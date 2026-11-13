// node --test test/quotes-signed-out.test.ts (from packages/signpage): after Sign out the page sends no quote (card
// helper-says-why-a-vendor-refused, review P3). src/main.ts is the page's entry, run only in a browser, so its wiring is
// read here as text: every way the page learns it is signed out (its own Sign out, its store's signout event, another
// tab's) ends the quotes' asks (quotesSignedOut) until it is signed in again (quotesSignedIn), and every quote host is handed
// that stop (quotesStopped). The stop's
// effect on each host is tested on the host: test/deposit-dry.test.ts, test/pool-deposit-address.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const MAIN = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
/** The text from `start` to the first `end` after it. */
function block(start: string, end: string): string {
  const a = MAIN.indexOf(start);
  assert.ok(a >= 0, start);
  const b = MAIN.indexOf(end, a + start.length);
  assert.ok(b > a, end);
  return MAIN.slice(a, b);
}

test("every way the page learns it is signed out ends the quotes' asks", () => {
  assert.match(block("async function signOut(): Promise<void> {", "\n}\n"), /\n {2}quotesSignedOut\(\);/);
  assert.match(block('if (e.kind !== "signout") return;', 'show("signed-out");'), /\n {6}quotesSignedOut\(\);/);
  assert.match(block("function storeMoved(e: WalletEvent): void {", "\n}\n"), /if \(e\.kind === "signout"\) \{[^}]*quotesSignedOut\(\);/);
});

test("every quote host gets the page's stop: deposit.quote, pool.address and the sheet's reads on both pages", () => {
  assert.match(MAIN, /"deposit\.quote": depositQuoteHost\(\{[^\n]*stop: quotesStopped \}\)/);
  assert.match(MAIN, /"pool\.address": poolAddressHost\(\{[^\n]*stop: quotesStopped \}\)/);
  assert.equal(MAIN.split("depositReadHosts({ stop: quotesStopped })").length - 1, 2);
  assert.equal(MAIN.split("depositReadHosts(").length - 1, 2);
  // declared before the API starts, which reads it as the page loads, from the page's one stop (src/quotes-stop.ts)
  assert.ok(MAIN.indexOf("const quotesStopped") < MAIN.indexOf("stop: quotesStopped"));
  assert.match(MAIN, /const quotes = quotesStop\(\);\nconst quotesStopped = quotes\.stopped;\nconst quotesSignedOut = quotes\.signedOut;/);
});

// Delta review P2-2: the stop stays pulled from the tap until the page is signed in again. The store's sign out waits for
// the seed lock while the records stay readable, and the API's queue runs the next request as the one before it answers:
// a request queued behind the tap must find the stop pulled, not a fresh one.
test("a signed-in page renews the stop: on every landing, and when its sign out is refused", () => {
  assert.match(MAIN, /const quotesSignedIn = quotes\.signedIn;/);
  assert.match(block("async function landed(l: Landing): Promise<void> {", "\n}\n"), /^async function landed\(l: Landing\): Promise<void> \{\n(?: {2}\/\/[^\n]*\n)* {2}quotesSignedIn\(\);/);
  assert.match(block("async function signOut(): Promise<void> {", "\n}\n"), /try \{\n {4}await s\.signOut\(\);\n {2}\} catch \(e\) \{\n(?: {4}\/\/[^\n]*\n)* {4}quotesSignedIn\(\);\n {4}throw e;\n {2}\}/);
  // nowhere else: a sign out never renews it
  assert.equal(MAIN.split("quotesSignedIn()").length - 1, 2);
});

const RECORD = { status: { source: "code", code_saved: true }, deposit: { v: 1, scope: "7", index: 3, id: "5d".repeat(32) } } as const;
const PARAMS = { origin_asset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", amount: "25" };
/** deposit.quote on `page`'s stop, the records `records()` says, each ask counted; `hang` keeps an ask in flight until
 *  its signal ends it. */
async function host(page: { stopped: () => AbortSignal }, records: () => boolean, hang = false) {
  const { depositQuoteHost } = await import("../src/deposit-wire.ts");
  const sent: unknown[] = [];
  const quote = depositQuoteHost({
    scope: () => 7n,
    read: async () => (records() ? RECORD : null),
    fetch: (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).recipient);
      if (hang) return new Promise<Response>((_ok, no) => init.signal!.addEventListener("abort", () => no(init.signal!.reason), { once: true }));
      return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
    now: () => Date.parse("2026-11-02T06:00:00.000Z"),
    checked: async () => {},
    stop: page.stopped,
  });
  return { sent, quote };
}

test("the reviewer's case: a deposit.quote queued behind one in flight at the tap sends nothing", async () => {
  const { quotesStop } = await import("../src/quotes-stop.ts");
  const page = quotesStop();
  const h = await host(page, () => true, true);
  const a = h.quote(PARAMS, { id: "a" });
  while (h.sent.length === 0) await new Promise((ok) => setImmediate(ok));
  page.signedOut(); // Sign out tapped; the store's sign out still waits, the records stand
  await a.after;
  assert.deepEqual(a.answer(), { error: "down" });
  const b = h.quote(PARAMS, { id: "b" }); // the API queue runs B now
  await b.after;
  assert.deepEqual(b.answer(), { error: "down" });
  assert.equal(h.sent.length - 1, 0, "asks after the tap");
});

test("a sign out refused, then a quote: it goes out (signedIn renews the stop)", async () => {
  const { quotesStop } = await import("../src/quotes-stop.ts");
  const page = quotesStop();
  const h = await host(page, () => true);
  page.signedOut();
  const held = h.quote(PARAMS, { id: "held" });
  await held.after;
  assert.equal(h.sent.length, 0, "nothing while the sign out runs");
  page.signedIn(); // main.ts signOut's catch
  const d = h.quote(PARAMS, { id: "after" });
  await d.after;
  assert.equal(h.sent.length, 1, "the quote after the refused sign out went out");
  assert.deepEqual(d.answer(), { error: "down" }); // the helper's 503, as data
});

test("sign out, sign in, a quote: it goes out on the fresh stop, and the one under way at the sign out did not", async () => {
  const { quotesStop } = await import("../src/quotes-stop.ts");
  const page = quotesStop();
  const before = page.stopped();
  page.signedIn(); // signed in already: the same stop
  assert.equal(page.stopped(), before);
  page.signedOut();
  assert.equal(before.aborted, true);
  assert.equal(page.stopped().aborted, true, "a sign out never renews the stop");
  page.signedIn(); // landed()
  assert.equal(page.stopped().aborted, false);
  const h = await host(page, () => true);
  const d = h.quote(PARAMS, { id: "op-2" });
  await d.after;
  assert.equal(h.sent.length, 1, "the quote after the sign in went out");
  assert.deepEqual(d.answer(), { error: "down" }); // the helper's 503, as data
});
