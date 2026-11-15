import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { setTurnSlot, type SteerableTurn } from '../transport/turn-steer.ts';

interface Waiter {
  ctx: MiddlewareContext;
  admit: (run: boolean) => void;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface TargetQueue {
  pending: Waiter[];
  windowAnchorAt: number;
  submitChain: Promise<void>;
  activeTurn?: SteerableTurn;
  inFlightSteers: number;
  closing: boolean;
  extraRuns: Promise<void>[];
  refreshTimeout?: () => void;
}

export interface SerialMergeOptions {
  maxQueue: number;
  maxProcessingMs: number;
  onMerge: (buffered: MiddlewareContext[]) => MiddlewareContext;
  /** 短时自动 steer 时间窗（毫秒，支持函数动态读取最新配置；<=0 关闭） */
  steerWindowMs?: number | (() => number);
  /** 判断当前入站消息是否允许触发短时自动 steer（群聊显式 @bot / 私聊连发） */
  canSteer?: (ctx: MiddlewareContext) => boolean;
}

function resolveSteerWindowMs(value: SerialMergeOptions['steerWindowMs']): number {
  if (typeof value === 'function') return value();
  return value ?? 0;
}

async function drainSteers(queue: TargetQueue): Promise<void> {
  while (true) {
    const chain = queue.submitChain;
    const extras = queue.extraRuns.splice(0);
    await chain;
    if (extras.length > 0) await Promise.allSettled(extras);
    if (queue.activeTurn?.isRunning()) {
      await queue.activeTurn.whenIdle().catch(() => {});
    }
    if (
      queue.submitChain === chain
      && queue.extraRuns.length === 0
      && !queue.activeTurn?.isRunning()
      && queue.inFlightSteers === 0
    ) {
      break;
    }
  }
  queue.closing = true;
}

/**
 * SDK 1.0.5 的 merge 分支在唤醒 survivor 后就释放锁，survivor 也没有 watchdog。
 * 把同一把锁直接交给下一批，直到它自己的下游链收敛，避免慢工具期间并发 followup；
 * 同时支持短时间窗口内的显式 @bot / 私聊补充消息通过 submitChain 有序打断并 steer 当前回合。
 */
export function serialMerge(options: SerialMergeOptions): Middleware {
  const queues = new Map<string, TargetQueue>();

  function handoff(key: string, queue: TargetQueue): void {
    const batch = queue.pending.splice(0);
    const ready = batch.filter((w) => !w.ctx.signal.aborted);
    let survivor: MiddlewareContext | undefined;
    try {
      if (ready.length > 0) {
        const contexts = ready.map((w) => w.ctx);
        const merged = options.onMerge(contexts);
        survivor = contexts.includes(merged) ? merged : contexts[0];
      }
    } catch (error) {
      // 合并失败仍逐条保留消息，不能让所有等待者悬空。
      ready[0]?.ctx.log.error?.(`[concurrency:merge] ${String(error)}`);
      survivor = ready[0]?.ctx;
      queue.pending.unshift(...ready.slice(1));
    }
    if (survivor === undefined) queues.delete(key);
    // 存在 survivor 时保留 Map 中的占用；新消息必须等它完成，不能越过交接窗口。
    for (const waiter of batch) {
      if (!queue.pending.includes(waiter)) waiter.admit(waiter.ctx === survivor);
    }
  }

  return async (ctx, next) => {
    if (ctx.signal.aborted) return;
    const target = ctx.message.replyTarget;
    const key = `${target.scope}:${target.targetId}`;
    let queue = queues.get(key);
    if (queue === undefined) {
      queue = {
        pending: [],
        windowAnchorAt: Date.now(),
        submitChain: Promise.resolve(),
        inFlightSteers: 0,
        closing: false,
        extraRuns: [],
      };
      queues.set(key, queue);
    } else {
      const windowMs = resolveSteerWindowMs(options.steerWindowMs);
      const steerable = windowMs > 0
        && !queue.closing
        && (options.canSteer?.(ctx) ?? false)
        && Date.now() - queue.windowAnchorAt <= windowMs;

      if (steerable) {
        if (queue.pending.length + queue.inFlightSteers >= options.maxQueue) {
          ctx.log.warn?.(`[concurrency:merge] queue full for ${key}`);
          ctx.stop('concurrency:merge-full');
          return;
        }
        const activeQueue = queue;
        activeQueue.inFlightSteers++;
        const prevSubmit = activeQueue.submitChain;
        const currentSubmit = createDeferred();
        activeQueue.submitChain = currentSubmit.promise;
        try {
          await prevSubmit;
          if (ctx.signal.aborted) return;
          if (activeQueue.activeTurn !== undefined && activeQueue.activeTurn.isRunning()) {
            activeQueue.windowAnchorAt = Date.now();
            activeQueue.refreshTimeout?.();
            setTurnSlot(ctx, { role: 'steer', target: activeQueue.activeTurn });
            await next();
          } else {
            // 前序消息未进入 agent 回合（如空消息提前返回）或刚巧结束：升级为当前锁内的 owner 执行
            activeQueue.windowAnchorAt = Date.now();
            activeQueue.refreshTimeout?.();
            setTurnSlot(ctx, {
              role: 'owner',
              attach(turn) {
                activeQueue.activeTurn = turn;
                activeQueue.windowAnchorAt = Date.now();
                currentSubmit.resolve();
              },
            });
            const run = next();
            activeQueue.extraRuns.push(run);
            await run;
          }
        } finally {
          activeQueue.inFlightSteers--;
          currentSubmit.resolve();
        }
        return;
      }

      if (queue.pending.length + queue.inFlightSteers >= options.maxQueue) {
        ctx.log.warn?.(`[concurrency:merge] queue full for ${key}`);
        ctx.stop('concurrency:merge-full');
        return;
      }
      const waitingQueue = queue;
      const admitted = await new Promise<boolean>((resolve) => {
        const abort = () => {
          const index = waitingQueue.pending.indexOf(waiter);
          if (index >= 0) waitingQueue.pending.splice(index, 1);
          waiter.admit(false);
        };
        const waiter: Waiter = {
          ctx,
          admit: (run) => {
            ctx.signal.removeEventListener('abort', abort);
            resolve(run);
          },
        };
        waitingQueue.pending.push(waiter);
        ctx.signal.addEventListener('abort', abort, { once: true });
      });
      if (!admitted) return;
    }

    const activeQueue = queue;
    const ownerSubmit = createDeferred();
    activeQueue.windowAnchorAt = Date.now();
    activeQueue.submitChain = ownerSubmit.promise;
    activeQueue.activeTurn = undefined;
    activeQueue.closing = false;
    activeQueue.extraRuns = [];
    setTurnSlot(ctx, {
      role: 'owner',
      attach(turn) {
        activeQueue.activeTurn = turn;
        activeQueue.windowAnchorAt = Date.now();
        ownerSubmit.resolve();
      },
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const resetTimer = () => {
      clearTimer();
      if (options.maxProcessingMs > 0) {
        timer = setTimeout(() => {
          ctx.log.warn?.(`[concurrency] aborting ${key} after ${options.maxProcessingMs}ms`);
          ctx.abort('concurrency:processing-timeout');
        }, options.maxProcessingMs);
        timer.unref?.();
      }
    };
    activeQueue.refreshTimeout = resetTimer;

    try {
      if (ctx.signal.aborted) return;
      resetTimer();
      await next();
    } finally {
      ownerSubmit.resolve();
      await drainSteers(activeQueue);
      clearTimer();
      activeQueue.refreshTimeout = undefined;
      activeQueue.activeTurn = undefined;
      // abort 只是请求取消；等下游完成清理再交接，避免旧回合取消新回合。
      handoff(key, activeQueue);
    }
  };
}
