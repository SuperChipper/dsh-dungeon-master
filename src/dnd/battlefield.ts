/**
 * 战斗内站位：Character.room 只管在哪个房间，同一房间里谁离谁多远以前只活在模型的叙述里，
 * 上下文一压缩就走样，借机、贴身这类裁定跟着判错。这里把坐标存进 InitiativeState，
 * 团况每次都带，距离和借机由代码算，不靠模型回忆。
 *
 * 一格 5 尺，x 向东、y 向南；斜走也算 5 尺（5e 默认规则；2026-11-07 本桌定了不改 DMG 的 5-10-5 变体）。
 * 只提醒不拦截的地方是故意的：冲刺、触及武器、特性都可能让「超速」「够不到」其实合法，那是 DM 的裁量。
 */
import {
  type BattleCell,
  type Campaign,
  type Character,
  type InitiativeState,
  type Weapon,
  type ReactorOption,
  changeCondition,
  findCharacter,
  isOut,
  isRangedWeapon,
  inInitiative,
  pushLog,
  reactionBlocked,
  reactionsOf,
  requireCharacter,
  requireInitiative,
  roomOf,
} from './campaign.ts';
import {
  breakConcentration,
  concentratingOn,
  concentratingZoneNames,
  ensureTurnState,
  hasCondition,
  isIncapacitated,
  movementSpeedInfo,
} from './conditions.ts';
import type { CustomEffectDef } from './custom-effects.ts';
import { cryptoRoller, type Roller } from './dice.ts';
import {
  type BattleZone,
  createBattleZoneInput,
  extraCellCostMultiplier,
  formatZonePlayerLegend,
  formatZoneSummary,
  isCellHeavilyObscured,
  settleMovementHazards,
  zonesAtCell,
  zonesInRoom,
} from './zones.ts';
import {
  type BattleMap,
  type Cell,
  areaAt,
  areaCells,
  areaName,
  blocksMove,
  cellKey,
  findArea,
  nearestFree,
  parseBattleMap,
  parseKey,
  pathTo,
  terrainLine,
  walk,
  wallBetween,
} from './terrain.ts';

export const CELL_FEET = 5;
export const DEFAULT_SPEED = 30;
const MELEE_REACH_FEET = 5;
const MAX_COORD = 99;
const MAX_ALTITUDE_FEET = 300;

export function distanceFeet(
  a: { x: number; y: number; z?: number },
  b: { x: number; y: number; z?: number },
): number {
  return Math.max(
    Math.abs(a.x - b.x) * CELL_FEET,
    Math.abs(a.y - b.y) * CELL_FEET,
    Math.abs((a.z ?? 0) - (b.z ?? 0)),
  );
}

function fmtCoord(cell: { x: number; y: number; z?: number }): string {
  return (cell.z ?? 0) > 0 ? `(${cell.x},${cell.y},↑${cell.z}尺)` : `(${cell.x},${cell.y})`;
}

/** 角色当前的格子；换过房间后旧坐标作废（room 对不上就当没摆位，比沿用错坐标安全） */
export function cellOf(c: Campaign, ch: Character): BattleCell | undefined {
  const cell = c.initiative?.positions?.[ch.name];
  return cell !== undefined && cell.room === roomOf(c, ch) ? cell : undefined;
}

function isHostile(a: Character, b: Character): boolean {
  return (a.kind === 'monster') !== (b.kind === 'monster');
}

export function canReact(ch: Character): boolean {
  return !isOut(ch) && ch.hp > 0 && !isIncapacitated(ch);
}

/** 房间字段不能成为绕过战场路线、借机和出口位置的捷径。 */
export function assertCombatExit(c: Campaign, ch: Character, targetRoom: string): void {
  if (!inInitiative(c, ch.name) || roomOf(c, ch) === targetRoom) return;
  const at = cellOf(c, ch);
  const map = at === undefined ? undefined : mapOf(c, at.room);
  const area = at === undefined || map === undefined ? undefined : areaAt(map, at);
  if (area === undefined || !['door', 'outside'].includes(area.kind) || area.to !== targetRoom) {
    throw new Error(`${ch.name} 还没走到通往 ${targetRoom} 的出口。战斗中先 dnd_position move 到门口/门外并处理借机，再换 room；没有出口格就先 terrain 标出 door/outside 和 to。不能用改卡代替逃跑路线。`);
  }
}

/** 这个房间里已摆位、还活着的人 */
function placedIn(c: Campaign, room: string): Array<{ ch: Character; cell: BattleCell }> {
  return c.characters.flatMap((ch) => {
    const cell = cellOf(c, ch);
    return cell !== undefined && cell.room === room && !isOut(ch) ? [{ ch, cell }] : [];
  });
}

function occupant(c: Campaign, room: string, at: { x: number; y: number; z?: number }, except: string): Character | undefined {
  const az = at.z ?? 0;
  return placedIn(c, room).find(({ ch, cell }) => ch.name !== except && cell.x === at.x && cell.y === at.y && (cell.z ?? 0) === az)?.ch;
}

function requireCoord(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COORD) {
    throw new Error(`${label} 要是 0-${MAX_COORD} 的整数格子（一格 5 尺），收到 ${String(value)}`);
  }
  return value;
}

function requireAltitude(value: unknown, label: string, ceiling?: number): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_ALTITUDE_FEET || value % CELL_FEET !== 0) {
    throw new Error(`${label} 要是 0-${MAX_ALTITUDE_FEET} 且为 5 的整数倍（离地尺数，如 0 / 15 / 30），收到 ${String(value)}`);
  }
  if (ceiling !== undefined && value > ceiling) {
    throw new Error(`房间层高上限为 ${ceiling} 尺，不能升空到 ${value} 尺`);
  }
  return value;
}

export interface Placement {
  name: string;
  x?: number;
  y?: number;
  /** 离地高度（尺，5 的非负整数倍；缺省为 0 地面） */
  z?: number;
  /** 不给坐标时：摆在这个人/地标/地形（门）旁边最近的空格，按 placements 的顺序一个个占 */
  near?: string;
  /** 不是角色卡上的东西：门、柱子、没建卡的俘虏 */
  mark?: boolean;
}

/** 这个房间的战斗场地图（没画过就是 undefined：空地，不限边界） */
export function mapOf(c: Campaign, room: string): BattleMap | undefined {
  return c.battlemaps?.[room];
}

function sameSize(a: BattleMap, b: BattleMap): boolean {
  return a.width === b.width && a.height === b.height;
}

/** 画/重画一个房间的场地图；返回站在墙里、障碍里的人，让 DM 挪出来 */
export function setBattleMap(c: Campaign, room: string, input: unknown): { map: BattleMap; misplaced: string[] } {
  const map = parseBattleMap(input);
  // DM 在模组底图上补门、补障碍时只会重画 areas；尺寸没变就还是同一张底图，别把它丢了
  const previous = mapOf(c, room)?.art;
  if (map.art === undefined && previous !== undefined && sameSize(mapOf(c, room)!, map)) map.art = previous;
  for (const area of map.areas) {
    if (area.to !== undefined && area.to === room) throw new Error(`${areaName(area)} 的 to 是这个房间自己（${room}），应该填门通往的房间`);
  }
  (c.battlemaps ??= {})[room] = map;
  const misplaced = c.initiative === undefined
    ? []
    : placedIn(c, room).filter(({ cell }) => blocksMove(map, cell)).map(({ ch, cell }) => `${ch.name}(${cell.x},${cell.y})`);
  return { map, misplaced };
}

/** 清除房间中临时手绘的场地图：模组自带底图则恢复模组版，否则清空 */
export function clearBattleMap(c: Campaign, room: string, authored?: BattleMap): BattleMap | undefined {
  if (authored !== undefined) {
    const restored = structuredClone(authored);
    (c.battlemaps ??= {})[room] = restored;
    return restored;
  }
  if (c.battlemaps !== undefined) {
    delete c.battlemaps[room];
    if (Object.keys(c.battlemaps).length === 0) delete c.battlemaps;
  }
  return undefined;
}

/** 一个地点名对应的格子：同房间的人 → 地标 → 地形区域 */
function spotCells(c: Campaign, room: string, query: string): { cells: Cell[]; blocking: boolean; label: string; who?: Character } | undefined {
  const ch = findCharacter(c, query);
  if (ch !== undefined) {
    const cell = cellOf(c, ch);
    if (cell !== undefined && cell.room === room) return { cells: [cell], blocking: true, label: ch.name, who: ch };
  }
  const mark = Object.entries(c.initiative?.marks ?? {}).find(([n, m]) => m.room === room && (n === query || n.includes(query)));
  if (mark !== undefined) return { cells: [mark[1]], blocking: false, label: mark[0] };
  const map = mapOf(c, room);
  const area = map === undefined ? undefined : findArea(map, query);
  if (map !== undefined && area !== undefined) {
    return { cells: areaCells(map, area), blocking: area.kind === 'wall' || area.kind === 'object', label: areaName(area) };
  }
  return undefined;
}

function unknownSpot(c: Campaign, room: string, query: string): Error {
  const map = mapOf(c, room);
  const names = [
    ...placedIn(c, room).map(({ ch }) => ch.name),
    ...Object.entries(c.initiative?.marks ?? {}).filter(([, m]) => m.room === room).map(([n]) => n),
    ...(map?.areas.filter((a) => a.kind !== 'wall').map(areaName) ?? []),
  ];
  return new Error(`这个房间里找不到「${query}」。能用的：${[...new Set(names)].join('、') || '（还没有人摆位、也没有场地图）'}`);
}

/** 摆位/修正：不算移动力、不触发借机。开战摆位、强制位移（推、拖）、纠错都走这里 */
export function setPositions(c: Campaign, placements: readonly Placement[]): string[] {
  const state = requireInitiative(c);
  if (placements.length === 0) throw new Error('set 要给 placements');
  const notes: string[] = [];
  for (const p of placements) {
    if (p.mark === true) {
      const x = requireCoord(p.x, `${p.name} 的 x`);
      const y = requireCoord(p.y, `${p.name} 的 y`);
      const room = markRoom(c, state);
      (state.marks ??= {})[p.name] = { x, y, room };
      continue;
    }
    const ch = requireCharacter(c, p.name);
    const room = roomOf(c, ch);
    if (room === undefined) throw new Error(`${ch.name} 没有所在房间，先 dnd_character update room`);
    const map = mapOf(c, room);
    const z = requireAltitude(p.z, `${p.name} 的 z`, map?.ceiling);
    let at: Cell;
    if (p.x === undefined && p.y === undefined && p.near !== undefined) {
      const spot = spotCells(c, room, p.near);
      if (spot === undefined) throw unknownSpot(c, room, p.near);
      const taken = (cell: Cell): boolean => occupant(c, room, { ...cell, z }, ch.name) !== undefined || (spot.blocking && z < 15 && spot.cells.some((s) => s.x === cell.x && s.y === cell.y));
      const free = nearestFree(map, spot.cells, taken);
      if (free === undefined) throw new Error(`${spot.label} 附近没有空格了`);
      at = free;
    } else {
      at = { x: requireCoord(p.x, `${p.name} 的 x`), y: requireCoord(p.y, `${p.name} 的 y`) };
      if (blocksMove(map, at, z >= 15)) throw new Error(`(${at.x},${at.y}) 是${map === undefined ? '' : terrainHere(map, at)}，${ch.name} 站不上去；换一格，或用 near`);
    }
    (state.positions ??= {})[ch.name] = { x: at.x, y: at.y, ...(z > 0 ? { z } : {}), room };
    if (z > 0 && (ch.flySpeed ?? 0) <= 0 && ch.hover !== true && !hasCondition(ch, '飞行术')) {
      notes.push(`【DM】${ch.name} 置于高空 ↑${z}尺，但角色卡未记录 fly_speed 且未挂「飞行术」；若天生会飞请用 dnd_character update fly_speed=60 补齐。`);
    }
  }
  // 全部放好再查重叠：同一次调用里两个人互换位置不算冲突
  for (const p of placements) {
    if (p.mark === true) continue;
    const ch = requireCharacter(c, p.name);
    const cell = state.positions![ch.name]!;
    const other = occupant(c, cell.room, cell, ch.name);
    if (other !== undefined && !notes.some((n) => n.includes(ch.name) && n.includes('同一格'))) {
      notes.push(`【DM】${ch.name} 和 ${other.name} 在同一格 ${fmtCoord(cell)}，不是故意的话改一下。`);
    }
  }
  return notes;
}

function terrainHere(map: BattleMap, at: Cell): string {
  const area = areaAt(map, at);
  return area === undefined ? (blocksMove(map, at) ? '场地外' : '空地') : areaName(area);
}

/** 标记跟着当前行动者的房间走；战斗跨房间时它才是 DM 正在描述的那一间 */
function markRoom(c: Campaign, state: InitiativeState): string {
  const current = state.order[state.turn];
  const ch = current === undefined ? undefined : findCharacter(c, current.name);
  return (ch === undefined ? undefined : roomOf(c, ch)) ?? c.currentRoom;
}

export function removePosition(c: Campaign, name: string): string {
  const state = requireInitiative(c);
  if (state.marks?.[name] !== undefined) {
    delete state.marks[name];
    return `已移除标记 ${name}`;
  }
  const ch = requireCharacter(c, name);
  delete state.positions?.[ch.name];
  return `${ch.name} 已从站位上拿掉`;
}

/** 放置或更新战场持续区域效果（黑暗术、毒雾、蛛网术、荆棘丛生、月华之光等） */
export function upsertBattleZone(
  c: Campaign,
  raw: Omit<Parameters<typeof createBattleZoneInput>[0], 'room'> & { room?: string },
): { zone: BattleZone; broken: string[]; affected: string[] } {
  const state = requireInitiative(c);
  const caster = raw.source !== undefined ? requireCharacter(c, raw.source) : undefined;
  const room = raw.room ?? (caster !== undefined ? roomOf(c, caster) : undefined) ?? markRoom(c, state);
  const x = requireCoord(raw.x, '区域 x');
  const y = requireCoord(raw.y, '区域 y');
  const seqHint = (state.zones?.length ?? 0) + 1;
  const zone = createBattleZoneInput({ ...raw, room, x, y, ...(caster !== undefined ? { source: caster.name } : {}) }, seqHint);

  const broken: string[] = [];
  if (zone.concentration === true && zone.source !== undefined) {
    const prevStates = concentratingOn(c, zone.source).filter((s) => s.state.name !== zone.name);
    const prevZones = concentratingZoneNames(c, zone.source).filter((zName) => zName !== zone.name);
    if (prevStates.length > 0 || prevZones.length > 0) {
      broken.push(...breakConcentration(c, zone.source, `改换专注为「${zone.name}」`));
      for (const line of broken) pushLog(c, line);
    }
  }

  const existing = (state.zones ?? []).filter((z) => {
    if (z.id === zone.id) return false;
    // 同一施法者重放/挪动同名专注区域（如移动月华之光）时原地更新，不留残影
    if (zone.concentration === true && zone.source !== undefined && z.source === zone.source && z.name === zone.name) return false;
    return true;
  });
  existing.push(zone);
  state.zones = existing;
  pushLog(c, `放置战场区域：${formatZoneSummary(zone)}`);

  const affected = placedIn(c, room)
    .filter(({ cell }) => zonesAtCell(c, room, cell).some((z) => z.id === zone.id))
    .map(({ ch }) => ch.name);
  return { zone, broken, affected };
}

/** 手动移除战场持续区域（按区域 id 或名称） */
export function removeBattleZone(c: Campaign, idOrName: string, room?: string): BattleZone[] {
  const state = requireInitiative(c);
  const q = idOrName.trim();
  if (!q) throw new Error('remove_zone 要给 name（区域名称或 id）');
  const list = state.zones ?? [];
  const removed = list.filter((z) => (room === undefined || z.room === room) && (z.id === q || z.name === q || z.name.includes(q)));
  if (removed.length === 0) {
    const existing = list.map((z) => `${z.name}(${z.id})`).join('、') || '无';
    throw new Error(`找不到持续区域「${q}」。当前场上区域：${existing}`);
  }
  const rest = list.filter((z) => !removed.includes(z));
  if (rest.length === 0) delete state.zones;
  else state.zones = rest;
  for (const r of removed) pushLog(c, `移除战场区域「${r.name}」`);
  return removed;
}

export interface MoveRequest {
  x?: number;
  y?: number;
  /** 目标离地高度（尺，5 的非负整数倍；省略时保持当前高度） */
  z?: number;
  /** 走到这个人身边最近的空格（同 to=某人，留着兼容） */
  adjacentTo?: string;
  /** 走向一个人（贴上去）、地标或地形（门、门外、熔炉旁）；比让模型算坐标靠谱 */
  to?: string;
  /** 离这个人越远越好 */
  awayFrom?: string;
  /** 最多走多少尺（「往门口挪 10 尺」）；不给就用本回合剩下的移动力 */
  feet?: number;
  /** 走完必须还贴着这个人，做不到就报错（「贴着熊二往门口挪」） */
  keepAdjacent?: string;
  /** 冲刺：本回合移动力翻倍 */
  dash?: boolean;
  /** 拖着一个贴身的人走：每格算双倍，他落在你身后那一格 */
  drag?: string;
  /** 撤离动作：这次移动不触发借机 */
  disengage?: boolean;
  /** 倒地时保持爬行（不自动扣半速起身，每格按双倍移动力计算） */
  crawl?: boolean;
  /** 特例豁免移动类状态限制（如自由行动戒指） */
  ignoreStateMods?: boolean;
  /** 反应/他人回合里的移动：不计入本回合移动力 */
  reaction?: boolean;
  /** 工具层移动必须暂停；纯路径查询仍可取得完整路线。不能由模型跳过。 */
  interrupt?: boolean;
  ignoredReactors?: string[];
}

export interface MoveResult {
  name: string;
  from: BattleCell;
  to: BattleCell;
  feet: number;
  /** 本回合累计 */
  totalFeet: number;
  /** 本回合可用（冲刺算双倍） */
  speed: number;
  dashed: boolean;
  /** 这一步离开了谁的触及范围 */
  provokes: string[];
  /** 这一步「进入」了谁的长柄触及范围（长柄大师这类反向触发） */
  enters: Array<{ name: string; reach: number; reaction: string }>;
  disengaged: boolean;
  /** 起点就贴着、一路没出过触及的敌人：贴身挪位不吃借机，明说出来免得 DM 误报 */
  stayedIn: string[];
  /** 被墙、障碍、敌人挡着绕了路 */
  detour: boolean;
  /** 落脚处的地形名（门、门外、干水渠） */
  where?: string;
  /** 走完贴着的敌人 */
  adjacent: string[];
  dragged?: { name: string; to: BattleCell };
  /** 移动力不够、没走到想去的地方 */
  short?: string;
  notes: string[];
  opportunity?: { reactors: ReactorOption[]; resume: MoveRequest };
}

/** 按直线走过的格子（含起点终点）；没有场地图、直接给坐标时用 */
function straightPath(from: Cell, to: Cell): Cell[] {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  if (steps === 0) return [{ x: from.x, y: from.y }];
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: Math.round(from.x + ((to.x - from.x) * i) / steps),
    y: Math.round(from.y + ((to.y - from.y) * i) / steps),
  }));
}

const minFeet = (cells: readonly Cell[], at: Cell): number => Math.min(...cells.map((c) => distanceFeet(c, at)));

function hasBlindOrSpecialSight(ch: Character): boolean {
  const text = `${ch.notes ?? ''} ${(ch.traits ?? []).join(' ')}`;
  return /盲视|blindsight|真实视觉|truesight|魔鬼视界|devil'?s\s*sight|震颤感知|tremorsense/i.test(text);
}

export interface MoveGridOptions {
  roller?: Roller;
  globalEffects?: Record<string, CustomEffectDef>;
}

/**
 * 回合内移动：算走了多少尺，报出会触发谁的借机，联动结算持续地形（难行/遮蔽/进圈伤害）与 2.5D 飞行高度。
 * 有场地图时按最短路绕墙、难行地形算双倍；目的地可以是坐标，也可以是「走到谁身边 / 门口 / 离谁远点」，
 * 由工具挑格子：今晚的错位都出在模型自己把「靠着熊二往门口挪」换算成坐标时丢了条件。
 */
export function moveOnGrid(c: Campaign, name: string, request: MoveRequest, options: MoveGridOptions = {}): MoveResult {
  const state = requireInitiative(c);
  const ch = requireCharacter(c, name);
  const from = cellOf(c, ch);
  if (from === undefined) throw new Error(`${ch.name} 还没摆位，先 dnd_position set`);
  const map = mapOf(c, from.room);
  const fromZ = from.z ?? 0;
  const targetZ = request.z !== undefined ? requireAltitude(request.z, 'z', map?.ceiling) : fromZ;
  const isAirborneMove = fromZ > 0 || targetZ > 0;
  const canFly = (ch.flySpeed ?? 0) > 0 || ch.hover === true || hasCondition(ch, '飞行术');
  if (targetZ > 0 && !canFly && request.ignoreStateMods !== true) {
    throw new Error(`${ch.name} 没有飞行速度（fly_speed）也未处于「飞行术」状态，无法升空到 z=${targetZ} 尺`);
  }

  const reaction = request.reaction === true;
  if (request.disengage === true) {
    state.disengaged = [...new Set([...(state.disengaged ?? []), ch.name])];
    if (!reaction) {
      const ts = ensureTurnState(c);
      if (ts?.actor === ch.name) ts.actionUsed ??= '撤离';
    }
  }
  const disengaged = state.disengaged?.includes(ch.name) === true;

  if (request.dash === true && !reaction) {
    const dashed = state.dashed ?? [];
    if (!dashed.includes(ch.name)) dashed.push(ch.name);
    state.dashed = dashed;
    const ts = ensureTurnState(c);
    if (ts?.actor === ch.name) ts.actionUsed ??= '冲刺';
  }
  const isDashed = state.dashed?.includes(ch.name) === true;
  const rawBaseSpeed = isAirborneMove
    ? (ch.flySpeed ?? (hasCondition(ch, '飞行术') ? 60 : (ch.speed ?? DEFAULT_SPEED)))
    : (ch.speed ?? DEFAULT_SPEED);
  const moveInfo = request.ignoreStateMods === true
    ? { baseSpeed: rawBaseSpeed, zeroSpeed: false, zeroReasons: [] as string[], notes: [] as string[], fearSources: [] as string[], hasUnboundFear: false }
    : movementSpeedInfo(ch, rawBaseSpeed);
  const baseSpeed = moveInfo.zeroSpeed ? rawBaseSpeed : moveInfo.baseSpeed;
  const speed = baseSpeed * (isDashed ? 2 : 1);
  const usedBefore = reaction ? 0 : state.moved?.[ch.name] ?? 0;
  const isProne = !reaction && request.ignoreStateMods !== true && hasCondition(ch, '倒地');
  const crawling = isProne && request.crawl === true;
  const ts = ensureTurnState(c);
  const autoStandUp = isProne && !crawling && ts?.stoodUp !== true;
  const standCost = autoStandUp ? Math.floor(baseSpeed / 2) : 0;
  if (autoStandUp && request.interrupt === true && usedBefore + standCost > speed) {
    throw new Error(`${ch.name} 处于「倒地」，起身需先消耗一半速度（${standCost} 尺），但本回合只剩 ${Math.max(0, speed - usedBefore)}/${speed} 尺移动力；若冲刺请传 dash=true，若倒地爬行请传 crawl=true`);
  }
  const used = usedBefore + standCost;

  const dragged = request.drag === undefined ? undefined : requireCharacter(c, request.drag);
  if (dragged !== undefined) {
    const at = cellOf(c, dragged);
    if (at === undefined || at.room !== from.room || distanceFeet(at, from) > MELEE_REACH_FEET) throw new Error(`${dragged.name} 不在 ${ch.name} 身边，拖不了；先走过去`);
  }
  const keep = request.keepAdjacent === undefined ? undefined : requireCharacter(c, request.keepAdjacent);
  const keepCell = keep === undefined ? undefined : cellOf(c, keep);
  if (keep !== undefined && (keepCell === undefined || keepCell.room !== from.room)) throw new Error(`${keep.name} 不在这个房间的站位上`);

  const others = placedIn(c, from.room).filter(({ ch: o }) => o.name !== ch.name && o.name !== dragged?.name);
  const foes = others.filter(({ ch: o }) => isHostile(ch, o));
  const moverInvisible = request.ignoreStateMods !== true && hasCondition(ch, '隐形') && !hasCondition(ch, '妖火');
  const reactors = moverInvisible ? [] : foes.filter(({ ch: o }) => inInitiative(c, o.name) && canReact(o) && !hasCondition(o, '失明') && reactionBlocked(c, o.name) === undefined
    && !request.ignoredReactors?.includes(o.name));
  const reachOf = (other: Character): number => Math.max(MELEE_REACH_FEET, ...(other.weapons ?? []).map((w) => weaponReach(w, true) ?? 0));

  const highAltitude = fromZ >= 15 && targetZ >= 15;
  // 5e：能穿过友方的格子，不能穿过同一高度层的敌人的格子；高空飞越地面敌人不阻挡
  const blocked = (at: Cell): boolean => foes.some(({ cell }) => cell.x === at.x && cell.y === at.y && Math.abs((cell.z ?? 0) - targetZ) < CELL_FEET);
  const taken = (at: Cell): boolean => others.some(({ cell }) => cell.x === at.x && cell.y === at.y && (cell.z ?? 0) === targetZ);
  const cellCostMult = (at: Cell): number => extraCellCostMultiplier(c, ch, { ...at, z: targetZ }, from.room, options.globalEffects);
  const canReactorSeeAt = (other: Character, reactorCell: BattleCell, moverCell: BattleCell): { ok: boolean; reason?: string } => {
    if (hasBlindOrSpecialSight(other)) return { ok: true };
    const obs = isCellHeavilyObscured(c, moverCell) ?? isCellHeavilyObscured(c, reactorCell);
    if (obs !== undefined) return { ok: false, reason: `「${obs.name}」遮蔽视线，${other.name} 无法借机攻击` };
    return { ok: true };
  };
  const provokesOn = (a: Cell, b: Cell): number => disengaged ? 0
    : reactors.filter(({ ch: other, cell }) => {
      const a3: BattleCell = { ...a, ...(targetZ > 0 ? { z: targetZ } : {}), room: from.room };
      const b3: BattleCell = { ...b, ...(targetZ > 0 ? { z: targetZ } : {}), room: from.room };
      return canReactorSeeAt(other, cell, a3).ok && distanceFeet(a3, cell) <= reachOf(other) && distanceFeet(b3, cell) > reachOf(other);
    }).length;
  const factor = (dragged === undefined ? 1 : 2) * (crawling ? 2 : 1);

  let dest: Cell;
  let path: Cell[];
  let horizFeet: number;
  let short: string | undefined;
  const explicit = request.x !== undefined || request.y !== undefined;
  const target = request.to ?? request.adjacentTo;
  const pureVertical = !explicit && target === undefined && request.awayFrom === undefined && request.z !== undefined;

  if (pureVertical) {
    dest = { x: from.x, y: from.y };
    if (blocksMove(map, dest, targetZ >= 15)) throw new Error(`(${dest.x},${dest.y}) 无法停靠`);
    const occupied = occupant(c, from.room, { ...dest, z: targetZ }, ch.name);
    if (occupied !== undefined && occupied.name !== dragged?.name) {
      throw new Error(`${fmtCoord({ ...dest, z: targetZ })} 已经站着 ${occupied.name}，换一格或换高度`);
    }
    path = [{ x: from.x, y: from.y }];
    horizFeet = 0;
  } else if (explicit) {
    if (target !== undefined || request.awayFrom !== undefined) throw new Error('x/y 和 to/away_from 二选一');
    dest = { x: requireCoord(request.x ?? from.x, 'x'), y: requireCoord(request.y ?? from.y, 'y') };
    if (blocksMove(map, dest, targetZ >= 15)) throw new Error(`(${dest.x},${dest.y}) 是${terrainHere(map!, dest)}，站不上去；要去旁边用 to`);
    const occupied = occupant(c, from.room, { ...dest, z: targetZ }, ch.name);
    if (occupied !== undefined && occupied.name !== dragged?.name) throw new Error(`${fmtCoord({ ...dest, z: targetZ })} 已经站着 ${occupied.name}，换一格，或用 to`);
    const hasExtraTerrain = map !== undefined || foes.length > 0 || (state.zones?.length ?? 0) > 0
      || c.characters.some((o) => o.name !== ch.name && (o.activeStates?.length ?? 0) > 0);
    if (!hasExtraTerrain) {
      path = straightPath(from, dest);
      horizFeet = Math.max(Math.abs(from.x - dest.x), Math.abs(from.y - dest.y)) * CELL_FEET * factor;
    } else {
      const reached = walk(map, from, { blocked, provokes: provokesOn, costFactor: factor, highAltitude, cellCostMultiplier: cellCostMult, stopAt: dest });
      const found = pathTo(reached, dest);
      if (found === undefined) throw new Error(`走不到 (${dest.x},${dest.y})：被墙或敌人堵死了`);
      path = found;
      horizFeet = reached.get(cellKey(dest))!.feet;
    }
  } else {
    if (target === undefined && request.awayFrom === undefined) throw new Error('move 要给 x/y/z，或者 to / adjacent_to / away_from 之一');
    if (target !== undefined && request.awayFrom !== undefined) throw new Error('to 和 away_from 二选一');
    const remaining = reaction ? baseSpeed : speed - used;
    const maxFeet = request.feet ?? remaining;
    if (maxFeet < CELL_FEET * factor) {
      throw new Error(`${ch.name} 这回合的移动力用完了（已走 ${used}/${speed} 尺）${isDashed ? '' : '；冲刺传 dash=true'}`);
    }
    let score: (at: Cell) => number;
    let goal: string;
    if (target !== undefined) {
      const spot = spotCells(c, from.room, target);
      if (spot === undefined) throw unknownSpot(c, from.room, target);
      // 人和挡路的东西：贴上去就算到；门、门外这种能站的地方：要站进去
      score = spot.blocking
        ? (at) => Math.max(0, minFeet(spot.cells, at) - MELEE_REACH_FEET)
        : (at) => minFeet(spot.cells, at);
      goal = spot.label;
    } else {
      const away = requireCharacter(c, request.awayFrom!);
      const awayCell = cellOf(c, away);
      if (awayCell === undefined || awayCell.room !== from.room) throw new Error(`${away.name} 不在这个房间的站位上`);
      score = (at) => -distanceFeet({ ...at, z: targetZ }, awayCell);
      goal = `远离 ${away.name}`;
    }
    const reached = walk(map, from, { blocked, provokes: provokesOn, costFactor: factor, highAltitude, cellCostMultiplier: cellCostMult, maxFeet });
    let best: { at: Cell; s: number; feet: number; provokes: number } | undefined;
    for (const [k, r] of reached) {
      const at = parseKey(k);
      if (taken(at) && !(at.x === from.x && at.y === from.y && targetZ === fromZ)) continue;
      if (keepCell !== undefined && distanceFeet({ ...at, z: targetZ }, keepCell) > MELEE_REACH_FEET) continue;
      const s = score(at);
      if (best === undefined || s < best.s || (s === best.s && (r.feet < best.feet || (r.feet === best.feet && r.provokes < best.provokes)))) {
        best = { at, s, feet: r.feet, provokes: r.provokes };
      }
    }
    if (best === undefined) throw new Error(`${keep === undefined ? '' : `贴着 ${keep.name} 的`}格子都走不到或站满了`);
    dest = best.at;
    path = pathTo(reached, dest)!;
    horizFeet = best.feet;
    if (target !== undefined && best.s > 0) {
      const limit = keep !== undefined ? `要贴着 ${keep.name}，最多` : request.feet !== undefined ? `限 ${request.feet} 尺，只够` : '移动力只够';
      short = `${limit}走到这里，离 ${goal} 还有 ${best.s} 尺`;
    }
  }
  const blocker = occupant(c, from.room, { ...dest, z: targetZ }, ch.name);
  if (blocker !== undefined && blocker.name !== dragged?.name) throw new Error(`${fmtCoord({ ...dest, z: targetZ })} 已经站着 ${blocker.name}，换一格，或用 to`);
  if (keepCell !== undefined && distanceFeet({ ...dest, z: targetZ }, keepCell) > MELEE_REACH_FEET) {
    throw new Error(`走到 ${fmtCoord({ ...dest, z: targetZ })} 就不贴着 ${keep!.name} 了；不给坐标、传 to + keep_adjacent，工具会挑贴着他的格子`);
  }

  // 生成完整 3D 轨迹（支持原地升空/俯冲与斜飞）
  const horizSteps = path.length - 1;
  const vertSteps = Math.abs(targetZ - fromZ) / CELL_FEET;
  const totalSteps = Math.max(horizSteps, vertSteps);
  let path3d: BattleCell[];
  if (totalSteps === 0) {
    path3d = [{ x: from.x, y: from.y, ...(fromZ > 0 ? { z: fromZ } : {}), room: from.room }];
  } else {
    path3d = Array.from({ length: totalSteps + 1 }, (_, k) => {
      const hIdx = horizSteps === 0 ? 0 : Math.min(horizSteps, Math.round((k * horizSteps) / totalSteps));
      const hc = path[hIdx]!;
      const zk = Math.round((fromZ + ((targetZ - fromZ) * k) / totalSteps) / CELL_FEET) * CELL_FEET;
      return { x: hc.x, y: hc.y, ...(zk > 0 ? { z: zk } : {}), room: from.room };
    });
  }

  let feet = horizSteps === 0
    ? path3d.slice(1).reduce((sum, step) => sum + CELL_FEET * factor * extraCellCostMultiplier(c, ch, step, from.room, options.globalEffects), 0)
    : Math.max(horizFeet, Math.abs(targetZ - fromZ) * factor);

  if (!reaction && request.ignoreStateMods !== true && moveInfo.fearSources.length > 0) {
    for (const srcName of moveInfo.fearSources) {
      const srcCh = findCharacter(c, srcName);
      const srcCell = srcCh === undefined ? undefined : cellOf(c, srcCh);
      if (srcCh !== undefined && srcCell !== undefined && srcCell.room === from.room) {
        const startDist = distanceFeet(from, srcCell);
        const closer = path3d.some((step, i) => i > 0 && distanceFeet(step, srcCell) < startDist);
        if (closer) {
          throw new Error(`${ch.name} 正对 ${srcCh.name} 处于「恐慌」状态，不能主动移向恐惧源（若免疫或强制位移请传 ignore_state_mods=true 或用 set）`);
        }
      }
    }
  }

  const blockedSightNotes = new Set<string>();
  let opportunity: MoveResult['opportunity'];
  const fullDestZ = targetZ;
  const fullDest = { ...dest };
  if (request.interrupt === true && !disengaged) {
    const triggers: Array<{ stop: number; character: string; reaction: string }> = [];
    for (const { ch: other, cell } of reactors) {
      const reach = reachOf(other);
      for (let i = 0; i + 1 < path3d.length; i++) {
        if (distanceFeet(path3d[i]!, cell) <= reach && distanceFeet(path3d[i + 1]!, cell) > reach && wallBetween(map, path3d[i]!, cell) === undefined) {
          const sight = canReactorSeeAt(other, cell, path3d[i]!);
          if (!sight.ok) {
            if (sight.reason) blockedSightNotes.add(sight.reason);
            continue;
          }
          triggers.push({ stop: i, character: other.name, reaction: '借机攻击' });
          break;
        }
      }
      for (const r of reactionsOf(other).filter((r) => r.enter === true)) {
        for (let i = 0; i + 1 < path3d.length; i++) {
          if (distanceFeet(path3d[i]!, cell) > (r.range ?? MELEE_REACH_FEET) && distanceFeet(path3d[i + 1]!, cell) <= (r.range ?? MELEE_REACH_FEET) && wallBetween(map, path3d[i + 1]!, cell) === undefined) {
            const sight = canReactorSeeAt(other, cell, path3d[i + 1]!);
            if (!sight.ok) {
              if (sight.reason) blockedSightNotes.add(sight.reason);
              continue;
            }
            triggers.push({ stop: i + 1, character: other.name, reaction: r.name });
            break;
          }
        }
      }
    }
    if (triggers.length > 0) {
      const first = Math.min(...triggers.map((t) => t.stop));
      const here = triggers.filter((t) => t.stop === first);
      const reactorOptions: ReactorOption[] = here.map(({ character, reaction }) => ({ character, reaction,
        ...(requireCharacter(c, character).kind !== 'pc' || requireCharacter(c, character).playerId === undefined ? { npc: true } : {}) }));
      opportunity = { reactors: reactorOptions, resume: {
        x: fullDest.x, y: fullDest.y, ...(fullDestZ !== 0 || fromZ !== 0 ? { z: fullDestZ } : {}), interrupt: true, reaction,
        ignoredReactors: [...new Set([...(request.ignoredReactors ?? []), ...here.map((t) => t.character)])],
        ...(request.drag !== undefined ? { drag: request.drag } : {}),
        ...(request.keepAdjacent !== undefined ? { keepAdjacent: request.keepAdjacent } : {}),
        ...(request.crawl === true ? { crawl: true } : {}),
        ...(request.ignoreStateMods === true ? { ignoreStateMods: true } : {}),
      } };
      path3d = path3d.slice(0, first + 1);
      const stopCell = path3d.at(-1)!;
      dest = { x: stopCell.x, y: stopCell.y };
      feet = path3d.slice(1).reduce((sum, step) => {
        const stepHigh = (step.z ?? 0) >= 15;
        const mapMult = !stepHigh && map !== undefined && areaAt(map, step)?.kind === 'difficult' ? 2 : 1;
        const zoneMult = extraCellCostMultiplier(c, ch, step, from.room, options.globalEffects);
        return sum + CELL_FEET * factor * Math.max(mapMult, zoneMult);
      }, 0);
      short = '已在借机触发处暂停，剩余路程等反应结算后再走';
    }
  }

  const provokes: string[] = [];
  const stayedIn: string[] = [];
  const enters: Array<{ name: string; reach: number; reaction: string }> = [];
  if (!disengaged) {
    for (const { ch: other, cell } of reactors) {
      const leaves = path3d.some((step, i) => {
        const next = path3d[i + 1];
        if (next === undefined || distanceFeet(step, cell) > reachOf(other) || distanceFeet(next, cell) <= reachOf(other)) return false;
        const sight = canReactorSeeAt(other, cell, step);
        if (!sight.ok) {
          if (sight.reason) blockedSightNotes.add(sight.reason);
          return false;
        }
        return true;
      });
      if (leaves) provokes.push(other.name);
      else if (!opportunity?.reactors.some((r) => r.character === other.name) && path3d.length > 1 && path3d.every((step) => distanceFeet(step, cell) <= reachOf(other))) stayedIn.push(other.name);
      // 长柄大师：拿着长柄武器时，敌人「进入」触及范围也吃借机——方向反着算，一回合至多一次
      for (const r of reactionsOf(other)) {
        if (r.enter !== true) continue;
        const reach = r.range ?? MELEE_REACH_FEET;
        const steppedIn = path3d.some((step, i) => {
          const next = path3d[i + 1];
          if (next === undefined || distanceFeet(step, cell) <= reach || distanceFeet(next, cell) > reach) return false;
          const sight = canReactorSeeAt(other, cell, next);
          if (!sight.ok) {
            if (sight.reason) blockedSightNotes.add(sight.reason);
            return false;
          }
          return true;
        });
        if (steppedIn) enters.push({ name: other.name, reach, reaction: r.name });
      }
    }
  }

  const finalStep = path3d.at(-1)!;
  const to: BattleCell = { x: finalStep.x, y: finalStep.y, ...(finalStep.z !== undefined && finalStep.z > 0 ? { z: finalStep.z } : {}), room: from.room };
  (state.positions ??= {})[ch.name] = to;
  let draggedTo: { name: string; to: BattleCell } | undefined;
  if (dragged !== undefined) {
    // 拖着的人落在你走过的最后一格（原地没动就不动他）
    const behind = path3d.length >= 2 ? path3d[path3d.length - 2]! : undefined;
    if (behind !== undefined && (behind.x !== to.x || behind.y !== to.y || (behind.z ?? 0) !== (to.z ?? 0))) {
      const cell: BattleCell = { x: behind.x, y: behind.y, ...(behind.z !== undefined && behind.z > 0 ? { z: behind.z } : {}), room: from.room };
      state.positions[dragged.name] = cell;
      draggedTo = { name: dragged.name, to: cell };
    }
  }
  const moved = state.moved ?? {};
  const notes: string[] = [...moveInfo.notes, ...blockedSightNotes];
  if (autoStandUp) {
    changeCondition(c, ch.name, '倒地', false);
    if (ts !== undefined && ts.actor === ch.name) ts.stoodUp = true;
    notes.push(`已自动花费 ${standCost} 尺移动力从倒地起身并解除「倒地」（若本意是保持倒地爬行，请 dnd_undo 后传 crawl=true）`);
  } else if (crawling) {
    notes.push(`${ch.name} 保持倒地爬行（每格算双倍耗速）`);
  }
  if (!reaction) moved[ch.name] = (moved[ch.name] ?? 0) + standCost + feet;
  state.moved = moved;

  const hazardLines = settleMovementHazards(c, ch, path3d, options.roller ?? cryptoRoller, options.globalEffects);
  notes.push(...hazardLines);
  // 若沿途区域伤害已将角色击倒/击杀，不再保留借机恢复窗口
  if (opportunity !== undefined && (ch.hp <= 0 || isOut(ch))) {
    opportunity = undefined;
  }

  // 若区域伤害导致高空坠机（z 已清零），同步返回值中的 to
  const postPos = state.positions[ch.name] ?? to;
  if (moveInfo.hasUnboundFear) notes.push(`${ch.name} 处于恐慌：不能主动移向恐惧源`);
  if (moveInfo.zeroReasons.length > 0) notes.push(`${ch.name} 处于${moveInfo.zeroReasons.join('、')}，速度应为 0`);
  const area = map === undefined || (postPos.z ?? 0) >= 15 ? undefined : areaAt(map, postPos);
  return {
    name: ch.name,
    from,
    to: postPos,
    feet,
    totalFeet: moved[ch.name] ?? 0,
    speed,
    dashed: isDashed,
    provokes,
    enters,
    disengaged,
    stayedIn,
    detour: feet > distanceFeet(from, postPos) * factor,
    ...(area !== undefined && area.kind !== 'wall' ? { where: areaName(area) } : {}),
    adjacent: adjacentFoes(c, ch, postPos),
    ...(draggedTo !== undefined ? { dragged: draggedTo } : {}),
    ...(short !== undefined ? { short } : {}),
    notes,
    ...(opportunity !== undefined ? { opportunity } : {}),
  };
}

export function moveResultText(r: MoveResult): string {
  const how = [r.detour ? '绕开挡路的' : '', r.dragged !== undefined ? `拖着 ${r.dragged.name}，每格算双倍` : ''].filter(Boolean).join('，');
  const lines = [`${r.name} ${fmtCoord(r.from)}→${fmtCoord(r.to)}，走 ${r.feet} 尺${how ? `（${how}）` : ''}，本回合累计 ${r.totalFeet}/${r.speed} 尺${r.dashed ? '（冲刺）' : ''}`];
  const now = [
    (r.to.z ?? 0) > 0 ? `离地 ${r.to.z} 尺` : '',
    r.where !== undefined ? `站在${r.where}` : '',
    r.adjacent.length > 0 ? `贴身：${r.adjacent.join('、')}` : '没贴着敌人',
  ].filter(Boolean);
  lines.push(`现在：${now.join('；')}${r.dragged !== undefined ? `；${r.dragged.name} 在 ${fmtCoord(r.dragged.to)}` : ''}`);
  if (r.short !== undefined) lines.push(`【DM】${r.short}。`);
  if (r.totalFeet > r.speed) lines.push(`【DM】超过速度 ${r.speed}：${r.dashed ? '冲刺也不够' : '没冲刺的话要传 dash=true'}，不合法就 dnd_undo。`);
  if (r.disengaged) lines.push('撤离：这次移动不触发借机。');
  if (r.stayedIn.length > 0) lines.push(`贴着 ${r.stayedIn.join('、')} 挪位，全程没离开触及，不触发借机。`);
  if (r.provokes.length > 0) {
    lines.push(`【DM】离开了 ${r.provokes.join('、')} 的触及范围：他们可以借机，消耗反应，到各自下回合开始恢复。`);
  }
  if (r.enters.length > 0) {
    lines.push(`【DM】进入 ${r.enters.map((e) => `${e.name} 的 ${e.reach} 尺触及（${e.reaction}）`).join('、')}：可以借机，用 dnd_check ... reaction=true 结算。`);
  }
  lines.push(...r.notes.map((n) => `【DM】${n}`));
  if (r.opportunity !== undefined) lines.push(`【移动待结算】在触发处停下：${r.opportunity.reactors.map((r) => `${r.character}·${r.reaction}`).join('、')}。先问玩家，不能提前 next、攻击或走完剩余路程。借机用 dnd_check type=attack reaction=true target=${r.name}；不用传 dnd_apply target=${r.name} decline=[角色名]；全部处理后 settle=true 继续移动。`);
  return lines.join('\n');
}

/** 敌对且贴身的人 */
function adjacentFoes(c: Campaign, ch: Character, cell: BattleCell): string[] {
  return placedIn(c, cell.room)
    .filter(({ ch: other, cell: at }) => other.name !== ch.name && isHostile(ch, other) && distanceFeet(cell, at) <= MELEE_REACH_FEET)
    .map(({ ch: other }) => other.name);
}

/** 先攻表里还没摆位的人（换了房间的也算） */
export function unplaced(c: Campaign): string[] {
  return (c.initiative?.order ?? []).flatMap((e) => {
    const ch = findCharacter(c, e.name);
    return ch !== undefined && !isOut(ch) && cellOf(c, ch) === undefined ? [ch.name] : [];
  });
}

/** 轮到某人时随回合提示给的一句：他在哪、贴着谁、最近的敌人多远，省得模型再算 */
export function turnPositionNote(c: Campaign, name: string): string {
  const missing = unplaced(c);
  const hint = missing.length > 0 ? `【站位】还没摆位：${missing.join('、')}。先 dnd_position set 再裁定距离。` : '';
  const ch = findCharacter(c, name);
  const cell = ch === undefined ? undefined : cellOf(c, ch);
  if (ch === undefined || cell === undefined) return hint;
  const foes = placedIn(c, cell.room).filter(({ ch: other }) => isHostile(ch, other));
  const adjacent = adjacentFoes(c, ch, cell);
  const map = mapOf(c, cell.room);
  const area = map === undefined || (cell.z ?? 0) >= 15 ? undefined : areaAt(map, cell);
  const zonesHere = zonesAtCell(c, cell.room, cell);
  let where = `【站位】${ch.name}${fmtCoord(cell)}${area !== undefined && area.kind !== 'wall' ? `（${areaName(area)}）` : ''}${zonesHere.length > 0 ? `（处于区域：${zonesHere.map((z) => z.name).join('、')}）` : ''}`;
  if (adjacent.length > 0) where += `，贴身：${adjacent.join('、')}`;
  else if (foes.length > 0) {
    const nearest = foes.map((f) => ({ name: f.ch.name, feet: distanceFeet(cell, f.cell) })).sort((a, b) => a.feet - b.feet)[0]!;
    where += `，最近的敌人 ${nearest.name} ${nearest.feet} 尺`;
  }
  // 打到一半才上线这功能的战斗没有开战提示，在回合提示里补要
  const noMap = map === undefined ? '这间还没有场地图：先 dnd_position terrain 照现有站位把墙、门、门外走廊、障碍画上。' : '';
  return `${where}。${hint}${noMap}`;
}

/** 玩家看站位时要藏起来的：隐形、躲着的怪。位置正是它们要瞒的东西 */
const HIDDEN = ['隐形', '躲藏', '隐匿'];
export function hiddenFromPlayers(ch: Character): boolean {
  return ch.kind === 'monster' && ch.conditions.some((cond) => HIDDEN.includes(cond));
}

const defaultVisible = (): boolean => true;

/**
 * 团况和 show 用的全场站位，按房间分行：压缩之后靠这几行恢复现场。
 * visible 给玩家视角用：不列的人也不算进贴身。
 */
export function battleLines(c: Campaign, roomName: (id: string) => string, visible: (ch: Character) => boolean = defaultVisible): string[] {
  const state = c.initiative;
  if (state === undefined) return [];
  const rooms = new Map<string, Array<{ ch: Character; cell: BattleCell }>>();
  for (const entry of c.characters) {
    const cell = cellOf(c, entry);
    if (cell === undefined || isOut(entry) || !visible(entry)) continue;
    if (!rooms.has(cell.room)) rooms.set(cell.room, []);
    rooms.get(cell.room)!.push({ ch: entry, cell });
  }
  const marks = Object.entries(state.marks ?? {});
  for (const [, cell] of marks) if (!rooms.has(cell.room)) rooms.set(cell.room, []);
  for (const z of state.zones ?? []) if (!rooms.has(z.room)) rooms.set(z.room, []);

  const lines: string[] = [];
  const isDmView = visible === defaultVisible;
  for (const [room, members] of rooms) {
    const seen = new Set<string>();
    const pairs: string[] = [];
    for (const { ch, cell } of members) {
      for (const foe of adjacentFoes(c, ch, cell).filter((n) => members.some((m) => m.ch.name === n))) {
        const key = [ch.name, foe].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push(`${ch.name}-${foe}`);
        }
      }
    }
    const roomMarks = marks.filter(([, cell]) => cell.room === room).map(([n, cell]) => `${n}(${cell.x},${cell.y})`);
    lines.push(`站位｜${roomName(room)}（格=5尺，x东y南）：${members.map(({ ch, cell }) => `${ch.name}${fmtCoord(cell)}`).join('、') || '无'}`
      + `${pairs.length > 0 ? `；贴身：${pairs.join('、')}` : ''}`
      + `${roomMarks.length > 0 ? `；标记：${roomMarks.join('、')}` : ''}`);
    const map = mapOf(c, room);
    if (map !== undefined) lines.push(`　${terrainLine(map)}`);
    const roomZones = zonesInRoom(c, room);
    if (roomZones.length > 0) {
      lines.push(`　持续区域：${roomZones.map(isDmView ? formatZoneSummary : formatZonePlayerLegend).join('；')}`);
    }
  }
  const missing = unplaced(c).filter((n) => {
    const ch = findCharacter(c, n);
    return ch !== undefined && visible(ch);
  });
  if (missing.length > 0) lines.push(`未摆位：${missing.join('、')}`);
  return lines;
}

/** 一格 3 个字符时最多几列（手机上一行放得下）；更宽的场地改成一格 2 个字符 */
const GRID_MAX = 15;
/** 一格 2 个字符时最多几列；再宽就只截人在的那一块 */
const GRID_WIDE_MAX = 22;
/** 行数不受屏宽限制，但太长要翻屏 */
const GRID_ROWS_MAX = 22;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * 每个人在图上用哪个字符。只用 ASCII：代码块里中文和 emoji 占两格，会把列挤歪。
 * 队友用名字里的拉丁字母（Kriv→K），没有就按顺序给大写字母；怪物用数字（名字末尾有数字就用它），九个以上接小写字母；地标用小写字母。
 */
function gridGlyphs(people: readonly Character[], marks: readonly string[]): Map<string, string> {
  const used = new Set<string>();
  const glyph = new Map<string, string>();
  const take = (g: string, key: string): void => {
    used.add(g);
    glyph.set(key, g);
  };
  const nextLower = (): string => [...LETTERS.toLowerCase()].find((l) => !used.has(l)) ?? '?';
  for (const ch of people.filter((p) => p.kind !== 'monster')) {
    const latin = (/[A-Za-z]/.exec(ch.name)?.[0] ?? '').toUpperCase();
    take(latin !== '' && !used.has(latin) ? latin : [...LETTERS].find((l) => !used.has(l)) ?? '?', ch.name);
  }
  // 怪物名字以数字结尾（矮人丧尸2）就用那个数字，图上的 2 就是丧尸2；撞了再按顺序给
  const monsters = people.filter((p) => p.kind === 'monster');
  for (const ch of monsters) {
    const own = /([1-9])$/.exec(ch.name)?.[1];
    if (own !== undefined && !used.has(own)) take(own, ch.name);
  }
  const nextDigit = (): string | undefined => [...'123456789'].find((d) => !used.has(d));
  for (const ch of monsters) if (!glyph.has(ch.name)) take(nextDigit() ?? nextLower(), ch.name);
  for (const name of marks) take(nextLower(), `mark:${name}`);
  return glyph;
}

/** 地形在图上的字符：都是 ASCII，和人、地标的字母数字不撞 */
const TERRAIN_GLYPH: Record<'wall' | 'door' | 'outside' | 'difficult', string> = { wall: '#', door: '+', outside: ':', difficult: '~' };

/** 一个轴上截哪一段：放得下就全要；放不下就挑框住人最多的那一段，同样多时让人居中 */
function fitAxis(lo: number, hi: number, max: number, people: readonly number[]): [number, number] {
  if (hi - lo + 1 <= max) return [lo, hi];
  const mean = people.length === 0 ? (lo + hi) / 2 : people.reduce((a, b) => a + b, 0) / people.length;
  let best: { s: number; n: number; off: number } | undefined;
  for (let s = lo; s + max - 1 <= hi; s++) {
    const n = people.filter((p) => p >= s && p <= s + max - 1).length;
    const off = Math.abs(s + (max - 1) / 2 - mean);
    if (best === undefined || n > best.n || (n === best.n && off < best.off)) best = { s, n, off };
  }
  return [best!.s, best!.s + max - 1];
}

/**
 * 画哪一块：有场地图就画整张，没有就画人和地标周围一圈；太大时截人在的那一块。
 * 冶炼洞窟的场地 20 格宽，以前超过 15 列就整张不画，/dnd status 退回了坐标列表。
 */
function viewport(map: BattleMap | undefined, items: readonly Cell[], people: readonly Cell[]): { x0: number; y0: number; x1: number; y1: number } {
  const xs = items.map((i) => i.x);
  const ys = items.map((i) => i.y);
  const lo = map === undefined
    ? { x0: Math.max(0, Math.min(...xs) - 1), y0: Math.max(0, Math.min(...ys) - 1), x1: Math.max(...xs) + 1, y1: Math.max(...ys) + 1 }
    : { x0: 0, y0: 0, x1: map.width - 1, y1: map.height - 1 };
  const [x0, x1] = fitAxis(lo.x0, lo.x1, GRID_WIDE_MAX, people.map((p) => p.x));
  const [y0, y1] = fitAxis(lo.y0, lo.y1, GRID_ROWS_MAX, people.map((p) => p.y));
  return { x0, y0, x1, y1 };
}

/** 列号表头：一格 3 字符时直接写数字；一格 2 字符时两位数挤不下，拆成十位一行、个位一行 */
function headerLines(cols: readonly number[], width: number): string[] {
  if (width === 3) return [`   ${cols.map((x) => String(x).padStart(3)).join('')}`];
  const units = `   ${cols.map((x) => String(x % 10).padStart(2)).join('')}`;
  if (cols.every((x) => x < 10)) return [units];
  return [`   ${cols.map((x) => (x >= 10 ? String(Math.floor(x / 10) % 10) : ' ').padStart(2)).join('')}`, units];
}

/** DM 用 mark 又标了一遍场地图上已有的东西（熔炉、门）：画地形就够了，不再叠一个字母 */
function duplicatesTerrain(map: BattleMap | undefined, name: string, at: Cell): boolean {
  const area = map === undefined ? undefined : areaAt(map, at);
  if (area === undefined) return false;
  const n = areaName(area);
  return n.includes(name) || name.includes(n);
}

/**
 * 战场示意图：每个房间一张字符网格（要放进 markdown 代码块才等宽），下面是图例。
 * 有场地图就把墙（#）、门（+）、门外（:）、难行地形（~）和障碍物（小写字母）一起画上；
 * 15 列以内一格 3 个字符，再宽一格 2 个字符，超过 22 列只截人在的那一块并列出图外的人。
 * 没人摆位时返回 undefined，调用方退回 battleLines。visible 给玩家视角用：藏起来的怪不画。
 */
export function battleGridLines(c: Campaign, roomName: (id: string) => string, visible: (ch: Character) => boolean = () => true): string[] | undefined {
  const state = c.initiative;
  if (state === undefined) return undefined;
  const placed = c.characters.flatMap((ch) => {
    const cell = cellOf(c, ch);
    return cell !== undefined && !isOut(ch) && visible(ch) ? [{ ch, cell }] : [];
  });
  if (placed.length === 0) return undefined;
  const marks = Object.entries(state.marks ?? {}).filter(([name, m]) => !duplicatesTerrain(mapOf(c, m.room), name, m));
  const rooms = [...new Set([...placed.map((p) => p.cell.room), ...marks.map(([, m]) => m.room)])];
  // 障碍物和地标共用小写字母；同名的只给一个字母
  const objects = [...new Set(rooms.flatMap((room) => mapOf(c, room)?.areas.filter((a) => a.kind === 'object').map(areaName) ?? []))];
  const glyph = gridGlyphs(placed.map((p) => p.ch), [...marks.map(([name]) => name), ...objects.filter((o) => !marks.some(([n]) => n === o))]);

  const out: string[] = [];
  const stacked: string[] = [];
  const offView: string[] = [];
  const shownGlyphs = new Set<string>();
  const terrainNames = new Map<string, Set<string>>();
  for (const room of rooms) {
    const map = mapOf(c, room);
    const people = placed.filter((p) => p.cell.room === room);
    const items = [
      ...people.map((p) => ({ g: glyph.get(p.ch.name)!, key: p.ch.name, name: p.ch.name, x: p.cell.x, y: p.cell.y })),
      ...marks.filter(([, m]) => m.room === room).map(([name, m]) => ({ g: glyph.get(`mark:${name}`)!, key: `mark:${name}`, name, x: m.x, y: m.y })),
    ];
    if (items.length === 0) continue;
    const view = viewport(map, items, people.map((p) => p.cell));
    const inView = (i: Cell): boolean => i.x >= view.x0 && i.x <= view.x1 && i.y >= view.y0 && i.y <= view.y1;
    offView.push(...items.filter((i) => !inView(i)).map((i) => `${i.name}(${i.x},${i.y})`));
    const at = new Map<string, typeof items>();
    for (const i of items.filter(inView)) at.set(`${i.x},${i.y}`, [...(at.get(`${i.x},${i.y}`) ?? []), i]);
    const ground = (x: number, y: number): string => {
      const zHere = zonesAtCell(c, room, { x, y, z: 0 });
      if (map === undefined) {
        if (zHere.length > 0) {
          if (!terrainNames.has('*')) terrainNames.set('*', new Set());
          for (const z of zHere) terrainNames.get('*')!.add(z.name);
          return '*';
        }
        return '.';
      }
      const area = areaAt(map, { x, y });
      if (area === undefined) {
        if (zHere.length > 0) {
          if (!terrainNames.has('*')) terrainNames.set('*', new Set());
          for (const z of zHere) terrainNames.get('*')!.add(z.name);
          return '*';
        }
        return '.';
      }
      if (area.kind === 'object') {
        const g = glyph.get(`mark:${areaName(area)}`) ?? '?';
        shownGlyphs.add(`mark:${areaName(area)}`);
        return g;
      }
      if (area.kind !== 'wall' && zHere.length > 0) {
        if (!terrainNames.has('*')) terrainNames.set('*', new Set());
        for (const z of zHere) terrainNames.get('*')!.add(z.name);
        return '*';
      }
      const g = TERRAIN_GLYPH[area.kind];
      if (!terrainNames.has(g)) terrainNames.set(g, new Set());
      terrainNames.get(g)!.add(areaName(area));
      return g;
    };
    // 坐标照实标：玩家说「走到 (4,2)」和 DM 工具里的是同一套
    const cols = Array.from({ length: view.x1 - view.x0 + 1 }, (_, k) => view.x0 + k);
    const width = cols.length <= GRID_MAX ? 3 : 2;
    if (rooms.length > 1) out.push(`${roomName(room)}：`);
    out.push('```', ...headerLines(cols, width));
    for (let y = view.y0; y <= view.y1; y++) {
      out.push(`${String(y).padStart(3)}${cols.map((x) => {
        const here = at.get(`${x},${y}`);
        if (here !== undefined) for (const i of here) shownGlyphs.add(i.key);
        return (here === undefined ? ground(x, y) : here.length > 1 ? '@' : here[0]!.g).padStart(width);
      }).join('')}`);
    }
    out.push('```');
    for (const here of at.values()) if (here.length > 1) stacked.push(`@=${here.map((i) => i.name).join('+')}`);
  }
  const altByKey = new Map(placed.filter((p) => (p.cell.z ?? 0) > 0).map((p) => [p.ch.name, p.cell.z!]));
  const legend = [...glyph]
    .filter(([key]) => shownGlyphs.has(key))
    .map(([key, g]) => {
      const label = key.replace(/^mark:/, '');
      const z = altByKey.get(key);
      return `${g}=${label}${z !== undefined ? `(↑${z}尺)` : ''}`;
    });
  const terrain = [...terrainNames].map(([g, names]) => `${g}=${[...names].join('/')}`);
  out.push([...legend, ...stacked].join('　'));
  if (terrain.length > 0) out.push(terrain.join('　'));
  const activeZones = rooms.flatMap((room) => zonesInRoom(c, room));
  if (activeZones.length > 0) out.push(`🌀 区域：${activeZones.map(formatZonePlayerLegend).join('；')}`);
  if (offView.length > 0) out.push(`图外：${offView.join('、')}`);
  out.push('每格 5 尺，x 向东（右）、y 向南（下）');
  const missing = unplaced(c).filter((n) => {
    const ch = findCharacter(c, n);
    return ch !== undefined && visible(ch);
  });
  if (missing.length > 0) out.push(`未摆位：${missing.join('、')}`);
  return out;
}

/** show from=某人：他到房间里其他人的距离 */
export function distancesFrom(c: Campaign, name: string, visible: (ch: Character) => boolean = () => true): string {
  const ch = requireCharacter(c, name);
  const cell = cellOf(c, ch);
  if (cell === undefined) throw new Error(`${ch.name} 还没摆位，先 dnd_position set`);
  const others = placedIn(c, cell.room)
    .filter(({ ch: other }) => other.name !== ch.name && visible(other))
    .map(({ ch: other, cell: at }) => ({ name: other.name, feet: distanceFeet(cell, at), foe: isHostile(ch, other) }))
    .sort((a, b) => a.feet - b.feet);
  const marks = Object.entries(c.initiative?.marks ?? {})
    .filter(([, at]) => at.room === cell.room)
    .map(([n, at]) => `${n} ${distanceFeet(cell, at)} 尺`);
  const who = others.map((o) => `${o.foe ? '敌 ' : ''}${o.name} ${o.feet} 尺`).join('、') || '房间里没有别人';
  return `${ch.name}${fmtCoord(cell)} 到：${who}${marks.length > 0 ? `；标记：${marks.join('、')}` : ''}`;
}

export type AreaShape = 'sphere' | 'cube' | 'line';

export interface AreaRequest {
  shape: AreaShape;
  /** 球的半径、立方的边长、线的长度，尺 */
  size: number;
  /** 球心 / 立方西北角 / 线的终点方向：格子坐标 */
  x?: number;
  y?: number;
  /** 代替 x/y：以这个人或地标所在格为球心（或线的方向） */
  at?: string;
  /** 施法者：分敌我用；line 从他身边起算 */
  caster?: string;
}

/**
 * 范围法术会罩到谁。11-08 的火球是 DM 凭眼睛摆的，说「三只都能罩住，队友一个都进不去」，
 * 可两只蜘蛛各贴着一个队友，按格子不连队友根本圈不住。
 * 距离和工具别处一样按格算（斜着也是 5 尺）；球心落在格子上。锥形各家画法不一，不在这里算。
 */
export function areaReport(c: Campaign, req: AreaRequest): string {
  if (!Number.isInteger(req.size) || req.size < 5 || req.size % 5 !== 0) throw new Error('size 要是 5 的倍数（尺）');
  const caster = req.caster === undefined ? undefined : requireCharacter(c, req.caster);
  const casterCell = caster === undefined ? undefined : cellOf(c, caster);
  let point: BattleCell | undefined;
  if (req.at !== undefined) {
    const who = findCharacter(c, req.at);
    point = who !== undefined ? cellOf(c, who) : c.initiative?.marks?.[req.at];
    if (point === undefined) throw new Error(`${req.at} 没摆位，也不是标记；给 x/y`);
  } else if (req.x !== undefined && req.y !== undefined) {
    const room = casterCell?.room ?? fightRoomOf(c);
    point = { x: requireCoord(req.x, 'x'), y: requireCoord(req.y, 'y'), room };
  } else {
    throw new Error('要给 at（人或标记），或者 x/y');
  }
  const cells = req.shape === 'sphere'
    ? (at: Cell): boolean => distanceFeet(at, point) <= req.size
    : req.shape === 'cube'
      ? (at: Cell): boolean => at.x >= point.x && at.y >= point.y && at.x < point.x + req.size / 5 && at.y < point.y + req.size / 5
      : lineCells(casterCell, point, req.size);
  // 球与立方也可能罩住施法者；线的起点由 lineCells 自身排除，不能统一豁免施法者。
  const inside = placedIn(c, point.room).filter(({ cell }) => cells(cell));
  const marks = Object.entries(c.initiative?.marks ?? {}).filter(([, at]) => at.room === point.room && cells(at)).map(([n]) => n);
  const side = (ch: Character): boolean => (caster !== undefined ? isHostile(caster, ch) : ch.kind === 'monster');
  const foes = inside.filter(({ ch }) => side(ch)).map(({ ch }) => ch.name);
  const friends = inside.filter(({ ch }) => !side(ch)).map(({ ch }) => ch.name);
  const shapeName = { sphere: `半径 ${req.size} 尺的球`, cube: `边长 ${req.size} 尺的立方`, line: `${req.size} 尺长、5 尺宽的线` }[req.shape];
  const where = req.shape === 'line' ? `从 ${caster?.name ?? '?'} 朝 (${point.x},${point.y})` : req.shape === 'cube' ? `西北角 (${point.x},${point.y})` : `中心 (${point.x},${point.y})`;
  const lines = [`${shapeName}，${where}：`, `- ${caster !== undefined ? '敌方' : '怪物'}：${foes.join('、') || '无'}`, `- ${caster !== undefined ? '己方' : '队伍/NPC'}：${friends.join('、') || '无'}`];
  if (marks.length > 0) lines.push(`- 标记：${marks.join('、')}`);
  if (friends.length > 0) lines.push('【DM】己方也在范围里：换个落点再试，或照实告诉玩家会波及谁，别说「队友一个都进不去」。');
  return lines.join('\n');
}

function fightRoomOf(c: Campaign): string {
  const current = c.initiative?.order[c.initiative.turn]?.name;
  const ch = current === undefined ? undefined : findCharacter(c, current);
  return (ch === undefined ? undefined : roomOf(c, ch)) ?? c.currentRoom;
}

/** 线：从施法者所在格朝目标点走直线，走满长度为止（不含施法者自己那格） */
function lineCells(from: BattleCell | undefined, toward: BattleCell, feet: number): (at: Cell) => boolean {
  if (from === undefined) throw new Error('line 要给 caster，而且他要已经摆位');
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) throw new Error('线的方向点不能是施法者自己那格');
  const hit = new Set<string>();
  for (let i = 1; i <= feet / 5; i++) {
    hit.add(`${Math.round(from.x + (dx * i) / steps)},${Math.round(from.y + (dy * i) / steps)}`);
  }
  return (at) => hit.has(`${at.x},${at.y}`);
}

/** 近战判断只看备注里写明的投掷/触及；其余按普通近战武器 */
export function weaponReach(weapon: Weapon, melee = false): number | undefined {
  if (isRangedWeapon(weapon) || (!melee && /投掷|thrown/i.test(weapon.notes ?? ''))) return undefined;
  return /触及|reach/i.test(weapon.notes ?? '') ? 10 : MELEE_REACH_FEET;
}

/**
 * 攻击时对照站位：报距离，距离不合理就提醒。不拦，因为怪物和法术攻击工具分不清近战远程；
 * 判错了 dnd_undo 能退回去。借机本来就发生在对方走之前，reaction 不查够不够得着。
 */
export function attackRangeNote(
  c: Campaign,
  attacker: Character,
  target: Character,
  options: { weapon?: Weapon; reaction?: boolean; advantage?: string },
): string | undefined {
  const from = cellOf(c, attacker);
  const to = cellOf(c, target);
  if (from === undefined || to === undefined || from.room !== to.room) return undefined;
  const feet = distanceFeet(from, to);
  const parts = [`距离 ${feet} 尺`];
  // 只看直线上有没有墙和障碍：挡住了多半够不着、也看不见；门洞、柱子边上的掩护仍由 DM 判
  const wall = wallBetween(mapOf(c, from.room), from, to);
  // object 是挡路的东西（裂谷、桌子、熔炉、石柱），不一定挡视线：18 号的裂谷让隔坑射箭报了三次「看不见」
  if (wall?.kind === 'wall') parts.push(`中间隔着${areaName(wall)}，多半打不到也看不见；判错了 dnd_undo`);
  else if (wall !== undefined) parts.push(`中间有${areaName(wall)}：坑和矮家具不挡视线，高的柱子、熔炉可能给掩护，你判`);
  const reach = options.weapon === undefined ? undefined : weaponReach(options.weapon);
  if (options.weapon === undefined) {
    if (feet > MELEE_REACH_FEET && options.reaction !== true) parts.push(`如果是近战就够不到：应先 dnd_position move，判错了 dnd_undo`);
  } else if (reach !== undefined) {
    if (feet > reach && options.reaction !== true) parts.push(`${options.weapon.name} 够不到（触及 ${reach} 尺）：应先 dnd_position move，判错了 dnd_undo`);
  } else if (isRangedWeapon(options.weapon) && options.advantage !== 'disadvantage') {
    const adjacent = adjacentFoes(c, attacker, from).filter((n) => {
      const foe = findCharacter(c, n);
      return foe !== undefined && canReact(foe);
    });
    if (adjacent.length > 0) parts.push(`${adjacent.join('、')} 贴着射手，这一箭该劣势；判错了 dnd_undo 重掷`);
  }
  return `【站位】${parts.join('；')}`;
}
