/**
 * 11-11 DM 提的几处工具往返：出口检定和手动检定不互通、角色卡不能批量改、停团看不了角色卡。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdventureLibrary, validateAdventure } from './adventure.ts';
import { CampaignStore, createCampaign, findCharacter, moveParty, nextRollId, upsertCharacter } from './campaign.ts';
import type { Roller } from './dice.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { rollIds } from './tools/shared.ts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const fixed = (value: number): Roller => () => value;

/** 两间屋，中间一段要过力量检定 DC 15 的台阶 */
function stairs() {
  return validateAdventure({
    id: 'stairs',
    name: '台阶',
    start: 'below',
    sites: [{
      id: 'shrine', name: '神龛', entry: 'below',
      rooms: [
        { id: 'below', name: '台阶下', x: 0, y: 4, w: 3, h: 3, playerView: '', dmNotes: '', exits: [{ to: 'top', label: '第三段台阶', check: { ability: 'str', dc: 15, fail: '滑下去，1d6 钝击' } }] },
        { id: 'top', name: '神龛', x: 0, y: 0, w: 3, h: 3, playerView: '', dmNotes: '', exits: [{ to: 'below', label: '台阶' }] },
      ],
    }],
  });
}

describe('出口检定已经另投过', () => {
  function party() {
    const adv = stairs();
    const c = createCampaign('k', adv);
    upsertCharacter(c, { name: '甲', maxHp: 10 });
    upsertCharacter(c, { name: '乙', maxHp: 10 });
    return { adv, c };
  }

  it('不带 check_done：工具照旧给每个人掷，没过的留下', () => {
    const { adv, c } = party();
    const r = moveParty(c, adv, 'top', false, undefined, fixed(5));
    expect(r.checks).toHaveLength(2);
    expect(r.movers).toEqual([]);
    expect(r.checkDone).toBeUndefined();
  });

  it('带 check_done：不再掷，名单里的人直接过去，日志记下是哪几骰', () => {
    const { adv, c } = party();
    const a = nextRollId(c);
    const b = nextRollId(c);
    // 骰子给 1：要是工具还掷，两个人都过不去
    const r = moveParty(c, adv, 'top', false, undefined, fixed(1), [a, b]);
    expect(r.checks).toEqual([]);
    expect(r.movers).toEqual(['甲', '乙']);
    expect(r.checkDone).toEqual([a, b]);
    expect(c.currentRoom).toBe('top');
    expect(c.log.join('\n')).toContain(`#R${a} #R${b}`);
  });

  it('没过的人不写进 who 就留在原地', () => {
    const { adv, c } = party();
    const id = nextRollId(c);
    const r = moveParty(c, adv, 'top', false, ['甲'], fixed(1), [id]);
    expect(r.movers).toEqual(['甲']);
    expect(findCharacter(c, '乙')!.room).not.toBe('top');
  });

  it('编号对不上的不认：不能凭空跳过检定', () => {
    const { adv, c } = party();
    expect(() => moveParty(c, adv, 'top', false, undefined, fixed(20), [7])).toThrow(/没有 #R7/);
    expect(c.currentRoom).toBe('below');
  });

  it('出口本来不用检定时 check_done 不起作用', () => {
    const { adv, c } = party();
    const id = nextRollId(c);
    moveParty(c, adv, 'top', false, undefined, fixed(20));
    const back = moveParty(c, adv, 'below', false, undefined, fixed(1), [id]);
    expect(back.checkDone).toBeUndefined();
    expect(back.movers).toEqual(['甲', '乙']);
  });

  it('骰子编号的几种写法', () => {
    expect(rollIds([149, '150', 'R151', '#r152'])).toEqual([149, 150, 151, 152]);
    expect(rollIds(undefined)).toEqual([]);
    expect(() => rollIds(['第三骰'])).toThrow(/骰子编号/);
  });
});

type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };

function table() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-feedback-'));
  const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root, roller: fixed(10) });
  const key = 'qqbot:app:group:G1';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: '甲', maxHp: 20 });
    upsertCharacter(c, { name: '乙', maxHp: 12 });
    upsertCharacter(c, { name: '丙', maxHp: 8 });
    upsertCharacter(c, { name: '巨鼠', kind: 'monster', maxHp: 7, room: c.currentRoom });
  });
  const record = { sessionKey: key, scope: 'group', peerId: 'G1', recentSenders: [] };
  const tools = new Map<string, Tool>();
  const ctx = { get: () => ({ register: (d: Tool) => tools.set(d.name, d) }) };
  registerDndTools(ctx as never, { service, manager: { findByAgent: () => record } as never, logger: logger as never, sendImage: vi.fn() });
  const call = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.execute(args, { agent: {} })).text;
  const sheet = (name: string) => findCharacter(service.store.load(key)!, name)!;
  return { call, sheet, service, key };
}

describe('dnd_character 批量', () => {
  it('names：同一处改动一次套给几个人，返回每人一行', async () => {
    const { call, sheet } = table();
    const text = await call('dnd_character', { action: 'update', names: ['甲', '乙', '丙'], add_items: ['超自然护符'], room: 'nave' });
    expect(text).toMatch(/^已更新 3 个/);
    expect(text.split('\n')).toHaveLength(4);
    for (const name of ['甲', '乙', '丙']) {
      expect(sheet(name).inventory).toContain('超自然护符');
      expect(sheet(name).room).toBe('nave');
    }
  });

  it('max_hp_change：支援术给每个人加上限和当前生命，结束时减回去；倒地的不会因此站起来', async () => {
    const { call, sheet, service, key } = table();
    service.store.update(key, (c) => { findCharacter(c, '乙')!.hp = 5; findCharacter(c, '丙')!.hp = 0; });
    await call('dnd_character', { action: 'update', names: ['甲', '乙', '丙'], max_hp_change: 5 });
    expect([sheet('甲').maxHp, sheet('甲').hp]).toEqual([25, 25]);
    expect([sheet('乙').maxHp, sheet('乙').hp]).toEqual([17, 10]);
    expect([sheet('丙').maxHp, sheet('丙').hp]).toEqual([13, 0]);

    await call('dnd_character', { action: 'update', names: ['甲', '乙'], max_hp_change: -5 });
    expect([sheet('甲').maxHp, sheet('甲').hp]).toEqual([20, 20]);
    expect([sheet('乙').maxHp, sheet('乙').hp]).toEqual([12, 10]);
  });

  it('有一个名字不对：整次不落盘，前面的人也不改', async () => {
    const { call, sheet } = table();
    await expect(call('dnd_character', { action: 'update', names: ['甲', '不存在'], gp_change: 50 })).rejects.toThrow(/不存在/);
    expect(sheet('甲').gp ?? 0).toBe(0);
  });

  it('单个人自己的字段不能批量套；names 不用于建卡', async () => {
    const { call } = table();
    await expect(call('dnd_character', { action: 'update', names: ['甲', '乙'], max_hp: 30 })).rejects.toThrow(/max_hp/);
    await expect(call('dnd_character', { action: 'update', names: ['甲', '乙'], player_id: 'U1' })).rejects.toThrow(/player_id/);
    await expect(call('dnd_character', { action: 'create', names: ['丁', '戊'] })).rejects.toThrow(/names 只用于/);
  });

  it('show 带 names：每人一行摘要', async () => {
    const { call } = table();
    const text = await call('dnd_character', { action: 'show', names: ['甲', '乙'] });
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('甲');
    expect(text).toContain('乙');
  });
});

describe('停团时看角色卡', () => {
  it('dnd_lookup kind=character：停团也能看队伍的卡和背包，怪物不给查', async () => {
    const { call, service, key } = table();
    await call('dnd_character', { action: 'update', name: '甲', add_items: ['静默之铃'], gp_change: 42 });
    service.stop(key, '【位置】门厅');

    const list = await call('dnd_lookup', { kind: 'character' });
    expect(list).toContain('甲');
    expect(list).not.toContain('巨鼠');

    const card = await call('dnd_lookup', { kind: 'character', id: '甲' });
    expect(card).toContain('静默之铃');
    expect(card).toContain('42');

    await expect(call('dnd_lookup', { kind: 'character', id: '巨鼠' })).rejects.toThrow(/怪物/);
  });
});
