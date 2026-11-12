// POST /v1/bind/record (card near-holdings-restore): a device restoring from its 12 words learns, for each of its NEAR
// trade wallets W, the token W bought and W's own signed calls, from the helper's trade store, only for a W the vault
// paid, with no read that names W going to a provider.
//   node --test apps/helper/src/bind/record.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { HELPER_BIND_RECORD_WALLETS_MAX, HELPER_V1_PATHS, type HelperBindRecordAnswer } from "@blindfill/kit";
import type { BindSender } from "./env.ts";
import { parseRecordBody, readRecords, RECORD_BODY_MAX, type RecordDeps } from "./record.ts";
import { accountSlots, type Rpc } from "./send.ts";
import { createTradeReads, createTradeStore, type TradeRecord } from "./trade.ts";
import { API_RATE_MAX, handler, RECORD_RATE_MAX, RECORD_TOTAL_MAX } from "../server.ts";

const W1 = "a1".repeat(32);
const W2 = "b2".repeat(32);
const W3 = "c3".repeat(32);
const VAULT = "vault.testnet";
const USDC = "usdc.testnet";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NOW = 1_800_000_000_000;

// ---- a stand-in of two NEAR providers: final blocks that move, and the vault's spends list ----

type Row = { index: number; recipient: string; status: string; refund_value: string };
type Seen = { url: number; method: string; params: Record<string, unknown> };
const hashOf = (h: number) => `H${String(h).replace(/0/g, "o")}`.padEnd(40, "A");
function chain(rows: Row[], o: { disagree?: boolean; fail?: () => boolean } = {}) {
  let height = 1000;
  const seen: Seen[] = [];
  const rpcs = [0, 1].map((url) => async (method: string, params: Record<string, unknown>) => {
    seen.push({ url, method, params });
    if (o.fail?.()) throw new Error("HTTP 500");
    const header = (h: number) => ({ header: { height: h, hash: hashOf(h), gas_price: "100000000", timestamp_nanosec: String(BigInt(NOW) * 1_000_000n) } });
    if (method === "block") return header(params.finality === "final" ? (url === 0 ? ++height : height) : Number(params.block_id));
    if (method === "query" && params.method_name === "spends") {
      const { from, limit } = JSON.parse(Buffer.from(String(params.args_base64), "base64").toString("utf8")) as { from: number; limit: number };
      let page = rows.slice(from, from + limit);
      if (o.disagree === true && url === 1) page = page.map((r) => ({ ...r, status: "refund_pending" }));
      return { block_height: params.block_id, block_hash: hashOf(Number(params.block_id)), result: [...Buffer.from(JSON.stringify(page))] };
    }
    throw new Error(`not served: ${method}`);
  }) as unknown as readonly [Rpc, Rpc];
  return { rpcs, seen, spends: () => seen.filter((s) => s.method === "query" && s.params.method_name === "spends") };
}
const row = (index: number, recipient: string, status: string, refund_value = "0"): Row => ({ index, recipient, status, refund_value });
const readsOn = (rpcs: readonly [Rpc, Rpc]) => createTradeReads(rpcs, VAULT, USDC, () => NOW);
const spendArgs = (s: Seen) => JSON.parse(Buffer.from(String(s.params.args_base64), "base64").toString("utf8")) as { from: number; limit: number };

test("payoutsLanded: one call for several wallets reads the spends list once (one page on each provider), in the asked order: paid, settled with no refund, bounced, settled with a refund, none", async () => {
  const W4 = "d4".repeat(32);
  const W5 = "e5".repeat(32);
  const c = chain([row(0, W1, "paid"), row(1, W2, "settled"), row(2, W3, "refund_pending", "0"), row(3, W4, "settled", "5")]);
  const r = readsOn(c.rpcs);
  assert.deepEqual(await r.payoutsLanded([W1, W2, W3, W4, W5]), [true, true, false, false, false]);
  assert.equal(c.spends().length, 2, "the list once, on both providers");
  assert.ok(c.spends().every((s) => !JSON.stringify(s.params).includes(W1.slice(0, 16))), "no read names a wallet");
});

test("payoutsLanded: a row read before as not landed is read again with its whole 100-row page at the new block, never one row alone (no read singles out W's row), and each page once per call", async () => {
  const rows = [row(0, W1, "refund_pending"), row(1, W2, "refund_pending"), row(2, W3, "paid")];
  const c = chain(rows);
  const r = readsOn(c.rpcs);
  assert.deepEqual(await r.payoutsLanded([W1, W2]), [false, false]);
  rows[0] = row(0, W1, "paid");
  const before = c.spends().length;
  assert.deepEqual(await r.payoutsLanded([W1, W2, W3]), [true, false, true]);
  const again = c.spends().slice(before);
  // the catch-up from the cursor (row 3) on each provider, then page 0 once on each: never a one-row read
  assert.deepEqual(again.map(spendArgs), [{ from: 3, limit: 100 }, { from: 3, limit: 100 }, { from: 0, limit: 100 }, { from: 0, limit: 100 }]);
});

test("payoutsLanded: a page the two providers disagree on is no answer (it throws, nothing decided)", async () => {
  const c = chain([row(0, W1, "paid")], { disagree: true });
  await assert.rejects(readsOn(c.rpcs).payoutsLanded([W1]), /disagree/);
});

// ---- the body ----

test("the body: exactly {network, wallets} with 1 to 64 distinct 64-lowercase-hex wallets; anything else is null", () => {
  assert.deepEqual(parseRecordBody({ network: "testnet", wallets: [W1, W2] }), { network: "testnet", wallets: [W1, W2] });
  assert.deepEqual(parseRecordBody({ network: "mainnet", wallets: [W1] }), { network: "mainnet", wallets: [W1] });
  const max = Array.from({ length: HELPER_BIND_RECORD_WALLETS_MAX }, (_, i) => i.toString(16).padStart(64, "0"));
  assert.notEqual(parseRecordBody({ network: "testnet", wallets: max }), null);
  for (const bad of [
    null,
    [],
    "x",
    {},
    { network: "testnet" },
    { wallets: [W1] },
    { network: "testnet", wallets: [W1], extra: 1 },
    { network: "devnet", wallets: [W1] },
    { network: "testnet", wallets: [] },
    { network: "testnet", wallets: [...max, "f".repeat(64)] },
    { network: "testnet", wallets: [W1, W1] },
    { network: "testnet", wallets: [W1.toUpperCase()] },
    { network: "testnet", wallets: [W1.slice(2)] },
    { network: "testnet", wallets: [`${W1}0`] },
    { network: "testnet", wallets: [1] },
    { network: "testnet", wallets: W1 },
    { network: "testnet", wallet: W1 },
  ])
    assert.equal(parseRecordBody(bad), null, JSON.stringify(bad));
  // 64 wallets fit the row's body limit with room
  assert.ok(Buffer.byteLength(JSON.stringify({ network: "testnet", wallets: max })) < RECORD_BODY_MAX);
  assert.equal(RECORD_BODY_MAX, HELPER_V1_PATHS.find((p) => p.path === "/v1/bind/record")!.limitBytes);
  assert.deepEqual(HELPER_V1_PATHS.find((p) => p.path === "/v1/bind/record"), { method: "POST", path: "/v1/bind/record", part: "delegate", limitBytes: 8192 });
});

// ---- the answer, from the trade store ----

const tx = (n: number) => ({ tx_hash: `T${n}`.padEnd(44, "x"), nonce: String(n), height: String(5000 + n), block_hash: `B${n}`.padEnd(44, "y"), signed_tx: Buffer.from(`signed-${n}-${"z".repeat(n)}`).toString("base64") });
function recordOf(w: string): TradeRecord {
  const base = { trade: "t", cost: "1", deposit: "0", token_in: USDC, amount_in: "1000000" };
  return {
    w,
    creation: { ...tx(1), amount: "1820000000000000000000", state: "landed" },
    adopted: false,
    token: "wrap.testnet",
    carried: [
      { ...tx(2), ...base, sha256: "s2", side: "buy", method: "storage_deposit", state: "landed" },
      { ...tx(3), ...base, sha256: "s3", side: "buy", method: "ft_transfer_call", state: "failed", refunded: true },
      { ...tx(4), ...base, sha256: "s4", side: "buy", method: "ft_transfer_call", state: "landed" },
      { ...tx(5), ...base, sha256: "s5", side: "sell", method: "ft_transfer_call", state: "pending", refunded: false },
    ],
  };
}
const empty = (wallet: string) => ({ wallet, token: null, calls: [], created: null });

function storeWith(...recs: TradeRecord[]) {
  const dir = mkdtempSync(join(tmpdir(), "record-store-"));
  const s = createTradeStore(dir);
  for (const r of recs) s.create(r);
  return { s, dir };
}

test("a paid W with a record answers its token, its creation (hash, height, state) and every carried call in the record's order, each signed_tx byte-equal to the store; refunded only when true", async () => {
  const { s, dir } = storeWith(recordOf(W1));
  const c = chain([row(0, W1, "paid")]);
  const a = await readRecords([W1], { reads: readsOn(c.rpcs), store: s });
  assert.equal(a.status, 200);
  const stored = JSON.parse(readFileSync(join(dir, `t-${W1}.json`), "utf8")) as TradeRecord;
  const body = a.body as HelperBindRecordAnswer;
  assert.deepEqual(body, {
    records: [
      {
        wallet: W1,
        token: "wrap.testnet",
        created: { tx_hash: stored.creation!.tx_hash, height: "5001", state: "landed" },
        calls: stored.carried.map((x) => ({ tx_hash: x.tx_hash, signed_tx: x.signed_tx, method: x.method, side: x.side, state: x.state, ...(x.refunded === true && { refunded: true }) })),
      },
    ],
  });
  assert.deepEqual(body.records[0]!.calls.map((x) => Buffer.from(x.signed_tx, "base64")), stored.carried.map((x) => Buffer.from(x.signed_tx, "base64")));
  assert.equal(body.records[0]!.calls[1]!.refunded, true);
  assert.ok(!("refunded" in body.records[0]!.calls[3]!), "refunded false is left out");
  // nothing in the answer the wire does not name (no nonce, block hash, cost, sha256, trade id)
  assert.deepEqual(Object.keys(body.records[0]!.calls[0]!), ["tx_hash", "signed_tx", "method", "side", "state"]);
  s.close();
});

test("an unpaid W with a record, and a W with no record, answer the same empty shape, in the asked order beside a paid one; a paid W with no record is empty too", async () => {
  const { s } = storeWith(recordOf(W1), recordOf(W2));
  const c = chain([row(0, W1, "paid"), row(1, W2, "refund_pending")]);
  const a = await readRecords([W2, W3, W1], { reads: readsOn(c.rpcs), store: s });
  const body = a.body as HelperBindRecordAnswer;
  assert.equal(a.status, 200);
  assert.deepEqual(body.records[0], empty(W2));
  assert.deepEqual(body.records[1], empty(W3));
  assert.equal(body.records[2]!.wallet, W1);
  assert.equal(body.records[2]!.token, "wrap.testnet");
  const paidNone = await readRecords([W3], { reads: { payoutsLanded: async () => [true] }, store: s });
  assert.deepEqual(paidNone, { status: 200, body: { records: [empty(W3)] } });
  // a record whose creation is not claimed yet, taken as it was: created null
  const { s: s2 } = storeWith({ w: W3, creation: null, adopted: true, token: null, carried: [] });
  assert.deepEqual(await readRecords([W3], { reads: { payoutsLanded: async () => [true] }, store: s2 }), { status: 200, body: { records: [empty(W3)] } });
  s.close();
  s2.close();
});

test("a spends read that fails answers 503 upstream and nothing is kept: the next call reads again and answers", async () => {
  const { s } = storeWith(recordOf(W1));
  let down = true;
  const c = chain([row(0, W1, "paid")], { fail: () => down });
  const reads = readsOn(c.rpcs);
  assert.deepEqual(await readRecords([W1], { reads, store: s }), { status: 503, body: { error: { code: "upstream" } } });
  down = false;
  const a = await readRecords([W1], { reads, store: s });
  assert.equal(a.status, 200);
  assert.equal((a.body as HelperBindRecordAnswer).records[0]!.token, "wrap.testnet");
  // a store read that throws is upstream too
  assert.deepEqual(await readRecords([W1], { reads, store: { get: () => { throw new Error("EIO"); } } }), { status: 503, body: { error: { code: "upstream" } } });
  s.close();
});

test("the read never writes the store and never waits on a carry: W's carry slot held, the record still answers, the file untouched", async () => {
  const { s, dir } = storeWith(recordOf(W1));
  const file = join(dir, `t-${W1}.json`);
  const before = [readFileSync(file, "utf8"), statSync(file).mtimeMs];
  const store = { get: s.get, create: () => assert.fail("no create"), put: () => assert.fail("no put") } as unknown as RecordDeps["store"];
  accountSlots.add(W1);
  try {
    const a = await readRecords([W1], { reads: { payoutsLanded: async () => [true] }, store });
    assert.equal(a.status, 200);
  } finally {
    accountSlots.delete(W1);
  }
  assert.deepEqual([readFileSync(file, "utf8"), statSync(file).mtimeMs], before);
  s.close();
});

// ---- the route ----

function call(port: number, method: string, path: string, body?: string, xff = "203.0.113.7") {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", origin: "https://ct-app.unrealized.trade", "x-forwarded-for": xff } }, (res) => {
      let b = "";
      res.setEncoding("utf8").on("data", (d) => (b += d)).on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", fail).end(body);
  });
}

async function route(t: { after(fn: () => unknown): void }, record: BindSender["record"]) {
  let clock = NOW;
  const bind: BindSender = { carry: async () => ({ status: 200, body: { tx_hash: "4YsDRNYepeb4u16677E9WYB5DSF69EwnUuG6XLAV7eBL" } }), warm: () => undefined, stop: () => undefined, record };
  const h = createServer(handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, bind, null, new Map(), new Map(), () => (clock += 3)));
  await new Promise<void>((ok) => h.listen(0, "127.0.0.1", () => ok()));
  t.after(() => new Promise<void>((ok) => (h.closeAllConnections(), h.close(() => ok()))));
  return { port: (h.address() as AddressInfo).port, jump: (ms: number) => (clock += ms) };
}
const body = (wallets: string[]) => JSON.stringify({ network: "testnet", wallets });
const many = (n: number, at = 0) => Array.from({ length: n }, (_, i) => (at + i).toString(16).padStart(64, "0"));

test("POST /v1/bind/record: the body handed to the sender, its answer as is; not JSON 400 bad_shape; over its limit 413 too_large; GET 405; mounted (never 404) on the delegate part", async (t) => {
  const seen: unknown[] = [];
  const r = await route(t, async (b) => (seen.push(b), { status: 200, body: { records: [empty(W1)] } }));
  const ok = await call(r.port, "POST", "/v1/bind/record", body([W1]));
  assert.deepEqual([ok.status, JSON.parse(ok.body)], [200, { records: [empty(W1)] }]);
  assert.equal(ok.headers["access-control-allow-origin"], "https://ct-app.unrealized.trade");
  assert.deepEqual(seen, [{ network: "testnet", wallets: [W1] }]);
  const n = await call(r.port, "POST", "/v1/bind/record", "{not json");
  assert.deepEqual([n.status, JSON.parse(n.body)], [400, { error: { code: "bad_shape" } }]);
  const big = await call(r.port, "POST", "/v1/bind/record", JSON.stringify({ network: "testnet", wallets: [W1], pad: "x".repeat(RECORD_BODY_MAX) }));
  assert.deepEqual([big.status, JSON.parse(big.body)], [413, { error: { code: "too_large" } }]);
  const g = await call(r.port, "GET", "/v1/bind/record");
  assert.deepEqual([g.status, g.headers["allow"]], [405, "POST, OPTIONS"]);
  const health = JSON.parse((await call(r.port, "GET", "/v1/health")).body) as { parts: Record<string, string> };
  assert.equal(health.parts.delegate, "up");
});

test("POST /v1/bind/record with no record sender (no network carried) is 400 bad_shape, as a trade on a network not carried", async (t) => {
  const r = await route(t, undefined);
  const a = await call(r.port, "POST", "/v1/bind/record", body([W1]));
  assert.deepEqual([a.status, JSON.parse(a.body)], [400, { error: { code: "bad_shape" } }]);
});

test("the route's own budget: 100 wallets in two calls back to back pass; past RECORD_RATE_MAX one client meets 429 with a readable wait, while /v1/bind still goes for it; a second client goes; past RECORD_TOTAL_MAX every client waits; /v1/bind's window does not touch it", async (t) => {
  assert.ok(RECORD_RATE_MAX >= 2 && RECORD_TOTAL_MAX > RECORD_RATE_MAX);
  const r = await route(t, async (b) => ({ status: 200, body: { records: (b as { wallets: string[] }).wallets.map(empty) } }));
  const A = "203.0.113.7";
  // a restore of 100 wallets: 64, then 36, back to back
  const first = await call(r.port, "POST", "/v1/bind/record", body(many(64)), A);
  const second = await call(r.port, "POST", "/v1/bind/record", body(many(36, 64)), A);
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.equal((JSON.parse(first.body) as HelperBindRecordAnswer).records.length + (JSON.parse(second.body) as HelperBindRecordAnswer).records.length, 100);
  for (let i = 2; i < RECORD_RATE_MAX; i++) assert.equal((await call(r.port, "POST", "/v1/bind/record", body([W1]), A)).status, 200);
  const over = await call(r.port, "POST", "/v1/bind/record", body([W1]), A);
  assert.equal(over.status, 429);
  assert.deepEqual(JSON.parse(over.body), { error: { code: "rate_limited" } });
  assert.ok(Number(over.headers["retry-after"]) >= 1);
  assert.ok(String(over.headers["access-control-expose-headers"]).includes("Retry-After"));
  assert.equal((await call(r.port, "POST", "/v1/bind", JSON.stringify({ signed_delegate: "AAAA" }), A)).status, 200, "/v1/bind is not starved by the record route");
  // the total, across clients
  let served = RECORD_RATE_MAX;
  for (let c = 0; served < RECORD_TOTAL_MAX; c++) {
    const ip = `198.51.100.${c + 1}`;
    for (let i = 0; i < RECORD_RATE_MAX && served < RECORD_TOTAL_MAX; i++, served++) assert.equal((await call(r.port, "POST", "/v1/bind/record", body([W1]), ip)).status, 200, `client ${ip} call ${i}`);
  }
  const fresh = await call(r.port, "POST", "/v1/bind/record", body([W1]), "192.0.2.200");
  assert.equal(fresh.status, 429, "a new client past the route's total");
  r.jump(10_000);
  assert.equal((await call(r.port, "POST", "/v1/bind/record", body([W1]), A)).status, 200, "the next window");
  // /v1/bind's window (API_RATE_MAX) spent by one client leaves its record calls their own budget
  const B = "192.0.2.201";
  for (let i = 0; i <= API_RATE_MAX; i++) await call(r.port, "POST", "/v1/bind", JSON.stringify({ signed_delegate: "AAAA" }), B);
  assert.equal((await call(r.port, "POST", "/v1/bind", JSON.stringify({ signed_delegate: "AAAA" }), B)).status, 429);
  assert.equal((await call(r.port, "POST", "/v1/bind/record", body([W1]), B)).status, 200, "the record route is not starved by /v1/bind");
});

test("logs: the route writes no line, and none of its refusals names W or the client", async (t) => {
  const out: string[] = [];
  const mocks = (["log", "error", "warn", "info", "debug"] as const).map((m) => mock.method(console, m, (...a: unknown[]) => void out.push(a.map(String).join(" "))));
  try {
    const { s } = storeWith(recordOf(W1));
    const c = chain([row(0, W1, "paid")]);
    const reads = readsOn(c.rpcs);
    const r = await route(t, async (b) => {
      const p = parseRecordBody(b);
      return p === null ? { status: 400, body: { error: { code: "bad_shape" } } } : readRecords(p.wallets, { reads, store: s });
    });
    const IP = "203.0.113.99";
    for (let i = 0; i <= RECORD_RATE_MAX; i++) await call(r.port, "POST", "/v1/bind/record", body([W1]), IP);
    await call(r.port, "POST", "/v1/bind/record", JSON.stringify({ network: "testnet", wallets: [W1.toUpperCase()] }), "203.0.113.98");
    s.close();
  } finally {
    for (const m of mocks) m.mock.restore();
  }
  assert.deepEqual(out.filter((l) => l.includes(W1) || l.includes(W1.toUpperCase()) || l.includes("203.0.113.9")), []);
});

test("the host's bind sender: a record body on a network it does not carry is 400 bad_shape, with nothing read", async () => {
  const { bindSenderFromEnv } = await import("./env.ts");
  const b = bindSenderFromEnv({}, {}, async () => assert.fail("nothing fetched"));
  assert.deepEqual(await b.record!({ network: "testnet", wallets: [W1] }), { status: 400, body: { error: { code: "bad_shape" } } });
  assert.deepEqual(await b.record!({ network: "testnet", wallets: [W1], x: 1 }), { status: 400, body: { error: { code: "bad_shape" } } });
});
