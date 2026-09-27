import { tokenize, type TermKind } from './terms.js';

/**
 * 命中摘要：从文档原文中截取以命中词为中心的窗口，
 * 并给出窗口内命中词的高亮区间（前端按纯文本渲染，不用 v-html）。
 */

export interface HighlightRange {
  start: number;
  end: number;
}

export interface Snippet {
  text: string;
  highlights: HighlightRange[];
}

const SNIPPET_RADIUS = 40;
const KIND_PRIORITY: Record<TermKind, number> = { bigram: 0, word: 1, unigram: 2 };

export function buildSnippet(content: string, queryTerms: ReadonlySet<string>): Snippet {
  const tokens = tokenize(content);
  const hits = tokens.filter((token) => queryTerms.has(token.term));
  if (hits.length === 0) {
    return { text: content.slice(0, SNIPPET_RADIUS * 2), highlights: [] };
  }

  // 选锚点：优先 bigram/word，其次取文本中最早出现的位置。
  const anchor = hits.reduce((best, token) => {
    const kindDiff = KIND_PRIORITY[token.kind] - KIND_PRIORITY[best.kind];
    if (kindDiff < 0) return token;
    if (kindDiff === 0 && token.start < best.start) return token;
    return best;
  });

  const windowStart = Math.max(0, anchor.start - SNIPPET_RADIUS);
  const windowEnd = Math.min(content.length, anchor.end + SNIPPET_RADIUS);
  const prefix = windowStart > 0 ? '…' : '';
  const suffix = windowEnd < content.length ? '…' : '';
  const text = prefix + content.slice(windowStart, windowEnd) + suffix;

  const offset = prefix.length - windowStart;
  const highlights = hits
    .filter((token) => token.end > windowStart && token.start < windowEnd)
    .map((token) => ({
      start: Math.max(token.start, windowStart) + offset,
      end: Math.min(token.end, windowEnd) + offset
    }));

  return { text, highlights };
}
