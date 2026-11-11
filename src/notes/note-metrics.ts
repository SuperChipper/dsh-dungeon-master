/**
 * 笔记注入的账本：只记录，不改变检索行为。
 *
 * 为什么要它：检索用的 BM25 + 精确 + 语义三路融合只看"像不像"，不看"有没有用"。
 * 结果是某些词面泛化的笔记（比如满篇「预测 / 实际 / 回复」的观察日记）几乎每轮都被注入，
 * 却从来没被引用过——而系统对此一无所知，下一轮照样注入。
 *
 * 这一版只做第一步：把「哪一段、什么时候、以多少分、以多强的优势」记下来。
 * 判断「到底用没用」和据此调整权重是下一步，得先有一周的真实分布才谈得上调参。
 *
 * 落盘策略：内存聚合，定时（默认 60s）和进程退出时刷一次。一轮注入至多两段，
 * 每轮都写盘会让磁盘成为瓶颈，而账本丢最后一分钟不影响统计。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Logger } from '../types.ts';
import { shouldMute } from '../features/note-judge.ts';

interface EntryStats {
  file: string;
  heading: string;
  injected: number;
  strengthSum: number;
  firstAt: number;
  lastAt: number;
  via: Record<string, number>;
  /** 被模型评过相关性的次数；没评过时缺省（旧账本没有这三个字段） */
  judged?: number;
  /** 相关分累计，每次 0-1 */
  relevanceSum?: number;
  /** 被静音的时刻：之后不再自动注入，主动检索不受影响 */
  mutedAt?: number;
  /** 主人手动静音的：不受打分开关和阈值影响，只能手动解除 */
  mutedManually?: boolean;
}

export type NoteStatRow = EntryStats & { avgStrength: number; avgRelevance?: number };

export interface MetricsFile {
  version: 1;
  updatedAt: number;
  /** 按天汇总，看总量趋势用；明细在 entries */
  days: Record<string, { injections: number; distinct: number }>;
  entries: Record<string, EntryStats>;
}

const FLUSH_INTERVAL_MS = 60_000;

export function metricsPath(): string {
  return resolve(homedir(), '.dsh', 'qqbot-notes', 'metrics.json');
}

function dayKey(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 命中来源：两个以上同时成立时按优先级记，够用来分组，不必是完整组合 */
function viaOf(hit: { exact?: unknown; similarity?: unknown }): string {
  if (hit.exact !== undefined) return 'exact';
  if (hit.similarity !== undefined) return 'semantic';
  return 'bm25';
}

export class NoteMetricsStore {
  private readonly path: string;
  private readonly logger: Logger | undefined;
  private data: MetricsFile;
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(path = metricsPath(), logger?: Logger) {
    this.path = path;
    this.logger = logger;
    this.data = this.load();
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    // 后台账本不该拖住宿主退出
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private load(): MetricsFile {
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<MetricsFile>;
        if (parsed.version === 1 && parsed.entries !== undefined) {
          return { version: 1, updatedAt: parsed.updatedAt ?? 0, days: parsed.days ?? {}, entries: parsed.entries };
        }
      }
    } catch (err) {
      this.logger?.warn(`im-qqbot: 笔记账本读取失败，从空账本开始: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { version: 1, updatedAt: 0, days: {}, entries: {} };
  }

  /** 一轮注入结束后调用；hits 是按最终顺序排好的、真正进了提示词的那几段 */
  public recordInjection(hits: readonly {
    file: string;
    heading: string;
    score: number;
    exact?: unknown;
    similarity?: unknown;
  }[]): void {
    if (hits.length === 0) return;
    const now = Date.now();
    const top = Math.max(...hits.map((hit) => hit.score), 1e-9);
    const day = dayKey(now);
    const bucket = this.data.days[day] ?? { injections: 0, distinct: 0 };
    const seenToday = new Set<string>();

    for (const hit of hits) {
      const key = `${hit.file}::${hit.heading}`;
      const stat = this.data.entries[key] ?? {
        file: hit.file,
        heading: hit.heading,
        injected: 0,
        strengthSum: 0,
        firstAt: now,
        lastAt: now,
        via: {},
      };
      const via = viaOf(hit);
      stat.injected += 1;
      stat.strengthSum += hit.score / top;
      stat.lastAt = now;
      stat.via[via] = (stat.via[via] ?? 0) + 1;
      this.data.entries[key] = stat;
      bucket.injections += 1;
      seenToday.add(key);
    }
    // distinct 是当天出现过多少不同的段，用它比 injections 更能看出"是不是同一段反复霸榜"
    bucket.distinct = Math.max(bucket.distinct, uniqueCountForDay(this.data, day, seenToday));
    this.data.days[day] = bucket;
    this.data.updatedAt = now;
    this.dirty = true;
  }

  /**
   * 记下一轮打分。scores 与 items 一一对应（0-1）；返回这次新被静音的键。
   * 只更新已有注入记录的段：没注入过却有分数说明两边对不上，不该凭空建条目。
   */
  public recordJudgement(
    items: readonly { file: string; heading: string }[],
    scores: readonly number[],
    policy: { minSamples: number; muteBelow: number },
    now = Date.now(),
  ): string[] {
    const muted: string[] = [];
    items.forEach((item, index) => {
      const score = scores[index];
      const key = `${item.file}::${item.heading}`;
      const stat = this.data.entries[key];
      if (stat === undefined || score === undefined) return;
      stat.judged = (stat.judged ?? 0) + 1;
      stat.relevanceSum = (stat.relevanceSum ?? 0) + score;
      if (stat.mutedAt === undefined && shouldMute({ judged: stat.judged, relevanceSum: stat.relevanceSum }, policy)) {
        stat.mutedAt = now;
        muted.push(key);
      }
      this.dirty = true;
    });
    if (this.dirty) this.data.updatedAt = now;
    return muted;
  }

  /** 这段被静音的时刻；没静音返回 undefined */
  public mutedAt(file: string, heading: string): number | undefined {
    return this.data.entries[`${file}::${heading}`]?.mutedAt;
  }

  /** 是不是主人手动静音的 */
  public mutedManually(file: string, heading: string): boolean {
    return this.data.entries[`${file}::${heading}`]?.mutedManually === true;
  }

  /** 手动静音。没注入过的段也能静音，所以这里会建条目 */
  public mute(file: string, heading: string, now = Date.now()): void {
    const key = `${file}::${heading}`;
    const stat = this.data.entries[key] ?? { file, heading, injected: 0, strengthSum: 0, firstAt: now, lastAt: now, via: {} };
    stat.mutedAt = now;
    stat.mutedManually = true;
    this.data.entries[key] = stat;
    this.data.updatedAt = now;
    this.dirty = true;
  }

  /** 解除静音并清零分数：笔记内容改过了，旧分数评的不是现在这段 */
  public unmute(file: string, heading: string): void {
    const stat = this.data.entries[`${file}::${heading}`];
    if (stat === undefined || stat.mutedAt === undefined) return;
    delete stat.mutedAt;
    delete stat.mutedManually;
    delete stat.judged;
    delete stat.relevanceSum;
    this.dirty = true;
  }

  public flush(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.data, null, 2), 'utf8');
      renameSync(temporary, this.path);
      this.dirty = false;
    } catch (err) {
      this.logger?.warn(`im-qqbot: 笔记账本写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 汇总：给「哪些段注入最多、强度最高」这类问题一个现成入口 */
  public summary(limit = 20): NoteStatRow[] {
    return Object.values(this.data.entries)
      .map((stat) => ({
        ...stat,
        avgStrength: stat.injected === 0 ? 0 : stat.strengthSum / stat.injected,
        ...((stat.judged ?? 0) > 0 ? { avgRelevance: (stat.relevanceSum ?? 0) / stat.judged! } : {}),
      }))
      .sort((a, b) => b.injected - a.injected)
      .slice(0, limit);
  }

  public dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.flush();
  }
}

/**
 * 当天不同段数：账本只存累计值，这里用「今天最后写入过的段」近似。
 *
 * 精确统计要按天存 key 集合，文件会膨胀；而这条指标只用来判断「同一段是不是霸榜」，
 * 用累计 entries 里 lastAt 落在今天的个数就够了。
 */
function uniqueCountForDay(data: MetricsFile, day: string, extra: ReadonlySet<string>): number {
  let count = 0;
  for (const [key, stat] of Object.entries(data.entries)) {
    if (dayKey(stat.lastAt) === day || extra.has(key)) count += 1;
  }
  return count;
}
