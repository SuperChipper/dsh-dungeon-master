import { symbols, type Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import {
  installHostCompactionGuard,
  onHostAgentLifecycle,
  readSessionContentGeneration,
  readSessionEvents,
  registerHostEffect,
  suppressScopeRuntimeContext,
  tryReadSessionEvents,
} from './index.ts';

describe('host-adapter', () => {
  it('tryReadSessionEvents 与 readSessionEvents 优先读取 snapshotEvents()，兼容回退 events', () => {
    const legacy = [{ type: 'user/message' }];
    const live = [{ type: 'assistant/message' }];
    expect(tryReadSessionEvents(undefined)).toBeUndefined();
    expect(readSessionEvents(undefined)).toEqual([]);
    expect(readSessionEvents({ events: legacy })).toEqual(legacy);
    expect(readSessionEvents({ events: legacy, snapshotEvents: () => live })).toEqual(live);
  });

  it('readSessionContentGeneration 缺失 surface 时安全返回 0', () => {
    expect(readSessionContentGeneration(undefined)).toBe(0);
    expect(readSessionContentGeneration({})).toBe(0);
    expect(readSessionContentGeneration({ surface: { contentGeneration: 7 } })).toBe(7);
  });

  it('suppressScopeRuntimeContext 仅在宿主提供该方法时触发并返回 true', () => {
    const suppress = vi.fn();
    expect(suppressScopeRuntimeContext({ get: () => ({ suppressRuntimeContext: suppress }) } as unknown as Context)).toBe(true);
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(suppressScopeRuntimeContext({ get: () => ({}) } as unknown as Context)).toBe(false);
    expect(suppressScopeRuntimeContext({ get: () => undefined } as unknown as Context)).toBe(false);
  });

  it('installHostCompactionGuard 解包 symbols.original、拦截匹配 agent 并于释放时无痕还原', async () => {
    class FakeCompactionEngine {
      public readonly calls: Array<{ id: string; trigger: string }> = [];
      async compactIfNeeded(agent: { id: string }, trigger: string): Promise<string> {
        this.calls.push({ id: agent.id, trigger });
        return 'compacted';
      }
    }
    const rawEngine = new FakeCompactionEngine();
    const proxyEngine = { [symbols.original]: rawEngine };

    const disposers: Array<() => void> = [];
    const ctx = {
      inject: (_deps: string[], cb: (scoped: Record<string, unknown>) => void) => {
        cb({
          compaction: proxyEngine,
          effect: (fn: () => (() => void) | undefined) => {
            const cleanup = fn();
            if (cleanup) disposers.push(cleanup);
          },
        });
        return { dispose: () => { for (const d of disposers.splice(0)) d(); } };
      },
    } as unknown as Context;

    const skipped: string[] = [];
    const cleanup = installHostCompactionGuard<{ id: string }>(ctx, {
      shouldSkip: (agent) => agent.id.startsWith('combat-'),
      onSkipped: (agent, trigger) => skipped.push(`${agent.id}:${trigger}`),
    });

    // 原型方法被包了一层实例属性：跳过 combat-*，正常 agent 绑定正确 this 转发到原方法
    await expect(rawEngine.compactIfNeeded({ id: 'combat-1' }, 'auto')).resolves.toBeNull();
    await expect(rawEngine.compactIfNeeded({ id: 'main-1' }, 'auto')).resolves.toBe('compacted');
    expect(skipped).toEqual(['combat-1:auto']);
    expect(rawEngine.calls).toEqual([{ id: 'main-1', trigger: 'auto' }]);

    cleanup();
    // 清理后自有属性应被删掉、回到原型方法，且不再跳过 combat-*
    expect(Object.prototype.hasOwnProperty.call(rawEngine, 'compactIfNeeded')).toBe(false);
    await expect(rawEngine.compactIfNeeded({ id: 'combat-2' }, 'auto')).resolves.toBe('compacted');
    expect(rawEngine.calls).toEqual([
      { id: 'main-1', trigger: 'auto' },
      { id: 'combat-2', trigger: 'auto' },
    ]);
  });

  it('onHostAgentLifecycle 与 registerHostEffect 正确委托给 Context', () => {
    const on = vi.fn();
    const effect = vi.fn();
    const ctx = { on, effect } as unknown as Context;
    const handler = vi.fn();
    onHostAgentLifecycle(ctx, 'agent/created', handler);
    expect(on).toHaveBeenCalledWith('agent/created', handler, { global: true });

    const fn = () => () => {};
    registerHostEffect(ctx, fn, 'test.effect');
    expect(effect).toHaveBeenCalledWith(fn, 'test.effect');
  });
});
