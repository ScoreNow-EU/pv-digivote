import type { Ballot } from "@pv/domain";

export interface ScoreRow {
  actId: string;
  rank: number;
  juryPoints: number;
  publicRawPoints: number;
  publicPoints: number;
  totalPoints: number;
  distinctVoters: number;
  highScoreCounts: Record<number, number>;
  fullyTiedWithPrevious: boolean;
}

export interface ScoreboardResult {
  rows: ScoreRow[];
  juryTotal: number;
  publicRawTotal: number;
  publicTarget: number;
  publicAllocatedTotal: number;
  requiresRunoff: boolean;
  runoffActIds: string[];
}

export interface ComputeScoreboardInput {
  actIds: readonly string[];
  juryBallots: readonly Ballot[];
  publicBallots: readonly Ballot[];
  pointScale: readonly number[];
  juryWeight: number;
  publicWeight: number;
}

function isCountingBallot(ballot: Ballot): boolean {
  return ballot.status === "SUBMITTED" || ballot.status === "LOCKED";
}

function sumPointScale(pointScale: readonly number[]): number {
  return pointScale.reduce((sum, value) => sum + value, 0);
}

function emptyMap(actIds: readonly string[]): Map<string, number> {
  return new Map(actIds.map((actId) => [actId, 0]));
}

function addBallots(
  actIds: readonly string[],
  ballots: readonly Ballot[]
): Map<string, number> {
  const result = emptyMap(actIds);
  const knownActs = new Set(actIds);

  for (const ballot of ballots.filter(isCountingBallot)) {
    for (const entry of ballot.entries) {
      if (!knownActs.has(entry.actId)) continue;
      result.set(entry.actId, (result.get(entry.actId) ?? 0) + entry.points);
    }
  }

  return result;
}

interface AllocationTieStats {
  distinctVoters: Map<string, number>;
  highScoreCounts: Map<string, Record<number, number>>;
}

function collectTieStats(
  actIds: readonly string[],
  ballots: readonly Ballot[],
  pointScale: readonly number[]
): AllocationTieStats {
  const distinctSets = new Map(actIds.map((actId) => [actId, new Set<string>()]));
  const highScoreCounts = new Map(
    actIds.map((actId) => [
      actId,
      Object.fromEntries(pointScale.map((value) => [value, 0])) as Record<number, number>
    ])
  );

  for (const ballot of ballots.filter(isCountingBallot)) {
    for (const entry of ballot.entries) {
      distinctSets.get(entry.actId)?.add(`${ballot.group}:${ballot.voterId}`);
      const counts = highScoreCounts.get(entry.actId);
      if (counts) counts[entry.points] = (counts[entry.points] ?? 0) + 1;
    }
  }

  return {
    distinctVoters: new Map([...distinctSets].map(([actId, voters]) => [actId, voters.size])),
    highScoreCounts
  };
}

function compareHighScores(
  left: Record<number, number>,
  right: Record<number, number>,
  pointScaleDescending: readonly number[]
): number {
  for (const points of pointScaleDescending) {
    const difference = (right[points] ?? 0) - (left[points] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function normalizePublicPoints(
  rawPoints: ReadonlyMap<string, number>,
  target: number,
  tieStats: AllocationTieStats,
  pointScale: readonly number[]
): Map<string, number> {
  if (!Number.isInteger(target) || target < 0) {
    throw new Error("Die Zielpunktzahl muss eine nicht-negative Ganzzahl sein.");
  }

  const rawTotal = [...rawPoints.values()].reduce((sum, value) => sum + value, 0);
  if (rawTotal === 0 || target === 0) return new Map([...rawPoints.keys()].map((actId) => [actId, 0]));

  const descendingScale = [...pointScale].sort((a, b) => b - a);
  const quotas = [...rawPoints].map(([actId, raw]) => {
    const exact = (raw / rawTotal) * target;
    return {
      actId,
      raw,
      floor: Math.floor(exact),
      remainder: exact - Math.floor(exact)
    };
  });
  const allocation = new Map(quotas.map(({ actId, floor }) => [actId, floor]));
  let remainderPoints = target - quotas.reduce((sum, quota) => sum + quota.floor, 0);

  quotas.sort((left, right) => {
    const remainderDifference = right.remainder - left.remainder;
    if (Math.abs(remainderDifference) > Number.EPSILON) return remainderDifference;
    if (right.raw !== left.raw) return right.raw - left.raw;

    const distinctDifference =
      (tieStats.distinctVoters.get(right.actId) ?? 0) -
      (tieStats.distinctVoters.get(left.actId) ?? 0);
    if (distinctDifference !== 0) return distinctDifference;

    const highScoreDifference = compareHighScores(
      tieStats.highScoreCounts.get(left.actId) ?? {},
      tieStats.highScoreCounts.get(right.actId) ?? {},
      descendingScale
    );
    if (highScoreDifference !== 0) return highScoreDifference;

    return left.actId.localeCompare(right.actId, "de");
  });

  for (const quota of quotas) {
    if (remainderPoints <= 0) break;
    allocation.set(quota.actId, (allocation.get(quota.actId) ?? 0) + 1);
    remainderPoints -= 1;
  }

  return allocation;
}

function compareRows(
  left: Omit<ScoreRow, "rank" | "fullyTiedWithPrevious">,
  right: Omit<ScoreRow, "rank" | "fullyTiedWithPrevious">,
  pointScaleDescending: readonly number[]
): number {
  if (right.totalPoints !== left.totalPoints) return right.totalPoints - left.totalPoints;
  if (right.publicPoints !== left.publicPoints) return right.publicPoints - left.publicPoints;
  if (right.distinctVoters !== left.distinctVoters) return right.distinctVoters - left.distinctVoters;
  return compareHighScores(left.highScoreCounts, right.highScoreCounts, pointScaleDescending);
}

export function computeScoreboard(input: ComputeScoreboardInput): ScoreboardResult {
  if (input.juryWeight <= 0 || input.publicWeight <= 0) {
    throw new Error("Jury- und Publikumsgewicht müssen größer als null sein.");
  }
  if (new Set(input.actIds).size !== input.actIds.length) {
    throw new Error("Act-IDs müssen eindeutig sein.");
  }

  const validJuryBallots = input.juryBallots.filter(isCountingBallot);
  const validPublicBallots = input.publicBallots.filter(isCountingBallot);
  const juryScores = addBallots(input.actIds, validJuryBallots);
  const publicRawScores = addBallots(input.actIds, validPublicBallots);
  const allTieStats = collectTieStats(
    input.actIds,
    [...validJuryBallots, ...validPublicBallots],
    input.pointScale
  );
  const publicTieStats = collectTieStats(input.actIds, validPublicBallots, input.pointScale);

  const juryTotal = validJuryBallots.length * sumPointScale(input.pointScale);
  const publicRawTotal = validPublicBallots.length * sumPointScale(input.pointScale);
  const publicTarget = validPublicBallots.length === 0
    ? 0
    : Math.round(juryTotal * (input.publicWeight / input.juryWeight));
  const publicScores = normalizePublicPoints(
    publicRawScores,
    publicTarget,
    publicTieStats,
    input.pointScale
  );
  const descendingScale = [...input.pointScale].sort((a, b) => b - a);

  const unsorted = input.actIds.map((actId) => {
    const juryPoints = juryScores.get(actId) ?? 0;
    const publicPoints = publicScores.get(actId) ?? 0;
    return {
      actId,
      juryPoints,
      publicRawPoints: publicRawScores.get(actId) ?? 0,
      publicPoints,
      totalPoints: juryPoints + publicPoints,
      distinctVoters: allTieStats.distinctVoters.get(actId) ?? 0,
      highScoreCounts: allTieStats.highScoreCounts.get(actId) ?? {}
    };
  });

  unsorted.sort((left, right) => {
    const result = compareRows(left, right, descendingScale);
    return result === 0 ? left.actId.localeCompare(right.actId, "de") : result;
  });

  const rows: ScoreRow[] = unsorted.map((row, index) => {
    const previous = unsorted[index - 1];
    const tied = previous !== undefined && compareRows(previous, row, descendingScale) === 0;
    return {
      ...row,
      rank: tied ? (unsorted.slice(0, index).reverse().findIndex((candidate, offset) => {
        const before = unsorted[index - offset - 1];
        return before !== undefined && compareRows(before, row, descendingScale) !== 0;
      }) >= 0 ? index : 1) : index + 1,
      fullyTiedWithPrevious: tied
    };
  });

  // Assign competition ranks in one readable pass (1, 2, 2, 4).
  let currentRank = 1;
  for (let index = 0; index < rows.length; index += 1) {
    if (index > 0 && !rows[index]!.fullyTiedWithPrevious) currentRank = index + 1;
    rows[index]!.rank = currentRank;
  }

  const topRows = rows.filter((row) => rows[0] && compareRows(rows[0], row, descendingScale) === 0);
  const requiresRunoff = topRows.length > 1;

  return {
    rows,
    juryTotal,
    publicRawTotal,
    publicTarget,
    publicAllocatedTotal: [...publicScores.values()].reduce((sum, value) => sum + value, 0),
    requiresRunoff,
    runoffActIds: requiresRunoff ? topRows.map((row) => row.actId) : []
  };
}
