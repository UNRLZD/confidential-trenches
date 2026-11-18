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

test("T3: one page's busiest 10 s on the near seat: 90 reads from one address answered, the 91st refused 429 rate_limited", async () => {
  const { asked, c, keyedOnly } = rig({ NEAR_RPC_URL_FASTNEAR: FASTNEAR }, false);
  // one fixed 10 s share window (limits.ts upstreamBudget: floor(t / 10 s)), the reads 100 ms apart: 91 reads in 9.1 s,
  // so FastNEAR's pace (limits.ts KEYED_PACE fastnear, 60 a second, 120 at once) always has room and the share alone binds
  c.t = Math.ceil(c.t / 10_000) * 10_000;
  const statuses: number[] = [];
  let last;
  for (let i = 0; i < 91; i++) {
    last = await keyedOnly({ ...QUERY, id: i + 1 });
    statuses.push(last.status);
    c.t += 100;
  }
  assert.deepEqual(statuses.slice(0, 90), Array(90).fill(200), `the page's 90: ${statuses.join(",")}`);
  assert.equal(statuses[90], 429, "the 91st is the caller's own 429");
  assert.deepEqual(JSON.parse(last!.body), { error: { code: "rate_limited" } });
  assert.equal(asked.length, 90, "the 91st reached no provider");
  assert.ok(asked.every((u) => u === FASTNEAR));
  assert.equal(NEED.near, 90, "RPC_PAGE_NEED names near's share");
});

test("card near-seat-pace-fits-one-quote: one NEAR quote's reads at its block (18 and 29, the app lead's count 18 Nov 02:39Z) asked at once by one caller on the seat are all answered with no wait, and a second caller's 29 at the same instant too", async () => {
  for (const n of [18, 29]) {
    const { asked, c, keyedOnly } = rig({ NEAR_RPC_URL_FASTNEAR: FASTNEAR }, false);
    // a whole share window ahead, so both callers' reads fall in one window
    c.t = Math.ceil(c.t / 10_000) * 10_000 + 1_000;
    const t0 = c.t;
    const quote = (client: string) => Promise.all(Array.from({ length: n }, (_, i) => keyedOnly({ ...QUERY, id: i + 1 }, client)));
    const [one, two] = await Promise.all([quote("198.51.100.7"), quote("203.0.113.9")]);
    for (const [who, as] of [["the first caller", one], ["the second caller", two]] as const)
      assert.deepEqual(as.map((a) => a.status), Array(n).fill(200), `${who}'s quote of ${n}: ${as.map((a) => a.status).join(",")}`);
    assert.equal(c.t, t0, `a quote of ${n} reads waited ${c.t - t0} ms on the helper's pace`);
    assert.equal(asked.length, 2 * n);
    assert.ok(asked.every((u) => u === FASTNEAR));
  }
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

/** A rig whose FastNEAR answers as `mode.now` says: 200, its 503, or its 429 naming 60 s. */
function modeRig(deps: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const mode = { now: "ok" as "ok" | "down" | "busy" };
  const fetch = async (url: string): Promise<Response> => {
    asked.push(url);
    if (mode.now === "down") return new Response("down", { status: 503 });
    if (mode.now === "busy") return new Response("busy", { status: 429, headers: { "retry-after": "60" } });
    return new Response(FAST_BODY, { status: 200, headers: { "content-type": JSON_T } });
  };
  const c = { t: Math.ceil(1_800_000_000_000 / 86_400_000) * 86_400_000 };
  const r = createRpc({ NEAR_RPC_URL_FASTNEAR: FASTNEAR }, { ...deps, fetch: fetch as never, now: () => c.t, sleep: async (ms: number) => void (c.t += ms), log: () => undefined });
  const keyedOnly = (body: unknown, client = "198.51.100.7") => r.handle("near", JSON_T, JSON.stringify(body), client, false, true);
  /** reads 2 s apart (inside the share and FastNEAR's pace) until one is refused; how many were answered */
  const drain = async (): Promise<number> => {
    for (let ok = 0; ; ok++) {
      const a = await keyedOnly(QUERY);
      if (a.status !== 200) return ok;
      c.t += 2_000;
    }
  };
  return { asked, mode, c, keyedOnly, drain };
}
const DAY_OF = () => (rpcModule as unknown as { NEAR_SEAT_DAY?: number }).NEAR_SEAT_DAY ?? 15_000;

test("T6: the seat's day map holds at most its caller count (LIMIT_CLIENTS): a new caller past it is refused 429 naming RETRY_AFTER_MAX_S with no send, so its page reads its spare; a caller already in it is answered (review P3-2 of 997ce7a7f)", async () => {
  const { asked, keyedOnly } = modeRig({ seatClients: 2 });
  assert.equal((await keyedOnly(QUERY, "198.51.100.1")).status, 200);
  assert.equal((await keyedOnly(QUERY, "198.51.100.2")).status, 200);
  const third = await keyedOnly(QUERY, "198.51.100.3");
  assert.equal(third.status, 429, third.body);
  assert.equal(third.headers?.["Retry-After"], "75");
  assert.equal(asked.length, 2, "the third caller's read reached no provider");
  assert.equal((await keyedOnly(QUERY, "198.51.100.1")).status, 200, "a caller in the map is still answered");
});

test("T7: a read the caller's share refuses spends none of its day: 5 share refusals in one 10 s, then the day still answers NEAR_SEAT_DAY reads (review P3-3 of 997ce7a7f)", async () => {
  const { c, keyedOnly, drain } = modeRig();
  const statuses: number[] = [];
  // the share's reads and 5 more inside one fixed 10 s window (RPC_PAGE_NEED near, 90: 95 reads 50 ms apart, 4.75 s)
  const share = NEED.near!;
  for (let i = 0; i < share + 5; i++) statuses.push((await keyedOnly({ ...QUERY, id: i + 1 })).status), (c.t += 50);
  assert.deepEqual(statuses, [...Array(share).fill(200), ...Array(5).fill(429)], statuses.join(","));
  c.t += 10_000;
  assert.equal(share + (await drain()), DAY_OF(), `the day counts the ${share} answered, never the 5 refused`);
});

test("T8: a read no provider answered (FastNEAR's 503, or its 429 held past the wait) gives its day back (review P3-3 of 997ce7a7f)", async () => {
  const { asked, mode, c, keyedOnly, drain } = modeRig();
  mode.now = "down";
  for (let i = 0; i < 3; i++) assert.equal((await keyedOnly(QUERY)).status, 503), (c.t += 2_000);
  mode.now = "busy";
  const held = await keyedOnly(QUERY);
  assert.equal(held.status, 429, held.body);
  c.t += 61_000;
  mode.now = "ok";
  const sent = asked.length;
  assert.equal(await drain(), DAY_OF(), "the 4 unanswered reads spent none of the day");
  assert.equal(asked.length - sent, DAY_OF());
});

test("card near-seat-pace-fits-one-quote: a 429 FastNEAR answers the seat reaches the helper's log line, naming the chain, the company and its seconds, so a pace set over FastNEAR's published rate shows in the log", async () => {
  const lines: string[] = [];
  let busy = true;
  const fetch = async (): Promise<Response> =>
    busy ? new Response("busy", { status: 429, headers: { "retry-after": "60" } }) : new Response(FAST_BODY, { status: 200, headers: { "content-type": JSON_T } });
  const c = { t: 1_800_000_000_000 };
  const r = createRpc({ NEAR_RPC_URL_FASTNEAR: FASTNEAR }, { fetch: fetch as never, now: () => c.t, sleep: async (ms: number) => void (c.t += ms), log: (l: string) => void lines.push(l) });
  const a = await r.handle("near", JSON_T, JSON.stringify(QUERY), "198.51.100.7", false, true);
  assert.equal(a.status, 429, a.body);
  assert.ok(lines.some((l) => /^rpc hold near fastnear\.com caller 60 s/.test(l)), lines.join("\n"));
  assert.ok(lines.every((l) => !l.includes("plantedNEARfastnear0key")), "the key never in a log line");
  busy = false;
});
