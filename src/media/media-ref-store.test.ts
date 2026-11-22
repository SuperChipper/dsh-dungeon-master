import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { VisionConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { MediaRefStore, isMediaRef, shortenQqMediaUrls } from './media-ref-store.ts';
import { loadImageBytes, registerDescribeImageTool } from './vision-tool.ts';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

describe('MediaRefStore', () => {
  it('确定性生成短引用、归一化 // 协议、支持大小写不敏感 resolve 与 LRU 淘汰', () => {
    const store = new MediaRefStore(2);
    const u1 = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=A&rkey=1';
    const ref1 = store.register(u1, { filename: 'a.png' });
    const ref1Same = store.register('//multimedia.nt.qq.com.cn/download?appid=1407&fileid=A&rkey=1');

    expect(isMediaRef(ref1)).toBe(true);
    expect(ref1).toMatch(/^qqref:[0-9a-f]{10}$/);
    expect(ref1Same).toBe(ref1);
    expect(store.resolve(ref1.toUpperCase())).toMatchObject({ url: u1, filename: 'a.png' });

    const ref2 = store.register('https://q/2.jpg');
    // 访问 ref1 刷新 LRU；插入 ref3 应淘汰 ref2 而保留 ref1
    expect(store.resolve(ref1)).toBeDefined();
    const ref3 = store.register('https://q/3.jpg');
    expect(store.size).toBe(2);
    expect(store.resolve(ref2)).toBeUndefined();
    expect(store.resolve(ref1)).toBeDefined();
    expect(store.resolve(ref3)).toBeDefined();
  });

  it('bindLocalPath 关联本地缓存路径', () => {
    const store = new MediaRefStore(10);
    const ref = store.register('https://q/pic.png', { filename: 'pic.png' });
    store.bindLocalPath('https://q/pic.png', '/tmp/pic.png');
    expect(store.resolve(ref)?.localPath).toBe('/tmp/pic.png');
  });
});

describe('loadImageBytes with qqref', () => {
  it('优先从绑定本地路径读取，未命中本地则经 fetchUrl 拉取，过期/未知 ref 明确报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqref-vision-'));
    try {
      const localFile = join(dir, 'cached.png');
      writeFileSync(localFile, PNG_BYTES);

      const refs = new MediaRefStore(10);
      const refCached = refs.register('https://q/cached.png', { filename: 'cached.png', localPath: localFile });
      const refRemote = refs.register('https://q/remote.png', { filename: 'remote.png' });

      const fetchUrl = vi.fn(async () => PNG_BYTES);
      const fromLocal = await loadImageBytes(refCached, 1024 * 1024, new AbortController().signal, { refs, fetchUrl });
      expect(fromLocal.mediaType).toBe('image/png');
      expect(fromLocal.filename).toBe('cached.png');
      expect(fetchUrl).not.toHaveBeenCalled();

      const fromRemote = await loadImageBytes(refRemote, 1024 * 1024, new AbortController().signal, { refs, fetchUrl });
      expect(fromRemote.mediaType).toBe('image/png');
      expect(fromRemote.filename).toBe('remote.png');
      expect(fetchUrl).toHaveBeenCalledWith('https://q/remote.png', 1024 * 1024, expect.objectContaining({ signal: expect.any(AbortSignal) }));

      await expect(
        loadImageBytes('qqref:deadbeef00', 1024 * 1024, new AbortController().signal, { refs, fetchUrl }),
      ).rejects.toThrow('not found or expired');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('shortenQqMediaUrls', () => {
  it('将 QQ 内部 CDN 签名长链接替换为可反查的 qqref 短引用，保留普通网页链接', () => {
    const refs = new MediaRefStore(10);
    const cdn1 = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=ABC&rkey=secret&spec=0';
    const cdn2 = 'https://gchat.qpic.cn/gchatpic_new/123/456/0?term=2';
    const github = 'https://github.com/SuperChipper/voice-lab';
    const out = shortenQqMediaUrls(`图1 ${cdn1}\n图2 ${cdn2}\n链接 ${github}`, refs);

    expect(out).not.toContain('multimedia.nt.qq.com.cn');
    expect(out).not.toContain('gchat.qpic.cn');
    expect(out).toContain(github);
    const matches = out.match(/qqref:[0-9a-f]{10}/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(refs.resolve(matches[0]!)?.url).toBe(cdn1);
    expect(refs.resolve(matches[1]!)?.url).toBe(cdn2);
  });
});

describe('registerDescribeImageTool (native-first + fallback)', () => {
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const baseVision: VisionConfig = {
    enabled: true,
    native: true,
    provider: 'fallback-provider',
    model: 'fallback-vision',
    maxBytes: 10 * 1024 * 1024,
    maxTokens: 512,
    defaultPrompt: 'Describe this image',
  };

  function setupTool(opts: {
    vision?: VisionConfig;
    inputModalities?: string[];
    hasStream?: boolean;
  } = {}) {
    let registered: {
      execute: (args: unknown, exec: { signal: AbortSignal; agent?: unknown }) => Promise<Record<string, unknown>>;
      output: { render: (args: unknown, value: unknown) => Array<{ type: string; text?: string; attachment?: unknown }> };
    } | undefined;
    const streamSpy = vi.fn(async function* () {
      yield { type: 'text-delta', text: 'fallback description' };
      yield { type: 'finish', finishReason: { kind: 'stop' } };
    });
    const fakeAttachment = { attachmentId: 'att-1', mediaType: 'image/png' as const, bytes: PNG_BYTES.length, width: 1, height: 1 };
    const services = new Map<string, unknown>([
      ['tools', { register: (def: unknown) => { registered = def as typeof registered; } }],
      ['attachments', { saveImage: vi.fn(async () => fakeAttachment) }],
      ['llm', {
        resolveModelInfo: vi.fn(async () => ({ inputModalities: opts.inputModalities ?? ['text', 'image'] })),
        ...(opts.hasStream === false ? {} : { stream: streamSpy }),
      }],
    ]);
    const ctx = { get: (name: string) => services.get(name) } as never;
    const refs = new MediaRefStore(10);
    const ref = refs.register('https://multimedia.nt.qq.com.cn/download?fileid=TEST', { filename: 'test.png' });
    registerDescribeImageTool(ctx, opts.vision ?? baseVision, logger, {
      refs,
      fetchUrl: async () => PNG_BYTES,
    });
    return { registered, streamSpy, fakeAttachment, ref };
  }

  it('主模型支持 image 输入且开启 native 时直接返回图片附件块且不调用副视觉模型', async () => {
    // 即使未配 fallback provider/model，native-only 模式下也应正常注册与执行
    const { registered, streamSpy, fakeAttachment, ref } = setupTool({
      vision: { ...baseVision, provider: '', model: '' },
      inputModalities: ['text', 'image'],
      hasStream: false,
    });
    expect(registered).toBeDefined();

    const value = await registered!.execute({ image: ref }, {
      signal: new AbortController().signal,
      agent: { options: { provider: 'opencode-go', model: 'gemini-4-argon' } },
    });
    expect(value.mode).toBe('native');
    expect(value.model).toBe('opencode-go/gemini-4-argon');
    expect(streamSpy).not.toHaveBeenCalled();

    const rendered = registered!.output.render({ image: ref }, value);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]?.type).toBe('text');
    expect(rendered[1]).toEqual({ type: 'image', attachment: fakeAttachment });
  });

  it('主模型为纯文本路由时回退到辅助视觉模型，无兜底配置则给出明确报错', async () => {
    const fallbackSetup = setupTool({ inputModalities: ['text'] });
    const value = await fallbackSetup.registered!.execute({ image: fallbackSetup.ref, prompt: 'read text' }, {
      signal: new AbortController().signal,
      agent: { session: { requestHeader: () => ({ config: { provider: 'text-only', model: 'm1' } }) } },
    });
    expect(value.mode).toBe('vision');
    expect(value.model).toBe('fallback-vision');
    expect(fallbackSetup.streamSpy).toHaveBeenCalledTimes(1);
    expect(fallbackSetup.registered!.output.render({ image: fallbackSetup.ref }, value)).toEqual([
      { type: 'text', text: 'fallback description' },
    ]);

    const noFallbackSetup = setupTool({
      vision: { ...baseVision, provider: '', model: '' },
      inputModalities: ['text'],
      hasStream: false,
    });
    await expect(
      noFallbackSetup.registered!.execute({ image: noFallbackSetup.ref }, {
        signal: new AbortController().signal,
        agent: { options: { provider: 'text-only', model: 'm1' } },
      }),
    ).rejects.toThrow('no fallback vision.provider/model is configured');
  });
});
