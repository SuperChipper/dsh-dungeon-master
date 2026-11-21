import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../types.ts';
import { DEFAULT_PERSONA_ID, parsePersona, PersonaStore, resolvePersonasDir } from './persona-store.ts';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'qqbot-persona-'));
  const dir = join(base, 'personas');
  mkdirSync(dir);
  const statePath = join(base, 'state.json');
  const warn = vi.fn();
  const open = () => new PersonaStore({ dir, statePath, logger: { warn, info: vi.fn() } as unknown as Logger });
  return { dir, statePath, open, warn };
}

describe('parsePersona', () => {
  it('读文件头的 name、names，正文作为 prompt；支持可选 voiceId 且空值不挂载属性', () => {
    const persona = parsePersona('maid', '---\nname: 冷面女仆\nnames: [女仆, 小女仆]\n---\n【身份】女仆\n');
    expect(persona).toEqual({ id: 'maid', name: '冷面女仆', names: ['女仆', '小女仆'], prompt: '【身份】女仆' });
    expect('voiceId' in persona).toBe(false);

    const voiced = parsePersona('maid', '---\nname: 冷面女仆\nvoiceId: "  voice_abc123  "\n---\n【身份】女仆\n');
    expect(voiced.voiceId).toBe('voice_abc123');

    const emptyVoice = parsePersona('maid', '---\nname: 冷面女仆\nvoiceId: "   "\n---\n【身份】女仆\n');
    expect('voiceId' in emptyVoice).toBe(false);
  });

  it('没有文件头时用文件名，CRLF 也能解析', () => {
    expect(parsePersona('maid', '【身份】女仆').name).toBe('maid');
    expect(parsePersona('maid', '---\r\nname: 女仆\r\n---\r\n正文\r\n')).toMatchObject({ name: '女仆', prompt: '正文' });
  });

  it('正文为空或文件头写坏时报错', () => {
    expect(() => parsePersona('maid', '---\nname: 女仆\n---\n')).toThrow(/正文为空/);
    expect(() => parsePersona('maid', '---\nname: [\n---\n正文')).toThrow();
    expect(() => parsePersona('maid', '---\n- a\n---\n正文')).toThrow(/键值对/);
  });
});

describe('PersonaStore', () => {
  it('人设选择落盘失败时回滚内存，避免提示词与会话错配', () => {
    const { dir, open } = setup();
    writeFileSync(join(dir, 'maid.md'), '女仆正文');
    const store = open();
    const save = vi.spyOn(store as unknown as { save(): void }, 'save').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => store.select('g1', 'maid')).toThrow('disk full');
    expect(store.currentId('g1')).toBe(DEFAULT_PERSONA_ID);
    save.mockRestore();
    store.select('g1', 'maid');
    vi.spyOn(store as unknown as { save(): void }, 'save').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => store.select('g1', DEFAULT_PERSONA_ID)).toThrow('disk full');
    expect(store.currentId('g1')).toBe('maid');
  });

  it('放进目录就能选，_ 开头和坏文件不算人设，坏文件只警告一次', () => {
    const { dir, open, warn } = setup();
    const store = open();
    expect(store.list()).toEqual([]);
    writeFileSync(join(dir, 'maid.md'), '---\nname: 女仆\n---\n女仆正文');
    writeFileSync(join(dir, '_common.md'), '共用规则');
    writeFileSync(join(dir, 'broken.md'), '   ');
    writeFileSync(join(dir, 'note.txt'), '不是人设');
    expect(store.list().map((persona) => persona.id)).toEqual(['maid']);
    store.list();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(store.find('女仆')?.id).toBe('maid');
    expect(store.find('maid')?.name).toBe('女仆');
    expect(store.find('../maid')).toBeUndefined();
  });

  it('按群选择并持久化，别的群不受影响', () => {
    const { dir, open } = setup();
    writeFileSync(join(dir, 'maid.md'), '女仆正文');
    const store = open();
    expect(store.currentId('g1')).toBe(DEFAULT_PERSONA_ID);
    store.select('g1', 'maid');
    expect(store.current('g1')?.prompt).toBe('女仆正文');
    expect(store.current('g2')).toBeUndefined();
    expect(open().currentId('g1')).toBe('maid');
    store.select('g1', DEFAULT_PERSONA_ID);
    expect(open().current('g1')).toBeUndefined();
  });

  it('选中的文件被删后回到默认人设', () => {
    const { dir, open } = setup();
    const file = join(dir, 'maid.md');
    writeFileSync(file, '女仆正文');
    const store = open();
    store.select('g1', 'maid');
    writeFileSync(file, '');
    expect(store.currentId('g1')).toBe(DEFAULT_PERSONA_ID);
  });

  it('按群和人设记会话并持久化', () => {
    const { open } = setup();
    const store = open();
    store.rememberSession('g1', 'maid', 's1');
    expect(open().sessionFor('g1', 'maid')).toBe('s1');
    expect(store.sessionFor('g1', DEFAULT_PERSONA_ID)).toBeUndefined();
    expect(store.sessionFor('g2', 'maid')).toBeUndefined();
  });

  it('私聊选择和会话可持久化，与同 openid 的群聊及其他私聊隔离', () => {
    const { dir, open } = setup();
    writeFileSync(join(dir, 'maid.md'), '女仆正文');
    const store = open();
    store.select('u1', 'maid', 'c2c');
    store.rememberSession('u1', 'maid', 'direct-session', 'c2c');
    store.rememberSession('u1', 'maid', 'group-session');
    const reloaded = open();
    expect(reloaded.current('u1', 'c2c')?.prompt).toBe('女仆正文');
    expect(reloaded.currentId('u1')).toBe(DEFAULT_PERSONA_ID);
    expect(reloaded.currentId('u2', 'c2c')).toBe(DEFAULT_PERSONA_ID);
    expect(reloaded.sessionFor('u1', 'maid', 'c2c')).toBe('direct-session');
    expect(reloaded.sessionFor('u1', 'maid')).toBe('group-session');
    expect(reloaded.sessionFor('u2', 'maid', 'c2c')).toBeUndefined();
    reloaded.select('u1', 'maid');
    reloaded.select('u1', DEFAULT_PERSONA_ID, 'c2c');
    expect(open().currentId('u1', 'c2c')).toBe(DEFAULT_PERSONA_ID);
    expect(open().currentId('u1')).toBe('maid');
    expect(open().sessionFor('u1', 'maid', 'c2c')).toBe('direct-session');
  });

  it('读取旧格式后保留群聊人设和会话，私聊从默认开始', () => {
    const { dir, statePath, open } = setup();
    writeFileSync(join(dir, 'maid.md'), '女仆正文');
    writeFileSync(statePath, JSON.stringify({ groups: { g1: 'maid' }, sessions: { g1: { maid: 'old-session' } } }));
    const store = open();
    expect(store.currentId('g1')).toBe('maid');
    expect(store.sessionFor('g1', 'maid')).toBe('old-session');
    expect(store.currentId('g1', 'c2c')).toBe(DEFAULT_PERSONA_ID);
    store.select('u1', 'maid', 'c2c');
    expect(open().currentId('u1', 'c2c')).toBe('maid');
    expect(open().sessionFor('g1', 'maid')).toBe('old-session');
  });

  it('支持 .group.md / .direct.md 按群聊和私聊分别加载，并在列表中按规范 id 去重', () => {
    const { dir, open } = setup();
    writeFileSync(join(dir, 'Gemini.group.md'), '---\nname: 哈基米\nnames: [吉米]\n---\n群聊版猫猫');
    writeFileSync(join(dir, 'Gemini.direct.md'), '---\nname: 哈基米\nnames: [吉米]\n---\n私聊版深度猫猫');
    writeFileSync(join(dir, 'fallback.md'), '---\nname: 通用\n---\n通用正文');
    const store = open();
    expect(store.list().map((p) => p.id)).toEqual(['Gemini', 'fallback']);
    expect(store.find('哈基米')?.id).toBe('Gemini');
    expect(store.find('Gemini.group')).toBeUndefined();
    store.select('g1', 'Gemini', 'group');
    store.select('u1', 'Gemini', 'c2c');
    store.select('u2', 'fallback', 'c2c');
    expect(store.current('g1', 'group')?.prompt).toBe('群聊版猫猫');
    expect(store.current('u1', 'c2c')?.prompt).toBe('私聊版深度猫猫');
    expect(store.current('u2', 'c2c')?.prompt).toBe('通用正文');
  });

  it('defaultPersona 读取并解析 default.{group,direct}.md 且不进 list()', () => {
    const { dir, open } = setup();
    writeFileSync(join(dir, 'default.group.md'), '---\nname: 默认\nnames: [大肥鱼, 小肥鱼]\n---\n默认群聊正文');
    writeFileSync(join(dir, 'default.direct.md'), '---\nname: 默认\nnames: [大肥鱼]\n---\n默认私聊正文');
    const store = open();
    expect(store.list('group').map((p) => p.id)).toEqual([]);
    expect(store.list('c2c').map((p) => p.id)).toEqual([]);
    expect(store.current('g1', 'group')).toBeUndefined();
    expect(store.defaultPersona('group')).toEqual({
      id: DEFAULT_PERSONA_ID,
      name: '默认',
      names: ['大肥鱼', '小肥鱼'],
      prompt: '默认群聊正文',
    });
    expect(store.defaultPersona('c2c')).toEqual({
      id: DEFAULT_PERSONA_ID,
      name: '默认',
      names: ['大肥鱼'],
      prompt: '默认私聊正文',
    });
  });

  it('持久化人设切换事务支持 beginTransition → commitTransition → finishTransition 及崩溃持久化恢复', () => {
    const { dir, open } = setup();
    writeFileSync(join(dir, 'maid.md'), '女仆正文');
    const store = open();
    const begun = store.beginTransition({
      scope: 'group',
      peerId: 'g1',
      fromPersona: DEFAULT_PERSONA_ID,
      toPersona: 'maid',
      sourceSessionId: 's-default',
      targetSessionId: 's-maid',
    });
    expect(begun.phase).toBe('handoff');
    expect(open().getTransition('g1', 'group')).toEqual(begun);

    const committed = store.commitTransition('g1', 'group');
    expect(committed?.phase).toBe('committing');
    const reloaded = open();
    expect(reloaded.currentId('g1', 'group')).toBe('maid');
    expect(reloaded.sessionFor('g1', DEFAULT_PERSONA_ID, 'group')).toBe('s-default');
    expect(reloaded.sessionFor('g1', 'maid', 'group')).toBe('s-maid');
    expect(reloaded.getTransition('g1', 'group')?.phase).toBe('committing');

    reloaded.finishTransition('g1', 'group');
    expect(open().getTransition('g1', 'group')).toBeUndefined();
    expect(open().currentId('g1', 'group')).toBe('maid');
  });
});

describe('resolvePersonasDir', () => {
  it('显式 root 支持绝对路径和按 cwd 解析相对路径，留空时优先插件根目录再回退 ~/.dsh-qqbot/personas', () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-persona-dir-'));
    const pluginWithPersonas = join(root, 'plugin-with');
    const pluginEmpty = join(root, 'plugin-empty');
    const pluginOnlyHelper = join(root, 'plugin-helper');
    mkdirSync(join(pluginWithPersonas, 'personas'), { recursive: true });
    mkdirSync(join(pluginEmpty, 'personas'), { recursive: true });
    mkdirSync(join(pluginOnlyHelper, 'personas'), { recursive: true });
    writeFileSync(join(pluginWithPersonas, 'personas', 'default.group.md'), '群聊默认');
    writeFileSync(join(pluginOnlyHelper, 'personas', '_shared.md'), '共用片段');

    const absTarget = join(root, 'custom-personas');
    expect(resolvePersonasDir({ root: `  ${absTarget}  `, cwd: root, pluginRoot: pluginWithPersonas, homeDir: root }))
      .toBe(absTarget);

    expect(resolvePersonasDir({ root: 'my-personas', cwd: root, pluginRoot: pluginWithPersonas, homeDir: root }))
      .toBe(join(root, 'my-personas'));

    expect(resolvePersonasDir({ root: '', cwd: root, pluginRoot: pluginWithPersonas, homeDir: root }))
      .toBe(join(pluginWithPersonas, 'personas'));

    expect(resolvePersonasDir({ root: '', cwd: root, pluginRoot: pluginEmpty, homeDir: root }))
      .toBe(join(root, '.dsh-qqbot', 'personas'));

    expect(resolvePersonasDir({ root: '', cwd: root, pluginRoot: pluginOnlyHelper, homeDir: root }))
      .toBe(join(root, '.dsh-qqbot', 'personas'));
  });
});
