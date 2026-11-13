/** 掷骰与结算：dnd_roll、dnd_check、dnd_apply。 */
import { rollD20,rollExpression } from '../dice.ts';
import {
type PendingAttack,
type PendingCheck,applyDamage,
armorClass,assertCanAct,assertDeclaredByOwner,assertNoPending,attackModifier,
changeCondition,checkModifier,deathSave,findCharacter,
findWeapon,grantTempHp,heal,requireCharacter,
requireInitiative,requireResource,useResource,weaponAttackModifier,spendReaction
} from '../campaign.ts';
import { ABILITY_NAMES,type Ability,type Skill,SKILLS,parseAbility,parseSkill,skillLabel } from '../rules.ts';
import {
attackRangeNote,canReact,cellOf,distanceFeet,weaponReach
} from '../battlefield.ts';
import {
eligibleReactors,holdNotice,
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
onHitArg,settleAttackDamage,str,
int,
strList,advantageOf,hpLine,type ToolKit
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
          + 'opportunity attacks, reactions, a perception or knowledge check off-turn. Reaction attacks spend the actor\'s reaction and require the owner\'s declared_by (or their reaction button). Passive saves/checks do not spend a reaction by default.',
      },
      use_reaction: { type: 'boolean', description: 'Explicitly spend a reaction for a save/check feature. reaction=true attack already spends it automatically. Passive/off-turn checks alone do not cost one.' },
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
          const clicked = movement?.claimed.some((r) => r.character === ch.name) === true;
          if (!prepaid && !clicked) assertDeclaredByOwner(ch, { declaredBy: memberId(exec, args.declared_by, 'declared_by'), recentSenders: sendersOf(exec) }, '反应攻击');
          if (prepaid) state.counterAttacks = state.counterAttacks?.filter((r) => r !== counter);
          else spendReaction(c, ch.name);
          if (movement !== undefined) {
            movement.used.push({ by: ch.name, name: '借机攻击', effect: '已宣告并消耗反应' });
            movement.claimed = movement.claimed.filter((r) => r.character !== ch.name);
          }
        }
      }
      if (args.use_reaction === true && !(type === 'attack' && args.reaction === true)) {
        assertDeclaredByOwner(ch, { declaredBy: memberId(exec, args.declared_by, 'declared_by'), recentSenders: sendersOf(exec) }, '反应');
        spendReaction(c, ch.name);
      }
      const spendKey = str(args.spend);
      const spent = spendKey === undefined ? undefined : useResource(c, ch.name, spendKey);
      const spentNote = spent === undefined ? '' : `\n用掉「${spent.key}」，剩 ${spent.resource.current}/${spent.resource.max}`;
      const bonusDice = str(args.bonus_dice);
      const extraRoll = bonusDice === undefined ? undefined : rollExpression(bonusDice, service.roller);
      const bonus = (int(args.bonus) ?? 0) + (extraRoll?.total ?? 0);
      const extraNote = extraRoll === undefined ? '' : `（含额外骰 ${extraRoll.detail}）`;

      if (type === 'death') {
        const id = rollId(c, exec);
        const r = deathSave(c, ch.name, service.roller);
        return `${r.name} 死亡豁免 ${r.detail}：${{ success: '成功', failure: '失败', stable: '三次成功，伤势稳定', dead: '死亡', revived: '天然 20，恢复 1 HP 醒来' }[r.outcome]}（成功 ${r.successes}/3，失败 ${r.failures}/3） #R${id}`;
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
        const modifier = weapon !== undefined ? weaponAttackModifier(ch, weapon, ability) : attackModifier(ch, ability);
        const id = rollId(c, exec);
        const roll = rollD20(modifier + bonus, adv, service.roller);
        const crit = roll.natural === 20;
        const targetAc = armorClass(c, target);
        const hit = crit || (roll.natural !== 1 && roll.total >= targetAc);
        const lines = [`${ch.name}${label !== undefined ? `（${label}）` : ''} 攻击 ${target.name}：${roll.detail}${extraNote}${target.kind === 'monster' ? '' : ` vs AC ${targetAc}`} → ${crit ? '重击！' : (hit ? '命中' : (roll.natural === 1 ? '天然 1，失手' : '未命中'))} #R${id}${spentNote}`];
        const extra = str(args.damage);
        const expression = attackExpression(ch, weapon, extra);
        const defense = parseDefense(args.defense);
        const damageType = str(args.damage_type);
        const auto = c.initiative === undefined || expression === undefined
          ? []
          : eligibleReactors(c, ch, target, { hit, crit, natural: roll.natural });
        const reactors = mergeReactors(auto, holdFor);
        // 能反应的人在场就先不落账；DM 手动挂起（hold / hold_for）时天然 1 也挂：重掷能改掉它
        const hold = c.initiative !== undefined && (wantHold || (expression !== undefined && roll.natural !== 1 && auto.length > 0));
        if (hold) {
          const dmg = hit && expression !== undefined ? rollAttackDamage(ch, weapon, expression, crit, service.roller) : undefined;
          if (dmg !== undefined) lines.push(`伤害（还没扣）${dmg.detail}`);
          const p: PendingAttack = {
            kind: 'attack', seq: id, at: Date.now(), attacker: ch.name, target: target.name, natural: roll.natural, rollDetail: roll.detail,
            total: roll.total, modifier: roll.modifier, advantage: adv, ac: targetAc, crit, reactors,
            attackMod: 0, acMod: 0, damageMod: 0, declined: [], claimed: [], used: [],
            ...(weapon !== undefined ? { weapon: weapon.name } : {}),
            ...(extra !== undefined ? { extraDamage: extra } : {}),
            ...(dmg !== undefined ? { rawDamage: dmg.total, damageDetail: dmg.detail } : {}),
            ...(damageType !== undefined ? { damageType } : {}),
            ...(defense !== undefined ? { defense } : {}),
            ...(onHit !== undefined ? { onHit } : {}),
          };
          requireInitiative(c).pending = p;
          lines.push(holdNotice(p));
          deps.onPendingAttack?.(recordOf(exec));
        } else if (hit) {
          if (expression === undefined) {
            lines.push('没有伤害表达式：传 weapon（角色卡上的武器），或用 dnd_roll 掷伤害（重击时骰子翻倍）再 dnd_apply 扣血。');
          } else {
            const dmg = rollAttackDamage(ch, weapon, expression, crit, service.roller);
            const amount = saveDamage(dmg.total, false, 'half', defense);
            lines.push(`伤害 ${dmg.detail}${defense !== undefined ? `，${DEFENSE_NAMES[defense]} → ${amount}` : ''}`);
            lines.push(...settleAttackDamage(c, ch.name, target.name, dmg.total, crit, damageType, defense, onHit, service.roller));
          }
        }
        const rangeNote = attackRangeNote(c, ch, target, { ...(weapon !== undefined ? { weapon } : {}), reaction: args.reaction === true, advantage: adv });
        if (rangeNote !== undefined) lines.push(rangeNote);
        lines.push(SECRET_NOTE);
        return lines.join('\n');
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
      const id = rollId(c, exec);
      const roll = rollD20(checkModifier(ch, kind, ability, skill) + bonus, adv, service.roller);
      const label = skill !== undefined ? `${skillLabel(skill)}检定` : `${ABILITY_NAMES[ability]}${kind === 'save' ? '豁免' : '检定'}`;
      const dc = int(args.dc);
      const verdict = dc === undefined
        ? ''
        : ` → ${roll.total >= dc ? '成功' : '失败'}${roll.natural === 20 ? '（天然 20）' : (roll.natural === 1 ? '（天然 1）' : '')}`;
      const head = `${ch.name} ${label}：${roll.detail}${extraNote}${verdict} #R${id}${spentNote}`;
      if (wantHold) {
        const p: PendingCheck = {
          kind: 'roll', seq: id, at: Date.now(), attacker: ch.name, target: ch.name, label,
          rolls: [{ name: ch.name, natural: roll.natural, modifier: roll.modifier, advantage: adv, total: roll.total, detail: `${roll.detail}${extraNote}`, mod: 0 }],
          ...(dc !== undefined ? { dc } : {}),
          damageMod: 0, reactors: holdFor, declined: [], claimed: [], used: [],
        };
        requireInitiative(c).pending = p;
        deps.onPendingAttack?.(recordOf(exec));
        return `${head}\n${holdNotice(p)}\n${SECRET_NOTE}`;
      }
      return `${head}\n${secret ? HIDDEN_ROLL_NOTE : SECRET_NOTE}`;
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
      add_conditions: { type: 'array', items: { type: 'string' }, description: 'e.g. ["中毒", "倒地"]' },
      remove_conditions: { type: 'array', items: { type: 'string' } },
      reaction: {
        type: 'object',
        description: 'For a pending roll. `target` names whose roll it changes (attack: the one attacked; save/check: the roller). '
          + 'e.g. cutting words {by:"Kriv",name:"尖刻言语",attack_mod:"-1d6",spend:"诗人激励"}; shield '
          + '{by:"Kriv",name:"护盾术",ac_mod:5,spend:"防御法杖充能"}; guided strike {by:"刻德温",name:"导引打击",attack_mod:"+10",spend:"引导神力"}; '
          + 'chronal shift {by:"奇塔露",name:"时间变幻",reroll:"d20",spend:"时间变幻"}.',
        properties: {
          by: { type: 'string' },
          name: { type: 'string' },
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
        },
        required: ['by', 'name'],
        additionalProperties: false,
      },
      decline: {
        type: 'array',
        items: { type: 'string' },
        description: 'Characters who will not react: their player said no, or the player is away and has not answered for a while '
          + '(the window has no time limit, so skipping an absent player is your call; say so in the reply).',
      },
      settle: { type: 'boolean', description: 'Apply the pending roll. Refused while someone has not answered (no time limit).' },
      cancel: { type: 'boolean', description: 'Drop the pending roll without applying it. Spent resources stay spent; if it should not have happened at all, use dnd_undo roll=.' },
      declared_by: { type: 'string', description: 'For reaction by a PC: member id of the player who said so (the #U number, pass "U3").' },
    },
    [],
    (args, exec) => mutate(exec, (c) => {
      if (args.targets !== undefined && (args.settle === true || args.cancel === true || args.reaction !== undefined || args.decline !== undefined)) {
        throw new Error('批量 targets 不能和反应/待结算混用；先处理停止点');
      }
      if (args.settle === true || args.cancel === true || args.reaction !== undefined || args.decline !== undefined) {
        if (c.initiative?.pending === undefined && c.initiative?.movement !== undefined) {
          if (args.reaction !== undefined) throw new Error('移动借机用 dnd_check type=attack reaction=true 结算，不用 dnd_apply reaction 改数值');
          const text = resolveMovement(c, args);
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
      const damageRoll = str(args.damage_roll) === undefined ? undefined : rollExpression(String(args.damage_roll), service.roller);
      const healRoll = str(args.heal_roll) === undefined ? undefined : rollExpression(String(args.heal_roll), service.roller);
      const lines: string[] = [];
      if (damageRoll !== undefined || healRoll !== undefined) {
        const id = rollId(c, exec);
        if (damageRoll !== undefined) lines.push(`公共伤害 ${damageRoll.detail} #R${id}`);
        if (healRoll !== undefined) lines.push(`公共治疗 ${healRoll.detail} #R${id}`);
      }
      for (const { ch, values } of resolved) {
        const details: string[] = [];
        const damage = int(values.damage) ?? damageRoll?.total;
        const healing = int(values.heal) ?? healRoll?.total;
        const temp = int(values.temp_hp);
        if (damage !== undefined && damage > 0) {
          const amount = saveDamage(damage, false, 'half', parseDefense(values.defense));
          details.push(hpLine(applyDamage(c, ch.name, amount, { crit: args.crit === true, damageType: str(values.damage_type), roller: service.roller })));
        }
        if (healing !== undefined && healing > 0) details.push(hpLine(heal(c, ch.name, healing)));
        if (temp !== undefined && temp > 0) details.push(hpLine(grantTempHp(c, ch.name, temp)));
        for (const cond of strList(values.add_conditions) ?? []) changeCondition(c, ch.name, cond, true);
        for (const cond of strList(values.remove_conditions) ?? []) changeCondition(c, ch.name, cond, false);
        if (details.length === 0) details.push(ch.kind === 'monster' ? `${ch.name} 状态已更新` : `${ch.name} HP ${ch.hp}/${ch.maxHp}`);
        details.push(`状态：${ch.conditions.join('、') || '无'}`);
        lines.push(details.join('；'));
      }
      return lines.join('\n');
    }),
  );
}
