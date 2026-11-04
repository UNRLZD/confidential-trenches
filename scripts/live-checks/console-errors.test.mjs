// node --test scripts/live-checks/console-errors.test.mjs: the shared console collector (card live-console-url) writes a
// console message as its text and its address's origin and path, never the query; a message with no address is its
// text alone. Each check's own test replays a recorded error through the check's hook and its judge.
import assert from "node:assert/strict";
import { test } from "node:test";
import { consoleError, consoleLine, resourceOf } from "./console-errors.mjs";

// sign live run 41843186760: eight lines of this text that named no host
const TEXT = "Failed to load resource: the server responded with a status of 429 ()";
const msg = (text, location) => ({ type: () => "error", text: () => text, location: () => location });

test("a console error names its resource's origin and path, never the query or fragment", () => {
  const url = "https://api.confidential.unrealized.trade/v1/market/candles?chain=solana&token=6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN&tf=15m#x";
  assert.equal(consoleError(msg(TEXT, { url, lineNumber: 0 })), `${TEXT} (https://api.confidential.unrealized.trade/v1/market/candles)`);
  assert.equal(resourceOf("https://confidential.unrealized.trade/"), "https://confidential.unrealized.trade/");
  assert.equal(resourceOf("wss://h.example/socket?k=1"), "wss://h.example/socket");
});

test("an address that is no http(s) page keeps its scheme only (a data: URL never lands whole in a line)", () => {
  assert.equal(resourceOf("data:text/javascript;base64,AAAA"), "data:");
  assert.equal(resourceOf("blob:https://sign.confidential.unrealized.trade/6f1c-uuid"), "blob:https://sign.confidential.unrealized.trade");
});

test("a message with no address is its text alone", () => {
  assert.equal(consoleError(msg("Uncaught boom", { url: "" })), "Uncaught boom");
  assert.equal(consoleError(msg("Uncaught boom", undefined)), "Uncaught boom");
  assert.equal(consoleError(msg("Uncaught boom", { url: "not a url" })), "Uncaught boom");
  assert.equal(consoleLine("x", undefined), "x");
});
