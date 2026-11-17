/** 掷骰与结算：dnd_roll、dnd_check、dnd_apply。 */
import { rollD20,rollExpression } from '../dice.ts';
import {
type PendingAttack,
type PendingRider,
type PendingCheck,applyDamage,
armorClass,assertCanAct,assertDeclaredByOwner,assertNoPending,attackModifier,
changeCondition,checkAllAirborneCrashes,checkModifier,deathSave,findCharacter,
findWeapon,grantTempHp,heal,hexbladeCurseOn,inInitiative,isRangedWeapon,pushCombatLedger,requireCharacter,
requireInitiative,requireResource,usesElvenAccuracy,useResource,weaponAttackModifier,spendReaction
} from '../campaign.ts';
import {
activeEffectDefsFor,breakConcentration,collectHitRiders,computeAttackStateMods,computeCheckStateMods,computeDefenseStateMod,
computeSaveStateMods,effectiveMaxHp,ensureTurnState,formatStateModSummary,hasCondition,movementSpeedInfo,normalizeCondition,recordTurnSpellCast
} from '../conditions.ts';
import { buildFormulaContext,evalIntFormula } from '../formula.ts';
import { ABILITY_NAMES,type Ability,type Skill,SKILLS,parseAbility,parseSkill,proficiencyBonus,skillLabel } from '../rules.ts';
import {
attackRangeNote,canReact,cellOf,distanceFeet,weaponReach
} from '../battlefield.ts';
import {
assertReactionAuthorized,eligibleReactors,holdNotice,
manualReactors,
mergeReactors
} from '../pending-attack.ts';
import {
DEFENSE_NAMES,parseDefense,
parseSaveTargets,saveDamage
} from '../save-effect.ts';
import { resolveMovement } from '../movement.ts';
import {
SECRET_NOTE,
HIDDEN_ROLL_NOTE,attackExpression,
rollAttackDamage,
rollCollectedRiders,
onHitArg,settleAttackDamage,str,
int,
strList,advantageOf,hpLine,combatLedgerSuffix,type ToolKit
} from './shared.ts';

export function registerDiceTools(kit: ToolKit): void {
  const { deps, service, recordOf, mutate, rollId, sendersOf, memberId, resolvePending, saveEffectText, register } = kit;

  register(
    'dnd_roll',
    'Roll dice for the D&D game (damage, random tables, anything not covered by dnd_check). Never invent dice '
    + 'results yourself: always call this. Supports NdM, NdMkhX/klX, constants joined by + or -, e.g. "2d6+3", "4d6kh3".',
    {
      expression: { type: 'string', description: 'Dice expression, e.g. "1d8+2".' },
      reason: { type: 'string', description: 'What the roll is for, e.g. "长剑伤害".' },
      secret: { type: 'boolean', description: 'DM-only roll: do not tell players the number.' },
    },
    ['expression'],
    (args) => {
      const expression = str(args.expression);
      if (expression === undefined) throw new Error('dnd_roll: expression 不能为空');
      const result = rollExpression(expression, service.roller);
      const reason = str(args.reason);
      return `${reason ? `${reason}：` : ''}${result.detail}${args.secret === true ? HIDDEN_ROLL_NOTE : ''}`;
    },
  );

  register(
    'dnd_check',
    'Resolve a d20 roll for a character: skill check, ability check, saving throw, attack, or death save. '
    + 'The DC (or the target\'s AC) stays hidden from players. For attacks with a known damage expression the hit '
    + 'damage is rolled (crits double the dice) and applied to the target automatically. '
    + 'Save effects (fireball, breath weapon, sacred flame, a trap on several PCs): ONE call with type=save, '
    + '`character` = the caster/source, `targets` = everyone who saves, plus dc, ability, damage; the tool rolls '
    + 'damage once, rolls each save, halves on success (on_save), applies resistance/immunity and HP, and adds '
    + 'on_fail_conditions to whoever fails. Never loop one call per target, pre-roll the damage, or add the failure '
    + 'condition with a separate dnd_apply. Spell attacks: type=attack with the casting `ability`, `damage`, `damage_type` '
    + 'and `spend` for the slot. A PC acting on another PC (shove, grab, steal): ask that player first; contested rolls '
    + 'are rolled for both, the passive side with reaction=true. Every result carries a roll id (#R12): dnd_undo roll=R12 '
    + 'reverts that roll and everything after it. Out-of-combat rerolls after seeing the number (Chronal Shift, Lucky): '
    + 'dnd_undo roll=R12 first, then call dnd_check again (with `spend`). '
    + 'For a player-authorized "if the final hit lands, use Divine Smite", pass on_hit with damage/type/spend; it is resolved only after defensive reactions and costs nothing on a final miss. Never infer permission to spend from merely knowing the ability.',
    {
      character: { type: 'string', description: 'Who rolls (character name or the player\'s nickname).' },
      type: { type: 'string', enum: ['skill', 'ability', 'save', 'attack', 'death'] },
      skill: { type: 'string', description: 'For type=skill, e.g. "察觉" or "stealth".' },
      ability: {
        type: 'string',
        description: 'For ability/save, e.g. "敏捷". For attack: override the attack ability; spell attacks MUST pass the '
          + 'casting ability (wis cleric/druid/ranger, int wizard, cha bard/paladin/sorcerer/warlock).',
      },
      dc: { type: 'integer', description: 'Difficulty class for skill/ability/save. Secret.' },
      target: { type: 'string', description: 'For type=attack: the character being attacked.' },
      targets: {
        type: 'array',
        description: 'For type=save: creatures that make the save (then `character` is the caster or source, e.g. '
          + 'a trap name). Only `name` is required per item. Use it even for one target.',
        // 只用对象形式：不确定宿主/模型端是否支持 anyOf；运行时仍兼容纯字符串
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            advantage: { type: 'string', enum: ['none', 'advantage', 'disadvantage'] },
            bonus: { type: 'integer' },
            bonus_dice: { type: 'string', description: 'Extra dice for THIS target\'s save, rolled by the tool (e.g. Bless "1d4"). Overrides global bonus_dice; "" means no bonus dice for this target. Never pre-roll with dnd_roll.' },
            defense: { type: 'string', enum: ['resistant', 'immune', 'vulnerable'], description: 'Against this damage type.' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      on_save: { type: 'string', enum: ['half', 'none'], description: 'For type=save with damage: what a successful save takes (default half).' },
      on_fail_conditions: {
        type: 'array',
        items: { type: 'string' },
        description: 'For type=save with dc: conditions each failing target gets, e.g. ["麻痹"] for hold person, ["倒地"] for '
          + 'thunderwave. Applied in the same step as the damage, so one undo takes both back.',
      },
      defense: {
        type: 'string',
        enum: ['resistant', 'immune', 'vulnerable'],
        description: 'The attack target (or the lone saver when there are no `targets`) resists / is immune / vulnerable to this damage type.',
      },
      weapon: {
        type: 'string',
        description: 'For type=attack: weapon name from the attacker\'s sheet; damage and ability come from it. Weapon missing from '
          + 'the sheet: add it with dnd_character update weapons first, never improvise damage dice.',
      },
      damage: {
        type: 'string',
        description: 'For type=attack: damage expression for spells/special attacks, or extra dice such as sneak attack "1d6". '
          + 'With `weapon` it is ADDED to the weapon damage. For type=save: the effect\'s full damage, rolled once for all targets.',
      },
      damage_type: { type: 'string', description: 'For attack/save damage: damage type, e.g. 光耀/穿刺/火焰 (radiant beats Undead Fortitude).' },
      advantage: { type: 'string', enum: ['none', 'advantage', 'disadvantage'] },
      crit_on: {
        type: 'integer',
        description: 'For type=attack: minimum natural d20 for a critical hit (18-20), e.g. 19 for Champion / Hexblade\'s Curse. Applied automatically when 咒剑诅咒 is recorded via dnd_resource.',
      },
      bonus: {
        type: 'integer',
        description: 'Extra situational flat modifier (e.g. cover). Magic weapons, fighting styles and expertise on the '
          + 'sheet are applied automatically; never add them here.',
      },
      bonus_dice: {
        type: 'string',
        description: 'Extra dice added to THIS d20 roll, rolled by the tool: guidance/bless "1d4", bardic inspiration "1d6". '
          + 'Never pre-roll these with dnd_roll.',
      },
      spend: {
        type: 'string',
        description: 'Spent BEFORE rolling, including on a miss. Not conditional on hit: use on_hit for pre-authorized Divine Smite/on-hit spending. Resource for this roll, e.g. "1环法术位" for guiding bolt, "诗人激励" (spent by '
          + 'the character it is on). Fails if none left. Only when the player said they use it.',
      },
      on_hit: {
        type: 'object',
        description: 'A PRE-AUTHORIZED rider, e.g. {name:"至圣斩",damage:"2d8",damage_type:"光耀",spend:"1环法术位"}. Waits for the FINAL hit after all defensive reactions; then spends once, rolls separately without Great Weapon Fighting, doubles dice on crit, applies its own defense, and combines HP loss as one hit. Final miss spends/rolls nothing. Not permission to choose for the player after rolling.',
        properties: {
          name: { type: 'string' }, damage: { type: 'string' }, damage_type: { type: 'string' }, spend: { type: 'string' },
          critical_only: { type: 'boolean', description: 'Player explicitly said to spend only on a final critical hit.' },
          defense: { type: 'string', enum: ['resistant', 'immune', 'vulnerable'], description: 'Against this rider\'s damage type, independently of the weapon damage.' },
        }, required: ['damage', 'damage_type', 'spend'], additionalProperties: false,
      },
      secret: {
        type: 'boolean',
        description: 'Hidden check (passive perception, insight): do not reveal the roll or DC, but say the outcome in this reply '
          + '(noticed / did not notice); never resolve it silently.',
      },
      hold: {
        type: 'boolean',
        description: 'In combat: roll but do not settle yet, leaving a reaction window (attack, save or check). Attacks hold '
          + 'automatically when a PC with a registered reaction can respond. Pass it yourself for an NPC or monster reaction.',
      },
      hold_for: {
        type: 'array',
        description: 'In combat: hold this roll and ask these players, with buttons and the timer. For reactions decided after '
          + 'seeing the result that the tool does not detect, e.g. a foe saving against 奇塔露\'s spell when she has 时间变幻: '
          + '[{by:"奇塔露", name:"时间变幻"}]. Only when the rules let them react (in range, can see it, reaction unused): '
          + 'you decide, the tool does not.',
        items: {
          type: 'object',
          properties: { by: { type: 'string' }, name: { type: 'string' } },
          required: ['by', 'name'],
          additionalProperties: false,
        },
      },
      declared_by: {
        type: 'string',
        description: 'Member id of the player whose message declared this action: the #U number in their tag "[昵称 #U3]" (pass "U3"). '
          + 'Required for a PC acting on their own; omit for monsters/NPCs.',
      },
      reaction: {
        type: 'boolean',
        description: 'A roll you (the DM) call for outside the actor\'s own declaration: contested checks, '
          + 'opportunity attacks, reactions, a perception or knowledge check off-turn. PC opportunity attacks spend a reaction and require the one-use server authorization from the owner\'s explicit choice. Passive saves/checks do not spend a reaction by default.',
      },
      use_reaction: { type: 'boolean', description: 'Explicitly spend a reaction for a save/check feature. reaction=true attack already spends it automatically. Passive/off-turn checks alone do not cost one.' },
      concentration: { type: 'boolean', description: 'For type=save: (1) Constitution concentration check: if failed against dc, breaks active concentration and clears concentrated buffs/zones; (2) Concentration control spell with on_fail_conditions (e.g. Hold Person, Fear): binds failing targets\' applied conditions to the caster\'s concentration.' },
      rounds: { type: 'integer', description: 'For type=save with on_fail_conditions: duration in rounds for the applied conditions (e.g. 10 for 1-minute control spells).' },
      ignore_state_mods: { type: 'boolean', description: 'Escape hatch: bypass automatic 5e condition modifiers (advantage/disadvantage, incapacitation block, charm block, auto-crit, resistance) when a specific feature/immunity overrides standard rules.' },
      authorization: { type: 'string', description: 'For a PC opportunity attack: copy the one-use authorization from the server player/button notice for this movement window. declared_by is not consent. Sentinel counterattacks already authorized through dnd_apply need no second token.' },
      dm_override: {
        type: 'boolean',
        description: 'Roll for a PC whose player has not spoken because another player explicitly delegated it '
          + '(e.g. "让 Kriv 去谈"): skips the "only the owner may declare" check but still respects turn order. '
          + 'Requires declared_by (who delegated) and must be explained in the reply.',
      },
    },
    ['character', 'type'],
    (args, exec) => mutate(exec, (c) => {
      const type = String(args.type);
      if (args.on_hit !== undefined && type !== 'attack') throw new Error('on_hit 只用于攻击');
      if (args.dm_override === true && str(args.declared_by) === undefined) {
        throw new Error('dnd_check: dm_override 还要给 declared_by（提出委托的玩家编号，如 U4），并在回复里写明是谁委托的');
      }
      const actOptions = () => ({
        declaredBy: memberId(exec, args.declared_by, 'declared_by'),
        reaction: args.reaction === true,
        dmOverride: args.dm_override === true,
        recentSenders: sendersOf(exec),
        ignoreStateMods: args.ignore_state_mods === true,
      });
      // 挂起的条件在掷骰前查完：查不过就什么都没掷，不会「掷完报错、重来一次换个点数」
      const wantHold = args.hold === true || args.hold_for !== undefined;
      const holdFor = wantHold ? manualReactors(c, args.hold_for) : [];
      if (wantHold) {
        if (c.initiative === undefined) throw new Error('hold 只在战斗中用（待结算挂在先攻上）。战斗外直接问玩家；判错了用 dnd_undo roll= 连后果一起退');
        if (args.secret === true) throw new Error('暗骰不能挂起：挂起要把成败告诉玩家，才好决定用不用反应');
        if (type === 'death') throw new Error('死亡豁免不挂起');
        assertNoPending(c, '再挂起一笔');
      }
      const targets = type === 'save' ? parseSaveTargets(args.targets) : undefined;
      if (targets !== undefined && targets.length > 0) {
        assertNoPending(c, '结算豁免效果');
        // character 是施法者/来源：是角色卡上的人就按主动行动校验并从他身上扣资源；陷阱之类的来源不校验
        const source = findCharacter(c, String(args.character ?? ''));
        if (source !== undefined) {
          if (args.reaction === true && c.initiative !== undefined) c.initiative.rebrief = true;
          assertCanAct(c, source, actOptions());
          if (args.use_reaction === true) {
            assertDeclaredByOwner(source, { declaredBy: memberId(exec, args.declared_by, 'declared_by'), recentSenders: sendersOf(exec) }, '反应');
            spendReaction(c, source.name);
          }
        }
        return saveEffectText(c, args, targets, source?.name ?? str(args.character) ?? '效果', source !== undefined, exec, wantHold ? holdFor : undefined);
      }
      const ch = requireCharacter(c, String(args.character ?? ''));
      const onHit = onHitArg(args.on_hit);
      if (onHit !== undefined) {
        requireResource(ch, onHit.spend);
        const weaponName = str(args.weapon);
        const weapon = weaponName === undefined || (ch.kind !== 'pc' && (ch.weapons?.length ?? 0) === 0) ? undefined : findWeapon(ch, weaponName);
        if (attackExpression(ch, weapon, str(args.damage)) === undefined) throw new Error('on_hit 要先给 weapon 或基础 damage');
      }
      const adv = advantageOf(args.advantage);
      const secret = args.secret === true;
      if (type === 'save' && (str(args.damage) !== undefined || (strList(args.on_fail_conditions)?.length ?? 0) > 0)) {
        assertNoPending(c, '结算豁免效果');
        // 没有 targets 但带了伤害或失败状态：掷豁免的人自己承受（踩中陷阱、被定身），走同一套结算
        const defense = parseDefense(args.defense);
        return saveEffectText(c, args, [{ name: ch.name, ...(defense !== undefined ? { defense } : {}) }], undefined, true, exec, wantHold ? holdFor : undefined);
      }
      // 豁免和死亡豁免是被动发生的，不需要宣告；攻击和检定是主动行动
      if (type !== 'save' && type !== 'death') {
        // 打断回合顺序的反应/借机攻击之后，下一个 PC 回合重新给完整的停手提示
        if (args.reaction === true && c.initiative !== undefined) c.initiative.rebrief = true;
        assertCanAct(c, ch, actOptions());
      }
      if (type === 'attack') {
        const state = c.initiative;
        const movement = state?.movement;
        const target = requireCharacter(c, String(args.target ?? ''));
        if (state?.pending !== undefined) assertNoPending(c, '再结算攻击');
        if (movement !== undefined && !(args.reaction === true && movement.target === target.name
          && movement.reactors.some((r) => r.character === ch.name)
          && !movement.declined.includes(ch.name) && !movement.used.some((r) => r.by === ch.name))) {
          throw new Error(`先处理 ${movement.target} 的借机窗口，只能由名单中的角色对移动者进行借机攻击`);
        }
        if (args.reaction === true && state !== undefined) {
          if (!inInitiative(c, ch.name)) {
            throw new Error(`${ch.name} 不在当前战斗的参战名单（先攻表）里，不能发动反应攻击；如确已中途参战请先调用 dnd_initiative action=join`);
          }
          if (!canReact(ch)) throw new Error(`${ch.name} 现在做不了反应`);
          const weaponName = str(args.weapon);
          const weapon = weaponName === undefined || (ch.kind !== 'pc' && (ch.weapons?.length ?? 0) === 0) ? undefined : findWeapon(ch, weaponName);
          const from = cellOf(c, ch), to = cellOf(c, target);
          if (movement !== undefined && weapon !== undefined && weaponReach(weapon, true) === undefined) throw new Error('借机攻击必须使用近战武器');
          if ((movement !== undefined || weapon !== undefined) && from !== undefined && to !== undefined && from.room === to.room && distanceFeet(from, to) > (weapon === undefined ? 5 : weaponReach(weapon, movement !== undefined) ?? Infinity)) {
            throw new Error('反应近战攻击够不到目标；借机必须在移动触发处结算，不是走完后隔空攻击');
          }
          const counter = state.counterAttacks?.find((r) => r.by === ch.name && r.target === target.name);
          const prepaid = counter !== undefined;
          const chosen = !prepaid && movement !== undefined
            ? movement.claimed.find((r) => r.character === ch.name && r.authorization === args.authorization)
            : undefined;
          if (!prepaid && movement !== undefined) {
            assertReactionAuthorized(movement, ch, chosen?.reaction ?? '借机攻击', args.authorization);
          }
          if (!prepaid && movement === undefined && ch.kind === 'pc' && ch.playerId !== undefined) {
            // 不能绕过窗口，直接用 reaction=true + 玩家编号替本人宣告。
            const blocked = state.reacted?.includes(ch.name);
            throw new Error(blocked ? `${ch.name} 的反应已经用过` : 'PC 反应攻击需要本次借机窗口授权，或已授权的还击；declared_by 不能代替同意');
          }
          if (args.declared_by !== undefined) assertDeclaredByOwner(ch, { declaredBy: memberId(exec, args.declared_by, 'declared_by'), recentSenders: sendersOf(exec) }, '反应攻击');
          if (prepaid) state.counterAttacks = state.counterAttacks?.filter((r) => r !== counter);
          else spendReaction(c, ch.name);
          if (movement !== undefined) {
            movement.used.push({ by: ch.name, name: chosen?.reaction ?? '借机攻击', effect: '已宣告并消耗反应' });
            movement.claimed = movement.claimed.filter((r) => r.character !== ch.name);
          }
        }
      }
      if (args.use_reaction === true && !(type === 'attack' && args.reaction === true)) {
        assertNoPending(c, '单独消耗反应；当前窗口请用带 authorization 的 dnd_apply reaction 处理');
        assertDeclaredByOwner(ch, { declaredBy: memberId(exec, args.declared_by, 'declared_by'), recentSenders: sendersOf(exec) }, '反应');
        spendReaction(c, ch.name);
      }
      const spendKey = str(args.spend);
      const bonusDice = str(args.bonus_dice);

      if (type === 'death') {
        const spent = spendKey === undefined ? undefined : useResource(c, ch.name, spendKey);
        const spentNote = spent === undefined ? '' : `\n用掉「${spent.key}」，剩 ${spent.resource.current}/${spent.resource.max}`;
        const id = rollId(c, exec);
        const r = deathSave(c, ch.name, service.roller);
        return `${r.name} 死亡豁免 ${r.detail}：${{ success: '成功', failure: '失败', stable: '三次成功，伤势稳定', dead: '死亡', revived: '天然 20，恢复 1 HP 醒来' }[r.outcome]}（成功 ${r.successes}/3，失败 ${r.failures}/3） #R${id}${spentNote}${combatLedgerSuffix(c)}`;
      }

      if (type === 'attack') {
        if (c.initiative?.movement === undefined) assertNoPending(c, '再结算攻击');
        const targetName = str(args.target);
        if (targetName === undefined) throw new Error('dnd_check: 攻击需要 target');
        const target = requireCharacter(c, targetName);
        const weaponName = str(args.weapon);
        // srd 建的怪只有卡面上的攻击加值和伤害，没有武器列表：「咬」报错后 DM 只能战斗中逐只补武器。
        // 没有武器列表的怪直接用卡面数值，武器名只当描述；PC 写错武器名仍然报错
        const cardAttack = weaponName !== undefined && ch.kind !== 'pc' && (ch.weapons?.length ?? 0) === 0;
        const weapon = weaponName === undefined || cardAttack ? undefined : findWeapon(ch, weaponName);
        const label = weapon?.name ?? (cardAttack ? weaponName : undefined);
        const override = str(args.ability);
        const ability = override !== undefined ? parseAbility(override) : (weapon === undefined ? undefined : weapon.ability ?? 'str');
        const attackAbility = ability ?? (ch.attackBonus !== undefined ? undefined : (ch.abilities.dex > ch.abilities.str ? 'dex' : 'str'));
        const spiritAdv = c.initiative?.fightingSpirit?.includes(ch.name) === true && (weapon !== undefined || (ch.kind !== 'pc' && override === undefined));
        const fromCell = cellOf(c, ch);
        const toCell = cellOf(c, target);
        const distanceFt = fromCell !== undefined && toCell !== undefined && fromCell.room === toCell.room
          ? distanceFeet(fromCell, toCell)
          : undefined;
        const damageType = str(args.damage_type);
        const explicitDefense = parseDefense(args.defense);
        const globalEffects = service.globalEffects();
        const isRanged = weapon !== undefined ? isRangedWeapon(weapon) : false;
        const hasWeapon = weapon !== undefined || (ch.kind !== 'pc' && override === undefined);
        // 先跑结构化状态计算（若被魅惑不能攻击目标则在扣资源与掷骰前直接拦截）
        const stateMods = args.ignore_state_mods === true
          ? undefined
          : computeAttackStateMods(c, ch, target, {
            ...(distanceFt !== undefined ? { distanceFt } : {}),
            isRanged,
            hasWeapon,
            explicitAdvantage: adv,
            ...(bonusDice !== undefined ? { explicitBonusDice: bonusDice } : {}),
            fightingSpirit: spiritAdv,
            globalEffects,
          });
        const defenseMod = args.ignore_state_mods === true
          ? { defense: explicitDefense }
          : computeDefenseStateMod(target, damageType, explicitDefense, c, globalEffects);
        const defense = defenseMod.defense;

        const spent = spendKey === undefined ? undefined : useResource(c, ch.name, spendKey);
        const slotMatch = spent === undefined ? null : /([1-9])\s*环/.exec(spent.key);
        const spellWarn = slotMatch !== null && args.reaction !== true && c.initiative?.order[c.initiative.turn]?.name === ch.name
          ? recordTurnSpellCast(ensureTurnState(c), ch.name, label ?? spent!.key, Number(slotMatch[1]), 'action')
          : undefined;
        const spentNote = [
          spent === undefined ? '' : `用掉「${spent.key}」，剩 ${spent.resource.current}/${spent.resource.max}`,
          spellWarn ?? '',
        ].filter(Boolean).map((s) => `\n${s}`).join('');
        const extraRoll = bonusDice === undefined ? undefined : rollExpression(bonusDice, service.roller);
        let autoDiceTotal = 0;
        const autoDiceDetails: string[] = [];
        for (const expr of stateMods?.autoDice ?? []) {
          const m = /^([+-])(.+)$/.exec(expr)!;
          const r = rollExpression(m[2]!, service.roller);
          autoDiceTotal += m[1] === '-' ? -r.total : r.total;
          autoDiceDetails.push(`${m[1]}${r.detail}`);
        }
        const stateHitBonus = stateMods?.hitBonus ?? 0;
        const bonus = (int(args.bonus) ?? 0) + (extraRoll?.total ?? 0) + stateHitBonus + autoDiceTotal;
        const extraNote = extraRoll === undefined ? '' : `（含额外骰 ${extraRoll.detail}）`;

        if (args.reaction !== true && c.initiative !== undefined) {
          const ts = ensureTurnState(c);
          if (ts !== undefined && ts.actor === ch.name) ts.attacks += 1;
        }

        const effectiveAdv = stateMods !== undefined ? stateMods.advantage : (spiritAdv ? (adv === 'disadvantage' ? 'none' : 'advantage') : adv);
        const spiritNote = spiritAdv && adv !== 'advantage' && stateMods === undefined ? '（战斗英姿）' : '';
        const elvenAccuracy = usesElvenAccuracy(ch, attackAbility);
        const modifier = weapon !== undefined ? weaponAttackModifier(ch, weapon, ability) : attackModifier(ch, ability);
        const id = rollId(c, exec);
        const roll = rollD20(modifier + bonus, effectiveAdv, service.roller, { elvenAccuracy });
        const cursed = hexbladeCurseOn(c, ch.name, target.name) !== undefined
          || (target.conditions.some((cond) => cond.includes('咒剑诅咒')) && ch.resources?.['咒剑诅咒'] !== undefined);
        const rawCritOn = int(args.crit_on);
        const critThreshold = Math.min(
          rawCritOn !== undefined ? Math.max(18, Math.min(20, rawCritOn)) : 20,
          cursed ? 19 : 20,
          stateMods?.critThreshold ?? 20,
        );
        const naturalCrit = roll.natural >= critThreshold;
        const targetAc = armorClass(c, target, globalEffects);
        const hit = naturalCrit || (roll.natural !== 1 && roll.total >= targetAc);
        const autoCritOnHit = stateMods?.autoCritOnHit === true;
        const effectiveCrit = naturalCrit || (hit && autoCritOnHit);
        const verdictText = naturalCrit
          ? '重击！'
          : (hit
            ? (autoCritOnHit ? '命中（近距麻痹/昏迷自动重击！）' : '命中')
            : (roll.natural === 1 ? '天然 1，失手' : '未命中'));

        const modExtras: string[] = [...(stateMods?.hitBonusReasons ?? []), ...autoDiceDetails];
        if (hit && autoCritOnHit && stateMods?.autoCritReason !== undefined) modExtras.push(stateMods.autoCritReason);
        if (hit && defenseMod.reason !== undefined) modExtras.push(defenseMod.reason);
        const stateSummary = stateMods !== undefined
          ? formatStateModSummary(stateMods.advReasons, stateMods.disadvReasons, effectiveAdv, modExtras)
          : undefined;
        const stateSuffix = stateSummary !== undefined ? ` ${stateSummary}` : '';

        const lines = [`${ch.name}${label !== undefined ? `（${label}）` : ''} 攻击 ${target.name}：${roll.detail}${spiritNote}${extraNote}${stateSuffix}${target.kind === 'monster' ? '' : ` vs AC ${targetAc}`} → ${verdictText} #R${id}${spentNote}`];
        for (const n of stateMods?.notes ?? []) lines.push(`【状态提示】${n}`);

        const rawExtra = str(args.damage);
        const collected = collectHitRiders(c, ch, target, {
          ...(weapon !== undefined ? { weapon } : {}),
          ...(attackAbility !== undefined ? { ability: attackAbility } : {}),
          isRanged,
          effectiveAdvantage: effectiveAdv,
          ...(rawExtra !== undefined ? { explicitExtraDamage: rawExtra } : {}),
          ...(damageType !== undefined ? { mainDamageType: damageType } : {}),
          ignoreStateMods: args.ignore_state_mods === true,
          globalEffects,
        });
        for (const sn of collected.skippedNotes) lines.push(`【防重算】${sn}`);

        let extra = rawExtra;
        let curseNote = '';
        const curseBonus = cursed ? proficiencyBonus(ch.level) : 0;
        const hasBaseDamage = weapon !== undefined || extra !== undefined || ch.damage !== undefined;
        if (curseBonus > 0 && hasBaseDamage) {
          if (extra !== undefined && /^\+?\d+$/.test(extra) && Number(extra) === curseBonus) {
            curseNote = `（含咒剑诅咒 +${curseBonus}）`;
          } else {
            extra = extra !== undefined ? `${extra}+${curseBonus}` : String(curseBonus);
            curseNote = `（含咒剑诅咒 +${curseBonus}）`;
          }
        }
        const expression = attackExpression(ch, weapon, extra);
        const auto = c.initiative === undefined || expression === undefined
          ? []
          : eligibleReactors(c, ch, target, { hit, crit: effectiveCrit, natural: roll.natural });
        const reactors = mergeReactors(auto, holdFor);
        // 能反应的人在场就先不落账；DM 手动挂起（hold / hold_for）时天然 1 也挂：重掷能改掉它
        const hold = c.initiative !== undefined && (wantHold || (expression !== undefined && roll.natural !== 1 && auto.length > 0));
        if (hold) {
          const dmg = hit && expression !== undefined ? rollAttackDamage(ch, weapon, expression, effectiveCrit, service.roller) : undefined;
          const pendingRiders: PendingRider[] = hit
            ? rollCollectedRiders(c, target, collected.riders, effectiveCrit, service.roller, args.ignore_state_mods === true, globalEffects)
            : collected.riders.map((r) => {
              const rDef = args.ignore_state_mods === true ? undefined : computeDefenseStateMod(target, r.damageType, undefined, c, globalEffects).defense;
              return {
                label: r.label,
                expression: r.expression,
                damageType: r.damageType,
                ...(rDef !== undefined ? { defense: rDef } : {}),
                ...(r.oncePerTurnRule !== undefined ? { oncePerTurnRule: r.oncePerTurnRule } : {}),
              };
            });
          if (dmg !== undefined) {
            const riderPreview = pendingRiders.length > 0
              ? `；附伤 ${pendingRiders.map((r) => `${r.label} ${r.detail ?? r.expression} ${r.damageType}`).join(' + ')}`
              : '';
            lines.push(`伤害（还没扣）${dmg.detail}${curseNote}${riderPreview}`);
          }
          pushCombatLedger(c, `${ch.name}${label !== undefined ? `（${label}）` : ''}→${target.name}：${roll.detail}${spiritNote}${extraNote}${stateSuffix} → ${verdictText}（待反应）`, id);
          const p: PendingAttack = {
            kind: 'attack', seq: id, at: Date.now(), attacker: ch.name, target: target.name, natural: roll.natural, rollDetail: roll.detail,
            total: roll.total, modifier: roll.modifier, advantage: effectiveAdv, ac: targetAc, crit: naturalCrit,
            ...(autoCritOnHit ? { autoCritOnHit: true } : {}),
            reactors,
            ...(elvenAccuracy ? { elvenAccuracy: true } : {}),
            ...(critThreshold < 20 ? { critThreshold } : {}),
            attackMod: 0, acMod: 0, damageMod: 0, declined: [], claimed: [], used: [],
            ...(weapon !== undefined ? { weapon: weapon.name } : {}),
            ...(extra !== undefined ? { extraDamage: extra } : {}),
            ...(dmg !== undefined ? { rawDamage: dmg.total, damageDetail: dmg.detail } : {}),
            ...(damageType !== undefined ? { damageType } : {}),
            ...(defense !== undefined ? { defense } : {}),
            ...(onHit !== undefined ? { onHit } : {}),
            ...(pendingRiders.length > 0 ? { riders: pendingRiders } : {}),
          };
          requireInitiative(c).pending = p;
          lines.push(holdNotice(p));
          deps.onPendingAttack?.(recordOf(exec));
        } else if (hit) {
          if (expression === undefined) {
            pushCombatLedger(c, `${ch.name}${label !== undefined ? `（${label}）` : ''}→${target.name}：${roll.detail}${spiritNote}${extraNote}${stateSuffix} → ${verdictText}`, id);
            lines.push('没有伤害表达式：传 weapon（角色卡上的武器），或用 dnd_roll 掷伤害（重击时骰子翻倍）再 dnd_apply 扣血。');
          } else {
            const dmg = rollAttackDamage(ch, weapon, expression, effectiveCrit, service.roller);
            const rolledRiders = rollCollectedRiders(c, target, collected.riders, effectiveCrit, service.roller, args.ignore_state_mods === true, globalEffects);
            const amount = saveDamage(dmg.total, false, 'half', defense);
            const riderLedger = rolledRiders.length > 0
              ? ` + 附伤(${rolledRiders.map((r) => `${r.label} ${r.detail} ${r.damageType}`).join(' + ')})`
              : '';
            pushCombatLedger(c, `${ch.name}${label !== undefined ? `（${label}）` : ''}→${target.name}：${roll.detail}${spiritNote}${extraNote}${stateSuffix} → ${verdictText}，伤害 ${dmg.detail}${curseNote}${riderLedger}`, id);
            lines.push(`伤害 ${dmg.detail}${curseNote}${defense !== undefined ? `，${DEFENSE_NAMES[defense]} → ${amount}` : ''}`);
            lines.push(...settleAttackDamage(c, ch.name, target.name, dmg.total, effectiveCrit, damageType, defense, onHit, service.roller, rolledRiders));
          }
        } else {
          pushCombatLedger(c, `${ch.name}${label !== undefined ? `（${label}）` : ''}→${target.name}：${roll.detail}${spiritNote}${extraNote}${stateSuffix} → ${verdictText}`, id);
        }
        const rangeNote = attackRangeNote(c, ch, target, { ...(weapon !== undefined ? { weapon } : {}), reaction: args.reaction === true, advantage: effectiveAdv });
        if (rangeNote !== undefined) lines.push(rangeNote);
        lines.push(SECRET_NOTE);
        return `${lines.join('\n')}${combatLedgerSuffix(c)}`;
      }

      let ability: Ability | undefined;
      let skill: Skill | undefined;
      if (type === 'skill') {
        skill = parseSkill(String(args.skill ?? ''));
        if (skill === undefined) throw new Error(`dnd_check: 未知技能 ${String(args.skill ?? '')}。可用：${Object.values(SKILLS).map((s) => s.name).join('、')}`);
        ability = SKILLS[skill].ability;
      } else if (type === 'ability' || type === 'save') {
        ability = parseAbility(String(args.ability ?? ''));
        if (ability === undefined) throw new Error(`dnd_check: 未知属性 ${String(args.ability ?? '')}`);
      } else {
        throw new Error(`dnd_check: 未知类型 ${type}`);
      }
      const kind = type as 'skill' | 'ability' | 'save';
      const label = skill !== undefined ? `${skillLabel(skill)}检定` : `${ABILITY_NAMES[ability]}${kind === 'save' ? '豁免' : '检定'}`;
      const dc = int(args.dc);
      const spent = spendKey === undefined ? undefined : useResource(c, ch.name, spendKey);
      const spentNote = spent === undefined ? '' : `\n用掉「${spent.key}」，剩 ${spent.resource.current}/${spent.resource.max}`;

      if (kind === 'save' && args.ignore_state_mods !== true) {
        const globalEffects = service.globalEffects();
        const vsTags = [
          ...(args.concentration === true ? ['concentration'] : []),
          ...(str(args.damage_type) !== undefined ? [str(args.damage_type)!] : []),
        ];
        const saveMods = computeSaveStateMods(ch, ability, {
          explicitAdvantage: adv,
          ...(bonusDice !== undefined ? { explicitBonusDice: bonusDice } : {}),
          vsTags,
          campaign: c,
          globalEffects,
        });
        if (saveMods.autoFail) {
          const id = rollId(c, exec);
          const concBroken = args.concentration === true
            ? [...breakConcentration(c, ch.name, '专注豁免失败'), ...checkAllAirborneCrashes(c, service.roller, globalEffects)]
            : [];
          const concLine = concBroken.length > 0 ? `\n${concBroken.join('；')}` : '';
          return `${ch.name} ${label}：自动失败（${saveMods.autoFailReason ?? '状态限制'}）${dc !== undefined ? ' → 失败' : ''} #R${id}${spentNote}${concLine}\n${secret ? HIDDEN_ROLL_NOTE : SECRET_NOTE}${combatLedgerSuffix(c)}`;
        }
        const extraRoll = bonusDice === undefined ? undefined : rollExpression(bonusDice, service.roller);
        let autoDiceTotal = 0;
        const autoDiceDetails: string[] = [];
        for (const expr of saveMods.autoDice) {
          const m = /^([+-])(.+)$/.exec(expr)!;
          const r = rollExpression(m[2]!, service.roller);
          autoDiceTotal += m[1] === '-' ? -r.total : r.total;
          autoDiceDetails.push(`${m[1]}${r.detail}`);
        }
        const bonus = (int(args.bonus) ?? 0) + (extraRoll?.total ?? 0) + autoDiceTotal + saveMods.flatBonus;
        const extraNote = extraRoll === undefined ? '' : `（含额外骰 ${extraRoll.detail}）`;
        const id = rollId(c, exec);
        const roll = rollD20(checkModifier(ch, kind, ability, skill) + bonus, saveMods.advantage, service.roller);
        const stateSummary = formatStateModSummary(
          saveMods.advReasons,
          saveMods.disadvReasons,
          saveMods.advantage,
          [...saveMods.flatBonusReasons, ...autoDiceDetails],
        );
        const stateSuffix = stateSummary !== undefined ? ` ${stateSummary}` : '';
        const passed = dc === undefined ? undefined : roll.total >= dc;
        const verdict = passed === undefined
          ? ''
          : ` → ${passed ? '成功' : '失败'}${roll.natural === 20 ? '（天然 20）' : (roll.natural === 1 ? '（天然 1）' : '')}`;
        const concBroken = passed === false && args.concentration === true && !wantHold
          ? [...breakConcentration(c, ch.name, '专注豁免失败'), ...checkAllAirborneCrashes(c, service.roller, globalEffects)]
          : [];
        const concLine = concBroken.length > 0 ? `\n${concBroken.join('；')}` : '';
        const head = `${ch.name} ${label}：${roll.detail}${extraNote}${stateSuffix}${verdict} #R${id}${spentNote}${concLine}`;
        if (wantHold) {
          const p: PendingCheck = {
            kind: 'roll', seq: id, at: Date.now(), attacker: ch.name, target: ch.name, label,
            rolls: [{ name: ch.name, natural: roll.natural, modifier: roll.modifier, advantage: saveMods.advantage, total: roll.total, detail: `${roll.detail}${extraNote}${stateSuffix}`, mod: 0 }],
            ...(dc !== undefined ? { dc } : {}),
            damageMod: 0, reactors: holdFor, declined: [], claimed: [], used: [],
          };
          requireInitiative(c).pending = p;
          deps.onPendingAttack?.(recordOf(exec));
          return `${head}\n${holdNotice(p)}\n${SECRET_NOTE}${combatLedgerSuffix(c)}`;
        }
        return `${head}\n${secret ? HIDDEN_ROLL_NOTE : SECRET_NOTE}${combatLedgerSuffix(c)}`;
      }

      const checkMods = (kind === 'skill' || kind === 'ability') && args.ignore_state_mods !== true
        ? computeCheckStateMods(c, ch, ability, { explicitAdvantage: adv })
        : undefined;
      const effectiveCheckAdv = checkMods !== undefined ? checkMods.advantage : adv;
      const extraRoll = bonusDice === undefined ? undefined : rollExpression(bonusDice, service.roller);
      const bonus = (int(args.bonus) ?? 0) + (extraRoll?.total ?? 0);
      const extraNote = extraRoll === undefined ? '' : `（含额外骰 ${extraRoll.detail}）`;
      const id = rollId(c, exec);
      const roll = rollD20(checkModifier(ch, kind, ability, skill) + bonus, effectiveCheckAdv, service.roller);
      const stateSummary = checkMods !== undefined
        ? formatStateModSummary(checkMods.advReasons, checkMods.disadvReasons, effectiveCheckAdv)
        : undefined;
      const stateSuffix = stateSummary !== undefined ? ` ${stateSummary}` : '';
      const verdict = dc === undefined
        ? ''
        : ` → ${roll.total >= dc ? '成功' : '失败'}${roll.natural === 20 ? '（天然 20）' : (roll.natural === 1 ? '（天然 1）' : '')}`;
      const concBroken = kind === 'save' && dc !== undefined && roll.total < dc && args.concentration === true && !wantHold
        ? breakConcentration(c, ch.name, '专注豁免失败')
        : [];
      const concLine = concBroken.length > 0 ? `\n${concBroken.join('；')}` : '';
      const noteLines = (checkMods?.notes ?? []).map((n) => `\n【状态提示】${n}`).join('');
      const head = `${ch.name} ${label}：${roll.detail}${extraNote}${stateSuffix}${verdict} #R${id}${spentNote}${concLine}${noteLines}`;
      if (wantHold) {
        const p: PendingCheck = {
          kind: 'roll', seq: id, at: Date.now(), attacker: ch.name, target: ch.name, label,
          rolls: [{ name: ch.name, natural: roll.natural, modifier: roll.modifier, advantage: effectiveCheckAdv, total: roll.total, detail: `${roll.detail}${extraNote}${stateSuffix}`, mod: 0 }],
          ...(dc !== undefined ? { dc } : {}),
          damageMod: 0, reactors: holdFor, declined: [], claimed: [], used: [],
        };
        requireInitiative(c).pending = p;
        deps.onPendingAttack?.(recordOf(exec));
        return `${head}\n${holdNotice(p)}\n${SECRET_NOTE}${combatLedgerSuffix(c)}`;
      }
      return `${head}\n${secret ? HIDDEN_ROLL_NOTE : SECRET_NOTE}${combatLedgerSuffix(c)}`;
    }),
  );

  register(
    'dnd_apply',
    'Apply already-decided damage, healing, temporary HP or conditions to one target or a batch. For a common damage/healing roll, '
    + 'pass damage_roll/heal_roll here: the tool rolls once for the whole batch; target overrides and defense are applied per creature. '
    + 'Use targets=[{name,...}] for several creatures, never one call per target. This does not make attack rolls or save rolls; use dnd_check for those. '
    + 'Also resolves a pending roll (attack, save or check) or paused movement: '
    + '`reaction` changes the numbers or rerolls the d20 (the tool rolls the dice), `decline` records who passed, `settle` '
    + 'applies the result once everyone answered (no timeout), `cancel` drops it. A counter-attack reaction '
    + '(Sentinel) only registers {by,name} here; after settling, roll the strike with dnd_check reaction=true. Never fake a '
    + 'reaction with heal or compensation afterwards. Undead Fortitude and similar traits are handled from damage_type: never '
    + 'remove 死亡 or heal a dead monster by hand.',
    {
      target: { type: 'string', description: 'One creature, or the target of a pending roll/movement. Use either target or targets.' },
      targets: {
        type: 'array', minItems: 1, maxItems: 20,
        description: 'Batch of already-decided effects; each item inherits top-level damage/heal/temp_hp/conditions unless overridden. Entire batch is atomic. Cannot combine with a pending reaction or movement.',
        items: {
          type: 'object', properties: {
            name: { type: 'string' }, damage: { type: 'integer' }, heal: { type: 'integer' }, temp_hp: { type: 'integer' },
            damage_type: { type: 'string' }, defense: { type: 'string', enum: ['resistant', 'immune', 'vulnerable'] },
            add_conditions: { type: 'array', items: { type: 'string' } }, remove_conditions: { type: 'array', items: { type: 'string' } },
            drop_concentration: { type: 'boolean' }, rounds: { type: 'integer' },
          }, required: ['name'], additionalProperties: false,
        },
      },
      damage: { type: 'integer' },
      damage_roll: { type: 'string', description: 'Roll damage once for all targets, e.g. "2d6". Instead of top-level damage. Each target can override with its own final integer damage.' },
      heal_roll: { type: 'string', description: 'Roll healing once for all targets, e.g. "1d4+3". Instead of top-level heal.' },
      defense: { type: 'string', enum: ['resistant', 'immune', 'vulnerable'], description: 'Against this damage type; override per target in a batch.' },
      damage_type: { type: 'string', description: 'e.g. 光耀/心灵/钝击. Radiant damage beats Undead Fortitude.' },
      crit: { type: 'boolean', description: 'The damage came from a critical hit.' },
      heal: { type: 'integer' },
      temp_hp: { type: 'integer' },
      caster: { type: 'string', description: 'Optional healer/caster character name (enables automatic 生命门徒/神佑医者 bonuses on leveled heals and concentration source binding).' },
      slot_level: { type: 'integer', description: 'Optional spell slot level (1-9) when applying a leveled healing spell (triggers 生命门徒 +2+slot and 神佑医者 self-heal).' },
      preserve_life: { type: 'boolean', description: 'True when applying 保全生命 (Preserve Life): caps each target\'s restored HP at half its effective max HP.' },
      drop_concentration: { type: 'boolean', description: 'Drop active concentration of the target creature(s), clearing their concentrated buffs/debuffs and battlefield zones.' },
      concentration: { type: 'boolean', description: 'Bind add_conditions to `caster`\'s concentration.' },
      rounds: { type: 'integer', description: 'Duration in rounds for add_conditions.' },
      add_conditions: { type: 'array', items: { type: 'string' }, description: 'e.g. ["中毒", "倒地"]' },
      remove_conditions: { type: 'array', items: { type: 'string' } },
      reaction: {
        type: 'object',
        description: 'For a pending roll. `target` names whose roll it changes (attack: the one attacked; save/check: the roller). '
          + 'e.g. cutting words {by:"Kriv",name:"尖刻言语",attack_mod:"-1d6",spend:"诗人激励"}; shield '
          + '{by:"Kriv",name:"护盾术",ac_mod:5,spend:"防御法杖充能"}; guided strike {by:"刻德温",name:"导引打击",attack_mod:"+10",spend:"引导神力"}; '
          + 'chronal shift {by:"奇塔露",name:"时间变幻",reroll:"d20",spend:"时间变幻"}. '
          + 'PCs require authorization copied from the server notice after their real button click or explicit message. It binds this window and skill, and is revoked by a later refusal. Questions and declared_by are not consent.',
        properties: {
          by: { type: 'string' },
          name: { type: 'string' },
          authorization: { type: 'string', description: 'One-use server authorization for this PC, exact skill and pending window; copy from player/button notice.' },
          attack_mod: { type: 'string', description: 'Added to the pending d20 total (attack roll, or the `target`\'s save/check), e.g. "-1d6" or "+10". The tool rolls it.' },
          ac_mod: { type: 'integer', description: 'Attacks only: added to the target AC, e.g. 5.' },
          damage_mod: { type: 'string', description: 'Added to the damage, e.g. "-1d6". The tool rolls it.' },
          reroll: {
            type: 'string',
            enum: ['d20'],
            description: 'Reroll the whole d20 (same advantage, same modifiers); the new result must be used and the old one is '
              + 'void. Success, crit and damage are recomputed.',
          },
          spend: { type: 'string', description: 'Resource the reactor spends.' },
          spend_amount: { type: 'integer', description: 'Charges/units spent for this reaction (default: ReactionDef.cost or 1, e.g. 2 for Staff of Defense Shield).' },
        },
        required: ['by', 'name'],
        additionalProperties: false,
      },
      ask_reactions: {
        type: 'array',
        description: 'Add a missed/manual PC reaction option to the CURRENT pending roll without rerolling or spending. Use [{by:"奇塔露",name:"时间变幻"}], then stop and wait for the owner. Cannot override a refusal or be combined with reaction/decline/settle/cancel. For a future roll use dnd_check hold_for instead.',
        items: { type: 'object', properties: { by: { type: 'string' }, name: { type: 'string' } }, required: ['by', 'name'], additionalProperties: false },
      },
      decline: {
        type: 'array',
        items: { type: 'string' },
        description: 'Characters who will not react: their player said no, or the player is away and has not answered for a while '
          + '(the window has no time limit, so skipping an absent player is your call; say so in the reply).',
      },
      settle: { type: 'boolean', description: 'Apply the pending roll. Refused while someone has not answered (no time limit).' },
      cancel: { type: 'boolean', description: 'Drop the pending roll without applying it. Spent resources stay spent; if it should not have happened at all, use dnd_undo roll=.' },
      ignore_state_mods: { type: 'boolean', description: 'Escape hatch: bypass automatic resistance from 狂暴/石化 and automatic half-speed cost when removing 倒地 on own turn.' },
      declared_by: { type: 'string', description: 'Optional ownership cross-check (the #U member id). Does not grant reaction consent; PC reaction.authorization is required.' },
    },
    [],
    (args, exec) => mutate(exec, (c) => {
      if (args.targets !== undefined && (args.settle === true || args.cancel === true || args.reaction !== undefined || args.decline !== undefined || args.ask_reactions !== undefined)) {
        throw new Error('批量 targets 不能和反应/待结算混用；先处理停止点');
      }
      if (args.settle === true || args.cancel === true || args.reaction !== undefined || args.decline !== undefined || args.ask_reactions !== undefined) {
        if (c.initiative?.pending === undefined && c.initiative?.movement !== undefined) {
          if (args.ask_reactions !== undefined) throw new Error('移动借机名单由路径和触及范围计算；ask_reactions 只用于待结算骰子');
          if (args.reaction !== undefined) throw new Error('移动借机用 dnd_check type=attack reaction=true 结算，不用 dnd_apply reaction 改数值');
          const text = resolveMovement(c, args, { roller: service.roller, globalEffects: service.globalEffects() });
          if (c.initiative?.movement !== undefined) deps.onPendingAttack?.(recordOf(exec));
          else deps.onTurnChange?.(recordOf(exec));
          return text;
        }
        const { text, reopened } = resolvePending(c, args, exec);
        if (c.initiative?.pending === undefined && c.initiative?.movement !== undefined) deps.onPendingAttack?.(recordOf(exec));
        else if (c.initiative?.pending === undefined) deps.onTurnChange?.(recordOf(exec));
        else if (reopened) deps.onPendingAttack?.(recordOf(exec));
        return text;
      }
      const batch = args.targets !== undefined;
      if (batch && args.target !== undefined) throw new Error('target 和 targets 二选一');
      if (batch && (!Array.isArray(args.targets) || args.targets.length === 0 || args.targets.length > 20)) throw new Error('targets 要是 1-20 项的数组');
      if (batch) assertNoPending(c, '批量结算');
      const seen = new Set<string>();
      const resolved = (batch ? args.targets as unknown[] : [{ name: args.target }]).map((raw) => {
        const item = raw as Record<string, unknown> | null;
        const ch = requireCharacter(c, String(item?.name ?? ''));
        if (seen.has(ch.name)) throw new Error(`targets 重复列出「${ch.name}」，不会重复扣血`);
        seen.add(ch.name);
        const values = { ...args, ...item };
        for (const key of ['damage', 'heal', 'temp_hp']) {
          if (values[key] !== undefined && (typeof values[key] !== 'number' || !Number.isInteger(values[key]) || (values[key] as number) < 0)) throw new Error(`${ch.name} 的 ${key} 要是非负整数`);
        }
        if (values.defense !== undefined && parseDefense(values.defense) === undefined) throw new Error(`${ch.name} 的 defense 不认识`);
        return { ch, values };
      });
      if (args.damage !== undefined && args.damage_roll !== undefined) throw new Error('damage 和 damage_roll 二选一');
      if (args.heal !== undefined && args.heal_roll !== undefined) throw new Error('heal 和 heal_roll 二选一');
      for (const { ch, values } of resolved) {
        const hasDmg = int(values.damage) !== undefined || str(args.damage_roll) !== undefined;
        const hasHeal = int(values.heal) !== undefined || str(args.heal_roll) !== undefined;
        if (hasDmg && hasHeal) {
          throw new Error(`不能对同一目标「${ch.name}」同时传 damage 和 heal；请分清本次是受伤还是治疗（若需修正角色卡生命上限请用 dnd_character update）`);
        }
      }
      const globalEffects = service.globalEffects();
      const casterName = str(args.caster);
      const casterCh = casterName !== undefined ? requireCharacter(c, casterName) : undefined;
      const slotLevel = int(args.slot_level);
      const damageRoll = str(args.damage_roll) === undefined ? undefined : rollExpression(String(args.damage_roll), service.roller);
      const healRoll = str(args.heal_roll) === undefined ? undefined : rollExpression(String(args.heal_roll), service.roller);
      const lines: string[] = [];
      if (damageRoll !== undefined || healRoll !== undefined) {
        const id = rollId(c, exec);
        if (damageRoll !== undefined) lines.push(`公共伤害 ${damageRoll.detail} #R${id}`);
        if (healRoll !== undefined) lines.push(`公共治疗 ${healRoll.detail} #R${id}`);
      }
      let blessedHealerApplied = false;
      if (args.concentration === true && casterCh !== undefined && resolved.some(({ values }) => (strList(values.add_conditions)?.length ?? 0) > 0)) {
        const brokenPrev = breakConcentration(c, casterCh.name, '施放新的专注效果');
        lines.push(...brokenPrev);
      }
      for (const { ch, values } of resolved) {
        const details: string[] = [];
        const damage = int(values.damage) ?? damageRoll?.total;
        let healing = int(values.heal) ?? healRoll?.total;
        const temp = int(values.temp_hp);
        if (damage !== undefined && damage > 0) {
          const explicitDef = parseDefense(values.defense);
          const defMod = args.ignore_state_mods === true
            ? { defense: explicitDef }
            : computeDefenseStateMod(ch, str(values.damage_type), explicitDef, c, globalEffects);
          const amount = saveDamage(damage, false, 'half', defMod.defense);
          const reasonNote = defMod.reason !== undefined ? `（${defMod.reason} → ${amount}）` : '';
          details.push(`${hpLine(applyDamage(c, ch.name, amount, { crit: args.crit === true, damageType: str(values.damage_type), roller: service.roller }))}${reasonNote}`);
        }
        if (healing !== undefined && healing > 0) {
          const healNotes: string[] = [];
          let capHalf = args.preserve_life === true;
          if (casterCh !== undefined && args.ignore_state_mods !== true) {
            const ctx = buildFormulaContext(casterCh, slotLevel !== undefined ? { slotLevel } : {});
            for (const { def } of activeEffectDefsFor(casterCh, c.customEffects, globalEffects)) {
              const hm = def.healMod;
              if (hm === undefined) continue;
              if (hm.capAtHalfMaxHp) capHalf = true;
              if (slotLevel !== undefined && slotLevel >= 1 && hm.bonusFormula !== undefined) {
                const extra = evalIntFormula(hm.bonusFormula, ctx);
                if (extra > 0) {
                  healing += extra;
                  healNotes.push(`${def.name}+${extra}`);
                }
              }
              if (!blessedHealerApplied && ch.name !== casterCh.name && slotLevel !== undefined && slotLevel >= 1 && hm.selfHealOnOtherFormula !== undefined && !casterCh.conditions.includes('死亡')) {
                const selfGain = evalIntFormula(hm.selfHealOnOtherFormula, ctx);
                if (selfGain > 0) {
                  blessedHealerApplied = true;
                  const selfRes = heal(c, casterCh.name, selfGain);
                  lines.push(`【${def.name}】${hpLine(selfRes)}`);
                }
              }
            }
          }
          if (capHalf) {
            const halfCap = Math.floor(effectiveMaxHp(ch) / 2);
            const allowed = Math.max(0, halfCap - ch.hp);
            if (healing > allowed) {
              healing = allowed;
              healNotes.push(`半血上限 ${halfCap}`);
            }
          }
          if (healing > 0) {
            details.push(`${hpLine(heal(c, ch.name, healing))}${healNotes.length > 0 ? `（${healNotes.join('，')}）` : ''}`);
          } else if (healNotes.length > 0) {
            details.push(`${ch.name} 已达治疗上限（${healNotes.join('，')}），恢复 0 HP`);
          }
        }
        if (temp !== undefined && temp > 0) details.push(hpLine(grantTempHp(c, ch.name, temp)));
        if (values.drop_concentration === true) {
          const broken = [...breakConcentration(c, ch.name, '主动解除专注'), ...checkAllAirborneCrashes(c, service.roller, globalEffects)];
          details.push(broken.length > 0 ? broken.join('；') : `${ch.name} 当前没有维持中的专注效果`);
        }
        const addRounds = int(values.rounds);
        for (const cond of strList(values.add_conditions) ?? []) {
          changeCondition(c, ch.name, cond, true, {
            ...(casterCh !== undefined ? { source: casterCh.name } : {}),
            ...(args.concentration === true && casterCh !== undefined ? { concentration: true, replaceConcentration: false } : {}),
            ...(addRounds !== undefined ? { roundsLeft: addRounds } : {}),
            roller: service.roller,
            globalEffects,
          });
        }
        const removals = strList(values.remove_conditions) ?? [];
        // 先移除非“倒地”状态（例如同一步挣脱擒抱并起身），再结算起身半速校验
        for (const cond of removals) {
          if (normalizeCondition(cond) !== '倒地') changeCondition(c, ch.name, cond, false, { roller: service.roller, globalEffects });
        }
        for (const cond of removals) {
          if (normalizeCondition(cond) !== '倒地') continue;
          const hadProne = hasCondition(ch, '倒地');
          if (hadProne && args.ignore_state_mods !== true && c.initiative !== undefined
            && c.initiative.order[c.initiative.turn]?.name === ch.name && ch.hp > 0) {
            const moveInfo = movementSpeedInfo(ch);
            if (moveInfo.zeroSpeed) {
              throw new Error(`${ch.name} 当前速度为 0（${moveInfo.zeroReasons.join('、')}），不能消耗半速起身（若受特殊效果直接扶起请传 ignore_state_mods=true）`);
            }
            const ts = ensureTurnState(c);
            if (ts !== undefined && ts.stoodUp !== true) {
              const standCost = Math.floor(moveInfo.baseSpeed / 2);
              const isDashed = c.initiative.dashed?.includes(ch.name) === true;
              const avail = moveInfo.baseSpeed * (isDashed ? 2 : 1);
              const prevMoved = c.initiative.moved?.[ch.name] ?? 0;
              if (prevMoved + standCost > avail) {
                throw new Error(`${ch.name} 剩余移动力不足以起身（需 ${standCost} 尺，本回合已移动 ${prevMoved}/${avail} 尺）`);
              }
              (c.initiative.moved ??= {})[ch.name] = prevMoved + standCost;
              ts.stoodUp = true;
              details.push(`起身消耗 ${standCost} 尺移动力（本回合移动 ${prevMoved + standCost}/${avail} 尺）`);
            }
          }
          changeCondition(c, ch.name, cond, false, { roller: service.roller, globalEffects });
        }
        if (details.length === 0) details.push(ch.kind === 'monster' ? `${ch.name} 状态已更新` : `${ch.name} HP ${ch.hp}/${ch.maxHp}`);
        details.push(`状态：${ch.conditions.join('、') || '无'}`);
        lines.push(details.join('；'));
      }
      return `${lines.join('\n')}${combatLedgerSuffix(c)}`;
    }),
  );
}
