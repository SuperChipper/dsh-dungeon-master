/**
 * 用模组书里的地图（玩家版）给玩家看，替代方框示意图。
 *
 * 示意图只有按估计坐标摆的方框和连线，没有墙、走廊形状和比例，玩家常看不明白。书里的玩家版地图
 * 去掉了编号和暗门标记，但整层的布局都在上面，直接整张发就等于没有迷雾。所以 fog 图只露出
 * 去过的房间（房间矩形由模组作者在原图上标出），其余涂黑，再裁到露出来的那一片——裁剪也防止
 * 画布尺寸泄露这一层还有多大。城镇、区域这种玩家本来就能拿到的图标成 full，整张发。
 *
 * 只管选图、算遮罩和裁剪；场景没有地图或当前房间不在任何一张图上时返回 undefined，
 * 调用方退回示意图。
 */
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Campaign } from './campaign.ts';
import { partyPositions } from './campaign.ts';
import { type Adventure, type MapRect, type SiteMap, mapRects, siteOfRoom } from './adventure.ts';

/** 发到群里的图最长边；原图 2750 宽，QQ 里看缩略图也够用 */
const MAX_SIDE = 1800;

export interface FogPlan {
  map: SiteMap;
  /** 图片的绝对路径 */
  image: string;
  /** 要露出来的矩形（fog 图才有；full 图为空，表示整张都露） */
  shown: MapRect[];
  /** 队伍标记：房间第一个矩形的中心，count 是那里的人数（0 = 不标数字） */
  markers: { x: number; y: number; count: number }[];
}

/** 选当前房间所在的那张图；当前房间没标在任何图上时，用场景里的 full 图（城镇里没标的小地方） */
export function pickSiteMap(c: Campaign, adv: Adventure): SiteMap | undefined {
  const site = siteOfRoom(adv, c.currentRoom);
  const maps = site?.maps ?? [];
  return maps.find((m) => m.rooms[c.currentRoom] !== undefined) ?? maps.find((m) => m.reveal === 'full');
}

/** 图片必须在模组目录里：路径来自模组 JSON，不能让它读到别处的文件 */
function imagePath(adv: Adventure, map: SiteMap): string | undefined {
  if (adv.dir === undefined) return undefined;
  const full = resolve(adv.dir, map.image);
  const rel = relative(adv.dir, full);
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return full;
}

export function planFog(c: Campaign, adv: Adventure): FogPlan | undefined {
  const map = pickSiteMap(c, adv);
  if (map === undefined) return undefined;
  const image = imagePath(adv, map);
  if (image === undefined) return undefined;
  const fog = map.reveal !== 'full';
  const shown = fog
    ? Object.entries(map.rooms).filter(([id]) => c.revealed.includes(id)).flatMap(([, rects]) => mapRects(rects))
    : [];
  if (fog && shown.length === 0) return undefined;

  const positions = partyPositions(c);
  // 只有分头行动时才标人数，全队在一起时一个点就够了
  const placed: [string, number][] = positions.size > 1
    ? [...positions].map(([room, members]) => [room, members.length])
    : [[c.currentRoom, 0]];
  const markers = placed.flatMap(([room, count]) => {
    const rects = map.rooms[room];
    if (rects === undefined) return [];
    const [x, y, w, h] = mapRects(rects)[0]!;
    return [{ x: x + w / 2, y: y + h / 2, count }];
  });
  return { map, image, shown, markers };
}

/** 裁剪框：露出来的矩形外扩一圈，夹在图内；full 图不裁 */
export function cropBox(plan: FogPlan, width: number, height: number): { left: number; top: number; width: number; height: number } {
  if (plan.shown.length === 0) return { left: 0, top: 0, width, height };
  const margin = Math.round(Math.max(80, Math.min(width, height) * 0.05));
  const left = Math.max(0, Math.min(...plan.shown.map((r) => r[0])) - margin);
  const top = Math.max(0, Math.min(...plan.shown.map((r) => r[1])) - margin);
  const right = Math.min(width, Math.max(...plan.shown.map((r) => r[0] + r[2])) + margin);
  const bottom = Math.min(height, Math.max(...plan.shown.map((r) => r[1] + r[3])) + margin);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** 覆盖层：fog 图用遮罩把没去过的地方涂黑（边缘稍微羽化），再画队伍标记 */
export function buildFogSvg(plan: FogPlan, width: number, height: number): string {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`];
  if (plan.shown.length > 0) {
    const soft = Math.max(3, Math.round(Math.min(width, height) * 0.004));
    parts.push('<defs>');
    parts.push(`<filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${soft}"/></filter>`);
    parts.push(`<mask id="fog" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">`);
    parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="white"/>`);
    parts.push('<g filter="url(#soft)">');
    for (const [x, y, w, h] of plan.shown) parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="black"/>`);
    parts.push('</g></mask></defs>');
    parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#121316" mask="url(#fog)"/>`);
  }
  const r = Math.max(14, Math.round(Math.min(width, height) * 0.013));
  for (const m of plan.markers) {
    parts.push(`<circle cx="${m.x}" cy="${m.y}" r="${r}" fill="#d4552f" stroke="#ffffff" stroke-width="${Math.max(3, Math.round(r / 5))}"/>`);
    if (m.count > 0) {
      parts.push(`<text x="${m.x}" y="${m.y + r * 0.4}" font-family="sans-serif" font-size="${Math.round(r * 1.1)}" font-weight="bold" fill="#ffffff" text-anchor="middle">${m.count}</text>`);
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

interface SharpImage {
  metadata(): Promise<{ width?: number; height?: number }>;
  composite(layers: { input: Buffer }[]): SharpImage;
  extract(region: { left: number; top: number; width: number; height: number }): SharpImage;
  resize(options: { width: number; height: number; fit: 'inside'; withoutEnlargement: boolean }): SharpImage;
  jpeg(options: { quality: number }): SharpImage;
  toBuffer(): Promise<Buffer>;
  toFile(path: string): Promise<unknown>;
}
type SharpFactory = (input: string | Buffer) => SharpImage;

let sharpPromise: Promise<SharpFactory | undefined> | undefined;

async function loadSharp(): Promise<SharpFactory | undefined> {
  sharpPromise ??= import('sharp')
    .then((mod) => ((mod as { default?: unknown }).default ?? mod) as SharpFactory)
    .catch(() => undefined);
  return sharpPromise;
}

/**
 * 画书里的地图，输出 JPEG（outPath 的扩展名会被换成 .jpg）。
 * 场景没有可用地图、或者 sharp 不可用时返回 undefined，调用方退回示意图。
 */
export async function renderBookMap(c: Campaign, adv: Adventure, outPath: string): Promise<string | undefined> {
  const plan = planFog(c, adv);
  if (plan === undefined) return undefined;
  const sharp = await loadSharp();
  if (sharp === undefined) return undefined;
  const { width, height } = await sharp(plan.image).metadata();
  if (width === undefined || height === undefined) return undefined;
  // sharp 在同一条流水线里先 extract 后 composite，所以先合成到 buffer，再裁剪缩放
  const covered = await sharp(plan.image).composite([{ input: Buffer.from(buildFogSvg(plan, width, height)) }]).toBuffer();
  const out = outPath.replace(/\.[a-z]+$/i, '') + '.jpg';
  mkdirSync(dirname(out), { recursive: true });
  await sharp(covered)
    .extract(cropBox(plan, width, height))
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(out);
  return out;
}
