import type { BotConfig } from "@/src/config";
import type { Candle, MarketDetail, MarketSummary } from "@/src/types";

export function config(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    apiBaseUrl: "https://api.loafmarkets.com/api",
    apiKey: "a".repeat(64),
    cronSecret: "s".repeat(32),
    tradingEnabled: false,
    allowOutsideCompetition: false,
    queuePositionAdvisory: false,
    holdDuringDraftRound: true,
    killSwitch: false,
    targetTokens: [],
    startingBalanceUsdl: 100_000,
    maxDrawdownPct: 6,
    maxGrossExposurePct: 60,
    maxMarketExposurePct: 12,
    cashReservePct: 25,
    orderNotionalPct: 2,
    compoundingEnabled: true,
    compoundingProfitReinvestPct: 100,
    compoundingMaxEquityMultiplier: 1.5,
    qualitySizeBoostMax: 1.35,
    pointsModeEnabled: true,
    pointsOrderNotionalPct: 0.6,
    pointsMaxMarketExposurePct: 3,
    pointsDrawdownStopPct: 2,
    pointsMaxRoundTripCostBps: 90,
    volumeMaxMode: true,
    volumeMaxRoundNumber: 1,
    volumeMaxTargetVolume: 30_000_000,
    volumeRankChasingEnabled: true,
    volumeRankChasingMarginPct: 12,
    volumeRankChasingMinElapsedPct: 2,
    volumeRankChasingMaxTargetVolume: 1_000_000_000,
    volumeMaxCatchupScale: 1.25,
    volumeMaxMarketsPerTick: 12,
    volumeMaxOrdersPerTick: 10,
    volumeMaxPointsOrderNotionalPct: 0.75,
    volumeMaxPointsMaxMarketExposurePct: 4,
    volumeMaxBookParticipationPct: 20,
    volumeMaxQuoteTtlSeconds: 90,
    stopLossPct: 4,
    minStopLossPct: 1.5,
    minTakeProfitPct: 1.5,
    maxTakeProfitPct: 4,
    maxMarketsPerTick: 10,
    maxOrdersPerTick: 6,
    quoteTtlSeconds: 240,
    repriceThresholdBps: 20,
    minNetEdgeBps: 30,
    maxSpreadBps: 120,
    liquidityDepthBps: 25,
    maxBookParticipationPct: 15,
    minOrderNotional: 10,
    tickSize: 0.01,
    stateNamespace: "loaf:test",
    telemetryMaxRuns: 2_000,
    requireDurableLock: false,
    ...overrides,
  };
}

export function candles(now: number, movePerBar = 0.0008, count = 60): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 * (1 + movePerBar) ** index;
    return {
      time: now - (count - index) * 300,
      open: close / (1 + movePerBar),
      high: close * 1.001,
      low: close * 0.999,
      close,
      volume: 100,
    };
  });
}

export const market: MarketSummary = {
  propertyId: 1,
  tokenName: "opera",
  assetName: "Sydney Opera House",
  ticker: "OPR",
  status: "LIVE",
  marketPrice: 101,
  dailyReferencePrice: 100,
  volume24h: 1_000_000,
  isCompetition: true,
};

export const detail: MarketDetail = {
  property: {
    propertyId: 1,
    tokenName: "opera",
    assetName: "Sydney Opera House",
    ticker: "OPR",
    status: "LIVE",
    isHalted: false,
    isCompetition: true,
  },
  orderBook: {
    propertyId: 1,
    bids: [{ price: 100, quantity: 20 }],
    asks: [{ price: 101, quantity: 10 }],
  },
  dailyReferencePrice: 100,
  volume24h: 1_000_000,
  maxSlippageBps: 500,
  competitionModeActive: true,
};
