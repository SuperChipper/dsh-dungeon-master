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
import type { Campaign, Character } from './campaign.ts';
import { isOut } from './campaign.ts';
import { normalizeCondition } from './conditions.ts';
import { type CustomEffectDef, resolveEffectDef } from './custom-effects.ts';
import { type BattleMap, areaName } from './terrain.ts';
import {
  type BattleZone,
  type VisualAuraRing,
  type ZoneTheme,
  activeVisualAurasInRoom,
  zonesInRoom,
} from './zones.ts';
import { loadSharp } from '../shared/sharp.ts';
import { esc } from './map-render.ts';

/** 输出图上一格的像素：手机上一格放得下一个字 */
const CELL = 48;
/** 左边和上边留给坐标数字 */
const MARGIN = 24;
const TITLE_H = 40;
const FONT = "'Microsoft YaHei','PingFang SC','Noto Sans CJK SC','Source Han Sans SC',sans-serif";

export interface Token {
  name: string;
  label: string;
  x: number;
  y: number;
  z?: number;
  kind: 'pc' | 'npc' | 'monster';
  down: boolean;
  current: boolean;
  hp: number;
  maxHp: number;
  tempHp: number;
  /** 当前生效的正面增益状态名（用于在角色棋子外画蓝圈） */
  buffs?: string[];
  /** 当前生效的负面减益/受控状态名（用于在角色棋子外画红圈） */
  debuffs?: string[];
  /** 棋子底部紧凑状态角标文字（如「倒地」「失能」「麻痹」「祝·盾」「倒·咒」） */
  badge?: string;
}

interface StateShortMeta {
  two: string;
  one: string;
  prio: number;
}

const DEBUFF_SHORT: Readonly<Record<string, StateShortMeta>> = {
  昏迷: { two: '昏迷', one: '昏', prio: 100 },
  麻痹: { two: '麻痹', one: '麻', prio: 99 },
  震慑: { two: '震慑', one: '震', prio: 98 },
  石化: { two: '石化', one: '石', prio: 97 },
  人类定身术: { two: '定身', one: '定', prio: 96 },
  怪物定身术: { two: '定身', one: '定', prio: 96 },
  催眠图纹: { two: '催眠', one: '眠', prio: 95 },
  放逐术: { two: '放逐', one: '逐', prio: 94 },
  失能: { two: '失能', one: '失', prio: 93 },
  倒地: { two: '倒地', one: '倒', prio: 90 },
  束缚: { two: '束缚', one: '束', prio: 85 },
  蛛网术: { two: '束缚', one: '网', prio: 84 },
  纠缠术: { two: '纠缠', one: '缠', prio: 84 },
  擒抱: { two: '擒抱', one: '擒', prio: 82 },
  失明: { two: '失明', one: '盲', prio: 80 },
  恐慌: { two: '恐慌', one: '恐', prio: 78 },
  恐惧术: { two: '恐慌', one: '恐', prio: 78 },
  魅惑: { two: '魅惑', one: '魅', prio: 76 },
  迟缓术: { two: '迟缓', one: '迟', prio: 75 },
  中毒: { two: '中毒', one: '毒', prio: 72 },
  耳聋: { two: '耳聋', one: '聋', prio: 65 },
  妖火: { two: '妖火', one: '妖', prio: 64 },
  灾祸术: { two: '灾祸', one: '灾', prio: 62 },
  脆弱诅咒: { two: '邪咒', one: '咒', prio: 60 },
  咒剑诅咒: { two: '咒剑', one: '咒', prio: 60 },
  猎人印记: { two: '印记', one: '印', prio: 58 },
};

const BUFF_SHORT: Readonly<Record<string, StateShortMeta>> = {
  加速术: { two: '加速', one: '速', prio: 55 },
  隐形: { two: '隐形', one: '隐', prio: 54 },
  高等隐形: { two: '高隐', one: '隐', prio: 54 },
  狂暴: { two: '狂暴', one: '狂', prio: 52 },
  灵体卫士: { two: '灵卫', one: '卫', prio: 50 },
  护盾术: { two: '护盾', one: '盾', prio: 49 },
  闪避: { two: '闪避', one: '避', prio: 48 },
  祝福术: { two: '祝福', one: '祝', prio: 46 },
  护盾信仰: { two: '圣盾', one: '盾', prio: 45 },
  神圣武器: { two: '圣武', one: '圣', prio: 44 },
  朦胧术: { two: '朦胧', one: '胧', prio: 43 },
  镜像术: { two: '镜像', one: '镜', prio: 43 },
  变巨术: { two: '变巨', one: '巨', prio: 42 },
  神恩: { two: '神恩', one: '恩', prio: 41 },
  飞行术: { two: '飞行', one: '飞', prio: 40 },
  躲藏: { two: '隐匿', one: '匿', prio: 40 },
  隐匿: { two: '隐匿', one: '匿', prio: 40 },
  防护善恶: { two: '防邪', one: '防', prio: 39 },
  防护毒素: { two: '防毒', one: '防', prio: 38 },
  战斗英姿: { two: '英姿', one: '姿', prio: 37 },
  灵体武器: { two: '灵武', one: '武', prio: 36 },
};

export function classifyTokenStates(
  c: Campaign,
  ch: Character,
  down: boolean,
  globalEffects?: Record<string, CustomEffectDef>,
): { buffs: string[]; debuffs: string[]; badge?: string } {
  if (down) {
    if (ch.kind !== 'monster' && ch.hp === 0 && !ch.conditions.includes('死亡')) {
      return {
        buffs: [],
        debuffs: [],
        badge: ch.conditions.includes('稳定') ? '稳定' : '濒死',
      };
    }
    return { buffs: [], debuffs: [] };
  }

  const rawNames: string[] = [
    ...ch.conditions,
    ...(ch.activeStates ?? []).map((s) => s.name),
    ...(c.initiative?.shielded?.includes(ch.name) ? ['护盾术'] : []),
    ...(c.initiative?.fightingSpirit?.includes(ch.name) ? ['战斗英姿'] : []),
  ];

  const seen = new Set<string>();
  const debuffItems: Array<{ name: string; two: string; one: string; prio: number }> = [];
  const buffItems: Array<{ name: string; two: string; one: string; prio: number }> = [];

  for (const raw of rawNames) {
    const trimmed = raw.trim();
    if (!trimmed || /^专注([:：]|$)/.test(trimmed)) continue;
    const norm = normalizeCondition(trimmed);
    if (norm === '死亡' || norm === '稳定' || seen.has(norm)) continue;
    seen.add(norm);

    if (DEBUFF_SHORT[norm] !== undefined) {
      debuffItems.push({ name: norm, ...DEBUFF_SHORT[norm]! });
      continue;
    }
    const exh = /^力竭([1-6])?$/.exec(norm);
    if (exh !== null) {
      debuffItems.push({ name: norm, two: exh[1] ? `竭${exh[1]}` : '力竭', one: '竭', prio: 74 });
      continue;
    }
    if (BUFF_SHORT[norm] !== undefined) {
      buffItems.push({ name: norm, ...BUFF_SHORT[norm]! });
      continue;
    }

    const st = ch.activeStates?.find((s) => normalizeCondition(s.name) === norm);
    const def = resolveEffectDef(norm, c.customEffects, globalEffects);
    const chars = [...norm];
    const fallbackTwo = chars.slice(0, 2).join('') || norm;
    const fallbackOne = chars[0] ?? '?';

    const isNegative =
      def?.hitRider?.markedTargetOnly === true
      || (def?.defenseMod?.vulnerable?.length ?? 0) > 0
      || def?.defenseMod?.attackerAdvantage === 'advantage'
      || def?.attackMod?.advantage === 'disadvantage'
      || def?.saveMod?.advantage === 'disadvantage'
      || (st?.acBonus !== undefined && st.acBonus < 0)
      || (st?.hitBonus !== undefined && st.hitBonus < 0)
      || /诅咒|印记|重伤|流血|减速|虚弱|燃烧|着火|灼烧|冰冻|麻痹|眩晕|禁锢|沉默|致盲|破甲|易伤|恶臭|疾病|腐化|压制/i.test(norm);

    const isPositive = !isNegative && (
      def !== undefined
      || (st?.acBonus !== undefined && st.acBonus > 0)
      || (st?.hitBonus !== undefined && st.hitBonus > 0)
      || (st?.riders?.length ?? 0) > 0
      || /祝福|护盾|加速|强化|鼓舞|激励|庇护|抗性|免疫|隐形|飞行|狂暴|圣光|增益|英勇|临时|闪避|镜像|朦胧|图腾|姿态|附魔/i.test(norm)
    );

    if (isPositive) {
      buffItems.push({ name: norm, two: fallbackTwo, one: fallbackOne, prio: 35 });
    } else {
      debuffItems.push({ name: norm, two: fallbackTwo, one: fallbackOne, prio: 56 });
    }
  }

  debuffItems.sort((a, b) => b.prio - a.prio);
  buffItems.sort((a, b) => b.prio - a.prio);
  const allSorted = [...debuffItems, ...buffItems].sort((a, b) => b.prio - a.prio);

  let badge: string | undefined;
  if (allSorted.length === 1) {
    badge = allSorted[0]!.two;
  } else if (allSorted.length === 2) {
    badge = `${allSorted[0]!.one}·${allSorted[1]!.one}`;
  } else if (allSorted.length >= 3) {
    badge = `${allSorted[0]!.one}·${allSorted[1]!.one}+${allSorted.length - 2}`;
  }

  return {
    buffs: buffItems.map((b) => b.name),
    debuffs: debuffItems.map((d) => d.name),
    ...(badge !== undefined ? { badge } : {}),
  };
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
export function roomTokens(
  c: Campaign,
  room: string,
  visible: (ch: Character) => boolean,
  globalEffects?: Record<string, CustomEffectDef>,
): Token[] {
  const current = c.initiative?.order[c.initiative.turn]?.name;
  const placed = c.characters.flatMap((ch) => {
    const cell = cellOf(c, ch);
    return cell !== undefined && cell.room === room && visible(ch) ? [{ ch, cell }] : [];
  });
  const labels = tokenLabels(placed.map(({ ch }) => ({ name: ch.name, monster: ch.kind === 'monster' })));
  return placed.map(({ ch, cell }) => {
    // 倒地（0 HP 在做死亡豁免）和死了都画成灰的：玩家一眼要看出谁需要救
    const down = isOut(ch) || ch.hp <= 0;
    const states = classifyTokenStates(c, ch, down, globalEffects);
    return {
      name: ch.name,
      label: labels.get(ch.name) ?? '?',
      x: cell.x,
      y: cell.y,
      ...(cell.z !== undefined && cell.z > 0 ? { z: cell.z } : {}),
      kind: ch.kind === 'monster' ? 'monster' : (ch.kind === 'pc' ? 'pc' : 'npc'),
      down,
      current: ch.name === current,
      hp: ch.hp,
      maxHp: ch.maxHp,
      tempHp: ch.tempHp ?? 0,
      ...(states.buffs.length > 0 ? { buffs: states.buffs } : {}),
      ...(states.debuffs.length > 0 ? { debuffs: states.debuffs } : {}),
      ...(states.badge !== undefined ? { badge: states.badge } : {}),
    };
  });
}

const TOKEN_FILL = { pc: '#2f7dd4', npc: '#3a9a5b', monster: '#c8372d' } as const;

const ZONE_PALETTE: Record<ZoneTheme, { fill: string; stroke: string; text: string; opacity: number }> = {
  darkness: { fill: '#221238', stroke: '#a87bff', text: '#ede0ff', opacity: 0.54 },
  poison: { fill: '#1f6e2c', stroke: '#69f0ae', text: '#e8ffe9', opacity: 0.36 },
  fire: { fill: '#c63f17', stroke: '#ff8a50', text: '#fff2e6', opacity: 0.36 },
  radiant: { fill: '#c99714', stroke: '#ffe082', text: '#fff9db', opacity: 0.34 },
  frost: { fill: '#196496', stroke: '#80d8ff', text: '#e6f7ff', opacity: 0.36 },
  nature: { fill: '#5d6b24', stroke: '#c5e1a5', text: '#f4ffdf', opacity: 0.36 },
  fog: { fill: '#546e7a', stroke: '#cfd8dc', text: '#f5f8fa', opacity: 0.44 },
};

/**
 * 叠在底图上的那一层（或者没有底图时的整张图）。坐标都是输出图的像素，左上留出标题和坐标的边。
 * withArt=false 时把地形本身也画出来：地面、墙、门、障碍、难行地形；
 * 同时支持叠加持续区域（黑暗术、毒雾、蛛网术等）、移动光环（灵体卫士）与飞行高度角标。
 */
export function buildBattleSvg(
  map: BattleMap,
  tokens: readonly Token[],
  title: string,
  withArt: boolean,
  marks: readonly { name: string; x: number; y: number }[] = [],
  zones: readonly BattleZone[] = [],
  auras: readonly VisualAuraRing[] = [],
): string {
  const W = MARGIN + map.width * CELL;
  const H = TITLE_H + MARGIN + map.height * CELL;
  const ox = MARGIN;
  const oy = TITLE_H + MARGIN;
  const px = (x: number): number => ox + x * CELL;
  const py = (y: number): number => oy + y * CELL;
  const p: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`];
  p.push(`<defs><clipPath id="gridClip"><rect x="${ox}" y="${oy}" width="${map.width * CELL}" height="${map.height * CELL}"/></clipPath></defs>`);
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

  // 绘制持续区域效果（黑暗术、毒雾、蛛网术等）与移动光环（灵体卫士）
  if (zones.length > 0 || auras.length > 0) {
    p.push('<g clip-path="url(#gridClip)">');
    for (const aura of auras) {
      const col = ZONE_PALETTE[aura.theme ?? 'radiant'];
      const rCells = Math.max(1, Math.round(aura.radius / 5));
      const rx = px(aura.x - rCells) + 2;
      const ry = py(aura.y - rCells) + 2;
      const rw = (rCells * 2 + 1) * CELL - 4;
      const rh = (rCells * 2 + 1) * CELL - 4;
      p.push(`<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="14" fill="${col.fill}" fill-opacity="0.16" stroke="${col.stroke}" stroke-width="2" stroke-dasharray="5 5"/>`);
      const tagX = Math.min(Math.max(ox + 36, rx + rw / 2), W - 36);
      const tagY = Math.max(oy + 15, ry + 15);
      p.push(`<text x="${tagX}" y="${tagY}" font-family="${FONT}" font-size="12" font-weight="bold" fill="${col.text}" stroke="#000" stroke-width="0.5" text-anchor="middle">${esc(aura.name)}</text>`);
    }
    for (const z of zones) {
      const col = ZONE_PALETTE[z.theme ?? 'fog'];
      let rx: number;
      let ry: number;
      let rw: number;
      let rh: number;
      if (z.shape === 'sphere') {
        const rCells = Math.max(1, Math.round((z.radius ?? 15) / 5));
        rx = px(z.x - rCells) + 1;
        ry = py(z.y - rCells) + 1;
        rw = (rCells * 2 + 1) * CELL - 2;
        rh = (rCells * 2 + 1) * CELL - 2;
        p.push(`<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="12" fill="${col.fill}" fill-opacity="${col.opacity}" stroke="${col.stroke}" stroke-width="2.5" stroke-dasharray="8 4"/>`);
        p.push(`<circle cx="${px(z.x) + CELL / 2}" cy="${py(z.y) + CELL / 2}" r="${(rCells + 0.42) * CELL}" fill="none" stroke="${col.stroke}" stroke-opacity="0.55" stroke-width="1.5"/>`);
      } else {
        rx = px(z.x) + 1;
        ry = py(z.y) + 1;
        rw = (z.w ?? 1) * CELL - 2;
        rh = (z.h ?? 1) * CELL - 2;
        p.push(`<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="8" fill="${col.fill}" fill-opacity="${col.opacity}" stroke="${col.stroke}" stroke-width="2.5" stroke-dasharray="8 4"/>`);
      }
      const label = `${z.name}${z.roundsLeft !== undefined && z.roundsLeft <= 20 ? `(${z.roundsLeft})` : ''}`;
      const lx = Math.min(Math.max(ox + 34, rx + rw / 2), W - 34);
      const ly = Math.min(Math.max(oy + 16, ry + 16), H - 8);
      p.push(`<text x="${lx}" y="${ly}" font-family="${FONT}" font-size="13" font-weight="bold" fill="${col.text}" stroke="#000" stroke-width="0.6" text-anchor="middle">${esc(label)}</text>`);
    }
    p.push('</g>');
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

  // 同一平面格有多枚棋子（如高空飞行悬在地面角色头顶）时微错位排布，避免完全遮挡
  const cellGroups = new Map<string, Token[]>();
  for (const t of tokens) {
    const k = `${t.x},${t.y}`;
    cellGroups.set(k, [...(cellGroups.get(k) ?? []), t]);
  }
  const badges: string[] = [];
  for (const t of tokens) {
    const siblings = cellGroups.get(`${t.x},${t.y}`) ?? [t];
    const idx = siblings.indexOf(t);
    const shift = siblings.length > 1 ? (idx === 0 ? -7 : 7) : 0;
    const cx = px(t.x) + CELL / 2 + shift;
    const cy = py(t.y) + CELL / 2 - shift * 0.6;
    const hasBuff = (t.buffs?.length ?? 0) > 0;
    const hasDebuff = (t.debuffs?.length ?? 0) > 0;
    const hasStatusRing = !t.down && (hasBuff || hasDebuff);
    const r = siblings.length > 1 ? CELL * 0.34 : (hasStatusRing ? CELL * 0.38 : CELL * 0.42);
    if (t.current) {
      const curR = hasStatusRing ? r + 6.2 : r + 5;
      p.push(`<circle cx="${cx}" cy="${cy}" r="${curR.toFixed(1)}" fill="none" stroke="#f5d142" stroke-width="${hasStatusRing ? 3 : 4}"/>`);
    }
    p.push(`<circle cx="${cx}" cy="${cy}" r="${r.toFixed(2)}" fill="${t.down ? '#6b6b6b' : TOKEN_FILL[t.kind]}" stroke="#fff" stroke-width="2.3"/>`);
    if (hasStatusRing) {
      const ringR = r + 2.9;
      const rr = ringR.toFixed(2);
      // 深色衬底环保证蓝圈叠蓝棋子、红圈叠红棋子在任何底图上都清晰分明，且外径严格 <=24px 不挤压邻格
      p.push(`<circle cx="${cx}" cy="${cy}" r="${rr}" fill="none" stroke="#12141a" stroke-width="4.8" stroke-opacity="0.88"/>`);
      if (hasBuff && !hasDebuff) {
        p.push(`<circle cx="${cx}" cy="${cy}" r="${rr}" fill="none" stroke="#38bdf8" stroke-width="3"/>`);
      } else if (hasDebuff && !hasBuff) {
        p.push(`<circle cx="${cx}" cy="${cy}" r="${rr}" fill="none" stroke="#ff3b5c" stroke-width="3"/>`);
      } else {
        const topY = (cy - ringR).toFixed(2);
        const botY = (cy + ringR).toFixed(2);
        p.push(`<path d="M ${cx} ${topY} A ${rr} ${rr} 0 0 0 ${cx} ${botY}" fill="none" stroke="#38bdf8" stroke-width="3"/>`);
        p.push(`<path d="M ${cx} ${topY} A ${rr} ${rr} 0 0 1 ${cx} ${botY}" fill="none" stroke="#ff3b5c" stroke-width="3"/>`);
      }
    }
    const size = t.label.length <= 1 ? (hasStatusRing ? 20 : 22) : (t.label.length === 2 ? 15 : 12);
    p.push(`<text x="${cx}" y="${(cy + size * 0.35 - (t.badge !== undefined ? 1.5 : 0)).toFixed(1)}" font-family="${FONT}" font-size="${size}" font-weight="bold" fill="#fff" text-anchor="middle">${esc(t.label)}</text>`);
    if (t.down) p.push(`<path d="M ${cx - r * 0.6} ${cy - r * 0.6} L ${cx + r * 0.6} ${cy + r * 0.6} M ${cx + r * 0.6} ${cy - r * 0.6} L ${cx - r * 0.6} ${cy + r * 0.6}" stroke="#fff" stroke-width="3"/>`);
    if (t.badge !== undefined) {
      const charW = [...t.badge].reduce((w, cChar) => w + (cChar.charCodeAt(0) > 127 ? 9.5 : 5.5), 6);
      const bw = Math.min(CELL - 4, Math.max(24, charW));
      const bx = Math.min(W - bw - 1, Math.max(ox + 1, cx - bw / 2));
      const by = Math.min(H - 14, cy + r - 8.2);
      const isNegBadge = hasDebuff || t.badge === '濒死';
      const badgeStroke = isNegBadge ? '#ff4d6d' : (t.badge === '稳定' ? '#69f0ae' : '#38bdf8');
      const badgeText = isNegBadge ? '#ffd6de' : (t.badge === '稳定' ? '#e0ffe8' : '#dff6ff');
      badges.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="13" rx="6.5" fill="#14161c" fill-opacity="0.94" stroke="${badgeStroke}" stroke-width="1.3"/>`);
      badges.push(`<text x="${(bx + bw / 2).toFixed(1)}" y="${(by + 9.9).toFixed(1)}" font-family="${FONT}" font-size="9.5" font-weight="bold" fill="${badgeText}" text-anchor="middle">${esc(t.badge)}</text>`);
    }
    if ((t.z ?? 0) > 0) {
      const zText = `↑${t.z}'`;
      const bw = Math.max(26, zText.length * 7 + 6);
      const bx = Math.min(W - bw - 2, cx + r * 0.35);
      const by = Math.max(oy + 2, cy - r - 8);
      badges.push(`<rect x="${bx}" y="${by}" width="${bw}" height="15" rx="7" fill="#1b1d22" stroke="#ffd54f" stroke-width="1.4"/>`);
      badges.push(`<text x="${bx + bw / 2}" y="${by + 11.5}" font-family="${FONT}" font-size="10.5" font-weight="bold" fill="#ffd54f" text-anchor="middle">${esc(zText)}</text>`);
    }
  }
  p.push(...badges);
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
  c: Campaign,
  adv: Adventure,
  room: string,
  title: string,
  outPath: string,
  visible: (ch: Character) => boolean,
  globalEffects?: Record<string, CustomEffectDef>,
): Promise<string | undefined> {
  const map = mapOf(c, room);
  if (map === undefined) return undefined;
  const sharp = await loadSharp<SharpFactory>();
  if (sharp === undefined) return undefined;
  const path = map.art === undefined ? undefined : artPath(adv, map.art.image);
  const base = path === undefined ? undefined : await cropArt(sharp, path, map).catch(() => undefined);
  const marks = Object.entries(c.initiative?.marks ?? {}).filter(([, m]) => m.room === room).map(([name, m]) => ({ name, x: m.x, y: m.y }));
  const zones = zonesInRoom(c, room);
  const auras = activeVisualAurasInRoom(c, room, visible, globalEffects);
  const svg = Buffer.from(buildBattleSvg(map, roomTokens(c, room, visible, globalEffects), title, base !== undefined, marks, zones, auras));
  const W = MARGIN + map.width * CELL;
  const H = TITLE_H + MARGIN + map.height * CELL;
  const layers = base === undefined ? [{ input: svg }] : [{ input: base, left: MARGIN, top: TITLE_H + MARGIN }, { input: svg }];
  const out = outPath.replace(/\.[a-z]+$/i, '') + '.jpg';
  mkdirSync(dirname(out), { recursive: true });
  await sharp({ create: { width: W, height: H, channels: 3, background: '#1b1d22' } }).composite(layers).jpeg({ quality: 85 }).toFile(out);
  return out;
}
