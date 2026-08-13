import assert from "node:assert/strict";
import test from "node:test";
import { isAuthorized, unauthorizedResponse } from "@/src/auth";
import { loadConfig } from "@/src/config";

function withEnvironment(values: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const baseEnvironment = {
  LOAF_API_KEY: "a".repeat(64),
  CRON_SECRET: "s".repeat(32),
  TRADING_ENABLED: "false",
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  KV_REST_API_URL: undefined,
  KV_REST_API_TOKEN: undefined,
  LOAF_HANDLE: undefined,
  LOAF_WALLET_ADDRESS: undefined,
};

test("Bearer authorization is exact and never accepts query-string credentials", () => {
  const secret = "s".repeat(32);
  assert.equal(isAuthorized(new Request("https://bot.example/api/tick", { headers: { Authorization: `Bearer ${secret}` } }), secret), true);
  assert.equal(isAuthorized(new Request(`https://bot.example/api/tick?secret=${secret}`), secret), false);
  assert.equal(isAuthorized(new Request("https://bot.example/api/tick", { headers: { Authorization: secret } }), secret), false);
  assert.equal(isAuthorized(new Request("https://bot.example/api/tick", { headers: { Authorization: `bearer ${secret}` } }), secret), false);
  const response = unauthorizedResponse();
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("WWW-Authenticate"), "Bearer");
});

test("live trading fails closed without durable state", () => {
  withEnvironment({ ...baseEnvironment, TRADING_ENABLED: "true", LOAF_HANDLE: "expert" }, () => {
    assert.throws(() => loadConfig(), /requires Upstash durable state/);
  });
});

test("live trading fails closed without leaderboard identity", () => {
  withEnvironment(
    {
      ...baseEnvironment,
      TRADING_ENABLED: "true",
      UPSTASH_REDIS_REST_URL: "https://redis.example",
      UPSTASH_REDIS_REST_TOKEN: "redis-token",
    },
    () => assert.throws(() => loadConfig(), /requires LOAF_HANDLE or LOAF_WALLET_ADDRESS/),
  );
});

test("production rejects an insecure Loaf API origin", () => {
  withEnvironment({ ...baseEnvironment, NODE_ENV: "production", LOAF_API_BASE_URL: "http://api.example/api" }, () => {
    assert.throws(() => loadConfig(), /must use HTTPS/);
  });
});

test("telemetry retention is capped for free-tier durable storage", () => {
  withEnvironment({
    ...baseEnvironment,
    TELEMETRY_MAX_RUNS: "10000",
    POINTS_ORDER_NOTIONAL_PCT: undefined,
    COMPOUNDING_ENABLED: undefined,
    COMPOUNDING_PROFIT_REINVEST_PCT: undefined,
    COMPOUNDING_MAX_EQUITY_MULTIPLIER: undefined,
    QUALITY_SIZE_BOOST_MAX: undefined,
    HOLD_DURING_DRAFT_ROUND: undefined,
    VOLUME_MAX_MODE: undefined,
    VOLUME_MAX_ROUND_NUMBER: undefined,
    VOLUME_MAX_TARGET_VOLUME: undefined,
    VOLUME_RANK_CHASING_ENABLED: undefined,
    VOLUME_RANK_CHASING_MARGIN_PCT: undefined,
    VOLUME_RANK_CHASING_MIN_ELAPSED_PCT: undefined,
    VOLUME_RANK_CHASING_MAX_TARGET_VOLUME: undefined,
    VOLUME_MAX_CATCHUP_SCALE: undefined,
    VOLUME_MAX_MARKETS_PER_TICK: undefined,
    VOLUME_MAX_ORDERS_PER_TICK: undefined,
    VOLUME_MAX_POINTS_ORDER_NOTIONAL_PCT: undefined,
    VOLUME_MAX_POINTS_MAX_MARKET_EXPOSURE_PCT: undefined,
    VOLUME_MAX_BOOK_PARTICIPATION_PCT: undefined,
    VOLUME_MAX_QUOTE_TTL_SECONDS: undefined,
  }, () => {
    const config = loadConfig();
    assert.equal(config.telemetryMaxRuns, 2_000);
    assert.equal(config.pointsOrderNotionalPct, 0.6);
    assert.equal(config.compoundingEnabled, true);
    assert.equal(config.holdDuringDraftRound, true);
    assert.equal(config.volumeMaxMode, true);
    assert.equal(config.volumeMaxTargetVolume, 30_000_000);
    assert.equal(config.volumeRankChasingEnabled, true);
    assert.equal(config.volumeRankChasingMarginPct, 12);
    assert.equal(config.volumeMaxMarketsPerTick, 12);
    assert.equal(config.volumeMaxOrdersPerTick, 10);
    assert.equal(config.volumeMaxPointsOrderNotionalPct, 0.75);
    assert.equal(config.volumeMaxCatchupScale, 1.25);
  });
});

test("round-one rank chasing accepts a multi-billion volume fail-safe ceiling", () => {
  withEnvironment({
    ...baseEnvironment,
    VOLUME_RANK_CHASING_MAX_TARGET_VOLUME: "5000000000",
  }, () => {
    assert.equal(loadConfig().volumeRankChasingMaxTargetVolume, 5_000_000_000);
  });
});
