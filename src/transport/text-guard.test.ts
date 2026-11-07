import { describe, expect, it } from 'vitest';
import { dropTrailingPeriod, isBlankReply } from './text-guard.ts';

describe('dropTrailingPeriod', () => {
  it('群聊短句去掉句末句号，句中的留着', () => {
    expect(dropTrailingPeriod('吃得多才沉得快，道理我懂，但我不想改。')).toBe('吃得多才沉得快，道理我懂，但我不想改');
    expect(dropTrailingPeriod('区别在这。它是嘴上没把门的。')).toBe('区别在这。它是嘴上没把门的');
    expect(dropTrailingPeriod('好。。')).toBe('好');
    expect(dropTrailingPeriod('  行吧。  ')).toBe('行吧');
  });

  it('不是句号结尾的不动', () => {
    expect(dropTrailingPeriod('那得看……')).toBe('那得看……');
    expect(dropTrailingPeriod('你确定？')).toBe('你确定？');
  });

  it('长段、多行、代码、链接是在讲正事，不动', () => {
    const long = `${'这是一段很长的解释'.repeat(10)}。`;
    expect(dropTrailingPeriod(long)).toBe(long);
    expect(dropTrailingPeriod('第一句。\n第二句。')).toBe('第一句。\n第二句。');
    expect(dropTrailingPeriod('用 `npm run build` 就行。')).toBe('用 `npm run build` 就行。');
    expect(dropTrailingPeriod('看这里 https://example.com 。')).toBe('看这里 https://example.com 。');
  });

  it('只有一个句号的静音回复原样交给 isBlankReply 丢掉', () => {
    expect(dropTrailingPeriod('。')).toBe('。');
    expect(isBlankReply(dropTrailingPeriod('。'))).toBe(true);
  });
});
