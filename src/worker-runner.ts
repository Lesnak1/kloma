import type { BotConfig } from "@/src/config";
import { TradingEngine, type MarketDataCacheEntry } from "@/src/engine";
import { LoafClient } from "@/src/loaf-client";
import { CronJobOrgClient } from "@/src/scheduler";
import { UpstashStateStore } from "@/src/state-store";
import type { RunReport } from "@/src/types";

export interface WorkerExecutionResult {
  report?: RunReport;
  durableState: boolean;
  skipped?: "distributed-lock-held";
}

function schedulerFor(config: BotConfig): CronJobOrgClient | undefined {
  return config.cronJobApiKey && config.cronJobJobId
    ? new CronJobOrgClient(config.cronJobApiKey, config.cronJobJobId)
    : undefined;
}

function stateStoreFor(config: BotConfig): UpstashStateStore | undefined {
  return config.upstashRestUrl && config.upstashRestToken
    ? new UpstashStateStore(
        config.upstashRestUrl,
        config.upstashRestToken,
        config.stateNamespace,
        config.telemetryMaxRuns,
      )
    : undefined;
}

export async function runWorkerExecution(
  config: BotConfig,
  marketDataCache: ReadonlyMap<string, MarketDataCacheEntry>,
): Promise<WorkerExecutionResult> {
  const store = stateStoreFor(config);
  if (!store) {
    if (config.tradingEnabled) throw new Error("Live worker requires Upstash durable state.");
    const api = new LoafClient({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey });
    const report = await new TradingEngine(api, config, schedulerFor(config), {}, undefined, marketDataCache).run();
    report.warnings.push("Worker dry-run has no durable lock or persistent telemetry.");
    return { report, durableState: false };
  }

  const owner = await store.acquireLock();
  if (!owner) return { durableState: true, skipped: "distributed-lock-held" };

  let report: RunReport | undefined;
  try {
    const state = await store.loadState();
    const api = new LoafClient({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey });
    report = await new TradingEngine(
      api,
      config,
      schedulerFor(config),
      state.calibrations,
      state.risk,
      marketDataCache,
    ).run();
    await store.recordRun(report, state);
    return { report, durableState: true };
  } finally {
    try {
      await store.releaseLock(owner);
    } catch (error) {
      report?.warnings.push(
        `Distributed lock release failed; TTL will recover it: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
}
