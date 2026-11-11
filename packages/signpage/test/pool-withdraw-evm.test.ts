// pool.withdraw on a Base or Robinhood pool (src/pool-withdraw-evm.ts): the plan's arithmetic (exactly the part arrives,
// each note's change 0 or spendable), To's refusals, the chain's costs read on two RPCs (a plain send, a To with code:
// its estimate and margin and its run on both, refused when it reverts or the two disagree), the release's calldata
// byte for byte the pool's testnet run's encoding, and an owed send's finish after a reload. The two RPCs are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { entropyToWords, freshWallet, wordsToSeed64 } from "../../wallet/src/derive/keys.ts";
import { evmRelayDataBytes, type EvmPoolPin, type EvmPoolRequest, type EvmRelayData } from "../../wallet/src/pool/evm.ts";
import type { NoteRecord, NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import { evmPoolChainFee, evmPoolChainFeeReads } from "../../kit/src/trade/evm/pool-fee.ts";
import { evmWithdrawCalldata } from "../src/evm-send.ts";
import { planPoolWithdraw, withdrawSources } from "../src/pool-withdraw.ts";
import { evmToRefused, evmWithdrawCosts, evmWithdrawMinPart, finishEvmOnward, releaseContextOf, EVM_ONWARD_TIP, EVM_ONWARD_L1_BYTES, type EvmPendingOnward, type EvmWithdrawHost } from "../src/pool-withdraw-evm.ts";
import { EVM_ONWARD_GAS, evmOnwardCodeGas, withdrawNoteFloor } from "../src/rules/pool.ts";

const LIB = new URL("../../../contracts/pool-evm/script/testnet-run-lib.mjs", import.meta.url).href;
const { withdrawData, proofArg } = (await import(LIB)) as { withdrawData: (...a: unknown[]) => string; proofArg: (...a: unknown[]) => unknown };

const POOL = "0x00000000000000000000000000000000000f0011";
const FEE_TO = "0x0000000000000000000000000000000000000fee";
const TO = "0x1111111111111111111111111111111111111111";
const SAFE = "0x2222222222222222222222222222222222222222";
const BASE_PIN: EvmPoolPin = { network: "base-sepolia", pool: POOL, feeRecipient: FEE_TO, fromBlock: 1n };
const RH_PIN: EvmPoolPin = { network: "robinhood-testnet", pool: POOL, feeRecipient: FEE_TO, fromBlock: 1n };
// the all-zero seed (the published vector, packages/wallet/test/vectors/a8.json)
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const L = 5n;
const W = freshWallet(SEED, "evm", L, 0).address;
const FEE = 20_000_000_000_000n;
const BASE_FEE = 10_000_000n;
const NOW = 1_800_000_000_000n;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const q = (v: bigint) => "0x" + v.toString(16);
const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");

type Side = { code?: Record<string, string>; estimate?: (call: { from: string; to: string }) => bigint; reverts?: boolean; l1?: bigint; operator?: bigint; nonce?: bigint; receipt?: unknown; tx?: unknown };
type Call = { method: string; params: unknown[] };
const rpcOf = (s: Side, calls: Call[]) => async (method: string, params: unknown[] = []): Promise<unknown> => {
  calls.push({ method, params });
  if (method === "eth_getBlockByNumber") return { number: "0x100", hash: "0x" + "be".repeat(32), timestamp: q(NOW / 1000n), baseFeePerGas: q(BASE_FEE) };
  if (method === "eth_getCode") return s.code?.[String(params[0]).toLowerCase()] ?? "0x";
  if (method === "eth_estimateGas") return q(s.estimate?.(params[0] as { from: string; to: string }) ?? EVM_ONWARD_GAS);
  if (method === "eth_call") {
    const c = params[0] as { to: string; data?: string };
    // Base's GasPriceOracle: getL1FeeUpperBound, then getOperatorFee
    if (c.to.toLowerCase() === "0x420000000000000000000000000000000000000f") return word(c.data!.startsWith("0xf1c7a58b") ? (s.l1 ?? 900n) : (s.operator ?? 0n));
    if (s.reverts) throw new Error("execution reverted");
    return "0x";
  }
  if (method === "eth_getTransactionCount") return q(s.nonce ?? 0n);
  if (method === "eth_getTransactionReceipt") return s.receipt ?? null;
  if (method === "eth_getTransactionByHash") return s.tx ?? null;
  throw new Error(`no ${method}`);
};
const poolOf = (fee = FEE) =>
  ({ now: async () => NOW, epochMs: 60_000n, lifeMs: 210_000n, scope: 7n, bind: async () => ({ feeCap: fee }) }) as unknown as Pool<EvmPoolRequest>;
const hostOf = (chain: "base" | "robinhood", a: Side = {}, b: Side = a, calls: Call[] = []) => ({
  chain,
  pin: chain === "base" ? BASE_PIN : RH_PIN,
  rpcs: [rpcOf(a, calls), rpcOf(b, calls)] as unknown as EvmWithdrawHost["rpcs"],
  pool: poolOf(),
});

test("the smallest part: the fee less W's fee (the pool's backstop holds the fee to half the chunk), at least 1 wei", () => {
  assert.equal(evmWithdrawMinPart(FEE, 210_000_000_000n), FEE - 210_000_000_000n);
  assert.equal(evmWithdrawMinPart(100n, 100n), 1n);
  assert.equal(evmWithdrawMinPart(100n, 500n), 1n);
  const part = evmWithdrawMinPart(FEE, 1n);
  assert.ok(FEE * 2n <= part + FEE + 1n, "fee at most half of part + fee + W's fee");
});

test("the plan: exactly the amount leaves as parts, each chunk part + fee + W's fee, and each note's change 0 or at least the note floor", () => {
  const c = { fee: FEE, wFee: 210_000_000_000n, minPart: evmWithdrawMinPart(FEE, 210_000_000_000n) };
  const floor = withdrawNoteFloor(c);
  const notes = [{ id: "a", value: 10n ** 15n }, { id: "b", value: 10n ** 15n }];
  for (const amount of [c.minPart, 5n * 10n ** 14n, 10n ** 15n - c.fee - c.wFee, 10n ** 15n, 2n * (10n ** 15n - c.fee - c.wFee)]) {
    const plan = planPoolWithdraw(notes, amount, c);
    assert.ok(plan, `a plan for ${amount}`);
    assert.equal(plan!.reduce((s, p) => s + p.part, 0n), amount, "exactly the amount typed arrives");
    for (const p of plan!) {
      assert.equal(p.chunk, p.part + c.fee + c.wFee);
      const left = notes.find((n) => n.id === p.noteId)!.value - p.chunk;
      assert.ok(left === 0n || left >= floor, `change ${left}: 0 or at least ${floor}`);
    }
  }
  assert.equal(planPoolWithdraw(notes, c.minPart - 1n, c), null, "under the smallest part: no plan");
  assert.equal(planPoolWithdraw(notes, 2n * 10n ** 15n, c), null, "more than the notes give after fees: no plan");
});

test("the screen's notes: landed UNSPENT notes of the pool's scope, and HELD ones only when the page's own queue holds them", () => {
  const n = (id: string, state: NoteRecord["state"], scope = 7n) => ({ id, state, scope, leaf: { value: 10n ** 15n, label: L, leafIndex: 0n } }) as unknown as NoteRecord;
  const got = withdrawSources([n("u", "UNSPENT"), n("h", "HELD"), n("mine", "HELD"), n("r", "RESERVED"), n("other", "UNSPENT", 8n)], 7n, new Set(["mine"]));
  assert.deepEqual(got.map((x) => x.id), ["u", "mine"]);
});

test("To refused before any note moves: the zero address, every precompile under 0x10000, the pool, the fee recipient, a W of the plan, a malformed address", () => {
  for (const to of ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000001", "0x000000000000000000000000000000000000ffff", POOL, POOL.toUpperCase().replace("0X", "0x"), FEE_TO, W, W.toLowerCase(), "0x1234", "1111111111111111111111111111111111111111"])
    assert.equal(evmToRefused(to, BASE_PIN, [W]), true, to);
  assert.equal(evmToRefused("0x0000000000000000000000000000000000010000", BASE_PIN, [W]), false, "0x10000: above every precompile");
  assert.equal(evmToRefused(TO, BASE_PIN, [W]), false);
});

test("Base, To with no code: 21,000 gas, max fee twice the base fee and the tip, the L1 bound for 128 bytes and the operator fee; W's fee is their sum", async () => {
  const calls: Call[] = [];
  const c = await evmWithdrawCosts(hostOf("base", { l1: 900n, operator: 7n }, { l1: 900n, operator: 7n }, calls), { to: TO, from: W, value: 10n ** 14n });
  assert.equal(c.toHasCode, false);
  assert.equal(c.gas, EVM_ONWARD_GAS);
  assert.equal(c.tip, EVM_ONWARD_TIP);
  assert.equal(c.maxFee, 2n * BASE_FEE + EVM_ONWARD_TIP);
  const l1 = evmPoolChainFee("base-sepolia", EVM_ONWARD_L1_BYTES, [900n, 7n]);
  assert.equal(c.l1, l1);
  assert.equal(c.wFee, EVM_ONWARD_GAS * c.maxFee + l1);
  assert.equal(c.fee, FEE);
  assert.equal(c.minPart, evmWithdrawMinPart(FEE, c.wFee));
  // the oracle reads are the kit's own, for the send's size
  const reads = evmPoolChainFeeReads("base-sepolia", EVM_ONWARD_GAS, EVM_ONWARD_L1_BYTES).map((r) => r.data);
  assert.deepEqual(calls.filter((x) => x.method === "eth_call").map((x) => (x.params[0] as { data: string }).data), [reads[0], reads[0], reads[1], reads[1]]);
  // a plain send is never simulated and never named to an estimate on Base
  assert.equal(calls.some((x) => x.method === "eth_estimateGas"), false);
});

test("Robinhood: the max fee is the base fee itself, no tip, no L1 bound, the gas the two RPCs' agreed estimate: W pays exactly its bound and ends at 0", async () => {
  const c = await evmWithdrawCosts(hostOf("robinhood"), { to: TO, from: W, value: 10n ** 14n });
  assert.equal(c.maxFee, BASE_FEE);
  assert.equal(c.tip, 0n);
  assert.equal(c.l1, 0n);
  assert.equal(c.gas, EVM_ONWARD_GAS);
  assert.equal(c.wFee, EVM_ONWARD_GAS * BASE_FEE);
  // W after the release holds the chunk less the fee: part + wFee; the send at gas x base fee leaves exactly 0
  const part = 10n ** 14n;
  assert.equal(part + c.wFee - part - c.gas * BASE_FEE, 0n);
  await assert.rejects(evmWithdrawCosts(hostOf("robinhood", {}, { estimate: () => 21_001n }), { to: TO, from: W, value: 1n }), "two estimates that differ: refused");
});

test("To with code that accepts: W's exact send estimated and run on both RPCs (W's balance set by a state override), its gas the estimate and a fifth", async () => {
  const calls: Call[] = [];
  const side: Side = { code: { [TO.toLowerCase()]: "0x6080" }, estimate: () => 30_000n };
  const c = await evmWithdrawCosts(hostOf("base", side, side, calls), { to: TO, from: W, value: 10n ** 14n });
  assert.equal(c.toHasCode, true);
  assert.equal(c.gas, evmOnwardCodeGas(30_000n));
  assert.equal(c.gas, 36_000n);
  const sims = calls.filter((x) => (x.method === "eth_call" && (x.params[0] as { to: string }).to === TO) || x.method === "eth_estimateGas");
  assert.equal(sims.length, 4, "an estimate and a run on each RPC");
  for (const s of sims) {
    const call = s.params[0] as { from: string; to: string; value: string; gas?: string };
    assert.equal(call.from, W);
    assert.equal(call.value, q(10n ** 14n));
    assert.ok((s.params[2] as Record<string, { balance: string }>)[W], "W's balance by a state override");
    if (s.method === "eth_call") assert.equal(call.gas, q(36_000n), "the run carries the very gas W's send will");
  }
  // an EIP-7702 delegation is code too
  const d = { code: { [TO.toLowerCase()]: "0xef0100" + SAFE.slice(2) }, estimate: () => 25_000n };
  assert.equal((await evmWithdrawCosts(hostOf("base", d, d), { to: TO, from: W, value: 1n })).gas, 30_000n);
});

test("To with code refused before any note moves: its run reverts on either RPC, the two estimates differ, the two disagree on its code, or its gas passes the cap", async () => {
  const code = { [TO.toLowerCase()]: "0x6080" };
  const at = { to: TO, from: W, value: 10n ** 14n };
  await assert.rejects(evmWithdrawCosts(hostOf("base", { code, estimate: () => 30_000n, reverts: true }), at), "reverts on both");
  await assert.rejects(evmWithdrawCosts(hostOf("base", { code, estimate: () => 30_000n }, { code, estimate: () => 30_000n, reverts: true }), at), "reverts on one");
  await assert.rejects(evmWithdrawCosts(hostOf("base", { code, estimate: () => 30_000n }, { code, estimate: () => 31_000n }), at), "estimates differ");
  await assert.rejects(evmWithdrawCosts(hostOf("base", { code }, {}), at), "one RPC reads code, the other none");
  await assert.rejects(evmWithdrawCosts(hostOf("base", { code, estimate: () => 90_000n }), at), "90,000 and a fifth passes the 100,000 cap");
  await assert.rejects(evmWithdrawCosts(hostOf("robinhood", { code, estimate: () => 30_000n, reverts: true }), at), "Robinhood: the same");
});

test("the release's calldata is the pool's canonical encoding, byte for byte the testnet run's withdrawData, 1,028 bytes, its context in the head's word 16", () => {
  const relay: EvmRelayData = { recipient: W, feeRecipient: FEE_TO, feeCap: FEE, deadlineMs: NOW + 210_000n, refundPrecommitment: 9n, salt: "0x" + "ab".repeat(16) };
  const proof = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] };
  const signals = ["11", "12", "13", "14", "15", "16", "17", "18"];
  const sig = Uint8Array.from({ length: 65 }, (_, i) => i + 1);
  const ours = evmWithdrawCalldata(POOL, relay, proof as never, signals as never, FEE, sig);
  const theirs = withdrawData(POOL, "0x" + hex(evmRelayDataBytes(relay)), proofArg(proof, signals), FEE, sig);
  assert.equal("0x" + hex(ours), theirs);
  assert.equal(ours.length, 1028, "the helper's withdraw length");
  assert.equal(releaseContextOf("0x" + hex(ours)), 18n, "the proof's eighth public signal");
  assert.equal(releaseContextOf("0x12345678" + hex(ours).slice(8)), null, "another selector: not a release");
  assert.equal(releaseContextOf("0x"), null);
});

// an owed send after a reload: the note's record, W's kept send's receipt on both RPCs
const noteOf = (state: NoteRecord["state"], attempt = "a1"): NoteRecord => ({ id: "n1", ref: { kind: "deposit", s: 1n, i: 0 }, scope: 7n, precommitment: 1n, state, attempt, leaf: { value: 10n ** 15n, label: L, leafIndex: 0n } }) as unknown as NoteRecord;
const pendingOf = (o: Partial<EvmPendingOnward> = {}): EvmPendingOnward => ({
  noteId: "n1", attempt: "a1", context: "18", to: TO, last: true, feeCap: "210000000000", chain: "base", part: "100000000000000",
  nullifier: "12", from: "200", deadlineMs: (NOW + 210_000n).toString(), chunk: (10n ** 14n + FEE + 210_000_000_000n).toString(), fee: FEE.toString(), ...o,
});
const fullHost = (note: NoteRecord, side: Side): EvmWithdrawHost =>
  ({
    ...hostOf("base", side),
    testnet: true,
    venues: {} as never,
    prover: {} as never,
    notes: async () => ({ get: async () => note }) as unknown as NoteStore,
    seed64: async () => SEED.slice(),
    send: async () => assert.fail("no send on a finish"),
    settle: () => {},
  }) as EvmWithdrawHost;
const ONWARD = "0x" + "cd".repeat(32);

test("a reload after W's send left: its kept hash read back on both RPCs (status 1, from W to To) ends the op sent with what it moved", async () => {
  const side: Side = { receipt: { status: "0x1", from: W, to: TO, blockHash: "0x" + "ee".repeat(32) }, tx: { value: q(10n ** 14n) } };
  const got = await finishEvmOnward(fullHost(noteOf("RESERVED"), side), pendingOf({ onward: ONWARD }));
  assert.deepEqual(got, { stage: "sent", txs: [{ chain: "base", hash: ONWARD }], arrived: { [ONWARD]: (10n ** 14n).toString() } });
  // a part before the last: its send done, the op goes on with the next part (stopped here, the run's own)
  assert.equal((await finishEvmOnward(fullHost(noteOf("RESERVED"), side), pendingOf({ onward: ONWARD, last: false })))?.stage, "stopped");
});

test("a reload whose note is no longer this attempt's (another tab's attempt, or back to UNSPENT): stopped, nothing sent from here", async () => {
  const side: Side = {};
  assert.equal((await finishEvmOnward(fullHost(noteOf("RESERVED", "a2"), side), pendingOf()))?.stage, "stopped");
  assert.equal((await finishEvmOnward(fullHost(noteOf("UNSPENT"), side), pendingOf()))?.stage, "stopped");
  assert.equal((await finishEvmOnward(fullHost(noteOf("RESERVED"), side), pendingOf({ chain: "robinhood" })))?.stage, "stopped", "another chain's record");
});

test("a reload whose kept send is not read on both RPCs yet, nor the release: read again later (null), nothing signed", async () => {
  const one: Side = { receipt: { status: "0x1", from: W, to: TO, blockHash: "0x" + "ee".repeat(32) } };
  const host = { ...fullHost(noteOf("RESERVED"), one), rpcs: [rpcOf(one, []), rpcOf({}, [])] } as unknown as EvmWithdrawHost;
  assert.equal(await finishEvmOnward(host, pendingOf({ onward: ONWARD })), null);
});

test("the withdraw's live check reads what the page sends: the release's selector, the pool's Withdrawn topic and the bundle marks this code carries (scripts/live-checks/evm-withdraw-mainnet.mjs)", async () => {
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const { EVM_WITHDRAW_SIGNATURE } = await import("../src/evm-send.ts");
  const { EVM_POOL_EVENTS } = await import("../../wallet/src/pool/evm.ts");
  const { readFileSync } = await import("node:fs");
  const lc = (await import(new URL("../../../scripts/live-checks/evm-withdraw-mainnet.mjs", import.meta.url).href)) as { WITHDRAW_SELECTOR: string; WITHDRAWN: string; WITHDRAW_MARKS: readonly string[] };
  const k = (s: string) => hex(keccak_256(new TextEncoder().encode(s)));
  assert.equal(lc.WITHDRAW_SELECTOR, "0x" + k(EVM_WITHDRAW_SIGNATURE).slice(0, 8));
  assert.equal(lc.WITHDRAWN, "0x" + k(EVM_POOL_EVENTS.Withdrawn));
  assert.equal(lc.WITHDRAW_MARKS[0], EVM_WITHDRAW_SIGNATURE);
  assert.ok(readFileSync(new URL("../src/pool-withdraw-evm.ts", import.meta.url), "utf8").includes(lc.WITHDRAW_MARKS[1]!), "the probe key's hex, as the source writes it");
});
