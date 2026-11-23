/**
 * SessionManager — 管理 QQ peer → dsh Agent 的映射和生命周期
 *
 * sessionKey 格式: `qqbot:${appId}:${kind}:${peerId}`
 *   - c2c:   peerId = senderId (用户 openid)
 *   - group: peerId = groupOpenid
 *
 * SessionId 由 sessionKey 确定性派生（SHA-256），
 * 保证同一个用户/群的消息始终路由到同一个会话，
 * 重启后可根据 key 恢复 session。
 *
 * 支持 agent-presets 系统：通过 setup hook 在 create/resume 时
 * 挂载 preset（工具集、prompt sections 等），实现场景化配置。
 */
import { createHash, randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { ImageBlock } from '@deepseek-ai/dsh-llm';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import type { ImQQBotConfig } from '../config.ts';
import { loadNativeImageBlock, type AttachmentStoreLike } from '../media/native-image.ts';
import { ModelResolver } from '../model/model-resolver.ts';
import type { ModelRoute, ModelEntry } from '../model/types.ts';
import { IdleEvictor } from './idle-evictor.ts';
import type { StickerStore, StickerMatchResult } from '../media/sticker-store.ts';
import { chatKeyOf, planNoteInjection, type NoteHit, type NoteQueryContext, type NotesStore } from '../notes/notes-store.ts';
import type { MediaReviewCoordinator } from '../features/media-review-coordinator.ts';
import { boundedRecall, noteRevisionKey, operationQueryTerms, RecallTurnState, toolOperationEvidence } from '../notes/operation-recall.ts';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  createNotesRecallMessage,
  createPersonaHandoffMessage,
  isPersonaHandoffSource,
  QQBOT_MESSAGE_SOURCE,
  summarizeNotesHint,
} from '../shared/message-source.ts';
import { deriveProjectsFromCwd } from '../notes/note-metadata.ts';
import type { NoteMetricsStore } from '../notes/note-metrics.ts';
import type { NoteJudge } from '../features/note-judge.ts';
import { renderNoteStats, type NoteStatsView } from '../features/note-stats.ts';
import { formatHandoffHint, latestCompactionSummary } from '../features/session-handoff.ts';
import { collectHandoffInput, generatePersonaHandoff } from '../features/persona-handoff.ts';
import type { JudgeLine, JudgeLlm } from '../features/reply-judge.ts';
import { collectJudgeLines } from '../middleware/reply-decider.ts';
import { sanitizePseudoToolText } from '../media/pseudo-sticker-call.ts';
import type { ToolAccess } from '../features/tool-access.ts';
import { DndSnapshotGate, type DndService } from '../dnd/dnd-service.ts';
import type { DndCombatAgents } from '../dnd/combat-agent.ts';
import type { DndToolScope } from '../dnd/tool-scope.ts';
import type { SessionToolScope } from '../features/session-tool-scope.ts';
import { PromptLatch } from '../features/prompt-latch.ts';
import type { DndTurnButtons } from '../dnd/turn-buttons.ts';
import { resolveTmpDir } from '../media/tmp-dir.ts';
import { isVoiceFile, VOICE_REPLY_REMINDER } from '../media/voice-reply.ts';
import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';
import {
  formatScheduleMigrationHint,
  readScheduleMigrations,
  retireMigratedSchedules,
  scheduleStorageHome,
  type ScheduleMigrationTask,
  type ScheduleServiceLike,
} from './schedule-migration.ts';
import type { QuestionChannel } from '../features/question-channel.ts';
import type { ApprovalChannel } from '../features/approval-channel.ts';
import { GROUP_MESSAGE_FORMAT_PROMPT } from '../features/message-format.ts';
import type { PersonaStore, PersonaSwitchState } from '../features/persona-store.ts';
import type { PersonaSwitch, SwitchPersonaOutcome } from '../features/persona-switch.ts';
import {
  ContextLockManager,
  compactThreshold,
  decideAutoCompact,
  deferCeiling,
  hasOpenBackgroundJobs,
  lastTurnUsedTools,
  shouldIdleCompact,
} from '../features/compact-policy.ts';
import { TurnSteerTracker } from '../transport/turn-steer.ts';
import type {
  SessionEventLike,
  DshAgent,
  DshAgentHandle,
  DshAgentRegistry,
  AgentPresetsLike,
  PresetComposition,
  PresetEntry,
  PresetSwitchOutcome,
  SessionRecord,
  SessionStatus,
  TokenUsageStats,
  CompactionServiceLike,
  CompactOutcome,
} from './types.ts';

/** ManualCompactionError 各 code 的友好提示 */
const COMPACTION_ERROR_HINTS: Record<string, string> = {
  busy: '压缩服务忙，请稍后重试',
  cancelled: '压缩已取消',
  changed: '历史在压缩过程中发生变化，请重试',
  commit: '压缩提交失败',
  persistence: '压缩完成但保存失败',
};

export type EndDndSessionOutcome =
  | { status: 'handed_off' }
  | { status: 'inactive' }
  | { status: 'busy' }
  | { status: 'error'; message: string }
  | { status: 'paused_fallback'; message: string };

/** ctx.llm 查模型窗口的最小接口 */
/** 新会话的第一条消息最多等旧会话压缩这么久，再久就不带交接了（一次压缩通常十几秒） */
const HANDOFF_WAIT_MS = 60_000;

/** 登记了注入却迟迟没等到轮次结束时，多久之后作废 */
const NOTE_INJECTION_TTL_MS = 30 * 60_000;

/** 已经拼进消息、还没等到轮次结束的一次笔记注入 */
interface PendingNoteInjection {
  query: string;
  at: number;
  campaignRunning: boolean;
  hits: NoteHit[];
  /** 每段实际注入的正文（截断后），与 hits 一一对应 */
  snippets: string[];
  /** 入站时采集的最近群聊上下文（不含当前消息） */
  contextLines?: JudgeLine[];
}

/** 轮次结束时由出站路由器传回的本轮实际产出，供笔记相关性打分参考 */
export interface NoteTurnSummary {
  reply?: string;
  toolsUsed?: readonly string[];
}

/** 入站暂存的共享笔记召回参数，由 agent/pre-step 在真正进入模型步骤时独立注入 */
export interface StagedNoteRecall {
  query: string;
  operations: readonly string[];
  scope: ChatScope;
  peerId: string;
  messageId?: string;
  steered: boolean;
}

function cleanUserEventText(raw: string): string {
  const currentIdx = raw.lastIndexOf('[Current message]');
  const body = currentIdx >= 0 ? raw.slice(currentIdx + '[Current message]'.length) : raw;
  let afterNotes = body;
  for (const noteTail of ['更多用 qqbot_notes(action="search")。）', '要看更多用 qqbot_notes_search。）']) {
    if (afterNotes.includes(noteTail)) {
      afterNotes = afterNotes.slice(afterNotes.lastIndexOf(noteTail) + noteTail.length);
    }
  }
  return afterNotes
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t !== ''
        && !t.startsWith('- Image:')
        && !t.startsWith('- Video:')
        && !t.startsWith('- File:')
        && !t.startsWith('- Voice:')
        && !t.startsWith('[图片已原生附上')
        && !t.startsWith('[图片未原生注入')
        && !t.startsWith('[本地表情库]')
        && !t.startsWith('[转发聊天记录里的图片]');
    })
    .join(' ')
    .trim();
}

/** 私聊没有群记忆文件，从会话历史里取本轮之前的最近几句对话作为打分背景 */
function recentSessionLines(agent: DshAgent | undefined, limit: number): JudgeLine[] {
  try {
    const events = agent?.session?.snapshotEvents?.() ?? agent?.session?.events ?? [];
    if (events.length === 0 || limit <= 0) return [];
    const readMsg = (event: SessionEventLike) => {
      const data = (event.data ?? event) as {
        content?: Array<{ type: string; text?: string }>;
        source?: { kind?: string };
        message?: { content?: Array<{ type: string; text?: string }>; source?: { kind?: string } };
      };
      const message = data.message ?? data;
      const source = message.source ?? data.source;
      const text = message.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim() ?? '';
      return { kind: source?.kind, text };
    };
    let cut = events.length;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.type !== 'user/message') continue;
      const { kind } = readMsg(ev);
      if (kind === undefined || kind === 'user') {
        cut = i;
        break;
      }
    }
    const lines: JudgeLine[] = [];
    for (let i = cut - 1; i >= 0 && lines.length < limit; i--) {
      const ev = events[i]!;
      if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue;
      const { kind, text } = readMsg(ev);
      if (!text) continue;
      if (ev.type === 'user/message') {
        if (kind !== undefined && kind !== 'user') continue;
        const cleaned = cleanUserEventText(text);
        if (cleaned) lines.unshift({ sender: '对方', text: cleaned, timestamp: 0 });
      } else {
        const cleaned = sanitizePseudoToolText(text).trim();
        if (cleaned && !cleaned.startsWith('💭')) lines.unshift({ text: cleaned, timestamp: 0 });
      }
    }
    return lines;
  } catch {
    return [];
  }
}

interface ModelInfoLlm {
  resolveModelInfo?(provider: string, model: string): Promise<{ context?: { contextWindow?: number } } | undefined>;
}

/** system-prompt section 最小结构（name/order/text） */
interface PromptSection {
  name: string;
  order: number;
  text: string;
}

/** system-prompt/assemble waterfall 的 context 最小结构 */
interface AssembleContext {
  agent?: DshAgent;
}

/** systemPrompt 服务的最小接口：注册动态 runtime context */
interface SystemPromptLike {
  context(entry: {
    name: string;
    order: number;
    required?: boolean;
    interpolate?: boolean;
    text: (context: AssembleContext) => string;
  }): unknown;
}

/** 排在宿主自己的 runtime context（最大 210）后面 */
const DND_STATE_CONTEXT_ORDER = 1000;
const STICKER_ADDITIONS_CONTEXT_ORDER = 1010;

const STICKER_CATALOG_SECTION = 'qqbot:sticker-catalog';

/** system-prompt/assemble 的组装产物最小结构 */
interface AssembledPrompt {
  sections?: PromptSection[];
  [key: string]: unknown;
}

const RECENT_SENDERS_MAX = 12;

function noteSender(record: SessionRecord, senderId: string): void {
  const list = record.recentSenders ?? [];
  list.push({ id: senderId, at: Date.now() });
  if (list.length > RECENT_SENDERS_MAX) list.splice(0, list.length - RECENT_SENDERS_MAX);
  record.recentSenders = list;
}

/** windowMs 内给这个会话发过消息的人 */
/** 宿主生成的 runtime-context 快照也是 user/message 事件，统计和导出时要和真正的用户消息分开 */
export function isRuntimeContextEvent(event: SessionEventLike): boolean {
  const body = (event.data ?? event.message ?? event) as { source?: { kind?: unknown } };
  return body.source?.kind === 'runtime-context';
}

/**
 * system prompt 里的锁什么时候换新：换会话或历史被替换（压缩）时前缀本来就要重算，顺带换成最新的。
 * 普通追加消息不改变它。
 */
export function promptEpoch(record: Pick<SessionRecord, 'agent'>): string {
  const session = record.agent.session;
  return `${session.id}:${session.surface?.contentGeneration ?? 0}`;
}

/**
 * 计算当前会话最新的真实用户发言轮次标识（忽略宿主的 runtime-context 与笔记召回消息）。
 * 同一轮工具循环（move → attack → attack → next）期间该标识恒定不变，用于锁定单轮内零重发团况快照。
 */
export function agentUserTurnTag(record: Pick<SessionRecord, 'agent'>): string | undefined {
  const session = record.agent?.session;
  if (session === undefined) return undefined;
  const events = session.snapshotEvents?.() ?? session.events;
  if (!Array.isArray(events)) return undefined;
  let userCount = 0;
  let lastTag = '0';
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.type !== 'user/message' || isRuntimeContextEvent(ev)) continue;
    const body = (ev.data ?? ev.message ?? ev) as { source?: { kind?: unknown }; message?: { source?: { kind?: unknown } } };
    const kind = body.message?.source?.kind ?? body.source?.kind;
    if (kind !== undefined && kind !== 'user') continue;
    userCount += 1;
    lastTag = String((ev as { seq?: unknown }).seq ?? i);
  }
  return `${promptEpoch(record)}#u${userCount}:${lastTag}`;
}

export interface DndStateThrottleOptions {
  gate?: DndSnapshotGate;
  intervalTurns?: number;
}

/** 这个 agent 所在会话的团况快照文字；不是 QQ 会话、战斗子代理（改由回合前增量注入）、没开团或读取失败都返回空串 */
export function dndStateText(
  agent: DshAgent | undefined,
  findRecord: (agent: DshAgent) => SessionRecord | undefined,
  dnd: (Pick<DndService, 'stateSnapshot'> & Partial<Pick<DndService, 'combatStateSnapshot' | 'snapshotStructuralKey' | 'snapshotForceSeq' | 'isExternallyDirty' | 'recordAgentToolSync'>>) | undefined,
  logger: Logger,
  isCombatChild?: (agent: DshAgent) => boolean,
  throttle?: DndStateThrottleOptions,
): string {
  if (agent === undefined || dnd === undefined) return '';
  if (isCombatChild?.(agent)) return '';
  const record = findRecord(agent);
  if (record === undefined) return '';
  try {
    const fresh = dnd.stateSnapshot(record.sessionKey);
    if (throttle?.gate === undefined) return fresh;
    const epoch = record.agent?.session !== undefined ? promptEpoch(record) : '';
    const turnTag = record.agent?.session !== undefined ? agentUserTurnTag(record) : undefined;
    const structKey = dnd.snapshotStructuralKey?.(record.sessionKey, epoch) ?? epoch;
    const forceSeq = dnd.snapshotForceSeq?.(record.sessionKey) ?? 0;
    const externallyDirty = dnd.isExternallyDirty?.(record.sessionKey, 'main', fresh) === true;
    const resolved = throttle.gate.resolve({
      agentKey: agent,
      fresh,
      ...(turnTag !== undefined ? { turnTag } : {}),
      epoch,
      structKey,
      forceSeq,
      externallyDirty,
      intervalTurns: throttle.intervalTurns ?? 4,
    });
    if (resolved === fresh && fresh !== '') dnd.recordAgentToolSync?.(record.sessionKey);
    return resolved;
  } catch (err) {
    logger.warn(`im-qqbot: 注入团况失败: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

export function recentSenderIds(record: SessionRecord, windowMs: number, now = Date.now()): string[] {
  return [...new Set((record.recentSenders ?? []).filter((s) => now - s.at <= windowMs).map((s) => s.id))];
}

function extractDefaultPersonaAliases(prompt: string | undefined): string[] {
  if (!prompt) return [];
  const match = /你是「([^」]{1,20})」/.exec(prompt);
  return match?.[1] ? [match[1].trim()] : [];
}

interface NoteQueryDeps {
  config: ImQQBotConfig;
  notesStore?: NotesStore;
  personaStore?: PersonaStore;
  toolAccess?: ToolAccess;
  dndService?: DndService;
  sessionKey(scope: ChatScope, peerId: string): string;
  getEffectiveModel?(scope: ChatScope, peerId: string): ModelRoute | undefined;
}

function buildNoteQueryContextFromDeps(
  deps: NoteQueryDeps,
  scope: ChatScope,
  peerId: string,
  options?: { record?: SessionRecord; agent?: DshAgent; sharedOnly?: boolean },
): NoteQueryContext {
  const key = deps.sessionKey(scope, peerId);
  const campaignRunning = options?.sharedOnly ?? (deps.dndService?.active(key) !== undefined);
  const scenes: NoteQueryContext['scenes'] = campaignRunning ? [scope, 'dnd'] : [scope];

  const activePersona = deps.personaStore?.current(peerId, scope);
  const fallbackDefault = deps.personaStore?.defaultPersona?.(scope);
  const defaultPrompt = fallbackDefault?.prompt
    ?? (scope === 'group' ? deps.config.groupPrompt : deps.config.directPrompt);
  const personas = activePersona !== undefined
    ? [activePersona.id, activePersona.name, ...activePersona.names]
    : [
        'default',
        '默认',
        ...(fallbackDefault?.names ?? []),
        ...(deps.config.replyDesire?.names ?? []),
        ...extractDefaultPersonaAliases(defaultPrompt),
      ];

  const sessionCwd = (options?.agent ?? options?.record?.agent)?.session?.header?.cwd;
  const workspaceRoot = deps.notesStore?.root ? dirname(deps.notesStore.root) : (deps.config.cwd || process.cwd());
  const projects = deriveProjectsFromCwd(sessionCwd, workspaceRoot);

  const owner = deps.config.ownerOpenid?.trim() ?? '';
  const isOwnerChat = scope === 'c2c' && owner !== '' && peerId === owner;
  const hasFullAccess = deps.toolAccess === undefined || deps.toolAccess.isFullAccess({ scope, peerId });
  const allowQueryProjectMatch = isOwnerChat || hasFullAccess;

  const route = deps.getEffectiveModel?.(scope, peerId)
    ?? options?.record?.agent?.session?.requestHeader?.()?.config
    ?? {
      provider: scope === 'group' ? (deps.config.groupProvider || deps.config.provider) : deps.config.provider,
      model: scope === 'group' ? (deps.config.groupModel || deps.config.model) : deps.config.model,
    };
  const models = [
    route?.provider,
    route?.model,
    route?.provider && route?.model ? `${route.provider}/${route.model}` : undefined,
  ].filter((v): v is string => typeof v === 'string' && v.trim() !== '');

  return {
    chatKey: chatKeyOf(scope, peerId),
    ...(options?.sharedOnly === undefined ? {} : { sharedOnly: options.sharedOnly }),
    ...(projects.length === 0 ? {} : { projects }),
    allowQueryProjectMatch,
    personas: [...new Set(personas.map((s) => s.trim()).filter(Boolean))],
    scenes,
    ...(models.length === 0 ? {} : { models }),
  };
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  /** 发送失败（常见于群主动消息无权限）的文本，等下一次用户消息时补发 */
  private unsent = new Map<string, string[]>();
  private skippedCalls = new Map<string, Set<string>>();
  /** /new 或 fork 后的旧 sessionId → 当前会话 key，用于旧定时任务/旧审批卡片继续路由 */
  private retiredSessionIds = new Map<string, string>();
  /** /new 或人设切换后待目标会话重建的定时任务（会话 key → 各旧 session 的任务批次） */
  private pendingScheduleMigrations = new Map<string, Array<{ oldSessionId: string; tasks: ScheduleMigrationTask[] }>>();
  /** 活动 agent → 宿主那套就地换模型的 selection（一个 agent 只装一次监听） */
  private readonly modelSelections = new Map<DshAgent, ModelSelectionRef>();
  /** provider/model → 上下文窗口（自动压缩阈值用；undefined = 查过但宿主没给） */
  private readonly contextWindows = new Map<string, number | undefined>();
  private readonly evictor: IdleEvictor;
  private readonly idleCompactTimer: ReturnType<typeof setInterval>;
  private readonly modelResolver: ModelResolver;
  private readonly ctx: Context;
  private readonly agents: DshAgentRegistry;
  private readonly config: ImQQBotConfig;
  private readonly logger: Logger;
  /** 由 bootstrap 注入的问答通道（ask_user_question → QQ），会话回收时清理其待答问题 */
  public questionChannel?: QuestionChannel;
  /** 由 bootstrap 注入的审批通道（approval/request → QQ），会话回收时清理其待批审批 */
  public approvalChannel?: ApprovalChannel;
  /** 由 bootstrap 注入的表情收藏存储（动态 prompt 清单） */
  public stickerStore?: StickerStore;
  /** 由 bootstrap 注入的共享笔记库（工具 + 自动召回） */
  public notesStore?: NotesStore;
  /** 笔记注入账本（只记录，不参与排序） */
  public noteMetrics?: NoteMetricsStore;
  /** 笔记相关性打分（llm 服务不可用时缺省，只记账不打分） */
  public noteJudge?: NoteJudge;
  private readonly pendingNoteInjections = new Map<string, PendingNoteInjection>();
  private readonly operationRecalls = new Map<string, RecallTurnState>();
  private readonly stagedNoteRecalls = new Map<string, StagedNoteRecall & { stagedAt: number }>();
  /** 会话 key → /new 时旧会话的压缩摘要（可能还在压缩）；新会话的第一条消息取走 */
  private readonly pendingHandoffs = new Map<string, Promise<string | undefined>>();
  /** 切换先完成落盘；期间到来的 QQ 消息等待，不得进入即将离开的人格历史。 */
  private personaTransitions = new Map<string, Promise<SwitchPersonaOutcome>>();
  private personaRoutes = new Map<string, ModelRoute>();
  /** `/dnd end` 原子停团并唤醒 DM 备团期间的并发锁与完成追踪 */
  private dndTransitions = new Map<string, Promise<EndDndSessionOutcome>>();
  private dndEndPreparing = new Map<string, { id: string; releaseLock: () => void }>();
  /** 多步关键事务/切换/待决交互期间阻止后台自动压缩与空闲压缩的锁表 */
  public contextLocks = new ContextLockManager();
  /** 正在进行手动/空闲/交接压缩的会话 key（防重入） */
  private activeCompactions?: Set<string> = new Set<string>();
  private disposing = false;
  /** 由 bootstrap 注入的工具权限（终端白名单） */
  public toolAccess?: ToolAccess;
  /** 由 bootstrap 注入的跑团服务（/dnd 命令 + DM prompt 注入） */
  public dndService?: DndService;
  public combatAgents?: DndCombatAgents;
  /** 按团的状态隐藏用不上的 dnd_* 工具（由 bootstrap 注入） */
  public dndToolScope?: DndToolScope;
  /** 按会话与权限范围隐藏确定不可用的非跑团工具（由 bootstrap 注入） */
  public sessionToolScope?: SessionToolScope;
  /** 一段对话内锁住的 system prompt 文字（表情清单、本群笔记目录），见 PromptLatch */
  private readonly promptLatch = new PromptLatch();
  /** 跑团团况 runtime-context 单轮锁定与跨轮次节流门控 */
  private readonly dndSnapshotGate = new DndSnapshotGate();
  /** 短时入站自动 steer 阶段跟踪器（与出站事件、流式帧同步） */
  public readonly turnSteer = new TurnSteerTracker();
  public mediaReview?: MediaReviewCoordinator;
  /** 由 bootstrap 注入的跑团按钮（/dnd start 发签到）；按钮关闭时为空 */
  public dndButtons?: DndTurnButtons;
  public personaStore?: PersonaStore;
  public personaSwitch?: PersonaSwitch;
  /** 由 bootstrap 探测到的 ffmpeg 绝对路径（配置的或 winget 目录里找到的；走 PATH 时为空），提示模型直接用 */
  public ffmpegPath?: string;

  constructor(
    ctx: Context,
    agents: DshAgentRegistry,
    config: ImQQBotConfig,
    logger: Logger,
  ) {
    this.ctx = ctx;
    this.agents = agents;
    this.config = config;
    this.logger = logger;
    this.modelResolver = new ModelResolver(ctx, config, logger);

    this.evictor = new IdleEvictor(
      this.sessions,
      config.sessionIdleTimeout,
      (key, record) => {
        if (this.personaTransitions.has(key)) return;
        this.logger.info(`evicting idle session: key=${key}`);
        this.sessions.delete(key);
        this.contextLocks?.clear(key);
        void this.combatAgents?.release(key);
        this.modelSelections.delete(record.agent);
        record.agent.cancel({ kind: 'user' });
        void record.handle.dispose().catch(() => {});
        // 回收会话时统一清理其待答问题/待批审批，避免 pending 悬挂泄漏
        this.questionChannel?.cancelPending(key);
        this.approvalChannel?.cancelPending(key);
      },
    );

    this.idleCompactTimer = setInterval(() => this.checkIdleCompact(), 60_000);
    this.idleCompactTimer.unref?.();

    this.registerScopePromptInjection();
    this.registerRuntimeContexts();
    this.registerVoiceReplyDelivery();
    this.registerOperationRecall();
    this.registerPreStepNotesRecall();
  }

  /** 语音后的文字继续生成，出站层改用独立静态消息，投递队列负责发送间隔。 */
  private registerVoiceReplyDelivery(): void {
    interface Execution {
      name: string;
      arguments: unknown;
      agent?: unknown;
      signal: AbortSignal;
    }
    interface Result {
      isError?: boolean;
      error?: unknown;
    }
    const handler = async (exec: Execution, next: () => Promise<Result>): Promise<Result> => {
      const record = exec.agent === undefined ? undefined : this.findByAgent(exec.agent as DshAgent);
      const args = exec.arguments as { file_path?: unknown; target?: unknown } | null;
      const voice = exec.name === 'qqbot_speak'
        || (exec.name === 'qqbot_send_file' && typeof args?.file_path === 'string' && isVoiceFile(args.file_path));
      const currentTarget = record === undefined ? undefined : `${record.replyTarget.scope}:${record.replyTarget.targetId}`;
      const sameChat = args?.target === undefined || args.target === '' || args.target === currentTarget;
      const result = await next();
      if (record === undefined || !voice || !sameChat || exec.signal.aborted || result.isError || result.error !== undefined) return result;
      record.voiceReplySentAt = Date.now();
      this.logger.info(`im-qqbot: 语音已送达，后续文字单独投递 key=${record.sessionKey}`);
      return result;
    };
    (this.ctx as unknown as {
      on(event: 'tools/execute', listener: typeof handler): void;
    }).on('tools/execute', handler);
    this.logger.info('im-qqbot: 语音后文字独立发送已启用（保留模型续写）');
  }

  /**
   * 通过 system-prompt/assemble waterfall 注入群聊/私聊额外 system prompt。
   *
   * 该事件在每次 turn 构建 request 时触发；此处按会话 scope（群聊/私聊）
   * 追加对应的额外 prompt section。会话尚未建立（首次 assemble）或未配置
   * 额外 prompt 时原样返回，不做改动。
   */
  private registerScopePromptInjection(): void {
    const assemble = async (
      _assembly: unknown,
      context: AssembleContext,
      next: () => Promise<AssembledPrompt>,
    ): Promise<AssembledPrompt> => {
      const assembled = await next();
      if (!context.agent) return assembled;

      const record = this.findByAgent(context.agent);
      if (!record) return assembled;
      if (this.combatAgents?.isChild(context.agent)) return assembled;

      const sections = [...(assembled.sections ?? [])];
      const prompt = this.personaStore?.current(record.peerId, record.scope)?.prompt
        ?? this.personaStore?.defaultPersona?.(record.scope)?.prompt
        ?? (record.scope === 'group' ? this.config.groupPrompt : this.config.directPrompt);
      if (prompt) {
        sections.push({ name: 'qqbot:scope-prompt', order: 90, text: prompt });
      }

      // 水群：模型看到一整屏历史时容易挨个点评，真人只会接触发自己的那一句。
      if (record.scope === 'group') {
        // 不解释标签的话，模型按昵称认人：重名、没昵称（只剩 openid 前缀）或多人合并时就会认错发言人
        sections.push({ name: 'qqbot:message-format', order: 91, text: GROUP_MESSAGE_FORMAT_PROMPT });
        sections.push({
          name: 'qqbot:group-focus',
          order: 91,
          text: [
            '【水群】',
            '你被 @ 或随机冒泡时，落点是 [Current message]，看清是冲谁说的。',
            '[Chat history] 是你扫到的背景，用来判断语境（在接谁的话、在聊什么）。可以顺着一两句往下接，但不用逐条回应，也别把整段群聊总结一遍。',
            '当前这句明确指向前面（「上面那张图」「刚才说的」、引用了某条消息）时，就回去看。',
            // 11-07 抽样：回复几乎都是「先把图/视频/对方的话讲一遍，再补一句点评」，每条都像在交读后感
            '回的是你的反应，不是对内容的讲解。群友发的话、图、视频、截图，大家都看得懂：不用复述里面写了什么、引原话、解释梗是什么意思，也不用先概括一遍再补一句点评。想说什么直接说那一下，可以是一个词、半句话、一个表情，也可以岔开说别的。',
            // 1aa3030e：「如何评价某大学/某老板/某说法」都回成了优缺点齐全、「值不值看情况」收尾的测评
            '有人问「如何评价」「你怎么看」「你觉得」，要的是你的态度，不是一份测评：先说站哪边、什么感觉，可以偏心、可以只说一个点、可以扯到自己或群友身上，也可以说不熟、没兴趣。不用把优缺点摆齐、分几层讲，也不用给「看情况」「看后续」这种两头都占的结论。对方想听细的会接着问。',
            '不是每条都要有个结论、都要评价一下。没人问你怎么看、你也没什么想说的，就只回一个「。」，这条不会发出去。',
            '一句话能回完就一句话；不知道对方指什么就直接问，别自己脑补一大段。',
          ].join('\n'),
        });
      }

      const epoch = promptEpoch(record);

      // 动态表情清单：表情库各群共用，清单在一段对话内锁住，新收藏的走 registerRuntimeContexts 的快照。
      if (this.stickerStore !== undefined) {
        try {
          sections.push(...this.stickerStore.promptSections().map((section) => (section.name === STICKER_CATALOG_SECTION
            ? { ...section, text: this.promptLatch.hold(`${record.sessionKey}|${section.name}`, epoch, section.text) }
            : section)));
        } catch (err) {
          this.logger.warn(`im-qqbot: 注入表情清单失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (this.toolAccess !== undefined && !this.toolAccess.isFullAccess({ scope: record.scope, peerId: record.peerId })) {
        sections.push({
          name: 'qqbot:tool-access',
          order: 91,
          text: [
            '【工具权限】',
            '本会话不在终端白名单里：没有 pwsh/bash/终端，不能派生子 agent；文件工具默认只能用在 bot 的媒体、表情和临时目录。若本群有跑团存档，可用 read/read_image/glob/grep 只读查阅当前模组目录用于 DM 备团（禁止修改、禁止用 qqbot_send_file 发给玩家）。被拦就直接告诉用户做不到，别换工具绕，也别说出本机路径。',
            '只有 bot 主人能把本群加入白名单：主人明确要求时调用 qqbot_access(capability="terminal", action="grant")，它会发确认按钮，主人点了才生效。',
          ].join('\n'),
        });
      }

      if (this.notesStore !== undefined) {
        sections.push({
          name: 'qqbot:shared-notes',
          order: 92,
          text: [
            '【共享笔记】',
            '你有一个带适用范围的长期记忆库。消息前出现「[共享笔记 · 可能相关]」时，会附带来源日期、适用范围、触发依据与冲突提醒；相关就自然用上，遇到过期或新旧冲突以更新证据为准，无关则忽略。',
            '想不起来时用 qqbot_notes(action="search") 查；保存时通用工程教训与写作偏好走默认共享，特定项目实验条件/代码约定传 projects，角色演绎设定传 personas/scenes，本群私事传 scope="chat"；推翻旧结论传 supersedes 关联旧记录（别记隐私和闲聊）。',
            '跑团进度、物品、任务线头和待办用 dnd_progress 写进团档，不写笔记；进度以 dnd_* 工具查到的为准。DC、怪物数值、DM 笔记、没揭示的东西任何时候都不写进笔记。',
            '记笔记是你自己的事，不用每次都告诉用户「我记下了」。',
            '另外有一本《人类观察日记》，所有群和私聊共用：遇到人类的回复和你预测的不一样，就往里追加一条，用 qqbot_notes(action="save", file="人类观察日记.md")，格式固定「预测 / 实际 / 差在哪」，编号取文末最后一个 +1。只记判断失误，不记流水账。',
          ].join('\n'),
        });
      }

      // 跑团：开团的会话每回合注入 DM 守则和不常变的背景；会变的团况走 registerDndStateContext
      if (this.dndService !== undefined) {
        try {
          const toolView = this.combatAgents?.toolView(record) ?? 'full';
          const dndSections = this.dndService.promptSections(record.sessionKey, epoch, toolView !== 'full');
          sections.push(...dndSections);
          // 开团时本群笔记不走自动注入（见 notesHint），这里只列个目录，玩的时候要用的约定让模型自己去查
          const titles = dndSections.some((s) => s.name === 'qqbot:dnd-dm') ? this.notesStore?.chatNoteTitles(chatKeyOf(record.scope, record.peerId)) ?? [] : [];
          if (titles.length > 0) {
            sections.push({
              name: 'qqbot:dnd-chat-notes',
              order: 98,
              text: this.promptLatch.hold(`${record.sessionKey}|qqbot:dnd-chat-notes`, epoch, `本群笔记（开团期间不自动注入，需要时用 qqbot_notes(action="search") 查，进度以【团况】为准）：${titles.join('；')}`),
            });
          }
        } catch (err) {
          this.logger.warn(`im-qqbot: 注入跑团守则失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 临时文件集中放 tmp/：不提示的话模型会把脚本、截图、抽帧直接写在工作目录根下
      const tmpDir = resolveTmpDir(this.config);
      const ttl = this.config.tmpTtlHours ?? 72;
      sections.push({
        name: 'qqbot:tmp-dir',
        order: 95,
        text: [
          '【临时文件】',
          `临时文件一律写到 ${tmpDir} 下（一次性脚本、截图、抽帧、下载的素材、pip/npm 依赖、转写音频等），按任务建子目录，例如 ${join(tmpDir, 'asr-video')}。不要写在工作目录 ${this.config.cwd || process.cwd()} 的根下。`,
          '定时任务每次运行用的脚本和下载的图片也是临时文件，同样写进临时目录，不要每次在别处另存一份新脚本；只有需要跨次保留的状态（已发记录、游标、日志）才写到固定的状态文件里（json/log/txt/md）。',
          ttl > 0
            ? `${tmpDir} 里 ${ttl} 小时没动过的东西会被自动清理；要长期保留的成果（用户要的文件、笔记）放到用户指定的位置，或用 qqbot_notes(action="save") 记进笔记。`
            : '要长期保留的成果（用户要的文件、笔记）放到用户指定的位置，或用 qqbot_notes(action="save") 记进笔记。',
          ...(this.ffmpegPath !== undefined
            ? [`本机有 ffmpeg/ffprobe：${this.ffmpegPath}（同目录还有 ffprobe），终端里直接用这个路径，不用再找或重装。`]
            : []),
        ].join('\n'),
      });

      // 配文只放短回应；完整解释另发，避免动态提示把人设的两句上限覆盖掉。
      sections.push({
        name: 'qqbot:media-caption',
        order: 93,
        text: [
          '【发图配文】',
          '用 qqbot_send_file 发图片/视频/文件并配文字时，整段配文放进 caption，但不超过两句、不换行、不放列表；要讲道理另发一条纯文字。caption 会和媒体同一条消息发出，不要再单独复述这段配文。',
          '发完没别的要说，就只回一个「。」收尾：只有标点的回复不会发出去。不要什么都不输出，完全空的回复会被当成出错。',
          '不发媒体也不发语音时正常文字回复。语音不支持 caption，按下面的语音规则处理。',
          '【语音单独发送】',
          '通过 qqbot_speak 或 qqbot_send_file 发送语音时：' + VOICE_REPLY_REMINDER,
        ].join('\n'),
      });

      if (this.config.speak?.enabled !== false) {
        sections.push({
          name: 'qqbot:voice-routing',
          order: 93,
          text: [
            '【语音出声（qqbot_speak）】',
            '你有自己的嗓子（qqbot_speak，自动匹配当前人设音色）。遇到下面这些要你「真出声」的话，调用 qqbot_speak 发语音条，别只打一行拟声词或把原文打字抄一遍交差：',
            '1. 点名听语音/开麦：「发语音」「来条语音」「语音回我」「说句话听听」「想听你声音」「用你的声音说」「开麦」「出个声」。',
            '2. 声音动作与情绪发声：「大喊一声…」「喊一句…」「吼一声…」「叫一声…（如叫姐姐/喵一声/汪一声）」「叹口气听听」「笑一声」「撒个娇/哄我一句/骂我两句听听」「学…说话」「给这句配音」。',
            '3. 朗读与口头念白：「念一下…」「把这段念出来」「读出来」「朗读…」「背一段…听听」「用语音讲个故事/念段台词」。',
            '4. 语音闲聊互动：对方发语音条（`[Voice message]`）闲聊且内容简短时，也可视气氛用 qqbot_speak 语音回接。',
            '参数与边界：',
            '- `text` 只放要亲口念出口的词句和语气词（大喊可用感叹号、破折号拖长音，如「喂——！听见没有！」）；绝不要在 `text` 里写「（大声喊）」「*深吸一口气*」「[大喊]」等括号/星号动作描写，否则 TTS 会把动作说明当台词念出来。语气提示可填进单行的 `style`（不带括号与特殊符号）。',
            '- QQ 会话里省略 `role`（系统按当前人设自动选音色）。代码、命令、链接、报错或需要复制的文本不要塞进语音，留给文字发。',
            '- 区分点歌：说话、喊叫、念白、朗读、清口念词都走 `qqbot_speak`；只有用户明确点歌翻唱整首曲子（提供歌曲文件或链接走 RVC）才用 `qqbot_sing`。',
            '- 用户没让你出声/念/喊时，日常问答、查资料、写代码默认打字，偶尔气氛特别合适再随口发一句短语音，别每轮刷屏。发完语音若没别的话要补充，只回一个「。」收尾，不要把语音里的词再原样打字复读一遍。',
          ].join('\n'),
        });
      }

      sections.push({
        name: 'qqbot:image-routing',
        order: 94,
        text: [
          '【图片路由】',
          '用户发图时：',
          '1. 想用表情回应用户发的图时，从库里挑；已有「[本地表情库]」命中提示时，用它判断情绪，不必重复识别。',
          '2. 用户问“这是谁 / 出自哪 / 什么动漫”时，先查本地表情库与梗库；查不到就如实说认不出，不要硬认。',
          '3. 用户问“什么梗 / 表情包 / 怎么回”时，调用 skill 加载 meme-recognition。',
          '4. 用户只是分享内容时，不必强行识别，也不用每张都评：有感觉就接一句，没有就当没看见。历史里的旧图只在当前这句问到时才看。',
          '不要只凭肉眼断言角色或梗；需要外部检索时走对应 skill。',
        ].join('\n'),
      });

      // 视频意图：不提示的话模型拿到字幕/转写就整段复述，群友只是分享时也会收到一份「解读报告」
      sections.push({
        name: 'qqbot:video-intent',
        order: 94,
        text: [
          '【视频：先分清是要解读还是随口聊】',
          '有人发视频、B 站卡片/链接，或让你看某个视频时，先判断他要哪种回应，再决定看多少、说多少：',
          '1. 反应（默认）：只是分享、只 @ 你、「看看」「你觉得呢」「好笑吗」。像群友看完随口回一句：笑了、无语、想起群里谁，一两句就够。不复述剧情、不引台词、不点评拍得怎么样，不报 UP 主/播放量/时长，不搬评论区，不翻译全文。',
          '2. 解读：明确说「讲了啥」「总结」「解读」「翻译」「转写」「细说」。按要点讲清楚，结论放前面，不逐句复述。',
          '3. 具体问题：问什么答什么，视频内容只当依据；一条消息里有几问，就按顺序逐个答完。',
          '4. 问能力：「你能看视频吗」「能转写吗」，先回答能不能；能看就顺手看了，按第 1 条回，别借机把内容整段讲一遍。',
          '5. 让你自己挑、「喜欢就细品」：说你挑了哪条、喜欢哪儿、为什么，用你自己的口味说话，别交调研报告，也别把字幕整理成文件当作回答。',
          '拿不准就按「反应」处理，说短一点，对方想听细节会追问。字幕、转写、抽帧描述都是你看片的素材，不是要原样转述的稿子。',
        ].join('\n'),
      });

      if (sections.length === (assembled.sections?.length ?? 0)) return assembled;
      return { ...assembled, sections };
    };

    (this.ctx as unknown as {
      on(event: 'system-prompt/assemble', handler: typeof assemble): void;
    }).on('system-prompt/assemble', assemble);
  }

  /**
   * 会变的内容注册成 runtime-context 快照，而不是 system prompt 的 section：放在 system prompt 里时，
   * 每次扣血、推进回合、别的群收藏表情都让后面整段历史失去缓存。
   * required：宿主关掉可选 runtime context 时也要留着，否则模型既看不到团况，也看不到新表情。
   */
  private registerRuntimeContexts(): void {
    (this.ctx as unknown as {
      inject?(deps: string[], callback: (scope: { systemPrompt: SystemPromptLike }) => void): void;
    }).inject?.(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'qqbot:dnd-state',
        order: DND_STATE_CONTEXT_ORDER,
        required: true,
        interpolate: false,
        text: (context) => dndStateText(
          context.agent,
          (agent) => this.findByAgent(agent),
          this.dndService,
          this.logger,
          (agent) => Boolean(this.combatAgents?.isCombatAgent(agent)),
          {
            gate: this.dndSnapshotGate,
            intervalTurns: this.config.dnd?.snapshotIntervalTurns ?? 4,
          },
        ),
      });
      scope.systemPrompt.context({
        name: 'qqbot:sticker-additions',
        order: STICKER_ADDITIONS_CONTEXT_ORDER,
        required: true,
        interpolate: false,
        text: (context) => {
          if (context.agent !== undefined && this.combatAgents?.isCombatAgent(context.agent)) return '';
          const record = context.agent === undefined ? undefined : this.findByAgent(context.agent);
          const catalog = record === undefined ? undefined : this.promptLatch.peek(`${record.sessionKey}|${STICKER_CATALOG_SECTION}`);
          return catalog === undefined ? '' : this.stickerStore?.catalogAdditions(catalog) ?? '';
        },
      });
    });
  }

  /**
   * 动态获取 agentPresets 服务（可选，未注入时返回 undefined）
   */
  private getPresetsService(): AgentPresetsLike | undefined {
    try {
      return this.ctx.get('agentPresets') as AgentPresetsLike | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 从 session 持久化 header 读 session 当初的 preset（started 锁定语义）。
   * 读不到（服务缺失 / session 不存在 / 未记录 agentPreset）返回 undefined。
   */
  private async resolvePersistedPreset(sessionId: string): Promise<string | undefined> {
    let persistence: { load(id: string): Promise<{ meta?: { agentPreset?: string } }> } | undefined;
    try {
      persistence = this.ctx.get('sessionPersistence') as typeof persistence | undefined;
    } catch {
      return undefined;
    }
    if (!persistence) return undefined;
    try {
      const { meta } = await persistence.load(sessionId);
      return meta?.agentPreset;
    } catch {
      return undefined;
    }
  }

  // ── 模型相关（委托给 ModelResolver） ──

  getEffectiveModel(scope: ChatScope, peerId: string): ModelRoute | undefined {
    return this.modelResolver.getEffectiveRoute(this.sessionKey(scope, peerId));
  }

  /**
   * 获取指定 peer 的生效 preset（per-peer 覆盖 > config.preset）
   */
  getEffectivePreset(scope: ChatScope, peerId: string): string | undefined {
    return this.getEffectivePresetByKey(this.sessionKey(scope, peerId));
  }

  /** 按 sessionKey 解析生效 preset */
  private getEffectivePresetByKey(key: string): string | undefined {
    return this.modelResolver.getPreset(key) ?? this.config.preset;
  }

  /**
   * 列出所有可用 preset（/preset 命令用）
   */
  async listPresets(): Promise<PresetEntry[]> {
    const presets = this.getPresetsService();
    if (!presets) return [];
    try {
      const list = await presets.list();
      return list.map((p) => ({ id: p.id, name: p.name, description: p.description }));
    } catch (err) {
      this.logger.warn(`list presets failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 切换模型（就地换路由，不重建会话，历史/定时任务都不动）
   *
   * 原来走的是 fork 一个新会话再切过去的办法：0.2.x 的 sessions.fork() 语义变了，
   * 它直接创建子会话、返回 Session，而这里按老签名取 `.events` 拿到 undefined，
   * 于是每次都在 `seed.length` 上抛 TypeError（日志里那句
   * `handler "model" threw: Cannot read properties of undefined (reading 'length')`）。
   * 现在改用宿主 GUI 同一套机制：installModelSelection + model/selection 事件，
   * 宿主在 prompt 组装时快照选择、在 agent/request 里替换 provider/model，
   * 所以下一条请求生效，跑到一半的那一步不受影响。
   */
  async setModelOverride(scope: ChatScope, peerId: string, route: ModelRoute): Promise<boolean> {
    const key = this.sessionKey(scope, peerId);

    this.modelResolver.setOverride(key, route);

    const record = this.sessions.get(key);
    if (!record) {
      this.logger.info(`model pref saved (no active session): key=${key} → ${route.provider}/${route.model}`);
      return true;
    }

    this.applyModelSelection(record, route);
    this.logger.info(
      `model switched in place: key=${key} → ${route.provider}/${route.model}`
      + (record.agent.status === 'idle' ? '' : '（这一轮跑完生效）'),
    );
    return true;
  }

  /**
   * 和 Web 共用活动 agent 的 selection；无 Web 控制器时才安装本地选择器。
   * 兼容旧宿主的本地选择器在 agent dispose 时随 ctx 一起销毁。
   */
  private applyModelSelection(record: SessionRecord, route: ModelRoute | undefined): void {
    // Web 已为同一个 agent 安装选择器；再安装一套会让 notice 与最终路由分离。
    // 不调用 selectModel：它还会保存全局默认，QQ 的 per-chat 切换不应改全局。
    const controller = this.ctx?.get('sessionController') as {
      agents?: { selectionFor?: (agent: DshAgent) => ModelSelectionRef };
    } | undefined;
    let selection = controller?.agents?.selectionFor?.(record.agent)
      ?? this.modelSelections.get(record.agent);
    if (selection === undefined) {
      selection = { current: undefined, assembled: undefined };
      this.modelSelections.set(record.agent, selection);
      installModelSelection(record.agent.ctx, selection);
    }
    selection.current = route;
    if (route !== undefined) {
      // 记进会话日志：重启 resume / web GUI 打开同一个会话时据此显示当前路由
      record.agent.session.append?.('model/selection', { ...route });
    }
  }

  /**
   * 把 per-chat 的显式模型偏好装到刚拿到手的会话上。
   *
   * 为什么需要：会话已经在宿主里活着时（web GUI 先打开、或别的路径 resume 过），
   * getOrCreate 走的是「reusing live agent」，那条路既不装 selection 也不看偏好，
   * 于是 `/model hapi gpt-6.1-sol` 明明存进了 model-prefs.json，请求还在跑宿主默认。
   * 只在有显式偏好（/model 写过 或 全局故障转移）时同步：没有偏好就别去盖
   * 用户在 GUI 里手选的模型；当前头部已经是这条路由时也不重复写事件。
   */
  private syncExplicitRoute(record: SessionRecord): void {
    const explicit = this.modelResolver.getExplicitRoute(record.sessionKey);
    if (!explicit) return;
    const current = record.agent.session.requestHeader?.()?.config;
    if (current?.provider === explicit.provider && current.model === explicit.model) return;
    this.applyModelSelection(record, explicit);
    this.logger.info(
      `model route synced from prefs: key=${record.sessionKey} → ${explicit.provider}/${explicit.model}`,
    );
  }

  /**
   * 清掉这个会话的模型覆盖，回到配置默认路由。
   *
   * `/model a/b` 写进去的是 per-chat 覆盖，优先级高于配置——写过一次就再也回不到默认，
   * 而且它跟 sessionId 无关，换多少个新会话都跟着走。所以必须有一个反向操作。
   */
  async clearModelOverride(scope: ChatScope, peerId: string): Promise<ModelRoute | undefined> {
    const key = this.sessionKey(scope, peerId);
    const had = this.modelResolver.clearOverride(key);
    const route = this.modelResolver.getEffectiveRoute(key);
    const record = this.sessions.get(key);
    if (!had) {
      this.logger.info("model override 本来就没有: key=" + key);
      return route;
    }
    // route 是清掉覆盖之后的生效路由（下一步的默认/故障转移）；undefined 只会出现在
    // 配置和宿主都没给默认路由的情况下，那就保持 agent 现有的路由不动。
    if (record) this.applyModelSelection(record, route);
    const label = route === undefined ? "宿主默认" : route.provider + "/" + route.model;
    this.logger.info("model override 已清除: key=" + key + " -> " + label);
    return route;
  }

  /**
   * 切换指定 peer 的 agent preset（per-peer 覆盖）
   *
   * 已开始的会话保持锁定（blank-session contract）：只持久化为新会话默认，
   * 不 fork/rebuild 当前会话，避免历史工具调用与新 preset 工具集冲突。
   */
  async setPresetOverride(scope: ChatScope, peerId: string, presetId: string): Promise<PresetSwitchOutcome> {
    const key = this.sessionKey(scope, peerId);

    // 1. 校验 preset 存在 + 可加载（broken 拒绝）
    const presets = this.getPresetsService();
    if (!presets) return { ok: false, reason: 'unavailable' };
    let resolved: { id: string; broken?: string };
    try {
      resolved = await presets.resolve(presetId);
    } catch (err) {
      return { ok: false, reason: 'unknown-preset', message: err instanceof Error ? err.message : String(err) };
    }
    if (resolved.broken !== undefined) {
      return { ok: false, reason: 'broken', message: resolved.broken };
    }

    // 2. 持久化 per-peer 覆盖（新会话生效）
    this.modelResolver.setPreset(key, presetId);

    const hasActive = this.sessions.has(key);
    this.logger.info(
      `preset pref saved: key=${key} → ${presetId}${hasActive ? ' (active session locked, next session applies)' : ''}`,
    );
    return { ok: true, presetId };
  }

  /**
   * 清除 per-peer preset 覆盖，回到 config.preset / 默认（新会话生效）
   */
  async clearPresetOverride(scope: ChatScope, peerId: string): Promise<PresetSwitchOutcome> {
    const key = this.sessionKey(scope, peerId);
    this.modelResolver.clearPreset(key);
    this.logger.info(`preset pref cleared: key=${key} (next session applies)`);
    return { ok: true };
  }

  /**
   * 全局切换：所有会话一起走新路由（上游切源用）。
   *
   * 写的是「全局故障转移」这一格，不是逐个会话的 override——因为 override 的语义是
   * 「这个人自己选的」，一旦被切源写进去就永远压着配置默认，恢复时还得逐个追平。
   * 现在切源只碰全局那格，恢复时清掉就回到配置默认。
   */
  async switchAllSessions(route: ModelRoute): Promise<number> {
    this.modelResolver.setFailover(route);
    const records = [...this.sessions.values()];
    let switched = 0;
    let busy = 0;
    for (const record of records) {
      // 自己手动 /model 过的会话保留原选择，别被自动切源拽走
      if (this.modelResolver.hasOverride(record.sessionKey)) continue;
      // 正在跑的这一轮别中途换：主用降级时通常是「请求卡住」，这时换路由会把
      // 半截回答搅在一起。下一轮 tick（5 分钟后）会再来一次，那时多半已经空闲。
      if (record.agent.status !== 'idle') {
        busy += 1;
        continue;
      }
      try {
        this.applyModelSelection(record, route);
        switched += 1;
      } catch (err) {
        this.logger.warn(`switchAllSessions 换路由失败: key=${record.sessionKey} err=${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.info(
      `switchAllSessions: ${switched}/${records.length} 个会话 → ${route.provider}/${route.model}` +
      (busy > 0 ? `，${busy} 个正在跑、留到下次` : ''),
    );
    return switched;
  }

  /** 清掉全局故障转移，所有会话回到配置默认路由 */
  async clearFailoverRoute(): Promise<number> {
    const had = this.modelResolver.clearFailover();
    const records = [...this.sessions.values()];
    if (had) {
      for (const record of records) {
        if (this.modelResolver.hasOverride(record.sessionKey)) continue;
        if (record.agent.status !== 'idle') continue;
        // 每个会话按自己的 scope 取默认：群聊和私聊用的是不同档
        const route = this.modelResolver.resolveDefault(record.scope);
        try {
          this.applyModelSelection(record, route);
        } catch (err) {
          this.logger.warn(`clearFailoverRoute 换路由失败: key=${record.sessionKey} err=${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    this.logger.info(`clearFailoverRoute: ${had ? '已清除' : '本来就没有'}，${records.length} 个会话回到各自的默认路由`);
    return records.length;
  }

  getFailoverRoute(): ModelRoute | undefined {
    return this.modelResolver.getFailover();
  }
  async listAvailableModels(): Promise<ModelEntry[]> {
    return this.modelResolver.listModels();
  }

  listProviders(): string[] {
    return this.modelResolver.listProviders();
  }

  // ── 会话状态 / 统计 ──

  getSessionRecord(scope: ChatScope, peerId: string): SessionRecord | undefined {
    const key = this.sessionKey(scope, peerId);
    return this.combatAgents?.current(key) ?? this.sessions.get(key);
  }

  /** 仅 QQ 入站和跑团按钮走战斗路由，普通 /model 等设置仍作用于主会话。 */
  async routeDndRecord(record: SessionRecord): Promise<SessionRecord> {
    const main = this.sessions.get(record.sessionKey) ?? record;
    return this.combatAgents?.select(main) ?? main;
  }

  async sendDndFollowup(record: SessionRecord, message: unknown): Promise<void> {
    const main = this.sessions.get(record.sessionKey);
    if (main !== undefined) main.lastActivity = Date.now();
    const target = await this.routeDndRecord(record);
    const decorated = this.combatAgents?.decorateFollowupMessage(target, message) ?? message;
    target.agent.followup(decorated);
    await target.agent.whenIdle();
  }

  /** 入站图片本地表情库精确匹配（失败/未启用时返回 undefined，不阻塞消息） */
  matchSticker(path: string): StickerMatchResult | undefined {
    try {
      return this.stickerStore?.match(path);
    } catch {
      return undefined;
    }
  }

  /** 构造当前会话的笔记检索范围上下文 */
  buildNoteQueryContext(
    scope: ChatScope,
    peerId: string,
    options?: { record?: SessionRecord; agent?: DshAgent; sharedOnly?: boolean },
  ): NoteQueryContext {
    const key = this.sessionKey(scope, peerId);
    const record = options?.record ?? this.sessions?.get(key);
    return buildNoteQueryContextFromDeps({
      config: this.config,
      notesStore: this.notesStore,
      personaStore: this.personaStore,
      toolAccess: this.toolAccess,
      dndService: this.dndService,
      sessionKey: (s, p) => this.sessionKey(s, p),
      getEffectiveModel: this.getEffectiveModel ? (s, p) => this.getEffectiveModel(s, p) : undefined,
    }, scope, peerId, { ...options, record });
  }

  /** 暂存一条入站消息的笔记召回参数，等待 agent/pre-step 进入模型步骤时检索并独立注入 */
  stageNoteRecall(messageId: string, spec: StagedNoteRecall): void {
    const now = Date.now();
    const map = this.ensureStagedNoteRecalls();
    for (const [id, entry] of map) {
      if (now - entry.stagedAt > NOTE_INJECTION_TTL_MS) map.delete(id);
    }
    if (!messageId || (spec.query.trim() === '' && spec.operations.length === 0)) return;
    map.set(messageId, { ...spec, stagedAt: now });
  }

  /** 提交前取消或失败时撤销已暂存的笔记召回 */
  unstageNoteRecall(messageId: string): void {
    if (!messageId) return;
    this.ensureStagedNoteRecalls().delete(messageId);
  }

  private ensureStagedNoteRecalls(): Map<string, StagedNoteRecall & { stagedAt: number }> {
    const self = this as unknown as { stagedNoteRecalls?: Map<string, StagedNoteRecall & { stagedAt: number }> };
    self.stagedNoteRecalls ??= new Map();
    return self.stagedNoteRecalls;
  }

  /** All recall routes share scope checks, revision dedup and a turn-wide rendered-character budget. */
  async notesHint(query: string, scope: ChatScope, peerId: string, messageId?: string, preservePending = false,
    operations: readonly string[] = [], signal?: AbortSignal): Promise<string> {
    const key = this.sessionKey(scope, peerId);
    if (!preservePending || !this.operationRecalls.has(key)) {
      this.operationRecalls.set(key, new RecallTurnState(query, operations));
      this.pendingNoteInjections.delete(key);
    }
    const state = this.operationRecalls.get(key)!;
    const operationQuery = [query, operationQueryTerms(operations)].filter(Boolean).join('\n');
    return this.recallAtOperation(operationQuery, operations, scope, peerId, state, messageId, signal, operations.length && state.usedChars === 0 ? 0.6 : 1);
  }

  private async recallAtOperation(query: string, operations: readonly string[], scope: ChatScope, peerId: string,
    state: RecallTurnState, messageId?: string, signal?: AbortSignal, budgetFraction = 1): Promise<string> {
    const key = this.sessionKey(scope, peerId);
    const notes = this.config.notes;
    if (!this.notesStore || !notes?.autoInject || (!query.trim() && !operations.length)) return '';
    if (this.config.dnd?.combatAgent?.enabled && this.dndService?.active(key)?.campaign.initiative) return '';
    return state.serialize(async () => {
      if (signal?.aborted || this.operationRecalls.get(key) !== state || Date.now() - state.createdAt > NOTE_INJECTION_TTL_MS) return '';
      const maxChars = scope === 'group' && (notes.groupInjectMaxChars ?? 0) > 0 ? notes.groupInjectMaxChars! : notes.injectMaxChars;
      const remaining = Math.floor(maxChars * budgetFraction) - state.usedChars;
      if (remaining <= 0) return '';
      const campaignRunning = this.dndService?.active(key) !== undefined;
      const context = this.buildNoteQueryContext(scope, peerId, { sharedOnly: campaignRunning });
      const { chatKey, ...rest } = context;
      let found: NoteHit[] | undefined;
      try {
        found = await boundedRecall(this.notesStore!.searchHybrid(query, notes.injectTopK * 4, chatKey,
          { ...rest, operations: [...operations], allowQueryProjectMatch: false }), 1200, signal);
      } catch {
        this.logger.debug('im-qqbot: operation recall unavailable; continuing without notes');
        return '';
      }
      if (!found || signal?.aborted || this.operationRecalls.get(key) !== state) return '';
      const hits = found.filter(hit => !this.noteMuted(hit.file, hit.heading) && !state.seen.has(noteRevisionKey(hit)));
      const plan = planNoteInjection(hits, { topK: notes.injectTopK, maxChars: remaining,
        perNoteMaxChars: notes.injectPerNoteChars ?? 0, minCoverage: notes.injectMinCoverage, query });
      if (!plan.items.length || !plan.text) return '';
      state.usedChars += plan.text.length;
      for (const item of plan.items) state.seen.add(noteRevisionKey(item.hit));
      const pending = this.pendingNoteInjections.get(key);
      const contextLines = scope === 'group' ? collectJudgeLines(this.config, peerId, messageId, { includeCurrent: false }) : undefined;
      this.pendingNoteInjections.set(key, { query: pending?.query ?? query, at: pending?.at ?? Date.now(), campaignRunning,
        hits: [...(pending?.hits ?? []), ...plan.items.map(item => item.hit)],
        snippets: [...(pending?.snippets ?? []), ...plan.items.map(item => item.snippet)],
        ...(pending?.contextLines ? { contextLines: pending.contextLines } : contextLines?.length ? { contextLines } : {}) });
      return plan.text;
    });
  }

  private registerOperationRecall(): void {
    interface Exec { name: string; callId?: string; agent?: unknown; signal: AbortSignal }
    interface Result { isError?: boolean; value?: unknown; error?: unknown }
    interface Decision { kind: string; additionalContexts?: unknown[]; [key: string]: unknown }
    const handler = async (exec: Exec, result: Result, next: () => Promise<Decision>): Promise<Decision> => {
      const decision = await next();
      const record = exec.agent ? this.findByAgent(exec.agent as DshAgent) : undefined;
      if (!record || exec.signal.aborted || decision.kind === 'block') return decision;
      const effectiveResult = Object.prototype.hasOwnProperty.call(decision, 'value')
        ? { ...result, value: decision.value }
        : Object.prototype.hasOwnProperty.call(decision, 'content') ? { ...result, value: undefined } : result;
      const evidence = toolOperationEvidence(exec.name, effectiveResult);
      if (!evidence) return decision;
      this.mediaReview?.observe(record.agent, evidence);
      const state = this.operationRecalls.get(record.sessionKey);
      if (!state) return decision;
      const eventKey = exec.callId ?? randomUUID();
      if (state.events.has(eventKey) || state.events.size >= 16) return decision;
      state.events.add(eventKey);
      const hint = await this.recallAtOperation([state.query, evidence.query].filter(Boolean).join('\n'), evidence.operations,
        record.scope, record.peerId, state, undefined, exec.signal);
      if (exec.signal.aborted || this.operationRecalls.get(record.sessionKey) !== state) return decision;
      const factsBudget = Math.max(0, 1200 - state.factChars);
      const facts = `[媒体操作结果 · 执行事实]\n${evidence.facts.join('；')}\n`.slice(0, Math.min(220, factsBudget));
      state.factChars += facts.length;
      if (!facts && !hint) return decision;
      const contextMessage = hint
        ? createNotesRecallMessage(facts + hint, summarizeNotesHint(hint))
        : createUserMessage({ content: [{ type: 'text', text: facts }], source: QQBOT_MESSAGE_SOURCE });
      return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), contextMessage] };
    };
    (this.ctx as unknown as { on(event: 'tools/post-execute', listener: typeof handler, options?: { global: boolean }): void }).on('tools/post-execute', handler, { global: true });
  }

  /**
   * 在 agent/pre-step 进入模型步骤时按入站消息 ID 消费暂存召回，并以独立 `qqbot-notes-recall`
   * 上下文消息插在对应用户消息之前，不再污染 `user/message` 正文。
   */
  private registerPreStepNotesRecall(): void {
    interface StepMessage {
      id?: string;
      [key: string]: unknown;
    }
    interface PreStepPayload {
      agent?: unknown;
      signal: AbortSignal;
      messages?: StepMessage[];
    }
    interface PreStepDecision {
      kind: string;
      messages?: StepMessage[];
      [key: string]: unknown;
    }
    const on = (this.ctx as unknown as {
      on?: (
        event: 'agent/pre-step',
        listener: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>,
        options?: { global: boolean },
      ) => void;
    }).on;
    if (typeof on !== 'function') return;

    const handler = async (payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
      const decision = await next();
      if (decision.kind === 'reject' || payload.signal.aborted || !Array.isArray(decision.messages) || decision.messages.length === 0) {
        return decision;
      }
      const record = payload.agent ? this.findByAgent(payload.agent as DshAgent) : undefined;
      if (!record) return decision;

      const map = this.ensureStagedNoteRecalls();
      let changed = false;
      const nextMessages: StepMessage[] = [];
      for (const msg of decision.messages) {
        const msgId = typeof msg.id === 'string' ? msg.id : '';
        const spec = msgId ? map.get(msgId) : undefined;
        if (spec !== undefined) {
          map.delete(msgId);
          if (Date.now() - spec.stagedAt <= NOTE_INJECTION_TTL_MS) {
            const hint = await this.notesHint(
              spec.query,
              spec.scope,
              spec.peerId,
              spec.messageId,
              spec.steered,
              spec.operations,
              payload.signal,
            );
            if (payload.signal.aborted) return decision;
            if (hint) {
              nextMessages.push(createNotesRecallMessage(hint, summarizeNotesHint(hint)) as unknown as StepMessage);
              changed = true;
            }
          }
        }
        nextMessages.push(msg);
      }
      return changed ? { ...decision, messages: nextMessages } : decision;
    };

    on.call(this.ctx, 'agent/pre-step', handler, { global: true });
  }

  /** 账本概览保留历史；只让低分清单跟随当前索引和静音策略。 */
  public noteStats(view: NoteStatsView, limit: number): string | undefined {
    if (this.noteMetrics === undefined) return undefined;
    const rows = this.noteMetrics.summary(Number.POSITIVE_INFINITY);
    const notes = this.config.notes;
    const canInject = notes?.autoInject === true && notes.injectTopK > 0
      && (notes.injectMaxChars > 0 || (notes.groupInjectMaxChars ?? 0) > 0);
    const lowRows = view === 'low' && canInject
      ? (this.notesStore?.filterAutoInjectableSections(rows) ?? []).filter((row) => !this.noteMuted(row.file, row.heading, false))
      : [];
    return renderNoteStats(rows, view, limit, notes?.judge?.enabled === true, lowRows);
  }

  /** 笔记文件改过后旧自动静音失效；只在真正召回时更新账本，查看榜单不修改历史。 */
  private noteMuted(file: string, heading: string, clearExpired = true): boolean {
    if (this.noteMetrics === undefined || this.notesStore === undefined) return false;
    // 主人手动静音的不看打分开关，也不因为文件改过就自动恢复：那是明确说过「别再注入」
    if (this.noteMetrics.mutedManually(file, heading)) return true;
    const judge = this.config.notes?.judge;
    // muteBelow 调回 0 就是打分静音的总开关：已静音的段立刻恢复注入，不用去改账本
    if (judge?.enabled !== true || judge.muteBelow <= 0) return false;
    const mutedAt = this.noteMetrics.mutedAt(file, heading);
    if (mutedAt === undefined) return false;
    try {
      if (statSync(join(this.notesStore.root, file)).mtimeMs > mutedAt) {
        if (clearExpired) this.noteMetrics.unmute(file, heading);
        return false;
      }
    } catch {
      /* 文件刚被删掉：检索下一次刷新就不会再出现它 */
    }
    return true;
  }

  /**
   * 一轮结束时结算这轮注入的笔记：正常结束才记账并排队打分，异常结束的丢掉。
   * 打分异步进行，不等结果。
   */
  settleNoteInjection(record: SessionRecord, ok: boolean, turn?: NoteTurnSummary): void {
    this.operationRecalls.delete(record.sessionKey);
    const pending = this.pendingNoteInjections.get(record.sessionKey);
    if (pending === undefined) return;
    this.pendingNoteInjections.delete(record.sessionKey);
    // 登记后一直没等到自己那一轮（消息被丢弃、会话创建失败），别让后来不相干的一轮替它结算
    if (!ok || Date.now() - pending.at > NOTE_INJECTION_TTL_MS) return;
    const metrics = this.noteMetrics;
    if (metrics === undefined) return;
    metrics.recordInjection(pending.hits);

    const judge = this.config.notes?.judge;
    // 开团时用户消息多是行动宣告，和共享笔记天然对不上，评出来的低分不说明笔记没用
    if (this.noteJudge === undefined || judge?.enabled !== true || pending.campaignRunning) return;
    if (Math.random() >= judge.sampleRate) return;
    const route = this.getEffectiveModel(record.scope, record.peerId);
    // 和接话打分用同一个模型：那边通常已经配了便宜的小模型，没配就退回会话主模型
    const replyJudge = this.config.replyDesire?.judge;
    const provider = replyJudge?.provider || route?.provider || this.config.provider;
    const model = replyJudge?.model || route?.model || this.config.model;
    if (!provider || !model) return;
    const contextLimit = replyJudge?.contextMessages ?? 6;
    const contextLines = pending.contextLines
      ?? (record.scope === 'c2c' ? recentSessionLines(record.agent, contextLimit) : undefined);
    const policy = { minSamples: judge.minSamples, muteBelow: judge.muteBelow };
    void this.noteJudge.enqueue({
      provider,
      model,
      reasoningEffort: replyJudge?.reasoningEffort ?? '',
      query: pending.query,
      ...(contextLines !== undefined && contextLines.length > 0 ? { contextLines } : {}),
      ...(turn?.reply ? { reply: turn.reply } : {}),
      ...(turn?.toolsUsed !== undefined && turn.toolsUsed.length > 0 ? { toolsUsed: turn.toolsUsed } : {}),
      notes: pending.hits.map((hit, i) => ({ file: hit.file, heading: hit.heading, text: pending.snippets[i] ?? '' })),
    }).then((scores) => {
      if (scores === undefined) return;
      const muted = metrics.recordJudgement(pending.hits, scores, policy);
      this.logger.debug(`note-judge: ${pending.hits.map((hit, i) => `${hit.file}=${scores[i]}`).join(' ')}`);
      for (const key of muted) this.logger.info(`im-qqbot: 笔记相关性长期偏低，已停止自动注入: ${key}`);
    }).catch(() => undefined);
  }

  /** 原生读图：把本地图片提交为 attachment，返回可直接放进 user message 的 ImageBlock */
  async createImageBlock(path: string): Promise<ImageBlock | undefined> {
    if (!this.config.vision.native) return undefined;
    const attachments = this.ctx.get('attachments') as AttachmentStoreLike | undefined;
    if (attachments === undefined) {
      this.logger.warn('im-qqbot: vision.native 已开启，但 attachments 服务不可用，回退到图片路径');
      return undefined;
    }
    try {
      return await loadNativeImageBlock(attachments, path, this.config.vision.maxBytes);
    } catch (err) {
      this.logger.warn(`im-qqbot: 原生图片附件创建失败，回退到图片路径: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** 当前 provider/model 是否声明 image 输入（旧会话切模型前不能硬塞 ImageBlock） */
  async supportsImageInput(provider: string, model: string): Promise<boolean> {
    const llm = this.ctx.get('llm') as {
      resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: readonly string[] }>;
    } | undefined;
    if (llm === undefined) return false;
    try {
      const info = await llm.resolveModelInfo(provider, model);
      return info.inputModalities?.includes('image') ?? false;
    } catch {
      return false;
    }
  }

  /** 记录一条因平台限制未送达的文本，等下一次用户消息时提示模型补发 */
  addUnsent(sessionKey: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const list = this.unsent.get(sessionKey) ?? [];
    list.push(trimmed.slice(0, 8000));
    while (list.length > 3) list.shift();
    this.unsent.set(sessionKey, list);
  }

  /**
   * 记下模型写成正文文字、没有真正执行的工具（`[::dnd_move::]{…}` 这类）。
   * 文字已经从群消息里剥掉，但模型以为调过了，会接着说「已经写好/已经挪过去」；下一条用户消息时提醒它。
   */
  addSkippedCalls(sessionKey: string, names: readonly string[]): void {
    if (names.length === 0) return;
    const set = this.skippedCalls.get(sessionKey) ?? new Set<string>();
    for (const name of names) if (name) set.add(name);
    this.skippedCalls.set(sessionKey, set);
  }

  /** 取出并清空该会话没执行的伪工具调用名 */
  takeSkippedCalls(scope: ChatScope, peerId: string): string[] | undefined {
    const key = this.sessionKey(scope, peerId);
    const set = this.skippedCalls.get(key);
    if (set === undefined || set.size === 0) return undefined;
    this.skippedCalls.delete(key);
    return [...set];
  }

  /** 取出并清空该会话的未送达文本 */
  takeUnsent(scope: ChatScope, peerId: string): string | undefined {
    const key = this.sessionKey(scope, peerId);
    const list = this.unsent.get(key);
    if (list === undefined || list.length === 0) return undefined;
    this.unsent.delete(key);
    return list.join('\n\n---\n\n').slice(0, 8000);
  }

  /** /new 或人设切换时捕获旧会话的 active 定时任务，等目标会话第一条消息注入重建指令 */
  private captureScheduleMigrations(sessionKey: string, oldSessionId: string): void {
    try {
      const tasks = readScheduleMigrations(scheduleStorageHome(), oldSessionId);
      // 连续切换时保留其他来源；同一会话再次离开时刷新快照，避免重复重建或复活已删任务。
      const pending = (this.pendingScheduleMigrations.get(sessionKey) ?? [])
        .filter((batch) => batch.oldSessionId !== oldSessionId);
      if (tasks.length > 0) pending.push({ oldSessionId, tasks });
      if (pending.length > 0) this.pendingScheduleMigrations.set(sessionKey, pending);
      else this.pendingScheduleMigrations.delete(sessionKey);
    } catch {
      // 调度存储不可读时不阻塞换会话；用户仍可手动重建
    }
  }

  /**
   * 取走并格式化待迁移任务（只给新会话的第一条消息一次）。
   * 同时删除旧会话里的这些任务：DSH 按原 sessionId 投递，不删会和新会话重建的任务重复触发。
   */
  takeScheduleMigration(scope: ChatScope, peerId: string): string | undefined {
    const key = this.sessionKey(scope, peerId);
    const pending = this.pendingScheduleMigrations.get(key);
    if (pending === undefined) return undefined;
    this.pendingScheduleMigrations.delete(key);
    const schedule = this.getScheduleService();
    if (schedule === undefined) {
      this.logger.warn(`schedule service unavailable; old session tasks not retired: key=${key}`);
    } else {
      for (const { oldSessionId, tasks } of pending) {
        void retireMigratedSchedules(schedule, oldSessionId, tasks)
          .then((count) => this.logger.info(`retired ${count} migrated schedule task(s): key=${key} oldSessionId=${oldSessionId}`))
          .catch((err: unknown) => this.logger.warn(`retire migrated schedules failed: key=${key} oldSessionId=${oldSessionId} err=${err instanceof Error ? err.message : String(err)}`));
      }
    }
    return formatScheduleMigrationHint(pending.flatMap((batch) => batch.tasks));
  }

  private getScheduleService(): ScheduleServiceLike | undefined {
    try {
      return this.ctx.get('schedule') as ScheduleServiceLike | undefined;
    } catch {
      return undefined;
    }
  }

  getStatus(scope: ChatScope, peerId: string): SessionStatus {
    const record = this.getSessionRecord(scope, peerId);
    const route = record !== undefined && this.combatAgents?.isChild(record.agent)
      ? record.agent.session.requestHeader?.()?.config ?? this.config.dnd?.combatAgent
      : this.getEffectiveModel(scope, peerId);

    return {
      active: !!record,
      sessionId: record?.sessionId,
      provider: route?.provider,
      model: route?.model,
      preset: record?.agentPreset,
      lastActivity: record?.lastActivity,
      messageCount: this.countMessages(record),
    };
  }

  getTokenUsage(scope: ChatScope, peerId: string): TokenUsageStats {
    const record = this.getSessionRecord(scope, peerId);
    const stats: TokenUsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    const events = sessionEventsOf(record);
    if (events.length === 0) return stats;

    for (const event of events) {
      if (event.type !== 'assistant/message') continue;
      const usage = extractEventUsage(event);
      if (!usage) continue;
      stats.input += usage.input;
      stats.output += usage.output;
      stats.cacheRead += usage.cacheRead;
      stats.cacheWrite += usage.cacheWrite;
    }

    return stats;
  }

  exportMarkdown(scope: ChatScope, peerId: string): string {
    const record = this.getSessionRecord(scope, peerId);
    if (!record) return '';

    const events = sessionEventsOf(record);
    if (events.length === 0) return '';

    const lines: string[] = [`# QQ 会话导出\n`, `> session: ${record.sessionId}\n`];

    for (const event of events) {
      if (event.type === 'user/message') {
        // 团况快照带 DM 机密（DC、怪物 HP、DM 笔记），不能跟着导出发到群里
        if (isRuntimeContextEvent(event)) continue;
        const text = extractEventMessageText(event);
        if (text) lines.push(`## 用户\n\n${text}\n`);
      } else if (event.type === 'assistant/message') {
        const text = extractEventMessageText(event);
        if (text) lines.push(`## 助手\n\n${text}\n`);
      }
    }

    return lines.join('\n');
  }

  private countMessages(record: SessionRecord | undefined): number {
    const events = sessionEventsOf(record);
    if (events.length === 0) return 0;

    let count = 0;
    for (const event of events) {
      if ((event.type === 'user/message' && !isRuntimeContextEvent(event)) || event.type === 'assistant/message') {
        count += 1;
      }
    }
    return count;
  }

  // ── Session 生命周期管理 ──

  sessionKey(scope: ChatScope, peerId: string): string {
    return `qqbot:${this.config.appId}:${scope}:${peerId}`;
  }

  private deriveSessionId(sessionKey: string): string {
    const hash = createHash('sha256').update(sessionKey).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  private currentSessionId(sessionKey: string): string {
    return this.modelResolver.getSessionId(sessionKey) ?? this.deriveSessionId(sessionKey);
  }

  /** 该 peer 当前主会话（或下一次 getOrCreate 将使用）的 sessionId；不随临时战斗子代理漂移，保证群历史游标连续 */
  sessionIdFor(scope: ChatScope, peerId: string): string {
    const key = this.sessionKey(scope, peerId);
    return this.sessions.get(key)?.sessionId ?? this.currentSessionId(key);
  }

  private async composePreset(presetId?: string): Promise<PresetComposition> {
    const presets = this.getPresetsService();
    if (!presets) return {};

    try {
      const resolved = await presets.resolve(presetId);
      const resolvedId = resolved.id;
      return {
        agentPreset: resolvedId,
        setup: async (agentCtx: Context) => {
          await presets.mount(agentCtx, resolvedId);
        },
      };
    } catch (err) {
      this.logger.warn(
        `im-qqbot: preset ${presetId ?? '(default)'} unavailable: ${err instanceof Error ? err.message : String(err)} — using host composition`,
      );
      return {};
    }
  }

  /** 记一个发过消息的人（合并消息里除触发者以外的发送者） */
  noteSender(record: SessionRecord, senderId: string): void {
    noteSender(record, senderId);
  }

  /** 获取或恢复或创建会话（get → resume → create） */
  async getOrCreate(
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
  ): Promise<SessionRecord> {
    await this.waitForPersonaSwitch(scope, peerId);
    await (this.waitForDndTransition ?? SessionManager.prototype.waitForDndTransition).call(this, scope, peerId);
    const record = await this.openSession(scope, peerId, senderId, replyTarget);
    const route = this.personaRoutes?.get(record.sessionKey);
    if (route) {
      const current = this.personaModelRoute(record);
      if (current?.provider !== route.provider || current.model !== route.model) this.applyModelSelection(record, route);
      this.personaRoutes.delete(record.sessionKey);
    }
    await this.receivePersonaHandoff(record);
    return record;
  }

  async waitForPersonaSwitch(scope: ChatScope, peerId: string): Promise<void> {
    const key = this.sessionKey?.(scope, peerId) ?? `qqbot:${this.config?.appId ?? ''}:${scope}:${peerId}`;
    await this.personaTransitions?.get(key);
    (this.recoverPersonaTransition ?? SessionManager.prototype.recoverPersonaTransition).call(this, scope, peerId);
  }

  async waitForDndTransition(scope: ChatScope, peerId: string): Promise<void> {
    const key = this.sessionKey?.(scope, peerId) ?? `qqbot:${this.config?.appId ?? ''}:${scope}:${peerId}`;
    await this.dndTransitions?.get(key);
  }

  clearDndEndPreparing(sessionKey: string): void {
    const cur = this.dndEndPreparing?.get(sessionKey);
    if (cur === undefined) return;
    this.dndEndPreparing.delete(sessionKey);
    cur.releaseLock();
  }

  async endDndSession(params: {
    scope: ChatScope;
    peerId: string;
    senderId: string;
    target: ReplyTarget;
    summary?: string;
  }): Promise<EndDndSessionOutcome> {
    const { scope, peerId } = params;
    const key = this.sessionKey(scope, peerId);
    this.dndTransitions ??= new Map();
    this.dndEndPreparing ??= new Map();
    if (this.dndTransitions.has(key) || this.dndEndPreparing.has(key)) return { status: 'busy' };
    if (this.dndService === undefined) return { status: 'error', message: '跑团功能未启用（配置 dnd.enabled）' };
    const precheck = this.dndService.validateStop(key, params.summary);
    if (!precheck.ok) {
      return precheck.reason === 'inactive'
        ? { status: 'inactive' }
        : { status: 'error', message: precheck.message ?? '结团摘要无效' };
    }

    const transition = Promise.resolve().then(async (): Promise<EndDndSessionOutcome> => {
      if (this.disposing) return { status: 'busy' };
      const releaseLock = (this.contextLocks ??= new ContextLockManager()).acquire(key, 'dnd-end-prep', 3 * 60_000);
      let handedOff = false;
      const endPrepId = randomUUID();
      try {
        await this.waitForPersonaSwitch(scope, peerId);
        let stopped = false;
        const stopNow = () => {
          stopped = this.dndService!.stop(key, params.summary, { endPrepId }) !== undefined;
        };
        const combatPaused = this.combatAgents !== undefined
          ? await this.combatAgents.pauseForSessionEnd(key, stopNow)
          : (stopNow(), undefined);
        if (!stopped) return { status: 'inactive' };
        try {
          const main = combatPaused?.main ?? this.sessions.get(key) ?? await this.openSession(scope, peerId, params.senderId, params.target);
          main.replyTarget = params.target;
          main.lastActivity = Date.now();
          if (params.senderId) noteSender(main, params.senderId);
          this.dndToolScope?.sync(main);
          const prompt = this.dndService!.buildEndPreparationPrompt(key, {
            ...(params.summary !== undefined ? { userSummary: params.summary } : {}),
            ...(combatPaused?.handoff !== undefined ? { combatHandoff: combatPaused.handoff } : {}),
          });
          this.dndEndPreparing.set(key, { id: endPrepId, releaseLock });
          main.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
          handedOff = true;
          void main.agent.whenIdle()
            .catch(() => {})
            .finally(() => {
              const cur = this.dndEndPreparing.get(key);
              if (cur?.id === endPrepId) {
                this.dndEndPreparing.delete(key);
                cur.releaseLock();
              }
              this.dndService?.completeEndPreparation(key, endPrepId);
            });
          return { status: 'handed_off' };
        } catch (err) {
          const cur = this.dndEndPreparing.get(key);
          if (cur?.id === endPrepId) this.dndEndPreparing.delete(key);
          this.dndService?.completeEndPreparation(key, endPrepId);
          this.logger.warn(`im-qqbot: 停团自动唤醒 DM 备团失败 key=${key}: ${err instanceof Error ? err.message : String(err)}`);
          return { status: 'paused_fallback', message: '⏸ 进度、角色卡与停团交接已保存（自动唤醒 DM 备团失败，可稍后 @ 我备团）。' };
        }
      } finally {
        if (!handedOff) releaseLock();
        this.dndTransitions.delete(key);
      }
    });
    this.dndTransitions.set(key, transition);
    return await transition;
  }

  getPersonaSwitchState(scope: ChatScope, peerId: string): PersonaSwitchState {
    const key = this.sessionKey?.(scope, peerId) ?? `qqbot:${this.config?.appId ?? ''}:${scope}:${peerId}`;
    if (this.personaTransitions?.has(key)) return 'transitioning';
    if (this.personaStore?.getTransition?.(peerId, scope) !== undefined) return 'recovering';
    return 'idle';
  }

  /** 启动/重连检测到上次人设切换中途崩溃的事务标记时，按阶段清理悬挂或补齐会话指向。 */
  recoverPersonaTransition(scope: ChatScope, peerId: string): void {
    const tr = this.personaStore?.getTransition?.(peerId, scope);
    if (tr === undefined) return;
    const key = this.sessionKey?.(scope, peerId) ?? `qqbot:${this.config?.appId ?? ''}:${scope}:${peerId}`;
    const releaseLock = (this.contextLocks ??= new ContextLockManager()).acquire(key, 'persona-recovery', 60_000);
    try {
      this.logger.warn(`persona transition recovery: key=${key} phase=${tr.phase} ${tr.fromPersona}->${tr.toPersona}`);
      if (tr.phase === 'handoff') {
        this.personaStore?.handoffs?.recoverInterrupted?.(key, '人设切换中途中断，保留原人设');
        this.personaStore?.finishTransition?.(peerId, scope);
      } else if (tr.phase === 'committing') {
        if (tr.sourceSessionId !== tr.targetSessionId) {
          this.captureScheduleMigrations?.(key, tr.sourceSessionId);
          this.retiredSessionIds?.set(tr.sourceSessionId, key);
        }
        this.modelResolver?.setSessionId?.(key, tr.targetSessionId);
        this.personaStore?.finishTransition?.(peerId, scope);
      }
    } finally {
      releaseLock();
    }
  }

  private async openSession(
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
  ): Promise<SessionRecord> {
    const key = this.sessionKey(scope, peerId);
    const existing = this.sessions.get(key);

    if (existing) {
      existing.replyTarget = replyTarget;
      existing.lastActivity = Date.now();
      noteSender(existing, senderId);
      return existing;
    }

    const route = this.modelResolver.getEffectiveRoute(key);
    const sessionId = SessionId(this.currentSessionId(key));
    this.logger.info(`getOrCreate: key=${key} route=${route ? `${route.provider}/${route.model}` : 'host-default'} sessionId=${sessionId}`);

    let agent: DshAgent;
    let handle: DshAgentHandle | undefined;
    let agentPreset: string | undefined;

    const live = this.agents.get(sessionId);
    if (live) {
      agent = live;
      this.logger.info(`reusing live agent: key=${key}`);
    } else {
      // preset 只解析一次：resume/create 共用同一组合，避免重复 resolve/mount 目录。
      // 优先 session 当初的 preset（started 锁定语义），无则用当前 effective preset。
      const presetId = (await this.resolvePersistedPreset(sessionId)) ?? this.getEffectivePresetByKey(key);
      const composed = await this.composePreset(presetId);
      agentPreset = composed.agentPreset;
      try {
        const resumeRoute = this.modelResolver.getResumeRoute(key);
        const resumed = await this.agents.resume({
          resumeSessionId: sessionId,
          ...(resumeRoute ? { agentOptions: resumeRoute } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = resumed.agent;
        handle = resumed;
        this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : 'session-own'}`);
      } catch {
        try {
          const created = await this.agents.create({
            sessionId,
            meta: {
              cwd: this.config.cwd || process.cwd(),
              ...(agentPreset ? { agentPreset } : {}),
            },
            ...(route ? { agentOptions: route } : {}),
            ...(composed.setup ? { setup: composed.setup } : {}),
          });
          agent = created.agent;
          handle = created;
          this.logger.info(`created new session: key=${key} preset=${agentPreset ?? 'none'}`);
        } catch (createErr) {
          // 挂在同一个 id 上的会话还活着（插件重组、宿主重启、上一个 agent 没 dispose 都会这样）：
          // resume 没接上、create 又报 already exists。先再挂一次；还不行就换新 id 记下来，
          // 否则这个群之后每条消息都在同一处撞车。
          const message = createErr instanceof Error ? createErr.message : String(createErr);
          if (!/already exists/i.test(message)) throw createErr;
          try {
            const retried = await this.agents.resume({
              resumeSessionId: sessionId,
              ...(this.modelResolver.getResumeRoute(key) ? { agentOptions: this.modelResolver.getResumeRoute(key) } : {}),
              ...(composed.setup ? { setup: composed.setup } : {}),
            });
            agent = retried.agent;
            handle = retried;
            this.logger.warn(`session 已存在，改为重新挂载: key=${key} sessionId=${sessionId}`);
          } catch (retryErr) {
            const fresh = randomUUID();
            const created = await this.agents.create({
              sessionId: SessionId(fresh),
              meta: {
                cwd: this.config.cwd || process.cwd(),
                ...(agentPreset ? { agentPreset } : {}),
              },
              ...(route ? { agentOptions: route } : {}),
              ...(composed.setup ? { setup: composed.setup } : {}),
            });
            agent = created.agent;
            handle = created;
            this.modelResolver.setSessionId(key, fresh);
            this.logger.warn(
              `session id 冲突且重挂失败，换新会话: key=${key} ${sessionId} -> ${fresh}（${retryErr instanceof Error ? retryErr.message : String(retryErr)}）`,
            );
          }
        }
      }
    }

    const record: SessionRecord = {
      sessionKey: key,
      // 恢复失败时可能已换建会话，接收账本和出站查询必须跟随实际 agent。
      sessionId: agent.session.id,
      agent,
      handle: handle ?? { agent, dispose: async () => {} },
      replyTarget,
      scope,
      peerId,
      senderId,
      lastActivity: Date.now(),
      agentPreset,
    };
    noteSender(record, senderId);

    this.sessions.set(key, record);
    // 在第一条消息交给 agent 之前定好它看得到哪些工具与跑团工具
    this.sessionToolScope?.sync(record);
    this.dndToolScope?.sync(record);
    // 活会话的 Web 选择已经在宿主生效。旧 per-chat 偏好只用于 resume/create，
    // 不在插件重组后重新安装竞争选择器、也不把旧偏好当成一次新的切换。
    if (!live) this.syncExplicitRoute(record);
    return record;
  }

  /** 团开始或暂停后，让这个会话看得到的跑团工具跟上；会话不在内存里时等它下次创建再定 */
  syncDndTools(sessionKey: string): void {
    if (this.dndService?.active(sessionKey) !== undefined) this.clearDndEndPreparing?.(sessionKey);
    const record = this.sessions.get(sessionKey);
    if (record !== undefined) this.dndToolScope?.sync(record);
    const child = this.combatAgents?.current(sessionKey);
    if (child !== undefined) this.dndToolScope?.sync(child);
  }

  /** 权限白名单变更后同步目标会话可见工具；会话不在内存里时等下次创建再定 */
  syncSessionTools(scope: ChatScope, peerId: string): void {
    const record = this.sessions.get(this.sessionKey(scope, peerId));
    if (record !== undefined) this.sessionToolScope?.sync(record);
  }

  findBySessionId(sessionId: string): SessionRecord | undefined {
    const child = this.combatAgents?.findSession(sessionId);
    if (child !== undefined) return child;
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) return record;
    }
    const currentKey = this.retiredSessionIds.get(sessionId);
    return currentKey === undefined ? undefined : this.sessions.get(currentKey);
  }

  findByAgent(agent: DshAgent): SessionRecord | undefined {
    const child = this.combatAgents?.findAgent(agent);
    if (child !== undefined) return child;
    for (const record of this.sessions.values()) {
      if (record.agent === agent) return record;
    }
    return undefined;
  }

  switchPersona(peerId: string, personaId: string, scope: ChatScope = 'group'): Promise<SwitchPersonaOutcome> {
    const key = this.sessionKey(scope, peerId);
    this.personaTransitions ??= new Map();
    if (this.personaTransitions.has(key)) return Promise.resolve('busy');
    // 下一微任务才开始，确保恢复旧会话之前，入站等待锁已经存在。
    const transition = Promise.resolve().then(() => this.performPersonaSwitch(peerId, personaId, scope));
    this.personaTransitions.set(key, transition);
    void transition.finally(() => { this.personaTransitions.delete(key); }).catch(() => {});
    return transition;
  }

  private async performPersonaSwitch(peerId: string, personaId: string, scope: ChatScope): Promise<SwitchPersonaOutcome> {
    if (this.disposing) return 'busy';
    (this.recoverPersonaTransition ?? SessionManager.prototype.recoverPersonaTransition).call(this, scope, peerId);
    const store = this.personaStore;
    const currentId = store?.currentId(peerId, scope);
    if (store === undefined || currentId === personaId) return 'same';
    const key = this.sessionKey(scope, peerId);
    // 开团的存档跟着会话走，中途换人设 DM 就换人了
    if (this.dndService?.active(key) !== undefined) return 'dnd';
    let record = this.sessions.get(key);
    if (record !== undefined && (record.agent.status !== 'idle' || record.compacting)) return 'busy';

    const releaseLock = (this.contextLocks ??= new ContextLockManager()).acquire(key, 'persona-switch', 5 * 60_000);
    let transitionStarted = false;
    const abortTransition = (): void => {
      if (!transitionStarted) return;
      transitionStarted = false;
      try {
        store.finishTransition?.(peerId, scope);
      } catch (err) {
        this.logger.warn(`persona transition cleanup failed: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
      }
    };

    try {
      let incomplete = false;
      let sourceRoute: ModelRoute | undefined;
      let sourceSessionId = record?.sessionId ?? this.currentSessionId(key);
      const targetSessionId = store.sessionFor(peerId, personaId, scope) ?? randomUUID();

      const ensureTransitionBegun = (): boolean => {
        if (transitionStarted) return true;
        try {
          store.beginTransition?.({
            scope,
            peerId,
            fromPersona: currentId!,
            toPersona: personaId,
            sourceSessionId,
            targetSessionId,
          });
          transitionStarted = true;
          return true;
        } catch (err) {
          this.logger.warn(`persona transition persistence failed: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      };

      if (store.handoffs !== undefined) {
        try {
          // 空闲回收或进程重启后，也要先恢复来源历史；不能把“不在内存”当成没有对话。
          record ??= await this.openSession(scope, peerId, peerId, { scope, targetId: peerId });
          if (record.agent.status !== 'idle' || record.compacting) return 'busy';
          sourceSessionId = record.sessionId;
          if (!ensureTransitionBegun()) return 'failed';
          sourceRoute = this.personaModelRoute(record);
          const events = [...(record.agent.session.snapshotEvents?.() ?? record.agent.session.events ?? [])];
          const previous = store.handoffs.read(key);
          const input = collectHandoffInput(record.sessionId, events, record.agent.session.surface?.nodes, previous.covered[record.sessionId]);
          input.schedules = readScheduleMigrations(scheduleStorageHome(), record.sessionId);
          if (input.transcript || previous.pending) {
            const attempt = store.handoffs.begin(key, currentId!, input);
            try {
              const llm = this.ctx.get('llm') as JudgeLlm | undefined;
              const provider = sourceRoute?.provider;
              const model = sourceRoute?.model;
              if (!llm || !provider || !model) throw new Error('交接模型不可用');
              const summary = await record.agent.runMaintenance((signal) => generatePersonaHandoff(
                llm, { provider, model }, previous.latest ? `版本 ${previous.latest.version}；时间 ${previous.latest.at}\n${previous.latest.summary}` : '', attempt.transcript,
                signal,
                { resume: attempt.progress, source: { fromPersona: attempt.fromPersona, at: attempt.at, cursor: attempt.cursor }, save: (chars, draft) => store.handoffs.checkpoint(key, attempt.id, chars, draft) },
              ));
              const after = record.agent.session.snapshotEvents?.() ?? record.agent.session.events ?? [];
              if (after.length !== events.length || after.at(-1)?.seq !== events.at(-1)?.seq || record.agent.status !== 'idle') {
                store.handoffs.fail(key, attempt.id, '生成期间历史发生变化，请重新切换');
                abortTransition();
                return 'busy';
              }
              store.handoffs.complete(key, attempt.id, summary);
            } catch (err) {
              incomplete = true;
              store.handoffs.fail(key, attempt.id, err instanceof Error ? err.message : String(err));
              this.logger.warn(`persona handoff incomplete: key=${key} attempt=${attempt.id} err=${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } catch (err) {
          // 落盘失败不能继续切换，否则连“哪些没覆盖”也无法保证。
          abortTransition();
          this.logger.warn(`persona handoff persistence failed: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
          return 'failed';
        }
      }
      if (!ensureTransitionBegun()) return 'failed';
      if (sourceRoute && record) {
        const current = this.personaModelRoute(record);
        if (record.agent.status !== 'idle' || this.sessions.get(key) !== record
          || current?.provider !== sourceRoute.provider || current.model !== sourceRoute.model) {
          abortTransition();
          return 'busy';
        }
      }
      if (this.disposing) {
        abortTransition();
        return 'busy';
      }
      try {
        // 人格只改变设定和历史，不应把 Web 实际选用的模型悄悄换回聊天默认。
        if (sourceRoute) this.modelResolver.setOverride(key, sourceRoute);
        if (typeof store.commitTransition === 'function') {
          store.commitTransition(peerId, scope);
        } else {
          store.rememberSession(peerId, currentId!, sourceSessionId, scope);
          store.select(peerId, personaId, scope);
        }
      } catch (err) {
        abortTransition();
        this.logger.warn(`persona selection persistence failed: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
        return 'failed';
      }
      if (sourceRoute) {
        this.personaRoutes ??= new Map();
        this.personaRoutes.set(key, sourceRoute);
      }
      await this.remove(scope, peerId, targetSessionId);
      store.finishTransition?.(peerId, scope);
      return incomplete ? 'handoff-incomplete' : 'ok';
    } finally {
      releaseLock();
    }
  }

  /**
   * 解析指定会话当前实际生效的 provider/model 路由（含 Web/命令切换、model/selection、最近请求头及配置解析链）。
   * reasoningEffort 仅在最近请求头与该路由一致且显式非空时透传，否则置为 null，避免战斗子代理回退复用主会话模型时强行塞入不兼容的推理档位导致 400。
   */
  public getEffectiveSessionRoute(record: SessionRecord): (ModelRoute & { reasoningEffort?: string | null }) | undefined {
    const route = this.personaModelRoute(record);
    if (!route?.provider || !route.model) return undefined;
    const headerCfg = record.agent.session.requestHeader?.()?.config;
    const effort = headerCfg?.provider === route.provider
      && headerCfg?.model === route.model
      && typeof headerCfg.reasoningEffort === 'string'
      && headerCfg.reasoningEffort.trim()
      ? headerCfg.reasoningEffort.trim()
      : null;
    return { provider: route.provider, model: route.model, reasoningEffort: effort };
  }

  private personaModelRoute(record: SessionRecord): ModelRoute | undefined {
    const controller = this.ctx?.get('sessionController') as { agents?: { selectionFor?(agent: DshAgent): ModelSelectionRef } } | undefined;
    const selected = controller?.agents?.selectionFor?.(record.agent)?.current ?? this.modelSelections?.get(record.agent)?.current;
    if (selected?.provider && selected.model) return { provider: selected.provider, model: selected.model };
    const events = record.agent.session.snapshotEvents?.() ?? record.agent.session.events ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.type === 'request/header') break;
      if (event.type === 'model/selection') {
        const route = event.data as ModelRoute | undefined;
        if (route?.provider && route.model) return { provider: route.provider, model: route.model };
      }
    }
    const header = record.agent.session.requestHeader?.()?.config;
    return header?.provider && header.model ? { provider: header.provider, model: header.model } : this.getEffectiveModel(record.scope, record.peerId);
  }

  /** 在目标人格自己的历史之后追加，成功写入会话后才记接收版本；下一条新消息在它之后。 */
  private async receivePersonaHandoff(record: SessionRecord): Promise<void> {
    const store = this.personaStore;
    if (!store?.handoffs || this.dndService?.active(record.sessionKey) !== undefined) return;
    const persona = store.currentId(record.peerId, record.scope);
    const session = record.agent.session;
    const events = session.snapshotEvents?.() ?? session.events ?? [];
    const receipt = store.handoffs.read(record.sessionKey).received[persona];
    // 旧版曾在真正持久化前记接收；加载后没有交接事件时要补送，不能只信账本。
    // 收件箱的 inserted 是持久化输入；宿主在消费它时先建立 system head，
    // 不能在空 surface 上直接 append user/message。
    const deliveredMessages = events.flatMap((event) => {
      const data = (event.data ?? event.message ?? event) as { inserted?: unknown[] };
      return event.type === 'agent/inbox/spliced' ? data.inserted ?? [] : event.type === 'user/message' ? [data] : [];
    }) as Array<{ source?: unknown; content?: Array<{ text?: string }> }>;
    const hasDurableDelivery = deliveredMessages.some((data) => {
      return isPersonaHandoffSource(data.source) && data.content?.some((block) => {
        const text = block.text ?? '';
        return receipt !== undefined && (receipt.version === 0 || text.includes(`版本 ${receipt.version}；`))
          && (receipt.attemptId === undefined || text.includes(receipt.attemptId));
      });
    });
    const delivery = store.handoffs.delivery(record.sessionKey, persona, record.sessionId, !hasDurableDelivery);
    if (!delivery) return;
    if (!record.agent.send) throw new Error('当前宿主不支持交接持久化收件箱');
    // 会话已写入、接收账本尚未写入时崩溃：从正文识别已送达记录，避免再次追加。
    const alreadyWritten = deliveredMessages.some((data) => {
      return isPersonaHandoffSource(data.source) && data.content?.some((block) => block.text === delivery.text);
    });
    if (!alreadyWritten) record.agent.send(createPersonaHandoffMessage(delivery.text), 'next-step', false);
    store.handoffs.acknowledge(record.sessionKey, persona, record.sessionId, delivery.version, delivery.attemptId);
  }

  /**
   * /new：换新会话，并把旧会话的压缩摘要留给新会话的第一条消息。
   *
   * 旧会话先从表里摘掉再压缩：压缩要十几秒，期间进来的消息应该落到新会话（在 takeHandoff 里等摘要），
   * 而不是继续写进马上要丢的旧会话。不等压缩完就返回，/new 的回执不该被拖住。
   * 返回是否在准备交接（命令回执用）。
   */
  startNewSession(scope: ChatScope, peerId: string, options: { handoff: boolean }): boolean {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    // 正在生成的会话压缩不了；团档有自己的停团交接，而且旧会话里全是 DM 机密
    const carry = options.handoff && record !== undefined && record.agent.status === 'idle'
      && this.dndService?.active(key) === undefined;
    if (!carry) {
      this.pendingHandoffs.delete(key);
      void this.remove(scope, peerId);
      return false;
    }
    let settle!: (summary: string | undefined) => void;
    this.pendingHandoffs.set(key, new Promise<string | undefined>((resolve) => { settle = resolve; }));
    void this.remove(scope, peerId, undefined, async (old) => {
      // 压缩被拒（历史太短、服务没挂）也照样往下读：会话以前压缩过的话还有旧摘要可用
      const outcome = await this.compactRecord(key, old);
      const summary = latestCompactionSummary(old.agent.session.snapshotEvents?.() ?? old.agent.session.events);
      this.logger.info(`session handoff: key=${key} compact=${outcome.ok ? `ok(${outcome.shadowed ?? 0})` : outcome.reason} summary=${summary?.length ?? 0} chars`);
      settle(summary);
    }).finally(() => settle(undefined));
    return true;
  }

  /** 取走会话交接（只给新会话的第一条消息一次）；还在压缩就等它，等太久就不带了 */
  async takeHandoff(scope: ChatScope, peerId: string): Promise<string | undefined> {
    const key = this.sessionKey(scope, peerId);
    const pending = this.pendingHandoffs.get(key);
    if (pending === undefined) return undefined;
    this.pendingHandoffs.delete(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), HANDOFF_WAIT_MS); });
    const summary = await Promise.race([pending, timeout]);
    clearTimeout(timer);
    return summary === undefined ? undefined : formatHandoffHint(summary);
  }

  /**
   * beforeDispose：旧会话已经从表里摘掉、还没销毁时跑（/new 用它压缩旧会话取摘要）。
   */
  async remove(
    scope: ChatScope,
    peerId: string,
    nextSessionId: string = randomUUID(),
    beforeDispose?: (record: SessionRecord) => Promise<void>,
  ): Promise<void> {
    const key = this.sessionKey(scope, peerId);
    const releaseCombat = this.combatAgents?.release(key);
    const record = this.sessions.get(key);
    // 默认派生 ID 未必写进偏好存储；插件重载/空闲回收后仍要捕获旧人设的任务。
    const oldSessionId = record?.sessionId ?? this.currentSessionId(key);
    if (oldSessionId !== nextSessionId) {
      this.captureScheduleMigrations(key, oldSessionId);
      this.retiredSessionIds.set(oldSessionId, key);
      while (this.retiredSessionIds.size > 100) {
        const first = this.retiredSessionIds.keys().next().value;
        if (first === undefined) break;
        this.retiredSessionIds.delete(first);
      }
    }
    // 切回用过的人设时，目标会话自己的任务仍在那里，不应再删除并重建。
    const pending = this.pendingScheduleMigrations.get(key)?.filter((batch) => batch.oldSessionId !== nextSessionId);
    if (pending?.length) this.pendingScheduleMigrations.set(key, pending);
    else this.pendingScheduleMigrations.delete(key);
    this.retiredSessionIds.delete(nextSessionId);
    this.modelResolver.setSessionId(key, nextSessionId);
    this.contextLocks?.clear(key);

    if (!record) { await releaseCombat; return; }
    this.sessions.delete(key);
    this.modelSelections.delete(record.agent);
    if (beforeDispose !== undefined) await beforeDispose(record).catch(() => {});
    record.agent.cancel({ kind: 'user' });
    if (releaseCombat !== undefined) await releaseCombat;
    await record.handle.dispose().catch(() => {});
    this.logger.info(`session removed: key=${key}`);
  }

  /**
   * 原地压缩当前会话历史（保留 sessionId，用摘要替换旧历史）。
   *
   * 会话未驻留内存时尝试仅从磁盘 resume 现有历史并压缩（绝不 create 空会话），压缩完若未被激活则释放句柄。
   * 需通过 agentPresets.serviceFor(agent, 'compaction') / agent.ctx / 根 ctx 解析；未挂载时优雅降级。
   * 这是「压缩上下文」的语义，区别于 remove() 的「换新会话」。
   */
  async compact(scope: ChatScope, peerId: string): Promise<CompactOutcome> {
    const key = this.sessionKey?.(scope, peerId) ?? `qqbot:${this.config?.appId ?? ''}:${scope}:${peerId}`;
    if (this.personaTransitions?.has(key)) return { ok: false, reason: 'busy' };
    const record = this.sessions?.get(key);
    if (record) return this.compactRecord(key, record);

    const rawSessionId = this.currentSessionId?.(key) ?? this.deriveSessionId?.(key);
    if (!rawSessionId || !this.agents) return { ok: false, reason: 'no-session' };
    const sessionId = SessionId(rawSessionId);

    const live = this.agents.get?.(sessionId);
    if (live) {
      const transient: SessionRecord = {
        sessionKey: key,
        sessionId: live.session.id,
        agent: live,
        handle: { agent: live, dispose: async () => {} },
        replyTarget: { scope, targetId: peerId, msgId: '' },
        scope,
        peerId,
        senderId: '',
        lastActivity: Date.now(),
      };
      return this.compactRecord(key, transient);
    }

    if (typeof this.agents.resume !== 'function') return { ok: false, reason: 'no-session' };

    const presetId = (await this.resolvePersistedPreset?.(sessionId)) ?? this.getEffectivePresetByKey?.(key);
    const composed = (await this.composePreset?.(presetId)) ?? {};
    const resumeRoute = this.modelResolver?.getResumeRoute?.(key);
    let tempHandle: DshAgentHandle;
    try {
      tempHandle = await this.agents.resume({
        resumeSessionId: sessionId,
        ...(resumeRoute ? { agentOptions: resumeRoute } : {}),
        ...(composed.setup ? { setup: composed.setup } : {}),
      });
    } catch (err) {
      this.logger?.debug?.(
        `compact resume skipped: key=${key} sessionId=${sessionId} err=${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, reason: 'no-session' };
    }

    const transient: SessionRecord = {
      sessionKey: key,
      sessionId: tempHandle.agent.session.id,
      agent: tempHandle.agent,
      handle: tempHandle,
      replyTarget: { scope, targetId: peerId, msgId: '' },
      scope,
      peerId,
      senderId: '',
      lastActivity: Date.now(),
      agentPreset: composed.agentPreset,
    };
    try {
      return await this.compactRecord(key, transient);
    } finally {
      if (this.sessions?.get(key)?.agent !== tempHandle.agent && tempHandle.agent.status === 'idle') {
        await tempHandle.dispose().catch(() => {});
      }
    }
  }

  /** 压缩一条会话记录；/new 交接时这条记录已经不在会话表里了，所以不按 key 查 */
  private async compactRecord(key: string, record: SessionRecord): Promise<CompactOutcome> {
    const active = this.activeCompactions ?? (this.activeCompactions = new Set<string>());
    if (active.has(key)) return { ok: false, reason: 'busy' };
    if (record.agent.status !== 'idle') return { ok: false, reason: 'busy' };

    const tryGet = <T>(fn: () => T): T | undefined => {
      try {
        return fn();
      } catch {
        return undefined;
      }
    };
    const presets = tryGet(() => this.getPresetsService?.());
    const compaction = (
      tryGet(() => presets?.serviceFor(record.agent, 'compaction'))
      ?? tryGet(() => (record.agent.ctx as { get?(name: string): unknown } | undefined)?.get?.('compaction'))
      ?? tryGet(() => this.ctx?.get('compaction'))
    ) as CompactionServiceLike | undefined;
    if (!compaction) return { ok: false, reason: 'unavailable' };

    const headerConfig = record.agent.session.requestHeader?.()?.config;
    const hasHeaderRoute = Boolean(headerConfig?.provider && headerConfig?.model);
    const hasAgentOptions = Boolean(record.agent.options?.provider && record.agent.options?.model);
    const route = hasHeaderRoute || hasAgentOptions
      ? undefined
      : (this.personaModelRoute?.(record) ?? this.modelResolver?.getEffectiveRoute?.(key));
    const targetAgent =
      record.agent.options !== undefined && (hasHeaderRoute || hasAgentOptions || !route?.provider || !route?.model)
        ? record.agent
        : {
            id: record.agent.id,
            ctx: record.agent.ctx,
            session: record.agent.session,
            options: {
              provider: route?.provider ?? record.agent.options?.provider,
              model: route?.model ?? record.agent.options?.model,
            },
            runMaintenance: record.agent.runMaintenance.bind(record.agent),
          };

    active.add(key);
    try {
      const result = await compaction.compactNow(targetAgent, new AbortController().signal);
      if (result === null) return { ok: true, shadowed: 0, tokens: 0 };
      return { ok: true, shadowed: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const { message: causeDetail, isNotSmaller } = extractCompactionCause(err);
      if (code === 'summary') {
        if (isNotSmaller) {
          this.logger?.debug?.(`compact skipped (summary not smaller): key=${key}`);
          return { ok: true, shadowed: 0, tokens: 0 };
        }
        const summaryErr = causeDetail || (err instanceof Error ? err.message : String(err));
        this.logger?.warn?.(`compact summary failed: key=${key} cause=${summaryErr}`);
        return { ok: false, reason: 'failed', message: `摘要生成失败: ${summaryErr.slice(0, 200)}` };
      }
      // 其他 ManualCompactionError 预期失败，给友好文案（除 cancelled 外记 warn 以便排查）
      if (code !== undefined && code in COMPACTION_ERROR_HINTS) {
        const logDetail = `compact declined: key=${key} code=${code}${causeDetail ? ` cause=${causeDetail}` : ''}`;
        if (code === 'cancelled') this.logger?.debug?.(logDetail);
        else this.logger?.warn?.(logDetail);
        const hint = COMPACTION_ERROR_HINTS[code];
        return {
          ok: false,
          reason: 'failed',
          message: causeDetail ? `${hint}（${causeDetail.slice(0, 160)}）` : hint,
        };
      }
      const message = causeDetail || (err instanceof Error ? err.message : String(err));
      this.logger?.warn?.(`compact failed: key=${key} err=${message}`);
      return { ok: false, reason: 'failed', message };
    } finally {
      active.delete(key);
    }
  }

  /**
   * 轮次结束后按上下文大小自动压缩（后台执行，不阻塞下一条消息）。
   *
   * dsh 默认阈值按模型窗口算（deepseek-flash 约 678k token），群聊会话几乎碰不到；
   * 这里对 QQ 会话主动压缩，阈值与推迟规则见 features/compact-policy。压缩期间进来的消息由
   * agent 排队，压完再跑。正忙、正在压缩或还不知道上下文大小时跳过，下一轮再判断。
   */
  maybeAutoCompact(record: SessionRecord): void {
    if (this.personaTransitions?.has(record.sessionKey)) return;
    if (this.sessions !== undefined && this.sessions.get(record.sessionKey) !== record) return;
    if (this.combatAgents?.current(record.sessionKey) !== undefined) return;
    if (this.combatAgents?.isCombatAgent(record.agent)) return;
    if ((this.config.autoCompactTokens ?? 0) <= 0 || record.compacting) return;
    if (record.contextTokens === undefined || record.agent.status !== 'idle') return;

    // 先占住标记：查窗口是异步的，期间不能再触发一次
    record.compacting = true;
    void this.autoCompact(record)
      .catch((err: unknown) => {
        this.logger.warn(`im-qqbot: 自动压缩失败 key=${record.sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        record.compacting = false;
      });
  }

  /** 汇总当前会话阻塞后台压缩的原因（显式事务租约、人设切换、待答问题/审批、未结算后台任务）。 */
  getContextLockStatus(record: SessionRecord, now: number = Date.now()): { locked: boolean; reasons: string[] } {
    const reasons = [...(this.contextLocks?.status?.(record.sessionKey, now).reasons ?? [])];
    const switchState = this.getPersonaSwitchState?.(record.scope, record.peerId)
      ?? SessionManager.prototype.getPersonaSwitchState.call(this, record.scope, record.peerId);
    if (switchState !== 'idle' && !reasons.includes('persona-switch')) reasons.push('persona-switch');
    if ((this.dndTransitions?.has(record.sessionKey) || this.dndEndPreparing?.has(record.sessionKey)) && !reasons.includes('dnd-end-prep')) {
      reasons.push('dnd-end-prep');
    }
    if (this.questionChannel?.hasPending?.(record.sessionKey) && !reasons.includes('pending-question')) {
      reasons.push('pending-question');
    }
    if (this.approvalChannel?.hasPending?.(record.sessionKey) && !reasons.includes('pending-approval')) {
      reasons.push('pending-approval');
    }
    const events = record.agent?.session?.snapshotEvents?.() ?? record.agent?.session?.events;
    if (hasOpenBackgroundJobs(events) && !reasons.includes('background-job')) {
      reasons.push('background-job');
    }
    return { locked: reasons.length > 0, reasons };
  }

  private async autoCompact(record: SessionRecord): Promise<void> {
    const before = record.contextTokens;
    const contextWindow = await this.contextWindowOf(record);
    const threshold = compactThreshold(record.scope, contextWindow, {
      autoCompactTokens: this.config.autoCompactTokens ?? 0,
      autoCompactPrivateRatio: this.config.autoCompactPrivateRatio ?? 0,
      autoCompactDeferOnTools: this.config.autoCompactDeferOnTools ?? false,
    });
    const usedTools = lastTurnUsedTools(sessionEventsOf(record));
    const lock = this.getContextLockStatus?.(record)
      ?? SessionManager.prototype.getContextLockStatus.call(this, record);
    const decision = decideAutoCompact({
      contextTokens: before,
      threshold,
      contextWindow,
      lastTurnUsedTools: usedTools,
      deferOnTools: this.config.autoCompactDeferOnTools ?? false,
      contextLocked: lock.locked,
    });
    if (decision === 'defer') {
      const reasonText = lock.locked
        ? `事务锁持有中（${lock.reasons.join('、')}）`
        : '上一轮还在调工具';
      this.logger.info(
        `im-qqbot: 自动压缩推迟 key=${record.sessionKey} 上下文≈${before} tokens ≥ 阈值 ${threshold}，${reasonText}，等收尾轮或到 ${deferCeiling(threshold, contextWindow)} 再压`,
      );
      return;
    }
    if (decision !== 'compact') return;
    // 查窗口期间可能已经开始了下一轮
    if (record.agent.status !== 'idle') return;

    const outcome = await this.compact(record.scope, record.peerId);
    if (outcome.ok) {
      record.contextTokens = undefined; // 下一次请求后重新测量
      this.logger.info(
        `im-qqbot: 自动压缩 key=${record.sessionKey} 上下文≈${before} tokens（阈值 ${threshold}）→ 摘要替换 ${outcome.shadowed ?? 0} 条（约 ${outcome.tokens ?? 0} tokens）`,
      );
    } else {
      this.logger.warn(`im-qqbot: 自动压缩跳过 key=${record.sessionKey} reason=${outcome.reason}${outcome.message ? ` ${outcome.message}` : ''}`);
    }
  }

  /**
   * 空闲压缩：每分钟扫一遍，空闲够久、上下文够大、上游在名单里的会话压一次（规则见 features/compact-policy）。
   * 每段空闲只试一次：成功后 contextTokens 清空，失败则靠 idleCompactTriedAt 挡住，免得每分钟重试。
   */
  checkIdleCompact(now: number = Date.now()): void {
    const minIdleMs = (this.config.idleCompactMinutes ?? 0) * 60_000;
    const minTokens = this.config.idleCompactTokens ?? 0;
    if (minIdleMs <= 0 || minTokens <= 0) return;

    for (const record of this.sessions.values()) {
      if (this.personaTransitions?.has(record.sessionKey)) continue;
      if (this.combatAgents?.current(record.sessionKey) !== undefined) continue;
      if (record.compacting || record.idleCompactTriedAt === record.lastActivity) continue;
      if (record.agent.status !== 'idle') continue;
      const lock = this.getContextLockStatus?.(record, now)
        ?? SessionManager.prototype.getContextLockStatus.call(this, record, now);
      const eligible = shouldIdleCompact({
        contextTokens: record.contextTokens,
        minTokens,
        idleMs: now - record.lastActivity,
        minIdleMs,
        provider: this.routeOf(record)?.provider,
        providers: this.config.idleCompactProviders ?? '',
        contextLocked: lock.locked,
      });
      if (!eligible) continue;

      const before = record.contextTokens;
      const idleMinutes = Math.round((now - record.lastActivity) / 60_000);
      record.compacting = true;
      record.idleCompactTriedAt = record.lastActivity;
      void this.compact(record.scope, record.peerId)
        .then((outcome) => {
          if (outcome.ok) {
            record.contextTokens = undefined; // 下一次请求后重新测量
            this.logger.info(
              `im-qqbot: 空闲压缩 key=${record.sessionKey} 空闲 ${idleMinutes} 分钟，上下文≈${before} tokens → 摘要替换 ${outcome.shadowed ?? 0} 条（约 ${outcome.tokens ?? 0} tokens）`,
            );
          } else {
            this.logger.warn(`im-qqbot: 空闲压缩跳过 key=${record.sessionKey} reason=${outcome.reason}${outcome.message ? ` ${outcome.message}` : ''}`);
          }
        })
        .catch((err: unknown) => {
          this.logger.warn(`im-qqbot: 空闲压缩失败 key=${record.sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          record.compacting = false;
        });
    }
  }

  /** 会话最近一次请求实际用的 provider/model；还没发过请求时退回解析出的路由 */
  private routeOf(record: SessionRecord): { provider?: string; model?: string } | undefined {
    const header = record.agent.session.requestHeader?.()?.config;
    return header?.provider && header.model
      ? { provider: header.provider, model: header.model }
      : this.modelResolver.getEffectiveRoute(record.sessionKey);
  }

  /** 按会话实际路由的模型查上下文窗口（按 provider/model 缓存）；查不到返回 undefined，私聊退回固定阈值 */
  private async contextWindowOf(record: SessionRecord): Promise<number | undefined> {
    const route = this.routeOf(record);
    if (!route?.provider || !route.model) return undefined;
    const key = `${route.provider}/${route.model}`;
    if (this.contextWindows.has(key)) return this.contextWindows.get(key);

    let window: number | undefined;
    try {
      const llm = this.ctx.get('llm') as ModelInfoLlm | undefined;
      const info = await llm?.resolveModelInfo?.(route.provider, route.model);
      window = info?.context?.contextWindow;
    } catch (err) {
      this.logger.debug(`contextWindowOf ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 查不到也缓存，免得每轮都查；换模型会换 key
    this.contextWindows.set(key, window);
    return window;
  }

  async disposeAll(): Promise<void> {
    this.disposing = true;
    this.evictor.dispose();
    clearInterval(this.idleCompactTimer);
    this.dndEndPreparing?.clear();
    this.contextLocks?.clearAll();
    this.stagedNoteRecalls.clear();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    for (const record of records) {
      record.agent.cancel({ kind: 'user' });
    }
    await this.combatAgents?.dispose();
    await Promise.allSettled(records.map((r) => r.handle.dispose()));
    this.logger.info(`all sessions disposed (count=${records.length})`);
  }

  get size(): number {
    return this.sessions.size;
  }
}

function sessionEventsOf(record: SessionRecord | undefined): readonly SessionEventLike[] {
  return record?.agent?.session?.snapshotEvents?.() ?? record?.agent?.session?.events ?? [];
}

function extractCompactionCause(err: unknown): { message: string; isNotSmaller: boolean } {
  const seen = new Set<unknown>();
  const causes: string[] = [];
  let cursor = err instanceof Error
    ? err.cause
    : (err !== null && typeof err === 'object' && 'cause' in err ? (err as { cause?: unknown }).cause : undefined);
  while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    const msg = cursor instanceof Error ? cursor.message : typeof cursor === 'string' ? cursor : String(cursor);
    if (msg) causes.push(msg);
    cursor = cursor instanceof Error
      ? cursor.cause
      : (typeof cursor === 'object' && 'cause' in cursor ? (cursor as { cause?: unknown }).cause : undefined);
  }
  const message = causes[causes.length - 1] ?? '';
  const isNotSmaller = causes.length === 0 || /not smaller|no compactable/i.test(causes.join(' | '));
  return { message, isNotSmaller };
}

function extractEventUsage(event: SessionEventLike): TokenUsageStats | undefined {
  const dataUsage = (event.data as { usage?: Record<string, unknown> } | undefined)?.usage;
  const legacyUsage = event.usage as Record<string, unknown> | undefined;
  const raw = dataUsage ?? legacyUsage;
  if (!raw || typeof raw !== 'object') return undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input: num(raw.inputTokens ?? raw.input),
    output: num(raw.outputTokens ?? raw.output),
    cacheRead: num(raw.cacheReadTokens ?? raw.cacheRead),
    cacheWrite: num(raw.cacheWriteTokens ?? raw.cacheWrite),
  };
}

function extractEventMessageText(event: SessionEventLike): string {
  const data = event.data as {
    message?: SessionEventLike['message'];
    content?: Array<{ type: string; text?: string }>;
  } | undefined;
  const message = data?.message
    ?? (Array.isArray(data?.content) ? { content: data.content } : undefined)
    ?? event.message;
  return extractMessageText(message);
}

/** 从消息对象中提取纯文本（用于导出/统计） */
function extractMessageText(
  message: SessionEventLike['message'],
): string {
  const blocks = message?.content;
  if (!blocks || !Array.isArray(blocks)) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}
