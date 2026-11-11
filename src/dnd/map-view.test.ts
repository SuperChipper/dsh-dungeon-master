import { describe, expect, it } from 'vitest';
import { AdventureLibrary } from './adventure.ts';
import { createCampaign } from './campaign.ts';
import { battleRoom, battleTitle, exploreTitle, mapCaption } from './map-view.ts';

const adv = new AdventureLibrary().get('sunken-bell')!;

describe('地图标题', () => {
  it('探索：场景 · 所在房间 · 探索进度', () => {
    const c = createCampaign('k', adv);
    expect(exploreTitle(c, adv)).toMatch(/^.+ · .+ · 已探索 1\/\d+$/);
  });

  it('战斗：第几轮 · 房间 · 轮到谁；交战房间跟着当前行动者', () => {
    const c = createCampaign('k', adv);
    const start = c.currentRoom;
    c.characters = [{ name: '艾琳', kind: 'pc', hp: 10, maxHp: 10, tempHp: 0, ac: 12, conditions: [], room: start }] as never;
    c.initiative = { round: 3, turn: 0, order: [{ name: '艾琳', init: 12 }] } as never;
    expect(battleRoom(c)).toBe(start);
    expect(battleTitle(c, adv, start)).toMatch(/^第 3 轮 · .+ · 轮到 艾琳$/);
  });
});

describe('地图说明', () => {
  it('战斗图：图例和圆片上的字一一对应，倒地的单列，有名字的障碍和难行地形也列出', () => {
    const c = createCampaign('k', adv);
    const room = c.currentRoom;
    const who = (name: string, kind: string, hp = 10) => ({ name, kind, hp, maxHp: 10, tempHp: 0, ac: 12, conditions: [], room });
    c.characters = [who('艾琳', 'pc'), who('卡厄斯', 'pc', 0), who('巨鼠1', 'monster'), who('修女', 'npc')] as never;
    c.initiative = {
      round: 1, turn: 0, order: [{ name: '艾琳', init: 12 }],
      positions: { 艾琳: { x: 1, y: 1, room }, 卡厄斯: { x: 2, y: 1, room }, 巨鼠1: { x: 3, y: 3, room }, 修女: { x: 0, y: 2, room } },
    } as never;
    c.battlemaps = { [room]: { width: 5, height: 5, areas: [{ kind: 'object', x: 2, y: 2, name: '石棺' }, { kind: 'difficult', x: 0, y: 4, w: 2, name: '碎石' }] } };
    const text = mapCaption(c, adv, 'battle');
    expect(text).toContain('🔵 艾=艾琳');
    expect(text).toContain('🟢 修=修女');
    expect(text).toContain('🔴 巨1=巨鼠1');
    expect(text).toContain('⚪ 倒地：卡厄斯');
    expect(text).toContain('🧱 挡路：石棺；难行：碎石');
  });

  it('探索地图：你们在哪、能去哪', () => {
    const c = createCampaign('k', adv);
    const text = mapCaption(c, adv, 'book');
    expect(text).toContain('📍 红点是你们');
    expect(text).toMatch(/🚪 能去：/);
  });
});

describe('战斗图图例的小改进', () => {
  const scene = (names: string[], areas: unknown[] = []) => {
    const c = createCampaign('k', adv);
    const room = c.currentRoom;
    c.characters = names.map((name) => ({ name, kind: 'monster', hp: 10, maxHp: 10, tempHp: 0, ac: 12, conditions: [], room })) as never;
    c.initiative = { round: 1, turn: 0, order: [], positions: Object.fromEntries(names.map((n, i) => [n, { x: i, y: 0, room }])) } as never;
    c.battlemaps = { [room]: { width: 10, height: 3, areas } } as never;
    return mapCaption(c, adv, 'battle');
  };

  it('同名带编号的怪合成一条；编号不连续就列出来；只有一只照旧', () => {
    expect(scene(['翼手族1', '翼手族2', '翼手族3'])).toContain('🔴 翼1–3=翼手族');
    expect(scene(['翼手族1', '翼手族3', '巨鼠2'])).toContain('🔴 翼1,3=翼手族 巨2=巨鼠2');
  });

  it('说明门和门外', () => {
    const text = scene(['巨鼠1'], [{ kind: 'door', x: 0, y: 2, name: '大门' }, { kind: 'outside', x: 0, y: 1 }]);
    expect(text).toContain('🚪 棕色格是门：大门；门外的格子也能站人');
  });
});
