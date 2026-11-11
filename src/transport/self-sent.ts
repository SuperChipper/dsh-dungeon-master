/**
 * bot 自己发出去的消息：ref_idx → 内容。
 *
 * 背景：SDK 的 quoteRef 中间件只记录**入站**消息，自己发出去的话从来没进过 ref 索引。
 * 于是群友引用 bot 自己的消息时，`quote.entry` 查不到，组装层只能写「未知发送者」，
 * 模型看到一段自己的原文却不知道是自己说的（甚至以为是对面用户说的）。
 *
 * 这里把出站消息记下来，quoteSenderFill 在 store 查不到时过来补一条，
 * 组装层据此标注「你自己」。
 *
 * 键必须是发送返回里的 `ext_info.ref_idx`，不是 message id：引用里带的 `refMsgIdx`
 * 就是这个 ref_idx。早先按 id 记，两边永远对不上，引用 bot 的话一直显示「未知发送者」。
 */
export const SELF_SENDER_ID = '__self__';

export interface SelfSentEntry {
  content: string;
  timestamp: string;
}

export class SelfSentIndex {
  private readonly map = new Map<string, SelfSentEntry>();

  public constructor(private readonly maxSize = 500) {}

  public record(refIdx: string | undefined | null, content: string): void {
    if (refIdx === undefined || refIdx === null || refIdx === '') return;
    this.map.set(refIdx, { content, timestamp: new Date().toISOString() });
    // Map 保持插入顺序，超限就丢最早的
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  public get(refIdx: string): SelfSentEntry | undefined {
    return this.map.get(refIdx);
  }

  public size(): number {
    return this.map.size;
  }
}

/** 富媒体发送结果里的 ref_idx（SDK 的 onMessageSent 只覆盖文字消息，媒体要自己取） */
export function mediaRefIdx(result: unknown): string | undefined {
  const message = (result as { message?: { ext_info?: { ref_idx?: unknown } } } | undefined)?.message;
  const refIdx = message?.ext_info?.ref_idx;
  return typeof refIdx === 'string' && refIdx !== '' ? refIdx : undefined;
}

/** 媒体消息记进索引时的文本：被引用时平台常常不给原文，至少让模型知道是自己发的什么 */
export function mediaQuoteText(kind: '图片' | '视频' | '语音' | '文件', caption: string | undefined): string {
  return caption !== undefined && caption.trim() !== '' ? `[${kind}] ${caption}` : `[${kind}]`;
}
