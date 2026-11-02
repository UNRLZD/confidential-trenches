// The device's own fee cap (card wallet-withdraw-feemax): LD5's formula on recorded reads (test/vectors/
// withdraw-feemax.json, recorded by test/record-withdraw-feemax.mjs: reads only), every read answer hostile, and the cap
// applied where the fee is bound (withdrawRequest) at $1, $1,000 and $1,000,000 (§8 item 13; WU-05).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import {
  FEE_A_FUND,
  FEE_B_CAP,
  FEE_G_ARM_CAP,
  FEE_G_CAP,
  FEE_G_SETTLE_CAP,
  FEE_POOL_ID,
  FEE_POOL_TOKENS,
  FeeMaxRefused,
  type FeeRpc,
  readWithdrawFeeMax,
  withdrawFeeMax,
} from "../src/withdraw/feemax.ts";
import { askWithdrawFee, RELEASE_HELPER, WithdrawRelayRefused } from "../src/withdraw/relay.ts";
import { withdrawRequest } from "../src/withdraw/request.ts";
import { argsFor, closeVaults, FEE_MAX, FEE_READS, type FeeEdit, feeReplay, REGISTER_DEPOSIT, signalsProver, TOKEN, vaultWith } from "./withdraw-fixture.ts";

after(closeVaults);

const poolOf = (net = FEE_READS.answers.mainnet) => {
  const r = net.pool!.a.json as { result: { result: number[] } };
  return JSON.parse(Buffer.from(r.result.result).toString()) as { amounts: [string, string]; token_account_ids: string[]; pool_kind: string };
};
const POOL = poolOf();
const GP = 100_000_000n;

test("the formula's figures: LD5's constants, and fee_max at the recorded gas price and pool", () => {
  assert.equal(FEE_G_CAP, 2n * 92_505_000_000_000n); // 2 × 92.505 Tgas
  assert.equal(FEE_B_CAP, 710n + 148n);
  assert.equal(FEE_G_SETTLE_CAP, 101_475_000_000_000n + 3_000_000_000_000n);
  assert.equal(FEE_G_ARM_CAP, 100_000_000_000_000n);
  assert.equal(FEE_A_FUND, 8_820_000_000_000_000_000_000n); // 182 B × 1e19 + 0.007 N
  assert.equal(FEE_A_FUND + FEE_G_ARM_CAP * GP, 18_820_000_000_000_000_000_000n); // A_cap ≈ 0.0188 N at 1e8 (markets l.1688)
  assert.equal(FEE_POOL_ID, 4512);
  assert.deepEqual([...FEE_POOL_TOKENS], [NEAR_NETWORKS.mainnet.token, "wrap.near"]);
  assert.deepEqual(POOL.token_account_ids, [...FEE_POOL_TOKENS]);
  // the recorded reads: gas price 1e8 on both networks' blocks, and the pool's two amounts
  for (const net of ["mainnet", "testnet"] as const)
    for (const s of ["a", "b"] as const) assert.equal((FEE_READS.answers[net].at[s].json as { result: { header: { gas_price: string } } }).result.header.gas_price, "100000000");
  const tok = BigInt(POOL.amounts[0]);
  const near = BigInt(POOL.amounts[1]);
  // (G_cap × gp × 1.5 + S_cap) yocto, by hand: 0.0277515 N + 2 × (0.00858 + 0.00125 + 0.0104475 + 0.01882) N = 0.1059465 N
  const yocto = 27_751_500_000_000_000_000_000n + 2n * (8_580_000_000_000_000_000_000n + REGISTER_DEPOSIT + 10_447_500_000_000_000_000_000n + 18_820_000_000_000_000_000_000n);
  assert.equal(yocto, 105_946_500_000_000_000_000_000n);
  const want = (yocto * tok + near - 1n) / near;
  assert.equal(want, FEE_MAX);
  assert.equal(withdrawFeeMax({ gasPrice: GP, poolToken: tok, poolNear: near, registerDeposit: REGISTER_DEPOSIT }), FEE_MAX); // about $0.43
  assert.equal(withdrawFeeMax({ gasPrice: GP, poolToken: tok, poolNear: near, registerDeposit: 0n }), 423_234n);
  // rounds up: one base unit more for any remainder
  assert.equal(withdrawFeeMax({ gasPrice: GP, poolToken: 1n, poolNear: 105_946_500_000_000_000_000_000n, registerDeposit: REGISTER_DEPOSIT }), 1n);
  assert.equal(withdrawFeeMax({ gasPrice: GP, poolToken: 1n, poolNear: 105_946_499_999_999_999_999_999n, registerDeposit: REGISTER_DEPOSIT }), 2n);
  for (const bad of [{ gasPrice: 0n }, { poolToken: 0n }, { poolNear: 0n }, { registerDeposit: -1n }, { gasPrice: 1n << 128n }, { gasPrice: 1 as unknown as bigint }])
    assert.throws(() => withdrawFeeMax({ gasPrice: GP, poolToken: tok, poolNear: near, registerDeposit: 0n, ...bad }), (e: FeeMaxRefused) => e.code === "input");
});

test("the reads: gas price at one block on the network's pair, the pool at one block on mainnet's, both recorded", async () => {
  assert.equal(await readWithdrawFeeMax({ network: "mainnet", rpcs: feeReplay("mainnet"), priceRpcs: feeReplay("mainnet"), registerDeposit: REGISTER_DEPOSIT }), FEE_MAX);
  assert.equal(await readWithdrawFeeMax({ network: "testnet", rpcs: feeReplay("testnet"), priceRpcs: feeReplay("mainnet"), registerDeposit: REGISTER_DEPOSIT }), FEE_MAX);
  // the testnet token is USDC's code with its 6 decimals, so the mainnet USDC price is its price
  for (const s of ["a", "b"] as const) {
    const m = FEE_READS.answers.testnet.metadata![s].json as { result: { result: number[] } };
    assert.equal(JSON.parse(Buffer.from(m.result.result).toString()).decimals, 6);
  }
});

const refused = (p: Promise<unknown>, code: string, re?: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof FeeMaxRefused && e.code === code && (re === undefined || re.test(e.message)));
const withEdit = (net: "mainnet" | "testnet", edit: FeeEdit) =>
  readWithdrawFeeMax({ network: net, rpcs: feeReplay(net, edit), priceRpcs: feeReplay("mainnet", net === "mainnet" ? edit : undefined), registerDeposit: REGISTER_DEPOSIT });
const header = (j: Record<string, unknown>) => (j.result as { header: Record<string, unknown> }).header;
const poolBytes = (j: Record<string, unknown>, f: (p: Record<string, unknown>) => void) => {
  const r = j.result as { result: number[] };
  const p = JSON.parse(Buffer.from(r.result).toString()) as Record<string, unknown>;
  f(p);
  r.result = [...Buffer.from(JSON.stringify(p))];
  return j;
};

test("two providers disagreeing are refused: the gas price, the block's hash, the pool's bytes", async () => {
  // a gas price one yocto higher on dRPC, on the network's pair and on the price pair
  for (const net of ["mainnet", "testnet"] as const)
    await refused(withEdit(net, (r, s, j) => (r === "at" && s === "b" && (header(j).gas_price = "100000001"), j)), "disagree", /gas prices differ/);
  await refused(readWithdrawFeeMax({ network: "testnet", rpcs: feeReplay("testnet"), priceRpcs: feeReplay("mainnet", (r, s, j) => (r === "at" && s === "a" && (header(j).gas_price = "1"), j)), registerDeposit: 0n }), "disagree");
  // another block under the same height
  await refused(withEdit("testnet", (r, s, j) => (r === "at" && s === "b" && (header(j).hash = "11111111111111111111111111111111"), j)), "disagree", /different blocks/);
  // the pool's amounts differ by one base unit (a raised NEAR price on one side)
  await refused(withEdit("mainnet", (r, s, j) => (r === "pool" && s === "b" ? poolBytes(j, (p) => ((p.amounts as string[])[0] = String(BigInt((p.amounts as string[])[0]!) + 1n))) : j)), "disagree", /pool/);
  // a pool answer at another block, or a block answer at another height
  await refused(withEdit("mainnet", (r, s, j) => (r === "pool" && s === "a" && ((j.result as Record<string, unknown>).block_height = 1), j)), "rpc");
  await refused(withEdit("mainnet", (r, s, j) => (r === "at" && s === "a" && (header(j).height = 1), j)), "rpc");
  // a provider down or answering an error
  await refused(withEdit("testnet", (r, s, j) => (r === "final" && s === "b" ? { jsonrpc: "2.0", id: "x", error: { code: -32000 } } : j)), "rpc");
});

test("the pool must be the pinned SIMPLE_POOL of USDC and wNEAR, with two amounts above 0", async () => {
  const both = (f: (p: Record<string, unknown>) => void): FeeEdit => (r, _s, j) => (r === "pool" ? poolBytes(j, f) : j);
  await refused(withEdit("mainnet", both((p) => (p.pool_kind = "STABLE_SWAP"))), "pool", /SIMPLE_POOL/);
  await refused(withEdit("mainnet", both((p) => (p.token_account_ids = ["wrap.near", NEAR_NETWORKS.mainnet.token]))), "pool", /USDC/);
  await refused(withEdit("mainnet", both((p) => (p.token_account_ids = ["usdt.tether-token.near", "wrap.near"]))), "pool", /USDC/);
  await refused(withEdit("mainnet", both((p) => (p.amounts = ["0", "1"]))), "pool", /amounts/);
  await refused(withEdit("mainnet", both((p) => (p.amounts = [1, "1"]))), "pool", /amounts/);
});

test("the pairs are release pairs: one operator, a helper URL or the testnet pair for the price are refused", async () => {
  const [fa, fb] = feeReplay("mainnet");
  const renamed = (r: FeeRpc, name: string): FeeRpc => ({ name, block: r.block, query: r.query });
  const net = NEAR_NETWORKS.mainnet;
  const bad: [FeeRpc, FeeRpc][] = [
    [fa, renamed(fb, net.fastnear[1])], // two FastNEAR URLs: one operator
    [fa, renamed(fb, `${RELEASE_HELPER}/v1/rpc/near`)], // through the helper
  ];
  for (const pair of bad) {
    await refused(readWithdrawFeeMax({ network: "mainnet", rpcs: pair, priceRpcs: feeReplay("mainnet"), registerDeposit: 0n }), "input", /exactly/);
    await refused(readWithdrawFeeMax({ network: "mainnet", rpcs: feeReplay("mainnet"), priceRpcs: pair, registerDeposit: 0n }), "input", /exactly/);
  }
  await refused(readWithdrawFeeMax({ network: "testnet", rpcs: feeReplay("testnet"), priceRpcs: feeReplay("testnet"), registerDeposit: 0n }), "input", /price/);
  await refused(readWithdrawFeeMax({ network: "testnet", rpcs: feeReplay("mainnet"), priceRpcs: feeReplay("mainnet"), registerDeposit: 0n }), "input");
});

test("§8 item 13: at $1, $1,000 and $1,000,000 the cap signs and one base unit above it is refused, nothing held", async () => {
  const amounts = [1_000_000n, 1_000_000_000n, 1_000_000_000_000n];
  const v = await vaultWith(amounts.map((x) => x + 1_000_000n));
  for (const amount of amounts) {
    const before = await v.ns.list();
    const log: string[] = [];
    await assert.rejects(withdrawRequest(argsFor(v, signalsProver(log), { amount, relayFee: FEE_MAX + 1n })), /fee_max/, `$${amount / 1_000_000n}`);
    assert.deepEqual(log, [], "nothing proved");
    assert.deepEqual(await v.ns.list(), before, "nothing written");
    const r = await withdrawRequest(argsFor(v, signalsProver(), { amount, relayFee: FEE_MAX }));
    assert.equal(r.body.withdrawal.relay_fee, String(FEE_MAX));
  }
});

test("a caller-named fee_max is never used: withdrawRequest ignores it, askWithdrawFee refuses it", async () => {
  const v = await vaultWith();
  const over = { relayFee: FEE_MAX + 1n, feeMax: 1n << 100n } as Parameters<typeof argsFor>[2];
  await assert.rejects(withdrawRequest(argsFor(v, signalsProver(), over)), /fee_max/);
  let asked = 0;
  const fetchFn = (async () => (asked++, new Response("{}", { status: 500 }))) as typeof fetch;
  const relayer = { relayer_account: "relayer.example.near", fee_recipient: "fees.example.near" };
  await assert.rejects(
    askWithdrawFee({ token: TOKEN, relayer, amount: 3_000_000n, fetchFn, feeMax: 1n << 100n } as Parameters<typeof askWithdrawFee>[0]),
    (e: unknown) => e instanceof WithdrawRelayRefused && e.code === "input" && /fee cap/.test(e.message),
  );
  assert.equal(asked, 0, "nothing asked of the helper");
});

test("the fee is in the network's own token: a request on another token, or an unknown network, is refused", async () => {
  const v = await vaultWith();
  await assert.rejects(withdrawRequest(argsFor(v, signalsProver(), { network: "testnet" })), /token/);
  await assert.rejects(withdrawRequest(argsFor(v, signalsProver(), { network: "devnet" as "mainnet" })), /network/);
});
