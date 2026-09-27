import type { TraceType } from '@paper-book-traces/shared';
import type { ChangeRecord, SearchDocument } from './document.js';
import { InvertedIndex, type IndexHit } from './inverted-index.js';
import type { SearchSource } from './source.js';
import { tokenize } from './tokenizer.js';

export interface SearchQuery {
  query: string;
  types?: ReadonlySet<TraceType>;
  bookId?: string;
  page: number;
  pageSize: number;
}

export interface SearchResult {
  items: IndexHit[];
  total: number;
}

interface JournalEntry {
  seq: number;
  change: ChangeRecord;
}

/**
 * 痕迹全文检索服务。
 *
 * 用户隔离：每个用户一棵独立的 InvertedIndex，查询只能指定 userId 取本用户
 * 索引，结构上不存在跨用户检索的路径。
 *
 * 增量与重建一致：两条路径共用同一个 ChangeRecord 流与同一组
 * applyPut / applyRemove（按源行 version 做 last-write-wins），因此
 * 「一路增量」与「快照扫描 + 日志回放」收敛到同一份索引状态。
 *
 * 重建不阻塞写入：扫描分块异步进行，不持有任何锁；扫描窗口内的写入照常
 * 进入旧索引（查询不受影响），同时记入 journal；扫描结束后回放 journal
 * 并同步换入新索引——换入不发生 await，在单线程事件循环下是原子的。
 */
export class SearchService {
  private readonly indexes = new Map<string, InvertedIndex>();
  private readonly rebuilds = new Map<string, Promise<number>>();
  private journal: JournalEntry[] = [];
  private seq = 0;

  constructor(private readonly source: SearchSource) {}

  /** 增量入口：痕迹创建 / 更新 / 删除 / 恢复提交后调用（回读当前状态）。 */
  async notifyTraceChanged(traceType: TraceType, traceId: string): Promise<void> {
    const change = await this.source.loadChange(traceType, traceId);
    if (!change) return;
    await this.ensureIndexed(change.userId);
    this.apply(change);
  }

  /** 增量入口：书目改名 / 删除后，级联更新该书全部痕迹文档。 */
  async notifyBookChanged(userId: string, bookId: string): Promise<void> {
    const changes = await this.source.loadBookChanges(userId, bookId);
    await this.ensureIndexed(userId);
    for (const change of changes) {
      this.apply(change);
    }
  }

  async search(userId: string, query: SearchQuery): Promise<SearchResult> {
    await this.ensureIndexed(userId);
    const terms = tokenize(query.query, { forQuery: true });
    if (terms.length === 0) return { items: [], total: 0 };
    const index = this.indexes.get(userId);
    if (!index) return { items: [], total: 0 };
    const filter: { types?: ReadonlySet<TraceType>; bookId?: string } = {};
    if (query.types) filter.types = query.types;
    if (query.bookId) filter.bookId = query.bookId;
    const hits = index.search(terms, filter);
    const start = (query.page - 1) * query.pageSize;
    return { items: hits.slice(start, start + query.pageSize), total: hits.length };
  }

  /**
   * 全量重建指定用户的索引。同一用户的并发重建会去重为同一次执行。
   * 返回索引中的文档数。
   */
  rebuild(userId: string): Promise<number> {
    const inFlight = this.rebuilds.get(userId);
    if (inFlight) return inFlight;
    const promise = this.doRebuild(userId).finally(() => {
      if (this.rebuilds.get(userId) === promise) this.rebuilds.delete(userId);
    });
    this.rebuilds.set(userId, promise);
    return promise;
  }

  /** 服务重启后索引为空，首次访问时按需触发全量重建。 */
  async ensureIndexed(userId: string): Promise<void> {
    if (!this.indexes.has(userId)) {
      await this.rebuild(userId);
    }
  }

  isIndexed(userId: string): boolean {
    return this.indexes.has(userId);
  }

  /** 测试钩子：导出用户索引的规范化结构，用于断言增量与重建一致。 */
  debugSnapshot(userId: string): unknown {
    return this.indexes.get(userId)?.snapshot() ?? null;
  }

  private async doRebuild(userId: string): Promise<number> {
    // 之后的变更 seq 都大于 mark，会被记入 journal 并在扫描结束后回放。
    const mark = this.seq;
    const fresh = new InvertedIndex();
    for await (const chunk of this.source.scanUser(userId)) {
      for (const change of chunk) {
        this.applyTo(fresh, change);
      }
      // 每块之后让出事件循环，写入与查询请求得以继续处理。
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const entry of this.journal) {
      if (entry.seq > mark && entry.change.userId === userId) {
        this.applyTo(fresh, entry.change);
      }
    }
    // 同步换入：此处到 indexes.set 之间没有 await，换入是原子的。
    this.indexes.set(userId, fresh);
    return fresh.size;
  }

  private apply(change: ChangeRecord): void {
    const index = this.indexes.get(change.userId);
    if (!index) return;
    this.seq += 1;
    this.applyTo(index, change);
    if (this.rebuilds.size > 0) {
      this.journal.push({ seq: this.seq, change });
    } else if (this.journal.length > 0) {
      // 没有在途重建时日志无需保留。
      this.journal = [];
    }
  }

  private applyTo(index: InvertedIndex, change: ChangeRecord): void {
    if (change.doc) {
      index.applyPut(change.doc);
    } else {
      index.applyRemove(change.key, change.version);
    }
  }
}

export type { SearchDocument };
