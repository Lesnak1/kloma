import assert from "node:assert/strict";
import test from "node:test";
import { LoafApiError, LoafClient } from "@/src/loaf-client";

test("idempotent reads retry a transient 503 without leaking auth to public routes", async () => {
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(init ?? {});
    if (calls.length === 1) return Response.json({ error: "busy" }, { status: 503 });
    return Response.json({ rounds: [], featuredRound: null, makerFeeBps: 40, takerFeeBps: 70, queueCount: 0 });
  };
  try {
    const client = new LoafClient({ baseUrl: "https://api.example/api", apiKey: "a".repeat(64), maxReadRetries: 1 });
    const result = await client.getCompetition();
    assert.equal(result.makerFeeBps, 40);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(new Headers(call.headers).has("Authorization"), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("order placement requests one fresh nonce and never retries a failed write", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) return Response.json({ nonce: "nonce-1", deadline: 0 });
    return Response.json({ error: "matching engine busy" }, { status: 503 });
  };
  try {
    const client = new LoafClient({ baseUrl: "https://api.example/api", apiKey: "a".repeat(64), maxReadRetries: 5 });
    await assert.rejects(
      client.placeOrder({
        propertyId: 1,
        price: 100,
        quantity: 1,
        side: "BUY",
        type: "LIMIT",
        timeInForce: "GTC",
        deadline: 0,
      }),
      (error: unknown) => error instanceof LoafApiError && error.status === 503,
    );
    assert.equal(calls.length, 2, "nonce and order write must each run exactly once");
    assert.match(calls[0].url, /\/orders\/nonce$/);
    assert.match(calls[1].url, /\/orders\/$/);
    const body = JSON.parse(String(calls[1].init.body)) as { nonce: string };
    assert.equal(body.nonce, "nonce-1");
    assert.equal(new Headers(calls[1].init.headers).get("Authorization"), `Bearer ${"a".repeat(64)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sequential successful orders never reuse a nonce", async () => {
  const originalFetch = globalThis.fetch;
  let nonce = 0;
  const submitted: string[] = [];
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).endsWith("/orders/nonce")) {
      nonce += 1;
      return Response.json({ nonce: `nonce-${nonce}`, deadline: 0 });
    }
    const body = JSON.parse(String(init.body)) as { nonce: string };
    submitted.push(body.nonce);
    return Response.json({ success: true, orderId: submitted.length });
  };
  try {
    const client = new LoafClient({ baseUrl: "https://api.example/api", apiKey: "b".repeat(64) });
    const order = {
      propertyId: 1,
      price: 100,
      quantity: 1,
      side: "BUY" as const,
      type: "LIMIT" as const,
      timeInForce: "GTC" as const,
      deadline: 0,
    };
    await client.placeOrder(order);
    await client.placeOrder(order);
    assert.deepEqual(submitted, ["nonce-1", "nonce-2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
