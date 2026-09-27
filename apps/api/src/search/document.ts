import type { SearchEntityType } from '@prisma/client';
import { analyze } from './terms.js';

/**
 * 痕迹 → 检索文档 的纯函数组装。
 *
 * 增量索引与全量重建都只能通过 buildTraceDocument 构造文档，
 * 从结构上保证两条路径产出完全一致（一致性测试会再次验证）。
 */

export interface TraceSnapshot {
  userId: string;
  bookId: string;
  entityType: SearchEntityType;
  entityId: string;
  /** 业务实体的 version（写入方在同一事务内已递增后的值） */
  sourceVersion: number;
  pageStart: number;
  pageEnd: number;
  /** 折角/重读的 reason、批注的 content；无文本时为 null */
  text: string | null;
  sourceCreatedAt: Date;
  deleted: boolean;
}

export interface PostingEntry {
  term: string;
  tf: number;
}

export interface DocumentPlan {
  userId: string;
  bookId: string;
  entityType: SearchEntityType;
  entityId: string;
  sourceVersion: number;
  pageStart: number;
  pageEnd: number;
  content: string;
  /** 文档词元总数（含重复），BM25 长度归一化使用 */
  termCount: number;
  sourceCreatedAt: Date;
  postings: PostingEntry[];
}

/**
 * 由实体快照构造索引文档计划。
 * 返回 null 表示该实体没有可索引文本：索引中不应存在对应文档行
 * （调用方据此写入墓碑或跳过）。
 */
export function buildTraceDocument(snapshot: TraceSnapshot): DocumentPlan | null {
  if (snapshot.deleted) return null;
  const content = snapshot.text?.trim() ?? '';
  if (!content) return null;
  const stats = analyze(content);
  if (stats.size === 0) return null;
  let termCount = 0;
  const postings: PostingEntry[] = [];
  for (const [term, stat] of stats) {
    termCount += stat.tf;
    postings.push({ term, tf: stat.tf });
  }
  return {
    userId: snapshot.userId,
    bookId: snapshot.bookId,
    entityType: snapshot.entityType,
    entityId: snapshot.entityId,
    sourceVersion: snapshot.sourceVersion,
    pageStart: snapshot.pageStart,
    pageEnd: snapshot.pageEnd,
    content,
    termCount,
    sourceCreatedAt: snapshot.sourceCreatedAt,
    postings
  };
}
