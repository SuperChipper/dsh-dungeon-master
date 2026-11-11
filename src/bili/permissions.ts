import type { ImQQBotConfig } from '../config.ts';
import { isPrivilegedSender, privilegedOpenids } from '../shared/permissions.ts';

interface BiliChat {
  scope: string;
  peerId: string;
}

/** 字幕只读可共享；更换本机登录账号仍限主人/管理员私聊。 */
export function biliPermission(
  record: BiliChat | undefined,
  kind: 'login' | 'subtitle',
  config: ImQQBotConfig,
): { allowed: boolean; reason?: string } {
  if (kind === 'subtitle' || record === undefined) return { allowed: true };
  if (record.scope !== 'c2c') {
    return { allowed: false, reason: '扫码登录只能在主人或管理员私聊里做；群聊可以读取视频字幕，但不能更换登录账号' };
  }
  if (privilegedOpenids(config).length === 0) {
    return { allowed: false, reason: '请先在插件配置里设置 ownerOpenid 或 adminOpenids，再登录 B 站' };
  }
  if (!isPrivilegedSender(record.peerId, config)) {
    return { allowed: false, reason: '只有 bot 主人或管理员可以登录 B 站；只读字幕不受此限制' };
  }
  return { allowed: true };
}
