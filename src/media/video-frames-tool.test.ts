import { execFileSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm';
import type { VisionConfig } from '../config.ts';
import { locateFfmpeg, type FfmpegBins } from './video-tool.ts';
import { registerVideoFramesTool } from './video-frames-tool.ts';

const hooks = vi.hoisted(() => ({ launched: undefined as ((args: string[], child: ChildProcess) => void) | undefined }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const wrapped = (...args: Parameters<typeof original.execFile>) => {
    const child = original.execFile(...args);
    hooks.launched?.(args[1] as string[], child);
    return child;
  };
  // Node's execFile has a custom promisifier returning both stdout and stderr.
  Object.defineProperty(wrapped, promisify.custom, { value: (file: string, args: string[], options: object) =>
    new Promise((resolve, reject) => {
      const child = original.execFile(file, args, options, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
      hooks.launched?.(args, child);
    }) });
  return { ...original, execFile: wrapped };
});

type Attachment = ImageBlock['attachment'];
interface Result { video: string; duration: number; frames: Array<{ timestamp: number; width: number; height: number; attachment: Attachment }> }
interface Tool {
  name: string;
  output: { schema: unknown; render(args: unknown, result: unknown): ContentBlock[] };
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<Result>;
}
const ROOT = join(tmpdir(), 'dsh-qqbot-video-frames-tests');
const vision = { enabled: true, native: true, provider: '', model: '', defaultPrompt: '',
  maxBytes: 10 * 1024 * 1024, maxTokens: 256, timeoutMs: 1000 } satisfies VisionConfig;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let bins: FfmpegBins;
let dir: string;
let clip: string;
let work: string;
let counter = 0;

function run(args: string[]): void { execFileSync(bins.ffmpeg, ['-v', 'error', '-y', ...args], { stdio: 'ignore' }); }
function register(options: { maxBytes?: number; save?: (input: { data: Uint8Array }) => Promise<Attachment> } = {}) {
  let tool!: Tool;
  const saved: Uint8Array[] = [];
  const saveImage = vi.fn(async (input: { data: Uint8Array }) => {
    saved.push(input.data);
    if (options.save) return options.save(input);
    return { attachmentId: `sha256:test-${saved.length}`, mediaType: 'image/jpeg' as const,
      bytes: input.data.byteLength, width: 320, height: 180 };
  });
  const ctx = { get: (name: string) => name === 'tools' ? { register: (value: Tool) => { tool = value; } }
    : name === 'attachments' ? { saveImage } : undefined } as unknown as Context;
  registerVideoFramesTool(ctx, bins, { ...vision, maxBytes: options.maxBytes ?? vision.maxBytes }, logger, work);
  return { tool, saved, saveImage };
}
function execute(tool: Tool, args: unknown, signal = new AbortController().signal) { return tool.execute(args, { signal }); }
function expectClean() { expect(readdirSync(work)).toEqual([]); }
function pixel(data: Uint8Array): number[] {
  const path = join(dir, `pixel-${counter++}.jpg`);
  const raw = join(dir, `pixel-${counter++}.rgb`);
  writeFileSync(path, data);
  run(['-i', path, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw]);
  return [...readFileSync(raw)];
}

beforeAll(async () => {
  const found = await locateFfmpeg('');
  if (!found) throw new Error('These tests require real ffmpeg/ffprobe');
  bins = found;
  mkdirSync(ROOT, { recursive: true });
  dir = mkdtempSync(join(ROOT, 'run-'));
  work = join(dir, 'work');
  mkdirSync(work);
  clip = join(dir, 'colors.mp4');
  run(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=1:r=10',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=1:r=10',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=1:r=10',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
}, 30_000);
afterEach(() => { hooks.launched = undefined; vi.clearAllMocks(); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('qqbot_video_frames', () => {
  it('passes the installed dsh output-schema validator before plugin activation', async () => {
    const toolsUrl = pathToFileURL(join(process.env.APPDATA!, 'npm', 'node_modules', '@deepseek-ai', 'dsh',
      'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href;
    const host = await import(/* @vite-ignore */ toolsUrl) as { assertSupportedJsonSchema(schema: unknown): void };
    const { tool } = register();
    expect(() => host.assertSupportedJsonSchema(tool.output.schema)).not.toThrow();
  });

  it('extracts exact source offsets as separate JPEG refs, removes duplicate offsets, renders native images', async () => {
    const { tool, saved } = register();
    const result = await execute(tool, { video: clip, timestamps: [2.2, 0.2, 1.2, 0.2] });
    expect(tool.name).toBe('qqbot_video_frames');
    expect(result.duration).toBeCloseTo(3);
    expect(result.frames.map(frame => frame.timestamp)).toEqual([2.2, 0.2, 1.2]);
    expect(result.frames.every(frame => frame.width === 320 && frame.height === 180)).toBe(true);
    expect(saved).toHaveLength(3);
    saved.forEach(bytes => expect([...bytes.slice(0, 3)]).toEqual([255, 216, 255]));
    const colors = saved.map(pixel);
    expect(colors[0]![2]).toBeGreaterThan(240);
    expect(colors[0]![0]).toBeLessThan(10);
    expect(colors[1]![0]).toBeGreaterThan(240);
    expect(colors[2]![1]).toBeGreaterThan(100);
    expect(colors[2]![0]).toBeLessThan(10);
    const blocks = tool.output.render({}, result);
    expect(blocks.map(block => block.type)).toEqual(['text', 'text', 'image', 'text', 'image', 'text', 'image']);
    expect(blocks[1]).toEqual({ type: 'text', text: 'Frame at requested 2.2s — 320×180px' });
    expect(blocks[2]).toEqual({ type: 'image', attachment: result.frames[0]!.attachment });
    expect(JSON.stringify(result)).not.toContain('base64');
    expect(JSON.stringify(result)).not.toContain(work.replaceAll('\\', '\\\\'));
    expectClean();
  });

  it('crops original pixels before scaling without rounding odd crop coordinates or upscaling', async () => {
    const split = join(dir, 'split.mp4');
    run(['-f', 'lavfi', '-i', 'color=red:s=320x180:d=1:r=1,drawbox=x=160:y=0:w=160:h=180:color=blue:t=fill',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', split]);
    const { tool, saved } = register();
    const result = await execute(tool, { video: split, timestamps: [0], crop: { x: 191, y: 11, width: 101, height: 99 } });
    expect(result.frames[0]).toMatchObject({ width: 101, height: 99 });
    const rgb = pixel(saved[0]!);
    expect(rgb[2]).toBeGreaterThan(240);
    expect(rgb[0]).toBeLessThan(10);
    expectClean();
  });

  it.each([[2400, 1200, 1920, 960], [1200, 2400, 960, 1920]])(
    'bounds the longest side for a %ix%i source', async (width, height, outWidth, outHeight) => {
      const large = join(dir, `large-${width}.mp4`);
      run(['-f', 'lavfi', '-i', `color=red:s=${width}x${height}:d=1:r=1`, '-c:v', 'libx264', '-preset', 'ultrafast', large]);
      const { tool } = register();
      const result = await execute(tool, { video: large, timestamps: [0] });
      expect(result.frames[0]).toMatchObject({ width: outWidth, height: outHeight });
      expectClean();
    }, 30_000);

  it('honors display rotation and rejects crop for rotated videos', async () => {
    const rotated = join(dir, 'rotated.mp4');
    run(['-display_rotation', '90', '-i', clip, '-c', 'copy', rotated]);
    const { tool, saveImage } = register();
    await expect(execute(tool, { video: rotated, timestamps: [0], crop: { x: 0, y: 0, width: 10, height: 10 } })).rejects.toThrow('rotated');
    expect(saveImage).not.toHaveBeenCalled();
    const result = await execute(tool, { video: rotated, timestamps: [0] });
    expect(result.frames[0]).toMatchObject({ width: 180, height: 320 });
    expectClean();
  });

  it.each([
    { timestamps: [] }, { timestamps: [0, 0, 0, 0, 0, 0, 0] }, { timestamps: [-1] },
    { timestamps: [NaN] }, { timestamps: [Infinity] }, { timestamps: ['1'] }, { timestamps: [3] },
    { timestamps: [0], crop: { x: -1, y: 0, width: 10, height: 10 } },
    { timestamps: [0], crop: { x: 0, y: 0, width: 0, height: 10 } },
    { timestamps: [0], crop: { x: 0.5, y: 0, width: 10, height: 10 } },
    { timestamps: [0], crop: { x: 319, y: 0, width: 2, height: 10 } },
    { timestamps: [0], crop: { x: 0, y: 179, width: 10, height: 2 } },
  ])('rejects invalid timestamp/crop arguments %# before any extraction/save', async args => {
    const { tool, saveImage } = register();
    const extracted: string[][] = [];
    hooks.launched = args => { if (args.includes('-frames:v')) extracted.push(args); };
    await expect(execute(tool, { video: clip, ...args })).rejects.toThrow();
    expect(extracted).toEqual([]);
    expect(saveImage).not.toHaveBeenCalled();
    expectClean();
  });

  it('rejects relative paths, nonexistent files, directories and non-video files', async () => {
    const text = join(dir, 'invalid.txt');
    writeFileSync(text, 'not a video');
    const { tool, saveImage } = register();
    for (const path of ['relative.mp4', join(dir, 'missing.mp4'), dir, text]) {
      await expect(execute(tool, { video: path, timestamps: [0] })).rejects.toThrow();
    }
    expect(saveImage).not.toHaveBeenCalled();
    expectClean();
  });

  it('enforces the per-image byte budget before saving attachments', async () => {
    const { tool, saveImage } = register({ maxBytes: 10 });
    await expect(execute(tool, { video: clip, timestamps: [0] })).rejects.toThrow('maxBytes');
    expect(saveImage).not.toHaveBeenCalled();
    expectClean();
  });

  it('enforces the 24MiB aggregate budget before saving any attachment', async () => {
    // Trailing JPEG padding keeps real frame decoding while exercising the size guard deterministically.
    hooks.launched = (args, child) => {
      if (args.includes('-frames:v')) child.once('exit', code => {
        if (code === 0) appendFileSync(args.at(-1)!, Buffer.alloc(5 * 1024 * 1024));
      });
    };
    const { tool, saveImage } = register();
    await expect(execute(tool, { video: clip, timestamps: [0, 0.2, 0.4, 0.6, 0.8] })).rejects.toThrow('24MiB');
    expect(saveImage).not.toHaveBeenCalled();
    expectClean();
  });

  it('does not start any child or save for a pre-aborted request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('preabort'));
    const launched = vi.fn();
    hooks.launched = launched;
    const { tool, saveImage } = register();
    await expect(execute(tool, { video: clip, timestamps: [0] }, controller.signal)).rejects.toThrow('preabort');
    expect(launched).not.toHaveBeenCalled();
    expect(saveImage).not.toHaveBeenCalled();
    expectClean();
  });

  it.each(['probe', 'extract'])('propagates abort to a running %s child and cleans its workdir', async stage => {
    const controller = new AbortController();
    let child: ChildProcess | undefined;
    hooks.launched = (args, launched) => {
      if ((stage === 'probe' && args.includes('format=duration:stream=codec_type'))
        || (stage === 'extract' && args.includes('-frames:v'))) {
        child = launched;
        controller.abort(new Error(`abort ${stage}`));
      }
    };
    const { tool, saveImage } = register();
    await expect(execute(tool, { video: clip, timestamps: [0] }, controller.signal)).rejects.toThrow(/abort/i);
    expect(child).toBeDefined();
    expect(child!.killed).toBe(true);
    expect(saveImage).not.toHaveBeenCalled();
    expectClean();
  });

  it('stops waiting on a pending attachment save when cancelled', async () => {
    const controller = new AbortController();
    let release!: (value: Attachment) => void;
    const { tool, saveImage } = register({ save: () => {
      controller.abort(new Error('abort save'));
      return new Promise(resolve => { release = resolve; });
    } });
    await expect(execute(tool, { video: clip, timestamps: [0, 1] }, controller.signal)).rejects.toThrow('abort save');
    expect(saveImage).toHaveBeenCalledTimes(1);
    release({ attachmentId: 'sha256:late', mediaType: 'image/jpeg', bytes: 1, width: 1, height: 1 });
    expectClean();
  });

  it('cleans up after an attachment-store failure', async () => {
    const { tool } = register({ save: async () => { throw new Error('store failed'); } });
    await expect(execute(tool, { video: clip, timestamps: [0] })).rejects.toThrow('store failed');
    expectClean();
  });

  it.each(['tools', 'attachments'])('skips registration when %s is missing', missing => {
    const register = vi.fn();
    const ctx = { get: (name: string) => name === missing ? undefined
      : name === 'tools' ? { register } : { saveImage: vi.fn() } } as unknown as Context;
    registerVideoFramesTool(ctx, bins, vision, logger, work);
    expect(register).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('qqbot_video_frames'));
  });
});
