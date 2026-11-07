/**
 * qqbot_reverse_image — 以图搜图：拿一张图去外部服务查「这是哪部作品 / 谁画的 / 出自哪」。
 *
 * 补的是 `qqbot_match_sticker`（只查本地库）和文字检索之间的空缺：没见过的图、又没写字，
 * 光靠肉眼认角色最容易出错。
 *
 * 两个源：
 * - trace.moe：动画截图 → 作品名 + 第几集 + 时间点。免费、不要 key。
 * - SauceNAO：pixiv / twitter 同人图溯源 → 作者、作品、原图链接。免费 key 有每日额度，
 *   不配 key 也能查，限速更严。
 *
 * 只读。但**会把图上传给这两个第三方服务**，所以只在用户明确问「这是谁 / 出自哪」时才调，
 * 不要对每张收到的图自动发起。
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, basename, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Logger } from '../types.ts';

export const REVERSE_IMAGE_TOOL_NAME = 'qqbot_reverse_image';

const DESCRIPTION =
  'Reverse-search one image on external services to find where it comes from: '
  + 'trace.moe for anime screenshots (title, episode, timestamp) and SauceNAO for fan art '
  + '(pixiv/twitter author, original post). '
  + 'Use it when the user asks who a character is, what anime/series a picture is from, or who drew it — '
  + 'especially when the image has no readable text. '
  + 'NOT read-only in the privacy sense: the image is uploaded to those two third-party services, '
  + 'so call it only when the user actually asks about the origin, never automatically for every image. '
  + 'If both sources come back empty, say you do not know instead of guessing the character.';

const TRACE_MOE_ENDPOINT = 'https://api.trace.moe/search';
const SAUCENAO_ENDPOINT = 'https://saucenao.com/search.php';
/** 上传上限：两个源都吃不下太大的图，也没必要 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface ReverseArgs {
  image: string;
  source?: 'auto' | 'anime' | 'art';
}

interface Hit {
  source: 'anime' | 'art';
  title: string;
  detail: string;
  similarity: number;
  url?: string;
}

/** trace.moe 返回的 AniList 标题，优先中文/日文原名 */
interface TraceMoeResult {
  anilist?: {
    title?: { native?: string; english?: string; romaji?: string; chinese?: string };
    synonyms?: string[];
  };
  episode?: number | string;
  from?: number;
  to?: number;
  similarity?: number;
  filename?: string;
}

interface SaucenaoResult {
  header?: { similarity?: string; index_id?: number };
  data?: { title?: string; author_name?: string; ext_urls?: string[]; source?: string };
}

function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'image/jpeg';
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * SauceNAO key：先看进程环境，再读 `~/.dsh/.env`。
 *
 * 宿主只在启动时加载 .env，而 Windows 上已经开着的 cmd 窗口不会刷新环境变量——
 * 于是「先开窗口、后配 key」几乎必然让进程里没有这个变量。多读一次 .env，
 * 就不用为了一个 key 重启整个宿主。
 */
function saucenaoKey(): string {
  const fromEnv = process.env.QQBOT_SAUCENAO_KEY;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.env'), 'utf8');
    const match = /^\s*QQBOT_SAUCENAO_KEY\s*=\s*(.+)$/m.exec(text);
    if (match?.[1] !== undefined) return match[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    // 没有这个文件就当没配
  }
  return '';
}

async function postImage(url: string, body: Buffer, name: string, type: string): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(body)], { type }), name);
  return fetch(url, {
    method: 'POST',
    // SauceNAO 会 403 掉没有 User-Agent 的请求（node fetch 默认不带）
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; dsh-qqbot reverse-image)' },
    body: form,
    signal: AbortSignal.timeout(45_000),
  });
}

/** 动画截图：作品 + 集数 + 时间点 */
async function searchAnime(body: Buffer, name: string, type: string): Promise<Hit[]> {
  const res = await postImage(`${TRACE_MOE_ENDPOINT}?anilistInfo=1&cutBorders=1`, body, name, type);
  if (!res.ok) throw new Error(`trace.moe HTTP ${res.status}`);
  const json = (await res.json()) as { result?: TraceMoeResult[] };
  const hits: Hit[] = [];
  for (const item of json.result ?? []) {
    const similarity = Math.round((item.similarity ?? 0) * 1000) / 10;
    if (similarity < 60) continue;
    const t = item.anilist?.title ?? {};
    const title = t.chinese ?? t.native ?? t.english ?? t.romaji ?? item.filename ?? '（未命名）';
    const parts: string[] = [];
    if (item.episode !== undefined && item.episode !== '') parts.push(`第 ${item.episode} 集`);
    if (typeof item.from === 'number') parts.push(`${clock(item.from)}–${clock(item.to ?? item.from)}`);
    hits.push({ source: 'anime', title, detail: parts.join(' '), similarity });
    if (hits.length >= 3) break;
  }
  return hits;
}

/** 同人图溯源：作者 + 原帖 */
async function searchArt(body: Buffer, name: string, type: string): Promise<Hit[]> {
  const key = saucenaoKey();
  const params = new URLSearchParams({ output_type: '2', numres: '5', db: '999' });
  if (key !== '') params.set('api_key', key);
  const res = await postImage(`${SAUCENAO_ENDPOINT}?${params.toString()}`, body, name, type);
  if (res.status === 429) throw new Error('SauceNAO 限速了（免费额度按天算，配 QQBOT_SAUCENAO_KEY 后更宽）');
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // 2026-11 实测：匿名访问被彻底关掉了，只回这句 403
    if (detail.includes('anonymous')) {
      throw new Error('SauceNAO 不再允许匿名调用，需要免费 api_key（saucenao.com/user.php?page=register）设到 QQBOT_SAUCENAO_KEY');
    }
    throw new Error(`SauceNAO HTTP ${res.status} ${detail.slice(0, 120)}`);
  }
  const json = (await res.json()) as { header?: { status?: number; message?: string }; results?: SaucenaoResult[] };
  if (json.header?.status !== undefined && json.header.status !== 0) {
    throw new Error(`SauceNAO: ${json.header.message ?? `status ${json.header.status}`}`);
  }
  const hits: Hit[] = [];
  for (const item of json.results ?? []) {
    const similarity = Number.parseFloat(item.header?.similarity ?? '0');
    if (!Number.isFinite(similarity) || similarity < 60) continue;
    const data = item.data ?? {};
    const title = data.title ?? data.source ?? '（无标题）';
    const author = data.author_name !== undefined && data.author_name !== '' ? `作者 ${data.author_name}` : '';
    const url = data.ext_urls?.[0];
    hits.push({
      source: 'art',
      title,
      detail: author,
      similarity: Math.round(similarity * 10) / 10,
      ...(url !== undefined ? { url } : {}),
    });
    if (hits.length >= 3) break;
  }
  return hits;
}

function formatHits(hits: Hit[]): string {
  const lines = hits.map((h) => {
    const tag = h.source === 'anime' ? '动画截图' : '同人图';
    const detail = h.detail === '' ? '' : ` ${h.detail}`;
    const url = h.url === undefined ? '' : `\n    ${h.url}`;
    return `- [${tag}] ${h.title}${detail}（相似度 ${h.similarity}%）${url}`;
  });
  return lines.join('\n');
}

export function registerReverseImageTool(ctx: Context, logger: Logger): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_reverse_image 工具未注册');
    return;
  }

  const definition = {
    name: REVERSE_IMAGE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Absolute path to the local image file.' },
        source: {
          type: 'string',
          enum: ['auto', 'anime', 'art'],
          description: 'auto (default) queries both; anime queries trace.moe only; art queries SauceNAO only.',
        },
      },
      required: ['image'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['found', 'text'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args: unknown): Promise<{ found: boolean; text: string }> {
      const { image, source } = (args ?? {}) as ReverseArgs;
      if (typeof image !== 'string' || image.trim() === '') {
        throw new Error('qqbot_reverse_image: `image` 必须是图片绝对路径');
      }
      const path = image.trim();
      const info = statSync(path, { throwIfNoEntry: false });
      if (info === undefined || !info.isFile()) throw new Error(`qqbot_reverse_image: 文件不存在 ${path}`);
      if (info.size > MAX_UPLOAD_BYTES) {
        throw new Error(`qqbot_reverse_image: 图太大 ${(info.size / 1e6).toFixed(1)}MB，先缩到 8MB 以内`);
      }

      const body = readFileSync(path);
      const name = basename(path);
      const type = mimeOf(path);
      const mode = source ?? 'auto';

      const jobs: Array<Promise<Hit[]>> = [];
      if (mode !== 'art') jobs.push(searchAnime(body, name, type));
      if (mode !== 'anime') jobs.push(searchArt(body, name, type));

      const settled = await Promise.allSettled(jobs);
      const hits: Hit[] = [];
      const failures: string[] = [];
      for (const result of settled) {
        if (result.status === 'fulfilled') hits.push(...result.value);
        else failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
      hits.sort((a, b) => b.similarity - a.similarity);

      if (hits.length === 0) {
        const note = failures.length === 0
          ? '两个源都没匹配到。可能是原创图、同人二次创作、截图太糊或裁过。'
          : `没匹配到，且有源报错：${failures.join('；')}。`;
        return { found: false, text: `${note}不确定就直接说认不出，别猜角色名。` };
      }

      const warn = failures.length === 0 ? '' : `\n（另有源失败：${failures.join('；')}）`;
      return {
        found: true,
        text: `以图搜图结果：\n${formatHits(hits)}${warn}\n图片是用户上传到第三方服务查询的，回答时不用提这个。`,
      };
    },
  };

  tools.register(definition);
  logger.info('im-qqbot: qqbot_reverse_image 工具已注册（trace.moe + SauceNAO）');
}
