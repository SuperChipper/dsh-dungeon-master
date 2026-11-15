import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { AdventureLibrary } from './adventure.ts';
import { type Campaign, CampaignStore, findCharacter, playerStatus, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { chooseReaction, classifyReactionReply, eligibleReactors, recordReactionReply, reactionReplyNote, reactionsOf } from './pending-attack.ts';
import { ACK, DndTurnButtons, buildReactionKeyboard, reactionOptionKey } from './turn-buttons.ts';
import { encodeButtonData } from '../features/button-utils.ts';
import { pendingReactionReply } from '../gateway/middleware-setup.ts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };

/** rolls 里按顺序给骰子，给完了都是 10 */
function setup() {
  const rolls: number[] = [];
  const root = mkdtempSync(join(tmpdir(), 'dnd-pending-'));
  const service = new DndService({
    store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root, roller: () => rolls.shift() ?? 10,
  });
  const key = 'group:G1';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: 'Kriv', player: 'tty', playerId: 'P2', maxHp: 20, ac: 16, reactions: [{ name: '尖刻言语', when: 'foe_attacks', resource: '诗人激励' }, { name: '护盾术', when: 'attacked', resource: '防御法杖充能' }] });
    upsertCharacter(c, { name: '刻德温', player: 'kis', playerId: 'P4', maxHp: 25, ac: 20, weapons: [{ name: '银锤', damage: '1d8' }], reactions: [{ name: '导引打击', when: 'attacking', resource: '引导神力' }] });
    upsertCharacter(c, { name: '卡厄斯', player: 'cha', playerId: 'P3', maxHp: 29, ac: 18 });
    upsertCharacter(c, { name: '狼', kind: 'monster', maxHp: 30, ac: 13, attackBonus: 6, damage: '1d6+4', room: c.currentRoom });
    const kriv = c.characters.find((x) => x.name === 'Kriv')!;
    kriv.resources = { 诗人激励: { current: 3, max: 3, reset: 'short' }, 防御法杖充能: { current: 2, max: 2, reset: 'long' } };
    c.characters.find((x) => x.name === '刻德温')!.resources = { 引导神力: { current: 1, max: 1, reset: 'short' } };
    c.initiative = { round: 1, turn: 0, order: [{ name: '狼', init: 20 }, { name: 'Kriv', init: 15 }, { name: '刻德温', init: 12 }, { name: '卡厄斯', init: 5 }] };
  });

  const followup = vi.fn();
  const record = {
    sessionKey: key, scope: 'group', peerId: 'G1', replyTarget: { scope: 'group', targetId: 'G1' },
    recentSenders: [{ id: 'P2', at: Date.now() }, { id: 'P4', at: Date.now() }, { id: 'P3', at: Date.now() }],
    agent: { followup, whenIdle: () => Promise.resolve() },
  };
  const manager = { sessionKey: (_s: string, gid: string) => `group:${gid}`, getSessionRecord: () => record, findByAgent: () => record, dndService: service };
  const sender = { sendMarkdown: vi.fn(() => Promise.resolve()) };
  const buttons = new DndTurnButtons(service, manager as never, sender, logger as never);
  const tools = new Map<string, Tool>();
  const ctx = { get: () => ({ register: (d: Tool) => tools.set(d.name, d) }) };
  const onPendingAttack = vi.fn();
  registerDndTools(ctx as never, { service, manager: manager as never, logger: logger as never, sendImage: vi.fn(), onPendingAttack });
  const call = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.execute(args, { agent: {} })).text;
  const campaign = (): Campaign => service.store.load(key)!;
  const consent = (by: string, skill: string): string => service.store.update(key, (c) => {
    const p = c.initiative!.pending ?? c.initiative!.movement!;
    const existing = p.claimed.find((r) => r.character === by && r.reaction === skill)?.authorization;
    return existing ?? chooseReaction(c, p, c.characters.find((ch) => ch.name === by)!.playerId!, by, skill)!.authorization!;
  }, '测试：玩家本人明确选择');
  const hp = (name: string): number => findCharacter(campaign(), name)!.hp;
  const biteKriv = (): Promise<string> => call('dnd_check', { type: 'attack', character: '狼', target: 'Kriv' });
  let eventId = 0;
  const press = (data: { a?: string; i?: number }, clicker: string): number | undefined => {
    const option = (campaign().initiative?.pending ?? campaign().initiative?.movement)?.reactors[data.i ?? -1];
    return buttons.handleInteraction({
      id: `e${++eventId}`, type: 11, version: 1, group_openid: 'G1', group_member_openid: clicker,
      data: { type: 11, resolved: { button_data: JSON.stringify({ t: 'dnd', ...(data.a === 'react' && option ? { o: reactionOptionKey(option) } : {}), ...data }) } },
    } as InteractionEvent);
  };
  return { consent, rolls, service, key, call, campaign, hp, biteKriv, press, buttons, followup, sender, record, manager, onPendingAttack };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('攻击先算后结', () => {
  it('有人能反应时只掷骰、不扣血，返回值自带别往下推进，并触发窗口', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    const text = await t.biteKriv();
    expect(text).toContain('命中');
    expect(text).toContain('伤害（还没扣）');
    expect(text).toContain('这笔还没落账，别往下推进');
    expect(text).toContain('Kriv·尖刻言语');
    expect(t.hp('Kriv')).toBe(20);
    expect(t.campaign().initiative!.pending).toMatchObject({ attacker: '狼', target: 'Kriv', total: 21, rawDamage: 7 });
    expect(t.onPendingAttack).toHaveBeenCalledTimes(1);
  });

  it('没人能反应就和以前一样直接扣血', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => { c.characters.find((x) => x.name === 'Kriv')!.reactions = []; });
    t.rolls.push(15, 3);
    const text = await t.biteKriv();
    expect(text).not.toContain('待结算');
    expect(t.hp('Kriv')).toBe(13);
    expect(t.campaign().initiative!.pending).toBeUndefined();
  });

  it('没中、天然 1 不停下；不在战斗中不挂起', async () => {
    const t = setup();
    t.rolls.push(2);
    expect(await t.biteKriv()).not.toContain('待结算');
    t.rolls.push(1);
    expect(await t.biteKriv()).not.toContain('待结算');
    t.service.store.update(t.key, (c) => { c.initiative = undefined; });
    t.rolls.push(15, 3);
    expect(await t.biteKriv()).not.toContain('待结算');
    expect(t.hp('Kriv')).toBe(13);
  });

  it('hold=true 可以手动挂起（DM 操作的 NPC、怪物反应）', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => { c.characters.find((x) => x.name === 'Kriv')!.reactions = []; });
    t.rolls.push(15, 3);
    expect(await t.call('dnd_check', { type: 'attack', character: '狼', target: 'Kriv', hold: true })).toContain('待结算');
    expect(t.hp('Kriv')).toBe(20);
    expect((await t.call('dnd_apply', { target: 'Kriv', settle: true }))).toContain('受 7');
  });

  it('落账前推进、再攻击、豁免效果、移动、结束战斗都被拒绝', async () => {
    const t = setup();
    await t.call('dnd_position', { action: 'set', placements: [{ name: '狼', x: 0, y: 0 }, { name: 'Kriv', x: 1, y: 0 }] });
    t.rolls.push(15, 3);
    await t.biteKriv();
    await expect(t.call('dnd_initiative', { action: 'next' })).rejects.toThrow(/待结算/);
    await expect(t.call('dnd_initiative', { action: 'goto', name: 'Kriv' })).rejects.toThrow(/待结算/);
    await expect(t.call('dnd_initiative', { action: 'end' })).rejects.toThrow(/待结算/);
    await expect(t.biteKriv()).rejects.toThrow(/待结算/);
    await expect(t.call('dnd_check', { type: 'save', character: '狼', ability: '敏捷', dc: 12, damage: '1d6', targets: [{ name: 'Kriv' }] })).rejects.toThrow(/待结算/);
    await expect(t.call('dnd_move', { room: 'nave', who: ['狼'], dm_override: true })).rejects.toThrow(/待结算/);
    await expect(t.call('dnd_position', { action: 'move', name: '狼', x: 3, y: 3 })).rejects.toThrow(/待结算/);
  });

  it('被拒绝的调用不改状态：资源没扣、待结算还在', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    const before = t.campaign().initiative!.pending;
    await expect(t.call('dnd_initiative', { action: 'next' })).rejects.toThrow();
    expect(t.campaign().initiative!.pending).toEqual(before);
  });

  it('还有人没答复时不能落账，过多久都一样；DM 传 decline 替他跳过才行', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    await expect(t.call('dnd_apply', { target: 'Kriv', settle: true })).rejects.toThrow(/不限时/);
    t.service.store.update(t.key, (c) => { c.initiative!.pending!.at -= 3_600_000; });
    await expect(t.call('dnd_apply', { target: 'Kriv', settle: true })).rejects.toThrow(/反应窗口还开着/);
    expect(t.hp('Kriv')).toBe(20);
    const text = await t.call('dnd_apply', { target: 'Kriv', decline: ['Kriv'], settle: true });
    expect(text).toContain('受 7');
    expect(t.hp('Kriv')).toBe(13);
    expect(t.campaign().initiative!.pending).toBeUndefined();
  });

  it('target 对不上、没有待结算时报错', async () => {
    const t = setup();
    await expect(t.call('dnd_apply', { target: 'Kriv', settle: true })).rejects.toThrow(/没有待结算/);
    t.rolls.push(15, 3);
    await t.biteKriv();
    await expect(t.call('dnd_apply', { target: '狼', settle: true })).rejects.toThrow(/打的是 Kriv/);
    await expect(t.call('dnd_apply', { target: 'Kriv', decline: ['卡厄斯'] })).rejects.toThrow(/不在这笔/);
  });

  it('cancel 作废不扣血；dnd_undo 能退回挂起之前', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    await t.call('dnd_apply', { target: 'Kriv', cancel: true });
    expect(t.hp('Kriv')).toBe(20);
    expect(t.campaign().initiative!.pending).toBeUndefined();
    t.rolls.push(15, 3);
    await t.biteKriv();
    await t.call('dnd_undo', { action: 'undo', steps: 1 });
    expect(t.campaign().initiative!.pending).toBeUndefined();
  });

  it('普通的 dnd_apply 扣血不受影响', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    expect(await t.call('dnd_apply', { target: '卡厄斯', damage: 2 })).toContain('27');
    expect(t.campaign().initiative!.pending).toBeDefined();
  });
});

describe('反应改数值', () => {
  it('尖刻言语减攻击：命中变未命中，资源扣了，不扣血', async () => {
    const t = setup();
    t.rolls.push(10, 3); // 10+6=16，刚好命中 AC 16
    await t.biteKriv();
    t.rolls.push(2);
    const text = await t.call('dnd_apply', { target: 'Kriv', declared_by: 'P2', reaction: { by: 'Kriv', name: '尖刻言语', authorization: t.consent('Kriv', '尖刻言语'), attack_mod: '-1d6', spend: '诗人激励' } });
    expect(text).toContain('未命中');
    expect(text).toContain('都答复了');
    expect(findCharacter(t.campaign(), 'Kriv')!.resources!['诗人激励']!.current).toBe(2);
    expect(await t.call('dnd_apply', { target: 'Kriv', settle: true })).toContain('未命中');
    expect(t.hp('Kriv')).toBe(20);
  });

  it('尖刻言语减伤害：先减再落账，不用事后回血', async () => {
    const t = setup();
    t.rolls.push(20, 5, 5); // 重击 2d6+4 = 14
    await t.biteKriv();
    t.rolls.push(4);
    await t.call('dnd_apply', { target: 'Kriv', declared_by: 'P2', reaction: { by: 'Kriv', name: '尖刻言语', authorization: t.consent('Kriv', '尖刻言语'), damage_mod: '-1d6', spend: '诗人激励' }, settle: true });
    expect(t.hp('Kriv')).toBe(10); // 20 - (14-4)
    expect(t.campaign().log.some((l) => l.includes('恢复'))).toBe(false);
  });

  it('护盾术 +5 AC；重击时不再提供', async () => {
    const t = setup();
    t.rolls.push(12, 3); // 18 vs 16
    await t.biteKriv();
    const text = await t.call('dnd_apply', { target: 'Kriv', declared_by: 'P2', reaction: { by: 'Kriv', name: '护盾术', authorization: t.consent('Kriv', '护盾术'), ac_mod: 5, spend: '防御法杖充能' } });
    expect(text).not.toContain('AC 21');
    expect(text).toContain('未命中');
    await t.call('dnd_apply', { target: 'Kriv', settle: true });
    expect(t.hp('Kriv')).toBe(20);

    const c = t.campaign();
    const options = eligibleReactors(c, findCharacter(c, '狼')!, findCharacter(c, '卡厄斯')!, { hit: true, crit: true, natural: 20 });
    expect(options.map((o) => o.reaction)).toEqual([]); // Kriv 这轮反应已用
  });

  it('导引打击：自己攻击没中时停下，+10 改成命中后才掷伤害，不占反应', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => { c.initiative!.turn = 2; });
    t.rolls.push(3); // 刻德温 3 vs AC 13，没中
    const first = await t.call('dnd_check', { type: 'attack', character: '刻德温', target: '狼', weapon: '银锤', declared_by: 'P4' });
    expect(first).toContain('未命中');
    expect(first).toContain('待结算');
    expect(t.campaign().initiative!.pending!.rawDamage).toBeUndefined();
    t.rolls.push(5);
    const text = await t.call('dnd_apply', { target: '狼', declared_by: 'P4', reaction: { by: '刻德温', name: '导引打击', authorization: t.consent('刻德温', '导引打击'), attack_mod: '+10', spend: '引导神力' } });
    expect(text).toContain('现在命中');
    await t.call('dnd_apply', { target: '狼', settle: true });
    expect(t.hp('狼')).toBe(25);
    expect(t.campaign().initiative!.reacted).toBeUndefined();
  });

  it('自己攻击命中时不为导引打击停下', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => { c.initiative!.turn = 2; });
    t.rolls.push(15, 5);
    const text = await t.call('dnd_check', { type: 'attack', character: '刻德温', target: '狼', weapon: '银锤', declared_by: 'P4' });
    expect(text).not.toContain('待结算');
    expect(t.hp('狼')).toBe(25);
  });

  it('玩家本人没发话不能替他用', async () => {
    const t = setup();
    t.record.recentSenders = [];
    t.rolls.push(15, 3);
    await t.biteKriv();
    await expect(t.call('dnd_apply', { target: 'Kriv', reaction: { by: 'Kriv', name: '尖刻言语', attack_mod: '-1d6' } })).rejects.toThrow();
  });

  it('一轮一次反应，到他自己回合开始才恢复', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    await t.call('dnd_apply', { target: 'Kriv', declared_by: 'P2', reaction: { by: 'Kriv', name: '尖刻言语', authorization: t.consent('Kriv', '尖刻言语'), damage_mod: '-1' }, settle: true });
    expect(t.campaign().initiative!.reacted).toEqual(['Kriv']);

    // 同一轮再被打：Kriv 没反应可用了，直接落账
    t.rolls.push(15, 3);
    expect(await t.biteKriv()).not.toContain('待结算');

    await t.call('dnd_initiative', { action: 'next' });
    expect(t.campaign().initiative!.reacted).toBeUndefined();
  });

  it('资源用完不再询问', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => {
      const res = c.characters.find((x) => x.name === 'Kriv')!.resources!;
      res['诗人激励']!.current = 0;
      res['防御法杖充能']!.current = 0;
    });
    t.rolls.push(15, 3);
    expect(await t.biteKriv()).not.toContain('待结算');
  });

  it('按防御算：抗性在落账时减半', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    await t.call('dnd_check', { type: 'attack', character: '狼', target: 'Kriv', defense: 'resistant' });
    expect(await t.call('dnd_apply', { target: 'Kriv', decline: ['Kriv'], settle: true })).toContain('抗性 受 3');
  });

  it('被打到 0 HP 的流程照旧：落账时才进濒死', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => { c.characters.find((x) => x.name === 'Kriv')!.hp = 3; });
    t.rolls.push(15, 3);
    await t.biteKriv();
    expect(t.hp('Kriv')).toBe(3);
    await t.call('dnd_apply', { target: 'Kriv', decline: ['Kriv'], settle: true });
    expect(t.hp('Kriv')).toBe(0);
  });
});

describe('谁能反应', () => {
  it('旧卡从备注推断；写了 reactions 就不再猜，空数组等于明确没有', () => {
    const c = setup().campaign();
    const ch = findCharacter(c, '卡厄斯')!;
    ch.notes = '尖刻言语 Cutting Words（反应）';
    expect(reactionsOf(ch).map((r) => r.name)).toEqual(['尖刻言语']);
    ch.reactions = [];
    expect(reactionsOf(ch)).toEqual([]);
  });

  it('昏迷的、别的房间的、NPC 都不在名单里', () => {
    const t = setup();
    const c = t.campaign();
    const hit = { hit: true, crit: false, natural: 15 };
    const names = (): string[] => eligibleReactors(c, findCharacter(c, '狼')!, findCharacter(c, '卡厄斯')!, hit).map((o) => o.character);
    expect(names()).toEqual(['Kriv']);
    upsertCharacter(c, { name: '希尔达', kind: 'npc', maxHp: 27, notes: '尖刻言语' });
    expect(names()).toEqual(['Kriv']);
    findCharacter(c, 'Kriv')!.conditions.push('昏迷');
    expect(names()).toEqual([]);
    findCharacter(c, 'Kriv')!.conditions.pop();
    findCharacter(c, 'Kriv')!.room = 'somewhere-else';
    expect(names()).toEqual([]);
  });

  it('护盾术只在自己被打时给', () => {
    const c = setup().campaign();
    const hit = { hit: true, crit: false, natural: 15 };
    const of = (target: string): string[] => eligibleReactors(c, findCharacter(c, '狼')!, findCharacter(c, target)!, hit).map((o) => o.reaction);
    expect(of('Kriv')).toEqual(['尖刻言语', '护盾术']);
    expect(of('卡厄斯')).toEqual(['尖刻言语']);
  });

  it('敌人之间、队友误伤不算 foe_attacks', () => {
    const c = setup().campaign();
    const hit = { hit: true, crit: false, natural: 15 };
    expect(eligibleReactors(c, findCharacter(c, '卡厄斯')!, findCharacter(c, '狼')!, hit)).toEqual([]);
  });
});

describe('压缩和玩家视角', () => {
  it('待结算进团况，重新读档也还在', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    const snapshot = t.service.stateSnapshot(t.key);
    expect(snapshot).toContain('【待结算 #R1】狼→Kriv');
    expect(snapshot).toContain('伤害 7，还没扣血');
    expect(snapshot).toContain('还在等：Kriv');
    expect(new CampaignStore(t.service.store.root).load(t.key)!.initiative!.pending!.rawDamage).toBe(7);
  });

  it('落账后团况不再提', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    await t.call('dnd_apply', { target: 'Kriv', decline: ['Kriv'], settle: true });
    expect(t.service.stateSnapshot(t.key)).not.toContain('待结算');
  });

  it('玩家状态只说在等，不漏 AC 和数字', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    const c = t.campaign();
    const text = playerStatus(c, t.service.library.get(c.adventureId)!);
    expect(text).toContain('还没结算');
    expect(text).not.toContain('AC');
  });
});

describe('反应按钮', () => {
  it('每个反应一个按钮，加一个不用，并且竖着排（横排会把名字截断）', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    const keyboard = buildReactionKeyboard(t.campaign().initiative!.pending!);
    const labels = keyboard.content.rows.flatMap((r) => r.buttons.map((b) => b.render_data.label));
    expect(labels).toEqual(['Kriv·尖刻言语', 'Kriv·护盾术', '不用']);
    expect(keyboard.content.rows.map((r) => r.buttons.length)).toEqual([1, 1, 1]);
  });

  it('按钮只放名字前半截，长名字不会被截成省略号', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => {
      c.characters.find((x) => x.name === '刻德温')!.reactions = [{ name: '哨兵', when: 'foe_attacks', range: 5, counter: true }];
      c.initiative!.positions = { 刻德温: { x: 5, y: 6, room: c.currentRoom }, 狼: { x: 5, y: 5, room: c.currentRoom } };
    });
    t.rolls.push(15, 3);
    await t.biteKriv();
    const labels = buildReactionKeyboard(t.campaign().initiative!.pending!).content.rows.flatMap((r) => r.buttons.map((b) => b.render_data.label));
    expect(labels).toContain('刻德温·哨兵');
    expect(labels.some((l) => l.includes('…'))).toBe(false);
  });

  it('只有本人点才算：别人点被拒，本人点了 DM 不用再要 declared_by', async () => {
    const t = setup();
    t.record.recentSenders = [];
    t.rolls.push(15, 3);
    await t.biteKriv();
    const seq = t.campaign().initiative!.pending!.seq;
    expect(t.press({ a: 'react', r: seq, i: 0 }, 'P3')).toBe(ACK.denied);
    expect(t.followup).not.toHaveBeenCalled();
    expect(t.press({ a: 'react', r: seq, i: 0 }, 'P2')).toBe(ACK.ok);
    expect(t.followup.mock.calls[0]![0].content[0].text).toContain('不是新的回合行动');
    expect(t.press({ a: 'react', r: seq, i: 0 }, 'P2')).toBe(ACK.duplicate);
    t.rolls.push(1);
    expect(await t.call('dnd_apply', { target: 'Kriv', reaction: { by: 'Kriv', name: '尖刻言语', authorization: t.campaign().initiative!.pending!.claimed[0]!.authorization, damage_mod: '-1d6', spend: '诗人激励' } })).toContain('都答复了');
  });

  it('点了要用但还没结算效果时，不能提前落账', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    t.press({ a: 'react', r: t.campaign().initiative!.pending!.seq, i: 0 }, 'P2');
    await expect(t.call('dnd_apply', { target: 'Kriv', settle: true })).rejects.toThrow(/还在等 Kriv/);
  });

  it('「不用」只算自己，全员答复才叫醒 DM；名单外的人点被拒', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => { c.characters.find((x) => x.name === '卡厄斯')!.reactions = [{ name: '防护' }]; });
    t.rolls.push(15, 3);
    await t.biteKriv();
    const seq = t.campaign().initiative!.pending!.seq;
    expect(t.press({ a: 'pass', r: seq }, 'P4')).toBe(ACK.denied);
    expect(t.press({ a: 'pass', r: seq }, 'P2')).toBe(ACK.ok);
    expect(t.followup).not.toHaveBeenCalled();
    expect(t.press({ a: 'pass', r: seq }, 'P2')).toBe(ACK.duplicate);
    expect(t.press({ a: 'pass', r: seq }, 'P3')).toBe(ACK.ok);
    expect(t.followup.mock.calls[0]![0].content[0].text).toContain('settle=true');
  });

  it('旧消息上的按钮作废', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    const seq = t.campaign().initiative!.pending!.seq;
    await t.call('dnd_apply', { target: 'Kriv', decline: ['Kriv'], settle: true });
    expect(t.press({ a: 'react', r: seq, i: 0 }, 'P2')).toBe(ACK.duplicate);
    t.rolls.push(15, 3);
    await t.biteKriv();
    expect(t.press({ a: 'pass', r: seq }, 'P2')).toBe(ACK.duplicate);
  });

  it('待结算期间点「结束回合」推进不了', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => { c.initiative!.turn = 1; });
    t.rolls.push(15, 3);
    await t.call('dnd_check', { type: 'attack', character: '狼', target: 'Kriv', reaction: true });
    const press = t.press({ a: 'end', n: 'Kriv', r: 1 }, 'P2');
    expect(press).toBe(ACK.failed);
    expect(t.campaign().initiative!.turn).toBe(1);
  });

  it('回复发完才发按钮；不限时，没人答复也不会自己算「不用」去催 DM', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    t.buttons.scheduleReaction(t.record as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.sender.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(t.sender.sendMarkdown.mock.calls[0]![1]).toContain('不限时');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.followup).not.toHaveBeenCalled();
    expect(t.campaign().initiative!.pending).toBeDefined();
  });

  it('按钮发不出去时待结算照样挂着，玩家打字回应的路不受影响', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.sender.sendMarkdown.mockRejectedValueOnce(new Error('no keyboard permission'));
    t.rolls.push(15, 3);
    await t.biteKriv();
    t.buttons.scheduleReaction(t.record as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.campaign().initiative!.pending).toBeDefined();
  });

  it('button_data 能编码 react 和 pass', () => {
    expect(JSON.parse(encodeButtonData({ t: 'dnd', a: 'react', r: 3, i: 1 }))).toMatchObject({ a: 'react', r: 3, i: 1 });
  });
});

describe('inbound 认反应', () => {
  async function pending() {
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    return { ...t, c: t.campaign() };
  }

  it('「我用尖刻言语」是宣告；名单外玩家提到反应是讨论', async () => {
    const { c } = await pending();
    expect(classifyReactionReply(c, 'P2', '我用尖刻言语')).toMatchObject({ kind: 'use', characters: ['Kriv'] });
    expect(classifyReactionReply(c, 'P2', '<@!123> 尖刻言语 减他')).toMatchObject({ kind: 'use' });
    expect(classifyReactionReply(c, 'P3', '我有反应吗，能帮挡吗')).toMatchObject({ kind: 'question', characters: [] });
  });

  it('「不用」只认名单里的人，别人说算了不算回应', async () => {
    const { c } = await pending();
    expect(classifyReactionReply(c, 'P2', '不用')).toMatchObject({ kind: 'decline', characters: ['Kriv'] });
    expect(classifyReactionReply(c, 'P2', '不用了。')).toMatchObject({ kind: 'decline' });
    expect(classifyReactionReply(c, 'P3', '算了')).toBeUndefined();
  });

  it('闲聊、斜杠命令、不是玩家的人、没有待结算时都不算', async () => {
    const { c } = await pending();
    expect(classifyReactionReply(c, 'P2', '这狼也太猛了')).toBeUndefined();
    expect(classifyReactionReply(c, 'P2', '/dnd status 反应')).toBeUndefined();
    expect(classifyReactionReply(c, 'stranger', '我用尖刻言语')).toBeUndefined();
    const fresh = setup().campaign();
    expect(classifyReactionReply(fresh, 'P2', '我用尖刻言语')).toBeUndefined();
  });

  it('标记写明不是新回合、没带 @ 也算', async () => {
    const { c } = await pending();
    const reply = recordReactionReply(c, 'P2', classifyReactionReply(c, 'P2', '我用尖刻言语')!, 'm1');
    const use = reactionReplyNote(c, reply);
    expect(use).toContain('不是新的回合行动');
    expect(use).toContain('没带 @ 也算');
    expect(reactionReplyNote(c, { kind: 'decline', characters: ['Kriv'] })).toContain('撤销旧授权');
  });

  it('中间件入口：只有群消息、有待结算、认得出才给标记', async () => {
    const t = await pending();
    const msg = (content: string, extra: object = {}) => ({ kind: 'group', groupOpenid: 'G1', senderId: 'P2', content, messageId: 'm1', ...extra }) as never;
    expect(pendingReactionReply(msg('我用尖刻言语'), t.manager as never, true)?.note).toContain('[系统 · 待结算]');
    expect(pendingReactionReply(msg('吃饭了'), t.manager as never)).toBeUndefined();
    expect(pendingReactionReply(msg('我用尖刻言语', { kind: 'c2c' }), t.manager as never)).toBeUndefined();
    pendingReactionReply(msg('不用', { messageId: 'm2' }), t.manager as never, true);
    await t.call('dnd_apply', { target: 'Kriv', settle: true });
    expect(pendingReactionReply(msg('我用尖刻言语'), t.manager as never)).toBeUndefined();
  });
});

describe('服务器反应授权', () => {
  async function pending() {
    const t = setup();
    t.rolls.push(15, 3);
    await t.biteKriv();
    return t;
  }
  function reply(t: ReturnType<typeof setup>, content: string, messageId: string, senderId = 'P2') {
    return pendingReactionReply({ kind: 'group', groupOpenid: 'G1', senderId, content, messageId } as never, t.manager as never, true);
  }
  function token(t: ReturnType<typeof setup>) {
    return t.campaign().initiative!.pending!.claimed[0]!.authorization!;
  }
  const shield = (t: ReturnType<typeof setup>, authorization?: string) => t.call('dnd_apply', {
    target: 'Kriv', declared_by: 'P2', reaction: { by: 'Kriv', name: '护盾术', ac_mod: 5, spend: '防御法杖充能', authorization },
  });

  it('玩家编号或规则提问不授权；含混群聊短答也不自动拒绝', async () => {
    const t = await pending();
    const before = t.campaign();
    await expect(shield(t)).rejects.toThrow('有效授权');
    for (const [i, text] of ['护盾术持续一回合的', '能用护盾术吗？', '我有反应吗，能帮挡吗'].entries()) {
      expect(reply(t, text, `q${i}`)?.note).toContain('没有新的使用授权');
    }
    for (const text of ['没有', '没', '算了']) expect(reply(t, text, text)).toBeUndefined();
    expect(reply(t, '我用护盾术', 'other', 'P3')).toBeDefined();
    expect(t.campaign()).toMatchObject({ characters: before.characters, initiative: { pending: { claimed: [], declined: [] } } });
    await expect(shield(t)).rejects.toThrow('有效授权');
  });

  it('复现日志竞态：明确宣告排队，随后点不用，旧调用不能扣账或掷骰', async () => {
    const t = await pending();
    expect(reply(t, '我用护盾术', 'm1')?.note).toContain('authorization:');
    const old = token(t);
    expect(t.press({ a: 'pass', r: t.campaign().initiative!.pending!.seq }, 'P2')).toBe(ACK.ok);
    const before = t.campaign();
    t.rolls.push(4, 2);
    await expect(shield(t, old)).rejects.toThrow('已选择不用');
    expect(t.campaign()).toEqual(before);
    expect(t.rolls).toEqual([4, 2]);
    expect(before.initiative!.pending!.claimed).toEqual([]);
    expect(before.initiative!.reacted).toBeUndefined();
    expect(findCharacter(before, 'Kriv')!.resources!.防御法杖充能!.current).toBe(2);
  });

  it('本人重新同意发新凭证，旧凭证和重复投递的消息不能复活或消费', async () => {
    const t = await pending();
    reply(t, '我用护盾术', 'm1');
    const old = token(t);
    reply(t, '不用', 'm2');
    reply(t, '我用护盾术', 'm1');
    expect(t.campaign().initiative!.pending!.claimed).toEqual([]);
    reply(t, '我用护盾术', 'm3');
    const current = token(t);
    expect(current).not.toBe(old);
    await expect(shield(t, old)).rejects.toThrow('有效授权');
    await shield(t, current);
    const after = t.campaign();
    await expect(shield(t, current)).rejects.toThrow('已经对这笔用过');
    expect(t.campaign()).toEqual(after);
    expect(findCharacter(after, 'Kriv')!.resources!.防御法杖充能!.current).toBe(1);
  });

  it('授权不能换技能、不能被 DM decline 覆盖；本人改选技能撤销旧凭证', async () => {
    const t = await pending();
    reply(t, '我用尖刻言语', 'm1');
    const old = token(t);
    await expect(shield(t, old)).rejects.toThrow('有效授权');
    await expect(t.call('dnd_apply', { target: 'Kriv', decline: ['Kriv'], settle: true })).rejects.toThrow('不能替他改成不用');
    const seq = t.campaign().initiative!.pending!.seq;
    expect(t.press({ a: 'react', r: seq, i: 1 }, 'P2')).toBe(ACK.ok);
    expect(token(t)).not.toBe(old);
    t.rolls.push(4);
    await expect(t.call('dnd_apply', { target: 'Kriv', reaction: { by: 'Kriv', name: '尖刻言语', damage_mod: '-1d6', authorization: old } })).rejects.toThrow('有效授权');
    expect(t.rolls).toEqual([4]);
    await shield(t, token(t));
  });

  it('重掷后名单重排时，旧按钮不能把原来的技能选成另一个技能', async () => {
    const t = await pending();
    const p = t.campaign().initiative!.pending!;
    const data = { t: 'dnd', a: 'react', r: p.seq, i: 0, o: reactionOptionKey(p.reactors[0]!) };
    t.service.store.update(t.key, (c) => { c.initiative!.pending!.reactors.reverse(); });
    expect(t.buttons.handleInteraction({ id: 'stale-option', type: 11, version: 1, group_openid: 'G1', group_member_openid: 'P2',
      data: { type: 11, resolved: { button_data: JSON.stringify(data) } } } as InteractionEvent)).toBe(ACK.duplicate);
    expect(t.campaign().initiative!.pending!.claimed).toEqual([]);
    expect(t.press({ a: 'react', r: p.seq, i: 0 }, 'P2')).toBe(ACK.ok);
    await shield(t, token(t));
  });

  it('不能在拒绝后用另一次检定的 use_reaction 绕过当前窗口授权', async () => {
    const t = await pending();
    reply(t, '不用', 'm1');
    const before = t.campaign();
    await expect(t.call('dnd_check', { type: 'check', character: 'Kriv', ability: '魅力', reaction: true, use_reaction: true, declared_by: 'P2', spend: '防御法杖充能' })).rejects.toThrow('待结算');
    expect(t.campaign()).toEqual(before);
  });

  it('相同角色和技能的新窗口也不能重用旧凭证', async () => {
    const t = await pending();
    reply(t, '我用护盾术', 'm1');
    const old = token(t);
    reply(t, '不用', 'm2');
    await t.call('dnd_apply', { target: 'Kriv', settle: true });
    t.rolls.push(15, 3);
    await t.biteKriv();
    reply(t, '我用护盾术', 'm3');
    await expect(shield(t, old)).rejects.toThrow('有效授权');
    await shield(t, token(t));
  });

  it('遗漏的手动反应可以补询问，保持原骰子和窗口，仍须本人重新确认', async () => {
    const t = await pending();
    const before = t.campaign().initiative!.pending!;
    expect(reply(t, '我用时间变幻', 'm1', 'P3')?.note).toContain('没有新的使用授权');
    const ask = { target: 'Kriv', ask_reactions: [{ by: '卡厄斯', name: '时间变幻' }] };
    expect(await t.call('dnd_apply', ask)).toContain('原骰子保持不变');
    expect(t.campaign().initiative!.pending).toMatchObject({ seq: before.seq, natural: before.natural, total: before.total, rawDamage: before.rawDamage, claimed: [] });
    expect(t.onPendingAttack).toHaveBeenCalledTimes(2);
    await expect(t.call('dnd_apply', { target: 'Kriv', reaction: { by: '卡厄斯', name: '时间变幻', reroll: 'd20' }, declared_by: 'P3' })).rejects.toThrow('有效授权');
    // 原消息重复投递不算对新增询问的确认。
    reply(t, '我用时间变幻', 'm1', 'P3');
    expect(t.campaign().initiative!.pending!.claimed).toEqual([]);
    reply(t, '我用时间变幻', 'm2', 'P3');
    t.rolls.push(5);
    expect(await t.call('dnd_apply', { target: 'Kriv', reaction: { by: '卡厄斯', name: '时间变幻', reroll: 'd20', authorization: token(t) } })).toContain('重掷');
    await expect(t.call('dnd_apply', { ...ask, settle: true })).rejects.toThrow('不能同时');
  });

  it('纯检测不生成授权；DM 补询问不能清除本人拒绝', async () => {
    const t = await pending();
    pendingReactionReply({ kind: 'group', groupOpenid: 'G1', senderId: 'P2', content: '我用护盾术', messageId: 'm1' } as never, t.manager as never);
    expect(t.campaign().initiative!.pending!.claimed).toEqual([]);
    reply(t, '不用', 'm2');
    const before = t.campaign();
    await expect(t.call('dnd_apply', { target: 'Kriv', ask_reactions: [{ by: 'Kriv', name: '时间变幻' }] })).rejects.toThrow('不能由 DM 重新询问覆盖');
    expect(t.campaign()).toEqual(before);
  });

  it('按钮旧回调重投不能撤回后重新授权，旧存档确认需本人重选', async () => {
    const t = await pending();
    t.service.store.update(t.key, (c) => { c.initiative!.pending!.claimed = [{ character: 'Kriv', reaction: '护盾术' }]; });
    await expect(shield(t)).rejects.toThrow('有效授权');
    const seq = t.campaign().initiative!.pending!.seq;
    expect(t.press({ a: 'react', r: seq, i: 1 }, 'P2')).toBe(ACK.ok);
    const old = token(t);
    expect(t.press({ a: 'react', r: seq, i: 1 }, 'P2')).toBe(ACK.duplicate);
    expect(t.press({ a: 'pass', r: seq }, 'P2')).toBe(ACK.ok);
    const replay = t.buttons.handleInteraction({ id: 'e1', type: 11, version: 1, group_openid: 'G1', group_member_openid: 'P2',
      data: { type: 11, resolved: { button_data: JSON.stringify({ t: 'dnd', a: 'react', r: seq, i: 1 }) } } } as InteractionEvent);
    expect(replay).toBe(ACK.duplicate);
    const replayDuplicate = t.buttons.handleInteraction({ id: 'e2', type: 11, version: 1, group_openid: 'G1', group_member_openid: 'P2',
      data: { type: 11, resolved: { button_data: JSON.stringify({ t: 'dnd', a: 'react', r: seq, i: 1 }) } } } as InteractionEvent);
    expect(replayDuplicate).toBe(ACK.duplicate);
    await expect(shield(t, old)).rejects.toThrow('已选择不用');
  });
});

describe('哨兵：别人挨打时反手一记', () => {
  /** 刻德温换成只有哨兵：5 尺内有人打别人时反打，不看有没有打中 */
  function armSentinel(t: ReturnType<typeof setup>): void {
    t.service.store.update(t.key, (c) => {
      c.characters.find((x) => x.name === '刻德温')!.reactions = [{ name: '哨兵', when: 'foe_attacks', range: 5, counter: true }];
    });
  }

  const place = (t: ReturnType<typeof setup>, spots: Array<[string, number, number]>): Promise<string> =>
    t.call('dnd_position', { action: 'set', placements: spots.map(([name, x, y]) => ({ name, x, y })) });

  it('贴身的怪打别人：即使打空也给他按钮', async () => {
    const t = setup();
    armSentinel(t);
    await place(t, [['狼', 5, 5], ['Kriv', 6, 5], ['刻德温', 5, 6]]);
    t.rolls.push(2); // d20=2 +6 = 8，打不中 AC16
    const text = await t.biteKriv();
    expect(text).toContain('未命中');
    expect(text).toContain('刻德温·哨兵');
  });

  it('超出 5 尺就不出现', async () => {
    const t = setup();
    armSentinel(t);
    await place(t, [['狼', 5, 5], ['Kriv', 6, 5], ['刻德温', 25, 25]]);
    t.rolls.push(15, 3);
    const text = await t.biteKriv();
    expect(text).not.toContain('哨兵');
  });

  it('打的就是他本人时不算「别人挨打」', async () => {
    const t = setup();
    armSentinel(t);
    await place(t, [['狼', 5, 5], ['Kriv', 6, 5], ['刻德温', 5, 6]]);
    t.rolls.push(15, 3);
    const text = await t.call('dnd_check', { type: 'attack', character: '狼', target: '刻德温' });
    expect(text).not.toContain('哨兵');
  });

  it('用了之后不落账、只提示「落账后打回去」，还不改这笔的数字', async () => {
    const t = setup();
    armSentinel(t);
    await place(t, [['狼', 5, 5], ['Kriv', 6, 5], ['刻德温', 5, 6]]);
    t.rolls.push(15, 3);
    await t.biteKriv();
    const text = await t.call('dnd_apply', { target: 'Kriv', reaction: { by: '刻德温', name: '哨兵', authorization: t.consent('刻德温', '哨兵') }, declared_by: 'P4' });
    expect(text).toContain('新的攻击');
    expect(text).toContain('dnd_check character=刻德温');
    expect(t.hp('Kriv')).toBe(20); // 这笔还没落账
    const pendingAttack = t.campaign().initiative!.pending!;
    expect(pendingAttack.attackMod).toBe(0);
    expect(pendingAttack.used.at(-1)?.name).toBe('哨兵');
  });
});
