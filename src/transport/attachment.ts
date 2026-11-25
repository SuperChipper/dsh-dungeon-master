/**
 * 富媒体下载 — 将 QQ 图片/视频/file 附件安全下载到本地
 *
 * 下载后仅通过本地绝对路径提示模型，由模型通过 qqbot_describe_image / ffmpeg / tool-fs 等工具自行分析，
 *
 * 下载目录固定为 ~/.dsh-qqbot/media，
 * 文件名用时间戳+随机数防重名，不依赖 agent cwd，便于 qqbot_describe_image / tool-fs 等工具稳定访问。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as dns from 'node:dns';
import type { Logger, RawAttachment } from '../types.ts';
import type { MediaConfig } from '../config.ts';
import { MEDIA_ROOT } from '../media/media-cleaner.ts';
import { sniffImageMediaType } from '../media/native-image.ts';

/** 默认富媒体下载大小上限（MB），可被 media.maxMB 覆盖 */
const DEFAULT_MAX_MB = 200;
/** 下载超时（毫秒）：限制单附件网络阻塞窗口 */
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** 多附件并发下载上限，避免单条多图消息串行累加耗时 */
const DOWNLOAD_CONCURRENCY = 4;

/** 下载结果 */
export interface DownloadedFile {
  /** 原始文件名（用于与消息附件关联） */
  filename: string;
  /** 附件类型 */
  contentType: 'image' | 'video' | 'file';
  /** 本地绝对路径 */
  localPath: string;
}

/** 附件归类（QQ 网关的 content_type 是 MIME 类型，如 image/png、video/mp4、audio/silk） */
export type MediaKind = 'image' | 'video' | 'voice' | 'file';

/** 是否为图片（兼容裸值 'image' 与 MIME 'image/png'） */
export function isImageContentType(contentType?: string): boolean {
  return contentType === 'image' || contentType?.startsWith('image/') === true;
}

/** 是否为视频（兼容裸值 'video' 与 MIME 'video/mp4'） */
export function isVideoContentType(contentType?: string): boolean {
  return contentType === 'video' || contentType?.startsWith('video/') === true;
}

/** 是否为语音（兼容裸值 'voice' 与 MIME 'audio/silk'） */
export function isVoiceContentType(contentType?: string): boolean {
  return contentType === 'voice' || contentType?.startsWith('audio/') === true;
}

/** 归类附件 content_type 为统一类型 */
export function classifyContentType(contentType?: string): MediaKind {
  if (isImageContentType(contentType)) return 'image';
  if (isVideoContentType(contentType)) return 'video';
  if (isVoiceContentType(contentType)) return 'voice';
  return 'file';
}

/** 处理 `//` 开头的协议相对 URL（补 https:） */
function normalizeUrl(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url;
}

/** 文件名净化：去路径、移除非法字符（保留中文等 Unicode 字符），防止路径穿越 */
function sanitizeFilename(name: string): string {
  const base = basename(name.replace(/\\/g, '/'));
  // 仅替换文件系统非法字符（Windows 保留字符 + 控制字符），保留中文/空格等
  // normalize NFC：统一 Unicode 规范化，避免 macOS(NFD) 与 Linux/Windows(NFC) 存储差异导致路径对不上
  const safe = base
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .trim()
    .normalize('NFC');
  return safe || 'attachment';
}

/** 统一路径分隔符为 `/`（POSIX），Node fs 在 Windows 也接受正斜杠，保证注入路径跨平台一致 */
function toPosixPath(p: string): string {
  return p.split(sep).join('/');
}

/**
 * 按内容魔法字节修正扩展名：QQ 转发/发送 GIF 时文件名常常还是 `.jpg`，
 * 扩展名错了后面 ffmpeg、原生读图、人工排障都会先入为主。
 */
export function withSniffedExtension(name: string, bytes: Uint8Array): string {
  const sniffed = sniffImageMediaType(bytes);
  const want = sniffed === 'image/gif' ? '.gif'
    : sniffed === 'image/png' ? '.png'
      : sniffed === 'image/jpeg' ? '.jpg'
        : sniffed === 'image/webp' ? '.webp'
          : undefined;
  if (want === undefined) return name;
  const ext = extname(name).toLowerCase();
  if (ext === want || (want === '.jpg' && ext === '.jpeg')) return name;
  return `${basename(name, extname(name)) || 'attachment'}${want}`;
}

/** 防重名：文件名 + 时间戳 + 随机数 */
function uniqueFilename(name: string): string {
  const base = sanitizeFilename(name);
  const ext = extname(base);
  const stem = basename(base, ext);
  const rand = randomBytes(4).toString('hex');
  return `${stem}_${Date.now()}_${rand}${ext}`;
}

/** 字节数格式化 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

// ── SSRF 防护：阻断解析到私有/保留地址的下载 ──

const IPV4_PRIVATE_RANGES: Array<[netmask: bigint, prefix: number]> = [
  [0x00000000n, 8], // 0.0.0.0/8
  [0x0A000000n, 8], // 10.0.0.0/8
  [0x64400000n, 10], // 100.64.0.0/10 (CGNAT)
  [0xAC100000n, 12], // 172.16.0.0/12
  [0xC0A80000n, 16], // 192.168.0.0/16
  [0x7F000000n, 8], // 127.0.0.0/8
  [0xA9FE0000n, 16], // 169.254.0.0/16
  [0xE0000000n, 4], // 224.0.0.0/4 (multicast)
];

const IPV6_PRIVATE_RANGES: Array<[netmask: bigint, prefix: number]> = [
  [0xFC00n << 112n, 7], // fc00::/7 unique local
  [0xFE80n << 112n, 10], // fe80::/10 link local
  [0xFF00n << 112n, 8], // ff00::/8 multicast
];

/** 解析 IPv4 为整数；非法返回 undefined */
function ipv4ToBigInt(ip: string): bigint | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/** 解析 IPv6（含 :: 压缩与内嵌 IPv4）为整数；非法返回 undefined */
function ipv6ToBigInt(ip: string): bigint | undefined {
  const zoneIndex = ip.indexOf('%');
  const addr = zoneIndex >= 0 ? ip.slice(0, zoneIndex) : ip;
  const halves = addr.split('::');
  if (halves.length > 2) return undefined;

  const parseGroups = (text: string): number[] | undefined => {
    if (text === '') return [];
    const groups: number[] = [];
    for (const piece of text.split(':')) {
      if (piece.includes('.')) {
        const embedded = ipv4ToBigInt(piece);
        if (embedded === undefined) return undefined;
        groups.push(Number(embedded >> 16n), Number(embedded & 0xFFFFn));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  const [headText = '', tailText] = halves;
  const head = parseGroups(headText);
  const tail = tailText === undefined ? undefined : parseGroups(tailText);
  if (head === undefined || (halves.length === 2 && tail === undefined)) return undefined;

  let groups: number[];
  if (halves.length === 1) {
    if (head.length !== 8) return undefined;
    groups = head;
  } else {
    const filler = 8 - head.length - (tail as number[]).length;
    if (filler < 0) return undefined;
    groups = [...head, ...new Array<number>(filler).fill(0), ...(tail as number[])];
  }

  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

function inRanges(value: bigint, ranges: Array<[netmask: bigint, prefix: number]>, bits: bigint): boolean {
  return ranges.some(([mask, prefix]) => {
    const shift = bits - BigInt(prefix);
    return (value >> shift) === (mask >> shift);
  });
}

/** 单个地址是否属于内网/保留段（同时覆盖 IPv4 与 IPv6） */
export function isPrivateAddress(address: string): boolean {
  if (!address.includes(':')) {
    const value = ipv4ToBigInt(address);
    return value !== undefined && inRanges(value, IPV4_PRIVATE_RANGES, 32n);
  }
  const value = ipv6ToBigInt(address);
  if (value === undefined) return false;
  if (value === 0n || value === 1n) return true; // :: 与 ::1
  // IPv4-mapped / IPv4-compatible（::ffff:10.0.0.1 之类）按内嵌 IPv4 判定
  if (value >> 32n === 0n) {
    return inRanges(value & 0xFFFFFFFFn, IPV4_PRIVATE_RANGES, 32n);
  }
  if (value >> 32n === 0xFFFFn) {
    // ::ffff:0:0/96 IPv4-mapped
    return inRanges(value & 0xFFFFFFFFn, IPV4_PRIVATE_RANGES, 32n);
  }
  return inRanges(value, IPV6_PRIVATE_RANGES, 128n);
}

/** 解析器注入点，便于测试替换（默认走 Node 的内置实现） */
export interface HostResolver {
  lookup: (hostname: string) => Promise<string[]>;
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6: (hostname: string) => Promise<string[]>;
}

export const nodeHostResolver: HostResolver = {
  lookup: async (hostname) => {
    const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return results.map((entry) => entry.address);
  },
  resolve4: (hostname) => dns.promises.resolve4(hostname),
  resolve6: (hostname) => dns.promises.resolve6(hostname),
};

/**
 * 解析 hostname 的全部地址。
 *
 * 先用系统解析器（GetAddrInfo）：它带 Windows 缓存、NRPT 与重试，和浏览器/curl 走同一条路，
 * 不会被链路本地 DNS 服务器抖动拖死；只有在它拿不到结果时才回退到 c-ares 的 A/AAAA 查询。
 * 历史 bug：只调 dns.promises.resolve4（c-ares 直连 fe80::1 这类链路本地 DNS），一旦超时
 * 就返回空数组并抛「DNS resolution failed」，图片明明能下载却报 DNS 失败。
 */
export async function resolveHostAddresses(
  hostname: string,
  resolver: HostResolver = nodeHostResolver,
): Promise<string[]> {
  const viaSystem = await resolver.lookup(hostname).catch(() => [] as string[]);
  if (viaSystem.length > 0) return viaSystem;
  const [v4, v6] = await Promise.all([
    resolver.resolve4(hostname).catch(() => [] as string[]),
    resolver.resolve6(hostname).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

/** 解析 hostname 并阻断指向私有/内网地址的 URL（SSRF 防护） */
export async function assertSafeHostname(
  hostname: string,
  resolver: HostResolver = nodeHostResolver,
): Promise<void> {
  const addresses = await resolveHostAddresses(hostname, resolver);
  if (addresses.length === 0) throw new Error(`DNS resolution failed: ${hostname}`);
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${addr}`);
  }
}

/** 安全拉取：仅 HTTPS + SSRF 防护 + 大小上限 + 超时（支持外部 AbortSignal 联动取消），返回字节 */
export async function fetchSafe(
  url: string,
  maxBytes: number,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<Buffer> {
  options?.signal?.throwIfAborted();
  const parsed = new URL(normalizeUrl(url));
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only HTTPS allowed: ${parsed.protocol}`);
  }
  await assertSafeHostname(parsed.hostname);
  options?.signal?.throwIfAborted();

  const timeoutSignal = AbortSignal.timeout(options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  const requestSignal = options?.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([timeoutSignal, options.signal]);
  const resp = await fetch(parsed, { signal: requestSignal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const buf = Buffer.from(await resp.arrayBuffer());
  options?.signal?.throwIfAborted();
  if (buf.length > maxBytes) {
    throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB`);
  }
  return buf;
}

/**
 * 下载消息中的富媒体附件（image/video/file）到本地
 *
 * 下载目录固定为 ~/.dsh-qqbot/media，文件名用时间戳+随机数防重名。
 * 下载失败或被取消时不阻断（由调用方回退描述）。
 */
export async function downloadMediaAttachments(
  attachments: RawAttachment[] | undefined,
  media: MediaConfig,
  logger: Logger,
  signal?: AbortSignal,
): Promise<DownloadedFile[]> {
  if (!media.enabled || signal?.aborted) return [];

  const targets = (attachments ?? []).filter(a =>
    classifyContentType(a.content_type) !== 'voice' && a.url,
  );
  if (targets.length === 0) return [];

  mkdirSync(MEDIA_ROOT, { recursive: true });

  const maxBytes = (media.maxMB ?? DEFAULT_MAX_MB) * 1024 * 1024;
  const slots: Array<DownloadedFile | undefined> = new Array(targets.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      if (signal?.aborted) return;
      const idx = cursor++;
      const att = targets[idx]!;
      const contentType = classifyContentType(att.content_type) as 'image' | 'video' | 'file';

      if (att.size > maxBytes) {
        logger.debug(`im-qqbot: skip download (${att.size}B too large): ${att.filename}`);
        continue; // 超限不下载，由 buildDynamicCtx 回退为描述
      }

      let buf: Buffer;
      try {
        buf = await fetchSafe(att.url, maxBytes, { signal });
      } catch (err) {
        if (signal?.aborted) return;
        logger.warn(`im-qqbot: download failed: ${att.filename} — ${err instanceof Error ? err.message : String(err)}`);
        continue; // 下载失败不加入结果，由 buildDynamicCtx 回退为描述
      }

      // 扩展名按内容定，不用 QQ 给的（它常把 GIF 也叫 .jpg）
      const localPath = toPosixPath(join(MEDIA_ROOT, uniqueFilename(withSniffedExtension(att.filename, buf))));
      writeFileSync(localPath, buf);
      logger.debug(`im-qqbot: attachment downloaded: ${att.filename} (${formatSize(buf.length)}) → ${localPath}`);

      slots[idx] = { filename: att.filename, contentType, localPath };
    }
  };

  const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, targets.length) }, () => worker());
  await Promise.all(workers);

  return slots.filter((item): item is DownloadedFile => item !== undefined);
}