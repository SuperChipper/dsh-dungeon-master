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
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { NoteJudgeConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { pickLowestEffort, type JudgeLlm } from './reply-judge.ts';

export interface JudgedNote {
  file: string;
  heading: string;
  /** 模型实际看到的那段正文（已按注入字数上限截断） */
  text: string;
}

export interface NoteJudgeRequest {
  provider: string;
  model: string;
  /** 推理档位 id；空或缺省 = 自动选这个模型支持的最低档 */
  reasoningEffort?: string;
  /** 用户这条消息（含引用原文） */
  query: string;
  notes: readonly JudgedNote[];
}

const QUERY_MAX_CHARS = 400;
/** 排队上限：上游卡住时不让待评项无限堆积，超出的直接丢（少几个样本无妨） */
const MAX_PENDING = 20;

/** 平滑用的先验：当作已经有 3 次、每次 0.5 分的样本，前几次倒霉不至于直接静音 */
const PRIOR_SAMPLES = 3;
const PRIOR_SCORE = 0.5;

export function buildNoteJudgeSystem(): string {
  return [
    '你在评估一个聊天机器人的长期记忆检索。下面给出用户发来的一条消息，和系统自动检索出来、附在消息前给机器人看的几段笔记。',
    '判断每段笔记和这条消息的话题相关度：',
    '- 2：直接相关，回这条消息时用得上这段内容。',
    '- 1：同一个话题的背景，可有可无。',
    '- 0：无关，只是碰巧撞上了几个相同的词。',
    '只看话题是否对得上，不评价笔记写得好不好。拿不准就给低分。',
    '只输出 JSON，不要解释，按笔记编号顺序给分：{"scores":[2,0]}',
  ].join('\n');
}

export function buildNoteJudgePrompt(query: string, notes: readonly JudgedNote[]): string {
  const rows = notes.map((note, i) => `#${i + 1} ${note.file} › ${note.heading}\n${note.text.replace(/\s+/g, ' ').trim()}`);
  return `用户消息：\n${query.replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX_CHARS)}\n\n检索到的笔记（共 ${notes.length} 段）：\n${rows.join('\n\n')}`;
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

/** 调模型给注入的笔记打分；串行排队，推理档位按 provider/model 缓存 */
export class NoteJudge {
  private readonly efforts = new Map<string, Promise<string | undefined>>();
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
      const effort = configured !== '' ? configured : await this.effortFor(request.provider, request.model, signal);
      const options: GenerateOptions = {
        provider: request.provider,
        model: request.model,
        ...(effort !== undefined ? { reasoningEffort: effort as GenerateOptions['reasoningEffort'] } : {}),
        system: buildNoteJudgeSystem(),
        messages: [createUserMessage({
          content: [{ type: 'text', text: buildNoteJudgePrompt(request.query, request.notes) }],
          source: { kind: 'plugin', plugin: 'dsh-im-qqbot' },
        })],
        // 档位没关干净时思考会吃掉 completion 额度，留够余量让 JSON 写得出来
        maxTokens: 1024,
        signal,
      };
      const assembler = new BlockAssembler();
      for await (const chunk of this.llm.stream(options)) assembler.push(chunk);
      const text = assembler.blocks()
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join(' ');
      const scores = parseNoteScores(text, request.notes.length);
      if (scores === undefined) this.logger.warn(`note-judge: 解析不出打分: ${text.slice(0, 120)}`);
      return scores;
    } catch (err) {
      this.logger.warn(`note-judge: 打分失败: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private effortFor(provider: string, model: string, signal: AbortSignal): Promise<string | undefined> {
    const key = `${provider}/${model}`;
    let cached = this.efforts.get(key);
    if (cached === undefined) {
      cached = this.resolveLowest(provider, model, signal);
      this.efforts.set(key, cached);
    }
    return cached;
  }

  private async resolveLowest(provider: string, model: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const info = await this.llm.resolveModelInfo?.(provider, model, signal);
      return pickLowestEffort(info?.reasoning?.efforts ?? []);
    } catch {
      return undefined;
    }
  }
}
