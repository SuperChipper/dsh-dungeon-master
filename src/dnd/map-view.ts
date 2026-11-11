/**
 * 给玩家看的地图：dnd_map（DM 调）和 /dnd map（玩家敲）共用这一个入口，两边看到的永远是同一张。
 *
 * 选图顺序：打仗时发交战房间的战斗图（有底图用底图，没底图按场地图画）；平时发探索地图（书里的玩家版地图
 * 加迷雾，没有就画方框示意图）。位置、轮次这些说明都画进图的标题条里，消息本身不再附一大段文字。
 */
import { type Adventure, roomGraph, siteOfRoom } from './adventure.ts';
import { renderBattleImage, roomTokens } from './battle-image.ts';
import { hiddenFromPlayers, mapOf } from './battlefield.ts';
import { renderBookMap } from './book-map.ts';
import { type Campaign, explored, findCharacter, partyPositions, roomOf } from './campaign.ts';
import { findRoom } from './dungeon.ts';
import { renderMapPng } from './map-render.ts';
import { exitsLine } from './text-map.ts';

export type MapView = 'auto' | 'battle' | 'explore';

export interface RenderedMap {
  path: string;
  kind: 'battle' | 'book' | 'schematic';
}

/** 模组房间名常带书里的区域号（「14. 莫阿的墓」），标题里留着：书里的地图也按这个编号 */
function roomName(adv: Adventure, room: string): string {
  return findRoom(roomGraph(adv), room)?.name ?? room;
}

/** 交战房间：当前行动者所在的房间，没开战就是队伍所在 */
export function battleRoom(c: Campaign): string {
  const current = c.initiative?.order[c.initiative.turn]?.name;
  const ch = current === undefined ? undefined : findCharacter(c, current);
  return (ch === undefined ? undefined : roomOf(c, ch)) ?? c.currentRoom;
}

export function battleTitle(c: Campaign, adv: Adventure, room: string): string {
  const state = c.initiative;
  if (state === undefined) return roomName(adv, room);
  const current = state.order[state.turn]?.name;
  return [`第 ${state.round} 轮`, roomName(adv, room), ...(current !== undefined ? [`轮到 ${current}`] : [])].join(' · ');
}

export function exploreTitle(c: Campaign, adv: Adventure): string {
  const site = siteOfRoom(adv, c.currentRoom);
  const { seen, total } = explored(c, adv);
  return [site?.name ?? adv.name, roomName(adv, c.currentRoom), `已探索 ${seen}/${total}`].join(' · ');
}

/** 说明里「能去」最多列几处：再多手机上一屏装不下 */
const MAX_EXITS = 6;

/**
 * 图下面那几行字：图上画不出来的东西。
 * 战斗图配图例（圆片上的字是谁、谁倒了、有名字的障碍和难行地形）；探索地图配「你们在哪、能去哪」。
 * 地点、轮次、轮到谁已经在图的标题条上，这里不重复。
 */
export function mapCaption(c: Campaign, adv: Adventure, kind: RenderedMap['kind']): string {
  if (kind === 'battle') {
    const room = battleRoom(c);
    const tokens = roomTokens(c, room, (ch) => !hiddenFromPlayers(ch));
    const group = (k: 'pc' | 'npc' | 'monster'): string => legendEntries(tokens.filter((t) => t.kind === k && !t.down)).join(' ');
    const lines = [
      ...(group('pc') ? [`🔵 ${group('pc')}`] : []),
      ...(group('npc') ? [`🟢 ${group('npc')}`] : []),
      ...(group('monster') ? [`🔴 ${group('monster')}`] : []),
    ];
    const down = tokens.filter((t) => t.down).map((t) => t.name);
    if (down.length > 0) lines.push(`⚪ 倒地：${down.join('、')}`);
    const areas = mapOf(c, room)?.areas ?? [];
    const named = (k: 'object' | 'difficult'): string[] => [...new Set(areas.filter((a) => a.kind === k && a.name !== undefined).map((a) => a.name!))];
    const terrain = [
      ...(named('object').length > 0 ? [`挡路：${named('object').join('、')}`] : []),
      ...(named('difficult').length > 0 ? [`难行：${named('difficult').join('、')}`] : []),
    ];
    if (terrain.length > 0) lines.push(`🧱 ${terrain.join('；')}`);
    // 门是图上的棕色格子，门外是浅色那几格：不说的话新玩家认不出来
    const doors = [...new Set(areas.filter((a) => a.kind === 'door').map((a) => {
      const name = a.name ?? '门';
      return a.to === undefined ? name : `${name}（通${plainRoomName(adv, a.to)}）`;
    }))];
    const hasOutside = areas.some((a) => a.kind === 'outside');
    if (doors.length > 0 || hasOutside) {
      lines.push(`🚪 ${[...(doors.length > 0 ? [`棕色格是门：${doors.join('、')}`] : []), ...(hasOutside ? ['门外的格子也能站人'] : [])].join('；')}`);
    }
    lines.push('报位置用 (列,行)，如 (6,8)');
    return lines.join('\n');
  }
  const lines: string[] = [];
  const positions = partyPositions(c);
  if (positions.size > 1) {
    lines.push(`📍 ${[...positions].map(([room, members]) => `${members.map((m) => m.name).join('、')}：${plainRoomName(adv, room)}`).join('｜')}`);
  } else {
    lines.push('📍 红点是你们');
  }
  const exits = exitsLine(c, adv, MAX_EXITS);
  if (exits !== undefined) lines.push(exits);
  return lines.join('\n');
}

/**
 * 图例条目。同名带编号的怪合成一条（「翼1–8=翼手族」），八只怪逐个列要占一整行；
 * 编号不连续就列出来（「翼1,3,5=翼手族」）。
 */
function legendEntries(tokens: readonly { name: string; label: string }[]): string[] {
  const entries: string[] = [];
  const packs = new Map<string, { prefix: string; base: string; nums: number[] }>();
  for (const t of tokens) {
    const name = /^(.*?)(\d+)$/.exec(t.name);
    const label = /^(.*?)(\d+)$/.exec(t.label);
    if (name === null || label === null || name[2] !== label[2]) {
      entries.push(t.label === t.name ? t.name : `${t.label}=${t.name}`);
      continue;
    }
    const key = `${label[1]}=${name[1]}`;
    if (!packs.has(key)) {
      packs.set(key, { prefix: label[1]!, base: name[1]!, nums: [] });
      entries.push(key); // 占位，保持出现顺序
    }
    packs.get(key)!.nums.push(Number(name[2]));
  }
  return entries.map((e) => {
    const pack = packs.get(e);
    if (pack === undefined) return e;
    const nums = [...pack.nums].sort((a, b) => a - b);
    if (nums.length === 1) return `${pack.prefix}${nums[0]}=${pack.base}${nums[0]}`;
    const run = nums.every((n, i) => i === 0 || n === nums[i - 1]! + 1);
    return `${pack.prefix}${run ? `${nums[0]}–${nums[nums.length - 1]}` : nums.join(',')}=${pack.base}`;
  });
}

/** 说明文字里去掉书里的区域号，读起来顺（标题条里留着，对得上书里的地图） */
function plainRoomName(adv: Adventure, room: string): string {
  return roomName(adv, room).replace(/^\d+[a-zA-Z]?(–\d+[a-zA-Z]?)?\.\s*/, '');
}

/**
 * 画一张地图。view=battle 但交战房间还没有场地图时抛错（让调用方提示先画）；
 * 其余情况画不出来（没装 sharp）返回 undefined，调用方退回文字地图。
 */
export async function renderPartyMap(
  c: Campaign, adv: Adventure, outPath: string, view: MapView = 'auto', options: { schematic?: boolean } = {},
): Promise<RenderedMap | undefined> {
  if (view === 'battle' || (view === 'auto' && c.initiative !== undefined)) {
    const room = battleRoom(c);
    if (mapOf(c, room) === undefined && view === 'battle') throw new Error(`「${roomName(adv, room)}」还没有场地图`);
    const path = await renderBattleImage(c, adv, room, battleTitle(c, adv, room), outPath, (ch) => !hiddenFromPlayers(ch));
    if (path !== undefined) return { path, kind: 'battle' };
    if (view === 'battle') return undefined;
  }
  const title = exploreTitle(c, adv);
  const book = options.schematic === true ? undefined : await renderBookMap(c, adv, outPath, title);
  if (book !== undefined) return { path: book, kind: 'book' };
  const schematic = await renderMapPng(c, adv, outPath, title);
  return schematic === undefined ? undefined : { path: schematic, kind: 'schematic' };
}
