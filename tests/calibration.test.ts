import assert from "node:assert/strict";
import test from "node:test";
import { emptyDurableState, updateDurableState } from "@/src/calibration";
import { analyzeReplay } from "@/src/replay";
import type { RunReport } from "@/src/types";

function report(timestamp: string, mid: number, fairPrice: number): RunReport {
  return {
    runId: timestamp,
    timestamp,
    mode: "dry-run",
    competition: { active: true, roundNumber: 1, roundStatus: "ACTIVE", admitted: true },
    fees: { makerFeeBps: 40, takerFeeBps: 70 },
    decisions: [
      {
        tokenName: "opera",
        propertyId: 1,
        state: "quote",
        reason: "test",
        riskMode: "balanced",
        metrics: { mid, fairPrice },
        desiredOrders: [],
      },
    ],
    actions: [],
    warnings: [],
    durationMs: 1,
  };
}

test("adaptive calibration learns paper edge after round-trip fees", () => {
  const first = report("2026-08-01T00:00:00.000Z", 100, 101);
  const second = report("2026-08-01T00:20:00.000Z", 102, 103);
  const state = updateDurableState(updateDurableState(emptyDurableState(), first), second);
  const calibration = state.calibrations.opera;
  assert.equal(calibration.samples, 1);
  assert.ok(calibration.emaNetEdgeBps > 0, "200bps gross should remain positive after an 80bps round trip");
  assert.equal(calibration.sizeScale, 0.6, "small samples stay conservatively sized");
  assert.equal(calibration.thresholdAddBps, 25);
});

test("replay reports fee-adjusted directional quality", () => {
  const result = analyzeReplay([
    report("2026-08-01T00:40:00.000Z", 104, 105),
    report("2026-08-01T00:00:00.000Z", 100, 101),
    report("2026-08-01T00:20:00.000Z", 102, 103),
  ]);
  assert.equal(result.runCount, 3);
  assert.equal(result.samples, 2);
  assert.equal(result.markets[0].tokenName, "opera");
  assert.equal(result.markets[0].directionalAccuracy, 1);
  assert.ok((result.weightedAverageNetEdgeBps ?? -1) > 0);
});

test("persistent losing signals reduce size and increase the entry threshold", () => {
  let state = emptyDurableState();
  for (let index = 0; index < 13; index += 1) {
    const timestamp = new Date(Date.UTC(2026, 7, 1, 0, index * 20)).toISOString();
    const mid = 100 * 0.995 ** index;
    state = updateDurableState(state, report(timestamp, mid, mid * 1.01));
  }
  const calibration = state.calibrations.opera;
  assert.ok(calibration.samples >= 10);
  assert.ok(calibration.sizeScale <= 0.5);
  assert.ok(calibration.thresholdAddBps > 25);
  assert.ok(calibration.thresholdAddBps <= 120);
});

test("durable state tracks the peak separately for each competition round", () => {
  const first = report("2026-08-01T00:00:00.000Z", 100, 101);
  first.portfolio = { value: 110_000, cash: 110_000, frozen: 0, pnl: 10_000, drawdownPct: 0 };
  const second = report("2026-08-01T00:20:00.000Z", 102, 103);
  second.portfolio = { value: 105_000, cash: 105_000, frozen: 0, pnl: 5_000, drawdownPct: 0 };
  const nextRound = report("2026-08-08T00:00:00.000Z", 100, 101);
  nextRound.competition.roundNumber = 2;
  nextRound.portfolio = { value: 100_000, cash: 100_000, frozen: 0, pnl: 0, drawdownPct: 0 };

  let state = updateDurableState(emptyDurableState(), first);
  state = updateDurableState(state, second);
  assert.deepEqual(state.risk, { roundNumber: 1, peakPortfolioValue: 110_000 });
  state = updateDurableState(state, nextRound);
  assert.deepEqual(state.risk, { roundNumber: 2, peakPortfolioValue: 100_000 });
});

test("durable state tracks a high-water mark while the competition API has no round", () => {
  const first = report("2026-08-01T00:00:00.000Z", 100, 101);
  first.competition = { active: false, roundNumber: null, roundStatus: null, admitted: null };
  first.portfolio = { value: 129_000, cash: 100_000, frozen: 0, pnl: 2_000, drawdownPct: 0 };
  const second = report("2026-08-01T00:20:00.000Z", 102, 103);
  second.competition = { active: false, roundNumber: null, roundStatus: null, admitted: null };
  second.portfolio = { value: 125_000, cash: 96_000, frozen: 0, pnl: 1_000, drawdownPct: 0 };

  const state = updateDurableState(updateDurableState(emptyDurableState(), first), second);
  assert.deepEqual(state.risk, { roundNumber: null, peakPortfolioValue: 129_000 });
});
