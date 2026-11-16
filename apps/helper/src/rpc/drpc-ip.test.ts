// node --test apps/helper/src/rpc/drpc-ip.test.ts (card helper-base-keyed-holds-under-load): dRPC's free tier names 25
// RPS (drpc.org/docs/howitworks/ratelimiting, read 2026-11-16 04:35Z), and from the helper's one IP its three keys draw
// that rate together. Paced per key (8 a second, 8 at once each), a live run's paged log read and the pool fill sent
// dRPC up to 48 in one second: dRPC answered 429, the keys were held, QuickNode's Base day was spent, and callers got
// the helper's own 429 "every provider held" (16 Nov 03:59-04:33Z, run 43801531833). Here a fake dRPC refuses any call
// past 25 in a second across its keys, and under a live run's load (callers each second, a 10,000-block paged read, the
// pool fill) it must never refuse one, every caller is answered and the fill still moves. Fake clock and timers; the
// URLs are made up, the keys planted strings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRpc, keyedPaces } from "./rpc.ts";

const QN = "https://name-two.base-mainnet.quiknode.test/plantedBASEqn00key123456789abcd/";
const DR = [1, 2, 3].map((n) => `https://lb.drpc.test/base/plantedBASEdr${n}key123456789abcd`);
const ENV: Record<string, string> = { BASE_RPC_URL_QUICKNODE: QN, BASE_RPC_URL_DRPC_1: DR[0]!, BASE_RPC_URL_DRPC_2: DR[1]!, BASE_RPC_URL_DRPC_3: DR[2]! };
/** dRPC's free rate, the doc's words: 25 calls in a second from one IP, every key and keyless URL together. */
const DRPC_RPS = 25;
const POOL = "0xaa080e74ec99cf5c684548c77ca145edfcf899cf";
const FROM = 54_325_671;
const FINAL = FROM + 49_999;
const hex = (n: number): string => `0x${n.toString(16)}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function world() {
  let clock = 1_800_000_000_000;
  const timers: { at: number; ok: () => void }[] = [];
  const drpcAt: number[] = [];
  const refused: number[] = [];
  const fills: number[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { id: unknown; method: string; params: unknown[] };
    if (DR.includes(url)) {
      // dRPC: past 25 in the last second from this IP, its 429 (no Retry-After, as live)
      const inSecond = drpcAt.filter((t) => t > clock - 1000).length;
      drpcAt.push(clock);
      if (inSecond >= DRPC_RPS) return refused.push(clock), json({ jsonrpc: "2.0", id: req.id, error: { code: 429, message: "Too many request, try again later" } }, 429);
    }
    if (req.method === "eth_getBlockByNumber") return json({ jsonrpc: "2.0", id: req.id, result: { number: hex(FINAL), hash: `0x${"ab".repeat(32)}` } });
    if (req.method !== "eth_getLogs") return json({ jsonrpc: "2.0", id: req.id, result: "0x1" });
    const f = req.params[0] as { fromBlock: string; toBlock: string; topics?: unknown };
    const span = Number(BigInt(f.toBlock) - BigInt(f.fromBlock)) + 1;
    if (span > (url === QN ? 5 : 100)) return json({ jsonrpc: "2.0", id: req.id, error: { code: 35, message: "ranges over 10000 blocks are not supported on freetier" } }, 400);
    if (f.topics === undefined) fills.push(clock);
    return json({ jsonrpc: "2.0", id: req.id, result: [] });
  };
  const sleep = (ms: number) => new Promise<void>((ok) => void timers.push({ at: clock + Math.max(0, ms), ok }));
  const step = async (ms: number) => {
    clock += ms;
    for (const t of timers.filter((x) => x.at <= clock)) timers.splice(timers.indexOf(t), 1), t.ok();
    for (let i = 0; i < 3; i++) await new Promise((ok) => setImmediate(ok));
  };
  const lines: string[] = [];
  const r = createRpc(ENV, { fetch: fetch as never, now: () => clock, sleep, log: (l) => void lines.push(l) });
  return { r, step, drpcAt, refused, fills, lines, now: () => clock };
}
const logs = (id: number, from: number, to: number, address: string, topics: unknown = [["0x" + "a1".repeat(32)]]) => JSON.stringify({ jsonrpc: "2.0", id, method: "eth_getLogs", params: [{ address, topics, fromBlock: hex(from), toBlock: hex(to) }] });

test("dRPC's three keys draw one bucket for the helper's IP, at most 25 calls in any second, each key's day still its own account's", () => {
  const paces = Object.entries(keyedPaces(ENV)).filter(([u]) => DR.includes(u)).map(([, p]) => p);
  assert.equal(paces.length, 3, "each key is paced");
  assert.equal(new Set(paces.map((p) => p.group)).size, 3, "three accounts' days");
  // a bucket's worst second: full at its start, then its refill
  const buckets = new Map(paces.map((p) => [p!.rate ?? p!.group ?? "", p!]));
  const worst = [...buckets.values()].reduce((n, p) => n + p.burst + p.perS, 0);
  assert.ok(worst <= DRPC_RPS, `${worst} calls in the worst second from the helper's IP (${buckets.size} buckets), dRPC names 25`);
});

test("under a live run's load on Base's keyed route, dRPC is never sent past its 25 a second: no 429, every caller answered, the 10,000-block reads served, and the fill moves on what callers leave", async () => {
  const w = world();
  // the fill starts on a whole-range pool read
  const cold = w.r.handle("base", "application/json", logs(1, FROM, FINAL, POOL, [["0x" + "a1".repeat(32)]]), "203.0.113.9", false, true);
  for (let i = 0; i < 20 && w.fills.length === 0; i++) await w.step(50);
  await cold;
  assert.ok(w.fills.length > 0, "the fill started");
  const answers: { what: string; a: Promise<{ status: number; body: string; why?: string }> }[] = [];
  // a live run's pages and checks from a dozen addresses, each under its share
  const clients = Array.from({ length: 12 }, (_, i) => `203.0.113.${21 + i}`);
  const other = "0x1111111111111111111111111111111111111111";
  for (let s = 0; s < 30; s++) {
    // each 15 s a check's 10,000-block read of another address (100 of dRPC's pages, helper-base-logs-page's shape)
    if (s % 15 === 0) answers.push({ what: `paged ${s}`, a: w.r.handle("base", "application/json", logs(500 + s, FINAL - 9_999, FINAL, other), `203.0.113.${100 + s}`, false, true) });
    // and 6 callers' reads a second, a block, a call and a finalized-head batch of 3 (10 calls, 100 of the route's 135 a
    // 10 s), from a dozen addresses
    for (let k = 0; k < 6; k++) {
      const id = s * 100 + k;
      const body = k % 3 === 0 ? JSON.stringify({ jsonrpc: "2.0", id, method: "eth_blockNumber", params: [] }) : k % 3 === 1 ? JSON.stringify({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: other, data: "0x70a08231" }, "latest"] }) : JSON.stringify([1, 2, 3].map((j) => ({ jsonrpc: "2.0", id: id * 10 + j, method: j === 1 ? "eth_chainId" : "eth_getBlockByNumber", params: j === 1 ? [] : ["finalized", false] })));
      answers.push({ what: `caller ${s}.${k}`, a: w.r.handle("base", "application/json", body, clients[(s * 6 + k) % clients.length]!, false, true) });
      await w.step(150);
    }
    await w.step(100);
  }
  for (let i = 0; i < 300; i++) await w.step(10);
  const got = await Promise.all(answers.map(async (x) => ({ what: x.what, ...(await x.a) })));
  assert.deepEqual(w.refused.length, 0, `dRPC refused ${w.refused.length} of ${w.drpcAt.length} calls (its 25 a second passed)`);
  const bad = got.filter((g) => g.status !== 200 || /"error"/.test(g.body));
  assert.deepEqual(bad.slice(0, 12).map((g) => `${g.what}: ${g.status} ${g.why ?? ""} ${g.body.slice(0, 120)}`), [], `${bad.length} of ${got.length} reads not answered`);
  const peak = Math.max(...w.drpcAt.map((t) => w.drpcAt.filter((x) => x >= t && x < t + 1000).length));
  assert.ok(peak <= DRPC_RPS, `${peak} dRPC calls in one second`);
  assert.ok(w.fills.length >= 30, `the fill moved meanwhile (${w.fills.length} pages in 30 s)`);
  assert.ok(!w.lines.some((l) => l.includes("planted")), "no key in a log line");
});
