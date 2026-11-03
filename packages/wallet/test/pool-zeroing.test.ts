// node --test packages/wallet/test/pool-zeroing.test.ts (card wallet-pool-ladder): the proof queue zeroes every W
// secret key it derives as soon as it has the address, and its copy of the seed on close(), after it freed the notes.
// A load hook wraps derive/keys.ts's freshWallet, as key-zeroing.test.ts wraps the hash functions, so each call's seed
// argument and each wallet it returns are recorded. The hook is registered before the wallet's modules load, so they
// are imported dynamically. Test seed only: the all-zero entropy of vectors/a8.json.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";

type Call = { seed: Uint8Array; out: { secretKey: Uint8Array } };
const calls: Call[] = [];
Object.assign(globalThis, { __ctFresh: calls });
registerHooks({
  load(url, context, next) {
    if (!/\/src\/derive\/keys\.ts$/.test(url)) return next(url, context);
    const real = JSON.stringify(`${url}?real`);
    const source = `export * from ${real};
import * as m from ${real};
export function freshWallet(...a) { const out = m.freshWallet(...a); globalThis.__ctFresh.push({ seed: a[0], out }); return out; }`;
    return { format: "module", source, shortCircuit: true };
  },
});

const { USDC_LADDER } = await import("../src/pool/near.ts");
const { openProofQueue } = await import("../src/pool/queue.ts");
const { closeVaults, SEED, SCOPE, signalsProver, vaultWith } = await import("./withdraw-fixture.ts");
const { solanaRestore, solanaMarkOf } = await import("../src/pool/solana-restore.ts");
const { buyWallets, solanaSpentNotes } = await import("../src/pool/buy-wallets.ts");
const { noteSecrets, noteCommitment } = await import("../src/notes/secrets.ts");
const { vaultLabelOf } = await import("@blindfill/kit");
const { keccak_256 } = await import("@noble/hashes/sha3.js");
after(closeVaults);

const zero = (b: Uint8Array): boolean => b.every((x) => x === 0);

test("every W secret key is zeroed once derived; the seed's copy stays until close, which frees the notes first", async () => {
  const v = await vaultWith([2_000_000n, 5_000_000n]);
  const pool = {
    id: "zeroing",
    chain: "sol" as const,
    scope: SCOPE,
    ladder: USDC_LADDER,
    epochMs: 60_000n,
    lifeMs: 240_000n,
    sendMarginMs: 120_000n,
    now: async () => 1_800_000_000_000n,
    trees: async () => ({ stateTree: v.stateTree, labelTree: v.labelTree, stateRoot: v.stateTree.root!, labelRoot: v.labelTree.root! }),
    bind: async () => ({ context: BigInt(calls.length), feeCap: 1n, request: null }),
  };
  calls.length = 0;
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool, provers: [signalsProver(), signalsProver()], hardwareConcurrency: 4 });
  assert.equal((await q.refresh()).made.length, 2);
  assert.equal(calls.length, 2);
  for (const c of calls) assert.ok(zero(c.out.secretKey), "W's secret key is zeroed");
  const copy = calls[0]!.seed;
  assert.notEqual(copy, SEED, "the queue derives from its own copy");
  assert.ok(!zero(copy), "the copy lives while the queue does");
  let freedFirst = false;
  const move = v.ns.move;
  v.ns.move = async (...a) => {
    if (a[1] === "HELD" && a[2] === "UNSPENT") freedFirst ||= !zero(copy);
    return move(...a);
  };
  await q.close();
  v.ns.move = move;
  assert.ok(freedFirst, "the notes are freed before the seed is zeroed");
  assert.ok(zero(copy), "close zeroes the seed's copy");
  assert.ok(!zero(SEED), "never the caller's seed");
  assert.deepEqual((await v.ns.list()).map((n) => n.state), ["UNSPENT", "UNSPENT"]);
});

test("solanaRestore zeroes each spent note's W secret key once it has the address (card notes-per-pool-sol), and so does buyWallets on its spends (card wallet-per-buy)", async () => {
  const program = "GrhFJ6E7xdXj4Yf6zxwKEdcHPVJKDTRd3sYNkKYdKbt6"; // any base58 32-byte key: a test program id
  const scope = 7n;
  const dep = { kind: "deposit", s: scope, i: 0 } as const;
  const P = noteSecrets(SEED, dep).precommitment;
  const label = vaultLabelOf(keccak_256, scope, 1n);
  const cP = noteSecrets(SEED, { kind: "change", l: label, j: 0 }).precommitment;
  const marks = {
    pre: new Map([[solanaMarkOf(program, "pre", P), { value: 10_000_000n, nonce: 1n }]]),
    spent: new Map([[solanaMarkOf(program, "spent", noteSecrets(SEED, dep).nullifierHash), 10_000_000n]]),
    slot: 1,
  };
  const from = calls.length;
  const r = solanaRestore({ seed64: SEED, program, scope, stateLeaves: [noteCommitment(10_000_000n, label, P), noteCommitment(0n, label, cP)], labelLeaves: [label], marks, gap: 2 });
  const made = calls.slice(from);
  assert.equal(r.spends.length, 1);
  assert.equal(made.length, 1, "one W derived, for the one spent note");
  assert.ok(zero(made[0]!.out.secretKey), "W's secret key is left in memory");
  // the restore of the buys' wallets (card wallet-per-buy) lists that W from this restore, and zeroes its key too
  const reader = (name: string) => ({ chain: "sol" as const, name, read: async () => ({ native: 0n, tokens: new Map<string, bigint>() }) });
  const at = calls.length;
  const ws = await buyWallets(SEED, [{ id: program, chain: "sol", spent: solanaSpentNotes(r), readers: [reader("a"), reader("b")] }]);
  assert.deepEqual(ws.map((w) => w.address), [r.spends[0]!.w]);
  assert.equal(calls.length - at, 1, "one W derived per spent note");
  assert.ok(zero(calls[at]!.out.secretKey), "buyWallets leaves W's secret key in memory");
});
