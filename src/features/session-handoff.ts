/**
 * /new 的会话交接 — 换新会话前，让模型把旧会话写成一小段交接，注入新会话的第一条消息。
 *
 * 为什么要它：/new 只是丢掉旧会话。群聊还能靠落盘的群消息回灌最近的原文，
 * 但 bot 自己答应过什么、事情做到哪一步都不在里面；私聊则是完全从头开始。
 *
 * 跑团不走这里：团档独立于会话，有自己的停团交接。压缩摘要转述站位走样过，
 * 再叠一份转述只会多一个和团档对不上的来源。
 */
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { Logger } from '../types.ts';
import { pickLowestEffort, type JudgeLlm } from './reply-judge.ts';

export interface HandoffTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** 给摘要模型看的旧会话上限：只取最后这么多字，再早的事多半已经翻篇 */
const TRANSCRIPT_MAX_CHARS = 12_000;
/** 单条消息上限：一条长消息（贴的日志、整篇文章）不该挤掉其它所有轮次 */
const TURN_MAX_CHARS = 1_200;
/** 少于这么多条用户消息就不交接：没聊几句，没什么可带的 */
const MIN_USER_TURNS = 2;
/** 交接正文上限：它每次都占新会话的上下文，写长了等于没清 */
export const HANDOFF_MAX_CHARS = 800;
const TIMEOUT_MS = 30_000;
/** 模型认为没什么可交接时回的词 */
const NOTHING = '无';

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+\n/g, '\n').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…（后略）`;
}

/**
 * 用户侧的消息留尾巴：入站时群历史、笔记、各种提示都拼在前面，真正说的那句在最后。
 */
function clipTail(text: string, max: number): string {
  const flat = text.replace(/\s+\n/g, '\n').trim();
  return flat.length <= max ? flat : `（前略）…${flat.slice(-max)}`;
}

/**
 * 把旧会话的轮次拼成给摘要模型看的文本（旧→新），从最新的往回取到字数上限。
 * 用户消息不够 MIN_USER_TURNS 条时返回 undefined。
 */
export function buildHandoffTranscript(turns: readonly HandoffTurn[]): string | undefined {
  const useful = turns.filter((turn) => turn.text.trim() !== '');
  if (useful.filter((turn) => turn.role === 'user').length < MIN_USER_TURNS) return undefined;

  const lines: string[] = [];
  let total = 0;
  for (let i = useful.length - 1; i >= 0; i -= 1) {
    const turn = useful[i]!;
    const line = turn.role === 'user'
      ? `【用户侧】${clipTail(turn.text, TURN_MAX_CHARS)}`
      : `【机器人】${clip(turn.text, TURN_MAX_CHARS)}`;
    if (total + line.length > TRANSCRIPT_MAX_CHARS && lines.length > 0) break;
    lines.unshift(line);
    total += line.length;
  }
  return lines.join('\n\n');
}

export function buildHandoffSystem(): string {
  return [
    '下面是一个聊天机器人和用户的一段对话记录。这段会话马上要清空，机器人会在全新的上下文里继续和同一批人聊。',
    '替机器人写一份交接，让它接着聊时不至于前言不搭后语。只写接下来还用得上的：',
    '- 没做完的事：做到哪一步、下一步是什么。',
    '- 机器人答应过、还没兑现的事。',
    '- 用户明确提过的要求或偏好（怎么称呼、不要做什么）。',
    '- 正在聊、多半还会接着聊的话题，一句话带过。',
    '已经聊完的闲话、寒暄、工具调用的过程都不写。记录里没有的事不要补，拿不准的不写。',
    `用第二人称「你」写给机器人，分条，总共不超过 ${HANDOFF_MAX_CHARS} 字，不要标题和客套话。`,
    `如果没有任何值得交接的内容，只回一个字：${NOTHING}`,
  ].join('\n');
}

/** 模型的输出 → 交接正文；空、「无」都算没有 */
export function parseHandoff(text: string): string | undefined {
  const body = text.trim();
  if (body === '' || body.replace(/[\s\p{P}]/gu, '') === NOTHING) return undefined;
  return clip(body, HANDOFF_MAX_CHARS);
}

/** 注入新会话第一条消息的文字 */
export function formatHandoffHint(summary: string): string {
  return [
    '[上一段会话的交接]',
    '用户刚开了新会话，之前的对话你已经看不到了。下面是清空前自动整理的要点，是转述，细节可能不准：',
    '拿它当背景，对方接着之前的事说时能接上；对方没提就不用主动翻旧账，和对方现在说的对不上时以现在说的为准。',
    summary,
  ].join('\n');
}

export interface HandoffRequest {
  provider: string;
  model: string;
  transcript: string;
}

/** 调模型写交接；超时、出错、没内容都返回 undefined（少一份交接不该挡住 /new） */
export class HandoffWriter {
  private readonly efforts = new Map<string, Promise<string | undefined>>();

  public constructor(
    private readonly llm: JudgeLlm,
    private readonly logger: Logger,
  ) {}

  public async write(request: HandoffRequest): Promise<string | undefined> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const effort = await this.effortFor(request.provider, request.model, signal);
      const options: GenerateOptions = {
        provider: request.provider,
        model: request.model,
        ...(effort !== undefined ? { reasoningEffort: effort as GenerateOptions['reasoningEffort'] } : {}),
        system: buildHandoffSystem(),
        messages: [createUserMessage({
          content: [{ type: 'text', text: `对话记录（旧→新）：\n\n${request.transcript}` }],
          source: { kind: 'plugin', plugin: 'dsh-im-qqbot' },
        })],
        // 档位没关干净时思考会吃掉 completion 额度，留够余量让正文写得出来
        maxTokens: 2048,
        signal,
      };
      const assembler = new BlockAssembler();
      for await (const chunk of this.llm.stream(options)) assembler.push(chunk);
      const text = assembler.blocks()
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      return parseHandoff(text);
    } catch (err) {
      this.logger.warn(`session-handoff: 写交接失败: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private effortFor(provider: string, model: string, signal: AbortSignal): Promise<string | undefined> {
    const key = `${provider}/${model}`;
    let cached = this.efforts.get(key);
    if (cached === undefined) {
      cached = (async () => {
        try {
          const info = await this.llm.resolveModelInfo?.(provider, model, signal);
          return pickLowestEffort(info?.reasoning?.efforts ?? []);
        } catch {
          return undefined;
        }
      })();
      this.efforts.set(key, cached);
    }
    return cached;
  }
}
