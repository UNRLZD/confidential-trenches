// node --test test/pace.test.ts: one pace per provider URL for the whole page (src/pace.ts, card wallet-id-reader-paced).
// Delta review 2 of 71cb1284: P1, a request waits for its slot under its caller's own signal only and its deadline starts
// when the slot comes (before, the readers' 10 s deadline ran in the pace queue, so the fourth request queued on
// FastNEAR's 2.56 s gap timed out unsent and four chains at once stalled for good); P3-1, every reader of the page is on
// pacedFetch by default.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import * as P from "../src/pace.ts";
import { bindRpc } from "../src/deposit/bind.ts";
import { followRpc } from "../src/deposit/follow.ts";
import { archivalRpc, moveOutRpc } from "../src/deposit/moveout.ts";
import { relayRpc } from "../src/withdraw/relay.ts";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";

const FAST = NEAR_NETWORKS.mainnet.fastnear[0];
const DRPC = NEAR_NETWORKS.mainnet.drpc;
beforeEach(() => P.resetPaces());
const answer = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "blindfill", result: { ok: true } }), { status: 200 });

// five relay-like chains at once, each three reads in a row on FastNEAR, the readers' own default deadline: 15 requests
// past a burst of 8 at 2.56 s apart, the last slot about 18 s after the first, every one answered
test("five FastNEAR chains at once on the page's pace: every request answered, none timed out in the queue", { timeout: 60_000 }, async () => {
  let sent = 0;
  const f = P.pacedFetch(FAST, async (_u, init) => (sent++, assert.equal(init?.signal?.aborted, false), answer()));
  const rpc = relayRpc(FAST, f);
  const chain = async () => {
    for (let k = 0; k < 3; k++) assert.deepEqual(await rpc.query({ request_type: "view_account", finality: "final", account_id: "intents.near" }), { jsonrpc: "2.0", id: "blindfill", result: { ok: true } });
  };
  const t = performance.now();
  await Promise.all([chain(), chain(), chain(), chain(), chain()]);
  assert.equal(sent, 15);
  assert.ok(performance.now() - t > 15_000, `15 requests in ${performance.now() - t} ms: the pace held`);
});

test("a wait its caller ends gives its slot back, sends nothing and throws the caller's reason", async () => {
  let sent = 0;
  const f = P.pacedFetch(FAST, async () => (sent++, answer()));
  for (let k = 0; k < 8; k++) await f(FAST);
  const p = P.paceOf(FAST);
  const before = p.tat;
  const c = new AbortController();
  setTimeout(() => c.abort(new Error("signed out")), 30);
  await assert.rejects(f(FAST, { signal: c.signal }), /^Error: signed out$/);
  assert.equal(sent, 8);
  assert.ok(p.tat <= before + 1, `tat ${p.tat - before} ms on after the wait was ended`);
  // a signal already aborted takes no slot
  const d = new AbortController();
  d.abort(new Error("gone"));
  const t0 = p.tat;
  await assert.rejects(f(FAST, { signal: d.signal }), /^Error: gone$/);
  assert.equal(p.tat, t0);
});

test("the deadline starts at the slot and still bounds the request", async () => {
  const f = P.pacedFetch(FAST, (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason))), 100);
  const t = performance.now();
  await assert.rejects(f(FAST), (e: Error) => e.name === "TimeoutError");
  assert.ok(performance.now() - t < 2_000);
  // a reader on a pacedFetch leaves its deadline to it; on another fetch the reader bounds it
  assert.equal(P.deadlineOf(f, 10_000), null);
  assert.equal(P.deadlineOf(fetch, 10_000), 10_000);
  assert.equal(P.requestSignal(f, 10_000), undefined);
  assert.ok(P.requestSignal(fetch, 10_000) instanceof AbortSignal);
});

test("every reader of the page is on its URL's one pace by default (review P3-1)", () => {
  for (const u of [FAST, DRPC]) {
    for (const [name, rpc] of [["bindRpc", bindRpc(u)], ["followRpc", followRpc(u)], ["moveOutRpc", moveOutRpc(u)], ["relayRpc", relayRpc(u)], ["archivalRpc", archivalRpc(u)], ["pacedNearRpc", P.pacedNearRpc(u)]] as const) assert.ok(P.isPacedRpc(rpc), `${name}(${u})`);
    // a reader given its own fetch is not paced at its transport (the IdReader then takes the slot itself)
    assert.equal(P.isPacedRpc(relayRpc(u, async () => answer())), false);
  }
});
