import { isAuthorized, unauthorizedResponse } from "@/src/auth";
import { loadConfig } from "@/src/config";
import { LoafClient } from "@/src/loaf-client";
import { STRATEGY_VERSION } from "@/src/version";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request): Promise<Response> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    return Response.json(
      { error: "configuration_error", message: error instanceof Error ? error.message : "Invalid configuration" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!isAuthorized(request, config.cronSecret)) return unauthorizedResponse();

  try {
    const api = new LoafClient({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey });
    const [competition, portfolio, activeOrders, leaderboard, markets, queuePosition] = await Promise.all([
      api.getCompetition(),
      api.getPortfolio(),
      api.getActiveOrders(),
      api.getLeaderboard(),
      api.getMarkets(),
      api.getQueuePosition(),
    ]);
    return Response.json(
      {
        ok: true,
        timestamp: new Date().toISOString(),
        strategyVersion: STRATEGY_VERSION,
        mode: config.killSwitch ? "kill-switch" : config.tradingEnabled ? "live" : "dry-run",
        allowOutsideCompetition: config.allowOutsideCompetition,
        operations: {
          durableStateConfigured: Boolean(config.upstashRestUrl && config.upstashRestToken),
          durableLockRequired: config.requireDurableLock,
          schedulerConfigured: Boolean(config.cronJobApiKey && config.cronJobJobId),
          stopAfterRoundNumber: config.stopAfterRoundNumber ?? null,
        },
        strategy: {
          maxMarketsPerTick: config.maxMarketsPerTick,
          maxOrdersPerTick: config.maxOrdersPerTick,
          orderNotionalPct: config.orderNotionalPct,
          compoundingEnabled: config.compoundingEnabled,
          compoundingProfitReinvestPct: config.compoundingProfitReinvestPct,
          compoundingMaxEquityMultiplier: config.compoundingMaxEquityMultiplier,
          qualitySizeBoostMax: config.qualitySizeBoostMax,
          pointsModeEnabled: config.pointsModeEnabled,
          pointsOrderNotionalPct: config.pointsOrderNotionalPct,
          pointsMaxMarketExposurePct: config.pointsMaxMarketExposurePct,
          pointsDrawdownStopPct: config.pointsDrawdownStopPct,
          pointsMaxRoundTripCostBps: config.pointsMaxRoundTripCostBps,
          maxDrawdownPct: config.maxDrawdownPct,
          maxGrossExposurePct: config.maxGrossExposurePct,
          maxMarketExposurePct: config.maxMarketExposurePct,
          cashReservePct: config.cashReservePct,
          telemetryMaxRuns: config.telemetryMaxRuns,
        },
        competition,
        queuePosition,
        portfolio: {
          cash: portfolio.cash,
          frozen: portfolio.frozen,
          portfolioValue: portfolio.portfolioValue,
          portfolioPnl: portfolio.portfolioPnl,
          portfolioPnlPercent: portfolio.portfolioPnlPercent,
          positions: portfolio.positions,
        },
        activeOrders,
        leaderboard,
        marketCount: markets.properties.length,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: "status_failed", message: error instanceof Error ? error.message : "Unknown status failure" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
