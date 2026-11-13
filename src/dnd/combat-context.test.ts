import { describe, expect, it } from 'vitest';
import { createCampaign, startInitiative, upsertCharacter } from './campaign.ts';
import { AdventureLibrary } from './adventure.ts';
import { combatPartyContext } from './combat-context.ts';

function table() {
  const c = createCampaign('test', new AdventureLibrary().get('sunken-bell')!);
  upsertCharacter(c, {
    name: '时间法师', className: '时间魔法法师', level: 5, abilities: { dex: 16, int: 18 },
    skills: ['arcana'], expertise: ['investigation'], saves: ['int', 'wis'], initBonus: 7,
    notes: '现世感知：先攻加智力；灵敏之赐已施放，额外 1d8。',
    reactions: [{ name: '时间变幻' }],
    spells: [{ name: '护盾术', level: 1, wiki: 'https://example.test/spell', verified: true }],
    traits: ['时间变幻'],
  });
  upsertCharacter(c, { name: '弓手', level: 5, abilities: { dex: 18 }, traits: ['箭术'], weapons: [{ name: '长弓', ability: 'dex', damage: '1d8', magic: 1, ranged: true }] });
  upsertCharacter(c, { name: '怪物机密', kind: 'monster', maxHp: 91, ac: 23, room: c.currentRoom });
  startInitiative(c, (sides) => Math.min(sides, 10), ['时间法师', '怪物机密'], undefined, { 时间法师: '1d8' });
  return c;
}

describe('战斗能力交接', () => {
  it('携带角色被动、法术、装备、反应及技能，区分固定先攻和已掷结果', () => {
    const text = combatPartyContext(table());
    const cards = JSON.parse(text.split('\n').at(-1)!);
    expect(cards[0]).toMatchObject({
      className: '时间魔法法师', level: 5, abilities: { int: 18 }, skills: ['arcana', 'investigation'], expertise: ['investigation'], saves: ['int', 'wis'],
      participating: true, initiative: { fixed: 7, rolled: 25 }, reactions: [{ name: '时间变幻' }],
      spells: [{ name: '护盾术', level: 1 }], traits: ['时间变幻'],
    });
    expect(cards[0].notes).toContain('灵敏之赐');
    expect(cards[1]).toMatchObject({ participating: false, weapons: [{ baseAttackModifier: 10, baseDamage: '1d8+5' }] });
    expect(text).not.toContain('https://');
    expect(text).not.toContain('怪物机密');
    expect(text).toContain('不重掷');
  });

  it('只有备注中的被动不会被冒充成工具已计算的加值', () => {
    const c = table();
    delete c.characters[0]!.initBonus;
    const text = combatPartyContext(c);
    const cards = JSON.parse(text.split('\n').at(-1)!);
    expect(cards[0].initiative).toMatchObject({ fixed: 3, source: '敏捷调整值', rolled: 25 });
    expect(text).toContain('备注里的职业被动、专长与临时效果不会被程序自动识别');
  });
});
