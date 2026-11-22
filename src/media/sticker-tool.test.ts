import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';
import { StickerStore } from './sticker-store.ts';
import { registerStickerTool, STICKER_TOOL_NAME } from './sticker-tool.ts';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'sticker-tool-'));
  tempDirs.push(root);
  const store = new StickerStore({
    root: join(root, 'stickers'),
    allowedRoots: [root],
    maxBytes: 1024 * 1024,
    maxAutoEntries: 20,
  });
  const srcImg = join(root, 'meme.png');
  writeFileSync(srcImg, PNG_1X1);
  let definition: { name: string; execute(args: unknown): Promise<Record<string, unknown>> } | undefined;
  const ctx = { get: () => ({ register: (d: typeof definition) => { definition = d; } }) } as unknown as Context;
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  registerStickerTool(ctx, store, logger);
  return { tool: definition!, srcImg };
}

describe('qqbot_sticker', () => {
  it('action="save" 校验参数并写入，重复图再 match 命中情绪和文件', async () => {
    const { tool, srcImg } = setup();
    expect(tool.name).toBe(STICKER_TOOL_NAME);

    await expect(tool.execute({ action: 'save', image: srcImg, emotion: '开心' })).rejects.toThrow(/look/);
    await expect(tool.execute({ action: 'save', image: srcImg, look: '图里' })).rejects.toThrow(/emotion/);

    const missed = await tool.execute({ action: 'match', image: srcImg });
    expect(missed.matched).toBe(false);

    const saved = await tool.execute({
      action: 'save',
      image: srcImg,
      emotion: '开心',
      look: '白鱼微笑',
      note: '可爱',
    });
    expect(saved.saved).toBe(true);

    const hit = await tool.execute({ action: 'match', image: srcImg });
    expect(hit).toMatchObject({ matched: true, emotion: '开心', note: '可爱' });
    expect(String(hit.message)).toContain('qqbot_send_file');
  });

  it('非法 action 或空 image 抛明确错误', async () => {
    const { tool } = setup();
    await expect(tool.execute({ action: 'delete', image: 'a.png' })).rejects.toThrow(/action/);
    await expect(tool.execute({ action: 'match', image: '  ' })).rejects.toThrow(/image/);
  });
});
