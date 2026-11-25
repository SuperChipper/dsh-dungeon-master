import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { LearnInbox, type LearnScope } from './learn-inbox.ts';
import { wireLearnInbox } from '../gateway/learn-wiring.ts';

const owner = { scope: 'c2c', peerId: 'owner', sessionId: 'session' };
const guest = { scope: 'c2c', peerId: 'guest', sessionId: 'guest-session' };
const group = { ...owner, scope: 'group' };
const cmd = 'npx vitest run src/example.test.ts --pool=threads';

let root: string;
const make = (appId = 'bot', getOwner = () => 'owner') => new LearnInbox(join(root, 'inbox'), appId, getOwner);
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'qqbot-learn-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const start = (inbox: LearnInbox, text: string, n = 1, chat = owner, original = 'qq-' + n) => {
  inbox.stage(chat, 'msg-' + n, original, text);
  inbox.observe(chat, { type: 'turn/start', data: { turn: n } });
  inbox.observe(chat, { type: 'user/message', data: { id: 'msg-' + n, source: { kind: 'user' } } });
};
const end = (inbox: LearnInbox, n = 1, kind = 'completed', chat = owner) =>
  inbox.observe(chat, { type: 'turn/end', data: { turn: n, reason: { kind } } });
const list = (inbox: LearnInbox, chat = owner) => { start(inbox, '/learn', 42, chat); return inbox.list(chat); };

function vitestResult(inbox: LearnInbox, id: string, text: string, exitCode: number, options: {
  cwd?: string; command?: string; extra?: Record<string, unknown>;
} = {}) {
  inbox.observeTool(owner, { name: 'pwsh', callId: id, arguments: { command: options.command ?? cmd } }, {
    isError: false, value: { kind: 'foreground', cwd: options.cwd ?? 'C:/project', exitCode, aborted: false,
      signal: null, timedOut: false, stdout: { text, truncated: false }, ...options.extra },
  });
}
const fail = (inbox: LearnInbox) => vitestResult(inbox, 'fail', '      Tests  1 failed | 2 passed (3)\n', 1);
const pass = (inbox: LearnInbox, id = 'pass') => vitestResult(inbox, id, '      Tests  3 passed (3)\n', 0);
const edit = (inbox: LearnInbox, callId = 'edit') => inbox.observeTool(owner, { name: 'apply_patch', callId, arguments: {} }, {
  isError: false, value: { cancelled: false, operations: [{ status: 'completed' }] },
});

describe('experience drafts', () => {
  it('stages only after completed input; persists and deduplicates delivery replay after restart without saving private text', () => {
    const inbox = make();
    start(inbox, '我觉得以后描述方案都要先讲改哪里');
    expect(readdirSync(root)).toEqual([]);
    expect(() => inbox.list(owner)).toThrow('/learn');
    end(inbox);

    const restarted = make();
    start(restarted, '我觉得以后描述方案都要先讲改哪里', 2, owner, 'qq-1');
    end(restarted, 2);
    const found = list(restarted);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'preference', evidence: { messageId: 'qq-1', agentMessageId: 'msg-1' } });
    const dir = join(root, 'inbox', readdirSync(join(root, 'inbox'))[0]!);
    expect(readdirSync(dir)).toEqual([found[0]!.id + '.json']);
    const row = readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8');
    expect(row).not.toContain('描述方案');
    expect(readdirSync(root)).toEqual(['inbox']);
  });

  it('does not accept a generic yes, a one-off, quotes, questions, credentials, synthetic input or cancelled work', () => {
    const inbox = make();
    ['好', '这次就这样改', '「以后先用纯文本」', '以后先用办法甲吗？', '以后默认用这个密钥', '以后这样做吧'].forEach((text, i) => {
      // The last input is evidence-bearing only on an actual completed turn.
      start(inbox, text, i + 1);
      end(inbox, i + 1, i === 5 ? 'aborted' : 'completed');
    });
    inbox.stage(owner, 'fake', 'fake-qq', '以后默认只用纯文本');
    inbox.observe(owner, { type: 'turn/start', data: { turn: 8 } });
    inbox.observe(owner, { type: 'user/message', data: { id: 'fake', source: { kind: 'runtime-context' } } });
    end(inbox, 8);
    expect(list(inbox)).toEqual([]);
  });

  it('fails closed for group, guest, unset owner and non-/learn turns; separates stores across bots and owners', () => {
    const inbox = make();
    for (const chat of [guest, group]) {
      start(inbox, '以后也这样做', 1, chat);
      end(inbox, 1, 'completed', chat);
      expect(() => list(inbox, chat)).toThrow('/learn');
    }
    expect(() => list(make('bot', () => ''), owner)).toThrow('/learn');
    expect(list(inbox)).toEqual([]);
    start(inbox, '以后也这样做', 2);
    end(inbox, 2);
    expect(list(inbox)).toHaveLength(1);
    end(inbox, 42);
    expect(() => inbox.list(owner)).toThrow('/learn');
    expect(list(make('other-bot'))).toEqual([]);
    expect(list(make('bot', () => 'guest'), guest)).toEqual([]);
  });

  it('uses the observed failed check, edit, and matched passing check as an ordered sequence', () => {
    const inbox = make();
    start(inbox, '修一下这个问题');
    fail(inbox); edit(inbox); pass(inbox);
    end(inbox);
    expect(list(inbox)).toMatchObject([{ kind: 'verified-check', summary: expect.stringContaining('3 项通过'),
      evidence: { toolCallIds: ['fail', 'edit', 'pass'] } }]);
  });

  it.each([
    ['no failed check', (i: LearnInbox) => { edit(i); pass(i); }],
    ['no changed result', (i: LearnInbox) => { fail(i); pass(i); }],
    ['exit code alone', (i: LearnInbox) => { fail(i); edit(i); vitestResult(i, 'blank', '', 0); }],
    ['different folder', (i: LearnInbox) => { fail(i); edit(i); vitestResult(i, 'other', 'Tests  3 passed (3)', 0, { cwd: 'C:/other' }); }],
    ['skipped tests', (i: LearnInbox) => { fail(i); edit(i); vitestResult(i, 'skip', 'Tests  2 passed | 1 skipped (3)', 0); }],
    ['partial pass', (i: LearnInbox) => { fail(i); edit(i); vitestResult(i, 'fewer', 'Tests  2 passed (2)', 0); }],
    ['background result', (i: LearnInbox) => { fail(i); edit(i); vitestResult(i, 'bg', 'Tests  3 passed (3)', 0, { extra: { kind: 'promoted' } }); }],
    ['later edit', (i: LearnInbox) => { fail(i); edit(i); pass(i); edit(i, 'late-edit'); }],
  ] as const)('does not learn from %s', (_label, replay) => {
    const inbox = make();
    start(inbox, '修一下这个问题');
    replay(inbox);
    end(inbox);
    expect(list(inbox)).toEqual([]);
  });
});

it('wires the host events and serves evidence only on an explicit owner /learn', async () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  const text = '以后先检查文件再动手';
  const userEvent = { type: 'user/message', data: { id: 'msg-1', source: { kind: 'user' }, content: [{ type: 'text', text }] } };
  const agent = { session: { id: owner.sessionId, events: [userEvent] } };
  const record: LearnScope & { agent: typeof agent } = { ...owner, agent };
  const manager = { learnInbox: undefined as LearnInbox | undefined, findByAgent: (who: unknown) => who === agent ? record : undefined,
    findBySessionId: (id: string) => id === owner.sessionId ? record : undefined };
  const register = vi.fn();
  const ctx = { get: () => ({ register }), on: (name: string, fn: (...args: any[]) => void) => handlers.set(name, fn) };
  wireLearnInbox(ctx as unknown as Context, manager as never, { ownerOpenid: 'owner', appId: 'bot' } as never, root, { warn: vi.fn() } as never);
  expect(handlers.has('tools/result')).toBe(true);
  const session = { header: { id: owner.sessionId } };
  const emit = (type: string, data: Record<string, unknown>) => handlers.get('session/event')!(session, { type, data });
  manager.learnInbox!.stage(owner, 'msg-1', 'qq-1', text);
  emit('turn/start', { turn: 1 });
  emit(userEvent.type, userEvent.data);
  emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const tool = register.mock.calls[0]![0];
  const activate = register.mock.calls[0]![1].when;
  expect(tool.name).toBe('qqbot_learn_inbox');
  expect(activate({ agent })).toBe(true);
  expect(activate({ agent: {} })).toBe(false);
  await expect(tool.execute({}, { agent })).rejects.toThrow('/learn');
  start(manager.learnInbox!, '/learn', 2);
  await expect(tool.execute({}, { agent })).resolves.toMatchObject({ drafts: [{ sourceExcerpt: text }] });
  await expect(tool.execute({}, {})).rejects.toThrow('/learn');
});
