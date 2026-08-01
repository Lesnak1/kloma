import { isAuthorized, unauthorizedResponse } from "@/src/auth";
import { loadConfig } from "@/src/config";
import { UpstashStateStore } from "@/src/state-store";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request): Promise<Response> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    return Response.json(
      { error: "configuration_error", message: error instanceof Error ? error.message : "Invalid configuration" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!isAuthorized(request, config.cronSecret)) return unauthorizedResponse();
  if (!config.upstashRestUrl || !config.upstashRestToken) {
    return Response.json(
      { error: "telemetry_not_configured", message: "Upstash REST credentials are required" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(5_000, Number(url.searchParams.get("limit") ?? 120) || 120));
  const store = new UpstashStateStore(
    config.upstashRestUrl,
    config.upstashRestToken,
    config.stateNamespace,
    config.telemetryMaxRuns,
  );
  try {
    const [state, runs] = await Promise.all([store.loadState(), store.recentRuns(limit)]);
    return Response.json(
      { ok: true, timestamp: new Date().toISOString(), state, runs },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: "telemetry_failed", message: error instanceof Error ? error.message : "Unknown telemetry failure" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
