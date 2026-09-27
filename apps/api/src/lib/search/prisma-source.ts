import type { Annotation, Book, DogEar, RereadMark } from '@prisma/client';
import { TRACE_TYPES, type TraceType } from '@paper-book-traces/shared';
import { prisma } from '../prisma.js';
import { docKey, type ChangeRecord, type SearchDocument } from './document.js';
import { SEARCH_SCAN_CHUNK, type SearchSource } from './source.js';

type DogEarRow = DogEar & { book: Book };
type AnnotationRow = Annotation & { book: Book };
type RereadMarkRow = RereadMark & { book: Book };

function baseDoc(
  row: { id: string; userId: string; bookId: string; version: number; updatedAt: Date },
  book: Book,
  traceType: TraceType,
  text: string
): Omit<SearchDocument, 'pageNumber' | 'startPage' | 'endPage'> {
  return {
    key: docKey(traceType, row.id),
    userId: row.userId,
    traceType,
    traceId: row.id,
    bookId: row.bookId,
    bookTitle: book.title,
    bookAuthor: book.author,
    text,
    version: row.version,
    updatedAt: row.updatedAt.toISOString()
  };
}

function dogEarChange(row: DogEarRow): ChangeRecord {
  const deleted = row.deletedAt !== null || row.book.deletedAt !== null;
  return {
    key: docKey('DOG_EAR', row.id),
    userId: row.userId,
    bookId: row.bookId,
    version: row.version,
    doc: deleted
      ? null
      : {
          ...baseDoc(row, row.book, 'DOG_EAR', row.reason ?? ''),
          pageNumber: row.pageNumber,
          startPage: null,
          endPage: null
        }
  };
}

function annotationChange(row: AnnotationRow): ChangeRecord {
  const deleted = row.deletedAt !== null || row.book.deletedAt !== null;
  return {
    key: docKey('ANNOTATION', row.id),
    userId: row.userId,
    bookId: row.bookId,
    version: row.version,
    doc: deleted
      ? null
      : {
          ...baseDoc(row, row.book, 'ANNOTATION', row.content),
          pageNumber: null,
          startPage: row.startPage,
          endPage: row.endPage
        }
  };
}

function rereadMarkChange(row: RereadMarkRow): ChangeRecord {
  const deleted = row.deletedAt !== null || row.book.deletedAt !== null;
  return {
    key: docKey('REREAD_MARK', row.id),
    userId: row.userId,
    bookId: row.bookId,
    version: row.version,
    doc: deleted
      ? null
      : {
          ...baseDoc(row, row.book, 'REREAD_MARK', row.reason ?? ''),
          pageNumber: row.pageNumber,
          startPage: null,
          endPage: null
        }
  };
}

/**
 * 基于 Prisma 的生产数据源。PostgreSQL 是唯一事实源；
 * 这里只做只读查询，索引是纯粹的派生结构。
 */
export class PrismaSearchSource implements SearchSource {
  async loadChange(traceType: TraceType, traceId: string): Promise<ChangeRecord | null> {
    if (traceType === 'DOG_EAR') {
      const row = await prisma.dogEar.findUnique({ where: { id: traceId }, include: { book: true } });
      return row ? dogEarChange(row) : null;
    }
    if (traceType === 'ANNOTATION') {
      const row = await prisma.annotation.findUnique({ where: { id: traceId }, include: { book: true } });
      return row ? annotationChange(row) : null;
    }
    const row = await prisma.rereadMark.findUnique({ where: { id: traceId }, include: { book: true } });
    return row ? rereadMarkChange(row) : null;
  }

  async loadBookChanges(userId: string, bookId: string): Promise<ChangeRecord[]> {
    const [dogEars, annotations, rereadMarks] = await Promise.all([
      prisma.dogEar.findMany({ where: { userId, bookId }, include: { book: true } }),
      prisma.annotation.findMany({ where: { userId, bookId }, include: { book: true } }),
      prisma.rereadMark.findMany({ where: { userId, bookId }, include: { book: true } })
    ]);
    return [
      ...dogEars.map(dogEarChange),
      ...annotations.map(annotationChange),
      ...rereadMarks.map(rereadMarkChange)
    ];
  }

  async *scanUser(userId: string): AsyncIterable<ChangeRecord[]> {
    for (const traceType of TRACE_TYPES) {
      yield* this.scanTable(userId, traceType);
    }
  }

  /**
   * 按主键游标分块扫描：排序稳定，扫描期间的新增 / 修改由重建日志兜底，
   * 因此这里不需要事务快照，也不会对写入产生任何锁。
   */
  private async *scanTable(userId: string, traceType: TraceType): AsyncIterable<ChangeRecord[]> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.fetchPage(userId, traceType, cursor);
      if (page.changes.length === 0) return;
      yield page.changes;
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  private async fetchPage(
    userId: string,
    traceType: TraceType,
    cursor: string | undefined
  ): Promise<{ changes: ChangeRecord[]; nextCursor?: string }> {
    const pagination = {
      orderBy: { id: 'asc' as const },
      take: SEARCH_SCAN_CHUNK,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
    };
    if (traceType === 'DOG_EAR') {
      const rows = await prisma.dogEar.findMany({
        where: { userId, deletedAt: null },
        include: { book: true },
        ...pagination
      });
      return pageOf(rows, dogEarChange);
    }
    if (traceType === 'ANNOTATION') {
      const rows = await prisma.annotation.findMany({
        where: { userId, deletedAt: null },
        include: { book: true },
        ...pagination
      });
      return pageOf(rows, annotationChange);
    }
    const rows = await prisma.rereadMark.findMany({
      where: { userId, deletedAt: null },
      include: { book: true },
      ...pagination
    });
    return pageOf(rows, rereadMarkChange);
  }
}

function pageOf<Row extends { id: string }>(
  rows: Row[],
  toChange: (row: Row) => ChangeRecord
): { changes: ChangeRecord[]; nextCursor?: string } {
  const last = rows.at(-1);
  const result: { changes: ChangeRecord[]; nextCursor?: string } = {
    changes: rows.map(toChange)
  };
  if (rows.length === SEARCH_SCAN_CHUNK && last) {
    result.nextCursor = last.id;
  }
  return result;
}
