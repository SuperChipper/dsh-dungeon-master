/**
 * dnd_* 工具共用的部分：参数解析、结果文字、SRD 查询，以及每个工具都要用的会话上下文（createToolKit）。
 *
 * 工具结果只给模型看（showToolResults 对 dnd_* 永远不展示），DM 机密留在这里，
 * 由模型决定哪些说给玩家。团按会话 key 区分：每个群一份。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { DshAgent,SessionManager,SessionRecord } from '../../session/index.ts';
import { recentSenderIds } from '../../session/session-manager.ts';
import type { Logger } from '../../types.ts';
import { ATTITUDES,type Adventure,type Attitude,type Npc,QUEST_STATUSES,type QuestStatus,findNpc,findQuest,roomGraph } from '../adventure.ts';
import { type Advantage,type Roller,rollD20,rollExpression } from '../dice.ts';
import {
type Campaign,
type Character,
type CharacterInput,
type ReactionDef,type HpChange,
type PendingAttack,
type OnHitEffect,
type PendingCheck,
type PendingD20,
type ReactorOption,UNDEAD_FORTITUDE,
applyDamage,armorClass,assertDeclaredByOwner,attackModifier,changeInventory,describePending,findCharacter,initBonusOf,
findWeapon,isOut,inInitiative,isSurprised,
isRangedWeapon,
isTwoHandedWeapon,outsideRooms,nextRollId,pushLog,
recordDeathFailures,resourceTag,reactionBlocked,
requireCharacter,
requireResource,
requireInitiative,roomOf,spawnEncounter,
spendReaction,
spawnMonsters,upsertCharacter,
useResource,
usesGreatWeaponFighting,
weaponAttackModifier,
type Weapon,
weaponDamage
} from '../campaign.ts';
import {
formatEntry,
markChronicle,
openEntries,
recentEntries,
recordChanges,
searchEntries,
seedChronicle
} from '../chronicle.ts';
import type { DndService } from '../dnd-service.ts';
import { exitsOf,findRoom,resolveRoom } from '../dungeon.ts';
import {
type NpcState,
afterChange,
beginAdventure,
fireTrigger,
leadsCard,
learnLead,
npcAlive,
npcBrief,
npcCard,
npcCharacter,
npcCharacterInput,
npcRoom,questCard,
revealFact,
roomBrief,
roomCard,
setChapter,
setFlag,
setQuestStatus,siteCard,
updateNpc
} from '../story.ts';
import { ABILITIES,ABILITY_NAMES,type Ability,type Skill,SKILLS,parseAbility,parseSkill,skillLabel } from '../rules.ts';
import { type SrdEntry,type SrdKind,candidatesText,resolveSrdQuery,zhTable } from '../srd-lookup.ts';
import { type SpellInput,type UrlCheck,spellLine } from '../spell-links.ts';
import {
type Placement,canReact,mapOf,turnPositionNote
} from '../battlefield.ts';
import { areaName,terrainLine } from '../terrain.ts';
import {
assertWindowClosed,
consumesReaction,
declineReaction,findReactor,
holdNotice,pendingHit,
pendingState,
reactionsOf,
refreshReactors,
requirePending,
rollPassed,
waitingOn
} from '../pending-attack.ts';
import {
DEFENSE_NAMES,
type RolledSave,
type SaveOutcome,
type SaveTarget,
applySaveEffect,rollSaveEffect,
saveDamage,parseDefense
} from '../save-effect.ts';

export const DND_TOOL_PREFIX = 'dnd_';

export interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

export interface DndToolDeps {
  service: DndService;
  manager: SessionManager;
  logger: Logger;
  /** 把地图发到当前会话 */
  sendImage(record: SessionRecord, path: string, caption?: string): Promise<void>;
  /** 先攻指针变了（start/next/goto）：轮到 PC 时由按钮模块在回复发完后发「结束回合」按钮 */
  onTurnChange?(record: SessionRecord): void;
  onCombatStart?(record: SessionRecord, field: string): boolean;
  /** 有一笔待结算（新开的，或重掷后有新的人能反应）：回复发完后发反应按钮并开始计时 */
  onPendingAttack?(record: SessionRecord): void;
  /** 群成员短别名（#U3）和 openid 互换；不传时 declared_by / player_id 按原样当 openid */
  members?: MemberIds;
  /** 写法术时验 wiki 链接；测试里替换掉，免得联网 */
  checkUrl?: UrlCheck;
}

/** 模型只看得到群内短别名，要真实 openid 的参数由这里换回去 */
export interface MemberIds {
  /** U3 / #U3（或本群已知的 openid）→ openid；查不到返回 undefined */
  toOpenid(record: SessionRecord, value: string): string | undefined;
  /** openid → 给模型看的别名（如 U3）；没见过的人返回 undefined */
  display(record: SessionRecord, openid: string): string | undefined;
}

/** rolls：这次调用掷的 d20 编号，写进快照标签，dnd_undo roll= 靠它找 */
export type Exec = { agent?: unknown; label?: string; rolls?: number[]; concludeTurn?(): void };

/** declared_by 要和这段时间内真正发过消息的人对得上（覆盖一轮里插进来的消息） */
export const SENDER_WINDOW_MS = 10 * 60 * 1000;

export const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: (value as { text: string }).text }],
};

/**
 * 怪物的 AC、HP 和 DC 干脆不进结果：数字写在正文里会被照抄，包进【机密：…】也一样
 * （11-07 结果写着「命中【机密：AC 13】」「摇摇欲坠【机密：HP 1→7/40】」，群里照样出现「命中 AC 13」「还剩 7 点」）。
 * 成败工具已经判好，DM 用不上这些数字；真要看就 dnd_character show。
 */
/**
 * 原来写「群里只说命中没命中、过没过和伤势词」，DM 读成连骰子也别念，玩家两次要求「攻击和伤害的过程要告诉我们」。
 * 要藏的只是怪物的数值。
 */
export const SECRET_NOTE = '（骰子和加值照写；怪物的 AC、HP、DC 不报，伤势只说伤势词）';
/** 暗骰也要当场交代结果，只是不给数字：静默结算等于让玩家在黑箱里打架 */
export const HIDDEN_ROLL_NOTE = '（暗骰：不报点数和 DC，但要当场说结果：过了/没过，或角色察觉到/没察觉到什么）';

export function parseReactions(value: unknown): ReactionDef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (name.length === 0) throw new Error('reactions 每一项要有 name');
    const def: ReactionDef = { name };
    if (o.when === 'foe_attacks' || o.when === 'attacked' || o.when === 'attacking') def.when = o.when;
    if (typeof o.resource === 'string' && o.resource.trim().length > 0) def.resource = o.resource.trim();
    if (typeof o.range === 'number' && Number.isFinite(o.range) && o.range > 0) def.range = Math.trunc(o.range);
    if (o.counter === true) def.counter = true;
    if (o.enter === true) def.enter = true;
    return def;
  });
}

/** 「-1d6」「+10」「5」：工具掷骰，正负号决定加还是减 */
export function signedRoll(expression: string, roller: Roller): { total: number; detail: string } {
  const m = /^\s*([+-]?)\s*(.+)$/.exec(expression);
  if (m === null) throw new Error(`看不懂修正值「${expression}」，写成 -1d6 或 +10`);
  const result = rollExpression(m[2]!, roller);
  return { total: m[1] === '-' ? -result.total : result.total, detail: `${m[1] === '-' ? '-' : '+'}${result.detail}` };
}

/** 这次攻击的伤害表达式；既没武器也没给 damage 时是 undefined */
export function attackExpression(ch: Character, weapon: Weapon | undefined, extra: string | undefined): string | undefined {
  return weapon !== undefined ? `${weaponDamage(ch, weapon)}${extra !== undefined ? `+${extra}` : ''}` : extra ?? ch.damage;
}

export function rollAttackDamage(ch: Character, weapon: Weapon | undefined, expression: string, crit: boolean, roller: Roller): { total: number; detail: string } {
  const gwf = usesGreatWeaponFighting(ch, weapon)
    ? greatWeaponRoller(roller, diceCount(crit ? critExpression(weapon!.damage) : weapon!.damage))
    : undefined;
  const dmg = rollExpression(crit ? critExpression(expression) : expression, gwf?.roller ?? roller);
  const rerolled = gwf !== undefined && gwf.rerolls.length > 0 ? `（巨武器战斗重投：${gwf.rerolls.join('、')}）` : '';
  return { total: dmg.total, detail: `${dmg.detail}${rerolled}` };
}

/** 把攻击伤害记到目标身上；倒地的 PC 被重击记两次死亡豁免失败（applyDamage 已记一次） */
export function applyAttackDamage(c: Campaign, targetName: string, amount: number, crit: boolean, damageType: string | undefined, roller: Roller): HpChange {
  const change = applyDamage(c, targetName, amount, { crit, damageType, roller });
  const target = requireCharacter(c, targetName);
  if (crit && change.before === 0 && target.kind === 'pc' && !target.conditions.includes('死亡')) {
    change.events.push(...recordDeathFailures(c, target.name, 1));
  }
  return change;
}

export function onHitArg(value: unknown): OnHitEffect | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('on_hit 要是 {name, damage, damage_type, spend}');
  const raw = value as Record<string, unknown>;
  const damage = str(raw.damage), damageType = str(raw.damage_type), spend = str(raw.spend);
  if (damage === undefined || damageType === undefined || spend === undefined) throw new Error('on_hit 要给 damage、damage_type 和 spend（仅最终命中才消耗）');
  // 参数校验不使用真实骰子，避免命中之后才发现表达式不合法、重掷一遍攻击。
  rollExpression(damage, () => 1);
  rollExpression(critExpression(damage), () => 1);
  const defense = parseDefense(raw.defense);
  if (raw.defense !== undefined && defense === undefined) throw new Error('on_hit defense 只能是 resistant/immune/vulnerable');
  return { name: str(raw.name) ?? '命中追加', damage, damageType, spend,
    ...(raw.critical_only === true ? { criticalOnly: true } : {}), ...(defense !== undefined ? { defense } : {}) };
}

/** 同一击的不同伤害分开过抗性，再合并扣血，避免多记死亡豁免或先触发一次不死坚韧。 */
export function settleAttackDamage(c: Campaign, attacker: string, target: string, raw: number, crit: boolean, damageType: string | undefined,
  defense: PendingAttack['defense'], onHit: OnHitEffect | undefined, roller: Roller): string[] {
  let amount = saveDamage(raw, false, 'half', defense);
  let type = amount > 0 ? damageType : undefined;
  const lines: string[] = [];
  if (onHit !== undefined && (!onHit.criticalOnly || crit)) {
    const [, resource] = requireResource(requireCharacter(c, attacker), onHit.spend);
    if (resource.current <= 0) lines.push(`${onHit.name} 未追加：${onHit.spend} 已用完，没有扣资源。`);
    else {
      const spent = useResource(c, attacker, onHit.spend);
      const extra = rollExpression(crit ? critExpression(onHit.damage) : onHit.damage, roller);
      const added = saveDamage(extra.total, false, 'half', onHit.defense);
      amount += added;
      if (added > 0 && /光耀|radiant/i.test(onHit.damageType)) type = '光耀';
      lines.push(`${onHit.name} ${extra.detail} ${onHit.damageType}${onHit.defense !== undefined ? `，${DEFENSE_NAMES[onHit.defense]} → ${added}` : ''}；用掉「${spent.key}」，剩 ${spent.resource.current}/${spent.resource.max}`);
    }
  }
  lines.push(hpLine(applyAttackDamage(c, target, amount, crit, type, roller)));
  return lines;
}

export function parsePlacements(value: unknown): Placement[] {
  if (!Array.isArray(value)) throw new Error('dnd_position: set 要给 placements 数组');
  return value.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (name.length === 0) throw new Error('placements 每一项要有 name');
    const near = typeof o.near === 'string' && o.near.trim().length > 0 ? o.near.trim() : undefined;
    if (o.x === undefined && o.y === undefined && near === undefined) throw new Error(`${name} 要给 x/y，或者 near（摆在门、地标或某人旁边）`);
    return {
      name,
      ...(o.x !== undefined ? { x: o.x as number } : {}),
      ...(o.y !== undefined ? { y: o.y as number } : {}),
      ...(near !== undefined ? { near } : {}),
      ...(o.mark === true ? { mark: true } : {}),
    };
  });
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/** 骰子编号：149、"149"、"R149"、"#R149" 都认；认不出来的原样报错，不悄悄丢掉 */
export function rollIds(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => {
    const match = /^#?R?(\d+)$/i.exec(String(item).trim());
    if (match === null) throw new Error(`骰子编号要像 149 或 R149，收到 ${JSON.stringify(item)}`);
    return Number(match[1]);
  });
}

export function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

/** 开战时的先攻加值表 {角色名: 骰子表达式}；数字也收，转成常数表达式 */
export function initiativeBonusArg(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [rawName, rawExpr] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim();
    const expr = typeof rawExpr === 'number' ? String(rawExpr) : (typeof rawExpr === 'string' ? rawExpr.trim() : '');
    if (name.length > 0 && expr.length > 0) out[name] = expr;
  }
  return out;
}

export function advantageOf(value: unknown): Advantage {
  return value === 'advantage' || value === 'disadvantage' ? value : 'none';
}

/** 新建卡的名字含着一个还活着、还没上场的模组 NPC 的名字或别名（两个字以上） */
/**
 * 死了的也要拦：11-08 存档把内兹纳记成已死，DM 想让他出场时 fight=true 报「已经死了」，
 * 就用 create 现建了一张没挂 npcId 的卡，数值也是现编的（多了一发模组里没有的火球）。
 */
export function moduleNpcNamed(c: Campaign, adventure: Adventure, name: string): Npc | undefined {
  const bare = name.replace(/\d+$/, '');
  return adventure.npcs.find((npc) => {
    if (npcCharacter(c, npc.id) !== undefined) return false;
    const names = [npc.name, ...(npc.aliases ?? [])].filter((n) => n.length >= 2);
    // 死了的只拦同名：「黑蜘蛛的替身」这种冒名的生物要能建
    return npcAlive(c, npc.id) ? names.some((n) => bare.includes(n)) : names.includes(bare);
  });
}

/** 存档记他死了、桌上又说他活着时该怎么办 */
export function reviveHint(npc: Npc): string {
  return `存档记 ${npc.name} 已死。本桌裁定他其实没死，就先 dnd_story npc ${npc.id} alive=true，再 fight=true 或 join=true（数据照模组，要加强用 hp 和 dnd_character update）。`;
}

export function readChronicle(c: Campaign, action: 'search' | 'list', query: string | undefined): string {
  if (action === 'search') {
    if (query === undefined) throw new Error('dnd_chronicle search 要给 query');
    const found = searchEntries(c, query);
    return found.length > 0
      ? found.map(formatEntry).join('\n')
      // 账本有开账时间，查不到不等于没发生：别让模型据此否认玩家
      : `账本里没搜到「${query}」。没记录不等于没发生，换个词再搜，或问玩家。`;
  }
  const open = openEntries(c);
  const recent = recentEntries(c, 15).filter((e) => e.open !== true);
  return [
    `未了结（${open.length}）：${open.length > 0 ? `\n${open.map(formatEntry).join('\n')}` : '无'}`,
    `最近：${recent.length > 0 ? `\n${recent.map(formatEntry).join('\n')}` : '无'}`,
  ].join('\n');
}

/** 刷出来的怪：只留打法要点，HP/AC 不给（见 SECRET_NOTE） */
export function spawnLine(m: { name: string; notes?: string | undefined }): string {
  return `${m.name}${m.notes ? `（${m.notes}）` : ''}`;
}

export function hpLine(change: HpChange): string {
  const temp = change.tempHp > 0 ? `（临时 HP ${change.tempHp}）` : '';
  const absorbed = change.absorbed > 0 ? `，临时 HP 吸收 ${change.absorbed}` : '';
  const events = change.events.length > 0 ? `，${change.events.join('、')}` : '';
  // 怪物只给伤势词，见 SECRET_NOTE
  if (change.wound !== undefined) return `${change.name} ${change.wound}${events}`;
  return `${change.name} HP ${change.before}→${change.after}/${change.maxHp}${temp}${absorbed}${events}`;
}

/** 重击：骰子数量翻倍，常数不变 */
export function critExpression(expression: string): string {
  return expression.replace(/(\d*)d(\d+)/gi, (_m, n: string, sides: string) => `${(n === '' ? 1 : Number(n)) * 2}d${sides}`);
}

/** 表达式里一共有几颗骰子（常数不算） */
export function diceCount(expression: string): number {
  let n = 0;
  for (const m of expression.matchAll(/(\d*)d\d+/gi)) n += m[1] === '' ? 1 : Number(m[1]);
  return n;
}

/**
 * 巨武器战斗：只对前 weaponDice 颗骰（武器本身的伤害骰，表达式里排在最前）掷出 1、2 时重投一次，
 * 必须用新点数。偷袭、神恩之类附加骰不重投。明细里只显示最终点数，重投记在 rerolls 里另报。
 */
export function greatWeaponRoller(roller: Roller, weaponDice: number): { roller: Roller; rerolls: string[] } {
  const rerolls: string[] = [];
  let i = 0;
  return {
    rerolls,
    roller: (sides) => {
      const first = roller(sides);
      if (i++ >= weaponDice || first > 2) return first;
      const second = roller(sides);
      rerolls.push(`${first}→${second}`);
      return second;
    },
  };
}

export function weaponTags(w: Weapon): string {
  const tags = [
    w.magic ? `+${w.magic} 魔法` : '',
    w.proficient === false ? '不熟练' : '',
    isRangedWeapon(w) ? '远程' : '',
    isTwoHandedWeapon(w) ? '双手持' : '',
  ].filter(Boolean);
  return tags.length > 0 ? `［${tags.join('，')}］` : '';
}

/** who：把角色卡上绑定的 openid 换成给模型看的成员编号 */
export function sheet(ch: Character, who: (openid: string) => string = (id) => id, campaign?: Campaign): string {
  const abilities = ABILITIES.map((a) => `${ABILITY_NAMES[a]}${ch.abilities[a]}`).join(' ');
  const lines = [
    `${ch.name}${ch.player ? `〈${ch.player}${ch.playerId ? ` ${who(ch.playerId)}` : ''}〉` : ''}｜${ch.kind === 'pc' ? 'PC' : (ch.kind === 'npc' ? 'NPC' : '怪物')}${ch.className ? ` ${ch.className}` : ''} ${ch.level} 级`,
    `HP ${ch.hp}/${ch.maxHp}${ch.tempHp > 0 ? ` +${ch.tempHp}` : ''}  AC ${armorClass(campaign, ch)}${campaign?.initiative?.shielded?.includes(ch.name) ? `（基础 ${ch.ac}；护盾术 +5，到自己下回合开始）` : ''}${ch.speed !== undefined ? `  速度 ${ch.speed}` : ''}`,
    abilities,
    `固定先攻 ${initBonusOf(ch) >= 0 ? '+' : ''}${initBonusOf(ch)}${ch.initBonus === undefined ? '（敏捷；备注中的额外被动不会自动计入）' : '（角色卡总加值，开战时不要重复添加）'}`,
  ];
  if (ch.skills.length > 0) lines.push(`熟练技能：${ch.skills.map(skillLabel).join('、')}`);
  if ((ch.expertise?.length ?? 0) > 0) lines.push(`专精：${ch.expertise!.map(skillLabel).join('、')}`);
  if (ch.saves.length > 0) lines.push(`熟练豁免：${ch.saves.map((a) => ABILITY_NAMES[a]).join('、')}`);
  if (ch.attackBonus !== undefined || ch.damage !== undefined) lines.push(`攻击 +${attackModifier(ch)} 伤害 ${ch.damage ?? '?'}`);
  for (const w of ch.weapons ?? []) {
    const hit = weaponAttackModifier(ch, w);
    lines.push(`武器 ${w.name}${weaponTags(w)}：命中 ${hit >= 0 ? '+' : ''}${hit}，伤害 ${weaponDamage(ch, w)}${w.notes ? `（${w.notes}）` : ''}`);
  }
  if ((ch.reactions?.length ?? 0) > 0) lines.push(`反应：${ch.reactions!.map((r) => r.name).join('、')}`);
  if ((ch.spells?.length ?? 0) > 0) lines.push(spellLine(ch.spells!));
  const hooks = (ch.hooks ?? []).filter((h) => h.closed !== true);
  if (hooks.length > 0) lines.push(`背景钩子 ${hooks.length} 条（dnd_hook list）`);
  if (ch.conditions.length > 0) lines.push(`状态：${ch.conditions.join('、')}`);
  if (ch.deathSaves !== undefined) lines.push(`死亡豁免：成功 ${ch.deathSaves.successes}/3 失败 ${ch.deathSaves.failures}/3`);
  const resources = Object.entries(ch.resources ?? {}).map(([k, r]) => `${k} ${r.current}/${r.max}（${{ short: '短休回满', long: '长休回满', none: '不回复' }[r.reset]}）`);
  if (campaign?.initiative !== undefined && inInitiative(campaign, ch.name)) resources.push(`反应 ${campaign.initiative.reacted?.includes(ch.name) || !canReact(ch) || isSurprised(campaign, ch.name) ? 0 : 1}/1（自己下回合开始恢复）`);
  if (ch.hitDie !== undefined) resources.push(`生命骰 ${ch.hitDie} ${ch.level - (ch.hitDiceUsed ?? 0)}/${ch.level}`);
  if (resources.length > 0) lines.push(`资源：${resources.join('、')}`);
  if ((ch.inventory?.length ?? 0) > 0 || ch.gp !== undefined) lines.push(`物品：${ch.inventory?.join('、') || '无'}${ch.gp !== undefined ? `；${ch.gp} gp` : ''}`);
  if (ch.traits !== undefined && ch.traits.length > 0) lines.push(`特性：${ch.traits.join('、')}`);
  if (ch.room !== undefined) lines.push(`位置：${ch.room}`);
  if (ch.srd) lines.push(`SRD：${ch.srd}`);
  if (ch.notes) lines.push(`备注：${ch.notes}`);
  return lines.join('\n');
}

/** dnd_character show brief=true：一行状态，够回答「我还剩多少血/法术位」 */
export function characterBrief(c: Campaign, ch: Character): string {
  const room = roomOf(c, ch);
  return `${ch.name} HP ${ch.hp}/${ch.maxHp}${ch.tempHp > 0 ? `+${ch.tempHp}` : ''} AC ${armorClass(c, ch)}`
    + `${ch.conditions.length > 0 ? ` [${ch.conditions.join(',')}]` : ''}${resourceTag(ch, c)}${room !== undefined ? ` @${room}` : ''}`;
}

export function parseSkills(values: string[] | undefined): Skill[] | undefined {
  if (values === undefined) return undefined;
  return values.map((v) => {
    const skill = parseSkill(v);
    if (skill === undefined) throw new Error(`未知技能: ${v}。可用：${Object.values(SKILLS).map((s) => s.name).join('、')}`);
    return skill;
  });
}

export function parseSpellInputs(value: unknown, field: string): SpellInput[] {
  if (!Array.isArray(value)) throw new Error(`${field} 要是数组，如 [{name:"魔能爆", level:0}]`);
  return value.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const level = typeof o.level === 'number' && Number.isInteger(o.level) ? o.level : NaN;
    if (name === '') throw new Error(`${field}[${i}] 缺 name`);
    if (!(level >= 0 && level <= 9)) throw new Error(`${field}[${i}]「${name}」的 level 要是 0-9（戏法填 0）`);
    const en = typeof o.en === 'string' && o.en.trim() !== '' ? o.en.trim() : undefined;
    return { name, level, ...(en !== undefined ? { en } : {}) };
  });
}

export function parseWeapons(value: unknown): Weapon[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((raw) => {
    const w = raw as Record<string, unknown>;
    const name = str(w.name);
    const damage = str(w.damage);
    if (name === undefined || damage === undefined) throw new Error('武器需要 name 和 damage');
    rollExpression(damage); // 只为校验表达式
    const weapon: Weapon = { name, damage };
    if (w.ability === 'str' || w.ability === 'dex') weapon.ability = w.ability;
    const notes = str(w.notes);
    if (notes !== undefined) weapon.notes = notes;
    const magic = int(w.magic);
    if (magic !== undefined && magic !== 0) weapon.magic = Math.max(-3, Math.min(3, magic));
    if (w.proficient === false) weapon.proficient = false;
    if (typeof w.ranged === 'boolean') weapon.ranged = w.ranged;
    if (typeof w.two_handed === 'boolean') weapon.twoHanded = w.two_handed;
    return weapon;
  });
}

export function parseAbilities(values: string[] | undefined): Ability[] | undefined {
  if (values === undefined) return undefined;
  return values.map((v) => {
    const ability = parseAbility(v);
    if (ability === undefined) throw new Error(`未知属性: ${v}`);
    return ability;
  });
}


/** dnd_story 的各个动作；返回事件文字。抛错时 mutate 不落盘，所以先校验再改 */
export function storyAction(
  c: Campaign,
  adventure: Adventure,
  action: string,
  id: string,
  args: Record<string, unknown>,
  srdBase?: Omit<CharacterInput, 'name'>,
): string[] {
  if (action === 'begin') {
    const { lines, room } = beginAdventure(c, adventure);
    const spawned = room === undefined ? [] : spawnEncounter(c, room);
    if (spawned.length > 0) {
      lines.push(`【DM 机密】这里的敌人：${spawned.map(spawnLine).join('；')}`);
    }
    return lines;
  }
  if (id.length === 0) throw new Error('dnd_story: id 不能为空');
  if (action === 'trigger') {
    const result = fireTrigger(c, adventure, id);
    const lines = [...result.lines];
    if (result.spawn.length > 0) {
      const made = spawnMonsters(c, result.room.id, result.spawn);
      lines.push(`【DM 机密】「${result.room.name}」出现：${made.map((m) => spawnLine({ ...m, notes: undefined })).join('；')}`);
    }
    return lines;
  }
  if (action === 'fact') return revealFact(c, adventure, id, args.passed === true).lines;
  if (action === 'lead') return learnLead(c, adventure, id);
  if (action === 'flag') return setFlag(c, adventure, id, args.on !== false);
  if (action === 'chapter') return setChapter(c, adventure, id);
  if (action === 'quest') {
    const status = str(args.status) as QuestStatus | undefined;
    if (status === undefined || !QUEST_STATUSES.includes(status)) throw new Error(`dnd_story quest 要传 status：${QUEST_STATUSES.join('/')}`);
    const quest = findQuest(adventure, id);
    const reward = quest?.reward;
    const pays = status === 'rewarded' && reward !== undefined && ((reward.gp ?? 0) > 0 || (reward.items?.length ?? 0) > 0);
    const to = pays ? requireCharacter(c, str(args.to) ?? '') : undefined;
    const change = setQuestStatus(c, adventure, id, status);
    if (to !== undefined && change.reward !== undefined) {
      changeInventory(c, to.name, change.reward.items ?? [], [], change.reward.gp ?? 0);
      change.lines.push(`${to.name} 拿到：${[change.reward.gp ? `${change.reward.gp} gp` : '', ...(change.reward.items ?? [])].filter(Boolean).join('、')}`);
    }
    return change.lines;
  }
  if (action === 'npc') {
    const npc = findNpc(adventure, id);
    if (npc === undefined) throw new Error(`模组里没有 NPC「${id}」。有：${adventure.npcs.map((n) => n.id).join('、') || '（无）'}`);
    const attitude = str(args.attitude) as Attitude | undefined;
    if (attitude !== undefined && !ATTITUDES.includes(attitude)) throw new Error(`attitude 只能是 ${ATTITUDES.join('/')}`);
    if (args.join === true || args.fight === true) {
      if (args.join === true && args.fight === true) throw new Error('join 和 fight 只能选一个');
      const mode = args.join === true ? 'join' : 'fight';
      if (!npcAlive(c, npc.id)) throw new Error(`${npc.name} 已经死了。${reviveHint(npc)}`);
      const hp = int(args.hp);
      const { character, created } = upsertCharacter(c, { ...npcCharacterInput(c, npc, mode, srdBase), ...(hp !== undefined ? { hp } : {}) });
      // 态度本来就对时 updateNpc 只回一句「已更新」，上场这里不用重复
      const lines = updateNpc(c, adventure, npc.id, { met: true, attitude: attitude ?? (mode === 'fight' ? 'hostile' : 'friendly') }).lines
        .filter((l) => l !== `${npc.name} 已更新`);
      lines.unshift(mode === 'join'
        ? `${character.name} ${created ? '加入队伍（已建卡）' : '重新跟着队伍'}${npc.canJoin === true ? '' : '（模组没写他会入队，确认剧情说得通）'}`
        : `${character.name} 和队伍敌对${created ? `（已建卡，在 ${character.room}）` : '，转为敌人'}`);
      return lines;
    }
    const patch: NpcState = {};
    if (attitude !== undefined) patch.attitude = attitude;
    const room = str(args.room);
    if (room !== undefined) patch.room = resolveRoom(roomGraph(adventure), room)?.id ?? room;
    if (typeof args.met === 'boolean') patch.met = args.met;
    if (typeof args.alive === 'boolean') patch.alive = args.alive;
    if (Object.keys(patch).length === 0) throw new Error('dnd_story npc 至少要传 attitude/room/met/alive/join/fight 之一');
    return updateNpc(c, adventure, npc.id, patch).lines;
  }
  throw new Error(`dnd_story 不认识的 action: ${action}`);
}

/** dnd_lookup：模组内容的 DM 视角卡片；不传 id 时列出这一类 */
export function lookup(c: Campaign, adventure: Adventure, kind: string, id: string | undefined, brief = false): string {
  if (kind === 'leads') return leadsCard(c, adventure);
  if (kind === 'npc') {
    if (id === undefined) {
      if (adventure.npcs.length === 0) return '这个模组没有具名 NPC。';
      return adventure.npcs.map((n) => `- ${n.id} ${n.name}：${n.role}（${npcRoom(c, n)}${npcAlive(c, n.id) ? '' : '，已死'}）`).join('\n');
    }
    const npc = findNpc(adventure, id);
    if (npc === undefined) throw new Error(`没有这个 NPC: ${id}`);
    return brief ? npcBrief(c, npc) : npcCard(c, adventure, npc);
  }
  if (kind === 'quest') {
    if (id === undefined) {
      if (adventure.quests.length === 0) return '这个模组没有任务。';
      return adventure.quests.map((q) => `- ${q.id} ${q.name}：${c.quests[q.id] ?? '还没提出'}`).join('\n');
    }
    const quest = findQuest(adventure, id);
    if (quest === undefined) throw new Error(`没有这个任务: ${id}`);
    return questCard(c, adventure, quest);
  }
  if (kind === 'site') {
    const site = id === undefined ? undefined : adventure.sites.find((s) => s.id === id || s.name === id);
    if (site !== undefined) return siteCard(c, adventure, site.id);
    if (adventure.sites.length === 1) return siteCard(c, adventure, adventure.sites[0]!.id);
    // 没找到（常见是传了模组 id）就列出全部场景
    return (id === undefined ? '' : `没有场景「${id}」，模组里的场景：\n`) + adventure.sites.map((s) => `- ${s.id} ${s.name}${c.knownSites.includes(s.id) ? '' : '（玩家还不知道）'}${s.summary ? `：${s.summary}` : ''}`).join('\n');
  }
  if (kind === 'room') {
    const room = resolveRoom(roomGraph(adventure), id ?? c.currentRoom);
    if (room === undefined) throw new Error(`没有这个房间: ${id}`);
    return brief ? roomBrief(c, adventure, room) : roomCard(c, adventure, room);
  }
  throw new Error(`dnd_lookup 不认识的 kind: ${kind}`);
}

/** dnd_position terrain 不给 room 时画哪间：当前行动者所在的房间，没开战就是队伍所在 */
export function fightRoom(c: Campaign): string {
  const current = c.initiative?.order[c.initiative.turn]?.name;
  const ch = current === undefined ? undefined : findCharacter(c, current);
  return (ch === undefined ? undefined : roomOf(c, ch)) ?? c.currentRoom;
}

/**
 * 开战时关于场地的一段：模组写了场地图就先拷进战役档；有图就说从哪扇门进来、怎么贴门摆位，
 * 没图就要 DM 先画。冶炼洞窟那一仗是在空地上摆的人，门半路才补，「退到门外」没处放。
 */
export function battlemapHint(c: Campaign, adventure: Adventure, room: string): string {
  const graph = roomGraph(adventure);
  const authored = findRoom(graph, room)?.battlemap;
  if (mapOf(c, room) === undefined && authored !== undefined) (c.battlemaps ??= {})[room] = structuredClone(authored);
  const map = mapOf(c, room);
  if (map === undefined) {
    const exits = exitsOf(graph, room).filter((e) => e.hidden !== true).map((e) => `${e.label}→${e.to}`);
    return '【场地】这间还没有场地图：先 dnd_position terrain 按房间描述画（width/height；墙 wall，门 door 并填 to=通往的房间 id，'
      + '门外走廊 outside，熔炉石柱这类 object，碎石水渠 difficult），存下来再进这间沿用；然后再 set 摆位。'
      + (exits.length > 0 ? `出口：${exits.join('；')}。` : '');
  }
  const from = c.enteredFrom?.[room];
  const door = from === undefined ? undefined : map.areas.find((a) => a.kind === 'door' && a.to === from);
  // 从书里的地图生成的场地图只标了屋子轮廓外的墙；屋里的石柱、坑、隔墙、门要 DM 照房间描述补
  const artNote = map.art !== undefined && !map.areas.some((a) => a.kind !== 'wall')
    ? `这张场地图用模组地图做底图（dnd_map 发给玩家看），只标了屋子轮廓外的墙（涂黑的格子自动算墙）：屋里的石柱、坑、隔墙、门和障碍要按房间描述用 dnd_position terrain 补上（width=${map.width} height=${map.height} 不变就保留底图）。`
    : '';
  return `【场地】${terrainLine(map)}。${artNote}`
    + (door !== undefined ? `队伍是从「${areaName(door)}」进来的：PC 用 set placements near="${areaName(door)}" 摆在门边。` : 'PC 摆位可以用 near=门或地标的名字。');
}

/** 参战者里有人不在交战房间时的提醒：多半是赶过来了但没 dnd_move，战后位置会对不上 */
export function positionNote(c: Campaign, adventure: Adventure, names: readonly string[], rooms: ReadonlySet<string>): string {
  const away = outsideRooms(c, names, rooms);
  if (away.length === 0) return '';
  const graph = roomGraph(adventure);
  const where = away.map((a) => `${a.name}（在「${findRoom(graph, a.room)?.name ?? a.room}」）`).join('、');
  return `\n【DM】${where} 不在交战的房间。已经赶到的，轮到他时先 dnd_move 过来（不在先攻表里的随时能移动）；`
    + '真是隔着房间远程参战就不用管。';
}

export function orderLine(c: Campaign): string {
  const state = requireInitiative(c);
  return state.order.map((e, i) => (i === state.turn ? `▶${e.name}(${e.init})` : `${e.name}(${e.init})`)).join(' > ');
}

/**
 * 战斗中有人走进交战房间、或者刷出了新怪时，提醒模型用 join 拉进先攻表；
 * 不提醒的话模型要么让他们一直站着不动，要么 end 再 start 把整场重来。
 */
/** 拿去对背景钩子触发词的 NPC 文字：名字、别名、身份、阵营、外貌 */
export function npcSceneText(npc: Npc): string {
  return [npc.name, ...(npc.aliases ?? []), npc.role, npc.faction ?? '', npc.look].join('\n');
}

/** 模组没写人数时按官方默认 4 人 */
export const DEFAULT_PARTY_SIZE = 4;

/**
 * 本桌人比模组多时，刷怪那一步给出调强度的规矩。11-08 的内兹纳是现场凭感觉加强的（多一发火球、HP 照现编的 45 算），
 * 也没先跟桌上说；规矩放在刷怪的结果里，DM 正好在决定这一场怎么打。
 */
export function partySizeHint(c: Campaign, adventure: Adventure): string | undefined {
  const pcs = c.characters.filter((ch) => ch.kind === 'pc' && !isOut(ch)).length;
  const design = adventure.partySize ?? DEFAULT_PARTY_SIZE;
  if (pcs <= design) return undefined;
  return `【DM】模组按 ${design} 人写，本桌 ${pcs} 人。要调就在开打前定：小怪最多 ${Math.floor(pcs * 1.5)} 只（PC 数 ×1.5）；`
    + '首领 HP 最多按模组卡 ×1.5（以 dnd_lookup 查到的模组数值为准）；想加压力先换一只更强的、或给网、黑暗、地形，别堆数量。'
    + '调过就先在群里说一句「这一段我上调过」（不说细节），再 dnd_chronicle add kind=ruling 记下调了什么。';
}

export function combatJoinHint(c: Campaign, room: string, movers: string[], spawned: string[]): string | undefined {
  if (c.initiative === undefined) return undefined;
  const fightRooms = new Set(c.initiative.order.map((e) => {
    const ch = findCharacter(c, e.name);
    return ch === undefined ? undefined : roomOf(c, ch);
  }));
  const arrivals = fightRooms.has(room) ? movers.filter((n) => !inInitiative(c, n)) : [];
  const late = [...arrivals, ...spawned.filter((n) => !inInitiative(c, n))];
  if (late.length === 0) return undefined;
  return `【DM】战斗进行中，${late.join('、')} 还不在先攻表里。他们参战就调用 dnd_initiative join participants=[${late.join(', ')}]；`
    + '不要 end 再 start。';
}

export interface TurnPromptOptions {
  /** false = 这场战斗已经给过完整规则，只给一句精简提示；缺省 true */
  full?: boolean;
  /** 轮到的 PC 的玩家最近没发过言 */
  absent?: boolean;
}

/** 轮到某角色时给模型的指引：怪物继续结算，PC 必须停下等玩家 */
export function turnPrompt(ch: Character | undefined, name: string, options: TurnPromptOptions = {}): string {
  const full = options.full !== false;
  if (ch === undefined || ch.kind !== 'pc') {
    return full
      ? `轮到 ${name}（由你决定行动）。结算完调用 dnd_initiative next，直到轮到某个 PC 为止。`
      : `轮到 ${name}（你决定），结算完 next。`;
  }
  if (ch.hp === 0 && !ch.conditions.includes('稳定') && !ch.conditions.includes('死亡')) {
    return `轮到 ${name}（0 HP）：掷死亡豁免 dnd_check type=death，然后 dnd_initiative next。`;
  }
  const player = ch.player ?? '玩家';
  const absent = options.absent === true
    ? `${player} 最近 10 分钟没发过言：问一句等他，一直不回才 next dm_override=true 跳过并在回复里说明。`
    : '';
  if (!full) return `轮到 ${name}〈${player}〉：停下等他本人宣告（规矩同前）。${absent}`;
  return `轮到 ${name}〈${player}〉。到此停下：描述局面后问他做什么，等他本人宣告；`
    + '不要替他选目标、选武器或推断行动，这条回复里也不要再结算别人的回合。'
    + `回复发出后系统会自动给他发「结束回合」按钮，不用你在回复里画按钮或列菜单。${absent}`;
}

/**
 * 战斗里的回合提示：每场战斗 PC、怪物各给一次完整规则，之后只给精简一句——完整规则只在这里给（守则里只留了要点），
 * 每个回合整段重复只是在上下文里堆 token。破例（反应/借机攻击打断了顺序、goto 修过指针）后下一个 PC 回合再给一次完整的。
 * 会改 c.initiative 上的记录，调用方要在 store.update 里用。
 */
export function combatTurnPrompt(c: Campaign, name: string, extra: { recentSenders?: readonly string[]; force?: boolean } = {}): string {
  const ch = findCharacter(c, name);
  const state = c.initiative;
  const kind = ch?.kind === 'pc' ? 'pc' : 'monster';
  const absent = ch?.kind === 'pc' && ch.playerId !== undefined && extra.recentSenders !== undefined
    && !extra.recentSenders.includes(ch.playerId);
  if (state === undefined) return turnPrompt(ch, name, { absent });
  const briefed = state.briefed ?? [];
  const full = extra.force === true || !briefed.includes(kind) || (kind === 'pc' && state.rebrief === true);
  if (!briefed.includes(kind)) state.briefed = [...briefed, kind];
  if (kind === 'pc') delete state.rebrief;
  else if (extra.force === true) state.rebrief = true;
  const position = turnPositionNote(c, name);
  const reaction = ch?.kind === 'pc' ? `\n反应 ${canReact(ch) && reactionBlocked(c, ch.name) === undefined ? 1 : 0}/1` : '';
  return `${turnPrompt(ch, name, { full, absent })}${reaction}${position.length > 0 ? `\n${position}` : ''}`;
}

export const srdLists = new Map<SrdKind, SrdEntry[]>();

/** SRD 全量索引（几百条 index+name），进程内只取一次；取不到时返回空，只靠中文名表和原样 slug */
export async function srdList(kind: SrdKind): Promise<SrdEntry[]> {
  const cached = srdLists.get(kind);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`https://www.dnd5eapi.co/api/2014/${kind}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { results?: Array<{ index?: unknown; name?: unknown }> };
    const list = (body.results ?? [])
      .filter((r) => typeof r.index === 'string')
      .map((r) => ({ index: String(r.index), name: String(r.name ?? r.index) }));
    if (list.length > 0) srdLists.set(kind, list);
    return list;
  } catch {
    return [];
  }
}

export type SrdLookup =
  | { data: Record<string, unknown>; note?: string }
  | { candidates: SrdEntry[] };

/** 名字/拼错的 slug/中文名 → SRD 数据；有几个差不多的候选时不猜，交给调用方列出来 */
export async function lookupSrd(kind: SrdKind, query: string, list?: SrdEntry[]): Promise<SrdLookup> {
  const available = list ?? await srdList(kind);
  const resolved = resolveSrdQuery(query, available, zhTable(kind));
  if (resolved.kind === 'ambiguous') return { candidates: resolved.candidates };
  if (resolved.kind === 'none') {
    if (/\p{Script=Han}/u.test(query)) throw new Error(`SRD 里找不到「${query}」：中文名表没收录，换英文名或 index 再查`);
    // 索引没取到（网络问题）时按原样试一次，至少不比以前差
    if (available.length === 0) return { data: await fetchSrd(kind, query) };
    throw new Error(`SRD 里找不到「${query}」，也没有相近的名字。换个英文名再查`);
  }
  const data = await fetchSrd(kind, resolved.index);
  return resolved.kind === 'fuzzy' ? { data, note: `（「${query}」按 ${resolved.index} 查到）` } : { data };
}

/** 建卡用：拿不准是哪只就报错并列候选（建错怪比多问一次贵） */
export async function requireSrd(kind: SrdKind, query: string): Promise<Record<string, unknown>> {
  const found = await lookupSrd(kind, query);
  if ('candidates' in found) throw new Error(candidatesText(query, found.candidates));
  return found.data;
}

export async function fetchSrd(kind: 'monsters' | 'spells', rawIndex: string): Promise<Record<string, unknown>> {
  const index = rawIndex.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9-]+$/.test(index)) throw new Error('SRD index 只能是小写字母、数字和短横线，如 goblin、zombie');
  const res = await fetch(`https://www.dnd5eapi.co/api/2014/${kind}/${index}`, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) throw new Error(`SRD 里没有 ${index}`);
  if (!res.ok) throw new Error(`SRD 请求失败 HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export const SRD_TRAITS: Record<string, string> = { 'Undead Fortitude': UNDEAD_FORTITUDE };

/** SRD 怪物 JSON → 角色卡字段：AC、HP、六维、第一个带命中加值的攻击、会自动处理的特性 */
export function srdMonsterInput(data: Record<string, unknown>): Omit<CharacterInput, 'name'> {
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const ac = Array.isArray(data.armor_class) ? num((data.armor_class[0] as { value?: unknown } | undefined)?.value) : num(data.armor_class);
  const keys = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' } as const;
  const abilities: Partial<Record<Ability, number>> = {};
  for (const a of ABILITIES) {
    const v = num(data[keys[a]]);
    if (v !== undefined) abilities[a] = v;
  }
  const actions = Array.isArray(data.actions) ? data.actions as Array<Record<string, unknown>> : [];
  const attack = actions.find((a) => num(a.attack_bonus) !== undefined);
  // 多用途武器（长剑单手/双手）的伤害是二选一结构，取第一个选项
  type SrdDamage = { damage_dice?: unknown; from?: { options?: Array<{ damage_dice?: unknown }> } };
  const first = Array.isArray(attack?.damage) ? attack.damage[0] as SrdDamage | undefined : undefined;
  const dice = first?.damage_dice ?? first?.from?.options?.[0]?.damage_dice;
  const specials = Array.isArray(data.special_abilities) ? data.special_abilities as Array<{ name?: unknown }> : [];
  const traits = specials.map((s) => SRD_TRAITS[String(s.name)]).filter((t): t is string => t !== undefined);
  const input: Omit<CharacterInput, 'name'> = { kind: 'monster', abilities, srd: String(data.index ?? '') };
  if (ac !== undefined) input.ac = ac;
  const hp = num(data.hit_points);
  if (hp !== undefined) input.maxHp = hp;
  if (attack !== undefined) input.attackBonus = num(attack.attack_bonus)!;
  if (typeof dice === 'string') input.damage = dice.replace(/\s+/g, '');
  if (traits.length > 0) input.traits = traits;
  const walk = /(\d+)/.exec(String((data.speed as { walk?: unknown } | undefined)?.walk ?? ''));
  if (walk !== null) input.speed = Number(walk[1]);
  const notes = [attack !== undefined ? `攻击：${String(attack.name)}` : '', specials.map((s) => String(s.name)).join('、')].filter(Boolean).join('；');
  if (notes) input.notes = notes;
  return input;
}

/** 「地精」×3 → 接着现有编号往后排：地精1…，已有地精2 就从 地精3 开始 */
export function numberedNames(c: Campaign, base: string, count: number): string[] {
  let n = 0;
  for (const ch of c.characters) {
    const m = ch.name.startsWith(base) ? /^(\d+)$/.exec(ch.name.slice(base.length)) : null;
    if (m !== null) n = Math.max(n, Number(m[1]));
  }
  return Array.from({ length: count }, (_, i) => `${base}${n + i + 1}`);
}

/** 把 SRD JSON 压成几行，避免整份 JSON 进上下文 */
export function formatSrd(kind: 'monsters' | 'spells', data: Record<string, unknown>): string {
  const text = (v: unknown): string => (Array.isArray(v) ? v.join(' ') : String(v ?? ''));
  if (kind === 'spells') {
    return [
      `${text(data.name)}｜${text(data.level)} 环 ${text((data.school as { name?: string } | undefined)?.name)}`,
      `施法时间 ${text(data.casting_time)}，距离 ${text(data.range)}，持续 ${text(data.duration)}${data.concentration === true ? '（专注）' : ''}`,
      text(data.desc).slice(0, 900),
      data.higher_level ? `升环：${text(data.higher_level).slice(0, 300)}` : '',
    ].filter(Boolean).join('\n');
  }
  const ac = Array.isArray(data.armor_class) ? (data.armor_class[0] as { value?: number } | undefined)?.value : data.armor_class;
  const abilities = (['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'] as const)
    .map((k) => `${k.slice(0, 3).toUpperCase()} ${String(data[k] ?? '?')}`).join(' ');
  const named = (v: unknown, max: number): string => (Array.isArray(v)
    ? v.map((a) => `${String((a as { name?: string }).name)}: ${String((a as { desc?: string }).desc ?? '')}`).join('\n').slice(0, max)
    : '');
  return [
    `${text(data.name)}｜${text(data.size)} ${text(data.type)}，CR ${text(data.challenge_rating)}`,
    `AC ${String(ac)}，HP ${text(data.hit_points)}（${text(data.hit_points_dice)}）`,
    abilities,
    named(data.special_abilities, 600),
    named(data.actions, 900),
  ].filter(Boolean).join('\n');
}

/**
 * 各组工具共用的会话上下文：按调用找到团、落盘、编号骰子、核对发言人，以及统一的 register。
 * tools 服务不可用时返回 undefined。
 */
export function createToolKit(ctx: Context, deps: DndToolDeps) {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    deps.logger.warn('im-qqbot: tools 服务不可用，跑团工具未注册');
    return;
  }
  const { service, manager } = deps;

  const recordOf = (exec: Exec): SessionRecord => {
    const record = exec.agent !== undefined ? manager.findByAgent(exec.agent as DshAgent) : undefined;
    if (record === undefined) throw new Error('跑团工具只能在 QQ 会话里用');
    const combat = manager.combatAgents?.current(record.sessionKey);
    if (combat !== undefined && combat.agent !== record.agent) throw new Error('当前战斗由战斗代理主持，请等待它交回；主 DM 不能同时操作团档');
    return record;
  };

  /**
   * 读写当前会话的团；fn 抛错时不落盘。
   * 每次改动后统一跑一遍 afterChange（任务达成、里程碑…），有提示就接在文字结果后面。
   */
  const mutate = <T>(exec: Exec, fn: (c: Campaign, adventure: Adventure) => T, options: { allowPaused?: boolean } = {}): T => {
    const key = recordOf(exec).sessionKey;
    const { adventure } = (options.allowPaused ? service.active(key) ?? service.saved(key) : undefined) ?? service.require(key);
    return service.store.update(key, (c) => {
      seedChronicle(c, adventure);
      const before = markChronicle(c);
      const result = fn(c, adventure);
      // 停团写卡只记人物变化，不把新装备或等级当成剧情触发条件。
      const story = c.active ? afterChange(c, adventure) : [];
      for (const line of story) pushLog(c, line);
      recordChanges(before, c, adventure);
      return (story.length > 0 && typeof result === 'string' ? `${result}\n【剧情】${story.join('；')}` : result) as T;
    }, () => `${exec.label ?? ''}${(exec.rolls ?? []).map((n) => ` #R${n}`).join('')}`, options);
  };

  /** 新的一骰：编号记到这次调用上，结果里给模型看 */
  const rollId = (c: Campaign, exec: Exec): number => {
    const id = nextRollId(c);
    exec.rolls?.push(id);
    return id;
  };

  const sendersOf = (exec: Exec): string[] => recentSenderIds(recordOf(exec), SENDER_WINDOW_MS);

  /** 模型写的成员编号（U3）→ openid；未知编号直接报错，不能原样当 openid 存进角色卡或拿去校验 */
  const memberId = (exec: Exec, value: unknown, param: string): string | undefined => {
    const raw = str(value);
    if (raw === undefined || deps.members === undefined) return raw;
    const openid = deps.members.toOpenid(recordOf(exec), raw);
    if (openid === undefined) {
      throw new Error(`不认识的成员编号「${raw}」：${param} 填那位玩家消息标签里的编号，例如「[阿乙 #U3]」就填 U3。`);
    }
    return openid;
  };
  const whoOf = (exec: Exec) => (openid: string): string => {
    const alias = deps.members?.display(recordOf(exec), openid);
    return alias === undefined ? openid : `#${alias}`;
  };

  /** 豁免结果的逐人行：立即结算和落账共用 */
  const saveOutcomeLines = (outcomes: readonly SaveOutcome[]): string[] => outcomes.map((o) => {
    if (o.skipped !== undefined) return `- ${o.name}：${o.skipped}，跳过`;
    const verdict = o.saved === undefined ? '' : ` → ${o.saved ? '成功' : '失败'}`;
    const nat = o.natural === 20 ? '（天然 20）' : (o.natural === 1 ? '（天然 1）' : '');
    const dmg = o.damage === undefined
      ? ''
      : `，${o.defense !== undefined ? `${DEFENSE_NAMES[o.defense]} ` : ''}受 ${o.damage}${o.change !== undefined ? `；${hpLine(o.change)}` : ''}`;
    const cond = o.conditions !== undefined ? `，得「${o.conditions.join('、')}」` : '';
    return `- ${o.name} ${o.detail ?? ''}${verdict}${nat}${dmg}${cond}`;
  });

  /**
   * reroll="d20"：只换那颗 d20（优劣势照旧再掷两颗），修正、祝福骰、已用的反应加减都保留；
   * 旧结果作废、必须用新的，不提供保留选项。攻击的伤害跟着作废（重击与否可能变了），落账前按新结果重掷。
   */
  const rerollAttack = (c: Campaign, p: PendingAttack, exec: Exec): string => {
    const modifier = p.modifier ?? p.total - p.natural;
    const r = rollD20(modifier, p.advantage ?? 'none', service.roller);
    const id = rollId(c, exec);
    const old = p.rollDetail;
    Object.assign(p, { natural: r.natural, total: r.total, rollDetail: r.detail, crit: r.natural === 20 });
    delete p.rawDamage;
    delete p.damageDetail;
    return `重掷 #R${id}：${old} 作废 → ${r.detail}`;
  };
  const rerollCheck = (c: Campaign, entry: PendingD20, exec: Exec): string => {
    const r = rollD20(entry.modifier, entry.advantage, service.roller);
    const id = rollId(c, exec);
    const old = entry.detail;
    Object.assign(entry, { natural: r.natural, total: r.total, detail: r.detail });
    return `${entry.name} 重掷 #R${id}：${old} 作废 → ${r.detail}`;
  };

  /** 豁免/检定落账：带伤害或失败状态的按效果结算，单纯检定只报最终成败 */
  const settleCheck = (c: Campaign, p: PendingCheck): string[] => {
    if (p.damage === undefined && (p.onFail?.length ?? 0) === 0) return [`落账：${pendingState(p)}。按这个结果演。`];
    const saves: RolledSave[] = p.rolls.map((r) => ({
      name: r.name,
      natural: r.natural,
      total: r.total + r.mod,
      detail: r.mod !== 0 ? `${r.detail}，反应 ${r.mod > 0 ? '+' : ''}${r.mod} = ${r.total + r.mod}` : r.detail,
      ...(r.defense !== undefined ? { defense: r.defense } : {}),
    }));
    const outcomes = applySaveEffect(c, saves, {
      ...(p.dc !== undefined ? { dc: p.dc } : {}),
      ...(p.damage !== undefined ? { damage: Math.max(0, p.damage.total + p.damageMod), onSave: p.damage.onSave } : {}),
      ...(p.damage?.type !== undefined ? { damageType: p.damage.type } : {}),
      ...(p.onFail !== undefined ? { onFail: p.onFail } : {}),
      roller: service.roller,
    });
    return [`落账：${describePending(p)}`, ...saveOutcomeLines(outcomes)];
  };

  /** dnd_apply 处理待结算的部分：先改数值、记不用，最后才落账。reopened：重掷后有新的人能反应，要重发按钮 */
  const resolvePending = (c: Campaign, args: Record<string, unknown>, exec: Exec): { text: string; reopened: boolean } => {
    const p = requirePending(c);
    const named = requireCharacter(c, String(args.target ?? ''));
    // 攻击按被打的人对账；豁免/检定按掷骰的人（群体豁免里改哪一骰靠它指定）
    const entry = p.kind === 'roll' ? p.rolls.find((r) => r.name === named.name) : undefined;
    if (p.kind === 'attack' && named.name !== p.target) throw new Error(`待结算这笔打的是 ${p.target}，不是 ${named.name}`);
    if (p.kind === 'roll' && entry === undefined) {
      throw new Error(`待结算这笔掷骰的是 ${p.rolls.map((r) => r.name).join('、')}，没有 ${named.name}：target 填被改的那个掷骰人`);
    }
    if (args.cancel === true) {
      delete requireInitiative(c).pending;
      pushLog(c, `${describePending(p)}作废`);
      return { text: `${describePending(p)}作废，没有落账。已经花掉的资源不退：整件事不该发生的话用 dnd_undo roll=R${p.seq}。`, reopened: false };
    }
    let reopened = false;
    const lines: string[] = [];
    for (const name of strList(args.decline) ?? []) declineReaction(p, requireCharacter(c, name).name);

    const reaction = args.reaction as Record<string, unknown> | undefined;
    if (reaction !== undefined) {
      const name = str(reaction.name) ?? '反应';
      const reactor = findReactor(c, p, String(reaction.by ?? ''), name);
      const def = reactionsOf(reactor).find((r) => r.name === name);
      const clicked = p.claimed.some((o) => o.character === reactor.name);
      if (!clicked) assertDeclaredByOwner(reactor, { declaredBy: memberId(exec, args.declared_by, 'declared_by'), recentSenders: sendersOf(exec) }, '反应');
      const spendKey = str(reaction.spend) ?? def?.resource;
      if (spendKey !== undefined) useResource(c, reactor.name, spendKey);
      const effects: string[] = [];
      const reroll = str(reaction.reroll);
      if (reroll !== undefined) {
        if (reroll.toLowerCase() !== 'd20') throw new Error('reroll 只支持 "d20"：整颗 d20 重掷，必须用新结果');
        effects.push(p.kind === 'attack' ? rerollAttack(c, p, exec) : rerollCheck(c, entry!, exec));
      }
      const attackMod = str(reaction.attack_mod);
      if (attackMod !== undefined) {
        const r = signedRoll(attackMod, service.roller);
        if (p.kind === 'attack') p.attackMod += r.total;
        else entry!.mod += r.total;
        effects.push(`${p.kind === 'attack' ? '攻击' : `${entry!.name} 的骰`} ${r.detail}`);
      }
      const acMod = int(reaction.ac_mod);
      if (acMod !== undefined) {
        if (p.kind !== 'attack') throw new Error('ac_mod 只对攻击有用；豁免/检定用 attack_mod 加减那一骰');
        p.acMod += acMod;
        if (reactor.name === p.target && /^(护盾术|Shield)$/i.test(name) && acMod === 5) {
          const state = requireInitiative(c);
          state.shielded = [...new Set([...(state.shielded ?? []), reactor.name])];
        }
        effects.push(`AC ${acMod >= 0 ? '+' : ''}${acMod}`);
      }
      const damageMod = str(reaction.damage_mod);
      if (damageMod !== undefined) {
        if (p.kind === 'roll' && p.damage === undefined) throw new Error('这笔没有伤害，damage_mod 用不上');
        const r = signedRoll(damageMod, service.roller);
        p.damageMod += r.total;
        effects.push(`伤害 ${r.detail}`);
      }
      const counter = def?.counter === true && p.kind === 'attack';
      const effect = effects.join('，') || (counter ? '反手打回去' : '无数值变化');
      p.used.push({ by: reactor.name, name, effect });
      p.claimed = p.claimed.filter((o) => o.character !== reactor.name);
      if (consumesReaction(c, p, reactor.name, name)) {
        const state = requireInitiative(c);
        spendReaction(c, reactor.name);
        if (counter) (state.counterAttacks ??= []).push({ by: reactor.name, target: p.attacker, name });
      }
      pushLog(c, `${reactor.name} 用「${name}」（${effect}）`);
      lines.push(`${reactor.name} 用「${name}」：${effect}${spendKey !== undefined ? `，用掉「${spendKey}」` : ''}`);
      if (counter) {
        lines.push(`${name} 是一次新的攻击，不改这笔的数字：这笔落账之后，用 dnd_check character=${reactor.name} type=attack target=${p.attacker} reaction=true 结算还击（还击不打中也不影响这笔）。`);
      }
      // 重掷后成败变了：谁能反应要按新结果重算（没中了尖刻言语就用不上；变成命中了就有人能用）
      if (reroll !== undefined && p.kind === 'attack') {
        const fresh = refreshReactors(c, p);
        if (fresh.length > 0) {
          p.at = Date.now();
          reopened = true;
          lines.push(`按新结果 ${fresh.map((r) => `${r.character}·${r.reaction}`).join('、')} 也能反应了，窗口重开，先问他们。`);
        }
      }
    }

    // 未命中被改成命中（或重掷作废了旧伤害）时，这时才有伤害可掷
    if (p.kind === 'attack' && pendingHit(p) && p.rawDamage === undefined) {
      const attacker = requireCharacter(c, p.attacker);
      const weapon = p.weapon === undefined ? undefined : findWeapon(attacker, p.weapon);
      const expression = attackExpression(attacker, weapon, p.extraDamage);
      if (expression === undefined) {
        lines.push('命中，但没有伤害表达式：落账后用 dnd_roll 掷伤害（重击骰子翻倍）再 dnd_apply 扣血。');
      } else {
        const dmg = rollAttackDamage(attacker, weapon, expression, p.crit, service.roller);
        p.rawDamage = dmg.total;
        p.damageDetail = dmg.detail;
        lines.push(`现在命中${p.crit ? '（重击）' : ''}，伤害 ${dmg.detail}`);
      }
    }

    if (args.settle !== true) {
      const waiting = waitingOn(p);
      lines.push(pendingState(p));
      lines.push(waiting.length > 0
        ? `还没落账：还在等 ${waiting.join('、')}。`
        : `都答复了：报完结果就 dnd_apply target=${p.target} settle=true 落账。`);
      lines.push(SECRET_NOTE);
      return { text: lines.join('\n'), reopened };
    }

    assertWindowClosed(p);
    delete requireInitiative(c).pending;
    if (p.kind === 'roll') {
      lines.push(...settleCheck(c, p));
    } else if (!pendingHit(p)) {
      lines.push(`${p.attacker}→${p.target} 落账：未命中，没有扣血。`);
    } else if (p.rawDamage !== undefined) {
      const raw = Math.max(0, p.rawDamage + p.damageMod);
      const amount = saveDamage(raw, false, 'half', p.defense);
      lines.push(`${p.attacker}→${p.target} 落账：${p.defense !== undefined ? `${DEFENSE_NAMES[p.defense]} ` : ''}受 ${amount}`);
      lines.push(...settleAttackDamage(c, p.attacker, p.target, raw, p.crit, p.damageType, p.defense, p.onHit, service.roller));
    } else {
      lines.push(`${p.attacker}→${p.target} 落账：命中${p.crit ? '（重击）' : ''}，用 dnd_roll 掷伤害再 dnd_apply 扣血。`);
    }
    lines.push('继续结算这个回合；这一只行动完了再 next。');
    lines.push(SECRET_NOTE);
    return { text: lines.join('\n'), reopened };
  };

  /**
   * dnd_check type=save 的伤害/状态/多目标结算。spendFrom：花资源的人（施法者，或没有 targets 时掷豁免的人）；
   * 来源不是角色（陷阱）时不扣资源。hold：挂起等反应（时间变幻），不传就当场结算。
   */
  const saveEffectText = (
    c: Campaign, args: Record<string, unknown>, targets: SaveTarget[], source: string | undefined, hasSheet: boolean,
    exec: Exec, hold: ReactorOption[] | undefined,
  ): string => {
    const ability = parseAbility(String(args.ability ?? ''));
    if (ability === undefined) throw new Error(`dnd_check: 豁免要给 ability（如 敏捷），收到 ${String(args.ability ?? '')}`);
    const spendKey = str(args.spend);
    const spender = source ?? targets[0]!.name;
    if (spendKey !== undefined && !hasSheet) throw new Error(`「${spender}」不是角色卡上的人，不能 spend`);
    const dc = int(args.dc);
    const damage = str(args.damage);
    const damageType = str(args.damage_type);
    const onSave = args.on_save === 'none' ? 'none' : 'half';
    const onFail = strList(args.on_fail_conditions);
    const spent = spendKey === undefined ? undefined : useResource(c, spender, spendKey);
    const rolled = rollSaveEffect(c, {
      targets, ability, dc, damage, damageType, onSave, ...(onFail !== undefined ? { onFail } : {}),
      advantage: advantageOf(args.advantage), bonus: int(args.bonus), bonusDice: str(args.bonus_dice), roller: service.roller,
    });
    const id = rollId(c, exec);
    const label = `${ABILITY_NAMES[ability]}豁免`;
    const head = [
      source !== undefined ? `${source} 的效果：` : '',
      label,
      rolled.damageRoll !== undefined
        ? `，伤害 ${rolled.damageRoll.detail}${damageType ? ` ${damageType}` : ''}（成功${onSave === 'none' ? '无伤' : '减半'}）`
        : '',
      onFail !== undefined && onFail.length > 0 ? `，失败得「${onFail.join('、')}」` : '',
      ` #R${id}`,
    ].join('');
    const lines = [head];
    const spentLine = spent === undefined ? undefined : `用掉「${spent.key}」，剩 ${spent.resource.current}/${spent.resource.max}`;

    if (hold !== undefined) {
      const rolls: PendingD20[] = rolled.saves.flatMap((s) => (s.skipped !== undefined || s.total === undefined
        ? []
        : [{
          name: s.name, natural: s.natural ?? 0, modifier: s.modifier ?? 0, advantage: s.advantage ?? 'none', total: s.total, detail: s.detail ?? '', mod: 0,
          ...(s.defense !== undefined ? { defense: s.defense } : {}),
        }]));
      const first = rolls[0];
      if (first === undefined) throw new Error('没有能掷豁免的目标，不用挂起');
      const p: PendingCheck = {
        kind: 'roll', seq: id, at: Date.now(), attacker: source ?? first.name, target: first.name, label, rolls,
        ...(dc !== undefined ? { dc } : {}),
        ...(rolled.damageRoll !== undefined
          ? { damage: { total: rolled.damageRoll.total, detail: rolled.damageRoll.detail, onSave, ...(damageType !== undefined ? { type: damageType } : {}) } }
          : {}),
        ...(onFail !== undefined && onFail.length > 0 ? { onFail } : {}),
        damageMod: 0, reactors: hold, declined: [], claimed: [], used: [],
      };
      requireInitiative(c).pending = p;
      for (const r of rolls) {
        const passed = rollPassed(p, r);
        lines.push(`- ${r.name} ${r.detail}${passed === undefined ? '' : ` → ${passed ? '成功' : '失败'}`}（还没落账）`);
      }
      for (const s of rolled.saves) if (s.skipped !== undefined) lines.push(`- ${s.name}：${s.skipped}，跳过`);
      if (spentLine !== undefined) lines.push(spentLine);
      lines.push(holdNotice(p));
      lines.push(SECRET_NOTE);
      deps.onPendingAttack?.(recordOf(exec));
      return lines.join('\n');
    }

    const outcomes = applySaveEffect(c, rolled.saves, {
      ...(dc !== undefined ? { dc } : {}),
      ...(rolled.damageRoll !== undefined ? { damage: rolled.damageRoll.total } : {}),
      ...(damageType !== undefined ? { damageType } : {}),
      onSave,
      ...(onFail !== undefined ? { onFail } : {}),
      roller: service.roller,
    });
    lines.push(...saveOutcomeLines(outcomes));
    if (spentLine !== undefined) lines.push(spentLine);
    lines.push(args.secret === true ? HIDDEN_ROLL_NOTE : SECRET_NOTE);
    return lines.join('\n');
  };

  /** 注册过的工具名：按会话隐藏工具时要整份名单（见 tool-scope.ts） */
  const names: string[] = [];

  const register = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    run: (args: Record<string, unknown>, exec: Exec) => Promise<string> | string,
  ): void => {
    names.push(name);
    tools.register({
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute(args: unknown, exec: Exec): Promise<{ text: string }> {
        const input = (args ?? {}) as Record<string, unknown>;
        // 快照标签：undo 列表里让模型认得出是哪一步
        const brief = Object.entries(input)
          .filter(([k]) => !['declared_by', 'reaction', 'dm_override'].includes(k))
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
          .slice(0, 120);
        return { text: await run(input, { ...exec, concludeTurn: exec.concludeTurn?.bind(exec), label: `${name} ${brief}`, rolls: [] }) };
      },
    });
  };

  return { deps, service, manager, recordOf, mutate, rollId, sendersOf, memberId, whoOf, saveOutcomeLines, rerollAttack, rerollCheck, settleCheck, resolvePending, saveEffectText, register, names };
}

export type ToolKit = NonNullable<ReturnType<typeof createToolKit>>;
