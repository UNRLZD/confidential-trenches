// node --test scripts/live-checks/helper-sell-fee-recipient.test.mjs: the live check replays recorded runs
// (helper-sell-fee-recipient.answers.json). good: a local helper at this card's commit with both EVM testnet pools:
// PASS. bad_deployed: HELPER_HOST before the redeploy, which reads the 10-field Sell (400 bad_shape on each sell): FAIL.
// Made from the good run: a sell paying the wrong address accepted (auth_nonce, or sent with a hash), the fee recipient
// sell refused as fee_recipient, a fee answer naming one address for both or none, a missing commit or read: each FAIL.
// The sells are checked against the helper's own sell checks (apps/helper/src/pool/evm.ts), so each reaches the check
// the live check names it for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evmPoolSender, evmReadSell } from "../../apps/helper/src/pool/evm.ts";
import { evmPoolRecords, randomKey } from "./helper-evm-sender.mjs";
import { judge, OTHER, read, SELLS, sellsOf } from "./helper-sell-fee-recipient.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-sell-fee-recipient.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (run, asked, f, network) => ({ ...run, pools: run.pools.map((p) => (network && p.network !== network ? p : { ...p, reads: p.reads.map((x) => (x.asked === asked ? f(x) : x)) })) });
const body = (x, f) => ({ ...x, body: JSON.stringify(f(JSON.parse(x.body))) });

test("recorded good run: a local helper at this card's commit refuses each sell paying another than its fee recipient, and lets the one paying it through to W's nonce read: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(A.good.pools.map((p) => p.network), Object.keys(evmPoolRecords()));
});

test("recorded bad run: HELPER_HOST on the 10-field Sell answers 400 bad_shape to each sell: FAIL", () => {
  const r = judge(A.bad_deployed);
  assert.equal(r.ok, false);
  for (const p of A.bad_deployed.pools) for (const [asked] of SELLS) assert.ok(bad(r).some((l) => l.startsWith(`BAD [${p.network} ${asked}] POST /v1/pool/evm/sell answers 400`)), bad(r).join("\n"));
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
  for (const asked of ["fee", ...SELLS.map(([a]) => a)]) {
    assert.equal(judge(edit(g, asked, (x) => ({ ...x, headers: Object.fromEntries(Object.entries(x.headers).filter(([k]) => k !== "x-helper-commit")) }))).ok, false, `${asked}: no commit`);
    assert.equal(judge(edit(g, asked, (x) => ({ ...x, headers: { ...x.headers, "x-helper-commit": x.headers["x-helper-commit"].slice(0, 7) } }))).ok, false, `${asked}: a short commit`);
  }
  for (const p of g.pools) assert.equal(judge({ ...g, pools: g.pools.filter((x) => x.network !== p.network) }).ok, false, `${p.network} not read`);
  assert.equal(judge({ ...g, pools: [] }).ok, false);
});

// ---- The sells against the helper's own checks ----

const NOW = 1_800_000_000_000;
const FEE_TO = "0x000000000000000000000000000000000000fee1";
/** A provider that records each call and answers none: a body that reaches it passed every static check. */
const recording = (calls) => async (method, params) => {
  calls.push({ method, params });
  throw new Error("HTTP 502");
};

test("sellsOf() builds what the helper reads: the 11-field Sell, each paying its own address; the fee recipient's reaches the RPC reads, the others are fee_recipient with no RPC call", async () => {
  for (const [network, pool] of Object.entries(evmPoolRecords())) {
    const sellKey = randomKey();
    const s = (calls) => evmPoolSender({ network, pool, senderKey: randomKey(), sellKey, feeRecipient: FEE_TO }, [recording(calls), recording(calls)], () => NOW);
    const seller = s([]).sellSender;
    const sells = sellsOf({ network, pool, feeRecipient: FEE_TO, sellSender: seller, nowMs: NOW });
    assert.deepEqual(Object.keys(sells), SELLS.map(([a]) => a));
    const pays = Object.fromEntries(Object.entries(sells).map(([k, b]) => [k, evmReadSell(new Uint8Array(Buffer.from(b.data.slice(2), "hex"))).feeRecipient]));
    assert.deepEqual(pays, { pays_fee_recipient: FEE_TO, pays_other: OTHER, pays_sell_sender: seller });
    {
      const calls = [];
      const a = await s(calls).sell(sells.pays_fee_recipient);
      assert.ok(calls.length > 0, `${network}: the fee recipient's sell passes every static check (${JSON.stringify(a.body)})`);
    }
    for (const asked of ["pays_other", "pays_sell_sender"]) {
      const calls = [];
      const a = await s(calls).sell(sells[asked]);
      assert.deepEqual([a.status, a.body?.error?.code], [422, "fee_recipient"], `${network} ${asked}: ${JSON.stringify(a.body)}`);
      assert.equal(calls.length, 0, `${network} ${asked}: refused before any RPC call`);
    }
  }
});

test("read() asks each pool for its fee, then posts the three sells, each paying the fee answer's fee recipient, another, and its sell sender (replayed helper)", async () => {
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
  assert.deepEqual(paid, fees.flatMap((f) => [f.fee_recipient, OTHER, f.sell_sender]));
});
