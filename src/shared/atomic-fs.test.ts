import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic, writeTextAtomic } from './atomic-fs.ts';

const dirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-atomic-fs-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('atomic-fs', () => {
  it('writeTextAtomic 会自动创建父目录、覆盖旧内容且不残留临时文件', () => {
    const dir = makeTmp();
    const target = join(dir, 'nested', 'state.txt');
    writeTextAtomic(target, 'first');
    expect(readFileSync(target, 'utf8')).toBe('first');

    writeTextAtomic(target, 'second');
    expect(readFileSync(target, 'utf8')).toBe('second');
    expect(readdirSync(join(dir, 'nested'))).toEqual(['state.txt']);
  });

  it('writeJsonAtomic 支持 indent 与 trailingNewline', () => {
    const dir = makeTmp();
    const target = join(dir, 'data.json');
    writeJsonAtomic(target, { a: 1, b: 'ok' }, { indent: 2, trailingNewline: true });
    expect(readFileSync(target, 'utf8')).toBe('{\n  "a": 1,\n  "b": "ok"\n}\n');
    expect(readdirSync(dir)).toEqual(['data.json']);
  });

  it('exclusive 模式下目标是目录导致 rename 失败时抛出且清理临时文件', () => {
    const dir = makeTmp();
    const targetDir = join(dir, 'existing-dir');
    writeTextAtomic(join(targetDir, 'keep.txt'), 'ok');
    expect(() => writeTextAtomic(targetDir, 'bad', { exclusive: true })).toThrow();
    expect(readdirSync(dir)).toEqual(['existing-dir']);
  });
});
