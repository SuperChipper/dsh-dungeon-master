import { chooseReaction } from './pending-attack.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdventureLibrary } from './adventure.ts';
import { CampaignStore, requireCharacter, summarize, upsertCharacter } from './campaign.ts';
import { turnPositionNote } from './battlefield.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { buildReactionKeyboard, DndTurnButtons, ACK, reactionOptionKey } from './turn-buttons.ts';
import { pendingReactionReply } from '../gateway/middleware-setup.ts';

type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };

function table() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-movement-'));
  const rolls: number[] = [];
  const roller = vi.fn((sides: number) => rolls.shift() ?? Math.min(sides, 10));
  const service = new DndService({ store: new CampaignStore(root), library: new AdventureLibrary(), mapDir: root, roller });
  const key = 'group:G1';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: '甲', playerId: 'P1', maxHp: 40, ac: 14, weapons: [{ name: '剑', damage: '1d8' }], reactions: [] });
    upsertCharacter(c, { name: '乙', playerId: 'P2', maxHp: 40, weapons: [{ name: '剑', damage: '1d8' }], reactions: [] });
    upsertCharacter(c, { name: '狼', kind: 'monster', maxHp: 80, ac: 12, attackBonus: 6, damage: '1d6+2', room: c.currentRoom });
    c.initiative = { round: 1, turn: 0, order: [{ name: '狼', init: 20 }, { name: '甲', init: 15 }, { name: '乙', init: 10 }],
      positions: { 甲: { x: 0, y: 0, room: c.currentRoom }, 狼: { x: 1, y: 0, room: c.currentRoom }, 乙: { x: 8, y: 8, room: c.currentRoom } } };
  });
  const followup = vi.fn();
  const record = { sessionKey: key, scope: 'group', peerId: 'G1', replyTarget: { scope: 'group', targetId: 'G1' }, recentSenders: [{ id: 'P1', at: Date.now() }, { id: 'P2', at: Date.now() }], agent: { followup, whenIdle: () => Promise.resolve() } };
  const manager = { findByAgent: () => record, sessionKey: () => key, getSessionRecord: () => record, dndService: service };
  const onPendingAttack = vi.fn();
  const tools = new Map<string, Tool>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  registerDndTools({ get: () => ({ register: (t: Tool) => tools.set(t.name, t) }) } as never, {
    service, manager: manager as never, logger, sendImage: vi.fn(), onPendingAttack,
    members: { toOpenid: (_r, id) => ({ U1: 'P1', U2: 'P2' })[id], display: () => undefined },
  });
  const call = async (name: string, args: object) => (await tools.get(name)!.execute(args, { agent: {} })).text;
  const campaign = () => service.store.load(key)!;
  const consent = (by: string, skill: string): string => service.store.update(key, (c) => {
    const p = c.initiative!.pending ?? c.initiative!.movement!;
    const existing = p.claimed.find((r) => r.character === by && r.reaction === skill)?.authorization;
    return existing ?? chooseReaction(c, p, c.characters.find((ch) => ch.name === by)!.playerId!, by, skill)!.authorization!;
  }, '测试：玩家本人明确选择');
  const move = () => call('dnd_position', { action: 'move', name: '狼', x: 5, y: 0 });
  const strike = (extra = {}) => call('dnd_check', { type: 'attack', character: '甲', target: '狼', weapon: '剑', reaction: true, declared_by: 'U1', authorization: campaign().initiative?.movement && !campaign().initiative!.movement!.used.some((r) => r.by === '甲') ? consent('甲', '借机攻击') : undefined, ...extra });
  const buttons = new DndTurnButtons(service, manager as never, { sendMarkdown: vi.fn() }, logger);
  let eventId = 0;
  const press = (data: { a?: string; i?: number }, clicker = 'P1') => {
    const option = (campaign().initiative?.pending ?? campaign().initiative?.movement)?.reactors[data.i ?? -1];
    return buttons.handleInteraction({ id: `e${++eventId}`, type: 11, version: 1, group_openid: 'G1', group_member_openid: clicker,
      data: { type: 11, resolved: { button_data: JSON.stringify({ t: 'dnd', ...(data.a === 'react' && option ? { o: reactionOptionKey(option) } : {}), ...data }) } } } as never);
  };
  return { consent, service, key, rolls, roller, call, campaign, move, strike, manager, onPendingAttack, press, followup };
}

describe('借机是持久化的移动停止点', () => {
  it('借机也不能只凭玩家编号授权；不用撤回已确认的借机且不掷骰扣反应', async () => {
    const t = table();
    await t.move();
    const attack = (authorization?: string) => t.call('dnd_check', { type: 'attack', character: '甲', target: '狼', weapon: '剑', reaction: true, declared_by: 'U1', authorization });
    const before = t.campaign();
    await expect(attack()).rejects.toThrow('有效授权');
    expect(t.campaign()).toEqual(before);
    expect(t.roller).not.toHaveBeenCalled();
    const seq = before.initiative!.movement!.seq;
    expect(t.press({ a: 'react', r: seq, i: 0 })).toBe(ACK.ok);
    const old = t.campaign().initiative!.movement!.claimed[0]!.authorization;
    expect(t.press({ a: 'pass', r: seq })).toBe(ACK.ok);
    const declined = t.campaign();
    await expect(attack(old)).rejects.toThrow('借机窗口');
    expect(t.campaign()).toEqual(declined);
    expect(t.roller).not.toHaveBeenCalled();
    expect(t.campaign().initiative!.reacted).toBeUndefined();
  });

  it('在离开触及之前暂停，未走的路和移动力不提前写入；不能跳回合或假装攻击', async () => {
    const t = table();
    expect(await t.move()).toContain('移动待结算');
    expect(t.campaign().initiative).toMatchObject({ positions: { 狼: { x: 1, y: 0 } }, moved: { 狼: 0 }, movement: { target: '狼', reactors: [{ character: '甲', reaction: '借机攻击' }] } });
    expect(t.onPendingAttack).toHaveBeenCalledOnce();
    const text = summarize(t.campaign(), t.service.library.get('sunken-bell')!);
    expect(text).toContain('剩余移动还没执行');
    await expect(t.call('dnd_initiative', { action: 'next' })).rejects.toThrow('待结算');
    await expect(t.call('dnd_initiative', { action: 'end' })).rejects.toThrow('待结算');
    await expect(t.call('dnd_position', { action: 'move', name: '狼', x: 6, y: 0, reaction: true })).rejects.toThrow('待结算');
    await expect(t.call('dnd_check', { type: 'attack', character: '狼', target: '甲' })).rejects.toThrow('借机窗口');
    await expect(t.call('dnd_apply', { target: '狼', settle: true })).rejects.toThrow('反应窗口还开着');
    expect(t.roller).not.toHaveBeenCalled();
  });

  it('拒绝借机不扣反应；读盘后仍能恢复剩余移动，不能重复走或重复恢复', async () => {
    const t = table();
    await t.move();
    expect(new CampaignStore(t.service.store.root).load(t.key)!.initiative!.movement).toBeDefined();
    await t.call('dnd_apply', { target: '狼', decline: ['甲'], settle: true });
    expect(t.campaign().initiative).toMatchObject({ positions: { 狼: { x: 5, y: 0 } }, moved: { 狼: 20 } });
    expect(t.campaign().initiative!.reacted).toBeUndefined();
    expect(t.campaign().initiative!.movement).toBeUndefined();
    await expect(t.call('dnd_apply', { target: '狼', settle: true })).rejects.toThrow('没有待结算');
  });

  it('借机按触发位置结算且未命中也扣反应；自己下个回合前不能再借机', async () => {
    const t = table();
    await t.move();
    t.rolls.push(1);
    expect(await t.strike()).toContain('距离 5 尺');
    expect(t.campaign().initiative!.reacted).toEqual(['甲']);
    expect(await t.call('dnd_character', { action: 'show', name: '甲' })).toContain('反应 0/1');
    await expect(t.strike()).rejects.toThrow('借机窗口');
    await t.call('dnd_apply', { target: '狼', settle: true });
    await t.call('dnd_position', { action: 'set', placements: [{ name: '狼', x: 1, y: 0 }] });
    await expect(t.strike()).rejects.toThrow('反应已经用过');
    await t.call('dnd_initiative', { action: 'next' });
    expect(await t.call('dnd_character', { action: 'show', name: '甲' })).toContain('反应 1/1');
    expect(t.campaign().initiative!.reacted).toBeUndefined();
  });

  it('同一点的两名反应者分别答复；按钮只能由本人点击，并直接走借机工具', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => { c.initiative!.positions!.乙 = { x: 0, y: 1, room: c.currentRoom }; });
    await t.move();
    const seq = t.campaign().initiative!.movement!.seq;
    expect(t.press({ a: 'react', r: seq, i: 0 }, 'P2')).toBe(ACK.denied);
    expect(t.press({ a: 'react', r: seq, i: 0 })).toBe(ACK.ok);
    expect(t.followup.mock.calls.at(-1)?.[0].content[0].text).toContain('dnd_check');
    await t.strike({ declared_by: undefined });
    await expect(t.call('dnd_apply', { target: '狼', settle: true })).rejects.toThrow('乙');
    expect(t.press({ a: 'pass', r: seq }, 'P2')).toBe(ACK.ok);
    await t.call('dnd_apply', { target: '狼', settle: true });
    expect(t.campaign().initiative!.positions!.狼.x).toBe(5);
  });

  it('移动借机的普通回复不需要 @，会被识别成窗口答复', async () => {
    const t = table();
    await t.move();
    const reply = pendingReactionReply({ kind: 'group', groupOpenid: 'G1', senderId: 'P1', content: '打', messageId: 'm1' } as never, t.manager as never, true);
    expect(reply?.note).toContain('系统 · 借机');
    expect(reply?.note).toContain('authorization=');
  });

  it('撤离、失能、受惊、反应已用均不弹借机；10 尺外远离普通武器不触发', async () => {
    for (const mode of ['disengage', 'unconscious', 'surprised', 'used', 'outside']) {
      const t = table();
      t.service.store.update(t.key, (c) => {
        if (mode === 'unconscious') requireCharacter(c, '甲').conditions.push('失能');
        if (mode === 'surprised') c.initiative!.surprised = ['甲'];
        if (mode === 'used') c.initiative!.reacted = ['甲'];
        if (mode === 'outside') c.initiative!.positions!.狼.x = 2;
      });
      await t.call('dnd_position', { action: 'move', name: '狼', x: 5, y: 0, disengage: mode === 'disengage' });
      expect(t.campaign().initiative!.movement, mode).toBeUndefined();
    }
  });

  it('长柄大师的结构化字段可以写入，进入触及后暂停；只计实际走过的距离', async () => {
    const t = table();
    await t.call('dnd_character', { action: 'update', name: '甲', reactions: [{ name: '长柄大师', enter: true, range: 10 }] });
    t.service.store.update(t.key, (c) => { c.initiative!.positions!.狼.x = 4; });
    await t.call('dnd_position', { action: 'move', name: '狼', x: 1, y: 0 });
    expect(t.campaign().initiative).toMatchObject({ positions: { 狼: { x: 2 } }, moved: { 狼: 10 }, movement: { reactors: [{ reaction: '长柄大师' }] } });
  });

  it('借机攻击还能被护盾打断，两个窗口均结算后才继续移动，资源和反应各扣一次', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      c.initiative!.turn = 1;
      const pc = requireCharacter(c, '甲');
      pc.reactions = [{ name: '护盾术', when: 'attacked', resource: '1环法术位' }];
      pc.resources = { '1环法术位': { current: 2, max: 2, reset: 'long' } };
    });
    await t.call('dnd_position', { action: 'move', name: '甲', x: 0, y: 4, declared_by: 'U1' });
    expect(buildReactionKeyboard(t.campaign().initiative!.movement!).content.rows).toHaveLength(1);
    t.rolls.push(10, 2);
    await t.call('dnd_check', { type: 'attack', character: '狼', target: '甲', reaction: true });
    expect(t.campaign().initiative!.pending).toBeDefined();
    expect(t.campaign().initiative!.movement).toBeDefined();
    await t.call('dnd_apply', { target: '甲', declared_by: 'U1', reaction: { by: '甲', name: '护盾术', authorization: t.consent('甲', '护盾术'), ac_mod: 5 }, settle: true });
    expect(requireCharacter(t.campaign(), '甲')).toMatchObject({ hp: 40, resources: { '1环法术位': { current: 1 } } });
    expect(t.campaign().initiative!.reacted).toEqual(['狼', '甲']);
    await t.call('dnd_apply', { target: '甲', settle: true });
    expect(t.campaign().initiative!.positions!.甲.y).toBe(4);
    expect(t.campaign().initiative!.moved!.甲).toBe(20);
  });

  it('借机将移动者打倒或限制移动后，剩余路程取消；不用把位置补回去', async () => {
    const t = table();
    await t.move();
    await t.strike();
    await t.call('dnd_apply', { target: '狼', add_conditions: ['擒抱'] });
    expect(await t.call('dnd_apply', { target: '狼', settle: true })).toContain('无法继续移动');
    expect(t.campaign().initiative!.positions!.狼.x).toBe(1);
  });

  it('反应不会因新轮开始而恢复：到本人回合开始才恢复，指针纠错也不刷新', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => { c.initiative!.turn = 2; c.initiative!.reacted = ['甲']; });
    await t.call('dnd_initiative', { action: 'next', declared_by: 'U2' });
    expect(t.campaign().initiative!.round).toBe(2);
    expect(t.campaign().initiative!.reacted).toEqual(['甲']);
    await t.call('dnd_initiative', { action: 'goto', name: '甲' });
    expect(t.campaign().initiative!.reacted).toEqual(['甲']);
  });

  it('护盾持续保护后续攻击，直到本人下回合开始；反应已用不会再弹护盾', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      const pc = requireCharacter(c, '甲');
      pc.reactions = [{ name: '护盾术', when: 'attacked', resource: '1环法术位' }];
      pc.resources = { '1环法术位': { current: 2, max: 2, reset: 'long' } };
    });
    t.rolls.push(10, 2);
    await t.call('dnd_check', { type: 'attack', character: '狼', target: '甲' });
    await t.call('dnd_apply', { target: '甲', reaction: { by: '甲', name: '护盾术', authorization: t.consent('甲', '护盾术'), ac_mod: 5 }, declared_by: 'U1', settle: true });
    t.rolls.push(10);
    const second = await t.call('dnd_check', { type: 'attack', character: '狼', target: '甲' });
    expect(second).toContain('未命中');
    expect(second).not.toContain('待结算');
    expect(requireCharacter(t.campaign(), '甲').hp).toBe(40);
    expect(await t.call('dnd_character', { action: 'show', name: '甲' })).toContain('AC 19');
    await t.call('dnd_initiative', { action: 'next' });
    expect(await t.call('dnd_character', { action: 'show', name: '甲' })).toContain('AC 14');
  });

  it('逐段移动沿用本回合撤离，下一回合清除；不能用摆位或换房间跳过借机窗口', async () => {
    const t = table();
    await t.call('dnd_position', { action: 'move', name: '狼', x: 1, y: 1, disengage: true });
    await t.move();
    expect(t.campaign().initiative!.movement).toBeUndefined();
    await t.call('dnd_initiative', { action: 'next' });
    expect(t.campaign().initiative!.disengaged).toBeUndefined();
    const u = table();
    await u.move();
    await expect(u.call('dnd_position', { action: 'set', placements: [{ name: '狼', x: 5, y: 0 }] })).rejects.toThrow('待结算');
    await expect(u.call('dnd_character', { action: 'update', name: '狼', room: 'nave' })).rejects.toThrow('待结算');
    await expect(u.call('dnd_resource', { action: 'set', character: '甲', resource: '反应', max: 99 })).rejects.toThrow('自动记账');
  });

  it('哨兵还击已登记的反应不会扣两次，也不能重复使用这张许可', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      requireCharacter(c, '乙').reactions = [{ name: '哨兵', range: 5, counter: true, when: 'foe_attacks' }];
      c.initiative!.positions!.乙 = { x: 1, y: 1, room: c.currentRoom };
    });
    t.rolls.push(1);
    // 天然 1 不会自动打开窗口，PC 特殊反应先用 hold_for 询问本人。
    await t.call('dnd_check', { type: 'attack', character: '狼', target: '甲', hold_for: [{ by: '乙', name: '哨兵' }] });
    await t.call('dnd_apply', { target: '甲', reaction: { by: '乙', name: '哨兵', authorization: t.consent('乙', '哨兵') }, declared_by: 'U2', settle: true });
    await t.call('dnd_check', { type: 'attack', character: '乙', target: '狼', weapon: '剑', reaction: true });
    expect(t.campaign().initiative!.reacted).toEqual(['乙']);
    await expect(t.call('dnd_check', { type: 'attack', character: '乙', target: '狼', weapon: '剑', reaction: true, declared_by: 'U2' })).rejects.toThrow('反应已经用过');
  });

  it('起点终点都在触及之外，走廊路线途中经过再离开仍暂停', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      c.initiative!.positions = { 狼: { x: 0, y: 2, room: c.currentRoom }, 甲: { x: 3, y: 1, room: c.currentRoom } };
    });
    await t.call('dnd_position', { action: 'terrain', width: 8, height: 4, areas: [
      { kind: 'wall', x: 0, y: 0, w: 8 }, { kind: 'wall', x: 0, y: 3, w: 8 },
      { kind: 'wall', x: 0, y: 1, w: 3 }, { kind: 'wall', x: 4, y: 1, w: 4 },
    ] });
    await t.call('dnd_position', { action: 'move', name: '狼', x: 6, y: 2 });
    expect(t.campaign().initiative).toMatchObject({ positions: { 狼: { x: 4, y: 2 } }, moved: { 狼: 20 }, movement: { reactors: [{ character: '甲' }] } });
    await t.call('dnd_apply', { target: '狼', decline: ['甲'], settle: true });
    expect(t.campaign().initiative).toMatchObject({ positions: { 狼: { x: 6, y: 2 } }, moved: { 狼: 30 } });
  });

  it('绕墙的路线在难行格触发借机；暂停和恢复只累计实际成本', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      requireCharacter(c, '狼').speed = 40;
      c.initiative!.positions = { 狼: { x: 1, y: 1, room: c.currentRoom }, 甲: { x: 3, y: 5, room: c.currentRoom } };
    });
    await t.call('dnd_position', { action: 'terrain', width: 8, height: 7, areas: [
      { kind: 'wall', x: 3, y: 0, h: 4 }, { kind: 'difficult', x: 3, y: 4 },
    ] });
    await t.call('dnd_position', { action: 'move', name: '狼', x: 6, y: 1 });
    expect(t.campaign().initiative).toMatchObject({ positions: { 狼: { x: 3, y: 4 } }, moved: { 狼: 20 } });
    await t.call('dnd_apply', { target: '狼', decline: ['甲'], settle: true });
    expect(t.campaign().initiative!.moved!.狼).toBe(35);
  });

  it('一条路线先后经过不同敌人时逐处暂停，不提前问还未到达的触发点', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => { c.initiative!.positions!.乙 = { x: 4, y: 1, room: c.currentRoom }; });
    await t.call('dnd_position', { action: 'move', name: '狼', x: 7, y: 0 });
    expect(t.campaign().initiative!.movement!.reactors.map((r) => r.character)).toEqual(['甲']);
    await t.call('dnd_apply', { target: '狼', decline: ['甲'], settle: true });
    expect(t.campaign().initiative!.movement!.reactors.map((r) => r.character)).toEqual(['乙']);
    expect(t.campaign().initiative!.positions!.狼.x).toBeLessThan(7);
    await t.call('dnd_apply', { target: '狼', decline: ['乙'], settle: true });
    expect(t.campaign().initiative!.positions!.狼).toMatchObject({ x: 7, y: 0 });
    expect(t.campaign().initiative!.moved!.狼).toBe(30);
  });

  it('战斗中改 room 或 dnd_move 不能跳过路线；到达对应出口后才允许离场', async () => {
    const t = table();
    await expect(t.call('dnd_character', { action: 'update', name: '狼', room: 'nave' })).rejects.toThrow('还没走到');
    await expect(t.call('dnd_move', { room: 'nave', who: ['甲'] })).rejects.toThrow('还没走到');
    await t.call('dnd_position', { action: 'terrain', width: 8, height: 5, areas: [{ kind: 'door', name: '门', x: 5, y: 0, to: 'nave' }] });
    await t.call('dnd_position', { action: 'move', name: '狼', to: '门' });
    expect(t.campaign().initiative!.movement).toBeDefined();
    await t.call('dnd_apply', { target: '狼', decline: ['甲'], settle: true });
    await t.call('dnd_character', { action: 'update', name: '狼', room: 'nave' });
    expect(requireCharacter(t.campaign(), '狼').room).toBe('nave');
    expect(t.campaign().initiative!.order.some((r) => r.name === '狼')).toBe(false);
  });

  it('没有场地图时坐标移动也绕开敌人格，不沿直线穿人；真正传送可明确跳过路线', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      for (let y = 0; y < 3; y++) {
        upsertCharacter(c, { name: `挡路${y}`, kind: 'pc', maxHp: 10 });
        c.initiative!.positions![`挡路${y}`] = { x: 2, y, room: c.currentRoom };
      }
    });
    await t.call('dnd_position', { action: 'move', name: '狼', x: 4, y: 0, disengage: true });
    expect(t.campaign().initiative!.moved!.狼).toBeGreaterThan(15);
    await t.call('dnd_character', { action: 'update', name: '狼', room: 'nave', forced_move: true });
    expect(requireCharacter(t.campaign(), '狼').room).toBe('nave');
  });

  it('沿触及边缘先走一步再触发时，不把暂停前的安全路段说成整次移动不触发借机', async () => {
    const t = table();
    const text = await t.call('dnd_position', { action: 'move', name: '狼', x: 1, y: 5 });
    expect(text).toContain('移动待结算');
    expect(text).not.toContain('不触发借机');
    expect(t.campaign().initiative!.positions!.狼.y).toBe(1);
  });

  it('dash=true 在未超基础速度前遇借机暂停：不提前耗冲刺与主动作；取消不耗，settle 越过基础速度后才落账冲刺', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => { requireCharacter(c, '狼').speed = 30; });
    const paused = await t.call('dnd_position', { action: 'move', name: '狼', x: 9, y: 0, dash: true });
    expect(paused).toContain('移动待结算');
    expect(paused).toContain('0/30 尺');
    expect(paused).not.toContain('60 尺');
    expect(paused).not.toContain('（冲刺）');
    expect(t.campaign().initiative!.dashed).toBeUndefined();
    expect(t.campaign().initiative!.turnState?.actionUsed).toBeUndefined();

    // 取消剩余移动：冲刺动作未消耗，之后仍可在同一回合再按 dash=true 冲刺或做别的主动作
    const canceled = await t.call('dnd_apply', { target: '狼', cancel: true });
    expect(canceled).toContain('冲刺动作未消耗');
    expect(t.campaign().initiative!.dashed).toBeUndefined();
    expect(t.campaign().initiative!.turnState?.actionUsed).toBeUndefined();

    // 重新带 dash=true 走 40 尺，decline 后 settle 走完越过基础速度的路段 -> 现在才真正落账冲刺
    await t.call('dnd_position', { action: 'move', name: '狼', x: 9, y: 0, dash: true });
    await t.call('dnd_apply', { target: '狼', decline: ['甲'], settle: true });
    expect(t.campaign().initiative!.dashed).toEqual(['狼']);
    expect(t.campaign().initiative!.turnState?.actionUsed).toBe('冲刺');
    expect(t.campaign().initiative!.moved!.狼).toBe(40);
    expect(t.campaign().initiative!.positions!.狼.x).toBe(9);
  });

  it('dash=true 走过基础速度 30 尺之后才遇借机暂停：暂停时即已落账冲刺与主动作', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      requireCharacter(c, '狼').speed = 30;
      c.initiative!.positions!.甲 = { x: 8, y: 1, room: c.currentRoom };
    });
    // 从 (1,0) 走到 (10,0)，在 (9,0) 离开 (8,1) 甲 的 5 尺触及（已走 40 尺 > 30 尺基础速度）
    const paused = await t.call('dnd_position', { action: 'move', name: '狼', x: 10, y: 0, dash: true });
    expect(paused).toContain('移动待结算');
    expect(paused).toContain('40/60 尺（冲刺）');
    expect(t.campaign().initiative!.dashed).toEqual(['狼']);
    expect(t.campaign().initiative!.turnState?.actionUsed).toBe('冲刺');
  });

  it('双武器（5尺近战 + 10尺长戟）：离开 5 尺即暂停并可直接用 5 尺武器打借机', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      requireCharacter(c, '甲').weapons = [
        { name: '剑', damage: '1d8' },
        { name: '长戟', damage: '1d10', notes: '触及' },
      ];
    });
    const paused = await t.call('dnd_position', { action: 'move', name: '狼', x: 4, y: 0 });
    expect(paused).toContain('移动待结算');
    expect(t.campaign().initiative!.positions!.狼).toMatchObject({ x: 1, y: 0 });
    t.rolls.push(15, 6);
    const atk = await t.strike();
    expect(atk).toContain('距离 5 尺');
    expect(t.campaign().initiative!.reacted).toEqual(['甲']);
    await t.call('dnd_apply', { target: '狼', settle: true });
    expect(t.campaign().initiative!.positions!.狼).toMatchObject({ x: 4, y: 0 });
  });

  it('在某敌人的借机点中途暂停时，不对仍贴着的其他敌人误报「全程没离开触及，不触发借机」', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      // 甲 在 (0,0)，乙 在 (2,1)：狼 从 (1,0) 走到 (2,0) 离开 甲（触发借机暂停），此时还贴着 乙，若继续走到 (6,0) 会再离开 乙
      c.initiative!.positions!.乙 = { x: 2, y: 1, room: c.currentRoom };
    });
    const paused = await t.call('dnd_position', { action: 'move', name: '狼', x: 6, y: 0 });
    expect(paused).toContain('移动待结算');
    expect(paused).toContain('甲·借机攻击');
    expect(paused).not.toContain('全程没离开触及');
  });
});

describe('友方交换站位（swap）：移动预算、借机拦截与队友同意确认', () => {
  it('队友已在近期消息发言同意时（ally_declared_by），支持贴身 5 尺换位与远距走近再换位，精确计入移动消耗', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      c.initiative!.turn = 1; // 轮到 甲
      c.initiative!.positions = {
        甲: { x: 0, y: 2, room: c.currentRoom },
        乙: { x: 3, y: 2, room: c.currentRoom }, // 距甲 15 尺
        狼: { x: 4, y: 2, room: c.currentRoom }, // 贴着乙
      };
    });
    // 甲(0,2) 走到 (2,2) 花 10 尺，再与 乙(3,2) 互换花 5 尺，共 15/30 尺；乙 退到 (2,2)，甲 顶上前排 (3,2) 贴住 狼！
    const out = await t.call('dnd_position', {
      action: 'move',
      name: '甲',
      swap: '乙',
      declared_by: 'U1',
      ally_declared_by: 'U2',
    });
    expect(out).toContain('与 乙 交换站位');
    expect(out).toContain('15/30 尺');
    expect(out).toContain('贴身：狼');
    expect(t.campaign().initiative!.positions!.甲).toMatchObject({ x: 3, y: 2 });
    expect(t.campaign().initiative!.positions!.乙).toMatchObject({ x: 2, y: 2 });
    expect(t.campaign().initiative!.movement).toBeUndefined();
    // 乙 换位离开 狼 的触及也会提示 DM
    expect(out).toContain('乙 配合换位离开了 狼 的触及范围');
  });

  it('未传 ally_declared_by 时弹出换位确认窗口：不消耗反应（即使队友本轮已用反应也可同意），支持按钮与自然语言答复', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      c.initiative!.turn = 1; // 轮到 甲
      c.initiative!.reacted = ['乙']; // 乙 本轮反应已经用过（0/1）！
      c.initiative!.positions = {
        甲: { x: 1, y: 3, room: c.currentRoom },
        乙: { x: 2, y: 3, room: c.currentRoom },
        狼: { x: 8, y: 8, room: c.currentRoom },
      };
    });

    // 1) action="swap" 也支持，且未传 ally_declared_by 时暂停等 乙 本人确认
    const askOut = await t.call('dnd_position', {
      action: 'swap',
      name: '甲',
      to: '乙',
      declared_by: 'U1',
    });
    expect(askOut).toContain('【换位待确认】');
    expect(t.onPendingAttack).toHaveBeenCalledOnce();
    const pm = t.campaign().initiative!.movement!;
    expect(pm.swapWith).toBe('乙');
    expect(pm.reactors).toEqual([{ character: '乙', reaction: '同意换位' }]);

    // 按钮面板显示「乙·同意换位」与「不同意」
    const kb = buildReactionKeyboard(pm);
    expect(kb.content.rows[0]!.buttons[0]!.render_data.label).toContain('同意换位');
    expect(kb.content.rows[1]!.buttons[0]!.render_data.label).toBe('不同意');

    // 确认前不能偷调借机攻击、不能推进回合、不能强行 settle；甲 的玩家 P1 不能代点 乙 的按钮
    await expect(t.call('dnd_check', { type: 'attack', character: '乙', target: '甲', reaction: true })).rejects.toThrow('换位确认窗口');
    await expect(t.call('dnd_apply', { target: '甲', settle: true })).rejects.toThrow('反应窗口还开着');
    expect(t.press({ a: 'react', r: pm.seq, i: 0 }, 'P1')).toBe(ACK.denied);

    // 2) 乙 的玩家 P2 点「同意换位」按钮（不消耗反应！）→ settle 完成换位
    expect(t.press({ a: 'react', r: pm.seq, i: 0 }, 'P2')).toBe(ACK.ok);
    expect(t.followup.mock.calls.at(-1)?.[0].content[0].text).toContain('本人已同意与 甲 交换站位');
    const settled = await t.call('dnd_apply', { target: '甲', settle: true });
    expect(settled).toContain('与 乙 交换站位');
    expect(t.campaign().initiative!.positions!.甲).toMatchObject({ x: 2, y: 3 });
    expect(t.campaign().initiative!.positions!.乙).toMatchObject({ x: 1, y: 3 });
    expect(t.campaign().initiative!.moved!.甲).toBe(5);

    // 3) 再次请求换位，测试自然语言回复「不同意」取消换位，双方停在原位且延迟的冲刺不消耗
    await t.call('dnd_position', { action: 'move', name: '甲', swap: '乙', dash: true, declared_by: 'U1' });
    const declineReply = pendingReactionReply(
      { kind: 'group', groupOpenid: 'G1', senderId: 'P2', content: '不换', messageId: 'm-swap-no' } as never,
      t.manager as never,
      true,
    );
    expect(declineReply?.note).toContain('不同意交换站位');
    const aborted = await t.call('dnd_apply', { target: '甲', settle: true });
    expect(aborted).toContain('乙 未同意交换站位');
    expect(aborted).toContain('冲刺动作未消耗');
    expect(t.campaign().initiative!.positions!.甲).toMatchObject({ x: 2, y: 3 });
    expect(t.campaign().initiative!.positions!.乙).toMatchObject({ x: 1, y: 3 });
    expect(t.campaign().initiative!.dashed).toBeUndefined();
  });

  it('换位那一步离开敌方触及时先在换位前暂停结算借机（两人绝不叠格），且拦截与敌人或失能队友换位', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      c.initiative!.turn = 1; // 轮到 甲
      // 狼 在 (0,0)，甲 在 (1,0)（距狼 5 尺），乙 在 (2,0)（距狼 10 尺）
      // 甲 与 乙 换位从 (1,0)→(2,0) 会离开 狼 的 5 尺触及！
      c.initiative!.positions = {
        狼: { x: 0, y: 0, room: c.currentRoom },
        甲: { x: 1, y: 0, room: c.currentRoom },
        乙: { x: 2, y: 0, room: c.currentRoom },
      };
    });

    // 不能与敌人换位
    await expect(t.call('dnd_position', { action: 'swap', name: '甲', swap: '狼', declared_by: 'U1' }))
      .rejects.toThrow('敌对单位');

    // 队友失能时不能主动配合换位
    await t.call('dnd_apply', { target: '乙', add_conditions: ['麻痹'] });
    await expect(t.call('dnd_position', { action: 'swap', name: '甲', swap: '乙', declared_by: 'U1', ally_declared_by: 'U2' }))
      .rejects.toThrow('失能');
    await t.call('dnd_apply', { target: '乙', remove_conditions: ['麻痹'] });

    // 同意换位但踏入 (2,0) 离开 狼 触及：在 (1,0) 暂停等 狼 借机，此时甲仍在 (1,0)、乙仍在 (2,0) 不重叠
    const paused = await t.call('dnd_position', {
      action: 'move',
      name: '甲',
      swap: '乙',
      declared_by: 'U1',
      ally_declared_by: 'U2',
    });
    expect(paused).toContain('移动待结算');
    expect(paused).toContain('狼·借机攻击');
    expect(t.campaign().initiative!.positions!.甲).toMatchObject({ x: 1, y: 0 });
    expect(t.campaign().initiative!.positions!.乙).toMatchObject({ x: 2, y: 0 });

    // 狼 放弃借机后 settle → 完成与 乙 的位置互换！
    const done = await t.call('dnd_apply', { target: '甲', decline: ['狼'], settle: true });
    expect(done).toContain('与 乙 交换站位');
    expect(t.campaign().initiative!.positions!.甲).toMatchObject({ x: 2, y: 0 });
    expect(t.campaign().initiative!.positions!.乙).toMatchObject({ x: 1, y: 0 });
  });
});

describe('领域区域自动绕行与拆分移动（Breaking Up Your Move）提醒', () => {
  it('复刻 18.蛇人巢穴 火墙术场景：move to="蛇人纯血3" 自动走南侧无火走廊 (1,2)→(1,3)→(2,4)→(3,4) 耗 15 尺无伤贴身，且连击斩杀首目标后提示拆分移动转火', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, { name: '维斯珀', playerId: 'P2', className: '法师', level: 7, maxHp: 40, abilities: { int: 18 } });
      upsertCharacter(c, { name: '丛云', playerId: 'P1', className: '战士', level: 7, maxHp: 60, speed: 30, weapons: [{ name: '段云', damage: '1d8+4' }], reactions: [] });
      upsertCharacter(c, { name: '卡厄斯', playerId: 'P2', className: '圣武士', level: 7, maxHp: 60, reactions: [] });
      upsertCharacter(c, { name: '蛇人恶种1', kind: 'monster', maxHp: 10, hp: 6, ac: 12, room: c.currentRoom, reactions: [] });
      upsertCharacter(c, { name: '蛇人纯血3', kind: 'monster', maxHp: 40, hp: 40, ac: 12, room: c.currentRoom, reactions: [] });
      c.initiative = {
        round: 2,
        turn: 0,
        order: [
          { name: '丛云', init: 18 },
          { name: '维斯珀', init: 15 },
          { name: '蛇人恶种1', init: 12 },
          { name: '蛇人纯血3', init: 10 },
        ],
        moved: { 丛云: 5 }, // 本回合已从 (0,2) 走到 (1,2) 耗 5 尺，剩 25/30 尺
        positions: {
          卡厄斯: { x: 1, y: 1, room: c.currentRoom },
          丛云: { x: 1, y: 2, room: c.currentRoom },
          维斯珀: { x: 0, y: 2, room: c.currentRoom },
          蛇人恶种1: { x: 2, y: 1, room: c.currentRoom },
          蛇人纯血3: { x: 4, y: 3, room: c.currentRoom },
        },
      };
    });
    // 8×6 蛇人巢穴地形：y=0、y=5、x=7 为墙，x=0 为门外走廊，y=1..4, x=1..6 为室内空地
    await t.call('dnd_position', {
      action: 'terrain',
      width: 8,
      height: 6,
      areas: [
        { kind: 'wall', x: 0, y: 0, w: 8, h: 1 },
        { kind: 'wall', x: 1, y: 5, w: 7, h: 1 },
        { kind: 'wall', x: 7, y: 1, w: 1, h: 5 },
        { kind: 'outside', name: '门外走廊', x: 0, y: 1, w: 1, h: 5 },
      ],
    });
    // 维斯珀放置火墙术覆盖 (2..7, 2..3)
    await t.call('dnd_position', {
      action: 'zone',
      name: '火墙术',
      caster: '维斯珀',
      shape: 'rect',
      x: 2,
      y: 2,
      w: 6,
      h: 2,
      damage: '5d8',
      damage_type: '火焰',
      save_ability: 'dex',
      save_dc: 15,
      concentration: true,
    });

    // 1. 回合站位提示直接标出可无伤绕开火墙术近战触及 蛇人纯血3
    const posNote = turnPositionNote(t.campaign(), '丛云', t.service.globalEffects());
    expect(posNote).toContain('蛇人纯血3(15尺无伤绕开区域可达)');

    // 2. 连击 2 刀砍 蛇人恶种1，第 1 刀直接斩杀 -> 【连击停止】自动给出【拆分移动提示】告知可绕火转火 蛇人纯血3
    t.rolls.push(18, 6); // 命中并造成 6+4=10 斩杀恶种1
    const multiOut = await t.call('dnd_check', {
      type: 'attack',
      character: '丛云',
      target: '蛇人恶种1',
      weapon: '段云',
      declared_by: 'U1',
      attacks: [{}, {}],
    });
    expect(multiOut).toContain('【连击停止】');
    expect(multiOut).toContain('【拆分移动提示】丛云 还有 1 击未掷');
    expect(multiOut).toContain('蛇人纯血3(15尺无伤绕开区域可达)');

    // 3. 丛云 move to="蛇人纯血3"：自动从南侧 y=4 绕开火墙术，耗 15 尺（累计 20/30 尺），0 火焰伤害，落点 (3,4) 贴身纯血3！
    const moveOut = await t.call('dnd_position', {
      action: 'move',
      name: '丛云',
      to: '蛇人纯血3',
      declared_by: 'U1',
    });
    expect(moveOut).toContain('走 15 尺');
    expect(moveOut).toContain('20/30 尺');
    expect(moveOut).toContain('贴身：蛇人纯血3');
    expect(moveOut).toContain('已自动绕开领域/区域「火墙术」');
    expect(moveOut).not.toContain('区域·火墙术');
    expect(requireCharacter(t.campaign(), '丛云').hp).toBe(60);
    expect(t.campaign().initiative!.positions!.丛云).toMatchObject({ x: 3, y: 4 });
  });

  it('当挡路敌人封死唯一无伤通路而踩进领域技能时，给出域外停步坐标、清怪拆分移动绕行与友方专注提醒；传 enter_hazards=true 可显式直穿', async () => {
    const t = table();
    t.service.store.update(t.key, (c) => {
      upsertCharacter(c, { name: '维斯珀', playerId: 'P2', className: '法师', level: 7, maxHp: 40, abilities: { int: 18 } });
      upsertCharacter(c, { name: '丛云', playerId: 'P1', className: '战士', level: 7, maxHp: 60, speed: 30, reactions: [] });
      upsertCharacter(c, { name: '蛇人恶种1', kind: 'monster', maxHp: 20, ac: 12, room: c.currentRoom, reactions: [] });
      upsertCharacter(c, { name: '蛇人纯血5', kind: 'monster', maxHp: 40, ac: 12, room: c.currentRoom, reactions: [] });
      c.initiative = {
        round: 2,
        turn: 0,
        order: [{ name: '丛云', init: 18 }, { name: '维斯珀', init: 15 }, { name: '蛇人恶种1', init: 12 }, { name: '蛇人纯血5', init: 10 }],
        positions: {
          丛云: { x: 1, y: 2, room: c.currentRoom },
          维斯珀: { x: 0, y: 2, room: c.currentRoom },
          蛇人恶种1: { x: 2, y: 1, room: c.currentRoom }, // 堵死北侧 y=1 唯一无火通道！
          蛇人纯血5: { x: 4, y: 1, room: c.currentRoom },
        },
      };
    });
    // 南侧 y=4 设墙封死，使北侧 y=1 成为唯一非火墙走廊，且正被 (2,1) 的蛇人恶种1 挡住
    await t.call('dnd_position', {
      action: 'terrain',
      width: 8,
      height: 5,
      areas: [
        { kind: 'wall', x: 0, y: 0, w: 8, h: 1 },
        { kind: 'wall', x: 0, y: 4, w: 8, h: 1 },
        { kind: 'wall', x: 7, y: 1, w: 1, h: 3 },
      ],
    });
    await t.call('dnd_position', {
      action: 'zone',
      name: '火墙术',
      caster: '维斯珀',
      shape: 'rect',
      x: 2,
      y: 2,
      w: 5,
      h: 2,
      damage: '5d8',
      damage_type: '火焰',
      save_ability: 'dex',
      save_dc: 15,
      concentration: true,
    });

    // 丛云直接 move to="蛇人纯血5"：因 (2,1) 被恶种1堵死，只能踩进火墙 (2,2)→(3,1) 过去，同时输出完整拆分移动提醒！
    t.rolls.push(2, 2, 2, 2, 2, 18); // 5d8=10，豁免成功减半受 5 点火焰
    const crossed = await t.call('dnd_position', {
      action: 'move',
      name: '丛云',
      to: '蛇人纯血5',
      declared_by: 'U1',
    });
    expect(crossed).toContain('领域/拆分移动提醒：本次移动经过「火墙术」');
    expect(crossed).toContain('停在域外边缘 (1,2)');
    expect(crossed).toContain('若先攻击清掉或推开挡路的「蛇人恶种1」，再用剩余移动力拆分移动，只需 10 尺即可无伤绕开');
    expect(crossed).toContain('「火墙术」为友方 维斯珀 专注维持');

    // 退回该步并清掉挡路的恶种1，验证传 enter_hazards=true 时允许直线硬闯，不传时自动走 (2,1) 无伤绕开
    await t.call('dnd_undo', { action: 'undo', steps: 1 });
    await t.call('dnd_apply', { target: '蛇人恶种1', damage: 30 });
    const safeMove = await t.call('dnd_position', {
      action: 'move',
      name: '丛云',
      x: 3,
      y: 2,
      enter_hazards: true,
      declared_by: 'U1',
    });
    expect(safeMove).toContain('领域/拆分移动提醒：本次移动经过「火墙术」');
  });
});
