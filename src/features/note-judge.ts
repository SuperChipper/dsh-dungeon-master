/**
 * 笔记注入的相关性打分 — 一轮回复结束后，让模型判断这轮注入的笔记和用户消息到底相不相关。
 *
 * 为什么要它：检索只看「像不像」，账本只记「注入了什么」。满篇泛化词的段会被反复注入，
 * 却没有任何信号说它无关。这里补上那个信号：每段 0/1/2 三档，累计进账本，
 * 注入多、均分低的段可以静音（不再自动注入，主动检索仍查得到）。
 *
 * 打分在回复发出之后异步跑，不拖慢回复；失败、超时、解析不出都只是少一个样本。
 */
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { NoteJudgeConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { pickLowestEffort, type JudgeLine, type JudgeLlm } from './reply-judge.ts';
import { QQBOT_MESSAGE_SOURCE } from '../shared/message-source.ts';

export interface JudgedNote {
  file: string;
  heading: string;
  /** 模型实际看到的那段正文（已按注入字数上限截断） */
  text: string;
}

export interface NoteJudgeContext {
  /** 最近的对话记录（旧→新；sender 省略表示机器人自己说的） */
  contextLines?: readonly JudgeLine[];
  /** 机器人本轮实际发出的回复（含文件配文） */
  reply?: string;
  /** 机器人本轮调用过的工具名 */
  toolsUsed?: readonly string[];
}

export interface NoteJudgeRequest extends NoteJudgeContext {
  provider: string;
  model: string;
  /** 推理档位 id；空或缺省 = 自动选这个模型支持的最低档 */
  reasoningEffort?: string;
  /** 用户这条消息（含引用原文） */
  query: string;
  notes: readonly JudgedNote[];
}

const QUERY_MAX_CHARS = 400;
const CONTEXT_LINE_MAX_CHARS = 180;
const CONTEXT_MAX_LINES = 8;
const REPLY_MAX_CHARS = 500;
/** 部分上游在 off/low 档仍会吐出上千思考 token，输出其实只要十几个 token，留足余量防截断 */
const JUDGE_MAX_TOKENS = 4096;
/** 排队上限：上游卡住时不让待评项无限堆积，超出的直接丢（少几个样本无妨） */
const MAX_PENDING = 20;

/** 平滑用的先验：当作已经有 3 次、每次 0.5 分的样本，前几次倒霉不至于直接静音 */
const PRIOR_SAMPLES = 3;
const PRIOR_SCORE = 0.5;

type ModelEffortList = ReadonlyArray<{ id: string; name: string }>;

function clock(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function formatContextLines(lines: readonly JudgeLine[]): string {
  return lines.slice(-CONTEXT_MAX_LINES).map((line) => {
    const who = line.sender === undefined ? '[bot]' : line.sender;
    const text = line.text.replace(/\s+/g, ' ').trim().slice(0, CONTEXT_LINE_MAX_CHARS);
    return line.timestamp > 0 ? `${clock(line.timestamp)} ${who}: ${text}` : `${who}: ${text}`;
  }).join('\n');
}

export function buildNoteJudgeSystem(): string {
  return [
    '你在评估一个聊天机器人的长期记忆检索。下面给出最近的对话背景、用户发来的当前消息、机器人本轮的实际回复（及调用的工具），以及系统自动检索出来附给机器人看的几段笔记。',
    '结合对话上下文和机器人的实际回复，判断每段笔记在这一轮有没有帮上忙：',
    '- 2：直接有用。回复里用到了其中的事实、设定、偏好、梗或文件路径；或这段笔记帮机器人听懂了前文指代/群内黑话，或顺着它继续调工具深查；或行为准则/说话风格/踩坑提醒类笔记正好切中本轮场景并在回复中体现。',
    '- 1：间接相关。属于同一话题、同一人物/群梗或当前场景的有效背景与避坑参考，虽然回复没直接引述，但有参考价值。',
    '- 0：无关噪音。只是碰巧撞上了相同的字词、编号或目录前缀，和当前对话的话题、场景、回复方式都对不上。',
    '注意看最近聊天记录里的前文指代（如「那个」「发出来看看」），不要只盯用户最后一句字面词；真对不上话题就给 0。',
    '只输出 JSON，不要解释，按笔记编号顺序给分：{"scores":[2,0]}',
  ].join('\n');
}

export function buildNoteJudgePrompt(
  query: string,
  notes: readonly JudgedNote[],
  extra?: NoteJudgeContext,
): string {
  const sections: string[] = [];
  if (extra?.contextLines !== undefined && extra.contextLines.length > 0) {
    sections.push(`最近的对话背景：\n${formatContextLines(extra.contextLines)}`);
  }
  sections.push(`用户消息：\n${query.replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX_CHARS)}`);
  if (extra?.toolsUsed !== undefined && extra.toolsUsed.length > 0) {
    sections.push(`机器人本轮调用的工具：${extra.toolsUsed.slice(0, 12).join(', ')}`);
  }
  const replyText = extra?.reply?.replace(/\s+/g, ' ').trim() ?? '';
  if (replyText !== '') {
    sections.push(`机器人本轮回复：\n${replyText.slice(0, REPLY_MAX_CHARS)}`);
  }
  const rows = notes.map((note, i) => `#${i + 1} ${note.file} › ${note.heading}\n${note.text.replace(/\s+/g, ' ').trim()}`);
  sections.push(`检索到的笔记（共 ${notes.length} 段）：\n${rows.join('\n\n')}`);
  return sections.join('\n\n');
}

/**
 * 解析 {"scores":[…]}，返回 0-1 的分数（原始 0/1/2 除以 2）。
 * 个数对不上或有非法值时返回 undefined：宁可丢掉这一轮，也不把分数记到错的段上。
 */
export function parseNoteScores(text: string, expected: number): number[] | undefined {
  const match = /"?scores"?\s*[:：]\s*\[([^\]]*)\]/i.exec(text) ?? /\[([\d\s,.]*)\]/.exec(text);
  if (match === null) return undefined;
  const parts = match[1]!.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length !== expected) return undefined;
  const scores: number[] = [];
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0 || value > 2) return undefined;
    scores.push(value / 2);
  }
  return scores;
}

/** 带先验的平均相关分（0-1） */
export function smoothedRelevance(relevanceSum: number, judged: number): number {
  return (relevanceSum + PRIOR_SCORE * PRIOR_SAMPLES) / (judged + PRIOR_SAMPLES);
}

/** 该不该静音：评够了次数，平滑后的均分还低于阈值。muteBelow <= 0 表示只打分不静音 */
export function shouldMute(
  stat: { relevanceSum: number; judged: number },
  policy: { minSamples: number; muteBelow: number },
): boolean {
  if (policy.muteBelow <= 0 || stat.judged < Math.max(1, policy.minSamples)) return false;
  return smoothedRelevance(stat.relevanceSum, stat.judged) < policy.muteBelow;
}

/** 调模型给注入的笔记打分；串行排队，模型支持的推理档位按 provider/model 缓存 */
export class NoteJudge {
  private readonly modelEfforts = new Map<string, Promise<ModelEffortList | undefined>>();
  private readonly loggedEffortNotes = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  public constructor(
    private readonly llm: JudgeLlm,
    private readonly config: () => NoteJudgeConfig,
    private readonly logger: Logger,
  ) {}

  /** 排队打分；队列满了返回 undefined */
  public enqueue(request: NoteJudgeRequest): Promise<number[] | undefined> {
    if (request.notes.length === 0 || this.pending >= MAX_PENDING) return Promise.resolve(undefined);
    this.pending += 1;
    const run = this.tail.then(() => this.score(request)).finally(() => { this.pending -= 1; });
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** 每段 0-1；超时、出错、解析不出都返回 undefined */
  public async score(request: NoteJudgeRequest): Promise<number[] | undefined> {
    const signal = AbortSignal.timeout(this.config().timeoutMs);
    try {
      const configured = request.reasoningEffort?.trim() ?? '';
      const effort = await this.resolveEffort(request.provider, request.model, configured, signal);
      const options: GenerateOptions = {
        provider: request.provider,
        model: request.model,
        ...(effort !== undefined ? { reasoningEffort: effort as GenerateOptions['reasoningEffort'] } : {}),
        system: buildNoteJudgeSystem(),
        messages: [createUserMessage({
          content: [{
            type: 'text',
            text: buildNoteJudgePrompt(request.query, request.notes, {
              contextLines: request.contextLines,
              reply: request.reply,
              toolsUsed: request.toolsUsed,
            }),
          }],
          source: QQBOT_MESSAGE_SOURCE,
        })],
        maxTokens: JUDGE_MAX_TOKENS,
        signal,
      };
      const assembler = new BlockAssembler();
      let finishReason: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined;
      for await (const chunk of this.llm.stream(options)) {
        assembler.push(chunk);
        if (chunk.type === 'finish') finishReason = chunk.reason;
      }
      if (finishReason?.kind === 'error') {
        this.logger.warn(`note-judge: 打分失败 (${finishReason.failure.code}): ${finishReason.failure.message}`);
        return undefined;
      }
      if (finishReason?.kind === 'aborted') {
        this.logger.warn(`note-judge: 打分超时或中断: ${finishReason.failure.message}`);
        return undefined;
      }
      const text = assembler.blocks()
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join(' ');
      const scores = parseNoteScores(text, request.notes.length);
      if (scores === undefined) {
        if (finishReason?.kind === 'max-tokens') {
          this.logger.warn(`note-judge: 思考耗尽 maxTokens，未产出完整打分: ${text.slice(0, 120)}`);
        } else {
          this.logger.warn(`note-judge: 解析不出打分: ${text.slice(0, 120)}`);
        }
      }
      return scores;
    } catch (err) {
      this.logger.warn(`note-judge: 打分失败: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * 校验并挑选该 provider/model 实际支持的推理档位：
   * - 非推理模型（efforts 为空）一律不传 reasoningEffort，防止 UNSUPPORTED_REASONING_EFFORT；
   * - 已配置档位且目标模型声明支持时保留原值（如 opencode-go 下用 low 避免 off:null 回退满血思考）；
   * - 已配置档位但目标模型不支持（如回退到无 off 的 Gemini 路由）时，降级到该模型的最低可用档。
   */
  private async resolveEffort(
    provider: string,
    model: string,
    configured: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const efforts = await this.effortsFor(provider, model, signal);
    if (efforts === undefined) return configured !== '' ? configured : undefined;
    if (efforts.length === 0) {
      if (configured !== '') {
        this.logOnce(`${provider}/${model}:none:${configured}`, `note-judge: ${provider}/${model} 不支持推理档位，忽略配置的 "${configured}"`);
      }
      return undefined;
    }
    if (configured !== '') {
      if (efforts.some((e) => e.id === configured)) return configured;
      const fallback = pickLowestEffort(efforts);
      this.logOnce(
        `${provider}/${model}:fallback:${configured}`,
        `note-judge: ${provider}/${model} 不支持推理档位 "${configured}"（支持 [${efforts.map((e) => e.id).join(', ')}]），改用 ${fallback ?? '(provider 默认)'}`,
      );
      return fallback;
    }
    return pickLowestEffort(efforts);
  }

  private effortsFor(provider: string, model: string, signal: AbortSignal): Promise<ModelEffortList | undefined> {
    if (this.llm.resolveModelInfo === undefined) return Promise.resolve(undefined);
    const key = `${provider}/${model}`;
    let cached = this.modelEfforts.get(key);
    if (cached === undefined) {
      cached = this.fetchModelEfforts(key, provider, model, signal);
      this.modelEfforts.set(key, cached);
    }
    return cached;
  }

  private async fetchModelEfforts(
    cacheKey: string,
    provider: string,
    model: string,
    signal: AbortSignal,
  ): Promise<ModelEffortList | undefined> {
    try {
      const info = await this.llm.resolveModelInfo!(provider, model, signal);
      return info?.reasoning?.efforts ?? [];
    } catch {
      this.modelEfforts.delete(cacheKey);
      return undefined;
    }
  }

  private logOnce(key: string, message: string): void {
    if (this.loggedEffortNotes.has(key)) return;
    this.loggedEffortNotes.add(key);
    this.logger.info(message);
  }
}
