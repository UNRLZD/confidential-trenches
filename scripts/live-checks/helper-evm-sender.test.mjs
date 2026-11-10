// node --test scripts/live-checks/helper-evm-sender.test.mjs: the live check replays recorded runs
// (helper-evm-sender.answers.json). good: apps/helper with both EVM testnet pools set: PASS. bad_deployed: HELPER_HOST
// before its redeploy, which carries no EVM pool (404): FAIL. Made from the good run: a
// sell_sender other than the kit's pin, or null where the kit pins one, a field missing or added, a plant sent (200 with a hash), a plant refused with another code, an answer with no full-sha
// X-Helper-Commit, a pool or a plant not read: each FAIL.
// The plants are checked against the helper's own sell checks (apps/helper/src/pool/evm.ts), so the check plants what
// the route reads, and each differs from a sell that passes every static check in its one field. The sells the helper
// sent (checkSells) are checked on the recorded testnet runs of pool-evm-testnet-run: read back as if the helper had
// sent them, they pass every check but the gas limit, which the run's own sender estimated.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evmPoolSender, evmReadSell } from "../../apps/helper/src/pool/evm.ts";
import { evmPoolSignSellAuthorization, evmPoolVenues } from "../../packages/kit/src/index.ts";
import { checkSells, evmPoolRecords as currentRecords, FIELDS, FIRST_SET, judge as judgeLive, NETWORKS, PLANTS, plantsOf, randomKey, read as readLive, SELL_GAS, SENDER_FIELD, sendersOf } from "./helper-evm-sender.mjs";
import { replayer } from "./notes-per-pool-evm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-evm-sender.answers.json"), "utf8"));
// The recordings were made 6 Nov on the testnets' first pool set (FIRST_SET), before card pool-evm-buy-pays-revert's
// pools: a replay judges each on the pools it was recorded on; the live check reads the current set (evmPoolRecords()).
const evmPoolRecords = () => currentRecords(undefined, FIRST_SET);
const judge = (run, o = {}) => judgeLive(run, { records: evmPoolRecords(), ...o });
const read = (base, fetchFn) => readLive(base, fetchFn, evmPoolRecords());
test("the recordings name the first set's pools; the live check reads the current set's, each network's newest pool", () => {
  assert.deepEqual(Object.fromEntries(A.good.pools.map((p) => [p.network, p.pool])), evmPoolRecords());
  assert.deepEqual(Object.keys(currentRecords()), Object.keys(evmPoolRecords()));
  for (const n of NETWORKS) assert.equal(currentRecords()[n], JSON.parse(readFileSync(path.join(HERE, `pool-evm-buy-pays-revert.${n}.json`), "utf8")).contracts.PrivacyPoolSimple.address, n);
});
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
/** The good run with `f` applied to every read named `asked` (on `network`, or on every pool). */
const edit = (run, asked, f, network) => ({ ...run, pools: run.pools.map((p) => (network && p.network !== network ? p : { ...p, reads: p.reads.map((x) => (x.asked === asked ? f(x) : x)) })) });
const body = (x, f) => ({ ...x, body: JSON.stringify(f(JSON.parse(x.body))) });
const OTHER = "0x000000000000000000000000000000000000beef";
/** The kit's list with each testnet's sell sender pin set to `pins[network]` (null: no pin). The recorded good run is a
 *  local helper with throwaway sell keys (the answers' notes), so it is judged against its own senders as the pins; the
 *  kit's real pins are the helper box's keys, which only the deployed helper holds. */
const venuesWith = (pins) => {
  const v = evmPoolVenues();
  const out = { ...v };
  for (const [n, pin] of Object.entries(pins)) {
    const { sellSender: _, ...rest } = v[n];
    out[n] = pin === null ? rest : { ...rest, sellSender: pin };
  }
  return out;
};
const LOCAL = () => venuesWith(sendersOf(A.good));
/** judge with the recording's own senders as the pins, so each case below fails for its one change alone */
const judgeL = (run) => judge(run, { venues: LOCAL() });

test("recorded good run: both testnet pools' fee answers name a sell sender, every plant refused with its own code: PASS", () => {
  const r = judge(A.good, { venues: LOCAL() });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(A.good.pools.map((p) => p.network), Object.keys(evmPoolRecords()), "a pool for each deploy record");
  // against the kit's own pins (the helper box's sell keys), the local helper's throwaway senders fail each testnet
  const kit = judge(A.good);
  assert.equal(kit.ok, false);
  for (const n of NETWORKS) assert.ok(bad(kit).some((l) => l.startsWith(`BAD [${n} fee] sell_sender`) && l.includes(`the kit's pin ${evmPoolVenues()[n].sellSender}`)), bad(kit).join("\n"));
});

test("recorded bad run: HELPER_HOST with no EVM pool (404 on the fee and on every plant): FAIL", () => {
  const r = judge(A.bad_deployed);
  assert.equal(r.ok, false);
  assert.ok(bad(r).includes("BAD [base-sepolia fee] GET /v1/pool/fee answers 404"), bad(r).join("\n"));
});

test("the sell sender: where the kit pins one, the fee answer's sell_sender must be it; null only where none is pinned", () => {
  const g = A.good;
  assert.equal(SENDER_FIELD, "sell_sender");
  const sender = JSON.parse(g.pools[0].reads.find((x) => x.asked === "fee").body)[SENDER_FIELD];
  assert.match(sender, /^0x[0-9a-f]{40}$/);
  const venues = LOCAL();
  const pinned = (pin) => ({ ...venues, [g.pools[0].network]: { ...venues[g.pools[0].network], sellSender: pin } });
  assert.equal(evmPoolVenues()["base-sepolia"].sellSender, "0xd378cda68babba6a9dc1d52335bb76ca9e6a7553");
  assert.equal(evmPoolVenues()["robinhood-testnet"].sellSender, "0xd12d83097671d731df2db731e973ad9a07673607");
  assert.equal(judge(g, { venues: pinned(sender) }).ok, true, "the pin is the sender");
  assert.equal(judge(g, { venues: pinned(sender.toUpperCase().replace("0X", "0x")) }).ok, true, "a pin in another case is the same address");
  const other = judge(g, { venues: pinned(OTHER) });
  assert.equal(other.ok, false);
  assert.ok(bad(other).some((l) => l.includes(`the kit's pin ${OTHER}`)), bad(other).join("\n"));
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, [SENDER_FIELD]: "0x1234" }))), { venues: venuesWith({ "base-sepolia": null, "robinhood-testnet": null }) }).ok, false, "a sell sender that is no address");
  const none = edit(g, "fee", (x) => body(x, (b) => ({ ...b, [SENDER_FIELD]: null })), g.pools[0].network);
  assert.equal(judge(none, { venues: venuesWith({ ...sendersOf(g), [g.pools[0].network]: null }) }).ok, true, "no sell key and no pin: null");
  assert.equal(judge(none).ok, false, "no sell key where the kit pins one (its own list)");
  assert.equal(judge(none, { venues: pinned(sender) }).ok, false, "no sell key where the kit pins one");
  assert.deepEqual(sendersOf(none), { ...sendersOf(g), [g.pools[0].network]: null });
  assert.equal(sendersOf(g)[g.pools[0].network], sender);
});

test("the fee answer: a field missing or added, another chain, network or pool, an off-grid epoch: each FAIL", () => {
  const g = A.good;
  for (const k of FIELDS) {
    assert.equal(judgeL(edit(g, "fee", (x) => body(x, (b) => {
      const { [k]: _, ...rest } = b;
      return rest;
    }))).ok, false, `${k} missing`);
  }
  assert.equal(judgeL(edit(g, "fee", (x) => body(x, (b) => ({ ...b, extra: 1 })))).ok, false, "a field added");
  // the fee collector (card helper-sender-fee-proof): none set, the pool's address, or the sell sender's: each FAIL
  assert.equal(judgeL(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee_collector: null })))).ok, false, "no fee collector");
  assert.equal(judgeL(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee_collector: b.pool })))).ok, false, "the collector is the pool");
  assert.equal(judgeL(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee_collector: b.sell_sender })))).ok, false, "the collector is the sell sender");
  assert.equal(judgeL(edit(g, "fee", (x) => body(x, (b) => ({ ...b, chain: "solana" })))).ok, false);
  assert.equal(judgeL(edit(g, "fee", (x) => body(x, (b) => ({ ...b, network: "base" })))).ok, false);
  assert.equal(judgeL(edit(g, "fee", (x) => body(x, (b) => ({ ...b, pool: OTHER })))).ok, false);
  assert.equal(judgeL(edit(g, "fee", (x) => body(x, (b) => ({ ...b, epoch_start_ms: b.epoch_start_ms + 1 })))).ok, false);
  assert.equal(judgeL(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee: "-1" })))).ok, false);
  assert.equal(judgeL(edit(g, "fee", (x) => ({ ...x, status: 503 }))).ok, false);
});

test("a plant sent (200 with a hash) or refused with another code: each FAIL, on each pool", () => {
  const g = A.good;
  for (const { network } of g.pools) {
    for (const [asked, , code] of PLANTS) {
      const sent = judgeL(edit(g, asked, (x) => ({ ...x, status: 200, body: `{"hash":"0x${"11".repeat(32)}"}` }), network));
      assert.equal(sent.ok, false, `${network} ${asked} sent`);
      assert.ok(bad(sent).some((l) => l.startsWith(`BAD [${network} ${asked}]`)), bad(sent).join("\n"));
      const other = code === "simulation_failed" ? "auth_nonce" : "simulation_failed";
      assert.equal(judgeL(edit(g, asked, (x) => ({ ...x, body: `{"error":{"code":"${other}"}}` }), network)).ok, false, `${network} ${asked} as ${other}`);
      assert.equal(judgeL(edit(g, asked, (x) => ({ ...x, status: x.status === 400 ? 422 : 400 }), network)).ok, false, `${network} ${asked} at another status`);
      assert.equal(judgeL({ ...g, pools: g.pools.map((p) => (p.network === network ? { ...p, reads: p.reads.filter((x) => x.asked !== asked) } : p)) }).ok, false, `${network} ${asked} not read`);
    }
  }
});

test("X-Helper-Commit missing or short on any answer, or a pool not read: FAIL", () => {
  const g = A.good;
  for (const asked of ["fee", ...PLANTS.map(([a]) => a)]) {
    const none = judgeL(edit(g, asked, (x) => ({ ...x, headers: Object.fromEntries(Object.entries(x.headers).filter(([k]) => k !== "x-helper-commit")) })));
    assert.equal(none.ok, false, `${asked}: no commit`);
    assert.ok(bad(none).some((l) => l.includes(`${asked}] X-Helper-Commit: none`)), bad(none).join("\n"));
    assert.equal(judgeL(edit(g, asked, (x) => ({ ...x, headers: { ...x.headers, "x-helper-commit": x.headers["x-helper-commit"].slice(0, 7) } }))).ok, false, `${asked}: a short commit`);
  }
  for (const n of NETWORKS) if (g.pools.some((p) => p.network === n)) assert.equal(judgeL({ ...g, pools: g.pools.filter((p) => p.network !== n) }).ok, false, `${n} not read`);
  assert.equal(judgeL({ ...g, pools: [] }).ok, false, "no pool read");
  assert.equal(judgeL({ ...g, pools: g.pools.map((p) => ({ ...p, pool: OTHER })) }).ok, false, "another pool than the record's");
});

// ---- The plants against the helper's own checks ----

const NOW = 1_800_000_000_000;
/** The release's fee recipient the helper's fee answer names, the one each plant pays (card helper-sell-fee-recipient) */
const FEE_TO = "0x000000000000000000000000000000000000fee1";
/** A provider that records each call and answers none: a body that reaches it passed every static check. */
const recording = (calls) => async (method, params) => {
  calls.push({ method, params });
  throw new Error("HTTP 502");
};
const codeOf = (a) => a.body?.error?.code ?? "sent";

// card helper-sender-fee-proof, review M1: the fee answer's collector is the kit's pin, not just an address
test("the fee answer's fee_collector off the kit's pin (a stand-in, the other testnet's) or where the kit pins none: FAIL", () => {
  const venues = LOCAL();
  for (const p of A.good.pools) {
    const other = A.good.pools.find((x) => x.network !== p.network).network;
    for (const coll of ["0x00000000000000000000000000000000c011ec70", venues[other].feeCollector]) {
      const run = { ...A.good, pools: A.good.pools.map((x) => (x.network !== p.network ? x : { ...x, reads: x.reads.map((r) => (r.asked === "fee" ? { ...r, body: JSON.stringify({ ...JSON.parse(r.body), fee_collector: coll }) } : r)) })) };
      const r = judgeL(run);
      assert.ok(!r.ok && r.lines.some((l) => l.startsWith(`BAD [${p.network} fee] fee collector`)), `${p.network} ${coll}`);
    }
    const none = { ...venues, [p.network]: Object.fromEntries(Object.entries(venues[p.network]).filter(([k]) => k !== "feeCollector")) };
    const r = judge(A.good, { venues: none });
    assert.ok(!r.ok && r.lines.some((l) => l.startsWith(`BAD [${p.network} fee] fee collector`) && l.includes("the kit pins none")), p.network);
  }
});

test("plantsOf() builds what the helper's sell checks read: each plant its own status and code with no RPC call; the sell it is made from reaches the RPC reads", async () => {
  const records = evmPoolRecords();
  assert.deepEqual(Object.keys(records), ["base-sepolia", "robinhood-testnet"]);
  for (const [network, pool] of Object.entries(records)) {
    const p = plantsOf({ network, pool, feeRecipient: FEE_TO, nowMs: NOW });
    // the plants pay FEE_TO, so it is the collector here; the release's fee recipient is the sender's own address, since
    // the collector is never the fee recipient (card helper-sender-fee-proof, review L2)
    const sender = (calls) => evmPoolSender({ network, pool, senderKey: randomKey(), sellKey: randomKey(), feeCollector: FEE_TO, floor: 10n ** 13n }, [recording(calls), recording(calls)], () => NOW);
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
    route_other_target: ["sell.target", "sell.signature"],
  };
  for (const [network, pool] of Object.entries(evmPoolRecords())) {
    const p = plantsOf({ network, pool, feeRecipient: FEE_TO, nowMs: NOW });
    const base = read2(p.base);
    assert.equal(base["sell.feeRecipient"], FEE_TO, "every plant pays the fee answer's fee collector");
    const v = evmPoolVenues()[network];
    // the base's authorization is the kit's own, of the chain's pinned delegate
    const kit = evmPoolSignSellAuthorization(p.wKey, network, BigInt(p.base.authorization.nonce));
    assert.deepEqual(p.base.authorization, { chainId: `0x${kit.chainId.toString(16)}`, address: kit.address, nonce: `0x${kit.nonce.toString(16)}`, yParity: `0x${kit.yParity.toString(16)}`, r: kit.r, s: kit.s });
    assert.equal(p.base.authorization.address, v.sellDelegate);
    assert.equal(base["sell.pool"], pool);
    assert.equal(base["sell.target"], v.poolManager);
    assert.equal(read2(p.plants.route_other_target)["sell.target"], "0x000000000000000000000000000000000000dead");
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
  const [a, b] = [plantsOf({ network: "base-sepolia", pool: evmPoolRecords()["base-sepolia"], feeRecipient: FEE_TO, nowMs: NOW }), plantsOf({ network: "base-sepolia", pool: evmPoolRecords()["base-sepolia"], feeRecipient: FEE_TO, nowMs: NOW })];
  assert.notEqual(a.base.w, b.base.w);
});

test("read() asks each record's pool for its fee, then posts every plant to the sell route, each paying the fee answer's fee recipient (replayed helper)", async () => {
  const asked = [];
  const paid = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    asked.push(`${init.method ?? "GET"} ${u.pathname}${u.search}`);
    const pool = u.searchParams.get("pool") ?? JSON.parse(init.body).pool;
    if (init.body) paid.push([pool, evmReadSell(new Uint8Array(Buffer.from(JSON.parse(init.body).data.slice(2, JSON.parse(init.body).data.length % 64 === 10 ? undefined : -2), "hex"))).feeRecipient]);
    const p = A.good.pools.find((x) => x.pool === pool);
    const r = u.pathname === "/v1/pool/fee" ? p.reads[0] : p.reads.find((x) => x.asked === "fee_over_cap");
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  const run = await read("http://h.invalid", fetchFn);
  const records = evmPoolRecords();
  assert.deepEqual(asked, Object.values(records).flatMap((pool) => [`GET /v1/pool/fee?pool=${pool}`, ...PLANTS.map(() => "POST /v1/pool/evm/sell")]));
  assert.deepEqual(run.pools.map((p) => [p.network, p.pool, p.reads.map((x) => x.asked)]), Object.entries(records).map(([n, pool]) => [n, pool, ["fee", ...PLANTS.map(([a]) => a)]]));
  const named = Object.fromEntries(A.good.pools.map((p) => [p.pool, JSON.parse(p.reads[0].body).fee_collector]));
  assert.equal(paid.length, Object.keys(records).length * PLANTS.length);
  for (const [pool, to] of paid) assert.equal(to, named[pool], `${pool}: the plant pays ${to}`);
});

// ---- The sells the helper sent ----

const RUN = JSON.parse(readFileSync(path.join(HERE, "pool-evm-testnet-run.answers.json"), "utf8"));
/** The recorded whole runs (pool-evm-testnet-run), each sell read as one the helper sent, with `f` applied to its log.
 *  A row as testnet-run.mjs writes it: every row listed has landed, so none carries a `landed` field. */
const helperRuns = (f = (log) => log) => RUN.runs.filter((r) => !r.record.stopped).map((r) => ({ record: { ...r.record, txs: r.record.txs.map((t) => (t.kind === "sell" ? { ...t, via: "helper" } : t)) }, urls: r.urls, log: f(structuredClone(r.good)) }));
const relayers = (runs) => Object.fromEntries(runs.map((r) => [r.record.chain, r.record.relayer]));
const replayOf = (x) => replayer(x.log);
/** the log with each sell's transaction read at the helper's gas limit */
const atSellGas = (runs) => (log) => {
  const sells = new Set(runs.flatMap((r) => r.record.txs.filter((t) => t.kind === "sell").map((t) => t.hash)));
  for (const e of log) if (e.method === "eth_getTransactionByHash" && sells.has(e.params[0]) && e.result) e.result.gas = `0x${SELL_GAS.toString(16)}`;
  return log;
};

test("checkSells on the recorded testnet runs: every check reads real sells; the run's own sender estimated its gas, so the 1,000,000 limit fails each", async () => {
  const runs = helperRuns();
  assert.deepEqual(runs.map((r) => r.record.chain).sort(), [...NETWORKS].sort());
  const r = await checkSells(runs, replayOf, relayers(runs));
  assert.equal(r.ok, false);
  const sells = runs.flatMap((x) => x.record.txs.filter((t) => t.kind === "sell"));
  assert.ok(sells.length >= 3);
  // and no testnet has a sell read back whole, so each one's own line fails too
  assert.deepEqual(bad(r).map((l) => l.replace(/ gas limit \d+,.*/, "")), [...sells.map((t) => `BAD [${runs.find((x) => x.record.txs.includes(t)).record.chain} sell ${t.hash}]`), ...NETWORKS.map((n) => `BAD [${n}] a sell the helper sent, read back (helper-evm-sender.run.${n}.json)`)], bad(r).join("\n"));
  for (const t of sells) {
    assert.ok(r.lines.some((l) => l.startsWith(`ok  [`) && l.includes(`${t.hash}] the authorization is signed by ${t.w}`)), `${t.hash}: W signed the authorization`);
    assert.ok(r.lines.some((l) => l.startsWith(`ok  [`) && l.includes(`${t.hash}] the fee ${t.fee} covers the cost`)), `${t.hash}: the fee covers the cost`);
  }
});

test("checkSells: the same reads at the helper's gas limit pass; another sender, a fee under the cost, a spoiled run, or a testnet with no helper sell: each FAIL", async () => {
  const runs = helperRuns();
  const at = helperRuns(atSellGas(runs));
  assert.ok(at.every((x) => x.record.txs.every((t) => !("landed" in t))), "the record's shape: no landed field");
  const good = await checkSells(at, replayOf, relayers(at));
  assert.equal(good.ok, true, good.lines.join("\n"));
  // another sell sender, or none named
  for (const n of NETWORKS) {
    assert.equal((await checkSells(at, replayOf, { ...relayers(at), [n]: "0x000000000000000000000000000000000000beef" })).ok, false, `${n}: another sender`);
    assert.equal((await checkSells(at, replayOf, { ...relayers(at), [n]: null })).ok, false, `${n}: no sell sender`);
  }
  // a fee word under the cost: the sell's input with fee 1 wei
  const cheap = helperRuns((log) => {
    atSellGas(runs)(log);
    for (const e of log) if (e.method === "eth_getTransactionByHash" && e.result?.input?.startsWith("0x") && runs.some((r) => r.record.txs.some((t) => t.kind === "sell" && t.hash === e.params[0]))) e.result.input = `${e.result.input.slice(0, 74)}${"0".repeat(63)}1${e.result.input.slice(138)}`;
    return log;
  });
  const c = await checkSells(cheap, replayOf, relayers(cheap));
  assert.equal(c.ok, false);
  assert.ok(bad(c).some((l) => l.includes("the fee 1 covers the cost")), bad(c).join("\n"));
  for (const n of NETWORKS) assert.ok(bad(c).includes(`BAD [${n}] a sell the helper sent, read back (helper-evm-sender.run.${n}.json)`), `${n}: a sell whose reads fail is not read back`);
  // a sell's receipt reverted on one RPC
  const reverted = helperRuns((log) => {
    atSellGas(runs)(log);
    const h = runs[0].record.txs.find((t) => t.kind === "sell").hash;
    const e = log.find((x) => x.method === "eth_getTransactionReceipt" && x.params[0] === h && x.url === runs[0].urls[0]);
    if (e) e.result.status = "0x0"; // the base-sepolia run's log (each run's log is edited in turn)
    return log;
  });
  assert.equal((await checkSells(reverted, replayOf, relayers(reverted))).ok, false, "a sell that reverted");
  // a testnet with no helper sell
  for (const n of NETWORKS) {
    const only = at.filter((x) => x.record.chain !== n);
    const r = await checkSells(only, replayOf, relayers(at));
    assert.equal(r.ok, false);
    assert.ok(bad(r).includes(`BAD [${n}] a sell the helper sent, read back (helper-evm-sender.run.${n}.json)`), bad(r).join("\n"));
  }
  const notHelper = at.map((x) => ({ ...x, record: { ...x.record, txs: x.record.txs.map((t) => ({ ...t, via: undefined })) } }));
  assert.equal((await checkSells(notHelper, replayOf, relayers(at))).ok, false, "sells the run's own key sent");
  assert.equal((await checkSells([], replayOf, {})).ok, false, "no run");
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
  return { run, asked, r: judgeL(run) };
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
