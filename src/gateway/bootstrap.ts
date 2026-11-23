/**
 * 网关组装 — 创建 bot、编排中间件、注册事件、出站、生命周期
 *
 * 将 QQ 消息平台作为 dsh 前端协议驱动：入站消息 → handleInbound → dsh agent，
 * dsh session/event → createOutboundHandler → QQ 出站。
 */
import type { Context } from '@deepseek-ai/cordis';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import type { GatewayDisconnect, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { SessionManager, type DshAgent, type DshAgentRegistry } from '../session/index.ts';
import { handleInbound, createOutboundHandler } from '../transport/index.ts';
import { SelfSentIndex } from '../transport/self-sent.ts';
import { parseStreamFrame } from '../transport/events.ts';
import { isAutoSteerTurnEnd } from '../transport/turn-steer.ts';
import { cacheMsgId } from '../transport/msgid-cache.ts';
import type { ToolsRegistryLike } from '../transport/tool-presenter.ts';
import { QuestionChannel } from '../features/question-channel.ts';
import { ApprovalChannel, type ApprovalChannelContext } from '../features/approval-channel.ts';
import { singingWaitGuard } from '../features/singing-wait-guard.ts';
import { MediaReviewCoordinator } from '../features/media-review-coordinator.ts';
import { PersonaStore, resolvePersonasDir } from '../features/persona-store.ts';
import { PersonaSwitch } from '../features/persona-switch.ts';
import { ToolAccess, ToolAccessStore } from '../features/tool-access.ts';
import { GroupAccess, type GroupAccessFeature } from '../features/group-access.ts';
import { registerAccessTool } from '../features/access-tool.ts';
import { SessionToolScope } from '../features/session-tool-scope.ts';
import type { JudgeLlm } from '../features/reply-judge.ts';
import { NoteJudge } from '../features/note-judge.ts';
import { NoteMetricsStore } from '../notes/note-metrics.ts';
import { DndTurnButtons } from '../dnd/turn-buttons.ts';
import { MEDIA_ROOT } from '../media/media-cleaner.ts';
import { startCleanup } from '../media/cleanup.ts';
import { ensureTmpDir, resolveTmpDir } from '../media/tmp-dir.ts';
import { PLUGIN_ROOT, buildUserAgent, isPrivilegedSender, privilegedOpenids, resolveProfileDir } from '../shared/index.ts';
import { createToolGuard } from '../shared/tool-guard.ts';
import { updateProfileAllowedGroups } from '../setup/persist.ts';
import { NOTE_JUDGE_DEFAULTS, type ImQQBotConfig } from '../config.ts';
import {
  onHostAgentLifecycle,
  onHostAgentTurnStopping,
  onHostAssistantStream,
  onHostSessionEvent,
  registerHostEffect,
} from '../host-adapter/index.ts';
import type { Logger } from '../types.ts';
import { setupMiddlewares } from './middleware-setup.ts';
import { bindInteractionHandler, dispatchInteraction } from './interaction.ts';
import { createDndService, createNotesStore, createStickerStore } from './stores.ts';
import { createGatewaySenders } from './senders.ts';
import { registerGatewayTools } from './media-tools.ts';
import { startModelWatch } from './model-watch.ts';
import { wireDndTools } from './dnd-wiring.ts';

export { dispatchInteraction };

export async function bootstrapGateway(
  ctx: Context,
  agents: DshAgentRegistry,
  config: ImQQBotConfig,
  logger: Logger,
): Promise<void> {
  const manager = new SessionManager(ctx, agents, config, logger);

  // 配置权限：owner/admin 为空时保持旧行为，但明确提示风险
  if (privilegedOpenids(config).length === 0) {
    logger.warn('im-qqbot: 未配置 ownerOpenid/adminOpenids，配置命令与审批对所有通过访问控制的用户开放');
  }

  // ── 核心存储（表情收藏 / 共享笔记 / 跑团） ──
  const stickerStore = createStickerStore(config, logger);
  manager.stickerStore = stickerStore;

  const notesStore = createNotesStore(config, logger);
  manager.notesStore = notesStore;
  // 注入账本：只观察「哪几段真的进了提示词」，先跑一周看分布再谈调权
  if (notesStore !== undefined) manager.noteMetrics = new NoteMetricsStore(undefined, logger);

  const dndService = createDndService(config, logger);
  manager.dndService = dndService;

  // ── 初始化 QQ Bot SDK ──
  const userAgent = buildUserAgent();
  const bot = new QQBot({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    userAgent,
    logger,
  } as ConstructorParameters<typeof QQBot>[0]);
  logger.info(`QQBot SDK initialized (UA: ${userAgent})`);

  // ── 中间件链（llm 给回复欲望的模型打分用，可选） ──
  let llm: JudgeLlm | undefined;
  try {
    llm = ctx.get('llm') as JudgeLlm | undefined;
  } catch {
    llm = undefined;
  }
  // 笔记相关性打分和回复欲望打分共用同一个 llm 服务；开关在 notes.judge.enabled，每轮结算时读
  if (manager.noteMetrics !== undefined && llm?.stream !== undefined) {
    manager.noteJudge = new NoteJudge(llm, () => config.notes?.judge ?? NOTE_JUDGE_DEFAULTS, logger);
  }
  // 自己发出去的消息不进 SDK 的 ref 索引，这里单独记一份，引用解析时才能认出「你自己」
  const selfSent = new SelfSentIndex();
  // 所有文字发送（回复、DnD 卡片、审批、提问……）都经 messageApi，在这里统一按 ref_idx 记
  bot.messageApi.onMessageSent((refIdx, meta) => {
    selfSent.record(refIdx, meta.text ?? meta.ttsText ?? '');
  });
  setupMiddlewares(bot, config, manager, logger, llm, selfSent);

  // ── 入站：经过中间件链后的消息交给 dsh agent ──
  bot.on('message', async (mCtx: MiddlewareContext) => {
    const msg = mCtx.message;
    // 记录最近 msgId，供无上下文的出站发送（文件发送显式 target、主动推送等）获取被动回复目标
    cacheMsgId(mCtx.replyTarget.scope, mCtx.replyTarget.targetId, mCtx.replyTarget.msgId);
    if (config.debug) {
      logger.debug(`← message (post-middleware): ${JSON.stringify(msg, null, 2).slice(0, 500)}`);
    }
    await handleInbound(mCtx, manager, config, logger);
  });

  // ── 出站：dsh session/event → QQ 消息 ──
  let toolsRegistry: ToolsRegistryLike | undefined;
  try {
    toolsRegistry = ctx.get('tools') as ToolsRegistryLike | undefined;
  } catch {
    toolsRegistry = undefined;
  }

  const senders = createGatewaySenders({ bot, config, manager, selfSent });
  const { sender, mediaSender } = senders;

  const outbound = createOutboundHandler(manager, sender, config, logger, toolsRegistry, stickerStore);
  const mediaReview = new MediaReviewCoordinator(outbound, (message) => logger.warn(message));
  manager.mediaReview = mediaReview;
  onHostSessionEvent<
    Parameters<typeof outbound.routeSessionEvent>[0],
    Parameters<typeof outbound.routeSessionEvent>[1]
  >(ctx, (session, event) => {
    outbound.routeSessionEvent(session, event);
    if (event.type === 'turn/end' && !isAutoSteerTurnEnd((event as unknown as { data?: { reason?: unknown }; reason?: unknown }).data?.reason
      ?? (event as unknown as { reason?: unknown }).reason)) mediaReview.ended(session.header.id);
  });
  onHostAgentTurnStopping<DshAgent>(ctx, async ({ agent, signal }) => {
    if (manager.findByAgent(agent)) await mediaReview.stopping(agent, signal);
  });

  // ── 出站流式：agent/assistant-stream → 流式帧路由 ──
  onHostAssistantStream(ctx, (payload: unknown) => {
    const parsed = parseStreamFrame(payload);
    if (parsed !== undefined) outbound.routeStreamFrame(parsed.agentId, parsed.delta);
  });

  // ── 互动通道（问答 / 审批 / 跑团回合 / 人设 / 权限授权） ──
  const questionChannel = new QuestionChannel(manager, sender, config, logger);
  manager.questionChannel = questionChannel;
  questionChannel.install(ctx);

  const approvalChannel = new ApprovalChannel(
    manager,
    sender,
    logger,
    (senderId) => isPrivilegedSender(senderId, config),
  );
  manager.approvalChannel = approvalChannel;
  approvalChannel.install(ctx as unknown as ApprovalChannelContext);

  const dndButtons = dndService !== undefined && config.dnd?.turnButtons !== false
    ? new DndTurnButtons(dndService, manager, sender, logger)
    : undefined;
  manager.dndButtons = dndButtons;

  const personasDir = resolvePersonasDir({ root: config.personas?.root, cwd: config.cwd, pluginRoot: PLUGIN_ROOT });
  const personaStore = new PersonaStore({ dir: personasDir, logger });
  logger.info(`im-qqbot: 聊天人设已就绪 dir=${personaStore.dir}`);
  const personaSwitch = new PersonaSwitch(manager, personaStore, sender, config, logger);
  manager.personaStore = personaStore;
  manager.personaSwitch = personaSwitch;

  const toolAccess = new ToolAccess(config, new ToolAccessStore(), manager, sender, logger);
  manager.toolAccess = toolAccess;
  toolAccess.onChange = (kind, id) => manager.syncSessionTools(kind === 'group' ? 'group' : 'c2c', id);
  try {
    const guardTools = ctx.get('tools') as { guard?: (guard: unknown) => unknown } | undefined;
    if (guardTools?.guard === undefined) {
      logger.warn('im-qqbot: tools.guard 不可用，工具权限拦截未启用');
    } else {
      guardTools.guard(singingWaitGuard((agent) => manager.findByAgent(agent as never) !== undefined));
      logger.info('im-qqbot: 唱歌等待保护已启用（后台等待不占聊天队列）');
      guardTools.guard(createToolGuard({
        config,
        isFullAccess: (session) => toolAccess.isFullAccess(session),
        findSession: (agent) => manager.findByAgent(agent as never),
        roots: [MEDIA_ROOT, resolveTmpDir(config), ...(stickerStore !== undefined ? [stickerStore.root] : []), ...(config.toolAccess?.readRoots ?? [])],
        readOnlyRootsFor: (session) => {
          if (dndService === undefined) return [];
          const dir = dndService.adventureDir(manager.sessionKey(session.scope, session.peerId));
          return dir !== undefined ? [dir] : [];
        },
        noWriteRoots: dndService !== undefined ? [dndService.store.root] : [],
        cwd: config.cwd || process.cwd(),
      }));
      logger.info(`im-qqbot: 工具权限拦截已启用 白名单群=${config.toolAccess?.fullAccessGroups.length ?? 0}+${toolAccess.store.groups.length}`);
    }
  } catch (err) {
    logger.warn(`im-qqbot: 工具权限拦截注册失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  const registerGroupAccess = (feature: GroupAccessFeature): GroupAccess | undefined => {
    if (!config[feature]?.enabled || !config.ownerOpenid?.trim()) return undefined;
    const access = new GroupAccess(feature, config, manager, sender, logger, (groups) => updateProfileAllowedGroups(
      feature, groups, resolveProfileDir(ctx.baseUrl) ?? undefined, logger, config[feature]?.allowedGroups,
    ));
    access.onChange = (group) => manager.syncSessionTools('group', group);
    return access;
  };
  const groupAccess = { browser: registerGroupAccess('browser'), imageGen: registerGroupAccess('imageGen') };
  registerAccessTool(ctx, { terminal: toolAccess, browser: groupAccess.browser, imageGen: groupAccess.imageGen }, logger);

  bindInteractionHandler(bot, manager, dndButtons, toolAccess, groupAccess, personaSwitch);

  bot.on('error', (err: unknown) => {
    logger.error(`bot error: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 掉线可观测：willReconnect=false 表示不会再重连（随后 bot.start() 的 Promise 会失败）。
  // disconnected 事件为 SDK 1.0.5+ 新增：旧版 handlers 表缺该键，bot.on 会抛
  // TypeError（profiles 增量安装可能残留旧版 SDK）——降级为跳过监听而非崩溃
  try {
    bot.on('disconnected', (event: GatewayDisconnect) => {
      const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
      if (event.willReconnect) {
        logger.warn(`Bot disconnected (${detail}), reconnecting...`);
      } else {
        logger.error(`Bot disconnected permanently (${detail}), giving up`);
      }
    });
  } catch (err) {
    logger.warn(`qqbot-nodejs SDK 不支持 disconnected 事件（请升级 @tencent-connect/qqbot-nodejs 至 1.0.5+）: ${err instanceof Error ? err.message : String(err)}`);
  }

  bot.on('ready', () => {
    console.log(`[im-qqbot] Bot ready! appId=${config.appId}`);
  });

  // ── 临时目录、定期清理、工具集、上游健康监测、跑团装配 ──
  ensureTmpDir(resolveTmpDir(config), logger);
  startCleanup(ctx, config, logger);
  await registerGatewayTools({ ctx, config, manager, senders, stickerStore, notesStore, logger });
  const modelWatch = startModelWatch({ bot, config, manager, logger });
  if (dndService !== undefined) {
    wireDndTools({ ctx, agents, config, manager, dndService, dndButtons, mediaSender, logger });
  }

  // L0 按会话/宿主作用域隐藏确定不可用的非跑团工具（须在全部工具与 combatAgents 就绪后挂接）
  const sessionToolScope = new SessionToolScope({
    config,
    isFullAccess: (session) => toolAccess.isFullAccess(session),
    isCombatAgent: (agent) => manager.combatAgents?.isCombatAgent(agent as DshAgent) === true,
    logger,
  });
  manager.sessionToolScope = sessionToolScope;
  onHostAgentLifecycle<DshAgent>(ctx, 'agent/created', ({ agent }) => { if (agent !== undefined) sessionToolScope.hideForNonQq(agent); });
  onHostAgentLifecycle<DshAgent>(ctx, 'agent/disposed', ({ agent }) => { if (agent !== undefined) sessionToolScope.release(agent); });
  try {
    for (const agent of (agents as { list?(): DshAgent[] }).list?.() ?? []) sessionToolScope.hideForNonQq(agent);
  } catch (err) {
    logger.debug(`im-qqbot: 列不出现有 agent，会话工具仅对之后新建的隐藏: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 生命周期 ──
  registerHostEffect(ctx, () => {
    logger.info(`Starting bot (appId=${config.appId})`);
    bot.start().catch((err: unknown) => {
      logger.error(`Bot start failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    return async () => {
      logger.info('Shutting down');
      senders.dispose();
      modelWatch?.stop();
      // 待答问题挂在旧实例上，重载后没人能答：先让它们以 ASK_ABORTED 结束
      questionChannel.uninstall();
      manager.sessionToolScope?.disposeAll();
      manager.dndToolScope?.disposeAll();
      await manager.disposeAll();
      // 停掉账本的定时器并把最后一分钟刷盘，否则每次重组都留下一个还在写同一个文件的旧实例
      manager.noteMetrics?.dispose();
      bot.stop();
    };
  }, 'im-qqbot.lifecycle');
}
