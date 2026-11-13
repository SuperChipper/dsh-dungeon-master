import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdventureLibrary } from './adventure.ts';
import { CampaignStore, requireCharacter, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';

type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };

function table(roller?: (sides: number) => number) {
  const root = mkdtempSync(join(tmpdir(), 'dnd-paused-card-'));
  const library = new AdventureLibrary();
  const adventure = { ...library.get('sunken-bell')!, milestones: [{ when: { level: 1 }, level: 2 }] };
  vi.spyOn(library, 'get').mockReturnValue(adventure);
  const service = new DndService({ store: new CampaignStore(root), library, mapDir: root, roller });
  const key = 'group:G1';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: '甲', playerId: 'owner', maxHp: 20, notes: '保留旧背景', room: c.currentRoom });
    upsertCharacter(c, { name: '狼', kind: 'monster', maxHp: 11, room: c.currentRoom });
    upsertCharacter(c, { name: '向导', kind: 'npc', maxHp: 12 });
    c.initiative = { round: 3, turn: 1, order: [{ name: '甲', init: 18 }, { name: '狼', init: 10 }] };
  });
  service.stop(key, '【位置】门厅\n【下次接续】等甲的反应');
  const tools = new Map<string, Tool>();
  registerDndTools({ get: () => ({ register: (t: Tool) => tools.set(t.name, t) }) } as never, {
    service,
    manager: { findByAgent: () => ({ sessionKey: key }) } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    sendImage: vi.fn(),
    members: {
      toOpenid: (_record, value) => value === 'U7' ? 'player-openid' : undefined,
      display: (_record, value) => value === 'player-openid' ? 'U7' : undefined,
    },
  });
  const call = async (name: string, args: object) => (await tools.get(name)!.execute(args, { agent: {} })).text;
  const campaign = () => service.store.load(key)!;
  return { service, key, call, campaign };
}

describe('停团写 PC 卡', () => {
  it('建卡、绑定玩家、配资源后仍停团；不推进剧情或改变先攻，重读仍在', async () => {
    const { service, key, call, campaign } = table();
    const before = campaign();
    const text = await call('dnd_character', {
      action: 'create', name: 'tion', kind: 'pc', player: '飞斗', player_id: 'U7',
      class_name: '风暴牧师', level: 5, wis: 18, max_hp: 38, ac: 18, hit_die: 'd8',
      weapons: [{ name: '战锤', damage: '1d8' }],
    });
    expect(text).toContain('已建卡');
    expect(text).toContain('〈飞斗 #U7〉');
    await call('dnd_resource', { action: 'set', character: 'tion', resource: '1环法术位', max: 4, reset: 'long' });
    const saved = new CampaignStore(service.store.root).load(key)!;
    expect(requireCharacter(saved, 'tion')).toMatchObject({
      playerId: 'player-openid', level: 5, maxHp: 38, hp: 38, abilities: { wis: 18 },
      resources: { '1环法术位': { max: 4, current: 4, reset: 'long' } },
    });
    expect(saved.active).toBe(false);
    for (const field of ['initiative', 'currentRoom', 'chapter', 'quests', 'flags', 'announced', 'summaries'] as const) {
      expect(saved[field]).toEqual(before[field]);
    }
    expect(service.store.snapshots(key).at(-2)!.label).toContain('dnd_character');
    expect(service.promptSections(key)[0]!.text).toContain('dnd_character create/update');
  });

  it('停团写入固定先攻后，续团开战自动使用，不需要每场再加同一被动', async () => {
    const { service, key, call, campaign } = table(() => 10);
    const existingOrder = campaign().initiative!.order;
    const changed = await call('dnd_character', { action: 'update', name: '甲', init_bonus: 7 });
    expect(requireCharacter(campaign(), '甲').initBonus).toBe(7);
    expect(changed).toContain('固定先攻 +7');
    expect(campaign().initiative!.order).toEqual(existingOrder);
    service.start(key, 'sunken-bell', false);
    await call('dnd_initiative', { action: 'end' });
    const rolled = await call('dnd_initiative', { action: 'start', participants: ['甲'] });
    expect(rolled).toContain('+ 7');
    expect(campaign().initiative!.order[0]!.init).toBe(17);
  });

  it('改卡保留未提交字段；批量改卡可用，加入非 PC 则整批不落盘', async () => {
    const { service, key, call, campaign } = table();
    await call('dnd_character', { action: 'update', name: '甲', ac: 18 });
    expect(requireCharacter(campaign(), '甲')).toMatchObject({ ac: 18, notes: '保留旧背景', playerId: 'owner', maxHp: 20 });
    await call('dnd_character', { action: 'create', name: '乙', max_hp: 10 });
    await call('dnd_character', { action: 'update', names: ['甲', '乙'], add_items: ['背包'] });
    expect(requireCharacter(campaign(), '乙').inventory).toContain('背包');
    const before = campaign();
    const snapshots = service.store.snapshots(key);
    await expect(call('dnd_character', { action: 'update', names: ['甲', '狼'], gp_change: 10 })).rejects.toThrow('只能操作 PC');
    expect(campaign()).toEqual(before);
    expect(service.store.snapshots(key)).toEqual(snapshots);
  });

  it('查卡只返回 PC，具名或批量查怪物/NPC 也不能绕过', async () => {
    const { call } = table();
    expect(await call('dnd_character', { action: 'list' })).not.toMatch(/狼|向导/);
    expect(await call('dnd_character', { action: 'show', name: '甲' })).toContain('保留旧背景');
    expect(await call('dnd_character', { action: 'show', names: ['甲'] })).toContain('甲');
    await expect(call('dnd_character', { action: 'show', names: ['甲', '狼'] })).rejects.toThrow('只能操作 PC');
    await expect(call('dnd_character', { action: 'show', name: '狼', names: [] })).rejects.toThrow('只能操作 PC');
    await expect(call('dnd_character', { action: 'show', name: '向导' })).rejects.toThrow('只能操作 PC');
  });

  it.each([
    { action: 'create', name: '新怪', kind: 'monster' },
    { action: 'create', name: '狼', kind: 'pc' },
    { action: 'create', name: '新怪', srd: 'goblin' },
    { action: 'create', name: '复制卡', count: 2 },
    { action: 'update', name: '甲', kind: 'monster' },
    { action: 'update', name: '狼', names: [], ac: 20 },
    { action: 'update', name: '甲', room: 'nave' },
    { action: 'remove', name: '甲' },
  ])('拒绝停团操作 %j，团档保持不变', async (args) => {
    const { call, campaign } = table();
    const before = campaign();
    await expect(call('dnd_character', args)).rejects.toThrow('停团');
    expect(campaign()).toEqual(before);
  });

  it.each([
    ['dnd_resource', { action: 'set', character: '狼', resource: '次数', max: 1 }],
    ['dnd_resource', { action: 'use', character: '甲', resource: '次数' }],
    ['dnd_resource', { action: 'restore', character: '甲', resource: '次数' }],
    ['dnd_rest', { kind: 'long' }],
    ['dnd_apply', { target: '甲', damage: 1 }],
  ])('写卡例外不开放 %s %j', async (name, args) => {
    const { call, campaign } = table();
    const before = campaign();
    await expect(call(name as string, args as object)).rejects.toThrow();
    expect(campaign()).toEqual(before);
  });

  it('普通存储写入仍要求开团；续团后照常触发剧情检查', async () => {
    const { service, key, call, campaign } = table();
    expect(() => service.store.update(key, (c) => { c.flags.push('不该写入'); })).toThrow('进行中的团');
    await call('dnd_character', { action: 'update', name: '甲', ac: 18 });
    expect(campaign().announced).not.toContain('level:2');
    service.start(key, 'sunken-bell', false);
    const text = await call('dnd_resource', { action: 'set', character: '甲', resource: '次数', max: 1 });
    expect(text).toContain('里程碑');
    expect(campaign().announced).toContain('level:2');
  });

  it('没有团档时不能用写卡例外新建团', async () => {
    const { service, key, call, campaign } = table();
    service.store.archive(key);
    await expect(call('dnd_character', { action: 'create', name: '甲' })).rejects.toThrow('没有进行中的团');
    await expect(call('dnd_resource', { action: 'set', character: '甲', resource: '次数', max: 1 })).rejects.toThrow('没有进行中的团');
    expect(campaign()).toBeUndefined();
  });
});
