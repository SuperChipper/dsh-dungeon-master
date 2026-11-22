/**
 * 战场持续区域效果（BattleZone）与移动光环结算。
 *
 * 存储于 InitiativeState.zones：
 * - 随先攻轮次自动倒计时（tickOnTurnChange），到期自动移除；
 * - 绑定施法者专注（concentration=true）时，断专注自动同步移除；
 * - 战斗结束（endInitiative 清空 initiative）时 100% 自动清场，绝不污染永久房间场地图；
 * - 在 /dnd status 战斗图、ASCII 示意图与站位行中直观绘制，并与 move / nextTurn 实时联动结算。
 */
import { type BattleCell, type Campaign, type Character, type HpChange, applyDamage, pushCombatLedger } from './campaign.ts';
import { activeEffectDefsFor, computeDefenseStateMod, isIncapacitated } from './conditions.ts';
import type { AuraHazardSpec, CustomEffectDef } from './custom-effects.ts';
import { type Roller, rollExpression } from './dice.ts';
import { ABILITY_NAMES, abilityModifier, parseAbility, proficiencyBonus, type Ability } from './rules.ts';
import { DEFENSE_NAMES, resolveSaveEffect, saveDamage } from './save-effect.ts';

export type ZoneTheme = 'darkness' | 'poison' | 'fire' | 'radiant' | 'frost' | 'fog' | 'nature';
export type ZoneTrigger = 'enter' | 'turn_start' | 'turn_end';

export interface BattleZone {
  id: string;
  name: string;
  room: string;
  shape: 'sphere' | 'rect';
  /** sphere：球心格坐标；rect：西北角格坐标 */
  x: number;
  y: number;
  /** sphere 半径（尺，5 的倍数） */
  radius?: number;
  /** rect 宽高（格数） */
  w?: number;
  h?: number;
  /** 区域垂直高度（尺，默认球体取 radius、矩形取 20；离地高度 z 超过 height 的飞行单位不受影响） */
  height?: number;
  /** 施法者或来源名称 */
  source?: string;
  /** 是否依赖 source 专注维持 */
  concentration?: boolean;
  /** 剩余持续轮数；到 0 自动移除 */
  roundsLeft?: number;
  expires?: 'start_of_source_turn' | 'end_of_source_turn';
  /** 视线遮蔽：light=轻度遮蔽，heavy=重度遮蔽（云雾术），darkness=魔法黑暗（黑暗术） */
  obscured?: 'light' | 'heavy' | 'darkness';
  /** 是否视为难行地形（双倍移动消耗） */
  difficult?: boolean;
  /** 触发伤害骰表达式，如 "2d6"、"4d4" */
  damage?: string;
  damageType?: string;
  saveAbility?: Ability;
  saveDc?: number;
  onSave?: 'half' | 'none';
  onFailConditions?: string[];
  /** 触发时机（带伤害或失败状态时默认 ['enter', 'turn_start']） */
  triggers?: ZoneTrigger[];
  /** 是否每在区域内移动 5 尺就触发一次伤害（如荆棘丛生 2d4/5尺） */
  perStep?: boolean;
  /** 仅影响敌方/友方/全体（默认 'all'；法术区通常无差别生效） */
  targetSide?: 'all' | 'enemies' | 'allies';
  theme?: ZoneTheme;
}

interface ZonePreset {
  shape?: 'sphere' | 'rect';
  radius?: number;
  w?: number;
  h?: number;
  height?: number;
  concentration?: boolean;
  roundsLeft?: number;
  obscured?: 'light' | 'heavy' | 'darkness';
  difficult?: boolean;
  damage?: string;
  damageType?: string;
  saveAbility?: Ability;
  onSave?: 'half' | 'none';
  onFailConditions?: string[];
  triggers?: ZoneTrigger[];
  perStep?: boolean;
  theme: ZoneTheme;
}

const PRESET_DARKNESS: ZonePreset = { shape: 'sphere', radius: 15, height: 15, concentration: true, roundsLeft: 100, obscured: 'darkness', theme: 'darkness' };
const PRESET_FOG_CLOUD: ZonePreset = { shape: 'sphere', radius: 20, height: 20, concentration: true, roundsLeft: 600, obscured: 'heavy', theme: 'fog' };
const PRESET_CLOUDKILL: ZonePreset = { shape: 'sphere', radius: 20, height: 20, concentration: true, roundsLeft: 100, obscured: 'heavy', damage: '5d8', damageType: '毒素', saveAbility: 'con', onSave: 'half', triggers: ['enter', 'turn_start'], theme: 'poison' };
const PRESET_STINKING_CLOUD: ZonePreset = { shape: 'sphere', radius: 20, height: 20, concentration: true, roundsLeft: 10, obscured: 'heavy', saveAbility: 'con', onFailConditions: ['失能'], triggers: ['turn_start'], theme: 'poison' };
const PRESET_WEB: ZonePreset = { shape: 'rect', w: 4, h: 4, height: 20, concentration: true, roundsLeft: 600, obscured: 'light', difficult: true, saveAbility: 'dex', onFailConditions: ['束缚'], triggers: ['enter', 'turn_start'], theme: 'nature' };
const PRESET_CLOUD_OF_DAGGERS: ZonePreset = { shape: 'rect', w: 1, h: 1, height: 5, concentration: true, roundsLeft: 10, damage: '4d4', damageType: '挥砍', triggers: ['enter', 'turn_start'], theme: 'radiant' };
const PRESET_MOONBEAM: ZonePreset = { shape: 'sphere', radius: 5, height: 40, concentration: true, roundsLeft: 10, damage: '2d10', damageType: '光耀', saveAbility: 'con', onSave: 'half', triggers: ['enter', 'turn_start'], theme: 'radiant' };
const PRESET_SPIKE_GROWTH: ZonePreset = { shape: 'sphere', radius: 20, height: 5, concentration: true, roundsLeft: 100, difficult: true, damage: '2d4', damageType: '穿刺', triggers: ['enter'], perStep: true, theme: 'nature' };
const PRESET_WALL_OF_FIRE: ZonePreset = { shape: 'rect', w: 12, h: 1, height: 20, concentration: true, roundsLeft: 10, obscured: 'heavy', damage: '5d8', damageType: '火焰', saveAbility: 'dex', onSave: 'half', triggers: ['enter', 'turn_end'], theme: 'fire' };
const PRESET_SILENCE: ZonePreset = { shape: 'sphere', radius: 20, height: 20, concentration: true, roundsLeft: 100, onFailConditions: ['耳聋'], triggers: ['enter', 'turn_start'], theme: 'fog' };
const PRESET_ENTANGLE: ZonePreset = { shape: 'rect', w: 4, h: 4, height: 5, concentration: true, roundsLeft: 10, difficult: true, theme: 'nature' };
const PRESET_SLEET_STORM: ZonePreset = { shape: 'sphere', radius: 40, height: 20, concentration: true, roundsLeft: 10, obscured: 'heavy', difficult: true, saveAbility: 'dex', onFailConditions: ['倒地'], triggers: ['enter', 'turn_start'], theme: 'frost' };
const PRESET_HUNGER_OF_HADAR: ZonePreset = { shape: 'sphere', radius: 20, height: 20, concentration: true, roundsLeft: 10, obscured: 'darkness', difficult: true, damage: '2d6', damageType: '寒冷', triggers: ['turn_start'], theme: 'darkness' };

const ZONE_PRESETS: Record<string, ZonePreset> = {
  黑暗术: PRESET_DARKNESS,
  darkness: PRESET_DARKNESS,
  云雾术: PRESET_FOG_CLOUD,
  'fog cloud': PRESET_FOG_CLOUD,
  毒雾: { shape: 'sphere', radius: 20, height: 20, roundsLeft: 10, obscured: 'heavy', damageType: '毒素', saveAbility: 'con', onSave: 'half', triggers: ['enter', 'turn_start'], theme: 'poison' },
  死云术: PRESET_CLOUDKILL,
  cloudkill: PRESET_CLOUDKILL,
  臭云术: PRESET_STINKING_CLOUD,
  'stinking cloud': PRESET_STINKING_CLOUD,
  蛛网术: PRESET_WEB,
  web: PRESET_WEB,
  匕首之云: PRESET_CLOUD_OF_DAGGERS,
  匕首云: PRESET_CLOUD_OF_DAGGERS,
  'cloud of daggers': PRESET_CLOUD_OF_DAGGERS,
  月华之光: PRESET_MOONBEAM,
  月光束: PRESET_MOONBEAM,
  moonbeam: PRESET_MOONBEAM,
  荆棘丛生: PRESET_SPIKE_GROWTH,
  尖刺丛生: PRESET_SPIKE_GROWTH,
  荆棘生长: PRESET_SPIKE_GROWTH,
  'spike growth': PRESET_SPIKE_GROWTH,
  火墙术: PRESET_WALL_OF_FIRE,
  火墙: PRESET_WALL_OF_FIRE,
  'wall of fire': PRESET_WALL_OF_FIRE,
  沉默术: PRESET_SILENCE,
  silence: PRESET_SILENCE,
  纠缠术: PRESET_ENTANGLE,
  entangle: PRESET_ENTANGLE,
  雪雨暴: PRESET_SLEET_STORM,
  雨夹雪: PRESET_SLEET_STORM,
  雨雪暴: PRESET_SLEET_STORM,
  'sleet storm': PRESET_SLEET_STORM,
  哈达之饥渴: PRESET_HUNGER_OF_HADAR,
  哈达饥渴: PRESET_HUNGER_OF_HADAR,
  'hunger of hadar': PRESET_HUNGER_OF_HADAR,
};

export function inferZoneTheme(name: string, damageType?: string, obscured?: BattleZone['obscured']): ZoneTheme {
  if (obscured === 'darkness' || /黑暗|暗影|深渊|darkness|hunger of hadar/i.test(name)) return 'darkness';
  if (/毒|酸|孢子|死云|臭云|poison|acid/i.test(`${name} ${damageType ?? ''}`)) return 'poison';
  if (/火|熔岩|烈焰|焚|fire/i.test(`${name} ${damageType ?? ''}`)) return 'fire';
  if (/光耀|月华|圣|阳炎|匕首之云|radiant/i.test(`${name} ${damageType ?? ''}`)) return 'radiant';
  if (/冰|寒|霜|雪|cold|frost/i.test(`${name} ${damageType ?? ''}`)) return 'frost';
  if (/蛛网|荆棘|藤蔓|植物|纠缠|泥|web|spike|entangle/i.test(name)) return 'nature';
  return 'fog';
}

export function zoneCoversCell(zone: BattleZone, cell: { x: number; y: number; z?: number; room?: string }): boolean {
  if (cell.room !== undefined && cell.room !== zone.room) return false;
  const maxZ = zone.height ?? zone.radius ?? 20;
  if ((cell.z ?? 0) > maxZ) return false;
  if (zone.shape === 'sphere') {
    const r = zone.radius ?? 15;
    return Math.max(Math.abs(cell.x - zone.x), Math.abs(cell.y - zone.y)) * 5 <= r;
  }
  const w = zone.w ?? 1;
  const h = zone.h ?? 1;
  return cell.x >= zone.x && cell.x < zone.x + w && cell.y >= zone.y && cell.y < zone.y + h;
}

export function zonesInRoom(c: Campaign | undefined, room: string): BattleZone[] {
  return (c?.initiative?.zones ?? []).filter((z) => z.room === room);
}

export function zonesAtCell(c: Campaign | undefined, room: string, cell: { x: number; y: number; z?: number }): BattleZone[] {
  return zonesInRoom(c, room).filter((z) => zoneCoversCell(z, { ...cell, room }));
}

export function zoneAffectsCharacter(c: Campaign, zone: BattleZone, ch: Character): boolean {
  const side = zone.targetSide ?? 'all';
  if (side === 'all') return true;
  const src = zone.source === undefined ? undefined : c.characters.find((x) => x.name === zone.source);
  const srcIsMonster = src ? src.kind === 'monster' : false;
  const chIsMonster = ch.kind === 'monster';
  const hostile = src !== undefined ? srcIsMonster !== chIsMonster : chIsMonster;
  return side === 'enemies' ? hostile : !hostile;
}

export type BattleZoneInput = Omit<Parameters<typeof createBattleZoneInput>[0], 'room'> & { room?: string };

export function createBattleZoneInput(
  raw: {
    id?: string;
    name: string;
    room: string;
    shape?: 'sphere' | 'rect';
    x: number;
    y: number;
    radius?: number;
    w?: number;
    h?: number;
    height?: number;
    source?: string;
    concentration?: boolean;
    rounds?: number;
    expires?: 'start_of_source_turn' | 'end_of_source_turn';
    obscured?: 'light' | 'heavy' | 'darkness';
    difficult?: boolean;
    damage?: string;
    damageType?: string;
    saveAbility?: string;
    saveDc?: number;
    onSave?: 'half' | 'none';
    onFailConditions?: string[];
    triggers?: ZoneTrigger[];
    perStep?: boolean;
    targetSide?: 'all' | 'enemies' | 'allies';
  },
  seqHint = 1,
): BattleZone {
  const name = raw.name.trim();
  if (!name) throw new Error('zone 的 name 不能为空');
  const preset = ZONE_PRESETS[name] ?? ZONE_PRESETS[name.toLowerCase()];
  const shape = raw.shape ?? (raw.w !== undefined || raw.h !== undefined ? 'rect' : (preset?.shape ?? 'sphere'));
  const radius = shape === 'sphere' ? (raw.radius ?? preset?.radius ?? 15) : undefined;
  if (radius !== undefined && (radius < 5 || radius % 5 !== 0)) {
    throw new Error('sphere 区域的 radius 必须是 5 的正整数倍（尺），如 5 / 10 / 15 / 20');
  }
  const w = shape === 'rect' ? Math.max(1, Math.trunc(raw.w ?? preset?.w ?? 2)) : undefined;
  const h = shape === 'rect' ? Math.max(1, Math.trunc(raw.h ?? preset?.h ?? 2)) : undefined;
  const height = raw.height ?? preset?.height ?? (radius ?? 20);
  const obscured = raw.obscured ?? preset?.obscured;
  const difficult = raw.difficult ?? preset?.difficult;
  const damage = raw.damage?.trim() || preset?.damage;
  const damageType = raw.damageType?.trim() || preset?.damageType;
  const saveAbility = raw.saveAbility !== undefined ? parseAbility(raw.saveAbility) : preset?.saveAbility;
  if (raw.saveAbility !== undefined && saveAbility === undefined) {
    throw new Error(`未知豁免属性「${raw.saveAbility}」`);
  }
  const onSave = raw.onSave ?? preset?.onSave ?? 'half';
  const onFailConditions = raw.onFailConditions ?? preset?.onFailConditions;
  const hasEffect = Boolean(damage || (onFailConditions && onFailConditions.length > 0));
  const triggers = raw.triggers ?? preset?.triggers ?? (hasEffect ? ['enter', 'turn_start'] : undefined);
  const perStep = raw.perStep ?? preset?.perStep;
  const concentration = raw.concentration ?? preset?.concentration;
  const roundsLeft = raw.rounds ?? preset?.roundsLeft;
  const theme = inferZoneTheme(name, damageType, obscured);
  const id = raw.id?.trim() || `${name}#${seqHint}`;

  return {
    id,
    name,
    room: raw.room,
    shape,
    x: raw.x,
    y: raw.y,
    ...(radius !== undefined ? { radius } : {}),
    ...(w !== undefined ? { w } : {}),
    ...(h !== undefined ? { h } : {}),
    height,
    ...(raw.source ? { source: raw.source } : {}),
    ...(concentration === true ? { concentration: true } : {}),
    ...(roundsLeft !== undefined && roundsLeft > 0 ? { roundsLeft } : {}),
    ...(raw.expires ? { expires: raw.expires } : {}),
    ...(obscured ? { obscured } : {}),
    ...(difficult === true ? { difficult: true } : {}),
    ...(damage ? { damage } : {}),
    ...(damageType ? { damageType } : {}),
    ...(saveAbility ? { saveAbility } : {}),
    ...(raw.saveDc !== undefined ? { saveDc: raw.saveDc } : {}),
    ...(hasEffect ? { onSave } : {}),
    ...(onFailConditions && onFailConditions.length > 0 ? { onFailConditions } : {}),
    ...(triggers && triggers.length > 0 ? { triggers } : {}),
    ...(perStep === true ? { perStep: true } : {}),
    ...(raw.targetSide && raw.targetSide !== 'all' ? { targetSide: raw.targetSide } : {}),
    theme,
  };
}

export function formatZoneSummary(z: BattleZone): string {
  const geom = z.shape === 'sphere'
    ? `(${z.x},${z.y})半径${z.radius ?? 15}尺`
    : `(${z.x}-${z.x + (z.w ?? 1) - 1},${z.y}-${z.y + (z.h ?? 1) - 1})`;
  const tags: string[] = [];
  if (z.obscured === 'darkness') tags.push('魔法黑暗/重度遮蔽');
  else if (z.obscured === 'heavy') tags.push('重度遮蔽');
  else if (z.obscured === 'light') tags.push('轻度遮蔽');
  if (z.difficult) tags.push('难行');
  if (z.damage) {
    const savePart = z.saveAbility && z.saveDc !== undefined ? `DC${z.saveDc}${ABILITY_NAMES[z.saveAbility]}豁免` : '';
    tags.push(`${savePart ? `${savePart}·` : ''}${z.damage}${z.damageType ?? ''}${z.perStep ? '/5尺' : ''}`);
  } else if (z.onFailConditions?.length) {
    const savePart = z.saveAbility && z.saveDc !== undefined ? `DC${z.saveDc}${ABILITY_NAMES[z.saveAbility]}豁免失败` : '';
    tags.push(`${savePart}→${z.onFailConditions.join('+')}`);
  }
  if (z.roundsLeft !== undefined) tags.push(`剩${z.roundsLeft}轮`);
  if (z.concentration && z.source) tags.push(`${z.source}专注`);
  return `${z.name}${geom}${tags.length > 0 ? `[${tags.join('，')}]` : ''}`;
}

/** 给玩家看的区域简述（隐去怪物/陷阱未公开的精确 DC 数字） */
export function formatZonePlayerLegend(z: BattleZone): string {
  const tags: string[] = [];
  if (z.obscured === 'darkness') tags.push('魔法黑暗');
  else if (z.obscured === 'heavy') tags.push('重度遮蔽');
  if (z.difficult) tags.push('难行');
  if (z.damageType) tags.push(`${z.damageType}危险区`);
  else if (z.damage) tags.push('危险区');
  if (z.roundsLeft !== undefined && z.roundsLeft <= 20) tags.push(`剩${z.roundsLeft}轮`);
  return `${z.name}${tags.length > 0 ? `(${tags.join('·')})` : ''}`;
}

export function isCellHeavilyObscured(c: Campaign | undefined, cell: BattleCell | undefined): BattleZone | undefined {
  if (c === undefined || cell === undefined) return undefined;
  return zonesAtCell(c, cell.room, cell).find((z) => z.obscured === 'darkness' || z.obscured === 'heavy');
}

function charRoomOf(c: Campaign, ch: Character): string | undefined {
  return ch.kind === 'monster' ? ch.room : (ch.room ?? c.currentRoom);
}

function cellOfChar(c: Campaign, ch: Character): BattleCell | undefined {
  const pos = c.initiative?.positions?.[ch.name];
  return pos !== undefined && pos.room === charRoomOf(c, ch) ? pos : undefined;
}

function dist3d(a: { x: number; y: number; z?: number }, b: { x: number; y: number; z?: number }): number {
  return Math.max(Math.abs(a.x - b.x) * 5, Math.abs(a.y - b.y) * 5, Math.abs((a.z ?? 0) - (b.z ?? 0)));
}

function isHostilePair(a: Character, b: Character): boolean {
  return (a.kind === 'monster') !== (b.kind === 'monster');
}

export function inferSpellSaveDc(caster: Character): number {
  const cls = caster.className ?? '';
  let mod = Math.max(
    abilityModifier(caster.abilities.int),
    abilityModifier(caster.abilities.wis),
    abilityModifier(caster.abilities.cha),
  );
  if (/牧师|德鲁伊|游侠|cleric|druid|ranger/i.test(cls)) mod = abilityModifier(caster.abilities.wis);
  else if (/法师|奇械师|wizard|artificer/i.test(cls)) mod = abilityModifier(caster.abilities.int);
  else if (/圣武士|吟游诗人|术士|邪术师|paladin|bard|sorcerer|warlock/i.test(cls)) mod = abilityModifier(caster.abilities.cha);
  return 8 + proficiencyBonus(caster.level) + mod;
}

function formatHpBrief(change: HpChange): string {
  const events = change.events.length > 0 ? `（${change.events.join('、')}）` : '';
  if (change.wound !== undefined) return `${change.name} ${change.wound}${events}`;
  return `${change.name} HP ${change.before}→${change.after}/${change.maxHp}${events}`;
}

function buildAuraDamageExpr(hazard: AuraHazardSpec, slotLevel?: number): string {
  if (!hazard.upcastPerSlot || hazard.baseSlot === undefined || slotLevel === undefined || slotLevel <= hazard.baseSlot) {
    return hazard.damageDice;
  }
  const diff = slotLevel - hazard.baseSlot;
  const mBase = /^(\d+)d(\d+)$/i.exec(hazard.damageDice.trim());
  const mUp = /^(\d+)d(\d+)$/i.exec(hazard.upcastPerSlot.trim());
  if (mBase !== null && mUp !== null && mBase[2] === mUp[2]) {
    return `${Number(mBase[1]) + diff * Number(mUp[1])}d${mBase[2]}`;
  }
  return [hazard.damageDice, ...Array.from({ length: diff }, () => hazard.upcastPerSlot!)].join('+');
}

function applyZoneToCharacter(
  c: Campaign,
  zone: BattleZone,
  target: Character,
  timingLabel: string,
  roller: Roller,
  globalEffects?: Record<string, CustomEffectDef>,
  stepMultiplier = 1,
): string | undefined {
  if (target.conditions.includes('死亡') || !zoneAffectsCharacter(c, zone, target)) return undefined;
  const hasDamage = zone.damage !== undefined;
  const hasCond = (zone.onFailConditions?.length ?? 0) > 0;
  if (!hasDamage && !hasCond) return undefined;

  let expr = zone.damage;
  if (expr !== undefined && stepMultiplier > 1) {
    const m = /^(\d+)d(\d+)$/i.exec(expr.trim());
    expr = m !== null ? `${Number(m[1]) * stepMultiplier}d${m[2]}` : Array.from({ length: stepMultiplier }, () => expr!).join('+');
  }

  if (zone.saveAbility !== undefined && zone.saveDc !== undefined) {
    const res = resolveSaveEffect(c, {
      targets: [{ name: target.name }],
      ability: zone.saveAbility,
      dc: zone.saveDc,
      ...(expr !== undefined ? { damage: expr } : {}),
      ...(zone.damageType !== undefined ? { damageType: zone.damageType } : {}),
      onSave: zone.onSave ?? 'half',
      ...(zone.onFailConditions !== undefined ? { onFail: zone.onFailConditions } : {}),
      ...(zone.concentration === true && zone.source !== undefined ? { concentrationSource: zone.source } : {}),
      ...(globalEffects !== undefined ? { globalEffects } : {}),
      roller,
    });
    const o = res.outcomes[0];
    if (o === undefined || o.skipped !== undefined) return undefined;
    const verdict = o.saved ? '成功' : '失败';
    const dmgPart = o.damage !== undefined
      ? `，${o.defense !== undefined ? `${DEFENSE_NAMES[o.defense]} ` : ''}受 ${o.damage}${zone.damageType ? ` ${zone.damageType}` : ''}${o.change ? `（${formatHpBrief(o.change)}）` : ''}`
      : '';
    const condPart = o.conditions?.length ? `，陷入「${o.conditions.join('、')}」` : '';
    const line = `【区域·${zone.name}（${timingLabel}）】${target.name} ${ABILITY_NAMES[zone.saveAbility]}豁免 ${o.detail ?? ''} → ${verdict}${dmgPart}${condPart}`;
    pushCombatLedger(c, line);
    return line;
  }

  if (expr !== undefined) {
    const rolled = rollExpression(expr, roller);
    const defMod = computeDefenseStateMod(target, zone.damageType, undefined, c, globalEffects);
    const finalDmg = saveDamage(rolled.total, false, 'half', defMod.defense);
    const change = finalDmg > 0 ? applyDamage(c, target.name, finalDmg, { damageType: zone.damageType, roller }) : undefined;
    const stepNote = stepMultiplier > 1 ? `（区域内移动 ${stepMultiplier * 5} 尺）` : '';
    const line = `【区域·${zone.name}（${timingLabel}）】${stepNote}${target.name} 受伤害 ${rolled.detail}${defMod.defense !== undefined ? `（${DEFENSE_NAMES[defMod.defense]}→${finalDmg}）` : ''} ${zone.damageType ?? ''}${change ? `；${formatHpBrief(change)}` : ''}`;
    pushCombatLedger(c, line);
    return line;
  }
  return undefined;
}

function applyHazardAuraToCharacter(
  c: Campaign,
  caster: Character,
  auraName: string,
  hazard: AuraHazardSpec,
  slotLevel: number | undefined,
  saveDc: number | undefined,
  target: Character,
  timingLabel: string,
  roller: Roller,
  globalEffects?: Record<string, CustomEffectDef>,
): string | undefined {
  if (target.conditions.includes('死亡')) return undefined;
  const dc = saveDc ?? inferSpellSaveDc(caster);
  const expr = buildAuraDamageExpr(hazard, slotLevel);
  const res = resolveSaveEffect(c, {
    targets: [{ name: target.name }],
    ability: hazard.saveAbility,
    dc,
    damage: expr,
    damageType: hazard.damageType,
    onSave: hazard.halfOnSave === false ? 'none' : 'half',
    ...(globalEffects !== undefined ? { globalEffects } : {}),
    roller,
  });
  const o = res.outcomes[0];
  if (o === undefined || o.skipped !== undefined) return undefined;
  const verdict = o.saved ? '成功' : '失败';
  const dmgPart = o.damage !== undefined
    ? `，${o.defense !== undefined ? `${DEFENSE_NAMES[o.defense]} ` : ''}受 ${o.damage} ${hazard.damageType}${o.change ? `（${formatHpBrief(o.change)}）` : ''}`
    : '';
  const line = `【光环·${auraName}（${caster.name}·${timingLabel}）】${target.name} ${ABILITY_NAMES[hazard.saveAbility]}豁免 ${o.detail ?? ''} → ${verdict}${dmgPart}`;
  pushCombatLedger(c, line);
  return line;
}

/** 计算某一格因持续区域（蛛网/荆棘）或敌方减速光环（灵体卫士）产生的移动力倍率 */
export function extraCellCostMultiplier(
  c: Campaign,
  mover: Character,
  at: { x: number; y: number; z?: number },
  room: string,
  globalEffects?: Record<string, CustomEffectDef>,
): number {
  let mult = 1;
  for (const z of zonesAtCell(c, room, at)) {
    if (z.difficult && zoneAffectsCharacter(c, z, mover)) mult = Math.max(mult, 2);
  }
  for (const other of c.characters) {
    if (other.name === mover.name || other.hp <= 0 || other.conditions.includes('死亡') || isIncapacitated(other)) continue;
    const otherCell = cellOfChar(c, other);
    if (otherCell === undefined || otherCell.room !== room) continue;
    for (const { def } of activeEffectDefsFor(other, c.customEffects, globalEffects)) {
      const aura = def.aura;
      if (aura?.slowFactor === undefined) continue;
      const hostile = isHostilePair(mover, other);
      if (aura.target === 'enemies' && !hostile) continue;
      if (aura.target === 'allies' && hostile) continue;
      const radius = other.level >= 18 && aura.radiusAt18 !== undefined ? aura.radiusAt18 : aura.radius;
      if (dist3d(at, otherCell) <= radius) {
        mult = Math.max(mult, Math.max(2, Math.round(1 / aura.slowFactor)));
      }
    }
  }
  return mult;
}

/**
 * 纯几何查询（零掷骰、零副作用）：从 prev 踏入 next 这一步会新触发或踩中哪些危害型领域/区域/光环
 * （如火墙术、荆棘丛生、蛛网术、毒雾、月华之光、敌方灵体卫士等）。
 * 供寻路自动绕行与拆分移动提醒使用：若起点已在非 perStep 区域内，往外走不会误判为再次踏入。
 */
export function stepHazardNamesAt(
  c: Campaign,
  mover: Character,
  prev: { x: number; y: number; z?: number },
  next: { x: number; y: number; z?: number },
  room: string,
  globalEffects?: Record<string, CustomEffectDef>,
): string[] {
  const names: string[] = [];
  const pushUnique = (n: string): void => {
    if (!names.includes(n)) names.push(n);
  };
  for (const zone of zonesInRoom(c, room)) {
    if (!zoneAffectsCharacter(c, zone, mover)) continue;
    const hasHarm = zone.damage !== undefined || (zone.onFailConditions?.length ?? 0) > 0;
    if (!hasHarm) continue;
    if (zone.perStep === true) {
      if (zoneCoversCell(zone, next)) pushUnique(zone.name);
      continue;
    }
    if (!zoneCoversCell(zone, prev) && zoneCoversCell(zone, next)) {
      pushUnique(zone.name);
    }
  }
  for (const other of c.characters) {
    if (other.name === mover.name || other.hp <= 0 || other.conditions.includes('死亡') || isIncapacitated(other)) continue;
    const otherCell = cellOfChar(c, other);
    if (otherCell === undefined || otherCell.room !== room) continue;
    for (const { def } of activeEffectDefsFor(other, c.customEffects, globalEffects)) {
      const aura = def.aura;
      if (aura?.hazard === undefined) continue;
      const hostile = isHostilePair(mover, other);
      if (aura.target === 'enemies' && !hostile) continue;
      if (aura.target === 'allies' && hostile) continue;
      const radius = other.level >= 18 && aura.radiusAt18 !== undefined ? aura.radiusAt18 : aura.radius;
      if (dist3d(prev, otherCell) > radius && dist3d(next, otherCell) <= radius) {
        pushUnique(`${other.name}的${def.name}`);
      }
    }
  }
  return names;
}

/**
 * 纯几何查询（零副作用）：某一格上覆盖 mover 的所有领域/区域/光环技能名（含遮蔽/难行/伤害型区域与光环）。
 */
export function domainNamesAtCell(
  c: Campaign,
  mover: Character,
  at: { x: number; y: number; z?: number },
  room: string,
  globalEffects?: Record<string, CustomEffectDef>,
): string[] {
  const names: string[] = [];
  const pushUnique = (n: string): void => {
    if (!names.includes(n)) names.push(n);
  };
  for (const z of zonesAtCell(c, room, at)) {
    if (zoneAffectsCharacter(c, z, mover)) pushUnique(z.name);
  }
  for (const other of c.characters) {
    if (other.name === mover.name || other.hp <= 0 || other.conditions.includes('死亡') || isIncapacitated(other)) continue;
    const otherCell = cellOfChar(c, other);
    if (otherCell === undefined || otherCell.room !== room) continue;
    for (const { def } of activeEffectDefsFor(other, c.customEffects, globalEffects)) {
      const aura = def.aura;
      if (aura?.hazard === undefined && aura?.slowFactor === undefined) continue;
      const hostile = isHostilePair(mover, other);
      if (aura.target === 'enemies' && !hostile) continue;
      if (aura.target === 'allies' && hostile) continue;
      const radius = other.level >= 18 && aura.radiusAt18 !== undefined ? aura.radiusAt18 : aura.radius;
      if (dist3d(at, otherCell) <= radius) {
        pushUnique(`${other.name}的${def.name}`);
      }
    }
  }
  return names;
}

/** 当前房间是否存在持续战场区域或角色领域光环 */
export function hasActiveDomainsInRoom(
  c: Campaign,
  room: string,
  globalEffects?: Record<string, CustomEffectDef>,
): boolean {
  if (zonesInRoom(c, room).length > 0) return true;
  for (const ch of c.characters) {
    if (ch.hp <= 0 || ch.conditions.includes('死亡') || isIncapacitated(ch)) continue;
    const cell = cellOfChar(c, ch);
    if (cell === undefined || cell.room !== room) continue;
    for (const { def } of activeEffectDefsFor(ch, c.customEffects, globalEffects)) {
      if (def.aura?.hazard !== undefined || def.aura?.slowFactor !== undefined) return true;
    }
  }
  return false;
}

/** 移动落位后：结算沿途踩入的持续区域伤害，以及进入/扫过的灵体卫士类危害光环（每回合每目标限 1 次） */
export function settleMovementHazards(
  c: Campaign,
  mover: Character,
  path: readonly BattleCell[],
  roller: Roller,
  globalEffects?: Record<string, CustomEffectDef>,
): string[] {
  if (c.initiative === undefined || path.length < 2) return [];
  const state = c.initiative;
  const room = path[0]!.room;
  const logs: string[] = [];

  // 1. 持续战场区域（BattleZone）
  for (const zone of zonesInRoom(c, room)) {
    if (!zone.triggers?.includes('enter')) continue;
    if (mover.conditions.includes('死亡')) break;
    if (zone.perStep === true) {
      const stepsIn = path.slice(1).filter((step) => zoneCoversCell(zone, step)).length;
      if (stepsIn > 0) {
        const line = applyZoneToCharacter(c, zone, mover, '移动穿行', roller, globalEffects, stepsIn);
        if (line !== undefined) logs.push(line);
      }
      continue;
    }
    const key = `${zone.id}->${mover.name}`;
    if (state.zoneTriggered?.includes(key)) continue;
    const entered = path.some((step, i) => i > 0 && !zoneCoversCell(zone, path[i - 1]!) && zoneCoversCell(zone, step));
    if (entered) {
      (state.zoneTriggered ??= []).push(key);
      const line = applyZoneToCharacter(c, zone, mover, '踏入区域', roller, globalEffects);
      if (line !== undefined) logs.push(line);
    }
  }

  // 2a. 移动者踏入敌方施法者的危害光环（如敌人走进牧师的灵体卫士）
  for (const other of c.characters) {
    if (mover.conditions.includes('死亡')) break;
    if (other.name === mover.name || other.hp <= 0 || other.conditions.includes('死亡') || isIncapacitated(other)) continue;
    const otherCell = cellOfChar(c, other);
    if (otherCell === undefined || otherCell.room !== room) continue;
    for (const { def, state: st } of activeEffectDefsFor(other, c.customEffects, globalEffects)) {
      const aura = def.aura;
      if (aura?.hazard === undefined) continue;
      const hostile = isHostilePair(mover, other);
      if (aura.target === 'enemies' && !hostile) continue;
      if (aura.target === 'allies' && hostile) continue;
      const radius = other.level >= 18 && aura.radiusAt18 !== undefined ? aura.radiusAt18 : aura.radius;
      const key = `${other.name}:${def.name}->${mover.name}`;
      if (state.auraTriggered?.includes(key)) continue;
      const entered = path.some((step, i) => i > 0 && dist3d(path[i - 1]!, otherCell) > radius && dist3d(step, otherCell) <= radius);
      if (entered) {
        (state.auraTriggered ??= []).push(key);
        const line = applyHazardAuraToCharacter(c, other, def.name, aura.hazard, st?.slotLevel, st?.saveDc, mover, '踏入光环', roller, globalEffects);
        if (line !== undefined) logs.push(line);
      }
    }
  }

  // 2b. 移动者自身携带危害光环（如牧师开着灵体卫士主动走上前扫过敌人；同一回合每目标至多 1 次防反复横跳刷伤）
  if (!mover.conditions.includes('死亡') && mover.hp > 0 && !isIncapacitated(mover)) {
    for (const { def, state: st } of activeEffectDefsFor(mover, c.customEffects, globalEffects)) {
      const aura = def.aura;
      if (aura?.hazard === undefined) continue;
      const radius = mover.level >= 18 && aura.radiusAt18 !== undefined ? aura.radiusAt18 : aura.radius;
      for (const other of c.characters) {
        if (other.name === mover.name || other.conditions.includes('死亡')) continue;
        const hostile = isHostilePair(mover, other);
        if (aura.target === 'enemies' && !hostile) continue;
        if (aura.target === 'allies' && hostile) continue;
        const otherCell = cellOfChar(c, other);
        if (otherCell === undefined || otherCell.room !== room) continue;
        const key = `${mover.name}:${def.name}->${other.name}`;
        if (state.auraTriggered?.includes(key)) continue;
        const swept = path.some((step, i) => i > 0 && dist3d(path[i - 1]!, otherCell) > radius && dist3d(step, otherCell) <= radius);
        if (swept) {
          (state.auraTriggered ??= []).push(key);
          const line = applyHazardAuraToCharacter(c, mover, def.name, aura.hazard, st?.slotLevel, st?.saveDc, other, '光环扫过', roller, globalEffects);
          if (line !== undefined) logs.push(line);
        }
      }
    }
  }

  return logs;
}

/** 回合切换时（prevActor 结束回合 → nextActor 开始回合）：自动结算 turn_end 区域、turn_start 区域与敌方危害光环 */
export function settleTurnBoundaryHazards(
  c: Campaign,
  prevActor: string | undefined,
  nextActor: string,
  roller: Roller,
  globalEffects?: Record<string, CustomEffectDef>,
): string[] {
  if (c.initiative === undefined) return [];
  const logs: string[] = [];

  if (prevActor !== undefined && prevActor !== nextActor) {
    const prevCh = c.characters.find((x) => x.name === prevActor);
    const prevCell = prevCh === undefined ? undefined : cellOfChar(c, prevCh);
    if (prevCh !== undefined && prevCell !== undefined && !prevCh.conditions.includes('死亡')) {
      for (const zone of zonesAtCell(c, prevCell.room, prevCell)) {
        if (!zone.triggers?.includes('turn_end')) continue;
        const line = applyZoneToCharacter(c, zone, prevCh, '回合结束', roller, globalEffects);
        if (line !== undefined) logs.push(line);
      }
    }
  }

  const nextCh = c.characters.find((x) => x.name === nextActor);
  const nextCell = nextCh === undefined ? undefined : cellOfChar(c, nextCh);
  if (nextCh !== undefined && nextCell !== undefined && !nextCh.conditions.includes('死亡')) {
    for (const zone of zonesAtCell(c, nextCell.room, nextCell)) {
      if (!zone.triggers?.includes('turn_start')) continue;
      if (nextCh.conditions.includes('死亡')) break;
      const line = applyZoneToCharacter(c, zone, nextCh, '回合开始', roller, globalEffects);
      if (line !== undefined) logs.push(line);
    }

    for (const caster of c.characters) {
      if (nextCh.conditions.includes('死亡')) break;
      if (caster.name === nextCh.name || caster.hp <= 0 || caster.conditions.includes('死亡') || isIncapacitated(caster)) continue;
      const casterCell = cellOfChar(c, caster);
      if (casterCell === undefined || casterCell.room !== nextCell.room) continue;
      for (const { def, state: st } of activeEffectDefsFor(caster, c.customEffects, globalEffects)) {
        const aura = def.aura;
        if (aura?.hazard === undefined) continue;
        const hostile = isHostilePair(nextCh, caster);
        if (aura.target === 'enemies' && !hostile) continue;
        if (aura.target === 'allies' && hostile) continue;
        const radius = caster.level >= 18 && aura.radiusAt18 !== undefined ? aura.radiusAt18 : aura.radius;
        if (dist3d(nextCell, casterCell) <= radius) {
          const line = applyHazardAuraToCharacter(c, caster, def.name, aura.hazard, st?.slotLevel, st?.saveDc, nextCh, '回合开始', roller, globalEffects);
          if (line !== undefined) logs.push(line);
        }
      }
    }
  }

  return logs;
}

export interface VisualAuraRing {
  caster: string;
  name: string;
  x: number;
  y: number;
  radius: number;
  theme: ZoneTheme;
}

/** 供战斗地图绘制移动式角色光环（如灵体卫士 15 尺光环） */
export function activeVisualAurasInRoom(
  c: Campaign,
  room: string,
  visible: (ch: Character) => boolean = () => true,
  globalEffects?: Record<string, CustomEffectDef>,
): VisualAuraRing[] {
  const rings: VisualAuraRing[] = [];
  for (const ch of c.characters) {
    if (ch.hp <= 0 || ch.conditions.includes('死亡') || isIncapacitated(ch) || !visible(ch)) continue;
    const cell = cellOfChar(c, ch);
    if (cell === undefined || cell.room !== room) continue;
    for (const { def } of activeEffectDefsFor(ch, c.customEffects, globalEffects)) {
      if (def.aura?.hazard === undefined) continue;
      const radius = ch.level >= 18 && def.aura.radiusAt18 !== undefined ? def.aura.radiusAt18 : def.aura.radius;
      rings.push({
        caster: ch.name,
        name: def.name,
        x: cell.x,
        y: cell.y,
        radius,
        theme: inferZoneTheme(def.name, def.aura.hazard.damageType),
      });
    }
  }
  return rings;
}

