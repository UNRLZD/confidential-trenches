// node --test packages/wallet/test/pool-standard-sizes-evm.test.ts: every amount that leaves the Base and Robinhood
// pools is a rung of the 1-2-5 ladder from 0.001 ETH (card evm-pool-amounts-are-standard-sizes), as on Solana
// (./pool-standard-sizes.test.ts). Read on mainnet 14 Nov 10:0xZ, two RPCs each: Robinhood's pool holds a sale's deposit
// back of 1,880,137,434,291,065 wei, the user's own note; the proof queue's chunk of it was the largest rung, 0.001 ETH,
// which leaves 880,137,434,291,065 wei in the pool, under the least rung, where no release can ever take it. Test values
// only: no key, no seed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evmPool, EVM_LADDER, type EvmRpc } from "../src/pool/evm.ts";
import { isRung } from "../src/pool/ladder.ts";
import { poolChunkOf } from "../src/pool/pool.ts";

const never = (url: string): EvmRpc => Object.assign(async () => {
  throw new Error("no read in this test");
}, { url }) as EvmRpc;
// the pool's own object, as the signing page makes it: no read before a pass
const POOL = evmPool({
  pin: { network: "robinhood", pool: "0x9306359433127c4f3be426f6faeb00a3c41f66db", feeRecipient: "0x000000000000000000000000000000000000fee1", fromBlock: 1n },
  rpcs: [never("https://a.example"), never("https://b.example")],
  feeRpcs: [never("https://c.example"), never("https://d.example")],
  relayFee: async () => {
    throw new Error("no read in this test");
  },
  epochFee: () => 0n,
  salt: () => new Uint8Array(16),
  sleep: async () => undefined,
} as unknown as Parameters<typeof evmPool>[0]);

const E15 = 10n ** 15n;
// the chunks the queue proves from a note of `v`, in order, until it is spent (or none moves it)
const drain = (v: bigint): { chunks: bigint[]; left: bigint } => {
  const chunks: bigint[] = [];
  let x = v;
  while (x > 0n && chunks.length < 64) {
    const c = poolChunkOf(POOL, x);
    if (c === null) break;
    chunks.push(c);
    x -= c;
  }
  return { chunks, left: x };
};

test("the pool carries the piece rule: the 0.0001 ETH grid (MIN_DEPOSIT), the 0.001 ETH floor and least rung, an older note from 0.0001 ETH whole", () => {
  assert.deepEqual((POOL as { pieces?: unknown }).pieces, { grid: 10n ** 14n, floor: E15, ladder: EVM_LADDER, least: 10n ** 14n });
});

test("the sale's 1,880,137,434,291,065 wei note on Robinhood moves to its last wei: released whole once, never a rung that strands the rest", () => {
  assert.deepEqual(drain(1_880_137_434_291_065n), { chunks: [1_880_137_434_291_065n], left: 0n });
});

test("a note a step makes (a rung) drains in rungs to 0, and a change it leaves is a rung or at least the least rung", () => {
  for (const v of [E15, 2n * E15, 5n * E15, 10n * E15, 20n * E15, 3n * E15, 7n * E15, 12n * E15]) {
    const d = drain(v);
    assert.equal(d.left, 0n, `${v}: ${d.left} wei left in the pool`);
    // a rung note, or one the ladder's sums make (3 = 2 + 1, 7 = 5 + 2, 12 = 10 + 2), only ever leaves in rungs
    for (const c of d.chunks) assert.ok(isRung(EVM_LADDER, c), `${v}: a release of ${c}, off the ladder`);
  }
});

test("an older note off the ladder leaves at most one release off it, its last remainder, whole", () => {
  for (const v of [1_100_000_000_000_000n, 2_500_000_000_000_001n, 6_660_000_000_000_000n, 900_000_000_000_000n]) {
    const d = drain(v);
    assert.equal(d.left, 0n, `${v}: ${d.left} wei left in the pool`);
    assert.ok(d.chunks.filter((c) => !isRung(EVM_LADDER, c)).length <= 1, `${v}: ${d.chunks.join(", ")}`);
  }
});
