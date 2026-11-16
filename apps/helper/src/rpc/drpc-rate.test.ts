// node --test apps/helper/src/rpc/drpc-rate.test.ts (card base-reads-never-throttled): dRPC limits the helper's one IP,
// every key and keyless URL of it together, at a rate it changes ("a limit of 25 RPS" "under normal conditions",
// drpc.org/docs/howitworks/ratelimiting, read 2026-11-16 10:19Z). Live 16 Nov 10:17-10:21Z, Base's three keys were each
// refused once a second for runs of 7 to 15 s: a 429 held the one URL 1 s while the others sent on. Here: every dRPC URL
// draws one rate, a refusal of any of them holds them all and halves the pace, and under a dRPC that serves fewer than
// the pace, the helper settles under what it serves: callers answered, the fill moving. Fake clock and timers; the URLs
// are made up, the keys planted strings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DRPC_IP_PACE, PROVIDER_PACE, providerHolds, RATE_BACK_MAX_S, RATE_STEP_MS } from "../limits/limits.ts";
import { createRpc, keyedPaces } from "./rpc.ts";

const QN = "https://name-two.base-mainnet.quiknode.test/plantedBASEqn00key123456789abcd/";
const DR = [1, 2, 3].map((n) => `https://lb.drpc.live/base/plantedBASEdr${n}key123456789abcd`);
const NEAR_DR = "https://lb.drpc.live/near/plantedNEARdr1key123456789abcd";
const RH_KEYLESS = "https://robinhood.drpc.org";
const ENV: Record<string, string> = { BASE_RPC_URL_QUICKNODE: QN, BASE_RPC_URL_DRPC_1: DR[0]!, BASE_RPC_URL_DRPC_2: DR[1]!, BASE_RPC_URL_DRPC_3: DR[2]!, NEAR_RPC_URL_B: NEAR_DR };

test("every URL the helper sends dRPC from its IP draws dRPC's one rate: Base's keys, NEAR's dRPC URL under an existing name, the keyless robinhood.drpc.org", () => {
  const paces = { ...PROVIDER_PACE, ...keyedPaces(ENV) };
  for (const u of [...DR, NEAR_DR, RH_KEYLESS]) assert.equal(paces[u]?.rate, DRPC_IP_PACE.rate, `${u.replace(/planted\w+/, "<key>")} on dRPC's rate`);
  assert.equal(paces[QN]?.rate, undefined, "QuickNode keeps its own");
});

test("a refusal of one dRPC URL holds every URL on the rate, longer at each refusal in a row; one inside the hold counts no more; the pace halves and climbs back one a second each RATE_STEP_MS", () => {
  let clock = 1_800_000_000_000;
  const h = providerHolds(() => clock, { ...PROVIDER_PACE, ...keyedPaces(ENV) });
  const all = [...DR, NEAR_DR, RH_KEYLESS];
  h.hold(DR[0]!, 1);
  for (const u of all) assert.ok(h.heldMs(u) > 0, `${u.replace(/planted\w+/, "<key>")} held with key 1`);
  assert.equal(h.heldMs(QN), 0, "QuickNode not held");
  // a refusal of a send that left before the hold: the same hold
  h.hold(DR[1]!, 1);
  assert.equal(h.heldMs(DR[2]!), 1000);
  // sends after the hold refused again: 2 s, then 4, 8, 16, never more
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) {
    clock += h.heldMs(DR[0]!) + 1;
    h.hold(DR[i % 3]!, 1);
    waits.push(h.heldMs(NEAR_DR));
  }
  assert.deepEqual(waits, [2000, 4000, 8000, 16000, RATE_BACK_MAX_S * 1000, RATE_BACK_MAX_S * 1000]);
  // the pace: a second's sends once the hold ends, at the floor after seven halvings, then climbing
  const sends = (ms: number): number => {
    let n = 0;
    for (let t = 0; t < ms; t += 10) {
      if (h.heldMs(DR[0]!) === 0 && h.take(DR[n % 3]!, 1, false) === 0) n++;
      clock += 10;
    }
    return n;
  };
  clock += h.heldMs(DR[0]!);
  const low = sends(10_000);
  assert.ok(low <= DRPC_IP_PACE.burst + 2 * 10 + 1, `${low} sends in 10 s at the floor (2 a second)`);
  clock += 20 * RATE_STEP_MS;
  const back = sends(10_000);
  assert.ok(back >= DRPC_IP_PACE.perS * 10 - 2, `${back} sends in 10 s once climbed back to the pace's 20 a second`);
  // a refusal RATE_CALM_MS after the last starts again at 1 s
  clock += 60_000;
  h.hold(DR[2]!, 1);
  assert.equal(h.heldMs(DR[0]!), 1000);
});

const POOL = "0xaa080e74ec99cf5c684548c77ca145edfcf899cf";
const FROM = 54_325_671;
const FINAL = FROM + 2_000_000;
const hex = (n: number): string => `0x${n.toString(16)}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("under a dRPC that serves 8 a second from the helper's IP (under the pace's 20), the helper settles under it: dRPC refuses at most a few sends a minute past the first, every caller is answered, the fill moves", async () => {
  /** dRPC's rate today, as the doc's dynamic limit lets it be: 8 calls in any second, every URL together. */
  const SERVED = 8;
  let clock = 1_800_000_000_000;
  const timers: { at: number; ok: () => void }[] = [];
  const drpcAt: number[] = [];
  const refused: number[] = [];
  const fills: number[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { id: unknown; method: string; params: unknown[] };
    if (DR.includes(url)) {
      const inSecond = drpcAt.filter((t) => t > clock - 1000).length;
      drpcAt.push(clock);
      if (inSecond >= SERVED) return refused.push(clock), json({ jsonrpc: "2.0", id: req.id, error: { code: 429, message: "Too many request, try again later" } }, 429);
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
  // the fill starts on a whole-range pool read
  const cold = r.handle("base", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: POOL, topics: [["0x" + "a1".repeat(32)]], fromBlock: hex(FROM), toBlock: hex(FINAL) }] }), "203.0.113.9", false, true);
  for (let i = 0; i < 20 && fills.length === 0; i++) await step(50);
  void cold;
  assert.ok(fills.length > 0, "the fill started");
  const other = "0x1111111111111111111111111111111111111111";
  const answers: { what: string; a: Promise<{ status: number; body: string; why?: string }> }[] = [];
  const SECONDS = 180;
  for (let s = 0; s < SECONDS; s++) {
    // each 15 s a check's 2,000-block read of another address: 20 pages, dRPC's alone (QuickNode's trial spans 5), which
    // at 8 a second fit the read's 12 s beside the fill
    if (s % 15 === 0) answers.push({ what: `paged ${s}`, a: r.handle("base", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 500 + s, method: "eth_getLogs", params: [{ address: other, topics: [["0x" + "a1".repeat(32)]], fromBlock: hex(FINAL - 1_999), toBlock: hex(FINAL) }] }), `203.0.113.${100 + (s % 50)}`, false, true) });
    // 4 callers' reads a second from a dozen addresses: a block, a call, a balance, a chain id
    for (let k = 0; k < 4; k++) {
      const id = s * 100 + k;
      const method = ["eth_blockNumber", "eth_call", "eth_getBalance", "eth_chainId"][k]!;
      const params = method === "eth_call" ? [{ to: other, data: "0x70a08231" }, "latest"] : method === "eth_getBalance" ? [other, "latest"] : [];
      answers.push({ what: `caller ${s}.${k}`, a: r.handle("base", "application/json", JSON.stringify({ jsonrpc: "2.0", id, method, params }), `203.0.113.${21 + ((s * 4 + k) % 12)}`, false, false) });
      await step(250);
    }
  }
  for (let i = 0; i < 300; i++) await step(10);
  const got = await Promise.all(answers.map(async (x) => ({ what: x.what, ...(await x.a) })));
  // the first refusal is how the helper learns dRPC's rate today: a read inside the hold it starts may find every provider
  // held once; from the first 30 s on, every caller is answered
  const bad = got.filter((g) => g.status !== 200 || /"error"/.test(g.body));
  const settled = bad.filter((g) => Number(/ (\d+)/.exec(g.what)![1]) >= 30);
  assert.ok(bad.length - settled.length <= 1, `${bad.length - settled.length} callers not answered while the rate was learnt`);
  assert.deepEqual(settled.slice(0, 8).map((g) => `${g.what}: ${g.status} ${g.why ?? ""} ${g.body.slice(0, 100)}`), [], `${settled.length} of ${got.length} callers not answered past the first 30 s`);
  const t0 = drpcAt[0]!;
  const late = refused.filter((t) => t >= t0 + 60_000).length;
  const minutes = (SECONDS - 60) / 60;
  assert.ok(late <= 3 * minutes, `dRPC refused ${late} sends in the last ${minutes} min (${refused.length} of ${drpcAt.length} in all): the helper must settle under what dRPC serves`);
  const lateFills = fills.filter((t) => t >= t0 + 60_000).length;
  assert.ok(lateFills >= 60, `the fill moved ${lateFills} pages in the last ${minutes} min`);
  assert.ok(!lines.some((l) => l.includes("planted")), "no key in a log line");
});
