import { LoafClient } from "@/src/loaf-client";
import type { Candle, MarketSummary, PriceLevel } from "@/src/types";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Contract violation: ${message}`);
}

function finiteNonNegative(value: unknown): boolean {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0;
}

function validateLevels(levels: PriceLevel[], side: string, token: string): void {
  invariant(Array.isArray(levels), `${token} ${side} must be an array`);
  for (const level of levels) {
    invariant(Number.isFinite(Number(level.price)) && Number(level.price) > 0, `${token} ${side} price`);
    invariant(finiteNonNegative(level.quantity), `${token} ${side} quantity`);
  }
}

function validateCandles(candles: Candle[], token: string): void {
  invariant(Array.isArray(candles), `${token} candles must be an array`);
  let previousTime = 0;
  for (const candle of candles) {
    invariant(Number.isFinite(Number(candle.time)) && Number(candle.time) > previousTime, `${token} candle ordering`);
    for (const [field, value] of Object.entries({
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    })) {
      invariant(finiteNonNegative(value), `${token} candle ${field}`);
    }
    invariant(candle.high >= Math.max(candle.open, candle.close, candle.low), `${token} candle high`);
    invariant(candle.low <= Math.min(candle.open, candle.close, candle.high), `${token} candle low`);
    previousTime = Number(candle.time);
  }
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(...(await Promise.all(items.slice(index, index + size).map(run))));
  }
  return output;
}

async function main(): Promise<void> {
  const apiKey = process.env.LOAF_API_KEY?.trim();
  invariant(apiKey && /^[a-f0-9]{64}$/i.test(apiKey), "LOAF_API_KEY must be a 64-character key");
  const baseUrl = (process.env.LOAF_API_BASE_URL ?? "https://api.loafmarkets.com/api").replace(/\/+$/, "");
  const api = new LoafClient({ baseUrl, apiKey, timeoutMs: 10_000, maxReadRetries: 2 });
  const [competition, portfolio, activeOrders, queue, marketList, leaderboard] = await Promise.all([
    api.getCompetition(),
    api.getPortfolio(),
    api.getActiveOrders(),
    api.getQueuePosition(),
    api.getMarkets(),
    api.getLeaderboard(),
  ]);

  invariant(Array.isArray(competition.rounds), "competition.rounds");
  invariant(finiteNonNegative(competition.makerFeeBps), "competition.makerFeeBps");
  invariant(finiteNonNegative(competition.takerFeeBps), "competition.takerFeeBps");
  invariant(finiteNonNegative(portfolio.cash), "portfolio.cash");
  invariant(finiteNonNegative(portfolio.frozen), "portfolio.frozen");
  invariant(finiteNonNegative(portfolio.portfolioValue), "portfolio.portfolioValue");
  invariant(Array.isArray(portfolio.positions), "portfolio.positions");
  invariant(Array.isArray(activeOrders), "active orders");
  invariant(Array.isArray(marketList.properties), "trade properties");
  invariant(finiteNonNegative(queue.queueCount), "queue.queueCount");
  if (leaderboard) invariant(Array.isArray(leaderboard.entries), "leaderboard.entries");

  const seenIds = new Set<number>();
  const seenTokens = new Set<string>();
  for (const market of marketList.properties) {
    invariant(Number.isInteger(market.propertyId) && market.propertyId > 0, "market propertyId");
    invariant(typeof market.tokenName === "string" && market.tokenName.length > 0, "market tokenName");
    invariant(!seenIds.has(market.propertyId), `duplicate propertyId ${market.propertyId}`);
    invariant(!seenTokens.has(market.tokenName.toLowerCase()), `duplicate token ${market.tokenName}`);
    seenIds.add(market.propertyId);
    seenTokens.add(market.tokenName.toLowerCase());
  }

  const live = marketList.properties.filter((market): market is MarketSummary => market.status === "LIVE");
  const warnings: string[] = [];
  let candleCount = 0;
  let twoSidedBooks = 0;
  await inBatches(live, 3, async (market) => {
    const [detail, history] = await Promise.all([
      api.getMarketDetail(market.tokenName),
      api.getCandles(market.tokenName, "5m", 120),
    ]);
    invariant(detail.property.propertyId === market.propertyId, `${market.tokenName} propertyId mismatch`);
    invariant(detail.property.tokenName.toLowerCase() === market.tokenName.toLowerCase(), `${market.tokenName} token mismatch`);
    if (detail.orderBook) {
      validateLevels(detail.orderBook.bids, "bids", market.tokenName);
      validateLevels(detail.orderBook.asks, "asks", market.tokenName);
      if (detail.orderBook.bids.length > 0 && detail.orderBook.asks.length > 0) {
        const bestBid = Math.max(...detail.orderBook.bids.map((level) => Number(level.price)));
        const bestAsk = Math.min(...detail.orderBook.asks.map((level) => Number(level.price)));
        invariant(bestBid < bestAsk, `${market.tokenName} crossed order book`);
        twoSidedBooks += 1;
      } else {
        warnings.push(`${market.tokenName}: one-sided/empty book`);
      }
    } else {
      warnings.push(`${market.tokenName}: no order book`);
    }
    validateCandles(history.candles, market.tokenName);
    candleCount += history.candles.length;
    const latest = history.candles.at(-1)?.time;
    if (!latest || latest < Math.floor(Date.now() / 1000) - 20 * 60) {
      warnings.push(`${market.tokenName}: candles are stale or empty`);
    }
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        timestamp: new Date().toISOString(),
        readOnly: true,
        activeRound: competition.featuredRound?.status === "ACTIVE" ? competition.featuredRound.roundNumber : null,
        fees: { makerFeeBps: competition.makerFeeBps, takerFeeBps: competition.takerFeeBps },
        queue: { position: queue.position, queueCount: queue.queueCount, finalPlacement: queue.finalPlacement },
        portfolio: {
          value: portfolio.portfolioValue,
          cash: portfolio.cash,
          positions: portfolio.positions.length,
          activeOrders: activeOrders.length,
        },
        markets: {
          total: marketList.properties.length,
          live: live.length,
          validatedDetails: live.length,
          twoSidedBooks,
          validatedCandles: candleCount,
        },
        leaderboardAvailable: leaderboard !== null,
        warnings,
      },
      null,
      2,
    )}\n`,
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Unknown contract-test error"}\n`);
  process.exitCode = 1;
});
