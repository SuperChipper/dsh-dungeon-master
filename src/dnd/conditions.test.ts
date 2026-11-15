import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdventureLibrary } from './adventure.ts';
import { armorClass, CampaignStore, requireCharacter, rest, upsertCharacter } from './campaign.ts';
import { effectiveMaxHp, normalizeCondition, upsertActiveState } from './conditions.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';

type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };

function createArena() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-conds-'));
  const rolls: number[] = [];
  const roller = vi.fn((sides: number) => rolls.shift() ?? Math.min(sides, 10));
  const service = new DndService({ store: new CampaignStore(root), library: new AdventureLibrary(), mapDir: root, roller });
  const key = 'group:G_COND';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, {
      name: '卡厄斯',
      player: '甲',
      playerId: 'P1',
      className: '圣武士',
      level: 5,
      maxHp: 44,
      ac: 18,
      speed: 30,
      abilities: { str: 18, dex: 10, con: 14, int: 10, wis: 12, cha: 16 },
      saves: ['wis', 'cha'],
      weapons: [
        { name: '长剑', damage: '1d8' },
        { name: '长戟', damage: '1d10', notes: '触及 10 尺，双手', twoHanded: true },
        { name: '重弩', damage: '1d10', ability: 'dex', ranged: true },
      ],
    });
    upsertCharacter(c, {
      name: '刻德温',
      player: '乙',
      playerId: 'P2',
      className: '牧师',
      level: 5,
      maxHp: 38,
      ac: 16,
      speed: 30,
      abilities: { str: 12, dex: 12, con: 14, int: 10, wis: 18, cha: 12 },
      saves: ['wis', 'cha'],
      weapons: [{ name: '硬头锤', damage: '1d6' }],
    });
    upsertCharacter(c, {
      name: '地精首领',
      kind: 'monster',
      maxHp: 60,
      ac: 15,
      speed: 30,
      abilities: { str: 14, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
      attackBonus: 4,
      damage: '1d6+2',
      room: c.currentRoom,
    });
    upsertCharacter(c, {
      name: '食人魔',
      kind: 'monster',
      maxHp: 80,
      ac: 11,
      speed: 30,
      abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
      attackBonus: 6,
      damage: '2d8+4',
      room: c.currentRoom,
    });
    requireCharacter(c, '卡厄斯').resources = {
      '1环法术位': { current: 4, max: 4, reset: 'long' },
      '2环法术位': { current: 2, max: 2, reset: 'long' },
      神圣武器: { current: 1, max: 1, reset: 'short' },
      动作如潮: { current: 1, max: 1, reset: 'short' },
      战斗英姿: { current: 3, max: 3, reset: 'long' },
      狂暴: { current: 2, max: 2, reset: 'long' },
    };
    requireCharacter(c, '刻德温').resources = {
      '1环法术位': { current: 4, max: 4, reset: 'long' },
    };
  });

  const tools = new Map<string, Tool>();
  const now = Date.now();
  registerDndTools({ get: () => ({ register: (t: Tool) => tools.set(t.name, t) }) } as never, {
    service,
    manager: {
      findByAgent: () => ({
        sessionKey: key,
        recentSenders: [
          { id: 'P1', at: now },
          { id: 'P2', at: now },
        ],
      }),
    } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    sendImage: vi.fn(),
  });

  const call = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.execute(args, { agent: {} })).text;
  const campaign = () => service.store.load(key)!;
  const ch = (name: string) => requireCharacter(campaign(), name);

  const startCombat = async () => {
    rolls.push(20, 15, 10, 5);
    await call('dnd_initiative', { action: 'start', participants: ['卡厄斯', '刻德温', '地精首领', '食人魔'] });
    await call('dnd_position', {
      action: 'terrain',
      width: 12,
      height: 12,
      areas: [],
    });
    await call('dnd_position', {
      action: 'set',
      placements: [
        { name: '卡厄斯', x: 2, y: 2 },
        { name: '地精首领', x: 3, y: 2 }, // 距卡厄斯 5 尺
        { name: '刻德温', x: 2, y: 5 },
        { name: '食人魔', x: 4, y: 2 }, // 距卡厄斯 10 尺
      ],
    });
  };

  return { service, key, rolls, roller, call, campaign, ch, startCombat };
}

describe('D&D 5e 全量结构化状态与旧存档兼容', () => {
  it('同义词归一、旧存档纯字符串 conditions 直接生效、未知自定义状态原样保留且不乱改骰子', async () => {
    expect(normalizeCondition('prone')).toBe('倒地');
    expect(normalizeCondition('Blinded')).toBe('失明');
    expect(normalizeCondition('Exhaustion 3')).toBe('力竭:3');
    expect(normalizeCondition('力竭2级')).toBe('力竭:2');
    expect(normalizeCondition('诅咒折磨')).toBe('诅咒折磨');

    const t = createArena();
    await t.startCombat();
    // 模拟旧存档：只有 conditions 字符串数组，无 activeStates，无 turnState
    t.service.store.update(t.key, (c) => {
      const ogre = requireCharacter(c, '食人魔');
      ogre.conditions = ['狂暴', '诅咒折磨'];
      delete ogre.activeStates;
      delete c.initiative!.turnState;
    });

    // 自定义状态“诅咒折磨”不报错，旧字符串“狂暴”自动触发物理伤害抗性
    t.rolls.push(15, 6); // 命中，1d8(6)+4 = 10 挥砍 → 狂暴抗性减半为 5
    const out = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'attack',
      target: '食人魔',
      weapon: '长戟',
      damage_type: '挥砍',
      declared_by: 'P1',
    });
    expect(out).toContain('狂暴(物理抗性)');
    expect(t.ch('食人魔').hp).toBe(75);
    expect(t.ch('食人魔').conditions).toEqual(['狂暴', '诅咒折磨']);
  });

  it('倒地（Prone）：5尺近战优势、10尺触及/远程劣势、优劣势抵消，以及自动半速起身与爬行', async () => {
    const t = createArena();
    await t.startCombat();
    await t.call('dnd_apply', { target: '地精首领', add_conditions: ['prone'] });
    expect(t.ch('地精首领').conditions).toEqual(['倒地']);
    await t.call('dnd_apply', { target: '食人魔', add_conditions: ['倒地'] });

    // 1) 5 尺内近战打倒地地精 → 自动优势（掷两颗 d20 取高）
    t.rolls.push(3, 16, 5);
    const closeAtk = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'attack',
      target: '地精首领',
      weapon: '长剑',
      declared_by: 'P1',
    });
    expect(closeAtk).toContain('目标倒地5尺内(优) → 优势');
    expect(closeAtk).toContain('d20优势[3,16→16]');

    // 2) 10 尺长戟打倒地食人魔 → 超过 5 尺自动劣势
    t.rolls.push(18, 4);
    const reachAtk = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'attack',
      target: '食人魔',
      weapon: '长戟',
      declared_by: 'P1',
    });
    expect(reachAtk).toContain('目标倒地10尺(劣) → 劣势');
    expect(reachAtk).toContain('d20劣势[18,4→4]');

    // 3) 卡厄斯自己也倒地，5 尺打倒地地精 → 自身倒地(劣) + 目标倒地5尺内(优) → 抵消平掷
    await t.call('dnd_apply', { target: '卡厄斯', add_conditions: ['倒地'] });
    t.rolls.push(12, 4);
    const cancelAtk = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'attack',
      target: '地精首领',
      weapon: '长剑',
      declared_by: 'P1',
    });
    expect(cancelAtk).toContain('自身倒地(劣)');
    expect(cancelAtk).toContain('目标倒地5尺内(优)');
    expect(cancelAtk).toContain('→ 抵消平掷');
    expect(cancelAtk).toContain('d20[12]');

    // 4) 爬行 crawl=true：保留倒地，走 1 格花 10 尺
    const crawlOut = await t.call('dnd_position', {
      action: 'move',
      name: '卡厄斯',
      x: 2,
      y: 3,
      crawl: true,
      disengage: true,
      declared_by: 'P1',
    });
    expect(crawlOut).toContain('保持倒地爬行');
    expect(t.ch('卡厄斯').conditions).toContain('倒地');
    expect(t.campaign().initiative!.moved!['卡厄斯']).toBe(10);

    // 5) 正常移动：自动花 15 尺半速起身并清除倒地，再走 1 格（5 尺），累计 10 + 15 + 5 = 30/30 尺
    const standMove = await t.call('dnd_position', {
      action: 'move',
      name: '卡厄斯',
      x: 2,
      y: 4,
      declared_by: 'P1',
    });
    expect(standMove).toContain('已自动花费 15 尺移动力从倒地起身并解除「倒地」');
    expect(t.ch('卡厄斯').conditions).not.toContain('倒地');
    expect(t.campaign().initiative!.moved!['卡厄斯']).toBe(30);
  });

  it('本人回合用 dnd_apply 移除倒地自动扣半速；被擒抱速度为0时禁止起身', async () => {
    const t = createArena();
    await t.startCombat();
    await t.call('dnd_apply', { target: '卡厄斯', add_conditions: ['倒地', '擒抱'] });

    // 速度为 0 不能起身
    await expect(t.call('dnd_apply', { target: '卡厄斯', remove_conditions: ['倒地'] }))
      .rejects.toThrow(/速度为 0/);

    // 同时移除擒抱与倒地则合法，且扣 15 尺移动力
    const stood = await t.call('dnd_apply', { target: '卡厄斯', remove_conditions: ['擒抱', '倒地'] });
    expect(stood).toContain('起身消耗 15 尺移动力');
    expect(t.campaign().initiative!.moved!['卡厄斯']).toBe(15);
  });

  it('失能拦截动作与反应、魅惑禁止打源、恐慌禁止靠近恐惧源、隐形免除借机', async () => {
    const t = createArena();
    await t.startCombat();

    // 魅惑绑定源：不能攻击魅惑源，但不影响攻击其他敌人
    t.service.store.update(t.key, (c) => {
      upsertActiveState(c, requireCharacter(c, '卡厄斯'), { name: '魅惑', source: '地精首领' });
      upsertActiveState(c, requireCharacter(c, '卡厄斯'), { name: '恐慌', source: '食人魔' });
    });
    await expect(t.call('dnd_check', {
      character: '卡厄斯',
      type: 'attack',
      target: '地精首领',
      weapon: '长剑',
      declared_by: 'P1',
    })).rejects.toThrow(/魅惑/);

    // 恐慌绑定源（食人魔在 4,2，卡厄斯在 2,2 距离 10 尺）：移到 (3,3) 距离变 5 尺 → 拦截！
    await expect(t.call('dnd_position', {
      action: 'move',
      name: '卡厄斯',
      x: 3,
      y: 3,
      disengage: true,
      declared_by: 'P1',
    })).rejects.toThrow(/恐慌/);

    // 隐形离开地精首领触及：不触发借机暂停
    t.service.store.update(t.key, (c) => {
      requireCharacter(c, '卡厄斯').conditions = [];
      delete requireCharacter(c, '卡厄斯').activeStates;
      upsertActiveState(c, requireCharacter(c, '卡厄斯'), { name: '隐形' });
    });
    const invMove = await t.call('dnd_position', {
      action: 'move',
      name: '卡厄斯',
      x: 0,
      y: 2,
      declared_by: 'P1',
    });
    expect(invMove).not.toContain('触发借机');
    expect(t.campaign().initiative!.movement).toBeUndefined();

    // 震慑：硬拦截主动动作，ignore_state_mods=true 才放行
    await t.call('dnd_apply', { target: '卡厄斯', add_conditions: ['震慑'] });
    await expect(t.call('dnd_check', {
      character: '卡厄斯',
      type: 'skill',
      skill: '察觉',
      declared_by: 'P1',
    })).rejects.toThrow(/震慑/);

    t.rolls.push(11);
    const bypassed = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'skill',
      skill: '察觉',
      declared_by: 'P1',
      ignore_state_mods: true,
    });
    expect(bypassed).toContain('察觉检定');
  });

  it('5尺内麻痹/昏迷：命中自动转重击、未命中仍未命中；力量/敏捷豁免自动失败；石化抗性与毒免；力竭1-6级与长休恢复', async () => {
    const t = createArena();
    await t.startCombat();
    await t.call('dnd_apply', { target: '地精首领', add_conditions: ['麻痹'] });

    // 1) 麻痹提供优势，若两颗都低（2, 3）+ 7 = 10 < AC 15 → 仍然未命中（不会误判为天然20必中！）
    t.rolls.push(2, 3);
    const missText = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'attack',
      target: '地精首领',
      weapon: '长剑',
      declared_by: 'P1',
    });
    expect(missText).toContain('未命中');
    expect(t.ch('地精首领').hp).toBe(60);

    // 2) 5 尺内命中麻痹目标（非天然20：d20 掷 10, 12 → 12+7=19 >= 15）：伤害骰 1d8 自动翻倍为 2d8！
    t.rolls.push(10, 12, 5, 6); // 2d8[5,6] + 4 = 15
    const critHit = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'attack',
      target: '地精首领',
      weapon: '长剑',
      declared_by: 'P1',
    });
    expect(critHit).toContain('自动重击');
    expect(critHit).toContain('2d8[5,6]');
    expect(t.ch('地精首领').hp).toBe(45);

    // 3) 麻痹目标敏捷豁免自动失败，不消耗 d20
    const callsBefore = t.roller.mock.calls.length;
    t.rolls.push(8); // 只消耗 1 颗伤害骰 1d8[8]，不消耗豁免 d20
    const saveOut = await t.call('dnd_check', {
      character: '刻德温',
      type: 'save',
      ability: '敏捷',
      dc: 14,
      damage: '1d8',
      damage_type: '光耀',
      targets: [{ name: '地精首领' }],
      reaction: true,
    });
    expect(saveOut).toContain('自动失败（处于麻痹（敏捷豁免自动失败）） → 失败');
    expect(t.roller.mock.calls.length).toBe(callsBefore + 1);
    expect(t.ch('地精首领').hp).toBe(37);

    // 4) 石化：毒素免疫 + 其他伤害抗性
    await t.call('dnd_apply', { target: '食人魔', add_conditions: ['石化'] });
    await t.call('dnd_apply', { target: '食人魔', damage: 20, damage_type: '毒素' });
    expect(t.ch('食人魔').hp).toBe(80);
    await t.call('dnd_apply', { target: '食人魔', damage: 20, damage_type: '火焰' });
    expect(t.ch('食人魔').hp).toBe(70);

    // 5) 力竭 4 级有效最大生命减半、力竭 5 级速度为 0、长休降 1 级力竭
    await t.call('dnd_apply', { target: '刻德温', add_conditions: ['力竭:4'] });
    expect(effectiveMaxHp(t.ch('刻德温'))).toBe(19);
    expect(t.ch('刻德温').hp).toBe(19);
    await t.call('dnd_apply', { target: '刻德温', heal: 10 });
    expect(t.ch('刻德温').hp).toBe(19); // 治疗不超过有效上限 19

    t.service.store.update(t.key, (c) => {
      delete c.initiative;
      rest(c, 'long', ['刻德温'], {}, t.roller);
    });
    expect(t.ch('刻德温').conditions).toEqual(['力竭:3']);
    expect(t.ch('刻德温').hp).toBe(38); // 降到力竭:3 后上限恢复 38 并回满
  });

  it('资源联动（神圣武器/祝福术/护盾信仰/动作如潮）、专注唯一性与自动打断、轮数递减与回合账本保密', async () => {
    const t = createArena();
    await t.startCombat();

    // 1) 卡厄斯用神圣武器（CHA 16 → +3 命中，主动作）+ 护盾信仰（AC +2，专注，附赠动作）
    const swOut = await t.call('dnd_resource', {
      action: 'use',
      character: '卡厄斯',
      resource: '神圣武器',
    });
    expect(swOut).toContain('攻击检定自动 +3');
    expect(swOut).toContain('【当前回合账本】卡厄斯');
    expect(swOut).toContain('主动作: 神圣武器');

    const sofOut = await t.call('dnd_resource', {
      action: 'use',
      character: '卡厄斯',
      resource: '1环法术位',
      apply_state: '护盾信仰',
      rounds: 2,
    });
    expect(sofOut).toContain('AC+2');
    expect(armorClass(t.campaign(), t.ch('卡厄斯'))).toBe(20); // 18 + 2

    // 同一回合再消耗一个附赠动作资源（战斗英姿）→ 输出动作经济提醒
    const dupBonus = await t.call('dnd_resource', {
      action: 'use',
      character: '卡厄斯',
      resource: '战斗英姿',
    });
    expect(dupBonus).toContain('【动作经济提醒】');

    // 动作如潮刷新主动作槽
    const surgeOut = await t.call('dnd_resource', {
      action: 'use',
      character: '卡厄斯',
      resource: '动作如潮',
    });
    expect(surgeOut).toContain('主动作: 可用');

    // 2) 卡厄斯改换专注施放祝福术给卡厄斯与刻德温 → 自动解除护盾信仰（AC 回到 18）！
    const blessOut = await t.call('dnd_resource', {
      action: 'use',
      character: '卡厄斯',
      resource: '1环法术位',
      apply_state: '祝福术',
      targets: ['卡厄斯', '刻德温'],
      action_cost: 'action',
    });
    expect(blessOut).toContain('对「护盾信仰」（卡厄斯）的专注中断');
    expect(armorClass(t.campaign(), t.ch('卡厄斯'))).toBe(18);
    expect(t.ch('刻德温').conditions).toContain('祝福术');

    // 3) 攻击同时享受神圣武器 +3 与祝福术自动 +1d4（且传了 bonus_dice="1d4" 时不会重复再投一颗 1d4）
    t.rolls.push(3, 10, 10, 5); // 祝福术 +1d4[3]，战斗英姿优势 2d20[10,10]，伤害 1d8[5]+4
    const blessedAtk = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'attack',
      target: '地精首领',
      weapon: '长剑',
      declared_by: 'P1',
    });
    // 基础命中 +7 + 神圣武器 3 + 祝福 3 = +13 → 10 + 13 = 23
    expect(blessedAtk).toContain('神圣武器+3');
    expect(blessedAtk).toContain('+1d4[3]');
    expect(blessedAtk).toContain('= 23');

    // 4) 卡厄斯受 24 点伤害 → 提示体质专注豁免 DC 12；接着做 concentration=true 豁免失败 → 自动移除两人身上的祝福术！
    const hurtOut = await t.call('dnd_apply', { target: '卡厄斯', damage: 24 });
    expect(hurtOut).toContain('专注受击（祝福术）：需过体质专注豁免 DC 12');

    t.rolls.push(2, 4); // 祝福术自身在豁免上也给 +1d4[2]，d20[4] + 2(CON) + 2 = 8 < DC 12 → 失败！
    const concSave = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'save',
      ability: '体质',
      dc: 12,
      concentration: true,
    });
    expect(concSave).toContain('专注中断（专注豁免失败）');
    expect(t.ch('卡厄斯').conditions).not.toContain('祝福术');
    expect(t.ch('刻德温').conditions).not.toContain('祝福术');

    // 5) 推进回合到怪物时，回合账本绝不泄露怪物具体 HP/AC 数字
    await t.call('dnd_initiative', { action: 'next', declared_by: 'P1' }); // 轮到刻德温
    const monsterTurn = await t.call('dnd_initiative', { action: 'next', declared_by: 'P2' }); // 轮到地精首领
    expect(monsterTurn).toContain('【当前回合账本】地精首领（受伤）');
    expect(monsterTurn).not.toContain('AC 15');
    expect(monsterTurn).not.toContain('/60');
  });

  it('持续轮数在施法者回合开始自动递减并在归零时解除', async () => {
    const t = createArena();
    await t.startCombat();
    await t.call('dnd_resource', {
      action: 'use',
      character: '卡厄斯',
      resource: '1环法术位',
      apply_state: '护盾信仰',
      rounds: 1,
    });
    expect(t.ch('卡厄斯').conditions).toContain('护盾信仰');
    await t.call('dnd_initiative', { action: 'next', declared_by: 'P1' }); // 刻德温
    expect(t.ch('卡厄斯').conditions).toContain('护盾信仰');
    await t.call('dnd_initiative', { action: 'next', declared_by: 'P2' }); // 地精首领
    await t.call('dnd_initiative', { action: 'next' }); // 食人魔
    await t.call('dnd_initiative', { action: 'next' }); // 回到卡厄斯回合开始 → 1 轮到期解除！
    expect(t.ch('卡厄斯').conditions).not.toContain('护盾信仰');
    expect(t.ch('卡厄斯').activeStates).toBeUndefined();
  });
});
