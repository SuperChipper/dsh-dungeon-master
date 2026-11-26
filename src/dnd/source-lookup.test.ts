import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdventureLibrary } from './adventure.ts';
import { CampaignStore, pushLog, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { MAX_SOURCE_CHARS, lookupModuleSource } from './source-lookup.ts';

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-source-lookup-'));
  const modDir = join(root, 'adventures', 'demo-toa');
  mkdirSync(join(modDir, 'text-zh', '九神之墓'), { recursive: true });
  mkdirSync(join(modDir, 'text-en'), { recursive: true });
  mkdirSync(join(modDir, 'data'), { recursive: true });
  mkdirSync(join(modDir, 'build'), { recursive: true });
  mkdirSync(join(modDir, 'img'), { recursive: true });

  writeFileSync(join(modDir, 'text-en', '00-索引.md'), '# Index\n- Chapter 5: Tomb of the Nine Gods\n- Trickster Gods\n');
  writeFileSync(join(modDir, 'text-en', '06-Chapter 5.md'), '# Chapter 5\n## Trickster Gods\nEnglish lore text.\n');
  writeFileSync(join(modDir, 'text-zh', '九神之墓', '第五章：九神之墓.md'), [
    '# 第五章：九神之墓',
    '前言废话'.repeat(120),
    '## 2. 诡计长廊',
    '墙壁上刻着九位诡神的寓言。安珂的黄金吊坠挂在石像颈间，鉴定可得其阵营为守序善良，佩戴者获得 10 尺盲视。',
    '## 4B. 假墓穴与沙漏',
    '沙漏开始流逝时，二门逐渐下沉；若强行拉动墙边拉杆，地板翻开落入陷坑。',
    '## 超长条目测试',
    '这是一段非常长的原书表格与说明文字，用于验证单次检索的硬字数截断保护。'.repeat(250),
  ].join('\n'));
  writeFileSync(join(modDir, 'text-zh', '九神之墓', '附录F：诡神.md'), [
    '# 附录 F：奥姆城诡神',
    '## 安珂 I\'jin',
    '阵营：混乱中立；宿敌：奥博拉卡。赋予敏捷 23。',
    '## 奥博拉卡 Obo\'laka',
    '阵营：守序中立；宿敌：安珂。赋予同调上限 +1。',
  ].join('\n'));
  writeFileSync(join(modDir, 'data', 'bestiary.json'), JSON.stringify({
    monsters: [
      { name: '扎格米拉 Zagmira', spellbook: ['火球术', '解除魔法', '法师护甲', '法术反制'] },
    ],
  }, null, 2));
  writeFileSync(join(modDir, 'build', '50-tomb.json'), '{"secret":"ignored"}');
  writeFileSync(join(modDir, 'img', 'map.png'), 'png');
  writeFileSync(join(modDir, '_source.json'), '{"raw":true}');
  writeFileSync(join(modDir, 'adventure.json'), JSON.stringify({
    id: 'demo-toa',
    name: '示例目录模组',
    truth: ['底层秘密'],
    hook: '开场',
    start: 'r1',
    chapters: [{ id: 'ch1', name: '第一章', mode: 'dungeon', goal: '探索' }],
    sites: [{
      id: 's1',
      name: '墓穴',
      chapter: 'ch1',
      entry: 'r1',
      rooms: [
        { id: 'r1', name: '入口', x: 0, y: 0, w: 2, h: 2, playerView: '入口', dmNotes: '入口笔记', exits: [{ to: 'r2', label: '北门' }] },
        { id: 'r2', name: '诡计长廊', x: 0, y: 2, w: 2, h: 2, playerView: '长廊', dmNotes: '长廊笔记', exits: [] },
      ],
    }],
    npcs: [], leads: [], quests: [], flags: [],
  }));

  const service = new DndService({
    store: new CampaignStore(join(root, 'campaigns')),
    library: new AdventureLibrary({ adventures: join(root, 'adventures') }),
    mapDir: root,
    cwd: root,
  });
  const key = 'group:G-SRC';
  service.start(key, 'demo-toa', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: '奇塔露', maxHp: 30 });
    for (let i = 1; i <= 12; i++) pushLog(c, `很长的历史日志记录第${i}条：用于对比备团全量与速览输出体积`);
  });

  const defs = new Map<string, { execute(args: unknown, exec: unknown): Promise<{ text: string }> }>();
  const record = { sessionKey: key, agent: {}, recentSenders: [] };
  registerDndTools(
    { get: () => ({ register: (d: { name: string; execute(a: unknown, e: unknown): Promise<{ text: string }> }) => defs.set(d.name, d) }) } as never,
    { service, manager: { findByAgent: () => record } as never, logger: { info() {}, warn() {}, debug() {}, error() {} } },
  );
  const call = async (name: string, args: object) => (await defs.get(name)!.execute(args, { agent: record.agent })).text;
  return { root, modDir, service, key, call };
}

describe('dnd_lookup(kind="source") 与 dnd_prepare(brief=true)', () => {
  it('列出可读原书清单并自动过滤内部构建文件与图片，优先中文目录并附索引预览', async () => {
    const { call } = buildFixture();
    const list = await call('dnd_lookup', { kind: 'source' });
    expect(list).toContain('text-zh/九神之墓/第五章：九神之墓.md');
    expect(list).toContain('data/bestiary.json');
    expect(list).toContain('索引预览');
    expect(list).not.toContain('adventure.json');
    expect(list).not.toContain('build/');
    expect(list).not.toContain('img/');
    expect(list).not.toContain('_source.json');
    expect(list.length).toBeLessThanOrEqual(MAX_SOURCE_CHARS);
  });

  it('按关键词精确命中中文小节并硬限 3000 字，防止裸 grep 灌爆上下文', async () => {
    const { call } = buildFixture();
    const hit = await call('dnd_lookup', { kind: 'source', query: '诡计长廊 吊坠' });
    expect(hit).toContain('2. 诡计长廊');
    expect(hit).toContain('安珂的黄金吊坠');
    expect(hit).not.toContain('English lore text');
    expect(hit.length).toBeLessThanOrEqual(MAX_SOURCE_CHARS);

    // 命中超长小节时严格截断在 MAX_SOURCE_CHARS 以内
    const capped = await call('dnd_lookup', { kind: 'source', id: '第五章', query: '超长条目测试' });
    expect(capped).toContain('超长条目测试');
    expect(capped.length).toBeLessThanOrEqual(MAX_SOURCE_CHARS);

    // 支持 data/*.json 关键词检索与 offset 翻页
    const jsonHit = await call('dnd_lookup', { kind: 'source', id: 'bestiary.json', query: '扎格米拉' });
    expect(jsonHit).toContain('解除魔法');
    const paged = await call('dnd_lookup', { kind: 'source', id: '附录F', offset: 3 });
    expect(paged).toContain('阵营：混乱中立');
  });

  it('拒绝跨目录路径穿越，无原书目录的单文件模组返回清晰指引', async () => {
    const { call, modDir } = buildFixture();
    await expect(call('dnd_lookup', { kind: 'source', id: '../outside.md' })).rejects.toThrow(/非法文件路径/);
    expect(lookupModuleSource(undefined)).toContain('没有独立原书目录');
    expect(lookupModuleSource(modDir, { query: '完全不存在的词条xyz' })).toContain('未找到匹配');
  });

  it('dnd_prepare(action="show", brief=true) 显著短于完整视图，保留候选去向与原书入口', async () => {
    const { call } = buildFixture();
    const full = await call('dnd_prepare', { action: 'show' });
    const brief = await call('dnd_prepare', { action: 'show', brief: true });
    expect(brief).toContain('【备团速览 · DM 私有】');
    expect(brief).toContain('诡计长廊(r2，未去过)');
    expect(brief).toContain('dnd_lookup(kind="source"');
    expect(brief).not.toContain('近期完整日志');
    expect(brief.length).toBeLessThan(full.length);
  });
});
