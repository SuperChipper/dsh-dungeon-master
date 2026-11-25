/**
 * dnd_rule 工具：支持在确认村规/第三方扩展（如魔兽 5e、自制神器、个人宿命特性）时，
 * 直接通过声明式钩子与安全公式热注册进当前团档或全局规则库，无需改代码重启。
 */
import { pushLog } from '../campaign.ts';
import {
  BUILTIN_EFFECTS,
  type CustomEffectDef,
  parseCustomEffectDef,
  resolveEffectDef,
} from '../custom-effects.ts';
import { str, type ToolKit } from './shared.ts';

function formatEffectHooks(def: CustomEffectDef): string {
  const parts: string[] = [];
  if (def.passive) parts.push('常驻被动');
  if (def.classFilter) parts.push(`限职业:${def.classFilter}`);
  if (def.concentration) parts.push('专注');
  if (def.transferable) parts.push('可转移专注');
  if (def.defaultRounds !== undefined) parts.push(`默认${def.defaultRounds}轮`);
  if (def.ongoing !== undefined) {
    const { repeatSave, endOnDamage, wakeAsAction, zeroSpeed } = def.ongoing;
    if (repeatSave !== undefined) parts.push(`${repeatSave.timing === 'target_turn_start' ? '目标回合开始' : '目标回合结束'}复豁免（${repeatSave.ability}）`);
    if (endOnDamage) parts.push('受伤解除');
    if (wakeAsAction) parts.push('可用动作唤醒');
    if (zeroSpeed) parts.push('速度归零');
  }
  if (def.attackMod) {
    const a = def.attackMod;
    const sub = [
      a.toHitFormula ? `命中+${a.toHitFormula}` : '',
      a.bonusDice ? `命中骰+${a.bonusDice}` : '',
      a.advantage ? (a.advantage === 'advantage' ? '优势' : '劣势') : '',
      a.critOn !== undefined ? `${a.critOn}-20重击` : '',
      a.targetBelowMaxHp ? '目标受损' : '',
      a.targetHalfHp ? '目标半血' : '',
      a.targetConditions?.length ? `目标含[${a.targetConditions.join('/')}]` : '',
      a.allyAdjacentToTarget ? '友方贴身' : '',
      a.firstRoundOnly ? '首轮' : '',
      a.requiresStates?.length ? `需[${a.requiresStates.join('/')}]` : '',
    ].filter(Boolean).join('/');
    if (sub) parts.push(`攻击(${sub})`);
  }
  if (def.hitRider) {
    const r = def.hitRider;
    const scaling = r.scalingDice ? `${r.scalingDice.countFormula}d${r.scalingDice.sides}` : undefined;
    const expr = [r.damageDice, scaling, r.weaponDie ? '1×武器骰' : undefined, r.bonusFormula ? `+${r.bonusFormula}` : ''].filter(Boolean).join('+');
    const flags = [
      r.markedTargetOnly ? '锁定目标' : '',
      r.targetBelowMaxHp ? '目标受损' : '',
      r.targetHalfHp ? '目标半血' : '',
      r.targetConditions?.length ? `目标含[${r.targetConditions.join('/')}]` : '',
      r.advantageOnly ? '仅优势' : '',
      r.noDisadvantage ? '无劣势' : '',
      r.advantageOrAllyAdjacent ? '优势或友方贴身' : '',
      r.allyAdjacentToTarget ? '友方贴身' : '',
      r.oncePerTurn ? '1次/回合' : '',
      r.ownTurnOnly ? '仅自己回合' : '',
      r.firstRoundOnly ? '仅首轮' : '',
      r.critOnly ? '仅重击' : '',
      r.requiresStates?.length ? `需[${r.requiresStates.join('/')}]` : '',
      r.finesseOrRangedOnly ? '灵巧/远程' : '',
      r.meleeOnly ? '近战' : '',
      r.rangedOnly ? '远程' : '',
      r.weaponOnly ? '武器' : '',
    ].filter(Boolean).join('·');
    parts.push(`附伤(${expr} ${r.damageType}${flags ? `，${flags}` : ''})`);
  }
  if (def.defenseMod) {
    const d = def.defenseMod;
    const sub = [
      d.acBonus !== undefined ? `AC+${d.acBonus}` : '',
      d.resistant?.length ? `抗性:${d.resistant.join('/')}` : '',
      d.immune?.length ? `免疫:${d.immune.join('/')}` : '',
      d.vulnerable?.length ? `易伤:${d.vulnerable.join('/')}` : '',
    ].filter(Boolean).join('，');
    if (sub) parts.push(`防御(${sub})`);
  }
  if (def.saveMod) {
    const s = def.saveMod;
    const who = s.abilities === undefined || s.abilities === 'all' ? '全豁免' : `${s.abilities.join('/')}豁免`;
    const sub = [
      s.bonusFormula ? `+${s.bonusFormula}` : '',
      s.bonusDice ? `+${s.bonusDice}` : '',
      s.advantage ? (s.advantage === 'advantage' ? '优势' : '劣势') : '',
      s.vsTags?.length ? `对抗[${s.vsTags.join('/')}]` : '',
    ].filter(Boolean).join(' ');
    parts.push(`${who}(${sub})`);
  }
  if (def.aura) {
    const au = def.aura;
    const sub = [
      `${au.radius}尺${au.radiusAt18 ? `(18级${au.radiusAt18}尺)` : ''}`,
      au.target === 'allies' ? '友方' : (au.target === 'enemies' ? '敌方' : '全体'),
      au.saveBonusFormula ? `豁免+${au.saveBonusFormula}` : '',
      au.slowFactor !== undefined ? `速度×${au.slowFactor}` : '',
      au.hazard ? `${au.hazard.damageDice} ${au.hazard.damageType}(${au.hazard.saveAbility}豁免)` : '',
    ].filter(Boolean).join('·');
    parts.push(`光环(${sub})`);
  }
  if (def.healMod) {
    const h = def.healMod;
    const sub = [
      h.bonusFormula ? `额外治疗+${h.bonusFormula}` : '',
      h.selfHealOnOtherFormula ? `自疗+${h.selfHealOnOtherFormula}` : '',
      h.poolFormula ? `治疗池=${h.poolFormula}` : '',
      h.capAtHalfMaxHp ? '上限半血' : '',
    ].filter(Boolean).join('，');
    if (sub) parts.push(`治疗(${sub})`);
  }
  return `${def.name}${def.aliases?.length ? `（别名：${def.aliases.join('、')}）` : ''}：${parts.join('；')}${def.description ? ` —— ${def.description}` : ''}`;
}

export function registerRuleTools(kit: ToolKit): void {
  const { service, recordOf, mutate, register } = kit;

  register(
    'dnd_rule',
    '查询或热注册扩展规则/村规/专武机制（define / list / show / remove）。注册后的规则只要与角色卡 traits（常驻被动）或 activeStates/conditions（限时状态）同名，战斗检定、命中附伤、豁免、光环与治疗工具即自动精确结算，无需重启。',
    {
      action: { type: 'string', enum: ['define', 'list', 'show', 'remove'], description: 'define 注册/更新规则；list 列出全部内置+全局+本团规则；show 查看单条规则 JSON；remove 删除规则' },
      scope: { type: 'string', enum: ['campaign', 'global'], description: 'campaign 仅写入当前团档（专武、个人宿命、本桌村规，默认）；global 写入 dnd/custom-effects.json 跨团共用（如魔兽 5e 职业扩展）' },
      name: { type: 'string', description: '规则/特性/状态标准名（如 "风暴遗誓·二阶"、"段云·雷鸣斩"、"虔诚光环"）' },
      aliases: { type: 'array', items: { type: 'string' }, description: '可选同义词/英文名列表' },
      description: { type: 'string', description: '规则效果简述（方便核对）' },
      passive: { type: 'boolean', description: '设为 true 表示常驻被动特性（除 traits 外，还可从卡面被动能力与非否定备注安全激活；切勿给法术位消耗类法术设 true）' },
      class_filter: { type: 'string', description: '可选职业正则（如 "游荡者|rogue"），用于在兼职角色中提取 class_level 及校验备注被动归属' },
      concentration: { type: 'boolean', description: '作为状态挂载时是否默认需要维持专注' },
      transferable: { type: 'boolean', description: '作为专注状态挂载时，原目标倒下或战斗结束后专注是否保留在施法者身上并支持免费转移目标（如脆弱诅咒、猎人印记）' },
      default_rounds: { type: 'integer', description: '作为状态挂载时的默认持续轮数（如 1 分钟填 10，1 小时填 600）' },
      attack_mod: {
        type: 'object',
        description: '攻击检定修正：{to_hit_formula, bonus_dice, advantage, crit_on, weapon_only, melee_only, ranged_only, target_below_max_hp, target_half_hp, target_conditions, ally_adjacent_to_target, first_round_only, requires_states}。公式可用 level / class_level / prof / str_mod..cha_mod / slot_level / hp / max_hp / target_hp / target_max_hp / min() / max() / floor() / ceil()',
      },
      hit_rider: {
        type: 'object',
        description: '命中自动附伤：{damage_dice, scaling_dice:{count_formula,sides}, weapon_die, bonus_formula, damage_type, marked_target_only, weapon_only, melee_only, ranged_only, finesse_or_ranged_only, str_attack_only, advantage_only, no_disadvantage, target_below_max_hp, target_half_hp, target_conditions, ally_adjacent_to_target, advantage_or_ally_adjacent, first_round_only, crit_only, own_turn_only, requires_states, once_per_turn}',
      },
      defense_mod: {
        type: 'object',
        description: '防御与抗性修正：{ac_bonus, resistant: ["毒素"], immune: [...], vulnerable: [...], attacker_advantage}',
      },
      save_mod: {
        type: 'object',
        description: '豁免检定修正：{abilities: ["con"] | "all", bonus_formula, bonus_dice, advantage, vs_tags: ["concentration", "毒素"]}',
      },
      ongoing: {
        type: 'object',
        description: '挂在目标身上的效果。conditions 为失败时施加的状态；requires_condition 被免疫时整个效果不生效。repeat_save 使用本次原始 DC，timing 为 target_turn_start 或 target_turn_end，ability 为 str/dex/con/int/wis/cha。end_on_damage、wake_as_action、zero_speed 为可选布尔值。',
        properties: {
          conditions: { type: 'array', minItems: 1, items: { type: 'string' } },
          requires_condition: { type: 'string' },
          repeat_save: {
            type: 'object', required: ['timing', 'ability'], additionalProperties: false,
            properties: {
              timing: { type: 'string', enum: ['target_turn_start', 'target_turn_end'] },
              ability: { type: 'string', enum: ['str', 'dex', 'con', 'int', 'wis', 'cha'] },
            },
          },
          end_on_damage: { type: 'boolean' },
          wake_as_action: { type: 'boolean' },
          zero_speed: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      aura: {
        type: 'object',
        description: '光环效果：{radius, radius_at_18, target: "allies"|"enemies"|"all", include_self, save_bonus_formula, slow_factor, hazard: {damage_dice, upcast_per_slot, base_slot, damage_type, save_ability, half_on_save}}',
      },
      heal_mod: {
        type: 'object',
        description: '治疗增强：{bonus_formula, self_heal_on_other_formula, pool_formula, cap_at_half_max_hp}',
      },
    },
    ['action'],
    (args, exec) => {
      const action = String(args.action ?? '');
      const scope = args.scope === 'global' ? 'global' : 'campaign';
      const key = recordOf(exec).sessionKey;
      const globalMap = service.globalEffects();

      if (action === 'list') {
        const found = service.active(key) ?? service.saved(key);
        const campMap = found?.campaign.customEffects ?? {};
        const lines: string[] = [];
        const campEntries = Object.values(campMap);
        const globalEntries = Object.values(globalMap);
        const builtinEntries = Object.values(BUILTIN_EFFECTS);
        lines.push(`【本团扩展规则（campaign，共 ${campEntries.length} 条）】`);
        lines.push(...(campEntries.length > 0 ? campEntries.map((d) => `- ${formatEffectHooks(d)}`) : ['（无）']));
        lines.push(`【全局扩展规则（global，共 ${globalEntries.length} 条）】`);
        lines.push(...(globalEntries.length > 0 ? globalEntries.map((d) => `- ${formatEffectHooks(d)}`) : ['（无）']));
        lines.push(`【引擎内置规则（builtin，共 ${builtinEntries.length} 条）】`);
        lines.push(...builtinEntries.map((d) => `- ${formatEffectHooks(d)}`));
        return lines.join('\n');
      }

      if (action === 'show') {
        const name = str(args.name);
        if (name === undefined) throw new Error('dnd_rule show 需要提供 name');
        const found = service.active(key) ?? service.saved(key);
        const def = resolveEffectDef(name, found?.campaign.customEffects, globalMap);
        if (def === undefined) throw new Error(`未找到规则「${name}」`);
        const origin = found?.campaign.customEffects?.[def.name] !== undefined
          ? 'campaign（本团专属）'
          : (globalMap[def.name] !== undefined ? 'global（全局跨团）' : 'builtin（引擎内置）');
        return `规则来源：${origin}\n${formatEffectHooks(def)}\n${JSON.stringify(def, null, 2)}`;
      }

      if (action === 'define') {
        const def = parseCustomEffectDef(args);
        if (scope === 'global') {
          service.customEffects.upsert(def);
          return `已写入全局规则库（global）：${formatEffectHooks(def)}\n用法：常驻被动用 dnd_character update traits 加入「${def.name}」；限时法术/状态用 dnd_resource use apply_state="${def.name}" 或 dnd_apply add_conditions=["${def.name}"]。`;
        }
        return mutate(exec, (c) => {
          c.customEffects = { ...(c.customEffects ?? {}), [def.name]: def };
          pushLog(c, `注册战役规则「${def.name}」`);
          return `已写入当前团档（campaign）：${formatEffectHooks(def)}\n用法：常驻被动用 dnd_character update traits 加入「${def.name}」；限时法术/状态用 dnd_resource use apply_state="${def.name}" 或 dnd_apply add_conditions=["${def.name}"]。`;
        }, { allowPaused: true });
      }

      if (action === 'remove') {
        const name = str(args.name);
        if (name === undefined) throw new Error('dnd_rule remove 需要提供 name');
        if (scope === 'global') {
          const ok = service.customEffects.remove(name);
          if (!ok) throw new Error(`全局规则库中没有「${name}」（引擎内置规则不可删除，但可用同名定义覆盖）`);
          return `已从全局规则库移除「${name}」。`;
        }
        return mutate(exec, (c) => {
          const map = c.customEffects ?? {};
          const matchKey = Object.keys(map).find((k) => k === name || k.toLowerCase() === name.toLowerCase());
          if (matchKey === undefined) {
            throw new Error(`当前团档 customEffects 中没有「${name}」（若是全局规则请传 scope="global"）`);
          }
          delete map[matchKey];
          if (Object.keys(map).length === 0) delete c.customEffects;
          else c.customEffects = map;
          pushLog(c, `移除战役规则「${matchKey}」`);
          return `已从当前团档移除规则「${matchKey}」。`;
        }, { allowPaused: true });
      }

      throw new Error(`未知 dnd_rule action: ${action}`);
    },
  );
}
