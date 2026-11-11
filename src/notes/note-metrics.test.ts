import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoteMetricsStore } from './note-metrics.ts';

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'note-metrics-'));
  return join(dir, 'metrics.json');
}

const hit = (file: string, heading: string, score: number, extra: Record<string, unknown> = {}) => ({
  file,
  heading,
  score,
  ...extra,
});

describe('NoteMetricsStore', () => {
  it('空注入不写账本', () => {
    const path = tempPath();
    const store = new NoteMetricsStore(path);
    store.recordInjection([]);
    store.flush();
    expect(() => readFileSync(path, 'utf8')).toThrow();
    store.dispose();
  });

  it('按 file::heading 累计注入次数与强度', () => {
    const path = tempPath();
    const store = new NoteMetricsStore(path);
    store.recordInjection([hit('a.md', 'H1', 10), hit('b.md', 'H2', 5)]);
    store.recordInjection([hit('a.md', 'H1', 3)]);
    const summary = store.summary();
    const a = summary.find((s) => s.file === 'a.md')!;
    const b = summary.find((s) => s.file === 'b.md')!;
    expect(a.injected).toBe(2);
    // 第一次是首名（=1），第二次也是首名（=1）
    expect(a.avgStrength).toBeCloseTo(1, 5);
    expect(b.injected).toBe(1);
    // 同轮里 5/10 的强度
    expect(b.avgStrength).toBeCloseTo(0.5, 5);
    store.dispose();
  });

  it('记录命中来源，便于按来源复盘', () => {
    const path = tempPath();
    const store = new NoteMetricsStore(path);
    store.recordInjection([
      hit('a.md', 'H', 9, { exact: { score: 3 } }),
      hit('b.md', 'H', 6, { similarity: 0.8 }),
      hit('c.md', 'H', 3),
    ]);
    const via = store.summary().map((s) => [s.file, s.via]);
    expect(via).toEqual([
      ['a.md', { exact: 1 }],
      ['b.md', { semantic: 1 }],
      ['c.md', { bm25: 1 }],
    ]);
    store.dispose();
  });

  it('flush 后重新加载能读回同一份账本', () => {
    const path = tempPath();
    const first = new NoteMetricsStore(path);
    first.recordInjection([hit('a.md', 'H', 4)]);
    first.flush();
    first.dispose();
    const second = new NoteMetricsStore(path);
    expect(second.summary()[0]?.injected).toBe(1);
    second.dispose();
    rmSync(path, { force: true });
  });

  it('账本损坏时从空账本开始，不抛错', () => {
    const path = tempPath();
    const store = new NoteMetricsStore(path);
    store.dispose();
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(path, '{not json', 'utf8');
    const broken = new NoteMetricsStore(path);
    expect(broken.summary()).toEqual([]);
    broken.dispose();
    rmSync(path, { force: true });
  });

  it('旧账本没有打分字段也能读，打分后累计并在 summary 给出均分', () => {
    const path = tempPath();
    const store = new NoteMetricsStore(path);
    store.recordInjection([hit('a.md', 'H', 4), hit('b.md', 'H', 2)]);
    expect(store.summary()[0]?.avgRelevance).toBeUndefined();
    const policy = { minSamples: 8, muteBelow: 0 };
    store.recordJudgement([hit('a.md', 'H', 0), hit('b.md', 'H', 0)], [1, 0], policy);
    store.recordJudgement([hit('a.md', 'H', 0)], [0.5], policy);
    store.flush();
    store.dispose();
    const reloaded = new NoteMetricsStore(path);
    const a = reloaded.summary().find((s) => s.file === 'a.md')!;
    expect(a.judged).toBe(2);
    expect(a.avgRelevance).toBeCloseTo(0.75, 5);
    expect(reloaded.summary().find((s) => s.file === 'b.md')!.avgRelevance).toBe(0);
    reloaded.dispose();
    rmSync(path, { force: true });
  });

  it('没有注入记录的段不凭打分建条目', () => {
    const store = new NoteMetricsStore(tempPath());
    store.recordJudgement([hit('ghost.md', 'H', 0)], [1], { minSamples: 1, muteBelow: 0.5 });
    expect(store.summary()).toEqual([]);
    store.dispose();
  });

  it('评够次数且均分偏低时静音，只报告一次；unmute 清零分数', () => {
    const store = new NoteMetricsStore(tempPath());
    const policy = { minSamples: 3, muteBelow: 0.4 };
    store.recordInjection([hit('a.md', 'H', 4)]);
    expect(store.recordJudgement([hit('a.md', 'H', 0)], [0], policy, 100)).toEqual([]);
    expect(store.recordJudgement([hit('a.md', 'H', 0)], [0], policy, 200)).toEqual([]);
    expect(store.mutedAt('a.md', 'H')).toBeUndefined();
    expect(store.recordJudgement([hit('a.md', 'H', 0)], [0], policy, 300)).toEqual(['a.md::H']);
    expect(store.mutedAt('a.md', 'H')).toBe(300);
    expect(store.recordJudgement([hit('a.md', 'H', 0)], [0], policy, 400)).toEqual([]);
    expect(store.mutedAt('a.md', 'H')).toBe(300);

    store.unmute('a.md', 'H');
    expect(store.mutedAt('a.md', 'H')).toBeUndefined();
    const a = store.summary()[0]!;
    expect(a.judged).toBeUndefined();
    expect(a.injected).toBe(1);
    store.dispose();
  });
});
