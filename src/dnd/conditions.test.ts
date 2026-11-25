import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdventureLibrary } from './adventure.ts';
import { armorClass, CampaignStore, requireCharacter, rest, upsertCharacter } from './campaign.ts';
import { collectHitRiders, computeAttackStateMods, computeSaveStateMods, effectiveMaxHp, movementSpeedInfo, normalizeCondition, unhandledCombatPassives, upsertActiveState } from './conditions.ts';
import { srdMonsterInput } from './dnd-tools.ts';
import { computeExpected5eSlots } from './tools/character.ts';
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

  it('定身按玩家和怪物自己的回合末复豁免，只解除成功目标且不输出 DC', async () => {
    const t = createArena();
    await t.startCombat();
    t.rolls.push(2, 2, 3, 20);
    await t.call('dnd_check', {
      type: 'save', character: '卡厄斯', declared_by: 'P1', spell_name: 'Hold Person', ability: '感知', dc: 15,
      targets: [{ name: '刻德温' }, { name: '地精首领' }],
    });
    expect(t.ch('刻德温').conditions).toContain('麻痹');
    expect(t.ch('地精首领').conditions).toContain('麻痹');
    expect(await t.call('dnd_initiative', { action: 'next', declared_by: 'P1' })).not.toContain('回合结束感知豁免');
    const pc = await t.call('dnd_initiative', { action: 'next', declared_by: 'P2' });
    expect(pc).toMatch(/刻德温「人类定身术」回合结束感知豁免.*失败，持续/);
    const monster = await t.call('dnd_initiative', { action: 'next' });
    expect(monster).toMatch(/地精首领「人类定身术」回合结束感知豁免.*成功，解除/);
    expect(monster).not.toMatch(/DC\s*15/);
    expect(t.ch('地精首领').conditions).not.toContain('麻痹');
    expect(t.ch('刻德温').conditions).toContain('麻痹');
    expect(t.rolls).toEqual([]);
    await t.call('dnd_initiative', { action: 'goto', name: '刻德温', round: 1 });
    t.rolls.push(20);
    expect(await t.call('dnd_initiative', { action: 'next', declared_by: 'P2' })).not.toContain('回合结束感知豁免');
    expect(t.rolls).toEqual([20]);
  });

  it('首次开战会结算首个行动者的回合开始复豁免', async () => {
    const t = createArena();
    await t.call('dnd_rule', {
      action: 'define', name: '测试开场束缚',
      ongoing: { conditions: ['束缚'], repeat_save: { timing: 'target_turn_start', ability: 'str' } },
    });
    await t.call('dnd_apply', { target: '卡厄斯', add_conditions: ['测试开场束缚'], save_dc: 19 });
    t.rolls.push(20, 15, 10, 5, 2);
    const start = await t.call('dnd_initiative', {
      action: 'start', participants: ['卡厄斯', '刻德温', '地精首领', '食人魔'],
    });
    expect(start).toMatch(/卡厄斯「测试开场束缚」回合开始力量豁免.*失败，持续/);
    expect(t.ch('卡厄斯').conditions).toContain('束缚');
    expect(t.ch('卡厄斯').activeStates?.[0]?.ongoing?.lastSaveRound).toBe(1);
    expect(t.rolls).toEqual([]);
  });

  it('dnd_apply 传入 save_dc 但只传裸状态名时给出明确提醒，改传效果名则正常挂载复豁免', async () => {
    const t = createArena();
    await t.startCombat();
    const raw = await t.call('dnd_apply', { target: '地精首领', add_conditions: ['麻痹'], save_dc: 15, rounds: 10 });
    expect(raw).toContain('未匹配到带自动复豁免的效果规则');
    expect(t.ch('地精首领').conditions).toContain('麻痹');
    expect(t.ch('地精首领').activeStates?.some((s) => s.ongoing?.repeatSave !== undefined)).toBe(false);

    const named = await t.call('dnd_apply', { target: '食人魔', add_conditions: ['人类定身术'], save_dc: 15 });
    expect(named).not.toContain('未匹配到带自动复豁免的效果规则');
    expect(t.ch('食人魔').activeStates?.some((s) => s.ongoing?.repeatSave?.dc === 15)).toBe(true);
  });

  it('催眠图纹速度为零，免疫魅惑阻止整个效果，受伤与唤醒只移除该效果', async () => {
    const t = createArena();
    await t.startCombat();
    await t.call('dnd_character', { action: 'update', name: '食人魔', condition_immunities: ['charmed'] });
    await t.call('dnd_apply', { target: '地精首领', add_conditions: ['失能'] });
    t.rolls.push(2, 2);
    const cast = await t.call('dnd_check', {
      type: 'save', character: '卡厄斯', declared_by: 'P1', spell_name: '催眠图纹', ability: '感知', dc: 15,
      targets: [{ name: '地精首领' }, { name: '食人魔' }],
    });
    expect(cast).toContain('免疫「魅惑」');
    expect(t.ch('食人魔').conditions).not.toContain('失能');
    expect(movementSpeedInfo(t.ch('地精首领')).baseSpeed).toBe(0);
    const damage = await t.call('dnd_apply', { target: '地精首领', damage: 1 });
    expect(damage).toContain('受伤解除「催眠图纹」');
    expect(t.ch('地精首领').conditions).toEqual(['失能']);
    expect(movementSpeedInfo(t.ch('地精首领')).baseSpeed).toBe(30);
    await t.call('dnd_apply', { target: '地精首领', add_conditions: ['催眠图纹'] });
    expect(await t.call('dnd_apply', { target: '地精首领', wake_by: '卡厄斯', declared_by: 'P1' })).toContain('用主动作唤醒');
    expect(t.ch('地精首领').conditions).toEqual(['失能']);
    expect(t.campaign().initiative!.turnState?.actionUsed).toBe('唤醒');
  });

  it('热注册的复豁免在挂起、落盘及规则更新后保持生效时的规则', async () => {
    const t = createArena();
    await t.startCombat();
    const rule = { action: 'define', name: '测试毒触', scope: 'campaign' };
    await t.call('dnd_rule', {
      ...rule, ongoing: { conditions: ['中毒'], repeat_save: { timing: 'target_turn_end', ability: 'con' } },
    });
    t.rolls.push(2, 20);
    await t.call('dnd_check', {
      character: '卡厄斯', declared_by: 'P1', type: 'save', spell_name: rule.name, is_spell: false,
      ability: '体质', dc: 15, targets: [{ name: '地精首领' }], hold: true,
    });
    await t.call('dnd_rule', { ...rule, ongoing: { conditions: ['中毒'], end_on_damage: true } });
    await t.call('dnd_apply', { target: '地精首领', settle: true });
    await t.call('dnd_apply', { target: '地精首领', damage: 1 });
    expect(t.ch('地精首领').conditions).toContain('中毒');
    await t.call('dnd_apply', { target: '食人魔', add_conditions: [rule.name] });
    expect(t.ch('食人魔').conditions).toContain('中毒');
    await t.call('dnd_apply', { target: '食人魔', damage: 1 });
    expect(t.ch('食人魔').conditions).not.toContain('中毒');
    await t.call('dnd_initiative', { action: 'next', declared_by: 'P1' });
    await t.call('dnd_initiative', { action: 'next', declared_by: 'P2' });
    expect(await t.call('dnd_initiative', { action: 'next' })).toMatch(/地精首领「测试毒触」回合结束体质豁免.*成功，解除/);
    expect(t.ch('地精首领').conditions).not.toContain('中毒');
  });

  it('迟缓阻止同回合的第二击和附赠动作，也不能用动作如潮清掉攻击限制', async () => {
    const t = createArena();
    await t.startCombat();
    await t.call('dnd_apply', { target: '卡厄斯', add_conditions: ['缓慢术'], save_dc: 15 });
    const attack = { type: 'attack', character: '卡厄斯', declared_by: 'P1', target: '地精首领', weapon: '长剑' };
    t.rolls.push(20, 4, 4, 19);
    await t.call('dnd_check', attack);
    const hp = t.ch('地精首领').hp;
    await expect(t.call('dnd_check', attack)).rejects.toThrow(/每回合只能攻击一次/);
    await expect(t.call('dnd_resource', { action: 'use', character: '卡厄斯', resource: '战斗英姿', declared_by: 'P1' }))
      .rejects.toThrow(/只能选择主动作或附赠动作/);
    await t.call('dnd_resource', { action: 'use', character: '卡厄斯', resource: '动作如潮', declared_by: 'P1' });
    await expect(t.call('dnd_check', attack)).rejects.toThrow(/每回合只能攻击一次/);
    expect(t.ch('地精首领').hp).toBe(hp);
    expect(t.rolls).toEqual([19]);
  });

  it('SRD 状态免疫独立于伤害，非专注豁免仍保存施加者', async () => {
    const t = createArena();
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, {
        ...srdMonsterInput({ index: 'skeleton', hit_points: 13, condition_immunities: [{ index: 'poisoned' }] }),
        name: '骷髅', room: c.currentRoom,
      });
    });
    t.rolls.push(3, 3);
    const cast = await t.call('dnd_check', {
      type: 'save', character: '卡厄斯', declared_by: 'P1', ability: '感知', dc: 15, concentration: false,
      damage: '3', damage_type: '火焰', on_fail_conditions: ['中毒', '恐慌'], targets: [{ name: '骷髅' }],
    });
    expect(cast).toContain('免疫「中毒」');
    expect(t.ch('骷髅').hp).toBe(10);
    expect(t.ch('骷髅').conditions).toEqual(['恐慌']);
    expect(t.ch('骷髅').activeStates).toEqual([{ name: '恐慌', source: '卡厄斯' }]);
  });

  it('可转移专注（脆弱诅咒/猎人印记）：双术士同首领共存不互吞、击杀与战后清尸保留专注、零环位免费 transfer、护栏防误扣法术位、3环8小时跨短休保留', async () => {
    const t = createArena();
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, {
        name: '恩佐',
        player: '薯条大王',
        playerId: 'P1',
        className: '邪术师（至高妖精）6',
        level: 6,
        maxHp: 40,
        ac: 16,
        speed: 35,
        abilities: { str: 8, dex: 16, con: 13, int: 10, wis: 13, cha: 16 },
        hitDie: 'd8',
        weapons: [{ name: '契约短剑', damage: '1d6', ability: 'dex' }],
      });
      requireCharacter(c, '恩佐').resources = {
        '契约法术位（3环）': { current: 0, max: 2, reset: 'short' },
        '生命骰 d8': { current: 6, max: 6, reset: 'long' },
      };
      upsertCharacter(c, {
        name: '丛云',
        player: 'kisoon',
        playerId: 'P2',
        className: '战士 5 / 邪术师 2',
        level: 7,
        maxHp: 56,
        ac: 19,
        speed: 30,
        abilities: { str: 9, dex: 14, con: 14, int: 8, wis: 14, cha: 18 },
        weapons: [{ name: 'Talon', damage: '1d8', ability: 'cha' }],
      });
      requireCharacter(c, '丛云').resources = {
        '契约法术位（1环）': { current: 2, max: 2, reset: 'short' },
      };
    });

    // 1) 恩佐升 7 级兼职 1 级吟游诗人：dnd_character update 自动补齐「1环法术位 2/2」与「生命骰 d8 7/7」，已空的契约法术位保持 0/2
    const lvUpOut = await t.call('dnd_character', {
      action: 'update',
      name: '恩佐',
      level: 7,
      class_name: '邪术师（至高妖精）6 / 吟游诗人 1',
      max_hp: 45,
    });
    expect(lvUpOut).toContain('升级/兼职自动同步资源');
    expect(t.ch('恩佐').resources!['1环法术位']).toEqual({ current: 2, max: 2, reset: 'long' });
    expect(t.ch('恩佐').resources!['生命骰 d8']).toEqual({ current: 7, max: 7, reset: 'long' });
    expect(t.ch('恩佐').resources!['契约法术位（3环）']!.current).toBe(0);

    // 2) 开战：恩佐与丛云同时对「地精首领」施放《脆弱诅咒》（即便模型习惯性传了 rounds=10，自动按 1 小时=600 轮入账）
    t.rolls.push(20, 18, 15, 10, 5);
    await t.call('dnd_initiative', { action: 'start', participants: ['恩佐', '丛云', '卡厄斯', '地精首领', '食人魔'] });
    await t.call('dnd_resource', {
      action: 'use',
      character: '恩佐',
      resource: '1环法术位',
      apply_state: '脆弱诅咒',
      target: '地精首领',
      rounds: 10,
    });
    expect(t.ch('恩佐').resources!['1环法术位']!.current).toBe(1);
    expect(t.ch('恩佐').concentrationState).toMatchObject({ name: '脆弱诅咒', roundsLeft: 600, transferable: true, currentTarget: '地精首领' });

    await t.call('dnd_resource', {
      action: 'use',
      character: '丛云',
      resource: '契约法术位（1环）',
      apply_state: '脆弱诅咒',
      target: '地精首领',
    });
    // 双术士对同一首领挂脆弱诅咒：互不覆盖！两人攻击各自触发 +1d6 黯蚀，而无标记的卡厄斯绝不蹭伤
    expect(t.ch('地精首领').activeStates).toHaveLength(2);
    t.rolls.push(15, 4, 5); // 恩佐命中：1d6[4]+3 + 脆弱诅咒 1d6[5]
    const enzoHit = await t.call('dnd_check', { character: '恩佐', type: 'attack', target: '地精首领', weapon: '契约短剑', declared_by: 'P1' });
    expect(enzoHit).toContain('脆弱诅咒');

    await t.call('dnd_initiative', { action: 'next', declared_by: 'P1' }); // 轮到丛云
    t.rolls.push(15, 6, 4); // 丛云命中：1d8[6]+4 + 脆弱诅咒 1d6[4]
    const murakumoHit = await t.call('dnd_check', { character: '丛云', type: 'attack', target: '地精首领', weapon: 'Talon', declared_by: 'P2' });
    expect(murakumoHit).toContain('脆弱诅咒');

    await t.call('dnd_initiative', { action: 'next', declared_by: 'P2' }); // 轮到卡厄斯
    t.rolls.push(15, 5); // 卡厄斯攻击地精首领：绝不触发脆弱诅咒！
    const caelusHit = await t.call('dnd_check', { character: '卡厄斯', type: 'attack', target: '地精首领', weapon: '长剑', declared_by: 'P1' });
    expect(caelusHit).not.toContain('脆弱诅咒');

    // 原目标尚存活（HP > 0）时禁止免费转移
    await expect(t.call('dnd_resource', { action: 'transfer', character: '恩佐', target: '食人魔' }))
      .rejects.toThrow(/尚未倒下/);

    // 3) 击杀地精首领并结束战斗（endInitiative 清除死怪）：两人的脆弱诅咒专注完整保留在自身卡上！
    await t.call('dnd_apply', { target: '地精首领', damage: 200 });
    await t.call('dnd_apply', { target: '食人魔', damage: 200 });
    await t.call('dnd_initiative', { action: 'end' });
    expect(t.campaign().characters.find((x) => x.name === '地精首领')).toBeUndefined();
    expect(t.ch('恩佐').concentrationState).toMatchObject({ name: '脆弱诅咒', transferable: true, canTransfer: true });
    expect(t.ch('丛云').concentrationState).toMatchObject({ name: '脆弱诅咒', transferable: true, canTransfer: true });
    const briefAfterFight = await t.call('dnd_character', { action: 'show', name: '恩佐', brief: true });
    expect(briefAfterFight).toContain('专注:脆弱诅咒(可转移)');

    // 4) 下一场遭遇战开打：防误扣护栏阻止恩佐再花第 2 个 1 环位重放脆弱诅咒，引导用 transfer 零消耗转移！
    await t.call('dnd_character', { action: 'create', name: '蛇人卫兵', kind: 'monster', max_hp: 45, ac: 14, count: 2 });
    t.rolls.push(20, 15, 10, 5);
    await t.call('dnd_initiative', { action: 'start', participants: ['恩佐', '丛云', '蛇人卫兵1', '蛇人卫兵2'] });
    await expect(t.call('dnd_resource', {
      action: 'use',
      character: '恩佐',
      resource: '1环法术位',
      apply_state: '脆弱诅咒',
      target: '蛇人卫兵1',
    })).rejects.toThrow(/仍在维持「脆弱诅咒」的专注.*action="transfer"/);
    expect(t.ch('恩佐').resources!['1环法术位']!.current).toBe(1); // 法术位未扣！

    // 用 action="transfer" 零消耗转给蛇人卫兵1；同时兼容模型旧写法 dnd_apply add_conditions=["脆弱诅咒"] 替丛云转给蛇人卫兵2
    const transferOut = await t.call('dnd_resource', {
      action: 'transfer',
      character: '恩佐',
      target: '蛇人卫兵1',
    });
    expect(transferOut).toContain('未消耗法术位');
    expect(t.ch('恩佐').resources!['1环法术位']!.current).toBe(1);
    expect(t.ch('蛇人卫兵1').activeStates).toMatchObject([{ name: '脆弱诅咒', source: '恩佐', concentration: true }]);

    await t.call('dnd_initiative', { action: 'next', declared_by: 'P1' }); // 轮到丛云
    const fallbackApply = await t.call('dnd_apply', { target: '蛇人卫兵2', add_conditions: ['脆弱诅咒'] });
    expect(fallbackApply).toContain('已将 丛云 的「脆弱诅咒」专注转移至 蛇人卫兵2');
    expect(t.ch('蛇人卫兵2').activeStates).toMatchObject([{ name: '脆弱诅咒', source: '丛云', concentration: true }]);
    await t.call('dnd_initiative', { action: 'end' });

    // 5) 短休（1 小时 = 600 轮）：1 环 600 轮脆弱诅咒到期，契约法术位（3环）回满 2/2；再用 3 环位施放 8 小时（4800 轮）脆弱诅咒，下次短休后专注与满额契约位并存！
    await t.call('dnd_rest', { kind: 'short' });
    expect(t.ch('恩佐').concentrationState).toBeUndefined();
    expect(t.ch('恩佐').resources!['契约法术位（3环）']!.current).toBe(2);

    await t.call('dnd_resource', {
      action: 'use',
      character: '恩佐',
      resource: '契约法术位（3环）',
      apply_state: '脆弱诅咒',
      target: '蛇人卫兵1',
      drop_concentration: true,
    });
    expect(t.ch('恩佐').concentrationState).toMatchObject({ name: '脆弱诅咒', slotLevel: 3, roundsLeft: 4800 });
    expect(t.ch('恩佐').resources!['契约法术位（3环）']!.current).toBe(1);
    await t.call('dnd_rest', { kind: 'short' });
    expect(t.ch('恩佐').resources!['契约法术位（3环）']!.current).toBe(2); // 契约位回满！
    expect(t.ch('恩佐').concentrationState).toMatchObject({ name: '脆弱诅咒', slotLevel: 3, roundsLeft: 4200 }); // 8h - 1h = 7h 专注仍在！
  });

  it('资源同步与挂起专注豁免：setResource 0/0 升上限自动补差额、兼职法术位表核对、hold_for 挂起专注豁免失败落账自动断专注', async () => {
    // 校验 5e 兼职/单职法术位表推导（单施法职业兼职 vs 多施法职业兼职 vs 契约魔法独立计算）
    expect(computeExpected5eSlots('邪术师（至高妖精）6 / 吟游诗人 1', 7)).toEqual({
      standard: { 1: 2 },
      pact: { slotLevel: 3, max: 2 },
    });
    expect(computeExpected5eSlots('游侠（猎人）5 / 游荡者 2', 7)).toEqual({
      standard: { 1: 4, 2: 2 },
    });
    expect(computeExpected5eSlots('圣武士（奉献之誓）6 / 术士（神恩之魂）1', 7)).toEqual({
      standard: { 1: 4, 2: 3 },
    });
    expect(computeExpected5eSlots('法师（时间魔法）', 7)).toEqual({
      standard: { 1: 4, 2: 3, 3: 3, 4: 1 },
    });

    const t = createArena();
    // 1) 0/0 占位资源调高上限时自动补入新增额度（避免 0/0 变成空槽 0/2），已消耗格数升级时只加差额
    await t.call('dnd_resource', { action: 'set', character: '卡厄斯', resource: '3环法术位', max: 0, current: 0 });
    await t.call('dnd_resource', { action: 'set', character: '卡厄斯', resource: '3环法术位', max: 2 });
    expect(t.ch('卡厄斯').resources!['3环法术位']).toMatchObject({ current: 2, max: 2 });
    await t.call('dnd_resource', { action: 'use', character: '卡厄斯', resource: '3环法术位', amount: 2 });
    expect(t.ch('卡厄斯').resources!['3环法术位']!.current).toBe(0); // 0/2
    await t.call('dnd_resource', { action: 'set', character: '卡厄斯', resource: '3环法术位', max: 3 });
    expect(t.ch('卡厄斯').resources!['3环法术位']).toMatchObject({ current: 1, max: 3 }); // +1 新增环位可用

    // 2) 挂起专注豁免（hold_for 等时间变幻）：玩家跳过反应后 settle=true 失败自动打断专注！
    await t.startCombat();
    await t.call('dnd_resource', {
      action: 'use',
      character: '卡厄斯',
      resource: '1环法术位',
      apply_state: '护盾信仰',
    });
    expect(t.ch('卡厄斯').conditions).toContain('护盾信仰');
    t.rolls.push(2); // d20=2 + CON(2) + 守护灵光 = 失败 vs DC 20
    const heldSave = await t.call('dnd_check', {
      character: '卡厄斯',
      type: 'save',
      ability: '体质',
      dc: 20,
      concentration: true,
      hold_for: [{ by: '刻德温', name: '反应' }],
    });
    expect(heldSave).toContain('待结算');
    expect(t.ch('卡厄斯').conditions).toContain('护盾信仰'); // 尚未落账前不断专注
    const settledSave = await t.call('dnd_apply', { target: '卡厄斯', decline: ['刻德温'], settle: true });
    expect(settledSave).toContain('专注中断');
    expect(t.ch('卡厄斯').conditions).not.toContain('护盾信仰');
    expect(t.ch('卡厄斯').concentrationState).toBeUndefined();
  });

  it('巨兽杀手/巨像屠夫：满血首伤跳过（不泄血量）、受伤后连击触发、每回合1次、敌人回合借机与多来源防重算', async () => {
    const t = createArena();
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, {
        name: '维斯珀',
        player: '丙',
        playerId: 'P1',
        className: '游侠（猎人）',
        level: 5,
        maxHp: 44,
        ac: 16,
        abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 14, cha: 10 },
        weapons: [
          { name: '短剑', damage: '1d6', ability: 'dex' },
          { name: '长弓', damage: '1d8', ability: 'dex', ranged: true },
        ],
        traits: ['巨像屠夫'],
      });
      upsertCharacter(c, {
        name: '地精先锋',
        kind: 'monster',
        maxHp: 50,
        ac: 15,
        abilities: { str: 14, dex: 14, con: 12, int: 8, wis: 10, cha: 8 },
        room: c.currentRoom,
      });
      c.characters = c.characters.filter((x) => x.name === '维斯珀' || x.name === '地精先锋');
    });

    t.rolls.push(20, 10);
    await t.call('dnd_initiative', { action: 'start', participants: ['维斯珀', '地精先锋'] });
    await t.call('dnd_position', { action: 'terrain', width: 10, height: 10, areas: [] });
    await t.call('dnd_position', {
      action: 'set',
      placements: [{ name: '维斯珀', x: 2, y: 2 }, { name: '地精先锋', x: 3, y: 2 }],
    });

    // 1) 满血时连击两刀：第1击不触发巨兽杀手（且绝不泄露 50/50 HP），第2击目标已受损自动加 1d8！
    // 第1击：d20=15 -> 21 命中，短剑 1d6=4 (+3=7 -> HP 43/50)
    // 第2击：d20=15 -> 21 命中，短剑 1d6=3 (+3=6)，巨兽杀手 1d8=7 -> 共 13 伤（HP 30/50）
    t.rolls.push(15, 4, 15, 3, 7);
    const batchOut = await t.call('dnd_check', {
      type: 'attack',
      character: '维斯珀',
      target: '地精先锋',
      weapon: '短剑',
      damage_type: '穿刺',
      declared_by: 'P1',
      attacks: [{}, {}],
    });
    expect(batchOut).toContain('【第 1/2 击】');
    expect(batchOut).toContain('【条件被动】「巨兽杀手」未触发（本击前目标尚属毫发无伤；若受伤后再次命中将自动结算）');
    expect(batchOut).not.toContain('50/50');
    expect(batchOut).toContain('【第 2/2 击】');
    expect(batchOut).toContain('附伤「巨兽杀手」1d8[7] = 7 穿刺');
    expect(t.ch('地精先锋').hp).toBe(30);

    // 2) 同回合第3击（动作如潮）：oncePerTurn 已用过，不再触发巨兽杀手
    t.rolls.push(15, 2); // 短剑 2+3=5 -> HP 25/50
    const hit3 = await t.call('dnd_check', {
      type: 'attack',
      character: '维斯珀',
      target: '地精先锋',
      weapon: '短剑',
      damage_type: '穿刺',
      declared_by: 'P1',
    });
    expect(hit3).not.toContain('巨兽杀手');
    expect(t.ch('地精先锋').hp).toBe(25);

    // 3) 推到敌人回合，地精先锋离开触及触发借机攻击：目标未满血，在敌人回合也能触发一次巨兽杀手！
    await t.call('dnd_initiative', { action: 'next', declared_by: 'P1' });
    const oaCollect = collectHitRiders(t.campaign(), t.ch('维斯珀'), t.ch('地精先锋'), {
      weapon: t.ch('维斯珀').weapons![0],
      ability: 'dex',
    });
    expect(oaCollect.riders.map((r) => r.label)).toEqual(['巨兽杀手']);

    // 真实走一遍移动借机授权与结算，确认 oncePerTurn 记录落在新回合且同回合不会二次触发
    const oaPause = await t.call('dnd_position', { action: 'move', name: '地精先锋', x: 6, y: 2 });
    expect(oaPause).toContain('维斯珀·借机攻击');
    const auth = t.service.store.update(t.key, (c) => {
      const m = c.initiative!.movement!;
      m.claimed.push({ character: '维斯珀', reaction: '借机攻击', authorization: 'auth-oa-1' });
      return 'auth-oa-1';
    }, '玩家点击借机');
    t.rolls.push(15, 4, 6); // d20=15 命中，短剑 4+3=7，巨兽杀手 1d8=6 => 13 伤（HP 25->12）
    const oaHit = await t.call('dnd_check', {
      type: 'attack',
      character: '维斯珀',
      target: '地精先锋',
      weapon: '短剑',
      damage_type: '穿刺',
      reaction: true,
      authorization: auth,
    });
    expect(oaHit).toContain('附伤「巨兽杀手」1d8[6] = 6 穿刺');
    expect(t.ch('地精先锋').hp).toBe(12);
    // 同一敌人回合内再次检测，oncePerTurn 阻止再次触发
    const oaSecond = collectHitRiders(t.campaign(), t.ch('维斯珀'), t.ch('地精先锋'), {
      weapon: t.ch('维斯珀').weapons![0],
      ability: 'dex',
    });
    expect(oaSecond.riders).toEqual([]);

    // 4) 多来源卡面识别与防重算
    const c = t.campaign();
    const tgt = t.ch('地精先锋');
    // 4a) 带后缀括号的 trait 名
    upsertCharacter(c, { name: '测试A', className: '游侠', level: 5, traits: ['巨兽杀手（每回合一次+1d8）'], weapons: [{ name: '短弓', damage: '1d6', ability: 'dex', ranged: true }] });
    expect(collectHitRiders(c, requireCharacter(c, '测试A'), tgt, { weapon: requireCharacter(c, '测试A').weapons![0], ability: 'dex', isRanged: true }).riders.map((r) => r.label)).toContain('巨兽杀手');
    // 4b) spells kind=feature action=passive
    upsertCharacter(c, { name: '测试B', className: '游侠', level: 5, spells: [{ name: '巨兽杀手', level: 0, kind: 'feature', action: 'passive' }], weapons: [{ name: '短弓', damage: '1d6', ability: 'dex', ranged: true }] });
    expect(collectHitRiders(c, requireCharacter(c, '测试B'), tgt, { weapon: requireCharacter(c, '测试B').weapons![0], ability: 'dex', isRanged: true }).riders.map((r) => r.label)).toContain('巨兽杀手');
    // 4c) 肯定式 notes fallback vs 否定式 notes
    upsertCharacter(c, { name: '测试C', className: '游侠(猎人)', level: 5, notes: '游侠(猎人)5级，巨兽杀手：命中未满血目标额外1d8', weapons: [{ name: '短弓', damage: '1d6', ability: 'dex', ranged: true }] });
    expect(collectHitRiders(c, requireCharacter(c, '测试C'), tgt, { weapon: requireCharacter(c, '测试C').weapons![0], ability: 'dex', isRanged: true }).riders.map((r) => r.label)).toContain('巨兽杀手');
    upsertCharacter(c, { name: '测试D', className: '游侠(猎人)', level: 5, notes: '游侠(猎人)5级，未选巨兽杀手，改选破阵者', weapons: [{ name: '短弓', damage: '1d6', ability: 'dex', ranged: true }] });
    expect(collectHitRiders(c, requireCharacter(c, '测试D'), tgt, { weapon: requireCharacter(c, '测试D').weapons![0], ability: 'dex', isRanged: true }).riders.map((r) => r.label)).not.toContain('巨兽杀手');

    // 4d) 复合 explicit damage ("1d6+1d8") 同时为「猎人印记」和「巨兽杀手」去重
    upsertActiveState(c, tgt, { name: '猎人印记', source: '测试A', concentration: true, roundsLeft: 600 });
    const dedup = collectHitRiders(c, requireCharacter(c, '测试A'), tgt, {
      weapon: requireCharacter(c, '测试A').weapons![0],
      ability: 'dex',
      isRanged: true,
      explicitExtraDamage: '1d6+1d8',
    });
    expect(dedup.riders).toEqual([]);
    expect(dedup.skippedNotes).toHaveLength(2);
  });

  it('偷袭：兼职折算游荡者等级、盟友贴身/无劣势/灵巧远程校验、未摆位提醒与备注误识别防御', async () => {
    const t = createArena();
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, {
        name: '影刃',
        player: '丁',
        playerId: 'P1',
        className: '游侠 5 / 游荡者 3',
        level: 8,
        maxHp: 56,
        ac: 16,
        abilities: { str: 10, dex: 18, con: 14, int: 12, wis: 14, cha: 10 },
        weapons: [
          { name: '细剑', damage: '1d8', ability: 'dex' },
          { name: '硬头锤', damage: '1d6', ability: 'str' },
        ],
        traits: ['偷袭'],
      });
      upsertCharacter(c, {
        name: '无关战士',
        className: '战士',
        level: 5,
        notes: '曾在黑水镇被哥布林偷袭过',
        weapons: [{ name: '细剑', damage: '1d8', ability: 'dex' }],
      });
    });

    await t.startCombat();
    t.service.store.update(t.key, (c) => {
      const order = c.initiative!.order;
      c.initiative!.turn = order.findIndex((e) => e.name === '卡厄斯');
      c.initiative!.positions!['卡厄斯'] = { x: 2, y: 2, room: c.currentRoom };
      c.initiative!.positions!['地精首领'] = { x: 3, y: 2, room: c.currentRoom };
      c.initiative!.positions!['影刃'] = { x: 5, y: 2, room: c.currentRoom };
    });
    await t.call('dnd_initiative', { action: 'join', participants: ['影刃'] });

    const c = t.campaign();
    const rogue = requireCharacter(c, '影刃');
    const goblin = requireCharacter(c, '地精首领');

    // 1) 卡厄斯站在地精首领 5 尺内，无优势命中即按游荡者 3 级 -> 2d6（而非总等级 8 级的 4d6！）
    const sneakWithAlly = collectHitRiders(c, rogue, goblin, {
      weapon: rogue.weapons![0],
      ability: 'dex',
      effectiveAdvantage: 'none',
    });
    expect(sneakWithAlly.riders).toEqual([
      { label: '偷袭', expression: '2d6', damageType: '物理', oncePerTurnRule: '偷袭' },
    ]);

    // 2) 具劣势时不触发偷袭；使用非灵巧近战硬头锤时不触发偷袭
    expect(collectHitRiders(c, rogue, goblin, {
      weapon: rogue.weapons![0],
      ability: 'dex',
      effectiveAdvantage: 'disadvantage',
    }).riders).toEqual([]);
    expect(collectHitRiders(c, rogue, goblin, {
      weapon: rogue.weapons![1],
      ability: 'str',
      effectiveAdvantage: 'advantage',
    }).riders).toEqual([]);

    // 3) 非游荡者备注含「被哥布林偷袭过」绝不误触发偷袭
    const nonRogue = requireCharacter(c, '无关战士');
    expect(collectHitRiders(c, nonRogue, goblin, {
      weapon: nonRogue.weapons![0],
      ability: 'dex',
      effectiveAdvantage: 'advantage',
    }).riders).toEqual([]);

    // 4) 未摆战位且无优势时，给出不自动触发的提醒
    t.service.store.update(t.key, (camp) => {
      delete camp.initiative!.positions;
    });
    const unplaced = collectHitRiders(t.campaign(), rogue, goblin, {
      weapon: rogue.weapons![0],
      ability: 'dex',
      effectiveAdvantage: 'none',
    });
    expect(unplaced.riders).toEqual([]);
    expect(unplaced.conditionalNotes[0]).toContain('当前未摆战位');
  });

  it('凶蛮攻击：重击多1颗武器骰不二次翻倍，支持挂起攻击重掷后改重击结算', async () => {
    const t = createArena();
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, {
        name: '半兽人',
        player: '戊',
        playerId: 'P1',
        className: '战士',
        level: 5,
        maxHp: 50,
        ac: 16,
        abilities: { str: 18, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, // str_mod = +4
        weapons: [{ name: '巨斧', damage: '1d12', ability: 'str', twoHanded: true }],
        traits: ['凶蛮攻击'],
      });
      upsertCharacter(c, {
        name: '沙包王',
        kind: 'monster',
        maxHp: 120,
        ac: 14,
        abilities: { str: 14, dex: 10, con: 14, int: 8, wis: 10, cha: 8 },
        room: c.currentRoom,
      });
      c.characters = c.characters.filter((x) => x.name === '半兽人' || x.name === '沙包王');
    });

    t.rolls.push(20, 5);
    await t.call('dnd_initiative', { action: 'start', participants: ['半兽人', '沙包王'] });

    // 1) 普通命中：不触发凶蛮攻击（d20=12+7=19 vs 14 命中，巨斧 1d12=7 + 4 = 11）
    t.rolls.push(12, 7);
    const normalHit = await t.call('dnd_check', {
      type: 'attack',
      character: '半兽人',
      target: '沙包王',
      weapon: '巨斧',
      damage_type: '挥砍',
      declared_by: 'P1',
    });
    expect(normalHit).not.toContain('凶蛮攻击');
    expect(t.ch('沙包王').hp).toBe(109);

    // 2) 直接天然 20 重击：巨斧翻倍 2d12[8,9]+4 = 21 + 凶蛮攻击 1d12[10]（不翻倍！）= 31 伤（109 -> 78）
    t.rolls.push(20, 8, 9, 10);
    const directCrit = await t.call('dnd_check', {
      type: 'attack',
      character: '半兽人',
      target: '沙包王',
      weapon: '巨斧',
      damage_type: '挥砍',
      declared_by: 'P1',
    });
    expect(directCrit).toContain('附伤「凶蛮攻击」1d12[10] = 10 挥砍');
    expect(t.ch('沙包王').hp).toBe(78);

    // 3) 挂起普通命中 -> 重掷 d20 变成天然 20 重击，落账时补触发 1d12！
    t.rolls.push(14, 5);
    const held = await t.call('dnd_check', {
      type: 'attack',
      character: '半兽人',
      target: '沙包王',
      weapon: '巨斧',
      damage_type: '挥砍',
      hold: true,
      declared_by: 'P1',
    });
    expect(held).not.toContain('凶蛮攻击');
    t.service.store.update(t.key, (c) => {
      c.initiative!.pending!.reactors.push({ character: '半兽人', reaction: '重掷', manual: true });
      c.initiative!.pending!.claimed.push({ character: '半兽人', reaction: '重掷', authorization: 'auth-reroll-crit' });
    });
    // 重掷出 nat 20 -> 巨斧 2d12[6,7]+4=17 + 凶蛮攻击 1d12[11] = 28（78 -> 50）
    t.rolls.push(20, 6, 7, 11);
    const settledCrit = await t.call('dnd_apply', {
      target: '沙包王',
      reaction: { by: '半兽人', name: '重掷', reroll: 'd20', authorization: 'auth-reroll-crit' },
      settle: true,
    });
    expect(settledCrit).toContain('附伤「凶蛮攻击」1d12[11] = 11 挥砍');
    expect(t.ch('沙包王').hp).toBe(50);

    // 4) 反向：挂起天然 20 重击 -> 重掷跌回普通命中（d20=15），不结算凶蛮攻击
    t.service.store.update(t.key, (c) => {
      delete c.initiative!.reacted; // 恢复测试用反应次数
    });
    t.rolls.push(20, 9, 10, 12);
    const heldCrit = await t.call('dnd_check', {
      type: 'attack',
      character: '半兽人',
      target: '沙包王',
      weapon: '巨斧',
      damage_type: '挥砍',
      hold: true,
      declared_by: 'P1',
    });
    expect(heldCrit).toContain('凶蛮攻击');
    t.service.store.update(t.key, (c) => {
      c.initiative!.pending!.reactors.push({ character: '半兽人', reaction: '重掷', manual: true });
      c.initiative!.pending!.claimed.push({ character: '半兽人', reaction: '重掷', authorization: 'auth-reroll-down' });
    });
    t.rolls.push(15, 6); // 普通命中 d20=15, 1d12=6 + 4 = 10（50 -> 40）
    const settledDown = await t.call('dnd_apply', {
      target: '沙包王',
      reaction: { by: '半兽人', name: '重掷', reroll: 'd20', authorization: 'auth-reroll-down' },
      settle: true,
    });
    expect(settledDown).not.toContain('凶蛮攻击');
    expect(t.ch('沙包王').hp).toBe(40);
  });

  it('神圣狂怒/精通至圣斩/祝福打击/精通重击/战地施法者/集群战术/血腥狂乱、dnd_rule 条件钩子与未注册被动提醒', async () => {
    const t = createArena();
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, {
        name: '狂热者',
        player: '已',
        playerId: 'P1',
        className: '野蛮人 6 / 战士 2',
        level: 8,
        maxHp: 80,
        ac: 16,
        abilities: { str: 18, dex: 12, con: 16, int: 8, wis: 10, cha: 10 },
        weapons: [{ name: '巨剑', damage: '2d6', ability: 'str', twoHanded: true }],
        traits: ['神圣狂怒', '精通重击'],
      });
      upsertCharacter(c, {
        name: '大牧师',
        player: '庚',
        playerId: 'P2',
        className: '圣武士 11 / 牧师 8',
        level: 19,
        maxHp: 120,
        ac: 18,
        abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 18, cha: 16 },
        weapons: [
          { name: '战锤', damage: '1d8', ability: 'str' },
          { name: '重弩', damage: '1d10', ability: 'dex', ranged: true },
        ],
        traits: ['精通至圣斩', '祝福打击', '战地施法者'],
      });
      upsertCharacter(c, {
        name: '屠龙客',
        player: '辛',
        playerId: 'P1',
        className: '战士',
        level: 5,
        maxHp: 45,
        abilities: { str: 18, dex: 10, con: 14, int: 10, wis: 10, cha: 10 },
        weapons: [{ name: '长剑', damage: '1d8', ability: 'str' }],
        traits: ['屠龙猛击', '黑暗视觉'],
      });
    });

    await t.startCombat();
    t.service.store.update(t.key, (c) => {
      c.initiative!.positions!['卡厄斯'] = { x: 2, y: 2, room: c.currentRoom };
      c.initiative!.positions!['地精首领'] = { x: 3, y: 2, room: c.currentRoom };
      c.initiative!.positions!['食人魔'] = { x: 6, y: 6, room: c.currentRoom };
    });
    await t.call('dnd_initiative', { action: 'join', participants: ['狂热者', '大牧师', '屠龙客'] });

    // 1) 神圣狂怒：未狂暴不触发；狂暴期间自己回合触发 1d6+floor(6/2)=1d6+3 光耀；非自己回合不触发；精通重击 19 即重击
    t.service.store.update(t.key, (c) => {
      c.initiative!.turn = c.initiative!.order.findIndex((e) => e.name === '狂热者');
    });
    expect(collectHitRiders(t.campaign(), t.ch('狂热者'), t.ch('地精首领'), { weapon: t.ch('狂热者').weapons![0] }).riders).toEqual([]);
    await t.call('dnd_apply', { target: '狂热者', add_conditions: ['狂暴'] });
    expect(collectHitRiders(t.campaign(), t.ch('狂热者'), t.ch('地精首领'), { weapon: t.ch('狂热者').weapons![0] }).riders).toEqual([
      { label: '狂暴', expression: '2', damageType: '物理' },
      { label: '神圣狂怒', expression: '1d6+3', damageType: '光耀', oncePerTurnRule: '神圣狂怒' },
    ]);
    // 19-20 精通重击：nat 19 触发重击翻倍！
    t.rolls.push(19, 3, 4, 3, 4, 5, 2); // d20=19; 巨剑4d6[3,4,3,4]+4=18; 狂暴2; 神圣狂怒2d6[5,2]+3=10 => 共 30 伤（60->30）
    const crit19 = await t.call('dnd_check', {
      type: 'attack',
      character: '狂热者',
      target: '地精首领',
      weapon: '巨剑',
      damage_type: '挥砍',
      declared_by: 'P1',
    });
    expect(crit19).toContain('重击！');
    expect(crit19).toContain('附伤「神圣狂怒」');
    expect(t.ch('地精首领').hp).toBe(30);

    // 切到大牧师回合：狂热者若借机，ownTurnOnly 阻止神圣狂怒；大牧师近战命中触发 精通至圣斩(1d8)+祝福打击(1d8)，第2击只有精通至圣斩，远程只有祝福打击
    t.service.store.update(t.key, (c) => {
      c.initiative!.turn = c.initiative!.order.findIndex((e) => e.name === '大牧师');
    });
    expect(collectHitRiders(t.campaign(), t.ch('狂热者'), t.ch('地精首领'), { weapon: t.ch('狂热者').weapons![0] }).riders.map((r) => r.label)).toEqual(['狂暴']);

    const pal1 = collectHitRiders(t.campaign(), t.ch('大牧师'), t.ch('地精首领'), { weapon: t.ch('大牧师').weapons![0], isRanged: false });
    expect(pal1.riders.map((r) => r.label)).toEqual(['精通至圣斩', '祝福打击']);
    const palRanged = collectHitRiders(t.campaign(), t.ch('大牧师'), t.ch('地精首领'), { weapon: t.ch('大牧师').weapons![1], ability: 'dex', isRanged: true });
    expect(palRanged.riders.map((r) => r.label)).toEqual(['祝福打击']);

    // 战地施法者：体质专注豁免优势，普通体质豁免无优势
    const concSaveMod = computeSaveStateMods(t.ch('大牧师'), 'con', { vsTags: ['concentration'], campaign: t.campaign() });
    expect(concSaveMod.advantage).toBe('advantage');
    expect(concSaveMod.advReasons).toContain('战地施法者(优)');
    const normalConSaveMod = computeSaveStateMods(t.ch('大牧师'), 'con', { vsTags: ['毒素'], campaign: t.campaign() });
    expect(normalConSaveMod.advantage).toBe('none');

    // 2) SRD 狼 Pack Tactics（集群战术）+ Blood Frenzy（血腥狂乱）
    const wolfInput = srdMonsterInput({
      index: 'sahuagin-wolf',
      armor_class: 12,
      hit_points: 20,
      special_abilities: [{ name: 'Pack Tactics' }, { name: 'Blood Frenzy' }],
    });
    expect(wolfInput.traits).toEqual(['集群战术', '血腥狂乱']);
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, { name: '血狼', ...wolfInput, room: c.currentRoom });
      c.initiative!.order.push({ name: '血狼', init: 1 });
      c.initiative!.positions!['血狼'] = { x: 4, y: 2, room: c.currentRoom };
      c.initiative!.positions!['食人魔'] = { x: 4, y: 3, room: c.currentRoom };
      c.initiative!.positions!['地精首领'] = { x: 9, y: 9, room: c.currentRoom }; // 远离食人魔
    });
    const wolf = t.ch('血狼');
    // 卡厄斯(PC) 满血时：食人魔(怪物)不在地精首领旁 -> 集群战术不触发；卡厄斯满血 -> 血腥狂乱不触发
    expect(computeAttackStateMods(t.campaign(), wolf, t.ch('卡厄斯')).advantage).toBe('none');
    // 地精首领移动到卡厄斯旁 5 尺 -> 集群战术触发优势！
    t.service.store.update(t.key, (c) => {
      c.initiative!.positions!['地精首领'] = { x: 3, y: 2, room: c.currentRoom };
    });
    const packAdv = computeAttackStateMods(t.campaign(), wolf, t.ch('卡厄斯'));
    expect(packAdv.advantage).toBe('advantage');
    expect(packAdv.advReasons).toContain('集群战术(优)');
    // 地精首领移开后 -> 集群战术失效；卡厄斯受伤后 -> 血腥狂乱接管优势！
    t.service.store.update(t.key, (c) => {
      c.initiative!.positions!['地精首领'] = { x: 9, y: 9, room: c.currentRoom };
      requireCharacter(c, '卡厄斯').hp = 20;
    });
    const frenzyAdv = computeAttackStateMods(t.campaign(), wolf, t.ch('卡厄斯'));
    expect(frenzyAdv.advantage).toBe('advantage');
    expect(frenzyAdv.advReasons).toContain('血腥狂乱(优)');

    // 3) dnd_rule 热注册自定义条件钩子（target_half_hp / target_conditions / first_round_only）
    await t.call('dnd_rule', {
      action: 'define',
      name: '处决毒刃',
      passive: true,
      hit_rider: {
        damage_dice: '2d4',
        damage_type: '毒素',
        weapon_only: true,
        target_half_hp: true,
        target_conditions: ['中毒'],
        first_round_only: true,
      },
    });
    t.service.store.update(t.key, (c) => {
      c.characters.find((x) => x.name === '屠龙客')!.traits = ['屠龙猛击', '黑暗视觉', '处决毒刃'];
      c.initiative!.round = 1;
      c.initiative!.turn = c.initiative!.order.findIndex((e) => e.name === '屠龙客');
    });
    // 地精首领当前 30/60 (半血!)，先未中毒 -> 不触发；加上中毒后在 Round 1 自动触发 2d4 毒素
    expect(collectHitRiders(t.campaign(), t.ch('屠龙客'), t.ch('地精首领'), { weapon: t.ch('屠龙客').weapons![0] }).riders).toEqual([]);
    await t.call('dnd_apply', { target: '地精首领', add_conditions: ['中毒'] });
    expect(collectHitRiders(t.campaign(), t.ch('屠龙客'), t.ch('地精首领'), { weapon: t.ch('屠龙客').weapons![0] }).riders.map((r) => r.label)).toContain('处决毒刃');

    // 4) 未注册战斗被动提醒：命中时提醒「屠龙猛击」，绝不把「黑暗视觉」误报进提醒！
    expect(unhandledCombatPassives(t.ch('屠龙客'), t.campaign())).toEqual(['屠龙猛击']);
    t.rolls.push(15, 5, 3, 2); // 命中，长剑 5+4=9，处决毒刃 2d4[3,2]=5
    const hitRemind = await t.call('dnd_check', {
      type: 'attack',
      character: '屠龙客',
      target: '地精首领',
      weapon: '长剑',
      damage_type: '挥砍',
      declared_by: 'P1',
    });
    expect(hitRemind).toContain('【未注册被动提醒】屠龙客 有未入引擎的战斗被动：屠龙猛击');
    expect(hitRemind).not.toContain('黑暗视觉');
  });
});
