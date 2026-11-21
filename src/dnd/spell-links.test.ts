import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { AdventureLibrary, adventureFromDungeon } from './adventure.ts';
import { type Campaign, CampaignStore, createCampaign, findCharacter, setResource, upsertCharacter } from './campaign.ts';
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

  it('回合弹窗的「法术/能力」：谁点列谁的，且支持职业动作与旧卡自动兜底', async () => {
    const t = setup();
    await t.call('dnd_resource', { action: 'set', character: 'Kriv', resource: '诗人激励', max: 3, reset: 'short' });
    await t.call('dnd_character', {
      action: 'update',
      name: 'Kriv',
      reactions: [{ name: '尖刻言语', when: 'foe_attacks', resource: '诗人激励' }],
    });
    await t.call('dnd_character', {
      action: 'update',
      name: '恩佐',
      spells: [
        { name: '魔能爆', level: 0 },
        { name: '咒剑诅咒', kind: 'feature', action: 'bonus', summary: '30尺1目标，19-20重击+熟练加伤' },
      ],
    });
    const row = buildTurnKeyboard('Kriv', 1).content.rows[1]!.buttons.map((b) => b.render_data.label);
    // 第二行只剩两个，手机上不会被截断
    expect(row).toEqual(['行动', '法术/能力']);

    expect(t.press({ a: 'spells', n: 'Kriv' }, 'P1')).toBe(ACK.ok);
    await Promise.resolve();
    const enzoMsg = t.sender.sendMarkdown.mock.calls[0]![1] as string;
    expect(enzoMsg).toContain('🔮 **恩佐** 的法术与能力');
    expect(enzoMsg).toContain('**职业与物品能力**');
    expect(enzoMsg).toContain('咒剑诅咒 [附赠] — 30尺1目标，19-20重击+熟练加伤');

    // Kriv 没显式填 spells，但旧卡有 resources 和 reactions，点按钮自动兜底列出
    expect(t.press({ a: 'spells', n: 'Kriv' }, 'P2')).toBe(ACK.ok);
    await Promise.resolve();
    const krivMsg = t.sender.sendMarkdown.mock.calls[1]![1] as string;
    expect(krivMsg).toContain('🔮 **Kriv** 的法术与能力');
    expect(krivMsg).toContain('尖刻言语 [反应]（诗人激励 3/3）');
    expect(krivMsg).toContain('诗人激励（3/3，短休回）');
  });

  it('新资源同步：同名资源不被同名法术吞掉、新环位无条目法术位照常展示、简称模糊匹配、生命骰去重与冷启动点按钮', async () => {
    // 1. 已有法术（如 脆弱诅咒 1环）后通过 dnd_resource set 新增同名资源，按钮必须渲染余量而不是被吞掉
    const t = setup();
    await t.call('dnd_character', {
      action: 'update',
      name: '恩佐',
      spells: [{ name: '脆弱诅咒', level: 1, en: 'Hex' }],
    });
    await t.call('dnd_resource', { action: 'set', character: '恩佐', resource: '脆弱诅咒', max: 1, reset: 'none' });
    await t.call('dnd_resource', { action: 'set', character: '恩佐', resource: '4环法术位', max: 1, reset: 'long' });
    await t.call('dnd_resource', { action: 'set', character: '恩佐', resource: '2 环法术位', max: 3, current: 2, reset: 'long' });
    await t.call('dnd_resource', { action: 'set', character: '恩佐', resource: '生命骰', max: 6, reset: 'long' });
    await t.call('dnd_resource', { action: 'set', character: '恩佐', resource: '生命骰 d8', max: 7, current: 6, reset: 'long' });

    expect(t.press({ a: 'spells', n: '恩佐' }, 'P1')).toBe(ACK.ok);
    await Promise.resolve();
    const enzoMsg = t.sender.sendMarkdown.mock.calls.at(-1)![1] as string;
    expect(enzoMsg).toContain('脆弱诅咒（脆弱诅咒 1/1）');
    expect(enzoMsg).toContain('**2 环**　2/3');
    expect(enzoMsg).toContain('**4 环**　1/1');
    expect(enzoMsg).toContain('暂无该环法术记录');
    expect(enzoMsg).toContain('生命骰 d8（6/7，长休回）');
    expect(enzoMsg).not.toContain('· 生命骰（6/6');
    expect(spellListText('奇塔露', [{ name: '命运宠儿', level: 2 }], { 命运宠儿: { current: 1, max: 1, reset: 'none' } }, { includeFallback: true }))
      .toContain('命运宠儿（命运宠儿 1/1）');

    // 2. 只有新加的法术位、尚未录入 spells 条目时，也不报空卡提示
    const slotOnly = spellListText('奇塔露', [], { '4环法术位': { current: 1, max: 1, reset: 'long' } });
    expect(slotOnly).toContain('**4 环**　1/1');
    expect(slotOnly).toContain('暂无该环法术记录');
    expect(slotOnly).not.toContain('还没有法术或能力清单');

    // 3. 能力与反应传资源简称也能模糊匹配并显示实时余量
    const fuzzy = spellListText(
      'Kriv',
      [{ name: '激励', level: 0, kind: 'feature', action: 'bonus', resource: '诗人' }],
      { 诗人激励: { current: 2, max: 3, reset: 'short' } },
      { includeFallback: true, reactions: [{ name: '尖刻言语', when: 'foe_attacks', resource: '诗人' }] },
    );
    expect(fuzzy).toContain('激励 [附赠]（诗人激励 2/3）');
    expect(fuzzy).toContain('尖刻言语 [反应]（诗人激励 2/3）');
    expect(fuzzy).not.toContain('耗诗人');

    // 4. 冷启动（getSessionRecord 返回 undefined）点「法术/能力」依然能按最新资源发出
    const service = new DndService({
      store: new CampaignStore(mkdtempSync(join(tmpdir(), 'dnd-coldspells-'))),
      library: new AdventureLibrary(),
      mapDir: tmpdir(),
    });
    const coldKey = 'group:COLD';
    service.start(coldKey, 'sunken-bell', false);
    service.store.update(coldKey, (c) => {
      upsertCharacter(c, {
        name: 'Kriv',
        playerId: 'P2',
        maxHp: 30,
      });
      setResource(c, 'Kriv', '诗人激励', 3, 'short', 2);
    });
    const coldSender = { sendMarkdown: vi.fn(() => Promise.resolve()) };
    const coldButtons = new DndTurnButtons(
      service,
      { sessionKey: (_s: string, gid: string) => `group:${gid}`, getSessionRecord: () => undefined } as never,
      coldSender,
      logger as never,
    );
    expect(coldButtons.handleInteraction({
      id: 'cold-1', type: 11, version: 1, group_openid: 'COLD', group_member_openid: 'P2',
      data: { type: 11, resolved: { button_data: JSON.stringify({ t: 'dnd', a: 'spells', n: 'Kriv' }) } },
    } as InteractionEvent)).toBe(ACK.ok);
    await Promise.resolve();
    expect(coldSender.sendMarkdown).toHaveBeenCalledWith(
      { scope: 'group', targetId: 'COLD' },
      expect.stringContaining('诗人激励（2/3，短休回）'),
    );
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
