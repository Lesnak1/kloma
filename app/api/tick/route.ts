import { isAuthorized, unauthorizedResponse } from "@/src/auth";
import { loadConfig, type BotConfig } from "@/src/config";
import { TradingEngine } from "@/src/engine";
import { LoafClient } from "@/src/loaf-client";
import { CronJobOrgClient } from "@/src/scheduler";
import { UpstashStateStore } from "@/src/state-store";
import type { RunReport } from "@/src/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

let inFlight: Promise<RunReport> | null = null;

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

function responseFor(request: Request, report: RunReport, durableState: boolean): Response {
  if (request.headers.get("X-Bot-Compact") === "1") {
    const actionCounts = report.actions.reduce<Record<string, number>>((counts, action) => {
      counts[action.action] = (counts[action.action] ?? 0) + 1;
      return counts;
    }, {});
    return Response.json(
      {
        ok: true,
        runId: report.runId,
        timestamp: report.timestamp,
        mode: report.mode,
        competition: report.competition,
        durableState,
        actionCounts,
        warningCount: report.warnings.length,
        durationMs: report.durationMs,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(report, { headers: { "Cache-Control": "no-store" } });
}

async function runWithoutDurableState(config: BotConfig): Promise<RunReport> {
  if (!inFlight) {
    const api = new LoafClient({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey });
    inFlight = new TradingEngine(api, config, schedulerFor(config)).run().finally(() => {
      inFlight = null;
    });
  }
  const report = await inFlight;
  if (config.tradingEnabled) {
    report.warnings.push("Live mode is running without a cross-instance durable lock or persistent telemetry.");
  }
  return report;
}

async function execute(request: Request): Promise<Response> {
  let config: BotConfig;
  try {
    config = loadConfig();
  } catch (error) {
    return Response.json(
      { error: "configuration_error", message: error instanceof Error ? error.message : "Invalid configuration" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!isAuthorized(request, config.cronSecret)) return unauthorizedResponse();

  const store = stateStoreFor(config);
  try {
    if (!store) {
      const report = await runWithoutDurableState(config);
      return responseFor(request, report, false);
    }

    const owner = await store.acquireLock();
    if (!owner) {
      return Response.json(
        {
          ok: true,
          skipped: "distributed-lock-held",
          timestamp: new Date().toISOString(),
          durableState: true,
        },
        { headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
      );
    }

    let report: RunReport | undefined;
    try {
      const state = await store.loadState();
      const api = new LoafClient({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey });
      report = await new TradingEngine(api, config, schedulerFor(config), state.calibrations, state.risk).run();
      await store.recordRun(report, state);
    } finally {
      try {
        await store.releaseLock(owner);
      } catch (error) {
        report?.warnings.push(
          `Distributed lock release failed; TTL will recover it: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    if (!report) throw new Error("Trading run ended without a report");
    return responseFor(request, report, true);
  } catch (error) {
    return Response.json(
      {
        error: "tick_failed",
        message: error instanceof Error ? error.message : "Unknown tick failure",
        timestamp: new Date().toISOString(),
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  return execute(request);
}

export async function GET(request: Request): Promise<Response> {
  return execute(request);
}
