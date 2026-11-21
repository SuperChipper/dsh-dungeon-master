/**
 * 群聊触发门控策略（纯函数，无宿主依赖）。
 *
 * 将历史上的三个独立开关（`requireMention`、`groupReplyProbability`、`replyDesire.enabled`）
 * 收敛为统一的四档 `groupTriggerMode`，同时对未显式设置该键的存量配置保持兼容回退。
 */
export type GroupTriggerMode = 'mention' | 'probability' | 'desire' | 'all';

export const GROUP_TRIGGER_MODES: readonly GroupTriggerMode[] = [
  'mention',
  'probability',
  'desire',
  'all',
];

export interface GroupTriggerConfigLike {
  groupTriggerMode?: GroupTriggerMode;
  requireMention?: boolean;
  groupReplyProbability?: number;
  replyDesire?: { enabled?: boolean };
}

export interface GroupTriggerPolicy {
  mode: GroupTriggerMode;
  requireMentionInGroup: boolean;
  passthroughToDecider: boolean;
  implicitProbability: number;
  replyDesireEnabled: boolean;
  requireMentionHint: boolean;
}

function clampProbability(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function resolveGroupTriggerMode(config: GroupTriggerConfigLike): GroupTriggerMode {
  if (config.groupTriggerMode !== undefined && GROUP_TRIGGER_MODES.includes(config.groupTriggerMode)) {
    return config.groupTriggerMode;
  }
  if (config.requireMention === false) return 'all';
  if (config.replyDesire?.enabled === true) return 'desire';
  if (clampProbability(config.groupReplyProbability) > 0) return 'probability';
  return 'mention';
}

export function resolveGroupTriggerPolicy(config: GroupTriggerConfigLike): GroupTriggerPolicy {
  const mode = resolveGroupTriggerMode(config);
  switch (mode) {
    case 'all':
      return {
        mode,
        requireMentionInGroup: false,
        passthroughToDecider: false,
        implicitProbability: 0,
        replyDesireEnabled: false,
        requireMentionHint: false,
      };
    case 'probability':
      return {
        mode,
        requireMentionInGroup: true,
        passthroughToDecider: false,
        implicitProbability: clampProbability(config.groupReplyProbability),
        replyDesireEnabled: false,
        requireMentionHint: true,
      };
    case 'desire':
      return {
        mode,
        requireMentionInGroup: true,
        passthroughToDecider: true,
        implicitProbability: 0,
        replyDesireEnabled: true,
        requireMentionHint: true,
      };
    case 'mention':
      return {
        mode,
        requireMentionInGroup: true,
        passthroughToDecider: false,
        implicitProbability: 0,
        replyDesireEnabled: false,
        requireMentionHint: true,
      };
  }
}
