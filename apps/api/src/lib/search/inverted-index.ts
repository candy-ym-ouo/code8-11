import type { TraceType } from '@paper-book-traces/shared';
import { searchableText, type SearchDocument } from './document.js';
import { tokenize } from './tokenizer.js';

const BM25_K1 = 1.5;
const BM25_B = 0.75;

export interface IndexHit {
  doc: SearchDocument;
  score: number;
}

export interface IndexFilter {
  types?: ReadonlySet<TraceType>;
  bookId?: string;
}

/**
 * 单用户倒排索引：term -> postings(docKey -> tf)，BM25 排序。
 *
 * 所有写入（增量 notify 与全量重建）都收敛到 applyPut / applyRemove 两个
 * 入口，并按源行 version 做 last-write-wins：索引状态只取决于「已应用变更
 * 的最终集合」，与变更到达的顺序和路径无关。这是「增量索引与全量重建一致」
 * 的实现基础。
 */
export class InvertedIndex {
  private docs = new Map<string, SearchDocument>();
  private postings = new Map<string, Map<string, number>>();
  private docLengths = new Map<string, number>();
  private totalLength = 0;

  get size(): number {
    return this.docs.size;
  }

  /** 写入或更新文档；严格更旧的 version 直接丢弃。 */
  applyPut(doc: SearchDocument): boolean {
    const existing = this.docs.get(doc.key);
    if (existing && existing.version > doc.version) return false;
    if (existing) this.remove(existing);
    this.add(doc);
    return true;
  }

  /** 删除文档；version 来自删除后源行的新 version。 */
  applyRemove(key: string, version: number): boolean {
    const existing = this.docs.get(key);
    if (!existing || existing.version > version) return false;
    this.remove(existing);
    return true;
  }

  private add(doc: SearchDocument): void {
    const tokens = tokenize(searchableText(doc));
    this.docs.set(doc.key, doc);
    this.docLengths.set(doc.key, tokens.length);
    this.totalLength += tokens.length;
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    for (const [term, count] of tf) {
      let plist = this.postings.get(term);
      if (!plist) {
        plist = new Map();
        this.postings.set(term, plist);
      }
      plist.set(doc.key, count);
    }
  }

  private remove(doc: SearchDocument): void {
    this.docs.delete(doc.key);
    const length = this.docLengths.get(doc.key) ?? 0;
    this.docLengths.delete(doc.key);
    this.totalLength -= length;
    const tokens = new Set(tokenize(searchableText(doc)));
    for (const term of tokens) {
      const plist = this.postings.get(term);
      if (!plist || !plist.has(doc.key)) continue;
      plist.delete(doc.key);
      if (plist.size === 0) this.postings.delete(term);
    }
  }

  /** AND 语义：查询词的全部 term 都必须命中。 */
  search(terms: string[], filter?: IndexFilter): IndexHit[] {
    if (terms.length === 0) return [];
    let candidates: Set<string> | null = null;
    for (const term of terms) {
      const plist = this.postings.get(term);
      if (!plist) return [];
      const keys = new Set(plist.keys());
      candidates = candidates === null ? keys : intersect(candidates, keys);
      if (candidates.size === 0) return [];
    }
    if (!candidates) return [];
    const hits: IndexHit[] = [];
    for (const key of candidates) {
      const doc = this.docs.get(key);
      if (!doc) continue;
      if (filter?.types && !filter.types.has(doc.traceType)) continue;
      if (filter?.bookId && doc.bookId !== filter.bookId) continue;
      hits.push({ doc, score: this.bm25(terms, key) });
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        b.doc.updatedAt.localeCompare(a.doc.updatedAt) ||
        a.doc.key.localeCompare(b.doc.key)
    );
    return hits;
  }

  private bm25(terms: string[], key: string): number {
    const docCount = this.docs.size;
    if (docCount === 0) return 0;
    const avgLength = this.totalLength / docCount;
    const docLength = this.docLengths.get(key) ?? 0;
    let score = 0;
    for (const term of terms) {
      const plist = this.postings.get(term);
      const tf = plist?.get(key);
      if (!plist || tf === undefined) continue;
      const idf = Math.log(1 + (docCount - plist.size + 0.5) / (plist.size + 0.5));
      const norm = BM25_K1 * (1 - BM25_B + (BM25_B * docLength) / avgLength);
      score += (idf * tf * (BM25_K1 + 1)) / (tf + norm);
    }
    return score;
  }

  /** 导出规范化内部结构，供测试断言「增量索引 === 全量重建」。 */
  snapshot(): unknown {
    const sortEntries = <K extends string, V>(map: Map<K, V>): Array<[K, V]> =>
      [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    return {
      docs: sortEntries(this.docs),
      docLengths: sortEntries(this.docLengths),
      postings: sortEntries(this.postings).map(([term, plist]) => [term, sortEntries(plist)]),
      totalLength: this.totalLength
    };
  }
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  const result = new Set<string>();
  for (const value of smaller) {
    if (larger.has(value)) result.add(value);
  }
  return result;
}
