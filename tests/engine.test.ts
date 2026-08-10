import assert from "node:assert/strict";
import test from "node:test";
import { TradingEngine, volumeMaxRiskMode, volumeMaxStrategyConfig } from "@/src/engine";
import type { LoafApi } from "@/src/loaf-client";
import type { SchedulerControl } from "@/src/scheduler";
import { candles, config, detail, market } from "./helpers";

function inactiveApi(): { api: LoafApi; state: { readPastCompetition: boolean } } {
  const state = { readPastCompetition: false };
  const api: LoafApi = {
    async getCompetition() {
      return { rounds: [], featuredRound: null, makerFeeBps: 40, takerFeeBps: 70, queueCount: 0 };
    },
    async getQueuePosition() { throw new Error("should not be called"); },
    async getLeaderboard() { state.readPastCompetition = true; return null; },
    async getMarkets() { state.readPastCompetition = true; return { properties: [] }; },
    async getMarketDetail() { throw new Error("should not be called"); },
    async getCandles() { throw new Error("should not be called"); },
    async getPortfolio() { state.readPastCompetition = true; throw new Error("should not be called"); },
    async getActiveOrders() { state.readPastCompetition = true; return []; },
    async cancelOrder() { throw new Error("should not be called"); },
    async cancelAll() { throw new Error("should not be called"); },
    async placeOrder() { throw new Error("should not be called"); },
  };
  return { api, state };
}

test("inactive competition is a hard gate by default", async () => {
  const { api, state } = inactiveApi();
  const report = await new TradingEngine(api, config()).run();
  assert.equal(report.competition.active, false);
  assert.equal(report.actions[0]?.result, "no active competition round");
  assert.equal(state.readPastCompetition, false);
});

test("a scheduled draft round holds new orders even when outside-round trading was previously enabled", async () => {
  const { api, state } = inactiveApi();
  api.getCompetition = async () => ({
    rounds: [{ roundNumber: 1, name: "Volumemaxxing", status: "DRAFT" }],
    featuredRound: { roundNumber: 1, name: "Volumemaxxing", status: "DRAFT" },
    makerFeeBps: 0,
    takerFeeBps: 10,
    queueCount: 0,
  });

  const report = await new TradingEngine(api, config({ allowOutsideCompetition: true })).run();
  assert.equal(report.mode, "dry-run");
  assert.match(report.actions[0]?.result ?? "", /preserving capital/);
  assert.match(report.warnings[0] ?? "", /HOLD_DURING_DRAFT_ROUND/);
  assert.equal(state.readPastCompetition, false);
});

test("volume-max round scans every LIVE market and force-includes the featured arena asset", async () => {
  const now = Math.floor(Date.now() / 1000);
  const series = candles(now, 0.0001);
  const tokens = ["terafab", "opera", "eiffel", "liberty", "monaco", "marina", "goldengate", "yongin", "metlife", "rainier", "deepwaterbay"];
  const markets = tokens.map((token, index) => ({
    ...market,
    propertyId: index + 1,
    tokenName: token,
    ticker: token.slice(0, 4).toUpperCase(),
    volume24h: token === "terafab" ? 0 : 1_000_000 + index,
    isCompetition: token === "terafab",
    candlesticks: series,
  }));
  const requested = new Set<string>();
  const api: LoafApi = {
    async getCompetition() {
      return {
        rounds: [{ roundNumber: 1, name: "Volumemaxxing", status: "ACTIVE" }],
        featuredRound: {
          roundNumber: 1,
          name: "Volumemaxxing",
          status: "ACTIVE",
          startsAt: now - 2 * 60 * 60,
          endsAt: now + 3 * 24 * 60 * 60,
          startingBalanceUsdl: 100_000,
          newAssetProperty: { propertyId: 1, tokenName: "terafab" },
          volumeMultiplierTiers: [{ minVolume: 0, multiplier: 1 }, { minVolume: 5_000_000, multiplier: 2 }],
        },
        makerFeeBps: 0,
        takerFeeBps: 10,
        queueCount: 0,
      };
    },
    async getQueuePosition() { return { position: null, finalPlacement: null, queueCount: 0 }; },
    async getLeaderboard() {
      return {
        roundNumber: 1,
        entries: [
          { rank: 1, handle: "one", walletAddress: "0x1", points: 1_200_000, volume: 1_200_000, pnl: 0 },
          { rank: 2, handle: "two", walletAddress: "0x2", points: 1_100_000, volume: 1_100_000, pnl: 0 },
          { rank: 3, handle: "three", walletAddress: "0x3", points: 1_000_000, volume: 1_000_000, pnl: 0 },
        ],
      };
    },
    async getMarkets() { return { properties: markets, competitionModeActive: true }; },
    async getMarketDetail(tokenName) {
      requested.add(tokenName);
      const selected = markets.find((item) => item.tokenName === tokenName)!;
      return {
        ...detail,
        property: { ...detail.property, propertyId: selected.propertyId, tokenName, ticker: selected.ticker },
      };
    },
    async getCandles() { return { resolution: "5m", candles: series, oldestTs: series[0].time, hasMore: false }; },
    async getPortfolio() {
      return {
        cash: 100_000,
        frozen: 0,
        portfolioValue: 100_000,
        portfolioPnl: 0,
        portfolioPnlPercent: 0,
        positions: [],
        applicableFees: { makerFeeBps: 0, takerFeeBps: 10 },
      };
    },
    async getActiveOrders() { return []; },
    async cancelOrder() { throw new Error("dry-run must not cancel"); },
    async cancelAll() { throw new Error("dry-run must not cancel all"); },
    async placeOrder() { throw new Error("dry-run must not place"); },
  };

  const report = await new TradingEngine(api, config({ volumeMaxMarketsPerTick: 12 })).run();
  assert.equal(requested.size, tokens.length);
  assert.equal(requested.has("terafab"), true);
  assert.equal(requested.has("opera"), true);
  assert.equal(report.actions.filter((action) => action.action === "place").length, 10);
  assert.equal(report.leaderboard?.volumeMaxMode, true);
  assert.ok((report.leaderboard?.volumeTarget ?? 0) > 30_000_000);
  assert.equal(report.leaderboard?.rankChasingActive, true);
  assert.equal(report.leaderboard?.thirdPlaceVolume, 1_000_000);
});

test("volume-max mode does not shrink a leading trader below balanced maker sizing", () => {
  assert.equal(volumeMaxRiskMode("preserve", true), "balanced");
  assert.equal(volumeMaxRiskMode("attack", true), "attack");
  assert.equal(volumeMaxRiskMode("preserve", false), "preserve");
});

test("a fresh WebSocket cache avoids REST book and candle reads during an active tick", async () => {
  const now = Math.floor(Date.now() / 1000);
  const series = candles(now, 0.0001);
  let marketReads = 0;
  const api: LoafApi = {
    async getCompetition() {
      return {
        rounds: [{ roundNumber: 1, name: "Volumemaxxing", status: "ACTIVE" }],
        featuredRound: {
          roundNumber: 1,
          name: "Volumemaxxing",
          status: "ACTIVE",
          startsAt: now - 3 * 60 * 60,
          endsAt: now + 3 * 24 * 60 * 60,
          startingBalanceUsdl: 100_000,
        },
        makerFeeBps: 0,
        takerFeeBps: 10,
        queueCount: 0,
      };
    },
    async getQueuePosition() { return { position: null, finalPlacement: null, queueCount: 0 }; },
    async getLeaderboard() { return { roundNumber: 1, entries: [] }; },
    async getMarkets() { return { properties: [market], competitionModeActive: true }; },
    async getMarketDetail() { marketReads += 1; throw new Error("fresh cache should be used"); },
    async getCandles() { marketReads += 1; throw new Error("fresh cache should be used"); },
    async getPortfolio() {
      return {
        cash: 100_000,
        frozen: 0,
        portfolioValue: 100_000,
        portfolioPnl: 0,
        portfolioPnlPercent: 0,
        positions: [],
        applicableFees: { makerFeeBps: 0, takerFeeBps: 10 },
      };
    },
    async getActiveOrders() { return []; },
    async cancelOrder() { throw new Error("dry-run must not cancel"); },
    async cancelAll() { throw new Error("dry-run must not cancel all"); },
    async placeOrder() { throw new Error("dry-run must not place"); },
  };
  const cache = new Map([[market.tokenName, { detail, candles: series, updatedAt: Date.now() }]]);
  const report = await new TradingEngine(api, config(), undefined, {}, undefined, cache).run();
  assert.equal(marketReads, 0);
  assert.equal(report.decisions.length, 1);
});

test("rank chasing uses the full catch-up scale until the projected P3 pace is met", () => {
  const base = config({ volumeMaxPointsOrderNotionalPct: 0.75, volumeMaxCatchupScale: 1.25 });
  const passive = volumeMaxStrategyConfig(base, true, 0.9, 0, false);
  const chasing = volumeMaxStrategyConfig(base, true, 0.9, 0, true);
  assert.equal(passive.pointsOrderNotionalPct, 0.75);
  assert.equal(chasing.pointsOrderNotionalPct, 0.9375);
  assert.equal(volumeMaxStrategyConfig(base, true, 0.9, 1.5, true).pointsOrderNotionalPct, 0.75);
});

test("terminal target round cancels open orders before disabling the scheduler", async () => {
  const state = { cancelled: false, schedulerDisabled: false };
  const api: LoafApi = {
    async getCompetition() {
      return {
        rounds: [{ roundNumber: 3, status: "COMPLETED" }],
        featuredRound: null,
        makerFeeBps: 40,
        takerFeeBps: 70,
        queueCount: 0,
      };
    },
    async getQueuePosition() { throw new Error("should not be called"); },
    async getLeaderboard() { throw new Error("should not be called"); },
    async getMarkets() { throw new Error("should not be called"); },
    async getMarketDetail() { throw new Error("should not be called"); },
    async getCandles() { throw new Error("should not be called"); },
    async getPortfolio() { throw new Error("should not be called"); },
    async getActiveOrders() {
      return [{ id: 9, propertyId: 1, tokenName: "opera", side: "BUY", quantity: 1, price: 100 }];
    },
    async cancelOrder() { throw new Error("should not be called"); },
    async cancelAll() {
      state.cancelled = true;
      return { requestedCount: 1, cancelledOrderIds: [9], failedOrders: [] };
    },
    async placeOrder() { throw new Error("should not be called"); },
  };
  const scheduler: SchedulerControl = {
    async disable() {
      assert.equal(state.cancelled, true, "open orders must be cancelled before shutdown");
      state.schedulerDisabled = true;
      return { jobId: 42, disabled: true };
    },
  };

  const report = await new TradingEngine(
    api,
    config({ tradingEnabled: true, stopAfterRoundNumber: 3 }),
    scheduler,
  ).run();

  assert.equal(state.schedulerDisabled, true);
  assert.equal(report.actions.some((action) => action.action === "cancel"), true);
  assert.equal(report.actions.some((action) => action.action === "scheduler"), true);
});

test("scheduler stays enabled when post-round cancellation is incomplete", async () => {
  let schedulerDisabled = false;
  const api: LoafApi = {
    async getCompetition() {
      return {
        rounds: [{ roundNumber: 3, status: "ENDED" }],
        featuredRound: null,
        makerFeeBps: 40,
        takerFeeBps: 70,
        queueCount: 0,
      };
    },
    async getQueuePosition() { throw new Error("should not be called"); },
    async getLeaderboard() { throw new Error("should not be called"); },
    async getMarkets() { throw new Error("should not be called"); },
    async getMarketDetail() { throw new Error("should not be called"); },
    async getCandles() { throw new Error("should not be called"); },
    async getPortfolio() { throw new Error("should not be called"); },
    async getActiveOrders() {
      return [{ id: 9, propertyId: 1, tokenName: "opera", side: "BUY", quantity: 1, price: 100 }];
    },
    async cancelOrder() { throw new Error("should not be called"); },
    async cancelAll() {
      return { requestedCount: 1, cancelledOrderIds: [], failedOrders: [{ orderId: 9, errorMessage: "busy" }] };
    },
    async placeOrder() { throw new Error("should not be called"); },
  };
  const scheduler: SchedulerControl = {
    async disable() {
      schedulerDisabled = true;
      return { jobId: 42, disabled: true };
    },
  };

  const report = await new TradingEngine(
    api,
    config({ tradingEnabled: true, stopAfterRoundNumber: 3 }),
    scheduler,
  ).run();

  assert.equal(schedulerDisabled, false);
  assert.equal(report.warnings.some((warning) => warning.includes("scheduler remains enabled")), true);
});

test("dry-run reconciliation keeps one fresh quote and removes its duplicate", async () => {
  const now = Math.floor(Date.now() / 1000);
  const series = candles(now, 0.006);
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
    async getQueuePosition() {
      return { position: null, finalPlacement: null, queueCount: 0 };
    },
    async getLeaderboard() { return { roundNumber: 1, entries: [] }; },
    async getMarkets() { return { properties: [{ ...market, candlesticks: series }], competitionModeActive: true }; },
    async getMarketDetail() { return detail; },
    async getCandles() { return { resolution: "5m", candles: series, oldestTs: series[0].time, hasMore: false }; },
    async getPortfolio() {
      return {
        cash: 100_000,
        frozen: 0,
        portfolioValue: 100_000,
        portfolioPnl: 0,
        portfolioPnlPercent: 0,
        positions: [],
        applicableFees: { makerFeeBps: 40, takerFeeBps: 70 },
      };
    },
    async getActiveOrders() {
      return [1, 2].map((id) => ({
        id,
        propertyId: 1,
        tokenName: "opera",
        side: "BUY" as const,
        quantity: 10,
        price: 100.01,
        createdAt: now,
      }));
    },
    async cancelOrder() { throw new Error("dry-run must not cancel"); },
    async cancelAll() { throw new Error("dry-run must not cancel all"); },
    async placeOrder() { throw new Error("dry-run must not place"); },
  };

  const report = await new TradingEngine(api, config()).run();
  assert.equal(report.mode, "dry-run");
  assert.equal(report.actions.filter((action) => action.action === "cancel").length, 1);
  assert.equal(report.actions.some((action) => action.result === "fresh equivalent order already active"), true);
  assert.equal(report.actions.some((action) => action.action === "place"), false);
});
