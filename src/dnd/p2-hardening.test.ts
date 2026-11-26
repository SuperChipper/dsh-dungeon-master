import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdventureLibrary, adventureWarnings, validateAdventure } from './adventure.ts';
import { CampaignStore, findCharacter, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { pendingTriggers, roomCard } from './story.ts';
import { isDndAutoRecallCandidate } from '../session/session-manager.ts';

function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-p2-'));
  const advDir = join(root, 'adventures');
  mkdirSync(advDir, { recursive: true });
  const advJson = {
    id: 'p2-tomb',
    name: 'P2 验收古墓',
    truth: ['红袍法师正在古墓外收集方块。'],
    hook: '开场。',
    start: 'hall',
    chapters: [{ id: 'ch1', name: '古墓', mode: 'dungeon', goal: '探索', dmGuide: '' }],
    flags: [{ id: 'door-open', label: '二门已开' }, { id: 'pit-sprung', label: '陷坑已发' }],
    sites: [{
      id: 'tomb',
      name: '九神墓',
      chapter: 'ch1',
      entry: 'hall',
      rooms: [{
        id: 'hall',
        name: '假墓穴',
        x: 0, y: 0, w: 4, h: 4,
        playerView: '沙漏与墙边拉杆。',
        dmNotes: '二门下沉与拉杆陷坑互斥。',
        exits: [],
        triggers: [
          { id: 'door-open-trig', when: '沙漏流完二门沉下开启', then: '二门打开', set: ['door-open'], mutex: ['pit-trig'] },
          { id: 'pit-trig', when: '强行拉动墙边拉杆', then: '地板翻开落入陷坑', set: ['pit-sprung'] },
        ],
      }],
    }],
    npcs: [{
      id: 'zagmira',
      name: '扎格米拉',
      role: '红袍法师首领',
      look: '身披红袍的塞尔女法师',
      motive: '夺取灵魂容器',
      home: { room: 'hall' },
      attitude: 'hostile',
      stat: {
        srd: 'mage',
        name: '扎格米拉',
        count: 1,
        hp: 40,
        ac: 12,
        initBonus: 2,
        attackBonus: 6,
        damage: '1d4+1',
        resources: {
          '1环法术位': 4,
          '3环法术位': { max: 3, reset: 'long' },
        },
        notes: '高阶红袍施法者',
      },
      spellbook: ['法师护甲', '火球术', '解除魔法', '法术反制', '飞行术'],
      escort: [
        { name: '塞尔护卫', count: 2, hp: 33, ac: 16, initBonus: 1, attackBonus: 5, damage: '1d8+3', notes: '持长剑盾牌' },
      ],
      knows: [],
    }],
    leads: [],
    quests: [],
  };
  writeFileSync(join(advDir, 'p2-tomb.json'), JSON.stringify(advJson));

  const service = new DndService({
    store: new CampaignStore(join(root, 'campaigns')),
    library: new AdventureLibrary({ adventures: advDir }),
    mapDir: root,
    roller: () => 10,
  });
  const key = 'group:P2';
  service.start(key, 'p2-tomb', false);
  service.store.update(key, (c) => {
    c.begun = true;
    upsertCharacter(c, { name: '卡厄斯', kind: 'pc', maxHp: 40, hp: 20, hitDie: 'd10', level: 4 });
  });

  const defs = new Map<string, { execute(args: unknown, exec: unknown): Promise<{ text: string }> }>();
  const record = { sessionKey: key, agent: {}, recentSenders: [] };
  registerDndTools(
    { get: () => ({ register: (d: { name: string; execute(a: unknown, e: unknown): Promise<{ text: string }> }) => defs.set(d.name, d) }) } as never,
    { service, manager: { findByAgent: () => record } as never, logger: { info() {}, warn() {}, debug() {}, error() {} } },
  );
  const call = async (name: string, args: object) => (await defs.get(name)!.execute(args, { agent: record.agent })).text;
  return { service, key, call, advJson };
}

describe('P2 模组拆解规范：互斥触发器、法术书/预设法术位/随行护卫与验收警告', () => {
  it('mutex 触发器双向互斥生效：任一触发后锁定对方并隐藏出待触发列表', async () => {
    const { service, key, call } = setupFixture();
    await call('dnd_story', { action: 'trigger', id: 'pit-trig' });
    // 虽然只在 door-open-trig 上声明了 mutex: ['pit-trig']，双向检查仍拦截 door-open-trig
    await expect(call('dnd_story', { action: 'trigger', id: 'door-open-trig' })).rejects.toThrow(/互斥/);
    const { campaign, adventure } = service.require(key);
    expect(pendingTriggers(campaign, adventure, 'hall')).toEqual([]);
    expect(roomCard(campaign, adventure, adventure.sites[0]!.rooms[0]!)).toContain('与 pit-trig 互斥已锁');
  });

  it('validateAdventure 拦截非法 mutex；adventureWarnings 巡检无约束可重复机关与缺法术书/裸 SRD 施法者', () => {
    const { advJson } = setupFixture();
    const valid = validateAdventure(structuredClone(advJson));
    expect(adventureWarnings(valid)).toEqual([]);

    const badMutex = structuredClone(advJson);
    badMutex.sites[0]!.rooms[0]!.triggers[0]!.mutex = ['no-such-trigger'];
    expect(() => validateAdventure(badMutex)).toThrow(/不存在的触发器/);

    const selfMutex = structuredClone(advJson);
    selfMutex.sites[0]!.rooms[0]!.triggers[0]!.mutex = ['door-open-trig'];
    expect(() => validateAdventure(selfMutex)).toThrow(/不能指向自己/);

    const sloppy = structuredClone(advJson) as Record<string, unknown>;
    const rooms = ((sloppy.sites as Array<{ rooms: Array<{ triggers: Array<Record<string, unknown>> }> }>)[0]!.rooms);
    rooms[0]!.triggers = [
      { id: 't1', when: '门开', then: '开了', once: false },
      { id: 't2', when: '掉坑', then: '掉了', once: false },
    ];
    sloppy.npcs = [
      {
        id: 'bare-mage',
        name: '裸法师',
        role: '红袍法师',
        look: '红袍',
        motive: '抢宝',
        home: { room: 'hall' },
        attitude: 'hostile',
        stat: { srd: 'mage' },
        knows: [],
      },
    ];
    const warnings = adventureWarnings(validateAdventure(sloppy));
    expect(warnings.some((w) => w.includes('互斥机关请补充 mutex'))).toBe(true);
    expect(warnings.some((w) => w.includes('裸 SRD 模板'))).toBe(true);
    expect(warnings.some((w) => w.includes('未写 spellbook'))).toBe(true);
  });

  it('具名施法者 NPC 展示 spellbook 与护卫，fight=true 自动写入法术位并同步刷出 escort', async () => {
    const { service, key, call } = setupFixture();
    const card = await call('dnd_lookup', { kind: 'npc', id: 'zagmira' });
    expect(card).toContain('法术书（可抄/随身法术清单）：法师护甲、火球术、解除魔法、法术反制、飞行术');
    expect(card).toContain('预设法术位/资源：1环法术位 4/4、3环法术位 3/3');
    expect(card).toContain('随行护卫（fight=true 自动出场）：塞尔护卫×2');

    const fightOut = await call('dnd_story', { action: 'npc', id: 'zagmira', fight: true });
    expect(fightOut).toContain('随行护卫同步出场');
    expect(fightOut).toContain('塞尔护卫1');
    expect(fightOut).toContain('塞尔护卫2');
    expect(fightOut).toContain('持有法术书（共 5 门法术');

    const c = service.require(key).campaign;
    const boss = findCharacter(c, '扎格米拉')!;
    expect(boss.resources?.['1环法术位']).toEqual({ current: 4, max: 4, reset: 'long' });
    expect(boss.resources?.['3环法术位']).toEqual({ current: 3, max: 3, reset: 'long' });
    expect(findCharacter(c, '塞尔护卫1')).toBeDefined();
    expect(findCharacter(c, '塞尔护卫2')).toBeDefined();
  });
});

describe('P2 细节加固：停团 chronicle 放行、dnd_rest 严校验与跑团期笔记降噪', () => {
  it('停团期允许 dnd_chronicle add kind=ruling|backstory，拒绝 event/promise/close 且保持停团态', async () => {
    const { service, key, call } = setupFixture();
    service.stop(key);

    const ruling = await call('dnd_chronicle', { action: 'add', kind: 'ruling', text: '时间充裕默认挂引导术' });
    expect(ruling).toContain('已记：');
    const backstory = await call('dnd_chronicle', { action: 'add', kind: 'backstory', text: '丛云寻找父亲重锻之剑' });
    expect(backstory).toContain('已记：');
    expect(service.store.load(key)!.active).toBe(false);

    await expect(call('dnd_chronicle', { action: 'add', kind: 'event', text: '进古墓打赢了' })).rejects.toThrow(/只允许补记/);
    await expect(call('dnd_chronicle', { action: 'add', text: '省略 kind 默认是 event' })).rejects.toThrow(/只允许补记/);
    await expect(call('dnd_chronicle', { action: 'close', id: 1 })).rejects.toThrow(/没有进行中的团/);
  });

  it('dnd_rest 校验非法参数与未知键名，拒绝静默降级为短休', async () => {
    const { call, service, key } = setupFixture();
    await expect(call('dnd_rest', { type: 'long' })).rejects.toThrow(/不认识的参数 type/);
    await expect(call('dnd_rest', { kind: 'full' })).rejects.toThrow(/kind 只能是 "short" 或 "long"/);
    await expect(call('dnd_rest', { kind: 'long', hit_dice: { 卡厄斯: 1 } })).rejects.toThrow(/不能传 hit_dice/);
    // 校验失败时角色血量保持不变
    expect(findCharacter(service.require(key).campaign, '卡厄斯')!.hp).toBe(20);

    const ok = await call('dnd_rest', { kind: 'long' });
    expect(ok).toContain('长休完成');
    expect(findCharacter(service.require(key).campaign, '卡厄斯')!.hp).toBe(40);
  });

  it('跑团活跃期自动召回屏蔽纯闲聊/表情包/观察日记笔记，保留 dnd 场景与跑团主题笔记', () => {
    expect(isDndAutoRecallCandidate({
      file: 'shared/表情包.md',
      heading: '平涂大肥鱼表情包来源小红书',
      meta: { kind: 'fact', scope: {}, inject: 'auto', status: 'active' },
    })).toBe(false);

    expect(isDndAutoRecallCandidate({
      file: 'shared/人类观察日记014.md',
      heading: '颂展神·晨课合集',
      meta: { kind: 'fact', scope: { scenes: ['group'] }, inject: 'auto', status: 'active' },
    })).toBe(false);

    expect(isDndAutoRecallCandidate({
      file: 'shared/table-prefs.md',
      heading: '本桌习惯',
      meta: { kind: 'preference', scope: { scenes: ['group', 'dnd'] }, inject: 'auto', status: 'active' },
    })).toBe(true);

    expect(isDndAutoRecallCandidate({
      file: 'shared/跑团入门.md',
      heading: '团规约定',
      meta: { kind: 'rule', scope: {}, inject: 'auto', status: 'active' },
    })).toBe(true);
  });
});
