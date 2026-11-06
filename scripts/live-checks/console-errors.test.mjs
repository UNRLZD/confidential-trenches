// node --test scripts/live-checks/console-errors.test.mjs: the shared console collector (card live-console-url) writes a
// console message as its text and its address's origin and path, never the query; a message with no address is its
// text alone. A page error is kept the same way, named by its stack's top frame (card live-pageerror-hooks), and
// watchErrors() hooks both on a page. Each check's own test replays a recorded error through the check's hook and its
// judge.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { consoleError, consoleLine, pageError, pageErrorUrl, resourceOf, watchErrors } from "./console-errors.mjs";

// sign live run 41843186760: eight lines of this text that named no host
const TEXT = "Failed to load resource: the server responded with a status of 429 ()";
const msg = (text, location) => ({ type: () => "error", text: () => text, location: () => location });

test("a console error names its resource's origin and path, never the query or fragment", () => {
  const url = "https://ct-api.unrealized.trade/v1/market/candles?chain=solana&token=6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN&tf=15m#x";
  assert.equal(consoleError(msg(TEXT, { url, lineNumber: 0 })), `${TEXT} (https://ct-api.unrealized.trade/v1/market/candles)`);
  assert.equal(resourceOf("https://ct-app.unrealized.trade/"), "https://ct-app.unrealized.trade/");
  assert.equal(resourceOf("wss://h.example/socket?k=1"), "wss://h.example/socket");
});

test("an address that is no http(s) page keeps its scheme only (a data: URL never lands whole in a line)", () => {
  assert.equal(resourceOf("data:text/javascript;base64,AAAA"), "data:");
  assert.equal(resourceOf("blob:https://confidential.unrealized.trade/6f1c-uuid"), "blob:https://confidential.unrealized.trade");
});

test("a message with no address is its text alone", () => {
  assert.equal(consoleError(msg("Uncaught boom", { url: "" })), "Uncaught boom");
  assert.equal(consoleError(msg("Uncaught boom", undefined)), "Uncaught boom");
  assert.equal(consoleError(msg("Uncaught boom", { url: "not a url" })), "Uncaught boom");
  assert.equal(consoleLine("x", undefined), "x");
});

// a page error as Playwright hands it: an Error whose stack is V8's description, "    at fn (url:line:col)" lines
const thrown = (Name, message, at) => {
  const e = new Name(message);
  e.stack = `${e.name}: ${message}${at.map((a) => `\n    at ${a}`).join("")}`;
  return e;
};
const APP = "https://ct-app.unrealized.trade";

test("an address written inside a line's text is cut to its origin and path too", () => {
  assert.equal(consoleLine("helper https://ct-api.unrealized.trade/v1/quote?amount=25&to=abc.near#f answered 500", ""), "helper https://ct-api.unrealized.trade/v1/quote answered 500");
  assert.equal(consoleLine("socket wss://h.example/s?k=1 closed", `${APP}/a.js?v=2`), `socket wss://h.example/s closed (${APP}/a.js)`);
  assert.equal(consoleLine("no address here", ""), "no address here");
});

test("a page error is its name and message, named by its top stack frame's origin and path, never the query (card live-pageerror-hooks)", () => {
  const e = thrown(TypeError, "Cannot read properties of undefined (reading 'pools')", [`Ft (${APP}/assets/index-abc.js?v=1:1:2345)`, `${APP}/assets/vendor.js:2:1`]);
  assert.equal(pageErrorUrl(e), `${APP}/assets/index-abc.js?v=1`);
  assert.equal(pageError(e), `pageerror TypeError: Cannot read properties of undefined (reading 'pools') (${APP}/assets/index-abc.js)`);
  // the forms of a V8 frame: bare, async, a constructor, and none placeable
  assert.equal(pageErrorUrl(thrown(Error, "x", [`${APP}/a.js:1:2`])), `${APP}/a.js`);
  assert.equal(pageErrorUrl(thrown(Error, "x", [`async run (${APP}/b.js:3:4)`])), `${APP}/b.js`);
  assert.equal(pageErrorUrl(thrown(Error, "x", [`new Pool (${APP}/c.js:5:6)`])), `${APP}/c.js`);
  assert.equal(pageError(thrown(Error, "x", ["<anonymous>"])), "pageerror Error: x");
  // no stack at all (a thrown string, a page error Playwright could not place): its text alone
  assert.equal(pageError(thrown(Error, "boom", [])), "pageerror Error: boom");
  assert.equal(pageError({ name: "Error", message: "odd", toString: () => "Error: odd" }), "pageerror Error: odd");
  // a message that writes an address: cut too
  assert.equal(pageError(thrown(Error, `fetch ${APP}/x?secret=1 failed`, [])), `pageerror Error: fetch ${APP}/x failed`);
});

test("watchErrors keeps the console errors and page errors its filter picks, and every one with no address (card live-pageerror-hooks)", () => {
  const msg = (t, location, type = "error") => ({ type: () => type, text: () => t, location: () => location });
  const page = new EventEmitter();
  const kept = [];
  watchErrors(page, kept, (url) => url.startsWith(APP));
  page.emit("console", msg("app 429", { url: `${APP}/a.js?q=1` }));
  page.emit("console", msg("shell 429", { url: "https://confidential.unrealized.trade/s.js" }));
  page.emit("console", msg("a warning", { url: "" }, "warning"));
  page.emit("console", msg("no address", undefined));
  page.emit("console", msg("not a url", { url: "not a url" }));
  page.emit("pageerror", thrown(Error, "app threw", [`f (${APP}/a.js:1:2)`]));
  page.emit("pageerror", thrown(Error, "shell threw", ["f (https://confidential.unrealized.trade/s.js:1:2)"]));
  page.emit("pageerror", thrown(Error, "unplaced", []));
  assert.deepEqual(kept, [`app 429 (${APP}/a.js)`, "no address", "not a url", `pageerror Error: app threw (${APP}/a.js)`, "pageerror Error: unplaced"]);
  // with no filter, every error of the page
  const all = [];
  const p2 = new EventEmitter();
  watchErrors(p2, all);
  p2.emit("console", msg("shell 429", { url: "https://confidential.unrealized.trade/s.js" }));
  p2.emit("pageerror", thrown(Error, "shell threw", ["f (https://confidential.unrealized.trade/s.js:1:2)"]));
  assert.deepEqual(all, ["shell 429 (https://confidential.unrealized.trade/s.js)", "pageerror Error: shell threw (https://confidential.unrealized.trade/s.js)"]);
});
