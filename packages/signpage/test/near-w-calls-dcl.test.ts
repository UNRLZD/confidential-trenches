// W's own Rhea DCL calls read back (src/near-w-calls.ts, card near-dcl-sell): the device learns the token a W traded and
// what its swap signed from W's own delegates, as the helper carried them, on DCL as on Rhea classic. The calls are the
// kit's dclSwapCalls on the kit's dclQuote replayed on recorded mainnet answers (kit fixtures/near-dcl-quotes.json),
// signed by W's key from the public test seed (the wallet's signNearSwapDelegates) and wrapped in a relayer's
// Transaction V0 as the helper sends it. No network.
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base64 } from "@scure/base";
import { dclQuote, dclSwapCalls, type DclQuote } from "../../kit/src/near/dcl.ts";
import type { NearSwapCall } from "../../kit/src/trade/near/swap.ts";
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import { NEAR_RHEA } from "../../kit/src/near/rhea.ts";
import type { NearSwapWalletState } from "../../kit/src/trade/near/wallet.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { signNearSwapDelegates } from "../../wallet/src/near/swap-delegate.ts";
import { nearWCallOf, nearWCallToken } from "../src/near-w-calls.ts";

const SEED = new Uint8Array(64).fill(0x42);
const W = freshWallet(SEED, "near", 7n, 1).address;
const USDC = NEAR_NETWORKS.mainnet.usdc;
const EX = NEAR_RHEA.mainnet.exchange;
const DCL = "dclv2.ref-labs.near";
const HOODL = "hoodl-95275b.launchpad.justhoot.near";
const FAST = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
type Run = { side: "buy" | "sell"; token: string; amountIn: string; pools: string[]; log: { url: string; params: unknown; answer: unknown }[] };
const { runs } = JSON.parse(readFileSync(new URL("../../kit/test/fixtures/near-dcl-quotes.json", import.meta.url), "utf8")) as { runs: Run[] };

async function quoteOf(side: "buy" | "sell"): Promise<DclQuote> {
  const r = runs.find((x) => x.side === side && x.token === HOODL)!;
  const rpcs = [FAST, DRPC].map((url) => ({ name: url, query: async (p: Record<string, unknown>) => structuredClone(r.log.find((l) => l.url === url && JSON.stringify(l.params) === JSON.stringify(p))!.answer) })) as unknown as Parameters<typeof dclQuote>[0]["rpcs"];
  return dclQuote({ network: "mainnet", rpcs, side, token: HOODL, amountIn: BigInt(r.amountIn), pools: r.pools });
}
const u = (n: bigint, bytes: number) => Array.from({ length: bytes }, (_, k) => Number((n >> BigInt(8 * k)) & 0xffn));
const bstr = (s: string) => {
  const b = new TextEncoder().encode(s);
  return [...u(BigInt(b.length), 4), ...b];
};
/** W's signed calls for the quote, each in a relayer's Transaction V0 (one Action::Delegate) as the helper sends it. */
function relayed(q: DclQuote, calls: NearSwapCall[], registered: boolean): string[] {
  const state: NearSwapWalletState = { account: W, height: q.height, blockHash: q.blockHash, nonce: 41n, held: q.amountIn, registered, storageMin: 1_250_000_000_000_000_000_000n, lostfound: 0n };
  const req = { network: "mainnet" as const, side: q.side, token: q.token, amountIn: q.amountIn, wallet: W, slippageBps: 100 };
  return signNearSwapDelegates(SEED, 7n, 1, calls, req, q, state, q.side === "sell" ? HOODL : null).map((d) => {
    const signed = base64.decode(d.signed_delegate);
    const tx = [...bstr("relayer.near"), 0, ...new Uint8Array(32).fill(7), ...u(9n, 8), ...bstr(W), ...new Uint8Array(32).fill(3), ...u(1n, 4), 8, ...signed, 0, ...new Uint8Array(64).fill(1)];
    return base64.encode(Uint8Array.from(tx));
  });
}
const callsOf = (q: DclQuote, registered = true) =>
  dclSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered, storageMin: 1_250_000_000_000_000_000_000n }, { network: "mainnet", side: q.side, token: q.token, amountIn: q.amountIn, wallet: W, slippageBps: 100 });

test("a DCL buy's swap read back: W's own Swap into DCL names the token and the minimum W signed from its own quote", async () => {
  const q = await quoteOf("buy");
  const [tx] = relayed(q, callsOf(q), true);
  const call = nearWCallOf(W, tx!);
  assert.ok(call);
  assert.deepEqual([call.receiver, call.method], [USDC, "ft_transfer_call"]);
  assert.deepEqual(nearWCallToken(call, USDC, EX), { token: HOODL, sellSwap: false, minOut: (q.venueOut * 9_900n) / 10_000n });
  // its registration names the token too
  const [reg] = relayed(q, callsOf(q, false), false);
  assert.deepEqual(nearWCallToken(nearWCallOf(W, reg!)!, USDC, EX), { token: HOODL, sellSwap: false });
});

test("a DCL sell's swap read back: the token's own transfer into DCL is a sell, with the amount W sent", async () => {
  const q = await quoteOf("sell");
  const [tx] = relayed(q, callsOf(q), true);
  const call = nearWCallOf(W, tx!)!;
  assert.deepEqual([call.receiver, JSON.parse(new TextDecoder().decode(call.args)).receiver_id], [HOODL, DCL]);
  assert.deepEqual(nearWCallToken(call, USDC, EX), { token: HOODL, sellSwap: true, amountIn: q.amountIn });
});

test("a call into neither exchange, or a DCL msg that is not a Swap to a token, names nothing", async () => {
  const q = await quoteOf("buy");
  const call = nearWCallOf(W, relayed(q, callsOf(q), true)[0]!)!;
  const withArgs = (a: Record<string, unknown>) => ({ ...call, args: new TextEncoder().encode(JSON.stringify(a)) });
  const args = JSON.parse(new TextDecoder().decode(call.args));
  assert.equal(nearWCallToken(withArgs({ ...args, receiver_id: "evil.near" }), USDC, EX), null);
  assert.equal(nearWCallToken(withArgs({ ...args, msg: JSON.stringify({ Swap: { pool_ids: [], output_token: USDC, min_output_amount: "1", skip_unwrap_near: true } }) }), USDC, EX), null);
  assert.equal(nearWCallToken(withArgs({ ...args, msg: JSON.stringify({ Deposit: {} }) }), USDC, EX), null);
  // DCL is mainnet's: a testnet exchange reads no DCL call
  assert.equal(nearWCallToken(call, USDC, NEAR_RHEA.testnet.exchange), null);
  // and DCL has no lost-found: a claim on it names nothing
  assert.equal(nearWCallToken({ ...call, receiver: DCL, method: "claim_lostfound", args: new TextEncoder().encode(JSON.stringify({ token_id: HOODL })) }, USDC, EX), null);
});
