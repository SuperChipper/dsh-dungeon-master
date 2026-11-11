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
});
