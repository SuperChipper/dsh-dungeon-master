import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdventureLibrary } from './adventure.ts';
import { CampaignStore, requireCharacter, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';

type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };

function table() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-chain-'));
  const rolls: number[] = [];
  const roller = vi.fn((sides: number) => rolls.shift() ?? Math.min(sides, 4));
  const service = new DndService({ store: new CampaignStore(root), library: new AdventureLibrary(), mapDir: root, roller });
  const key = 'group:G';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: '甲', playerId: 'P1', level: 5, maxHp: 40, abilities: { str: 18 }, traits: ['巨武器战斗'], weapons: [{ name: '大剑', damage: '2d6', twoHanded: true }] });
    upsertCharacter(c, { name: '乙', maxHp: 40 });
    upsertCharacter(c, { name: '狼', kind: 'monster', maxHp: 100, ac: 12, room: c.currentRoom });
    requireCharacter(c, '甲').resources = { '1环法术位': { current: 3, max: 3, reset: 'long' } };
    c.initiative = { round: 1, turn: 0, order: [{ name: '甲', init: 20 }, { name: '狼', init: 10 }] };
  });
  const tools = new Map<string, Tool>();
  registerDndTools({ get: () => ({ register: (t: Tool) => tools.set(t.name, t) }) } as never, {
    service, manager: { findByAgent: () => ({ sessionKey: key, recentSenders: [{ id: 'P1', at: Date.now() }] }) } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, sendImage: vi.fn(),
  });
  const call = async (name: string, args: object) => (await tools.get(name)!.execute(args, { agent: {} })).text;
  const campaign = () => service.store.load(key)!;
  const char = (name = '甲') => requireCharacter(campaign(), name);
  const onHit = { name: '至圣斩', damage: '2d8', damage_type: '光耀', spend: '1环法术位' };
  const attack = (extra = {}) => call('dnd_check', { type: 'attack', character: '甲', target: '狼', weapon: '大剑', declared_by: 'P1', on_hit: onHit, ...extra });
  return { service, key, rolls, roller, call, campaign, char, attack, onHit };
}

describe('逐目标祝福骰', () => {
  it('只给指定目标加骰，不影响同一效果里的敌人；省掉单独 dnd_roll', async () => {
    const t = table();
    t.rolls.push(2, 12, 9);
    const text = await t.call('dnd_check', { type: 'save', character: '陷阱', ability: '敏捷', dc: 14, targets: [{ name: '甲', bonus_dice: '1d4' }, { name: '狼' }] });
    expect(text).toContain('甲 d20[12] + 2 = 14（含 1d4[2] = 2） → 成功');
    expect(text).toContain('狼 d20[9] = 9 → 失败');
    expect(t.roller).toHaveBeenCalledTimes(3);
  });

  it('目标可覆盖公共加骰或明确禁用，目标各自掷一次', async () => {
    const t = table();
    t.rolls.push(2, 10, 7, 10, 10);
    const text = await t.call('dnd_check', { type: 'save', character: '陷阱', ability: '体质', bonus_dice: '1d4', targets: [{ name: '甲' }, { name: '乙', bonus_dice: '1d8' }, { name: '狼', bonus_dice: '' }] });
    expect(text).toContain('1d4[2]');
    expect(text).toContain('1d8[7]');
    expect(text.split('\n').find((line) => line.startsWith('- 狼'))).not.toContain('含');
  });
});

describe('普通批量结算', () => {
  it('公共伤害只掷一次，逐目标抗性、临时生命和覆写数值生效，怪物数值保密', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => { requireCharacter(c, '甲').tempHp = 3; });
    t.rolls.push(4, 5);
    const text = await t.call('dnd_apply', { damage_roll: '2d6', damage_type: '火焰', targets: [{ name: '甲', defense: 'resistant' }, { name: '乙', defense: 'immune' }, { name: '狼', damage: 12 }] });
    expect(t.char()).toMatchObject({ hp: 39, tempHp: 0 });
    expect(t.char('乙').hp).toBe(40);
    expect(t.char('狼').hp).toBe(88);
    expect(t.roller).toHaveBeenCalledTimes(2);
    expect(text).toContain('公共伤害');
    expect(text).not.toMatch(/狼 HP|100|88/);
  });

  it('批量治疗/临时生命/状态一次落盘，单次 undo 整批恢复', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => { requireCharacter(c, '甲').hp = 20; requireCharacter(c, '乙').hp = 25; });
    t.rolls.push(3);
    await t.call('dnd_apply', { heal_roll: '1d4+2', temp_hp: 5, add_conditions: ['祝福'], targets: [{ name: '甲' }, { name: '乙', heal: 2 }] });
    expect(t.char()).toMatchObject({ hp: 25, tempHp: 5, conditions: ['祝福'] });
    expect(t.char('乙')).toMatchObject({ hp: 27, tempHp: 5 });
    await t.call('dnd_undo', { action: 'undo' });
    expect(t.char()).toMatchObject({ hp: 20, tempHp: 0, conditions: [] });
    expect(t.char('乙').hp).toBe(25);
  });

  it.each([
    { targets: [{ name: '甲' }, { name: '不存在' }], damage_roll: '2d6' },
    { targets: [{ name: '甲' }, { name: '甲' }], damage: 5 },
    { targets: [{ name: '甲' }, { name: '乙', heal: -5 }], heal_roll: '1d4' },
    { targets: [{ name: '甲' }], target: '甲', damage: 5 },
  ])('非法批量不掷骰、不落盘：%j', async (args) => {
    const t = table(), before = t.campaign();
    await expect(t.call('dnd_apply', args)).rejects.toThrow();
    expect(t.campaign()).toEqual(before);
    expect(t.roller).not.toHaveBeenCalled();
  });
});

describe('最终命中才追加并消耗', () => {
  it('未命中不扣资源、不掷伤害；普通命中扣一次，伤害各过抗性后合并一次扣血', async () => {
    const t = table();
    t.rolls.push(1);
    await t.attack();
    expect(t.char().resources!['1环法术位']!.current).toBe(3);
    expect(t.char('狼').hp).toBe(100);
    expect(t.roller).toHaveBeenCalledTimes(1);
    t.rolls.push(10, 3, 4, 5, 6);
    const text = await t.attack({ defense: 'resistant', on_hit: { ...t.onHit, defense: 'resistant' } });
    // 武器 3+4+4=11，抗性后 5；光耀 5+6=11，独立抗性后 5。
    expect(t.char('狼').hp).toBe(90);
    expect(t.char().resources!['1环法术位']!.current).toBe(2);
    expect(text).toContain('至圣斩');
    expect(text).not.toContain('狼 HP');
  });

  it('重击追加骰翻倍，巨武器战斗不会重投至圣斩的 1、2', async () => {
    const t = table();
    t.rolls.push(20, 3, 3, 3, 3, 1, 2, 1, 2);
    const text = await t.attack();
    expect(text).toContain('至圣斩 4d8[1,2,1,2] = 6');
    expect(t.char('狼').hp).toBe(78); // 武器 12+4，光耀 6
    expect(t.roller).toHaveBeenCalledTimes(9);
  });

  it('护盾把命中改成未命中，预授权追加不扣；重掷后按最终重击结算', async () => {
    const t = table();
    t.rolls.push(10, 3, 4);
    await t.attack({ hold: true });
    expect(t.char('狼').hp).toBe(100);
    expect(t.char().resources!['1环法术位']!.current).toBe(3);
    expect(t.campaign().initiative!.pending).toMatchObject({ onHit: { name: '至圣斩' } });
    await t.call('dnd_apply', { target: '狼', reaction: { by: '狼', name: '护盾术', ac_mod: 10 }, settle: true });
    expect(t.char('狼').hp).toBe(100);
    expect(t.char().resources!['1环法术位']!.current).toBe(3);
    t.rolls.push(10, 3, 4);
    await t.attack({ hold: true });
    t.rolls.push(20, 3, 3, 3, 3, 4, 4, 4, 4);
    await t.call('dnd_apply', { target: '狼', reaction: { by: '甲', name: '时间变幻', reroll: 'd20' }, declared_by: 'P1', settle: true });
    expect(t.char('狼').hp).toBe(68); // 武器 16，光耀16
    expect(t.char().resources!['1环法术位']!.current).toBe(2);
  });

  it('critical_only 只在最终重击触发；没有资源不追加，基础攻击仍结算', async () => {
    const t = table();
    t.rolls.push(10, 3, 4);
    await t.attack({ on_hit: { ...t.onHit, critical_only: true } });
    expect(t.char().resources!['1环法术位']!.current).toBe(3);
    t.service.store.update(t.key, (c) => { requireCharacter(c, '甲').resources!['1环法术位']!.current = 0; });
    t.rolls.push(10, 3, 4);
    expect(await t.attack()).toContain('已用完');
    expect(t.char('狼').hp).toBe(78);
  });

  it('先校验参数和资源名称；反应窗口里不能用批量结算绕过停止点', async () => {
    const t = table();
    for (const on_hit of [{ ...t.onHit, damage: '坏骰子' }, { ...t.onHit, spend: '不存在' }]) {
      await expect(t.attack({ on_hit })).rejects.toThrow();
    }
    expect(t.roller).not.toHaveBeenCalled();
    await t.attack({ hold: true });
    await expect(t.call('dnd_apply', { targets: [{ name: '狼' }], damage: 12 })).rejects.toThrow('待结算');
  });

  it('追加与武器算同一击：倒地 PC 的重击只记两次死亡豁免失败', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => { const pc = requireCharacter(c, '乙'); pc.hp = 0; pc.conditions = ['昏迷']; pc.deathSaves = { successes: 0, failures: 0 }; });
    t.rolls.push(20, 3, 3, 3, 3, 3, 3, 3, 3);
    await t.attack({ target: '乙' });
    expect(t.char('乙').deathSaves?.failures).toBe(2);
    expect(t.char('乙').conditions).not.toContain('死亡');
  });

  it('光耀追加和武器一起落账，不会先为物理部分触发不死坚韧；落账可完整撤销', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => { const wolf = requireCharacter(c, '狼'); wolf.hp = 10; wolf.traits = ['不死坚韧']; });
    t.rolls.push(10, 3, 4);
    await t.attack({ hold: true });
    t.rolls.push(3, 4);
    await t.call('dnd_apply', { target: '狼', settle: true });
    expect(t.char('狼').conditions).toContain('死亡');
    expect(t.roller).toHaveBeenCalledTimes(5);
    await expect(t.call('dnd_apply', { target: '狼', settle: true })).rejects.toThrow('没有待结算');
    await t.call('dnd_undo', { action: 'undo' });
    expect(t.char('狼').hp).toBe(10);
    expect(t.char().resources!['1环法术位']!.current).toBe(3);
    expect(t.campaign().initiative!.pending).toBeDefined();
  });
});
