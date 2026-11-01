// Every secret byte buffer our code derives and does not hand back is zeroed (card wallet-deposit-delegate, review of
// 50df56c item 2-3).   node --test test/key-zeroing.test.ts   (from packages/wallet)
// A load hook wraps the three functions every derive goes through, @noble/hashes' hkdf and hmac and @scure/bip39's
// mnemonicToSeedSync, so each buffer they return and each buffer passed into hkdf and hmac is recorded; after a call,
// each recorded buffer the call did not hand back (and not the caller's own input) must read all zero. It also records
// every @scure/bip32 HDKey node made, so each can be checked wiped. The hook is registered before the wallet's modules
// load, so they are imported dynamically.
// What the libraries keep inside (noble's HKDF PRK and HMAC state, scure's BIP-32 steps and PBKDF2) is theirs, not ours.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const seen: Uint8Array[] = [];
const inputs: { fn: string; args: unknown[] }[] = [];
const nodes: { privateKey: Uint8Array | null }[] = [];
Object.assign(globalThis, { __ctDerived: seen, __ctInputs: inputs, __ctNodes: nodes });
const WRAP: [RegExp, string][] = [
  [/\/@noble\/hashes\/hkdf\.js$/, "hkdf"],
  [/\/@noble\/hashes\/hmac\.js$/, "hmac"],
  [/\/@scure\/bip39\/index\.js$/, "mnemonicToSeedSync"],
];
registerHooks({
  load(url, context, next) {
    if (/\/@scure\/bip32\/index\.js$/.test(url)) {
      const real = JSON.stringify(`${url}?real`);
      const source = `export * from ${real};
import { HDKey } from ${real};
const derive = HDKey.prototype.deriveChild, master = HDKey.fromMasterSeed;
HDKey.prototype.deriveChild = function (i) { const c = derive.call(this, i); globalThis.__ctNodes.push(c); return c; };
HDKey.fromMasterSeed = function (...a) { const n = master.apply(this, a); globalThis.__ctNodes.push(n); return n; };`;
      return { format: "module", source, shortCircuit: true };
    }
    const hit = WRAP.find(([re]) => re.test(url));
    if (!hit) return next(url, context);
    const real = JSON.stringify(`${url}?real`);
    const name = hit[1];
    // hmac.create is hkdf's own path; it is passed through and not recorded (its state is the library's).
    const source = `export * from ${real};
import * as m from ${real};
export function ${name}(...a) { globalThis.__ctInputs.push({ fn: "${name}", args: a }); const out = m.${name}(...a); globalThis.__ctDerived.push(out); return out; }
if (m.${name}.create) ${name}.create = m.${name}.create;`;
    return { format: "module", source, shortCircuit: true };
  },
});

const { depositAccount, NEAR_NETWORKS } = await import("../src/deposit/account.ts");
const { depositDelegate, DepositDelegateRefused } = await import("../src/deposit/delegate.ts");
const keys = await import("../src/derive/keys.ts");
const { noteSecretsFromWords } = await import("../src/notes/secrets.ts");
const { replayDepositReads } = await import("./replay-deposit-reads.ts");

const SEED = new Uint8Array(64).fill(0x42); // the public test seed
const zero = (b: Uint8Array) => b.every((x) => x === 0);
function only(f: () => unknown): Uint8Array[] {
  seen.length = inputs.length = nodes.length = 0;
  f();
  return [...seen];
}
async function onlyAsync(f: () => Promise<unknown>): Promise<Uint8Array[]> {
  seen.length = inputs.length = nodes.length = 0;
  await f();
  return [...seen];
}
const bytesIn = (fn: string) => inputs.filter((x) => x.fn === fn).map((x) => x.args.filter((a): a is Uint8Array => a instanceof Uint8Array));

test("the hook sees a derive: depositId's key is recorded, and it is the caller's to zero", () => {
  let u: ReturnType<typeof keys.depositId> | undefined;
  const got = only(() => (u = keys.depositId(SEED, 1n, 0)));
  assert.equal(got.length, 1);
  assert.equal(got[0], u!.secretKey);
  assert.ok(!zero(got[0]!));
  u!.secretKey.fill(0);
});

test("depositAccount zeroes the copy of U's key it derives for the public side", () => {
  const got = only(() => depositAccount(SEED, 1n, 0));
  assert.equal(got.length, 1);
  assert.equal(got[0]!.length, 32);
  assert.ok(zero(got[0]!), "depositAccount left U's secret key in memory");
});

test("depositDelegate zeroes both copies of U's key: the read's and the signer's, signed or refused", async () => {
  const pub = depositAccount(SEED, 1n, 0).publicKey;
  const args = { network: "testnet" as const, amount: 25_000_000n, precommitment: 7n };
  const got = await onlyAsync(() => depositDelegate(SEED, 1n, 0, args, replayDepositReads("testnet", pub)));
  assert.equal(got.length, 2);
  for (const b of got) assert.ok(zero(b), "a copy of U's secret key was left after signing");
  // Both derives ran on depositDelegate's own copy of the seed, not the caller's, and that copy is zeroed.
  const ikm = bytesIn("hkdf").map((a) => a[0]!);
  assert.equal(ikm.length, 2);
  for (const k of ikm) {
    assert.notEqual(k, SEED);
    assert.ok(zero(k), "depositDelegate's copy of the seed was left");
  }
  assert.ok(!zero(SEED));
  // Refused inside the signer, after its derive (P not below p): still zeroed.
  const bad = await onlyAsync(() =>
    depositDelegate(SEED, 1n, 0, { ...args, precommitment: 1n << 254n }, replayDepositReads("testnet", pub)).catch((e) => {
      assert.ok(e instanceof DepositDelegateRefused);
    }),
  );
  assert.equal(bad.length, 2);
  for (const b of bad) assert.ok(zero(b), "a copy of U's secret key was left after a refusal");
  assert.equal(NEAR_NETWORKS.testnet.vault.length > 0, true);
});

test("noteSecretsFromWords zeroes the seed it makes from the words, and the masters' HKDF bytes", () => {
  const words = keys.entropyToWords(new Uint8Array(16)); // a public test value, never printed
  const got = only(() => noteSecretsFromWords(words, { kind: "deposit", s: 1n, i: 0 }));
  assert.ok(got.some((b) => b.length === 64), "no seed recorded");
  for (const b of got) assert.ok(zero(b), `a ${b.length}-byte derive was left`);
});

test("SLIP-10 zeroes every step's HMAC output; a fresh ed25519 wallet zeroes its path bytes and chain code", () => {
  const steps = [44, 501, 1, 2].map((x) => x + 0x80000000);
  let out: { key: Uint8Array; chainCode: Uint8Array } | undefined;
  const got = only(() => (out = keys.slip10Ed25519(SEED, steps)));
  assert.equal(got.length, steps.length + 1);
  for (const b of got) assert.ok(zero(b), "a SLIP-10 step's I was left");
  // Each step's HMAC inputs: the parent chain code (its key, a view of the parent's I) and its data (0 || parent key || index).
  // The first HMAC takes the curve's constant and the caller's seed, which are not ours to zero.
  const ins = bytesIn("hmac");
  assert.equal(ins.length, steps.length + 1);
  for (const [k, [chainCode, data]] of ins.slice(1).entries()) {
    assert.ok(zero(chainCode!), `step ${k}: the parent chain code was left`);
    assert.ok(zero(data!), `step ${k}: the step's data (with the parent key) was left`);
  }
  assert.ok(!zero(out!.key));
  out!.key.fill(0);
  out!.chainCode.fill(0);
  let w: ReturnType<typeof keys.freshWallet> | undefined;
  const fw = only(() => (w = keys.freshWallet(SEED, "sol", 1n, 0)));
  for (const b of fw) assert.ok(zero(b), `a ${b.length}-byte derive was left`);
  assert.ok(!zero(w!.secretKey));
  w!.secretKey.fill(0);
});

test("a fresh secp256k1 wallet wipes every BIP-32 node it made, the master and the leaf included", () => {
  let w: ReturnType<typeof keys.freshWallet> | undefined;
  only(() => (w = keys.freshWallet(SEED, "evm", 1n, 0)));
  assert.equal(nodes.length, 5); // the master and the four path steps
  for (const [k, n] of nodes.entries()) assert.equal(n.privateKey, null, `node ${k} keeps its private key`);
  assert.ok(!zero(w!.secretKey)); // the copy handed back
  w!.secretKey.fill(0);
});
