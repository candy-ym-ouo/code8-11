import { describe, expect, it, vi } from 'vitest';
import type { TraceType } from '@paper-book-traces/shared';
import { docKey, type ChangeRecord, type SearchDocument } from './document.js';
import { InvertedIndex } from './inverted-index.js';
import { SearchService } from './service.js';
import type { SearchSource } from './source.js';

let clock = 0;
function makeDoc(
  traceType: TraceType,
  traceId: string,
  text: string,
  version: number,
  userId: string,
  bookId: string,
  bookTitle = '活着'
): SearchDocument {
  clock += 1;
  return {
    key: docKey(traceType, traceId),
    userId,
    traceType,
    traceId,
    bookId,
    bookTitle,
    bookAuthor: '余华',
    text,
    pageNumber: traceType === 'ANNOTATION' ? null : 12,
    startPage: traceType === 'ANNOTATION' ? 3 : null,
    endPage: traceType === 'ANNOTATION' ? 5 : null,
    version,
    updatedAt: new Date(1_700_000_000_000 + clock).toISOString()
  };
}

/** 内存数据源：模拟 PostgreSQL 行为（软删除保留墓碑、version 单调递增）。 */
class FakeSource implements SearchSource {
  private rows = new Map<string, ChangeRecord>();
  chunkSize = 50;
  scanCallCount = 0;
  scanHook: ((chunkIndex: number) => Promise<void>) | null = null;

  upsert(doc: SearchDocument): void {
    this.rows.set(doc.key, { key: doc.key, userId: doc.userId, bookId: doc.bookId, version: doc.version, doc });
  }

  remove(key: string, version: number): void {
    const existing = this.rows.get(key);
    if (!existing) return;
    this.rows.set(key, { key, userId: existing.userId, bookId: existing.bookId, version, doc: null });
  }

  retitleBook(bookId: string, title: string): void {
    for (const [key, change] of this.rows) {
      if (change.bookId === bookId && change.doc) {
        this.rows.set(key, { ...change, doc: { ...change.doc, bookTitle: title } });
      }
    }
  }

  deleteBook(bookId: string, nextVersion: () => number): void {
    for (const [key, change] of this.rows) {
      if (change.bookId === bookId && change.doc) {
        this.rows.set(key, { ...change, version: nextVersion(), doc: null });
      }
    }
  }

  allChanges(userId: string): ChangeRecord[] {
    return [...this.rows.values()].filter((change) => change.userId === userId);
  }

  async loadChange(traceType: TraceType, traceId: string): Promise<ChangeRecord | null> {
    return this.rows.get(docKey(traceType, traceId)) ?? null;
  }

  async loadBookChanges(userId: string, bookId: string): Promise<ChangeRecord[]> {
    return [...this.rows.values()].filter((change) => change.userId === userId && change.bookId === bookId);
  }

  async *scanUser(userId: string): AsyncIterable<ChangeRecord[]> {
    this.scanCallCount += 1;
    const live = [...this.rows.values()].filter((change) => change.userId === userId && change.doc !== null);
    let chunkIndex = 0;
    for (let i = 0; i < live.length; i += this.chunkSize) {
      if (this.scanHook) await this.scanHook(chunkIndex);
      chunkIndex += 1;
      yield live.slice(i, i + this.chunkSize);
    }
  }
}

/** 参考索引：从源当前状态经同一 apply 路径构建，代表「正确的最终状态」。 */
function referenceIndex(source: FakeSource, userId: string): InvertedIndex {
  const index = new InvertedIndex();
  for (const change of source.allChanges(userId)) {
    if (change.doc) index.applyPut(change.doc);
    else index.applyRemove(change.key, change.version);
  }
  return index;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAGE = { page: 1, pageSize: 100 };

describe('SearchService 用户隔离', () => {
  it('相同文本的痕迹分属两用户，互不可见；重建后依然隔离', async () => {
    const source = new FakeSource();
    const service = new SearchService(source);
    source.upsert(makeDoc('ANNOTATION', 'a1', '深夜的读书笔记', 1, 'alice', 'b1'));
    source.upsert(makeDoc('ANNOTATION', 'b1', '深夜的读书笔记', 2, 'bob', 'b1'));
    await service.notifyTraceChanged('ANNOTATION', 'a1');
    await service.notifyTraceChanged('ANNOTATION', 'b1');

    const assertIsolated = async () => {
      const alice = await service.search('alice', { query: '笔记', ...PAGE });
      expect(alice.items.map((hit) => hit.doc.traceId)).toEqual(['a1']);
      expect(alice.items.every((hit) => hit.doc.userId === 'alice')).toBe(true);
      const bob = await service.search('bob', { query: '笔记', ...PAGE });
      expect(bob.items.map((hit) => hit.doc.traceId)).toEqual(['b1']);
      const carol = await service.search('carol', { query: '笔记', ...PAGE });
      expect(carol.total).toBe(0);
    };

    await assertIsolated();
    await service.rebuild('alice');
    await service.rebuild('bob');
    await assertIsolated();
  });
});

describe('SearchService 增量与重建一致', () => {
  it('随机工作负载下，增量索引与全量重建严格相等', async () => {
    const rng = mulberry32(20260927);
    const source = new FakeSource();
    const service = new SearchService(source);
    const users = ['u1', 'u2', 'u3'];
    const words = ['读书', '笔记', '孤独', '论证', '山水', '小说', '历史', 'kafka', 'python', '重读', '折角', '批注'];
    const types: TraceType[] = ['DOG_EAR', 'ANNOTATION', 'REREAD_MARK'];
    let version = 0;
    const pick = <T,>(list: T[]): T => list[Math.floor(rng() * list.length)]!;

    for (let i = 0; i < 600; i += 1) {
      const userId = pick(users);
      const traceType = pick(types);
      const traceId = `t${Math.floor(rng() * 120)}`;
      if (rng() < 0.7) {
        const text = Array.from({ length: 1 + Math.floor(rng() * 6) }, () => pick(words)).join(' ');
        source.upsert(makeDoc(traceType, traceId, text, ++version, userId, `b${Math.floor(rng() * 4)}`));
      } else {
        source.remove(docKey(traceType, traceId), ++version);
      }
      await service.notifyTraceChanged(traceType, traceId);
      if (rng() < 0.08) await service.rebuild(pick(users));
    }

    for (const userId of users) {
      await service.rebuild(userId);
      expect(service.debugSnapshot(userId)).toEqual(referenceIndex(source, userId).snapshot());
    }

    // 查询结果在再次重建后保持不变
    const queries = ['读书', '笔记', '孤独 山水', 'kafka', '重读', '不存在的词'];
    const runAll = async () => {
      const out: Record<string, unknown> = {};
      for (const userId of users) {
        for (const query of queries) {
          const result = await service.search(userId, { query, ...PAGE });
          out[`${userId}:${query}`] = result.items.map((hit) => [hit.doc.key, hit.score]);
        }
      }
      return out;
    };
    const before = await runAll();
    for (const userId of users) await service.rebuild(userId);
    expect(await runAll()).toEqual(before);
  });
});

describe('SearchService 全量重建不阻塞写入', () => {
  it('重建扫描期间写写照常，换入后索引与源状态一致', async () => {
    const source = new FakeSource();
    source.chunkSize = 50;
    const service = new SearchService(source);
    const userId = 'reader';
    let version = 0;
    for (let i = 0; i < 200; i += 1) {
      source.upsert(makeDoc('ANNOTATION', `seed${i}`, `初始 笔记 山水 ${i}`, ++version, userId, 'b1'));
    }
    await service.ensureIndexed(userId);

    // 门控：扫描到第 2 块时挂起，直到测试放行
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let scannedChunks = 0;
    source.scanHook = async (chunkIndex) => {
      scannedChunks = chunkIndex + 1;
      if (chunkIndex === 1) await scanGate;
    };

    const rebuildPromise = service.rebuild(userId);
    await vi.waitFor(() => {
      expect(scannedChunks).toBe(2);
    });

    // 重建扫描挂起中：新增、改写、删除都必须立即完成
    for (let i = 0; i < 10; i += 1) {
      source.upsert(makeDoc('REREAD_MARK', `new${i}`, `重读 新增 小说 ${i}`, ++version, userId, 'b2'));
      await service.notifyTraceChanged('REREAD_MARK', `new${i}`);
    }
    source.upsert(makeDoc('ANNOTATION', 'seed1', '改写后的批注 意境', ++version, userId, 'b1'));
    await service.notifyTraceChanged('ANNOTATION', 'seed1');
    source.remove(docKey('ANNOTATION', 'seed0'), ++version);
    await service.notifyTraceChanged('ANNOTATION', 'seed0');

    // 扫描期间查询由旧索引继续服务
    const during = await service.search(userId, { query: '山水', ...PAGE });
    expect(during.total).toBeGreaterThan(0);

    releaseScan();
    await rebuildPromise;
    source.scanHook = null;

    // 重建窗口内的全部变更在换入后的索引中可见
    const added = await service.search(userId, {
      query: '新增',
      types: new Set<TraceType>(['REREAD_MARK']),
      ...PAGE
    });
    expect(added.total).toBe(10);
    const notes = await service.search(userId, { query: '笔记', page: 1, pageSize: 500 });
    expect(notes.items.some((hit) => hit.doc.traceId === 'seed0')).toBe(false);
    const rewritten = await service.search(userId, { query: '改写后', ...PAGE });
    expect(rewritten.items[0]?.doc.traceId).toBe('seed1');

    // 换入后的索引与「从源状态一次性构建」严格一致
    expect(service.debugSnapshot(userId)).toEqual(referenceIndex(source, userId).snapshot());
  });

  it('同一用户的并发重建去重为一次扫描', async () => {
    const source = new FakeSource();
    source.upsert(makeDoc('DOG_EAR', 'd1', '折角 山水', 1, 'u1', 'b1'));
    const service = new SearchService(source);
    const [a, b] = await Promise.all([service.rebuild('u1'), service.rebuild('u1')]);
    expect(a).toBe(b);
    expect(source.scanCallCount).toBe(1);
  });
});

describe('SearchService 懒加载与级联更新', () => {
  it('首次访问自动触发全量重建', async () => {
    const source = new FakeSource();
    source.upsert(makeDoc('DOG_EAR', 'd1', '折角 山水 意境', 1, 'u1', 'b1'));
    const service = new SearchService(source);
    expect(service.isIndexed('u1')).toBe(false);
    const result = await service.search('u1', { query: '山水', ...PAGE });
    expect(result.total).toBe(1);
    expect(service.isIndexed('u1')).toBe(true);
  });

  it('书目改名 / 删除后级联更新痕迹文档', async () => {
    const source = new FakeSource();
    const service = new SearchService(source);
    let version = 0;
    source.upsert(makeDoc('ANNOTATION', 't1', '批注 山水', ++version, 'u1', 'b1', '旧书名'));
    source.upsert(makeDoc('DOG_EAR', 't2', '折角', ++version, 'u1', 'b1', '旧书名'));
    source.upsert(makeDoc('ANNOTATION', 't3', '批注 山水', ++version, 'u1', 'b2', '别的书'));
    await service.ensureIndexed('u1');

    source.retitleBook('b1', '新书名');
    await service.notifyBookChanged('u1', 'b1');
    expect((await service.search('u1', { query: '新书名', ...PAGE })).total).toBe(2);
    expect((await service.search('u1', { query: '旧书名', ...PAGE })).total).toBe(0);

    source.deleteBook('b1', () => ++version);
    await service.notifyBookChanged('u1', 'b1');
    const remaining = await service.search('u1', { query: '山水', ...PAGE });
    expect(remaining.items.map((hit) => hit.doc.traceId)).toEqual(['t3']);
    expect(service.debugSnapshot('u1')).toEqual(referenceIndex(source, 'u1').snapshot());
  });
});
