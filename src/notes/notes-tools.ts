/**
 * qqbot_notes_search / qqbot_notes_save / qqbot_notes_manage — 共享笔记库的检索、记录与治理工具。
 *
 * 笔记库支持适用范围（通用 / 项目 / 人设 / 场景 / 会话私有）、显式触发词、注入预算与新旧替代关系：
 * - scope="chat"（`chats/<会话>/`）的笔记只属于当前群/私聊，别的会话检索不到；
 * - 带 projects / personas / scenes 的笔记只在匹配的上下文里召回，避免项目条件或角色设定串台。
 */
import { dirname } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { DshAgent, SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import {
  chatKeyOf,
  formatConflictsSummary,
  type NoteInjectPolicy,
  type NoteQueryContext,
  type NoteScene,
  type NotesStore,
  type SaveNoteResult,
} from './notes-store.ts';
import { deriveProjectsFromCwd } from './note-metadata.ts';
import { findDmSecret } from '../features/campaign-secrets.ts';
import { NOTE_STATS_VIEWS, type NoteStatsView } from '../features/note-stats.ts';

export const NOTES_SEARCH_TOOL_NAME = 'qqbot_notes_search';
export const NOTES_SAVE_TOOL_NAME = 'qqbot_notes_save';
export const NOTES_MANAGE_TOOL_NAME = 'qqbot_notes_manage';

/** 检索结果里每段正文的最大字数 */
const SEARCH_SNIPPET_CHARS = 800;

const SEARCH_DESCRIPTION =
  'Search the shared notes library with scope awareness (general, project, persona/scene, and chat-private notes). '
  + 'Returns matching sections along with why each hit matched, its applicable scope, date/source provenance, and any '
  + 'conflicts with newer notes. Use optional `project` / `persona` filters when looking up a specific project or character; '
  + '`all_scopes=true` inspects across project/persona scopes in owner private chat or local sessions.';

const SAVE_DESCRIPTION =
  'Save distilled long-term knowledge into the shared notes library with explicit scope and lifecycle metadata. '
  + 'General engineering lessons and writing preferences leave `projects`/`personas` empty so they work everywhere. '
  + 'Project-specific experiment conditions or code conventions must set `projects`; roleplay settings must set `personas` '
  + 'and/or `scenes`; chat-only affairs (TRPG campaigns, this group\'s plans/facts) set scope="chat". '
  + 'Use `triggers` for explicit keywords, `inject="search-only"` or `budget_chars` to control auto-injection budget, '
  + 'and `supersedes` to link old notes replaced by this new conclusion. Never save private secrets or DM-only stats.';

const MANAGE_DESCRIPTION =
  'Owner-only housekeeping for the shared notes library; works only in a private chat with the owner or local sessions. '
  + 'action="stats": show injection ledger and relevance scores (view="low"|"top"|"muted"). '
  + 'action="mute" / "unmute": stop or resume auto-injecting a section (remains searchable). '
  + 'action="supersede": mark an outdated note/section as superseded in place while preserving its date, source and text. '
  + 'action="archive": move a file or section into .archive/ (not indexed, nothing is deleted).';

interface ManageArgs {
  action: 'stats' | 'mute' | 'unmute' | 'archive' | 'supersede';
  view?: NoteStatsView;
  limit?: number;
  file?: string;
  heading?: string;
  occurrence?: number;
  superseded_by?: string;
}

export interface NotesToolsOptions {
  /** bot 主人的 openid；空 = 管理工具只有本机会话能用 */
  ownerOpenid?: string;
}

/** 看起来像跑团存档/约定的内容：没指定 scope 时默认只记到本会话，免得串到别的群 */
const CAMPAIGN_NOTE_PATTERN = /跑团|开团|结团|带团|模组|\/dnd|\bDM\b|\bKP\b|先攻|检定|角色卡|法术位|环位|\bHP\b/;

export function looksLikeCampaignNote(title: string, content: string): boolean {
  return CAMPAIGN_NOTE_PATTERN.test(`${title}\n${content}`);
}

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface SearchArgs {
  query: string;
  limit?: number;
  project?: string;
  persona?: string;
  all_scopes?: boolean;
}

interface SaveArgs {
  title: string;
  content: string;
  file?: string;
  scope?: 'shared' | 'chat';
  projects?: string[];
  personas?: string[];
  scenes?: NoteScene[];
  operations?: string[];
  triggers?: string[];
  inject?: NoteInjectPolicy;
  budget_chars?: number;
  supersedes?: string[];
}

interface SearchOutputHit {
  file: string;
  heading: string;
  text: string;
  score: number;
  exact?: string[];
  similarity?: number;
  scope?: string;
  why?: string;
  date?: string;
  source?: string;
  status?: 'active' | 'superseded';
  conflicts?: string[];
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function renderHits(query: string, hits: readonly SearchOutputHit[]): string {
  if (hits.length === 0) return `笔记库里没有和「${query}」相关的内容。`;
  return hits.map((hit, i) => {
    const text = hit.text.length > SEARCH_SNIPPET_CHARS ? `${hit.text.slice(0, SEARCH_SNIPPET_CHARS)}…` : hit.text;
    const prov: string[] = [];
    if (hit.status === 'superseded') prov.push('⚠️已过期');
    if (hit.date) prov.push(hit.date);
    if (hit.source) prov.push(hit.source);
    const metaParts: string[] = [];
    if (prov.length > 0) metaParts.push(prov.join('·'));
    if (hit.scope) metaParts.push(`适用:${hit.scope}`);
    if (hit.why) metaParts.push(`触发:${hit.why}`);

    const lines = [`#${i + 1} ${hit.file} › ${hit.heading}`];
    if (metaParts.length > 0) lines.push(`[${metaParts.join(' | ')}]`);
    if (hit.conflicts !== undefined && hit.conflicts.length > 0) {
      lines.push(`⚠️ 冲突提醒：${hit.conflicts.join('；')}`);
    }
    lines.push(text);
    return lines.join('\n');
  }).join('\n\n');
}

export function registerNotesTools(
  ctx: Context,
  store: NotesStore,
  manager: SessionManager,
  logger: Logger,
  options: NotesToolsOptions = {},
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，笔记工具未注册');
    return;
  }

  tools.register({
    name: NOTES_SEARCH_TOOL_NAME,
    description: SEARCH_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, e.g. "大肥鱼小课堂 第四集" or "voice-lab 破音".' },
        limit: { type: 'integer', description: 'Max sections to return (1-8, default 4).' },
        project: { type: 'string', description: 'Optional project name filter, e.g. "voice-lab" or "dsh-qqbot".' },
        persona: { type: 'string', description: 'Optional persona name/id filter, e.g. "哈基米" or "大肥鱼".' },
        all_scopes: { type: 'boolean', description: 'Owner private chat / local session only: search across project/persona/scene scopes.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                heading: { type: 'string' },
                text: { type: 'string' },
                score: { type: 'number' },
                exact: { type: 'array', items: { type: 'string' } },
                similarity: { type: 'number' },
                scope: { type: 'string' },
                why: { type: 'string' },
                date: { type: 'string' },
                source: { type: 'string' },
                status: { type: 'string', enum: ['active', 'superseded'] },
                conflicts: { type: 'array', items: { type: 'string' } },
              },
              required: ['file', 'heading', 'text', 'score'],
              additionalProperties: false,
            },
          },
        },
        required: ['query', 'hits'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { query: string; hits: SearchOutputHit[] };
        return [{ type: 'text', text: renderHits(v.query, v.hits) }];
      },
    },
    async execute(args: unknown, exec: { agent?: unknown }): Promise<Record<string, unknown>> {
      const { query, limit, project, persona, all_scopes } = args as SearchArgs;
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('qqbot_notes_search: `query` 不能为空');
      }
      const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(8, Math.max(1, Math.floor(limit))) : 4;
      const agent = exec.agent as DshAgent | undefined;
      const record = agent !== undefined ? manager.findByAgent(agent) : undefined;
      const owner = options.ownerOpenid?.trim() ?? '';
      const ownerOrLocal = record === undefined || (owner !== '' && record.scope === 'c2c' && record.peerId === owner);

      let queryCtx: Omit<NoteQueryContext, 'chatKey'>;
      let chatKey: string | undefined;
      if (record !== undefined && typeof manager.buildNoteQueryContext === 'function') {
        const built = manager.buildNoteQueryContext(record.scope, record.peerId, { record, agent });
        chatKey = built.chatKey;
        const { chatKey: _c, ...rest } = built;
        queryCtx = rest;
      } else if (record !== undefined) {
        chatKey = chatKeyOf(record.scope, record.peerId);
        const projects = deriveProjectsFromCwd(agent?.session?.header?.cwd, dirname(store.root));
        queryCtx = {
          scenes: [record.scope],
          ...(projects.length > 0 ? { projects } : {}),
          allowQueryProjectMatch: ownerOrLocal,
        };
      } else {
        chatKey = undefined;
        const projects = deriveProjectsFromCwd(agent?.session?.header?.cwd, dirname(store.root));
        queryCtx = {
          scenes: ['local'],
          ...(projects.length > 0 ? { projects } : {}),
          allowQueryProjectMatch: true,
        };
      }

      if (ownerOrLocal && typeof project === 'string' && project.trim() !== '') {
        queryCtx = { ...queryCtx, projects: [project.trim()] };
      }
      if (ownerOrLocal && typeof persona === 'string' && persona.trim() !== '') {
        queryCtx = { ...queryCtx, personas: [persona.trim()] };
      }
      if (all_scopes === true && ownerOrLocal) {
        queryCtx = { ...queryCtx, unscoped: true };
      }

      if (record === undefined) queryCtx = { ...queryCtx, sharedOnly: true };
      const rawHits = await store.searchHybrid(query, n, chatKey, queryCtx);
      const hits: SearchOutputHit[] = rawHits.map((hit) => {
        const conflictStrings = hit.conflicts?.map((c) => formatConflictsSummary([c])).filter(Boolean);
        return {
          file: hit.file,
          heading: hit.heading,
          text: hit.text,
          score: Math.round(hit.score * 100) / 100,
          ...(hit.exact === undefined ? {} : { exact: hit.exact.matched }),
          ...(hit.similarity === undefined ? {} : { similarity: Math.round(hit.similarity * 100) / 100 }),
          ...(hit.scopeLabel === undefined ? {} : { scope: hit.scopeLabel }),
          ...(hit.why === undefined ? {} : { why: hit.why }),
          ...(hit.meta?.date === undefined ? {} : { date: hit.meta.date }),
          ...(hit.meta?.source === undefined ? {} : { source: hit.meta.source }),
          ...(hit.meta?.status === undefined ? {} : { status: hit.meta.status }),
          ...(conflictStrings === undefined || conflictStrings.length === 0 ? {} : { conflicts: conflictStrings }),
        };
      });
      return { query, hits };
    },
  });

  tools.register({
    name: NOTES_SAVE_TOOL_NAME,
    description: SAVE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title of the note or section.' },
        content: { type: 'string', description: 'Markdown body. Keep it distilled; lists are fine.' },
        file: { type: 'string', description: 'Optional existing note file name to append to (e.g. 大肥鱼小课堂-课堂笔记.md).' },
        scope: {
          type: 'string',
          enum: ['shared', 'chat'],
          description: '"shared" = cross-chat eligible (subject to projects/personas/scenes); "chat" = only this group/private chat.',
        },
        projects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict this note to specific project(s) (e.g. ["voice-lab"], ["dsh-qqbot"]). Omit for general lessons.',
        },
        personas: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict roleplay/character notes to specific persona(s) (e.g. ["哈基米"], ["大肥鱼"]).',
        },
        scenes: {
          type: 'array',
          items: { type: 'string', enum: ['group', 'c2c', 'dnd', 'local'] },
          description: 'Restrict to specific scene(s): group, c2c, dnd, local.',
        },
        operations: { type: 'array', items: { type: 'string' }, description: 'Optional operation tags, e.g. ["notes.search"]. Adds a recall route without restricting ordinary recall.' },
        triggers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit trigger words/phrases that should activate this note reliably.',
        },
        inject: {
          type: 'string',
          enum: ['auto', 'search-only'],
          description: '"auto" (default) = eligible for prompt injection; "search-only" = only retrieved by explicit search.',
        },
        budget_chars: {
          type: 'integer',
          description: 'Optional max characters allocated to this note when auto-injected (60-2000).',
        },
        supersedes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Older note file(s) or "file.md › heading" sections replaced by this new conclusion.',
        },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          created: { type: 'boolean' },
          chars: { type: 'integer' },
          message: { type: 'string' },
        },
        required: ['file', 'created', 'chars', 'message'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => [
        { type: 'text', text: (value as SaveNoteResult).message },
      ],
    },
    async execute(args: unknown, exec: { agent?: unknown }): Promise<SaveNoteResult> {
      const { title, content, file, scope, projects, personas, scenes, operations, triggers, inject, budget_chars, supersedes } = args as SaveArgs;
      if (typeof title !== 'string' || typeof content !== 'string') {
        throw new Error('qqbot_notes_save: `title` 和 `content` 必须是字符串');
      }
      let budgetChars: number | undefined;
      if (budget_chars !== undefined) {
        if (typeof budget_chars !== 'number' || !Number.isFinite(budget_chars) || budget_chars < 60 || budget_chars > 2000) {
          throw new Error('qqbot_notes_save: `budget_chars` 必须是 60-2000 的整数（仅检索请传 inject="search-only"）');
        }
        budgetChars = Math.floor(budget_chars);
      }

      const record = exec.agent !== undefined ? manager.findByAgent(exec.agent as DshAgent) : undefined;
      const source = record === undefined ? '本机会话' : (record.scope === 'group' ? '群聊' : '私聊');
      // 本会话开着团时，笔记会在之后的消息里被自动检索出来，DM 机密一旦写进去就可能被念给玩家
      const campaign = record === undefined ? undefined : manager.dndService?.active(record.sessionKey)?.campaign;
      if (campaign !== undefined) {
        const monsters = campaign.characters.filter((ch) => ch.kind === 'monster').map((ch) => ch.name);
        // 「刻德温 Kodwin」在笔记里常只写中文名或英文名，拆开分别匹配
        const pcs = campaign.characters.filter((ch) => ch.kind === 'pc').flatMap((ch) => ch.name.split(/\s+/));
        const secret = findDmSecret(`${title}\n${content}`, monsters, pcs);
        if (secret !== undefined) {
          throw new Error(`qqbot_notes_save: 跑团进行中，笔记${secret}。DM 机密（DC、怪物数值、DM 笔记）不写进笔记，去掉后再记；跑团进度用 dnd_progress 写进团档。`);
        }
      }
      // 本机会话没有「本会话」可言，一律记到共享区
      const chatOnly = record !== undefined
        && (scope === 'chat' || (scope === undefined && looksLikeCampaignNote(title, content)));

      const cleanProjects = cleanStringArray(projects);
      const cleanPersonas = cleanStringArray(personas);
      const cleanScenes = Array.isArray(scenes)
        ? scenes.filter((s): s is NoteScene => s === 'group' || s === 'c2c' || s === 'dnd' || s === 'local')
        : undefined;
      const cleanTriggers = cleanStringArray(triggers);
      const cleanSupersedes = cleanStringArray(supersedes);

      return store.save({
        title,
        content,
        source,
        ...(chatOnly ? { chatKey: chatKeyOf(record.scope, record.peerId) } : {}),
        ...(typeof file === 'string' && file.trim().length > 0 ? { file } : {}),
        ...(cleanProjects === undefined ? {} : { projects: cleanProjects }),
        ...(cleanPersonas === undefined ? {} : { personas: cleanPersonas }),
        ...(cleanScenes === undefined || cleanScenes.length === 0 ? {} : { scenes: cleanScenes }),
        ...(cleanStringArray(operations) === undefined ? {} : { operations: cleanStringArray(operations) }),
        ...(cleanTriggers === undefined ? {} : { triggers: cleanTriggers }),
        ...(inject === 'auto' || inject === 'search-only' ? { inject } : {}),
        ...(budgetChars === undefined ? {} : { budgetChars }),
        ...(cleanSupersedes === undefined ? {} : { supersedes: cleanSupersedes }),
      });
    },
  });

  tools.register({
    name: NOTES_MANAGE_TOOL_NAME,
    description: MANAGE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['stats', 'mute', 'unmute', 'archive', 'supersede'], description: 'What to do.' },
        view: { type: 'string', enum: ['low', 'top', 'muted'], description: 'stats only: low = lowest relevance among sections currently eligible for auto-injection (default), top = most injected historically, muted = recorded mutes.' },
        limit: { type: 'integer', description: 'stats only: how many rows (1-30, default 10).' },
        file: { type: 'string', description: 'mute/unmute/archive/supersede: note path relative to the notes root, exactly as shown by stats or search.' },
        heading: { type: 'string', description: 'mute/unmute: full heading path ("一级 › 二级"). archive/supersede: target section; omit for whole file / first section.' },
        occurrence: { type: 'integer', description: 'archive/supersede only: which one (1-based) when several sections share the same heading path.' },
        superseded_by: { type: 'string', description: 'supersede only: the newer note file or "file.md › heading" replacing this note.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: (value as { message: string }).message }],
    },
    async execute(args: unknown, exec: { agent?: unknown }): Promise<{ message: string }> {
      const { action, view, limit, file, heading, occurrence, superseded_by } = args as ManageArgs;
      const record = exec.agent !== undefined ? manager.findByAgent(exec.agent as DshAgent) : undefined;
      // 清单里有每个群的私有笔记标题，静音和归档又会影响所有会话：只给主人私聊和本机会话
      const owner = options.ownerOpenid?.trim() ?? '';
      const ownerChat = record === undefined || (owner !== '' && record.scope === 'c2c' && record.peerId === owner);
      if (!ownerChat) throw new Error('qqbot_notes_manage: 只能在主人私聊里用');
      if (action === 'stats') {
        const picked: NoteStatsView = view !== undefined && NOTE_STATS_VIEWS.includes(view) ? view : 'low';
        const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(30, Math.max(1, Math.floor(limit))) : 10;
        const message = manager.noteStats(picked, n);
        if (message === undefined) throw new Error('qqbot_notes_manage: 笔记账本不可用');
        return { message };
      }
      const metrics = manager.noteMetrics;
      if (metrics === undefined) throw new Error('qqbot_notes_manage: 笔记账本不可用');
      if (typeof file !== 'string' || file.trim() === '') throw new Error(`qqbot_notes_manage: ${action} 需要 file`);
      const path = file.trim().split('\\').join('/');
      const section = typeof heading === 'string' ? heading.trim() : '';

      if (action === 'supersede') {
        if (typeof superseded_by !== 'string' || superseded_by.trim() === '') {
          throw new Error('qqbot_notes_manage: supersede 需要 superseded_by（新结论所在的文件或小节）');
        }
        const result = store.supersede({
          file: path,
          ...(section !== '' ? { heading: section } : {}),
          ...(typeof occurrence === 'number' && Number.isFinite(occurrence) ? { occurrence: Math.floor(occurrence) } : {}),
          supersededBy: superseded_by.trim(),
        });
        return { message: result.message };
      }

      if (action === 'archive') {
        const result = store.archive({
          file: path,
          ...(section !== '' ? { heading: section } : {}),
          ...(typeof occurrence === 'number' && Number.isFinite(occurrence) ? { occurrence: Math.floor(occurrence) } : {}),
        });
        return { message: `${result.message}要恢复就把它从归档目录搬回原处。` };
      }
      if (action === 'mute' || action === 'unmute') {
        if (section === '') throw new Error(`qqbot_notes_manage: ${action} 需要 heading（完整标题路径，stats 里「›」后面那一串）`);
        if (action === 'unmute') {
          if (metrics.mutedAt(path, section) === undefined) return { message: `${path} › ${section} 本来就没有静音。` };
          metrics.unmute(path, section);
          return { message: `已恢复自动注入：${path} › ${section}（之前的相关性分数已清零，重新累计）。` };
        }
        // 标题路径写错的话静音会落到一个不存在的键上，什么也不会发生还以为生效了
        if (!store.hasSection(path, section)) throw new Error(`qqbot_notes_manage: 笔记库里没有 ${path} › ${section}，先用 stats 或 qqbot_notes_search 确认路径`);
        metrics.mute(path, section);
        return { message: `已静音：${path} › ${section}。之后不再自动注入，qqbot_notes_search 仍然查得到；要恢复用 unmute。` };
      }
      throw new Error(`qqbot_notes_manage: 不认识的 action「${String(action)}」`);
    },
  });

  logger.info(`im-qqbot: 笔记工具已注册 root=${store.root}`);
}
