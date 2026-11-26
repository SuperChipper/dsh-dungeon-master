/**
 * 共享笔记库 — 把一个目录下的 Markdown 笔记当作跨会话共享的长期记忆。
 *
 *   - 按标题（#/##/###）把每个 .md 切成小段，一段就是一个检索单元；
 *   - 支持目录约定、YAML frontmatter 与小节元数据行声明适用范围（project/persona/scene/model/chatKey）、
 *     显式触发词、注入预算与过期替代关系（supersedes / supersededBy）；
 *   - 中文按二字切词（bigram）、英文/数字按词，BM25 打分，不依赖向量服务；
 *   - BM25 之外再走一路字面精确匹配（专有名词、引号原文、别名、编号、显式触发词），可选再加一路向量语义相似度，
 *     多路 RRF 融合 + 新旧冲突/替代解析后取 top-k；
 *   - 目录有改动（文件增删、mtime/大小变化）时自动重建索引，人手改笔记也能立即生效；
 *   - `chats/<会话键>/` 下是只属于某个群/私聊的笔记（如某个群的跑团进度），只有那个会话检索得到，
 *     避免别的群的存档混进来。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, appendFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { Logger } from '../types.ts';
import { writeTextAtomic } from '../shared/atomic-fs.ts';
import { EXACT_STRONG_SCORE, scoreExact, type ExactScore } from '../features/exact-match.ts';
import { fuseRankings, gateSimilarities, type SemanticGate } from '../features/rank-fusion.ts';
import type { EmbeddingCache } from './embedding.ts';
import {
  chatNotesDir,
  cloneNoteMeta,
  compareNoteDates,
  deriveDirMeta,
  describeNoteScope,
  extractFrontmatter,
  formatMetaBlockquote,
  matchesNoteScope,
  mergeNoteMeta,
  parseMetaBlockquote,
  parseSectionMeta,
  upsertMetaInBlockquote,
  type NoteConflict,
  type NoteInjectPolicy,
  type NoteMeta,
  type NoteQueryContext,
  type NoteScene,
} from './note-metadata.ts';

export { chatNotesDir };
export type { NoteConflict, NoteInjectPolicy, NoteMeta, NoteQueryContext, NoteScene };

/** 单个笔记文件大小上限：更大的文件跳过，避免把日志之类的东西误当笔记 */
const MAX_FILE_BYTES = 512 * 1024;
/** 最多索引的文件数 */
const MAX_FILES = 500;
/** 递归深度上限 */
const MAX_DEPTH = 3;
/** 单段最大字符数：超出按段落再切 */
const MAX_CHUNK_CHARS = 1200;
/** 两次扫描目录的最小间隔(ms) */
const RESCAN_INTERVAL_MS = 3000;
/** 单次 save 的内容上限 */
const MAX_SAVE_CHARS = 8000;

/** 会话私有笔记的子目录：chats/<会话键>/xxx.md */
const CHAT_NOTES_DIR = 'chats';

const BM25_K1 = 1.2;
/** 长度归一化放轻（常见取 0.75）：笔记段都很短，否则「待办」这类短段会压过真正讲这件事的段 */
const BM25_B = 0.3;
/** 参与融合的粗检索名次上限：再往后的段只有被精确一路捞到才有机会进结果 */
const COARSE_POOL = 50;

/** 大库防泛化词误注入：至少达到此总段数才启用文档频率区分度门槛 */
const DISTINCTIVE_CORPUS_MIN_CHUNKS = 8;
/** 词项出现在不超过此比例的段落里时视为有区分度 */
const DISTINCTIVE_MAX_DF_RATIO = 0.35;
/** 退役/作废类新证据识别词 */
const DEPRECATION_RE = /已退役|作废|已废弃|已删除|不再使用|不再保留|整体重写|已停用/;
/** 历史溯源查询：明确在问旧版/改版前内容时允许召回并注入已过期笔记 */
const HISTORICAL_QUERY_RE = /之前|以前|旧版|老版|原来|历史|退役|废弃|改版前|为什么删|怎么改的|演进/;

export interface NoteChunk {
  /** 相对笔记根目录的路径（posix 分隔符） */
  file: string;
  /** 标题路径，如「大肥鱼小课堂 › 一、逐集笔记 › 04 …」 */
  heading: string;
  text: string;
  /** Shared by all retrieval chunks of one marked section. */
  section?: { text: string; recall: string };
  /** 解析并继承后的结构化元数据 */
  meta?: NoteMeta;
}

export interface NoteHit extends NoteChunk {
  score: number;
  /** 命中的不同查询词个数 */
  matched: number;
  /**
   * 命中的查询词占比（0-1），用于判断是否值得自动注入。
   * 分母只算笔记库里出现过的查询词：「你还记得…吗」这类口语虚词组合不拉低覆盖率。
   */
  coverage: number;
  /** 字面精确命中（引号原文/别名/编号/专有名词）；没有精确命中时缺省 */
  exact?: ExactScore;
  /** 与查询的余弦相似度；只有过了语义门槛才有，语义检索没开或没过门槛时缺省 */
  similarity?: number;
  /** 适用范围中文说明 */
  scopeLabel?: string;
  /** 触发依据说明 */
  why?: string;
  /** 命中的显式触发词 */
  triggeredBy?: string[];
  operationMatches?: string[];
  /** 命中的代表性关键词（按 IDF 从高到低） */
  matchedTerms?: string[];
  /** 是否命中至少一个非泛化高区分度词（大库防弱词面误注入） */
  hasDistinctiveTerm?: boolean;
  /** 若由过期旧记录的替代关系补召回/提权而来，记录旧记录是否满足注入门槛 */
  rescuedFromQualifying?: boolean;
  /** 新旧冲突或已被替代的关系提示 */
  conflicts?: NoteConflict[];
}

export interface SaveNoteInput {
  title: string;
  content: string;
  /** 目标文件名（只取 basename）；缺省按标题建文件 */
  file?: string;
  /** 来源描述，如「群聊」「私聊」 */
  source?: string;
  /** 会话键：给了就写进 chats/<会话键>/，只有这个会话检索得到 */
  chatKey?: string;
  projects?: string[];
  personas?: string[];
  scenes?: NoteScene[];
  models?: string[];
  operations?: string[];
  triggers?: string[];
  inject?: NoteInjectPolicy;
  budgetChars?: number;
  supersedes?: string[];
  date?: string;
}

export interface SaveNoteResult {
  file: string;
  created: boolean;
  chars: number;
  message: string;
}

export interface SupersedeNoteInput {
  file: string;
  heading?: string;
  occurrence?: number;
  supersededBy: string;
}

export interface SupersedeNoteResult {
  file: string;
  heading: string;
  message: string;
}

export interface PlannedNoteItem {
  hit: NoteHit;
  snippet: string;
  truncated: boolean;
}

export interface NoteInjectionPlan {
  items: PlannedNoteItem[];
  text: string;
  usedChars: number;
  maxChars: number;
}

interface IndexedChunk extends NoteChunk {
  rawMeta: NoteMeta;
  meta: NoteMeta;
  replacedByIndices: number[];
  terms: Map<string, number>;
  headingTerms: Set<string>;
  length: number;
}

/**
 * 切词：中日文连续片段取二字组（单字片段保留单字），英文/数字取整词（小写）。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.normalize('NFKC').toLowerCase();
  for (const match of normalized.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[a-z0-9_]+/gu)) {
    const run = match[0];
    if (/^[a-z0-9_]+$/.test(run)) {
      if (run.length >= 2 || /\d/.test(run)) tokens.push(run);
      continue;
    }
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

/** 参与检索/算向量的全文：标题路径 + 正文 + 显式触发词 */
function embeddingText(chunk: Pick<NoteChunk, 'heading' | 'text' | 'meta'>): string {
  const trigs = chunk.meta?.triggers?.length ? `\n${chunk.meta.triggers.join(' ')}` : '';
  return `${chunk.heading}\n${chunk.text}${trigs}`;
}

function countTerms(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/** 把超长段按空行再切，保证每段不超过 MAX_CHUNK_CHARS */
function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const parts: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (current.length > 0 && current.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
      parts.push(current);
      current = '';
    }
    current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
    while (current.length > MAX_CHUNK_CHARS) {
      parts.push(current.slice(0, MAX_CHUNK_CHARS));
      current = current.slice(MAX_CHUNK_CHARS);
    }
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

/**
 * 按标题把一篇 Markdown 切成段。# / ## / ### 开新段，更深的标题并入当前段。
 * 标题路径作为段的上下文，同时参与检索，并逐级解析/继承元数据。
 */
export function chunkMarkdown(file: string, markdown: string): NoteChunk[] {
  const fallbackTitle = basename(file, extname(file));
  const dirMeta = deriveDirMeta(file);
  const { patch: fmPatch, body: markdownBody } = extractFrontmatter(markdown);
  const fileMeta = fmPatch === undefined ? dirMeta : mergeNoteMeta(dirMeta, fmPatch);

  const stack: string[] = [];
  const metaStack: NoteMeta[] = [fileMeta];
  const chunks: NoteChunk[] = [];
  let body: string[] = [];
  let currentLevel = 0;

  const flush = (): void => {
    const rawLines = body;
    body = [];
    const heading = stack.length > 0 ? stack.join(' › ') : fallbackTitle;
    const parentMeta = currentLevel === 0 ? fileMeta : (metaStack[currentLevel - 1] ?? fileMeta);
    const { meta, bodyLines } = parseSectionMeta(rawLines, parentMeta, file, heading);
    // Directory ownership cannot be rewritten by frontmatter or section metadata.
    if (dirMeta.scope.chatKey !== undefined) {
      meta.scope.chatKey = dirMeta.scope.chatKey;
      meta.kind = 'chat';
    }
    if (currentLevel >= 1) metaStack[currentLevel] = meta;
    const text = bodyLines.join('\n').trim();
    if (text.length === 0) return;
    const recall = readRecallBody(text);
    const section = recall === undefined ? undefined : { text, recall };
    for (const part of splitLong(text)) chunks.push({ file, heading, text: part.trim(), meta, ...(section && { section }) });
  };

  for (const line of markdownBody.split(/\r?\n/)) {
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match === null) {
      body.push(line);
      continue;
    }
    flush();
    const level = match[1]!.length;
    stack.length = Math.min(stack.length, level - 1);
    stack[level - 1] = match[2]!;
    // 标题跳级（# 后直接 ###）时补齐中间层，避免 join 出 undefined
    for (let i = 0; i < level - 1; i++) stack[i] ??= fallbackTitle;

    metaStack.length = Math.min(metaStack.length, level);
    for (let i = 1; i < level; i++) metaStack[i] ??= metaStack[i - 1] ?? fileMeta;
    currentLevel = level;
  }
  flush();
  return chunks;
}

/** 归档目录：点开头，不进检索索引 */
const ARCHIVE_DIR = '.archive';

function readRecallBody(text: string): string | undefined {
  const label = /^召回正文[：:]/u.exec(text);
  if (!label) return undefined;
  return text.slice(label[0].length).split(/^依据[：:]/mu, 1)[0]!.trim();
}

export interface ArchiveNoteResult {
  /** 归档到哪（相对笔记根目录） */
  archivedTo: string;
  chars: number;
  /** 原文件是否整个移走了 */
  fileRemoved: boolean;
  message: string;
}

/**
 * 从一篇 Markdown 里切出标题路径为 heading 的那一节（标题行 + 到下一个 #/##/### 之前的正文）。
 * 同一路径出现多次时用 occurrence（从 1 起）指定；不指定且不唯一时只返回 matches，让调用方去问。
 * 这一节下面还挂着更深的小节时只切正文、保留标题行，否则那些小节会被并到上一个标题下面。
 */
export function cutSection(
  file: string,
  markdown: string,
  heading: string,
  occurrence?: number,
): { matches: number; removed?: string; rest?: string } {
  const fallbackTitle = basename(file, extname(file));
  const lines = markdown.split(/\r?\n/);
  const stack: string[] = [];
  const sections: Array<{ path: string; level: number; start: number; end: number }> = [];
  lines.forEach((line, index) => {
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match === null) return;
    const level = match[1]!.length;
    stack.length = Math.min(stack.length, level - 1);
    stack[level - 1] = match[2]!;
    for (let i = 0; i < level - 1; i++) stack[i] ??= fallbackTitle;
    const last = sections[sections.length - 1];
    if (last !== undefined) last.end = index;
    sections.push({ path: stack.join(' › '), level, start: index, end: lines.length });
  });
  const found = sections.filter((section) => section.path === heading);
  if (found.length === 0 || (found.length > 1 && occurrence === undefined)) return { matches: found.length };
  const target = found[(occurrence ?? 1) - 1];
  if (target === undefined) return { matches: found.length };
  const next = sections[sections.indexOf(target) + 1];
  const keepHeading = next !== undefined && next.level > target.level;
  const from = keepHeading ? target.start + 1 : target.start;
  const removed = lines.slice(target.start, target.end).join('\n').trim();
  const rest = [...lines.slice(0, from), ...lines.slice(target.end)].join('\n').replace(/\n{3,}/g, '\n\n');
  return { matches: found.length, removed, rest };
}

/** 文件名净化：去路径与非法字符，补 .md 扩展名 */
function sanitizeNoteFileName(name: string): string {
  const base = basename(name.replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const safe = base.length > 0 && base !== '.' && base !== '..' ? base : 'note';
  return extname(safe).toLowerCase() === '.md' ? safe : `${safe}.md`;
}

/** QQ 会话的笔记会话键 */
export function chatKeyOf(scope: string, peerId: string): string {
  return `${scope}_${peerId}`;
}

/** 这段笔记属于哪个会话；共享笔记返回 undefined */
function chatOwnerOf(file: string): string | undefined {
  const parts = file.split('/');
  return parts.length >= 3 && parts[0] === CHAT_NOTES_DIR ? parts[1] : undefined;
}

function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchTriggerList(triggers: readonly string[] | undefined, normalizedQuery: string): string[] {
  if (!triggers || triggers.length === 0 || normalizedQuery === '') return [];
  const matched: string[] = [];
  for (const trig of triggers) {
    const nt = trig.normalize('NFKC').trim().toLowerCase();
    if (nt === '') continue;
    if (/^[a-z0-9_.-]+$/i.test(nt)) {
      if (new RegExp(`(?<![a-z0-9_-])${escapeRegExp(nt)}(?![a-z0-9_-])`, 'i').test(normalizedQuery)) {
        matched.push(trig);
      }
    } else if (normalizedQuery.includes(nt)) {
      matched.push(trig);
    }
  }
  return matched;
}

function matchTargetRef(ref: string, candidate: Pick<IndexedChunk, 'file' | 'heading'>): boolean {
  const normRef = ref.split('\\').join('/').replace(/^\.?\//, '').trim();
  if (normRef === '') return false;
  return candidate.file === normRef
    || `${candidate.file} › ${candidate.heading}` === normRef
    || candidate.heading === normRef;
}

function compatibleReplacement(a: IndexedChunk, b: IndexedChunk): boolean {
  // A narrower audience must never invalidate evidence for a broader audience.
  const canonical = (meta: NoteMeta): string => JSON.stringify([
    meta.scope.chatKey ?? '',
    ...(['projects', 'personas', 'scenes', 'models'] as const).map((key) =>
      (meta.scope[key] ?? []).map((v) => v.normalize('NFKC').toLowerCase()).sort()),
  ]);
  return canonical(a.rawMeta) === canonical(b.rawMeta);
}

function resolveTargetRef(ref: string, chunks: IndexedChunk[]): IndexedChunk[] {
  const found = chunks.filter((chunk) => matchTargetRef(ref, chunk));
  const norm = ref.replace(/\\/g, '/').replace(/^\.?\//, '').trim();
  // A file reference intentionally selects the file; a bare heading must identify one section.
  if (found.some((chunk) => chunk.file === norm)) return found;
  const sections = new Set(found.map((chunk) => `${chunk.file} › ${chunk.heading}`));
  const section = found[0]?.section;
  return sections.size === 1 && (found.length === 1 || (section && found.every(chunk => chunk.section === section))) ? found : [];
}

function resolveSupersessionLinks(chunks: IndexedChunk[]): void {
  for (const newer of chunks) {
    if (newer.rawMeta.status === 'superseded') continue;
    for (const ref of newer.rawMeta.supersedes ?? []) {
      for (const older of resolveTargetRef(ref, chunks)) {
        if (older === newer || !compatibleReplacement(older, newer)) continue;
        if (compareNoteDates(newer.rawMeta.date, older.rawMeta.date) < 0) continue;
        older.meta.status = 'superseded';
        const index = chunks.indexOf(newer);
        if (!older.replacedByIndices.includes(index)) older.replacedByIndices.push(index);
      }
    }
  }
  for (const older of chunks) {
    if (!older.rawMeta.supersededBy) continue;
    for (const newer of resolveTargetRef(older.rawMeta.supersededBy, chunks)) {
      if (newer === older || newer.meta.status === 'superseded' || !compatibleReplacement(older, newer)) continue;
      older.meta.status = 'superseded';
      const index = chunks.indexOf(newer);
      if (!older.replacedByIndices.includes(index)) older.replacedByIndices.push(index);
    }
  }
}

export class NotesStore {
  public readonly root: string;
  private readonly logger: Logger | undefined;
  private chunks: IndexedChunk[] = [];
  private docFreq = new Map<string, number>();
  private avgLength = 0;
  private signature = '';
  private lastScan = 0;
  private semantic: { cache: EmbeddingCache; gate: SemanticGate } | undefined;

  public constructor(root: string, logger?: Logger) {
    this.root = root;
    this.logger = logger;
  }

  /** 当前索引的段数（测试/日志用） */
  public get size(): number {
    this.refresh();
    return this.chunks.length;
  }

  /** 挂上语义检索（向量缓存 + 相似度门槛）；传 undefined 关闭 */
  public setSemantic(cache: EmbeddingCache | undefined, gate: SemanticGate = { minSimilarity: 0.5, minMargin: 0.16 }): void {
    this.semantic = cache === undefined ? undefined : { cache, gate };
    if (cache === undefined) return;
    this.refresh();
    void cache.warm(this.chunks.map(embeddingText));
  }

  /**
   * 检索最相关的 limit 段（BM25 + 字面精确匹配 + 显式触发词）。查询为空或没有任何命中时返回空数组。
   * 给了 chatKey 时，别的会话的私有笔记（chats/<别的会话>/）不参与检索。
   */
  public search(
    query: string,
    limit = 5,
    chatKey?: string,
    context: Omit<NoteQueryContext, 'chatKey'> = {},
  ): NoteHit[] {
    this.refresh();
    const queryCtx: NoteQueryContext = { ...context, ...(chatKey === undefined ? {} : { chatKey }) };
    return this.rank(query, limit, queryCtx);
  }

  /**
   * 同 search，再加向量语义一路。没挂语义检索、接口失败或超时时等同于 search。
   * 笔记向量在后台补算，还没算好的段这一轮只是不参与语义一路。
   * sharedOnly：只检索共享笔记，跳过所有会话私有笔记（开团时本群的跑团笔记交给团况注入，不走自动召回）。
   */
  public async searchHybrid(
    query: string,
    limit = 5,
    chatKey?: string,
    options: Omit<NoteQueryContext, 'chatKey'> = {},
  ): Promise<NoteHit[]> {
    this.refresh();
    const queryCtx: NoteQueryContext = { ...options, ...(chatKey === undefined ? {} : { chatKey }) };
    const semantic = this.semantic;
    if (semantic === undefined || this.chunks.length === 0) return this.rank(query, limit, queryCtx);
    void semantic.cache.warm(this.chunks.map(embeddingText));
    const queryVector = await semantic.cache.embedQuery(query);
    if (queryVector === undefined) return this.rank(query, limit, queryCtx);

    const vectors: Array<{ id: string; vector: Float32Array }> = [];
    this.chunks.forEach((chunk, index) => {
      if (!matchesNoteScope(chunk.meta, queryCtx, query)) return;
      const vector = semantic.cache.vectorFor(embeddingText(chunk));
      if (vector !== undefined) vectors.push({ id: String(index), vector });
    });
    return this.rank(query, limit, queryCtx, gateSimilarities(queryVector, vectors, semantic.gate));
  }

  /** 索引里有没有这一段（file + 完整标题路径） */
  public hasSection(file: string, heading: string): boolean {
    this.refresh();
    return this.chunks.some((chunk) => chunk.file === file && chunk.heading === heading);
  }

  /** 低分榜只看索引里仍可参与常规自动注入的段；账本本身不跟随文件生命周期删除。 */
  public filterAutoInjectableSections<T extends { file: string; heading: string }>(rows: readonly T[]): T[] {
    this.refresh();
    const active = new Set(this.chunks.filter((chunk) => allowsAutoInjection(chunk.meta))
      .map((chunk) => `${chunk.file}\0${chunk.heading}`));
    return rows.filter((row) => active.has(`${row.file}\0${row.heading}`));
  }

  /** 会话私有笔记的标题（每个文件的一级标题，没有就用文件名），给团况注入列个目录 */
  public chatNoteTitles(chatKey: string): string[] {
    this.refresh();
    const dir = chatNotesDir(chatKey);
    const titles = new Map<string, string>();
    for (const chunk of this.chunks) {
      if (chatOwnerOf(chunk.file) !== dir || titles.has(chunk.file)) continue;
      titles.set(chunk.file, chunk.heading.split(' › ')[0]!);
    }
    return [...titles.values()];
  }

  /** BM25 粗检索 + 字面精确/显式触发词 + （可选）语义相似度，三路 RRF 融合 + 新旧关系解析 */
  private rank(
    query: string,
    limit: number,
    queryCtx: NoteQueryContext,
    similarity?: ReadonlyMap<string, number>,
  ): NoteHit[] {
    const queryTerms = [...new Set(tokenize(query))];
    const normalizedQuery = query.normalize('NFKC').toLowerCase();
    if ((normalizedQuery.trim() === '' && !queryCtx.operations?.length) || this.chunks.length === 0) return [];

    const total = this.chunks.length;
    const knownTerms = queryTerms.filter((term) => this.docFreq.has(term)).length;

    interface Candidate {
      id: string;
      chunk: IndexedChunk;
      score: number;
      matched: number;
      coverage: number;
      triggeredBy: string[];
      operationMatches: string[];
      matchedTerms: string[];
      hasDistinctiveTerm: boolean;
      distinctiveSet: Set<string>;
    }

    const distinctiveDfCutoff = Math.max(2, Math.floor(total * 0.25));
    const candidates: Candidate[] = [];
    let anyTrigger = false;

    this.chunks.forEach((chunk, index) => {
      if (!matchesNoteScope(chunk.meta, queryCtx, query)) return;
      let score = 0;
      let matched = 0;
      const matchedEntries: Array<{ term: string; idf: number; df: number }> = [];

      for (const term of queryTerms) {
        const tf = chunk.terms.get(term);
        if (tf === undefined) continue;
        matched++;
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        const norm = BM25_K1 * (1 - BM25_B + BM25_B * (chunk.length / (this.avgLength || 1)));
        score += idf * ((tf * (BM25_K1 + 1)) / (tf + norm));
        matchedEntries.push({ term, idf, df });
      }

      matchedEntries.sort((a, b) => (b.idf - a.idf) || (b.term.length - a.term.length));
      const matchedTerms = matchedEntries.slice(0, 4).map((e) => e.term);
      const hasDistinctiveTerm = total < DISTINCTIVE_CORPUS_MIN_CHUNKS
        ? matched > 0 || (similarity?.has(String(index)) ?? false)
        : matchedEntries.some((e) => e.df / total <= DISTINCTIVE_MAX_DF_RATIO);

      const operationMatches = (chunk.meta.operations ?? []).filter((op) =>
        queryCtx.operations?.some((queryOp) => queryOp.normalize('NFKC').trim().toLowerCase() === op.normalize('NFKC').trim().toLowerCase()));
      const triggeredBy = matchTriggerList(chunk.meta.triggers, normalizedQuery);
      if (triggeredBy.length > 0) anyTrigger = true;

      const distinctiveSet = new Set<string>();
      for (const term of chunk.terms.keys()) {
        const df = this.docFreq.get(term) ?? 1;
        if (term.length >= 2 && df <= distinctiveDfCutoff) distinctiveSet.add(term);
      }

      candidates.push({
        id: String(index),
        chunk,
        score,
        matched,
        coverage: matched / (knownTerms || 1),
        triggeredBy,
        operationMatches,
        matchedTerms,
        hasDistinctiveTerm,
        distinctiveSet,
      });
    });

    if (queryTerms.length === 0 && (similarity?.size ?? 0) === 0 && !anyTrigger && !queryCtx.operations?.length) return [];

    const hits = candidates
      .filter((c) => c.matched > 0 || c.triggeredBy.length > 0 || c.operationMatches.length > 0)
      .sort((a, b) => (b.score - a.score) || (b.triggeredBy.length - a.triggeredBy.length));

    // 精确一路扫全部 BM25 命中段而不是只扫粗检索前几名：字面量的切词必然也是 BM25 词，
    // 含有它的段一定在 hits 里，这样被粗检索截断的段也能被捞回来
    const exact = scoreExact(
      query,
      hits.filter((h) => h.matched > 0).map((hit) => ({ id: hit.id, text: embeddingText(hit.chunk), terms: hit.chunk.terms })),
      candidates.length,
    );

    const exactForFusion = new Map<string, ExactScore>(exact);
    for (const c of hits) {
      if (c.triggeredBy.length === 0 && c.operationMatches.length === 0) continue;
      const existing = exactForFusion.get(c.id);
      exactForFusion.set(c.id, {
        score: Math.max(EXACT_STRONG_SCORE, (existing?.score ?? 0) + c.triggeredBy.length + c.operationMatches.length),
        matched: existing?.matched ?? [],
      });
    }

    // 语义一路从全部可见段里召回：同义/换说法的段可能一个词都没和查询撞上
    const fused = fuseRankings(hits.slice(0, COARSE_POOL), (hit) => hit.id, {
      exact: exactForFusion,
      semantic: similarity,
      extra: candidates,
    });

    const candidateById = new Map(candidates.map((c) => [c.id, c]));
    const fusedById = new Map(fused.map((f) => [f.item.id, f]));
    const originalFused = new Map(fused.map((f) => [f.item.id, f.fused]));
    const rescuedFrom = new Map<string, IndexedChunk>();
    const rescuedQualifying = new Map<string, { coverage: number; matched: number; strong: boolean }>();

    // 过期降权 + 替代补召回：若命中了旧记录，把其关联的新记录补进来并压低旧记录权重
    for (const entry of [...fused]) {
      const oldCand = entry.item;
      const oldChunk = oldCand.chunk;
      if (oldChunk.meta.status !== 'superseded') continue;
      const origScore = originalFused.get(oldCand.id) ?? entry.fused;
      entry.fused = origScore * 0.35;

      const oldExactScore = exact.get(oldCand.id)?.score ?? 0;
      const oldStrong = oldCand.triggeredBy.length > 0
        || oldExactScore >= EXACT_STRONG_SCORE
        || entry.similarity !== undefined;

      for (const repIdx of oldChunk.replacedByIndices) {
        const repCand = candidateById.get(String(repIdx));
        if (repCand === undefined || repCand.chunk.meta.status === 'superseded') continue;
        const existingRep = fusedById.get(repCand.id);
        const recordRescue = (): void => {
          rescuedFrom.set(repCand.id, oldChunk);
          rescuedQualifying.set(repCand.id, {
            coverage: oldCand.coverage,
            matched: oldCand.matched,
            strong: oldStrong || (oldCand.matched >= INJECT_MIN_MATCHED_TERMS && oldCand.hasDistinctiveTerm),
          });
        };
        if (existingRep === undefined) {
          const rescuedEntry = {
            item: repCand,
            fused: origScore * 1.05,
            ...(exact.has(repCand.id) ? { exact: exact.get(repCand.id) } : {}),
            ...(similarity?.has(repCand.id) ? { similarity: similarity.get(repCand.id) } : {}),
          };
          fused.push(rescuedEntry);
          fusedById.set(repCand.id, rescuedEntry);
          recordRescue();
        } else if (existingRep.fused < origScore * 1.01) {
          existingRep.fused = origScore * 1.01;
          recordRescue();
        }
      }
    }

    // 三层新旧冲突识别
    const conflictsById = new Map<string, NoteConflict[]>();
    const activePool = fused.filter((f) => f.item.chunk.meta.status !== 'superseded').slice(0, 20);
    const boostedTier2 = new Set<string>();
    const newerBumpPairs: Array<{ olderId: string; newerId: string }> = [];

    for (const entry of fused) {
      const cand = entry.item;
      const chunk = cand.chunk;
      const list: NoteConflict[] = [];

      if (chunk.meta.status === 'superseded') {
        for (const repIdx of chunk.replacedByIndices) {
          const repChunk = this.chunks[repIdx];
          if (repChunk === undefined || repChunk.meta.status === 'superseded' || !matchesNoteScope(repChunk.meta, queryCtx, query)) continue;
          list.push({
            file: repChunk.file,
            heading: repChunk.heading,
            ...(repChunk.meta.date === undefined ? {} : { date: repChunk.meta.date }),
            relation: 'superseded-by',
          });
        }

      } else {
        for (const other of activePool) {
          if (other.item.id === cand.id || !compatibleReplacement(chunk, other.item.chunk)) continue;
          const b = other.item;
          if (compareNoteDates(b.chunk.meta.date, chunk.meta.date) <= 0) continue;

          let shared = 0;
          let sharedInHeading = false;
          for (const term of cand.distinctiveSet) {
            if (!b.distinctiveSet.has(term)) continue;
            shared++;
            if (cand.chunk.headingTerms.has(term) || b.chunk.headingTerms.has(term)) {
              sharedInHeading = true;
            }
          }

          if (DEPRECATION_RE.test(b.chunk.text) && shared >= 2) {
            list.push({
              file: b.chunk.file,
              heading: b.chunk.heading,
              ...(b.chunk.meta.date === undefined ? {} : { date: b.chunk.meta.date }),
              relation: 'deprecated-by',
            });
            if (!boostedTier2.has(b.id)) {
              boostedTier2.add(b.id);
              other.fused *= 1.15;
            }
            newerBumpPairs.push({ olderId: cand.id, newerId: b.id });
          } else if (
            activePool.indexOf(other) < 15
            && ((b.chunk.file === chunk.file && shared >= 2) || (shared >= 3 && sharedInHeading))
          ) {
            list.push({
              file: b.chunk.file,
              heading: b.chunk.heading,
              ...(b.chunk.meta.date === undefined ? {} : { date: b.chunk.meta.date }),
              relation: 'newer-evidence',
            });
            newerBumpPairs.push({ olderId: cand.id, newerId: b.id });
          }
        }
      }

      if (list.length > 0) conflictsById.set(cand.id, list);
    }

    // 融合分接近（< 10%）时，让更新证据稳妥排在旧证据前面，同时保持全局排序严格可传递
    for (const { olderId, newerId } of newerBumpPairs) {
      const olderEntry = fusedById.get(olderId);
      const newerEntry = fusedById.get(newerId);
      if (olderEntry === undefined || newerEntry === undefined) continue;
      if (olderEntry.fused >= newerEntry.fused && (olderEntry.fused - newerEntry.fused) / Math.max(olderEntry.fused, 1e-9) < 0.1) {
        newerEntry.fused = olderEntry.fused * 1.02;
      }
    }

    fused.sort((a, b) =>
      b.fused - a.fused
      || (exact.get(b.item.id)?.score ?? 0) - (exact.get(a.item.id)?.score ?? 0)
      || (b.similarity ?? 0) - (a.similarity ?? 0)
      || (a.coarseRank ?? Infinity) - (b.coarseRank ?? Infinity));

    // 同一段内容被复制到多个文件时只留排名最高的一份
    const seenText = new Set<string>();
    const seenSections = new Set<NonNullable<NoteChunk['section']>>();
    const result: NoteHit[] = [];
    for (const entry of fused) {
      if (result.length >= Math.max(0, limit)) break;
      const cand = entry.item;
      const chunk = cand.chunk;
      if (chunk.section && seenSections.has(chunk.section)) continue;
      if (chunk.section) seenSections.add(chunk.section);
      const key = (chunk.section?.text ?? chunk.text).replace(/\s+/g, ' ').trim();
      if (seenText.has(key)) continue;
      seenText.add(key);

      const exactScore = exact.get(cand.id);
      const sim = entry.similarity;
      const conflicts = conflictsById.get(cand.id);
      const rescued = rescuedFrom.get(cand.id);
      const rescuedInfo = rescuedQualifying.get(cand.id);

      const why = buildTriggerReason({
        rescuedFrom: rescued,
        triggeredBy: cand.triggeredBy,
        exact: exactScore,
        matched: cand.matched,
        matchedTerms: cand.matchedTerms,
        coverage: cand.coverage,
        similarity: sim,
      });

      const publicMeta = cloneNoteMeta(chunk.meta);
      delete publicMeta.supersedes;
      delete publicMeta.supersededBy;
      const visibleReplacement = chunk.replacedByIndices.map((i) => this.chunks[i]!).find((c) => matchesNoteScope(c.meta, queryCtx, query));
      if (visibleReplacement) publicMeta.supersededBy = `${visibleReplacement.file} › ${visibleReplacement.heading}`;
      result.push({
        file: chunk.file,
        heading: chunk.heading,
        text: chunk.section?.text ?? chunk.text,
        ...(chunk.section && { section: chunk.section }),
        meta: publicMeta,
        score: cand.score,
        matched: cand.matched,
        coverage: cand.coverage,
        scopeLabel: describeNoteScope(chunk.meta),
        ...(cand.operationMatches.length ? { why: `操作「${cand.operationMatches.slice(0, 2).join('、')}」${why ? ` + ${why}` : ''}`, operationMatches: cand.operationMatches } : why === undefined ? {} : { why }),
        ...(cand.triggeredBy.length === 0 ? {} : { triggeredBy: cand.triggeredBy }),
        ...(cand.matchedTerms.length === 0 ? {} : { matchedTerms: cand.matchedTerms }),
        hasDistinctiveTerm: cand.hasDistinctiveTerm,
        ...(rescuedInfo !== undefined && rescuedInfo.strong ? { rescuedFromQualifying: true } : {}),
        ...(exactScore === undefined ? {} : { exact: exactScore }),
        ...(sim === undefined ? {} : { similarity: sim }),
        ...(conflicts === undefined ? {} : { conflicts }),
      });
    }
    return result;
  }

  /** 写入一条笔记：新标题建文件，指定已有文件则追加为一个小节 */
  public save(input: SaveNoteInput): SaveNoteResult {
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 80);
    const content = input.content.trim();
    if (title.length === 0) throw new Error('笔记标题不能为空');
    if (content.length === 0) throw new Error('笔记内容不能为空');
    if (content.length > MAX_SAVE_CHARS) throw new Error(`笔记内容过长（${content.length} 字，上限 ${MAX_SAVE_CHARS}）`);

    const dir = input.chatKey === undefined ? this.root : join(this.root, CHAT_NOTES_DIR, chatNotesDir(input.chatKey));
    mkdirSync(dir, { recursive: true });
    const fileName = sanitizeNoteFileName(input.file ?? title);
    const path = join(dir, fileName);
    const shownName = input.chatKey === undefined ? fileName : `${CHAT_NOTES_DIR}/${chatNotesDir(input.chatKey)}/${fileName}`;

    const scope: NoteMeta['scope'] = {
      ...(input.projects?.length ? { projects: input.projects } : {}),
      ...(input.personas?.length ? { personas: input.personas } : {}),
      ...(input.scenes?.length ? { scenes: input.scenes } : {}),
      ...(input.models?.length ? { models: input.models } : {}),
    };
    const metaObj: Partial<NoteMeta> = {
      date: input.date ?? today(),
      ...(input.source ? { source: input.source } : {}),
      scope,
      ...(input.operations?.length ? { operations: input.operations } : {}),
      ...(input.triggers?.length ? { triggers: input.triggers } : {}),
      ...(input.inject === 'search-only' ? { inject: 'search-only' } : {}),
      ...(input.budgetChars !== undefined && input.budgetChars >= 0 ? { budgetChars: input.budgetChars } : {}),
      ...(input.supersedes?.length ? { supersedes: input.supersedes } : {}),
    };
    const meta = formatMetaBlockquote(metaObj, today());
    const created = !existsSync(path);

    if (created) {
      writeTextAtomic(path, `# ${title}\n\n${meta}\n\n${content}\n`);
    } else {
      appendFileSync(path, `\n## ${title}\n\n${meta}\n\n${content}\n`, 'utf8');
    }
    this.lastScan = 0; // 下次检索立即重建索引

    this.logger?.info(`im-qqbot: 笔记${created ? '新建' : '追加'} ${shownName}（${content.length} 字）`);
    const resolvedScope = describeNoteScope({
      kind: 'general',
      scope: {
        ...(input.chatKey === undefined ? {} : { chatKey: chatNotesDir(input.chatKey) }),
        ...scope,
      },
      inject: input.inject ?? 'auto',
      status: 'active',
    });
    const audience = input.chatKey === undefined
      ? (resolvedScope === '跨会话通用' ? '所有会话' : `${resolvedScope} 范围`)
      : '只有本会话';
    const supersedeNote = input.supersedes?.length ? `，已关联替代：${input.supersedes.join('、')}` : '';
    return {
      file: fileName,
      created,
      chars: content.length,
      message: `${created ? '已新建笔记' : '已追加到笔记'} ${fileName}「${title}」（${content.length} 字），${audience}下次检索即可用${supersedeNote}。`,
    };
  }

  private sectionForEdit(input: { file: string; heading?: string; occurrence?: number }) {
    this.lastScan = 0;
    this.refresh();
    const file = input.file.split('\\').join('/').replace(/^\.?\//, '');
    if (!this.chunks.some((chunk) => chunk.file === file)) {
      throw new Error(`笔记库里没有 ${file}（要写相对笔记根目录的路径，会话私有笔记形如 chats/<会话>/xxx.md）`);
    }
    const source = join(this.root, file);
    const raw = readFileSync(source, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);

    // 跳过文件头 YAML frontmatter，免得里面的注释被误认成标题
    let bodyStart = 0;
    if (lines[0]?.trim() === '---') {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === '---') {
          bodyStart = i + 1;
          break;
        }
      }
    }

    const fallbackTitle = basename(file, extname(file));
    const stack: string[] = [];
    const sections: Array<{ path: string; level: number; start: number; end: number }> = [];
    for (let index = bodyStart; index < lines.length; index++) {
      const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(lines[index]!);
      if (match === null) continue;
      const level = match[1]!.length;
      stack.length = Math.min(stack.length, level - 1);
      stack[level - 1] = match[2]!;
      for (let i = 0; i < level - 1; i++) stack[i] ??= fallbackTitle;
      const last = sections[sections.length - 1];
      if (last !== undefined) last.end = index;
      sections.push({ path: stack.join(' › '), level, start: index, end: lines.length });
    }

    const requestedHeading = input.heading?.trim() ?? '';
    if (!sections.length) sections.push({ path: fallbackTitle, level: 0, start: bodyStart, end: lines.length });
    let target: { path: string; level: number; start: number; end: number };
    if (requestedHeading !== '') {
      const found = sections.filter((section) => section.path === requestedHeading);
      if (found.length === 0) {
        throw new Error(`${file} 里没有标题路径为「${requestedHeading}」的小节（要写完整路径，如「一级 › 二级」）`);
      }
      if (found.length > 1 && input.occurrence === undefined) {
        throw new Error(`${file} 里「${requestedHeading}」有 ${found.length} 节，用 occurrence（1-${found.length}）指定第几节`);
      }
      const picked = found[(input.occurrence ?? 1) - 1];
      if (picked === undefined) {
        throw new Error(`${file} 里「${requestedHeading}」没有第 ${input.occurrence} 节`);
      }
      target = picked;
    } else {
      target = sections[0]!;
    }

    const contentStart = target.level > 0 ? target.start + 1 : bodyStart;
    let firstNonEmpty = -1;
    for (let i = contentStart; i < target.end; i++) {
      if (lines[i]!.trim() !== '') {
        firstNonEmpty = i;
        break;
      }
    }
    return { file, source, lines, eol, target, contentStart, firstNonEmpty };
  }

  /** Replace only the reviewed body. A changed or ambiguous target requires a fresh review. */
  public revise(file: string, heading: string, expectedContent: string, content: string): string {
    if (!heading.trim() || !expectedContent.trim()) throw new Error('原节标题和审阅过的原文不能为空');
    const next = content.replace(/\r\n/g, '\n').trim();
    if (!readRecallBody(next) || next.length > MAX_SAVE_CHARS || /^#{1,3}\s/m.test(next)) {
      throw new Error('请提供带完整「召回正文：」的一节，保留依据，勿新增标题或超过字数上限');
    }
    const { source, lines, eol, target, firstNonEmpty } = this.sectionForEdit({ file, heading });
    let start = firstNonEmpty;
    if (start < 0) throw new Error('目标节没有原文');
    if (parseMetaBlockquote(lines[start]!) !== undefined) start++;
    while (start < target.end && !lines[start]!.trim()) start++;
    let end = target.end;
    while (end > start && !lines[end - 1]!.trim()) end--;
    if (lines.slice(start, end).join('\n').trim() !== expectedContent.replace(/\r\n/g, '\n').trim()) {
      throw new Error('原文与审阅内容不一致，请重新读取该节');
    }
    lines.splice(start, end - start, ...next.split('\n'));
    writeTextAtomic(source, lines.join(eol));
    this.signature = '';
    this.lastScan = 0;
    return `已修订 ${file} › ${heading}`;
  }

  public supersede(input: SupersedeNoteInput): SupersedeNoteResult {
    const supersededBy = input.supersededBy.trim();
    if (supersededBy === '') throw new Error('supersededBy 不能为空');
    const { file, source, lines, eol, target, contentStart, firstNonEmpty } = this.sectionForEdit(input);
    const matchedChunk = this.chunks.find(c => c.file === file && c.heading === target.path);
    const fallbackDate = matchedChunk?.meta.date ?? today();

    if (firstNonEmpty >= 0 && parseMetaBlockquote(lines[firstNonEmpty]!) !== undefined) {
      lines[firstNonEmpty] = upsertMetaInBlockquote(
        lines[firstNonEmpty],
        { status: 'superseded', supersededBy },
        fallbackDate,
      );
    } else {
      const metaLine = upsertMetaInBlockquote(undefined, { status: 'superseded', supersededBy }, fallbackDate);
      const insertAt = contentStart;
      const insertLines = lines[insertAt]?.trim() === '' ? ['', metaLine] : ['', metaLine, ''];
      lines.splice(insertAt, 0, ...insertLines);
    }

    writeTextAtomic(source, lines.join(eol));
    this.lastScan = 0;
    this.logger?.info(`im-qqbot: 笔记标记过期 ${file} › ${target.path} -> ${supersededBy}`);
    return {
      file,
      heading: target.path,
      message: `已将 ${file} › ${target.path} 标记为已过期（保留原日期与来源），替代记录：${supersededBy}。`,
    };
  }

  /**
   * 把一篇笔记或其中一节移进 .archive/<日期>/（不进索引，原文留着可以搬回来）。
   * 只认索引里有的文件：路径由模型给出，不能让它指到笔记目录外面去。
   */
  public archive(input: { file: string; heading?: string; occurrence?: number }): ArchiveNoteResult {
    this.lastScan = 0;
    this.refresh();
    const file = input.file.split('\\').join('/').replace(/^\.?\//, '');
    if (!this.chunks.some((chunk) => chunk.file === file)) {
      throw new Error(`笔记库里没有 ${file}（要写相对笔记根目录的路径，会话私有笔记形如 chats/<会话>/xxx.md）`);
    }
    const source = join(this.root, file);
    const target = this.archivePath(file);
    mkdirSync(dirname(target.abs), { recursive: true });
    const heading = input.heading?.trim() ?? '';

    if (heading === '') {
      const chars = readFileSync(source, 'utf8').length;
      this.moveWhole(source, target.abs);
      this.lastScan = 0;
      this.logger?.info(`im-qqbot: 笔记归档 ${file} → ${target.rel}`);
      return { archivedTo: target.rel, chars, fileRemoved: true, message: `已把 ${file} 整篇归档到 ${target.rel}（${chars} 字）。` };
    }

    const markdown = readFileSync(source, 'utf8');
    const cut = cutSection(file, markdown, heading, input.occurrence);
    if (cut.matches === 0) throw new Error(`${file} 里没有标题路径为「${heading}」的小节（要写完整路径，如「一级 › 二级」）`);
    if (cut.removed === undefined || cut.rest === undefined) {
      throw new Error(`${file} 里「${heading}」有 ${cut.matches} 节，用 occurrence（1-${cut.matches}）指定第几节`);
    }
    // 切完没有任何可检索的内容了，就整篇移走，免得留一个空标题在索引里
    if (chunkMarkdown(file, cut.rest).length === 0) {
      this.moveWhole(source, target.abs);
      this.lastScan = 0;
      this.logger?.info(`im-qqbot: 笔记归档 ${file} → ${target.rel}（最后一节）`);
      return {
        archivedTo: target.rel,
        chars: cut.removed.length,
        fileRemoved: true,
        message: `「${heading}」是 ${file} 里最后一节有内容的小节，已把整篇归档到 ${target.rel}。`,
      };
    }
    appendFileSync(target.abs, `<!-- 归档自 ${file} › ${heading}，${today()} -->\n${cut.removed}\n\n`, 'utf8');
    writeTextAtomic(source, cut.rest);
    this.lastScan = 0;
    this.logger?.info(`im-qqbot: 笔记小节归档 ${file} › ${heading} → ${target.rel}`);
    return {
      archivedTo: target.rel,
      chars: cut.removed.length,
      fileRemoved: false,
      message: `已把 ${file}「${heading}」归档到 ${target.rel}（${cut.removed.length} 字）。`,
    };
  }

  /** 整篇移进归档；当天已经归档过它的小节时接在后面，不覆盖 */
  private moveWhole(source: string, target: string): void {
    if (!existsSync(target)) {
      renameSync(source, target);
      return;
    }
    appendFileSync(target, `<!-- 以下是原文件剩余部分，${today()} -->
${readFileSync(source, 'utf8')}
`, 'utf8');
    unlinkSync(source);
  }

  /** 归档目标路径：.archive/<日期>/<原相对路径>；整篇归档遇到同名时加序号，小节归档往同一个文件里追加 */
  private archivePath(file: string): { abs: string; rel: string } {
    return { abs: join(this.root, ARCHIVE_DIR, today().replace(/-/g, ''), file), rel: `${ARCHIVE_DIR}/${today().replace(/-/g, '')}/${file}` };
  }

  /** 目录有变化时重建索引（节流） */
  private refresh(): void {
    const now = Date.now();
    if (now - this.lastScan < RESCAN_INTERVAL_MS) return;
    this.lastScan = now;

    const files = this.listFiles();
    const signature = files.map((f) => `${f.rel}:${f.mtimeMs}:${f.size}`).join('|');
    if (signature === this.signature) return;
    this.signature = signature;

    const chunks: IndexedChunk[] = [];
    for (const file of files) {
      let markdown: string;
      try {
        markdown = readFileSync(file.abs, 'utf8');
      } catch {
        continue;
      }
      for (const chunk of chunkMarkdown(file.rel, markdown)) {
        const meta = chunk.meta ?? deriveDirMeta(chunk.file);
        const tokens = tokenize(embeddingText(chunk));
        const headingTerms = new Set(tokenize(chunk.heading));
        chunks.push({
          ...chunk,
          meta: cloneNoteMeta(meta),
          rawMeta: cloneNoteMeta(meta),
          replacedByIndices: [],
          terms: countTerms(tokens),
          headingTerms,
          length: tokens.length,
        });
      }
    }

    resolveSupersessionLinks(chunks);

    const docFreq = new Map<string, number>();
    let totalLength = 0;
    for (const chunk of chunks) {
      totalLength += chunk.length;
      for (const term of chunk.terms.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
    this.chunks = chunks;
    this.docFreq = docFreq;
    this.avgLength = chunks.length > 0 ? totalLength / chunks.length : 0;
    this.logger?.debug(`im-qqbot: 笔记索引重建 files=${files.length} chunks=${chunks.length}`);
  }

  private listFiles(): Array<{ abs: string; rel: string; mtimeMs: number; size: number }> {
    const result: Array<{ abs: string; rel: string; mtimeMs: number; size: number }> = [];
    if (!existsSync(this.root)) return result;

    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_DEPTH || result.length >= MAX_FILES) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (result.length >= MAX_FILES) return;
        if (entry.name.startsWith('.')) continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs, depth + 1);
        } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
          try {
            const info = statSync(abs);
            if (info.size > MAX_FILE_BYTES) continue;
            result.push({ abs, rel: relative(this.root, abs).split('\\').join('/'), mtimeMs: info.mtimeMs, size: info.size });
          } catch {
            /* 文件刚被删掉之类，跳过 */
          }
        }
      }
    };
    walk(this.root, 0);
    return result;
  }
}

function buildTriggerReason(info: {
  rescuedFrom?: IndexedChunk;
  triggeredBy: readonly string[];
  exact?: ExactScore;
  matched: number;
  matchedTerms: readonly string[];
  coverage: number;
  similarity?: number;
}): string | undefined {
  const parts: string[] = [];
  if (info.rescuedFrom !== undefined) {
    parts.push(`替代旧记录《${info.rescuedFrom.file}》`);
  }
  if (info.triggeredBy.length > 0) {
    parts.push(`触发词「${info.triggeredBy.slice(0, 2).join('、')}」`);
  }
  if (info.exact !== undefined && info.exact.matched.length > 0) {
    parts.push(`精确匹配「${info.exact.matched.slice(0, 2).join('、')}」`);
  }
  if (info.matched > 0 && info.matchedTerms.length > 0) {
    parts.push(`关键词「${info.matchedTerms.slice(0, 3).join('、')}」(覆盖 ${Math.round(info.coverage * 100)}%)`);
  }
  if (info.similarity !== undefined) {
    parts.push(`语义相近 ${info.similarity.toFixed(2)}`);
  }
  return parts.length === 0 ? undefined : parts.slice(0, 2).join(' + ');
}

export function isHistoricalQuery(query: string): boolean {
  return HISTORICAL_QUERY_RE.test(query);
}

/** 格式化冲突关系列表为中文提醒 */
export function formatConflictsSummary(conflicts: readonly NoteConflict[] | undefined): string {
  if (!conflicts || conflicts.length === 0) return '';
  const parts = conflicts.slice(0, 2).map((c) => {
    const target = c.heading ? `《${c.file} › ${c.heading}》` : `《${c.file}》`;
    const dateTag = c.date ? `（${c.date}）` : '';
    if (c.relation === 'superseded-by') return `已被${target}${dateTag}替代，请以新记录为准`;
    if (c.relation === 'deprecated-by') return `新记录${target}${dateTag}已标明作废/替代，请以新记录为准`;
    return `同话题有更新记录${target}${dateTag}，不一致处以新证据为准`;
  });
  return parts.join('；');
}

/** 自动注入至少要命中的不同查询词数：「哈哈」「随便」这类只撞上一个词的短消息不注入 */
const INJECT_MIN_MATCHED_TERMS = 2;

function allowsAutoInjection(meta: NoteHit['meta'], allowSuperseded = false): boolean {
  return meta?.inject !== 'search-only' && meta?.budgetChars !== 0
    && (allowSuperseded || meta?.status !== 'superseded');
}

/**
 * 从检索结果里挑出真正要注入的段。
 *
 * 单独拿出来是为了让调用方能拿到「到底注入了哪几段」——账本要记的是注入事实，
 * 而不是检索候选；两件事差一位就会把统计做错。
 */
export function selectNotesForInjection(
  hits: readonly NoteHit[],
  options: { topK: number; minCoverage: number; query?: string },
): NoteHit[] {
  const allowSuperseded = options.query !== undefined && isHistoricalQuery(options.query);
  return hits
    .filter((hit) => {
      if (!allowsAutoInjection(hit.meta, allowSuperseded)) return false;
      return hit.rescuedFromQualifying === true
        || (hit.operationMatches?.length ?? 0) > 0
        || (hit.triggeredBy?.length ?? 0) > 0
        || (hit.exact?.score ?? 0) >= EXACT_STRONG_SCORE
        || hit.similarity !== undefined
        || (hit.coverage >= options.minCoverage
          && hit.matched >= INJECT_MIN_MATCHED_TERMS
          && hit.hasDistinctiveTerm !== false);
    })
    .slice(0, Math.max(0, options.topK));
}

function allocateBudgets(wants: readonly number[], totalBudget: number): number[] {
  const alloc = new Array<number>(wants.length).fill(0);
  let remaining = Math.max(0, totalBudget);
  const pending = new Set(wants.map((_, i) => i));
  while (pending.size > 0) {
    const share = Math.floor(remaining / pending.size);
    let settledAny = false;
    for (const i of [...pending]) {
      if (wants[i]! <= share) {
        alloc[i] = wants[i]!;
        remaining -= wants[i]!;
        pending.delete(i);
        settledAny = true;
      }
    }
    if (!settledAny) {
      const list = [...pending];
      const base = Math.floor(remaining / list.length);
      let extra = remaining % list.length;
      for (const i of list) {
        const give = Math.min(wants[i]!, base + (extra > 0 ? 1 : 0));
        alloc[i] = give;
        if (extra > 0) extra -= 1;
      }
      break;
    }
  }
  return alloc;
}

/**
 * 筛选并按注水式字数预算（water-filling）规划真正要注入的笔记提示块。
 */
export function planNoteInjection(
  hits: readonly NoteHit[],
  options: {
    topK: number;
    maxChars: number;
    perNoteMaxChars?: number;
    minCoverage: number;
    query?: string;
  },
): NoteInjectionPlan {
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  if (maxChars === 0 || options.topK <= 0) {
    return { items: [], text: '', usedChars: 0, maxChars };
  }
  const relevant = selectNotesForInjection(hits, { ...options, topK: hits.length });
  if (relevant.length === 0) {
    return { items: [], text: '', usedChars: 0, maxChars };
  }

  const bounded = (text: string, cap: number): string => text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
  const header = '[共享笔记 · 可能相关]';
  const footer = '（来自笔记库，仅供参考；共享笔记不代表本群经历。新旧冲突以新证据为准，无关则忽略；更多用 qqbot_notes(action="search")。）';
  const prefixFor = (hit: NoteHit): string => {
    const scope = hit.scopeLabel ?? (hit.meta ? describeNoteScope(hit.meta) : '跨会话通用');
    if (hit.section) {
      const conflict = formatConflictsSummary(hit.conflicts);
      const status = hit.meta?.status === 'superseded' ? '，已过期' : '';
      return `- ${hit.heading}（适用:${scope}${status}）\n${conflict ? `  ⚠️ ${conflict}\n` : ''}  `;
    }
    const owner = chatOwnerOf(hit.file);
    const name = owner === undefined ? hit.file : `[本会话] ${hit.file.split('/').slice(2).join('/')}`;
    const meta: string[] = [];
    const provenance: string[] = [];
    if (hit.meta?.status === 'superseded') provenance.push('⚠️已过期');
    if (hit.meta?.date) provenance.push(bounded(hit.meta.date, 12));
    if (hit.meta?.source) provenance.push(bounded(hit.meta.source, 40));
    if (provenance.length) meta.push(provenance.join('·'));
    meta.push(`适用:${bounded(scope, 80)}`);
    if (hit.why) meta.push(`触发:${bounded(hit.why, 100)}`);
    const conflict = bounded(formatConflictsSummary(hit.conflicts), 140);
    return `- ${bounded(name, 100)} › ${bounded(hit.heading, 160)}（${meta.join(' | ')}）\n${conflict ? `  ⚠️ 冲突提醒：${conflict}\n` : ''}  `;
  };
  const render = (items: readonly PlannedNoteItem[]): string =>
    [header, ...items.map(({ hit, snippet }) => `${prefixFor(hit)}${snippet}`), footer].join('\n');

  const selected: Array<{ hit: NoteHit; clean: string; want: number }> = [];
  let remaining = maxChars - header.length - footer.length - 1;
  let legacyMinimum = 0;
  const legacyOnly = relevant.every(hit => !hit.section);
  for (const hit of relevant) {
    const clean = hit.section?.recall ?? hit.text.replace(/\s+/g, ' ').trim();
    const perNoteLimit = options.perNoteMaxChars ?? 0;
    const want = Math.min(clean.length, perNoteLimit > 0 ? perNoteLimit : Infinity, hit.meta?.budgetChars ?? Infinity);
    if (want <= 0 || (hit.section && want < clean.length)) continue;
    const minimum = hit.section ? want : Math.min(40, want);
    const cost = 1 + prefixFor(hit).length + minimum;
    if (cost > remaining) {
      if (legacyOnly) break;
      continue;
    }
    selected.push({ hit, clean, want });
    remaining -= cost;
    if (!hit.section) legacyMinimum += minimum;
    if (selected.length >= options.topK) break;
  }
  const legacy = selected.filter(entry => !entry.hit.section);
  const allocations = allocateBudgets(legacy.map(entry => entry.want), legacyMinimum + remaining);
  let legacyIndex = 0;
  const items = selected.map(({ hit, clean, want }): PlannedNoteItem => {
    const limit = hit.section ? want : allocations[legacyIndex++]!;
    const truncated = clean.length > limit;
    const snippet = truncated && limit > 1 ? `${clean.slice(0, limit - 1)}…` : clean.slice(0, limit);
    return { hit, snippet, truncated };
  });
  const text = items.length ? render(items) : '';
  return { items, text, usedChars: text.length, maxChars };
}

/**
 * 把检索结果格式化成注入到用户消息前的提示块；没有足够相关的结果返回空串。
 */
export function formatNotesHint(
  hits: readonly NoteHit[],
  options: { topK: number; maxChars: number; perNoteMaxChars?: number; minCoverage: number; query?: string },
): string {
  return planNoteInjection(hits, options).text;
}
