/** 角色卡与资源：dnd_character、dnd_resource、dnd_rest。 */
import type { Adventure } from '../adventure.ts';
import {
type Campaign,type Character,type CharacterInput,type CharacterKind,type DelegationTarget,type PendingSpell,assertNoPending,changeInventory,checkAllAirborneCrashes,delegationTag,fightingSpiritTempHp,findCharacter,grantTempHp,hexbladeKillHeal,inInitiative,isAbsent,isDmDelegated,isOut,fightRooms,leaveInitiative,pushLog,reactionBlocked,removeCharacter,requireCharacter,requireInitiative,requireResource,rest,
restoreReaction,
restoreResource,
roomOf,
setCharacterAbsent,
setCharacterDelegation,
setHexbladeCurse,
setResource,spendReaction,upsertCharacter,
useResource
} from '../campaign.ts';
import {
npcAlive
} from '../story.ts';
import { ABILITIES,type Ability,abilityModifier,proficiencyBonus } from '../rules.ts';
import {
breakConcentration,concentratingOn,defaultStateRounds,ensureTurnState,isDefaultConcentrationState,isTransferableState,normalizeCondition,recordTurnSpellCast,transferConcentration,upsertActiveState
} from '../conditions.ts';
import { resolveEffectDef } from '../custom-effects.ts';
import { buildFormulaContext,evalIntFormula } from '../formula.ts';
import { inferSpellSaveDc } from '../zones.ts';
import { resolveSrdQuery,zhTable } from '../srd-lookup.ts';
import { type CardSpell,mergeSpells,resolveSpells } from '../spell-links.ts';
import { hookHint } from '../hooks.ts';
import { assertCombatExit, canReact } from '../battlefield.ts';
import { eligibleSpellReactors, holdNotice, hostileSpellcasterHints } from '../pending-attack.ts';
import {
SECRET_NOTE,
parseReactions,str,
int,
strList,moduleNpcNamed,
reviveHint,sheet,
characterBrief,
parseSkills,
parseSpellInputs,
parseWeapons,
parseAbilities,srdList,requireSrd,srdMonsterInput,
numberedNames,combatLedgerSuffix,type ToolKit
} from './shared.ts';

/** 5e 全施法者法术位表（施法者等级 1–20 → 1–9 环法术位上限） */
const FULL_CASTER_SLOTS: Readonly<Record<number, readonly number[]>> = {
  1: [2],
  2: [3],
  3: [4, 2],
  4: [4, 3],
  5: [4, 3, 2],
  6: [4, 3, 3],
  7: [4, 3, 3, 1],
  8: [4, 3, 3, 2],
  9: [4, 3, 3, 3, 1],
  10: [4, 3, 3, 3, 2],
  11: [4, 3, 3, 3, 2, 1],
  12: [4, 3, 3, 3, 2, 1],
  13: [4, 3, 3, 3, 2, 1, 1],
  14: [4, 3, 3, 3, 2, 1, 1],
  15: [4, 3, 3, 3, 2, 1, 1, 1],
  16: [4, 3, 3, 3, 2, 1, 1, 1],
  17: [4, 3, 3, 3, 2, 1, 1, 1, 1],
  18: [4, 3, 3, 3, 3, 1, 1, 1, 1],
  19: [4, 3, 3, 3, 3, 2, 1, 1, 1],
  20: [4, 3, 3, 3, 3, 2, 2, 1, 1],
};

function splitTopLevelClasses(className: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of className) {
    if (ch === '(' || ch === '（' || ch === '[' || ch === '【') depth++;
    else if ((ch === ')' || ch === '）' || ch === ']' || ch === '】') && depth > 0) depth--;
    if (depth === 0 && (ch === '/' || ch === '／' || ch === '、' || ch === '；' || ch === ';')) {
      if (cur.trim().length > 0) parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) parts.push(cur.trim());
  return parts;
}

type CasterKind = 'full' | 'artificer' | 'half' | 'third' | 'warlock' | 'noncaster';

function classifyClassSegment(seg: string): CasterKind | undefined {
  // 先认邪术师，避免把「邪术师」误识别成「术士」
  if (/邪术师|warlock/i.test(seg)) return 'warlock';
  if (/奇械师|artificer/i.test(seg)) return 'artificer';
  if (/奥法骑士|诡术师|诡术浪客|eldritch\s*knight|arcane\s*trickster/i.test(seg)) return 'third';
  if (/吟游诗人|诗人|牧师|德鲁伊|术士|法师|bard|cleric|druid|sorcerer|wizard/i.test(seg)) return 'full';
  if (/圣武士|圣骑士|游侠|paladin|ranger/i.test(seg)) return 'half';
  if (/战士|野蛮人|武僧|游荡者|盗贼|fighter|barbarian|monk|rogue/i.test(seg)) return 'noncaster';
  return undefined;
}

/** 按 5e PHB 规则（含单施法职业兼职与多施法职业兼职表、契约魔法独立计算）推导应有的法术位上限；无法确定等级拆分时返回 undefined */
export function computeExpected5eSlots(
  className: string | undefined,
  totalLevel: number,
): { standard: Record<number, number>; pact?: { slotLevel: number; max: number } } | undefined {
  if (!className || totalLevel < 1) return undefined;
  const rawParts = splitTopLevelClasses(className);
  if (rawParts.length === 0) return undefined;

  const parsed: Array<{ kind: CasterKind; level: number }> = [];
  if (rawParts.length === 1) {
    const seg = rawParts[0]!;
    const kind = classifyClassSegment(seg);
    if (kind === undefined) return undefined;
    const stripped = seg.replace(/（[^）]*）|\([^)]*\)/g, ' ');
    const m = /(\d+)\s*级?/.exec(stripped);
    const lv = m !== null ? Number(m[1]) : totalLevel;
    if (lv !== totalLevel) return undefined;
    parsed.push({ kind, level: lv });
  } else {
    let sum = 0;
    for (const seg of rawParts) {
      const kind = classifyClassSegment(seg);
      if (kind === undefined) return undefined;
      const stripped = seg.replace(/（[^）]*）|\([^)]*\)/g, ' ');
      const m = /(\d+)\s*级?/.exec(stripped);
      if (m === null) return undefined;
      const lv = Number(m[1]);
      if (!Number.isInteger(lv) || lv < 1) return undefined;
      sum += lv;
      parsed.push({ kind, level: lv });
    }
    if (sum !== totalLevel) return undefined;
  }

  // PHB p.164：只有拥有 >= 2 个「施法（Spellcasting）」特性职业时才按兼职施法者等级相加；单施法职业（如游侠5/游荡者2、邪术师6/诗人1）按该职业自身法术位表
  const spellcasters = parsed.filter((p) =>
    (p.kind === 'full' && p.level >= 1)
    || (p.kind === 'artificer' && p.level >= 1)
    || (p.kind === 'half' && p.level >= 2)
    || (p.kind === 'third' && p.level >= 3),
  );

  let effectiveCasterLevel = 0;
  if (spellcasters.length === 1) {
    const only = spellcasters[0]!;
    if (only.kind === 'full') effectiveCasterLevel = only.level;
    else if (only.kind === 'artificer' || only.kind === 'half') effectiveCasterLevel = Math.ceil(only.level / 2);
    else if (only.kind === 'third') effectiveCasterLevel = Math.ceil(only.level / 3);
  } else if (spellcasters.length >= 2) {
    for (const sc of spellcasters) {
      if (sc.kind === 'full') effectiveCasterLevel += sc.level;
      else if (sc.kind === 'artificer') effectiveCasterLevel += Math.ceil(sc.level / 2);
      else if (sc.kind === 'half') effectiveCasterLevel += Math.floor(sc.level / 2);
      else if (sc.kind === 'third') effectiveCasterLevel += Math.floor(sc.level / 3);
    }
  }

  const standard: Record<number, number> = {};
  const row = FULL_CASTER_SLOTS[Math.min(20, effectiveCasterLevel)];
  if (row !== undefined) {
    row.forEach((max, idx) => {
      if (max > 0) standard[idx + 1] = max;
    });
  }

  const warlockLv = parsed.filter((p) => p.kind === 'warlock').reduce((acc, p) => acc + p.level, 0);
  const pact = warlockLv >= 1
    ? {
      slotLevel: Math.min(5, Math.ceil(warlockLv / 2)),
      max: warlockLv === 1 ? 1 : warlockLv <= 10 ? 2 : warlockLv <= 16 ? 3 : 4,
    }
    : undefined;

  return { standard, ...(pact !== undefined ? { pact } : {}) };
}

/** PC 升级或兼职改动时自动补齐新增生命骰与 5e 法术位上限（保留已消耗格数，新增上限自动以可用态补入） */
function syncLevelUpResources(
  c: Campaign,
  ch: Character,
  prevLevel: number | undefined,
  prevClassName: string | undefined,
): string[] {
  if (ch.kind !== 'pc') return [];
  const synced: string[] = [];
  if (prevLevel !== undefined && ch.level > prevLevel && ch.resources !== undefined) {
    const delta = ch.level - prevLevel;
    for (const [rk, rr] of Object.entries(ch.resources)) {
      if (rk.startsWith('生命骰') && rr.max < ch.level) {
        const before = `${rr.current}/${rr.max}`;
        rr.max = ch.level;
        rr.current = Math.min(ch.level, rr.current + delta);
        synced.push(`${rk} ${before}→${rr.current}/${rr.max}`);
      }
    }
  }

  const classChanged = ch.className !== prevClassName;
  const leveledUp = prevLevel !== undefined && ch.level > prevLevel;
  if (!leveledUp && !classChanged) return synced;

  const expected = computeExpected5eSlots(ch.className, ch.level);
  if (expected === undefined) return synced;

  for (const [tierStr, expMax] of Object.entries(expected.standard)) {
    const tier = Number(tierStr);
    const key = `${tier}环法术位`;
    const existing = ch.resources?.[key];
    if (existing === undefined || existing.max < expMax) {
      const before = existing !== undefined ? `${existing.current}/${existing.max}` : '未建';
      const updated = setResource(c, ch.name, key, expMax, 'long');
      synced.push(`${key} ${before}→${updated.current}/${updated.max}`);
    }
  }

  if (expected.pact !== undefined) {
    const { slotLevel, max: pactMax } = expected.pact;
    const targetKey = `契约法术位（${slotLevel}环）`;
    const existingEntry = Object.entries(ch.resources ?? {}).find(([k]) => k.startsWith('契约法术位'));
    if (existingEntry === undefined) {
      const updated = setResource(c, ch.name, targetKey, pactMax, 'short');
      synced.push(`${targetKey} 未建→${updated.current}/${updated.max}`);
    } else {
      const [oldKey, oldRes] = existingEntry;
      if (oldKey !== targetKey || oldRes.max < pactMax) {
        const newMax = Math.max(oldRes.max, pactMax);
        const gained = Math.max(0, newMax - oldRes.max);
        const newCur = Math.min(newMax, oldRes.current + gained);
        if (oldKey !== targetKey && ch.resources !== undefined) delete ch.resources[oldKey];
        ch.resources = { ...(ch.resources ?? {}), [targetKey]: { current: newCur, max: newMax, reset: 'short' } };
        synced.push(`${oldKey !== targetKey ? `${oldKey}→${targetKey}` : targetKey} ${oldRes.current}/${oldRes.max}→${newCur}/${newMax}`);
      }
    }
  }
  return synced;
}

/** 暂停时可备好 PC 卡，但不能借写卡改战场或访问敌方数据。 */
function assertPausedSheet(c: Campaign, args: Record<string, unknown>): void {
  if (c.active) return;
  const action = String(args.action);
  if (!['create', 'update', 'show', 'list'].includes(action)) throw new Error('停团时只支持 PC 建卡、改卡和查卡；不能移除角色');
  if (args.kind !== undefined && args.kind !== 'pc') throw new Error('停团时只能操作 PC 角色卡');
  if (args.absent !== undefined) throw new Error('停团时不能设置暂离，收团后所有 PC 自动归队');
  if (args.delegate !== undefined) throw new Error('停团时不能设置托管，开团后再设置或收团已自动解除');
  if (args.srd !== undefined || (int(args.count) ?? 1) > 1) throw new Error('停团时不能用 SRD 或 count 建怪；PC 一人一张卡');
  if (args.room !== undefined) throw new Error('停团写卡不能改变位置；移动请开团后用 dnd_move');
  if (action === 'list') return;
  const several = strList(args.names);
  for (const name of several !== undefined && several.length > 0 ? several : [str(args.name) ?? '']) {
    const ch = action === 'create' ? findCharacter(c, name) : requireCharacter(c, name);
    if (ch !== undefined && ch.kind !== 'pc') throw new Error(`停团时只能操作 PC 角色卡：「${ch.name}」不是 PC`);
  }
}

export function registerCharacterTools(kit: ToolKit): void {
  const { deps, service, recordOf, mutate, rollId, memberId, whoOf, register } = kit;

  register(
    'dnd_character',
    'Use whenever a player asks to see/check their character sheet, inventory, spells or resources, or to create/edit/level up a character. '
    + 'For existing sheets, read current data with show before answering or editing (reuse a show result already obtained this turn); never reconstruct a sheet from chat memory. '
    + 'Full sheet: action=show name="角色名"; quick HP/resources: also brief=true; unknown name: action=list first. '
    + 'Tool results are DM-only, NOT automatically sent to the group: send the requested PC sheet/content in your reply after reading it. '
    + 'Edits must be persisted with update (new sheets: create); only confirm saved after success. The update result already contains the saved sheet, so no extra show is needed. '
    + 'Create, update, show, list or remove character sheets (PCs, NPCs, extra monsters). Ability scores default to 10. '
    + 'Bind a PC to the player\'s group nickname with `player` and `player_id` so they can only act for their own character. '
    + 'New PC: ask name and class, then create with weapons, hit_die and the reactions that change attacks (standard array '
    + '15/14/13/12/10/8 if they want help), and set spell slots / class resources with dnd_resource set. '
    + 'While paused, create/update/show/list work for PCs only (no remove, SRD, multiple copies or room changes); '
    + 'no need to start the adventure. Use the player tag as player_id (e.g. U7); never edit campaign JSON. '
    + 'For updates, omit unchanged fields. notes and arrays such as weapons/traits/reactions/skills/saves/spells REPLACE existing values: '
    + 'read and preserve unrelated entries; prefer add_spells/remove_spells and add_items/remove_items for incremental changes. '
    + 'Use structured fields for supported mechanics (e.g. init_bonus, traits, reactions); notes alone do not enable automatic bonuses. '
    + 'Set spell slots/class-resource limits with dnd_resource set, not just notes. '
    + 'Improvised monsters: pass `srd` (e.g. "goblin") to take real stats from the SRD and `count` for several '
    + '(named 地精1, 地精2…); they are placed in the party\'s current room unless `room` is given. '
    + 'The same change for several characters (handing everyone an amulet, moving the party by hand, Aid on three people): '
    + 'ONE update with `names`, never one call each.',
    {
      action: { type: 'string', enum: ['create', 'update', 'show', 'list', 'remove'], description: 'show: read a current sheet before displaying/editing; update: persist changes to an existing sheet; create: a new sheet; list: find names; remove: delete.' },
      name: { type: 'string', description: 'Exact character name for create/update/show/remove. If unknown, use list first; names is for batch update or brief show.' },
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'For update/show: several characters at once instead of `name`. update applies the same fields to each '
          + '(room, add_items, remove_items, gp_change, max_hp_change, ac, speed…) and returns one line per character.',
      },
      srd: { type: 'string', description: 'For create: SRD monster index; fills AC/HP/abilities/attack from dnd5eapi.' },
      count: { type: 'integer', description: 'For create: how many copies (numbered names).' },
      room: {
        type: 'string',
        description: 'Room id the character is in (monsters; PCs that split off). Moving a monster in combat to a room '
          + 'outside the fight also takes it out of initiative. Voluntary fleeing must first use dnd_position move to the mapped exit and resolve opportunity attacks.',
      },
      forced_move: { type: 'boolean', description: 'With room: actual teleport/forced movement or correction only, bypassing the voluntary exit-route check. Never for voluntary fleeing. Explain the cause in the reply.' },
      speed: { type: 'integer', description: 'Walking speed in feet (default 30). dnd_position warns when a turn\'s movement exceeds it.' },
      fly_speed: { type: 'integer', description: 'Flying speed in feet (e.g. 60 for Young Green Dragon); enables 2.5D vertical movement (z > 0) in dnd_position.' },
      hover: { type: 'boolean', description: 'True if the creature can hover (immune to falling/crash damage when prone or speed=0 while airborne).' },
      reactions: {
        type: 'array',
        description: 'Reactions that can change an attack or spell; attacks/spells pause for the player when one applies (replaces the list). '
          + 'when: foe_attacks (a foe hits an ally or self: 尖刻言语), attacked (self is hit before damage: 护盾术), '
          + 'damaged (after taking damage is confirmed: 迷雾逃生, 炼狱叱喝), enemy_crit (a foe lands a crit: 时间变幻), '
          + 'attacking (own attack misses: 导引打击), foe_casts (a foe casts a spell within 60 ft: 法术反制). resource: what it spends; cost: units spent per use (default 1, e.g. 2 for Staff of Defense Shield).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            when: { type: 'string', enum: ['foe_attacks', 'attacked', 'attacking', 'damaged', 'enemy_crit', 'foe_casts'] },
            resource: { type: 'string' },
            cost: { type: 'integer', description: 'Resource units spent per reaction (default 1).' },
            range: { type: 'integer', description: 'Trigger range in feet (e.g. 哨兵 5, 长柄大师 10).' },
            counter: { type: 'boolean', description: 'Reaction grants a separate counterattack (e.g. 哨兵); record it with dnd_apply reaction, then dnd_check attack reaction=true after settling.' },
            enter: { type: 'boolean', description: 'Triggers when an enemy enters reach (长柄大师); movement pauses at this boundary.' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      hit_die: { type: 'string', description: 'PCs: hit die, e.g. d10 (fighter/paladin/ranger), d8 (cleric/rogue/bard).' },
      traits: {
        type: 'array',
        items: { type: 'string' },
        description: 'Auto-handled traits (replaces the list): "不死坚韧", fighting styles "巨武器战斗"/"箭术", feats "精灵精准"/"战地施法者", '
          + 'and conditional combat passives "巨兽杀手" (once/turn +1d8 when target < maxHp), "偷袭", "精通至圣斩", "祝福打击", "神圣狂怒", "凶蛮攻击", '
          + '"精通重击"/"卓越重击", "集群战术", "血腥狂乱", "守护灵光", "生命门徒"/"神佑医者". With these set, never add them by hand.',
      },
      expertise: { type: 'array', items: { type: 'string' }, description: 'Skills with expertise (double proficiency), e.g. ["巧手","隐匿"].' },
      spells: {
        type: 'array',
        description: 'Spells AND class/item abilities on the character\'s sheet, replacing the list. Players open it from the '
          + '「法术/能力」 turn button. For spells (kind="spell" or omitted), give level (0-9) and `en` when the Chinese name '
          + 'is not in the SRD table (脆弱诅咒 → Hex). For class features/actions or magic item abilities, pass kind="feature" '
          + 'or "item" (level optional, no English wiki check) with optional action/resource/cost/summary so players see their full kit.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Chinese name as the table says it.' },
            level: { type: 'integer', description: '0 for cantrips; 1-9 for leveled spells; optional (default 0) when kind is feature/item.' },
            kind: { type: 'string', enum: ['spell', 'feature', 'item'], description: 'Default "spell"; pass "feature" for class actions/features or "item" for item charges.' },
            action: { type: 'string', enum: ['action', 'bonus', 'reaction', 'free', 'passive'], description: 'Action economy cost.' },
            resource: { type: 'string', description: 'Linked resource key in dnd_resource (displays live current/max).' },
            cost: { type: 'integer', description: 'Units of resource spent per use (default 1).' },
            summary: { type: 'string', description: 'Concise 1-line summary for players.' },
            en: { type: 'string', description: 'English spell name, when the Chinese spell is not in the SRD table.' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      add_spells: { type: 'array', description: 'Spells learned (same shape as spells); replaces one of the same name.', items: { type: 'object' } },
      remove_spells: { type: 'array', items: { type: 'string' }, description: 'Spells forgotten or swapped out, by name.' },
      add_items: { type: 'array', items: { type: 'string' }, description: 'Items picked up. For non-module/homebrew magic items, cap rarity by party level (L1-4 Common/Uncommon, L5-6 Uncommon max +1, L7-10 Rare) and check existing party gear first; never stack +2/+3 with extra spell effects at low-mid levels.' },
      remove_items: { type: 'array', items: { type: 'string' }, description: 'Items used up or handed over.' },
      gp_change: { type: 'integer', description: 'Gold gained (+) or spent (-).' },
      kind: {
        type: 'string',
        enum: ['pc', 'npc', 'monster'],
        description: 'npc = on the party\'s side. Anyone fighting the party, named villains included, is monster: npc cards count as allies, so their AC and HP show and reactions against them are not offered.',
      },
      player: { type: 'string', description: 'Player nickname in the group (PCs).' },
      player_id: { type: 'string', description: 'Player member id from their tag "[昵称 #U3]" (pass "U3") (PCs). Binds the PC so only this player can act for it.' },
      class_name: { type: 'string', description: 'e.g. 战士 / 法师 / 游荡者' },
      level: { type: 'integer' },
      str: { type: 'integer' }, dex: { type: 'integer' }, con: { type: 'integer' },
      int: { type: 'integer' }, wis: { type: 'integer' }, cha: { type: 'integer' },
      skills: { type: 'array', items: { type: 'string' }, description: 'Proficient skills, e.g. ["察觉","隐匿"].' },
      saves: { type: 'array', items: { type: 'string' }, description: 'Proficient saves, e.g. ["力量","体质"].' },
      max_hp: { type: 'integer' },
      max_hp_change: {
        type: 'integer',
        description: 'Raise or lower max HP by this much (Aid +5, ending it -5). A raise also adds the same to current HP; '
          + 'current HP never exceeds the new max. Use this with `names`, since each character\'s max differs.',
      },
      ac: { type: 'integer' },
      init_bonus: {
        type: 'integer',
        description: 'Fixed TOTAL initiative modifier, replacing Dexterity-only calculation (e.g. dex + Temporal Awareness/Jack of All Trades/Alert). Persist after checking the sheet; do not add it again via initiative bonus. Temporary dice such as Gift of Alacrity go in dnd_initiative start bonus, never here. Changing this does not rewrite already-rolled initiative.',
      },
      attack_bonus: { type: 'integer', description: 'Monsters/NPCs; PCs use ability + proficiency.' },
      damage: { type: 'string', description: 'Monsters/NPCs: default attack damage, e.g. "1d8+3".' },
      weapons: {
        type: 'array',
        description: 'PC weapons (replaces the list). damage is the weapon die only: 巨斧 1d12, 长剑 1d8, 刺剑 1d8 (dex), 短弓 1d6 (dex).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            damage: { type: 'string' },
            ability: { type: 'string', enum: ['str', 'dex', 'con', 'int', 'wis', 'cha'] },
            notes: { type: 'string', description: 'damage type, properties, range' },
            magic: { type: 'integer', description: '+N magic weapon: added to hit AND damage automatically.' },
            proficient: { type: 'boolean', description: 'false when the wielder lacks proficiency (no proficiency bonus to hit).' },
            ranged: { type: 'boolean', description: 'Ranged weapon (Archery applies). Default: name contains 弓/弩.' },
            two_handed: { type: 'boolean', description: 'Wielded two-handed (Great Weapon Fighting applies). Default: notes contain 双手.' },
            riders: {
              type: 'array',
              description: 'Multi-part extra damage on hit (e.g. [{damage:"2d6", damage_type:"火焰"}]), rolled separately with its own resistance/immunity and doubled on crit.',
              items: {
                type: 'object',
                properties: {
                  damage: { type: 'string' },
                  damage_type: { type: 'string' },
                },
                required: ['damage', 'damage_type'],
                additionalProperties: false,
              },
            },
          },
          required: ['name', 'damage'],
          additionalProperties: false,
        },
      },
      notes: { type: 'string', description: 'Replaces ALL notes. Read current notes and preserve unrelated abilities, passives, active effects and agreements when editing. Notes alone do not apply mechanical bonuses; use supported structured fields too.' },
      absent: { type: 'boolean', description: 'PC only (active session): true temporarily removes an absent player\'s PC from the party (and initiative); false returns them to the party at the current room.' },
      delegate: { type: 'string', description: 'PC only (active session, update): temporarily transfer control to another player without overwriting original player_id, hand over to DM to prevent AFK lost reactions, or clear. Pass a teammate character name (e.g. "奇塔露"), member id ("U2"), "dm", or "none"/"clear".' },
      delegate_player: { type: 'string', description: 'Optional display nickname when `delegate` is a raw member id (#U2) with no PC sheet name to infer from.' },
      brief: { type: 'boolean', description: 'For show: one line (HP, AC, conditions, resources, room) instead of the full sheet.' },
    },
    ['action'],
    async (args, exec) => {
      const action = String(args.action);
      const key = recordOf(exec).sessionKey;
      const { campaign } = service.active(key) ?? service.saved(key) ?? service.require(key);
      assertPausedSheet(campaign, args);
      if (action === 'list' || action === 'show') {
        if (action === 'list') {
          const visible = campaign.active ? campaign.characters : campaign.characters.filter((ch) => ch.kind === 'pc');
          return visible.length === 0
            ? '还没有角色。'
            : visible.map((ch) => `${ch.name}${ch.player ? `〈${ch.player}〉` : ''} ${ch.kind} HP ${ch.hp}/${ch.maxHp}${isAbsent(ch) ? ' [暂离]' : (roomOf(campaign, ch) ? ` @${roomOf(campaign, ch)}` : '')}`).join('\n');
        }
        const several = strList(args.names);
        if (several !== undefined && several.length > 0) {
          // 一次看几个人只给一行摘要：整张卡连着贴几张，比分开调还费上下文
          return several.map((n) => characterBrief(campaign, requireCharacter(campaign, n))).join('\n');
        }
        const target = requireCharacter(campaign, String(args.name ?? ''));
        return args.brief === true ? characterBrief(campaign, target) : sheet(target, whoOf(exec), campaign);
      }
      // SRD 数据先取回来（网络请求不能放进同步的 mutate 里）
      const srdIndex = action === 'create' ? str(args.srd) : undefined;
      const srdBase = srdIndex === undefined ? undefined : srdMonsterInput(await requireSrd('monsters', srdIndex));
      // 法术链接要联网验，放在改存档之前：验不过整张卡都不动
      const spellArgs = args.spells === undefined ? undefined : parseSpellInputs(args.spells, 'spells');
      const addSpellArgs = args.add_spells === undefined ? undefined : parseSpellInputs(args.add_spells, 'add_spells');
      const spellNotes: string[] = [];
      let newSpells: CardSpell[] | undefined;
      let addSpells: CardSpell[] = [];
      if (spellArgs !== undefined || addSpellArgs !== undefined) {
        const list = await srdList('spells');
        const slugOf = (name: string): string | undefined => {
          const r = resolveSrdQuery(name, list, zhTable('spells'));
          return r.kind === 'exact' ? r.index : undefined;
        };
        if (spellArgs !== undefined) {
          const r = await resolveSpells(spellArgs, slugOf, deps.checkUrl);
          newSpells = r.spells;
          spellNotes.push(...r.notes);
        }
        if (addSpellArgs !== undefined) {
          const r = await resolveSpells(addSpellArgs, slugOf, deps.checkUrl);
          addSpells = r.spells;
          spellNotes.push(...r.notes);
        }
      }
      const removeSpells = strList(args.remove_spells) ?? [];
      /** 改一张卡，返回给模型看的文字。抛错时整次调用不落盘，批量改到一半失败也不会只改了前几个 */
      const applyOne = (c: Campaign, adventure: Adventure, name: string | undefined): string => {
        if (name === undefined) throw new Error('dnd_character: name 不能为空');
        if (args.room !== undefined || action === 'remove') assertNoPending(c, '换房间或移除角色');
        if (action === 'update' && str(args.room) !== undefined && args.forced_move !== true) assertCombatExit(c, requireCharacter(c, name), String(args.room));
        if (action === 'update' && isAbsent(requireCharacter(c, name)) && str(args.room) !== undefined && args.absent !== false) {
          throw new Error(`${requireCharacter(c, name).name} 已暂时移出队伍，改房间请先传 absent=false 归队`);
        }
        if (action === 'create' && args.absent !== undefined) {
          throw new Error('dnd_character create 不支持传 absent；建好卡后如需暂离请用 update absent=true');
        }
        if (action === 'create' && args.delegate !== undefined) {
          throw new Error('dnd_character create 不支持传 delegate；建好卡后如需托管请用 update delegate=...');
        }
        if (action === 'remove') return `已移除 ${removeCharacter(c, name).name}`;
        if (action === 'create' && str(args.kind) !== 'pc') {
          // 11-05 黑蜘蛛被现场建成「黑蜘蛛·内兹纳尔」，死讯没挂到模组的内兹纳上，神庙的剧本还让他再出场一次
          const npc = moduleNpcNamed(c, adventure, name);
          if (npc !== undefined && !npcAlive(c, npc.id)) throw new Error(`「${name}」是模组里的具名 NPC ${npc.name}(${npc.id})。${reviveHint(npc)}`);
          if (npc !== undefined) {
            throw new Error(`「${name}」是模组里的具名 NPC ${npc.name}(${npc.id})：上场用 dnd_story npc ${npc.id} fight=true（同行用 join=true），数据照模组。确实是另一个生物就换个不含「${npc.name}」和他别名的名字。`);
          }
        }
        if (action === 'update' && findCharacter(c, name) === undefined) throw new Error(`找不到角色「${name}」，要新建用 create`);
        const prevExisting = action === 'update' ? findCharacter(c, name) : undefined;
        const prevLevel = prevExisting?.level;
        const prevClassName = prevExisting?.className;
        const abilities: Partial<Record<Ability, number>> = { ...srdBase?.abilities };
        for (const a of ABILITIES) {
          const v = int(args[a]);
          if (v !== undefined) abilities[a] = v;
        }
        const input: CharacterInput = { ...srdBase, name: action === 'update' ? requireCharacter(c, name).name : name, abilities };
        const kind = str(args.kind) ?? (srdBase !== undefined ? 'monster' : undefined);
        if (kind !== undefined) input.kind = kind as CharacterKind;
        const optional = {
          player: str(args.player), playerId: memberId(exec, args.player_id, 'player_id'), className: str(args.class_name), level: int(args.level), maxHp: int(args.max_hp),
          ac: int(args.ac), initBonus: int(args.init_bonus), attackBonus: int(args.attack_bonus), damage: str(args.damage), notes: str(args.notes),
          skills: parseSkills(strList(args.skills)), expertise: parseSkills(strList(args.expertise)), saves: parseAbilities(strList(args.saves)),
          weapons: parseWeapons(args.weapons), room: str(args.room), hitDie: str(args.hit_die), traits: strList(args.traits),
          speed: int(args.speed), flySpeed: int(args.fly_speed), hover: typeof args.hover === 'boolean' ? args.hover : undefined,
          reactions: parseReactions(args.reactions),
        };
        for (const [k, v] of Object.entries(optional)) {
          if (v !== undefined) (input as unknown as Record<string, unknown>)[k] = v;
        }
        // 新建的怪物/NPC 默认放在队伍主位置，才会进这个房间的先攻
        if (action === 'create' && input.room === undefined && input.kind !== undefined && input.kind !== 'pc') input.room = c.currentRoom;

        const count = action === 'create' ? Math.min(Math.max(int(args.count) ?? 1, 1), 20) : 1;
        if (count > 1) {
          const names = numberedNames(c, name, count);
          const made = names.map((n) => upsertCharacter(c, { ...input, name: n }).character);
          return `已建卡 ${made.length} 个：${names.join('、')}\n${sheet(made[0]!, whoOf(exec), c)}`;
        }
        if (action === 'create' && findCharacter(c, name)?.name === name) throw new Error(`已经有「${name}」了，改数据用 update，再加一只换个名字或传 count`);
        const roomsBefore = fightRooms(c);
        const { character, created } = upsertCharacter(c, input);
        const lines = [`${created ? '已建卡' : '已更新'}：`];
        // 战斗中换到交战房间以外（逃跑、去报信）：移出先攻表，不然它会一直占着回合
        const newRoom = str(args.room);
        if (action === 'update' && typeof args.absent === 'boolean') {
          const absRes = setCharacterAbsent(c, character.name, args.absent);
          if (args.absent === false && newRoom !== undefined) requireCharacter(c, character.name).room = newRoom;
          const ci = service.checkIns.get(key);
          const updatedCh = requireCharacter(c, character.name);
          if (ci !== undefined && updatedCh.playerId !== undefined) {
            if (args.absent) ci.arrived.delete(updatedCh.playerId);
            else ci.arrived.set(updatedCh.playerId, Date.now());
          }
          if (absRes.leftCombat) {
            lines.unshift(`${character.name} 已暂时移出队伍并移出先攻表。`);
          } else if (args.absent === false && absRes.changed && c.initiative !== undefined && !inInitiative(c, character.name)) {
            lines.unshift(`${character.name} 已归队（当前战斗进行中，如需入战请用 dnd_initiative join）。`);
          }
        }
        if (action === 'update' && args.delegate !== undefined) {
          const cleaned = (str(args.delegate) ?? '').trim();
          let target: DelegationTarget;
          if (cleaned === '' || /^(none|clear|off|owner|cancel|无|解除|取消|收回)$/i.test(cleaned)) {
            target = { mode: 'none' };
          } else if (/^dm$/i.test(cleaned)) {
            target = { mode: 'dm' };
          } else {
            const refChar = findCharacter(c, cleaned);
            if (refChar !== undefined) {
              if (refChar.kind !== 'pc' || refChar.playerId === undefined) {
                throw new Error(`「${refChar.name}」没有绑定玩家，不能作为受托托管玩家；请传已绑玩家的队友角色名、成员编号（如 U2）或 "dm"`);
              }
              const nick = str(args.delegate_player) ?? refChar.player;
              target = {
                mode: 'player',
                playerId: refChar.playerId,
                ...(nick !== undefined ? { player: nick } : {}),
              };
            } else {
              const pid = memberId(exec, cleaned, 'delegate')!;
              const matchedOwner = c.characters.find((x) => x.kind === 'pc' && x.playerId === pid);
              const nick = str(args.delegate_player) ?? matchedOwner?.player;
              target = {
                mode: 'player',
                playerId: pid,
                ...(nick !== undefined ? { player: nick } : {}),
              };
            }
          }
          const delRes = setCharacterDelegation(c, character.name, target);
          const updatedDel = requireCharacter(c, character.name);
          const tag = delegationTag(updatedDel);
          if (tag !== undefined) {
            lines.unshift(`${character.name} 已设为「${tag}」${isDmDelegated(updatedDel) ? '（DM 可直接代为行动、结束回合与触发反应窗口，原玩家绑定保留）' : '（受托玩家与原玩家均可行动、回应反应与点击回合按钮，原玩家绑定保留）'}。`);
          } else if (delRes.changed) {
            lines.unshift(`${character.name} 已解除托管，恢复原玩家控制。`);
          }
        }
        if (!created && newRoom !== undefined && inInitiative(c, character.name) && !roomsBefore.has(newRoom)) {
          const wasCurrent = c.initiative!.order[c.initiative!.turn]?.name === character.name;
          leaveInitiative(c, character.name);
          lines.unshift(`${character.name} 离开了交战区域，已移出先攻表${wasCurrent ? '；它的回合到此结束，接着调用 dnd_initiative next' : ''}。`);
        }
        const add = strList(args.add_items) ?? [];
        const remove = strList(args.remove_items) ?? [];
        const gp = int(args.gp_change) ?? 0;
        if (add.length > 0 || remove.length > 0 || gp !== 0) changeInventory(c, character.name, add, remove, gp);
        const itemHint = add.length > 0 ? hookHint(c, add.join('\n')) : undefined;
        if (newSpells !== undefined || addSpells.length > 0 || removeSpells.length > 0) {
          const ch = requireCharacter(c, character.name);
          ch.spells = mergeSpells(newSpells ?? ch.spells ?? [], addSpells, removeSpells);
        }
        const maxHpChange = int(args.max_hp_change) ?? 0;
        if (maxHpChange !== 0) {
          const ch = requireCharacter(c, character.name);
          ch.maxHp = Math.max(1, ch.maxHp + maxHpChange);
          // 倒地的人不靠加上限站起来：那是治疗的事
          if (maxHpChange > 0 && ch.hp > 0) ch.hp += maxHpChange;
          ch.hp = Math.min(ch.hp, ch.maxHp);
        }
        const finalCh = requireCharacter(c, character.name);
        const syncedRes = action === 'update' && args.sync_resources !== false
          ? syncLevelUpResources(c, finalCh, prevLevel, prevClassName)
          : [];
        if (syncedRes.length > 0) {
          spellNotes.push(`升级/兼职自动同步资源：${syncedRes.join('、')}`);
        }
        const missingSpellResources = [...new Set(
          (finalCh.spells ?? [])
            .map((s) => s.resource?.trim())
            .filter((rk): rk is string => Boolean(rk) && finalCh.resources?.[rk!] === undefined),
        )];
        if (missingSpellResources.length > 0) {
          spellNotes.push(`角色能力引用了尚未建立的资源「${missingSpellResources.join('、')}」，请用 dnd_resource action="set" 补齐上限`);
        }
        lines.push(sheet(finalCh, whoOf(exec), c));
        if (spellNotes.length > 0) lines.push(`【DM】${spellNotes.join('；')}`);
        if (itemHint !== undefined) lines.push(itemHint);
        return lines.join('\n');
      };
      return mutate(exec, (c, adventure) => {
        // 法术链接校验会等待网络；这期间可能收团，落盘前按最新状态再检查。
        assertPausedSheet(c, args);
        const several = strList(args.names);
        if (several === undefined || several.length === 0) return applyOne(c, adventure, str(args.name));
        if (action !== 'update') throw new Error('names 只用于 update 和 show。一次建多只怪用 count，移除一个个来');
        // 这些字段是某一个人自己的，批量套给所有人一定是填错了
        const personal = ['name', 'player', 'player_id', 'weapons', 'spells', 'add_spells', 'remove_spells', 'reactions', 'max_hp', 'class_name']
          .filter((key) => args[key] !== undefined);
        if (personal.length > 0) throw new Error(`带 names 批量改时不能给 ${personal.join('、')}：这些是单个人的，分开改（上限统一加减用 max_hp_change）`);
        for (const who of several) applyOne(c, adventure, who);
        return `已更新 ${several.length} 个：\n${several.map((who) => characterBrief(c, requireCharacter(c, who))).join('\n')}`;
      }, { allowPaused: true });
    },
  );

  register(
    'dnd_resource',
    'Track limited-use resources and transferable concentration: spell slots (e.g. "1环法术位", "契约法术位（3环）"), lay on hands pool ("圣疗池"), bardic inspiration '
    + '("诗人激励"), class features ("战争祭司"), potions. set: create or change max (increasing max on level-up automatically adds the newly gained uses); use: spend (fails if not enough); '
    + 'restore: give back (omit amount to refill); transfer: move an active transferable concentration spell (脆弱诅咒 Hex, 猎人印记 Hunter\'s Mark) to a new target at ZERO spell-slot cost after the previous target dropped to 0 HP. '
    + 'Set the max the first time a resource comes up. Spend only when the owning player says they use it. '
    + 'Reactions are a built-in 0/1 combat resource, shown on dnd_character show and restored at the actor\'s next turn; do not create a second resource or spend it separately. Reaction tools account for it automatically. '
    + 'While paused, only set on a PC is allowed, to configure a sheet without starting play; use/restore/transfer require an active adventure.',
    {
      action: { type: 'string', enum: ['set', 'use', 'restore', 'transfer'] },
      character: { type: 'string' },
      resource: { type: 'string', description: 'Resource key (required for set/use/restore; optional for transfer).' },
      amount: { type: 'integer', description: 'use/restore: how much (default 1 / refill). For lay on hands, the HP spent.' },
      target: { type: 'string', description: 'For transfer, targeted class features (e.g. "咒剑诅咒"), or single-target apply_state: the target creature name.' },
      targets: { type: 'array', items: { type: 'string' }, description: 'For use with apply_state on multiple creatures (e.g. 祝福术 on 3 allies, 灾祸术 on foes).' },
      apply_state: {
        type: 'string',
        description: 'For use/transfer: atomically attach or transfer a structured active state/buff (e.g. "脆弱诅咒", "猎人印记", "祝福术", "灾祸术", "护盾信仰", "加速术", "狂暴", "神圣武器", "闪避", "妖火", "无痕步", "朦胧术"). Automatically applies attack/save/AC/speed modifiers, concentration binding, cross-combat retention and round countdowns.',
      },
      concentration: { type: 'boolean', description: 'For apply_state: whether this effect requires concentration (auto-breaks previous concentration). Auto-detected for standard spells like 祝福术/护盾信仰/加速术/脆弱诅咒/猎人印记/无痕步.' },
      drop_concentration: { type: 'boolean', description: 'Drop active concentration for this character (pass resource="专注" drop_concentration=true to drop without spending a resource).' },
      slot_level: { type: 'integer', description: 'Optional spell slot level (1-9; auto-inferred when resource is like "3环法术位" or "契约法术位（3环）", used for upcast 灵体卫士 or 8h/24h 脆弱诅咒/猎人印记).' },
      rounds: { type: 'integer', description: 'For apply_state: duration in 6-second combat rounds. Omit to use standard 5e spell duration automatically (600 for 1h Hex/Hunter\'s Mark/Pass without Trace, 4800 for 3-4 slot Hex/Hunter\'s Mark, 100 for 10-min Shield of Faith, 10 for 1-min buffs).' },
      hit_bonus: { type: 'integer', description: 'For apply_state: flat attack bonus while active (神圣武器 auto-computes max(1, CHA mod) if omitted).' },
      ac_bonus: { type: 'integer', description: 'For apply_state: flat AC bonus while active (护盾信仰/加速术 auto-apply +2 if omitted).' },
      action_cost: { type: 'string', enum: ['action', 'bonus', 'reaction', 'free'], description: 'Optional turn action-economy slot spent in combat (records 主动作/附赠动作 and warns on duplicate usage).' },
      temp_hp: { type: 'integer', description: 'Optional temporary HP override for features like "战斗英姿" (computed automatically from fighter level if omitted).' },
      ignore_state_mods: { type: 'boolean', description: 'For transfer: allow transferring before the previous target drops to 0 HP when a special feature permits.' },
      max: { type: 'integer', description: 'For set.' },
      current: { type: 'integer', description: 'For set: current value (omit to fill new resource or add +Δmax on level-up).' },
      reset: { type: 'string', enum: ['short', 'long', 'none'], description: 'For set: which rest refills it.' },
    },
    ['action', 'character'],
    (args, exec) => mutate(exec, (c) => {
      const name = String(args.character ?? '');
      const key = String(args.resource ?? '');
      const action = String(args.action);
      if (action !== 'transfer' && key.trim().length === 0) {
        throw new Error(`dnd_resource ${action} 需要提供 resource 参数`);
      }
      if (/^(反应|reaction)$/i.test(key.trim())) {
        if (action === 'restore') {
          if (!c.active || c.initiative === undefined) throw new Error('反应名额只在战斗中记账，当前不在战斗中');
          assertNoPending(c, '恢复反应名额');
          const ch = requireCharacter(c, name);
          const had = restoreReaction(c, ch.name);
          return had ? `已退回 ${ch.name} 本轮的反应名额（1/1）` : `${ch.name} 本轮的反应本来就是可用状态（1/1）`;
        }
        throw new Error('反应由战斗工具按 0/1 自动记账，在自己下回合开始恢复；不要用 dnd_resource 创建或手动消耗（仅误扣退费时可用 action=restore resource="反应"）。用 dnd_character show 查看');
      }
      if (!c.active && (action !== 'set' || requireCharacter(c, name).kind !== 'pc')) {
        throw new Error('停团时只能用 dnd_resource set 配置 PC 资源；消耗、恢复和专注转移请开团后操作');
      }
      if (action === 'set') {
        const max = int(args.max);
        if (max === undefined) throw new Error('dnd_resource set 需要 max');
        const reset = args.reset === 'short' || args.reset === 'none' ? args.reset : 'long';
        const r = setResource(c, name, key, max, reset, int(args.current));
        return `${requireCharacter(c, name).name}「${key.trim()}」${r.current}/${r.max}`;
      }

      const globalEffects = service.globalEffects();
      const executeConcentrationTransfer = (): string => {
        if (c.initiative !== undefined) assertNoPending(c, '转移专注');
        const ch = requireCharacter(c, name);
        const targetName = str(args.target) ?? strList(args.targets)?.[0];
        if (targetName === undefined) {
          throw new Error('转移专注需要传 target="新目标名"');
        }
        const targetCh = requireCharacter(c, targetName);
        const rawSpell = str(args.apply_state) ?? (!/^(?:专注|concentration|)$/i.test(key.trim()) ? key.trim() : undefined);
        const res = transferConcentration(c, ch, targetCh, {
          ...(rawSpell !== undefined ? { spellName: rawSpell } : {}),
          force: args.ignore_state_mods === true,
          globalEffects,
        });
        const warnings: string[] = [];
        const onOwnTurn = c.initiative !== undefined && c.initiative.order[c.initiative.turn]?.name === ch.name;
        const ts = onOwnTurn ? ensureTurnState(c) : undefined;
        const costKind = (str(args.action_cost) as 'action' | 'bonus' | 'reaction' | 'free' | undefined) ?? 'bonus';
        if (ts !== undefined && costKind === 'bonus') {
          if (ts.bonusUsed !== undefined) {
            warnings.push(`【动作经济提醒】${ch.name} 本回合此前已使用过附赠动作（${ts.bonusUsed}），每回合通常只有 1 个附赠动作`);
          }
          ts.bonusUsed = `转移${res.spellName}`;
        } else if (ts !== undefined && costKind === 'action') {
          if (ts.actionUsed !== undefined || ts.attacks > 0) {
            warnings.push(`【动作经济提醒】${ch.name} 本回合此前已使用主动作（${ts.actionUsed ?? `已攻击×${ts.attacks}`}）`);
          }
          ts.actionUsed = `转移${res.spellName}`;
        }
        pushLog(c, `${ch.name} 将「${res.spellName}」专注转移至 ${targetCh.name}`);
        const warnSuffix = warnings.length > 0 ? `\n${warnings.join('\n')}` : '';
        return `${ch.name} 消耗附赠动作将「${res.spellName}」免费转移至「${targetCh.name}」（未消耗法术位，剩余 ${res.roundsLeft} 轮）${warnSuffix}${combatLedgerSuffix(c)}`;
      };

      if (action === 'transfer') {
        return executeConcentrationTransfer();
      }

      if (action === 'use') {
        const ch = requireCharacter(c, name);
        if (/^(专注|concentration)$/i.test(key.trim())) {
          if (args.drop_concentration === true) {
            const broken = [...breakConcentration(c, ch.name, '主动解除专注'), ...checkAllAirborneCrashes(c, service.roller, globalEffects)];
            return `${broken.length > 0 ? broken.join('；') : `${ch.name} 当前没有维持中的专注效果`}${combatLedgerSuffix(c)}`;
          }
          if (str(args.target) !== undefined || (strList(args.targets)?.length ?? 0) > 0) {
            return executeConcentrationTransfer();
          }
          throw new Error(`${ch.name} 解除专注请传 drop_concentration=true；若要免费转移「脆弱诅咒/猎人印记」等专注目标，请传 action="transfer" target="新目标名"`);
        }

        const rawApplyStatePre = str(args.apply_state);
        const normApplyStatePre = rawApplyStatePre !== undefined ? normalizeCondition(rawApplyStatePre) : undefined;
        // 防误扣法术位护栏：施法者已在维持同名可转移专注且原目标已倒下/可转移时，阻止重复扣法术位并引导用 action="transfer"
        if (normApplyStatePre !== undefined && args.drop_concentration !== true && isTransferableState(c, normApplyStatePre, globalEffects)) {
          const cs = ch.concentrationState;
          const legacyMarked = concentratingOn(c, ch.name).filter((x) => normalizeCondition(x.state.name) === normApplyStatePre);
          const hasActiveSameConc = (cs !== undefined && normalizeCondition(cs.name) === normApplyStatePre) || legacyMarked.length > 0;
          if (hasActiveSameConc) {
            const liveInCurrentFight = legacyMarked.some((x) =>
              x.owner.hp > 0
              && !x.owner.conditions.includes('死亡')
              && (c.initiative !== undefined ? c.initiative.order.some((e) => e.name === x.owner.name) : roomOf(c, x.owner) === roomOf(c, ch)),
            );
            if (cs?.canTransfer === true || !liveInCurrentFight) {
              const tgtHint = str(args.target) ?? strList(args.targets)?.[0] ?? '新目标名';
              throw new Error(
                `${ch.name} 仍在维持「${normApplyStatePre}」的专注，无需重复消耗「${key.trim()}」；`
                + `请改用 dnd_resource action="transfer" character="${ch.name}" target="${tgtHint}" apply_state="${normApplyStatePre}" 免费转移目标`
                + `（若确需放弃当前专注并消耗法术位重新施放，请传 drop_concentration=true）`,
              );
            }
          }
        }
        const [matchedKey] = requireResource(ch, key);
        let curseTarget: ReturnType<typeof requireCharacter> | undefined;
        if (/^(咒剑诅咒|Hexblade'?s Curse)$/i.test(matchedKey.trim())) {
          const targetArg = str(args.target);
          if (targetArg !== undefined) {
            curseTarget = requireCharacter(c, targetArg);
          } else if (c.initiative !== undefined) {
            const foes = c.initiative.order
              .map((e) => findCharacter(c, e.name))
              .filter((f): f is NonNullable<typeof f> => f !== undefined && !isOut(f) && (ch.kind === 'monster' ? f.kind !== 'monster' : f.kind === 'monster'));
            if (foes.length === 1) curseTarget = foes[0];
            else if (foes.length > 1) {
              throw new Error('场上不止一个敌方目标，使用「咒剑诅咒」请传 target="目标名" 指定诅咒对象');
            }
          }
        }
        const result = useResource(c, ch.name, key, int(args.amount) ?? 1);
        const baseLine = `${ch.name}「${result.key}」${result.before}→${result.resource.current}/${result.resource.max}`;
        const keyTrim = result.key.trim();
        const slotMatch = /([1-9])\s*环/.exec(keyTrim);
        const slotLevel = int(args.slot_level) ?? (slotMatch !== null ? Number(slotMatch[1]) : undefined);
        const rawApplyState = str(args.apply_state);
        const normApplyState = rawApplyState !== undefined ? normalizeCondition(rawApplyState) : undefined;
        const isSacredWeapon = /^(神圣武器|Sacred Weapon)$/i.test(keyTrim) || normApplyState === '神圣武器';
        const isActionSurge = /^(动作如潮|Action Surge)$/i.test(keyTrim);
        const isFightingSpirit = /^(战斗英姿|Fighting Spirit)$/i.test(keyTrim);
        const isRageResource = /^(狂暴|Rage)$/i.test(keyTrim);
        const isBonusSpellState = normApplyState === '护盾信仰' || normApplyState === '猎人印记' || normApplyState === '脆弱诅咒' || normApplyState === '神恩';

        // 当前行动者回合内自动追踪主动作/附赠动作槽位并提示重复消耗
        const warnings: string[] = [];
        if (args.drop_concentration === true) {
          warnings.push(...breakConcentration(c, ch.name, '主动解除专注'), ...checkAllAirborneCrashes(c, service.roller, globalEffects));
        }
        const onOwnTurn = c.initiative !== undefined && c.initiative.order[c.initiative.turn]?.name === ch.name;
        const ts = onOwnTurn ? ensureTurnState(c) : undefined;
        const explicitCost = str(args.action_cost) as 'action' | 'bonus' | 'reaction' | 'free' | undefined;
        const inferredCost: 'action' | 'bonus' | 'reaction' | 'free' | undefined = explicitCost
          ?? (isActionSurge ? 'free' : undefined)
          ?? (isFightingSpirit || curseTarget !== undefined || isRageResource || normApplyState === '狂暴' || isBonusSpellState || /^(回气|Second Wind)$/i.test(keyTrim) ? 'bonus' : undefined)
          ?? (isSacredWeapon ? 'action' : undefined);

        if (isActionSurge) {
          if (ts !== undefined) {
            delete ts.actionUsed;
            ts.attacks = 0;
          }
          return `${baseLine}；动作如潮生效，本回合获得额外一个主动作（主动作与攻击计数已刷新）${combatLedgerSuffix(c)}`;
        }
        if (ts !== undefined && inferredCost === 'action') {
          if (ts.actionUsed !== undefined || ts.attacks > 0) {
            warnings.push(`【动作经济提醒】${ch.name} 本回合此前已使用主动作（${ts.actionUsed ?? `已攻击×${ts.attacks}`}），请核对是否有动作如潮或特殊规则支持`);
          }
          ts.actionUsed = normApplyState ?? keyTrim;
        } else if (ts !== undefined && inferredCost === 'bonus') {
          if (ts.bonusUsed !== undefined) {
            warnings.push(`【动作经济提醒】${ch.name} 本回合此前已使用过附赠动作（${ts.bonusUsed}），每回合通常只有 1 个附赠动作`);
          }
          ts.bonusUsed = normApplyState ?? keyTrim;
        }
        if (ts !== undefined && (slotLevel !== undefined || isBonusSpellState)) {
          const spellCost = inferredCost ?? (slotLevel !== undefined ? 'action' : undefined);
          const spellWarn = recordTurnSpellCast(ts, ch.name, normApplyState ?? keyTrim, slotLevel ?? 1, spellCost);
          if (spellWarn !== undefined) warnings.push(spellWarn);
        }
        const warnSuffix = warnings.length > 0 ? `\n${warnings.join('\n')}` : '';

        if (curseTarget !== undefined) {
          setHexbladeCurse(c, ch.name, curseTarget.name);
          const prof = proficiencyBonus(ch.level);
          const killHeal = hexbladeKillHeal(ch);
          return `${baseLine}；已对「${curseTarget.name}」施加咒剑诅咒（攻击该目标天然 19-20 重击、命中伤害自动 +${prof}，请勿在 damage 重复填常数；目标死亡恢复 ${killHeal} HP）${warnSuffix}${combatLedgerSuffix(c)}`;
        }
        if (isFightingSpirit) {
          const gain = int(args.temp_hp) ?? fightingSpiritTempHp(ch);
          const hpChange = grantTempHp(c, ch.name, gain);
          if (c.initiative !== undefined) {
            c.initiative.fightingSpirit = [...new Set([...(c.initiative.fightingSpirit ?? []), ch.name])];
          }
          return `${baseLine}；获得 ${gain} 点临时 HP（当前临时 HP ${hpChange.tempHp}）${c.initiative !== undefined ? '，本回合武器攻击自动具有优势（含精灵精准三骰取高）' : ''}${warnSuffix}${combatLedgerSuffix(c)}`;
        }
        if (isSacredWeapon) {
          const hitBonus = int(args.hit_bonus) ?? Math.max(1, abilityModifier(ch.abilities.cha));
          const rounds = int(args.rounds) ?? 10;
          upsertActiveState(c, ch, { name: '神圣武器', source: ch.name, roundsLeft: rounds, hitBonus });
          return `${baseLine}；已激活「神圣武器」（持续 ${rounds} 轮，攻击检定自动 +${hitBonus}）${warnSuffix}${combatLedgerSuffix(c)}`;
        }

        const poolDef = resolveEffectDef(normApplyState ?? keyTrim, c.customEffects, globalEffects);
        if (poolDef?.healMod?.poolFormula !== undefined && (normApplyState === undefined || normApplyState === poolDef.name)) {
          const pool = evalIntFormula(poolDef.healMod.poolFormula, buildFormulaContext(ch, slotLevel !== undefined ? { slotLevel } : {}));
          const capHint = poolDef.healMod.capAtHalfMaxHp
            ? `；接下来请用 dnd_apply caster="${ch.name}" preserve_life=true targets=[...] 分配治疗，每名目标最多恢复至有效生命上限的一半`
            : '';
          return `${baseLine}；「${poolDef.name}」治疗池共 ${pool} 点 HP${capHint}${warnSuffix}${combatLedgerSuffix(c)}`;
        }

        const effectiveApplyState = normApplyState ?? (isRageResource ? '狂暴' : undefined);
        const casterSpellHints = c.initiative !== undefined && ch.kind !== 'monster' && slotLevel !== undefined
          ? hostileSpellcasterHints(c, ch, { kind: 'spell', ...(effectiveApplyState !== undefined ? { spellName: effectiveApplyState } : {}) })
          : [];
        const casterHintSuffix = casterSpellHints.length > 0 ? `\n${casterSpellHints.join('\n')}` : '';

        if (effectiveApplyState !== undefined && effectiveApplyState.length > 0) {
          const effectDef = resolveEffectDef(effectiveApplyState, c.customEffects, globalEffects);
          const isConc = typeof args.concentration === 'boolean'
            ? args.concentration
            : isDefaultConcentrationState(c, effectiveApplyState, globalEffects);
          const targetNames = strList(args.targets) ?? (str(args.target) !== undefined ? [str(args.target)!] : [ch.name]);
          const targetChars = targetNames.map((n) => requireCharacter(c, n));
          const explicitRounds = int(args.rounds);
          // 兼容修正：脆弱诅咒/猎人印记标准最短为 1 小时（600 轮，3-4 环 4800 轮），若模型惯性填了 1 分钟的 rounds=10，自动修正为法术真实持续轮数
          const autoSpellRounds = defaultStateRounds(effectiveApplyState, slotLevel, c, globalEffects);
          const rounds = explicitRounds !== undefined && !(explicitRounds === 10 && (effectiveApplyState === '脆弱诅咒' || effectiveApplyState === '猎人印记'))
            ? explicitRounds
            : (isConc || effectDef?.defaultRounds !== undefined || effectiveApplyState === '狂暴'
              ? autoSpellRounds
              : (effectiveApplyState === '闪避' ? 1 : undefined));
          const expires = effectiveApplyState === '闪避' ? 'start_of_source_turn' as const : undefined;
          const hitBonus = int(args.hit_bonus);
          const acBonus = int(args.ac_bonus);
          const saveDc = effectDef?.aura?.hazard !== undefined ? inferSpellSaveDc(ch) : undefined;

          if (c.initiative !== undefined && ch.kind === 'monster' && slotLevel !== undefined && args.drop_concentration !== true) {
            const spellReactors = eligibleSpellReactors(c, ch, { spellName: effectiveApplyState });
            if (spellReactors.length > 0) {
              const id = rollId(c, exec);
              const p: PendingSpell = {
                kind: 'spell',
                seq: id,
                at: Date.now(),
                attacker: ch.name,
                target: targetChars[0]?.name ?? ch.name,
                reactors: spellReactors,
                declined: [],
                claimed: [],
                used: [],
                spellName: effectiveApplyState,
                spellLevel: slotLevel,
                effect: {
                  kind: 'state',
                  stateName: effectiveApplyState,
                  targets: targetChars.map((x) => x.name),
                  concentration: isConc,
                  ...(rounds !== undefined ? { rounds } : {}),
                  ...(expires !== undefined ? { expires } : {}),
                  ...(hitBonus !== undefined ? { hitBonus } : {}),
                  ...(acBonus !== undefined ? { acBonus } : {}),
                  ...(slotLevel !== undefined ? { slotLevel } : {}),
                  ...(saveDc !== undefined ? { saveDc } : {}),
                  ...(warnings.length > 0 ? { warnings } : {}),
                },
              };
              requireInitiative(c).pending = p;
              deps.onPendingAttack?.(recordOf(exec));
              return `${baseLine}${warnSuffix}\n${ch.name} 正在施放「${effectiveApplyState}」（还没生效） #R${id}\n${holdNotice(p)}\n${SECRET_NOTE}`;
            }
          }

          const broken = isConc
            ? [...breakConcentration(c, ch.name, `改换专注为「${effectiveApplyState}」`), ...checkAllAirborneCrashes(c, service.roller, globalEffects)]
            : [];
          for (const tCh of targetChars) {
            const up = upsertActiveState(c, tCh, {
              name: effectiveApplyState,
              source: ch.name,
              ...(isConc ? { concentration: true } : {}),
              ...(rounds !== undefined ? { roundsLeft: rounds } : {}),
              ...(expires !== undefined ? { expires } : {}),
              ...(hitBonus !== undefined ? { hitBonus } : {}),
              ...(acBonus !== undefined ? { acBonus } : {}),
              ...(slotLevel !== undefined ? { slotLevel } : {}),
              ...(saveDc !== undefined ? { saveDc } : {}),
            }, { replaceConcentration: false, globalEffects });
            broken.push(...up.broken);
          }
          broken.push(...checkAllAirborneCrashes(c, service.roller, globalEffects));
          const metaDesc = [
            isConc ? '需专注' : '',
            rounds !== undefined ? `持续${rounds}轮` : '',
            slotLevel !== undefined && effectDef?.aura?.hazard !== undefined ? `${slotLevel}环施放·DC${saveDc}` : '',
            hitBonus !== undefined ? `命中${hitBonus >= 0 ? '+' : ''}${hitBonus}` : '',
            acBonus !== undefined ? `AC${acBonus >= 0 ? '+' : ''}${acBonus}` : (effectiveApplyState === '护盾信仰' || effectiveApplyState === '加速术' ? 'AC+2' : ''),
          ].filter(Boolean).join('，');
          const brokenSuffix = broken.length > 0 ? `；${broken.join('；')}` : '';
          return `${baseLine}；已对「${targetChars.map((x) => x.name).join('、')}」挂载状态「${effectiveApplyState}」${metaDesc ? `（${metaDesc}）` : ''}${brokenSuffix}${warnSuffix}${casterHintSuffix}${combatLedgerSuffix(c)}`;
        }

        if (c.initiative !== undefined && /^(时间变幻|迷雾逃生|炼狱叱喝|直觉闪避|风暴之怒|偏转飞弹)$/i.test(keyTrim)) {
          if (canReact(ch) && reactionBlocked(c, ch.name) === undefined) {
            spendReaction(c, ch.name);
            return `${baseLine}；已同步记下本轮反应已消耗（0/1）${warnSuffix}${casterHintSuffix}${combatLedgerSuffix(c)}`;
          }
        }
        return `${baseLine}${warnSuffix}${casterHintSuffix}${combatLedgerSuffix(c)}`;
      }
      const result = restoreResource(c, name, key, int(args.amount));
      return `${requireCharacter(c, name).name}「${result.key}」${result.before}→${result.resource.current}/${result.resource.max}`;
    }, { allowPaused: true }),
  );

  register(
    'dnd_rest',
    'Short or long rest for the party (or the listed characters). short: refills short-rest resources; spend hit dice '
    + 'with `hit_dice` ({"卡厄斯": 1}), the tool rolls and heals. long: full HP, all resources, half the hit dice back. '
    + 'Not during combat.',
    {
      kind: { type: 'string', enum: ['short', 'long'] },
      characters: { type: 'array', items: { type: 'string' }, description: 'Omit for everyone in the party.' },
      hit_dice: { type: 'object', additionalProperties: { type: 'integer' }, description: 'short rest: character → dice to spend.' },
    },
    ['kind'],
    (args, exec) => mutate(exec, (c) => {
      const spend: Record<string, number> = {};
      if (args.hit_dice !== null && typeof args.hit_dice === 'object') {
        for (const [k, v] of Object.entries(args.hit_dice as Record<string, unknown>)) {
          const n = int(v);
          if (n !== undefined && n > 0) spend[k] = n;
        }
      }
      const kind = args.kind === 'long' ? 'long' : 'short';
      const results = rest(c, kind, strList(args.characters), spend, service.roller);
      return `${kind === 'long' ? '长休' : '短休'}完成：\n${results.map((r) => `${r.name}：${r.lines.join('，') || '无变化'}`).join('\n')}`;
    }),
  );
}
