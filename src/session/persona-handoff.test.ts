import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { newCommand } from '../commands/session.ts';
import { PersonaHandoffStore } from '../features/persona-handoff.ts';
import { SessionManager } from './session-manager.ts';
import type { SessionEventLike, SessionRecord } from './types.ts';
import type { ChatScope } from '../types.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(options: { scope?: ChatScope; unloaded?: boolean; fail?: boolean; gate?: Promise<void>; selected?: { provider: string; model: string } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'persona-handoff-integration-'));
  dirs.push(dir);
  const scope = options.scope ?? 'group';
  const key = `qqbot:app:${scope}:peer`;
  const handoffs = new PersonaHandoffStore(dir);
  let current = 'default';
  let currentSession = 'source-session';
  const remembered = new Map([['dragon', 'dragon-session']]);
  const fromEvents: SessionEventLike[] = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '改 compact' }] } },
    { type: 'compaction/summary', seq: 3, data: { summary: [{ type: 'text', text: '之前只讨论 compact 策略' }], shadowedSeqs: [1] } },
    { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: '最后纠正：实现共同交接，肥龙是助手自己设计的人格' }] } },
  ];
  const toEvents: SessionEventLike[] = [{ type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '肥龙自己的聊天历史' }] } } }];
  const calls: GenerateOptions[] = [];
  const llm = {
    async *stream(opts: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(opts);
      await options.gate;
      if (options.fail) throw new Error('模拟生成失败');
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '1. 当前真实意图：实现共同交接。\n2. 已确认：肥龙由助手自己设计。\n3. 待做交接功能。\n4. 暂无后台任务。\n5. compact 是之前的话题。' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const makeRecord = (sessionId: string, events: SessionEventLike[]): SessionRecord => ({
    sessionKey: key, sessionId, scope, peerId: 'peer', senderId: 'owner', replyTarget: { scope, targetId: 'peer' }, lastActivity: 0,
    agent: {
      id: sessionId, status: 'idle', ctx: { on: vi.fn(() => () => {}) } as never,
      session: {
        id: sessionId, snapshotEvents: () => events,
        append: vi.fn((type, data) => { events.push({ type, data, seq: (events.at(-1)?.seq ?? 0) + 1 }); }),
        requestHeader: () => ({ config: { provider: 'actual-provider', model: 'actual-model' } }),
      },
      runMaintenance: vi.fn(async (task) => task(new AbortController().signal)),
      cancel: vi.fn(), followup: vi.fn(), whenIdle: async () => {},
    },
    handle: { agent: undefined as never, dispose: vi.fn(async () => {}) },
  });
  const source = makeRecord('source-session', fromEvents);
  const target = makeRecord('dragon-session', toEvents);
  const sessions = new Map(options.unloaded ? [] : [[key, source]]);
  const modelPin = vi.fn();
  const select = vi.fn((_peer: string, id: string) => { current = id; });
  const openSession = vi.fn(async () => {
    const record = current === 'default' ? source : target;
    sessions.set(key, record);
    return record;
  });
  const manager = Object.assign(Object.create(SessionManager.prototype) as SessionManager, {
    sessions,
    personaStore: {
      handoffs, currentId: () => current,
      rememberSession: (_peer: string, id: string, sid: string) => remembered.set(id, sid),
      select, sessionFor: (_peer: string, id: string) => remembered.get(id),
    },
    modelResolver: { getSessionId: () => currentSession, setSessionId: (_key: string, id: string) => { currentSession = id; }, getEffectiveRoute: () => ({ provider: 'p', model: 'm' }), setOverride: modelPin },
    modelSelections: new Map(), pendingScheduleMigrations: new Map(), retiredSessionIds: new Map(),
    captureScheduleMigrations: vi.fn(), openSession,
    config: { appId: 'app' },
    ctx: { get: (name: string) => name === 'llm' ? llm : name === 'sessionController' && options.selected ? { agents: { selectionFor: (agent: unknown) => agent === source.agent ? { current: options.selected } : undefined } } : undefined },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { manager, handoffs, key, calls, source, target, fromEvents, toEvents, select, openSession, modelPin };
}

describe('人格交接生命周期', () => {
  it.each(['group', 'c2c'] as const)('%s 切换前生成落盘，恢复自身历史后接收一次，再接新消息', async (scope) => {
    const h = harness({ scope });
    expect(await h.manager.switchPersona('peer', 'dragon', scope)).toBe('ok');
    expect(h.handoffs.read(h.key).latest?.cursor).toEqual({ sessionId: 'source-session', event: 4, messageEvent: 4 });
    expect(h.select).toHaveBeenCalledWith('peer', 'dragon', scope);
    expect(h.source.handle.dispose).toHaveBeenCalledOnce();
    const request = h.calls[0]!;
    expect(request.provider).toBe('actual-provider');
    expect(request.model).toBe('actual-model');
    expect(JSON.stringify(request.messages)).toContain('最后纠正');
    expect(JSON.stringify(request.messages)).toContain('compact 策略');
    const record = await h.manager.getOrCreate(scope, 'peer', 'owner', { scope, targetId: 'peer' });
    expect(record).toBe(h.target);
    expect(h.toEvents).toHaveLength(2);
    expect(JSON.stringify(h.toEvents[0])).toContain('肥龙自己的聊天历史');
    expect(JSON.stringify(h.toEvents[1])).toContain('同一聊天的跨人格交接');
    expect(h.target.agent.session.append).toHaveBeenCalledWith('user/message', expect.objectContaining({ source: { kind: 'qqbot-persona-handoff', form: 'recall' } }), { surfaceOp: 'append' });
    expect(h.handoffs.read(h.key).received.dragon).toEqual({ sessionId: 'dragon-session', version: 1 });
    await h.manager.getOrCreate(scope, 'peer', 'owner', { scope, targetId: 'peer' });
    expect(h.toEvents).toHaveLength(2);
    // 新消息随后由入站 followup 提交，交接不能跑到它后面。
    h.target.agent.followup('你的新消息');
    expect(h.target.agent.session.append).toHaveBeenCalledOnce();
    expect(h.target.agent.followup).toHaveBeenCalledWith('你的新消息');
  });

  it('来源人格已回收时先恢复它，不能直接丢失最后几轮', async () => {
    const h = harness({ unloaded: true });
    expect(await h.manager.switchPersona('peer', 'dragon')).toBe('ok');
    expect(h.openSession).toHaveBeenCalledWith('group', 'peer', 'peer', { scope: 'group', targetId: 'peer' });
    expect(JSON.stringify(h.calls[0]?.messages)).toContain('最后纠正');
  });

  it('人格切换保留 Web 实际选中的模型，即使聊天默认和目标旧会话是不同的请求格式', async () => {
    const route = { provider: 'hapi', model: 'gpt-responses' };
    const h = harness({ selected: route });
    await h.manager.switchPersona('peer', 'dragon');
    expect(h.calls[0]?.provider).toBe(route.provider);
    expect(h.calls[0]?.model).toBe(route.model);
    expect(h.modelPin).toHaveBeenCalledWith(h.key, route);
    await h.manager.getOrCreate('group', 'peer', 'owner', { scope: 'group', targetId: 'peer' });
    expect(h.target.agent.session.append).toHaveBeenCalledWith('model/selection', route);
  });

  it('旧版账本说已接收但交接没真正写入会话时，修复后重新补送', async () => {
    const h = harness();
    await h.manager.switchPersona('peer', 'dragon');
    const delivery = h.handoffs.delivery(h.key, 'dragon', 'dragon-session')!;
    h.handoffs.acknowledge(h.key, 'dragon', 'dragon-session', delivery.version);
    expect(h.handoffs.delivery(h.key, 'dragon', 'dragon-session')).toBeUndefined();
    await h.manager.getOrCreate('group', 'peer', 'owner', { scope: 'group', targetId: 'peer' });
    expect(h.toEvents).toHaveLength(2);
    expect(JSON.stringify(h.toEvents[1])).toContain('qqbot-persona-handoff');
    expect(JSON.stringify(h.toEvents[1])).not.toContain('"kind":"plugin"');
    const newer = h.handoffs.begin(h.key, 'other', { cursor: { sessionId: 's3', event: 2 }, transcript: '新的纠正', recent: '新的纠正' });
    h.handoffs.complete(h.key, newer.id, '第二版事实');
    h.handoffs.acknowledge(h.key, 'dragon', 'dragon-session', 2);
    await h.manager.getOrCreate('group', 'peer', 'owner', { scope: 'group', targetId: 'peer' });
    expect(JSON.stringify(h.toEvents[2])).toContain('第二版事实');
  });

  it('真实宿主 Session 的请求历史顺序为目标自身历史、交接、新消息', async () => {
    const h = harness();
    const session = Session.create(SessionId('f2e86374-ce41-401b-a241-fd899eebd642'));
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '目标人格自己的历史' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    h.target.agent = { ...h.target.agent, session };
    await h.manager.switchPersona('peer', 'dragon');
    await h.manager.getOrCreate('group', 'peer', 'owner', { scope: 'group', targetId: 'peer' });
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '现在的新消息' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    const messages = session.deriveMessages();
    expect(messages).toHaveLength(3);
    expect(JSON.stringify(messages[0])).toContain('目标人格自己的历史');
    expect(JSON.stringify(messages[1])).toContain('同一聊天的跨人格交接');
    expect(JSON.stringify(messages[2])).toContain('现在的新消息');
  });

  it('生成期间新消息等待，同聊天重复点切换返回 busy，落盘前仍保持旧人格', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const h = harness({ gate });
    const switching = h.manager.switchPersona('peer', 'dragon');
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.select).not.toHaveBeenCalled();
    expect(h.handoffs.read(h.key).pending?.status).toBe('generating');
    expect(await h.manager.switchPersona('peer', 'other')).toBe('busy');
    let delivered = false;
    const arriving = h.manager.getOrCreate('group', 'peer', 'owner', { scope: 'group', targetId: 'peer' }).then(() => { delivered = true; });
    await Promise.resolve();
    expect(delivered).toBe(false);
    finish();
    expect(await switching).toBe('ok');
    await arriving;
    expect(delivered).toBe(true);
    expect(h.handoffs.read(h.key).latest?.version).toBe(1);
    expect(h.toEvents).toHaveLength(2);
  });

  it('生成失败保留旧交接，并给接手人格明确提示未覆盖的最后一句', async () => {
    const h = harness({ fail: true });
    const old = h.handoffs.begin(h.key, 'old', { cursor: { sessionId: 'earlier', event: 1 }, transcript: '旧事实', recent: '' });
    h.handoffs.complete(h.key, old.id, '上一版已确认的事实');
    expect(await h.manager.switchPersona('peer', 'dragon')).toBe('handoff-incomplete');
    expect(h.handoffs.read(h.key).latest?.summary).toBe('上一版已确认的事实');
    expect(h.handoffs.read(h.key).pending?.status).toBe('failed');
    await h.manager.getOrCreate('group', 'peer', 'owner', { scope: 'group', targetId: 'peer' });
    expect(JSON.stringify(h.toEvents[1])).toContain('交接未完成');
    expect(JSON.stringify(h.toEvents[1])).toContain('最后纠正');
  });

  it('/new 也等待按钮发起的交接完成，避免同时清空来源会话', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const h = harness({ gate });
    const switching = h.manager.switchPersona('peer', 'dragon');
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const start = vi.spyOn(h.manager, 'startNewSession').mockReturnValue(false);
    const command = newCommand({ manager: h.manager } as never);
    const response = command.handler({ message: { kind: 'group', groupOpenid: 'peer', senderId: 'owner' }, command: { raw: '' } } as never);
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    finish();
    await switching;
    await response;
    expect(start).toHaveBeenCalledWith('group', 'peer', { handoff: true });
  });

  it('交接生成失败期间用户明确换了模型，不能再用旧模型快照覆盖这次决定', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const h = harness({ gate, fail: true });
    const switching = h.manager.switchPersona('peer', 'dragon');
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const latest = { provider: 'google', model: 'explicit-new-choice' };
    await h.manager.setModelOverride('group', 'peer', latest);
    finish();
    expect(await switching).toBe('busy');
    expect(h.select).not.toHaveBeenCalled();
    expect(h.modelPin).toHaveBeenCalledExactlyOnceWith(h.key, latest);
  });

  it('落盘失败不切换，不把失败的交接标成已接收', async () => {
    const h = harness();
    vi.spyOn(h.handoffs, 'begin').mockImplementation(() => { throw new Error('disk full'); });
    expect(await h.manager.switchPersona('peer', 'dragon')).toBe('failed');
    expect(h.select).not.toHaveBeenCalled();
    expect(h.source.handle.dispose).not.toHaveBeenCalled();
    expect(h.handoffs.read(h.key).received).toEqual({});
  });

  it('会话写入交接失败时不记接收；写入成功而账本写入失败时重试也不重复追加', async () => {
    const h = harness();
    await h.manager.switchPersona('peer', 'dragon');
    vi.mocked(h.target.agent.session.append!).mockImplementationOnce(() => { throw new Error('append failed'); });
    await expect(h.manager.getOrCreate('group', 'peer', 'owner', { scope: 'group', targetId: 'peer' })).rejects.toThrow('append failed');
    expect(h.handoffs.read(h.key).received).toEqual({});
    const ack = vi.spyOn(h.handoffs, 'acknowledge').mockImplementationOnce(() => { throw new Error('receipt failed'); });
    await expect(h.manager.getOrCreate('group', 'peer', 'owner', { scope: 'group', targetId: 'peer' })).rejects.toThrow('receipt failed');
    expect(h.toEvents).toHaveLength(2);
    ack.mockRestore();
    await h.manager.getOrCreate('group', 'peer', 'owner', { scope: 'group', targetId: 'peer' });
    expect(h.toEvents).toHaveLength(2);
    expect(h.handoffs.read(h.key).received.dragon?.version).toBe(1);
  });

  it('生成期间来源历史又增加时拒绝切换，不能声称覆盖新增消息', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const h = harness({ gate });
    const switching = h.manager.switchPersona('peer', 'dragon');
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.fromEvents.push({ type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: 'Web 新增一句纠正' }] } });
    finish();
    expect(await switching).toBe('busy');
    expect(h.select).not.toHaveBeenCalled();
    expect(h.handoffs.read(h.key).latest).toBeUndefined();
    expect(h.handoffs.read(h.key).pending?.error).toContain('历史发生变化');
  });
});
