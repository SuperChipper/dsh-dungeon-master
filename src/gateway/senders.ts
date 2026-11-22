/**
 * 网关出站发送适配：被动回复限额管控、per-peer 队列节拍、群内 @ 还原、
 * 媒体引用索引登记与机器人群发言归档。
 */
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { ReplyTarget } from '../types.ts';
import type { QQBotSender } from '../transport/outbound-buffer.ts';
import { PeerSendQueue } from '../transport/peer-send-queue.ts';
import { ReplyLimiter } from '../transport/reply-limiter.ts';
import { resolveReplyTarget, sendResolvedMarkdown } from '../transport/reply-target.ts';
import { mediaQuoteText, mediaRefIdx, type SelfSentIndex } from '../transport/self-sent.ts';
import { appendBotGroupMessage, resolveBotSenderName, type BotPersonaNameSource } from '../features/group-memory.ts';
import { renderOutboundMentions } from '../features/member-mention.ts';
import { getSenderAliases } from '../features/sender-alias.ts';
import type { MediaSenderLike } from '../media/send-file-tool.ts';

export type GatewayBotSendLike = Pick<
  QQBot,
  'sendMarkdown' | 'send' | 'openStream' | 'sendImage' | 'sendVideo' | 'sendVoice' | 'sendFile'
>;

export interface GatewaySendersDeps {
  bot: GatewayBotSendLike;
  config: Pick<ImQQBotConfig, 'appId' | 'replyDesire'>;
  manager: { personaStore?: BotPersonaNameSource };
  selfSent: Pick<SelfSentIndex, 'record'>;
}

export interface GatewaySenders {
  sender: QQBotSender;
  mediaSender: MediaSenderLike;
  rawSendVoice: (target: ReplyTarget, source: { localPath?: string }) => Promise<Awaited<ReturnType<QQBot['sendVoice']>>>;
  rememberMedia: <T>(
    target: ReplyTarget,
    kind: Parameters<typeof mediaQuoteText>[0],
    caption: string | undefined,
  ) => (result: T) => T;
  archiveBotMessage: (target: ReplyTarget, content: string, result: unknown) => void;
  sendQueue: PeerSendQueue;
  dispose: () => void;
}

/** 构造文本/流式/媒体发送适配器和群聊自动归档勾子 */
export function createGatewaySenders(deps: GatewaySendersDeps): GatewaySenders {
  const { bot, config, manager, selfSent } = deps;
  const replyLimiter = new ReplyLimiter({ limit: 4 });
  const sendQueue = new PeerSendQueue();

  // 群里模型写的 @#U3 在这里换成真正的 @（编号 → openid 用同一张别名表）
  const withMentions = (target: { scope: string; targetId: string }, content: string): string =>
    target.scope === 'group'
      ? renderOutboundMentions(content, (alias) => getSenderAliases().resolve(config.appId, target.targetId, alias))
      : content;

  const archiveBotMessage = (target: ReplyTarget, content: string, result: unknown): void => {
    if (target.scope !== 'group' || !target.targetId) return;
    appendBotGroupMessage(config.appId, target.targetId, {
      content,
      senderName: resolveBotSenderName(target.targetId, config.replyDesire?.names, manager.personaStore),
      result,
    });
  };

  const sender: QQBotSender = {
    sendMarkdown: (target, content, opts) => sendQueue.run(target,
      () => sendResolvedMarkdown(bot as QQBot, resolveReplyTarget(target, replyLimiter, true), withMentions(target, content), opts))
      .then((result) => {
        archiveBotMessage(target, content, result);
        return result;
      }),
    openStream: (target) => sendQueue.stream(target, () => bot.openStream({
      target: {
        scope: target.scope,
        targetId: target.targetId,
        msgId: target.msgId as string,
      },
    })),
  };

  // 媒体发送不走 onMessageSent，结果里的 ref_idx 自己记，群友引用表情/配图时才认得出是 bot 发的；群聊同时写入归档
  const rememberMedia = <T,>(
    target: ReplyTarget,
    kind: Parameters<typeof mediaQuoteText>[0],
    caption: string | undefined,
  ) => (result: T): T => {
    const text = mediaQuoteText(kind, caption);
    selfSent.record(mediaRefIdx(result), text);
    archiveBotMessage(target, text, result);
    return result;
  };

  const rawSendVoice = (target: ReplyTarget, source: { localPath?: string }) =>
    sendQueue.run(target, () => bot.sendVoice(resolveReplyTarget(target, replyLimiter, false), source), true);

  const mediaSender: MediaSenderLike = {
    sendImage: (target, source, opts) => sendQueue.run(target, () => bot.sendImage(resolveReplyTarget(target, replyLimiter, false), source, opts))
      .then(rememberMedia(target, '图片', opts?.content)),
    sendVideo: (target, source, opts) => sendQueue.run(target, () => bot.sendVideo(resolveReplyTarget(target, replyLimiter, false), source, opts))
      .then(rememberMedia(target, '视频', opts?.content)),
    sendVoice: (target, source) => rawSendVoice(target, source)
      .then(rememberMedia(target, '语音', undefined)),
    sendFile: (target, source, opts) => sendQueue.run(target, () => bot.sendFile(resolveReplyTarget(target, replyLimiter, false), source, opts))
      .then(rememberMedia(target, '文件', opts?.content?.trim() ? opts.content : opts?.fileName)),
  };

  return {
    sender,
    mediaSender,
    rawSendVoice,
    rememberMedia,
    archiveBotMessage,
    sendQueue,
    dispose: () => sendQueue.dispose(),
  };
}
