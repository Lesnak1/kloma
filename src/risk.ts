import { clamp } from "@/src/indicators";
import type {
  LeaderboardEntry,
  LeaderboardResponse,
  MarketSummary,
  PortfolioComponent,
  RiskMode,
} from "@/src/types";

export interface Standing {
  rank: number | null;
  participants: number;
  percentile: number | null;
  bottomThirtyCutoffRank: number | null;
  riskMode: RiskMode;
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
    return { rank: null, participants, percentile: null, bottomThirtyCutoffRank, riskMode: "balanced" };
  }

  const percentile = clamp(own.rank / participants, 0, 1);
  const riskMode: RiskMode =
    percentile <= 0.35 ? "preserve" : percentile <= 0.55 ? "balanced" : percentile <= 0.7 ? "defend" : "attack";
  return { rank: own.rank, participants, percentile, bottomThirtyCutoffRank, riskMode };
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
    if (Number.isFinite(value) && value > 0 && value <= 100) return value;
  }
  return null;
}

export function explicitMarketMultiplier(tiers: unknown, market: MarketSummary): number {
  if (!Array.isArray(tiers)) return 1;
  for (const raw of tiers) {
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
