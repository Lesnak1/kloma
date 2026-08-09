import { initialStrategyCalibration } from "@/src/calibration";
import { loadConfig } from "@/src/config";
import { LoafClient } from "@/src/loaf-client";
import { decideMarket } from "@/src/strategy";

async function main(): Promise<void> {
  process.env.CRON_SECRET ||= "read-only-market-audit-secret".padEnd(32, "x");
  process.env.TRADING_ENABLED = "false";
  process.env.REQUIRE_DURABLE_LOCK = "false";
  const config = loadConfig({ requireApiKey: false });
  const api = new LoafClient({ baseUrl: config.apiBaseUrl, apiKey: "" });
  const [competition, listed] = await Promise.all([api.getCompetition(), api.getMarkets()]);
  const live = listed.properties.filter((market) => market.status === "LIVE");
  const rows = await Promise.all(live.map(async (market) => {
    const [detail, history] = await Promise.all([
      api.getMarketDetail(market.tokenName),
      api.getCandles(market.tokenName, "5m", 120),
    ]);
    const decision = decideMarket({
      config,
      market,
      detail,
      candles: history.candles,
      portfolioValue: config.startingBalanceUsdl,
      cash: config.startingBalanceUsdl,
      grossExposure: 0,
      makerFeeBps: Number(competition.makerFeeBps ?? 0),
      takerFeeBps: Number(competition.takerFeeBps ?? 0),
      riskMode: "balanced",
      multiplier: 1,
      calibration: initialStrategyCalibration(),
    });
    const order = decision.desiredOrders[0];
    const mid = Number(decision.metrics.mid ?? 0);
    const fairPrice = Number(decision.metrics.fairPrice ?? 0);
    return {
      token: market.tokenName,
      volume24h: Number(market.volume24h ?? 0),
      state: decision.state,
      reason: decision.reason,
      spreadBps: decision.metrics.spreadBps,
      volatilityBps: decision.metrics.volatilityBps,
      momentum5mBps: decision.metrics.momentumBps,
      momentum15mBps: decision.metrics.higherTimeframeMomentumBps,
      signalBps: mid > 0 && fairPrice > 0 ? (fairPrice / mid - 1) * 10_000 : null,
      dynamicStopLossPct: decision.metrics.dynamicStopLossPct,
      dynamicTakeProfitPct: decision.metrics.dynamicTakeProfitPct,
      liquidityBudget: decision.metrics.liquidityBudget,
      pointsModeEligible: decision.metrics.pointsModeEligible,
      pointsRoundTripCostBps: decision.metrics.pointsRoundTripCostBps,
      pointsOrderNotional: decision.metrics.pointsOrderNotional,
      qualitySizeScale: decision.metrics.qualitySizeScale,
      sizingEquity: decision.metrics.sizingEquity,
      side: order?.side ?? null,
      orderNotional: order ? order.price * order.quantity : 0,
    };
  }));

  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    readOnly: true,
    fees: { makerFeeBps: competition.makerFeeBps, takerFeeBps: competition.takerFeeBps },
    activeRound: competition.featuredRound
      ?? competition.rounds.find((round) => String(round.status).toUpperCase() === "ACTIVE")
      ?? null,
    markets: rows.sort((left, right) => right.volume24h - left.volume24h),
  }, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
