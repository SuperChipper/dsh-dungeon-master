import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import type { HttpGet } from './http.ts';
import { FanartSeenStore } from './seen.ts';
import { FANART_TOOL_NAME, registerFanartTool } from './fanart-tool.ts';

const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60_000)]);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(get: HttpGet) {
  const dir = mkdtempSync(join(tmpdir(), 'fanart-tool-'));
  tempDirs.push(dir);
  let def: {
    name: string;
    output: { render(args: unknown, value: unknown): Array<{ type: string; text?: string }> };
    execute(args: unknown): Promise<Record<string, unknown>>;
  } | undefined;
  const ctx = { get: (name: string) => (name === 'tools' ? { register: (d: typeof def) => { def = d; } } : undefined) } as unknown as Context;
  const config = { vision: { native: false } } as unknown as ImQQBotConfig;
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
  registerFanartTool(ctx, config, {
    get,
    seen: new FanartSeenStore(join(dir, 'seen')),
    poolDir: dir,
    candidatesDir: join(dir, 'candidates'),
  }, logger);
  return { tool: def! };
}

describe('qqbot_fanart', () => {
  it('action="booru" 校验空 tags，并能下载合法返回与渲染文本', async () => {
    const get: HttpGet = vi.fn(async (url: string) => {
      if (url.includes('page=dapi')) {
        const rows = [{
          id: 999,
          width: 1000,
          height: 1200,
          tags: '1girl yuri',
          rating: 'general',
          file_url: 'https://safebooru.org/images/1/a.jpg',
          source: 'https://pixiv.net/artworks/1',
        }];
        return { status: 200, body: Buffer.from(JSON.stringify(rows), 'utf8') };
      }
      return { status: 200, body: FAKE_JPEG };
    });
    const { tool } = setup(get);
    expect(tool.name).toBe(FANART_TOOL_NAME);

    const bad = await tool.execute({ action: 'booru', tags: '   ' });
    expect(bad).toMatchObject({ action: 'booru', ok: false });
    expect(tool.output.render({}, bad)[0]!.text).toContain('没取到');

    const ok = await tool.execute({ action: 'booru', tags: 'yuri', mode: 'latest' });
    expect(ok).toMatchObject({ action: 'booru', ok: true, id: '999' });
    expect(tool.output.render({}, ok)[0]!.text).toContain('post 999');
  });

  it('action="pick" 支持参数透传与结果渲染，非法 action 报错', async () => {
    const get: HttpGet = vi.fn(async () => ({ status: 503, body: Buffer.alloc(0) }));
    const { tool } = setup(get);
    const picked = await tool.execute({ action: 'pick', count: 1, source: 'booru' });
    expect(picked).toMatchObject({ action: 'pick', candidates: [] });
    expect(tool.output.render({}, picked)[0]!.text).toContain('没抽到');

    await expect(tool.execute({ action: 'invalid' })).rejects.toThrow(/action/);
  });
});
