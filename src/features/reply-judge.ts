/**
 * 回复欲望的模型打分 — `desire` 模式下除硬过滤与表情包接龙复读外，统一交给模型灰区判断 bot 要不要接话。
 *
 * 配合 JudgeQueue 的防抖：群里连着说的几条只给最后一条打一次分。
 * 在对话窗口内且打分模型声明支持 image 输入时，可一并附带最新图片块参与多模态打分；
 * 跑团进行中切换为极克制的「旁观 DM」专用提示词，避免打断玩家战术讨论。
 * 打分只要一个数字，推理档位默认取模型支持的最低档：思考内容按输出计费，还会拖慢判断。
 */
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions, ImageBlock, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ReplyJudgeConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { QQBOT_MESSAGE_SOURCE } from '../shared/message-source.ts';

/** llm 服务里打分用到的部分 */
export interface JudgeLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{
    context?: { contextWindow?: number };
    inputModalities?: readonly string[];
    reasoning?: { efforts: ReadonlyArray<{ id: string; name: string }>; defaultEffort?: string };
  } | undefined>;
}

export interface JudgeLine {
  /** 发送者昵称；bot 自己说的话为 undefined */
  sender?: string;
  text: string;
  timestamp: number;
}

export interface JudgeImage {
  /** 给模型看的标注，例如「[图片#1（来自阿明，最新消息）]」 */
  label: string;
  block: ImageBlock;
  /** 动图抽帧拼图等附加说明 */
  note?: string;
}

export interface JudgeHints {
  /** 当前群正在跑团（D&D）：切换极克制的旁观 DM 提示词 */
  dnd?: boolean;
  /** 当前处于对话窗口内（刚被 @ 或刚接过话） */
  engaged?: boolean;
  /** 最新消息发送者就是窗口内刚和 bot 聊过的人 */
  engagedPeer?: boolean;
  /** 最新消息命中了 bot 昵称/别名 */
  named?: boolean;
  /** 最新消息是一张表情包 */
  sticker?: boolean;
  /** 表情包匹配到 bot 收藏库类型：pack = 自带包，auto = 自动收藏 */
  stickerCollection?: 'pack' | 'auto';
  /** bot 30 秒内刚发过言 */
  recentBotReply?: boolean;
}

export interface JudgeRequest {
  provider: string;
  model: string;
  names: readonly string[];
  /** 群聊额外 system prompt（bot 人设），截断后给模型参考 */
  persona?: string;
  /** 最近的群聊（旧→新），最后一条是待判断的消息 */
  lines: readonly JudgeLine[];
  /** 规则提取的上下文线索（对话窗口、昵称命中、表情包、跑团状态） */
  hints?: JudgeHints;
  /** 对话窗口内随消息附带的图片块（最多 2 张；模型支持 image 输入时传入） */
  images?: readonly JudgeImage[];
}

interface CachedModelCaps {
  effort: string | undefined;
  supportsImage: boolean;
}

/** 推理档位按这个顺序找最低档（id 或名字里含这些词） */
const LOW_EFFORT_HINTS = ['none', 'off', 'disable', 'minimal', 'min', 'low', 'fast'];
const PERSONA_MAX_CHARS = 600;
const LINE_MAX_CHARS = 200;

/** 从模型支持的档位里挑最低的；挑不出来就不传（用 provider 默认） */
export function pickLowestEffort(efforts: ReadonlyArray<{ id: string; name: string }>): string | undefined {
  for (const hint of LOW_EFFORT_HINTS) {
    const hit = efforts.find((e) => e.id.toLowerCase().includes(hint) || e.name.toLowerCase().includes(hint));
    if (hit !== undefined) return hit.id;
  }
  return undefined;
}

function clock(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** 群友之间聊天也算可接的场合：bot 靠接住具体的点串人，不等人叫；跑团期切用极克制旁观 DM 规则 */
export function buildJudgeSystem(
  names: readonly string[],
  persona?: string,
  options?: { dnd?: boolean; hasImages?: boolean },
): string {
  const who = names.length > 0 ? `「${names.join('」「')}」` : '「bot」';
  const hasImages = options?.hasImages === true;

  const lines = options?.dnd === true
    ? [
        `当前群正在跑 D&D 团，你在帮担任 DM 的机器人 ${who} 判断：看到最新这条未 @ 它的消息，它现在要不要作为「旁观 DM」顺嘴插一两句（不结算检定、不推进剧情）。`,
        '群友叫它不一定用全名：名字的变体（叠字、只叫一半、换个字、加「小」「老」「子」）、照人设起的外号或直接喊「DM」都算在叫它。',
        '跑团期间必须极度克制，绝不打断玩家讨论：',
        '- 高分：明显在直接喊 DM / 叫 bot 名字问规则、问状况或打招呼；发 bot 自带表情包或明显冲着 DM 逗乐；或者刚发生爆笑/大失败剧情、有人抛出极强且一句话能接住的梗。',
        '- 低分：玩家之间商量战术、讨论行动计划、角色间扮演对话、分配资源/站位、普通闲聊，或只是第三人称提到 bot/DM 名字——即使处在对话窗口内，只要是玩家互相讨论就一律给低分。',
        ...(hasImages
          ? ['- 本次附带了对话窗口内刚发的图片：只有图里是角色卡/规则截图在问 DM，或明显冲着 DM 的梗图/表情包时才给高分；无关配图或普通收尾表情一律低分。']
          : ['- 只是发了图、视频、链接或转发，没人问 DM 怎么看，给低分。']),
        '- 拿不准就给低分，宁可保持安静等玩家 @。',
        '只输出 JSON，不要解释：{"desire": 0到100的整数}',
      ]
    : [
        `你在帮 QQ 群里的机器人 ${who} 判断：看到最新这条消息，它现在要不要主动接话（没人 @ 它）。`,
        '群友叫它不一定用全名：名字的变体（叠字、只叫一半、换个字、加「小」「老」「子」）、照人设起的外号或调侃'
          + '（人设里的特点、爱好、梗），或者直接冲它说话（「起床」「在吗」「懒虫」），都算在叫它。',
        '像一个有分寸的群友那样判断：',
        '- 高分：在叫 bot、逗 bot、问 bot（注意区分直接叫 bot 和群友间第三人称顺嘴提到名字，后者视语境决定）；对话窗口内刚聊过的人顺着上一句追问、补充或接梗；有人求助一直没人回；最近几条里有一句话就能接住的具体点（错字、双关、自夸、身份标签、前后矛盾、自己立的 flag），群友之间聊天也算。',
        ...(hasImages
          ? ['- 本次附带了对话窗口内刚发的图片，请直接结合图片内容与上下文判断：图里有报错/问题截图、在给 bot 展示刚聊到的东西、表情包或梗图明显在回应或逗 bot 时给高分；只是随手转无关图、纯表情收尾或和当前对话无关时给低分。']
          : ['- 低分补充：只是发了图、视频、链接或转发，没人问 bot 怎么看（发东西不等于等人点评）。']),
        '- 低分：有人在求助、认真讨论、聊严肃的事或情绪不好；只有话题、没有具体的点；对话明显已经收尾或对方转去和别人聊别的事；已经有人接过这个点；bot 刚接过同一个人。',
        '- 拿不准就给低分，宁可少说。',
        '只输出 JSON，不要解释：{"desire": 0到100的整数}',
      ];

  if (persona !== undefined && persona.trim() !== '') {
    lines.push('', `bot 的人设（用来认出群友是不是在叫它、聊的是不是它会接的话题）：${persona.trim().slice(0, PERSONA_MAX_CHARS)}`);
  }
  return lines.join('\n');
}

function formatJudgeHints(hints: JudgeHints | undefined, imageCount: number): string[] {
  const items: string[] = [];
  if (hints?.dnd === true) items.push('当前群正在跑团（旁观 DM 插话评估，需极克制）');
  if (hints?.engaged === true) {
    items.push(hints.engagedPeer === true ? '当前在对话窗口内（最新发送者刚和 bot 聊过）' : '当前在对话窗口内（最新发送者为群内其他成员）');
  }
  if (hints?.named === true) items.push('最新消息命中 bot 昵称/别名（请区分是在叫 bot 还是第三人称提及）');
  if (hints?.sticker === true) {
    const detail: string[] = [];
    if (hints.stickerCollection === 'pack') detail.push('bot 自带表情包');
    else if (hints.stickerCollection === 'auto') detail.push('bot 收藏表情');
    if (hints.recentBotReply === true) detail.push('bot 30 秒内刚发过言');
    items.push(`最新消息是表情包${detail.length > 0 ? `（${detail.join('，')}）` : ''}`);
  }
  if (imageCount > 0) items.push(`随附 ${imageCount} 张对话窗口内图片，请结合图片内容判断`);
  return items;
}

export function buildJudgeTranscript(lines: readonly JudgeLine[], hints?: JudgeHints, imageCount = 0): string {
  const rows = lines.map((line, i) => {
    const who = line.sender === undefined ? '[bot]' : line.sender;
    const mark = i === lines.length - 1 ? '▶ ' : '';
    return `${mark}${clock(line.timestamp)} ${who}: ${line.text.replace(/\s+/g, ' ').slice(0, LINE_MAX_CHARS)}`;
  });
  const base = `最近的群聊（▶ 是最新一条）：\n${rows.join('\n')}`;
  const hintItems = formatJudgeHints(hints, imageCount);
  if (hintItems.length === 0) return base;
  return `${base}\n\n参考线索：${hintItems.join('；')}`;
}

/** 解析 {"desire": n}，解析不出来返回 undefined */
export function parseDesire(text: string): number | undefined {
  const match = /"?desire"?\s*[:：]\s*(\d+(?:\.\d+)?)/i.exec(text) ?? /\b(\d{1,3})\b/.exec(text);
  if (match === null) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value)) / 100;
}

/** 调模型打分；推理档位与 image 模态能力按 provider/model 缓存 */
export class ReplyJudge {
  private readonly modelCaps = new Map<string, Promise<CachedModelCaps>>();

  public constructor(
    private readonly llm: JudgeLlm,
    private readonly config: () => ReplyJudgeConfig,
    private readonly logger: Logger,
  ) {}

  /** 当前打分模型是否声明支持 image 输入（结果按 provider/model 缓存） */
  public async supportsImageInput(provider: string, model: string, signal?: AbortSignal): Promise<boolean> {
    const caps = await this.capsFor(provider, model, signal);
    return caps.supportsImage;
  }

  /** 0-1；超时、出错、解析不出都按 undefined（调用方当不接处理） */
  public async score(request: JudgeRequest): Promise<number | undefined> {
    const cfg = this.config();
    const signal = AbortSignal.timeout(cfg.timeoutMs);
    try {
      const effort = await this.effortFor(request.provider, request.model, cfg.reasoningEffort, signal);
      const rawImages = request.images ?? [];
      const images = rawImages.length > 0 && await this.supportsImageInput(request.provider, request.model, signal)
        ? rawImages
        : [];
      const content: ContentBlock[] = [
        { type: 'text', text: buildJudgeTranscript(request.lines, request.hints, images.length) },
      ];
      for (const image of images) {
        content.push({ type: 'text', text: image.note !== undefined ? `${image.label} ${image.note}` : image.label });
        content.push(image.block);
      }
      const options: GenerateOptions = {
        provider: request.provider,
        model: request.model,
        ...(effort !== undefined ? { reasoningEffort: effort as GenerateOptions['reasoningEffort'] } : {}),
        system: buildJudgeSystem(request.names, request.persona, {
          dnd: request.hints?.dnd,
          hasImages: images.length > 0,
        }),
        messages: [createUserMessage({
          content,
          source: QQBOT_MESSAGE_SOURCE,
        })],
        // 思考会吃掉 completion 额度：档位没关干净时，上下文一长 JSON 就写不出来、正文回空串
        maxTokens: 2048,
        signal,
      };
      const assembler = new BlockAssembler();
      let finishReason: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined;
      for await (const chunk of this.llm.stream(options)) {
        assembler.push(chunk);
        if (chunk.type === 'finish') finishReason = chunk.reason;
      }
      if (finishReason?.kind === 'error') {
        this.logger.warn(`reply-judge: 打分失败 (${finishReason.failure.code}): ${finishReason.failure.message}`);
        return undefined;
      }
      if (finishReason?.kind === 'aborted') {
        this.logger.warn(`reply-judge: 打分超时或中断: ${finishReason.failure.message}`);
        return undefined;
      }
      const text = assembler.blocks()
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join(' ');
      const desire = parseDesire(text);
      if (desire === undefined) {
        if (finishReason?.kind === 'max-tokens') {
          this.logger.warn(`reply-judge: 思考耗尽 maxTokens，未产出完整打分: ${text.slice(0, 120)}`);
        } else {
          this.logger.warn(`reply-judge: 解析不出打分: ${text.slice(0, 120)}`);
        }
      }
      return desire;
    } catch (err) {
      this.logger.warn(`reply-judge: 打分失败: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async effortFor(provider: string, model: string, configured: string, signal: AbortSignal): Promise<string | undefined> {
    if (configured.trim() !== '') return configured.trim();
    const caps = await this.capsFor(provider, model, signal);
    return caps.effort;
  }

  private capsFor(provider: string, model: string, signal?: AbortSignal): Promise<CachedModelCaps> {
    const key = `${provider}/${model}`;
    let cached = this.modelCaps.get(key);
    if (cached === undefined) {
      cached = this.resolveModelCaps(provider, model, signal);
      this.modelCaps.set(key, cached);
    }
    return cached;
  }

  private async resolveModelCaps(provider: string, model: string, signal?: AbortSignal): Promise<CachedModelCaps> {
    try {
      const info = await this.llm.resolveModelInfo?.(provider, model, signal);
      const efforts = info?.reasoning?.efforts ?? [];
      const effort = pickLowestEffort(efforts);
      const supportsImage = info?.inputModalities?.includes('image') === true;
      this.logger.info(
        `reply-judge: ${provider}/${model} 推理档位 [${efforts.map((e) => e.id).join(', ')}]，`
        + `打分用 ${effort ?? '(provider 默认)'}${supportsImage ? '（支持看图）' : ''}`,
      );
      return { effort, supportsImage };
    } catch (err) {
      this.logger.warn(`reply-judge: 查询模型能力失败，用默认配置: ${err instanceof Error ? err.message : String(err)}`);
      return { effort: undefined, supportsImage: false };
    }
  }
}

export type JudgeOutcome = 'judge' | 'superseded';

interface PendingJudge {
  resolve: (outcome: JudgeOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  firstAt: number;
}

/**
 * 按群防抖：群里安静 debounceMs 才放最后一条去打分，之前排着的都作废；
 * 一直有人说话时，最早那条排了 maxWaitMs 也要打一次，免得热闹的群里 bot 永远插不上话。
 */
export class JudgeQueue {
  private readonly pending = new Map<string, PendingJudge>();

  public constructor(private readonly config: () => ReplyJudgeConfig) {}

  /** 排一条候选消息；返回 judge = 轮到它打分，superseded = 被后来的消息顶掉了 */
  public enqueue(groupId: string, now: number): Promise<JudgeOutcome> {
    const previous = this.pending.get(groupId);
    const firstAt = previous?.firstAt ?? now;
    if (previous !== undefined) {
      clearTimeout(previous.timer);
      previous.resolve('superseded');
    }
    return new Promise<JudgeOutcome>((resolve) => {
      const entry: PendingJudge = { resolve, firstAt, timer: this.arm(groupId, now, firstAt) };
      this.pending.set(groupId, entry);
    });
  }

  /** 群里有新动静但不是候选（语气词、表情包等）：重新计时，候选不变 */
  public activity(groupId: string, now: number): void {
    const entry = this.pending.get(groupId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    entry.timer = this.arm(groupId, now, entry.firstAt);
  }

  /** bot 反正要说话了（被 @ / 规则放行）：排着的候选作废 */
  public cancel(groupId: string): void {
    const entry = this.pending.get(groupId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(groupId);
    entry.resolve('superseded');
  }

  private arm(groupId: string, now: number, firstAt: number): ReturnType<typeof setTimeout> {
    const cfg = this.config();
    const delay = Math.max(0, Math.min(cfg.debounceMs, firstAt + cfg.maxWaitMs - now));
    return setTimeout(() => {
      const entry = this.pending.get(groupId);
      if (entry === undefined) return;
      this.pending.delete(groupId);
      entry.resolve('judge');
    }, delay);
  }
}
