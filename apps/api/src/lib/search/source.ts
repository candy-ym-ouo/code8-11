import type { TraceType } from '@paper-book-traces/shared';
import type { ChangeRecord } from './document.js';

/** 全量重建时分块扫描的块大小；块与块之间必须让出事件循环。 */
export const SEARCH_SCAN_CHUNK = 200;

/**
 * 检索数据源：索引系统对业务存储的唯一依赖。
 * 生产实现是 PrismaSearchSource，测试使用内存实现。
 */
export interface SearchSource {
  /** 读取单条痕迹的当前状态（含软删除），用于写路径提交后的增量回读。 */
  loadChange(traceType: TraceType, traceId: string): Promise<ChangeRecord | null>;
  /** 读取某本书全部痕迹的当前状态（含软删除），用于书目改名 / 删除后的级联更新。 */
  loadBookChanges(userId: string, bookId: string): Promise<ChangeRecord[]>;
  /**
   * 分块扫描用户全部未删除痕迹（全量重建用）。
   * 实现必须分块异步产出，使扫描期间其他请求得以继续处理。
   */
  scanUser(userId: string): AsyncIterable<ChangeRecord[]>;
}
