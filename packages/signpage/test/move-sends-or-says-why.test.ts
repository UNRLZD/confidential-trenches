// A Move out of a pool sends or fails in bounded time (card move-sends-or-says-why). The owner's Move of 14 Nov 11:44Z,
// 0.08 SOL from the Solana pool to Base's, showed Processing for 529 s with nothing on chain: its pool run waited on the
// proof queue a frozen state read held, and nothing ever ended the move. Now the move's record is written leaving with
// a send-by before its quote; the run's claim, right before its first release leaves, is refused past it; and the follow
// ends an unclaimed move failed once it passes. Each chain, both routes (one swap into a pool, the vault route to Cash),
// a quote that never answers, and a reload. Red at 43351a214: the follow loops on leaving for as long as the run says
// nothing, a quote that never answers holds the move with no record, and the run is handed no claim.
//   node --test test/move-sends-or-says-why.test.ts      (from packages/signpage)
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimed, poolToCash } from "../src/pool-to-cash.ts";
import type { MoveOpRecord } from "../src/cash-to-pool.ts";
import type { PoolFunds } from "../src/withdraw/pool-form.ts";

const PRICE = { price: "8000000000", expo: -8 };
const SOL_FUNDS: PoolFunds = { notes: [{ id: "a", value: 30_000_000n }, { id: "b", value: 10_000_000n }], fee: 1_300_000n, wFee: 5_000n, minPart: 1_890_880n };
const EVM_FUNDS: PoolFunds = { notes: [{ id: "a", value: 10n ** 16n }], fee: 10n ** 13n, wFee: 10n ** 12n, minPart: 10n ** 14n };
const ADDR = { solana: "57LxDLkS96hfigLJW45RFEBYT28kzZ8x8u28Vd14o3xU", base: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", robinhood: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" } as const;
const T0 = 1_763_000_000_000;
/** A move that hangs (at 43351a214) fails its test here instead of holding the run. */
const BOUND = { timeout: 5_000 };
/** Longer than any send-by the page may draw (the quote's own 30 min deadline). */
const PAST = 31 * 60_000;

type Chain = "solana" | "base" | "robinhood";
/** A page whose pool run never says anything (its op absent, as a run stuck before its first write, or `out` given),
 *  on a clock each poll moves 2 s on; the store a compare-and-set map, the move's writes logged. */
function page(o: { out?: { stage: string; txs?: { chain: string; hash: string }[] }; quote?: () => Promise<{ address: string; minOut: bigint }>; now?: () => number } = {}) {
  let clock = T0;
  const mem = new Map<string, MoveOpRecord>();
  const log: MoveOpRecord[] = [];
  const claims: (() => Promise<void>)[] = [];
  const stop = new AbortController();
  let polls = 0;
  const write = (id: string, v: MoveOpRecord) => {
    mem.set(id, structuredClone(v));
    log.push(structuredClone(v));
  };
  const quote = async (chain: Chain) => (o.quote ? o.quote() : { address: ADDR[chain], minOut: 1_500_000n });
  const d = {
    price: () => PRICE,
    funds: async (chain: Chain) => (chain === "solana" ? SOL_FUNDS : EVM_FUNDS),
    quote: async (chain: Chain) => quote(chain),
    onChain: (chain: Chain, a: string) => a === ADDR[chain],
    // the run: started, never heard from again; its claim kept for the test
    withdraw: () => (_ready: unknown, _id: string, claim?: () => Promise<void>) => void (claim && claims.push(claim)),
    op: async (id: string) => (id.endsWith("/out") ? o.out : id.includes("/") ? undefined : mem.get(id)),
    // the store before this card: a plain put
    put: async (id: string, rec: MoveOpRecord) => write(id, rec),
    update: async (id: string, change: (v: MoveOpRecord | undefined) => MoveOpRecord | undefined) => {
      const v = change(mem.has(id) ? structuredClone(mem.get(id)!) : undefined);
      if (v !== undefined) write(id, v);
      return v;
    },
    now: o.now ?? (() => clock),
    // each poll 2 s on; a follow still going after the quote's whole deadline is stopped, so the test ends either way
    wait: async (ms: number) => {
      clock += ms;
      if (++polls * ms > PAST) stop.abort();
    },
    signal: stop.signal,
    direct: {
      quote: async (from: Chain, to: Chain) => quote(from).then((q) => ({ ...q, minOut: to === "solana" ? 1_000_000n : 10n ** 14n })),
      follow: async () => undefined,
      floor: async () => 0n,
    },
  };
  return { m: poolToCash(d as never), log, mem, claims, tick: (ms: number) => void (clock += ms) };
}

const AMOUNT: Record<Chain, bigint> = { solana: 20_000_000n, base: 5n * 10n ** 15n, robinhood: 5n * 10n ** 15n };
const PAIRS: [Chain, Chain | "near"][] = [["solana", "base"], ["solana", "robinhood"], ["solana", "near"], ["base", "solana"], ["base", "near"], ["robinhood", "base"], ["robinhood", "near"]];

for (const [from, to] of PAIRS)
  test(`a Move ${from} -> ${to} whose pool run never sends ends failed once its send-by passes; the run's claim is then refused, so it never sends`, BOUND, async () => {
    const p = page();
    assert.deepEqual(await p.m.move(from, AMOUNT[from], "mv", to), { op: "mv" });
    await p.m.idle();
    const last = p.log.at(-1)!;
    assert.equal(last.stage, "failed", `the move ended, not left leaving: ${p.log.map((r) => r.stage).join(" ")}`);
    assert.equal(last.error, "not_sent");
    assert.equal(p.claims.length, 1, "the run was handed the move's claim");
    await assert.rejects(p.claims[0]!(), "a claim after the move failed is refused: nothing leaves");
    assert.equal(p.mem.get("mv")!.stage, "failed");
  });

test("a run that claims inside its send-by is followed on: the send-by never fails a move whose release is on its way", BOUND, async () => {
  const p = page({ out: { stage: "proving" } });
  await p.m.move("solana", AMOUNT.solana, "mv", "base");
  p.tick(60_000);
  await p.claims[0]!();
  assert.equal(typeof p.mem.get("mv")!.claimed_ms, "number");
  // a second part's claim, after the stage moved on, is still the move's
  await p.claims[0]!();
  await p.m.idle();
  assert.deepEqual([...new Set(p.log.map((r) => r.stage))], ["leaving"], "never failed while claimed");
  assert.equal(p.mem.get("mv")!.claimed_ms !== undefined, true, "the claim kept through every later write");
});

test("the move's record is written leaving, with its send-by, before its quote is asked; a quote that never answers ends it failed by the send-by, and no run starts", BOUND, async () => {
  let asked = 0;
  let calls = 0;
  const seen: (MoveOpRecord | undefined)[] = [];
  const p: ReturnType<typeof page> = page({
    // the clock: the tap, then past any send-by
    now: () => (calls++ === 0 ? T0 : T0 + PAST),
    quote: () => {
      asked++;
      seen.push(p.mem.get("mv"));
      return new Promise(() => {});
    },
  });
  const r = await p.m.move("solana", AMOUNT.solana, "mv", "base");
  assert.equal(asked, 1);
  assert.equal(seen[0]?.stage, "leaving", "a record to follow before the quote");
  assert.equal(typeof seen[0]?.send_by_ms, "number");
  assert.deepEqual(r, { error: "down" });
  assert.equal(p.mem.get("mv")!.stage, "failed");
  assert.equal(p.claims.length, 0, "no run");
});

test("after a reload: a move left leaving and unclaimed past its send-by ends failed", BOUND, async () => {
  const p = page();
  const rec: MoveOpRecord = { kind: "move", from: "solana", to: "base", stage: "leaving", txs: [], amount: "0.02", created_ms: T0 - PAST, send_by_ms: T0 - PAST + 300_000 };
  p.mem.set("mv", rec);
  p.m.resume([{ id: "mv", rec }]);
  await p.m.idle();
  assert.equal(p.mem.get("mv")!.stage, "failed");
});

// The owner's own Move (14 Nov 11:44Z) was written by release 137: no send_by_ms, no claim. Loaded by this build it takes
// its tap plus MOVE_SEND_MS as its send-by, and ends failed only while its run shows no release sent.
const LEGACY: MoveOpRecord = { kind: "move", from: "solana", to: "base", stage: "leaving", txs: [], amount: "0.08", out: "0.0021", created_ms: T0 - 3_600_000 };
for (const out of [{ stage: "proving" }, undefined, { stage: "stopped", txs: [] }])
  test(`a release-137 move (no send-by, no claim, an hour old) whose run is ${out === undefined ? "absent" : out.stage} with no tx ends failed not_sent on load; a claim after it is refused`, BOUND, async () => {
    const p = page(out === undefined ? {} : { out });
    p.mem.set("mv", structuredClone(LEGACY));
    p.m.resume([{ id: "mv", rec: structuredClone(LEGACY) }]);
    await p.m.idle();
    const end = p.mem.get("mv")!;
    assert.equal(end.stage, "failed");
    assert.equal(end.error, out?.stage === "stopped" ? undefined : "not_sent", "a stopped run with nothing sent fails as before; else the send-by");
    assert.equal(claimed(end, T0), null, "nothing may send for it after");
  });

for (const out of [{ stage: "in_transit", txs: [{ chain: "solana", hash: "S" }] }, { stage: "in_transit" }, { stage: "sent", txs: [{ chain: "solana", hash: "S" }] }])
  test(`a release-137 move whose run is ${out.stage}${"txs" in out ? " with its tx" : " (its release may be out)"} is never failed by the send-by`, BOUND, async () => {
    const p = page({ out });
    p.mem.set("mv", structuredClone(LEGACY));
    p.m.resume([{ id: "mv", rec: structuredClone(LEGACY) }]);
    await p.m.idle();
    assert.notEqual(p.mem.get("mv")!.stage, "failed", p.log.map((r) => r.stage).join(" "));
  });
