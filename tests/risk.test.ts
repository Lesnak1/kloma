import assert from "node:assert/strict";
import test from "node:test";
import { assessStanding, explicitMarketMultiplier, portfolioDrawdownPct } from "@/src/risk";
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
});

test("drawdown is measured from round starting capital", () => {
  assert.equal(portfolioDrawdownPct(92_000, 100_000), 8);
  assert.equal(portfolioDrawdownPct(105_000, 100_000), 0);
});
