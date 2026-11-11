import { describe, expect, it } from 'vitest';
import { formatHandoffHint, HANDOFF_MAX_CHARS, latestCompactionSummary } from './session-handoff.ts';

function summaryEvent(text: string) {
  return { type: 'compaction/summary', data: { compactionId: 'c', summary: [{ type: 'text', text }], shadowedSeqs: [1, 2] } };
}

describe('latestCompactionSummary', () => {
  it('没压缩过的会话没有交接', () => {
    expect(latestCompactionSummary(undefined)).toBeUndefined();
    expect(latestCompactionSummary([])).toBeUndefined();
    expect(latestCompactionSummary([{ type: 'user/message' }, { type: 'assistant/message' }])).toBeUndefined();
  });

  it('取最新一条压缩摘要的正文', () => {
    const events = [
      summaryEvent('第一次压缩：用户在问天气'),
      { type: 'user/message' },
      { type: 'compaction/start', data: { compactionId: 'd' } },
      summaryEvent('第二次压缩：你答应明天提醒他交报告'),
      { type: 'compaction/end', data: { compactionId: 'd' } },
    ];
    expect(latestCompactionSummary(events)).toBe('第二次压缩：你答应明天提醒他交报告');
  });

  it('最新一条是空的或形状不对时往前找', () => {
    const events = [
      summaryEvent('能用的那条'),
      { type: 'compaction/summary', data: { summary: [{ type: 'text', text: '   ' }] } },
      { type: 'compaction/summary', data: { summary: 'not-an-array' } },
      { type: 'compaction/summary' },
    ];
    expect(latestCompactionSummary(events)).toBe('能用的那条');
  });

  it('多个文本块拼起来；超长截断', () => {
    const multi = { type: 'compaction/summary', data: { summary: [{ type: 'text', text: '上半' }, { type: 'image' }, { type: 'text', text: '下半' }] } };
    expect(latestCompactionSummary([multi])).toBe('上半\n\n下半');
    const long = latestCompactionSummary([summaryEvent('字'.repeat(HANDOFF_MAX_CHARS * 2))])!;
    expect(long.length).toBeLessThan(HANDOFF_MAX_CHARS + 10);
    expect(long).toContain('（后略）');
  });
});

describe('formatHandoffHint', () => {
  it('说明这是转述、以对方现在说的为准', () => {
    const hint = formatHandoffHint('- 你答应明天提醒他交报告');
    expect(hint).toMatch(/^\[上一段会话的交接\]/);
    expect(hint).toContain('转述');
    expect(hint).toContain('- 你答应明天提醒他交报告');
  });
});
