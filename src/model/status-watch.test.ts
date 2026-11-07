/**
 * 双链路健康监测的测试。
 *
 * 关键行为：
 * - 只看目标模型，不被同服务其他模型带偏
 * - unknown（接口没回话 / 模型不在套餐）一律不触发切换
 * - 备用未验证时不切；备用自己坏了而主用健康时立刻回主用
 * - 恢复要连续够次数
 */
import { describe, expect, it } from 'vitest';
import { ModelWatch, isWatchedProvider, probeKindOf, probeStatus } from './status-watch.ts';
import type { Health } from './status-watch.ts';

function reply(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

const healthyPayload = {
  components: [{
    service: 'go',
    breakdown: [{ id: 'deepseek-v4.1-flash', status: 'operational', reason: 'none', speed: { ttft: 900, tps: 200 } }],
  }],
};

const degradedPayload = {
  status: 'degraded',
  components: [{
    service: 'go',
    breakdown: [
      { id: 'glm-5.3-flash', status: 'operational', reason: 'none', speed: { ttft: 1600, tps: 85 } },
      { id: 'deepseek-v4.1-flash', status: 'degraded', reason: 'upstream', speed: { ttft: 3100, tps: 140 } },
    ],
  }],
};

describe('provider 归属', () => {
  it('opencode 走状态接口，commandcode 走请求探测', () => {
    expect(isWatchedProvider('opencode-go')).toBe(true);
    expect(isWatchedProvider('commandcode')).toBe(true);
    expect(isWatchedProvider('deepseek-max')).toBe(false);
    expect(probeKindOf({ provider: 'opencode-go', model: 'x' })).toBe('status');
    expect(probeKindOf({ provider: 'commandcode', model: 'x' })).toBe('request');
  });
});

describe('probeStatus', () => {
  it('只看目标模型，同服务其他模型正常不影响判定', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => reply(degradedPayload)) as typeof fetch;
    try {
      const bad = await probeStatus({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' });
      expect(bad.state).toBe('degraded');
      expect(bad.reason).toBe('upstream');
      expect(bad.ttftMs).toBe(3100);

      const other = await probeStatus({ provider: 'opencode-go', model: 'glm-5.3-flash' });
      expect(other.state).toBe('operational');
    } finally { globalThis.fetch = original; }
  });

  it('模型不在明细里判 unknown', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => reply(healthyPayload)) as typeof fetch;
    try {
      const verdict = await probeStatus({ provider: 'opencode-go', model: 'nope' });
      expect(verdict.state).toBe('unknown');
      expect(verdict.reason).toBe('missing-model');
    } finally { globalThis.fetch = original; }
  });

  it('网络失败判 unknown 而不是 outage', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('boom'); }) as typeof fetch;
    try {
      const verdict = await probeStatus({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' });
      expect(verdict.state).toBe('unknown');
      expect(verdict.reason).toBe('network');
    } finally { globalThis.fetch = original; }
  });
});

describe('ModelWatch 双链路互备', () => {
  /** 用脚本化结果替换 probe（避免真打网络） */
  function harness(script: { primary: Health[]; backup: Health[] }) {
    const calls: string[] = [];
    const pi = { n: 0 };
    const bi = { n: 0 };
    const watch = new ModelWatch({
      primary: { provider: 'opencode-go', model: 'a' },
      backup: { provider: 'commandcode', model: 'b' },
      failThreshold: 1,
      recoverThreshold: 2,
      switchTo: async (target) => { calls.push(`to:${target.provider}/${target.model}`); },
      switchBack: async (target) => { calls.push(`back:${target.provider}/${target.model}`); },
      log: () => {},
      // 测试注入：绕过真实探测
      __probe: async (spec: { provider: string }) => {
        if (spec.provider === 'opencode-go') {
          const value = script.primary[Math.min(pi.n, script.primary.length - 1)]!;
          pi.n += 1;
          return value;
        }
        const value = script.backup[Math.min(bi.n, script.backup.length - 1)]!;
        bi.n += 1;
        return value;
      },
    } as never);
    return { watch, calls };
  }

  const ok: Health = { state: 'operational', reason: 'ok', detail: 'ok' };
  const bad: Health = { state: 'degraded', reason: 'upstream', detail: 'bad' };
  const down: Health = { state: 'outage', reason: 'network', detail: 'down' };
  const unknown: Health = { state: 'unknown', reason: 'network', detail: 'unknown' };

  it('主用降级且备用健康 → 切到备用', async () => {
    const { watch, calls } = harness({ primary: [bad], backup: [ok] });
    await watch.tick();
    expect(calls).toEqual(['to:commandcode/b']);
    expect(watch.state.usingBackup).toBe(true);
  });

  it('主用降级但备用未验证 → 不切', async () => {
    const { watch, calls } = harness({ primary: [bad], backup: [unknown] });
    await watch.tick();
    expect(calls).toEqual([]);
    expect(watch.state.usingBackup).toBe(false);
  });

  it('备用态下主用连续正常够次数才切回', async () => {
    const { watch, calls } = harness({
      primary: [bad, ok, ok, ok],
      backup: [ok, ok, ok, ok],
    });
    await watch.tick();
    expect(calls).toEqual(['to:commandcode/b']);
    await watch.tick();
    expect(calls).toHaveLength(1);
    await watch.tick();
    expect(calls).toEqual(['to:commandcode/b', 'back:opencode-go/a']);
  });

  it('备用自己挂掉而主用健康 → 立刻回主用', async () => {
    const { watch, calls } = harness({
      primary: [bad, ok],
      backup: [ok, down],
    });
    await watch.tick();
    await watch.tick();
    expect(calls).toEqual(['to:commandcode/b', 'back:opencode-go/a']);
  });

  it('两侧都 unknown 时不动', async () => {
    const { watch, calls } = harness({ primary: [unknown], backup: [unknown] });
    await watch.tick();
    expect(calls).toEqual([]);
  });
});
