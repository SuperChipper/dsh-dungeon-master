import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from './session-manager.ts';
import type { CompactOutcome, DshAgent, SessionRecord } from './types.ts';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createHarness(overrides: Record<string, unknown> = {}) {
  const logger = makeLogger();
  const sessions = new Map<string, SessionRecord>();
  const ctxMap = new Map<string, unknown>();
  const self: Record<string, unknown> = {
    config: { appId: 'app', autoCompactTokens: 120000, autoCompactPrivateRatio: 0.5, autoCompactDeferOnTools: true },
    logger,
    sessions,
    ctx: { get: (name: string) => ctxMap.get(name) },
    agents: { get: vi.fn(), resume: vi.fn() },
    modelResolver: {
      getSessionId: vi.fn(),
      getResumeRoute: vi.fn(),
      getEffectiveRoute: vi.fn(),
    },
    getPresetsService: vi.fn(),
    getEffectiveModel: vi.fn(() => undefined),
    resolvePersistedPreset: vi.fn(async () => undefined),
    getEffectivePresetByKey: vi.fn(() => undefined),
    composePreset: vi.fn(async () => ({})),
    sessionKey: SessionManager.prototype.sessionKey,
    currentSessionId: (SessionManager.prototype as unknown as { currentSessionId: unknown }).currentSessionId,
    deriveSessionId: (SessionManager.prototype as unknown as { deriveSessionId: unknown }).deriveSessionId,
    getSessionRecord: SessionManager.prototype.getSessionRecord,
    getStatus: SessionManager.prototype.getStatus,
    compactRecord: (SessionManager.prototype as unknown as { compactRecord: unknown }).compactRecord,
    countMessages: (SessionManager.prototype as unknown as { countMessages: unknown }).countMessages,
    getTokenUsage: SessionManager.prototype.getTokenUsage,
    exportMarkdown: SessionManager.prototype.exportMarkdown,
    compact: SessionManager.prototype.compact,
    maybeAutoCompact: SessionManager.prototype.maybeAutoCompact,
    contextWindowOf: vi.fn(async () => undefined),
    ...overrides,
  };
  Object.assign(self, { autoCompact: (SessionManager.prototype as unknown as { autoCompact: unknown }).autoCompact });
  return { self: self as unknown as SessionManager, logger, sessions, ctxMap };
}

function makeAgent(overrides: Partial<DshAgent> & { events?: unknown[]; snapshotEvents?: () => unknown[] } = {}): DshAgent {
  const { events, snapshotEvents, ...rest } = overrides;
  return {
    id: 'sess-1',
    ctx: { get: () => undefined } as unknown as DshAgent['ctx'],
    status: 'idle',
    options: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    session: {
      id: 'sess-1',
      ...(events !== undefined ? { events } : {}),
      ...(snapshotEvents !== undefined ? { snapshotEvents } : {}),
      requestHeader: () => ({ config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }),
    },
    runMaintenance: async <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    cancel: vi.fn(),
    followup: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    ...rest,
  } as unknown as DshAgent;
}

describe('SessionManager.compact', () => {
  it('传递真实 agent 与多级 compaction 解析，并在 summary 失败含真实原因时上浮 failed 而非静默成功', async () => {
    const compactNow = vi.fn(async (target: unknown) => {
      expect(target).toBe(agent);
      return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1500 };
    });
    const agent = makeAgent({
      ctx: { get: (name: string) => (name === 'compaction' ? { compactNow } : undefined) } as unknown as DshAgent['ctx'],
    });
    const { self, sessions, logger } = createHarness();
    sessions.set('qqbot:app:group:g1', {
      sessionKey: 'qqbot:app:group:g1',
      sessionId: 'sess-1',
      agent,
      handle: { agent, dispose: async () => {} },
      replyTarget: { scope: 'group', targetId: 'g1', msgId: 'm1' },
      scope: 'group',
      peerId: 'g1',
      senderId: 'u1',
      lastActivity: 1,
    });

    const ok = await self.compact('group', 'g1');
    expect(ok).toEqual({ ok: true, shadowed: 3, tokens: 1500 });

    // cause 是 "summary is not smaller..." → 正常返回 shadowed: 0
    const notSmallerErr = Object.assign(new Error('manual compaction could not produce a smaller summary'), {
      code: 'summary',
      cause: new Error('summary is not smaller than the shadowed content (120 >= 100)'),
    });
    compactNow.mockRejectedValueOnce(notSmallerErr);
    expect(await self.compact('group', 'g1')).toEqual({ ok: true, shadowed: 0, tokens: 0 });

    // cause 是真实 LLM/API 报错 → 不能静默成 ok: true
    const llmErr = Object.assign(new Error('manual compaction could not produce a smaller summary'), {
      code: 'summary',
      cause: new Error('HTTP 429 rate limit exceeded'),
    });
    compactNow.mockRejectedValueOnce(llmErr);
    const failed = await self.compact('group', 'g1');
    expect(failed.ok).toBe(false);
    expect(failed.reason).toBe('failed');
    expect(failed.message).toContain('HTTP 429 rate limit exceeded');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('会话不在内存时支持从磁盘 resume 后压缩并释放临时句柄；不存在则只返回 no-session 不 create', async () => {
    const compactNow = vi.fn(async () => ({ shadowedSeqs: [10], shadowedTokenCount: 800 }));
    const dispose = vi.fn(async () => {});
    const resumedAgent = makeAgent();
    const { self, ctxMap } = createHarness({
      agents: {
        get: vi.fn(() => undefined),
        resume: vi.fn(async () => ({ agent: resumedAgent, dispose })),
      },
    });
    ctxMap.set('compaction', { compactNow });

    const out = await self.compact('c2c', 'u1');
    expect(out).toEqual({ ok: true, shadowed: 1, tokens: 800 });
    expect(dispose).toHaveBeenCalledTimes(1);

    // 磁盘也无历史 → resume 抛错 → 返回 no-session
    const { self: selfNoDisk } = createHarness({
      agents: {
        get: vi.fn(() => undefined),
        resume: vi.fn(async () => { throw new Error('ENOENT'); }),
      },
    });
    expect(await selfNoDisk.compact('c2c', 'u2')).toEqual({ ok: false, reason: 'no-session' });
  });

  it('复用 agents.get 里的活跃实例且不释放，并发 /compact 返回 busy', async () => {
    let release!: (val: { shadowedSeqs: number[]; shadowedTokenCount: number }) => void;
    const compactNow = vi.fn(() => new Promise<{ shadowedSeqs: number[]; shadowedTokenCount: number }>((r) => { release = r; }));
    const liveAgent = makeAgent();
    const { self, ctxMap } = createHarness({
      agents: { get: vi.fn(() => liveAgent), resume: vi.fn() },
    });
    ctxMap.set('compaction', { compactNow });

    const p1 = self.compact('group', 'g2');
    await vi.waitFor(() => expect(compactNow).toHaveBeenCalledTimes(1));
    const p2 = await self.compact('group', 'g2');
    expect(p2).toEqual({ ok: false, reason: 'busy' });

    release({ shadowedSeqs: [1, 2], shadowedTokenCount: 500 });
    expect(await p1).toEqual({ ok: true, shadowed: 2, tokens: 500 });
  });
});

describe('SessionManager dsh v4 snapshotEvents & autoCompact', () => {
  it('getTokenUsage / exportMarkdown / getStatus / autoCompact 兼容 snapshotEvents() 与 dsh v4 结构', async () => {
    const v4Events = [
      { type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'DM SECRET HP=5' }] } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好呀' }] } },
      {
        type: 'assistant/message',
        data: {
          message: { content: [{ type: 'text', text: '哈喽' }] },
          usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 800, cacheWriteTokens: 40 },
        },
      },
      // 保留老事件格式向后兼容
      {
        type: 'assistant/message',
        message: { content: [{ type: 'text', text: '旧回复' }] },
        usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2 },
      },
      { type: 'turn/start' },
      { type: 'tool/call' },
      { type: 'turn/end' },
    ];
    const agent = makeAgent({ snapshotEvents: () => v4Events });
    const compactSpy = vi.fn(async (): Promise<CompactOutcome> => ({ ok: true, shadowed: 2, tokens: 100 }));
    const { self, sessions } = createHarness({ compact: compactSpy });
    const record: SessionRecord = {
      sessionKey: 'qqbot:app:group:g9',
      sessionId: 'sess-1',
      agent,
      handle: { agent, dispose: async () => {} },
      replyTarget: { scope: 'group', targetId: 'g9', msgId: 'm1' },
      scope: 'group',
      peerId: 'g9',
      senderId: 'u1',
      lastActivity: 1000,
      contextTokens: 130000,
    };
    sessions.set(record.sessionKey, record);

    expect(self.getTokenUsage('group', 'g9')).toEqual({
      input: 130,
      output: 35,
      cacheRead: 820,
      cacheWrite: 42,
    });

    const md = self.exportMarkdown('group', 'g9');
    expect(md).toContain('## 用户\n\n你好呀');
    expect(md).toContain('## 助手\n\n哈喽');
    expect(md).toContain('## 助手\n\n旧回复');
    expect(md).not.toContain('DM SECRET HP=5');
    expect(self.getStatus('group', 'g9').messageCount).toBe(3);

    // autoCompact 通过 snapshotEvents 读取到上一轮 tool/call 并推迟压缩（不误压）
    self.maybeAutoCompact(record);
    await vi.waitFor(() => expect(record.compacting).toBe(false));
    expect(compactSpy).not.toHaveBeenCalled();
  });
});
