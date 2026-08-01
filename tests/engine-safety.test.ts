import assert from "node:assert/strict";
import test from "node:test";
import { TradingEngine } from "@/src/engine";
import type { LoafApi } from "@/src/loaf-client";
import { config } from "./helpers";

function forbidden(message = "should not be called"): never {
  throw new Error(message);
}

test("an account outside the admitted batch cannot reach portfolio or order writes", async () => {
  let downstreamReads = 0;
  const api: LoafApi = {
    async getCompetition() {
      return {
        rounds: [{ roundNumber: 1, status: "ACTIVE" }],
        featuredRound: { roundNumber: 1, status: "ACTIVE" },
        makerFeeBps: 40,
        takerFeeBps: 70,
        queueCount: 100,
      };
    },
    async getQueuePosition() { return { position: 12, queueCount: 100, finalPlacement: null }; },
    async getLeaderboard() { downstreamReads += 1; return null; },
    async getMarkets() { downstreamReads += 1; return { properties: [] }; },
    async getMarketDetail() { return forbidden(); },
    async getCandles() { return forbidden(); },
    async getPortfolio() { downstreamReads += 1; return forbidden(); },
    async getActiveOrders() { downstreamReads += 1; return []; },
    async cancelOrder() { return forbidden(); },
    async cancelAll() { return forbidden(); },
    async placeOrder() { return forbidden(); },
  };
  const report = await new TradingEngine(api, config({ tradingEnabled: true })).run();
  assert.equal(report.mode, "halted");
  assert.equal(report.competition.admitted, false);
  assert.equal(downstreamReads, 0);
});

test("kill switch cancels all before any market evaluation", async () => {
  let cancelled = 0;
  const api: LoafApi = {
    async getCompetition() {
      return { rounds: [], featuredRound: null, makerFeeBps: 40, takerFeeBps: 70, queueCount: 0 };
    },
    async getQueuePosition() { return forbidden(); },
    async getLeaderboard() { return forbidden(); },
    async getMarkets() { return forbidden(); },
    async getMarketDetail() { return forbidden(); },
    async getCandles() { return forbidden(); },
    async getPortfolio() { return forbidden(); },
    async getActiveOrders() { return forbidden(); },
    async cancelOrder() { return forbidden(); },
    async cancelAll() {
      cancelled += 1;
      return { requestedCount: 2, cancelledOrderIds: [1, 2], failedOrders: [] };
    },
    async placeOrder() { return forbidden(); },
  };
  const report = await new TradingEngine(api, config({ tradingEnabled: true, killSwitch: true })).run();
  assert.equal(cancelled, 1);
  assert.equal(report.mode, "halted");
  assert.match(report.actions[0].result, /kill-switch/);
});

test("drawdown breaker protects gains using the persisted round peak", async () => {
  let cancelled = 0;
  let details = 0;
  const api: LoafApi = {
    async getCompetition() {
      return {
        rounds: [{ roundNumber: 1, status: "ACTIVE" }],
        featuredRound: { roundNumber: 1, status: "ACTIVE", startingBalanceUsdl: 100_000 },
        makerFeeBps: 40,
        takerFeeBps: 70,
        queueCount: 0,
      };
    },
    async getQueuePosition() { return { position: null, queueCount: 0, finalPlacement: null }; },
    async getLeaderboard() { return { roundNumber: 1, entries: [] }; },
    async getMarkets() { return { properties: [] }; },
    async getMarketDetail() { details += 1; return forbidden(); },
    async getCandles() { return forbidden(); },
    async getPortfolio() {
      return { cash: 110_000, frozen: 0, portfolioValue: 110_000, portfolioPnl: 10_000, portfolioPnlPercent: 10, positions: [] };
    },
    async getActiveOrders() { return []; },
    async cancelOrder() { return forbidden(); },
    async cancelAll() {
      cancelled += 1;
      return { requestedCount: 0, cancelledOrderIds: [], failedOrders: [] };
    },
    async placeOrder() { return forbidden(); },
  };
  const report = await new TradingEngine(
    api,
    config({ tradingEnabled: true, maxDrawdownPct: 8 }),
    undefined,
    {},
    { roundNumber: 1, peakPortfolioValue: 120_000 },
  ).run();
  assert.equal(cancelled, 1);
  assert.equal(details, 0);
  assert.equal(report.mode, "halted");
  assert.match(report.warnings[0], /Drawdown/);
});
