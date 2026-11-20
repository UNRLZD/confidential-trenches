// A buy tapped while the device prepares the chain's spend waits for it inside the request (card
// taps-wait-inside-the-page; owner 13 Nov 07:53Z: "why can I not spend my own deposited money"). At e1995d679 a tap
// before the first prepared spend reached the buy's flow at once, which found no ready proof and answered not_funded,
// or moved Cash for money the pool already held (cashFirst read tap_max 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolKinds, type PoolKindsDeps } from "../src/pool-kinds.ts";
import { tapPrepared, TAP_PREPARE_MS } from "../src/tap-prepare.ts";
import type { PoolAsk } from "../src/rules/pool.ts";
import type { CashToPoolDeps } from "../src/cash-to-pool.ts";
import { READ_WAIT_TOTAL_MS } from "../src/read-waits.ts";

const SOL_TOKEN = "So11111111111111111111111111111111111111112";
const ctx = (id = "r1") => ({ id, sha: "00", progress: () => {} });
const BUY = { chain: "solana", token: SOL_TOKEN, amount: "0.4", slippage_bps: 100 };

async function settle(a: unknown): Promise<unknown> {
  const r = a as { after?: Promise<unknown>; answer?: () => unknown };
  if (r.after === undefined) return { ...(a as object) };
  await r.after;
  return { ...(r.answer!() as object) };
}

/** A page whose pool holds 0.5 SOL in one note, proved only once its pass ends: `ready` is what the buy's pick reads. */
function page() {
  let ready = 0n;
  let passEnds!: () => void;
  const pass = new Promise<void>((r) => (passEnds = () => ((ready = 500_000_000n), r())));
  const flows: bigint[] = [];
  const moved: bigint[] = [];
  const flow = (ask: PoolAsk) => (flows.push(ask.amount), ask.amount <= ready ? { running: true as const, after: Promise.resolve(), answer: () => ({ result: { stage: "filled" as const, txs: [] } }) } : { error: "not_funded" as const });
  const cash: CashToPoolDeps = {
    any: async () => true,
    tapMax: async () => ready,
    need: async (_c, short) => (moved.push(short), "cash/solana/0"),
    moved: async () => ({ landed: true }),
    proving: async () => false,
    wait: async () => {},
    now: () => 0,
  };
  const deps: PoolKindsDeps = { pinned: () => true, rpcs: () => null, flow: flow as PoolKindsDeps["flow"] };
  return { deps, cash, flows, moved, pass, passEnds, preparing: () => ready === 0n };
}

test("a buy tapped while its chain's spend is prepared waits for the pass inside the request, then fills, Cash untouched", async () => {
  const p = page();
  let asked = 0;
  const k = poolKinds({ ...p.deps, cash: () => p.cash, prepared: async (chain) => (asked++, assert.equal(chain, "solana"), tapPrepared({ preparing: async () => p.preparing(), pass: () => p.pass, now: () => 0, wait: () => new Promise(() => {}) })) });
  const got = k["pool.buy"](BUY, ctx());
  // the flow is not reached before the pass ends
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(p.flows, []);
  p.passEnds();
  assert.deepEqual(await settle(got), { result: { stage: "filled", txs: [] } });
  assert.equal(asked, 1);
  assert.deepEqual(p.flows, [400_000_000n]);
  // the money the pool held was spent: nothing moved from Cash
  assert.deepEqual(p.moved, []);
});

test("with no `prepared` the tap goes to the flow at once, as before the card", async () => {
  const p = page();
  const k = poolKinds(p.deps);
  assert.deepEqual(await settle(k["pool.buy"](BUY, ctx())), { error: "not_funded" });
});

test("the wait is bounded: a pass that never ends lets the tap go at TAP_PREPARE_MS, inside the tap's one bound", async () => {
  assert.ok(TAP_PREPARE_MS > 0 && TAP_PREPARE_MS < READ_WAIT_TOTAL_MS, "the prepare wait leaves the buy room in the tap's one bound");
  let clock = 0;
  const waits: number[] = [];
  const passes: number[] = [];
  const done = await tapPrepared({
    preparing: async () => true,
    // a pass that never ends
    pass: () => (passes.push(clock), new Promise(() => {})),
    now: () => clock,
    wait: (ms) => (waits.push(ms), (clock += ms), Promise.resolve()),
  }).then(() => clock);
  assert.equal(done, TAP_PREPARE_MS);
  assert.deepEqual(waits, [TAP_PREPARE_MS]);
  assert.equal(passes.length, 1);
});

test("a pass that ends at once while the chain still reads as preparing never spins: each next look waits a step, and the bound ends it", async () => {
  let clock = 0;
  let looks = 0;
  await tapPrepared({
    preparing: async () => (looks++, true),
    pass: () => Promise.resolve(),
    now: () => clock,
    wait: (ms) => ((clock += ms), Promise.resolve()),
  });
  assert.ok(clock >= TAP_PREPARE_MS);
  assert.ok(looks <= 2 * (TAP_PREPARE_MS / 250) + 2, `looks ${looks}`);
});

test("nothing being prepared: no pass is asked and no time passes", async () => {
  let passes = 0;
  let clock = 0;
  await tapPrepared({ preparing: async () => false, pass: () => (passes++, Promise.resolve()), now: () => clock, wait: (ms) => ((clock += ms), Promise.resolve()) });
  assert.equal(passes, 0);
  assert.equal(clock, 0);
});

test("a sign out ends the wait at once, and the tap never reaches the flow after it", async () => {
  const p = page();
  const out = new AbortController();
  const k = poolKinds({ ...p.deps, stop: () => out.signal, prepared: () => tapPrepared({ preparing: async () => p.preparing(), pass: () => p.pass, now: () => 0, wait: () => new Promise(() => {}), signal: out.signal }) });
  const got = k["pool.buy"](BUY, ctx());
  out.abort();
  assert.deepEqual(await settle(got), { error: "failed" });
  assert.deepEqual(p.flows, []);
});

test("two taps waiting on one note's pass ask the queue's one pass, never a second spend prepared beside it; each then runs the buy, whose pick and take hold one note to one tap", async () => {
  const p = page();
  let passes = 0;
  // the page's pass in flight, joined by every waiting tap (pool-testnet.ts passing): one prover run for both
  let inFlight: Promise<void> | null = null;
  const pass = () => (inFlight ??= (passes++, p.pass));
  // the flow as the buy's pick holds a note: the first run claims it, the second finds it held (pool-buy.ts claimed)
  let claimed = false;
  const flow = (ask: PoolAsk) => (ask.amount <= 500_000_000n && !claimed ? ((claimed = true), { running: true as const, after: Promise.resolve(), answer: () => ({ result: { stage: "filled" as const, txs: [] } }) }) : { error: "not_funded" as const });
  const k = poolKinds({ ...p.deps, flow: flow as PoolKindsDeps["flow"], prepared: () => tapPrepared({ preparing: async () => p.preparing(), pass, now: () => 0, wait: () => new Promise(() => {}) }) });
  const a = k["pool.buy"](BUY, ctx("a"));
  const b = k["pool.buy"](BUY, ctx("b"));
  await new Promise((r) => setTimeout(r, 5));
  p.passEnds();
  const got = [await settle(a), await settle(b)];
  assert.equal(passes, 1);
  assert.deepEqual(got.filter((x) => "result" in (x as object)).length, 1);
  assert.deepEqual(got.filter((x) => (x as { error?: string }).error === "not_funded").length, 1);
});

test("a withdraw is never held by the wait: it proves its own parts from the notes (pool-withdraw.ts)", async () => {
  const p = page();
  let asked = 0;
  const flow = () => ({ error: "not_allowed" as const });
  const k = poolKinds({ ...p.deps, flow: flow as unknown as PoolKindsDeps["flow"], prepared: async () => void asked++ });
  await settle(k["pool.withdraw"]({ chain: "solana" }, ctx()));
  assert.equal(asked, 0);
});
