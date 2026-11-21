import { describe, it, expect } from 'vitest';
import {
  ContextLockManager,
  compactThreshold,
  decideAutoCompact,
  deferCeiling,
  hasOpenBackgroundJobs,
  lastTurnUsedTools,
  shouldIdleCompact,
  type CompactPolicyConfig,
} from './compact-policy.ts';

const cfg: CompactPolicyConfig = { autoCompactTokens: 120000, autoCompactPrivateRatio: 0.5, autoCompactDeferOnTools: true };

describe('compactThreshold', () => {
  it('私聊按窗口比例放宽，群聊用固定阈值', () => {
    expect(compactThreshold('c2c', 1_000_000, cfg)).toBe(500000);
    expect(compactThreshold('group', 1_000_000, cfg)).toBe(120000);
  });

  it('私聊不低于群聊阈值（小窗口模型不会反而压得更狠）', () => {
    expect(compactThreshold('c2c', 131072, cfg)).toBe(120000);
  });

  it('取不到窗口 / 比例为 0 → 私聊退回固定阈值', () => {
    expect(compactThreshold('c2c', undefined, cfg)).toBe(120000);
    expect(compactThreshold('c2c', 1_000_000, { ...cfg, autoCompactPrivateRatio: 0 })).toBe(120000);
  });

  it('autoCompactTokens=0 时私聊也关闭', () => {
    expect(compactThreshold('c2c', 1_000_000, { ...cfg, autoCompactTokens: 0 })).toBe(0);
  });
});

describe('deferCeiling', () => {
  it('阈值 1.5 倍，且不超过窗口 90%、不低于阈值', () => {
    expect(deferCeiling(120000, undefined)).toBe(180000);
    expect(deferCeiling(500000, 1_000_000)).toBe(750000);
    expect(deferCeiling(800000, 1_000_000)).toBe(900000);
    expect(deferCeiling(120000, 125000)).toBe(120000);
  });
});

describe('decideAutoCompact', () => {
  const base = { threshold: 500000, contextWindow: 1_000_000, lastTurnUsedTools: false, deferOnTools: true };

  it('未到阈值 / 大小未知 / 关闭 → skip', () => {
    expect(decideAutoCompact({ ...base, contextTokens: 499999 })).toBe('skip');
    expect(decideAutoCompact({ ...base, contextTokens: undefined })).toBe('skip');
    expect(decideAutoCompact({ ...base, threshold: 0, contextTokens: 900000 })).toBe('skip');
  });

  it('超阈值且上一轮没调工具 → compact', () => {
    expect(decideAutoCompact({ ...base, contextTokens: 500000 })).toBe('compact');
  });

  it('上一轮调了工具 → 推迟，直到硬上限', () => {
    const busy = { ...base, lastTurnUsedTools: true };
    expect(decideAutoCompact({ ...busy, contextTokens: 600000 })).toBe('defer');
    expect(decideAutoCompact({ ...busy, contextTokens: 749999 })).toBe('defer');
    expect(decideAutoCompact({ ...busy, contextTokens: 750000 })).toBe('compact');
  });

  it('关掉推迟时调工具也照压', () => {
    expect(decideAutoCompact({ ...base, lastTurnUsedTools: true, deferOnTools: false, contextTokens: 600000 })).toBe('compact');
  });
});

describe('lastTurnUsedTools', () => {
  const ev = (...types: string[]) => types.map((type) => ({ type }));

  it('最近一轮有 tool/call → true', () => {
    expect(lastTurnUsedTools(ev('turn/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'assistant/message', 'turn/end'))).toBe(true);
  });

  it('只看最近一轮：之前轮次的工具调用不算', () => {
    expect(lastTurnUsedTools(ev(
      'turn/start', 'user/message', 'tool/call', 'tool/result', 'assistant/message', 'turn/end',
      'turn/start', 'user/message', 'assistant/message', 'turn/end',
    ))).toBe(false);
  });

  it('没有 turn/start 时以上一轮的 turn/end 为界', () => {
    expect(lastTurnUsedTools(ev('tool/call', 'turn/end', 'user/message', 'assistant/message', 'turn/end'))).toBe(false);
  });

  it('turn/end 之后的事件（如压缩标记）不影响判断', () => {
    expect(lastTurnUsedTools(ev('turn/start', 'tool/call', 'tool/result', 'turn/end', 'compaction/start', 'compaction/end'))).toBe(true);
  });

  it('没有事件 / 还没结束过一轮 → false', () => {
    expect(lastTurnUsedTools(undefined)).toBe(false);
    expect(lastTurnUsedTools(ev('turn/start', 'tool/call'))).toBe(false);
  });
});

describe('ContextLock 与后台任务保护', () => {
  it('contextLocked 在阈值与硬上限之间推迟 autoCompact，超硬上限仍强制压缩', () => {
    const base = { threshold: 500000, contextWindow: 1_000_000, lastTurnUsedTools: false, deferOnTools: false };
    expect(decideAutoCompact({ ...base, contextTokens: 600000, contextLocked: true })).toBe('defer');
    expect(decideAutoCompact({ ...base, contextTokens: 749999, contextLocked: true })).toBe('defer');
    expect(decideAutoCompact({ ...base, contextTokens: 750000, contextLocked: true })).toBe('compact');
  });

  it('contextLocked 时禁止空闲压缩', () => {
    expect(shouldIdleCompact({
      contextTokens: 200000,
      minTokens: 100000,
      idleMs: 30 * 60_000,
      minIdleMs: 20 * 60_000,
      provider: 'google',
      providers: 'google',
      contextLocked: true,
    })).toBe(false);
  });

  it('ContextLockManager 支持多租约叠加、幂等释放与 TTL 自动过期', () => {
    const locks = new ContextLockManager();
    const t0 = 1_000_000;
    const releaseA = locks.acquire('s1', 'multi-step', 10_000, t0);
    const releaseB = locks.acquire('s1', 'persona-switch', 5_000, t0);
    expect(locks.status('s1', t0 + 100)).toEqual({ locked: true, reasons: ['multi-step', 'persona-switch'] });

    releaseB();
    releaseB();
    expect(locks.status('s1', t0 + 100)).toEqual({ locked: true, reasons: ['multi-step'] });

    expect(locks.status('s1', t0 + 10_001)).toEqual({ locked: false, reasons: [] });
    releaseA();
  });

  it('hasOpenBackgroundJobs 仅在最近摘要后存在未 settled 的 job 时返回 true', () => {
    expect(hasOpenBackgroundJobs([
      { type: 'job/registered', data: { jobId: 'old-job' } },
      { type: 'compaction/summary', data: {} },
      { type: 'job/registered', data: { jobId: 'j1' } },
      { type: 'job/settled', data: { jobId: 'j1' } },
    ])).toBe(false);

    expect(hasOpenBackgroundJobs([
      { type: 'job/registered', data: { jobId: 'j1' } },
      { type: 'job/registered', data: { jobId: 'j2' } },
      { type: 'job/settled', data: { jobId: 'j1' } },
    ])).toBe(true);
  });
});
