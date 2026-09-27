import { describe, expect, it } from 'vitest';
import { tokenize } from './tokenizer.js';

describe('tokenize', () => {
  it('拉丁字母与数字按词切分并转小写', () => {
    expect(tokenize('Hello, Kafka! 1984')).toEqual(['hello', 'kafka', '1984']);
  });

  it('写入侧 CJK 产出单字 + 二元组', () => {
    expect(tokenize('读书笔记')).toEqual(['读', '书', '笔', '记', '读书', '书笔', '笔记']);
  });

  it('查询侧 CJK 长串只产出二元组', () => {
    expect(tokenize('读书笔记', { forQuery: true })).toEqual(['读书', '书笔', '笔记']);
  });

  it('单个 CJK 字两侧都按单字处理', () => {
    expect(tokenize('山')).toEqual(['山']);
    expect(tokenize('山', { forQuery: true })).toEqual(['山']);
  });

  it('中英文混排', () => {
    const indexed = tokenize('重读Kafka的笔记');
    expect(indexed).toContain('kafka');
    expect(indexed).toContain('笔记');
    expect(tokenize('Kafka 笔记', { forQuery: true })).toEqual(['kafka', '笔记']);
  });

  it('纯标点与空白没有可检索词', () => {
    expect(tokenize('！？。，  ')).toEqual([]);
    expect(tokenize('')).toEqual([]);
  });

  it('NFC 归一化后等价文本产出等价词项', () => {
    const composed = ' café'.normalize('NFC');
    const decomposed = ' café'.normalize('NFD');
    expect(tokenize(composed)).toEqual(tokenize(decomposed));
  });
});
