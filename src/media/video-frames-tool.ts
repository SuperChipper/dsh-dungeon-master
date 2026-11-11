import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm';
import type { VisionConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { probeVideo, type FfmpegBins } from './video-tool.ts';
import type { AttachmentStoreLike } from './vision-tool.ts';

const execFileAsync = promisify(execFile);
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
export const VIDEO_FRAMES_TOOL_NAME = 'qqbot_video_frames';

type Attachment = ImageBlock['attachment'];
interface Crop { x: number; y: number; width: number; height: number }
interface Frame { timestamp: number; width: number; height: number; attachment: Attachment }
interface Result { video: string; duration: number; frames: Frame[] }
interface Dimensions { width: number; height: number; rotated: boolean }

const DESCRIPTION = 'Extract 1–6 individual frames from an original local video directly into your own image context. '
  + 'Use after qqbot_describe_video is blurry or for OCR, UI, and small visual details: request the same or neighboring '
  + 'time and optionally crop the relevant pixel region for a closer view. Timestamps are seconds in the original '
  + 'video, not a summarized segment. Duplicate timestamps are extracted once, in request order. Read the returned '
  + 'images yourself; this tool does not call another vision model or send anything to QQ. Each JPEG keeps original '
  + 'resolution up to a 1920px longest side, with no upscaling; crop coordinates use original unrotated pixels. '
  + 'Crop is rejected for rotated videos. At most 24MiB total images per call.';

function fail(message: string): never { throw new Error(`${VIDEO_FRAMES_TOOL_NAME}: ${message}`); }

async function dimensions(bins: FfmpegBins, path: string, signal: AbortSignal): Promise<Dimensions> {
  signal.throwIfAborted();
  const { stdout } = await execFileAsync(bins.ffprobe, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height:stream_tags=rotate:stream_side_data=rotation', '-of', 'json', path,
  ], { timeout: TIMEOUT_MS, signal });
  signal.throwIfAborted();
  const json = JSON.parse(stdout) as { streams?: Array<{
    width?: number; height?: number; tags?: { rotate?: string };
    side_data_list?: Array<{ rotation?: number }>;
  }> };
  const stream = json.streams?.[0];
  const width = stream?.width, height = stream?.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! <= 0 || height! <= 0) {
    fail('no readable video stream dimensions');
  }
  const rotations = [stream?.tags?.rotate, ...(stream?.side_data_list ?? []).map(item => item.rotation)]
    .filter(value => value !== undefined).map(Number);
  return { width: width!, height: height!, rotated: rotations.some(value => !Number.isFinite(value) || value % 360 !== 0) };
}

// The host store currently has no signal parameter. Stop waiting on abort and never return a cancelled save.
async function saveImage(attachments: AttachmentStoreLike, data: Uint8Array, name: string, signal: AbortSignal): Promise<Attachment> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return attachments.saveImage({ data, mediaType: 'image/jpeg', name });
    }).then(ref => {
      signal.throwIfAborted();
      resolve(ref);
    }).catch(reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function validateArgs(args: unknown): { video: string; timestamps: number[]; crop?: Crop } {
  if (!args || typeof args !== 'object') fail('arguments must be an object');
  const { video, timestamps, crop } = args as { video?: unknown; timestamps?: unknown; crop?: unknown };
  if (typeof video !== 'string' || !isAbsolute(video)) fail('video must be an absolute local path');
  if (!Array.isArray(timestamps) || timestamps.length < 1 || timestamps.length > 6
    || timestamps.some(time => typeof time !== 'number' || !Number.isFinite(time) || time < 0)) {
    fail('timestamps must contain 1–6 finite nonnegative seconds');
  }
  if (crop !== undefined) {
    if (!crop || typeof crop !== 'object') fail('crop must be a pixel rectangle');
    const rect = crop as Crop;
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger)
      || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) {
      fail('crop x/y must be nonnegative integers and width/height positive integers');
    }
  }
  return { video, timestamps: [...new Set(timestamps as number[])], crop: crop as Crop | undefined };
}

/** Called only after ffmpeg has been located by the parent video registration. */
export function registerVideoFramesTool(
  ctx: Context, bins: FfmpegBins, vision: VisionConfig, logger: Logger, tmpRoot: string,
): void {
  const tools = ctx.get('tools') as { register(definition: unknown): unknown } | undefined;
  const attachments = ctx.get('attachments') as AttachmentStoreLike | undefined;
  if (!tools?.register || !attachments?.saveImage) {
    logger.warn('im-qqbot: tools/attachments 服务不可用，qqbot_video_frames 工具未注册');
    return;
  }
  const perImageLimit = Math.min(vision.maxBytes, MAX_TOTAL_BYTES);
  tools.register({
    name: VIDEO_FRAMES_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object', properties: {
        video: { type: 'string', description: 'Absolute local path to the original video.' },
        timestamps: { type: 'array', minItems: 1, maxItems: 6,
          items: { type: 'number', minimum: 0 }, description: 'Original-video offsets in seconds, each strictly before video duration; duplicates are removed.' },
        crop: { type: 'object', properties: {
          x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 },
          width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 },
        }, required: ['x', 'y', 'width', 'height'], additionalProperties: false,
        description: 'Optional original-pixel rectangle applied before scaling. Must fit the video; rotated videos reject crop.' },
      }, required: ['video', 'timestamps'], additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object', properties: {
          video: { type: 'string' }, duration: { type: 'number' },
          // dsh output schemas accept only their documented subset; validate counts in execute.
          frames: { type: 'array', items: {
            type: 'object', properties: {
              timestamp: { type: 'number' }, width: { type: 'integer' }, height: { type: 'integer' },
              attachment: { type: 'object', additionalProperties: true },
            }, required: ['timestamp', 'width', 'height', 'attachment'], additionalProperties: false,
          } },
        }, required: ['video', 'duration', 'frames'], additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const result = value as Result;
        const blocks: ContentBlock[] = [{ type: 'text', text: `Original video duration: ${result.duration}s. Requested offsets below are original-video seconds.` }];
        for (const frame of result.frames) {
          blocks.push({ type: 'text', text: `Frame at requested ${frame.timestamp}s — ${frame.width}×${frame.height}px` });
          blocks.push({ type: 'image', attachment: frame.attachment });
        }
        return blocks;
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal }): Promise<Result> {
      const { signal } = exec;
      signal.throwIfAborted();
      const { video, timestamps, crop } = validateArgs(args);
      if (!Number.isFinite(perImageLimit) || perImageLimit <= 0) fail('vision.maxBytes must be positive');
      const info = await stat(video).catch(error => {
        signal.throwIfAborted();
        fail(`video file not found or unreadable: ${error instanceof Error ? error.message : String(error)}`);
      });
      signal.throwIfAborted();
      if (!info.isFile()) fail('video must be a regular file');
      const { duration } = await probeVideo(bins, video, signal);
      signal.throwIfAborted();
      if (timestamps.some(time => time >= duration)) fail(`timestamps must be < video duration (${duration}s)`);
      const source = await dimensions(bins, video, signal);
      if (crop) {
        if (source.rotated) fail('crop is unsupported for rotated video; omit crop');
        if (crop.x + crop.width > source.width || crop.y + crop.height > source.height) fail(`crop exceeds ${source.width}×${source.height} source bounds`);
      }
      signal.throwIfAborted();
      await mkdir(tmpRoot, { recursive: true });
      signal.throwIfAborted();
      const work = await mkdtemp(join(tmpRoot, 'qqbot-video-frames-'));
      try {
        const extracted: Array<{ timestamp: number; path: string; width: number; height: number }> = [];
        let totalBytes = 0;
        for (const [index, timestamp] of timestamps.entries()) {
          signal.throwIfAborted();
          const path = join(work, `frame-${index}.jpg`);
          const filters = crop ? [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}:exact=1`] : [];
          // min(1, ...) preserves small source pixels and bounds portrait as well as landscape frames.
          filters.push("scale=w='max(1,trunc(iw*min(1,1920/max(iw,ih))))':h='max(1,trunc(ih*min(1,1920/max(iw,ih))))'");
          await execFileAsync(bins.ffmpeg, [
            '-v', 'error', '-y', '-ss', String(timestamp), '-i', video, '-map', '0:v:0',
            '-vf', filters.join(','), '-frames:v', '1', '-q:v', '2', path,
          ], { timeout: TIMEOUT_MS, signal });
          signal.throwIfAborted();
          const frameInfo = await stat(path);
          totalBytes += frameInfo.size;
          if (frameInfo.size > perImageLimit) fail(`frame at ${timestamp}s exceeds vision.maxBytes (${frameInfo.size} bytes)`);
          if (totalBytes > MAX_TOTAL_BYTES) fail('frames exceed the 24MiB total image budget');
          const size = await dimensions(bins, path, signal);
          extracted.push({ timestamp, path, width: size.width, height: size.height });
        }
        // Validate the whole batch's size before any persistent attachment is created.
        const frames: Frame[] = [];
        for (const frame of extracted) {
          signal.throwIfAborted();
          const data = await readFile(frame.path, { signal });
          const attachment = await saveImage(attachments, data, `${basename(video)}.${frame.timestamp}s.jpg`, signal);
          frames.push({ timestamp: frame.timestamp, width: frame.width, height: frame.height, attachment });
        }
        signal.throwIfAborted();
        return { video, duration, frames };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  });
  logger.info('im-qqbot: qqbot_video_frames 工具已注册 (frames≤6, longest side≤1920)');
}
