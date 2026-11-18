import { describe, expect, it } from 'vitest';
import {
  compareNoteDates,
  deriveDirMeta,
  deriveProjectsFromCwd,
  describeNoteScope,
  extractFrontmatter,
  formatMetaBlockquote,
  matchesNoteScope,
  parseMetaBlockquote,
  parseSectionMeta,
  upsertMetaInBlockquote,
  type NoteMeta,
} from './note-metadata.ts';
import { chunkMarkdown } from './notes-store.ts';

describe('note-metadata: frontmatter 与目录推导', () => {
  it('解析 YAML frontmatter 的范围、触发、预算、来源与替代字段', () => {
    const md = [
      '---',
      'project: voice-lab',
      'personas: [哈基米, 猫猫]',
      'scenes: [private, dnd]',
      'models: mimo',
      'triggers: [RVC, 破音]',
      'operations: [audio.convert]',
      'budget: 240',
      'date: 2026-11-05',
      'source: 私聊',
      'supersedes: ASR 选型.md',
      '---',
      '# 正文标题',
      '正文内容',
    ].join('\n');

    const { patch, body } = extractFrontmatter(md);
    expect(body).toBe('# 正文标题\n正文内容');
    expect(patch).toMatchObject({
      scope: {
        projects: ['voice-lab'],
        personas: ['哈基米', '猫猫'],
        scenes: ['c2c', 'dnd'],
        models: ['mimo'],
      },
      triggers: ['RVC', '破音'],
      operations: ['audio.convert'],
      budgetChars: 240,
      date: '2026-11-05',
      source: '私聊',
      supersedes: ['ASR 选型.md'],
    });
  });

  it('YAML 语法损坏时静默退回普通正文，不丢笔记', () => {
    const broken = '---\nprojects: [unclosed\n---\n# 标题\n正文还在';
    const { patch, body } = extractFrontmatter(broken);
    expect(patch).toBeUndefined();
    expect(body).toBe(broken);
  });

  it('YAML Date 对象和 budget: 0 正确归一化', () => {
    const md = [
      '---',
      'date: 2026-11-08',
      'budgetChars: 0',
      'status: expired',
      'supersededBy: 新链路.md',
      '---',
      '正文',
    ].join('\n');
    const { patch } = extractFrontmatter(md);
    expect(patch?.date).toBe('2026-11-08');
    expect(patch?.budgetChars).toBe(0);
    expect(patch?.inject).toBe('search-only');
    expect(patch?.status).toBe('superseded');
    expect(patch?.supersededBy).toBe('新链路.md');
  });

  it('按 chats/projects/personas 目录推导默认范围', () => {
    expect(deriveDirMeta('chats/group_A/点歌.md')).toMatchObject({ kind: 'chat', scope: { chatKey: 'group_A' } });
    expect(deriveDirMeta('projects/voice-lab/踩坑.md')).toMatchObject({ kind: 'project', scope: { projects: ['voice-lab'] } });
    expect(deriveDirMeta('personas/哈基米/口癖.md')).toMatchObject({ kind: 'roleplay', scope: { personas: ['哈基米'] } });
    expect(deriveDirMeta('通用教训.md')).toMatchObject({ kind: 'general', scope: {} });
  });
});

describe('note-metadata: 引用行序列化、无损往返与层级继承', () => {
  it('仅有 date 和 source 时精确保持向后兼容格式', () => {
    expect(formatMetaBlockquote({ date: '2026-11-17', source: '群聊' })).toBe('> 记录于 2026-11-17 · 来源：群聊');
  });

  it('带扩展字段时序列化与 parseMetaBlockquote 无损往返', () => {
    const line = formatMetaBlockquote({
      date: '2026-11-05',
      source: '私聊',
      scope: {
        projects: ['voice-lab'],
        personas: ['哈基米'],
        scenes: ['group', 'dnd'],
        models: ['mimo'],
      },
      triggers: ['RVC', '破音'],
      operations: ['audio.convert'],
      inject: 'search-only',
      budgetChars: 240,
      status: 'superseded',
      supersedes: ['a.md', 'b.md'],
      supersededBy: 'new.md',
    });
    const parsed = parseMetaBlockquote(line);
    expect(parsed).toMatchObject({
      date: '2026-11-05',
      source: '私聊',
      scope: {
        projects: ['voice-lab'],
        personas: ['哈基米'],
        scenes: ['group', 'dnd'],
        models: ['mimo'],
      },
      triggers: ['RVC', '破音'],
      operations: ['audio.convert'],
      inject: 'search-only',
      budgetChars: 240,
      status: 'superseded',
      supersedes: ['a.md', 'b.md'],
      supersededBy: 'new.md',
    });
  });

  it('upsertMetaInBlockquote 原地标过期且保留原日期与来源', () => {
    const updated = upsertMetaInBlockquote(
      '> 记录于 2026-10-30 · 来源：私聊',
      { status: 'superseded', supersededBy: '当前链路.md' },
    );
    expect(updated).toContain('记录于 2026-10-30 · 来源：私聊');
    expect(updated).toContain('状态：已过期');
    expect(updated).toContain('已被替代：当前链路.md');
  });

  it('含正文的引用行保留原文并兜底提取开头日期；纯元数据行在有正文时被剥离', () => {
    const base: NoteMeta = { kind: 'general', scope: {}, inject: 'auto', status: 'active' };
    const contentQuote = parseSectionMeta(
      ['> 2026-11-05 整体重写。原来那套本机 whisper 已退役。', '', '现在走新链路。'],
      base,
      '链路.md',
      '链路',
    );
    expect(contentQuote.meta.date).toBe('2026-11-05');
    expect(contentQuote.bodyLines[0]).toContain('整体重写');

    const pureMeta = parseSectionMeta(
      ['> 记录于 2026-11-01 · 来源：私聊', '', '真正正文'],
      base,
      'a.md',
      'A',
    );
    expect(pureMeta.meta.date).toBe('2026-11-01');
    expect(pureMeta.bodyLines.join('\n').trim()).toBe('真正正文');
  });

  it('小节按层级继承但不互相串味', () => {
    const md = [
      '# 根节',
      '> 记录于 2026-10-27 · 来源：私聊 · 范围：project=voice-lab',
      '',
      '根正文',
      '',
      '## 子节A',
      '> 记录于 2026-10-29',
      '',
      'A正文',
      '',
      '## 子节B',
      'B正文',
    ].join('\n');
    const chunks = chunkMarkdown('rvc.md', md);
    expect(chunks).toHaveLength(3);
    expect(chunks[1]!.meta?.date).toBe('2026-10-29');
    expect(chunks[1]!.meta?.scope.projects).toEqual(['voice-lab']);
    expect(chunks[2]!.meta?.date).toBe('2026-10-27');
    expect(chunks[2]!.meta?.scope.projects).toEqual(['voice-lab']);
  });
});

describe('note-metadata: deriveProjectsFromCwd 与 matchesNoteScope', () => {
  it('伞状根目录返回空，子项目与 state 子目录正确推导', () => {
    const root = 'C:\\Users\\16257\\Desktop\\Dsh-bot';
    expect(deriveProjectsFromCwd(root, root)).toEqual([]);
    expect(deriveProjectsFromCwd(`${root}\\voice-lab\\scripts`, root)).toEqual(['voice-lab']);
    expect(deriveProjectsFromCwd(`${root}\\state\\paper-trade`, root)).toEqual(['paper-trade', 'state/paper-trade']);
    expect(deriveProjectsFromCwd('D:\\other\\my-app', root)).toEqual(['my-app']);
  });

  it('通用 / 项目 / 人设 / 场景 / 模型范围判定与 unscoped 边界', () => {
    const general: NoteMeta = { kind: 'general', scope: {}, inject: 'auto', status: 'active' };
    expect(matchesNoteScope(general, { chatKey: 'group_1', projects: ['voice-lab'], models: ['gpt-5'] }, 'anything')).toBe(true);
    expect(describeNoteScope(general)).toBe('跨会话通用');

    const proj: NoteMeta = { kind: 'project', scope: { projects: ['voice-lab'] }, inject: 'auto', status: 'active' };
    expect(matchesNoteScope(proj, { projects: ['voice-lab'] }, '破音')).toBe(true);
    expect(matchesNoteScope(proj, { projects: ['dsh-qqbot'] }, 'voice-lab 破音')).toBe(false);
    expect(matchesNoteScope(proj, { projects: ['dsh-qqbot'], allowQueryProjectMatch: true }, 'voice-lab 破音')).toBe(true);
    expect(matchesNoteScope(proj, { projects: ['dsh-qqbot'], allowQueryProjectMatch: false }, 'voice-lab 破音')).toBe(false);

    const roleplay: NoteMeta = {
      kind: 'roleplay',
      scope: { personas: ['哈基米'], scenes: ['group'], models: ['mimo'] },
      inject: 'auto',
      status: 'active',
    };
    expect(matchesNoteScope(roleplay, { personas: ['哈基米'], scenes: ['group'], models: ['mimo-v2.6-flash'] })).toBe(true);
    expect(matchesNoteScope(roleplay, { personas: ['大肥鱼'], scenes: ['group'], models: ['mimo-v2.6-flash'] })).toBe(false);
    expect(matchesNoteScope(roleplay, { personas: ['哈基米'], scenes: ['c2c'], models: ['mimo-v2.6-flash'] })).toBe(false);
    expect(matchesNoteScope(roleplay, { personas: ['哈基米'], scenes: ['group'], models: ['deepseek-v4'] })).toBe(false);

    const chatPrivate: NoteMeta = { kind: 'chat', scope: { chatKey: 'group_A', projects: ['voice-lab'] }, inject: 'auto', status: 'active' };
    // unscoped 只跳过 project/persona/scene/model，绝不绕过非本机 chatKey 隔离
    expect(matchesNoteScope(chatPrivate, { chatKey: 'group_B', unscoped: true })).toBe(false);
    expect(matchesNoteScope(proj, { chatKey: 'c2c_OWNER', unscoped: true })).toBe(true);
  });

  it('compareNoteDates 正确比较 YYYY-MM 与 YYYY-MM-DD', () => {
    expect(compareNoteDates('2026-11-05', '2026-10-30')).toBe(1);
    expect(compareNoteDates('2026-11-05', '2026-10')).toBe(1);
    expect(compareNoteDates('2026-10-30', '2026-11-05')).toBe(-1);
    expect(compareNoteDates('2026-11-05', undefined)).toBe(0);
  });
});
