/**
 * 笔记注入账本的查看：挑出要看的那几条，排成给人看的文本。
 * /bot-notes 命令和 qqbot_notes_manage 工具共用，所以不依赖宿主。
 */
import type { NoteStatRow } from '../notes/note-metrics.ts';

/** low = 相关分最低的；top = 注入最多的；muted = 已静音的 */
export type NoteStatsView = 'low' | 'top' | 'muted';

export const NOTE_STATS_VIEWS: readonly NoteStatsView[] = ['low', 'top', 'muted'];

export function pickNoteStats(rows: readonly NoteStatRow[], view: NoteStatsView, limit: number): NoteStatRow[] {
  const n = Math.max(1, Math.floor(limit));
  if (view === 'muted') {
    return rows.filter((row) => row.mutedAt !== undefined).sort((a, b) => (b.mutedAt ?? 0) - (a.mutedAt ?? 0)).slice(0, n);
  }
  if (view === 'top') return [...rows].sort((a, b) => b.injected - a.injected).slice(0, n);
  return rows
    .filter((row) => row.avgRelevance !== undefined)
    // 同分时注入多的排前面：一样不相关，打扰次数多的更该先处理
    .sort((a, b) => (a.avgRelevance! - b.avgRelevance!) || (b.injected - a.injected))
    .slice(0, n);
}

function line(row: NoteStatRow, index: number): string {
  const relevance = row.avgRelevance === undefined ? '未评' : `均分 ${row.avgRelevance.toFixed(2)}（评 ${row.judged ?? 0} 次）`;
  const muted = row.mutedAt === undefined ? '' : (row.mutedManually === true ? ' · 🔇手动' : ' · 🔇');
  return `${index + 1}. ${relevance} · 注入 ${row.injected} 次${muted}\n   ${row.file} › ${row.heading}`;
}

const TITLES: Record<NoteStatsView, string> = {
  low: '相关分最低',
  top: '注入最多',
  muted: '已静音',
};

/** 概览一行 + 所选视图的清单 */
export function renderNoteStats(rows: readonly NoteStatRow[], view: NoteStatsView, limit: number, judgeEnabled: boolean): string {
  const injected = rows.reduce((sum, row) => sum + row.injected, 0);
  const judged = rows.filter((row) => (row.judged ?? 0) > 0).length;
  const muted = rows.filter((row) => row.mutedAt !== undefined).length;
  const head = `📒 笔记注入账本：${rows.length} 段、共注入 ${injected} 次；已评 ${judged} 段，已静音 ${muted} 段`
    + (judgeEnabled ? '' : '\n（相关性打分没开：设置页「共享笔记 › 注入相关性打分」）');
  const picked = pickNoteStats(rows, view, limit);
  if (picked.length === 0) {
    const why = view === 'low' ? '还没有评过分的段' : view === 'muted' ? '没有被静音的段' : '账本是空的';
    return `${head}\n\n${TITLES[view]}：${why}。`;
  }
  return `${head}\n\n${TITLES[view]}（前 ${picked.length}）：\n${picked.map(line).join('\n')}`;
}
