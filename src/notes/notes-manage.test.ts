import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { NotesStore, cutSection } from './notes-store.ts';
import { NoteMetricsStore } from './note-metrics.ts';
import { NOTES_MANAGE_TOOL_NAME, registerNotesTools } from './notes-tools.ts';
import { pickNoteStats, renderNoteStats } from '../features/note-stats.ts';
import { parseNotesArgs } from '../commands/notes.ts';

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

type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ message: string }> };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function setup(record: Record<string, unknown> | undefined = { scope: 'c2c', peerId: 'OWNER' }) {
  const root = mkdtempSync(join(tmpdir(), 'notes-manage-'));
  mkdirSync(join(root, 'chats', 'group_G1'), { recursive: true });
  writeFileSync(join(root, '观察日记.md'), DIARY, 'utf8');
  writeFileSync(join(root, '单篇.md'), '# 单篇\n\n只有这一段内容', 'utf8');
  writeFileSync(join(root, 'chats', 'group_G1', '点歌.md'), '# 点歌\n\n群里的点歌约定', 'utf8');
  const store = new NotesStore(root);
  const metrics = new NoteMetricsStore(join(root, '.metrics.json'));
  const tools = new Map<string, Tool>();
  const ctx = { get: () => ({ register: (d: Tool) => tools.set(d.name, d) }) };
  const manager = { findByAgent: () => record, noteMetrics: metrics };
  registerNotesTools(ctx as never, store, manager as never, logger as never, { ownerOpenid: 'OWNER', judgeEnabled: () => true });
  const call = (args: Record<string, unknown>) => tools.get(NOTES_MANAGE_TOOL_NAME)!.execute(args, record === undefined ? {} : { agent: {} });
  const archived = (): string[] => {
    const dir = join(root, '.archive');
    return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((name) => name.endsWith('.md')) : [];
  };
  return { root, store, metrics, call, archived };
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
    await expect(setup(undefined).call({ action: 'stats' })).resolves.toBeDefined();
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
    expect(renderNoteStats(rows, 'top', 3, false)).toContain('相关性打分没开');
    expect(renderNoteStats([], 'low', 3, true)).toContain('还没有评过分的段');
  });

  it('命令参数：视图和条数顺序不限，条数封顶，认不出的报用法', () => {
    expect(parseNotesArgs('')).toEqual({ view: 'low', limit: 10 });
    expect(parseNotesArgs('top 5')).toEqual({ view: 'top', limit: 5 });
    expect(parseNotesArgs('99 muted')).toEqual({ view: 'muted', limit: 30 });
    expect(parseNotesArgs('删掉')).toBeUndefined();
  });
});
