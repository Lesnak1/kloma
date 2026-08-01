import { LoafClient } from "@/src/loaf-client";

async function main(): Promise<void> {
  const apiKey = process.env.LOAF_API_KEY?.trim();
  if (!apiKey || !/^[a-f0-9]{64}$/i.test(apiKey)) {
    throw new Error("LOAF_API_KEY must be set to a 64-character key");
  }
  const baseUrl = (process.env.LOAF_API_BASE_URL ?? "https://api.loafmarkets.com/api").replace(/\/+$/, "");
  const api = new LoafClient({ baseUrl, apiKey });
  const [competition, portfolio, activeOrders, queue, markets] = await Promise.all([
    api.getCompetition(),
    api.getPortfolio(),
    api.getActiveOrders(),
    api.getQueuePosition(),
    api.getMarkets(),
  ]);
  const activeRound =
    [competition.featuredRound, ...competition.rounds].find(
      (round) => round?.status?.toUpperCase() === "ACTIVE",
    ) ?? null;

  process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      timestamp: new Date().toISOString(),
      activeRound: activeRound
        ? { roundNumber: activeRound.roundNumber, status: activeRound.status }
        : null,
      fees: { makerFeeBps: competition.makerFeeBps, takerFeeBps: competition.takerFeeBps },
      queue: {
        position: queue.position,
        queueCount: queue.queueCount,
        finalPlacement: queue.finalPlacement,
      },
      portfolio: {
        value: portfolio.portfolioValue,
        cash: portfolio.cash,
        frozen: portfolio.frozen,
        positions: portfolio.positions.length,
      },
      activeOrders: activeOrders.length,
      liveMarkets: markets.properties.filter((market) => market.status === "LIVE").length,
    },
    null,
    2,
  )}\n`,
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Unknown preflight error"}\n`);
  process.exitCode = 1;
});
