import { randomUUID } from "node:crypto";
import {
  emptyDurableState,
  normalizeDurableState,
  updateDurableState,
  type DurableBotState,
} from "@/src/calibration";
import type { RunReport } from "@/src/types";

interface RedisResult<T> {
  result?: T;
  error?: string;
}

export class DurableStateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DurableStateError";
  }
}

export class UpstashStateStore {
  private readonly stateKey: string;
  private readonly runsKey: string;
  private readonly lockKey: string;

  constructor(
    private readonly restUrl: string,
    private readonly token: string,
    namespace: string,
    private readonly maxRuns = 10_000,
  ) {
    this.stateKey = `${namespace}:state:v1`;
    this.runsKey = `${namespace}:runs:v1`;
    this.lockKey = `${namespace}:tick-lock:v1`;
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.restUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new DurableStateError(`State store returned HTTP ${response.status}`, response.status);
    const payload = (await response.json()) as RedisResult<T> | Array<RedisResult<unknown>>;
    if (!Array.isArray(payload) && payload.error) throw new DurableStateError(payload.error, response.status);
    return payload as T;
  }

  private async command<T>(...args: Array<string | number>): Promise<T | null> {
    const payload = await this.request<RedisResult<T>>("", args);
    return payload.result ?? null;
  }

  async acquireLock(ttlMs = 70_000): Promise<string | null> {
    const owner = randomUUID();
    const result = await this.command<string>("SET", this.lockKey, owner, "NX", "PX", ttlMs);
    return result === "OK" ? owner : null;
  }

  async releaseLock(owner: string): Promise<void> {
    const script =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
    await this.command<number>("EVAL", script, 1, this.lockKey, owner);
  }

  async loadState(): Promise<DurableBotState> {
    const raw = await this.command<string>("GET", this.stateKey);
    if (!raw) return emptyDurableState();
    try {
      return normalizeDurableState(JSON.parse(raw));
    } catch {
      throw new DurableStateError("Stored calibration state is not valid JSON", 500);
    }
  }

  async recordRun(report: RunReport, currentState: DurableBotState): Promise<DurableBotState> {
    const nextState = updateDurableState(currentState, report);
    const pipeline = [
      ["SET", this.stateKey, JSON.stringify(nextState)],
      ["LPUSH", this.runsKey, JSON.stringify(report)],
      ["LTRIM", this.runsKey, 0, this.maxRuns - 1],
      ["EXPIRE", this.runsKey, 60 * 60 * 24 * 30],
    ];
    const result = await this.request<Array<RedisResult<unknown>>>("/pipeline", pipeline);
    if (!Array.isArray(result) || result.some((item) => item.error)) {
      throw new DurableStateError("State-store telemetry pipeline failed", 502);
    }
    return nextState;
  }

  async recentRuns(limit = 120): Promise<RunReport[]> {
    const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    const raw = await this.command<string[]>("LRANGE", this.runsKey, 0, safeLimit - 1);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      try {
        return [JSON.parse(item) as RunReport];
      } catch {
        return [];
      }
    });
  }
}
