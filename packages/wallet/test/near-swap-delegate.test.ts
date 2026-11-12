// W_{near,l,j}'s NEP-366 delegates over the kit's NEAR swap calls (src/near/swap-delegate.ts). The quotes are real:
// the kit's rheaQuote replayed on recorded mainnet answers of both providers (kit fixtures/near-rhea-quotes.json). The
// encoding is held to a delegate that landed: a claim_lostfound on v2.ref-finance.near by an implicit account, carried
// by a relayer (tx DETpSaKYz4czkWWZQiW9vcNptjqPNaj5ZYKPVk4xvbyE, block 219833593), whose signature must verify over
// our bytes of its fields.
//   node --test test/near-swap-delegate.test.ts      (from packages/wallet)
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { rheaQuote, type RheaQuote } from "../../kit/src/near/rhea.ts";
import { nearSwapCalls, NearSwapRefused, type NearSwapCall, type NearSwapRequest } from "../../kit/src/trade/near/swap.ts";
import { freshWallet } from "../src/derive/keys.ts";
import { encodeDelegateAction, NEP366_PREFIX } from "../src/deposit/delegate.ts";
import type { NearSwapWalletState } from "../../kit/src/trade/near/wallet.ts";
import { NEAR_SWAP_READ_AGE_MAX, nearSwapWallet, NearSwapDelegateRefused, signNearSwapDelegates, type NearSwapDelegateRefusalCode } from "../src/near/swap-delegate.ts";

const SEED = new Uint8Array(64).fill(0x42); // the public test seed (deposit-account.json's)
const L = 7n, J = 1;
const W = freshWallet(SEED, "near", L, J).address;
const MIN = 1_250_000_000_000_000_000_000n;
const RHEA = "token.rhealab.near";
const NONCE = 224_000_000_000_000n;
const FAST = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
const { runs } = JSON.parse(readFileSync(new URL("../../kit/test/fixtures/near-rhea-quotes.json", import.meta.url), "utf8"));

async function quoteOf(name: string): Promise<RheaQuote> {
  const r = runs.find((x: { name: string }) => x.name === name);
  const rpcs = [FAST, DRPC].map((url) => ({
    name: url,
    async query(params: Record<string, unknown>) {
      const hit = r.log.find((l: { url: string; params: unknown }) => l.url === url && JSON.stringify(l.params) === JSON.stringify(params));
      if (!hit) throw new Error("not recorded");
      return hit.answer;
    },
  })) as unknown as Parameters<typeof rheaQuote>[0]["rpcs"];
  return rheaQuote({ network: "mainnet", rpcs, side: r.side, token: r.token, amountIn: BigInt(r.amountIn), pools: r.pools });
}
const reqOf = (q: RheaQuote, wallet = W): NearSwapRequest => ({ network: "mainnet", side: q.side, token: q.token, amountIn: q.amountIn, wallet, slippageBps: 100 });
const callsOf = (q: RheaQuote, wallet = W, registered = true, lostfound = 5n) => nearSwapCalls({ quote: q, wallet, slippageBps: 100, registered, storageMin: MIN, lostfound }, reqOf(q, wallet));
// W read just before the quote: at the quote's own block unless `o` says otherwise
const stateOf = (q: RheaQuote, registered = true, o: Partial<NearSwapWalletState> = {}): NearSwapWalletState => ({
  account: W, height: q.height, blockHash: q.blockHash, nonce: NONCE, held: q.amountIn, registered, storageMin: MIN, lostfound: 5n, ...o,
});
const verifies = (delegate: Uint8Array, sig: Uint8Array, pub: Uint8Array) => {
  const signable = new Uint8Array(4 + delegate.length);
  new DataView(signable.buffer).setUint32(0, NEP366_PREFIX, true);
  signable.set(delegate, 4);
  return ed25519.verify(sig, sha256(signable), pub);
};
function refused(f: () => unknown, code: NearSwapDelegateRefusalCode) {
  assert.throws(f, (e: unknown) => {
    assert.ok(e instanceof NearSwapDelegateRefused, String(e));
    assert.equal(e.code, code, e.message);
    return true;
  });
}

test("D1 W is the fresh wallet W_{near,l,j} at m/44'/397'/a'/b': its id is the hex of its key, no key leaves", () => {
  const w = nearSwapWallet(SEED, L, J);
  assert.equal(w.id, W);
  assert.match(w.id, /^[0-9a-f]{64}$/);
  assert.match(w.path, /^m\/44'\/397'\/\d+'\/\d+'$/);
  assert.deepEqual(Object.keys(w).sort(), ["id", "path"]);
  assert.notEqual(nearSwapWallet(SEED, L, J + 1).id, W);
});

test("D2 a buy: one delegate per call in order, nonces n+1.., one window, each signature W's over exactly the call", async () => {
  const q = await quoteOf("buy RHEA through wNEAR");
  // the registration's own round, then the swap and the claim once it reads back
  const reg = signNearSwapDelegates(SEED, L, J, callsOf(q, W, false), reqOf(q), q, stateOf(q, false), null);
  assert.deepEqual(reg.map((d) => [d.method_name, d.receiver_id, d.nonce]), [["storage_deposit", RHEA, NONCE + 1n]]);
  assert.throws(() => signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, stateOf(q, false), null), (e: unknown) => e instanceof NearSwapRefused && e.code === "N3");
  const calls = callsOf(q);
  const out = signNearSwapDelegates(SEED, L, J, calls, reqOf(q), q, stateOf(q), null);
  assert.equal(out.length, 2);
  const pub = freshWallet(SEED, "near", L, J).publicKey;
  out.forEach((d, k) => {
    const c = calls[k]!;
    const f = c.actions[0].FunctionCall;
    assert.equal(d.sender_id, W);
    assert.equal(d.receiver_id, c.receiver_id);
    assert.equal(d.method_name, f.method_name);
    assert.equal(d.nonce, NONCE + 1n + BigInt(k));
    assert.equal(d.max_block_height, BigInt(q.height) + 120n);
    assert.equal(d.public_key, `ed25519:${base58.encode(pub)}`);
    const signed = base64.decode(d.signed_delegate);
    const delegate = signed.slice(0, -65);
    assert.equal(signed[signed.length - 65], 0);
    const want = encodeDelegateAction({
      sender_id: W, receiver_id: c.receiver_id, method_name: f.method_name, args: new TextEncoder().encode(JSON.stringify(f.args)),
      gas: BigInt(f.gas), deposit: BigInt(f.deposit), nonce: d.nonce, max_block_height: d.max_block_height, public_key: pub,
    });
    assert.deepEqual(delegate, want);
    assert.ok(verifies(delegate, signed.slice(-64), pub));
  });
  assert.deepEqual(out.map((d) => d.receiver_id), [q.tokenIn, "v2.ref-finance.near"]);
});

test("D3 our bytes of a delegate that landed on mainnet carry its own signature", () => {
  const pub = base58.decode("EQEbEiZZ8BG5ZWxbUGR5w5PgrAH49hS8QzGvCaMZsDop");
  const sig = base58.decode("51dCykYaJLqBJ8JHP7rDbRrD8zg9xKPWas5R1PN8CtBKd2AxVfXwMJNzXDbhzRGCESCNWtNSdKEzCMoTbCQ3bDpb");
  const CLAIMED = "purge-558.meme-cooking.near"; // the args were {"token_id": CLAIMED}, this JSON's bytes exactly
  const fields = {
    sender_id: "c71ba7bd78110d8470d534684cde3fb61c17997349e8430e7bd37e55f97b3f5b", receiver_id: "v2.ref-finance.near", method_name: "claim_lostfound",
    args: new TextEncoder().encode(JSON.stringify({ token_id: CLAIMED })), gas: 30_000_000_000_000n, deposit: 1n,
    nonce: 219_833_572_000_001n, max_block_height: 219_834_189n, public_key: pub,
  };
  assert.ok(verifies(encodeDelegateAction(fields), sig, pub));
  assert.ok(!verifies(encodeDelegateAction({ ...fields, nonce: fields.nonce + 1n }), sig, pub));
});

test("D4 A11: a W bound to another token is refused on a buy; a sell needs the W's own token", async () => {
  const buy = await quoteOf("buy RHEA through wNEAR");
  refused(() => signNearSwapDelegates(SEED, L, J, callsOf(buy), reqOf(buy), buy, stateOf(buy), "wrap.near"), "A11");
  assert.equal(signNearSwapDelegates(SEED, L, J, callsOf(buy), reqOf(buy), buy, stateOf(buy), RHEA).length, 2);
  const sell = await quoteOf("sell RHEA through wNEAR");
  const calls = callsOf(sell, W, true, 0n);
  refused(() => signNearSwapDelegates(SEED, L, J, calls, reqOf(sell), sell, stateOf(sell), null), "A11");
  refused(() => signNearSwapDelegates(SEED, L, J, calls, reqOf(sell), sell, stateOf(sell), "wrap.near"), "A11");
  assert.equal(signNearSwapDelegates(SEED, L, J, calls, reqOf(sell), sell, stateOf(sell), RHEA).length, 1);
});

test("D5 only W_{near,l,j} signs, only its own read: another wallet's calls or another account's read are refused", async () => {
  const q = await quoteOf("buy RHEA through wNEAR");
  const other = freshWallet(SEED, "near", L, J + 1).address;
  refused(() => signNearSwapDelegates(SEED, L, J, callsOf(q, other), reqOf(q, other), q, stateOf(q, true, { account: other }), null), "key");
  refused(() => signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, stateOf(q, true, { account: other }), null), "key");
});

test("D6 a call changed after it was built is refused by the kit's check before W's key signs", async () => {
  const q = await quoteOf("buy RHEA through wNEAR");
  const calls = JSON.parse(JSON.stringify(callsOf(q))) as NearSwapCall[];
  calls[0]!.actions[0].FunctionCall.gas = 300e12;
  assert.throws(() => signNearSwapDelegates(SEED, L, J, calls, reqOf(q), q, stateOf(q), null), (e: unknown) => e instanceof NearSwapRefused && e.code === "N7");
  const more = JSON.parse(JSON.stringify(callsOf(q))) as NearSwapCall[];
  more[0]!.actions[0].FunctionCall.args.receiver_id = W;
  assert.throws(() => signNearSwapDelegates(SEED, L, J, more, reqOf(q), q, stateOf(q), null), NearSwapRefused);
});

test("D7 the window is 1..600 blocks and no nonce reaches the read height x 1,000,000", async () => {
  const q = await quoteOf("buy RHEA through wNEAR");
  refused(() => signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, stateOf(q), null, 601), "window");
  refused(() => signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, stateOf(q), null, 0), "window");
  assert.equal(signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, stateOf(q), null, 600)[0]!.max_block_height, BigInt(q.height) + 600n);
  // two calls: n+2 must stay under height x 10^6
  const edge = stateOf(q, true, { nonce: BigInt(q.height) * 1_000_000n - 2n });
  refused(() => signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, edge, null), "nonce");
  assert.equal(signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, { ...edge, nonce: edge.nonce - 1n }, null).length, 2);
  refused(() => signNearSwapDelegates(SEED.slice(0, 32), L, J, callsOf(q), reqOf(q), q, stateOf(q), null), "input");
});

test("D8 W's state is taken whole and must be the quote's moment: a read past the quote, or more than NEAR_SWAP_READ_AGE_MAX blocks before it, is refused stale before W's key is derived", async () => {
  const q = await quoteOf("buy RHEA through wNEAR");
  // the probe's case: a read 5,000,000 blocks past the quote sets the window and the nonce range
  refused(() => signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, stateOf(q, true, { height: q.height + 5_000_000 }), null), "stale");
  // a quote one block older than the read
  refused(() => signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, stateOf(q, true, { height: q.height + 1 }), null), "stale");
  // the read NEAR_SWAP_READ_AGE_MAX blocks before the quote signs (its height sets the window), one more is refused
  const at = signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, stateOf(q, true, { height: q.height - NEAR_SWAP_READ_AGE_MAX }), null);
  assert.equal(at[0]!.max_block_height, BigInt(q.height - NEAR_SWAP_READ_AGE_MAX) + 120n);
  refused(() => signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, stateOf(q, true, { height: q.height - NEAR_SWAP_READ_AGE_MAX - 1 }), null), "stale");
  // a state that is not one: refused as input
  refused(() => signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, { ...stateOf(q), registered: "yes" } as unknown as NearSwapWalletState, null), "input");
  refused(() => signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, { ...stateOf(q), storageMin: 1 } as unknown as NearSwapWalletState, null), "input");
});

test("D9 the registration and its deposit come from W's state, never a caller's word: the swap's calls against a state reading unregistered are refused, the registration against one reading registered too", async () => {
  const q = await quoteOf("buy RHEA through wNEAR");
  assert.throws(() => signNearSwapDelegates(SEED, L, J, callsOf(q), reqOf(q), q, stateOf(q, false), null), (e: unknown) => e instanceof NearSwapRefused && e.code === "N3");
  assert.throws(() => signNearSwapDelegates(SEED, L, J, callsOf(q, W, false), reqOf(q), q, stateOf(q, true), null), NearSwapRefused);
  // the storage minimum the registration attaches is the state's
  assert.throws(() => signNearSwapDelegates(SEED, L, J, callsOf(q, W, false), reqOf(q), q, stateOf(q, false, { storageMin: MIN + 1n }), null), NearSwapRefused);
  assert.equal(signNearSwapDelegates(SEED, L, J, callsOf(q, W, false), reqOf(q), q, stateOf(q, false), null).length, 1);
});
