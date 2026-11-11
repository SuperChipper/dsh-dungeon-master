import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encode } from 'silk-wasm';
import { AsrOfflineError, pcmToWav, requestTranscription, toUploadableAudio } from './asr.ts';
import { setChatKeyResolver } from './chat-gateway.ts';
import { transcribeVoices } from '../middleware/attachment.ts';
import type { AsrConfig } from '../config.ts';
import type { RawAttachment } from '../types.ts';

const asr: AsrConfig = {
  enabled: true,
  mode: 'openai',
  baseUrl: 'https://asr.example.com/v1/',
  apiKey: 'test-key',
  model: 'FunAudioLLM/SenseVoiceSmall',
  preferQQ: true,
  timeoutMs: 5000,
};

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function voice(extra: Partial<RawAttachment> = {}): RawAttachment {
  return { content_type: 'voice', filename: 'a.amr', size: 100, url: 'https://x/a.amr', ...extra };
}

/** 一个刚释放、没人监听的本机端口（连上去必然 ECONNREFUSED） */
async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toUploadableAudio', () => {
  it('decodes SILK to a WAV with duration', async () => {
    const pcm = new Uint8Array(24000 * 2); // 1s of silence at 24kHz
    const silk = await encode(pcmToWav(pcm, 24000), 0);
    const out = await toUploadableAudio(Buffer.from(silk.data), 'a.amr');
    expect(out.name).toBe('voice.wav');
    expect(out.data.subarray(0, 4).toString()).toBe('RIFF');
    expect(out.duration).toBe(1);
  });

  it('passes WAV through and keeps unknown formats as-is', async () => {
    const wav = pcmToWav(new Uint8Array(4), 16000);
    expect((await toUploadableAudio(wav, 'x')).data).toBe(wav);
    const mp3 = Buffer.from('ID3....');
    expect(await toUploadableAudio(mp3, 'a.mp3')).toEqual({ data: mp3, name: 'a.mp3' });
  });
});

describe('requestTranscription', () => {
  it('posts multipart to {baseUrl}/audio/transcriptions with bearer key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: ' 你好 ' })));
    vi.stubGlobal('fetch', fetchMock);
    const text = await requestTranscription({ data: Buffer.from('RIFF'), name: 'voice.wav' }, asr);
    expect(text).toBe('你好');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://asr.example.com/v1/audio/transcriptions');
    expect(init.headers).toEqual({ Authorization: 'Bearer test-key' });
    expect((init.body as FormData).get('model')).toBe(asr.model);
  });

  it('throws AsrOfflineError when nothing listens at baseUrl', async () => {
    await expect(requestTranscription({ data: Buffer.from(''), name: 'v.wav' }, { ...asr, baseUrl: await closedPortUrl() }))
      .rejects.toBeInstanceOf(AsrOfflineError);
  });

  describe('fallback endpoint', () => {
    const LOCAL = 'http://127.0.0.1:8080/v1';
    const ONLINE = 'https://online.example.com/v1';
    const withFallback: AsrConfig = {
      ...asr, baseUrl: LOCAL, apiKey: '', model: 'large-v3-turbo',
      fallback: { enabled: true, baseUrl: ONLINE, apiKey: 'sk-online', model: 'FunAudioLLM/SenseVoiceSmall', timeoutMs: 5000 },
    };
    const refused = (): TypeError => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    /** 本机按 local 的行为响应，在线接口回「在线结果」 */
    function stub(local: () => Promise<Response>) {
      const fetchMock = vi.fn(async (url: string) => (url.startsWith(LOCAL) ? local() : new Response(JSON.stringify({ text: '在线结果' }))));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('local offline → online endpoint with its own model and key', async () => {
      const fetchMock = stub(async () => { throw refused(); });
      expect(await requestTranscription({ data: Buffer.from('RIFF'), name: 'v.wav' }, withFallback)).toBe('在线结果');
      const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
      expect(url).toBe(`${ONLINE}/audio/transcriptions`);
      expect(init.headers).toEqual({ Authorization: 'Bearer sk-online' });
      expect((init.body as FormData).get('model')).toBe('FunAudioLLM/SenseVoiceSmall');
    });

    it('local 5xx → online; local 4xx → no switch', async () => {
      stub(async () => new Response('boom', { status: 503 }));
      expect(await requestTranscription({ data: Buffer.from(''), name: 'v.wav' }, withFallback)).toBe('在线结果');
      const fetchMock = stub(async () => new Response('bad request', { status: 400 }));
      await expect(requestTranscription({ data: Buffer.from(''), name: 'v.wav' }, withFallback)).rejects.toThrow('HTTP 400');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fallback disabled or missing → original offline error', async () => {
      stub(async () => { throw refused(); });
      const disabled = { ...withFallback, fallback: { ...withFallback.fallback!, enabled: false } };
      await expect(requestTranscription({ data: Buffer.from(''), name: 'v.wav' }, disabled)).rejects.toBeInstanceOf(AsrOfflineError);
      const { fallback: _f, ...legacy } = withFallback;
      await expect(requestTranscription({ data: Buffer.from(''), name: 'v.wav' }, legacy)).rejects.toBeInstanceOf(AsrOfflineError);
    });

    it('both offline → AsrOfflineError from the fallback', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw refused(); }));
      await expect(requestTranscription({ data: Buffer.from(''), name: 'v.wav' }, withFallback)).rejects.toThrow(`ASR server unreachable: ${ONLINE}`);
    });
  });

  it('throws on HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })));
    await expect(requestTranscription({ data: Buffer.from(''), name: 'v.wav' }, asr)).rejects.toThrow('HTTP 401');
  });
});

describe('chat 协议（mode: chat）', () => {
  const chatAsr: AsrConfig = { ...asr, mode: 'chat' };

  afterEach(() => {
    setChatKeyResolver(undefined);
    vi.unstubAllGlobals();
  });

  it('走 chat/completions + input_audio，并带上 reasoning_effort=none', async () => {
    setChatKeyResolver(async () => 'sk-chat');
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '你好呀' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const text = await requestTranscription({ data: Buffer.from('fake-wav'), name: 'voice.wav' }, chatAsr);
    expect(text).toBe('你好呀');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.reasoning_effort).toBe('none');
    expect(body.messages[0].content[0].input_audio.format).toBe('wav');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-chat');
  });

  it('不是 wav/mp3 时直接报错，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestTranscription({ data: Buffer.from('amr'), name: 'voice.amr' }, chatAsr))
      .rejects.toThrow(/只支持 wav\/mp3/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('chat 网关连不上时抛 AsrOfflineError（语音消息才会标 asrOffline）', async () => {
    setChatKeyResolver(async () => 'sk-chat');
    const refused = (): TypeError => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw refused(); }));
    await expect(requestTranscription({ data: Buffer.from('w'), name: 'voice.wav' }, chatAsr))
      .rejects.toBeInstanceOf(AsrOfflineError);
  });
});

describe('ASR cancellation', () => {
  const audio = { data: Buffer.from('RIFF'), name: 'v.wav' };
  const withFallback: AsrConfig = {
    ...asr,
    fallback: { enabled: true, baseUrl: 'https://fallback.example.com/v1', apiKey: 'fallback-key', model: 'whisper', timeoutMs: 5000 },
  };

  afterEach(() => {
    setChatKeyResolver(undefined);
  });

  it.each(['chat', 'openai'] as const)('%s pre-aborted calls never resolve keys or fetch', async (mode) => {
    const resolver = vi.fn(async () => 'sk-chat');
    setChatKeyResolver(resolver);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(requestTranscription(audio, { ...withFallback, mode }, undefined, controller.signal))
      .rejects.toBe(controller.signal.reason);
    expect(resolver).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['chat', 'openai'] as const)('%s cancellation reaches fetch and never falls back or becomes offline', async (mode) => {
    setChatKeyResolver(async () => 'sk-chat');
    const controller = new AbortController();
    // Even a connection-shaped rejection must preserve cancellation once the caller aborts.
    const reason = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal!.aborted).toBe(false);
      controller.abort(reason);
      expect(init.signal!.aborted).toBe(true);
      throw reason;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestTranscription(audio, { ...withFallback, mode }, undefined, controller.signal))
      .rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['chat', 'openai'] as const)('%s preserves timeout cancellation with fallback enabled', async (mode) => {
    setChatKeyResolver(async () => 'sk-chat');
    const timeout = new AbortController();
    const timeoutMock = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const controller = new AbortController();
    const reason = new DOMException('Request timed out', 'TimeoutError');
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      timeout.abort(reason);
      expect(init.signal!.aborted).toBe(true);
      expect(controller.signal.aborted).toBe(false);
      throw init.signal!.reason;
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(requestTranscription(audio, { ...withFallback, mode }, undefined, controller.signal))
        .rejects.toBe(reason);
      expect(timeoutMock).toHaveBeenCalledWith(asr.timeoutMs);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      timeoutMock.mockRestore();
    }
  });

  it.each([
    ['chat', 200], ['chat', 503], ['openai', 200], ['openai', 503],
  ] as const)('%s cancellation while reading HTTP %s does not fall back or return text', async (mode, status) => {
    setChatKeyResolver(async () => 'sk-chat');
    const controller = new AbortController();
    const reason = new DOMException('Canceled response body', 'AbortError');
    const response = new Response('body', { status });
    if (status === 200) {
      vi.spyOn(response, 'json').mockImplementation(async () => {
        controller.abort(reason);
        return { text: 'stale result', choices: [{ message: { content: 'stale result' } }] };
      });
    } else {
      vi.spyOn(response, 'text').mockImplementation(async () => {
        controller.abort(reason);
        throw reason;
      });
    }
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestTranscription(audio, { ...withFallback, mode }, undefined, controller.signal))
      .rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['chat', 'openai'] as const)('%s propagates cancellation to its native fallback request', async (mode) => {
    setChatKeyResolver(async () => 'sk-chat');
    const controller = new AbortController();
    const reason = new DOMException('Canceled fallback', 'AbortError');
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) return new Response('unavailable', { status: 503 });
      controller.abort(reason);
      expect(init.signal!.aborted).toBe(true);
      throw init.signal!.reason;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestTranscription(audio, { ...withFallback, mode }, undefined, controller.signal))
      .rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://fallback.example.com/v1/audio/transcriptions');
  });
});

describe('transcribeVoices', () => {
  it('prefers QQ asr_refer_text and only calls ASR when missing', async () => {
    const transcribe = vi.fn(async () => ({ text: '在线结果', duration: 3 }));
    const out = await transcribeVoices(
      [voice({ asr_refer_text: 'QQ结果' }), voice({ filename: 'b.amr' }), { ...voice(), content_type: 'image/png' }],
      asr,
      logger,
      transcribe,
    );
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(out.map(p => [p.voiceText, p.voiceSource])).toEqual([['QQ结果', 'asr'], ['在线结果', 'stt']]);
  });

  it('marks voices with no QQ text as asrOffline when the server is down', async () => {
    const transcribe = vi.fn(async () => ({ offline: true as const }));
    const out = await transcribeVoices(
      [voice(), voice({ filename: 'b.amr', asr_refer_text: 'QQ结果' })],
      { ...asr, preferQQ: false },
      logger,
      transcribe,
    );
    expect(out).toEqual([
      expect.objectContaining({ filename: 'a.amr', asrOffline: true, voiceSource: 'fallback' }),
      expect.objectContaining({ filename: 'b.amr', voiceText: 'QQ结果', voiceSource: 'asr' }),
    ]);
    expect(out[0].voiceText).toBeUndefined();
  });

  it('falls back to QQ text when online ASR fails and preferQQ is off', async () => {
    const transcribe = vi.fn(async () => undefined);
    const out = await transcribeVoices([voice({ asr_refer_text: 'QQ结果' })], { ...asr, preferQQ: false }, logger, transcribe);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(out).toEqual([expect.objectContaining({ voiceText: 'QQ结果', voiceSource: 'asr' })]);
  });
});
