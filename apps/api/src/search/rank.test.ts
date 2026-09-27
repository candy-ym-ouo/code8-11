import { describe, expect, it } from 'vitest';
import { bm25Idf, bm25Score, bm25Tf } from './rank.js';

describe('BM25 ranking', () => {
  it('rewards rarer terms with higher idf', () => {
    expect(bm25Idf(1, 1000)).toBeGreaterThan(bm25Idf(500, 1000));
    expect(bm25Idf(1, 1000)).toBeGreaterThan(0);
  });

  it('saturates term frequency instead of growing linearly', () => {
    const tf1 = bm25Tf(1, 100, 100);
    const tf4 = bm25Tf(4, 100, 100);
    const tf16 = bm25Tf(16, 100, 100);
    expect(tf4).toBeGreaterThan(tf1);
    expect(tf16).toBeGreaterThan(tf4);
    expect(tf16 - tf4).toBeLessThan(tf4 - tf1);
  });

  it('normalizes against longer documents', () => {
    expect(bm25Tf(2, 400, 100)).toBeLessThan(bm25Tf(2, 100, 100));
  });

  it('weighs unigram matches below word and bigram matches', () => {
    const base = { tf: 2, df: 3, docCount: 100, docLength: 50, avgDocLength: 50 };
    const unigram = bm25Score({ ...base, kind: 'unigram' });
    const bigram = bm25Score({ ...base, kind: 'bigram' });
    const word = bm25Score({ ...base, kind: 'word' });
    expect(unigram).toBeLessThan(bigram);
    expect(word).toBeCloseTo(bigram, 10);
  });
});
