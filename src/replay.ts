import type { RunReport } from "@/src/types";

export interface ReplayMarketResult {
  tokenName: string;
  samples: number;
  directionalAccuracy: number | null;
  averageGrossEdgeBps: number | null;
  averageNetEdgeBps: number | null;
  worstNetEdgeBps: number | null;
}

export interface ReplayResult {
  generatedAt: string;
  runCount: number;
  samples: number;
  weightedDirectionalAccuracy: number | null;
  weightedAverageNetEdgeBps: number | null;
  portfolioReturnPct: number | null;
  portfolioMaxDrawdownPct: number | null;
  markets: ReplayMarketResult[];
}

interface Point {
  timestamp: number;
  mid: number;
  signalBps: number;
  makerFeeBps: number;
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function analyzeReplay(runs: RunReport[]): ReplayResult {
  const byMarket = new Map<string, Point[]>();
  for (const run of runs) {
    const timestamp = Date.parse(run.timestamp) / 1000;
    if (!Number.isFinite(timestamp)) continue;
    for (const decision of run.decisions) {
      const mid = Number(decision.metrics.mid);
      const fairPrice = Number(decision.metrics.fairPrice);
      if (!Number.isFinite(mid) || !Number.isFinite(fairPrice) || mid <= 0 || fairPrice <= 0) continue;
      const signalBps = (fairPrice / mid - 1) * 10_000;
      if (Math.abs(signalBps) < 1) continue;
      const token = decision.tokenName.toLowerCase();
      const points = byMarket.get(token) ?? [];
      points.push({
        timestamp,
        mid,
        signalBps,
        makerFeeBps: Math.max(0, Number(run.fees?.makerFeeBps ?? 0)),
      });
      byMarket.set(token, points);
    }
  }

  const markets: ReplayMarketResult[] = [];
  for (const [tokenName, unsorted] of byMarket) {
    const points = [...unsorted].sort((left, right) => left.timestamp - right.timestamp);
    const grossEdges: number[] = [];
    const netEdges: number[] = [];
    for (let index = 0; index + 1 < points.length; index += 1) {
      const current = points[index];
      const next = points.slice(index + 1).find((candidate) => candidate.timestamp - current.timestamp >= 4 * 60);
      if (!next) continue;
      const elapsed = next.timestamp - current.timestamp;
      if (elapsed > 10 * 60) continue;
      const forwardBps = (next.mid / current.mid - 1) * 10_000;
      const grossEdge = Math.sign(current.signalBps) * forwardBps;
      grossEdges.push(grossEdge);
      netEdges.push(grossEdge - current.makerFeeBps * 2);
    }
    const correct = grossEdges.filter((value) => value > 0).length;
    markets.push({
      tokenName,
      samples: grossEdges.length,
      directionalAccuracy: grossEdges.length > 0 ? correct / grossEdges.length : null,
      averageGrossEdgeBps: mean(grossEdges),
      averageNetEdgeBps: mean(netEdges),
      worstNetEdgeBps: netEdges.length > 0 ? Math.min(...netEdges) : null,
    });
  }
  markets.sort((left, right) => right.samples - left.samples);
  const sampleCount = markets.reduce((sum, market) => sum + market.samples, 0);
  const weightedAccuracy = markets.reduce(
    (sum, market) => sum + (market.directionalAccuracy ?? 0) * market.samples,
    0,
  );
  const weightedNetEdge = markets.reduce(
    (sum, market) => sum + (market.averageNetEdgeBps ?? 0) * market.samples,
    0,
  );
  const portfolioSeries = runs
    .map((run) => ({ timestamp: Date.parse(run.timestamp), value: Number(run.portfolio?.value) }))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value) && point.value > 0)
    .sort((left, right) => left.timestamp - right.timestamp);
  const firstValue = portfolioSeries.at(0)?.value;
  const lastValue = portfolioSeries.at(-1)?.value;
  let peak = firstValue ?? 0;
  let maxDrawdownPct = 0;
  for (const point of portfolioSeries) {
    peak = Math.max(peak, point.value);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - point.value) / peak) * 100);
  }
  return {
    generatedAt: new Date().toISOString(),
    runCount: runs.length,
    samples: sampleCount,
    weightedDirectionalAccuracy: sampleCount > 0 ? weightedAccuracy / sampleCount : null,
    weightedAverageNetEdgeBps: sampleCount > 0 ? weightedNetEdge / sampleCount : null,
    portfolioReturnPct:
      firstValue && lastValue ? ((lastValue - firstValue) / firstValue) * 100 : null,
    portfolioMaxDrawdownPct: portfolioSeries.length > 0 ? maxDrawdownPct : null,
    markets,
  };
}
