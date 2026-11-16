// node --test apps/helper/src/rpc/pool-logs.test.ts (card helper-keyed-logs-serve-a-whole-pool-range): the keyed-only
// route answers an eth_getLogs of the pinned pool over a finalized range of any width. On Base's keyed list (QuickNode's
// trial at 5 blocks, dRPC's free keys at 100) the route's pages reach 10,000 blocks, so a fresh device's one read of the
// pool's whole history was refused with "maximum block range: 10000" every time. Now the first such read starts the pool
// store's fill (background pages within dRPC's span, POOL_FILL_PER_S a second), and once it covers the range every read
// of it is answered from the store, topics filtered, the part past it paged as before. Fake clock and sleep throughout
// (no real timer); the URLs are made up, the keys planted strings.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as rpcModule from "./rpc.ts";
import { createRpc } from "./rpc.ts";

// read off the module, so this file loads at main and fails on the behaviour (red runs)
const { POOL_FILL_PER_S, POOL_FILL_FAILS } = rpcModule as unknown as { POOL_FILL_PER_S?: number; POOL_FILL_FAILS?: number };

const QN = "https://name-two.base-mainnet.quiknode.test/plantedBASEqn00key123456789abcd/";
const DR = [1, 2, 3].map((n) => `https://lb.drpc.test/base/plantedBASEdr${n}key123456789abcd`);
const BASE_ENV: Record<string, string> = { BASE_RPC_URL_QUICKNODE: QN, BASE_RPC_URL_DRPC_1: DR[0]!, BASE_RPC_URL_DRPC_2: DR[1]!, BASE_RPC_URL_DRPC_3: DR[2]! };
const SPANS: Record<string, number> = { [QN]: 5, ...Object.fromEntries(DR.map((u) => [u, 100])) };
/** Base's pool as the kit pins it and its deploy block (packages/wallet/src/pool/evm.ts EVM_POOLS). */
const POOL = "0xaa080e74ec99cf5c684548c77ca145edfcf899cf";
const FROM = 54_325_671;
/** The finalized head: 30,000 blocks of pool life, 300 of dRPC's pages, three times what the route's pages reach. */
let FINAL = FROM + 29_999;
/** Every provider's head read refused (429), as on 16 Nov when dRPC's keys were held; and URLs that refuse everything. */
let HEAD_DOWN = false;
/** The next this many head reads refused (429), one per provider asked: a head read that fails, then answers. */
let HEAD_FAILS = 0;
const DOWN = new Set<string>();
const A = `0x${"a1".repeat(32)}`;
const B = `0x${"b2".repeat(32)}`;
const hex = (n: number): string => `0x${n.toString(16)}`;
const CALLER = "203.0.113.9";
type Log = { address: string; blockNumber: string; logIndex: string; data: string; topics: string[]; transactionHash: string };
/** The pool's logs over a range: at each block divisible by 37, a log of topic A then one of topic B. */
function logsIn(from: number, to: number, only?: string): Log[] {
  const out: Log[] = [];
  for (let b = Math.ceil(from / 37) * 37; b <= to; b += 37)
    for (const [i, t] of [A, B].entries()) if (only === undefined || only === t) out.push({ address: POOL, blockNumber: hex(b), logIndex: hex(i), data: "0x", topics: [t], transactionHash: `0x${"cd".repeat(32)}` });
  return out;
}
const wideBody = (id: number | string, from: number, to: number, topics: unknown = [[A, B]], address = POOL): string => JSON.stringify({ jsonrpc: "2.0", id, method: "eth_getLogs", params: [{ address, topics, fromBlock: hex(from), toBlock: hex(to) }] });

type Sent = { url: string; at: number; fill: boolean; from: number; to: number };
function world(override?: (url: string, from: number, to: number, fill: boolean) => Response | undefined) {
  let clock = 1_800_000_000_000;
  const sent: Sent[] = [];
  const lines: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { id: unknown; method: string; params: unknown[] };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (DOWN.has(url) || (req.method === "eth_getBlockByNumber" && (HEAD_DOWN || (HEAD_FAILS > 0 && HEAD_FAILS-- > 0)))) return new Response("{}", { status: 429, headers: { "retry-after": "30", "content-type": "application/json" } });
    if (req.method === "eth_getBlockByNumber") return json({ jsonrpc: "2.0", id: req.id, result: { number: hex(FINAL), hash: `0x${"ab".repeat(32)}` } });
    if (req.method !== "eth_getLogs") return json({ jsonrpc: "2.0", id: req.id, result: "0x1" });
    const f = req.params[0] as { fromBlock: string; toBlock: string; topics?: string[][] };
    const from = Number(BigInt(f.fromBlock));
    const to = Number(BigInt(f.toBlock));
    // the fill asks the pool's address alone; a caller's page keeps the caller's topics
    const fill = f.topics === undefined;
    sent.push({ url, at: clock, fill, from, to });
    const o = override?.(url, from, to, fill);
    if (o !== undefined) return o;
    if (to - from + 1 > (SPANS[url] ?? Infinity)) return json({ jsonrpc: "2.0", id: req.id, error: { code: 35, message: "ranges over 10000 blocks are not supported on freetier" } }, 400);
    const all = logsIn(from, to);
    return json({ jsonrpc: "2.0", id: req.id, result: fill ? all : all.filter((l) => f.topics![0]!.includes(l.topics[0]!)) });
  };
  const deps = {
    fetch: fetch as never,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    log: (l: string) => void lines.push(l),
  };
  /** Turns of the event loop until the fill logs its end (or `max` turns). */
  const filled = async (max = 200_000): Promise<string> => {
    for (let i = 0; i < max; i++) {
      const l = lines.find((x) => x.startsWith("rpc pool-logs base covered to"));
      if (l !== undefined) return l;
      await new Promise((ok) => setImmediate(ok));
    }
    return "";
  };
  return { sent, lines, deps, filled, tick: (ms: number) => (clock += ms), fills: () => sent.filter((s) => s.fill), callers: () => sent.filter((s) => !s.fill) };
}
const read = (r: ReturnType<typeof createRpc>, body: string, chain = "base") => r.handle(chain, "application/json", body, CALLER, false, true);
const resultOf = (a: { status: number; body: string }) => (JSON.parse(a.body) as { id: unknown; result?: Log[]; error?: { code: number; message: string; data?: string } });

test("Base: the pool's whole finalized range (30,000 blocks, past the route's 10,000) is answered in one read once the store fills, topics filtered, with no upstream log read", async () => {
  FINAL = FROM + 29_999;
  const w = world();
  const r = createRpc(BASE_ENV, w.deps);
  // a cold store: the route's own cap, as before, and the fill starts
  const cold = resultOf(await read(r, wideBody(1, FROM, FINAL)));
  assert.equal(cold.error?.code, -32602, "cold: the route's cap, which the wallet pages on");
  assert.match(cold.error!.message, /maximum block range: 10000$/, "in the words the wallet reads");
  assert.equal(cold.error?.data, `pool logs kept to block ${FROM - 1}`, "and how far the store is");
  assert.match(await w.filled(), /covered to 54355670$/, "the fill covers the pool to the finalized head");
  // the fill: every page within dRPC's 100, never QuickNode's 5, back to back from the deploy block
  const pages = w.fills();
  assert.equal(pages.length, 300, "300 pages of 100 blocks, each asked once");
  assert.ok(pages.every((s) => s.url !== QN && s.to - s.from + 1 <= 100));
  for (let i = 0; i < pages.length; i++) assert.equal(pages[i]!.from, FROM + i * 100);
  const before = w.sent.length;
  const warm = await read(r, wideBody("w-2", FROM, FINAL));
  assert.equal(warm.status, 200, warm.body.slice(0, 200));
  assert.deepEqual(resultOf(warm), { jsonrpc: "2.0", id: "w-2", result: logsIn(FROM, FINAL) } as never, "every log of the pool, in order, the caller's id");
  assert.ok(warm.timing?.includes('rpc-cache;desc="hit"'), "answered from the store");
  assert.equal(w.sent.length, before, "no upstream read");
  // topics filtered as a node filters them; a sub-range of it too
  assert.deepEqual(resultOf(await read(r, wideBody(3, FROM, FINAL, [A]))).result, logsIn(FROM, FINAL, A));
  assert.deepEqual(resultOf(await read(r, wideBody(4, FROM + 5_000, FROM + 25_000, [[B]]))).result, logsIn(FROM + 5_000, FROM + 25_000, B));
  assert.deepEqual(resultOf(await read(r, wideBody(5, FROM, FINAL, [null, A]))).result, [], "a second topic no log has");
  assert.equal(w.sent.length, before, "still no upstream read");
});

test("Base: the head moves on: the store's part from the store, the blocks past it paged as before and joined in order; the fill catches up", async () => {
  FINAL = FROM + 29_999;
  const w = world();
  const r = createRpc(BASE_ENV, w.deps);
  await read(r, wideBody(1, FROM, FINAL));
  await w.filled();
  FINAL += 250;
  w.tick(20_000); // past FINAL_HEAD_MS: the head is read again
  w.lines.length = 0;
  const a = await read(r, wideBody(2, FROM, FINAL));
  assert.equal(a.status, 200, a.body.slice(0, 200));
  assert.deepEqual(resultOf(a).result, logsIn(FROM, FINAL));
  const tail = w.callers();
  assert.ok(tail.length > 0 && tail.every((s) => s.from > FROM + 29_999), "only the blocks past the store asked, with the caller's topics");
  await w.filled();
  const n = w.sent.length;
  assert.deepEqual(resultOf(await read(r, wideBody(3, FROM, FINAL))).result, logsIn(FROM, FINAL));
  assert.equal(w.sent.length, n, "caught up: from the store alone");
});

test(`the fill's pace: at most ${POOL_FILL_PER_S ?? 6} pages in any second, a provider's 429 holds that provider alone, and a caller's reads go on meanwhile`, async () => {
  FINAL = FROM + 29_999;
  let refused = 0;
  const w = world((url, _f, _t, fill) => (fill && url === DR[1] && refused < 3 && ++refused > 0 ? new Response("{}", { status: 429, headers: { "retry-after": "5", "content-type": "application/json" } }) : undefined));
  const r = createRpc(BASE_ENV, w.deps);
  await read(r, wideBody(1, FROM, FINAL));
  // a caller's own reads during the fill are served, never a 429
  for (let i = 0; i < 20; i++) {
    const a = await read(r, JSON.stringify({ jsonrpc: "2.0", id: 100 + i, method: "eth_blockNumber", params: [] }));
    assert.equal(a.status, 200, `caller read ${i}: ${a.status} ${a.body}`);
    await new Promise((ok) => setImmediate(ok));
  }
  await w.filled();
  const at = w.fills().map((s) => s.at);
  for (let i = 0; i < at.length; i++) {
    const inSecond = at.filter((t) => t >= at[i]! && t < at[i]! + 1000).length;
    assert.ok(inSecond <= (POOL_FILL_PER_S ?? 6), `${inSecond} pages in the second from ${at[i]}`);
  }
  assert.equal(refused, 3, "the key refused three times, then served");
  const held = w.fills().filter((s) => s.url === DR[1]);
  for (let i = 1; i < 4; i++) assert.ok(held[i]!.at >= held[i - 1]!.at + 5_000, `the throttled key asked again only after its 5 s (${held[i]!.at - held[i - 1]!.at} ms)`);
  assert.equal(w.fills().filter((s) => s.url !== DR[1] && s.at > held[0]!.at && s.at < held[0]!.at + 5_000).length > 0, true, "the other keys go on meanwhile");
  assert.deepEqual(resultOf(await read(r, wideBody(9, FROM, FINAL))).result, logsIn(FROM, FINAL), "and the store is whole");
  assert.ok(w.lines.some((l) => /^rpc hold base drpc\.test background 5 s pool-logs$/.test(l)), w.lines.join("\n"));
  assert.ok(!w.lines.some((l) => l.includes("planted")), "no key in a log line");
});

test("only the pinned pool: another address, a range before its deploy block or a filter it does not answer is read as before and starts no fill", async () => {
  FINAL = FROM + 29_999;
  const w = world();
  const r = createRpc(BASE_ENV, w.deps);
  const other = "0x1111111111111111111111111111111111111111";
  assert.equal(resultOf(await read(r, wideBody(1, FROM, FINAL, [[A]], other))).error?.code, -32602);
  assert.equal(resultOf(await read(r, wideBody(2, FROM - 20_000, FINAL))).error?.code, -32602);
  assert.equal(resultOf(await read(r, wideBody(3, FROM, FINAL, [["0x12"]]))).error?.code, -32602);
  for (let i = 0; i < 2_000; i++) await new Promise((ok) => setImmediate(ok));
  assert.equal(w.fills().length, 0, "no fill");
  assert.equal(w.lines.filter((l) => l.startsWith("rpc pool-logs")).length, 0);
});

test(`hostile pages are never kept: another address, a block outside the page, logs out of order; ${POOL_FILL_FAILS ?? 20} unserved pages in a row stop the fill short of them`, async () => {
  FINAL = FROM + 29_999;
  const bad = FROM + 12_300;
  const forms = [
    (l: Log[]) => [{ ...l[0]!, address: "0x2222222222222222222222222222222222222222" }, ...l.slice(1)],
    (l: Log[]) => [...l, { ...l[0]!, blockNumber: hex(FINAL + 5) }],
    (l: Log[]) => [...l].reverse(),
  ];
  let k = 0;
  const w = world((_url, from, to, fill) => (fill && from === bad ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: forms[k++ % forms.length]!(logsIn(from, to)) }), { status: 200, headers: { "content-type": "application/json" } }) : undefined));
  const r = createRpc(BASE_ENV, w.deps);
  await read(r, wideBody(1, FROM, FINAL));
  assert.match(await w.filled(), new RegExp(`covered to ${bad - 1}$`), "the store ends before the bad page");
  assert.equal(w.fills().filter((s) => s.from === bad).length, POOL_FILL_FAILS ?? 20);
  // inside it: from the store; past it: as before (here the route's own cap)
  const n = w.sent.length;
  assert.deepEqual(resultOf(await read(r, wideBody(2, FROM, bad - 1))).result, logsIn(FROM, bad - 1));
  assert.equal(w.sent.length, n);
  const rest = resultOf(await read(r, wideBody(3, FROM, FINAL)));
  assert.equal(rest.error?.code, -32602, "the rest past the route's reach: its cap");
  assert.equal(rest.error?.data, `pool logs kept to block ${bad - 1}`, "naming how far the store is");
});

test("HELPER_STORE_DIR: a restart starts warm from the store's file (no upstream log read); a file tampered with is not read", async () => {
  FINAL = FROM + 29_999;
  const dir = mkdtempSync(join(tmpdir(), "pool-logs-"));
  const env = { ...BASE_ENV, HELPER_STORE_DIR: dir };
  const w = world();
  await read(createRpc(env, w.deps), wideBody(1, FROM, FINAL));
  await w.filled();
  const file = join(dir, "rpc-pool-logs", "base.json");
  assert.ok(!readFileSync(file, "utf8").includes("planted"), "no key in the store");
  const w2 = world();
  const r2 = createRpc(env, w2.deps);
  const a = await read(r2, wideBody(2, FROM, FINAL));
  assert.deepEqual(resultOf(a).result, logsIn(FROM, FINAL));
  assert.equal(w2.sent.filter((s) => s.from !== undefined).length, 0, "warm: no log read");
  // a log moved to another pool in the file: the file is not read, the store starts cold
  writeFileSync(file, readFileSync(file, "utf8").replace(POOL, "0x3333333333333333333333333333333333333333"));
  const w3 = world();
  assert.equal(resultOf(await read(createRpc(env, w3.deps), wideBody(3, FROM, FINAL))).error?.code, -32602, "cold again: the route's cap");
  assert.ok(w3.lines.includes("rpc pool-logs base no store kept"));
});

test("the cold fill, named: Base's pool on 16 Nov is 36,480 pages of 100 blocks, about 61 min at POOL_FILL_PER_S, 729,600 dRPC CU once, under 4% of the three keys' day", () => {
  const blocks = 3_647_944; // 54,325,671 to the finalized head the wallet lead's run read (the brief, 16 Nov)
  const pages = Math.ceil(blocks / 100);
  assert.equal(pages, 36_480);
  assert.equal(POOL_FILL_PER_S, 10);
  assert.equal(Math.round(pages / POOL_FILL_PER_S! / 60), 61);
  assert.ok(pages * 20 < 0.04 * 3 * 7_000_000);
});

test("the fill never costs a caller a 429: callers at 120 reads a 10 s on Base's keyed route (its total 135: QuickNode's 35 and dRPC's one bucket's 100) from six addresses, each under its share, while the store fills, are all answered; the fill draws none of the route's total and still moves", async () => {
  FINAL = FROM + 29_999;
  // a fake clock whose timers fire only as the test moves it (the fill and the callers wait on the same clock)
  let clock = 1_800_000_000_000;
  const timers: { at: number; ok: () => void }[] = [];
  const sleep = (ms: number) => new Promise<void>((ok) => void timers.push({ at: clock + Math.max(0, ms), ok }));
  const w = world();
  const r = createRpc(BASE_ENV, { ...w.deps, now: () => clock, sleep });
  const turns = async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise((ok) => setImmediate(ok));
  };
  const step = async (ms: number) => {
    clock += ms;
    for (const t of timers.filter((x) => x.at <= clock)) timers.splice(timers.indexOf(t), 1), t.ok();
    await turns(3);
  };
  const cold = read(r, wideBody(1, FROM, FINAL));
  for (let i = 0; i < 50 && !w.fills().length; i++) await step(10);
  assert.equal(resultOf(await cold).error?.code, -32602);
  assert.ok(w.fills().length > 0, "the fill started");
  const pages0 = w.fills().length;
  const answers: Promise<{ status: number; body: string }>[] = [];
  const clients = ["203.0.113.21", "203.0.113.22", "203.0.113.23", "203.0.113.24", "203.0.113.25", "203.0.113.26"];
  for (let s = 0; s < 30; s++) {
    // 12 reads in each second, spread over it, each client 2 a second (20 a 10 s, under its share of 30), the helper's
    // own head reads on the same total
    for (let k = 0; k < 12; k++) {
      answers.push(r.handle("base", "application/json", JSON.stringify({ jsonrpc: "2.0", id: s * 100 + k, method: "eth_blockNumber", params: [] }), clients[(s * 12 + k) % clients.length], false, true));
      await step(80);
    }
    await step(40);
  }
  for (let i = 0; i < 400; i++) await step(10);
  const got = await Promise.all(answers);
  const refused = got.map((a, i) => [i, a.status, a.body] as const).filter(([, s]) => s !== 200);
  assert.deepEqual(refused.slice(0, 5).map(([i, s]) => `${i} ${s} ${(got[i] as { why?: string }).why}`), [], `${refused.length} of ${got.length} caller reads refused`);
  assert.ok(w.fills().length - pages0 >= 100, `the fill moved on meanwhile (${w.fills().length - pages0} pages in 30 s)`);
});

/** A fake clock whose timers fire only as the test moves it: a helper on it stands still (as if stopped) between steps. */
function scheduler() {
  let clock = 1_800_000_000_000;
  const timers: { at: number; ok: () => void }[] = [];
  const sleep = (ms: number) => new Promise<void>((ok) => void timers.push({ at: clock + Math.max(0, ms), ok }));
  const step = async (ms: number) => {
    clock += ms;
    for (const t of timers.filter((x) => x.at <= clock)) timers.splice(timers.indexOf(t), 1), t.ok();
    for (let i = 0; i < 3; i++) await new Promise((ok) => setImmediate(ok));
  };
  return { now: () => clock, sleep, step };
}
const FILLING = /^pool logs kept to block (\d+)$/;

// card base-reads-never-throttled (E2): live 16 Nov 12:2xZ the helper's finalized-head read met dRPC's code 15 on
// every key, and the fill read a head of 0 and ended ("covered to" its start), so the store stood still until a device
// read past it came. A failed head read is read again at its next turn (FINAL_HEAD_MS) and the fill goes on to the head
test("the fill never ends on a failed head read: every provider's head read refused three walks running, then answered; the fill reaches the head with no second device read", async () => {
  FINAL = FROM + 29_999;
  HEAD_FAILS = 12; // three walks of the four keyed URLs
  try {
    const w = world();
    const r = createRpc(BASE_ENV, w.deps);
    const cold = resultOf(await read(r, wideBody(1, FROM, FINAL)));
    assert.equal(cold.error?.code, -32602, "cold: the route's cap, and the fill starts");
    const devices = w.callers().length;
    assert.match(await w.filled(), /covered to 54355670$/, `the fill reaches the head (${w.lines.filter((l) => l.startsWith("rpc pool-logs")).join(" | ")})`);
    assert.equal(HEAD_FAILS, 0, "every planted refusal was met");
    assert.equal(w.callers().length, devices, "no device read restarted it");
    assert.equal(w.fills().length, 300, "300 pages, each asked once");
  } finally {
    HEAD_FAILS = 0;
  }
});

// card base-reads-never-throttled (E2, the wallet's restore 16 Nov 11:59-12:06Z): a fill that ended at the head left the
// store behind as the chain moved, so a device's whole-range read had a tail past the store wider than the route's 10,000
// blocks and was answered "maximum block range: 10000", paging to the head 10,000 at a time. At the head the fill
// follows it while pool reads come, and the read is answered from the store
test("at the head the fill follows it: the chain moves 15,000 blocks with no device read, and the next whole-range read is answered from the store, no range cap, no caller page", async () => {
  FINAL = FROM + 29_999;
  const clock = scheduler();
  const w = world();
  const r = createRpc(BASE_ENV, { ...w.deps, now: clock.now, sleep: clock.sleep });
  const cold = read(r, wideBody(1, FROM, FINAL));
  for (let i = 0; i < 2_000 && !w.lines.some((l) => l.startsWith("rpc pool-logs base covered to")); i++) await clock.step(100);
  assert.ok(w.lines.includes(`rpc pool-logs base covered to ${FINAL}`), w.lines.slice(-3).join("\n"));
  void (await cold);
  // the chain moves on past the route's reach; no device reads for three minutes
  FINAL += 15_000;
  for (let i = 0; i < 1_800; i++) await clock.step(100);
  const callers = w.callers().length;
  const a = await Promise.race([read(r, wideBody(2, FROM, FINAL)), (async () => {
    for (let i = 0; i < 100; i++) await clock.step(50);
    return { status: 0, body: "{}" };
  })()]);
  assert.equal(a.status, 200, a.body.slice(0, 300));
  assert.deepEqual(resultOf(a).result, logsIn(FROM, FINAL), "every log to the new head, from the store");
  assert.equal(w.callers().length, callers, "no caller page: the store followed the head");
});

// live 16 Nov 02:48-03:12Z (run 43794383970): the fill's 429s held dRPC's keys, the helper's own head read was held with
// them, and the store's part was skipped: the whole-range read got the route's bare cap, no `data`, which the check reads
// as FAIL. A whole-range pool read never answers a range error without the store's progress
test("a whole-range pool read never answers a bare range cap: the helper's head read refused (its keys held), the store's progress is still named", async () => {
  FINAL = FROM + 29_999;
  const w = world();
  const r = createRpc(BASE_ENV, w.deps);
  await read(r, wideBody(1, FROM, FINAL));
  assert.match(await w.filled(), /covered to 54355670$/);
  // the head moves 20,000 blocks on and the helper can no longer read it
  FINAL += 20_000;
  w.tick(20_000);
  HEAD_DOWN = true;
  try {
    const a = resultOf(await read(r, wideBody(2, FROM, FINAL)));
    assert.equal(a.error?.code, -32602, JSON.stringify(a).slice(0, 300));
    assert.match(a.error!.message, /maximum block range: 10000$/, "the route's reach, in the words the wallet reads");
    assert.equal(a.error?.data, `pool logs kept to block ${FROM + 29_999}`, "the filling shape: how far the store is");
    // within the store: answered from it, head read or not
    const n = w.sent.length;
    assert.deepEqual(resultOf(await read(r, wideBody(3, FROM, FROM + 29_999))).result, logsIn(FROM, FROM + 29_999));
    assert.equal(w.sent.length, n, "from the store alone");
  } finally {
    HEAD_DOWN = false;
  }
});

test("a provider's own range cap on the tail past the store is never passed through: the route's cap in the filling shape", async () => {
  FINAL = FROM + 29_999;
  // the tail within the route's reach, but every provider answers a caller's page of it with its own cap, at 200
  const w2 = world((_url, _from, _to, fill) => (fill ? undefined : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "query exceeds max block range 50" } }), { status: 200, headers: { "content-type": "application/json" } })));
  const r2 = createRpc(BASE_ENV, w2.deps);
  await read(r2, wideBody(1, FROM, FINAL));
  await w2.filled();
  FINAL += 250;
  w2.tick(20_000);
  const b = resultOf(await read(r2, wideBody(4, FROM, FINAL)));
  assert.equal(b.error?.code, -32602, JSON.stringify(b).slice(0, 300));
  assert.match(b.error!.message, /^eth_getLogs range too wide, maximum block range: 50$/, "the provider's span in the route's words, never its own");
  // how far the store is when the answer is made: the fill, started by the read, may have kept a page more meanwhile
  // (card helper-base-keyed-holds-under-load: it no longer sits out a caller's draw)
  const kept = Number(FILLING.exec(b.error?.data ?? "")?.[1]);
  assert.ok(kept >= FROM + 29_999 && kept < FINAL, `the filling shape, how far the store is (${b.error?.data})`);
});

// live 16 Nov: about 80 "rpc hold base drpc.live background 1 s pool-logs" lines a minute, each holding the key for every
// caller, and callers refused "every provider held". A fill's own 429 slows the fill alone
test("the fill's 429 never holds a provider for callers: with every dRPC key refusing the fill and QuickNode out, a caller's read is still answered by dRPC, and the fill backs off that key", async () => {
  FINAL = FROM + 29_999;
  const clock = scheduler();
  const refusedFill = new Map<string, number>();
  const w = world((url, _f, _t, fill) => {
    if (!fill) return undefined;
    // each key's first refusal asks 30 s, the rest 1 s (dRPC's own words on 16 Nov)
    const k = (refusedFill.get(url) ?? 0) + 1;
    refusedFill.set(url, k);
    return new Response("{}", { status: 429, headers: { "retry-after": k === 1 ? "30" : "1", "content-type": "application/json" } });
  });
  const r = createRpc(BASE_ENV, { ...w.deps, now: clock.now, sleep: clock.sleep });
  DOWN.add(QN);
  try {
    const cold = read(r, wideBody(1, FROM, FINAL));
    for (let i = 0; i < 100 && refusedFill.size < 3; i++) await clock.step(50);
    assert.equal(refusedFill.size, 3, "the fill was refused on all three keys");
    await clock.step(10);
    const a = read(r, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_blockNumber", params: [] }));
    for (let i = 0; i < 40; i++) await clock.step(25);
    const got = await a;
    assert.equal(got.status, 200, `the caller's read: ${got.status} ${got.body}`);
    // the fill backs off each key: over 60 s each is asked far fewer times than the pace would allow
    for (let i = 0; i < 600; i++) await clock.step(100);
    for (const u of DR) assert.ok((refusedFill.get(u) ?? 0) <= 12, `${u.slice(-30)} asked ${refusedFill.get(u)} times in 60 s while refusing`);
    assert.ok(w.lines.some((l) => /^rpc hold base drpc\.test background \d+ s pool-logs$/.test(l)));
    void cold;
  } finally {
    DOWN.delete(QN);
  }
});

test("the store's progress survives a restart: a helper stopped mid-fill leaves the file, the next one starts warm from it, names it while filling and pages on from the block after, never a page again", async () => {
  FINAL = FROM + 99_999; // 1,000 pages, about 167 s at the pace: past POOL_WRITE_MS, so the file is written mid-fill
  const dir = mkdtempSync(join(tmpdir(), "pool-logs-"));
  const env = { ...BASE_ENV, HELPER_STORE_DIR: dir };
  const file = join(dir, "rpc-pool-logs", "base.json");
  const coveredOf = (): number => {
    try {
      return Number(BigInt((JSON.parse(readFileSync(file, "utf8")) as { covered: string }).covered));
    } catch {
      return -1;
    }
  };
  // the first helper: fills until its file holds part of the pool, then stands still (stopped)
  const c1 = scheduler();
  const w1 = world();
  const r1 = createRpc(env, { ...w1.deps, now: c1.now, sleep: c1.sleep });
  const cold = read(r1, wideBody(1, FROM, FINAL));
  for (let i = 0; i < 3_000 && coveredOf() < FROM; i++) await c1.step(100);
  assert.equal(resultOf(await cold).error?.data, `pool logs kept to block ${FROM - 1}`);
  const kept = coveredOf();
  assert.ok(kept > FROM && kept < FINAL, `the file holds part of the pool (${kept})`);
  // the second helper on the same directory
  const c2 = scheduler();
  const w2 = world();
  const r2 = createRpc(env, { ...w2.deps, now: c2.now, sleep: c2.sleep });
  const mid = read(r2, wideBody(2, FROM, FINAL));
  for (let i = 0; i < 20; i++) await c2.step(10);
  assert.equal(resultOf(await mid).error?.data, `pool logs kept to block ${kept}`, "while filling: the filling shape, from the file");
  assert.ok(!w2.lines.includes("rpc pool-logs base no store kept"), "the file was read");
  for (let i = 0; i < 6_000 && !w2.lines.some((l) => l.startsWith("rpc pool-logs base covered to")); i++) await c2.step(100);
  assert.ok(w2.lines.includes(`rpc pool-logs base covered to ${FINAL}`), w2.lines.slice(-3).join("\n"));
  const pages = w2.fills();
  assert.equal(pages[0]!.from, kept + 1, "resumed at the block after the file's");
  for (let i = 1; i < pages.length; i++) assert.equal(pages[i]!.from, pages[i - 1]!.to + 1, "page after page, none asked twice");
  assert.equal(coveredOf(), FINAL, "and the file holds it all");
  const n = w2.sent.length;
  const whole = await read(r2, wideBody(3, FROM, FINAL));
  assert.deepEqual(resultOf(whole).result, logsIn(FROM, FINAL), "once full: the range");
  assert.equal(w2.sent.length, n);
});
