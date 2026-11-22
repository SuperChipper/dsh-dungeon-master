/**
 * L0 按会话/宿主作用域自动隐藏确定不可用的工具。
 *
 * 与 `tools.guard`（运行期兜底拦截）及 `DndToolScope`（跑团作用域）正交叠加：
 * 在单个 agent 作用域内通过 `tools.restrict({ deny })` 隐藏该作用域下必然不可用的工具，
 * 既减少无用 schema token 占用、避免模型误调报错，又完全不改全局工具名与提示词前缀；
 * 若当前集合与上次一致则直接跳过，保持 prompt prefix cache 稳定。
 */
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope, Logger } from '../types.ts';
import { AGENT_TOOLS, SHELL_TOOLS, type ToolGuardSession } from '../shared/tool-guard.ts';
import { biliPermission } from '../bili/permissions.ts';
import { canUseImageGen, groupOnList } from './group-access-policy.ts';

/** 强依赖 QQ 会话上下文的工具（无 QQ SessionRecord 时必然报错），对非 QQ agent（Web/Desktop）隐藏 */
export const NON_QQ_ONLY_TOOLS: readonly string[] = [
  'qqbot_browser',
];

/** 仅限特权用户私聊扫码登录的工具 */
export const BILI_LOGIN_TOOLS: readonly string[] = ['qqbot_bili_auth'];

export type SessionToolScopeConfig = Pick<
  ImQQBotConfig,
  'ownerOpenid' | 'adminOpenids' | 'toolAccess' | 'browser' | 'imageGen'
>;

export interface SessionScopeSnapshot {
  scope: ChatScope;
  peerId: string;
  senderId?: string;
}

/** 根据运行时同一套鉴权规则，计算指定 QQ 会话确定不可用的工具名列表（确定性升序） */
export function computeSessionDeniedTools(
  session: SessionScopeSnapshot,
  config: SessionToolScopeConfig,
  isFullAccess: (session: ToolGuardSession) => boolean,
): string[] {
  const denied = new Set<string>();
  const peerSession: ToolGuardSession = { scope: session.scope, peerId: session.peerId };

  if (!isFullAccess(peerSession)) {
    for (const name of SHELL_TOOLS) denied.add(name);
    for (const name of AGENT_TOOLS) denied.add(name);
  }

  const owner = config.ownerOpenid?.trim() ?? '';
  const isOwnerC2c = owner !== '' && session.scope === 'c2c' && session.peerId === owner;
  const isOwnerStrict = isOwnerC2c && (session.senderId === undefined || session.senderId === owner);

  if (!isOwnerC2c) {
    denied.add('qqbot_notes_manage');
  }

  if (!biliPermission(peerSession, 'login', config as ImQQBotConfig).allowed) {
    for (const name of BILI_LOGIN_TOOLS) denied.add(name);
  }

  const canBrowse = isOwnerStrict || (session.scope === 'group' && groupOnList(session.peerId, config.browser?.allowedGroups));
  if (!canBrowse) {
    denied.add('qqbot_browser');
  }

  if (!canUseImageGen(peerSession, config as Pick<ImQQBotConfig, 'imageGen'>, isFullAccess)) {
    denied.add('qqbot_image_gen');
  }

  return [...denied].sort();
}

export interface ScopedTools {
  restrict?(filter: { deny: readonly string[] }): () => void;
  view?(scope?: unknown): { restrictableNames?: ReadonlySet<string> } | undefined;
  definitions?(scope?: unknown): readonly { name: string }[];
  get?(name: string, scope?: unknown): unknown;
}

export interface ScopedAgent {
  ctx: { get(name: string): unknown };
}

/** 找出 agent.ctx 上的 dsh.scope key，确保 tools.view(scope) 与 tools.restrict() 使用完全一致的作用域键 */
function getScopeKey(ctx: object): unknown {
  for (let cur: object | null = ctx; cur !== null; cur = Object.getPrototypeOf(cur)) {
    for (const sym of Object.getOwnPropertySymbols(cur)) {
      if (sym.description === 'dsh.scope') return (ctx as Record<symbol, unknown>)[sym];
    }
  }
  return undefined;
}

/**
 * dsh-tools 的 restrict() 会校验 deny 里每个名字都已全局注册（未知或未启用的工具会抛错，
 * 例如未启用 browser 时的 qqbot_browser 或非 Linux 上的 bash）。这里先按当前全局可限制工具过滤。
 */
export function filterRestrictable(
  candidates: readonly string[],
  tools: ScopedTools,
  agent: ScopedAgent,
): string[] {
  const unique = [...new Set(candidates)];
  const scopeKey = getScopeKey(agent.ctx);
  const restrictable = tools.view?.(scopeKey ?? agent)?.restrictableNames;
  if (restrictable !== undefined && typeof restrictable.has === 'function') {
    return unique.filter((name) => restrictable.has(name)).sort();
  }
  if (typeof tools.definitions === 'function') {
    const known = new Set(tools.definitions().map((def) => def.name));
    return unique.filter((name) => known.has(name)).sort();
  }
  if (typeof tools.get === 'function') {
    return unique.filter((name) => tools.get!(name) !== undefined).sort();
  }
  return unique.sort();
}

export interface SessionToolScopeDeps {
  config: SessionToolScopeConfig;
  isFullAccess(session: ToolGuardSession): boolean;
  isCombatAgent?(agent: ScopedAgent): boolean;
  logger: Logger;
}

export interface SessionScopeRecord {
  sessionKey: string;
  scope: ChatScope;
  peerId: string;
  senderId?: string;
  agent: ScopedAgent;
}

export class SessionToolScope {
  /** agent → 已生效的规范化拒绝集键值与撤销函数；agent 销毁时 release，插件卸载时 disposeAll */
  private readonly applied = new Map<object, { denyKey: string; lift?: () => void }>();

  public constructor(private readonly deps: SessionToolScopeDeps) {}

  /**
   * 宿主新建 agent（或插件加载时已存在的非 QQ agent）先隐藏强绑定 QQ 会话的工具；
   * 若随后确认属于 QQ 会话，sync(record) 会替换为该会话自己的精确集合。
   * 挂在 agent/created 上时绝不能抛错，否则会否决 agent 创建。
   */
  public hideForNonQq(agent: ScopedAgent): void {
    if (this.applied.has(agent) || this.deps.isCombatAgent?.(agent) === true) return;
    try {
      const tools = agent.ctx.get('tools') as ScopedTools | undefined;
      if (tools?.restrict === undefined) return;
      const deny = filterRestrictable(NON_QQ_ONLY_TOOLS, tools, agent);
      if (deny.length === 0) {
        this.applied.set(agent, { denyKey: '' });
        return;
      }
      const lift = tools.restrict({ deny });
      this.applied.set(agent, { denyKey: deny.join('\0'), lift });
    } catch (err) {
      this.deps.logger.debug(
        `im-qqbot: 会话初始工具隐藏跳过: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 将 QQ 会话的可见工具集同步到当前权限状态；拒绝集未变化时什么都不做以保住提示词缓存 */
  public sync(record: SessionScopeRecord): void {
    if (this.deps.isCombatAgent?.(record.agent) === true) return;

    let tools: ScopedTools | undefined;
    try {
      tools = record.agent.ctx.get('tools') as ScopedTools | undefined;
    } catch (err) {
      this.deps.logger.warn(`im-qqbot: 无法读取会话工具服务: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const candidates = computeSessionDeniedTools(record, this.deps.config, this.deps.isFullAccess);
    const deny = tools !== undefined ? filterRestrictable(candidates, tools, record.agent) : [...candidates];
    const denyKey = deny.join('\0');
    const previous = this.applied.get(record.agent);
    if (previous?.denyKey === denyKey) return;

    let lift: (() => void) | undefined;
    try {
      // 先装新限制再撤旧限制：中间不会出现受限工具短暂暴露的窗口
      if (deny.length > 0) {
        if (tools?.restrict === undefined) throw new Error('tools.restrict 不可用');
        lift = tools.restrict({ deny });
      }
      previous?.lift?.();
    } catch (err) {
      try { lift?.(); } catch { /* ignore rollback error */ }
      this.deps.logger.warn(
        `im-qqbot: 会话工具可见范围更新失败 key=${record.sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    this.applied.set(record.agent, { denyKey, lift });
    this.deps.logger.info(
      `im-qqbot: 会话工具可见范围 key=${record.sessionKey} 隐藏 ${deny.length} 个${deny.length > 0 ? ` (${deny.join(',')})` : ''}`,
    );
  }

  /** agent 已销毁：限制随它的作用域释放，这里仅清理跟踪记录 */
  public release(agent: object): void {
    this.applied.delete(agent);
  }

  /** 插件卸载：撤掉所有挂在存活 agent 上的限制，避免重载后残留 */
  public disposeAll(): void {
    for (const entry of this.applied.values()) {
      try {
        entry.lift?.();
      } catch {
        // agent 可能已在销毁途中
      }
    }
    this.applied.clear();
  }
}
