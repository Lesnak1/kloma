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
    candles: candles(now, 0.006),
    portfolioValue: 100_000,
    cash: 100_000,
    grossExposure: 0,
    makerFeeBps: 40,
    takerFeeBps: 70,
    riskMode: "balanced",
    multiplier: 1,
    nowSeconds: now,
  });
  const buy = decision.desiredOrders.find((order) => order.side === "BUY");
  assert.ok(buy);
  assert.ok(buy.price < 102);
  assert.ok(buy.price * buy.quantity <= 300 + buy.price * 0.1, "buy respects 15% exit-book participation");
  assert.equal(Number((buy.quantity * 10).toFixed(8)) % 1, 0);
  assert.equal(decision.desiredOrders.some((order) => order.side === "SELL"), false);
});

test("dynamic take profit offers the full position without crossing the book", () => {
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
      averageEntryPrice: 98,
      marketPrice: 100.5,
      propertyPnlPercent: 3,
    },
    portfolioValue: 100_000,
    cash: 50_000,
    grossExposure: 743.7,
    makerFeeBps: 40,
    takerFeeBps: 70,
    riskMode: "balanced",
    multiplier: 1,
    nowSeconds: now,
  });
  const sell = decision.desiredOrders.find((order) => order.side === "SELL");
  assert.ok(sell);
  assert.equal(sell.timeInForce, "GTC");
  assert.equal(sell.quantity, 7.4);
  assert.ok(sell.rationale.includes("volatility-take-profit"));
});

test("an extreme negative calibration quarantines new inventory while retaining metrics", () => {
  const now = 1_800_000_000;
  const decision = decideMarket({
    config: config(),
    market,
    detail,
    candles: candles(now, 0.006),
    portfolioValue: 100_000,
    cash: 100_000,
    grossExposure: 0,
    makerFeeBps: 40,
    takerFeeBps: 70,
    riskMode: "balanced",
    multiplier: 1,
    calibration: {
      samples: 1,
      emaNetEdgeBps: -100,
      directionalAccuracy: 0,
      sizeScale: 0.45,
      thresholdAddBps: 100,
    },
    nowSeconds: now,
  });
  assert.equal(decision.reason, "calibration-quarantine");
  assert.equal(decision.desiredOrders.length, 0);
  assert.equal(decision.metrics.calibrationQuarantined, true);
  assert.ok(Number.isFinite(decision.metrics.fairPrice));
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
    takerFeeBps: 70,
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
    takerFeeBps: 70,
    riskMode: "balanced",
    multiplier: 1,
    nowSeconds: now,
  });
  assert.equal(decision.state, "halt");
  assert.equal(decision.desiredOrders.length, 0);
});
