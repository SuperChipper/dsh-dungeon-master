/**
 * 共享笔记的元数据、适用范围与新旧关系（纯函数，不依赖宿主）。
 *
 * 支持三种渐进式写法（互相兼容，缺省按通用共享笔记处理）：
 * 1. 目录约定：`chats/<会话>/`、`projects/<项目>/`、`personas/<人设>/`；
 * 2. 文件头 YAML frontmatter（损坏时自动退回正文，绝不丢笔记）；
 * 3. 小节开头 `> 记录于 ... · 来源：... · 范围：...` 元数据引用行。
 */
import { basename, extname } from 'node:path';
import yaml from 'js-yaml';

export type NoteKind = 'general' | 'project' | 'roleplay' | 'chat';
export type NoteScene = 'group' | 'c2c' | 'dnd' | 'local';
export type NoteInjectPolicy = 'auto' | 'search-only';
export type NoteStatus = 'active' | 'superseded';

export interface NoteScopeSpec {
  chatKey?: string;
  projects?: string[];
  personas?: string[];
  scenes?: NoteScene[];
  models?: string[];
}

export interface NoteMeta {
  kind: NoteKind;
  scope: NoteScopeSpec;
  operations?: string[];
  triggers?: string[];
  inject: NoteInjectPolicy;
  budgetChars?: number;
  date?: string;
  source?: string;
  status: NoteStatus;
  supersedes?: string[];
  supersededBy?: string;
}

export interface NoteQueryContext {
  chatKey?: string;
  operations?: readonly string[];
  /** Explicit trusted local access; an unidentified caller is shared-only. */
  trustedLocal?: boolean;
  sharedOnly?: boolean;
  projects?: readonly string[];
  /** 本机/主人私聊/终端白名单会话为 true，允许查询文本显式点名项目时命中对应项目笔记；普通受限水群为 false */
  allowQueryProjectMatch?: boolean;
  personas?: readonly string[];
  scenes?: readonly NoteScene[];
  models?: readonly string[];
  /** 仅主人私聊/本机会话排查时可置 true：跳过 project/persona/scene/model 过滤，但仍遵守非本机 chatKey 隔离 */
  unscoped?: boolean;
}

export interface NoteConflict {
  file: string;
  heading: string;
  date?: string;
  relation: 'superseded-by' | 'deprecated-by' | 'newer-evidence';
}

export interface RawMetaPatch {
  kind?: NoteKind;
  scope?: NoteScopeSpec;
  operations?: string[];
  triggers?: string[];
  inject?: NoteInjectPolicy;
  budgetChars?: number;
  date?: string;
  source?: string;
  status?: NoteStatus;
  supersedes?: string[];
  supersededBy?: string;
}

const CHAT_NOTES_DIR = 'chats';
const PROJECTS_NOTES_DIR = 'projects';
const PERSONAS_NOTES_DIR = 'personas';

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const DATE_RE = /(20\d{2}-\d{2}(?:-\d{2})?)/;
const LEADING_QUOTE_DATE_RE = /^>\s*(20\d{2}-\d{2}(?:-\d{2})?)(?=\D|$)/;
const META_FIELD_BOUNDARY_RE = /[；;]\s*(?=(?:记录于|来源|范围|项目|人设|场景|模型|操作|operations?|触发|预算|注入|状态|替代|已被替代|已被|date|source|scope|project|persona|scene|model|trigger|budget|inject|status|supersedes|supersededBy)\s*[：: ])/iu;

/** 会话键 → 目录名，如 group:ABC → group_ABC */
export function chatNotesDir(chatKey: string): string {
  return chatKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unknown';
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const key = trimmed.normalize('NFKC').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function toStringList(value: unknown, splitComma = true): string[] {
  if (value === undefined || value === null) return [];
  const rawList = Array.isArray(value) ? value : [value];
  const expanded: string[] = [];
  for (const item of rawList) {
    if (item === undefined || item === null) continue;
    const str = String(item).trim();
    if (str === '') continue;
    if (splitComma) {
      for (const part of str.split(/[,，、]/)) {
        const trimmed = part.trim();
        if (trimmed !== '') expanded.push(trimmed);
      }
    } else {
      expanded.push(str);
    }
  }
  return dedupeStrings(expanded);
}

function normalizeScene(raw: string): NoteScene | undefined {
  const v = raw.trim().normalize('NFKC').toLowerCase();
  if (v === 'group' || v === '群' || v === '群聊') return 'group';
  if (v === 'c2c' || v === 'direct' || v === 'private' || v === '私聊') return 'c2c';
  if (v === 'dnd' || v === 'trpg' || v === '跑团') return 'dnd';
  if (v === 'local' || v === '本机' || v === '本地') return 'local';
  return undefined;
}

function toSceneList(value: unknown): NoteScene[] {
  const out: NoteScene[] = [];
  for (const item of toStringList(value)) {
    const scene = normalizeScene(item);
    if (scene !== undefined && !out.includes(scene)) out.push(scene);
  }
  return out;
}

function normalizeDateValue(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const match = DATE_RE.exec(String(value));
    if (match !== null) return match[1];
  }
  return undefined;
}

function normalizeStatus(value: unknown): NoteStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().normalize('NFKC').toLowerCase();
  if (v === 'superseded' || v === 'expired' || v === 'outdated' || v === 'deprecated' || v === '已过期' || v === '已废弃' || v === '过期') {
    return 'superseded';
  }
  if (v === 'active' || v === '有效') return 'active';
  return undefined;
}

function normalizeKind(value: unknown): NoteKind | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().normalize('NFKC').toLowerCase();
  if (v === 'chat' || v === '本会话' || v === '会话') return 'chat';
  if (v === 'project' || v === '项目') return 'project';
  if (v === 'roleplay' || v === 'persona' || v === '角色' || v === '角色演绎' || v === '人设') return 'roleplay';
  if (v === 'general' || v === 'shared' || v === '通用' || v === '共享') return 'general';
  return undefined;
}

function normalizeInject(value: unknown): NoteInjectPolicy | undefined {
  if (value === false) return 'search-only';
  if (value === true) return 'auto';
  if (typeof value !== 'string') return undefined;
  const v = value.trim().normalize('NFKC').toLowerCase();
  if (v === 'search-only' || v === 'search_only' || v === 'search' || v === 'manual' || v === '仅检索' || v === '不自动注入' || v === 'false') {
    return 'search-only';
  }
  if (v === 'auto' || v === '自动' || v === 'true') return 'auto';
  return undefined;
}

function normalizeBudget(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string') {
    const m = /^\s*(\d+)\s*(?:字|chars?)?\s*$/i.exec(value);
    if (m !== null) return Number(m[1]);
  }
  return undefined;
}

function mergeUniqueStrings(base?: readonly string[], next?: readonly string[]): string[] | undefined {
  if (next === undefined || next.length === 0) return base === undefined ? undefined : [...base];
  if (base === undefined || base.length === 0) return [...next];
  return dedupeStrings([...base, ...next]);
}

function mergeScenes(base?: readonly NoteScene[], next?: readonly NoteScene[]): NoteScene[] | undefined {
  if (next === undefined || next.length === 0) return base === undefined ? undefined : [...base];
  if (base === undefined || base.length === 0) return [...next];
  const out = [...base];
  for (const s of next) if (!out.includes(s)) out.push(s);
  return out;
}

export function cloneNoteMeta(meta: NoteMeta): NoteMeta {
  return {
    kind: meta.kind,
    scope: {
      ...(meta.scope.chatKey === undefined ? {} : { chatKey: meta.scope.chatKey }),
      ...(meta.scope.projects === undefined ? {} : { projects: [...meta.scope.projects] }),
      ...(meta.scope.personas === undefined ? {} : { personas: [...meta.scope.personas] }),
      ...(meta.scope.scenes === undefined ? {} : { scenes: [...meta.scope.scenes] }),
      ...(meta.scope.models === undefined ? {} : { models: [...meta.scope.models] }),
    },
    ...(meta.operations === undefined ? {} : { operations: [...meta.operations] }),
    ...(meta.triggers === undefined ? {} : { triggers: [...meta.triggers] }),
    inject: meta.inject,
    ...(meta.budgetChars === undefined ? {} : { budgetChars: meta.budgetChars }),
    ...(meta.date === undefined ? {} : { date: meta.date }),
    ...(meta.source === undefined ? {} : { source: meta.source }),
    status: meta.status,
    ...(meta.supersedes === undefined ? {} : { supersedes: [...meta.supersedes] }),
    ...(meta.supersededBy === undefined ? {} : { supersededBy: meta.supersededBy }),
  };
}

export function resolveKind(scope: NoteScopeSpec, explicit?: NoteKind): NoteKind {
  if (scope.chatKey !== undefined) return 'chat';
  if (scope.projects !== undefined && scope.projects.length > 0) return 'project';
  if ((scope.personas !== undefined && scope.personas.length > 0) || (scope.scenes !== undefined && scope.scenes.length > 0)) {
    return 'roleplay';
  }
  return explicit ?? 'general';
}

export function mergeNoteMeta(base: NoteMeta, patch: RawMetaPatch): NoteMeta {
  const scope: NoteScopeSpec = {
    ...(base.scope.chatKey === undefined ? {} : { chatKey: base.scope.chatKey }),
    ...(base.scope.projects === undefined ? {} : { projects: [...base.scope.projects] }),
    ...(base.scope.personas === undefined ? {} : { personas: [...base.scope.personas] }),
    ...(base.scope.scenes === undefined ? {} : { scenes: [...base.scope.scenes] }),
    ...(base.scope.models === undefined ? {} : { models: [...base.scope.models] }),
  };
  if (patch.scope?.chatKey !== undefined) scope.chatKey = patch.scope.chatKey;
  const projects = mergeUniqueStrings(scope.projects, patch.scope?.projects);
  if (projects !== undefined) scope.projects = projects;
  const personas = mergeUniqueStrings(scope.personas, patch.scope?.personas);
  if (personas !== undefined) scope.personas = personas;
  const scenes = mergeScenes(scope.scenes, patch.scope?.scenes);
  if (scenes !== undefined) scope.scenes = scenes;
  const models = mergeUniqueStrings(scope.models, patch.scope?.models);
  if (models !== undefined) scope.models = models;

  const operations = mergeUniqueStrings(base.operations, patch.operations);
  const triggers = mergeUniqueStrings(base.triggers, patch.triggers);
  const supersedes = mergeUniqueStrings(base.supersedes, patch.supersedes);
  const budgetChars = patch.budgetChars !== undefined ? patch.budgetChars : base.budgetChars;
  let inject = patch.inject ?? base.inject;
  if (budgetChars === 0) inject = 'search-only';

  const merged: NoteMeta = {
    kind: resolveKind(scope, patch.kind ?? base.kind),
    scope,
    ...(operations === undefined ? {} : { operations }),
    ...(triggers === undefined ? {} : { triggers }),
    inject,
    ...(budgetChars === undefined ? {} : { budgetChars }),
    ...(patch.date !== undefined ? { date: patch.date } : base.date !== undefined ? { date: base.date } : {}),
    ...(patch.source !== undefined ? { source: patch.source } : base.source !== undefined ? { source: base.source } : {}),
    status: patch.status ?? base.status,
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(patch.supersededBy !== undefined ? { supersededBy: patch.supersededBy } : base.supersededBy !== undefined ? { supersededBy: base.supersededBy } : {}),
  };
  return merged;
}

/** 根据文件路径推导目录约定元数据 */
export function deriveDirMeta(file: string): NoteMeta {
  const parts = file.split('\\').join('/').replace(/^\.?\//, '').split('/');
  const scope: NoteScopeSpec = {};
  if (parts.length >= 3 && parts[0] === CHAT_NOTES_DIR && parts[1]) {
    scope.chatKey = parts[1];
  } else if (parts.length >= 3 && parts[0] === PROJECTS_NOTES_DIR && parts[1]) {
    scope.projects = [parts[1]];
  } else if (parts.length >= 3 && parts[0] === PERSONAS_NOTES_DIR && parts[1]) {
    scope.personas = [parts[1]];
  }
  return {
    kind: resolveKind(scope),
    scope,
    inject: 'auto',
    status: 'active',
  };
}

function parseFrontmatterObject(head: Record<string, unknown>): RawMetaPatch {
  const patch: RawMetaPatch = {};
  const scope: NoteScopeSpec = {};

  if (typeof head.kind === 'string') {
    const k = normalizeKind(head.kind);
    if (k !== undefined) patch.kind = k;
  }

  if (typeof head.scope === 'string') {
    const k = normalizeKind(head.scope);
    if (k !== undefined && patch.kind === undefined) patch.kind = k;
  } else if (head.scope !== null && typeof head.scope === 'object' && !Array.isArray(head.scope)) {
    const sc = head.scope as Record<string, unknown>;
    if (typeof sc.chatKey === 'string' && sc.chatKey.trim() !== '') scope.chatKey = sc.chatKey.trim();
    const p = toStringList(sc.projects ?? sc.project);
    if (p.length > 0) scope.projects = p;
    const per = toStringList(sc.personas ?? sc.persona);
    if (per.length > 0) scope.personas = per;
    const scn = toSceneList(sc.scenes ?? sc.scene);
    if (scn.length > 0) scope.scenes = scn;
    const mod = toStringList(sc.models ?? sc.model);
    if (mod.length > 0) scope.models = mod;
  }

  const topProjects = toStringList(head.projects ?? head.project);
  if (topProjects.length > 0) scope.projects = mergeUniqueStrings(scope.projects, topProjects);
  const topPersonas = toStringList(head.personas ?? head.persona);
  if (topPersonas.length > 0) scope.personas = mergeUniqueStrings(scope.personas, topPersonas);
  const topScenes = toSceneList(head.scenes ?? head.scene);
  if (topScenes.length > 0) scope.scenes = mergeScenes(scope.scenes, topScenes);
  const topModels = toStringList(head.models ?? head.model);
  if (topModels.length > 0) scope.models = mergeUniqueStrings(scope.models, topModels);
  if (Object.keys(scope).length > 0) patch.scope = scope;

  const operations = toStringList(head.operations ?? head.operation);
  if (operations.length > 0) patch.operations = operations;
  const triggers = toStringList(head.triggers ?? head.trigger);
  if (triggers.length > 0) patch.triggers = triggers;

  const inject = normalizeInject(head.inject);
  if (inject !== undefined) patch.inject = inject;

  const budget = normalizeBudget(head.budget ?? head.budgetChars ?? head.maxInjectChars);
  if (budget !== undefined) {
    patch.budgetChars = budget;
    if (budget === 0) patch.inject = 'search-only';
  }

  const date = normalizeDateValue(head.date ?? head.recordedAt ?? head.updatedAt);
  if (date !== undefined) patch.date = date;

  if (typeof head.source === 'string' && head.source.trim() !== '') patch.source = head.source.trim();

  const status = normalizeStatus(head.status);
  if (status !== undefined) patch.status = status;

  const supersedes = toStringList(head.supersedes, false);
  if (supersedes.length > 0) patch.supersedes = supersedes;

  const supersededByRaw = head.supersededBy ?? head.superseded_by;
  if (typeof supersededByRaw === 'string' && supersededByRaw.trim() !== '') {
    patch.supersededBy = supersededByRaw.trim();
  }

  return patch;
}

/**
 * 抽取文件头 YAML frontmatter。若不存在或语法无效，原样退回正文，绝不抛错。
 */
export function extractFrontmatter(markdown: string): { patch?: RawMetaPatch; body: string } {
  const match = FRONT_MATTER_RE.exec(markdown);
  if (match === null) return { body: markdown };
  try {
    const loaded = yaml.load(match[1]!);
    if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) {
      return { body: markdown };
    }
    return {
      patch: parseFrontmatterObject(loaded as Record<string, unknown>),
      body: match[2]!,
    };
  } catch {
    return { body: markdown };
  }
}

function parseScopeExpression(expr: string): NoteScopeSpec | undefined {
  const scope: NoteScopeSpec = {};
  const entries = expr.split(/[;；]/).map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return undefined;
  let recognized = false;
  for (const entry of entries) {
    const m = /^(projects?|项目|personas?|人设|角色|scenes?|场景|models?|模型|chat|chatKey|会话)\s*[=：:]\s*(.+)$/i.exec(entry);
    if (m === null) return undefined;
    recognized = true;
    const key = m[1]!.toLowerCase();
    const rawVal = m[2]!.trim();
    if (key.startsWith('project') || key === '项目') {
      const vals = toStringList(rawVal);
      if (vals.length > 0) scope.projects = mergeUniqueStrings(scope.projects, vals);
    } else if (key.startsWith('persona') || key === '人设' || key === '角色') {
      const vals = toStringList(rawVal);
      if (vals.length > 0) scope.personas = mergeUniqueStrings(scope.personas, vals);
    } else if (key.startsWith('scene') || key === '场景') {
      const vals = toSceneList(rawVal.split('/'));
      if (vals.length > 0) scope.scenes = mergeScenes(scope.scenes, vals);
    } else if (key.startsWith('model') || key === '模型') {
      const vals = toStringList(rawVal);
      if (vals.length > 0) scope.models = mergeUniqueStrings(scope.models, vals);
    } else if (key === 'chat' || key === 'chatkey' || key === '会话') {
      if (rawVal !== '') scope.chatKey = rawVal;
    }
  }
  return recognized ? scope : undefined;
}

/**
 * 尝试把一条 `> ...` 引用行当作纯元数据行解析；任一片段无法识别则返回 undefined。
 */
export function parseMetaBlockquote(line: string): RawMetaPatch | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('>')) return undefined;
  const inner = trimmed.slice(1).trim();
  if (inner === '') return undefined;

  const dotParts = inner.split(/\s*·\s*/).filter(Boolean);
  const parts: string[] = [];
  for (const dotPart of dotParts) {
    for (const sub of dotPart.split(META_FIELD_BOUNDARY_RE)) {
      const s = sub.trim();
      if (s !== '') parts.push(s);
    }
  }
  if (parts.length === 0) return undefined;

  const patch: RawMetaPatch = {};
  const scope: NoteScopeSpec = {};
  let hasScope = false;

  for (const part of parts) {
    let matched: RegExpExecArray | null;
    if ((matched = /^记录于\s*(20\d{2}-\d{2}(?:-\d{2})?)$/.exec(part)) !== null) {
      patch.date = matched[1]!;
    } else if ((matched = /^date\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      const d = normalizeDateValue(matched[1]!);
      if (d === undefined) return undefined;
      patch.date = d;
    } else if ((matched = /^(?:来源|source)\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      patch.source = matched[1]!.trim();
    } else if ((matched = /^(?:范围|scope)\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      const parsedScope = parseScopeExpression(matched[1]!);
      if (parsedScope !== undefined) {
        hasScope = true;
        if (parsedScope.chatKey !== undefined) scope.chatKey = parsedScope.chatKey;
        if (parsedScope.projects) scope.projects = mergeUniqueStrings(scope.projects, parsedScope.projects);
        if (parsedScope.personas) scope.personas = mergeUniqueStrings(scope.personas, parsedScope.personas);
        if (parsedScope.scenes) scope.scenes = mergeScenes(scope.scenes, parsedScope.scenes);
        if (parsedScope.models) scope.models = mergeUniqueStrings(scope.models, parsedScope.models);
      } else {
        const k = normalizeKind(matched[1]!);
        if (k === undefined) return undefined;
        patch.kind = k;
      }
    } else if ((matched = /^(?:项目|projects?)\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      const vals = toStringList(matched[1]!);
      if (vals.length === 0) return undefined;
      hasScope = true;
      scope.projects = mergeUniqueStrings(scope.projects, vals);
    } else if ((matched = /^(?:人设|角色|personas?)\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      const vals = toStringList(matched[1]!);
      if (vals.length === 0) return undefined;
      hasScope = true;
      scope.personas = mergeUniqueStrings(scope.personas, vals);
    } else if ((matched = /^(?:场景|scenes?)\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      const vals = toSceneList(matched[1]!.split('/'));
      if (vals.length === 0) return undefined;
      hasScope = true;
      scope.scenes = mergeScenes(scope.scenes, vals);
    } else if ((matched = /^(?:模型|models?)\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      const vals = toStringList(matched[1]!);
      if (vals.length === 0) return undefined;
      hasScope = true;
      scope.models = mergeUniqueStrings(scope.models, vals);
    } else if ((matched = /^(?:操作|operations?)\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      const vals = toStringList(matched[1]!);
      if (vals.length === 0) return undefined;
      patch.operations = mergeUniqueStrings(patch.operations, vals);
    } else if ((matched = /^(?:触发|triggers?)\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      const vals = toStringList(matched[1]!);
      if (vals.length === 0) return undefined;
      patch.triggers = mergeUniqueStrings(patch.triggers, vals);
    } else if ((matched = /^(?:预算|budget|budgetChars)\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      const b = normalizeBudget(matched[1]!);
      if (b === undefined) return undefined;
      patch.budgetChars = b;
      if (b === 0) patch.inject = 'search-only';
    } else if ((matched = /^(?:注入|inject)\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      const inj = normalizeInject(matched[1]!);
      if (inj === undefined) return undefined;
      patch.inject = inj;
    } else if ((matched = /^(?:状态|status)\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      const st = normalizeStatus(matched[1]!);
      if (st === undefined) return undefined;
      patch.status = st;
    } else if ((matched = /^(?:替代|supersedes)\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      const vals = toStringList(matched[1]!, true);
      if (vals.length === 0) return undefined;
      patch.supersedes = mergeUniqueStrings(patch.supersedes, vals);
    } else if ((matched = /^(?:已被替代|supersededBy)\s*[：:]\s*(.+)$/i.exec(part)) !== null) {
      const target = matched[1]!.trim();
      if (target === '') return undefined;
      patch.supersededBy = target;
    } else if ((matched = /^已被\s*(.+?)\s*替代$/i.exec(part)) !== null) {
      const target = matched[1]!.trim();
      if (target === '') return undefined;
      patch.supersededBy = target;
    } else {
      return undefined;
    }
  }

  if (hasScope) patch.scope = scope;
  return patch;
}

/**
 * 解析小节级元数据并剥离纯元数据引用行（仅当剥离后仍有非空正文时剥离，避免单行笔记变空段）。
 */
export function parseSectionMeta(
  rawLines: readonly string[],
  parentMeta: NoteMeta,
  file: string,
  heading: string,
): { meta: NoteMeta; bodyLines: string[] } {
  const firstNonEmptyIdx = rawLines.findIndex((line) => line.trim() !== '');
  let bodyLines = [...rawLines];
  let sectionPatch: RawMetaPatch | undefined;
  let quoteDate: string | undefined;

  if (firstNonEmptyIdx >= 0) {
    const firstLine = rawLines[firstNonEmptyIdx]!;
    const parsed = parseMetaBlockquote(firstLine);
    if (parsed !== undefined) {
      sectionPatch = parsed;
      const hasOtherBody = rawLines.some((line, idx) => idx !== firstNonEmptyIdx && line.trim() !== '');
      if (hasOtherBody) {
        bodyLines = rawLines.filter((_, idx) => idx !== firstNonEmptyIdx);
      }
    } else {
      const lead = LEADING_QUOTE_DATE_RE.exec(firstLine.trim());
      if (lead !== null) quoteDate = lead[1];
    }
  }

  let meta = sectionPatch === undefined ? cloneNoteMeta(parentMeta) : mergeNoteMeta(parentMeta, sectionPatch);

  if (sectionPatch?.date === undefined) {
    const leafHeading = heading.split(' › ').at(-1) ?? heading;
    const headingMatch = DATE_RE.exec(leafHeading);
    const fileMatch = DATE_RE.exec(basename(file, extname(file)));
    if (quoteDate !== undefined) meta = { ...meta, date: quoteDate };
    else if (headingMatch !== null) meta = { ...meta, date: headingMatch[1]! };
    else if (meta.date === undefined && fileMatch !== null) meta = { ...meta, date: fileMatch[1]! };
  }

  return { meta, bodyLines };
}

/**
 * 把元数据格式化为 `> ...` 引用行。
 * 当只有 date 和可选 source 时，精确输出 `> 记录于 YYYY-MM-DD · 来源：...` 以保持向后兼容。
 */
export function formatMetaBlockquote(meta: Partial<NoteMeta>, fallbackDate?: string): string {
  const date = meta.date ?? fallbackDate;
  const parts: string[] = [];
  if (date !== undefined && date !== '') parts.push(`记录于 ${date}`);
  if (meta.source !== undefined && meta.source !== '') parts.push(`来源：${meta.source}`);

  const scopeParts: string[] = [];
  if (meta.scope?.projects?.length) scopeParts.push(`project=${meta.scope.projects.join(',')}`);
  if (meta.scope?.personas?.length) scopeParts.push(`persona=${meta.scope.personas.join(',')}`);
  if (meta.scope?.scenes?.length) scopeParts.push(`scene=${meta.scope.scenes.join(',')}`);
  if (meta.scope?.models?.length) scopeParts.push(`model=${meta.scope.models.join(',')}`);
  if (scopeParts.length > 0) parts.push(`范围：${scopeParts.join('; ')}`);

  if (meta.operations?.length) parts.push(`操作：${meta.operations.join(', ')}`);
  if (meta.triggers?.length) parts.push(`触发：${meta.triggers.join(', ')}`);
  if (meta.inject === 'search-only') parts.push('注入：仅检索');
  if (meta.budgetChars !== undefined && meta.budgetChars > 0) parts.push(`预算：${meta.budgetChars}字`);
  if (meta.status === 'superseded') parts.push('状态：已过期');
  if (meta.supersedes?.length) parts.push(`替代：${meta.supersedes.join(', ')}`);
  if (meta.supersededBy !== undefined && meta.supersededBy !== '') parts.push(`已被替代：${meta.supersededBy}`);

  return parts.length === 0 ? '' : `> ${parts.join(' · ')}`;
}

/**
 * 原地更新一条元数据引用行（保留原有的日期、来源、范围等字段）。
 */
export function upsertMetaInBlockquote(
  existingLine: string | undefined,
  patch: RawMetaPatch,
  fallbackDate?: string,
): string {
  const existing = existingLine === undefined ? undefined : parseMetaBlockquote(existingLine);
  const base: NoteMeta = {
    kind: 'general',
    scope: {},
    inject: 'auto',
    status: 'active',
    ...(fallbackDate === undefined ? {} : { date: fallbackDate }),
  };
  const withExisting = existing === undefined ? base : mergeNoteMeta(base, existing);
  const updated = mergeNoteMeta(withExisting, patch);
  return formatMetaBlockquote(updated, fallbackDate);
}

/**
 * 从会话工作目录（sessionCwd）相对于总工作区根目录（workspaceRoot）推导出所属项目名列表。
 * 若 sessionCwd 就是伞状根目录本身，返回空数组，避免把父目录误判为子项目。
 */
export function deriveProjectsFromCwd(sessionCwd: string | undefined, workspaceRoot: string | undefined): string[] {
  if (!sessionCwd || sessionCwd.trim() === '') return [];
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const cwdNorm = norm(sessionCwd);
  const rootNorm = workspaceRoot ? norm(workspaceRoot) : '';

  const isWindows = /^[A-Za-z]:/.test(cwdNorm) || /^[A-Za-z]:/.test(rootNorm);
  const eq = (a: string, b: string): boolean => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const startsWithPath = (target: string, prefix: string): boolean => {
    const a = isWindows ? target.toLowerCase() : target;
    const b = isWindows ? prefix.toLowerCase() : prefix;
    return a.startsWith(`${b}/`);
  };

  if (rootNorm !== '') {
    if (eq(cwdNorm, rootNorm)) return [];
    if (startsWithPath(cwdNorm, rootNorm)) {
      const rel = cwdNorm.slice(rootNorm.length + 1);
      const segs = rel.split('/').filter(Boolean);
      if (segs.length === 0) return [];
      if (segs[0]!.toLowerCase() === 'state' && segs[1] !== undefined) {
        return dedupeStrings([segs[1], `${segs[0]}/${segs[1]}`]);
      }
      return [segs[0]!];
    }
  }
  const base = basename(cwdNorm);
  return base !== '' ? [base] : [];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 判断查询文本里是否明确点名了某个项目名 */
export function queryMentionsProject(query: string, projects: readonly string[]): boolean {
  if (query.trim() === '' || projects.length === 0) return false;
  const q = query.normalize('NFKC').toLowerCase();
  for (const proj of projects) {
    const p = proj.normalize('NFKC').trim().toLowerCase();
    if (p === '') continue;
    if (/^[a-z0-9_.-]+$/i.test(p)) {
      const re = new RegExp(`(?<![a-z0-9_-])${escapeRegExp(p)}(?![a-z0-9_-])`, 'i');
      if (re.test(q)) return true;
    } else if (q.includes(p)) {
      return true;
    }
  }
  return false;
}

function hasIntersectionIgnoreCase(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a || a.length === 0 || !b || b.length === 0) return false;
  const setB = new Set(b.map((s) => s.normalize('NFKC').trim().toLowerCase()).filter(Boolean));
  return a.some((item) => setB.has(item.normalize('NFKC').trim().toLowerCase()));
}

/** 判断某条笔记在当前上下文和查询下是否满足适用范围 */
export function matchesNoteScope(meta: NoteMeta, context: NoteQueryContext = {}, query = ''): boolean {
  if (meta.scope.chatKey !== undefined) {
    if (context.sharedOnly === true || (context.chatKey === undefined && context.trustedLocal !== true)) return false;
    if (context.chatKey !== undefined && chatNotesDir(context.chatKey) !== meta.scope.chatKey) return false;
  }

  if (context.unscoped === true) return true;

  if (meta.scope.projects !== undefined && meta.scope.projects.length > 0) {
    const byContext = hasIntersectionIgnoreCase(meta.scope.projects, context.projects);
    const byQuery = context.allowQueryProjectMatch === true && queryMentionsProject(query, meta.scope.projects);
    if (!byContext && !byQuery) return false;
  }

  if (meta.scope.personas !== undefined && meta.scope.personas.length > 0) {
    if (!hasIntersectionIgnoreCase(meta.scope.personas, context.personas)) return false;
  }

  if (meta.scope.scenes !== undefined && meta.scope.scenes.length > 0) {
    if (context.scenes === undefined || context.scenes.length === 0) return false;
    if (!meta.scope.scenes.some((s) => context.scenes!.includes(s))) return false;
  }

  if (meta.scope.models !== undefined && meta.scope.models.length > 0 && context.models !== undefined && context.models.length > 0) {
    const ctxModels = context.models.map((m) => m.normalize('NFKC').trim().toLowerCase()).filter(Boolean);
    const matchedModel = meta.scope.models.some((req) => {
      const r = req.normalize('NFKC').trim().toLowerCase();
      return r !== '' && ctxModels.some((cm) => cm === r || cm.includes(r) || r.includes(cm));
    });
    if (!matchedModel) return false;
  }

  return true;
}

const SCENE_LABELS: Record<NoteScene, string> = {
  group: '群聊',
  c2c: '私聊',
  dnd: '跑团',
  local: '本机',
};

/** 生成简明中文适用范围标签 */
export function describeNoteScope(meta: NoteMeta): string {
  const parts: string[] = [];
  if (meta.scope.chatKey !== undefined) parts.push('仅本会话');
  if (meta.scope.projects?.length) parts.push(`项目:${meta.scope.projects.join('/')}`);
  if (meta.scope.personas?.length) parts.push(`人设:${meta.scope.personas.join('/')}`);
  if (meta.scope.scenes?.length) parts.push(`场景:${meta.scope.scenes.map((s) => SCENE_LABELS[s]).join('/')}`);
  if (meta.scope.models?.length) parts.push(`模型:${meta.scope.models.join('/')}`);
  return parts.length === 0 ? '跨会话通用' : parts.join(' · ');
}

function sortableDate(date: string): string {
  return /^\d{4}-\d{2}$/.test(date) ? `${date}-00` : date;
}

/** 比较两个笔记日期；任一方缺失返回 0 */
export function compareNoteDates(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const sa = sortableDate(a);
  const sb = sortableDate(b);
  if (sa === sb) return 0;
  return sa > sb ? 1 : -1;
}
