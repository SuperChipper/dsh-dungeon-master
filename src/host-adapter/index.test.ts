import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { symbols, type Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import {
  BiliSchema,
  ConfigSchema,
  DND_COMBAT_AGENT_DEFAULTS,
  FanartSchema,
  ModelFailoverSchema,
  ReverseImageSchema,
  SingSchema,
} from '../config.ts';
import {
  DEFAULT_CHAT_BASE_URL,
  DEFAULT_CHAT_KEY_REF,
  DEFAULT_CHAT_MODEL,
  DEFAULT_VIDEO_MODEL,
} from '../media/chat-gateway.ts';
import {
  getHostService,
  installHostCompactionGuard,
  onHostAgentLifecycle,
  onHostAgentPreStep,
  onHostApprovalRequest,
  onHostSystemPromptAssemble,
  onHostToolsExecute,
  onHostToolsPostExecute,
  readHostContextProp,
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

  it('readHostContextProp 与 getHostService 安全读取宿主属性与可选服务', () => {
    const fakeAgents = { list: [] };
    const ctx = {
      agents: fakeAgents,
      get: (key: string) => {
        if (key === 'broken') throw new Error('not ready');
        return key === 'llm' ? { ok: true } : undefined;
      },
    } as unknown as Context;

    expect(readHostContextProp(ctx, 'agents')).toBe(fakeAgents);
    expect(readHostContextProp(ctx, 'missing')).toBeUndefined();
    expect(getHostService<{ ok: boolean }>(ctx, 'llm')).toEqual({ ok: true });
    expect(getHostService(ctx, 'broken')).toBeUndefined();
    expect(getHostService({} as unknown as Context, 'llm')).toBeUndefined();
  });

  it('事件注册辅助正确绑定瀑布钩子，并在缺失 on 时安全跳过 agent/pre-step', () => {
    const on = vi.fn();
    const ctx = { on } as unknown as Context;
    const approval = vi.fn();
    const toolsExec = vi.fn(async () => ({}));
    const toolsPost = vi.fn(async () => ({ kind: 'continue' }));
    const assemble = vi.fn(async () => ({ sections: [] }));
    const preStep = vi.fn(async () => ({ kind: 'continue' }));

    onHostApprovalRequest(ctx, approval);
    expect(on).toHaveBeenCalledWith('approval/request', approval, { global: true, prepend: true });

    onHostToolsExecute(ctx, toolsExec);
    expect(on).toHaveBeenCalledWith('tools/execute', toolsExec);

    onHostToolsPostExecute(ctx, toolsPost);
    expect(on).toHaveBeenCalledWith('tools/post-execute', toolsPost, { global: true });

    onHostSystemPromptAssemble(ctx, assemble);
    expect(on).toHaveBeenCalledWith('system-prompt/assemble', assemble);

    expect(onHostAgentPreStep(ctx, preStep)).toBe(true);
    expect(on).toHaveBeenCalledWith('agent/pre-step', preStep, { global: true });
    expect(onHostAgentPreStep({} as unknown as Context, preStep)).toBe(false);
  });
});

function walkProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkProductionTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('plugin boundary invariants', () => {
  it('业务代码禁止绕过 host-adapter 直接强转 ctx/scope 或触碰未公开宿主内部符号', () => {
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const guards: Array<[string, RegExp]> = [
      ['ctx/scope cast', /\b(?:this\.)?(?:ctx|scope)\s+as\s+unknown\b/],
      ['symbols.original', /\bsymbols\.original\b/],
      ['compactIfNeeded', /\bcompactIfNeeded\b/],
      ['suppressRuntimeContext', /\bsuppressRuntimeContext\b/],
    ];

    const violations: string[] = [];
    for (const file of walkProductionTsFiles(srcRoot)) {
      const rel = relative(srcRoot, file).replace(/\\/g, '/');
      if (rel.startsWith('host-adapter/') || rel === 'client/host-adapter.ts') continue;
      const content = readFileSync(file, 'utf8');
      for (const [label, pattern] of guards) {
        if (pattern.test(content)) violations.push(`${rel} [${label}]`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('公开发包默认配置保持去个人化且非核心扩展工具默认关闭', () => {
    expect(BiliSchema(undefined).enabled).toBe(false);
    expect(FanartSchema({} as never).enabled).toBe(false);
    expect(ReverseImageSchema(undefined).enabled).toBe(false);
    expect(SingSchema(undefined).enabled).toBe(false);

    const fullDefaults = ConfigSchema({} as never);
    expect(fullDefaults.fanart.enabled).toBe(false);
    expect(fullDefaults.bili?.enabled).toBe(false);
    expect(fullDefaults.reverseImage?.enabled).toBe(false);
    expect(fullDefaults.sing?.enabled).toBe(false);

    const failover = ModelFailoverSchema({} as never);
    expect(failover.backupProvider).toBe('');
    expect(failover.backupModel).toBe('');
    expect(failover.backupApiKeyEnv).toBe('');

    expect(DND_COMBAT_AGENT_DEFAULTS.provider).toBe('');
    expect(DND_COMBAT_AGENT_DEFAULTS.model).toBe('');
    expect(DND_COMBAT_AGENT_DEFAULTS.reasoningEffort).toBe('');

    expect(DEFAULT_CHAT_BASE_URL).toBe('');
    expect(DEFAULT_CHAT_MODEL).toBe('');
    expect(DEFAULT_CHAT_KEY_REF).toBe('');
    expect(DEFAULT_VIDEO_MODEL).toBe('');
  });

  it('公开 bundle 模板 cordis.patch.yml 仅使用环境变量占位且不含私人渠道或音色映射', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const patchContent = readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8');
    expect(patchContent).toMatch(/appId:\s*__FROM_ENV__/);
    expect(patchContent).toMatch(/appSecret:\s*__FROM_ENV__/);
    expect(patchContent).not.toMatch(/roleVoices|opencode\.ai|commandcode/i);
  });
});
