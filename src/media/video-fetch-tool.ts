/**
 * qqbot_video_fetch —— 把一段 B 站视频下到 media 目录，交给 qqbot_describe_video 看。
 *
 * 为什么要有这个工具：群里撤掉终端白名单后，模型不能再自己跑下载器；而“看一眼这个视频
 * 讲了什么”只需要一个固定动作——给 bvid，取回本地 mp4。封成工具后模型只能按 bvid 取片，
 * 参数里没有命令、没有任意路径，群里留着是安全的。
 *
 * 只取免登录直链（durl，最高 480p）。付费/大会员专享、或接口只给 DASH 的片子会明确报错，
 * 不做降级猜测——比悄悄下到一个空文件好。
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { BiliClient } from '../bili/client.ts';
import { bvidOf } from '../bili/tools.ts';
import { MEDIA_ROOT } from './media-cleaner.ts';

const run = promisify(execFile);

export const VIDEO_FETCH_TOOL_NAME = 'qqbot_video_fetch';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_MAX_MB = 200;

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface ToolLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface VideoFetchDeps {
  client: BiliClient;
  logger: ToolLogger;
  /** 多段 durl 拼接用；没给就只能下第一段 */
  ffmpegPath?: string;
}

interface FetchArgs {
  url?: string;
  page?: number;
  quality?: number;
  max_mb?: number;
}

function qualityLabel(qn: number): string {
  const table: Record<number, string> = { 16: '360P', 32: '480P', 64: '720P', 74: '720P60', 80: '1080P', 112: '1080P+' };
  return table[qn] ?? `${qn}`;
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mmss(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** 流式写盘，超上限立刻中断，避免 4K 视频把磁盘吃满 */
async function downloadSegment(url: string, outPath: string, capBytes: number): Promise<number> {
  const response = await fetch(url, {
    headers: { referer: 'https://www.bilibili.com/', 'user-agent': UA },
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok || response.body === null) throw new Error(`下载直链失败：HTTP ${response.status}`);
  let written = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > capBytes) {
        callback(new Error(`视频超过 ${mb(capBytes)} 上限，已中断`));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    counter,
    createWriteStream(outPath),
  );
  return written;
}

export function registerVideoFetchTool(tools: ToolsRegistryLike, deps: VideoFetchDeps): void {
  const { client, logger } = deps;

  const definition = {
    name: VIDEO_FETCH_TOOL_NAME,
    description:
      'Download one Bilibili video to the local media folder so qqbot_describe_video / qqbot_transcribe '
      + 'can read it. Pass a BVID or any bilibili URL. Available in every chat (no terminal needed). '
      + 'Only public videos up to 480p: paid / members-only clips fail with a clear error. '
      + 'Returns the local file path and duration; call qqbot_describe_video with that path next.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'BVID or a Bilibili video URL, e.g. BV1qbn16kEFh.' },
        page: { type: 'number', description: '分P 页码，默认 1。' },
        quality: { type: 'number', description: '清晰度 qn：16/32/64/80，默认 64（720P）。' },
        max_mb: { type: 'number', description: `体积上限（MB），默认 ${DEFAULT_MAX_MB}。` },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: String(value) }],
    },
    async execute(args: FetchArgs): Promise<string> {
      const raw = typeof args.url === 'string' ? args.url.trim() : '';
      if (raw === '') throw new Error('qqbot_video_fetch: url 不能为空');
      const bvid = bvidOf(raw);
      const pageNo = Math.max(1, Math.trunc(args.page ?? 1));
      const qn = Math.trunc(args.quality ?? 64);
      const capBytes = Math.max(1, args.max_mb ?? DEFAULT_MAX_MB) * 1024 * 1024;

      const info = await client.video(bvid);
      const page = info.pages.find((item) => item.page === pageNo) ?? info.pages[pageNo - 1];
      const cid = page?.cid ?? info.cid;
      if (!cid) throw new Error(`${bvid} 没有第 ${pageNo} P`);

      const play = await client.playUrl(bvid, cid, qn);
      const dir = join(MEDIA_ROOT, 'video');
      await mkdir(dir, { recursive: true });
      const stamp = Date.now();
      const target = join(dir, `${bvid}-p${pageNo}-${stamp}.mp4`);

      let bytes = 0;
      if (play.segments.length === 1) {
        bytes = await downloadSegment(play.segments[0]!.url, target, capBytes);
      } else {
        // 老视频按 10 分钟切段，逐段落盘后用 ffmpeg 无损拼接
        if (deps.ffmpegPath === undefined) {
          await rm(target, { force: true });
          throw new Error(`这个视频被切成 ${play.segments.length} 段，需要 ffmpeg 拼接，但本机没找到 ffmpeg`);
        }
        const parts: string[] = [];
        try {
          for (const [index, segment] of play.segments.entries()) {
            const part = `${target}.part${index}`;
            bytes += await downloadSegment(segment.url, part, capBytes - bytes);
            parts.push(part);
          }
          const listFile = `${target}.concat.txt`;
          await writeFile(listFile, parts.map((part) => `file '${part.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
          await run(deps.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', target]);
          await rm(listFile, { force: true });
        } finally {
          await Promise.all(parts.map((part) => rm(part, { force: true })));
        }
        bytes = (await stat(target)).size;
      }

      logger.info(`im-qqbot: 视频已下载 ${bvid} p${pageNo} ${mb(bytes)} -> ${target}`);
      const seconds = page?.duration ?? info.duration;
      return [
        `已下载《${info.title}》第 ${pageNo} P（${qualityLabel(play.quality || qn)}，${mb(bytes)}，${mmss(seconds)}）`,
        `path: ${target}`,
        `下一步：把 path 传给 qqbot_describe_video（要文字稿再加 qqbot_transcribe）。`,
      ].join('\n');
    },
  };

  tools.register(definition);
  logger.info('im-qqbot: qqbot_video_fetch 已注册');
}
