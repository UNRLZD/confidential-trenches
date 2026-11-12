// pool.buy.dry (card max-is-priced-for-the-coin, src/pools.ts poolBuyDryKind): Max for the coin on screen is
// state.pools' Solana tap_max priced on the coin's own venue, read on two providers, where state.pools prices the
// costliest venue of any coin. The coins are mainnet's, as the kit's recorded reads hold them (a pump curve coin and a
// PumpSwap coin, both Token-2022 at 170 bytes, no cashback: kit/test/fixtures/solana-pool-buy.json).
//   node --test test/pool-buy-dry.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { SOLANA_POOL_WORST_BUY_VENUE, solanaPoolBuyFunds, solanaPoolFee, type SolanaPoolRelease, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { fx, replay } from "../../kit/test/solana-pool-buy-fx.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import { poolBalances, solanaBalancePool, type BalanceProof } from "../../wallet/src/pool/balances.ts";
import { SOL_LADDER, SOL_TIP_CAP } from "../../wallet/src/pool/solana.ts";
import { evmBalancePool } from "../../wallet/src/pool/balances.ts";
import { poolBuyDryKind, readCoinVenue, withSolanaRent, type PoolBuyDryDeps } from "../src/pools.ts";

// mainnet's Rent sysvar (5,080 a byte-year, threshold 1.0), as the recorded reads hold it
const RENT: SolanaRent = { lamportsPerByte: 5_080n, factor: 1n };
const FEE = solanaPoolFee(RENT);
const RUNG = SOL_LADDER.min; // 0.01 SOL
const SOL = solanaBalancePool("sol:p", 11n);
const BASE = evmBalancePool("evm:b", "base", 22n);
const held: NoteRecord = { id: "n1", ref: { kind: "deposit", s: 11n, i: 0 }, scope: 11n, precommitment: 1n, state: "HELD", attempt: "a1", deadlineMs: 1n, leaf: { value: RUNG, label: 1n, commitment: 1n, leafIndex: 0n } };
const ready: BalanceProof = { noteId: "n1", attempt: "a1", poolId: SOL.id, chunk: RUNG, binding: { feeCap: FEE, request: { tipCap: SOL_TIP_CAP } } };
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
  assert.equal(state[0]!.tap_max, "0.00038488");
  for (const [coin, kind] of [["pump", "pump-curve"], ["pumpswap", "pumpswap"]] as const) {
    const venue = await readCoinVenue(pair(coin), fx[coin].mint);
    assert.deepEqual(venue, { kind, tokenAccountSize: 170, cashback: false });
    const a = await ask(poolBuyDryKind(deps({ rpcsOf: () => pair(coin) })), { chain: "solana", token: fx[coin].mint });
    // 10,000,000 less the relay fee 1,300,000, the tip cap 1,000,000, W's token account rent(170) 1,513,840, its volume
    // account rent(137) 1,346,200 and the sell's need on PumpSwap with no cashback (5,000 + rent(165) 1,488,440)
    assert.deepEqual(a, { result: { tap_max: "0.00334652" } }, coin);
    assert.equal(SIGNPAGE_RESULT_SCHEMAS["pool.buy.dry"]((a as { result: unknown }).result), true);
    // the buy pays it: the funds rule the signing page checks before W signs passes at that spend on the coin's venue,
    // at every tip the proof allows, and refuses one lamport more
    const release = { withdrawnValue: RUNG, relayFee: FEE } as SolanaPoolRelease;
    const funds = (spend: bigint, tip: bigint) => solanaPoolBuyFunds(release, venue as never, { spend, tip }, RENT).problem;
    for (const tip of [0n, 1_000n, SOL_TIP_CAP]) assert.equal(funds(3_346_520n, tip), null, `${coin} tip ${tip}`);
    assert.notEqual(funds(3_346_521n, SOL_TIP_CAP), null);
  }
});

test("each branch of the venue moves Max: Token or Token-2022, cashback or not, curve or PumpSwap", () => {
  const max = (v: { kind: "pump-curve" | "pumpswap"; tokenAccountSize: number; cashback: boolean }) => poolBalances([held], withSolanaRent([SOL], RENT, v), [ready])[0]!.tap_max;
  // a Token mint's coin with no cashback: 3,371,920 on either venue (the CO's 0.00337)
  assert.equal(max({ kind: "pump-curve", tokenAccountSize: 165, cashback: false }), "0.00337192");
  assert.equal(max({ kind: "pumpswap", tokenAccountSize: 165, cashback: false }), "0.00337192");
  // Token-2022's larger account costs its rent
  assert.equal(max({ kind: "pump-curve", tokenAccountSize: 170, cashback: false }), "0.00334652");
  // cashback: PumpSwap's buy makes one more wrapped-SOL account; the curve's keeps both of the sell's cashback accounts
  assert.equal(max({ kind: "pumpswap", tokenAccountSize: 165, cashback: true }), "0.00188348");
  assert.equal(max({ kind: "pump-curve", tokenAccountSize: 165, cashback: true }), "0.00053728");
  // the costliest of all is state.pools' own
  assert.equal(max(SOLANA_POOL_WORST_BUY_VENUE), "0.00038488");
});

test("a cashback coin, as both providers' venue bytes say it (the curve's byte 82, the PumpSwap pool's 244): its own Max on each venue", async () => {
  const cashback = (coin: "pump" | "pumpswap", p: 0 | 1): SolanaRpc =>
    replay(fx[coin], p, (_list, ans) => {
      const d = Buffer.from(ans.value[1].data[0], "base64");
      d[coin === "pump" ? 82 : 244] = 1;
      ans.value[1].data[0] = d.toString("base64");
      return ans;
    });
  // Token-2022 at 170 bytes: the curve keeps both of the sell's PumpSwap cashback accounts (511,880); PumpSwap's buy
  // makes W's wrapped-SOL cashback account (1,858,080)
  for (const [coin, kind, tap] of [["pump", "pump-curve", "0.00051188"], ["pumpswap", "pumpswap", "0.00185808"]] as const) {
    const rpcs = [cashback(coin, 0), cashback(coin, 1)] as const;
    assert.deepEqual(await readCoinVenue(rpcs, fx[coin].mint), { kind, tokenAccountSize: 170, cashback: true });
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
  assert.deepEqual(await ask(kind, { chain: "solana", token: fx.pump.mint }), { result: { tap_max: "0.00334652" } });
  assert.equal(reads, 2, "one read on each provider");
  assert.deepEqual(await ask(kind, { chain: "solana", token: fx.pump.mint }), { result: { tap_max: "0.00334652" } });
  assert.equal(reads, 2);
});
