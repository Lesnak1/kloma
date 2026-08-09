import assert from "node:assert/strict";
import test from "node:test";
import { emptyDurableState } from "@/src/calibration";
import { UpstashStateStore } from "@/src/state-store";
import type { RunReport } from "@/src/types";

test("Upstash store uses NX lock, bounded telemetry and compare-delete release", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(input), body });
    if (calls.length === 1) return Response.json({ result: "OK" });
    if (calls.length === 2) return Response.json({ result: null });
    if (calls.length === 3) {
      return Response.json([{ result: "OK" }, { result: 1 }, { result: "OK" }, { result: 1 }]);
    }
    return Response.json({ result: 1 });
  };

  const report: RunReport = {
    runId: "run-1",
    timestamp: "2026-08-01T00:00:00.000Z",
    mode: "dry-run",
    competition: { active: false, roundNumber: null, roundStatus: null, admitted: null },
    fees: { makerFeeBps: 40, takerFeeBps: 70 },
    decisions: [],
    actions: [],
    warnings: [],
    durationMs: 1,
  };

  try {
    const store = new UpstashStateStore("https://redis.example", "redis-secret", "loaf:test", 250);
    const owner = await store.acquireLock();
    assert.ok(owner);
    await store.loadState();
    await store.recordRun(report, emptyDurableState());
    await store.releaseLock(owner);

    const lock = calls[0].body as unknown[];
    assert.equal(lock[0], "SET");
    assert.equal(lock[3], "NX");
    assert.equal(lock[4], "PX");
    assert.equal(calls[2].url, "https://redis.example/pipeline");
    const pipeline = calls[2].body as unknown[][];
    assert.deepEqual(pipeline[1].slice(0, 3), ["LTRIM", "loaf:test:runs:v1", 0]);
    assert.equal(pipeline[1][3], 248);
    assert.deepEqual(pipeline[2].slice(0, 2), ["LPUSH", "loaf:test:runs:v1"]);
    const release = calls[3].body as unknown[];
    assert.equal(release[0], "EVAL");
    assert.match(String(release[1]), /redis\.call\("get"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("corrupt durable calibration state fails closed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ result: "not-json" });
  try {
    const store = new UpstashStateStore("https://redis.example", "redis-secret", "loaf:test");
    await assert.rejects(store.loadState(), /not valid JSON/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
