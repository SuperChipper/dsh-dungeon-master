/**
 * 豁免类效果的一次结算：火球、吐息、圣火术这类「目标各自豁免、伤害掷一次」的效果。
 *
 * 以前一发火球打五只怪要 dnd_check save ×5 + dnd_roll + dnd_apply ×5，模型还得自己算减半和抗性；
 * 这里一次给出每个目标的豁免、伤害和 HP 变化，减半/抗性/免疫/易伤按 5e 顺序算（先减半再抗性，都向下取整）。
 */
import { type Advantage, type DiceResult, type Roller, rollD20, rollExpression } from './dice.ts';
import { type Campaign, type HpChange, applyDamage, changeCondition, checkModifier, requireCharacter } from './campaign.ts';
import type { Ability } from './rules.ts';

export type Defense = 'resistant' | 'immune' | 'vulnerable';

const DEFENSE_ALIASES: Record<string, Defense> = {
  resistant: 'resistant', resistance: 'resistant', 抗性: 'resistant', 抗: 'resistant',
  immune: 'immune', immunity: 'immune', 免疫: 'immune',
  vulnerable: 'vulnerable', vulnerability: 'vulnerable', 易伤: 'vulnerable',
};

export const DEFENSE_NAMES: Record<Defense, string> = { resistant: '抗性', immune: '免疫', vulnerable: '易伤' };

export function parseDefense(value: unknown): Defense | undefined {
  return typeof value === 'string' ? DEFENSE_ALIASES[value.trim().toLowerCase()] : undefined;
}

/** 豁免成功减半（或无伤），再按抗性/免疫/易伤调整 */
export function saveDamage(total: number, saved: boolean, onSave: 'half' | 'none', defense?: Defense): number {
  let dmg = Math.max(0, Math.trunc(total));
  if (saved) dmg = onSave === 'none' ? 0 : Math.floor(dmg / 2);
  if (defense === 'immune') return 0;
  if (defense === 'resistant') return Math.floor(dmg / 2);
  if (defense === 'vulnerable') return dmg * 2;
  return dmg;
}

export interface SaveTarget {
  name: string;
  advantage?: Advantage;
  bonus?: number;
  bonusDice?: string;
  defense?: Defense;
}

/** targets 既可以是名字，也可以是 {name, advantage, bonus, defense}；非法项直接报错，免得静默漏掉一个目标 */
export function parseSaveTargets(value: unknown): SaveTarget[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((raw) => {
    if (typeof raw === 'string' && raw.trim().length > 0) return { name: raw.trim() };
    const o = (raw ?? {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (name.length === 0) throw new Error('targets 每一项要有 name');
    const t: SaveTarget = { name };
    if (o.advantage === 'advantage' || o.advantage === 'disadvantage' || o.advantage === 'none') t.advantage = o.advantage;
    if (typeof o.bonus === 'number' && Number.isFinite(o.bonus)) t.bonus = Math.trunc(o.bonus);
    if (typeof o.bonus_dice === 'string') t.bonusDice = o.bonus_dice.trim();
    if (o.defense !== undefined) {
      const d = parseDefense(o.defense);
      if (d === undefined) throw new Error(`${name} 的 defense 只能是 resistant/immune/vulnerable（抗性/免疫/易伤）`);
      t.defense = d;
    }
    return t;
  });
}

export interface SaveEffectInput {
  targets: SaveTarget[];
  ability: Ability;
  /** 不传时只报点数、不判成败，也不结算伤害 */
  dc?: number;
  /** 伤害表达式：所有目标共用一次掷骰 */
  damage?: string;
  damageType?: string;
  onSave?: 'half' | 'none';
  /** 豁免失败附带的状态（定身术的麻痹、雷鸣波的倒地）：和伤害同一步落账，撤销时也一起退 */
  onFail?: string[];
  /** 所有目标默认的优劣势和加值；目标自己的设置优先 */
  advantage?: Advantage;
  bonus?: number;
  /** 每个目标各掷一次加在豁免上（祝福术） */
  bonusDice?: string;
  roller: Roller;
}

/** 一个目标掷完、还没结算的那一骰 */
export interface RolledSave {
  name: string;
  /** 已死亡等原因跳过时的说明 */
  skipped?: string;
  natural?: number;
  /** 含 bonus 和祝福骰：重掷时只换 d20，这些照旧 */
  modifier?: number;
  advantage?: Advantage;
  total?: number;
  detail?: string;
  defense?: Defense;
}

export interface RolledSaveEffect {
  damageRoll?: DiceResult;
  saves: RolledSave[];
}

export interface SaveOutcome {
  name: string;
  skipped?: string;
  detail?: string;
  saved?: boolean;
  natural?: number;
  damage?: number;
  defense?: Defense;
  change?: HpChange;
  /** 豁免失败加上的状态 */
  conditions?: string[];
}

export interface SaveEffectResult {
  damageRoll?: DiceResult;
  outcomes: SaveOutcome[];
}

/** 只掷不结算：伤害骰一次，每个目标各一骰。任何一个目标找不到都在掷骰前抛错 */
export function rollSaveEffect(c: Campaign, input: SaveEffectInput): RolledSaveEffect {
  if (input.targets.length === 0) throw new Error('targets 不能为空');
  if (input.damage !== undefined && input.dc === undefined) throw new Error('带伤害的豁免要给 dc，才能判定减半');
  if ((input.onFail?.length ?? 0) > 0 && input.dc === undefined) throw new Error('on_fail_conditions 要给 dc，才能判定谁失败');
  const seen = new Set<string>();
  const resolved = input.targets.flatMap((t) => {
    const ch = requireCharacter(c, t.name);
    if (seen.has(ch.name)) return [];
    seen.add(ch.name);
    return [{ t, ch }];
  });
  const damageRoll = input.damage === undefined ? undefined : rollExpression(input.damage, input.roller);
  const saves = resolved.map(({ t, ch }): RolledSave => {
    if (ch.conditions.includes('死亡')) return { name: ch.name, skipped: '已死亡' };
    const bonusDice = t.bonusDice ?? input.bonusDice;
    const extra = bonusDice === undefined || bonusDice.length === 0 ? undefined : rollExpression(bonusDice, input.roller);
    const modifier = checkModifier(ch, 'save', input.ability) + (t.bonus ?? input.bonus ?? 0) + (extra?.total ?? 0);
    const advantage = t.advantage ?? input.advantage ?? 'none';
    const roll = rollD20(modifier, advantage, input.roller);
    const out: RolledSave = {
      name: ch.name, natural: roll.natural, modifier, advantage, total: roll.total,
      detail: `${roll.detail}${extra !== undefined ? `（含 ${extra.detail}）` : ''}`,
    };
    if (t.defense !== undefined) out.defense = t.defense;
    return out;
  });
  return damageRoll === undefined ? { saves } : { damageRoll, saves };
}

export interface ApplySaveInput {
  dc?: number;
  /** 已经掷好的伤害总数（反应改过的） */
  damage?: number;
  damageType?: string;
  onSave?: 'half' | 'none';
  onFail?: string[];
  roller: Roller;
}

/** 按掷好的骰子判成败、扣血、加状态 */
export function applySaveEffect(c: Campaign, saves: readonly RolledSave[], input: ApplySaveInput): SaveOutcome[] {
  return saves.map((s): SaveOutcome => {
    if (s.skipped !== undefined || s.total === undefined) return { name: s.name, skipped: s.skipped ?? '没有掷骰' };
    const base: SaveOutcome = { name: s.name, ...(s.detail !== undefined ? { detail: s.detail } : {}), ...(s.natural !== undefined ? { natural: s.natural } : {}) };
    if (input.dc === undefined) return base;
    const saved = s.total >= input.dc;
    const out: SaveOutcome = { ...base, saved };
    if (s.defense !== undefined) out.defense = s.defense;
    if (input.damage !== undefined) {
      out.damage = saveDamage(input.damage, saved, input.onSave ?? 'half', s.defense);
      if (out.damage > 0) out.change = applyDamage(c, s.name, out.damage, { damageType: input.damageType, roller: input.roller });
    }
    const conditions = saved ? [] : (input.onFail ?? []);
    if (conditions.length > 0 && !requireCharacter(c, s.name).conditions.includes('死亡')) {
      for (const cond of conditions) changeCondition(c, s.name, cond, true);
      out.conditions = [...conditions];
    }
    return out;
  });
}

/** 掷完立刻结算：没有人要反应时走这里 */
export function resolveSaveEffect(c: Campaign, input: SaveEffectInput): SaveEffectResult {
  const rolled = rollSaveEffect(c, input);
  const outcomes = applySaveEffect(c, rolled.saves, {
    ...(input.dc !== undefined ? { dc: input.dc } : {}),
    ...(rolled.damageRoll !== undefined ? { damage: rolled.damageRoll.total } : {}),
    ...(input.damageType !== undefined ? { damageType: input.damageType } : {}),
    ...(input.onSave !== undefined ? { onSave: input.onSave } : {}),
    ...(input.onFail !== undefined ? { onFail: input.onFail } : {}),
    roller: input.roller,
  });
  return rolled.damageRoll === undefined ? { outcomes } : { damageRoll: rolled.damageRoll, outcomes };
}
