import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdventureLibrary, adventureFromDungeon } from './adventure.ts';
import { type Campaign, CampaignStore, createCampaign, findCharacter, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { SUNKEN_BELL } from './dungeons/sunken-bell.ts';
import { addHook, hookHint, hookPromptLines, matchHooks, planHook, useHook } from './hooks.ts';
import { openingLines } from './story.ts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };
const BELL = adventureFromDungeon(SUNKEN_BELL);

function party(): Campaign {
  const c = createCampaign('group:abc', BELL);
  upsertCharacter(c, { name: '刻德温', maxHp: 30, ac: 15 });
  upsertCharacter(c, { name: '维斯珀', maxHp: 25, ac: 14 });
  upsertCharacter(c, { name: '狼', kind: 'monster', maxHp: 11, ac: 13 });
  return c;
}
const pc = (c: Campaign, name: string) => findCharacter(c, name)!;

describe('背景钩子', () => {
  it('只挂 PC；触发词至少两个字、不能为空', () => {
    const c = party();
    expect(() => addHook(pc(c, '狼'), '找主人', ['主人'])).toThrow(/只挂在 PC/);
    expect(() => addHook(pc(c, '刻德温'), '找妹妹', ['妹'])).toThrow(/至少两个字/);
    expect(() => addHook(pc(c, '刻德温'), '找妹妹', [])).toThrow(/触发词/);
    expect(addHook(pc(c, '刻德温'), '在找失踪的妹妹拉西亚', ['拉西亚', '红袍']).id).toBe(1);
  });

  it('3-4 档要先 plan；第 5 档还要玩家点头；同一档补记接没接不用再走一遍', () => {
    const c = party();
    const ch = pc(c, '刻德温');
    addHook(ch, '在找失踪的妹妹拉西亚', ['拉西亚']);
    expect(() => useHook(ch, 1, 3)).toThrow(/先 dnd_hook plan/);
    expect(useHook(ch, 1, 2, { response: 'bit', now: 5 }).tier).toBe(2);
    planHook(ch, 1, 3, '下一场旅店老板转交一封信');
    expect(useHook(ch, 1, 3).plan).toBeUndefined();
    expect(useHook(ch, 1, 3, { response: 'ignored' }).response).toBe('ignored');

    planHook(ch, 1, 5, '拉西亚本人在神庙出现');
    expect(() => useHook(ch, 1, 5)).toThrow(/同不同意/);
    expect(useHook(ch, 1, 5, { playerOk: true }).tier).toBe(5);
    expect(() => planHook(ch, 1, 2, 'x')).toThrow(/3-5 档/);
  });

  it('只提醒在场 PC 的、没了结的；最久没碰的排前面', () => {
    const c = party();
    addHook(pc(c, '刻德温'), '在找妹妹拉西亚', ['拉西亚']);
    const v = addHook(pc(c, '维斯珀'), '欠盗贼公会一笔钱', ['盗贼公会', '拉西亚']);
    v.usedAt = 100;
    expect(matchHooks(c, '墙上刻着拉西亚的名字').map((m) => m.ch.name)).toEqual(['刻德温', '维斯珀']);
    expect(matchHooks(c, '墙上刻着拉西亚的名字', ['维斯珀']).map((m) => m.ch.name)).toEqual(['维斯珀']);
    v.closed = true;
    expect(matchHooks(c, '盗贼公会的标记')).toEqual([]);
    expect(hookHint(c, '一间空屋')).toBeUndefined();
    expect(hookHint(c, '拉西亚')).toContain('【DM · 背景钩子】');
  });

  it('开团背景：最久没被碰的 PC 点名；开场没留钩子的 PC 被问到', () => {
    const c = party();
    addHook(pc(c, '刻德温'), '在找妹妹拉西亚', ['拉西亚']).usedAt = 100;
    addHook(pc(c, '维斯珀'), '欠盗贼公会一笔钱', ['盗贼公会']);
    expect(hookPromptLines(c).at(-1)).toContain('最久没被碰到的是 维斯珀');
    expect(hookPromptLines(createCampaign('group:x', BELL))).toEqual([]);

    const fresh = createCampaign('group:y', BELL);
    upsertCharacter(fresh, { name: '甲', maxHp: 10, ac: 10 });
    expect(openingLines(fresh, BELL).at(-1)).toContain('甲：角色过去有没有放不下的事');
    addHook(pc(fresh, '甲'), '逃婚出来的', ['婚约']);
    expect(openingLines(fresh, BELL).join('\n')).not.toContain('dnd_hook add');
  });
});

describe('dnd_hook 工具', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'dnd-hooks-'));
    const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root, roller: () => 10 });
    const key = 'group:G1';
    service.start(key, 'sunken-bell', false);
    service.store.update(key, (c) => {
      upsertCharacter(c, { name: '刻德温', maxHp: 30, ac: 15 });
    });
    const record = { sessionKey: key, scope: 'group', peerId: 'G1', replyTarget: { scope: 'group', targetId: 'G1' }, recentSenders: [], agent: { followup: vi.fn(), whenIdle: () => Promise.resolve() } };
    const manager = { sessionKey: (_s: string, gid: string) => `group:${gid}`, getSessionRecord: () => record, findByAgent: () => record, dndService: service };
    const tools = new Map<string, Tool>();
    const ctx = { get: () => ({ register: (d: Tool) => tools.set(d.name, d) }) };
    registerDndTools(ctx as never, { service, manager: manager as never, logger: logger as never, sendImage: vi.fn() });
    const call = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.execute(args, { agent: {} })).text;
    return { call, service, key };
  }

  it('进新房间碰到触发词才提醒，回头路不提；用过记进账本、进开团背景', async () => {
    const t = setup();
    await t.call('dnd_hook', { action: 'add', character: '刻德温', text: '父亲当年是这座钟楼的敲钟人', keys: ['钟楼'] });
    await t.call('dnd_story', { action: 'begin' });
    const first = await t.call('dnd_move', { room: 'nave' });
    expect(first).toContain('【DM · 背景钩子】');
    expect(first).toContain('刻德温 #1');
    const back = await t.call('dnd_move', { room: 'gate' });
    expect(back).not.toContain('背景钩子');
    const again = await t.call('dnd_move', { room: 'nave' });
    expect(again).not.toContain('背景钩子');

    await expect(t.call('dnd_hook', { action: 'use', character: '刻德温', id: 1, tier: 4 })).rejects.toThrow(/先 dnd_hook plan/);
    expect(await t.call('dnd_hook', { action: 'use', character: '刻德温', id: 1, tier: 1, response: 'bit' })).toContain('到过第 1 档');
    expect(await t.call('dnd_chronicle', { action: 'search', query: '钩子' })).toContain('演到第 1 档');
    expect(await t.call('dnd_hook', { action: 'list' })).toContain('玩家接了');
    const background = t.service.promptSections(t.key).find((s) => s.name === 'qqbot:dnd-background')!.text;
    expect(background).toContain('最久没被碰到的是 刻德温');
  });

  it('拿到的东西沾边也提醒', async () => {
    const t = setup();
    await t.call('dnd_hook', { action: 'add', character: '刻德温', text: '在找失踪的妹妹拉西亚', keys: ['拉西亚'] });
    const text = await t.call('dnd_character', { action: 'update', name: '刻德温', add_items: ['刻着「拉西亚」的银坠子'] });
    expect(text).toContain('【DM · 背景钩子】');
    expect(text).toContain('背景钩子 1 条');
  });
});
