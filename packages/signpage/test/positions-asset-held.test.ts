// state.positions[].asset_held (card portfolio-counts-money-an-open-buy-holds): the SOL a position's Ws hold beside the
// token and get back at a full sell, W's own lamports and those of the accounts a full sell closes back to W (its token
// account, its pump and PumpSwap volume accounts), from one batched getMultipleAccounts for the pass; absent when not read.
// Red before this card: positions carried token amounts only, so the app's Portfolio showed none of W's SOL.
//   node --test test/positions-asset-held.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLANA_PUMP_AMM_PROGRAM, SOLANA_PUMP_PROGRAM, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaVolumeAccumulator } from "../../kit/src/checks/solana/checks.ts";
import { solanaAta } from "../../kit/src/checks/solana/message.ts";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { stateOf } from "../src/state.ts";
import { pageAssetHeldRpc } from "../src/pool-testnet.ts";
import { keptPositions, passMemo, positionsPass, solanaAssetHeld, withPositions, type FoundWallet, type PositionsReads } from "../src/positions.ts";

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
  assert.deepEqual(await solanaAssetHeld(rpc, [{ address: W1, mint: MINT }]), new Map([[W1, 8_478_835n]]));
  assert.equal(calls.length, 1, "one call");
  assert.deepEqual(calls[0], [
    W1,
    solanaAta(W1, MINT, SOLANA_TOKEN_PROGRAM),
    solanaAta(W1, MINT, SOLANA_TOKEN_2022_PROGRAM),
    solanaVolumeAccumulator(W1, SOLANA_PUMP_PROGRAM),
    solanaVolumeAccumulator(W1, SOLANA_PUMP_AMM_PROGRAM),
  ]);
});

test("solanaAssetHeld refuses a W it cannot trust (a closable account of another program, lamports not whole: that W absent), and an answer of another count or none (a throw)", async () => {
  const one = [{ address: W1, mint: MINT }];
  const absent = async (byKey: Record<string, ReturnType<typeof ACCOUNT> | null>) => assert.deepEqual(await solanaAssetHeld(rpcOf(byKey, []), one), new Map());
  await absent({ [W1]: ACCOUNT(1, SYSTEM), [solanaVolumeAccumulator(W1, SOLANA_PUMP_PROGRAM)]: ACCOUNT(1, SOLANA_PUMP_AMM_PROGRAM) });
  await absent({ [W1]: ACCOUNT(1, SYSTEM), [solanaAta(W1, MINT, SOLANA_TOKEN_PROGRAM)]: ACCOUNT(1, SOLANA_TOKEN_2022_PROGRAM) });
  await absent({ [W1]: ACCOUNT(1.5, SYSTEM) });
  await absent({ [W1]: ACCOUNT(-1, SYSTEM) });
  const short = (async () => ({ context: { slot: 1 }, value: [null] })) as unknown as SolanaRpc;
  await assert.rejects(solanaAssetHeld(short, one));
  const none = (async () => null) as unknown as SolanaRpc;
  await assert.rejects(solanaAssetHeld(none, one));
});

test("review P2-1: a stranger's lamports at a closable address (a System-owned account there) count 0, never a throw on every pass", async () => {
  const got = await solanaAssetHeld(rpcOf({
    [W1]: ACCOUNT(5_618_795, SYSTEM),
    [solanaAta(W1, MINT, SOLANA_TOKEN_PROGRAM)]: ACCOUNT(2_039_280, SYSTEM),
    [solanaVolumeAccumulator(W1, SOLANA_PUMP_AMM_PROGRAM)]: ACCOUNT(1, SYSTEM),
  }, []), [{ address: W1, mint: MINT }]);
  assert.deepEqual(got, new Map([[W1, 5_618_795n]]));
});

test("review P3-2: every W of the pass in one batched call, twenty Ws a call, each W's five accounts read as its own", async () => {
  const calls: string[][] = [];
  // twenty-one addresses of no one: W1, then each the pump volume address of the one before
  const addresses = [W1];
  while (addresses.length < 21) addresses.push(solanaVolumeAccumulator(addresses.at(-1)!, SOLANA_PUMP_PROGRAM));
  const many = addresses.map((address) => ({ address, mint: MINT }));
  const rpc = rpcOf(Object.fromEntries(many.map((w, i) => [w.address, ACCOUNT(1_000 + i, SYSTEM)])), calls);
  const got = await solanaAssetHeld(rpc, many);
  assert.deepEqual(calls.map((c) => c.length), [100, 5], "twenty Ws a call, the rest in a second");
  assert.equal(got.size, 21);
  for (const [i, w] of many.entries()) assert.equal(got.get(w.address), BigInt(1_000 + i), w.address);
});

/** A pass over two Ws that each bought MINT, the finder reading both whole. */
function reads(held: (address: string) => Promise<bigint>): PositionsReads {
  const found: FoundWallet[] = [W1, W2].map((address) => ({ address, tokens: new Map([[MINT, 1_000_000n]]) }));
  return {
    wallets: async () => found,
    decimals: async () => 6,
    bought: async () => ({ [W1]: { mint: MINT }, [W2]: { mint: MINT } }),
    // the pass's one batch, each W's answer from `held`: a W whose answer throws is absent (refused)
    assetHeld: async (ws) => {
      const out = new Map<string, bigint>();
      for (const w of ws) await held(w.address).then((v) => void out.set(w.address, v), () => {});
      return out;
    },
  };
}

test("review P2-2: a sign out mid-read ends the held read: the call in flight is aborted, and none is sent after the stop", async () => {
  const real = globalThis.fetch;
  const sent: string[][] = [];
  let release: (() => void) | null = null;
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push((JSON.parse(String(init?.body)) as { params: [string[]] }).params[0]);
    // the answer waits until the stop aborts it
    return await new Promise<Response>((_, reject) => {
      const s = init?.signal;
      const stop = () => reject(s?.reason ?? new Error("aborted"));
      if (s?.aborted) return stop();
      s?.addEventListener("abort", stop, { once: true });
      release = stop;
    });
  }) as typeof fetch;
  try {
    const out = new AbortController();
    const p = solanaAssetHeld(pageAssetHeldRpc(out.signal, false), [{ address: W1, mint: MINT }], out.signal);
    for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(sent.length, 1, "the read went out");
    out.abort();
    await assert.rejects(p, "the sign out ends the read");
    assert.ok(release !== null);
    await assert.rejects(solanaAssetHeld(pageAssetHeldRpc(out.signal, false), [{ address: W2, mint: MINT }], out.signal));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 1, "nothing of the signed-out account's is sent after the stop");
  } finally {
    globalThis.fetch = real;
  }
});

test("a position's asset_held is the sum over its Ws, in whole SOL, and fits the kit's state schema", async () => {
  const asked: string[] = [];
  const got = await positionsPass(reads(async (a) => (asked.push(a), a === W1 ? 8_478_835n : 1_000_000_000n)));
  assert.equal(got.whole, true);
  assert.equal(got.positions.length, 1);
  assert.equal(got.positions[0]!.asset_held, "1.008478835");
  assert.deepEqual(asked.sort(), [W1, W2].sort(), "each W in the batch");
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

test("a later pass keeps each W's last asset_held while it reads (its shown rows) and when its read fails, so the Total never dips", async () => {
  const memo = passMemo();
  await positionsPass(reads(async (a) => (a === W1 ? 8_478_835n : 1_000_000_000n)), memo);
  const shown: (string | undefined)[] = [];
  const r = reads(async (a) => {
    if (a === W2) throw new Error("429");
    return 8_000_000n;
  });
  r.shown = (ps) => void shown.push(ps[0]?.asset_held);
  const wallets = r.wallets;
  r.wallets = async (only, o) => {
    const all = await wallets(only, o);
    for (const w of all) o?.each?.(w);
    return all;
  };
  const got = await positionsPass(r, memo);
  assert.equal(got.whole, false, "the failed read runs the pass again");
  assert.equal(got.positions[0]!.asset_held, "1.008", "W1 read now, W2 at its last read");
  assert.ok(shown.length > 0 && shown.every((x) => x === "1.008478835"), `rows shown while the pass reads: ${JSON.stringify(shown)}`);
  // a kept pass carries each W's last read, so a load answers with it at once
  const kept: unknown[] = [];
  const again = reads(async () => 8_000_000n);
  again.keep = async (k) => void kept.push(k);
  await positionsPass(again, memo);
  const fresh = passMemo();
  const r2 = reads(async () => {
    throw new Error("down");
  });
  r2.kept = async () => kept[0];
  assert.equal((await positionsPass(r2, fresh)).positions[0]!.asset_held, "0.016");
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
