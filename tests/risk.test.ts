import assert from "node:assert/strict";
import test from "node:test";
import {
  assessStanding,
  explicitMarketMultiplier,
  portfolioDrawdownPct,
  rankChaseTargetForRound,
  volumePaceForRound,
  volumeMultiplierForStanding,
} from "@/src/risk";
import { volumeMaxRiskMode } from "@/src/engine";
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

test("rank chasing projects third place with a margin after enough of the round has elapsed", () => {
  const round = { roundNumber: 1, startsAt: 1_000, endsAt: 11_000, status: "ACTIVE" };
  const target = rankChaseTargetForRound(
    round,
    {
      roundNumber: 1,
      entries: [
        { rank: 1, handle: "one", walletAddress: "0x1", points: 10_000_000, volume: 9_000_000, pnl: 0 },
        { rank: 2, handle: "two", walletAddress: "0x2", points: 9_000_000, volume: 8_000_000, pnl: 0 },
        { rank: 3, handle: "three", walletAddress: "0x3", points: 8_000_000, volume: 7_000_000, pnl: 0 },
      ],
    },
    {
      baselineTargetVolume: 30_000_000,
      enabled: true,
      safetyMarginPct: 12,
      minElapsedPct: 2,
      maxTargetVolume: 1_000_000_000,
    },
    6_000_000,
  );
  assert.equal(target.leaderboardProjectionActive, true);
  assert.equal(target.thirdPlaceVolume, 7_000_000);
  assert.equal(target.thirdPlacePoints, 8_000_000);
  assert.equal(target.thirdPlaceProjectedVolume, 14_000_000);
  assert.equal(target.targetVolume, 30_000_000);
  assert.equal(target.thirdPlaceProjectedPoints, 16_000_000);
});

test("rank chasing raises the pace goal above the tier floor and caps malformed projections", () => {
  const round = { roundNumber: 1, startsAt: 1_000, endsAt: 11_000, status: "ACTIVE" };
  const leaderboard = {
    roundNumber: 1,
    entries: [
      { rank: 1, handle: "one", walletAddress: "0x1", points: 1, volume: 100_000_000, pnl: 0 },
      { rank: 2, handle: "two", walletAddress: "0x2", points: 1, volume: 95_000_000, pnl: 0 },
      { rank: 3, handle: "three", walletAddress: "0x3", points: 1, volume: 90_000_000, pnl: 0 },
    ],
  };
  const raised = rankChaseTargetForRound(round, leaderboard, {
    baselineTargetVolume: 30_000_000,
    enabled: true,
    safetyMarginPct: 12,
    minElapsedPct: 2,
    maxTargetVolume: 1_000_000_000,
  }, 6_000_000);
  assert.ok(Math.abs(raised.targetVolume - 201_600_000) < 0.01);

  const capped = rankChaseTargetForRound(round, leaderboard, {
    baselineTargetVolume: 30_000_000,
    enabled: true,
    safetyMarginPct: 12,
    minElapsedPct: 2,
    maxTargetVolume: 100_000_000,
  }, 1_300_000);
  assert.equal(capped.targetVolume, 100_000_000);
});

test("rank chasing remains at the baseline before enough data exists", () => {
  const target = rankChaseTargetForRound(
    { roundNumber: 1, startsAt: 1_000, endsAt: 11_000, status: "ACTIVE" },
    { roundNumber: 1, entries: [{ rank: 3, handle: "three", walletAddress: "0x3", points: 1, volume: 90_000_000, pnl: 0 }] },
    {
      baselineTargetVolume: 30_000_000,
      enabled: true,
      safetyMarginPct: 12,
      minElapsedPct: 2,
      maxTargetVolume: 1_000_000_000,
    },
    1_100_000,
  );
  assert.equal(target.leaderboardProjectionActive, false);
  assert.equal(target.targetVolume, 30_000_000);
});

test("volume maximization stays in bounded attack mode while behind target pace", () => {
  assert.equal(volumeMaxRiskMode("preserve", true, 0.99), "attack");
  assert.equal(volumeMaxRiskMode("balanced", true, null), "balanced");
  assert.equal(volumeMaxRiskMode("preserve", true, 1), "balanced");
  assert.equal(volumeMaxRiskMode("attack", false, 0), "attack");
});
