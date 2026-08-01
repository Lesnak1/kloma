import assert from "node:assert/strict";
import test from "node:test";
import { decideMarket } from "@/src/strategy";
import { candles, config, detail, market } from "./helpers";

test("strategy produces a non-crossing, precision-safe buy without shorting", () => {
  const now = 1_800_000_000;
  const decision = decideMarket({
    config: config(),
    market,
    detail,
    candles: candles(now, 0.0015),
    portfolioValue: 100_000,
    cash: 100_000,
    grossExposure: 0,
    makerFeeBps: 40,
    riskMode: "balanced",
    multiplier: 1,
    nowSeconds: now,
  });
  const buy = decision.desiredOrders.find((order) => order.side === "BUY");
  assert.ok(buy);
  assert.ok(buy.price < 102);
  assert.equal(Number((buy.quantity * 10).toFixed(8)) % 1, 0);
  assert.equal(decision.desiredOrders.some((order) => order.side === "SELL"), false);
});

test("stop loss creates an IOC sell capped by tradeable position", () => {
  const now = 1_800_000_000;
  const decision = decideMarket({
    config: config(),
    market,
    detail,
    candles: candles(now, 0.0001),
    position: {
      propertyId: 1,
      tokenName: "opera",
      quantity: 7.4,
      averageEntryPrice: 110,
      marketPrice: 101,
      propertyPnlPercent: -5,
    },
    portfolioValue: 100_000,
    cash: 50_000,
    grossExposure: 747.4,
    makerFeeBps: 40,
    riskMode: "balanced",
    multiplier: 1,
    nowSeconds: now,
  });
  const sell = decision.desiredOrders.find((order) => order.side === "SELL");
  assert.ok(sell);
  assert.equal(sell.timeInForce, "IOC");
  assert.ok(sell.quantity <= 7.4);
});

test("large one-bar jump triggers circuit breaker", () => {
  const now = 1_800_000_000;
  const series = candles(now, 0.0001);
  series.at(-1)!.close = series.at(-2)!.close * 1.09;
  const decision = decideMarket({
    config: config(),
    market,
    detail,
    candles: series,
    portfolioValue: 100_000,
    cash: 100_000,
    grossExposure: 0,
    makerFeeBps: 40,
    riskMode: "balanced",
    multiplier: 1,
    nowSeconds: now,
  });
  assert.equal(decision.state, "halt");
  assert.equal(decision.desiredOrders.length, 0);
});
