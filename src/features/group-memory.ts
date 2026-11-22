/**
 * 持久化群记忆（借鉴 dsh-pet：把群聊沉淀到磁盘 JSONL，重启后可回灌长期上下文）
 * 路径：~/.dsh/qqbot-memory/<appId>-<groupId>.jsonl
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { SELF_SENDER_ID } from '../transport/self-sent.ts';
import { writeJsonAtomic } from '../shared/atomic-fs.ts';
import {
  groupMemoryCursorPath,
  groupMemoryPath,
  qqbotMemoryDir,
  sanitizeStorageKey,
} from '../shared/paths.ts';
import { DEFAULT_PERSONA_NAME } from './persona-store.ts';

/** 群消息里的图片（只存 QQ 下发的 URL，真正用到时再下载） */
export interface GroupMemoryImage {
  url: string;
  filename?: string;
}

export interface GroupMemoryEntry {
  messageId: string;
  senderId: string;
  senderName?: string;
  /** 仅 bot 自己发的出站消息带该字段；群友入站消息省略，兼容历史记录 */
  role?: 'assistant';
  content: string;
  timestamp: number;
  /** 图片附件；旧记录没有该字段 */
  images?: GroupMemoryImage[];
}

export interface ReadGroupMessagesOptions {
  /** 是否包含 bot 自己的发言（默认 true） */
  includeSelf?: boolean;
}

export interface BotGroupMessageInput {
  content: string;
  senderName?: string;
  result?: unknown;
  messageId?: string;
  timestamp?: number;
}

export interface BotPersonaNameSource {
  current?(peerId: string, scope?: 'c2c' | 'group'): { name: string; names: readonly string[] } | undefined;
  defaultPersona?(scope?: 'c2c' | 'group'): { name: string; names: readonly string[] } | undefined;
}

let botMessageSeq = 0;

/** 这条归档记录是不是 bot 自己发的 */
export function isBotMemoryEntry(entry: { senderId?: string; role?: string }): boolean {
  return entry.senderId === SELF_SENDER_ID || entry.role === 'assistant';
}

/** 从 QQ 发送响应里提取可用的消息 ID（优先 message id，其次 ref_idx，都没有就兜底生成） */
export function extractSentMessageId(result: unknown, now: number = Date.now()): string {
  const r = result as {
    id?: unknown;
    ext_info?: { ref_idx?: unknown };
    message?: { id?: unknown; ext_info?: { ref_idx?: unknown } };
  } | undefined;
  for (const candidate of [
    r?.id,
    r?.message?.id,
    r?.ext_info?.ref_idx,
    r?.message?.ext_info?.ref_idx,
  ]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim();
    }
  }
  botMessageSeq += 1;
  return `bot-${now}-${botMessageSeq}`;
}

/** 解析 bot 在某个群当前显示的称呼（非默认人设名 > 配置别名 > 默认人设别名 > 'bot'） */
export function resolveBotSenderName(
  groupId: string,
  configuredNames: readonly string[] | undefined,
  personaStore?: BotPersonaNameSource,
): string {
  const firstTrimmed = (values: readonly string[] | undefined): string | undefined =>
    values?.map((v) => v.trim()).find((v) => v !== '');

  const current = personaStore?.current?.(groupId, 'group');
  if (current !== undefined) {
    const display = current.name.trim();
    if (display !== '' && display !== DEFAULT_PERSONA_NAME) return display;
    const alias = firstTrimmed(current.names);
    if (alias !== undefined) return alias;
  }

  const configured = (configuredNames ?? [])
    .flatMap((name) => name.split(/[;；,，、\s]+/))
    .map((name) => name.trim())
    .find((name) => name !== '');
  if (configured !== undefined) return configured;

  const fallback = personaStore?.defaultPersona?.('group');
  if (fallback !== undefined) {
    const alias = firstTrimmed(fallback.names);
    if (alias !== undefined) return alias;
    const display = fallback.name.trim();
    if (display !== '' && display !== DEFAULT_PERSONA_NAME) return display;
  }

  return 'bot';
}

interface GroupMemoryCacheEntry {
  size: number;
  mtimeMs: number;
  ino: number;
  entries: GroupMemoryEntry[];
}

const MAX_CACHED_GROUPS = 64;
const memoryCache = new Map<string, GroupMemoryCacheEntry>();

function touchCache(path: string, entry: GroupMemoryCacheEntry): void {
  memoryCache.delete(path);
  memoryCache.set(path, entry);
  while (memoryCache.size > MAX_CACHED_GROUPS) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
}

/** 清空群记忆内存缓存（供测试隔离） */
export function clearGroupMemoryCache(): void {
  memoryCache.clear();
}

/** 追加一条群消息到持久化记忆（JSONL，写失败静默不阻断消息处理） */
export function appendGroupMessage(appId: string, groupId: string, entry: GroupMemoryEntry): void {
  try {
    const p = groupMemoryPath(appId, groupId);
    mkdirSync(dirname(p), { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    appendFileSync(p, line, 'utf8');
    const cached = memoryCache.get(p);
    if (cached !== undefined) {
      try {
        const st = statSync(p);
        if (st.ino === cached.ino && st.size === cached.size + Buffer.byteLength(line, 'utf8')) {
          cached.entries.push(entry);
          cached.size = st.size;
          cached.mtimeMs = st.mtimeMs;
          touchCache(p, cached);
        } else {
          memoryCache.delete(p);
        }
      } catch {
        memoryCache.delete(p);
      }
    }
  } catch {
    /* ignore */
  }
}

/** 追加 bot 自己发出的一条群消息到持久化记忆（空白正文不落盘） */
export function appendBotGroupMessage(
  appId: string,
  groupId: string,
  input: BotGroupMessageInput,
): GroupMemoryEntry | undefined {
  const content = input.content.trim();
  if (!groupId || content === '') return undefined;
  const timestamp = input.timestamp ?? Date.now();
  const explicitId = input.messageId?.trim();
  const messageId = explicitId !== undefined && explicitId !== ''
    ? explicitId
    : extractSentMessageId(input.result, timestamp);
  const senderName = input.senderName?.trim();
  const entry: GroupMemoryEntry = {
    messageId,
    senderId: SELF_SENDER_ID,
    ...(senderName !== undefined && senderName !== '' ? { senderName } : {}),
    role: 'assistant',
    content,
    timestamp,
  };
  appendGroupMessage(appId, groupId, entry);
  return entry;
}

/** 读取全部群记忆（带基于 stat 校验的内存缓存，坏行跳过，读失败返回空） */
export function readAllGroupMessages(appId: string, groupId: string): GroupMemoryEntry[] {
  try {
    const p = groupMemoryPath(appId, groupId);
    if (!existsSync(p)) {
      memoryCache.delete(p);
      return [];
    }
    const st = statSync(p);
    const cached = memoryCache.get(p);
    if (cached !== undefined && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.ino === st.ino) {
      touchCache(p, cached);
      return [...cached.entries];
    }
    const entries: GroupMemoryEntry[] = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as GroupMemoryEntry;
        if (e) entries.push(e);
      } catch {
        /* 跳过坏行 */
      }
    }
    touchCache(p, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, entries });
    return [...entries];
  } catch {
    return [];
  }
}

/** 读取最近 limit 条群记忆，排除指定 messageId（当前消息），按时间正序返回 */
export function readRecentGroupMessages(
  appId: string,
  groupId: string,
  limit: number,
  excludeMessageId?: string,
  options?: ReadGroupMessagesOptions,
): GroupMemoryEntry[] {
  return readGroupMessagesAfter(appId, groupId, limit, undefined, excludeMessageId, options);
}

/**
 * 读取 afterMessageId 之后的群记忆（最多 limit 条，按时间正序，排除当前消息）。
 * afterMessageId 缺省或在记忆里找不到时，退回最近 limit 条。
 */
export function readGroupMessagesAfter(
  appId: string,
  groupId: string,
  limit: number,
  afterMessageId: string | undefined,
  excludeMessageId?: string,
  options?: ReadGroupMessagesOptions,
): GroupMemoryEntry[] {
  const all = readAllGroupMessages(appId, groupId);
  const cut = afterMessageId === undefined ? -1 : all.findIndex((e) => e.messageId === afterMessageId);
  const since = cut >= 0 ? all.slice(cut + 1) : all;
  const includeSelf = options?.includeSelf ?? true;
  return since
    .filter((e) => e.messageId !== excludeMessageId && (includeSelf || !isBotMemoryEntry(e)))
    .slice(-Math.max(0, limit));
}

/**
 * 群历史游标：某个会话上次注入群历史时，已经覆盖到的消息。
 * 绑定 sessionId——换了新会话（/new、重建）时游标失效，重新注入完整的最近 N 条。
 */
export interface GroupHistoryCursor {
  sessionId: string;
  messageId: string;
}

/** 读取群历史游标（不存在或损坏返回 undefined） */
export function readHistoryCursor(appId: string, groupId: string): GroupHistoryCursor | undefined {
  try {
    const p = groupMemoryCursorPath(appId, groupId);
    if (!existsSync(p)) return undefined;
    const c = JSON.parse(readFileSync(p, 'utf8')) as Partial<GroupHistoryCursor>;
    return typeof c.sessionId === 'string' && typeof c.messageId === 'string'
      ? { sessionId: c.sessionId, messageId: c.messageId }
      : undefined;
  } catch {
    return undefined;
  }
}

/** 写入群历史游标（原子落盘，失败静默：最坏情况是下次多注入几条重复历史） */
export function writeHistoryCursor(appId: string, groupId: string, cursor: GroupHistoryCursor): void {
  try {
    writeJsonAtomic(groupMemoryCursorPath(appId, groupId), cursor);
  } catch {
    /* ignore */
  }
}

/**
 * 列出这个 appId 下所有有记忆文件的会话 id。
 * 只用于「检索时不给会话就是全量搜」——文件名里除了会话 id 没有别的元信息，
 * 群/私聊的区别只有调用方知道（见 history-tool 的 chat 参数）。
 */
export function listMemoryChats(appId: string): string[] {
  try {
    const dir = qqbotMemoryDir();
    if (!existsSync(dir)) return [];
    const prefix = `${sanitizeStorageKey(appId)}-`;
    return readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
      .map((f) => f.slice(prefix.length, -'.jsonl'.length));
  } catch {
    return [];
  }
}
