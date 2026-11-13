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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import type { ChatScope, Logger } from '../types.ts';
import { PersonaHandoffStore } from './persona-handoff.ts';

export const DEFAULT_PERSONA_ID = 'default';
export const DEFAULT_PERSONA_NAME = '默认';

export interface Persona {
  id: string;
  name: string;
  /** 群里叫 bot 的称呼；空 = 沿用 replyDesire.names */
  names: string[];
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
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/** 解析人设文件；正文为空或文件头写坏时抛错 */
export function parsePersona(id: string, text: string): Persona {
  const match = FRONT_MATTER_RE.exec(text);
  const head = match === null ? {} : yaml.load(match[1]!);
  const body = (match === null ? text : match[2]!).trim();
  if (body === '') throw new Error('正文为空');
  if (head === null || typeof head !== 'object' || Array.isArray(head)) throw new Error('文件头不是键值对');
  const { name, names } = head as { name?: unknown; names?: unknown };
  const list: unknown[] = Array.isArray(names) ? names : names === undefined || names === null ? [] : [names];
  return {
    id,
    name: typeof name === 'string' && name.trim() !== '' ? name.trim() : id,
    names: list.map((value) => String(value).trim()).filter((value) => value !== ''),
    prompt: body,
  };
}

export class PersonaStore {
  public readonly handoffs: PersonaHandoffStore;
  private readonly dir: string;
  private readonly statePath: string;
  private readonly logger?: Logger;
  private state: PersonaState = { groups: {}, sessions: {}, direct: {}, directSessions: {} };
  /** 每轮都读目录，坏文件只警告一次，不然日志会被刷满 */
  private readonly warned = new Set<string>();

  public constructor(options: { dir?: string; statePath?: string; logger?: Logger } = {}) {
    const home = resolve(homedir(), '.dsh-qqbot');
    this.dir = options.dir ?? join(home, 'personas');
    this.statePath = options.statePath ?? join(home, 'persona-state.json');
    this.handoffs = new PersonaHandoffStore(join(dirname(this.statePath), 'persona-handoffs'));
    this.logger = options.logger;
    try {
      if (existsSync(this.statePath)) {
        const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<PersonaState>;
        this.state = {
          groups: parsed.groups ?? {}, sessions: parsed.sessions ?? {},
          direct: parsed.direct ?? {}, directSessions: parsed.directSessions ?? {},
        };
      }
    } catch (err) {
      this.logger?.warn(`im-qqbot: 人设选择记录读取失败，各聊天回到默认人设: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 目录里的人设，按文件名排序；_ 开头的文件留给共用片段，不算人设 */
  public list(): Persona[] {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((file) => file.endsWith('.md') && !file.startsWith('_')).sort();
    } catch {
      return [];
    }
    const personas: Persona[] = [];
    for (const file of files) {
      const id = basename(file, '.md');
      if (id === DEFAULT_PERSONA_ID) continue;
      try {
        personas.push(parsePersona(id, readFileSync(join(this.dir, file), 'utf8')));
        this.warned.delete(file);
      } catch (err) {
        if (!this.warned.has(file)) {
          this.warned.add(file);
          this.logger?.warn(`im-qqbot: 人设文件 ${file} 无法使用，已跳过: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return personas;
  }

  /** 按 id 或显示名找；默认人设没有文件，返回 undefined */
  public find(idOrName: string): Persona | undefined {
    const personas = this.list();
    return personas.find((persona) => persona.id === idOrName) ?? personas.find((persona) => persona.name === idOrName);
  }

  /** 当前聊天选中的人设；选的是默认，或文件已被删掉时返回 undefined */
  public current(peerId: string, scope: ChatScope = 'group'): Persona | undefined {
    const id = (scope === 'group' ? this.state.groups : this.state.direct)[peerId];
    return id === undefined ? undefined : this.list().find((persona) => persona.id === id);
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

  private save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(tmp, this.statePath);
  }
}
