// node --test scripts/live-checks/helper-sell-fee-recipient.test.mjs: the live check replays recorded runs
// (helper-sell-fee-recipient.answers.json). good: a local helper at card helper-sender-fee-proof's commit with both EVM
// testnet pools and the kit's pinned fee collectors (the deployed FeeCollectors): PASS. bad_fee_recipient: card helper-sell-fee-recipient's own good run (a
// local helper at feb84e3a), which lets a Sell paying the withdraw's fee recipient through and names no collector: FAIL.
// bad_deployed: HELPER_HOST before the redeploy, which reads the 10-field Sell (400 bad_shape on each sell): FAIL.
// Made from the good run: a sell paying the wrong address accepted (auth_nonce, or sent with a hash), the collector's
// sell refused as fee_recipient, a fee answer naming one address for two or none, a missing commit or read: each FAIL.
// The sells are checked against the helper's own sell checks (apps/helper/src/pool/evm.ts), so each reaches the check
// the live check names it for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evmPoolSender, evmReadSell } from "../../apps/helper/src/pool/evm.ts";
import { evmPoolRecords as currentRecords, feeCollectors, FIRST_SET, randomKey } from "./helper-evm-sender.mjs";
import { judge as judgeLive, OTHER, read as readLive, SELLS, sellsOf } from "./helper-sell-fee-recipient.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-sell-fee-recipient.answers.json"), "utf8"));
// The recordings were made 6 Nov on the testnets' first pool set (FIRST_SET), before card pool-evm-buy-pays-revert's
// pools: a replay judges each on the pools it was recorded on; the live check reads the current set (evmPoolRecords()).
const evmPoolRecords = () => currentRecords(undefined, FIRST_SET);
const judge = (run, records = evmPoolRecords(), collectors) => judgeLive(run, records, collectors);
const read = (base, fetchFn, records = evmPoolRecords()) => readLive(base, fetchFn, records);
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (run, asked, f, network) => ({ ...run, pools: run.pools.map((p) => (network && p.network !== network ? p : { ...p, reads: p.reads.map((x) => (x.asked === asked ? f(x) : x)) })) });
const body = (x, f) => ({ ...x, body: JSON.stringify(f(JSON.parse(x.body))) });

test("recorded good run: a local helper at card helper-sender-fee-proof's commit refuses each sell paying another than its fee collector, and lets the one paying it through to W's nonce read: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(A.good.pools.map((p) => p.network), Object.keys(evmPoolRecords()));
});

test("recorded bad run: a helper that takes a Sell paying the withdraw's fee recipient and names no fee collector: FAIL", () => {
  const r = judge(A.bad_fee_recipient);
  assert.equal(r.ok, false);
  for (const p of A.bad_fee_recipient.pools) {
    assert.ok(bad(r).some((l) => l.startsWith(`BAD [${p.network} fee]`) && l.includes("fee_collector none")), bad(r).join("\n"));
    assert.ok(bad(r).some((l) => l.startsWith(`BAD [${p.network} pays_fee_recipient] POST /v1/pool/evm/sell answers 422`) && l.includes("auth_nonce")), bad(r).join("\n"));
  }
});

test("recorded bad run: HELPER_HOST on the 10-field Sell answers 400 bad_shape to each sell: FAIL", () => {
  const r = judge(A.bad_deployed);
  assert.equal(r.ok, false);
  // recorded before pays_collector was asked: each sell it read answers 400 bad_shape, and pays_collector is not read
  for (const p of A.bad_deployed.pools) for (const [asked] of SELLS.filter(([a]) => a !== "pays_collector")) assert.ok(bad(r).some((l) => l.startsWith(`BAD [${p.network} ${asked}] POST /v1/pool/evm/sell answers 400`)), bad(r).join("\n"));
});

test("a sell paying the wrong address accepted, the right one refused, a sell sent, or another status: each FAIL, on each pool", () => {
  const g = A.good;
  for (const { network } of g.pools) {
    for (const [asked, , code] of SELLS) {
      const sent = judge(edit(g, asked, (x) => ({ ...x, status: 200, body: `{"hash":"0x${"11".repeat(32)}"}` }), network));
      assert.equal(sent.ok, false, `${network} ${asked} sent`);
      assert.ok(bad(sent).some((l) => l.startsWith(`BAD [${network} ${asked}]`)), bad(sent).join("\n"));
      const other = code === "fee_recipient" ? "auth_nonce" : "fee_recipient";
      assert.equal(judge(edit(g, asked, (x) => ({ ...x, body: `{"error":{"code":"${other}"}}` }), network)).ok, false, `${network} ${asked} as ${other}`);
      assert.equal(judge(edit(g, asked, (x) => ({ ...x, status: 400 }), network)).ok, false, `${network} ${asked} at 400`);
      assert.equal(judge({ ...g, pools: g.pools.map((p) => (p.network === network ? { ...p, reads: p.reads.filter((x) => x.asked !== asked) } : p)) }).ok, false, `${network} ${asked} not read`);
    }
  }
});

test("the fee answer: not 200, no fee recipient, no sell sender, or one address for both: each FAIL; a missing or short commit, or a pool not read: FAIL", () => {
  const g = A.good;
  assert.equal(judge(edit(g, "fee", (x) => ({ ...x, status: 404 }))).ok, false);
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee_recipient: null })))).ok, false);
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, sell_sender: null })))).ok, false);
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, sell_sender: b.fee_recipient })))).ok, false, "one address for both");
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee_collector: null })))).ok, false, "no collector");
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee_collector: b.fee_recipient })))).ok, false, "the collector is the fee recipient");
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee_collector: b.sell_sender })))).ok, false, "the collector is the sell sender");
  for (const asked of ["fee", ...SELLS.map(([a]) => a)]) {
    assert.equal(judge(edit(g, asked, (x) => ({ ...x, headers: Object.fromEntries(Object.entries(x.headers).filter(([k]) => k !== "x-helper-commit")) }))).ok, false, `${asked}: no commit`);
    assert.equal(judge(edit(g, asked, (x) => ({ ...x, headers: { ...x.headers, "x-helper-commit": x.headers["x-helper-commit"].slice(0, 7) } }))).ok, false, `${asked}: a short commit`);
  }
  for (const p of g.pools) assert.equal(judge({ ...g, pools: g.pools.filter((x) => x.network !== p.network) }).ok, false, `${p.network} not read`);
  assert.equal(judge({ ...g, pools: [] }).ok, false);
});

// card helper-sender-fee-proof, review M1: nothing tied the fee answer's collector to the real FeeCollector, so a wrong
// POOL_EVM_FEE_COLLECTOR_<NETWORK> would read every sale as paid
test("the fee collector: the kit's pin, which is evm-fee-collector's record; a stand-in, the other testnet's, a pin off the record, a record off the pin or no pin: each FAIL", () => {
  const g = A.good;
  const c = feeCollectors();
  assert.deepEqual(Object.fromEntries(Object.entries(c).map(([n, x]) => [n, x.pin])), { "base-sepolia": "0x9cc4788af51677aaa7770d78277c41fb864b35e1", "robinhood-testnet": "0xb174f0e859f00a7b593baca38394327e3d6bf638" });
  for (const [n, x] of Object.entries(c)) assert.equal(x.recorded, x.pin, `${n}: the pin is the record's FeeCollector`);
  const line = (r, n) => bad(r).some((l) => l.startsWith(`BAD [${n} fee] fee_collector`));
  for (const n of Object.keys(c)) {
    const other = Object.keys(c).find((x) => x !== n);
    for (const coll of ["0x00000000000000000000000000000000c011ec70", c[other].pin]) {
      const r = judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee_collector: coll })), n));
      assert.ok(!r.ok && line(r, n), `${n} ${coll}: ${bad(r).join("\n")}`);
    }
    for (const [why, cs] of [["a record off the pin", { ...c, [n]: { ...c[n], recorded: "0x00000000000000000000000000000000c011ec70" } }], ["no record", { ...c, [n]: { ...c[n], recorded: null } }], ["no pin", { ...c, [n]: { ...c[n], pin: null } }]]) {
      const r = judge(g, undefined, cs);
      assert.ok(!r.ok && line(r, n), `${n} ${why}: ${bad(r).join("\n")}`);
    }
  }
});

// ---- The sells against the helper's own checks ----

const NOW = 1_800_000_000_000;
const FEE_TO = "0x000000000000000000000000000000000000fee1";
const COLLECTOR = "0x000000000000000000000000000000000000c011";
/** A provider that records each call and answers none: a body that reaches it passed every static check. */
const recording = (calls) => async (method, params) => {
  calls.push({ method, params });
  throw new Error("HTTP 502");
};

test("sellsOf() builds what the helper reads: the 11-field Sell, each paying its own address; the collector's reaches the RPC reads, the others are fee_recipient with no RPC call", async () => {
  for (const [network, pool] of Object.entries(evmPoolRecords())) {
    const sellKey = randomKey();
    const s = (calls) => evmPoolSender({ network, pool, senderKey: randomKey(), sellKey, feeRecipient: FEE_TO, feeCollector: COLLECTOR }, [recording(calls), recording(calls)], () => NOW);
    const seller = s([]).sellSender;
    const sells = sellsOf({ network, pool, feeCollector: COLLECTOR, feeRecipient: FEE_TO, sellSender: seller, nowMs: NOW });
    assert.deepEqual(Object.keys(sells), SELLS.map(([a]) => a));
    const pays = Object.fromEntries(Object.entries(sells).map(([k, b]) => [k, evmReadSell(new Uint8Array(Buffer.from(b.data.slice(2), "hex"))).feeRecipient]));
    assert.deepEqual(pays, { pays_collector: COLLECTOR, pays_fee_recipient: FEE_TO, pays_other: OTHER, pays_sell_sender: seller });
    {
      const calls = [];
      const a = await s(calls).sell(sells.pays_collector);
      assert.ok(calls.length > 0, `${network}: the collector's sell passes every static check (${JSON.stringify(a.body)})`);
    }
    for (const asked of ["pays_fee_recipient", "pays_other", "pays_sell_sender"]) {
      const calls = [];
      const a = await s(calls).sell(sells[asked]);
      assert.deepEqual([a.status, a.body?.error?.code], [422, "fee_recipient"], `${network} ${asked}: ${JSON.stringify(a.body)}`);
      assert.equal(calls.length, 0, `${network} ${asked}: refused before any RPC call`);
    }
  }
});

test("read() asks each pool for its fee, then posts the four sells, each paying the fee answer's fee collector, its fee recipient, another, and its sell sender (replayed helper)", async () => {
  const asked = [];
  const paid = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    asked.push(`${init.method ?? "GET"} ${u.pathname}${u.search}`);
    const pool = u.searchParams.get("pool") ?? JSON.parse(init.body).pool;
    if (init.body) paid.push(evmReadSell(new Uint8Array(Buffer.from(JSON.parse(init.body).data.slice(2), "hex"))).feeRecipient);
    const p = A.good.pools.find((x) => x.pool === pool);
    const r = u.pathname === "/v1/pool/fee" ? p.reads[0] : p.reads.find((x) => x.asked === "pays_other");
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  const run = await read("http://h.invalid", fetchFn);
  const records = evmPoolRecords();
  assert.deepEqual(asked, Object.values(records).flatMap((pool) => [`GET /v1/pool/fee?pool=${pool}`, ...SELLS.map(() => "POST /v1/pool/evm/sell")]));
  assert.deepEqual(run.pools.map((p) => [p.network, p.reads.map((x) => x.asked)]), Object.keys(records).map((n) => [n, ["fee", ...SELLS.map(([a]) => a)]]));
  const fees = A.good.pools.map((p) => JSON.parse(p.reads[0].body));
  assert.deepEqual(paid, fees.flatMap((f) => [f.fee_collector, f.fee_recipient, OTHER, f.sell_sender]));
});

// card evm-fee-quiet-epoch: the fee read goes through evm-pool-fee-epoch.mjs. The helper has no block yet in the first
// moment of a minute (503 index_behind; 404 not_found before its change): the epoch before is asked, and a chain with no
// block for a minute is INCONCLUSIVE, never PASS (its plants are then not sent).
const NO_BLOCK = [503, '{"error":{"code":"index_behind"}}'];
const NOT_FOUND = [404, '{"error":{"code":"not_found"}}'];
/** read() against a fake helper: `first` answers the fee asked for the helper's now, `second` the one with &epoch=; the
 *  plants are answered with the good run's, in order. */
async function planted(first, second) {
  const asked = [];
  const posted = {};
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const pool = u.searchParams.get("pool") ?? JSON.parse(init.body).pool;
    const p = A.good.pools.find((x) => x.pool === pool);
    asked.push(`${init.method ?? "GET"} ${u.pathname}${u.search}`);
    if (init.method === "POST") {
      const plants = p.reads.filter((x) => x.asked !== "fee");
      const r = plants[(posted[pool] = (posted[pool] ?? -1) + 1)];
      return new Response(r.body, { status: r.status, headers: r.headers });
    }
    const a = u.searchParams.has("epoch") ? second : first;
    const r = p.reads[0];
    return a === "good" ? new Response(r.body, { status: r.status, headers: r.headers }) : new Response(a[1], { status: a[0], headers: r.headers });
  };
  const run = await read("http://h.invalid", fetchFn);
  return { run, asked, r: judge(run) };
}

for (const [name, first] of [["503 index_behind", NO_BLOCK], ["404 not_found", NOT_FOUND]]) {
  test(`the first fee answer ${name} and the epoch before's 200 passes, both asks recorded`, async () => {
    const { run, asked, r } = await planted(first, "good");
    assert.equal(r.verdict, "PASS", r.lines.join("\n"));
    assert.equal(asked.filter((u) => u.startsWith("GET ")).length, 2 * run.pools.length);
    assert.equal(asked.filter((u) => u.includes("&epoch=")).length, run.pools.length);
    for (const p of run.pools) assert.deepEqual(p.reads.slice(0, 2).map((x) => [x.asked, x.status]), [["fee_first", first[0]], ["fee", 200]]);
  });
}

test("503 index_behind on the epoch and the one before is INCONCLUSIVE, never PASS, with a line that says why; no plant is sent", async () => {
  const { asked, r } = await planted(NO_BLOCK, NO_BLOCK);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("QUIET") && /no block in the epoch or the one before/.test(l)), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => l.startsWith("BAD")), r.lines.join("\n"));
  assert.ok(asked.every((u) => u.startsWith("GET ")), "no POST");
});

test("404 not_found on the epoch and the one before fails: the pool is not carried", async () => {
  const { r } = await planted(NOT_FOUND, NOT_FOUND);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && /fee\] GET \/v1\/pool\/fee answers 404/.test(l) || l.startsWith("BAD") && /fee\] 404/.test(l)), r.lines.join("\n"));
});
