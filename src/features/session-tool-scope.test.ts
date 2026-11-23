import { describe, expect, it, vi } from 'vitest';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { AGENT_TOOLS, SHELL_TOOLS } from '../shared/tool-guard.ts';
import {
  BILI_LOGIN_TOOLS,
  computeSessionDeniedTools,
  NON_QQ_ONLY_TOOLS,
  SessionToolScope,
  type SessionToolScopeConfig,
} from './session-tool-scope.ts';

function makeConfig(overrides: Partial<SessionToolScopeConfig> = {}): SessionToolScopeConfig {
  return {
    ownerOpenid: 'OWNER_1',
    adminOpenids: ['ADMIN_1'],
    toolAccess: {
      enabled: true,
      fullAccessGroups: ['FULL_GROUP'],
      fullAccessUsers: ['FULL_USER'],
      readRoots: [],
    },
    imageGen: {
      enabled: true,
      allowAllGroups: false,
      allowedGroups: ['IMAGE_GROUP'],
    } as ImQQBotConfig['imageGen'],
    ...overrides,
  };
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('computeSessionDeniedTools', () => {
  it('受限未授权群：隐藏终端/子代理、notes_manage、qqbot_bili_auth 与 image_gen，保留 qqbot_access 供群内申请', () => {
    const config = makeConfig();
    const denied = computeSessionDeniedTools(
      { scope: 'group', peerId: 'GROUP_PLAIN', senderId: 'U_1' },
      config,
      () => false,
    );
    for (const name of [...SHELL_TOOLS, ...AGENT_TOOLS, ...BILI_LOGIN_TOOLS]) {
      expect(denied).toContain(name);
    }
    expect(denied).toContain('qqbot_notes_manage');
    expect(denied).toContain('qqbot_image_gen');
    expect(denied).not.toContain('qqbot_access');
    expect(denied).not.toContain('qqbot_describe_image');
  });

  it('受限非主人私聊：隐藏终端/子代理、notes_manage、qqbot_bili_auth 与 image_gen', () => {
    const config = makeConfig();
    const denied = computeSessionDeniedTools(
      { scope: 'c2c', peerId: 'OTHER_USER', senderId: 'OTHER_USER' },
      config,
      () => false,
    );
    expect(denied).toContain('qqbot_notes_manage');
    expect(denied).toContain('qqbot_image_gen');
    expect(denied).not.toContain('qqbot_access');
    for (const name of [...SHELL_TOOLS, ...AGENT_TOOLS, ...BILI_LOGIN_TOOLS]) {
      expect(denied).toContain(name);
    }
  });

  it('主人私聊：全部相关工具均可见（返回空数组）', () => {
    const config = makeConfig();
    const denied = computeSessionDeniedTools(
      { scope: 'c2c', peerId: 'OWNER_1', senderId: 'OWNER_1' },
      config,
      () => true,
    );
    expect(denied).toEqual([]);
  });

  it('管理员非白名单私聊：保留 qqbot_bili_auth，仍隐藏终端/子代理、notes_manage 与 image_gen', () => {
    const config = makeConfig();
    const denied = computeSessionDeniedTools(
      { scope: 'c2c', peerId: 'ADMIN_1', senderId: 'ADMIN_1' },
      config,
      () => false,
    );
    expect(denied).not.toContain('qqbot_bili_auth');
    for (const name of [...SHELL_TOOLS, ...AGENT_TOOLS]) expect(denied).toContain(name);
    expect(denied).toContain('qqbot_notes_manage');
    expect(denied).toContain('qqbot_image_gen');
  });

  it('终端白名单群：放开终端/子代理和 qqbot_image_gen，仍隐藏 notes_manage 与 qqbot_bili_auth', () => {
    const config = makeConfig();
    const denied = computeSessionDeniedTools(
      { scope: 'group', peerId: 'FULL_GROUP', senderId: 'U_1' },
      config,
      (s) => s.peerId === 'FULL_GROUP',
    );
    for (const name of [...SHELL_TOOLS, ...AGENT_TOOLS]) expect(denied).not.toContain(name);
    expect(denied).not.toContain('qqbot_image_gen');
    expect(denied).toContain('qqbot_notes_manage');
    expect(denied).toContain('qqbot_bili_auth');
  });

  it('全群生图开启的受限群：放开 qqbot_image_gen', () => {
    const config = makeConfig({
      imageGen: { enabled: true, allowAllGroups: true, allowedGroups: [] } as ImQQBotConfig['imageGen'],
    });
    const denied = computeSessionDeniedTools(
      { scope: 'group', peerId: 'GROUP_PLAIN', senderId: 'U_1' },
      config,
      () => false,
    );
    expect(denied).not.toContain('qqbot_image_gen');
  });
});

interface MockScopeOpts {
  restrictableNames?: ReadonlySet<string>;
  definitions?: readonly { name: string }[];
  get?: (name: string) => unknown;
  failOnRestrict?: boolean;
  noRestrict?: boolean;
  isCombat?: boolean;
  scopeKey?: object;
}

function makeHarness(
  configOverrides: Partial<SessionToolScopeConfig> = {},
  initialFullAccess = false,
  opts: MockScopeOpts = {},
) {
  let fullAccess = initialFullAccess;
  const config = makeConfig(configOverrides);
  const live: string[][] = [];
  const callOrder: string[] = [];
  const restrict = vi.fn((filter: { deny: readonly string[] }) => {
    if (opts.failOnRestrict === true) throw new Error('restrict failed');
    const entry = [...filter.deny];
    live.push(entry);
    callOrder.push(`install:${entry.length}`);
    return () => {
      const idx = live.indexOf(entry);
      if (idx >= 0) live.splice(idx, 1);
      callOrder.push(`lift:${entry.length}`);
    };
  });

  const toolsService: Record<string, unknown> = opts.noRestrict === true ? {} : { restrict };
  if (opts.restrictableNames !== undefined) {
    const names = opts.restrictableNames;
    toolsService.view = vi.fn((_scope?: unknown) => ({ restrictableNames: names }));
  }
  if (opts.definitions !== undefined) {
    const defs = opts.definitions;
    toolsService.definitions = vi.fn(() => defs);
  }
  if (opts.get !== undefined) {
    toolsService.get = vi.fn(opts.get);
  }

  const ctxObj: Record<PropertyKey, unknown> = {
    get: () => toolsService,
  };
  if (opts.scopeKey !== undefined) {
    ctxObj[Symbol('dsh.scope')] = opts.scopeKey;
  }
  const agent = { ctx: ctxObj as { get(name: string): unknown } };
  const logger = makeLogger();
  const scope = new SessionToolScope({
    config,
    isFullAccess: () => fullAccess,
    isCombatAgent: opts.isCombat ? () => true : undefined,
    logger,
  });

  return {
    config,
    scope,
    agent,
    live,
    callOrder,
    restrict,
    toolsService,
    logger,
    setFullAccess: (next: boolean) => { fullAccess = next; },
  };
}

describe('SessionToolScope', () => {
  it('通过 view(scopeKey).restrictableNames / definitions() / get() 过滤未注册工具名', () => {
    const scopeKey = {};
    const hView = makeHarness({}, false, {
      restrictableNames: new Set(['pwsh', 'subagent', 'qqbot_notes_manage']),
      scopeKey,
    });
    hView.scope.sync({ sessionKey: 'k1', scope: 'group', peerId: 'G1', senderId: 'U1', agent: hView.agent });
    expect((hView.toolsService.view as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(scopeKey);
    expect(hView.live).toEqual([['pwsh', 'qqbot_notes_manage', 'subagent']]);

    const hDefs = makeHarness({}, false, {
      definitions: [{ name: 'bash' }, { name: 'qqbot_image_gen' }],
    });
    hDefs.scope.sync({ sessionKey: 'k2', scope: 'group', peerId: 'G1', senderId: 'U1', agent: hDefs.agent });
    expect(hDefs.live).toEqual([['bash', 'qqbot_image_gen']]);

    const registered = new Set(['qqbot_bili_auth', 'qqbot_notes_manage']);
    const hGet = makeHarness({}, false, {
      get: (name) => (registered.has(name) ? { name } : undefined),
    });
    hGet.scope.sync({ sessionKey: 'k3', scope: 'group', peerId: 'G1', senderId: 'U1', agent: hGet.agent });
    expect(hGet.live).toEqual([['qqbot_bili_auth', 'qqbot_notes_manage']]);
  });

  it('hideForNonQq：NON_QQ_ONLY_TOOLS 为空时安全无副作用、不调用 restrict、异常绝不外抛', () => {
    expect(NON_QQ_ONLY_TOOLS).toEqual([]);
    const h = makeHarness();
    h.scope.hideForNonQq(h.agent);
    expect(h.restrict).not.toHaveBeenCalled();

    const hFail = makeHarness({}, false, { failOnRestrict: true });
    expect(() => hFail.scope.hideForNonQq(hFail.agent)).not.toThrow();

    const hNoSupport = makeHarness({}, false, { noRestrict: true });
    expect(() => hNoSupport.scope.hideForNonQq(hNoSupport.agent)).not.toThrow();

    expect(() => hFail.scope.hideForNonQq({ ctx: { get: () => { throw new Error('boom'); } } })).not.toThrow();
  });

  it('受限会话随后绑定为主人私聊时，sync 彻底撤掉限制', () => {
    const h = makeHarness({}, false);
    h.scope.sync({ sessionKey: 'k_grp', scope: 'group', peerId: 'G1', senderId: 'U1', agent: h.agent });
    expect(h.live).toHaveLength(1);

    h.setFullAccess(true);
    h.scope.sync({ sessionKey: 'k_owner', scope: 'c2c', peerId: 'OWNER_1', senderId: 'OWNER_1', agent: h.agent });
    expect(h.live).toEqual([]);
    expect(h.restrict).toHaveBeenCalledTimes(1);
  });

  it('同一拒绝集重复 sync 直接跳过（不重调 restrict，保护提示词前缀缓存）', () => {
    const h = makeHarness();
    const record = { sessionKey: 'k_grp', scope: 'group' as const, peerId: 'G1', senderId: 'U1', agent: h.agent };
    h.scope.sync(record);
    h.scope.sync(record);
    expect(h.restrict).toHaveBeenCalledTimes(1);
  });

  it('动态授予/撤销白名单时：先装新限制再撤旧限制，且立即生效', () => {
    const h = makeHarness();
    const record = { sessionKey: 'k_grp', scope: 'group' as const, peerId: 'G1', senderId: 'U1', agent: h.agent };
    h.scope.sync(record);
    const initialCount = h.live[0]!.length;

    h.setFullAccess(true);
    h.scope.sync(record);
    expect(h.live).toHaveLength(1);
    const afterGrantCount = h.live[0]!.length;
    expect(afterGrantCount).toBeLessThan(initialCount);
    expect(h.callOrder).toEqual([
      `install:${initialCount}`,
      `install:${afterGrantCount}`,
      `lift:${initialCount}`,
    ]);

    h.setFullAccess(false);
    h.scope.sync(record);
    expect(h.live).toHaveLength(1);
    expect(h.live[0]!.length).toBe(initialCount);
  });

  it('战斗子代理会被同时跳过 hideForNonQq 与 sync', () => {
    const h = makeHarness({}, false, { isCombat: true });
    h.scope.hideForNonQq(h.agent);
    h.scope.sync({ sessionKey: 'k_combat', scope: 'group', peerId: 'G1', senderId: 'U1', agent: h.agent });
    expect(h.restrict).not.toHaveBeenCalled();
    expect(h.live).toEqual([]);
  });

  it('release 仅清记录不撤限制，disposeAll 撤掉所有存活限制并清空状态', () => {
    const h = makeHarness();
    const gone = { ctx: h.agent.ctx };
    h.scope.sync({ sessionKey: 'k_alive', scope: 'group', peerId: 'G1', senderId: 'U1', agent: h.agent });
    h.scope.sync({ sessionKey: 'k_gone', scope: 'group', peerId: 'G2', senderId: 'U1', agent: gone });
    expect(h.live).toHaveLength(2);

    h.scope.release(gone);
    h.scope.disposeAll();
    expect(h.live).toHaveLength(1);

    // 重新同步存活 agent 不受旧缓存状态影响
    h.scope.sync({ sessionKey: 'k_grp', scope: 'group', peerId: 'G1', senderId: 'U1', agent: h.agent });
    expect(h.live).toHaveLength(2);
  });

  it('restrict 抛错时保留原有生效限制并记警告，下次 sync 可继续重试', () => {
    let fail = false;
    const config = makeConfig();
    const live: string[][] = [];
    const restrict = vi.fn((filter: { deny: readonly string[] }) => {
      if (fail) throw new Error('transient');
      const entry = [...filter.deny];
      live.push(entry);
      return () => { live.splice(live.indexOf(entry), 1); };
    });
    const agent = { ctx: { get: () => ({ restrict }) } };
    const logger = makeLogger();
    let full = false;
    const scope = new SessionToolScope({ config, isFullAccess: () => full, logger });
    const record = { sessionKey: 'k_retry', scope: 'group' as const, peerId: 'G1', senderId: 'U1', agent };

    scope.sync(record);
    const beforeDenied = [...live[0]!];

    fail = true;
    full = true;
    scope.sync(record);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(live).toEqual([beforeDenied]);

    fail = false;
    scope.sync(record);
    expect(live).toHaveLength(1);
    expect(live[0]!.length).toBeLessThan(beforeDenied.length);
  });
});
