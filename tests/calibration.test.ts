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
  const second = report("2026-08-01T00:05:00.000Z", 101, 102);
  const state = updateDurableState(updateDurableState(emptyDurableState(), first), second);
  const calibration = state.calibrations.opera;
  assert.equal(calibration.samples, 1);
  assert.ok(calibration.emaNetEdgeBps > 0, "100bps gross should remain positive after an 80bps round trip");
  assert.equal(calibration.sizeScale, 0.7, "small samples stay conservatively sized");
  assert.equal(calibration.thresholdAddBps, 10);
});

test("replay reports fee-adjusted directional quality", () => {
  const result = analyzeReplay([
    report("2026-08-01T00:10:00.000Z", 102, 103),
    report("2026-08-01T00:00:00.000Z", 100, 101),
    report("2026-08-01T00:05:00.000Z", 101, 102),
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
    const timestamp = new Date(Date.UTC(2026, 7, 1, 0, index * 5)).toISOString();
    const mid = 100 * 0.995 ** index;
    state = updateDurableState(state, report(timestamp, mid, mid * 1.01));
  }
  const calibration = state.calibrations.opera;
  assert.ok(calibration.samples >= 10);
  assert.ok(calibration.sizeScale <= 0.55);
  assert.ok(calibration.thresholdAddBps > 10);
  assert.ok(calibration.thresholdAddBps <= 60);
});
