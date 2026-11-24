/**
 * /bot-doctor 运行时自检（人设唯一真源、触发门控一致性、会话压缩锁、存储与外部服务可达性）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionRecord } from '../session/types.ts';
import type { ChatScope } from '../types.ts';
import { defaultEnvFiles } from '../shared/paths.ts';
import { resolveGroupTriggerMode, type GroupTriggerMode } from './group-trigger.ts';
import type { Persona, PersonaSwitchState } from './persona-store.ts';
import type { HandoffState } from './persona-handoff.ts';
import { readScheduleMigrations, scheduleStorageHome } from '../session/schedule-migration.ts';

export type GsvProbeStatus = 'disabled' | 'reachable' | 'offline';

export interface BotDoctorManagerLike {
  readonly size: number;
  readonly notesStore?: unknown;
  readonly personaStore?: {
    readonly dir?: string;
    list(scope?: ChatScope): Persona[];
    defaultPersona?(scope?: ChatScope): Persona | undefined;
    currentId(peerId: string, scope?: ChatScope): string;
    handoffs?: { read(chatKey: string): HandoffState };
  };
  sessionKey(scope: ChatScope, peerId: string): string;
  sessionIdFor(scope: ChatScope, peerId: string): string;
  getEffectiveModel(scope: ChatScope, peerId: string): { provider?: string; model?: string } | undefined;
  getSessionRecord(scope: ChatScope, peerId: string): SessionRecord | undefined;
  getPersonaSwitchState?(scope: ChatScope, peerId: string): PersonaSwitchState;
  getContextLockStatus?(record: SessionRecord): { locked: boolean; reasons: string[] };
}

export interface BotDoctorReport {
  scope: ChatScope;
  peerId: string;
  personas: {
    enabled: boolean;
    dir?: string;
    count: number;
    currentId: string;
    switchState: PersonaSwitchState;
    hasDefaultGroup: boolean;
    hasDefaultDirect: boolean;
    defaultGroupNames: number;
    defaultDirectNames: number;
    pendingHandoffStatus?: 'generating' | 'failed';
  };
  triggerMode: GroupTriggerMode;
  modelRoute?: string;
  activeSessions: number;
  sessionId: string;
  contextLock: { locked: boolean; reasons: string[] };
  notesEnabled: boolean;
  scheduleCount: number;
  gsv: { url: string; status: GsvProbeStatus };
  elevenlabs: { enabled: boolean; hasKey: boolean; configuredVoices: number };
  deepseek: { enabled: boolean; hasKey: boolean; configuredVoices: number };
  warnings: string[];
}

export type UrlProbe = (url: string, timeoutMs: number) => Promise<'reachable' | 'offline'>;

const DEFAULT_PROBE_TIMEOUT_MS = 1500;

function hasEnvKeyInFiles(envFiles: readonly string[], keyRef: string): boolean {
  for (const file of envFiles) {
    try {
      if (!existsSync(file)) continue;
      const parsed = parseEnv(readFileSync(file, 'utf8'));
      if (parsed[keyRef]?.trim()) return true;
    } catch {
      // 忽略异常环境文件
    }
  }
  return false;
}

async function defaultProbeUrl(url: string, timeoutMs: number): Promise<'reachable' | 'offline'> {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return 'reachable';
  } catch {
    return 'offline';
  }
}

export async function runBotDoctor(deps: {
  manager: BotDoctorManagerLike;
  config: Partial<ImQQBotConfig>;
  scope: ChatScope;
  peerId: string;
  probeUrl?: UrlProbe;
  readScheduleCount?: (sessionId: string) => number;
  env?: Record<string, string | undefined>;
  envFiles?: readonly string[];
}): Promise<BotDoctorReport> {
  const { manager, config, scope, peerId } = deps;
  const env = deps.env ?? process.env;
  const warnings: string[] = [];

  const key = manager.sessionKey(scope, peerId);
  const sessionId = manager.sessionIdFor(scope, peerId);
  const ps = manager.personaStore;
  const defaultGroup = ps?.defaultPersona?.('group');
  const defaultDirect = ps?.defaultPersona?.('c2c');
  const switchState = manager.getPersonaSwitchState?.(scope, peerId) ?? 'idle';

  let pendingHandoffStatus: 'generating' | 'failed' | undefined;
  try {
    pendingHandoffStatus = ps?.handoffs?.read(key).pending?.status;
  } catch {
    warnings.push('无法读取人设交接状态文件');
  }

  if (ps === undefined) {
    warnings.push('PersonaStore 未初始化');
  } else {
    if (!defaultGroup) warnings.push('缺少外置默认群聊人设（default.group.md）');
    if (!defaultDirect) warnings.push('缺少外置默认私聊人设（default.direct.md）');
  }
  const personaDirHint = ps?.dir ?? '~/.dsh-qqbot/personas/';
  if (typeof config.groupPrompt === 'string' && config.groupPrompt.trim() !== '') {
    warnings.push(`配置仍含内嵌 groupPrompt，建议移除并由 ${personaDirHint} 唯一托管`);
  }
  if (typeof config.directPrompt === 'string' && config.directPrompt.trim() !== '') {
    warnings.push(`配置仍含内嵌 directPrompt，建议移除并由 ${personaDirHint} 唯一托管`);
  }
  if (switchState !== 'idle') {
    warnings.push(`人设切换状态机处于 ${switchState}`);
  }
  if (pendingHandoffStatus !== undefined) {
    warnings.push(`存在未完成的人设交接（pending=${pendingHandoffStatus}）`);
  }

  const triggerMode = resolveGroupTriggerMode(config);
  if (config.groupTriggerMode !== undefined && config.groupTriggerMode !== 'desire' && config.replyDesire?.enabled === true) {
    warnings.push(`配置存在历史冲突：groupTriggerMode=${config.groupTriggerMode} 但 replyDesire.enabled=true（已按 groupTriggerMode 生效）`);
  }

  if (config.notes?.semantic?.enabled === true && !config.notes.semantic.apiKey && !env.QQBOT_EMBEDDING_API_KEY) {
    warnings.push('notes.semantic 已启用，但未设置 notes.semantic.apiKey 与 QQBOT_EMBEDDING_API_KEY');
  }
  const imageGenEnvRef = config.imageGen?.apiKeyEnv?.trim() || 'OPENAI_API_KEY';
  if (config.imageGen?.enabled === true && !config.imageGen.apiKey?.trim() && !env[imageGenEnvRef]) {
    warnings.push(`imageGen 已启用，但未设置 imageGen.apiKey 与环境变量 ${imageGenEnvRef}`);
  }

  const envFiles = deps.envFiles ?? (
    deps.env !== undefined || process.env.VITEST
      ? []
      : defaultEnvFiles()
  );

  if (Object.prototype.hasOwnProperty.call(config, 'browser') && (config as Record<string, unknown>).browser !== undefined) {
    warnings.push('配置仍含已下线的 browser 字段（Playwright 已于 0.9.0 移除），保存一次设置会自动清理或可手动删除');
  }
  const asrChatUrl = (config.asr?.chatBaseUrl ?? '').trim()
    || (env.QQBOT_TRANSCRIBE_BASE_URL ?? '').trim()
    || (hasEnvKeyInFiles(envFiles, 'QQBOT_TRANSCRIBE_BASE_URL') ? 'configured' : '');
  if (config.asr?.enabled === true && (config.asr.mode ?? 'chat') === 'chat' && asrChatUrl === '') {
    warnings.push('asr 已启用（chat 模式），但 0.9.0 已清空内置第三方转写网关，请在设置页补填 chatBaseUrl 或设置 QQBOT_TRANSCRIBE_BASE_URL');
  }
  if (
    config.modelFailover?.enabled === true
    && (!config.modelFailover.backupProvider?.trim() || !config.modelFailover.backupModel?.trim())
  ) {
    warnings.push('modelFailover 已启用，但 0.9.0 已清空默认备模，请补填自有 backupProvider/backupModel 或关闭该开关');
  }
  if (
    config.dnd?.combatAgent?.enabled === true
    && (!config.dnd.combatAgent.provider?.trim() || !config.dnd.combatAgent.model?.trim())
  ) {
    warnings.push('dnd.combatAgent 已启用，但 0.9.0 已清空默认战斗模型，请补填 provider/model 或关闭以继承主模型');
  }
  if (
    config.fanart?.enabled !== true
    && Boolean(config.fanart?.proxy?.trim() || config.fanart?.poolDir?.trim())
  ) {
    warnings.push('fanart 填有代理/标签池配置但当前未开启（0.9.0 起扩展工具默认关闭，如需继续使用请开启 fanart.enabled）');
  }
  if (config.sing?.enabled !== true && Boolean(config.sing?.baseUrl?.trim())) {
    warnings.push('sing 填有 baseUrl 但当前未开启（0.9.0 起扩展工具默认关闭，如需继续使用请开启 sing.enabled）');
  }

  const route = manager.getEffectiveModel(scope, peerId);
  const record = manager.getSessionRecord(scope, peerId);
  const contextLock = record !== undefined && manager.getContextLockStatus !== undefined
    ? manager.getContextLockStatus(record)
    : { locked: false, reasons: [] };

  let scheduleCount = 0;
  try {
    scheduleCount = deps.readScheduleCount !== undefined
      ? deps.readScheduleCount(sessionId)
      : readScheduleMigrations(scheduleStorageHome(), sessionId).length;
  } catch {
    warnings.push('定时任务目录读取失败');
  }

  const gsvUrl = (config.speak?.gsvUrl ?? '').trim();
  const gsvStatus: GsvProbeStatus = gsvUrl === ''
    ? 'disabled'
    : await (deps.probeUrl ?? defaultProbeUrl)(gsvUrl, DEFAULT_PROBE_TIMEOUT_MS);
  if (gsvStatus === 'offline') {
    warnings.push(`本地语音服务不可达（${gsvUrl}），qqbot_speak 将退回 edge-tts`);
  }

  const el = config.speak?.elevenlabs;
  const elEnabled = el?.enabled === true;
  const elEnvRef = el?.apiKeyEnv?.trim() || 'ELEVENLABS_API_KEY';
  const elHasKey = Boolean(el?.apiKey?.trim() || env[elEnvRef]?.trim() || hasEnvKeyInFiles(envFiles, elEnvRef));
  const roleVoiceCount = Object.values(el?.roleVoices ?? {}).filter((v) => typeof v === 'string' && v.trim() !== '').length;
  const personaVoiceCount = [defaultGroup, defaultDirect, ...(ps?.list(scope) ?? [])]
    .filter((p) => Boolean(p?.voiceId?.trim()))
    .length;
  const elVoiceCount = roleVoiceCount + personaVoiceCount + (el?.defaultVoiceId?.trim() ? 1 : 0);
  if (elEnabled) {
    if (!elHasKey) {
      warnings.push(`speak.elevenlabs 已启用，但未设置 speak.elevenlabs.apiKey、环境变量 ${elEnvRef} 或 .env.local`);
    }
    if (elVoiceCount === 0) {
      warnings.push('speak.elevenlabs 已启用，但未配置 defaultVoiceId、roleVoices 或人设 voiceId');
    }
  }

  const ds = config.speak?.deepseek;
  const dsEnabled = ds?.enabled === true;
  const dsEnvRef = ds?.apiKeyEnv?.trim() || 'DEEPSEEK_API_KEY';
  const dsHasKey = Boolean(ds?.apiKey?.trim() || env[dsEnvRef]?.trim() || hasEnvKeyInFiles(envFiles, dsEnvRef));
  const dsVoiceCount = Object.values(ds?.roleVoices ?? {}).filter((v) => typeof v === 'string' && v.trim() !== '').length
    + (ds?.defaultVoiceId?.trim() ? 1 : 0);
  if (dsEnabled) {
    if (!dsHasKey) {
      warnings.push(`speak.deepseek 已启用，但未设置 speak.deepseek.apiKey、环境变量 ${dsEnvRef} 或 .env`);
    }
    if (dsVoiceCount === 0) {
      warnings.push('speak.deepseek 已启用，但未配置 defaultVoiceId 或 roleVoices');
    }
  }

  return {
    scope,
    peerId,
    personas: {
      enabled: ps !== undefined,
      ...(ps?.dir !== undefined ? { dir: ps.dir } : {}),
      count: ps?.list(scope).length ?? 0,
      currentId: ps?.currentId(peerId, scope) ?? 'default',
      switchState,
      hasDefaultGroup: defaultGroup !== undefined,
      hasDefaultDirect: defaultDirect !== undefined,
      defaultGroupNames: defaultGroup?.names.length ?? 0,
      defaultDirectNames: defaultDirect?.names.length ?? 0,
      ...(pendingHandoffStatus !== undefined ? { pendingHandoffStatus } : {}),
    },
    triggerMode,
    modelRoute: route?.provider && route?.model ? `${route.provider}/${route.model}` : undefined,
    activeSessions: manager.size,
    sessionId,
    contextLock,
    notesEnabled: manager.notesStore !== undefined,
    scheduleCount,
    gsv: { url: gsvUrl, status: gsvStatus },
    elevenlabs: { enabled: elEnabled, hasKey: elHasKey, configuredVoices: elVoiceCount },
    deepseek: { enabled: dsEnabled, hasKey: dsHasKey, configuredVoices: dsVoiceCount },
    warnings,
  };
}

export function renderBotDoctorReport(report: BotDoctorReport): string {
  const defaultOk = report.personas.hasDefaultGroup && report.personas.hasDefaultDirect;
  const gsvText = report.gsv.status === 'disabled'
    ? '未配置'
    : report.gsv.status === 'reachable'
      ? `在线 (${report.gsv.url})`
      : `离线 (${report.gsv.url})`;
  const elText = !report.elevenlabs.enabled
    ? '未启用'
    : report.elevenlabs.hasKey && report.elevenlabs.configuredVoices > 0
      ? `已启用 (${report.elevenlabs.configuredVoices} 个音色配置)`
      : '已启用（待补齐配置）';
  const dsText = !report.deepseek.enabled
    ? '未启用'
    : report.deepseek.hasKey && report.deepseek.configuredVoices > 0
      ? `已启用 (${report.deepseek.configuredVoices} 个音色配置)`
      : '已启用（待补齐配置）';
  const lockText = report.contextLock.locked
    ? `锁定 (${report.contextLock.reasons.join('、')})`
    : '空闲';

  const lines = [
    '🩺 Bot 自检报告 (/bot-doctor)',
    `人设: 当前=${report.personas.currentId} · 可选 ${report.personas.count} 项 · 状态机=${report.personas.switchState} · 默认文件=${defaultOk ? '完整' : '缺失'}`,
    `触发门控: groupTriggerMode=${report.triggerMode}`,
    `模型与会话: 路由=${report.modelRoute ?? '宿主默认'} · 活跃会话=${report.activeSessions} · 当前=${report.sessionId.slice(0, 8)} · 压缩锁=${lockText}`,
    `存储与服务: 共享笔记=${report.notesEnabled ? '已启用' : '未启用'} · 本会话定时任务=${report.scheduleCount} · ElevenLabs=${elText} · DeepSeekTTS=${dsText} · GPT-SoVITS=${gsvText}`,
  ];
  if (report.warnings.length === 0) {
    lines.push('✅ 未发现异常或配置漂移');
  } else {
    lines.push(`⚠️ 发现 ${report.warnings.length} 项提醒：`);
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  return lines.join('\n');
}
