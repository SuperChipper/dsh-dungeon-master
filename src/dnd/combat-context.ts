import { armorClass, fightRooms, initBonusOf, reactionBlocked, roomOf, weaponAttackModifier, weaponDamage, type Campaign, type Character } from './campaign.ts';
import { canReact } from './battlefield.ts';

/** 单个参战我方角色（PC / 同伴 NPC）的完整战斗机械卡，供开战快照与中途 dnd_initiative join 共用。 */
export function combatParticipantCard(campaign: Campaign, ch: Character) {
  const initiative = campaign.initiative?.order.find((entry) => entry.name === ch.name);
  const weapons = ch.weapons?.map((weapon) => ({
    ...weapon, baseAttackModifier: weaponAttackModifier(ch, weapon), baseDamage: weaponDamage(ch, weapon),
  }));
  return {
    name: ch.name, kind: ch.kind, player: ch.player, className: ch.className, level: ch.level,
    participating: true,
    abilities: ch.abilities, skills: ch.skills, expertise: ch.expertise, saves: ch.saves,
    ac: armorClass(campaign, ch), baseAc: ch.ac, hp: ch.hp, maxHp: ch.maxHp, tempHp: ch.tempHp, speed: ch.speed ?? 30,
    reaction: { current: reactionBlocked(campaign, ch.name) === undefined && canReact(ch) ? 1 : 0, max: 1, reset: '本人下回合开始' },
    initiative: { fixed: initBonusOf(ch), source: ch.initBonus === undefined ? '敏捷调整值' : 'init_bonus 固定总加值', rolled: initiative?.init },
    attackBonus: ch.attackBonus, damage: ch.damage, weapons,
    traits: ch.traits, reactions: ch.reactions,
    spells: ch.spells?.map(({ name, level }) => ({ name, level })),
    resources: ch.resources, hitDie: ch.hitDie, hitDiceUsed: ch.hitDiceUsed,
    conditions: ch.conditions, deathSaves: ch.deathSaves, notes: ch.notes,
    inventory: ch.inventory, room: ch.room,
  };
}

/** 参战者携带完整机械卡；未参战者只带精简摘要，避免把全队背包与长篇背景故事塞进战斗上下文。 */
export function combatPartyContext(campaign: Campaign): string {
  const activeRooms = fightRooms(campaign);
  const cards = campaign.characters.filter((ch) => ch.kind !== 'monster').map((ch) => {
    const initiative = campaign.initiative?.order.find((entry) => entry.name === ch.name);
    const chRoom = roomOf(campaign, ch);
    if (initiative === undefined && activeRooms.size > 0 && (chRoom === undefined || !activeRooms.has(chRoom))) {
      return {
        name: ch.name, kind: ch.kind, player: ch.player, className: ch.className, level: ch.level,
        participating: false, hp: ch.hp, maxHp: ch.maxHp, conditions: ch.conditions, room: chRoom,
      };
    }
    if (initiative === undefined) {
      const weapons = ch.weapons?.map((weapon) => ({
        ...weapon, baseAttackModifier: weaponAttackModifier(ch, weapon), baseDamage: weaponDamage(ch, weapon),
      }));
      return {
        name: ch.name, kind: ch.kind, player: ch.player, className: ch.className, level: ch.level,
        participating: false,
        abilities: ch.abilities, saves: ch.saves,
        ac: armorClass(campaign, ch), baseAc: ch.ac, hp: ch.hp, maxHp: ch.maxHp, tempHp: ch.tempHp, speed: ch.speed ?? 30,
        initiative: { fixed: initBonusOf(ch), source: ch.initBonus === undefined ? '敏捷调整值' : 'init_bonus 固定总加值', rolled: undefined },
        attackBonus: ch.attackBonus, damage: ch.damage, weapons,
        traits: ch.traits, reactions: ch.reactions, conditions: ch.conditions, room: ch.room,
      };
    }
    return combatParticipantCard(campaign, ch);
  });
  return [
    '【角色能力与被动 · 开战时快照】',
    '下列基础命中、伤害和固定先攻只按结构化字段计算；备注里的职业被动、专长与临时效果不会被程序自动识别（已结构化支持的：巨武器战斗、箭术、精灵精准、不死坚韧；dnd_resource use「战斗英姿」自动给临时 HP 与本回合优势，「咒剑诅咒」自动记 19-20 重击与熟练加伤）。',
    'participating=false 的角色未参战，不进入反应与借机名单；若中途入战须先 dnd_initiative join（返回结果会自动附上新参战我方的完整能力卡）。',
    '核对参战者的 notes、traits、reactions、装备和本桌约定；先攻已掷出的 rolled 与最新先攻表为准，不重掷。',
    '固定总先攻可用 dnd_character update init_bonus 持久保存；灵敏之赐等临时骰只在开战/中途入战时传 bonus，不写成固定值，也不重复添加已包含的加值。',
    '生效时间、专注、目标和玩家预先声明的条件必须核对；知道某项能力不代表玩家授权消耗资源。HP、资源、位置等后续变化以最新团况和工具为准。',
    JSON.stringify(cards),
  ].join('\n');
}
