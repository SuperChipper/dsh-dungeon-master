/**
 * 笔记账本命令：/bot-notes（仅 owner/admin，仅私聊）
 *
 *   /bot-notes            相关分最低的 10 段
 *   /bot-notes top [n]    注入最多的
 *   /bot-notes muted [n]  已静音的
 *
 * 只在私聊里给看：清单里有各个群的私有笔记标题，发到群里等于把别的群的事贴出来。
 * 这里只查不改；静音、归档让私聊里的 agent 用 qqbot_notes_manage 做。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { isPrivilegedSender, sendMarkdownChunked } from '../shared/index.ts';
import { NOTE_STATS_VIEWS, renderNoteStats, type NoteStatsView } from '../features/note-stats.ts';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

/** 解析「[low|top|muted] [n]」；认不出来返回 undefined */
export function parseNotesArgs(raw: string): { view: NoteStatsView; limit: number } | undefined {
  const parts = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let view: NoteStatsView = 'low';
  let limit = DEFAULT_LIMIT;
  for (const part of parts) {
    if ((NOTE_STATS_VIEWS as readonly string[]).includes(part)) view = part as NoteStatsView;
    else if (/^\d+$/.test(part)) limit = Math.min(MAX_LIMIT, Math.max(1, Number(part)));
    else return undefined;
  }
  return { view, limit };
}

/** /bot-notes — 查看笔记注入与相关性打分 */
export function notesCommand({ manager, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'bot-notes',
    category: 'qqbot',
    description: '查看笔记注入账本和相关性打分（top 注入最多，muted 已静音）',
    authorized: (ctx) => {
      if (!isPrivilegedSender(ctx.message.senderId, config)) return '⚠️ 只有 bot 主人或管理员可以查看笔记账本。';
      if (ctx.message.kind === 'group') return '⚠️ 笔记账本里有各个群的私有笔记标题，请在私聊里查看。';
      return true;
    },
    handler: async (cmdCtx) => {
      const metrics = manager.noteMetrics;
      if (metrics === undefined) return '共享笔记库没有启用';
      const args = parseNotesArgs(cmdCtx.command?.raw ?? '');
      if (args === undefined) return '用法：/bot-notes [low|top|muted] [条数]';
      const text = renderNoteStats(metrics.summary(Number.POSITIVE_INFINITY), args.view, args.limit, config.notes?.judge?.enabled === true);
      await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}
