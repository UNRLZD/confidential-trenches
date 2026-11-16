// W_{near,l,j}'s delegates over a Rhea DCL quote (src/near/swap-delegate.ts, card near-dcl-sell): the signer runs the
// kit's dclSwapCheck on a DCL quote and nearSwapCheck on a classic one, never the other. The DCL quotes are the kit's
// dclQuote replayed on recorded mainnet answers of both providers (kit fixtures/near-dcl-quotes.json, 2026-11-16); the
// classic ones the kit's rheaQuote on kit fixtures/near-rhea-quotes.json, their signed bytes held to those the signer
// gave before this card (sha256 of the delegates, recorded at c7538f44c).
//   node --test test/near-swap-delegate-dcl.test.ts      (from packages/wallet)
/// <reference types="node" />
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base64 } from "@scure/base";
import { dclQuote, dclSwapCalls, rheaQuote, type DclQuote, type RheaQuote } from "@blindfill/kit";
import { nearSwapCalls, NearSwapRefused, type NearSwapCall, type NearSwapRequest } from "../../kit/src/trade/near/swap.ts";
import type { NearSwapWalletState } from "../../kit/src/trade/near/wallet.ts";
import { freshWallet } from "../src/derive/keys.ts";
import { encodeDelegateAction } from "../src/deposit/delegate.ts";
import { signNearSwapDelegates } from "../src/near/swap-delegate.ts";

const SEED = new Uint8Array(64).fill(0x42); // the public test seed (deposit-account.json's)
const L = 7n, J = 1;
const W = freshWallet(SEED, "near", L, J).address;
const MIN = 1_250_000_000_000_000_000_000n;
const NONCE = 224_000_000_000_000n;
const FAST = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
const HOODL = "hoodl-95275b.launchpad.justhoot.near";
const DCL = "dclv2.ref-labs.near";
const EX = "v2.ref-finance.near";
type Run = { name: string; side: "buy" | "sell"; token: string; amountIn: string; pools: (string | number)[]; log: { url: string; params: unknown; answer: unknown }[] };
const fixture = (f: string) => (JSON.parse(readFileSync(new URL(`../../kit/test/fixtures/${f}`, import.meta.url), "utf8")) as { runs: Run[] }).runs;
const replay = (r: Run) =>
  [FAST, DRPC].map((url) => ({
    name: url,
    async query(params: Record<string, unknown>) {
      const hit = r.log.find((l) => l.url === url && JSON.stringify(l.params) === JSON.stringify(params));
      if (!hit) throw new Error("not recorded");
      return structuredClone(hit.answer);
    },
  })) as unknown as Parameters<typeof rheaQuote>[0]["rpcs"];
async function dclOf(side: "buy" | "sell"): Promise<DclQuote> {
  const r = fixture("near-dcl-quotes.json").find((x) => x.side === side && x.token === HOODL)!;
  return dclQuote({ network: "mainnet", rpcs: replay(r), side, token: r.token, amountIn: BigInt(r.amountIn), pools: r.pools as string[] });
}
async function rheaOf(name: string): Promise<RheaQuote> {
  const r = fixture("near-rhea-quotes.json").find((x) => x.name === name)!;
  return rheaQuote({ network: "mainnet", rpcs: replay(r), side: r.side, token: r.token, amountIn: BigInt(r.amountIn), pools: r.pools as number[] });
}
const reqOf = (q: RheaQuote | DclQuote): NearSwapRequest => ({ network: "mainnet", side: q.side, token: q.token, amountIn: q.amountIn, wallet: W, slippageBps: 100 });
const stateOf = (q: RheaQuote | DclQuote, registered = true): NearSwapWalletState => ({ account: W, height: q.height, blockHash: q.blockHash, nonce: NONCE, held: q.amountIn, registered, storageMin: MIN, lostfound: 0n });
const dclCalls = (q: DclQuote, registered = true) => dclSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered, storageMin: MIN }, reqOf(q));
const bound = (q: RheaQuote | DclQuote) => (q.side === "sell" ? q.token : null);
const plain = (c: readonly NearSwapCall[]) => JSON.parse(JSON.stringify(c)) as NearSwapCall[];

test("S1 a DCL sell and a DCL buy sign: the registration alone, then the one Swap into DCL with the device's minimum, each W's delegate over exactly the call", async () => {
  for (const side of ["sell", "buy"] as const) {
    const q = await dclOf(side);
    const reg = signNearSwapDelegates(SEED, L, J, dclCalls(q, false), reqOf(q), q, stateOf(q, false), bound(q));
    assert.deepEqual(reg.map((d) => [d.method_name, d.receiver_id, d.nonce]), [["storage_deposit", q.tokenOut, NONCE + 1n]], side);
    const calls = dclCalls(q);
    const out = signNearSwapDelegates(SEED, L, J, calls, reqOf(q), q, stateOf(q), bound(q));
    assert.deepEqual(out.map((d) => [d.method_name, d.receiver_id, d.nonce]), [["ft_transfer_call", q.tokenIn, NONCE + 1n]], side);
    const f = calls[0]!.actions[0].FunctionCall;
    assert.equal(f.args.receiver_id, DCL);
    const floor = (q.venueOut * 9_900n) / 10_000n;
    assert.equal(f.args.msg, `{"Swap":{"pool_ids":${JSON.stringify(q.poolIds)},"output_token":"${q.tokenOut}","min_output_amount":"${floor}","skip_unwrap_near":true}}`);
    const signed = base64.decode(out[0]!.signed_delegate);
    const pub = freshWallet(SEED, "near", L, J).publicKey;
    const want = encodeDelegateAction({ sender_id: W, receiver_id: q.tokenIn, method_name: "ft_transfer_call", args: new TextEncoder().encode(JSON.stringify(f.args)), gas: BigInt(f.gas), deposit: 1n, nonce: NONCE + 1n, max_block_height: BigInt(q.height) + 120n, public_key: pub });
    assert.deepEqual(signed.slice(0, -65), want, side);
  }
});

test("S2 a classic quote signs the same bytes as before the DCL route: the registration and the swap with its claim, buy and sell", async () => {
  const before: Record<string, string> = {
    "buy RHEA through wNEAR false": "6cbf6202ce02c154ad7865628500ca600439ee5fe2e4bc943529cdc1fb3ca993",
    "buy RHEA through wNEAR true": "25dc2e76928bab372e95c88ceae516d17336bd2153eb0242f15f11280f712189",
    "sell RHEA through wNEAR false": "007f3d728c11ebb4fddbfcf546cbf9517767a4941387b9da1aee9b072c57adea",
    "sell RHEA through wNEAR true": "c1bef0ca0fa716cc70ad30b23199bb11d7f595e67c99d6a06303c1357858b3c9",
  };
  for (const name of ["buy RHEA through wNEAR", "sell RHEA through wNEAR"]) {
    const q = await rheaOf(name);
    for (const registered of [false, true]) {
      const calls = nearSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered, storageMin: MIN, lostfound: 5n }, reqOf(q));
      const out = signNearSwapDelegates(SEED, L, J, calls, reqOf(q), q, { ...stateOf(q, registered), lostfound: 5n }, bound(q));
      assert.equal(createHash("sha256").update(out.map((d) => d.signed_delegate).join(",")).digest("hex"), before[`${name} ${registered}`], `${name} ${registered}`);
    }
  }
});

test("S3 a DCL quote with classic-shaped calls is refused, and a classic quote with DCL calls: nothing signed", async () => {
  const d = await dclOf("sell");
  // the DCL swap turned into the classic one: into the classic exchange, a classic msg
  const asClassic = plain(dclCalls(d));
  const f = asClassic[0]!.actions[0].FunctionCall;
  f.args.receiver_id = EX;
  f.args.msg = JSON.stringify({ force: 0, actions: [{ pool_id: 1, token_in: HOODL, token_out: "wrap.near", min_amount_out: "1" }], skip_degen_price_sync: true, skip_unwrap_near: true });
  assert.throws(() => signNearSwapDelegates(SEED, L, J, asClassic, reqOf(d), d, stateOf(d), HOODL), NearSwapRefused);
  // only the msg classic-shaped, still into DCL
  const msgOnly = plain(dclCalls(d));
  msgOnly[0]!.actions[0].FunctionCall.args.msg = f.args.msg;
  assert.throws(() => signNearSwapDelegates(SEED, L, J, msgOnly, reqOf(d), d, stateOf(d), HOODL), (e: unknown) => e instanceof NearSwapRefused && e.code === "N4");
  // a DCL quote with a lost-found claim after its swap: DCL has none
  const claim = [...plain(dclCalls(d)), { sender_id: W, receiver_id: DCL, actions: [{ FunctionCall: { method_name: "claim_lostfound", args: { token_id: d.tokenOut }, gas: 100e12, deposit: "1" } }] }] as NearSwapCall[];
  assert.throws(() => signNearSwapDelegates(SEED, L, J, claim, reqOf(d), d, stateOf(d), HOODL), (e: unknown) => e instanceof NearSwapRefused && e.code === "N3");
  // a classic quote with the DCL Swap: into DCL, a Swap msg
  const c = await rheaOf("sell RHEA through wNEAR");
  const asDcl = plain(nearSwapCalls({ quote: c, wallet: W, slippageBps: 100, registered: true, storageMin: MIN, lostfound: 0n }, reqOf(c)));
  asDcl[0]!.actions[0].FunctionCall.args.receiver_id = DCL;
  asDcl[0]!.actions[0].FunctionCall.args.msg = JSON.stringify({ Swap: { pool_ids: [`${c.token}|wrap.near|100`], output_token: c.tokenOut, min_output_amount: "1", skip_unwrap_near: true } });
  assert.throws(() => signNearSwapDelegates(SEED, L, J, asDcl, reqOf(c), c, stateOf(c), c.token), (e: unknown) => e instanceof NearSwapRefused && e.code === "N2");
  // a classic quote dressed as DCL (venue "dcl", no pool ids): refused, never read as a DCL quote
  assert.throws(() => signNearSwapDelegates(SEED, L, J, dclCalls(d), reqOf(d), { ...c, venue: "dcl" } as unknown as DclQuote, stateOf(c), HOODL), NearSwapRefused);
});
