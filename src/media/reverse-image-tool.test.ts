import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// homedir 指向不存在的路径，免得读到本机真实 ~/.dsh/.env 里的 key
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => '/nonexistent-home-for-tests' };
});

import { registerReverseImageTool, REVERSE_IMAGE_TOOL_NAME } from './reverse-image-tool.ts';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

interface ToolDef {
  name: string;
  execute(args: unknown): Promise<{ found: boolean; text: string }>;
}

function makeImage(name = 'a.png', bytes = 1024): string {
  const dir = mkdtempSync(join(tmpdir(), 'revimg-'));
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 1));
  return path;
}

function register(): ToolDef {
  const registered: ToolDef[] = [];
  registerReverseImageTool({
    get: (n: string) => (n === 'tools' ? { register: (d: ToolDef) => registered.push(d) } : undefined),
  } as never, logger as never);
  return registered[0]!;
}

/** 按 URL 关键字分发假响应 */
function stubFetch(routes: Array<[string, () => Response]>) {
  const mock = vi.fn(async (url: string) => {
    for (const [needle, make] of routes) if (url.includes(needle)) return make();
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const traceMoeHit = {
  result: [{
    anilist: { title: { native: 'アトリ', english: 'ATRI' } },
    episode: 1,
    from: 754,
    to: 760,
    similarity: 0.962,
    filename: 'atri.mkv',
  }],
};

const saucenaoHit = {
  header: { status: 0 },
  results: [{
    header: { similarity: '92.1' },
    data: { title: 'pixiv #123', author_name: 'someone', ext_urls: ['https://www.pixiv.net/artworks/123'] },
  }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete process.env.QQBOT_SAUCENAO_KEY;
});

describe('qqbot_reverse_image', () => {
  it('工具名正确', () => {
    stubFetch([]);
    expect(register().name).toBe(REVERSE_IMAGE_TOOL_NAME);
  });

  it('路径为空或文件不存在时报错，不发请求', async () => {
    const fetchMock = stubFetch([]);
    const tool = register();

    await expect(tool.execute({ image: '   ' })).rejects.toThrow(/绝对路径/);
    await expect(tool.execute({ image: join(tmpdir(), 'nope-不存在.png') })).rejects.toThrow(/文件不存在/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auto 同时查两个源，动画结果带作品名和集数时间', async () => {
    const fetchMock = stubFetch([
      ['trace.moe', () => json(traceMoeHit)],
      ['saucenao', () => json(saucenaoHit)],
    ]);
    const tool = register();

    const out = await tool.execute({ image: makeImage() });

    expect(out.found).toBe(true);
    expect(out.text).toContain('アトリ');
    expect(out.text).toContain('第 1 集');
    expect(out.text).toContain('12:34');  // 754s
    expect(out.text).toContain('pixiv #123');
    expect(out.text).toContain('作者 someone');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('source=anime 只打 trace.moe', async () => {
    const fetchMock = stubFetch([['trace.moe', () => json(traceMoeHit)]]);
    const tool = register();

    const out = await tool.execute({ image: makeImage(), source: 'anime' });
    expect(out.text).toContain('アトリ');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain('trace.moe');
  });

  it('相似度低于 60% 的丢掉', async () => {
    stubFetch([
      ['trace.moe', () => json({ result: [{ anilist: { title: { native: '不准' } }, similarity: 0.41 }] })],
      ['saucenao', () => json({ header: { status: 0 }, results: [] })],
    ]);
    const tool = register();

    const out = await tool.execute({ image: makeImage() });
    expect(out.found).toBe(false);
    expect(out.text).toContain('都没匹配到');
  });

  it('一个源挂了，另一个的结果照样返回，并带提示', async () => {
    stubFetch([
      ['trace.moe', () => json(traceMoeHit)],
      ['saucenao', () => new Response('', { status: 500 })],
    ]);
    const tool = register();

    const out = await tool.execute({ image: makeImage() });
    expect(out.found).toBe(true);
    expect(out.text).toContain('アトリ');
    expect(out.text).toContain('SauceNAO HTTP 500');
  });

  it('SauceNAO 429 提示配 key', async () => {
    stubFetch([
      ['trace.moe', () => json({ result: [] })],
      ['saucenao', () => new Response('', { status: 429 })],
    ]);
    const tool = register();

    const out = await tool.execute({ image: makeImage() });
    expect(out.found).toBe(false);
    expect(out.text).toContain('QQBOT_SAUCENAO_KEY');
  });

  it('SauceNAO 拒绝匿名调用时，提示去注册免费 key', async () => {
    stubFetch([
      ['trace.moe', () => json({ result: [] })],
      ['saucenao', () => json({ header: { status: -1, message: 'The anonymous account type does not permit API usage.' } }, 403)],
    ]);
    const tool = register();

    const out = await tool.execute({ image: makeImage() });
    expect(out.found).toBe(false);
    expect(out.text).toContain('不再允许匿名调用');
    expect(out.text).toContain('QQBOT_SAUCENAO_KEY');
  });

  it('配了 key 时把它带进查询串', async () => {
    process.env.QQBOT_SAUCENAO_KEY = 'abc123';
    const fetchMock = stubFetch([['saucenao', () => json({ header: { status: 0 }, results: [] })]]);
    const tool = register();

    await tool.execute({ image: makeImage(), source: 'art' });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain('api_key=abc123');
  });
});
