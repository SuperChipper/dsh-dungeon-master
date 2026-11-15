/**
 * 短时入站自动 Steer（打断当前思考并追加新消息）状态跟踪与协调器
 *
 * 解决的问题：
 * - `@deepseek-ai/dsh-agent` 的 `agent.steer(msg)` 仅投递到 `next-step` 边界，不会主动中止正在进行的慢思考流；
 * - 直接裸调 `agent.cancel()` 若撞在 `preStep` / `prepareCall`（`inbox.claim` 之后、`user/message` 落表之前），
 *   会导致前一条已认领的消息丢失；若撞在工具执行中途，则会误杀正在运行的工具。
 *
 * 本模块按会话跟踪实时阶段（preparing / streaming / tools / closing）：
 * - `preparing`：等待首帧 `agent/assistant-stream` `start`（此时前序 `user/message` 必定已写入 session）；
 * - `streaming`：模型正在思考或流式输出，用 `cancel(hook: qqbot:auto-steer, { keepInbox: true }) + followup` 立即打断重想；
 * - `tools`：工具正在执行，不中止信号，改走 `agent.steer`（`next-step`）在工具结束后紧接注入；
 * - `closing` / `idle`：本轮正文已生成完毕或已空闲，直接 `followup` 紧接下一轮。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { DshAgent } from '../session/types.ts';
import type { RawSessionEvent } from './events.ts';

/** 自动 steer 打断当前思考时写入 turn/end 的 hook 原因标识 */
export const AUTO_STEER_CANCEL_REASON = 'qqbot:auto-steer';

/** 等待 preparing 阶段进入 streaming 的最大保护时间（毫秒），防止异常宿主卡死提交链 */
const PREPARING_WAIT_TIMEOUT_MS = 5000;

export type TurnLivePhase = 'idle' | 'preparing' | 'streaming' | 'tools' | 'closing';

export type SteerableAgent = Pick<DshAgent, 'followup' | 'whenIdle' | 'cancel'> & Partial<Pick<DshAgent, 'status' | 'steer' | 'send' | 'session'>>;

export interface SteerableTurn {
  /** 当前回合所属的底层 agent 实例 */
  readonly ownerAgent: SteerableAgent;
  /** 当前回合是否仍处于运行态 */
  isRunning(): boolean;
  /** 等待当前回合及所有已接入的续轮彻底收敛 */
  whenIdle(): Promise<void>;
  /** 向当前活跃回合发起 steer（打断思考并追加，或在工具执行间隙插入下一步） */
  steer(
    targetAgent: SteerableAgent,
    message: unknown,
    signal: AbortSignal,
    onSubmitted: () => void,
  ): Promise<void>;
}

export interface TurnSlot {
  readonly role: 'owner' | 'steer';
  /** owner 专用：首条消息提交给 agent 后注册活跃回合控制器 */
  attach?(turn: SteerableTurn): void;
  /** steer 专用：要打断/追加的目标回合控制器 */
  readonly target?: SteerableTurn;
}

const TURN_SLOT_STATE_KEY = '__qqbotTurnSlot';

export function setTurnSlot(ctx: MiddlewareContext, slot: TurnSlot): void {
  (ctx.state as Record<string, unknown>)[TURN_SLOT_STATE_KEY] = slot;
}

export function getTurnSlot(ctx: MiddlewareContext): TurnSlot | undefined {
  return (ctx.state as Record<string, unknown>)[TURN_SLOT_STATE_KEY] as TurnSlot | undefined;
}

export function isSteeredContext(ctx: MiddlewareContext): boolean {
  return getTurnSlot(ctx)?.role === 'steer';
}

/** 判断 turn/end 的 reason 是否由本模块的自动 steer 打断触发 */
export function isAutoSteerTurnEnd(reason: unknown): boolean {
  if (reason === null || typeof reason !== 'object') return false;
  const r = reason as { kind?: unknown; reason?: { kind?: unknown; reason?: unknown } };
  return r.kind === 'aborted'
    && r.reason?.kind === 'hook'
    && r.reason?.reason === AUTO_STEER_CANCEL_REASON;
}

function submitNextStep(agent: SteerableAgent, message: unknown): void {
  if (typeof agent.steer === 'function') {
    agent.steer(message);
  } else if (typeof agent.send === 'function') {
    agent.send(message, 'next-step', true);
  } else {
    agent.followup(message);
  }
}

export class TurnSteerTracker {
  private readonly phases = new Map<string, TurnLivePhase>();
  private readonly steeredAborts = new Set<string>();
  private readonly preparingWaiters = new Map<string, Set<() => void>>();

  /** 获取会话当前阶段（无真实 sessionId 的单测 mock 视为可直接打断的 streaming） */
  public phaseOf(sessionId: string | undefined): TurnLivePhase {
    if (!sessionId) return 'streaming';
    return this.phases.get(sessionId) ?? 'idle';
  }

  /** 当前会话是否刚被自动 steer 中止（用于出站层丢弃被打断步骤的半截草稿） */
  public isSteerAborted(sessionId: string): boolean {
    return this.steeredAborts.has(sessionId);
  }

  /** followup 提交前标记进入 preparing，直到收到流式 start 帧确认 user/message 已落表 */
  public markSubmitting(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.setPhase(sessionId, 'preparing');
  }

  /** 收到实时流式帧 attempt-start：此时本步所有 user/message 均已写入 session */
  public onStreamStart(agentId: string): void {
    if (!agentId) return;
    this.setPhase(agentId, 'streaming');
  }

  /** 消费 session/event，同步推进回合内阶段 */
  public onSessionEvent(sessionId: string, raw: RawSessionEvent): void {
    if (!sessionId) return;
    switch (raw.type) {
      case 'turn/start':
        this.setPhase(sessionId, 'preparing');
        break;
      case 'assistant/message': {
        const data = raw.data as {
          interrupted?: boolean;
          message?: { content?: Array<{ type?: string }> };
        };
        if (data.interrupted === true) break;
        const hasToolCall = Array.isArray(data.message?.content)
          && data.message.content.some((b) => b.type === 'tool-call');
        this.setPhase(sessionId, hasToolCall ? 'tools' : 'closing');
        break;
      }
      case 'step/end':
        if (this.phases.get(sessionId) === 'tools') {
          this.setPhase(sessionId, 'preparing');
        }
        break;
      case 'turn/end': {
        this.steeredAborts.delete(sessionId);
        if (isAutoSteerTurnEnd(raw.data?.reason)) {
          // 续轮已在 inbox 中等待唤醒，保持 preparing 防止两轮交接微任务间隙漏判为 idle
          this.setPhase(sessionId, 'preparing');
        } else {
          this.setPhase(sessionId, 'idle');
        }
        break;
      }
    }
  }

  /** 若当前处于 preparing，等待其进入 streaming / tools / closing / idle */
  public async waitOutPreparing(sessionId: string | undefined, signal?: AbortSignal): Promise<void> {
    if (!sessionId || this.phases.get(sessionId) !== 'preparing' || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        const set = this.preparingWaiters.get(sessionId);
        if (set !== undefined) {
          set.delete(finish);
          if (set.size === 0) this.preparingWaiters.delete(sessionId);
        }
        resolve();
      };
      let set = this.preparingWaiters.get(sessionId);
      if (set === undefined) {
        set = new Set();
        this.preparingWaiters.set(sessionId, set);
      }
      set.add(finish);
      const timer = setTimeout(finish, PREPARING_WAIT_TIMEOUT_MS);
      timer.unref?.();
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  /**
   * 对正在运行的回合执行打断或下一步注入：
   * - 若等待期间原回合已自然结束（或跑团子会话发生路由切换），自动退化为完整的新回合 followup + whenIdle；
   * - 若正在运行工具（tools），走 next-step steer 不杀工具；
   * - 若正在思考/流式（streaming），cancel(keepInbox) 打断当前思考并紧接 followup 新消息。
   */
  public async steerIntoTurn(
    ownerAgent: SteerableAgent,
    targetAgent: SteerableAgent,
    isOwnerRunning: () => boolean,
    message: unknown,
    signal: AbortSignal,
    onSubmitted: () => void,
  ): Promise<void> {
    if (signal.aborted) return;

    // 罕见边界：跑团开战/收尾导致目标 agent 切换，等旧 agent 收敛后在新 agent 上走完整回合
    if (targetAgent !== ownerAgent) {
      await ownerAgent.whenIdle().catch(() => {});
      if (signal.aborted) return;
      await this.runFullTurn(targetAgent, message, signal, onSubmitted);
      return;
    }

    const sessionId = targetAgent.session?.id;
    await this.waitOutPreparing(sessionId, signal);
    if (signal.aborted) return;

    const agentRunning = targetAgent.status !== undefined ? targetAgent.status === 'running' : isOwnerRunning();
    if (!agentRunning) {
      await this.runFullTurn(targetAgent, message, signal, onSubmitted);
      return;
    }

    const phase = this.phaseOf(sessionId);
    if (phase === 'tools') {
      submitNextStep(targetAgent, message);
      onSubmitted();
      return;
    }
    if (phase === 'closing') {
      this.markSubmitting(sessionId);
      targetAgent.followup(message);
      onSubmitted();
      return;
    }

    // streaming（或保护超时后的兜底）：打断当前思考并保留队列，紧接提交补充消息
    if (sessionId) {
      this.steeredAborts.add(sessionId);
      this.setPhase(sessionId, 'preparing');
    }
    targetAgent.cancel({ kind: 'hook', reason: AUTO_STEER_CANCEL_REASON }, { keepInbox: true });
    targetAgent.followup(message);
    onSubmitted();
  }

  private async runFullTurn(
    agent: SteerableAgent,
    message: unknown,
    signal: AbortSignal,
    onSubmitted: () => void,
  ): Promise<void> {
    if (signal.aborted) return;
    const cancel = () => agent.cancel({ kind: 'user' });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      this.markSubmitting(agent.session?.id);
      agent.followup(message);
      onSubmitted();
      await agent.whenIdle();
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  private setPhase(sessionId: string, next: TurnLivePhase): void {
    if (next === 'idle') {
      this.phases.delete(sessionId);
    } else {
      this.phases.set(sessionId, next);
    }
    if (next !== 'preparing') {
      const waiters = this.preparingWaiters.get(sessionId);
      if (waiters !== undefined) {
        this.preparingWaiters.delete(sessionId);
        for (const wake of [...waiters]) wake();
      }
    }
  }
}
