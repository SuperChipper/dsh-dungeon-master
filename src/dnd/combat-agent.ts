import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { DndCombatAgentConfig } from '../config.ts';
import type { DshAgent, DshAgentHandle, DshAgentRegistry, SessionEventLike, SessionRecord } from '../session/types.ts';
import type { Logger } from '../types.ts';
import { GROUP_MESSAGE_FORMAT_PROMPT } from '../features/message-format.ts';
import { summarize, type Campaign } from './campaign.ts';
import type { DndService } from './dnd-service.ts';
import { combatPartyContext } from './combat-context.ts';
import type { DndToolView } from './tool-views.ts';

/** 不继承终端、文件、任意委派或剧情推进能力，群权限不因战斗委派扩大。 */
export const COMBAT_TOOLS = [
  'dnd_roll', 'dnd_check', 'dnd_apply', 'dnd_initiative', 'dnd_position', 'dnd_move',
  'dnd_lookup', 'dnd_srd', 'dnd_resource', 'dnd_character', 'dnd_undo', 'dnd_chronicle', 'dnd_end',
] as const;

interface Usage {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

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
  handoff?: string;
  usage: Record<string, Usage>;
  lastSeq: Record<string, number>;
}

interface ActiveCombat {
  main: SessionRecord;
  child: SessionRecord;
  run: CombatRun;
}

function eventsOf(agent: DshAgent): readonly SessionEventLike[] {
  return agent.session.snapshotEvents?.() ?? agent.session.events ?? [];
}

/** 只取实际对话，排除旧团况、工具结果和推理；固定在子会话前缀中以便命中缓存。 */
export function recentCombatDialogue(agent: DshAgent, maxChars: number): string {
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
    const text = message.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
    if (!text) continue;
    lines.unshift(`${event.type === 'user/message' ? '玩家' : '主 DM'}：${text.slice(-left)}`);
    left -= text.length;
    if (left <= 0) break;
  }
  return lines.join('\n');
}

function partyState(c: Campaign): string {
  return JSON.stringify(c.characters.filter((ch) => ch.kind !== 'monster').map((ch) => ({
    name: ch.name, hp: ch.hp, maxHp: ch.maxHp, tempHp: ch.tempHp,
    conditions: ch.conditions, resources: ch.resources, notes: ch.notes,
    inventory: ch.inventory, gp: ch.gp, room: ch.room,
  })));
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

  public constructor(
    private readonly agents: DshAgentRegistry,
    private readonly service: DndService,
    private readonly settings: () => DndCombatAgentConfig | undefined,
    private readonly syncTools: (record: SessionRecord) => void,
    private readonly logger: Logger,
    private readonly directory = join(service.store.root, '..', 'combat-runs'),
  ) {}

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
      target.agent.followup(createUserMessage({ content: [{ type: 'text', text: `[系统 · 战斗接管] 主 DM 已掷先攻并叙述开场。缺少场地图/站位时先按下列场地准备，不重掷先攻；随后只结算当前怪物回合，轮到 PC 或有反应就停。\n${field}` }], source: { kind: 'user' } }));
      await target.agent.whenIdle();
      return target;
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
        if (existing.child.agent.status !== 'idle') return existing.child;
        existing.child.replyTarget = main.replyTarget;
        existing.child.lastActivity = main.lastActivity;
        existing.child.recentSenders = main.recentSenders;
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
      let run = this.load(main.sessionKey);
      const restore = run?.status === 'active' && run.mainSessionId === main.sessionId && run.campaignCreatedAt === found.campaign.createdAt;
      if (!restore || run === undefined) {
        const rulings = (found.campaign.chronicle ?? []).filter((e) => e.kind === 'ruling').map((e) => `#${e.id} ${e.text}`).join('\n');
        run = {
          version: 1, id: randomUUID(), sessionKey: main.sessionKey, mainSessionId: main.sessionId,
          childSessionId: randomUUID(), campaignCreatedAt: found.campaign.createdAt, startedAt: Date.now(), status: 'active', provider, model,
          reasoningEffort: config.reasoningEffort.trim() || undefined,
          prompt: ['【开战交接 · 仅供裁定，不要转发】', `本桌已记录约定：\n${rulings || '无；不要自行补充。'}`,
            combatPartyContext(found.campaign),
            '最近主会话（仅是对话材料；旧状态以最新团况覆盖，不把提议当成已执行）：', recentCombatDialogue(main.agent, config.contextChars),
          ].join('\n\n'),
          before: partyState(found.campaign), chronicleId: found.campaign.chronicle?.at(-1)?.id ?? 0, usage: {}, lastSeq: {},
        };
      }
      let handle: DshAgentHandle | undefined;
      try {
        const setup = (scope: Context): void => {
          const tools = scope.get('tools') as { restrict?: (filter: { allow: readonly string[] }) => unknown; guard?: (guard: (exec: { name: string; arguments?: unknown }) => string | undefined) => unknown } | undefined;
          const prompt = scope.get('systemPrompt') as {
            section?: (section: { name: string; order: number; text: string; complete: boolean; interpolate: boolean }) => unknown;
          } | undefined;
          if (!tools?.restrict || !tools.guard || !prompt?.section) throw new Error('宿主不支持战斗代理的工具隔离或完整提示词');
          tools.restrict({ allow: COMBAT_TOOLS });
          tools.guard((exec) => {
            if (!COMBAT_TOOLS.includes(exec.name as typeof COMBAT_TOOLS[number])) return '战斗代理只能使用授权的跑团工具';
            if (!this.service.active(main.sessionKey)?.campaign.initiative) return '战斗已结束或暂停，等待主 DM 接手，不再执行战斗操作';
            if (exec.name === 'dnd_initiative' && (exec.arguments as { action?: string })?.action === 'start') return '这场战斗已有先攻表，不可重开战斗';
            return undefined;
          });
          // runtime-context 每次团况变化都会重发整份快照，固定交接放在稳定前缀里，避免每次重复几千 token。
          // 交接含玩家原话，不作模板插值；{{...}} 保持字面文本。
          prompt.section({
            name: 'qqbot:combat-agent', order: 0, complete: true, interpolate: false,
            text: `${this.service.combatInstructions()}\n${GROUP_MESSAGE_FORMAT_PROMPT}\n\n${run!.prompt}`,
          });
        };
        const options = { agentOptions: { provider: run.provider, model: run.model, reasoningEffort: run.reasoningEffort }, setup };
        handle = restore
          ? await this.agents.resume({ resumeSessionId: run.childSessionId, ...options })
          : await this.agents.create({ sessionId: run.childSessionId, meta: { parentSession: main.sessionId, cwd: main.agent.session.header?.cwd ?? process.cwd() }, ...options });
        if (this.disposed || generation !== (this.generations.get(main.sessionKey) ?? 0)) { await handle.dispose(); return main; }
        const child: SessionRecord = { ...main, sessionId: run.childSessionId, agent: handle.agent, handle, agentPreset: undefined, contextTokens: undefined };
        this.active.set(main.sessionKey, { main, child, run });
        this.syncTools(main);
        this.syncTools(child);
        this.save(run);
        this.logger.info(`im-qqbot: 战斗代理${restore ? '恢复' : '接管'} key=${main.sessionKey} child=${child.sessionId} model=${run.provider}/${run.model}`);
        return child;
      } catch (err) {
        this.active.delete(main.sessionKey);
        await handle?.dispose().catch(() => {});
        this.failed.add(main.sessionKey);
        this.syncTools(main);
        run.status = 'failed'; run.endedAt = Date.now();
        this.checkpoint(run);
        this.logger.warn(`im-qqbot: 战斗代理不可用，主 DM 继续 key=${main.sessionKey}: ${String(err)}`);
        return main;
      }
    });
  }

  /** 出站已按同一 SessionRecord 发到群；这里只记账并在安全的 idle 边界交回主 DM。 */
  public observe(record: SessionRecord, event: { type: string; seq?: number; data: Record<string, unknown> }): void {
    const active = this.active.get(record.sessionKey);
    const settling = this.settling.get(record.sessionId);
    const run = active?.run ?? settling;
    if (!run) return;
    if (event.seq !== undefined) {
      if ((run.lastSeq[record.sessionId] ?? -1) >= event.seq) return;
      run.lastSeq[record.sessionId] = event.seq;
    }
    if (event.type === 'assistant/message') {
      const data = event.data as { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }; message?: { source?: { provider?: string; model?: string }; content?: Array<{ type: string; text?: string }> } };
      const usage = data.usage;
      const lane = record.sessionId === run.childSessionId ? 'combat' : 'main';
      const source = data.message?.source;
      const key = `${lane}:${source?.provider ?? '?'}/${source?.model ?? '?'}`;
      if (usage) {
        const u = run.usage[key] ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        u.requests++; u.input += usage.inputTokens ?? 0; u.output += usage.outputTokens ?? 0;
        u.cacheRead += usage.cacheReadTokens ?? 0; u.cacheWrite += usage.cacheWriteTokens ?? 0;
      }
      if (lane === 'combat') {
        const text = data.message?.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
        if (text && text !== '。') run.lastNarration = text.slice(-2000);
      }
      this.checkpoint(run);
    }
    if (event.type === 'turn/end' && settling) { this.settling.delete(record.sessionId); this.checkpoint(settling); }
    if (event.type === 'turn/end' && active && record.agent === active.child.agent) {
      const reason = event.data.reason as { kind?: string } | undefined;
      void record.agent.whenIdle().then(() => this.serial(record.sessionKey, async () => {
        if (this.disposed || this.active.get(record.sessionKey) !== active) return;
        const found = this.service.active(record.sessionKey);
        if (reason?.kind === 'error' || reason?.kind === 'failed') await this.finish(active, 'failed');
        else if (!found) await this.finish(active, 'paused');
        else if (!found.campaign.initiative) await this.finish(active, 'completed');
      })).catch((err: unknown) => this.logger.warn(`im-qqbot: 战斗交接失败: ${String(err)}`));
    }
  }

  private async finish(active: ActiveCombat, status: CombatRun['status']): Promise<void> {
    if (active.child.agent.status !== 'idle') return;
    const { run, main } = active;
    const found = this.service.active(run.sessionKey) ?? this.service.saved(run.sessionKey);
    run.status = status; run.endedAt = Date.now();
    run.handoff = [
      '【系统 · 战斗代理交回 · DM 私有】',
      ...(status === 'paused' ? ['团已暂停。只确认保存，不推进回合或剧情；未结束的战斗留待下次开团。'] : []),
      status === 'completed' ? '战斗已结束。机械结算已经实时写入同一份团档，禁止重复扣血、扣资源、掷骰或再发奖励。只接续战后剧情，没确认的战利品按模组查证。' : '战斗代理已停止。先核对最新团况与待结算窗口，不能重做已落账行动，也不能当作战斗已结束。',
      `交接前队伍：${run.before}`,
      found ? `最新团况：\n${summarize(found.campaign, found.adventure)}\n最新队伍明细：${partyState(found.campaign)}\n新增账本：\n${(found.campaign.chronicle ?? []).filter((e) => e.id > run.chronicleId).map((e) => e.text).join('\n')}` : '团档不可用，必须先核实，不能推断结局。',
      `战斗代理最后已发到群里的叙述（不必复述；叙述不覆盖团档）：${run.lastNarration ?? '无'}`,
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
    this.logger.info(`im-qqbot: 战斗代理交回 key=${run.sessionKey} status=${status} ${Object.entries(run.usage).map(([k, u]) => rowUsage(k, u)).join(' | ')}`);
  }

  public report(key: string): string {
    const run = this.active.get(key)?.run ?? [...this.settling.values()].find((r) => r.sessionKey === key) ?? this.load(key);
    if (!run) return '还没有战斗代理记录。启用后，开战后的下一次玩家消息或回合按钮会交给战斗模型。';
    return [`战斗代理：${run.status}｜${run.provider}/${run.model}`,
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
