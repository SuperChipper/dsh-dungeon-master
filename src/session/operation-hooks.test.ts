import { describe, expect, it, vi } from 'vitest';
import { RecallTurnState } from '../notes/operation-recall.ts';
import { createNotesRecallMessage, isNotesRecallSource, summarizeNotesHint } from '../shared/message-source.ts';
import { SessionManager, type StagedNoteRecall } from './session-manager.ts';

interface Exec {
  name: string;
  callId?: string;
  agent?: unknown;
  signal: AbortSignal;
}
interface Result { isError?: boolean; value?: unknown; error?: unknown }
interface Decision { kind: string; additionalContexts?: unknown[]; [key: string]: unknown }
type Handler = (exec: Exec, result: Result, next: () => Promise<Decision>) => Promise<Decision>;

function setup() {
  let handler!: Handler;
  const on = vi.fn((_event: string, listener: Handler, _options: unknown) => { handler = listener; });
  const agent = {};
  const record = { sessionKey: 'qqbot:app:group:G', scope: 'group', peerId: 'G', agent };
  const state = new RecallTurnState('当前问题', []);
  const recallAtOperation = vi.fn(async (..._args: unknown[]) => '[共享笔记 · 可能相关]\n历史参考');
  const observe = vi.fn();
  const stub = {
    ctx: { on },
    findByAgent: vi.fn((candidate: unknown) => candidate === agent ? record : undefined),
    operationRecalls: new Map([[record.sessionKey, state]]),
    mediaReview: { observe },
    recallAtOperation,
  };
  const prototype = SessionManager.prototype as unknown as { registerOperationRecall(this: unknown): void };
  prototype.registerOperationRecall.call(stub);
  const controller = new AbortController();
  const exec: Exec = { name: 'qqbot_describe_video', callId: 'call-1', agent, signal: controller.signal };
  return { handler, on, stub, state, record, agent, exec, controller, recallAtOperation, observe };
}

const continueDecision = (): Decision => ({ kind: 'continue' });

describe('SessionManager operation recall hook', () => {
  it('registers the real post-execute handler globally and retains downstream context', async () => {
    const { handler, on, exec, recallAtOperation } = setup();
    expect(on).toHaveBeenCalledWith('tools/post-execute', handler, { global: true });
    const existingContext = { prior: true };
    const next = vi.fn(async () => ({ kind: 'continue', additionalContexts: [existingContext], marker: 'preserved' }));
    const output = await handler(exec, { value: { text: '视频中出现蓝色列车', analyzedStart: 2, analyzedEnd: 12 } }, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(output.marker).toBe('preserved');
    expect(output.additionalContexts?.[0]).toBe(existingContext);
    expect(output.additionalContexts).toHaveLength(2);
    expect(JSON.stringify(output.additionalContexts?.[1])).toContain('实际覆盖:2–12秒');
    expect(JSON.stringify(output.additionalContexts?.[1])).toContain('历史参考');
    expect(recallAtOperation).toHaveBeenCalledWith(
      '当前问题\n视频中出现蓝色列车', ['media.video.inspect'], 'group', 'G', expect.any(RecallTurnState), undefined, exec.signal,
    );
  });

  it('deduplicates a repeated callId while distinct calls with identical text remain separate events', async () => {
    const { handler, exec, recallAtOperation, state } = setup();
    const result = { value: { text: '相同画面' } };
    const first = await handler(exec, result, async () => continueDecision());
    const repeatedDecision = continueDecision();
    const repeated = await handler(exec, result, async () => repeatedDecision);
    const distinct = await handler({ ...exec, callId: 'call-2' }, result, async () => continueDecision());
    expect(first.additionalContexts).toHaveLength(1);
    expect(repeated).toBe(repeatedDecision);
    expect(repeated.additionalContexts).toBeUndefined();
    expect(distinct.additionalContexts).toHaveLength(1);
    expect(recallAtOperation).toHaveBeenCalledTimes(2);
    expect(state.events).toEqual(new Set(['call-1', 'call-2']));
  });

  it('uses downstream replacement value rather than raw tool text for recall and media review', async () => {
    const { handler, exec, recallAtOperation, observe } = setup();
    const replacement = { text: '审核后的画面描述', title: '最终标题' };
    const output = await handler(exec, { value: { text: 'RAW_PRIVATE_TEXT', title: 'RAW_TITLE' } }, async () => ({ kind: 'continue', value: replacement }));
    expect(output.value).toBe(replacement);
    expect(recallAtOperation.mock.calls[0]?.[0]).toBe('当前问题\n审核后的画面描述\n最终标题');
    expect(JSON.stringify(recallAtOperation.mock.calls)).not.toContain('RAW_');
    expect(observe).toHaveBeenCalledWith(exec.agent, expect.objectContaining({ query: '审核后的画面描述\n最终标题' }));
  });

  it('does not reuse raw text when downstream supplies only rendered replacement content', async () => {
    const { handler, exec, recallAtOperation, observe } = setup();
    const content = [{ type: 'text', text: '经处理的展示文本' }];
    const output = await handler(exec, { value: { text: 'RAW_PRIVATE_TEXT', title: 'RAW_TITLE' } }, async () => ({ kind: 'continue', content }));
    expect(output.content).toBe(content);
    expect(recallAtOperation.mock.calls[0]?.[0]).toBe('当前问题');
    expect(JSON.stringify(recallAtOperation.mock.calls)).not.toContain('RAW_');
    expect(observe).toHaveBeenCalledWith(exec.agent, expect.objectContaining({ query: '' }));
  });

  it('leaves unknown tools, non-QQ agents, missing agents and blocked decisions unchanged', async () => {
    const { handler, exec, recallAtOperation, observe } = setup();
    for (const candidate of [{ ...exec, name: 'pwsh' }, { ...exec, agent: {} }, { ...exec, agent: undefined }]) {
      const decision = continueDecision();
      expect(await handler(candidate, { value: { text: '原始输出' } }, async () => decision)).toBe(decision);
    }
    const blocked: Decision = { kind: 'block', reason: 'downstream' };
    expect(await handler(exec, { value: { text: '原始输出' } }, async () => blocked)).toBe(blocked);
    expect(recallAtOperation).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it('adds no context for an aborted execution or one aborted during recall', async () => {
    const early = setup();
    early.controller.abort();
    const earlyDecision = continueDecision();
    expect(await early.handler(early.exec, { value: { text: '画面' } }, async () => earlyDecision)).toBe(earlyDecision);
    expect(early.recallAtOperation).not.toHaveBeenCalled();
    expect(early.observe).not.toHaveBeenCalled();

    const during = setup();
    during.recallAtOperation.mockImplementationOnce(async () => {
      during.controller.abort();
      return '迟到的笔记';
    });
    const duringDecision = continueDecision();
    const output = await during.handler(during.exec, { value: { text: '画面' } }, async () => duringDecision);
    expect(output).toBe(duringDecision);
    expect(output.additionalContexts).toBeUndefined();
    expect(during.state.factChars).toBe(0);
  });

  it('uses qqbot-notes-recall notice source when post-execute recall returns notes', async () => {
    const s = setup();
    s.recallAtOperation.mockResolvedValueOnce('[共享笔记 · 可能相关]\n- guides/video.md › 切片（适用:跨会话通用）\n  片段正文');
    const output = await s.handler(s.exec, { value: { text: '视频片段' } }, async () => continueDecision());
    const added = output.additionalContexts?.[0] as { source?: { kind?: string; form?: string; summary?: string } };
    expect(added.source).toEqual({
      kind: 'qqbot-notes-recall',
      form: 'notice',
      summary: '共享笔记（1 条）：guides/video.md',
    });
  });
});

describe('SessionManager pre-step notes recall hook', () => {
  interface PreStepMessage { id?: string; content?: Array<{ type: string; text?: string }>; source?: Record<string, unknown> }
  interface PreStepPayload { agent?: unknown; signal: AbortSignal; messages?: PreStepMessage[] }
  interface PreStepDecision { kind: string; messages?: PreStepMessage[]; preserved?: string }
  type PreStepHandler = (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>;

  function setupPreStep() {
    let handler!: PreStepHandler;
    const on = vi.fn((_event: string, listener: PreStepHandler, _options: unknown) => { handler = listener; });
    const agent = {};
    const record = { sessionKey: 'qqbot:app:group:G', scope: 'group' as const, peerId: 'G', agent };
    const notesHint = vi.fn(async (..._args: unknown[]) => '[共享笔记 · 可能相关]\n- foo.md › 约定（适用:跨会话通用）\n  记得提前检查');
    const stub = {
      ctx: { on },
      findByAgent: vi.fn((candidate: unknown) => candidate === agent ? record : undefined),
      notesHint,
      stagedNoteRecalls: new Map<string, StagedNoteRecall & { stagedAt: number }>(),
      ensureStagedNoteRecalls: (SessionManager.prototype as unknown as { ensureStagedNoteRecalls: () => Map<string, StagedNoteRecall & { stagedAt: number }> }).ensureStagedNoteRecalls,
    };
    const prototype = SessionManager.prototype as unknown as { registerPreStepNotesRecall(this: unknown): void };
    prototype.registerPreStepNotesRecall.call(stub);
    const stage = (id: string, spec: StagedNoteRecall) => SessionManager.prototype.stageNoteRecall.call(stub as never, id, spec);
    const unstage = (id: string) => SessionManager.prototype.unstageNoteRecall.call(stub as never, id);
    const controller = new AbortController();
    return { handler, on, agent, stub, notesHint, stage, unstage, controller };
  }

  it('global 监听 agent/pre-step，在匹配用户消息前插入独立 qqbot-notes-recall 且不改写用户消息，并仅消费一次', async () => {
    const { handler, on, agent, notesHint, stage, controller } = setupPreStep();
    expect(on).toHaveBeenCalledWith('agent/pre-step', handler, { global: true });

    stage('msg-1', {
      query: '帮我查一下约定',
      operations: ['media.image.inspect'],
      scope: 'group',
      peerId: 'G',
      messageId: 'qq-m1',
      steered: false,
    });

    const userMsg: PreStepMessage = {
      id: 'msg-1',
      content: [{ type: 'text', text: '[群友 #U1] (@you) 帮我查一下约定' }],
      source: { kind: 'user' },
    };
    const otherMsg: PreStepMessage = {
      id: 'msg-other',
      content: [{ type: 'text', text: '别的消息' }],
      source: { kind: 'user' },
    };

    const output = await handler(
      { agent, signal: controller.signal, messages: [otherMsg, userMsg] },
      async () => ({ kind: 'enter', messages: [otherMsg, userMsg], preserved: 'ok' }),
    );

    expect(notesHint).toHaveBeenCalledWith('帮我查一下约定', 'group', 'G', 'qq-m1', false, ['media.image.inspect'], controller.signal);
    expect(output.preserved).toBe('ok');
    expect(output.messages).toHaveLength(3);
    expect(output.messages?.[0]).toBe(otherMsg);
    expect(isNotesRecallSource(output.messages?.[1]?.source)).toBe(true);
    expect(output.messages?.[1]?.source).toEqual({
      kind: 'qqbot-notes-recall',
      form: 'notice',
      summary: '共享笔记（1 条）：foo.md',
    });
    expect(output.messages?.[2]).toBe(userMsg);
    expect(userMsg.content?.[0]?.text).toBe('[群友 #U1] (@you) 帮我查一下约定');

    // 第二步同一消息不应重复召回
    notesHint.mockClear();
    const second = await handler(
      { agent, signal: controller.signal, messages: [userMsg] },
      async () => ({ kind: 'enter', messages: [userMsg] }),
    );
    expect(notesHint).not.toHaveBeenCalled();
    expect(second.messages).toEqual([userMsg]);
  });

  it('reject、非 QQ agent、已中止、unstage 或召回为空时不改写决策', async () => {
    const s = setupPreStep();
    s.stage('msg-reject', { query: 'q', operations: [], scope: 'group', peerId: 'G', steered: false });
    const rejected = { kind: 'reject' };
    expect(await s.handler({ agent: s.agent, signal: s.controller.signal, messages: [{ id: 'msg-reject' }] }, async () => rejected)).toBe(rejected);

    // unstage 后即使 enter 也不触发检索
    s.unstage('msg-reject');
    const afterUnstage = { kind: 'enter', messages: [{ id: 'msg-reject' }] };
    expect(await s.handler({ agent: s.agent, signal: s.controller.signal, messages: [{ id: 'msg-reject' }] }, async () => afterUnstage)).toBe(afterUnstage);
    expect(s.notesHint).not.toHaveBeenCalled();

    // 空提示返回原决策
    s.notesHint.mockResolvedValueOnce('');
    s.stage('msg-empty', { query: 'q', operations: [], scope: 'group', peerId: 'G', steered: false });
    const emptyDecision = { kind: 'enter', messages: [{ id: 'msg-empty' }] };
    expect(await s.handler({ agent: s.agent, signal: s.controller.signal, messages: [{ id: 'msg-empty' }] }, async () => emptyDecision)).toBe(emptyDecision);

    // summarizeNotesHint / createNotesRecallMessage 多条与默认兜底格式
    expect(summarizeNotesHint('[共享笔记 · 可能相关]\n- [本会话] a.md › h1\n- b.md › h2\n- a.md › h3')).toBe('共享笔记（3 条）：a.md、b.md');
    expect(summarizeNotesHint('普通文本')).toBe('共享笔记自动召回');
    expect(createNotesRecallMessage('hello').source).toEqual({
      kind: 'qqbot-notes-recall',
      form: 'notice',
      summary: '共享笔记自动召回',
    });
  });
});
