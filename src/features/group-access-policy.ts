import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope } from '../types.ts';

type Peer = { scope: ChatScope; peerId: string };
type FullAccess = (session: Peer) => boolean;

export function groupOnList(group: string, ids: readonly string[] | undefined): boolean {
  return ids?.some((id) => id.trim() === group) ?? false;
}

/** The dedicated image list is additive: removing a grant cannot override an existing broader policy. */
export function implicitImageGroupAccess(group: string, config: Pick<ImQQBotConfig, 'imageGen'>, isFullAccess?: FullAccess): string {
  if (config.imageGen?.allowAllGroups === true) return '全群生图已开启（allowAllGroups）';
  if (isFullAccess?.({ scope: 'group', peerId: group })) return '该群已有完全工具权限';
  return '';
}

export function canUseImageGen(caller: Peer | undefined, config: Pick<ImQQBotConfig, 'imageGen'>, isFullAccess?: FullAccess): boolean {
  if (caller === undefined) return true; // 本机会话
  if (caller.scope !== 'group') return isFullAccess?.(caller) === true;
  return groupOnList(caller.peerId, config.imageGen?.allowedGroups) || !!implicitImageGroupAccess(caller.peerId, config, isFullAccess);
}
