import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { AdventureLibrary } from './adventure.ts';
import { type Campaign, CampaignStore, findCharacter, playerStatus, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { chooseReaction, classifyReactionReply, eligibleReactors, eligibleSpellReactors, hostileSpellcasterHints, recordReactionReply, reactionReplyNote, reactionsOf } from './pending-attack.ts';
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

describe('2026-11-15 角斗场反应与回滚加固', () => {
  it('多充能反应 cost：充能不足不弹窗，触发时一次扣足并显示余量；护盾术挡不下时显式警告', async () => {
    const t = setup();
    await t.call('dnd_character', {
      action: 'update',
      name: 'Kriv',
      reactions: [
        { name: '尖刻言语', when: 'foe_attacks', resource: '诗人激励' },
        { name: '护盾术', when: 'attacked', resource: '防御法杖充能', cost: 2 },
      ],
    });
    t.service.store.update(t.key, (c) => {
      findCharacter(c, 'Kriv')!.resources!['防御法杖充能'] = { current: 9, max: 10, reset: 'long' };
    });

    // 16 + 6 = 22 vs AC 16：护盾术 +5 到 21 仍挡不住，必须带【算账核对】提醒
    t.rolls.push(16, 4);
    const overHit = await t.biteKriv();
    expect(overHit).toContain('【算账核对】');
    expect(overHit).toContain('单靠「护盾术」挡不下这一击');
    await t.call('dnd_apply', { target: 'Kriv', decline: ['Kriv'], settle: true });

    // 12 + 6 = 18 vs AC 16：护盾术能挡住，不报挡不下警告，且一次扣掉 2 点充能（9→7/10）
    t.rolls.push(12, 3);
    const blockable = await t.biteKriv();
    expect(blockable).not.toContain('单靠「护盾术」挡不下这一击');
    const usedText = await t.call('dnd_apply', {
      target: 'Kriv',
      declared_by: 'P2',
      reaction: { by: 'Kriv', name: '护盾术', authorization: t.consent('Kriv', '护盾术'), ac_mod: 5 },
    });
    expect(usedText).toContain('9→7/10');
    expect(findCharacter(t.campaign(), 'Kriv')!.resources!['防御法杖充能']!.current).toBe(7);
    const settled = await t.call('dnd_apply', { target: 'Kriv', settle: true });
    expect(settled).toContain('本笔反应汇总');

    // 只剩 1 点充能时（< cost 2），不再向玩家询问护盾术
    await t.call('dnd_initiative', { action: 'next' }); // 轮到 Kriv，自动恢复反应与卸除上轮护盾术
    await t.call('dnd_initiative', { action: 'goto', name: '狼' });
    t.service.store.update(t.key, (c) => {
      const res = findCharacter(c, 'Kriv')!.resources!;
      res['诗人激励']!.current = 0;
      res['防御法杖充能']!.current = 1;
    });
    t.rolls.push(12, 3);
    expect(await t.biteKriv()).not.toContain('待结算');
  });

  it('受伤后反应（迷雾逃生）排在改命中反应之后：尖刻言语改未命中不吞反应，仍命中才重开询问', async () => {
    const t = setup();
    // 兼容旧存档把迷雾逃生写成 when=attacked 的情况
    t.service.store.update(t.key, (c) => {
      const ch = findCharacter(c, '卡厄斯')!;
      ch.ac = 16;
      ch.reactions = [{ name: '迷雾逃生', when: 'attacked', resource: '迷雾逃生' }];
      ch.resources = { 迷雾逃生: { current: 1, max: 1, reset: 'short' } };
    });

    // 第 1 击：11+6=17 vs AC 16，先只问 Kriv·尖刻言语，不提前弹出迷雾逃生
    t.rolls.push(11, 4);
    const first = await t.call('dnd_check', { type: 'attack', character: '狼', target: '卡厄斯' });
    expect(first).toContain('Kriv·尖刻言语');
    expect(first).not.toContain('迷雾逃生');

    // Kriv 尖刻言语 -3 把 17 减到 14（未命中）：直接落账，卡厄斯迷雾逃生与反应名额完好无损
    t.rolls.push(3);
    await t.call('dnd_apply', {
      target: '卡厄斯',
      reaction: { by: 'Kriv', name: '尖刻言语', authorization: t.consent('Kriv', '尖刻言语'), attack_mod: '-1d6', spend: '诗人激励' },
    });
    const missSettle = await t.call('dnd_apply', { target: '卡厄斯', settle: true });
    expect(missSettle).toContain('未命中');
    expect(missSettle).toContain('Kriv「尖刻言语」');
    expect(findCharacter(t.campaign(), '卡厄斯')!.resources!['迷雾逃生']!.current).toBe(1);
    expect(t.campaign().initiative!.reacted).toEqual(['Kriv']);

    // 下一轮重置 Kriv 反应，再测 Kriv 选择不用时自动解锁卡厄斯·迷雾逃生
    t.service.store.update(t.key, (c) => { delete c.initiative!.reacted; });
    t.rolls.push(12, 4);
    await t.call('dnd_check', { type: 'attack', character: '狼', target: '卡厄斯' });
    const unlock = await t.call('dnd_apply', { target: '卡厄斯', decline: ['Kriv'], settle: true });
    expect(unlock).toContain('命中已确认，现在询问受伤后反应：卡厄斯·迷雾逃生');
    expect(t.campaign().initiative!.pending).toBeDefined();
    expect(t.onPendingAttack).toHaveBeenCalledTimes(3);
  });

  it('备注推断时间变幻只在敌人重击时自动挂起；手动扣时间变幻同步消耗反应，且支持 restore 反应退费', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => {
      findCharacter(c, 'Kriv')!.reactions = [];
      const ch = findCharacter(c, '卡厄斯')!;
      ch.notes = '预言/时间法师：时间变幻 2/2';
      ch.resources = { 时间变幻: { current: 2, max: 2, reset: 'long' } };
    });

    // 普通命中不弹时间变幻，避免每刀骚扰
    t.rolls.push(15, 3);
    expect(await t.biteKriv()).not.toContain('待结算');

    // 天然 20 重击自动挂起询问卡厄斯·时间变幻
    t.rolls.push(20, 4, 4);
    const critText = await t.biteKriv();
    expect(critText).toContain('卡厄斯·时间变幻');
    await t.call('dnd_apply', { target: 'Kriv', decline: ['卡厄斯'], settle: true });

    // 手动 dnd_resource use 时间变幻 会同步记下本轮反应已用，且误扣可 restore 反应退回
    const manualUse = await t.call('dnd_resource', { action: 'use', character: '卡厄斯', resource: '时间变幻' });
    expect(manualUse).toContain('已同步记下本轮反应已消耗');
    expect(t.campaign().initiative!.reacted).toContain('卡厄斯');

    const refunded = await t.call('dnd_resource', { action: 'restore', character: '卡厄斯', resource: '反应' });
    expect(refunded).toContain('已退回 卡厄斯 本轮的反应名额');
    expect(t.campaign().initiative!.reacted).toBeUndefined();
  });

  it('文字回复「用，直接放在伤害骰上」「用，攻击鉴定」在唯一选项时直接签发授权', async () => {
    const t = setup();
    t.rolls.push(15, 3);
    await t.call('dnd_check', { type: 'attack', character: '狼', target: '卡厄斯' }); // Kriv 只有尖刻言语一个选项
    const c = t.campaign();
    expect(classifyReactionReply(c, 'P2', '<@!999> 用，直接放在伤害骰上')).toMatchObject({
      kind: 'use',
      choices: [{ character: 'Kriv', reaction: '尖刻言语' }],
    });
    expect(classifyReactionReply(c, 'P2', '<@!999> 用，攻击鉴定')).toMatchObject({
      kind: 'use',
      choices: [{ character: 'Kriv', reaction: '尖刻言语' }],
    });
    // 多选项时带技能名 + 修饰说明同样签发授权，但纯疑问句不授权
    await t.call('dnd_apply', { target: '卡厄斯', cancel: true });
    t.rolls.push(12, 3);
    await t.biteKriv(); // Kriv 有尖刻言语 + 护盾术两个选项
    const both = t.campaign();
    expect(classifyReactionReply(both, 'P2', '用尖刻言语，直接放在伤害骰上')).toMatchObject({
      kind: 'use',
      choices: [{ character: 'Kriv', reaction: '尖刻言语' }],
    });
    expect(classifyReactionReply(both, 'P2', '用护盾术能挡下吗')).toMatchObject({ kind: 'question' });
  });

  it('dnd_undo roll= 越过中途 join 或后续检定时要求二次确认，并提示紧邻前置走位/扣资源', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => {
      findCharacter(c, 'Kriv')!.reactions = [];
      upsertCharacter(c, { name: '新队友', player: 'new', playerId: 'P9', maxHp: 20, ac: 15 });
    });
    await t.call('dnd_position', { action: 'set', placements: [{ name: '狼', x: 0, y: 0 }, { name: 'Kriv', x: 2, y: 0 }] });
    await t.call('dnd_position', { action: 'move', name: '狼', x: 1, y: 0 });
    t.rolls.push(15, 3);
    const r1 = await t.biteKriv();
    const id = /#R(\d+)/.exec(r1)![1]!;
    t.rolls.push(18);
    await t.call('dnd_initiative', { action: 'join', participants: ['新队友'] });

    // 越过队友入战先攻，未传 confirm 时必须拦截确认
    const ask = await t.call('dnd_undo', { action: 'undo', roll: `R${id}` });
    expect(ask).toContain('confirm=true');
    expect(t.campaign().initiative!.order.some((e) => e.name === '新队友')).toBe(true);

    // confirm=true 执行后，提示紧邻该骰之前的同回合前置走位尚未回退
    const done = await t.call('dnd_undo', { action: 'undo', roll: `R${id}`, confirm: true });
    expect(done).toContain('【前置步骤提醒】');
    expect(done).toContain('dnd_position action=move');
  });

  it('法术反制与护盾术：从 spells 自动推断并支持高环法术位兜底；reactions: [] 明确禁用', () => {
    const t = setup();
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, {
        name: '奥术师',
        player: 'arc',
        playerId: 'P5',
        className: '法师',
        level: 7,
        maxHp: 40,
        ac: 13,
        abilities: { int: 18 },
        reactions: [{ name: '时间变幻', when: 'enemy_crit', resource: '时间变幻' }],
        spells: [{ name: '护盾术', level: 1 }, { name: '法术反制', level: 3 }],
        room: c.currentRoom,
      });
      findCharacter(c, '奥术师')!.resources = {
        '1环法术位': { current: 0, max: 4, reset: 'long' },
        '2环法术位': { current: 2, max: 3, reset: 'long' },
        '3环法术位': { current: 0, max: 3, reset: 'long' },
        '4环法术位': { current: 1, max: 1, reset: 'long' },
        时间变幻: { current: 1, max: 1, reset: 'long' },
      };
      upsertCharacter(c, {
        name: '禁用盾',
        player: 'no',
        playerId: 'P6',
        maxHp: 30,
        ac: 14,
        reactions: [],
        spells: [{ name: '护盾术', level: 1 }],
      });
      c.initiative!.order.push({ name: '奥术师', init: 14 });
    });

    const camp = t.campaign();
    const mage = findCharacter(camp, '奥术师')!;
    const wolf = findCharacter(camp, '狼')!;
    expect(reactionsOf(mage).map((r) => r.name)).toEqual(['时间变幻', '护盾术', '法术反制']);
    expect(reactionsOf(findCharacter(camp, '禁用盾')!)).toEqual([]);

    // 1 环已空但 2 环有空余 -> 护盾术仍可触发；法术反制只算 3+ 环，4 环有空余时可触发
    expect(eligibleReactors(camp, wolf, mage, { hit: true, crit: false, natural: 15 }).filter((r) => r.character === '奥术师').map((r) => r.reaction)).toEqual(['护盾术']);
    // 普攻绝不误触法术反制
    expect(eligibleReactors(camp, wolf, mage, { hit: true, crit: false, natural: 15 }).filter((r) => r.character === '奥术师').map((r) => r.reaction)).not.toContain('法术反制');
    expect(eligibleSpellReactors(camp, wolf).map((r) => `${r.character}·${r.reaction}`)).toContain('奥术师·法术反制');

    // 高环位也全部用光后不再触发
    t.service.store.update(t.key, (c) => {
      const m = findCharacter(c, '奥术师')!;
      m.resources!['2环法术位']!.current = 0;
      m.resources!['4环法术位']!.current = 0;
    });
    const depleted = t.campaign();
    const mDep = findCharacter(depleted, '奥术师')!;
    expect(eligibleReactors(depleted, wolf, mDep, { hit: true, crit: false, natural: 15 }).filter((r) => r.character === '奥术师')).toEqual([]);
    expect(eligibleSpellReactors(depleted, wolf).map((r) => r.character)).not.toContain('奥术师');
  });

  it('敌方豁免法术（3环火球术 / 5环怪物定身术）自动触发60尺法术反制，含口头回应与高环施法属性检定', async () => {
    const t = setup();
    t.record.recentSenders.push({ id: 'P5', at: Date.now() });
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, {
        name: '奇塔露',
        player: 'qtl',
        playerId: 'P5',
        className: '法师',
        level: 7,
        maxHp: 35,
        ac: 13,
        abilities: { int: 18 },
        spells: [{ name: '法术反制', level: 3 }],
      });
      findCharacter(c, '奇塔露')!.resources = {
        '3环法术位': { current: 2, max: 3, reset: 'long' },
        '4环法术位': { current: 1, max: 1, reset: 'long' },
      };
      upsertCharacter(c, {
        name: '敌方法师',
        kind: 'monster',
        className: '法师',
        level: 9,
        maxHp: 50,
        ac: 12,
        abilities: { int: 18 },
        room: c.currentRoom,
      });
      findCharacter(c, '敌方法师')!.resources = {
        '3环法术位': { current: 2, max: 3, reset: 'long' },
        '5环法术位': { current: 1, max: 1, reset: 'long' },
      };
      c.initiative = {
        round: 1,
        turn: 0,
        order: [{ name: '敌方法师', init: 20 }, { name: '奇塔露', init: 16 }, { name: '卡厄斯', init: 5 }],
        positions: {
          敌方法师: { x: 0, y: 0, room: c.currentRoom },
          卡厄斯: { x: 2, y: 0, room: c.currentRoom },
          奇塔露: { x: 13, y: 0, room: c.currentRoom }, // 65 尺 > 60 尺
        },
      };
    });

    // 1) 超出 60 尺不挂起法术反制，火球直接命中卡厄斯
    t.rolls.push(4, 4, 4, 4, 4, 4, 4, 4, 2); // 8d6=32, 敏捷豁免 2+0=2 失败
    const farCast = await t.call('dnd_check', {
      character: '敌方法师',
      type: 'save',
      ability: '敏捷',
      dc: 15,
      damage: '8d6',
      damage_type: '火焰',
      spend: '3环法术位',
      spell_name: '火球术',
      targets: [{ name: '卡厄斯' }],
    });
    expect(farCast).not.toContain('待结算');
    expect(t.hp('卡厄斯')).toBe(0);
    expect(findCharacter(t.campaign(), '敌方法师')!.resources!['3环法术位']!.current).toBe(1);

    // 恢复卡厄斯 HP 并把奇塔露挪到 50 尺内（60 尺反制范围）
    t.service.store.update(t.key, (c) => {
      const ks = findCharacter(c, '卡厄斯')!;
      ks.hp = 29;
      ks.conditions = [];
      delete ks.deathSaves;
      c.initiative!.positions!['奇塔露'] = { x: 10, y: 0, room: c.currentRoom };
    });

    // 2) 3 环火球在 50 尺内自动挂起，文字回应「用3环法术反制」签发授权，反制后火球彻底失效且敌方法术位不退还
    t.rolls.push(4, 4, 4, 4, 4, 4, 4, 4, 2);
    const nearCast = await t.call('dnd_check', {
      character: '敌方法师',
      type: 'save',
      ability: '敏捷',
      dc: 15,
      damage: '8d6',
      damage_type: '火焰',
      spend: '3环法术位',
      spell_name: '火球术',
      targets: [{ name: '卡厄斯' }],
    });
    expect(nearCast).toContain('待结算');
    expect(nearCast).toContain('奇塔露·法术反制');
    expect(t.hp('卡厄斯')).toBe(29);
    expect(classifyReactionReply(t.campaign(), 'P5', '用3环法术反制')).toMatchObject({
      kind: 'use',
      choices: [{ character: '奇塔露', reaction: '法术反制' }],
    });
    expect(classifyReactionReply(t.campaign(), 'P5', '法术反制有效吗？')).toMatchObject({ kind: 'question' });

    const auth1 = t.consent('奇塔露', '法术反制');
    const countered = await t.call('dnd_apply', {
      target: '卡厄斯',
      reaction: { by: '奇塔露', name: '法术反制', authorization: auth1, slot_level: 3 },
      settle: true,
    });
    expect(countered).toContain('自动成功');
    expect(countered).toContain('反制失效');
    expect(t.hp('卡厄斯')).toBe(29);
    expect(findCharacter(t.campaign(), '奇塔露')!.resources!['3环法术位']!.current).toBe(1);
    expect(findCharacter(t.campaign(), '敌方法师')!.resources!['3环法术位']!.current).toBe(0);
    expect(t.campaign().initiative!.reacted).toContain('奇塔露');

    // 3) 5 环怪物定身术用 3 环反制需过 DC 15 智力检定（+4）：失败继续生效，成功则失效
    t.service.store.update(t.key, (c) => { delete c.initiative!.reacted; });
    t.rolls.push(2); // 卡厄斯感知豁免 2 失败
    await t.call('dnd_check', {
      character: '敌方法师',
      type: 'save',
      ability: '感知',
      dc: 15,
      on_fail_conditions: ['麻痹'],
      concentration: true,
      spend: '5环法术位',
      spell_name: '怪物定身术',
      targets: [{ name: '卡厄斯' }],
    });
    const authFail = t.consent('奇塔露', '法术反制');
    t.rolls.push(9); // d20=9 + 4 = 13 < DC 15 反制失败！
    const failedCounter = await t.call('dnd_apply', {
      target: '卡厄斯',
      reaction: { by: '奇塔露', name: '法术反制', authorization: authFail, slot_level: 3 },
      settle: true,
    });
    expect(failedCounter).toContain('未达反制要求');
    expect(findCharacter(t.campaign(), '卡厄斯')!.conditions).toContain('麻痹');

    t.service.store.update(t.key, (c) => {
      delete c.initiative!.reacted;
      findCharacter(c, '卡厄斯')!.conditions = [];
      delete findCharacter(c, '卡厄斯')!.activeStates;
      findCharacter(c, '敌方法师')!.resources!['5环法术位']!.current = 1;
      findCharacter(c, '奇塔露')!.resources!['3环法术位']!.current = 2;
    });
    t.rolls.push(2);
    await t.call('dnd_check', {
      character: '敌方法师',
      type: 'save',
      ability: '感知',
      dc: 15,
      on_fail_conditions: ['麻痹'],
      concentration: true,
      spend: '5环法术位',
      spell_name: '怪物定身术',
      targets: [{ name: '卡厄斯' }],
    });
    const authPass = t.consent('奇塔露', '法术反制');
    t.rolls.push(12); // d20=12 + 4 = 16 >= DC 15 反制成功！
    const passedCounter = await t.call('dnd_apply', {
      target: '卡厄斯',
      reaction: { by: '奇塔露', name: '法术反制', authorization: authPass, slot_level: 3 },
      settle: true,
    });
    expect(passedCounter).toContain('反制成功');
    expect(findCharacter(t.campaign(), '卡厄斯')!.conditions).not.toContain('麻痹');
  });

  it('敌方法术攻击无damage仍挂起护盾术（默认+5 AC）与法术反制；敌方魔法飞弹触发护盾术全免疫与法术反制', async () => {
    const t = setup();
    t.record.recentSenders.push({ id: 'P5', at: Date.now() });
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, {
        name: '奇塔露',
        player: 'qtl',
        playerId: 'P5',
        className: '法师',
        level: 5,
        maxHp: 30,
        ac: 13,
        abilities: { int: 18 },
        spells: [{ name: '护盾术', level: 1 }, { name: '法术反制', level: 3 }],
      });
      findCharacter(c, '奇塔露')!.resources = {
        '1环法术位': { current: 2, max: 3, reset: 'long' },
        '3环法术位': { current: 2, max: 2, reset: 'long' },
      };
      findCharacter(c, 'Kriv')!.reactions = [];
      findCharacter(c, '刻德温')!.reactions = [];
      upsertCharacter(c, {
        name: '敌方法师',
        kind: 'monster',
        level: 5,
        abilities: { int: 18 },
        attackBonus: 7,
        maxHp: 45,
        ac: 12,
        room: c.currentRoom,
      });
      c.initiative = { round: 1, turn: 0, order: [{ name: '敌方法师', init: 20 }, { name: '奇塔露', init: 16 }, { name: '卡厄斯', init: 5 }] };
    });

    // 1) 未传 damage 的法术攻击同样自动挂起护盾术与法术反制，且用护盾术时 ac_mod 自动默认 +5 挡下 15 命中
    t.rolls.push(8); // 8+7=15 vs AC 13 命中，护盾术 +5 AC -> 18 未命中
    const atkHold = await t.call('dnd_check', {
      character: '敌方法师',
      type: 'attack',
      target: '奇塔露',
      ability: 'int',
      spell_name: '灼热射线',
      spell_level: 2,
    });
    expect(atkHold).toContain('奇塔露·护盾术');
    expect(atkHold).toContain('奇塔露·法术反制');
    const shieldAuth = t.consent('奇塔露', '护盾术');
    const shieldRes = await t.call('dnd_apply', {
      target: '奇塔露',
      reaction: { by: '奇塔露', name: '护盾术', authorization: shieldAuth },
      settle: true,
    });
    expect(shieldRes).toContain('AC +5');
    expect(shieldRes).toContain('未命中');
    expect(t.campaign().initiative!.shielded).toContain('奇塔露');
    expect(findCharacter(t.campaign(), '奇塔露')!.resources!['1环法术位']!.current).toBe(1);

    // 2) 魔法飞弹自动挂起，护盾术完全免疫自身伤害而队友照常吃伤
    t.service.store.update(t.key, (c) => { delete c.initiative!.reacted; });
    const mmHold = await t.call('dnd_apply', {
      caster: '敌方法师',
      spell_name: '魔法飞弹',
      slot_level: 1,
      damage_type: '力场',
      targets: [{ name: '奇塔露', damage: 10 }, { name: '卡厄斯', damage: 9 }],
    });
    expect(mmHold).toContain('待结算');
    expect(mmHold).toContain('奇塔露·护盾术');
    expect(mmHold).toContain('奇塔露·法术反制');
    expect(t.hp('奇塔露')).toBe(30);
    expect(t.hp('卡厄斯')).toBe(29);

    const mmShieldAuth = t.consent('奇塔露', '护盾术');
    const mmRes = await t.call('dnd_apply', {
      target: '奇塔露',
      reaction: { by: '奇塔露', name: '护盾术', authorization: mmShieldAuth },
      settle: true,
    });
    expect(mmRes).toContain('护盾术');
    expect(mmRes).toContain('免疫');
    expect(t.hp('奇塔露')).toBe(30);
    expect(t.hp('卡厄斯')).toBe(20);

    // 3) 魔法飞弹被法术反制后，全员 0 伤
    t.service.store.update(t.key, (c) => { delete c.initiative!.reacted; });
    await t.call('dnd_apply', {
      caster: '敌方法师',
      spell_name: '魔法飞弹',
      slot_level: 1,
      damage_type: '力场',
      targets: [{ name: '奇塔露', damage: 10 }, { name: '卡厄斯', damage: 9 }],
    });
    const mmCounterAuth = t.consent('奇塔露', '法术反制');
    const mmCountered = await t.call('dnd_apply', {
      target: '奇塔露',
      reaction: { by: '奇塔露', name: '法术反制', authorization: mmCounterAuth, slot_level: 3 },
      settle: true,
    });
    expect(mmCountered).toContain('反制失效');
    expect(t.hp('卡厄斯')).toBe(20);
  });

  it('敌方持续区域（火墙术）与状态法术（灵体卫士）自动触发法术反制，反制后不落地、跳过后正常生效', async () => {
    const t = setup();
    t.record.recentSenders.push({ id: 'P5', at: Date.now() });
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, {
        name: '奇塔露',
        player: 'qtl',
        playerId: 'P5',
        className: '法师',
        level: 7,
        maxHp: 35,
        ac: 13,
        abilities: { int: 18 },
        spells: [{ name: '法术反制', level: 3 }],
      });
      findCharacter(c, '奇塔露')!.resources = {
        '3环法术位': { current: 2, max: 3, reset: 'long' },
        '4环法术位': { current: 1, max: 1, reset: 'long' },
      };
      upsertCharacter(c, {
        name: '敌方牧师',
        kind: 'monster',
        className: '牧师',
        level: 7,
        maxHp: 50,
        ac: 16,
        abilities: { wis: 18 },
        room: c.currentRoom,
      });
      findCharacter(c, '敌方牧师')!.resources = {
        '3环法术位': { current: 2, max: 3, reset: 'long' },
        '4环法术位': { current: 2, max: 2, reset: 'long' },
      };
      c.initiative!.order.push({ name: '奇塔露', init: 16 }, { name: '敌方牧师', init: 11 });
    });
    await t.call('dnd_position', { action: 'terrain', width: 10, height: 10, areas: [] });

    // 1) 敌方放置火墙术：消耗 4 环位后挂起，4 环反制后区域不生成
    const zoneHold = await t.call('dnd_position', {
      action: 'zone',
      name: '火墙术',
      caster: '敌方牧师',
      x: 3,
      y: 3,
      spend: '4环法术位',
    });
    expect(zoneHold).toContain('待结算');
    expect(zoneHold).toContain('奇塔露·法术反制');
    expect(t.campaign().initiative!.zones).toBeUndefined();
    const zAuth = t.consent('奇塔露', '法术反制');
    await t.call('dnd_apply', {
      target: '敌方牧师',
      reaction: { by: '奇塔露', name: '法术反制', authorization: zAuth, slot_level: 4 },
      settle: true,
    });
    expect(t.campaign().initiative!.zones).toBeUndefined();
    expect(findCharacter(t.campaign(), '敌方牧师')!.resources!['4环法术位']!.current).toBe(1);

    // 跳过反制 -> 落账后火墙术成功生效
    t.service.store.update(t.key, (c) => { delete c.initiative!.reacted; });
    await t.call('dnd_position', { action: 'zone', name: '火墙术', caster: '敌方牧师', x: 3, y: 3, spend: '4环法术位' });
    const zSettled = await t.call('dnd_apply', { target: '敌方牧师', decline: ['奇塔露'], settle: true });
    expect(zSettled).toContain('已放置持续区域：火墙术');
    expect(t.campaign().initiative!.zones?.some((z) => z.name === '火墙术')).toBe(true);

    // 2) 敌方施放 3 环灵体卫士：反制成功后不挂载状态，但法术位不退回
    t.service.store.update(t.key, (c) => { delete c.initiative!.reacted; });
    const buffHold = await t.call('dnd_resource', {
      action: 'use',
      character: '敌方牧师',
      resource: '3环法术位',
      apply_state: '灵体卫士',
    });
    expect(buffHold).toContain('待结算');
    const bAuth = t.consent('奇塔露', '法术反制');
    const buffCountered = await t.call('dnd_apply', {
      target: '敌方牧师',
      reaction: { by: '奇塔露', name: '法术反制', authorization: bAuth, slot_level: 3 },
      settle: true,
    });
    expect(buffCountered).toContain('反制失效');
    expect(findCharacter(t.campaign(), '敌方牧师')!.conditions).not.toContain('灵体卫士');
    expect(findCharacter(t.campaign(), '敌方牧师')!.resources!['3环法术位']!.current).toBe(1);
  });

  it('PC 施法与攻击命中敌方法师时触发仅限 DM 可见的法术反制/护盾术战术提醒（绝不发玩家按钮）', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, {
        name: '黑蜘蛛',
        kind: 'monster',
        className: '法师',
        level: 6,
        maxHp: 40,
        ac: 12,
        spells: [{ name: '法术反制', level: 3 }, { name: '护盾术', level: 1 }],
        room: c.currentRoom,
      });
      findCharacter(c, '黑蜘蛛')!.resources = {
        '1环法术位': { current: 2, max: 3, reset: 'long' },
        '3环法术位': { current: 2, max: 2, reset: 'long' },
      };
      const ks = findCharacter(c, '卡厄斯')!;
      ks.className = '法师';
      ks.weapons = [{ name: '短剑', damage: '1d6' }];
      ks.resources = {
        '1环法术位': { current: 3, max: 3, reset: 'long' },
        '2环法术位': { current: 2, max: 2, reset: 'long' },
        '3环法术位': { current: 2, max: 2, reset: 'long' },
      };
      c.initiative = {
        round: 1,
        turn: 0,
        order: [{ name: '卡厄斯', init: 20 }, { name: '黑蜘蛛', init: 10 }],
        positions: {
          卡厄斯: { x: 1, y: 1, room: c.currentRoom },
          黑蜘蛛: { x: 6, y: 1, room: c.currentRoom }, // 25 尺 <= 60 尺
        },
      };
    });

    // 1) PC 放火球、放火墙、施放状态法术，均提醒黑蜘蛛持有「法术反制」且不自动挂窗口
    t.rolls.push(3, 3, 3, 3, 3, 3, 3, 3, 2);
    const fb = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'save',
      ability: '敏捷',
      dc: 15,
      damage: '8d6',
      damage_type: '火焰',
      spend: '3环法术位',
      spell_name: '火球术',
      targets: [{ name: '黑蜘蛛' }],
      declared_by: 'P3',
    });
    expect(fb).toContain('【DM战术提醒】敌方「黑蜘蛛」（距 25 尺、反应 1/1）持有「法术反制」');
    expect(fb).not.toContain('待结算');

    const zoneRes = await t.call('dnd_position', { action: 'zone', name: '火墙术', caster: '卡厄斯', x: 4, y: 4 });
    expect(zoneRes).toContain('【DM战术提醒】敌方「黑蜘蛛」（距 25 尺、反应 1/1）持有「法术反制」');

    const bufRes = await t.call('dnd_resource', {
      action: 'use',
      character: '卡厄斯',
      resource: '2环法术位',
      apply_state: '防护毒素',
    });
    expect(bufRes).toContain('【DM战术提醒】敌方「黑蜘蛛」（距 25 尺、反应 1/1）持有「法术反制」');

    // 2) PC 攻击命中黑蜘蛛（AC 12）：总值 15 可被护盾术(+5→17)挡下；总值 18 单靠护盾术挡不下
    t.rolls.push(13, 3); // d20=13 + 2 = 15 (12<=15<17)
    const hitBlockable = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'attack',
      target: '黑蜘蛛',
      weapon: '短剑',
      declared_by: 'P3',
    });
    expect(hitBlockable).toContain('【DM战术提醒】敌方「黑蜘蛛」（反应 1/1）持有「护盾术」');
    expect(hitBlockable).toContain('可直接挡下本击');

    t.rolls.push(16, 3); // d20=16 + 2 = 18 (>=17)
    const hitTooHigh = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'attack',
      target: '黑蜘蛛',
      weapon: '短剑',
      declared_by: 'P3',
    });
    expect(hitTooHigh).toContain('单靠「护盾术」（+5 AC）挡不下本击');

    // 3) 超过 60 尺不再提示法术反制；反应耗尽(0/1)后两类均不提示
    t.service.store.update(t.key, (c) => {
      c.initiative!.positions!['黑蜘蛛'] = { x: 15, y: 1, room: c.currentRoom }; // 70 尺
    });
    const outOfRange = await t.call('dnd_position', { action: 'zone', name: '火墙术', caster: '卡厄斯', x: 5, y: 5 });
    expect(outOfRange).not.toContain('法术反制');

    t.service.store.update(t.key, (c) => {
      c.initiative!.positions!['黑蜘蛛'] = { x: 6, y: 1, room: c.currentRoom };
      c.initiative!.reacted = ['黑蜘蛛'];
    });
    const spentRx = await t.call('dnd_position', { action: 'zone', name: '火墙术', caster: '卡厄斯', x: 6, y: 6 });
    expect(spentRx).not.toContain('【DM战术提醒】');
    t.rolls.push(13, 3);
    const hitSpentRx = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'attack',
      target: '黑蜘蛛',
      weapon: '短剑',
      declared_by: 'P3',
    });
    expect(hitSpentRx).not.toContain('【DM战术提醒】');
  });
});
