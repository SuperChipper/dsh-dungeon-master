import { describe, expect, it, vi } from 'vitest';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import {
  buildHandoffTranscript,
  formatHandoffHint,
  HANDOFF_MAX_CHARS,
  HandoffWriter,
  parseHandoff,
  type HandoffTurn,
} from './session-handoff.ts';
import type { JudgeLlm } from './reply-judge.ts';

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

function turns(...pairs: Array<[HandoffTurn['role'], string]>): HandoffTurn[] {
  return pairs.map(([role, text]) => ({ role, text }));
}

describe('buildHandoffTranscript', () => {
  it('没聊几句不交接；空消息不算数', () => {
    expect(buildHandoffTranscript([])).toBeUndefined();
    expect(buildHandoffTranscript(turns(['user', '在吗'], ['assistant', '在']))).toBeUndefined();
    expect(buildHandoffTranscript(turns(['user', '在吗'], ['user', '   '], ['assistant', '在']))).toBeUndefined();
  });

  it('按旧→新拼接，标出是谁说的', () => {
    const text = buildHandoffTranscript(turns(['user', '帮我查下周的天气'], ['assistant', '好，查到了告诉你'], ['user', '顺便看看机票']));
    expect(text).toBe('【用户侧】帮我查下周的天气\n\n【机器人】好，查到了告诉你\n\n【用户侧】顺便看看机票');
  });

  it('用户消息留尾巴（前面拼的是历史和提示），机器人消息留开头', () => {
    const user = `${'历史'.repeat(2000)}真正说的话`;
    const bot = `回答开头${'废话'.repeat(2000)}`;
    const text = buildHandoffTranscript(turns(['user', user], ['assistant', bot], ['user', '第二句']))!;
    expect(text).toContain('真正说的话');
    expect(text).toContain('（前略）');
    expect(text).toContain('【机器人】回答开头');
    expect(text).toContain('（后略）');
  });

  it('超出总字数时丢最旧的，最新的一定在', () => {
    const many = Array.from({ length: 60 }, (_, i) => ['user', `第${i}条 ${'字'.repeat(1000)}`] as [HandoffTurn['role'], string]);
    const text = buildHandoffTranscript(turns(...many))!;
    expect(text).toContain('第59条');
    expect(text).not.toContain('第0条 ');
    expect(text.length).toBeLessThan(14_000);
  });
});

describe('parseHandoff', () => {
  it('空和「无」都算没有交接', () => {
    expect(parseHandoff('')).toBeUndefined();
    expect(parseHandoff(' 无 ')).toBeUndefined();
    expect(parseHandoff('无。')).toBeUndefined();
  });

  it('正文原样保留，超长截断', () => {
    expect(parseHandoff('- 你答应明天提醒他交报告')).toBe('- 你答应明天提醒他交报告');
    expect(parseHandoff('无法确定机票时间，用户还在等')).toBe('无法确定机票时间，用户还在等');
    expect(parseHandoff('字'.repeat(HANDOFF_MAX_CHARS * 2))!.length).toBeLessThan(HANDOFF_MAX_CHARS + 10);
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

describe('HandoffWriter', () => {
  function llmReturning(text: string, seen: GenerateOptions[] = []): JudgeLlm {
    return {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        seen.push(options);
        yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk;
        yield { type: 'text-delta', index: 0, text } as StreamChunk;
        yield { type: 'block-end', index: 0, block: { type: 'text', text } } as StreamChunk;
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk;
      },
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] } }),
    };
  }

  it('把记录交给模型，用最低推理档，返回交接正文', async () => {
    const seen: GenerateOptions[] = [];
    const writer = new HandoffWriter(llmReturning('- 你答应明天提醒他交报告', seen), logger);
    const out = await writer.write({ provider: 'p', model: 'm', transcript: '【用户侧】明天提醒我交报告' });
    expect(out).toBe('- 你答应明天提醒他交报告');
    expect(seen[0]).toMatchObject({ provider: 'p', model: 'm', reasoningEffort: 'low' });
    expect(JSON.stringify(seen[0]!.messages)).toContain('明天提醒我交报告');
  });

  it('模型说没什么可交接、或调用出错，都返回 undefined', async () => {
    expect(await new HandoffWriter(llmReturning('无'), logger).write({ provider: 'p', model: 'm', transcript: 'x' })).toBeUndefined();
    const broken: JudgeLlm = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<StreamChunk> { throw new Error('upstream down'); },
    };
    expect(await new HandoffWriter(broken, logger).write({ provider: 'p', model: 'm', transcript: 'x' })).toBeUndefined();
  });
});
