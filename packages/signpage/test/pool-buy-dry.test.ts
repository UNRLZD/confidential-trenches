// pool.buy.dry (card max-is-priced-for-the-coin, src/pools.ts poolBuyDryKind): Max for the coin on screen is
// state.pools' Solana tap_max priced on the coin's own venue, read on two providers, where state.pools prices the
// costliest venue of any coin. The coins are mainnet's, as the kit's recorded reads hold them (a pump curve coin and a
// PumpSwap coin, both Token-2022 at 170 bytes, no cashback: kit/test/fixtures/solana-pool-buy.json).
//   node --test test/pool-buy-dry.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { SOLANA_POOL_JITO_TIP } from "../../kit/src/checks/solana/checks.ts";
import { SOLANA_POOL_WORST_BUY_VENUE, solanaPoolBuyFunds, solanaPoolFee, type SolanaPoolRelease, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { readSolanaReference } from "../../kit/src/trade/solana/pool.ts";
import { fx, replay } from "../../kit/test/solana-pool-buy-fx.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import { poolBalances, solanaBalancePool, type BalanceProof } from "../../wallet/src/pool/balances.ts";
import { SOL_LADDER, SOL_TIP_CAP } from "../../wallet/src/pool/solana.ts";
import { evmBalancePool } from "../../wallet/src/pool/balances.ts";
import { COIN_VENUE_KEEP_MS, poolBuyDryKind, readCoinVenue, withSolanaRent, type PoolBuyDryDeps } from "../src/pools.ts";
import { APP_ORIGIN, signedOutState, startApi, type IncomingMessage } from "../src/api.ts";

// mainnet's Rent sysvar (5,080 a byte-year, threshold 1.0), as the recorded reads hold it
const RENT: SolanaRent = { lamportsPerByte: 5_080n, factor: 1n };
const FEE = solanaPoolFee(RENT);
const RUNG = SOL_LADDER.min; // 0.01 SOL
const SOL = solanaBalancePool("sol:p", 11n);
const BASE = evmBalancePool("evm:b", "base", 22n);
const held: NoteRecord = { id: "n1", ref: { kind: "deposit", s: 11n, i: 0 }, scope: 11n, precommitment: 1n, state: "HELD", attempt: "a1", deadlineMs: 1n, leaf: { value: RUNG, label: 1n, commitment: 1n, leafIndex: 0n } };
const ready: BalanceProof = { noteId: "n1", attempt: "a1", poolId: SOL.id, chunk: RUNG, wallet: { l: 1n, j: 0, address: "W" }, binding: { feeCap: FEE, request: { tipCap: SOL_TIP_CAP } } };
const pair = (k: "pump" | "pumpswap"): readonly [SolanaRpc, SolanaRpc] => [replay(fx[k], 0), replay(fx[k], 1)];

function deps(over: Partial<PoolBuyDryDeps> & { rpcsOf?: () => readonly [SolanaRpc, SolanaRpc] } = {}): PoolBuyDryDeps {
  return {
    pools: [SOL, BASE],
    rpcs: over.rpcsOf ?? (() => pair("pump")),
    rent: () => RENT,
    ready: async () => ({ notes: [held], ready: [ready], open: new Set([SOL.id]) }),
    trading: () => false,
    ...over,
  };
}
/** The kind's answer once it settles (a plain value: HostAnswer's optional `then` makes it no async result). */
function ask(kind: ReturnType<typeof poolBuyDryKind>, params: Record<string, unknown>): Promise<unknown> {
  const r = kind(params);
  return r.after.then(() => r.answer() as unknown);
}

test("the coin's own venue: the 0.01 SOL piece's Max on a curve coin and a PumpSwap coin, where state.pools reads the costliest venue's", async () => {
  // the state's tap_max, on the costliest venue of any coin (Token-2022 at its largest, cashback, the curve)
  const state = poolBalances([held], withSolanaRent([SOL], RENT), [ready], new Set([SOL.id]));
  assert.equal(state[0]!.tap_max, "0.00128488");
  for (const [coin, kind] of [["pump", "pump-curve"], ["pumpswap", "pumpswap"]] as const) {
    const venue = await readCoinVenue(pair(coin), fx[coin].mint);
    // the mint's decimals, byte 44 of the recorded mint (pump's coins are made at 6)
    assert.deepEqual(venue, { kind, tokenAccountSize: 170, cashback: false, decimals: 6 });
    const a = await ask(poolBuyDryKind(deps({ rpcsOf: () => pair(coin) })), { chain: "solana", token: fx[coin].mint });
    // 10,000,000 less the relay fee 1,300,000, the tip the buy pays 100,000 (SOLANA_POOL_JITO_TIP), W's token account rent(170) 1,513,840, its volume
    // account rent(137) 1,346,200 and the sell's need on PumpSwap with no cashback (5,000 + rent(165) 1,488,440)
    assert.deepEqual(a, { result: { tap_max: "0.00424652" } }, coin);
    assert.equal(SIGNPAGE_RESULT_SCHEMAS["pool.buy.dry"]((a as { result: unknown }).result), true);
    // the buy pays it: the funds rule the signing page checks before W signs passes at that spend on the coin's venue,
    // at the tip the buy pays and any less, and refuses one lamport more (card max-is-what-you-hold-after-a-trade)
    const release = { withdrawnValue: RUNG, relayFee: FEE } as SolanaPoolRelease;
    const funds = (spend: bigint, tip: bigint) => solanaPoolBuyFunds(release, venue as never, { spend, tip }, RENT).problem;
    for (const tip of [0n, 1_000n, SOLANA_POOL_JITO_TIP]) assert.equal(funds(4_246_520n, tip), null, `${coin} tip ${tip}`);
    assert.notEqual(funds(4_246_521n, SOLANA_POOL_JITO_TIP), null);
  }
});

test("each branch of the venue moves Max: Token or Token-2022, cashback or not, curve or PumpSwap", () => {
  const max = (v: { kind: "pump-curve" | "pumpswap"; tokenAccountSize: number; cashback: boolean }) => poolBalances([held], withSolanaRent([SOL], RENT, v), [ready])[0]!.tap_max;
  // a Token mint's coin with no cashback: 4,271,920 on either venue (0.00427 SOL)
  assert.equal(max({ kind: "pump-curve", tokenAccountSize: 165, cashback: false }), "0.00427192");
  assert.equal(max({ kind: "pumpswap", tokenAccountSize: 165, cashback: false }), "0.00427192");
  // Token-2022's larger account costs its rent
  assert.equal(max({ kind: "pump-curve", tokenAccountSize: 170, cashback: false }), "0.00424652");
  // cashback: PumpSwap's buy makes one more wrapped-SOL account; the curve's keeps both of the sell's cashback accounts
  assert.equal(max({ kind: "pumpswap", tokenAccountSize: 165, cashback: true }), "0.00278348");
  assert.equal(max({ kind: "pump-curve", tokenAccountSize: 165, cashback: true }), "0.00143728");
  // the costliest of all is state.pools' own
  assert.equal(max(SOLANA_POOL_WORST_BUY_VENUE), "0.00128488");
});

test("a cashback coin, as both providers' venue bytes say it (the curve's byte 82, the PumpSwap pool's 244): its own Max on each venue", async () => {
  const cashback = (coin: "pump" | "pumpswap", p: 0 | 1): SolanaRpc =>
    replay(fx[coin], p, (_list, ans) => {
      const d = Buffer.from(ans.value[1].data[0], "base64");
      d[coin === "pump" ? 82 : 244] = 1;
      ans.value[1].data[0] = d.toString("base64");
      return ans;
    });
  // Token-2022 at 170 bytes: the curve keeps both of the sell's PumpSwap cashback accounts (1,411,880); PumpSwap's buy
  // makes W's wrapped-SOL cashback account (2,758,080)
  for (const [coin, kind, tap] of [["pump", "pump-curve", "0.00141188"], ["pumpswap", "pumpswap", "0.00275808"]] as const) {
    const rpcs = [cashback(coin, 0), cashback(coin, 1)] as const;
    assert.deepEqual(await readCoinVenue(rpcs, fx[coin].mint), { kind, tokenAccountSize: 170, cashback: true, decimals: 6 });
    assert.deepEqual(await ask(poolBuyDryKind(deps({ rpcsOf: () => rpcs })), { chain: "solana", token: fx[coin].mint }), { result: { tap_max: tap } }, coin);
  }
});

test("a coin whose venue is not read keeps state.pools' Max: refused, never a number", async () => {
  // neither venue's accounts recorded: the replay throws on both reads
  assert.deepEqual(await ask(poolBuyDryKind(deps()), { chain: "solana", token: fx.pumpswap.mint.replace("9", "8") }), { error: "quote_check_failed" });
  // the providers disagree on the curve (one byte of the creator), and the coin has no PumpSwap pool
  const off: SolanaRpc = replay(fx.pump, 1, (list, ans) => {
    const d = Buffer.from(ans.value[1].data[0], "base64");
    d[60]! ^= 1;
    ans.value[1].data[0] = d.toString("base64");
    return ans;
  });
  assert.deepEqual(await ask(poolBuyDryKind(deps({ rpcsOf: () => [replay(fx.pump, 0), off] })), { chain: "solana", token: fx.pump.mint }), { error: "quote_check_failed" });
  const down = (): SolanaRpc =>
    (async () => {
      throw new SolanaRpcTransportError("timeout", "no answer", 1, "test");
    }) as SolanaRpc;
  assert.deepEqual(await ask(poolBuyDryKind(deps({ rpcsOf: () => [down(), down()] })), { chain: "solana", token: fx.pump.mint }), { error: "down" });
});

test("refused: a chain other than Solana, signed out, a trade running, no Solana pool", async () => {
  assert.deepEqual(await ask(poolBuyDryKind(deps()), { chain: "base", token: "0x" + "1".repeat(40) }), { error: "not_allowed" });
  assert.deepEqual(await ask(poolBuyDryKind(deps({ pools: [BASE] })), { chain: "solana", token: fx.pump.mint }), { error: "not_allowed" });
  assert.deepEqual(await ask(poolBuyDryKind(deps({ ready: async () => null })), { chain: "solana", token: fx.pump.mint }), { error: "not_funded" });
  assert.deepEqual(await ask(poolBuyDryKind(deps({ trading: () => true })), { chain: "solana", token: fx.pump.mint }), { error: "busy" });
  // no queue open: no ready, so no Max of the coin's either
  assert.deepEqual(await ask(poolBuyDryKind(deps({ ready: async () => ({ notes: [held] }) })), { chain: "solana", token: fx.pump.mint }), { error: "not_funded" });
});

test("a coin's venue is read once on the page: the next ask makes no read", async () => {
  let reads = 0;
  const counted = (p: 0 | 1): SolanaRpc => {
    const r = replay(fx.pump, p);
    return (async (m: string, q: readonly unknown[]) => (reads++, r(m, q))) as SolanaRpc;
  };
  const kind = poolBuyDryKind(deps({ rpcsOf: () => [counted(0), counted(1)] }));
  assert.deepEqual(await ask(kind, { chain: "solana", token: fx.pump.mint }), { result: { tap_max: "0.00424652" } });
  assert.equal(reads, 2, "one read on each provider");
  assert.deepEqual(await ask(kind, { chain: "solana", token: fx.pump.mint }), { result: { tap_max: "0.00424652" } });
  assert.equal(reads, 2);
});

test("the page's message queue never waits for a coin's venue read: a state asked after pool.buy.dry is answered first", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = (p: 0 | 1): SolanaRpc => {
    const r = replay(fx.pump, p);
    return (async (m: string, q: readonly unknown[]) => (await gate, r(m, q))) as SolanaRpc;
  };
  const dry = poolBuyDryKind(deps({ rpcsOf: () => [slow(0), slow(1)] }));
  const posted: { id?: string }[] = [];
  const parent = { postMessage: (msg: unknown) => void posted.push(msg as { id?: string }) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  startApi({ parent, listen: (fn) => (listener = fn), state: signedOutState, kinds: { "pool.buy.dry": (p) => dry(p) } });
  const send = (data: unknown) => listener!({ origin: APP_ORIGIN, source: parent, data });
  const [a, s] = [crypto.randomUUID(), crypto.randomUUID()];
  send({ v: 1, id: a, type: "pool.buy.dry", chain: "solana", token: fx.pump.mint });
  send({ v: 1, id: s, type: "state" });
  await new Promise((ok) => setTimeout(ok, 300));
  const stateFirst = posted.some((m) => m.id === s);
  release();
  const end = Date.now() + 2_000;
  while (!posted.some((m) => m.id === a) && Date.now() < end) await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(stateFirst, true, "the state waited behind pool.buy.dry's venue read");
  assert.deepEqual(posted.filter((m) => m.id === a || m.id === s).map((m) => (m.id === a ? "dry" : "state")), ["state", "dry"]);
});

/** One provider of a recorded pair that answers both coins' reads, the PumpSwap coin's pool a cashback one (byte 244),
 *  so the two coins' Max differ; every read counted. */
function bothCoins(p: 0 | 1, reads: { n: number }): SolanaRpc {
  const pump = replay(fx.pump, p);
  const swap = replay(fx.pumpswap, p, (_list, ans) => {
    const d = Buffer.from(ans.value[1].data[0], "base64");
    d[244] = 1;
    ans.value[1].data[0] = d.toString("base64");
    return ans;
  });
  return (async (m: string, q: readonly unknown[]) => {
    reads.n++;
    const k = JSON.stringify(q[0]);
    if (fx.pump.reads[p][k]) return pump(m, q);
    if (fx.pumpswap.reads[p][k]) return swap(m, q);
    throw new Error(`no recorded read of ${k}`);
  }) as SolanaRpc;
}

test("two coins on one page: each its own Max, the kept venue the asked coin's", async () => {
  const reads = { n: 0 };
  const kind = poolBuyDryKind(deps({ rpcsOf: () => [bothCoins(0, reads), bothCoins(1, reads)] }));
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await ask(kind, { chain: "solana", token: fx.pump.mint }), { result: { tap_max: "0.00424652" } });
    assert.deepEqual(await ask(kind, { chain: "solana", token: fx.pumpswap.mint }), { result: { tap_max: "0.00275808" } });
  }
  // the curve coin one read a provider, the PumpSwap coin two (its curve, then its pool); the second round none
  assert.equal(reads.n, 6);
});

test("a kept venue is read again once it is COIN_VENUE_KEEP_MS old: a coin's flags are never kept for the page's life", async () => {
  assert.equal(COIN_VENUE_KEEP_MS, 60_000);
  let now = 1_000_000;
  const reads = { n: 0 };
  const kind = poolBuyDryKind(deps({ rpcsOf: () => [bothCoins(0, reads), bothCoins(1, reads)], now: () => now }));
  const mint = fx.pump.mint;
  await ask(kind, { chain: "solana", token: mint });
  assert.equal(reads.n, 2);
  now += COIN_VENUE_KEEP_MS - 1;
  await ask(kind, { chain: "solana", token: mint });
  assert.equal(reads.n, 2, "kept inside the limit");
  now += 1;
  assert.deepEqual(await ask(kind, { chain: "solana", token: mint }), { result: { tap_max: "0.00424652" } });
  assert.equal(reads.n, 4, "read again at the limit");
});

test("with an amount (kit 1.12, card buy-spends-several-pieces): the pieces a buy of it spends and what it costs for good, from the same ready set", async () => {
  // the own note's 0.01 piece and two 0.02 pieces bound to its W (another note's each)
  const n = (id: string, label: bigint, value: bigint): NoteRecord => ({ ...held, id, attempt: `a-${id}`, leaf: { ...held.leaf!, value, label } });
  const notes = [n("own", 1n, RUNG), n("p2", 2n, 2n * RUNG), n("p3", 3n, 2n * RUNG)];
  const proofOf = (x: NoteRecord, own: boolean) => ({ ...ready, noteId: x.id, attempt: x.attempt!, chunk: x.leaf!.value, ...(own ? { own: true as const } : {}) });
  const list = [proofOf(notes[0]!, true), proofOf(notes[1]!, false), proofOf(notes[2]!, false)];
  const TIP = 100_000n;
  const kind = poolBuyDryKind(deps({ tip: TIP, ready: async () => ({ notes, ready: list, open: new Set([SOL.id]) }) }));
  const at = async (amount?: string) => (await ask(kind, { chain: "solana", token: fx.pump.mint, ...(amount === undefined ? {} : { amount }) })) as { result?: Record<string, unknown>; error?: string };
  const plain = await at();
  const tap = plain.result!.tap_max as string;
  assert.deepEqual(Object.keys(plain.result!), ["tap_max"], "no amount: tap_max alone, as kit 1.10 reads it");
  const sol = (l: bigint) => (Number(l) / 1e9).toString();
  // out (card solana-buy-preview-complete): the quote the buy takes, the kit's readSolanaReference on the same pair
  const outOf = async (spend: string) => (await quoteOut("pump", spend));
  // a spend the own piece pays alone: one piece, its relay fee and the tip
  assert.deepEqual((await at("0.001")).result, { tap_max: tap, pieces: 1, cost: sol(FEE + TIP), out: await outOf("0.001") });
  // past it: the own piece and one 0.02 (the least released), two relay fees and one tip
  assert.deepEqual((await at("0.01")).result, { tap_max: tap, pieces: 2, cost: sol(2n * FEE + TIP), out: await outOf("0.01") });
  // tap_max itself: all three
  assert.deepEqual((await at(tap)).result, { tap_max: tap, pieces: 3, cost: sol(3n * FEE + TIP), out: await outOf(tap) });
  // past tap_max: no pieces, as no buy of it passes
  assert.deepEqual(Object.keys((await at("1")).result!), ["tap_max"]);
  for (const bad of ["0.0000000001", "-1", "1e3", "abc", 5]) assert.deepEqual(await at(bad as string), { error: "not_allowed" }, String(bad));
  for (const r of [(await at("0.01")).result, (await at("0.001")).result]) assert.ok(SIGNPAGE_RESULT_SCHEMAS["pool.buy.dry"](r));
});

test("with an amount, the page's own tip (card buy-spends-several-pieces): every set's cost carries the auction's tip once (the kit's solanaPoolBuyTip, card owners-solana-buy-lands), as the buy tips it", async () => {
  const n = (id: string, label: bigint, value: bigint): NoteRecord => ({ ...held, id, attempt: `a-${id}`, leaf: { ...held.leaf!, value, label } });
  const notes = [n("own", 1n, RUNG), n("p2", 2n, 2n * RUNG)];
  const proofOf = (x: NoteRecord, own: boolean) => ({ ...ready, noteId: x.id, attempt: x.attempt!, chunk: x.leaf!.value, ...(own ? { own: true as const } : {}) });
  const kind = poolBuyDryKind(deps({ ready: async () => ({ notes, ready: [proofOf(notes[0]!, true), proofOf(notes[1]!, false)], open: new Set([SOL.id]) }) }));
  const at = async (amount: string) => (await ask(kind, { chain: "solana", token: fx.pump.mint, amount })) as { result?: Record<string, unknown> };
  const sol = (l: bigint) => (Number(l) / 1e9).toString();
  assert.deepEqual([(await at("0.001")).result?.pieces, (await at("0.001")).result?.cost], [1, sol(FEE + SOLANA_POOL_JITO_TIP)]);
  assert.deepEqual([(await at("0.01")).result?.pieces, (await at("0.01")).result?.cost], [2, sol(2n * FEE + SOLANA_POOL_JITO_TIP)]);
});

/** The expected out the buy's own quote gives for `spend` SOL on the recorded coin (src/pool-buy.ts: readSolanaReference
 *  through pageReference, the best of pump's curve and PumpSwap), in whole tokens at the mint's 6 decimals. */
async function quoteOut(coin: "pump" | "pumpswap", spend: string): Promise<string> {
  const [w, f = ""] = spend.split(".");
  const lamports = BigInt(w!) * 1_000_000_000n + BigInt(f.padEnd(9, "0"));
  const ref = await readSolanaReference(pair(coin), { side: "buy", token: fx[coin].mint, amount: lamports });
  const best = ref!.pools.filter((p) => p.venue === "pump-curve" || p.venue === "pumpswap").sort((x, y) => (x.expectedOut > y.expectedOut ? -1 : 1))[0]!;
  const s = best.expectedOut.toString().padStart(7, "0");
  const frac = s.slice(-6).replace(/0+$/, "");
  return frac ? `${s.slice(0, -6)}.${frac}` : s.slice(0, -6);
}

/** The page's one 0.01 SOL note with its own proof ready: a buy it pays alone is one piece. */
const OWN: PoolBuyDryDeps["ready"] = async () => ({ notes: [held], ready: [{ ...ready, own: true as const }], open: new Set([SOL.id]) });
test("with an amount, You receive (card solana-buy-preview-complete): out is the buy's own quote on the coin's venue, curve and PumpSwap, and a quote that is not read gives no out", async () => {
  // red before this card: the answer had no out, so the app's You receive drew a dash on every amount
  for (const coin of ["pump", "pumpswap"] as const) {
    const kind = poolBuyDryKind(deps({ rpcsOf: () => pair(coin), tip: 100_000n, ready: OWN }));
    const a = (await ask(kind, { chain: "solana", token: fx[coin].mint, amount: "0.001" })) as { result: Record<string, unknown> };
    assert.equal(a.result.out, await quoteOut(coin, "0.001"), coin);
    assert.match(a.result.out as string, /^[1-9][0-9]*(\.[0-9]{1,6})?$/, coin);
    assert.ok(SIGNPAGE_RESULT_SCHEMAS["pool.buy.dry"](a.result), coin);
  }
  // the curve coin's 0.001 SOL buy as recorded: 35,294.263662 tokens (a curve near its start: ~35.7K a 0.001 SOL less
  // pump's fee)
  assert.equal(await quoteOut("pump", "0.001"), "35294.263662");
  // the quote's read fails on one provider (the venue's kept from an earlier ask): pieces and cost as before, no out
  let fail = false;
  const flaky = (p: 0 | 1): SolanaRpc => {
    const r = replay(fx.pump, p);
    return (async (m: string, q: readonly unknown[]) => {
      if (fail && p === 1) throw new SolanaRpcTransportError("timeout", "no answer", 1, "test");
      return r(m, q);
    }) as SolanaRpc;
  };
  const kind = poolBuyDryKind(deps({ rpcsOf: () => [flaky(0), flaky(1)], tip: 100_000n, ready: OWN }));
  await ask(kind, { chain: "solana", token: fx.pump.mint });
  fail = true;
  assert.deepEqual(await ask(kind, { chain: "solana", token: fx.pump.mint, amount: "0.001" }), { result: { tap_max: "0.00424652", pieces: 1, cost: "0.0014" } });
});

test("Max is the most the buy pays at the tip it tips (card max-is-what-you-hold-after-a-trade): the account of 13 Nov 18:23Z, three pieces on one W, state.pools and the coin's own Max alike", async () => {
  // the owner's Solana notes after two round trips, as the QA browser read them (13 Nov 18:23Z): a 0.005547107 note
  // (its own W's), a 0.003502518 note and a 0.012 sale's return, whose piece is 0.005 (the piece rule leaves 0.007 for
  // the next tap); every proof binds SOL_TIP_CAP, and the buy tips the page's SOLANA_POOL_JITO_TIP
  const n = (id: string, label: bigint, value: bigint): NoteRecord => ({ ...held, id, attempt: `a-${id}`, leaf: { ...held.leaf!, value, label } });
  const notes = [n("own", 1n, 5_547_107n), n("ret", 2n, 3_502_518n), n("big", 3n, 12_000_000n)];
  const chunks = [5_547_107n, 3_502_518n, 5_000_000n];
  const list = notes.map((x, i) => ({ ...ready, noteId: x.id, attempt: x.attempt!, chunk: chunks[i]!, ...(i === 0 ? { own: true as const } : {}) }));
  const lamports = (s: string): bigint => BigInt(s.replace(".", "").replace(/^0+/, "") || "0") * 10n ** BigInt(9 - (s.split(".")[1]?.length ?? 0));
  const pieces = chunks.map((c) => ({ withdrawnValue: c, relayFee: FEE }) as SolanaPoolRelease);
  const funds = (venue: Parameters<typeof solanaPoolBuyFunds>[1], spend: bigint) => solanaPoolBuyFunds(pieces, venue, { spend, tip: SOLANA_POOL_JITO_TIP }, RENT).problem;
  // state.pools: the costliest venue of any coin
  const state = lamports(poolBalances(notes, withSolanaRent([SOL], RENT), list, new Set([SOL.id]))[0]!.tap_max!);
  assert.equal(funds(SOLANA_POOL_WORST_BUY_VENUE, state), null, "the buy pays state.pools' Max");
  assert.notEqual(funds(SOLANA_POOL_WORST_BUY_VENUE, state + 1n), null, "and not one lamport more: Max is all of it");
  // pool.buy.dry: the coin's own venue, and the box's amount at Max is a buy of all three pieces
  const kind = poolBuyDryKind(deps({ ready: async () => ({ notes, ready: list, open: new Set([SOL.id]) }) }));
  const tap = ((await ask(kind, { chain: "solana", token: fx.pump.mint })) as { result: { tap_max: string } }).result.tap_max;
  const venue = await readCoinVenue(pair("pump"), fx.pump.mint);
  assert.equal(funds(venue as never, lamports(tap)), null, "the buy pays the coin's Max");
  assert.notEqual(funds(venue as never, lamports(tap) + 1n), null, "and not one lamport more");
  const at = (await ask(kind, { chain: "solana", token: fx.pump.mint, amount: tap })) as { result: Record<string, unknown> };
  assert.equal(at.result.pieces, 3);
});
