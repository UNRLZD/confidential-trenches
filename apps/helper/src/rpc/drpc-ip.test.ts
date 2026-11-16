// node --test apps/helper/src/rpc/drpc-ip.test.ts (cards helper-base-keyed-holds-under-load, base-reads-never-throttled):
// from the helper's one IP, dRPC's free plan answers a budget of calls per calendar minute, the three keys together.
// Measured from the helper's box 16 Nov 16:22-16:30Z (limits.ts DRPC_IP_PACE): 62 calls answered in a minute, then 429
// code 15 "You reached free plan rate limit" until the minute turned. Paced at 20 a second, the pool fill and callers
// spent each minute's budget in seconds and callers met dRPC's 429 for the rest of it (live run 43891883180, 16 Nov
// 15:23Z: "[base keyed] eth_getLogs answers 429 (Retry-After "1")", three times). Here a fake dRPC refuses any call past
// 62 in a calendar minute across its keys; under a caller's reads and bursts below that, with the pool fill drawing what
// callers leave, it must never refuse one, and every caller is answered inside its deadline. Fake clock and timers; the
// URLs are made up, the keys planted strings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRpc, keyedPaces } from "./rpc.ts";
import { DRPC_IP_PACE } from "../limits/limits.ts";

const QN = "https://name-two.base-mainnet.quiknode.test/plantedBASEqn00key123456789abcd/";
const DR = [1, 2, 3].map((n) => `https://lb.drpc.test/base/plantedBASEdr${n}key123456789abcd`);
const ENV: Record<string, string> = { BASE_RPC_URL_QUICKNODE: QN, BASE_RPC_URL_DRPC_1: DR[0]!, BASE_RPC_URL_DRPC_2: DR[1]!, BASE_RPC_URL_DRPC_3: DR[2]! };
/** dRPC's free plan from the helper's IP as measured: 62 calls answered in a calendar minute, every key together. */
const DRPC_PER_MINUTE = 62;
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
      // dRPC: past 62 in this calendar minute from this IP, its 429 code 15 (no Retry-After, as live)
      const minute = Math.floor(clock / 60_000);
      const inMinute = drpcAt.filter((t) => Math.floor(t / 60_000) === minute).length;
      drpcAt.push(clock);
      if (inMinute >= DRPC_PER_MINUTE) return refused.push(clock), json({ jsonrpc: "2.0", id: req.id, error: { code: 15, message: "You reached free plan rate limit, please upgrade to paid plan" } }, 429);
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

test("dRPC's three keys draw one bucket for the helper's IP, at most the measured minute's budget in any calendar minute, each key's day still its own account's", () => {
  const paces = Object.entries(keyedPaces(ENV)).filter(([u]) => DR.includes(u)).map(([, p]) => p);
  assert.equal(paces.length, 3, "each key is paced");
  assert.equal(new Set(paces.map((p) => p.group)).size, 3, "three accounts' days");
  // a bucket's worst calendar minute: full at its start, then its refill
  const buckets = new Map(paces.map((p) => [p!.rate ?? p!.group ?? "", p!]));
  const worst = [...buckets.values()].reduce((n, p) => n + p.burst + p.perS * 60, 0);
  assert.ok(worst <= DRPC_PER_MINUTE, `${worst} calls in the worst minute from the helper's IP (${buckets.size} buckets), dRPC answered 62`);
});

test("callers on Base's keyed route under dRPC's minute budget, with the pool fill: dRPC never refuses one, every caller is answered inside its deadline, the excess held in our queue", async () => {
  const w = world();
  // the fill starts on a whole-range pool read
  const cold = w.r.handle("base", "application/json", logs(1, FROM, FINAL, POOL, [["0x" + "a1".repeat(32)]]), "203.0.113.9", false, true);
  for (let i = 0; i < 20 && w.fills.length === 0; i++) await w.step(50);
  await cold;
  const answers: { what: string; t: number; a: Promise<{ status: number; body: string; why?: string }> }[] = [];
  const other = "0x1111111111111111111111111111111111111111";
  // two minutes: a caller's read every 3 s from its own address, and each 30 s a page of six 100-block log reads at once
  // (the device's pool sync), 32 calls a minute
  for (let s = 0; s < 120; s++) {
    if (s % 3 === 0) {
      const body = s % 2 === 0 ? JSON.stringify({ jsonrpc: "2.0", id: s, method: "eth_blockNumber", params: [] }) : JSON.stringify({ jsonrpc: "2.0", id: s, method: "eth_call", params: [{ to: other, data: "0x70a08231" }, "latest"] });
      answers.push({ what: `caller ${s}`, t: w.now(), a: w.r.handle("base", "application/json", body, `203.0.113.${21 + (s % 12)}`, false, true) });
    }
    if (s % 30 === 0) for (let k = 0; k < 6; k++) answers.push({ what: `page ${s}.${k}`, t: w.now(), a: w.r.handle("base", "application/json", logs(1_000 + s * 10 + k, FINAL - 999 + k * 100, FINAL - 900 + k * 100, other), `203.0.113.${60 + k}`, false, true) });
    for (let i = 0; i < 10; i++) await w.step(100);
  }
  for (let i = 0; i < 100; i++) await w.step(100);
  const got = await Promise.all(answers.map(async (x) => ({ what: x.what, ...(await x.a) })));
  assert.deepEqual(w.refused.length, 0, `dRPC refused ${w.refused.length} of ${w.drpcAt.length} calls (its 62 a minute passed)`);
  const bad = got.filter((g) => g.status !== 200 || /"error"/.test(g.body));
  assert.deepEqual(bad.slice(0, 12).map((g) => `${g.what}: ${g.status} ${g.why ?? ""} ${g.body.slice(0, 120)}`), [], `${bad.length} of ${got.length} reads not answered`);
  assert.ok(w.fills.length > 0, `the fill moved meanwhile (${w.fills.length} pages)`);
  assert.ok(!w.lines.some((l) => l.includes("planted")), "no key in a log line");
});

test("a paid dRPC plan's pace is RPC_PACE_DRPC, \"<calls a second>,<at once>\"; empty is the free plan's; any other value stops the start, naming it", () => {
  const drpc = (env: Record<string, string>) => Object.entries(keyedPaces({ ...ENV, ...env })).filter(([u]) => DR.includes(u)).map(([, p]) => [p.perS, p.burst, p.rate]);
  assert.deepEqual(drpc({}), DR.map(() => [DRPC_IP_PACE.perS, DRPC_IP_PACE.burst, "drpc-ip"]));
  assert.deepEqual(drpc({ RPC_PACE_DRPC: "" }), DR.map(() => [DRPC_IP_PACE.perS, DRPC_IP_PACE.burst, "drpc-ip"]));
  assert.deepEqual(drpc({ RPC_PACE_DRPC: "90.5,20" }), DR.map(() => [90.5, 20, "drpc-ip"]), "still the one bucket for the IP");
  for (const bad of ["fast", "0,4", "20", "20,0", "-1,4", "20,4,1"]) assert.throws(() => keyedPaces({ ...ENV, RPC_PACE_DRPC: bad }), /RPC_PACE_DRPC/, bad);
});
