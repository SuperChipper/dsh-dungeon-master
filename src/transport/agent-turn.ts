import {
  TurnSteerTracker,
  type SteerableAgent,
  type SteerableTurn,
  type TurnSlot,
} from './turn-steer.ts';

export interface InboundTurnOptions {
  slot?: TurnSlot;
  tracker?: TurnSteerTracker;
}

const fallbackTracker = new TurnSteerTracker();

/** QQ 的 watchdog 只能取消自己交给 agent 的活动，收敛后立即解绑；支持短时消息通过 TurnSlot 自动 steer。 */
export async function runInboundTurn(
  agent: SteerableAgent,
  message: unknown,
  signal: AbortSignal,
  onSubmitted: () => void,
  options?: InboundTurnOptions,
): Promise<void> {
  // 附件下载、会话恢复可能已经耗尽了超时，不能再启动一个迟到的回合。
  if (signal.aborted) return;

  const slot = options?.slot;
  const tracker = options?.tracker ?? fallbackTracker;

  if (slot?.role === 'steer' && slot.target !== undefined) {
    await slot.target.steer(agent, message, signal, onSubmitted);
    return;
  }

  let running = true;
  const controller: SteerableTurn = {
    ownerAgent: agent,
    isRunning: () => (agent.status !== undefined ? agent.status === 'running' && running : running),
    whenIdle: () => agent.whenIdle(),
    steer: (targetAgent, nextMessage, steerSignal, onSteerSubmitted) =>
      tracker.steerIntoTurn(agent, targetAgent, () => running, nextMessage, steerSignal, onSteerSubmitted),
  };

  const cancel = () => agent.cancel({ kind: 'user' });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    tracker.markSubmitting(agent.session?.id);
    agent.followup(message);
    onSubmitted();
    slot?.attach?.(controller);
    await agent.whenIdle();
  } finally {
    running = false;
    signal.removeEventListener('abort', cancel);
  }
}
