/**
 * 内置 qqbot_speak 工具 — 让 bot 用自己的声音说一句话。
 *
 * 为什么放在插件里而不是让模型自己跑命令：受限沙箱里联网要人审批，
 * 每开一次口就弹一次确认太出戏；宿主进程内的插件不受文件沙箱约束，
 * 合成一次 mp3 再走 sendVoice 就跟发图一样直接。
 *
 * QQ 语音不支持 caption，后续文字由出站队列留出间隔后独立发送。
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv, promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { defaultEnvFiles } from '../shared/paths.ts';
import {
  DEEPSEEK_SPEAK_DEFAULTS,
  ELEVENLABS_SPEAK_DEFAULTS,
  type DeepSeekSpeakConfig,
  type ElevenLabsSpeakConfig,
  type ImQQBotConfig,
  type SpeakConfig,
} from '../config.ts';
import type { DshAgent, SessionManager } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { resolveOptionalKey } from './chat-gateway.ts';
import { resolveTmpDir } from './tmp-dir.ts';
import { withFreshReplyTarget } from './send-file-tool.ts';
import { VOICE_REPLY_REMINDER, VOICE_REPLY_TOOL_HINT } from './voice-reply.ts';

const execFileAsync = promisify(execFile);

/** 工具名（qqbot 前缀避免与其他通道的同名工具冲突） */
export const SPEAK_TOOL_NAME = 'qqbot_speak';

const DESCRIPTION =
  'Synthesize speech and send it as a real QQ voice bubble (`qqbot_speak`), automatically using the current persona\'s voice. '
  + 'Call this whenever the user asks you to speak out loud, send a voice message, shout/yell/call out, read/recite text aloud, or voice-act a line '
  + '(e.g. "发语音", "说句话听听", "开麦/出声", "大喊/喊一声/吼一声/叫一声", "喵/汪一声", "念一下/读出来/朗读/背一段", "配音/用你的声音说/讲故事给我听") — '
  + 'do NOT substitute plain-text onomatopoeia or copy-pasted text when the user wants to hear your voice. '
  + 'Do NOT put code, shell commands, URLs, raw error logs, or text meant for copy-pasting inside `text`. '
  + VOICE_REPLY_TOOL_HINT;

/** 常用音色（只是提示，允许传任意 edge-tts 音色名） */
const VOICE_HINTS = [
  'zh-CN-XiaoyiNeural（少女音，默认）',
  'zh-CN-XiaoxiaoNeural（通用女声）',
  'zh-CN-XiaomoNeural（偏温柔）',
  'zh-CN-XiaoshuangNeural（更幼）',
  'zh-CN-YunxiNeural（男声）',
].join('、');

interface VoiceSenderLike {
  sendVoice(target: ReplyTarget, source: { localPath?: string }): Promise<{ upload: { file_uuid: string }; message?: { id?: string } }>;
}

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>;
}

export interface RegisterSpeakToolOptions {
  /** 仅测试注入：覆盖默认读取的插件 .env.local / .env 路径，避免单测误读本机环境文件 */
  envFiles?: readonly string[];
  /** 语音发出后的回调（用于归档朗读文本或记录引用索引，不影响语音投递） */
  onSent?: (target: ReplyTarget, spoken: string, result: unknown) => void;
}

const MAX_STYLE_CODE_POINTS = 160;
const MAX_QQ_VOICE_BYTES = 20 * 1024 * 1024;
const ELEVENLABS_VOICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEEPSEEK_VOICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EXPLICIT_ROLE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NO_LANGUAGE_CODE_MODEL_RE = /^eleven_(?:multilingual_v[12]|monolingual_v1)$/i;

interface SpeakArgs {
  text: string;
  voice?: string;
  rate?: string;
  target?: string;
  lang?: string;
  role?: string;
  style?: string;
}

function lookupRoleVoice(roleVoices: Record<string, string> | undefined, key: string | undefined): string | undefined {
  if (roleVoices === undefined || key === undefined) return undefined;
  const needle = key.trim().toLowerCase();
  if (needle === '') return undefined;
  for (const [entryKey, entryVal] of Object.entries(roleVoices)) {
    if (entryKey.trim().toLowerCase() === needle && typeof entryVal === 'string' && entryVal.trim() !== '') {
      return entryVal.trim();
    }
  }
  return undefined;
}

function resolveEnvValueFromFiles(envFiles: readonly string[], keyRef: string): string | undefined {
  for (const file of envFiles) {
    try {
      if (!existsSync(file)) continue;
      const parsed = parseEnv(readFileSync(file, 'utf8'));
      const value = parsed[keyRef]?.trim();
      if (value) return value;
    } catch {
      // 忽略不可读或格式异常的环境文件，交给下一候选或回退通道
    }
  }
  return undefined;
}

async function resolveSpeakApiKey(
  ctx: Context,
  directKey: string | undefined,
  keyRef: string,
  envFiles: readonly string[],
): Promise<string | undefined> {
  const direct = directKey?.trim();
  if (direct) return direct;
  const credentials = ctx.get('credentials') as CredentialsLike | undefined;
  const fromCreds = (await credentials?.resolve(keyRef))?.value?.trim();
  if (fromCreds) return fromCreds;
  const fromEnv = (await resolveOptionalKey(keyRef))?.trim();
  if (fromEnv) return fromEnv;
  return resolveEnvValueFromFiles(envFiles, keyRef);
}

interface OnlineTtsCandidate {
  provider: 'elevenlabs' | 'deepseek';
  voiceId: string;
  label: string;
}

function pushUniqueCandidate(
  list: OnlineTtsCandidate[],
  seen: Set<string>,
  candidate: OnlineTtsCandidate,
): void {
  const key = `${candidate.provider}:${candidate.voiceId}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push(candidate);
}

function resolveOnlineCandidates(
  el: ElevenLabsSpeakConfig | undefined,
  ds: DeepSeekSpeakConfig | undefined,
  options: {
    isQqCaller: boolean;
    personaId?: string;
    personaVoiceId?: string;
    explicitRole?: string;
  },
): OnlineTtsCandidate[] {
  const elEnabled = el?.enabled === true;
  const dsEnabled = ds?.enabled === true;
  if (!elEnabled && !dsEnabled) return [];

  const candidates: OnlineTtsCandidate[] = [];
  const seen = new Set<string>();

  if (options.isQqCaller) {
    const personaId = options.personaId?.trim();
    const label = personaId || 'default';

    // 第一梯队：精确 personaId 映射与人设 frontmatter voiceId
    if (elEnabled) {
      const byPersona = lookupRoleVoice(el.roleVoices, personaId);
      if (byPersona !== undefined) {
        pushUniqueCandidate(candidates, seen, { provider: 'elevenlabs', voiceId: byPersona, label });
      } else if (options.personaVoiceId?.trim()) {
        pushUniqueCandidate(candidates, seen, {
          provider: 'elevenlabs',
          voiceId: options.personaVoiceId.trim(),
          label,
        });
      }
    }
    if (dsEnabled) {
      const byPersona = lookupRoleVoice(ds.roleVoices, personaId);
      if (byPersona !== undefined) {
        pushUniqueCandidate(candidates, seen, { provider: 'deepseek', voiceId: byPersona, label });
      }
    }

    // 第二梯队：defaultVoiceId 兜底
    if (elEnabled && el.defaultVoiceId?.trim()) {
      pushUniqueCandidate(candidates, seen, { provider: 'elevenlabs', voiceId: el.defaultVoiceId.trim(), label });
    }
    if (dsEnabled && ds.defaultVoiceId?.trim()) {
      pushUniqueCandidate(candidates, seen, { provider: 'deepseek', voiceId: ds.defaultVoiceId.trim(), label });
    }
    return candidates;
  }

  const explicitRole = options.explicitRole?.trim();
  if (explicitRole) {
    if (elEnabled) {
      const byRole = lookupRoleVoice(el.roleVoices, explicitRole);
      if (byRole !== undefined) {
        pushUniqueCandidate(candidates, seen, { provider: 'elevenlabs', voiceId: byRole, label: explicitRole });
      }
    }
    if (dsEnabled) {
      const byRole = lookupRoleVoice(ds.roleVoices, explicitRole);
      if (byRole !== undefined) {
        pushUniqueCandidate(candidates, seen, { provider: 'deepseek', voiceId: byRole, label: explicitRole });
      }
    }
    if (elEnabled && el.defaultVoiceId?.trim()) {
      pushUniqueCandidate(candidates, seen, { provider: 'elevenlabs', voiceId: el.defaultVoiceId.trim(), label: explicitRole });
    }
    if (dsEnabled && ds.defaultVoiceId?.trim()) {
      pushUniqueCandidate(candidates, seen, { provider: 'deepseek', voiceId: ds.defaultVoiceId.trim(), label: explicitRole });
    }
    return candidates;
  }

  if (elEnabled && el.defaultVoiceId?.trim()) {
    pushUniqueCandidate(candidates, seen, { provider: 'elevenlabs', voiceId: el.defaultVoiceId.trim(), label: 'default' });
  }
  if (dsEnabled && ds.defaultVoiceId?.trim()) {
    pushUniqueCandidate(candidates, seen, { provider: 'deepseek', voiceId: ds.defaultVoiceId.trim(), label: 'default' });
  }
  return candidates;
}

function validateStyle(style: unknown): string | undefined {
  if (style === undefined) return undefined;
  if (typeof style !== 'string' || style.trim() === '') {
    throw new Error('qqbot_speak: `style` 必须是非空的单行语气描述');
  }
  if ([...style].length > MAX_STYLE_CODE_POINTS) {
    throw new Error(`qqbot_speak: \`style\` 最多 ${MAX_STYLE_CODE_POINTS} 个 Unicode 码点`);
  }
  // 与 VoxCPM 服务的 _delivery_line 同步：只用规范化识别分隔符，不改写描述。
  const delimiterOrControl = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Ps}\p{Pe}()<>|`]/u;
  if (delimiterOrControl.test(style) || delimiterOrControl.test(style.normalize('NFKC'))) {
    throw new Error('qqbot_speak: `style` 不能包含括号、分隔符、控制字符或换行');
  }
  return style;
}

/** 解析显式 target（"c2c:openid" / "group:openid"），非法返回 undefined */
function parseTarget(input: string): ReplyTarget | undefined {
  const idx = input.indexOf(':');
  if (idx <= 0) return undefined;
  const scope = input.slice(0, idx);
  const targetId = input.slice(idx + 1);
  if (!targetId || (scope !== 'c2c' && scope !== 'group')) return undefined;
  return { scope, targetId };
}

/**
 * 把回复文本洗成适合朗读的样子。
 *
 * 代码块整段丢掉（念出来是噪音），链接换成「链接」两个字，
 * markdown 符号和多余换行也一并抹平——这些在耳朵里全是杂音。
 */
export function toSpeechText(raw: string): string {
  let text = raw;
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/https?:\/\/\S+/g, '链接');
  text = text.replace(/[*_~#>|]+/g, ' ');
  text = text.replace(/[ \t]*\n+[ \t]*/g, '，');
  text = text.replace(/[ \t]{2,}/g, ' ');
  return text.trim();
}

/** edge-tts 的候选调用方式：配置优先，否则按 edge-tts → python -m → py -m 依次试探 */
function resolveAttempts(config: SpeakConfig): { bin: string; prefix: string[] }[] {
  const configured = (config.command ?? '').trim();
  if (configured !== '') return [{ bin: configured, prefix: [] }];
  return [
    { bin: 'edge-tts', prefix: [] },
    { bin: 'python', prefix: ['-m', 'edge_tts'] },
    { bin: 'py', prefix: ['-m', 'edge_tts'] },
  ];
}

/** 合成一次 mp3；返回生成的文件路径 */
async function synthesize(
  config: SpeakConfig,
  text: string,
  voice: string,
  rate: string,
  outPath: string,
  logger: Logger,
  signal?: AbortSignal,
): Promise<void> {
  const attempts = resolveAttempts(config);
  const errors: string[] = [];

  for (const attempt of attempts) {
    signal?.throwIfAborted();
    const args = [
      ...attempt.prefix,
      '--voice', voice,
      ...(rate.trim() !== '' ? ['--rate', rate.trim()] : []),
      '--text', text,
      '--write-media', outPath,
    ];
    try {
      await execFileAsync(attempt.bin, args, {
        timeout: 240_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!existsSync(outPath)) throw new Error('合成结束但没有产出文件');
      return;
    } catch (err) {
      if (signal?.aborted) throw err;
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      const reason = e.code === 'ENOENT'
        ? '命令不存在'
        : (e.stderr?.trim() || e.message || String(err));
      errors.push(`${attempt.bin}: ${reason}`);
      logger.warn(`im-qqbot: qqbot_speak 尝试 ${attempt.bin} 失败: ${reason}`);
    }
  }

  throw new Error(
    'qqbot_speak: 语音合成失败，没找到可用的 edge-tts。'
    + `已尝试 -> ${errors.join(' | ')}。`
    + '可用 config.speak.command 指定可执行文件，或先 pip install edge-tts。',
  );
}

/** 把 WAV 二进制通过 ffmpeg 转成 QQ 语音使用的 MP3，并可选调节语速 */
async function convertWavToMp3(
  audio: Buffer,
  outPath: string,
  speed = 1.0,
  signal?: AbortSignal,
): Promise<void> {
  const wavPath = outPath.replace(/\.mp3$/, '.wav');
  await writeFile(wavPath, audio);
  try {
    const tempoArgs = speed !== 1.0 ? ['-af', `atempo=${speed}`] : [];
    await execFileAsync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, ...tempoArgs, '-codec:a', 'libmp3lame', '-q:a', '4', outPath],
      { timeout: 240_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...(signal !== undefined ? { signal } : {}) },
    );
  } finally {
    await rm(wavPath, { force: true });
  }
  if (!existsSync(outPath)) throw new Error('转 mp3 没有产出文件');
}

/**
 * 走本地 TTS 服务（推荐回退路径）。
 *
 * 服务返回 WAV；QQ 语音要 MP3，所以这里用 ffmpeg 转一道。
 * 任何一步失败都抛出去，由调用方退回 edge-tts——宁可声音换人，也不要没声音。
 */
async function synthesizeLocal(
  config: SpeakConfig,
  text: string,
  outPath: string,
  { lang, role, style }: { lang?: string; role?: string; style?: string },
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const base = config.gsvUrl.trim().replace(/\/+$/, '');
  const timeoutSignal = AbortSignal.timeout(240_000);
  const reqSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  const res = await fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 不传时由服务选择语言和音色；语气与朗读内容分开，旧服务可忽略新增字段。
    body: JSON.stringify({ text, speed: config.gsvSpeed, lang, role, style }),
    signal: reqSignal,
  });
  reqSignal.throwIfAborted();
  if (!res.ok) {
    throw new Error(`本地语音服务返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  reqSignal.throwIfAborted();
  if (audio.length < 1024) throw new Error('本地语音服务返回的音频过小');
  await convertWavToMp3(audio, outPath, 1.0, signal);
}

function normalizeDeepSeekVoiceId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '海星') return 'stella';
  if (trimmed === '暗潮') return 'tide';
  return trimmed;
}

function resolveDeepSeekTtsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base === '') {
    throw new Error('DeepSeek baseUrl 不能为空');
  }
  const normalized = /^https?:\/\/api\.deepseek\.com$/i.test(base) ? `${base}/v1` : base;
  return `${normalized}/tools/tts`;
}

/**
 * 走 DeepSeek 官方 TTS API（/v1/tools/tts，返回 WAV 后经 ffmpeg 转 MP3）。
 */
async function synthesizeDeepSeek(
  ds: DeepSeekSpeakConfig,
  apiKey: string,
  rawVoiceId: string,
  text: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const voiceId = normalizeDeepSeekVoiceId(rawVoiceId);
  if (!DEEPSEEK_VOICE_ID_RE.test(voiceId)) {
    throw new Error(`DeepSeek voice_id 格式非法: ${rawVoiceId}`);
  }
  const url = resolveDeepSeekTtsUrl(ds.baseUrl);
  const timeoutSignal = AbortSignal.timeout(ds.timeoutMs);
  const reqSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'audio/wav',
    },
    body: JSON.stringify({
      text,
      voice_id: voiceId,
      format: 'wav',
      filter_markdown: true,
    }),
    signal: reqSignal,
  });
  reqSignal.throwIfAborted();
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    reqSignal.throwIfAborted();
    throw new Error(`DeepSeek TTS 返回 ${res.status}: ${detail.slice(0, 200)}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  reqSignal.throwIfAborted();
  if (audio.length < 256) {
    throw new Error('DeepSeek TTS 返回的音频过小');
  }
  await convertWavToMp3(audio, outPath, ds.speed, signal);
}

function inferLanguageCode(text: string, explicitLang?: string): string | undefined {
  const explicit = explicitLang?.trim();
  if (explicit) return explicit;
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/\p{Script=Han}/u.test(text)) return 'zh';
  return undefined;
}

/**
 * 走 ElevenLabs REST API 在线合成（直出 MP3，无需 ffmpeg 转码）。
 * 失败（非主动取消）时抛给调用方按三级回退链降级。
 */
async function synthesizeElevenLabs(
  el: ElevenLabsSpeakConfig,
  apiKey: string,
  voiceId: string,
  text: string,
  outPath: string,
  lang?: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!ELEVENLABS_VOICE_ID_RE.test(voiceId)) {
    throw new Error(`ElevenLabs voice_id 格式非法: ${voiceId}`);
  }
  const base = el.baseUrl.trim().replace(/\/+$/, '');
  if (base === '') {
    throw new Error('ElevenLabs baseUrl 不能为空');
  }
  const modelId = el.modelId.trim() || ELEVENLABS_SPEAK_DEFAULTS.modelId;
  const outputFormat = el.outputFormat || ELEVENLABS_SPEAK_DEFAULTS.outputFormat;
  const url = `${base}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
  const timeoutSignal = AbortSignal.timeout(el.timeoutMs);
  const reqSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

  const isV4 = /^eleven_v4/i.test(modelId);
  const voiceSettings: Record<string, unknown> = isV4
    ? {
        stability: el.stability,
        similarity_boost: el.similarityBoost,
        ...(el.speed !== 1.0 ? { speed: el.speed } : {}),
      }
    : {
        stability: el.stability,
        similarity_boost: el.similarityBoost,
        style: el.styleExaggeration,
        use_speaker_boost: el.useSpeakerBoost,
        ...(el.speed !== 1.0 ? { speed: el.speed } : {}),
      };
  // eleven_multilingual_v2 / v1 与 eleven_monolingual_v1 不支持显式 language_code，传了会报 400
  const languageCode = NO_LANGUAGE_CODE_MODEL_RE.test(modelId)
    ? undefined
    : inferLanguageCode(text, lang);
  const payload: Record<string, unknown> = {
    text,
    model_id: modelId,
    voice_settings: voiceSettings,
    ...(languageCode !== undefined ? { language_code: languageCode } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(payload),
    signal: reqSignal,
  });
  reqSignal.throwIfAborted();
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    reqSignal.throwIfAborted();
    throw new Error(`ElevenLabs 返回 ${res.status}: ${detail.slice(0, 200)}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  reqSignal.throwIfAborted();
  if (audio.length < 256) {
    throw new Error('ElevenLabs 返回的音频过小');
  }
  await writeFile(outPath, audio);
  if (!existsSync(outPath)) {
    throw new Error('ElevenLabs 写入音频失败');
  }
}

/** 注册 qqbot_speak 工具（tools 服务缺失时优雅降级，不阻断插件启动） */
export function registerSpeakTool(
  ctx: Context,
  bot: VoiceSenderLike,
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
  options?: RegisterSpeakToolOptions,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_speak 工具未注册');
    return;
  }

  const speak = config.speak;
  const elevenlabsConfig: ElevenLabsSpeakConfig | undefined = speak.elevenlabs === undefined
    ? undefined
    : { ...ELEVENLABS_SPEAK_DEFAULTS, ...speak.elevenlabs };
  const deepseekConfig: DeepSeekSpeakConfig | undefined = speak.deepseek === undefined
    ? undefined
    : { ...DEEPSEEK_SPEAK_DEFAULTS, ...speak.deepseek };
  const envFiles = options?.envFiles ?? (
    process.env.VITEST
      ? []
      : defaultEnvFiles()
  );
  const configuredRoles = [...new Set<string>(
    [
      ...Object.entries(elevenlabsConfig?.roleVoices ?? {}),
      ...Object.entries(deepseekConfig?.roleVoices ?? {}),
    ]
      .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
      .map(([key]) => key.trim())
      .filter(Boolean),
  )];
  const hasLocalService = (speak.gsvUrl ?? '').trim() !== '';
  const strictConfiguredRoles = configuredRoles.length > 0 && !hasLocalService;
  const outDir = join(resolveTmpDir(config), 'voice');

  const definition = {
    name: SPEAK_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            `Only the exact spoken words/interjections to say out loud (plain text, up to ${speak.maxChars} chars; markdown/code blocks are stripped). `
            + 'Use natural punctuation/elongation for emotion (e.g. "喂——！听见没有！"), and NEVER include bracketed or asterisk stage directions '
            + 'like "（大声喊）", "[大喊]", or "*深吸一口气*" in `text` because TTS will read them literally. Put delivery cues in `style` instead.',
        },
        voice: {
          type: 'string',
          description: `Optional edge-tts voice name (ignored when ElevenLabs or a local voice service is active). Defaults to config.speak.voice. Common ones: ${VOICE_HINTS}`,
        },
        rate: {
          type: 'string',
          description: 'Optional speech-rate delta such as "+10%" or "-5%". Defaults to config.speak.rate.',
        },
        lang: {
          type: 'string',
          enum: ['zh', 'ja', 'en'],
          description: 'Optional language hint for the voice service. Ignored by edge-tts and multilingual v2.',
        },
        role: {
          type: 'string',
          ...(strictConfiguredRoles ? { enum: configuredRoles } : {}),
          description: 'Optional voice role only outside QQ sessions (e.g. Web with an explicit target). '
            + 'In QQ, omit it: the current conversation persona chooses the voice. Ignored by edge-tts.',
        },
        style: {
          type: 'string',
          description: `Optional one-line delivery direction, e.g. "放开嗓子大声喊出来" or "忍着笑自嘲，句尾收住" (up to ${MAX_STYLE_CODE_POINTS} Unicode code points). `
            + 'No brackets, angle signs, pipes, backticks or control characters. Keep it separate from text; it is not spoken and online/edge-tts backends ignore it safely.',
        },
        target: {
          type: 'string',
          description: 'Optional send target as "c2c:openid" or "group:openid". Omit to speak into the current conversation.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          voice: { type: 'string' },
          backend: { type: 'string' },
          chars: { type: 'integer' },
          fileSize: { type: 'integer' },
          target: { type: 'string' },
          fileUuid: { type: 'string' },
          messageId: { type: 'string' },
        },
        required: ['voice', 'chars', 'fileSize', 'target', 'fileUuid'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { voice: string; backend?: string; chars: number; target: string };
        const engine = v.backend === 'elevenlabs'
          ? `ElevenLabs（${v.voice}）`
          : v.backend === 'deepseek'
            ? `DeepSeek（${v.voice}）`
            : v.backend === 'local'
              ? '本地嗓子'
              : `edge-tts，${v.voice}`;
        return [{
          type: 'text',
          text: `已发送语音（${v.chars} 字，${engine}）→ ${v.target}。`
            + VOICE_REPLY_REMINDER,
        }];
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown>> {
      const { text, voice, rate, target, lang, role, style } = args as SpeakArgs;
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('qqbot_speak: `text` 不能为空');
      }

      const spoken = toSpeechText(text);
      if (spoken.length === 0) {
        throw new Error('qqbot_speak: 洗掉代码块和链接后没有可朗读的内容');
      }
      if (spoken.length > speak.maxChars) {
        throw new Error(
          `qqbot_speak: 文本 ${spoken.length} 字超过上限 ${speak.maxChars} 字（QQ 语音单条上限 20MB，约 4～5 分钟），请精简后再念`,
        );
      }

      const deliveryStyle = validateStyle(style);
      const caller = exec.agent === undefined ? undefined : manager.findByAgent(exec.agent as DshAgent);
      let normalizedExplicitRole: string | undefined;
      if (role !== undefined) {
        if (typeof role !== 'string' || !EXPLICIT_ROLE_RE.test(role.trim())) {
          throw new Error('qqbot_speak: `role` 必须是非空字母/数字/下划线/短横线标识');
        }
        const trimmedRole = role.trim();
        if (strictConfiguredRoles) {
          const matchedRole = configuredRoles.find((candidate) => candidate.toLowerCase() === trimmedRole.toLowerCase());
          if (matchedRole === undefined) {
            throw new Error(`qqbot_speak: \`role\` 只接受 ${configuredRoles.join('、')}`);
          }
          normalizedExplicitRole = matchedRole;
        } else {
          normalizedExplicitRole = trimmedRole;
        }
        if (caller !== undefined) {
          throw new Error('qqbot_speak: QQ 会话的音色由当前人设决定，请省略 `role`');
        }
      }

      // 1. 解析发送目标：显式 target > 当前会话；音色不随发送目标变化。
      let replyTarget: ReplyTarget | undefined;
      if (target !== undefined && target !== '') {
        replyTarget = parseTarget(target);
        if (replyTarget === undefined) {
          throw new Error(`qqbot_speak: target 格式错误，需要 c2c:openid 或 group:openid，收到: ${target}`);
        }
      } else {
        replyTarget = caller?.replyTarget;
      }
      if (replyTarget === undefined) {
        throw new Error('qqbot_speak: 无法确定发送目标，请显式传 target 参数');
      }
      replyTarget = withFreshReplyTarget(replyTarget);

      // 2. 合成：在线 TTS（ElevenLabs / DeepSeek 按角色候选序）→ 本地 VoxCPM2/GSV → edge-tts；主动取消直接中止
      exec.signal.throwIfAborted();
      const useVoice = (typeof voice === 'string' && voice.trim() !== '') ? voice.trim() : speak.voice;
      const useRate = typeof rate === 'string' ? rate : speak.rate;
      const langHint = typeof lang === 'string' ? lang : undefined;
      const personaId = caller === undefined
        ? undefined
        : manager.personaStore?.currentId(caller.peerId, caller.scope);
      const personaVoiceId = caller === undefined
        ? undefined
        : (!personaId || personaId === 'default'
          ? manager.personaStore?.defaultPersona?.(caller.scope)?.voiceId
          : manager.personaStore?.current?.(caller.peerId, caller.scope)?.voiceId);

      await mkdir(outDir, { recursive: true });
      const outPath = join(outDir, `say-${randomUUID()}.mp3`);
      let backend = 'edge-tts';
      let voiceLabel = useVoice;

      const onlineCandidates = resolveOnlineCandidates(elevenlabsConfig, deepseekConfig, {
        isQqCaller: caller !== undefined,
        personaId,
        personaVoiceId,
        explicitRole: normalizedExplicitRole,
      });
      for (const candidate of onlineCandidates) {
        try {
          if (candidate.provider === 'elevenlabs') {
            const el = elevenlabsConfig!;
            const keyRef = el.apiKeyEnv?.trim() || 'ELEVENLABS_API_KEY';
            const apiKey = await resolveSpeakApiKey(ctx, el.apiKey, keyRef, envFiles);
            if (!apiKey) {
              throw new Error(`缺少 API Key（未配置 speak.elevenlabs.apiKey、凭证或 ${keyRef}）`);
            }
            await synthesizeElevenLabs(el, apiKey, candidate.voiceId, spoken, outPath, langHint, exec.signal);
          } else {
            const ds = deepseekConfig!;
            const keyRef = ds.apiKeyEnv?.trim() || 'DEEPSEEK_API_KEY';
            const apiKey = await resolveSpeakApiKey(ctx, ds.apiKey, keyRef, envFiles);
            if (!apiKey) {
              throw new Error(`缺少 API Key（未配置 speak.deepseek.apiKey、凭证或 ${keyRef}）`);
            }
            await synthesizeDeepSeek(ds, apiKey, candidate.voiceId, spoken, outPath, exec.signal);
          }
          backend = candidate.provider;
          voiceLabel = candidate.label;
          break;
        } catch (err) {
          if (exec.signal.aborted) throw err;
          const providerLabel = candidate.provider === 'elevenlabs' ? 'ElevenLabs' : 'DeepSeek TTS';
          logger.warn(`im-qqbot: qqbot_speak ${providerLabel} 合成失败，尝试降级: ${(err as Error).message}`);
        }
      }

      const onlineSucceeded = backend === 'elevenlabs' || backend === 'deepseek';
      if (!onlineSucceeded && (speak.gsvUrl ?? '').trim() !== '') {
        try {
          const qqPersonaRole = personaId?.trim();
          const localRole = caller === undefined
            ? normalizedExplicitRole
            : (qqPersonaRole !== undefined && qqPersonaRole !== '' && qqPersonaRole.toLowerCase() !== 'default'
              ? qqPersonaRole
              : undefined);
          await synthesizeLocal(speak, spoken, outPath, {
            lang: langHint,
            role: localRole,
            style: deliveryStyle,
          }, exec.signal);
          backend = 'local';
          voiceLabel = '本地嗓子';
        } catch (err) {
          if (exec.signal.aborted) throw err;
          logger.warn(`im-qqbot: qqbot_speak 本地语音服务不可用，退回 edge-tts: ${(err as Error).message}`);
        }
      }
      if (!onlineSucceeded && backend !== 'local') {
        await synthesize(speak, spoken, useVoice, useRate, outPath, logger, exec.signal);
      }
      exec.signal.throwIfAborted();
      const info = await stat(outPath);
      if (info.size > MAX_QQ_VOICE_BYTES) {
        await rm(outPath, { force: true });
        throw new Error(
          `qqbot_speak: 生成的音频体积 ${(info.size / (1024 * 1024)).toFixed(1)}MB 超过 QQ 语音 20MB 上限，请缩短文本后再试`,
        );
      }

      // 3. 发送
      exec.signal.throwIfAborted();
      const result = await bot.sendVoice(replyTarget, { localPath: outPath });
      logger.info(
        `im-qqbot: qqbot_speak 合成并发送 ${spoken.length} 字（${voiceLabel}/${backend}`
        + `${langHint !== undefined ? `/${langHint}` : ''}，${info.size} bytes）`
        + ` → ${replyTarget.scope}:${replyTarget.targetId}`,
      );
      try {
        options?.onSent?.(replyTarget, spoken, result);
      } catch (err) {
        logger.warn(`im-qqbot: qqbot_speak 发送后回调失败: ${err instanceof Error ? err.message : String(err)}`);
      }

      return {
        voice: voiceLabel,
        backend,
        chars: spoken.length,
        fileSize: info.size,
        target: `${replyTarget.scope}:${replyTarget.targetId}`,
        fileUuid: result.upload.file_uuid,
        ...(result.message?.id !== undefined ? { messageId: result.message.id } : {}),
      };
    },
  };

  const activeBackends = [
    ...(elevenlabsConfig?.enabled ? ['ElevenLabs'] : []),
    ...(deepseekConfig?.enabled ? ['DeepSeek'] : []),
  ];
  tools.register(definition);
  logger.info(
    `im-qqbot: qqbot_speak 工具已注册（音色 ${speak.voice}${activeBackends.length > 0 ? `，在线=${activeBackends.join('+')}` : ''}）`,
  );
}
