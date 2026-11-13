import { describe, expect, it, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import { personaCommand } from '../commands/persona.ts';
import { meCommand } from '../commands/misc.ts';
import { SessionManager } from '../session/session-manager.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import { DEFAULT_PERSONA_ID, type Persona, type PersonaStore } from './persona-store.ts';
import { buildPersonaKeyboard, canManagePersona, PersonaSwitch, type SwitchPersonaOutcome } from './persona-switch.ts';

const config = { ownerOpenid: 'owner', adminOpenids: ['admin'], textChunkLimit: 4500 } as unknown as ImQQBotConfig;
const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
const maid: Persona = { id: 'maid', name: '女仆', names: [], prompt: '正文' };

function fakeStore(personas: Persona[] = [maid], current = DEFAULT_PERSONA_ID): PersonaStore {
  return {
    list: () => personas,
    find: (arg: string) => personas.find((p) => p.id === arg || p.name === arg),
    currentId: () => current,
  } as unknown as PersonaStore;
}

function setup(outcome: SwitchPersonaOutcome = 'ok', personas: Persona[] = [maid]) {
  const switchPersona = vi.fn(() => outcome);
  const sent: Array<{ target: ReplyTarget; text: string; keyboard?: unknown }> = [];
  const sender = {
    sendMarkdown: vi.fn(async (target: ReplyTarget, text: string, opts?: { keyboard?: unknown }) => { sent.push({ target, text, keyboard: opts?.keyboard }); }),
  };
  const personaSwitch = new PersonaSwitch({ switchPersona }, fakeStore(personas), sender, config, logger);
  return { personaSwitch, switchPersona, sent };
}

function click(data: unknown, member?: string): InteractionEvent {
  return {
    id: 'e1',
    group_openid: 'g1',
    ...(member !== undefined ? { group_member_openid: member } : {}),
    data: { resolved: { button_data: JSON.stringify(data) } },
  } as unknown as InteractionEvent;
}

function directClick(data: unknown, user?: string): InteractionEvent {
  const event = click(data);
  delete event.group_openid;
  if (user !== undefined) event.user_openid = user;
  return event;
}

const labels = (keyboard: ReturnType<typeof buildPersonaKeyboard>) => keyboard.content.rows.map((row) => row.buttons.map((b) => b.render_data.label));

describe('canManagePersona', () => {
  it('只认主人和管理员，没配名单时也拒绝', () => {
    expect(canManagePersona('owner', config)).toBe(true);
    expect(canManagePersona('admin', config)).toBe(true);
    expect(canManagePersona('stranger', config)).toBe(false);
    expect(canManagePersona(undefined, config)).toBe(false);
    expect(canManagePersona('anyone', {} as ImQQBotConfig)).toBe(false);
  });
});

describe('buildPersonaKeyboard', () => {
  const options = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `人设${i}` }));

  it('当前人设打勾，一页最多 4 行加 1 行翻页', () => {
    const first = buildPersonaKeyboard(options, 'p1', 0);
    expect(first.content.rows).toHaveLength(5);
    expect(labels(first)[0]).toEqual(['人设0', '人设1 ✓']);
    expect(labels(first)[4]).toEqual(['下一页']);
  });

  it('翻到最后一页只有上一页，页码越界时取最后一页', () => {
    expect(labels(buildPersonaKeyboard(options, 'p1', 1))).toEqual([['人设8', '人设9'], ['上一页']]);
    expect(labels(buildPersonaKeyboard(options, 'p1', 99))).toEqual([['人设8', '人设9'], ['上一页']]);
  });

  it('按钮带人设 id，长名字截断', () => {
    const keyboard = buildPersonaKeyboard([{ id: 'long', name: '一二三四五六七八九十十一' }], 'other', 0);
    const only = keyboard.content.rows[0]!.buttons[0]!;
    expect(only.render_data.label.length).toBeLessThanOrEqual(10);
    expect(JSON.parse(only.action.data)).toEqual({ t: 'persona', a: 'use', p: 'long' });
  });
});

describe('PersonaSwitch', () => {
  it('管理员的卡片有按钮，其他人只看到当前人设', async () => {
    const { personaSwitch, sent } = setup();
    const target = { scope: 'group' as const, targetId: 'g1' };
    await personaSwitch.sendCard(target, 'admin');
    await personaSwitch.sendCard(target, 'stranger');
    expect(sent[0]!.keyboard).toBeDefined();
    expect(sent[1]!.keyboard).toBeUndefined();
    expect(sent[1]!.text).toContain('当前人设：默认');
  });

  it('非管理员点按钮被拒绝，不切换', () => {
    const { personaSwitch, switchPersona } = setup();
    expect(personaSwitch.handleInteraction(click({ t: 'persona', a: 'use', p: 'maid' }, 'stranger'))).toBe(4);
    expect(personaSwitch.handleInteraction(click({ t: 'persona', a: 'use', p: 'maid' }))).toBe(4);
    expect(switchPersona).not.toHaveBeenCalled();
  });

  it('管理员点按钮切换当前群，并告知结果', async () => {
    const { personaSwitch, switchPersona, sent } = setup();
    expect(personaSwitch.handleInteraction(click({ t: 'persona', a: 'use', p: 'maid' }, 'admin'))).toBe(0);
    expect(switchPersona).toHaveBeenCalledWith('g1', 'maid', 'group');
    await vi.waitFor(() => expect(sent[0]?.text).toContain('已切换到「女仆」'));
  });

  it('私聊卡片读取私聊人设，按钮切换后回复当前私聊', async () => {
    const { switchPersona, sent } = setup();
    const store = fakeStore([maid], 'maid');
    const currentId = vi.spyOn(store, 'currentId');
    const personaSwitch = new PersonaSwitch({ switchPersona }, store, {
      sendMarkdown: async (target, text, opts) => { sent.push({ target, text, keyboard: opts?.keyboard }); },
    }, config, logger);
    await personaSwitch.sendCard({ scope: 'c2c', targetId: 'owner', msgId: 'm1' }, 'owner');
    expect(currentId).toHaveBeenCalledWith('owner', 'c2c');
    expect(sent[0]!.text).toContain('当前人设：女仆');
    expect(sent[0]!.text).toContain('只影响当前私聊');
    expect(sent[0]!.keyboard).toBeDefined();
    expect(personaSwitch.handleInteraction(directClick({ t: 'persona', a: 'use', p: 'maid' }, 'owner'))).toBe(0);
    expect(switchPersona).toHaveBeenCalledWith('owner', 'maid', 'c2c');
    await vi.waitFor(() => expect(sent[1]?.target).toEqual({ scope: 'c2c', targetId: 'owner', eventId: 'e1' }));
    expect(sent[1]!.text).toContain('已切换');
  });

  it('私聊翻页发送到点击者，权限检查与群聊一致，缺少目标时拒绝', async () => {
    const { personaSwitch, switchPersona, sent } = setup();
    expect(personaSwitch.handleInteraction(directClick({ t: 'persona', a: 'page', n: 1 }, 'admin'))).toBe(0);
    expect(sent[0]!.target).toEqual({ scope: 'c2c', targetId: 'admin', eventId: 'e1' });
    expect(sent[0]!.keyboard).toBeDefined();
    expect(personaSwitch.handleInteraction(directClick({ t: 'persona', a: 'use', p: 'maid' }, 'stranger'))).toBe(4);
    expect(personaSwitch.handleInteraction(directClick({ t: 'persona', a: 'use', p: 'maid' }))).toBe(1);
    await personaSwitch.sendCard({ scope: 'c2c', targetId: 'stranger' }, 'stranger');
    expect(sent[1]!.keyboard).toBeUndefined();
    expect(switchPersona).not.toHaveBeenCalled();
  });

  it('旧卡片上的人设已删除时不切换', async () => {
    const { personaSwitch, switchPersona, sent } = setup('ok', []);
    expect(personaSwitch.handleInteraction(click({ t: 'persona', a: 'use', p: 'maid' }, 'owner'))).toBe(0);
    expect(switchPersona).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sent[0]?.text).toContain('不在了'));
  });

  it.each([
    ['dnd', '跑团'],
    ['busy', '正在回复'],
    ['same', '现在就是'],
  ] as const)('切不了时说明原因：%s', async (outcome, text) => {
    expect(await setup(outcome).personaSwitch.apply('g1', 'maid')).toContain(text);
  });
});

describe('/persona', () => {
  function context(senderId: string, raw: string, kind = 'group') {
    return { command: { raw }, message: { senderId, kind, groupOpenid: 'g1', messageId: 'm1' } } as never;
  }
  function command(outcome: SwitchPersonaOutcome = 'ok') {
    const parts = setup(outcome);
    const manager = { personaStore: fakeStore(), personaSwitch: parts.personaSwitch };
    return { ...parts, cmd: personaCommand({ manager: manager as never, config }) };
  }

  it('查看不限，切换只限主人和管理员', () => {
    const { cmd } = command();
    expect(cmd.authorized?.(context('stranger', ''))).toBe(true);
    expect(cmd.authorized?.(context('stranger', '女仆'))).toMatch(/只有/);
    expect(cmd.authorized?.(context('admin', '女仆'))).toBe(true);
  });

  it('按名字切换，也能切回默认；没有的人设报错', async () => {
    const { cmd, switchPersona } = command();
    expect(await cmd.handler(context('admin', '女仆'))).toContain('已切换');
    expect(switchPersona).toHaveBeenLastCalledWith('g1', 'maid', 'group');
    await cmd.handler(context('admin', '默认'));
    expect(switchPersona).toHaveBeenLastCalledWith('g1', DEFAULT_PERSONA_ID, 'group');
    expect(await cmd.handler(context('admin', '不存在'))).toContain('没有这个人设');
  });

  it('私聊支持卡片、按名字切换和恢复默认，沿用管理权限', async () => {
    const { cmd, sent, switchPersona } = command();
    expect(cmd.authorized?.(context('stranger', '女仆', 'c2c'))).toMatch(/只有/);
    expect(cmd.authorized?.(context('admin', '女仆', 'c2c'))).toBe(true);
    expect(await cmd.handler(context('admin', '', 'c2c'))).toEqual({ kind: 'noop' });
    expect(sent[0]!.target).toMatchObject({ scope: 'c2c', targetId: 'admin', msgId: 'm1' });
    expect(await cmd.handler(context('admin', '女仆', 'c2c'))).toContain('已切换');
    expect(switchPersona).toHaveBeenLastCalledWith('admin', 'maid', 'c2c');
    await cmd.handler(context('admin', 'default', 'c2c'));
    expect(switchPersona).toHaveBeenLastCalledWith('admin', DEFAULT_PERSONA_ID, 'c2c');
  });
});

describe('SessionManager.switchPersona', () => {
  function manager(options: { status?: string; dnd?: boolean; sessionFor?: string; scope?: ChatScope } = {}) {
    const state = { current: DEFAULT_PERSONA_ID };
    const store = {
      currentId: () => state.current,
      rememberSession: vi.fn(),
      select: vi.fn((_g: string, id: string) => { state.current = id; }),
      sessionFor: vi.fn(() => options.sessionFor),
    };
    const record = options.status === undefined ? undefined : { sessionId: 'old', agent: { status: options.status } };
    const remove = vi.fn(async () => {});
    const self = Object.assign(Object.create(SessionManager.prototype) as SessionManager, {
      personaStore: store,
      dndService: { active: () => (options.dnd === true ? {} : undefined) },
      sessions: new Map(record === undefined ? [] : [[`qqbot:app:${options.scope ?? 'group'}:g1`, record]]),
      sessionKey: (scope: ChatScope, peerId: string) => `qqbot:app:${scope}:${peerId}`,
      currentSessionId: () => 'derived',
      remove,
    });
    return { self, store, remove };
  }

  it('记下当前会话，第一次用的人设拿新会话', async () => {
    const { self, store, remove } = manager({ status: 'idle' });
    expect(await self.switchPersona('g1', 'maid')).toBe('ok');
    expect(store.rememberSession).toHaveBeenCalledWith('g1', DEFAULT_PERSONA_ID, 'old', 'group');
    expect(store.select).toHaveBeenCalledWith('g1', 'maid', 'group');
    expect(remove).toHaveBeenCalledWith('group', 'g1', expect.any(String));
  });

  it('切回用过的人设时接着原来的会话；会话不在内存里也能记下', async () => {
    const { self, store, remove } = manager({ sessionFor: 'maid-session' });
    expect(await self.switchPersona('g1', 'maid')).toBe('ok');
    expect(store.rememberSession).toHaveBeenCalledWith('g1', DEFAULT_PERSONA_ID, 'derived', 'group');
    expect(remove).toHaveBeenCalledWith('group', 'g1', 'maid-session');
  });

  it.each([undefined, 'maid-session'])('私聊保存当前会话并切到独立的人设会话：%s', async (sessionFor) => {
    const { self, store, remove } = manager({ status: 'idle', scope: 'c2c', sessionFor });
    expect(await self.switchPersona('g1', 'maid', 'c2c')).toBe('ok');
    expect(store.rememberSession).toHaveBeenCalledWith('g1', DEFAULT_PERSONA_ID, 'old', 'c2c');
    expect(store.select).toHaveBeenCalledWith('g1', 'maid', 'c2c');
    expect(store.sessionFor).toHaveBeenCalledWith('g1', 'maid', 'c2c');
    expect(remove).toHaveBeenCalledWith('c2c', 'g1', sessionFor ?? expect.any(String));
  });

  it('私聊正在回复时不切换', async () => {
    const { self, store, remove } = manager({ status: 'running', scope: 'c2c' });
    expect(await self.switchPersona('g1', 'maid', 'c2c')).toBe('busy');
    expect(store.select).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'running' }, 'busy'],
    [{ status: 'idle', dnd: true }, 'dnd'],
  ] as const)('回复中和开团中不切换：%j', async (options, outcome) => {
    const { self, store, remove } = manager(options);
    expect(await self.switchPersona('g1', 'maid')).toBe(outcome);
    expect(store.select).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('已经是这个人设时什么都不做', async () => {
    const { self, remove } = manager({ status: 'idle' });
    expect(await self.switchPersona('g1', DEFAULT_PERSONA_ID)).toBe('same');
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('/bot-me', () => {
  it('群里给出自己和群的 openid', async () => {
    const sendMarkdown = vi.fn(async () => {});
    const ctx = { bot: { sendMarkdown }, message: { senderId: 'u1', groupOpenid: 'g1', kind: 'group', messageId: 'm1' } };
    await meCommand({ manager: {} as never, config }).handler(ctx as never);
    const text = JSON.stringify(sendMarkdown.mock.calls);
    expect(text).toContain('u1');
    expect(text).toContain('g1');
  });
});
