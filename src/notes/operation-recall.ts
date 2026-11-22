import { createHash } from 'node:crypto';

export interface OperationEvidence {
  operations: string[];
  query: string;
  media: boolean;
  incomplete: boolean;
  facts: string[];
}
const TOOL_OPERATIONS: Record<string, string> = {
  qqbot_describe_video: 'media.video.inspect', qqbot_video_fetch: 'media.video.fetch',
  qqbot_bili: 'media.video.fetch',
  qqbot_transcribe: 'media.audio.transcribe', qqbot_describe_image: 'media.image.inspect',
  qqbot_reverse_image: 'media.image.origin', qqbot_video_frames: 'media.video.frames',
};
export function operationQueryTerms(operations: readonly string[]): string {
  const terms: Record<string, string> = {
    'media.video.inspect': '视频理解 视频解析', 'media.video.fetch': '视频下载',
    'media.audio.transcribe': '音频转写 语音识别', 'media.image.inspect': '图片识别',
    'media.image.origin': '角色辨认 图片出处 梗', 'media.video.frames': '视频画面 字幕',
    'credentials.resolve.missing': '凭证解析 密钥引用',
  };
  return [...new Set(operations.flatMap(op => terms[op] ? [terms[op]!] : []))].join(' ');
}

export function inboundOperations(text: string, mediaTypes: readonly string[]): string[] {
  const operations = new Set<string>();
  if (mediaTypes.includes('video') || /b23\.tv\/|bilibili\.com\/video\/|BV[\w]{10}/i.test(text)) operations.add('media.video.inspect');
  if (mediaTypes.includes('voice') || /转写|听写|音频转文字/.test(text)) operations.add('media.audio.transcribe');
  if (mediaTypes.includes('image')) operations.add('media.image.inspect');
  if (mediaTypes.includes('image') && /这是谁|出自|出处|什么梗|认得/.test(text)) operations.add('media.image.origin');
  return [...operations];
}

/** Only explicit public media fields are retrieval material; raw arguments, shell output and secrets never enter this route. */
export function toolOperationEvidence(name: string, result: { isError?: boolean; value?: unknown; error?: unknown }): OperationEvidence | undefined {
  const operation = TOOL_OPERATIONS[name];
  if (!operation) return undefined;
  const failed = result.isError === true;
  if (name === 'qqbot_bili' && !failed && (typeof result.value !== 'string' || !result.value.includes('已下载《'))) {
    return undefined;
  }
  const value = result.value && typeof result.value === 'object' ? result.value as Record<string, unknown> : {};
  const error = result.error && typeof result.error === 'object' ? result.error as Record<string, unknown> : {};
  const partial = value.partial === true || value.truncated === true || value.textTruncated === true;
  const facts = [`工具:${name}`, `结果:${failed ? '失败' : partial ? '部分完成' : '成功'}`];
  if (typeof value.analyzedStart === 'number' && typeof value.analyzedEnd === 'number') facts.push(`实际覆盖:${value.analyzedStart}–${value.analyzedEnd}秒`);
  if (value.transcribed === false && name === 'qqbot_describe_video') facts.push('音轨未转写，不能据此声称已听完');
  // Error text is classified, never copied into the note query (could include URLs or credentials).
  const errorMessage = typeof error.message === 'string' ? error.message : '';
  const operations = [operation];
  if (failed && /凭证|credential|api.?key|unauthorized/i.test(errorMessage)) operations.push('credentials.resolve.missing');
  const allowed = failed ? '' : [value.text, value.title].filter((x): x is string => typeof x === 'string').join('\n');
  const query = allowed.replace(/(?:https?:\/\/|[A-Za-z]:[\\/])\S+/g, ' ').slice(0, 4000);
  const missingSpeech = value.transcribed === false && name === 'qqbot_describe_video';
  return { operations, query, media: true, incomplete: failed || partial || missingSpeech, facts };
}

/** Identity includes content revision: a corrected note can be recalled again in the same turn. */
export function noteRevisionKey(hit: { file: string; heading: string; text: string }): string {
  return `${hit.file}\0${hit.heading}\0${createHash('sha256').update(hit.text).digest('hex')}`;
}

export class RecallTurnState {
  readonly seen = new Set<string>();
  readonly events = new Set<string>();
  usedChars = 0;
  factChars = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly query: string, readonly operations: readonly string[], readonly createdAt = Date.now()) {}
  serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** The underlying read may finish later, but only the returned value may commit recall state. */
export async function boundedRecall<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T | undefined> {
  if (signal?.aborted) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cutoff = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    onAbort = () => resolve(undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, cutoff]); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}
