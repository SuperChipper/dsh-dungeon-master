import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { serialMerge } from './serial-merge.ts';
import { runInboundTurn } from '../transport/agent-turn.ts';
import { AUTO_STEER_CANCEL_REASON, getTurnSlot, TurnSteerTracker } from '../transport/turn-steer.ts';
import { canAutoSteer } from '../gateway/middleware-setup.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function context(id: string, peer = 'p'): MiddlewareContext {
  const controller = new AbortController();
  return {
    message: { content: id, messageId: id, replyTarget: { scope: 'c2c', targetId: peer } },
    state: {}, signal: controller.signal,
    abort: vi.fn(() => controller.abort()), stop: vi.fn(),
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as MiddlewareContext;
}

function guard(timeout = 100, maxQueue = 20): Middleware {
  return serialMerge({ maxQueue, maxProcessingMs: timeout, onMerge: (contexts) => {
    const first = contexts[0]!;
    first.message.content = contexts.map((c) => c.message.content).join('+');
    return first;
  } });
}

afterEach(() => vi.useRealTimers());

describe('serialMerge', () => {
  it('交接后仍串行：第二批运行时到达的第三批不能并发 followup', async () => {
    const middleware = guard(0);
    const a = deferred(), b = deferred();
    const seen: string[] = [];
    const first = middleware(context('a'), () => a.promise);
    const second = middleware(context('b'), async () => { seen.push('b'); await b.promise; });
    a.resolve();
    await first;
    expect(seen).toEqual(['b']);
    const c = context('c'), d = context('d');
    const third = middleware(c, async () => { seen.push(c.message.content); });
    const fourth = middleware(d, async () => { seen.push('d separately'); });
    await Promise.resolve();
    expect(seen).toEqual(['b']);
    b.resolve();
    await Promise.all([second, third, fourth]);
    expect(seen).toEqual(['b', 'c+d']);
    await middleware(context('e'), async () => { seen.push('e'); });
    expect(seen).toEqual(['b', 'c+d', 'e']);
  });

  it('每批都有 watchdog，取消 agent 收敛后才交接下一批', async () => {
    vi.useFakeTimers();
    const middleware = guard();
    const a = deferred(), idle = deferred();
    const first = middleware(context('a'), () => a.promise);
    const b = context('b');
    const agent = { followup: vi.fn(), cancel: vi.fn(), whenIdle: () => idle.promise };
    const second = middleware(b, () => runInboundTurn(agent, 'wait for singing', b.signal, () => {}));
    await vi.advanceTimersByTimeAsync(80);
    a.resolve();
    await first;
    const next = vi.fn(async () => {});
    const third = middleware(context('c'), next);
    await vi.advanceTimersByTimeAsync(99);
    expect(agent.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(agent.cancel).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    idle.resolve();
    await Promise.all([second, third]);
    expect(next).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(agent.cancel).toHaveBeenCalledTimes(1);
  });

  it('唱歌作业仍在后台排队时，提交回合结束就允许聊天继续', async () => {
    const middleware = guard(0);
    const submitted = deferred(), song = deferred();
    let finished = false;
    void song.promise.then(() => { finished = true; });
    const submit = middleware(context('song'), () => submitted.promise);
    const chat = vi.fn(async () => {});
    const queued = middleware(context('chat'), chat);
    submitted.resolve();
    await Promise.all([submit, queued]);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    song.resolve();
  });

  it('不同 peer 独立，取消排队消息释放容量', async () => {
    const middleware = guard(0, 1), a = deferred();
    const first = middleware(context('a'), () => a.promise);
    const b = context('b'), nextB = vi.fn(async () => {});
    const second = middleware(b, nextB);
    const overflow = context('overflow');
    await middleware(overflow, async () => { throw Error('must not run'); });
    expect(overflow.stop).toHaveBeenCalledWith('concurrency:merge-full');
    const other = vi.fn(async () => {});
    await middleware(context('other', 'other-peer'), other);
    expect(other).toHaveBeenCalledTimes(1);
    b.abort();
    await second;
    const nextC = vi.fn(async () => {});
    const third = middleware(context('c'), nextC);
    a.resolve();
    await Promise.all([first, third]);
    expect(nextB).not.toHaveBeenCalled();
    expect(nextC).toHaveBeenCalledTimes(1);
  });

  it('下游失败仍交接，旧 watchdog 不会误杀后续批次', async () => {
    vi.useFakeTimers();
    const middleware = guard();
    const a = deferred(), b = context('b');
    const first = middleware(context('a'), async () => { await a.promise; throw Error('failed'); });
    const rejected = expect(first).rejects.toThrow('failed');
    const second = middleware(b, async () => { await vi.advanceTimersByTimeAsync(60); });
    await vi.advanceTimersByTimeAsync(60);
    a.resolve();
    await Promise.all([rejected, second]);
    expect(b.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.signal.aborted).toBe(false);
  });

  it('合并函数抛错仍逐条处理，不遗留等待者', async () => {
    const middleware = serialMerge({ maxQueue: 20, maxProcessingMs: 0, onMerge: () => { throw Error('merge'); } });
    const a = deferred(), seen: string[] = [];
    const first = middleware(context('a'), () => a.promise);
    const second = middleware(context('b'), async () => { seen.push('b'); });
    const third = middleware(context('c'), async () => { seen.push('c'); });
    a.resolve();
    await Promise.all([first, second, third]);
    expect(seen).toEqual(['b', 'c']);
  });

  describe('短时自动 steer（打断当前思考）', () => {
    function groupCtx(id: string, mention: { wasMentioned?: boolean; implicit?: boolean }, peer = 'g1'): MiddlewareContext {
      const controller = new AbortController();
      return {
        message: { kind: 'group', groupOpenid: peer, senderId: `u-${id}`, content: id, messageId: id, replyTarget: { scope: 'group', targetId: peer } },
        state: { mention },
        signal: controller.signal,
        abort: vi.fn(() => controller.abort()),
        stop: vi.fn(),
        log: { warn: vi.fn(), error: vi.fn() },
      } as unknown as MiddlewareContext;
    }

    it('canAutoSteer：群聊仅显式 @bot 触发，隐式冒泡/欲望接话不触发，私聊连发触发', () => {
      expect(canAutoSteer(groupCtx('1', { wasMentioned: true }))).toBe(true);
      expect(canAutoSteer(groupCtx('2', { wasMentioned: false, implicit: true }))).toBe(false);
      expect(canAutoSteer(groupCtx('3', {}))).toBe(false);
      const c2c = context('4');
      (c2c.message as unknown as { kind: string }).kind = 'c2c';
      expect(canAutoSteer(c2c)).toBe(true);
    });

    it('时间窗内显式 @bot 自动打断当前思考并追加，隐式消息与超时 @bot 照常排队合并', async () => {
      vi.useFakeTimers();
      const tracker = new TurnSteerTracker();
      const middleware = serialMerge({
        maxQueue: 20,
        maxProcessingMs: 30_000,
        steerWindowMs: 10_000,
        canSteer: canAutoSteer,
        onMerge: (contexts) => {
          const first = contexts[0]!;
          first.message.content = contexts.map((c) => c.message.content).join('+');
          return first;
        },
      });

      const idle1 = deferred();
      const idle2 = deferred();
      let turnPhase: 'first' | 'second' = 'first';
      const agent = {
        status: 'running' as 'idle' | 'running',
        session: { id: 's1' },
        followup: vi.fn(),
        steer: vi.fn(),
        cancel: vi.fn(),
        whenIdle: () => (turnPhase === 'first' ? idle1.promise : idle2.promise),
      };

      const run = (c: MiddlewareContext) =>
        middleware(c, () => runInboundTurn(agent, c.message.content, c.signal, () => {}, { slot: getTurnSlot(c), tracker }));

      const m1 = groupCtx('砍蛇头1', { wasMentioned: true });
      const p1 = run(m1);
      // 模拟首条已进入 LLM 流式思考
      tracker.onStreamStart('s1');

      // 2 秒后：隐式冒泡消息到达 → 不打断，进 pending 排队
      await vi.advanceTimersByTimeAsync(2000);
      const implicitMsg = groupCtx('路人闲聊', { wasMentioned: false, implicit: true });
      const pImplicit = run(implicitMsg);
      expect(agent.cancel).not.toHaveBeenCalled();

      // 4 秒后（仍在 10s 窗口内）：显式 @bot 补充 → 立即打断当前思考并 followup 补充消息！
      await vi.advanceTimersByTimeAsync(2000);
      const m2 = groupCtx('先开咒剑诅咒', { wasMentioned: true });
      const p2 = run(m2);
      await p2;
      expect(agent.cancel).toHaveBeenCalledTimes(1);
      expect(agent.cancel).toHaveBeenCalledWith(
        { kind: 'hook', reason: AUTO_STEER_CANCEL_REASON },
        { keepInbox: true },
      );
      expect(agent.followup).toHaveBeenNthCalledWith(1, '砍蛇头1');
      expect(agent.followup).toHaveBeenNthCalledWith(2, '先开咒剑诅咒');

      // 模拟续轮进入流式思考，随后超过 10s 窗口再来一条显式 @bot → 不再打断，与排队消息合并
      tracker.onStreamStart('s1');
      await vi.advanceTimersByTimeAsync(11_000);
      const m3 = groupCtx('超时后的新指令', { wasMentioned: true });
      const p3 = run(m3);
      await Promise.resolve();
      expect(agent.cancel).toHaveBeenCalledTimes(1);
      expect(agent.followup).toHaveBeenCalledTimes(2);

      // 收敛第一轮（含 steer 续轮）后，排队的 implicitMsg + m3 合并进入下一轮
      agent.status = 'idle';
      idle1.resolve();
      turnPhase = 'second';
      await p1;

      agent.status = 'idle';
      idle2.resolve();
      await Promise.all([pImplicit, p3]);
      expect(agent.followup).toHaveBeenNthCalledWith(3, '路人闲聊+超时后的新指令');
    });

    it('preparing 保护与工具执行保护：流未开始前等待落表，工具执行期间走 next-step steer 不杀工具', async () => {
      const tracker = new TurnSteerTracker();
      const idle = deferred();
      const agent = {
        status: 'running' as 'idle' | 'running',
        session: { id: 's-phase' },
        followup: vi.fn(),
        steer: vi.fn(),
        cancel: vi.fn(),
        whenIdle: () => idle.promise,
      };
      const middleware = serialMerge({
        maxQueue: 20,
        maxProcessingMs: 0,
        steerWindowMs: 10_000,
        canSteer: () => true,
        onMerge: (cs) => cs[0]!,
      });
      const run = (c: MiddlewareContext) =>
        middleware(c, () => runInboundTurn(agent, c.message.content, c.signal, () => {}, { slot: getTurnSlot(c), tracker }));

      const c1 = context('m1');
      const p1 = run(c1);

      // m1 尚在 preparing（未收到 attempt-start）：m2 必须等 attempt-start 后才允许 cancel
      const c2 = context('m2');
      const p2 = run(c2);
      await Promise.resolve();
      expect(agent.cancel).not.toHaveBeenCalled();

      tracker.onStreamStart('s-phase');
      await p2;
      expect(agent.cancel).toHaveBeenCalledTimes(1);
      expect(agent.followup).toHaveBeenLastCalledWith('m2');

      // 续轮进入工具执行阶段（assistant/message 含 tool-call）：m3 走 steer(next-step) 不调 cancel
      tracker.onSessionEvent('s-phase', {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'tool-call', name: 'dnd_roll' }] } },
      });
      const c3 = context('m3');
      await run(c3);
      expect(agent.cancel).toHaveBeenCalledTimes(1);
      expect(agent.steer).toHaveBeenCalledWith('m3');

      agent.status = 'idle';
      idle.resolve();
      await p1;
    });

    it('首条消息未进入 agent 回合提前返回时，等待中的短时 steer 消息平滑升级执行不丢失', async () => {
      const middleware = serialMerge({
        maxQueue: 20,
        maxProcessingMs: 0,
        steerWindowMs: 10_000,
        canSteer: () => true,
        onMerge: (cs) => cs[0]!,
      });
      const preCheck = deferred();
      const idle = deferred();
      const agent = { followup: vi.fn(), cancel: vi.fn(), whenIdle: () => idle.promise };

      const c1 = context('empty');
      const c2 = context('real');
      const p1 = middleware(c1, async () => { await preCheck.promise; /* 空消息直接退出 */ });
      const p2 = middleware(c2, () => runInboundTurn(agent, 'real', c2.signal, () => {}, { slot: getTurnSlot(c2) }));

      preCheck.resolve();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(agent.followup).toHaveBeenCalledWith('real');

      idle.resolve();
      await Promise.all([p1, p2]);
    });
  });
});
