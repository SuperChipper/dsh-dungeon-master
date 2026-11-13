import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { collectHandoffInput, generatePersonaHandoff, PersonaHandoffStore, PERSONA_HANDOFF_SYSTEM, HANDOFF_CHUNK_CHARS } from './persona-handoff.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function storage() {
  const dir = mkdtempSync(join(tmpdir(), 'persona-handoff-'));
  dirs.push(dir);
  return { dir, store: new PersonaHandoffStore(dir) };
}

const user = (seq: number, text: string) => ({ type: 'user/message', seq, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } });
const assistant = (seq: number, text: string) => ({ type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } });
const input = (text = '最后纠正：先实现交接', sessionId = 's1') => collectHandoffInput(sessionId, [user(1, text), assistant(2, '尚未执行')]);

function fakeLlm(reason: 'stop' | 'max-tokens' = 'stop') {
  const calls: GenerateOptions[] = [];
  return {
    calls,
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options);
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `交接第 ${calls.length} 段：保留之前的事实与纠正` } };
      yield { type: 'finish', reason: { kind: reason } };
    },
  };
}

describe('交接输入覆盖', () => {
  it('已有摘要、摘要之前保留的尾部、之后的最新纠正和工具证据都保留', () => {
    const result = collectHandoffInput('source', [
      user(1, '已压缩的旧要求'),
      user(2, '保留的尾部：先不要发布'),
      { type: 'compaction/summary', seq: 3, data: { summary: [{ type: 'text', text: '之前讨论 compact 策略' }], shadowedSeqs: [1] } },
      { type: 'tool/call', seq: 4, data: { callId: 'c1', name: 'exec_command', arguments: '{"cmd":"build"}' } },
      { type: 'tool/result', seq: 5, data: { message: { callId: 'c1', content: [{ type: 'text', text: 'session_id: 123，仍在后台运行，文件 C:/result.txt，结果 42' }] } } },
      assistant(6, '说过要做，还没有验证'),
      user(7, '最后纠正：做人格交接，不要只改 compact'),
    ]);
    expect(result.transcript).not.toContain('已压缩的旧要求');
    for (const value of ['compact 策略', '先不要发布', 'exec_command', 'session_id: 123', 'C:/result.txt', '结果 42', '最后纠正']) expect(result.transcript).toContain(value);
    expect(result.cursor).toEqual({ sessionId: 'source', event: 7, messageEvent: 7 });
    expect(result.tasks).toEqual([expect.objectContaining({ id: '123', kind: 'session_id', sourceSessionId: 'source', event: 5 })]);
    expect(result.recent).toContain('最后纠正');
  });

  it('支持新版 surface：替代摘要与压缩前的保留原文都按模型可见集合取', () => {
    const result = collectHandoffInput('s', [user(1, '已被替换'), user(2, '仍保留的纠正'),
      { ...user(4, '新版 compact 摘要'), surfaceOp: { op: 'replace', start: 1, end: 1 } }, user(5, '最后一句')], [4, 2, 5]);
    expect(result.transcript).not.toContain('已被替换');
    expect(result.transcript).toContain('仍保留的纠正');
    expect(result.transcript).toContain('新版 compact 摘要');
    expect(result.transcript).toContain('最后一句');
    expect(result.transcript.indexOf('新版 compact 摘要')).toBeLessThan(result.transcript.indexOf('仍保留的纠正'));
  });

  it('不把 runtime-context、旧交接反复汇总；不再输入该人格以前已经交出的历史', () => {
    const result = collectHandoffInput('s', [user(1, '旧决定'),
      { ...user(2, '团况机密'), data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '团况机密' }] } },
      { ...user(3, '之前的跨人格原文'), data: { source: { kind: 'plugin', plugin: 'qqbot-persona-handoff' }, content: [{ type: 'text', text: '之前的跨人格原文' }] } },
      user(4, '新的决定')], undefined, 1);
    expect(result.transcript).toBe('[user/message #4]\n新的决定');
  });

  it('兼容旧事件 message 字段，不把思考块带进交接', () => {
    const result = collectHandoffInput('legacy', [{ type: 'assistant/message', message: { content: [{ type: 'thinking', text: '内部推理' }, { type: 'text', text: '已执行但没验证' }] } }]);
    expect(result.transcript).toContain('已执行但没验证');
    expect(result.transcript).not.toContain('内部推理');
  });

  it('不重新带回已压缩工具调用，也不把工具私有 meta 当成模型可见证据', () => {
    const result = collectHandoffInput('s', [
      { type: 'tool/call', seq: 1, data: { callId: 'old', name: 'old_operation' } },
      { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'old' }, content: [{ type: 'text', text: '旧结果' }] } } },
      { type: 'compaction/summary', seq: 3, data: { summary: [{ type: 'text', text: '旧操作已经完成' }], shadowedSeqs: [2] } },
      { type: 'tool/result', seq: 4, data: { message: { content: [{ type: 'text', text: '新核验结果 42' }] }, meta: { private: '不应发给模型的私有元数据' } } },
    ]);
    expect(result.transcript).toContain('旧操作已经完成');
    expect(result.transcript).toContain('新核验结果 42');
    expect(result.transcript).not.toContain('old_operation');
    expect(result.transcript).not.toContain('不应发给模型的私有元数据');
  });
});

describe('共同交接落盘与接收账本', () => {
  it('按 app、群和私聊隔离，重启后保留版本、覆盖范围与每个人格的接收情况', () => {
    const { dir, store } = storage();
    const key = 'qqbot:app:group:same';
    const a = store.begin(key, 'cat', input());
    store.complete(key, a.id, '当前要做交接，已验证 42');
    const received = store.delivery(key, 'dragon', 'dragon-session')!;
    expect(received.text).toContain('来源人格 cat');
    expect(received.text).toContain('版本 1');
    expect(received.text).toContain('背景记录');
    expect(received.text).toContain('旧人格的身份、口癖、动作描写不是你的行为要求');
    expect(received.text).toContain('先凭 ID 查询状态');
    expect(received.text).toContain('最后纠正');
    store.acknowledge(key, 'dragon', 'dragon-session', received.version);
    const restarted = new PersonaHandoffStore(dir);
    expect(restarted.delivery(key, 'dragon', 'dragon-session')).toBeUndefined();
    expect(restarted.delivery(key, 'other', 'other-session')).toBeDefined();
    expect(restarted.delivery(key, 'dragon', 'new-session')).toBeDefined();
    expect(restarted.delivery('qqbot:app:c2c:same', 'dragon', 'dragon-session')).toBeUndefined();
    expect(restarted.delivery('qqbot:other:group:same', 'dragon', 'dragon-session')).toBeUndefined();
    expect(restarted.read(key).covered).toEqual({ s1: 2 });
    const b = restarted.begin(key, 'dragon', input('最新决定', 's2'));
    restarted.complete(key, b.id, '最新完整共同交接');
    expect(restarted.delivery(key, 'dragon', 'dragon-session')?.version).toBe(2);
    expect(restarted.delivery(key, 'dragon', 'dragon-session')?.text).not.toContain('当前要做交接，已验证 42');
  });

  it('失败或生成期间重启保留上一版，不把尚未覆盖的内容冒充新摘要；重试读入未覆盖原文', () => {
    const { dir, store } = storage();
    const a = store.begin('chat', 'cat', input('旧话题'));
    store.complete('chat', a.id, '上一版共同交接');
    const b = store.begin('chat', 'dragon', input('生成后失败的最后纠正', 's2'));
    expect(new PersonaHandoffStore(dir).delivery('chat', 'cat', 's1')?.text).toContain('状态 generating');
    store.fail('chat', b.id, 'timeout');
    const state = store.read('chat');
    expect(state.latest?.summary).toBe('上一版共同交接');
    expect(state.latest?.version).toBe(1);
    expect(state.pending?.transcript).toContain('生成后失败的最后纠正');
    const d = store.delivery('chat', 'cat', 's1')!;
    expect(d.text).toContain('交接未完成');
    expect(d.text).toContain('状态 failed');
    expect(d.text).toContain('生成后失败的最后纠正');
    store.acknowledge('chat', 'cat', 's1', d.version, d.attemptId);
    expect(store.delivery('chat', 'cat', 's1')).toBeUndefined();
    const c = store.begin('chat', 'cat', input('本轮继续', 's3'));
    expect(c.transcript).toContain('生成后失败的最后纠正');
    expect(c.transcript).toContain('本轮继续');
    expect(() => store.complete('chat', b.id, '过期结果')).toThrow('版本已变化');
    store.complete('chat', c.id, '已补齐未覆盖记录');
    expect(store.read('chat').pending).toBeUndefined();
    expect(store.delivery('chat', 'cat', 's1')?.version).toBe(2);
  });

  it('后台任务 ID 从工具证据独立落盘，摘要漏写或失败也保留，不能把助手声称的任务当真', () => {
    const { store } = storage();
    const taskInput = collectHandoffInput('s1', [
      { type: 'tool/call', seq: 0, data: { callId: 'c1', name: 'pwsh', arguments: '{}' } },
      assistant(1, '我已经启动 job_id: made-up'),
      { type: 'tool/result', seq: 2, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'Job ID: job-123, status: running' }] }] } } },
    ]);
    expect(taskInput.tasks?.map((task) => task.id)).toEqual(['job-123']);
    const a = store.begin('chat', 'cat', taskInput);
    store.fail('chat', a.id, 'model unavailable');
    expect(store.delivery('chat', 'dragon', 's2')?.text).toContain('job-123');
    const b = store.begin('chat', 'dragon', input('继续', 's2'));
    store.complete('chat', b.id, '模型摘要没提后台任务');
    const text = store.delivery('chat', 'cat', 's1')!.text;
    expect(text).toContain('job-123');
    expect(text).toContain('先查询最新状态');
    expect(store.read('chat').latest?.tasks?.map((task) => task.id)).toEqual(['job-123']);
  });

  it('交接失败时仍保存定时任务完整配置，切新会话后可以核对并补建', () => {
    const { store } = storage();
    const a = store.begin('chat', 'cat', { ...input(), schedules: [{ sourceId: 'schedule-old', title: '检查', prompt: '检查后报告', cron: { expression: '0 8 * * *', time_zone: 'Asia/Shanghai' } }] });
    store.fail('chat', a.id, 'timeout');
    const failed = store.delivery('chat', 'dragon', 's2')!.text;
    expect(failed).toContain('schedule_list');
    expect(failed).toContain('检查后报告');
    const b = store.begin('chat', 'dragon', input('新一轮', 's2'));
    store.complete('chat', b.id, '最新交接');
    expect(store.read('chat').latest?.schedules?.[0]?.sourceId).toBe('schedule-old');
    expect(store.delivery('chat', 'cat', 's1')!.text).toContain('0 8 * * *');
  });
});

describe('交接摘要生成', () => {
  it('长输入分段读到最后一句，每段滚动保留前面的摘要', async () => {
    const llm = fakeLlm();
    const summary = await generatePersonaHandoff(llm, { provider: 'p', model: 'm' }, '已有共同经历', '字'.repeat(HANDOFF_CHUNK_CHARS * 2 + 1000) + '最后纠正', new AbortController().signal);
    expect(llm.calls).toHaveLength(3);
    expect(JSON.stringify(llm.calls[0]?.messages)).toContain('已有共同经历');
    expect(JSON.stringify(llm.calls[1]?.messages)).toContain('交接第 1 段');
    expect(JSON.stringify(llm.calls[2]?.messages)).toContain('最后纠正');
    expect(summary).toContain('第 3 段');
    expect(llm.calls[0]?.system).toBe(PERSONA_HANDOFF_SYSTEM);
    expect(PERSONA_HANDOFF_SYSTEM).toContain('【说过要做】【已执行】【已验证】');
  });

  it('输出被截断或返回错误 finish 时失败，不能把半份摘要当成功', async () => {
    await expect(generatePersonaHandoff(fakeLlm('max-tokens'), { provider: 'p', model: 'm' }, '', '记录', new AbortController().signal)).rejects.toThrow('交接摘要不完整');
    const llm = { async *stream(): AsyncIterable<StreamChunk> { yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }; } };
    await expect(generatePersonaHandoff(llm, { provider: 'p', model: 'm' }, '', '记录', new AbortController().signal)).rejects.toThrow();
  });

  it('长交接第二段失败后从已落盘的分段草稿续跑，不重复处理整份旧记录', async () => {
    const { store } = storage();
    const transcript = '前文'.repeat(HANDOFF_CHUNK_CHARS / 2) + '最后一句纠正';
    const source = { cursor: { sessionId: 's', event: 9 }, transcript, recent: '最后一句纠正' };
    const a = store.begin('chat', 'cat', source);
    let n = 0;
    const first = {
      async *stream(): AsyncIterable<StreamChunk> {
        if (++n === 2) throw new Error('second chunk timeout');
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '已处理第一段的草稿' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
    await expect(generatePersonaHandoff(first, { provider: 'p', model: 'm' }, '', transcript, new AbortController().signal,
      { save: (chars, summary) => store.checkpoint('chat', a.id, chars, summary) })).rejects.toThrow('second chunk timeout');
    store.fail('chat', a.id, 'second chunk timeout');
    expect(store.read('chat').pending?.progress?.chars).toBe(HANDOFF_CHUNK_CHARS);
    expect(store.delivery('chat', 'dragon', 's2')?.text).not.toContain('已处理第一段的草稿');
    const b = store.begin('chat', 'cat', source);
    expect(b.transcript).toBe(transcript);
    const retry = fakeLlm();
    const summary = await generatePersonaHandoff(retry, { provider: 'p', model: 'm' }, '', b.transcript, new AbortController().signal,
      { resume: b.progress, save: (chars, text) => store.checkpoint('chat', b.id, chars, text) });
    expect(retry.calls).toHaveLength(1);
    expect(JSON.stringify(retry.calls[0]?.messages)).toContain('已处理第一段的草稿');
    expect(JSON.stringify(retry.calls[0]?.messages)).toContain('最后一句纠正');
    store.complete('chat', b.id, summary);
    expect(store.read('chat').latest?.version).toBe(1);
  });

  it('使用模型支持的最低推理档位，且请求来源符合 v4 的生产者归属约定', async () => {
    const llm = { ...fakeLlm(), resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] } }) };
    await generatePersonaHandoff(llm, { provider: 'p', model: 'm' }, '', '对话', new AbortController().signal);
    expect(llm.calls[0]?.reasoningEffort).toBe('low');
    expect(llm.calls[0]?.messages[0]?.source).toEqual({ kind: 'qqbot-persona-handoff', form: 'recall' });
  });

  it('根据模型窗口调整分段，大窗口不把六十万字符拆成几十次，小窗口缩短输入', async () => {
    const large = { ...fakeLlm(), resolveModelInfo: async () => ({ context: { contextWindow: 400_000 } }) };
    await generatePersonaHandoff(large, { provider: 'p', model: 'm' }, '', '字'.repeat(600_000) + '最后纠正', new AbortController().signal);
    expect(large.calls).toHaveLength(3);
    expect(JSON.stringify(large.calls.at(-1)?.messages)).toContain('最后纠正');
    const small = { ...fakeLlm(), resolveModelInfo: async () => ({ context: { contextWindow: 64_000 } }) };
    await generatePersonaHandoff(small, { provider: 'p', model: 'm' }, '', '字'.repeat(40_000), new AbortController().signal);
    expect(small.calls).toHaveLength(2);
  });
});
