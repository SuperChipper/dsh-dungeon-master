import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { REPLY_JUDGE_DEFAULTS, type ReplyJudgeConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import {
  JudgeQueue,
  ReplyJudge,
  buildJudgeSystem,
  buildJudgeTranscript,
  parseDesire,
  pickLowestEffort,
  type JudgeLlm,
} from './reply-judge.ts';

const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

describe('pickLowestEffort', () => {
  it('按 none → minimal → low 的顺序挑，挑不到返回 undefined', () => {
    expect(pickLowestEffort([{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }, { id: 'none', name: 'Off' }])).toBe('none');
    expect(pickLowestEffort([{ id: 'max', name: 'Max' }, { id: 'e1', name: 'Minimal' }])).toBe('e1');
    expect(pickLowestEffort([{ id: 'high', name: 'High' }])).toBeUndefined();
  });
});

describe('buildJudgeSystem', () => {
  it('不因为是群友之间聊天就给低分，看有没有具体可接的点', () => {
    const system = buildJudgeSystem(['小d']);
    expect(system).not.toContain('群友之间在聊自己的事');
    expect(system).toContain('前后矛盾');
    expect(system).toContain('拿不准就给低分');
  });

  it('带图片时引导裁判直接看图内容，跑团模式切换极克制的旁观 DM 提示词', () => {
    const withImages = buildJudgeSystem(['小d'], undefined, { hasImages: true });
    expect(withImages).toContain('附带了对话窗口内刚发的图片');
    expect(withImages).not.toContain('低分补充：只是发了图');

    const dndSystem = buildJudgeSystem(['小d'], undefined, { dnd: true, hasImages: true });
    expect(dndSystem).toContain('旁观 DM');
    expect(dndSystem).toContain('玩家之间商量战术');
    expect(dndSystem).toContain('即使处在对话窗口内');
    expect(dndSystem).toContain('角色卡/规则截图');
  });
});

describe('parseDesire', () => {
  it('解析 JSON 或裸数字，截到 0-1', () => {
    expect(parseDesire('{"desire": 73}')).toBe(0.73);
    expect(parseDesire('```json\n{"desire":150}\n```')).toBe(1);
    expect(parseDesire('desire：20')).toBe(0.2);
    expect(parseDesire('45')).toBe(0.45);
    expect(parseDesire('不想接')).toBeUndefined();
  });
});

describe('buildJudgeTranscript', () => {
  it('bot 的话标 [bot]，最后一条标 ▶，长消息截断', () => {
    const t = buildJudgeTranscript([
      { sender: '阿明', text: '今天好热', timestamp: 0 },
      { text: '开空调啊', timestamp: 1 },
      { sender: '小红', text: 'x'.repeat(500), timestamp: 2 },
    ]);
    const rows = t.split('\n').slice(1);
    expect(rows[1]).toMatch(/\[bot\]: 开空调啊$/);
    expect(rows[2]!.startsWith('▶ ')).toBe(true);
    expect(rows[2]!.length).toBeLessThan(260);
  });

  it('传入 hints 和附带图片数时追加参考线索行', () => {
    const t = buildJudgeTranscript(
      [{ sender: '阿明', text: '[图片]', timestamp: 0 }],
      { dnd: true, engaged: true, engagedPeer: true, named: true, sticker: true, stickerCollection: 'pack' },
      2,
    );
    expect(t).toContain('参考线索：');
    expect(t).toContain('旁观 DM');
    expect(t).toContain('最新发送者刚和 bot 聊过');
    expect(t).toContain('命中 bot 昵称/别名');
    expect(t).toContain('bot 自带表情包');
    expect(t).toContain('随附 2 张对话窗口内图片');
  });
});

function fakeLlm(
  reply: string,
  efforts?: Array<{ id: string; name: string }>,
  inputModalities?: readonly string[],
) {
  const calls: GenerateOptions[] = [];
  const llm: JudgeLlm = {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk;
      yield { type: 'text-delta', index: 0, text: reply } as StreamChunk;
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } } as StreamChunk;
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk;
    },
    resolveModelInfo: vi.fn(async () => ({
      ...(efforts !== undefined ? { reasoning: { efforts } } : {}),
      ...(inputModalities !== undefined ? { inputModalities } : {}),
    })),
  };
  return { llm, calls };
}

const request = { provider: 'p', model: 'm', names: ['小d'], lines: [{ sender: 'a', text: '在吗', timestamp: 0 }] };

describe('ReplyJudge', () => {
  it('自动用最低推理档，同一模型只查一次档位', async () => {
    const { llm, calls } = fakeLlm('{"desire": 80}', [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }]);
    const judge = new ReplyJudge(llm, () => REPLY_JUDGE_DEFAULTS, logger);
    expect(await judge.score(request)).toBe(0.8);
    await judge.score(request);
    expect(calls[0]!.reasoningEffort).toBe('low');
    expect(calls[0]!.system).toContain('小d');
    expect(calls[0]!.system).toContain('名字的变体');
    expect(llm.resolveModelInfo).toHaveBeenCalledTimes(1);
  });

  it('配置了档位就直接用；模型不给档位就不传', async () => {
    const configured = fakeLlm('{"desire": 10}', [{ id: 'low', name: 'Low' }]);
    await new ReplyJudge(configured.llm, () => ({ ...REPLY_JUDGE_DEFAULTS, reasoningEffort: 'medium' }), logger).score(request);
    expect(configured.calls[0]!.reasoningEffort).toBe('medium');
    const none = fakeLlm('{"desire": 10}');
    await new ReplyJudge(none.llm, () => REPLY_JUDGE_DEFAULTS, logger).score(request);
    expect(none.calls[0]!.reasoningEffort).toBeUndefined();
  });

  it('出错按 undefined 处理，不抛', async () => {
    const llm: JudgeLlm = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<StreamChunk> { throw new Error('boom'); },
    };
    expect(await new ReplyJudge(llm, () => REPLY_JUDGE_DEFAULTS, logger).score(request)).toBeUndefined();
  });

  it('多模态模型支持附带 ImageBlock 参与打分，纯文本模型自动剥离图片块且共用能力缓存', async () => {
    const imageBlock = {
      type: 'image' as const,
      attachment: { id: 'att-1', mediaType: 'image/png' as const, size: 128 },
    };
    const multimodal = fakeLlm('{"desire": 85}', [{ id: 'low', name: 'Low' }], ['text', 'image']);
    const judge = new ReplyJudge(multimodal.llm, () => REPLY_JUDGE_DEFAULTS, logger);
    expect(await judge.supportsImageInput('p', 'm')).toBe(true);
    const score = await judge.score({
      ...request,
      hints: { engaged: true, engagedPeer: true },
      images: [{ label: '[图片#1（来自a，最新消息）]', block: imageBlock }],
    });
    expect(score).toBe(0.85);
    expect(multimodal.llm.resolveModelInfo).toHaveBeenCalledTimes(1);
    const blocks = multimodal.calls[0]!.messages[0]!.content;
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
    expect(multimodal.calls[0]!.system).toContain('附带了对话窗口内刚发的图片');

    const textOnly = fakeLlm('{"desire": 20}', [{ id: 'low', name: 'Low' }], ['text']);
    const textJudge = new ReplyJudge(textOnly.llm, () => REPLY_JUDGE_DEFAULTS, logger);
    expect(await textJudge.supportsImageInput('p', 'm')).toBe(false);
    expect(await textJudge.score({
      ...request,
      images: [{ label: '[图片#1]', block: imageBlock }],
    })).toBe(0.2);
    expect(textOnly.calls[0]!.messages[0]!.content.some((b) => b.type === 'image')).toBe(false);
  });
});

describe('JudgeQueue', () => {
  afterEach(() => { vi.useRealTimers(); });
  const cfg: ReplyJudgeConfig = { ...REPLY_JUDGE_DEFAULTS, debounceMs: 1000, maxWaitMs: 2500 };

  it('连着来的候选只有最后一条去打分', async () => {
    vi.useFakeTimers();
    const q = new JudgeQueue(() => cfg);
    const first = q.enqueue('g', 0);
    vi.advanceTimersByTime(500);
    const second = q.enqueue('g', 500);
    expect(await first).toBe('superseded');
    vi.advanceTimersByTime(1000);
    expect(await second).toBe('judge');
  });

  it('一直有动静时，最早那条排满 maxWaitMs 也要打分', async () => {
    vi.useFakeTimers();
    const q = new JudgeQueue(() => cfg);
    const p = q.enqueue('g', 0);
    let settled: string | undefined;
    void p.then((v) => { settled = v; });
    for (let t = 800; t <= 2400; t += 800) {
      vi.advanceTimersByTime(800);
      q.activity('g', t);
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe('judge');
  });

  it('bot 反正要说话时 cancel 掉候选', async () => {
    vi.useFakeTimers();
    const q = new JudgeQueue(() => cfg);
    const p = q.enqueue('g', 0);
    q.cancel('g');
    expect(await p).toBe('superseded');
  });
});
