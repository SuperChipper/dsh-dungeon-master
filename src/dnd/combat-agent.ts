import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { DndCombatAgentConfig } from '../config.ts';
import type { DshAgent, DshAgentHandle, DshAgentRegistry, SessionEventLike, SessionRecord } from '../session/types.ts';
import type { Logger } from '../types.ts';
import { GROUP_MESSAGE_FORMAT_PROMPT } from '../features/message-format.ts';
import { summarize, type Campaign, type Character, type CombatLedgerEntry, type Resource } from './campaign.ts';
import type { DndService } from './dnd-service.ts';
import { combatPartyContext } from './combat-context.ts';
import type { DndToolView } from './tool-views.ts';
import { isAutoSteerTurnEnd } from '../transport/turn-steer.ts';

/** 不继承终端、文件、任意委派或剧情推进能力，群权限不因战斗委派扩大。 */
export const COMBAT_TOOLS = [
  'dnd_roll', 'dnd_check', 'dnd_apply', 'dnd_initiative', 'dnd_position', 'dnd_move',
  'dnd_lookup', 'dnd_srd', 'dnd_resource', 'dnd_character', 'dnd_undo', 'dnd_chronicle', 'dnd_end', 'dnd_rule',
] as const;

interface Usage {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CombatRoute {
  provider: string;
  model: string;
  /**
   * 可选推理强度覆盖：
   * - string：显式使用该推理强度
   * - null：显式不传 reasoningEffort（沿用宿主为该模型配置的默认参数，防止跨模型 400）
   * - undefined：若与 combatAgent 配置为同一模型族则继承 combatAgent.reasoningEffort，否则不传
   */
  reasoningEffort?: string | null;
}

export interface CombatFallbackState {
  /** 全局故障转移已激活的目标路由（若主源已切走，新开战直接走备用源） */
  activeFailover?: CombatRoute;
  /** 备用路由（modelFailover 配置的备用源） */
  backup?: CombatRoute;
  /** 主 DM 会话当前实际使用的模型路由（独立战斗源与备用源不可用时，优先在轻量战斗子代理内复用主 DM 模型，仍失败才交回主 DM） */
  mainRoute?: CombatRoute;
}

const PRIMARY_COOLDOWN_MS = 30 * 60_000;

export interface CombatRun {
  version: 1;
  id: string;
  sessionKey: string;
  mainSessionId: string;
  childSessionId: string;
  campaignCreatedAt: number;
  startedAt: number;
  endedAt?: number;
  status: 'active' | 'completed' | 'paused' | 'failed' | 'interrupted';
  provider: string;
  model: string;
  reasoningEffort?: string;
  prompt: string;
  before: string;
  chronicleId: number;
  lastNarration?: string;
  lastNarrationRound?: number;
  narratedLedgerCount?: number;
  fallbackFrom?: string;
  triedRoutes?: string[];
  error?: string;
  handoff?: string;
  usage: Record<string, Usage>;
  lastSeq: Record<string, number>;
}

interface ActiveCombat {
  main: SessionRecord;
  child: SessionRecord;
  run: CombatRun;
  triedRoutes: Set<string>;
  lastDialogue?: { text: string; fromChild: boolean };
  runtimeContextSuppressed?: boolean;
  lastInjectedSnapshot?: string;
  lastPrompt?: string;
  pendingTurnEnd?: Promise<void>;
}

const TURN_SNAPSHOT_PREFIX_RE = /^【团况 · DM 视角（本轮最新快照，旧快照作废）】\n[\s\S]*?\n\n/;

export function stripTurnSnapshotPrefix(text: string): string {
  return text.replace(TURN_SNAPSHOT_PREFIX_RE, '');
}

function eventsOf(agent: DshAgent): readonly SessionEventLike[] {
  return agent.session.snapshotEvents?.() ?? agent.session.events ?? [];
}

/** 只取实际对话，排除旧团况、工具结果和推理；固定在子会话前缀中以便命中缓存。 */
export function recentCombatDialogue(agent: DshAgent, maxChars: number, fromCombatChild = false): string {
  const lines: string[] = [];
  let left = maxChars;
  for (const event of [...eventsOf(agent)].reverse()) {
    if (event.type !== 'assistant/message' && event.type !== 'user/message') continue;
    const data = (event.data ?? event) as {
      content?: Array<{ type: string; text?: string }>;
      source?: { kind?: string };
      message?: { content?: Array<{ type: string; text?: string }>; source?: { kind?: string } };
    };
    // v4 用户事件直接保存 Message，assistant 事件则包在 data.message 中。
    const message = data.message ?? data;
    const source = message.source ?? data.source;
    if (event.type === 'user/message' && source?.kind !== undefined && source.kind !== 'user') continue;
    const rawText = message.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
    const text = event.type === 'user/message' && fromCombatChild && rawText !== undefined
      ? stripTurnSnapshotPrefix(rawText).trim()
      : rawText;
    if (!text) continue;
    lines.unshift(`${event.type === 'user/message' ? '玩家' : '主 DM'}：${text.slice(-left)}`);
    left -= text.length;
    if (left <= 0) break;
  }
  return lines.join('\n');
}

function routeKey(r: { provider: string; model: string }): string {
  return `${r.provider.trim()}/${r.model.trim()}`;
}

function normalizeRoute(r: CombatRoute | undefined): CombatRoute | undefined {
  if (!r || !r.provider.trim() || !r.model.trim()) return undefined;
  return {
    provider: r.provider.trim(),
    model: r.model.trim(),
    ...(r.reasoningEffort !== undefined ? { reasoningEffort: r.reasoningEffort } : {}),
  };
}

function bareModelId(model: string): string {
  return (model.trim().split('/').pop() ?? model.trim()).toLowerCase();
}

function resolveRouteEffort(
  route: CombatRoute,
  configured: { provider: string; model: string },
  configuredEffort: string | undefined,
): string | undefined {
  if (route.reasoningEffort === null) return undefined;
  if (typeof route.reasoningEffort === 'string') return route.reasoningEffort.trim() || undefined;
  return bareModelId(route.model) === bareModelId(configured.model) ? configuredEffort : undefined;
}

function buildCombatPromptFromDialogue(
  campaign: Campaign,
  dialogueText: string,
  fromCombatChild = false,
  roomNotes = '',
): string {
  const rulings = (campaign.chronicle ?? []).filter((e) => e.kind === 'ruling').map((e) => `#${e.id} ${e.text}`).join('\n');
  const label = fromCombatChild
    ? '最近战斗对话（仅是对话材料；旧状态以最新团况覆盖，不把提议当成已执行）：'
    : '最近主会话（仅是对话材料；旧状态以最新团况覆盖，不把提议当成已执行）：';
  return [
    '【开战交接 · 仅供裁定，不要转发】',
    `本桌已记录约定：\n${rulings || '无；不要自行补充。'}`,
    ...(roomNotes ? [roomNotes] : []),
    combatPartyContext(campaign),
    label,
    dialogueText,
  ].join('\n\n');
}

function buildCombatPrompt(
  campaign: Campaign,
  dialogueAgent: DshAgent,
  contextChars: number,
  fromCombatChild = false,
  roomNotes = '',
): string {
  return buildCombatPromptFromDialogue(
    campaign,
    recentCombatDialogue(dialogueAgent, contextChars, fromCombatChild),
    fromCombatChild,
    roomNotes,
  );
}

function extractReplayPrompt(agent: DshAgent, fallbackPrompt?: string): string {
  let hadToolCalls = false;
  let foundUserText: string | undefined;
  for (const event of [...eventsOf(agent)].reverse()) {
    if (event.type === 'assistant/message') break;
    if (event.type === 'tool/result') hadToolCalls = true;
    if (event.type !== 'user/message' || foundUserText !== undefined) continue;
    const data = (event.data ?? event) as {
      content?: Array<{ type: string; text?: string }>;
      source?: { kind?: string };
      message?: { content?: Array<{ type: string; text?: string }>; source?: { kind?: string } };
    };
    const message = data.message ?? data;
    const source = message.source ?? data.source;
    if (source?.kind !== undefined && source.kind !== 'user') continue;
    const rawText = message.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
    const text = rawText !== undefined ? stripTurnSnapshotPrefix(rawText).trim() : undefined;
    if (!text || text.startsWith('Current runtime context.')) continue;
    foundUserText = text;
  }
  const base = foundUserText
    ?? fallbackPrompt
    ?? '[系统 · 备用通道恢复] 上一轮请求因上游接口异常未完成。请先核对最新团况与待结算状态，继续主持当前战斗回合。';
  if (!hadToolCalls || base.startsWith('[系统 · 备用通道续接]')) return base;
  return `[系统 · 备用通道续接] 上一通道在执行中途报错断开，部分工具结果已实时写入团档。请先核对最新【团况 · DM 视角】与待结算窗口，已落账的站位/检定/扣血切勿重复执行，只继续未完成的部分：\n${base}`;
}

interface PartySnapshotItem {
  name: string;
  hp: number;
  maxHp: number;
  tempHp: number;
  conditions: string[];
  resources?: Record<string, Resource>;
  notes?: string;
  inventory: string[];
  gp: number;
  room?: string;
}

function partySnapshotItemsFromCharacters(characters: readonly Character[]): PartySnapshotItem[] {
  return characters.filter((ch) => ch.kind !== 'monster').map((ch) => ({
    name: ch.name,
    hp: ch.hp,
    maxHp: ch.maxHp,
    tempHp: ch.tempHp ?? 0,
    conditions: [...(ch.conditions ?? [])],
    ...(ch.resources !== undefined ? { resources: structuredClone(ch.resources) } : {}),
    ...(ch.notes !== undefined ? { notes: ch.notes } : {}),
    inventory: [...(ch.inventory ?? [])],
    gp: ch.gp ?? 0,
    ...(ch.room !== undefined ? { room: ch.room } : {}),
  }));
}

function partyState(c: Campaign): string {
  // 演练模式下 startInitiative 会在开战时把角色临时改成演练血量，交接基线应取真正的演练前快照
  const source = c.initiative?.rehearsalSnapshot?.characters ?? c.characters;
  return JSON.stringify(partySnapshotItemsFromCharacters(source));
}

function formatPartyDelta(beforeJson: string, c: Campaign): string {
  let prevList: PartySnapshotItem[] | undefined;
  try {
    const parsed = JSON.parse(beforeJson) as unknown;
    if (Array.isArray(parsed)) prevList = parsed as PartySnapshotItem[];
  } catch { /* fallback below */ }
  const current = partySnapshotItemsFromCharacters(c.characters);
  if (prevList === undefined) {
    return current.map((ch) => `${ch.name} HP ${ch.hp}/${ch.maxHp}${ch.tempHp > 0 ? `(+${ch.tempHp})` : ''}${ch.conditions.length > 0 ? ` [${ch.conditions.join('、')}]` : ''}`).join('；') || '无角色';
  }
  const prevByName = new Map(prevList.map((p) => [p.name, p]));
  const currNames = new Set(current.map((ch) => ch.name));
  const lines: string[] = [];
  for (const curr of current) {
    const prev = prevByName.get(curr.name);
    if (prev === undefined) {
      lines.push(`- 新增同伴 ${curr.name}：HP ${curr.hp}/${curr.maxHp}${curr.conditions.length > 0 ? ` [${curr.conditions.join('、')}]` : ''}`);
      continue;
    }
    const diffs: string[] = [];
    if (prev.hp !== curr.hp || prev.maxHp !== curr.maxHp) {
      diffs.push(`HP ${prev.hp}/${prev.maxHp}→${curr.hp}/${curr.maxHp}`);
    }
    if ((prev.tempHp ?? 0) !== (curr.tempHp ?? 0)) {
      diffs.push(`临时HP ${prev.tempHp ?? 0}→${curr.tempHp ?? 0}`);
    }
    const prevCond = prev.conditions ?? [];
    if (JSON.stringify(prevCond) !== JSON.stringify(curr.conditions)) {
      diffs.push(`状态 [${prevCond.join('、') || '无'}]→[${curr.conditions.join('、') || '无'}]`);
    }
    const resKeys = new Set([...Object.keys(prev.resources ?? {}), ...Object.keys(curr.resources ?? {})]);
    const resDiffs: string[] = [];
    for (const key of resKeys) {
      const pr = prev.resources?.[key];
      const cr = curr.resources?.[key];
      if (pr?.current !== cr?.current || pr?.max !== cr?.max) {
        resDiffs.push(`${key} ${pr ? `${pr.current}/${pr.max}` : '无'}→${cr ? `${cr.current}/${cr.max}` : '移除'}`);
      }
    }
    if (resDiffs.length > 0) diffs.push(`资源 ${resDiffs.join('、')}`);
    if ((prev.gp ?? 0) !== (curr.gp ?? 0)) diffs.push(`金币 ${prev.gp ?? 0}→${curr.gp ?? 0}`);
    const prevInv = prev.inventory ?? [];
    if (JSON.stringify(prevInv) !== JSON.stringify(curr.inventory)) {
      const added = curr.inventory.filter((x) => !prevInv.includes(x));
      const removed = prevInv.filter((x) => !curr.inventory.includes(x));
      if (added.length > 0) diffs.push(`新增物品 [${added.join('、')}]`);
      if (removed.length > 0) diffs.push(`消耗/移除物品 [${removed.join('、')}]`);
      if (added.length === 0 && removed.length === 0) diffs.push(`物品数量变化`);
    }
    if ((prev.room ?? '') !== (curr.room ?? '')) diffs.push(`房间 ${prev.room ?? '随队'}→${curr.room ?? '随队'}`);
    if ((prev.notes ?? '') !== (curr.notes ?? '')) diffs.push(`备注更新：${(curr.notes ?? '（清空）').slice(0, 240)}`);
    if (diffs.length > 0) lines.push(`- ${curr.name}：${diffs.join('；')}`);
  }
  for (const prev of prevList) {
    if (!currNames.has(prev.name)) lines.push(`- 已移除角色：${prev.name}`);
  }
  if (lines.length === 0) {
    return c.lastCombat?.restored
      ? '【演练已自动还原】所有角色 HP、资源、状态、物品及房间场地图已恢复到开战前快照，无永久损耗。'
      : '队伍 HP、资源、状态与物品较开战前无净变化。';
  }
  return lines.join('\n');
}

function formatLedgerByRound(entries: readonly CombatLedgerEntry[]): string {
  const groups = new Map<number, string[]>();
  for (const entry of entries) {
    const list = groups.get(entry.round) ?? [];
    list.push(`${entry.seq !== undefined ? `[#R${entry.seq}] ` : ''}${entry.text}`);
    groups.set(entry.round, list);
  }
  return [...groups.entries()]
    .map(([round, list]) => `第 ${round} 轮：\n${list.map((line) => `  - ${line}`).join('\n')}`)
    .join('\n');
}

function rowUsage(label: string, u: Usage): string {
  return `${label}：${u.requests} 次请求｜新输入 ${u.input}｜缓存读取 ${u.cacheRead}｜缓存写入 ${u.cacheWrite}｜输出 ${u.output}`;
}

/**
 * 专用子 Agent 由 QQ 插件持有 handle：群消息直接路由，不经主模型逐条转述。
 * 活跃日志记录精简前缀和子会话 ID，插件重组后可恢复同一场战斗。
 */
export class DndCombatAgents {
  private readonly active = new Map<string, ActiveCombat>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly settling = new Map<string, CombatRun>();
  private readonly generations = new Map<string, number>();
  private readonly failed = new Set<string>();
  private disposed = false;
  private readonly starting = new Set<string>();
  private primaryCooldown?: { key: string; until: number; reason: string };

  public constructor(
    private readonly agents: DshAgentRegistry,
    private readonly service: DndService,
    private readonly settings: () => DndCombatAgentConfig | undefined,
    private readonly syncTools: (record: SessionRecord) => void,
    private readonly logger: Logger,
    private readonly directory = join(service.store.root, '..', 'combat-runs'),
    private readonly fallback?: (main: SessionRecord) => CombatFallbackState | undefined,
  ) {}

  private candidateFallbacks(main: SessionRecord, excludeKeys: ReadonlySet<string>): CombatRoute[] {
    const fb = this.fallback?.(main);
    const out: CombatRoute[] = [];
    const seen = new Set(excludeKeys);
    for (const raw of [fb?.backup, fb?.mainRoute]) {
      const route = normalizeRoute(raw);
      if (!route) continue;
      const k = routeKey(route);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(route);
    }
    return out;
  }

  private resolveRoutes(
    configured: CombatRoute,
    main: SessionRecord,
  ): { initial: CombatRoute; fallbacks: CombatRoute[]; tried: string[]; preSwitchReason?: string } {
    const primaryKey = routeKey(configured);
    const fb = this.fallback?.(main);
    const candidates = this.candidateFallbacks(main, new Set([primaryKey]));
    if (candidates.length === 0) return { initial: configured, fallbacks: [], tried: [primaryKey] };
    const normBackup = normalizeRoute(fb?.backup);
    const activeFo = normalizeRoute(fb?.activeFailover);
    if (normBackup && activeFo && routeKey(activeFo) === routeKey(normBackup)) {
      const chosen = candidates.find((c) => routeKey(c) === routeKey(normBackup)) ?? normBackup;
      const rest = candidates.filter((c) => routeKey(c) !== routeKey(chosen));
      return {
        initial: chosen,
        fallbacks: rest,
        tried: [primaryKey, routeKey(chosen)],
        preSwitchReason: `${primaryKey} (全局故障转移生效中)`,
      };
    }
    if (this.primaryCooldown && this.primaryCooldown.key === primaryKey && Date.now() < this.primaryCooldown.until) {
      const [chosen, ...rest] = candidates;
      return {
        initial: chosen!,
        fallbacks: rest,
        tried: [primaryKey, routeKey(chosen!)],
        preSwitchReason: `${primaryKey} (近期报错冷却中: ${this.primaryCooldown.reason})`,
      };
    }
    return { initial: configured, fallbacks: candidates, tried: [primaryKey] };
  }

  private markPrimaryCooldown(route: CombatRoute, reason: string): void {
    const config = this.settings();
    if (!config) return;
    if (config.provider.trim() === route.provider && config.model.trim() === route.model) {
      this.primaryCooldown = { key: `${route.provider}/${route.model}`, until: Date.now() + PRIMARY_COOLDOWN_MS, reason };
    }
  }

  private makeSetup(sessionKey: string, getPrompt: () => string, onSuppressed?: (suppressed: boolean) => void): (scope: Context) => void {
    return (scope: Context): void => {
      const tools = scope.get('tools') as { restrict?: (filter: { allow: readonly string[] }) => unknown; guard?: (guard: (exec: { name: string; arguments?: unknown }) => string | undefined) => unknown } | undefined;
      const prompt = scope.get('systemPrompt') as {
        section?: (section: { name: string; order: number; text: string; complete: boolean; interpolate: boolean }) => unknown;
        suppressRuntimeContext?: () => unknown;
      } | undefined;
      if (!tools?.restrict || !tools.guard || !prompt?.section) throw new Error('宿主不支持战斗代理的工具隔离或完整提示词');
      tools.restrict({ allow: COMBAT_TOOLS });
      tools.guard((exec) => {
        if (!COMBAT_TOOLS.includes(exec.name as typeof COMBAT_TOOLS[number])) return '战斗代理只能使用授权的跑团工具';
        if (!this.service.active(sessionKey)?.campaign.initiative) return '战斗已结束或暂停，等待主 DM 接手，不再执行战斗操作';
        if (exec.name === 'dnd_initiative' && (exec.arguments as { action?: string })?.action === 'start') return '这场战斗已有先攻表，不可重开战斗';
        if (exec.name === 'dnd_rule') {
          const ruleAct = (exec.arguments as { action?: string })?.action;
          if (ruleAct === 'define' || ruleAct === 'remove') {
            return '战斗子代理仅可查询已登记规则（list/show），新增或移除村规/扩展规则须由主 DM 与玩家确认';
          }
        }
        return undefined;
      });
      const suppressed = typeof prompt.suppressRuntimeContext === 'function';
      if (suppressed) prompt.suppressRuntimeContext!();
      onSuppressed?.(suppressed);
      // runtime-context 每次团况变化都会重发整份快照，固定交接放在稳定前缀里，避免每次重复几千 token。
      // 交接含玩家原话，不作模板插值；{{...}} 保持字面文本。
      prompt.section({
        name: 'qqbot:combat-agent', order: 0, complete: true, interpolate: false,
        text: `${this.service.combatInstructions()}\n${GROUP_MESSAGE_FORMAT_PROMPT}\n\n${getPrompt()}`,
      });
    };
  }

  /**
   * 当宿主支持 suppressRuntimeContext 时，关闭每步工具改档的 4KB 全量快照刷屏，
   * 改为仅在每轮新消息进入子代理、且精简战况较上一轮发生变化时前置一次精简战斗快照。
   */
  public decorateTurnText(record: SessionRecord, text: string): string {
    const active = this.active.get(record.sessionKey);
    if (active === undefined || active.child.agent !== record.agent || !active.runtimeContextSuppressed) return text;
    let snap = '';
    try {
      snap = this.service.combatStateSnapshot(record.sessionKey);
    } catch (err) {
      this.logger.warn(`im-qqbot: 注入战斗精简快照失败: ${err instanceof Error ? err.message : String(err)}`);
      return text;
    }
    if (!snap || snap === active.lastInjectedSnapshot) return text;
    active.lastInjectedSnapshot = snap;
    return `${snap}\n\n${text}`;
  }

  public decorateInboundText(record: SessionRecord, text: string): string {
    const active = this.active.get(record.sessionKey);
    if (active === undefined || active.child.agent !== record.agent) return text;
    active.lastPrompt = text;
    return this.decorateTurnText(record, text);
  }

  public decorateFollowupMessage(record: SessionRecord, message: unknown): unknown {
    const active = this.active.get(record.sessionKey);
    if (active === undefined || active.child.agent !== record.agent) return message;
    if (typeof message !== 'object' || message === null || !Array.isArray((message as { content?: unknown }).content)) {
      return message;
    }
    const msg = message as { content: Array<{ type: string; text?: string }>; [k: string]: unknown };
    const idx = msg.content.findIndex((b) => b.type === 'text' && typeof b.text === 'string');
    if (idx < 0) return message;
    const cleanText = msg.content[idx]!.text!;
    active.lastPrompt = cleanText;
    const decorated = this.decorateTurnText(record, cleanText);
    if (decorated === cleanText) return message;
    const nextContent = [...msg.content];
    nextContent[idx] = { ...nextContent[idx]!, text: decorated };
    return { ...msg, content: nextContent };
  }

  private file(key: string): string { return join(this.directory, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`); }

  private save(run: CombatRun): void {
    mkdirSync(this.directory, { recursive: true });
    const file = this.file(run.sessionKey);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(run, null, 2), 'utf8');
    renameSync(tmp, file);
    // 每场单独保留，latest 文件仅用于恢复和 /dnd combat。
    writeFileSync(join(this.directory, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf8');
  }

  private checkpoint(run: CombatRun): void {
    try { this.save(run); }
    catch (err) { this.logger.warn(`im-qqbot: 战斗用量记录写入失败: ${String(err)}`); }
  }

  private load(key: string): CombatRun | undefined {
    try {
      if (!existsSync(this.file(key))) return undefined;
      const run = JSON.parse(readFileSync(this.file(key), 'utf8')) as CombatRun;
      return run.version === 1 && run.sessionKey === key ? run : undefined;
    } catch { return undefined; }
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.locks.set(key, result);
    void result.finally(() => { if (this.locks.get(key) === result) this.locks.delete(key); }).catch(() => {});
    return result;
  }

  public current(key: string): SessionRecord | undefined { return this.active.get(key)?.child; }
  public toolView(record: { sessionKey: string; agent: object }): DndToolView {
    const config = this.settings();
    if (!config?.enabled || !config.provider.trim() || !config.model.trim() || this.failed.has(record.sessionKey)) return 'full';
    if (this.isChild(record.agent as DshAgent)) return 'full';
    return this.active.has(record.sessionKey) ? 'waiting' : 'narrative';
  }

  /** 主 DM 只掷开战先攻，回复结束后自动唤醒子级；怪物先手也不必等玩家再发「继续」。 */
  public startAfterReply(main: SessionRecord, field: string): Promise<SessionRecord | undefined> | undefined {
    if (this.disposed || this.toolView(main) !== 'narrative' || this.starting.has(main.sessionKey)) return;
    const generation = this.generations.get(main.sessionKey) ?? 0;
    this.starting.add(main.sessionKey);
    return main.agent.whenIdle().then(async () => {
      if (this.disposed || generation !== (this.generations.get(main.sessionKey) ?? 0)
        || !this.service.active(main.sessionKey)?.campaign.initiative) return;
      const existing = this.current(main.sessionKey);
      if (existing !== undefined) { await existing.agent.whenIdle(); return existing; }
      const target = await this.select(main);
      if (target === main) {
        if (this.service.active(main.sessionKey)?.campaign.initiative) {
          this.failed.add(main.sessionKey);
          this.syncTools(main);
          main.agent.followup(createUserMessage({ content: [{ type: 'text', text: '[系统 · 战斗委派未接管] 完整战斗工具已恢复，由你接着主持；先核对先攻与站位，不能重掷已完成的先攻。' }], source: { kind: 'user' } }));
        }
        return;
      }
      if (target.agent.status !== 'idle') return;
      const handoffPrompt = `[系统 · 战斗接管] 主 DM 已掷先攻并叙述开场。缺少场地图/站位时先按下列场地准备，不重掷先攻；随后只结算当前怪物回合，轮到 PC 或有反应就停。\n${field}`;
      const active = this.active.get(main.sessionKey);
      if (active) active.lastPrompt = handoffPrompt;
      const promptWithState = this.decorateTurnText(target, handoffPrompt);
      target.agent.followup(createUserMessage({ content: [{ type: 'text', text: promptWithState }], source: { kind: 'user' } }));
      await target.agent.whenIdle();
      await this.active.get(main.sessionKey)?.pendingTurnEnd;
      const current = this.current(main.sessionKey);
      if (current !== undefined && current !== target) {
        await current.agent.whenIdle();
        await this.active.get(main.sessionKey)?.pendingTurnEnd;
      }
      return this.current(main.sessionKey);
    }).finally(() => this.starting.delete(main.sessionKey));
  }
  public isChild(agent: DshAgent): boolean { return this.findAgent(agent) !== undefined; }
  public findAgent(agent: DshAgent): SessionRecord | undefined {
    return [...this.active.values()].find((a) => a.child.agent === agent)?.child;
  }
  public findSession(id: string): SessionRecord | undefined {
    return [...this.active.values()].find((a) => a.child.sessionId === id)?.child;
  }

  public async select(main: SessionRecord): Promise<SessionRecord> {
    const generation = this.generations.get(main.sessionKey) ?? 0;
    return this.serial(main.sessionKey, async () => {
      if (this.disposed || generation !== (this.generations.get(main.sessionKey) ?? 0)) return main;
      if (this.settling.has(main.sessionId)) await main.agent.whenIdle();
      const existing = this.active.get(main.sessionKey);
      const found = this.service.active(main.sessionKey);
      const config = this.settings();
      if (existing !== undefined) {
        existing.child.replyTarget = main.replyTarget;
        existing.child.lastActivity = main.lastActivity;
        existing.child.recentSenders = main.recentSenders;
        if (existing.child.agent.status !== 'idle') return existing.child;
        if (found?.campaign.initiative !== undefined && found.campaign.createdAt === existing.run.campaignCreatedAt && config?.enabled) return existing.child;
        await this.finish(existing, found === undefined ? 'paused' : found.campaign.initiative ? 'interrupted' : 'completed');
        return main;
      }
      if (!found?.campaign.initiative) this.failed.delete(main.sessionKey);
      if (!config?.enabled || !found?.campaign.initiative || this.failed.has(main.sessionKey)) {
        this.syncTools(main);
        return main;
      }
      // 不在主模型仍执行工具时交接，也不让空 Provider 意外继承昂贵主模型。
      if (main.agent.status !== 'idle') return main;
      const provider = config.provider.trim();
      const model = config.model.trim();
      if (!provider || !model) {
        this.failed.add(main.sessionKey);
        this.syncTools(main);
        this.logger.warn(`im-qqbot: 战斗代理 provider/model 为空，继续由主 DM 主持 key=${main.sessionKey}`);
        return main;
      }
      const configuredRoute: CombatRoute = { provider, model };
      const configuredEffort = config.reasoningEffort.trim() || undefined;
      const { initial, fallbacks, tried, preSwitchReason } = this.resolveRoutes(configuredRoute, main);
      let run = this.load(main.sessionKey);
      let restore = run?.status === 'active' && run.mainSessionId === main.sessionId && run.campaignCreatedAt === found.campaign.createdAt;
      if (!restore || run === undefined) {
        run = {
          version: 1, id: randomUUID(), sessionKey: main.sessionKey, mainSessionId: main.sessionId,
          childSessionId: randomUUID(), campaignCreatedAt: found.campaign.createdAt, startedAt: Date.now(), status: 'active',
          provider: initial.provider, model: initial.model,
          ...(preSwitchReason ? { fallbackFrom: preSwitchReason } : {}),
          triedRoutes: [...tried],
          reasoningEffort: resolveRouteEffort(initial, configuredRoute, configuredEffort),
          prompt: buildCombatPrompt(found.campaign, main.agent, config.contextChars, false, this.service.roomCombatNotes(main.sessionKey)),
          before: partyState(found.campaign), chronicleId: found.campaign.chronicle?.at(-1)?.id ?? 0, usage: {}, lastSeq: {},
        };
      }
      let runtimeContextSuppressed = false;
      const setup = this.makeSetup(main.sessionKey, () => run!.prompt, (s) => { runtimeContextSuppressed = s; });
      const spawn = async (route: CombatRoute, effort: string | undefined, allowResume: boolean): Promise<DshAgentHandle> => {
        const options = {
          agentOptions: {
            provider: route.provider,
            model: route.model,
            ...(effort !== undefined ? { reasoningEffort: effort } : {}),
          },
          setup,
        };
        return allowResume
          ? await this.agents.resume({ resumeSessionId: run!.childSessionId, ...options })
          : await this.agents.create({ sessionId: run!.childSessionId, meta: { parentSession: main.sessionId, cwd: main.agent.session.header?.cwd ?? process.cwd() }, ...options });
      };
      let handle: DshAgentHandle | undefined;
      try {
        const triedSet = new Set(run.triedRoutes?.length ? run.triedRoutes : [...tried, routeKey({ provider: run.provider, model: run.model })]);
        triedSet.add(routeKey({ provider: run.provider, model: run.model }));
        run.triedRoutes = [...triedSet];
        const pendingFallbacks = restore ? this.candidateFallbacks(main, triedSet) : [...fallbacks];
        const failureNotes = run.fallbackFrom ? [run.fallbackFrom] : [];
        let currentRoute: CombatRoute = { provider: run.provider, model: run.model, reasoningEffort: run.reasoningEffort ?? null };
        let allowResume = restore;
        for (;;) {
          try {
            handle = await spawn(currentRoute, run.reasoningEffort, allowResume);
            break;
          } catch (attemptErr) {
            const errMsg = attemptErr instanceof Error ? attemptErr.message.slice(0, 200) : String(attemptErr).slice(0, 200);
            this.markPrimaryCooldown(currentRoute, errMsg);
            const prevLabel = routeKey(currentRoute);
            failureNotes.push(`${prevLabel} (${errMsg})`);
            const next = pendingFallbacks.shift();
            if (!next) {
              throw failureNotes.length > 1 ? new Error(failureNotes.join('；')) : attemptErr;
            }
            triedSet.add(routeKey(next));
            this.logger.warn(`im-qqbot: 战斗代理通道 ${prevLabel} 启动失败 (${errMsg})，切至备用通道 ${next.provider}/${next.model} key=${main.sessionKey}`);
            run.fallbackFrom = failureNotes.join(' → ');
            run.provider = next.provider;
            run.model = next.model;
            run.reasoningEffort = resolveRouteEffort(next, configuredRoute, configuredEffort);
            run.triedRoutes = [...triedSet];
            run.childSessionId = randomUUID();
            restore = false;
            allowResume = false;
            currentRoute = next;
          }
        }
        if (this.disposed || generation !== (this.generations.get(main.sessionKey) ?? 0)) { await handle.dispose(); return main; }
        const child: SessionRecord = { ...main, sessionId: run.childSessionId, agent: handle.agent, handle, agentPreset: undefined, contextTokens: undefined };
        this.active.set(main.sessionKey, { main, child, run, triedRoutes: triedSet, runtimeContextSuppressed });
        this.syncTools(main);
        this.syncTools(child);
        this.save(run);
        this.logger.info(`im-qqbot: 战斗代理${restore ? '恢复' : '接管'} key=${main.sessionKey} child=${child.sessionId} model=${run.provider}/${run.model}${run.fallbackFrom ? ` (fallback from ${run.fallbackFrom})` : ''}`);
        return child;
      } catch (err) {
        this.active.delete(main.sessionKey);
        await handle?.dispose().catch(() => {});
        this.failed.add(main.sessionKey);
        this.syncTools(main);
        run.status = 'failed'; run.endedAt = Date.now();
        run.error = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
        this.checkpoint(run);
        this.logger.warn(`im-qqbot: 战斗代理不可用，主 DM 继续 key=${main.sessionKey}: ${String(err)}`);
        return main;
      }
    });
  }

  /**
   * 出站已按同一 SessionRecord 发到群；这里只记账并在安全的 idle 边界交回主 DM 或切换备用通道。
   * 返回 true 表示本次子代理 turn/end 报错已由战斗路由接管恢复（切备用模型或交回主 DM），出站层不必再向群内刷原始报错。
   */
  public observe(record: SessionRecord, event: { type: string; seq?: number; data: Record<string, unknown> }): boolean {
    const active = this.active.get(record.sessionKey);
    const settling = this.settling.get(record.sessionId);
    const run = active?.run ?? settling;
    if (!run) return false;
    if (event.seq !== undefined) {
      if ((run.lastSeq[record.sessionId] ?? -1) >= event.seq) {
        const dupReason = event.type === 'turn/end' ? (event.data.reason as { kind?: string } | undefined) : undefined;
        return Boolean(active && record.agent === active.child.agent && (dupReason?.kind === 'error' || dupReason?.kind === 'failed'));
      }
      run.lastSeq[record.sessionId] = event.seq;
    }
    if (event.type === 'assistant/message') {
      const data = event.data as { interrupted?: boolean; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }; message?: { source?: { provider?: string; model?: string }; content?: Array<{ type: string; text?: string }> } };
      const usage = data.usage;
      const lane = record.sessionId === run.childSessionId ? 'combat' : 'main';
      const source = data.message?.source;
      const key = `${lane}:${source?.provider ?? '?'}/${source?.model ?? '?'}`;
      if (usage) {
        const u = run.usage[key] ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        u.requests++; u.input += usage.inputTokens ?? 0; u.output += usage.outputTokens ?? 0;
        u.cacheRead += usage.cacheReadTokens ?? 0; u.cacheWrite += usage.cacheWriteTokens ?? 0;
      }
      if (lane === 'combat' && data.interrupted !== true) {
        const text = data.message?.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
        if (text && text !== '。') {
          run.lastNarration = text.slice(-2000);
          const activeCamp = this.service.active(record.sessionKey)?.campaign;
          const init = activeCamp?.initiative;
          if (init !== undefined) {
            run.lastNarrationRound = init.round;
            run.narratedLedgerCount = init.ledger?.length ?? 0;
          } else if (activeCamp?.lastCombat !== undefined && activeCamp.lastCombat.at >= run.startedAt) {
            run.lastNarrationRound = activeCamp.lastCombat.rounds;
            run.narratedLedgerCount = activeCamp.lastCombat.ledger.length;
          }
        }
      }
      this.checkpoint(run);
    }
    if (event.type === 'turn/end' && settling) { this.settling.delete(record.sessionId); this.checkpoint(settling); }
    if (event.type === 'turn/end' && active && record.agent === active.child.agent) {
      const reason = event.data.reason as { kind?: string; message?: string; error?: { message?: string; code?: string }; failure?: { message?: string; code?: string } } | undefined;
      if (isAutoSteerTurnEnd(reason)) return false;
      const isFailure = reason?.kind === 'error' || reason?.kind === 'failed';
      const task = record.agent.whenIdle().then(() => this.serial(record.sessionKey, async () => {
        if (this.disposed || this.active.get(record.sessionKey) !== active) return;
        const found = this.service.active(record.sessionKey);
        if (isFailure) {
          const errObj = reason?.error ?? reason?.failure;
          const code = errObj?.code ? ` (${errObj.code})` : '';
          const msg = (errObj?.message ?? reason?.message ?? '').trim();
          const errText = `${reason!.kind}${code}${msg ? `: ${msg.slice(0, 300)}` : ''}`;
          this.markPrimaryCooldown({ provider: active.run.provider, model: active.run.model }, errText);
          const prevChain = active.run.fallbackFrom ? [active.run.fallbackFrom] : [];
          prevChain.push(`${active.run.provider}/${active.run.model} (${errText})`);
          if (found?.campaign.initiative) {
            const candidates = this.candidateFallbacks(active.main, active.triedRoutes);
            for (const cand of candidates) {
              active.triedRoutes.add(routeKey(cand));
              active.run.triedRoutes = [...active.triedRoutes];
              try {
                await this.switchToBackup(active, found.campaign, cand, prevChain.join(' → '));
                return;
              } catch (switchErr) {
                const switchMsg = switchErr instanceof Error ? switchErr.message.slice(0, 160) : String(switchErr).slice(0, 160);
                prevChain.push(`${routeKey(cand)} (启动失败: ${switchMsg})`);
              }
            }
          }
          active.run.error = prevChain.length > 1 ? prevChain.join('；') : errText;
          await this.finish(active, 'failed');
        }
        else if (!found) await this.finish(active, 'paused');
        else if (!found.campaign.initiative) await this.finish(active, 'completed');
      })).catch((err: unknown) => this.logger.warn(`im-qqbot: 战斗交接失败: ${String(err)}`))
        .finally(() => { if (active.pendingTurnEnd === task) active.pendingTurnEnd = undefined; });
      active.pendingTurnEnd = task;
      return isFailure;
    }
    return false;
  }

  private async switchToBackup(active: ActiveCombat, campaign: Campaign, backup: CombatRoute, fallbackFromChain: string): Promise<void> {
    const oldChild = active.child;
    const configuredCfg = this.settings();
    const configured = { provider: configuredCfg?.provider.trim() ?? '', model: configuredCfg?.model.trim() ?? '' };
    const configuredEffort = configuredCfg?.reasoningEffort.trim() || undefined;
    const nextEffort = resolveRouteEffort(backup, configured, configuredEffort);
    const replayPrompt = extractReplayPrompt(oldChild.agent, active.lastPrompt);
    const hasChildDialogue = eventsOf(oldChild.agent).some((e) => e.type === 'assistant/message');
    const contextChars = configuredCfg?.contextChars ?? 8000;
    const dialogue = hasChildDialogue
      ? { text: recentCombatDialogue(oldChild.agent, contextChars, true), fromChild: true }
      : (active.lastDialogue ?? { text: recentCombatDialogue(active.main.agent, contextChars, false), fromChild: false });
    const nextPrompt = buildCombatPromptFromDialogue(
      campaign,
      dialogue.text,
      dialogue.fromChild,
      this.service.roomCombatNotes(active.run.sessionKey),
    );
    const nextChildId = randomUUID();
    let runtimeContextSuppressed = false;
    const setup = this.makeSetup(active.run.sessionKey, () => nextPrompt, (s) => { runtimeContextSuppressed = s; });
    const handle = await this.agents.create({
      sessionId: nextChildId,
      meta: { parentSession: active.main.sessionId, cwd: active.main.agent.session.header?.cwd ?? process.cwd() },
      agentOptions: {
        provider: backup.provider,
        model: backup.model,
        ...(nextEffort !== undefined ? { reasoningEffort: nextEffort } : {}),
      },
      setup,
    });
    active.lastDialogue = dialogue;
    active.run.prompt = nextPrompt;
    active.run.fallbackFrom = fallbackFromChain;
    active.run.provider = backup.provider;
    active.run.model = backup.model;
    active.run.reasoningEffort = nextEffort;
    active.run.childSessionId = nextChildId;
    delete active.run.error;
    const newChild: SessionRecord = {
      ...active.main,
      replyTarget: oldChild.replyTarget,
      lastActivity: oldChild.lastActivity,
      recentSenders: oldChild.recentSenders,
      sessionId: nextChildId,
      agent: handle.agent,
      handle,
      agentPreset: undefined,
      contextTokens: undefined,
    };
    active.child = newChild;
    active.runtimeContextSuppressed = runtimeContextSuppressed;
    active.lastInjectedSnapshot = undefined;
    active.lastPrompt = replayPrompt;
    this.syncTools(newChild);
    this.save(active.run);
    await oldChild.handle.dispose().catch(() => {});
    this.logger.warn(`im-qqbot: 战斗代理通道异常 (${fallbackFromChain})，已自动切至备用通道 ${backup.provider}/${backup.model} key=${active.run.sessionKey} child=${newChild.sessionId}`);
    const promptWithState = this.decorateTurnText(newChild, replayPrompt);
    newChild.agent.followup(createUserMessage({ content: [{ type: 'text', text: promptWithState }], source: { kind: 'user' } }));
  }

  private async finish(active: ActiveCombat, status: CombatRun['status']): Promise<void> {
    if (active.child.agent.status !== 'idle') return;
    const { run, main } = active;
    const found = this.service.active(run.sessionKey) ?? this.service.saved(run.sessionKey);
    run.status = status; run.endedAt = Date.now();
    const lastCombat = found?.campaign.lastCombat !== undefined && found.campaign.lastCombat.at >= run.startedAt
      ? found.campaign.lastCombat
      : undefined;
    const fullLedger = lastCombat?.ledger ?? found?.campaign.initiative?.ledger ?? [];
    const unreported = fullLedger.slice(Math.min(run.narratedLedgerCount ?? 0, fullLedger.length));
    const outcomeBlock = lastCombat === undefined
      ? undefined
      : [
          `【本场战斗结果摘要】共 ${lastCombat.rounds} 轮${lastCombat.rehearsal ? (lastCombat.restored ? '（梦境/演练模式，战后已自动还原真实状态与地图）' : '（演练模式，保留变更）') : ''}`,
          `- 击败敌方：${lastCombat.defeated.join('、') || '无'}`,
          `- 场上仍存活敌方（DM 机密数值，严禁向群内透露具体数字，只用伤势词描述）：${lastCombat.survivingMonsters.map((m) => `${m.name} HP ${m.hp}/${m.maxHp}${m.conditions.length > 0 ? ` [${m.conditions.join('、')}]` : ''}`).join('、') || '无（敌方全灭）'}`,
          `- 本场倒地/阵亡我方：${lastCombat.fallenParty.map((p) => `${p.name}（HP ${p.hp}/${p.maxHp}${p.conditions.length > 0 ? `，${p.conditions.join('、')}` : ''}）`).join('、') || '无'}`,
        ].join('\n');
    const unreportedBlock = unreported.length === 0
      ? undefined
      : [
          `【未向群内播报的战斗账本（共 ${unreported.length} 条；战斗代理已落账但尚未向玩家叙述）】`,
          '接手后的第一条回复必须按下列真实账本补叙未播报回合的关键交锋、重击/倒地与最终胜负（怪物 AC/HP/DC 保密，不报具体剩余血量数字）：',
          formatLedgerByRound(unreported),
        ].join('\n');
    const newChronicle = found
      ? (found.campaign.chronicle ?? []).filter((e) => e.id > run.chronicleId).map((e) => e.text).join('\n')
      : '';
    run.handoff = [
      '【系统 · 战斗代理交回 · DM 私有】',
      ...(status === 'paused' ? ['团已暂停。只确认保存，不推进回合或剧情；未结束的战斗留待下次开团。'] : []),
      status === 'completed'
        ? '战斗已结束。机械结算已经实时写入同一份团档，禁止重复扣血、扣资源、掷骰或再发奖励。只接续战后剧情，没确认的战利品按模组查证。'
        : `战斗代理已停止${run.error ? `（原因：${run.error}；此原因仅供 DM 知悉，勿把原始报错 JSON 发进群）` : ''}。先核对最新团况与待结算窗口，不能重做已落账行动，也不能当作战斗已结束。`,
      ...(outcomeBlock !== undefined ? [outcomeBlock] : []),
      found
        ? `【战前→战后队伍变化】\n${formatPartyDelta(run.before, found.campaign)}\n最新团况：\n${summarize(found.campaign, found.adventure)}${newChronicle ? `\n新增账本：\n${newChronicle}` : ''}`
        : `交接前队伍：${run.before}\n团档不可用，必须先核实，不能推断结局。`,
      ...(unreportedBlock !== undefined ? [unreportedBlock] : []),
      `战斗代理最后已发到群里的叙述${run.lastNarrationRound !== undefined ? `（第 ${run.lastNarrationRound} 轮）` : ''}（已播报内容不必复述；叙述不覆盖团档）：${run.lastNarration ?? '无'}`,
      '怪物 AC、HP、DC 和 DM 机密仍不进群消息；不要替玩家选择下一步。',
    ].join('\n');
    this.checkpoint(run);
    this.active.delete(run.sessionKey);
    if (status === 'failed') this.failed.add(run.sessionKey);
    else this.failed.delete(run.sessionKey);
    this.syncTools(main);
    // 先释放子级，保证主模型醒来时再没有另一个 DM 可修改团档。
    await active.child.handle.dispose().catch(() => {});
    if (!this.disposed) {
      main.replyTarget = active.child.replyTarget;
      this.settling.set(main.sessionId, run);
      main.agent.followup(createUserMessage({ content: [{ type: 'text', text: run.handoff }], source: { kind: 'user' } }));
    }
    this.logger.info(`im-qqbot: 战斗代理交回 key=${run.sessionKey} status=${status}${run.error ? ` reason=${run.error}` : ''} ${Object.entries(run.usage).map(([k, u]) => rowUsage(k, u)).join(' | ')}`);
  }

  public report(key: string): string {
    const run = this.active.get(key)?.run ?? [...this.settling.values()].find((r) => r.sessionKey === key) ?? this.load(key);
    if (!run) return '还没有战斗代理记录。启用后，开战后的下一次玩家消息或回合按钮会交给战斗模型。';
    return [`战斗代理：${run.status}｜${run.provider}/${run.model}`,
      ...(run.fallbackFrom ? [`已回退自：${run.fallbackFrom}`] : []),
      ...(run.error ? [`失败原因：${run.error}`] : []),
      `记录：${run.id.slice(0, 8)}｜子会话 ${run.childSessionId.slice(0, 8)}`,
      ...Object.entries(run.usage).map(([label, usage]) => rowUsage(label, usage)),
      '包含战斗代理与战后主 DM 交接回复；不含开战前主会话，缓存单列，金额按渠道账单计算。',
    ].join('\n');
  }

  public release(key: string): Promise<void> | undefined {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    const active = this.active.get(key);
    this.active.delete(key);
    this.failed.delete(key);
    if (!active) return;
    this.syncTools(active.main);
    active.run.status = 'interrupted'; active.run.endedAt = Date.now(); this.checkpoint(active.run);
    active.child.agent.cancel({ kind: 'user' });
    return active.child.handle.dispose().catch(() => {});
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.locks.values()]);
    const active = [...this.active.values()];
    this.active.clear();
    for (const a of active) { this.checkpoint(a.run); a.child.agent.cancel({ kind: 'user' }); }
    await Promise.allSettled(active.map((a) => a.child.handle.dispose()));
  }
}
