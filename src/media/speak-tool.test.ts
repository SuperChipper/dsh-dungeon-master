import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeepSeekSpeakConfig, ElevenLabsSpeakConfig } from '../config.ts';
import type { ChatScope } from '../types.ts';
import { registerSpeakTool, toSpeechText, type RegisterSpeakToolOptions } from './speak-tool.ts';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

describe('toSpeechText', () => {
  it('代码块整段丢掉，行内 code 只留内容', () => {
    const out = toSpeechText('跑这个 ```bash\nnpm run build\n``` 还有 `git status` 也行');
    expect(out).not.toContain('npm run build');
    expect(out).toContain('git status');
  });

  it('markdown 符号和换行抹平', () => {
    expect(toSpeechText('**重点**来了\n下一行')).toBe('重点 来了，下一行');
  });

  it('链接换成「链接」两个字，md 链接只留标题', () => {
    expect(toSpeechText('看 https://example.com/a 这个')).toBe('看 链接 这个');
    expect(toSpeechText('[文档](https://example.com)')).toBe('文档');
  });

  it('纯代码没有可念的内容', () => {
    expect(toSpeechText('```python\nprint(1)\n```')).toBe('');
  });
});

describe('registerSpeakTool', () => {
  let root: string;
  const execFileMock = vi.mocked(execFile);
  const fetchMock = vi.fn<typeof fetch>();
  const localUrl = 'http://127.0.0.1:8765';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'speak-tool-'));
    vi.stubGlobal('fetch', fetchMock.mockImplementation(async () => new Response(new Uint8Array(2048))));
    execFileMock.mockImplementation(((_file: string, args: string[], _options: unknown, callback: Function) => {
      writeFileSync(args.at(-1)!, Buffer.alloc(2048));
      callback(null, '', '');
    }) as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function register(options: {
    bound?: boolean;
    personaId?: string;
    scope?: ChatScope;
    personaVoiceId?: string;
    defaultVoiceId?: string;
    maxChars?: number;
    elevenlabs?: Partial<ElevenLabsSpeakConfig>;
    deepseek?: Partial<DeepSeekSpeakConfig>;
    credentialKey?: string;
    credentialKeys?: Record<string, string>;
    gsvUrl?: string;
    toolOptions?: RegisterSpeakToolOptions;
  } = {}) {
    type ToolDef = {
      execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<unknown>;
      output: { render(args: unknown, value: unknown): Array<{ type: string; text?: string }> };
    };
    let tool: ToolDef | undefined;
    const ctx = {
      get: (name: string) => {
        if (name === 'tools') return { register: (def: ToolDef) => { tool = def; } };
        if (name === 'credentials' && (options.credentialKey !== undefined || options.credentialKeys !== undefined)) {
          return {
            resolve: async (ref: string) => {
              const value = options.credentialKeys?.[ref] ?? options.credentialKey;
              return value === undefined ? undefined : { value };
            },
          };
        }
        return undefined;
      },
    };
    const sendVoice = vi.fn(async () => ({ upload: { file_uuid: 'voice-file' }, message: { id: 'voice-message' } }));
    const agent = Object.freeze({ preset: 'unrelated preset', systemPrompt: '假设我叫 Gemini。' });
    const peerId = 'origin';
    const scope = options.scope ?? 'group';
    const record = {
      peerId, scope, agent, agentPreset: agent.preset,
      replyTarget: { scope, targetId: peerId },
    };
    const findByAgent = vi.fn((ref: unknown) => options.bound && ref === agent ? record : undefined);
    const currentId = vi.fn(() => options.personaId);
    const current = vi.fn(() => (
      options.personaId && options.personaId !== 'default'
        ? { id: options.personaId, name: options.personaId, names: [], prompt: 'p', ...(options.personaVoiceId ? { voiceId: options.personaVoiceId } : {}) }
        : undefined
    ));
    const defaultPersona = vi.fn(() => (
      options.defaultVoiceId ? { id: 'default', name: '默认', names: [], prompt: 'd', voiceId: options.defaultVoiceId } : undefined
    ));
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    registerSpeakTool(
      ctx as never,
      { sendVoice },
      {
        findByAgent,
        personaStore: options.personaId === undefined && options.personaVoiceId === undefined && options.defaultVoiceId === undefined
          ? undefined
          : { currentId, current, defaultPersona },
      } as never,
      {
        tmpDir: root,
        speak: {
          enabled: true,
          voice: 'zh-CN-XiaoyiNeural',
          rate: '+8%',
          maxChars: options.maxChars ?? 1500,
          command: 'test-edge-tts',
          gsvUrl: options.gsvUrl ?? `${localUrl}/`,
          gsvSpeed: 0.95,
          ...(options.elevenlabs !== undefined ? { elevenlabs: options.elevenlabs } : {}),
          ...(options.deepseek !== undefined ? { deepseek: options.deepseek } : {}),
        },
      } as never,
      logger,
      options.toolOptions,
    );
    return { tool: tool!, sendVoice, agent, record, findByAgent, currentId, logger };
  }

  function requestBody(): unknown {
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${localUrl}/tts`);
    expect(options).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    return JSON.parse(String(options?.body));
  }

  it.each([
    ['default', 'feiyu', 'group'],
    ['soft-whale', 'feiyu', 'group'],
    ['tieba-whale', 'feiyu', 'c2c'],
    ['white-dragon', 'dragon', 'c2c'],
    ['Gemini', 'hakimi', 'group'],
  ] as const)('用受信任的 QQ 人设 %s 选 %s，而不是读台词、preset 或发送目的地', async (personaId, role, scope) => {
    const { tool, sendVoice, agent, record, findByAgent, currentId } = register({ bound: true, personaId, scope });
    const text = '我是白龙还是哈基米？';
    await expect(tool.execute({ text, target: 'c2c:destination' }, { agent, signal: new AbortController().signal }))
      .resolves.toMatchObject({ backend: 'local', target: 'c2c:destination', fileUuid: 'voice-file', messageId: 'voice-message' });
    expect(findByAgent).toHaveBeenCalledExactlyOnceWith(agent);
    expect(currentId).toHaveBeenCalledExactlyOnceWith(record.peerId, scope);
    expect(requestBody()).toEqual({ text, speed: 0.95, role });
    expect(sendVoice).toHaveBeenCalledExactlyOnceWith({ scope: 'c2c', targetId: 'destination' }, {
      localPath: expect.stringMatching(/\.mp3$/),
    });
    expect(record.agentPreset).toBe('unrelated preset');
    expect(agent.systemPrompt).toBe('假设我叫 Gemini。');
  });

  it('独立传递 text、lang、role 和原样 style；无需显式 target 也能发回当前 QQ 会话', async () => {
    const { tool, sendVoice, agent, record } = register({ bound: true, personaId: 'white-dragon' });
    const style = '忍着笑自嘲，句尾收住';
    await tool.execute({ text: '**そうだね**（本当に）', lang: 'ja', style }, { agent, signal: new AbortController().signal });
    expect(requestBody()).toEqual({ text: 'そうだね （本当に）', speed: 0.95, lang: 'ja', role: 'dragon', style });
    expect(sendVoice).toHaveBeenCalledWith(record.replyTarget, expect.anything());
  });

  it.each(['unmapped-persona', undefined])('QQ 人设无法映射（%s）时由服务决定音色', async (personaId) => {
    const { tool, agent } = register({ bound: true, personaId });
    await tool.execute({ text: '旧调用仍然可用。' }, { signal: new AbortController().signal, agent });
    expect(requestBody()).toEqual({ text: '旧调用仍然可用。', speed: 0.95 });
  });

  it('无 agent 的旧调用保留原有请求格式', async () => {
    const { tool, findByAgent, currentId } = register({ personaId: 'Gemini' });
    await tool.execute({ text: 'Test', lang: 'en', target: 'c2c:u1' }, { signal: new AbortController().signal });
    expect(requestBody()).toEqual({ text: 'Test', speed: 0.95, lang: 'en' });
    expect(findByAgent).not.toHaveBeenCalled();
    expect(currentId).not.toHaveBeenCalled();
  });

  it('Web agent 没有 QQ 记录时可显式选音色，但不能用目标会话的人设', async () => {
    const { tool, agent, currentId } = register({ personaId: 'white-dragon' });
    await tool.execute({ text: '试音。', target: 'group:origin', role: 'hakimi' }, { signal: new AbortController().signal, agent });
    expect(requestBody()).toEqual({ text: '试音。', speed: 0.95, role: 'hakimi' });
    expect(currentId).not.toHaveBeenCalled();
  });

  it.each(['white-dragon', 'unmapped-persona'])('QQ 会话不允许显式覆盖音色（%s）', async (personaId) => {
    const { tool, agent, sendVoice } = register({ bound: true, personaId });
    await expect(tool.execute({ text: '不要切音色。', role: 'hakimi', target: 'c2c:elsewhere' }, {
      signal: new AbortController().signal, agent,
    })).rejects.toThrow('请省略 `role`');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendVoice).not.toHaveBeenCalled();
  });

  it('拒绝不受支持的 role', async () => {
    const { tool } = register();
    await expect(tool.execute({ text: '试音。', role: 'other', target: 'c2c:u1' }, { signal: new AbortController().signal }))
      .rejects.toThrow('`role` 只接受');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '', 42, '含(括号)', '含（全角）', '含﹙兼容﹚', '含「起始括号', '含结束括号⦆',
    '小于号<', '大于号>', '竖线|', '反引号`', '全角小于号＜', '全角竖线｜', '全角反引号｀',
    '中间\n换行', '尾端制表符\t', '中间\0控制', '中间\u2028行分隔符', '中间\u2029段落分隔符',
    '中间\u202E格式控制', '中间\uD800孤立代理', '𠮷'.repeat(161),
  ])('拒绝无效 style %j，不请求、不发送', async (style) => {
    const { tool, sendVoice } = register();
    await expect(tool.execute({ text: '试音。', target: 'c2c:u1', style }, { signal: new AbortController().signal }))
      .rejects.toThrow('`style`');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(sendVoice).not.toHaveBeenCalled();
  });

  it('style 的 160 字上限按 Unicode 码点计数', async () => {
    const { tool } = register();
    const style = '𠮷'.repeat(160);
    await tool.execute({ text: '试音。', target: 'c2c:u1', style }, { signal: new AbortController().signal });
    expect(requestBody()).toEqual({ text: '试音。', speed: 0.95, style });
  });

  it('本地服务失败时，edge-tts 只收到台词、原有音色和速率', async () => {
    const { tool, agent, sendVoice } = register({ bound: true, personaId: 'Gemini' });
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    const result = await tool.execute({ text: '照常说。', style: '轻快一些', lang: 'ja' }, {
      signal: new AbortController().signal, agent,
    });
    expect(requestBody()).toEqual({ text: '照常说。', speed: 0.95, style: '轻快一些', lang: 'ja', role: 'hakimi' });
    expect(execFileMock).toHaveBeenCalledExactlyOnceWith('test-edge-tts', [
      '--voice', 'zh-CN-XiaoyiNeural', '--rate', '+8%', '--text', '照常说。', '--write-media', expect.stringMatching(/\.mp3$/),
    ], expect.anything(), expect.any(Function));
    expect(result).toMatchObject({ backend: 'edge-tts', voice: 'zh-CN-XiaoyiNeural' });
    expect(sendVoice).toHaveBeenCalledTimes(1);
  });

  it('exec.signal 已中止时不请求、不回退 edge-tts、不调用 sendVoice', async () => {
    const { tool, sendVoice } = register();
    const controller = new AbortController();
    controller.abort(new Error('turn cancelled'));
    await expect(tool.execute({ text: '你好呀', target: 'c2c:u1' }, { signal: controller.signal })).rejects.toThrow('turn cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(sendVoice).not.toHaveBeenCalled();
  });

  it('请求已开始时同步中止本地请求，而不是回退或发送', async () => {
    const { tool, sendVoice } = register();
    const controller = new AbortController();
    let started!: (signal: AbortSignal) => void;
    const requestStarted = new Promise<AbortSignal>(resolve => { started = resolve; });
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      started(signal);
    }));
    const pending = tool.execute({ text: '还没说完', target: 'c2c:u1', role: 'dragon', style: '平静轻声' }, {
      signal: controller.signal,
    });
    const requestSignal = await requestStarted;
    const reason = new Error('turn cancelled');
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    expect(requestSignal.aborted).toBe(true);
    await rejected;
    expect(execFileMock).not.toHaveBeenCalled();
    expect(sendVoice).not.toHaveBeenCalled();
  });

  describe('ElevenLabs 在线 TTS', () => {
    const roleVoices = {
      feiyu: 'v_feiyu_01',
      dragon: 'v_dragon_02',
      hakimi: 'v_hakimi_03',
    };

    it.each([
      ['default', 'feiyu', 'v_feiyu_01', 'group'],
      ['soft-whale', 'feiyu', 'v_feiyu_01', 'group'],
      ['tieba-whale', 'feiyu', 'v_feiyu_01', 'c2c'],
      ['white-dragon', 'dragon', 'v_dragon_02', 'c2c'],
      ['Gemini', 'hakimi', 'v_hakimi_03', 'group'],
    ] as const)('按受信任 QQ 人设 %s 路由到角色 %s (%s)', async (personaId, expectedLabel, voiceId, scope) => {
      const { tool, sendVoice, agent } = register({
        bound: true,
        personaId,
        scope,
        credentialKey: 'xi-test-key',
        elevenlabs: { enabled: true, roleVoices },
      });
      const result = await tool.execute({ text: '你好呀', target: 'group:dest' }, {
        signal: new AbortController().signal,
        agent,
      });
      expect(result).toMatchObject({ backend: 'elevenlabs', voice: expectedLabel, target: 'group:dest' });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`);
      expect(init?.headers).toMatchObject({ 'xi-api-key': 'xi-test-key', 'Content-Type': 'application/json' });
      expect(execFileMock).not.toHaveBeenCalled();
      expect(sendVoice).toHaveBeenCalledTimes(1);
      expect(tool.output.render({}, result)[0]?.text).toContain(`ElevenLabs（${expectedLabel}）`);
    });

    it('支持按具体 personaId 与人设 frontmatter voiceId 覆盖角色映射', async () => {
      const { tool: byPersonaMap, agent: a1 } = register({
        bound: true,
        personaId: 'soft-whale',
        credentialKey: 'xi-test-key',
        elevenlabs: {
          enabled: true,
          roleVoices: { ...roleVoices, 'soft-whale': 'v_soft_override' },
        },
      });
      await byPersonaMap.execute({ text: '覆盖映射' }, { signal: new AbortController().signal, agent: a1 });
      expect(fetchMock.mock.calls[0]?.[0]).toContain('/v_soft_override?');

      const { tool: byFrontmatter, agent: a2 } = register({
        bound: true,
        personaId: 'custom-maid',
        personaVoiceId: 'v_frontmatter_maid',
        credentialKey: 'xi-test-key',
        elevenlabs: { enabled: true, roleVoices },
      });
      const res = await byFrontmatter.execute({ text: '头信息覆盖' }, { signal: new AbortController().signal, agent: a2 });
      expect(fetchMock.mock.calls[1]?.[0]).toContain('/v_frontmatter_maid?');
      expect(res).toMatchObject({ backend: 'elevenlabs', voice: 'custom-maid' });
    });

    it('eleven_v4 按文本自动识别 zh / ja language_code 且精简 voice_settings；eleven_multilingual_v2 仍不传 language_code', async () => {
      const { tool: v4, agent: a0 } = register({
        bound: true,
        personaId: 'white-dragon',
        credentialKey: 'xi-test-key',
        elevenlabs: { enabled: true, roleVoices },
      });
      await v4.execute({ text: '先叠个甲。' }, { signal: new AbortController().signal, agent: a0 });
      const bodyV4Zh = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(bodyV4Zh.model_id).toBe('eleven_v4');
      expect(bodyV4Zh.language_code).toBe('zh');
      expect(bodyV4Zh.voice_settings).toEqual({ stability: 0.5, similarity_boost: 0.75 });

      await v4.execute({ text: 'そうだね' }, { signal: new AbortController().signal, agent: a0 });
      const bodyV4Ja = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
      expect(bodyV4Ja.language_code).toBe('ja');

      await v4.execute({ text: 'Hello there' }, { signal: new AbortController().signal, agent: a0 });
      const bodyV4En = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
      expect(bodyV4En.language_code).toBeUndefined();

      const { tool: v2, agent: a1 } = register({
        bound: true,
        personaId: 'Gemini',
        credentialKey: 'xi-test-key',
        elevenlabs: { enabled: true, modelId: 'eleven_multilingual_v2', roleVoices },
      });
      await v2.execute({ text: 'そうだね', lang: 'ja' }, { signal: new AbortController().signal, agent: a1 });
      const bodyV2 = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
      expect(bodyV2.language_code).toBeUndefined();

      const { tool: v3, agent: a2 } = register({
        bound: true,
        personaId: 'Gemini',
        credentialKey: 'xi-test-key',
        elevenlabs: { enabled: true, modelId: 'eleven_v3', roleVoices },
      });
      await v3.execute({ text: 'そうだね', lang: 'ja' }, { signal: new AbortController().signal, agent: a2 });
      const bodyV3 = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body));
      expect(bodyV3.language_code).toBe('ja');
      expect(bodyV3.voice_settings).toEqual({
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
      });

      const { tool: flash, agent: a3 } = register({
        bound: true,
        personaId: 'Gemini',
        credentialKey: 'xi-test-key',
        elevenlabs: { enabled: true, modelId: 'eleven_flash_v2_5', roleVoices },
      });
      await flash.execute({ text: 'Hello', lang: 'en' }, { signal: new AbortController().signal, agent: a3 });
      const bodyFlash = JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body));
      expect(bodyFlash.language_code).toBe('en');
    });

    it('style 不混入 ElevenLabs text；ElevenLabs 5xx 时回退本地服务并原样透传 style', async () => {
      const { tool, agent } = register({
        bound: true,
        personaId: 'white-dragon',
        credentialKey: 'xi-test-key',
        elevenlabs: { enabled: true, roleVoices },
      });
      fetchMock
        .mockResolvedValueOnce(new Response('upstream error', { status: 500 }))
        .mockResolvedValueOnce(new Response(new Uint8Array(2048)));

      const result = await tool.execute({ text: '先叠个甲。', style: '忍着笑吐槽' }, {
        signal: new AbortController().signal,
        agent,
      });
      expect(result).toMatchObject({ backend: 'local', voice: '本地嗓子' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const elBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(elBody.text).toBe('先叠个甲。');
      const localBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
      expect(localBody).toEqual({ text: '先叠个甲。', speed: 0.95, role: 'dragon', style: '忍着笑吐槽' });
    });

    it('ElevenLabs 缺 key 时自动回退本地服务，本地再失败自动退回 edge-tts', async () => {
      const { tool, agent, sendVoice } = register({
        bound: true,
        personaId: 'Gemini',
        elevenlabs: { enabled: true, roleVoices, apiKeyEnv: 'MISSING_XI_KEY_FOR_TEST' },
      });
      fetchMock.mockResolvedValueOnce(new Response('local down', { status: 503 }));
      const result = await tool.execute({ text: '三级回退测试' }, {
        signal: new AbortController().signal,
        agent,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${localUrl}/tts`);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ backend: 'edge-tts', voice: 'zh-CN-XiaoyiNeural' });
      expect(sendVoice).toHaveBeenCalledTimes(1);
    });

    it('人设未绑定 ElevenLabs 且无 defaultVoiceId 时跳过 ElevenLabs 直接走本地服务', async () => {
      const { tool, agent } = register({
        bound: true,
        personaId: 'default',
        credentialKey: 'xi-test-key',
        elevenlabs: { enabled: true, roleVoices: { dragon: 'v_dragon_02', hakimi: 'v_hakimi_03' } },
      });
      const res = await tool.execute({ text: '大肥鱼走本地' }, { signal: new AbortController().signal, agent });
      expect(res).toMatchObject({ backend: 'local' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${localUrl}/tts`);
    });

    it('支持从注入的 envFiles 解析 ELEVENLABS_API_KEY，且非 QQ 自定义角色回退本地时不透传非法 role', async () => {
      const envPath = join(root, '.env.local');
      writeFileSync(envPath, 'ELEVENLABS_API_KEY="xi-from-dotenv"\n', 'utf8');
      const { tool } = register({
        elevenlabs: { enabled: true, roleVoices: { ...roleVoices, maid: 'v_maid_09' } },
        toolOptions: { envFiles: [envPath] },
      });
      await tool.execute({ text: '女仆试音', target: 'c2c:u1', role: 'maid' }, {
        signal: new AbortController().signal,
      });
      expect(fetchMock.mock.calls[0]?.[0]).toContain('/v_maid_09?');
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'xi-api-key': 'xi-from-dotenv' });

      fetchMock
        .mockResolvedValueOnce(new Response('xi down', { status: 502 }))
        .mockResolvedValueOnce(new Response(new Uint8Array(2048)));
      await tool.execute({ text: '自定义角色降级', target: 'c2c:u1', role: 'maid' }, {
        signal: new AbortController().signal,
      });
      const localBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
      expect(localBody.role).toBeUndefined();
    });

    it('exec.signal 中止时同步取消 ElevenLabs fetch 且不回退、不发送', async () => {
      const { tool, sendVoice, agent } = register({
        bound: true,
        personaId: 'Gemini',
        credentialKey: 'xi-test-key',
        elevenlabs: { enabled: true, roleVoices },
      });
      const controller = new AbortController();
      let started!: (signal: AbortSignal) => void;
      const requestStarted = new Promise<AbortSignal>((resolve) => { started = resolve; });
      fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started(signal);
      }));
      const pending = tool.execute({ text: '中断测试' }, { signal: controller.signal, agent });
      const requestSignal = await requestStarted;
      const reason = new Error('turn cancelled');
      const rejected = expect(pending).rejects.toBe(reason);
      controller.abort(reason);
      expect(requestSignal.aborted).toBe(true);
      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).not.toHaveBeenCalled();
      expect(sendVoice).not.toHaveBeenCalled();
    });
  });

  describe('DeepSeek TTS 与 ElevenLabs 混合多角色', () => {
    const hybridElevenLabs: Partial<ElevenLabsSpeakConfig> = {
      enabled: true,
      roleVoices: {
        dragon: '5q4CepYUNl0GbkkgWQCr',
        hakimi: 'jsFTyDLIzXGzC5TAFmFD',
      },
    };
    const hybridDeepSeek: Partial<DeepSeekSpeakConfig> = {
      enabled: true,
      roleVoices: {
        feiyu: '海星',
      },
    };
    const credentialKeys = {
      ELEVENLABS_API_KEY: 'xi-hybrid-key',
      DEEPSEEK_API_KEY: 'ds-hybrid-key',
    };

    it.each([
      ['default', 'c2c'],
      ['soft-whale', 'group'],
      ['tieba-whale', 'group'],
    ] as const)('混合模式下 %s 走 DeepSeek 海星 (stella) 并经 ffmpeg 转 MP3', async (personaId, scope) => {
      const { tool, sendVoice, agent } = register({
        bound: true,
        personaId,
        scope,
        credentialKeys,
        elevenlabs: hybridElevenLabs,
        deepseek: hybridDeepSeek,
      });
      const result = await tool.execute({ text: '**早上好**' }, {
        signal: new AbortController().signal,
        agent,
      });
      expect(result).toMatchObject({ backend: 'deepseek', voice: 'feiyu' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.deepseek.com/v1/tools/tts');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer ds-hybrid-key',
        'Content-Type': 'application/json',
        Accept: 'audio/wav',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        text: '早上好',
        voice_id: 'stella',
        format: 'wav',
        filter_markdown: true,
      });
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock.mock.calls[0]?.[0]).toBe('ffmpeg');
      expect(sendVoice).toHaveBeenCalledTimes(1);
      expect(tool.output.render({}, result)[0]?.text).toContain('DeepSeek（feiyu）');
    });

    it.each([
      ['white-dragon', 'dragon', '5q4CepYUNl0GbkkgWQCr'],
      ['Gemini', 'hakimi', 'jsFTyDLIzXGzC5TAFmFD'],
    ] as const)('混合模式下 %s 仍走 ElevenLabs 角色 %s', async (personaId, expectedLabel, voiceId) => {
      const { tool, agent } = register({
        bound: true,
        personaId,
        credentialKeys,
        elevenlabs: hybridElevenLabs,
        deepseek: hybridDeepSeek,
      });
      const result = await tool.execute({ text: '测试角色音色' }, {
        signal: new AbortController().signal,
        agent,
      });
      expect(result).toMatchObject({ backend: 'elevenlabs', voice: expectedLabel });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toContain(`/text-to-speech/${voiceId}?`);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('支持 https://api.deepseek.com 自动补 /v1 与语速 atempo，style 不混入 text 且失败回退本地服务', async () => {
      const { tool, agent } = register({
        bound: true,
        personaId: 'default',
        credentialKeys,
        elevenlabs: hybridElevenLabs,
        deepseek: { enabled: true, baseUrl: 'https://api.deepseek.com', roleVoices: { feiyu: 'stella' }, speed: 1.1 },
      });
      await tool.execute({ text: '调速测试', style: '轻快一点' }, {
        signal: new AbortController().signal,
        agent,
      });
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/v1/tools/tts');
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).text).toBe('调速测试');
      expect(execFileMock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['-af', 'atempo=1.1']));

      fetchMock
        .mockResolvedValueOnce(new Response('ds down', { status: 500 }))
        .mockResolvedValueOnce(new Response(new Uint8Array(2048)));
      const fallbackRes = await tool.execute({ text: '失败降级', style: '忍着笑自嘲' }, {
        signal: new AbortController().signal,
        agent,
      });
      expect(fallbackRes).toMatchObject({ backend: 'local', voice: '本地嗓子' });
      const localBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
      expect(localBody).toEqual({ text: '失败降级', speed: 0.95, role: 'feiyu', style: '忍着笑自嘲' });
    });

    it('exec.signal 中止时同步取消 DeepSeek fetch 且不回退、不发送', async () => {
      const { tool, sendVoice, agent } = register({
        bound: true,
        personaId: 'default',
        credentialKeys,
        elevenlabs: hybridElevenLabs,
        deepseek: hybridDeepSeek,
      });
      const controller = new AbortController();
      let started!: (signal: AbortSignal) => void;
      const requestStarted = new Promise<AbortSignal>((resolve) => { started = resolve; });
      fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started(signal);
      }));
      const pending = tool.execute({ text: '取消测试' }, { signal: controller.signal, agent });
      const requestSignal = await requestStarted;
      const reason = new Error('turn cancelled');
      const rejected = expect(pending).rejects.toBe(reason);
      controller.abort(reason);
      expect(requestSignal.aborted).toBe(true);
      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).not.toHaveBeenCalled();
      expect(sendVoice).not.toHaveBeenCalled();
    });
  });

  describe('字数与体积限制', () => {
    it('默认 1500 字上限下支持 4 分钟级长文本（如 1260 字）通过 ElevenLabs 正常发送', async () => {
      const { tool, sendVoice, agent } = register({
        bound: true,
        personaId: 'Gemini',
        credentialKey: 'xi-test-key',
        elevenlabs: { enabled: true, roleVoices: { hakimi: 'yJMhHgXbgiuvJezppMtB' } },
      });
      const longText = '哈基米测试长语音。'.repeat(140);
      expect(longText.length).toBe(1260);
      const result = await tool.execute({ text: longText, target: 'group:dest' }, {
        signal: new AbortController().signal,
        agent,
      });
      expect(result).toMatchObject({ backend: 'elevenlabs', voice: 'hakimi', chars: 1260, target: 'group:dest' });
      expect(sendVoice).toHaveBeenCalledTimes(1);
    });

    it('超过 maxChars 时抛错提示 20MB 上限，不再出现 60 秒', async () => {
      const { tool, sendVoice, agent } = register({
        bound: true,
        personaId: 'Gemini',
        credentialKey: 'xi-test-key',
        elevenlabs: { enabled: true, roleVoices: { hakimi: 'yJMhHgXbgiuvJezppMtB' } },
      });
      const oversized = '哈'.repeat(1501);
      let thrown: Error | undefined;
      try {
        await tool.execute({ text: oversized }, { signal: new AbortController().signal, agent });
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown?.message).toContain('超过上限 1500 字');
      expect(thrown?.message).toContain('20MB');
      expect(thrown?.message).not.toContain('60 秒');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sendVoice).not.toHaveBeenCalled();
    });

    it('合成音频超过 20MB 时拦截报错、清理临时文件且不调用 sendVoice', async () => {
      const { tool, sendVoice, agent } = register({
        bound: true,
        personaId: 'Gemini',
        credentialKey: 'xi-test-key',
        elevenlabs: { enabled: true, roleVoices: { hakimi: 'yJMhHgXbgiuvJezppMtB' } },
      });
      fetchMock.mockResolvedValueOnce(new Response(Buffer.alloc(20 * 1024 * 1024 + 16, 1)));
      await expect(tool.execute({ text: '大文件拦截测试' }, { signal: new AbortController().signal, agent }))
        .rejects.toThrow('超过 QQ 语音 20MB 上限');
      expect(sendVoice).not.toHaveBeenCalled();
      expect(readdirSync(join(root, 'voice'))).toEqual([]);
    });
  });

  describe('onSent 回调', () => {
    it('sendVoice 成功后把 target、朗读文本和发送结果交给 onSent', async () => {
      const onSent = vi.fn();
      const { tool, agent, record } = register({
        bound: true,
        personaId: 'white-dragon',
        toolOptions: { onSent },
      });
      await tool.execute({ text: '**测试**语音' }, { signal: new AbortController().signal, agent });
      expect(onSent).toHaveBeenCalledExactlyOnceWith(
        record.replyTarget,
        '测试 语音',
        { upload: { file_uuid: 'voice-file' }, message: { id: 'voice-message' } },
      );
    });

    it('onSent 抛错时记 warning，不阻断工具返回', async () => {
      const onSent = vi.fn(() => {
        throw new Error('disk full');
      });
      const { tool, agent, logger } = register({
        bound: true,
        personaId: 'white-dragon',
        toolOptions: { onSent },
      });
      await expect(tool.execute({ text: '测试回调容错' }, { signal: new AbortController().signal, agent }))
        .resolves.toMatchObject({ fileUuid: 'voice-file', messageId: 'voice-message' });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    });
  });
});
