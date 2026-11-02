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
import { after, test } from "node:test";

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
const { armingAccount } = await import("../src/arming/accounts.ts");
const { depositDelegate, DepositDelegateRefused } = await import("../src/deposit/delegate.ts");
const keys = await import("../src/derive/keys.ts");
const { noteSecretsFromWords } = await import("../src/notes/secrets.ts");
const { replayDepositReads } = await import("./replay-deposit-reads.ts");
const { solanaRestore, solanaMarkOf } = await import("../src/pool/solana-restore.ts");
const { noteSecrets, noteCommitment } = await import("../src/notes/secrets.ts");
const { vaultLabelOf } = await import("@blindfill/kit");
const { keccak_256 } = await import("@noble/hashes/sha3.js");

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

test("armingAccount zeroes the copy of A's key it derives for the public side", () => {
  const got = only(() => armingAccount(SEED, 1n, 0));
  assert.equal(got.length, 1);
  assert.equal(got[0]!.length, 32);
  assert.ok(zero(got[0]!), "armingAccount left A's secret key in memory");
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

test("solanaRestore zeroes each spent note's W key it derives for the W's address (card notes-per-pool-sol)", () => {
  const program = "GrhFJ6E7xdXj4Yf6zxwKEdcHPVJKDTRd3sYNkKYdKbt6"; // any base58 32-byte key: a test program id
  const scope = 7n;
  const P = noteSecrets(SEED, { kind: "deposit", s: scope, i: 0 }).precommitment;
  const label = vaultLabelOf(keccak_256, scope, 1n);
  const cP = noteSecrets(SEED, { kind: "change", l: label, j: 0 }).precommitment;
  const marks = {
    pre: new Map([[solanaMarkOf(program, "pre", P), { value: 10_000_000n, nonce: 1n }]]),
    spent: new Map([[solanaMarkOf(program, "spent", noteSecrets(SEED, { kind: "deposit", s: scope, i: 0 }).nullifierHash), 10_000_000n]]),
    slot: 1,
  };
  const leaves = [noteCommitment(10_000_000n, label, P), noteCommitment(0n, label, cP)];
  let spends = 0;
  const got = only(() => (spends = solanaRestore({ seed64: SEED, program, scope, stateLeaves: leaves, labelLeaves: [label], marks, gap: 2 }).spends.length));
  assert.equal(spends, 1);
  const keys = got.filter((b) => b.length === 32 || b.length === 64);
  assert.ok(keys.length > 0, "the hook saw the W derive");
  assert.ok(got.every(zero), "solanaRestore left a derived secret in memory");
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

test("REVIEW M31: bindDeposit zeroes its own copy of the seed", async () => {
  const { bindDeposit } = await import("../src/deposit/bind.ts");
  const { openWalletStore } = await import("../src/store/index.ts");
  const { openNoteStore } = await import("../src/notes/store.ts");
  const { IDBFactory } = await import("fake-indexeddb");
  const ws = await openWalletStore({ indexedDB: new IDBFactory() });
  const store = await openNoteStore(ws);
  const pub = depositAccount(SEED, 1n, 0).publicKey;
  const rpcs = replayDepositReads("testnet", pub).map((r) => ({ ...r, tx: async () => ({}) }));
  await onlyAsync(() => bindDeposit(SEED, { network: "testnet", s: 1n, i: 0, noteId: "f".repeat(32), amount: 25_000_000n }, { store, rpcs: rpcs as never }).catch(() => {}));
  const ikm = bytesIn("hkdf").map((a) => a[0]!).filter((k) => k !== SEED && k.length === 64);
  assert.ok(ikm.length >= 1, "the bind derived U from its copy");
  for (const k of ikm) assert.ok(zero(k), "bindDeposit's copy of the seed was left");
  store.close();
  ws.close();
});

test("withdrawRequest zeroes its own copy of the seed, handed back or refused after the proof", async () => {
  const { withdrawRequest } = await import("../src/withdraw/request.ts");
  const fx = await import("./withdraw-fixture.ts");
  after(fx.closeVaults);
  for (const fail of [false, true]) {
    const v = await fx.vaultWith();
    if (fail) v.failPut.on = (rec) => (rec as { state?: string }).state === "RESERVED";
    const got = await onlyAsync(() => withdrawRequest(fx.argsFor(v, fx.signalsProver())).catch((e: Error) => assert.match(e.message, /refused the write/)));
    // the spent note's, the change note's and the refund note's secrets: each master's HKDF ran on the request's copy
    const ikm = bytesIn("hkdf").map((a) => a[0]!);
    assert.ok(ikm.length >= 3, "the request derived its notes' secrets");
    for (const k of ikm) {
      assert.notEqual(k, fx.SEED);
      assert.ok(zero(k), `withdrawRequest's copy of the seed was left (${fail ? "refused" : "handed back"})`);
    }
    for (const b of got) assert.ok(zero(b), `a ${b.length}-byte derive was left`);
    assert.ok(!zero(fx.SEED));
  }
});
