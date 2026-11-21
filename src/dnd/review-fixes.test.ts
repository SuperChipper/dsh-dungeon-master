import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { InlineKeyboard, InteractionEvent, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { Roller } from './dice.ts';
import {
  CampaignStore,
  applyDamage,
  changeCondition,
  combatants,
  createCampaign,
  findCharacter,
  isAbsent,
  joinInitiative,
  moveParty,
  partyPositions,
  playerStatus,
  requireCharacter,
  rest,
  roomOf,
  setResource,
  startInitiative,
  summarize,
  summarizeCombat,
  upsertCharacter,
  useResource,
  woundLabel,
} from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { partySizeHint, registerDndTools, srdMonsterInput } from './dnd-tools.ts';
import { ACK, DndTurnButtons, buildTurnKeyboard } from './turn-buttons.ts';
import { combatPartyContext } from './combat-context.ts';
import { addHook, hookPromptLines, matchHooks } from './hooks.ts';
import { eligibleReactors } from './pending-attack.ts';
import { SUNKEN_BELL } from './dungeons/sunken-bell.ts';
import { AdventureLibrary, adventureFromDungeon } from './adventure.ts';
import { mergeWithSenders } from '../gateway/middleware-setup.ts';
import { makeSenderLabeler } from '../features/message-format.ts';
import { encodeButtonData } from '../features/button-utils.ts';

const BELL = adventureFromDungeon(SUNKEN_BELL);

function fixed(...values: number[]): Roller {
  let i = 0;
  return () => values[i++ % values.length]!;
}

function trio() {
  const c = createCampaign('group:abc', BELL);
  upsertCharacter(c, { name: '刻德温 Kodwin', player: '玩家甲', playerId: 'P1', abilities: { con: 14 }, maxHp: 10, ac: 18 });
  upsertCharacter(c, { name: '恩佐', player: '玩家乙', playerId: 'P2', abilities: { dex: 16 }, maxHp: 10, ac: 14 });
  upsertCharacter(c, { name: '卡厄斯', player: '玩家丙', playerId: 'P3', abilities: { str: 16 }, maxHp: 12, ac: 16 });
  return c;
}

describe('找角色', () => {
  it('名字的一段也能找到，有歧义时不猜', () => {
    const c = trio();
    expect(findCharacter(c, '刻德温')?.name).toBe('刻德温 Kodwin');
    expect(findCharacter(c, 'kodwin')?.name).toBe('刻德温 Kodwin');
    upsertCharacter(c, { name: '刻德温 Junior' });
    expect(findCharacter(c, '刻德温')).toBeUndefined();
  });
});

describe('分头行动', () => {
  it('who 只移动说了要走的人，其他人留在原地', () => {
    const c = trio();
    moveParty(c, BELL, 'nave');
    const r = moveParty(c, BELL, 'vestry', false, ['恩佐']);
    expect(r.movers).toEqual(['恩佐']);
    expect(c.currentRoom).toBe('nave'); // 两个人还在残殿，主位置不变
    expect(findCharacter(c, '恩佐')?.room).toBe('vestry');
    expect(combatants(c, 'vestry').map((ch) => ch.name)).toContain('恩佐');
    expect(combatants(c, 'vestry').map((ch) => ch.name)).not.toContain('卡厄斯');
    expect(combatants(c).map((ch) => ch.name)).not.toContain('恩佐');
  });

  it('不同房间的人不能一起移动；战斗中只能移动当前回合的角色', () => {
    const c = trio();
    moveParty(c, BELL, 'nave');
    moveParty(c, BELL, 'vestry', false, ['恩佐']);
    expect(() => moveParty(c, BELL, 'bellshaft', false, ['恩佐', '卡厄斯'])).toThrow(/不同房间/);

    startInitiative(c, fixed(10), ['卡厄斯', '刻德温 Kodwin']);
    const current = c.initiative!.order[0]!.name;
    const other = current === '卡厄斯' ? '刻德温 Kodwin' : '卡厄斯';
    expect(() => moveParty(c, BELL, 'bellshaft')).toThrow(/战斗中不能整队移动/);
    expect(() => moveParty(c, BELL, 'bellshaft', false, [other])).toThrow(/当前回合/);
    expect(() => moveParty(c, BELL, 'bellshaft', false, [current])).not.toThrow();
  });

  it('先攻默认只拉在场的人，room 可以指定打架的房间', () => {
    const c = trio();
    moveParty(c, BELL, 'nave');
    moveParty(c, BELL, 'vestry', false, ['恩佐']);
    const rolls = startInitiative(c, fixed(10), undefined, 'vestry');
    const names = rolls.map((r) => r.name);
    expect(names).toContain('恩佐');
    expect(names.some((n) => n.startsWith('地精'))).toBe(true);
    expect(names).not.toContain('卡厄斯');
  });
});

describe('怪物特性与伤势', () => {
  function zombie(c: ReturnType<typeof trio>) {
    upsertCharacter(c, { name: '溺尸', kind: 'monster', maxHp: 22, abilities: { con: 16 }, traits: ['不死坚韧'] });
  }

  it('不死坚韧：普通伤害打到 0 时豁免成功留 1 HP；光耀和重击直接死', () => {
    const c = trio();
    zombie(c);
    applyDamage(c, '溺尸', 15);
    const saved = applyDamage(c, '溺尸', 7, { roller: fixed(20) }); // DC 5+7=12，d20 20 + 体质 3
    expect(saved.after).toBe(1);
    expect(saved.events.join()).toMatch(/不死坚韧.* 成功，撑住了$/);
    // 伤害太高时 DC 也高：一下 30 点就是 DC 35，必然失败
    const c3 = trio();
    zombie(c3);
    expect(applyDamage(c3, '溺尸', 30, { roller: fixed(20) }).after).toBe(0);

    const radiant = applyDamage(c, '溺尸', 12, { damageType: '光耀', roller: fixed(20) });
    expect(radiant.after).toBe(0);
    expect(findCharacter(c, '溺尸')?.conditions).toContain('死亡');

    const c2 = trio();
    zombie(c2);
    expect(applyDamage(c2, '溺尸', 30, { crit: true, roller: fixed(20) }).after).toBe(0);
  });

  it('不能手动删「死亡」，死了也不能再挨打', () => {
    const c = trio();
    upsertCharacter(c, { name: '巨鼠', kind: 'monster', maxHp: 7 });
    applyDamage(c, '巨鼠', 10);
    expect(() => changeCondition(c, '巨鼠', '死亡', false)).toThrow(/dnd_undo/);
    expect(() => applyDamage(c, '巨鼠', 1)).toThrow(/已经死亡/);
  });

  it('怪物只给伤势词，玩家视角的团况里没有怪物血量', () => {
    const c = trio();
    upsertCharacter(c, { name: '地精', kind: 'monster', maxHp: 7, room: c.currentRoom });
    const change = applyDamage(c, '地精', 6);
    expect(change.wound).toBe('摇摇欲坠');
    expect(woundLabel(findCharacter(c, '地精')!)).toBe('摇摇欲坠');
    const view = playerStatus(c, BELL);
    expect(view).toContain('地精（摇摇欲坠）');
    expect(view).not.toMatch(/地精\s*\d+\/7/);
  });

  it('SRD 怪物数据转成角色卡字段', () => {
    const input = srdMonsterInput({
      index: 'zombie', armor_class: [{ value: 8 }], hit_points: 22,
      strength: 13, dexterity: 6, constitution: 16, intelligence: 3, wisdom: 6, charisma: 5,
      actions: [{ name: 'Slam', attack_bonus: 3, damage: [{ damage_dice: '1d6 + 1' }] }],
      special_abilities: [{ name: 'Undead Fortitude' }],
    });
    expect(input).toMatchObject({ kind: 'monster', ac: 8, maxHp: 22, attackBonus: 3, damage: '1d6+1', traits: ['不死坚韧'] });
    expect(input.abilities?.con).toBe(16);
  });

  it('多用途武器的二选一伤害取第一个选项', () => {
    const input = srdMonsterInput({
      index: 'hobgoblin', armor_class: [{ value: 18 }], hit_points: 11,
      actions: [{
        name: 'Longsword', attack_bonus: 3,
        damage: [{ choose: 1, from: { options: [{ damage_dice: '1d8+1' }, { damage_dice: '1d10+1' }] } }],
      }],
    });
    expect(input.damage).toBe('1d8+1');
  });
});

describe('资源与休息', () => {
  it('资源不够时拒绝，长休回满', () => {
    const c = trio();
    setResource(c, '刻德温', '1环法术位', 2, 'long');
    useResource(c, '刻德温', '1环法术位');
    useResource(c, '刻德温', '法术位');
    expect(() => useResource(c, '刻德温', '1环法术位')).toThrow(/只剩 0/);
    rest(c, 'long');
    expect(findCharacter(c, '刻德温')?.resources?.['1环法术位']?.current).toBe(2);
  });

  it('短休花生命骰由工具掷骰回血，用完不能再花', () => {
    const c = trio();
    upsertCharacter(c, { name: '刻德温 Kodwin', hitDie: 'd8' });
    applyDamage(c, '刻德温', 8);
    const [result] = rest(c, 'short', ['刻德温'], { 刻德温: 1 }, fixed(5));
    expect(result!.lines.join()).toMatch(/d8\[5\]\+2 = 7/);
    expect(findCharacter(c, '刻德温')?.hp).toBe(9);
    expect(() => rest(c, 'short', ['刻德温'], { 刻德温: 1 }, fixed(5))).toThrow(/只剩 0/);
  });

  it('战斗中不能休息', () => {
    const c = trio();
    startInitiative(c, fixed(10));
    expect(() => rest(c, 'short')).toThrow(/战斗中/);
  });
});

describe('合并消息保留发送者', () => {
  function ctx(senderId: string, senderName: string, content: string): MiddlewareContext {
    return { message: { senderId, senderName, content }, state: {} } as unknown as MiddlewareContext;
  }
  const label = makeSenderLabeler((id) => (id === 'A' ? 'U1' : 'U2'));

  it('多人合并时每行都带自己的昵称和群内别名，第一个人的后续行不会被算到别人头上', () => {
    const merged = mergeWithSenders([ctx('A', '玩家丁', '躲到暗处'), ctx('B', '玩家乙', '跟上去'), ctx('A', '玩家丁', '再看看')], label);
    expect(merged.message.content).toBe('[玩家丁 #U1] 躲到暗处\n[玩家乙 #U2] 跟上去\n[玩家丁 #U1] 再看看');
    expect(merged.state.mergedSenders).toEqual(['A', 'B']);
    expect(merged.state.senderTagged).toBe(true);
  });

  it('(@you) 只跟在真的 @ 了 bot 的那一行后面', () => {
    const b = ctx('B', '玩家乙', '跟上去');
    b.state.mention = { wasMentioned: true };
    const merged = mergeWithSenders([ctx('A', '玩家丁', '笑死'), b], label);
    expect(merged.message.content).toBe('[玩家丁 #U1] 笑死\n[玩家乙 #U2] 跟上去 (@you)');
  });

  it('同一个人连发几条时不加行标签，交给入站组装整体加', () => {
    const merged = mergeWithSenders([ctx('A', '玩家丁', '一'), ctx('A', '玩家丁', '二')], label);
    expect(merged.message.content).toBe('一\n二');
    expect(merged.state.senderTagged).toBeUndefined();
  });
});

describe('回合按钮', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'dnd-buttons-'));
    const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
    const key = 'group:G1';
    service.start(key, 'sunken-bell', false);
    service.store.update(key, (c) => {
      upsertCharacter(c, { name: '卡厄斯', player: '玩家丙', playerId: 'P3', maxHp: 12 });
      upsertCharacter(c, { name: '巨鼠', kind: 'monster', maxHp: 7, room: c.currentRoom });
      c.initiative = { round: 2, turn: 0, order: [{ name: '卡厄斯', init: 18 }, { name: '巨鼠', init: 10 }] };
    });
    const followup = vi.fn();
    const record = { sessionKey: key, scope: 'group', replyTarget: { scope: 'group', targetId: 'G1' }, agent: { followup, whenIdle: () => Promise.resolve() } };
    const manager = { sessionKey: (_s: string, gid: string) => `group:${gid}`, getSessionRecord: () => record };
    const sender = { sendMarkdown: vi.fn(() => Promise.resolve()) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const buttons = new DndTurnButtons(service, manager as never, sender, logger as never);
    return { service, key, buttons, followup, sender };
  }

  function click(data: object, clicker: string): InteractionEvent {
    return {
      id: 'e1', type: 11, version: 1, group_openid: 'G1', group_member_openid: clicker,
      data: { type: 11, resolved: { button_data: encodeButtonData(data as never) } },
    };
  }

  it('结束回合只有本人点才推进，并通知 DM 接着结算', () => {
    const { service, key, buttons, followup } = setup();
    expect(buttons.handleInteraction(click({ t: 'dnd', a: 'end', n: '卡厄斯', r: 2 }, 'P1'))).toBe(ACK.denied);
    expect(service.store.load(key)?.initiative?.turn).toBe(0);

    expect(buttons.handleInteraction(click({ t: 'dnd', a: 'end', n: '卡厄斯', r: 2 }, 'P3'))).toBe(ACK.ok);
    expect(service.store.load(key)?.initiative?.turn).toBe(1);
    expect(followup).toHaveBeenCalledTimes(1);

    // 同一个按钮再点一次：回合已经过了
    expect(buttons.handleInteraction(click({ t: 'dnd', a: 'end', n: '卡厄斯', r: 2 }, 'P3'))).toBe(ACK.duplicate);
  });

  it('查看状态直接回玩家视角团况，不是跑团按钮时交给别的通道', () => {
    const { buttons, sender } = setup();
    expect(buttons.handleInteraction(click({ t: 'dnd', a: 'status' }, 'P1'))).toBe(ACK.ok);
    expect(sender.sendMarkdown).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('▶卡厄斯'));
    expect(buttons.handleInteraction(click({ t: 'approval', d: 'allow' }, 'P1'))).toBeUndefined();
  });

  it('按钮上带角色名和轮次', () => {
    const kb = buildTurnKeyboard('卡厄斯', 3);
    const end = kb.content.rows[0]!.buttons[0]!;
    expect(JSON.parse(end.action.data)).toEqual({ t: 'dnd', a: 'end', n: '卡厄斯', r: 3 });
  });
});

describe('开团签到', () => {
  const TARGET = { scope: 'group' as const, targetId: 'G1', msgId: 'M1' };

  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'dnd-checkin-'));
    const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
    const key = 'group:G1';
    service.start(key, 'sunken-bell', false);
    service.store.update(key, (c) => {
      upsertCharacter(c, { name: '卡厄斯', player: '玩家丙', playerId: 'P3' });
      upsertCharacter(c, { name: '恩佐', player: '玩家丁', playerId: 'P4' });
      upsertCharacter(c, { name: '路人', kind: 'pc' });
    });
    const followup = vi.fn();
    const record = { sessionKey: key, scope: 'group', replyTarget: { scope: 'group', targetId: 'G1' }, agent: { followup, whenIdle: () => Promise.resolve() } };
    const manager = { sessionKey: (_s: string, gid: string) => `group:${gid}`, getSessionRecord: () => record };
    const sender = { sendMarkdown: vi.fn((..._args: unknown[]) => Promise.resolve()) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const buttons = new DndTurnButtons(service, manager as never, sender, logger as never);
    const press = (a: 'in' | 'go' | 'roster', clicker: string): number | undefined => buttons.handleInteraction({
      id: 'e1', type: 11, version: 1, group_openid: 'G1', group_member_openid: clicker,
      data: { type: 11, resolved: { button_data: encodeButtonData({ t: 'dnd', a }) } },
    });
    const kickoffText = (): string => followup.mock.calls[0]![0].content[0].text as string;
    return { service, key, buttons, sender, followup, press, kickoffText };
  }

  it('开团回复本身带名单和签到/开始/名单按钮，只发一条，回复到 /dnd 那条消息', async () => {
    const { buttons, key, sender } = setup();
    expect(await buttons.openCheckIn(key, TARGET, '🎲 开团：沉钟修道院', true)).toBe(true);
    expect(sender.sendMarkdown).toHaveBeenCalledTimes(1);
    const [target, text, opts] = sender.sendMarkdown.mock.calls[0]! as [unknown, string, { keyboard: InlineKeyboard }];
    expect(target).toEqual(TARGET);
    expect(text).toContain('🎲 开团：沉钟修道院');
    expect(text).toContain('签到 0/2');
    expect(text).toContain('路人 没绑定玩家');
    expect(text).toContain('人齐了自动开场');
    expect(opts.keyboard.content.rows[0]!.buttons.map((b) => JSON.parse(b.action.data).a)).toEqual(['in', 'go', 'roster']);
  });

  it('签到后群里攒几秒发一行提醒，连着签到的合成一条', async () => {
    vi.useFakeTimers();
    try {
      const { buttons, key, sender, press } = setup();
      await buttons.openCheckIn(key, TARGET, '', true);
      sender.sendMarkdown.mockClear();

      press('in', 'P3');
      press('in', 'NEW');
      expect(sender.sendMarkdown).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4000);
      expect(sender.sendMarkdown).toHaveBeenCalledTimes(1);
      const [target, text, opts] = sender.sendMarkdown.mock.calls[0]! as [unknown, string, unknown];
      expect(target).toEqual({ scope: 'group', targetId: 'G1' });
      expect(text).toBe('✅ 卡厄斯 到了；1 位还没角色卡的玩家到了（@我说名字和职业建卡） · 1/2，还差 恩佐');
      expect(opts).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('签到凑齐触发开场时不发提醒，攒着的也取消', async () => {
    vi.useFakeTimers();
    try {
      const { buttons, key, sender, followup, press } = setup();
      await buttons.openCheckIn(key, TARGET, '', true);
      sender.sendMarkdown.mockClear();
      press('in', 'P3');
      press('in', 'P4');
      expect(followup).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sender.sendMarkdown).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('人齐了自动开场，只开一次', async () => {
    const { buttons, key, service, sender, followup, press, kickoffText } = setup();
    await buttons.openCheckIn(key, TARGET, '', true);
    sender.sendMarkdown.mockClear();

    expect(press('in', 'P3')).toBe(ACK.ok);
    expect(press('in', 'P3')).toBe(ACK.duplicate);
    expect(press('in', 'NEW')).toBe(ACK.ok);
    expect(followup).not.toHaveBeenCalled();
    // DM 的 prompt 里能看到出勤
    const state = service.stateSnapshot(key);
    expect(state).toContain('本次签到：已到 卡厄斯');
    expect(state).toContain('未签到 恩佐');

    expect(press('in', 'P4')).toBe(ACK.ok);
    expect(followup).toHaveBeenCalledTimes(1);
    expect(kickoffText()).toContain('人到齐了（卡厄斯、恩佐）');
    expect(kickoffText()).toContain('按开场要求叙述');
    // 开场后再有人签到不会再开一次
    expect(press('in', 'LATE')).toBe(ACK.ok);
    expect(followup).toHaveBeenCalledTimes(1);
  });

  it('「开始」不等没到的人，点的人顺带签到；继续的团让 DM 先回顾', async () => {
    const { buttons, key, service, followup, press, kickoffText } = setup();
    service.store.update(key, (c) => { c.begun = true; });
    await buttons.openCheckIn(key, TARGET, '', true);
    expect(press('go', 'P3')).toBe(ACK.ok);
    expect(kickoffText()).toContain('已到：卡厄斯；未到：恩佐');
    expect(kickoffText()).toContain('回顾上次的进度');
    expect(press('go', 'P4')).toBe(ACK.duplicate);
    expect(followup).toHaveBeenCalledTimes(1);
  });

  it('「名单」才在群里发名单，30 秒内重复点不再发', async () => {
    const { buttons, key, sender, press } = setup();
    await buttons.openCheckIn(key, TARGET, '', true);
    sender.sendMarkdown.mockClear();
    press('in', 'P3');
    expect(press('roster', 'P4')).toBe(ACK.ok);
    expect(press('roster', 'P3')).toBe(ACK.duplicate);
    expect(sender.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(sender.sendMarkdown.mock.calls[0]![1]).toContain('未到：恩佐〈玩家丁〉');
  });

  it('checkin（reset=false）保留签到；重新开团清空；结团删掉；按钮发不出去退回文字', async () => {
    const { buttons, key, service, sender, press } = setup();
    await buttons.openCheckIn(key, TARGET, '', true);
    press('in', 'P3');
    await buttons.openCheckIn(key, TARGET, '', false);
    expect(service.checkIns.get(key)?.arrived.has('P3')).toBe(true);
    await buttons.openCheckIn(key, TARGET, '', true);
    expect(service.checkIns.get(key)?.arrived.size).toBe(0);
    service.stop(key);
    expect(service.checkIns.has(key)).toBe(false);

    service.start(key, 'sunken-bell', false);
    sender.sendMarkdown.mockRejectedValueOnce(new Error('no keyboard permission'));
    expect(await buttons.openCheckIn(key, TARGET, '', true)).toBe(false);
    expect(service.checkIns.has(key)).toBe(false);
  });

  it('bot 重启后点旧签到按钮：自动开新表接着签', () => {
    const { service, key, press } = setup();
    expect(service.checkIns.has(key)).toBe(false);
    expect(press('in', 'P3')).toBe(ACK.ok);
    expect(service.checkIns.get(key)?.arrived.has('P3')).toBe(true);
  });

  it('点「开始」时未签到的绑定 PC 暂时移出队伍；已到与未绑定 PC 保留，/dnd end 后全部归队', async () => {
    const { buttons, key, service, press, kickoffText } = setup();
    await buttons.openCheckIn(key, TARGET, '', true);
    expect(press('in', 'P3')).toBe(ACK.ok);
    expect(press('go', 'P3')).toBe(ACK.ok);

    const campaign = service.store.load(key)!;
    expect(isAbsent(requireCharacter(campaign, '恩佐'))).toBe(true);
    expect(isAbsent(requireCharacter(campaign, '卡厄斯'))).toBe(false);
    expect(isAbsent(requireCharacter(campaign, '路人'))).toBe(false);
    expect(kickoffText()).toContain('已暂时移出队伍');
    expect(service.stateSnapshot(key)).toContain('暂离队伍（未签到，不参与探索/战斗）：恩佐');

    service.stop(key);
    expect(isAbsent(requireCharacter(service.store.load(key)!, '恩佐'))).toBe(false);
  });

  it('暂离 PC 全链路隔离：探索、先攻、反应、战斗上下文、团况、人数提示、休息与背景钩子', async () => {
    const { buttons, key, service, press } = setup();
    service.store.update(key, (c) => {
      upsertCharacter(c, { name: '卡厄斯', player: '玩家丙', playerId: 'P3', maxHp: 20, notes: '护盾术' });
      upsertCharacter(c, { name: '恩佐', player: '玩家乙', playerId: 'P4', maxHp: 20, notes: '护盾术' });
      upsertCharacter(c, { name: '小四', player: '玩家戊', playerId: 'P5', maxHp: 18 });
      upsertCharacter(c, { name: '小五', player: '玩家己', playerId: 'P6', maxHp: 18 });
      upsertCharacter(c, { name: '地精1', kind: 'monster', maxHp: 7, room: c.currentRoom });
      addHook(requireCharacter(c, '恩佐'), '在找失踪的姐姐', ['残殿']);
      requireCharacter(c, '恩佐').hp = 5;
      requireCharacter(c, '卡厄斯').hp = 5;
    });
    await buttons.openCheckIn(key, TARGET, '', true);
    press('in', 'P3');
    press('in', 'P5');
    press('in', 'P6');
    press('go', 'P3');

    const { campaign, adventure } = service.require(key);
    expect(isAbsent(requireCharacter(campaign, '恩佐'))).toBe(true);
    expect(roomOf(campaign, requireCharacter(campaign, '恩佐'))).toBeUndefined();
    expect(partyPositions(campaign).get(campaign.currentRoom)?.map((x) => x.name)).not.toContain('恩佐');
    expect(partySizeHint(campaign, adventure)).toBeUndefined(); // 4 个 PC 暂离 1 个（加未绑定路人 4 人 ≤ 默认 4 人）

    // 全队移动不带走暂离 PC，也不会触发其钩子或出口检定；显式移动暂离 PC 报错
    moveParty(campaign, adventure, 'nave');
    expect(requireCharacter(campaign, '恩佐').room).toBeUndefined();
    expect(campaign.currentRoom).toBe('nave');
    expect(() => moveParty(campaign, adventure, 'vestry', false, ['恩佐'])).toThrow(/暂时移出队伍/);

    // 钩子与休息隔离
    expect(matchHooks(campaign, '残殿的石头')).toEqual([]);
    expect(hookPromptLines(campaign)).toEqual([]);
    rest(campaign, 'long');
    expect(requireCharacter(campaign, '卡厄斯').hp).toBe(20);
    expect(requireCharacter(campaign, '恩佐').hp).toBe(5);
    expect(() => rest(campaign, 'long', ['恩佐'])).toThrow(/暂时移出队伍/);

    // 先攻、反应、战斗上下文与团况隔离
    const summaryText = summarize(campaign, adventure);
    expect(summaryText).toContain('暂离队伍');
    expect(playerStatus(campaign, adventure)).toContain('💤 暂离（未签到）：恩佐');

    upsertCharacter(campaign, { name: '伏兵', kind: 'monster', maxHp: 10, room: 'nave' });
    const rolls = startInitiative(campaign, fixed(10));
    expect(rolls.map((r) => r.name)).not.toContain('恩佐');
    expect(() => startInitiative(campaign, fixed(10), ['恩佐'])).toThrow(/暂时移出队伍/);
    expect(() => joinInitiative(campaign, ['恩佐'])).toThrow(/暂时移出队伍/);
    expect(combatPartyContext(campaign)).not.toContain('恩佐');
    expect(summarizeCombat(campaign, adventure)).not.toContain('恩佐');
    const reactors = eligibleReactors(campaign, requireCharacter(campaign, '伏兵'), requireCharacter(campaign, '卡厄斯'), { hit: true, crit: false, natural: 15 });
    expect(reactors.map((r) => r.character)).not.toContain('恩佐');
  });

  it('战斗未完续团后点「开始」：未签到 PC 从先攻、站位与待结算移出，turn 指针不越界', async () => {
    const { buttons, key, service, press } = setup();
    service.store.update(key, (c) => {
      upsertCharacter(c, { name: '地精', kind: 'monster', maxHp: 7, room: c.currentRoom });
      c.initiative = {
        round: 1,
        turn: 2,
        order: [{ name: '卡厄斯', init: 18 }, { name: '地精', init: 12 }, { name: '恩佐', init: 8 }],
        positions: { 卡厄斯: { x: 1, y: 1, room: c.currentRoom }, 恩佐: { x: 2, y: 1, room: c.currentRoom } },
        pending: {
          kind: 'attack', seq: 1, at: 10, attacker: '地精', target: '卡厄斯',
          reactors: [{ character: '恩佐', reaction: '尖刻言语' }],
          declined: [], claimed: [{ character: '恩佐', reaction: '尖刻言语', authorization: 'tok' }], used: [],
          natural: 15, total: 19, rollDetail: 'd20=15+4=19', ac: 16, crit: false, attackMod: 0, acMod: 0, damageMod: 0,
        },
        turnState: { actor: '恩佐', attacks: 0 },
      };
    });
    await buttons.openCheckIn(key, TARGET, '', true);
    press('in', 'P3');
    expect(press('go', 'P3')).toBe(ACK.ok);

    const saved = service.store.load(key)!;
    expect(isAbsent(requireCharacter(saved, '恩佐'))).toBe(true);
    expect(saved.initiative!.order.map((e) => e.name)).toEqual(['卡厄斯', '地精']);
    expect(saved.initiative!.turn).toBe(0);
    expect(saved.initiative!.round).toBe(2);
    expect(saved.initiative!.turnState?.actor).toBe('卡厄斯');
    expect(saved.initiative!.positions?.['恩佐']).toBeUndefined();
    expect(saved.initiative!.pending!.declined).toContain('恩佐');
    expect(saved.initiative!.pending!.claimed).toEqual([]);
  });

  it('晚到玩家开场后点「签到」自动归队并同步当前房间；bot 重启后按团档恢复签到态', async () => {
    const { buttons, key, service, sender, followup, press } = setup();
    await buttons.openCheckIn(key, TARGET, '', true);
    press('in', 'P3');
    press('go', 'P3');
    expect(followup).toHaveBeenCalledTimes(1);

    // 队伍移动到了新房间
    service.store.update(key, (c) => {
      moveParty(c, service.require(key).adventure, 'nave');
    });
    sender.sendMarkdown.mockClear();

    // 模拟 bot 重启：清空内存 checkIns 后重开 DndTurnButtons
    service.checkIns.clear();
    const restartedManager = { sessionKey: (_s: string, gid: string) => `group:${gid}`, getSessionRecord: () => ({ sessionKey: key, scope: 'group', replyTarget: { scope: 'group', targetId: 'G1' }, agent: { followup, whenIdle: () => Promise.resolve() } }) };
    const restartedButtons = new DndTurnButtons(service, restartedManager as never, sender, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never);

    // 重启后点「名单」先恢复 started=true 视图
    expect(restartedButtons.handleInteraction({
      id: 'e-r', type: 11, version: 1, group_openid: 'G1', group_member_openid: 'P3',
      data: { type: 11, resolved: { button_data: encodeButtonData({ t: 'dnd', a: 'roster' }) } },
    })).toBe(ACK.ok);
    expect(service.checkIns.get(key)?.started).toBe(true);
    expect(sender.sendMarkdown).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('💤 暂离（未签到，已移出队伍）：恩佐'));

    // 再次模拟内存空了（或直接点击），恩佐点击「签到」自动归队并同步到 nave，不重开 kickoff
    service.checkIns.clear();
    expect(restartedButtons.handleInteraction({
      id: 'e-in', type: 11, version: 1, group_openid: 'G1', group_member_openid: 'P4',
      data: { type: 11, resolved: { button_data: encodeButtonData({ t: 'dnd', a: 'in' }) } },
    })).toBe(ACK.ok);

    const updated = service.store.load(key)!;
    expect(isAbsent(requireCharacter(updated, '恩佐'))).toBe(false);
    expect(roomOf(updated, requireCharacter(updated, '恩佐'))).toBe('nave');
    expect(requireCharacter(updated, '恩佐').room).toBe('nave');
    expect(followup).toHaveBeenCalledTimes(1);
    expect(sender.sendMarkdown).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('恩佐 签到归队'));
    // 已经归队再点一次签到算重复
    expect(restartedButtons.handleInteraction({
      id: 'e-in-dup', type: 11, version: 1, group_openid: 'G1', group_member_openid: 'P4',
      data: { type: 11, resolved: { button_data: encodeButtonData({ t: 'dnd', a: 'in' }) } },
    })).toBe(ACK.duplicate);
  });

  it('无缓存会话 record（重启后直接 /dnd start 未 @bot）时点名单/签到/开始不再失败', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dnd-norecord-'));
    const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
    const key = 'group:G1';
    service.start(key, 'sunken-bell', false);
    service.store.update(key, (c) => {
      upsertCharacter(c, { name: '卡厄斯', player: '玩家丙', playerId: 'P3' });
      upsertCharacter(c, { name: '恩佐', player: '玩家丁', playerId: 'P4' });
    });
    const followup = vi.fn();
    const createdRecord = { sessionKey: key, scope: 'group' as const, peerId: 'G1', replyTarget: { scope: 'group' as const, targetId: 'G1' }, agent: { followup, whenIdle: () => Promise.resolve() } };
    const getOrCreate = vi.fn(async () => createdRecord);
    const manager = { sessionKey: (_s: string, gid: string) => `group:${gid}`, getSessionRecord: () => undefined, getOrCreate };
    const sender = { sendMarkdown: vi.fn(() => Promise.resolve()) };
    const buttons = new DndTurnButtons(service, manager as never, sender, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never);
    await buttons.openCheckIn(key, TARGET, '', true);
    sender.sendMarkdown.mockClear();

    const press = (a: 'in' | 'go' | 'roster', clicker: string) => buttons.handleInteraction({
      id: `e-${a}-${clicker}`, type: 11, version: 1, group_openid: 'G1', group_member_openid: clicker,
      data: { type: 11, resolved: { button_data: encodeButtonData({ t: 'dnd', a }) } },
    });

    expect(press('roster', 'P3')).toBe(ACK.ok);
    expect(sender.sendMarkdown).toHaveBeenCalledWith({ scope: 'group', targetId: 'G1' }, expect.stringContaining('未到：卡厄斯'));
    expect(press('in', 'P3')).toBe(ACK.ok);
    expect(press('go', 'P3')).toBe(ACK.ok);
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(1));
    expect(getOrCreate).toHaveBeenCalledWith('group', 'G1', 'P3', { scope: 'group', targetId: 'G1' });
    expect(isAbsent(requireCharacter(service.store.load(key)!, '恩佐'))).toBe(true);
  });

  it('dnd_undo 不回滚暂离/归队状态；dnd_character update absent 同步签到表与先攻，停团时拒绝', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dnd-absent-tools-'));
    const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
    const key = 'group:G1';
    service.start(key, 'sunken-bell', false);
    service.store.update(key, (c) => {
      upsertCharacter(c, { name: '卡厄斯', player: '玩家丙', playerId: 'P3', maxHp: 20 });
      upsertCharacter(c, { name: '恩佐', player: '玩家丁', playerId: 'P4', maxHp: 20 });
      upsertCharacter(c, { name: '地精', kind: 'monster', maxHp: 7, room: c.currentRoom });
    });
    const tools = new Map<string, { name: string; execute(args: unknown, exec: unknown): Promise<{ text: string }> }>();
    registerDndTools({ get: () => ({ register: (t: never) => tools.set((t as { name: string }).name, t as never) }) } as never, {
      service,
      manager: { findByAgent: () => ({ sessionKey: key }), sessionKey: () => key } as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      sendImage: vi.fn(),
    });
    const call = async (name: string, args: object) => (await tools.get(name)!.execute(args, { agent: {} })).text;

    const followup = vi.fn();
    const record = { sessionKey: key, scope: 'group', replyTarget: { scope: 'group', targetId: 'G1' }, agent: { followup, whenIdle: () => Promise.resolve() } };
    const buttons = new DndTurnButtons(service, { sessionKey: () => key, getSessionRecord: () => record } as never, { sendMarkdown: vi.fn(() => Promise.resolve()) }, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never);
    await buttons.openCheckIn(key, TARGET, '', true);
    buttons.handleInteraction({ id: 'e1', type: 11, version: 1, group_openid: 'G1', group_member_openid: 'P3', data: { type: 11, resolved: { button_data: encodeButtonData({ t: 'dnd', a: 'in' }) } } });
    buttons.handleInteraction({ id: 'e2', type: 11, version: 1, group_openid: 'G1', group_member_openid: 'P3', data: { type: 11, resolved: { button_data: encodeButtonData({ t: 'dnd', a: 'go' }) } } });

    // 在恩佐暂离期间做一次能进撤销栈的操作（移动或扣血）
    await call('dnd_apply', { target: '卡厄斯', damage: 3 });
    await call('dnd_undo', { action: 'undo', steps: 1 });
    expect(isAbsent(requireCharacter(service.store.load(key)!, '恩佐'))).toBe(true);

    // 之后用 dnd_character 让恩佐归队，并再做一次扣血然后撤销：归队不会被撤回暂离
    const backMsg = await call('dnd_character', { action: 'update', name: '恩佐', absent: false });
    expect(backMsg).toContain('已更新');
    expect(service.checkIns.get(key)?.arrived.has('P4')).toBe(true);
    await call('dnd_apply', { target: '卡厄斯', damage: 2 });
    await call('dnd_undo', { action: 'undo', steps: 1 });
    expect(isAbsent(requireCharacter(service.store.load(key)!, '恩佐'))).toBe(false);

    // 战斗中把卡厄斯设成暂离：同步移出先攻表和签到表
    await call('dnd_initiative', { action: 'start' });
    const leaveMsg = await call('dnd_character', { action: 'update', name: '卡厄斯', absent: true });
    expect(leaveMsg).toContain('已暂时移出队伍并移出先攻表');
    expect(service.store.load(key)!.initiative!.order.map((e) => e.name)).not.toContain('卡厄斯');
    expect(service.checkIns.get(key)?.arrived.has('P3')).toBe(false);

    // 停团后拒绝传 absent
    service.stop(key);
    await expect(call('dnd_character', { action: 'update', name: '卡厄斯', absent: true })).rejects.toThrow('停团时不能设置暂离');
  });
});
