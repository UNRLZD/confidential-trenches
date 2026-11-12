// node --test packages/wallet/test/near-swap-zeroing.test.ts (card near-private-trading): W_{near,l,j}'s secret key is
// zeroed on every path of src/near/swap-delegate.ts, signed or refused. A load hook wraps derive/keys.ts's freshWallet,
// as pool-zeroing.test.ts does, so each wallet it returns is recorded; the hook is registered before the wallet's modules
// load, so they are imported dynamically. Test seed only (deposit-account.json's public 0x42 seed); the quote is the
// kit's rheaQuote replayed on recorded mainnet answers (kit fixtures/near-rhea-quotes.json).
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

const fresh: { secretKey: Uint8Array }[] = [];
Object.assign(globalThis, { __ctNearFresh: fresh });
registerHooks({
  load(url, context, next) {
    if (!/\/src\/derive\/keys\.ts$/.test(url)) return next(url, context);
    const real = JSON.stringify(`${url}?real`);
    const source = `export * from ${real};
import * as m from ${real};
export function freshWallet(...a) { const out = m.freshWallet(...a); globalThis.__ctNearFresh.push(out); return out; }`;
    return { format: "module", source, shortCircuit: true };
  },
});

const { rheaQuote } = await import("../../kit/src/near/rhea.ts");
const { nearSwapCalls } = await import("../../kit/src/trade/near/swap.ts");
const { nearSwapWallet, NearSwapDelegateRefused, signNearSwapDelegates } = await import("../src/near/swap-delegate.ts");

const SEED = new Uint8Array(64).fill(0x42);
const L = 7n, J = 1;
const MIN = 1_250_000_000_000_000_000_000n;
const zero = (b: Uint8Array) => b.every((x) => x === 0);
const { runs } = JSON.parse(readFileSync(new URL("../../kit/test/fixtures/near-rhea-quotes.json", import.meta.url), "utf8"));
const r = runs.find((x: { name: string }) => x.name === "buy RHEA through wNEAR");
const rpcs = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"].map((url) => ({
  name: url,
  async query(params: Record<string, unknown>) {
    const hit = r.log.find((l: { url: string; params: unknown }) => l.url === url && JSON.stringify(l.params) === JSON.stringify(params));
    if (!hit) throw new Error("not recorded");
    return hit.answer;
  },
})) as unknown as Parameters<typeof rheaQuote>[0]["rpcs"];
const q = await rheaQuote({ network: "mainnet", rpcs, side: r.side, token: r.token, amountIn: BigInt(r.amountIn), pools: r.pools });
const W = nearSwapWallet(SEED, L, J).id;
const request = { network: "mainnet" as const, side: q.side, token: q.token, amountIn: q.amountIn, wallet: W, slippageBps: 100 };
const calls = nearSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered: true, storageMin: MIN, lostfound: 0n }, request);
const state = { account: W, height: q.height, blockHash: q.blockHash, nonce: 9n, held: q.amountIn, registered: true, storageMin: MIN, lostfound: 0n };

/** Every key freshWallet made during `f`, which must have made at least one. */
function keysOf(f: () => unknown): Uint8Array[] {
  fresh.length = 0;
  try {
    f();
  } catch (e) {
    if (!(e instanceof NearSwapDelegateRefused)) throw e;
  }
  assert.ok(fresh.length > 0, "no key was derived");
  return fresh.map((w) => w.secretKey);
}

test("nearSwapWallet zeroes W's key once its id is read", () => {
  for (const k of keysOf(() => nearSwapWallet(SEED, L, J))) assert.ok(zero(k), "nearSwapWallet left W's secret key in memory");
});

test("signNearSwapDelegates zeroes W's key after it signs", () => {
  let out: unknown[] = [];
  const keys = keysOf(() => (out = signNearSwapDelegates(SEED, L, J, calls, request, q, state, null)));
  assert.equal(out.length, 1);
  for (const k of keys) assert.ok(zero(k), "W's secret key was left after signing");
});

test("signNearSwapDelegates zeroes W's key on a refusal after the derive: another account's read (key), a nonce at the read's range (nonce)", () => {
  const other = nearSwapWallet(SEED, L, J + 1).id;
  for (const [s, code] of [
    [{ ...state, account: other }, "key"],
    [{ ...state, nonce: BigInt(q.height) * 1_000_000n - 1n }, "nonce"],
  ] as const) {
    fresh.length = 0;
    assert.throws(() => signNearSwapDelegates(SEED, L, J, calls, request, q, s, null), (e: unknown) => e instanceof NearSwapDelegateRefused && e.code === code);
    assert.ok(fresh.length > 0, `${code}: no key was derived`);
    for (const w of fresh) assert.ok(zero(w.secretKey), `${code}: W's secret key was left after the refusal`);
  }
});
