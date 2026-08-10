import assert from "node:assert/strict";
import test from "node:test";
import {
  orderbookTokenChannel,
  parseOrderBookUpdate,
  subscribeFrame,
  websocketErrorMessage,
} from "@/src/worker-protocol";

test("WebSocket order-book subscriptions validate the lowercase tokenName identity", () => {
  assert.equal(orderbookTokenChannel(" TERAfab "), "orderbook:terafab");
  assert.throws(() => orderbookTokenChannel("not/a-token"), /tokenName/);
});

test("WebSocket subscription frames use a non-empty channels array and surface server errors", () => {
  assert.deepEqual(subscribeFrame(["orderbook:terafab", "orderbook:terafab"]), {
    type: "subscribe",
    channels: ["orderbook:terafab"],
  });
  assert.throws(() => subscribeFrame([]), /channel array/);
  assert.equal(
    websocketErrorMessage('{"type":"error","code":"INVALID_CHANNELS","message":"channels must be an array of strings"}'),
    "INVALID_CHANNELS: channels must be an array of strings",
  );
});

test("order-book payload parser accepts valid Buffer data and rejects incomplete books", () => {
  const update = parseOrderBookUpdate(Buffer.from(JSON.stringify({
    type: "orderbook_update",
    propertyId: 42,
    bids: [{ price: 100, quantity: 3, orderId: 7 }],
    asks: [{ price: 101, quantity: 2, orderId: 8 }],
  })));
  assert.deepEqual(update, {
    propertyId: 42,
    bids: [{ price: 100, quantity: 3, orderId: 7 }],
    asks: [{ price: 101, quantity: 2, orderId: 8 }],
  });
  assert.equal(parseOrderBookUpdate('{"type":"orderbook_update","propertyId":42,"bids":[],"asks":[]}'), null);
  assert.equal(parseOrderBookUpdate("not-json"), null);
});
