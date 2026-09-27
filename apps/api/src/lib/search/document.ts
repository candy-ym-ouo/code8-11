import type { TraceType } from '@paper-book-traces/shared';

/**
 * 一条可搜索文档：折角 / 批注 / 重读三类痕迹的统一检索视图。
 * 文档是派生数据，唯一事实源是 PostgreSQL 中的业务行。
 */
export interface SearchDocument {
  /** 文档主键，形如 `ANNOTATION:<uuid>`，用户间通过 userId 字段与索引隔离。 */
  key: string;
  userId: string;
  traceType: TraceType;
  traceId: string;
  bookId: string;
  bookTitle: string;
  bookAuthor: string | null;
  /** 痕迹自身文本：批注内容，或折角 / 重读的原因。 */
  text: string;
  pageNumber: number | null;
  startPage: number | null;
  endPage: number | null;
  /** 源行业务 version，索引按 last-write-wins 应用。 */
  version: number;
  /** ISO 时间，排序兜底字段。 */
  updatedAt: string;
}

/**
 * 一次索引变更。doc 为 null 表示删除（墓碑）。
 * 增量回读与全量重建都归结为 ChangeRecord 流，保证两条路径同构。
 */
export interface ChangeRecord {
  key: string;
  userId: string;
  bookId: string;
  version: number;
  doc: SearchDocument | null;
}

export function docKey(traceType: TraceType, traceId: string): string {
  return `${traceType}:${traceId}`;
}

/** 参与全文索引的文本：书名、作者与痕迹正文。 */
export function searchableText(doc: SearchDocument): string {
  return [doc.bookTitle, doc.bookAuthor ?? '', doc.text].join(' ');
}
