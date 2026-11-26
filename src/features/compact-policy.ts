/**
 * 自动压缩的触发规则 — 什么时候让宿主 compactNow 把会话历史换成摘要。
 *
 * 宿主的 compactNow 不保留尾部（retainTokens=0）：除最后一条外整段历史都进摘要，
 * 工具结果原文、中间状态都只剩摘要里的几行。所以插件这边能做的是「晚点压、挑时候压」：
 *   - 私聊阈值按模型上下文窗口的比例算，且不低于群聊阈值（私聊只放宽不收紧）；
 *     群聊闲聊多、单条价值低，仍用固定 token 阈值。
 *   - 上一轮调用过工具（多步任务大概率还在进行），超过阈值也先不压，等到一轮没调工具的
 *     「收尾」轮再压；超过硬上限才强制压，避免无限推迟撑爆窗口。
 * 更大的上下文还会碰到宿主自己的 pressure 压缩（轮内 step 边界触发、保留近期尾部），
 * 那条路不受这里控制。
 */
import { randomUUID } from 'node:crypto';
import type { ChatScope } from '../types.ts';

export interface CompactPolicyConfig {
  /** 群聊（及取不到窗口时私聊）的阈值；0 = 插件不自动压缩 */
  autoCompactTokens: number;
  /** 私聊阈值 = 窗口 × 该比例；0 = 私聊也用 autoCompactTokens */
  autoCompactPrivateRatio: number;
  /** 上一轮调过工具时推迟压缩 */
  autoCompactDeferOnTools: boolean;
}

/** 推迟的上限：阈值的 1.5 倍，且不超过窗口的 90%（再往上就该宿主 overflow 恢复接手了） */
const DEFER_CEILING_FACTOR = 1.5;
const DEFER_CEILING_WINDOW_RATIO = 0.9;

/** 本会话的自动压缩阈值（token），0 = 不自动压缩 */
export function compactThreshold(scope: ChatScope, contextWindow: number | undefined, cfg: CompactPolicyConfig): number {
  const base = cfg.autoCompactTokens;
  if (base <= 0) return 0;
  if (scope !== 'c2c' || cfg.autoCompactPrivateRatio <= 0) return base;
  if (contextWindow === undefined || contextWindow <= 0) return base;
  return Math.max(base, Math.floor(contextWindow * cfg.autoCompactPrivateRatio));
}

/** 推迟压缩能撑到的上限；不会低于阈值本身 */
export function deferCeiling(threshold: number, contextWindow: number | undefined): number {
  const ceiling = Math.floor(threshold * DEFER_CEILING_FACTOR);
  if (contextWindow === undefined || contextWindow <= 0) return ceiling;
  return Math.max(threshold, Math.min(ceiling, Math.floor(contextWindow * DEFER_CEILING_WINDOW_RATIO)));
}

/**
 * 空闲压缩：上游的隐式提示缓存只活几分钟（Gemini 实测约 5 分钟），群里安静一阵之后每条消息都要
 * 全价重读整段上下文。空闲够久（话题多半已经换了）且上下文够大时先压成摘要：压缩请求本身也是
 * 全价读一遍，和下一条消息冷启动花的一样，省的是之后每一次冷启动。
 * 只对命中规则的上游/模型生效——缓存活得久、命中稳定的上游不需要。
 */
export interface IdleCompactInput {
  contextTokens: number | undefined;
  /** 上下文不到这么多不压（冷启动本来就便宜）；0 = 关闭 */
  minTokens: number;
  idleMs: number;
  /** 空闲不到这么久不压；0 = 关闭 */
  minIdleMs: number;
  provider: string | undefined;
  // 会话实际模型 ID（支持按 provider/model、*/*gemini* 或 model:*gemini* 命中聚合网关下的短缓存模型）
  model?: string | undefined;
  /** 逗号或空白分隔的规则列表；支持 provider、provider/model、`model:<pattern>`（支持 `*` 通配）；空 = 全部 */
  providers: string;
  /** 关键事务窗口 locked 时禁止空闲压缩，避免等待用户或后台任务途中截断上下文 */
  contextLocked?: boolean;
}

export type IdleCompactSkipReason =
  | 'context-locked'
  | 'disabled'
  | 'not-idle'
  | 'unknown-tokens'
  | 'below-tokens'
  | 'route-mismatch';

export type IdleCompactEvaluation =
  | { eligible: true }
  | { eligible: false; reason: IdleCompactSkipReason };

export function parseProviderList(raw: string): string[] {
  return raw.split(/[,，\s]+/).map((item) => item.toLowerCase()).filter(Boolean);
}

function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value.toLowerCase() === pattern.toLowerCase();
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

// 判断会话的 provider/model 是否命中 `idleCompactProviders` 规则列表：
// - 规则列表为空 → 全部放行；
// - `model:<pattern>` → 按模型 ID 匹配（支持 `*` 通配）；
// - `<providerPattern>/<modelPattern>` → 同时匹配 provider 与 model（按首个 `/` 拆分，支持 `*` 通配，如 `*/*gemini*`、`opencode/gemini*`）；
// - 其余条目 → 匹配 provider（含 `*` 时做通配，否则大小写不敏感精确匹配）。
export function matchesIdleCompactRoute(
  provider: string | undefined,
  model: string | undefined,
  rawRules: string,
): boolean {
  const rules = parseProviderList(rawRules);
  if (rules.length === 0) return true;
  const prov = provider?.trim();
  const mod = model?.trim();
  for (const rule of rules) {
    if (rule.startsWith('model:')) {
      const modelPat = rule.slice('model:'.length);
      if (modelPat !== '' && mod !== undefined && mod !== '' && wildcardMatch(mod, modelPat)) return true;
      continue;
    }
    const slash = rule.indexOf('/');
    if (slash >= 0) {
      const provPat = rule.slice(0, slash);
      const modelPat = rule.slice(slash + 1);
      if (
        provPat !== '' && modelPat !== ''
        && prov !== undefined && prov !== ''
        && mod !== undefined && mod !== ''
        && wildcardMatch(prov, provPat)
        && wildcardMatch(mod, modelPat)
      ) {
        return true;
      }
      continue;
    }
    if (prov !== undefined && prov !== '' && wildcardMatch(prov, rule)) return true;
  }
  return false;
}

export function evaluateIdleCompact(input: IdleCompactInput): IdleCompactEvaluation {
  if (input.contextLocked === true) return { eligible: false, reason: 'context-locked' };
  if (input.minIdleMs <= 0 || input.minTokens <= 0) return { eligible: false, reason: 'disabled' };
  if (input.idleMs < input.minIdleMs) return { eligible: false, reason: 'not-idle' };
  if (input.contextTokens === undefined) return { eligible: false, reason: 'unknown-tokens' };
  if (input.contextTokens < input.minTokens) return { eligible: false, reason: 'below-tokens' };
  if (!matchesIdleCompactRoute(input.provider, input.model, input.providers)) {
    return { eligible: false, reason: 'route-mismatch' };
  }
  return { eligible: true };
}

export function shouldIdleCompact(input: IdleCompactInput): boolean {
  return evaluateIdleCompact(input).eligible;
}

/**
 * 从会话事件流逆序提取最近一次 `assistant/message` 后的上下文大小（输入 + 缓存读写 + 输出）。
 * 若最近一次压缩摘要（`compaction/summary` / `compaction/end`）之后没有新的 `assistant/message` 用量，
 * 返回 `undefined`，避免恢复或重载会话时把压缩前的旧上下文大小误当作当前值。
 */
export function latestContextTokens(
  events: readonly { type: string; data?: unknown; usage?: unknown }[] | undefined,
): number | undefined {
  if (!events || events.length === 0) return undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (ev.type === 'compaction/summary' || ev.type === 'compaction/end') return undefined;
    if (ev.type !== 'assistant/message') continue;
    const raw = ((ev.data as { usage?: Record<string, unknown> } | undefined)?.usage ?? ev.usage) as
      | Record<string, unknown>
      | undefined;
    if (!raw || typeof raw !== 'object') continue;
    const total = num(raw.inputTokens ?? raw.input)
      + num(raw.cacheReadTokens ?? raw.cacheRead)
      + num(raw.cacheWriteTokens ?? raw.cacheWrite)
      + num(raw.outputTokens ?? raw.output);
    if (total > 0) return total;
  }
  return undefined;
}

export type CompactDecision ='compact' | 'defer' | 'skip';

export interface CompactInput {
  contextTokens: number | undefined;
  threshold: number;
  contextWindow: number | undefined;
  lastTurnUsedTools: boolean;
  deferOnTools: boolean;
  /** 多步关键事务/交接/待决状态持有锁时，同样推迟到紧急硬上限前 */
  contextLocked?: boolean;
}

export function decideAutoCompact(input: CompactInput): CompactDecision {
  const { contextTokens, threshold } = input;
  if (threshold <= 0 || contextTokens === undefined || contextTokens < threshold) return 'skip';
  const busy = input.contextLocked === true || (input.deferOnTools && input.lastTurnUsedTools);
  if (busy && contextTokens < deferCeiling(threshold, input.contextWindow)) {
    return 'defer';
  }
  return 'compact';
}

/**
 * 扫描最近一次压缩摘要之后的事件，检查是否仍有未结算的后台任务（job/registered 且未 job/settled）。
 */
export function hasOpenBackgroundJobs(
  events: readonly { type: string; data?: unknown; [key: string]: unknown }[] | undefined,
): boolean {
  if (!events || events.length === 0) return false;
  let start = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === 'compaction/summary') {
      start = i + 1;
      break;
    }
  }
  const open = new Set<string>();
  for (let i = start; i < events.length; i += 1) {
    const ev = events[i]!;
    if (ev.type !== 'job/registered' && ev.type !== 'job/settled') continue;
    const body = (ev.data ?? ev) as { jobId?: unknown };
    const id = typeof body.jobId === 'string' ? body.jobId.trim() : '';
    if (!id) continue;
    if (ev.type === 'job/registered') open.add(id);
    else open.delete(id);
  }
  return open.size > 0;
}

/** 会话级关键事务租约管理器（TTL 兜底防止异常分支泄漏永久锁死压缩）。 */
export class ContextLockManager {
  private readonly leases = new Map<string, Map<string, { reason: string; expiresAt: number }>>();

  public acquire(
    sessionKey: string,
    reason: string,
    ttlMs = 10 * 60_000,
    now = Date.now(),
  ): () => void {
    const id = randomUUID();
    let perSession = this.leases.get(sessionKey);
    if (perSession === undefined) {
      perSession = new Map();
      this.leases.set(sessionKey, perSession);
    }
    perSession.set(id, { reason, expiresAt: now + Math.max(1, ttlMs) });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const bag = this.leases.get(sessionKey);
      if (bag === undefined) return;
      bag.delete(id);
      if (bag.size === 0) this.leases.delete(sessionKey);
    };
  }

  public status(sessionKey: string, now = Date.now()): { locked: boolean; reasons: string[] } {
    const bag = this.leases.get(sessionKey);
    if (bag === undefined || bag.size === 0) return { locked: false, reasons: [] };
    const reasons: string[] = [];
    for (const [id, entry] of bag) {
      if (entry.expiresAt <= now) bag.delete(id);
      else if (!reasons.includes(entry.reason)) reasons.push(entry.reason);
    }
    if (bag.size === 0) this.leases.delete(sessionKey);
    return { locked: reasons.length > 0, reasons };
  }

  public clear(sessionKey: string): void {
    this.leases.delete(sessionKey);
  }

  public clearAll(): void {
    this.leases.clear();
  }
}

/**
 * 最近一个已结束的轮次（最后一个 turn/end 到它的 turn/start）有没有工具调用。
 * 只看事件类型，不依赖 data 结构；倒序扫描，遇到本轮开头或上一轮结尾就停。
 */
export function lastTurnUsedTools(events: readonly { type: string }[] | undefined): boolean {
  if (!events) return false;
  let i = events.length - 1;
  // turn/end 之后可能还有压缩标记等非对话事件，先跳到它
  while (i >= 0 && events[i]!.type !== 'turn/end') i -= 1;
  for (i -= 1; i >= 0; i -= 1) {
    const type = events[i]!.type;
    if (type === 'turn/start' || type === 'turn/end') return false;
    if (type === 'tool/call') return true;
  }
  return false;
}
