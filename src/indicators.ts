import type { Candle, PriceLevel } from "@/src/types";

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function roundToTick(value: number, tickSize: number, direction: "nearest" | "down" | "up" = "nearest"): number {
  const scaled = value / tickSize;
  const rounded = direction === "down" ? Math.floor(scaled) : direction === "up" ? Math.ceil(scaled) : Math.round(scaled);
  return Number((rounded * tickSize).toFixed(8));
}

export function floorQuantity(value: number): number {
  return Math.floor((value + Number.EPSILON) * 10) / 10;
}

export function ema(values: number[], period: number): number | null {
  const clean = values.filter(Number.isFinite);
  if (clean.length === 0) return null;
  const alpha = 2 / (period + 1);
  let result = clean[0];
  for (let index = 1; index < clean.length; index += 1) {
    result = alpha * clean[index] + (1 - alpha) * result;
  }
  return result;
}

export function aggregateCandles(candles: Candle[], bucketSeconds = 15 * 60): Candle[] {
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0) return [];
  const grouped = new Map<number, Candle>();
  const ordered = candles
    .filter((candle) => candle.time > 0 && candle.close > 0)
    .sort((left, right) => left.time - right.time);

  for (const candle of ordered) {
    const bucket = Math.floor(candle.time / bucketSeconds) * bucketSeconds;
    const existing = grouped.get(bucket);
    if (!existing) {
      grouped.set(bucket, { ...candle, time: bucket });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
  }
  return [...grouped.values()].sort((left, right) => left.time - right.time);
}

export function realizedVolatilityBps(candles: Candle[], window = 24): number {
  const closes = candles.slice(-(window + 1)).map((candle) => candle.close).filter((value) => value > 0);
  if (closes.length < 3) return 0;
  const returns: number[] = [];
  for (let index = 1; index < closes.length; index += 1) {
    returns.push(Math.log(closes[index] / closes[index - 1]));
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  return Math.sqrt(variance) * 10_000;
}

export function momentumBps(candles: Candle[]): number {
  const closes = candles.map((candle) => candle.close).filter((value) => Number.isFinite(value) && value > 0);
  if (closes.length < 6) return 0;
  const fast = ema(closes.slice(-36), 6) ?? closes.at(-1)!;
  const slow = ema(closes.slice(-72), 18) ?? closes.at(-1)!;
  const oneBar = closes.length >= 2 ? (closes.at(-1)! / closes.at(-2)! - 1) * 10_000 : 0;
  return clamp((fast / slow - 1) * 10_000 * 0.8 + oneBar * 0.2, -500, 500);
}

export function topOfBook(levels: PriceLevel[], side: "bid" | "ask"): PriceLevel | null {
  const clean = levels.filter((level) => level.price > 0 && level.quantity > 0);
  if (clean.length === 0) return null;
  return clean.reduce((best, level) => {
    if (side === "bid") return level.price > best.price ? level : best;
    return level.price < best.price ? level : best;
  });
}

export function microPrice(bestBid: PriceLevel, bestAsk: PriceLevel): number {
  const total = bestBid.quantity + bestAsk.quantity;
  if (total <= 0) return (bestBid.price + bestAsk.price) / 2;
  return (bestAsk.price * bestBid.quantity + bestBid.price * bestAsk.quantity) / total;
}
