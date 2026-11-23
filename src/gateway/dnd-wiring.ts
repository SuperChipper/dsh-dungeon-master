/**
 * 跑团网关装配：dnd_* 工具注册、独立战斗子代理路由、按团作用域隐藏工具
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.ts';
import { onHostAgentLifecycle } from '../host-adapter/index.ts';
import type { DshAgent, DshAgentRegistry, SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { getSenderAliases, memberIdsFor } from '../features/sender-alias.ts';
import type { MediaSenderLike } from '../media/send-file-tool.ts';
import { withFreshReplyTarget } from '../media/send-file-tool.ts';
import type { DndService } from '../dnd/dnd-service.ts';
import { registerDndTools } from '../dnd/dnd-tools.ts';
import { DndCombatAgents } from '../dnd/combat-agent.ts';
import { DndToolScope } from '../dnd/tool-scope.ts';
import type { DndTurnButtons } from '../dnd/turn-buttons.ts';

export interface WireDndToolsDeps {
  ctx: Context;
  agents: DshAgentRegistry;
  config: ImQQBotConfig;
  manager: SessionManager;
  dndService: DndService;
  dndButtons?: DndTurnButtons;
  mediaSender: MediaSenderLike;
  logger: Logger;
}

/** 注册 dnd_* 工具并挂接战斗子代理与按团可见性过滤 */
export function wireDndTools(deps: WireDndToolsDeps): void {
  const { ctx, agents, config, manager, dndService, dndButtons, mediaSender, logger } = deps;

  // /dnd map 发的是被动回复：target 就是那条 /dnd 消息，不用换新的 msgId
  dndService.sendImage = async (target, path, caption) => {
    await mediaSender.sendImage(target, { localPath: path }, caption !== undefined ? { content: caption } : undefined);
  };

  const dndToolNames = registerDndTools(ctx, {
    service: dndService,
    manager,
    logger,
    sendImage: async (record, path, caption) => {
      await mediaSender.sendImage(
        withFreshReplyTarget(record.replyTarget),
        { localPath: path },
        caption !== undefined ? { content: caption } : undefined,
      );
    },
    onTurnChange: (record) => dndButtons?.schedule(record),
    onCombatStart: (record, field) => {
      const starting = manager.combatAgents?.startAfterReply(record, field);
      if (starting === undefined) return false;
      void starting.then((child) => { if (child !== undefined) dndButtons?.schedule(child); })
        .catch((err: unknown) => logger.warn(`im-qqbot: 自动战斗交接失败: ${String(err)}`));
      return true;
    },
    onPendingAttack: (record) => dndButtons?.scheduleReaction(record),
    members: memberIdsFor(getSenderAliases(), config.appId),
  });

  // 没开团的会话不带跑团工具：开团、停团时跟着换
  if (dndToolNames.length === 0) return;

  const toolScope = new DndToolScope(dndService, dndToolNames, logger, (record) => manager.combatAgents?.toolView(record) ?? 'full');
  manager.dndToolScope = toolScope;
  manager.combatAgents = new DndCombatAgents(
    agents, dndService, () => config.dnd?.combatAgent,
    (record) => toolScope.sync(record), logger, undefined,
    (main) => {
      const mainRoute = manager.getEffectiveSessionRoute(main);
      const fo = config.modelFailover;
      if (!fo?.enabled) return mainRoute ? { mainRoute } : undefined;
      const cur = config.dnd?.combatAgent;
      const pProv = fo.primaryProvider.trim() || (config.provider ?? '').trim();
      const pMod = fo.primaryModel.trim() || (config.model ?? '').trim();
      const bProv = fo.backupProvider.trim();
      const bMod = fo.backupModel.trim();
      const activeFailover = cur?.provider.trim() === pProv ? manager.getFailoverRoute() : undefined;
      const isBackupConfiguredAsPrimary = cur?.provider.trim() === bProv && cur?.model.trim() === bMod;
      const cand = isBackupConfiguredAsPrimary
        ? (pProv && pMod ? { provider: pProv, model: pMod } : undefined)
        : (bProv && bMod ? { provider: bProv, model: bMod } : undefined);
      const backup = cand && (cand.provider !== cur?.provider.trim() || cand.model !== cur?.model.trim())
        ? cand
        : undefined;
      return { activeFailover, backup, mainRoute };
    },
    () => config.dnd?.snapshotIntervalTurns ?? 4,
  );
  manager.combatAgents.installCompactionGuard(ctx);
  dndService.onStateChange = (key) => manager.syncDndTools(key);

  // 不是 QQ 会话的 agent 也不带跑团工具：每个 agent 出现时先全藏，QQ 会话建好记录后再按团的状态放开。
  onHostAgentLifecycle<DshAgent>(ctx, 'agent/created', ({ agent }) => { if (agent !== undefined) toolScope.hideAll(agent); });
  onHostAgentLifecycle<DshAgent>(ctx, 'agent/disposed', ({ agent }) => { if (agent !== undefined) toolScope.release(agent); });

  // 插件加载前就活着的 agent 收不到 created
  try {
    for (const agent of (agents as { list?(): DshAgent[] }).list?.() ?? []) toolScope.hideAll(agent);
  } catch (err) {
    logger.debug(`im-qqbot: 列不出现有 agent，跑团工具只对之后新建的隐藏: ${err instanceof Error ? err.message : String(err)}`);
  }
}
