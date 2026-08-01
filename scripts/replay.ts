import { readFile } from "node:fs/promises";
import { analyzeReplay } from "@/src/replay";
import type { RunReport } from "@/src/types";

interface TelemetryPayload {
  runs?: RunReport[];
}

async function loadRuns(): Promise<RunReport[]> {
  const file = process.env.REPLAY_FILE?.trim();
  if (file) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as TelemetryPayload | RunReport[];
    return Array.isArray(parsed) ? parsed : parsed.runs ?? [];
  }

  const botUrl = process.env.BOT_PUBLIC_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.CRON_SECRET?.trim();
  if (!botUrl || !secret) {
    throw new Error("Set REPLAY_FILE, or set BOT_PUBLIC_URL and CRON_SECRET");
  }
  const response = await fetch(`${botUrl}/api/telemetry?limit=5000`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Telemetry endpoint returned HTTP ${response.status}`);
  const payload = (await response.json()) as TelemetryPayload;
  return payload.runs ?? [];
}

async function main(): Promise<void> {
  const result = analyzeReplay(await loadRuns());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Unknown replay error"}\n`);
  process.exitCode = 1;
});
