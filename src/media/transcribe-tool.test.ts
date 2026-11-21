import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';

// transcribe-tool 在模块顶层 promisify(execFile)，所以必须在 import 之前 mock
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';
import { registerTranscribeTool, TRANSCRIBE_TOOL_NAME } from './transcribe-tool.ts';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const realExecFile = vi.mocked(execFile);

interface ToolDef {
  name: string;
  execute(args: unknown): Promise<{ text: string; segments: number; chunks: number; model: string; message: string }>;
}

/** 假的 ffmpeg/ffprobe：ffprobe 报时长，ffmpeg 往 out 路径写个假 mp3 */
function stubMediaBinaries(duration = '115.0'): void {
  realExecFile.mockImplementation(((_file: string, args: string[], _opts: unknown, cb: Function) => {
    if (args.includes('-show_entries')) {
      cb(null, { stdout: `${duration}\n`, stderr: '' });
      return;
    }
    writeFileSync(args[args.length - 1]!, Buffer.alloc(2048, 1));
    cb(null, { stdout: '', stderr: '' });
  }) as never);
}

function register(asr?: Parameters<typeof registerTranscribeTool>[2], ffmpegBins?: Parameters<typeof registerTranscribeTool>[3]): ToolDef {
  const registered: ToolDef[] = [];
  registerTranscribeTool({
    get: (name: string) => {
      if (name === 'tools') return { register: (def: ToolDef) => registered.push(def) };
      if (name === 'credentials') return { resolve: async () => ({ value: 'test-key' }) };
      return undefined;
    },
  } as never, logger as never, asr, ffmpegBins);
  return registered[0]!;
}

function sourceFile(name = 'clip.mp4'): string {
  const dir = mkdtempSync(join(tmpdir(), 'transcribe-test-'));
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(4096, 7));
  return path;
}

function stubFetch(content: string | null) {
  const mock = vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('qqbot_transcribe', () => {
  it('注册出的工具名和参数正确', () => {
    stubMediaBinaries();
    const tool = register();
    expect(tool.name).toBe(TRANSCRIBE_TOOL_NAME);
  });

  it('凭证服务晚于工具注册启动，转写时仍能读取；服务卸载后回退环境变量', async () => {
    vi.stubEnv('QQBOT_TRANSCRIBE_KEY_REF', undefined);
    vi.stubEnv('OPENCODE_GO_API_KEY', undefined);
    stubMediaBinaries();
    const fetchMock = stubFetch('0.00-1.00 | SPEAKER_00: 测试');
    const ctx = new Context();
    const registered: ToolDef[] = [];
    ctx.provide('tools', { register: (def: ToolDef) => registered.push(def) });
    try {
      expect(ctx.get('credentials')).toBeUndefined();
      registerTranscribeTool(ctx, logger);
      const tool = registered[0]!;
      const args = { file: sourceFile() };
      await expect(tool.execute(args)).rejects.toThrow(/未配置多模态凭证 OPENCODE_GO_API_KEY/);
      expect(fetchMock).not.toHaveBeenCalled();

      const resolve = vi.fn(async () => ({ value: 'test-late-credential' }));
      const provider = ctx.plugin({
        apply(providerCtx: Context) {
          providerCtx.provide('credentials', { resolve });
        },
      });
      await provider;
      await expect(tool.execute(args)).resolves.toMatchObject({ chunks: 1 });
      expect(resolve).toHaveBeenCalledExactlyOnceWith('OPENCODE_GO_API_KEY');
      expect(fetchMock).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer test-late-credential' }),
      }));

      await provider.dispose();
      vi.stubEnv('OPENCODE_GO_API_KEY', 'test-env-fallback');
      await expect(tool.execute(args)).resolves.toMatchObject({ chunks: 1 });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer test-env-fallback' }),
      }));
    } finally {
      await ctx.fiber.dispose();
      vi.unstubAllEnvs();
    }
  });

  it('file 为空或文件不存在时直接报错，不发请求', async () => {
    stubMediaBinaries();
    const fetchMock = stubFetch('x');
    const tool = register();

    await expect(tool.execute({ file: '  ' })).rejects.toThrow(/不能为空/);
    await expect(tool.execute({ file: join(tmpdir(), 'nope-不存在.mp4') })).rejects.toThrow(/文件不存在/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('请求必须带 reasoning_effort=none 和 x-opencode-session', async () => {
    stubMediaBinaries();
    const fetchMock = stubFetch('12.50-18.20 | SPEAKER_01: どうしたんですか？');
    const tool = register();

    const out = await tool.execute({ file: sourceFile() });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(init.body as string);
    expect(headers['x-opencode-session']).toBeTruthy();
    expect(headers['user-agent']).toBe('opencode/0.1.0');
    expect(body.reasoning_effort).toBe('none');
    expect(body.model).toBe('mimo-v2.6-flash');
    expect(out.segments).toBe(1);
    expect(out.chunks).toBe(1);
    expect(out.message).toContain('SPEAKER_01');
    // 给模型看的结果末尾提醒别引台词；text 字段保持纯转写
    expect(out.message).toContain('别引台词');
    expect(out.text).not.toContain('别引台词');
  });

  it('正文为 null 时报「思考吃掉额度」而不是回显空串', async () => {
    stubMediaBinaries();
    stubFetch(null);
    const tool = register();

    await expect(tool.execute({ file: sourceFile() })).rejects.toThrow(/空正文/);
  });

  it('超过 10 分钟按块切分，并标注每块的起点', async () => {
    stubMediaBinaries('1500'); // 25 分钟 → 3 块
    stubFetch('1.00-2.00 | SPEAKER_00: はい');
    const tool = register();

    const out = await tool.execute({ file: sourceFile() });
    expect(out.chunks).toBe(3);
    expect(out.text).toContain('【0分0秒起】');
    expect(out.text).toContain('【10分0秒起】');
    expect(out.text).toContain('【20分0秒起】');
  });

  it('没抽出音轨（ffmpeg 没产出文件）时报错', async () => {
    realExecFile.mockImplementation(((_file: string, args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: args.includes('-show_entries') ? '115.0\n' : '', stderr: '' });
    }) as never);
    const fetchMock = stubFetch('x');
    const tool = register();

    await expect(tool.execute({ file: sourceFile() })).rejects.toThrow(/没抽出音轨/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('跟随 config.asr：mode=openai 时走 /audio/transcriptions 并透传 model/language', async () => {
    stubMediaBinaries();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'hello from whisper' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const tool = register({
      enabled: true,
      mode: 'openai',
      baseUrl: 'https://asr.example.com/v1',
      apiKey: 'sk-asr-openai',
      model: 'whisper-large-v3',
      preferQQ: true,
      timeoutMs: 10000,
    });

    const out = await tool.execute({ file: sourceFile(), language: 'en', prompt: 'keep names' } as unknown);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://asr.example.com/v1/audio/transcriptions');
    expect(init.headers).toEqual({ Authorization: 'Bearer sk-asr-openai' });
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('language')).toBe('en');
    expect(form.get('prompt')).toBe('keep names');
    expect(out.model).toBe('whisper-large-v3');
    expect(out.text).toBe('hello from whisper');
  });

  it('跟随 config.asr：mode=chat 可换自定义网关与模型', async () => {
    stubMediaBinaries();
    const fetchMock = stubFetch('0.00-3.00 | SPEAKER_00: 自定义 chat 网关');
    const tool = register({
      enabled: true,
      mode: 'chat',
      baseUrl: 'https://unused.example/v1',
      apiKey: '',
      model: 'unused',
      chatBaseUrl: 'https://custom-chat.example/v1',
      chatModel: 'gemini-2.5-flash',
      chatApiKey: 'sk-custom',
      chatReasoningEffort: 'omit',
      preferQQ: true,
      timeoutMs: 10000,
    });

    const out = await tool.execute({ file: sourceFile() });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://custom-chat.example/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-custom');
    expect(JSON.parse(init.body as string).model).toBe('gemini-2.5-flash');
    expect(out.model).toBe('gemini-2.5-flash');
    expect(out.text).toContain('自定义 chat 网关');
  });
});
