/**
 * qqbot_fanart_pick — 一次抽几张百合同人图候选，拼成带编号的对比图交给模型挑。
 *
 * 模型看对比图挑一张，再用 qqbot_send_file 发出；发送成功后由 send-file 的回调
 * 把那张记为已发（markSentCandidate），没选中的候选下次还能抽到。
 */
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm';
import type { ImQQBotConfig } from '../config.ts';
import { loadNativeImageBlock, type AttachmentStoreLike } from '../media/native-image.ts';
import type { Logger } from '../types.ts';
import type { HttpGet } from './http.ts';
import { fetchBooruImage, sanitizeTags, type BooruFetchMode, type BooruFetchResult } from './booru-post.ts';
import { renderBooruFetchText } from './booru-tool.ts';
import { loadPool, pickFanart, type PickedCandidate, type PickResult, type PickSourceMode } from './pick.ts';
import type { FanartSeenStore } from './seen.ts';
import type { BooruPoolEntry, PixivPoolEntry } from './types.ts';

export const FANART_PICK_TOOL_NAME = 'qqbot_fanart_pick';
export const FANART_TOOL_NAME = 'qqbot_fanart';

const MAX_COUNT = 6;
const DEFAULT_COUNT = 3;
/** 对比图 / 单图进上下文的大小上限 */
const SHEET_MAX_BYTES = 5 * 1024 * 1024;
const MIN_EDGE_DEFAULT = 800;

const DESCRIPTION =
  'Fetch several yuri fan-art candidates at once (pixiv + safebooru, all-ages, both characters of the couple '
  + 'tag-matched, popularity-weighted, one image per artist) and return them with a numbered contact sheet. '
  + 'Look at the sheet, pick the best-drawn image whose characters really match the couple, then send ONLY that '
  + `one with qqbot_send_file (put the source link in the caption). Only the image you send is marked as posted; `
  + 'the rest can be drawn again later. If none is good enough, call this tool once more instead of sending a weak one.';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface PickArgs {
  count?: number;
  cp?: string;
  source?: string;
  cp_only?: boolean;
}

export interface FanartToolDeps {
  get: HttpGet;
  seen: FanartSeenStore;
  /** pixiv-tags.json / fanart-tags.json 所在目录 */
  poolDir: string;
  candidatesDir: string;
}

function describeCandidate(c: PickedCandidate): string {
  const parts = [
    `#${c.index}`,
    c.source,
    c.cp ? `「${c.cp}」` : '随机百合',
    c.author ? `画师 ${c.author}` : undefined,
    c.bookmarks !== undefined ? `收藏 ${c.bookmarks}` : '收藏未知',
    `${c.width}x${c.height}`,
  ].filter(Boolean);
  return `${parts.join(' · ')}\n   path: ${c.path}\n   出处: ${c.pageUrl}`;
}

export function renderPickText(v: PickResult, sheetAttached: boolean): string {
  if (v.candidates.length === 0) {
    return `这次没抽到可用的候选。${v.failures.length ? `\n原因：${v.failures.join('；')}` : ''}`;
  }
  const lines = [`抽到 ${v.candidates.length} 张候选：`, ...v.candidates.map(describeCandidate)];
  if (v.sheetPath) {
    lines.push(sheetAttached
      ? `对比图（编号对应上面）已附在下面：${v.sheetPath}`
      : `对比图（编号对应上面）：${v.sheetPath}，先看这张再挑。`);
  }
  lines.push('挑一张用 qqbot_send_file 发（caption 带出处链接）；只有发出去的那张会记为已发。');
  if (v.failures.length) lines.push(`部分查询失败：${v.failures.join('；')}`);
  return lines.join('\n');
}

interface FanartToolArgs extends PickArgs {
  action?: 'pick' | 'booru';
  tags?: string;
  mode?: string;
  min_edge?: number;
}

const UNIFIED_DESCRIPTION =
  'Yuri fan-art finder returning local image path(s) ready for qqbot_send_file (sent images are automatically marked seen). '
  + 'Choose action: '
  + '"pick" — fetch several couple-matched candidates (pixiv + safebooru) with a numbered contact sheet so you can pick the best one; '
  + '"booru" — search safebooru by tag query (`tags`, e.g. "shinosawa_hiro rating:general -ai-generated") and download ONE unseen image (mode="latest"|"random") for recurring character drops.';

/** L1 合并入口 `qqbot_fanart`：将候选挑图（pick）与按 tag 单抽（booru）按 action 收口 */
export function registerFanartTool(
  ctx: Context,
  config: ImQQBotConfig,
  deps: FanartToolDeps,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn(`im-qqbot: tools 服务不可用，${FANART_TOOL_NAME} 工具未注册`);
    return;
  }
  const attachments = ctx.get('attachments') as AttachmentStoreLike | undefined;

  tools.register({
    name: FANART_TOOL_NAME,
    description: UNIFIED_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['pick', 'booru'],
          description: '"pick" to fetch multiple candidates + contact sheet; "booru" to fetch one safebooru image by tags.',
        },
        count: { type: 'integer', description: `action="pick": how many candidates to fetch (1-${MAX_COUNT}, default ${DEFAULT_COUNT}).` },
        cp: { type: 'string', description: 'action="pick": optional couple name from the pool (e.g. "芙星"); omit to mix several couples.' },
        source: { type: 'string', enum: ['mix', 'pixiv', 'booru'], description: 'action="pick": which site to search (default mix).' },
        cp_only: { type: 'boolean', description: 'action="pick": booru only searches the couple pool (default false).' },
        tags: { type: 'string', description: 'action="booru" required: safebooru/danbooru tag query, e.g. "shinosawa_hiro rating:general -ai-generated".' },
        mode: { type: 'string', enum: ['latest', 'random'], description: 'action="booru": "latest" = newest unseen post; "random" = random unseen post (default).' },
        min_edge: { type: 'integer', description: `action="booru": reject images whose shorter side is below this many pixels (default ${MIN_EDGE_DEFAULT}).` },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as Record<string, unknown>;
        if (v.action === 'booru') {
          const b = v as unknown as BooruFetchResult & { image?: ImageBlock };
          const blocks: ContentBlock[] = [{ type: 'text', text: renderBooruFetchText(b, b.image !== undefined) }];
          if (b.image !== undefined) blocks.push(b.image);
          return blocks;
        }
        const p = v as unknown as PickResult & { sheetImage?: ImageBlock };
        const blocks: ContentBlock[] = [{ type: 'text', text: renderPickText(p, p.sheetImage !== undefined) }];
        if (p.sheetImage !== undefined) blocks.push(p.sheetImage);
        return blocks;
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const input = (args ?? {}) as FanartToolArgs;
      if (input.action === 'booru') {
        const tags = sanitizeTags(input.tags);
        if (tags === undefined) {
          return { action: 'booru', ok: false, reason: 'tags 为空或过长' } satisfies Record<string, unknown>;
        }
        const mode: BooruFetchMode = input.mode === 'latest' ? 'latest' : 'random';
        const minEdge = typeof input.min_edge === 'number' && Number.isFinite(input.min_edge)
          ? Math.min(2000, Math.max(400, Math.floor(input.min_edge)))
          : MIN_EDGE_DEFAULT;
        const started = Date.now();
        const result = await fetchBooruImage({ tags, mode }, {
          get: deps.get,
          candidatesDir: deps.candidatesDir,
          seen: deps.seen.load('booru'),
          minEdge,
        });
        let image: ImageBlock | undefined;
        if (result.ok && config.vision.native && attachments?.saveImage) {
          image = await loadNativeImageBlock(attachments, result.path, SHEET_MAX_BYTES).catch(() => undefined);
        }
        logger.info(
          `im-qqbot: qqbot_fanart(booru) ${mode} ${tags} → ${result.ok ? result.id : result.reason}（${Date.now() - started}ms）`,
        );
        return { action: 'booru', ...result, ...(image === undefined ? {} : { image }) } as unknown as Record<string, unknown>;
      }

      if (input.action !== 'pick') {
        throw new Error(`qqbot_fanart: 不支持的 action="${String(input.action)}"`);
      }

      const n = typeof input.count === 'number' && Number.isFinite(input.count)
        ? Math.min(MAX_COUNT, Math.max(1, Math.floor(input.count)))
        : DEFAULT_COUNT;
      const mode: PickSourceMode = input.source === 'pixiv' || input.source === 'booru' ? input.source : 'mix';
      const started = Date.now();
      const result = await pickFanart(
        { count: n, ...(typeof input.cp === 'string' && input.cp.trim() ? { cp: input.cp.trim() } : {}), source: mode, cpOnly: input.cp_only === true },
        {
          get: deps.get,
          seen: deps.seen,
          pixivPool: loadPool<PixivPoolEntry>(join(deps.poolDir, 'pixiv-tags.json'), (e) => !!e.name && !!e.words),
          booruPool: loadPool<BooruPoolEntry>(join(deps.poolDir, 'fanart-tags.json'), (e) => !!e.name && !!e.tags),
          candidatesDir: deps.candidatesDir,
        },
      );
      let sheetImage: ImageBlock | undefined;
      if (config.vision.native && attachments?.saveImage && result.sheetPath) {
        sheetImage = await loadNativeImageBlock(attachments, result.sheetPath, SHEET_MAX_BYTES).catch(() => undefined);
      }
      logger.info(
        `im-qqbot: qqbot_fanart(pick) ${result.candidates.length}/${n} 张，用时 ${Date.now() - started}ms`
        + (result.failures.length ? `，失败: ${result.failures.join('；')}` : ''),
      );
      return { action: 'pick', ...result, ...(sheetImage !== undefined ? { sheetImage } : {}) } as unknown as Record<string, unknown>;
    },
  });
  logger.info(`im-qqbot: ${FANART_TOOL_NAME} 工具已注册`);
}

export function registerFanartPickTool(
  ctx: Context,
  config: ImQQBotConfig,
  deps: FanartToolDeps,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_fanart_pick 工具未注册');
    return;
  }
  const attachments = ctx.get('attachments') as AttachmentStoreLike | undefined;

  tools.register({
    name: FANART_PICK_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: `How many candidates to fetch (1-${MAX_COUNT}, default ${DEFAULT_COUNT}).` },
        cp: { type: 'string', description: 'Optional couple name from the pool (e.g. "芙星"); omit to mix several couples.' },
        source: { type: 'string', enum: ['mix', 'pixiv', 'booru'], description: 'Which site to search (default mix).' },
        cp_only: { type: 'boolean', description: 'Booru: only search the couple pool, skip random yuri (default false).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as PickResult & { sheetImage?: ImageBlock };
        const blocks: ContentBlock[] = [{ type: 'text', text: renderPickText(v, v.sheetImage !== undefined) }];
        if (v.sheetImage !== undefined) blocks.push(v.sheetImage);
        return blocks;
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { count, cp, source, cp_only } = (args ?? {}) as PickArgs;
      const n = typeof count === 'number' && Number.isFinite(count)
        ? Math.min(MAX_COUNT, Math.max(1, Math.floor(count)))
        : DEFAULT_COUNT;
      const mode: PickSourceMode = source === 'pixiv' || source === 'booru' ? source : 'mix';
      const started = Date.now();

      const result = await pickFanart(
        { count: n, ...(typeof cp === 'string' && cp.trim() ? { cp: cp.trim() } : {}), source: mode, cpOnly: cp_only === true },
        {
          get: deps.get,
          seen: deps.seen,
          pixivPool: loadPool<PixivPoolEntry>(join(deps.poolDir, 'pixiv-tags.json'), (e) => !!e.name && !!e.words),
          booruPool: loadPool<BooruPoolEntry>(join(deps.poolDir, 'fanart-tags.json'), (e) => !!e.name && !!e.tags),
          candidatesDir: deps.candidatesDir,
        },
      );

      let sheetImage: ImageBlock | undefined;
      if (config.vision.native && attachments?.saveImage && result.sheetPath) {
        sheetImage = await loadNativeImageBlock(attachments, result.sheetPath, SHEET_MAX_BYTES).catch(() => undefined);
      }
      logger.info(
        `im-qqbot: qqbot_fanart_pick ${result.candidates.length}/${n} 张，用时 ${Date.now() - started}ms`
        + (result.failures.length ? `，失败: ${result.failures.join('；')}` : ''),
      );
      return { ...result, ...(sheetImage !== undefined ? { sheetImage } : {}) } as unknown as Record<string, unknown>;
    },
  });
  logger.info('im-qqbot: qqbot_fanart_pick 工具已注册');
}
