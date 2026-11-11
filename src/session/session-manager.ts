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
import { chatKeyOf, formatNotesHint, selectNotesForInjection, type NotesStore } from '../notes/notes-store.ts';
import type { NoteMetricsStore } from '../notes/note-metrics.ts';
import { buildHandoffTranscript, formatHandoffHint, type HandoffTurn, type HandoffWriter } from '../features/session-handoff.ts';
import type { ToolAccess } from '../features/tool-access.ts';
import type { DndService } from '../dnd/dnd-service.ts';
import { PromptLatch } from '../features/prompt-latch.ts';
import type { DndTurnButtons } from '../dnd/turn-buttons.ts';
import { resolveTmpDir } from '../media/tmp-dir.ts';
import { isVoiceFile, VOICE_REPLY_REMINDER } from '../media/voice-reply.ts';
import { join } from 'node:path';
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
import type { PersonaStore } from '../features/persona-store.ts';
import type { PersonaSwitch, SwitchPersonaOutcome } from '../features/persona-switch.ts';
import { compactThreshold, decideAutoCompact, deferCeiling, lastTurnUsedTools, shouldIdleCompact } from '../features/compact-policy.ts';
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

/** ctx.llm 查模型窗口的最小接口 */
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

/** 这个 agent 所在会话的团况快照文字；不是 QQ 会话、没开团或读取失败都返回空串 */
export function dndStateText(
  agent: DshAgent | undefined,
  findRecord: (agent: DshAgent) => SessionRecord | undefined,
  dnd: Pick<DndService, 'stateSnapshot'> | undefined,
  logger: Logger,
): string {
  if (agent === undefined || dnd === undefined) return '';
  const record = findRecord(agent);
  if (record === undefined) return '';
  try {
    return dnd.stateSnapshot(record.sessionKey);
  } catch (err) {
    logger.warn(`im-qqbot: 注入团况失败: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

export function recentSenderIds(record: SessionRecord, windowMs: number, now = Date.now()): string[] {
  return [...new Set((record.recentSenders ?? []).filter((s) => now - s.at <= windowMs).map((s) => s.id))];
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  /** 发送失败（常见于群主动消息无权限）的文本，等下一次用户消息时补发 */
  private unsent = new Map<string, string[]>();
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
  /** /new 时写会话交接（llm 服务不可用时缺省，/new 照常只是不带交接） */
  public handoffWriter?: HandoffWriter;
  /** 会话 key → 正在写或已写好的交接；新会话的第一条消息取走 */
  private readonly pendingHandoffs = new Map<string, Promise<string | undefined>>();
  /** 由 bootstrap 注入的工具权限（终端白名单） */
  public toolAccess?: ToolAccess;
  /** 由 bootstrap 注入的跑团服务（/dnd 命令 + DM prompt 注入） */
  public dndService?: DndService;
  /** 一段对话内锁住的 system prompt 文字（表情清单、本群笔记目录），见 PromptLatch */
  private readonly promptLatch = new PromptLatch();
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
        this.logger.info(`evicting idle session: key=${key}`);
        this.sessions.delete(key);
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

      const sections = [...(assembled.sections ?? [])];
      const prompt = record.scope === 'group'
        ? this.personaStore?.current(record.peerId)?.prompt ?? this.config.groupPrompt
        : this.config.directPrompt;
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
            '本会话不在终端白名单里：没有 pwsh/bash/终端，不能派生子 agent；文件工具只能用在 bot 的媒体、表情和临时目录。被拦就直接告诉用户做不到，别换工具绕，也别说出本机路径。',
            '只有 bot 主人能把本群加入白名单：主人明确要求时调用 qqbot_tool_access(action="grant")，它会发确认按钮，主人点了才生效。',
          ].join('\n'),
        });
      }

      if (this.notesStore !== undefined) {
        sections.push({
          name: 'qqbot:shared-notes',
          order: 92,
          text: [
            '【共享笔记】',
            '你有一个所有群和私聊共享的笔记库，是你的长期记忆。消息前出现「[共享笔记 · 可能相关]」时，是按这条消息自动检索到的片段，相关就自然地用上，不相关就忽略，别生硬复述。',
            '想不起来但可能记过的东西，用 qqbot_notes_search 查；看完/学到/群里沉淀下来值得长期记住的，用 qqbot_notes_save 记下（提炼后再记，别记隐私和闲聊）。',
            '只属于当前群的东西（跑团的玩家偏好、DM 约定，这个群成员自己的事）用 qqbot_notes_save(scope="chat") 记，别的群看不到；共享笔记里提到的人和事不一定发生在这个群，别把别的群的跑团进度、角色当成这个群的。',
            '跑团进度、物品、任务线头和待办用 dnd_progress 写进团档，不写笔记；进度以 dnd_* 工具查到的为准。DC、怪物数值、DM 笔记、没揭示的东西任何时候都不写进笔记。',
            '记笔记是你自己的事，不用每次都告诉用户「我记下了」。',
            '另外有一本《人类观察日记》，所有群和私聊共用：遇到人类的回复和你预测的不一样，就往里追加一条，用 qqbot_notes_save(file="人类观察日记.md")，格式固定「预测 / 实际 / 差在哪」，编号取文末最后一个 +1。只记判断失误，不记流水账。',
          ].join('\n'),
        });
      }

      // 跑团：开团的会话每回合注入 DM 守则和不常变的背景；会变的团况走 registerDndStateContext
      if (this.dndService !== undefined) {
        try {
          const dndSections = this.dndService.promptSections(record.sessionKey, epoch);
          sections.push(...dndSections);
          // 开团时本群笔记不走自动注入（见 notesHint），这里只列个目录，玩的时候要用的约定让模型自己去查
          const titles = dndSections.some((s) => s.name === 'qqbot:dnd-dm') ? this.notesStore?.chatNoteTitles(chatKeyOf(record.scope, record.peerId)) ?? [] : [];
          if (titles.length > 0) {
            sections.push({
              name: 'qqbot:dnd-chat-notes',
              order: 98,
              text: this.promptLatch.hold(`${record.sessionKey}|qqbot:dnd-chat-notes`, epoch, `本群笔记（开团期间不自动注入，需要时用 qqbot_notes_search 查，进度以【团况】为准）：${titles.join('；')}`),
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
            ? `${tmpDir} 里 ${ttl} 小时没动过的东西会被自动清理；要长期保留的成果（用户要的文件、笔记）放到用户指定的位置，或用 qqbot_notes_save 记进笔记。`
            : '要长期保留的成果（用户要的文件、笔记）放到用户指定的位置，或用 qqbot_notes_save 记进笔记。',
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
          '没有媒体要发时正常文字回复。语音不支持 caption，按下面的语音发送规则处理。',
          '【语音单独发送】',
          '通过 qqbot_speak 或 qqbot_send_file 发送语音时：' + VOICE_REPLY_REMINDER,
        ].join('\n'),
      });

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
        text: (context) => dndStateText(context.agent, (agent) => this.findByAgent(agent), this.dndService, this.logger),
      });
      scope.systemPrompt.context({
        name: 'qqbot:sticker-additions',
        order: STICKER_ADDITIONS_CONTEXT_ORDER,
        required: true,
        interpolate: false,
        text: (context) => {
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
  async listAvailableModels(): Promise<ModelEntry[]> {
    return this.modelResolver.listModels();
  }

  listProviders(): string[] {
    return this.modelResolver.listProviders();
  }

  // ── 会话状态 / 统计 ──

  getSessionRecord(scope: ChatScope, peerId: string): SessionRecord | undefined {
    return this.sessions.get(this.sessionKey(scope, peerId));
  }

  /** 入站图片本地表情库精确匹配（失败/未启用时返回 undefined，不阻塞消息） */
  matchSticker(path: string): StickerMatchResult | undefined {
    try {
      return this.stickerStore?.match(path);
    } catch {
      return undefined;
    }
  }

  /** 按当前消息检索笔记（共享 + 本会话私有），返回要注入的提示块（未启用/无相关结果/出错时返回空串） */
  async notesHint(query: string, scope: ChatScope, peerId: string): Promise<string> {
    const notes = this.config.notes;
    if (this.notesStore === undefined || !notes?.autoInject || query.trim().length === 0) return '';
    try {
      // 开着团时本群的跑团笔记（旧进度、旧待办）会和每回合注入的实时团况打架，只召回共享笔记
      const campaignRunning = this.dndService?.active(this.sessionKey(scope, peerId)) !== undefined;
      const hits = await this.notesStore.searchHybrid(query, notes.injectTopK * 2, chatKeyOf(scope, peerId), { sharedOnly: campaignRunning });
      const selected = selectNotesForInjection(hits, { topK: notes.injectTopK, minCoverage: notes.injectMinCoverage });
      // 账本记的是「真正进了提示词的段」；只观察，不影响本次注入
      this.noteMetrics?.recordInjection(selected);
      return formatNotesHint(hits, {
        topK: notes.injectTopK,
        maxChars: notes.injectMaxChars,
        minCoverage: notes.injectMinCoverage,
      });
    } catch (err) {
      this.logger.warn(`im-qqbot: 笔记检索失败: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
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
    const route = this.getEffectiveModel(scope, peerId);

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

    const events = record?.agent.session.events;
    if (!events) return stats;

    for (const event of events) {
      if (event.type !== 'assistant/message' || !event.usage) continue;
      stats.input += event.usage.input ?? 0;
      stats.output += event.usage.output ?? 0;
      stats.cacheRead += event.usage.cacheRead ?? 0;
      stats.cacheWrite += event.usage.cacheWrite ?? 0;
    }

    return stats;
  }

  exportMarkdown(scope: ChatScope, peerId: string): string {
    const record = this.getSessionRecord(scope, peerId);
    if (!record) return '';

    const events = record.agent.session.events;
    if (!events || events.length === 0) return '';

    const lines: string[] = [`# QQ 会话导出\n`, `> session: ${record.sessionId}\n`];

    for (const event of events) {
      if (event.type === 'user/message') {
        // 团况快照带 DM 机密（DC、怪物 HP、DM 笔记），不能跟着导出发到群里
        if (isRuntimeContextEvent(event)) continue;
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 用户\n\n${text}\n`);
      } else if (event.type === 'assistant/message') {
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 助手\n\n${text}\n`);
      }
    }

    return lines.join('\n');
  }

  private countMessages(record: SessionRecord | undefined): number {
    const events = record?.agent.session.events;
    if (!events) return 0;

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

  /** 该 peer 当前（或下一次 getOrCreate 将使用）的 sessionId */
  sessionIdFor(scope: ChatScope, peerId: string): string {
    const record = this.sessions.get(this.sessionKey(scope, peerId));
    return record?.sessionId ?? this.currentSessionId(this.sessionKey(scope, peerId));
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
      sessionId,
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
    // 活会话的 Web 选择已经在宿主生效。旧 per-chat 偏好只用于 resume/create，
    // 不在插件重组后重新安装竞争选择器、也不把旧偏好当成一次新的切换。
    if (!live) this.syncExplicitRoute(record);
    return record;
  }

  findBySessionId(sessionId: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) return record;
    }
    const currentKey = this.retiredSessionIds.get(sessionId);
    return currentKey === undefined ? undefined : this.sessions.get(currentKey);
  }

  findByAgent(agent: DshAgent): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.agent === agent) return record;
    }
    return undefined;
  }

  /**
   * 切换群人设：记下当前人设用的会话，换到目标人设自己的会话（第一次用就是新会话）。
   * 群历史游标绑定 sessionId，换会话后会重新注入最近的群聊，上下文不会断。
   */
  switchPersona(groupId: string, personaId: string): SwitchPersonaOutcome {
    const store = this.personaStore;
    const currentId = store?.currentId(groupId);
    if (store === undefined || currentId === personaId) return 'same';
    const key = this.sessionKey('group', groupId);
    // 开团的存档跟着会话走，中途换人设 DM 就换人了
    if (this.dndService?.active(key) !== undefined) return 'dnd';
    const record = this.sessions.get(key);
    if (record !== undefined && record.agent.status !== 'idle') return 'busy';
    store.rememberSession(groupId, currentId!, record?.sessionId ?? this.currentSessionId(key));
    store.select(groupId, personaId);
    void this.remove('group', groupId, store.sessionFor(groupId, personaId) ?? randomUUID());
    return 'ok';
  }

  /**
   * /new：换新会话，并在后台把旧会话写成交接留给新会话的第一条消息。
   * 不等交接写完就返回：/new 的回执不该被一次模型调用拖住，等待放在 takeHandoff 里。
   * 返回是否在写交接（命令回执用）。
   */
  startNewSession(scope: ChatScope, peerId: string, options: { handoff: boolean }): boolean {
    const key = this.sessionKey(scope, peerId);
    const handoff = options.handoff ? this.beginHandoff(key) : undefined;
    if (handoff === undefined) this.pendingHandoffs.delete(key);
    else this.pendingHandoffs.set(key, handoff);
    void this.remove(scope, peerId);
    return handoff !== undefined;
  }

  /** 旧会话还在内存里、聊过几句、没在跑团时才写；否则返回 undefined */
  private beginHandoff(key: string): Promise<string | undefined> | undefined {
    const record = this.sessions.get(key);
    const route = this.modelResolver.getEffectiveRoute(key);
    if (this.handoffWriter === undefined || record === undefined || route?.provider === undefined || route.model === undefined) return undefined;
    // 团档有自己的停团交接，而且旧会话里全是 DM 机密
    if (this.dndService?.active(key) !== undefined) return undefined;
    const turns: HandoffTurn[] = [];
    for (const event of record.agent.session.events ?? []) {
      if (event.type === 'user/message' && !isRuntimeContextEvent(event)) turns.push({ role: 'user', text: extractMessageText(event.message) });
      else if (event.type === 'assistant/message') turns.push({ role: 'assistant', text: extractMessageText(event.message) });
    }
    const transcript = buildHandoffTranscript(turns);
    if (transcript === undefined) return undefined;
    return this.handoffWriter.write({ provider: route.provider, model: route.model, transcript });
  }

  /** 取走会话交接（只给新会话的第一条消息一次）；还在写就等它写完 */
  async takeHandoff(scope: ChatScope, peerId: string): Promise<string | undefined> {
    const key = this.sessionKey(scope, peerId);
    const pending = this.pendingHandoffs.get(key);
    if (pending === undefined) return undefined;
    this.pendingHandoffs.delete(key);
    const summary = await pending;
    return summary === undefined ? undefined : formatHandoffHint(summary);
  }

  async remove(scope: ChatScope, peerId: string, nextSessionId: string = randomUUID()): Promise<void> {
    const key = this.sessionKey(scope, peerId);
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

    if (!record) return;
    this.sessions.delete(key);
    this.modelSelections.delete(record.agent);
    record.agent.cancel({ kind: 'user' });
    await record.handle.dispose().catch(() => {});
    this.logger.info(`session removed: key=${key}`);
  }

  /**
   * 原地压缩当前会话历史（保留 sessionId，用摘要替换旧历史）。
   *
   * 需通过 agentPresets.serviceFor(agent, 'compaction') 解析；未挂载时优雅降级。
   * 这是「压缩上下文」的语义，区别于 remove() 的「换新会话」。
   */
  async compact(scope: ChatScope, peerId: string): Promise<CompactOutcome> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    if (!record) return { ok: false, reason: 'no-session' };
    if (record.agent.status !== 'idle') return { ok: false, reason: 'busy' };

    let compaction: CompactionServiceLike | undefined;
    try {
      const presets = this.getPresetsService();
      compaction = (presets?.serviceFor(record.agent, 'compaction') ?? this.ctx.get('compaction')) as CompactionServiceLike | undefined;
    } catch {
      compaction = undefined;
    }
    if (!compaction) return { ok: false, reason: 'unavailable' };

    const route = this.modelResolver.getEffectiveRoute(key);
    const agentCtx = {
      session: record.agent.session,
      options: { provider: route?.provider, model: route?.model },
      runMaintenance: record.agent.runMaintenance.bind(record.agent),
    };

    try {
      const result = await compaction.compactNow(agentCtx, new AbortController().signal);
      if (result === null) return { ok: true, shadowed: 0, tokens: 0 };
      return { ok: true, shadowed: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // summary = 摘要没有更小 = 历史不足以压缩，属正常结果而非失败
      if (code === 'summary') {
        return { ok: true, shadowed: 0, tokens: 0 };
      }
      // 其他 ManualCompactionError 预期失败，给友好文案（debug 记录，不 warn 刷屏）
      if (code !== undefined && code in COMPACTION_ERROR_HINTS) {
        this.logger.debug(`compact declined: key=${key} code=${code}`);
        return { ok: false, reason: 'failed', message: COMPACTION_ERROR_HINTS[code] };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`compact failed: key=${key} err=${message}`);
      return { ok: false, reason: 'failed', message };
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

  private async autoCompact(record: SessionRecord): Promise<void> {
    const before = record.contextTokens;
    const contextWindow = await this.contextWindowOf(record);
    const threshold = compactThreshold(record.scope, contextWindow, {
      autoCompactTokens: this.config.autoCompactTokens ?? 0,
      autoCompactPrivateRatio: this.config.autoCompactPrivateRatio ?? 0,
      autoCompactDeferOnTools: this.config.autoCompactDeferOnTools ?? false,
    });
    const usedTools = lastTurnUsedTools(record.agent.session.events);
    const decision = decideAutoCompact({
      contextTokens: before,
      threshold,
      contextWindow,
      lastTurnUsedTools: usedTools,
      deferOnTools: this.config.autoCompactDeferOnTools ?? false,
    });
    if (decision === 'defer') {
      this.logger.info(
        `im-qqbot: 自动压缩推迟 key=${record.sessionKey} 上下文≈${before} tokens ≥ 阈值 ${threshold}，上一轮还在调工具，等收尾轮或到 ${deferCeiling(threshold, contextWindow)} 再压`,
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
      if (record.compacting || record.idleCompactTriedAt === record.lastActivity) continue;
      if (record.agent.status !== 'idle') continue;
      const eligible = shouldIdleCompact({
        contextTokens: record.contextTokens,
        minTokens,
        idleMs: now - record.lastActivity,
        minIdleMs,
        provider: this.routeOf(record)?.provider,
        providers: this.config.idleCompactProviders ?? '',
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
    this.evictor.dispose();
    clearInterval(this.idleCompactTimer);
    const records = [...this.sessions.values()];
    this.sessions.clear();
    for (const record of records) {
      record.agent.cancel({ kind: 'user' });
    }
    await Promise.allSettled(records.map((r) => r.handle.dispose()));
    this.logger.info(`all sessions disposed (count=${records.length})`);
  }

  get size(): number {
    return this.sessions.size;
  }
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
