import type {
  ActiveOrder,
  CancelAllResult,
  CancelResult,
  CandleHistoryResponse,
  CompetitionResponse,
  LeaderboardResponse,
  MarketDetail,
  MarketListResponse,
  OrderRequest,
  OrderResult,
  PortfolioComponent,
  QueuePositionResponse,
} from "@/src/types";

export class LoafApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "LoafApiError";
  }
}

interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxReadRetries?: number;
}

export interface LoafApi {
  getCompetition(): Promise<CompetitionResponse>;
  getQueuePosition(): Promise<QueuePositionResponse>;
  getLeaderboard(): Promise<LeaderboardResponse | null>;
  getMarkets(): Promise<MarketListResponse>;
  getMarketDetail(tokenName: string): Promise<MarketDetail>;
  getCandles(tokenName: string, resolution?: string, countBack?: number): Promise<CandleHistoryResponse>;
  getPortfolio(): Promise<PortfolioComponent>;
  getActiveOrders(): Promise<ActiveOrder[]>;
  cancelOrder(orderId: number): Promise<CancelResult>;
  cancelAll(): Promise<CancelAllResult>;
  placeOrder(order: Omit<OrderRequest, "nonce">): Promise<OrderResult>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 5000);
  return Math.min(250 * 2 ** attempt, 2000);
}

export class LoafClient implements LoafApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxReadRetries: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxReadRetries = options.maxReadRetries ?? 2;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: { auth?: boolean; idempotent?: boolean; allow404?: boolean } = {},
  ): Promise<T | null> {
    const auth = options.auth ?? true;
    const idempotent = options.idempotent ?? (init.method === undefined || init.method === "GET");
    const attempts = idempotent ? this.maxReadRetries + 1 : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const headers = new Headers(init.headers);
        headers.set("Accept", "application/json");
        if (init.body !== undefined) headers.set("Content-Type", "application/json");
        if (auth) {
          if (!this.apiKey) throw new Error("LOAF_API_KEY is required for this operation");
          headers.set("Authorization", `Bearer ${this.apiKey}`);
        }

        const response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers,
          cache: "no-store",
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.status === 404 && options.allow404) return null;
        if (response.ok) return (await response.json()) as T;

        let payload: Record<string, unknown> = {};
        try {
          payload = asRecord(await response.json());
        } catch {
          // A non-JSON upstream error is represented by status only.
        }
        const code = typeof payload.code === "string" ? payload.code : undefined;
        const baseMessage =
          typeof payload.errorMessage === "string"
            ? payload.errorMessage
            : typeof payload.error === "string"
              ? payload.error
              : `Loaf API returned HTTP ${response.status}`;
        const details = Array.isArray(payload.details)
          ? payload.details.filter((item): item is string => typeof item === "string" && item.length > 0).join("; ")
          : "";
        const message = details ? `${baseMessage}: ${details}` : baseMessage;

        if (idempotent && attempt + 1 < attempts && (response.status === 429 || response.status === 503)) {
          await delay(retryDelay(response, attempt));
          continue;
        }

        throw new LoafApiError(
          message,
          response.status,
          code,
          Number(response.headers.get("retry-after")) || undefined,
        );
      } catch (error) {
        if (error instanceof LoafApiError) throw error;
        if (idempotent && attempt + 1 < attempts) {
          await delay(Math.min(250 * 2 ** attempt, 2000));
          continue;
        }
        const message = error instanceof Error ? error.message : "Unknown network error";
        throw new LoafApiError(`Loaf API connection failed: ${message}`, 0);
      }
    }
    throw new LoafApiError("Loaf API retry loop exhausted", 0);
  }

  async getCompetition(): Promise<CompetitionResponse> {
    return (await this.request<CompetitionResponse>("/competition", {}, { auth: false }))!;
  }

  async getQueuePosition(): Promise<QueuePositionResponse> {
    return (await this.request<QueuePositionResponse>("/competition/queue-position"))!;
  }

  async getLeaderboard(): Promise<LeaderboardResponse | null> {
    return this.request<LeaderboardResponse>("/leaderboard", {}, { auth: false, allow404: true });
  }

  async getMarkets(): Promise<MarketListResponse> {
    return (await this.request<MarketListResponse>("/trade", {}, { auth: false }))!;
  }

  async getMarketDetail(tokenName: string): Promise<MarketDetail> {
    return (await this.request<MarketDetail>(`/trade/${encodeURIComponent(tokenName)}`, {}, { auth: false }))!;
  }

  async getCandles(
    tokenName: string,
    resolution = "5m",
    countBack = 120,
  ): Promise<CandleHistoryResponse> {
    const search = new URLSearchParams({ resolution, countBack: String(countBack) });
    return (await this.request<CandleHistoryResponse>(
      `/trade/${encodeURIComponent(tokenName)}/candles?${search.toString()}`,
      {},
      { auth: false },
    ))!;
  }

  async getPortfolio(): Promise<PortfolioComponent> {
    const response = (await this.request<PortfolioComponent>("/portfolio/component"))!;
    return {
      ...response,
      cash: Number(response.cash ?? 0),
      frozen: Number(response.frozen ?? 0),
      portfolioValue: Number(response.portfolioValue ?? 0),
      portfolioPnl: Number(response.portfolioPnl ?? 0),
      portfolioPnlPercent: Number(response.portfolioPnlPercent ?? 0),
      positions: Array.isArray(response.positions) ? response.positions : [],
      openOrders: Array.isArray(response.openOrders) ? response.openOrders : [],
    };
  }

  async getActiveOrders(): Promise<ActiveOrder[]> {
    const response = (await this.request<{ activeOrders?: ActiveOrder[] }>("/history/orders/active"))!;
    return Array.isArray(response.activeOrders) ? response.activeOrders : [];
  }

  async requestNonce(): Promise<{ nonce: string; deadline: number }> {
    return (await this.request<{ nonce: string; deadline: number }>(
      "/orders/nonce",
      { method: "POST" },
      { idempotent: false },
    ))!;
  }

  async placeOrder(order: Omit<OrderRequest, "nonce">): Promise<OrderResult> {
    const noncePayload = await this.requestNonce();
    const result = (await this.request<OrderResult>(
      "/orders/",
      { method: "POST", body: JSON.stringify({ ...order, nonce: noncePayload.nonce }) },
      { idempotent: false },
    ))!;
    if (!result.success) throw new LoafApiError(result.errorMessage ?? "Order rejected", 400);
    return result;
  }

  async cancelOrder(orderId: number): Promise<CancelResult> {
    return (await this.request<CancelResult>(
      "/orders/cancel",
      { method: "POST", body: JSON.stringify({ orderId }) },
      { idempotent: false },
    ))!;
  }

  async cancelAll(): Promise<CancelAllResult> {
    return (await this.request<CancelAllResult>(
      "/orders/cancel-all",
      { method: "POST" },
      { idempotent: false },
    ))!;
  }
}
