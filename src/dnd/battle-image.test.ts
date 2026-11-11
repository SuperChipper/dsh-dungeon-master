import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Adventure, validateAdventure } from './adventure.ts';
import { buildBattleSvg, renderBattleImage, roomTokens, tokenLabels } from './battle-image.ts';
import { setBattleMap } from './battlefield.ts';
import { type Campaign, createCampaign } from './campaign.ts';
import { areaAt, blocksMove, parseBattleMap } from './terrain.ts';

function adventure(dir?: string): Adventure {
  const adv = validateAdventure({
    id: 'demo',
    name: 'demo',
    start: 'hall',
    sites: [{ id: 'crypt', name: 'crypt', entry: 'hall', rooms: [{ id: 'hall', name: '大厅', x: 0, y: 0, w: 4, h: 4, playerView: '', dmNotes: '', exits: [] }] }],
  });
  if (dir !== undefined) adv.dir = dir;
  return adv;
}

const person = (name: string, kind: 'pc' | 'npc' | 'monster', hp = 10) => ({ name, kind, hp, maxHp: 10, tempHp: 0, ac: 12, conditions: [] as string[], room: 'hall' });

function fight(people: [ReturnType<typeof person>, number, number][], current: string): Campaign {
  const c = createCampaign('k', adventure());
  c.characters = people.map(([p]) => p) as unknown as Campaign['characters'];
  c.initiative = {
    round: 1,
    turn: people.findIndex(([p]) => p.name === current),
    order: people.map(([p], i) => ({ name: p.name, init: 10 - i })),
    positions: Object.fromEntries(people.map(([p, x, y]) => [p.name, { x, y, room: 'hall' }])),
  } as Campaign['initiative'];
  return c;
}

describe('战斗图：标签和站位', () => {
  it('人用第一个字，怪物带编号，撞了多取一个字', () => {
    const labels = tokenLabels([
      { name: '艾琳', monster: false },
      { name: '艾德', monster: false },
      { name: '巨鼠1', monster: true },
      { name: '巨鼠2', monster: true },
    ]);
    expect([...labels.values()]).toEqual(['艾', '艾德', '巨1', '巨2']);
  });

  it('藏起来的怪不画，倒地的画灰，当前行动者有标记', () => {
    const c = fight([[person('艾琳', 'pc'), 1, 1], [person('卡厄斯', 'pc', 0), 2, 1], [person('影魔', 'monster'), 3, 3]], '艾琳');
    const tokens = roomTokens(c, 'hall', (ch) => ch.name !== '影魔');
    expect(tokens.map((t) => [t.name, t.x, t.y, t.down, t.current])).toEqual([['艾琳', 1, 1, false, true], ['卡厄斯', 2, 1, true, false]]);
  });
});

describe('战斗图：底图和规则', () => {
  const art = { image: 'map.png', left: 10, top: 20, cell: 50, shade: [[0, 0, 4, 1]] };

  it('art 解析保留，shade 的格子规则上算墙，画在上面的门照样优先', () => {
    const map = parseBattleMap({ width: 4, height: 4, areas: [{ kind: 'door', x: 1, y: 0, name: '北门', to: 'x' }], art });
    expect(map.art?.shade).toEqual([[0, 0, 4, 1]]);
    expect(blocksMove(map, { x: 0, y: 0 })).toBe(true);
    expect(areaAt(map, { x: 1, y: 0 })?.kind).toBe('door');
    expect(blocksMove(map, { x: 1, y: 1 })).toBe(false);
  });

  it('拒绝越界的 shade 和缺 image 的 art', () => {
    expect(() => parseBattleMap({ width: 4, height: 4, art: { ...art, shade: [[3, 0, 2, 1]] } })).toThrow(/shade/);
    expect(() => parseBattleMap({ width: 4, height: 4, art: { left: 0, top: 0, cell: 50 } })).toThrow(/image/);
  });

  it('DM 同尺寸重画时保留底图，改了尺寸就丢掉', () => {
    const c = createCampaign('k', adventure());
    setBattleMap(c, 'hall', { width: 4, height: 4, art });
    setBattleMap(c, 'hall', { width: 4, height: 4, areas: [{ kind: 'object', x: 2, y: 2, name: '石柱' }] });
    expect(c.battlemaps?.hall?.art?.image).toBe('map.png');
    setBattleMap(c, 'hall', { width: 5, height: 4 });
    expect(c.battlemaps?.hall?.art).toBeUndefined();
  });

  it('没有底图时把地形画出来，有底图时墙交给底图', () => {
    const map = parseBattleMap({ width: 3, height: 3, areas: [{ kind: 'wall', x: 0, y: 0, w: 3 }, { kind: 'object', x: 1, y: 1, name: '石柱' }] });
    const drawn = buildBattleSvg(map, [], '大厅', false);
    expect(drawn).toContain('#3b3c42');
    expect(drawn).toContain('石柱');
    expect(buildBattleSvg(map, [], '大厅', true)).not.toContain('#3b3c42');
  });
});

describe('战斗图：渲染', () => {
  it('有底图就裁出这间屋叠上人，没有就画格子图；都输出 JPEG', async () => {
    let sharp: ((input: unknown) => any) | undefined;
    try {
      const mod = await import('sharp');
      sharp = ((mod as { default?: unknown }).default ?? mod) as (input: unknown) => any;
    } catch {
      return; // sharp 是可选依赖
    }
    const dir = mkdtempSync(join(tmpdir(), 'battle-image-'));
    writeFileSync(join(dir, 'map.png'), await sharp({ create: { width: 400, height: 400, channels: 3, background: '#aaaaaa' } }).png().toBuffer());
    const c = fight([[person('艾琳', 'pc'), 1, 1]], '艾琳');
    const adv = adventure(dir);
    setBattleMap(c, 'hall', { width: 4, height: 3, art: { image: 'map.png', left: 10, top: 20, cell: 50 } });
    const withArt = await renderBattleImage(c, adv, 'hall', '第 1 轮 · 大厅', join(dir, 'a.png'), () => true);
    const meta = await sharp(withArt).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([24 + 4 * 48, 40 + 24 + 3 * 48]);

    setBattleMap(c, 'hall', { width: 5, height: 3 });
    const drawn = await renderBattleImage(c, adv, 'hall', '大厅', join(dir, 'b.png'), () => true);
    expect((await sharp(drawn).metadata()).width).toBe(24 + 5 * 48);

    const empty = createCampaign('k', adv);
    expect(await renderBattleImage(empty, adv, 'hall', '大厅', join(dir, 'c.png'), () => true)).toBeUndefined();
  });
});
