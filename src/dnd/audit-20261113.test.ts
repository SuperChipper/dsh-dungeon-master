import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { DND_COMBAT_AGENT_DEFAULTS } from '../config.ts';
import type { DshAgent, SessionRecord } from '../session/types.ts';
import { pendingReactionReply } from '../gateway/middleware-setup.ts';
import { AdventureLibrary, roomGraph } from './adventure.ts';
import { mapOf } from './battlefield.ts';
import { CampaignStore, findCharacter, requireCharacter, upsertCharacter } from './campaign.ts';
import { DndCombatAgents } from './combat-agent.ts';
import { combatPartyContext } from './combat-context.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { findRoom } from './dungeon.ts';
import { classifyReactionReply } from './pending-attack.ts';
import { narrativeTool, type DndToolDefinition } from './tool-views.ts';
import { ACK, DndTurnButtons, reactionOptionKey } from './turn-buttons.ts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
type Tool = DndToolDefinition & { execute(args: unknown, exec: { agent?: unknown; concludeTurn?: () => void }): Promise<{ text: string }> };

function createAuditHarness() {
  const rolls: number[] = [];
  const root = mkdtempSync(join(tmpdir(), 'dnd-audit-20261113-'));
  const service = new DndService({
    store: new CampaignStore(join(root, 'campaigns')),
    library: new AdventureLibrary(),
    mapDir: root,
    roller: () => rolls.shift() ?? 10,
  });
  const key = 'qqbot:app-audit:group:AUDIT';
  service.start(key, 'sunken-bell', false);
  const startRoom = service.active(key)!.campaign.currentRoom;
  service.store.update(key, (c) => {
    upsertCharacter(c, {
      name: '丛云',
      kind: 'pc',
      player: '雨云',
      playerId: 'U4',
      className: '战士（武士）5 / 邪术师（咒剑）1',
      level: 6,
      maxHp: 49,
      ac: 18,
      abilities: { str: 10, dex: 14, con: 14, int: 10, wis: 12, cha: 18 },
      weapons: [{ name: '长剑「Talon」+1（咒剑·草薙融合）', damage: '1d8', ability: 'dex', magic: 3 }],
      reactions: [{ name: '护盾术', when: 'attacked', resource: '契约法术位（1环）' }],
      notes: '半精灵武士5/咒剑1；专长：精灵精准 Elven Accuracy（敏捷/智力/感知/魅力优势攻击掷三颗d20取高）。',
    });
    const cy = requireCharacter(c, '丛云');
    cy.resources = {
      战斗英姿: { current: 3, max: 3, reset: 'long' },
      咒剑诅咒: { current: 1, max: 1, reset: 'short' },
      '契约法术位（1环）': { current: 1, max: 1, reset: 'short' },
    };

    upsertCharacter(c, {
      name: 'Kriv',
      kind: 'pc',
      player: 'tty',
      playerId: 'U2',
      className: '圣武士 2 / 吟游诗人 4',
      level: 6,
      maxHp: 52,
      ac: 19,
      reactions: [{ name: '尖刻言语', when: 'foe_attacks', resource: '诗人激励' }],
      notes: '长篇背景故事与未参战备注'.repeat(80),
    });
    const kriv = requireCharacter(c, 'Kriv');
    kriv.inventory = Array.from({ length: 20 }, (_, i) => `Kriv的装备_${i}`);
    kriv.resources = { 诗人激励: { current: 4, max: 4, reset: 'short' } };

    for (let i = 1; i <= 6; i++) {
      upsertCharacter(c, {
        name: `留守队员${i}`,
        kind: 'pc',
        playerId: `U1${i}`,
        level: 6,
        maxHp: 40,
        room: 'nave',
        notes: '港口留守长备注'.repeat(80),
      });
      requireCharacter(c, `留守队员${i}`).inventory = Array.from({ length: 15 }, (_, j) => `港口物资_${i}_${j}`);
    }

    upsertCharacter(c, {
      name: '牢爹',
      kind: 'monster',
      room: startRoom,
      maxHp: 229,
      ac: 17,
      attackBonus: 10,
      damage: '2d8+6',
    });
  });

  const mainAgent = {
    id: 'main',
    status: 'idle',
    ctx: { get: vi.fn() },
    session: { id: 'main', header: { cwd: root }, events: [] },
    followup: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  } as unknown as DshAgent;

  const main: SessionRecord = {
    sessionKey: key,
    sessionId: 'main',
    agent: mainAgent,
    handle: { agent: mainAgent, dispose: vi.fn(async () => {}) },
    scope: 'group',
    peerId: 'AUDIT',
    senderId: 'U4',
    recentSenders: [{ id: 'U4', at: Date.now() }, { id: 'U2', at: Date.now() }],
    lastActivity: Date.now(),
    replyTarget: { scope: 'group', targetId: 'AUDIT', msgId: 'M1' },
  };

  const settings = { ...DND_COMBAT_AGENT_DEFAULTS, enabled: true };
  const prompts: Array<{ text: string; complete: boolean; interpolate: boolean }> = [];
  const guards: Array<(exec: { name: string; arguments?: unknown }) => string | undefined> = [];
  const agents = {
    create: vi.fn(async (options: { sessionId?: string; setup?: (scope: unknown) => void }) => {
      const id = options.sessionId ?? 'child';
      const scope = {
        get: (name: string) => name === 'tools'
          ? { restrict: () => vi.fn(), guard: (g: typeof guards[number]) => guards.push(g) }
          : { section: (s: typeof prompts[number]) => prompts.push(s), context: vi.fn() },
      };
      await options.setup?.(scope);
      const agent = {
        ...mainAgent,
        id,
        ctx: scope,
        session: { id, events: [] },
        followup: vi.fn(),
        cancel: vi.fn(),
        whenIdle: vi.fn(async () => {}),
      } as unknown as DshAgent;
      return { agent, dispose: vi.fn(async () => {}) };
    }),
    resume: vi.fn(),
    get: vi.fn(),
  };

  const router = new DndCombatAgents(agents as never, service, () => settings, vi.fn(), logger, join(root, 'combat-runs'));
  const manager = {
    combatAgents: router,
    dndService: service,
    sessionKey: (_s: string, gid: string) => (gid === 'AUDIT' ? key : `group:${gid}`),
    getSessionRecord: () => main,
    routeDndRecord: async (r: SessionRecord) => router.select(r),
    sendDndFollowup: async (r: SessionRecord, msg: unknown) => (await router.select(r)).agent.followup(msg as never),
    findByAgent: (a: DshAgent) => router.findAgent(a) ?? (a === main.agent ? main : undefined),
  };

  const sender = { sendMarkdown: vi.fn(async () => {}) };
  const buttons = new DndTurnButtons(service, manager as never, sender, logger as never);
  const tools = new Map<string, Tool>();
  registerDndTools(
    { get: () => ({ register: (d: Tool) => tools.set(d.name, d) }) } as never,
    {
      service,
      manager: manager as never,
      logger: logger as never,
      sendImage: vi.fn(async () => {}),
      onCombatStart: (record, field) => router.startAfterReply(record, field) !== undefined,
    },
  );

  let eventSeq = 0;
  const press = (data: { a: string; r: number; i?: number }, clicker: string) => {
    const c = service.store.load(key)!;
    const pending = c.initiative?.pending ?? c.initiative?.movement;
    const option = pending?.reactors[data.i ?? -1];
    return buttons.handleInteraction({
      id: `evt-${++eventSeq}`,
      type: 11,
      version: 1,
      group_openid: 'AUDIT',
      group_member_openid: clicker,
      data: {
        type: 11,
        resolved: {
          button_data: JSON.stringify({
            t: 'dnd',
            ...(data.a === 'react' && option ? { o: reactionOptionKey(option) } : {}),
            ...data,
          }),
        },
      },
    } as InteractionEvent);
  };

  return { rolls, root, service, key, startRoom, main, router, manager, buttons, tools, prompts, press };
}

describe('2026-11-13 D&D 跑团审计五项回归验证', () => {
  it('问题1 & 问题4：规则提醒不授权反应，点击「不用」后拦截强行扣位；未参战同房间角色不进反应窗口', async () => {
    const h = createAuditHarness();
    // 仅「丛云」与「牢爹」参战；同房间的 Kriv 未参战
    h.rolls.push(1, 18); // 先攻：丛云 1+2=3，牢爹 18+0=18（牢爹先手）
    const narrativeStart = narrativeTool(h.tools.get('dnd_initiative')!)!;
    await narrativeStart.execute({ action: 'start', participants: ['丛云', '牢爹'] }, { agent: h.main.agent } as never);
    const child = await h.router.select(h.main);
    const call = (name: string, args: Record<string, unknown>) =>
      h.tools.get(name)!.execute(args, { agent: child.agent });

    // 牢爹攻击丛云：12 + 10 = 22 vs AC 18 命中，只应弹出「丛云·护盾术」，绝不应出现同房间未参战的「Kriv·尖刻言语」
    h.rolls.push(12, 4, 5);
    const atkText = (await call('dnd_check', { type: 'attack', character: '牢爹', target: '丛云' })).text;
    expect(atkText).toContain('丛云·护盾术');
    expect(atkText).not.toContain('Kriv');

    const pendingBefore = h.service.store.load(h.key)!.initiative!.pending!;
    expect(pendingBefore.reactors.map((r) => r.character)).toEqual(['丛云']);

    // 手动 ask_reactions 也拒绝把未参战角色塞进窗口
    await expect(call('dnd_apply', { target: '丛云', ask_reactions: [{ by: 'Kriv', name: '尖刻言语' }] }))
      .rejects.toThrow(/不在当前战斗的参战名单/);

    // 19:05:57 玩家说「护盾术持续一回合的」——必须识别为规则提醒/讨论，不生成授权，也不污染撤销快照
    const snapCountBeforeQuestion = h.service.store.snapshots(h.key).length;
    const replyNotice = pendingReactionReply(
      { kind: 'group', groupOpenid: 'AUDIT', senderId: 'U4', messageId: 'MSG-190557', content: '护盾术持续一回合的' } as never,
      h.manager as never,
      true,
    );
    expect(replyNotice?.note).toContain('反应讨论');
    expect(h.service.store.load(h.key)!.initiative!.pending!.claimed).toEqual([]);
    expect(h.service.store.snapshots(h.key).length).toBe(snapCountBeforeQuestion);

    // 角色名前缀明确同意与明确带技能拒绝的分类边界
    const currentCampaign = h.service.store.load(h.key)!;
    expect(classifyReactionReply(currentCampaign, 'U4', '丛云 护盾术')).toMatchObject({
      kind: 'use',
      choices: [{ character: '丛云', reaction: '护盾术' }],
    });
    expect(classifyReactionReply(currentCampaign, 'U4', '不用护盾术')).toMatchObject({
      kind: 'decline',
      characters: ['丛云'],
    });

    // 19:06:02 玩家点击「不用」按钮
    expect(h.press({ a: 'pass', r: pendingBefore.seq }, 'U4')).toBe(ACK.ok);
    expect(h.service.store.load(h.key)!.initiative!.pending!.declined).toContain('丛云');

    // 19:06:15 模型仍试图带 declared_by=U4 强行施放护盾术扣契约法术位 -> 执行层必须硬拦截！
    await expect(call('dnd_apply', {
      target: '丛云',
      declared_by: 'U4',
      reaction: { by: '丛云', name: '护盾术', ac_mod: 5, spend: '契约法术位（1环）' },
      settle: true,
    })).rejects.toThrow(/已选择不用|authorization/);

    const cyAfter = requireCharacter(h.service.store.load(h.key)!, '丛云');
    expect(cyAfter.resources!['契约法术位（1环）']!.current).toBe(1);
    expect(h.service.store.load(h.key)!.initiative!.reacted ?? []).not.toContain('丛云');
  });

  it('问题4：战斗交接上下文裁剪非参战角色的冗长背包与背景备注', () => {
    const h = createAuditHarness();
    h.service.store.update(h.key, (c) => {
      c.initiative = { round: 1, turn: 0, order: [{ name: '丛云', init: 18 }, { name: '牢爹', init: 12 }] };
    });
    const ctx = combatPartyContext(h.service.store.load(h.key)!);
    expect(ctx).toContain('备注里的职业被动、专长与临时效果不会被程序自动识别');
    const cards = JSON.parse(ctx.split('\n').at(-1)!) as Array<Record<string, unknown>>;
    const cy = cards.find((x) => x.name === '丛云')!;
    const kriv = cards.find((x) => x.name === 'Kriv')!;
    const away = cards.find((x) => x.name === '留守队员1')!;
    expect(cy.participating).toBe(true);
    expect(cy.notes).toContain('精灵精准');
    // 同房间未参战者保留参战标记与基础属性，但不注入长篇 notes / inventory / resources
    expect(kriv.participating).toBe(false);
    expect(kriv.notes).toBeUndefined();
    expect(kriv.inventory).toBeUndefined();
    expect(kriv.resources).toBeUndefined();
    // 异地未参战者仅保留最小状态摘要
    expect(away).toMatchObject({ name: '留守队员1', participating: false, room: 'nave' });
    expect(away.abilities).toBeUndefined();
    expect(away.inventory).toBeUndefined();
    expect(ctx.length).toBeLessThan(4000);
  });

  it('问题3：咒剑诅咒（天然19重击 + 熟练加伤去重 + 击杀回血）、战斗英姿（临时HP + 本回合优势）与精灵精准（3d20取高）联动', async () => {
    const h = createAuditHarness();
    h.service.store.update(h.key, (c) => {
      requireCharacter(c, '丛云').hp = 30; // 先受过伤，便于验证咒剑击杀回血与临时HP分开计入
      // 移除丛云的护盾术避免牢爹反击时挂起窗口干扰本用例
      requireCharacter(c, '丛云').reactions = [];
      c.initiative = { round: 1, turn: 0, order: [{ name: '丛云', init: 20 }, { name: '牢爹', init: 10 }] };
    });
    const child = await h.router.select(h.main);
    const call = (name: string, args: Record<string, unknown>) =>
      h.tools.get(name)!.execute(args, { agent: child.agent });

    // 1) 场上只有「牢爹」一个敌方时，dnd_resource use 咒剑诅咒自动绑定目标
    const curseRes = (await call('dnd_resource', { action: 'use', character: '丛云', resource: '咒剑诅咒' })).text;
    expect(curseRes).toContain('已对「牢爹」施加咒剑诅咒');
    expect(curseRes).toContain('19-20 重击');

    // 2) 使用第1次战斗英姿：自动给 5 点临时 HP，并开启本回合武器攻击优势 + 精灵精准
    const fs1 = (await call('dnd_resource', { action: 'use', character: '丛云', resource: '战斗英姿' })).text;
    expect(fs1).toContain('获得 5 点临时 HP');
    expect(requireCharacter(h.service.store.load(h.key)!, '丛云').tempHp).toBe(5);

    // 3) 丛云出剑（即使模型重复传了 damage="3"，工具自动去重不双算 +6；三骰 [4, 19, 11] 取 19 触发咒剑重击 2d8+5+3）
    h.rolls.push(4, 19, 11, 6, 7); // 3d20=[4,19,11]->19 重击！伤害 2d8=[6,7]+5(dex2+magic3)+3(咒剑)=21
    const atk1 = (await call('dnd_check', {
      type: 'attack',
      character: '丛云',
      target: '牢爹',
      weapon: '长剑「Talon」+1（咒剑·草薙融合）',
      damage: '3',
      damage_type: '挥砍',
      declared_by: 'U4',
    })).text;
    expect(atk1).toContain('d20精灵精准[4,19,11→19]');
    expect(atk1).toContain('重击！');
    expect(atk1).toContain('= 21');
    expect(requireCharacter(h.service.store.load(h.key)!, '牢爹').hp).toBe(229 - 21);

    // 4) 推进到下一轮：战斗英姿的本回合优势自动清除；打掉临时 HP 后再次使用战斗英姿，仍准确获得 5 点临时 HP
    await call('dnd_initiative', { action: 'next', declared_by: 'U4' });
    await call('dnd_apply', { target: '丛云', damage: 5 }); // 吸收掉 5 点临时 HP
    expect(requireCharacter(h.service.store.load(h.key)!, '丛云').tempHp).toBe(0);
    await call('dnd_initiative', { action: 'next' }); // 回到第 2 轮丛云回合
    expect(h.service.store.load(h.key)!.initiative!.fightingSpirit).toBeUndefined();

    await call('dnd_resource', { action: 'use', character: '丛云', resource: '战斗英姿' });
    expect(requireCharacter(h.service.store.load(h.key)!, '丛云').tempHp).toBe(5);

    // 5) 斩杀被诅咒的牢爹：自动触发邪术师等级(1) + 魅力调整值(+4) = 5 HP 治疗（30 -> 35）
    h.service.store.update(h.key, (c) => { requireCharacter(c, '牢爹').hp = 10; });
    h.rolls.push(15, 19, 8, 5, 5); // 19 重击斩杀
    await call('dnd_check', {
      type: 'attack',
      character: '丛云',
      target: '牢爹',
      weapon: '长剑「Talon」+1（咒剑·草薙融合）',
      declared_by: 'U4',
    });
    const cyFinal = requireCharacter(h.service.store.load(h.key)!, '丛云');
    expect(cyFinal.hp).toBe(35);
    expect(h.service.store.load(h.key)!.hexbladeCurses).toBeUndefined();
  });

  it('问题2：子代理多轮自动对砍并通过 concludeTurn 直接收尾时，交接完整携带未播报回合账本与存活敌方精确 HP', async () => {
    const h = createAuditHarness();
    h.service.store.update(h.key, (c) => {
      requireCharacter(c, '丛云').reactions = [];
      c.initiative = { round: 1, turn: 0, order: [{ name: '丛云', init: 20 }, { name: '牢爹', init: 10 }] };
    });
    const child = await h.router.select(h.main);
    const concludeTurn = vi.fn();
    const call = (name: string, args: Record<string, unknown>) =>
      h.tools.get(name)!.execute(args, { agent: child.agent, concludeTurn });

    // 第 1~2 轮：子 DM 发过最后一条叙述「坐骑先留在入口外。」
    await call('dnd_check', { type: 'attack', character: '丛云', target: '牢爹', weapon: '长剑「Talon」+1（咒剑·草薙融合）', declared_by: 'U4' });
    await call('dnd_initiative', { action: 'next', declared_by: 'U4' });
    await call('dnd_initiative', { action: 'next' }); // 进入第 2 轮
    h.router.observe(child, {
      type: 'assistant/message',
      seq: 1,
      data: { message: { source: { provider: 'test', model: 'flash' }, content: [{ type: 'text', text: '坐骑先留在入口外，你们准备继续交锋。' }] } },
    });

    // 第 3~10 轮：全部通过工具自动对砍推进，没有再发群消息，第 10 轮牢爹剩 30/229 HP、丛云倒地后直接 end
    for (let targetRound = 3; targetRound <= 10; targetRound++) {
      await call('dnd_initiative', { action: 'next', declared_by: 'U4' });
      await call('dnd_initiative', { action: 'next' });
      h.rolls.push(16, 6);
      await call('dnd_check', {
        type: 'attack',
        character: '丛云',
        target: '牢爹',
        weapon: '长剑「Talon」+1（咒剑·草薙融合）',
        declared_by: 'U4',
      });
    }
    h.service.store.update(h.key, (c) => { requireCharacter(c, '牢爹').hp = 30; });
    await call('dnd_apply', { target: '丛云', damage: 60 }); // 丛云 0 HP 昏迷倒地
    const endRes = await call('dnd_initiative', { action: 'end' });
    expect(concludeTurn).not.toHaveBeenCalled();
    expect(endRes.text).toContain('【收尾播报】');
    expect(endRes.text).toContain('共 10 轮');
    expect(endRes.text).toContain('仍存活敌方：牢爹');

    h.router.observe(child, { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } });
    await vi.waitFor(() => expect(h.main.agent.followup).toHaveBeenCalledOnce());
    const handoffText = (vi.mocked(h.main.agent.followup).mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0]!.text;

    expect(handoffText).toContain('【本场战斗结果摘要】共 10 轮');
    expect(handoffText).toContain('牢爹 HP 30/229');
    expect(handoffText).toContain('本场倒地/阵亡我方：丛云');
    expect(handoffText).toContain('【未向群内播报的战斗账本');
    expect(handoffText).toContain('第 3 轮：');
    expect(handoffText).toContain('第 10 轮：');
    expect(handoffText).not.toContain('第 1 轮：');
    expect(handoffText).toContain('第 2 轮）');
    // 不应再把未参战角色的冗长背包重复塞入交接
    expect(handoffText).not.toContain('港口物资_1_0');
  });

  it('问题5：梦境/演练模式（rehearsal=true）超过 40 步仍保住开战快照，结束时自动清理 14×14 灰雾石墙并还原人物与账本', async () => {
    const h = createAuditHarness();
    // 演练前真实状态：丛云 24/49 HP，战斗英姿剩 2/3，入口房间没有自定义场地图
    h.service.store.update(h.key, (c) => {
      const cy = requireCharacter(c, '丛云');
      cy.hp = 24;
      cy.resources!['战斗英姿']!.current = 2;
      cy.reactions = [];
    });
    const chronicleBefore = structuredClone(h.service.store.load(h.key)!.chronicle);
    expect(mapOf(h.service.store.load(h.key)!, h.startRoom)).toBeUndefined();

    // 主 DM 通过受限 narrative 视图开启梦境演练：梦中满血 49 HP，牢爹为梦境临时怪物
    const narrativeStart = narrativeTool(h.tools.get('dnd_initiative')!)!;
    const startRes = await narrativeStart.execute({
      action: 'start',
      participants: ['丛云', '牢爹'],
      rehearsal: true,
      rehearsal_hp: { 丛云: 49 },
      temporary_monsters: ['牢爹'],
    }, { agent: h.main.agent } as never) as { text: string };
    expect(startRes.text).toContain('【演练模式】');
    expect(requireCharacter(h.service.store.load(h.key)!, '丛云').hp).toBe(49);

    const child = await h.router.select(h.main);
    const call = (name: string, args: Record<string, unknown>) =>
      h.tools.get(name)!.execute(args, { agent: child.agent });

    // 梦境中铺设 14×14 四面灰雾石墙
    await call('dnd_position', {
      action: 'terrain',
      room: h.startRoom,
      width: 14,
      height: 14,
      areas: [
        { kind: 'wall', x: 0, y: 0, w: 14, name: '灰雾石墙' },
        { kind: 'wall', x: 0, y: 13, w: 14, name: '灰雾石墙' },
        { kind: 'wall', x: 0, y: 1, h: 12, name: '灰雾石墙' },
        { kind: 'wall', x: 13, y: 1, h: 12, name: '灰雾石墙' },
      ],
    });
    expect(mapOf(h.service.store.load(h.key)!, h.startRoom)?.width).toBe(14);

    // 连续执行 45 次工具更新（超过 MAX_SNAPSHOTS=40），验证开战快照受保护不会被挤掉
    for (let i = 0; i < 45; i++) {
      await call('dnd_apply', { target: '丛云', damage: 1 });
    }
    const historyLabels = h.service.store.snapshots(h.key).map((s) => s.label);
    expect(historyLabels.some((l) => /\bdnd_initiative\b.*\baction=start\b/.test(l))).toBe(true);

    // 梦境中耗光战斗英姿并被打至死亡，验证永久 chronicle 不记假死讯
    await call('dnd_resource', { action: 'use', character: '丛云', resource: '战斗英姿' });
    await call('dnd_apply', { target: '丛云', damage: 200 });
    expect(requireCharacter(h.service.store.load(h.key)!, '丛云').conditions).toContain('死亡');
    expect(h.service.store.load(h.key)!.chronicle).toEqual(chronicleBefore);

    // 结束梦境演练：自动还原丛云 24/49 HP、战斗英姿 2/3、清除房间 14×14 灰雾石墙、移除临时怪物牢爹
    const endRes = await call('dnd_initiative', { action: 'end' });
    expect(endRes.text).toContain('【演练还原】');
    h.router.observe(child, { type: 'turn/end', seq: 10, data: { reason: { kind: 'completed' } } });
    await vi.waitFor(() => expect(h.main.agent.followup).toHaveBeenCalledOnce());
    const rehearsalHandoff = (vi.mocked(h.main.agent.followup).mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0]!.text;
    expect(rehearsalHandoff).toContain('梦境/演练模式，战后已自动还原真实状态与地图');
    expect(rehearsalHandoff).toContain('【演练已自动还原】');

    const after = h.service.store.load(h.key)!;
    const cyRestored = requireCharacter(after, '丛云');
    expect(cyRestored.hp).toBe(24);
    expect(cyRestored.maxHp).toBe(49);
    expect(cyRestored.conditions).toEqual([]);
    expect(cyRestored.resources!['战斗英姿']!.current).toBe(2);
    expect(mapOf(after, h.startRoom)).toBeUndefined();
    expect(findCharacter(after, '牢爹')).toBeUndefined();
    expect(after.chronicle).toEqual(chronicleBefore);

    // 同时验证手动 dnd_position clear_terrain：临时画图可手动清理，若有模组预设地图则恢复预设
    await h.tools.get('dnd_position')!.execute({
      action: 'terrain',
      room: h.startRoom,
      width: 10,
      height: 10,
      areas: [{ kind: 'wall', x: 0, y: 0, w: 10, name: '临时墙' }],
    }, { agent: h.main.agent });
    expect(mapOf(h.service.store.load(h.key)!, h.startRoom)).toBeDefined();
    const clearRes = await h.tools.get('dnd_position')!.execute({
      action: 'clear_terrain',
      room: h.startRoom,
    }, { agent: h.main.agent });
    const authored = findRoom(roomGraph(h.service.library.get('sunken-bell')!), h.startRoom)?.battlemap;
    if (authored === undefined) {
      expect(clearRes.text).toContain('已清除');
      expect(mapOf(h.service.store.load(h.key)!, h.startRoom)).toBeUndefined();
    } else {
      expect(clearRes.text).toContain('恢复模组预设场地图');
      expect(mapOf(h.service.store.load(h.key)!, h.startRoom)).toEqual(authored);
    }
  });

  it('问题4延伸：旁观/异地队友中途入战（dnd_initiative join）校验挂起窗口、补齐精简掉的完整能力卡、支持先攻加值与演练还原、立即解锁反应窗口', async () => {
    const h = createAuditHarness();
    h.service.store.update(h.key, (c) => {
      requireCharacter(c, 'Kriv').hp = 20;
      upsertCharacter(c, {
        name: '场外守卫',
        kind: 'npc',
        room: h.startRoom,
        maxHp: 30,
        ac: 15,
        attackBonus: 5,
        damage: '1d8+3',
      });
    });

    // 开战：只有牢爹与丛云参战（且开启演练模式），Kriv 同房旁观，留守队员1 在异地房间
    h.rolls.push(18, 8); // 牢爹先动，丛云后动
    await h.tools.get('dnd_initiative')!.execute({
      action: 'start',
      participants: ['牢爹', '丛云'],
      rehearsal: true,
      rehearsal_hp: { 丛云: 49 },
      temporary_monsters: ['牢爹'],
    }, { agent: h.main.agent });
    const child = await h.router.select(h.main);
    const call = (name: string, args: Record<string, unknown>) =>
      h.tools.get(name)!.execute(args, { agent: child.agent });

    await call('dnd_position', {
      action: 'set',
      placements: [
        { name: '牢爹', x: 5, y: 5 },
        { name: '丛云', x: 6, y: 5 },
        { name: 'Kriv', x: 7, y: 5 },
        { name: '场外守卫', x: 5, y: 6 },
      ],
    });

    // 1) 未入战前：主动行动报错明确提示先 dnd_initiative action=join；场外 NPC 也不能偷打反应攻击
    await expect(call('dnd_check', {
      character: 'Kriv',
      type: 'attack',
      target: '牢爹',
      damage: '1d8+3',
      declared_by: 'U2',
    })).rejects.toThrow(/还不在先攻表里.*dnd_initiative action=join/);

    await expect(call('dnd_check', {
      character: '场外守卫',
      type: 'attack',
      target: '牢爹',
      reaction: true,
    })).rejects.toThrow(/不在当前战斗的参战名单（先攻表）里，不能发动反应攻击/);

    // 2) 牢爹攻击丛云挂起护盾术窗口期间，禁止中途 join 篡改先攻指针；且此刻 Kriv 不在反应名单中
    h.rolls.push(10, 4, 4); // 10+10=20 vs AC 18 命中，挂起丛云护盾术
    await call('dnd_check', { character: '牢爹', type: 'attack', target: '丛云' });
    expect(h.service.store.load(h.key)!.initiative!.pending!.reactors.map((r) => r.character)).toEqual(['丛云']);
    await expect(call('dnd_initiative', {
      action: 'join',
      participants: ['Kriv'],
    })).rejects.toThrow(/还有一笔待结算.*先不能加入战斗/);

    // 结算挂起攻击后，Kriv 与留守队员1 中途参战（支持 bonus 临时先攻骰与演练临时血量）
    await call('dnd_apply', { target: '丛云', decline: ['丛云'], settle: true });
    h.rolls.push(12, 6, 4); // Kriv: d20=12 + bonus 1d8=6；留守队员1: d20=4
    const joinRes = await call('dnd_initiative', {
      action: 'join',
      participants: ['Kriv', '留守队员1'],
      bonus: { Kriv: '1d8' },
      rehearsal_hp: { Kriv: 52 },
    });

    expect(joinRes.text).toContain('Kriv');
    expect(joinRes.text).toContain('1d8');
    // 开战快照曾精简 Kriv 的 notes/resources/inventory 与留守队员1 的完整卡面，join 返回值立即补齐
    expect(joinRes.text).toContain('【新入战我方能力卡（开战快照曾精简，以此完整卡为准）】');
    expect(joinRes.text).toContain('诗人激励');
    expect(joinRes.text).toContain('Kriv的装备_0');
    expect(joinRes.text).toContain('港口物资_1_0');
    expect(requireCharacter(h.service.store.load(h.key)!, 'Kriv').hp).toBe(52);

    // 3) 入战后无需重开战斗，下一次怪物攻击立即对 Kriv 开放尖刻言语反应窗口！
    h.rolls.push(10, 4, 4);
    await call('dnd_check', { character: '牢爹', type: 'attack', target: '丛云' });
    const reactorsAfterJoin = h.service.store.load(h.key)!.initiative!.pending!.reactors;
    expect(reactorsAfterJoin).toEqual(expect.arrayContaining([
      expect.objectContaining({ character: 'Kriv', reaction: '尖刻言语' }),
    ]));

    // 结算窗口后轮到 Kriv，消耗一次诗人激励并受伤，验证演练结束时中途入战的 Kriv 也会还原回真实的 20/52 HP 与满诗人激励
    await call('dnd_apply', { target: '丛云', decline: ['丛云', 'Kriv'], settle: true });
    await call('dnd_initiative', { action: 'goto', name: 'Kriv' });
    await call('dnd_resource', { action: 'use', character: 'Kriv', resource: '诗人激励', declared_by: 'U2' });
    await call('dnd_apply', { target: 'Kriv', damage: 15 });
    expect(requireCharacter(h.service.store.load(h.key)!, 'Kriv').hp).toBe(37);

    await call('dnd_initiative', { action: 'end' });
    const after = h.service.store.load(h.key)!;
    expect(after.lastCombat?.participants).toEqual(expect.arrayContaining(['牢爹', '丛云', 'Kriv', '留守队员1']));
    const krivRestored = requireCharacter(after, 'Kriv');
    expect(krivRestored.hp).toBe(20);
    expect(krivRestored.maxHp).toBe(52);
    expect(krivRestored.resources!['诗人激励']!.current).toBe(4);
  });
});
