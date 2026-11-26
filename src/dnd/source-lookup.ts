/**
 * 受控的模组原书只读检索器（供 `dnd_lookup(kind="source")` 使用）。
 *
 * 设计目标：
 * - 严格限制在当前模组目录内只读访问，拒绝路径穿越与内部编译产物（adventure.json / build / img / sites / _source.json）。
 * - 单次输出硬限 `MAX_SOURCE_CHARS`（默认 3000 字符），彻底避免裸 `grep`/`read` 把 15k–50k 字符原书文本灌爆上下文。
 * - 优先检索中文原书与顶层参考文件（如 `text-zh/`、`译名对照表.md`），仅在中文无命中或显式点名英文文件时回退 `text-en/`。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

export const MAX_SOURCE_CHARS = 3000;

const SKIP_DIRS = new Set(['build', 'img', 'sites', 'node_modules']);
const SKIP_FILES = new Set(['adventure.json', '_source.json']);
const TEXT_EXTS = new Set(['.md', '.txt', '.json']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_DEPTH = 4;

export interface SourceFileEntry {
  /** 相对于模组目录的正斜杠路径 */
  rel: string;
  abs: string;
  ext: string;
  /** 0 = 顶层参考 / text-zh 中文原书，1 = data 结构化数据，2 = text-en 英文原书 / 其他 */
  priority: number;
}

interface MarkdownSection {
  heading: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface LookupSourceOptions {
  /** 目标文件相对路径或文件名关键词；省略时列出目录/索引或全书按 query 检索 */
  id?: string;
  /** 空格分隔的检索关键词或小节名 */
  query?: string;
  /** 1-based 起始行号（翻页续读指定文件时使用） */
  offset?: number;
  /** 单次输出最大字符数（硬上限，默认 3000） */
  maxChars?: number;
}

function classifyPriority(rel: string): number {
  const lower = rel.toLowerCase();
  if (lower.startsWith('text-zh/') || !lower.includes('/')) return 0;
  if (lower.startsWith('data/')) return 1;
  return 2;
}

function isInsideRoot(rootReal: string, targetReal: string): boolean {
  if (targetReal === rootReal) return true;
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
  return targetReal.startsWith(prefix);
}

/** 扫描模组目录下可供 DM 只读查阅的文本/数据文件（过滤图片、构建产物、隐藏文件与越界符号链接） */
export function listSourceFiles(moduleDir: string): SourceFileEntry[] {
  if (!existsSync(moduleDir)) return [];
  let rootReal: string;
  try {
    rootReal = realpathSync(moduleDir);
  } catch {
    return [];
  }
  const files: SourceFileEntry[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (depth === 0 && SKIP_DIRS.has(name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      if (depth === 0 && SKIP_FILES.has(name)) continue;
      const ext = extname(name).toLowerCase();
      if (!TEXT_EXTS.has(ext) || stat.size > MAX_FILE_BYTES) continue;
      const rel = relative(rootReal, resolve(full)).replace(/\\/g, '/');
      if (rel.startsWith('..')) continue;
      files.push({ rel, abs: full, ext, priority: classifyPriority(rel) });
    }
  };
  walk(rootReal, 0);
  files.sort((a, b) => a.priority - b.priority || a.rel.localeCompare(b.rel));
  return files;
}

function clampOutput(text: string, limit: number, tailHint?: string): string {
  if (text.length <= limit) return text;
  const suffix = tailHint ? `\n…（已截断，${tailHint}）` : '\n…（已按 3000 字上限截断）';
  const budget = Math.max(80, limit - suffix.length);
  return `${text.slice(0, budget).trimEnd()}${suffix}`;
}

function splitMarkdownSections(content: string): MarkdownSection[] {
  const lines = content.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  let heading = '（文件开头）';
  let startLine = 1;
  let buf: string[] = [];

  const flush = (endLine: number): void => {
    const text = buf.join('\n').trim();
    if (text.length > 0) sections.push({ heading, startLine, endLine, text });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /^#{1,4}\s+(.+?)\s*$/.exec(line);
    if (match !== null) {
      flush(i);
      heading = match[1]!;
      startLine = i + 1;
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  flush(lines.length);
  return sections;
}

function parseQueryTerms(query: string): string[] {
  return [...new Set(query.trim().split(/[\s,，、|/]+/).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
}

function scoreSection(sec: MarkdownSection, terms: readonly string[]): { score: number; matchedTerms: number } {
  const headingLower = sec.heading.toLowerCase();
  const bodyLower = sec.text.toLowerCase();
  let score = 0;
  let matchedTerms = 0;
  for (const term of terms) {
    const inHeading = headingLower.includes(term);
    const inBody = bodyLower.includes(term);
    if (!inHeading && !inBody) continue;
    matchedTerms += 1;
    score += inHeading ? 12 : 3;
    // 额外奖励重复出现（有上限，防止超长章节占便宜）
    let idx = 0;
    let hits = 0;
    while (hits < 5) {
      const next = bodyLower.indexOf(term, idx);
      if (next < 0) break;
      hits += 1;
      idx = next + term.length;
    }
    score += hits;
  }
  if (matchedTerms === terms.length && terms.length > 1) score += 20;
  return { score, matchedTerms };
}

function resolveSourceFile(moduleDir: string, files: readonly SourceFileEntry[], id: string): SourceFileEntry | undefined {
  const normalized = id.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.length === 0 || normalized.includes('..')) {
    throw new Error(`dnd_lookup source: 非法文件路径「${id}」（不允许跨目录访问）`);
  }
  // 校验绝对/相对路径不逃逸 moduleDir
  let rootReal: string;
  try {
    rootReal = realpathSync(moduleDir);
  } catch {
    return undefined;
  }
  const directCandidate = resolve(rootReal, normalized);
  if (existsSync(directCandidate)) {
    try {
      const real = realpathSync(directCandidate);
      if (!isInsideRoot(rootReal, real)) throw new Error(`dnd_lookup source: 非法文件路径「${id}」（超出当前模组目录）`);
    } catch (err) {
      if (err instanceof Error && err.message.includes('非法文件路径')) throw err;
    }
  }
  const lower = normalized.toLowerCase();
  return files.find((f) => f.rel.toLowerCase() === lower)
    ?? files.find((f) => f.rel.toLowerCase().endsWith(`/${lower}`))
    ?? files.find((f) => f.rel.toLowerCase().includes(lower));
}

function readBoundedLines(content: string, startLine: number, budget: number): { excerpt: string; endLine: number; totalLines: number } {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const start = Math.min(Math.max(1, Math.trunc(startLine)), Math.max(1, totalLines));
  const out: string[] = [];
  let used = 0;
  let endLine = start - 1;
  for (let i = start - 1; i < totalLines; i++) {
    const line = lines[i]!;
    if (used + line.length + 1 > budget && out.length > 0) break;
    out.push(line);
    used += line.length + 1;
    endLine = i + 1;
  }
  return { excerpt: out.join('\n'), endLine, totalLines };
}

function searchJsonLines(entry: SourceFileEntry, content: string, terms: readonly string[], limit: number): string {
  const lines = content.split(/\r?\n/);
  const hits: Array<{ lineNo: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i]!.toLowerCase();
    if (terms.every((t) => lower.includes(t)) || (terms.length > 1 && terms.some((t) => lower.includes(t)))) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 4);
      hits.push({ lineNo: i + 1, text: lines.slice(start, end).join('\n') });
      i = end - 1;
      if (hits.length >= 6) break;
    }
  }
  if (hits.length === 0) return `在 ${entry.rel} 中未找到匹配「${terms.join(' ')}」的内容。`;
  const body = hits.map((h) => `--- ${entry.rel}:L${h.lineNo} ---\n${h.text}`).join('\n');
  return clampOutput(`【模组原书检索 · ${entry.rel}】\n${body}`, limit, `缩小 query 或指定 offset 续读`);
}

function formatDirectoryListing(files: readonly SourceFileEntry[], limit: number): string {
  if (files.length === 0) return '当前模组目录下没有可供只读查阅的原书文本文件。';
  const primary = files.filter((f) => f.priority === 0);
  const data = files.filter((f) => f.priority === 1);
  const secondary = files.filter((f) => f.priority === 2);

  const lines: string[] = [
    '【模组原书索引 · DM 私有】先优先查当前房间/NPC 卡片（dnd_lookup room/npc）；卡片未展开细则时再传 id 或 query 精确检索（单次输出硬限 3000 字）。',
  ];
  if (primary.length > 0) {
    lines.push(`中文原书与参考（${primary.length} 个）：${primary.slice(0, 24).map((f) => f.rel).join('、')}${primary.length > 24 ? '…' : ''}`);
  }
  if (data.length > 0) {
    lines.push(`结构化数据（${data.length} 个）：${data.slice(0, 12).map((f) => f.rel).join('、')}${data.length > 12 ? '…' : ''}`);
  }
  if (secondary.length > 0) {
    lines.push(`其他/英文原书（${secondary.length} 个）：${secondary.slice(0, 16).map((f) => f.rel).join('、')}${secondary.length > 16 ? '…' : ''}`);
  }

  // 若存在 00-索引.md 或 00-目录.md，附带紧凑目录摘要
  const indexFile = files.find((f) => /(?:^|\/)00-(?:索引|目录)\.md$/i.test(f.rel));
  if (indexFile !== undefined) {
    try {
      const content = readFileSync(indexFile.abs, 'utf8');
      const remain = limit - lines.join('\n').length - 120;
      if (remain > 200) {
        const { excerpt } = readBoundedLines(content, 1, remain);
        lines.push(`--- 索引预览（${indexFile.rel}）---\n${excerpt}`);
      }
    } catch {
      /* ignore */
    }
  }
  return clampOutput(lines.join('\n'), limit, '传 id="<文件名>" 或 query="<关键词>" 精确查节');
}

/**
 * 受控读取或检索模组原书目录，严格限制单次返回体积 ≤ maxChars（默认 3000）。
 */
export function lookupModuleSource(moduleDir: string | undefined, options: LookupSourceOptions = {}): string {
  if (moduleDir === undefined) {
    return '当前模组没有独立原书目录，请用 dnd_lookup 的 room / npc / site / quest 查询模组卡片。';
  }
  const limit = Math.min(Math.max(400, Math.trunc(options.maxChars ?? MAX_SOURCE_CHARS)), MAX_SOURCE_CHARS);
  const files = listSourceFiles(moduleDir);
  const id = options.id?.trim();
  const query = options.query?.trim();
  const offset = options.offset;

  // 模式 A：无 id 无 query → 返回文件清单与索引预览
  if (!id && !query) {
    return formatDirectoryListing(files, limit);
  }

  // 模式 B：指定了文件 id
  if (id) {
    const entry = resolveSourceFile(moduleDir, files, id);
    if (entry === undefined) {
      const sample = files.slice(0, 10).map((f) => f.rel).join('、') || '（无）';
      throw new Error(`模组原书目录里找不到「${id}」。可用示例：${sample}`);
    }
    const content = readFileSync(entry.abs, 'utf8');
    if (query) {
      const terms = parseQueryTerms(query);
      if (entry.ext === '.json') return searchJsonLines(entry, content, terms, limit);
      const sections = splitMarkdownSections(content);
      const ranked = sections
        .map((sec) => ({ sec, ...scoreSection(sec, terms) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.matchedTerms - a.matchedTerms || b.score - a.score || a.sec.startLine - b.sec.startLine);
      if (ranked.length === 0) {
        return `在 ${entry.rel} 中未找到匹配「${query}」的章节；可换用更短关键词或省略 query 查看目录与前段。`;
      }
      const header = `【模组原书 · ${entry.rel}｜命中 ${ranked.length} 节】`;
      const parts: string[] = [header];
      let used = header.length;
      const shown: number[] = [];
      for (const item of ranked.slice(0, 3)) {
        const blockHead = `\n--- [${item.sec.heading}] (L${item.sec.startLine}-L${item.sec.endLine}) ---\n`;
        const remain = limit - used - blockHead.length - 120;
        if (remain < 160 && shown.length > 0) break;
        const snippet = item.sec.text.length > Math.max(200, remain)
          ? `${item.sec.text.slice(0, Math.max(200, remain)).trimEnd()}\n…（本节未完，可传 id="${entry.rel}" offset=${item.sec.startLine + 25} 续读）`
          : item.sec.text;
        parts.push(`${blockHead}${snippet}`);
        used += blockHead.length + snippet.length;
        shown.push(item.sec.startLine);
      }
      const others = ranked.slice(shown.length, shown.length + 6);
      if (others.length > 0) {
        parts.push(`\n其他命中：${others.map((o) => `${o.sec.heading}(L${o.sec.startLine})`).join('；')}`);
      }
      return clampOutput(parts.join(''), limit, `传 id="${entry.rel}" offset=<行号> 精读`);
    }

    // 指定文件但未给 query：返回章节提纲（若从头读）+ 受控行片段
    const start = offset ?? 1;
    const outline = start === 1 && entry.ext === '.md'
      ? splitMarkdownSections(content)
        .filter((s) => s.heading !== '（文件开头）')
        .slice(0, 20)
        .map((s) => `${s.heading}(L${s.startLine})`)
        .join('｜')
      : '';
    const prefix = [
      `【模组原书 · ${entry.rel}】`,
      ...(outline ? [`目录节选：${outline}`] : []),
    ].join('\n');
    const budget = Math.max(400, limit - prefix.length - 100);
    const { excerpt, endLine, totalLines } = readBoundedLines(content, start, budget);
    const more = endLine < totalLines ? `\n…（已读至 L${endLine}/${totalLines}，续读传 id="${entry.rel}" offset=${endLine + 1} 或加 query 精查）` : `\n（已到文件末尾，共 ${totalLines} 行）`;
    return clampOutput(`${prefix}\n${excerpt}${more}`, limit);
  }

  // 模式 C：跨文件按 query 精确检索（优先中文原书，中文无命中再查英文/数据）
  const terms = parseQueryTerms(query!);
  if (terms.length === 0) return formatDirectoryListing(files, limit);

  const mdFiles = files.filter((f) => f.ext === '.md' || f.ext === '.txt');
  const primaryFiles = mdFiles.filter((f) => f.priority === 0);
  const fallbackFiles = mdFiles.filter((f) => f.priority > 0);

  const searchPool = (pool: readonly SourceFileEntry[]) => {
    const matches: Array<{ file: SourceFileEntry; sec: MarkdownSection; score: number; matchedTerms: number }> = [];
    for (const file of pool) {
      let content: string;
      try {
        content = readFileSync(file.abs, 'utf8');
      } catch {
        continue;
      }
      for (const sec of splitMarkdownSections(content)) {
        const scored = scoreSection(sec, terms);
        if (scored.score > 0) matches.push({ file, sec, ...scored });
      }
    }
    matches.sort((a, b) => b.matchedTerms - a.matchedTerms || b.score - a.score || a.file.priority - b.file.priority || a.sec.startLine - b.sec.startLine);
    return matches;
  };

  let matches = searchPool(primaryFiles);
  if (matches.length === 0) matches = searchPool(fallbackFiles);
  if (matches.length === 0) {
    return `模组原书中未找到匹配「${query}」的章节；可先查 dnd_lookup(kind="room"|"npc")，或传 dnd_lookup(kind="source") 查看可用文件列表。`;
  }

  const header = `【模组原书检索 · 「${query}」｜命中 ${matches.length} 节（最多展示前 2 节精要）】`;
  const parts: string[] = [header];
  let used = header.length;
  let shownCount = 0;
  for (const item of matches.slice(0, 2)) {
    const blockHead = `\n--- ${item.file.rel} [${item.sec.heading}] (L${item.sec.startLine}-L${item.sec.endLine}) ---\n`;
    const perCap = Math.min(1150, limit - used - blockHead.length - 140);
    if (perCap < 180 && shownCount > 0) break;
    const snippet = item.sec.text.length > perCap
      ? `${item.sec.text.slice(0, perCap).trimEnd()}\n…（精读传 id="${item.file.rel}" offset=${item.sec.startLine}）`
      : item.sec.text;
    parts.push(`${blockHead}${snippet}`);
    used += blockHead.length + snippet.length;
    shownCount += 1;
  }
  const rest = matches.slice(shownCount, shownCount + 6);
  if (rest.length > 0) {
    parts.push(`\n更多命中：${rest.map((m) => `${m.file.rel} · ${m.sec.heading}(L${m.sec.startLine})`).join('；')}`);
  }
  return clampOutput(parts.join(''), limit, '传 id="<文件>" 与 offset 精读指定小节');
}
