import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { AdventureLibrary, adventureFromDungeon } from './adventure.ts';
import { type Campaign, CampaignStore, createCampaign, findCharacter, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { partySizeHint, registerDndTools } from './dnd-tools.ts';
import { SUNKEN_BELL } from './dungeons/sunken-bell.ts';
import { type UrlCheck, huijiSearchUrl, mergeSpells, resolveSpells, spellListText, wikidotSlug } from './spell-links.ts';
import { ACK, DndTurnButtons, buildTurnKeyboard } from './turn-buttons.ts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };

/** 只认这几个词条，其余 404 */
const wiki = (known: string[]): UrlCheck => vi.fn(async (url: string) => (known.some((k) => url.endsWith(`spell:${k}`)) ? 'ok' : 'missing'));
const SRD = (name: string): string | undefined => ({ 魔能爆: 'eldritch-blast', 恶言相加: 'vicious-mockery', 塔莎狂笑术: 'hideous-laughter' } as Record<string, string>)[name];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('法术链接', () => {
  it('中文名走 SRD 表，表里没有的用 en；wikidot 404 的一次全报出来', async () => {
    const check = wiki(['eldritch-blast', 'hex']);
    const { spells } = await resolveSpells([{ name: '魔能爆', level: 0 }, { name: '脆弱诅咒', level: 1, en: 'Hex' }], SRD, check);
    expect(spells.map((s) => s.wiki)).toEqual(['https://dnd5e.wikidot.com/spell:eldritch-blast', 'https://dnd5e.wikidot.com/spell:hex']);
    expect(spells.every((s) => s.verified)).toBe(true);

    // SRD 的 index 叫 hideous-laughter，wikidot 叫 tashas-hideous-laughter；对不上的和没给 en 的都要报
    await expect(resolveSpells([{ name: '塔莎狂笑术', level: 1 }, { name: '咒火', level: 0 }], SRD, wiki([])))
      .rejects.toThrow(/塔莎狂笑术[\s\S]*不存在[\s\S]*咒火」对不上/);
  });

  it('网络不通时先存着，不拦写卡', async () => {
    const { spells, notes } = await resolveSpells([{ name: '恶言相加', level: 0 }], SRD, async () => 'unknown');
    expect(spells[0]).toMatchObject({ name: '恶言相加', verified: false });
    expect(notes[0]).toContain('没验上');
  });

  it('英文名转 wikidot 地址：撇号去掉、空格变连字符', () => {
    expect(wikidotSlug("Tasha's Hideous Laughter")).toBe('tashas-hideous-laughter');
  });

  it('合并：同名覆盖，按环位排；删卡上没有的报错', () => {
    const merged = mergeSpells([{ name: '魔能爆', level: 0 }, { name: '脆弱诅咒', level: 1 }], [{ name: '暗示术', level: 2 }], ['脆弱诅咒']);
    expect(merged.map((s) => s.name)).toEqual(['魔能爆', '暗示术']);
    expect(() => mergeSpells([], [], ['火球术'])).toThrow(/没有这些法术/);
  });

  it('清单带法术位和两种链接；卡上没有法术时告诉玩家找 DM 补', () => {
    const text = spellListText('恩佐', [
      { name: '魔能爆', level: 0, wiki: 'https://dnd5e.wikidot.com/spell:eldritch-blast' },
      { name: '催眠图纹', level: 3, wiki: 'https://dnd5e.wikidot.com/spell:hypnotic-pattern' },
    ], { '契约法术位（3环）': { current: 1, max: 2, reset: 'short' }, 妖精仪态: { current: 1, max: 1, reset: 'short' } });
    // 法术位跟在每一环后面，不在标题上汇总
    expect(text).toContain('**3 环**　契约 1/2');
    expect(text).toContain('**戏法**\n');
    expect(text).not.toContain('妖精仪态');
    expect(text).toContain(huijiSearchUrl('魔能爆'));
    expect(text).toContain('spell:eldritch-blast');
    // 走 sendMarkdown，所以是行内链接：屏幕上只剩「中 / 英」两个字，不再贴裸 URL
    expect(text).toContain(`[中](${huijiSearchUrl('魔能爆')})`);
    expect(text).toContain('[英](https://dnd5e.wikidot.com/spell:eldritch-blast)');
    expect(text).not.toContain('中文 https');
    expect(text).not.toContain('英文 https');
    expect(spellListText('Kriv', [])).toContain('dnd_character update spells');
  });
});

describe('工具和按钮', () => {
  function setup() {
    // SRD 索引取不到时只用中文名表，不联网
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const root = mkdtempSync(join(tmpdir(), 'dnd-spells-'));
    const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root, roller: () => 10 });
    const key = 'group:G1';
    service.start(key, 'sunken-bell', false);
    service.store.update(key, (c) => {
      upsertCharacter(c, { name: '恩佐', player: 'fries', playerId: 'P1', maxHp: 33, ac: 16 });
      upsertCharacter(c, { name: 'Kriv', player: 'tty', playerId: 'P2', maxHp: 31, ac: 16 });
    });
    const record = { sessionKey: key, scope: 'group', peerId: 'G1', replyTarget: { scope: 'group', targetId: 'G1' }, recentSenders: [], agent: { followup: vi.fn(), whenIdle: () => Promise.resolve() } };
    const manager = { sessionKey: (_s: string, gid: string) => `group:${gid}`, getSessionRecord: () => record, findByAgent: () => record, dndService: service };
    const tools = new Map<string, Tool>();
    const ctx = { get: () => ({ register: (d: Tool) => tools.set(d.name, d) }) };
    registerDndTools(ctx as never, { service, manager: manager as never, logger: logger as never, sendImage: vi.fn(), checkUrl: wiki(['eldritch-blast', 'hex']) });
    const call = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.execute(args, { agent: {} })).text;
    const sender = { sendMarkdown: vi.fn(() => Promise.resolve()) };
    const buttons = new DndTurnButtons(service, manager as never, sender, logger as never);
    const press = (data: object, clicker: string): number | undefined => buttons.handleInteraction({
      id: 'e1', type: 11, version: 1, group_openid: 'G1', group_member_openid: clicker,
      data: { type: 11, resolved: { button_data: JSON.stringify({ t: 'dnd', ...data }) } },
    } as InteractionEvent);
    const campaign = (): Campaign => service.store.load(key)!;
    return { call, press, sender, campaign };
  }

  it('写卡时验链接，验不过整张卡不动；卡面多一行法术', async () => {
    const t = setup();
    await expect(t.call('dnd_character', { action: 'update', name: '恩佐', max_hp: 40, spells: [{ name: '脆弱诅咒', level: 1 }] }))
      .rejects.toThrow(/给 en/);
    expect(findCharacter(t.campaign(), '恩佐')!.maxHp).toBe(33);

    const text = await t.call('dnd_character', { action: 'update', name: '恩佐', spells: [{ name: '魔能爆', level: 0 }, { name: '脆弱诅咒', level: 1, en: 'Hex' }] });
    expect(text).toContain('法术：戏法 魔能爆；1 环 脆弱诅咒');
    await t.call('dnd_character', { action: 'update', name: '恩佐', remove_spells: ['脆弱诅咒'] });
    expect(findCharacter(t.campaign(), '恩佐')!.spells!.map((s) => s.name)).toEqual(['魔能爆']);
  });

  it('回合弹窗的「我的法术」：谁点列谁的', async () => {
    const t = setup();
    await t.call('dnd_character', { action: 'update', name: '恩佐', spells: [{ name: '魔能爆', level: 0 }] });
    const row = buildTurnKeyboard('Kriv', 1).content.rows[1]!.buttons.map((b) => b.render_data.label);
    // 第二行只剩两个，手机上不会被截成「我的…」
    expect(row).toEqual(['行动', '我的法术']);

    expect(t.press({ a: 'spells', n: 'Kriv' }, 'P1')).toBe(ACK.ok);
    await Promise.resolve();
    expect(t.sender.sendMarkdown.mock.calls[0]![1]).toContain('🔮 **恩佐** 的法术');
  });
});

describe('人数比模组多', () => {
  const BELL = adventureFromDungeon(SUNKEN_BELL);
  function table(n: number): Campaign {
    const c = createCampaign('group:abc', BELL);
    for (let i = 0; i < n; i++) upsertCharacter(c, { name: `PC${i}`, maxHp: 10, ac: 12 });
    return c;
  }

  it('6 人桌刷怪时给出调整上限和「先说一句、记 ruling」；不超过模组人数就不说', () => {
    const hint = partySizeHint(table(6), BELL)!;
    expect(hint).toContain('模组按 4 人写，本桌 6 人');
    expect(hint).toContain('小怪最多 9 只');
    expect(hint).toContain('kind=ruling');
    expect(partySizeHint(table(4), BELL)).toBeUndefined();
    expect(partySizeHint(table(6), { ...BELL, partySize: 6 })).toBeUndefined();
  });
});
