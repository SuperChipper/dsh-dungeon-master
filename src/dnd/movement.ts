/** 移动与借机的停止点：路径计算不代替玩家决定，也不把剩余路程提前落盘。 */
import { type Campaign, type PendingMovement, nextRollId, pushLog, requireCharacter, requireInitiative } from './campaign.ts';
import { type MoveGridOptions, type MoveRequest, moveOnGrid, moveResultText } from './battlefield.ts';
import { hasCondition, movementSpeedInfo } from './conditions.ts';
import { assertWindowClosed, declineReaction } from './pending-attack.ts';

function stopped(c: Campaign, name: string, ignoreStateMods = false): boolean {
  const ch = requireCharacter(c, name);
  if (ch.hp <= 0 || ch.conditions.includes('死亡')) return true;
  const base = Math.max(ch.speed ?? 30, ch.flySpeed ?? 0, hasCondition(ch, '飞行术') ? 60 : 0);
  if (ignoreStateMods) return base <= 0;
  return movementSpeedInfo(ch, base).zeroSpeed;
}

export function beginMovement(c: Campaign, name: string, request: MoveRequest, options: MoveGridOptions = {}): string {
  if (stopped(c, name, request.ignoreStateMods === true)) throw new Error(`${name} 现在不能移动（速度为 0、失去意识或被限制移动），先结算对应状态`);
  const result = moveOnGrid(c, name, { ...request, interrupt: true }, options);
  if (result.opportunity !== undefined) {
    const p: PendingMovement = {
      kind: 'move', seq: nextRollId(c), at: Date.now(), attacker: result.name, target: result.name,
      reactors: result.opportunity.reactors, declined: [], claimed: [], used: [], resume: result.opportunity.resume,
    };
    requireInitiative(c).movement = p;
  }
  return moveResultText(result);
}

export function resolveMovement(
  c: Campaign,
  args: { target?: unknown; decline?: unknown; settle?: unknown; cancel?: unknown },
  options: MoveGridOptions = {},
): string {
  const state = requireInitiative(c);
  if (state.pending !== undefined) throw new Error('借机攻击还没落账，先用 dnd_apply 处理攻击的反应和 settle，再继续移动');
  const p = state.movement;
  if (p === undefined) throw new Error('现在没有待结算的移动');
  if (requireCharacter(c, String(args.target ?? '')).name !== p.target) throw new Error(`待结算移动的是 ${p.target}`);
  if (args.cancel === true) {
    const dashRefundNote = p.resume.dash === true && state.dashed?.includes(p.target) !== true
      ? '（尚未进入冲刺阶段，冲刺动作未消耗）'
      : '';
    delete state.movement;
    pushLog(c, `${p.target} 取消剩余移动`);
    return `${p.target} 取消剩余移动，停在当前格；已经花掉的移动力和反应不退${dashRefundNote}。`;
  }
  if (Array.isArray(args.decline)) for (const name of args.decline) declineReaction(p, requireCharacter(c, String(name)).name);
  if (args.settle !== true) return `${p.target} 仍停在借机触发处；全部答复且借机落账后 dnd_apply target=${p.target} settle=true 继续移动。`;
  assertWindowClosed(p);
  delete state.movement;
  if (stopped(c, p.target, p.resume.ignoreStateMods === true)) {
    const dashRefundNote = p.resume.dash === true && state.dashed?.includes(p.target) !== true
      ? '（尚未进入冲刺阶段，冲刺动作未消耗）'
      : '';
    return `${p.target} 在借机后无法继续移动，停在当前格${dashRefundNote}。`;
  }
  return beginMovement(c, p.target, p.resume, options);
}
