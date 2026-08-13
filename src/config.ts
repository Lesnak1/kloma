export interface BotConfig {
  apiBaseUrl: string;
  apiKey: string;
  cronSecret: string;
  tradingEnabled: boolean;
  allowOutsideCompetition: boolean;
  queuePositionAdvisory: boolean;
  holdDuringDraftRound: boolean;
  killSwitch: boolean;
  handle?: string;
  walletAddress?: string;
  targetTokens: string[];
  startingBalanceUsdl: number;
  maxDrawdownPct: number;
  maxGrossExposurePct: number;
  maxMarketExposurePct: number;
  cashReservePct: number;
  orderNotionalPct: number;
  compoundingEnabled: boolean;
  compoundingProfitReinvestPct: number;
  compoundingMaxEquityMultiplier: number;
  qualitySizeBoostMax: number;
  pointsModeEnabled: boolean;
  pointsOrderNotionalPct: number;
  pointsMaxMarketExposurePct: number;
  pointsDrawdownStopPct: number;
  pointsMaxRoundTripCostBps: number;
  volumeMaxMode: boolean;
  volumeMaxRoundNumber: number;
  volumeMaxFeaturedOnly: boolean;
  volumeMaxTargetVolume: number;
  volumeRankChasingEnabled: boolean;
  volumeRankChasingMarginPct: number;
  volumeRankChasingMinElapsedPct: number;
  volumeRankChasingMaxTargetVolume: number;
  volumeMaxCatchupScale: number;
  volumeMaxMarketsPerTick: number;
  volumeMaxOrdersPerTick: number;
  volumeMaxPointsOrderNotionalPct: number;
  volumeMaxPointsMaxMarketExposurePct: number;
  volumeMaxBookParticipationPct: number;
  volumeMaxQuoteTtlSeconds: number;
  stopLossPct: number;
  minStopLossPct: number;
  minTakeProfitPct: number;
  maxTakeProfitPct: number;
  maxMarketsPerTick: number;
  maxOrdersPerTick: number;
  quoteTtlSeconds: number;
  repriceThresholdBps: number;
  minNetEdgeBps: number;
  maxSpreadBps: number;
  liquidityDepthBps: number;
  maxBookParticipationPct: number;
  minOrderNotional: number;
  tickSize: number;
  botPublicUrl?: string;
  cronJobApiKey?: string;
  cronJobJobId?: number;
  stopAfterRoundNumber?: number;
  upstashRestUrl?: string;
  upstashRestToken?: string;
  stateNamespace: string;
  telemetryMaxRuns: number;
  requireDurableLock: boolean;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be exactly true or false`);
}

function numberInRange(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  const parsed = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalPositiveInteger(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig(options: { requireApiKey?: boolean } = {}): BotConfig {
  const apiBaseUrl = (
    process.env.LOAF_API_BASE_URL ?? "https://api.loafmarkets.com/api"
  ).replace(/\/+$/, "");
  if (!apiBaseUrl.startsWith("https://") && process.env.NODE_ENV === "production") {
    throw new Error("LOAF_API_BASE_URL must use HTTPS in production");
  }

  const apiKey = options.requireApiKey === false ? (process.env.LOAF_API_KEY ?? "") : required("LOAF_API_KEY");
  if (apiKey && !/^[a-f0-9]{64}$/i.test(apiKey)) {
    throw new Error("LOAF_API_KEY must be a 64-character hexadecimal key");
  }

  const cronSecret = required("CRON_SECRET");
  if (cronSecret.length < 32) {
    throw new Error("CRON_SECRET must be at least 32 characters");
  }

  const botPublicUrl = process.env.BOT_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined;
  if (botPublicUrl && !botPublicUrl.startsWith("https://")) {
    throw new Error("BOT_PUBLIC_URL must use HTTPS");
  }

  const upstashRestUrl = (
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? ""
  ).trim().replace(/\/+$/, "") || undefined;
  const upstashRestToken = (
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? ""
  ).trim() || undefined;
  if (upstashRestUrl && !upstashRestUrl.startsWith("https://")) {
    throw new Error("UPSTASH_REDIS_REST_URL must use HTTPS");
  }
  if (Boolean(upstashRestUrl) !== Boolean(upstashRestToken)) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set together");
  }
  const requireDurableLock = bool("REQUIRE_DURABLE_LOCK", false);
  if (requireDurableLock && !upstashRestUrl) {
    throw new Error("REQUIRE_DURABLE_LOCK=true requires Upstash REST credentials");
  }
  const tradingEnabled = bool("TRADING_ENABLED", false);
  if (tradingEnabled && !upstashRestUrl) {
    throw new Error("TRADING_ENABLED=true requires Upstash durable state credentials");
  }
  const stateNamespace = process.env.STATE_NAMESPACE?.trim() || "loaf:league:trader";
  if (!/^[a-zA-Z0-9:_-]{1,64}$/.test(stateNamespace)) {
    throw new Error("STATE_NAMESPACE contains unsupported characters");
  }
  const handle = process.env.LOAF_HANDLE?.trim() || undefined;
  const walletAddress = process.env.LOAF_WALLET_ADDRESS?.trim().toLowerCase() || undefined;
  if (tradingEnabled && !handle && !walletAddress) {
    throw new Error("TRADING_ENABLED=true requires LOAF_HANDLE or LOAF_WALLET_ADDRESS for rank-aware risk");
  }

  const stopLossPct = numberInRange("STOP_LOSS_PCT", 4, 0.5, 30);
  const minStopLossPct = numberInRange("MIN_STOP_LOSS_PCT", 1.5, 0.25, 10);
  const minTakeProfitPct = numberInRange("MIN_TAKE_PROFIT_PCT", 1.5, 0.25, 20);
  const maxTakeProfitPct = numberInRange("MAX_TAKE_PROFIT_PCT", 4, 0.5, 30);
  const maxDrawdownPct = numberInRange("MAX_DRAWDOWN_PCT", 6, 0.1, 50);
  const maxMarketExposurePct = numberInRange("MAX_MARKET_EXPOSURE_PCT", 12, 1, 50);
  const pointsMaxMarketExposurePct = numberInRange("POINTS_MAX_MARKET_EXPOSURE_PCT", 3, 0.25, 20);
  const pointsDrawdownStopPct = numberInRange("POINTS_DRAWDOWN_STOP_PCT", 2, 0.1, 20);
  if (minStopLossPct > stopLossPct) {
    throw new Error("MIN_STOP_LOSS_PCT cannot exceed STOP_LOSS_PCT");
  }
  if (minTakeProfitPct > maxTakeProfitPct) {
    throw new Error("MIN_TAKE_PROFIT_PCT cannot exceed MAX_TAKE_PROFIT_PCT");
  }
  if (pointsMaxMarketExposurePct > maxMarketExposurePct) {
    throw new Error("POINTS_MAX_MARKET_EXPOSURE_PCT cannot exceed MAX_MARKET_EXPOSURE_PCT");
  }
  if (pointsDrawdownStopPct > maxDrawdownPct) {
    throw new Error("POINTS_DRAWDOWN_STOP_PCT cannot exceed MAX_DRAWDOWN_PCT");
  }

  return {
    apiBaseUrl,
    apiKey,
    cronSecret,
    tradingEnabled,
    allowOutsideCompetition: bool("ALLOW_OUTSIDE_COMPETITION", false),
    queuePositionAdvisory: bool("QUEUE_POSITION_ADVISORY", false),
    holdDuringDraftRound: bool("HOLD_DURING_DRAFT_ROUND", true),
    killSwitch: bool("KILL_SWITCH", false),
    handle,
    walletAddress,
    targetTokens: (process.env.LOAF_TARGET_TOKENS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    startingBalanceUsdl: numberInRange("STARTING_BALANCE_USDL", 100_000, 100, 100_000_000),
    maxDrawdownPct,
    maxGrossExposurePct: numberInRange("MAX_GROSS_EXPOSURE_PCT", 60, 1, 100),
    maxMarketExposurePct,
    cashReservePct: numberInRange("CASH_RESERVE_PCT", 25, 0, 95),
    orderNotionalPct: numberInRange("ORDER_NOTIONAL_PCT", 2, 0.05, 10),
    compoundingEnabled: bool("COMPOUNDING_ENABLED", true),
    compoundingProfitReinvestPct: numberInRange("COMPOUNDING_PROFIT_REINVEST_PCT", 100, 0, 100),
    compoundingMaxEquityMultiplier: numberInRange("COMPOUNDING_MAX_EQUITY_MULTIPLIER", 1.5, 1, 5),
    qualitySizeBoostMax: numberInRange("QUALITY_SIZE_BOOST_MAX", 1.35, 1, 2),
    pointsModeEnabled: bool("POINTS_MODE_ENABLED", true),
    pointsOrderNotionalPct: numberInRange("POINTS_ORDER_NOTIONAL_PCT", 0.6, 0.05, 5),
    pointsMaxMarketExposurePct,
    pointsDrawdownStopPct,
    pointsMaxRoundTripCostBps: numberInRange("POINTS_MAX_ROUND_TRIP_COST_BPS", 90, 0, 200),
    volumeMaxMode: bool("VOLUME_MAX_MODE", true),
    volumeMaxRoundNumber: Math.floor(numberInRange("VOLUME_MAX_ROUND_NUMBER", 1, 1, 100)),
    volumeMaxFeaturedOnly: bool("VOLUME_MAX_FEATURED_ONLY", true),
    volumeMaxTargetVolume: numberInRange("VOLUME_MAX_TARGET_VOLUME", 30_000_000, 1_000_000, 10_000_000_000),
    volumeRankChasingEnabled: bool("VOLUME_RANK_CHASING_ENABLED", true),
    volumeRankChasingMarginPct: numberInRange("VOLUME_RANK_CHASING_MARGIN_PCT", 12, 0, 100),
    volumeRankChasingMinElapsedPct: numberInRange("VOLUME_RANK_CHASING_MIN_ELAPSED_PCT", 2, 0.1, 25),
    volumeRankChasingMaxTargetVolume: numberInRange("VOLUME_RANK_CHASING_MAX_TARGET_VOLUME", 1_000_000_000, 1_000_000, 10_000_000_000),
    volumeMaxCatchupScale: numberInRange("VOLUME_MAX_CATCHUP_SCALE", 1.25, 1, 3),
    volumeMaxMarketsPerTick: Math.floor(numberInRange("VOLUME_MAX_MARKETS_PER_TICK", 12, 1, 20)),
    volumeMaxOrdersPerTick: Math.floor(numberInRange("VOLUME_MAX_ORDERS_PER_TICK", 10, 1, 20)),
    volumeMaxPointsOrderNotionalPct: numberInRange("VOLUME_MAX_POINTS_ORDER_NOTIONAL_PCT", 0.75, 0.05, 20),
    volumeMaxPointsMaxMarketExposurePct: numberInRange("VOLUME_MAX_POINTS_MAX_MARKET_EXPOSURE_PCT", 4, 0.25, 50),
    volumeMaxBookParticipationPct: numberInRange("VOLUME_MAX_BOOK_PARTICIPATION_PCT", 20, 1, 100),
    volumeMaxQuoteTtlSeconds: Math.floor(numberInRange("VOLUME_MAX_QUOTE_TTL_SECONDS", 90, 30, 3600)),
    stopLossPct,
    minStopLossPct,
    minTakeProfitPct,
    maxTakeProfitPct,
    maxMarketsPerTick: Math.floor(numberInRange("MAX_MARKETS_PER_TICK", 10, 1, 10)),
    maxOrdersPerTick: Math.floor(numberInRange("MAX_ORDERS_PER_TICK", 6, 1, 20)),
    quoteTtlSeconds: Math.floor(numberInRange("QUOTE_TTL_SECONDS", 240, 30, 3600)),
    repriceThresholdBps: numberInRange("REPRICE_THRESHOLD_BPS", 20, 1, 500),
    minNetEdgeBps: numberInRange("MIN_NET_EDGE_BPS", 30, 0, 500),
    maxSpreadBps: numberInRange("MAX_SPREAD_BPS", 120, 10, 5000),
    liquidityDepthBps: numberInRange("LIQUIDITY_DEPTH_BPS", 25, 1, 500),
    maxBookParticipationPct: numberInRange("MAX_BOOK_PARTICIPATION_PCT", 15, 1, 100),
    minOrderNotional: numberInRange("MIN_ORDER_NOTIONAL", 10, 10, 10_000),
    tickSize: numberInRange("TICK_SIZE", 0.01, 0.01, 100),
    botPublicUrl,
    cronJobApiKey: process.env.CRONJOB_API_KEY?.trim() || undefined,
    cronJobJobId: optionalPositiveInteger("CRONJOB_JOB_ID"),
    stopAfterRoundNumber: optionalPositiveInteger("STOP_AFTER_ROUND_NUMBER"),
    upstashRestUrl,
    upstashRestToken,
    stateNamespace,
    telemetryMaxRuns: Math.min(
      2_000,
      Math.floor(numberInRange("TELEMETRY_MAX_RUNS", 2_000, 100, 50_000)),
    ),
    requireDurableLock,
  };
}
