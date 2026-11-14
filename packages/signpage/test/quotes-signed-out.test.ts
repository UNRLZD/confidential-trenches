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
  // its own Sign out, at the tap, with no new run (card sign-out-stops-the-pages-reads' `leaving`)
  assert.match(block("async function signOut(): Promise<void> {", "\n}\n"), /\n {2}leaving = true;\n(?: {2}\/\/[^\n]*\n)* {2}quotesSignedOut\(\);\n/);
  // another tab's, heard on the store's channel or the shell's: both reach signedOutElsewhere, which stops the quotes
  // right after it closes the page's gate
  assert.match(block('if (e.kind !== "signout") return;', 'show("signed-out");'), /\n {6}signedOutElsewhere\(\);\n/);
  assert.match(block("function storeMoved(e: WalletEvent): void {", "\n}\n"), /if \(e\.kind === "signout"\) signedOutElsewhere\(\);/);
  assert.match(block("function signedOutElsewhere(): void {", "\n}\n"), /\n {2}closeHostLanes\(\);\n {2}quotesSignedOut\(\);\n/);
  assert.equal(MAIN.split("quotesSignedOut()").length - 1, 2);
});

test("every quote host gets the page's stop: deposit.quote, pool.address and the sheet's reads on both pages", () => {
  assert.match(MAIN, /"deposit\.quote": depositQuoteHost\(\{[^\n]*stop: quotesStopped \}\)/);
  assert.match(MAIN, /"pool\.address": poolAddressHost\(\{[^\n]*stop: quotesStopped \}\)/);
  // and each page's pool floors (card deposit-takes-each-pools-own-coin: deposit.assets lists each pool's own coin)
  assert.equal(MAIN.split("depositReadHosts({ stop: quotesStopped, poolFloor: pagePoolFloor })").length - 1, 2);
  assert.equal(MAIN.split("depositReadHosts(").length - 1, 2);
  // declared before the API starts, which reads it as the page loads, from the page's one stop (src/quotes-stop.ts)
  assert.ok(MAIN.indexOf("const quotesStopped") < MAIN.indexOf("stop: quotesStopped"));
  assert.match(MAIN, /const quotes = quotesStop\(\);\nconst quotesStopped = quotes\.stopped;\nconst quotesSignedOut = quotes\.signedOut;/);
});

/** Each call of `name` in main.ts, from its `({` to the matching `})`. */
function calls(name: string): string[] {
  const out: string[] = [];
  for (let at = MAIN.indexOf(`${name}({`); at >= 0; at = MAIN.indexOf(`${name}({`, at + 1)) {
    let depth = 0;
    let i = at + name.length + 1;
    for (; i < MAIN.length; i += 1) {
      if (MAIN[i] === "{") depth += 1;
      else if (MAIN[i] === "}" && --depth === 0) break;
    }
    out.push(MAIN.slice(at, i + 1));
  }
  return out;
}

// Card move-one-confidential-swap: every 1Click quote the page asks is one confidential swap, held to 1Click's keyless
// tell, and the tell reads on the host's own signal, the page's stop (its effect: test/pool-deposit-address.test.ts and
// test/rules-deposit-quote.test.ts). The hosts: deposit.quote and pool.address (money in from an outside wallet), the
// Move's quote into a pool (poolMoveAddress) and into Cash (poolCoinQuote). No host is built and left unused.
test("every 1Click quote host is confidential, and its keyless tell reads on the page's stop", () => {
  const hosts = [...calls("depositQuoteHost"), ...calls("poolAddressHost")];
  assert.equal(hosts.length, 4, hosts.map((h) => h.slice(0, 60)).join("\n"));
  for (const h of hosts) {
    assert.match(h, /\bstop: quotesStopped\b/, h.slice(0, 80));
    assert.match(h, /\bconfidential: true\b/, h.slice(0, 80));
    assert.match(h, /\bhidden: \(address, signal\) => oneClickHidden\(address, fetch, signal\)/, h.slice(0, 80));
  }
  // the tell is read nowhere else, so never off a host's stop
  assert.equal(MAIN.split("oneClickHidden(").length - 1, 4);
  for (const name of ["poolCoinQuote", "poolMoveAddress"]) assert.ok(MAIN.split(name).length - 1 >= 2, `${name} is used`);
  assert.doesNotMatch(MAIN, /const poolAddress = /);
});

// Delta review P2-2: the stop stays pulled from the tap until the page is signed in again. The store's sign out waits for
// the seed lock while the records stay readable, and the API's queue runs the next request as the one before it answers:
// a request queued behind the tap must find the stop pulled, not a fresh one.
test("a signed-in page renews the stop: on every landing, and when its sign out is refused", () => {
  assert.match(MAIN, /const quotesSignedIn = quotes\.signedIn;/);
  // a landing renews it, unless the page's gate is closed (a sign out landed: the page reloads instead)
  assert.match(block("async function landed(l: Landing): Promise<void> {", "\n}\n"), /^async function landed\(l: Landing\): Promise<void> \{\n(?: {2}\/\/[^\n]*\n)* {2}if \(hostLanesClosed\(\)\) return void \([^\n]*location\.reload\(\)\);\n(?: {2}\/\/[^\n]*\n)* {2}quotesSignedIn\(\);\n/);
  // a sign out refused with this account's seed still stored: still signed in
  assert.match(block("async function signOut(): Promise<void> {", "\n}\n"), /if \(still !== undefined\) \{\n {6}still\.entropy\.fill\(0\);\n {6}leaving = false;\n(?: {6}\/\/[^\n]*\n)* {6}quotesSignedIn\(\);\n {6}throw refused\.e;\n {4}\}/);
  // nowhere else: a sign out never renews it
  assert.equal(MAIN.split("quotesSignedIn()").length - 1, 2);
});

// Delta review P3-5: pool.address hands its stop to the floor read, and the page's floor hands it to the Solana reads,
// whose fee read names U_X (the read itself: test/pool-deposit-address.test.ts)
test("the page's floor read passes the stop on to the Solana floor's reads", () => {
  assert.match(block("const floorFor = async (", "\n  };\n"), /^const floorFor = async \(chain: PoolChain, wallet: string, signal\?: AbortSignal\)[^\n]*\n[^\n]*\n[^\n]*\n {4}return [^\n]*readSolanaPoolFloor\(pair, PAGE_SOL_PIN\.program, wallet, signal\) : null;$/);
  assert.match(MAIN, /"pool\.address": poolAddressHost\(\{[^\n]*floor: floorFor,/);
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
  // A's ask was cut mid-flight (down); B never asked: a signed-out page's answer
  assert.deepEqual(b.answer(), { error: "not_allowed" });
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
