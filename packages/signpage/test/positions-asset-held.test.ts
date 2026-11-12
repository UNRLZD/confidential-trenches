// state.positions[].asset_held (card portfolio-counts-money-an-open-buy-holds): the SOL a position's Ws hold beside the
// token and get back at a full sell, W's own lamports and those of the accounts a full sell closes back to W (its token
// account, its pump and PumpSwap volume accounts), from one getMultipleAccounts per W naming that W; absent when not read.
// Red before this card: positions carried token amounts only, so the app's Portfolio showed none of W's SOL.
//   node --test test/positions-asset-held.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLANA_PUMP_AMM_PROGRAM, SOLANA_PUMP_PROGRAM, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaVolumeAccumulator } from "../../kit/src/checks/solana/checks.ts";
import { solanaAta } from "../../kit/src/checks/solana/message.ts";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { stateOf } from "../src/state.ts";
import { keptPositions, positionsPass, solanaAssetHeld, withPositions, type FoundWallet, type PositionsReads } from "../src/positions.ts";

const SYSTEM = "11111111111111111111111111111111";
// three public keys of no one (base58 of 32 bytes), never a key of ours
const W1 = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const W2 = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const MINT = "So11111111111111111111111111111111111111112";

const ACCOUNT = (lamports: number, owner: string) => ({ lamports, owner, data: ["", "base64"], executable: false, rentEpoch: 0, space: 0 });
/** One getMultipleAccounts answer per call, by the keys it names: each key's account or null. */
function rpcOf(byKey: Record<string, ReturnType<typeof ACCOUNT> | null>, calls: string[][]): SolanaRpc {
  return (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    const keys = params[0] as string[];
    calls.push(keys);
    return { context: { slot: 1 }, value: keys.map((k) => byKey[k] ?? null) };
  }) as SolanaRpc;
}

test("solanaAssetHeld: W's lamports, its token account's and its volume accounts', in one call naming W (the live fault: 8,478,835)", async () => {
  const calls: string[][] = [];
  const rpc = rpcOf({
    [W1]: ACCOUNT(5_618_795, SYSTEM),
    [solanaAta(W1, MINT, SOLANA_TOKEN_PROGRAM)]: ACCOUNT(1_513_840, SOLANA_TOKEN_PROGRAM),
    [solanaVolumeAccumulator(W1, SOLANA_PUMP_PROGRAM)]: ACCOUNT(1_346_200, SOLANA_PUMP_PROGRAM),
  }, calls);
  assert.equal(await solanaAssetHeld(rpc, W1, MINT), 8_478_835n);
  assert.equal(calls.length, 1, "one call per W");
  assert.deepEqual(calls[0], [
    W1,
    solanaAta(W1, MINT, SOLANA_TOKEN_PROGRAM),
    solanaAta(W1, MINT, SOLANA_TOKEN_2022_PROGRAM),
    solanaVolumeAccumulator(W1, SOLANA_PUMP_PROGRAM),
    solanaVolumeAccumulator(W1, SOLANA_PUMP_AMM_PROGRAM),
  ]);
});

test("solanaAssetHeld refuses an answer it cannot trust: a closable account of another program, a wrong count, lamports not whole", async () => {
  const bad = async (byKey: Record<string, ReturnType<typeof ACCOUNT> | null>) => assert.rejects(solanaAssetHeld(rpcOf(byKey, []), W1, MINT));
  await bad({ [W1]: ACCOUNT(1, SYSTEM), [solanaAta(W1, MINT, SOLANA_TOKEN_PROGRAM)]: ACCOUNT(2_039_280, SYSTEM) });
  await bad({ [W1]: ACCOUNT(1, SYSTEM), [solanaVolumeAccumulator(W1, SOLANA_PUMP_PROGRAM)]: ACCOUNT(1, SOLANA_PUMP_AMM_PROGRAM) });
  await bad({ [W1]: ACCOUNT(1.5, SYSTEM) });
  await bad({ [W1]: ACCOUNT(-1, SYSTEM) });
  const short = (async () => ({ context: { slot: 1 }, value: [null] })) as unknown as SolanaRpc;
  await assert.rejects(solanaAssetHeld(short, W1, MINT));
  const none = (async () => null) as unknown as SolanaRpc;
  await assert.rejects(solanaAssetHeld(none, W1, MINT));
});

/** A pass over two Ws that each bought MINT, the finder reading both whole. */
function reads(held: (address: string) => Promise<bigint>): PositionsReads {
  const found: FoundWallet[] = [W1, W2].map((address) => ({ address, tokens: new Map([[MINT, 1_000_000n]]) }));
  return {
    wallets: async () => found,
    decimals: async () => 6,
    bought: async () => ({ [W1]: { mint: MINT }, [W2]: { mint: MINT } }),
    assetHeld: held,
  };
}

test("a position's asset_held is the sum over its Ws, in whole SOL, and fits the kit's state schema", async () => {
  const asked: string[] = [];
  const got = await positionsPass(reads(async (a) => (asked.push(a), a === W1 ? 8_478_835n : 1_000_000_000n)));
  assert.equal(got.whole, true);
  assert.equal(got.positions.length, 1);
  assert.equal(got.positions[0]!.asset_held, "1.008478835");
  assert.deepEqual(asked.sort(), [W1, W2].sort(), "one read per W");
  const state = withPositions(stateOf(true, { source: "code", code_saved: true }, []), got.positions);
  assert.equal(state.positions[0]?.asset_held, "1.008478835", "the state carries it");
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(state), true);
});

test("a W whose extra read fails: no asset_held for its position (never a part sum, never 0), the token rows still update, the pass runs again", async () => {
  const got = await positionsPass(reads(async (a) => {
    if (a === W2) throw new Error("429");
    return 8_478_835n;
  }));
  assert.equal(got.positions.length, 1);
  assert.equal(got.positions[0]!.amount, "2", "the token amount still updates");
  assert.equal(Object.hasOwn(got.positions[0]!, "asset_held"), false);
  assert.equal(got.whole, false, "the pass runs again");
  // with no reader at all (an EVM pass, a page of an earlier release): absent, never "0"
  const bare = reads(async () => 0n);
  delete bare.assetHeld;
  const plain = await positionsPass(bare);
  assert.equal(Object.hasOwn(plain.positions[0]!, "asset_held"), false);
  assert.equal(plain.whole, true);
});

test("the kit's schema: asset_held a decimal at SOL's 9 digits, on Solana only; a kept pass from before it still loads", () => {
  const S = stateOf(true, { source: "code", code_saved: true }, []);
  const at = (p: Record<string, unknown>) => SIGNPAGE_RESULT_SCHEMAS.state({ ...S, positions: [{ chain: "solana", token: MINT, amount: "1", cost: "0", wallets: [W1], decimals: 6, ...p }] });
  assert.equal(at({ asset_held: "0.008478835" }), true);
  assert.equal(at({ asset_held: "0.0084788351" }), false, "more digits than SOL has");
  assert.equal(at({ asset_held: "-1" }), false);
  assert.equal(at({ asset_held: 8478835 }), false, "a number, not a decimal string");
  assert.equal(at({ chain: "base", token: "0x" + "1".repeat(40), asset_held: "0.1" }), false, "EVM positions carry none");
  const old = { positions: [{ chain: "solana", token: MINT, amount: "1", cost: "0", wallets: [W1], decimals: 6 }], held: {}, listed: [] };
  assert.deepEqual(keptPositions(old), old.positions);
  assert.equal(at({}), true);
});
