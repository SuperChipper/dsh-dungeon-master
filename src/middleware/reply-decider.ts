/**
 * 回复欲望门控中间件 — 接在 mentionGate({ passthrough: true }) 之后。
 *
 * mentionGate 已放行的（被 @ / 待结算反应 / 私聊）直接通过，群里被 @ 或隐式触发时顺带开对话窗口；
 * 没放行的群消息：
 *   - 有灰区裁判（默认）：仅硬过滤（@ 别人、斜杠命令、空消息、纯语气词、表情包冷却/防互刷）与表情包接龙复读
 *     走规则直判；其余消息（含提到昵称、窗口内文字/纯图、非冷却表情包与开团旁观插话）统一经防抖进入
 *     ReplyJudge，并把窗口状态、昵称命中、表情包收藏与跑团态作为线索喂给模型。
 *   - 对话窗口内且打分模型支持 image 输入时，按需下载并附带最新 2 张图片（含纯图截图与非冷却表情包），
 *     复用 history-images 的本地缓存避免放行后重复下载；模型不支持看图或下载失败时自动回退纯文本打分。
 *   - 开团且 `dnd.interjections === false` 时直接拦截；允许插嘴时切用极克制的「旁观 DM」专用提示词，
 *     放行后依然不带 (@you) 标签，跑团里按旁观插嘴处理。
 *   - 无 llm 服务时降级为纯规则分数阈值放行（开团期间仍不开窗）。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { REPLY_JUDGE_DEFAULTS, type ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import {
  classifyMessage,
  getEngagementTracker,
  hasImageAttachment,
  isJudgeCandidate,
  scoreReplyDesire,
  type DesireAttachment,
  type DesireResult,
} from '../features/reply-desire.ts';
import type { JudgeHints, JudgeImage, JudgeLine, JudgeQueue, ReplyJudge } from '../features/reply-judge.ts';
import { isBotMemoryEntry, readRecentGroupMessages } from '../features/group-memory.ts';
import { downloadRecentHistoryImages, type HistoryImage } from '../media/history-images.ts';
import { isImageContentType } from '../transport/attachment.ts';
import { attachableImageFor } from '../transport/inbound.ts';

/** 窗口内传给灰区打分模型的最多图片张数（越新越优先） */
export const MAX_JUDGE_IMAGES = 2;
/** 灰区看图单张字节上限（避免超大原图拖慢打分） */
const MAX_JUDGE_IMAGE_BYTES = 6 * 1024 * 1024;
/** 灰区看图下载超时上限 */
const MAX_JUDGE_DOWNLOAD_MS = 8_000;

interface MentionState {
  wasMentioned: boolean;
  implicit: boolean;
  shouldAnswer: boolean;
  reason: string;
}

export interface JudgeDeps {
  judge: Pick<ReplyJudge, 'score'> & Partial<Pick<ReplyJudge, 'supportsImageInput'>>;
  queue: JudgeQueue;
  /** 可选注入点（供单测替换网络下载），默认复用 downloadRecentHistoryImages（含 URL 缓存） */
  downloadImages?: typeof downloadRecentHistoryImages;
  /** 可选注入点（供单测替换动图抽帧），默认复用 attachableImageFor */
  prepareImage?: typeof attachableImageFor;
}

export interface WindowJudgeImageCandidate extends HistoryImage {
  sender: string;
  isCurrent: boolean;
}

/**
 * 给模型看的群聊上下文：群记忆里截到当前消息为止，再按时间插进 bot 自己说过的话。
 * `includeCurrent = false` 时只取当前消息之前的背景（供笔记相关性打分复用，避免和当前消息重复）。
 */
export function collectJudgeLines(
  config: ImQQBotConfig,
  groupId: string,
  messageId?: string,
  options?: { includeCurrent?: boolean },
): JudgeLine[] {
  const includeCurrent = options?.includeCurrent ?? true;
  const limit = config.replyDesire?.judge?.contextMessages ?? REPLY_JUDGE_DEFAULTS.contextMessages;
  const recent = readRecentGroupMessages(config.appId, groupId, limit + 10);
  const cut = messageId !== undefined ? recent.findIndex((e) => e.messageId === messageId) : -1;
  const toLine = (e: (typeof recent)[number]): JudgeLine => {
    const { text, stickerId } = classifyMessage(e.content);
    const hasImg = stickerId !== undefined || (e.images?.length ?? 0) > 0;
    const shown = text !== ''
      ? (hasImg ? `${text} [图片]` : text)
      : (hasImg ? '[图片]' : '');
    if (isBotMemoryEntry(e)) return { text: shown, timestamp: e.timestamp };
    return { sender: e.senderName ?? e.senderId.slice(-6), text: shown, timestamp: e.timestamp };
  };

  if (!includeCurrent) {
    const beforeEntries = cut >= 0 ? recent.slice(0, cut) : recent;
    const cutoffTs = cut >= 0 ? recent[cut]!.timestamp : Number.POSITIVE_INFINITY;
    const userLines = beforeEntries.map(toLine).filter((line) => line.text !== '');
    const bot = beforeEntries.some(isBotMemoryEntry)
      ? []
      : getEngagementTracker().botLines(groupId)
          .filter((line) => line.timestamp <= cutoffTs)
          .map((line) => ({ text: line.text, timestamp: line.timestamp }));
    return [...userLines, ...bot].sort((a, b) => a.timestamp - b.timestamp).slice(-limit);
  }

  const upto = cut >= 0 ? recent.slice(0, cut + 1) : recent;
  const lines = upto.map(toLine).filter((line) => line.text !== '');
  const current = lines[lines.length - 1];
  const bot = upto.some(isBotMemoryEntry)
    ? []
    : getEngagementTracker().botLines(groupId)
        .filter((line) => current === undefined || line.timestamp <= current.timestamp)
        .map((line) => ({ text: line.text, timestamp: line.timestamp }));
  // 当前消息必须留在最后（模型按 ▶ 判断），bot 的话只往它前面插
  const before = [...lines.slice(0, -1), ...bot].sort((a, b) => a.timestamp - b.timestamp);
  return [...before, ...(current !== undefined ? [current] : [])].slice(-limit);
}

/**
 * 收集当前对话窗口内、bot 上次发言之后的最新图片（最多 MAX_JUDGE_IMAGES 张，按时间正序返回）。
 * 既覆盖当前消息本身附带的图片，也覆盖防抖合并期间紧邻前一条发出的截图/照片（先发图再问话）。
 */
export function collectWindowImageCandidates(options: {
  config: ImQQBotConfig;
  groupId: string;
  messageId?: string;
  attachments?: readonly DesireAttachment[];
  senderId: string;
  senderName?: string;
  now: number;
  engagedMs: number;
  botSpokeAt?: number;
}): WindowJudgeImageCandidate[] {
  const { config, groupId, messageId, attachments = [], senderId, senderName, now, engagedMs, botSpokeAt } = options;
  const limit = config.replyDesire?.judge?.contextMessages ?? REPLY_JUDGE_DEFAULTS.contextMessages;
  const recent = readRecentGroupMessages(config.appId, groupId, limit + 10);
  const cut = messageId !== undefined ? recent.findIndex((e) => e.messageId === messageId) : -1;
  const upto = cut >= 0 ? recent.slice(0, cut + 1) : recent;
  const minTs = Math.max(now - engagedMs, botSpokeAt ?? 0);

  const collected: Array<{
    messageId: string;
    url: string;
    filename?: string;
    sender: string;
    isCurrent: boolean;
  }> = [];
  const seenUrl = new Set<string>();

  const pushUnique = (item: { messageId: string; url: string; filename?: string; sender: string; isCurrent: boolean }) => {
    if (!item.url || seenUrl.has(item.url)) return;
    seenUrl.add(item.url);
    collected.push(item);
  };

  // 若当前消息尚未落入群记忆（如直接调中间件的单测场景），优先纳入当前消息的图片附件
  if (cut < 0) {
    const senderLabel = senderName ?? senderId.slice(-6);
    const currentImages = attachments.filter((a) => isImageContentType(a.content_type ?? '') && typeof a.url === 'string' && a.url !== '');
    for (let i = currentImages.length - 1; i >= 0 && collected.length < MAX_JUDGE_IMAGES; i -= 1) {
      const att = currentImages[i]!;
      pushUnique({
        messageId: messageId ?? 'current',
        url: att.url!,
        ...(att.filename !== undefined ? { filename: att.filename } : {}),
        sender: senderLabel,
        isCurrent: true,
      });
    }
  }

  // 从最新一条往回扫，碰到 bot 自己的消息或超出窗口起点即停，避免反复对旧图打分
  for (let i = upto.length - 1; i >= 0 && collected.length < MAX_JUDGE_IMAGES; i -= 1) {
    const entry = upto[i]!;
    if (isBotMemoryEntry(entry)) break;
    if (entry.timestamp < minTs) break;
    const imgs = entry.images ?? [];
    if (imgs.length === 0) continue;
    const senderLabel = entry.senderName ?? entry.senderId.slice(-6);
    const isCurrent = messageId !== undefined ? entry.messageId === messageId : i === upto.length - 1;
    for (let j = imgs.length - 1; j >= 0 && collected.length < MAX_JUDGE_IMAGES; j -= 1) {
      const img = imgs[j]!;
      pushUnique({
        messageId: entry.messageId,
        url: img.url,
        ...(img.filename !== undefined ? { filename: img.filename } : {}),
        sender: senderLabel,
        isCurrent,
      });
    }
  }

  return collected.reverse().map((item, idx) => ({
    index: idx + 1,
    messageId: item.messageId,
    url: item.url,
    ...(item.filename !== undefined ? { filename: item.filename } : {}),
    sender: item.sender,
    isCurrent: item.isCurrent,
  }));
}

async function loadWindowJudgeImages(options: {
  candidates: WindowJudgeImageCandidate[];
  provider: string;
  model: string;
  config: ImQQBotConfig;
  manager: SessionManager;
  logger: Logger;
  judgeDeps: JudgeDeps;
  timeoutMs: number;
}): Promise<JudgeImage[]> {
  const { candidates, provider, model, config, manager, logger, judgeDeps, timeoutMs } = options;
  if (candidates.length === 0) return [];
  if (config.media?.enabled === false) return [];
  if (typeof manager.createImageBlock !== 'function') return [];

  const supportsImage = (await judgeDeps.judge.supportsImageInput?.(provider, model)) === true;
  if (!supportsImage) return [];

  const download = judgeDeps.downloadImages ?? downloadRecentHistoryImages;
  try {
    await download(
      candidates,
      config.media,
      logger,
      MAX_JUDGE_IMAGES,
      undefined,
      AbortSignal.timeout(Math.min(timeoutMs, MAX_JUDGE_DOWNLOAD_MS)),
    );
  } catch (err) {
    logger.debug(`reply-desire: 窗口图片下载失败，降级纯文本打分: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const prepare = judgeDeps.prepareImage ?? attachableImageFor;
  const maxBytes = Math.min(config.vision?.maxBytes ?? MAX_JUDGE_IMAGE_BYTES, MAX_JUDGE_IMAGE_BYTES);
  const loaded: JudgeImage[] = [];
  for (const item of candidates) {
    if (item.localPath === undefined) continue;
    const prepared: { path: string; note?: string } = await prepare(item.localPath, manager.ffmpegPath, logger)
      .catch(() => ({ path: item.localPath! }));
    const block = await manager.createImageBlock(prepared.path, { ignoreNativeFlag: true, maxBytes });
    if (block === undefined) continue;
    const suffix = item.isCurrent ? '，最新消息' : '';
    loaded.push({
      label: `[图片#${loaded.length + 1}（来自${item.sender}${suffix}）]`,
      block,
      ...(prepared.note !== undefined ? { note: prepared.note } : {}),
    });
  }
  return loaded;
}

export function replyDecider(config: ImQQBotConfig, manager: SessionManager, logger: Logger, judgeDeps?: JudgeDeps) {
  const tracker = getEngagementTracker();
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    const msg = ctx.message;
    const groupId = msg.groupOpenid;
    if (msg.kind !== 'group' || groupId === undefined) {
      await next();
      return;
    }

    const rd = config.replyDesire;
    const now = Date.now();
    const content = String(msg.content ?? '');
    const attachments = (msg as { attachments?: DesireAttachment[] }).attachments ?? [];
    const { text, stickerId } = classifyMessage(content, attachments);
    const dnd = manager.dndService?.active(manager.sessionKey('group', groupId)) !== undefined;
    const mention = ctx.state.mention as MentionState | undefined;
    const queue = judgeDeps?.queue;
    const persona = manager.personaStore?.current(groupId);
    const defaultGroupPersona = persona === undefined ? manager.personaStore?.defaultPersona?.('group') : undefined;
    // 换了人设，群里叫 bot 的称呼也跟着换；人设没写就沿用配置，再兜底外置默认人设 names
    const names = persona !== undefined && persona.names.length > 0
      ? persona.names
      : (rd.names.length > 0 ? rd.names : (defaultGroupPersona?.names ?? []));
    // 有模型裁判时统一走灰区打分（含跑团旁观模式）；仅 llm 不可用时降级为纯规则
    const judged = judgeDeps !== undefined;

    const answer = async (result: DesireResult): Promise<void> => {
      queue?.cancel(groupId);
      if (judged || !dnd) tracker.take(groupId, msg.senderId, Date.now(), rd.engagedMs, rd.engagedMaxTurns);
      tracker.markSticker(groupId, msg.senderId, result, Date.now());
      ctx.state.mention = { wasMentioned: mention?.wasMentioned ?? false, implicit: true, shouldAnswer: true, reason: 'passthrough' };
      ctx.state.replyDesire = result;
      logger.info(`reply-desire: answer group=${groupId} score=${result.score.toFixed(2)} [${result.reasons.join(',')}]`);
      await next();
    };

    if (mention === undefined || mention.shouldAnswer) {
      tracker.record(groupId, { senderId: msg.senderId, stickerId });
      queue?.cancel(groupId);
      if ((judged || !dnd) && rd.engagedMaxTurns > 0 && (mention?.wasMentioned === true || mention?.implicit === true)) {
        tracker.open(groupId, msg.senderId, now, rd.engagedMs);
      }
      await next();
      return;
    }

    // 开团且关了插嘴：只回 @（与 groupReplyProbability 的规则一致）
    if (dnd && config.dnd?.interjections === false) {
      tracker.record(groupId, { senderId: msg.senderId, stickerId });
      ctx.stop('reply-desire:dnd');
      return;
    }

    const activeEngagement = tracker.get(groupId, now);
    const collection = stickerId !== undefined ? manager.stickerStore?.collectionKind(stickerId) : undefined;
    const mentions = (msg as { mentions?: Array<{ is_you?: boolean } | undefined> }).mentions;
    const result = scoreReplyDesire({
      content,
      attachments,
      senderId: msg.senderId,
      mentionsOthers: Array.isArray(mentions) && mentions.some((m) => m?.is_you !== true),
      names,
      // 有模型裁判时，对话窗口仅作线索与看图边界，不直接触发规则放行；纯规则降级时开团仍不开窗
      engagement: judged ? activeEngagement : (dnd ? undefined : activeEngagement),
      recent: tracker.recent(groupId),
      sinceBotSpoke: tracker.sinceBotSpoke(groupId, now),
      stickerAnswered: tracker.stickerAnswered(groupId, msg.senderId),
      chainAnswered: tracker.chainAnswered(groupId),
      sinceStickerReply: tracker.sinceStickerReply(groupId, now),
      dnd,
      collection,
    });
    tracker.record(groupId, { senderId: msg.senderId, stickerId });

    // 无 llm 服务降级：沿用纯规则阈值放行
    if (!judged) {
      if (result.score >= rd.threshold) {
        await answer(result);
        return;
      }
      if (config.debug) {
        logger.debug(`reply-desire: skip score=${result.score.toFixed(2)} [${result.reasons.join(',')}]`);
      }
      ctx.stop('reply-desire:low');
      return;
    }

    // 表情包接龙复读（连续 3 条同一张、非跑团）：无需模型判断，快捷跟发
    if (result.mode === 'sticker-chain') {
      await answer(result);
      return;
    }

    const engaged = activeEngagement !== undefined;
    const hasImage = hasImageAttachment(attachments);
    const directCall = result.reasons.includes('name') || result.reasons.includes('sticker-mine');
    if (!isJudgeCandidate(text, result, { engaged, hasImage })
      || (!directCall && tracker.banterCapped(groupId, msg.senderId, now))) {
      queue?.activity(groupId, now);
      if (config.debug) {
        logger.debug(`reply-desire: skip score=${result.score.toFixed(2)} [${result.reasons.join(',')}]`);
      }
      ctx.stop('reply-desire:low');
      return;
    }

    const outcome = await judgeDeps.queue.enqueue(groupId, now);
    if (outcome === 'superseded') {
      ctx.stop('reply-desire:superseded');
      return;
    }
    const judgeCfg = rd.judge ?? REPLY_JUDGE_DEFAULTS;
    const route = manager.getEffectiveModel('group', groupId);
    const provider = judgeCfg.provider || route?.provider || config.provider;
    const model = judgeCfg.model || route?.model || config.model;
    if (!provider || !model) {
      logger.warn('reply-desire: 没有可用的打分模型（judge.provider/model 和主模型都没配置）');
      ctx.stop('reply-desire:no-model');
      return;
    }

    const hints: JudgeHints = {
      ...(dnd ? { dnd: true } : {}),
      ...(engaged ? { engaged: true, engagedPeer: activeEngagement.peers.has(msg.senderId) } : {}),
      ...(result.reasons.includes('name') ? { named: true } : {}),
      ...(result.mode === 'sticker'
        ? { sticker: true, ...(collection !== undefined ? { stickerCollection: collection } : {}) }
        : {}),
      ...(result.reasons.includes('sticker-react') ? { recentBotReply: true } : {}),
    };

    const images = engaged
      ? await loadWindowJudgeImages({
          candidates: collectWindowImageCandidates({
            config,
            groupId,
            messageId: msg.messageId,
            attachments,
            senderId: msg.senderId,
            senderName: (msg as { senderName?: string }).senderName,
            now: Date.now(),
            engagedMs: rd.engagedMs,
            botSpokeAt: tracker.botSpokeAt(groupId),
          }),
          provider,
          model,
          config,
          manager,
          logger,
          judgeDeps,
          timeoutMs: judgeCfg.timeoutMs,
        })
      : [];

    const desire = await judgeDeps.judge.score({
      provider,
      model,
      names,
      persona: persona?.prompt ?? defaultGroupPersona?.prompt ?? config.groupPrompt,
      lines: collectJudgeLines(config, groupId, msg.messageId),
      hints,
      ...(images.length > 0 ? { images } : {}),
    });
    if (desire === undefined || desire < rd.threshold) {
      logger.info(
        `reply-desire: judge skip group=${groupId} desire=${desire?.toFixed(2) ?? 'n/a'}`
        + `${dnd ? ' dnd=1' : ''}${images.length > 0 ? ` images=${images.length}` : ''}`,
      );
      ctx.stop('reply-desire:judge-low');
      return;
    }
    tracker.noteBanter(groupId, msg.senderId, Date.now());
    await answer({
      ...result,
      score: desire,
      reasons: [...result.reasons, 'judge', ...(images.length > 0 ? ['images'] : [])],
    });
  };
}
