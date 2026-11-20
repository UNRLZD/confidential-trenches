// node --test src/rpc/marks.test.ts (card sol-pools-mainnet-pin): the mainnet mark scan has two routes on two companies.
// Route A, POST /v1/rpc/solana, sends getProgramAccounts to SOLANA_RPC_URL alone, never to a spare or the public
// endpoint. Route B, POST /v1/rpc/solana-marks, answers nothing but that scan (rpc.ts scanAllowed), from the keyed names
// of RPC_UPSTREAMS["solana-marks"] whose company is not route A's, and has no public fallback. The signing page lists the
// marks on route B and reads each listed mark on its pair (packages/wallet/src/pool/solana-restore.ts solanaMarksListed). The env check
// that redeploy.sh runs asks B's provider the exact scan and refuses a B on A's company, or one that does not answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { solanaDlmmPairScan } from "@blindfill/kit";
import { RPC_CHAINS, RPC_METHODS } from "./methods.ts";
import { createRpc } from "./rpc.ts";
import { checkMarksRoute } from "../env-check.ts";

/** A still clock: a caller's share and a provider's budget are fixed windows on the helper's clock (limits.ts
 *  clientWindow, upstreamBudget; card helper-share-tests-on-a-still-clock), so on the machine's clock a window's turn
 *  inside a test clears the share its counts and 429s assert (PR 979's merge queue run 44243609488). */
const STILL = (): number => 1_800_000_000_000;
const PROGRAM = "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF";
// made-up hosts and test-only keys: nothing here reaches a network
const key = (n: string) => `test-key-${n}-not-a-secret`;
const A = `https://mainnet.helius-rpc.example/?api-key=${key("a")}`;
const QN = `https://x.solana-mainnet.quiknode.example/${key("qn")}/`;
const DRPC = `https://lb.drpc.example/solana/${key("drpc")}`;
const SAME = `https://other.helius-rpc.example/?api-key=${key("a2")}`;
const SPENT = { commitment: "finalized", encoding: "base64", withContext: true, minContextSlot: 7, filters: [{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "1112" } }] };
const scan = (program = PROGRAM, config: unknown = SPENT) => ({ jsonrpc: "2.0", id: 5, method: "getProgramAccounts", params: [program, config] });
const ANSWER = (id: unknown) => ({ jsonrpc: "2.0", id, result: { context: { slot: 467400178 }, value: [] } });

type Sent = { url: string; body: string };
function fakeFetch(status: (url: string) => number = () => 200) {
  const sent: Sent[] = [];
  const f = async (url: string, init: RequestInit) => {
    sent.push({ url, body: String(init.body) });
    const s = status(url);
    const p = JSON.parse(String(init.body));
    const body = Array.isArray(p) ? p.map((r: { id: unknown }) => ANSWER(r.id)) : ANSWER(p.id);
    return new Response(s === 200 ? JSON.stringify(body) : JSON.stringify({ error: "down" }), { status: s, headers: { "content-type": "application/json" } });
  };
  return { sent, f };
}
const call = (r: ReturnType<typeof createRpc>, chain: string, body: unknown) => r.handle(chain, "application/json", JSON.stringify(body));
const ENV = { SOLANA_RPC_URL: A, SOLANA_RPC_URL_QUICKNODE: QN, SOLANA_RPC_URL_DRPC_1: DRPC, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM };

test("solana-marks is a route of its own whose only method is getProgramAccounts", () => {
  assert.ok((RPC_CHAINS as readonly string[]).includes("solana-marks"));
  assert.deepEqual([...RPC_METHODS["solana-marks" as (typeof RPC_CHAINS)[number]]], ["getProgramAccounts"]);
});

test("route B forwards the exact scan to the first keyed provider not on route A's company, never SOLANA_RPC_URL", async () => {
  const { sent, f } = fakeFetch();
  const r = createRpc(ENV, { now: STILL, fetch: f, log: () => {} });
  const a = await call(r, "solana-marks", scan());
  assert.equal(a.status, 200);
  assert.deepEqual(sent.map((s) => s.url), [QN]);
  assert.deepEqual(JSON.parse(a.body).result.value, []);
});

// review of 369a87a8, P1: the signing page's lister on mainnet is route B (pool-testnet.ts pageSolanaLister), and the
// wallet's lister asks for the addresses alone (solana-restore.ts solanaMarksListed: dataSlice { offset: 0, length: 0 })
test("route B forwards the wallet lister's exact request, the empty dataSlice included", async () => {
  const { sent, f } = fakeFetch();
  const r = createRpc(ENV, { now: STILL, fetch: f, log: () => {} });
  const a = await call(r, "solana-marks", scan(PROGRAM, { ...SPENT, dataSlice: { offset: 0, length: 0 } }));
  assert.equal(a.status, 200);
  assert.deepEqual(sent.map((s) => s.url), [QN]);
});

test("route B refuses every other method and every wider scan, before any call", async () => {
  const { sent, f } = fakeFetch();
  const r = createRpc(ENV, { now: STILL, fetch: f, log: () => {} });
  for (const body of [
    { jsonrpc: "2.0", id: 1, method: "getSlot" },
    { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [PROGRAM, { encoding: "base64" }] },
    { jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["AA=="] },
    scan("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    scan(PROGRAM, { ...SPENT, filters: [{ dataSize: 13 }] }),
    scan(PROGRAM, { ...SPENT, encoding: "jsonParsed" }),
    [scan(), { jsonrpc: "2.0", id: 2, method: "getSlot" }],
  ]) {
    const a = await call(r, "solana-marks", body);
    assert.equal(a.status, 400, JSON.stringify(body));
  }
  assert.equal(sent.length, 0);
});

test("route B never asks route A's company: a QuickNode name set to A's company is skipped, and with none other left B answers 503 and sends nothing", async () => {
  const same = SAME;
  const { sent, f } = fakeFetch();
  const r = createRpc({ ...ENV, SOLANA_RPC_URL_QUICKNODE: same }, { now: STILL, fetch: f, log: () => {} });
  assert.equal((await call(r, "solana-marks", scan())).status, 200);
  assert.deepEqual(sent.map((s) => s.url), [DRPC]);
  sent.length = 0;
  const only = createRpc({ SOLANA_RPC_URL: A, SOLANA_RPC_URL_QUICKNODE: same, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM }, { now: STILL, fetch: f, log: () => {} });
  assert.equal((await call(only, "solana-marks", scan())).status, 503);
  assert.equal(sent.length, 0);
});

test("route B with no keyed name set answers 503 and sends nothing, never a public endpoint", async () => {
  const { sent, f } = fakeFetch();
  const r = createRpc({ SOLANA_RPC_URL: A, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM }, { now: STILL, fetch: f, log: () => {} });
  assert.equal((await call(r, "solana-marks", scan())).status, 503);
  assert.equal(sent.length, 0);
});

test("route B walks to its spare when its first provider is down, never to route A's provider", async () => {
  const { sent, f } = fakeFetch((url) => (url === QN ? 503 : 200));
  const r = createRpc(ENV, { now: STILL, fetch: f, log: () => {} });
  assert.equal((await call(r, "solana-marks", scan())).status, 200);
  assert.deepEqual(sent.map((s) => s.url), [QN, DRPC]);
});

test("route A sends the scan to SOLANA_RPC_URL alone: down, it answers 503, never a keyed spare or the public endpoint", async () => {
  const up = fakeFetch();
  const r = createRpc(ENV, { now: STILL, fetch: up.f, log: () => {} });
  assert.equal((await call(r, "solana", scan())).status, 200);
  assert.deepEqual(up.sent.map((s) => s.url), [A]);
  const down = fakeFetch((url) => (url === A ? 503 : 200));
  const d = createRpc(ENV, { now: STILL, fetch: down.f, log: () => {} });
  assert.equal((await call(d, "solana", scan())).status, 503);
  assert.deepEqual(down.sent.map((s) => s.url), [A]);
  // other reads keep their failover
  down.sent.length = 0;
  await call(d, "solana", { jsonrpc: "2.0", id: 1, method: "getSlot" });
  assert.ok(down.sent.some((s) => s.url !== A), "getSlot still walks past A");
});

test("route A with no SOLANA_RPC_URL answers the scan 503 and sends nothing", async () => {
  const { sent, f } = fakeFetch();
  const r = createRpc({ SOLANA_RPC_URL_QUICKNODE: QN, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM }, { now: STILL, fetch: f, log: () => {} });
  assert.equal((await call(r, "solana", scan())).status, 503);
  assert.equal(sent.length, 0);
});

// ------------------------------------------------------------------------------------------- the start check
const secretsIn = (lines: string[]) => lines.filter((l) => [A, QN, DRPC, "helius", "quiknode", "drpc.example", "test-key"].some((s) => l.includes(s)));

test("the start check asks A and B the exact scan, both mark sizes, and prints status, slot, count and sha256, never a URL", async () => {
  const { sent, f } = fakeFetch();
  const lines = await checkMarksRoute(ENV, f);
  assert.deepEqual(sent.map((s) => s.url), [A, A, QN, QN]);
  for (const s of sent) {
    const b = JSON.parse(s.body);
    assert.equal(b.method, "getProgramAccounts");
    assert.equal(b.params[0], PROGRAM);
    // the wallet lister's exact request: the addresses alone (solana-restore.ts solanaMarksListed)
    assert.deepEqual(Object.keys(b.params[1]).sort(), ["commitment", "dataSlice", "encoding", "filters", "withContext"]);
    assert.deepEqual(b.params[1].dataSlice, { offset: 0, length: 0 });
  }
  assert.ok(lines.some((l) => /SOLANA_RPC_URL_QUICKNODE size 13: HTTP 200, slot 467400178, 0 account\(s\), sha256 [0-9a-f]{16}/.test(l)), lines.join("\n"));
  assert.deepEqual(secretsIn(lines), []);
});

test("the start check refuses B on A's company, B unset, or B not answering 200 with a list, naming variables, never values", async () => {
  const same = SAME;
  const cases: [string, Record<string, string>, (url: string) => number][] = [
    ["B on A's company", { SOLANA_RPC_URL: A, SOLANA_RPC_URL_QUICKNODE: same, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM }, () => 200],
    ["B unset", { SOLANA_RPC_URL: A, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM }, () => 200],
    ["A unset", { SOLANA_RPC_URL_QUICKNODE: QN, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM }, () => 200],
    ["B 403", ENV, (url) => (url === QN ? 403 : 200)],
    ["A 403", ENV, (url) => (url === A ? 403 : 200)],
  ];
  for (const [name, env, status] of cases) {
    const { f } = fakeFetch(status);
    await assert.rejects(checkMarksRoute(env, f), (e: Error) => secretsIn([e.message]).length === 0 && /SOLANA_RPC_URL/.test(e.message), name);
  }
  // an answer with no list is a refusal too
  const noList = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32010, message: "excluded from account secondary indexes" } }), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(checkMarksRoute(ENV, noList), /SOLANA_RPC_URL/);
});

test("the start check is off with no mainnet pool program: the routes refuse every scan then", async () => {
  const { sent, f } = fakeFetch();
  const lines = await checkMarksRoute({ SOLANA_RPC_URL: A }, f);
  assert.equal(sent.length, 0);
  assert.match(lines.join("\n"), /POOL_SOLANA_PROGRAM_MAINNET unset/);
});

test("?keyed=only keeps both mark routes: the scan on /solana goes to A alone and /solana-marks to B alone (review P3-1)", async () => {
  const { sent, f } = fakeFetch();
  const r = createRpc(ENV, { now: STILL, fetch: f, log: () => {} });
  const keyedOnly = (chain: string) => r.handle(chain, "application/json", JSON.stringify(scan()), undefined, false, true);
  assert.equal((await keyedOnly("solana")).status, 200);
  assert.deepEqual(sent.map((s) => s.url), [A]);
  sent.length = 0;
  assert.equal((await keyedOnly("solana-marks")).status, 200);
  assert.deepEqual(sent.map((s) => s.url), [QN]);
  // A down: still 503, never a keyed spare
  const down = fakeFetch((url) => (url === A ? 503 : 200));
  const d = createRpc(ENV, { now: STILL, fetch: down.f, log: () => {} });
  assert.equal((await d.handle("solana", "application/json", JSON.stringify(scan()), undefined, false, true)).status, 503);
  assert.deepEqual(down.sent.map((s) => s.url), [A]);
});

test("route B folds a company's other domain: dRPC's keyed lb.drpc.live is A's company when A is on drpc.org (review P3-5)", async () => {
  const aDrpc = `https://solana.drpc.example.drpc.org/${key("a-drpc")}`;
  const bDrpc = `https://lb.drpc.live/solana/${key("b-drpc")}`;
  const { sent, f } = fakeFetch();
  const r = createRpc({ SOLANA_RPC_URL: aDrpc, SOLANA_RPC_URL_DRPC_1: bDrpc, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM }, { now: STILL, fetch: f, log: () => {} });
  assert.equal((await call(r, "solana-marks", scan())).status, 503);
  assert.equal(sent.length, 0);
  await assert.rejects(checkMarksRoute({ SOLANA_RPC_URL: aDrpc, SOLANA_RPC_URL_DRPC_1: bDrpc, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM }, f), /SOLANA_RPC_URL_DRPC_1 on SOLANA_RPC_URL's company/);
});

// ---------------------------------------------------- card helper-solana-off-a-spent-key: route A off a spent plan
// Live 20 Nov 08:5xZ: SOLANA_RPC_URL's provider answered every read HTTP 429 "max usage reached" (its plan spent), and
// the deploy's settings check, which asked SOLANA_RPC_URL alone, refused every helper deploy (helper-9.sh, 08:46Z).
const SPENT_429 = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32429, message: "max usage reached" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } });
const SHORT_429 = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32429, message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } });
/** A fetch whose `url` answers `bad(n)` for its n-th call (undefined: the scan's answer), every other URL the scan's
 *  answer, and getGenesisHash mainnet's genesis (the probe's identity read). */
function scripted(bad: Record<string, (n: number) => Response | undefined>) {
  const sent: Sent[] = [];
  const n = new Map<string, number>();
  const f = async (url: string, init: RequestInit) => {
    sent.push({ url, body: String(init.body) });
    const i = n.get(url) ?? 0;
    n.set(url, i + 1);
    const r = bad[url]?.(i);
    if (r !== undefined) return r;
    const p = JSON.parse(String(init.body));
    const one = (q: { id: unknown; method?: string }) => (q.method === "getGenesisHash" ? { jsonrpc: "2.0", id: q.id, result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" } : ANSWER(q.id));
    return new Response(JSON.stringify(Array.isArray(p) ? p.map(one) : one(p)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, f };
}
/** A clock the waits move (a hold of 1 s ends after a sleep of 1 s). */
function moving() {
  let t = STILL();
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}
const POOL_SCAN = (id = 9) => ({ jsonrpc: "2.0", id, method: "getProgramAccounts", params: [...solanaDlmmPairScan("So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")] });

test("a spent route A (429 max usage reached): the start check takes the next keyed provider that answers, on a company no route B URL is on, before any public endpoint", async () => {
  const { sent, f } = scripted({ [A]: () => SPENT_429() });
  const t = moving();
  const lines = await checkMarksRoute(ENV, f, t.sleep);
  // A asked once: a spent plan is no throttle to wait out; then QuickNode as A, dRPC as B, never A again
  assert.deepEqual(sent.map((s) => s.url), [A, QN, QN, DRPC, DRPC]);
  assert.ok(lines.some((l) => /SOLANA_RPC_URL size 13: HTTP 429, its plan spent/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /route A: SOLANA_RPC_URL_QUICKNODE; route B: SOLANA_RPC_URL_DRPC_1/.test(l)), lines.join("\n"));
  assert.deepEqual(secretsIn(lines), []);
});

test("a spent route A with no other company left for route B: the start check refuses, naming the spent variable and why no pair answers", async () => {
  const { f } = scripted({ [A]: () => SPENT_429() });
  const t = moving();
  await assert.rejects(checkMarksRoute({ SOLANA_RPC_URL: A, SOLANA_RPC_URL_QUICKNODE: QN, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM }, f, t.sleep), (e: Error) => secretsIn([e.message]).length === 0 && /SOLANA_RPC_URL size 13: HTTP 429, its plan spent/.test(e.message) && /SOLANA_RPC_URL_QUICKNODE: no route B provider off its company/.test(e.message));
});

test("a short throttle on route A (429, no spent plan) is waited out, never a switch: the start check asks A again after its Retry-After", async () => {
  const { sent, f } = scripted({ [A]: (n) => (n === 0 ? SHORT_429() : undefined) });
  const t = moving();
  const lines = await checkMarksRoute(ENV, f, t.sleep);
  assert.deepEqual(sent.map((s) => s.url), [A, A, A, QN, QN]);
  assert.ok(lines.some((l) => /route A: SOLANA_RPC_URL; route B: SOLANA_RPC_URL_QUICKNODE/.test(l)), lines.join("\n"));
  // one that never ends is refused on A, never moved past
  const always = scripted({ [A]: () => SHORT_429() });
  await assert.rejects(checkMarksRoute(ENV, always.f, t.sleep), /SOLANA_RPC_URL size 13: HTTP 429$/);
  assert.ok(always.sent.every((s) => s.url === A));
});

test("the helper's route A moves off a spent plan to the next keyed provider, route B off that one's company; a pool scan follows A", async () => {
  const { sent, f } = scripted({ [A]: () => SPENT_429() });
  const t = moving();
  const r = createRpc(ENV, { now: t.now, sleep: t.sleep, fetch: f, log: () => {} });
  const first = await call(r, "solana", scan());
  assert.equal(first.status, 200);
  assert.deepEqual(sent.map((s) => s.url), [A, QN]);
  sent.length = 0;
  assert.equal((await call(r, "solana", scan())).status, 200);
  assert.equal((await call(r, "solana-marks", scan())).status, 200);
  assert.equal((await call(r, "solana", POOL_SCAN())).status, 200);
  // the spent plan is never asked again inside its retry; B is dRPC, never QuickNode, now route A's company
  assert.deepEqual(sent.map((s) => s.url), [QN, DRPC, QN]);
});

test("route A's short throttle is waited out on A, never a switch to another provider", async () => {
  const { sent, f } = scripted({ [A]: (n) => (n === 0 ? SHORT_429() : undefined) });
  const t = moving();
  const r = createRpc(ENV, { now: t.now, sleep: t.sleep, fetch: f, log: () => {} });
  assert.equal((await call(r, "solana", scan())).status, 200);
  assert.deepEqual(sent.map((s) => s.url), [A, A]);
  sent.length = 0;
  assert.equal((await call(r, "solana-marks", scan())).status, 200);
  assert.deepEqual(sent.map((s) => s.url), [QN]);
});

test("route A spent with no company left for route B: the mark scan stays on A (503 while spent), B stays off A's company; the pool scan moves to the keyed provider that answers", async () => {
  const { sent, f } = scripted({ [A]: () => SPENT_429() });
  const t = moving();
  const r = createRpc({ SOLANA_RPC_URL: A, SOLANA_RPC_URL_QUICKNODE: QN, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM }, { now: t.now, sleep: t.sleep, fetch: f, log: () => {} });
  assert.equal((await call(r, "solana", scan())).status, 503);
  assert.equal((await call(r, "solana-marks", scan())).status, 200);
  sent.length = 0;
  assert.equal((await call(r, "solana", POOL_SCAN())).status, 200);
  assert.deepEqual(sent.map((s) => s.url), [QN]);
});

// the live host's shape, read by the CO 20 Nov 09:07Z: SOLANA_RPC_URL and SOLANA_TRADES_RPC_URL one spent Helius URL,
// SOLANA_HOLDERS_RPC_URL another Helius key with its own credits that answers, QuickNode the only other company
const HOLDERS = `https://mainnet.helius-rpc.example/?api-key=${key("holders")}`;
const HOST = { SOLANA_RPC_URL: A, SOLANA_TRADES_RPC_URL: A, SOLANA_HOLDERS_RPC_URL: HOLDERS, SOLANA_RPC_URL_QUICKNODE: QN, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM };
test("the live host's shape: SOLANA_RPC_URL spent (the trades slot the same URL, asked once), the holders slot's own Helius key takes route A and QuickNode route B, in the check and in the helper", async () => {
  const t = moving();
  const check = scripted({ [A]: () => SPENT_429() });
  const lines = await checkMarksRoute(HOST, check.f, t.sleep);
  assert.deepEqual(check.sent.map((s) => s.url), [A, HOLDERS, HOLDERS, QN, QN]);
  assert.ok(lines.some((l) => /route A: SOLANA_HOLDERS_RPC_URL; route B: SOLANA_RPC_URL_QUICKNODE/.test(l)), lines.join("\n"));
  assert.deepEqual(secretsIn(lines), []);
  const { sent, f } = scripted({ [A]: () => SPENT_429() });
  const r = createRpc(HOST, { now: t.now, sleep: t.sleep, fetch: f, log: () => {} });
  const a = await call(r, "solana", scan());
  assert.equal(a.status, 200);
  // the read names the provider by its variable alone (Server-Timing rpc), never its URL
  assert.match((a.timing ?? []).join(", "), /rpc;dur=\d+;desc="SOLANA_HOLDERS_RPC_URL"/);
  assert.equal((await call(r, "solana-marks", scan())).status, 200);
  assert.equal((await call(r, "solana", POOL_SCAN())).status, 200);
  assert.deepEqual(sent.map((s) => s.url), [A, HOLDERS, QN, HOLDERS]);
  // QuickNode is never route A while it is route B's only company
  const both = scripted({ [A]: () => SPENT_429(), [HOLDERS]: () => SPENT_429() });
  await assert.rejects(checkMarksRoute(HOST, both.f, t.sleep), /SOLANA_HOLDERS_RPC_URL size 13: HTTP 429, its plan spent.*SOLANA_RPC_URL_QUICKNODE: no route B provider off its company/);
});

test("/v1/health's solana.rpc is keyed while a keyed spare serves past a spent first key, and rpc.solana names the spent one", async () => {
  const { f } = scripted({ [A]: () => SPENT_429() });
  const t = moving();
  const r = createRpc(ENV, { now: t.now, sleep: t.sleep, fetch: f, log: () => {} });
  const a = await call(r, "solana", { jsonrpc: "2.0", id: 1, method: "getSlot" });
  assert.equal(a.status, 200);
  // the probe draws a second of the spares' pace the read just took
  await t.sleep(1_000);
  await r.probe();
  assert.equal(r.slot.state(), "keyed");
  assert.deepEqual(r.keyed().solana, ["helius-rpc.example spent", "quiknode.example answers", "drpc.example key1 answers"]);
});

test("/v1/health's solana.rpc is fallback once no keyed provider serves: every one spent", async () => {
  const { f } = scripted({ [A]: () => SPENT_429(), [QN]: () => SPENT_429(), [DRPC]: () => SPENT_429() });
  const t = moving();
  const r = createRpc(ENV, { now: t.now, sleep: t.sleep, fetch: f, log: () => {} });
  await call(r, "solana", { jsonrpc: "2.0", id: 1, method: "getSlot" });
  await r.probe();
  assert.equal(r.slot.state(), "fallback");
});

test("the start check refuses a 200 list with no context slot, and a non-200 that carries a list (review P3-2)", async () => {
  const answer = (status: number, result: unknown) => async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status, headers: { "content-type": "application/json" } });
  await assert.rejects(checkMarksRoute(ENV, answer(200, { value: [] })), /SOLANA_RPC_URL size 13: HTTP 200, no list with its slot/);
  await assert.rejects(checkMarksRoute(ENV, answer(200, { context: {}, value: [] })), /HTTP 200, no list with its slot/);
  await assert.rejects(checkMarksRoute(ENV, answer(500, { context: { slot: 467400178 }, value: [] })), /SOLANA_RPC_URL size 13: HTTP 500$/);
});
