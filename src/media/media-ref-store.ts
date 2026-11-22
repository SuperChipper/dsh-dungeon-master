/**
 * 进程内 QQ 媒体 URL 短引用表（`qqref:<10-hex>`）。
 *
 * 群历史未下载图片、合并转发未下载图片与入站下载失败的图片原本会把 250~450+ 字符的
 * QQ CDN 签名长链接（rkey/spec 等）直接拼进用户消息，既污染模型上下文、又容易让模型误以为
 * 可以直接打开或复述。这里映射为确定性短句柄 `qqref:<10-hex>`，`qqbot_describe_image`
 * 在真正需要看图时再反查回原 URL / 本地缓存路径。
 */
import { createHash } from 'node:crypto';

export const MEDIA_REF_PREFIX = 'qqref:';

const MEDIA_REF_RE = /^qqref:[0-9a-f]{8,16}$/i;

export interface MediaRefEntry {
  ref: string;
  url: string;
  filename?: string;
  localPath?: string;
  createdAt: number;
}

export function isMediaRef(value: string): boolean {
  return MEDIA_REF_RE.test(value.trim());
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
}

function refForUrl(url: string): string {
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 10);
  return `${MEDIA_REF_PREFIX}${digest}`;
}

export class MediaRefStore {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, MediaRefEntry>();

  public constructor(maxEntries = 500) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  public register(url: string, meta?: { filename?: string; localPath?: string }): string {
    const normalized = normalizeUrl(url);
    const ref = refForUrl(normalized);
    const existing = this.entries.get(ref);
    const entry: MediaRefEntry = {
      ref,
      url: normalized,
      filename: meta?.filename ?? existing?.filename,
      localPath: meta?.localPath ?? existing?.localPath,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    if (existing !== undefined) this.entries.delete(ref);
    this.entries.set(ref, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return ref;
  }

  public bindLocalPath(url: string, localPath: string): void {
    const ref = refForUrl(normalizeUrl(url));
    const entry = this.entries.get(ref);
    if (entry === undefined) return;
    entry.localPath = localPath;
    this.entries.delete(ref);
    this.entries.set(ref, entry);
  }

  public resolve(ref: string): MediaRefEntry | undefined {
    const key = ref.trim().toLowerCase();
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  public clear(): void {
    this.entries.clear();
  }

  public get size(): number {
    return this.entries.size;
  }
}

export const mediaRefStore = new MediaRefStore();

export function registerMediaRef(url: string, meta?: { filename?: string; localPath?: string }): string {
  return mediaRefStore.register(url, meta);
}

export function resolveMediaRef(ref: string): MediaRefEntry | undefined {
  return mediaRefStore.resolve(ref);
}

export function bindMediaRefLocalPath(url: string, localPath: string): void {
  mediaRefStore.bindLocalPath(url, localPath);
}

const QQ_MEDIA_CDN_URL_RE = /https?:\/\/(?:multimedia\.nt\.qq\.com\.cn|gchat\.qpic\.cn|c2cpicdw\.qpic\.cn)\/[^\s\]"')<>]+/gi;

/** 把自由文本里残留的 QQ 内部媒体签名长 URL 收敛为 `qqref:<10-hex>`，不影响普通网页链接 */
export function shortenQqMediaUrls(text: string, refs: MediaRefStore = mediaRefStore): string {
  if (!text) return text;
  return text.replace(QQ_MEDIA_CDN_URL_RE, (url) => refs.register(url));
}
