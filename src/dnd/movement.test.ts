import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdventureLibrary } from './adventure.ts';
import { CampaignStore, requireCharacter, summarize, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { buildReactionKeyboard, DndTurnButtons, ACK } from './turn-buttons.ts';
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
  const move = () => call('dnd_position', { action: 'move', name: '狼', x: 5, y: 0 });
  const strike = (extra = {}) => call('dnd_check', { type: 'attack', character: '甲', target: '狼', weapon: '剑', reaction: true, declared_by: 'U1', ...extra });
  const buttons = new DndTurnButtons(service, manager as never, { sendMarkdown: vi.fn() }, logger);
  const press = (data: object, clicker = 'P1') => buttons.handleInteraction({ id: 'e', type: 11, version: 1, group_openid: 'G1', group_member_openid: clicker, data: { type: 11, resolved: { button_data: JSON.stringify({ t: 'dnd', ...data }) } } } as never);
  return { service, key, rolls, roller, call, campaign, move, strike, manager, onPendingAttack, press, followup };
}

describe('借机是持久化的移动停止点', () => {
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
    const reply = pendingReactionReply({ kind: 'group', groupOpenid: 'G1', senderId: 'P1', content: '打' } as never, t.manager as never);
    expect(reply?.note).toContain('系统 · 借机');
    expect(reply?.note).toContain('工具会扣反应');
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
    await t.call('dnd_apply', { target: '甲', declared_by: 'U1', reaction: { by: '甲', name: '护盾术', ac_mod: 5 }, settle: true });
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
    await t.call('dnd_apply', { target: '甲', reaction: { by: '甲', name: '护盾术', ac_mod: 5 }, declared_by: 'U1', settle: true });
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
    // 天然 1 不会自动打开窗口，手动 hold 也能登记 NPC/特殊反应。
    await t.call('dnd_check', { type: 'attack', character: '狼', target: '甲', hold: true });
    await t.call('dnd_apply', { target: '甲', reaction: { by: '乙', name: '哨兵' }, declared_by: 'U2', settle: true });
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
});
