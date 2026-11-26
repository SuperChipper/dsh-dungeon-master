import { createElement, Fragment, type ReactNode } from 'react';
import type { ElevenLabsOutputFormat, ImageGenComplexity, ImageGenQuality } from '../../config.ts';
import { AreaRow, FieldRow, ListRow, NumberRow, SelectRow, SwitchRow } from './controls.ts';
import {
  DEEPSEEK_SPEAK_WIRE_DEFAULTS,
  ELEVENLABS_SPEAK_WIRE_DEFAULTS,
  parseRoleVoices,
  type AsrFallbackWire,
  type AsrWire,
  type ConfigWire,
  type ImageGenWire,
  type MediaWire,
  type PatchFn,
  type SendFileWire,
  type SpeakWire,
  type VideoWire,
  type VisionWire,
} from './types.ts';

export function MediaConfigSections({
  form,
  patch,
  extraRoleVoicesText,
  setExtraRoleVoicesText,
  extraDsRoleVoicesText,
  setExtraDsRoleVoicesText,
}: {
  form: ConfigWire;
  patch: PatchFn;
  extraRoleVoicesText: string;
  setExtraRoleVoicesText: (raw: string) => void;
  extraDsRoleVoicesText: string;
  setExtraDsRoleVoicesText: (raw: string) => void;
}): ReactNode {
  const media: MediaWire = form.media ?? { enabled: true, maxMB: 200, ttlHours: 24, maxTotalMB: 1024 };
  const vision: VisionWire = form.vision ?? {
    enabled: false, native: false, provider: '', model: '',
    defaultPrompt: 'Describe this image in detail.', maxBytes: 10 * 1024 * 1024, maxTokens: 1024, timeoutMs: 120000,
  };
  const asr: AsrWire = {
    enabled: false,
    mode: 'chat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: '',
    model: 'Qwen/Qwen3-ASR-1.7B',
    chatBaseUrl: '',
    chatModel: '',
    chatApiKeyEnv: '',
    chatReasoningEffort: 'none',
    preferQQ: true,
    timeoutMs: 30000,
    ...form.asr,
  };
  // 旧配置没有 fallback 组时按默认值显示
  const asrFallback: AsrFallbackWire = {
    enabled: false,
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: '',
    model: 'FunAudioLLM/SenseVoiceSmall',
    timeoutMs: 30000,
    ...asr.fallback,
  };
  const video: VideoWire = {
    enabled: true,
    ffmpegPath: '',
    maxFrames: 8,
    maxSeconds: 300,
    directEnabled: true,
    baseUrl: '',
    model: '',
    apiKeyEnv: '',
    reasoningEffort: '',
    ...form.video,
  };
  const imageGen: ImageGenWire = {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-image-2.6-sunburst',
    standardModel: 'gpt-image-2.6',
    defaultQuality: 'auto',
    defaultSize: '1024x1024',
    defaultComplexity: '',
    timeoutMs: 180000,
    allowAllGroups: false,
    allowedGroups: [],
    ...form.imageGen,
  };
  const sendFile: SendFileWire = form.sendFile ?? { restrictPaths: true, extraRoots: [] };
  const speak: SpeakWire = {
    enabled: true, voice: 'zh-CN-XiaoyiNeural', rate: '+8%', maxChars: 1500, command: '', gsvUrl: '', gsvSpeed: 1.0,
    ...form.speak,
    elevenlabs: {
      ...ELEVENLABS_SPEAK_WIRE_DEFAULTS,
      ...form.speak?.elevenlabs,
      roleVoices: { ...(form.speak?.elevenlabs?.roleVoices ?? {}) },
    },
    deepseek: {
      ...DEEPSEEK_SPEAK_WIRE_DEFAULTS,
      ...form.speak?.deepseek,
      roleVoices: { ...(form.speak?.deepseek?.roleVoices ?? {}) },
    },
  };
  const elevenlabs = speak.elevenlabs!;
  const isElevenV4 = /^eleven_v4/i.test((elevenlabs.modelId || 'eleven_v4').trim());
  const deepseek = speak.deepseek!;

  return createElement(Fragment, null,
    createElement('div', { className: 'imqb2-group-title' }, '图片与媒体'),
    createElement(SwitchRow, {
      label: '启用富媒体理解', checked: media.enabled,
      help: '下载聊天里的图片/视频并交给模型或工具分析；关闭后只保留文本',
      onChange: (v) => { patch('media', { ...media, enabled: v }); },
    }),
    createElement(NumberRow, {
      label: '单个媒体大小上限（MB）', value: media.maxMB, min: 1, max: 2048, step: 10,
      help: '超过上限的图片/视频不下载',
      onChange: (v) => { patch('media', { ...media, maxMB: v }); },
    }),
    createElement(NumberRow, {
      label: '媒体保留时长（小时）', value: media.ttlHours, min: 0, max: 720, step: 1,
      help: '超过后自动清理；0 = 永不清理',
      onChange: (v) => { patch('media', { ...media, ttlHours: v }); },
    }),
    createElement(NumberRow, {
      label: '媒体目录总量上限（MB）', value: media.maxTotalMB, min: 0, max: 102400, step: 128,
      help: '超出时从最旧的开始删；0 = 不限',
      onChange: (v) => { patch('media', { ...media, maxTotalMB: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '视觉理解'),
    createElement(SwitchRow, {
      label: '启用视觉理解', checked: vision.enabled,
      help: '注册 qqbot_describe_image；关闭后不能识图（原生看图另见下一项）',
      onChange: (v) => { patch('vision', { ...vision, enabled: v }); },
    }),
    createElement(SwitchRow, {
      label: '把图片直接交给主模型', checked: vision.native,
      help: '主模型路由必须声明支持 image 输入，否则会报错',
      onChange: (v) => { patch('vision', { ...vision, native: v }); },
    }),
    createElement(FieldRow, {
      label: '视觉模型 Provider', value: vision.provider, placeholder: '如 deepseek-vision',
      onChange: (v) => { patch('vision', { ...vision, provider: v }); },
    }),
    createElement(FieldRow, {
      label: '视觉模型 Model', value: vision.model, placeholder: '如 deepseek-v4-flash',
      onChange: (v) => { patch('vision', { ...vision, model: v }); },
    }),
    createElement(AreaRow, {
      label: '默认描述 prompt', value: vision.defaultPrompt, rows: 2,
      onChange: (v) => { patch('vision', { ...vision, defaultPrompt: v }); },
    }),
    createElement(NumberRow, {
      label: '图片字节上限', value: vision.maxBytes, min: 1024, max: 104857600, step: 1048576,
      onChange: (v) => { patch('vision', { ...vision, maxBytes: v }); },
    }),
    createElement(NumberRow, {
      label: '输出 token 上限', value: vision.maxTokens, min: 64, max: 32768, step: 64,
      onChange: (v) => { patch('vision', { ...vision, maxTokens: v }); },
    }),
    createElement(NumberRow, {
      label: '视觉调用超时（毫秒）', value: vision.timeoutMs, min: 10000, max: 600000, step: 5000,
      onChange: (v) => { patch('vision', { ...vision, timeoutMs: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '视频理解'),
    createElement(SwitchRow, {
      label: '启用视频理解', checked: video.enabled,
      help: '注册 qqbot_describe_video：长片按时间分段，视频直传失败才抽帧；音轨逐段转写，需要视觉模型和 ffmpeg',
      onChange: (v) => { patch('video', { ...video, enabled: v }); },
    }),
    createElement(SwitchRow, {
      label: '优先整段视频直传网关', checked: video.directEnabled !== false,
      help: '开启时先压缩整段视频直传多模态网关，失败或关闭后仅走抽帧宫格 + 视觉模型',
      onChange: (v) => { patch('video', { ...video, directEnabled: v }); },
    }),
    video.directEnabled !== false ? createElement(FieldRow, {
      label: '视频直传网关地址', value: video.baseUrl ?? '',
      placeholder: '留空 = QQBOT_VIDEO_BASE_URL 或跟随 chat 转写网关',
      onChange: (v) => { patch('video', { ...video, baseUrl: v.trim() }); },
    }) : null,
    video.directEnabled !== false ? createElement(FieldRow, {
      label: '视频直传模型', value: video.model ?? '',
      placeholder: '留空 = QQBOT_VIDEO_MODEL 或跟随 chat 转写模型',
      onChange: (v) => { patch('video', { ...video, model: v.trim() }); },
    }) : null,
    video.directEnabled !== false ? createElement(FieldRow, {
      label: '视频直传凭证环境变量', value: video.apiKeyEnv ?? '',
      placeholder: '留空 = QQBOT_VIDEO_KEY_REF 或跟随 chat 凭证',
      help: '支持 credentials 凭证名或环境变量名；直填密钥仅可在 cordis.patch.yml 中配置',
      onChange: (v) => { patch('video', { ...video, apiKeyEnv: v.trim() }); },
    }) : null,
    video.directEnabled !== false ? createElement(FieldRow, {
      label: '视频直传思考档位 (reasoning_effort)', value: video.reasoningEffort ?? '',
      placeholder: '留空 = 跟随 chat 转写（默认 none）；填 omit 不传',
      onChange: (v) => { patch('video', { ...video, reasoningEffort: v.trim() }); },
    }) : null,
    createElement(FieldRow, {
      label: 'ffmpeg 路径', value: video.ffmpegPath, placeholder: '留空 = PATH 里的 ffmpeg',
      help: '路径里有空格也直接填；ffprobe 取同目录',
      onChange: (v) => { patch('video', { ...video, ffmpegPath: v }); },
    }),
    createElement(NumberRow, {
      label: '每段最多抽帧数', value: video.maxFrames, min: 1, max: 24, step: 1,
      onChange: (v) => { patch('video', { ...video, maxFrames: v }); },
    }),
    createElement(NumberRow, {
      label: '每段最多秒数（封顶300）', value: video.maxSeconds, min: 10, max: 300, step: 10,
      onChange: (v) => { patch('video', { ...video, maxSeconds: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '语音识别'),
    createElement(SwitchRow, {
      label: '启用在线语音识别', checked: asr.enabled,
      help: 'QQ 没给识别文本时，把语音与视频音轨转成文字（qqbot_transcribe 同步跟随这里的协议与网关）',
      onChange: (v) => { patch('asr', { ...asr, enabled: v }); },
    }),
    createElement(SelectRow, {
      label: '转写协议', value: asr.mode,
      options: [
        { value: 'chat', label: '多模态对话网关（chat）' },
        { value: 'openai', label: '音频接口（openai）' },
      ],
      help: 'chat 走 /chat/completions + input_audio；openai 走 /audio/transcriptions（兼容 Whisper / SiliconFlow / Groq）',
      onChange: (v) => { patch('asr', { ...asr, mode: v }); },
    }),
    asr.mode === 'chat' ? createElement(FieldRow, {
      label: 'chat 转写网关地址', value: asr.chatBaseUrl ?? '',
      placeholder: '留空 = QQBOT_TRANSCRIBE_BASE_URL',
      onChange: (v) => { patch('asr', { ...asr, chatBaseUrl: v.trim() }); },
    }) : null,
    asr.mode === 'chat' ? createElement(FieldRow, {
      label: 'chat 转写模型', value: asr.chatModel ?? '',
      placeholder: '留空 = QQBOT_TRANSCRIBE_MODEL',
      onChange: (v) => { patch('asr', { ...asr, chatModel: v.trim() }); },
    }) : null,
    asr.mode === 'chat' ? createElement(FieldRow, {
      label: 'chat 转写凭证环境变量', value: asr.chatApiKeyEnv ?? '',
      placeholder: '留空 = QQBOT_TRANSCRIBE_KEY_REF',
      help: '支持 credentials 凭证名或环境变量名；直填密钥仅可在 cordis.patch.yml 中配置',
      onChange: (v) => { patch('asr', { ...asr, chatApiKeyEnv: v.trim() }); },
    }) : null,
    asr.mode === 'chat' ? createElement(FieldRow, {
      label: 'chat 转写思考档位 (reasoning_effort)', value: asr.chatReasoningEffort ?? 'none',
      placeholder: 'none（防思考耗尽 token）；填 omit 表示不传该字段',
      onChange: (v) => { patch('asr', { ...asr, chatReasoningEffort: v.trim() }); },
    }) : null,
    asr.mode === 'openai' ? createElement(FieldRow, {
      label: '接口地址', value: asr.baseUrl, placeholder: 'https://api.siliconflow.cn/v1',
      onChange: (v) => { patch('asr', { ...asr, baseUrl: v }); },
    }) : null,
    asr.mode === 'openai' ? createElement(FieldRow, {
      label: '转写模型', value: asr.model, placeholder: 'Qwen/Qwen3-ASR-1.7B',
      onChange: (v) => { patch('asr', { ...asr, model: v }); },
    }) : null,
    asr.mode === 'openai' ? createElement(FieldRow, {
      label: '接口密钥环境变量', value: asr.apiKeyEnv ?? '',
      placeholder: '留空 = QQBOT_ASR_API_KEY',
      help: '支持 credentials 凭证名或环境变量名；免鉴权本机 Whisper 留空即可',
      onChange: (v) => { patch('asr', { ...asr, apiKeyEnv: v.trim() }); },
    }) : null,
    createElement(SwitchRow, {
      label: '优先用 QQ 自带识别文本', checked: asr.preferQQ,
      onChange: (v) => { patch('asr', { ...asr, preferQQ: v }); },
    }),
    createElement(NumberRow, {
      label: '转写超时（毫秒）', value: asr.timeoutMs, min: 5000, max: 120000, step: 5000,
      onChange: (v) => { patch('asr', { ...asr, timeoutMs: v }); },
    }),
    createElement(SwitchRow, {
      label: '主接口连不上时改用备用接口', checked: asrFallback.enabled,
      help: '如本机 whisper 优先、在线服务兜底；只在连不上或服务端 5xx 时切换',
      onChange: (v) => { patch('asr', { ...asr, fallback: { ...asrFallback, enabled: v } }); },
    }),
    createElement(FieldRow, {
      label: '备用接口地址', value: asrFallback.baseUrl, placeholder: 'https://api.siliconflow.cn/v1',
      onChange: (v) => { patch('asr', { ...asr, fallback: { ...asrFallback, baseUrl: v } }); },
    }),
    createElement(FieldRow, {
      label: '备用转写模型', value: asrFallback.model, placeholder: 'FunAudioLLM/SenseVoiceSmall',
      onChange: (v) => { patch('asr', { ...asr, fallback: { ...asrFallback, model: v } }); },
    }),
    createElement(FieldRow, {
      label: '备用接口密钥环境变量', value: asrFallback.apiKeyEnv ?? '',
      placeholder: '留空 = QQBOT_ASR_FALLBACK_API_KEY 或 QQBOT_ASR_API_KEY',
      onChange: (v) => { patch('asr', { ...asr, fallback: { ...asrFallback, apiKeyEnv: v.trim() } }); },
    }),
    createElement(NumberRow, {
      label: '备用接口超时（毫秒）', value: asrFallback.timeoutMs, min: 5000, max: 120000, step: 5000,
      onChange: (v) => { patch('asr', { ...asr, fallback: { ...asrFallback, timeoutMs: v } }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '图片生成 (GPT Image)'),
    createElement(SwitchRow, {
      label: '启用 qqbot_image_gen 生图工具', checked: imageGen.enabled,
      help: '对接 OpenAI Images API（支持文生图与 1~16 张参考图编辑），默认存盘返回路径并支持直接发图',
      onChange: (v) => { patch('imageGen', { ...imageGen, enabled: v }); },
    }),
    ...(imageGen.enabled ? [
      createElement(FieldRow, {
        label: 'Images API 网关地址', value: imageGen.baseUrl, placeholder: 'https://api.openai.com/v1',
        onChange: (v) => { patch('imageGen', { ...imageGen, baseUrl: v.trim() }); },
      }),
      createElement(FieldRow, {
        label: 'API Key 环境变量 / 凭证名', value: imageGen.apiKeyEnv, placeholder: 'OPENAI_API_KEY',
        help: '优先读取 patch 中的 imageGen.apiKey，留空时读取该 credentials 凭证或环境变量',
        onChange: (v) => { patch('imageGen', { ...imageGen, apiKeyEnv: v.trim() }); },
      }),
      createElement(FieldRow, {
        label: '默认精细模型 (sunburst)', value: imageGen.model, placeholder: 'gpt-image-2.6-sunburst',
        onChange: (v) => { patch('imageGen', { ...imageGen, model: v.trim() }); },
      }),
      createElement(FieldRow, {
        label: '标准/快速模型 (variant=standard)', value: imageGen.standardModel, placeholder: 'gpt-image-2.6',
        help: '可填 gpt-image-2.6 或 gpt-image-2.6-flare，用于草图、批量出图或降本场景',
        onChange: (v) => { patch('imageGen', { ...imageGen, standardModel: v.trim() }); },
      }),
      createElement(SelectRow, {
        label: '默认画质 (quality)', value: imageGen.defaultQuality,
        options: [
          { value: 'auto', label: 'auto（模型自动）' },
          { value: 'low', label: 'low（最快）' },
          { value: 'medium', label: 'medium' },
          { value: 'high', label: 'high' },
          { value: 'xhigh', label: 'xhigh（2.6 高清）' },
          { value: 'max', label: 'max（2.6 最高）' },
        ],
        onChange: (v) => { patch('imageGen', { ...imageGen, defaultQuality: v as ImageGenQuality }); },
      }),
      createElement(FieldRow, {
        label: '默认尺寸 (size)', value: imageGen.defaultSize, placeholder: '1024x1024',
        help: '支持 auto 或 256..3840 内的 16 倍数 WIDTHxHEIGHT（如 1024x1024 / 1536x1024 / 1024x1536）',
        onChange: (v) => { patch('imageGen', { ...imageGen, defaultSize: v.trim() }); },
      }),
      createElement(SelectRow, {
        label: '默认复杂度 (2.6 complexity)', value: imageGen.defaultComplexity,
        options: [
          { value: '', label: '留空（不传该参数）' },
          { value: 'low', label: 'low' },
          { value: 'medium', label: 'medium' },
          { value: 'high', label: 'high' },
        ],
        onChange: (v) => { patch('imageGen', { ...imageGen, defaultComplexity: v as ImageGenComplexity }); },
      }),
      createElement(NumberRow, {
        label: '请求超时（毫秒）', value: imageGen.timeoutMs, min: 5000, max: 600000, step: 5000,
        onChange: (v) => { patch('imageGen', { ...imageGen, timeoutMs: v }); },
      }),
      createElement(SwitchRow, {
        label: '允许全部群聊调用生图', checked: imageGen.allowAllGroups,
        help: '关闭时仅主人私聊、完全工具权限会话与下方白名单群可调用（防群友刷爆额度）',
        onChange: (v) => { patch('imageGen', { ...imageGen, allowAllGroups: v }); },
      }),
      !imageGen.allowAllGroups ? createElement(ListRow, {
        label: '允许生图的群 group_openid', value: imageGen.allowedGroups, rows: 2,
        help: '每行一个群 openid。群内可用 qqbot_access(capability="image_gen") 申请，主人在本群点击同意后写入；这不会授予浏览器或终端权限。移出此名单不影响已有的完全工具权限。',
        onChange: (v) => { patch('imageGen', { ...imageGen, allowedGroups: v }); },
      }) : null,
    ] : []),

    createElement('div', { className: 'imqb2-group-title' }, '文件发送'),
    createElement(SwitchRow, {
      label: '启用路径白名单', checked: sendFile.restrictPaths,
      help: '只允许 media、工作目录和额外目录里的文件；关闭后任意路径都能发',
      onChange: (v) => { patch('sendFile', { ...sendFile, restrictPaths: v }); },
    }),
    createElement(ListRow, {
      label: '额外允许的根目录', help: '每行一个绝对路径', value: sendFile.extraRoots, rows: 2,
      onChange: (v) => { patch('sendFile', { ...sendFile, extraRoots: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '语音合成'),
    createElement(SwitchRow, {
      label: '启用 qqbot_speak', checked: speak.enabled,
      help: '让 bot 用自己的声音说一两句；依赖本机的 edge-tts（pip install edge-tts）',
      onChange: (v) => { patch('speak', { ...speak, enabled: v }); },
    }),
    createElement(FieldRow, {
      label: '音色', value: speak.voice, placeholder: 'zh-CN-XiaoyiNeural',
      help: 'edge-tts 音色名，如 zh-CN-XiaoyiNeural、zh-CN-XiaoxiaoNeural',
      onChange: (v) => { patch('speak', { ...speak, voice: v.trim() }); },
    }),
    createElement(FieldRow, {
      label: '语速', value: speak.rate, placeholder: '+8%',
      help: '带符号的百分比，如 +8% / -5%；留空用引擎默认',
      onChange: (v) => { patch('speak', { ...speak, rate: v.trim() }); },
    }),
    createElement(NumberRow, {
      label: '单条字数上限', value: speak.maxChars, min: 10, max: 5000, step: 50,
      help: '默认 1500 字（约 4～5 分钟）；QQ 语音单条上限 20MB，超过字数上限会被拒绝',
      onChange: (v) => { patch('speak', { ...speak, maxChars: v }); },
    }),
    createElement(FieldRow, {
      label: 'edge-tts 命令', value: speak.command, placeholder: '留空 = 自动探测',
      help: '填可执行文件路径，比如 conda 里的 Scripts\\edge-tts.exe',
      onChange: (v) => { patch('speak', { ...speak, command: v.trim() }); },
    }),
    createElement(FieldRow, {
      label: '本地语音服务', value: speak.gsvUrl, placeholder: 'http://127.0.0.1:8765（留空 = edge-tts）',
      help: '填了优先用本机 GPT-SoVITS 服务发声，服务没起来会自动退回 edge-tts',
      onChange: (v) => { patch('speak', { ...speak, gsvUrl: v.trim() }); },
    }),
    createElement(NumberRow, {
      label: '本地服务语速', value: speak.gsvSpeed, min: 0.5, max: 2, step: 0.01,
      help: '倍率，1 = 原速；和上面 edge-tts 的百分比语速互不影响',
      onChange: (v) => { patch('speak', { ...speak, gsvSpeed: v }); },
    }),
    createElement(SwitchRow, {
      label: '启用 ElevenLabs 在线 TTS', checked: elevenlabs.enabled,
      help: '启用后优先按当前人设对应音色走 ElevenLabs API，失败或未绑定的角色自动回退本地服务与 edge-tts',
      onChange: (v) => { patch('speak', { ...speak, elevenlabs: { ...elevenlabs, enabled: v } }); },
    }),
    ...(elevenlabs.enabled ? [
      createElement(FieldRow, {
        label: 'ElevenLabs API 地址', value: elevenlabs.baseUrl, placeholder: 'https://api.elevenlabs.io/v1',
        onChange: (v) => { patch('speak', { ...speak, elevenlabs: { ...elevenlabs, baseUrl: v.trim() } }); },
      }),
      createElement(FieldRow, {
        label: 'ElevenLabs 凭证 / 环境变量名', value: elevenlabs.apiKeyEnv, placeholder: 'ELEVENLABS_API_KEY',
        help: '优先读取 patch 中的 speak.elevenlabs.apiKey，留空时读取凭证服务、环境变量或插件 .env.local',
        onChange: (v) => { patch('speak', { ...speak, elevenlabs: { ...elevenlabs, apiKeyEnv: v.trim() } }); },
      }),
      createElement(FieldRow, {
        label: 'ElevenLabs 模型 ID', value: elevenlabs.modelId, placeholder: 'eleven_v4',
        help: '常用：eleven_v4（默认，不使用 Style / Speaker Boost）、eleven_v4_turbo、eleven_v3、eleven_multilingual_v2、eleven_flash_v2_5',
        onChange: (v) => { patch('speak', { ...speak, elevenlabs: { ...elevenlabs, modelId: v.trim() } }); },
      }),
      createElement(SelectRow, {
        label: 'MP3 输出格式', value: elevenlabs.outputFormat,
        options: [
          { value: 'mp3_44100_128', label: 'mp3_44100_128（默认 128kbps）' },
          { value: 'mp3_44100_192', label: 'mp3_44100_192（192kbps）' },
          { value: 'mp3_44100_64', label: 'mp3_44100_64（64kbps）' },
          { value: 'mp3_22050_32', label: 'mp3_22050_32（32kbps）' },
        ],
        onChange: (v) => { patch('speak', { ...speak, elevenlabs: { ...elevenlabs, outputFormat: v as ElevenLabsOutputFormat } }); },
      }),
      createElement(FieldRow, {
        label: '默认兜底 Voice ID', value: elevenlabs.defaultVoiceId, placeholder: '留空 = 未映射人设直接回退本地/edge-tts',
        onChange: (v) => { patch('speak', { ...speak, elevenlabs: { ...elevenlabs, defaultVoiceId: v.trim() } }); },
      }),
      createElement(AreaRow, {
        label: '人设音色映射',
        value: extraRoleVoicesText,
        placeholder: 'persona-a=<your-voice-id>\npersona-b=<your-voice-id>',
        rows: 3,
        help: '每行一条 personaId=voiceId（请填写你自己 ElevenLabs 账号下的 voice_id；也可写到人设 .md 的 voiceId 头字段）',
        onChange: (raw) => {
          setExtraRoleVoicesText(raw);
          patch('speak', { ...speak, elevenlabs: { ...elevenlabs, roleVoices: parseRoleVoices(raw) } });
        },
      }),
      createElement(NumberRow, {
        label: 'ElevenLabs 语速', value: elevenlabs.speed, min: 0.7, max: 1.2, step: 0.05,
        help: '0.7 ~ 1.2（1.0 = 原速）',
        onChange: (v) => { patch('speak', { ...speak, elevenlabs: { ...elevenlabs, speed: v } }); },
      }),
      createElement(NumberRow, {
        label: 'Stability（稳定性）', value: elevenlabs.stability, min: 0, max: 1, step: 0.05,
        onChange: (v) => { patch('speak', { ...speak, elevenlabs: { ...elevenlabs, stability: v } }); },
      }),
      createElement(NumberRow, {
        label: 'Similarity Boost（相似度）', value: elevenlabs.similarityBoost, min: 0, max: 1, step: 0.05,
        onChange: (v) => { patch('speak', { ...speak, elevenlabs: { ...elevenlabs, similarityBoost: v } }); },
      }),
      ...(!isElevenV4 ? [
        createElement(NumberRow, {
          label: 'Style（风格夸张度）', value: elevenlabs.styleExaggeration, min: 0, max: 1, step: 0.05,
          onChange: (v) => { patch('speak', { ...speak, elevenlabs: { ...elevenlabs, styleExaggeration: v } }); },
        }),
        createElement(SwitchRow, {
          label: 'Speaker Boost（说话人增强）', checked: elevenlabs.useSpeakerBoost,
          onChange: (v) => { patch('speak', { ...speak, elevenlabs: { ...elevenlabs, useSpeakerBoost: v } }); },
        }),
      ] : []),
      createElement(NumberRow, {
        label: 'ElevenLabs 请求超时（毫秒）', value: elevenlabs.timeoutMs, min: 3000, max: 600000, step: 1000,
        onChange: (v) => { patch('speak', { ...speak, elevenlabs: { ...elevenlabs, timeoutMs: v } }); },
      }),
    ] : []),
    createElement(SwitchRow, {
      label: '启用 DeepSeek 在线 TTS', checked: deepseek.enabled,
      help: '支持官方海星 (stella) / 暗潮 (tide) 音色，复用 DEEPSEEK_API_KEY；可与 ElevenLabs 分角色同时启用',
      onChange: (v) => { patch('speak', { ...speak, deepseek: { ...deepseek, enabled: v } }); },
    }),
    ...(deepseek.enabled ? [
      createElement(FieldRow, {
        label: 'DeepSeek API 地址', value: deepseek.baseUrl, placeholder: 'https://api.deepseek.com/v1',
        onChange: (v) => { patch('speak', { ...speak, deepseek: { ...deepseek, baseUrl: v.trim() } }); },
      }),
      createElement(FieldRow, {
        label: 'DeepSeek 凭证 / 环境变量名', value: deepseek.apiKeyEnv, placeholder: 'DEEPSEEK_API_KEY',
        help: '优先读取 patch 中的 speak.deepseek.apiKey，留空时读取凭证服务、环境变量或 ~/.dsh/.env',
        onChange: (v) => { patch('speak', { ...speak, deepseek: { ...deepseek, apiKeyEnv: v.trim() } }); },
      }),
      createElement(FieldRow, {
        label: 'DeepSeek 默认兜底音色', value: deepseek.defaultVoiceId, placeholder: '留空 = 仅显式匹配人设时走 DeepSeek',
        onChange: (v) => { patch('speak', { ...speak, deepseek: { ...deepseek, defaultVoiceId: v.trim() } }); },
      }),
      createElement(AreaRow, {
        label: 'DeepSeek 人设音色映射',
        value: extraDsRoleVoicesText,
        placeholder: 'persona-a=stella\npersona-b=tide',
        rows: 3,
        help: '每行一条 personaId=voiceId（如内置 stella / tide 或你自己的音色 ID）',
        onChange: (raw) => {
          setExtraDsRoleVoicesText(raw);
          patch('speak', { ...speak, deepseek: { ...deepseek, roleVoices: parseRoleVoices(raw) } });
        },
      }),
      createElement(NumberRow, {
        label: 'DeepSeek 语速', value: deepseek.speed, min: 0.5, max: 2, step: 0.05,
        help: '倍率，1 = 原速；非 1.0 时在转码阶段调整',
        onChange: (v) => { patch('speak', { ...speak, deepseek: { ...deepseek, speed: v } }); },
      }),
      createElement(NumberRow, {
        label: 'DeepSeek 请求超时（毫秒）', value: deepseek.timeoutMs, min: 3000, max: 600000, step: 1000,
        onChange: (v) => { patch('speak', { ...speak, deepseek: { ...deepseek, timeoutMs: v } }); },
      }),
    ] : []),
  );
}
