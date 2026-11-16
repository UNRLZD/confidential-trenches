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

test("the cold fill, named: Base's pool on 16 Nov is 36,480 pages of 100 blocks, about 101 min at POOL_FILL_PER_S, 729,600 dRPC CU once, under 4% of the three keys' day", () => {
  const blocks = 3_647_944; // 54,325,671 to the finalized head the wallet lead's run read (the brief, 16 Nov)
  const pages = Math.ceil(blocks / 100);
  assert.equal(pages, 36_480);
  assert.equal(POOL_FILL_PER_S, 6);
  assert.equal(Math.round(pages / POOL_FILL_PER_S! / 60), 101);
  assert.ok(pages * 20 < 0.04 * 3 * 7_000_000);
});
