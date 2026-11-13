// node --test apps/helper/src/rpc/near-seat.test.ts (card near-quote-under-the-pace): POST /v1/rpc/near?keyed=only is
// the signing page's second NEAR seat, beside dRPC read device-direct. The page trusts a NEAR read only when both seats
// agree byte for byte, so this seat must be another operator: FastNEAR's key alone, never dRPC's or any other company's
// URL and never the public fallback. And one page's busiest 10 s on it, one buy's reads, is answered (RPC_PAGE_NEED).
// Every URL here is made up or a provider's public host with a planted key; no real key.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as rpcModule from "./rpc.ts";
import { createRpc } from "./rpc.ts";

// read off the module, so this file still loads at a base without it and its tests fail on the behaviour (red runs)
const NEED = (rpcModule as unknown as { RPC_PAGE_NEED?: Record<string, number> }).RPC_PAGE_NEED ?? {};

const FASTNEAR = "https://rpc.mainnet.fastnear.com?apiKey=plantedNEARfastnear0key123456789";
/** dRPC's keyless NEAR host, and its keyed form (lb.drpc.live/<network>/<key>, drpc.org/docs/gettingstarted/firstrequest). */
const DRPC_PUBLIC = "https://near.drpc.org";
const DRPC_KEYED = "https://lb.drpc.live/near/plantedNEARdrpc000key123456789";
/** Another company's keyed URL under the existing name. */
const OTHER_KEYED = "https://near.other-operator.test/plantedNEARother0key123456789";
const JSON_T = "application/json";
const QUERY = { jsonrpc: "2.0", id: 7, method: "query", params: { request_type: "view_account", finality: "final", account_id: "near" } };
const FAST_BODY = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { amount: "1", block_height: 1 } });

/** A rig on a planted clock (each sleep moves it), FastNEAR answering or down, every other URL answering. */
function rig(env: Record<string, string>, fastnearDown: boolean) {
  const asked: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    asked.push(url);
    if (url === FASTNEAR) return fastnearDown ? new Response("down", { status: 503 }) : new Response(FAST_BODY, { status: 200, headers: { "content-type": JSON_T } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { from: new URL(url).host } }), { status: 200, headers: { "content-type": JSON_T } });
  };
  const c = { t: 1_800_000_000_000 };
  const r = createRpc(env, { fetch: fetch as never, now: () => c.t, sleep: async (ms: number) => void (c.t += ms), log: () => undefined });
  const keyedOnly = (body: unknown, client = "198.51.100.7") => r.handle("near", JSON_T, JSON.stringify(body), client, false, true);
  return { r, asked, c, keyedOnly };
}

for (const [what, b] of [["dRPC's keyless host", DRPC_PUBLIC], ["dRPC's keyed host", DRPC_KEYED]] as const) {
  test(`T1: FastNEAR down, ${what} set as NEAR_RPC_URL_B: ?keyed=only answers 503 upstream and never sends to dRPC`, async () => {
    const { asked, keyedOnly } = rig({ NEAR_RPC_URL_FASTNEAR: FASTNEAR, NEAR_RPC_URL_B: b }, true);
    const a = await keyedOnly(QUERY);
    assert.equal(a.status, 503, a.body);
    assert.deepEqual(JSON.parse(a.body), { error: { code: "upstream" } });
    assert.ok(!asked.some((u) => /drpc\.(org|live)/.test(new URL(u).host)), `asked dRPC: ${asked.join(" ")}`);
    assert.ok(asked.every((u) => u === FASTNEAR), `asked only FastNEAR: ${asked.join(" ")}`);
  });
}

test("T1: FastNEAR down, another company's keyed URL set as NEAR_RPC_URL: ?keyed=only answers 503 and never sends there", async () => {
  const { asked, keyedOnly } = rig({ NEAR_RPC_URL_FASTNEAR: FASTNEAR, NEAR_RPC_URL: OTHER_KEYED, NEAR_RPC_URL_B: DRPC_KEYED }, true);
  const a = await keyedOnly(QUERY);
  assert.equal(a.status, 503, a.body);
  assert.ok(asked.every((u) => u === FASTNEAR), `asked only FastNEAR: ${asked.join(" ")}`);
});

test("T1: no FastNEAR URL set, only dRPC's keyed one: ?keyed=only answers 503 and fetches nothing", async () => {
  const { asked, keyedOnly } = rig({ NEAR_RPC_URL_B: DRPC_KEYED }, true);
  const a = await keyedOnly(QUERY);
  assert.equal(a.status, 503, a.body);
  assert.deepEqual(asked, []);
});

test("T2: FastNEAR answering: ?keyed=only answers 200 with FastNEAR's body, sent to the fastnear.com URL alone", async () => {
  const { asked, keyedOnly } = rig({ NEAR_RPC_URL_FASTNEAR: FASTNEAR, NEAR_RPC_URL_B: DRPC_KEYED }, false);
  const a = await keyedOnly(QUERY);
  assert.equal(a.status, 200, a.body);
  assert.equal(a.body, FAST_BODY);
  assert.deepEqual(asked, [FASTNEAR]);
});

test("the plain near route (no ?keyed=only) still walks its list past a FastNEAR that is down, as before", async () => {
  const { asked, r } = rig({ NEAR_RPC_URL_FASTNEAR: FASTNEAR, NEAR_RPC_URL_B: DRPC_KEYED }, true);
  const a = await r.handle("near", JSON_T, JSON.stringify(QUERY), "198.51.100.7");
  assert.equal(a.status, 200, a.body);
  assert.deepEqual(asked, [FASTNEAR, DRPC_KEYED]);
});

test("T3: one page's busiest 10 s on the near seat: 30 reads from one address answered, the 31st refused 429 rate_limited", async () => {
  const { asked, c, keyedOnly } = rig({ NEAR_RPC_URL_FASTNEAR: FASTNEAR }, false);
  // one fixed 10 s share window (limits.ts upstreamBudget: floor(t / 10 s)), the reads 300 ms apart: 31 reads in 9 s,
  // so FastNEAR's pace (limits.ts KEYED_PACE fastnear, 5 a second, 5 at once) always has room and the share alone binds
  const statuses: number[] = [];
  let last;
  for (let i = 0; i < 31; i++) {
    last = await keyedOnly({ ...QUERY, id: i + 1 });
    statuses.push(last.status);
    c.t += 300;
  }
  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200), `the page's 30: ${statuses.join(",")}`);
  assert.equal(statuses[30], 429, "the 31st is the caller's own 429");
  assert.deepEqual(JSON.parse(last!.body), { error: { code: "rate_limited" } });
  assert.equal(asked.length, 30, "the 31st reached no provider");
  assert.ok(asked.every((u) => u === FASTNEAR));
  assert.equal(NEED.near, 30, "RPC_PAGE_NEED names near's share");
});

test("T4: one caller's ?keyed=only NEAR reads in a UTC day stop at NEAR_SEAT_DAY: past it 429 rate_limited naming RETRY_AFTER_MAX_S with no send; another caller is answered; the next UTC day the first is again (review P3-2)", async () => {
  const DAY = (rpcModule as unknown as { NEAR_SEAT_DAY?: number }).NEAR_SEAT_DAY ?? 15_000;
  const { asked, c, keyedOnly } = rig({ NEAR_RPC_URL_FASTNEAR: FASTNEAR }, false);
  // the day's start, then reads well inside the share (5 every 10 s, 2 s apart) and FastNEAR's pace
  c.t = Math.ceil(c.t / 86_400_000) * 86_400_000;
  let ok = 0;
  let last;
  for (let i = 0; i < DAY + 1; i++) {
    last = await keyedOnly({ ...QUERY, id: i + 1 });
    if (last.status !== 200) break;
    ok++;
    c.t += 2_000;
  }
  assert.equal(ok, DAY, `answered ${ok} of the day's ${DAY}`);
  assert.ok(c.t < Math.ceil((c.t + 1) / 86_400_000) * 86_400_000, "all inside one UTC day");
  assert.equal(last!.status, 429, last!.body);
  assert.deepEqual(JSON.parse(last!.body), { error: { code: "rate_limited" } });
  assert.equal(last!.headers?.["Retry-After"], "75");
  assert.equal(asked.length, DAY, "the refused read reached no provider");
  assert.equal((await keyedOnly(QUERY, "198.51.100.8")).status, 200, "another caller is answered");
  c.t = Math.ceil(c.t / 86_400_000) * 86_400_000 + 1;
  assert.equal((await keyedOnly(QUERY)).status, 200, "a new UTC day");
});

test("T5: FastNEAR's keyless URL set under the keyed name (no key in it): ?keyed=only answers 503 upstream and sends nothing (review P3-5)", async () => {
  const { asked, keyedOnly } = rig({ NEAR_RPC_URL_FASTNEAR: "https://rpc.mainnet.fastnear.com", NEAR_RPC_URL_B: DRPC_KEYED }, false);
  const a = await keyedOnly(QUERY);
  assert.equal(a.status, 503, a.body);
  assert.deepEqual(asked, []);
});
