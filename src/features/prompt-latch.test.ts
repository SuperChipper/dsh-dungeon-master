import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PromptLatch } from './prompt-latch.ts';

describe('PromptLatch', () => {
  it('同一 epoch 内一直返回第一次的文字，epoch 变了换新', () => {
    const latch = new PromptLatch();
    expect(latch.peek('k')).toBeUndefined();
    expect(latch.hold('k', 'e1', '旧')).toBe('旧');
    expect(latch.hold('k', 'e1', '新')).toBe('旧');
    expect(latch.peek('k')).toBe('旧');
    expect(latch.hold('k', 'e2', '新')).toBe('新');
  });

  it('不同 key 互不影响，forget 后重新锁', () => {
    const latch = new PromptLatch();
    latch.hold('a', 'e', 'A');
    expect(latch.hold('b', 'e', 'B')).toBe('B');
    latch.forget('a');
    expect(latch.hold('a', 'e', 'A2')).toBe('A2');
  });

  it('配置持久化路径后跨重载保留同一 epoch 的锁，forget 与换 epoch 同步落盘', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prompt-latch-'));
    const file = join(dir, 'latch.json');

    const first = new PromptLatch(file);
    expect(first.hold('group:1', 's:c0', '背景V1')).toBe('背景V1');

    // 模拟插件重载/宿主重启后重建实例
    const reloaded = new PromptLatch(file);
    expect(reloaded.peek('group:1')).toBe('背景V1');
    expect(reloaded.hold('group:1', 's:c0', '背景V2')).toBe('背景V1');

    // 压缩后 epoch 变更：换新并覆盖落盘
    expect(reloaded.hold('group:1', 's:c1', '背景V2')).toBe('背景V2');
    const afterCompact = new PromptLatch(file);
    expect(afterCompact.hold('group:1', 's:c1', '背景V3')).toBe('背景V2');

    // forget 同步删除持久化条目
    afterCompact.forget('group:1');
    const afterForget = new PromptLatch(file);
    expect(afterForget.peek('group:1')).toBeUndefined();
  });

  it('持久化文件损坏时安全降级为内存态', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prompt-latch-bad-'));
    const file = join(dir, 'latch.json');
    writeFileSync(file, '{broken json', 'utf8');
    const latch = new PromptLatch(file);
    expect(latch.hold('k', 'e1', 'ok')).toBe('ok');
  });
});
