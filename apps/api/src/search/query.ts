import { Prisma, type SearchEntityType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { analyzeQuery } from './terms.js';
import { bm25Score } from './rank.js';
import { buildSnippet, type Snippet } from './snippet.js';

/**
 * 全文检索查询执行。
 *
 * 用户隔离：所有候选文档行都带 d.user_id = 当前用户条件；
 * df 只对倒排表做 COUNT（跨用户共享统计量），不暴露也不读取他人文档内容。
 * 匹配语义：查询词项全部命中（AND），BM25 排序。
 */

export interface SearchInput {
  query: string;
  type: SearchEntityType | undefined;
  bookId: string | undefined;
  pageNumber: number | undefined;
  page: number;
  pageSize: number;
}

export interface SearchHit {
  entityType: SearchEntityType;
  entityId: string;
  bookId: string;
  bookTitle: string;
  pageStart: number;
  pageEnd: number;
  score: number;
  snippet: Snippet;
  createdAt: string;
}

export interface SearchOutput {
  items: SearchHit[];
  total: number;
  ready: boolean;
  building: boolean;
}

interface CandidateRow {
  document_id: string;
  entity_type: SearchEntityType;
  entity_id: string;
  book_id: string;
  page_start: number;
  page_end: number;
  content: string;
  term_count: number;
  source_created_at: Date;
  term: string;
  tf: number;
}

interface DocCountRow {
  count: bigint;
  avg_len: number | null;
}

interface DfRow {
  term: string;
  df: bigint;
}

interface GenerationRow {
  id: number;
  status: string;
}

export async function searchTraces(userId: string, input: SearchInput): Promise<SearchOutput> {
  const analysis = analyzeQuery(input.query);
  const terms = analysis.terms;
  if (terms.length === 0) return { items: [], total: 0, ready: false, building: false };

  const generations = await prisma.$queryRaw<GenerationRow[]>`
    SELECT id, status::text AS status FROM search_generations WHERE status IN ('ACTIVE', 'BUILDING')`;
  const active = generations.find((generation) => generation.status === 'ACTIVE');
  if (!active) return { items: [], total: 0, ready: false, building: generations.length > 0 };

  const typeFilter = input.type
    ? Prisma.sql`AND d.entity_type = ${input.type}::"SearchEntityType"`
    : Prisma.empty;
  const bookFilter = input.bookId ? Prisma.sql`AND d.book_id = ${input.bookId}::uuid` : Prisma.empty;
  const pageFilter = input.pageNumber
    ? Prisma.sql`AND d.page_start <= ${input.pageNumber} AND d.page_end >= ${input.pageNumber}`
    : Prisma.empty;
  const termList = Prisma.join(terms);

  const [candidateRows, statsRows, dfRows] = await Promise.all([
    prisma.$queryRaw<CandidateRow[]>`
      SELECT
        d.id::text AS document_id,
        d.entity_type::text AS entity_type,
        d.entity_id::text AS entity_id,
        d.book_id::text AS book_id,
        d.page_start, d.page_end, d.content, d.term_count,
        d.source_created_at, p.term, p.tf
      FROM search_postings p
      JOIN search_documents d ON d.id = p.document_id
      WHERE p.generation_id = ${active.id}
        AND p.term IN (${termList})
        AND d.user_id = ${userId}::uuid
        AND d.deleted_at IS NULL
        ${typeFilter}
        ${bookFilter}
        ${pageFilter}`,
    prisma.$queryRaw<DocCountRow[]>`
      SELECT COUNT(*)::bigint AS count, COALESCE(AVG(term_count), 0) AS avg_len
      FROM search_documents
      WHERE generation_id = ${active.id} AND deleted_at IS NULL`,
    prisma.$queryRaw<DfRow[]>`
      SELECT term, COUNT(*)::bigint AS df
      FROM search_postings
      WHERE generation_id = ${active.id} AND term IN (${termList})
      GROUP BY term`
  ]);

  const docCount = Number(statsRows[0]?.count ?? 0);
  const avgDocLength = Number(statsRows[0]?.avg_len ?? 0);
  const dfByTerm = new Map(dfRows.map((row) => [row.term, Number(row.df)]));

  interface CandidateDoc {
    entityType: SearchEntityType;
    entityId: string;
    bookId: string;
    pageStart: number;
    pageEnd: number;
    content: string;
    termCount: number;
    createdAt: Date;
    matched: Map<string, number>;
  }

  const byDocument = new Map<string, CandidateDoc>();
  for (const row of candidateRows) {
    let doc = byDocument.get(row.document_id);
    if (!doc) {
      doc = {
        entityType: row.entity_type,
        entityId: row.entity_id,
        bookId: row.book_id,
        pageStart: row.page_start,
        pageEnd: row.page_end,
        content: row.content,
        termCount: row.term_count,
        createdAt: row.source_created_at,
        matched: new Map()
      };
      byDocument.set(row.document_id, doc);
    }
    doc.matched.set(row.term, row.tf);
  }

  // AND 语义：任一词项缺失的文档直接淘汰。
  const scored: Array<CandidateDoc & { score: number }> = [];
  for (const doc of byDocument.values()) {
    if (doc.matched.size < terms.length) continue;
    let score = 0;
    for (const term of terms) {
      const tf = doc.matched.get(term) ?? 0;
      const df = dfByTerm.get(term) ?? 0;
      score += bm25Score({
        tf,
        df,
        docCount,
        docLength: doc.termCount,
        avgDocLength,
        kind: analysis.kinds.get(term) ?? 'word'
      });
    }
    scored.push({ ...doc, score });
  }

  scored.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.entityId.localeCompare(b.entityId);
  });

  // 只返回仍属于当前用户、且书目未删除的结果（纵深防御：索引行本身也带 user_id）。
  const bookIds = [...new Set(scored.map((doc) => doc.bookId))];
  const books = bookIds.length
    ? await prisma.book.findMany({
        where: { id: { in: bookIds }, userId, deletedAt: null },
        select: { id: true, title: true }
      })
    : [];
  const bookTitles = new Map(books.map((book) => [book.id, book.title]));

  const visible = scored.filter((doc) => bookTitles.has(doc.bookId));
  const total = visible.length;
  const pageItems = visible.slice((input.page - 1) * input.pageSize, input.page * input.pageSize);
  const queryTermSet = new Set(terms);

  const items: SearchHit[] = pageItems.map((doc) => ({
    entityType: doc.entityType,
    entityId: doc.entityId,
    bookId: doc.bookId,
    bookTitle: bookTitles.get(doc.bookId) ?? '已删除书目',
    pageStart: doc.pageStart,
    pageEnd: doc.pageEnd,
    score: Number(doc.score.toFixed(6)),
    snippet: buildSnippet(doc.content, queryTermSet),
    createdAt: doc.createdAt.toISOString()
  }));

  return { items, total, ready: true, building: generations.some((generation) => generation.status === 'BUILDING') };
}
