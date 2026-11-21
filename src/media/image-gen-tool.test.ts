import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { IMAGE_GEN_DEFAULTS, type ImQQBotConfig } from '../config.ts';
import type { DshAgent, SessionManager, SessionRecord } from '../session/index.ts';
import {
  canUseImageGen,
  IMAGE_GEN_TOOL_NAME,
  registerImageGenTool,
  validateImageGenSize,
} from './image-gen-tool.ts';
import type { MediaSenderLike } from './send-file-tool.ts';

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 2)]);

interface RegisteredTool {
  name: string;
  output: { render(args: unknown, value: unknown): Array<{ type: string; text: string }> };
  execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown>>;
}

const dirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'imagegen-test-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function setup(options: {
  imageGen?: Partial<ImQQBotConfig['imageGen']>;
  fullAccess?: boolean;
  caller?: SessionRecord;
  credentialValue?: string;
} = {}) {
  const workDir = makeTmp();
  const config = {
    cwd: workDir,
    tmpDir: '',
    ownerOpenid: 'OWNER',
    fileAccess: { sensitivePaths: [join(workDir, 'secrets')] },
    toolAccess: { enabled: true, fullAccessGroups: [], fullAccessUsers: [], readRoots: [] },
    imageGen: {
      ...IMAGE_GEN_DEFAULTS,
      enabled: true,
      apiKey: 'sk-img-test',
      ...options.imageGen,
    },
  } as unknown as ImQQBotConfig;

  let registered: RegisteredTool | undefined;
  const ctx = {
    get: (name: string) => {
      if (name === 'tools') return { register: (def: RegisteredTool) => { registered = def; } };
      if (name === 'credentials') {
        return {
          resolve: async () => options.credentialValue === undefined ? undefined : { value: options.credentialValue },
        };
      }
      return undefined;
    },
  } as unknown as Context;

  const sentCalls: Array<{ target: unknown; localPath: string; caption?: string }> = [];
  const bot: MediaSenderLike = {
    sendImage: vi.fn(async (target, source, opts) => {
      sentCalls.push({ target, localPath: source.localPath!, caption: opts?.content });
      return { upload: { file_uuid: 'u1' }, message: { id: 'm1' } };
    }),
    sendVideo: vi.fn(),
    sendVoice: vi.fn(),
    sendFile: vi.fn(),
  };

  const agent = {} as DshAgent;
  const manager = {
    toolAccess: { isFullAccess: () => options.fullAccess ?? true },
    findByAgent: (a: unknown) => (a === agent ? options.caller : undefined),
  } as unknown as SessionManager;

  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  registerImageGenTool(ctx, bot, manager, config, logger);
  return { workDir, config, tool: registered!, agent, sentCalls, bot };
}

describe('validateImageGenSize', () => {
  it('接受 auto 与 256..3840 内的 16 倍数宽高', () => {
    expect(validateImageGenSize('auto')).toEqual({ ok: true, normalized: 'auto' });
    expect(validateImageGenSize('AUTO')).toEqual({ ok: true, normalized: 'auto' });
    expect(validateImageGenSize('1024x1024')).toEqual({ ok: true, normalized: '1024x1024' });
    expect(validateImageGenSize('1536x864')).toEqual({ ok: true, normalized: '1536x864' });
    expect(validateImageGenSize('3840x1280')).toEqual({ ok: true, normalized: '3840x1280' });
  });

  it('拒绝非 16 倍数、越界和比例失衡尺寸', () => {
    expect(validateImageGenSize('500x500').ok).toBe(false);
    expect(validateImageGenSize('128x128').ok).toBe(false);
    expect(validateImageGenSize('4096x1024').ok).toBe(false);
    expect(validateImageGenSize('3072x512').ok).toBe(false);
    expect(validateImageGenSize('wide').ok).toBe(false);
  });
});

describe('canUseImageGen', () => {
  const cfg = { imageGen: { ...IMAGE_GEN_DEFAULTS, enabled: true, allowAllGroups: false, allowedGroups: ['G_OK'] } };

  it('仅放行本机会话、完全权限会话、allowedGroups 或 allowAllGroups', () => {
    expect(canUseImageGen(undefined, cfg)).toBe(true);
    expect(canUseImageGen({ scope: 'c2c', peerId: 'OWNER' }, cfg, () => true)).toBe(true);
    expect(canUseImageGen({ scope: 'c2c', peerId: 'STRANGER' }, cfg, () => false)).toBe(false);
    expect(canUseImageGen({ scope: 'group', peerId: 'G_NO' }, cfg, () => false)).toBe(false);
    expect(canUseImageGen({ scope: 'group', peerId: 'G_OK' }, cfg, () => false)).toBe(true);
    expect(canUseImageGen({ scope: 'group', peerId: 'G_ANY' }, { imageGen: { ...cfg.imageGen, allowAllGroups: true } }, () => false)).toBe(true);
  });
});

describe('qqbot_image_gen', () => {
  it('文生图默认用 gpt-image-2.6-sunburst，支持 variant=standard、complexity 和 transparent 纠偏', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString('base64'), revised_prompt: 'refined' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { tool, workDir } = setup();
    expect(tool.name).toBe(IMAGE_GEN_TOOL_NAME);

    const out1 = await tool.execute({
      prompt: 'chibi dragon mascot',
      background: 'transparent',
      output_format: 'jpeg',
      complexity: 'high',
      size: '1536x864',
      quality: 'xhigh',
    }, { signal: new AbortController().signal });

    const [url1, init1] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url1).toBe('https://api.openai.com/v1/images/generations');
    const body1 = JSON.parse(init1.body as string);
    expect(body1).toEqual({
      model: 'gpt-image-2.6-sunburst',
      prompt: 'chibi dragon mascot',
      n: 1,
      size: '1536x864',
      quality: 'xhigh',
      background: 'transparent',
      output_format: 'png',
      complexity: 'high',
    });
    const files1 = out1.files as string[];
    expect(files1).toHaveLength(1);
    expect(files1[0]).toContain(join(workDir, 'tmp', 'imagegen'));
    expect(existsSync(files1[0]!)).toBe(true);
    expect(readFileSync(files1[0]!)).toEqual(PNG_BYTES);
    expect(out1.sent).toBe(false);

    // variant=standard 不传空 complexity
    await tool.execute({
      prompt: 'sketch',
      variant: 'standard',
    }, { signal: new AbortController().signal });
    const body2 = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(body2.model).toBe('gpt-image-2.6');
    expect('complexity' in body2).toBe(false);
  });

  it('参考图编辑：单图传 image + mask，多图传 image[]，兼容同源 url 回落下载', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/images/edits')) {
        return new Response(
          JSON.stringify({ data: [{ url: 'https://relay.example.com/files/result.png' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(PNG_BYTES, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { tool, workDir } = setup({ imageGen: { baseUrl: 'https://relay.example.com/v1/' } });
    const ref1 = join(workDir, 'ref1.jpg');
    const ref2 = join(workDir, 'ref2.png');
    const mask = join(workDir, 'mask.png');
    writeFileSync(ref1, JPEG_BYTES);
    writeFileSync(ref2, PNG_BYTES);
    writeFileSync(mask, PNG_BYTES);

    // 单图 + mask → 字段名为 image + mask
    const singleOut = await tool.execute({
      prompt: 'replace background',
      images: [ref1],
      mask,
    }, { signal: new AbortController().signal });
    const [editUrl1, editInit1] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(editUrl1).toBe('https://relay.example.com/v1/images/edits');
    const form1 = editInit1.body as FormData;
    expect(form1.getAll('image')).toHaveLength(1);
    expect(form1.getAll('image[]')).toHaveLength(0);
    expect(form1.get('mask')).toBeTruthy();
    expect(existsSync((singleOut.files as string[])[0]!)).toBe(true);

    // 多图 → 字段名为 image[]，不传 mask
    await tool.execute({
      prompt: 'combine character and pose',
      images: [ref1, ref2],
    }, { signal: new AbortController().signal });
    const form2 = (fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form2.getAll('image[]')).toHaveLength(2);
    expect(form2.getAll('image')).toHaveLength(0);

    // 多图带 mask 被拒
    await expect(tool.execute({
      prompt: 'invalid',
      images: [ref1, ref2],
      mask,
    }, { signal: new AbortController().signal })).rejects.toThrow(/mask/);
  });

  it('未授权群拒绝生图；允许群可生成并发送到本群，但禁传跨会话 target', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const deniedRecord = { scope: 'group', peerId: 'G_DENY', replyTarget: { scope: 'group', targetId: 'G_DENY', msgId: '1', receivedAt: Date.now() } } as unknown as SessionRecord;
    const deniedSetup = setup({ fullAccess: false, caller: deniedRecord, imageGen: { allowedGroups: ['G_ALLOW'] } });
    await expect(deniedSetup.tool.execute({ prompt: 'hi' }, { signal: new AbortController().signal, agent: deniedSetup.agent }))
      .rejects.toThrow(/未开通生图权限/);
    expect(fetchMock).not.toHaveBeenCalled();

    const allowedRecord = { scope: 'group', peerId: 'G_ALLOW', replyTarget: { scope: 'group', targetId: 'G_ALLOW', msgId: '2', receivedAt: Date.now() } } as unknown as SessionRecord;
    const allowedSetup = setup({ fullAccess: false, caller: allowedRecord, imageGen: { allowedGroups: ['G_ALLOW'] } });

    // 受限群不允许跨会话 target
    await expect(allowedSetup.tool.execute({
      prompt: 'hi',
      send: true,
      target: 'c2c:OTHER',
    }, { signal: new AbortController().signal, agent: allowedSetup.agent })).rejects.toThrow(/target/);

    const sentOut = await allowedSetup.tool.execute({
      prompt: 'hi',
      send: true,
      caption: '给你画好啦',
    }, { signal: new AbortController().signal, agent: allowedSetup.agent });
    expect(sentOut.sent).toBe(true);
    expect(sentOut.target).toBe('group:G_ALLOW');
    expect(allowedSetup.sentCalls).toHaveLength(1);
    expect(allowedSetup.sentCalls[0]?.caption).toBe('给你画好啦');

    const rendered = allowedSetup.tool.output.render({ caption: '给你画好啦' }, sentOut);
    expect(rendered[0]!.text).toContain('不要在回复里重复 caption');
  });

  it('支持通过 credentials 服务解析 apiKeyEnv，且 pre-aborted 不解析凭证', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { tool } = setup({ imageGen: { apiKey: '', apiKeyEnv: 'OPENAI_CUSTOM' }, credentialValue: 'sk-from-creds' });
    const abort = new AbortController();
    abort.abort();
    await expect(tool.execute({ prompt: 'hi' }, { signal: abort.signal })).rejects.toBe(abort.signal.reason);
    expect(fetchMock).not.toHaveBeenCalled();

    await tool.execute({ prompt: 'hi' }, { signal: new AbortController().signal });
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-from-creds');
  });
});
