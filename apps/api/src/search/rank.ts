import type { TermKind } from './terms.js';

/**
 * BM25 相关性评分（Okapi BM25），参数取通行默认值。
 *
 * df（文档频率）按整个代际统计，跨用户共享同一语料统计量；
 * 文档本身始终按 user_id 隔离，评分过程不读取其他用户的文档行。
 */

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** 词种权重：bigram 与词元最精确，单字噪声大、降权。 */
export const TERM_KIND_WEIGHT: Record<TermKind, number> = {
  word: 1.0,
  bigram: 1.0,
  unigram: 0.4
};

export function bm25Idf(df: number, docCount: number): number {
  return Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
}

export function bm25Tf(tf: number, docLength: number, avgDocLength: number): number {
  const safeAvg = avgDocLength > 0 ? avgDocLength : 1;
  const norm = 1 - BM25_B + (BM25_B * docLength) / safeAvg;
  return (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm);
}

export function bm25Score(input: {
  tf: number;
  df: number;
  docCount: number;
  docLength: number;
  avgDocLength: number;
  kind: TermKind;
}): number {
  return (
    TERM_KIND_WEIGHT[input.kind] *
    bm25Idf(input.df, input.docCount) *
    bm25Tf(input.tf, input.docLength, input.avgDocLength)
  );
}
