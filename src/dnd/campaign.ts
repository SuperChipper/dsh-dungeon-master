/**
 * 跑团权威状态 — 每个群（或私聊）一份 campaign JSON。
 *
 * 角色卡、HP、状态、先攻、当前房间、已揭示房间都只在这里改，模型通过工具读写；
 * 每回合只把 summarize() 的精简摘要注入 prompt，不注入整份 JSON。
 * 剧情状态（flag、线索、任务、NPC）的读写在 story.ts，这里只存字段。
 * 写法参考 sticker-store：先写 .tmp 再 rename，避免写一半崩掉留下坏文件。
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../shared/atomic-fs.ts';
import { parseProgress } from './progress-patch.ts';
import { rollD20, rollExpression, type Roller, cryptoRoller } from './dice.ts';
import type { ChronicleEntry } from './chronicle.ts';
import type { CardSpell } from './spell-links.ts';
import type { BackstoryHook } from './hooks.ts';
import { type Adventure, type QuestStatus, type Site, findSite, isHub, roomGraph, siteOfRoom } from './adventure.ts';
import {
  type DungeonExit,
  type DungeonMonster,
  type ExitCheck,
  type DungeonRoom,
  exitBetween,
  exitKey,
  exitsOf,
  findRoom,
  normalizeMonsterResources,
} from './dungeon.ts';
import { ABILITIES, type Ability, type Skill, abilityModifier, parseAbility, parseSkill, proficiencyBonus, SKILLS } from './rules.ts';
import { type MoveRequest, battleGridLines, battleLines, canReact, cellOf, distancesFrom, hiddenFromPlayers } from './battlefield.ts';
import {
  type ActiveState,
  type ActiveOngoingEffect,
  type PreparedOngoingEffect,
  type ConcentrationRecord,
  type TurnActionState,
  INCAPACITATING_CONDITIONS,
  ZERO_SPEED_CONDITIONS,
  actionRestriction,
  breakConcentration,
  computeDefenseStateMod,
  concentratingOn,
  concentratingSpellNames,
  effectiveMaxHp,
  effectiveStates,
  exhaustionLevel,
  externalConcentrationTags,
  hasCondition,
  immuneToCondition,
  isIncapacitated,
  normalizeCondition,
  notifyConcentrationTargetDown,
  ongoingEffects,
  removeActiveState,
  removeOngoingEffect,
  stateAcBonus,
  syncConcentrationAfterRemoval,
  tickActiveStatesOnTurnChange,
  upsertActiveState,
} from './conditions.ts';
import type { CustomEffectDef } from './custom-effects.ts';
import { pendingSummaryLine } from './pending-attack.ts';
import { DEFENSE_NAMES, settleOngoingSaves } from './save-effect.ts';
import type { BattleMap } from './terrain.ts';
import { type NpcState, afterChange, describeCondition, evalCondition, locationKnown, roomView, storySummaryLines } from './story.ts';
import { type BattleZone, type BattleZoneInput, settleTurnBoundaryHazards } from './zones.ts';

export type { ActiveState, ConcentrationRecord, TurnActionState };

export type CharacterKind = 'pc' | 'npc' | 'monster';

export interface CharacterDelegation {
  mode: 'player' | 'dm';
  playerId?: string;
  player?: string;
  since?: number;
}

export type CompanionStatus = 'following' | 'stationed' | 'retired';

export interface Character {
  name: string;
  kind: CharacterKind;
  /** 玩家群昵称（pc 才有） */
  player?: string;
  /** 玩家 openid：绑定后只有这个人能宣告该角色的行动 */
  playerId?: string;
  /** 本次开团未签到或中途暂离，暂时移出队伍（角色卡完整保留；晚到点「签到」或收团后自动归队） */
  absent?: boolean;
  /** NPC 随行状态：following（默认，随队移动）/ stationed（留守当前房间）/ retired（已退队，不参与整队移动与分头提醒） */
  companionStatus?: CompanionStatus;
  /** 临时托管：把控制权交给另一位玩家或交由 DM 直接接管（保留原 playerId，停团/开团自动清空） */
  delegated?: CharacterDelegation;
  className?: string;
  level: number;
  abilities: Record<Ability, number>;
  /** 熟练技能 */
  skills: Skill[];
  /** 专精技能：熟练加值翻倍（游荡者、吟游诗人）；隐含熟练 */
  expertise?: Skill[];
  /** 熟练豁免 */
  saves: Ability[];
  hp: number;
  maxHp: number;
  tempHp: number;
  ac: number;
  conditions: string[];
  conditionImmunities?: string[];
  /** 结构化生效状态（含持续轮数、专注归属、动态命中/AC加值）；旧存档缺省时自动从 conditions 推导 */
  activeStates?: ActiveState[];
  /** 施法者本人维持的专注记录（使脆弱诅咒/猎人印记等可转移专注在原目标倒下、清尸或跨场战斗后依然保留在施法者身上） */
  concentrationState?: ConcentrationRecord;
  /** 怪物/NPC 的命中加值与伤害（PC 按属性+熟练算） */
  attackBonus?: number;
  damage?: string;
  /** 固定先攻总加值覆盖；未设置时取敏捷调整值，临时骰在开战时另传 */
  initBonus?: number;
  /** 步行速度（尺）；缺省按 30 算，只用来提醒超速 */
  speed?: number;
  /** 飞行速度（尺）；有值时允许在战场地图上升空 z > 0 */
  flySpeed?: number;
  /** 悬浮（hover）：高空陷入倒地或速度归 0 时不会坠机 */
  hover?: boolean;
  /** 能改写攻击结果的反应；工具按它决定要不要停下来等（见 pending-attack.ts）。缺省时从备注推断 */
  reactions?: ReactionDef[];
  /** 所在房间。怪物离开房间就不进先攻；PC/NPC 缺省时跟着队伍主位置（currentRoom） */
  room?: string;
  srd?: string;
  /** 模组里的具名 NPC（入队或上场战斗时建的卡） */
  npcId?: string;
  notes?: string;
  /** 武器：攻击时按名字取伤害和属性，避免模型临时编伤害骰 */
  weapons?: Weapon[];
  /** 会的法术：回合按钮「我的法术」照这个列清单和 wiki 链接（见 spell-links.ts） */
  spells?: CardSpell[];
  /** 玩家给的来历里没了结的事，场景沾边时提醒 DM（见 hooks.ts）；只有 PC 有 */
  hooks?: BackstoryHook[];
  /** 0 HP 时的死亡豁免计数 */
  deathSaves?: { successes: number; failures: number };
  /** 工具会自动处理的特性，如「不死坚韧」 */
  traits?: string[];
  /** 有次数的资源：法术位、圣疗池、诗人激励、职业特性 */
  resources?: Record<string, Resource>;
  /** 生命骰（如 d10）与已用数量；总数 = 等级 */
  hitDie?: string;
  hitDiceUsed?: number;
  inventory?: string[];
  gp?: number;
}

export interface Resource {
  current: number;
  max: number;
  /** 什么休息后回满；none 表示只能手动恢复（如一次性物品） */
  reset: 'short' | 'long' | 'none';
}

export interface Weapon {
  name: string;
  /** 伤害表达式（不含属性调整），如 1d12 */
  damage: string;
  /** 命中/伤害用的属性；缺省取力量（灵巧武器传 dex） */
  ability?: Ability;
  /** 伤害类型、特性等备注 */
  notes?: string;
  /** 魔法武器 +N：命中和伤害都加 */
  magic?: number;
  /** 不熟练（如游荡者拿弯刀）：命中不加熟练加值；缺省熟练 */
  proficient?: boolean;
  /** 远程武器（弓、弩）：箭术战斗风格只加在这上面；缺省按名字里有没有弓/弩判断 */
  ranged?: boolean;
  /** 双手持用（双手或多用途双手握）：巨武器战斗只作用在这上面；缺省看备注里有没有「双手」 */
  twoHanded?: boolean;
  /** 多段伤害附伤（如烈焰舌 +2d6 火焰、淬毒匕首 +2d6 毒素），各自按自身伤害类型独立结算抗性/免疫且重击自动翻倍骰数 */
  riders?: Array<{ damage: string; damageType: string }>;
}

export interface InitiativeEntry {
  name: string;
  init: number;
}

/**
 * foe_attacks：敌人打队友时（尖刻言语）；attacked：自己被命中且非重击时（护盾术）；
 * attacking：自己攻击没中时（导引打击）；damaged：自己确认受伤害后（迷雾逃生、炼狱叱喝）；
 * enemy_crit：敌人打出重击时（时间变幻）；foe_casts：敌方在 60 尺内施法时（法术反制）
 */
export interface ReactionDef {
  name: string;
  when?: 'foe_attacks' | 'attacked' | 'attacking' | 'damaged' | 'enemy_crit' | 'foe_casts';
  /** 用掉的资源；卡上这项不够 cost 就不问他 */
  resource?: string;
  /** 每次使用消耗的资源点数（缺省 1；如防御法杖施放护盾术为 2） */
  cost?: number;
  /** 够得着的距离（尺），量的是「反应者到自己那次攻击/施法发起者」；不填 = 不按距离筛 */
  range?: number;
  /**
   * 这个反应是一次新的攻击（哨兵：5 尺内有人打别人时反打一记），不是改数值。
   * 工具只登记「用掉了」，还击本身由 DM 落账后用 dnd_check reaction=true 结算。
   */
  counter?: boolean;
  /**
   * 触发条件反过来：敌人「进入」触及范围时借机（长柄大师），不是离开。
   * 这时 range 当那把武器的触及用，不填按 5 尺。
   */
  enter?: boolean;
}

/**
 * 从角色卡 reactions / spells / notes 识别常见反应能力；显式传空数组 `reactions: []` 表示明确禁用自动推断。
 */
const INFERRED_REACTIONS: Array<{ pattern: RegExp; def: ReactionDef }> = [
  { pattern: /尖刻言语|Cutting Words/i, def: { name: '尖刻言语', when: 'foe_attacks', resource: '诗人激励', range: 60 } },
  { pattern: /护盾术|(?<!Fire\s)\bShield\b(?!\s+of\b)/i, def: { name: '护盾术', when: 'attacked' } },
  { pattern: /法术反制|反制法术|Counterspell/i, def: { name: '法术反制', when: 'foe_casts', range: 60 } },
  { pattern: /导引打击|Guided Strike/i, def: { name: '导引打击', when: 'attacking', resource: '引导神力' } },
  // 时间变幻平时不每刀都弹，敌人重击时自动挂起防秒杀；普通检定/豁免仍由 DM 用 hold_for 挂起
  { pattern: /时间变幻|Chronal Shift/i, def: { name: '时间变幻', when: 'enemy_crit', resource: '时间变幻', range: 30 } },
  { pattern: /迷雾逃生|Misty Escape/i, def: { name: '迷雾逃生', when: 'damaged', resource: '迷雾逃生' } },
  { pattern: /炼狱叱喝|Hellish Rebuke/i, def: { name: '炼狱叱喝', when: 'damaged', range: 60 } },
  { pattern: /吸收元素|Absorb Elements/i, def: { name: '吸收元素', when: 'damaged' } },
  { pattern: /直觉闪避|Uncanny Dodge/i, def: { name: '直觉闪避', when: 'damaged' } },
  // 哨兵：5 尺内有人打别人时反打一记。是不算命中与否的新攻击，所以不看 hit
  { pattern: /哨兵|Sentinel/i, def: { name: '哨兵', when: 'foe_attacks', range: 5, counter: true } },
  // 长柄大师：拿着长柄武器时，敌人「进入」触及范围就借机（不是离开）
  { pattern: /长柄大师|Polearm Master/i, def: { name: '长柄大师', when: 'foe_attacks', enter: true, range: 10 } },
];

function hasPositiveReactionMention(notes: string, pattern: RegExp): boolean {
  const cleanPattern = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  for (const sub of notes.split(/[，,。\n；;！!]+/)) {
    const m = cleanPattern.exec(sub);
    if (m === null) continue;
    const pre = sub.slice(0, m.index);
    const post = sub.slice(m.index + m[0].length);
    if (/(?:移除|取消|失去|没有|不含|未学|作废|放弃|删去)|(?:^|[^不])无\s*$/.test(pre)) continue;
    if (/^原/.test(pre.trim()) && /(?:移除|取消|失去|作废|洗点|重修|改为)/.test(sub)) continue;
    if (/^[^（(]*?(?:已移除|被移除|移除|已取消|取消|已失去|失去|作废|已删)/.test(post)) continue;
    return true;
  }
  return false;
}

export function reactionsOf(ch: Character): ReactionDef[] {
  if (ch.reactions !== undefined && ch.reactions.length === 0) return [];
  const out: ReactionDef[] = ch.reactions !== undefined ? [...ch.reactions] : [];
  const pushUnique = (def: ReactionDef): void => {
    if (!out.some((x) => x.name === def.name)) out.push(def);
  };
  for (const s of ch.spells ?? []) {
    for (const { pattern, def } of INFERRED_REACTIONS) {
      if (pattern.test(s.name)) pushUnique(def);
    }
  }
  if (ch.reactions === undefined && ch.notes) {
    for (const { pattern, def } of INFERRED_REACTIONS) {
      if (hasPositiveReactionMention(ch.notes, pattern)) pushUnique(def);
    }
  }
  return out;
}

export interface ReactorOption {
  character: string;
  reaction: string;
  /** DM 用 hold_for 点名问的（时间变幻这类不登记触发条件的反应）；重掷后重算名单时保留 */
  manual?: boolean;
  /** NPC/怪物由 DM 决定，不生成可被群成员点击的反应按钮。 */
  npc?: boolean;
  /** DM 托管中的 PC：保留反应窗口以防 AFK 丢反应，允许 DM 不凭玩家 authorization 直接代为触发/结算，且不发玩家按钮。 */
  dmManaged?: boolean;
  /** 仅真实入站消息/按钮生成；旧存档没有凭证时必须重新确认。 */
  authorization?: string;
}

interface PendingBase {
  /** 打开这笔的那一骰的编号（#R）；按钮靠它认出旧消息，撤销不会让它回退，所以不会和新的一笔撞号 */
  seq: number;
  /** 窗口开始的时间；重掷后有新的人能反应时会重开 */
  at: number;
  /** 攻击：攻击者。豁免：效果来源（施法者、陷阱）。检定：掷骰的人 */
  attacker: string;
  /** 攻击：被打的人。豁免/检定：第一个掷骰的人；dnd_apply target 用它对账 */
  target: string;
  reactors: ReactorOption[];
  declined: string[];
  /** 本人明确选择要用，效果还没结算；授权绑定这个窗口和具体技能。 */
  claimed: ReactorOption[];
  /** 入站重复投递不能在玩家改选后复活旧授权。 */
  reactionReplyIds?: string[];
  used: Array<{ by: string; name: string; effect: string; spendKey?: string; spendAmount?: number; consumedReaction?: boolean }>;
}

export interface PendingRider {
  label: string;
  expression: string;
  rawDamage?: number;
  detail?: string;
  damageType: string;
  defense?: 'resistant' | 'immune' | 'vulnerable';
  oncePerTurnRule?: string;
  critOnly?: boolean;
}

/** 掷完骰、还没落账的一次攻击 */
export interface PendingAttack extends PendingBase {
  kind: 'attack';
  weapon?: string;
  /** 额外伤害表达式；未命中转命中时落账才掷，要留着 */
  extraDamage?: string;
  onHit?: OnHitEffect;
  /** 自动收集的结构化命中附伤（脆弱诅咒、猎人印记、武器多段伤害、扩展规则附伤） */
  riders?: PendingRider[];
  natural: number;
  rollDetail: string;
  total: number;
  /** 这一骰的修正和优劣势：重掷要按原样再掷一次（旧存档没有，按 total - natural 算） */
  modifier?: number;
  advantage?: 'none' | 'advantage' | 'disadvantage';
  /** 精灵精准重掷时保持三骰取高 */
  elvenAccuracy?: boolean;
  /** 重击阈值（缺省 20；咒剑诅咒等为 19） */
  critThreshold?: number;
  /** 目标处于 5 尺内麻痹/昏迷：确认命中时自动转为重击（不改变命中判定本身） */
  autoCritOnHit?: boolean;
  ac: number;
  crit: boolean;
  /** 掷好的伤害（抗性之前）；没中时没有 */
  rawDamage?: number;
  damageDetail?: string;
  damageType?: string;
  defense?: 'resistant' | 'immune' | 'vulnerable';
  attackMod: number;
  acMod: number;
  damageMod: number;
  spellName?: string;
  spellLevel?: number;
  countered?: boolean;
  counteredBy?: string;
}

/** 玩家预先授权的命中追加；防守方反应全部结束后才掷骰和扣资源。 */
export interface OnHitEffect {
  name: string;
  damage: string;
  damageType: string;
  spend: string;
  criticalOnly?: boolean;
  defense?: 'resistant' | 'immune' | 'vulnerable';
}

/** 豁免/检定里一个人的那一骰 */
export interface PendingD20 {
  name: string;
  natural: number;
  modifier: number;
  advantage: 'none' | 'advantage' | 'disadvantage';
  total: number;
  detail: string;
  /** 反应加减的（尖刻言语 -1d6），重掷后保留 */
  mod: number;
  autoFailed?: string;
  defense?: 'resistant' | 'immune' | 'vulnerable';
}

/**
 * 掷完、还没落账的豁免或检定。带伤害/失败状态的豁免效果由落账一起结算；
 * 单纯的检定落账只报最终成败，后果由 DM 演。
 */
export interface PendingCheck extends PendingBase {
  kind: 'roll';
  /** 「感知豁免」「运动检定」 */
  label: string;
  dc?: number;
  rolls: PendingD20[];
  /** 豁免效果的伤害：所有目标共用一次掷骰 */
  damage?: { total: number; detail: string; type?: string; onSave: 'half' | 'none' };
  /** 豁免失败附带的状态 */
  onFail?: string[];
  effectSource?: string;
  ongoing?: PreparedOngoingEffect;
  /** 豁免失败附加状态绑定的专注施法者 */
  concentrationSource?: string;
  /** 是否为受击体质专注豁免（挂起后若落账结果为失败，自动打断施法者专注） */
  concentrationCheck?: boolean;
  /** 豁免失败附加状态的持续轮数 */
  failRounds?: number;
  damageMod: number;
  spellName?: string;
  spellLevel?: number;
  countered?: boolean;
  counteredBy?: string;
}

/** 敌方施放持续区域、群体增益或魔法飞弹等待反应窗口（支持法术反制 / 护盾术挡魔法飞弹） */
export interface PendingSpell extends PendingBase {
  kind: 'spell';
  spellName: string;
  spellLevel?: number;
  countered?: boolean;
  counteredBy?: string;
  shieldedTargets?: string[];
  effect:
    | { kind: 'zone'; zoneInput: BattleZoneInput; spellWarn?: string }
    | {
        kind: 'state';
        stateName: string;
        targets: string[];
        concentration: boolean;
        rounds?: number;
        expires?: ActiveState['expires'];
        hitBonus?: number;
        acBonus?: number;
        slotLevel?: number;
        saveDc?: number;
        conditions?: string[];
        ongoing?: PreparedOngoingEffect;
        warnings?: string[];
      }
    | {
        kind: 'magic_missile';
        targets: Array<{ name: string; damage: number; defense?: 'resistant' | 'immune' | 'vulnerable' }>;
        damageDetail?: string;
        damageType: string;
      };
}

export type PendingRoll = PendingAttack | PendingCheck | PendingSpell;

/** 移动在触发借机或等待队友确认换位时暂停；反应攻击仍使用 pending，可以再被护盾等反应打断。 */
export interface PendingMovement extends PendingBase {
  kind: 'move';
  resume: MoveRequest;
  /** 友方换位确认窗口：记录待同意的友方角色名（不消耗对方反应） */
  swapWith?: string;
}

export type ReactionWindow = PendingRoll | PendingMovement;

export function reactionWindow(c: Campaign | undefined): ReactionWindow | undefined {
  return c?.initiative?.pending ?? c?.initiative?.movement ?? c?.pending;
}

/** 写入待结算窗口：战斗中挂在先攻上，战斗外仅允许挂起检定/豁免（kind=roll）。 */
export function setPendingRoll(c: Campaign, pending: PendingRoll): void {
  if (c.initiative !== undefined) {
    c.initiative.pending = pending;
    return;
  }
  if (pending.kind !== 'roll') {
    throw new Error('攻击与战斗施法待结算只能在战斗中使用，先用 dnd_initiative start');
  }
  c.pending = pending;
}

/** 清除当前待结算骰子（无论来自战斗先攻还是战斗外探索窗口）。 */
export function clearPendingRoll(c: Campaign): void {
  if (c.initiative?.pending !== undefined) {
    delete c.initiative.pending;
  } else {
    delete c.pending;
  }
}

/** 留守或已退队的 NPC：不随整队 dnd_move 移动，也不计入分头行动告警。 */
export function isStationedNpc(ch: Character): boolean {
  return ch.kind === 'npc' && (ch.companionStatus === 'stationed' || ch.companionStatus === 'retired');
}

export function companionStatusTag(ch: Character): string | undefined {
  if (ch.kind !== 'npc') return undefined;
  if (ch.companionStatus === 'stationed') return '留守';
  if (ch.companionStatus === 'retired') return '已退队';
  return undefined;
}

/** 这笔是什么，给提示和报错用 */
export function describePending(p: ReactionWindow): string {
  if (p.kind === 'move') return p.swapWith !== undefined ? `${p.target} 请求与 ${p.swapWith} 交换站位` : `${p.target} 的移动（借机）`;
  if (p.kind === 'spell') return `${p.attacker} 施放的「${p.spellName}」`;
  if (p.kind === 'attack') {
    return p.spellName !== undefined
      ? `${p.attacker}→${p.target} 的「${p.spellName}」攻击`
      : `${p.attacker}→${p.target} 的攻击`;
  }
  const who = p.rolls.map((r) => r.name).join('、');
  if (p.spellName !== undefined) return `${p.attacker} 施放的「${p.spellName}」（${who} ${p.label}）`;
  return p.attacker === who ? `${who} 的${p.label}` : `${p.attacker} 的效果（${who} ${p.label}）`;
}

/** 战斗内坐标（一格 5 尺）。带上房间，角色换房间后旧坐标自动作废 */
export interface BattleCell {
  x: number;
  y: number;
  /** 离地高度（尺，5 的非负整数倍；缺省或 0 为地面） */
  z?: number;
  room: string;
}

export interface CombatLedgerEntry {
  round: number;
  seq?: number;
  text: string;
}

export interface RehearsalSnapshot {
  characters: Character[];
  battlemaps?: Record<string, BattleMap>;
  npcs: Record<string, NpcState>;
  spawned: string[];
  enteredFrom?: Record<string, string>;
  temporaryMonsters?: string[];
}

export interface HexbladeCurse {
  caster: string;
  target: string;
}

export interface LastCombatSummary {
  at: number;
  rounds: number;
  rehearsal?: boolean;
  restored?: boolean;
  participants: string[];
  defeated: string[];
  survivingMonsters: Array<{ name: string; hp: number; maxHp: number; conditions: string[]; wound: string }>;
  fallenParty: Array<{ name: string; hp: number; maxHp: number; conditions: string[] }>;
  ledger: CombatLedgerEntry[];
}

export interface InitiativeState {
  battleId?: string;
  round: number;
  /** 当前行动者在 order 里的下标 */
  turn: number;
  order: InitiativeEntry[];
  /** 这场战斗已经给过完整回合提示的角色类别；之后的回合只给精简提示（见 turnPrompt） */
  briefed?: Array<'pc' | 'monster'>;
  /** 出现了反应/借机攻击/指针修正等破例：下一个 PC 回合重新给完整提示 */
  rebrief?: boolean;
  /** 站位：角色名 → 格子（见 battlefield.ts） */
  positions?: Record<string, BattleCell>;
  /** 不是角色卡上的地标：门、柱子、没建卡的俘虏 */
  marks?: Record<string, BattleCell>;
  /** 当前回合已走的尺数；指针一动就清 */
  moved?: Record<string, number>;
  /** 当前回合冲刺过的人（移动力翻倍）；和 moved 一起清 */
  dashed?: string[];
  disengaged?: string[];
  /** 武士「战斗英姿」：本回合内武器攻击具优势，回合结束自动清除 */
  fightingSpirit?: string[];
  /** 护盾术持续到施法者下回合开始，不只保护触发它的那一次攻击。 */
  shielded?: string[];
  /** 同一时间只有一笔：落账前不能推进，所以不需要队列 */
  pending?: PendingRoll;
  movement?: PendingMovement;
  /** 哨兵等已经登记反应消耗、尚未掷骰的还击；不能再扣第二次，也不能当作任意反应通行证。 */
  counterAttacks?: Array<{ by: string; target: string; name: string }>;
  /** 本轮用过反应的人；到他自己的回合开始时恢复 */
  reacted?: string[];
  /**
   * 受惊的人：第 1 轮轮到时工具直接跳过，跳过前也不能反应。
   * 以前靠 DM 逐个喊「点结束回合」，一场突袭要等五六个人各点一次按钮。
   */
  surprised?: string[];
  /** 本场曾经进入过先攻表的全部角色（含中途 join 或中途 leave 的角色），供收尾摘要对账 */
  allParticipants?: string[];
  /** 本场完整战斗账本（按轮次记录，供战斗代理收尾交接补齐未播报回合） */
  ledger?: CombatLedgerEntry[];
  /** 当前行动者本回合的结构化动作槽与起身记录（回合切换自动重置） */
  turnState?: TurnActionState;
  /** 战场持续区域效果（黑暗术、毒雾、蛛网术、荆棘丛生等；随轮次倒计时、断专注或结束战斗自动清场） */
  zones?: BattleZone[];
  /** 当前回合内已触发过 enter 的区域键（`${zoneId}:${charName}`，推进回合自动清空） */
  zoneTriggered?: string[];
  /** 当前回合内已触发过伤害光环的键（`${caster}->${target}:${auraName}`，推进回合自动清空） */
  auraTriggered?: string[];
  /** 梦境/幻境/切磋演练模式：战后自动恢复战前角色状态与房间场地图 */
  rehearsal?: boolean;
  rehearsalSnapshot?: RehearsalSnapshot;
}

export interface CampaignSummary {
  at: number;
  text: string;
  /** 摘要写入时对应的房间与团况，用于区分叙事地点和模组的粗粒度房间 */
  room?: string;
  state?: string;
}

export interface SessionHandoff {
  at: number;
  room: string;
  /** 不把新变化拼回旧摘要，避免挤掉尚未了结的线头 */
  changes: string[];
  needsReview: boolean;
}

export interface EndPreparationState {
  id: string;
  phase: 'ending' | 'preparing';
  startedAt: number;
  hasSummary: boolean;
}

export interface Campaign {
  version: 2;
  key: string;
  /** v1 叫 dungeonId；旧的单地城会被包成同 id 的模组 */
  adventureId: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  currentRoom: string;
  revealed: string[];
  discoveredExits: string[];
  /** 遭遇已经刷出过的房间（离开再回来不重刷） */
  spawned: string[];
  characters: Character[];
  initiative?: InitiativeState;
  /** 战斗外探索期挂起等待反应的检定/豁免（如时间变幻、闪光灵感等） */
  pending?: PendingCheck;
  summaries: CampaignSummary[];
  handoff?: SessionHandoff;
  /** 只给 DM 的候选计划，不能作为已经发生的事实 */
  preparation?: { at: number; state: string; text: string };
  /** 停团过渡与后台备团状态（不计入剧情哈希；完成或下次开团时清除） */
  endPrep?: EndPreparationState;
  /** 最近的关键事件（伤害、倒地、移动），摘要里展示最后几条 */
  log: string[];

  // ── 剧情状态（story.ts 读写） ──
  chapter: string;
  flags: string[];
  /** 玩家知道的线索，按得知顺序 */
  leads: string[];
  /** 已经透露过的信息 */
  facts: string[];
  firedTriggers: string[];
  quests: Record<string, QuestStatus>;
  npcs: Record<string, NpcState>;
  /** 玩家知道的场景 */
  knownSites: string[];
  /** 只提示一次的事（里程碑、章节推进） */
  announced: string[];
  /** false = 还在开场（没进第一个场景）；旧存档没有这个字段，当作已开始 */
  begun?: boolean;
  /** 这一次开团（/dnd start）的时间：停团时据此判断这次有没有写过进度 */
  sessionStartedAt?: number;
  /** 剧情账本（chronicle.ts）；老团第一次改动时补记，新团从空开始 */
  chronicle?: ChronicleEntry[];
  /**
   * 骰子编号（#R）的计数。撤销时不跟着回退：退掉的编号不再复用，模型上下文里的旧编号才不会指到新的骰子上。
   * 只有它变了不算改动，不存快照。
   */
  rollSeq?: number;
  /** 战斗场地图，按房间 id（terrain.ts）；打完仗也留着，再进这间沿用 */
  battlemaps?: Record<string, BattleMap>;
  /** 每个房间最近一次是从哪个房间进来的：开战时队伍默认站在那扇门边 */
  enteredFrom?: Record<string, string>;
  /** 激活中的咒剑诅咒（1 分钟，战后或休息自动清除） */
  hexbladeCurses?: HexbladeCurse[];
  /** 本战役注册的扩展/村规效果表（优先于全局 custom-effects.json） */
  customEffects?: Record<string, CustomEffectDef>;
  /** 最近一场结束战斗的结构化摘要与账本（仅用于战后交接，不计入剧情哈希） */
  lastCombat?: LastCombatSummary;
}

const MAX_LOG = 30;
const MAX_COMBAT_LEDGER = 200;
const MAX_SNAPSHOTS = 40;
const MAX_CHECKPOINTS = 20;
const MAX_SUMMARIES = 10;
/** 一条进度/结团摘要的上限：每次开团都整条注入 */
export const SUMMARY_MAX_CHARS = 1500;
const SUMMARY_LOG_LINES = 5;

export function createCampaign(key: string, adv: Adventure, now = Date.now()): Campaign {
  const startSite = siteOfRoom(adv, adv.start);
  return {
    version: 2,
    key,
    adventureId: adv.id,
    active: true,
    createdAt: now,
    updatedAt: now,
    currentRoom: adv.start,
    revealed: [adv.start],
    discoveredExits: [],
    spawned: [],
    characters: [],
    summaries: [],
    log: [],
    chapter: startSite?.chapter ?? adv.chapters[0]?.id ?? '',
    flags: [],
    leads: [],
    facts: [],
    firedTriggers: [],
    quests: {},
    npcs: {},
    knownSites: adv.sites.filter((s) => s.knownWhen === undefined || s.id === startSite?.id).map((s) => s.id),
    announced: [],
    begun: false,
    chronicle: [],
  };
}

/**
 * 按当前模组补齐 knownSites：没写 knownWhen 的场景本来就该一开始知道。
 * knownSites 只在开团时算一次，开团后模组再加场景、去掉 knownWhen，旧存档永远走不过去——
 * 模型被逼得直接去改存档 JSON。每次加载都对一遍，只增不减（玩家已知的不会被收回）。
 */
export function reconcileKnownSites(c: Campaign, adv: Adventure): string[] {
  const added = adv.sites.filter((s) => s.knownWhen === undefined && !c.knownSites.includes(s.id)).map((s) => s.id);
  c.knownSites.push(...added);
  return added;
}

/**
 * 解析存档 JSON，旧版本就地升级。load 和 undo 都走这里：
 * undo 恢复的快照可能是升级前存的 v1。
 */
export function parseCampaign(json: string): Campaign | undefined {
  const data = JSON.parse(json) as Record<string, unknown>;
  if (data.version === 2) {
    const c = data as unknown as Campaign;
    // 待结算刚上线时只有攻击，存档里没有 kind
    const pending = c.initiative?.pending as (PendingRoll & { kind?: string }) | undefined;
    if (pending !== undefined && pending.kind === undefined) (pending as PendingAttack).kind = 'attack';
    return c;
  }
  if (data.version !== 1) return undefined;
  const { dungeonId, ...rest } = data;
  return {
    ...(rest as unknown as Campaign),
    version: 2,
    adventureId: String(dungeonId),
    // 旧团只会是单地城，包出来的模组只有 main 一章、场景 id 就是地城 id
    chapter: 'main',
    flags: [],
    leads: [],
    facts: [],
    firedTriggers: [],
    quests: {},
    npcs: {},
    knownSites: [String(dungeonId)],
    announced: [],
  };
}

export function pushCombatLedger(c: Campaign, text: string, seq?: number): void {
  if (c.initiative === undefined) return;
  const ledger = (c.initiative.ledger ??= []);
  ledger.push({ round: c.initiative.round, ...(seq !== undefined ? { seq } : {}), text });
  if (ledger.length > MAX_COMBAT_LEDGER) ledger.splice(0, ledger.length - MAX_COMBAT_LEDGER);
}

export function pushLog(c: Campaign, line: string): void {
  c.log.push(line);
  if (c.log.length > MAX_LOG) c.log.splice(0, c.log.length - MAX_LOG);
  pushCombatLedger(c, line);
}

export function findCharacter(c: Campaign, name: string): Character | undefined {
  const q = name.trim();
  const lower = q.toLowerCase();
  if (lower.length === 0) return undefined;
  const exact = c.characters.find((ch) => ch.name === q)
    ?? c.characters.find((ch) => ch.player === q && ch.kind === 'pc')
    ?? c.characters.find((ch) => ch.name.toLowerCase() === lower || ch.player?.trim().toLowerCase() === lower);
  if (exact !== undefined) return exact;
  // 「刻德温」能找到「刻德温 Kodwin」：按空格拆出的名字片段匹配，唯一命中才算
  const partial = c.characters.filter((ch) => ch.name.toLowerCase().split(/\s+/).includes(lower));
  return partial.length === 1 ? partial[0] : undefined;
}

export function requireCharacter(c: Campaign, name: string): Character {
  const found = findCharacter(c, name);
  if (found === undefined) {
    const names = c.characters.map((ch) => ch.name).join('、') || '（还没有角色）';
    throw new Error(`找不到角色「${name}」。现有：${names}`);
  }
  return found;
}

export interface CharacterInput {
  name: string;
  kind?: CharacterKind;
  player?: string;
  playerId?: string;
  companionStatus?: CompanionStatus;
  className?: string;
  level?: number;
  abilities?: Partial<Record<Ability, number>>;
  skills?: Skill[];
  expertise?: Skill[];
  saves?: Ability[];
  conditionImmunities?: string[];
  maxHp?: number;
  hp?: number;
  ac?: number;
  attackBonus?: number;
  damage?: string;
  initBonus?: number;
  speed?: number;
  flySpeed?: number;
  hover?: boolean;
  reactions?: ReactionDef[];
  weapons?: Weapon[];
  spells?: CardSpell[];
  notes?: string;
  traits?: string[];
  srd?: string;
  room?: string;
  hitDie?: string;
  npcId?: string;
  resources?: Record<string, Resource>;
}

/** 新建或更新角色卡；只覆盖传入的字段 */
export function upsertCharacter(c: Campaign, input: CharacterInput): { character: Character; created: boolean } {
  const name = input.name.trim();
  if (name.length === 0) throw new Error('角色名不能为空');
  const existing = c.characters.find((ch) => ch.name === name);
  const base: Character = existing ?? {
    name,
    kind: input.kind ?? 'pc',
    level: 1,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    skills: [],
    saves: [],
    hp: 10,
    maxHp: 10,
    tempHp: 0,
    ac: 10,
    conditions: [],
  };
  const next: Character = { ...base, abilities: { ...base.abilities } };
  if (input.kind !== undefined) next.kind = input.kind;
  if (input.player !== undefined) next.player = input.player;
  if (input.playerId !== undefined) next.playerId = input.playerId;
  if (input.companionStatus !== undefined) {
    if (next.kind !== 'npc') throw new Error('companion_status 只用于 NPC 盟友；PC 暂离请用 absent');
    if (input.companionStatus === 'following') delete next.companionStatus;
    else next.companionStatus = input.companionStatus;
  } else if (next.kind !== 'npc' && next.companionStatus !== undefined) {
    delete next.companionStatus;
  }
  if (input.className !== undefined) next.className = input.className;
  if (input.level !== undefined) next.level = clampInt(input.level, 1, 20);
  for (const ability of ABILITIES) {
    const score = input.abilities?.[ability];
    if (score !== undefined) next.abilities[ability] = clampInt(score, 1, 30);
  }
  if (input.skills !== undefined) next.skills = [...new Set(input.skills)];
  if (input.expertise !== undefined) {
    next.expertise = [...new Set(input.expertise)];
    // 专精以熟练为前提，补上免得两个列表对不上
    next.skills = [...new Set([...next.skills, ...next.expertise])];
  }
  if (input.saves !== undefined) next.saves = [...new Set(input.saves)];
  if (input.conditionImmunities !== undefined) {
    next.conditionImmunities = [...new Set(input.conditionImmunities.map(normalizeCondition).filter(Boolean))];
  }
  if (input.ac !== undefined) next.ac = clampInt(input.ac, 1, 30);
  if (input.maxHp !== undefined) {
    next.maxHp = clampInt(input.maxHp, 1, 999);
    if (existing === undefined && input.hp === undefined) next.hp = next.maxHp;
  }
  if (input.hp !== undefined) next.hp = clampInt(input.hp, 0, next.maxHp);
  if (input.attackBonus !== undefined) next.attackBonus = Math.trunc(input.attackBonus);
  if (input.damage !== undefined) next.damage = input.damage;
  if (input.initBonus !== undefined) next.initBonus = Math.trunc(input.initBonus);
  if (input.speed !== undefined) next.speed = clampInt(input.speed, 0, 300);
  if (input.flySpeed !== undefined) {
    const fs = clampInt(input.flySpeed, 0, 300);
    if (fs > 0) next.flySpeed = fs;
    else delete next.flySpeed;
  }
  if (input.hover !== undefined) {
    if (input.hover) next.hover = true;
    else delete next.hover;
  }
  if (input.reactions !== undefined) next.reactions = input.reactions;
  if (input.weapons !== undefined) next.weapons = input.weapons;
  if (input.spells !== undefined) next.spells = input.spells;
  if (input.notes !== undefined) next.notes = input.notes;
  if (input.traits !== undefined) next.traits = [...new Set(input.traits.map(normalizeTrait))];
  if (input.srd !== undefined) next.srd = input.srd;
  if (input.room !== undefined) next.room = input.room;
  if (input.hitDie !== undefined) next.hitDie = input.hitDie;
  if (input.npcId !== undefined) next.npcId = input.npcId;
  if (input.resources !== undefined) {
    next.resources = { ...next.resources };
    for (const [k, r] of Object.entries(input.resources)) {
      if (existing === undefined || next.resources[k] === undefined) next.resources[k] = { ...r };
    }
  }
  next.hp = Math.min(next.hp, next.maxHp);

  if (existing === undefined) c.characters.push(next);
  else c.characters[c.characters.indexOf(existing)] = next;
  return { character: next, created: existing === undefined };
}

export function removeCharacter(c: Campaign, name: string): Character {
  const ch = requireCharacter(c, name);
  if (isOut(ch)) recordNpcDeath(c, ch);
  breakConcentration(c, ch.name, '角色离场');
  notifyConcentrationTargetDown(c, ch);
  c.characters = c.characters.filter((x) => x !== ch);
  if (c.initiative !== undefined) removeFromInitiative(c.initiative, ch.name);
  if (c.hexbladeCurses !== undefined) {
    c.hexbladeCurses = c.hexbladeCurses.filter((x) => x.caster !== ch.name && x.target !== ch.name);
    if (c.hexbladeCurses.length === 0) delete c.hexbladeCurses;
  }
  return ch;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function setCondition(ch: Character, condition: string, on: boolean): boolean {
  const has = ch.conditions.includes(condition);
  if (on && !has) ch.conditions.push(condition);
  if (!on && has) ch.conditions = ch.conditions.filter((x) => x !== condition);
  return has !== on;
}

export interface HpChange {
  name: string;
  before: number;
  after: number;
  maxHp: number;
  tempHp: number;
  /** 伤害被临时 HP 吸收的部分 */
  absorbed: number;
  /** 新增的状态，如 昏迷、死亡 */
  events: string[];
  /** 受击后仍在维持专注时，这次伤害要求的豁免；不写入角色或团档。 */
  concentrationDc?: number;
  /** 怪物/NPC：给玩家听的伤势描述（不报数字） */
  wound?: string;
}

/** 怪物伤势的口头描述：DM 只说这个，不报 HP 数字 */
export function woundLabel(ch: Character): string {
  if (ch.conditions.includes('死亡')) return '死了';
  if (ch.hp === 0) return '倒下';
  const ratio = ch.hp / ch.maxHp;
  if (ratio >= 1) return '毫发无伤';
  if (ratio > 0.5) return '受了点伤';
  if (ratio > 0.25) return '伤得不轻';
  return '摇摇欲坠';
}

function woundOf(ch: Character): { wound?: string } {
  return ch.kind === 'pc' ? {} : { wound: woundLabel(ch) };
}

export interface DamageOptions {
  /** 重击：不死坚韧不生效 */
  crit?: boolean;
  /** 伤害类型，如 光耀 */
  damageType?: string;
  roller?: Roller;
}

export const UNDEAD_FORTITUDE = '不死坚韧';

/**
 * 伤害：先扣临时 HP；怪物到 0 死亡，PC 到 0 昏迷，溢出伤害 ≥ 最大 HP 即死。
 * 有「不死坚韧」的怪物被打到 0 时（非光耀、非重击）自动过体质豁免 DC 5+伤害，成功留 1 HP。
 */
export function applyDamage(c: Campaign, name: string, amount: number, options: DamageOptions = {}): HpChange {
  const ch = requireCharacter(c, name);
  if (ch.conditions.includes('死亡')) throw new Error(`${ch.name} 已经死亡`);
  const dmg = Math.max(0, Math.trunc(amount));
  const before = ch.hp;
  const absorbed = Math.min(ch.tempHp, dmg);
  ch.tempHp -= absorbed;
  const rest = dmg - absorbed;
  const overflow = rest - ch.hp;
  ch.hp = Math.max(0, ch.hp - rest);
  const events: string[] = [];
  if (dmg > 0) {
    for (const effect of ongoingEffects(ch)) {
      if (!effect.endOnDamage) continue;
      removeOngoingEffect(c, ch, effect.id);
      events.push(`受伤解除「${effect.name}」`);
    }
  }
  if (ch.hp === 0 && before > 0 && rest > 0 && ch.kind !== 'pc' && ch.traits?.includes(UNDEAD_FORTITUDE)
    && options.crit !== true && !/光耀|radiant/i.test(options.damageType ?? '')) {
    const dc = 5 + rest;
    const save = rollD20(abilityModifier(ch.abilities.con), 'none', options.roller ?? cryptoRoller);
    if (save.total >= dc) {
      ch.hp = 1;
      events.push(`${UNDEAD_FORTITUDE}：体质豁免 ${save.detail} 成功，撑住了`);
    } else {
      events.push(`${UNDEAD_FORTITUDE}：体质豁免 ${save.detail} 失败`);
    }
  }
  if (ch.hp === 0 && rest > 0) {
    const effMax = effectiveMaxHp(ch);
    if (ch.kind !== 'pc' || overflow >= effMax) {
      if (setCondition(ch, '死亡', true)) events.push('死亡');
    } else if (before > 0) {
      if (setCondition(ch, '昏迷', true)) events.push('昏迷');
      setCondition(ch, '倒地', true);
      setCondition(ch, '稳定', false);
    } else {
      // 已经昏迷的 PC 再受伤：记一次死亡豁免失败（重击由调用方再记一次）
      events.push(...addDeathFailures(ch, 1));
    }
  }
  let concentrationDc: number | undefined;
  if (dmg > 0) {
    if (ch.hp === 0 || isIncapacitated(ch)) {
      events.push(...breakConcentration(c, ch.name, '失去行动能力'));
    } else {
      const spells = concentratingSpellNames(c, ch.name);
      if (spells.length > 0) {
        concentrationDc = Math.max(10, Math.floor(dmg / 2));
        events.push(`专注受击（${spells.join('、')}）：需过体质专注豁免 DC ${concentrationDc}`);
      }
    }
  }
  if (ch.hp === 0 && before > 0) {
    events.push(...notifyConcentrationTargetDown(c, ch));
  }
  pushLog(c, `${ch.name} 受到 ${dmg} 点伤害（${hpTrail(ch, before)}）${events.length > 0 ? `，${events.join('、')}` : ''}`);
  if (ch.hp === 0 || isIncapacitated(ch)) {
    const crashLines = checkAllAirborneCrashes(c, options.roller ?? cryptoRoller);
    events.push(...crashLines);
  }
  if (events.includes('死亡') && c.hexbladeCurses !== undefined) {
    const triggered = c.hexbladeCurses.filter((x) => x.target === ch.name);
    c.hexbladeCurses = c.hexbladeCurses.filter((x) => x.target !== ch.name);
    if (c.hexbladeCurses.length === 0) delete c.hexbladeCurses;
    for (const curse of triggered) {
      const caster = findCharacter(c, curse.caster);
      if (caster !== undefined && !isOut(caster) && caster.hp > 0 && canReact(caster)) {
        const healed = heal(c, caster.name, hexbladeKillHeal(caster));
        const gained = healed.after - healed.before;
        events.push(gained > 0 ? `咒剑诅咒：${caster.name} 恢复 ${gained} HP` : `咒剑诅咒触发（${caster.name} HP 已满）`);
      }
    }
  }
  return { name: ch.name, before, after: ch.hp, maxHp: ch.maxHp, tempHp: ch.tempHp, absorbed, events,
    ...(concentrationDc === undefined ? {} : { concentrationDc }), ...woundOf(ch) };
}

/** 日志里的血量变化：日志会进团况的「最近」，怪物只写伤势词，免得数字被说出去 */
function hpTrail(ch: Character, before: number): string {
  return ch.kind === 'monster' ? woundLabel(ch) : `${before}→${ch.hp}/${ch.maxHp}`;
}

/** 治疗：不超过有效最大 HP（力竭 4 级减半）；从 0 恢复时清掉昏迷/稳定 */
export function heal(c: Campaign, name: string, amount: number): HpChange {
  const ch = requireCharacter(c, name);
  if (ch.conditions.includes('死亡')) throw new Error(`${ch.name} 已经死亡，普通治疗无效`);
  const before = ch.hp;
  const effMax = effectiveMaxHp(ch);
  ch.hp = Math.min(effMax, ch.hp + Math.max(0, Math.trunc(amount)));
  const events: string[] = [];
  if (before === 0 && ch.hp > 0) {
    removeActiveState(ch, '昏迷');
    removeActiveState(ch, '稳定');
    delete ch.deathSaves;
    events.push('苏醒');
  }
  pushLog(c, `${ch.name} 恢复 ${ch.hp - before} 点 HP（${hpTrail(ch, before)}）`);
  return { name: ch.name, before, after: ch.hp, maxHp: ch.maxHp, tempHp: ch.tempHp, absorbed: 0, events, ...woundOf(ch) };
}

/** 临时 HP 不叠加，取较大值 */
export function grantTempHp(c: Campaign, name: string, amount: number): HpChange {
  const ch = requireCharacter(c, name);
  ch.tempHp = Math.max(ch.tempHp, Math.max(0, Math.trunc(amount)));
  return { name: ch.name, before: ch.hp, after: ch.hp, maxHp: ch.maxHp, tempHp: ch.tempHp, absorbed: 0, events: [] };
}

/**
 * 检查单个处于高空（z > 0）的角色是否因陷入倒地/失能/速度归 0 或失去飞行能力而坠机（PHB 高空坠落规则）：
 * - 若具备 `hover: true` 或仍维持未死亡的 `飞行术`，可悬浮免于坠落；
 * - 否则 `z` 归 0，每 10 尺掷 1d6（上限 20d6）钝击伤害，若受到至少 1 点坠落伤害则陷入「倒地」。
 */
export function checkAirborneCrash(
  c: Campaign,
  ch: Character,
  roller: Roller = cryptoRoller,
  globalEffects?: Record<string, CustomEffectDef>,
): string[] {
  const state = c.initiative;
  if (state === undefined) return [];
  const cell = state.positions?.[ch.name];
  if (cell === undefined || cell.room !== roomOf(c, ch) || (cell.z ?? 0) <= 0) return [];

  const fallFeet = cell.z!;
  if (ch.conditions.includes('死亡')) {
    delete cell.z;
    const msg = `${ch.name} 从 ${fallFeet} 尺高空坠落地面`;
    pushLog(c, msg);
    return [msg];
  }

  const magicalAloft = hasCondition(ch, '飞行术');
  const canHover = ch.hover === true || magicalAloft;
  if (canHover) return [];

  const lostFlight = (ch.flySpeed ?? 0) <= 0;
  const incapacitatedOrPinned = hasCondition(ch, '倒地')
    || effectiveStates(ch).some((s) => ZERO_SPEED_CONDITIONS.has(s.name) || INCAPACITATING_CONDITIONS.has(s.name))
    || ongoingEffects(ch).some((effect) => effect.zeroSpeed)
    || exhaustionLevel(ch) >= 5;
  if (!lostFlight && !incapacitatedOrPinned) return [];

  // 先落地归 0，防止后续 applyDamage 再次触发递归坠机
  delete cell.z;
  const diceCount = Math.min(20, Math.floor(fallFeet / 10));
  if (diceCount <= 0) {
    const msg = `【高空坠落】${ch.name} 从 ${fallFeet} 尺高度坠地（未满 10 尺无坠落伤害）`;
    pushLog(c, msg);
    return [msg];
  }

  const rolled = rollExpression(`${diceCount}d6`, roller);
  const defMod = computeDefenseStateMod(ch, '钝击', undefined, c, globalEffects);
  let finalDmg = rolled.total;
  if (defMod.defense === 'immune') finalDmg = 0;
  else if (defMod.defense === 'resistant') finalDmg = Math.floor(finalDmg / 2);
  else if (defMod.defense === 'vulnerable') finalDmg *= 2;

  let dmgTail = `${rolled.detail}${defMod.defense !== undefined ? `（${DEFENSE_NAMES[defMod.defense]}→${finalDmg}）` : ''} 钝击`;
  if (finalDmg > 0) {
    const change = applyDamage(c, ch.name, finalDmg, { damageType: '钝击', roller });
    const trail = ch.kind === 'monster' ? (change.wound ?? woundLabel(ch)) : `HP ${change.before}→${change.after}/${change.maxHp}`;
    dmgTail += `（${trail}）`;
    if (!ch.conditions.includes('死亡') && !hasCondition(ch, '倒地')) {
      upsertActiveState(c, ch, { name: '倒地' });
      dmgTail += '，摔成倒地';
    }
  }
  const msg = `【高空坠落】${ch.name} 从 ${fallFeet} 尺高空坠落地面：${dmgTail}`;
  pushCombatLedger(c, msg);
  return [msg];
}

export function checkAllAirborneCrashes(
  c: Campaign,
  roller: Roller = cryptoRoller,
  globalEffects?: Record<string, CustomEffectDef>,
): string[] {
  if (c.initiative?.positions === undefined) return [];
  const out: string[] = [];
  for (const name of Object.keys(c.initiative.positions)) {
    const ch = findCharacter(c, name);
    if (ch !== undefined) out.push(...checkAirborneCrash(c, ch, roller, globalEffects));
  }
  return out;
}

export interface ChangeConditionOptions extends Pick<ActiveState, 'saveDc' | 'slotLevel' | 'acBonus' | 'hitBonus'> {
  source?: string;
  concentration?: boolean;
  replaceConcentration?: boolean;
  roundsLeft?: number;
  expires?: ActiveState['expires'];
  ongoing?: ActiveOngoingEffect;
  roller?: Roller;
  globalEffects?: Record<string, CustomEffectDef>;
}

export function changeCondition(
  c: Campaign,
  name: string,
  condition: string,
  on: boolean,
  options: ChangeConditionOptions = {},
): Character {
  const ch = requireCharacter(c, name);
  const norm = normalizeCondition(condition);
  if (norm.length === 0) throw new Error('状态名不能为空');
  if (!on && norm === '死亡' && ch.conditions.includes('死亡')) {
    throw new Error('不能手动解除「死亡」。判错了要回滚用 dnd_undo；不死坚韧之类的特性工具会自动处理');
  }
  if (on) {
    const had = ch.conditions.some((x) => normalizeCondition(x) === norm);
    const { broken, immune } = upsertActiveState(
      c,
      ch,
      {
        name: condition,
        ...(norm === '闪避' ? { source: ch.name, expires: 'start_of_source_turn' as const } : {}),
        ...(options.source !== undefined ? { source: options.source } : {}),
        ...(options.concentration !== undefined ? { concentration: options.concentration } : {}),
        ...(options.roundsLeft !== undefined ? { roundsLeft: options.roundsLeft } : {}),
        ...(options.expires !== undefined ? { expires: options.expires } : {}),
        ...(options.ongoing !== undefined ? { ongoing: options.ongoing } : {}),
        ...(options.saveDc !== undefined ? { saveDc: options.saveDc } : {}),
        ...(options.slotLevel !== undefined ? { slotLevel: options.slotLevel } : {}),
        ...(options.acBonus !== undefined ? { acBonus: options.acBonus } : {}),
        ...(options.hitBonus !== undefined ? { hitBonus: options.hitBonus } : {}),
      },
      { replaceConcentration: options.replaceConcentration, globalEffects: options.globalEffects },
    );
    if (immune) return ch;
    if (!had) pushLog(c, `${ch.name} 获得状态「${norm}」`);
    for (const line of broken) pushLog(c, line);
    checkAllAirborneCrashes(c, options.roller ?? cryptoRoller, options.globalEffects);
  } else {
    for (const effect of ongoingEffects(ch)) {
      if (normalizeCondition(effect.name) !== norm) continue;
      removeOngoingEffect(c, ch, effect.id);
      pushLog(c, `${ch.name} 解除「${effect.name}」`);
    }
    const removed = removeActiveState(ch, condition);
    syncConcentrationAfterRemoval(c, ch, removed);
    if (
      removed.length === 0
      && (norm === '专注' || norm.toLowerCase() === 'concentration' || (ch.concentrationState !== undefined && normalizeCondition(ch.concentrationState.name) === norm))
    ) {
      for (const line of breakConcentration(c, ch.name, '主动解除专注')) pushLog(c, line);
    }
    for (const r of removed) pushLog(c, `${ch.name} 解除状态「${r}」`);
    checkAllAirborneCrashes(c, options.roller ?? cryptoRoller, options.globalEffects);
  }
  return ch;
}

export function applyEffectConditions(
  c: Campaign, ch: Character, conditions: readonly string[],
  options: Omit<ChangeConditionOptions, 'ongoing'> & { ongoing?: PreparedOngoingEffect },
): { applied: string[]; immune: string[] } {
  const unique = [...new Map(conditions.map((name) => [normalizeCondition(name), name])).values()];
  const { ongoing, ...stateOptions } = options;
  const immune = unique.filter((name) => immuneToCondition(ch, name));
  if (ongoing?.requiresCondition !== undefined && immuneToCondition(ch, ongoing.requiresCondition)) {
    return { applied: [], immune };
  }
  const applied = unique.filter((name) => !immune.includes(name));
  const instance = ongoing === undefined ? undefined : {
    id: randomUUID(), name: ongoing.name, repeatSave: ongoing.repeatSave, endOnDamage: ongoing.endOnDamage,
    wakeAsAction: ongoing.wakeAsAction, zeroSpeed: ongoing.zeroSpeed,
  };
  for (const name of applied) {
    changeCondition(c, ch.name, name, true, { ...stateOptions, ongoing: instance });
  }
  return { applied, immune };
}

export function wakeFromEffect(c: Campaign, actor: Character, target: Character, effectName?: string): string {
  assertNoPending(c, '唤醒');
  if (actor === target || actor.hp <= 0 || roomOf(c, actor) !== roomOf(c, target)) throw new Error('必须由同场的另一名生物唤醒');
  const from = cellOf(c, actor), to = cellOf(c, target);
  if (from !== undefined && to !== undefined && Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y), Math.abs((from.z ?? 0) - (to.z ?? 0)) / 5) > 1) {
    throw new Error('必须进入目标 5 尺内才能唤醒');
  }
  const matches = ongoingEffects(target).filter((effect) => effect.wakeAsAction
    && (effectName === undefined || normalizeCondition(effect.name) === normalizeCondition(effectName)));
  if (matches.length !== 1) throw new Error(matches.length === 0 ? '目标没有可用动作唤醒的效果' : '目标有多个可唤醒效果，请指定效果名');
  const effect = matches[0]!;
  removeOngoingEffect(c, target, effect.id);
  const line = `${actor.name} 用主动作唤醒 ${target.name}，解除「${effect.name}」`;
  pushLog(c, line);
  return line;
}

// ── 死亡豁免 ──

function addDeathFailures(ch: Character, n: number): string[] {
  const saves = ch.deathSaves ?? { successes: 0, failures: 0 };
  saves.failures = Math.min(3, saves.failures + n);
  ch.deathSaves = saves;
  setCondition(ch, '稳定', false);
  if (saves.failures >= 3) {
    setCondition(ch, '死亡', true);
    return [`死亡豁免失败 ${saves.failures}/3，死亡`];
  }
  return [`死亡豁免失败 ${saves.failures}/3`];
}

/** 额外记死亡豁免失败（如倒地时被重击） */
export function recordDeathFailures(c: Campaign, name: string, n: number): string[] {
  const ch = requireCharacter(c, name);
  const events = addDeathFailures(ch, n);
  pushLog(c, `${ch.name} ${events.join('，')}`);
  return events;
}

export interface DeathSaveResult {
  name: string;
  detail: string;
  successes: number;
  failures: number;
  outcome: 'success' | 'failure' | 'stable' | 'dead' | 'revived';
}

/** 0 HP 的 PC 掷死亡豁免：≥10 成功，天然 1 记两次失败，天然 20 回到 1 HP */
export function deathSave(c: Campaign, name: string, roller: Roller = cryptoRoller): DeathSaveResult {
  const ch = requireCharacter(c, name);
  if (ch.kind !== 'pc' || ch.hp > 0) throw new Error(`${ch.name} 不需要死亡豁免（只有 0 HP 的 PC 才掷）`);
  if (ch.conditions.includes('死亡')) throw new Error(`${ch.name} 已经死亡`);
  if (ch.conditions.includes('稳定')) throw new Error(`${ch.name} 已经稳定，不再掷死亡豁免`);
  const roll = rollD20(0, 'none', roller);
  const saves = ch.deathSaves ?? { successes: 0, failures: 0 };
  ch.deathSaves = saves;
  let outcome: DeathSaveResult['outcome'];
  if (roll.natural === 20) {
    ch.hp = 1;
    setCondition(ch, '昏迷', false);
    setCondition(ch, '倒地', true);
    delete ch.deathSaves;
    outcome = 'revived';
  } else if (roll.natural === 1) {
    addDeathFailures(ch, 2);
    outcome = ch.conditions.includes('死亡') ? 'dead' : 'failure';
  } else if (roll.total >= 10) {
    saves.successes++;
    if (saves.successes >= 3) {
      setCondition(ch, '稳定', true);
      delete ch.deathSaves;
      outcome = 'stable';
    } else {
      outcome = 'success';
    }
  } else {
    addDeathFailures(ch, 1);
    outcome = ch.conditions.includes('死亡') ? 'dead' : 'failure';
  }
  const label = { success: '成功', failure: '失败', stable: '三次成功，稳定', dead: '死亡', revived: '天然 20，恢复 1 HP 醒来' }[outcome];
  pushLog(c, `${ch.name} 死亡豁免 ${roll.natural}：${label}`);
  return {
    name: ch.name,
    detail: roll.detail,
    successes: ch.deathSaves?.successes ?? (outcome === 'stable' ? 3 : 0),
    failures: ch.deathSaves?.failures ?? (outcome === 'dead' ? 3 : 0),
    outcome,
  };
}

// ── 先攻 ──

export function isOut(ch: Character): boolean {
  return ch.conditions.includes('死亡');
}

export function isAbsent(ch: Character): boolean {
  return ch.kind === 'pc' && ch.absent === true;
}

/**
 * 暂时移出队伍或归队（仅 PC）。
 * 暂离时保留角色卡、HP、资源与物品，只在当前开团中把它从在队成员、房间位置、先攻表、战场站位与待结算反应中移出；
 * 归队时放回队伍当前主房间（战斗中如需参战另走 dnd_initiative join）。
 */
export function setCharacterAbsent(
  c: Campaign,
  name: string,
  absent: boolean,
  options: { silent?: boolean } = {},
): { character: Character; changed: boolean; leftCombat: boolean } {
  const ch = requireCharacter(c, name);
  if (ch.kind !== 'pc') throw new Error(`只有 PC 支持暂离/归队（${ch.name} 不是 PC）`);
  if (absent) {
    const inOrder = c.initiative?.order.some((e) => e.name === ch.name) ?? false;
    if (ch.absent === true && !inOrder) {
      return { character: ch, changed: false, leftCombat: false };
    }
    const prevAbsent = ch.absent === true;
    ch.absent = true;
    delete ch.delegated;
    let leftCombat = false;
    const state = c.initiative;
    if (state !== undefined) {
      const idx = state.order.findIndex((e) => e.name === ch.name);
      if (idx !== -1) {
        leftCombat = true;
        state.order.splice(idx, 1);
        delete state.positions?.[ch.name];
        delete state.moved?.[ch.name];
        if (state.surprised !== undefined) {
          state.surprised = state.surprised.filter((n) => n !== ch.name);
          if (state.surprised.length === 0) delete state.surprised;
        }
        if (state.dashed !== undefined) {
          state.dashed = state.dashed.filter((n) => n !== ch.name);
          if (state.dashed.length === 0) delete state.dashed;
        }
        if (state.disengaged !== undefined) {
          state.disengaged = state.disengaged.filter((n) => n !== ch.name);
          if (state.disengaged.length === 0) delete state.disengaged;
        }
        if (state.fightingSpirit !== undefined) {
          state.fightingSpirit = state.fightingSpirit.filter((n) => n !== ch.name);
          if (state.fightingSpirit.length === 0) delete state.fightingSpirit;
        }
        if (state.shielded !== undefined) {
          state.shielded = state.shielded.filter((n) => n !== ch.name);
          if (state.shielded.length === 0) delete state.shielded;
        }
        if (state.reacted !== undefined) {
          state.reacted = state.reacted.filter((n) => n !== ch.name);
          if (state.reacted.length === 0) delete state.reacted;
        }
        if (idx < state.turn) {
          state.turn--;
        } else if (idx === state.turn) {
          if (state.order.length === 0) {
            state.turn = 0;
          } else {
            if (state.turn >= state.order.length) {
              state.turn = 0;
              state.round++;
              delete state.surprised;
            }
            delete state.moved;
            delete state.dashed;
            delete state.disengaged;
            delete state.fightingSpirit;
            delete state.zoneTriggered;
            delete state.auraTriggered;
            state.turnState = { actor: state.order[state.turn]!.name, attacks: 0 };
          }
        }
      }
      const win = reactionWindow(c);
      if (
        win !== undefined
        && win.reactors.some((r) => r.character === ch.name)
        && !win.used.some((u) => u.by === ch.name)
        && !win.declined.includes(ch.name)
      ) {
        win.declined.push(ch.name);
        win.claimed = win.claimed.filter((r) => r.character !== ch.name);
      }
    }
    if (!options.silent && (!prevAbsent || leftCombat)) {
      pushLog(c, `${ch.name} 暂时移出队伍${leftCombat ? '（已移出先攻表）' : ''}`);
    }
    return { character: ch, changed: !prevAbsent || leftCombat, leftCombat };
  }
  if (ch.absent !== true) {
    return { character: ch, changed: false, leftCombat: false };
  }
  delete ch.absent;
  ch.room = c.currentRoom;
  if (!options.silent) pushLog(c, `${ch.name} 归队`);
  return { character: ch, changed: true, leftCombat: false };
}

/** 将所有暂离 PC 恢复为在队状态（用于收团、续团前重置出勤） */
export function restoreAllAbsent(c: Campaign): string[] {
  const restored: string[] = [];
  for (const ch of c.characters) {
    if (ch.kind === 'pc' && ch.absent === true) {
      delete ch.absent;
      if (ch.room !== undefined) ch.room = c.currentRoom;
      restored.push(ch.name);
    }
  }
  return restored;
}

export function isDmDelegated(ch: Character): boolean {
  return ch.kind === 'pc' && ch.delegated?.mode === 'dm';
}

export function effectiveControllerId(ch: Character): string | undefined {
  if (ch.kind !== 'pc' || isDmDelegated(ch)) return undefined;
  if (ch.delegated?.mode === 'player' && ch.delegated.playerId !== undefined) return ch.delegated.playerId;
  return ch.playerId;
}

/** 该角色此刻是否允许由指定 openid 操作：原绑定玩家本人与受托托管玩家都认 */
export function isControlledBy(ch: Character, senderId: string | undefined): boolean {
  if (ch.kind !== 'pc' || senderId === undefined) return false;
  if (ch.delegated?.mode === 'player' && ch.delegated.playerId === senderId) return true;
  return ch.playerId !== undefined && ch.playerId === senderId;
}

export function delegationTag(ch: Character): string | undefined {
  if (ch.kind !== 'pc' || ch.delegated === undefined) return undefined;
  if (ch.delegated.mode === 'dm') return 'DM托管';
  if (ch.delegated.mode === 'player' && ch.delegated.playerId !== undefined) {
    return `托管→${ch.delegated.player ?? ch.delegated.playerId}`;
  }
  return undefined;
}

function syncWindowDelegation(win: ReactionWindow | undefined, characterName: string, dmManaged: boolean): void {
  if (win === undefined) return;
  for (const r of win.reactors) {
    if (r.character !== characterName) continue;
    if (dmManaged) r.dmManaged = true;
    else delete r.dmManaged;
  }
}

export type DelegationTarget =
  | { mode: 'none' }
  | { mode: 'dm' }
  | { mode: 'player'; playerId: string; player?: string };

/**
 * 设置或解除 PC 的临时托管状态：
 * - mode='player': 保留原 `playerId`，额外授权受托玩家控制、反应与查看法术；若目标就是原主人自己则等效解除托管；
 * - mode='dm': 由 DM 临时接管，保留反应窗口（`dmManaged=true`）使 DM 可直接代为结算以免 AFK 丢反应；
 * - mode='none': 结束托管，恢复原玩家独占控制；
 * 若当前正处于待结算/借机窗口中，立即同步对应 `ReactorOption.dmManaged`，即时解卡。
 */
export function setCharacterDelegation(
  c: Campaign,
  name: string,
  target: DelegationTarget,
  now = Date.now(),
): { character: Character; changed: boolean } {
  const ch = requireCharacter(c, name);
  if (ch.kind !== 'pc') throw new Error(`只有 PC 可以设置托管：「${ch.name}」不是 PC`);
  if (target.mode !== 'none' && isAbsent(ch)) {
    throw new Error(`${ch.name} 已暂离队伍，如需托管参战请先传 absent=false 归队`);
  }
  const normalized: DelegationTarget = target.mode === 'player' && target.playerId === ch.playerId
    ? { mode: 'none' }
    : target;

  if (normalized.mode === 'none') {
    const had = ch.delegated !== undefined;
    if (had) {
      delete ch.delegated;
      pushLog(c, `${ch.name} 结束托管，恢复原玩家控制`);
    }
    syncWindowDelegation(c.initiative?.pending, ch.name, false);
    syncWindowDelegation(c.initiative?.movement, ch.name, false);
    syncWindowDelegation(c.pending, ch.name, false);
    return { character: ch, changed: had };
  }

  if (normalized.mode === 'dm') {
    const unchanged = ch.delegated?.mode === 'dm';
    ch.delegated = { mode: 'dm', since: now };
    syncWindowDelegation(c.initiative?.pending, ch.name, true);
    syncWindowDelegation(c.initiative?.movement, ch.name, true);
    syncWindowDelegation(c.pending, ch.name, true);
    if (!unchanged) pushLog(c, `${ch.name} 改为 DM 托管`);
    return { character: ch, changed: !unchanged };
  }

  const unchanged = ch.delegated?.mode === 'player'
    && ch.delegated.playerId === normalized.playerId
    && ch.delegated.player === normalized.player;
  ch.delegated = {
    mode: 'player',
    playerId: normalized.playerId,
    ...(normalized.player !== undefined ? { player: normalized.player } : {}),
    since: now,
  };
  syncWindowDelegation(c.initiative?.pending, ch.name, false);
  syncWindowDelegation(c.initiative?.movement, ch.name, false);
  syncWindowDelegation(c.pending, ch.name, false);
  if (!unchanged) pushLog(c, `${ch.name} 托管给 ${normalized.player ?? normalized.playerId}`);
  return { character: ch, changed: !unchanged };
}

/** 清除全部 PC 的临时托管（用于停团、续团前重置） */
export function clearAllDelegations(c: Campaign): string[] {
  const cleared: string[] = [];
  for (const ch of c.characters) {
    if (ch.kind === 'pc' && ch.delegated !== undefined) {
      delete ch.delegated;
      cleared.push(ch.name);
    }
  }
  return cleared;
}

/**
 * 具名 NPC 的卡一删，npcAlive 就退回去看 campaign.npcs，默认算活着：格罗尔和维瑞丝死后都被当成活人，
 * 房间照旧列出他们。删卡前把死讯记下来。
 */
function recordNpcDeath(c: Campaign, ch: Character): void {
  if (ch.npcId === undefined) return;
  c.npcs[ch.npcId] = { ...c.npcs[ch.npcId], alive: false };
}

/** 角色所在房间：暂离队伍的 PC 不在任何房间；怪物看自己的 room；PC/NPC 没单独移动过时跟着队伍主位置 */
export function roomOf(c: Campaign, ch: Character): string | undefined {
  if (isAbsent(ch)) return undefined;
  return ch.kind === 'monster' ? ch.room : (ch.room ?? c.currentRoom);
}

/** 某房间里参与战斗的角色（默认队伍主位置）：在场活着的 PC/NPC + 本房间活着的怪物 */
export function combatants(c: Campaign, room = c.currentRoom): Character[] {
  return c.characters.filter((ch) => !isOut(ch) && !isAbsent(ch) && roomOf(c, ch) === room);
}

export function initBonusOf(ch: Character): number {
  return ch.initBonus ?? abilityModifier(ch.abilities.dex);
}

export interface InitiativeRoll {
  name: string;
  init: number;
  detail: string;
}

/**
 * 为参战者掷先攻并排序；names 省略时取 room（默认队伍主位置）里的 combatants()。
 * `bonus` 是开战时就已生效的额外先攻值（灵敏之赐 1d8、警觉 +5、状态加成），按角色名给骰子表达式，
 * 由这里掷进去——否则「d20 + 敏调」的半成品会被当成最终结果，玩家事后发现少算了也只能认。
 */
export interface StartInitiativeOptions {
  /** 梦境/幻境/切磋演练模式：保存完整战前快照，战斗结束时自动恢复角色状态与房间场地图 */
  rehearsal?: boolean;
  /** 演练专用临时生命上限（仅 rehearsal=true 时生效，快照先保存真实数值） */
  rehearsalHp?: Record<string, number>;
  /** 演练专用临时怪物名单（结束时自动移除角色卡） */
  temporaryMonsters?: string[];
}

export function startInitiative(
  c: Campaign, roller: Roller = cryptoRoller, names?: string[], room?: string, bonus: Record<string, string> = {},
  surprisedNames: string[] = [], options: StartInitiativeOptions = {},
): InitiativeRoll[] {
  const members = names === undefined || names.length === 0 ? combatants(c, room) : names.map((n) => requireCharacter(c, n));
  if (members.length === 0) throw new Error('没有可以参战的角色');
  const absentMembers = members.filter(isAbsent);
  if (absentMembers.length > 0) {
    throw new Error(`${absentMembers.map((ch) => ch.name).join('、')} 本次未签到、已暂时移出队伍，不能拉入先攻（等本人点「签到」自动归队，或确认本人到场后用 dnd_character update absent=false 归队）`);
  }
  // 掷骰前查完：名字写错时什么都还没掷
  const surprised = [...new Set(surprisedNames.map((n) => requireCharacter(c, n).name))];
  const outsider = surprised.filter((n) => !members.some((m) => m.name === n));
  if (outsider.length > 0) throw new Error(`surprised 里的 ${outsider.join('、')} 不在参战者里`);
  const rehearsal = options.rehearsal === true;
  if (!rehearsal && (options.rehearsalHp !== undefined || options.temporaryMonsters !== undefined)) {
    throw new Error('rehearsal_hp / temporary_monsters 只在 rehearsal=true 的演练战斗中使用');
  }
  const tempMonsters = rehearsal
    ? [...new Set((options.temporaryMonsters ?? []).map((n) => requireCharacter(c, n).name))]
    : [];
  const hpOverrides = rehearsal && options.rehearsalHp !== undefined
    ? Object.entries(options.rehearsalHp).map(([rawName, hp]) => ({ ch: requireCharacter(c, rawName), hp: clampInt(hp, 1, 999) }))
    : [];
  const rehearsalSnapshot: RehearsalSnapshot | undefined = rehearsal
    ? structuredClone({
      characters: c.characters,
      ...(c.battlemaps !== undefined ? { battlemaps: c.battlemaps } : {}),
      npcs: c.npcs,
      spawned: c.spawned,
      ...(c.enteredFrom !== undefined ? { enteredFrom: c.enteredFrom } : {}),
      ...(tempMonsters.length > 0 ? { temporaryMonsters: tempMonsters } : {}),
    })
    : undefined;
  for (const { ch, hp } of hpOverrides) {
    ch.maxHp = hp;
    ch.hp = hp;
  }
  const rolls = members.map((ch) => {
    const r = rollD20(initBonusOf(ch), 'none', roller);
    const expr = bonus[ch.name];
    const extra = expr === undefined ? undefined : rollExpression(expr, roller);
    const flat = initBonusOf(ch) + (extra?.total ?? 0);
    return {
      name: ch.name,
      init: r.total + (extra?.total ?? 0),
      detail: extra === undefined ? r.detail : `${r.detail} + ${expr} ${extra.detail}`,
      tiebreak: flat,
    };
  });
  rolls.sort((a, b) => b.init - a.init || b.tiebreak - a.tiebreak);
  c.initiative = {
    battleId: randomUUID(),
    round: 1,
    turn: 0,
    order: rolls.map(({ name, init }) => ({ name, init })),
    allParticipants: rolls.map(({ name }) => name),
    ...(rolls[0] !== undefined ? { turnState: { actor: rolls[0].name, attacks: 0 } } : {}),
    ...(rehearsal ? { rehearsal: true, rehearsalSnapshot } : {}),
  };
  if (surprised.length > 0) c.initiative.surprised = surprised;
  if (!rehearsal) c.begun = true;
  pushLog(c, `进入${rehearsal ? '演练' : ''}战斗：${rolls.map((r) => `${r.name}(${r.init})`).join(' > ')}${surprised.length > 0 ? `；受惊：${surprised.join('、')}` : ''}`);
  return rolls.map(({ name, init, detail }) => ({ name, init, detail }));
}

export function isSurprised(c: Campaign, name: string): boolean {
  return c.initiative?.surprised?.includes(name) ?? false;
}

/** 此刻为什么不能反应；能反应时返回 undefined */
export function reactionBlocked(c: Campaign, name: string): string | undefined {
  if (isSurprised(c, name)) return `${name} 受惊，自己第一个回合过去之前不能反应`;
  const ch = findCharacter(c, name);
  if (ch !== undefined && hasCondition(ch, '迟缓术')) return `${name} 受迟缓术影响，无法执行反应`;
  if (c.initiative?.reacted?.includes(name) === true) return `${name} 的反应已经用过了，要到他下个回合开始才恢复`;
  return undefined;
}

export function spendReaction(c: Campaign, name: string): void {
  const ch = requireCharacter(c, name);
  const blocked = reactionBlocked(c, ch.name);
  if (blocked !== undefined) throw new Error(blocked);
  if (!canReact(ch)) throw new Error(`${ch.name} 现在做不了反应`);
  if (c.initiative === undefined) throw new Error('反应名额只在战斗中记账');
  c.initiative.reacted = [...new Set([...(c.initiative.reacted ?? []), ch.name])];
  c.initiative.rebrief = true;
}

/** 退回本轮误扣的反应名额（1/1），供改判退费或未最终受伤自动回退使用 */
export function restoreReaction(c: Campaign, name: string): boolean {
  const ch = requireCharacter(c, name);
  if (c.initiative === undefined) throw new Error('反应名额只在战斗中记账');
  const had = c.initiative.reacted?.includes(ch.name) === true;
  if (c.initiative.reacted !== undefined) {
    c.initiative.reacted = c.initiative.reacted.filter((n) => n !== ch.name);
    if (c.initiative.reacted.length === 0) delete c.initiative.reacted;
  }
  return had;
}

export function armorClass(
  c: Campaign | undefined,
  ch: Character,
  globalEffects?: Record<string, CustomEffectDef>,
): number {
  return ch.ac + (c?.initiative?.shielded?.includes(ch.name) === true ? 5 : 0) + stateAcBonus(ch, c, globalEffects);
}

/** 指针往后挪一格；回到表头算新一轮。新一轮开始时突袭已经结束 */
function stepTurn(state: InitiativeState): boolean {
  state.turn++;
  if (state.turn < state.order.length) return false;
  state.turn = 0;
  state.round++;
  delete state.surprised;
  return true;
}

/**
 * 当前行动者受惊时整回合跳过，一直挪到第一个没受惊的人（或第 2 轮）。
 * start 之后和每次 next 之后都要调：开场排第一的就可能是受惊的人。
 */
export function skipSurprised(c: Campaign): { skipped: string[]; newRound: boolean } {
  const state = requireInitiative(c);
  const skipped: string[] = [];
  let newRound = false;
  while (state.surprised !== undefined) {
    const current = state.order[state.turn];
    if (current === undefined || !state.surprised.includes(current.name)) break;
    state.surprised = state.surprised.filter((n) => n !== current.name);
    if (state.surprised.length === 0) delete state.surprised;
    skipped.push(current.name);
    if (stepTurn(state)) newRound = true;
  }
  if (skipped.length > 0) pushLog(c, `受惊跳过：${skipped.join('、')}`);
  const active = state.order[state.turn]?.name;
  if (active !== undefined) state.turnState = { actor: active, attacks: 0 };
  return { skipped, newRound };
}

export interface JoinInitiativeOptions {
  rehearsalHp?: Record<string, number>;
  temporaryMonsters?: string[];
}

/**
 * 战斗进行中加入新的参战者（赶到的队友、刚刷出来的怪）：只给他们掷先攻并插进现有顺序，
 * 不重掷别人、不重置轮数——重开一场会把正在进行的回合和整张先攻表都打乱。
 * 插在当前行动者前面的，本轮已经错过，下一轮才轮到。
 */
export function joinInitiative(
  c: Campaign, names: string[], roller: Roller = cryptoRoller,
  bonus: Record<string, string> = {}, options: JoinInitiativeOptions = {},
): InitiativeRoll[] {
  const state = requireInitiative(c);
  if (names.length === 0) throw new Error('join 要给 participants');
  const members = [...new Set(names.map((n) => requireCharacter(c, n)))];
  const absentMembers = members.filter(isAbsent);
  if (absentMembers.length > 0) {
    throw new Error(`${absentMembers.map((ch) => ch.name).join('、')} 本次未签到、已暂时移出队伍，不能拉入先攻（等本人点「签到」自动归队，或确认本人到场后用 dnd_character update absent=false 归队）`);
  }
  const already = members.filter((ch) => state.order.some((e) => e.name === ch.name));
  if (already.length > 0) throw new Error(`${already.map((ch) => ch.name).join('、')} 已经在先攻表里了`);
  const rehearsal = state.rehearsal === true;
  if (!rehearsal && (options.rehearsalHp !== undefined || options.temporaryMonsters !== undefined)) {
    throw new Error('rehearsal_hp / temporary_monsters 只在 rehearsal=true 的演练战斗中使用');
  }
  const tempMonsters = rehearsal
    ? [...new Set((options.temporaryMonsters ?? []).map((n) => requireCharacter(c, n).name))]
    : [];
  const hpOverrides = rehearsal && options.rehearsalHp !== undefined
    ? Object.entries(options.rehearsalHp).map(([rawName, hp]) => ({ ch: requireCharacter(c, rawName), hp: clampInt(hp, 1, 999) }))
    : [];
  // 先在活体卡上应用演练临时血量（战前快照 rehearsalSnapshot 保持不变，结束时仍能还原真实状态）
  for (const { ch, hp } of hpOverrides) {
    ch.maxHp = hp;
    ch.hp = hp;
    ch.conditions = ch.conditions.filter((cond) => cond !== '死亡' && cond !== '昏迷');
  }
  const out = members.filter((ch) => isOut(ch));
  if (out.length > 0) throw new Error(`${out.map((ch) => ch.name).join('、')} 已经倒下，不能入战`);
  if (rehearsal && tempMonsters.length > 0 && state.rehearsalSnapshot !== undefined) {
    state.rehearsalSnapshot.temporaryMonsters = [
      ...new Set([...(state.rehearsalSnapshot.temporaryMonsters ?? []), ...tempMonsters]),
    ];
  }
  const rolls = members.map((ch) => {
    const r = rollD20(initBonusOf(ch), 'none', roller);
    const expr = bonus[ch.name];
    const extra = expr === undefined ? undefined : rollExpression(expr, roller);
    const flat = initBonusOf(ch) + (extra?.total ?? 0);
    return {
      name: ch.name,
      init: r.total + (extra?.total ?? 0),
      detail: extra === undefined ? r.detail : `${r.detail} + ${expr} ${extra.detail}`,
      tiebreak: flat,
    };
  });
  const sorted = [...rolls].sort((a, b) => b.init - a.init || b.tiebreak - a.tiebreak);
  for (const r of sorted) {
    // 同点数排在已有的人后面：先在场的先动
    let idx = state.order.findIndex((e) => e.init < r.init);
    if (idx === -1) idx = state.order.length;
    state.order.splice(idx, 0, { name: r.name, init: r.init });
    if (idx <= state.turn) state.turn++;
  }
  state.allParticipants = [...new Set([...(state.allParticipants ?? []), ...state.order.map((e) => e.name)])];
  pushLog(c, `加入${rehearsal ? '演练' : ''}战斗：${sorted.map((r) => `${r.name}(${r.init})`).join('、')}`);
  return sorted.map(({ name, init, detail }) => ({ name, init, detail }));
}

/**
 * 角色离开战斗（怪物逃走报信、NPC 退场）：移出先攻表但不算击败。
 * 正在行动的人离场时指针退一格，下一次 next 才落到排在他后面的人，不会跳过谁。
 */
export function leaveInitiative(c: Campaign, name: string): boolean {
  if (c.initiative === undefined || !removeFromInitiative(c.initiative, name)) return false;
  pushLog(c, `${name} 离开战斗`);
  return true;
}

/** 交战房间：先攻表里所有人所在的房间（同一场战斗可能跨相邻房间） */
export function fightRooms(c: Campaign): Set<string> {
  const rooms = new Set<string>();
  for (const e of c.initiative?.order ?? []) {
    const ch = findCharacter(c, e.name);
    const room = ch === undefined ? undefined : roomOf(c, ch);
    if (room !== undefined) rooms.add(room);
  }
  return rooms;
}

/** names 里不在 rooms 中的人及其位置（给模型的提醒，不拦：远程隔着房间打也是可能的） */
export function outsideRooms(c: Campaign, names: readonly string[], rooms: ReadonlySet<string>): { name: string; room: string }[] {
  return names.flatMap((n) => {
    const ch = requireCharacter(c, n);
    const room = roomOf(c, ch);
    return room === undefined || rooms.has(room) ? [] : [{ name: ch.name, room }];
  });
}

/** 已在先攻表里的角色名 */
export function inInitiative(c: Campaign, name: string): boolean {
  return c.initiative?.order.some((e) => e.name === name) ?? false;
}

/**
 * 移出先攻表。移走的是当前或之前的人时指针退一格，下一次 nextTurn 正好落到原来排在他后面的人；
 * 原来只在 idx < turn 时退格，当前行动者在自己回合倒下/被移走时 next 会跳过下一个人。
 */
function removeFromInitiative(state: InitiativeState, name: string): boolean {
  const idx = state.order.findIndex((e) => e.name === name);
  if (idx === -1) return false;
  state.order.splice(idx, 1);
  delete state.positions?.[name];
  if (idx <= state.turn) state.turn--;
  if (state.turn >= state.order.length) state.turn = state.order.length - 1;
  return true;
}

export function requireInitiative(c: Campaign): InitiativeState {
  if (c.initiative === undefined) throw new Error('当前不在战斗中，先用 dnd_initiative start');
  return c.initiative;
}

/** 有待结算的骰子时拒绝往下走：只靠提醒拦不住，模型常把一只怪的回合一口气结算完 */
export function assertNoPending(c: Campaign, what: string): void {
  const p = reactionWindow(c);
  if (p === undefined) return;
  throw new Error(`还有一笔待结算（${describePending(p)}），先不能${what}。玩家回应后 dnd_apply target=${p.target} settle=true 落账；判错了才用 cancel=true。`);
}

/** 新的一骰：编号只增不减（见 Campaign.rollSeq） */
export function nextRollId(c: Campaign): number {
  c.rollSeq = (c.rollSeq ?? 0) + 1;
  return c.rollSeq;
}

/** 推进到下一个还能行动的角色（跳过死亡的；昏迷的 PC 保留，要做死亡豁免） */
export function nextTurn(
  c: Campaign,
  roller: Roller = cryptoRoller,
  globalEffects?: Record<string, CustomEffectDef>,
): {
  round: number;
  current: InitiativeEntry;
  newRound: boolean;
  skipped: string[];
  expired: string[];
  hazardNotes: string[];
} {
  assertNoPending(c, '推进回合');
  const state = requireInitiative(c);
  let prevActor = state.order[state.turn]?.name;
  for (const entry of [...state.order]) {
    const ch = findCharacter(c, entry.name);
    if (ch === undefined || isOut(ch)) removeFromInitiative(state, entry.name);
  }
  if (state.order.length === 0) throw new Error('先攻表里已经没有能行动的角色，用 dnd_initiative end 结束战斗');
  delete state.moved;
  delete state.dashed;
  delete state.disengaged;
  delete state.fightingSpirit;
  delete state.counterAttacks;
  delete state.zoneTriggered;
  delete state.auraTriggered;

  const allSkipped: string[] = [];
  const allExpired: string[] = [];
  const allHazards = settleOngoingSaves(c, prevActor, 'target_turn_end', roller, globalEffects);
  let newRound = false;
  const maxHops = Math.max(1, state.order.length + 1);

  for (let hop = 0; hop < maxHops; hop++) {
    if (stepTurn(state)) newRound = true;
    const skippedRound = state.round;
    const skip = skipSurprised(c);
    newRound ||= skip.newRound;
    allSkipped.push(...skip.skipped);
    for (const actor of skip.skipped) {
      allHazards.push(...settleOngoingSaves(c, actor, 'target_turn_start', roller, globalEffects, skippedRound));
      allHazards.push(...settleOngoingSaves(c, actor, 'target_turn_end', roller, globalEffects, skippedRound));
    }
    const current = state.order[state.turn];
    if (current === undefined) break;
    if (state.shielded !== undefined) state.shielded = state.shielded.filter((name) => name !== current.name);
    if (state.reacted !== undefined) {
      state.reacted = state.reacted.filter((n) => n !== current.name);
      if (state.reacted.length === 0) delete state.reacted;
    }
    const expired = tickActiveStatesOnTurnChange(c, prevActor, current.name);
    for (const line of expired) pushLog(c, line);
    allExpired.push(...expired);
    allHazards.push(...checkAllAirborneCrashes(c, roller, globalEffects));
    allHazards.push(...settleTurnBoundaryHazards(c, prevActor, current.name, roller, globalEffects));
    allHazards.push(...settleOngoingSaves(c, current.name, 'target_turn_start', roller, globalEffects));
    allHazards.push(...checkAllAirborneCrashes(c, roller, globalEffects));

    const curCh = findCharacter(c, current.name);
    if (curCh !== undefined && !isOut(curCh)) {
      return { round: state.round, current, newRound, skipped: allSkipped, expired: allExpired, hazardNotes: allHazards };
    }
    // 当前行动者在回合开始时被光环/持续地形直接击杀：移出先攻表并顺延到下一名存活角色
    prevActor = undefined;
    removeFromInitiative(state, current.name);
    if (state.order.length === 0) break;
  }
  const fallback = state.order[Math.max(0, state.turn)] ?? { name: '（全灭）', init: 0 };
  return { round: state.round, current: fallback, newRound, skipped: allSkipped, expired: allExpired, hazardNotes: allHazards };
}

export interface EndInitiativeResult {
  rounds: number;
  defeated: string[];
  survivingMonsters: Array<{ name: string; hp: number; maxHp: number; conditions: string[]; wound: string }>;
  rehearsal?: boolean;
  restored?: boolean;
}

/** 结束战斗：记录本场完整结果与账本，清空先攻，移除已死亡的怪物（演练模式则自动还原战前状态与场地图） */
export function endInitiative(c: Campaign, options: { keepChanges?: boolean } = {}): EndInitiativeResult {
  const state = c.initiative;
  const rounds = state?.round ?? 0;
  const participants = [...new Set([...(state?.allParticipants ?? []), ...(state?.order.map((e) => e.name) ?? [])])];
  const rooms = fightRooms(c);
  const dead = c.characters.filter((ch) => ch.kind === 'monster' && isOut(ch));
  const defeated = dead.map((ch) => ch.name);
  const survivingMonsters = c.characters
    .filter((ch) => ch.kind === 'monster' && !isOut(ch) && (participants.includes(ch.name) || (ch.room !== undefined && rooms.has(ch.room))))
    .map((ch) => ({ name: ch.name, hp: ch.hp, maxHp: ch.maxHp, conditions: [...ch.conditions], wound: woundLabel(ch) }));
  const fallenParty = c.characters
    .filter((ch) => ch.kind !== 'monster' && !isAbsent(ch) && (ch.hp === 0 || isOut(ch) || ch.conditions.includes('昏迷')) && (participants.includes(ch.name) || rooms.has(roomOf(c, ch) ?? '')))
    .map((ch) => ({ name: ch.name, hp: ch.hp, maxHp: ch.maxHp, conditions: [...ch.conditions] }));
  const rehearsal = state?.rehearsal === true;
  const snap = state?.rehearsalSnapshot;
  const restored = rehearsal && snap !== undefined && options.keepChanges !== true;
  const ledger = [...(state?.ledger ?? [])];

  c.initiative = undefined;
  delete c.hexbladeCurses;
  c.lastCombat = {
    at: Date.now(),
    rounds,
    ...(rehearsal ? { rehearsal: true, restored } : {}),
    participants,
    defeated,
    survivingMonsters,
    fallenParty,
    ledger,
  };

  if (restored) {
    const absentStates = new Map(c.characters.filter((ch) => ch.kind === 'pc').map((ch) => [ch.name, ch.absent === true]));
    const tempSet = new Set(snap.temporaryMonsters ?? []);
    const participantSet = new Set(participants);
    c.characters = structuredClone(snap.characters).filter((ch) => {
      if (tempSet.has(ch.name)) return false;
      if (ch.kind === 'monster' && ch.npcId === undefined && ch.srd === undefined && participantSet.has(ch.name) && /梦境|演练|幻境|幻象|加练/.test(ch.notes ?? '')) return false;
      return true;
    });
    for (const ch of c.characters) {
      if (ch.kind !== 'pc') continue;
      const liveAbsent = absentStates.get(ch.name);
      if (liveAbsent === undefined) continue;
      if (liveAbsent) ch.absent = true;
      else if (ch.absent === true) {
        delete ch.absent;
        ch.room = c.currentRoom;
      }
    }
    if (snap.battlemaps !== undefined) c.battlemaps = structuredClone(snap.battlemaps);
    else delete c.battlemaps;
    c.npcs = structuredClone(snap.npcs);
    c.spawned = [...snap.spawned];
    if (snap.enteredFrom !== undefined) c.enteredFrom = structuredClone(snap.enteredFrom);
    else delete c.enteredFrom;
    pushLog(c, `演练战斗结束（${rounds} 轮）${defeated.length > 0 ? `，演练击败 ${defeated.join('、')}` : ''}，战前角色状态与房间场地图已自动还原`);
    return { rounds, defeated, survivingMonsters, rehearsal: true, restored: true };
  }

  for (const ch of dead) {
    recordNpcDeath(c, ch);
    notifyConcentrationTargetDown(c, ch);
  }
  c.characters = c.characters.filter((ch) => !(ch.kind === 'monster' && isOut(ch)));
  for (const ch of c.characters) {
    if (ch.activeStates !== undefined) {
      const endNames = ch.activeStates
        .filter((s) => s.expires === 'end_of_combat' || s.name === '闪避')
        .map((s) => s.name);
      for (const name of endNames) {
        const removed = removeActiveState(ch, name);
        syncConcentrationAfterRemoval(c, ch, removed);
      }
    } else if (ch.conditions.includes('闪避')) {
      removeActiveState(ch, '闪避');
    }
  }
  // 核对各存活施法者的 concentrationState：可转移专注（脆弱诅咒/猎人印记）在原目标被清理后继续保留在施法者身上，其余失去受术目标或战场区域的专注自动收尾
  for (const ch of c.characters) {
    const cs = ch.concentrationState;
    if (cs === undefined) continue;
    const norm = normalizeCondition(cs.name);
    const remaining = concentratingOn(c, ch.name).filter((x) => normalizeCondition(x.state.name) === norm);
    if (remaining.length > 0) {
      const liveOne = remaining.find((x) => !isOut(x.owner) && x.owner.hp > 0);
      if (cs.transferable === true) {
        ch.concentrationState = {
          name: norm,
          ...(cs.slotLevel !== undefined ? { slotLevel: cs.slotLevel } : {}),
          ...(remaining[0]!.state.roundsLeft !== undefined ? { roundsLeft: remaining[0]!.state.roundsLeft } : (cs.roundsLeft !== undefined ? { roundsLeft: cs.roundsLeft } : {})),
          transferable: true,
          ...(liveOne !== undefined ? { currentTarget: liveOne.owner.name, canTransfer: false } : { canTransfer: true }),
        };
      }
    } else if (cs.transferable === true) {
      ch.concentrationState = {
        name: norm,
        ...(cs.slotLevel !== undefined ? { slotLevel: cs.slotLevel } : {}),
        ...(cs.roundsLeft !== undefined ? { roundsLeft: cs.roundsLeft } : {}),
        transferable: true,
        canTransfer: true,
      };
    } else {
      delete ch.concentrationState;
    }
  }
  pushLog(c, `战斗结束（${rounds} 轮）${defeated.length > 0 ? `，击败 ${defeated.join('、')}` : ''}`);
  return { rounds, defeated, survivingMonsters, ...(rehearsal ? { rehearsal: true, restored: false } : {}) };
}

// ── 移动 ──

export interface VisibleExit {
  to: string;
  name: string;
  label: string;
  known: boolean;
  /** 条件不满足、暂时过不去 */
  locked?: boolean;
}

export interface ExitCheckRoll {
  name: string;
  passed: boolean;
  detail: string;
}

export interface MoveResult {
  /** 实际移动的角色名（出口检定失败的人留在原地，不在这里） */
  movers: string[];
  room: DungeonRoom;
  site: Site;
  /** 首次进入这个房间 */
  firstVisit: boolean;
  /** 首次进入这个场景（要念 Site.arrival） */
  firstSiteVisit: boolean;
  /** 跨场景赶路时出发的场景 */
  travelledFrom?: Site;
  /** 已清空地城快速穿越经过的中间房间名（不含起点与终点；跨场景离城时包含出口房间） */
  viaRooms?: string[];
  /** 整队移动时自动留在各自原房间的其他房间 NPC（避免旧档非随行 NPC 阻断整队移动） */
  leftBehindNpcs?: string[];
  /** 套用描述变体之后的玩家视角 / DM 笔记 */
  view: { playerView: string; dmNotes: string };
  spawned: Character[];
  /** 出口检定的结果；没过的人没动 */
  checks: ExitCheckRoll[];
  /** 出口检定失败的后果（DM 视角） */
  failText?: string;
  /** 出口检定没由工具掷：DM 已经用 dnd_check 另行结算过，这里是那几骰的编号 */
  checkDone?: number[];
  /** afterChange 产生的剧情提示 */
  story: string[];
  /** 玩家现在能看到的出口 */
  exits: VisibleExit[];
}

/** 城镇里随便走：同一城镇里玩家知道的其他地点 */
function hubExits(c: Campaign, adv: Adventure, roomId: string): DungeonExit[] {
  const site = siteOfRoom(adv, roomId);
  if (!isHub(site)) return [];
  return site!.rooms
    .filter((r) => r.id !== roomId && locationKnown(c, adv, r))
    .map((r) => ({ to: r.id, label: `去${r.name}` }));
}

/** 能去的其他已知场景（有 routes 时只算有路相连的）：地城只能从入口走，城镇从哪儿都能走 */
function crossSiteExits(c: Campaign, adv: Adventure, roomId: string): DungeonExit[] {
  const site = siteOfRoom(adv, roomId);
  if (site === undefined || (site.entry !== roomId && !isHub(site))) return [];
  return adv.sites
    .filter((s) => s.id !== site.id && c.knownSites.includes(s.id))
    .filter((s) => adv.routes === undefined || adv.routes.some((r) => (r.from === site.id && r.to === s.id) || (r.from === s.id && r.to === site.id)))
    .map((s) => ({ to: s.entry, label: `前往${s.name}` }));
}

/** 列出当前房间对玩家可见的出口（未发现的暗门不列，条件不满足的标 locked） */
export function visibleExits(c: Campaign, adv: Adventure, roomId = c.currentRoom): VisibleExit[] {
  const graph = roomGraph(adv);
  const own = exitsOf(graph, roomId);
  const hub = hubExits(c, adv, roomId).filter((e) => !own.some((o) => o.to === e.to));
  return [...own, ...hub, ...crossSiteExits(c, adv, roomId)]
    .filter((e) => e.hidden !== true || c.discoveredExits.includes(exitKey(roomId, e.to)))
    .map((e) => ({
      to: e.to,
      name: findRoom(graph, e.to)?.name ?? e.to,
      label: e.label,
      known: c.revealed.includes(e.to),
      ...(e.requires !== undefined && !evalCondition(c, adv, e.requires) ? { locked: true } : {}),
    }));
}

/** 按 id、本场景房间名、场景 id/名（→ 场景入口）、全模组房间名的顺序找目标 */
function resolveTarget(adv: Adventure, from: string, query: string): DungeonRoom | undefined {
  const q = query.trim();
  const graph = roomGraph(adv);
  const here = siteOfRoom(adv, from);
  const site = findSite(adv, q) ?? adv.sites.find((s) => s.name === q);
  return findRoom(graph, q)
    ?? here?.rooms.find((r) => r.name === q)
    ?? (site !== undefined ? findRoom(graph, site.entry) : undefined)
    ?? graph.rooms.find((r) => r.name === q);
}

/** 新角色名：重名时加房间后缀，再重名就加序号 */
function freeName(c: Campaign, name: string, roomId: string): string {
  if (!c.characters.some((ch) => ch.name === name)) return name;
  let candidate = `${name}-${roomId}`;
  for (let n = 2; c.characters.some((ch) => ch.name === candidate); n++) candidate = `${name}-${roomId}-${n}`;
  return candidate;
}

/** 把模组里的怪物刷进某个房间（房间遭遇、触发器援兵） */
export function spawnMonsters(c: Campaign, roomId: string, monsters: readonly DungeonMonster[]): Character[] {
  const spawned: Character[] = [];
  for (const monster of monsters) {
    for (let i = 1; i <= monster.count; i++) {
      const monsterResources = normalizeMonsterResources(monster.resources);
      const ch: Character = {
        name: freeName(c, monster.count > 1 ? `${monster.name}${i}` : monster.name, roomId),
        kind: 'monster',
        level: 1,
        abilities: { str: 10, dex: 10 + monster.initBonus * 2, con: 10, int: 10, wis: 10, cha: 10, ...monster.abilities },
        skills: [],
        saves: [],
        hp: monster.hp,
        maxHp: monster.hp,
        tempHp: 0,
        ac: monster.ac,
        conditions: [],
        attackBonus: monster.attackBonus,
        damage: monster.damage,
        initBonus: monster.initBonus,
        room: roomId,
        ...(monster.srd !== undefined ? { srd: monster.srd } : {}),
        ...(monster.notes !== undefined ? { notes: monster.notes } : {}),
        ...(monster.traits !== undefined ? { traits: [...monster.traits] } : {}),
        ...(monsterResources !== undefined ? { resources: monsterResources } : {}),
      };
      c.characters.push(ch);
      spawned.push(ch);
    }
  }
  return spawned;
}

/** 房间的固定遭遇只刷一次（第一次有人进来，或开场结束时的起始房间） */
export function spawnEncounter(c: Campaign, room: DungeonRoom): Character[] {
  if (c.spawned.includes(room.id)) return [];
  c.spawned.push(room.id);
  return spawnMonsters(c, room.id, room.encounter ?? []);
}

/** 出口检定：skill 或 ability 都可以写中文或英文 */
function rollExitCheck(ch: Character, check: ExitCheck, roller: Roller): ExitCheckRoll {
  const skill = check.skill === undefined ? undefined : parseSkill(check.skill);
  const ability = skill !== undefined ? SKILLS[skill].ability as Ability : parseAbility(check.ability ?? '');
  if (ability === undefined) throw new Error(`出口检定写的技能/属性认不出来: ${check.skill ?? check.ability}`);
  const r = rollD20(checkModifier(ch, skill !== undefined ? 'skill' : 'ability', ability, skill), 'none', roller);
  const passed = r.total >= check.dc;
  return { name: ch.name, passed, detail: `${r.detail}，${passed ? '成功' : '失败'}` };
}

/**
 * 移动到相邻房间。who 省略时整队（全部活着的 PC/NPC）一起走；传了只移动这几个人（分头行动）。
 * 暗门需要 discoverHidden=true（模型在检定成功后才传）。首次进入时揭示房间并刷出遭遇怪物。
 * 战斗中只能单独移动当前回合的角色。
 * 跨场景：从场景入口走到另一个已知场景的入口（有 routes 时要有路）。
 * 出口有 requires 时条件不满足就过不去；有 check 时工具给每个人掷骰，没过的留在原地。
 * checkDone：这道检定桌上已经用 dnd_check 投过了（模组写的是攀爬，玩家选了别的办法，DM 改掷了体质豁免），
 * 传那几骰的编号就不再掷一遍。11-11 吞蛇台阶就是先投了豁免，换房间时工具又掷一次，DM 只好逐个手改 room。
 */
function hasLivingMonster(c: Campaign, roomId: string): boolean {
  return c.characters.some((ch) => ch.kind === 'monster' && !isOut(ch) && roomOf(c, ch) === roomId);
}

/**
 * 已清空地城快速穿行 BFS：仅在同一非城镇场景的已揭示房间之间寻路，
 * 要求沿途每个房间无存活怪物且每段出口无未发现暗门、无未满足前置条件、无检定门槛。
 */
function findClearedPath(c: Campaign, adv: Adventure, from: string, to: string): string[] | undefined {
  if (from === to) return [from];
  const fromSite = siteOfRoom(adv, from);
  const toSite = siteOfRoom(adv, to);
  if (fromSite === undefined || toSite === undefined || fromSite.id !== toSite.id || isHub(fromSite)) return undefined;
  if (!c.revealed.includes(from) || !c.revealed.includes(to)) return undefined;
  if (hasLivingMonster(c, from) || hasLivingMonster(c, to)) return undefined;
  const graph = roomGraph(adv);
  const prev = new Map<string, string | null>([[from, null]]);
  const queue: string[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    for (const edge of exitsOf(graph, cur)) {
      const next = edge.to;
      if (prev.has(next)) continue;
      if (siteOfRoom(adv, next)?.id !== fromSite.id) continue;
      if (!c.revealed.includes(next)) continue;
      if (hasLivingMonster(c, next)) continue;
      if (edge.hidden === true && !c.discoveredExits.includes(exitKey(cur, next))) continue;
      if (edge.requires !== undefined && !evalCondition(c, adv, edge.requires)) continue;
      if (edge.check !== undefined) continue;
      prev.set(next, cur);
      if (next === to) {
        const path: string[] = [];
        let node: string | null = next;
        while (node !== null) {
          path.push(node);
          node = prev.get(node) ?? null;
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return undefined;
}

export function moveParty(
  c: Campaign,
  adv: Adventure,
  target: string,
  discoverHidden = false,
  who?: string[],
  roller: Roller = cryptoRoller,
  checkDone: readonly number[] = [],
): MoveResult {
  const graph = roomGraph(adv);
  const whole = who === undefined || who.length === 0;
  if (c.initiative !== undefined) {
    if (whole) throw new Error('战斗中不能整队移动；先结束战斗（dnd_initiative end），或用 who 只移动当前回合的角色');
    const current = c.initiative.order[c.initiative.turn]?.name;
    // 不在先攻表里的人（还在路上的队友）不受回合限制，否则他们永远等不到「自己的回合」、赶不过来
    const others = who.map((n) => requireCharacter(c, n).name).filter((n) => n !== current && inInitiative(c, n));
    if (others.length > 0) throw new Error(`战斗中只能移动当前回合的角色（${current ?? '无'}）：${others.join('、')} 要等自己的回合`);
  }
  let leftBehindNpcs: Character[] = [];
  let candidates: Character[];
  if (whole) {
    const activeMembers = c.characters.filter((ch) => ch.kind !== 'monster' && !isOut(ch) && !isAbsent(ch) && !isStationedNpc(ch));
    const pcs = activeMembers.filter((ch) => ch.kind === 'pc');
    const pcRooms = new Set(pcs.map((ch) => roomOf(c, ch)!));
    if (pcs.length > 0 && pcRooms.size === 1) {
      const pcRoom = [...pcRooms][0]!;
      candidates = activeMembers.filter((ch) => ch.kind === 'pc' || roomOf(c, ch) === pcRoom);
      leftBehindNpcs = activeMembers.filter((ch) => ch.kind === 'npc' && roomOf(c, ch) !== pcRoom);
    } else {
      candidates = activeMembers;
    }
  } else {
    candidates = [...new Set(who.map((n) => requireCharacter(c, n)))];
  }
  if (candidates.length === 0) throw new Error('没有可以移动的角色');
  const absentMovers = candidates.filter(isAbsent);
  if (absentMovers.length > 0) {
    throw new Error(`${absentMovers.map((ch) => ch.name).join('、')} 已暂时移出队伍，不能移动（等本人点「签到」归队或 dnd_character update absent=false）`);
  }
  const monster = candidates.find((ch) => ch.kind === 'monster');
  if (monster !== undefined) {
    throw new Error(`${monster.name} 是怪物，不用 dnd_move。怪物换房间/逃跑用 dnd_character update name=${monster.name} room=<房间 id>（战斗中会顺带移出先攻表）`);
  }
  const from = roomOf(c, candidates[0]!)!;
  const fromName = findRoom(graph, from)?.name ?? from;
  const split = candidates.filter((ch) => roomOf(c, ch) !== from);
  if (split.length > 0) {
    throw new Error(`${split.map((ch) => ch.name).join('、')} 不在「${fromName}」，不同房间的人分开移动（who）`);
  }

  const room = resolveTarget(adv, from, target);
  if (room === undefined) throw new Error(`没有这个房间: ${target}`);
  if (room.id === from) throw new Error(`${whole ? '队伍' : candidates.map((ch) => ch.name).join('、')}已经在「${room.name}」了`);
  const fromSite = siteOfRoom(adv, from)!;
  const site = siteOfRoom(adv, room.id)!;
  let exit = site.id === fromSite.id
    ? exitBetween(graph, from, room.id) ?? hubExits(c, adv, from).find((e) => e.to === room.id)
    : crossSiteExits(c, adv, from).find((e) => e.to === room.id);
  let viaPath: string[] | undefined;
  let enteredFromRoom = from;
  if (exit === undefined && c.initiative === undefined) {
    if (site.id === fromSite.id && !isHub(site)) {
      const path = findClearedPath(c, adv, from, room.id);
      if (path !== undefined && path.length >= 3) {
        viaPath = path.slice(1, -1);
        enteredFromRoom = path[path.length - 2]!;
        exit = { to: room.id, label: `穿行已清空区域前往${room.name}` };
      }
    } else if (site.id !== fromSite.id && !isHub(fromSite) && from !== fromSite.entry && c.knownSites.includes(site.id) && room.id === site.entry) {
      const entryCrossExit = crossSiteExits(c, adv, fromSite.entry).find((e) => e.to === room.id);
      if (entryCrossExit !== undefined) {
        const toEntryPath = findClearedPath(c, adv, from, fromSite.entry);
        if (toEntryPath !== undefined) {
          viaPath = toEntryPath.slice(1);
          enteredFromRoom = fromSite.entry;
          exit = entryCrossExit;
        }
      }
    }
  }
  if (exit === undefined) {
    if (site.id !== fromSite.id) {
      if (!c.knownSites.includes(site.id)) throw new Error(`玩家还不知道「${site.name}」在哪`);
      if (!isHub(fromSite) && from !== fromSite.entry) throw new Error(`要离开「${fromSite.name}」，先回到入口「${findRoom(graph, fromSite.entry)?.name ?? fromSite.entry}」`);
      if (room.id !== site.entry) throw new Error(`去「${site.name}」要从入口「${findRoom(graph, site.entry)?.name ?? site.entry}」进`);
      throw new Error(`「${fromSite.name}」和「${site.name}」之间没有路`);
    }
    if (isHub(site)) throw new Error(`玩家还不知道「${room.name}」这个地方`);
    const names = visibleExits(c, adv, from).map((e) => e.name).join('、') || '无';
    throw new Error(`「${room.name}」和「${fromName}」不相邻。可去：${names}`);
  }
  const key = exitKey(from, room.id);
  if (exit.hidden === true && !c.discoveredExits.includes(key)) {
    if (!discoverHidden) throw new Error(`没有可见的路通往「${room.name}」`);
    c.discoveredExits.push(key);
    pushLog(c, `发现暗门：${fromName} ↔ ${room.name}`);
  }
  if (exit.requires !== undefined && !evalCondition(c, adv, exit.requires)) {
    throw new Error(`过不去：${exit.lockedText ?? `需要 ${describeCondition(adv, exit.requires)}`}`);
  }

  const check = exit.check;
  // 编号对不上的不认：只有真掷过的骰才能顶替出口检定
  const unknownRoll = checkDone.find((id) => !Number.isInteger(id) || id < 1 || id > (c.rollSeq ?? 0));
  if (unknownRoll !== undefined) throw new Error(`没有 #R${unknownRoll} 这一骰（目前最新是 #R${c.rollSeq ?? 0}）。check_done 填 dnd_check 结果里的骰子编号`);
  const settledByHand = check !== undefined && checkDone.length > 0;
  const checks = check === undefined || settledByHand ? [] : candidates.map((ch) => rollExitCheck(ch, check, roller));
  const movers = candidates.filter((ch) => checks.find((r) => r.name === ch.name)?.passed !== false);
  const failText = check !== undefined && checks.some((r) => !r.passed) ? check.fail : undefined;
  if (checks.length > 0) pushLog(c, `${exit.label}检定：${checks.map((r) => `${r.name}${r.passed ? '成功' : '失败'}`).join('、')}`);
  if (settledByHand) pushLog(c, `${exit.label}检定已另行结算（${checkDone.map((id) => `#R${id}`).join(' ')}）`);

  const everyone = whole && movers.length === candidates.length;
  const firstSiteVisit = movers.length > 0 && site.id !== fromSite.id && !site.rooms.some((r) => c.revealed.includes(r.id));
  const firstVisit = movers.length > 0 && !c.revealed.includes(room.id);
  const spawned: Character[] = [];
  if (movers.length > 0) {
    // 都开始走动了，开场肯定结束了；起始房间的遭遇（比如开场伏击）这时还没刷过，补上
    if (c.begun === false) {
      c.begun = true;
      const start = findRoom(graph, from);
      if (start !== undefined) spawnEncounter(c, start);
    }
    // 没单独移动过的人跟着 currentRoom；它要变之前先把留下的人钉在原地，免得被一起带走
    for (const ch of c.characters) {
      if (ch.kind !== 'monster' && !isAbsent(ch) && ch.room === undefined && !movers.includes(ch)) ch.room = c.currentRoom;
    }
    for (const ch of movers) ch.room = room.id;
    (c.enteredFrom ??= {})[room.id] = enteredFromRoom;
    // 有人检定没过留在原地时，队伍主位置按人数多的一边算
    c.currentRoom = everyone ? room.id : mainRoom(c, room.id);
    if (firstVisit) c.revealed.push(room.id);
    if (!c.knownSites.includes(site.id)) c.knownSites.push(site.id);
    spawned.push(...spawnEncounter(c, room));
    pushLog(c, `${everyone ? '队伍' : movers.map((ch) => ch.name).join('、')}进入「${room.name}」`);
  }
  const viaRooms = viaPath?.map((id) => findRoom(graph, id)?.name ?? id);
  const story = afterChange(c, adv);
  for (const line of story) pushLog(c, line);
  return {
    movers: movers.map((ch) => ch.name),
    room,
    site,
    firstVisit,
    firstSiteVisit,
    ...(movers.length > 0 && site.id !== fromSite.id ? { travelledFrom: fromSite } : {}),
    ...(viaRooms !== undefined && viaRooms.length > 0 ? { viaRooms } : {}),
    ...(leftBehindNpcs.length > 0 ? { leftBehindNpcs: leftBehindNpcs.map((ch) => ch.name) } : {}),
    view: roomView(c, adv, room),
    spawned,
    checks,
    ...(failText !== undefined ? { failText } : {}),
    ...(settledByHand ? { checkDone: [...checkDone] } : {}),
    story,
    exits: visibleExits(c, adv, movers.length > 0 ? room.id : from),
  };
}

/** 队伍主位置：活着的 PC/NPC 最多的房间（平手取 prefer） */
function mainRoom(c: Campaign, prefer: string): string {
  const counts = new Map<string, number>();
  for (const [room, members] of partyPositions(c)) counts.set(room, members.length);
  let best = prefer;
  for (const [room, n] of counts) {
    if (n > (counts.get(best) ?? 0)) best = room;
  }
  return best;
}

/** 按房间分组的队伍位置（活着的且在队的 PC 与随行 NPC，不含留守/退队 NPC）；全队在一起时只有一组 */
export function partyPositions(c: Campaign): Map<string, Character[]> {
  const groups = new Map<string, Character[]>();
  for (const ch of c.characters) {
    if (ch.kind === 'monster' || isOut(ch) || isAbsent(ch) || isStationedNpc(ch)) continue;
    const room = roomOf(c, ch)!;
    groups.set(room, [...(groups.get(room) ?? []), ch]);
  }
  return groups;
}

// ── 行动界限 ──

export interface ActOptions {
  /** 宣告这个行动的玩家 openid（模型填消息标签 [昵称 #U3] 里的别名，dnd_* 工具换回 openid） */
  declaredBy?: string;
  /** DM 要求的对抗/反应/借机攻击：不受回合和玩家绑定限制 */
  reaction?: boolean;
  /**
   * 玩家明确把这个角色的行动委托给了别人（「让 Kriv 去谈」），或者这是被推/被拖一类的强制位移：
   * 跳过「只能由本人宣告」，但仍然受回合顺序限制。用之前必须在回复里写明是谁委托的。
   */
  dmOverride?: boolean;
  /** 特例豁免结构化状态的硬拦截（如自由行动戒指、特殊专长） */
  ignoreStateMods?: boolean;
  /**
   * 最近真正给 bot 发过消息的人。传入时 declaredBy 必须在里面：
   * 模型照抄角色卡上的 openid 也冒充不了没说话的玩家。
   */
  recentSenders?: readonly string[];
}

/** PC 必须由绑定的玩家本人（或受托托管玩家）宣告，且这个人最近确实发过消息；DM 托管中的 PC 由 DM 直接接管 */
export function assertDeclaredByOwner(ch: Character, options: ActOptions, what: string): void {
  if (ch.kind !== 'pc' || ch.playerId === undefined || isDmDelegated(ch)) return;
  const owner = `〈${ch.player ?? ch.playerId}〉`;
  const delegate = ch.delegated?.mode === 'player' && ch.delegated.playerId !== undefined
    ? `〈${ch.delegated.player ?? ch.delegated.playerId}〉`
    : undefined;
  if (!isControlledBy(ch, options.declaredBy)) {
    const whoDesc = delegate !== undefined ? `${owner}（当前托管给 ${delegate}）` : owner;
    throw new Error(
      `${ch.name} 是${whoDesc}的角色，${what}只能由${delegate !== undefined ? '本人或受托托管玩家' : '他本人'}宣告（declared_by 填他消息标签里的编号，如 U3）。`
      + '别人说的只当提议，去问本人；DM 要求的对抗检定或反应传 reaction=true。',
    );
  }
  const actorLabel = ch.delegated?.mode === 'player' && options.declaredBy === ch.delegated.playerId ? delegate! : owner;
  if (options.recentSenders !== undefined && !options.recentSenders.includes(options.declaredBy!)) {
    throw new Error(`${actorLabel}最近没有发消息，不能替他宣告${what}。等他本人说话。`);
  }
}

/**
 * 检查角色此刻能否主动行动；不能时抛出给模型看的原因。
 *   - 绑定了玩家的 PC，只能由该玩家宣告；
 *   - 战斗中只有当前回合的角色能主动行动（反应除外）。
 */
export function assertCanAct(c: Campaign, ch: Character, options: ActOptions = {}): void {
  if (isAbsent(ch)) {
    throw new Error(`${ch.name} 本次未签到、已暂时移出队伍，暂不能行动；本人点「签到」自动归队，或确认本人加入时用 dnd_character update absent=false 归队`);
  }
  if (options.reaction === true) return;
  if (options.ignoreStateMods !== true) {
    const blocked = actionRestriction(ch);
    if (blocked !== undefined) throw new Error(`${blocked}（若特殊规则允许请传 ignore_state_mods=true）`);
  }
  // 委托来的行动（玩家自己说「让 Kriv 去谈」）和强制位移不查本人，但仍然只能在轮到他的回合里主动行动
  if (options.dmOverride !== true) assertDeclaredByOwner(ch, options, '行动');
  const state = c.initiative;
  if (state === undefined) return;
  const current = state.order[state.turn];
  if (current !== undefined && current.name !== ch.name) {
    if (!inInitiative(c, ch.name)) {
      throw new Error(
        `现在是 ${current.name} 的回合，${ch.name} 不能主动行动（且 ${ch.name} 还不在先攻表里：若中途参战请先调用 dnd_initiative action=join participants=["${ch.name}"] 掷先攻并摆位；场外被动/知识检定传 reaction=true）。`,
      );
    }
    throw new Error(
      `现在是 ${current.name} 的回合，${ch.name} 不能主动行动。${current.name} 行动完先调用 dnd_initiative next；`
      + '借机攻击/反应传 reaction=true。',
    );
  }
}

/**
 * 结束当前回合（dnd_initiative next）前的检查：当前是绑定玩家的 PC 时，
 * 只有他本人能结束（附赠动作、移动还没用完）；玩家掉线时 DM 传 dmOverride。
 */
export function assertCanEndTurn(c: Campaign, options: ActOptions & { dmOverride?: boolean } = {}): void {
  if (options.dmOverride === true) return;
  const state = requireInitiative(c);
  const current = state.order[state.turn];
  const ch = current === undefined ? undefined : findCharacter(c, current.name);
  if (ch === undefined || ch.hp === 0 || ch.conditions.includes('死亡')) return;
  assertDeclaredByOwner(ch, options, '结束回合');
}

/** 纠正先攻指针：跳到某角色的回合（叙事和状态对不上时用） */
export function gotoTurn(c: Campaign, name: string, round?: number): InitiativeEntry {
  assertNoPending(c, '调整先攻指针');
  const state = requireInitiative(c);
  const ch = requireCharacter(c, name);
  const idx = state.order.findIndex((e) => e.name === ch.name);
  if (idx === -1) throw new Error(`${ch.name} 不在先攻表里`);
  state.turn = idx;
  delete state.counterAttacks;
  delete state.moved;
  delete state.dashed;
  delete state.disengaged;
  delete state.fightingSpirit;
  delete state.zoneTriggered;
  delete state.auraTriggered;
  state.turnState = { actor: ch.name, attacks: 0 };
  if (round !== undefined && round >= 1) state.round = Math.trunc(round);
  pushLog(c, `先攻指针调整到第 ${state.round} 轮 ${ch.name}`);
  return state.order[idx]!;
}

// ── 检定 ──

export type CheckKind = 'skill' | 'ability' | 'save';

/** 角色在某检定上的修正值（属性调整 + 熟练） */
export function checkModifier(ch: Character, kind: CheckKind, ability: Ability, skill?: Skill): number {
  const base = abilityModifier(ch.abilities[ability]);
  const prof = proficiencyBonus(ch.level);
  if (kind === 'skill' && skill !== undefined && ch.expertise?.includes(skill)) return base + prof * 2;
  if (kind === 'skill' && skill !== undefined && ch.skills.includes(skill)) return base + prof;
  if (kind === 'save' && ch.saves.includes(ability)) return base + prof;
  return base;
}

export function findWeapon(ch: Character, name: string): Weapon {
  const q = name.trim();
  const weapon = ch.weapons?.find((w) => w.name === q) ?? ch.weapons?.find((w) => w.name.includes(q) || q.includes(w.name));
  if (weapon === undefined) {
    const list = ch.weapons?.map((w) => w.name).join('、') || '（角色卡上没有武器，先用 dnd_character update 补上）';
    throw new Error(`${ch.name} 没有「${name}」。现有武器：${list}`);
  }
  return weapon;
}

/** 武器伤害表达式：武器骰 + 属性调整值 */
export function weaponDamage(ch: Character, weapon: Weapon): string {
  const mod = abilityModifier(ch.abilities[weapon.ability ?? 'str']) + (weapon.magic ?? 0);
  return mod === 0 ? weapon.damage : `${weapon.damage}${mod > 0 ? '+' : '-'}${Math.abs(mod)}`;
}

// 战斗风格与专长写进 traits，由工具自动结算；模型不用每次记着手动加 bonus / 重投
export const GREAT_WEAPON_FIGHTING = '巨武器战斗';
export const ARCHERY = '箭术';
export const ELVEN_ACCURACY = '精灵精准';
const TRAIT_ALIASES: Record<string, string> = {
  'great weapon fighting': GREAT_WEAPON_FIGHTING,
  巨武器: GREAT_WEAPON_FIGHTING,
  大武器战斗: GREAT_WEAPON_FIGHTING,
  巨武器战斗风格: GREAT_WEAPON_FIGHTING,
  archery: ARCHERY,
  箭术战斗风格: ARCHERY,
  弓术: ARCHERY,
  射击: ARCHERY,
  射术: ARCHERY,
  'elven accuracy': ELVEN_ACCURACY,
  精灵准: ELVEN_ACCURACY,
  精灵精准专长: ELVEN_ACCURACY,
  'colossus slayer': '巨兽杀手',
  colossus_slayer: '巨兽杀手',
  巨像屠夫: '巨兽杀手',
  巨象屠夫: '巨兽杀手',
  'sneak attack': '偷袭',
  sneak_attack: '偷袭',
  'improved divine smite': '精通至圣斩',
  强化至圣斩: '精通至圣斩',
  高等至圣斩: '精通至圣斩',
  'blessed strikes': '祝福打击',
  受祝打击: '祝福打击',
  'divine fury': '神圣狂怒',
  'savage attacks': '凶蛮攻击',
  野蛮攻击: '凶蛮攻击',
  'improved critical': '精通重击',
  'superior critical': '卓越重击',
  'war caster': '战地施法者',
  战争施法者: '战地施法者',
  'pack tactics': '集群战术',
  'blood frenzy': '血腥狂乱',
  嗜血狂乱: '血腥狂乱',
};

/** 把别名统一成工具认的特性名（「巨武器战斗风格」→「巨武器战斗」） */
export function normalizeTrait(trait: string): string {
  const t = trait.trim();
  return TRAIT_ALIASES[t.toLowerCase()] ?? t;
}

/** 精灵精准：优先看结构化 traits，旧角色卡未填 traits 时从备注兜底识别 */
export function hasElvenAccuracy(ch: Character): boolean {
  if (ch.traits !== undefined) return ch.traits.includes(ELVEN_ACCURACY);
  return /精灵精?准|Elven Accuracy/i.test(ch.notes ?? '');
}

/** 用敏捷/智力/感知/魅力进行的攻击检定具优势时可触发精灵精准（三骰取高） */
export function usesElvenAccuracy(ch: Character, ability: Ability | undefined): boolean {
  return ability !== undefined && ability !== 'str' && hasElvenAccuracy(ch);
}

/** 武士「战斗英姿」临时生命值：3/10/15 级战士对应 5/10/15 点（兼职优先按 className 中的战士等级） */
export function fightingSpiritTempHp(ch: Character): number {
  const match = /战士(?:[（(][^）)]*[）)])?\s*(\d+)/.exec(ch.className ?? '')
    ?? /(\d+)\s*级[^\n]*武士/.exec(ch.notes ?? '');
  const fighterLevel = match !== null ? Number(match[1]) : ch.level;
  if (fighterLevel >= 15) return 15;
  if (fighterLevel >= 10) return 10;
  return 5;
}

/** 咒剑诅咒：每个施法者同时维持一个诅咒目标 */
export function setHexbladeCurse(c: Campaign, caster: string, target: string): HexbladeCurse {
  const casterCh = requireCharacter(c, caster);
  const targetCh = requireCharacter(c, target);
  const entry: HexbladeCurse = { caster: casterCh.name, target: targetCh.name };
  c.hexbladeCurses = [...(c.hexbladeCurses ?? []).filter((x) => x.caster !== casterCh.name), entry];
  return entry;
}

export function hexbladeCurseOn(c: Campaign | undefined, caster: string, target: string): HexbladeCurse | undefined {
  return c?.hexbladeCurses?.find((x) => x.caster === caster && x.target === target);
}

/** 咒剑诅咒目标死亡时的治疗量：邪术师等级 + 魅力调整值（至少 1） */
export function hexbladeKillHeal(caster: Character): number {
  const match = /邪术师(?:[（(][^）)]*[）)])?\s*(\d+)/.exec(caster.className ?? '')
    ?? /邪术师\s*(\d+)\s*级/.exec(caster.notes ?? '');
  const warlockLevel = match !== null ? Number(match[1]) : caster.level;
  return Math.max(1, warlockLevel + abilityModifier(caster.abilities.cha));
}

export function isRangedWeapon(weapon: Weapon): boolean {
  return weapon.ranged ?? /弓|弩|bow/i.test(weapon.name);
}

export function isTwoHandedWeapon(weapon: Weapon): boolean {
  return weapon.twoHanded ?? (!isRangedWeapon(weapon) && /双手/.test(weapon.notes ?? ''));
}

/** 巨武器战斗：双手近战武器的伤害骰掷出 1 或 2 可以重投一次（2014 版规则） */
export function usesGreatWeaponFighting(ch: Character, weapon: Weapon | undefined): boolean {
  return weapon !== undefined && ch.traits?.includes(GREAT_WEAPON_FIGHTING) === true && isTwoHandedWeapon(weapon);
}

/** 用某把武器攻击的命中加值：属性 + 熟练（不熟练则无）+ 魔法加值 + 箭术 */
export function weaponAttackModifier(ch: Character, weapon: Weapon, ability?: Ability): number {
  const use = ability ?? weapon.ability ?? 'str';
  const prof = weapon.proficient === false ? 0 : proficiencyBonus(ch.level);
  const archery = ch.traits?.includes(ARCHERY) === true && isRangedWeapon(weapon) ? 2 : 0;
  return abilityModifier(ch.abilities[use]) + prof + (weapon.magic ?? 0) + archery;
}

/** PC 攻击加值：取力量/敏捷较高者 + 熟练；怪物用 attackBonus */
export function attackModifier(ch: Character, ability?: Ability): number {
  if (ch.attackBonus !== undefined && ability === undefined) return ch.attackBonus;
  const use = ability ?? (ch.abilities.dex > ch.abilities.str ? 'dex' : 'str');
  return abilityModifier(ch.abilities[use]) + proficiencyBonus(ch.level);
}

// ── 资源、休息、物品 ──

export function requireResource(ch: Character, key: string): [string, Resource] {
  const q = key.trim();
  const entries = Object.entries(ch.resources ?? {});
  const found = entries.find(([k]) => k === q) ?? entries.find(([k]) => k.includes(q) || q.includes(k));
  if (found === undefined) {
    const list = entries.map(([k, r]) => `${k} ${r.current}/${r.max}`).join('、') || '（还没有记录，先 dnd_resource set）';
    throw new Error(`${ch.name} 没有资源「${key}」。现有：${list}`);
  }
  return found;
}

/** 建立或改写资源；current 省略时新建取满，已有资源若上限提高（如升级/兼职解锁法术位）自动加上新增差额，避免 0/0 升为 0/2 */
export function setResource(c: Campaign, name: string, key: string, max: number, reset: Resource['reset'], current?: number): Resource {
  const ch = requireCharacter(c, name);
  const k = key.trim();
  if (k.length === 0) throw new Error('资源名不能为空');
  const cap = clampInt(max, 0, 999);
  const existing = ch.resources?.[k];
  const gained = existing !== undefined ? Math.max(0, cap - existing.max) : 0;
  const value = current !== undefined
    ? clampInt(current, 0, cap)
    : existing !== undefined
      ? clampInt(existing.current + gained, 0, cap)
      : cap;
  const resource: Resource = { current: value, max: cap, reset };
  ch.resources = { ...ch.resources, [k]: resource };
  return resource;
}

/** 消耗资源，不够时抛错（不会扣成负数） */
export function useResource(c: Campaign, name: string, key: string, amount = 1): { key: string; before: number; resource: Resource } {
  const ch = requireCharacter(c, name);
  const [k, r] = requireResource(ch, key);
  const n = Math.max(1, Math.trunc(amount));
  if (r.current < n) throw new Error(`${ch.name} 的「${k}」只剩 ${r.current}/${r.max}，不够用 ${n}`);
  const before = r.current;
  r.current -= n;
  pushLog(c, `${ch.name} 用掉「${k}」${n}（剩 ${r.current}/${r.max}）`);
  return { key: k, before, resource: r };
}

/** 恢复资源；amount 省略时回满 */
export function restoreResource(c: Campaign, name: string, key: string, amount?: number): { key: string; before: number; resource: Resource } {
  const ch = requireCharacter(c, name);
  const [k, r] = requireResource(ch, key);
  const before = r.current;
  r.current = amount === undefined ? r.max : Math.min(r.max, r.current + Math.max(0, Math.trunc(amount)));
  pushLog(c, `${ch.name} 恢复「${k}」到 ${r.current}/${r.max}`);
  return { key: k, before, resource: r };
}

export interface RestResult {
  name: string;
  lines: string[];
}

/**
 * 休息。短休：short 资源回满，可花生命骰（spend: 角色名 → 骰数）回血；
 * 长休：HP 回满、所有 short/long 资源回满、生命骰回一半（至少 1）。战斗中不能休息。
 */
export function rest(
  c: Campaign,
  kind: 'short' | 'long',
  names?: string[],
  spend: Record<string, number> = {},
  roller: Roller = cryptoRoller,
): RestResult[] {
  if (c.initiative !== undefined) throw new Error('战斗中不能休息');
  delete c.hexbladeCurses;
  const members = names === undefined || names.length === 0
    ? c.characters.filter((ch) => ch.kind !== 'monster' && !isOut(ch) && !isAbsent(ch))
    : names.map((n) => requireCharacter(c, n));
  const absentMembers = members.filter(isAbsent);
  if (absentMembers.length > 0) {
    throw new Error(`${absentMembers.map((ch) => ch.name).join('、')} 本次未签到、已暂时移出队伍，不参与休息（等本人点「签到」归队或 dnd_character update absent=false）`);
  }
  const spendFor = new Map<Character, number>();
  for (const [n, dice] of Object.entries(spend)) spendFor.set(requireCharacter(c, n), dice);
  const results = members.map((ch) => {
    const lines: string[] = [];
    for (const [k, r] of Object.entries(ch.resources ?? {})) {
      if ((r.reset === 'short' || (kind === 'long' && r.reset === 'long')) && r.current < r.max) {
        r.current = r.max;
        lines.push(`${k} 回满 ${r.max}`);
      }
    }
    if (kind === 'short') {
      // 短休（1 小时 = 600 轮）：清除 1 小时及以内的短时状态，保留超过 600 轮的长效状态/专注（如 3 环 8 小时脆弱诅咒/猎人印记）并扣减 600 轮
      if (ch.activeStates !== undefined) {
        const kept: ActiveState[] = [];
        const expiredNames: string[] = [];
        for (const s of ch.activeStates) {
          if (s.expires !== undefined) {
            expiredNames.push(s.name);
          } else if (s.roundsLeft !== undefined) {
            if (s.roundsLeft > 600) kept.push({ ...s, roundsLeft: s.roundsLeft - 600 });
            else expiredNames.push(s.name);
          } else {
            kept.push(s);
          }
        }
        if (kept.length > 0) ch.activeStates = kept;
        else delete ch.activeStates;
        for (const t of expiredNames) {
          const norm = normalizeCondition(t);
          if (!(ch.activeStates?.some((x) => normalizeCondition(x.name) === norm) ?? false)) {
            ch.conditions = ch.conditions.filter((cond) => normalizeCondition(cond) !== norm);
          }
        }
      }
      if (ch.concentrationState !== undefined) {
        const cs = ch.concentrationState;
        if (cs.roundsLeft !== undefined) {
          if (cs.roundsLeft > 600) {
            cs.roundsLeft -= 600;
            lines.push(`维持专注「${cs.name}」（剩余约 ${Math.round((cs.roundsLeft / 600) * 10) / 10} 小时）`);
          } else {
            delete ch.concentrationState;
          }
        }
      }
      const dice = Math.max(0, Math.trunc(spendFor.get(ch) ?? 0));
      if (dice > 0) {
        if (ch.hitDie === undefined) throw new Error(`${ch.name} 没记录生命骰，先 dnd_character update hit_die（如 d10）`);
        const left = ch.level - (ch.hitDiceUsed ?? 0);
        if (dice > left) throw new Error(`${ch.name} 只剩 ${left} 颗生命骰`);
        const con = abilityModifier(ch.abilities.con);
        let healed = 0;
        const rolls: string[] = [];
        const sides = Number(ch.hitDie.replace(/^\d*d/i, ''));
        if (!Number.isInteger(sides) || sides < 2) throw new Error(`${ch.name} 的生命骰「${ch.hitDie}」写法不对，应为 d6/d8/d10/d12`);
        for (let i = 0; i < dice; i++) {
          const face = roller(sides);
          const gain = Math.max(0, face + con);
          healed += gain;
          rolls.push(`${ch.hitDie}[${face}]${con >= 0 ? '+' : ''}${con}`);
        }
        ch.hitDiceUsed = (ch.hitDiceUsed ?? 0) + dice;
        for (const [rk, rr] of Object.entries(ch.resources ?? {})) {
          if (rk.startsWith('生命骰') && rr.max === ch.level) rr.current = Math.max(0, ch.level - ch.hitDiceUsed);
        }
        const before = ch.hp;
        const effMax = effectiveMaxHp(ch);
        if (!ch.conditions.includes('死亡')) ch.hp = Math.min(effMax, ch.hp + healed);
        lines.push(`生命骰 ${rolls.join(' ')} = ${healed}，HP ${before}→${ch.hp}/${effMax}（剩 ${ch.level - ch.hitDiceUsed} 颗）`);
      }
    } else {
      breakConcentration(c, ch.name);
      delete ch.concentrationState;
      if (ch.activeStates !== undefined) {
        const timed = ch.activeStates.filter((s) => s.roundsLeft !== undefined || s.expires !== undefined || s.concentration === true).map((s) => s.name);
        for (const t of timed) removeActiveState(ch, t);
      }
      const exh = exhaustionLevel(ch);
      if (exh > 0) {
        removeActiveState(ch, '力竭');
        if (exh > 1) {
          upsertActiveState(c, ch, { name: `力竭:${exh - 1}` });
          lines.push(`力竭减轻为 ${exh - 1} 级`);
        } else {
          lines.push('解除力竭');
        }
      }
      const before = ch.hp;
      const effMax = effectiveMaxHp(ch);
      ch.hp = effMax;
      ch.tempHp = 0;
      delete ch.deathSaves;
      removeActiveState(ch, '昏迷');
      removeActiveState(ch, '稳定');
      if (before < effMax) lines.push(`HP ${before}→${effMax}`);
      if ((ch.hitDiceUsed ?? 0) > 0) {
        const regained = Math.min(ch.hitDiceUsed ?? 0, Math.max(1, Math.floor(ch.level / 2)));
        ch.hitDiceUsed = (ch.hitDiceUsed ?? 0) - regained;
        lines.push(`生命骰回 ${regained} 颗`);
      }
    }
    return { name: ch.name, lines };
  });
  pushLog(c, `${kind === 'short' ? '短休' : '长休'}：${results.map((r) => r.name).join('、')}`);
  return results;
}

/** 增减物品与金币 */
export function changeInventory(c: Campaign, name: string, add: string[] = [], remove: string[] = [], gpDelta = 0): Character {
  const ch = requireCharacter(c, name);
  const items = [...(ch.inventory ?? [])];
  for (const item of remove) {
    const q = item.trim();
    const idx = items.findIndex((x) => x === q);
    const fuzzy = idx === -1 ? items.findIndex((x) => x.includes(q)) : idx;
    if (fuzzy === -1) throw new Error(`${ch.name} 身上没有「${item}」。现有：${items.join('、') || '无'}`);
    items.splice(fuzzy, 1);
  }
  for (const item of add) if (item.trim().length > 0) items.push(item.trim());
  ch.inventory = items;
  if (gpDelta !== 0) {
    const gp = (ch.gp ?? 0) + Math.trunc(gpDelta);
    if (gp < 0) throw new Error(`${ch.name} 只有 ${ch.gp ?? 0} gp`);
    ch.gp = gp;
  }
  if (add.length > 0 || remove.length > 0 || gpDelta !== 0) {
    pushLog(c, `${ch.name} 物品${add.length > 0 ? ` +${add.join('、')}` : ''}${remove.length > 0 ? ` -${remove.join('、')}` : ''}${gpDelta !== 0 ? ` ${gpDelta > 0 ? '+' : ''}${gpDelta}gp` : ''}`);
  }
  return ch;
}

export function resourceTag(ch: Character, c?: Campaign): string {
  const entries = Object.entries(ch.resources ?? {});
  const hitDiceKeys = entries.map(([k]) => k).filter((k) => k.startsWith('生命骰'));
  const preferredHitDieKey = hitDiceKeys.length > 1
    ? (hitDiceKeys.find((k) => k.length > '生命骰'.length) ?? hitDiceKeys.at(-1))
    : undefined;
  const parts = entries
    .filter(([k]) => preferredHitDieKey === undefined || !k.startsWith('生命骰') || k === preferredHitDieKey)
    .map(([k, r]) => `${k}${r.current}/${r.max}`);
  if (c?.initiative !== undefined && inInitiative(c, ch.name)) parts.push(`反应${reactionBlocked(c, ch.name) === undefined && canReact(ch) ? 1 : 0}/1`);
  const hasHitDieResource = hitDiceKeys.length > 0;
  if (ch.hitDie !== undefined && !hasHitDieResource) parts.push(`生命骰${ch.level - (ch.hitDiceUsed ?? 0)}/${ch.level}`);
  return parts.length > 0 ? ` {${parts.join(' ')}}` : '';
}

// ── 结团摘要 ──

export function addSummary(c: Campaign, text: string, now = Date.now()): void {
  const value = text.trim();
  if (value.length === 0) return;
  if (value.length > SUMMARY_MAX_CHARS) {
    throw new Error(`进度共 ${value.length} 字，超过 ${SUMMARY_MAX_CHARS} 字，未保存、旧进度保留。请用 summary 精简后整份重写；增量修改旧摘要时可用 set={"旧进度":""} 移除已核对的旧段，保留未结事项。`);
  }
  c.summaries.push({ at: now, text: value, room: c.currentRoom, state: campaignState(c) });
  if (c.summaries.length > MAX_SUMMARIES) c.summaries.splice(0, c.summaries.length - MAX_SUMMARIES);
}

/** 元数据变化不代表剧情推进；备团计划和停团过渡标记也不能混进已发生事实。 */
export function campaignState(c: Campaign): string {
  const { summaries, handoff, preparation, lastCombat, endPrep, active, updatedAt, sessionStartedAt, rollSeq, ...state } = c;
  const normalized = state.characters === undefined
    ? state
    : { ...state, characters: state.characters.map(({ absent: _absent, delegated: _delegated, ...rest }) => rest) };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function fitHandoff(lines: string[], budget = 1000): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of [...lines].reverse()) {
    if (used + line.length + 1 > budget) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  if (kept.length < lines.length) kept.unshift(`（另有 ${lines.length - kept.length} 条未展示，请 dnd_chronicle search 核对；近期日志也可用 dnd_prepare show 看）`);
  return kept;
}

/**
 * 两个结团入口共用的交接：旧摘要完整保留，摘要之后的工具事实另存。
 * 不能只看「本场写过一次」：早先存过档，后半场仍可能推进了剧情。
 */
export function ensureSessionSummary(c: Campaign, now = Date.now()): boolean {
  const last = c.summaries.at(-1);
  const changed = last?.state !== campaignState(c);
  const since = last?.at ?? c.sessionStartedAt ?? 0;
  const events = changed ? (c.chronicle ?? []).filter((e) => e.at >= since).map((e) => `- ${e.text}`) : [];
  const changes = fitHandoff(events.length > 0 ? events : changed ? c.log.slice(-5).map((line) => `- 近期日志（可能含存档前内容）：${line}`) : []);
  c.handoff = { at: now, room: c.currentRoom, changes, needsReview: changed || last === undefined || /【[^】\n]*$/.test(last.text) };
  if (last !== undefined || changes.length === 0) return changes.length > 0;
  addSummary(c, `【自动交接】\n工具记录，尚未人工核对具体停点与玩家决定：\n${changes.join('\n')}`, now);
  return true;
}

// ── 每回合注入的精简摘要 ──

function hpTag(ch: Character, c?: Campaign, globalEffects?: Record<string, CustomEffectDef>): string {
  const temp = ch.tempHp > 0 ? `+${ch.tempHp}` : '';
  const extConc = c !== undefined ? externalConcentrationTags(c, ch) : [];
  const tags = [...ch.conditions, ...extConc];
  const cond = tags.length > 0 ? ` [${tags.join(',')}]` : '';
  return `${ch.name} ${ch.hp}${temp}/${ch.maxHp} AC${armorClass(c, ch, globalEffects)}${cond}`;
}

function ongoingSummary(c: Campaign): string[] {
  const effects = c.characters.flatMap((ch) => inInitiative(c, ch.name) ? ongoingEffects(ch).map((effect) => {
    const timing = effect.repeatSave?.timing;
    const rules = [
      timing === undefined ? '' : `${timing === 'target_turn_start' ? '回合开始' : '回合末'}自动复豁免`,
      effect.endOnDamage ? '受伤解除' : '',
      effect.wakeAsAction ? '可唤醒' : '',
      effect.zeroSpeed ? '速度0' : '',
    ].filter(Boolean);
    return `${ch.name}·${effect.name}${rules.length > 0 ? `（${rules.join('、')}）` : ''}`;
  }) : []);
  return effects.length > 0 ? [`持续减益：${effects.join('；')}`] : [];
}

/** 队伍主位置所在的场景，以及这个场景探索了几个房间 */
export function explored(c: Campaign, adv: Adventure): { site: Site | undefined; seen: number; total: number } {
  const site = siteOfRoom(adv, c.currentRoom);
  // 城镇只数玩家知道的地点，不然分母会泄露还有几个藏着的地方
  const rooms = (site?.rooms ?? []).filter((r) => !isHub(site) || locationKnown(c, adv, r));
  return { site, seen: rooms.filter((r) => c.revealed.includes(r.id)).length, total: rooms.length };
}

export function summarize(c: Campaign, adv: Adventure): string {
  const graph = roomGraph(adv);
  const room = findRoom(graph, c.currentRoom);
  const { site, seen, total } = explored(c, adv);
  const lines: string[] = [];
  const where = adv.sites.length > 1
    ? `${adv.name}｜${isHub(site) ? '城镇' : '场景'}：${site?.name ?? '?'}`
    : `${isHub(site) ? '城镇' : '地城'}：${site?.name ?? adv.name}`;
  lines.push(`${where}｜当前房间：${room?.name ?? c.currentRoom}（${c.currentRoom}）｜已探索 ${seen}/${total}`);
  const last = c.summaries.at(-1);
  const scene = last?.room === c.currentRoom ? parseProgress(last.text).find((s) => s.name === '位置') : undefined;
  if (scene !== undefined) lines.push(`具体叙事位置（最近存档）：${scene.lines.join('；')}；房间 ID 可能只表示大区域，别把它当成重新出发。`);
  const exits = visibleExits(c, adv).map((e) => `${e.name}(${e.to})${e.locked === true ? '[过不去]' : ''}`).join('、');
  lines.push(`可见出口：${exits || '无'}`);

  const activeParty = c.characters.filter((ch) => ch.kind !== 'monster' && !isAbsent(ch) && !isStationedNpc(ch));
  const stationedNpcs = c.characters.filter(isStationedNpc);
  const absentParty = c.characters.filter(isAbsent);
  lines.push(`队伍：${activeParty.length > 0 ? activeParty.map((ch) => `${hpTag(ch, c)}${ch.player ? `〈${ch.player}〉` : ''}${delegationTag(ch) ? `[${delegationTag(ch)}]` : ''}${resourceTag(ch, c)}`).join('；') : '还没有角色卡'}`);
  if (stationedNpcs.length > 0) {
    lines.push(`留守/退队 NPC：${stationedNpcs.map((ch) => `${ch.name}[${companionStatusTag(ch)}@${findRoom(graph, roomOf(c, ch) ?? '')?.name ?? roomOf(c, ch) ?? '?'}]`).join('、')}`);
  }
  if (absentParty.length > 0) {
    lines.push(`暂离队伍（未签到，不参与探索/战斗）：${absentParty.map((ch) => `${ch.name}${ch.player ? `〈${ch.player}〉` : ''}`).join('、')}（点「签到」自动归队，或本人明确要求加入时 dnd_character update absent=false）`);
  }
  const positions = partyPositions(c);
  if (positions.size > 1) {
    lines.push(`队伍分头行动：${[...positions].map(([room, members]) => `${findRoom(graph, room)?.name ?? room}：${members.map((ch) => ch.name).join('、')}`).join('｜')}`);
  }

  const occupied = positions.size > 1 ? [...positions.keys()] : [c.currentRoom];
  for (const room of occupied) {
    const foes = c.characters.filter((ch) => ch.kind === 'monster' && ch.room === room && !isOut(ch));
    if (foes.length > 0) {
      const at = room === c.currentRoom ? '本房间' : `「${findRoom(graph, room)?.name ?? room}」`;
      lines.push(`${at}敌人：${foes.map((ch) => `${ch.name}${ch.conditions.length > 0 ? ` [${ch.conditions.join(',')}]` : ''} ${woundLabel(ch)}`).join('；')}`);
    }
  }

  if (c.initiative !== undefined) {
    const s = c.initiative;
    const order = s.order.map((e, i) => (i === s.turn ? `▶${e.name}(${e.init})` : `${e.name}(${e.init})`)).join(' > ');
    lines.push(`${s.rehearsal === true ? '【演练模式·战后自动还原状态与场地图】' : ''}战斗第 ${s.round} 轮：${order}`);
    lines.push(...battleLines(c, (id) => findRoom(graph, id)?.name ?? id));
    lines.push(...ongoingSummary(c));
    if (s.reacted?.length) lines.push(`已用反应：${s.reacted.join('、')}`);
    if (s.fightingSpirit?.length) lines.push(`战斗英姿生效：${s.fightingSpirit.join('、')}（本回合武器攻击自动具优势）`);
    if (c.hexbladeCurses?.length) {
      lines.push(`咒剑诅咒生效：${c.hexbladeCurses.map((x) => {
        const caster = findCharacter(c, x.caster);
        const bonus = caster === undefined ? 0 : proficiencyBonus(caster.level);
        return `${x.caster}→${x.target}（19-20 重击，伤害自动 +${bonus}，勿在 damage 重复填常数）`;
      }).join('；')}`);
    }
    if (s.shielded?.length) lines.push(`护盾术生效：${s.shielded.join('、')}（到各自下回合开始）`);
    if (s.disengaged?.length) lines.push(`本回合已撤离：${s.disengaged.join('、')}`);
    if (s.counterAttacks?.length) lines.push(`待还击（反应已扣）：${s.counterAttacks.map((r) => `${r.by}→${r.target}·${r.name}`).join('、')}，原攻击落账后 dnd_check attack reaction=true；不再另扣反应。`);
    if (s.moved && Object.keys(s.moved).length) lines.push(`本回合已移动：${Object.entries(s.moved).map(([name, feet]) => `${name} ${feet}尺`).join('、')}`);
    if (s.dashed?.length) lines.push(`本回合已冲刺：${s.dashed.join('、')}`);
    if (s.surprised?.length) lines.push(`受惊：${s.surprised.join('、')}`);
    if (s.pending !== undefined) lines.push(pendingSummaryLine(s.pending));
    if (s.movement !== undefined) lines.push(pendingSummaryLine(s.movement));
  } else if (c.pending !== undefined) {
    lines.push(pendingSummaryLine(c.pending));
  }
  lines.push(...storySummaryLines(c, adv, occupied));
  if (c.log.length > 0) lines.push(`最近：${c.log.slice(-SUMMARY_LOG_LINES).join('；')}`);
  return lines.join('\n');
}

/** 专用战斗子代理的精简动态战况：只含当前战场、参战生物血量/状态/资源、先攻站位区域与待结算窗口，不含全图出口、场外角色全资源和主线剧情线索。 */
export function summarizeCombat(
  c: Campaign,
  adv: Adventure,
  globalEffects?: Record<string, CustomEffectDef>,
): string {
  const graph = roomGraph(adv);
  const room = findRoom(graph, c.currentRoom);
  const lines: string[] = [];
  lines.push(`当前战场：${room?.name ?? c.currentRoom}（${c.currentRoom}）`);

  const s = c.initiative;
  const activeRooms = fightRooms(c);
  if (activeRooms.size === 0) activeRooms.add(c.currentRoom);
  const participantSet = new Set([
    ...(s?.order.map((e) => e.name) ?? []),
    ...(s?.allParticipants ?? []),
  ]);

  const party = c.characters.filter((ch) => ch.kind !== 'monster' && !isAbsent(ch));
  const combatParty = party.filter((ch) =>
    participantSet.has(ch.name)
    || (s?.rehearsal !== true && (ch.hp === 0 || ch.conditions.includes('昏迷') || ch.conditions.includes('稳定')) && activeRooms.has(roomOf(c, ch) ?? '')),
  );
  const bystanders = s?.rehearsal === true
    ? []
    : party.filter((ch) => !combatParty.includes(ch) && !isOut(ch) && activeRooms.has(roomOf(c, ch) ?? ''));

  if (combatParty.length > 0) {
    lines.push(`参战我方：${combatParty.map((ch) => `${hpTag(ch, c, globalEffects)}${ch.player ? `〈${ch.player}〉` : ''}${delegationTag(ch) ? `[${delegationTag(ch)}]` : ''}${resourceTag(ch, c)}`).join('；')}`);
  }
  if (bystanders.length > 0) {
    lines.push(`同房未入战：${bystanders.map((ch) => ch.name).join('、')}（中途入战先 dnd_initiative join）`);
  }

  const foes = c.characters.filter((ch) =>
    ch.kind === 'monster'
    && !isOut(ch)
    && (inInitiative(c, ch.name) || (s?.rehearsal !== true && activeRooms.has(ch.room ?? ''))),
  );
  if (foes.length > 0) {
    lines.push(`敌方：${foes.map((ch) => `${ch.name}${!inInitiative(c, ch.name) ? '(未入先攻)' : ''}${ch.conditions.length > 0 ? ` [${ch.conditions.join(',')}]` : ''} ${woundLabel(ch)}`).join('；')}`);
  }

  if (s !== undefined) {
    const order = s.order.map((e, i) => (i === s.turn ? `▶${e.name}(${e.init})` : `${e.name}(${e.init})`)).join(' > ');
    lines.push(`${s.rehearsal === true ? '【演练模式·战后自动还原状态与场地图】' : ''}战斗第 ${s.round} 轮：${order}`);
    lines.push(...battleLines(c, (id) => findRoom(graph, id)?.name ?? id));
    lines.push(...ongoingSummary(c));
    if (s.reacted?.length) lines.push(`已用反应：${s.reacted.join('、')}`);
    if (s.fightingSpirit?.length) lines.push(`战斗英姿生效：${s.fightingSpirit.join('、')}（本回合武器攻击自动具优势）`);
    if (c.hexbladeCurses?.length) {
      lines.push(`咒剑诅咒生效：${c.hexbladeCurses.map((x) => {
        const caster = findCharacter(c, x.caster);
        const bonus = caster === undefined ? 0 : proficiencyBonus(caster.level);
        return `${x.caster}→${x.target}（19-20 重击，伤害自动 +${bonus}，勿在 damage 重复填常数）`;
      }).join('；')}`);
    }
    if (s.shielded?.length) lines.push(`护盾术生效：${s.shielded.join('、')}（到各自下回合开始）`);
    if (s.disengaged?.length) lines.push(`本回合已撤离：${s.disengaged.join('、')}`);
    if (s.counterAttacks?.length) lines.push(`待还击（反应已扣）：${s.counterAttacks.map((r) => `${r.by}→${r.target}·${r.name}`).join('、')}，原攻击落账后 dnd_check attack reaction=true；不再另扣反应。`);
    if (s.moved && Object.keys(s.moved).length) lines.push(`本回合已移动：${Object.entries(s.moved).map(([name, feet]) => `${name} ${feet}尺`).join('、')}`);
    if (s.dashed?.length) lines.push(`本回合已冲刺：${s.dashed.join('、')}`);
    if (s.surprised?.length) lines.push(`受惊：${s.surprised.join('、')}`);
    if (s.pending !== undefined) lines.push(pendingSummaryLine(s.pending));
    if (s.movement !== undefined) lines.push(pendingSummaryLine(s.movement));
  } else if (c.pending !== undefined) {
    lines.push(pendingSummaryLine(c.pending));
  }
  return lines.filter((l) => l.length > 0).join('\n');
}

/**
 * 给玩家看的团况：PC 的 HP/资源、敌人只给伤势词、先攻顺序、站位；不含 DM 笔记和怪物数值。
 * viewer 是看的人的 openid：战斗中多给一行他的角色到各人的距离。
 * markdown：站位画成代码块里的字符网格（只有 markdown 消息等宽）；纯文本消息退回坐标列表。
 * 探索进度、出口这些 /dnd map 已经有的不在这里重复。
 */
/** format=image：战斗图下方只保留敌人伤势与先攻（我方血量合在图例里，不刷长串资源与异地角色） */
export function playerStatus(c: Campaign, adv: Adventure, viewer?: string, format: 'text' | 'markdown' | 'image' = 'text'): string {
  const lines: string[] = [];
  const graph = roomGraph(adv);
  if (format === 'image' && c.initiative !== undefined) {
    const s = c.initiative;
    const activeRooms = fightRooms(c);
    if (activeRooms.size === 0) activeRooms.add(c.currentRoom);
    const foes = c.characters.filter(
      (ch) => ch.kind === 'monster' && !isOut(ch)
        && (inInitiative(c, ch.name) || (!hiddenFromPlayers(ch) && activeRooms.has(ch.room ?? ''))),
    );
    if (foes.length > 0) {
      lines.push(`敌人：${foes.map((ch) => `${ch.name}（${woundLabel(ch)}${ch.conditions.length > 0 ? `，${ch.conditions.join(',')}` : ''}）`).join('、')}`);
    }
    lines.push(`⚔ 第 ${s.round} 轮：${s.order.map((e, i) => (i === s.turn ? `▶${e.name}` : e.name)).join(' → ')}`);
    if (s.pending !== undefined) lines.push(`⏳ ${describePending(s.pending)}还没结算，等反应`);
    if (s.movement !== undefined) lines.push(`⏳ ${s.movement.swapWith !== undefined ? `${s.movement.target} 请求与 ${s.movement.swapWith} 交换站位` : `${s.movement.target} 暂停移动，等借机反应`}`);
    return lines.join('\n');
  }
  const room = findRoom(graph, c.currentRoom);
  const site = siteOfRoom(adv, c.currentRoom);
  if (c.initiative === undefined) {
    lines.push(`📍 ${adv.sites.length > 1 && site !== undefined ? `${site.name} · ` : ''}${room?.name ?? c.currentRoom}`);
    const positions = partyPositions(c);
    for (const [roomId, members] of positions) {
      const where = positions.size > 1 ? `${findRoom(graph, roomId)?.name ?? roomId}：` : '';
      lines.push(`${where}${members.map((ch) => {
        const tags = [...ch.conditions, ...externalConcentrationTags(c, ch)];
        return `${ch.name} ${ch.hp}/${ch.maxHp}${tags.length > 0 ? `[${tags.join(',')}]` : ''}${resourceTag(ch)}`;
      }).join('；')}`);
    }
    const foes = c.characters.filter((ch) => ch.kind === 'monster' && !isOut(ch) && positions.has(ch.room ?? ''));
    if (foes.length > 0) lines.push(`敌人：${foes.map((ch) => `${ch.name}（${woundLabel(ch)}${ch.conditions.length > 0 ? `，${ch.conditions.join(',')}` : ''}）`).join('、')}`);
    const absentParty = c.characters.filter(isAbsent);
    if (absentParty.length > 0) {
      lines.push(`💤 暂离（未签到）：${absentParty.map((ch) => ch.name).join('、')}（点「签到」归队）`);
    }
    if (c.pending !== undefined) lines.push(`⏳ ${describePending(c.pending)}还没结算，等反应`);
    return lines.join('\n');
  }
  const s = c.initiative;
  const activeRooms = fightRooms(c);
  if (activeRooms.size === 0) activeRooms.add(c.currentRoom);
  const combatAllies = c.characters.filter((ch) => ch.kind !== 'monster' && !isAbsent(ch) && (inInitiative(c, ch.name) || activeRooms.has(roomOf(c, ch) ?? '')));
  if (combatAllies.length > 0) {
    lines.push(`我方：${combatAllies.map((ch) => `${ch.name} ${ch.hp}/${ch.maxHp}${(ch.tempHp ?? 0) > 0 ? `(+${ch.tempHp})` : ''}`).join('、')}`);
  }
  const foes = c.characters.filter(
    (ch) => ch.kind === 'monster' && !isOut(ch)
      && (inInitiative(c, ch.name) || (!hiddenFromPlayers(ch) && activeRooms.has(ch.room ?? ''))),
  );
  if (foes.length > 0) lines.push(`敌人：${foes.map((ch) => `${ch.name}（${woundLabel(ch)}${ch.conditions.length > 0 ? `，${ch.conditions.join(',')}` : ''}）`).join('、')}`);
  lines.push(`⚔ 第 ${s.round} 轮：${s.order.map((e, i) => (i === s.turn ? `▶${e.name}` : e.name)).join(' → ')}`);
  // 藏起来的怪只是位置保密：名字已经在先攻表里了
  const visible = (ch: Character): boolean => !hiddenFromPlayers(ch);
  const roomName = (id: string): string => findRoom(graph, id)?.name ?? id;
  const grid = format === 'markdown' ? battleGridLines(c, roomName, visible) : undefined;
  lines.push(...(grid ?? battleLines(c, roomName, visible)));
  const mine = viewer === undefined ? [] : c.characters.filter((ch) => isControlledBy(ch, viewer) && !isOut(ch) && !isAbsent(ch) && cellOf(c, ch) !== undefined);
  for (const ch of mine) lines.push(distancesFrom(c, ch.name, visible));
  if (s.pending !== undefined) lines.push(`⏳ ${describePending(s.pending)}还没结算，等反应`);
  if (s.movement !== undefined) lines.push(`⏳ ${s.movement.swapWith !== undefined ? `${s.movement.target} 请求与 ${s.movement.swapWith} 交换站位` : `${s.movement.target} 暂停移动，等借机反应`}`);
  return lines.join('\n');
}

// ── 存储 ──

export interface Snapshot {
  at: number;
  /** 造成这次改动的工具调用，如「dnd_check 恩佐 攻击 巨鼠1」 */
  label: string;
  /** 改动前的整份 campaign JSON */
  state: string;
}

export interface CampaignCheckpoint {
  /** 唯一短编号，如 cp-1 */
  id: string;
  /** 检查点名称，如「开团基线」「开战前」「谈判前」 */
  name: string;
  at: number;
  room: string;
  /** true 表示系统在开团/开战/跨场景等里程碑自动保存 */
  auto?: boolean;
  /** 完整 campaign JSON */
  state: string;
}

function safeFileName(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

export class CampaignStore {
  public readonly root: string;

  public constructor(root: string) {
    this.root = root;
  }

  private pathOf(key: string): string {
    return join(this.root, `${safeFileName(key)}.json`);
  }

  public load(key: string): Campaign | undefined {
    const path = this.pathOf(key);
    if (!existsSync(path)) return undefined;
    try {
      return parseCampaign(readFileSync(path, 'utf8'));
    } catch {
      return undefined;
    }
  }

  public save(c: Campaign, now = Date.now()): void {
    c.updatedAt = now;
    writeJsonAtomic(this.pathOf(c.key), c, { indent: 2, trailingNewline: true });
  }

  /** 把旧团改名存档（重新开新团时用），返回存档文件名 */
  public archive(key: string, now = Date.now()): string | undefined {
    const path = this.pathOf(key);
    if (!existsSync(path)) return undefined;
    const archived = join(this.root, `${safeFileName(key)}.${now}.json`);
    renameSync(path, archived);
    return archived;
  }

  /**
   * 读取 → 修改 → 保存；fn 抛错时不保存。改动前的状态存一份快照，供 undo 回滚。
   * label 可以是函数：骰子编号在 fn 里才分配，标签要等它跑完再取。
   */
  public update<T>(
    key: string,
    fn: (c: Campaign) => T,
    label: string | (() => string) = '改动',
    options: { allowPaused?: boolean; recordHistory?: boolean } = {},
  ): T {
    const c = this.load(key);
    if (c === undefined || (!c.active && !options.allowPaused)) throw new Error('这个群还没有进行中的团。让玩家发送 /dnd start 开团');
    const before = JSON.stringify(c);
    const beforeRoom = c.currentRoom;
    const wasInCombat = c.initiative !== undefined;
    const seqBefore = c.rollSeq;
    const result = fn(c);
    if (JSON.stringify(c) !== before) {
      // 只多掷了一骰（没有后果的检定）或纯反应窗口去重记录不占快照：快照有上限，别让它挤掉真正能撤的改动
      const onlyCounter = JSON.stringify({ ...c, rollSeq: seqBefore }) === before;
      if (!onlyCounter && options.recordHistory !== false) {
        this.pushSnapshot(key, { at: Date.now(), label: typeof label === 'function' ? label() : label, state: before }, c.initiative !== undefined);
        if (!wasInCombat && c.initiative !== undefined) {
          this.saveCheckpoint(key, '开战前', { auto: true, state: before, room: beforeRoom });
        }
      }
      this.save(c);
    }
    return result;
  }

  private historyPath(key: string): string {
    return join(this.root, 'history', `${safeFileName(key)}.json`);
  }

  private checkpointsPath(key: string): string {
    return join(this.root, 'checkpoints', `${safeFileName(key)}.json`);
  }

  public snapshots(key: string): Snapshot[] {
    const path = this.historyPath(key);
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Snapshot[];
    } catch {
      return [];
    }
  }

  public checkpoints(key: string): CampaignCheckpoint[] {
    const path = this.checkpointsPath(key);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed as CampaignCheckpoint[] : [];
    } catch {
      return [];
    }
  }

  private writeCheckpoints(key: string, list: CampaignCheckpoint[]): void {
    writeJsonAtomic(this.checkpointsPath(key), list);
  }

  /**
   * 保存一个命名/里程碑检查点，不随 40 步细粒度 undo 历史被挤掉。
   * 达到上限时优先淘汰最早的自动检查点，保护手动命名检查点。
   */
  public saveCheckpoint(
    key: string,
    name: string,
    options: { auto?: boolean; state?: string; room?: string; now?: number } = {},
  ): CampaignCheckpoint {
    const label = name.trim();
    if (label.length === 0) throw new Error('检查点名称不能为空');
    const live = options.state === undefined ? this.load(key) : undefined;
    if (options.state === undefined && live === undefined) {
      throw new Error('这个群还没有团档，不能保存检查点');
    }
    const state = options.state ?? JSON.stringify(live!);
    const room = options.room ?? live?.currentRoom ?? parseCampaign(state)?.currentRoom ?? '';
    const list = this.checkpoints(key);
    const newest = list.at(-1);
    if (options.auto === true && newest !== undefined && newest.state === state && newest.name === label) {
      return newest;
    }
    let maxNum = 0;
    for (const cp of list) {
      const m = /^cp-(\d+)$/.exec(cp.id);
      if (m !== null) maxNum = Math.max(maxNum, Number(m[1]));
    }
    const created: CampaignCheckpoint = {
      id: `cp-${maxNum + 1}`,
      name: label,
      at: options.now ?? Date.now(),
      room,
      ...(options.auto === true ? { auto: true } : {}),
      state,
    };
    list.push(created);
    while (list.length > MAX_CHECKPOINTS) {
      const autoIdx = list.findIndex((cp) => cp.auto === true);
      list.splice(autoIdx >= 0 ? autoIdx : 0, 1);
    }
    this.writeCheckpoints(key, list);
    return created;
  }

  /**
   * 一步恢复到指定检查点（按 id 如 cp-2 / 2，或名称精确/模糊匹配最新一条）。
   * 恢复前会把当前状态压入普通撤销栈，误回退也能一步撤回。
   */
  public restoreCheckpoint(key: string, target: string): { checkpoint: CampaignCheckpoint; restored: Campaign } {
    const q = target.trim();
    if (q.length === 0) throw new Error('请提供要恢复的检查点编号（如 cp-1）或名称');
    const list = this.checkpoints(key);
    if (list.length === 0) throw new Error('还没有保存过检查点；用 dnd_undo action=checkpoint 保存，或用 steps/roll 回退');
    const lower = q.toLowerCase();
    const idQuery = /^\d+$/.test(q) ? `cp-${q}` : lower;
    const rev = [...list].reverse();
    const matched = rev.find((cp) => cp.id.toLowerCase() === idQuery)
      ?? rev.find((cp) => cp.name === q)
      ?? rev.find((cp) => cp.name.toLowerCase().includes(lower));
    if (matched === undefined) {
      const avail = rev.slice(0, 8).map((cp) => `${cp.id}「${cp.name}」`).join('、');
      throw new Error(`找不到检查点「${q}」。可用：${avail}`);
    }
    const restored = parseCampaign(matched.state);
    if (restored === undefined) throw new Error(`检查点 ${matched.id} 格式不认识，没法恢复`);
    const live = this.load(key);
    if (live !== undefined) {
      this.pushSnapshot(
        key,
        { at: Date.now(), label: `恢复检查点 ${matched.id}「${matched.name}」前`, state: JSON.stringify(live) },
        live.initiative !== undefined,
      );
    }
    this.applyRestoreInvariants(restored, live);
    this.save(restored);
    return { checkpoint: matched, restored };
  }

  private applyRestoreInvariants(restored: Campaign, live: Campaign | undefined): void {
    const liveAbsent = new Set((live?.characters ?? []).filter(isAbsent).map((ch) => ch.name));
    restored.active = live?.active ?? true;
    // 签到暂离/归队属本次出勤，不随游戏状态回滚
    for (const ch of restored.characters) {
      if (ch.kind !== 'pc') continue;
      if (liveAbsent.has(ch.name)) {
        setCharacterAbsent(restored, ch.name, true, { silent: true });
      } else if (ch.absent === true) {
        delete ch.absent;
        ch.room = restored.currentRoom;
      }
    }
    // 骰子编号不回退：退掉的 #R 不再复用（按钮序号也是它）
    const seq = Math.max(live?.rollSeq ?? 0, restored.rollSeq ?? 0);
    if (seq > 0) restored.rollSeq = seq;
  }

  private pushSnapshot(key: string, snapshot: Snapshot, inCombat = false): void {
    const list = this.snapshots(key);
    list.push(snapshot);
    while (list.length > MAX_SNAPSHOTS) {
      // 战斗进行中保留最近一次开战前的基线快照，避免长战斗超过 40 步后丢掉开战前状态
      let pinned = -1;
      if (inCombat) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (/^dnd_initiative\b.*\baction=start\b/.test(list[i]!.label)) {
            pinned = i;
            break;
          }
        }
      }
      list.splice(pinned === 0 ? 1 : 0, 1);
    }
    this.writeSnapshots(key, list);
  }

  private writeSnapshots(key: string, list: Snapshot[]): void {
    writeJsonAtomic(this.historyPath(key), list);
  }

  /** 撤销最近 steps 次改动，返回被撤销的改动标签（新→旧） */
  public undo(key: string, steps: number): string[] {
    const list = this.snapshots(key);
    const n = Math.min(Math.max(1, Math.trunc(steps)), list.length);
    if (n === 0) throw new Error('没有可以撤销的改动');
    const live = this.load(key);
    const undone = list.splice(list.length - n, n);
    const restored = parseCampaign(undone[0]!.state);
    if (restored === undefined) throw new Error('快照格式不认识，没法撤销');
    this.applyRestoreInvariants(restored, live);
    this.save(restored);
    this.writeSnapshots(key, list);
    return undone.reverse().map((s) => s.label);
  }
}

/** 快照标签里带的骰子编号，如「dnd_check … #R12」 */
export function snapshotRolls(label: string): number[] {
  return [...label.matchAll(/#R(\d+)\b/g)].map((m) => Number(m[1]));
}

/** 这些改动推进过回合、有人中途入战/换房间，或已经结过下一轮检定：按骰子撤销越过它们时要 DM 再确认一次 */
export function crossesTurn(label: string): boolean {
  return /^dnd_initiative .*action=(next|goto|end|join|start)\b|^按钮 结束回合|^dnd_move\b|^dnd_check\b/.test(label);
}
