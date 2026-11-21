/**
 * 自检命令：/bot-doctor（别名 /doctor，仅 owner/admin）
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer, isPrivilegedSender } from '../shared/index.ts';
import { renderBotDoctorReport, runBotDoctor } from '../features/bot-doctor.ts';

export function doctorCommand({ manager, config }: CommandDeps): CategorizedCommand {
  return {
    name: ['bot-doctor', 'doctor'],
    category: 'qqbot',
    description: '自检人设、触发门控、模型路由、压缩锁与外部服务状态',
    authorized: (ctx) => isPrivilegedSender(ctx.message.senderId, config)
      || '⚠️ 只有 bot 主人或管理员可以运行自检。',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const report = await runBotDoctor({ manager, config, scope, peerId });
      return renderBotDoctorReport(report);
    },
  };
}
