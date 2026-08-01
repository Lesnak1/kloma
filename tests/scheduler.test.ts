import assert from "node:assert/strict";
import test from "node:test";
import { CronJobOrgClient } from "@/src/scheduler";

test("cron-job.org job is a protected minute POST with response storage disabled", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ jobs: [], someFailed: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ jobId: 321 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await new CronJobOrgClient("scheduler-secret").ensureMinuteJob({
      targetUrl: "https://bot.example/",
      cronSecret: "tick-secret",
    });
    assert.deepEqual(result, { jobId: 321, created: true });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "https://api.cron-job.org/jobs");
    assert.equal(requests[1].init?.method, "PUT");
    const body = JSON.parse(String(requests[1].init?.body)) as {
      job: {
        url: string;
        requestMethod: number;
        saveResponses: boolean;
        schedule: { minutes: number[] };
        extendedData: { headers: Record<string, string> };
      };
    };
    assert.equal(body.job.url, "https://bot.example/api/tick");
    assert.equal(body.job.requestMethod, 1);
    assert.equal(body.job.saveResponses, false);
    assert.deepEqual(body.job.schedule.minutes, [-1]);
    assert.equal(body.job.extendedData.headers.Authorization, "Bearer tick-secret");
    assert.equal(body.job.extendedData.headers["X-Bot-Compact"], "1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
