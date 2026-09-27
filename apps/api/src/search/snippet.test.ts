import { describe, expect, it } from 'vitest';
import { buildSnippet } from './snippet.js';
import { analyzeQuery } from './terms.js';

function queryTerms(query: string): Set<string> {
  return new Set(analyzeQuery(query).terms);
}

describe('search snippet', () => {
  it('centers the window on the matched term and marks highlights', () => {
    const content = '这是一段很长的批注。'.repeat(10) + '存在主义是一种人道主义。' + '后面的内容。'.repeat(10);
    const snippet = buildSnippet(content, queryTerms('人道主义'));
    expect(snippet.text).toContain('人道主义');
    expect(snippet.text.startsWith('…')).toBe(true);
    expect(snippet.text.endsWith('…')).toBe(true);
    expect(snippet.highlights.length).toBeGreaterThan(0);
    for (const range of snippet.highlights) {
      const fragment = snippet.text.slice(range.start, range.end);
      expect(fragment.length).toBeGreaterThan(0);
    }
    // 高亮区间必须落在摘要文本内
    for (const range of snippet.highlights) {
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(snippet.text.length);
    }
  });

  it('prefers bigram anchors over unigram anchors', () => {
    const content = '存一存二存三。真正的存在主义在这里展开讨论。';
    const snippet = buildSnippet(content, queryTerms('存在'));
    expect(snippet.text).toContain('存在主义');
  });

  it('returns the leading window when nothing matches', () => {
    const snippet = buildSnippet('没有任何命中词的一段文字', queryTerms('kafka'));
    expect(snippet.highlights).toEqual([]);
    expect(snippet.text.length).toBeGreaterThan(0);
  });

  it('handles matches at the very start without ellipsis prefix', () => {
    const snippet = buildSnippet('存在主义开头即命中，后面还有很多内容需要截断处理。', queryTerms('存在主义'));
    expect(snippet.text.startsWith('…')).toBe(false);
  });
});
