import { describe, expect, it } from 'vitest';
import type { TraceType } from '@paper-book-traces/shared';
import { docKey, type SearchDocument } from './document.js';
import { InvertedIndex } from './inverted-index.js';
import { tokenize } from './tokenizer.js';

let seq = 0;
function doc(
  traceId: string,
  text: string,
  version: number,
  options?: { userId?: string; traceType?: TraceType; bookId?: string; bookTitle?: string }
): SearchDocument {
  seq += 1;
  const traceType = options?.traceType ?? 'ANNOTATION';
  return {
    key: docKey(traceType, traceId),
    userId: options?.userId ?? 'u1',
    traceType,
    traceId,
    bookId: options?.bookId ?? 'b1',
    bookTitle: options?.bookTitle ?? '活着',
    bookAuthor: '余华',
    text,
    pageNumber: null,
    startPage: 1,
    endPage: 2,
    version,
    updatedAt: new Date(1_700_000_000_000 + seq).toISOString()
  };
}

function terms(query: string): string[] {
  return tokenize(query, { forQuery: true });
}

describe('InvertedIndex', () => {
  it('写入后可按中文二元组检索', () => {
    const index = new InvertedIndex();
    index.applyPut(doc('t1', '这里的论证非常精彩', 1));
    const hits = index.search(terms('论证'));
    expect(hits.map((hit) => hit.doc.traceId)).toEqual(['t1']);
  });

  it('书名与作者同样可检索', () => {
    const index = new InvertedIndex();
    index.applyPut(doc('t1', '平淡的一页', 1, { bookTitle: '百年孤独' }));
    expect(index.search(terms('孤独')).map((hit) => hit.doc.traceId)).toEqual(['t1']);
    expect(index.search(terms('余华')).map((hit) => hit.doc.traceId)).toEqual(['t1']);
  });

  it('更新后旧文本不再命中', () => {
    const index = new InvertedIndex();
    index.applyPut(doc('t1', '旧批注 山水', 1));
    index.applyPut(doc('t1', '新批注 小说', 2));
    expect(index.search(terms('山水'))).toEqual([]);
    expect(index.search(terms('小说'))).toHaveLength(1);
    expect(index.size).toBe(1);
  });

  it('删除后不再命中', () => {
    const index = new InvertedIndex();
    index.applyPut(doc('t1', '读书笔记', 1));
    index.applyRemove(docKey('ANNOTATION', 't1'), 2);
    expect(index.search(terms('笔记'))).toEqual([]);
    expect(index.size).toBe(0);
  });

  it('严格更旧的写入被拒绝（last-write-wins）', () => {
    const index = new InvertedIndex();
    index.applyPut(doc('t1', '新版本 小说', 5));
    expect(index.applyPut(doc('t1', '旧版本 山水', 3))).toBe(false);
    expect(index.search(terms('山水'))).toEqual([]);
    expect(index.search(terms('小说'))).toHaveLength(1);
  });

  it('同 version 的写入允许覆盖（书目改名场景）', () => {
    const index = new InvertedIndex();
    index.applyPut(doc('t1', '批注', 5, { bookTitle: '旧书名' }));
    expect(index.applyPut(doc('t1', '批注', 5, { bookTitle: '新书名' }))).toBe(true);
    expect(index.search(terms('旧书名'))).toEqual([]);
    expect(index.search(terms('新书名'))).toHaveLength(1);
  });

  it('严格更旧的删除被拒绝', () => {
    const index = new InvertedIndex();
    index.applyPut(doc('t1', '读书笔记', 5));
    expect(index.applyRemove(docKey('ANNOTATION', 't1'), 3)).toBe(false);
    expect(index.search(terms('笔记'))).toHaveLength(1);
  });

  it('按痕迹类型与书目过滤', () => {
    const index = new InvertedIndex();
    index.applyPut(doc('t1', '精彩 段落', 1, { traceType: 'DOG_EAR' }));
    index.applyPut(doc('t2', '精彩 段落', 2, { traceType: 'REREAD_MARK', bookId: 'b2' }));
    expect(index.search(terms('精彩'), { types: new Set(['REREAD_MARK']) }).map((hit) => hit.doc.traceId)).toEqual([
      't2'
    ]);
    expect(index.search(terms('精彩'), { bookId: 'b1' }).map((hit) => hit.doc.traceId)).toEqual(['t1']);
  });

  it('AND 语义：全部查询词都命中才算匹配', () => {
    const index = new InvertedIndex();
    index.applyPut(doc('t1', '读书笔记', 1));
    index.applyPut(doc('t2', '读书 心得', 2));
    expect(index.search(terms('读书笔记')).map((hit) => hit.doc.traceId)).toEqual(['t1']);
  });

  it('BM25 让词频更高的文档排在前面', () => {
    const index = new InvertedIndex();
    index.applyPut(doc('dense', '孤独 孤独 孤独', 1));
    index.applyPut(doc('sparse', '孤独 外加 很多 无关 词汇 填充 内容 稀释 主题', 2));
    const hits = index.search(terms('孤独'));
    expect(hits[0]?.doc.traceId).toBe('dense');
  });

  it('空词项返回空结果', () => {
    const index = new InvertedIndex();
    index.applyPut(doc('t1', '读书笔记', 1));
    expect(index.search([])).toEqual([]);
  });

  it('相同变更序列产出相同内部结构', () => {
    const a = new InvertedIndex();
    const b = new InvertedIndex();
    const docs = [doc('t1', '读书笔记 山水', 1), doc('t2', '重读 小说 章节', 2), doc('t3', 'Kafka 短篇', 3)];
    for (const item of docs) {
      a.applyPut(item);
      b.applyPut(item);
    }
    a.applyRemove(docs[1]!.key, 4);
    b.applyRemove(docs[1]!.key, 4);
    expect(a.snapshot()).toEqual(b.snapshot());
  });
});
