/**
 * 全文检索分词器（从零实现，不依赖外部分词库）。
 *
 * 设计：
 * - 归一化：NFKC + 小写，全角字符折叠为半角，索引与查询走完全相同的管线；
 * - CJK（中日韩表意文字、假名、谚文）：单字（unigram）+ 相邻二字（bigram）；
 * - 拉丁字母与数字：连续序列构成词元（word），最长截取 32 字符；
 * - 其余字符（标点、空白、符号）一律视为分隔符。
 *
 * 词项带命名空间前缀（w:/u:/b:），避免不同词种在倒排表中碰撞。
 */

export type TermKind = 'word' | 'unigram' | 'bigram';

export interface Token {
  term: string;
  kind: TermKind;
  /** 在归一化文本中的起止偏移（UTF-16 code unit），供摘要与高亮使用 */
  start: number;
  end: number;
}

export interface TermStat {
  tf: number;
  kind: TermKind;
}

const WORD_MAX_LENGTH = 32;
const QUERY_MAX_TERMS = 32;

// CJK 统一表意文字（含扩展 A/B）、兼容表意、日文假名、韩文音节、半角片假名。
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2ebef],
  [0xf900, 0xfaff],
  [0x3040, 0x309f],
  [0x30a0, 0x30ff],
  [0xac00, 0xd7af],
  [0xff66, 0xff9d]
];

function isCjkCodePoint(codePoint: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

function isWordChar(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z（已小写化）
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x5f // _
  );
}

function isCjkChar(ch: string): boolean {
  return isCjkCodePoint(ch.codePointAt(0) ?? 0);
}

export function normalizeForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

export function tokenize(text: string): Token[] {
  const normalized = normalizeForSearch(text);
  const tokens: Token[] = [];
  let wordStart = -1;
  let cjkChars: string[] = [];
  let cjkOffsets: number[] = [];

  const flushWord = (end: number): void => {
    if (wordStart < 0) return;
    const raw = normalized.slice(wordStart, end);
    tokens.push({ term: `w:${raw.slice(0, WORD_MAX_LENGTH)}`, kind: 'word', start: wordStart, end });
    wordStart = -1;
  };

  const flushCjk = (): void => {
    for (let index = 0; index < cjkChars.length; index += 1) {
      const ch = cjkChars[index]!;
      const start = cjkOffsets[index]!;
      const end = start + ch.length;
      tokens.push({ term: `u:${ch}`, kind: 'unigram', start, end });
      if (index > 0) {
        const prev = cjkChars[index - 1]!;
        tokens.push({
          term: `b:${prev}${ch}`,
          kind: 'bigram',
          start: cjkOffsets[index - 1]!,
          end
        });
      }
    }
    cjkChars = [];
    cjkOffsets = [];
  };

  let offset = 0;
  for (const ch of normalized) {
    if (isWordChar(ch)) {
      flushCjk();
      if (wordStart < 0) wordStart = offset;
    } else if (isCjkChar(ch)) {
      flushWord(offset);
      cjkChars.push(ch);
      cjkOffsets.push(offset);
    } else {
      flushWord(offset);
      flushCjk();
    }
    offset += ch.length;
  }
  flushWord(normalized.length);
  flushCjk();
  return tokens;
}

/** 统计一段文本的词项频率，供索引写入与 BM25 的 termCount 使用。 */
export function analyze(text: string): Map<string, TermStat> {
  const stats = new Map<string, TermStat>();
  for (const token of tokenize(text)) {
    const existing = stats.get(token.term);
    if (existing) {
      existing.tf += 1;
    } else {
      stats.set(token.term, { tf: 1, kind: token.kind });
    }
  }
  return stats;
}

export interface QueryAnalysis {
  /** 去重后的查询词项（带前缀），AND 语义 */
  terms: string[];
  kinds: Map<string, TermKind>;
}

/** 查询分析与索引分析共用同一分词管线，保证两侧词项一致。 */
export function analyzeQuery(query: string): QueryAnalysis {
  const stats = analyze(query);
  const terms = [...stats.keys()].slice(0, QUERY_MAX_TERMS);
  const kinds = new Map<string, TermKind>();
  for (const term of terms) {
    kinds.set(term, stats.get(term)?.kind ?? 'word');
  }
  return { terms, kinds };
}
