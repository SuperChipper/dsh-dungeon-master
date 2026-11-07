/**
 * qqbot_sing —— 点歌工具，替代在终端里跑 sing_client.py。
 *
 * 背景：唱歌服务本身是本地 HTTP 服务（127.0.0.1:8766），以前靠模型跑命令行调用；
 * 群聊撤掉终端白名单后那条路断了。封成工具之后群里也能点歌，而且模型能做的只有
 * submit / status / cancel / result 四个固定动作，拼不出任意命令。
 *
 * 点完不用盯：提交后挂一个后台轮询，唱完自动下载成品并发回发起的那条会话；
 * 模型这边立刻拿到 job id 就能继续聊天。
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionManager } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { MEDIA_ROOT } from './media-cleaner.ts';
import { PLUGIN_ROOT } from '../shared/index.ts';
import { withFreshReplyTarget, type MediaSenderLike } from './send-file-tool.ts';

export const SING_TOOL_NAME = 'qqbot_sing';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8766';
const TERMINAL_STATES = new Set(['succeeded', 'succeeded_with_warnings', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const SUCCESS_STATES = new Set(['succeeded', 'succeeded_with_warnings']);
const POLL_INTERVAL_MS = 6_000;
const MAX_POLL_MS = 60 * 60 * 1000;

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface SingJob {
  id?: string;
  state?: string;
  stage?: string;
  error?: string;
  result_format?: string;
  result_url?: string;
  created?: number;
  finished?: number;
  [key: string]: unknown;
}

function baseUrl(): string {
  return (process.env.QQBOT_SING_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function token(): string {
  return process.env.QQBOT_SING_TOKEN ?? process.env.SING_SERVICE_TOKEN ?? '';
}

async function rpc<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const value = token();
  if (value !== '') headers.authorization = `Bearer ${value}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(baseUrl() + path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  if (!response.ok) {
    const message = (parsed as { error?: string }).error ?? text.slice(0, 300);
    throw new Error(`唱歌服务返回 HTTP ${response.status}：${message}`);
  }
  return parsed as T;
}

/** 结果落盘：Content-Type 决定扩展名，不靠调用方猜 */
async function downloadResult(jobId: string, hint?: string): Promise<string> {
  const headers: Record<string, string> = {};
  const value = token();
  if (value !== '') headers.authorization = `Bearer ${value}`;
  const response = await fetch(`${baseUrl()}/jobs/${encodeURIComponent(jobId)}/result`, {
    headers,
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok || response.body === null) throw new Error(`取成品失败：HTTP ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  const ext = type.includes('video/mp4') ? '.mp4' : hint === 'mp3' ? '.mp3' : '.mp3';
  const dir = join(MEDIA_ROOT, 'sing');
  await mkdir(dir, { recursive: true });
  const out = join(dir, `${jobId}${ext}`);
  const temporary = `${out}.part`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(temporary),
    );
    await rm(out, { force: true });
    await rename(temporary, out);
  } finally {
    await rm(temporary, { force: true });
  }
  return out;
}

/** path 是否在 root 里（含 root 本身） */
function isInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function songLabel(song: string): string {
  const name = song.split(/[\\/]/).pop() ?? song;
  return name.replace(/\.[a-z0-9]{1,5}$/i, '');
}

export function registerSingTool(
  ctx: Context,
  sender: MediaSenderLike,
  manager: SessionManager,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_sing 未注册');
    return;
  }

  /** 正在等结果的单子：jobId → 定时器，同一个单子不重复挂 */
  const watching = new Map<string, NodeJS.Timeout>();

  const startWatching = (jobId: string, target: ReplyTarget | undefined, song: string): void => {
    if (watching.has(jobId)) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      void (async () => {
        if (Date.now() - startedAt > MAX_POLL_MS) {
          clearInterval(timer);
          watching.delete(jobId);
          logger.warn(`im-qqbot: 唱歌任务 ${jobId} 超过 ${MAX_POLL_MS / 60000} 分钟仍在跑，停止轮询`);
          return;
        }
        try {
          const job = await rpc<SingJob>(`/jobs/${encodeURIComponent(jobId)}`);
          if (!TERMINAL_STATES.has(String(job.state))) return;
          clearInterval(timer);
          watching.delete(jobId);
          if (!SUCCESS_STATES.has(String(job.state))) {
            logger.warn(`im-qqbot: 唱歌任务 ${jobId} 结束于 ${job.state}${job.error ? `（${job.error}）` : ''}`);
            return;
          }
          if (target === undefined) {
            logger.info(`im-qqbot: 唱歌任务 ${jobId} 完成（本机会话，不自动发送）`);
            return;
          }
          const file = await downloadResult(jobId, job.result_format);
          const caption = `${song} 唱好了`;
          if (file.endsWith('.mp4')) await sender.sendVideo(target, { localPath: file }, { content: caption });
          else await sender.sendFile(target, { localPath: file }, { fileName: `${song}.mp3`, content: caption });
          logger.info(`im-qqbot: 唱歌任务 ${jobId} 已发回 ${file}`);
        } catch (err) {
          logger.warn(`im-qqbot: 唱歌任务 ${jobId} 轮询失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }, POLL_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    watching.set(jobId, timer);
  };

  const definition = {
    name: SING_TOOL_NAME,
    description:
      '点歌：把一首歌交给本地唱歌服务（RVC 翻唱），异步出片，唱完自动发回当前会话。'
      + 'action=submit 需要 song（本地音频路径或 http(s) 链接）；提交后立即返回 job id，不要在这里等。'
      + 'action=status/list/cancel/result 用来查进度、列任务、取消、取成品路径。'
      + '不发语音气泡：成品是 mp4，按视频发。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['submit', 'status', 'cancel', 'result', 'list', 'health'],
          description: 'submit 提交点歌；status 查单个；list 列最近；cancel 取消；result 取成品路径；health 探活。',
        },
        song: { type: 'string', description: 'submit 用：本地音频绝对路径（必须在 Dsh-bot 里）或 http(s) 链接。' },
        job: { type: 'string', description: 'status / cancel / result 用的任务 id。' },
        options: {
          type: 'object',
          description: '可选参数，例如 {"cover_emotion":"开心"}、{"lead_back":"hp5"}、{"separator":"demucs"}。',
          additionalProperties: true,
        },
        idempotency_key: { type: 'string', description: '重复提交时用同一个 key，服务端会复用任务。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: String(value) }],
    },
    async execute(args: Record<string, unknown>, exec: { agent?: unknown }): Promise<string> {
      const action = String(args.action ?? '');
      const jobId = typeof args.job === 'string' ? args.job.trim() : '';

      if (action === 'health') {
        const value = await rpc<Record<string, unknown>>('/health', { timeoutMs: 5_000 });
        return `唱歌服务：${String(value.service ?? '?')}；ready=${String(value.ready ?? '?')}`;
      }

      if (action === 'list') {
        const value = await rpc<{ jobs?: SingJob[] }>('/jobs');
        const jobs = value.jobs ?? [];
        if (jobs.length === 0) return '唱歌服务现在没有任务。';
        return jobs.slice(0, 10).map((job) => `${job.id}  ${job.state ?? '?'}  ${job.stage ?? ''}`).join('\n');
      }

      if (action === 'status') {
        if (jobId === '') throw new Error('qqbot_sing: status 需要 job');
        const job = await rpc<SingJob>(`/jobs/${encodeURIComponent(jobId)}`);
        return JSON.stringify(job, null, 2).slice(0, 1500);
      }

      if (action === 'cancel') {
        if (jobId === '') throw new Error('qqbot_sing: cancel 需要 job');
        const job = await rpc<SingJob>(`/jobs/${encodeURIComponent(jobId)}/cancel`, { body: {} });
        return `已请求取消 ${jobId}，当前状态 ${String(job.state ?? '?')}。`;
      }

      if (action === 'result') {
        if (jobId === '') throw new Error('qqbot_sing: result 需要 job');
        const job = await rpc<SingJob>(`/jobs/${encodeURIComponent(jobId)}`);
        if (!SUCCESS_STATES.has(String(job.state))) return `任务 ${jobId} 还没成功（state=${job.state ?? '?'}），先别取成品。`;
        const file = await downloadResult(jobId, job.result_format);
        const size = (await stat(file)).size;
        return `成品已下载：${file}（${(size / (1024 * 1024)).toFixed(1)} MB）\n要发出去就用 qqbot_send_file。`;
      }

      if (action !== 'submit') throw new Error(`qqbot_sing: 未知 action ${action}`);

      const rawSong = typeof args.song === 'string' ? args.song.trim() : '';
      if (rawSong === '') throw new Error('qqbot_sing: submit 需要 song');
      const isUrl = /^https?:\/\//i.test(rawSong);
      // 服务端用 Path.resolve() 校验输入，而它是隐藏启动的、cwd 不可预期：这里先锚成绝对路径
      const song = isUrl ? rawSong : isAbsolute(rawSong) ? rawSong : resolve(process.cwd(), rawSong);
      // 本地文件只认 media 和 tmp：群里任何人能调这个工具，不能让它把随便哪个本机文件
      // 当成“歌”上传到服务里走一遍，再发回群里。
      if (!isUrl && !isInside(song, MEDIA_ROOT) && !isInside(song, join(PLUGIN_ROOT, 'tmp'))) {
        throw new Error('qqbot_sing: 本地音频只能放在 bot 的 media 或 tmp 目录下；也可以直接给 http(s) 链接');
      }
      const options = args.options !== null && typeof args.options === 'object' ? args.options : {};
      const payload = {
        song,
        options,
        idempotency_key: typeof args.idempotency_key === 'string' ? args.idempotency_key : '',
      };
      const job = await rpc<SingJob>('/jobs', { body: payload, timeoutMs: 30_000 });
      const id = String(job.id ?? '');
      if (id === '') throw new Error('唱歌服务没有返回任务 id');

      const record = exec.agent === undefined ? undefined : manager.findByAgent(exec.agent as never);
      const target = record === undefined ? undefined : withFreshReplyTarget(record.replyTarget);
      startWatching(id, target, songLabel(song));

      const queue = job.queue ?? job.position;
      return [
        `已提交：《${songLabel(song)}》 job=${id} state=${String(job.state ?? '?')}${queue === undefined ? '' : ` 排队位次 ${String(queue)}`}`,
        '唱完会自动发回这条会话；现在可以继续聊别的，不用等。',
      ].join('\n');
    },
  };

  tools.register(definition);
  logger.info(`im-qqbot: qqbot_sing 已注册（${baseUrl()}）`);
}
