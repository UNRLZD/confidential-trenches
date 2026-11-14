// node --test packages/wallet/test/pool-standard-sizes-evm.test.ts: every amount a Base or Robinhood pool releases is a
// rung of its 1-2-5 ladder, and every note drains to 0 (card pool-amounts-are-standard-sizes-evm, the Solana rule of
// pool-standard-sizes.test.ts on the EVM pools). A buy's and a withdraw's chunk is the pool's own (poolChunkOf), so the
// pool's piece rule decides both. Test values only: no key, no seed, no read (the pool is made with RPCs that refuse).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isRung, ladderSplit } from "../src/pool/ladder.ts";
import { EVM_LADDER, EVM_POOLS, evmPool } from "../src/pool/evm.ts";
import { poolChunkOf } from "../src/pool/pool.ts";

const E15 = 1_000_000_000_000_000n; // 0.001 ETH, the ladder's least rung
const refuses = (url: string) => Object.assign(async () => Promise.reject(new Error("no reads in this test")), { url });
const poolOf = (chain: "base" | "robinhood") =>
  evmPool({ pin: EVM_POOLS[chain]!, rpcs: [refuses("https://a.example"), refuses("https://b.example")], feeRpcs: [refuses("https://a.example"), refuses("https://b.example")], relayFee: async () => Promise.reject(new Error("no reads")), epochFee: () => 0n, salt: () => new Uint8Array(16), sleep: async () => undefined } as never);

// the chunks a buy or a withdraw releases from a note of `v`, in order, and what no chunk can take
const drain = (p: Parameters<typeof poolChunkOf>[0], v: bigint): { out: bigint[]; stuck: bigint } => {
  const out: bigint[] = [];
  let x = v;
  while (x > 0n && out.length < 64) {
    const c = poolChunkOf(p, x);
    if (c === null) break;
    out.push(c);
    x -= c;
  }
  return { out, stuck: x };
};

// notes as the pools hold them: rungs a deposit made, and a sale's deposit back, which SellDelegate makes the ETH gained
// less the fee, to the wei (contracts/pool-evm/src/SellDelegate.sol sell): test values of that shape, no rung
const SALES = [12_300_000_000_000_000n, 1_537_402_118_220_431n, 4_998_000_000_000_001n, 27_000_000_000_000_003n];
const RUNGS = ladderSplit(EVM_LADDER, 88n * E15).notes;

for (const chain of ["base", "robinhood"] as const) {
  test(`${chain}: the pool has a piece rule on its own ladder, its floor the least rung`, () => {
    const p = poolOf(chain);
    assert.ok(p.pieces !== undefined, `${chain}: no piece rule, so a chunk may leave a change no step can move`);
    assert.equal(p.pieces!.ladder, p.ladder);
    assert.equal(p.pieces!.floor, EVM_LADDER.min);
    assert.equal(p.pieces!.grid, EVM_LADDER.one);
  });

  test(`${chain}: buy, withdraw: every chunk is a rung while the change moves; a note drains to 0 with at most one last remainder off the ladder`, () => {
    const p = poolOf(chain);
    const bad: string[] = [];
    for (const v of [...RUNGS, ...SALES]) {
      const { out, stuck } = drain(p, v);
      if (stuck !== 0n) bad.push(`${v}: ${stuck} wei no release can take (${out.join(",")})`);
      const off = out.filter((c) => !isRung(EVM_LADDER, c));
      if (off.length > 1 || (off.length === 1 && out.at(-1) !== off[0])) bad.push(`${v}: off the ladder before the end (${out.join(",")})`);
      if (RUNGS.includes(v) && off.length > 0) bad.push(`${v}: a rung note released off the ladder (${out.join(",")})`);
    }
    assert.deepEqual(bad, []);
  });
}
