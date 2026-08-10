import type { PriceLevel } from "@/src/types";

interface OrderBookUpdate {
  type?: unknown;
  propertyId?: unknown;
  bids?: unknown;
  asks?: unknown;
}

function asPriceLevels(value: unknown): PriceLevel[] | null {
  if (!Array.isArray(value)) return null;
  const levels = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const price = Number(raw.price);
    const quantity = Number(raw.quantity);
    const orderId = Number(raw.orderId);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) return [];
    return [{ price, quantity, ...(Number.isInteger(orderId) && orderId > 0 ? { orderId } : {}) }];
  });
  return levels;
}

function rawText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString();
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString();
  if (Array.isArray(raw) && raw.every((item) => ArrayBuffer.isView(item))) {
    return Buffer.concat(raw.map((item) => Buffer.from(item.buffer, item.byteOffset, item.byteLength))).toString();
  }
  return null;
}

export function orderbookTokenChannel(tokenName: string): string {
  const token = tokenName.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(token)) {
    throw new Error("WebSocket order-book subscription requires a lowercase tokenName");
  }
  return `orderbook:${token}`;
}

export function subscribeFrame(channels: readonly string[]): { type: "subscribe"; channels: string[] } {
  const uniqueChannels = [...new Set(channels)];
  if (uniqueChannels.length === 0 || uniqueChannels.some((channel) => !channel.startsWith("orderbook:"))) {
    throw new Error("WebSocket subscriptions require a non-empty order-book channel array");
  }
  return { type: "subscribe", channels: uniqueChannels };
}

export function websocketErrorMessage(raw: unknown): string | null {
  try {
    const text = rawText(raw);
    if (!text) return null;
    const candidate = JSON.parse(text) as { type?: unknown; message?: unknown; code?: unknown };
    if (candidate.type !== "error" || typeof candidate.message !== "string") return null;
    return typeof candidate.code === "string" ? `${candidate.code}: ${candidate.message}` : candidate.message;
  } catch {
    return null;
  }
}

export function parseOrderBookUpdate(raw: unknown): { propertyId: number; bids: PriceLevel[]; asks: PriceLevel[] } | null {
  try {
    const text = rawText(raw);
    if (!text) return null;
    const candidate = JSON.parse(text) as OrderBookUpdate;
    if (candidate.type !== "orderbook_update") return null;
    const propertyId = Number(candidate.propertyId);
    const bids = asPriceLevels(candidate.bids);
    const asks = asPriceLevels(candidate.asks);
    if (!Number.isInteger(propertyId) || propertyId <= 0 || !bids?.length || !asks?.length) return null;
    return { propertyId, bids, asks };
  } catch {
    return null;
  }
}
