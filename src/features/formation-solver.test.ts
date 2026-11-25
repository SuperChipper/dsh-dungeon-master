import { describe, expect, it } from 'vitest';
import { solveFormation, type FormationCandidate, type FormationProblem } from './formation-solver.ts';

function point(x: number, depth: number, anchorDistance = 0): FormationCandidate {
  return { x, y: 0, depth, anchorDistance, rankDeviation: 0, hazardous: false };
}

function formation(): FormationProblem {
  const doorway = point(1, 5);
  const flank = point(3, 5, 10);
  const middle = point(0, 10);
  return {
    members: [
      { name: '先锋', rank: 0, candidates: [doorway, flank] },
      { name: '后援', rank: 1, candidates: [middle] },
    ],
    occupied: [], fixedAllies: [], cellFeet: 5, targetGap: 10,
    fallback: new Map([['先锋', doorway], ['后援', middle]]),
  };
}

describe('整队阵型搜索', () => {
  it('比较整队间距，可以牺牲更靠近入口的单人成本', () => {
    const problem = formation();
    const result = solveFormation(problem)!;
    expect(result.positions.get('先锋')).toMatchObject({ x: 3 });
    expect(result.closePairs).toBe(0);
    expect(solveFormation({ ...problem, members: [...problem.members].reverse() })).toEqual(result);
  });

  it('先保证排位次序，再比较分开的距离', () => {
    const problem = formation();
    const leader = point(1, 5);
    const correctRear = point(2, 10);
    const reverseRear = point(5, 0);
    const result = solveFormation({
      ...problem,
      members: [
        { name: '先锋', rank: 0, candidates: [leader] },
        { name: '后援', rank: 1, candidates: [reverseRear, correctRear] },
      ],
    })!;
    expect(result.positions.get('后援')).toBe(correctRear);
    expect(result.closePairs).toBe(1);
  });

  it('搜索耗尽时只接受完整且不占固定格的贪心解', () => {
    const problem = formation();
    expect(solveFormation(problem, 0)).toMatchObject({ examined: 0, closePairs: 1, spacingDeficit: 5 });
    expect(solveFormation({ ...problem, occupied: [point(1, 5)] }, 0)).toBeUndefined();
    expect(solveFormation({ ...problem, occupied: [point(1, 5)] })!.positions.get('先锋')).toMatchObject({ x: 3 });
  });

  it('初始候选不够时扩池，并把各轮尝试合计在预算内', () => {
    const cells = Array.from({ length: 13 }, (_, index) => point(index, 5, 5 * index));
    const problem: FormationProblem = {
      ...formation(),
      members: [{ name: '先锋', rank: 0, candidates: cells }],
      occupied: cells.slice(0, 12),
      fallback: new Map(),
    };
    expect(solveFormation(problem, 24)).toBeUndefined();
    const result = solveFormation(problem, 25)!;
    expect(result.positions.get('先锋')).toBe(cells[12]);
    expect(result.examined).toBe(25);
  });
});
