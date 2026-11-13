import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DND_COMBAT_AGENT_DEFAULTS } from '../config.ts';
import { SessionManager, dndStateText } from '../session/session-manager.ts';
import type { DshAgent, SessionRecord } from '../session/types.ts';
import { AdventureLibrary } from './adventure.ts';
import { CampaignStore, endInitiative, startInitiative, upsertCharacter } from './campaign.ts';
import { COMBAT_TOOLS, DndCombatAgents, recentCombatDialogue } from './combat-agent.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { DndToolScope } from './tool-scope.ts';

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'dnd-combat-agent-'));
  const service = new DndService({ store: new CampaignStore(join(directory, 'campaigns')), library: new AdventureLibrary(), mapDir: directory, roller: () => 10 });
  const key = 'qqbot:app:group:G1';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: '战士', playerId: 'P1', maxHp: 30, abilities: { dex: 20 }, weapons: [{ name: '长剑', damage: '1d8' }] });
    upsertCharacter(c, { name: '地精', kind: 'monster', room: c.currentRoom, maxHp: 50 });
    startInitiative(c, () => 10);
  });
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const mainAgent = {
    id: 'main', status: 'idle', ctx: { get: vi.fn() },
    session: { id: 'main', header: { cwd: directory }, events: [
      { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '[玩家 #U1] (@you) 用长剑攻击地精' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '轮到战士。' }] } } },
    ] },
    followup: vi.fn(), cancel: vi.fn(), whenIdle: vi.fn(async () => {}),
  } as unknown as DshAgent;
  const main: SessionRecord = {
    sessionKey: key, sessionId: 'main', agent: mainAgent, handle: { agent: mainAgent, dispose: vi.fn(async () => {}) },
    scope: 'group', peerId: 'G1', senderId: 'P1', recentSenders: [{ id: 'P1', at: Date.now() }], lastActivity: Date.now(),
    replyTarget: { scope: 'group', targetId: 'G1', msgId: 'M1' },
  };
  const settings = { ...DND_COMBAT_AGENT_DEFAULTS, enabled: true };
  const restrictions: unknown[] = [], prompts: Array<{ text: string; complete: boolean; interpolate: boolean }> = [];
  const contexts: Array<{ text: string; interpolate: boolean }> = [];
  const guards: Array<(exec: { name: string; arguments?: unknown }) => string | undefined> = [];
  const children: Array<{ agent: DshAgent; dispose: ReturnType<typeof vi.fn> }> = [];
  const make = async (options: { sessionId?: string; resumeSessionId?: string; setup?: (scope: unknown) => void }) => {
    const id = options.sessionId ?? options.resumeSessionId!;
    const scope = { get: (name: string) => name === 'tools' ? {
      restrict: (filter: unknown) => { restrictions.push(filter); return vi.fn(); },
      guard: (guard: typeof guards[number]) => { guards.push(guard); },
    } : {
      section: (section: typeof prompts[number]) => { prompts.push(section); },
      context: (context: typeof contexts[number]) => { contexts.push(context); },
    } };
    await options.setup?.(scope);
    const agent = { ...mainAgent, id, ctx: scope, session: { id, events: [] }, followup: vi.fn(), cancel: vi.fn(), whenIdle: vi.fn(async () => {}) } as unknown as DshAgent;
    const handle = { agent, dispose: vi.fn(async () => {}) };
    children.push(handle);
    return handle;
  };
  const agents = { create: vi.fn(make), resume: vi.fn(make), get: vi.fn() };
  const sync = vi.fn();
  const createRouter = () => new DndCombatAgents(agents as never, service, () => settings, sync, logger, join(directory, 'runs'));
  const router = createRouter();
  return { directory, service, key, logger, main, settings, agents, children, restrictions, prompts, contexts, guards, router, sync, createRouter };
}

function usage(seq: number, model = 'deepseek-v4.1-flash') {
  return { type: 'assistant/message', seq, data: {
    usage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 20, outputTokens: 30 },
    message: { source: { provider: 'test', model }, content: [{ type: 'text', text: '地精倒下了。' }] },
  } };
}

describe('战斗代理路由和同一份团档', () => {
  it('主 DM 回复结束后自动接管场地和首回合，不必等另一个玩家消息', async () => {
    const h = harness();
    let unblock!: () => void;
    Object.assign(h.main.agent, { status: 'running', whenIdle: () => new Promise<void>((resolve) => { unblock = resolve; }) });
    expect(h.router.toolView(h.main)).toBe('narrative');
    const starting = h.router.startAfterReply(h.main, '场地图：拱门在北侧');
    expect(h.router.startAfterReply(h.main, '重复开战')).toBeUndefined();
    expect(h.agents.create).not.toHaveBeenCalled();
    Object.assign(h.main.agent, { status: 'idle' });
    unblock();
    const child = await starting;
    expect(child).toBeDefined();
    expect(h.agents.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(child!.agent.followup).mock.calls)).toContain('拱门在北侧');
    expect(h.router.toolView(h.main)).toBe('waiting');
    expect(h.router.toolView(child!)).toBe('full');
    expect(h.sync).toHaveBeenCalledWith(h.main);
    await h.router.dispose();
  });

  it('真实开战工具只向主级返回交接提示，完整场地材料交给自动唤醒的子级', async () => {
    const h = harness();
    h.service.store.update(h.key, (c) => endInitiative(c));
    let unblock!: () => void;
    Object.assign(h.main.agent, { status: 'running', whenIdle: () => new Promise<void>((resolve) => { unblock = resolve; }) });
    const definitions = new Map<string, { execute(args: object, exec: object): Promise<{ text: string }> }>();
    let starting: ReturnType<DndCombatAgents['startAfterReply']>;
    const onTurnChange = vi.fn();
    registerDndTools({ get: () => ({ register: (d: { name: string; execute(args: object, exec: object): Promise<{ text: string }> }) => definitions.set(d.name, d) }) } as never,
      { service: h.service, manager: { combatAgents: h.router, findByAgent: () => h.main } as never, logger: h.logger, sendImage: vi.fn(), onTurnChange,
        onCombatStart: (record, field) => { starting = h.router.startAfterReply(record, field); return starting !== undefined; } });
    const result = await definitions.get('dnd_initiative')!.execute({ action: 'start', participants: ['战士', '地精'] }, { agent: h.main.agent });
    expect(result.text).toContain('【战斗委派】');
    expect(result.text).not.toContain('dnd_position set');
    expect(onTurnChange).not.toHaveBeenCalled();
    Object.assign(h.main.agent, { status: 'idle' }); unblock();
    const child = await starting!;
    expect(child).toBeDefined();
    expect(JSON.stringify(vi.mocked(child!.agent.followup).mock.calls)).toContain('场地');
    expect(h.service.active(h.key)!.campaign.initiative!.round).toBe(1);
    await h.router.dispose();
  });

  it('自动交接失败时恢复主 DM 的完整工具并唤醒它继续，不重掷先攻', async () => {
    const h = harness();
    h.agents.create.mockRejectedValue(new Error('unavailable'));
    await h.router.startAfterReply(h.main, '场地');
    expect(h.router.toolView(h.main)).toBe('full');
    expect(JSON.stringify(vi.mocked(h.main.agent.followup).mock.calls)).toContain('完整战斗工具已恢复');
    expect(h.service.active(h.key)!.campaign.initiative).toBeDefined();
    expect(h.sync).toHaveBeenCalledWith(h.main);
  });

  it('玩家抢先触发接管时复用已有子级，不额外发一次开场消息', async () => {
    const h = harness();
    let unblock!: () => void;
    Object.assign(h.main.agent, { whenIdle: () => new Promise<void>((resolve) => { unblock = resolve; }) });
    const starting = h.router.startAfterReply(h.main, '场地');
    const child = await h.router.select(h.main);
    unblock();
    expect(await starting).toBe(child);
    expect(h.agents.create).toHaveBeenCalledOnce();
    expect(child.agent.followup).not.toHaveBeenCalled();
    await h.router.dispose();
  });

  it('等待主 DM 收尾期间取消、暂停或已有玩家先接管，不重复启动战斗', async () => {
    const h = harness();
    let unblock!: () => void;
    Object.assign(h.main.agent, { whenIdle: () => new Promise<void>((resolve) => { unblock = resolve; }) });
    const starting = h.router.startAfterReply(h.main, '场地');
    await h.router.release(h.key);
    unblock();
    expect(await starting).toBeUndefined();
    expect(h.agents.create).not.toHaveBeenCalled();
    const other = harness();
    await other.router.select(other.main);
    expect(other.router.startAfterReply(other.main, '场地')).toBeUndefined();
    await other.router.dispose();
  });

  it('旧的桌面约定和完整能力卡不受最近对话截断影响', async () => {
    const h = harness();
    h.service.store.update(h.key, (c) => {
      c.chronicle = [{ id: 42, at: 1, kind: 'ruling', text: '时间充裕时默认由队友施放引导术；未到场的人不掷先攻。' }];
      c.characters[0]!.notes = '先攻包含职业被动，反应只在本人同意后使用。';
      c.characters[0]!.traits = ['额外攻击'];
    });
    (h.main.agent.session.events as unknown[]).push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '很长的最近对话'.repeat(2000) }] } });
    await h.router.select(h.main);
    expect(h.prompts[0]!.text).toContain('#42 时间充裕时默认由队友施放引导术');
    expect(h.prompts[0]!.text).toContain('"traits":["额外攻击"]');
    expect(h.prompts[0]!.text).toContain('先攻包含职业被动');
    await h.router.dispose();
  });

  it('默认不开启；无战斗不建子级，忙碌主 DM 不被中途抢走', async () => {
    const h = harness();
    h.settings.enabled = false;
    expect(await h.router.select(h.main)).toBe(h.main);
    h.settings.enabled = true;
    Object.assign(h.main.agent, { status: 'running' });
    expect(await h.router.select(h.main)).toBe(h.main);
    Object.assign(h.main.agent, { status: 'idle' });
    h.service.store.update(h.key, (c) => { delete c.initiative; });
    expect(await h.router.select(h.main)).toBe(h.main);
    expect(h.agents.create).not.toHaveBeenCalled();
  });

  it('并发玩家/按钮只创建一次，后续复用子会话，路由和实时团况仍属于原群', async () => {
    const h = harness();
    const [child, second] = await Promise.all([h.router.select(h.main), h.router.select(h.main)]);
    expect(child).toBe(second);
    expect(child.sessionKey).toBe(h.key);
    expect(h.agents.create).toHaveBeenCalledOnce();
    expect(h.agents.create.mock.calls[0]![0]).toMatchObject({ agentOptions: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, meta: { parentSession: 'main', cwd: h.directory } });
    expect(h.router.findAgent(child.agent)).toBe(child);
    expect(h.router.findSession(child.sessionId)).toBe(child);
    expect(h.router.findAgent({ ...child.agent })).toBeUndefined();
    expect(dndStateText(child.agent, (a) => h.router.findAgent(a), h.service, h.logger)).toContain('战斗第 1 轮');
    h.main.replyTarget = { ...h.main.replyTarget, msgId: 'M2' };
    expect((await h.router.select(h.main)).replyTarget.msgId).toBe('M2');
    expect(h.prompts[0]).toMatchObject({ complete: true });
    expect(h.prompts[0]!.text).toContain('用长剑攻击地精');
    expect(h.prompts[0]!.text).toContain('【角色能力与被动');
    expect(h.prompts[0]!.text).toContain('baseAttackModifier');
    expect(h.prompts[0]!.interpolate).toBe(false);
    expect(h.restrictions).toContainEqual({ allow: COMBAT_TOOLS });
    expect(h.guards[0]!({ name: 'pwsh' })).toContain('只能');
    expect(h.guards[0]!({ name: 'subagent' })).toContain('只能');
    expect(h.guards[0]!({ name: 'dnd_initiative', arguments: { action: 'start' } })).toContain('不可重开');
    await h.router.dispose();
  });

  it('真实 dnd 工具由子级结算到原团档，主级不能同时写，结束后不再执行战斗操作', async () => {
    const h = harness();
    const child = await h.router.select(h.main);
    type Tool = { name: string; execute: (args: unknown, exec: { agent: DshAgent }) => Promise<{ text: string }> };
    const tools = new Map<string, Tool>();
    const manager = {
      combatAgents: h.router,
      findByAgent: (a: DshAgent) => h.router.findAgent(a) ?? (a === h.main.agent ? h.main : undefined),
    };
    registerDndTools({ get: () => ({ register: (tool: Tool) => tools.set(tool.name, tool) }) } as never,
      { service: h.service, manager: manager as never, logger: h.logger, sendImage: vi.fn() });
    const concludeTurn = vi.fn();
    const call = (name: string, args: unknown, agent = child.agent) => tools.get(name)!.execute(args, { agent, concludeTurn } as never);
    await expect(call('dnd_apply', { target: '战士', damage: 3 }, h.main.agent)).rejects.toThrow('不能同时');
    await call('dnd_apply', { target: '战士', damage: 3 });
    expect(h.service.store.load(h.key)!.characters.find((ch) => ch.name === '战士')!.hp).toBe(27);
    await call('dnd_initiative', { action: 'end' });
    expect(concludeTurn).toHaveBeenCalledOnce();
    expect(h.guards[0]!({ name: 'dnd_apply' })).toContain('战斗已结束');
    h.router.observe(child, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    await vi.waitFor(() => expect(h.main.agent.followup).toHaveBeenCalledOnce());
    const handoff = JSON.stringify(vi.mocked(h.main.agent.followup).mock.calls[0]);
    expect(handoff).toContain('禁止重复扣血');
    expect(handoff).toContain('27');
    expect(h.router.current(h.key)).toBeUndefined();
    expect(h.children[0]!.dispose).toHaveBeenCalledOnce();
  });

  it('子级工具范围与 hideAll/sync 能叠加，撤掉隐藏不会移除 allow 限制', async () => {
    const h = harness();
    const child = await h.router.select(h.main);
    const scope = new DndToolScope(h.service, [...COMBAT_TOOLS], h.logger);
    scope.hideAll(child.agent);
    scope.sync(child);
    expect(h.restrictions).toContainEqual({ allow: COMBAT_TOOLS });
    await h.router.dispose();
  });
});

describe('战斗代理交接、恢复和用量', () => {
  it('固定交接只出现一次，连续团况变化不再携带交接正文或触发模板插值', async () => {
    const h = harness();
    (h.main.agent.session.events as unknown[]).push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '测试原话 {{unknown_variable}}' }] } });
    const child = await h.router.select(h.main);
    const prefix = h.prompts[0]!.text;
    const snapshots: string[] = [];
    for (let i = 0; i < 3; i++) {
      h.service.store.update(h.key, (c) => { c.initiative!.round++; });
      await h.router.select(h.main);
      snapshots.push(dndStateText(child.agent, (a) => h.router.findAgent(a), h.service, h.logger));
    }
    expect(h.contexts).toHaveLength(0);
    expect(h.prompts).toHaveLength(1);
    expect(prefix.split('【开战交接 · 仅供裁定，不要转发】')).toHaveLength(2);
    expect(prefix).toContain('{{unknown_variable}}');
    expect(h.prompts[0]!.interpolate).toBe(false);
    expect(new Set(snapshots).size).toBe(3);
    expect(snapshots.every((text) => !text.includes('【开战交接'))).toBe(true);
    await h.router.dispose();
  });

  it('缓存与新输入分开，重复事件不重记，战后主模型只叫醒一次并单独计费', async () => {
    const h = harness();
    const child = await h.router.select(h.main);
    h.router.observe(child, usage(1));
    h.router.observe(child, usage(1));
    h.service.store.update(h.key, (c) => endInitiative(c));
    h.router.observe(child, { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } });
    h.router.observe(child, { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } });
    await vi.waitFor(() => expect(h.main.agent.followup).toHaveBeenCalledOnce());
    h.router.observe(h.main, usage(100, 'argon'));
    h.router.observe(h.main, { type: 'turn/end', seq: 101, data: {} });
    h.router.observe(h.main, usage(102, 'argon'));
    const report = h.router.report(h.key);
    expect(report).toContain('combat:test/deepseek-v4.1-flash：1 次请求｜新输入 100｜缓存读取 900｜缓存写入 20｜输出 30');
    expect(report).toContain('main:test/argon：1 次请求');
    expect(report).not.toContain('地精倒下');
    const files = readdirSync(join(h.directory, 'runs')).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(h.directory, 'runs', files[0]!), 'utf8')).status).toBe('completed');
  });

  it('插件重组保留活跃日志，恢复同一子会话，不复制主会话历史', async () => {
    const h = harness();
    const child = await h.router.select(h.main);
    h.router.observe(child, usage(1));
    await h.router.dispose();
    const restored = h.createRouter();
    const next = await restored.select(h.main);
    expect(next.sessionId).toBe(child.sessionId);
    expect(h.agents.resume).toHaveBeenCalledOnce();
    expect(h.agents.create).toHaveBeenCalledOnce();
    expect(h.agents.create.mock.calls[0]![0]).not.toHaveProperty('seed');
    restored.observe(next, usage(1));
    expect(restored.report(h.key)).toContain('1 次请求');
    await restored.dispose();
  });

  it('模型启动失败不会反复重试或吞掉下一条玩家消息', async () => {
    const h = harness();
    h.agents.create.mockRejectedValue(new Error('unknown model'));
    expect(await h.router.select(h.main)).toBe(h.main);
    expect(await h.router.select(h.main)).toBe(h.main);
    expect(h.agents.create).toHaveBeenCalledOnce();
    expect(h.router.report(h.key)).toContain('failed');
    expect(h.main.agent.followup).not.toHaveBeenCalled();
  });

  it('运行失败交回当前状态，保留进行中的先攻，不把它说成胜利', async () => {
    const h = harness();
    const child = await h.router.select(h.main);
    h.router.observe(child, { type: 'turn/end', data: { reason: { kind: 'error' } } });
    await vi.waitFor(() => expect(h.main.agent.followup).toHaveBeenCalledOnce());
    expect(JSON.stringify(vi.mocked(h.main.agent.followup).mock.calls)).toContain('不能当作战斗已结束');
    expect(h.service.active(h.key)!.campaign.initiative).toBeDefined();
    expect(await h.router.select(h.main)).toBe(h.main);
  });

  it('暂停保留战斗并交回暂停提醒；/new 清理子级，不唤醒旧主模型', async () => {
    const h = harness();
    const child = await h.router.select(h.main);
    h.service.stop(h.key);
    h.router.observe(child, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    await vi.waitFor(() => expect(h.main.agent.followup).toHaveBeenCalledOnce());
    expect(JSON.stringify(vi.mocked(h.main.agent.followup).mock.calls)).toContain('团已暂停');
    expect(h.service.saved(h.key)!.campaign.initiative).toBeDefined();
    const other = harness();
    await other.router.select(other.main);
    await other.router.release(other.key);
    expect(other.main.agent.followup).not.toHaveBeenCalled();
    expect(other.children[0]!.agent.cancel).toHaveBeenCalledOnce();
  });

  it('/new 在子级创建中发生时，迟到的 handle 被释放', async () => {
    const h = harness();
    const original = h.agents.create.getMockImplementation()!;
    let unblock!: () => void;
    h.agents.create.mockImplementation(async (options) => {
      await new Promise<void>((resolve) => { unblock = resolve; });
      return original(options);
    });
    const selecting = h.router.select(h.main);
    await vi.waitFor(() => expect(unblock).toBeDefined());
    await h.router.release(h.key);
    unblock();
    expect(await selecting).toBe(h.main);
    expect(h.children[0]!.dispose).toHaveBeenCalledOnce();
    expect(h.router.current(h.key)).toBeUndefined();
  });
});

it('交接上下文截断且排除 runtime-context/工具/推理', () => {
  const h = harness();
  const events = h.main.agent.session.events as unknown[];
  events.push({ type: 'user/message', data: { source: { kind: 'runtime-context' }, message: { content: [{ type: 'text', text: '旧的 DM 秘密' }] } } });
  events.push({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: '旧工具结果' }] } } });
  events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '隐藏推理' }, { type: 'text', text: '甲'.repeat(100) }] } } });
  const context = recentCombatDialogue(h.main.agent, 20);
  expect(context).not.toMatch(/秘密|工具结果|隐藏推理|长剑/);
  expect(context).toBe(`主 DM：${'甲'.repeat(20)}`);
});

it('按真实 v4 日志读取玩家临战约定，兼容旧包装并过滤宿主注入', () => {
  const h = harness();
  const events = h.main.agent.session.events as unknown[];
  events.push({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '[玩家 #U1] (@you) 我守在门口，不要替我往前走' }] } });
  events.push({ type: 'user/message', data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '旧格式玩家发言' }] } } });
  for (const kind of ['runtime-context', 'skill-catalog', 'time-context']) {
    events.push({ type: 'user/message', data: { role: 'user', source: { kind }, content: [{ type: 'text', text: `不应带入：${kind}` }] } });
  }
  const dialogue = recentCombatDialogue(h.main.agent, 8000);
  expect(dialogue).toContain('玩家：[玩家 #U1] (@you) 我守在门口，不要替我往前走');
  expect(dialogue).toContain('玩家：旧格式玩家发言');
  expect(dialogue).toContain('主 DM：轮到战士。');
  expect(dialogue).not.toContain('不应带入');
});

it('SessionManager 的玩家和按钮入口都直接路由子级', async () => {
  const h = harness();
  const manager = Object.assign(Object.create(SessionManager.prototype), {
    sessions: new Map([[h.key, h.main]]), combatAgents: h.router,
  }) as SessionManager;
  const child = await manager.routeDndRecord(h.main);
  expect(manager.findByAgent(child.agent)).toBe(child);
  expect(manager.findBySessionId(child.sessionId)).toBe(child);
  await manager.sendDndFollowup(h.main, { text: '玩家点了结束回合' });
  expect(child.agent.followup).toHaveBeenCalledWith({ text: '玩家点了结束回合' });
  expect(h.main.agent.followup).not.toHaveBeenCalled();
  await h.router.dispose();
});
