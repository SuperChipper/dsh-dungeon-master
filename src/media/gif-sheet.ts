/**
 * 动图 GIF 的关键帧宫格 — 宿主把图片归一化成单帧 8bit sRGB
 * （dsh-attachment-local 的 canPassThroughNormalization 明确排除 image/gif 与 animated，
 * verifyNormalizedImage 还会断言产物单帧），动画到模型那里就没了。
 * 所以在插件侧先抽几帧拼成一张宫格图，宿主看到的仍是静态图，但动作信息没丢。
 */
import { execFile } from 'node:child_process';
import { dirname, extname, join } from 'node:path';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { resolveFfmpegBins } from './video-tool.ts';

const execFileAsync = promisify(execFile);
const FFMPEG_TIMEOUT_MS = 60_000;
/** 宫格最多几帧：3x3 已经够看懂一个表情包了，再多每格就糊 */
const MAX_SHEET_FRAMES = 9;
/** 每格宽度（等比缩放），够模型看清表情又不至于超过宿主的归一化预算 */
const SHEET_FRAME_WIDTH = 320;

export interface GifSheet {
  /** 宫格图本地路径 */
  path: string;
  /** 原动图总帧数 */
  frames: number;
}

/** GIF 文件头嗅探（GIF87a / GIF89a） */
export function isGifBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x38;
}

/**
 * 按 GIF 结构数字节里的帧数：每个图形控制扩展（0x21 0xF9 0x04）对应一帧。
 * ffprobe 在某些构建/环境下会返回空或 N/A，这时用字节数兜底，不至于把动图当单帧丢掉。
 */
export function countGifFrames(bytes: Uint8Array): number {
  if (!isGifBytes(bytes)) return 0;
  let frames = 0;
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xF9 && bytes[i + 2] === 0x04) frames++;
  }
  return frames;
}

/** 宫格布局：4 帧以内 2 列，再多 3 列，行数向上取整 */
export function sheetLayout(frames: number): { cols: number; rows: number; count: number } {
  const count = Math.max(1, Math.min(MAX_SHEET_FRAMES, frames));
  const cols = count <= 4 ? 2 : 3;
  return { cols, rows: Math.ceil(count / cols), count };
}

/** 抽帧用的 ffmpeg 滤镜：每 step 帧取一张，缩到固定宽，tile 拼宫格 */
export function sheetFilter(frames: number): string {
  const { cols, rows, count } = sheetLayout(frames);
  const step = Math.max(1, Math.floor(frames / count));
  // 逗号在 filtergraph 里是分隔符，表达式内的要转义
  return `select='not(mod(n\\,${step}))',scale=${SHEET_FRAME_WIDTH}:-2,tile=${cols}x${rows}`;
}

/**
 * 给一张 GIF 生成宫格图；单帧或非动图返回 undefined（那种情况宿主归一化就够了）。
 * ffmpeg 缺失或抽帧失败同样返回 undefined，调用方回退成原来的静态图。
 */
export async function makeGifSheet(
  gifPath: string,
  ffmpegPath = '',
  onWarn?: (message: string) => void,
  framesOverride?: number,
): Promise<GifSheet | undefined> {
  const bins = resolveFfmpegBins(ffmpegPath);
  let frames: number;
  if (framesOverride !== undefined && framesOverride > 1) {
    frames = framesOverride;
  } else {
    let rawFrames = '';
    try {
      const { stdout } = await execFileAsync(
        bins.ffprobe,
        ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', gifPath],
        { timeout: FFMPEG_TIMEOUT_MS },
      );
      rawFrames = String(stdout).trim();
      // csv 输出理论上就是 "36"，但不同构建可能带前导空格、N/A 或多列，捞第一个数字最稳
      const matched = rawFrames.match(/\d+/);
      frames = matched === null ? Number.NaN : Number(matched[0]);
    } catch (err) {
      onWarn?.(`ffprobe 调用失败（${bins.ffprobe}）：${describeExecError(err)}`);
      return undefined;
    }
    if (!Number.isFinite(frames) || frames <= 1) {
      onWarn?.(`ffprobe 报告帧数=${rawFrames || '<空>'}（ffprobe=${bins.ffprobe}），按单帧处理，不拼宫格`);
      return undefined;
    }
  }

  const out = join(dirname(gifPath), `${basename(gifPath, extname(gifPath))}_sheet.png`);
  try {
    await execFileAsync(
      bins.ffmpeg,
      ['-v', 'error', '-y', '-i', gifPath, '-vf', sheetFilter(frames), '-frames:v', '1', out],
      { timeout: FFMPEG_TIMEOUT_MS },
    );
  } catch (err) {
    onWarn?.(`ffmpeg 拼宫格失败（${bins.ffmpeg}）：${describeExecError(err)}`);
    return undefined;
  }
  return { path: out, frames };
}

/** execFile 失败原因：ENOENT 这类 code 比 message 更能说明问题 */
function describeExecError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const detail = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
  return code === undefined ? detail : `${code} ${detail}`;
}

/** 给模型的说明：这一坨格子的读法 */
export function buildGifSheetNote(sheet: GifSheet, layout = sheetLayout(sheet.frames)): string {
  return `[动图 GIF：${sheet.frames} 帧，上面是 ${layout.cols}x${layout.rows} 宫格，`
    + '按时间顺序从左到右、从上到下，当成一段连续动画看，不是几张无关的图]';
}
