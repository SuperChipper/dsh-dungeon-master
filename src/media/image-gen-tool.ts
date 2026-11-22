/**
 * 内置 qqbot_image_gen 工具 — 对接 OpenAI GPT Image 2.6（Sunburst / 标准版）生图与多参考图编辑。
 *
 *   - 无参考图走 POST {baseUrl}/images/generations（JSON）；
 *   - 传 1~16 张本地参考图走 POST {baseUrl}/images/edits（multipart/form-data，支持可选 mask）；
 *   - 默认仅主人私聊、完全权限会话与允许生图群可调用；可在配置开启 allowAllGroups 放开全部群；
 *   - 默认存盘返回本地路径，方便模型检查、裁图做表情包或配合 qqbot_send_file；传 send=true 可直接发图。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import {
  IMAGE_GEN_COMPLEXITIES,
  IMAGE_GEN_QUALITIES,
  type ImageGenComplexity,
  type ImageGenQuality,
  type ImQQBotConfig,
} from '../config.ts';
import { canUseImageGen } from '../features/group-access-policy.ts';
import type { DshAgent, SessionManager, SessionRecord } from '../session/index.ts';
import { isSensitivePath } from '../shared/file-access.ts';
import { canonical, sensitivePathsApply } from '../shared/tool-guard.ts';
import { fetchSafe } from '../transport/attachment.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import { resolveOptionalKey } from './chat-gateway.ts';
import { parseTarget, withFreshReplyTarget, type MediaSenderLike } from './send-file-tool.ts';
import { resolveTmpDir } from './tmp-dir.ts';
import { sniffImageMediaType } from './vision-tool.ts';

export const IMAGE_GEN_TOOL_NAME = 'qqbot_image_gen';

const MAX_REF_IMAGES = 16;
const MAX_REF_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_BATCH = 4;

const OUTPUT_FORMATS = ['png', 'jpeg', 'webp'] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

const BACKGROUNDS = ['auto', 'transparent', 'opaque'] as const;
type ImageBackground = (typeof BACKGROUNDS)[number];

let fileSeq = 0;

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>;
}

interface ImageGenArgs {
  prompt: string;
  images?: string[];
  mask?: string;
  variant?: 'sunburst' | 'standard';
  model?: string;
  size?: string;
  quality?: ImageGenQuality;
  background?: ImageBackground;
  output_format?: OutputFormat;
  complexity?: Exclude<ImageGenComplexity, ''>;
  n?: number;
  out_dir?: string;
  send?: boolean;
  caption?: string;
  target?: string;
}

interface ImageGenOutput {
  files: string[];
  model: string;
  size: string;
  quality: string;
  background: string;
  sent: boolean;
  target?: string;
  revisedPrompts?: string[];
}

const DESCRIPTION =
  'Generate or edit images using OpenAI GPT Image (defaults to gpt-image-2.6-sunburst for high-precision '
  + 'generation and multi-reference editing, or variant="standard" for standard speed). '
  + 'Omit `images` for text-to-image; pass 1-16 local image paths in `images` for character-consistent '
  + 'editing/remixing (plus optional PNG `mask` when editing a single image). '
  + 'Use background="transparent" with png/webp for stickers or cutouts. '
  + 'By default (`send=false`), files are saved to disk and their paths are returned so you can inspect '
  + 'or post-process them, or deliver them via qqbot_send_file. Set `send=true` (and optional short `caption`) '
  + 'to immediately send the generated image(s) to the current QQ chat. If a group user asks to enable image generation, '
  + 'use qqbot_access(capability="image_gen", action="grant") when available and wait for owner approval; do not request terminal or browser access.';

const SIZE_RE = /^(\d+)x(\d+)$/;

/** 校验 OpenAI GPT Image 尺寸参数：'auto' 或 256..3840 内的 16 倍数宽高，比例不超过 3:1 */
export function validateImageGenSize(
  size: string,
): { ok: true; normalized: string } | { ok: false; reason: string } {
  const normalized = size.trim().toLowerCase();
  if (normalized === 'auto') return { ok: true, normalized: 'auto' };
  const match = SIZE_RE.exec(normalized);
  if (!match) {
    return { ok: false, reason: `size 必须是 "auto" 或 "WIDTHxHEIGHT"（如 1024x1024），收到: ${size}` };
  }
  const w = Number.parseInt(match[1]!, 10);
  const h = Number.parseInt(match[2]!, 10);
  if (w < 256 || w > 3840 || h < 256 || h > 3840) {
    return { ok: false, reason: `size 宽高必须在 256..3840 之间，收到: ${w}x${h}` };
  }
  if (w % 16 !== 0 || h % 16 !== 0) {
    return { ok: false, reason: `size 宽高必须都是 16 的整数倍，收到: ${w}x${h}` };
  }
  if (w > 3 * h || h > 3 * w) {
    return { ok: false, reason: `size 宽高比不能超过 3:1，收到: ${w}x${h}` };
  }
  return { ok: true, normalized: `${w}x${h}` };
}

export { canUseImageGen };

async function resolveImageGenApiKey(
  ctx: Context,
  config: Pick<ImQQBotConfig, 'imageGen'>,
): Promise<string> {
  const direct = config.imageGen.apiKey?.trim();
  if (direct) return direct;
  const keyRef = config.imageGen.apiKeyEnv?.trim() || 'OPENAI_API_KEY';
  const credentials = ctx.get('credentials') as CredentialsLike | undefined;
  const fromCreds = (await credentials?.resolve(keyRef))?.value;
  if (fromCreds !== undefined && fromCreds !== '') return fromCreds;
  const fallback = await resolveOptionalKey(keyRef);
  if (fallback !== undefined && fallback !== '') return fallback;
  throw new Error(`qqbot_image_gen: 缺少 API Key，请配置 imageGen.apiKey 或凭证/环境变量 ${keyRef}`);
}

function extForGeneratedImage(bytes: Uint8Array, requestedFormat: OutputFormat): string {
  const sniffed = sniffImageMediaType(bytes);
  if (sniffed === 'image/png') return 'png';
  if (sniffed === 'image/jpeg') return 'jpg';
  if (sniffed === 'image/webp') return 'webp';
  if (sniffed === 'image/gif') return 'gif';
  return requestedFormat === 'jpeg' ? 'jpg' : requestedFormat;
}

async function readCheckedImage(absPath: string, requirePng = false): Promise<{ data: Uint8Array; mime: string }> {
  if (!existsSync(absPath)) throw new Error(`qqbot_image_gen: 参考图不存在: ${absPath}`);
  const info = await stat(absPath);
  if (!info.isFile()) throw new Error(`qqbot_image_gen: 路径不是普通文件: ${absPath}`);
  if (info.size > MAX_REF_BYTES) {
    throw new Error(`qqbot_image_gen: 图片超过 50MB 上限 (${info.size} bytes): ${absPath}`);
  }
  const data = new Uint8Array(await readFile(absPath));
  const mime = sniffImageMediaType(data);
  if (mime === null) {
    throw new Error(`qqbot_image_gen: 不支持的图片格式（仅限 png/jpeg/webp/gif）: ${absPath}`);
  }
  if (requirePng && mime !== 'image/png') {
    throw new Error(`qqbot_image_gen: mask 必须是 PNG 图片，收到 ${mime}: ${absPath}`);
  }
  return { data, mime };
}

async function fetchImageUrl(
  url: string,
  baseUrl: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const targetUrl = new URL(url);
  const gatewayUrl = new URL(baseUrl);
  // 同一中转域名（含自建局域网网关）直接按配置超时拉取；外域链接强制走 fetchSafe 防 SSRF
  if (targetUrl.origin === gatewayUrl.origin) {
    const resp = await fetch(targetUrl.href, { signal });
    if (!resp.ok) throw new Error(`下载生成图失败 (HTTP ${resp.status})`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`下载生成图超过 50MB 上限 (${buf.length} bytes)`);
    }
    return buf;
  }
  return fetchSafe(url, MAX_DOWNLOAD_BYTES, { signal, timeoutMs });
}

function isApiErrorBody(value: unknown): value is { error?: { message?: unknown } } {
  return typeof value === 'object' && value !== null;
}

/** 注册 qqbot_image_gen 生图工具 */
export function registerImageGenTool(
  ctx: Context,
  bot: MediaSenderLike,
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_image_gen 工具未注册');
    return;
  }

  const ig = config.imageGen;
  const cwd = config.cwd || process.cwd();

  tools.register({
    name: IMAGE_GEN_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed prompt describing the image to generate or edit instructions for reference images.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_REF_IMAGES,
          description: 'Optional local paths (1-16) to reference/source images. When provided, uses /images/edits.',
        },
        mask: {
          type: 'string',
          description: 'Optional local path to a transparent PNG mask (only allowed when editing a single image).',
        },
        variant: {
          type: 'string',
          enum: ['sunburst', 'standard'],
          description: 'Model preset: "sunburst" (default high precision) or "standard" (faster/standard tier).',
        },
        model: {
          type: 'string',
          description: 'Optional explicit model ID overriding `variant`.',
        },
        size: {
          type: 'string',
          description: 'Output dimensions: "auto" or "WIDTHxHEIGHT" (multiples of 16 in 256..3840, aspect ratio <= 3:1).',
        },
        quality: {
          type: 'string',
          enum: [...IMAGE_GEN_QUALITIES],
          description: 'Rendering quality: auto, low, medium, high, xhigh, max.',
        },
        background: {
          type: 'string',
          enum: [...BACKGROUNDS],
          description: 'Background mode: auto, transparent (requires png/webp), or opaque.',
        },
        output_format: {
          type: 'string',
          enum: [...OUTPUT_FORMATS],
          description: 'Image format: png (default), jpeg, or webp.',
        },
        complexity: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'GPT Image 2.6 detail complexity: low, medium, or high.',
        },
        n: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_BATCH,
          description: 'Number of images to generate (1-4, default 1).',
        },
        out_dir: {
          type: 'string',
          description: 'Optional directory to save generated files; defaults to tmp/imagegen.',
        },
        send: {
          type: 'boolean',
          description: 'When true, immediately sends generated image(s) to QQ; default false (save and return paths).',
        },
        caption: {
          type: 'string',
          description: 'Optional short companion message attached when `send` is true (at most two sentences, no repetition).',
        },
        target: {
          type: 'string',
          description: 'Optional explicit target ("c2c:openid" or "group:openid") when `send` is true.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' } },
          model: { type: 'string' },
          size: { type: 'string' },
          quality: { type: 'string' },
          background: { type: 'string' },
          sent: { type: 'boolean' },
          target: { type: 'string' },
          revisedPrompts: { type: 'array', items: { type: 'string' } },
        },
        required: ['files', 'model', 'size', 'quality', 'background', 'sent'],
        additionalProperties: false,
      },
      render: (args: unknown, value: unknown): ContentBlock[] => {
        const v = value as ImageGenOutput;
        const caption = (args as { caption?: unknown } | undefined)?.caption;
        const lines = [
          `已生成 ${v.files.length} 张图片（model=${v.model}, size=${v.size}, quality=${v.quality}, background=${v.background}）：`,
          ...v.files.map((f) => `- ${f}`),
        ];
        if (v.sent && v.target) {
          lines.push(`已直接发送至 ${v.target}。`);
          if (typeof caption === 'string' && caption.trim() !== '') {
            lines.push('caption 已随图片发出，不要在回复里重复 caption；没有别的新内容就直接回一个句号「。」');
          }
        } else {
          lines.push('文件已存盘（send=false）；可先看图检查或裁切，如需发图再调用 qqbot_send_file。');
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<ImageGenOutput> {
      exec.signal?.throwIfAborted();
      const input = (args ?? {}) as ImageGenArgs;
      const caller: SessionRecord | undefined = exec.agent === undefined
        ? undefined
        : manager.findByAgent(exec.agent as DshAgent);
      const isFullAccess = (s: { scope: ChatScope; peerId: string }): boolean =>
        manager.toolAccess?.isFullAccess(s) === true;

      if (!canUseImageGen(caller, config, isFullAccess)) {
        const hint = caller?.scope === 'group' && config.ownerOpenid?.trim()
          ? '；用户要求开通时，调用 qqbot_access(capability="image_gen", action="grant") 申请本群生图权限，等主人审批。不要申请终端或浏览权限。'
          : '。';
        throw new Error(`qqbot_image_gen: 当前会话未开通生图权限${hint}`);
      }

      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (prompt === '') throw new Error('qqbot_image_gen: `prompt` 不能为空');

      const rawImages = input.images ?? [];
      if (!Array.isArray(rawImages) || rawImages.some((p) => typeof p !== 'string' || p.trim() === '')) {
        throw new Error('qqbot_image_gen: `images` 必须是非空路径数组');
      }
      if (rawImages.length > MAX_REF_IMAGES) {
        throw new Error(`qqbot_image_gen: 参考图最多支持 ${MAX_REF_IMAGES} 张，收到 ${rawImages.length}`);
      }
      const rawMask = typeof input.mask === 'string' && input.mask.trim() !== '' ? input.mask.trim() : undefined;
      if (rawMask !== undefined && rawImages.length !== 1) {
        throw new Error('qqbot_image_gen: 传入 `mask` 时 `images` 必须且只能包含 1 张待编辑原图');
      }

      const chosenModel = input.model?.trim()
        || (input.variant === 'standard'
          ? (ig.standardModel?.trim() || ig.model?.trim() || 'gpt-image-2.6')
          : (ig.model?.trim() || 'gpt-image-2.6-sunburst'));

      const sizeCheck = validateImageGenSize(input.size ?? ig.defaultSize ?? '1024x1024');
      if (!sizeCheck.ok) throw new Error(`qqbot_image_gen: ${sizeCheck.reason}`);
      const chosenSize = sizeCheck.normalized;

      const chosenQuality = (input.quality ?? ig.defaultQuality ?? 'auto') as ImageGenQuality;
      if (!IMAGE_GEN_QUALITIES.includes(chosenQuality)) {
        throw new Error(`qqbot_image_gen: 非法 quality: ${String(chosenQuality)}`);
      }

      const chosenBg = (input.background ?? 'auto') as ImageBackground;
      if (!BACKGROUNDS.includes(chosenBg)) {
        throw new Error(`qqbot_image_gen: 非法 background: ${String(chosenBg)}`);
      }

      let chosenFormat = (input.output_format ?? 'png') as OutputFormat;
      if (!OUTPUT_FORMATS.includes(chosenFormat)) {
        throw new Error(`qqbot_image_gen: 非法 output_format: ${String(chosenFormat)}`);
      }
      if (chosenBg === 'transparent' && chosenFormat === 'jpeg') {
        chosenFormat = 'png';
      }

      const rawComplexity = (input.complexity ?? ig.defaultComplexity ?? '') as ImageGenComplexity;
      if (!IMAGE_GEN_COMPLEXITIES.includes(rawComplexity)) {
        throw new Error(`qqbot_image_gen: 非法 complexity: ${String(rawComplexity)}`);
      }

      const count = input.n ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) {
        throw new Error(`qqbot_image_gen: ` + '`n` 必须是 1..4 的整数');
      }

      const absImages = rawImages.map((p) => resolve(cwd, p.trim()));
      const absMask = rawMask === undefined ? undefined : resolve(cwd, rawMask);
      const absOutDir = input.out_dir?.trim()
        ? resolve(cwd, input.out_dir.trim())
        : join(resolveTmpDir(config), 'imagegen');

      const fullAccess = caller === undefined ? true : isFullAccess(caller);
      if (caller !== undefined && sensitivePathsApply(config, fullAccess)) {
        for (const p of [...absImages, ...(absMask === undefined ? [] : [absMask]), absOutDir]) {
          if (isSensitivePath(p, config) || isSensitivePath(canonical(p), config)) {
            throw new Error(`qqbot_image_gen: 路径位于敏感目录，禁止访问: ${p}`);
          }
        }
      }

      const sendNow = input.send === true;
      const captionText = typeof input.caption === 'string' && input.caption.trim() !== ''
        ? input.caption.trim()
        : undefined;
      let replyTarget: ReplyTarget | undefined;
      if (sendNow) {
        const explicitTarget = typeof input.target === 'string' && input.target.trim() !== ''
          ? input.target.trim()
          : undefined;
        if (explicitTarget !== undefined) {
          if (!fullAccess) {
            throw new Error('qqbot_image_gen: 受限群会话不允许通过 target 向其他会话发送图片');
          }
          replyTarget = parseTarget(explicitTarget);
          if (replyTarget === undefined) {
            throw new Error(`qqbot_image_gen: target 格式错误，需要 c2c:openid 或 group:openid，收到: ${explicitTarget}`);
          }
        } else if (caller !== undefined) {
          replyTarget = caller.replyTarget;
        }
        if (replyTarget === undefined) {
          throw new Error('qqbot_image_gen: send=true 时无法确定发送目标，请显式传 target');
        }
        replyTarget = withFreshReplyTarget(replyTarget);
      }

      exec.signal?.throwIfAborted();
      const apiKey = await resolveImageGenApiKey(ctx, config);
      exec.signal?.throwIfAborted();

      const baseUrl = (ig.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const timeoutSignal = AbortSignal.timeout(ig.timeoutMs || 180_000);
      const requestSignal = exec.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([timeoutSignal, exec.signal]);

      let response: Response;
      if (absImages.length === 0) {
        const payload: Record<string, unknown> = {
          model: chosenModel,
          prompt,
          n: count,
          size: chosenSize,
          quality: chosenQuality,
          background: chosenBg,
          output_format: chosenFormat,
        };
        if (rawComplexity !== '') payload.complexity = rawComplexity;
        response = await fetch(`${baseUrl}/images/generations`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: requestSignal,
        });
      } else {
        const refs = await Promise.all(absImages.map((p) => readCheckedImage(p, false)));
        const maskFile = absMask === undefined ? undefined : await readCheckedImage(absMask, true);
        requestSignal.throwIfAborted();

        const form = new FormData();
        if (refs.length === 1) {
          const rf = refs[0]!;
          form.append('image', new Blob([new Uint8Array(rf.data)], { type: rf.mime }), basename(absImages[0]!));
        } else {
          for (let i = 0; i < refs.length; i += 1) {
            const rf = refs[i]!;
            form.append('image[]', new Blob([new Uint8Array(rf.data)], { type: rf.mime }), basename(absImages[i]!));
          }
        }
        if (maskFile !== undefined && absMask !== undefined) {
          form.append('mask', new Blob([new Uint8Array(maskFile.data)], { type: maskFile.mime }), basename(absMask));
        }
        form.append('model', chosenModel);
        form.append('prompt', prompt);
        form.append('n', String(count));
        form.append('size', chosenSize);
        form.append('quality', chosenQuality);
        form.append('background', chosenBg);
        form.append('output_format', chosenFormat);
        if (rawComplexity !== '') form.append('complexity', rawComplexity);

        response = await fetch(`${baseUrl}/images/edits`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}` },
          body: form,
          signal: requestSignal,
        });
      }

      requestSignal.throwIfAborted();
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        requestSignal.throwIfAborted();
        throw new Error(`GPT Image 请求失败 (${response.status}): ${detail.slice(0, 300)}`);
      }

      const json = (await response.json()) as {
        data?: Array<{ b64_json?: unknown; url?: unknown; revised_prompt?: unknown }>;
      };
      requestSignal.throwIfAborted();

      if (!Array.isArray(json.data) || json.data.length === 0) {
        const msg = isApiErrorBody(json) && typeof json.error?.message === 'string' ? json.error.message : 'data 为空';
        throw new Error(`GPT Image 返回异常: ${msg}`);
      }

      mkdirSync(absOutDir, { recursive: true });
      const files: string[] = [];
      const revisedPrompts: string[] = [];
      const stamp = Date.now();
      fileSeq = (fileSeq + 1) % 10_000;

      for (let i = 0; i < json.data.length; i += 1) {
        requestSignal.throwIfAborted();
        const item = json.data[i]!;
        let bytes: Buffer;
        if (typeof item.b64_json === 'string' && item.b64_json.trim() !== '') {
          bytes = Buffer.from(item.b64_json, 'base64');
        } else if (typeof item.url === 'string' && item.url.trim() !== '') {
          bytes = await fetchImageUrl(item.url.trim(), baseUrl, ig.timeoutMs || 180_000, requestSignal);
        } else {
          throw new Error(`GPT Image 第 ${i + 1} 项既无 b64_json 也无 url`);
        }
        if (bytes.length === 0) throw new Error(`GPT Image 第 ${i + 1} 项图片字节为空`);

        const ext = extForGeneratedImage(bytes, chosenFormat);
        const outPath = join(absOutDir, `gen-${stamp}-${fileSeq}-${i + 1}.${ext}`);
        writeFileSync(outPath, bytes);
        files.push(outPath);

        if (typeof item.revised_prompt === 'string' && item.revised_prompt.trim() !== '') {
          revisedPrompts.push(item.revised_prompt.trim());
        }
      }

      let targetLabel: string | undefined;
      if (sendNow && replyTarget !== undefined) {
        targetLabel = `${replyTarget.scope}:${replyTarget.targetId}`;
        for (let i = 0; i < files.length; i += 1) {
          exec.signal?.throwIfAborted();
          const opts = i === 0 && captionText !== undefined ? { content: captionText } : undefined;
          await bot.sendImage(replyTarget, { localPath: files[i]! }, opts);
        }
      }

      logger.info(
        `im-qqbot: qqbot_image_gen ${absImages.length > 0 ? 'edits' : 'generations'} model=${chosenModel} `
        + `count=${files.length} sent=${sendNow}`,
      );

      return {
        files,
        model: chosenModel,
        size: chosenSize,
        quality: chosenQuality,
        background: chosenBg,
        sent: sendNow,
        ...(targetLabel !== undefined ? { target: targetLabel } : {}),
        ...(revisedPrompts.length > 0 ? { revisedPrompts } : {}),
      };
    },
  });

  logger.info(`im-qqbot: qqbot_image_gen 工具已注册 (model=${ig.model})`);
}
