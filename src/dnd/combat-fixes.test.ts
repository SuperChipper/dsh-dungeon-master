/**
 * 11-08 黑蜘蛛那一仗暴露的几处：突袭要逐个点结束回合、火球凭眼睛摆、srd 怪没武器打不出「咬」、
 * 停团兜底摘要只剩一串短休日志。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdventureLibrary, adventureFromDungeon } from './adventure.ts';
import {
  type Campaign,
  CampaignStore,
  addSummary,
  createCampaign,
  ensureSessionSummary,
  nextTurn,
  reactionBlocked,
  skipSurprised,
  startInitiative,
  upsertCharacter,
} from './campaign.ts';
import { areaReport, setPositions } from './battlefield.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { SUNKEN_BELL } from './dungeons/sunken-bell.ts';

const BELL = adventureFromDungeon(SUNKEN_BELL);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** 甲 +5、狼 +4、乙 +3；骰子恒为 10，先攻顺序 甲 15 > 狼 14 > 乙 13 */
function ambush(): Campaign {
  const c = createCampaign('group:abc', BELL);
  upsertCharacter(c, { name: '甲', maxHp: 20, ac: 15, initBonus: 5 });
  upsertCharacter(c, { name: '乙', maxHp: 20, ac: 15, initBonus: 3 });
  upsertCharacter(c, { name: '狼', kind: 'monster', maxHp: 11, ac: 13, initBonus: 4, room: c.currentRoom });
  return c;
}

describe('突袭', () => {
  it('受惊的人第 1 轮由工具跳过，跳过之前不能反应；第 2 轮照常', () => {
    const c = ambush();
    startInitiative(c, () => 10, undefined, undefined, {}, ['甲', '乙']);
    expect(c.initiative!.order.map((e) => e.name)).toEqual(['甲', '狼', '乙']);

    expect(skipSurprised(c).skipped).toEqual(['甲']);
    expect(c.initiative!.order[c.initiative!.turn]!.name).toBe('狼');
    expect(reactionBlocked(c, '乙')).toMatch(/受惊/);
    expect(reactionBlocked(c, '甲')).toBeUndefined();

    const next = nextTurn(c);
    expect(next).toMatchObject({ skipped: ['乙'], newRound: true, round: 2, current: { name: '甲' } });
    expect(c.initiative!.surprised).toBeUndefined();
    expect(reactionBlocked(c, '乙')).toBeUndefined();
  });

  it('受惊名单里有不在参战者里的人：掷骰前就报错', () => {
    const c = ambush();
    expect(() => startInitiative(c, () => 10, ['甲', '狼'], undefined, {}, ['乙'])).toThrow(/不在参战者里/);
    expect(c.initiative).toBeUndefined();
  });
});

describe('范围法术', () => {
  function room(): Campaign {
    const c = ambush();
    upsertCharacter(c, { name: '奇塔露', maxHp: 30, ac: 13 });
    upsertCharacter(c, { name: '蛛2', kind: 'monster', maxHp: 26, ac: 14, room: c.currentRoom });
    startInitiative(c, () => 10);
    // 跟 20 号祭司居所一样：两只怪各贴着一个队友
    setPositions(c, [
      { name: '狼', x: 2, y: 4 }, { name: '乙', x: 2, y: 5 },
      { name: '蛛2', x: 6, y: 3 }, { name: '甲', x: 6, y: 4 },
      { name: '奇塔露', x: 7, y: 9 },
    ]);
    return c;
  }

  it('火球圈住两只怪时也圈住了贴身的队友，并提醒别说「队友进不去」', () => {
    const text = areaReport(room(), { shape: 'sphere', size: 20, x: 3, y: 1, caster: '奇塔露' });
    expect(text).toContain('敌方：狼、蛛2');
    expect(text).toContain('己方：甲、乙');
    expect(text).toContain('别说「队友一个都进不去」');
  });

  it('立方从西北角算，线从施法者往外走满长度', () => {
    const c = room();
    expect(areaReport(c, { shape: 'cube', size: 10, x: 1, y: 3, caster: '奇塔露' })).toContain('敌方：狼\n- 己方：无');
    expect(areaReport(c, { shape: 'line', size: 30, at: '蛛2', caster: '奇塔露' })).toMatch(/敌方：蛛2/);
    expect(() => areaReport(c, { shape: 'line', size: 30, x: 3, y: 3 })).toThrow(/caster/);
  });
});

describe('停团兜底摘要', () => {
  it('交接优先用账本里的剧情，旧摘要保留全文、不再层层套兜底', () => {
    const c = { summaries: [], log: [], chronicle: [], sessionStartedAt: 100 } as unknown as Campaign;
    addSummary(c, '（停团时没写进度，以下是自动整理的最近记录）\n上次停在冶炼洞窟', 50);
    c.chronicle!.push(
      { id: 1, at: 40, kind: 'event', text: '很早以前的事' },
      { id: 2, at: 120, kind: 'event', text: '内兹纳 死亡' },
      { id: 3, at: 130, kind: 'event', text: '击败：巨蛛1' },
    );
    c.log.push('短休：全员', '维斯珀 恢复 3 点 HP');
    expect(ensureSessionSummary(c, 200)).toBe(true);
    const text = `${c.summaries.at(-1)!.text}\n${c.handoff!.changes.join('\n')}`;
    expect(text).toContain('- 内兹纳 死亡');
    expect(text).toContain('上次停在冶炼洞窟');
    expect(text).not.toContain('很早以前的事');
    expect(text).not.toContain('短休');
    expect(text.match(/停团时没写进度/g)).toHaveLength(1);
  });
});

describe('工具', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'dnd-combat-fixes-'));
    const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root, roller: () => 10 });
    const key = 'group:G1';
    service.start(key, 'sunken-bell', false);
    service.store.update(key, (c) => {
      upsertCharacter(c, { name: 'Kriv', player: 'tty', playerId: 'P2', maxHp: 20, ac: 16 });
      // srd 建出来的怪就是这样：卡面有攻击加值和伤害，没有武器列表
      upsertCharacter(c, { name: '狼', kind: 'monster', maxHp: 30, ac: 13, attackBonus: 5, damage: '1d8+3', room: c.currentRoom });
    });
    const record = { sessionKey: key, scope: 'group', peerId: 'G1', replyTarget: { scope: 'group', targetId: 'G1' }, recentSenders: [{ id: 'P2', at: Date.now() }] };
    const manager = { sessionKey: (_s: string, gid: string) => `group:${gid}`, getSessionRecord: () => record, findByAgent: () => record, dndService: service };
    const tools = new Map<string, { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> }>();
    const ctx = { get: () => ({ register: (d: { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> }) => tools.set(d.name, d) }) };
    registerDndTools(ctx as never, { service, manager: manager as never, logger: logger as never, sendImage: vi.fn() });
    const call = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.execute(args, { agent: {} })).text;
    return { call };
  }

  it('没有武器列表的怪报武器名时用卡面数值，武器名只当描述', async () => {
    const { call } = setup();
    const text = await call('dnd_check', { type: 'attack', character: '狼', target: 'Kriv', weapon: '咬' });
    expect(text).toContain('狼（咬） 攻击 Kriv：d20[10] + 5 = 15');
  });

  it('start 传 surprised：提示里说明由工具跳过', async () => {
    const { call } = setup();
    const text = await call('dnd_initiative', { action: 'start', surprised: ['Kriv'] });
    expect(text).toContain('【突袭】');
    expect(text).toContain('轮到 狼');
  });
});
