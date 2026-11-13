// The page's NEAR pair with the helper's FastNEAR seat slow, busy or down (review P2-1 of e6c66cce3): dRPC answers at
// once, the seat's final comes seconds later (its busy retry, or the keyless spare past its tries or its deadline), and
// the kit's nearFinal re-asks the lower final once, so a late answer is never read as one provider ahead; a seat that
// fell to its spare stays down SEAT_DOWN_MS, so a trade's next reads go to the spare at once. A NEAR buy after its
// payout fills with the seat at 429 throughout, and within the helper's per-caller share with the seat up. All on the
// test clock, on a fake chain that moves a block every 600 ms of it; nothing real.
//   node --test test/near-seat-down.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { onTestClock } from "../../kit/test/test-clock.ts";
import { NEAR_NETWORKS, type NearRpc } from "../../kit/src/near/networks.ts";
import { nearFinal, RheaQuoteRefused } from "../../kit/src/near/rhea.ts";
import type { NearSwapCall } from "../../kit/src/trade/near/swap.ts";
import type { SignedNearSwapDelegate } from "../../wallet/src/near/swap-delegate.ts";
import type * as Pace from "../../wallet/src/pace.ts";
import { nearReads } from "../src/near-buy.ts";
import { runNearBuy, type NearBuyDeps, type NearBuyStep } from "../src/near-trade.ts";
import { AMOUNT, chain, TOKEN, USDC } from "./near-chain-fake.ts";

const NET = NEAR_NETWORKS.mainnet;
const W = "0".repeat(64);
// one copy of the pace module per test: its paces and its seats taken for down are its own
let copies = 0;
const fresh = async () => (await import(new URL(`../../wallet/src/pace.ts?seat-down=${++copies}`, import.meta.url).href)) as typeof Pace;

type Seat = "ok" | "deadline" | "busy-once-3s" | "busy" | "503" | "day";
/** The seat's answer by mode: hangs to its deadline, 429 once with Retry-After 3, 429 Retry-After 1 always, or 503. */
function seatAnswer(mode: Seat, nth: number, signal: AbortSignal | null | undefined): Response | Promise<Response> | null {
  if (mode === "deadline") return new Promise<Response>((_, no) => signal!.addEventListener("abort", () => no(signal!.reason), { once: true }));
  if (mode === "busy-once-3s" && nth === 1) return new Response("{}", { status: 429, headers: { "retry-after": "3" } });
  if (mode === "busy") return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
  if (mode === "503") return new Response(JSON.stringify({ error: { code: "upstream" } }), { status: 503 });
  // the helper's day cap for this caller (apps/helper/src/rpc/rpc.ts NEAR_SEAT_DAY): its 429 names RETRY_AFTER_MAX_S
  if (mode === "day") return new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429, headers: { "retry-after": "75" } });
  return null;
}

/** A fake chain and the page's pair on it: the seat by `mode`, dRPC and the keyless spare answering; every ask counted. */
async function pairOn(mode: Seat) {
  const k = chain();
  k.c.exists = true;
  const t0 = performance.now();
  const H0 = k.c.height;
  const at = () => {
    while (k.c.height < H0 + Math.floor((performance.now() - t0) / 600)) k.tick();
  };
  const asked = { seat: 0, drpc: 0, keyless: 0 };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    at();
    const params = JSON.parse(String(init!.body)).params as Record<string, unknown>;
    if (url === NET.seat) {
      const busy = seatAnswer(mode, ++asked.seat, init?.signal);
      if (busy !== null) return busy;
    } else if (url === NET.drpc) asked.drpc++;
    else asked.keyless++;
    return new Response(JSON.stringify(k.answer(params)), { status: 200 });
  }) as typeof fetch;
  const P = await fresh();
  const pair = [P.nearSeatRpc("mainnet", fetchFn), P.pacedNearRpc(NET.drpc, fetchFn)] as readonly [NearRpc, NearRpc];
  return { k, at, asked, pair, P, t0 };
}

for (const mode of ["deadline", "busy-once-3s", "busy", "503"] as const) {
  test(`nearFinal with the seat ${mode}: the late final is not read as one provider ahead; one final of both providers`, { timeout: 120_000 }, () => onTestClock(async () => {
    const { pair, asked } = await pairOn(mode);
    const f = await nearFinal("mainnet", pair).catch((e: unknown) => (e instanceof RheaQuoteRefused ? `${e.code}: ${e.message}` : String(e)));
    assert.equal(typeof f, "object", `${mode}: ${String(f)} ${JSON.stringify(asked)}`);
    // dRPC re-asked once at most: the lower side's final once more
    assert.ok(asked.drpc <= 2, JSON.stringify(asked));
  }));
}

test("a seat that fell to its spare stays down SEAT_DOWN_MS: the next reads go to the spare at once; then the seat is asked again; a sign out (seatsUp) forgets it", { timeout: 120_000 }, () => onTestClock(async () => {
  const { pair, asked, P } = await pairOn("503");
  const view = { request_type: "view_account", finality: "final", account_id: W };
  await pair[0].query(view);
  assert.deepEqual([asked.seat, asked.keyless], [1, 1]);
  const t = performance.now();
  for (let i = 0; i < 3; i++) await pair[0].query(view);
  await (await pair[0].reserve!()).query(view);
  assert.deepEqual([asked.seat, asked.keyless], [1, 5], "down: the spare alone, the reserved turn too");
  await new Promise((r) => setTimeout(r, Math.max(0, P.SEAT_DOWN_MS - (performance.now() - t)) + 1));
  await pair[0].query(view);
  assert.deepEqual([asked.seat, asked.keyless], [2, 6], "past SEAT_DOWN_MS the seat is asked again (and is down again)");
  P.seatsUp();
  await pair[0].query(view);
  assert.equal(asked.seat, 3, "after seatsUp the seat is asked at once");
  // a 4xx is no seat down: it shows, and nothing is remembered
  assert.equal(P.SEAT_DOWN_MS, 10_000);
}));

test("the helper's day cap (429 naming 75 s): the seat is asked once, the spare answers at once, and the seat stays down the 75 s it named (SEAT_DOWN_MAX_MS), not SEAT_DOWN_MS", { timeout: 300_000 }, () => onTestClock(async () => {
  const { pair, asked, P } = await pairOn("day");
  const view = { request_type: "view_account", finality: "final", account_id: W };
  const t = performance.now();
  await pair[0].query(view);
  assert.deepEqual([asked.seat, asked.keyless], [1, 1], "no wait on a 75 s busy: the spare at once");
  assert.ok(performance.now() - t < P.NEAR_BUSY_WAIT_MAX_MS, "answered before any busy wait");
  await new Promise((r) => setTimeout(r, P.SEAT_DOWN_MS + 1_000));
  await pair[0].query(view);
  assert.equal(asked.seat, 1, "still down past SEAT_DOWN_MS");
  await new Promise((r) => setTimeout(r, P.SEAT_DOWN_MAX_MS - P.SEAT_DOWN_MS));
  await pair[0].query(view);
  assert.equal(asked.seat, 2, "asked again once the 75 s named are over");
}));

/** One NEAR buy after its payout on the page's reads (nearReads) and pair, the helper landing what it is sent. */
async function buy(mode: Seat | "share", poolPages = 0) {
  let win = -1, used = 0, refused = 0;
  const sent: number[] = [];
  const k = chain();
  const t0 = performance.now();
  const H0 = k.c.height;
  const at = () => {
    while (k.c.height < H0 + Math.floor((performance.now() - t0) / 600)) k.tick();
  };
  const asked = { seat: 0, keyless: 0 };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    at();
    const params = JSON.parse(String(init!.body)).params as Record<string, unknown>;
    if (url === NET.seat) {
      asked.seat++;
      sent.push(performance.now() - t0);
      if (mode === "share") {
        // the helper's per-caller share: RPC_PAGE_NEED near per fixed 10 s window, past it 429 with the seconds left
        const t = performance.now() - t0;
        const w = Math.floor(t / 10_000);
        if (w !== win) (win = w), (used = 0);
        if (++used > 30) return refused++, new Response("{}", { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(((w + 1) * 10_000 - t) / 1000))) } });
      } else {
        const busy = seatAnswer(mode, asked.seat, init?.signal);
        if (busy !== null) return busy;
      }
    } else if (url !== NET.drpc) asked.keyless++;
    return new Response(JSON.stringify(k.answer(params)), { status: 200 });
  }) as typeof fetch;
  const P = await fresh();
  const pair = [P.nearSeatRpc("mainnet", fetchFn), P.pacedNearRpc(NET.drpc, fetchFn)] as readonly [NearRpc, NearRpc];
  const page = { network: "mainnet" as const, rpcs: () => pair, pools: async () => [9, 4512] };
  const log: string[] = [];
  const deps: NearBuyDeps = {
    network: "mainnet",
    ...nearReads(page),
    begin: async (ask) => ({ ask, w: { id: W, l: 1n, j: 0 }, txs: [] }),
    progress: async () => {},
    payout: async () => ({ kind: "landed", tx: null }),
    helper: async (body) => {
      at();
      const n = body.signed_delegates.length;
      if (n === 0) return (k.c.exists = true), { ok: true, tx_hashes: ["11111111111111111111111111111111"] };
      const method = JSON.parse(atob(body.signed_delegates[0]!)).method as string;
      if (method === "storage_deposit") k.later(() => (k.c.reg.add(TOKEN), (k.c.nonce += 1)));
      else k.later(() => (k.c.bal.set(USDC, 0n), k.c.bal.set(TOKEN, BigInt(body.trade.venue_out)), (k.c.nonce += n)));
      return { ok: true, tx_hashes: body.signed_delegates.map(() => "11111111111111111111111111111111") };
    },
    sign: (given: readonly NearSwapCall[], _r, _q, s) =>
      given.map((call, i): SignedNearSwapDelegate => ({
        signed_delegate: btoa(JSON.stringify({ method: call.actions[0].FunctionCall.method_name })),
        sender_id: call.sender_id,
        receiver_id: call.receiver_id,
        method_name: call.actions[0].FunctionCall.method_name,
        nonce: s.nonce + 1n + BigInt(i),
        max_block_height: BigInt(s.height) + 120n,
        public_key: "ed25519:x",
      })),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (s: NearBuyStep, outcome: string) => void log.push(`${Math.round((performance.now() - t0) / 1000)}s ${s}: ${outcome}`),
  };
  // the session's first buy reads Rhea's pool list first, its pages on both providers at once (near-pools.ts)
  await Promise.all(Array.from({ length: poolPages }, () => pair[0].query({ request_type: "view_account", finality: "final", account_id: W })));
  const a = await runNearBuy(deps, { token: TOKEN, amount: AMOUNT, slippageBps: 1000 });
  // the most seat asks in any 10 s
  const most = Math.max(0, ...sent.map((t) => sent.filter((u) => u >= t && u < t + 10_000).length));
  return { a, log, usdcOnW: k.c.bal.get(USDC), ms: Math.round(performance.now() - t0), refused, asked, most };
}

test("a NEAR buy after its payout with the helper's seat at 429 throughout fills (the spare, the seat asked again each SEAT_DOWN_MS)", { timeout: 300_000 }, () => onTestClock(async () => {
  const r = await buy("busy");
  console.log("seat busy:", r.ms, "ms", JSON.stringify(r.asked), JSON.stringify(r.log));
  assert.ok("result" in r.a && r.a.result.stage === "filled", JSON.stringify(r.a) + JSON.stringify(r.log));
  assert.equal(r.usdcOnW, 0n);
}));

test("a session's first NEAR buy with the seat up at the helper's per-caller share (30 a 10 s window): its one 429 is waited out on the seat, never the spare, and the buy fills (pace.ts PACE.seat's numbers)", { timeout: 120_000 }, () => onTestClock(async () => {
  const r = await buy("share", 6);
  console.log("share:", r.ms, "ms", "refused", r.refused, "most in 10 s", r.most, JSON.stringify(r.asked));
  assert.ok("result" in r.a && r.a.result.stage === "filled", JSON.stringify(r.a));
  assert.ok(r.refused <= 1, `the helper refused ${r.refused} of ${r.asked.seat}`);
  assert.equal(r.asked.keyless, 0, "a share's 429 waited out, the seat never taken for down");
}));
