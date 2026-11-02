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
