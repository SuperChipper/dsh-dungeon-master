/** 掷骰与结算：dnd_roll、dnd_check、dnd_apply。 */
import { rollD20,rollExpression } from '../dice.ts';
import {
type PendingAttack,
type PendingCheck,applyDamage,
assertCanAct,assertNoPending,attackModifier,
changeCondition,checkModifier,deathSave,findCharacter,
findWeapon,grantTempHp,heal,isSurprised,requireCharacter,
requireInitiative,useResource,weaponAttackModifier
} from '../campaign.ts';
import { ABILITY_NAMES,type Ability,type Skill,SKILLS,parseAbility,parseSkill,skillLabel } from '../rules.ts';
import {
attackRangeNote
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
import {
SECRET_NOTE,
HIDDEN_ROLL_NOTE,attackExpression,
rollAttackDamage,
applyAttackDamage,str,
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
    + 'reverts that roll and everything after it.',
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
        description: 'Resource the roller spends on this roll, e.g. "1环法术位" for guiding bolt, "诗人激励" (spent by '
          + 'the character it is on). Fails if none left. Only when the player said they use it.',
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
          + 'opportunity attacks, reactions, a perception or knowledge check off-turn. Skips the turn-order and player checks.',
      },
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
        }
        return saveEffectText(c, args, targets, source?.name ?? str(args.character) ?? '效果', source !== undefined, exec, wantHold ? holdFor : undefined);
      }
      const ch = requireCharacter(c, String(args.character ?? ''));
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
        // 借机攻击要花反应；受惊的人轮到自己之前没有反应。对抗检定也走 reaction=true，不拦
        if (args.reaction === true && type === 'attack' && isSurprised(c, ch.name)) {
          throw new Error(`${ch.name} 受惊，自己第一个回合过去之前不能反应，这次借机打不了`);
        }
        // 打断回合顺序的反应/借机攻击之后，下一个 PC 回合重新给完整的停手提示
        if (args.reaction === true && c.initiative !== undefined) c.initiative.rebrief = true;
        assertCanAct(c, ch, actOptions());
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
        assertNoPending(c, '再结算攻击');
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
        const hit = crit || (roll.natural !== 1 && roll.total >= target.ac);
        const lines = [`${ch.name}${label !== undefined ? `（${label}）` : ''} 攻击 ${target.name}：${roll.detail}${extraNote}${target.kind === 'monster' ? '' : ` vs AC ${target.ac}`} → ${crit ? '重击！' : (hit ? '命中' : (roll.natural === 1 ? '天然 1，失手' : '未命中'))} #R${id}${spentNote}`];
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
            total: roll.total, modifier: roll.modifier, advantage: adv, ac: target.ac, crit, reactors,
            attackMod: 0, acMod: 0, damageMod: 0, declined: [], claimed: [], used: [],
            ...(weapon !== undefined ? { weapon: weapon.name } : {}),
            ...(extra !== undefined ? { extraDamage: extra } : {}),
            ...(dmg !== undefined ? { rawDamage: dmg.total, damageDetail: dmg.detail } : {}),
            ...(damageType !== undefined ? { damageType } : {}),
            ...(defense !== undefined ? { defense } : {}),
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
            lines.push(hpLine(applyAttackDamage(c, target.name, amount, crit, damageType, service.roller)));
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
    'Change a character\'s state: damage, healing, temporary HP, conditions. This is the only way HP or conditions '
    + 'change; roll the amount with dnd_roll first. Also resolves a pending roll (attack, save or check) left by dnd_check: '
    + '`reaction` changes the numbers or rerolls the d20 (the tool rolls the dice), `decline` records who passed, `settle` '
    + 'applies the result (once everyone answered or the window timed out), `cancel` drops it. A counter-attack reaction '
    + '(Sentinel) only registers {by,name} here; after settling, roll the strike with dnd_check reaction=true. Never fake a '
    + 'reaction with heal or compensation afterwards. Undead Fortitude and similar traits are handled from damage_type: never '
    + 'remove 死亡 or heal a dead monster by hand.',
    {
      target: { type: 'string' },
      damage: { type: 'integer' },
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
    ['target'],
    (args, exec) => mutate(exec, (c) => {
      if (args.settle === true || args.cancel === true || args.reaction !== undefined || args.decline !== undefined) {
        const { text, reopened } = resolvePending(c, args, exec);
        if (c.initiative?.pending === undefined) deps.onTurnChange?.(recordOf(exec));
        else if (reopened) deps.onPendingAttack?.(recordOf(exec));
        return text;
      }
      const ch = requireCharacter(c, String(args.target ?? ''));
      const lines: string[] = [];
      const damage = int(args.damage);
      const healing = int(args.heal);
      const temp = int(args.temp_hp);
      if (damage !== undefined && damage > 0) {
        lines.push(hpLine(applyDamage(c, ch.name, damage, { crit: args.crit === true, damageType: str(args.damage_type), roller: service.roller })));
      }
      if (healing !== undefined && healing > 0) lines.push(hpLine(heal(c, ch.name, healing)));
      if (temp !== undefined && temp > 0) lines.push(hpLine(grantTempHp(c, ch.name, temp)));
      for (const cond of strList(args.add_conditions) ?? []) changeCondition(c, ch.name, cond, true);
      for (const cond of strList(args.remove_conditions) ?? []) changeCondition(c, ch.name, cond, false);
      if (lines.length === 0) lines.push(`${ch.name} HP ${ch.hp}/${ch.maxHp}`);
      lines.push(`状态：${ch.conditions.join('、') || '无'}`);
      return lines.join('\n');
    }),
  );
}
