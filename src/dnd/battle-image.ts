/**
 * 发给玩家的战斗图：一个房间的场地图 + 每个人的站位。
 *
 * 群里以前只有代码块里的字符网格（# 是墙、+ 是门、字母是人），手机上常错行，玩家要对着图例数格子。
 * 有书里的底图（BattleMap.art）就裁出这间屋、按格叠上人；没有就把场地图画成一张干净的格子图。
 * 规则（移动、借机、触及）仍然只看 areas，底图只是给人看的；模型看的照旧是字符网格。
 */
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Adventure } from './adventure.ts';
import { cellOf, mapOf } from './battlefield.ts';
import { type Campaign, type Character, isOut } from './campaign.ts';
import { type BattleMap, areaName } from './terrain.ts';
import { loadSharp } from '../shared/sharp.ts';

/** 输出图上一格的像素：手机上一格放得下一个字 */
const CELL = 48;
/** 左边和上边留给坐标数字 */
const MARGIN = 24;
const TITLE_H = 40;
const FONT = "'Microsoft YaHei','PingFang SC','Noto Sans CJK SC','Source Han Sans SC',sans-serif";

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface Token {
  name: string;
  label: string;
  x: number;
  y: number;
  kind: 'pc' | 'npc' | 'monster';
  down: boolean;
  current: boolean;
}

/**
 * 图上每个人的标签：人用名字的第一个字，怪物再带上名字末尾的编号（「鼠2」）。
 * 撞了就多取一个字，免得两个「艾」分不清。
 */
export function tokenLabels(names: readonly { name: string; monster: boolean }[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const { name, monster } of names) {
    const chars = [...name.replace(/\d+$/, '')];
    const digits = monster ? (/(\d+)$/.exec(name)?.[1] ?? '') : '';
    let label = '';
    for (let n = 1; n <= Math.max(1, chars.length); n++) {
      label = chars.slice(0, n).join('') + digits;
      if (!used.has(label)) break;
    }
    used.add(label);
    result.set(name, label);
  }
  return result;
}

/** 这间屋里摆了位的人（visible 给玩家视角：藏起来的怪不画） */
export function roomTokens(c: Campaign, room: string, visible: (ch: Character) => boolean): Token[] {
  const current = c.initiative?.order[c.initiative.turn]?.name;
  const placed = c.characters.flatMap((ch) => {
    const cell = cellOf(c, ch);
    return cell !== undefined && cell.room === room && visible(ch) ? [{ ch, cell }] : [];
  });
  const labels = tokenLabels(placed.map(({ ch }) => ({ name: ch.name, monster: ch.kind === 'monster' })));
  return placed.map(({ ch, cell }) => ({
    name: ch.name,
    label: labels.get(ch.name) ?? '?',
    x: cell.x,
    y: cell.y,
    kind: ch.kind === 'monster' ? 'monster' : (ch.kind === 'pc' ? 'pc' : 'npc'),
    // 倒地（0 HP 在做死亡豁免）和死了都画成灰的：玩家一眼要看出谁需要救
    down: isOut(ch) || ch.hp <= 0,
    current: ch.name === current,
  }));
}

const TOKEN_FILL = { pc: '#2f7dd4', npc: '#3a9a5b', monster: '#c8372d' } as const;

/**
 * 叠在底图上的那一层（或者没有底图时的整张图）。坐标都是输出图的像素，左上留出标题和坐标的边。
 * withArt=false 时把地形本身也画出来：地面、墙、门、障碍、难行地形。
 */
export function buildBattleSvg(map: BattleMap, tokens: readonly Token[], title: string, withArt: boolean, marks: readonly { name: string; x: number; y: number }[] = []): string {
  const W = MARGIN + map.width * CELL;
  const H = TITLE_H + MARGIN + map.height * CELL;
  const ox = MARGIN;
  const oy = TITLE_H + MARGIN;
  const px = (x: number): number => ox + x * CELL;
  const py = (y: number): number => oy + y * CELL;
  const p: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`];
  p.push(`<rect x="0" y="0" width="${W}" height="${oy}" fill="#1b1d22"/><rect x="0" y="0" width="${ox}" height="${H}" fill="#1b1d22"/>`);
  p.push(`<text x="10" y="27" font-family="${FONT}" font-size="20" font-weight="bold" fill="#e8dcc0">${esc(title)}</text>`);

  if (!withArt) {
    p.push(`<rect x="${ox}" y="${oy}" width="${map.width * CELL}" height="${map.height * CELL}" fill="#d9d2bf"/>`);
  }
  for (const a of map.areas) {
    const x = px(a.x);
    const y = py(a.y);
    const w = (a.w ?? 1) * CELL;
    const h = (a.h ?? 1) * CELL;
    if (a.kind === 'wall' && !withArt) p.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#3b3c42"/>`);
    if (a.kind === 'outside' && !withArt) p.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#bdb6a4"/>`);
    if (a.kind === 'door') p.push(`<rect x="${x + 3}" y="${y + 3}" width="${w - 6}" height="${h - 6}" fill="#9b6a3a" fill-opacity="${withArt ? 0.35 : 0.9}" stroke="#6b4422" stroke-width="3"/>`);
    if (a.kind === 'difficult') p.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#6f8f3a" fill-opacity="0.3" stroke="#4e6b22" stroke-dasharray="6 4" stroke-width="2"/>`);
    if (a.kind === 'object') {
      p.push(`<rect x="${x + 4}" y="${y + 4}" width="${w - 8}" height="${h - 8}" rx="6" fill="#7b808a" fill-opacity="${withArt ? 0.45 : 0.9}" stroke="#4a4e56" stroke-width="2"/>`);
      p.push(`<text x="${x + w / 2}" y="${y + h / 2 + 6}" font-family="${FONT}" font-size="15" fill="#fff" stroke="#000" stroke-width="0.6" text-anchor="middle">${esc(areaName(a).slice(0, Math.max(1, Math.floor(w / 16))))}</text>`);
    }
  }
  for (const [x, y, w, h] of map.art?.shade ?? []) {
    if (withArt) p.push(`<rect x="${px(x)}" y="${py(y)}" width="${w * CELL}" height="${h * CELL}" fill="#121316" fill-opacity="0.92"/>`);
  }
  // 网格和坐标：玩家报「我走到 (6,8)」时要对得上 dnd_position 的坐标
  p.push(`<g stroke="#000" stroke-opacity="${withArt ? 0.22 : 0.18}" stroke-width="1">`);
  for (let i = 0; i <= map.width; i++) p.push(`<line x1="${px(i)}" y1="${oy}" x2="${px(i)}" y2="${H}"/>`);
  for (let j = 0; j <= map.height; j++) p.push(`<line x1="${ox}" y1="${py(j)}" x2="${W}" y2="${py(j)}"/>`);
  p.push('</g>');
  for (let i = 0; i < map.width; i++) p.push(`<text x="${px(i) + CELL / 2}" y="${oy - 7}" font-family="${FONT}" font-size="13" fill="#b8ad93" text-anchor="middle">${i}</text>`);
  for (let j = 0; j < map.height; j++) p.push(`<text x="${ox - 5}" y="${py(j) + CELL / 2 + 5}" font-family="${FONT}" font-size="13" fill="#b8ad93" text-anchor="end">${j}</text>`);

  for (const m of marks) {
    const cx = px(m.x) + CELL / 2;
    const cy = py(m.y) + CELL / 2;
    p.push(`<path d="M ${cx} ${cy - 12} L ${cx + 12} ${cy} L ${cx} ${cy + 12} L ${cx - 12} ${cy} Z" fill="#e8b830" stroke="#fff" stroke-width="2"/>`);
    p.push(`<text x="${cx}" y="${cy + 26}" font-family="${FONT}" font-size="12" fill="#fff" stroke="#000" stroke-width="0.5" text-anchor="middle">${esc(m.name.slice(0, 4))}</text>`);
  }
  for (const t of tokens) {
    const cx = px(t.x) + CELL / 2;
    const cy = py(t.y) + CELL / 2;
    const r = CELL * 0.42;
    if (t.current) p.push(`<circle cx="${cx}" cy="${cy}" r="${r + 5}" fill="none" stroke="#f5d142" stroke-width="4"/>`);
    p.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${t.down ? '#6b6b6b' : TOKEN_FILL[t.kind]}" stroke="#fff" stroke-width="2.5"/>`);
    const size = t.label.length <= 1 ? 22 : (t.label.length === 2 ? 16 : 12);
    p.push(`<text x="${cx}" y="${cy + size * 0.36}" font-family="${FONT}" font-size="${size}" font-weight="bold" fill="#fff" text-anchor="middle">${esc(t.label)}</text>`);
    if (t.down) p.push(`<path d="M ${cx - r * 0.6} ${cy - r * 0.6} L ${cx + r * 0.6} ${cy + r * 0.6} M ${cx + r * 0.6} ${cy - r * 0.6} L ${cx - r * 0.6} ${cy + r * 0.6}" stroke="#fff" stroke-width="3"/>`);
  }
  p.push('</svg>');
  return p.join('');
}

interface SharpImage {
  metadata(): Promise<{ width?: number; height?: number }>;
  extract(region: { left: number; top: number; width: number; height: number }): SharpImage;
  extend(options: { top: number; bottom: number; left: number; right: number; background: string }): SharpImage;
  resize(width: number, height: number, options: { fit: 'fill' }): SharpImage;
  composite(layers: { input: Buffer; left?: number; top?: number }[]): SharpImage;
  flatten(options: { background: string }): SharpImage;
  png(): SharpImage;
  jpeg(options: { quality: number }): SharpImage;
  toBuffer(): Promise<Buffer>;
  toFile(path: string): Promise<unknown>;
}
type SharpFactory = (input: string | Buffer | { create: { width: number; height: number; channels: 3; background: string } }) => SharpImage;

/** 底图路径必须在模组目录里 */
function artPath(adv: Adventure, image: string): string | undefined {
  if (adv.dir === undefined) return undefined;
  const full = resolve(adv.dir, image);
  const rel = relative(adv.dir, full);
  return rel.startsWith('..') || isAbsolute(rel) ? undefined : full;
}

/** 从书里的地图上裁出这间屋（超出原图的部分补黑），缩放到每格 CELL 像素 */
async function cropArt(sharp: SharpFactory, path: string, map: BattleMap): Promise<Buffer | undefined> {
  const art = map.art!;
  const { width: iw, height: ih } = await sharp(path).metadata();
  if (iw === undefined || ih === undefined) return undefined;
  const want = { left: Math.round(art.left), top: Math.round(art.top), width: Math.round(map.width * art.cell), height: Math.round(map.height * art.cell) };
  const left = Math.max(0, want.left);
  const top = Math.max(0, want.top);
  const right = Math.min(iw, want.left + want.width);
  const bottom = Math.min(ih, want.top + want.height);
  if (right <= left || bottom <= top) return undefined;
  const cut = await sharp(path).extract({ left, top, width: right - left, height: bottom - top })
    .extend({ left: left - want.left, top: top - want.top, right: want.left + want.width - right, bottom: want.top + want.height - bottom, background: '#121316' })
    .toBuffer();
  return sharp(cut).resize(map.width * CELL, map.height * CELL, { fit: 'fill' }).png().toBuffer();
}

/**
 * 画一个房间的战斗图，输出 JPEG（outPath 的扩展名换成 .jpg）。
 * 这间屋还没有场地图、或 sharp 不可用时返回 undefined。
 */
export async function renderBattleImage(
  c: Campaign, adv: Adventure, room: string, title: string, outPath: string, visible: (ch: Character) => boolean,
): Promise<string | undefined> {
  const map = mapOf(c, room);
  if (map === undefined) return undefined;
  const sharp = await loadSharp<SharpFactory>();
  if (sharp === undefined) return undefined;
  const path = map.art === undefined ? undefined : artPath(adv, map.art.image);
  const base = path === undefined ? undefined : await cropArt(sharp, path, map).catch(() => undefined);
  const marks = Object.entries(c.initiative?.marks ?? {}).filter(([, m]) => m.room === room).map(([name, m]) => ({ name, x: m.x, y: m.y }));
  const svg = Buffer.from(buildBattleSvg(map, roomTokens(c, room, visible), title, base !== undefined, marks));
  const W = MARGIN + map.width * CELL;
  const H = TITLE_H + MARGIN + map.height * CELL;
  const layers = base === undefined ? [{ input: svg }] : [{ input: base, left: MARGIN, top: TITLE_H + MARGIN }, { input: svg }];
  const out = outPath.replace(/\.[a-z]+$/i, '') + '.jpg';
  mkdirSync(dirname(out), { recursive: true });
  await sharp({ create: { width: W, height: H, channels: 3, background: '#1b1d22' } }).composite(layers).jpeg({ quality: 85 }).toFile(out);
  return out;
}
