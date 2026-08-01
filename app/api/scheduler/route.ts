import { isAuthorized, unauthorizedResponse } from "@/src/auth";
import { loadConfig } from "@/src/config";
import { CronJobOrgClient } from "@/src/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function configurationError(message: string): Response {
  return Response.json(
    { error: "scheduler_configuration_error", message },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    return configurationError(error instanceof Error ? error.message : "Invalid configuration");
  }
  if (!isAuthorized(request, config.cronSecret)) return unauthorizedResponse();
  if (!config.cronJobApiKey) return configurationError("CRONJOB_API_KEY is required");
  if (!config.botPublicUrl) return configurationError("BOT_PUBLIC_URL is required");

  try {
    const scheduler = new CronJobOrgClient(config.cronJobApiKey, config.cronJobJobId);
    const result = await scheduler.ensureMinuteJob({
      targetUrl: config.botPublicUrl,
      cronSecret: config.cronSecret,
    });
    return Response.json(
      {
        ok: true,
        provider: "cron-job.org",
        cadence: "every-minute",
        saveResponses: false,
        ...result,
        nextStep:
          config.cronJobJobId === result.jobId
            ? "Scheduler is fully configured."
            : `Set CRONJOB_JOB_ID=${result.jobId} in Vercel for automatic competition-end shutdown, then redeploy.`,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: "scheduler_setup_failed", message: error instanceof Error ? error.message : "Unknown failure" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function DELETE(request: Request): Promise<Response> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    return configurationError(error instanceof Error ? error.message : "Invalid configuration");
  }
  if (!isAuthorized(request, config.cronSecret)) return unauthorizedResponse();
  if (!config.cronJobApiKey) return configurationError("CRONJOB_API_KEY is required");
  if (!config.cronJobJobId) return configurationError("CRONJOB_JOB_ID is required");

  try {
    const result = await new CronJobOrgClient(config.cronJobApiKey, config.cronJobJobId).disable();
    return Response.json({ ok: true, provider: "cron-job.org", ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: "scheduler_disable_failed", message: error instanceof Error ? error.message : "Unknown failure" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
