// node --test scripts/live-checks/helper-evm-sender.test.mjs: the live check replays recorded runs
// (helper-evm-sender.answers.json). good: apps/helper with both EVM testnet pools set: PASS. bad_deployed: HELPER_HOST
// before its redeploy, which carries no EVM pool (404): FAIL. Made from the good run: a sender other than the kit's pin,
// a field missing or added, a plant sent (200 with a hash), a plant refused with another code, an answer with no full-sha
// X-Helper-Commit, a pool or a plant not read: each FAIL.
// The plants are checked against the helper's own sell checks (apps/helper/src/pool/evm.ts), so the check plants what
// the route reads, and each differs from a sell that passes every static check in its one field.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evmPoolSender, evmReadSell } from "../../apps/helper/src/pool/evm.ts";
import { evmPoolSignSellAuthorization, evmPoolVenues } from "../../packages/kit/src/index.ts";
import { evmPoolRecords, FIELDS, judge, NETWORKS, PLANTS, plantsOf, randomKey, read } from "./helper-evm-sender.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-evm-sender.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
/** The good run with `f` applied to every read named `asked` (on `network`, or on every pool). */
const edit = (run, asked, f, network) => ({ ...run, pools: run.pools.map((p) => (network && p.network !== network ? p : { ...p, reads: p.reads.map((x) => (x.asked === asked ? f(x) : x)) })) });
const body = (x, f) => ({ ...x, body: JSON.stringify(f(JSON.parse(x.body))) });
const OTHER = "0x000000000000000000000000000000000000beef";

test("recorded good run: both testnet pools' fee answers name a sender, every plant refused with its own code: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(A.good.pools.map((p) => p.network), Object.keys(evmPoolRecords()), "a pool for each deploy record");
});

test("recorded bad run: HELPER_HOST with no EVM pool (404 on the fee and on every plant): FAIL", () => {
  const r = judge(A.bad_deployed);
  assert.equal(r.ok, false);
  assert.ok(bad(r).includes("BAD [base-sepolia fee] GET /v1/pool/fee answers 404"), bad(r).join("\n"));
});

test("the sender: where the kit pins one, the fee answer's sender must be it", () => {
  const g = A.good;
  const sender = JSON.parse(g.pools[0].reads.find((x) => x.asked === "fee").body).sender;
  const venues = evmPoolVenues();
  const pinned = (pin) => ({ ...venues, [g.pools[0].network]: { ...venues[g.pools[0].network], sellSender: pin } });
  assert.equal(judge(g, { venues: pinned(sender) }).ok, true, "the pin is the sender");
  assert.equal(judge(g, { venues: pinned(sender.toUpperCase().replace("0X", "0x")) }).ok, true, "a pin in another case is the same address");
  const other = judge(g, { venues: pinned(OTHER) });
  assert.equal(other.ok, false);
  assert.ok(bad(other).some((l) => l.includes(`the kit's pin ${OTHER}`)), bad(other).join("\n"));
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, sender: "0x1234" })))).ok, false, "a sender that is no address");
});

test("the fee answer: a field missing or added, another chain, network or pool, an off-grid epoch: each FAIL", () => {
  const g = A.good;
  for (const k of FIELDS) {
    assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => {
      const { [k]: _, ...rest } = b;
      return rest;
    }))).ok, false, `${k} missing`);
  }
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, extra: 1 })))).ok, false, "a field added");
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, chain: "solana" })))).ok, false);
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, network: "base" })))).ok, false);
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, pool: OTHER })))).ok, false);
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, epoch_start_ms: b.epoch_start_ms + 1 })))).ok, false);
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee: "-1" })))).ok, false);
  assert.equal(judge(edit(g, "fee", (x) => ({ ...x, status: 503 }))).ok, false);
});

test("a plant sent (200 with a hash) or refused with another code: each FAIL, on each pool", () => {
  const g = A.good;
  for (const { network } of g.pools) {
    for (const [asked, , code] of PLANTS) {
      const sent = judge(edit(g, asked, (x) => ({ ...x, status: 200, body: `{"hash":"0x${"11".repeat(32)}"}` }), network));
      assert.equal(sent.ok, false, `${network} ${asked} sent`);
      assert.ok(bad(sent).some((l) => l.startsWith(`BAD [${network} ${asked}]`)), bad(sent).join("\n"));
      const other = code === "simulation_failed" ? "auth_nonce" : "simulation_failed";
      assert.equal(judge(edit(g, asked, (x) => ({ ...x, body: `{"error":{"code":"${other}"}}` }), network)).ok, false, `${network} ${asked} as ${other}`);
      assert.equal(judge(edit(g, asked, (x) => ({ ...x, status: x.status === 400 ? 422 : 400 }), network)).ok, false, `${network} ${asked} at another status`);
      assert.equal(judge({ ...g, pools: g.pools.map((p) => (p.network === network ? { ...p, reads: p.reads.filter((x) => x.asked !== asked) } : p)) }).ok, false, `${network} ${asked} not read`);
    }
  }
});

test("X-Helper-Commit missing or short on any answer, or a pool not read: FAIL", () => {
  const g = A.good;
  for (const asked of ["fee", ...PLANTS.map(([a]) => a)]) {
    const none = judge(edit(g, asked, (x) => ({ ...x, headers: Object.fromEntries(Object.entries(x.headers).filter(([k]) => k !== "x-helper-commit")) })));
    assert.equal(none.ok, false, `${asked}: no commit`);
    assert.ok(bad(none).some((l) => l.includes(`${asked}] X-Helper-Commit: none`)), bad(none).join("\n"));
    assert.equal(judge(edit(g, asked, (x) => ({ ...x, headers: { ...x.headers, "x-helper-commit": x.headers["x-helper-commit"].slice(0, 7) } }))).ok, false, `${asked}: a short commit`);
  }
  for (const n of NETWORKS) if (g.pools.some((p) => p.network === n)) assert.equal(judge({ ...g, pools: g.pools.filter((p) => p.network !== n) }).ok, false, `${n} not read`);
  assert.equal(judge({ ...g, pools: [] }).ok, false, "no pool read");
  assert.equal(judge({ ...g, pools: g.pools.map((p) => ({ ...p, pool: OTHER })) }).ok, false, "another pool than the record's");
});

// ---- The plants against the helper's own checks ----

const NOW = 1_800_000_000_000;
/** A provider that records each call and answers none: a body that reaches it passed every static check. */
const recording = (calls) => async (method, params) => {
  calls.push({ method, params });
  throw new Error("HTTP 502");
};
const codeOf = (a) => a.body?.error?.code ?? "sent";

test("plantsOf() builds what the helper's sell checks read: each plant its own status and code with no RPC call; the sell it is made from reaches the RPC reads", async () => {
  const records = evmPoolRecords();
  assert.deepEqual(Object.keys(records), ["base-sepolia", "robinhood-testnet"]);
  for (const [network, pool] of Object.entries(records)) {
    const p = plantsOf({ network, pool, nowMs: NOW });
    const sender = (calls) => evmPoolSender({ network, pool, senderKey: randomKey(), floor: 10n ** 13n }, [recording(calls), recording(calls)], () => NOW);
    {
      const calls = [];
      const a = await sender(calls).sell(p.base);
      assert.ok(calls.length > 0, `${network}: the base sell passes every static check (${JSON.stringify(a.body)})`);
      assert.equal(codeOf(a), "upstream", `${network}: it stops at the first read, which fails here`);
    }
    assert.deepEqual(Object.keys(p.plants), PLANTS.map(([a]) => a));
    for (const [asked, status, code] of PLANTS) {
      const calls = [];
      const a = await sender(calls).sell(p.plants[asked]);
      assert.deepEqual([a.status, codeOf(a)], [status, code], `${network} ${asked}: ${JSON.stringify(a.body)}`);
      assert.equal(calls.length, 0, `${network} ${asked}: refused before any RPC call`);
    }
  }
});

test("each plant differs from the base sell in its one field (and the signature that field's change makes)", () => {
  const read2 = (b) => {
    const s = evmReadSell(new Uint8Array(Buffer.from(b.data.slice(2), "hex")));
    const { yParity, r, s: as, ...auth } = b.authorization;
    return { pool: b.pool, w: b.w, ...Object.fromEntries(Object.entries(s).map(([k, v]) => [`sell.${k}`, v instanceof Uint8Array ? Buffer.from(v).toString("hex") : String(v)])), ...Object.fromEntries(Object.entries(auth).map(([k, v]) => [`auth.${k}`, v])), "auth.sig": `${yParity}${r}${as}` };
  };
  const WANT = {
    auth_chain_zero: ["auth.chainId", "auth.sig"],
    auth_other_delegate: ["auth.address", "auth.sig"],
    sell_other_signer: ["sell.signature"],
    deadline_in_ms: ["sell.deadline", "sell.signature"],
    deadline_near: ["sell.deadline", "sell.signature"],
    sell_other_pool: ["sell.pool", "sell.signature"],
    fee_over_cap: ["sell.fee"],
  };
  for (const [network, pool] of Object.entries(evmPoolRecords())) {
    const p = plantsOf({ network, pool, nowMs: NOW });
    const base = read2(p.base);
    const v = evmPoolVenues()[network];
    // the base's authorization is the kit's own, of the chain's pinned delegate
    const kit = evmPoolSignSellAuthorization(p.wKey, network, BigInt(p.base.authorization.nonce));
    assert.deepEqual(p.base.authorization, { chainId: `0x${kit.chainId.toString(16)}`, address: kit.address, nonce: `0x${kit.nonce.toString(16)}`, yParity: `0x${kit.yParity.toString(16)}`, r: kit.r, s: kit.s });
    assert.equal(p.base.authorization.address, v.sellDelegate);
    assert.equal(base["sell.pool"], pool);
    assert.equal(base["sell.target"], v.poolManager);
    for (const [asked, fields] of Object.entries(WANT)) {
      const got = read2(p.plants[asked]);
      assert.deepEqual(Object.keys(base).filter((k) => base[k] !== got[k]), fields, `${network} ${asked}`);
    }
    assert.equal(read2(p.plants.deadline_near)["sell.deadline"], String(BigInt(NOW / 1000) + 59n));
    assert.equal(read2(p.plants.deadline_in_ms)["sell.deadline"], String(BigInt(NOW) + 300_000n));
    assert.equal(read2(p.plants.auth_chain_zero)["auth.chainId"], "0x0");
    assert.equal(BigInt(read2(p.plants.fee_over_cap)["sell.fee"]), BigInt(base["sell.feeCap"]) + 1n);
    assert.deepEqual({ ...p.plants.trailing_byte, data: p.plants.trailing_byte.data.slice(0, -2) }, p.base, "trailing_byte: the base and one byte");
    assert.equal(p.plants.trailing_byte.data.slice(-2), "00");
    // W's authorization nonce is one no fresh W holds, so a helper that skipped a static check stops at auth_nonce
    assert.ok(BigInt(p.base.authorization.nonce) > 0n && BigInt(p.base.authorization.nonce) < 2n ** 64n - 1n);
  }
  // a fresh W key each build
  const [a, b] = [plantsOf({ network: "base-sepolia", pool: evmPoolRecords()["base-sepolia"], nowMs: NOW }), plantsOf({ network: "base-sepolia", pool: evmPoolRecords()["base-sepolia"], nowMs: NOW })];
  assert.notEqual(a.base.w, b.base.w);
});

test("read() asks each record's pool for its fee, then posts every plant to the sell route (replayed helper)", async () => {
  const asked = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    asked.push(`${init.method ?? "GET"} ${u.pathname}${u.search}`);
    const pool = u.searchParams.get("pool") ?? JSON.parse(init.body).pool;
    const p = A.good.pools.find((x) => x.pool === pool);
    const r = u.pathname === "/v1/pool/fee" ? p.reads[0] : p.reads.find((x) => x.asked === "fee_over_cap");
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  const run = await read("http://h.invalid", fetchFn);
  const records = evmPoolRecords();
  assert.deepEqual(asked, Object.values(records).flatMap((pool) => [`GET /v1/pool/fee?pool=${pool}`, ...PLANTS.map(() => "POST /v1/pool/evm/sell")]));
  assert.deepEqual(run.pools.map((p) => [p.network, p.pool, p.reads.map((x) => x.asked)]), Object.entries(records).map(([n, pool]) => [n, pool, ["fee", ...PLANTS.map(([a]) => a)]]));
});
