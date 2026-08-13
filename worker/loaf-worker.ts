import WebSocket from "ws";
import { loadConfig, type BotConfig } from "@/src/config";
import { type MarketDataCacheEntry } from "@/src/engine";
import { LoafClient } from "@/src/loaf-client";
import { runWorkerExecution } from "@/src/worker-runner";
import {
  orderbookTokenChannel,
  parseOrderBookUpdate,
  subscribeFrame,
  websocketErrorMessage,
} from "@/src/worker-protocol";
import type { Candle, MarketSummary } from "@/src/types";

interface WorkerSettings {
  wsUrl: string;
  minTickMs: number;
  heartbeatMs: number;
  catalogRefreshMs: number;
  candleRefreshMs: number;
  maxSubscriptions: number;
  eligibilityRetryMs: number;
}

function numberEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function websocketUrl(apiBaseUrl: string): string {
  const configured = process.env.LOAF_WS_URL?.trim();
  if (configured) return configured;
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

function settingsFor(config: BotConfig): WorkerSettings {
  return {
    wsUrl: websocketUrl(config.apiBaseUrl),
    minTickMs: numberEnv("WORKER_MIN_TICK_MS", 5_000, 2_000, 60_000),
    heartbeatMs: numberEnv("WORKER_HEARTBEAT_MS", 10_000, 5_000, 60_000),
    catalogRefreshMs: numberEnv("WORKER_CATALOG_REFRESH_MS", 60_000, 15_000, 15 * 60_000),
    candleRefreshMs: numberEnv("WORKER_CANDLE_REFRESH_MS", 5 * 60_000, 60_000, 60 * 60_000),
    maxSubscriptions: numberEnv("WORKER_MAX_SUBSCRIPTIONS", 24, 1, 100),
    eligibilityRetryMs: numberEnv("WORKER_ELIGIBILITY_RETRY_MS", 5 * 60_000, 30_000, 15 * 60_000),
  };
}

function exchangeEligibilityRejection(warnings: string[]): string | undefined {
  return warnings.find((warning) => /not a competition participant|competition eligibility|HTTP 403/i.test(warning));
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`);
}

class LoafWebsocketWorker {
  private readonly api: LoafClient;
  private readonly cache = new Map<string, MarketDataCacheEntry>();
  private readonly tokenByPropertyId = new Map<number, string>();
  private socket: WebSocket | null = null;
  private stopped = false;
  private running = false;
  private queued = false;
  private lastTickAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private catalogTimer: NodeJS.Timeout | null = null;
  private candleTimer: NodeJS.Timeout | null = null;
  private eligibilityRetryAt = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly settings: WorkerSettings,
  ) {
    this.api = new LoafClient({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey });
  }

  async start(): Promise<void> {
    await this.refreshCatalog();
    this.connect();
    this.heartbeatTimer = setInterval(() => this.requestTick("heartbeat"), this.settings.heartbeatMs);
    this.catalogTimer = setInterval(() => void this.refreshCatalog(), this.settings.catalogRefreshMs);
    this.candleTimer = setInterval(() => void this.refreshCandles(), this.settings.candleRefreshMs);
    this.requestTick("startup");
    log("worker_started", {
      wsUrl: new URL(this.settings.wsUrl).origin,
      minTickMs: this.settings.minTickMs,
      subscriptions: this.tokenByPropertyId.size,
      tradingEnabled: this.config.tradingEnabled,
    });
  }

  stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of [
      this.reconnectTimer,
      this.tickTimer,
      this.heartbeatTimer,
      this.catalogTimer,
      this.candleTimer,
    ]) {
      if (timer) clearTimeout(timer);
    }
    this.socket?.close(1000, reason);
    log("worker_stopped", { reason });
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.settings.wsUrl, { handshakeTimeout: 10_000 });
    this.socket = socket;
    socket.on("open", () => {
      log("websocket_connected", { subscriptions: this.tokenByPropertyId.size });
      this.sendOrderbookSubscriptions(socket);
    });
    socket.on("message", (raw) => {
      const update = parseOrderBookUpdate(raw);
      if (!update) {
        const message = websocketErrorMessage(raw);
        if (message) log("websocket_protocol_error", { message });
        return;
      }
      const token = this.tokenByPropertyId.get(update.propertyId);
      const cached = token ? this.cache.get(token) : undefined;
      if (!cached) return;
      cached.detail = {
        ...cached.detail,
        orderBook: { propertyId: update.propertyId, bids: update.bids, asks: update.asks },
      };
      cached.updatedAt = Date.now();
      this.requestTick("orderbook_update");
    });
    socket.on("error", (error) => log("websocket_error", { message: error.message }));
    socket.on("close", (code) => {
      if (this.socket === socket) {
        this.socket = null;
      }
      log("websocket_closed", { code });
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3_000);
  }

  private async refreshCatalog(): Promise<void> {
    try {
      const marketList = await this.api.getMarkets();
      const live = marketList.properties
        .filter((market) => market.status === "LIVE")
        .sort((left, right) => Number(right.volume24h ?? 0) - Number(left.volume24h ?? 0))
        .slice(0, this.settings.maxSubscriptions);
      this.tokenByPropertyId.clear();
      for (const market of live) this.tokenByPropertyId.set(market.propertyId, market.tokenName.toLowerCase());
      await Promise.all(live.map((market) => this.refreshMarket(market)));
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.sendOrderbookSubscriptions(this.socket);
      }
      log("catalog_refreshed", { liveMarkets: live.length, cachedMarkets: this.cache.size });
    } catch (error) {
      log("catalog_refresh_failed", { message: error instanceof Error ? error.message : "unknown error" });
    }
  }

  private async refreshCandles(): Promise<void> {
    const tokens = [...this.tokenByPropertyId.values()];
    await Promise.all(tokens.map(async (token) => {
      const cached = this.cache.get(token);
      if (!cached) return;
      try {
        const candles = await this.api.getCandles(token, "5m", 120);
        cached.candles = candles.candles;
      } catch (error) {
        log("candle_refresh_failed", { token, message: error instanceof Error ? error.message : "unknown error" });
      }
    }));
  }

  private async refreshMarket(market: MarketSummary): Promise<void> {
    const token = market.tokenName.toLowerCase();
    try {
      const [detail, candles] = await Promise.all([
        this.api.getMarketDetail(token),
        this.api.getCandles(token, "5m", 120),
      ]);
      this.cache.set(token, { detail, candles: candles.candles, updatedAt: Date.now() });
    } catch (error) {
      log("market_warmup_failed", { token, message: error instanceof Error ? error.message : "unknown error" });
    }
  }

  private sendOrderbookSubscriptions(socket: WebSocket): void {
    const channels = [...this.tokenByPropertyId.values()].map(orderbookTokenChannel);
    socket.send(JSON.stringify(subscribeFrame(channels)));
  }

  private requestTick(reason: string): void {
    if (this.stopped) return;
    this.queued = true;
    if (this.running || this.tickTimer) return;
    const waitMs = Math.max(0, this.settings.minTickMs - (Date.now() - this.lastTickAt));
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      void this.runQueuedTick(reason);
    }, waitMs);
  }

  private async runQueuedTick(reason: string): Promise<void> {
    if (this.stopped || this.running || !this.queued) return;
    if (Date.now() < this.eligibilityRetryAt) {
      this.queued = false;
      return;
    }
    if (Date.now() - this.lastTickAt < this.settings.minTickMs) return;
    this.queued = false;
    this.running = true;
    this.lastTickAt = Date.now();
    try {
      const result = await runWorkerExecution(this.config, this.cache);
      if (result.skipped) {
        log("tick_skipped", { reason, skipped: result.skipped });
      } else if (result.report) {
        const leaderboard = result.report.leaderboard;
        const eligibilityRejection = exchangeEligibilityRejection(result.report.warnings);
        if (eligibilityRejection) {
          this.eligibilityRetryAt = Date.now() + this.settings.eligibilityRetryMs;
          log("exchange_eligibility_backoff", {
            retryAfterMs: this.settings.eligibilityRetryMs,
            reason: eligibilityRejection,
          });
        }
        log("tick_complete", {
          reason,
          mode: result.report.mode,
          durationMs: result.report.durationMs,
          actionCount: result.report.actions.length,
          warningCount: result.report.warnings.length,
          admitted: result.report.competition.admitted,
          rank: leaderboard?.rank ?? null,
          volume: leaderboard?.volume ?? null,
          volumeTarget: leaderboard?.volumeTarget ?? null,
          actions: result.report.actions.slice(0, 3).map((action) => ({
            action: action.action,
            side: action.side ?? null,
            result: action.result,
          })),
          warnings: result.report.warnings.slice(0, 2),
        });
      }
    } catch (error) {
      log("tick_failed", { reason, message: error instanceof Error ? error.message : "unknown error" });
    } finally {
      this.running = false;
      if (this.queued) this.requestTick("coalesced_event");
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (process.env.WORKER_ENABLED !== "true") {
    throw new Error("WORKER_ENABLED=true is required to start the persistent worker.");
  }
  const worker = new LoafWebsocketWorker(config, settingsFor(config));
  process.on("SIGINT", () => worker.stop("SIGINT"));
  process.on("SIGTERM", () => worker.stop("SIGTERM"));
  await worker.start();
}

void main().catch((error) => {
  log("worker_fatal", { message: error instanceof Error ? error.message : "unknown error" });
  process.exitCode = 1;
});
