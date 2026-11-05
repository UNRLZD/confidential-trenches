// The testnet build's pool table (card signpage-pool-pins, src/pools.ts): PAGE_POOLS is the page network's pins, each
// under the id and scope its pool kind gives it, so the proof queue's ready proofs reach state.pools as `ready` and, once
// the Rent sysvar is read, as `tap_max`: what the trade box needs to turn Buy on. Its own file: the network is read
// once, at import, so this process runs as the testnet build does (test/pools.test.ts runs the mainnet one).
//   node --test test/pools-testnet.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import type { EvmPoolPin } from "../../wallet/src/pool/evm.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { SOL_POOLS, SOL_TIP_CAP, solanaEpochFee, solanaPool } = await import("../../wallet/src/pool/solana.ts");
const { EVM_POOLS, evmPool } = await import("../../wallet/src/pool/evm.ts");
const { solanaTapSpendOf } = await import("../../wallet/src/pool/balances.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { stateOf } = await import("../src/state.ts");
const { SIGNPAGE_RESULT_SCHEMAS } = await import("../../kit/src/signpage/schema.ts");
// the whole module, so a test that reads an export main has not got fails alone
const pools = await import("../src/pools.ts");

const SIGNED_IN = stateOf(true, { source: "code", code_saved: true }, []);
// two RPC functions the pool kinds take (never called: building a pool kind reads nothing)
const RPCS = [async () => null, async () => null] as const;
const never = async (): Promise<never> => {
  throw new Error("not read");
};
// the Solana pool kind the testnet build's proof queue runs (src/pool-testnet.ts openQueue): its id is every ready
// proof's poolId, its scope every note's
const KIND = solanaPool({ pin: SOL_POOLS.devnet!, rpcs: RPCS, relayFee: never });
// the Base Sepolia pool of pool-evm-deploy's record, as a pin (a test pin: EVM_POOLS holds none yet)
const BASE_SEPOLIA = JSON.parse(readFileSync(new URL("../../../scripts/live-checks/pool-evm-deploy.base-sepolia.json", import.meta.url), "utf8")) as {
  contracts: { PrivacyPoolSimple: { address: string } };
};
const EVM_PIN: EvmPoolPin = {
  network: "base-sepolia",
  pool: BASE_SEPOLIA.contracts.PrivacyPoolSimple.address.replace(/^0x(.{4})/, (_, a: string) => `0x${a.toUpperCase()}`),
  feeRecipient: "0x49f2425b7f33f3a10912de8add6839226ce663a2",
  fromBlock: 1n,
};
const evmKind = (pin: EvmPoolPin) => evmPool({ pin, rpcs: RPCS, feeRpcs: [async () => null, async () => 1] as const, relayFee: never, epochFee: () => 0n });
// the Rent sysvar as Solana has it: 3,480 lamports per byte-year, exempt at 2 years
const RENT = { lamportsPerByte: 3480n, factor: 2n } as const;
const CHUNK = 50_000_000n; // 0.05 SOL
// the epoch fee the device computes at that rent (1,700,000 lamports), each proof's fee cap
const FEE_CAP = solanaEpochFee(RENT).fee;
const held = (id: string, attempt: string, value = CHUNK): NoteRecord => ({
  id,
  ref: { kind: "deposit", s: KIND.scope, i: 0 },
  scope: KIND.scope,
  precommitment: 1n,
  state: "HELD",
  attempt,
  deadlineMs: 1n,
  leaf: { value, label: 1n, commitment: 1n, leafIndex: 0n },
});
const ready = (noteId: string, attempt: string, chunk = CHUNK) => [{ noteId, attempt, poolId: KIND.id, chunk, binding: { feeCap: FEE_CAP, request: { tipCap: SOL_TIP_CAP } } }];

test("the testnet build's pool table is its pins: the devnet Solana pool under its pool kind's id and scope, and each pinned EVM testnet pool", () => {
  assert.equal(POOL_TESTNET, true, "this process runs as the testnet build");
  const evm = (["base", "robinhood"] as const).flatMap((chain) => {
    const pin = EVM_POOLS[chain === "base" ? "base-sepolia" : "robinhood-testnet"];
    if (pin === undefined) return [];
    const k = evmKind(pin);
    return [{ id: k.id, chain, scope: k.scope, asset: "ETH" }];
  });
  const table = pools.PAGE_POOLS.map((p) => ({ id: p.id, chain: p.chain, scope: p.scope, asset: p.asset }));
  assert.deepEqual(table, [{ id: KIND.id, chain: "solana", scope: KIND.scope, asset: "SOL" }, ...evm]);
  assert.ok(Object.isFrozen(pools.PAGE_POOLS));
});

test("a ready proof of the devnet pool reaches state.pools as ready, and as tap_max once the Rent sysvar is read", async () => {
  const notes = async () => [held("n1", "a1")];
  const before = await pools.withPools(SIGNED_IN, notes, pools.PAGE_POOLS, ready("n1", "a1"));
  assert.deepEqual(before.pools?.find((p) => p.chain === "solana"), { chain: "solana", asset: "SOL", balance: "0.05", ready: "0.05" });
  const priced = await pools.withPools(SIGNED_IN, notes, pools.withSolanaRent(pools.PAGE_POOLS, RENT), ready("n1", "a1"));
  const spend = solanaTapSpendOf(RENT)(CHUNK, FEE_CAP, SOL_TIP_CAP);
  assert.ok(spend > 0n && spend < CHUNK, `the tap spends ${spend} of the ${CHUNK} chunk`);
  const tapMax = `0.${spend.toString().padStart(9, "0")}`.replace(/0+$/, "");
  assert.deepEqual(priced.pools?.find((p) => p.chain === "solana"), { chain: "solana", asset: "SOL", balance: "0.05", ready: "0.05", tap_max: tapMax });
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(priced), true);
  // a proof of another pool, or of another attempt, is not ready
  const other = [{ ...ready("n1", "a1")[0]!, poolId: "sol:other" }];
  assert.equal((await pools.withPools(SIGNED_IN, notes, pools.PAGE_POOLS, other)).pools?.[0]?.ready, "0");
  assert.equal((await pools.withPools(SIGNED_IN, notes, pools.PAGE_POOLS, ready("n1", "a2"))).pools?.[0]?.ready, "0");
  // the ladder's least rung, 0.01 SOL, spends nothing at the worst venue once the fee, the tip and the accounts' rent
  // are out: ready, with tap_max "0", so the box keeps Buy off for it
  const small = await pools.withPools(SIGNED_IN, async () => [held("s1", "a1", 10_000_000n)], pools.withSolanaRent(pools.PAGE_POOLS, RENT), ready("s1", "a1", 10_000_000n));
  assert.deepEqual(small.pools?.[0], { chain: "solana", asset: "SOL", balance: "0.01", ready: "0.01", tap_max: "0" });
});

test("withSolanaRent gives only the Solana entry a spend, and leaves the table it was handed as it was", () => {
  const evm = pools.pagePoolsOf("testnet", {}, { "base-sepolia": EVM_PIN })[0]!;
  const both = [...pools.PAGE_POOLS.filter((p) => p.chain === "solana"), evm];
  const out = pools.withSolanaRent(both, RENT);
  assert.equal(typeof out[0]!.spendOf, "function");
  assert.equal(out[1], evm, "the EVM entry is the same entry");
  assert.equal(both[0]!.spendOf, undefined, "the table handed in is not changed");
  assert.ok(Object.isFrozen(out));
});

test("an EVM pin goes in under its pool kind's id and scope, on its app chain, spending a whole chunk at the tap", () => {
  const k = evmKind(EVM_PIN);
  const [e, ...rest] = pools.pagePoolsOf("testnet", {}, { "base-sepolia": EVM_PIN });
  assert.equal(rest.length, 0);
  assert.deepEqual({ id: e!.id, chain: e!.chain, scope: e!.scope, asset: e!.asset }, { id: k.id, chain: "base", scope: k.scope, asset: "ETH" });
  assert.equal(e!.spendOf?.(7n, 1n, undefined), 7n);
  // the testnet table takes the testnet networks only, mainnet's the mainnet ones
  assert.deepEqual(pools.pagePoolsOf("mainnet", {}, { "base-sepolia": EVM_PIN }), []);
  assert.deepEqual(pools.pagePoolsOf("testnet", { mainnet: SOL_POOLS.devnet! }, {}), []);
  const main = pools.pagePoolsOf("mainnet", { mainnet: SOL_POOLS.devnet! }, { robinhood: { ...EVM_PIN, network: "robinhood" } });
  assert.deepEqual(main.map((p) => [p.chain, p.id]), [["solana", KIND.id], ["robinhood", evmKind({ ...EVM_PIN, network: "robinhood" }).id]]);
});

test("rentOnce: one read at a time, kept once it lands, the state told once; a failed read is tried again at the next get", async () => {
  let reads = 0;
  let told = 0;
  let fail = true;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const r = pools.rentOnce(async () => {
    reads++;
    if (fail) throw new Error("the two RPCs differ");
    return RENT;
  }, () => told++);
  assert.equal(r.get(), null);
  assert.equal(r.get(), null);
  await settle();
  assert.equal(reads, 1, "one read while one runs");
  assert.equal(told, 0);
  fail = false;
  assert.equal(r.get(), null);
  await settle();
  assert.equal(reads, 2, "the failed read is tried again");
  assert.deepEqual(r.get(), RENT);
  assert.equal(told, 1);
  r.get();
  await settle();
  assert.equal(reads, 2, "kept once it lands");
  assert.equal(told, 1);
});
