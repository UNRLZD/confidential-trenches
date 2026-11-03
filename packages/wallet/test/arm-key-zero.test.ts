// The key solanaArmedSigner signs with is zeroed once its signature is made (card signpage-solana-trade, the Opus
// review's plant R5). ed25519.sign is wrapped before records.ts loads, so the test sees the very key it was handed.
//   node --test test/arm-key-zero.test.ts   (from packages/wallet)
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
const keysSeen: Uint8Array[] = [];
Object.assign(globalThis, { __ctSignKeys: keysSeen });
registerHooks({
  load(url, context, next) {
    if (/\/@noble\/curves\/ed25519\.js$/.test(url)) {
      const real = JSON.stringify(`${url}?real`);
      return { format: "module", shortCircuit: true, source: `export * from ${real};
import { ed25519 as e } from ${real};
export const ed25519 = { ...e, sign: (m, k, ...r) => { globalThis.__ctSignKeys.push(k); return e.sign(m, k, ...r); } };` };
    }
    return next(url, context);
  },
});
const { solanaArmedSigner, armKey } = await import("../src/arming/records.ts");
const { entropyToWords, freshWallet, wordsToSeed64 } = await import("../src/derive/index.ts");
const L = 5n;
const seed = () => wordsToSeed64(entropyToWords(new Uint8Array(16)));
const W0 = freshWallet(seed(), "sol", L, 0);
W0.secretKey.fill(0);
test("the derived key is zero after the signature", async () => {
  const OP = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
  const rec = { v: 1, chain: "sol", l: L, j: 0, address: W0.address, role: "fresh", size_cents: 1000n, state: "READY", own: { context: "ab".repeat(32) }, spend: 1n, inflight: { op: OP, side: "buy", token: "Mint1111111111111111111111111111111111111111", txs: [] } };
  const m = new Map([[armKey("sol", L, 0), rec]]);
  const store = { keys: async () => [...m.keys()], get: async (_s: string, k: string) => m.get(k), update: async (_s: string, k: string, f: (v: unknown) => unknown) => { const n = f(m.get(k)); if (n !== undefined) m.set(k, n as never); return n; } };
  const signer = solanaArmedSigner(store as never, async () => seed(), OP);
  await signer.sign(W0.address, Uint8Array.from([1, 0, 0, 0, ...new Uint8Array(32).fill(9), 1, 2, 3]), { lastValidBlockHeight: 1 });
  signer.close();
  assert.equal(keysSeen.length, 1);
  assert.ok(keysSeen[0]!.every((x) => x === 0), "the signing key was left in memory");
});
