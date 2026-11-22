/**
 * 上游健康监测（opencode / commandcode 主备自动故障转移与恢复）
 */
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { ModelWatch, isWatchedProvider } from '../model/status-watch.ts';

export interface StartModelWatchDeps {
  bot: QQBot;
  config: ImQQBotConfig;
  manager: SessionManager;
  logger: Logger;
}

/** 启动上游健康监测；未启用或配置不全时清理磁盘残留 failover 路由 */
export function startModelWatch(deps: StartModelWatchDeps): ModelWatch | undefined {
  const { bot, config, manager, logger } = deps;
  const failover = config.modelFailover;
  let modelWatch: ModelWatch | undefined;

  if (failover?.enabled === true) {
    const primary = {
      provider: failover.primaryProvider.trim() === '' ? (config.provider ?? '') : failover.primaryProvider.trim(),
      model: failover.primaryModel.trim() === '' ? (config.model ?? '') : failover.primaryModel.trim(),
      apiKeyEnv: failover.primaryApiKeyEnv.trim() || undefined,
    };
    const backup = {
      provider: failover.backupProvider.trim(),
      model: failover.backupModel.trim(),
      apiKeyEnv: failover.backupApiKeyEnv.trim() || undefined,
    };
    const ready = primary.provider !== '' && primary.model !== '' && backup.provider !== '' && backup.model !== '';
    if (ready && isWatchedProvider(primary.provider) && isWatchedProvider(backup.provider)) {
      const notify = async (line: string): Promise<void> => {
        if (!failover.notify) return;
        const owner = config.ownerOpenid?.trim();
        if (owner === undefined || owner === '') return;
        try {
          await bot.sendMarkdown({ scope: 'c2c', targetId: owner }, line);
        } catch (err) {
          logger.warn(`model-watch: 通知失败 ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      modelWatch = new ModelWatch({
        primary,
        backup,
        intervalMs: Math.max(1, failover.intervalMinutes) * 60_000,
        failThreshold: Math.max(1, failover.failThreshold),
        recoverThreshold: Math.max(1, failover.recoverThreshold),
        ttftThresholdMs: Math.max(1000, failover.ttftThresholdMs),
        initialUsingBackup: manager.getFailoverRoute() !== undefined,
        immediate: true,
        switchTo: async (target, health) => {
          const count = await manager.switchAllSessions(target);
          await notify(`⚠️ ${health.detail}\n已把 ${count} 个会话切到 ${target.provider}/${target.model}`);
        },
        switchBack: async (_target, health) => {
          // 切回默认：清掉全局故障转移那一格，而不是再写一遍 override。
          // 写 override 的问题是它会永久压住配置默认，下次再切又要追平一次。
          const count = await manager.clearFailoverRoute();
          await notify(`✅ ${health.detail}\n已把 ${count} 个会话切回配置默认`);
        },
        log: (message) => logger.info(`im-qqbot: ${message}`),
      });
      modelWatch.start();
    } else if (ready) {
      logger.warn(`model-watch: ${primary.provider} 或 ${backup.provider} 不在可监测名单（opencode / commandcode），跳过`);
    } else {
      logger.warn('model-watch: 主用或备用的 provider/model 没配全，跳过');
    }
  }

  if (modelWatch === undefined && manager.getFailoverRoute() !== undefined) {
    void manager.clearFailoverRoute()
      .then((count) => logger.info(`im-qqbot: model-watch 未运行，已自动清理磁盘残留故障转移路由（切回默认会话=${count}）`))
      .catch((err: unknown) => logger.warn(`im-qqbot: 清理残留故障转移路由失败: ${String(err)}`));
  }

  return modelWatch;
}
