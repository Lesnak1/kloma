import assert from "node:assert/strict";
import test from "node:test";
import {
  assessStanding,
  explicitMarketMultiplier,
  portfolioDrawdownPct,
  volumePaceForRound,
  volumeMultiplierForStanding,
} from "@/src/risk";
import { market } from "./helpers";

test("bottom thirty standing selects bounded attack mode", () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    rank: index + 1,
    handle: `trader-${index + 1}`,
    walletAddress: `0x${index + 1}`,
    points: 100 - index,
    volume: 1_000,
    pnl: 0,
  }));
  const standing = assessStanding(
    { roundNumber: 1, entries },
    { handle: "trader-8" },
  );
  assert.equal(standing.bottomThirtyCutoffRank, 7);
  assert.equal(standing.rank, 8);
  assert.equal(standing.riskMode, "attack");
});

test("unknown multiplier formats never invent a bonus", () => {
  assert.equal(explicitMarketMultiplier([{ label: "new", boost: 5 }], market), 1);
  assert.equal(explicitMarketMultiplier([{ tokenName: "opera", multiplier: 3 }], market), 3);
  assert.equal(explicitMarketMultiplier([{ tokenName: "opera", multiplier: 100 }], market), 1);
});

test("drawdown is measured from round starting capital", () => {
  assert.equal(portfolioDrawdownPct(92_000, 100_000), 8);
  assert.equal(portfolioDrawdownPct(105_000, 100_000), 0);
});

test("global volume tiers select the earned multiplier and expose the next target", () => {
  const tiers = [
    { minVolume: 0, multiplier: 1 },
    { minVolume: 50_000, multiplier: 1.5 },
    { minVolume: 250_000, multiplier: 2 },
  ];
  assert.deepEqual(volumeMultiplierForStanding(tiers, 80_000), {
    currentMultiplier: 1.5,
    nextThreshold: 250_000,
    nextMultiplier: 2,
  });
});

test("unknown volume tier shapes fail closed at a 1x multiplier", () => {
  assert.deepEqual(volumeMultiplierForStanding([{ boost: 10, target: "soon" }], 1_000_000), {
    currentMultiplier: 1,
    nextThreshold: null,
    nextMultiplier: null,
  });
});

test("round volume pace exposes catch-up target without inventing an early ratio", () => {
  const round = { roundNumber: 1, startsAt: 1_000, endsAt: 2_000, status: "ACTIVE" };
  assert.deepEqual(volumePaceForRound(round, 0, 20_000_000, 1_005_000), {
    targetVolume: 20_000_000,
    expectedVolume: 100_000,
    paceRatio: null,
  });
  const pace = volumePaceForRound(round, 4_000_000, 20_000_000, 1_500_000);
  assert.equal(pace.expectedVolume, 10_000_000);
  assert.equal(pace.paceRatio, 0.4);
});
