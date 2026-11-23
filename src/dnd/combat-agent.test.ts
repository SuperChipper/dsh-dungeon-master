import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { describe, expect, it, vi } from 'vitest';
import { DND_COMBAT_AGENT_DEFAULTS } from '../config.ts';
import { SessionManager, dndStateText } from '../session/session-manager.ts';
import type { DshAgent, SessionRecord } from '../session/types.ts';
import { AdventureLibrary } from './adventure.ts';
import { CampaignStore, applyDamage, endInitiative, startInitiative, upsertCharacter } from './campaign.ts';
import { COMBAT_TOOLS, DndCombatAgents, recentCombatDialogue, type CombatFallbackState } from './combat-agent.ts';
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
  const settings = { ...DND_COMBAT_AGENT_DEFAULTS, enabled: true, provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' };
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
  let fallbackState: CombatFallbackState | undefined;
  const createRouter = () => new DndCombatAgents(agents as never, service, () => settings, sync, logger, join(directory, 'runs'), () => fallbackState);
  const router = createRouter();
  return { directory, service, key, logger, main, settings, agents, children, restrictions, prompts, contexts, guards, router, sync, createRouter, setFallback: (next?: CombatFallbackState) => { fallbackState = next; } };
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
    expect(h.guards[0]!({ name: 'dnd_rule', arguments: { action: 'define' } })).toContain('仅可查询');
    expect(h.guards[0]!({ name: 'dnd_rule', arguments: { action: 'list' } })).toBeUndefined();
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
    const endRes = await call('dnd_initiative', { action: 'end' });
    expect(concludeTurn).not.toHaveBeenCalled();
    expect(endRes.text).toContain('【收尾播报】');
    expect(h.guards[0]!({ name: 'dnd_apply' })).toContain('战斗已结束');
    h.router.observe(child, {
      type: 'assistant/message',
      seq: 10,
      data: {
        message: {
          source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
          content: [{ type: 'text', text: '战士挥出最后一剑斩倒地精，战斗结束！' }],
        },
      },
    });
    h.router.observe(child, { type: 'turn/end', seq: 11, data: { reason: { kind: 'completed' } } });
    await vi.waitFor(() => expect(h.main.agent.followup).toHaveBeenCalledOnce());
    const handoff = JSON.stringify(vi.mocked(h.main.agent.followup).mock.calls[0]);
    expect(handoff).toContain('禁止重复扣血');
    expect(handoff).toContain('27');
    expect(handoff).toContain('战士挥出最后一剑斩倒地精');
    expect(handoff).not.toContain('未向群内播报的战斗账本');
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

  it('运行失败交回当前状态，保留进行中的先攻，不把它说成胜利，并记录失败原因', async () => {
    const h = harness();
    const child = await h.router.select(h.main);
    h.router.observe(child, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'QUOTA', message: '429 GoUsageLimitError' } } } });
    await vi.waitFor(() => expect(h.main.agent.followup).toHaveBeenCalledOnce());
    const followupText = JSON.stringify(vi.mocked(h.main.agent.followup).mock.calls);
    expect(followupText).toContain('不能当作战斗已结束');
    expect(followupText).toContain('QUOTA');
    expect(followupText).toContain('429 GoUsageLimitError');
    expect(h.router.report(h.key)).toContain('失败原因：error (QUOTA): 429 GoUsageLimitError');
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

it('主通道 turn/end 报 429 QUOTA 时自动切备用通道重放提示，下场开战在冷却期内直接走备用通道，主备均败才交回主 DM', async () => {
  const h = harness();
  h.setFallback({ backup: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' } });
  const child1 = await h.router.select(h.main);
  (child1.agent.session.events as unknown[]).push({
    type: 'user/message',
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '[系统 · 战斗接管] 布置场地并推进首轮' }] },
  });
  const handled = h.router.observe(child1, {
    type: 'turn/end',
    seq: 13,
    data: { reason: { kind: 'error', error: { code: 'QUOTA', message: 'OpenCode Go usage limit reached' } } },
  });
  expect(handled).toBe(true);
  await vi.waitFor(() => expect(h.agents.create).toHaveBeenCalledTimes(2));

  // 已自动切到 commandcode 子代理，未交回主 DM
  expect(h.main.agent.followup).not.toHaveBeenCalled();
  expect(h.children[0]!.dispose).toHaveBeenCalledOnce();
  const secondCreateOpts = h.agents.create.mock.calls[1]![0] as { agentOptions?: { provider?: string; model?: string } };
  expect(secondCreateOpts.agentOptions).toMatchObject({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' });
  const child2 = h.router.current(h.key)!;
  expect(child2).toBeDefined();
  expect(child2.sessionId).not.toBe(child1.sessionId);
  expect(JSON.stringify(vi.mocked(child2.agent.followup).mock.calls)).toContain('布置场地并推进首轮');
  expect(h.router.report(h.key)).toContain('commandcode/deepseek/deepseek-v4.1-flash');
  expect(h.router.report(h.key)).toContain('已回退自：opencode-go/deepseek-v4.1-flash');

  // 若备用通道也继续报错，不再死循环，而是把两侧失败原因交回主 DM
  const handled2 = h.router.observe(child2, {
    type: 'turn/end',
    seq: 5,
    data: { reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'upstream 502' } } },
  });
  expect(handled2).toBe(true);
  await vi.waitFor(() => expect(h.main.agent.followup).toHaveBeenCalledOnce());
  expect(h.agents.create).toHaveBeenCalledTimes(2);
  const handoff = JSON.stringify(vi.mocked(h.main.agent.followup).mock.calls);
  expect(handoff).toContain('OpenCode Go usage limit reached');
  expect(handoff).toContain('upstream 502');

  // 下一场新战斗开启时，主通道仍在冷却期内，直接以备用通道启动
  h.service.store.update(h.key, (c) => endInitiative(c));
  await h.router.select(h.main);
  h.service.store.update(h.key, (c) => startInitiative(c, () => 12));
  const child3 = await h.router.select(h.main);
  expect(child3).not.toBe(h.main);
  const thirdCreateOpts = h.agents.create.mock.calls[2]![0] as { agentOptions?: { provider?: string; model?: string } };
  expect(thirdCreateOpts.agentOptions).toMatchObject({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' });
  await h.router.dispose();
});

it('无论宿主是否提供 suppressRuntimeContext，仅在回合变化时前置精简战斗快照并去重生命骰', async () => {
  const h = harness();
  const suppressRuntimeContext = vi.fn();
  const baseImpl = h.agents.create.getMockImplementation()!;
  h.agents.create.mockImplementation(async (options: { sessionId?: string; resumeSessionId?: string; setup?: (scope: unknown) => void }) => {
    const wrappedSetup = async (scope: { get(name: string): unknown }) => {
      const sp = {
        ...(scope.get('systemPrompt') as Record<string, unknown>),
        suppressRuntimeContext,
      };
      const wrappedScope = { get: (name: string) => (name === 'systemPrompt' ? sp : scope.get(name)) };
      await options.setup?.(wrappedScope);
    };
    return baseImpl({ ...options, setup: wrappedSetup });
  });

  // 增加同房未参战 PC、异地 PC、多种重复生命骰资源，并配置非演练房间 DM 笔记
  h.service.store.update(h.key, (c) => {
    const fighter = c.characters.find((x) => x.name === '战士')!;
    fighter.hitDie = 'd10';
    fighter.resources = {
      动作如潮: { current: 1, max: 1, reset: 'short' },
      生命骰: { current: 5, max: 5, reset: 'long' },
      '生命骰 d10': { current: 4, max: 5, reset: 'long' },
    };
    upsertCharacter(c, {
      name: '法师', playerId: 'P2', maxHp: 22, room: c.currentRoom,
      resources: { '1环法术位': { current: 3, max: 4, reset: 'long' } },
    });
    upsertCharacter(c, {
      name: '留守牧师', playerId: 'P3', maxHp: 28, room: 'other-room',
      resources: { 引导神力: { current: 2, max: 2, reset: 'short' } },
    });
    c.begun = true;
  });
  const advRoom = h.service.require(h.key).adventure.sites[0]!.rooms.find((r) => r.id === h.service.require(h.key).campaign.currentRoom)!;
  advRoom.dmNotes = '祭坛下方藏有酸液暗格（感知 DC 15 发现）。';

  const child = (await h.router.startAfterReply(h.main, '场地 10x10'))!;
  expect(suppressRuntimeContext).toHaveBeenCalledOnce();
  // 静态房间 DM 笔记只放进固定交接前缀一次
  expect(h.prompts[0]!.text).toContain('祭坛下方藏有酸液暗格');

  // 开战接管首条消息前置了精简战斗快照
  const startPrompt = (vi.mocked(child.agent.followup).mock.calls[0]![0] as { content: Array<{ text?: string }> }).content[0]!.text!;
  expect(startPrompt).toContain('【团况 · DM 视角（本轮最新快照，旧快照作废）】');
  expect(startPrompt).toContain('当前战场：');
  expect(startPrompt).toContain('参战我方：战士 30/30');
  expect(startPrompt).toContain('同房未入战：法师');
  expect(startPrompt).toContain('生命骰 d104/5');
  expect(startPrompt).not.toContain('生命骰5/5');
  expect(startPrompt).not.toMatch(/生命骰 d104\/5[^\n]*生命骰\d+\/\d+/);
  expect(startPrompt).not.toContain('留守牧师');
  expect(startPrompt).not.toContain('引导神力');
  expect(startPrompt).not.toContain('1环法术位');
  expect(startPrompt).not.toContain('可见出口：');
  expect(startPrompt).not.toContain('祭坛下方藏有酸液暗格');

  // 局面未变化（玩家只问规则）时不重复前置快照
  const qnaTurn = h.router.decorateInboundText(child, '[玩家 #U1] (@you) 我能退几格？');
  expect(qnaTurn).toBe('[玩家 #U1] (@you) 我能退几格？');

  // 血量变化后下一轮入站或按钮 followup 重新注入更新后的精简快照
  h.service.store.update(h.key, (c) => applyDamage(c, '战士', 6));
  const nextTurn = h.router.decorateInboundText(child, '[玩家 #U1] (@you) 我砍它一剑');
  expect(nextTurn).toContain('【团况 · DM 视角（本轮最新快照，旧快照作废）】');
  expect(nextTurn).toContain('战士 24/30');
  expect(nextTurn).toContain('[玩家 #U1] (@you) 我砍它一剑');

  // 无新变化时 sendDndFollowup 不重复注入；再扣血则注入一次
  const manager = Object.assign(Object.create(SessionManager.prototype), {
    sessions: new Map([[h.key, h.main]]), combatAgents: h.router,
  }) as SessionManager;
  await manager.sendDndFollowup(h.main, createUserMessage({ content: [{ type: 'text', text: '[系统 · 按钮] 战士结束了回合' }], source: { kind: 'user' } }));
  expect((vi.mocked(child.agent.followup).mock.calls.at(-1)![0] as { content: Array<{ text?: string }> }).content[0]!.text).toBe('[系统 · 按钮] 战士结束了回合');

  h.service.store.update(h.key, (c) => applyDamage(c, '战士', 4));
  await manager.sendDndFollowup(h.main, createUserMessage({ content: [{ type: 'text', text: '[系统 · 按钮] 战士再点状态' }], source: { kind: 'user' } }));
  const btnMsg = (vi.mocked(child.agent.followup).mock.calls.at(-1)![0] as { content: Array<{ text?: string }> }).content[0]!.text!;
  expect(btnMsg).toContain('战士 20/30');
  expect(btnMsg).toContain('[系统 · 按钮] 战士再点状态');
  await h.router.dispose();
});

it('演练模式精简快照与 dndStateText 对子代理静默、主代理保留完整快照', async () => {
  const h = harness();
  h.service.store.update(h.key, (c) => {
    endInitiative(c);
    upsertCharacter(c, { name: '无关路人怪', kind: 'monster', room: c.currentRoom, maxHp: 40 });
    startInitiative(c, () => 10, ['战士', '地精'], undefined, {}, [], { rehearsal: true });
  });
  const advRoom = h.service.require(h.key).adventure.sites[0]!.rooms.find((r) => r.id === h.service.require(h.key).campaign.currentRoom)!;
  advRoom.dmNotes = '真实地城房间暗门笔记。';

  const child = await h.router.select(h.main);
  expect(h.prompts[0]!.text).not.toContain('真实地城房间暗门笔记');

  // 无 suppressRuntimeContext 的宿主中，入站照样注入精简战况且排除无关怪与 DM 笔记
  const decorated = h.router.decorateInboundText(child, '[玩家 #U1] 开始演练');
  expect(decorated).toContain('【演练模式·战后自动还原状态与场地图】');
  expect(decorated).not.toContain('无关路人怪');
  expect(decorated).not.toContain('真实地城房间暗门笔记');
  expect(decorated).not.toContain('可见出口：');

  // required runtime context（qqbot:dnd-state）对战斗子代理固定返回空串，杜绝每步工具写档重发 Current runtime context
  const childRuntimeCtx = dndStateText(child.agent, (a) => h.router.findAgent(a), h.service, h.logger, (a) => h.router.isCombatAgent(a));
  const mainRuntimeCtx = dndStateText(h.main.agent, () => h.main, h.service, h.logger, (a) => h.router.isCombatAgent(a));
  expect(childRuntimeCtx).toBe('');
  expect(mainRuntimeCtx).toContain('可见出口：');
  expect(mainRuntimeCtx).toContain('真实地城房间暗门笔记');
  await h.router.dispose();
});

it('SessionManager.sessionIdFor 在战斗接管和备用通道切换期间始终保持为主会话 ID，不打断群历史游标', async () => {
  const h = harness();
  h.setFallback({ backup: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' } });
  const resolver = { getSessionId: () => undefined };
  const manager = Object.assign(Object.create(SessionManager.prototype), {
    config: { appId: 'app' },
    sessions: new Map([[h.key, h.main]]),
    modelResolver: resolver,
    combatAgents: h.router,
  }) as SessionManager;

  expect(manager.sessionIdFor('group', 'G1')).toBe('main');
  const child1 = await manager.routeDndRecord(h.main);
  expect(child1.sessionId).not.toBe('main');
  expect(manager.getSessionRecord('group', 'G1')).toBe(child1);
  expect(manager.sessionIdFor('group', 'G1')).toBe('main');

  h.router.observe(child1, {
    type: 'turn/end',
    seq: 1,
    data: { reason: { kind: 'error', error: { code: 'QUOTA', message: 'limit' } } },
  });
  await vi.waitFor(() => expect(h.agents.create).toHaveBeenCalledTimes(2));
  const child2 = h.router.current(h.key)!;
  expect(child2.sessionId).not.toBe(child1.sessionId);
  expect(manager.sessionIdFor('group', 'G1')).toBe('main');

  h.service.store.update(h.key, (c) => endInitiative(c));
  await manager.routeDndRecord(h.main);
  expect(manager.sessionIdFor('group', 'G1')).toBe('main');
  await h.router.dispose();
});

it('未开启 modelFailover 时，子代理提供商失败自动回退复用主会话模型路由（不继承异构 reasoningEffort、不交回主 DM），冷却期内新战直连主路由，主路由也失败才交回主 DM', async () => {
  const h = harness();
  (h.main.agent.session as { requestHeader?: () => unknown }).requestHeader = () => ({
    config: { provider: 'opencode-argon-native', model: 'gemini-4-argon' },
  });
  const fakeManager = Object.create(SessionManager.prototype) as SessionManager;
  const mainRoute = fakeManager.getEffectiveSessionRoute(h.main);
  expect(mainRoute).toEqual({ provider: 'opencode-argon-native', model: 'gemini-4-argon', reasoningEffort: null });

  h.setFallback({ mainRoute });
  const child1 = await h.router.select(h.main);
  const firstOpts = h.agents.create.mock.calls[0]![0] as { agentOptions?: { provider?: string; model?: string; reasoningEffort?: string } };
  expect(firstOpts.agentOptions).toMatchObject({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' });

  h.router.observe(child1, {
    type: 'turn/end',
    seq: 1,
    data: { reason: { kind: 'error', error: { code: 'QUOTA', message: 'primary quota exceeded' } } },
  });
  await vi.waitFor(() => expect(h.agents.create).toHaveBeenCalledTimes(2));

  const secondOpts = h.agents.create.mock.calls[1]![0] as { agentOptions?: { provider?: string; model?: string; reasoningEffort?: string } };
  expect(secondOpts.agentOptions).toEqual({ provider: 'opencode-argon-native', model: 'gemini-4-argon' });
  expect(secondOpts.agentOptions).not.toHaveProperty('reasoningEffort');
  expect(h.main.agent.followup).not.toHaveBeenCalled();
  expect(h.router.toolView(h.main)).toBe('waiting');
  expect(h.router.report(h.key)).toContain('opencode-argon-native/gemini-4-argon');
  expect(h.router.report(h.key)).toContain('已回退自：opencode-go/deepseek-v4.1-flash');

  // 冷却期内下一场新战斗直接复用主路由子代理，不再撞已失败的 opencode-go
  h.service.store.update(h.key, (c) => endInitiative(c));
  await h.router.select(h.main);
  vi.mocked(h.main.agent.followup).mockClear();
  h.service.store.update(h.key, (c) => startInitiative(c, () => 12));
  const child3 = await h.router.select(h.main);
  expect(child3).not.toBe(h.main);
  const thirdOpts = h.agents.create.mock.calls[2]![0] as { agentOptions?: { provider?: string; model?: string; reasoningEffort?: string } };
  expect(thirdOpts.agentOptions).toEqual({ provider: 'opencode-argon-native', model: 'gemini-4-argon' });

  // 若主路由在子代理内也报错，才交回主 DM
  h.router.observe(child3, {
    type: 'turn/end',
    seq: 2,
    data: { reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'main route 502' } } },
  });
  await vi.waitFor(() => expect(h.main.agent.followup).toHaveBeenCalledOnce());
  expect(h.agents.create).toHaveBeenCalledTimes(3);
  expect(h.router.toolView(h.main)).toBe('full');
  expect(JSON.stringify(vi.mocked(h.main.agent.followup).mock.calls)).toContain('main route 502');
  await h.router.dispose();
});

it('三级回退链（独立源 -> modelFailover 备用源 -> 主会话路由 -> 主 DM）跨两跳保留已发生战斗对话且不重复重试同路由', async () => {
  const h = harness();
  h.setFallback({
    backup: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
    mainRoute: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: null },
  });
  const child1 = await h.router.select(h.main);
  (child1.agent.session.events as unknown[]).push(
    { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '[系统 · 战斗接管] 第1轮开始' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第1轮：地精挥刀未中。' }] } } },
  );

  // 第 1 跳：独立源 -> modelFailover 备用源（同模型族保留 high）
  h.router.observe(child1, {
    type: 'turn/end',
    seq: 1,
    data: { reason: { kind: 'error', error: { code: 'QUOTA', message: 'quota 1' } } },
  });
  await vi.waitFor(() => expect(h.agents.create).toHaveBeenCalledTimes(2));
  const secondOpts = h.agents.create.mock.calls[1]![0] as { agentOptions?: { provider?: string; model?: string; reasoningEffort?: string } };
  expect(secondOpts.agentOptions).toMatchObject({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'high' });

  // 第 2 跳：备用源首轮即挂（未产生 assistant/message）-> 主会话路由，仍保留第1轮对话且去掉不兼容 reasoningEffort
  const child2 = h.router.current(h.key)!;
  h.router.observe(child2, {
    type: 'turn/end',
    seq: 2,
    data: { reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'backup 502' } } },
  });
  await vi.waitFor(() => expect(h.agents.create).toHaveBeenCalledTimes(3));
  const thirdOpts = h.agents.create.mock.calls[2]![0] as { agentOptions?: { provider?: string; model?: string; reasoningEffort?: string } };
  expect(thirdOpts.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' });
  expect(h.prompts.at(-1)!.text).toContain('第1轮：地精挥刀未中。');
  expect(h.main.agent.followup).not.toHaveBeenCalled();

  // 第 3 跳：主会话路由也失败 -> 交回主 DM，汇总三级失败原因且不再重试
  const child3 = h.router.current(h.key)!;
  h.router.observe(child3, {
    type: 'turn/end',
    seq: 3,
    data: { reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'main 503' } } },
  });
  await vi.waitFor(() => expect(h.main.agent.followup).toHaveBeenCalledOnce());
  expect(h.agents.create).toHaveBeenCalledTimes(3);
  const handoff = JSON.stringify(vi.mocked(h.main.agent.followup).mock.calls);
  expect(handoff).toContain('quota 1');
  expect(handoff).toContain('backup 502');
  expect(handoff).toContain('main 503');
  await h.router.dispose();
});

it('战斗子代理全程禁用宿主自动压缩/溢出摘要与插件侧自动压缩，dispose 后恢复原宿主方法', async () => {
  const h = harness();
  const innerCompact = vi.fn(async () => ({ shadowedSeqs: [1], shadowedRange: { start: 1, end: 1 }, shadowedTokenCount: 100 }));
  let stepTrigger!: (agent: DshAgent, trigger: string) => Promise<unknown>;
  class FakeCompaction extends Service {
    constructor(c: Context) {
      super(c, 'compaction');
      stepTrigger = (agent, trigger) => this.compactIfNeeded(agent, trigger);
    }
    async compactIfNeeded(agent: DshAgent, trigger: string): Promise<unknown> {
      return innerCompact(agent, trigger);
    }
  }
  const cordisCtx = new Context();
  cordisCtx.plugin(FakeCompaction as never);
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.router.installCompactionGuard(cordisCtx);

  const child = await h.router.select(h.main);
  expect(h.router.isCombatAgent(child.agent)).toBe(true);
  expect(h.router.isCombatAgent(h.main.agent)).toBe(false);

  // 通过 Cordis service internal `this.compactIfNeeded`（即 BasicCompactionEngine agent/pre-step 的实际调用路径）测试拦截
  expect(await stepTrigger(child.agent, 'pressure')).toBeNull();
  expect(await stepTrigger(child.agent, 'context-overflow')).toBeNull();
  expect(innerCompact).not.toHaveBeenCalled();

  // 主会话不受影响
  await stepTrigger(h.main.agent, 'pressure');
  expect(innerCompact).toHaveBeenCalledOnce();
  expect(innerCompact).toHaveBeenCalledWith(h.main.agent, 'pressure');

  // 插件侧 maybeAutoCompact 对子代理（含结束刚移出 active 后的尾轮竞争窗口）同样静默
  const compact = vi.fn();
  const fakeManager = {
    config: { autoCompactTokens: 1000, autoCompactPrivateRatio: 0.5, autoCompactDeferOnTools: false },
    sessions: new Map([[h.key, h.main]]),
    combatAgents: h.router,
    compact,
  };
  const childRec = { ...child, contextTokens: 500_000 } as SessionRecord;
  SessionManager.prototype.maybeAutoCompact.call(fakeManager as never, childRec);
  expect(compact).not.toHaveBeenCalled();

  h.service.store.update(h.key, (c) => endInitiative(c));
  h.router.observe(child, { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } });
  await vi.waitFor(() => expect(h.main.agent.followup).toHaveBeenCalledOnce());
  expect(h.router.isCombatAgent(child.agent)).toBe(true);
  expect(await stepTrigger(child.agent, 'pressure')).toBeNull();
  SessionManager.prototype.maybeAutoCompact.call(fakeManager as never, childRec);
  expect(compact).not.toHaveBeenCalled();

  // dispose 后完整撤销对宿主 compaction 实例的方法包装
  await h.router.dispose();
  innerCompact.mockClear();
  await stepTrigger(child.agent, 'pressure');
  expect(innerCompact).toHaveBeenCalledOnce();
});

it('pauseForSessionEnd 串行取消并释放战斗子代理、落盘 paused 状态并返回交接，但不重复唤醒主 DM', async () => {
  const h = harness();
  const child = await h.router.select(h.main);
  const res = await h.router.pauseForSessionEnd(h.key, () => {
    h.service.stop(h.key, undefined, { endPrepId: 'prep-x' });
  });
  expect(res).toBeDefined();
  expect(res!.main).toBe(h.main);
  expect(res!.handoff).toContain('团已暂停');
  expect(res!.handoff).toContain('dnd_prepare');
  expect(child.agent.cancel).toHaveBeenCalledWith({ kind: 'user', reason: 'dnd_end' });
  expect(h.children[0]!.dispose).toHaveBeenCalledOnce();
  expect(h.router.current(h.key)).toBeUndefined();
  expect(h.service.saved(h.key)!.campaign.initiative).toBeDefined();
  // 由 SessionManager.endDndSession 统一发送单次合并消息，pauseForSessionEnd 本身不调用 followup
  expect(h.main.agent.followup).not.toHaveBeenCalled();
});
