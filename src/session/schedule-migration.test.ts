import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatScheduleMigrationHint,
  readScheduleMigrations,
  retireMigratedSchedules,
  type ScheduleServiceLike,
} from './schedule-migration.ts';
import { SessionManager } from './session-manager.ts';
import { DEFAULT_PERSONA_ID } from '../features/persona-store.ts';

const dirs: string[] = [];
function homeWith(tasks: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-schedule-'));
  dirs.push(home);
  mkdirSync(join(home, 'storages'));
  writeFileSync(join(home, 'storages', 'schedule.json'), JSON.stringify({ tables: { tasks } }), 'utf8');
  return home;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const oldSession = 'old-session';

describe('schedule migration', () => {
  it('只迁移旧 session 的 active daily/weekly/cron/every 任务', () => {
    const home = homeWith({
      a: {
        sessionId: oldSession,
        status: 'active',
        record: { kind: 'daily', title: '早报', prompt: '读 RSS 写简报', time: '11:00:00.000', timeZone: 'Asia/Shanghai' },
      },
      b: {
        sessionId: oldSession,
        status: 'active',
        record: { kind: 'every', title: '新图', prompt: '查新图', everySeconds: 7200 },
      },
      c: {
        sessionId: oldSession,
        status: 'active',
        record: { kind: 'weekly', prompt: '周报', time: '20:00:00', timeZone: 'Asia/Shanghai', weekdays: [7] },
      },
      g: {
        sessionId: oldSession,
        status: 'active',
        record: { kind: 'cron', title: '同人图', prompt: '取一张', expression: '0 8,12-13 * * *', timeZone: 'Asia/Shanghai' },
      },
      h: { sessionId: oldSession, status: 'active', record: { kind: 'cron', title: '坏表达式', prompt: 'x', expression: '0 8 *' } },
      d: { sessionId: 'other', status: 'active', record: { kind: 'daily', prompt: 'x', time: '10:00:00' } },
      e: { sessionId: oldSession, status: 'inactive', record: { kind: 'daily', prompt: 'x', time: '10:00:00' } },
      f: { sessionId: oldSession, status: 'active', record: { kind: 'after', prompt: '一次性', afterSeconds: 60 } },
    });

    const tasks = readScheduleMigrations(home, oldSession);
    expect(tasks).toHaveLength(4);
    expect(tasks[0]).toMatchObject({ title: '早报', prompt: '读 RSS 写简报', daily: { time: '11:00:00.000', time_zone: 'Asia/Shanghai' } });
    expect(tasks[1]).toMatchObject({ every_seconds: 7200 });
    expect(tasks[2]).toMatchObject({ weekly: { time: '20:00:00', weekdays: [7] } });
    // cron 不迁移的话，/new 之后这类任务会一直留在旧 session 里跑，永远拿不到新 prompt
    expect(tasks[3]).toMatchObject({ cron: { expression: '0 8,12-13 * * *', time_zone: 'Asia/Shanghai' } });
  });

  it('缺失/损坏存储返回空数组，hint 为空', () => {
    expect(readScheduleMigrations(join(tmpdir(), 'no-such-dsh-home'), oldSession)).toEqual([]);
    expect(formatScheduleMigrationHint([])).toBeUndefined();
  });

  it('生成包含 schedule_create 指令和 JSON 的 hint', () => {
    const hint = formatScheduleMigrationHint([
      { title: '早报', prompt: '读 RSS', daily: { time: '11:00:00', time_zone: 'Asia/Shanghai' } },
    ]);
    expect(hint).toContain('schedule_list');
    expect(hint).toContain('schedule_create');
    expect(hint).toContain('/new 或人设切换');
    expect(hint).toContain('"daily": {');
    expect(hint).toContain('"prompt": "读 RSS"');
  });

  it('hint 里带上「搜图用工具、别每轮搓临时脚本」的提醒', () => {
    const hint = formatScheduleMigrationHint([
      { title: '同人图', prompt: '取一张', cron: { expression: '0 8 * * *', time_zone: 'Asia/Shanghai' } },
    ]);
    expect(hint).toContain('qqbot_booru_fetch');
    expect(hint).toContain('tmp/');
  });

  it('记录旧任务 id，但 hint 里不暴露', () => {
    const home = homeWith({
      'schedule-a': {
        sessionId: oldSession,
        status: 'active',
        record: { id: 'schedule-a', kind: 'daily', title: '早报', prompt: '读 RSS', time: '11:00:00', timeZone: 'Asia/Shanghai' },
      },
    });
    const tasks = readScheduleMigrations(home, oldSession);
    expect(tasks[0]?.sourceId).toBe('schedule-a');
    expect(formatScheduleMigrationHint(tasks)).not.toContain('schedule-a');
  });

  it('retireMigratedSchedules 只删旧 session 里被迁移的任务', async () => {
    const remove = vi.fn(async () => ({ deleted: true }));
    const count = await retireMigratedSchedules({ delete: remove }, oldSession, [
      { title: '早报', prompt: 'x', every_seconds: 600, sourceId: 'schedule-a' },
      { title: '无 id', prompt: 'y', every_seconds: 600 },
    ]);
    expect(count).toBe(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ sessionId: oldSession, id: 'schedule-a' });
  });
});

describe('人设切换复用真实会话重建与定时任务迁移', () => {
  const key = 'qqbot:app:group:g1';
  const hash = createHash('sha256').update(key).digest('hex');
  const derivedSession = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  const cronTask = (id: string, sessionId: string) => ({
    sessionId,
    status: 'active',
    record: { id, kind: 'cron', title: id, prompt: '取一张', expression: '0 8 * * *', timeZone: 'Asia/Shanghai' },
  });

  function harness(options: { live?: boolean; stored?: boolean; targetSession?: string } = {}) {
    let current = DEFAULT_PERSONA_ID;
    const personaSessions = new Map<string, string>();
    if (options.targetSession !== undefined) personaSessions.set('maid', options.targetSession);
    const ids = new Map(options.stored ? [[key, oldSession]] : []);
    const removeTask = vi.fn(async () => ({ deleted: true }));
    const cancel = vi.fn();
    const dispose = vi.fn(async () => {});
    const record = { sessionId: oldSession, agent: { status: 'idle', cancel }, handle: { dispose } };
    const manager = Object.assign(Object.create(SessionManager.prototype) as SessionManager, {
      config: { appId: 'app' },
      sessions: new Map(options.live ? [[key, record]] : []),
      modelSelections: new Map(),
      pendingScheduleMigrations: new Map(),
      retiredSessionIds: new Map(),
      personaStore: {
        currentId: () => current,
        rememberSession: (_group: string, persona: string, session: string) => { personaSessions.set(persona, session); },
        select: (_group: string, persona: string) => { current = persona; },
        sessionFor: (_group: string, persona: string) => personaSessions.get(persona),
      },
      modelResolver: {
        getSessionId: (sessionKey: string) => ids.get(sessionKey),
        setSessionId: (sessionKey: string, id: string) => { ids.set(sessionKey, id); },
      },
      ctx: { get: (name: string) => name === 'schedule' ? { delete: removeTask } : undefined },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    return { manager, removeTask, cancel, dispose, personaSessions };
  }

  it.each([
    { live: true, stored: false, source: oldSession },
    { live: false, stored: true, source: oldSession },
    { live: false, stored: false, source: derivedSession },
  ])('切换新人人设捕获 cron，首条消息注入一次：%j', async ({ live, stored, source }) => {
    vi.stubEnv('DSH_HOME', homeWith({ 'source-cron': cronTask('source-cron', source) }));
    const { manager, removeTask, personaSessions } = harness({ live, stored });
    expect(manager.switchPersona('g1', 'maid')).toBe('ok');
    expect(personaSessions.get(DEFAULT_PERSONA_ID)).toBe(source);
    expect(manager.sessionIdFor('group', 'g1')).not.toBe(source);
    expect(removeTask).not.toHaveBeenCalled();
    const hint = manager.takeScheduleMigration('group', 'g1');
    expect(hint).toContain('"title": "source-cron"');
    expect(hint).toContain('"cron": {');
    expect(hint).toContain('"expression": "0 8 * * *"');
    await vi.waitFor(() => expect(removeTask).toHaveBeenCalledExactlyOnceWith({ sessionId: source, id: 'source-cron' }));
    expect(manager.takeScheduleMigration('group', 'g1')).toBeUndefined();
  });

  it('切回旧人设会话也注入离开会话的任务，不删除目标会话已有任务', async () => {
    vi.stubEnv('DSH_HOME', homeWith({
      'source-cron': cronTask('source-cron', oldSession),
      'target-cron': cronTask('target-cron', 'maid-session'),
    }));
    const { manager, removeTask } = harness({ live: true, targetSession: 'maid-session' });
    expect(manager.switchPersona('g1', 'maid')).toBe('ok');
    expect(manager.sessionIdFor('group', 'g1')).toBe('maid-session');
    const hint = manager.takeScheduleMigration('group', 'g1');
    expect(hint).toContain('source-cron');
    expect(hint).not.toContain('target-cron');
    await vi.waitFor(() => expect(removeTask).toHaveBeenCalledTimes(1));
    expect(removeTask).toHaveBeenCalledWith({ sessionId: oldSession, id: 'source-cron' });
  });

  it('未注入前 A→B→A 时保留 A 自己的 cron，只迁移 B 的任务', async () => {
    vi.stubEnv('DSH_HOME', homeWith({
      'source-cron': cronTask('source-cron', oldSession),
      'target-cron': cronTask('target-cron', 'maid-session'),
    }));
    const { manager, removeTask } = harness({ live: true, targetSession: 'maid-session' });
    manager.switchPersona('g1', 'maid');
    manager.switchPersona('g1', DEFAULT_PERSONA_ID);
    expect(manager.sessionIdFor('group', 'g1')).toBe(oldSession);
    const hint = manager.takeScheduleMigration('group', 'g1');
    expect(hint).toContain('target-cron');
    expect(hint).not.toContain('source-cron');
    await vi.waitFor(() => expect(removeTask).toHaveBeenCalledExactlyOnceWith({ sessionId: 'maid-session', id: 'target-cron' }));
  });

  it('连续往返后再次切走，同一个 cron 只注入一次', async () => {
    vi.stubEnv('DSH_HOME', homeWith({ 'source-cron': cronTask('source-cron', oldSession) }));
    const { manager, removeTask } = harness({ live: true, targetSession: 'maid-session' });
    manager.switchPersona('g1', 'maid');
    manager.switchPersona('g1', DEFAULT_PERSONA_ID);
    manager.switchPersona('g1', 'maid');
    const hint = manager.takeScheduleMigration('group', 'g1');
    expect(hint?.match(/"title": "source-cron"/g)).toHaveLength(1);
    await vi.waitFor(() => expect(removeTask).toHaveBeenCalledTimes(1));
  });

  it('/new 在默认派生会话不在内存时同样捕获 cron', async () => {
    vi.stubEnv('DSH_HOME', homeWith({ 'source-cron': cronTask('source-cron', derivedSession) }));
    const { manager, removeTask } = harness();
    await manager.remove('group', 'g1', 'new-session');
    expect(manager.takeScheduleMigration('group', 'g1')).toContain('source-cron');
    await vi.waitFor(() => expect(removeTask).toHaveBeenCalledExactlyOnceWith({ sessionId: derivedSession, id: 'source-cron' }));
  });
});

describe('SessionManager schedule migration', () => {
  function harness(schedule: ScheduleServiceLike | undefined) {
    // 只测迁移逻辑：用最小的 this 调用原型方法
    const proto = SessionManager.prototype as unknown as {
      captureScheduleMigrations(key: string, oldSessionId: string): void;
      takeScheduleMigration(scope: string, peerId: string): string | undefined;
      getScheduleService(): ScheduleServiceLike | undefined;
    };
    const self = {
      pendingScheduleMigrations: new Map(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ctx: { get: (name: string) => (name === 'schedule' ? schedule : undefined) },
      sessionKey: (scope: string, peerId: string) => `${scope}:${peerId}`,
      getScheduleService: proto.getScheduleService,
    };
    return {
      capture: (oldSessionId: string) => proto.captureScheduleMigrations.call(self, 'group:g1', oldSessionId),
      take: () => proto.takeScheduleMigration.call(self, 'group', 'g1'),
      logger: self.logger,
    };
  }

  const dailyTask = (id: string, sessionId: string) => ({
    sessionId,
    status: 'active',
    record: { id, kind: 'daily', title: `早报-${id}`, prompt: '读 RSS', time: '11:00:00', timeZone: 'Asia/Shanghai' },
  });

  it('/new 后交出重建指令时删除旧 session 的任务，避免新旧会话重复触发', async () => {
    vi.stubEnv('DSH_HOME', homeWith({
      'schedule-a': dailyTask('schedule-a', oldSession),
      'schedule-cron': { sessionId: oldSession, status: 'active', record: { id: 'schedule-cron', kind: 'cron', prompt: 'c' } },
      'schedule-other': dailyTask('schedule-other', 'other'),
    }));
    const remove = vi.fn(async () => ({ deleted: true }));
    const { capture, take } = harness({ delete: remove });

    capture(oldSession);
    // /new 本身不删：新会话还没重建前，旧任务继续生效
    expect(remove).not.toHaveBeenCalled();

    const hint = take();
    expect(hint).toContain('早报-schedule-a');
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(remove).toHaveBeenCalledWith({ sessionId: oldSession, id: 'schedule-a' });

    // 只交出一次，也只删一次
    expect(take()).toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('连续 /new 时不丢前一批，按各自旧 sessionId 删除', async () => {
    vi.stubEnv('DSH_HOME', homeWith({ 'schedule-a': dailyTask('schedule-a', oldSession) }));
    const remove = vi.fn(async () => ({ deleted: true }));
    const { capture, take } = harness({ delete: remove });

    capture(oldSession);
    capture('middle-session-without-tasks');
    expect(take()).toContain('早报-schedule-a');
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith({ sessionId: oldSession, id: 'schedule-a' }));
  });

  it('同一来源被反复捕获时只保留一批任务', () => {
    vi.stubEnv('DSH_HOME', homeWith({ 'schedule-a': dailyTask('schedule-a', oldSession) }));
    const { capture, take } = harness(undefined);
    capture(oldSession);
    capture(oldSession);
    expect(take()?.match(/"title": "早报-schedule-a"/g)).toHaveLength(1);
  });

  it('重复捕获刷新来源快照，不复活已经删掉的任务', () => {
    const home = homeWith({ 'schedule-a': dailyTask('schedule-a', oldSession) });
    vi.stubEnv('DSH_HOME', home);
    const { capture, take } = harness(undefined);
    capture(oldSession);
    writeFileSync(join(home, 'storages', 'schedule.json'), JSON.stringify({ tables: { tasks: {} } }), 'utf8');
    capture(oldSession);
    expect(take()).toBeUndefined();
  });

  it('没有 schedule 服务时仍给出 hint 并告警', () => {
    vi.stubEnv('DSH_HOME', homeWith({ 'schedule-a': dailyTask('schedule-a', oldSession) }));
    const { capture, take, logger } = harness(undefined);
    capture(oldSession);
    expect(take()).toContain('早报-schedule-a');
    expect(logger.warn).toHaveBeenCalled();
  });
});
