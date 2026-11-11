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
 * 只对列出的 provider 生效——缓存活得久、命中稳定的上游不需要。
 */
export interface IdleCompactInput {
  contextTokens: number | undefined;
  /** 上下文不到这么多不压（冷启动本来就便宜）；0 = 关闭 */
  minTokens: number;
  idleMs: number;
  /** 空闲不到这么久不压；0 = 关闭 */
  minIdleMs: number;
  provider: string | undefined;
  /** 逗号分隔的 provider 名；空 = 所有 provider */
  providers: string;
}

export function parseProviderList(raw: string): string[] {
  return raw.split(/[,，\s]+/).map((item) => item.toLowerCase()).filter(Boolean);
}

export function shouldIdleCompact(input: IdleCompactInput): boolean {
  if (input.minIdleMs <= 0 || input.minTokens <= 0) return false;
  if (input.idleMs < input.minIdleMs) return false;
  if (input.contextTokens === undefined || input.contextTokens < input.minTokens) return false;
  const providers = parseProviderList(input.providers);
  if (providers.length === 0) return true;
  return input.provider !== undefined && providers.includes(input.provider.toLowerCase());
}

export type CompactDecision ='compact' | 'defer' | 'skip';

export interface CompactInput {
  contextTokens: number | undefined;
  threshold: number;
  contextWindow: number | undefined;
  lastTurnUsedTools: boolean;
  deferOnTools: boolean;
}

export function decideAutoCompact(input: CompactInput): CompactDecision {
  const { contextTokens, threshold } = input;
  if (threshold <= 0 || contextTokens === undefined || contextTokens < threshold) return 'skip';
  if (input.deferOnTools && input.lastTurnUsedTools && contextTokens < deferCeiling(threshold, input.contextWindow)) {
    return 'defer';
  }
  return 'compact';
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
