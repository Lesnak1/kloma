import { clamp } from "@/src/indicators";
import type {
  CompetitionRound,
  LeaderboardEntry,
  LeaderboardResponse,
  MarketSummary,
  PortfolioComponent,
  RiskMode,
} from "@/src/types";

export interface VolumePace {
  targetVolume: number;
  expectedVolume: number | null;
  paceRatio: number | null;
}

export interface RankChaseTarget {
  baselineTargetVolume: number;
  targetVolume: number;
  thirdPlaceVolume: number | null;
  thirdPlacePoints: number | null;
  thirdPlaceProjectedVolume: number | null;
  thirdPlaceProjectedPoints: number | null;
  leaderboardProjectionActive: boolean;
}

function timestampMilliseconds(value: CompetitionRound["startsAt"]): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function elapsedRoundFraction(round: CompetitionRound, nowMilliseconds: number): number | null {
  const start = timestampMilliseconds(round.startsAt);
  const end = timestampMilliseconds(round.endsAt);
  if (start === null || end === null || end <= start || nowMilliseconds <= start) return null;
  return clamp((nowMilliseconds - start) / (end - start), 0, 1);
}

export function volumePaceForRound(
  round: CompetitionRound,
  currentVolume: number | null,
  targetVolume: number,
  nowMilliseconds = Date.now(),
): VolumePace {
  const safeTarget = Math.max(0, targetVolume);
  const elapsed = elapsedRoundFraction(round, nowMilliseconds);
  if (elapsed === null) {
    return { targetVolume: safeTarget, expectedVolume: 0, paceRatio: null };
  }
  const expectedVolume = safeTarget * elapsed;
  if (expectedVolume < safeTarget * 0.01) {
    return { targetVolume: safeTarget, expectedVolume, paceRatio: null };
  }
  return {
    targetVolume: safeTarget,
    expectedVolume,
    paceRatio: Math.max(0, Number(currentVolume ?? 0)) / expectedVolume,
  };
}

export function rankChaseTargetForRound(
  round: CompetitionRound,
  leaderboard: LeaderboardResponse | null,
  options: {
    baselineTargetVolume: number;
    enabled: boolean;
    safetyMarginPct: number;
    minElapsedPct: number;
    maxTargetVolume: number;
  },
  nowMilliseconds = Date.now(),
): RankChaseTarget {
  const baselineTargetVolume = Math.max(0, Number(options.baselineTargetVolume) || 0);
  const maximumTargetVolume = Math.max(baselineTargetVolume, Number(options.maxTargetVolume) || baselineTargetVolume);
  const rankedEntries = [...(leaderboard?.entries ?? [])]
    .filter((entry) => Number.isFinite(Number(entry.rank)) && Number(entry.rank) > 0)
    .sort((left, right) => Number(left.rank) - Number(right.rank));
  const third = rankedEntries.find((entry) => Number(entry.rank) === 3) ?? rankedEntries[2];
  const thirdPlaceVolume = third && Number.isFinite(Number(third.volume)) ? Math.max(0, Number(third.volume)) : null;
  const thirdPlacePoints = third && Number.isFinite(Number(third.points)) ? Math.max(0, Number(third.points)) : null;
  const elapsed = elapsedRoundFraction(round, nowMilliseconds);
  const minimumElapsed = clamp(Number(options.minElapsedPct) / 100, 0, 1);
  const canProject = Boolean(
    options.enabled &&
    elapsed !== null &&
    elapsed >= minimumElapsed &&
    thirdPlaceVolume !== null,
  );
  const thirdPlaceProjectedVolume = canProject ? thirdPlaceVolume! / elapsed! : null;
  const thirdPlaceProjectedPoints = canProject && thirdPlacePoints !== null ? thirdPlacePoints / elapsed! : null;
  const safetyMultiplier = 1 + clamp(Number(options.safetyMarginPct) / 100, 0, 1);
  const targetVolume = canProject
    ? Math.min(maximumTargetVolume, Math.max(baselineTargetVolume, thirdPlaceProjectedVolume! * safetyMultiplier))
    : baselineTargetVolume;

  return {
    baselineTargetVolume,
    targetVolume,
    thirdPlaceVolume,
    thirdPlacePoints,
    thirdPlaceProjectedVolume,
    thirdPlaceProjectedPoints,
    leaderboardProjectionActive: canProject,
  };
}

export interface Standing {
  rank: number | null;
  participants: number;
  percentile: number | null;
  bottomThirtyCutoffRank: number | null;
  riskMode: RiskMode;
  points: number | null;
  volume: number | null;
  pnl: number | null;
}

export interface VolumeMultiplierState {
  currentMultiplier: number;
  nextThreshold: number | null;
  nextMultiplier: number | null;
}

function sameIdentity(entry: LeaderboardEntry, handle?: string, walletAddress?: string): boolean {
  const handleMatches = handle !== undefined && entry.handle?.toLowerCase() === handle.toLowerCase();
  const walletMatches =
    walletAddress !== undefined && entry.walletAddress?.toLowerCase() === walletAddress.toLowerCase();
  return handleMatches || walletMatches;
}

export function assessStanding(
  leaderboard: LeaderboardResponse | null,
  identity: { handle?: string; walletAddress?: string },
): Standing {
  const entries = leaderboard?.entries ?? [];
  const participants = entries.length;
  const bottomThirtyCutoffRank = participants > 0 ? Math.max(1, Math.floor(participants * 0.7)) : null;
  const own = entries.find((entry) => sameIdentity(entry, identity.handle, identity.walletAddress));
  if (!own || participants === 0) {
    return {
      rank: null,
      participants,
      percentile: null,
      bottomThirtyCutoffRank,
      riskMode: "balanced",
      points: null,
      volume: null,
      pnl: null,
    };
  }

  const percentile = clamp(own.rank / participants, 0, 1);
  const riskMode: RiskMode =
    percentile <= 0.35 ? "preserve" : percentile <= 0.55 ? "balanced" : percentile <= 0.7 ? "defend" : "attack";
  return {
    rank: own.rank,
    participants,
    percentile,
    bottomThirtyCutoffRank,
    riskMode,
    points: Number.isFinite(Number(own.points)) ? Number(own.points) : null,
    volume: Number.isFinite(Number(own.volume)) ? Number(own.volume) : null,
    pnl: Number.isFinite(Number(own.pnl)) ? Number(own.pnl) : null,
  };
}

export function modeSizeMultiplier(mode: RiskMode): number {
  switch (mode) {
    case "preserve":
      return 0.65;
    case "defend":
      return 1.15;
    case "attack":
      return 1.35;
    default:
      return 1;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function candidateMultiplier(item: Record<string, unknown>): number | null {
  for (const key of ["multiplier", "volumeMultiplier", "pointsMultiplier", "value"]) {
    const value = Number(item[key]);
    if (Number.isFinite(value) && value > 0 && value <= 10) return value;
  }
  return null;
}

function tierArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const item = record(value);
  if (!item) return [];
  for (const key of ["tiers", "volumeTiers", "multipliers"]) {
    if (Array.isArray(item[key])) return item[key] as unknown[];
  }
  return [];
}

function candidateThreshold(item: Record<string, unknown>): number | null {
  for (const key of ["threshold", "volumeThreshold", "minVolume", "minimumVolume", "volume"]) {
    const value = Number(item[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

export function volumeMultiplierForStanding(tiers: unknown, volume: number | null): VolumeMultiplierState {
  const normalizedVolume = Math.max(0, Number(volume ?? 0));
  const parsed = tierArray(tiers)
    .map((raw) => {
      const item = record(raw);
      if (!item) return null;
      const threshold = candidateThreshold(item);
      const multiplier = candidateMultiplier(item);
      return threshold !== null && multiplier !== null ? { threshold, multiplier } : null;
    })
    .filter((item): item is { threshold: number; multiplier: number } => item !== null)
    .sort((left, right) => left.threshold - right.threshold);

  let currentMultiplier = 1;
  let nextThreshold: number | null = null;
  let nextMultiplier: number | null = null;
  for (const tier of parsed) {
    if (normalizedVolume >= tier.threshold) {
      currentMultiplier = Math.max(currentMultiplier, tier.multiplier);
      continue;
    }
    nextThreshold = tier.threshold;
    nextMultiplier = tier.multiplier;
    break;
  }
  return { currentMultiplier, nextThreshold, nextMultiplier };
}

export function explicitMarketMultiplier(tiers: unknown, market: MarketSummary): number {
  for (const raw of tierArray(tiers)) {
    const item = record(raw);
    if (!item) continue;
    const token = String(item.tokenName ?? item.token ?? "").toLowerCase();
    const propertyId = Number(item.propertyId);
    const matches = token === market.tokenName.toLowerCase() || propertyId === market.propertyId;
    if (!matches) continue;
    return candidateMultiplier(item) ?? 1;
  }
  return 1;
}

export function portfolioGrossExposure(portfolio: PortfolioComponent): number {
  return portfolio.positions.reduce(
    (sum, position) => sum + Math.max(0, position.quantity) * Math.max(0, position.marketPrice),
    0,
  );
}

export function portfolioDrawdownPct(portfolioValue: number, startingBalance: number): number {
  if (startingBalance <= 0) return 0;
  return Math.max(0, ((startingBalance - portfolioValue) / startingBalance) * 100);
}
