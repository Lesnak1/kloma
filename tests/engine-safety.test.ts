import assert from "node:assert/strict";
import test from "node:test";
import { TradingEngine } from "@/src/engine";
import type { LoafApi } from "@/src/loaf-client";
import { candles, config, detail, market } from "./helpers";

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

test("queue position can be advisory while the exchange remains the final order gate", async () => {
  const now = Math.floor(Date.now() / 1000);
  let placements = 0;
  const api: LoafApi = {
    async getCompetition() {
      return {
        rounds: [{ roundNumber: 1, name: "Volumemaxxing", status: "ACTIVE" }],
        featuredRound: {
          roundNumber: 1,
          name: "Volumemaxxing",
          status: "ACTIVE",
          startsAt: now - 60 * 60,
          endsAt: now + 60 * 60,
          startingBalanceUsdl: 100_000,
          newAssetProperty: { propertyId: market.propertyId, tokenName: market.tokenName },
        },
        makerFeeBps: 0,
        takerFeeBps: 10,
        queueCount: 100,
      };
    },
    async getQueuePosition() { return { position: 12, queueCount: 100, finalPlacement: null }; },
    async getLeaderboard() { return { roundNumber: 1, entries: [] }; },
    async getMarkets() { return { properties: [market] }; },
    async getMarketDetail() { return detail; },
    async getCandles() { return { resolution: "5m", candles: candles(now, 0.0001), oldestTs: now - 3600, hasMore: false }; },
    async getPortfolio() {
      return {
        cash: 100_000,
        frozen: 0,
        portfolioValue: 100_000,
        portfolioPnl: 0,
        portfolioPnlPercent: 0,
        positions: [],
      };
    },
    async getActiveOrders() { return []; },
    async cancelOrder() { throw new Error("not needed"); },
    async cancelAll() { throw new Error("not needed"); },
    async placeOrder() { placements += 1; return { success: true, orderId: 1 }; },
  };
  const report = await new TradingEngine(api, config({
    tradingEnabled: true,
    queuePositionAdvisory: true,
    volumeMaxTargetVolume: 1_000_000,
    volumeMaxPointsOrderNotionalPct: 1,
  })).run();
  assert.equal(report.mode, "live");
  assert.equal(report.competition.admitted, false);
  assert.ok(placements > 0);
  assert.match(report.warnings.join(" "), /QUEUE_POSITION_ADVISORY/);
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

test("drawdown breaker protects compounded gains without an active round", async () => {
  let cancelled = 0;
  const api: LoafApi = {
    async getCompetition() {
      return { rounds: [], featuredRound: null, makerFeeBps: 0, takerFeeBps: 70, queueCount: 0 };
    },
    async getQueuePosition() { return forbidden(); },
    async getLeaderboard() { return null; },
    async getMarkets() { return { properties: [] }; },
    async getMarketDetail() { return forbidden(); },
    async getCandles() { return forbidden(); },
    async getPortfolio() {
      return { cash: 110_000, frozen: 0, portfolioValue: 110_000, portfolioPnl: 0, portfolioPnlPercent: 0, positions: [] };
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
    config({ tradingEnabled: true, allowOutsideCompetition: true, maxDrawdownPct: 8 }),
    undefined,
    {},
    { roundNumber: null, peakPortfolioValue: 120_000 },
  ).run();
  assert.equal(cancelled, 1);
  assert.equal(report.mode, "halted");
  assert.match(report.warnings[0], /Drawdown/);
});
