import assert from "node:assert/strict";
import test from "node:test";
import { ema, floorQuantity, microPrice, realizedVolatilityBps, roundToTick } from "@/src/indicators";
import { candles } from "./helpers";

test("money and quantity rounding obey exchange precision", () => {
  assert.equal(roundToTick(100.019, 0.01, "down"), 100.01);
  assert.equal(roundToTick(100.011, 0.01, "up"), 100.02);
  assert.equal(floorQuantity(1.29), 1.2);
});

test("microprice leans toward the ask when bid size dominates", () => {
  const price = microPrice({ price: 100, quantity: 30 }, { price: 102, quantity: 10 });
  assert.equal(price, 101.5);
});

test("indicators return finite values", () => {
  const now = 1_800_000_000;
  const series = candles(now, 0.001, 60);
  assert.ok((ema(series.map((item) => item.close), 12) ?? 0) > 0);
  assert.ok(Number.isFinite(realizedVolatilityBps(series)));
});
