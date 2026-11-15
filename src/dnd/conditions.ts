/**
 * D&D 5e 全量结构化状态引擎：
 * - 14 种 PHB 标准状态 + 力竭（1–6 级）+ 濒死/稳定/专注 + 高频战斗增益（祝福术、灾祸术、护盾信仰、加速术、闪避、狂暴、妖火、神圣武器）
 * - 同义词与英文输入统一归一为中文标准名；未知/模组自定义剧情状态原样保留、绝不猜测数值或暗自拦截动作
 * - 与旧存档 `conditions: string[]` 双向同步，旧存档无需迁移即可自动享受结构化检定、移动限制与专注管理
 */
import type { Campaign, Character } from './campaign.ts';
import type { Advantage } from './dice.ts';
import type { Ability } from './rules.ts';
import type { Defense } from './save-effect.ts';

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
  护盾信仰: '护盾信仰',

  haste: '加速术',
  加速: '加速术',
  加速术: '加速术',

  dodge: '闪避',
  闪避动作: '闪避',
  闪避: '闪避',

  rage: '狂暴',
  狂暴: '狂暴',

  'faerie fire': '妖火',
  妖火: '妖火',

  'sacred weapon': '神圣武器',
  神圣武器: '神圣武器',
};

/** 含失能效果的状态：禁止动作/附赠动作/反应，且施加时自动打断专注 */
export const INCAPACITATING_CONDITIONS = new Set(['失能', '麻痹', '石化', '震慑', '昏迷', '死亡']);

/** 使步行速度归 0 的状态 */
export const ZERO_SPEED_CONDITIONS = new Set(['死亡', '擒抱', '束缚', '麻痹', '石化', '震慑', '昏迷']);

/** 默认需要维持专注的常见状态（未显式传 concentration=false 时自动启用专注管理） */
export const DEFAULT_CONCENTRATION_STATES = new Set([
  '祝福术', '灾祸术', '护盾信仰', '加速术', '妖火', '猎人印记', '脆弱诅咒',
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

export function hasCondition(ch: Character, canonicalName: string): boolean {
  const target = normalizeCondition(canonicalName);
  return ch.conditions.some((c) => normalizeCondition(c) === target)
    || (ch.activeStates?.some((s) => normalizeCondition(s.name) === target) ?? false);
}

export function isIncapacitated(ch: Character): boolean {
  return effectiveStates(ch).some((s) => INCAPACITATING_CONDITIONS.has(s.name));
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

/** 结构化状态提供的 AC 加值（护盾信仰 +2、加速术 +2，或显式 acBonus） */
export function stateAcBonus(ch: Character): number {
  let bonus = 0;
  for (const s of effectiveStates(ch)) {
    if (s.acBonus !== undefined) bonus += s.acBonus;
    else if (s.name === '护盾信仰' || s.name === '加速术') bonus += 2;
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

export function movementSpeedInfo(ch: Character, defaultSpeed = 30): MovementSpeedInfo {
  const states = effectiveStates(ch);
  const zeroReasons = states.filter((s) => ZERO_SPEED_CONDITIONS.has(s.name)).map((s) => s.name);
  const exh = exhaustionLevel(ch);
  if (exh >= 5) zeroReasons.push(`力竭:${exh}`);
  if ((ch.speed ?? defaultSpeed) <= 0) zeroReasons.push('基础速度为0');

  let baseSpeed = ch.speed ?? defaultSpeed;
  const notes: string[] = [];
  if (states.some((s) => s.name === '加速术')) {
    baseSpeed *= 2;
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

/** 打断某施法者维持的全部专注状态，同步移除受术者身上的对应状态 */
export function breakConcentration(c: Campaign, casterName: string, reason?: string): string[] {
  const active = concentratingOn(c, casterName);
  if (active.length === 0) return [];
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
  return [...grouped.entries()].map(([spell, targets]) => `${casterName} 对「${spell}」（${targets.join('、')}）的专注中断${reason ? `（${reason}）` : ''}`);
}

/**
 * 给角色挂载或更新一条结构化状态，并同步 `ch.conditions`。
 * 注意：若新状态带 `concentration: true`，调用方若一次给多人挂同一法术，应先调一次 `breakConcentrationIfDifferent` 或传 `replaceConcentration: true`。
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
    const prev = concentratingOn(c, input.source).filter((x) => x.state.name !== name);
    if (prev.length > 0) {
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
  };
  const hasMetadata = clean.source !== undefined || clean.target !== undefined || clean.concentration === true
    || clean.expires !== undefined || clean.roundsLeft !== undefined || clean.hitBonus !== undefined || clean.acBonus !== undefined;

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

/**
 * 先攻推进时（prevActor 结束回合 → nextActor 开始回合）自动递减轮数并清理到期状态。
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
  /** 状态提供的固定命中加值（如神圣武器 +3） */
  hitBonus: number;
  hitBonusReasons: string[];
  /** 自动补投的加减骰表达式（如 ["+1d4", "-1d4"]） */
  autoDice: string[];
  notes: string[];
}

function has1d4Already(explicitBonusDice: string | undefined, negative: boolean): boolean {
  if (explicitBonusDice === undefined || explicitBonusDice.trim().length === 0) return false;
  return negative ? /-\s*1d4\b/i.test(explicitBonusDice) : /(?:^|[+\s])1d4\b/i.test(explicitBonusDice);
}

/** 计算攻击检定双方全部结构化状态的优劣势、命中加值、自动重击与加减骰 */
export function computeAttackStateMods(
  c: Campaign,
  attacker: Character,
  target: Character,
  options: {
    distanceFt?: number;
    isRanged?: boolean;
    explicitAdvantage?: Advantage;
    explicitBonusDice?: string;
    fightingSpirit?: boolean;
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
  if (atkStates.some((s) => s.name === '隐形') && !atkFaerieFire) advReasons.push('自身隐形(优)');
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
  if (tgtStates.some((s) => s.name === '隐形') && !tgtFaerieFire) disadvReasons.push('目标隐形(劣)');
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

  // 5. 5e 优劣势抵消规则
  const hasAdv = advReasons.length > 0;
  const hasDisadv = disadvReasons.length > 0;
  const advantage: Advantage = hasAdv && hasDisadv ? 'none' : hasAdv ? 'advantage' : hasDisadv ? 'disadvantage' : 'none';

  // 6. 5 尺内命中麻痹/昏迷目标自动转重击
  const within5ft = options.distanceFt !== undefined ? options.distanceFt <= 5 : options.isRanged !== true;
  const critCond = tgtStates.find((s) => s.name === '麻痹' || s.name === '昏迷');
  const autoCritOnHit = within5ft && critCond !== undefined;
  const autoCritReason = autoCritOnHit ? `目标5尺内${critCond!.name}(命中自动重击)` : undefined;

  // 7. 固定加值与祝福/灾祸骰
  let hitBonus = 0;
  const hitBonusReasons: string[] = [];
  for (const s of atkStates) {
    if (s.hitBonus !== undefined && s.hitBonus !== 0) {
      hitBonus += s.hitBonus;
      hitBonusReasons.push(`${s.name}${s.hitBonus > 0 ? '+' : ''}${s.hitBonus}`);
    }
  }
  const autoDice: string[] = [];
  if (atkStates.some((s) => s.name === '祝福术') && !has1d4Already(options.explicitBonusDice, false)) {
    autoDice.push('+1d4');
  }
  if (atkStates.some((s) => s.name === '灾祸术') && !has1d4Already(options.explicitBonusDice, true)) {
    autoDice.push('-1d4');
  }

  return {
    advantage,
    advReasons,
    disadvReasons,
    autoCritOnHit,
    ...(autoCritReason !== undefined ? { autoCritReason } : {}),
    hitBonus,
    hitBonusReasons,
    autoDice,
    notes,
  };
}

export interface SaveStateMods {
  autoFail: boolean;
  autoFailReason?: string;
  advantage: Advantage;
  advReasons: string[];
  disadvReasons: string[];
  autoDice: string[];
}

export function computeSaveStateMods(
  ch: Character,
  ability: Ability,
  options: { explicitAdvantage?: Advantage; explicitBonusDice?: string } = {},
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

  const hasAdv = advReasons.length > 0;
  const hasDisadv = disadvReasons.length > 0;
  const advantage: Advantage = hasAdv && hasDisadv ? 'none' : hasAdv ? 'advantage' : hasDisadv ? 'disadvantage' : 'none';

  const autoDice: string[] = [];
  if (options.explicitBonusDice !== '') {
    if (states.some((s) => s.name === '祝福术') && !has1d4Already(options.explicitBonusDice, false)) {
      autoDice.push('+1d4');
    }
    if (states.some((s) => s.name === '灾祸术') && !has1d4Already(options.explicitBonusDice, true)) {
      autoDice.push('-1d4');
    }
  }
  return { autoFail: false, advantage, advReasons, disadvReasons, autoDice };
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

  if (ability === 'str' && states.some((s) => s.name === '狂暴')) advReasons.push('狂暴(优)');
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

/** 计算受击方结构化状态提供的伤害抗性/免疫（石化全伤抗性+毒免、狂暴物理三伤抗性） */
export function computeDefenseStateMod(
  target: Character,
  damageType: string | undefined,
  explicitDefense?: Defense,
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
  return {};
}

/** 把角色当前状态格式化为紧凑提示词（含剩余轮数、加值与专注归属） */
export function formatCharacterStates(c: Campaign, ch: Character): string {
  const states = effectiveStates(ch);
  const concOwned = concentratingOn(c, ch.name);
  const items = states.map((s) => {
    const meta: string[] = [];
    if (s.hitBonus !== undefined && s.hitBonus !== 0) meta.push(`命中${s.hitBonus > 0 ? '+' : ''}${s.hitBonus}`);
    if (s.acBonus !== undefined && s.acBonus !== 0) meta.push(`AC${s.acBonus > 0 ? '+' : ''}${s.acBonus}`);
    if (s.roundsLeft !== undefined) meta.push(`剩${s.roundsLeft}轮`);
    if (s.concentration === true) meta.push(s.source !== undefined && s.source !== ch.name ? `由${s.source}专注` : '专注');
    return `${s.name}${meta.length > 0 ? `(${meta.join(',')})` : ''}`;
  });
  // 若该角色专注维持在队友/敌人身上但自身不在受术列表中，也提示出来
  const externalConc = [...new Set(concOwned.filter((x) => x.owner.name !== ch.name).map((x) => x.state.name))];
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
  const moveInfo = movementSpeedInfo(ch);
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
  // 怪物严格遵循 SECRET_NOTE：绝不在工具返回中暴露具体 HP/AC 数字，免得模型照抄泄露
  if (ch.kind === 'monster') {
    const wound = ch.hp <= 0 ? '倒下' : ch.hp < effMax ? '受伤' : '完好';
    return `【当前回合账本】${ch.name}（${wound}） | 状态: ${formatCharacterStates(c, ch)} | 移动 ${moved}/${availSpeed}尺${ts?.stoodUp ? '(含起身)' : ''}${isDashed ? '(冲刺)' : ''} | 主动作: ${actionLabel} | 附赠: ${bonusLabel} | 反应: ${reactAvail}/1`;
  }
  const hpPart = `HP ${ch.hp}${ch.tempHp > 0 ? `+${ch.tempHp}` : ''}/${effMax}`;
  return `【当前回合账本】${ch.name}：${hpPart} | AC ${helpers.armorClass(c, ch)} | 状态: ${formatCharacterStates(c, ch)} | 移动 ${moved}/${availSpeed}尺${ts?.stoodUp ? '(含起身)' : ''}${isDashed ? '(冲刺)' : ''} | 主动作: ${actionLabel} | 附赠: ${bonusLabel} | 反应: ${reactAvail}/1`;
}
