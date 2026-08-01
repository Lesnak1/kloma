export interface BotConfig {
  apiBaseUrl: string;
  apiKey: string;
  cronSecret: string;
  tradingEnabled: boolean;
  allowOutsideCompetition: boolean;
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
  stopLossPct: number;
  maxMarketsPerTick: number;
  maxOrdersPerTick: number;
  quoteTtlSeconds: number;
  repriceThresholdBps: number;
  minNetEdgeBps: number;
  maxSpreadBps: number;
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

  return {
    apiBaseUrl,
    apiKey,
    cronSecret,
    tradingEnabled,
    allowOutsideCompetition: bool("ALLOW_OUTSIDE_COMPETITION", false),
    killSwitch: bool("KILL_SWITCH", false),
    handle,
    walletAddress,
    targetTokens: (process.env.LOAF_TARGET_TOKENS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    startingBalanceUsdl: numberInRange("STARTING_BALANCE_USDL", 100_000, 100, 100_000_000),
    maxDrawdownPct: numberInRange("MAX_DRAWDOWN_PCT", 8, 0.1, 50),
    maxGrossExposurePct: numberInRange("MAX_GROSS_EXPOSURE_PCT", 65, 1, 100),
    maxMarketExposurePct: numberInRange("MAX_MARKET_EXPOSURE_PCT", 15, 1, 50),
    cashReservePct: numberInRange("CASH_RESERVE_PCT", 25, 0, 95),
    orderNotionalPct: numberInRange("ORDER_NOTIONAL_PCT", 1.25, 0.05, 10),
    stopLossPct: numberInRange("STOP_LOSS_PCT", 4, 0.5, 30),
    maxMarketsPerTick: Math.floor(numberInRange("MAX_MARKETS_PER_TICK", 4, 1, 10)),
    maxOrdersPerTick: Math.floor(numberInRange("MAX_ORDERS_PER_TICK", 6, 1, 20)),
    quoteTtlSeconds: Math.floor(numberInRange("QUOTE_TTL_SECONDS", 240, 30, 3600)),
    repriceThresholdBps: numberInRange("REPRICE_THRESHOLD_BPS", 20, 1, 500),
    minNetEdgeBps: numberInRange("MIN_NET_EDGE_BPS", 12, 0, 500),
    maxSpreadBps: numberInRange("MAX_SPREAD_BPS", 350, 10, 5000),
    minOrderNotional: numberInRange("MIN_ORDER_NOTIONAL", 10, 10, 10_000),
    tickSize: numberInRange("TICK_SIZE", 0.01, 0.01, 100),
    botPublicUrl,
    cronJobApiKey: process.env.CRONJOB_API_KEY?.trim() || undefined,
    cronJobJobId: optionalPositiveInteger("CRONJOB_JOB_ID"),
    stopAfterRoundNumber: optionalPositiveInteger("STOP_AFTER_ROUND_NUMBER"),
    upstashRestUrl,
    upstashRestToken,
    stateNamespace,
    telemetryMaxRuns: Math.floor(numberInRange("TELEMETRY_MAX_RUNS", 10_000, 100, 50_000)),
    requireDurableLock,
  };
}
