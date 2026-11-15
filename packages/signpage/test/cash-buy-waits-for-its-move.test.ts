// A buy from Cash swaps once its money lands, however long the move takes (card cash-buy-waits-for-its-move). The
// owner's buy 2 of 15 Nov moved all of Cash into the Solana pool and never swapped: the tap's wait was a fixed 180 s
// from the tap (CASH_MOVE_WAIT_MS), the move took about 117 s from quote to pool deposit (quote 15:18:32Z, vault payout
// 15:18:44Z, 1Click delivered 15:20:22Z, deposits 15:20:27Z and 15:20:29Z), and the 63 s left did not cover the notes'
// landing and proofs: the pool buy answered not_funded and sent nothing. Now the wait follows the move to its landing
// (every part in the pool or stopped) and then the chain's landing notes and their proofs; a real stop ends it at once.
// The real cashMover and cashFirst on one simulated clock, moved by their waits (each a poll's CASH_MOVE_POLL_MS);
// nothing here imports what the base lacks, so the same file runs red at 9cf75cbda.
//   node --test test/cash-buy-waits-for-its-move.test.ts      (from packages/signpage)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolAsk } from "../src/rules/pool.ts";
import type { HostRefusal, KindContext, Running } from "../src/api.ts";
import { cashFirst, cashMover, provingOn, type CashMoverDeps, type CashToPoolDeps, type MoveFollow, type MoveOpRecord } from "../src/cash-to-pool.ts";
import type { PoolChain } from "../../kit/src/signpage/messages.ts";
import { traceTo } from "../src/trace.ts";

const BOUND = { timeout: 10_000 };
const S = 1_000;
const PRICE = { price: "8000000000", expo: -8 }; // SOL at 80 USD
const ADDRESS = "a".repeat(64);
const TOKEN = "So11111111111111111111111111111111111111112";
const SWAP_TX = "3PQYp7SEuisBKEPBMtPkVNFwkAexB3FcKb2F8ari1cWEQ6yHXWNVv8Xx1avEUqXyKKfcD3fVhJJgGKNUd8UBdZCf";
const ask = (amount: bigint, chain: PoolChain = "solana"): PoolAsk => ({ kind: "pool.buy", chain, token: TOKEN, amount, slippageBps: 100, decimals: 6 });

/** A move's timeline, in ms from the tap: the vault's payout, the follow's first in_pool (or its stop), and when the
 *  landed notes' proofs make one tap spend the ask. */
type Timeline = { payout: number; inPool?: number; stop?: { at: number; stage: string }; proved: number; deadline?: number };

type Line = { op: string; step: string; stage?: string; error?: string; tx?: string; move?: string };

/** The page: the real mover and the real cashFirst on one clock, which each one's wait moves (the mover's follow polls
 *  while the tap waits, so the clock runs up to twice a poll per round). */
/** `chain`: the pool the buy is on (Base and Robinhood: the page sizes the move, `short`); `proving`: the page's own read
 *  of the chain's notes (none: landing or proving from in_pool until proved); `tapAfter`: what one tap spends once
 *  proved. */
type PageOpts = { tapBefore?: bigint; tapAfter?: bigint; signal?: AbortController; chain?: PoolChain; short?: bigint; proving?: (clock: number, seen: Map<string, number>) => boolean };
function page(tl: Timeline, o: PageOpts = {}) {
  const chain = o.chain ?? "solana";
  let clock = 0;
  const mem = new Map<string, MoveOpRecord>();
  const stop = new AbortController();
  const lines: Line[] = [];
  const was = traceTo((l) => void lines.push(JSON.parse(l.slice(l.indexOf(" ") + 1)) as Line), () => clock);
  const follow = (): MoveFollow | undefined => {
    if (clock < tl.payout) return undefined;
    if (tl.stop !== undefined && clock >= tl.stop.at) return { stage: tl.stop.stage, ...(tl.deadline === undefined ? {} : { follow: { deadline_ms: tl.deadline } }) };
    if (tl.inPool !== undefined && clock >= tl.inPool) return { stage: "in_pool", txs: [{ chain: "solana", hash: "VFC5hqbQxyVDAEybRXmeQLHEiP3rfab6AqGwZpvXWLt5dMt8k2tDjxR52N1EJTMowadauBu6iZbjgdEDDbnE9Hs" }] };
    return { stage: clock < 110 * S ? "waiting" : "in_transit", ...(tl.deadline === undefined ? {} : { follow: { deadline_ms: tl.deadline } }) };
  };
  const md: CashMoverDeps = {
    price: () => PRICE,
    floor: async (c) => (c === "solana" ? 12_000_000n : 1_020_000_000_000_000n),
    rails: ["1click"],
    quote: async (c, usdc) => ({ address: ADDRESS, amountIn: usdc, minOut: (usdc * 10n ** (c === "solana" ? 9n : 18n)) / 80_000_000n }),
    fee: async () => 50_000n,
    cash: async () => 1_000_000_000n,
    handoff: async () => ({ kind: "landed", tx: "8ZFHv6ZJkjYuUj5Je3R1aqVXnHmUZQcZocwZncC6KP6S" }) as never,
    landed: async () => false,
    now: () => clock,
    update: async (id, change) => {
      const v = change(mem.has(id) ? structuredClone(mem.get(id)!) : undefined);
      if (v !== undefined) mem.set(id, structuredClone(v));
      return v;
    },
    follow: async () => follow(),
    // the mover's polls move the clock too: time passes while the tap waits on its landing
    wait: (ms) => new Promise<void>((r) => setImmediate(() => ((clock += ms), r()))),
    signal: o.signal?.signal ?? stop.signal,
  };
  const m = cashMover(md);
  const proved = (): boolean => clock >= tl.proved && (tl.inPool !== undefined && clock >= tl.inPool);
  const tapNow = (): bigint => (proved() ? (o.tapAfter ?? 400_000_000n) : (o.tapBefore ?? 0n));
  const deps: CashToPoolDeps = {
    any: async () => true,
    tapMax: async () => tapNow(),
    need: (c, s) => m.need(c, s),
    // the page's own: the mover's landing, and the chain's notes landing or proving (from in_pool until proved)
    moved: (op) => m.landing(op),
    proving: async (_c: PoolChain, seen: Map<string, number>) => (o.proving ? o.proving(clock, seen) : tl.inPool !== undefined && clock >= tl.inPool && clock < tl.proved),
    ...(o.short === undefined ? {} : { short: async () => o.short! }),
    wait: (ms) => new Promise<void>((r) => setImmediate(() => ((clock += ms), r()))),
    now: () => clock,
    ...(o.signal ? { signal: o.signal.signal } : {}),
  } as CashToPoolDeps;
  const swaps: number[] = [];
  // the pool buy: one tap pays the ask only once the landed notes are proved, else not_funded with nothing sent
  const inner = (a: PoolAsk, c: KindContext | null): HostRefusal | Running<"pool.buy"> => {
    swaps.push(clock);
    if (a.amount > tapNow()) return { error: "not_funded" };
    c?.progress("sent");
    return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent", txs: [{ chain: "solana", hash: SWAP_TX }] } }) };
  };
  const ctx: KindContext = { id: "buy-2", sha: "00", progress: () => {}, route: () => {} };
  return {
    m,
    mem,
    lines,
    swaps,
    now: () => clock,
    tick: (ms: number) => void (clock += ms),
    buy: async (amount: bigint) => {
      const r = cashFirst(inner, () => deps)(ask(amount, chain), ctx);
      if (!("running" in r)) return { ...r };
      await r.after;
      return { ...(r.answer() as object) } as { result?: { stage: string; txs: { hash: string }[] }; error?: string };
    },
    end: () => {
      stop.abort();
      o.signal?.abort();
      traceTo(was.to, was.now);
    },
  };
}

test("a move of 120 s whose proofs take 70 s more: the swap is sent once one tap spends the ask, never not_funded at the 180 s mark", BOUND, async () => {
  const p = page({ payout: 12 * S, inPool: 120 * S, proved: 190 * S });
  try {
    const a = await p.buy(400_000_000n);
    assert.deepEqual(a, { result: { stage: "sent", txs: [{ chain: "solana", hash: SWAP_TX }] } }, `the swap sent (pool buy asked at ${p.swaps.map((x) => x / S)} s)`);
    assert.equal(p.swaps.length, 1);
    assert.ok(p.swaps[0]! >= 190 * S, `the pool buy ran once the proofs were made, at ${p.swaps[0]! / S} s`);
  } finally {
    p.end();
  }
});

test("buy 2's timeline replayed: quote, payout at 12 s, 1Click delivers at 110 s, deposits at 115 s and 117 s, proofs by 200 s: the swap is sent; the move's money counts as on its way until it is in the pool", BOUND, async () => {
  const p = page({ payout: 12 * S, inPool: 115 * S, proved: 200 * S });
  try {
    const going = p.buy(400_000_000n);
    // the move is on its way while the tap waits: its money counts (a Max with Cash 0 is never $0 meanwhile)
    while (p.now() < 100 * S) await new Promise((r) => setImmediate(r));
    assert.ok(p.m.coming("solana") > 0n, "on its way at 100 s");
    const a = await going;
    assert.equal(a.result?.stage, "sent");
    assert.ok(p.swaps[0]! >= 200 * S && p.swaps[0]! < 210 * S, `the swap ran right once the proofs were made, at ${p.swaps[0]! / S} s`);
    assert.equal(p.m.coming("solana"), 0n, "in the pool: no longer counted as on its way (counted once proved, as one tap's)");
    const buy = p.lines.filter((l) => l.op === "buy-2").map((l) => `${l.step}:${l.stage ?? ""}`);
    assert.deepEqual(buy, ["move:", "move:landed", "move:ready", "swap:sent", "swap:sent", "end:sent"]);
  } finally {
    p.end();
  }
});

test("a move still on its way past 180 s counts in what is coming and holds the tap; the swap is sent when it lands and is proved", BOUND, async () => {
  const p = page({ payout: 12 * S, inPool: 260 * S, proved: 300 * S });
  try {
    const going = p.buy(400_000_000n);
    while (p.now() < 200 * S) await new Promise((r) => setImmediate(r));
    assert.ok(p.m.coming("solana") > 0n, "still on its way at 200 s: Max counts it, a second tap never moves it again");
    assert.equal((await going).result?.stage, "sent");
    assert.ok(p.swaps[0]! >= 300 * S);
  } finally {
    p.end();
  }
});

for (const [name, tl, words] of [
  ["its quote's follow refunded", { payout: 12 * S, stop: { at: 90 * S, stage: "refunded" }, proved: Infinity }, /the quote's follow ended refunded/],
  ["its quote expired with nothing delivered", { payout: 12 * S, stop: { at: 90 * S, stage: "expired" }, proved: Infinity }, /the quote's follow ended expired/],
  ["its quote's deadline passed with nothing delivered and no follow end", { payout: 12 * S, proved: Infinity, deadline: 40 * S }, /the quote's deadline passed with nothing delivered/],
] as const)
  test(`a real stop ends the wait at once: ${name}; the line says why and the op record keeps it`, BOUND, async () => {
    const p = page(tl as Timeline);
    try {
      const a = await p.buy(400_000_000n);
      assert.deepEqual(a, { error: "not_funded" }, "the pool buy's own answer");
      const stop = (tl as Timeline).stop?.at ?? (tl as Timeline).deadline! + 60 * S;
      assert.ok(p.swaps[0]! <= stop + 8 * S, `ended at the stop (${stop / S} s), not later: ${p.swaps[0]! / S} s`);
      const stopped = p.lines.find((l) => l.op === "buy-2" && l.stage === "stopped");
      assert.ok(stopped, JSON.stringify(p.lines));
      assert.match(String(stopped!.error), words);
      const rec = [...p.mem.values()][0]!;
      assert.match(rec.last?.error ?? "", words, "the op record keeps the error");
    } finally {
      p.end();
    }
  });

test("a sign out ends the wait at once", BOUND, async () => {
  const out = new AbortController();
  const p = page({ payout: 12 * S, inPool: 260 * S, proved: 300 * S }, { signal: out });
  try {
    const going = p.buy(400_000_000n);
    while (p.now() < 50 * S) await new Promise((r) => setImmediate(r));
    out.abort();
    const a = await going;
    assert.deepEqual(a, { error: "not_funded" });
    assert.ok(p.swaps[0]! < 60 * S, `${p.swaps[0]! / S} s`);
    assert.ok(p.lines.some((l) => l.op === "buy-2" && l.stage === "signed_out"));
  } finally {
    p.end();
  }
});

test("a move landed whose proofs leave one tap short: the wait ends once nothing is landing or proving, and the next tap spends what landed", BOUND, async () => {
  // the money is in the pool and proved (one tap spends 0.4 SOL), the ask 0.5 SOL
  const p = page({ payout: 12 * S, inPool: 100 * S, proved: 150 * S });
  try {
    const a = await p.buy(500_000_000n);
    assert.deepEqual(a, { error: "not_funded" });
    assert.ok(p.swaps[0]! >= 150 * S && p.swaps[0]! < 170 * S, `ended once nothing more was on its way: ${p.swaps[0]! / S} s`);
    assert.ok(p.lines.some((l) => l.op === "buy-2" && l.stage === "settled"));
    // the next tap at what one tap spends: no move, the pool buy at once, sent
    const next = await p.buy(400_000_000n);
    assert.equal(next.result?.stage, "sent");
    assert.equal(p.swaps.at(-1), p.swaps[0]!, "the next tap ran at once");
  } finally {
    p.end();
  }
});

test("the page closed after the move landed: after the reload its move is followed on, counts as on its way until it is in the pool, and the next tap spends its money", BOUND, async () => {
  const p = page({ payout: 0, inPool: 30 * S, proved: 60 * S });
  try {
    // the record a page left: its vault payout landed, 1Click carrying it (src/main.ts resumeMoves at the next sign-in)
    const rec: MoveOpRecord = { kind: "move", from: "near", to: "solana", stage: "in_transit", txs: [{ chain: "near", hash: "8ZFHv6ZJkjYuUj5Je3R1aqVXnHmUZQcZocwZncC6KP6S" }], amount: "40", out: "0.5", created_ms: 0, send_by_ms: 300 * S, claimed_ms: 1 };
    p.mem.set("cash/solana/0", rec);
    p.m.resume([{ id: "cash/solana/0", rec }]);
    assert.equal(p.m.coming("solana"), 500_000_000n, "after the reload its money counts as on its way: a tap never moves it twice");
    p.tick(30 * S);
    while (p.mem.get("cash/solana/0")!.stage !== "into_pool") await new Promise((r) => setImmediate(r));
    assert.equal(p.m.coming("solana"), 0n, "in the pool: the pool's");
    p.tick(30 * S);
    const a = await p.buy(400_000_000n);
    assert.equal(a.result?.stage, "sent", "the next tap spends what landed");
    assert.equal(p.swaps.length, 1);
  } finally {
    p.end();
  }
});

// --- Base and Robinhood: a landed note waits for its queue's next epoch turn
// An EVM note that landed mid-period is UNSPENT until the period's turn pass starts its proof (wallet/src/pool/queue.ts:623
// marks it in flight only then, :715 `making` is those): no INCOMING, no making, not HELD. At 7d282cb80 that read idle,
// so the wait ended two reads after the landing and the pool buy answered not_funded. The page's own read here is the
// real provingOn over the note's states as the queue writes them: UNSPENT from the landing at 60 s, HELD (its proof
// started) at the turn 48 s later, ready (one tap spends it) 50 s after the landing.
const RUNG = 5_000_000_000_000_000n; // 0.005 ETH
const EVM_SCOPE = new Set([5n]);
const evmNotes = (inPool: number, proved: number, value = RUNG) => (clock: number, seen: Map<string, number>): boolean => {
  if (clock < inPool) return false;
  const state = clock < proved - 2 * S ? "UNSPENT" : "HELD";
  const ready = clock >= proved ? [{ noteId: "w1" }] : [];
  return provingOn([{ id: "w1", scope: 5n, state, leaf: { value } }], EVM_SCOPE, ready, undefined, { chain: "base", open: true, seen, now: clock });
};
for (const chain of ["base", "robinhood"] as const)
  test(`${chain}: a move landed at 60 s whose note is proved at the next epoch turn 50 s later: the swap is sent`, BOUND, async () => {
    const p = page({ payout: 12 * S, inPool: 60 * S, proved: 110 * S }, { chain, short: RUNG, tapAfter: RUNG, proving: evmNotes(60 * S, 110 * S) });
    try {
      const a = await p.buy(RUNG);
      assert.equal(a.result?.stage, "sent", `the swap sent (pool buy asked at ${p.swaps.map((x) => x / S)} s): ${JSON.stringify(a)}`);
      assert.ok(p.swaps[0]! >= 110 * S, `once the proof was made, at ${p.swaps[0]! / S} s`);
    } finally {
      p.end();
    }
  });

test("a landed note the queue never proves does not hold the wait: below the piece rule's floor, its queue closed, or past its epoch turn and the margin", BOUND, async () => {
  const seen = new Map<string, number>();
  const note = (value: bigint) => [{ id: "w1", scope: 5n, state: "UNSPENT", leaf: { value } }];
  const turn = (now: number, open = true) => ({ chain: "base" as const, open, seen, now });
  assert.equal(provingOn(note(RUNG), EVM_SCOPE, [], undefined, turn(0)), true, "a rung, its queue open: waits for the turn");
  assert.equal(provingOn(note(RUNG), EVM_SCOPE, [], undefined, turn(69 * S)), true, "inside the epoch (60 s) and the margin (10 s)");
  assert.equal(provingOn(note(RUNG), EVM_SCOPE, [], undefined, turn(70 * S)), false, "past the turn and the margin: idle");
  seen.clear();
  assert.equal(provingOn(note(1n), EVM_SCOPE, [], undefined, turn(0)), false, "below EVM_PIECES' floor: pieceChunk is null, never proved (queue.ts usable)");
  assert.equal(provingOn(note(RUNG), EVM_SCOPE, [], undefined, turn(0, false)), false, "its queue closed (a hidden tab's)");
  assert.equal(provingOn([{ id: "w2", scope: 9n, state: "UNSPENT", leaf: { value: RUNG } }], EVM_SCOPE, [], undefined, turn(0)), false, "another pool's");
  assert.equal(provingOn(note(RUNG), EVM_SCOPE, [], undefined), false, "no turn given: as before");
  // and the tap: a below-floor note alone ends the wait two reads after the landing
  const p = page({ payout: 12 * S, inPool: 60 * S, proved: Infinity }, { chain: "base", short: RUNG, tapAfter: RUNG, proving: evmNotes(60 * S, Infinity, 1n) });
  try {
    assert.deepEqual(await p.buy(RUNG), { error: "not_funded" });
    assert.ok(p.swaps[0]! < 72 * S, `ended at once: ${p.swaps[0]! / S} s`);
  } finally {
    p.end();
  }
});
