/**
 * 待结算扩到豁免/检定、reroll="d20"、失败附带状态和按骰子撤销。
 * 攻击窗口本身（按钮、计时、inbound）在 pending-attack.test.ts。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdventureLibrary } from './adventure.ts';
import { type Campaign, CampaignStore, findCharacter, parseCampaign, playerStatus, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { classifyReactionReply } from './pending-attack.ts';
import { DndTurnButtons } from './turn-buttons.ts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };

const CHRONAL = [{ by: '奇塔露', name: '时间变幻' }];

/** rolls 里按顺序给骰子，给完了都是 10。先攻：狼 > 奇塔露 > 地精 > Kriv */
function setup() {
  const rolls: number[] = [];
  const root = mkdtempSync(join(tmpdir(), 'dnd-pending-roll-'));
  const service = new DndService({
    store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root, roller: () => rolls.shift() ?? 10,
  });
  const key = 'group:G1';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: 'Kriv', player: 'tty', playerId: 'P2', maxHp: 20, ac: 16, reactions: [{ name: '尖刻言语', when: 'foe_attacks', resource: '诗人激励' }] });
    upsertCharacter(c, { name: '奇塔露', player: 'qtl', playerId: 'P5', maxHp: 18, ac: 12, reactions: [] });
    upsertCharacter(c, { name: '狼', kind: 'monster', maxHp: 30, ac: 13, attackBonus: 6, damage: '1d6+4', room: c.currentRoom });
    upsertCharacter(c, { name: '地精', kind: 'monster', maxHp: 7, ac: 15, room: c.currentRoom });
    c.characters.find((x) => x.name === 'Kriv')!.resources = { 诗人激励: { current: 3, max: 3, reset: 'short' } };
    c.characters.find((x) => x.name === '奇塔露')!.resources = {
      时间变幻: { current: 2, max: 2, reset: 'long' }, '1环法术位': { current: 2, max: 2, reset: 'long' },
    };
    c.initiative = { round: 1, turn: 0, order: [{ name: '狼', init: 20 }, { name: '奇塔露', init: 16 }, { name: '地精', init: 12 }, { name: 'Kriv', init: 5 }] };
  });

  const followup = vi.fn();
  const record = {
    sessionKey: key, scope: 'group', peerId: 'G1', replyTarget: { scope: 'group', targetId: 'G1' },
    recentSenders: [{ id: 'P2', at: Date.now() }, { id: 'P5', at: Date.now() }],
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
  const ch = (name: string) => findCharacter(campaign(), name)!;
  /** 轮到奇塔露，对地精放一个感知豁免的法术 */
  const castOnGoblin = (extra: Record<string, unknown> = {}): Promise<string> => {
    service.store.update(key, (c) => { c.initiative!.turn = 1; });
    return call('dnd_check', {
      type: 'save', character: '奇塔露', ability: '感知', dc: 15, targets: [{ name: '地精' }], on_fail_conditions: ['麻痹'],
      spend: '1环法术位', declared_by: 'P5', ...extra,
    });
  };
  const chronal = (target: string) => call('dnd_apply', {
    target, declared_by: 'P5', reaction: { by: '奇塔露', name: '时间变幻', reroll: 'd20', spend: '时间变幻' },
  });
  return { rolls, service, key, call, campaign, ch, castOnGoblin, chronal, buttons, followup, record, onPendingAttack, sender };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('豁免和检定也能挂起', () => {
  it('敌人对奇塔露法术的豁免：hold_for 挂起，状态先不加，结果里要报成败', async () => {
    const t = setup();
    t.rolls.push(18);
    const text = await t.castOnGoblin({ hold_for: CHRONAL });
    expect(text).toContain('→ 成功（还没落账）');
    expect(text).toContain('这笔还没落账，别往下推进');
    expect(text).toContain('报骰子和成败');
    expect(text).toContain('奇塔露·时间变幻');
    expect(t.ch('地精').conditions).not.toContain('麻痹');
    expect(t.campaign().initiative!.pending).toMatchObject({ kind: 'roll', attacker: '奇塔露', target: '地精', dc: 15, onFail: ['麻痹'] });
    expect(t.onPendingAttack).toHaveBeenCalledTimes(1);
    // 法术位在施法时就花了，不等落账
    expect(t.ch('奇塔露').resources!['1环法术位']!.current).toBe(1);
  });

  it('时间变幻重掷：旧结果作废、必须用新的，落账时按新结果加状态', async () => {
    const t = setup();
    t.rolls.push(18);
    await t.castOnGoblin({ hold_for: CHRONAL });
    t.rolls.push(2);
    const text = await t.chronal('地精');
    expect(text).toMatch(/重掷 #R2：d20\[18\].* 作废 → d20\[2\]/);
    expect(text).toContain('失败');
    expect(t.campaign().initiative!.reacted).toContain('奇塔露');
    expect(t.ch('奇塔露').resources!['时间变幻']!.current).toBe(1);
    const settled = await t.call('dnd_apply', { target: '地精', settle: true });
    expect(settled).toContain('得「麻痹」');
    expect(t.ch('地精').conditions).toContain('麻痹');
    expect(t.campaign().initiative!.pending).toBeUndefined();
  });

  it('群体豁免里重掷哪一个靠 target 指定；不在名单里的人报错', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => { upsertCharacter(c, { name: '地精2', kind: 'monster', maxHp: 7, ac: 15, room: c.currentRoom }); c.initiative!.turn = 1; });
    t.rolls.push(6, 3, 18);
    await t.call('dnd_check', {
      type: 'save', character: '奇塔露', ability: '敏捷', dc: 13, damage: '1d6', targets: [{ name: '地精' }, { name: '地精2' }],
      declared_by: 'P5', hold_for: CHRONAL,
    });
    expect(t.ch('地精2').hp).toBe(7);
    await expect(t.chronal('Kriv')).rejects.toThrow(/掷骰的是 地精、地精2/);
    t.rolls.push(1);
    await t.chronal('地精2');
    await t.call('dnd_apply', { target: '地精', settle: true });
    // 伤害骰先掷、共用、不重掷：地精 3 失败吃满 6，地精2 18 本来成功，重掷成 1 也失败
    expect(t.ch('地精').hp).toBe(1);
    expect(t.ch('地精2').hp).toBe(1);
  });

  it('单纯的检定也能挂：落账只报最终成败，不碰别的状态', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => { c.initiative!.turn = 3; });
    t.rolls.push(4);
    const text = await t.call('dnd_check', { type: 'skill', character: 'Kriv', skill: '运动', dc: 12, declared_by: 'P2', hold_for: CHRONAL });
    expect(text).toContain('失败');
    expect(text).toContain('后果先别演');
    t.rolls.push(17);
    await t.chronal('Kriv');
    expect(await t.call('dnd_apply', { target: 'Kriv', settle: true })).toMatch(/落账：Kriv 运动检定 17.* → 成功。按这个结果演/);
  });

  it('攻击加减用 attack_mod 改那一骰；ac_mod 只对攻击有用', async () => {
    const t = setup();
    t.rolls.push(13);
    await t.castOnGoblin({ hold_for: CHRONAL });
    await expect(t.call('dnd_apply', { target: '地精', declared_by: 'P5', reaction: { by: '奇塔露', name: '时间变幻', ac_mod: 5 } })).rejects.toThrow(/ac_mod 只对攻击有用/);
    t.rolls.push(3);
    const text = await t.call('dnd_apply', { target: '地精', declared_by: 'P5', reaction: { by: '奇塔露', name: '时间变幻', attack_mod: '+1d4' } });
    expect(text).toMatch(/地精 感知豁免 16（原 13） → 成功/);
  });

  it('reroll 只认 d20', async () => {
    const t = setup();
    t.rolls.push(13);
    await t.castOnGoblin({ hold_for: CHRONAL });
    await expect(t.call('dnd_apply', { target: '地精', declared_by: 'P5', reaction: { by: '奇塔露', name: '时间变幻', reroll: '2d20' } })).rejects.toThrow(/只支持 "d20"/);
  });
});

describe('hold 在掷骰前校验', () => {
  it('点名 NPC/怪物、暗骰、战斗外都在掷骰前报错，骰子和编号都没动', async () => {
    const t = setup();
    t.rolls.push(18, 18, 18);
    await expect(t.castOnGoblin({ hold_for: [{ by: '狼', name: '反应' }] })).rejects.toThrow(/不是绑了玩家的 PC/);
    await expect(t.call('dnd_check', { type: 'save', character: '地精', ability: '感知', dc: 15, secret: true, hold: true })).rejects.toThrow(/暗骰不能挂起/);
    t.service.store.update(t.key, (c) => { c.initiative = undefined; });
    await expect(t.call('dnd_check', { type: 'save', character: '地精', ability: '感知', dc: 15, hold: true })).rejects.toThrow(/只在战斗中/);
    expect(t.rolls).toHaveLength(3);
    expect(t.campaign().rollSeq).toBeUndefined();
  });

  it('这一轮反应用过了就不能再点名', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => { c.initiative!.reacted = ['奇塔露']; });
    await expect(t.castOnGoblin({ hold_for: CHRONAL })).rejects.toThrow(/反应已经用过了/);
  });
});

describe('攻击重掷', () => {
  it('重击被重掷成没中：旧伤害作废，没回话的尖刻言语从名单上拿掉，落账不扣血', async () => {
    const t = setup();
    t.rolls.push(20, 3, 4);
    const first = await t.call('dnd_check', { type: 'attack', character: '狼', target: 'Kriv', hold_for: CHRONAL });
    expect(first).toContain('重击');
    expect(t.campaign().initiative!.pending).toMatchObject({ crit: true, rawDamage: 11 });
    t.rolls.push(2);
    const text = await t.chronal('Kriv');
    expect(text).toContain('未命中，落账时不扣血');
    const p = t.campaign().initiative!.pending!;
    expect(p).toMatchObject({ crit: false, natural: 2 });
    expect(p.kind === 'attack' ? p.rawDamage : 0).toBeUndefined();
    expect(p.reactors.map((r) => r.character)).toEqual(['奇塔露']);
    await t.call('dnd_apply', { target: 'Kriv', settle: true });
    expect(t.ch('Kriv').hp).toBe(20);
  });

  it('没中被重掷成命中：按新结果掷伤害，尖刻言语加进名单、窗口重开', async () => {
    const t = setup();
    t.rolls.push(5);
    await t.call('dnd_check', { type: 'attack', character: '狼', target: 'Kriv', hold_for: CHRONAL });
    expect(t.campaign().initiative!.pending!.reactors).toHaveLength(1);
    t.rolls.push(15, 2);
    const text = await t.chronal('Kriv');
    expect(text).toContain('Kriv·尖刻言语 也能反应了');
    expect(text).toContain('现在命中，伤害 1d6[2] + 4 = 6');
    expect(t.onPendingAttack).toHaveBeenCalledTimes(2);
    await expect(t.call('dnd_apply', { target: 'Kriv', settle: true })).rejects.toThrow(/还在等 Kriv/);
    await t.call('dnd_apply', { target: 'Kriv', decline: ['Kriv'], settle: true });
    expect(t.ch('Kriv').hp).toBe(14);
  });

  it('DM 手动挂起时天然 1 也挂（重掷能改掉它）', async () => {
    const t = setup();
    t.rolls.push(1);
    expect(await t.call('dnd_check', { type: 'attack', character: '狼', target: 'Kriv', hold_for: CHRONAL })).toContain('待结算');
  });

});

describe('失败状态和伤害同一步落账', () => {
  it('不挂起时 on_fail_conditions 当场加上，成功的人不加', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => { upsertCharacter(c, { name: '地精2', kind: 'monster', maxHp: 7, ac: 15, room: c.currentRoom }); c.initiative!.turn = 1; });
    t.rolls.push(3, 19);
    const text = await t.call('dnd_check', {
      type: 'save', character: '奇塔露', ability: '感知', dc: 15, targets: [{ name: '地精' }, { name: '地精2' }], on_fail_conditions: ['麻痹'], declared_by: 'P5',
    });
    expect(text).toContain('失败得「麻痹」');
    expect(t.ch('地精').conditions).toContain('麻痹');
    expect(t.ch('地精2').conditions).not.toContain('麻痹');
  });

  it('没有 targets 也行：掷豁免的人自己承受', async () => {
    const t = setup();
    t.rolls.push(2);
    await t.call('dnd_check', { type: 'save', character: '地精', ability: '力量', dc: 13, on_fail_conditions: ['倒地'] });
    expect(t.ch('地精').conditions).toContain('倒地');
  });

  it('要给 dc', async () => {
    const t = setup();
    await expect(t.call('dnd_check', { type: 'save', character: '地精', ability: '力量', on_fail_conditions: ['倒地'] })).rejects.toThrow(/要给 dc/);
  });
});

describe('按骰子撤销', () => {
  it('结果里带编号；roll= 把那一骰和之后的伤害、状态、资源一起退', async () => {
    const t = setup();
    t.rolls.push(3);
    const text = await t.castOnGoblin();
    expect(text).toContain('#R1');
    await t.call('dnd_apply', { target: '地精', damage: 3 });
    expect(t.ch('地精').conditions).toContain('麻痹');
    await t.call('dnd_undo', { action: 'undo', roll: 'R1' });
    expect(t.ch('地精').conditions).not.toContain('麻痹');
    expect(t.ch('地精').hp).toBe(7);
    expect(t.ch('奇塔露').resources!['1环法术位']!.current).toBe(2);
  });

  it('越过回合推进时先列出来要 confirm', async () => {
    const t = setup();
    t.service.store.update(t.key, (c) => { c.characters.find((x) => x.name === 'Kriv')!.reactions = []; });
    t.rolls.push(15, 3);
    await t.call('dnd_check', { type: 'attack', character: '狼', target: 'Kriv' });
    await t.call('dnd_initiative', { action: 'next' });
    const ask = await t.call('dnd_undo', { action: 'undo', roll: 'R1' });
    expect(ask).toContain('confirm=true');
    expect(t.ch('Kriv').hp).toBe(13);
    await t.call('dnd_undo', { action: 'undo', roll: 'R1', confirm: true });
    expect(t.ch('Kriv').hp).toBe(20);
    expect(t.campaign().initiative!.turn).toBe(0);
  });

  it('退掉的编号不复用；找不到的编号报错', async () => {
    const t = setup();
    t.rolls.push(3);
    await t.castOnGoblin();
    await t.call('dnd_undo', { action: 'undo', roll: 'R1' });
    expect(t.campaign().rollSeq).toBe(1);
    t.rolls.push(3);
    expect(await t.castOnGoblin()).toContain('#R2');
    await expect(t.call('dnd_undo', { action: 'undo', roll: 'R1' })).rejects.toThrow(/找不到 #R1/);
  });

  it('没有后果的检定只记编号、不占撤销记录', async () => {
    const t = setup();
    const before = t.service.store.snapshots(t.key).length;
    await t.call('dnd_check', { type: 'save', character: '地精', ability: '感知', dc: 10 });
    expect(t.service.store.snapshots(t.key)).toHaveLength(before);
    expect(t.campaign().rollSeq).toBe(1);
  });

  it('挂起后撤销：按钮序号不回退，旧消息的按钮对不上新的一笔', async () => {
    const t = setup();
    t.rolls.push(18);
    await t.castOnGoblin({ hold_for: CHRONAL });
    await t.call('dnd_undo', { action: 'undo', roll: 'R1' });
    t.rolls.push(18);
    await t.castOnGoblin({ hold_for: CHRONAL });
    expect(t.campaign().initiative!.pending!.seq).toBe(2);
  });
});

describe('存档和玩家视角', () => {
  it('只有攻击那版的待结算存档读进来补上 kind', () => {
    const t = setup();
    const c = t.campaign() as unknown as Record<string, unknown> & { initiative: Record<string, unknown> };
    c.initiative.pending = { seq: 1, at: 0, attacker: '狼', target: 'Kriv', natural: 15, rollDetail: 'd20[15] + 6 = 21', total: 21, ac: 16, crit: false, attackMod: 0, acMod: 0, damageMod: 0, reactors: [], declined: [], claimed: [], used: [] };
    expect(parseCampaign(JSON.stringify(c))!.initiative!.pending!.kind).toBe('attack');
  });

  it('status 带站位和看的人到各人的距离；隐形的怪不给位置', async () => {
    const t = setup();
    await t.call('dnd_position', { action: 'set', placements: [{ name: '狼', x: 0, y: 0 }, { name: 'Kriv', x: 3, y: 0 }, { name: '地精', x: 5, y: 0 }, { name: '奇塔露', x: 3, y: 2 }] });
    t.service.store.update(t.key, (c) => { c.characters.find((x) => x.name === '地精')!.conditions.push('隐形'); });
    const c = t.campaign();
    const view = playerStatus(c, t.service.library.get(c.adventureId)!, 'P2');
    expect(view).toContain('狼(0,0)');
    expect(view).toContain('Kriv(3,0) 到：');
    expect(view).toContain('敌 狼 15 尺');
    expect(view).not.toContain('地精(5,0)');
    expect(view).not.toContain('地精 10 尺');
    expect(playerStatus(c, t.service.library.get(c.adventureId)!)).not.toContain('到：');
  });

  it('markdown 版把站位画成代码块网格，不重复 /dnd map 已有的探索进度', async () => {
    const t = setup();
    await t.call('dnd_position', { action: 'set', placements: [{ name: '狼', x: 0, y: 0 }, { name: 'Kriv', x: 3, y: 0 }] });
    const c = t.campaign();
    const view = playerStatus(c, t.service.library.get(c.adventureId)!, 'P2', 'markdown');
    expect(view).toContain('```\n     0  1  2  3  4\n  0  1  .  .  K  .');
    expect(view).toContain('K=Kriv　1=狼');
    expect(view).toContain('Kriv(3,0) 到：');
    expect(view).not.toContain('已探索');
    expect(view).not.toContain('站位｜');
  });

  it('「查看状态」按钮和 /dnd status 发的是 markdown 网格', async () => {
    const t = setup();
    await t.call('dnd_position', { action: 'set', placements: [{ name: '狼', x: 0, y: 0 }, { name: 'Kriv', x: 3, y: 0 }] });
    t.buttons.handleInteraction({
      id: 'e1', type: 11, version: 1, group_openid: 'G1', group_member_openid: 'P2',
      data: { type: 11, resolved: { button_data: JSON.stringify({ t: 'dnd', a: 'status' }) } },
    } as never);
    await vi.waitFor(() => expect(t.sender.sendMarkdown).toHaveBeenCalled());
    expect(String((t.sender.sendMarkdown.mock.calls[0] as unknown[])[1])).toContain('K=Kriv');
    expect(await t.buttons.sendStatus(t.key, { scope: 'group', targetId: 'G1' } as never, 'P2')).toBe(true);
    t.sender.sendMarkdown.mockRejectedValueOnce(new Error('markdown not allowed'));
    expect(await t.buttons.sendStatus(t.key, { scope: 'group', targetId: 'G1' } as never, 'P2')).toBe(false);
  });

  it('dnd_position show 给 DM 一张能原样贴的玩家视角图', async () => {
    const t = setup();
    await t.call('dnd_position', { action: 'set', placements: [{ name: '狼', x: 0, y: 0 }, { name: 'Kriv', x: 3, y: 0 }, { name: '地精', x: 5, y: 0 }] });
    t.service.store.update(t.key, (c) => { c.characters.find((x) => x.name === '地精')!.conditions.push('隐形'); });
    const text = await t.call('dnd_position', { action: 'show' });
    expect(text).toContain('地精(5,0)');
    const grid = text.slice(text.indexOf('玩家视角示意图'));
    expect(grid).toContain('```');
    expect(grid).not.toContain('地精');
  });

  it('inbound 认得 DM 点名的反应名（不在角色卡上）', async () => {
    const t = setup();
    t.rolls.push(18);
    await t.castOnGoblin({ hold_for: [{ by: '奇塔露', name: '银光嘲弄' }] });
    expect(classifyReactionReply(t.campaign(), 'P5', '银光嘲弄！')).toEqual({ kind: 'use', characters: ['奇塔露'] });
  });
});

describe('战斗图代替字符网格', () => {
  const hasSharp = (): Promise<boolean> => import('sharp').then(() => true, () => false);
  const withMap = async () => {
    const t = setup();
    const sendImage = vi.fn((..._args: unknown[]) => Promise.resolve());
    t.service.sendImage = sendImage as never;
    await t.call('dnd_position', { action: 'terrain', width: 6, height: 4, areas: [{ kind: 'object', x: 2, y: 2, name: '石台' }] });
    await t.call('dnd_position', { action: 'set', placements: [{ name: '狼', x: 0, y: 0 }, { name: 'Kriv', x: 3, y: 0 }, { name: '奇塔露', x: 4, y: 1 }] });
    return { ...t, sendImage };
  };

  it('查看状态：能出图就发战斗图，血量和先攻附在图下，不再发字符网格', async () => {
    if (!(await hasSharp())) return;
    const t = await withMap();
    expect(await t.buttons.sendStatus(t.key, { scope: 'group', targetId: 'G1' } as never, 'P2')).toBe(true);
    expect(t.sender.sendMarkdown).not.toHaveBeenCalled();
    const [, path, text] = t.sendImage.mock.calls[0] as [unknown, string, string];
    expect(path).toMatch(/\.jpg$/);
    expect(text).toContain('⚔ 第 1 轮');
    expect(text).toContain('🧱 挡路：石台');
    expect(text).not.toContain('```');
  });

  it('每轮只自动发一张战斗图：同一轮第二个 PC 的回合提示不再带图', async () => {
    if (!(await hasSharp())) return;
    const t = await withMap();
    t.service.store.update(t.key, (c) => { c.initiative!.turn = 1; });
    t.buttons.schedule(t.record as never);
    await vi.waitFor(() => expect(t.sender.sendMarkdown).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(t.sendImage).toHaveBeenCalledTimes(1);
    t.service.store.update(t.key, (c) => { c.initiative!.turn = 3; });
    t.buttons.schedule(t.record as never);
    await vi.waitFor(() => expect(t.sender.sendMarkdown).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(t.sendImage).toHaveBeenCalledTimes(1);
  });
});
