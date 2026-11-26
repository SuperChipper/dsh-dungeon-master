/**
 * dsh-im-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';
import {
  GROUP_TRIGGER_MODES,
  resolveGroupTriggerMode,
  resolveGroupTriggerPolicy,
  type GroupTriggerConfigLike,
  type GroupTriggerMode,
  type GroupTriggerPolicy,
} from './features/group-trigger.ts';

export {
  GROUP_TRIGGER_MODES,
  resolveGroupTriggerMode,
  resolveGroupTriggerPolicy,
  type GroupTriggerConfigLike,
  type GroupTriggerMode,
  type GroupTriggerPolicy,
};

export interface AccessControlConfig {
  /** C2C 访问模式 */
  c2cMode: 'open' | 'allowlist' | 'disabled';
  /** C2C 白名单（user openid） */
  c2cAllow: string[];
  /** 群聊访问模式 */
  groupMode: 'open' | 'allowlist' | 'disabled';
  /** 群聊白名单（group openid） */
  groupAllow: string[];
}

export interface MediaConfig {
  /** 是否启用富媒体理解（图片/视频下载 + 工具分析） */
  enabled: boolean;
  /** 富媒体下载大小上限（MB），默认 200 */
  maxMB: number;
  /** 富媒体存活时长（小时，TTL），默认 24，0 = 永不过期 */
  ttlHours: number;
  /** media 目录总量上限（MB），超出时从最旧的删，默认 1024，0 = 不限 */
  maxTotalMB?: number;
}

/** 用户自定义清理规则 */
export interface CleanupRuleConfig {
  /** 规则名（日志 / 报告用，空 = 用 dir） */
  name: string;
  /** 目录（相对路径按 cwd 解析；必须位于 cwd / 插件目录 / 系统临时目录之内） */
  dir: string;
  /** file = 每个文件单独判断；entry = 每个顶层条目整体判断（取子树最新 mtime） */
  unit: 'file' | 'entry';
  /** 超过多少小时未改动就删除（0 = 不按时间删） */
  ttlHours: number;
  /** unit=file 时是否进入子目录 */
  recursive: boolean;
  /** 永不删除的文件/条目名（支持 * ?） */
  keep: string[];
  /** 非空时只处理命中的文件/条目名 */
  match: string[];
  /** 总量上限（MB），超出从最旧的删（0 = 不限） */
  maxTotalMB: number;
}

export interface CleanupConfig {
  /** 只记日志不删除（先看看会删什么） */
  dryRun: boolean;
  /** 额外的清理规则（media / tmp / 视频工作目录是内置规则） */
  rules: CleanupRuleConfig[];
}

export interface VisionConfig {
  /** 是否启用视觉理解（qqbot_describe_image 工具） */
  enabled: boolean;
  /** 是否把图片作为原生 ImageBlock 直接交给主模型（主模型路由必须声明 image 输入） */
  native: boolean;
  /** 视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai） */
  provider: string;
  /** 视觉模型 id（如 qwen-vl-max） */
  model: string;
  /** 默认描述 prompt（调用未显式指定时使用） */
  defaultPrompt: string;
  /** 图片字节上限，默认 10MB */
  maxBytes: number;
  /** 输出 token 上限 */
  maxTokens: number;
  /** 视觉调用超时(ms) */
  timeoutMs: number;
}

export interface VideoConfig {
  /** 是否注册 qqbot_describe_video（需 vision 已配置 + ffmpeg 可用） */
  enabled: boolean;
  /** ffmpeg 可执行文件（空 = PATH 里的 ffmpeg；ffprobe 取同目录） */
  ffmpegPath: string;
  /** 每个片段降级抽帧时的最大帧数 */
  maxFrames: number;
  /** 每段最多分析秒数；最长300秒，长片自动逐段处理 */
  maxSeconds: number;
  /** 是否优先尝试整段视频直传多模态网关（关闭则只走抽帧宫格 + 视觉模型） */
  directEnabled?: boolean;
  /** 整段视频直传网关地址（空 = QQBOT_VIDEO_BASE_URL 或跟随 chat 转写网关） */
  baseUrl?: string;
  /** 整段视频直传模型 id（空 = QQBOT_VIDEO_MODEL 或跟随 chat 转写模型） */
  model?: string;
  /** 整段视频直传凭证环境变量名（空 = QQBOT_VIDEO_KEY_REF 或跟随 chat 转写凭证） */
  apiKeyEnv?: string;
  /** 整段视频直填密钥（优先于环境变量，不上表单回显） */
  apiKey?: string;
  /** 视频直传 reasoning_effort（空 = 跟随 chat 转写；填 omit 表示不传该字段） */
  reasoningEffort?: string;
}

/** 语音识别的两种协议 */
export type AsrMode =
  /** POST {baseUrl}/chat/completions + input_audio：能吃订阅制网关（默认 opencode-go 的 mimo），也可自定义兼容网关 */
  | 'chat'
  /** POST {baseUrl}/audio/transcriptions（multipart）：任何 OpenAI 兼容 ASR 服务 */
  | 'openai';

export interface AsrConfig {
  /** 是否启用在线语音识别（QQ 未给出识别文本时转写语音） */
  enabled: boolean;
  /**
   * 走哪种协议。`chat` 时优先读下面的 `chat*` 配置，留空退回 `QQBOT_TRANSCRIBE_*` 环境变量与默认网关；
   * `openai` 时走 `/audio/transcriptions`。`fallback` 始终按 openai 协议走。
   */
  mode: AsrMode;
  /** OpenAI 兼容接口地址（POST {baseUrl}/audio/transcriptions） */
  baseUrl: string;
  /** 接口密钥（空 = 按 apiKeyEnv 或 QQBOT_ASR_API_KEY 读取环境变量） */
  apiKey: string;
  /** OpenAI 兼容接口密钥环境变量名（空 = QQBOT_ASR_API_KEY） */
  apiKeyEnv?: string;
  /** 转写模型 id（如 FunAudioLLM/SenseVoiceSmall、whisper-large-v3） */
  model: string;
  /** chat 转写网关地址（空 = QQBOT_TRANSCRIBE_BASE_URL 或默认网关） */
  chatBaseUrl?: string;
  /** chat 转写模型 id（空 = QQBOT_TRANSCRIBE_MODEL 或默认模型） */
  chatModel?: string;
  /** chat 转写凭证名/环境变量（空 = QQBOT_TRANSCRIBE_KEY_REF 或 OPENCODE_GO_API_KEY） */
  chatApiKeyEnv?: string;
  /** chat 转写直填密钥（优先于环境变量，不上表单回显） */
  chatApiKey?: string;
  /** chat 转写 reasoning_effort（默认 none 防思考耗尽 token；填 omit 表示不传该字段） */
  chatReasoningEffort?: string;
  /** QQ 自带 asr_refer_text 存在时优先使用，不再调用接口 */
  preferQQ: boolean;
  /** 转写调用超时(ms) */
  timeoutMs: number;
  /** 主接口连不上或 5xx 时改用的备用接口（如本机 whisper 优先、在线服务兜底）；旧配置没有这一组 */
  fallback?: AsrFallbackConfig;
}

/** 语音识别备用接口 */
export interface AsrFallbackConfig {
  enabled: boolean;
  /** OpenAI 兼容接口地址（POST {baseUrl}/audio/transcriptions） */
  baseUrl: string;
  /** 接口密钥（空 = 按 apiKeyEnv 或 QQBOT_ASR_API_KEY 读取环境变量） */
  apiKey: string;
  /** 兜底接口密钥环境变量名（空 = QQBOT_ASR_FALLBACK_API_KEY 或 QQBOT_ASR_API_KEY） */
  apiKeyEnv?: string;
  model: string;
  timeoutMs: number;
}

export const IMAGE_GEN_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ImageGenQuality = (typeof IMAGE_GEN_QUALITIES)[number];

export const IMAGE_GEN_COMPLEXITIES = ['', 'low', 'medium', 'high'] as const;
export type ImageGenComplexity = (typeof IMAGE_GEN_COMPLEXITIES)[number];

/** OpenAI GPT Image 生图与参考图编辑配置 */
export interface ImageGenConfig {
  /** 是否启用 qqbot_image_gen 工具 */
  enabled: boolean;
  /** OpenAI Images API 网关地址（默认 https://api.openai.com/v1） */
  baseUrl: string;
  /** 直填密钥（优先于环境变量，不上表单回显） */
  apiKey: string;
  /** 密钥环境变量或 credentials 凭证名（默认 OPENAI_API_KEY） */
  apiKeyEnv: string;
  /** 默认精细/编辑模型（默认 gpt-image-2.6-sunburst） */
  model: string;
  /** 标准/快速模型（variant=standard 时使用，默认 gpt-image-2.6） */
  standardModel: string;
  /** 默认画质 */
  defaultQuality: ImageGenQuality;
  /** 默认尺寸（auto 或 16 倍数 WIDTHxHEIGHT） */
  defaultSize: string;
  /** Images 2.6 complexity 参数（空 = 不传该字段） */
  defaultComplexity: ImageGenComplexity;
  /** 请求超时(ms) */
  timeoutMs: number;
  /** 是否允许全部群聊调用生图 */
  allowAllGroups: boolean;
  /** 允许调用生图的群 group_openid 列表 */
  allowedGroups: string[];
}

export interface SendFileConfig {
  /** 是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots；关闭则任意路径） */
  restrictPaths: boolean;
  /** 额外允许访问的根目录（media 和 agent cwd 始终默认允许） */
  extraRoots: string[];
}

export const ELEVENLABS_OUTPUT_FORMATS = [
  'mp3_44100_128',
  'mp3_44100_192',
  'mp3_44100_64',
  'mp3_22050_32',
] as const;
export type ElevenLabsOutputFormat = (typeof ELEVENLABS_OUTPUT_FORMATS)[number];

/** ElevenLabs 在线 TTS 配置 */
export interface ElevenLabsSpeakConfig {
  /** 是否优先使用 ElevenLabs 在线 TTS（失败或未配好时自动回退本地服务 / edge-tts） */
  enabled: boolean;
  /** ElevenLabs API 根地址（默认 https://api.elevenlabs.io/v1） */
  baseUrl: string;
  /** 直填 API Key（优先于凭证/环境变量，不上表单回显） */
  apiKey: string;
  /** API Key 凭证名或环境变量名（默认 ELEVENLABS_API_KEY） */
  apiKeyEnv: string;
  /** 语音合成模型 ID（默认 eleven_v4） */
  modelId: string;
  /** 输出音频格式（需 MP3 以便直接作为 QQ 语音发送） */
  outputFormat: ElevenLabsOutputFormat;
  /** 默认兜底 voice_id（当人设未单独映射时使用） */
  defaultVoiceId: string;
  /** 人设 ID 到 ElevenLabs voice_id 的映射（如 persona-a -> <voice_id>） */
  roleVoices: Record<string, string>;
  /** 语速倍率（0.7 ~ 1.2，1.0 = 原速） */
  speed: number;
  /** 语音稳定性（0 ~ 1） */
  stability: number;
  /** 音色相似度增强（0 ~ 1） */
  similarityBoost: number;
  /** 说话风格夸张度（0 ~ 1） */
  styleExaggeration: number;
  /** 是否开启说话人增强（use_speaker_boost） */
  useSpeakerBoost: boolean;
  /** 请求超时（ms） */
  timeoutMs: number;
}

/** DeepSeek 在线 TTS 配置（/v1/tools/tts，stella=海星 / tide=暗潮） */
export interface DeepSeekSpeakConfig {
  /** 是否启用 DeepSeek 在线 TTS（按角色/人设映射路由，失败时自动回退本地服务 / edge-tts） */
  enabled: boolean;
  /** DeepSeek API 根地址（默认 https://api.deepseek.com/v1） */
  baseUrl: string;
  /** 直填 API Key（优先于凭证/环境变量，不上表单回显） */
  apiKey: string;
  /** API Key 凭证名或环境变量名（默认 DEEPSEEK_API_KEY） */
  apiKeyEnv: string;
  /** 默认兜底 voice_id（如 stella / tide；留空则仅按 roleVoices 命中时走 DeepSeek） */
  defaultVoiceId: string;
  /** 人设 ID 到 DeepSeek voice_id 的映射（如 persona-a -> stella） */
  roleVoices: Record<string, string>;
  /** 语速倍率（0.5 ~ 2.0，1.0 = 原速，非 1.0 时用 ffmpeg atempo 调整） */
  speed: number;
  /** 请求超时（ms） */
  timeoutMs: number;
}

export interface SpeakConfig {
  /** 是否注册 qqbot_speak 语音合成工具 */
  enabled: boolean;
  /** edge-tts 音色名（ms neural voice） */
  voice: string;
  /** 语速调整，如 +8% / -5% */
  rate: string;
  /** 单条语音最多合成多少字（QQ 语音单条上限 20MB，1500 字约 4～5 分钟） */
  maxChars: number;
  /** edge-tts 可执行命令；空 = 依次尝试 edge-tts / python -m edge_tts / py -m edge_tts */
  command: string;
  /**
   * 本地 GPT-SoVITS 服务地址（如 http://127.0.0.1:8765）；空 = 只用 edge-tts。
   * 填了就先走本地服务，那边比 edge-tts 更像「有情绪的嗓子」，失败再退回 edge-tts。
   */
  gsvUrl: string;
  /** GPT-SoVITS 语速倍率，1.0 = 原速（edge-tts 的 rate 是百分比，两者不通用） */
  gsvSpeed: number;
  /** ElevenLabs 在线 TTS 配置（可选；启用后优先走 ElevenLabs） */
  elevenlabs?: ElevenLabsSpeakConfig;
  /** DeepSeek 在线 TTS 配置（可选；支持海星 stella / 暗潮 tide） */
  deepseek?: DeepSeekSpeakConfig;
}

export interface FileAccessConfig {
  /** 敏感路径（拦截名单）：受限会话禁止访问/发送这些目录下的文件；白名单会话有终端，不拦 */
  sensitivePaths: string[];
}

/** 上游监测与主备切换 */
export interface ModelFailoverConfig {
  /** 启用上游状态监测 */
  enabled: boolean;
  /** 轮询间隔（分钟） */
  intervalMinutes: number;
  /** 连续几次异常才切换 */
  failThreshold: number;
  /** 连续几次正常才切回 */
  recoverThreshold: number;
  /** 主用 provider（空=跟随当前配置） */
  primaryProvider: string;
  /** 主用模型 id */
  primaryModel: string;
  /** 主用探测用的凭据环境变量（状态接口方式不需要） */
  primaryApiKeyEnv: string;
  /** 备用 provider */
  backupProvider: string;
  /** 备用模型 id */
  backupModel: string;
  /** 备用探测用的凭据环境变量 */
  backupApiKeyEnv: string;
  /** 首 token 时延阈值（毫秒），超过判降级 */
  ttftThresholdMs: number;
  /** 切换时是否在群里说一句 */
  notify: boolean;
}

export interface ToolAccessConfig {
  /** 是否按会话限制工具（关闭 = 所有 QQ 会话都能用终端、读任意路径） */
  enabled: boolean;
  /** 能用终端、读写任意路径的群 openid（主人私聊始终可以） */
  fullAccessGroups: string[];
  /** 除主人外，私聊里能用终端、读写任意路径的 openid */
  fullAccessUsers: string[];
  /** 受限会话额外允许文件工具访问的目录（media、表情库、临时目录始终允许） */
  readRoots: string[];
}

export interface StickersConfig {
  /** 是否启用表情自动收藏（工具 + 动态表情清单） */
  enabled: boolean;
  /** 表情包目录；空字符串表示插件根目录下的 stickers/ */
  root: string;
  /** 除 media 目录外，额外允许作为收藏来源的根目录 */
  extraRoots: string[];
  /** 单张表情文件大小上限（字节） */
  maxBytes: number;
  /** 自动收藏条目上限（防止索引无限增长） */
  maxAutoEntries: number;
}

export interface PersonasConfig {
  /** 人设目录（.md）；空 = 优先插件根目录/personas（含 .md 时），否则 ~/.dsh-qqbot/personas；相对路径按工作目录解析 */
  root: string;
}

export interface BiliConfig {
  /** 是否注册 qqbot_bili / qqbot_bili_auth B 站只读工具 */
  enabled: boolean;
}

export interface SingConfig {
  /** 是否注册 qqbot_sing 点歌工具（对接外部唱歌 HTTP 服务） */
  enabled: boolean;
  /** 唱歌服务地址（空 = QQBOT_SING_URL 或 http://127.0.0.1:8766） */
  baseUrl: string;
}

export interface ReverseImageConfig {
  /** 是否注册 qqbot_reverse_image 以图搜图工具 */
  enabled: boolean;
}

export interface FanartConfig {
  /** 是否注册 qqbot_fanart 搜图工具 */
  enabled: boolean;
  /** 访问 pixiv / safebooru 的 HTTP 代理（空 = 环境变量 HTTPS_PROXY，再退到 Windows 系统代理） */
  proxy: string;
  /** 标签池目录（pixiv-tags.json / fanart-tags.json）；空 = 插件根目录下的 scripts/ */
  poolDir: string;
}

export interface DndCombatAgentConfig {
  enabled: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
  /** 每场新子会话继承的最近对话字数，不复制整个主会话 */
  contextChars: number;
}

export interface DndConfig {
  /** 是否启用跑团（/dnd 命令 + dnd_* 工具） */
  enabled: boolean;
  /** 跑团数据目录（campaigns/、自定义 dungeons/ 与 adventures/）；空 = 工作目录下的 dnd/ */
  root: string;
  /** 轮到 PC 时发「结束回合 / 查看状态」按钮（需要机器人有消息按钮权限） */
  turnButtons: boolean;
  /** 跑团期间也按 groupReplyProbability 随机插嘴（只吐槽、不结算）；false = 开团后只回 @ */
  interjections: boolean;
  /** 团况快照按对话轮数节流间隔（默认 4 = 每 4 轮对话同步一次完整团况，单轮内工具循环始终零重发；设为 1 则每轮对话最多同步 1 次） */
  snapshotIntervalTurns?: number;
  combatAgent: DndCombatAgentConfig;
}

export interface ReplyJudgeConfig {
  /** 规则拿不准的文字消息交给模型打分（规则已放行 / 已拦下的不调模型） */
  enabled: boolean;
  /** 打分用的 provider；空 = 跟这个群的主模型一样 */
  provider: string;
  /** 打分用的模型；空 = 跟这个群的主模型一样 */
  model: string;
  /** 推理档位 id；空 = 自动选这个模型支持的最低档 */
  reasoningEffort: string;
  /** 群里安静多久(ms)才打一次分：连续几条只给最后一条打分 */
  debounceMs: number;
  /** 群里一直有人说话时，最多攒多久(ms)也要打一次分 */
  maxWaitMs: number;
  /** 给模型看的最近群消息条数 */
  contextMessages: number;
  /** 单次打分超时(ms)，超时按不接处理 */
  timeoutMs: number;
}

export interface ReplyDesireConfig {
  /** 群聊未 @ 时按回复欲望打分决定是否接话（替代纯随机插嘴）；关闭 = 只回 @ 与随机插嘴 */
  enabled: boolean;
  /** 放行阈值（0-1），越高越安静 */
  threshold: number;
  /** bot 的昵称/别名：群里点名这些词视为在叫 bot */
  names: string[];
  /** 对话窗口(ms)：bot 回复后这段时间内，刚聊过的人再说话更容易被接 */
  engagedMs: number;
  /** 对话窗口内最多靠打分连续接几轮（不含 @），到了就退出窗口，0 = 不进入对话窗口 */
  engagedMaxTurns: number;
  /** 模型打分 */
  judge: ReplyJudgeConfig;
}

/** 笔记语义检索（向量相似度，作为 RRF 第三路） */
export interface NotesSemanticConfig {
  /** 是否启用；关闭时只用 BM25 + 字面精确匹配 */
  enabled: boolean;
  /** OpenAI 兼容接口地址（POST {baseUrl}/embeddings） */
  baseUrl: string;
  /** 接口密钥（空 = 环境变量 QQBOT_EMBEDDING_API_KEY） */
  apiKey: string;
  /** 向量模型 id */
  model: string;
  /** 绝对下限：余弦相似度低于它的段一律不进语义榜（0-1） */
  minSimilarity: number;
  /** 相对门槛：要高出本次查询对全库相似度的中位数这么多才进语义榜/自动注入 */
  minMargin: number;
  /** 查询向量请求超时(ms)：超时这条消息就不走语义一路 */
  timeoutMs: number;
}

/**
 * 笔记注入的相关性打分：回复结束后让模型评这轮注入的笔记和用户消息相不相关。
 * 模型不单独配：用接话打分（replyDesire.judge）的 provider/model，那边没填就用会话的主模型。
 */
export interface NoteJudgeConfig {
  /** 是否打分；关闭时账本只记注入次数 */
  enabled: boolean;
  /** 单次打分超时(ms) */
  timeoutMs: number;
  /** 抽样比例（0-1）：1 = 每轮注入都评 */
  sampleRate: number;
  /** 一段笔记至少评过几次才可能被静音 */
  minSamples: number;
  /** 平均相关分（0-1）低于它就停止自动注入这一段；0 = 只打分不静音 */
  muteBelow: number;
}

export interface NotesConfig {
  /** 是否启用共享笔记库（检索/记录工具 + 自动召回） */
  enabled: boolean;
  /** 笔记目录；空字符串表示 agent 工作目录（cwd）下的 notes/ */
  root: string;
  /** 是否在每条消息前自动注入相关笔记片段 */
  autoInject: boolean;
  /** 自动注入的最多片段数 */
  injectTopK: number;
  /** 自动注入的总字数上限 */
  injectMaxChars: number;
  /** 单段自动注入的字数上限（0 = 不单独限制，在总预算内按需分配） */
  injectPerNoteChars?: number;
  /** 群聊自动注入的总字数上限（0 = 与 injectMaxChars 相同） */
  groupInjectMaxChars?: number;
  /** 自动注入的最低查询词覆盖率（0-1），越高越保守 */
  injectMinCoverage: number;
  /** 语义检索 */
  semantic: NotesSemanticConfig;
  /** 注入相关性打分 */
  judge: NoteJudgeConfig;
}

export interface ImQQBotConfig {
  /** QQ Bot AppID */
  appId: string;
  /** QQ Bot AppSecret */
  appSecret: string;
  /** dsh LLM 提供商名称 */
  provider?: string;
  /** 模型名称 */
  model?: string;
  /** Agent preset id */
  preset?: string;
  /** Agent 工作目录（缺省回落到进程 cwd） */
  cwd?: string;
  /** Agent 临时目录（空 = cwd/tmp）：脚本、截图、抽帧、下载等中间文件统一放这里 */
  tmpDir: string;
  /** 临时目录里多少小时没改动的条目自动清理（0 = 不清理） */
  tmpTtlHours: number;
  /** 临时目录总量上限（MB），超出时从最旧的条目删（0 = 不限） */
  tmpMaxTotalMB?: number;
  /** 定期清理（内置 media / tmp 规则之外的额外目录） */
  cleanup?: CleanupConfig;
  /** 群聊触发门控模式：mention=仅@回复，probability=随机概率，desire=回复欲望打分，all=全部回复 */
  groupTriggerMode?: GroupTriggerMode;
  /** @deprecated 已被 `groupTriggerMode` 取代，仅作历史配置兼容读取 */
  requireMention: boolean;
  /** 群聊未 @bot 时随机回复概率（0-1），0=关闭 */
  groupReplyProbability?: number;
  /** 群聊回复欲望门控（规则打分 + 对话窗口） */
  replyDesire: ReplyDesireConfig;
  /** @deprecated 已被外置人设目录（`personas/default.group.md`）取代，仅作兼容兜底与 `/bot-doctor` 迁移提醒 */
  groupPrompt?: string;
  /** @deprecated 已被外置人设目录（`personas/default.direct.md`）取代，仅作兼容兜底与 `/bot-doctor` 迁移提醒 */
  directPrompt?: string;
  /** 群聊默认 provider（留空=跟随全局 provider） */
  groupProvider?: string;
  /** 群聊默认模型（留空=跟随全局 model） */
  groupModel?: string;
  /** 单条消息最大长度（QQ 限制约 5000 字符） */
  textChunkLimit: number;
  /** 是否启用流式输出（群聊始终不启用） */
  streaming: boolean;
  /** 每会话最大闲置时长(ms)，超时自动回收 */
  sessionIdleTimeout: number;
  /** 并发队列最大长度 */
  maxQueue: number;
  /** 短时间窗口(ms)内显式 @bot（及私聊连发）自动打断当前思考并 steer 追加；0=关闭 */
  steerWindowMs?: number;
  /** 处理超时(ms)，超时中断当前 LLM 调用 */
  processingTimeoutMs: number;
  /** 待答问题超时(ms)，超时自动拒绝并提示（ask_user_question） */
  askTimeoutMs: number;
  /** 群历史缓冲条数 */
  historyLimit: number;
  /** QQ 会话上下文超过这么多 token 时，在轮次结束后自动压缩（0=关闭，交给 dsh 默认阈值） */
  autoCompactTokens: number;
  /** 私聊自动压缩阈值 = 模型上下文窗口 × 该比例（不低于 autoCompactTokens；0=私聊也用固定阈值） */
  autoCompactPrivateRatio: number;
  /** 上一轮调用过工具（多步任务进行中）时推迟自动压缩，直到收尾轮或阈值 1.5 倍 */
  autoCompactDeferOnTools: boolean;
  /** 会话空闲这么多分钟后压缩一次（需小于 sessionIdleTimeout，否则会话先被回收）；0=关闭 */
  idleCompactMinutes: number;
  /** 空闲压缩的上下文下限：低于这么多 token 不压 */
  idleCompactTokens: number;
  /** 空闲压缩生效的 provider 或模型规则（逗号分隔，支持 provider、provider/model 或 model:<通配>；空=全部） */
  idleCompactProviders: string;
  /** 访问控制 */
  access: AccessControlConfig;
  /** 是否展示工具调用成功结果（工具错误始终展示） */
  showToolResults: boolean;
  /** 调试模式 */
  debug: boolean;
  /** 富媒体理解（图片/视频） */
  media: MediaConfig;
  /** 视觉理解（qqbot_describe_image 工具，走 dsh llm + attachments） */
  vision: VisionConfig;
  /** 在线语音识别（OpenAI 兼容 /audio/transcriptions） */
  asr: AsrConfig;
  /** 视频理解（qqbot_describe_video：抽帧宫格 + 音轨 ASR） */
  video: VideoConfig;
  /** 附件发送（qqbot_send_file 工具） */
  sendFile: SendFileConfig;
  /** 语音合成（qqbot_speak 工具） */
  speak: SpeakConfig;
  /** 生图与参考图编辑（qqbot_image_gen 工具） */
  imageGen: ImageGenConfig;
  /** bot 主人 QQ openid（私聊识别，用于文件访问白名单） */
  ownerOpenid?: string;
  /** 额外的配置管理员 QQ openid（可修改模型/preset、点击审批） */
  adminOpenids: string[];
  /** 文件访问白名单 */
  fileAccess: FileAccessConfig;
  /** 工具权限：哪些会话能用终端、文件工具能碰哪些目录 */
  toolAccess: ToolAccessConfig;

  /** 上游状态监测与主备模型切换 */
  modelFailover: ModelFailoverConfig;
  /** 表情自动收藏（qqbot_save_sticker + 动态表情清单） */
  stickers: StickersConfig;
  /** 外置聊天人设目录（personas/*.md） */
  personas?: PersonasConfig;
  /** 共享笔记库（qqbot_notes_search / qqbot_notes_save + 自动召回） */
  notes: NotesConfig;
  /** B 站只读工具（qqbot_bili / qqbot_bili_auth，默认关闭） */
  bili?: BiliConfig;
  /** 外部唱歌服务工具（qqbot_sing，默认关闭） */
  sing?: SingConfig;
  /** 以图搜图工具（qqbot_reverse_image，默认关闭） */
  reverseImage?: ReverseImageConfig;
  /** 搜图工具（qqbot_fanart，默认关闭） */
  fanart: FanartConfig;
  /** 跑团（/dnd + dnd_* 工具） */
  dnd: DndConfig;
}

/** 清理规则子 Schema */
export const CleanupRuleSchema: Schema<CleanupRuleConfig> = Schema.object({
  name: Schema.string().default('').description('规则名（空=用目录）'),
  dir: Schema.string().default('').description('目录（相对路径按工作目录解析）'),
  unit: Schema.union(['file', 'entry']).default('file').description('file=逐个文件；entry=顶层条目整体'),
  ttlHours: Schema.number().default(72).description('多少小时未改动后删除（0=不按时间删）'),
  recursive: Schema.boolean().default(false).description('unit=file 时是否进入子目录'),
  keep: Schema.array(Schema.string()).default([]).description('永不删除的文件名（支持 * ?）'),
  match: Schema.array(Schema.string()).default([]).description('只处理这些文件名（空=全部）'),
  maxTotalMB: Schema.number().default(0).description('总量上限(MB)，0=不限'),
});

/** 清理配置子 Schema */
export const CleanupSchema: Schema<CleanupConfig> = Schema.object({
  dryRun: Schema.boolean().default(false).description('只记日志不删除'),
  rules: Schema.array(CleanupRuleSchema).default([]).description('额外的清理规则'),
});

/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema: Schema<AccessControlConfig> = Schema.object({
  c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式'),
  c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单'),
  groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式'),
  groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单'),
});

/** 工具权限子 Schema */
export const ToolAccessSchema: Schema<ToolAccessConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否按会话限制工具'),
  fullAccessGroups: Schema.array(Schema.string()).default([]).description('能用终端、读写任意路径的群 openid'),
  fullAccessUsers: Schema.array(Schema.string()).default([]).description('除主人外能用终端的私聊 openid'),
  readRoots: Schema.array(Schema.string()).default([]).description('受限会话额外允许访问的目录'),
});

/** 上游监测与主备切换子 Schema */
export const ModelFailoverSchema: Schema<ModelFailoverConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('启用上游状态监测'),
  intervalMinutes: Schema.number().default(10).description('轮询间隔（分钟）'),
  failThreshold: Schema.number().default(1).description('连续几次异常才切换'),
  recoverThreshold: Schema.number().default(3).description('连续几次正常才切回'),
  primaryProvider: Schema.string().default('').description('主用 provider（空=跟随当前配置）'),
  primaryModel: Schema.string().default('').description('主用模型 id'),
  primaryApiKeyEnv: Schema.string().default('').description('主用探测凭据的环境变量名（状态接口方式不需要）'),
  backupProvider: Schema.string().default('').description('备用 provider'),
  backupModel: Schema.string().default('').description('备用模型 id'),
  backupApiKeyEnv: Schema.string().default('').description('备用探测凭据的环境变量名'),
  ttftThresholdMs: Schema.number().default(8000).description('首 token 时延阈值（毫秒），超过判降级'),
  notify: Schema.boolean().default(true).description('切换时在群里说一句'),
});

/** 文件访问白名单子 Schema（独立导出：config 路由的服务端校验复用） */
export const FileAccessSchema: Schema<FileAccessConfig> = Schema.object({
  sensitivePaths: Schema.array(Schema.string()).default([]).description('敏感路径（拦截访问）'),
});

/** 表情自动收藏子 Schema */
export const StickersSchema: Schema<StickersConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用表情自动收藏'),
  root: Schema.string().default('').description('表情包目录（空=插件根目录/stickers）'),
  extraRoots: Schema.array(Schema.string()).default([]).description('额外允许的收藏来源目录'),
  maxBytes: Schema.number().default(8 * 1024 * 1024).description('单张表情大小上限（字节）'),
  maxAutoEntries: Schema.number().default(200).description('自动收藏条目上限'),
});

export const PERSONAS_DEFAULTS: PersonasConfig = { root: '' };

/** 外置聊天人设子 Schema */
export const PersonasSchema: Schema<PersonasConfig> = Schema.object({
  root: Schema.string().default('').description('人设目录（空=插件根目录/personas 或 ~/.dsh-qqbot/personas；相对路径按工作目录解析）'),
}).default(PERSONAS_DEFAULTS);

/** 笔记语义检索子 Schema */
export const NotesSemanticSchema: Schema<NotesSemanticConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('启用向量语义检索'),
  baseUrl: Schema.string().default('https://api.siliconflow.cn/v1').description('OpenAI 兼容接口地址（POST {baseUrl}/embeddings）'),
  apiKey: Schema.string().default('').description('接口密钥（空=环境变量 QQBOT_EMBEDDING_API_KEY）'),
  model: Schema.string().default('BAAI/bge-m3').description('向量模型'),
  minSimilarity: Schema.number().min(0).max(1).default(0.5).description('绝对下限：最低余弦相似度(0-1)'),
  minMargin: Schema.number().min(0).max(1).default(0.16).description('相对门槛：高出全库相似度中位数多少'),
  timeoutMs: Schema.number().min(500).max(30000).default(3000).description('查询向量超时(ms)'),
});

export const NOTE_JUDGE_DEFAULTS: NoteJudgeConfig = {
  enabled: false,
  timeoutMs: 15000,
  sampleRate: 1,
  minSamples: 8,
  muteBelow: 0,
};

/** 笔记注入相关性打分子 Schema */
export const NoteJudgeSchema: Schema<NoteJudgeConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('回复结束后让模型评这轮注入的笔记相不相关（模型同接话打分）'),
  timeoutMs: Schema.number().min(1000).max(120000).default(15000).description('单次打分超时(ms)'),
  sampleRate: Schema.number().min(0).max(1).default(1).description('抽样比例(0-1)，1=每轮都评'),
  minSamples: Schema.number().min(1).max(1000).default(8).description('至少评过几次才可能静音'),
  muteBelow: Schema.number().min(0).max(1).default(0).description('平均相关分低于它就停止自动注入(0-1)，0=只打分不静音'),
}).default(NOTE_JUDGE_DEFAULTS);

/** 共享笔记库子 Schema */
export const NotesSchema: Schema<NotesConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用共享笔记库'),
  root: Schema.string().default('').description('笔记目录（空=工作目录/notes）'),
  autoInject: Schema.boolean().default(true).description('是否自动在消息前注入相关笔记'),
  injectTopK: Schema.number().default(2).description('自动注入最多片段数'),
  injectMaxChars: Schema.number().default(600).description('自动注入总字数上限'),
  injectPerNoteChars: Schema.number().min(0).max(4000).default(0).description('单段自动注入字数上限（0=不单限，按总上限分配）'),
  groupInjectMaxChars: Schema.number().min(0).max(4000).default(0).description('群聊自动注入总字数上限（0=与总字数上限相同）'),
  injectMinCoverage: Schema.number().default(0.4).description('自动注入最低查询词覆盖率(0-1)'),
  semantic: NotesSemanticSchema.description('向量语义检索'),
  judge: NoteJudgeSchema.description('注入相关性打分'),
});

export const BiliSchema: Schema<BiliConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('是否注册 qqbot_bili / qqbot_bili_auth B 站只读工具'),
}).default({ enabled: false });

export const SingSchema: Schema<SingConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('是否注册 qqbot_sing 点歌工具'),
  baseUrl: Schema.string().default('').description('点歌服务 HTTP 地址（空=QQBOT_SING_URL 或 http://127.0.0.1:8766）'),
}).default({ enabled: false, baseUrl: '' });

export const ReverseImageSchema: Schema<ReverseImageConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('是否注册 qqbot_reverse_image 以图搜图工具'),
}).default({ enabled: false });

export const FanartSchema: Schema<FanartConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('是否启用 qqbot_fanart 搜图工具'),
  proxy: Schema.string().default('').description('pixiv/safebooru 用的 HTTP 代理（空=HTTPS_PROXY 或系统代理）'),
  poolDir: Schema.string().default('').description('标签池目录（空=插件根目录/scripts）'),
});

export const DND_COMBAT_AGENT_DEFAULTS: DndCombatAgentConfig = {
  enabled: false, provider: '', model: '', reasoningEffort: '', contextChars: 8000,
};

export const DndCombatAgentSchema: Schema<DndCombatAgentConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('使用独立战斗代理，战后交回主 DM'),
  provider: Schema.string().default('').description('战斗模型 Provider'),
  model: Schema.string().default('').description('战斗模型 ID'),
  reasoningEffort: Schema.string().default('').description('战斗推理强度（空=模型默认）'),
  contextChars: Schema.number().min(1000).max(30000).step(1).default(8000).description('开战交接的最近对话字数上限'),
});

export const DND_DEFAULT_SNAPSHOT_INTERVAL_TURNS = 4;

/** 跑团子 Schema */
export const DndSchema: Schema<DndConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用跑团（/dnd 命令与 dnd_* 工具）'),
  root: Schema.string().default('').description('跑团数据目录（空=工作目录/dnd）'),
  turnButtons: Schema.boolean().default(true).description('轮到玩家时发「结束回合 / 查看状态」按钮'),
  interjections: Schema.boolean().default(true).description('跑团期间也按插话概率随机吐槽（只吐槽、不结算行动）；关掉则开团后只回 @'),
  snapshotIntervalTurns: Schema.number().min(1).max(20).step(1).default(DND_DEFAULT_SNAPSHOT_INTERVAL_TURNS)
    .description('团况快照按对话轮数注入间隔（默认4=每4轮对话同步1次完整团况，单轮多次攻击/移动始终锁定零重发；1=每轮对话最多注入1次）'),
  combatAgent: DndCombatAgentSchema.default(DND_COMBAT_AGENT_DEFAULTS),
});

export const REPLY_JUDGE_DEFAULTS: ReplyJudgeConfig = {
  enabled: false,
  provider: '',
  model: '',
  reasoningEffort: '',
  debounceMs: 2500,
  maxWaitMs: 15000,
  contextMessages: 20,
  timeoutMs: 15000,
};

/** 模型打分子 Schema */
export const ReplyJudgeSchema: Schema<ReplyJudgeConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('规则拿不准的文字消息交给模型打分'),
  provider: Schema.string().default('').description('打分 provider（空=这个群的主模型）'),
  model: Schema.string().default('').description('打分模型（空=这个群的主模型）'),
  reasoningEffort: Schema.string().default('').description('推理档位 id（空=自动选最低档）'),
  debounceMs: Schema.number().min(0).max(60000).default(2500).description('群里安静多久(ms)才打一次分'),
  maxWaitMs: Schema.number().min(0).max(300000).default(15000).description('一直有人说话时最多攒多久(ms)也要打分'),
  contextMessages: Schema.number().min(1).max(100).default(20).description('给模型看的最近群消息条数'),
  timeoutMs: Schema.number().min(1000).max(120000).default(15000).description('单次打分超时(ms)'),
}).default(REPLY_JUDGE_DEFAULTS);

/** 回复欲望子 Schema */
export const ReplyDesireSchema: Schema<ReplyDesireConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('群聊未@时按回复欲望打分决定是否接话'),
  threshold: Schema.number().default(0.6).description('放行阈值(0-1)，越高越安静'),
  names: Schema.array(Schema.string()).default([]).description('bot 昵称/别名，群里提到即视为在叫 bot'),
  engagedMs: Schema.number().default(90000).description('对话窗口(ms)：bot 回复后刚聊过的人更容易被接话'),
  engagedMaxTurns: Schema.number().default(8).description('对话窗口内最多靠打分连续接几轮，0=不进入对话窗口'),
  judge: ReplyJudgeSchema.description('模型打分'),
});

/** 富媒体理解子 Schema（独立导出：config 面板的服务端校验复用） */
export const MediaSchema: Schema<MediaConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
  maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
  ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
  maxTotalMB: Schema.number().default(1024).description('media 目录总量上限(MB)，超出从最旧的删，0=不限'),
}).default({
  enabled: true,
  maxMB: 200,
  ttlHours: 24,
  maxTotalMB: 1024,
});

/** 视觉理解子 Schema */
export const VisionSchema: Schema<VisionConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('是否启用视觉理解（qqbot_describe_image 工具）'),
  native: Schema.boolean().default(false).description('是否把图片作为原生 ImageBlock 直接交给主模型（主模型路由需声明 image 输入）'),
  provider: Schema.string().default('').description('视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai）'),
  model: Schema.string().default('').description('视觉模型 id（如 qwen-vl-max）'),
  defaultPrompt: Schema.string().default('Describe this image in detail.').description('默认描述 prompt'),
  maxBytes: Schema.number().default(10 * 1024 * 1024).description('图片字节上限'),
  maxTokens: Schema.number().default(1024).description('输出 token 上限'),
  timeoutMs: Schema.number().default(120000).description('视觉调用超时(ms)'),
}).default({
  enabled: false,
  native: false,
  provider: '',
  model: '',
  defaultPrompt: 'Describe this image in detail.',
  maxBytes: 10 * 1024 * 1024,
  maxTokens: 1024,
  timeoutMs: 120000,
});

/** 语音识别子 Schema（apiKey 不随表单回传，服务端在写入时保留旧值） */
/** 语音识别备用接口子 Schema */
export const AsrFallbackSchema: Schema<AsrFallbackConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('主接口连不上时改用备用接口'),
  baseUrl: Schema.string().default('https://api.siliconflow.cn/v1').description('OpenAI 兼容接口地址'),
  apiKey: Schema.string().default('').description('接口密钥（空=按环境变量读取，不上表单回显）'),
  apiKeyEnv: Schema.string().default('').description('兜底接口密钥环境变量名（空=QQBOT_ASR_FALLBACK_API_KEY 或 QQBOT_ASR_API_KEY）'),
  model: Schema.string().default('Qwen/Qwen3-ASR-1.7B').description('转写模型 id'),
  timeoutMs: Schema.number().min(1000).max(300000).default(30000).description('转写调用超时(ms)'),
});

export const AsrSchema: Schema<AsrConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('是否启用在线语音识别（QQ 未给出识别文本时转写语音）'),
  mode: Schema.union([
    Schema.const('chat').description('chat/completions + input_audio（多模态对话网关）'),
    Schema.const('openai').description('POST {baseUrl}/audio/transcriptions（任何 OpenAI 兼容 ASR 服务）'),
  ]).default('chat').description('转写协议：chat 走下方 chat* 参数（空则退回 QQBOT_TRANSCRIBE_*）；openai 走 baseUrl/model'),
  baseUrl: Schema.string().default('https://api.siliconflow.cn/v1').description('OpenAI 兼容接口地址（POST {baseUrl}/audio/transcriptions）'),
  apiKey: Schema.string().default('').description('OpenAI 接口直填密钥（不上表单回显）'),
  apiKeyEnv: Schema.string().default('').description('OpenAI 兼容接口密钥环境变量名（空=QQBOT_ASR_API_KEY）'),
  model: Schema.string().default('Qwen/Qwen3-ASR-1.7B').description('OpenAI 转写模型 id'),
  chatBaseUrl: Schema.string().default('').description('chat 转写网关地址（空=读取环境变量 QQBOT_TRANSCRIBE_BASE_URL）'),
  chatModel: Schema.string().default('').description('chat 转写模型 id（空=读取环境变量 QQBOT_TRANSCRIBE_MODEL）'),
  chatApiKeyEnv: Schema.string().default('').description('chat 转写凭证名/环境变量（空=读取环境变量 QQBOT_TRANSCRIBE_KEY_REF）'),
  chatApiKey: Schema.string().default('').description('chat 转写直填密钥（优先于环境变量，不上表单回显）'),
  chatReasoningEffort: Schema.string().default('none').description('chat 转写 reasoning_effort（默认 none 防思考耗尽 token；填 omit 表示不传）'),
  preferQQ: Schema.boolean().default(true).description('QQ 自带识别文本存在时优先使用'),
  timeoutMs: Schema.number().default(30000).description('转写调用超时(ms)'),
  fallback: AsrFallbackSchema.description('备用接口：主接口连不上或 5xx 时改用'),
}).default({
  enabled: false,
  mode: 'chat',
  baseUrl: 'https://api.siliconflow.cn/v1',
  apiKey: '',
  apiKeyEnv: '',
  model: 'Qwen/Qwen3-ASR-1.7B',
  chatBaseUrl: '',
  chatModel: '',
  chatApiKeyEnv: '',
  chatApiKey: '',
  chatReasoningEffort: 'none',
  preferQQ: true,
  timeoutMs: 30000,
  fallback: {
    enabled: false,
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    apiKeyEnv: '',
    model: 'FunAudioLLM/SenseVoiceSmall',
    timeoutMs: 30000,
  },
});

/** 视频理解子 Schema */
export const VideoSchema: Schema<VideoConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否注册 qqbot_describe_video（需 vision 已配置 + ffmpeg 可用）'),
  ffmpegPath: Schema.string().default('').description('ffmpeg 路径（空=PATH 里的 ffmpeg）'),
  maxFrames: Schema.number().default(8).description('每段降级抽帧时的最大帧数（拼成宫格图）'),
  maxSeconds: Schema.number().default(300).description('每段最多秒数（实际封顶300；长片逐段处理，每次最多24段/2小时）'),
  directEnabled: Schema.boolean().default(true).description('优先尝试整段视频直传多模态网关（关闭则只走抽帧宫格 + 视觉模型）'),
  baseUrl: Schema.string().default('').description('整段视频直传网关地址（空=QQBOT_VIDEO_BASE_URL 或跟随 chat 转写网关）'),
  model: Schema.string().default('').description('整段视频直传模型 id（空=QQBOT_VIDEO_MODEL 或跟随 chat 转写模型）'),
  apiKeyEnv: Schema.string().default('').description('整段视频直传凭证环境变量名（空=QQBOT_VIDEO_KEY_REF 或跟随 chat 转写凭证）'),
  apiKey: Schema.string().default('').description('整段视频直填密钥（优先于环境变量，不上表单回显）'),
  reasoningEffort: Schema.string().default('').description('视频直传 reasoning_effort（空=跟随 chat 转写；填 omit 表示不传）'),
}).default({
  enabled: true,
  ffmpegPath: '',
  maxFrames: 8,
  maxSeconds: 300,
  directEnabled: true,
  baseUrl: '',
  model: '',
  apiKeyEnv: '',
  apiKey: '',
  reasoningEffort: '',
});

export const IMAGE_GEN_DEFAULTS: ImageGenConfig = {
  enabled: false,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  apiKeyEnv: 'OPENAI_API_KEY',
  model: 'gpt-image-2.6-sunburst',
  standardModel: 'gpt-image-2.6',
  defaultQuality: 'auto',
  defaultSize: '1024x1024',
  defaultComplexity: '',
  timeoutMs: 180000,
  allowAllGroups: false,
  allowedGroups: [],
};

/** OpenAI GPT Image 生图与参考图编辑子 Schema */
export const ImageGenSchema: Schema<ImageGenConfig> = Schema.object({
  enabled: Schema.boolean().default(IMAGE_GEN_DEFAULTS.enabled).description('是否启用 qqbot_image_gen 生图与参考图编辑工具'),
  baseUrl: Schema.string().default(IMAGE_GEN_DEFAULTS.baseUrl).description('OpenAI Images API 网关地址（{baseUrl}/images/generations 与 /images/edits）'),
  apiKey: Schema.string().default(IMAGE_GEN_DEFAULTS.apiKey).description('直填 API Key（优先于环境变量，不上表单回显）'),
  apiKeyEnv: Schema.string().default(IMAGE_GEN_DEFAULTS.apiKeyEnv).description('API Key 环境变量或 credentials 凭证名'),
  model: Schema.string().default(IMAGE_GEN_DEFAULTS.model).description('默认精细/参考图编辑模型（如 gpt-image-2.6-sunburst）'),
  standardModel: Schema.string().default(IMAGE_GEN_DEFAULTS.standardModel).description('标准/快速版模型（variant=standard 时使用，如 gpt-image-2.6 或 gpt-image-2.6-flare）'),
  defaultQuality: Schema.union(IMAGE_GEN_QUALITIES.map((q) => Schema.const(q))).default(IMAGE_GEN_DEFAULTS.defaultQuality).description('默认画质'),
  defaultSize: Schema.string().default(IMAGE_GEN_DEFAULTS.defaultSize).description('默认尺寸（auto 或 16 倍数 WIDTHxHEIGHT，如 1024x1024）'),
  defaultComplexity: Schema.union(IMAGE_GEN_COMPLEXITIES.map((c) => Schema.const(c))).default(IMAGE_GEN_DEFAULTS.defaultComplexity).description('GPT Image 2.6 complexity 参数（空=不传）'),
  timeoutMs: Schema.number().min(5000).max(600000).step(1).default(IMAGE_GEN_DEFAULTS.timeoutMs).description('请求超时(ms)'),
  allowAllGroups: Schema.boolean().default(IMAGE_GEN_DEFAULTS.allowAllGroups).description('是否允许全部群聊调用生图（关闭时仅主人私聊、完全权限会话与白名单群可用）'),
  allowedGroups: Schema.array(Schema.string()).default(IMAGE_GEN_DEFAULTS.allowedGroups).description('生图白名单 group_openid；本群也可通过 qqbot_access(capability="image_gen") 申请，主人确认后写入，与浏览/终端授权分开'),
}).default(IMAGE_GEN_DEFAULTS);

/** 附件发送子 Schema */
export const SendFileSchema: Schema<SendFileConfig> = Schema.object({
  restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）'),
  extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录'),
}).default({
  restrictPaths: true,
  extraRoots: [],
});

export const ELEVENLABS_SPEAK_DEFAULTS: ElevenLabsSpeakConfig = {
  enabled: false,
  baseUrl: 'https://api.elevenlabs.io/v1',
  apiKey: '',
  apiKeyEnv: 'ELEVENLABS_API_KEY',
  modelId: 'eleven_v4',
  outputFormat: 'mp3_44100_128',
  defaultVoiceId: '',
  roleVoices: {},
  speed: 1.0,
  stability: 0.5,
  similarityBoost: 0.75,
  styleExaggeration: 0.0,
  useSpeakerBoost: true,
  timeoutMs: 180000,
};

export const ElevenLabsSpeakSchema: Schema<ElevenLabsSpeakConfig> = Schema.object({
  enabled: Schema.boolean().default(ELEVENLABS_SPEAK_DEFAULTS.enabled).description('是否优先使用 ElevenLabs 在线语音合成'),
  baseUrl: Schema.string().default(ELEVENLABS_SPEAK_DEFAULTS.baseUrl).description('ElevenLabs API 根地址'),
  apiKey: Schema.string().default(ELEVENLABS_SPEAK_DEFAULTS.apiKey).description('直填 API Key（不上表单回显）'),
  apiKeyEnv: Schema.string().default(ELEVENLABS_SPEAK_DEFAULTS.apiKeyEnv).description('API Key 凭证名或环境变量名'),
  modelId: Schema.string().default(ELEVENLABS_SPEAK_DEFAULTS.modelId).description('模型 ID（如 eleven_v4、eleven_v4_turbo、eleven_v3、eleven_multilingual_v2、eleven_flash_v2_5）'),
  outputFormat: Schema.union(ELEVENLABS_OUTPUT_FORMATS.map((fmt) => Schema.const(fmt))).default(ELEVENLABS_SPEAK_DEFAULTS.outputFormat).description('MP3 输出格式'),
  defaultVoiceId: Schema.string().default(ELEVENLABS_SPEAK_DEFAULTS.defaultVoiceId).description('默认兜底 voice_id'),
  roleVoices: Schema.dict(Schema.string()).default(ELEVENLABS_SPEAK_DEFAULTS.roleVoices).description('角色/人设到 voice_id 的映射'),
  speed: Schema.number().min(0.7).max(1.2).default(ELEVENLABS_SPEAK_DEFAULTS.speed).description('语速倍率（0.7-1.2）'),
  stability: Schema.number().min(0).max(1).default(ELEVENLABS_SPEAK_DEFAULTS.stability).description('stability（0-1）'),
  similarityBoost: Schema.number().min(0).max(1).default(ELEVENLABS_SPEAK_DEFAULTS.similarityBoost).description('similarity_boost（0-1）'),
  styleExaggeration: Schema.number().min(0).max(1).default(ELEVENLABS_SPEAK_DEFAULTS.styleExaggeration).description('style 风格强度（0-1）'),
  useSpeakerBoost: Schema.boolean().default(ELEVENLABS_SPEAK_DEFAULTS.useSpeakerBoost).description('是否开启 use_speaker_boost'),
  timeoutMs: Schema.number().min(3000).max(600000).step(1).default(ELEVENLABS_SPEAK_DEFAULTS.timeoutMs).description('请求超时（ms）'),
}).default(ELEVENLABS_SPEAK_DEFAULTS);

export const DEEPSEEK_SPEAK_DEFAULTS: DeepSeekSpeakConfig = {
  enabled: false,
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  defaultVoiceId: '',
  roleVoices: {},
  speed: 1.0,
  timeoutMs: 180000,
};

export const DeepSeekSpeakSchema: Schema<DeepSeekSpeakConfig> = Schema.object({
  enabled: Schema.boolean().default(DEEPSEEK_SPEAK_DEFAULTS.enabled).description('是否启用 DeepSeek 在线 TTS'),
  baseUrl: Schema.string().default(DEEPSEEK_SPEAK_DEFAULTS.baseUrl).description('DeepSeek API 根地址'),
  apiKey: Schema.string().default(DEEPSEEK_SPEAK_DEFAULTS.apiKey).description('直填 API Key（不上表单回显）'),
  apiKeyEnv: Schema.string().default(DEEPSEEK_SPEAK_DEFAULTS.apiKeyEnv).description('API Key 凭证名或环境变量名'),
  defaultVoiceId: Schema.string().default(DEEPSEEK_SPEAK_DEFAULTS.defaultVoiceId).description('默认兜底 voice_id（如 stella / tide）'),
  roleVoices: Schema.dict(Schema.string()).default(DEEPSEEK_SPEAK_DEFAULTS.roleVoices).description('角色/人设到 voice_id 的映射'),
  speed: Schema.number().min(0.5).max(2.0).default(DEEPSEEK_SPEAK_DEFAULTS.speed).description('语速倍率（0.5-2.0）'),
  timeoutMs: Schema.number().min(3000).max(600000).step(1).default(DEEPSEEK_SPEAK_DEFAULTS.timeoutMs).description('请求超时（ms）'),
}).default(DEEPSEEK_SPEAK_DEFAULTS);

export const SpeakSchema: Schema<SpeakConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否注册 qqbot_speak 语音合成工具'),
  voice: Schema.string().default('zh-CN-XiaoyiNeural').description('edge-tts 音色名'),
  rate: Schema.string().default('+8%').description('语速调整，如 +8% / -5%'),
  maxChars: Schema.number().min(10).max(5000).step(1).default(1500).description('单条语音字数上限（QQ 语音单条上限 20MB，1500 字约 4～5 分钟）'),
  command: Schema.string().default('').description('edge-tts 可执行命令（空=自动探测）'),
  gsvUrl: Schema.string().default('').description('本地 GPT-SoVITS 服务地址（空=edge-tts）'),
  gsvSpeed: Schema.number().default(1.0).description('GPT-SoVITS 语速倍率（1.0=原速）'),
  elevenlabs: ElevenLabsSpeakSchema.description('ElevenLabs 在线 TTS 配置（启用后优先使用）'),
  deepseek: DeepSeekSpeakSchema.description('DeepSeek 在线 TTS 配置（支持海星 stella 等音色）'),
}).default({
  enabled: true,
  voice: 'zh-CN-XiaoyiNeural',
  rate: '+8%',
  maxChars: 1500,
  command: '',
  gsvUrl: '',
  gsvSpeed: 1.0,
  elevenlabs: ELEVENLABS_SPEAK_DEFAULTS,
  deepseek: DEEPSEEK_SPEAK_DEFAULTS,
});

/** 群聊触发模式子 Schema（不设 default，缺省时兼容读取存量三开关） */
export const GroupTriggerModeSchema: Schema<GroupTriggerMode> = Schema.union([
  Schema.const('mention'),
  Schema.const('probability'),
  Schema.const('desire'),
  Schema.const('all'),
]);

export const ConfigSchema: Schema<ImQQBotConfig> = Schema.object({
  appId: Schema.string().default('').description('QQ 机器人 AppID'),
  appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
  provider: Schema.string().description('LLM provider name'),
  model: Schema.string().description('Model name'),
  preset: Schema.string().description('Agent preset id'),
  cwd: Schema.string().description('Agent working directory'),
  tmpDir: Schema.string().default('').description('Agent 临时目录（空=工作目录/tmp）'),
  tmpTtlHours: Schema.number().default(72).description('临时目录条目多少小时未改动后自动清理（0=不清理）'),
  tmpMaxTotalMB: Schema.number().default(4096).description('临时目录总量上限(MB)，超出从最旧的条目删，0=不限'),
  cleanup: CleanupSchema.default({ dryRun: false, rules: [] }).description('定期清理（内置 media/tmp 之外的额外目录）'),
  groupTriggerMode: GroupTriggerModeSchema.description('群聊触发模式：mention=仅@回复，probability=固定概率接话，desire=回复欲望打分，all=全部回复'),
  requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发'),
  groupReplyProbability: Schema.number().default(0).description('群聊未@时随机回复概率(0-1)，0=关闭'),
  replyDesire: ReplyDesireSchema.default({
    enabled: false,
    threshold: 0.6,
    names: [],
    engagedMs: 90000,
    engagedMaxTurns: 8,
    judge: REPLY_JUDGE_DEFAULTS,
  }).description('群聊回复欲望门控'),
  groupPrompt: Schema.string().description('群聊额外system prompt'),
  directPrompt: Schema.string().description('私聊额外system prompt'),
  groupProvider: Schema.string().default('').description('群聊默认 provider（空=跟随全局）'),
  groupModel: Schema.string().default('').description('群聊默认模型（空=跟随全局）'),
  textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
  streaming: Schema.boolean().default(true).description('是否启用流式输出（群聊始终不启用）'),
  sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)'),
  maxQueue: Schema.number().default(20).description('并发队列最大长度'),
  steerWindowMs: Schema.number().min(0).max(300000).default(10000)
    .description('短时间内新消息自动打断当前思考并追加(steer)的时间窗(ms)，群聊仅显式@bot生效、私聊连发生效；0=关闭'),
  processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('处理超时(ms)，超时中断当前 LLM 调用'),
  askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示'),
  historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
  autoCompactTokens: Schema.number().default(160000).description('上下文超过此 token 数时自动压缩（0=关闭）；私聊另见 autoCompactPrivateRatio'),
  autoCompactPrivateRatio: Schema.number().min(0).max(0.9).default(0.5)
    .description('私聊自动压缩阈值占模型上下文窗口的比例（不低于 autoCompactTokens；0=私聊也用固定阈值）'),
  autoCompactDeferOnTools: Schema.boolean().default(true)
    .description('上一轮还在调工具时推迟自动压缩，等收尾轮或上下文到阈值 1.5 倍再压'),
  idleCompactMinutes: Schema.number().min(0).max(1440).default(20)
    .description('会话空闲这么多分钟后压缩一次，需小于会话闲置超时；0=关闭'),
  idleCompactTokens: Schema.number().min(0).default(100000).description('空闲压缩的上下文下限（token），低于它不压'),
  idleCompactProviders: Schema.string().default('google, */*gemini*')
    .description('空闲压缩生效的 provider 或模型规则，逗号分隔（支持 provider、provider/model 或 model:*gemini* 通配）；留空=全部（只有提示缓存几分钟就过期的上游/模型才需要）'),
  access: AccessControlSchema.default({
    c2cMode: 'open',
    c2cAllow: [],
    groupMode: 'open',
    groupAllow: [],
  }).description('访问控制'),
  showToolResults: Schema.boolean().default(false).description('是否展示工具调用结果（关闭时私聊仍展示错误，群聊不展示）'),
  debug: Schema.boolean().default(false),
  media: MediaSchema.description('富媒体理解配置'),
  vision: VisionSchema.description('视觉理解配置'),
  asr: AsrSchema.description('语音识别配置'),
  video: VideoSchema.description('视频理解配置'),
  sendFile: SendFileSchema.description('附件发送工具配置'),
  speak: SpeakSchema.description('语音合成工具配置（qqbot_speak）'),
  imageGen: ImageGenSchema.description('GPT Image 生图与参考图编辑配置'),
  ownerOpenid: Schema.string().description('bot 主人 QQ openid（私聊识别，文件访问白名单）'),
  adminOpenids: Schema.array(Schema.string()).default([]).description('额外的配置管理员 openid（可修改模型/preset、点击审批）'),
  fileAccess: FileAccessSchema.default({
    sensitivePaths: [],
  }).description('文件访问白名单'),
  toolAccess: ToolAccessSchema.default({
    enabled: true,
    fullAccessGroups: [],
    fullAccessUsers: [],
    readRoots: [],
  }).description('工具权限（终端白名单群、受限会话可访问的目录）'),
  modelFailover: ModelFailoverSchema.default({
    enabled: false,
    intervalMinutes: 10,
    failThreshold: 1,
    recoverThreshold: 3,
    primaryProvider: '',
    primaryModel: '',
    primaryApiKeyEnv: '',
    backupProvider: '',
    backupModel: '',
    backupApiKeyEnv: '',
    ttftThresholdMs: 8000,
    notify: true,
  }).description('上游状态监测：异常时自动切到备用模型'),
  stickers: StickersSchema.default({
    enabled: true,
    root: '',
    extraRoots: [],
    maxBytes: 8 * 1024 * 1024,
    maxAutoEntries: 200,
  }).description('表情自动收藏配置'),
  personas: PersonasSchema.description('外置聊天人设目录配置'),
  notes: NotesSchema.default({
    enabled: true,
    root: '',
    autoInject: true,
    injectTopK: 2,
    injectMaxChars: 600,
    injectMinCoverage: 0.4,
    semantic: {
      enabled: false,
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: '',
      model: 'BAAI/bge-m3',
      minSimilarity: 0.5,
      minMargin: 0.16,
      timeoutMs: 3000,
    },
    judge: NOTE_JUDGE_DEFAULTS,
  }).description('共享笔记库配置'),
  bili: BiliSchema.description('B 站只读工具开关（默认关闭）'),
  sing: SingSchema.description('点歌工具配置（默认关闭，需外部唱歌 HTTP 服务）'),
  reverseImage: ReverseImageSchema.description('以图搜图工具开关（默认关闭）'),
  fanart: FanartSchema.default({
    enabled: false,
    proxy: '',
    poolDir: '',
  }).description('搜图工具配置（默认关闭）'),
  dnd: DndSchema.default({
    enabled: true,
    root: '',
    turnButtons: true,
    interjections: true,
    snapshotIntervalTurns: DND_DEFAULT_SNAPSHOT_INTERVAL_TURNS,
    combatAgent: DND_COMBAT_AGENT_DEFAULTS,
  }).description('跑团配置'),
});
