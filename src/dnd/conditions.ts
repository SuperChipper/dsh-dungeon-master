/**
 * D&D 5e 全量结构化状态引擎：
 * - 14 种 PHB 标准状态 + 力竭（1–6 级）+ 濒死/稳定/专注 + 高频战斗增益（祝福术、灾祸术、护盾信仰、加速术、闪避、狂暴、妖火、神圣武器）
 * - 同义词与英文输入统一归一为中文标准名；未知/模组自定义剧情状态原样保留、绝不猜测数值或暗自拦截动作
 * - 与旧存档 `conditions: string[]` 双向同步，旧存档无需迁移即可自动享受结构化检定、移动限制与专注管理
 */
import type { BattleCell, Campaign, Character, Weapon } from './campaign.ts';
import {
  type CustomEffectDef,
  matchesDamageType,
  resolveEffectDef,
} from './custom-effects.ts';
import type { Advantage } from './dice.ts';
import { buildFormulaContext, evalIntFormula } from './formula.ts';
import type { Ability } from './rules.ts';
import type { Defense } from './save-effect.ts';
import { isCellHeavilyObscured } from './zones.ts';

export interface StateRiderSpec {
  damageDice?: string;
  bonus?: number;
  damageType: string;
}

export interface ActiveState {
  /** 归一后的标准名，如 "倒地"、"祝福术"、"神圣武器" */
  name: string;
  /** 施加者（专注归属人，或魅惑/恐慌源） */
  source?: string;
  /** 关联目标（如猎人印记/脆弱诅咒锁定的受术怪物） */
  target?: string;
  /** 是否需要 source 维持专注 */
  concentration?: boolean;
  /** 过期时机：'start_of_source_turn' | 'end_of_source_turn' | 'end_of_combat' */
  expires?: 'start_of_source_turn' | 'end_of_source_turn' | 'end_of_combat';
  /** 剩余轮数（如 1 分钟 = 10 轮；回合推进时自动递减） */
  roundsLeft?: number;
  /** 动态攻击命中加值（如神圣武器 +魅力调整值） */
  hitBonus?: number;
  /** 动态 AC 加值（如护盾信仰 +2、加速术 +2） */
  acBonus?: number;
  /** 施放该法术时使用的法术位环阶（如 4 环灵体卫士） */
  slotLevel?: number;
  /** 该状态的法术豁免 DC（如灵体卫士回合开始/进圈豁免） */
  saveDc?: number;
  /** 随状态挂载的额外命中附伤 */
  riders?: StateRiderSpec[];
}

export interface TurnActionState {
  actor: string;
  /** 本回合已执行的攻击检定次数 */
  attacks: number;
  /** 本回合已消耗的主动作（如 "冲刺"、"撤离"、"施法:祝福术"） */
  actionUsed?: string;
  /** 本回合已消耗的附赠动作（如 "战斗英姿"、"咒剑诅咒"） */
  bonusUsed?: string;
  /** 本回合是否已结算过倒地起身半速 */
  stoodUp?: boolean;
  /** 本回合主动作施放的环阶法术名（用于同回合附赠法术+主动作环阶法术规则校验） */
  leveledSpellAction?: string;
  /** 本回合附赠动作施放的法术名 */
  bonusSpellCast?: string;
  /** 本回合已触发过 oncePerTurn 钩子的规则名 */
  oncePerTurnUsed?: string[];
}

const CONDITION_ALIASES: Record<string, string> = {
  // 14 种 PHB 标准状态
  blinded: '失明',
  blind: '失明',
  目盲: '失明',
  致盲: '失明',
  失明: '失明',

  charmed: '魅惑',
  被魅惑: '魅惑',
  魅惑: '魅惑',

  deafened: '耳聋',
  deaf: '耳聋',
  失聪: '耳聋',
  耳聋: '耳聋',

  frightened: '恐慌',
  恐惧: '恐慌',
  惊恐: '恐慌',
  畏惧: '恐慌',
  恐慌: '恐慌',

  grappled: '擒抱',
  被擒抱: '擒抱',
  擒拿: '擒抱',
  擒抱: '擒抱',

  incapacitated: '失能',
  无力: '失能',
  丧失行动能力: '失能',
  失能: '失能',

  invisible: '隐形',
  隐身: '隐形',
  隐形: '隐形',

  paralyzed: '麻痹',
  paralysed: '麻痹',
  瘫痪: '麻痹',
  麻痹: '麻痹',

  petrified: '石化',
  石化: '石化',

  poisoned: '中毒',
  中毒: '中毒',

  prone: '倒地',
  击倒: '倒地',
  伏地: '倒地',
  摔倒: '倒地',
  倒地: '倒地',

  restrained: '束缚',
  被束缚: '束缚',
  捆绑: '束缚',
  纠缠: '束缚',
  束缚: '束缚',

  stunned: '震慑',
  眩晕: '震慑',
  击晕: '震慑',
  震慑: '震慑',

  unconscious: '昏迷',
  失去意识: '昏迷',
  不省人事: '昏迷',
  昏迷: '昏迷',

  // 死亡 / 稳定
  dead: '死亡',
  死亡: '死亡',
  stable: '稳定',
  伤势稳定: '稳定',
  稳定: '稳定',

  // 高频战斗增益与职业动作状态
  bless: '祝福术',
  祝福: '祝福术',
  祝福术: '祝福术',

  bane: '灾祸术',
  灾祸: '灾祸术',
  灾祸术: '灾祸术',

  'shield of faith': '护盾信仰',
  虔诚护盾: '护盾信仰',
  信仰护盾: '护盾信仰',
  虔诚之盾: '护盾信仰',
  护盾信仰: '护盾信仰',

  haste: '加速术',
  加速: '加速术',
  捷速术: '加速术',
  加速术: '加速术',

  dodge: '闪避',
  闪避动作: '闪避',
  闪避: '闪避',

  rage: '狂暴',
  狂暴: '狂暴',

  'faerie fire': '妖火',
  妖火术: '妖火',
  仙灵之火: '妖火',
  妖火: '妖火',

  'sacred weapon': '神圣武器',
  神圣武器: '神圣武器',

  hex: '脆弱诅咒',
  邪咒: '脆弱诅咒',
  诅咒术: '脆弱诅咒',
  脆弱诅咒: '脆弱诅咒',

  "hunter's mark": '猎人印记',
  'hunters mark': '猎人印记',
  猎手印记: '猎人印记',
  猎人印记: '猎人印记',

  'divine favor': '神恩',
  神恩术: '神恩',
  神恩: '神恩',

  'protection from poison': '防护毒素',
  防毒术: '防护毒素',
  防护毒素: '防护毒素',

  'spirit guardians': '灵体卫士',
  灵体守卫: '灵体卫士',
  魂灵环绕: '灵体卫士',
  圣灵守护: '灵体卫士',
  灵体卫士: '灵体卫士',

  'spiritual weapon': '灵体武器',
  精神武器: '灵体武器',
  灵体武器: '灵体武器',

  enlarge: '变巨术',
  'enlarge/reduce': '变巨术',
  变巨: '变巨术',
  成长药水: '变巨术',
  变巨缩小术: '变巨术',
  变巨术: '变巨术',

  fly: '飞行术',
  飞行术: '飞行术',

  'hold person': '人类定身术',
  定身人类: '人类定身术',
  人类定身术: '人类定身术',
  'hold monster': '怪物定身术',
  定身怪物: '怪物定身术',
  怪物定身术: '怪物定身术',
  banishment: '放逐术',
  放逐术: '放逐术',
  'fog cloud': '云雾术',
  云雾术: '云雾术',
  darkness: '黑暗术',
  黑暗术: '黑暗术',
  'wall of force': '力场墙',
  力场墙: '力场墙',
  'protection from evil and good': '防护善恶',
  防护邪恶与善良: '防护善恶',
  防护善恶: '防护善恶',
  web: '蛛网术',
  蛛网术: '蛛网术',
  entangle: '纠缠术',
  纠缠术: '纠缠术',
  moonbeam: '月华之光',
  月华之光: '月华之光',
  'hypnotic pattern': '催眠图纹',
  催眠图纹: '催眠图纹',
  fear: '恐惧术',
  恐惧术: '恐惧术',
  slow: '迟缓术',
  缓慢术: '迟缓术',
  缓慢: '迟缓术',
  迟缓: '迟缓术',
  减速术: '迟缓术',
  迟缓术: '迟缓术',
  polymorph: '变形术',
  变形术: '变形术',
  invisibility: '隐形术',
  隐身术: '隐形术',
  隐形术: '隐形术',
  'greater invisibility': '高等隐形',
  高等隐形术: '高等隐形',
  大隐形术: '高等隐形',
  高等隐身: '高等隐形',
  高等隐身术: '高等隐形',
  高等隐形: '高等隐形',
  'spike growth': '荆棘丛生',
  尖刺丛生: '荆棘丛生',
  荆棘生长: '荆棘丛生',
  荆棘丛生: '荆棘丛生',
  'cloud of daggers': '匕首之云',
  匕首之云: '匕首之云',
  'wall of fire': '火墙术',
  火墙术: '火墙术',
  silence: '沉默术',
  沉默术: '沉默术',
  'stinking cloud': '臭云术',
  臭云术: '臭云术',
  cloudkill: '死云术',
  死云术: '死云术',
  'sleet storm': '雪雨暴',
  雨夹雪: '雪雨暴',
  雨雪暴: '雪雨暴',
  雪雨暴: '雪雨暴',
};

/** 含失能效果的状态：禁止动作/附赠动作/反应，且施加时自动打断专注 */
export const INCAPACITATING_CONDITIONS = new Set(['失能', '麻痹', '石化', '震慑', '昏迷', '死亡']);

/** 使步行速度归 0 的状态 */
export const ZERO_SPEED_CONDITIONS = new Set(['死亡', '擒抱', '束缚', '麻痹', '石化', '震慑', '昏迷']);

/** 默认需要维持专注的常见状态（未显式传 concentration=false 时自动启用专注管理；灵体武器/防护毒素等非专注已排除） */
export const DEFAULT_CONCENTRATION_STATES = new Set([
  '祝福术', '灾祸术', '护盾信仰', '加速术', '妖火', '猎人印记', '脆弱诅咒',
  '神恩', '灵体卫士', '变巨术', '飞行术', '人类定身术', '怪物定身术', '放逐术',
  '云雾术', '黑暗术', '力场墙', '防护善恶', '蛛网术', '纠缠术',
  '月华之光', '催眠图纹', '恐惧术', '迟缓术', '变形术', '隐形术', '高等隐形',
  '荆棘丛生', '匕首之云', '火墙术', '沉默术', '臭云术', '死云术', '雪雨暴',
]);

/** 把英文或中文同义词归一成标准状态名；未知自定义状态原样保留（仅去首尾空白） */
export function normalizeCondition(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  const lower = trimmed.toLowerCase();
  const direct = CONDITION_ALIASES[lower];
  if (direct !== undefined) return direct;
  const exh = /^(?:exhaustion|力竭)\s*(?:[:：]|lv\.?|等级|级)?\s*([1-6])\s*级?$/i.exec(trimmed);
  if (exh !== null) return `力竭:${exh[1]}`;
  if (/^(?:exhaustion|力竭)$/i.test(trimmed)) return '力竭:1';
  return trimmed;
}

/** 解析力竭等级（0 表示无力竭，1–6 表示对应等级） */
export function exhaustionLevel(ch: Character): number {
  let max = 0;
  for (const raw of ch.conditions) {
    const norm = normalizeCondition(raw);
    const m = /^力竭:([1-6])$/.exec(norm);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  for (const s of ch.activeStates ?? []) {
    const norm = normalizeCondition(s.name);
    const m = /^力竭:([1-6])$/.exec(norm);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * 合并角色当前生效的全部状态（兼容仅有 `conditions: string[]` 的旧存档）。
 * 同名状态优先保留 `activeStates` 中的结构化元数据。
 */
export function effectiveStates(ch: Character): ActiveState[] {
  const map = new Map<string, ActiveState>();
  for (const s of ch.activeStates ?? []) {
    const name = normalizeCondition(s.name);
    if (name.length > 0) map.set(name, { ...s, name });
  }
  for (const raw of ch.conditions) {
    const name = normalizeCondition(raw);
    if (name.length > 0 && !map.has(name)) map.set(name, { name });
  }
  return [...map.values()];
}

/** 列出角色身上激活的所有自定义/内置规则定义（含 traits 常驻被动与 activeStates 限时状态） */
export function activeEffectDefsFor(
  ch: Character,
  campaignEffects?: Record<string, CustomEffectDef>,
  globalEffects?: Record<string, CustomEffectDef>,
): Array<{ def: CustomEffectDef; state?: ActiveState }> {
  const seen = new Set<string>();
  const out: Array<{ def: CustomEffectDef; state?: ActiveState }> = [];
  for (const trait of ch.traits ?? []) {
    const def = resolveEffectDef(trait, campaignEffects, globalEffects);
    if (def !== undefined && !seen.has(def.name)) {
      seen.add(def.name);
      out.push({ def });
    }
  }
  for (const s of effectiveStates(ch)) {
    const def = resolveEffectDef(s.name, campaignEffects, globalEffects);
    if (def !== undefined && !seen.has(def.name)) {
      seen.add(def.name);
      out.push({ def, state: s });
    }
  }
  return out;
}

export function hasCondition(ch: Character, canonicalName: string): boolean {
  const target = normalizeCondition(canonicalName);
  return ch.conditions.some((c) => normalizeCondition(c) === target)
    || (ch.activeStates?.some((s) => normalizeCondition(s.name) === target) ?? false);
}

export function isIncapacitated(ch: Character): boolean {
  return effectiveStates(ch).some((s) => INCAPACITATING_CONDITIONS.has(s.name));
}

export function isInvisibleState(ch: Character): boolean {
  return effectiveStates(ch).some((s) => s.name === '隐形' || s.name === '隐形术' || s.name === '高等隐形');
}

/** 角色无法执行动作/附赠动作/反应时的原因；可正常行动时返回 undefined */
export function actionRestriction(ch: Character): string | undefined {
  if (ch.hp <= 0 && ch.conditions.includes('昏迷')) {
    return `${ch.name} 处于 0 HP 昏迷状态，无法执行动作、附赠动作或反应`;
  }
  const blockers = effectiveStates(ch).filter((s) => INCAPACITATING_CONDITIONS.has(s.name)).map((s) => s.name);
  if (blockers.length > 0) {
    return `${ch.name} 处于「${blockers.join('、')}」，无法执行动作、附赠动作或反应`;
  }
  return undefined;
}

/** 力竭 4 级及以上时有效生命上限减半（不覆写角色卡原始 maxHp） */
export function effectiveMaxHp(ch: Character): number {
  return exhaustionLevel(ch) >= 4 ? Math.max(1, Math.floor(ch.maxHp / 2)) : ch.maxHp;
}

/** 结构化状态与扩展被动提供的 AC 加值（护盾信仰 +2、加速术 +2、显式 acBonus，及自定义 defenseMod.acBonus） */
export function stateAcBonus(ch: Character, c?: Campaign, globalEffects?: Record<string, CustomEffectDef>): number {
  let bonus = 0;
  const counted = new Set<string>();
  for (const s of effectiveStates(ch)) {
    if (s.acBonus !== undefined) {
      bonus += s.acBonus;
      counted.add(s.name);
    } else if (s.name === '护盾信仰' || s.name === '加速术') {
      bonus += 2;
      counted.add(s.name);
    }
    if (s.name === '迟缓术') {
      bonus -= 2;
      counted.add(s.name);
    }
  }
  const ctx = buildFormulaContext(ch);
  for (const { def } of activeEffectDefsFor(ch, c?.customEffects, globalEffects)) {
    if (counted.has(def.name) || def.defenseMod?.acBonus === undefined) continue;
    bonus += evalIntFormula(def.defenseMod.acBonus, ctx);
  }
  return bonus;
}

export interface MovementSpeedInfo {
  /** 计入加速术/力竭2级后的有效基础步行速度（未乘冲刺） */
  baseSpeed: number;
  zeroSpeed: boolean;
  zeroReasons: string[];
  notes: string[];
  /** 已绑定恐惧源名称列表 */
  fearSources: string[];
  hasUnboundFear: boolean;
}

export function movementSpeedInfo(ch: Character, defaultSpeed = 30, baseOverride?: number): MovementSpeedInfo {
  const states = effectiveStates(ch);
  const zeroReasons = states.filter((s) => ZERO_SPEED_CONDITIONS.has(s.name)).map((s) => s.name);
  const exh = exhaustionLevel(ch);
  if (exh >= 5) zeroReasons.push(`力竭:${exh}`);
  const rawSpeed = baseOverride ?? ch.speed ?? defaultSpeed;
  if (rawSpeed <= 0) zeroReasons.push('基础速度为0');

  let baseSpeed = rawSpeed;
  const notes: string[] = [];
  if (states.some((s) => s.name === '加速术')) {
    baseSpeed *= 2;
  }
  if (states.some((s) => s.name === '迟缓术')) {
    baseSpeed = Math.floor(baseSpeed / 2);
    notes.push(`迟缓术（速度减半为 ${baseSpeed} 尺）`);
  }
  if (exh >= 2 && exh < 5) {
    baseSpeed = Math.floor(baseSpeed / 2);
    notes.push(`力竭:${exh}（速度减半为 ${baseSpeed} 尺）`);
  }
  const fearStates = states.filter((s) => s.name === '恐慌');
  const fearSources = fearStates.map((s) => s.source).filter((s): s is string => s !== undefined && s.length > 0);
  const hasUnboundFear = fearStates.length > 0 && fearSources.length === 0;
  if (zeroReasons.length > 0) baseSpeed = 0;

  return {
    baseSpeed,
    zeroSpeed: zeroReasons.length > 0 || ch.hp <= 0,
    zeroReasons,
    notes,
    fearSources,
    hasUnboundFear,
  };
}

function charRoom(c: Campaign, ch: Character): string | undefined {
  return ch.kind === 'monster' ? ch.room : (ch.room ?? c.currentRoom);
}

/** 查询某施法者当前维持专注的所有状态描述 */
export function concentratingOn(c: Campaign, casterName: string): Array<{ owner: Character; state: ActiveState }> {
  const out: Array<{ owner: Character; state: ActiveState }> = [];
  for (const ch of c.characters) {
    for (const s of ch.activeStates ?? []) {
      if (s.source === casterName && s.concentration === true) {
        out.push({ owner: ch, state: s });
      }
    }
  }
  return out;
}

/** 查询某施法者当前维持专注的所有战场区域名称 */
export function concentratingZoneNames(c: Campaign, casterName: string): string[] {
  return [...new Set((c.initiative?.zones ?? []).filter((z) => z.source === casterName && z.concentration === true).map((z) => z.name))];
}

/** 打断某施法者维持的全部专注状态与专注区域效果，同步移除受术者身上的对应状态 */
export function breakConcentration(c: Campaign, casterName: string, reason?: string): string[] {
  const active = concentratingOn(c, casterName);
  const concZones = (c.initiative?.zones ?? []).filter((z) => z.source === casterName && z.concentration === true);
  if (active.length === 0 && concZones.length === 0) return [];
  const grouped = new Map<string, string[]>();
  for (const { owner, state } of active) {
    grouped.set(state.name, [...(grouped.get(state.name) ?? []), owner.name]);
    owner.activeStates = (owner.activeStates ?? []).filter((s) => !(s.source === casterName && s.concentration === true && s.name === state.name));
    if (owner.activeStates.length === 0) delete owner.activeStates;
    // 若该角色身上没有其他同名状态，同步从 conditions 移除
    const stillHas = owner.activeStates?.some((s) => normalizeCondition(s.name) === state.name) === true;
    if (!stillHas) {
      owner.conditions = owner.conditions.filter((cond) => normalizeCondition(cond) !== state.name);
    }
  }
  const lines = [...grouped.entries()].map(([spell, targets]) => `${casterName} 对「${spell}」（${targets.join('、')}）的专注中断${reason ? `（${reason}）` : ''}`);
  if (concZones.length > 0 && c.initiative?.zones !== undefined) {
    const zoneNames = [...new Set(concZones.map((z) => z.name))];
    c.initiative.zones = c.initiative.zones.filter((z) => !(z.source === casterName && z.concentration === true));
    if (c.initiative.zones.length === 0) delete c.initiative.zones;
    for (const zName of zoneNames) {
      if (!grouped.has(zName)) {
        lines.push(`${casterName} 对战场区域「${zName}」的专注中断${reason ? `（${reason}）` : ''}，区域消散`);
      }
    }
  }
  return lines;
}

/**
 * 给角色挂载或更新一条结构化状态，并同步 `ch.conditions`。
 * 注意：若新状态带 `concentration: true`，调用方若一次给多人挂同一法术，应先调一次 `breakConcentration` 或传 `replaceConcentration: false`。
 */
export function upsertActiveState(
  c: Campaign,
  ch: Character,
  input: ActiveState,
  options: { replaceConcentration?: boolean } = {},
): { broken: string[] } {
  const rawTrimmed = input.name.trim();
  const name = normalizeCondition(rawTrimmed);
  if (name.length === 0) throw new Error('状态名不能为空');
  const displayCond = rawTrimmed === '祝福' || rawTrimmed === '灾祸' ? rawTrimmed : name;
  const broken: string[] = [];
  if (input.concentration === true && input.source !== undefined && options.replaceConcentration !== false) {
    const prevStates = concentratingOn(c, input.source).filter((x) => x.state.name !== name);
    const prevZones = concentratingZoneNames(c, input.source).filter((zName) => zName !== name);
    if (prevStates.length > 0 || prevZones.length > 0) {
      broken.push(...breakConcentration(c, input.source, `改换专注为「${name}」`));
    }
  }
  // 力竭等级互斥：新力竭等级替换旧力竭等级；力竭:6 直接转死亡
  if (/^力竭:[1-6]$/.test(name)) {
    ch.conditions = ch.conditions.filter((cond) => !/^力竭:[1-6]$/.test(normalizeCondition(cond)));
    if (ch.activeStates !== undefined) {
      ch.activeStates = ch.activeStates.filter((s) => !/^力竭:[1-6]$/.test(normalizeCondition(s.name)));
    }
  }
  const clean: ActiveState = {
    name,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.target !== undefined ? { target: input.target } : {}),
    ...(input.concentration === true ? { concentration: true } : {}),
    ...(input.expires !== undefined ? { expires: input.expires } : {}),
    ...(input.roundsLeft !== undefined ? { roundsLeft: input.roundsLeft } : {}),
    ...(input.hitBonus !== undefined ? { hitBonus: input.hitBonus } : {}),
    ...(input.acBonus !== undefined ? { acBonus: input.acBonus } : {}),
    ...(input.slotLevel !== undefined ? { slotLevel: input.slotLevel } : {}),
    ...(input.saveDc !== undefined ? { saveDc: input.saveDc } : {}),
    ...(input.riders !== undefined && input.riders.length > 0 ? { riders: input.riders } : {}),
  };
  const hasMetadata = clean.source !== undefined || clean.target !== undefined || clean.concentration === true
    || clean.expires !== undefined || clean.roundsLeft !== undefined || clean.hitBonus !== undefined
    || clean.acBonus !== undefined || clean.slotLevel !== undefined || clean.saveDc !== undefined || clean.riders !== undefined;

  if (hasMetadata || ch.activeStates !== undefined) {
    const list = (ch.activeStates ?? []).filter((s) => normalizeCondition(s.name) !== name);
    list.push(clean);
    ch.activeStates = list;
  }
  // 统一把归一后的中文名写入 conditions（兼容保留“祝福/灾祸”字面简称，避免破坏旧列表断言）
  ch.conditions = ch.conditions.filter((cond) => normalizeCondition(cond) !== name);
  ch.conditions.push(displayCond);

  if (name === '力竭:4' || name === '力竭:5') {
    ch.hp = Math.min(ch.hp, effectiveMaxHp(ch));
  }
  if (name === '力竭:6') {
    ch.hp = 0;
    ch.tempHp = 0;
    if (!ch.conditions.includes('死亡')) ch.conditions.push('死亡');
  }
  if (INCAPACITATING_CONDITIONS.has(name) || name === '力竭:6') {
    broken.push(...breakConcentration(c, ch.name, `陷入${name}`));
  }
  return { broken };
}

/** 移除角色身上的某状态（兼容移除裸 `"力竭"` 清除任意等级力竭），同步清理 `activeStates` 与 `conditions` */
export function removeActiveState(ch: Character, rawName: string): string[] {
  const trimmed = rawName.trim();
  const isBareExhaustion = /^(?:exhaustion|力竭)$/i.test(trimmed);
  const norm = normalizeCondition(trimmed);
  const matches = (val: string): boolean => {
    const n = normalizeCondition(val);
    return isBareExhaustion ? /^力竭:[1-6]$/.test(n) : n === norm;
  };
  const removed = new Set<string>();
  for (const cond of ch.conditions) {
    if (matches(cond)) removed.add(normalizeCondition(cond));
  }
  for (const s of ch.activeStates ?? []) {
    if (matches(s.name)) removed.add(normalizeCondition(s.name));
  }
  if (removed.size === 0) return [];
  ch.conditions = ch.conditions.filter((cond) => !matches(cond));
  if (ch.activeStates !== undefined) {
    ch.activeStates = ch.activeStates.filter((s) => !matches(s.name));
    if (ch.activeStates.length === 0) delete ch.activeStates;
  }
  return [...removed];
}

/** 获取或初始化当前行动者的回合动作槽记录 */
export function ensureTurnState(c: Campaign): TurnActionState | undefined {
  const state = c.initiative;
  if (state === undefined) return undefined;
  const actor = state.order[state.turn]?.name;
  if (actor === undefined) return undefined;
  if (state.turnState === undefined || state.turnState.actor !== actor) {
    state.turnState = { actor, attacks: 0 };
  }
  return state.turnState;
}

/** 校验并记录 5e 同回合「附赠动作施法 + 主动作环阶法术」冲突 */
export function recordTurnSpellCast(
  ts: TurnActionState | undefined,
  actorName: string,
  spellOrSlotName: string,
  slotLevel: number,
  cost: 'action' | 'bonus' | 'reaction' | 'free' | undefined,
): string | undefined {
  if (ts === undefined || (cost !== 'action' && cost !== 'bonus')) return undefined;
  if (cost === 'bonus') {
    const prevLeveledAction = ts.leveledSpellAction;
    ts.bonusSpellCast = spellOrSlotName;
    if (prevLeveledAction !== undefined) {
      return `【施法动作经济警告】${actorName} 本回合已用主动作施放环阶法术（${prevLeveledAction}），5e 规则下施放附赠动作法术的同一回合，主动作只能施放施法时间为 1 动作的戏法（除非动作如潮或特殊规则覆盖）`;
    }
  } else if (cost === 'action' && slotLevel >= 1) {
    const prevBonusSpell = ts.bonusSpellCast;
    ts.leveledSpellAction = spellOrSlotName;
    if (prevBonusSpell !== undefined) {
      return `【施法动作经济警告】${actorName} 本回合已施放附赠动作法术（${prevBonusSpell}），5e 规则下同一回合只能再施放施法时间为 1 动作的戏法，不能再施放环阶法术（除非动作如潮或特殊规则覆盖）`;
    }
  }
  return undefined;
}

/**
 * 先攻推进时（prevActor 结束回合 → nextActor 开始回合）自动递减轮数并清理到期状态与持续区域。
 * 返回到期解除的日志行。
 */
export function tickActiveStatesOnTurnChange(c: Campaign, prevActor: string | undefined, nextActor: string): string[] {
  const logs: string[] = [];
  for (const ch of c.characters) {
    if (ch.activeStates === undefined || ch.activeStates.length === 0) continue;
    const kept: ActiveState[] = [];
    let changed = false;
    for (const s of ch.activeStates) {
      const ownerOrSource = s.source ?? ch.name;
      let shouldTick = false;
      if (prevActor !== undefined && ownerOrSource === prevActor && s.expires === 'end_of_source_turn') {
        shouldTick = true;
      } else if (ownerOrSource === nextActor && (s.expires === 'start_of_source_turn' || (s.expires === undefined && s.roundsLeft !== undefined))) {
        shouldTick = true;
      }
      if (!shouldTick) {
        kept.push(s);
        continue;
      }
      if (s.roundsLeft !== undefined && s.roundsLeft > 1) {
        kept.push({ ...s, roundsLeft: s.roundsLeft - 1 });
        changed = true;
      } else {
        changed = true;
        logs.push(`${ch.name} 的状态「${s.name}」持续时间结束`);
      }
    }
    if (changed) {
      if (kept.length > 0) ch.activeStates = kept;
      else delete ch.activeStates;
      // 同步移除已过期的状态名
      for (const line of logs) {
        const m = /^(.+?) 的状态「(.+?)」持续时间结束$/.exec(line);
        if (m !== null && m[1] === ch.name) {
          const expiredName = m[2]!;
          if (!(ch.activeStates?.some((x) => normalizeCondition(x.name) === expiredName) ?? false)) {
            ch.conditions = ch.conditions.filter((cond) => normalizeCondition(cond) !== expiredName);
          }
        }
      }
    }
  }
  if (c.initiative?.zones !== undefined && c.initiative.zones.length > 0) {
    const keptZones = [];
    const topActor = c.initiative.order[0]?.name;
    for (const z of c.initiative.zones) {
      if (z.roundsLeft === undefined) {
        keptZones.push(z);
        continue;
      }
      const owner = z.source ?? topActor;
      const shouldTick = owner !== undefined && (
        (prevActor !== undefined && owner === prevActor && z.expires === 'end_of_source_turn')
        || (owner === nextActor && z.expires !== 'end_of_source_turn')
      );
      if (!shouldTick) {
        keptZones.push(z);
        continue;
      }
      if (z.roundsLeft > 1) {
        keptZones.push({ ...z, roundsLeft: z.roundsLeft - 1 });
      } else {
        logs.push(`战场区域「${z.name}」持续时间结束，已消散`);
      }
    }
    if (keptZones.length > 0) c.initiative.zones = keptZones;
    else delete c.initiative.zones;
  }
  if (c.initiative !== undefined) {
    c.initiative.turnState = { actor: nextActor, attacks: 0 };
  }
  return logs;
}

export interface AttackStateMods {
  advantage: Advantage;
  advReasons: string[];
  disadvReasons: string[];
  /** 目标处于 5 尺内麻痹/昏迷：一旦命中自动转为重击 */
  autoCritOnHit: boolean;
  autoCritReason?: string;
  /** 扩展重击阈值（如 19 表示 19-20 重击） */
  critThreshold?: number;
  /** 状态提供的固定命中加值（如神圣武器 +3） */
  hitBonus: number;
  hitBonusReasons: string[];
  /** 自动补投的加减骰表达式（如 ["+1d4", "-1d4"]） */
  autoDice: string[];
  notes: string[];
}

function hasDiceAlready(explicitBonusDice: string | undefined, expr: string, negative: boolean): boolean {
  if (explicitBonusDice === undefined || explicitBonusDice.trim().length === 0) return false;
  const escaped = expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return negative
    ? new RegExp(`-\\s*${escaped}\\b`, 'i').test(explicitBonusDice)
    : new RegExp(`(?:^|[+\\s])${escaped}\\b`, 'i').test(explicitBonusDice);
}

function cellOfInCampaign(c: Campaign | undefined, ch: Character): BattleCell | undefined {
  const pos = c?.initiative?.positions?.[ch.name];
  if (pos === undefined || c === undefined) return undefined;
  return pos.room === charRoom(c, ch) ? pos : undefined;
}

function chebyshev3dFeet(a: BattleCell, b: BattleCell): number {
  return Math.max(Math.abs(a.x - b.x) * 5, Math.abs(a.y - b.y) * 5, Math.abs((a.z ?? 0) - (b.z ?? 0)));
}

/** 计算攻击检定双方全部结构化状态、扩展规则与战场遮蔽区域的优劣势、命中加值、自动重击与加减骰 */
export function computeAttackStateMods(
  c: Campaign,
  attacker: Character,
  target: Character,
  options: {
    distanceFt?: number;
    isRanged?: boolean;
    hasWeapon?: boolean;
    explicitAdvantage?: Advantage;
    explicitBonusDice?: string;
    fightingSpirit?: boolean;
    globalEffects?: Record<string, CustomEffectDef>;
  } = {},
): AttackStateMods {
  const atkStates = effectiveStates(attacker);
  const tgtStates = effectiveStates(target);
  const advReasons: string[] = [];
  const disadvReasons: string[] = [];
  const notes: string[] = [];

  // 1. 魅惑硬拦截：不能攻击魅惑源
  const charmed = atkStates.filter((s) => s.name === '魅惑');
  for (const chm of charmed) {
    if (chm.source !== undefined && chm.source === target.name) {
      throw new Error(`${attacker.name} 正被 ${target.name} 魅惑，规则上不能攻击魅惑源（若免疫或特殊效果覆盖请传 ignore_state_mods=true）`);
    }
    if (chm.source === undefined) {
      notes.push(`${attacker.name} 处于魅惑（未绑定源：若 ${target.name} 是魅惑源则不能攻击）`);
    }
  }

  // 2. 显式参数与战斗英姿
  if (options.explicitAdvantage === 'advantage') advReasons.push('参数指定(优)');
  if (options.explicitAdvantage === 'disadvantage') disadvReasons.push('参数指定(劣)');
  if (options.fightingSpirit === true) advReasons.push('战斗英姿(优)');

  // 3. 攻击者自身状态
  const atkFaerieFire = atkStates.some((s) => s.name === '妖火');
  if (isInvisibleState(attacker) && !atkFaerieFire) advReasons.push('自身隐形(优)');
  if (atkStates.some((s) => s.name === '失明')) disadvReasons.push('自身失明(劣)');
  if (atkStates.some((s) => s.name === '中毒')) disadvReasons.push('自身中毒(劣)');
  if (atkStates.some((s) => s.name === '倒地')) disadvReasons.push('自身倒地(劣)');
  if (atkStates.some((s) => s.name === '束缚')) disadvReasons.push('自身束缚(劣)');
  const atkExh = exhaustionLevel(attacker);
  if (atkExh >= 3) disadvReasons.push(`自身力竭:${atkExh}(劣)`);

  for (const fear of atkStates.filter((s) => s.name === '恐慌')) {
    if (fear.source !== undefined) {
      const src = c.characters.find((x) => x.name === fear.source && !x.conditions.includes('死亡'));
      if (src !== undefined && charRoom(c, src) === charRoom(c, attacker)) {
        disadvReasons.push(`恐慌源${src.name}在场(劣)`);
      }
    } else {
      notes.push(`${attacker.name} 处于恐慌（未记恐惧源：若视线内能看见恐惧源应具劣势）`);
    }
  }

  // 4. 受击目标状态
  const tgtFaerieFire = tgtStates.some((s) => s.name === '妖火');
  if (tgtFaerieFire) advReasons.push('目标妖火(优)');
  if (isInvisibleState(target) && !tgtFaerieFire) disadvReasons.push('目标隐形(劣)');
  if (tgtStates.some((s) => s.name === '失明')) advReasons.push('目标失明(优)');
  if (tgtStates.some((s) => s.name === '麻痹')) advReasons.push('目标麻痹(优)');
  if (tgtStates.some((s) => s.name === '石化')) advReasons.push('目标石化(优)');
  if (tgtStates.some((s) => s.name === '束缚')) advReasons.push('目标束缚(优)');
  if (tgtStates.some((s) => s.name === '震慑')) advReasons.push('目标震慑(优)');
  if (tgtStates.some((s) => s.name === '昏迷')) advReasons.push('目标昏迷(优)');

  if (tgtStates.some((s) => s.name === '闪避')) {
    const tgtMove = movementSpeedInfo(target);
    if (!isIncapacitated(target) && !tgtMove.zeroSpeed) {
      disadvReasons.push('目标闪避(劣)');
    }
  }

  if (tgtStates.some((s) => s.name === '倒地')) {
    const close = options.distanceFt !== undefined ? options.distanceFt <= 5 : options.isRanged !== true;
    if (close) advReasons.push('目标倒地5尺内(优)');
    else disadvReasons.push(`目标倒地${options.distanceFt !== undefined ? `${options.distanceFt}尺` : '远程'}(劣)`);
  }

  // 4b. 战场持续遮蔽区域（黑暗术 / 云雾术）
  const atkObscured = isCellHeavilyObscured(c, cellOfInCampaign(c, attacker));
  const tgtObscured = isCellHeavilyObscured(c, cellOfInCampaign(c, target));
  const obsZone = atkObscured ?? tgtObscured;
  if (obsZone !== undefined) {
    disadvReasons.push(`「${obsZone.name}」看不见目标(劣)`);
    advReasons.push(`「${obsZone.name}」目标看不见攻击者(优)`);
    notes.push(`处于「${obsZone.name}」重度遮蔽区（双向看不见默认优劣抵消；若某方具盲视/魔鬼视界可单向看穿，请传 ignore_state_mods=true 并设 advantage）`);
  }

  // 4c. 扩展规则钩子（attackMod & 目标 defenseMod.attackerAdvantage）
  const atkCtx = buildFormulaContext(attacker);
  let hitBonus = 0;
  const hitBonusReasons: string[] = [];
  const autoDice: string[] = [];
  let critThreshold: number | undefined;
  const isMelee = options.isRanged !== true;
  const isRanged = options.isRanged === true;
  const hasWeapon = options.hasWeapon !== false;

  for (const s of atkStates) {
    if (s.hitBonus !== undefined && s.hitBonus !== 0) {
      hitBonus += s.hitBonus;
      hitBonusReasons.push(`${s.name}${s.hitBonus > 0 ? '+' : ''}${s.hitBonus}`);
    }
  }
  if (atkStates.some((s) => s.name === '祝福术') && !hasDiceAlready(options.explicitBonusDice, '1d4', false)) {
    autoDice.push('+1d4');
  }
  if (atkStates.some((s) => s.name === '灾祸术') && !hasDiceAlready(options.explicitBonusDice, '1d4', true)) {
    autoDice.push('-1d4');
  }

  for (const { def, state } of activeEffectDefsFor(attacker, c.customEffects, options.globalEffects)) {
    const am = def.attackMod;
    if (am === undefined) continue;
    if (am.weaponOnly && !hasWeapon) continue;
    if (am.meleeOnly && !isMelee) continue;
    if (am.rangedOnly && !isRanged) continue;
    if (am.advantage === 'advantage') advReasons.push(`${def.name}(优)`);
    if (am.advantage === 'disadvantage') disadvReasons.push(`${def.name}(劣)`);
    if (am.critOn !== undefined) critThreshold = Math.min(critThreshold ?? 20, am.critOn);
    if (am.toHitFormula !== undefined && state?.hitBonus === undefined) {
      const val = evalIntFormula(am.toHitFormula, atkCtx);
      if (val !== 0) {
        hitBonus += val;
        hitBonusReasons.push(`${def.name}${val > 0 ? '+' : ''}${val}`);
      }
    }
    if (am.bonusDice !== undefined && !hasDiceAlready(options.explicitBonusDice, am.bonusDice, am.bonusDice.startsWith('-'))) {
      autoDice.push(am.bonusDice.startsWith('+') || am.bonusDice.startsWith('-') ? am.bonusDice : `+${am.bonusDice}`);
    }
  }

  for (const { def } of activeEffectDefsFor(target, c.customEffects, options.globalEffects)) {
    const adv = def.defenseMod?.attackerAdvantage;
    if (adv === 'advantage') advReasons.push(`目标${def.name}(优)`);
    if (adv === 'disadvantage') disadvReasons.push(`目标${def.name}(劣)`);
  }

  // 5. 5e 优劣势抵消规则
  const hasAdv = advReasons.length > 0;
  const hasDisadv = disadvReasons.length > 0;
  const advantage: Advantage = hasAdv && hasDisadv ? 'none' : hasAdv ? 'advantage' : hasDisadv ? 'disadvantage' : 'none';

  // 6. 5 尺内命中麻痹/昏迷目标自动转重击
  const within5ft = options.distanceFt !== undefined ? options.distanceFt <= 5 : options.isRanged !== true;
  const critCond = tgtStates.find((s) => s.name === '麻痹' || s.name === '昏迷');
  const autoCritOnHit = within5ft && critCond !== undefined;
  const autoCritReason = autoCritOnHit ? `目标5尺内${critCond!.name}(命中自动重击)` : undefined;

  if (atkStates.some((s) => s.name === '迟缓术')
    && c.initiative?.turnState?.actor === attacker.name
    && (c.initiative.turnState.attacks ?? 0) >= 1) {
    notes.push(`${attacker.name} 受迟缓术影响：本回合已攻击过，5e 规则下迟缓术受术者每回合至多只能进行 1 次近战或远程攻击`);
  }

  return {
    advantage,
    advReasons,
    disadvReasons,
    autoCritOnHit,
    ...(autoCritReason !== undefined ? { autoCritReason } : {}),
    ...(critThreshold !== undefined ? { critThreshold } : {}),
    hitBonus,
    hitBonusReasons,
    autoDice,
    notes,
  };
}

export interface CollectedRider {
  label: string;
  expression: string;
  damageType: string;
  oncePerTurnRule?: string;
}

function expressionContainsSameDice(explicitExtra: string | undefined, dice: string): boolean {
  if (!explicitExtra) return false;
  const cleanExtra = explicitExtra.replace(/\s+/g, '').replace(/^\+/, '').toLowerCase();
  return cleanExtra === dice.replace(/\s+/g, '').toLowerCase();
}

/**
 * 自动收集本次攻击命中时触发的全部结构化附伤（脆弱诅咒、猎人印记、神恩、狂暴、武器附伤与 dnd_rule 自定义 hitRider）。
 */
export function collectHitRiders(
  c: Campaign,
  attacker: Character,
  target: Character,
  options: {
    weapon?: Weapon;
    ability?: Ability;
    isRanged?: boolean;
    effectiveAdvantage?: Advantage;
    explicitExtraDamage?: string;
    mainDamageType?: string;
    ignoreStateMods?: boolean;
    globalEffects?: Record<string, CustomEffectDef>;
  } = {},
): { riders: CollectedRider[]; skippedNotes: string[] } {
  const riders: CollectedRider[] = [];
  const skippedNotes: string[] = [];
  let extraConsumed = false;
  const hasWeapon = options.weapon !== undefined || (attacker.kind !== 'pc' && options.ability === undefined);
  const isMelee = options.isRanged !== true;
  const usedStr = (options.ability ?? options.weapon?.ability ?? 'str') === 'str';
  const weaponDmgType = options.mainDamageType ?? '物理';

  // 1. 武器自身多段附伤（如绿龙撕裂 +2d6 毒素、魔法武器额外 +1d6 闪电）
  for (const wr of options.weapon?.riders ?? []) {
    if (!extraConsumed && expressionContainsSameDice(options.explicitExtraDamage, wr.damage)) {
      extraConsumed = true;
      skippedNotes.push(`参数 damage 已含 ${wr.damage}，跳过武器「${options.weapon!.name}」同名附伤防双算`);
      continue;
    }
    riders.push({ label: options.weapon!.name, expression: wr.damage, damageType: wr.damageType });
  }

  if (options.ignoreStateMods === true) return { riders, skippedNotes };

  const atkStates = effectiveStates(attacker);
  const tgtStates = effectiveStates(target);
  const atkCtx = buildFormulaContext(attacker);
  const ts = c.initiative?.turnState?.actor === attacker.name ? c.initiative.turnState : undefined;

  // 2. 野蛮人「狂暴」近战力量武器伤害加值（+2 / 9级+3 / 16级+4）
  if (atkStates.some((s) => s.name === '狂暴') && hasWeapon && isMelee && usedStr) {
    const rageBonus = attacker.level >= 16 ? 4 : attacker.level >= 9 ? 3 : 2;
    if (options.explicitExtraDamage?.trim() !== String(rageBonus) && options.explicitExtraDamage?.trim() !== `+${rageBonus}`) {
      riders.push({ label: '狂暴', expression: String(rageBonus), damageType: weaponDmgType });
    }
  }

  // 3. 状态上直接携带的 ad-hoc riders
  for (const s of atkStates) {
    for (const r of s.riders ?? []) {
      const parts = [r.damageDice, r.bonus !== undefined && r.bonus !== 0 ? String(r.bonus) : undefined].filter(Boolean);
      if (parts.length > 0) riders.push({ label: s.name, expression: parts.join('+'), damageType: r.damageType === '武器同型' ? weaponDmgType : r.damageType });
    }
  }

  const pushHookRider = (def: CustomEffectDef): void => {
    const hr = def.hitRider;
    if (hr === undefined) return;
    if (hr.weaponOnly && !hasWeapon) return;
    if (hr.meleeOnly && !isMelee) return;
    if (hr.strAttackOnly && !usedStr) return;
    if (hr.advantageOnly && options.effectiveAdvantage !== 'advantage') return;
    if (hr.oncePerTurn && ts?.oncePerTurnUsed?.includes(def.name)) return;

    const bonusVal = hr.bonusFormula !== undefined ? evalIntFormula(hr.bonusFormula, atkCtx) : 0;
    const exprParts: string[] = [];
    if (hr.damageDice) exprParts.push(hr.damageDice);
    if (bonusVal !== 0) exprParts.push(bonusVal > 0 && exprParts.length > 0 ? `+${bonusVal}` : String(bonusVal));
    const expr = exprParts.join('');
    if (!expr) return;
    if (!extraConsumed && hr.damageDice && bonusVal === 0 && expressionContainsSameDice(options.explicitExtraDamage, hr.damageDice)) {
      extraConsumed = true;
      skippedNotes.push(`参数 damage 已含 ${hr.damageDice}，跳过「${def.name}」自动附伤防双算`);
      return;
    }
    const resolvedType = hr.damageType === '武器同型' ? weaponDmgType : hr.damageType;
    riders.push({
      label: def.name,
      expression: expr,
      damageType: resolvedType,
      ...(hr.oncePerTurn ? { oncePerTurnRule: def.name } : {}),
    });
  };

  // 4. 攻击者身上的常驻被动与状态（神恩、变巨术、段云等；若 markedTargetOnly 则需锁定当前 target）
  const handledRules = new Set<string>();
  for (const { def, state } of activeEffectDefsFor(attacker, c.customEffects, options.globalEffects)) {
    if (def.hitRider === undefined) continue;
    if (def.hitRider.markedTargetOnly) {
      if (state?.target !== target.name) continue;
    }
    handledRules.add(def.name);
    pushHookRider(def);
  }

  // 5. 受击目标身上由当前攻击者施加的标记状态（脆弱诅咒、猎人印记等）
  for (const s of tgtStates) {
    const def = resolveEffectDef(s.name, c.customEffects, options.globalEffects);
    if (def?.hitRider?.markedTargetOnly !== true || handledRules.has(def.name)) continue;
    if (s.source !== undefined && s.source !== attacker.name) continue;
    handledRules.add(def.name);
    pushHookRider(def);
  }

  return { riders, skippedNotes };
}

export interface SaveStateMods {
  autoFail: boolean;
  autoFailReason?: string;
  advantage: Advantage;
  advReasons: string[];
  disadvReasons: string[];
  autoDice: string[];
  /** 来自守护灵光或自定义 saveMod / aura 的固定豁免加值 */
  flatBonus: number;
  flatBonusReasons: string[];
}

function isAlly(a: Character, b: Character): boolean {
  return (a.kind === 'monster') === (b.kind === 'monster');
}

export function computeSaveStateMods(
  ch: Character,
  ability: Ability,
  options: {
    explicitAdvantage?: Advantage;
    explicitBonusDice?: string;
    vsTags?: readonly string[];
    campaign?: Campaign;
    globalEffects?: Record<string, CustomEffectDef>;
  } = {},
): SaveStateMods {
  const states = effectiveStates(ch);
  if (ability === 'str' || ability === 'dex') {
    const autoFailCond = states.find((s) => s.name === '麻痹' || s.name === '石化' || s.name === '震慑' || s.name === '昏迷');
    if (autoFailCond !== undefined) {
      return {
        autoFail: true,
        autoFailReason: `处于${autoFailCond.name}（${ability === 'str' ? '力量' : '敏捷'}豁免自动失败）`,
        advantage: 'none',
        advReasons: [],
        disadvReasons: [],
        autoDice: [],
        flatBonus: 0,
        flatBonusReasons: [],
      };
    }
  }
  const advReasons: string[] = [];
  const disadvReasons: string[] = [];
  if (options.explicitAdvantage === 'advantage') advReasons.push('参数指定(优)');
  if (options.explicitAdvantage === 'disadvantage') disadvReasons.push('参数指定(劣)');

  if (ability === 'dex') {
    if (states.some((s) => s.name === '加速术')) advReasons.push('加速术(优)');
    if (states.some((s) => s.name === '闪避') && !isIncapacitated(ch) && !movementSpeedInfo(ch).zeroSpeed) {
      advReasons.push('闪避(优)');
    }
    if (states.some((s) => s.name === '束缚')) disadvReasons.push('束缚(劣)');
  }
  if (ability === 'str' && states.some((s) => s.name === '狂暴')) {
    advReasons.push('狂暴(优)');
  }
  const exh = exhaustionLevel(ch);
  if (exh >= 3) disadvReasons.push(`力竭:${exh}(劣)`);

  const autoDice: string[] = [];
  if (options.explicitBonusDice !== '') {
    if (states.some((s) => s.name === '祝福术') && !hasDiceAlready(options.explicitBonusDice, '1d4', false)) {
      autoDice.push('+1d4');
    }
    if (states.some((s) => s.name === '灾祸术') && !hasDiceAlready(options.explicitBonusDice, '1d4', true)) {
      autoDice.push('-1d4');
    }
  }

  let flatBonus = 0;
  const flatBonusReasons: string[] = [];
  if (ability === 'dex' && states.some((s) => s.name === '迟缓术')) {
    flatBonus -= 2;
    flatBonusReasons.push('迟缓术-2');
  }
  const c = options.campaign;
  const tagsLower = (options.vsTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const selfCtx = buildFormulaContext(ch);

  // 自身被动与状态的 saveMod（含防护毒素、变巨术、冥河炉心等自定义 saveMod）
  for (const { def } of activeEffectDefsFor(ch, c?.customEffects, options.globalEffects)) {
    const sm = def.saveMod;
    if (sm === undefined) continue;
    if (sm.abilities !== undefined && sm.abilities !== 'all' && !sm.abilities.includes(ability)) continue;
    if (sm.vsTags !== undefined && sm.vsTags.length > 0) {
      const matched = sm.vsTags.some((req) => {
        const r = req.toLowerCase();
        return tagsLower.some((t) => t.includes(r) || r.includes(t) || matchesDamageType(t, [req]));
      });
      if (!matched) continue;
    }
    if (sm.advantage === 'advantage' && !advReasons.includes(`${def.name}(优)`)) advReasons.push(`${def.name}(优)`);
    if (sm.advantage === 'disadvantage' && !disadvReasons.includes(`${def.name}(劣)`)) disadvReasons.push(`${def.name}(劣)`);
    if (sm.bonusFormula !== undefined) {
      const v = evalIntFormula(sm.bonusFormula, selfCtx);
      if (v !== 0) {
        flatBonus += v;
        flatBonusReasons.push(`${def.name}${v > 0 ? '+' : ''}${v}`);
      }
    }
    if (sm.bonusDice !== undefined && options.explicitBonusDice !== '' && !hasDiceAlready(options.explicitBonusDice, sm.bonusDice, sm.bonusDice.startsWith('-'))) {
      autoDice.push(sm.bonusDice.startsWith('+') || sm.bonusDice.startsWith('-') ? sm.bonusDice : `+${sm.bonusDice}`);
    }
  }

  // 圣武士【守护灵光】及自定义友方豁免光环（同名光环取最高，不重复叠加）
  if (c !== undefined) {
    const chRoom = charRoom(c, ch);
    const chCell = cellOfInCampaign(c, ch);
    const bestAuraByName = new Map<string, { val: number; provider: string }>();
    for (const other of c.characters) {
      if (other.hp <= 0 || other.conditions.includes('死亡') || isIncapacitated(other)) continue;
      if (charRoom(c, other) !== chRoom) continue;
      const otherCell = cellOfInCampaign(c, other);
      for (const { def } of activeEffectDefsFor(other, c.customEffects, options.globalEffects)) {
        const aura = def.aura;
        if (aura?.saveBonusFormula === undefined) continue;
        if (aura.target === 'allies' && !isAlly(ch, other)) continue;
        if (aura.target === 'enemies' && isAlly(ch, other)) continue;
        if (aura.includeSelf === false && other.name === ch.name) continue;
        const radius = other.level >= 18 && aura.radiusAt18 !== undefined ? aura.radiusAt18 : aura.radius;
        if (other.name !== ch.name) {
          if (c.initiative !== undefined) {
            if (chCell === undefined || otherCell === undefined) continue;
            if (chebyshev3dFeet(chCell, otherCell) > radius) continue;
          }
        }
        const val = evalIntFormula(aura.saveBonusFormula, buildFormulaContext(other));
        if (val <= 0) continue;
        const prev = bestAuraByName.get(def.name);
        if (prev === undefined || val > prev.val) {
          bestAuraByName.set(def.name, { val, provider: other.name });
        }
      }
    }
    for (const [auraName, { val, provider }] of bestAuraByName) {
      flatBonus += val;
      flatBonusReasons.push(`${auraName}${provider !== ch.name ? `(${provider})` : ''}+${val}`);
    }
  }

  const hasAdv = advReasons.length > 0;
  const hasDisadv = disadvReasons.length > 0;
  const advantage: Advantage = hasAdv && hasDisadv ? 'none' : hasAdv ? 'advantage' : hasDisadv ? 'disadvantage' : 'none';
  return { autoFail: false, advantage, advReasons, disadvReasons, autoDice, flatBonus, flatBonusReasons };
}

export interface CheckStateMods {
  advantage: Advantage;
  advReasons: string[];
  disadvReasons: string[];
  notes: string[];
}

export function computeCheckStateMods(
  c: Campaign,
  ch: Character,
  ability: Ability,
  options: { explicitAdvantage?: Advantage } = {},
): CheckStateMods {
  const states = effectiveStates(ch);
  const advReasons: string[] = [];
  const disadvReasons: string[] = [];
  const notes: string[] = [];

  if (options.explicitAdvantage === 'advantage') advReasons.push('参数指定(优)');
  if (options.explicitAdvantage === 'disadvantage') disadvReasons.push('参数指定(劣)');

  if (ability === 'str' && (states.some((s) => s.name === '狂暴') || states.some((s) => s.name === '变巨术'))) {
    advReasons.push(states.some((s) => s.name === '狂暴') ? '狂暴(优)' : '变巨术(优)');
  }
  if (states.some((s) => s.name === '中毒')) disadvReasons.push('中毒(劣)');
  const exh = exhaustionLevel(ch);
  if (exh >= 1) disadvReasons.push(`力竭:${exh}(劣)`);

  for (const fear of states.filter((s) => s.name === '恐慌')) {
    if (fear.source !== undefined) {
      const src = c.characters.find((x) => x.name === fear.source && !x.conditions.includes('死亡'));
      if (src !== undefined && charRoom(c, src) === charRoom(c, ch)) {
        disadvReasons.push(`恐慌源${src.name}在场(劣)`);
      }
    } else {
      notes.push(`${ch.name} 处于恐慌（未记恐惧源：若视线内能看见恐惧源则属性检定具劣势）`);
    }
  }
  if (states.some((s) => s.name === '耳聋')) {
    notes.push(`${ch.name} 处于耳聋（若该检定依赖听觉则自动失败）`);
  }

  const hasAdv = advReasons.length > 0;
  const hasDisadv = disadvReasons.length > 0;
  const advantage: Advantage = hasAdv && hasDisadv ? 'none' : hasAdv ? 'advantage' : hasDisadv ? 'disadvantage' : 'none';
  return { advantage, advReasons, disadvReasons, notes };
}

/** 格式化优劣势与状态修正摘要，仅在存在状态介入时输出 */
export function formatStateModSummary(
  advReasons: readonly string[],
  disadvReasons: readonly string[],
  finalAdv: Advantage,
  extras: readonly string[] = [],
): string | undefined {
  const autoReasons = [...advReasons, ...disadvReasons].filter((r) => !r.startsWith('参数指定'));
  if (autoReasons.length === 0 && extras.length === 0) return undefined;
  const parts: string[] = [];
  if (autoReasons.length > 0) {
    const outcome = advReasons.length > 0 && disadvReasons.length > 0
      ? ' → 抵消平掷'
      : finalAdv === 'advantage'
        ? ' → 优势'
        : finalAdv === 'disadvantage'
          ? ' → 劣势'
          : '';
    parts.push(`${[...advReasons, ...disadvReasons].join(' + ')}${outcome}`);
  }
  parts.push(...extras);
  return `[状态修正: ${parts.join('；')}]`;
}

/** 计算受击方结构化状态与自定义规则提供的伤害抗性/免疫/易伤（石化全伤抗性+毒免、狂暴物理抗性、防护毒素毒抗等） */
export function computeDefenseStateMod(
  target: Character,
  damageType: string | undefined,
  explicitDefense?: Defense,
  c?: Campaign,
  globalEffects?: Record<string, CustomEffectDef>,
): { defense?: Defense; reason?: string } {
  if (explicitDefense !== undefined) return { defense: explicitDefense };
  const states = effectiveStates(target);
  if (states.some((s) => s.name === '石化')) {
    if (damageType !== undefined && /毒素|毒|poison/i.test(damageType)) {
      return { defense: 'immune', reason: '石化(毒素免疫)' };
    }
    return { defense: 'resistant', reason: '石化(全伤害抗性)' };
  }
  if (states.some((s) => s.name === '狂暴') && damageType !== undefined
    && /钝击|穿刺|挥砍|物理|bludgeoning|piercing|slashing/i.test(damageType)) {
    return { defense: 'resistant', reason: '狂暴(物理抗性)' };
  }

  let immuneReason: string | undefined;
  let resistReason: string | undefined;
  let vulnReason: string | undefined;
  for (const { def } of activeEffectDefsFor(target, c?.customEffects, globalEffects)) {
    const dm = def.defenseMod;
    if (dm === undefined) continue;
    if (matchesDamageType(damageType, dm.immune)) immuneReason ??= `${def.name}(${damageType ?? ''}免疫)`;
    if (matchesDamageType(damageType, dm.resistant)) resistReason ??= `${def.name}(${damageType ?? ''}抗性)`;
    if (matchesDamageType(damageType, dm.vulnerable)) vulnReason ??= `${def.name}(${damageType ?? ''}易伤)`;
  }
  if (immuneReason !== undefined) return { defense: 'immune', reason: immuneReason };
  if (resistReason !== undefined && vulnReason !== undefined) {
    return { reason: `${resistReason}+${vulnReason}(抵消)` };
  }
  if (resistReason !== undefined) return { defense: 'resistant', reason: resistReason };
  if (vulnReason !== undefined) return { defense: 'vulnerable', reason: vulnReason };
  return {};
}

/** 把角色当前状态格式化为紧凑提示词（含剩余轮数、加值与专注归属） */
export function formatCharacterStates(c: Campaign, ch: Character): string {
  const states = effectiveStates(ch);
  const concOwned = concentratingOn(c, ch.name);
  const concZones = concentratingZoneNames(c, ch.name);
  const items = states.map((s) => {
    const meta: string[] = [];
    if (s.hitBonus !== undefined && s.hitBonus !== 0) meta.push(`命中${s.hitBonus > 0 ? '+' : ''}${s.hitBonus}`);
    if (s.acBonus !== undefined && s.acBonus !== 0) meta.push(`AC${s.acBonus > 0 ? '+' : ''}${s.acBonus}`);
    if (s.slotLevel !== undefined) meta.push(`${s.slotLevel}环`);
    if (s.roundsLeft !== undefined) meta.push(`剩${s.roundsLeft}轮`);
    if (s.concentration === true) meta.push(s.source !== undefined && s.source !== ch.name ? `由${s.source}专注` : '专注');
    return `${s.name}${meta.length > 0 ? `(${meta.join(',')})` : ''}`;
  });
  // 若该角色专注维持在队友/敌人身上或战场区域但自身不在受术列表中，也提示出来
  const externalConc = [
    ...new Set([
      ...concOwned.filter((x) => x.owner.name !== ch.name).map((x) => x.state.name),
      ...concZones,
    ]),
  ];
  for (const spell of externalConc) {
    if (!states.some((s) => s.name === spell && s.concentration === true)) {
      items.push(`维持专注:${spell}`);
    }
  }
  return items.length > 0 ? items.join('、') : '无';
}

/** 生成当前回合行动者的单行权威回合账本（仅在战斗中返回） */
export function turnLedgerLine(
  c: Campaign,
  helpers: { armorClass: (c: Campaign, ch: Character) => number; canReact: (ch: Character) => boolean; reactionBlocked: (c: Campaign, name: string) => string | undefined },
): string | undefined {
  const state = c.initiative;
  if (state === undefined) return undefined;
  const actorName = state.order[state.turn]?.name;
  if (actorName === undefined) return undefined;
  const ch = c.characters.find((x) => x.name === actorName);
  if (ch === undefined) return undefined;

  const ts = state.turnState?.actor === actorName ? state.turnState : undefined;
  const cell = cellOfInCampaign(c, ch);
  const flying = (cell?.z ?? 0) > 0;
  const flyBase = flying ? (ch.flySpeed ?? (hasCondition(ch, '飞行术') ? 60 : ch.speed ?? 30)) : undefined;
  const moveInfo = movementSpeedInfo(ch, 30, flyBase);
  const isDashed = state.dashed?.includes(ch.name) === true;
  const availSpeed = moveInfo.baseSpeed * (isDashed ? 2 : 1);
  const moved = state.moved?.[ch.name] ?? 0;

  let actionLabel = '可用';
  if (ts !== undefined) {
    if (ts.actionUsed !== undefined && ts.attacks > 0) actionLabel = `${ts.actionUsed}+已攻击×${ts.attacks}`;
    else if (ts.actionUsed !== undefined) actionLabel = ts.actionUsed;
    else if (ts.attacks > 0) actionLabel = `已攻击×${ts.attacks}`;
  }
  const bonusLabel = ts?.bonusUsed ?? '可用';
  const reactAvail = helpers.canReact(ch) && helpers.reactionBlocked(c, ch.name) === undefined ? 1 : 0;
  const effMax = effectiveMaxHp(ch);
  const altSuffix = flying ? ` ↑${cell!.z}尺` : '';
  // 怪物严格遵循 SECRET_NOTE：绝不在工具返回中暴露具体 HP/AC 数字，免得模型照抄泄露
  if (ch.kind === 'monster') {
    const wound = ch.hp <= 0 ? '倒下' : ch.hp < effMax ? '受伤' : '完好';
    return `【当前回合账本】${ch.name}（${wound}${altSuffix}） | 状态: ${formatCharacterStates(c, ch)} | 移动 ${moved}/${availSpeed}尺${ts?.stoodUp ? '(含起身)' : ''}${isDashed ? '(冲刺)' : ''} | 主动作: ${actionLabel} | 附赠: ${bonusLabel} | 反应: ${reactAvail}/1`;
  }
  const hpPart = `HP ${ch.hp}${ch.tempHp > 0 ? `+${ch.tempHp}` : ''}/${effMax}`;
  return `【当前回合账本】${ch.name}${altSuffix}：${hpPart} | AC ${helpers.armorClass(c, ch)} | 状态: ${formatCharacterStates(c, ch)} | 移动 ${moved}/${availSpeed}尺${ts?.stoodUp ? '(含起身)' : ''}${isDashed ? '(冲刺)' : ''} | 主动作: ${actionLabel} | 附赠: ${bonusLabel} | 反应: ${reactAvail}/1`;
}
