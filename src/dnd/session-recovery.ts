import { campaignState, type Campaign } from './campaign.ts';
import { parseProgress } from './progress-patch.ts';

export const PREPARATION_MAX_CHARS = 2000;

/** 交接是已记录事实，备团是候选安排；分别注入，避免计划被当作已经演过。 */
export function recoveryLines(c: Campaign): string[] {
  const last = c.summaries.at(-1);
  const sections = parseProgress(last?.text ?? '');
  const missing = ['位置', '刚刚发生', '已定行动', '同行与留守', '未结事项', '下次接续']
    .filter((name) => !sections.some((s) => s.name === name && s.lines.length > 0));
  const lines = ['【续团核对 · DM 私有】',
    '回顾前先对照最新团况、上次进度与停团补记。房间 ID 可能只代表大区域；具体营地、NPC 去向和玩家已定行动按交接核对，不能从模组起点重新出发。缺项先查 dnd_prepare show / dnd_chronicle search，仍查不到就问玩家，不补编。'];
  if (missing.length > 0) lines.push(`交接尚缺明确栏目：${missing.join('、')}（已有同义记录可先核对，不必重问）。`);
  if (last && (!last.state || /【[^】\n]*$/.test(last.text))) lines.push('旧摘要未带团况校验或末尾疑似截断，需核对；dnd_progress 可整份重写，旧无名段现为【旧进度】。');
  if (c.handoff?.needsReview) lines.push('停团时尚有未核对内容；旧摘要不能替代后来的工具事实。');
  if (c.handoff?.changes.length) lines.push(`停团补记（工具事实，近期日志未必全晚于摘要）：\n${c.handoff.changes.join('\n')}`);
  if (c.handoff && c.handoff.room !== c.currentRoom) lines.push('停团后房间已变化，旧交接位置仅供回顾，以最新团况为准。');
  if (c.initiative) lines.push('上场战斗尚未结束：保留原先攻、站位、已用反应与待结算，不要重掷先攻；先核对最新团况再继续。');
  return lines;
}

export function preparationLines(c: Campaign): string[] {
  const prep = c.preparation;
  if (!prep) return [];
  return ['【备团计划 · DM 私有 · 尚未发生】',
    prep.state === campaignState(c) ? '计划对应当前团况，仍须等玩家选择，不得自动触发事件、发奖励或透露秘密。' : '团况已变化，这份计划需要重新核对，不能直接照演。',
    prep.text];
}
