import { describe, it, expect, vi } from 'vitest';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { NOTE_JUDGE_DEFAULTS } from '../config.ts';
import type { Logger } from '../types.ts';
import type { JudgeLlm } from './reply-judge.ts';
import {
  NoteJudge,
  buildNoteJudgePrompt,
  parseNoteScores,
  shouldMute,
  smoothedRelevance,
} from './note-judge.ts';

const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function fakeLlm(reply: string | (() => string), efforts?: Array<{ id: string; name: string }>) {
  const calls: GenerateOptions[] = [];
  const llm: JudgeLlm = {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options);
      const text = typeof reply === 'string' ? reply : reply();
      yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk;
      yield { type: 'text-delta', index: 0, text } as StreamChunk;
      yield { type: 'block-end', index: 0, block: { type: 'text', text } } as StreamChunk;
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk;
    },
    resolveModelInfo: vi.fn(async () => (efforts === undefined ? {} : { reasoning: { efforts } })),
  };
  return { llm, calls };
}

const notes = [
  { file: 'a.md', heading: 'A › 一', text: '第一段' },
  { file: 'b.md', heading: 'B', text: '第二段' },
];
const request = { provider: 'p', model: 'm', query: '今天吃什么', notes };

describe('parseNoteScores', () => {
  it('解析 JSON、带解释的输出和裸数组，折算到 0-1', () => {
    expect(parseNoteScores('{"scores":[2,0]}', 2)).toEqual([1, 0]);
    expect(parseNoteScores('```json\n{"scores": [1, 2]}\n```\n第一段是背景', 2)).toEqual([0.5, 1]);
    expect(parseNoteScores('[0]', 1)).toEqual([0]);
  });

  it('个数对不上、越界或不是数字时整轮作废', () => {
    expect(parseNoteScores('{"scores":[2]}', 2)).toBeUndefined();
    expect(parseNoteScores('{"scores":[2,0,1]}', 2)).toBeUndefined();
    expect(parseNoteScores('{"scores":[3,0]}', 2)).toBeUndefined();
    expect(parseNoteScores('{"scores":["高","低"]}', 2)).toBeUndefined();
    expect(parseNoteScores('都不相关', 2)).toBeUndefined();
  });
});

describe('buildNoteJudgePrompt', () => {
  it('笔记带编号和标题路径，长消息截断', () => {
    const prompt = buildNoteJudgePrompt('问'.repeat(900), notes);
    expect(prompt).toContain('#1 a.md › A › 一\n第一段');
    expect(prompt).toContain('#2 b.md › B\n第二段');
    expect(prompt).toContain('共 2 段');
    expect(prompt.length).toBeLessThan(600);
  });

  it('带上最近对话背景、本轮调用工具和机器人实际回复', () => {
    const prompt = buildNoteJudgePrompt('发出来看看', notes, {
      contextLines: [
        { sender: '阿明', text: '昨天那张深渊巨口海报改完了吗', timestamp: new Date(2026, 10, 14, 1, 10, 1).getTime() },
        { text: '改完第三版了', timestamp: new Date(2026, 10, 14, 1, 10, 5).getTime() },
      ],
      toolsUsed: ['qqbot_notes_search', 'qqbot_send_file'],
      reply: '[配文] 第三版深渊巨口海报给你们端上来了',
    });
    expect(prompt).toContain('最近的对话背景：');
    expect(prompt).toContain('01:10:01 阿明: 昨天那张深渊巨口海报改完了吗');
    expect(prompt).toContain('01:10:05 [bot]: 改完第三版了');
    expect(prompt).toContain('机器人本轮调用的工具：qqbot_notes_search, qqbot_send_file');
    expect(prompt).toContain('机器人本轮回复：\n[配文] 第三版深渊巨口海报给你们端上来了');
  });
});

describe('shouldMute', () => {
  const policy = { minSamples: 8, muteBelow: 0.3 };

  it('没评够次数不静音，哪怕全是 0 分', () => {
    expect(shouldMute({ judged: 7, relevanceSum: 0 }, policy)).toBe(false);
    expect(shouldMute({ judged: 8, relevanceSum: 0 }, policy)).toBe(true);
  });

  it('先验把均分往中间拉：刚过样本数的边缘情况不静音', () => {
    // 原始均分 0.25 < 0.3，平滑后 (2 + 1.5) / 11 ≈ 0.32
    expect(smoothedRelevance(2, 8)).toBeCloseTo(0.318, 2);
    expect(shouldMute({ judged: 8, relevanceSum: 2 }, policy)).toBe(false);
  });

  it('muteBelow 为 0 时只打分不静音', () => {
    expect(shouldMute({ judged: 100, relevanceSum: 0 }, { minSamples: 8, muteBelow: 0 })).toBe(false);
  });
});

describe('NoteJudge', () => {
  it('把查询和笔记交给模型，用最低推理档，返回 0-1 分数', async () => {
    const { llm, calls } = fakeLlm('{"scores":[2,1]}', [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }]);
    const judge = new NoteJudge(llm, () => NOTE_JUDGE_DEFAULTS, logger);
    expect(await judge.enqueue(request)).toEqual([1, 0.5]);
    expect(calls[0]!.reasoningEffort).toBe('low');
    expect(calls[0]!.provider).toBe('p');
    const content = calls[0]!.messages[0]!.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toContain('今天吃什么');
  });

  it('模型出错或输出解析不了时返回 undefined，不抛错', async () => {
    const bad = new NoteJudge(fakeLlm('我觉得都挺相关').llm, () => NOTE_JUDGE_DEFAULTS, logger);
    expect(await bad.enqueue(request)).toBeUndefined();
    const failing: JudgeLlm = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<StreamChunk> { throw new Error('upstream 503'); },
    };
    expect(await new NoteJudge(failing, () => NOTE_JUDGE_DEFAULTS, logger).enqueue(request)).toBeUndefined();
  });

  it('串行执行：前一条失败不影响后一条', async () => {
    let n = 0;
    const { llm, calls } = fakeLlm(() => (++n === 1 ? '乱码' : '{"scores":[0,0]}'));
    const judge = new NoteJudge(llm, () => NOTE_JUDGE_DEFAULTS, logger);
    const [first, second] = await Promise.all([judge.enqueue(request), judge.enqueue(request)]);
    expect(first).toBeUndefined();
    expect(second).toEqual([0, 0]);
    expect(calls).toHaveLength(2);
  });

  it('没有笔记时不调模型', async () => {
    const { llm, calls } = fakeLlm('{"scores":[]}');
    const judge = new NoteJudge(llm, () => NOTE_JUDGE_DEFAULTS, logger);
    expect(await judge.enqueue({ ...request, notes: [] })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('校验上游模型支持的推理档位：保留支持的 low、降级不支持的 off、非推理模型不传', async () => {
    // 1. opencode-go 类模型同时声明 off 与 low，显式配了 low 时保留 low（避免 off:null 回退满血思考）
    const keepLow = fakeLlm('{"scores":[2,0]}', [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]);
    await new NoteJudge(keepLow.llm, () => NOTE_JUDGE_DEFAULTS, logger).score({ ...request, reasoningEffort: 'low' });
    expect(keepLow.calls[0]!.reasoningEffort).toBe('low');

    // 2. Gemini 类路由没有 off 档位，配置了 off 时自动降级到该模型支持的最低档 low
    const noOff = fakeLlm('{"scores":[1,0]}', [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }]);
    await new NoteJudge(noOff.llm, () => NOTE_JUDGE_DEFAULTS, logger).score({ ...request, reasoningEffort: 'off' });
    expect(noOff.calls[0]!.reasoningEffort).toBe('low');

    // 3. 非推理模型（efforts 为空）即使继承了配置的档位也不传 reasoningEffort
    const nonReasoning = fakeLlm('{"scores":[0,0]}');
    await new NoteJudge(nonReasoning.llm, () => NOTE_JUDGE_DEFAULTS, logger).score({ ...request, reasoningEffort: 'low' });
    expect(nonReasoning.calls[0]!.reasoningEffort).toBeUndefined();
  });

  it('流式 finish 为 aborted / error / max-tokens 时准确记日志并返回 undefined', async () => {
    const warn = vi.fn();
    const localLogger = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() } as unknown as Logger;
    const makeFinishLlm = (reason: Extract<StreamChunk, { type: 'finish' }>['reason']): JudgeLlm => ({
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason } as StreamChunk;
      },
      resolveModelInfo: async () => ({}),
    });

    const aborted = new NoteJudge(
      makeFinishLlm({ kind: 'aborted', failure: { code: 'ABORTED', message: 'The operation was aborted due to timeout' } } as never),
      () => NOTE_JUDGE_DEFAULTS,
      localLogger,
    );
    expect(await aborted.score(request)).toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('打分超时或中断'));

    const errored = new NoteJudge(
      makeFinishLlm({ kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'no off' } } as never),
      () => NOTE_JUDGE_DEFAULTS,
      localLogger,
    );
    expect(await errored.score(request)).toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('UNSUPPORTED_REASONING_EFFORT'));

    const maxTokens = new NoteJudge(
      makeFinishLlm({ kind: 'max-tokens' }),
      () => NOTE_JUDGE_DEFAULTS,
      localLogger,
    );
    expect(await maxTokens.score(request)).toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('思考耗尽 maxTokens'));
  });
});
