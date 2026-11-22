import type { BrowserConfig, ElevenLabsOutputFormat, GroupTriggerMode, ImageGenComplexity, ImageGenQuality } from '../../config.ts';

/** 访问控制配置（与 src/config.ts 的 AccessControlConfig 对应的局部投影） */
export interface AccessControlWire {
  c2cMode: 'open' | 'allowlist' | 'disabled';
  c2cAllow: string[];
  groupMode: 'open' | 'allowlist' | 'disabled';
  groupAllow: string[];
}

export type AccessMode = AccessControlWire['c2cMode'];

/** 文件访问白名单（与 src/config.ts 的 FileAccessConfig 对应） */
export interface FileAccessWire {
  sensitivePaths: string[];
}

/** 表情收藏配置（与 src/config.ts 的 StickersConfig 对应的局部投影） */
export interface StickersWire {
  enabled: boolean;
  root: string;
  extraRoots: string[];
  maxBytes: number;
  maxAutoEntries: number;
}

/** 外置聊天人设配置（与 src/config.ts 的 PersonasConfig 对应） */
export interface PersonasWire {
  root: string;
}

/** 富媒体理解（与 src/config.ts 的 MediaConfig 对应） */
export interface MediaWire {
  enabled: boolean;
  maxMB: number;
  ttlHours: number;
  maxTotalMB: number;
}

/** 视觉理解（与 src/config.ts 的 VisionConfig 对应；apiKey 不涉及） */
export interface VisionWire {
  enabled: boolean;
  native: boolean;
  provider: string;
  model: string;
  defaultPrompt: string;
  maxBytes: number;
  maxTokens: number;
  timeoutMs: number;
}

/** 语音识别备用接口（与 src/config.ts 的 AsrFallbackConfig 对应，不含 apiKey） */
export interface AsrFallbackWire {
  enabled: boolean;
  baseUrl: string;
  apiKeyEnv?: string;
  model: string;
  timeoutMs: number;
}

/** 在线语音识别（与 src/config.ts 的 AsrConfig 对应；apiKey/chatApiKey 走环境变量/patch，不进表单） */
export interface AsrWire {
  enabled: boolean;
  /** 'chat' = chat/completions + input_audio，'openai' = /audio/transcriptions */
  mode: string;
  baseUrl: string;
  apiKeyEnv?: string;
  model: string;
  chatBaseUrl?: string;
  chatModel?: string;
  chatApiKeyEnv?: string;
  chatReasoningEffort?: string;
  preferQQ: boolean;
  timeoutMs: number;
  fallback?: AsrFallbackWire;
}

/** 视频理解（与 src/config.ts 的 VideoConfig 对应，不含 apiKey） */
export interface VideoWire {
  enabled: boolean;
  ffmpegPath: string;
  maxFrames: number;
  maxSeconds: number;
  directEnabled?: boolean;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  reasoningEffort?: string;
}

/** 生图与参考图编辑（与 src/config.ts 的 ImageGenConfig 对应，不含 apiKey） */
export interface ImageGenWire {
  enabled: boolean;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  standardModel: string;
  defaultQuality: ImageGenQuality;
  defaultSize: string;
  defaultComplexity: ImageGenComplexity;
  timeoutMs: number;
  allowAllGroups: boolean;
  allowedGroups: string[];
}

/** 附件发送（与 src/config.ts 的 SendFileConfig 对应） */
export interface SendFileWire {
  restrictPaths: boolean;
  extraRoots: string[];
}

/** ElevenLabs 在线 TTS（与 src/config.ts 的 ElevenLabsSpeakConfig 对应，不含 apiKey） */
export interface ElevenLabsSpeakWire {
  enabled: boolean;
  baseUrl: string;
  apiKeyEnv: string;
  modelId: string;
  outputFormat: ElevenLabsOutputFormat;
  defaultVoiceId: string;
  roleVoices: Record<string, string>;
  speed: number;
  stability: number;
  similarityBoost: number;
  styleExaggeration: number;
  useSpeakerBoost: boolean;
  timeoutMs: number;
}

/** DeepSeek 在线 TTS（与 src/config.ts 的 DeepSeekSpeakConfig 对应，不含 apiKey） */
export interface DeepSeekSpeakWire {
  enabled: boolean;
  baseUrl: string;
  apiKeyEnv: string;
  defaultVoiceId: string;
  roleVoices: Record<string, string>;
  speed: number;
  timeoutMs: number;
}

/** 语音合成（与 src/config.ts 的 SpeakConfig 对应） */
export interface SpeakWire {
  enabled: boolean;
  voice: string;
  rate: string;
  maxChars: number;
  command: string;
  gsvUrl: string;
  gsvSpeed: number;
  elevenlabs?: ElevenLabsSpeakWire;
  deepseek?: DeepSeekSpeakWire;
}

/** 笔记注入相关性打分（与 src/config.ts 的 NoteJudgeConfig 对应） */
export interface NoteJudgeWire {
  enabled: boolean;
  timeoutMs: number;
  sampleRate: number;
  minSamples: number;
  muteBelow: number;
}

/** 笔记语义检索（与 src/config.ts 的 NotesSemanticConfig 对应，不含 apiKey） */
export interface NotesSemanticWire {
  enabled: boolean;
  baseUrl: string;
  model: string;
  minSimilarity: number;
  minMargin: number;
  timeoutMs: number;
}

/** 共享笔记库（与 src/config.ts 的 NotesConfig 对应） */
export interface NotesWire {
  enabled: boolean;
  root: string;
  autoInject: boolean;
  injectTopK: number;
  injectMaxChars: number;
  injectPerNoteChars?: number;
  groupInjectMaxChars?: number;
  injectMinCoverage: number;
  /** 密钥不上表单（GET 回显为空，POST 由服务端回填） */
  semantic?: NotesSemanticWire;
  judge?: NoteJudgeWire;
}

/** 工具权限（与 src/config.ts 的 ToolAccessConfig 对应） */
export interface ToolAccessWire {
  enabled: boolean;
  fullAccessGroups: string[];
  fullAccessUsers: string[];
  readRoots: string[];
}

/** 上游监测与主备切换（与 src/config.ts 的 ModelFailoverConfig 对应） */
export interface ModelFailoverWire {
  enabled: boolean;
  intervalMinutes: number;
  failThreshold: number;
  recoverThreshold: number;
  primaryProvider: string;
  primaryModel: string;
  primaryApiKeyEnv: string;
  backupProvider: string;
  backupModel: string;
  backupApiKeyEnv: string;
  ttftThresholdMs: number;
  notify: boolean;
}

/** 定期清理（rules 不在表单上，保存时由服务端保留旧值） */
export interface CleanupWire {
  dryRun: boolean;
}

/** 搜图（与 src/config.ts 的 FanartConfig 对应） */
export interface FanartWire {
  enabled: boolean;
  proxy: string;
  poolDir: string;
}

/** 跑团（与 src/config.ts 的 DndConfig 对应） */
export interface DndWire {
  enabled: boolean;
  root: string;
  turnButtons: boolean;
  interjections: boolean;
  snapshotIntervalTurns?: number;
  combatAgent?: { enabled: boolean; provider: string; model: string; reasoningEffort: string; contextChars: number };
}

/** 回复欲望的模型打分（与 src/config.ts 的 ReplyJudgeConfig 对应） */
export interface ReplyJudgeWire {
  enabled: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
  debounceMs: number;
  maxWaitMs: number;
  contextMessages: number;
  timeoutMs: number;
}

/** 回复欲望门控（与 src/config.ts 的 ReplyDesireConfig 对应） */
export interface ReplyDesireWire {
  enabled: boolean;
  threshold: number;
  names: string[];
  engagedMs: number;
  engagedMaxTurns: number;
  judge: ReplyJudgeWire;
}

/** GET 回显的生效配置（appSecret / asr.apiKey 已剔除） */
export type ConfigWire = {
  groupTriggerMode?: GroupTriggerMode;
  requireMention?: boolean;
  streaming?: boolean;
  showToolResults?: boolean;
  debug?: boolean;
  provider?: string;
  model?: string;
  preset?: string;
  groupPrompt?: string;
  directPrompt?: string;
  groupReplyProbability?: number;
  historyLimit?: number;
  sessionIdleTimeout?: number;
  textChunkLimit?: number;
  maxQueue?: number;
  steerWindowMs?: number;
  processingTimeoutMs?: number;
  askTimeoutMs?: number;
  autoCompactTokens?: number;
  autoCompactPrivateRatio?: number;
  autoCompactDeferOnTools?: boolean;
  idleCompactMinutes?: number;
  idleCompactTokens?: number;
  idleCompactProviders?: string;
  tmpDir?: string;
  tmpTtlHours?: number;
  tmpMaxTotalMB?: number;
  ownerOpenid?: string;
  adminOpenids?: string[];
  access?: AccessControlWire;
  fileAccess?: FileAccessWire;
  stickers?: StickersWire;
  personas?: PersonasWire;
  notes?: NotesWire;
  toolAccess?: ToolAccessWire;
  modelFailover?: ModelFailoverWire;
  media?: MediaWire;
  vision?: VisionWire;
  asr?: AsrWire;
  video?: VideoWire;
  imageGen?: ImageGenWire;
  sendFile?: SendFileWire;
  speak?: SpeakWire;
  cleanup?: CleanupWire;
  fanart?: FanartWire;
  browser?: BrowserConfig;
  dnd?: DndWire;
  replyDesire?: ReplyDesireWire;
  cwd?: string;
};

export type PatchFn = <K extends keyof ConfigWire>(key: K, value: ConfigWire[K]) => void;

export const ELEVENLABS_SPEAK_WIRE_DEFAULTS: ElevenLabsSpeakWire = {
  enabled: false,
  baseUrl: 'https://api.elevenlabs.io/v1',
  apiKeyEnv: 'ELEVENLABS_API_KEY',
  modelId: 'eleven_v4',
  outputFormat: 'mp3_44100_128',
  defaultVoiceId: '',
  roleVoices: {},
  speed: 1.0,
  stability: 0.5,
  similarityBoost: 0.75,
  styleExaggeration: 0.0,
  useSpeakerBoost: true,
  timeoutMs: 180000,
};

export const DEEPSEEK_SPEAK_WIRE_DEFAULTS: DeepSeekSpeakWire = {
  enabled: false,
  baseUrl: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  defaultVoiceId: '',
  roleVoices: {},
  speed: 1.0,
  timeoutMs: 180000,
};

export const REPLY_JUDGE_DEFAULTS: ReplyJudgeWire = {
  enabled: false, provider: '', model: '', reasoningEffort: '',
  debounceMs: 2500, maxWaitMs: 15000, contextMessages: 20, timeoutMs: 15000,
};

export const MODE_OPTIONS: ReadonlyArray<{ value: AccessMode; label: string }> = [
  { value: 'open', label: '所有人' },
  { value: 'allowlist', label: '白名单' },
  { value: 'disabled', label: '禁用' },
];

export const GROUP_TRIGGER_OPTIONS: Array<{ value: GroupTriggerMode; label: string }> = [
  { value: 'mention', label: '仅 @ 回复（mention）' },
  { value: 'probability', label: '随机概率接话（probability）' },
  { value: 'desire', label: '回复欲望打分（desire）' },
  { value: 'all', label: '回复全部群消息（all）' },
];

const BUILTIN_SPEAK_ROLES = new Set(['feiyu', 'dragon', 'hakimi']);

export function getRoleVoiceValue(roleVoices: Record<string, string>, key: string): string {
  const needle = key.toLowerCase();
  for (const [k, v] of Object.entries(roleVoices)) {
    if (k.trim().toLowerCase() === needle) return v;
  }
  return '';
}

export function setBuiltinRoleVoice(roleVoices: Record<string, string>, role: string, voiceId: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(roleVoices)) {
    if (k.trim().toLowerCase() !== role) next[k] = v;
  }
  const trimmed = voiceId.trim();
  if (trimmed !== '') next[role] = trimmed;
  return next;
}

export function formatExtraRoleVoices(roleVoices: Record<string, string>): string {
  return Object.entries(roleVoices)
    .filter(([k, v]) => !BUILTIN_SPEAK_ROLES.has(k.trim().toLowerCase()) && v.trim() !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function mergeExtraRoleVoices(current: Record<string, string>, raw: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) {
    if (BUILTIN_SPEAK_ROLES.has(k.trim().toLowerCase()) && v.trim() !== '') {
      next[k.trim().toLowerCase()] = v.trim();
    }
  }
  for (const line of raw.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === '' || val === '' || BUILTIN_SPEAK_ROLES.has(key.toLowerCase())) continue;
    next[key] = val;
  }
  return next;
}

export function cleanRoleVoicesMap(raw: Record<string, string> | undefined): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const tk = k.trim();
    const tv = v.trim();
    if (tk !== '' && tv !== '') clean[tk] = tv;
  }
  return clean;
}

/** 深比较（表单值与初始回显值的 dirty 判断） */
export function shallowEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const cleanLines = (values: readonly string[]): string[] => values.map((s) => s.trim()).filter(Boolean);

/**
 * 提取与 initial 相比发生变更的顶层配置键，并统一做空白清理与空行过滤。
 * 无任何变更时返回空对象。
 */
export function normalizeChangedConfig(form: ConfigWire, initial: ConfigWire): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(form) as Array<keyof ConfigWire>) {
    if (!shallowEqual(form[key], initial[key])) {
      changed[key] = form[key];
    }
  }
  if (Object.keys(changed).length === 0) return changed;

  // 白名单编辑期间保留原始换行/空行（textarea 可正常回车），提交时才规范化
  if (changed.adminOpenids !== undefined) {
    changed.adminOpenids = cleanLines(changed.adminOpenids as string[]);
  }
  if (changed.access !== undefined) {
    const a = changed.access as AccessControlWire;
    changed.access = {
      ...a,
      c2cAllow: cleanLines(a.c2cAllow),
      groupAllow: cleanLines(a.groupAllow),
    };
  }
  if (changed.fileAccess !== undefined) {
    const f = changed.fileAccess as FileAccessWire;
    changed.fileAccess = { sensitivePaths: cleanLines(f.sensitivePaths) };
  }
  if (changed.stickers !== undefined) {
    const s = changed.stickers as StickersWire;
    changed.stickers = { ...s, extraRoots: cleanLines(s.extraRoots) };
  }
  if (changed.personas !== undefined) {
    const p = changed.personas as PersonasWire;
    changed.personas = { ...p, root: p.root.trim() };
  }
  if (changed.toolAccess !== undefined) {
    const t = changed.toolAccess as ToolAccessWire;
    changed.toolAccess = {
      ...t,
      fullAccessGroups: cleanLines(t.fullAccessGroups),
      fullAccessUsers: cleanLines(t.fullAccessUsers),
      readRoots: cleanLines(t.readRoots),
    };
  }
  if (changed.modelFailover !== undefined) {
    const f = changed.modelFailover as ModelFailoverWire;
    changed.modelFailover = {
      ...f,
      primaryProvider: f.primaryProvider.trim(),
      primaryModel: f.primaryModel.trim(),
      backupProvider: f.backupProvider.trim(),
      backupModel: f.backupModel.trim(),
      primaryApiKeyEnv: f.primaryApiKeyEnv.trim(),
      backupApiKeyEnv: f.backupApiKeyEnv.trim(),
    };
  }
  if (changed.sendFile !== undefined) {
    const s = changed.sendFile as SendFileWire;
    changed.sendFile = { ...s, extraRoots: cleanLines(s.extraRoots) };
  }
  if (changed.replyDesire !== undefined) {
    const r = changed.replyDesire as ReplyDesireWire;
    changed.replyDesire = { ...r, names: cleanLines(r.names) };
  }
  if (changed.imageGen !== undefined) {
    const g = changed.imageGen as ImageGenWire;
    changed.imageGen = {
      ...g,
      baseUrl: g.baseUrl.trim(),
      apiKeyEnv: g.apiKeyEnv.trim(),
      model: g.model.trim(),
      standardModel: g.standardModel.trim(),
      defaultSize: g.defaultSize.trim(),
      allowedGroups: cleanLines(g.allowedGroups),
    };
  }
  if (changed.speak !== undefined) {
    const s = changed.speak as SpeakWire;
    const el = s.elevenlabs;
    const ds = s.deepseek;
    changed.speak = {
      ...s,
      voice: s.voice.trim(),
      rate: s.rate.trim(),
      command: s.command.trim(),
      gsvUrl: s.gsvUrl.trim(),
      ...(el === undefined ? {} : {
        elevenlabs: {
          ...el,
          baseUrl: el.baseUrl.trim(),
          apiKeyEnv: el.apiKeyEnv.trim(),
          modelId: el.modelId.trim(),
          defaultVoiceId: el.defaultVoiceId.trim(),
          roleVoices: cleanRoleVoicesMap(el.roleVoices),
        },
      }),
      ...(ds === undefined ? {} : {
        deepseek: {
          ...ds,
          baseUrl: ds.baseUrl.trim(),
          apiKeyEnv: ds.apiKeyEnv.trim(),
          defaultVoiceId: ds.defaultVoiceId.trim(),
          roleVoices: cleanRoleVoicesMap(ds.roleVoices),
        },
      }),
    };
  }

  return changed;
}
