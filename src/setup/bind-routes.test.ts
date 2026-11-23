/**
 * 端内绑定路由测试
 *
 * 用假的 webServer 捕获注册的 handler，验证：
 * 状态查询协议（含 bound 相位）、refresh / manual 动作、
 * 方法守卫、Origin 信任校验与 manual 请求体校验。
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BIND_CONFIG_PATH,
  BIND_MANUAL_PATH,
  BIND_PERSONAS_OPEN_PATH,
  BIND_PERSONAS_PATH,
  BIND_REFRESH_PATH,
  BIND_STATE_PATH,
  BIND_UNBIND_PATH,
  formatWindowsExplorerTarget,
  openDirectoryInOs,
  registerBindRoutes,
  type BindRoutesOptions,
  type WebRoute,
} from './bind-routes.ts';
import type { BindingService } from './binding-service.ts';
import { parsePersona } from '../features/persona-store.ts';

/** 默认 unbind/persist 实现依赖 getProfileDir：用可控 mock 替换（其余导出保留） */
const profileDirState = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock('../shared/index.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getProfileDir: () => profileDirState.dir };
});

/** 假 req：EventEmitter + headers/method + 可读 body */
function fakeReq(method: string, headers: Record<string, string | undefined> = {}, body?: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { headers: Record<string, string | undefined> }).headers = headers;
  Object.assign(req, {
    resume: vi.fn(),
    // 模拟异步可读流：POST body 异步推送
    [Symbol.asyncIterator]() {
      const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
      let index = 0;
      return {
        next: () => Promise.resolve(index < chunks.length
          ? { done: false, value: chunks[index++] as Buffer }
          : { done: true as const, value: undefined }),
      };
    },
  });
  return req;
}

/** 假 res：捕获 writeHead/end */
function fakeRes(): ServerResponse & { statusCode: number; body: string; headers: Record<string, string> } {
  const res = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(payload?: string) {
      if (payload !== undefined) res.body += payload;
    },
  };
  return res as unknown as ServerResponse & { statusCode: number; body: string; headers: Record<string, string> };
}

function createHarness(options: BindRoutesOptions = {}): {
  routes: Map<string, WebRoute>;
  service: { wireState: () => unknown; refresh: () => void };
  manualSubmits: unknown[];
} {
  const routes = new Map<string, WebRoute>();
  const webServer = {
    register(route: WebRoute): () => void {
      routes.set(route.path, route);
      return () => { routes.delete(route.path); };
    },
  };
  const service = {
    wireState: vi.fn(() => ({ phase: 'starting' })),
    refresh: vi.fn(),
  } as unknown as BindingService;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const manualSubmits: unknown[] = [];
  const wrappedOptions: BindRoutesOptions = {
    ...options,
    onManualCredentials: (credentials) => {
      manualSubmits.push(credentials);
      return options.onManualCredentials?.(credentials) ?? { persisted: true };
    },
  };
  registerBindRoutes(webServer, service, logger, wrappedOptions);
  return {
    routes,
    service: service as unknown as { wireState: () => unknown; refresh: () => void },
    manualSubmits,
  };
}

async function invoke(route: WebRoute | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (route === undefined) throw new Error('route not registered');
  await route.handler(req, res);
}

function json(res: { body: string }): unknown {
  return JSON.parse(res.body);
}

describe('bind-routes', () => {
  it('注册状态、刷新与手动提交三条精确路由', () => {
    const { routes } = createHarness();
    expect(routes.has(BIND_STATE_PATH)).toBe(true);
    expect(routes.has(BIND_REFRESH_PATH)).toBe(true);
    expect(routes.has(BIND_MANUAL_PATH)).toBe(true);
    expect(routes.get(BIND_STATE_PATH)?.kind).toBe('exact');
  });

  it('GET state：返回 200 + 序列化相位 + no-store', async () => {
    const { routes, service } = createHarness();
    service.wireState = () => ({ phase: 'waiting', url: 'https://q.qq.com/t1', issuedAt: 1 });

    const res = fakeRes();
    await invoke(routes.get(BIND_STATE_PATH), fakeReq('GET', { host: '127.0.0.1:3080' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(json(res)).toEqual({ phase: 'waiting', url: 'https://q.qq.com/t1', issuedAt: 1 });
  });

  it('GET state（bound）：优先返回脱敏 appId，不触碰扫码状态机', async () => {
    const { routes, service } = createHarness({ boundAppId: () => '102120114' });

    const res = fakeRes();
    await invoke(routes.get(BIND_STATE_PATH), fakeReq('GET', { host: '127.0.0.1:3080' }), res);

    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ phase: 'bound', appId: '102120114' });
    expect(service.wireState).not.toHaveBeenCalled();
  });

  it('HEAD state：允许', async () => {
    const { routes } = createHarness();
    const res = fakeRes();
    await invoke(routes.get(BIND_STATE_PATH), fakeReq('HEAD', { host: 'x' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('POST state：405', async () => {
    const { routes } = createHarness();
    const res = fakeRes();
    await invoke(routes.get(BIND_STATE_PATH), fakeReq('POST', { host: 'x' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('POST refresh：调用 service.refresh 并返回 starting', async () => {
    const { routes, service } = createHarness();
    const req = fakeReq('POST', { host: '127.0.0.1:3080' });
    const res = fakeRes();
    await invoke(routes.get(BIND_REFRESH_PATH), req, res);

    expect(service.refresh).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ phase: 'starting' });
  });

  it('GET refresh：405', async () => {
    const { routes } = createHarness();
    const res = fakeRes();
    await invoke(routes.get(BIND_REFRESH_PATH), fakeReq('GET', { host: 'x' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('POST manual：合法凭据 → 提交处理并返回成功', async () => {
    const { routes, manualSubmits } = createHarness();
    const res = fakeRes();
    await invoke(
      routes.get(BIND_MANUAL_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' }, '{"appId":"102120114","appSecret":"s3cr3t"}'),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true, message: '凭据已保存，插件将自动重载' });
    expect(manualSubmits).toEqual([{ appId: '102120114', appSecret: 's3cr3t' }]);
  });

  it('POST manual：缺失字段 → 400', async () => {
    const { routes } = createHarness();
    const res = fakeRes();
    await invoke(
      routes.get(BIND_MANUAL_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080' }, '{"appId":"102120114"}'),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST manual：空 body → 400', async () => {
    const { routes } = createHarness();
    const res = fakeRes();
    await invoke(routes.get(BIND_MANUAL_PATH), fakeReq('POST', { host: '127.0.0.1:3080' }, ''), res);
    expect(res.statusCode).toBe(400);
  });

  it('POST manual：persisted=false → 500 + 错误信息', async () => {
    const { routes } = createHarness({
      onManualCredentials: () => ({ persisted: false, error: '写入失败' }),
    });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_MANUAL_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080' }, '{"appId":"a","appSecret":"b"}'),
      res,
    );
    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual({ ok: false, error: '写入失败' });
  });

  it('GET manual：405', async () => {
    const { routes } = createHarness();
    const res = fakeRes();
    await invoke(routes.get(BIND_MANUAL_PATH), fakeReq('GET', { host: 'x' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('POST unbind（bound 态）：调用解绑处理并返回成功', async () => {
    const { routes } = createHarness({
      boundAppId: () => '102120114',
      onUnbind: () => ({ persisted: true }),
    });
    const res = fakeRes();
    await invoke(routes.get(BIND_UNBIND_PATH), fakeReq('POST', { host: '127.0.0.1:3080' }), res);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true, message: '已解绑，插件将重载并重新进入绑定流程' });
  });

  it('POST unbind（未绑定）：409，不触达解绑处理', async () => {
    const { routes } = createHarness();
    const res = fakeRes();
    await invoke(routes.get(BIND_UNBIND_PATH), fakeReq('POST', { host: '127.0.0.1:3080' }), res);
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ ok: false, error: '当前未绑定' });
  });

  it('GET unbind：405', async () => {
    const { routes } = createHarness();
    const res = fakeRes();
    await invoke(routes.get(BIND_UNBIND_PATH), fakeReq('GET', { host: 'x' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('POST unbind（默认实现）：删除 patch 凭据并清除进程 env（否则 HMR 后仍读到旧凭据，状态停留 bound）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'im-qqbot-unbind-'));
    const patchPath = join(dir, 'cordis.patch.yml');
    writeFileSync(patchPath, [
      '- id: im-qqbot',
      '  config:',
      '    appId: "102120114"',
      '    appSecret: "s3cr3t"',
      '    requireMention: true',
      '',
    ].join('\n'), 'utf8');
    profileDirState.dir = dir;
    // 扫码绑定成功时会写入进程 env：模拟该残留
    const savedAppId = process.env.QQBOT_APPID;
    const savedSecret = process.env.QQBOT_SECRET;
    process.env.QQBOT_APPID = '102120114';
    process.env.QQBOT_SECRET = 's3cr3t';

    try {
      const { routes } = createHarness({ boundAppId: () => '102120114' });
      const res = fakeRes();
      await invoke(routes.get(BIND_UNBIND_PATH), fakeReq('POST', { host: '127.0.0.1:3080' }), res);

      expect(res.statusCode).toBe(200);
      expect(json(res)).toMatchObject({ ok: true });
      // 进程 env 凭据被清除（HMR 重载后新 fiber 不再回退读到旧凭据）
      expect(process.env.QQBOT_APPID).toBeUndefined();
      expect(process.env.QQBOT_SECRET).toBeUndefined();
      // patch 中的凭据被删除、其余配置保留
      const content = readFileSync(patchPath, 'utf8');
      expect(content).not.toContain('appId');
      expect(content).not.toContain('appSecret');
      expect(content).toContain('requireMention: true');
    } finally {
      profileDirState.dir = undefined;
      if (savedAppId === undefined) delete process.env.QQBOT_APPID;
      else process.env.QQBOT_APPID = savedAppId;
      if (savedSecret === undefined) delete process.env.QQBOT_SECRET;
      else process.env.QQBOT_SECRET = savedSecret;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST unbind（幂等重入）：patch 已无凭据时仍写回文件（触发宿主 HMR，bound fiber 才会卸载）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'im-qqbot-unbind-idem-'));
    const patchPath = join(dir, 'cordis.patch.yml');
    // 凭据已被上一次解绑删除，但 fiber 未重载（无 HMR）的场景
    writeFileSync(patchPath, [
      '- id: im-qqbot',
      '  config:',
      '    requireMention: true',
      '',
    ].join('\n'), 'utf8');
    profileDirState.dir = dir;
    const before = readFileSync(patchPath, 'utf8');

    try {
      const { routes } = createHarness({ boundAppId: () => '102120114' });
      const res = fakeRes();
      await invoke(routes.get(BIND_UNBIND_PATH), fakeReq('POST', { host: '127.0.0.1:3080' }), res);

      expect(res.statusCode).toBe(200);
      // 文件被重写（mtime 更新触发宿主 HMR 重载），内容仍为合法 YAML
      expect(readFileSync(patchPath, 'utf8')).toEqual(before);
    } finally {
      profileDirState.dir = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (profileDirState.dir !== undefined) {
      rmSync(profileDirState.dir, { recursive: true, force: true });
      profileDirState.dir = undefined;
    }
  });

  it('GET config：回显生效配置且剔除 appSecret', async () => {
    const { routes } = createHarness({
      currentConfig: () => ({ appId: '102120114', appSecret: 'SECRET', requireMention: true, cwd: '/tmp/w' }),
    });
    const res = fakeRes();
    await invoke(routes.get(BIND_CONFIG_PATH), fakeReq('GET', { host: '127.0.0.1:3080' }), res);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ config: { appId: '102120114', requireMention: true, cwd: '/tmp/w' } });
  });

  it('POST config：白名单内合法值通过并触发合并写入', async () => {
    const { routes } = createHarness({ onUpdateConfig: () => true });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' },
        '{"requireMention":false,"access":{"c2cMode":"allowlist","c2cAllow":["u1"],"groupMode":"open","groupAllow":[]}}'),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true, message: '配置已保存，插件将自动重载（进行中的机器人会话将重置）' });
  });

  it('POST config：凭据字段被拒绝并引导绑定功能', async () => {
    const { routes } = createHarness();
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080' }, '{"appSecret":"xxx"}'),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(json(res)).toMatchObject({ ok: false, error: expect.stringContaining('凭据') });
  });

  it('POST config：cwd 只读字段被拒绝', async () => {
    const { routes } = createHarness();
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080' }, '{"cwd":"/etc"}'),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(json(res)).toMatchObject({ ok: false, error: expect.stringContaining('只读') });
  });

  it('POST config：未知字段不在白名单被拒绝', async () => {
    const { routes } = createHarness();
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080' }, '{"unknownKey":50}'),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST config：新增嵌套组通过校验并写入', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({
      onUpdateConfig: (config) => { updates.push(config); return true; },
    });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' },
        JSON.stringify({
          notes: {
            enabled: false, root: 'C:/notes', autoInject: true, injectTopK: 3,
            injectMaxChars: 500, injectPerNoteChars: 180, groupInjectMaxChars: 300, injectMinCoverage: 0.5,
          },
          media: { enabled: true, maxMB: 100, ttlHours: 12, maxTotalMB: 512 },
          video: { enabled: false, ffmpegPath: 'C:/ffmpeg/bin/ffmpeg.exe', maxFrames: 4, maxSeconds: 60 },
          toolAccess: { enabled: true, fullAccessGroups: ['g1'], fullAccessUsers: [], readRoots: ['C:/x'] },
          dnd: { enabled: true, root: '', turnButtons: false, interjections: true },
        })),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      notes: { enabled: false, injectPerNoteChars: 180, groupInjectMaxChars: 300 },
      video: { maxFrames: 4 },
      toolAccess: { fullAccessGroups: ['g1'] },
      dnd: { turnButtons: false },
    });
  });

  it.each([
    { injectPerNoteChars: -1 },
    { injectPerNoteChars: 4001 },
    { injectPerNoteChars: '100' },
    { groupInjectMaxChars: -5 },
    { groupInjectMaxChars: 5000 },
    { groupInjectMaxChars: false },
  ])('POST config：拒绝非法 notes 注入预算字段 %j', async (badNotes) => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (config) => { updates.push(config); return true; } });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' }, JSON.stringify({ notes: badNotes })),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('POST config：战斗代理配置可保存，且只写 dnd 顶层键', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (config) => { updates.push(config); return true; } });
    const res = fakeRes();
    await invoke(routes.get(BIND_CONFIG_PATH), fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({
      dnd: { combatAgent: { enabled: true, provider: 'opencode-go', model: 'deepseek-v4.1-flash', contextChars: 8000 } },
    })), res);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(updates[0]!)).toEqual(['dnd']);
    expect(updates[0]).toMatchObject({ dnd: { combatAgent: { enabled: true, model: 'deepseek-v4.1-flash', contextChars: 8000 } } });
  });

  it.each([
    { enabled: 'true' }, { provider: 42 }, { model: false }, { reasoningEffort: 42 },
    { contextChars: 999 }, { contextChars: 30001 }, { contextChars: 1000.5 },
  ])('POST config：拒绝非法战斗代理字段 %j', async (combatAgent) => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (config) => { updates.push(config); return true; } });
    const res = fakeRes();
    await invoke(routes.get(BIND_CONFIG_PATH), fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({ dnd: { combatAgent } })), res);
    expect(res.statusCode).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('POST config：speak 通过校验并写入', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (config) => { updates.push(config); return true; } });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' },
        '{"speak":{"enabled":true,"voice":"zh-CN-XiaoxiaoNeural","rate":"+5%","maxChars":80,"command":""}}'),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(updates[0]).toMatchObject({ speak: { voice: 'zh-CN-XiaoxiaoNeural', maxChars: 80 } });
  });

  it('POST config：speak.voice 类型错误被拒', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (config) => { updates.push(config); return true; } });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' },
        '{"speak":{"enabled":true,"voice":42,"rate":"+5%","maxChars":80,"command":""}}'),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('POST config：speak.gsvUrl / gsvSpeed 通过校验并写入', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (config) => { updates.push(config); return true; } });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' },
        '{"speak":{"enabled":true,"voice":"zh-CN-XiaoyiNeural","rate":"+8%","maxChars":120,"command":"",'
        + '"gsvUrl":"http://127.0.0.1:8765","gsvSpeed":1.1}}'),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(updates[0]).toMatchObject({ speak: { gsvUrl: 'http://127.0.0.1:8765', gsvSpeed: 1.1 } });
  });

  it('POST config：speak.gsvSpeed 类型错误被拒', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (config) => { updates.push(config); return true; } });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' },
        '{"speak":{"enabled":true,"voice":"zh-CN-XiaoyiNeural","rate":"+8%","maxChars":120,"command":"",'
        + '"gsvUrl":"http://127.0.0.1:8765","gsvSpeed":"fast"}}'),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('POST config：replyDesire 通过校验并写入', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (config) => { updates.push(config); return true; } });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' },
        '{"replyDesire":{"enabled":true,"threshold":0.5,"names":["大肥鱼"],"engagedMs":90000,"engagedMaxTurns":8}}'),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(updates[0]).toMatchObject({ replyDesire: { enabled: true, threshold: 0.5, names: ['大肥鱼'] } });
  });

  it('POST config：replyDesire.judge 通过校验，没传的字段补默认值', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (config) => { updates.push(config); return true; } });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' },
        '{"replyDesire":{"enabled":true,"threshold":0.6,"names":[],"engagedMs":90000,"engagedMaxTurns":8,'
        + '"judge":{"enabled":true,"model":"deepseek-v4-flash","debounceMs":3000}}}'),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(updates[0]).toMatchObject({
      replyDesire: { judge: { enabled: true, model: 'deepseek-v4-flash', debounceMs: 3000, provider: '', maxWaitMs: 15000 } },
    });
  });

  it('POST config：replyDesire.judge 越界或类型错误被拒绝', async () => {
    for (const judge of ['{"debounceMs":-1}', '{"contextMessages":0}', '{"timeoutMs":"fast"}', '{"enabled":"yes"}']) {
      const { routes } = createHarness({ onUpdateConfig: () => true });
      const res = fakeRes();
      await invoke(
        routes.get(BIND_CONFIG_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080' }, `{"replyDesire":{"enabled":true,"judge":${judge}}}`),
        res,
      );
      expect(res.statusCode, judge).toBe(400);
    }
  });

  it('POST config：私聊压缩比例与工具链推迟开关通过校验并写入', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (value) => { updates.push(value); return true; } });
    const res = fakeRes();
    await invoke(routes.get(BIND_CONFIG_PATH), fakeReq('POST', { host: '127.0.0.1:3080' },
      '{"autoCompactPrivateRatio":0.6,"autoCompactDeferOnTools":false}'), res);
    expect(res.statusCode).toBe(200);
    expect(updates[0]).toEqual({ autoCompactPrivateRatio: 0.6, autoCompactDeferOnTools: false });
  });

  it('POST config：空闲压缩三个键通过校验并写入', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (value) => { updates.push(value); return true; } });
    const res = fakeRes();
    await invoke(routes.get(BIND_CONFIG_PATH), fakeReq('POST', { host: '127.0.0.1:3080' },
      '{"idleCompactMinutes":30,"idleCompactTokens":100000,"idleCompactProviders":"google, google-vertex"}'), res);
    expect(res.statusCode).toBe(200);
    expect(updates[0]).toEqual({ idleCompactMinutes: 30, idleCompactTokens: 100000, idleCompactProviders: 'google, google-vertex' });
  });

  it.each([
    { idleCompactMinutes: -1 }, { idleCompactMinutes: 1441 }, { idleCompactMinutes: '20' },
    { idleCompactTokens: 1.5 }, { idleCompactTokens: 1_000_001 }, { idleCompactProviders: 5 },
    { autoCompactPrivateRatio: -0.1 }, { autoCompactPrivateRatio: 0.95 }, { autoCompactPrivateRatio: '0.5' },
    { autoCompactDeferOnTools: 'yes' },
  ])('POST config：压缩配置非法值被拒 %j', async (body) => {
    const update = vi.fn(() => true);
    const { routes } = createHarness({ onUpdateConfig: update });
    const res = fakeRes();
    await invoke(routes.get(BIND_CONFIG_PATH), fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify(body)), res);
    expect(res.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('POST config：数值越界被拒绝', async () => {
    const { routes } = createHarness({ onUpdateConfig: () => true });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080' }, '{"maxQueue":0}'),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('GET config：不回传 asr.apiKey', async () => {
    const { routes } = createHarness({
      currentConfig: () => ({ asr: { enabled: true, apiKey: 'sk-secret', timeoutMs: 30000 } }),
    });
    const res = fakeRes();
    await invoke(routes.get(BIND_CONFIG_PATH), fakeReq('GET', { host: '127.0.0.1:3080' }), res);
    const body = json(res) as { config: { asr: { apiKey: string; enabled: boolean } } };
    expect(res.statusCode).toBe(200);
    expect(body.config.asr.apiKey).toBe('');
    expect(body.config.asr.enabled).toBe(true);
  });

  it('POST config：asr 只改非密钥字段时保留已存 apiKey', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({
      currentConfig: () => ({ asr: { enabled: true, apiKey: 'sk-secret', baseUrl: 'x', model: 'm', preferQQ: true, timeoutMs: 30000 } }),
      onUpdateConfig: (config) => { updates.push(config); return true; },
    });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' },
        '{"asr":{"enabled":false,"baseUrl":"https://api.siliconflow.cn/v1","model":"FunAudioLLM/SenseVoiceSmall","preferQQ":true,"timeoutMs":30000}}'),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect((updates[0]?.asr as { apiKey?: string }).apiKey).toBe('sk-secret');
  });

  it('POST config：asr.mode 接受 chat/openai，其它值被拒', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({
      currentConfig: () => ({ asr: { enabled: true, apiKey: '', baseUrl: 'x', model: 'm', preferQQ: true, timeoutMs: 30000 } }),
      onUpdateConfig: (config) => { updates.push(config); return true; },
    });
    const head = '{"asr":{"enabled":true,"baseUrl":"https://api.siliconflow.cn/v1","model":"m","preferQQ":true,"timeoutMs":30000';

    const ok = fakeRes();
    await invoke(routes.get(BIND_CONFIG_PATH), fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' },
      `${head},"mode":"openai"}}`), ok);
    expect(ok.statusCode).toBe(200);
    expect((updates[0]?.asr as { mode?: string }).mode).toBe('openai');

    const bad = fakeRes();
    await invoke(routes.get(BIND_CONFIG_PATH), fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' },
      `${head},"mode":"whisper"}}`), bad);
    expect(bad.statusCode).toBe(400);
  });

  it('GET config：不回传 asr.fallback.apiKey', async () => {
    const { routes } = createHarness({
      currentConfig: () => ({ asr: { enabled: true, apiKey: 'sk-a', fallback: { enabled: true, apiKey: 'sk-online', baseUrl: 'https://x/v1' } } }),
    });
    const res = fakeRes();
    await invoke(routes.get(BIND_CONFIG_PATH), fakeReq('GET', { host: '127.0.0.1:3080' }), res);
    const body = json(res) as { config: { asr: { apiKey: string; fallback: { apiKey: string; baseUrl: string } } } };
    expect(body.config.asr.apiKey).toBe('');
    expect(body.config.asr.fallback).toEqual({ enabled: true, apiKey: '', baseUrl: 'https://x/v1' });
  });

  it('POST config：asr.fallback 合法值通过并保留已存的备用密钥；越界被拒', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({
      currentConfig: () => ({ asr: { apiKey: 'sk-a', fallback: { enabled: false, apiKey: 'sk-online' } } }),
      onUpdateConfig: (config) => { updates.push(config); return true; },
    });
    const post = async (fallback: Record<string, unknown>): Promise<number> => {
      const res = fakeRes();
      await invoke(
        routes.get(BIND_CONFIG_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' }, JSON.stringify({
          asr: { enabled: true, baseUrl: 'http://127.0.0.1:8080/v1', model: 'large-v3-turbo', preferQQ: true, timeoutMs: 30000, fallback },
        })),
        res,
      );
      return res.statusCode;
    };
    expect(await post({ enabled: true, baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall', timeoutMs: 20000 })).toBe(200);
    const asr = updates[0]?.asr as { apiKey: string; fallback: Record<string, unknown> };
    expect(asr.apiKey).toBe('sk-a');
    expect(asr.fallback).toEqual({
      enabled: true, baseUrl: 'https://api.siliconflow.cn/v1', apiKeyEnv: '', model: 'FunAudioLLM/SenseVoiceSmall', timeoutMs: 20000, apiKey: 'sk-online',
    });
    expect(await post({ timeoutMs: 10 })).toBe(400);
    expect(await post({ enabled: 'yes' })).toBe(400);
  });

  it('GET config：不回传 notes.semantic.apiKey', async () => {
    const { routes } = createHarness({
      currentConfig: () => ({ notes: { enabled: true, semantic: { enabled: true, apiKey: 'sk-embed', model: 'BAAI/bge-m3' } } }),
    });
    const res = fakeRes();
    await invoke(routes.get(BIND_CONFIG_PATH), fakeReq('GET', { host: '127.0.0.1:3080' }), res);
    const body = json(res) as { config: { notes: { semantic: { apiKey: string; enabled: boolean; model: string } } } };
    expect(body.config.notes.semantic).toEqual({ enabled: true, apiKey: '', model: 'BAAI/bge-m3' });
  });

  it('POST config：notes.semantic 合法值通过并保留已存 apiKey', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({
      currentConfig: () => ({ notes: { semantic: { enabled: false, apiKey: 'sk-embed' } } }),
      onUpdateConfig: (config) => { updates.push(config); return true; },
    });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' }, JSON.stringify({
        notes: {
          enabled: true, root: '', autoInject: true, injectTopK: 2, injectMaxChars: 600, injectMinCoverage: 0.4,
          semantic: { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'bge-m3', minSimilarity: 0.55, minMargin: 0.12, timeoutMs: 2000 },
        },
      })),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect((updates[0]?.notes as { semantic: unknown }).semantic).toEqual({
      enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'bge-m3', minSimilarity: 0.55, minMargin: 0.12, timeoutMs: 2000, apiKey: 'sk-embed',
    });
  });

  it('POST config：notes.semantic 越界或类型错误被拒绝', async () => {
    for (const semantic of [{ minSimilarity: 1.5 }, { minMargin: -0.1 }, { timeoutMs: 100 }, { enabled: 'yes' }]) {
      const { routes } = createHarness({ onUpdateConfig: () => true });
      const res = fakeRes();
      await invoke(
        routes.get(BIND_CONFIG_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' }, JSON.stringify({ notes: { semantic } })),
        res,
      );
      expect(res.statusCode, JSON.stringify(semantic)).toBe(400);
    }
  });

  it('POST config：notes.judge 合法值通过', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (config) => { updates.push(config); return true; } });
    const res = fakeRes();
    const judge = { enabled: true, timeoutMs: 8000, sampleRate: 0.5, minSamples: 5, muteBelow: 0.3 };
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' }, JSON.stringify({ notes: { judge } })),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect((updates[0]?.notes as { judge: unknown }).judge).toEqual(judge);
  });

  it('POST config：notes.judge 越界或类型错误被拒绝', async () => {
    for (const judge of [{ sampleRate: 1.5 }, { muteBelow: -0.1 }, { muteBelow: 2 }, { minSamples: 0 }, { timeoutMs: 100 }, { enabled: 'yes' }]) {
      const { routes } = createHarness({ onUpdateConfig: () => true });
      const res = fakeRes();
      await invoke(
        routes.get(BIND_CONFIG_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' }, JSON.stringify({ notes: { judge } })),
        res,
      );
      expect(res.statusCode, JSON.stringify(judge)).toBe(400);
    }
  });

  it('POST config：cleanup 只改 dryRun 时保留自定义规则', async () => {
    const rules = [{ name: 'x', dir: 'C:/x', unit: 'file', ttlHours: 1, recursive: false, keep: [], match: [], maxTotalMB: 0 }];
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({
      currentConfig: () => ({ cleanup: { dryRun: false, rules } }),
      onUpdateConfig: (config) => { updates.push(config); return true; },
    });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080' }, '{"cleanup":{"dryRun":true}}'),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect((updates[0]?.cleanup as { rules?: unknown }).rules).toEqual(rules);
  });

  it('POST config：类型错误被 Schema 拒绝', async () => {
    const { routes } = createHarness();
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080' }, '{"requireMention":"yes"}'),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(json(res)).toMatchObject({ ok: false, error: expect.stringContaining('布尔') });
  });

  it('GET config：脱敏 asr.chatApiKey、video.apiKey、imageGen.apiKey 与 speak.{elevenlabs,deepseek}.apiKey，且保留其余字段', async () => {
    const { routes } = createHarness({
      currentConfig: () => ({
        asr: { enabled: true, mode: 'chat', apiKey: 'sk-asr', chatApiKey: 'sk-chat', chatBaseUrl: 'https://custom.example/v1' },
        video: { enabled: true, apiKey: 'sk-vid', directEnabled: true, model: 'gemini-vid' },
        imageGen: { enabled: true, apiKey: 'sk-img', baseUrl: 'https://img.example/v1', model: 'gpt-image-2.6-sunburst' },
        speak: {
          enabled: true,
          voice: 'zh-CN-XiaoyiNeural',
          elevenlabs: { enabled: true, apiKey: 'xi-secret', modelId: 'eleven_v3', roleVoices: { feiyu: 'v-feiyu' } },
          deepseek: { enabled: true, apiKey: 'ds-secret', roleVoices: { feiyu: 'stella' } },
        },
      }),
    });
    const res = fakeRes();
    await invoke(routes.get(BIND_CONFIG_PATH), fakeReq('GET', { host: '127.0.0.1:3080' }), res);
    expect(res.statusCode).toBe(200);
    const body = json(res) as {
      config: {
        asr: { apiKey: string; chatApiKey: string; chatBaseUrl: string };
        video: { apiKey: string; model: string };
        imageGen: { apiKey: string; model: string };
        speak: {
          elevenlabs: { apiKey: string; modelId: string; roleVoices: Record<string, string> };
          deepseek: { apiKey: string; roleVoices: Record<string, string> };
        };
      };
    };
    expect(body.config.asr).toMatchObject({ apiKey: '', chatApiKey: '', chatBaseUrl: 'https://custom.example/v1' });
    expect(body.config.video).toMatchObject({ apiKey: '', model: 'gemini-vid' });
    expect(body.config.imageGen).toMatchObject({ apiKey: '', model: 'gpt-image-2.6-sunburst' });
    expect(body.config.speak.elevenlabs).toMatchObject({ apiKey: '', modelId: 'eleven_v3', roleVoices: { feiyu: 'v-feiyu' } });
    expect(body.config.speak.deepseek).toMatchObject({ apiKey: '', roleVoices: { feiyu: 'stella' } });
  });

  it('POST config：留空保存保留已有 chatApiKey / video.apiKey / imageGen.apiKey / speak.{elevenlabs,deepseek}.apiKey；非空允许覆盖且兼容旧请求', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({
      currentConfig: () => ({
        asr: { enabled: true, mode: 'chat', apiKey: 'sk-oai', chatApiKey: 'sk-chat-old' },
        video: { enabled: true, apiKey: 'sk-vid-old' },
        imageGen: { enabled: true, apiKey: 'sk-img-old' },
        speak: {
          enabled: true,
          voice: 'zh-CN-XiaoyiNeural',
          elevenlabs: { enabled: true, apiKey: 'xi-old', modelId: 'eleven_multilingual_v2', roleVoices: { feiyu: 'v1' } },
          deepseek: { enabled: true, apiKey: 'ds-old', roleVoices: { feiyu: 'stella' } },
        },
      }),
      onUpdateConfig: (config) => { updates.push(config); return true; },
    });

    const preserveRes = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({
        asr: { enabled: true, mode: 'chat', chatBaseUrl: 'https://g.example/v1', chatModel: 'm2', chatApiKeyEnv: 'K_ENV', chatReasoningEffort: 'omit' },
        video: { enabled: true, directEnabled: false, baseUrl: 'https://v.example/v1', model: 'v2', apiKeyEnv: 'V_ENV', reasoningEffort: 'low' },
        imageGen: { enabled: true, baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2.6-sunburst', standardModel: 'gpt-image-2.6-flare', defaultQuality: 'xhigh', defaultComplexity: 'high', allowAllGroups: false, allowedGroups: ['G1'] },
        speak: {
          enabled: true,
          voice: 'zh-CN-XiaoyiNeural',
          elevenlabs: { enabled: true, modelId: 'eleven_v3', roleVoices: { feiyu: 'v1', dragon: 'v2' } },
          deepseek: { enabled: true, roleVoices: { feiyu: 'stella', dragon: 'tide' } },
        },
      })),
      preserveRes,
    );
    expect(preserveRes.statusCode).toBe(200);
    expect(updates[0]).toMatchObject({
      asr: { apiKey: 'sk-oai', chatApiKey: 'sk-chat-old', chatBaseUrl: 'https://g.example/v1', chatModel: 'm2', chatReasoningEffort: 'omit' },
      video: { apiKey: 'sk-vid-old', directEnabled: false, baseUrl: 'https://v.example/v1', model: 'v2' },
      imageGen: { apiKey: 'sk-img-old', standardModel: 'gpt-image-2.6-flare', defaultQuality: 'xhigh', defaultComplexity: 'high', allowedGroups: ['G1'] },
      speak: {
        elevenlabs: { apiKey: 'xi-old', modelId: 'eleven_v3', roleVoices: { feiyu: 'v1', dragon: 'v2' } },
        deepseek: { apiKey: 'ds-old', roleVoices: { feiyu: 'stella', dragon: 'tide' } },
      },
    });

    const legacySpeakRes = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({
        speak: { enabled: true, voice: 'zh-CN-XiaoxiaoNeural', rate: '+5%', maxChars: 90, command: '' },
      })),
      legacySpeakRes,
    );
    expect(legacySpeakRes.statusCode).toBe(200);
    expect(updates[1]?.speak).toMatchObject({
      voice: 'zh-CN-XiaoxiaoNeural',
      elevenlabs: { enabled: true, apiKey: 'xi-old', modelId: 'eleven_multilingual_v2', roleVoices: { feiyu: 'v1' } },
      deepseek: { enabled: true, apiKey: 'ds-old', roleVoices: { feiyu: 'stella' } },
    });

    const rotateRes = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({
        imageGen: { enabled: true, apiKey: 'sk-img-new' },
        speak: {
          enabled: true,
          elevenlabs: { enabled: true, apiKey: 'xi-new' },
          deepseek: { enabled: true, apiKey: 'ds-new' },
        },
      })),
      rotateRes,
    );
    expect(rotateRes.statusCode).toBe(200);
    expect((updates[2]?.imageGen as { apiKey?: string }).apiKey).toBe('sk-img-new');
    expect((updates[2]?.speak as { elevenlabs?: { apiKey?: string } }).elevenlabs?.apiKey).toBe('xi-new');
    expect((updates[2]?.speak as { deepseek?: { apiKey?: string } }).deepseek?.apiKey).toBe('ds-new');
  });

  it.each([
    null,
    { enabled: 'yes' },
    { defaultQuality: 'ultra' },
    { defaultComplexity: 'extreme' },
    { timeoutMs: 1000 },
    { timeoutMs: 700000 },
    { allowedGroups: 'group1' },
  ])('POST config：imageGen 非法值被拒绝 %j', async (imageGen) => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (cfg) => { updates.push(cfg); return true; } });
    const res = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({ imageGen })),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('POST config：personas.root 合法值通过、非法类型被拒绝', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (cfg) => { updates.push(cfg); return true; } });
    const okRes = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({ personas: { root: 'C:/repo/personas' } })),
      okRes,
    );
    expect(okRes.statusCode).toBe(200);
    expect(updates[0]).toEqual({ personas: { root: 'C:/repo/personas' } });

    for (const bad of [null, [], { root: 123 }, { root: null }]) {
      const badRes = fakeRes();
      await invoke(
        routes.get(BIND_CONFIG_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({ personas: bad })),
        badRes,
      );
      expect(badRes.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(updates).toHaveLength(1);
  });

  it('POST config：groupTriggerMode 合法值通过、非法枚举或类型被拒绝', async () => {
    for (const mode of ['mention', 'probability', 'desire', 'all']) {
      const updates: Array<Record<string, unknown>> = [];
      const { routes } = createHarness({ onUpdateConfig: (cfg) => { updates.push(cfg); return true; } });
      const res = fakeRes();
      await invoke(
        routes.get(BIND_CONFIG_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({ groupTriggerMode: mode })),
        res,
      );
      expect(res.statusCode, mode).toBe(200);
      expect(updates[0]).toEqual({ groupTriggerMode: mode });
    }
    for (const bad of ['random', true, 123, null]) {
      const updates: Array<Record<string, unknown>> = [];
      const { routes } = createHarness({ onUpdateConfig: (cfg) => { updates.push(cfg); return true; } });
      const res = fakeRes();
      await invoke(
        routes.get(BIND_CONFIG_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({ groupTriggerMode: bad })),
        res,
      );
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(updates).toHaveLength(0);
    }
  });

  it('POST config：speak 放宽后的 maxChars 与在线超时通过校验，越界 maxChars 被拒', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (config) => { updates.push(config); return true; } });
    const okRes = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' }, JSON.stringify({
        speak: {
          enabled: true,
          voice: 'zh-CN-XiaoyiNeural',
          rate: '+8%',
          maxChars: 1500,
          command: '',
          elevenlabs: { enabled: true, timeoutMs: 300000 },
          deepseek: { enabled: true, timeoutMs: 300000 },
        },
      })),
      okRes,
    );
    expect(okRes.statusCode).toBe(200);
    expect(updates[0]).toMatchObject({
      speak: {
        maxChars: 1500,
        elevenlabs: { timeoutMs: 300000 },
        deepseek: { timeoutMs: 300000 },
      },
    });

    for (const badMaxChars of [5, 6000]) {
      const badRes = fakeRes();
      await invoke(
        routes.get(BIND_CONFIG_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' }, JSON.stringify({
          speak: { enabled: true, voice: 'zh-CN-XiaoyiNeural', rate: '+8%', maxChars: badMaxChars, command: '' },
        })),
        badRes,
      );
      expect(badRes.statusCode, String(badMaxChars)).toBe(400);
    }
    expect(updates).toHaveLength(1);
  });

  it('POST config：bili / sing / reverseImage 扩展工具开关校验合法与非法入参', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { routes } = createHarness({ onUpdateConfig: (cfg) => { updates.push(cfg); return true; } });
    const okRes = fakeRes();
    await invoke(
      routes.get(BIND_CONFIG_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' }, JSON.stringify({
        bili: { enabled: true },
        sing: { enabled: true, baseUrl: 'http://127.0.0.1:8766' },
        reverseImage: { enabled: true },
      })),
      okRes,
    );
    expect(okRes.statusCode).toBe(200);
    expect(updates[0]).toEqual({
      bili: { enabled: true },
      sing: { enabled: true, baseUrl: 'http://127.0.0.1:8766' },
      reverseImage: { enabled: true },
    });

    for (const badPayload of [
      { bili: { enabled: 'yes' } },
      { sing: { enabled: true, baseUrl: 123 } },
      { reverseImage: { enabled: 'no' } },
    ]) {
      const badRes = fakeRes();
      await invoke(
        routes.get(BIND_CONFIG_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json' }, JSON.stringify(badPayload)),
        badRes,
      );
      expect(badRes.statusCode, JSON.stringify(badPayload)).toBe(400);
    }
    expect(updates).toHaveLength(1);
  });

  it('跨站 Origin：403（state 与 manual 均拦截）', async () => {
    const { routes } = createHarness();
    const res1 = fakeRes();
    await invoke(
      routes.get(BIND_STATE_PATH),
      fakeReq('GET', { host: '127.0.0.1:3080', origin: 'https://evil.example.com' }),
      res1,
    );
    expect(res1.statusCode).toBe(403);

    const res2 = fakeRes();
    await invoke(
      routes.get(BIND_MANUAL_PATH),
      fakeReq('POST', { host: '127.0.0.1:3080', origin: 'https://evil.example.com' }, '{"appId":"a","appSecret":"b"}'),
      res2,
    );
    expect(res2.statusCode).toBe(403);
  });

  it('同源 Origin / 无 Origin（Desktop IPC 桥）：放行', async () => {
    const { routes } = createHarness();
    const resSame = fakeRes();
    await invoke(
      routes.get(BIND_STATE_PATH),
      fakeReq('GET', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }),
      resSame,
    );
    expect(resSame.statusCode).toBe(200);

    const resNone = fakeRes();
    await invoke(routes.get(BIND_STATE_PATH), fakeReq('GET', { host: '127.0.0.1:3080' }), resNone);
    expect(resNone.statusCode).toBe(200);
  });

  it('GET /personas：汇总目录人设、合并 group/direct 变体、忽略 _ 前缀并防跨站', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'im-qqbot-personas-list-'));
    try {
      writeFileSync(join(dir, 'default.group.md'), '---\nname: 默认群聊\n---\n\n群默认内容\n');
      writeFileSync(join(dir, 'default.direct.md'), '---\nname: 默认私聊\n---\n\n私聊默认内容\n');
      writeFileSync(join(dir, 'cat-dm.md'), '---\nname: 毒舌猫猫\n---\n\n通用猫猫正文\n');
      writeFileSync(join(dir, '_shared.md'), '忽略共享片段');
      const { routes } = createHarness({ resolvePersonasDir: () => dir });

      const forbidden = fakeRes();
      await invoke(routes.get(BIND_PERSONAS_PATH), fakeReq('GET', { host: '127.0.0.1:3080', origin: 'https://evil.example.com' }), forbidden);
      expect(forbidden.statusCode).toBe(403);

      const res = fakeRes();
      await invoke(routes.get(BIND_PERSONAS_PATH), fakeReq('GET', { host: '127.0.0.1:3080' }), res);
      expect(res.statusCode).toBe(200);
      expect(json(res)).toEqual({
        dir,
        isBundledDir: false,
        personas: [
          {
            id: 'default',
            name: '默认群聊',
            scopes: ['group', 'direct'],
            files: ['default.direct.md', 'default.group.md'],
          },
          {
            id: 'cat-dm',
            name: '毒舌猫猫',
            scopes: ['both'],
            files: ['cat-dm.md'],
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /personas：创建 .md / .group.md / .direct.md，防路径穿越/保留字/重名与跨站', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'im-qqbot-personas-create-'));
    try {
      const { routes } = createHarness({ resolvePersonasDir: () => dir });

      // 1. 创建通用人设（未填 prompt 自动生成模板）
      const resBoth = fakeRes();
      await invoke(
        routes.get(BIND_PERSONAS_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({ id: 'cat-dm', name: '毒舌猫猫' })),
        resBoth,
      );
      expect(resBoth.statusCode).toBe(201);
      expect(json(resBoth)).toMatchObject({ ok: true, id: 'cat-dm', fileName: 'cat-dm.md', dir });
      const parsedBoth = parsePersona('cat-dm', readFileSync(join(dir, 'cat-dm.md'), 'utf8'));
      expect(parsedBoth.name).toBe('毒舌猫猫');
      expect(parsedBoth.prompt).toContain('毒舌猫猫');

      // 2. 创建 group / direct 变体
      const resGroup = fakeRes();
      await invoke(
        routes.get(BIND_PERSONAS_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({ id: 'knight', scope: 'group', prompt: '严格骑士法则' })),
        resGroup,
      );
      expect(resGroup.statusCode).toBe(201);
      expect(parsePersona('knight', readFileSync(join(dir, 'knight.group.md'), 'utf8'))).toMatchObject({
        id: 'knight',
        name: 'knight',
        prompt: '严格骑士法则',
      });

      const resDirect = fakeRes();
      await invoke(
        routes.get(BIND_PERSONAS_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({ id: 'knight', name: '骑士私聊', scope: 'direct', prompt: '温柔回复' })),
        resDirect,
      );
      expect(resDirect.statusCode).toBe(201);
      expect(parsePersona('knight', readFileSync(join(dir, 'knight.direct.md'), 'utf8'))).toMatchObject({
        id: 'knight',
        name: '骑士私聊',
        prompt: '温柔回复',
      });

      // 3. 重复同名同作用域 -> 409
      const dupRes = fakeRes();
      await invoke(
        routes.get(BIND_PERSONAS_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({ id: 'cat-dm' })),
        dupRes,
      );
      expect(dupRes.statusCode).toBe(409);

      // 4. 非法 ID / 路径穿越 / 保留字 default / 非法 scope -> 400
      for (const badPayload of [
        { id: '../escape' },
        { id: 'foo/bar' },
        { id: 'default' },
        { id: 'cat-dm', scope: 'invalid' },
        { id: 'cat-dm', name: 123 },
      ]) {
        const badRes = fakeRes();
        await invoke(
          routes.get(BIND_PERSONAS_PATH),
          fakeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify(badPayload)),
          badRes,
        );
        expect(badRes.statusCode, JSON.stringify(badPayload)).toBe(400);
      }

      // 5. 跨站 Origin -> 403
      const evilRes = fakeRes();
      await invoke(
        routes.get(BIND_PERSONAS_PATH),
        fakeReq('POST', { host: '127.0.0.1:3080', origin: 'https://evil.example.com' }, JSON.stringify({ id: 'other' })),
        evilRes,
      );
      expect(evilRes.statusCode).toBe(403);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /personas/open：打开服务端推导的生效人设目录并防 GET 与跨站', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'im-qqbot-personas-open-'));
    try {
      const openDirectory = vi.fn(async () => ({ ok: true }));
      const { routes } = createHarness({
        resolvePersonasDir: () => dir,
        openDirectory,
      });

      const forbidden = fakeRes();
      await invoke(routes.get(BIND_PERSONAS_OPEN_PATH), fakeReq('POST', { host: '127.0.0.1:3080', origin: 'https://evil.example.com' }), forbidden);
      expect(forbidden.statusCode).toBe(403);

      const badMethod = fakeRes();
      await invoke(routes.get(BIND_PERSONAS_OPEN_PATH), fakeReq('GET', { host: '127.0.0.1:3080' }), badMethod);
      expect(badMethod.statusCode).toBe(405);

      const res = fakeRes();
      await invoke(routes.get(BIND_PERSONAS_OPEN_PATH), fakeReq('POST', { host: '127.0.0.1:3080' }), res);
      expect(res.statusCode).toBe(200);
      expect(openDirectory).toHaveBeenCalledTimes(1);
      expect(openDirectory).toHaveBeenCalledWith(dir);
      expect(json(res)).toMatchObject({ ok: true, dir });

      openDirectory.mockResolvedValueOnce({ ok: false, error: 'explorer failed' });
      const failRes = fakeRes();
      await invoke(routes.get(BIND_PERSONAS_OPEN_PATH), fakeReq('POST', { host: '127.0.0.1:3080' }), failRes);
      expect(failRes.statusCode).toBe(500);
      expect(json(failRes)).toEqual({ ok: false, error: 'explorer failed' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('openDirectoryInOs：win32 优先走 PowerShell Start-Process，失败降级 explorer.exe（含逗号/等号走安全 URI），全失败返回 error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'im-qqbot-open-dir-'));
    try {
      // 1. win32 主路径成功（PowerShell Start-Process）
      const psOkExecFile = vi.fn(
        (
          _cmd: string,
          _args: readonly string[],
          _opts: Record<string, unknown>,
          cb: (err: (Error & { code?: number | string; killed?: boolean }) | null, stdout?: string, stderr?: string) => void,
        ) => {
          cb(null, '', '');
        },
      );
      const logger1 = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
      const resPrimary = await openDirectoryInOs(dir, logger1, { platform: 'win32', execFileFn: psOkExecFile as never });
      expect(resPrimary).toEqual({ ok: true });
      expect(psOkExecFile).toHaveBeenCalledTimes(1);
      const [psCmd, psArgs, psOpts] = psOkExecFile.mock.calls[0]!;
      expect(psCmd).toMatch(/powershell\.exe$/i);
      expect(psArgs).toContain('-NoProfile');
      expect(psArgs).toContain('-NonInteractive');
      expect(psArgs.join(' ')).toContain('Start-Process -FilePath $env:IMQQBOT_OPEN_DIR -WindowStyle Normal');
      expect(psOpts.windowsHide).toBe(true);
      expect((psOpts.env as Record<string, string | undefined>).IMQQBOT_OPEN_DIR).toBe(dir);
      expect(logger1.info).toHaveBeenCalledTimes(1);
      expect(logger1.warn).not.toHaveBeenCalled();

      // 2. win32 主路径失败时降级 explorer.exe（容忍 exit code 1；含逗号/等号走 file:/// 转义）
      const specialDir = join(dir, '测试,a=b');
      const fallbackExecFile = vi.fn(
        (
          cmd: string,
          _args: readonly string[],
          _opts: Record<string, unknown>,
          cb: (err: (Error & { code?: number | string; killed?: boolean }) | null, stdout?: string, stderr?: string) => void,
        ) => {
          if (/powershell\.exe$/i.test(cmd)) {
            cb(Object.assign(new Error('ps failed'), { code: 1, killed: false }), '', 'Start-Process failed');
            return;
          }
          cb(Object.assign(new Error('Command failed'), { code: 1, killed: false }), '', '');
        },
      );
      const logger2 = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
      const resFallbackSpecial = await openDirectoryInOs(specialDir, logger2, {
        platform: 'win32',
        execFileFn: fallbackExecFile as never,
      });
      expect(resFallbackSpecial).toEqual({ ok: true });
      expect(fallbackExecFile).toHaveBeenCalledTimes(2);
      const [expCmd, expArgs, expOpts] = fallbackExecFile.mock.calls[1]!;
      expect(expCmd).toBe('explorer.exe');
      expect(expArgs[0]).toMatch(/^file:\/\/\//);
      expect(expArgs[0]).toContain('测试');
      expect(expArgs[0]).toContain('%2C');
      expect(expArgs[0]).toContain('%3D');
      expect(expOpts.windowsHide).toBe(false);
      expect(expOpts.detached).toBeUndefined();
      expect(logger2.warn).toHaveBeenCalledTimes(1);
      expect(logger2.info).toHaveBeenCalledTimes(1);

      const resFallbackNormal = await openDirectoryInOs(dir, logger2, {
        platform: 'win32',
        execFileFn: fallbackExecFile as never,
      });
      expect(resFallbackNormal).toEqual({ ok: true });
      expect(fallbackExecFile.mock.calls[3]![1][0]).toBe(dir);

      // 3. 两条路径均失败返回 error 并记录告警
      const bothFailExecFile = vi.fn(
        (
          cmd: string,
          _args: readonly string[],
          _opts: Record<string, unknown>,
          cb: (err: (Error & { code?: number | string; killed?: boolean }) | null, stdout?: string, stderr?: string) => void,
        ) => {
          if (/powershell\.exe$/i.test(cmd)) {
            cb(Object.assign(new Error('ps error'), { code: 1, killed: false }), '', 'ps blocked');
            return;
          }
          cb(Object.assign(new Error('Command failed'), { code: 2, killed: false }), '', 'access denied');
        },
      );
      const logger3 = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
      const resFail = await openDirectoryInOs(dir, logger3, { platform: 'win32', execFileFn: bothFailExecFile as never });
      expect(resFail.ok).toBe(false);
      expect(resFail.error).toContain('ps blocked');
      expect(resFail.error).toContain('access denied');
      expect(logger3.warn).toHaveBeenCalledTimes(2);

      const samplePath = process.platform === 'win32'
        ? 'C:\\Users\\测试,a=b\\personas'
        : '/tmp/测试,a=b/personas';
      const target = formatWindowsExplorerTarget(samplePath);
      expect(target).toContain('测试');
      expect(target).toContain('%2C');
      expect(target).toContain('%3D');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
