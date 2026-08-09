import { clamp } from "@/src/indicators";
import type { RunReport } from "@/src/types";

export interface StrategyCalibration {
  samples: number;
  emaNetEdgeBps: number;
  directionalAccuracy: number;
  sizeScale: number;
  thresholdAddBps: number;
}

export function initialStrategyCalibration(): StrategyCalibration {
  return {
    samples: 0,
    emaNetEdgeBps: 0,
    directionalAccuracy: 0.5,
    sizeScale: 0.6,
    thresholdAddBps: 25,
  };
}

export function isCalibrationQuarantined(calibration: StrategyCalibration): boolean {
  if (calibration.samples <= 0) return false;
  if (
    calibration.samples < 4 &&
    calibration.emaNetEdgeBps <= -80 &&
    calibration.directionalAccuracy <= 0.25
  ) {
    return true;
  }
  if (calibration.samples < 10) {
    return calibration.samples >= 4 && (
      calibration.emaNetEdgeBps <= -35 || calibration.directionalAccuracy < 0.38
    );
  }
  return calibration.emaNetEdgeBps <= -15 || calibration.directionalAccuracy < 0.45;
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
  risk: PortfolioRiskState;
}

export interface PortfolioRiskState {
  roundNumber: number | null;
  peakPortfolioValue: number;
}

export function emptyDurableState(): DurableBotState {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    observations: {},
    calibrations: {},
    risk: { roundNumber: null, peakPortfolioValue: 0 },
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
    risk: {
      roundNumber: Number.isInteger(candidate.risk?.roundNumber)
        ? Number(candidate.risk?.roundNumber)
        : null,
      peakPortfolioValue: Math.max(0, finite(candidate.risk?.peakPortfolioValue, 0)),
    },
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

  if (samples < 8) {
    const severeLoss = emaNetEdgeBps <= -80 || directionalAccuracy <= 0.25;
    return {
      samples,
      emaNetEdgeBps,
      directionalAccuracy,
      sizeScale: severeLoss ? 0.45 : 0.6,
      thresholdAddBps: severeLoss ? 100 : 25,
    };
  }
  const qualityBoost = Math.max(0, emaNetEdgeBps) / 100 + Math.max(0, directionalAccuracy - 0.5) * 0.9;
  const sizeScale = clamp(0.5 + qualityBoost, 0.4, 1.2);
  const edgePenalty = Math.max(0, -emaNetEdgeBps);
  const accuracyPenalty = Math.max(0, 0.48 - directionalAccuracy) * 100;
  const thresholdAddBps = clamp(edgePenalty + accuracyPenalty, 0, 120);
  return { samples, emaNetEdgeBps, directionalAccuracy, sizeScale, thresholdAddBps };
}

export function updateDurableState(state: DurableBotState, report: RunReport): DurableBotState {
  const next = normalizeDurableState(state);
  const now = Date.parse(report.timestamp);
  if (!Number.isFinite(now)) return next;
  const timestamp = Math.floor(now / 1000);
  const makerFeeBps = Math.max(0, finite(report.fees?.makerFeeBps, 0));
  const portfolioValue = Math.max(0, finite(report.portfolio?.value, 0));
  const roundNumber = report.competition.roundNumber;
  if (portfolioValue > 0) {
    next.risk = next.risk.roundNumber === roundNumber
      ? { roundNumber, peakPortfolioValue: Math.max(next.risk.peakPortfolioValue, portfolioValue) }
      : { roundNumber, peakPortfolioValue: portfolioValue };
  }

  for (const decision of report.decisions) {
    const token = decision.tokenName.toLowerCase();
    const mid = finite(decision.metrics.mid, 0);
    const fairPrice = finite(decision.metrics.fairPrice, 0);
    if (mid <= 0 || fairPrice <= 0) continue;
    const signalBps = clamp((fairPrice / mid - 1) * 10_000, -500, 500);
    const previous = next.observations[token];
    if (previous) {
      const elapsed = timestamp - finite(previous.timestamp, 0);
      if (elapsed >= 15 * 60 && elapsed <= 45 * 60 && Math.abs(previous.signalBps) >= 1) {
        const forwardBps = (mid / previous.mid - 1) * 10_000;
        const signedGrossEdgeBps = Math.sign(previous.signalBps) * forwardBps;
        next.calibrations[token] = updatedCalibration(
          next.calibrations[token],
          signedGrossEdgeBps,
          makerFeeBps,
        );
        next.observations[token] = { timestamp, mid, signalBps };
      } else if (elapsed > 45 * 60) {
        next.observations[token] = { timestamp, mid, signalBps };
      }
      continue;
    }
    next.observations[token] = { timestamp, mid, signalBps };
  }

  next.updatedAt = report.timestamp;
  return next;
}
