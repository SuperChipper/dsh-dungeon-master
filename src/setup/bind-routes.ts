/**
 * 端内绑定页路由 — /qqbot/im-qqbot/bind
 *
 * 注册在 dsh-host-webserver（ctx.webServer）的具名路由：
 * - Web 模式：页面同源直接访问
 * - Desktop：渲染进程的 fetch 经 IPC 桥自动附加 Host 认证转发
 *
 * 响应只含 task 级短时效数据（二维码 URL/SVG）与脱敏的 appId；
 * appSecret 绝不出现在任何响应中。manual 提交走与扫码一致的
 * persist 路径（写入 profile patch → HMR 重载生效）。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import type { Logger } from '../types.ts';
import type { BindingService } from './binding-service.ts';
import {
  persistCredentialsToProfile,
  removeCredentialsFromProfile,
  updateProfileConfig,
  type SetupCredentials,
} from './persist.ts';
import { getProfileDir, PLUGIN_ROOT, writeTextAtomic } from '../shared/index.ts';
import { parsePersona, PERSONA_FILE_RE, resolvePersonasDir } from '../features/persona-store.ts';
import {
  AccessControlSchema,
  AsrSchema,
  BiliSchema,
  CleanupSchema,
  DndSchema,
  FanartSchema,
  FileAccessSchema,
  GroupTriggerModeSchema,
  IMAGE_GEN_COMPLEXITIES,
  IMAGE_GEN_QUALITIES,
  ImageGenSchema,
  MediaSchema,
  ModelFailoverSchema,
  NotesSchema,
  PersonasSchema,
  ReplyDesireSchema,
  ReverseImageSchema,
  SendFileSchema,
  SingSchema,
  SpeakSchema,
  StickersSchema,
  ToolAccessSchema,
  VideoSchema,
  VisionSchema,
} from '../config.ts';
import {
  BIND_CONFIG_PATH,
  BIND_MANUAL_PATH,
  BIND_PERSONAS_OPEN_PATH,
  BIND_PERSONAS_PATH,
  BIND_REFRESH_PATH,
  BIND_STATE_PATH,
  BIND_UNBIND_PATH,
  type BindStateWire,
  type PersonaScopeKind,
  type PersonaSummaryWire,
} from '../shared/bind-protocol.ts';

// 协议单一来源：shared/bind-protocol.ts（类型 + 路径常量，客户端共用）
export {
  BIND_CONFIG_PATH,
  BIND_MANUAL_PATH,
  BIND_PERSONAS_OPEN_PATH,
  BIND_PERSONAS_PATH,
  BIND_REFRESH_PATH,
  BIND_STATE_PATH,
  BIND_UNBIND_PATH,
};
export type { BindStateWire, PersonaScopeKind, PersonaSummaryWire };

/** dsh-host-webserver 的具名路由注册形状（局部投影，避免硬依赖） */
export interface WebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** ctx.webServer 的局部投影（服务可用性由调用方探测） */
export interface WebServerLike {
  register(route: WebRoute): () => void;
}

/** 手动凭据提交的处理结果 */
export interface ManualSubmitResult {
  /** 是否已持久化（false = 落盘失败，需展示手动配置指引） */
  persisted: boolean;
  /** 失败原因（persisted=false 时回传给表单展示） */
  error?: string;
}

/** 解绑处理结果 */
export interface UnbindResult {
  persisted: boolean;
  error?: string;
}

/** 路由行为注入 */
export interface BindRoutesOptions {
  /**
   * 已绑定态：返回脱敏的 appId（可回显，非机密），null 表示未绑定。
   * 已绑定 fiber 注册路由时提供；待绑定流程不提供。
   */
  boundAppId?: () => string | null;
  /**
   * 手动凭据提交处理（默认：persist 到 profile patch）。
   * 待绑定流程会注入「先终止扫码轮询」的包装。
   */
  onManualCredentials?: (credentials: SetupCredentials) => ManualSubmitResult;
  /**
   * 解绑处理（默认：移除 profile patch 中的凭据字段）。
   * 未绑定态调用返回 409，不触达本回调。
   */
  onUnbind?: () => UnbindResult;
  /**
   * 当前生效配置（apply 时 loader 合并后的值，含默认值填充），
   * 用于 GET 回显（appSecret 剔除后返回）。
   */
  currentConfig?: () => Record<string, unknown>;
  /**
   * 所属 profile 目录（优先于 getProfileDir 的路径探测）。
   * 链接安装时插件真实路径不在 node_modules 下，路径探测会落空；
   * 调用方通常传入由 ctx.baseUrl 推导的值。
   */
  profileDir?: string | null;
  /**
   * 配置写入处理（默认：最小合并写入 profile patch）。
   */
  onUpdateConfig?: (config: Record<string, unknown>) => boolean;
  /**
   * 解析当前生效的人设目录（默认按 currentConfig.personas.root / cwd / PLUGIN_ROOT 推导）。
   */
  resolvePersonasDir?: (currentConfig: Record<string, unknown>) => string;
  /**
   * 在宿主系统文件管理器打开指定目录（测试可注入替身，避免真实拉起系统窗口）。
   */
  openDirectory?: (
    dir: string,
  ) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
}

/** 可经 UI 编辑的配置键（白名单：只收用户必要的字段，其余走 patch/env） */
const EDITABLE_CONFIG_KEYS = new Set([
  'groupTriggerMode', 'requireMention', 'streaming', 'showToolResults', 'debug',
  'provider', 'model', 'preset',
  'groupPrompt', 'directPrompt',
  'groupReplyProbability', 'replyDesire', 'historyLimit', 'sessionIdleTimeout', 'ownerOpenid',
  'adminOpenids', 'autoCompactTokens', 'autoCompactPrivateRatio', 'autoCompactDeferOnTools',
  'idleCompactMinutes', 'idleCompactTokens', 'idleCompactProviders', 'textChunkLimit', 'maxQueue',
  'steerWindowMs', 'processingTimeoutMs', 'askTimeoutMs',
  'tmpDir', 'tmpTtlHours', 'tmpMaxTotalMB',
  'access', 'fileAccess', 'stickers', 'personas', 'notes', 'toolAccess', 'modelFailover',
  'media', 'vision', 'asr', 'video', 'imageGen', 'sendFile', 'speak', 'cleanup', 'bili', 'sing', 'reverseImage', 'fanart', 'dnd',
]);

/** 白名单键的子 Schema（服务端校验：客户端校验仅为体验，安全边界在宿主） */
const EDITABLE_CONFIG_SCHEMAS: Record<string, (value: unknown) => unknown> = {
  groupTriggerMode: (v) => {
    if (typeof v !== 'string') throw new TypeError('groupTriggerMode 必须是字符串');
    return GroupTriggerModeSchema(v as never);
  },
  requireMention: (v) => booleanSchema(v, 'requireMention'),
  streaming: (v) => booleanSchema(v, 'streaming'),
  showToolResults: (v) => booleanSchema(v, 'showToolResults'),
  debug: (v) => booleanSchema(v, 'debug'),
  provider: stringSchema('provider'),
  model: stringSchema('model'),
  preset: stringSchema('preset'),
  groupPrompt: stringSchema('groupPrompt'),
  directPrompt: stringSchema('directPrompt'),
  groupReplyProbability: (v) => numberSchema(v, 'groupReplyProbability', 0, 1),
  historyLimit: (v) => integerSchema(v, 'historyLimit', 0, 200),
  autoCompactTokens: (v) => integerSchema(v, 'autoCompactTokens', 0, 1_000_000),
  autoCompactPrivateRatio: (v) => numberSchema(v, 'autoCompactPrivateRatio', 0, 0.9),
  autoCompactDeferOnTools: (v) => booleanSchema(v, 'autoCompactDeferOnTools'),
  idleCompactMinutes: (v) => numberSchema(v, 'idleCompactMinutes', 0, 1440),
  idleCompactTokens: (v) => integerSchema(v, 'idleCompactTokens', 0, 1_000_000),
  idleCompactProviders: stringSchema('idleCompactProviders'),
  textChunkLimit: (v) => integerSchema(v, 'textChunkLimit', 200, 5000),
  maxQueue: (v) => integerSchema(v, 'maxQueue', 1, 100),
  steerWindowMs: (v) => integerSchema(v, 'steerWindowMs', 0, 300_000),
  processingTimeoutMs: (v) => integerSchema(v, 'processingTimeoutMs', 10_000, 6 * 60 * 60 * 1000),
  askTimeoutMs: (v) => integerSchema(v, 'askTimeoutMs', 10_000, 6 * 60 * 60 * 1000),
  sessionIdleTimeout: (v) => integerSchema(v, 'sessionIdleTimeout', 60_000, 30 * 24 * 60 * 60 * 1000),
  tmpDir: stringSchema('tmpDir'),
  tmpTtlHours: (v) => integerSchema(v, 'tmpTtlHours', 0, 24 * 365),
  tmpMaxTotalMB: (v) => integerSchema(v, 'tmpMaxTotalMB', 0, 1_000_000),
  ownerOpenid: stringSchema('ownerOpenid'),
  adminOpenids: (v) => stringArraySchema(v, 'adminOpenids'),
  access: (v) => AccessControlSchema(v as never),
  fileAccess: (v) => FileAccessSchema(v as never),
  stickers: (v) => StickersSchema(v as never),
  personas: (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError('personas 必须是对象');
    const obj = v as Record<string, unknown>;
    if ('root' in obj && typeof obj.root !== 'string') throw new TypeError('personas.root 必须是字符串');
    return PersonasSchema(v as never);
  },
  notes: (v) => NotesSchema(v as never),
  toolAccess: (v) => ToolAccessSchema(v as never),
  modelFailover: (v) => ModelFailoverSchema(v as never),
  media: (v) => MediaSchema(v as never),
  vision: (v) => VisionSchema(v as never),
  asr: (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError('asr 必须是对象');
    return AsrSchema(v as never);
  },
  video: (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError('video 必须是对象');
    return VideoSchema(v as never);
  },
  imageGen: (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError('imageGen 必须是对象');
    const obj = v as Record<string, unknown>;
    if ('defaultQuality' in obj && !IMAGE_GEN_QUALITIES.includes(obj.defaultQuality as never)) {
      throw new TypeError(`imageGen.defaultQuality 必须是 ${IMAGE_GEN_QUALITIES.join('/')}`);
    }
    if ('defaultComplexity' in obj && !IMAGE_GEN_COMPLEXITIES.includes(obj.defaultComplexity as never)) {
      throw new TypeError('imageGen.defaultComplexity 必须是空字符串或 low/medium/high');
    }
    return ImageGenSchema(v as never);
  },
  sendFile: (v) => SendFileSchema(v as never),
  speak: (v) => SpeakSchema(v as never),
  cleanup: (v) => CleanupSchema(v as never),
  bili: (v) => BiliSchema(v as never),
  sing: (v) => SingSchema(v as never),
  reverseImage: (v) => ReverseImageSchema(v as never),
  fanart: (v) => FanartSchema(v as never),
  // combatAgent 与跑团共用顶层键，仍由唯一真源校验模型路由和交接字数。
  dnd: (v) => DndSchema(v as never),
  replyDesire: (v) => ReplyDesireSchema(v as never),
};

function booleanSchema(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} 必须是布尔值`);
  return value;
}

function stringSchema(name: string): (value: unknown) => unknown {
  return (value) => {
    if (typeof value !== 'string') throw new TypeError(`${name} 必须是字符串`);
    if (value.length > 20000) throw new TypeError(`${name} 过长`);
    return value;
  };
}

function stringArraySchema(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${name} 必须是字符串数组`);
  }
  return (value as string[]).map((item) => item.trim()).filter(Boolean);
}

function numberSchema(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} 必须是数字`);
  if (value < min || value > max) throw new TypeError(`${name} 必须在 ${min} 到 ${max} 之间`);
  return value;
}

function integerSchema(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeError(`${name} 必须是整数`);
  if (value < min || value > max) throw new TypeError(`${name} 必须在 ${min} 到 ${max} 之间`);
  return value;
}

/** 手动凭据 / 配置面板请求体上限（配置含两条完整 system prompt，4KB 不够） */
const MAX_MANUAL_BODY_BYTES = 256 * 1024;

/**
 * 注册绑定路由（状态查询 / 刷新二维码 / 手动凭据）。
 *
 * @param webServer - ctx.webServer
 * @param service - 绑定状态机；已绑定 fiber 传 null（无扫码流程）
 * @param logger - 日志
 * @param options - 行为注入（bound 态回显、manual 处理）
 * @returns 注销函数（与插件 fiber 生命周期绑定）
 */
export function registerBindRoutes(
  webServer: WebServerLike,
  service: BindingService | null,
  logger: Logger,
  options: BindRoutesOptions = {},
): () => void {
  const defaultManual = (credentials: SetupCredentials): ManualSubmitResult => {
    const persisted = persistCredentialsToProfile(credentials, options.profileDir ?? getProfileDir() ?? undefined, logger);
    return persisted ? { persisted: true } : { persisted: false, error: '无法定位 profile 目录或写入失败，请改用环境变量配置' };
  };
  const handleManualSubmit = options.onManualCredentials ?? defaultManual;

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: BIND_STATE_PATH,
      handler: (req, res) => { handleState(req, res, service, options); },
    }),
    webServer.register({
      kind: 'exact',
      path: BIND_REFRESH_PATH,
      handler: (req, res) => { handleRefresh(req, res, service); },
    }),
    webServer.register({
      kind: 'exact',
      path: BIND_MANUAL_PATH,
      handler: (req, res) => handleManual(req, res, handleManualSubmit),
    }),
    webServer.register({
      kind: 'exact',
      path: BIND_UNBIND_PATH,
      handler: (req, res) => handleUnbind(req, res, options),
    }),
    webServer.register({
      kind: 'exact',
      path: BIND_CONFIG_PATH,
      handler: (req, res) => handleConfig(req, res, options),
    }),
    webServer.register({
      kind: 'exact',
      path: BIND_PERSONAS_PATH,
      handler: (req, res) => handlePersonas(req, res, options),
    }),
    webServer.register({
      kind: 'exact',
      path: BIND_PERSONAS_OPEN_PATH,
      handler: (req, res) => handlePersonasOpen(req, res, options, logger),
    }),
  ];
  logger.info(`im-qqbot: 端内绑定页已就绪: ${BIND_STATE_PATH}`);
  return () => { for (const dispose of disposers) dispose(); };
}

/**
 * 请求来源校验（最小 CSRF 防护）。
 *
 * 带 Origin 的请求必须与 Host 同源；同源 fetch 与 Desktop IPC 桥
 * （后者会删除 origin 头）均放行。本路由数据不敏感且动作无害，
 * 该级别的防护足够。
 */
function trusted(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function handleState(
  req: IncomingMessage,
  res: ServerResponse,
  service: BindingService | null,
  options: BindRoutesOptions,
): void {
  if (!trusted(req)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  // 已绑定优先（appSecret 不回传，appId 非机密可回显）
  const boundAppId = options.boundAppId?.() ?? null;
  if (boundAppId !== null) {
    sendJson(res, 200, { phase: 'bound', appId: boundAppId });
    return;
  }
  sendJson(res, 200, service === null ? { phase: 'starting' } : service.wireState());
}

function handleRefresh(req: IncomingMessage, res: ServerResponse, service: BindingService | null): void {
  if (!trusted(req)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  // 丢弃可能的请求体（refresh 无参数）
  req.resume();
  service?.refresh();
  // 新二维码异步生成，统一由状态轮询收敛
  sendJson(res, 200, { phase: 'starting' });
}

/** 读取并解析 JSON 请求体（带大小上限） */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_MANUAL_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (size === 0) throw new Error('empty request body');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 校验手动提交的凭据形态（不打印内容） */
function parseCredentials(body: unknown): SetupCredentials | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const appId = typeof record.appId === 'string' ? record.appId.trim() : '';
  const appSecret = typeof record.appSecret === 'string' ? record.appSecret.trim() : '';
  if (appId.length === 0 || appSecret.length === 0) return null;
  if (appId.length > 128 || appSecret.length > 256) return null;
  return { appId, appSecret };
}

async function handleManual(
  req: IncomingMessage,
  res: ServerResponse,
  submit: (credentials: SetupCredentials) => ManualSubmitResult,
): Promise<void> {
  if (!trusted(req)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  const credentials = parseCredentials(body);
  if (credentials === null) {
    sendJson(res, 400, { ok: false, error: 'appId 与 appSecret 不能为空' });
    return;
  }
  const result = submit(credentials);
  if (!result.persisted) {
    sendJson(res, 500, { ok: false, error: result.error ?? '保存失败' });
    return;
  }
  // 写入 profile patch 触发 HMR 重载，新 fiber 以新凭据启动网关
  sendJson(res, 200, { ok: true, message: '凭据已保存，插件将自动重载' });
}

/** 解绑：仅已绑定态可执行；移除 profile patch 中的凭据并触发 HMR 重载 */
function handleUnbind(req: IncomingMessage, res: ServerResponse, options: BindRoutesOptions): void {
  if (!trusted(req)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  req.resume();
  if ((options.boundAppId?.() ?? null) === null) {
    sendJson(res, 409, { ok: false, error: '当前未绑定' });
    return;
  }
  const result: UnbindResult = options.onUnbind === undefined
    ? (() => {
        const removed = removeCredentialsFromProfile(options.profileDir ?? getProfileDir() ?? undefined, undefined);
        if (removed) {
          // 清除进程内凭据：扫码绑定成功时会写入 env（供热更新后的下次
          // apply 兜底读取）；不清则 HMR 重载后新 fiber 仍从 env 读到
          // 凭据，解绑不生效（状态一直停留在 bound）
          delete process.env.QQBOT_APPID;
          delete process.env.QQBOT_SECRET;
        }
        return removed
          ? { persisted: true }
          : { persisted: false, error: '无法定位 profile 目录或写入失败，请手动编辑 cordis.patch.yml' };
      })()
    : options.onUnbind();
  if (!result.persisted) {
    sendJson(res, 500, { ok: false, error: result.error ?? '解绑失败' });
    return;
  }
  // 移除后写入触发 HMR 重载，插件回到未绑定态（绑定流程重新可用）
  sendJson(res, 200, { ok: true, message: '已解绑，插件将重载并重新进入绑定流程' });
}

/**
 * 配置读写：
 * - GET：回显当前生效配置（appSecret 剔除，cwd 等只读字段正常返回）
 * - POST：白名单 + 子 Schema 校验 → 最小写入 profile patch → HMR 重载
 */
async function handleConfig(req: IncomingMessage, res: ServerResponse, options: BindRoutesOptions): Promise<void> {
  if (!trusted(req)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (req.method === 'GET') {
    const current = options.currentConfig?.() ?? {};
    // appSecret / asr.apiKey / asr.chatApiKey / asr.fallback.apiKey / video.apiKey / imageGen.apiKey / speak.{elevenlabs,deepseek}.apiKey / notes.semantic.apiKey 永不回传；其余（含只读 cwd）原样回显
    const {
      appSecret: _s,
      asr: asrValue,
      video: videoValue,
      imageGen: imageGenValue,
      speak: speakValue,
      notes: notesValue,
      ...safe
    } = current;
    const config: Record<string, unknown> = { ...safe };
    if (asrValue !== undefined) {
      const asr = asrValue as Record<string, unknown>;
      const fallback = asr.fallback as Record<string, unknown> | undefined;
      config.asr = {
        ...asr,
        apiKey: '',
        chatApiKey: '',
        ...(fallback === undefined ? {} : { fallback: { ...fallback, apiKey: '' } }),
      };
    }
    if (videoValue !== undefined) {
      config.video = { ...(videoValue as Record<string, unknown>), apiKey: '' };
    }
    if (imageGenValue !== undefined) {
      config.imageGen = { ...(imageGenValue as Record<string, unknown>), apiKey: '' };
    }
    if (speakValue !== undefined) {
      const speak = speakValue as Record<string, unknown>;
      const elevenlabs = speak.elevenlabs as Record<string, unknown> | undefined;
      const deepseek = speak.deepseek as Record<string, unknown> | undefined;
      config.speak = {
        ...speak,
        ...(elevenlabs === undefined ? {} : { elevenlabs: { ...elevenlabs, apiKey: '' } }),
        ...(deepseek === undefined ? {} : { deepseek: { ...deepseek, apiKey: '' } }),
      };
    }
    if (notesValue !== undefined) {
      const notes = notesValue as Record<string, unknown>;
      const semantic = notes.semantic as Record<string, unknown> | undefined;
      config.notes = semantic === undefined ? notes : { ...notes, semantic: { ...semantic, apiKey: '' } };
    }
    sendJson(res, 200, { config });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
    return;
  }
  const submitted = body as Record<string, unknown>;

  // 白名单与凭据/只读字段拦截
  for (const key of Object.keys(submitted)) {
    if (!EDITABLE_CONFIG_KEYS.has(key)) {
      const reason = key === 'appId' || key === 'appSecret'
        ? '凭据请使用绑定/更换/解绑功能'
        : key === 'cwd'
          ? 'cwd 为只读字段'
          : '不支持的字段';
      sendJson(res, 400, { ok: false, error: `${reason}: ${key}` });
      return;
    }
  }

  // 逐键 Schema 校验（非法值拒绝，返回首个错误）
  let validated: Record<string, unknown> = {};
  try {
    validated = Object.fromEntries(Object.entries(submitted).map(([key, value]) => {
      const check = EDITABLE_CONFIG_SCHEMAS[key];
      if (check === undefined) throw new TypeError(`不支持的字段: ${key}`);
      return [key, check(value)];
    }));
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof TypeError ? err.message : String(err) });
    return;
  }

  // 嵌套组里没有表单控件的字段按当前生效值回填：Schema 默认值会补空，
  // 直接写回会把已保存的 ASR / 视频 / 生图密钥或自定义清理规则冲掉
  const current = options.currentConfig?.() ?? {};
  if (validated.asr !== undefined) {
    const currentAsr = (current.asr ?? {}) as Record<string, unknown>;
    const currentFallback = currentAsr.fallback as Record<string, unknown> | undefined;
    const asr = validated.asr as Record<string, unknown>;
    const fallback = asr.fallback as Record<string, unknown>;
    validated.asr = {
      ...asr,
      apiKey: (typeof asr.apiKey === 'string' && asr.apiKey !== '' ? asr.apiKey : currentAsr.apiKey) ?? '',
      chatApiKey: (typeof asr.chatApiKey === 'string' && asr.chatApiKey !== '' ? asr.chatApiKey : currentAsr.chatApiKey) ?? '',
      fallback: {
        ...fallback,
        apiKey: (typeof fallback.apiKey === 'string' && fallback.apiKey !== '' ? fallback.apiKey : currentFallback?.apiKey) ?? '',
      },
    };
  }
  if (validated.video !== undefined) {
    const currentVideo = (current.video ?? {}) as Record<string, unknown>;
    const video = validated.video as Record<string, unknown>;
    validated.video = {
      ...video,
      apiKey: (typeof video.apiKey === 'string' && video.apiKey !== '' ? video.apiKey : currentVideo.apiKey) ?? '',
    };
  }
  if (validated.imageGen !== undefined) {
    const currentImageGen = (current.imageGen ?? {}) as Record<string, unknown>;
    const imageGen = validated.imageGen as Record<string, unknown>;
    validated.imageGen = {
      ...imageGen,
      apiKey: (typeof imageGen.apiKey === 'string' && imageGen.apiKey !== '' ? imageGen.apiKey : currentImageGen.apiKey) ?? '',
    };
  }
  if (validated.speak !== undefined) {
    const submittedSpeak = submitted.speak as Record<string, unknown> | undefined;
    const currentSpeak = (current.speak ?? {}) as Record<string, unknown>;
    const nextSpeak: Record<string, unknown> = { ...(validated.speak as Record<string, unknown>) };
    for (const subKey of ['elevenlabs', 'deepseek'] as const) {
      const currentSub = currentSpeak[subKey] as Record<string, unknown> | undefined;
      if (submittedSpeak !== undefined && !(subKey in submittedSpeak) && currentSub !== undefined) {
        // 旧客户端不传 speak.{elevenlabs,deepseek} 时保留存量配置，避免 Schema 默认值把已保存的音色与密钥冲掉
        nextSpeak[subKey] = currentSub;
      } else if (nextSpeak[subKey] !== undefined && typeof nextSpeak[subKey] === 'object' && nextSpeak[subKey] !== null) {
        const sub = nextSpeak[subKey] as Record<string, unknown>;
        nextSpeak[subKey] = {
          ...sub,
          apiKey: (typeof sub.apiKey === 'string' && sub.apiKey !== '' ? sub.apiKey : currentSub?.apiKey) ?? '',
        };
      }
    }
    validated.speak = nextSpeak;
  }
  if (validated.notes !== undefined) {
    const notes = validated.notes as Record<string, unknown>;
    const currentSemantic = ((current.notes ?? {}) as Record<string, unknown>).semantic as Record<string, unknown> | undefined;
    notes.semantic = { ...(notes.semantic as Record<string, unknown>), apiKey: currentSemantic?.apiKey ?? '' };
  }
  if (validated.cleanup !== undefined) {
    const currentCleanup = (current.cleanup ?? {}) as Record<string, unknown>;
    validated.cleanup = { ...(validated.cleanup as Record<string, unknown>), rules: currentCleanup.rules ?? [] };
  }

  const persisted = options.onUpdateConfig === undefined
    ? updateProfileConfig(validated, options.profileDir ?? getProfileDir() ?? undefined, undefined)
    : options.onUpdateConfig(validated);
  if (!persisted) {
    sendJson(res, 500, { ok: false, error: '无法定位 profile 目录或写入失败' });
    return;
  }
  sendJson(res, 200, { ok: true, message: '配置已保存，插件将自动重载（进行中的机器人会话将重置）' });
}

const PERSONA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const PERSONA_SCOPE_ORDER: Record<PersonaScopeKind, number> = { both: 0, group: 1, direct: 2 };

function resolveActivePersonasDir(options: BindRoutesOptions): string {
  const current = options.currentConfig?.() ?? {};
  if (options.resolvePersonasDir !== undefined) {
    return options.resolvePersonasDir(current);
  }
  const personasCfg = current.personas as { root?: unknown } | undefined;
  return resolvePersonasDir({
    root: typeof personasCfg?.root === 'string' ? personasCfg.root : undefined,
    cwd: typeof current.cwd === 'string' ? current.cwd : undefined,
    pluginRoot: PLUGIN_ROOT,
  });
}

function listPersonasSummary(dir: string): PersonaSummaryWire[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => !file.startsWith('_')).sort();
  } catch {
    return [];
  }
  const grouped = new Map<string, { name: string; namePriority: number; scopes: Set<PersonaScopeKind>; files: string[] }>();
  for (const file of files) {
    const match = PERSONA_FILE_RE.exec(file);
    if (match === null) continue;
    const id = match[1]!;
    const rawVariant = match[2];
    const scope: PersonaScopeKind = rawVariant === 'group' || rawVariant === 'direct' ? rawVariant : 'both';
    let displayName = id;
    try {
      displayName = parsePersona(id, readFileSync(resolve(dir, file), 'utf8')).name;
    } catch {
      /* 损坏或未写完的文件仍列出 id 兜底 */
    }
    const scopePriority = displayName === id ? 99 : PERSONA_SCOPE_ORDER[scope];
    const existing = grouped.get(id);
    if (existing === undefined) {
      grouped.set(id, { name: displayName, namePriority: scopePriority, scopes: new Set([scope]), files: [file] });
    } else {
      if (scopePriority < existing.namePriority) {
        existing.name = displayName;
        existing.namePriority = scopePriority;
      }
      existing.scopes.add(scope);
      existing.files.push(file);
    }
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => {
      if (a === 'default' && b !== 'default') return -1;
      if (b === 'default' && a !== 'default') return 1;
      return a.localeCompare(b);
    })
    .map(([id, entry]) => ({
      id,
      name: entry.name,
      scopes: [...entry.scopes].sort((a, b) => PERSONA_SCOPE_ORDER[a] - PERSONA_SCOPE_ORDER[b]),
      files: entry.files.sort(),
    }));
}

/** 将本机目录转为 Windows Explorer 安全 URI（保留中文、转义 `,` 与 `=` 防止被当作选项或列表分隔符）。 */
export function formatWindowsExplorerTarget(dir: string): string {
  const href = pathToFileURL(dir).href;
  return href
    .replace(/(?:%[89A-F][0-9A-F])+/gi, (escaped) => {
      try {
        return decodeURIComponent(escaped);
      } catch {
        return escaped;
      }
    })
    .replaceAll(',', '%2C')
    .replaceAll('=', '%3D');
}

function resolveWindowsPowerShell(): string {
  const root = process.env.SystemRoot || process.env.windir;
  if (root) {
    const candidate = resolve(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'powershell.exe';
}

function runExecFile(
  execFileImpl: typeof execFile,
  command: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number; windowsHide?: boolean; env?: NodeJS.ProcessEnv },
): Promise<{ err: (Error & { code?: unknown; killed?: boolean }) | null; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFileImpl(command, args, options, (err, _stdout, stderr) => {
      resolvePromise({
        err: (err as (Error & { code?: unknown; killed?: boolean }) | null) ?? null,
        stderr: typeof stderr === 'string' ? stderr : '',
      });
    });
  });
}

function formatExecError(err: Error | null, stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed !== '') return trimmed;
  return err instanceof Error ? err.message : String(err);
}

export async function openDirectoryInOs(
  dir: string,
  logger: Logger,
  internals: { platform?: NodeJS.Platform; execFileFn?: typeof execFile } = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    mkdirSync(dir, { recursive: true });
    const platform = internals.platform ?? process.platform;
    const execFileImpl = internals.execFileFn ?? execFile;

    if (platform === 'win32') {
      // 主路径：走 PowerShell Start-Process 调用 Win32 ShellExecuteExW，兼容后台启动/第三方文件管理器并通过 env 安全传参。
      const psCommand = "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:IMQQBOT_OPEN_DIR -WindowStyle Normal";
      const psRes = await runExecFile(
        execFileImpl,
        resolveWindowsPowerShell(),
        ['-NoProfile', '-NonInteractive', '-Command', psCommand],
        {
          encoding: 'utf8',
          timeout: 8000,
          windowsHide: true,
          env: { ...process.env, IMQQBOT_OPEN_DIR: dir },
        },
      );
      if (!psRes.err) {
        logger.info(`im-qqbot: 已打开人设目录 (shell-execute): ${dir}`);
        return { ok: true };
      }
      const psDetail = formatExecError(psRes.err, psRes.stderr);
      logger.warn(`im-qqbot: PowerShell 打开人设目录失败，尝试降级 explorer.exe: ${psDetail}`);

      // Explorer 对普通 Windows 路径传原生路径即可；仅含 `,` 或 `=` 时走 file:/// 转义以防参数解析歧义。
      const target = /[,=]/.test(dir) ? formatWindowsExplorerTarget(dir) : dir;
      const expRes = await runExecFile(
        execFileImpl,
        'explorer.exe',
        [target],
        { encoding: 'utf8', timeout: 8000, windowsHide: false },
      );
      // Windows explorer.exe 把打开目录转交给已有桌面外壳进程后会以 exit code 1 退出，这属于正常打开。
      if (!expRes.err || (expRes.err.code === 1 && !expRes.err.killed)) {
        logger.info(`im-qqbot: 已打开人设目录 (explorer-fallback): ${dir}`);
        return { ok: true };
      }
      const expDetail = formatExecError(expRes.err, expRes.stderr);
      const combined = `${psDetail}; explorer fallback: ${expDetail}`;
      logger.warn(`im-qqbot: 打开人设目录失败: ${combined}`);
      return { ok: false, error: combined };
    }

    const command = platform === 'darwin' ? 'open' : 'xdg-open';
    const res = await runExecFile(
      execFileImpl,
      command,
      [dir],
      { encoding: 'utf8', timeout: 8000 },
    );
    if (!res.err) {
      logger.info(`im-qqbot: 已打开人设目录 (${command}): ${dir}`);
      return { ok: true };
    }
    const detail = formatExecError(res.err, res.stderr);
    logger.warn(`im-qqbot: 打开人设目录失败: ${detail}`);
    return { ok: false, error: detail };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`im-qqbot: 打开人设目录失败: ${detail}`);
    return { ok: false, error: detail };
  }
}

/** 人设清单读取与新建自定义人设 */
async function handlePersonas(req: IncomingMessage, res: ServerResponse, options: BindRoutesOptions): Promise<void> {
  if (!trusted(req)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const dir = resolveActivePersonasDir(options);
  if (req.method === 'GET') {
    const isBundledDir = resolve(dir) === resolve(PLUGIN_ROOT, 'personas');
    const personas = existsSync(dir) ? listPersonasSummary(dir) : [];
    sendJson(res, 200, { dir, isBundledDir, personas });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
    return;
  }
  const input = body as Record<string, unknown>;
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!PERSONA_ID_RE.test(id) || id.toLowerCase() === 'default') {
    sendJson(res, 400, {
      ok: false,
      error: '人设 ID 仅限 1~48 位字母/数字/下划线/短横线（须以字母或数字开头，且不能为 default）',
    });
    return;
  }

  if (input.name !== undefined && typeof input.name !== 'string') {
    sendJson(res, 400, { ok: false, error: '显示名称必须是字符串' });
    return;
  }
  const trimmedName = typeof input.name === 'string' ? input.name.trim() : '';
  if (trimmedName.length > 64) {
    sendJson(res, 400, { ok: false, error: '显示名称不能超过 64 个字符' });
    return;
  }
  const displayName = trimmedName !== '' ? trimmedName : id;

  const rawScope = input.scope;
  if (rawScope !== undefined && rawScope !== 'both' && rawScope !== 'group' && rawScope !== 'direct') {
    sendJson(res, 400, { ok: false, error: 'scope 仅支持 both / group / direct' });
    return;
  }
  const scope: PersonaScopeKind = rawScope ?? 'both';

  if (input.prompt !== undefined && typeof input.prompt !== 'string') {
    sendJson(res, 400, { ok: false, error: 'prompt 必须是字符串' });
    return;
  }
  const rawPrompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (rawPrompt.length > 20000) {
    sendJson(res, 400, { ok: false, error: 'prompt 不能超过 20000 个字符' });
    return;
  }
  const promptBody = rawPrompt.trim() !== ''
    ? rawPrompt.trim()
    : `你现在扮演「${displayName}」。请保持鲜明自然的对话风格，回复简洁直接。`;

  const fileName = scope === 'both' ? `${id}.md` : `${id}.${scope}.md`;
  const resolvedDir = resolve(dir);
  const filePath = resolve(resolvedDir, fileName);
  if (dirname(filePath) !== resolvedDir) {
    sendJson(res, 400, { ok: false, error: '非法人设文件名' });
    return;
  }
  if (existsSync(filePath)) {
    sendJson(res, 409, { ok: false, error: `人设文件已存在: ${fileName}` });
    return;
  }

  try {
    mkdirSync(resolvedDir, { recursive: true });
    const frontmatter = yaml.dump({ name: displayName }).trim();
    const content = `---\n${frontmatter}\n---\n\n${promptBody}\n`;
    writeTextAtomic(filePath, content);
    sendJson(res, 201, {
      ok: true,
      id,
      fileName,
      filePath,
      dir: resolvedDir,
      message: `已创建人设文件 ${fileName}，无需重启即可使用 /persona 切换`,
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: `写入人设文件失败: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/** 在宿主系统文件管理器打开当前人设目录 */
async function handlePersonasOpen(
  req: IncomingMessage,
  res: ServerResponse,
  options: BindRoutesOptions,
  logger: Logger,
): Promise<void> {
  if (!trusted(req)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  req.resume();

  const dir = resolve(resolveActivePersonasDir(options));
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: `创建人设目录失败: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const openFn = options.openDirectory ?? ((target) => openDirectoryInOs(target, logger));
  let result: { ok: boolean; error?: string };
  try {
    result = await openFn(dir);
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: `打开人设目录失败: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  if (!result.ok) {
    sendJson(res, 500, { ok: false, error: result.error ?? '无法打开人设目录' });
    return;
  }
  sendJson(res, 200, { ok: true, dir, message: `已打开人设目录: ${dir}` });
}
