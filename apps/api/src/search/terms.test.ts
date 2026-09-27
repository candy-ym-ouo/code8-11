import { describe, expect, it } from 'vitest';
import { analyze, analyzeQuery, tokenize } from './terms.js';

describe('search tokenizer', () => {
  it('splits latin text into lowercase word terms', () => {
    const terms = tokenize('Hello, World! foo_bar 42').map((token) => token.term);
    expect(terms).toEqual(['w:hello', 'w:world', 'w:foo_bar', 'w:42']);
  });

  it('emits unigrams and bigrams for CJK runs', () => {
    const terms = tokenize('存在主义').map((token) => token.term);
    expect(terms).toEqual(['u:存', 'u:在', 'b:存在', 'u:主', 'b:在主', 'u:义', 'b:主义']);
  });

  it('keeps CJK and latin tokens separate across boundaries', () => {
    const terms = tokenize('读Kafka的书').map((token) => token.term);
    expect(terms).toEqual(['u:读', 'w:kafka', 'u:的', 'u:书', 'b:的书']);
  });

  it('normalizes full-width characters and case before tokenizing', () => {
    const terms = tokenize('Ｈｅｌｌｏ　ＷＯＲＬＤ').map((token) => token.term);
    expect(terms).toEqual(['w:hello', 'w:world']);
  });

  it('treats punctuation and emoji as separators', () => {
    const terms = tokenize('好——久不见🌙了').map((token) => token.term);
    expect(terms).toEqual(['u:好', 'u:久', 'u:不', 'b:久不', 'u:见', 'b:不见', 'u:了']);
  });

  it('counts term frequency with analyze', () => {
    const stats = analyze('重读 重读 重读');
    expect(stats.get('w:')?.tf).toBeUndefined();
    expect(stats.get('u:重')?.tf).toBe(3);
    expect(stats.get('b:重读')?.tf).toBe(3);
    expect(stats.get('u:读')?.tf).toBe(3);
  });

  it('deduplicates query terms and reports their kinds', () => {
    const analysis = analyzeQuery('存在 存在 kafka');
    expect(analysis.terms.sort()).toEqual(['b:存在', 'u:存', 'u:在', 'w:kafka'].sort());
    expect(analysis.kinds.get('b:存在')).toBe('bigram');
    expect(analysis.kinds.get('w:kafka')).toBe('word');
  });

  it('returns no terms for separator-only input', () => {
    expect(analyzeQuery('  ——  ').terms).toEqual([]);
  });
});
