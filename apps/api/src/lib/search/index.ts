import type { TraceType } from '@paper-book-traces/shared';
import { PrismaSearchSource } from './prisma-source.js';
import { SearchService } from './service.js';

/** 进程级单例：索引常驻内存，随请求写入增量更新。 */
export const searchService = new SearchService(new PrismaSearchSource());

interface ErrorLogger {
  error: (obj: unknown, msg?: string) => void;
}

/**
 * 索引更新失败不应让已提交的业务写入报错（索引可由重建兜底修复），
 * 因此写路径统一走这里的安全包装：失败只记录日志。
 */
export async function indexTraceSafely(
  log: ErrorLogger,
  traceType: TraceType,
  traceId: string
): Promise<void> {
  try {
    await searchService.notifyTraceChanged(traceType, traceId);
  } catch (error) {
    log.error(error, 'trace search index update failed');
  }
}

export async function indexBookSafely(log: ErrorLogger, userId: string, bookId: string): Promise<void> {
  try {
    await searchService.notifyBookChanged(userId, bookId);
  } catch (error) {
    log.error(error, 'book search index update failed');
  }
}
