/**
 * 具名 NPC 的生死和口供、停团时的聊团：
 * lmop 团里黑蜘蛛被现场建卡打死，模组的内兹纳还「活着」等在神庙；维瑞丝 knows 为空，DM 替她编了个营地；
 * 收团后没有守则，DM 报了没去过的地方和怪物数值，又凭印象连着改口。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { AdventureLibrary } from './adventure.ts';
import { CampaignStore, applyDamage, endInitiative, removeCharacter, startInitiative, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { npcAlive, npcCard } from './story.ts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const MINI = {
  id: 'mini',
  name: '小洞',
  truth: ['洞主是个法师。'],
  hook: '有人失踪。',
  start: 'gate',
  chapters: [{ id: 'cave', name: '小洞', mode: 'dungeon', goal: '找到洞主' }],
  flags: [],
  sites: [{
    id: 'cave', name: '小洞', chapter: 'cave', entry: 'gate',
    rooms: [
      { id: 'gate', name: '洞口', x: 0, y: 0, w: 3, h: 3, playerView: '洞口。', dmNotes: '探子在这里。', exits: [{ to: 'hall', label: '往里' }] },
      { id: 'hall', name: '大厅', x: 4, y: 0, w: 3, h: 3, playerView: '一张堆满笔记的桌子。', dmNotes: '洞主在桌边，由两只蜘蛛陪着。', exits: [] },
    ],
  }],
  npcs: [
    {
      id: 'boss', name: '内兹纳', aliases: ['黑蜘蛛'], role: '洞主', look: '白发黑肤的精灵', motive: '找炉子',
      home: { room: 'hall' }, attitude: 'hostile', knows: [],
      stat: { name: '内兹纳', count: 1, hp: 27, ac: 11, initBonus: 1, attackBonus: 1, damage: '2d6-1' },
    },
    {
      id: 'spy', name: '维瑞丝', role: '探子', look: '穿长袍的女子', motive: '取图', home: { room: 'gate' }, attitude: 'hostile',
      knows: [{ id: 'spy-boss', text: '洞主在大厅。', via: 'captured' }],
    },
  ],
  leads: [],
  quests: [],
  milestones: [],
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-npc-'));
  const advDir = join(root, 'adventures');
  mkdirSync(advDir);
  writeFileSync(join(advDir, 'mini.json'), JSON.stringify(MINI));
  const service = new DndService({
    store: new CampaignStore(join(root, 'campaigns')),
    library: new AdventureLibrary({ adventures: advDir }),
    mapDir: root,
    roller: () => 10,
  });
  const key = 'group:G1';
  service.start(key, 'mini', false);
  service.store.update(key, (c) => {
    c.begun = true;
    upsertCharacter(c, { name: 'Kriv', player: 'tty', playerId: 'P2', maxHp: 20, ac: 16 });
  });
  const record = { sessionKey: key, scope: 'group', peerId: 'G1', replyTarget: { scope: 'group', targetId: 'G1' }, recentSenders: [{ id: 'P2', at: Date.now() }] };
  const manager = { sessionKey: (_s: string, gid: string) => `group:${gid}`, getSessionRecord: () => record, findByAgent: () => record, dndService: service };
  type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };
  const tools = new Map<string, Tool>();
  const ctx = { get: () => ({ register: (d: Tool) => tools.set(d.name, d) }) };
  registerDndTools(ctx as never, { service, manager: manager as never, logger: logger as never, sendImage: vi.fn() });
  const call = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.execute(args, { agent: {} })).text;
  const adventure = service.library.get('mini')!;
  return { service, key, call, adventure };
}

describe('具名 NPC 的死讯', () => {
  it('战斗结束清掉死卡时记下死讯，房间不再列出他', () => {
    const { service, key, adventure } = setup();
    service.store.update(key, (c) => {
      upsertCharacter(c, { name: '内兹纳', kind: 'monster', npcId: 'boss', maxHp: 5, room: c.currentRoom });
      startInitiative(c, () => 10);
      applyDamage(c, '内兹纳', 50);
      endInitiative(c);
    });
    const c = service.store.load(key)!;
    expect(c.characters.some((ch) => ch.name === '内兹纳')).toBe(false);
    expect(npcAlive(c, 'boss')).toBe(false);
    expect(npcCard(c, adventure, adventure.npcs[0]!)).toContain('已死');
  });

  it('手动移除死卡也记死讯；活着的移走不算死', () => {
    const { service, key } = setup();
    service.store.update(key, (c) => {
      upsertCharacter(c, { name: '维瑞丝', kind: 'monster', npcId: 'spy', maxHp: 5, room: c.currentRoom });
      removeCharacter(c, '维瑞丝');
      upsertCharacter(c, { name: '内兹纳', kind: 'monster', npcId: 'boss', maxHp: 5, room: c.currentRoom });
      applyDamage(c, '内兹纳', 50);
      removeCharacter(c, '内兹纳');
    });
    const c = service.store.load(key)!;
    expect(npcAlive(c, 'spy')).toBe(true);
    expect(npcAlive(c, 'boss')).toBe(false);
  });

  it('在别处死了的 NPC：进他的房间时提醒剧本里他在场的部分作废', async () => {
    const { service, key, call } = setup();
    service.store.update(key, (c) => { c.npcs.boss = { alive: false }; });
    const text = await call('dnd_move', { room: 'hall' });
    expect(text).toContain('本桌已死：内兹纳(boss)');
    expect(text).not.toContain('这里的 NPC');
  });

  it('新建卡撞上还活着的模组 NPC 的名字或别名就报错，指去 dnd_story npc；他死了就放行', async () => {
    const { service, key, call } = setup();
    await expect(call('dnd_character', { action: 'create', name: '黑蜘蛛·内兹纳尔', kind: 'monster', max_hp: 27 }))
      .rejects.toThrow(/dnd_story npc boss fight=true/);
    expect(await call('dnd_character', { action: 'create', name: '巨蛛', kind: 'monster', max_hp: 26 })).toContain('已建卡');
    service.store.update(key, (c) => { c.npcs.boss = { alive: false }; });
    expect(await call('dnd_character', { action: 'create', name: '黑蜘蛛的替身', kind: 'monster', max_hp: 10 })).toContain('已建卡');
  });
});

describe('口供', () => {
  it('knows 为空时提醒别替他编；有 knows 时提醒这之外他不知道', () => {
    const { service, key, adventure } = setup();
    const c = service.store.load(key)!;
    expect(npcCard(c, adventure, adventure.npcs[0]!)).toContain('模组没写他知道什么');
    expect(npcCard(c, adventure, adventure.npcs[1]!)).toContain('这几条之外他不知道别的');
  });
});

describe('怪物数值不进例行结果', () => {
  it('打怪物只给伤势词，团况里也没有怪物的数字', async () => {
    const { service, key, call } = setup();
    service.store.update(key, (c) => upsertCharacter(c, { name: '巨蛛', kind: 'monster', maxHp: 26, ac: 14, room: c.currentRoom }));
    const hit = await call('dnd_apply', { target: '巨蛛', damage: 9 });
    expect(hit).toContain('巨蛛 受了点伤');
    expect(hit).not.toMatch(/17|26/);
    // 「最近」日志也算：以前写成「巨蛛 受到 9 点伤害（26→17/26）」
    const snapshot = service.stateSnapshot(key);
    expect(snapshot).toContain('巨蛛 受到 9 点伤害（受了点伤）');
    expect(snapshot).not.toMatch(/巨蛛[^；\n]*(\d+\/\d+|AC\d)/);
  });
});

describe('停团', () => {
  it('停团后注入停团守则；账本还能查不能写', async () => {
    const { service, key, call } = setup();
    await call('dnd_chronicle', { action: 'add', text: '在洞外打死了黑蜘蛛' });
    service.stop(key);
    const sections = service.promptSections(key);
    expect(sections.map((s) => s.name)).toEqual(['qqbot:dnd-paused']);
    expect(sections[0]!.text).toContain('dnd_chronicle search');
    expect(await call('dnd_chronicle', { action: 'search', query: '黑蜘蛛' })).toContain('在洞外打死了黑蜘蛛');
    expect(await call('dnd_chronicle', { action: 'list' })).toContain('最近');
    await expect(call('dnd_chronicle', { action: 'add', text: '又一件事' })).rejects.toThrow(/\/dnd start/);
  });

  it('从没开过团的群什么都不注入', () => {
    const { service } = setup();
    expect(service.promptSections('group:other')).toEqual([]);
  });
});
