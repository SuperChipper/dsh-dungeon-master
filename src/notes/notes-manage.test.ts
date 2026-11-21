import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { NotesStore, cutSection } from './notes-store.ts';
import { NoteMetricsStore } from './note-metrics.ts';
import { NOTES_MANAGE_TOOL_NAME, NOTES_SAVE_TOOL_NAME, NOTES_SEARCH_TOOL_NAME, registerNotesTools } from './notes-tools.ts';
import { pickNoteStats, renderNoteStats } from '../features/note-stats.ts';
import { notesCommand, parseNotesArgs } from '../commands/notes.ts';
import { SessionManager } from '../session/session-manager.ts';

const DIARY = [
  '# 观察日记',
  '',
  '卷首语',
  '',
  '## 001 第一条',
  '',
  '第一条正文',
  '',
  '## 002 第二条',
  '',
  '旧版正文',
  '',
  '## 002 第二条',
  '',
  '新版正文',
  '',
  '## 分组',
  '',
  '### 003 子条目',
  '',
  '子条目正文',
  '',
].join('\n');

type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<Record<string, unknown>> };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function setup(recordOrNull: Record<string, unknown> | null = { scope: 'c2c', peerId: 'OWNER' }) {
  const record = recordOrNull ?? undefined;
  const root = mkdtempSync(join(tmpdir(), 'notes-manage-'));
  mkdirSync(join(root, 'chats', 'group_G1'), { recursive: true });
  writeFileSync(join(root, '观察日记.md'), DIARY, 'utf8');
  writeFileSync(join(root, '单篇.md'), '# 单篇\n\n只有这一段内容', 'utf8');
  writeFileSync(join(root, 'chats', 'group_G1', '点歌.md'), '# 点歌\n\n群里的点歌约定', 'utf8');
  const store = new NotesStore(root);
  const metrics = new NoteMetricsStore(join(root, '.metrics.json'));
  const tools = new Map<string, Tool>();
  const ctx = { get: () => ({ register: (d: Tool) => tools.set(d.name, d) }) };
  const notes = { autoInject: true, injectTopK: 2, injectMaxChars: 600, judge: { enabled: true, muteBelow: 0.4 } };
  const manager = Object.assign(Object.create(SessionManager.prototype) as SessionManager, {
    findByAgent: () => record, noteMetrics: metrics, notesStore: store, config: { notes },
  });
  registerNotesTools(ctx as never, store, manager, logger as never, { ownerOpenid: 'OWNER' });
  const execCtx = (agentOver?: Record<string, unknown>) => (record === undefined && agentOver === undefined ? {} : { agent: agentOver ?? {} });
  const call = (args: Record<string, unknown>) => tools.get(NOTES_MANAGE_TOOL_NAME)!.execute(args, execCtx()) as Promise<{ message: string }>;
  const callSave = (args: Record<string, unknown>) => tools.get(NOTES_SAVE_TOOL_NAME)!.execute(args, execCtx());
  const callSearch = (args: Record<string, unknown>, agentOver?: Record<string, unknown>) => tools.get(NOTES_SEARCH_TOOL_NAME)!.execute(args, execCtx(agentOver));
  const archived = (): string[] => {
    const dir = join(root, '.archive');
    return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((name) => name.endsWith('.md')) : [];
  };
  return { root, store, metrics, call, callSave, callSearch, archived, manager, notes };
}

describe('cutSection', () => {
  it('切出一节，其余原样保留', () => {
    const cut = cutSection('观察日记.md', DIARY, '观察日记 › 001 第一条');
    expect(cut.removed).toBe('## 001 第一条\n\n第一条正文');
    expect(cut.rest).not.toContain('第一条正文');
    expect(cut.rest).toContain('卷首语');
    expect(cut.rest).toContain('新版正文');
  });

  it('同名小节不指定第几节时不动手，只报个数', () => {
    const cut = cutSection('观察日记.md', DIARY, '观察日记 › 002 第二条');
    expect(cut).toEqual({ matches: 2 });
    const first = cutSection('观察日记.md', DIARY, '观察日记 › 002 第二条', 1);
    expect(first.removed).toContain('旧版正文');
    expect(first.rest).toContain('新版正文');
    expect(first.rest).not.toContain('旧版正文');
  });

  it('下面挂着子小节时只切正文、保留标题行，子小节的路径不变', () => {
    const cut = cutSection('观察日记.md', DIARY, '观察日记', 1);
    expect(cut.removed).toContain('卷首语');
    expect(cut.rest!.startsWith('# 观察日记')).toBe(true);
    expect(cutSection('观察日记.md', cut.rest!, '观察日记 › 001 第一条').matches).toBe(1);
  });

  it('找不到返回 0', () => {
    expect(cutSection('观察日记.md', DIARY, '观察日记 › 不存在')).toEqual({ matches: 0 });
  });
});

describe('NotesStore.archive', () => {
  it('整篇归档：移进 .archive，不再被检索到', () => {
    const { root, store, archived } = setup();
    expect(store.search('只有这一段内容').length).toBe(1);
    const result = store.archive({ file: '单篇.md' });
    expect(result.fileRemoved).toBe(true);
    expect(existsSync(join(root, '单篇.md'))).toBe(false);
    expect(readFileSync(join(root, result.archivedTo), 'utf8')).toContain('只有这一段内容');
    expect(archived()).toHaveLength(1);
    expect(store.search('只有这一段内容')).toEqual([]);
  });

  it('小节归档：原文件留下其余部分，归档文件里带出处', () => {
    const { root, store } = setup();
    const result = store.archive({ file: '观察日记.md', heading: '观察日记 › 002 第二条', occurrence: 1 });
    expect(result.fileRemoved).toBe(false);
    const rest = readFileSync(join(root, '观察日记.md'), 'utf8');
    expect(rest).not.toContain('旧版正文');
    expect(rest).toContain('新版正文');
    const archive = readFileSync(join(root, result.archivedTo), 'utf8');
    expect(archive).toContain('归档自 观察日记.md › 观察日记 › 002 第二条');
    expect(archive).toContain('旧版正文');
  });

  it('同一天先归档小节再归档整篇：两次的内容都在，不互相覆盖', () => {
    const { root, store } = setup();
    const first = store.archive({ file: '观察日记.md', heading: '观察日记 › 001 第一条' });
    const second = store.archive({ file: '观察日记.md' });
    expect(second.archivedTo).toBe(first.archivedTo);
    const archive = readFileSync(join(root, first.archivedTo), 'utf8');
    expect(archive).toContain('第一条正文');
    expect(archive).toContain('新版正文');
    expect(existsSync(join(root, '观察日记.md'))).toBe(false);
  });

  it('只认索引里的文件：路径逃不出笔记目录，同名小节要指定第几节', () => {
    const { store } = setup();
    expect(() => store.archive({ file: '../外面.md' })).toThrow(/没有/);
    expect(() => store.archive({ file: '.metrics.json' })).toThrow(/没有/);
    expect(() => store.archive({ file: '观察日记.md', heading: '观察日记 › 002 第二条' })).toThrow(/occurrence/);
    expect(() => store.archive({ file: '观察日记.md', heading: '不存在' })).toThrow(/没有标题路径/);
  });
});

describe('qqbot_notes_manage', () => {
  it('只有主人私聊和本机会话能用', async () => {
    await expect(setup({ scope: 'group', peerId: 'G1' }).call({ action: 'stats' })).rejects.toThrow(/主人私聊/);
    await expect(setup({ scope: 'c2c', peerId: 'SOMEONE' }).call({ action: 'stats' })).rejects.toThrow(/主人私聊/);
    await expect(setup(null).call({ action: 'stats' })).resolves.toBeDefined();
  });

  it('stats 列出注入和均分', async () => {
    const { metrics, call } = setup();
    metrics.recordInjection([{ file: '单篇.md', heading: '单篇', score: 3 }, { file: '观察日记.md', heading: '观察日记', score: 1 }]);
    metrics.recordJudgement([{ file: '单篇.md', heading: '单篇' }, { file: '观察日记.md', heading: '观察日记' }], [0, 1], { minSamples: 8, muteBelow: 0 });
    const { message } = await call({ action: 'stats' });
    expect(message).toContain('2 段、共注入 2 次');
    // 均分低的排前面
    expect(message.indexOf('单篇.md › 单篇')).toBeLessThan(message.indexOf('观察日记.md › 观察日记'));
    expect(message).toContain('均分 0.00（评 1 次）');
  });

  it('两个低分入口只列当前可注入的小节，不会更新账本或改变历史视图', async () => {
    const { root, store, metrics, manager, notes, call } = setup();
    const archived = { file: '观察日记.md', heading: '观察日记 › 001 第一条' };
    const add = (name: string, meta = '') => {
      const file = `${name}.md`;
      writeFileSync(join(root, file), `# ${name}\n\n${meta}\n\n内容：${name}。`, 'utf8');
      return { file, heading: name };
    };
    const searchOnly = add('仅检索', '> 注入：仅检索');
    const zeroBudget = add('零预算', '> 预算：0');
    const outdated = add('过期结论', '> 状态：已过期');
    const manual = add('手动静音');
    const auto = add('仍自动静音');
    const updated = add('已修订笔记');
    const active = { file: '单篇.md', heading: '单篇' };
    const filtered = [archived, searchOnly, zeroBudget, outdated, manual, auto];
    const entries = [...filtered, updated, active];
    metrics.recordInjection(entries.map((entry) => ({ ...entry, score: 1 })));
    metrics.recordJudgement(entries, [0, 0, 0, 0, 0, 0, 0.5, 1], { minSamples: 1, muteBelow: 0 });
    metrics.mute(manual.file, manual.heading, 1);
    metrics.recordJudgement([auto], [0], { minSamples: 1, muteBelow: 1 }, Date.now() + 60_000);
    metrics.recordJudgement([updated], [0], { minSamples: 1, muteBelow: 1 }, 1);
    store.archive(archived);
    const historical = metrics.summary(Number.POSITIVE_INFINITY);

    const { message } = await call({ action: 'stats', limit: 2 });
    expect(message).toContain('8 段、共注入 8 次');
    expect(message).toContain('1. 均分 0.25（评 2 次） · 注入 1 次\n   已修订笔记.md › 已修订笔记');
    expect(message).toContain('2. 均分 1.00（评 1 次） · 注入 1 次\n   单篇.md › 单篇');
    for (const { file, heading } of filtered) expect(message).not.toContain(`${file} › ${heading}`);
    const replyTarget = {};
    const sendMarkdown = vi.fn(async () => undefined);
    const command = notesCommand({ manager, config: { textChunkLimit: 4000 } } as never);
    await command.handler({ bot: { sendMarkdown }, replyTarget, command: { raw: '' } } as never);
    expect(sendMarkdown).toHaveBeenCalledExactlyOnceWith(replyTarget, message);

    const top = (await call({ action: 'stats', view: 'top' })).message;
    expect(top).toContain(`${archived.file} › ${archived.heading}`);
    expect(top).toContain(`${searchOnly.file} › ${searchOnly.heading}`);
    const muted = (await call({ action: 'stats', view: 'muted' })).message;
    for (const row of [manual, auto, updated]) expect(muted).toContain(`${row.file} › ${row.heading}`);
    expect(metrics.summary(Number.POSITIVE_INFINITY)).toEqual(historical);

    notes.autoInject = false;
    expect((await call({ action: 'stats' })).message).not.toContain(`${active.file} › ${active.heading}`);
    expect((await call({ action: 'stats', view: 'top' })).message).toBe(top);
  });

  it('mute / unmute：没注入过的段也能静音，写错路径会被拦下', async () => {
    const { metrics, call } = setup();
    await expect(call({ action: 'mute', file: '单篇.md', heading: '写错了' })).rejects.toThrow(/没有/);
    await expect(call({ action: 'mute', file: '单篇.md' })).rejects.toThrow(/heading/);
    await call({ action: 'mute', file: '单篇.md', heading: '单篇' });
    expect(metrics.mutedManually('单篇.md', '单篇')).toBe(true);
    expect((await call({ action: 'stats', view: 'muted' })).message).toContain('🔇手动');
    await call({ action: 'unmute', file: '单篇.md', heading: '单篇' });
    expect(metrics.mutedAt('单篇.md', '单篇')).toBeUndefined();
    expect((await call({ action: 'unmute', file: '单篇.md', heading: '单篇' })).message).toContain('本来就没有静音');
  });

  it('archive：整篇和小节都走笔记库的归档，会话私有笔记也能归档', async () => {
    const { root, call, archived } = setup();
    await call({ action: 'archive', file: 'chats/group_G1/点歌.md' });
    await call({ action: 'archive', file: '观察日记.md', heading: '观察日记 › 分组 › 003 子条目' });
    expect(existsSync(join(root, 'chats', 'group_G1', '点歌.md'))).toBe(false);
    expect(readFileSync(join(root, '观察日记.md'), 'utf8')).not.toContain('子条目正文');
    expect(archived()).toHaveLength(2);
  });

  it('supersede：原地标过期并保留原日期、来源与正文', async () => {
    const { root, store, call } = setup();
    writeFileSync(join(root, '旧实验.md'), '# 旧实验条件\n\n> 记录于 2026-10-30 · 来源：私聊\n\n使用旧参数 1080p 测试。', 'utf8');
    const res = await call({ action: 'supersede', file: '旧实验.md', superseded_by: '新实验.md' });
    expect(res.message).toContain('标记为已过期');
    const content = readFileSync(join(root, '旧实验.md'), 'utf8');
    expect(content).toContain('记录于 2026-10-30 · 来源：私聊');
    expect(content).toContain('状态：已过期');
    expect(content).toContain('已被替代：新实验.md');
    expect(content).toContain('使用旧参数 1080p 测试');
    const [hit] = store.search('旧参数 1080p');
    expect(hit?.meta?.status).toBe('superseded');
    // An unresolved target must not leak through retrieval metadata.
    expect(hit?.conflicts).toBeUndefined();
    expect(hit?.meta?.supersededBy).toBeUndefined();
  });

  it('qqbot_notes_save 与 qqbot_notes_search：支持范围元数据、本机 cwd 感知与 all_scopes 权限边界', async () => {
    // 1. 本机会话保存项目笔记与角色笔记，并检验 budget_chars 校验
    const local = setup(null);
    await expect(local.callSave({ title: 'x', content: 'y', budget_chars: 20 })).rejects.toThrow(/60-2000/);

    const savedProj = await local.callSave({
      title: 'RVC 参数约定',
      content: '保护指数设为 0.45，避免破音。',
      projects: ['voice-lab'],
      triggers: ['保护指数'],
      operations: ['audio.convert'],
      budget_chars: 200,
    });
    expect(String(savedProj.message)).toContain('项目:voice-lab');
    expect(readFileSync(join(local.root, 'RVC 参数约定.md'), 'utf8')).toContain('操作：audio.convert');

    const savedRp = await local.callSave({
      title: '哈基米炸毛规则',
      content: '被叫小笨猫要哈气，不许用霸总腔。',
      personas: ['哈基米'],
      scenes: ['group'],
      inject: 'search-only',
    });
    expect(String(savedRp.message)).toContain('人设:哈基米');

    // 本机会话下，agent cwd 在 voice-lab 子目录时自动匹配项目笔记；返回带 scope/why/date/source
    const projRes = await local.callSearch(
      { query: '保护指数怎么设' },
      { session: { header: { cwd: join(local.root, '..', 'voice-lab', 'scripts') } } },
    ) as { hits: Array<Record<string, unknown>> };
    expect(projRes.hits[0]).toMatchObject({
      file: 'RVC 参数约定.md',
      scope: '项目:voice-lab',
      source: '本机会话',
    });
    expect(String(projRes.hits[0]!.why)).toContain('触发词「保护指数」');

    // 本机会话默认不命中仅限 group + 哈基米的人设笔记；传 all_scopes=true 可跨范围排查
    const noRp = await local.callSearch({ query: '小笨猫 霸总腔' }) as { hits: Array<Record<string, unknown>> };
    expect(noRp.hits).toEqual([]);
    const allRp = await local.callSearch({ query: '小笨猫 霸总腔', all_scopes: true }) as { hits: Array<Record<string, unknown>> };
    expect(allRp.hits[0]?.file).toBe('哈基米炸毛规则.md');
    const privateSearch = await local.callSearch({ query: '点歌约定', all_scopes: true }) as { hits: Array<{ file: string }> };
    expect(privateSearch.hits.some((hit) => hit.file.startsWith('chats/'))).toBe(false);

    // 2. 普通群聊传 all_scopes=true 被忽略，既拿不到跨范围人设/项目，也绝对拿不到别的群或当前未匹配项目的私有记录
    const groupTools = new Map<string, Tool>();
    const groupCtx = { get: () => ({ register: (d: Tool) => groupTools.set(d.name, d) }) };
    const groupManager = { findByAgent: () => ({ scope: 'group', peerId: 'G2' }), noteMetrics: local.metrics };
    registerNotesTools(groupCtx as never, local.store, groupManager as never, logger as never, { ownerOpenid: 'OWNER' });
    const groupRes = await groupTools.get(NOTES_SEARCH_TOOL_NAME)!.execute(
      { query: '小笨猫 点歌 保护指数', all_scopes: true, project: 'voice-lab', persona: '哈基米' },
      { agent: {} },
    ) as { hits: Array<Record<string, unknown>> };
    expect(groupRes.hits.map((h) => h.file)).toEqual([]);
  });
});

describe('笔记账本的查看', () => {
  const row = (file: string, injected: number, extra: Record<string, unknown> = {}) => ({
    file, heading: 'H', injected, strengthSum: injected, firstAt: 0, lastAt: 0, via: {}, avgStrength: 1, ...extra,
  });
  const rows = [
    row('a.md', 30, { judged: 10, relevanceSum: 1, avgRelevance: 0.1 }),
    row('b.md', 5, { judged: 4, relevanceSum: 4, avgRelevance: 1 }),
    row('c.md', 50),
    row('d.md', 2, { judged: 8, relevanceSum: 0.8, avgRelevance: 0.1, mutedAt: 9 }),
  ];

  it('low 只看评过的，均分相同时注入多的在前；top 按注入次数；muted 只看静音的', () => {
    expect(pickNoteStats(rows, 'low', 10).map((r) => r.file)).toEqual(['a.md', 'd.md', 'b.md']);
    expect(pickNoteStats(rows, 'top', 2).map((r) => r.file)).toEqual(['c.md', 'a.md']);
    expect(pickNoteStats(rows, 'muted', 10).map((r) => r.file)).toEqual(['d.md']);
  });

  it('没开打分时在概览里提示；空清单说明原因', () => {
    expect(renderNoteStats(rows, 'top', 3, false, [])).toContain('相关性打分没开');
    expect(renderNoteStats([], 'low', 3, true, [])).toContain('还没有评过分的段');
  });

  it('命令参数：视图和条数顺序不限，条数封顶，认不出的报用法', () => {
    expect(parseNotesArgs('')).toEqual({ view: 'low', limit: 10 });
    expect(parseNotesArgs('top 5')).toEqual({ view: 'top', limit: 5 });
    expect(parseNotesArgs('99 muted')).toEqual({ view: 'muted', limit: 30 });
    expect(parseNotesArgs('删掉')).toBeUndefined();
  });
});
