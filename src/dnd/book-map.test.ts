import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Adventure, validateAdventure } from './adventure.ts';
import { buildFogSvg, cropBox, planFog, renderBookMap } from './book-map.ts';
import type { Campaign } from './campaign.ts';

const room = (id: string, exits: { to: string; label: string }[] = []) => ({
  id, name: id, x: 0, y: 0, w: 2, h: 2, playerView: '', dmNotes: '', exits,
});

function adventure(maps: unknown, dir = '/mods/demo'): Adventure {
  const adv = validateAdventure({
    id: 'demo',
    name: 'demo',
    start: 'a',
    sites: [
      { id: 'cave', name: 'cave', entry: 'a', rooms: [room('a', [{ to: 'b', label: '门' }]), room('b', [{ to: 'c', label: '门' }]), room('c')], maps },
      { id: 'town', name: 'town', kind: 'hub', entry: 'square', rooms: [room('square'), room('inn')], maps: [{ image: 'town.png', reveal: 'full', rooms: { square: [10, 10, 20, 20] } }] },
    ],
  });
  adv.dir = dir;
  return adv;
}

const campaign = (currentRoom: string, revealed: string[]): Campaign => ({ currentRoom, revealed, characters: [] }) as unknown as Campaign;

const CAVE = [{ image: 'cave.png', rooms: { a: [0, 0, 100, 100], b: [[100, 0, 100, 100], [200, 40, 50, 20]], c: [400, 400, 100, 100] } }];

describe('书里的地图：迷雾', () => {
  it('只露出去过的房间，标记在当前房间第一个矩形的中心', () => {
    const plan = planFog(campaign('b', ['a', 'b']), adventure(CAVE))!;
    expect(plan.shown).toEqual([[0, 0, 100, 100], [100, 0, 100, 100], [200, 40, 50, 20]]);
    expect(plan.markers).toEqual([{ x: 150, y: 50, count: 0 }]);
    expect(plan.image.replace(/\\/g, '/')).toMatch(/\/mods\/demo\/cave\.png$/);
  });

  it('裁剪框只包住露出来的部分，外扩后夹在图内', () => {
    const plan = planFog(campaign('a', ['a']), adventure(CAVE))!;
    expect(cropBox(plan, 1000, 1000)).toEqual({ left: 0, top: 0, width: 180, height: 180 });
  });

  it('遮罩里只有露出来的矩形', () => {
    const svg = buildFogSvg(planFog(campaign('a', ['a']), adventure(CAVE))!, 1000, 1000);
    expect(svg).toContain('mask="url(#fog)"');
    expect(svg.match(/fill="black"/g)).toHaveLength(1);
  });

  it('full 图整张发、不裁，没标位置的地方也用它但不画标记', () => {
    const adv = adventure(CAVE);
    const atSquare = planFog(campaign('square', ['square']), adv)!;
    expect(atSquare.shown).toEqual([]);
    expect(cropBox(atSquare, 800, 600)).toEqual({ left: 0, top: 0, width: 800, height: 600 });
    expect(buildFogSvg(atSquare, 800, 600)).not.toContain('mask');
    const atInn = planFog(campaign('inn', ['square', 'inn']), adv)!;
    expect(atInn.map.image).toBe('town.png');
    expect(atInn.markers).toEqual([]);
  });

  it('场景没有地图、单文件模组、或图片路径跑出模组目录时返回 undefined', () => {
    expect(planFog(campaign('a', ['a']), adventure(undefined))).toBeUndefined();
    const single = adventure(CAVE);
    delete single.dir;
    expect(planFog(campaign('a', ['a']), single)).toBeUndefined();
    const escape = adventure([{ image: '../../secret.png', rooms: { a: [0, 0, 10, 10] } }]);
    expect(planFog(campaign('a', ['a']), escape)).toBeUndefined();
  });
});

describe('书里的地图：校验', () => {
  it('拒绝标了别的场景房间、或矩形写错的地图', () => {
    expect(() => adventure([{ image: 'x.png', rooms: { square: [0, 0, 10, 10] } }])).toThrow(/不属于本场景/);
    expect(() => adventure([{ image: 'x.png', rooms: { a: [0, 0, 10] } }])).toThrow(/\[x, y, 宽, 高\]/);
    expect(() => adventure([{ image: 'x.png', reveal: 'all', rooms: {} }])).toThrow(/fog 或 full/);
  });
});

describe('书里的地图：渲染', () => {
  it('合成迷雾并裁到露出来的那一片，输出 JPEG', async () => {
    let sharp: ((input: unknown) => any) | undefined;
    try {
      const mod = await import('sharp');
      sharp = ((mod as { default?: unknown }).default ?? mod) as (input: unknown) => any;
    } catch {
      return; // sharp 是可选依赖，装不上时跳过
    }
    const dir = mkdtempSync(join(tmpdir(), 'book-map-'));
    const png = await sharp({ create: { width: 1000, height: 800, channels: 3, background: '#88aa88' } }).png().toBuffer();
    writeFileSync(join(dir, 'cave.png'), png);
    const out = await renderBookMap(campaign('a', ['a']), adventure(CAVE, dir), join(dir, 'out.png'));
    expect(out).toMatch(/out\.jpg$/);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([180, 180]);
  });
});
