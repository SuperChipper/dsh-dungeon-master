import { describe, expect, it, vi } from 'vitest';
import { RecallTurnState } from '../notes/operation-recall.ts';
import { SessionManager } from './session-manager.ts';

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
});
