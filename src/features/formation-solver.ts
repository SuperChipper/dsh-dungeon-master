/** Pure assignment problem. Callers supply legal cells and all map-specific costs. */
export interface FormationPoint {
  x: number;
  y: number;
  z?: number;
}

export interface FormationCandidate extends FormationPoint {
  depth: number;
  anchorDistance: number;
  rankDeviation: number;
  hazardous: boolean;
}

export interface FormationMember {
  name: string;
  rank: number;
  /** First cells cover the preferred depth and several lateral bands. */
  candidates: readonly FormationCandidate[];
}

export interface FormationProblem {
  members: readonly FormationMember[];
  occupied: readonly FormationPoint[];
  fixedAllies: readonly FormationPoint[];
  cellFeet: number;
  targetGap: number;
  fallback: ReadonlyMap<string, FormationPoint>;
}

export interface FormationSolution {
  positions: ReadonlyMap<string, FormationCandidate>;
  closePairs: number;
  spacingDeficit: number;
  examined: number;
}

type Score = [
  hazards: number, rankConflicts: number, closePairs: number, spacingDeficit: number,
  rankDeviation: number, anchorDistance: number,
];

type Placement = { member: FormationMember; cell: FormationCandidate };
type PartialFormation = { placements: readonly Placement[]; score: Score };

const BEAM_WIDTH = 32;
export const FORMATION_EXPANSION_BUDGET = 24_000;
const CANDIDATE_LIMITS = [12, 24, 48] as const;
const emptyFormation: PartialFormation = { placements: [], score: [0, 0, 0, 0, 0, 0] };

function sameCell(a: FormationPoint, b: FormationPoint): boolean {
  return a.x === b.x && a.y === b.y;
}

function compareName(a: FormationMember, b: FormationMember): number {
  return a.name === b.name ? 0 : a.name < b.name ? -1 : 1;
}

function comparePlacements(a: Placement, b: Placement): number {
  return compareName(a.member, b.member) || a.cell.y - b.cell.y || a.cell.x - b.cell.x || (a.cell.z ?? 0) - (b.cell.z ?? 0);
}

function compareFormations(a: PartialFormation, b: PartialFormation): number {
  for (const [index, value] of a.score.entries()) {
    const diff = value - b.score[index]!;
    if (diff !== 0) return diff;
  }
  for (const [index, placement] of a.placements.entries()) {
    const diff = comparePlacements(placement, b.placements[index]!);
    if (diff !== 0) return diff;
  }
  return 0;
}

function trimBeam(formations: PartialFormation[]): PartialFormation[] {
  const beam: PartialFormation[] = [];
  const footprints = new Set<string>();
  for (const formation of formations.sort(compareFormations)) {
    // Exchanging equal-rank members leaves the same constraints for later placements.
    const key = formation.placements.map(({ member, cell }) =>
      `${member.rank}:${cell.x},${cell.y},${cell.z ?? 0},${cell.depth}`).sort().join(';');
    if (footprints.has(key)) continue;
    footprints.add(key);
    beam.push(formation);
    if (beam.length >= BEAM_WIDTH) break;
  }
  return beam;
}

function addPlacement(
  problem: FormationProblem, partial: PartialFormation, member: FormationMember, cell: FormationCandidate,
): PartialFormation | undefined {
  if (problem.occupied.some((point) => sameCell(point, cell)) || partial.placements.some((item) => sameCell(item.cell, cell))) {
    return undefined;
  }
  const score: Score = [...partial.score];
  score[0] += Number(cell.hazardous);
  score[4] += cell.rankDeviation;
  score[5] += cell.anchorDistance;
  for (const other of partial.placements) {
    const rankDifference = Math.sign(member.rank - other.member.rank);
    if (rankDifference !== 0 && (cell.depth - other.cell.depth) * rankDifference < problem.cellFeet) score[1]++;
  }
  const neighbors = [...problem.fixedAllies, ...partial.placements.map((item) => item.cell)];
  for (const other of neighbors) {
    const distance = Math.max(
      Math.abs(cell.x - other.x) * problem.cellFeet,
      Math.abs(cell.y - other.y) * problem.cellFeet,
      Math.abs((cell.z ?? 0) - (other.z ?? 0)),
    );
    if (distance < problem.targetGap) {
      score[2]++;
      score[3] += problem.targetGap - distance;
    }
  }
  const placements = [...partial.placements, { member, cell }].sort(comparePlacements);
  return { placements, score };
}

function scoreFallback(problem: FormationProblem): PartialFormation | undefined {
  let partial = emptyFormation;
  for (const member of problem.members) {
    const position = problem.fallback.get(member.name);
    const candidate = position === undefined ? undefined : member.candidates.find((cell) => sameCell(cell, position));
    if (candidate === undefined) return undefined;
    const next = addPlacement(problem, partial, member, candidate);
    if (next === undefined) return undefined;
    partial = next;
  }
  return partial;
}

export function solveFormation(problem: FormationProblem, maxExpansions = FORMATION_EXPANSION_BUDGET): FormationSolution | undefined {
  let best = scoreFallback(problem);
  let examined = 0;
  for (const limit of CANDIDATE_LIMITS) {
    const members = [...problem.members].sort((a, b) =>
      Math.min(a.candidates.length, limit) - Math.min(b.candidates.length, limit) || a.rank - b.rank || compareName(a, b));
    let beam = [emptyFormation];
    for (const [index, member] of members.entries()) {
      const next: PartialFormation[] = [];
      const candidates = member.candidates.slice(0, limit);
      for (const partial of beam) {
        for (const cell of candidates) {
          if (examined >= maxExpansions) break;
          examined++;
          const extended = addPlacement(problem, partial, member, cell);
          if (extended === undefined) continue;
          if (index + 1 !== members.length) next.push(extended);
          else if (best === undefined || compareFormations(extended, best) < 0) best = extended;
        }
        if (examined >= maxExpansions) break;
      }
      if (next.length === 0 || examined >= maxExpansions) break;
      beam = trimBeam(next);
    }
    // Widen only when the current search still leaves a safety, rank or spacing compromise.
    const meetsTargets = best !== undefined && best.score[0] === 0 && best.score[1] === 0 && best.score[2] === 0;
    if (meetsTargets || examined >= maxExpansions || members.every((member) => member.candidates.length <= limit)) break;
  }
  if (best === undefined) return undefined;
  return {
    positions: new Map(best.placements.map(({ member, cell }) => [member.name, cell])),
    closePairs: best.score[2],
    spacingDeficit: best.score[3],
    examined,
  };
}
