/**
 * /new 的会话交接 — 换新会话前先把旧会话压缩一次，把宿主写的压缩摘要带进新会话的第一条消息。
 *
 * 为什么要它：/new 只是丢掉旧会话。群聊还能靠落盘的群消息回灌最近的原文，
 * 但 bot 自己答应过什么、事情做到哪一步都不在里面；私聊则是完全从头开始。
 *
 * 为什么复用压缩而不是自己写一份摘要：宿主压缩时看得到完整历史（含工具结果），
 * 提示词和模型调用也都是它维护的；这里只负责把结果读出来。
 *
 * 跑团不走这里：团档独立于会话，有自己的停团交接。
 */

/** 会话事件里用得到的部分 */
interface EventLike {
  type: string;
  data?: unknown;
}

/** 带进新会话的摘要上限。宿主的摘要一般七八千字，这里只防意外的超长 */
export const HANDOFF_MAX_CHARS = 12_000;

/**
 * 取会话里最新一条压缩摘要的正文（宿主的 compaction/summary 事件）；没有压缩过返回 undefined。
 *
 * 取「最新一条」而不是「这次压缩产生的那条」：历史太短时宿主会拒绝压缩，
 * 但会话以前压缩过的话，那份旧摘要仍然比什么都不带强（只差最后几轮）。
 */
export function latestCompactionSummary(events: readonly EventLike[] | undefined): string | undefined {
  if (events === undefined) return undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== 'compaction/summary') continue;
    const blocks = (event.data as { summary?: unknown } | undefined)?.summary;
    if (!Array.isArray(blocks)) continue;
    const text = blocks
      .map((block: { type?: unknown; text?: unknown }) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('\n')
      .trim();
    if (text === '') continue;
    return text.length <= HANDOFF_MAX_CHARS ? text : `${text.slice(0, HANDOFF_MAX_CHARS)}…（后略）`;
  }
  return undefined;
}

/** 注入新会话第一条消息的文字 */
export function formatHandoffHint(summary: string): string {
  return [
    '[上一段会话的交接]',
    '用户刚开了新会话，之前的对话你已经看不到了。下面是清空前对那段会话的压缩摘要，是转述，细节可能不准：',
    '拿它当背景，对方接着之前的事说时能接上；对方没提就不用主动翻旧账，和对方现在说的对不上时以现在说的为准。',
    summary,
  ].join('\n');
}
