/**
 * 分词器：拉丁字母/数字按词切分，CJK 按「单字 + 二元组（bigram）」切分。
 *
 * 写入侧（forQuery=false）对 CJK 同时产出 unigram 与 bigram，保证单字可查；
 * 查询侧（forQuery=true）对长度 >= 2 的 CJK 串只产出 bigram，配合 AND 语义
 * 保证精度。增量索引与全量重建必须使用同一个分词器，这是二者结果一致的
 * 前提之一，因此本模块不持有任何状态，也不允许外部注入词表。
 */

const CJK_RANGE = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const TOKEN_PATTERN = new RegExp(`[a-z0-9]+|[${CJK_RANGE}]+`, 'g');

function cjkTokens(run: string, forQuery: boolean): string[] {
  if (run.length === 1) return [run];
  const bigrams: string[] = [];
  for (let i = 0; i < run.length - 1; i += 1) {
    bigrams.push(run.slice(i, i + 2));
  }
  if (forQuery) return bigrams;
  return [...run, ...bigrams];
}

export function tokenize(text: string, options?: { forQuery?: boolean }): string[] {
  const forQuery = options?.forQuery ?? false;
  const tokens: string[] = [];
  const normalized = text.normalize('NFC').toLowerCase();
  for (const match of normalized.matchAll(TOKEN_PATTERN)) {
    const segment = match[0];
    const first = segment.codePointAt(0) ?? 0;
    if (first < 128) {
      tokens.push(segment);
    } else {
      tokens.push(...cjkTokens(segment, forQuery));
    }
  }
  return tokens;
}
