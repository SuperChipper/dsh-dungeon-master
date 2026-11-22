/**
 * Bilibili 只读工具（L1 合并版）：
 *   - `qqbot_bili`: search / video / comments / subtitle / fetch（取公开免登录视频到 media 供观看）
 *   - `qqbot_bili_auth`: login / check（扫码登录；独立工具以便 L0 对所有群聊与非特权私聊隐藏）
 *
 * 刻意不注册发评论、投币、收藏、私信、投稿等写操作：
 * 肥鱼只负责“看”，要发内容由用户自己决定。
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { PLUGIN_ROOT } from '../shared/index.ts';
import { fetchBiliVideo } from '../media/video-fetch-tool.ts';
import { BiliClient } from './client.ts';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode') as {
  toFile(path: string, text: string, options?: Record<string, unknown>): Promise<void>;
};

export const BILI_TOOL_NAME = 'qqbot_bili';
export const BILI_AUTH_TOOL_NAME = 'qqbot_bili_auth';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface ToolLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface BiliToolDeps {
  client?: BiliClient;
  logger: ToolLogger;
  /** 多段 durl 视频无损拼接所需的 ffmpeg 路径 */
  ffmpegPath?: string;
  /** 把登录二维码发到当前 QQ 会话；返回 false/抛错时退化为返回本地路径 */
  sendQr?: (agent: unknown, qrPath: string, caption: string) => Promise<boolean>;
  /** 登录/使用登录态字幕的权限门；未提供时不做额外限制（本地 Web 场景） */
  permission?: (agent: unknown, kind?: 'login' | 'subtitle') => { allowed: boolean; reason?: string };
}

interface ToolRegistration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => ContentBlock[];
  };
  execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown> | string>;
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: String(value) }],
};

const BVID_PATTERN = /BV[0-9A-Za-z]{10}/;

/** 从链接或文字里取 BV 号；取不到就原样返回（去空白） */
export function bvidOf(value: string): string {
  const match = BVID_PATTERN.exec(value);
  return match?.[0] ?? value.trim();
}

function count(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return String(value);
}

function dateOf(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function loginHint(): string {
  return '还没有 B 站登录凭证。先在主人/管理员私聊调用 qqbot_bili_auth(action="login") 生成二维码，用手机 B 站扫码（确认时选「记住我 / 长期」），扫完再调用 qqbot_bili_auth(action="check")。';
}

interface BiliArgs {
  action?: 'search' | 'video' | 'comments' | 'subtitle' | 'fetch';
  keyword?: string;
  bvid?: string;
  url?: string;
  limit?: number;
  order?: 'totalrank' | 'click' | 'pubdate';
  page?: number;
  quality?: number;
  max_mb?: number;
}

interface BiliAuthArgs {
  action?: 'login' | 'check';
  qrcodeKey?: string;
}

export function registerBiliTools(tools: ToolsRegistryLike, deps: BiliToolDeps): void {
  const client = deps.client ?? new BiliClient();

  const ensurePermission = (agent: unknown, kind: 'login' | 'subtitle' = 'login'): void => {
    if (deps.permission === undefined) return;
    const result = deps.permission(agent, kind);
    if (!result.allowed) throw new Error(result.reason ?? '没有权限执行这个 B 站操作');
  };

  const biliTool: ToolRegistration = {
    name: BILI_TOOL_NAME,
    description:
      'Read-only Bilibili toolkit (never posts, likes, comments or sends messages). Choose action: '
      + '"search" (find public videos by keyword), '
      + '"video" (video metadata/stats/pages by bvid), '
      + '"comments" (top public comments by bvid), '
      + '"subtitle" (video subtitle text by bvid; may require login), '
      + '"fetch" (download a public non-VIP video to local media/ so qqbot_describe_video / qqbot_transcribe can inspect it).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'video', 'comments', 'subtitle', 'fetch'],
          description: 'Operation to perform.',
        },
        keyword: { type: 'string', description: 'action="search": search keywords, e.g. "DeepSeek Harness" or "大肥鱼".' },
        bvid: { type: 'string', description: 'action="video"|"comments"|"subtitle"|"fetch": BVID or Bilibili video URL, e.g. BV1qbn16kEFh.' },
        url: { type: 'string', description: 'action="fetch": optional alias of bvid (BVID or full URL).' },
        limit: { type: 'number', description: 'action="search" (1-20, default 10) or "comments" (1-30, default 10).' },
        order: {
          type: 'string',
          enum: ['totalrank', 'click', 'pubdate'],
          description: 'action="search": sort by relevance (totalrank), most played (click), or newest (pubdate).',
        },
        page: { type: 'number', description: 'action="fetch": multi-part video page number (1-based, default 1).' },
        quality: { type: 'number', description: 'action="fetch": quality code 16/32/64/80 (default 64 = 720P, guest max 480P when unauthenticated).' },
        max_mb: { type: 'number', description: 'action="fetch": download size limit in MB (default 200).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const input = (args ?? {}) as BiliArgs;
      switch (input.action) {
        case 'search': {
          const keyword = typeof input.keyword === 'string' ? input.keyword.trim() : '';
          if (keyword === '') throw new Error('qqbot_bili: action="search" 需要非空 keyword');
          const items = await client.search(keyword, input.limit ?? 10, input.order ?? 'totalrank');
          if (items.length === 0) return `B站搜索「${keyword}」没有结果。`;
          const lines = [`B站搜索「${keyword}」：`, ''];
          items.forEach((item, index) => {
            lines.push(`${index + 1}. [${item.title}](https://www.bilibili.com/video/${item.bvid})`);
            lines.push(`   UP主：${item.author}；播放：${count(item.play)}；发布：${dateOf(item.pubdate)}；时长：${item.duration || '—'}`);
          });
          lines.push('', '以上为公开搜索结果；需要看某个视频的字幕/评论/下载观看，传对应 BVID。');
          return lines.join('\n');
        }

        case 'video': {
          const bvid = typeof input.bvid === 'string' ? input.bvid.trim() : '';
          if (bvid === '') throw new Error('qqbot_bili: action="video" 需要非空 bvid');
          const info = await client.video(bvidOf(bvid));
          return [
            `# ${info.title}`,
            '',
            `- 链接：https://www.bilibili.com/video/${info.bvid}`,
            `- UP主：${info.author}（UID ${info.authorUid}）`,
            `- 发布：${dateOf(info.pubdate)}；时长：${Math.floor(info.duration / 60)}:${String(info.duration % 60).padStart(2, '0')}`,
            `- 播放：${count(info.stats.view)}；点赞：${count(info.stats.like)}；评论：${count(info.stats.reply)}；收藏：${count(info.stats.favorite)}；投币：${count(info.stats.coin)}`,
            info.description.trim() ? `- 简介：${truncate(info.description.replace(/\s+/g, ' ').trim(), 500)}` : '',
            info.pages.length > 1 ? `- 分P：${info.pages.length} 个（${info.pages.slice(0, 5).map((page) => `P${page.page} ${page.part}`).join('；')}${info.pages.length > 5 ? '…' : ''}）` : '',
          ].filter(Boolean).join('\n');
        }

        case 'comments': {
          const bvid = typeof input.bvid === 'string' ? input.bvid.trim() : '';
          if (bvid === '') throw new Error('qqbot_bili: action="comments" 需要非空 bvid');
          const items = await client.comments(bvidOf(bvid), input.limit ?? 10);
          if (items.length === 0) return '这个视频暂时没有公开评论。';
          const lines = ['评论（按热度）：', ''];
          items.forEach((item, index) => {
            lines.push(`${index + 1}. @${item.author}（赞 ${count(item.like)}）：${truncate(item.message.replace(/\s+/g, ' '), 300)}`);
            if (item.replyCount > 0) lines.push(`   楼中楼 ${item.replyCount} 条`);
          });
          return lines.join('\n');
        }

        case 'subtitle': {
          const bvid = typeof input.bvid === 'string' ? input.bvid.trim() : '';
          if (bvid === '') throw new Error('qqbot_bili: action="subtitle" 需要非空 bvid');
          if (client.hasCredential()) ensurePermission(exec.agent, 'subtitle');
          try {
            const result = await client.subtitle(bvidOf(bvid));
            if (result === undefined) return '这个视频没有可用字幕（可能未上传字幕，或该字幕需要登录后才有权限）。';
            return [
              `字幕（${result.lan || '未知语言'}，${result.lines} 行${result.truncated ? '，已截断' : ''}）：`,
              '',
              result.text,
            ].join('\n');
          } catch (err) {
            if (!client.hasCredential()) return `${loginHint()}\n\n（${err instanceof Error ? err.message : String(err)}）`;
            throw err;
          }
        }

        case 'fetch': {
          const targetUrl = (typeof input.bvid === 'string' && input.bvid.trim() !== '')
            ? input.bvid.trim()
            : (typeof input.url === 'string' ? input.url.trim() : '');
          if (targetUrl === '') throw new Error('qqbot_bili: action="fetch" 需要 bvid 或 url');
          return fetchBiliVideo(
            { client, logger: deps.logger, ffmpegPath: deps.ffmpegPath },
            {
              url: targetUrl,
              ...(input.page !== undefined ? { page: input.page } : {}),
              ...(input.quality !== undefined ? { quality: input.quality } : {}),
              ...(input.max_mb !== undefined ? { max_mb: input.max_mb } : {}),
            },
          );
        }

        default:
          throw new Error(`qqbot_bili: 不支持的 action="${String(input.action)}"`);
      }
    },
  };

  const qrSessions = new Map<string, { path: string; createdAt: number }>();

  const biliAuthTool: ToolRegistration = {
    name: BILI_AUTH_TOOL_NAME,
    description:
      'Owner/admin private-chat only: log into Bilibili via one-time QR code. '
      + 'action="login" generates the QR code and sends it to the current chat; '
      + 'action="check" polls login status using the `qrcodeKey` returned by login. '
      + 'Use only when the user explicitly asks to log in; never post the QR code or cookies publicly.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['login', 'check'], description: '"login" to start QR login; "check" to poll scan result.' },
        qrcodeKey: { type: 'string', description: 'Required when action="check": the qrcodeKey returned by login.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const input = (args ?? {}) as BiliAuthArgs;
      if (input.action === 'login') {
        ensurePermission(exec.agent, 'login');
        const start = await client.loginStart();
        const dir = join(PLUGIN_ROOT, 'media');
        mkdirSync(dir, { recursive: true });
        const qrPath = join(dir, `bili-login-${start.qrcodeKey.slice(0, 8)}.png`);
        await QRCode.toFile(qrPath, start.url, { width: 360, margin: 1, errorCorrectionLevel: 'M' });
        qrSessions.set(start.qrcodeKey, { path: qrPath, createdAt: Date.now() });

        let sent = false;
        if (deps.sendQr !== undefined && exec.agent !== undefined) {
          try {
            sent = await deps.sendQr(exec.agent, qrPath, '用手机 B 站扫码登录（确认时选「记住我 / 长期」），扫完说一声');
          } catch (err) {
            deps.logger.warn(`im-qqbot: 发送 B 站登录二维码失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        return [
          sent ? '登录二维码已发到当前会话。' : `登录二维码已生成：${qrPath}（可调用 qqbot_send_file 发送）。`,
          '用手机 B 站扫码，确认时选「记住我 / 长期」。',
          `扫完把这句话发我，或调用 qqbot_bili_auth(action="check", qrcodeKey="${start.qrcodeKey}")。`,
          `二维码约 ${start.expiresInSeconds} 秒内有效。`,
        ].join('\n');
      }

      if (input.action === 'check') {
        const qrcodeKey = input.qrcodeKey;
        if (typeof qrcodeKey !== 'string' || qrcodeKey.length === 0) {
          throw new Error('qqbot_bili_auth: action="check" 时 qrcodeKey 不能为空');
        }
        ensurePermission(exec.agent, 'login');
        const status = await client.loginPoll(qrcodeKey);
        if (status.state === 'success' || status.state === 'expired') {
          const session = qrSessions.get(qrcodeKey);
          if (session !== undefined) {
            try { rmSync(session.path, { force: true }); } catch { /* 忽略清理失败 */ }
            qrSessions.delete(qrcodeKey);
          }
          if (status.state === 'success') {
            deps.logger.info('im-qqbot: B 站扫码登录成功，凭证已保存到本机');
          }
        }
        return status.message;
      }

      throw new Error(`qqbot_bili_auth: 不支持的 action="${String(input.action)}"`);
    },
  };

  for (const tool of [biliTool, biliAuthTool]) {
    tools.register(tool);
  }
  deps.logger.info('im-qqbot: B 站工具已注册（qqbot_bili / qqbot_bili_auth）');
}
