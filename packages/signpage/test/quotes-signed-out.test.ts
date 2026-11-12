// node --test test/quotes-signed-out.test.ts (from packages/signpage): after Sign out the page sends no quote (card
// helper-says-why-a-vendor-refused, review P3). src/main.ts is the page's entry, run only in a browser, so its wiring is
// read here as text: every way the page learns it is signed out (its own Sign out, its store's signout event, another
// tab's) ends the quotes' asks (quotesSignedOut), and every quote host is handed that stop (quotesStopped). The stop's
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
  // declared before the API starts, which reads it as the page loads
  assert.ok(MAIN.indexOf("const quotesStopped") < MAIN.indexOf("stop: quotesStopped"));
});
