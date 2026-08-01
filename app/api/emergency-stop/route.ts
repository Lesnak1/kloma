import { isAuthorized, unauthorizedResponse } from "@/src/auth";
import { loadConfig } from "@/src/config";
import { LoafClient } from "@/src/loaf-client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
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

  try {
    const api = new LoafClient({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey });
    const result = await api.cancelAll();
    return Response.json(
      { ok: result.failedOrders.length === 0, timestamp: new Date().toISOString(), ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: "emergency_stop_failed", message: error instanceof Error ? error.message : "Unknown failure" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
