import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from './session-manager.ts';
import type { SessionRecord } from './types.ts';

/**
 * 回归：/model 切换与 /model reset 曾经每次都抛
 * `Cannot read properties of undefined (reading 'length')`。
 * 原因是 rebuildSession 按老签名取 `sessions.fork(...).events`，而 0.2.x 的 fork
 * 直接返回子会话、没有 .events。这里锁住「换模型只改 selection，不建新会话」。
 */
function harness() {
  const installedEvents: string[] = [];
  const appended: Array<{ type: string; payload: unknown }> = [];
  let header: { config?: { provider?: string; model?: string } } | undefined;
  const agent = {
    status: 'idle',
    ctx: {
      on: (event: string) => {
        installedEvents.push(event);
        return () => {};
      },
    },
    session: {
      id: 's',
      append: (type: string, payload: unknown) => {
        appended.push({ type, payload });
      },
      requestHeader: () => header,
    },
  };
  const sessions = new Map<string, SessionRecord>();
  const record = {
    sessionKey: 'qqbot:1:c2c:p',
    sessionId: 's',
    agent,
    handle: { agent, dispose: async () => {} },
    scope: 'c2c',
    peerId: 'p',
    senderId: 'p',
    replyTarget: { scope: 'c2c', targetId: 'p' },
    lastActivity: Date.now(),
  } as unknown as SessionRecord;

  const self: Record<string, unknown> = {
    modelSelections: new Map(),
    sessions,
    sessionKey: () => 'qqbot:1:c2c:p',
    modelResolver: {
      setOverride: vi.fn(),
      getEffectiveRoute: vi.fn(() => ({ provider: 'd', model: 'm' })),
      getExplicitRoute: vi.fn(() => undefined as { provider: string; model: string } | undefined),
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const proto = SessionManager.prototype as unknown as Record<string, unknown>;
  self.applyModelSelection = proto.applyModelSelection;
  self.syncExplicitRoute = proto.syncExplicitRoute;
  // getOrCreate 现在委托给会话打开与人设交接方法，沿用真实实现以保留这条复用路径的覆盖。
  for (const method of ['waitForPersonaSwitch', 'openSession', 'receivePersonaHandoff']) self[method] = proto[method];
  return { self, record, sessions, agent, installedEvents, appended, setHeader: (h) => { header = h; } };
}

describe('SessionManager 换模型', () => {
  it('applyModelSelection 只装一次监听，之后只改 current 并写 model/selection 事件', () => {
    const { self, record, installedEvents, appended } = harness();
    const apply = self.applyModelSelection as (r: SessionRecord, route: { provider: string; model: string }) => void;

    apply.call(self, record, { provider: 'deepseek-max', model: 'deepseek-flash' });
    apply.call(self, record, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' });

    // 两次切换只装一次 selection（两个 waterfall 监听）
    expect(installedEvents).toEqual(['system-prompt/assemble', 'agent/request']);
    expect(appended).toEqual([
      { type: 'model/selection', payload: { provider: 'deepseek-max', model: 'deepseek-flash' } },
      { type: 'model/selection', payload: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
    ]);
  });

  it('Web 控制器存在时复用其选择状态，不安装第二套监听且不保存全局默认', () => {
    const { self, record, installedEvents, appended } = harness();
    const shared = { current: { provider: 'argon', model: 'gemini-4-argon' }, assembled: undefined };
    const selectionFor = vi.fn(() => shared);
    const selectModel = vi.fn();
    self.ctx = { get: vi.fn(() => ({ agents: { selectionFor }, selectModel })) };
    (self.applyModelSelection as (r: SessionRecord, route: unknown) => void)
      .call(self, record, { provider: 'hapi', model: 'gpt-6.1-sol' });
    expect(shared.current).toEqual({ provider: 'hapi', model: 'gpt-6.1-sol' });
    expect(selectionFor).toHaveBeenCalledWith(record.agent);
    expect(installedEvents).toEqual([]);
    expect(selectModel).not.toHaveBeenCalled();
    expect(appended).toEqual([{ type: 'model/selection', payload: shared.current }]);
  });

  it('重载复用活 agent 时保留 Web 路由，不让旧 QQ 偏好触发错误切换通知', async () => {
    const { self, record, agent, appended } = harness();
    self.agents = { get: vi.fn(() => agent) };
    self.currentSessionId = () => 's';
    const sync = vi.fn();
    self.syncExplicitRoute = sync;
    const result = await SessionManager.prototype.getOrCreate.call(
      self as unknown as SessionManager, 'c2c', 'p', 'p', record.replyTarget,
    );
    expect(result.agent).toBe(agent);
    expect(sync).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });

  it('setModelOverride 写偏好并就地换路由，不抛错也不需要空闲', async () => {
    const { self, record, sessions } = harness();
    const setModelOverride = (SessionManager.prototype as unknown as {
      setModelOverride: (scope: string, peerId: string, route: { provider: string; model: string }) => Promise<boolean>;
    }).setModelOverride;

    sessions.set(record.sessionKey, record);
    record.agent = { ...record.agent, status: 'running' } as SessionRecord['agent'];

    await expect(setModelOverride.call(self, 'c2c', 'p', { provider: 'a', model: 'b' })).resolves.toBe(true);
    expect((self.modelResolver as { setOverride: unknown }).setOverride).toHaveBeenCalledWith('qqbot:1:c2c:p', { provider: 'a', model: 'b' });
    expect((self.modelSelections as Map<unknown, { current?: unknown }>).size).toBe(1);
  });

  it('没有活动会话时只留偏好，不碰 agent', async () => {
    const { self } = harness();
    const setModelOverride = (SessionManager.prototype as unknown as {
      setModelOverride: (scope: string, peerId: string, route: { provider: string; model: string }) => Promise<boolean>;
    }).setModelOverride;

    await expect(setModelOverride.call(self, 'c2c', 'p', { provider: 'a', model: 'b' })).resolves.toBe(true);
    expect((self.modelSelections as Map<unknown, unknown>).size).toBe(0);
  });

  /**
   * 回归：web GUI 先打开过这个会话时，getOrCreate 走「reusing live agent」，
   * 偏好存了 hapi 但请求还在跑宿主默认（2026-11-08 19:00 实测 deepseek-max/deepseek-flash）。
   */
  it('复用活 agent 时把显式偏好盖到会话上', () => {
    const { self, record, appended, setHeader } = harness();
    const resolve = (self.modelResolver as { getExplicitRoute: { mockReturnValue: (v: unknown) => void } }).getExplicitRoute;
    resolve.mockReturnValue({ provider: 'hapi', model: 'gpt-6.1-sol' });
    setHeader({ config: { provider: 'deepseek-max', model: 'deepseek-flash' } });

    (self.syncExplicitRoute as (r: SessionRecord) => void).call(self, record);

    expect(appended).toEqual([{ type: 'model/selection', payload: { provider: 'hapi', model: 'gpt-6.1-sol' } }]);
  });

  it('没有显式偏好时不动会话自己的路由（GUI 里手选的模型要留住）', () => {
    const { self, record, appended, setHeader } = harness();
    setHeader({ config: { provider: 'commandcode-claude', model: 'claude-sonnet-5-5' } });

    (self.syncExplicitRoute as (r: SessionRecord) => void).call(self, record);

    expect(appended).toEqual([]);
  });

  it('头部已经是这条路由时不重复写事件', () => {
    const { self, record, appended, setHeader } = harness();
    const resolve = (self.modelResolver as { getExplicitRoute: { mockReturnValue: (v: unknown) => void } }).getExplicitRoute;
    resolve.mockReturnValue({ provider: 'hapi', model: 'gpt-6.1-sol' });
    setHeader({ config: { provider: 'hapi', model: 'gpt-6.1-sol' } });

    (self.syncExplicitRoute as (r: SessionRecord) => void).call(self, record);

    expect(appended).toEqual([]);
  });
});
