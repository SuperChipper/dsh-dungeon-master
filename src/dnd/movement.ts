/** 移动与借机的停止点：路径计算不代替玩家决定，也不把剩余路程提前落盘。 */
import { type Campaign, type PendingMovement, nextRollId, pushLog, requireCharacter, requireInitiative } from './campaign.ts';
import { type MoveRequest, moveOnGrid, moveResultText } from './battlefield.ts';
import { assertWindowClosed, declineReaction } from './pending-attack.ts';

function stopped(c: Campaign, name: string): boolean {
  const ch = requireCharacter(c, name);
  return ch.hp <= 0 || (ch.speed ?? 30) <= 0 || ch.conditions.some((cond) => ['死亡', '擒抱', '束缚', '麻痹', '石化', '昏迷', '震慑'].includes(cond));
}

export function beginMovement(c: Campaign, name: string, request: MoveRequest): string {
  if (stopped(c, name)) throw new Error(`${name} 现在不能移动（速度为 0、失去意识或被限制移动），先结算对应状态`);
  const result = moveOnGrid(c, name, { ...request, interrupt: true });
  if (result.opportunity !== undefined) {
    const p: PendingMovement = {
      kind: 'move', seq: nextRollId(c), at: Date.now(), attacker: result.name, target: result.name,
      reactors: result.opportunity.reactors, declined: [], claimed: [], used: [], resume: result.opportunity.resume,
    };
    requireInitiative(c).movement = p;
  }
  return moveResultText(result);
}

export function resolveMovement(c: Campaign, args: { target?: unknown; decline?: unknown; settle?: unknown; cancel?: unknown }): string {
  const state = requireInitiative(c);
  if (state.pending !== undefined) throw new Error('借机攻击还没落账，先用 dnd_apply 处理攻击的反应和 settle，再继续移动');
  const p = state.movement;
  if (p === undefined) throw new Error('现在没有待结算的移动');
  if (requireCharacter(c, String(args.target ?? '')).name !== p.target) throw new Error(`待结算移动的是 ${p.target}`);
  if (args.cancel === true) {
    delete state.movement;
    pushLog(c, `${p.target} 取消剩余移动`);
    return `${p.target} 取消剩余移动，停在当前格；已经花掉的移动力和反应不退。`;
  }
  if (Array.isArray(args.decline)) for (const name of args.decline) declineReaction(p, requireCharacter(c, String(name)).name);
  if (args.settle !== true) return `${p.target} 仍停在借机触发处；全部答复且借机落账后 dnd_apply target=${p.target} settle=true 继续移动。`;
  assertWindowClosed(p);
  delete state.movement;
  if (stopped(c, p.target)) return `${p.target} 在借机后无法继续移动，停在当前格。`;
  return beginMovement(c, p.target, p.resume);
}
