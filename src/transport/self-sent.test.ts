import { describe, expect, it } from 'vitest';
import { SelfSentIndex, mediaQuoteText, mediaRefIdx } from './self-sent.ts';

describe('SelfSentIndex', () => {
  it('空键不记', () => {
    const index = new SelfSentIndex();
    index.record(undefined, 'a');
    index.record('', 'b');
    expect(index.size()).toBe(0);
  });

  it('超过上限丢最早的', () => {
    const index = new SelfSentIndex(2);
    index.record('r1', 'a');
    index.record('r2', 'b');
    index.record('r3', 'c');
    expect(index.get('r1')).toBeUndefined();
    expect(index.get('r3')?.content).toBe('c');
  });
});

describe('mediaRefIdx', () => {
  it('取富媒体发送结果里的 ext_info.ref_idx，不是 message id', () => {
    expect(mediaRefIdx({ upload: { file_uuid: 'u' }, message: { id: 'msg-1', ext_info: { ref_idx: 'REFIDX_9' } } }))
      .toBe('REFIDX_9');
  });

  it('没有 ref_idx 时返回 undefined', () => {
    expect(mediaRefIdx({ upload: { file_uuid: 'u' }, message: { id: 'msg-1' } })).toBeUndefined();
    expect(mediaRefIdx({ upload: { file_uuid: 'u' } })).toBeUndefined();
    expect(mediaRefIdx(undefined)).toBeUndefined();
  });
});

describe('mediaQuoteText', () => {
  it('有配文带上配文，没有只留类型', () => {
    expect(mediaQuoteText('图片', '不许学我心声')).toBe('[图片] 不许学我心声');
    expect(mediaQuoteText('语音', undefined)).toBe('[语音]');
    expect(mediaQuoteText('图片', '  ')).toBe('[图片]');
  });
});
