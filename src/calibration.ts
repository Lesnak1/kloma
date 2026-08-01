import { clamp } from "@/src/indicators";
import type { RunReport } from "@/src/types";

export interface StrategyCalibration {
  samples: number;
  emaNetEdgeBps: number;
  directionalAccuracy: number;
  sizeScale: number;
  thresholdAddBps: number;
}

interface SignalObservation {
  timestamp: number;
  mid: number;
  signalBps: number;
}

export interface DurableBotState {
  version: 1;
  updatedAt: string;
  observations: Record<string, SignalObservation>;
  calibrations: Record<string, StrategyCalibration>;
}

export function emptyDurableState(): DurableBotState {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    observations: {},
    calibrations: {},
  };
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeDurableState(value: unknown): DurableBotState {
  if (!value || typeof value !== "object") return emptyDurableState();
  const candidate = value as Partial<DurableBotState>;
  return {
    version: 1,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
    observations:
      candidate.observations && typeof candidate.observations === "object" ? candidate.observations : {},
    calibrations:
      candidate.calibrations && typeof candidate.calibrations === "object" ? candidate.calibrations : {},
  };
}

function updatedCalibration(
  current: StrategyCalibration | undefined,
  signedGrossEdgeBps: number,
  makerFeeBps: number,
): StrategyCalibration {
  const samples = Math.min(100_000, Math.max(0, Math.floor(finite(current?.samples, 0))) + 1);
  const previousEdge = finite(current?.emaNetEdgeBps, 0);
  const previousAccuracy = clamp(finite(current?.directionalAccuracy, 0.5), 0, 1);
  const alpha = samples === 1 ? 1 : 0.12;
  const netEdgeBps = signedGrossEdgeBps - makerFeeBps * 2;
  const emaNetEdgeBps = previousEdge * (1 - alpha) + netEdgeBps * alpha;
  const directionalAccuracy = previousAccuracy * (1 - alpha) + (signedGrossEdgeBps > 0 ? 1 : 0) * alpha;

  if (samples < 10) {
    return { samples, emaNetEdgeBps, directionalAccuracy, sizeScale: 0.7, thresholdAddBps: 10 };
  }
  const qualityBoost = Math.max(0, emaNetEdgeBps) / 80 + Math.max(0, directionalAccuracy - 0.5) * 0.8;
  const sizeScale = clamp(0.55 + qualityBoost, 0.5, 1.15);
  const edgePenalty = Math.max(0, -emaNetEdgeBps);
  const accuracyPenalty = Math.max(0, 0.48 - directionalAccuracy) * 100;
  const thresholdAddBps = clamp(edgePenalty + accuracyPenalty, 0, 60);
  return { samples, emaNetEdgeBps, directionalAccuracy, sizeScale, thresholdAddBps };
}

export function updateDurableState(state: DurableBotState, report: RunReport): DurableBotState {
  const next = normalizeDurableState(state);
  const now = Date.parse(report.timestamp);
  if (!Number.isFinite(now)) return next;
  const timestamp = Math.floor(now / 1000);
  const makerFeeBps = Math.max(0, finite(report.fees?.makerFeeBps, 0));

  for (const decision of report.decisions) {
    const token = decision.tokenName.toLowerCase();
    const mid = finite(decision.metrics.mid, 0);
    const fairPrice = finite(decision.metrics.fairPrice, 0);
    if (mid <= 0 || fairPrice <= 0) continue;
    const signalBps = clamp((fairPrice / mid - 1) * 10_000, -500, 500);
    const previous = next.observations[token];
    if (previous) {
      const elapsed = timestamp - finite(previous.timestamp, 0);
      if (elapsed >= 4 * 60 && elapsed <= 10 * 60 && Math.abs(previous.signalBps) >= 1) {
        const forwardBps = (mid / previous.mid - 1) * 10_000;
        const signedGrossEdgeBps = Math.sign(previous.signalBps) * forwardBps;
        next.calibrations[token] = updatedCalibration(
          next.calibrations[token],
          signedGrossEdgeBps,
          makerFeeBps,
        );
        next.observations[token] = { timestamp, mid, signalBps };
      } else if (elapsed > 10 * 60) {
        next.observations[token] = { timestamp, mid, signalBps };
      }
      continue;
    }
    next.observations[token] = { timestamp, mid, signalBps };
  }

  next.updatedAt = report.timestamp;
  return next;
}
