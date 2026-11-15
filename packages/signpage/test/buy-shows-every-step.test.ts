// A buy or a move from Cash says which step it is on, how long each took, its tx, and the exact error when one stops
// (card buy-shows-every-step). The owner's buys of 15 Nov 15:17-15:20Z failed with nothing on the device saying where:
// buy 1 at "Moving from Cash" after 28.2 s with no vault payout, buy 2 with its money landed in the Solana pool and no
// pool buy sent. Now the signing page writes one `[ct-trace]` JSON line per step (src/trace.ts), from an allowlist of
// public fields, and a move that stops keeps its last step and its error in its record. And the tap's wait for a move
// (cashFirst) is never ended by one read of what a tap spends that throws or never answers: red at 23eab91ab, the buy
// failed at once with its money already moved (a throw), or held past CASH_MOVE_WAIT_MS (a read that never answered).
//   node --test test/buy-shows-every-step.test.ts      (from packages/signpage)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolAsk } from "../src/rules/pool.ts";
import type { HostRefusal, KindContext, Running } from "../src/api.ts";
import { cashFirst, cashMover, type CashMoverDeps, type CashToPoolDeps, type MoveOpRecord } from "../src/cash-to-pool.ts";
import { followPoolQuote, tracedFollow } from "../src/pool-deposit-follow.ts";
import { SOL_LADDER } from "../../wallet/src/pool/solana.ts";
import { trace, traceAlias, traceBegin, traceTo, TRACE_TAG } from "../src/trace.ts";

const BOUND = { timeout: 5_000 };
type Line = { op: string; part: number | null; step: string; ms: number } & Record<string, unknown>;
/** The page's trace lines while `f` runs, parsed; every one starts with the tag and is one JSON object. */
async function lines(f: (tick: (ms: number) => void) => Promise<unknown>): Promise<Line[]> {
  const out: string[] = [];
  let clock = 1_000_000;
  const was = traceTo((l) => void out.push(l), () => clock);
  try {
    await f((ms) => void (clock += ms));
  } finally {
    traceTo(was.to, was.now);
  }
  return out.map((l) => {
    assert.ok(l.startsWith(`${TRACE_TAG} `), l);
    return JSON.parse(l.slice(TRACE_TAG.length + 1)) as Line;
  });
}

test("a line carries only the allowlisted public fields: a key, the words, a note secret or any other field never prints; a secret-sized run in an error is replaced", async () => {
  const words = "abandon ability able about above absent absorb abstract absurd abuse access accident";
  const secret = "1".repeat(77);
  const got = await lines(async (tick) => {
    traceBegin("op-a");
    tick(1_500);
    trace("op-a", 0, "relay_sent", { tx: "8ZFHv6ZJkjYuUj5Je3R1aqVXnHmUZQcZocwZncC6KP6S", error: `relay: HTTP 502 for nullifier ${secret} and key ${"ab".repeat(32)}`, ...({ seed: "00".repeat(32), words, secret, nullifier: secret } as object) });
    trace("op-a", 0, "quote", { address: words, status: "not a word!", amount: "1e9", stage: "ok" });
  });
  const all = JSON.stringify(got);
  for (const bad of [words, secret, "00".repeat(32), "ab".repeat(32)]) assert.equal(all.includes(bad), false, `never printed: ${bad.slice(0, 20)}`);
  assert.deepEqual(Object.keys(got[0]!).sort(), ["error", "ms", "op", "part", "step", "tx"]);
  assert.equal(got[0]!.ms, 1_500, "ms since the op began");
  assert.match(String(got[0]!.error), /^relay: HTTP 502 for nullifier <redacted> and key <redacted>$/);
  // a field of the wrong shape is dropped, never printed bent
  assert.deepEqual(got[1], { op: "op-a", part: 0, step: "quote", ms: 1_500, stage: "ok" });
});

test("a part's ids (its op, its follow) read as the move's, with the part's number", async () => {
  const got = await lines(async () => {
    traceAlias("mv-b/1/1click", "mv-b", 1);
    trace("mv-b/1/1click", null, "status", { status: "PROCESSING", address: "6215b306511c5cb375ac153417d8ee7ed1090a2e24fe26c1510af4604f4de085" });
  });
  assert.deepEqual(got, [{ op: "mv-b", part: 1, step: "status", ms: 0, status: "PROCESSING", address: "6215b306511c5cb375ac153417d8ee7ed1090a2e24fe26c1510af4604f4de085" }]);
});

// --- the move out of Cash

const PRICE = { price: "8000000000", expo: -8 };
const ADDRESS = "a".repeat(64);
type End = Awaited<ReturnType<NonNullable<CashMoverDeps["handoff"]>>>;
function mover(handoff: NonNullable<CashMoverDeps["handoff"]>, quote?: CashMoverDeps["quote"]) {
  const mem = new Map<string, MoveOpRecord>();
  let clock = 5_000;
  const d: CashMoverDeps = {
    price: () => PRICE,
    floor: async () => 12_000_000n,
    rails: ["1click"],
    quote: quote ?? (async (_c, usdc) => ({ address: ADDRESS, amountIn: usdc, minOut: (usdc * 10n ** 9n) / 80_000_000n })),
    fee: async () => 50_000n,
    cash: async () => 1_000_000_000n,
    handoff,
    landed: async () => false,
    now: () => clock,
    update: async (id, change) => {
      const v = change(mem.has(id) ? structuredClone(mem.get(id)!) : undefined);
      if (v !== undefined) mem.set(id, structuredClone(v));
      return v;
    },
  };
  return { m: cashMover(d), mem, tick: (ms: number) => void (clock += ms) };
}

test("a move whose vault withdraw lands: quote, proof start, proof done, relay sent and the payout with its tx, in order, each its time", BOUND, async () => {
  let t!: ReturnType<typeof mover>;
  const got = await lines(async (tick) => {
    t = mover(async (_w, _fee, _note, claim, mark) => {
      tick(2_000);
      await claim?.();
      mark?.("proof_start");
      tick(6_700);
      mark?.("proof_done");
      mark?.("relay_sent");
      tick(4_000);
      return { kind: "landed", tx: "8ZFHv6ZJkjYuUj5Je3R1aqVXnHmUZQcZocwZncC6KP6S" } as End;
    });
    assert.equal(await t.m.need("solana", 300_000_000n), "cash/solana/5000");
    await t.m.idle();
  });
  const mine = got.filter((l) => l.op === "cash/solana/5000");
  assert.deepEqual(mine.map((l) => l.step), ["quote", "proof_start", "proof_done", "relay_sent", "vault_payout"]);
  assert.equal(mine[0]!.address, ADDRESS, "the quote's deposit address, the one 1Click's status is read for");
  assert.equal(mine[0]!.quote, "cash/solana/5000/1click");
  assert.deepEqual(mine.map((l) => l.ms), [0, 2_000, 8_700, 8_700, 12_700]);
  assert.equal(mine.at(-1)!.tx, "8ZFHv6ZJkjYuUj5Je3R1aqVXnHmUZQcZocwZncC6KP6S");
  assert.ok(mine.every((l) => l.part === 0));
  const rec = t.mem.get("cash/solana/5000")!;
  assert.equal(rec.stage, "in_transit");
  assert.deepEqual(rec.last, { step: "vault_payout", ms: 12_700 });
});

for (const [name, run, error, words] of [
  ["throws (the relay refused)", async () => {
    throw new Error("withdraw relay: HTTP 502 bad gateway");
  }, "withdraw_failed", /^withdraw relay: HTTP 502 bad gateway$/],
  ["ends on a fee above the one drawn", async () => ({ kind: "fee", fee: 80_000n }) as End, "withdraw_fee", /ended fee \(the relayer's fee now 80000, above the fee drawn\)/],
  ["ends expired (nothing landed by its deadline)", async () => ({ kind: "expired" }) as End, "withdraw_expired", /ended expired/],
] as const)
  test(`a move whose vault withdraw ${name} ends failed with why in its record (the op's code) and its last step and words, and says it in an end line`, BOUND, async () => {
    let t!: ReturnType<typeof mover>;
    const got = await lines(async () => {
      t = mover(async (_w, _f, _n, claim, mark) => {
        await claim?.();
        mark?.("proof_start");
        return run();
      });
      await t.m.need("solana", 300_000_000n);
      await t.m.idle();
    });
    const rec = t.mem.get("cash/solana/5000")!;
    assert.equal(rec.stage, "failed");
    assert.equal(rec.error, error);
    assert.equal(rec.last?.step, "end");
    assert.match(rec.last?.error ?? "", words);
    const end = got.filter((l) => l.op === "cash/solana/5000").at(-1)!;
    assert.equal(end.step, "end");
    assert.equal(end.stage, "failed");
    assert.match(String(end.error), words);
  });

test("a move whose vault withdraw has not ended keeps its last step in its record: one that stalls shows where", BOUND, async () => {
  let done!: (e: End) => void;
  const t = mover(async (_w, _f, _n, claim, mark) => {
    await claim?.();
    mark?.("proof_start");
    mark?.("proof_done");
    mark?.("relay_sent");
    return new Promise<End>((r) => (done = r));
  });
  await lines(async () => {
    await t.m.need("solana", 300_000_000n);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(t.mem.get("cash/solana/5000")!.stage, "leaving");
    assert.equal(t.mem.get("cash/solana/5000")!.last?.step, "relay_sent");
    done({ kind: "arrived" } as End);
    await t.m.idle();
  });
});

test("a quote that fails a check names which: the record keeps its code and its words, and the quote line says them", BOUND, async () => {
  let t!: ReturnType<typeof mover>;
  const got = await lines(async () => {
    t = mover(async () => ({ kind: "arrived" }) as End, async (_c, usdc) => ({ address: "intents.near", amountIn: usdc, minOut: 10n ** 12n }));
    assert.equal(await t.m.need("solana", 300_000_000n), null);
  });
  const rec = t.mem.get("cash/solana/5000")!;
  assert.equal(rec.stage, "failed");
  assert.equal(rec.error, "quote_check_failed");
  assert.equal(rec.last?.error, "the quote's deposit address is not a NEAR implicit account");
  assert.equal(got.at(-1)!.step, "quote");
  assert.equal(got.at(-1)!.error, "the quote's deposit address is not a NEAR implicit account");
});

// --- the tap that waits on the move

const TOKEN = "So11111111111111111111111111111111111111112";
const ask = (amount: bigint): PoolAsk => ({ kind: "pool.buy", chain: "solana", token: TOKEN, amount, slippageBps: 100, decimals: 6 });
const ctx = (): KindContext => ({ id: "buy-1", sha: "00", progress: () => {}, route: () => {} });
const inner = (calls: bigint[]) => (a: PoolAsk, c: KindContext | null): HostRefusal | Running<"pool.buy"> => {
  calls.push(a.amount);
  c?.progress("sent");
  return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent", txs: [{ chain: "solana", hash: "3PQYp7SEuisBKEPBMtPkVNFwkAexB3FcKb2F8ari1cWEQ6yHXWNVv8Xx1avEUqXyKKfcD3fVhJJgGKNUd8UBdZCf" }] } }) };
};
function tap(reads: (() => Promise<bigint>)[]): CashToPoolDeps & { clock: () => number } {
  let k = 0, clock = 0;
  return {
    any: async () => true,
    tapMax: () => reads[Math.min(k++, reads.length - 1)]!(),
    need: async () => "cash/solana/7",
    moved: async () => ({ landed: true }),
    proving: async () => true,
    wait: async (ms) => void (clock += ms),
    now: () => clock,
    clock: () => clock,
  };
}
const answerOf = async (r: HostRefusal | Running<"pool.buy">): Promise<unknown> => {
  if (!("running" in r)) return { ...r };
  await r.after;
  return { ...(r.answer() as object) };
};

test("the tap's wait: a read of what one tap spends that throws (the dry down on a slow RPC) is nothing yet, never the buy's end: the money that lands is bought", BOUND, async () => {
  const calls: bigint[] = [];
  const d = tap([async () => 0n, async () => Promise.reject(new Error("down")), async () => Promise.reject(new Error("down")), async () => 400_000_000n]);
  let a: unknown;
  const got = await lines(async () => void (a = await answerOf(cashFirst(inner(calls), () => d)(ask(400_000_000n), ctx()))));
  assert.deepEqual(calls, [400_000_000n], "the pool buy ran for the whole ask");
  assert.equal((a as { result?: { stage: string } }).result?.stage, "sent");
  const buy = got.filter((l) => l.op === "buy-1");
  assert.deepEqual(buy.map((l) => `${l.step}:${l.stage ?? ""}`), ["move:", "move:landed", "move:tap_unread", "move:tap_unread", "move:ready", "swap:sent", "swap:sent", "end:sent"]);
  assert.equal(buy[0]!.move, "cash/solana/7");
  assert.equal(buy[2]!.error, "down");
  assert.equal(buy.at(-1)!.tx, "3PQYp7SEuisBKEPBMtPkVNFwkAexB3FcKb2F8ari1cWEQ6yHXWNVv8Xx1avEUqXyKKfcD3fVhJJgGKNUd8UBdZCf");
});

test("the tap's wait: reads that never answer each count as nothing after their bound; with nothing landing or proving the pool buy then answers, and the line says the wait ended short", BOUND, async () => {
  const calls: bigint[] = [];
  // the first read under the ask, then reads that never answer
  let k = 0;
  const d: CashToPoolDeps = { any: async () => true, tapMax: async () => (k++ === 0 ? 100_000_000n : new Promise<bigint>(() => {})), need: async () => "cash/solana/7", moved: async () => ({ landed: true }), proving: async () => false, wait: async () => {}, now: () => 0, readMs: 5 };
  const got = await lines(async () => {
    const r = cashFirst(inner(calls), () => d)(ask(400_000_000n), ctx());
    await answerOf(r);
  });
  assert.deepEqual(calls, [400_000_000n]);
  const over = got.find((l) => l.op === "buy-1" && l.stage === "settled");
  assert.ok(over, JSON.stringify(got));
  assert.match(String(over!.error), /one tap spends 0 of the 400000000 asked, with nothing more landing or proving/);
  assert.equal(got.filter((l) => l.op === "buy-1" && l.stage === "tap_unread").length, 2, "each read that never answered says so");
});

// --- the follow of the move's quote

test("the quote's follow writes each 1Click status read, 1Click's first sight of the deposit, the money at U_X and each deposit from it", BOUND, async () => {
  const PER = 2_936_160n, KEEP = 650_240n, FLOOR = SOL_LADDER.min + PER + KEEP;
  const rounds = [{ bal: [0n, 0n], status: "PENDING_DEPOSIT" }, { bal: [0n, 0n], status: "PROCESSING" }, { bal: [20_000_000n, 20_000_000n], status: "SUCCESS" }, { bal: [6_000_000n, 6_000_000n], status: "SUCCESS", past: true }] as const;
  let k = 0;
  const ac = new AbortController();
  const out: { step: string; f: Record<string, unknown> }[] = [];
  const end = await followPoolQuote(
    { chain: "solana", s: "777", i: 3, u: "53WArd2utpvQ9pXiUJh2ekcLnrTeYVYwEkUmUAwVPZiT", refund_id: "ab".repeat(32), address: "6215b306511c5cb375ac153417d8ee7ed1090a2e24fe26c1510af4604f4de085", deadline_ms: 1, origin: "nep141:usdc", min_out: "20000000" },
    tracedFollow({
      status: async () => ({ status: rounds[Math.min(k, 3)]!.status as never, delivered: null }),
      balances: async () => rounds[Math.min(k, 3)]!.bal as unknown as [bigint, bigint],
      costs: async () => ({ floor: FLOOR, perRung: PER, keep: KEEP }),
      ladder: SOL_LADDER,
      deposit: async () => ({ end: "filled", txs: [{ chain: "solana", hash: "VFC5hqbQxyVDAEybRXmeQLHEiP3rfab6AqGwZpvXWLt5dMt8k2tDjxR52N1EJTMowadauBu6iZbjgdEDDbnE9Hs" }] }),
      past: async () => "past" in rounds[Math.min(k, 3)]!,
      stage: async () => {},
      sleep: async () => void (++k >= 7 && ac.abort()),
      signal: ac.signal,
    }, (step, f) => void out.push({ step, f: f as Record<string, unknown> })),
  );
  assert.equal(end, "in_pool");
  assert.deepEqual(out.map((x) => `${x.step}:${x.f.status ?? x.f.stage ?? ""}`), ["status:PENDING_DEPOSIT", "status:PROCESSING", "intents:PROCESSING", "arrived:", "pool_deposit:filled"]);
  assert.equal(out[0]!.f.address, "6215b306511c5cb375ac153417d8ee7ed1090a2e24fe26c1510af4604f4de085", "the quote's deposit address, never the intents receiver");
  assert.equal(out[3]!.f.amount, "20000000");
  assert.equal(out[4]!.f.tx, "VFC5hqbQxyVDAEybRXmeQLHEiP3rfab6AqGwZpvXWLt5dMt8k2tDjxR52N1EJTMowadauBu6iZbjgdEDDbnE9Hs");
});
