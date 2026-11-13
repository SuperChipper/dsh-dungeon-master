import { armorClass, initBonusOf, reactionBlocked, weaponAttackModifier, weaponDamage, type Campaign } from './campaign.ts';
import { canReact } from './battlefield.ts';

/** 完整机械卡随开战交接，剧情钩子和法术链接不占战斗上下文。 */
export function combatPartyContext(campaign: Campaign): string {
  const cards = campaign.characters.filter((ch) => ch.kind !== 'monster').map((ch) => {
    const initiative = campaign.initiative?.order.find((entry) => entry.name === ch.name);
    return {
      name: ch.name, kind: ch.kind, player: ch.player, className: ch.className, level: ch.level,
      participating: initiative !== undefined,
      abilities: ch.abilities, skills: ch.skills, expertise: ch.expertise, saves: ch.saves,
      ac: armorClass(campaign, ch), baseAc: ch.ac, hp: ch.hp, maxHp: ch.maxHp, tempHp: ch.tempHp, speed: ch.speed ?? 30,
      reaction: initiative === undefined ? undefined : { current: reactionBlocked(campaign, ch.name) === undefined && canReact(ch) ? 1 : 0, max: 1, reset: '本人下回合开始' },
      initiative: { fixed: initBonusOf(ch), source: ch.initBonus === undefined ? '敏捷调整值' : 'init_bonus 固定总加值', rolled: initiative?.init },
      attackBonus: ch.attackBonus, damage: ch.damage,
      weapons: ch.weapons?.map((weapon) => ({
        ...weapon, baseAttackModifier: weaponAttackModifier(ch, weapon), baseDamage: weaponDamage(ch, weapon),
      })),
      traits: ch.traits, reactions: ch.reactions,
      spells: ch.spells?.map(({ name, level }) => ({ name, level })),
      resources: ch.resources, hitDie: ch.hitDie, hitDiceUsed: ch.hitDiceUsed,
      conditions: ch.conditions, deathSaves: ch.deathSaves, notes: ch.notes,
      inventory: ch.inventory, room: ch.room,
    };
  });
  return [
    '【角色能力与被动 · 开战时快照】',
    '下列基础命中、伤害和固定先攻只按结构化字段计算；备注里的职业被动、专长与临时效果不会被程序自动识别。',
    '核对 notes、traits、reactions、装备和本桌约定；先攻已掷出的 rolled 与最新先攻表为准，不重掷。',
    '固定总先攻可用 dnd_character update init_bonus 持久保存；灵敏之赐等临时骰只在开战时传 bonus，不写成固定值，也不重复添加已包含的加值。',
    '生效时间、专注、目标和玩家预先声明的条件必须核对；知道某项能力不代表玩家授权消耗资源。HP、资源、位置等后续变化以最新团况和工具为准。',
    JSON.stringify(cards),
  ].join('\n');
}
