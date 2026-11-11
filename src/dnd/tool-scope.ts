/**
 * 按团的状态决定一个 QQ 会话看得到哪些 dnd_* 工具。
 *
 * 为什么要它：19 个跑团工具的说明加参数约 4 万字符，全局注册后每个会话的每次请求都带着，
 * 没开团的群和私聊白白多出一万 token 上下。工具仍然全局注册一次，这里只用宿主的
 * `tools.restrict({ deny })` 在单个 agent 的作用域里把用不上的藏起来：
 *   - 没有团档：全部藏起来（开团靠 /dnd start 命令，不靠工具）；
 *   - 停团中：只留查账本、备团、补写交接这几个（PAUSED_RULES 里提到的）；
 *   - 团在进行：全部可见。
 *
 * 用「藏」而不是「按会话注册」：restrict 失败时工具照旧全部可见，等于回到原来的行为；
 * 按会话注册一旦失败，团就没工具可用了。
 *
 * 不是 QQ 会话的 agent（Web/Desktop、子 agent）也一律藏起来：dnd_* 只认 QQ 会话，它们本来就调不了。
 * 做法是每个 agent 一出现先全藏（hideAll），QQ 会话建好记录后再按团的状态放开（sync）。
 *
 * 限制挂在 agent 自己的作用域上，插件卸载时不会跟着消失：宿主里还活着的 agent（Web 里开着的会话）
 * 会带着旧限制进下一次加载，新实例撤不掉它，开团后工具就一直被藏着。所以卸载时必须 disposeAll。
 */
import type { Logger } from '../types.ts';

export type DndToolLevel = 'none' | 'paused' | 'active';

/** 停团期间仍然用得上的工具：都是 active ?? saved 两种团档都认的 */
export const PAUSED_DND_TOOLS: readonly string[] = ['dnd_chronicle', 'dnd_prepare', 'dnd_end', 'dnd_lookup'];

/** 这个状态下该藏起来的工具 */
export function hiddenDndTools(level: DndToolLevel, all: readonly string[]): string[] {
  if (level === 'active') return [];
  if (level === 'none') return [...all];
  return all.filter((name) => !PAUSED_DND_TOOLS.includes(name));
}

/** 宿主 tools 服务里用到的部分；从 agent.ctx 取到的那份只作用于这个 agent */
interface ScopedTools {
  restrict?(filter: { deny: readonly string[] }): () => void;
}

interface ScopedAgent {
  ctx: { get(name: string): unknown };
}

interface CampaignState {
  active(key: string): unknown;
  saved(key: string): unknown;
}

export class DndToolScope {
  /** agent → 当前生效的状态和撤销函数；agent 销毁时 release，插件卸载时 disposeAll */
  private readonly applied = new Map<object, { level: DndToolLevel; lift?: () => void }>();

  public constructor(
    private readonly service: CampaignState,
    private readonly toolNames: readonly string[],
    private readonly logger: Logger,
  ) {}

  public levelOf(sessionKey: string): DndToolLevel {
    if (this.service.active(sessionKey) !== undefined) return 'active';
    return this.service.saved(sessionKey) !== undefined ? 'paused' : 'none';
  }

  /**
   * agent 刚出现时先把跑团工具全藏起来；已经处理过的不动。
   * 挂在宿主的 agent/created 上，那里同步抛错会否决 agent 的创建，所以这里绝不能抛。
   */
  public hideAll(agent: ScopedAgent): void {
    if (this.applied.has(agent)) return;
    try {
      const tools = agent.ctx.get('tools') as ScopedTools | undefined;
      if (tools?.restrict === undefined) return;
      this.applied.set(agent, { level: 'none', lift: tools.restrict({ deny: this.toolNames }) });
    } catch (err) {
      this.logger.debug(`im-qqbot: 跑团工具没能对新 agent 隐藏: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** agent 已销毁：限制随它的作用域一起没了，这里只丢掉记录 */
  public release(agent: object): void {
    this.applied.delete(agent);
  }

  /** 插件卸载：撤掉所有还挂着的限制，不留给下一次加载 */
  public disposeAll(): void {
    for (const entry of this.applied.values()) {
      try {
        entry.lift?.();
      } catch {
        // agent 可能已经在销毁途中
      }
    }
    this.applied.clear();
  }

  /** 让这个会话的可见工具跟上团的状态；状态没变时什么都不做（工具列表一变提示缓存就失效） */
  public sync(record: { sessionKey: string; agent: ScopedAgent }): void {
    const level = this.levelOf(record.sessionKey);
    const previous = this.applied.get(record.agent);
    if (previous?.level === level) return;

    const deny = hiddenDndTools(level, this.toolNames);
    let lift: (() => void) | undefined;
    try {
      // 先装新的再撤旧的：中间不会出现「全部可见」的一瞬
      if (deny.length > 0) {
        const tools = record.agent.ctx.get('tools') as ScopedTools | undefined;
        if (tools?.restrict === undefined) throw new Error('tools.restrict 不可用');
        lift = tools.restrict({ deny });
      }
      previous?.lift?.();
    } catch (err) {
      // 藏不起来就全部可见，和没有这个功能时一样
      this.logger.warn(`im-qqbot: 跑团工具可见范围没能更新 key=${record.sessionKey} level=${level}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.applied.set(record.agent, { level, ...(lift !== undefined ? { lift } : {}) });
    this.logger.info(`im-qqbot: 跑团工具可见范围 key=${record.sessionKey} ${previous?.level ?? '(新会话)'} → ${level}（隐藏 ${deny.length} 个）`);
  }
}
