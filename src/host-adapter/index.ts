/**
 * DSH 宿主非公开内部接口适配层。
 *
 * 将本插件依赖但尚未进入 `@deepseek-ai/dsh-*` 稳定公开契约的探测、强转与补丁
 * （`snapshotEvents` / `contentGeneration`、`suppressRuntimeContext`、`compactIfNeeded`
 * 猴子补丁、无类型 `ctx.on` / `ctx.inject` / `ctx.effect`）集中隔离在此模块，
 * 避免散落在业务代码里；后续宿主升级或官方提供对应钩子时，只需替换此适配器。
 */
import { symbols, type Context } from '@deepseek-ai/cordis';

/** 宿主 Session 事件访问兼容接口（0.2.x 提供 snapshotEvents()，旧版暴露 events） */
export interface SessionEventsHostLike<T = unknown> {
  readonly events?: readonly T[];
  snapshotEvents?(): readonly T[];
}

/** 宿主 Session surface 状态接口（压缩或替换历史时 contentGeneration 递增） */
export interface SessionSurfaceHostLike {
  readonly surface?: {
    readonly contentGeneration?: number;
    readonly nodes?: readonly number[];
  };
}

interface HostCompactionTarget<TAgent> {
  compactIfNeeded?(agent: TAgent, trigger: string, signal?: AbortSignal): Promise<unknown>;
}

interface HostEventsContextLike {
  on(event: string, handler: (...args: unknown[]) => unknown, options?: { global?: boolean }): unknown;
}

interface HostEffectContextLike {
  effect?(fn: () => (() => Promise<void> | void) | void, name?: string): unknown;
}

interface HostInjectContextLike {
  inject?(
    deps: readonly string[],
    callback: (scoped: Context & Record<string, unknown>) => void,
  ): { dispose?(): unknown } | void;
  get?(name: string): unknown;
}

/** 尝试读取 Session 事件序列；未暴露任何事件源时返回 `undefined`。 */
export function tryReadSessionEvents<T = unknown>(session: SessionEventsHostLike<T> | undefined): readonly T[] | undefined {
  return session?.snapshotEvents?.() ?? session?.events;
}

/** 统一读取 Session 事件序列：优先使用宿主 0.2.x 的 `snapshotEvents()`，否则回退 `events`。 */
export function readSessionEvents<T = unknown>(session: SessionEventsHostLike<T> | undefined): readonly T[] {
  return tryReadSessionEvents(session) ?? [];
}

/** 读取 Session `surface.contentGeneration`（未暴露时按 `0` 处理）。 */
export function readSessionContentGeneration(session: SessionSurfaceHostLike | undefined): number {
  return session?.surface?.contentGeneration ?? 0;
}

/** 在 Cordis Context 上登记释放钩子，收敛跨版本 `.effect(...)` 弱类型强转。 */
export function registerHostEffect(
  ctx: Context,
  fn: () => (() => Promise<void> | void) | void,
  name?: string,
): void {
  (ctx as unknown as HostEffectContextLike).effect?.(fn, name);
}

/** 可选声明式注入宿主服务（服务未就绪时不阻塞，替换或卸载时自动对齐作用域生命周期）。 */
export function injectHostService<T = unknown>(
  ctx: Context,
  serviceName: string,
  callback: (service: T, scoped: Context) => void,
): void {
  const hostCtx = ctx as unknown as HostInjectContextLike;
  hostCtx.inject?.([serviceName], (scoped) => {
    const service = scoped[serviceName] as T | undefined;
    if (service !== undefined) callback(service, scoped);
  });
}

/** 监听宿主 `session/event` 持久化事件流。 */
export function onHostSessionEvent<TSession = unknown, TEvent = unknown>(
  ctx: Context,
  handler: (session: TSession, event: TEvent) => void,
): void {
  (ctx as unknown as HostEventsContextLike).on('session/event', handler as (...args: unknown[]) => unknown);
}

/** 全局监听宿主 `agent/turn-stopping` 钩子。 */
export function onHostAgentTurnStopping<TAgent = unknown>(
  ctx: Context,
  handler: (payload: { agent: TAgent; signal: AbortSignal }) => Promise<void> | void,
): void {
  (ctx as unknown as HostEventsContextLike).on(
    'agent/turn-stopping',
    handler as (...args: unknown[]) => unknown,
    { global: true },
  );
}

/** 全局监听宿主 `agent/assistant-stream` 瞬态流式帧。 */
export function onHostAssistantStream(
  ctx: Context,
  handler: (payload: unknown) => void,
): void {
  (ctx as unknown as HostEventsContextLike).on('agent/assistant-stream', handler, { global: true });
}

/** 全局监听宿主 `agent/created` / `agent/disposed` 生命周期事件。 */
export function onHostAgentLifecycle<TAgent = unknown>(
  ctx: Context,
  event: 'agent/created' | 'agent/disposed',
  handler: (payload: { agent?: TAgent }) => void,
): void {
  (ctx as unknown as HostEventsContextLike).on(
    event,
    handler as (...args: unknown[]) => unknown,
    { global: true },
  );
}

/** 若子代理 `systemPrompt` 暴露了 `suppressRuntimeContext()`，则关闭其自动全量 runtime-context 注入。 */
export function suppressScopeRuntimeContext(scope: Context): boolean {
  const prompt = (scope as unknown as { get?(name: string): unknown }).get?.('systemPrompt') as
    | { suppressRuntimeContext?: () => unknown }
    | undefined;
  if (typeof prompt?.suppressRuntimeContext !== 'function') return false;
  prompt.suppressRuntimeContext();
  return true;
}

/**
 * 拦截宿主 `compaction` 服务的 `compactIfNeeded`，为指定短期子代理跳过自动压缩与溢出摘要重整。
 *
 * 注：宿主目前尚无 `autoCompact: false` 公开选项；这里显式通过 Cordis `symbols.original`
 * 解包单例并在卸载时按原始属性描述符无痕还原，待宿主补齐公开配置后即可移除此补丁。
 */
export function installHostCompactionGuard<TAgent = unknown>(
  ctx: Context,
  options: {
    shouldSkip(agent: TAgent, trigger: string): boolean;
    onSkipped?(agent: TAgent, trigger: string): void;
  },
): () => void {
  const restorer = new Set<() => void>();
  const attach = (rawService: unknown): (() => void) | undefined => {
    if (rawService === undefined || rawService === null || (typeof rawService !== 'object' && typeof rawService !== 'function')) {
      return undefined;
    }
    // 宿主 BasicCompactionEngine 的监听器绑定在原始实例 `this` 上，必须解包 Cordis 代理再拦截 `compactIfNeeded`。
    const target = ((rawService as Record<symbol, unknown>)[symbols.original] ?? rawService) as HostCompactionTarget<TAgent>;
    const ownDesc = Object.getOwnPropertyDescriptor(target, 'compactIfNeeded');
    const original = target.compactIfNeeded;
    if (typeof original !== 'function') return undefined;

    let active = true;
    const wrapped: NonNullable<HostCompactionTarget<TAgent>['compactIfNeeded']> = async (agent, trigger, signal) => {
      if (options.shouldSkip(agent, trigger)) {
        options.onSkipped?.(agent, trigger);
        return null;
      }
      return await original.call(target, agent, trigger, signal);
    };
    target.compactIfNeeded = wrapped;

    const undo = (): void => {
      if (!active) return;
      active = false;
      restorer.delete(undo);
      if (target.compactIfNeeded !== wrapped) return;
      if (ownDesc !== undefined) Object.defineProperty(target, 'compactIfNeeded', ownDesc);
      else delete (target as { compactIfNeeded?: unknown }).compactIfNeeded;
    };
    restorer.add(undo);
    return undo;
  };

  const hostCtx = ctx as unknown as HostInjectContextLike;
  let forkDispose: (() => void) | undefined;
  if (typeof hostCtx.inject === 'function') {
    const fork = hostCtx.inject(['compaction'], (scoped) => {
      registerHostEffect(scoped, () => attach(scoped.compaction), 'im-qqbot.combat-compaction-guard');
    });
    if (fork && typeof fork.dispose === 'function') {
      forkDispose = () => { void fork.dispose?.(); };
    }
  } else if (typeof hostCtx.get === 'function') {
    try {
      attach(hostCtx.get('compaction'));
    } catch {
      /* compaction 服务未加载时跳过 */
    }
  }

  return () => {
    for (const undo of [...restorer]) undo();
    forkDispose?.();
    forkDispose = undefined;
  };
}
