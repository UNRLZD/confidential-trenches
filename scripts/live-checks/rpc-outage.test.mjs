// node --test scripts/live-checks/rpc-outage.test.mjs: what the shared judgment of a down RPC (rpc-outage.mjs) reads from
// a real Chrome. rpc-outage.preflights.json is apps/terminal/test/preflight/record.mjs --record, run 9 Nov in the installed
// Chrome (sandbox on) with no route on: a JSON POST from a page in a frame of another site to a local RPC whose preflight
// answered 503, 403, or had nothing listening; and, as the live terminal sits in the signing page, from a frame on the
// page's own site (preflights then come through the page's session) to an RPC answering 503. Playwright shows no preflight, and the POST ends net::ERR_FAILED for the 503
// and the 403 alike, so only watchPreflights' CDP record tells a down RPC from one refusing the origin.
// The rest of the judgment is replayed in app-shell.test.mjs, app-verify-mount.test.mjs and verify-pools.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EVM_READS } from "../../apps/terminal/src/screens/verify/pools.ts";
import { VERIFY_READS } from "../../apps/terminal/src/screens/verify/read.ts";
import { confirmDown, READS_PER_OPEN, readDown } from "./rpc-outage.mjs";

// the record keeps the recorder's ports as PORT; any port serves
const R = JSON.parse(readFileSync(new URL("./rpc-outage.preflights.json", import.meta.url), "utf8").replaceAll("PORT", "8545"));
const origin = "http://127.0.0.1:8545";

test("a real 503 preflight, a real 403 preflight and a real closed port: watchPreflights read each status, and only the first and last are down", () => {
  const c = R.cases;
  assert.deepEqual(c["503"].preflights.map((p) => p.status), [503]);
  assert.deepEqual(c["403"].preflights.map((p) => p.status), [403]);
  assert.deepEqual(c.closed.preflights.map((p) => [p.status, p.failure, p.cors]), [[null, "net::ERR_CONNECTION_REFUSED", false]]);
  // the same POST failure for the 503 and the 403, which is why the preflight's status is recorded
  assert.equal(c["503"].reads[0].failure, "net::ERR_FAILED");
  assert.equal(c["403"].reads[0].failure, "net::ERR_FAILED");
  assert.equal(c.closed.reads[0].failure, "net::ERR_CONNECTION_REFUSED");
  assert.equal(readDown(c["503"].reads[0], c["503"].preflights), true, "preflight 503: down");
  assert.equal(readDown(c["403"].reads[0], c["403"].preflights), false, "preflight 403: the RPC refusing the origin");
  assert.equal(readDown(c.closed.reads[0], c.closed.preflights), true, "nothing listening: down");
  assert.equal(readDown(c["503"].reads[0], []), false, "ERR_FAILED with no preflight recorded");
  // and through confirmDown, the way the checks use them
  for (const [name, want] of [["503", true], ["403", false], ["closed", true]]) {
    const k = c[name];
    const { some } = confirmDown(new Set([origin]), k.reads, { pre: k.preflights });
    assert.equal(some.has(origin), want, name);
  }
});

test("a cached good preflight does not hide a refused connection; only ERR_FAILED needs the preflight", () => {
  const c = R.cases;
  const good = [{ url: `${origin}/`, status: 200, failure: null, cors: false }];
  assert.equal(readDown(c.closed.reads[0], good), true, "ERR_CONNECTION_REFUSED beside a 200 preflight");
  assert.equal(readDown(c["403"].reads[0], good), false, "ERR_FAILED beside a 200 preflight");
});

test("the reads of one open are counted from the code's own lists", () => {
  assert.deepEqual(READS_PER_OPEN, { near: 1 + VERIFY_READS.length, solana: 1, evm: 1 + EVM_READS.length });
  assert.deepEqual(READS_PER_OPEN, { near: 8, solana: 1, evm: 7 });
});

test("a real 503 preflight seen from a frame on the page's own site (the live terminal in the signing page) is read and down", () => {
  const c = R.cases.sameSite;
  assert.ok(c, "the record holds the same-site case");
  const o = "http://localhost:8545";
  assert.deepEqual(c.preflights.map((p) => [p.url, p.status]), [[`${o}/`, 503]]);
  assert.equal(c.reads[0].failure, "net::ERR_FAILED");
  assert.equal(readDown(c.reads[0], c.preflights), true);
  assert.equal(readDown(c.reads[0], []), false, "without the preflight record, ERR_FAILED is not down");
  assert.equal(confirmDown(new Set([o]), c.reads, { pre: c.preflights }).some.has(o), true);
});
