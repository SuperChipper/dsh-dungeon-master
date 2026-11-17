/**
 * 声明式效果与扩展规则注册表（供内置 5e 特性/法术与 dnd_rule 热注册扩展共用）。
 *
 * 设计原则：
 * - 角色在 traits（常驻被动）或 activeStates/conditions（限时状态）中拥有同名条目时自动触发对应钩子；
 * - 支持 campaign 级（仅当前团档生效，如个人专武、本桌房规）与 global 级（dnd/custom-effects.json 跨团复用，如魔兽 5e 职业扩展）；
 * - 纯数据结构 + 安全公式求值（formula.ts），无需 eval、无需改源码重启，主 DM 与战斗子代理共享同一确定性引擎。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { rollExpression } from './dice.ts';
import { validateFormula } from './formula.ts';
import { ABILITIES, parseAbility, type Ability } from './rules.ts';

export interface AttackModHook {
  /** 命中加值公式，如 "cha_mod"、"prof"、"2" */
  toHitFormula?: string;
  /** 额外命中骰表达式，如 "1d4" */
  bonusDice?: string;
  advantage?: 'advantage' | 'disadvantage';
  /** 扩展重击阈值（18-20），如 19 表示 19-20 重击 */
  critOn?: number;
  weaponOnly?: boolean;
  meleeOnly?: boolean;
  rangedOnly?: boolean;
}

export interface HitRiderHook {
  /** 额外伤害骰表达式，如 "1d6"、"2d8"（重击时自动翻倍骰数） */
  damageDice?: string;
  /** 额外固定加值公式，如 "prof"、"cha_mod"（重击不翻倍常数） */
  bonusFormula?: string;
  /** 伤害类型，如 "黯蚀"、"光耀"、"闪电"；填 "武器同型" 则继承主伤害类型 */
  damageType: string;
  /** 为 true 时，仅当该状态挂在受击目标身上且 state.source === 攻击者（或攻击者自身状态锁定 target === 受击者）时触发（如脆弱诅咒、猎人印记） */
  markedTargetOnly?: boolean;
  weaponOnly?: boolean;
  meleeOnly?: boolean;
  strAttackOnly?: boolean;
  /** 仅在本次攻击具有优势时触发（如重锻太刀「段云」优势命中 +1d6 雷鸣） */
  advantageOnly?: boolean;
  /** 每回合至多触发 1 次（如巨像屠夫、神圣打击） */
  oncePerTurn?: boolean;
}

export interface DefenseModHook {
  /** AC 加值（整数或公式字符串，如 2 或 "max(1, cha_mod)"） */
  acBonus?: number | string;
  /** 获得抗性的伤害类型列表，如 ["毒素", "黯蚀"]；填 ["*"] 表示全伤害抗性 */
  resistant?: string[];
  /** 获得免疫的伤害类型列表 */
  immune?: string[];
  /** 获得易伤的伤害类型列表 */
  vulnerable?: string[];
  /** 攻击者对该目标攻击时的优劣势 */
  attackerAdvantage?: 'advantage' | 'disadvantage';
}

export interface SaveModHook {
  /** 适用的豁免属性列表（如 ["str", "con"]），或 "all" 表示全部六维豁免 */
  abilities?: Ability[] | 'all';
  /** 豁免固定加值公式，如 "max(1, cha_mod)" */
  bonusFormula?: string;
  /** 豁免额外骰，如 "1d4" */
  bonusDice?: string;
  advantage?: 'advantage' | 'disadvantage';
  /** 仅在对抗匹配标签时生效（如 ["concentration", "毒素", "黯蚀"]）；不填则无条件生效 */
  vsTags?: string[];
}

export interface AuraHazardSpec {
  /** 基础伤害骰，如 "3d8" */
  damageDice: string;
  /** 升环每高 1 环增加的骰子，如 "1d8" */
  upcastPerSlot?: string;
  /** 法术基础环阶，如灵体卫士为 3 */
  baseSlot?: number;
  damageType: string;
  saveAbility: Ability;
  /** 豁免成功是否减半（默认 true；false 则豁免成功无伤） */
  halfOnSave?: boolean;
}

export interface AuraHook {
  /** 光环半径（尺），如 10 或 15 */
  radius: number;
  /** 18 级起扩展半径（尺），如圣武士守护灵光 30 */
  radiusAt18?: number;
  target: 'allies' | 'enemies' | 'all';
  /** 对友军生效时是否包含光环持有者自身（默认 true） */
  includeSelf?: boolean;
  /** 为范围内目标提供的豁免加值公式（同名字取最高，不叠加以符合 5e 同名效应不叠加原则） */
  saveBonusFormula?: string;
  /** 范围内目标的速度倍率（如 0.5 表示灵体卫士敌方速度减半） */
  slowFactor?: number;
  /** 持续危害光环：目标在光环内开始回合，或本轮首次进入/被扫入光环时触发豁免伤害 */
  hazard?: AuraHazardSpec;
}

export interface HealModHook {
  /** 施放 1 环及以上治疗法术时额外恢复值公式，如生命门徒 "2 + slot_level" */
  bonusFormula?: string;
  /** 对他人施放 1 环及以上治疗法术时施法者自身恢复公式，如神佑医者 "2 + slot_level" */
  selfHealOnOtherFormula?: string;
  /** 治疗池总量公式（如保全生命 "5 * level"） */
  poolFormula?: string;
  /** 是否限制受术者最高恢复至有效生命上限的一半（保全生命规则） */
  capAtHalfMaxHp?: boolean;
}

export interface CustomEffectDef {
  name: string;
  aliases?: string[];
  description?: string;
  concentration?: boolean;
  defaultRounds?: number;
  attackMod?: AttackModHook;
  hitRider?: HitRiderHook;
  defenseMod?: DefenseModHook;
  saveMod?: SaveModHook;
  aura?: AuraHook;
  healMod?: HealModHook;
}

export const BUILTIN_EFFECTS: Readonly<Record<string, CustomEffectDef>> = {
  脆弱诅咒: {
    name: '脆弱诅咒',
    aliases: ['hex', '邪咒', '诅咒术'],
    description: '附赠动作专注法术：施法者每次攻击命中受诅咒目标额外造成 1d6 黯蚀伤害。',
    concentration: true,
    defaultRounds: 10,
    hitRider: { damageDice: '1d6', damageType: '黯蚀', markedTargetOnly: true },
  },
  猎人印记: {
    name: '猎人印记',
    aliases: ["hunter's mark", 'hunters mark', '猎手印记'],
    description: '附赠动作专注法术：施法者每次武器攻击命中受印记目标额外造成 1d6 武器同型伤害。',
    concentration: true,
    defaultRounds: 10,
    hitRider: { damageDice: '1d6', damageType: '武器同型', markedTargetOnly: true, weaponOnly: true },
  },
  神恩: {
    name: '神恩',
    aliases: ['divine favor', '神恩术'],
    description: '附赠动作专注法术：武器攻击命中额外造成 1d4 光耀伤害。',
    concentration: true,
    defaultRounds: 10,
    hitRider: { damageDice: '1d4', damageType: '光耀', weaponOnly: true },
  },
  变巨术: {
    name: '变巨术',
    aliases: ['enlarge', 'enlarge/reduce', '变巨', '成长药水', '变巨缩小术'],
    description: '力量检定与力量豁免优势，武器攻击命中额外造成 1d4 伤害。',
    concentration: true,
    defaultRounds: 10,
    hitRider: { damageDice: '1d4', damageType: '武器同型', weaponOnly: true },
    saveMod: { abilities: ['str'], advantage: 'advantage' },
  },
  防护毒素: {
    name: '防护毒素',
    aliases: ['protection from poison', '防毒术'],
    description: '非专注法术（1小时）：具有毒素伤害抗性，且对抗毒素与中毒的豁免具有优势。',
    concentration: false,
    defenseMod: { resistant: ['毒素'] },
    saveMod: { advantage: 'advantage', vsTags: ['毒素', '中毒', 'poison'] },
  },
  守护灵光: {
    name: '守护灵光',
    aliases: ['aura of protection', '保护灵光', '守护光环'],
    description: '圣武士 6 级特性：自身未失能时，10 尺内（18 级起 30 尺）自己与友军所有豁免检定自动加 max(1, 魅力调整值)。',
    aura: {
      radius: 10,
      radiusAt18: 30,
      target: 'allies',
      includeSelf: true,
      saveBonusFormula: 'max(1, cha_mod)',
    },
  },
  灵体卫士: {
    name: '灵体卫士',
    aliases: ['spirit guardians', '灵体守卫', '魂灵环绕', '圣灵守护'],
    description: '3 环专注光环（15 尺）：范围内敌方速度减半；敌方首次进入/被光环扫过或在其中开始回合时须过感知豁免，失败受 3d8（每升1环+1d8）光耀/黯蚀伤害，成功减半。',
    concentration: true,
    defaultRounds: 10,
    aura: {
      radius: 15,
      target: 'enemies',
      slowFactor: 0.5,
      hazard: {
        damageDice: '3d8',
        upcastPerSlot: '1d8',
        baseSlot: 3,
        damageType: '光耀',
        saveAbility: 'wis',
        halfOnSave: true,
      },
    },
  },
  生命门徒: {
    name: '生命门徒',
    aliases: ['disciple of life', '生命信徒'],
    description: '生命领域 1 级特性：使用 1 环及以上法术恢复生命值时，受术者额外恢复 2 + 法术环阶 HP。',
    healMod: { bonusFormula: '2 + slot_level' },
  },
  神佑医者: {
    name: '神佑医者',
    aliases: ['blessed healer', '受祝医者'],
    description: '生命领域 6 级特性：对自身以外生物施放 1 环及以上治疗法术时，自身同步恢复 2 + 法术环阶 HP。',
    healMod: { selfHealOnOtherFormula: '2 + slot_level' },
  },
  保全生命: {
    name: '保全生命',
    aliases: ['preserve life', '保留生命'],
    description: '生命领域引导神力：动作分配 5×牧师等级 点治疗池给 30 尺内生物，最多恢复至其有效生命上限的一半。',
    healMod: { poolFormula: '5 * level', capAtHalfMaxHp: true },
  },
};

function checkDice(expr: string | undefined, label: string): void {
  if (expr === undefined) return;
  if (expr.trim().length === 0) throw new Error(`${label} 不能为空字符串`);
  rollExpression(expr, () => 1);
}

function checkFormula(expr: string | undefined, label: string): void {
  if (expr === undefined) return;
  try {
    validateFormula(expr);
  } catch (err) {
    throw new Error(`${label} 公式不合法：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 校验并规整模型或文件传入的自定义规则定义 */
export function parseCustomEffectDef(raw: unknown): CustomEffectDef {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('规则定义必须是对象');
  }
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (name.length === 0) throw new Error('规则 name 不能为空');
  const aliases = Array.isArray(o.aliases)
    ? o.aliases.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
    : undefined;
  const description = typeof o.description === 'string' && o.description.trim().length > 0 ? o.description.trim() : undefined;
  const concentration = typeof o.concentration === 'boolean' ? o.concentration : undefined;
  const defaultRounds = typeof o.defaultRounds === 'number' && Number.isInteger(o.defaultRounds) && o.defaultRounds > 0
    ? o.defaultRounds
    : (typeof o.default_rounds === 'number' && Number.isInteger(o.default_rounds) && o.default_rounds > 0 ? o.default_rounds : undefined);

  const def: CustomEffectDef = {
    name,
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(concentration !== undefined ? { concentration } : {}),
    ...(defaultRounds !== undefined ? { defaultRounds } : {}),
  };

  const rawAtk = (o.attackMod ?? o.attack_mod) as Record<string, unknown> | undefined;
  if (rawAtk !== undefined && rawAtk !== null && typeof rawAtk === 'object') {
    const toHitFormula = typeof (rawAtk.toHitFormula ?? rawAtk.to_hit_formula) === 'string'
      ? String(rawAtk.toHitFormula ?? rawAtk.to_hit_formula).trim()
      : undefined;
    const bonusDice = typeof (rawAtk.bonusDice ?? rawAtk.bonus_dice) === 'string'
      ? String(rawAtk.bonusDice ?? rawAtk.bonus_dice).trim()
      : undefined;
    checkFormula(toHitFormula, 'attack_mod.to_hit_formula');
    checkDice(bonusDice, 'attack_mod.bonus_dice');
    const advantage = rawAtk.advantage === 'advantage' || rawAtk.advantage === 'disadvantage' ? rawAtk.advantage : undefined;
    const critRaw = rawAtk.critOn ?? rawAtk.crit_on;
    const critOn = typeof critRaw === 'number' && Number.isInteger(critRaw) && critRaw >= 18 && critRaw <= 20 ? critRaw : undefined;
    def.attackMod = {
      ...(toHitFormula ? { toHitFormula } : {}),
      ...(bonusDice ? { bonusDice } : {}),
      ...(advantage ? { advantage } : {}),
      ...(critOn !== undefined ? { critOn } : {}),
      ...((rawAtk.weaponOnly ?? rawAtk.weapon_only) === true ? { weaponOnly: true } : {}),
      ...((rawAtk.meleeOnly ?? rawAtk.melee_only) === true ? { meleeOnly: true } : {}),
      ...((rawAtk.rangedOnly ?? rawAtk.ranged_only) === true ? { rangedOnly: true } : {}),
    };
  }

  const rawRider = (o.hitRider ?? o.hit_rider) as Record<string, unknown> | undefined;
  if (rawRider !== undefined && rawRider !== null && typeof rawRider === 'object') {
    const damageDice = typeof (rawRider.damageDice ?? rawRider.damage_dice) === 'string'
      ? String(rawRider.damageDice ?? rawRider.damage_dice).trim()
      : undefined;
    const bonusFormula = typeof (rawRider.bonusFormula ?? rawRider.bonus_formula) === 'string'
      ? String(rawRider.bonusFormula ?? rawRider.bonus_formula).trim()
      : undefined;
    const damageType = typeof (rawRider.damageType ?? rawRider.damage_type) === 'string'
      ? String(rawRider.damageType ?? rawRider.damage_type).trim()
      : '';
    if (!damageDice && !bonusFormula) throw new Error('hit_rider 至少需要 damage_dice 或 bonus_formula 之一');
    if (!damageType) throw new Error('hit_rider 需要 damage_type（如 "闪电"、"光耀" 或 "武器同型"）');
    checkDice(damageDice, 'hit_rider.damage_dice');
    checkFormula(bonusFormula, 'hit_rider.bonus_formula');
    def.hitRider = {
      ...(damageDice ? { damageDice } : {}),
      ...(bonusFormula ? { bonusFormula } : {}),
      damageType,
      ...((rawRider.markedTargetOnly ?? rawRider.marked_target_only) === true ? { markedTargetOnly: true } : {}),
      ...((rawRider.weaponOnly ?? rawRider.weapon_only) === true ? { weaponOnly: true } : {}),
      ...((rawRider.meleeOnly ?? rawRider.melee_only) === true ? { meleeOnly: true } : {}),
      ...((rawRider.strAttackOnly ?? rawRider.str_attack_only) === true ? { strAttackOnly: true } : {}),
      ...((rawRider.advantageOnly ?? rawRider.advantage_only) === true ? { advantageOnly: true } : {}),
      ...((rawRider.oncePerTurn ?? rawRider.once_per_turn) === true ? { oncePerTurn: true } : {}),
    };
  }

  const rawDef = (o.defenseMod ?? o.defense_mod) as Record<string, unknown> | undefined;
  if (rawDef !== undefined && rawDef !== null && typeof rawDef === 'object') {
    const acRaw = rawDef.acBonus ?? rawDef.ac_bonus;
    let acBonus: number | string | undefined;
    if (typeof acRaw === 'number' && Number.isFinite(acRaw)) acBonus = Math.trunc(acRaw);
    else if (typeof acRaw === 'string' && acRaw.trim().length > 0) {
      acBonus = acRaw.trim();
      checkFormula(acBonus, 'defense_mod.ac_bonus');
    }
    const strArr = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const list = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
      return list.length > 0 ? list : undefined;
    };
    const resistant = strArr(rawDef.resistant);
    const immune = strArr(rawDef.immune);
    const vulnerable = strArr(rawDef.vulnerable);
    const advRaw = rawDef.attackerAdvantage ?? rawDef.attacker_advantage;
    const attackerAdvantage = advRaw === 'advantage' || advRaw === 'disadvantage' ? advRaw : undefined;
    def.defenseMod = {
      ...(acBonus !== undefined ? { acBonus } : {}),
      ...(resistant ? { resistant } : {}),
      ...(immune ? { immune } : {}),
      ...(vulnerable ? { vulnerable } : {}),
      ...(attackerAdvantage ? { attackerAdvantage } : {}),
    };
  }

  const rawSave = (o.saveMod ?? o.save_mod) as Record<string, unknown> | undefined;
  if (rawSave !== undefined && rawSave !== null && typeof rawSave === 'object') {
    let abilities: Ability[] | 'all' | undefined;
    if (rawSave.abilities === 'all') abilities = 'all';
    else if (Array.isArray(rawSave.abilities)) {
      const parsed = rawSave.abilities.map((x) => parseAbility(String(x)));
      if (parsed.some((x) => x === undefined)) {
        throw new Error(`save_mod.abilities 含未知属性；可用：${ABILITIES.join(', ')} 或 "all"`);
      }
      abilities = parsed as Ability[];
    }
    const bonusFormula = typeof (rawSave.bonusFormula ?? rawSave.bonus_formula) === 'string'
      ? String(rawSave.bonusFormula ?? rawSave.bonus_formula).trim()
      : undefined;
    const bonusDice = typeof (rawSave.bonusDice ?? rawSave.bonus_dice) === 'string'
      ? String(rawSave.bonusDice ?? rawSave.bonus_dice).trim()
      : undefined;
    checkFormula(bonusFormula, 'save_mod.bonus_formula');
    checkDice(bonusDice, 'save_mod.bonus_dice');
    const advantage = rawSave.advantage === 'advantage' || rawSave.advantage === 'disadvantage' ? rawSave.advantage : undefined;
    const vsRaw = rawSave.vsTags ?? rawSave.vs_tags;
    const vsTags = Array.isArray(vsRaw)
      ? vsRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
      : undefined;
    def.saveMod = {
      ...(abilities !== undefined ? { abilities } : {}),
      ...(bonusFormula ? { bonusFormula } : {}),
      ...(bonusDice ? { bonusDice } : {}),
      ...(advantage ? { advantage } : {}),
      ...(vsTags && vsTags.length > 0 ? { vsTags } : {}),
    };
  }

  const rawAura = o.aura as Record<string, unknown> | undefined;
  if (rawAura !== undefined && rawAura !== null && typeof rawAura === 'object') {
    const radius = typeof rawAura.radius === 'number' && Number.isInteger(rawAura.radius) && rawAura.radius >= 5
      ? rawAura.radius
      : undefined;
    if (radius === undefined) throw new Error('aura.radius 必须是不小于 5 的整数尺数');
    const r18Raw = rawAura.radiusAt18 ?? rawAura.radius_at_18;
    const radiusAt18 = typeof r18Raw === 'number' && Number.isInteger(r18Raw) && r18Raw >= radius ? r18Raw : undefined;
    const target = rawAura.target === 'allies' || rawAura.target === 'enemies' || rawAura.target === 'all' ? rawAura.target : 'allies';
    const saveBonusFormula = typeof (rawAura.saveBonusFormula ?? rawAura.save_bonus_formula) === 'string'
      ? String(rawAura.saveBonusFormula ?? rawAura.save_bonus_formula).trim()
      : undefined;
    checkFormula(saveBonusFormula, 'aura.save_bonus_formula');
    const slowRaw = rawAura.slowFactor ?? rawAura.slow_factor;
    const slowFactor = typeof slowRaw === 'number' && slowRaw > 0 && slowRaw < 1 ? slowRaw : undefined;
    let hazard: AuraHazardSpec | undefined;
    const rawHaz = rawAura.hazard as Record<string, unknown> | undefined;
    if (rawHaz !== undefined && rawHaz !== null && typeof rawHaz === 'object') {
      const damageDice = String(rawHaz.damageDice ?? rawHaz.damage_dice ?? '').trim();
      const damageType = String(rawHaz.damageType ?? rawHaz.damage_type ?? '').trim();
      const saveAb = parseAbility(String(rawHaz.saveAbility ?? rawHaz.save_ability ?? ''));
      if (!damageDice || !damageType || saveAb === undefined) {
        throw new Error('aura.hazard 需要 damage_dice、damage_type 与合法的 save_ability');
      }
      checkDice(damageDice, 'aura.hazard.damage_dice');
      const upcastPerSlot = typeof (rawHaz.upcastPerSlot ?? rawHaz.upcast_per_slot) === 'string'
        ? String(rawHaz.upcastPerSlot ?? rawHaz.upcast_per_slot).trim()
        : undefined;
      checkDice(upcastPerSlot, 'aura.hazard.upcast_per_slot');
      const baseSlotRaw = rawHaz.baseSlot ?? rawHaz.base_slot;
      const baseSlot = typeof baseSlotRaw === 'number' && Number.isInteger(baseSlotRaw) && baseSlotRaw >= 1 ? baseSlotRaw : undefined;
      hazard = {
        damageDice,
        damageType,
        saveAbility: saveAb,
        ...(upcastPerSlot ? { upcastPerSlot } : {}),
        ...(baseSlot !== undefined ? { baseSlot } : {}),
        ...((rawHaz.halfOnSave ?? rawHaz.half_on_save) === false ? { halfOnSave: false } : { halfOnSave: true }),
      };
    }
    def.aura = {
      radius,
      ...(radiusAt18 !== undefined ? { radiusAt18 } : {}),
      target,
      ...((rawAura.includeSelf ?? rawAura.include_self) === false ? { includeSelf: false } : {}),
      ...(saveBonusFormula ? { saveBonusFormula } : {}),
      ...(slowFactor !== undefined ? { slowFactor } : {}),
      ...(hazard !== undefined ? { hazard } : {}),
    };
  }

  const rawHeal = (o.healMod ?? o.heal_mod) as Record<string, unknown> | undefined;
  if (rawHeal !== undefined && rawHeal !== null && typeof rawHeal === 'object') {
    const bonusFormula = typeof (rawHeal.bonusFormula ?? rawHeal.bonus_formula) === 'string'
      ? String(rawHeal.bonusFormula ?? rawHeal.bonus_formula).trim()
      : undefined;
    const selfHeal = typeof (rawHeal.selfHealOnOtherFormula ?? rawHeal.self_heal_on_other_formula) === 'string'
      ? String(rawHeal.selfHealOnOtherFormula ?? rawHeal.self_heal_on_other_formula).trim()
      : undefined;
    const poolFormula = typeof (rawHeal.poolFormula ?? rawHeal.pool_formula) === 'string'
      ? String(rawHeal.poolFormula ?? rawHeal.pool_formula).trim()
      : undefined;
    checkFormula(bonusFormula, 'heal_mod.bonus_formula');
    checkFormula(selfHeal, 'heal_mod.self_heal_on_other_formula');
    checkFormula(poolFormula, 'heal_mod.pool_formula');
    def.healMod = {
      ...(bonusFormula ? { bonusFormula } : {}),
      ...(selfHeal ? { selfHealOnOtherFormula: selfHeal } : {}),
      ...(poolFormula ? { poolFormula } : {}),
      ...((rawHeal.capAtHalfMaxHp ?? rawHeal.cap_at_half_max_hp) === true ? { capAtHalfMaxHp: true } : {}),
    };
  }

  const hasAnyHook = def.attackMod !== undefined || def.hitRider !== undefined || def.defenseMod !== undefined
    || def.saveMod !== undefined || def.aura !== undefined || def.healMod !== undefined;
  if (!hasAnyHook) {
    throw new Error('规则定义至少需要包含一个效果钩子（attack_mod / hit_rider / defense_mod / save_mod / aura / heal_mod）');
  }
  return def;
}

/** 全局跨团规则库（默认保存在 dnd/custom-effects.json） */
export class CustomEffectStore {
  public constructor(public readonly filePath: string) {}

  public loadAll(): Record<string, CustomEffectDef> {
    if (!existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, CustomEffectDef> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        try {
          out[k] = parseCustomEffectDef(v);
        } catch {
          // 跳过被手改坏的单项，不阻塞整场战斗
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  public saveAll(defs: Record<string, CustomEffectDef>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(defs, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  public upsert(def: CustomEffectDef): void {
    const all = this.loadAll();
    all[def.name] = def;
    this.saveAll(all);
  }

  public remove(name: string): boolean {
    const all = this.loadAll();
    const key = Object.keys(all).find((k) => k === name || k.toLowerCase() === name.toLowerCase());
    if (key === undefined) return false;
    delete all[key];
    this.saveAll(all);
    return true;
  }
}

/** 合并内置 + 全局 + 当前团档自定义效果（优先级：campaign > global > builtin） */
export function mergedEffectMap(
  campaignEffects?: Record<string, CustomEffectDef>,
  globalEffects?: Record<string, CustomEffectDef>,
): Map<string, CustomEffectDef> {
  const byKey = new Map<string, CustomEffectDef>();
  const register = (def: CustomEffectDef): void => {
    byKey.set(def.name.toLowerCase(), def);
    for (const alias of def.aliases ?? []) {
      byKey.set(alias.toLowerCase(), def);
    }
  };
  for (const def of Object.values(BUILTIN_EFFECTS)) register(def);
  for (const def of Object.values(globalEffects ?? {})) register(def);
  for (const def of Object.values(campaignEffects ?? {})) register(def);
  return byKey;
}

export function resolveEffectDef(
  rawName: string,
  campaignEffects?: Record<string, CustomEffectDef>,
  globalEffects?: Record<string, CustomEffectDef>,
): CustomEffectDef | undefined {
  const q = rawName.trim().toLowerCase();
  if (!q) return undefined;
  return mergedEffectMap(campaignEffects, globalEffects).get(q);
}

/** 判断伤害类型是否命中抗性/免疫/易伤列表 */
export function matchesDamageType(damageType: string | undefined, list: readonly string[] | undefined): boolean {
  if (!list || list.length === 0) return false;
  if (list.includes('*') || list.includes('全部') || list.includes('all')) return true;
  if (!damageType) return false;
  const dt = damageType.trim().toLowerCase();
  const aliases: Record<string, string[]> = {
    毒素: ['毒素', '毒', 'poison'],
    黯蚀: ['黯蚀', '死灵', 'necrotic'],
    光耀: ['光耀', 'radiant'],
    闪电: ['闪电', '雷电', 'lightning'],
    雷鸣: ['雷鸣', '音波', 'thunder'],
    火焰: ['火焰', '火', 'fire'],
    寒冷: ['寒冷', '冰', '冻', 'cold'],
    强酸: ['强酸', '酸', 'acid'],
    心灵: ['心灵', '精神', 'psychic'],
    力场: ['力场', 'force'],
    钝击: ['钝击', 'bludgeoning'],
    穿刺: ['穿刺', 'piercing'],
    挥砍: ['挥砍', 'slashing'],
    物理: ['钝击', '穿刺', '挥砍', '物理', 'bludgeoning', 'piercing', 'slashing'],
  };
  for (const raw of list) {
    const key = raw.trim();
    const group = aliases[key] ?? [key.toLowerCase()];
    if (group.some((token) => dt.includes(token))) return true;
  }
  return false;
}
