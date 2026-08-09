import assert from "node:assert/strict";
import test from "node:test";
import { decideMarket } from "@/src/strategy";
import { candles, config, detail, market } from "./helpers";

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function tickAligned(value: number, tick: number): boolean {
  return Math.abs(value / tick - Math.round(value / tick)) < 1e-8;
}

test("2,000 deterministic market scenarios preserve execution invariants", () => {
  const random = generator(0x10af2026);
  const now = 1_800_000_000;

  for (let scenario = 0; scenario < 2_000; scenario += 1) {
    const bid = 20 + random() * 480;
    const spreadBps = 5 + random() * 500;
    const ask = bid * (1 + spreadBps / 10_000);
    const positionQuantity = Math.floor(random() * 250) / 10;
    const cash = 10_000 + random() * 90_000;
    const portfolioValue = 100_000;
    const scenarioDetail = {
      ...detail,
      dailyReferencePrice: bid * (0.97 + random() * 0.06),
      orderBook: {
        propertyId: 1,
        bids: [{ price: bid, quantity: 1 + random() * 100 }],
        asks: [{ price: ask, quantity: 1 + random() * 100 }],
      },
    };
    const decision = decideMarket({
      config: config({ maxSpreadBps: 600 }),
      market: { ...market, marketPrice: (bid + ask) / 2 },
      detail: scenarioDetail,
      candles: candles(now, (random() - 0.5) * 0.003, 80),
      position:
        positionQuantity > 0
          ? {
              propertyId: 1,
              tokenName: "opera",
              quantity: positionQuantity,
              averageEntryPrice: bid,
              marketPrice: (bid + ask) / 2,
              propertyPnlPercent: (random() - 0.5) * 12,
            }
          : undefined,
      portfolioValue,
      cash,
      grossExposure: positionQuantity * ((bid + ask) / 2),
      makerFeeBps: Math.floor(random() * 101),
      takerFeeBps: Math.floor(random() * 151),
      riskMode: ["preserve", "balanced", "defend", "attack"][scenario % 4] as
        | "preserve"
        | "balanced"
        | "defend"
        | "attack",
      multiplier: 1 + random(),
      nowSeconds: now,
    });

    const buy = decision.desiredOrders.find((order) => order.side === "BUY");
    const sell = decision.desiredOrders.find((order) => order.side === "SELL");
    for (const order of decision.desiredOrders) {
      assert.ok(Number.isFinite(order.price) && order.price > 0, `scenario ${scenario}: finite price`);
      assert.ok(Number.isFinite(order.quantity) && order.quantity > 0, `scenario ${scenario}: finite quantity`);
      assert.ok(tickAligned(order.price, 0.01), `scenario ${scenario}: tick-aligned price`);
      assert.ok(tickAligned(order.quantity, 0.1), `scenario ${scenario}: quantity precision`);
      assert.ok(order.price * order.quantity >= 10 - 1e-8, `scenario ${scenario}: minimum notional`);
      if (order.side === "BUY") assert.ok(order.price < ask, `scenario ${scenario}: buy must not cross`);
      if (order.side === "SELL" && !order.rationale.includes("volatility-stop-loss")) {
        assert.ok(order.price > bid, `scenario ${scenario}: passive sell must not cross`);
      }
      if (order.rationale.includes("volatility-stop-loss")) {
        assert.ok(order.price >= bid, `scenario ${scenario}: stop loss must be marketable`);
      }
    }
    if (sell) assert.ok(sell.quantity <= positionQuantity + 1e-8, `scenario ${scenario}: no short selling`);
    if (buy && sell) assert.ok(buy.price < sell.price, `scenario ${scenario}: self-trade prevention`);
    if (buy) {
      const availableCash = Math.max(0, cash - portfolioValue * 0.25);
      assert.ok(buy.price * buy.quantity <= availableCash + buy.price * 0.1, `scenario ${scenario}: cash cap`);
    }
  }
});
