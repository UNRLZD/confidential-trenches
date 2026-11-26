// node --test apps/helper/src/rpc/robinhood-seat.test.ts (card robinhood-warm-tap-inside-2s): POST
// /v1/rpc/robinhood?keyed=alchemy is the signing page's Robinhood seat, read beside its keyless providers. A tap asks
// the seat up to 93 calls and a cold tap and three warm 294 in about 13 s (a mainnet run of the tap check's own quotes
// with the seat first in Robinhood's list, 26 Nov 15:5xZ), so the seat has a share of its own, sized to taps, under a
// total that leaves the Alchemy key half its pace for the route's other reads. The key is Pay As You Go with no
// spending cap of its own, so its company is paced and its day capped in compute units, counted at the dearest method
// the route sends; and one caller's seat reads in a UTC day are bounded, as NEAR's seat's are. Every URL is made up.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as limitsModule from "../limits/limits.ts";
import * as rpcModule from "./rpc.ts";
import { createRpc, keyedPaces } from "./rpc.ts";

// read off the modules, so this file still loads at a base without them and its tests fail on the behaviour (red runs)
const R = rpcModule as unknown as { SEAT_SHARE?: number; ALCHEMY_SEAT_DAY?: number; KEYED_ROUTE_SHARE: number; RPC_PAGE_NEED: Record<string, number> };
const L = limitsModule as unknown as { KEYED_PACE: Record<string, { perS: number; burst: number } | undefined>; KEYED_DAY: Record<string, number | undefined>; KEYED_COST: Record<string, { evm: number } | undefined> };
const SHARE = R.SEAT_SHARE ?? 240;
const SEAT_DAY = R.ALCHEMY_SEAT_DAY ?? 30_000;

const ALCHEMY = "https://robinhood-mainnet.g.alchemy.com/v2/plantedRHalchemy0key123456789";
const BASE_ALCHEMY = "https://base-mainnet.g.alchemy.com/v2/plantedBASEalchemy0key12345678";
const QN = "https://qn.test/plantedRHquicknode0key123456789/";
const DRPC = "https://lb.drpc.test/robinhood/plantedRHdrpc0key123456789";
const KEYS = { ROBINHOOD_RPC_URL: ALCHEMY, ROBINHOOD_RPC_URL_QUICKNODE: QN, ROBINHOOD_RPC_URL_DRPC_1: DRPC };
const JSON_T = "application/json";
const CALL = { jsonrpc: "2.0", id: 3, method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000001", data: "0x" }, "latest"] };
const DAY_MS = 86_400_000;

/** A rig on a planted clock at a UTC day's start (each sleep moves it), every URL answering, or Alchemy down. */
function rig(env: Record<string, string> = KEYS) {
  const asked: string[] = [];
  const mode = { down: false };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push(url);
    if (url === ALCHEMY && mode.down) return new Response("down", { status: 503 });
    const id = (JSON.parse(String(init.body)) as { id: unknown }).id;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x01" }), { status: 200, headers: { "content-type": JSON_T } });
  };
  const c = { t: Math.ceil(1_800_000_000_000 / DAY_MS) * DAY_MS };
  const r = createRpc(env, { fetch: fetch as never, now: () => c.t, sleep: async (ms: number) => void (c.t += ms), log: () => undefined });
  const handle = r.handle as (...a: unknown[]) => ReturnType<typeof r.handle>;
  const seat = (client = "198.51.100.7") => handle("robinhood", JSON_T, JSON.stringify(CALL), client, false, "alchemy");
  const keyedOnly = (client = "198.51.100.7") => handle("robinhood", JSON_T, JSON.stringify(CALL), client, false, true);
  return { asked, c, seat, keyedOnly, mode };
}

test("one caller's seat reads in 10 s: the seat's own share (SEAT_SHARE, a tap's), every one sent to Alchemy alone, then 429; the caller's ?keyed=only share is its own", async () => {
  const { asked, c, seat, keyedOnly } = rig();
  let plain = 0;
  while ((await keyedOnly()).status === 200) if (++plain > 500) break;
  assert.equal(plain, R.RPC_PAGE_NEED.robinhood, "the caller's share on ?keyed=only, as before");
  asked.length = 0;
  let ok = 0;
  let last;
  for (let i = 0; i < SHARE + 1; i++) {
    last = await seat();
    if (last.status !== 200) break;
    ok++;
    c.t += 30;
  }
  assert.equal(ok, SHARE, `answered ${ok}, the share ${SHARE}: three warm taps' seat calls in 10 s`);
  assert.equal(last!.status, 429, last!.body);
  assert.deepEqual([...new Set(asked)], [ALCHEMY]);
  assert.equal((await seat("198.51.100.8")).status, 200, "another caller's seat share is its own");
});

test("every caller's seat reads in 10 s together stop at the seat's total, half of Alchemy's pace for 10 s (KEYED_ROUTE_SHARE), so the route's other reads keep the other half", async () => {
  const pace = L.KEYED_PACE.alchemy;
  assert.ok(pace !== undefined, "Alchemy is a paced company (limits.ts KEYED_PACE)");
  const total = Math.floor(pace.perS * 10 * R.KEYED_ROUTE_SHARE);
  assert.ok(total < 4 * SHARE, "four callers at their share would pass it");
  const { asked, c, seat } = rig();
  const callers = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"];
  const done = new Set<string>();
  let ok = 0;
  for (let i = 0; done.size < callers.length && i < 4 * SHARE + 8; i++) {
    const who = callers[i % callers.length]!;
    if (done.has(who)) continue;
    const a = await seat(who);
    if (a.status === 200) ok++;
    else done.add(who);
    c.t += 8;
  }
  assert.equal(ok, total, `answered ${ok} of the seat's total ${total}`);
  assert.deepEqual([...new Set(asked)], [ALCHEMY]);
});

test("a seat answer's RateLimit-Policy names the seat's own budget (its total and SEAT_SHARE), the route's answers keep the route's", () => {
  const r = createRpc(KEYS, { now: () => DAY_MS, log: () => undefined });
  const policyOf = r.policyOf as (chain: string, mode?: unknown) => string | undefined;
  const pace = L.KEYED_PACE.alchemy;
  assert.ok(pace !== undefined);
  assert.equal(policyOf("robinhood", "alchemy"), `"chain";q=${Math.floor(pace.perS * 10 * R.KEYED_ROUTE_SHARE)};w=10, "client";q=${SHARE};w=10`);
  assert.match(policyOf("robinhood") ?? "", new RegExp(`"client";q=${R.RPC_PAGE_NEED.robinhood};w=10$`));
  assert.equal(policyOf("robinhood", true), policyOf("robinhood"));
});

test("an Alchemy URL under any EVM chain's keyed name is paced and day-capped as the company alchemy (one bucket and one day for both chains, each call counted at 60 CU); RPC_PACE_ALCHEMY and RPC_DAY_ALCHEMY name another plan's; a Solana or other company's URL is not", () => {
  const pace = L.KEYED_PACE.alchemy;
  assert.ok(pace !== undefined && L.KEYED_DAY.alchemy !== undefined && L.KEYED_COST.alchemy !== undefined);
  const p = keyedPaces({ ...KEYS, BASE_RPC_URL: BASE_ALCHEMY, SOLANA_RPC_URL: "https://solana-mainnet.g.alchemy.com/v2/plantedSOLalchemy0key1234567" });
  for (const u of [ALCHEMY, BASE_ALCHEMY]) {
    assert.deepEqual(
      { perS: p[u]?.perS, burst: p[u]?.burst, group: p[u]?.group, day: p[u]?.day, cost: p[u]?.cost },
      { perS: pace.perS, burst: pace.burst, group: "alchemy", day: L.KEYED_DAY.alchemy, cost: 60 },
      u,
    );
  }
  assert.equal(p["https://solana-mainnet.g.alchemy.com/v2/plantedSOLalchemy0key1234567"], undefined, "Solana's Alchemy app is another plan");
  const o = keyedPaces({ ROBINHOOD_RPC_URL: ALCHEMY, RPC_PACE_ALCHEMY: "40,40", RPC_DAY_ALCHEMY: "6000000" });
  assert.deepEqual({ perS: o[ALCHEMY]?.perS, burst: o[ALCHEMY]?.burst, day: o[ALCHEMY]?.day }, { perS: 40, burst: 40, day: 6_000_000 });
  assert.equal(keyedPaces({ ROBINHOOD_RPC_URL: QN })[QN], undefined, "another company under the chain's own name keeps no pace, as before");
});

test("past Alchemy's day (RPC_DAY_ALCHEMY: two calls at 60) the seat answers 503 upstream with nothing sent, so the page reads its keyless providers; ?keyed=only walks on to QuickNode", async () => {
  const { asked, c, seat, keyedOnly } = rig({ ...KEYS, RPC_DAY_ALCHEMY: "120" });
  assert.equal((await seat()).status, 200);
  c.t += 100;
  assert.equal((await seat()).status, 200);
  c.t += 100;
  asked.length = 0;
  const a = await seat();
  assert.equal(a.status, 503, a.body);
  assert.deepEqual(JSON.parse(a.body), { error: { code: "upstream" } });
  assert.deepEqual(asked, [], "the day's third call reached no provider");
  assert.equal((await keyedOnly()).status, 200);
  assert.deepEqual(asked, [QN]);
});

test("one caller's seat reads in a UTC day stop at ALCHEMY_SEAT_DAY: past it 429 naming RETRY_AFTER_MAX_S with no send; another caller is answered; the next UTC day the first is again", async () => {
  const { asked, c, seat } = rig();
  let ok = 0;
  let last;
  for (let i = 0; i < SEAT_DAY + 1; i++) {
    last = await seat();
    if (last.status !== 200) break;
    ok++;
    // inside the share (200 a 10 s) and the pace
    c.t += 50;
  }
  assert.equal(ok, SEAT_DAY, `answered ${ok} of the day's ${SEAT_DAY}`);
  assert.equal(Math.floor(c.t / DAY_MS), Math.floor((c.t - SEAT_DAY * 50) / DAY_MS), "all inside one UTC day");
  assert.equal(last!.status, 429, last!.body);
  assert.deepEqual(JSON.parse(last!.body), { error: { code: "rate_limited" } });
  assert.equal(last!.headers?.["Retry-After"], "75");
  assert.equal(asked.length, SEAT_DAY, "the refused read reached no provider");
  assert.equal((await seat("198.51.100.8")).status, 200, "another caller is answered");
  c.t = Math.ceil(c.t / DAY_MS) * DAY_MS + 1;
  assert.equal((await seat()).status, 200, "a new UTC day");
});

test("a seat read Alchemy did not answer (its 503) gives the caller's seat day back", async () => {
  const { c, seat, mode } = rig();
  mode.down = true;
  for (let i = 0; i < 5; i++) {
    assert.equal((await seat()).status, 503);
    c.t += 2_000;
  }
  mode.down = false;
  let ok = 0;
  for (let i = 0; i < SEAT_DAY + 1; i++) {
    if ((await seat()).status !== 200) break;
    ok++;
    c.t += 50;
  }
  assert.equal(ok, SEAT_DAY, "the five unanswered reads spent none of the day");
});
