import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chatCompletion,
  describeVideoViaChat,
  setChatKeyResolver,
  transcribeViaChat,
  videoEndpointFromEnv,
} from './chat-gateway.ts';

function stubFetch(content: string | null, status = 200, finishReason?: string) {
  const mock = vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    { status, headers: { 'content-type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  setChatKeyResolver(undefined);
  vi.unstubAllGlobals();
  delete process.env.QQBOT_VIDEO_MODEL;
});

describe('chatCompletion', () => {
  it('带 x-opencode-session、user-agent 和 reasoning_effort=none', async () => {
    setChatKeyResolver(async () => 'sk-x');
    const fetchMock = stubFetch('ok');
    await chatCompletion([{ type: 'text', text: 'hi' }]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-opencode-session']).toBeTruthy();
    expect(headers['user-agent']).toBe('opencode/0.1.0');
    expect(JSON.parse(init.body as string).reasoning_effort).toBe('none');
  });

  it('空正文按错误处理，不静默返回空串', async () => {
    setChatKeyResolver(async () => 'sk-x');
    stubFetch(null);
    await expect(chatCompletion([{ type: 'text', text: 'hi' }])).rejects.toThrow(/空正文/);
  });

  it.each(['partial transcript', null])('rejects length-truncated output even when content is %s', async (content) => {
    setChatKeyResolver(async () => 'sk-x');
    stubFetch(content, 200, 'length');
    await expect(chatCompletion([])).rejects.toThrow(/截断.*finish_reason=length.*max_tokens/);
  });

  it('accepts a completed response with finish_reason=stop', async () => {
    setChatKeyResolver(async () => 'sk-x');
    stubFetch('complete transcript', 200, 'stop');
    await expect(chatCompletion([])).resolves.toBe('complete transcript');
  });

  it('缺凭证时报出是哪个 ref', async () => {
    await expect(chatCompletion([{ type: 'text', text: 'hi' }])).rejects.toThrow(/OPENCODE_GO_API_KEY/);
  });

  it.each(['completion', 'audio', 'video'] as const)('%s cancellation reaches the fetch signal', async (kind) => {
    setChatKeyResolver(async () => 'sk-x');
    const controller = new AbortController();
    const reason = new DOMException('Canceled by caller', 'AbortError');
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal!;
      expect(signal.aborted).toBe(false);
      controller.abort(reason);
      expect(signal.aborted).toBe(true);
      throw signal.reason;
    });
    vi.stubGlobal('fetch', fetchMock);
    const options = { signal: controller.signal };
    const request = kind === 'audio'
      ? transcribeViaChat(Buffer.from('a'), 'wav', options)
      : kind === 'video'
        ? describeVideoViaChat(Buffer.from('v'), 'describe', options)
        : chatCompletion([], options);
    await expect(request).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pre-aborted calls do not resolve credentials or issue requests', async () => {
    const resolver = vi.fn(async () => 'sk-x');
    setChatKeyResolver(resolver);
    const fetchMock = stubFetch('ok');
    const controller = new AbortController();
    controller.abort();
    await expect(chatCompletion([], { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(resolver).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancellation while resolving credentials prevents the network request', async () => {
    const controller = new AbortController();
    setChatKeyResolver(async () => {
      controller.abort();
      return 'sk-x';
    });
    const fetchMock = stubFetch('ok');
    await expect(chatCompletion([], { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the timeout active when a caller signal is supplied', async () => {
    setChatKeyResolver(async () => 'sk-x');
    const timeout = new AbortController();
    const timeoutMock = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const controller = new AbortController();
    const reason = new DOMException('Request timed out', 'TimeoutError');
    try {
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        timeout.abort(reason);
        expect(init.signal!.aborted).toBe(true);
        expect(controller.signal.aborted).toBe(false);
        throw init.signal!.reason;
      }));
      await expect(chatCompletion([], { signal: controller.signal, timeoutMs: 1234 }))
        .rejects.toBe(reason);
      expect(timeoutMock).toHaveBeenCalledWith(1234);
    } finally {
      timeoutMock.mockRestore();
    }
  });
});

describe('describeVideoViaChat', () => {
  it('用 video_url + data URI 传整段视频，模型默认 mimo', async () => {
    setChatKeyResolver(async () => 'sk-x');
    const fetchMock = stubFetch('视频里在吃咖喱');
    const text = await describeVideoViaChat(Buffer.from('fake-mp4'), '讲讲');

    expect(text).toBe('视频里在吃咖喱');
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('mimo-v2.6-flash');
    expect(body.max_tokens).toBe(8192);
    expect(body.messages[0].content[0].type).toBe('video_url');
    expect(body.messages[0].content[0].video_url.url).toMatch(/^data:video\/mp4;base64,/);
  });

  it('allows callers to override the video token budget', async () => {
    setChatKeyResolver(async () => 'sk-x');
    const fetchMock = stubFetch('complete');
    await describeVideoViaChat(Buffer.from('v'), 'describe', { maxTokens: 1234 });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.max_tokens).toBe(1234);
  });

  it('rejects truncated video output instead of returning a partial description', async () => {
    setChatKeyResolver(async () => 'sk-x');
    stubFetch('partial video subtitles', 200, 'length');
    await expect(describeVideoViaChat(Buffer.from('v'), 'describe')).rejects.toThrow(/截断/);
  });

  it('模型没收到视频、回一段寒暄时按失败处理（否则幻觉会被当成描述）', async () => {
    setChatKeyResolver(async () => 'sk-x');
    stubFetch('您好！请问您想咨询什么问题？请描述一下您的具体情况，我会尽力为您提供帮助。');
    await expect(describeVideoViaChat(Buffer.from('v'), '讲讲')).rejects.toThrow(/没有送进模型/);
  });

  it('QQBOT_VIDEO_MODEL 可以换模型', async () => {
    process.env.QQBOT_VIDEO_MODEL = 'some-video-model';
    setChatKeyResolver(async () => 'sk-x');
    const fetchMock = stubFetch('ok');
    await describeVideoViaChat(Buffer.from('v'), '讲讲');
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('some-video-model');
    expect(videoEndpointFromEnv().model).toBe('some-video-model');
  });
});

describe('transcribeViaChat', () => {
  it('超过单次上限直接报错，让调用方去切片', async () => {
    setChatKeyResolver(async () => 'sk-x');
    const fetchMock = stubFetch('x');
    await expect(transcribeViaChat(Buffer.alloc(2048), 'mp3', { maxBytes: 1024 })).rejects.toThrow(/超过单次上限/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('语言提示拼进指令，input_audio 带 format', async () => {
    setChatKeyResolver(async () => 'sk-x');
    const fetchMock = stubFetch('ok');
    await transcribeViaChat(Buffer.from('a'), 'mp3', { prompt: '转写', language: 'ja' });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content[0].input_audio.format).toBe('mp3');
    expect(body.messages[0].content[1].text).toContain('ja');
  });
});
