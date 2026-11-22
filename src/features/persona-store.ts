/**
 * 聊天人设 — 每个人设一个文件，按群或私聊选用。
 *
 * ~/.dsh-qqbot/personas/<id>.md，放进目录就能选，不用改配置也不用重载；每次都重新读目录，
 * 改文件下一轮就生效。文件头可写 name（显示名）和 names（群里叫 bot 的称呼），正文就是整段 system prompt。
 * 不选就用配置里的 groupPrompt / directPrompt，这个「默认」人设没有文件。
 *
 * 除了选中谁，还按「聊天 + 人设」记 sessionId：只换 prompt 没用，旧回复的语气会盖过新人设，
 * 所以每个人设有自己的会话，切回来接着聊。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import type { ChatScope, Logger } from '../types.ts';
import { writeJsonAtomic } from '../shared/atomic-fs.ts';
import { qqbotLegacyHomeDir, qqbotPersonaHandoffsDir, qqbotPersonasDir, qqbotPersonaStatePath } from '../shared/paths.ts';
import { PersonaHandoffStore } from './persona-handoff.ts';

export const DEFAULT_PERSONA_ID = 'default';
export const DEFAULT_PERSONA_NAME = '默认';

export type PersonaSwitchState = 'idle' | 'transitioning' | 'recovering';

export interface PersonaTransitionRecord {
  id: string;
  scope: ChatScope;
  peerId: string;
  fromPersona: string;
  toPersona: string;
  sourceSessionId: string;
  targetSessionId: string;
  phase: 'handoff' | 'committing';
  startedAt: string;
}

export interface Persona {
  id: string;
  name: string;
  /** 群里叫 bot 的称呼；空 = 沿用 replyDesire.names */
  names: string[];
  /** 可选 ElevenLabs voice_id 覆盖 */
  voiceId?: string;
  prompt: string;
}

interface PersonaState {
  /** 群 → 选中的人设 id；没有就是默认 */
  groups: Record<string, string>;
  /** 群 → 人设 id → sessionId */
  sessions: Record<string, Record<string, string>>;
  /** 私聊单独存，兼容旧群聊记录，也避免用户和群的 openid 碰撞 */
  direct: Record<string, string>;
  directSessions: Record<string, Record<string, string>>;
  /** 进行中的切换事务，用于进程崩溃重启后按阶段恢复一致性 */
  transitions?: Record<string, PersonaTransitionRecord>;
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const PERSONA_FILE_RE = /^(.+?)(?:\.(group|direct))?\.md$/;
type PersonaVariant = 'base' | 'group' | 'direct';

/**
 * 解析外置人设目录：
 *   1. 显式配置 personas.root 时优先使用（相对路径按工作目录 cwd 解析）；
 *   2. 未配置且插件目录下自带 personas/*.md 时使用插件仓库目录；
 *   3. 否则回退默认 ~/.dsh-qqbot/personas。
 */
export function resolvePersonasDir(options: {
  root?: string;
  cwd?: string;
  pluginRoot?: string;
  homeDir?: string;
} = {}): string {
  const configured = (options.root ?? '').trim();
  if (configured !== '') {
    return isAbsolute(configured) ? resolve(configured) : resolve(options.cwd || process.cwd(), configured);
  }
  if (options.pluginRoot !== undefined && options.pluginRoot.trim() !== '') {
    const repoPersonas = resolve(options.pluginRoot, 'personas');
    try {
      if (readdirSync(repoPersonas).some((file) => !file.startsWith('_') && PERSONA_FILE_RE.test(file))) {
        return repoPersonas;
      }
    } catch {
      // 目录不存在或不可读时回退默认目录
    }
  }
  const home = qqbotLegacyHomeDir(options.homeDir);
  return join(home, 'personas');
}

/** 解析人设文件；正文为空或文件头写坏时抛错 */
export function parsePersona(id: string, text: string): Persona {
  const match = FRONT_MATTER_RE.exec(text);
  const head = match === null ? {} : yaml.load(match[1]!);
  const body = (match === null ? text : match[2]!).trim();
  if (body === '') throw new Error('正文为空');
  if (head === null || typeof head !== 'object' || Array.isArray(head)) throw new Error('文件头不是键值对');
  const { name, names, voiceId } = head as { name?: unknown; names?: unknown; voiceId?: unknown };
  const list: unknown[] = Array.isArray(names) ? names : names === undefined || names === null ? [] : [names];
  const trimmedVoiceId = typeof voiceId === 'string' ? voiceId.trim() : '';
  return {
    id,
    name: typeof name === 'string' && name.trim() !== '' ? name.trim() : id,
    names: list.map((value) => String(value).trim()).filter((value) => value !== ''),
    ...(trimmedVoiceId !== '' ? { voiceId: trimmedVoiceId } : {}),
    prompt: body,
  };
}

export class PersonaStore {
  public readonly handoffs: PersonaHandoffStore;
  public readonly dir: string;
  private readonly statePath: string;
  private readonly logger?: Logger;
  private state: PersonaState = { groups: {}, sessions: {}, direct: {}, directSessions: {} };
  /** 每轮都读目录，坏文件只警告一次，不然日志会被刷满 */
  private readonly warned = new Set<string>();

  public constructor(options: { dir?: string; statePath?: string; logger?: Logger } = {}) {
    this.dir = options.dir ?? qqbotPersonasDir();
    this.statePath = options.statePath ?? qqbotPersonaStatePath();
    const handoffsDir = options.statePath !== undefined ? join(dirname(this.statePath), 'persona-handoffs') : qqbotPersonaHandoffsDir();
    this.handoffs = new PersonaHandoffStore(handoffsDir);
    this.logger = options.logger;
    try {
      if (existsSync(this.statePath)) {
        const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<PersonaState>;
        const transitions = parsed.transitions && typeof parsed.transitions === 'object' && !Array.isArray(parsed.transitions)
          && Object.keys(parsed.transitions).length > 0
          ? { ...parsed.transitions }
          : undefined;
        this.state = {
          groups: parsed.groups ?? {}, sessions: parsed.sessions ?? {},
          direct: parsed.direct ?? {}, directSessions: parsed.directSessions ?? {},
          ...(transitions ? { transitions } : {}),
        };
      }
    } catch (err) {
      this.logger?.warn(`im-qqbot: 人设选择记录读取失败，各聊天回到默认人设: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private readGroupedPersonas(): Map<string, Partial<Record<PersonaVariant, Persona>>> {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((file) => !file.startsWith('_')).sort();
    } catch {
      return new Map();
    }
    const grouped = new Map<string, Partial<Record<PersonaVariant, Persona>>>();
    for (const file of files) {
      const match = PERSONA_FILE_RE.exec(file);
      if (match === null) continue;
      const id = match[1]!;
      const variant: PersonaVariant = (match[2] as 'group' | 'direct' | undefined) ?? 'base';
      try {
        const persona = parsePersona(id, readFileSync(join(this.dir, file), 'utf8'));
        this.warned.delete(file);
        const entry = grouped.get(id) ?? {};
        entry[variant] = persona;
        grouped.set(id, entry);
      } catch (err) {
        if (!this.warned.has(file)) {
          this.warned.add(file);
          this.logger?.warn(`im-qqbot: 人设文件 ${file} 无法使用，已跳过: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return grouped;
  }

  private pickVariant(entry: Partial<Record<PersonaVariant, Persona>> | undefined, scope: ChatScope): Persona | undefined {
    if (entry === undefined) return undefined;
    return scope === 'group'
      ? (entry.group ?? entry.base ?? entry.direct)
      : (entry.direct ?? entry.base ?? entry.group);
  }

  /**
   * 目录里的可选人设，按规范 id 排序；_ 开头的文件留给共用片段，default 留给默认兜底，均不进切换列表。
   * 支持 <id>.group.md / <id>.direct.md 变体，同 id 只返回一项，避免切换卡片重复。
   */
  public list(scope: ChatScope = 'group'): Persona[] {
    const grouped = this.readGroupedPersonas();
    const personas: Persona[] = [];
    for (const id of [...grouped.keys()].sort()) {
      if (id === DEFAULT_PERSONA_ID) continue;
      const chosen = this.pickVariant(grouped.get(id), scope);
      if (chosen !== undefined) personas.push(chosen);
    }
    return personas;
  }

  /** 外置默认人设（personas/default.{group,direct}.md 或 default.md）；经过 parsePersona 解析文件头与 names */
  public defaultPersona(scope: ChatScope = 'group'): Persona | undefined {
    return this.pickVariant(this.readGroupedPersonas().get(DEFAULT_PERSONA_ID), scope);
  }

  /** 按 id 或显示名找；默认人设不在可选列表中，返回 undefined */
  public find(idOrName: string, scope: ChatScope = 'group'): Persona | undefined {
    const personas = this.list(scope);
    return personas.find((persona) => persona.id === idOrName) ?? personas.find((persona) => persona.name === idOrName);
  }

  /** 当前聊天显式选中的非默认人设；未选或文件已删时返回 undefined（默认人设另调 defaultPersona） */
  public current(peerId: string, scope: ChatScope = 'group'): Persona | undefined {
    const id = (scope === 'group' ? this.state.groups : this.state.direct)[peerId];
    return id === undefined ? undefined : this.list(scope).find((persona) => persona.id === id);
  }

  public currentId(peerId: string, scope: ChatScope = 'group'): string {
    return this.current(peerId, scope)?.id ?? DEFAULT_PERSONA_ID;
  }

  public select(peerId: string, personaId: string, scope: ChatScope = 'group'): void {
    const selected = scope === 'group' ? this.state.groups : this.state.direct;
    const previous = selected[peerId];
    if (personaId === DEFAULT_PERSONA_ID) delete selected[peerId];
    else selected[peerId] = personaId;
    try {
      this.save();
    } catch (err) {
      // 磁盘失败不能让内存先换人设、会话却还留在原人格。
      if (previous === undefined) delete selected[peerId];
      else selected[peerId] = previous;
      throw err;
    }
  }

  public sessionFor(peerId: string, personaId: string, scope: ChatScope = 'group'): string | undefined {
    return (scope === 'group' ? this.state.sessions : this.state.directSessions)[peerId]?.[personaId];
  }

  public rememberSession(peerId: string, personaId: string, sessionId: string, scope: ChatScope = 'group'): void {
    const sessions = scope === 'group' ? this.state.sessions : this.state.directSessions;
    (sessions[peerId] ??= {})[personaId] = sessionId;
    this.save();
  }

  private transitionKey(peerId: string, scope: ChatScope): string {
    return `${scope}:${peerId}`;
  }

  public getTransition(peerId: string, scope: ChatScope = 'group'): PersonaTransitionRecord | undefined {
    return this.state.transitions?.[this.transitionKey(peerId, scope)];
  }

  /** 在摘要与切换动作开始前写入持久化事务标记，保证中途崩溃可按阶段恢复。 */
  public beginTransition(
    input: Omit<PersonaTransitionRecord, 'id' | 'phase' | 'startedAt'>,
  ): PersonaTransitionRecord {
    const key = this.transitionKey(input.peerId, input.scope);
    const prevMap = this.state.transitions;
    const prevEntry = prevMap?.[key];
    const record: PersonaTransitionRecord = {
      ...input,
      id: randomUUID(),
      phase: 'handoff',
      startedAt: new Date().toISOString(),
    };
    this.state.transitions ??= {};
    this.state.transitions[key] = record;
    try {
      this.save();
    } catch (err) {
      if (prevMap === undefined) delete this.state.transitions;
      else if (prevEntry === undefined) delete this.state.transitions[key];
      else this.state.transitions[key] = prevEntry;
      throw err;
    }
    return record;
  }

  /** 单次原子落盘：记下双方会话绑定、切到目标人设，并把事务推进到 committing。 */
  public commitTransition(peerId: string, scope: ChatScope = 'group'): PersonaTransitionRecord | undefined {
    const key = this.transitionKey(peerId, scope);
    const current = this.state.transitions?.[key];
    if (current === undefined) return undefined;

    const selected = scope === 'group' ? this.state.groups : this.state.direct;
    const sessions = scope === 'group' ? this.state.sessions : this.state.directSessions;
    const prevSelected = selected[peerId];
    const prevPeerSessions = sessions[peerId];
    const hadFrom = prevPeerSessions !== undefined && Object.prototype.hasOwnProperty.call(prevPeerSessions, current.fromPersona);
    const hadTo = prevPeerSessions !== undefined && Object.prototype.hasOwnProperty.call(prevPeerSessions, current.toPersona);
    const prevFromSession = prevPeerSessions?.[current.fromPersona];
    const prevToSession = prevPeerSessions?.[current.toPersona];

    const peerSessions = (sessions[peerId] ??= {});
    peerSessions[current.fromPersona] = current.sourceSessionId;
    peerSessions[current.toPersona] = current.targetSessionId;
    if (current.toPersona === DEFAULT_PERSONA_ID) delete selected[peerId];
    else selected[peerId] = current.toPersona;
    const next: PersonaTransitionRecord = { ...current, phase: 'committing' };
    this.state.transitions![key] = next;

    try {
      this.save();
    } catch (err) {
      if (prevSelected === undefined) delete selected[peerId];
      else selected[peerId] = prevSelected;
      if (prevPeerSessions === undefined) {
        delete sessions[peerId];
      } else {
        if (hadFrom) prevPeerSessions[current.fromPersona] = prevFromSession!;
        else delete prevPeerSessions[current.fromPersona];
        if (hadTo) prevPeerSessions[current.toPersona] = prevToSession!;
        else delete prevPeerSessions[current.toPersona];
      }
      this.state.transitions![key] = current;
      throw err;
    }
    return next;
  }

  public finishTransition(peerId: string, scope: ChatScope = 'group'): void {
    const key = this.transitionKey(peerId, scope);
    const current = this.state.transitions?.[key];
    if (current === undefined) return;
    delete this.state.transitions![key];
    const emptied = Object.keys(this.state.transitions!).length === 0;
    if (emptied) delete this.state.transitions;
    try {
      this.save();
    } catch (err) {
      (this.state.transitions ??= {})[key] = current;
      throw err;
    }
  }

  private save(): void {
    writeJsonAtomic(this.statePath, this.state, { indent: 2 });
  }
}
