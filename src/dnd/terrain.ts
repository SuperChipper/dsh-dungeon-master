/**
 * 战斗场地图：一个房间在 5 尺网格上的墙、门、障碍、难行地形。
 *
 * 模组里的房间只有大地图上的一个框，开战时模型只能在空地上摆人：门是半路补的、「退到门外」
 * 在格子上表示不了、墙不存在所以卡门口这类战术没法判。场地图按房间存在战役档里，
 * 打完仗也留着，再进这间沿用同一张。模组可以在房间上预写 battlemap，没有就由 DM 开战时画。
 *
 * 门外的走廊也画在同一张图上（kind=outside）：站在那里的人还算这个房间，距离和借机照常算。
 * 这里只管几何，不认识角色；谁挡路由调用方传 blocked。
 */

export type TerrainKind = 'wall' | 'object' | 'difficult' | 'door' | 'outside';
export const TERRAIN_KINDS: readonly TerrainKind[] = ['wall', 'object', 'difficult', 'door', 'outside'];

export interface TerrainArea {
  kind: TerrainKind;
  x: number;
  y: number;
  /** 宽高（格），默认 1 */
  w?: number;
  h?: number;
  /** 熔炉、干水渠、门(通11)；object 必填，其余有默认名 */
  name?: string;
  /** 门/门外通往的房间 id */
  to?: string;
}

export interface BattleMap {
  width: number;
  height: number;
  /** 后写的盖住先写的：先画整面墙，再在墙上开门 */
  areas: TerrainArea[];
}

export interface Cell {
  x: number;
  y: number;
}

const MAX_SIDE = 40;
const CELL_FEET = 5;
const DEFAULT_NAMES: Record<TerrainKind, string> = { wall: '墙', object: '障碍', difficult: '难行地形', door: '门', outside: '门外' };

export function areaName(area: TerrainArea): string {
  return area.name ?? DEFAULT_NAMES[area.kind];
}

function intIn(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} 要是 ${min}-${max} 的整数，收到 ${String(value)}`);
  }
  return value;
}

/** 校验并规整（模型传的和模组里写的都走这里）；越界、缺名字直接报错，别存一张画不出来的图 */
export function parseBattleMap(input: unknown): BattleMap {
  const o = (input ?? {}) as Record<string, unknown>;
  const width = intIn(o.width, 1, MAX_SIDE, 'width');
  const height = intIn(o.height, 1, MAX_SIDE, 'height');
  const rawAreas = o.areas === undefined ? [] : o.areas;
  if (!Array.isArray(rawAreas)) throw new Error('areas 要是数组');
  const areas = rawAreas.map((raw, i): TerrainArea => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const kind = a.kind as TerrainKind;
    if (!TERRAIN_KINDS.includes(kind)) throw new Error(`areas[${i}].kind 要是 ${TERRAIN_KINDS.join('/')} 之一，收到 ${String(a.kind)}`);
    const x = intIn(a.x, 0, width - 1, `areas[${i}].x`);
    const y = intIn(a.y, 0, height - 1, `areas[${i}].y`);
    const w = a.w === undefined ? 1 : intIn(a.w, 1, width - x, `areas[${i}].w（从 x=${x} 起最多到右边界）`);
    const h = a.h === undefined ? 1 : intIn(a.h, 1, height - y, `areas[${i}].h（从 y=${y} 起最多到下边界）`);
    const name = typeof a.name === 'string' && a.name.trim().length > 0 ? a.name.trim() : undefined;
    if (kind === 'object' && name === undefined) throw new Error(`areas[${i}] 是 object，要给 name（熔炉、石柱…）`);
    const to = typeof a.to === 'string' && a.to.trim().length > 0 ? a.to.trim() : undefined;
    return { kind, x, y, ...(w !== 1 ? { w } : {}), ...(h !== 1 ? { h } : {}), ...(name !== undefined ? { name } : {}), ...(to !== undefined ? { to } : {}) };
  });
  return { width, height, areas };
}

export function inBounds(map: BattleMap, at: Cell): boolean {
  return at.x >= 0 && at.y >= 0 && at.x < map.width && at.y < map.height;
}

function covers(area: TerrainArea, at: Cell): boolean {
  return at.x >= area.x && at.x < area.x + (area.w ?? 1) && at.y >= area.y && at.y < area.y + (area.h ?? 1);
}

/** 这一格的地形（没写的就是空地）；后写的优先 */
export function areaAt(map: BattleMap, at: Cell): TerrainArea | undefined {
  for (let i = map.areas.length - 1; i >= 0; i--) {
    if (covers(map.areas[i]!, at)) return map.areas[i];
  }
  return undefined;
}

/** 走不进去：图外、墙、障碍物 */
export function blocksMove(map: BattleMap | undefined, at: Cell): boolean {
  if (map === undefined) return false;
  if (!inBounds(map, at)) return true;
  const kind = areaAt(map, at)?.kind;
  return kind === 'wall' || kind === 'object';
}

export function areaCells(map: BattleMap, area: TerrainArea): Cell[] {
  const cells: Cell[] = [];
  for (let y = area.y; y < area.y + (area.h ?? 1); y++) {
    for (let x = area.x; x < area.x + (area.w ?? 1); x++) {
      // 被后面的区域盖掉的格子不算它的（墙上开了门，那格就是门）
      if (areaAt(map, { x, y }) === area) cells.push({ x, y });
    }
  }
  return cells;
}

/** 按名字找地形：先全等，再用通往的房间 id，最后按包含关系找 */
export function findArea(map: BattleMap, query: string): TerrainArea | undefined {
  const q = query.trim();
  const named = map.areas.filter((a) => a.kind !== 'wall');
  return named.find((a) => areaName(a) === q)
    ?? named.find((a) => a.to === q)
    // 「门」同时包含在「门(通B)」和「门外(通B)」里：取名字最短的那个，离原话最近
    ?? named.filter((a) => areaName(a).includes(q) || q.includes(areaName(a))).sort((a, b) => areaName(a).length - areaName(b).length)[0];
}

export function chebyshevFeet(a: Cell, b: Cell): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * CELL_FEET;
}

export interface Reach {
  /** 到这一格的尺数 */
  feet: number;
  /** 路上离开了几次敌人的触及（同样尺数时选少的，像真人会绕着走） */
  provokes: number;
  prev?: string;
}

export interface WalkOptions {
  /** 被敌人占着的格子：5e 不能穿过敌人 */
  blocked: (at: Cell) => boolean;
  /** 走这一步会离开几个敌人的触及 */
  provokes?: (from: Cell, to: Cell) => number;
  /** 拖人时每格算双倍 */
  costFactor?: number;
  /** 最多走多少尺（含）；不给就不限 */
  maxFeet?: number;
}

const key = (at: Cell): string => `${at.x},${at.y}`;
const STEPS: readonly Cell[] = [
  { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
  { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 },
];
/** 没有场地图时也给个边，免得无限扩展 */
const OPEN_MAX = 99;

/**
 * 从 from 出发能走到的每一格和最省的走法（Dijkstra，八方向，斜走也算 5 尺）。
 * 难行地形进去算 10 尺；斜着穿墙角（两边都是墙）不行。
 */
export function walk(map: BattleMap | undefined, from: Cell, options: WalkOptions): Map<string, Reach> {
  const factor = options.costFactor ?? 1;
  const best = new Map<string, Reach>([[key(from), { feet: 0, provokes: 0 }]]);
  const open: Array<Cell & Reach> = [{ ...from, feet: 0, provokes: 0 }];
  const passable = (at: Cell): boolean => {
    if (map === undefined) return at.x >= 0 && at.y >= 0 && at.x <= OPEN_MAX && at.y <= OPEN_MAX;
    return !blocksMove(map, at);
  };
  while (open.length > 0) {
    open.sort((a, b) => a.feet - b.feet || a.provokes - b.provokes);
    const cur = open.shift()!;
    const known = best.get(key(cur))!;
    if (cur.feet > known.feet || (cur.feet === known.feet && cur.provokes > known.provokes)) continue;
    for (const step of STEPS) {
      const next = { x: cur.x + step.x, y: cur.y + step.y };
      if (!passable(next) || options.blocked(next)) continue;
      if (step.x !== 0 && step.y !== 0 && map !== undefined
        && blocksMove(map, { x: cur.x + step.x, y: cur.y }) && blocksMove(map, { x: cur.x, y: cur.y + step.y })) continue;
      const enter = map !== undefined && areaAt(map, next)?.kind === 'difficult' ? 2 * CELL_FEET : CELL_FEET;
      const feet = cur.feet + enter * factor;
      if (options.maxFeet !== undefined && feet > options.maxFeet) continue;
      const provokes = cur.provokes + (options.provokes?.(cur, next) ?? 0);
      const old = best.get(key(next));
      if (old !== undefined && (old.feet < feet || (old.feet === feet && old.provokes <= provokes))) continue;
      best.set(key(next), { feet, provokes, prev: key(cur) });
      open.push({ ...next, feet, provokes });
    }
  }
  return best;
}

/** walk 的结果里回溯出一条路（含起点终点） */
export function pathTo(reached: Map<string, Reach>, to: Cell): Cell[] | undefined {
  if (!reached.has(key(to))) return undefined;
  const path: Cell[] = [];
  let cur: string | undefined = key(to);
  while (cur !== undefined) {
    const [x, y] = cur.split(',').map(Number);
    path.unshift({ x: x!, y: y! });
    cur = reached.get(cur)!.prev;
  }
  return path;
}

export function cellKey(at: Cell): string {
  return key(at);
}

export function parseKey(k: string): Cell {
  const [x, y] = k.split(',').map(Number);
  return { x: x!, y: y! };
}

/** 摆位用：离 anchor 最近、能站人的空格（按格数一圈圈往外找） */
export function nearestFree(map: BattleMap | undefined, anchors: readonly Cell[], taken: (at: Cell) => boolean): Cell | undefined {
  const limit = map === undefined ? 10 : Math.max(map.width, map.height);
  for (let r = 0; r <= limit; r++) {
    const ring: Cell[] = [];
    for (const a of anchors) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          ring.push({ x: a.x + dx, y: a.y + dy });
        }
      }
    }
    // 同一圈里先取正交方向的（离锚点的直线距离近），结果稳定
    ring.sort((p, q) => {
      const dp = Math.min(...anchors.map((a) => (p.x - a.x) ** 2 + (p.y - a.y) ** 2));
      const dq = Math.min(...anchors.map((a) => (q.x - a.x) ** 2 + (q.y - a.y) ** 2));
      return dp - dq || p.y - q.y || p.x - q.x;
    });
    const hit = ring.find((at) => at.x >= 0 && at.y >= 0 && at.x <= OPEN_MAX && at.y <= OPEN_MAX && !blocksMove(map, at) && !taken(at));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** 直线上有没有墙/障碍挡着（隔墙够不着、射不到），不算两端 */
export function wallBetween(map: BattleMap | undefined, a: Cell, b: Cell): TerrainArea | undefined {
  if (map === undefined) return undefined;
  const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  for (let i = 1; i < steps; i++) {
    const at = { x: Math.round(a.x + ((b.x - a.x) * i) / steps), y: Math.round(a.y + ((b.y - a.y) * i) / steps) };
    const area = areaAt(map, at);
    if (area?.kind === 'wall' || area?.kind === 'object') return area;
  }
  return undefined;
}

/** 给 DM 的一行：有名字的地形和位置（墙不列，太长） */
export function terrainLine(map: BattleMap): string {
  const parts = map.areas
    .filter((a) => a.kind !== 'wall')
    .map((a) => {
      const w = a.w ?? 1;
      const h = a.h ?? 1;
      const span = w === 1 && h === 1 ? `(${a.x},${a.y})` : `(${a.x}-${a.x + w - 1},${a.y}-${a.y + h - 1})`;
      const tag = a.kind === 'difficult' ? '难行' : a.kind === 'object' ? '挡路' : a.kind === 'outside' ? '门外' : '门';
      return `${areaName(a)}${span}${areaName(a).includes(tag) ? '' : `[${tag}]`}`;
    });
  return `场地 ${map.width}×${map.height}${parts.length > 0 ? `：${parts.join('、')}` : ''}`;
}
