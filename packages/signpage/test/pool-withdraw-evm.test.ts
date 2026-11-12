// pool.withdraw on a Base or Robinhood pool (src/pool-withdraw-evm.ts): the plan's arithmetic (exactly the part arrives,
// each note's change 0 or spendable), To's refusals, the chain's costs read on two RPCs (a plain send, a To with code:
// its estimate and margin and its run on both, refused when it reverts or the two disagree), the release's calldata
// byte for byte the pool's testnet run's encoding, and an owed send's finish after a reload. The two RPCs are fakes.
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore } from "@blindfill/wallet/store";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { evmPoolContextOf, evmPoolScopeOf } from "../../wallet/src/pool/evm.ts";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";
import assert from "node:assert/strict";
import { entropyToWords, freshWallet, wordsToSeed64 } from "../../wallet/src/derive/keys.ts";
import { evmRelayDataBytes, type EvmPoolPin, type EvmPoolRequest, type EvmRelayData } from "../../wallet/src/pool/evm.ts";
import type { NoteRecord, NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import { evmPoolChainFee, evmPoolChainFeeReads } from "../../kit/src/trade/evm/pool-fee.ts";
import { evmWithdrawCalldata } from "../src/evm-send.ts";
import { planPoolWithdraw, withdrawSources } from "../src/pool-withdraw.ts";
import { evmPoolVenues } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { EVM_BUY_HEAD_SPREAD, EVM_BUY_LAG_BLOCKS, EVM_BUY_LAG_MS } from "../src/pool-buy-evm.ts";
import { EVM_SELL_LAG_BLOCKS } from "../src/pool-sell-evm.ts";
import { EVM_BUY_LOG_SPAN } from "../src/evm-send.ts";
import { EVM_LIFE_MS } from "../../wallet/src/pool/evm.ts";
import { evmToRefused, evmWithdrawCosts, evmWithdrawMinPart, finishEvmOnward, onwardReceipt, runEvmPoolWithdraw, EVM_ONWARD_TIP, EVM_ONWARD_L1_BYTES, type EvmHeldOnW, type EvmPendingOnward, type EvmWithdrawHost } from "../src/pool-withdraw-evm.ts";
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
const lower = (s: string) => s.toLowerCase();

type Side = {
  code?: Record<string, string>; estimate?: (call: { from: string; to: string }) => bigint; reverts?: boolean; l1?: bigint; operator?: bigint; nonce?: bigint; receipt?: unknown; tx?: unknown;
  // a finish's release read and W's send: the blocks' time, the pool's logs, transactions and receipts by hash, W's
  // balance, the raw sends made, and a send's receipt (status 1, from W to To) once one is made
  timeMs?: bigint; logs?: unknown[]; txs?: Record<string, unknown>; receipts?: Record<string, unknown>; balance?: bigint; sent?: string[]; landsOnSend?: boolean;
  // the RPC's safe block (default 0x100); a receipt with no block number is in block 0xf0, under it
  safe?: bigint;
};
const inBlock = (r: unknown): unknown => (r !== null && typeof r === "object" && !("blockNumber" in r) ? { ...r, blockNumber: "0xf0" } : r);
type Call = { method: string; params: unknown[] };
const rpcOf = (s: Side, calls: Call[]) => async (method: string, params: unknown[] = []): Promise<unknown> => {
  calls.push({ method, params });
  if (method === "eth_getBlockByNumber") return { number: params[0] === "safe" && s.safe !== undefined ? q(s.safe) : "0x100", hash: "0x" + "be".repeat(32), timestamp: q((s.timeMs ?? NOW) / 1000n), baseFeePerGas: q(BASE_FEE) };
  if (method === "eth_getLogs") return s.logs ?? [];
  if (method === "eth_getBalance") return q(s.balance ?? 0n);
  if (method === "eth_sendRawTransaction") {
    (s.sent ??= []).push(String(params[0]));
    return "0x" + hex(keccak_256(Uint8Array.from(Buffer.from(String(params[0]).slice(2), "hex"))));
  }
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
  if (method === "eth_getTransactionReceipt") {
    const h = String(params[0]);
    if (s.receipts?.[h] !== undefined) return inBlock(s.receipts[h]);
    const raw = s.landsOnSend ? s.sent?.find((r) => "0x" + hex(keccak_256(Uint8Array.from(Buffer.from(r.slice(2), "hex")))) === h) : undefined;
    return inBlock(raw !== undefined ? { status: "0x1", from: W, to: TO, blockHash: "0x" + "ee".repeat(32) } : (s.receipt ?? null));
  }
  if (method === "eth_getTransactionByHash") return s.txs?.[String(params[0])] ?? s.tx ?? null;
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

test("the screen's notes: landed UNSPENT and HELD notes of the pool's scope (a HELD one's queue lets go when the run frees it)", () => {
  const n = (id: string, state: NoteRecord["state"], scope = 7n) => ({ id, state, scope, leaf: { value: 10n ** 15n, label: L, leafIndex: 0n } }) as unknown as NoteRecord;
  const got = withdrawSources([n("u", "UNSPENT"), n("h", "HELD"), n("r", "RESERVED"), n("other", "UNSPENT", 8n)], 7n);
  assert.deepEqual(got.map((x) => x.id), ["u", "h"]);
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

test("the release's calldata is the pool's canonical encoding, byte for byte the testnet run's withdrawData, 1,028 bytes", () => {
  const relay: EvmRelayData = { recipient: W, feeRecipient: FEE_TO, feeCap: FEE, deadlineMs: NOW + 210_000n, refundPrecommitment: 9n, salt: "0x" + "ab".repeat(16) };
  const proof = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] };
  const signals = ["11", "12", "13", "14", "15", "16", "17", "18"];
  const sig = Uint8Array.from({ length: 65 }, (_, i) => i + 1);
  const ours = evmWithdrawCalldata(POOL, relay, proof as never, signals as never, FEE, sig);
  const theirs = withdrawData(POOL, "0x" + hex(evmRelayDataBytes(relay)), proofArg(proof, signals), FEE, sig);
  assert.equal("0x" + hex(ours), theirs);
  assert.equal(ours.length, 1028, "the helper's withdraw length");
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

// a finish's release read: the pool's Withdrawn of the part's nullifier (12) paying `to` the chunk, in transaction REL
// whose calldata carries `context`; the blocks past the deadline once `ended`
const REL = "0x" + "ab".repeat(32);
const PART = 10n ** 14n;
const W_BOUND = 21_000n * (2n * BASE_FEE + EVM_ONWARD_TIP) + 900n;
const releaseSide = (o: { to?: string; context?: bigint; logs?: boolean; ended?: boolean } = {}): Side => {
  const chunk = PART + FEE + 210_000_000_000n;
  const relay: EvmRelayData = { recipient: o.to ?? W, feeRecipient: FEE_TO, feeCap: FEE, deadlineMs: NOW + 210_000n, refundPrecommitment: 9n, salt: "0x" + "ab".repeat(16) };
  const proof = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] };
  const signals = ["11", "12", "13", "14", "15", "16", "17", String(o.context ?? 18n)];
  const input = "0x" + hex(evmWithdrawCalldata(POOL, relay, proof as never, signals as never, FEE, new Uint8Array(65).fill(1)));
  const topic = "0x" + hex(keccak_256(new TextEncoder().encode("Withdrawn(address,address,uint256,uint256,uint256,uint256)")));
  const data = "0x" + [BigInt(FEE_TO), chunk, FEE, 12n, 1n].map((v) => v.toString(16).padStart(64, "0")).join("");
  const log = { address: POOL, topics: [topic, word(BigInt(o.to ?? W))], data, blockNumber: "0xf0", logIndex: "0x0", transactionHash: REL, blockHash: "0x" + "bb".repeat(32) };
  return { timeMs: o.ended === false ? NOW : NOW + 300_000n, logs: o.logs === false ? [] : [log], txs: { [REL]: { to: POOL, input } }, balance: PART + W_BOUND };
};
const finishHost = (side: Side, o: { note?: NoteRecord; clock?: { ms: bigint }; settled?: number[]; kept?: EvmPendingOnward[] } = {}): EvmWithdrawHost =>
  ({
    ...fullHost(o.note ?? noteOf("RESERVED"), side),
    // the testnet build's venues, Base Sepolia's pool this test's
    venues: Object.freeze({ "base-sepolia": Object.freeze({ ...evmPoolVenues()["base-sepolia"], pool: POOL }) }),
    rpcs: [rpcOf(side, []), rpcOf(side, [])],
    now: () => o.clock?.ms ?? NOW,
    wait: async () => {},
    settle: () => void o.settled?.push(1),
    keep: async (p: EvmPendingOnward) => {
      // kept before its bytes leave: no raw send yet of this hash, nor of any resend kept (review 2 N5)
      const keptNow = [p.onward, ...(p.resends ?? []).map((r) => r.hash)];
      assert.ok(!(side.sent ?? []).some((r) => keptNow.includes("0x" + hex(keccak_256(Uint8Array.from(Buffer.from(r.slice(2), "hex")))))), "kept before it leaves");
      o.kept?.push(p);
    },
  }) as unknown as EvmWithdrawHost;
const BIG_CAP = { feeCap: W_BOUND.toString() };

test("a reload whose release reads none past its deadline: read again until a second pass the lag margin later reads none too, then stopped and the note settled, nothing sent", async () => {
  const side = releaseSide({ logs: false });
  const clock = { ms: NOW };
  const settled: number[] = [];
  const state = { stops: [null, null] as [bigint | null, bigint | null], noneAt: null as bigint | null };
  const host = finishHost(side, { clock, settled });
  assert.equal(await finishEvmOnward(host, pendingOf(BIG_CAP), state), null, "one pass of none: read again");
  clock.ms = NOW + BigInt(EVM_BUY_LAG_MS) - 1n;
  assert.equal(await finishEvmOnward(host, pendingOf(BIG_CAP), state), null, "under the lag margin: read again");
  clock.ms = NOW + BigInt(EVM_BUY_LAG_MS);
  assert.deepEqual(await finishEvmOnward(host, pendingOf(BIG_CAP), state), { stage: "stopped", txs: [], arrived: {} });
  assert.equal(settled.length, 1, "the note settled once");
  assert.deepEqual(side.sent ?? [], [], "nothing sent");
  // a read not yet past the deadline is no "none": read again
  assert.equal(await finishEvmOnward(finishHost(releaseSide({ logs: false, ended: false }), { clock }), pendingOf(BIG_CAP)), null);
});

test("a reload whose release is another's (paying another address): stopped, the note settled, nothing sent", async () => {
  for (const side of [releaseSide({ to: SAFE })]) {
    const settled: number[] = [];
    assert.deepEqual(await finishEvmOnward(finishHost(side, { settled }), pendingOf(BIG_CAP)), { stage: "stopped", txs: [], arrived: {} });
    assert.deepEqual(side.sent ?? [], [], "nothing sent");
    assert.equal(settled.length, 1);
  }
});

test("a reload whose release is this attempt's and W's send never left: W sends exactly the part to To, its hash kept before it leaves, the op sent with what arrived", async () => {
  const side = { ...releaseSide(), landsOnSend: true };
  const kept: EvmPendingOnward[] = [];
  const got = await finishEvmOnward(finishHost(side, { kept }), pendingOf(BIG_CAP));
  assert.equal(side.sent?.length, 2, "the one send, to both RPCs");
  assert.equal(side.sent![0], side.sent![1]);
  const hash = "0x" + hex(keccak_256(Uint8Array.from(Buffer.from(side.sent![0]!.slice(2), "hex"))));
  assert.deepEqual(kept.map((p) => p.onward), [hash], "its hash kept");
  assert.deepEqual(got, { stage: "sent", txs: [{ chain: "base", hash: REL }, { chain: "base", hash }], arrived: { [hash]: PART.toString() } });
});

test("a reload with several of W's sends kept (a reload's, another tab's): the one that landed read back, whichever it is, nothing signed again", async () => {
  const H1 = "0x" + "c1".repeat(32);
  const H2 = "0x" + "c2".repeat(32);
  const side: Side = { ...releaseSide(), receipts: { [H1]: { status: "0x1", from: W, to: TO, blockHash: "0x" + "ee".repeat(32) } }, txs: { ...releaseSide().txs, [H1]: { value: q(PART) } } };
  const got = await finishEvmOnward(finishHost(side), pendingOf({ ...BIG_CAP, onward: H2, onwards: [H1, H2] }));
  assert.deepEqual(got, { stage: "sent", txs: [{ chain: "base", hash: H1 }], arrived: { [H1]: PART.toString() } });
  assert.deepEqual(side.sent ?? [], [], "nothing signed again");
});

test("W's nonce past 0 on both RPCs (one of its sends landed): read again until both RPCs hold a kept send's receipt, with a send kept or none (review P1-1: never sent on a nonce)", async () => {
  const kept = { ...releaseSide(), nonce: 1n };
  assert.equal(await finishEvmOnward(finishHost(kept), pendingOf({ ...BIG_CAP, onward: "0x" + "c2".repeat(32) })), null);
  assert.deepEqual(kept.sent ?? [], [], "nothing signed at nonce 1");
  const none = { ...releaseSide(), nonce: 1n };
  assert.equal(await finishEvmOnward(finishHost(none), pendingOf(BIG_CAP)), null, "none kept: read again, never sent");
  assert.deepEqual(none.sent ?? [], []);
});

test("the withdraw's live check reads what the page sends: the release's selector, the pool's Withdrawn topic and the bundle marks this code carries (scripts/live-checks/evm-withdraw-mainnet.mjs)", async () => {
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

// ---------- review of 0f442b76 (verdict FIX): each test red at 0f442b76, green after ----------

// P1-1 (review R1): one RPC alone reads W's nonce past 0 (the other 0, W holding the part, nothing kept): never "sent"
test("(review P1-1, R1) one RPC's nonce past 0 alone: the finish reads again (null), nothing signed, never sent", async () => {
  const honest = { ...releaseSide(), landsOnSend: true };
  const hostile = { ...releaseSide(), nonce: 1n };
  const host = { ...finishHost(honest), rpcs: [rpcOf(honest, []), rpcOf(hostile, [])] } as unknown as EvmWithdrawHost;
  assert.equal(await finishEvmOnward(host, pendingOf(BIG_CAP)), null);
  assert.deepEqual([honest.sent ?? [], hostile.sent ?? []], [[], []], "nothing signed while the two disagree");
  // the other way round too
  const host2 = { ...finishHost(honest), rpcs: [rpcOf(hostile, []), rpcOf(honest, [])] } as unknown as EvmWithdrawHost;
  assert.equal(await finishEvmOnward(host2, pendingOf(BIG_CAP)), null);
});

// P2-2 (review R2): W's one send landed with status 0 on both RPCs (a To with code that reverts)
test("(review P2-2, R2; review 2 P2-A) a kept send that reverted (status 0 on both): the op stays in_transit, its answer names what W holds and W's index; nothing signed in the same pass", async () => {
  const H1 = "0x" + "c1".repeat(32);
  const side: Side = { ...releaseSide(), nonce: 1n, receipts: { [H1]: { status: "0x0", from: W, to: TO, blockHash: "0x" + "ee".repeat(32) } } };
  const got = await finishEvmOnward(finishHost(side), pendingOf({ ...BIG_CAP, onward: H1 }));
  assert.deepEqual(got, {
    stage: "in_transit", txs: [{ chain: "base", hash: REL }, { chain: "base", hash: H1 }], arrived: {},
    held: { chain: "base", noteId: "n1", w: W, l: L.toString(), j: 0, amount: (PART + W_BOUND).toString() },
  });
  assert.deepEqual(side.sent ?? [], [], "nothing signed before `held` is written");
  // status 0 on one RPC only: no end, read again
  const one: Side = { ...side, receipts: { [H1]: { status: "0x0", from: W, to: TO, blockHash: "0x" + "ee".repeat(32) } } };
  const other: Side = { ...side, receipts: { [H1]: { status: "0x1", from: W, to: TO, blockHash: "0x" + "ee".repeat(32) } } };
  const host = { ...finishHost(one), rpcs: [rpcOf(one, []), rpcOf(other, [])] } as unknown as EvmWithdrawHost;
  assert.equal(await finishEvmOnward(host, pendingOf({ ...BIG_CAP, onward: H1 })), null);
});

// P1-2 (review R3): the release reached the pool through a wrapper contract (its transaction's `to` another address)
test("(review P1-2, R3) a release sent through a wrapper is this part's: W sends exactly the part to To", async () => {
  // Why a wrapper cannot change what W receives: the match is the pinned pool's own Withdrawn (its log address the
  // pin's), the same on both RPCs, for this nullifier, paying W the chunk at a fee at most the cap: the pool pays W the
  // chunk less that fee in the very call that emits it, whoever called. Only W's key moves W's money, and W's one
  // nonce-0 send moves min(part, balance - bound): never more than the part, whatever else W holds.
  const side = { ...releaseSide(), landsOnSend: true };
  const tx = side.txs![REL] as { to: string; input: string };
  side.txs = { [REL]: { to: "0x3333333333333333333333333333333333333333", input: "0xdeadbeef" + tx.input.slice(10) } };
  const got = await finishEvmOnward(finishHost(side), pendingOf(BIG_CAP));
  assert.equal(got?.stage, "sent");
  assert.equal(side.sent?.length, 2, "W's one send, to both RPCs");
  const hash = "0x" + hex(keccak_256(Uint8Array.from(Buffer.from(side.sent![0]!.slice(2), "hex"))));
  assert.deepEqual(got?.arrived, { [hash]: PART.toString() }, "exactly the part");
  // W holding more than the chunk less the fee (a wrapper that sent W more): still exactly the part
  const rich = { ...releaseSide(), landsOnSend: true, balance: PART + W_BOUND + 10n ** 18n };
  rich.txs = side.txs;
  const got2 = await finishEvmOnward(finishHost(rich), pendingOf(BIG_CAP));
  const hash2 = "0x" + hex(keccak_256(Uint8Array.from(Buffer.from(rich.sent![0]!.slice(2), "hex"))));
  assert.deepEqual(got2?.arrived, { [hash2]: PART.toString() });
  // another release of the nullifier (another chunk): another's, stopped, nothing sent
  const chunkOff = releaseSide();
  const log = chunkOff.logs![0] as { data: string };
  chunkOff.logs = [{ ...log, data: "0x" + [BigInt(FEE_TO), PART + FEE + 210_000_000_000n + 1n, FEE, 12n, 1n].map((v) => v.toString(16).padStart(64, "0")).join("") }];
  assert.equal((await finishEvmOnward(finishHost(chunkOff), pendingOf(BIG_CAP)))?.stage, "stopped");
  assert.deepEqual(chunkOff.sent ?? [], []);
});

// P3: the fee recipient as To, with a fee recipient above every precompile (FEE_TO above is under 0x10000)
test("(review P3) To refused when it is the fee recipient, a fee recipient above 0x10000", () => {
  const high = "0x5555555555555555555555555555555555555555";
  const pin: EvmPoolPin = { ...BASE_PIN, feeRecipient: high };
  assert.equal(evmToRefused(high, pin, [W]), true);
  assert.equal(evmToRefused(high.toUpperCase().replace("0X", "0x"), pin, [W]), true);
  assert.equal(evmToRefused(TO, pin, [W]), false);
});

test("(review P3) W's send's receipt: ok or failed only when both RPCs read the same status", async () => {
  const r = (status: string) => ({ receipt: { status, from: W, to: TO, blockHash: "0x" + "ee".repeat(32) } });
  const of = (a: Side, b: Side) => [rpcOf(a, []), rpcOf(b, [])] as unknown as EvmWithdrawHost["rpcs"];
  assert.equal(await onwardReceipt(of(r("0x1"), r("0x1")), ONWARD, W, TO), "ok");
  assert.equal(await onwardReceipt(of(r("0x0"), r("0x0")), ONWARD, W, TO), "failed");
  assert.equal(await onwardReceipt(of(r("0x1"), r("0x0")), ONWARD, W, TO), null);
  assert.equal(await onwardReceipt(of(r("0x0"), r("0x1")), ONWARD, W, TO), null);
  assert.equal(await onwardReceipt(of(r("0x1"), {}), ONWARD, W, TO), null);
});

test("(review P3) W's send waits for its keep: a keep that has not answered holds the bytes back, and one that fails sends nothing", async () => {
  // a keep that answers a turn later: no raw send before it answered
  const side = { ...releaseSide(), landsOnSend: true };
  let answered = false;
  const host = {
    ...finishHost(side),
    keep: async () => {
      await new Promise((r) => setTimeout(r, 5));
      assert.deepEqual(side.sent ?? [], [], "nothing left before the keep answered");
      answered = true;
    },
  } as unknown as EvmWithdrawHost;
  assert.equal((await finishEvmOnward(host, pendingOf(BIG_CAP)))?.stage, "sent");
  assert.ok(answered);
  // a keep that fails (no longer this attempt's): nothing leaves, read again
  const no = { ...releaseSide(), landsOnSend: true };
  const failing = { ...finishHost(no), keep: async () => Promise.reject(new Error("owed send: not this attempt's")) } as unknown as EvmWithdrawHost;
  assert.equal(await finishEvmOnward(failing, pendingOf(BIG_CAP)), null);
  assert.deepEqual(no.sent ?? [], [], "nothing sent unkept");
});

test("(review P3) W's bound over the part's fee cap: in_transit with the fee it needs, nothing signed", async () => {
  const side = { ...releaseSide(), landsOnSend: true };
  const got = await finishEvmOnward(finishHost(side), pendingOf({ feeCap: (W_BOUND - 1n).toString() }));
  assert.deepEqual(got, { stage: "in_transit", txs: [], arrived: {}, feeNeeded: W_BOUND.toString() });
  assert.deepEqual(side.sent ?? [], []);
});

// ---------- the run (review P2-4): a note store, the pool's trees and bind, the helper's send and two RPCs ----------
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
const RUN_FEE_TO = "0x5555555555555555555555555555555555555555";
const RUN_VENUES = Object.freeze({ "base-sepolia": Object.freeze({ ...evmPoolVenues()["base-sepolia"], pool: POOL }) });
const RUN_SCOPE = evmPoolScopeOf(POOL, BigInt(RUN_VENUES["base-sepolia"].chainId));
const RUN_L1 = evmPoolChainFee("base-sepolia", EVM_ONWARD_L1_BYTES, [900n, 0n]);
const RUN_WFEE = EVM_ONWARD_GAS * (2n * BASE_FEE + EVM_ONWARD_TIP) + RUN_L1;
const RUN_ASK = { kind: "pool.withdraw", chain: "base", token: null, amount: 0n, slippageBps: 0, decimals: 18 } as const;
type RunPlant = {
  /** the helper's release: lands (default), never, or lands only once the clock is `lateMs` past the send */
  release?: "lands" | "never"; lateMs?: bigint;
  /** W's nonce as each RPC reads it once the release landed (default: 0, 1 once W's send left) */
  nonce?: [bigint, bigint];
  /** W's send's status (default 0x1) */
  status?: "0x1" | "0x0";
  /** each RPC's eth_blockNumber */
  heads?: [bigint, bigint];
  /** the proof's withdrawn value off by this (a prover that answers another value) */
  valueOff?: bigint;
  /** the helper's bind for W's part: another fee than the probe's, or another recipient than W */
  bindFee?: bigint; recipient?: string;
  /** the note a change note (not a deposit's own), and landed this epoch: the epoch's trees lack it */
  change?: boolean; thisEpoch?: boolean;
  /** the epoch trees hold the note only from this time on (default: past NOW when `thisEpoch`) */
  inFromMs?: bigint;
};
async function runWorld(plant: RunPlant = {}) {
  const ws = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => ws.close());
  await ws.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const notes = await openNoteStore(ws);
  closers.push(() => notes.close());
  const value = 10n ** 15n;
  const planned = await notes.planDeposit(RUN_SCOPE, (r) => noteSecrets(SEED, r).precommitment);
  const inc = await notes.move(planned.id, "PLANNED", "INCOMING", { send: { signature: "5".repeat(87), value, last_valid_block_height: 1_000n } });
  const label = vaultLabelOf(keccak_256, RUN_SCOPE, 1n);
  // a change note's own secrets make its leaf, its nullifier and its W (a return, move or refund note is the same case)
  const ref = plant.change ? ({ kind: "change", l: label, j: 1 } as const) : inc.ref;
  const commitment = noteCommitment(value, label, inc.precommitment);
  // the pool's tree holds the leaf the note's own secrets make (the store's record keeps its deposit's)
  const leafOf = noteCommitment(value, label, noteSecrets(SEED, ref).precommitment);
  await notes.move(inc.id, "INCOMING", "UNSPENT", { leaf: { value, label, commitment, leafIndex: 0n } });
  const noteId = inc.id;
  const w = freshWallet(SEED, "evm", label, jOf(ref)).address;
  const nullifier = noteSecrets(SEED, ref).nullifierHash;
  const clock = { ms: NOW };
  const chain = { logs: [] as unknown[], balance: 0n, sent: [] as string[], sentAt: null as bigint | null, binds: [] as bigint[], sends: 0, keeps: [] as EvmPendingOnward[], owes: [] as EvmPendingOnward[], stages: [] as string[], trees: [] as { beforeMs: bigint; newest: boolean; signal: boolean }[] };
  const tree = (xs: bigint[]) => new VaultTree(xs);
  const pool = {
    id: `evm:${POOL}`, chain: "evm", scope: RUN_SCOPE, ladder: [], epochMs: 60_000n, lifeMs: 210_000n, sendMarginMs: 30_000n,
    now: async () => clock.ms,
    trees: async (beforeMs: bigint, _s?: unknown, o?: { newest?: boolean }) => {
      chain.trees.push({ beforeMs, newest: o?.newest === true, signal: _s instanceof AbortSignal });
      // landed this epoch: the epoch's own trees (up to NOW, an epoch's start) do not hold it
      if (plant.thisEpoch && o?.newest !== true && (plant.inFromMs !== undefined ? beforeMs < plant.inFromMs : beforeMs <= NOW)) return { stateTree: { size: 0 }, labelTree: { size: 0 }, stateRoot: 0n, labelRoot: 0n };
      return { stateTree: tree([leafOf]), labelTree: tree([label]), stateRoot: tree([leafOf]).root!, labelRoot: tree([label]).root! };
    },
    bind: async (b: { chunk: bigint; wallet: { address: string }; refundPrecommitment: bigint; deadlineMs: bigint }) => {
      const isW = lower(b.wallet.address) === lower(w);
      const fee = isW ? (plant.bindFee ?? FEE) : FEE;
      const relay: EvmRelayData = { recipient: isW ? (plant.recipient ?? b.wallet.address) : b.wallet.address, feeRecipient: RUN_FEE_TO, feeCap: fee, deadlineMs: b.deadlineMs, refundPrecommitment: b.refundPrecommitment, salt: "0x" + (chain.binds.length + 1).toString(16).padStart(32, "0") };
      if (isW) chain.binds.push(b.chunk);
      const request: EvmPoolRequest = { processooor: POOL, relay };
      return { context: evmPoolContextOf(request, RUN_SCOPE), feeCap: fee, request };
    },
  } as unknown as Pool<EvmPoolRequest>;
  const prover = signalsProver();
  const proverOf = plant.valueOff === undefined ? prover : { ...prover, prove: async (c: string, input: unknown) => {
    const r = (await prover.prove(c as never, input as never)) as { publicSignals: string[] };
    return { ...r, publicSignals: r.publicSignals.map((x, k) => (k === 2 ? (BigInt(x) + plant.valueOff!).toString() : x)) };
  } };
  const topic = "0x" + hex(keccak_256(new TextEncoder().encode("Withdrawn(address,address,uint256,uint256,uint256,uint256)")));
  const rawHash = (r: string) => "0x" + hex(keccak_256(Uint8Array.from(Buffer.from(r.slice(2), "hex"))));
  const rpc = (k: 0 | 1) => async (method: string, params: readonly unknown[] = []): Promise<unknown> => {
    if (method === "eth_blockNumber") return q(plant.heads?.[k] ?? 0x100n);
    if (method === "eth_getBlockByNumber") {
      const at = typeof params[0] === "string" && params[0].startsWith("0x") ? BigInt(params[0]) : 0x100n;
      // the blocks past the proof's deadline: a read with no release reads "none"
      return { number: q(at), hash: "0x" + "be".repeat(32), timestamp: q((NOW + 600_000n) / 1000n), baseFeePerGas: q(BASE_FEE) };
    }
    if (method === "eth_getLogs") return chain.sentAt !== null && clock.ms - chain.sentAt >= (plant.lateMs ?? 0n) ? chain.logs : [];
    if (method === "eth_getBalance") return q(lower(String(params[0])) === lower(w) ? chain.balance : 0n);
    if (method === "eth_getCode") return "0x";
    if (method === "eth_estimateGas") return q(EVM_ONWARD_GAS);
    if (method === "eth_call") {
      const c = params[0] as { to: string; data?: string };
      if (c.to.toLowerCase() === "0x420000000000000000000000000000000000000f") return word(c.data!.startsWith("0xf1c7a58b") ? 900n : 0n);
      return "0x";
    }
    if (method === "eth_getTransactionCount") return q(plant.nonce?.[k] ?? (chain.sent.length > 0 ? 1n : 0n));
    if (method === "eth_sendRawTransaction") {
      chain.sent.push(String(params[0]));
      return rawHash(String(params[0]));
    }
    if (method === "eth_getTransactionReceipt") return chain.sent.some((r) => rawHash(r) === params[0]) ? { status: plant.status ?? "0x1", from: w, to: TO, blockHash: "0x" + "ee".repeat(32), blockNumber: q(0x100n) } : null;
    if (method === "eth_getTransactionByHash") return { value: q(PART) };
    throw new Error(`no ${method}`);
  };
  // a change note: the store's record as read, its ref a change's (a note a return, move or refund made is the same case)
  const asChange = (n: NoteRecord | undefined) => (n === undefined ? n : ({ ...n, ref } as unknown as NoteRecord));
  const seen = plant.change ? Object.assign(Object.create(notes) as NoteStore, { get: async (id: string) => asChange(await notes.get(id)), list: async () => (await notes.list()).map((n) => asChange(n)!) }) : notes;
  const h: EvmWithdrawHost = {
    chain: "base", testnet: true, pin: { ...BASE_PIN, feeRecipient: RUN_FEE_TO }, venues: RUN_VENUES as never, rpcs: [rpc(0), rpc(1)], pool, prover: proverOf as never,
    notes: async () => seen, seed64: async () => SEED.slice(),
    send: async () => {
      chain.sends++;
      if (plant.release === "never") return "0x" + "ab".repeat(32);
      const chunk = chain.binds.at(-1)!;
      const data = "0x" + [BigInt(RUN_FEE_TO), chunk, FEE, nullifier, 1n].map((v) => v.toString(16).padStart(64, "0")).join("");
      chain.logs = [{ address: POOL, topics: [topic, word(BigInt(w))], data, blockNumber: q(0x100n), logIndex: "0x0", transactionHash: REL, blockHash: "0x" + "bb".repeat(32) }];
      chain.sentAt = clock.ms;
      chain.balance = chunk - FEE;
      return REL;
    },
    settle: () => {},
    owe: async (p) => void chain.owes.push(p),
    keep: async (p) => void chain.keeps.push(p),
    stage: (s) => void chain.stages.push(s),
    now: () => clock.ms,
    wait: async (ms) => void (clock.ms += BigInt(ms)),
  };
  if (plant.release === "never") h.send = async () => ((chain.sentAt = clock.ms), chain.sends++, "0x" + "ab".repeat(32));
  return { h, notes, noteId, chain, clock, w, label };
}
const MAX = FEE + RUN_WFEE;

test("(review P2-4) the run: one part, exactly the part arrives at To, W's send kept before it leaves, the op sent", async () => {
  const { h, chain, notes, noteId } = await runWorld();
  const got = await runEvmPoolWithdraw(h, RUN_ASK, TO, PART, MAX);
  assert.equal(got.stage, "sent");
  assert.equal(got.pending, null);
  assert.equal(chain.binds.at(-1), PART + FEE + RUN_WFEE, "the chunk: part + fee + W's fee");
  assert.equal(chain.sends, 1);
  const hash = "0x" + hex(keccak_256(Uint8Array.from(Buffer.from(chain.sent[0]!.slice(2), "hex"))));
  assert.deepEqual(got.arrived, { [hash]: PART.toString() });
  assert.deepEqual(got.txs.map((t) => t.hash), [REL, hash]);
  assert.ok(chain.keeps.some((p) => p.onward === hash), "W's send's hash kept");
  assert.equal((await notes.get(noteId))?.state, "RESERVED", "settled by the settle pass, not here");
});

test("(review P2-4, M17) the run: a Max fee under the parts' fees stops before anything is bound or sent; exactly the fees goes on", async () => {
  const under = await runWorld();
  assert.equal((await runEvmPoolWithdraw(under.h, RUN_ASK, TO, PART, MAX - 1n)).stage, "stopped");
  assert.deepEqual([under.chain.binds.length, under.chain.sends, under.chain.sent.length], [0, 0, 0]);
  assert.equal((await under.notes.get(under.noteId))?.state, "UNSPENT");
  const exact = await runWorld();
  assert.equal((await runEvmPoolWithdraw(exact.h, RUN_ASK, TO, PART, MAX)).stage, "sent");
});

test("(review P2-4, M13) the run: one read of none is never the end; a release its logs show a few seconds later is read back and sent on", async () => {
  // the logs trail their blocks by 3 s, under the lag margin: the first read is "none" past the deadline
  assert.ok(3_000n < BigInt(EVM_BUY_LAG_MS));
  const { h, chain } = await runWorld({ lateMs: 3_000n });
  const got = await runEvmPoolWithdraw(h, RUN_ASK, TO, PART, MAX);
  assert.equal(got.stage, "sent");
  assert.equal(chain.sent.length, 2, "W's send, to both RPCs");
  // a release that never lands: two reads of none the lag margin apart, then stopped, nothing sent from W
  const never = await runWorld({ release: "never" });
  const t0 = never.clock.ms;
  assert.equal((await runEvmPoolWithdraw(never.h, RUN_ASK, TO, PART, MAX)).stage, "stopped");
  assert.ok(never.clock.ms - t0 >= BigInt(EVM_BUY_LAG_MS), "the second none the lag margin after the first");
  assert.deepEqual(never.chain.sent, []);
});

test("(review P2-4, M6) the run: a proof of another value is refused before W signs (the prover's answer is held to the input's signals), the note back UNSPENT", async () => {
  for (const off of [1n, -1n]) {
    const { h, chain, notes, noteId } = await runWorld({ valueOff: off });
    assert.equal((await runEvmPoolWithdraw(h, RUN_ASK, TO, PART, MAX)).stage, "stopped");
    assert.deepEqual([chain.sends, chain.sent.length, chain.owes.length], [0, 0, 0]);
    assert.equal((await notes.get(noteId))?.state, "UNSPENT");
  }
});

test("(review P1-1) the run: W's nonce past 0 with nothing kept, or two RPCs that differ on it: the part stays owed (in_transit), never dropped, nothing sent from W", async () => {
  for (const nonce of [[1n, 1n], [0n, 1n], [1n, 0n]] as [bigint, bigint][]) {
    const { h, chain } = await runWorld({ nonce });
    const got = await runEvmPoolWithdraw(h, RUN_ASK, TO, PART, MAX);
    assert.equal(got.stage, "in_transit", `nonce ${nonce}`);
    assert.equal(got.pending?.release, REL, "the owed send kept, its release read back");
    assert.deepEqual(chain.sent, []);
  }
});

test("(review P2-1, R4) the run: two heads further apart than EVM_BUY_HEAD_SPREAD stop the part before W signs, the note back UNSPENT", async () => {
  const far = await runWorld({ heads: [100_000n, 100_000n - EVM_BUY_HEAD_SPREAD - 1n] });
  assert.equal((await runEvmPoolWithdraw(far.h, RUN_ASK, TO, PART, MAX)).stage, "stopped");
  assert.deepEqual([far.chain.sends, far.chain.owes.length], [0, 0]);
  assert.equal((await far.notes.get(far.noteId))?.state, "UNSPENT");
  // the lower head above the lag margin (EVM_BUY_LAG_BLOCKS), the release's block (0x100) inside the range
  const near = await runWorld({ heads: [0x200n + EVM_BUY_HEAD_SPREAD, 0x200n] });
  assert.equal((await runEvmPoolWithdraw(near.h, RUN_ASK, TO, PART, MAX)).stage, "sent");
  assert.equal(near.chain.owes[0]?.from, (0x200n - EVM_BUY_LAG_BLOCKS).toString(), "a lag margin under the lower head");
});

test("(review P2-2; review 2 P2-A, P3-1, X18) the run: W's send reverted (status 0 on both): in_transit, the owed send kept, `held` in the stage's own call, the reverted send in the txs", async () => {
  const { h, chain, w, label, noteId } = await runWorld({ status: "0x0" });
  const calls: { stage: string; pending: unknown; held: unknown }[] = [];
  h.stage = (s, _t, p, _a, held?: unknown) => void calls.push({ stage: s, pending: p, held });
  const got = await runEvmPoolWithdraw(h, RUN_ASK, TO, PART, MAX);
  const held = { chain: "base", noteId, w, l: label.toString(), j: 0, amount: (PART + RUN_WFEE).toString() };
  assert.equal(got.stage, "in_transit");
  assert.equal(got.pending?.noteId, noteId, "the owed send kept: the state reads finish it");
  assert.equal(got.pending?.release, REL);
  assert.deepEqual(got.held, held);
  assert.equal(chain.sent.length, 2, "W's one send only, to both RPCs");
  const hash = "0x" + hex(keccak_256(Uint8Array.from(Buffer.from(chain.sent[0]!.slice(2), "hex"))));
  assert.deepEqual(got.txs.map((t) => t.hash), [REL, hash], "the reverted send in the op's txs");
  const last = calls.at(-1)!;
  assert.equal(last.stage, "in_transit");
  assert.notEqual(last.pending, null, "the stage write never clears the owed send");
  assert.deepEqual(last.held, held, "`held` in the same call as the stage");
});

test("(review M18) the run: a bind for W's part under another fee than the plan's (a lower one the rule lets pass) stops before W signs, the note back UNSPENT", async () => {
  const { h, chain, notes, noteId } = await runWorld({ bindFee: FEE - 1n });
  assert.equal((await runEvmPoolWithdraw(h, RUN_ASK, TO, PART, MAX)).stage, "stopped");
  assert.deepEqual([chain.binds.length, chain.sends, chain.owes.length], [1, 0, 0]);
  assert.equal((await notes.get(noteId))?.state, "UNSPENT");
});

test("(review M2) the run: a bind whose relay data names another recipient than W is refused before W signs (the rule's checkRelay, and the run's own check at the signer)", async () => {
  const { h, chain, notes, noteId } = await runWorld({ recipient: SAFE });
  assert.equal((await runEvmPoolWithdraw(h, RUN_ASK, TO, PART, MAX)).stage, "stopped");
  assert.deepEqual([chain.sends, chain.owes.length], [0, 0]);
  assert.equal((await notes.get(noteId))?.state, "UNSPENT");
});

test("(review M9) one RPC's nonce past 0 with a kept send that reads status 0: read again, never stopped on one RPC's word", async () => {
  const H1 = "0x" + "c1".repeat(32);
  const receipts = { [H1]: { status: "0x0", from: W, to: TO, blockHash: "0x" + "ee".repeat(32) } };
  const past: Side = { ...releaseSide(), nonce: 1n, receipts };
  const zero: Side = { ...releaseSide(), nonce: 0n, receipts };
  const host = { ...finishHost(past), rpcs: [rpcOf(past, []), rpcOf(zero, [])] } as unknown as EvmWithdrawHost;
  assert.equal(await finishEvmOnward(host, pendingOf({ ...BIG_CAP, onward: H1 })), null);
  assert.deepEqual([past.sent ?? [], zero.sent ?? []], [[], []]);
});

// ---------- review 2 of e1f9e87a (verdict FIX): each test red at e1f9e87a unless it says it kills a mutant ----------
const H1 = "0x" + "c1".repeat(32);
const R1 = "0x" + "d1".repeat(32);
const rcpt = (status: string, o: { bh?: string; block?: bigint } = {}) => ({ status, from: W, to: TO, blockHash: o.bh ?? "0x" + "ee".repeat(32), blockNumber: q(o.block ?? 0xf0n) });
const rawHashOf = (r: string) => "0x" + hex(keccak_256(Uint8Array.from(Buffer.from(r.slice(2), "hex"))));
// W after its nonce-0 send reverted: the part less what that send burned (21,000 gas at the base fee)
const HELD_BAL = PART + W_BOUND - 21_000n * BASE_FEE;
const heldOf = (o: Partial<EvmHeldOnW> = {}): EvmHeldOnW => ({ chain: "base", noteId: "n1", w: W, l: L.toString(), j: 0, amount: HELD_BAL.toString(), ...o });
// a reload after the revert: the release this part's, W's nonce-0 send H1 reverted on both RPCs, W's nonce `nonce`
const heldSide = (o: Side = {}): Side => ({ ...releaseSide(), nonce: 1n, balance: HELD_BAL, landsOnSend: true, ...o, receipts: { [H1]: rcpt("0x0"), ...(o.receipts ?? {}) } });

test("(review 2 P2-A) the resend: with `held`, W sends what it holds less its gas, at its next nonce, to the same To, after the send ran on both RPCs; kept before it leaves; sent once it lands", async () => {
  const side = heldSide();
  const kept: EvmPendingOnward[] = [];
  const calls: Call[] = [];
  const host = { ...finishHost(side, { kept }), rpcs: [rpcOf(side, calls), rpcOf(side, calls)] } as unknown as EvmWithdrawHost;
  const got = await finishEvmOnward(host, pendingOf({ ...BIG_CAP, onward: H1 }), undefined, heldOf());
  assert.equal(side.sent?.length, 2, "one send, to both RPCs");
  const hash = rawHashOf(side.sent![0]!);
  const value = HELD_BAL - W_BOUND;
  assert.deepEqual(got, { stage: "sent", txs: [{ chain: "base", hash: REL }, { chain: "base", hash }], arrived: { [hash]: value.toString() } });
  assert.deepEqual(kept.map((p) => p.resends), [[{ nonce: "1", hash }]], "kept, with its nonce, before it left");
  const runs = calls.filter((c) => c.method === "eth_call" && lower((c.params[0] as { to: string }).to) === lower(TO));
  assert.equal(runs.length, 2, "the very send run on both RPCs before it is signed");
  for (const r of runs) assert.deepEqual([lower((r.params[0] as { from: string }).from), (r.params[0] as { value: string }).value], [lower(W), q(value)]);
  // W holding more than the part and its bound: exactly the part, never more
  const rich = heldSide({ balance: PART + 2n * W_BOUND });
  const got2 = await finishEvmOnward(finishHost(rich), pendingOf({ ...BIG_CAP, onward: H1 }), undefined, heldOf());
  assert.deepEqual(Object.values(got2?.arrived ?? {}), [PART.toString()]);
});

test("(review 2 N7) the resend's bound over the part's fee cap: in_transit with the fee it needs, nothing signed", async () => {
  const side = heldSide();
  const got = await finishEvmOnward(finishHost(side), pendingOf({ feeCap: (W_BOUND - 1n).toString(), onward: H1 }), undefined, heldOf());
  assert.deepEqual(got, { stage: "in_transit", txs: [], arrived: {}, feeNeeded: W_BOUND.toString() });
  assert.deepEqual(side.sent ?? [], []);
});

test("(review 2 P2-A) the resend waits: its run reverting on either RPC, W's nonce 0 (never a second nonce-0 send while `held` is set), or the two RPCs' nonces apart: read again, nothing signed", async () => {
  for (const [name, a, b] of [
    ["run reverts on one RPC", heldSide(), heldSide({ reverts: true })],
    ["nonce 0 on both", heldSide({ nonce: 0n }), heldSide({ nonce: 0n })],
    ["nonces apart", heldSide({ nonce: 1n }), heldSide({ nonce: 2n })],
  ] as const) {
    const host = { ...finishHost(a), rpcs: [rpcOf(a, []), rpcOf(b, [])] } as unknown as EvmWithdrawHost;
    assert.equal(await finishEvmOnward(host, pendingOf({ ...BIG_CAP, onward: H1 }), undefined, heldOf()), null, name);
    assert.deepEqual([a.sent ?? [], b.sent ?? []], [[], []], `${name}: nothing signed`);
  }
});

test("(review 2 P2-A; review 3 P2-B) the resend lands at most once: a kept resend that landed ends it; one not read back at a nonce W has passed waits; one that reverted ends the resends (in_transit with what W holds, nothing signed)", async () => {
  const landed = heldSide({ nonce: 2n, receipts: { [R1]: rcpt("0x1") }, txs: { ...releaseSide().txs, [R1]: { value: q(PART - 1n) } } });
  const got = await finishEvmOnward(finishHost(landed), pendingOf({ ...BIG_CAP, onward: H1, resends: [{ nonce: "1", hash: R1 }] }), undefined, heldOf());
  assert.deepEqual(got, { stage: "sent", txs: [{ chain: "base", hash: REL }, { chain: "base", hash: R1 }], arrived: { [R1]: (PART - 1n).toString() } });
  assert.deepEqual(landed.sent ?? [], [], "nothing signed again");
  const unread = heldSide({ nonce: 2n });
  assert.equal(await finishEvmOnward(finishHost(unread), pendingOf({ ...BIG_CAP, onward: H1, resends: [{ nonce: "1", hash: R1 }] }), undefined, heldOf()), null);
  assert.deepEqual(unread.sent ?? [], [], "a nonce W passed with no kept send read back: nothing signed");
  const gap = heldSide({ nonce: 2n });
  assert.equal(await finishEvmOnward(finishHost(gap), pendingOf({ ...BIG_CAP, onward: H1 }), undefined, heldOf()), null);
  assert.deepEqual(gap.sent ?? [], [], "a nonce no kept send accounts for: nothing signed");
  const again = heldSide({ nonce: 2n, receipts: { [R1]: rcpt("0x0") } });
  const kept: EvmPendingOnward[] = [];
  const got3 = await finishEvmOnward(finishHost(again, { kept }), pendingOf({ ...BIG_CAP, onward: H1, resends: [{ nonce: "1", hash: R1 }] }), undefined, heldOf());
  assert.deepEqual(got3, { stage: "in_transit", txs: [{ chain: "base", hash: REL }, { chain: "base", hash: R1 }], arrived: {}, held: heldOf() }, "the one resend reverted: the part stays on W");
  assert.deepEqual([again.sent ?? [], kept], [[], []], "no send at nonce 2, nothing kept");
  // the resend itself reverts: in_transit, what W holds now in `held`, its hash in the txs
  const twice = heldSide({ landsOnSend: false, receipt: rcpt("0x0") });
  const got4 = await finishEvmOnward(finishHost(twice), pendingOf({ ...BIG_CAP, onward: H1 }), undefined, heldOf());
  const h2 = rawHashOf(twice.sent![0]!);
  assert.deepEqual(got4, { stage: "in_transit", txs: [{ chain: "base", hash: REL }, { chain: "base", hash: h2 }], arrived: {}, held: heldOf({ amount: HELD_BAL.toString() }) });
});

test("(review 2 P2-A) a `held` that is not this note's own W (another W, index or note): no resend from it; the chain's own word answers (in_transit with what W holds), nothing signed", async () => {
  for (const other of [heldOf({ w: SAFE }), heldOf({ j: 1 }), heldOf({ l: "6" }), heldOf({ noteId: "n2" }), heldOf({ chain: "robinhood" })]) {
    const side = heldSide();
    const got = await finishEvmOnward(finishHost(side), pendingOf({ ...BIG_CAP, onward: H1 }), undefined, other);
    assert.deepEqual(got, { stage: "in_transit", txs: [{ chain: "base", hash: REL }, { chain: "base", hash: H1 }], arrived: {}, held: heldOf() });
    assert.deepEqual(side.sent ?? [], [], "nothing signed");
  }
});

test("(review 2 P3-4) W's send's receipt ends only at or under the safe block both RPCs read, one block number on both", async () => {
  const of = (a: Side, b: Side) => [rpcOf(a, []), rpcOf(b, [])] as unknown as EvmWithdrawHost["rpcs"];
  const at = (status: string, block: bigint, safe = 0x100n): Side => ({ receipt: rcpt(status, { block }), safe });
  assert.equal(await onwardReceipt(of(at("0x1", 0x100n), at("0x1", 0x100n)), ONWARD, W, TO), "ok", "at the safe block");
  assert.equal(await onwardReceipt(of(at("0x1", 0x101n), at("0x1", 0x101n)), ONWARD, W, TO), null, "past it: an unsafe head");
  assert.equal(await onwardReceipt(of(at("0x0", 0x101n), at("0x0", 0x101n)), ONWARD, W, TO), null, "a revert past it too");
  assert.equal(await onwardReceipt(of(at("0x0", 0x100n), at("0x0", 0x100n, 0xffn)), ONWARD, W, TO), null, "one RPC's safe block under it");
  assert.equal(await onwardReceipt(of(at("0x0", 0xf0n), at("0x0", 0xf1n)), ONWARD, W, TO), null, "two block numbers");
  // the run: a send landed past the safe block is not yet sent: in_transit, owed
  const { h } = await runWorld();
  const r1 = h.rpcs[1];
  (h as { rpcs: unknown }).rpcs = [h.rpcs[0], async (m: string, p: unknown[] = []) => (m === "eth_getBlockByNumber" && p[0] === "safe" ? { number: q(0xffn), hash: "0x" + "be".repeat(32), timestamp: q((NOW + 600_000n) / 1000n), baseFeePerGas: q(BASE_FEE) } : r1(m, p as never))];
  const got = await runEvmPoolWithdraw(h, RUN_ASK, TO, PART, MAX);
  assert.equal(got.stage, "in_transit");
  assert.ok(got.pending, "still owed");
});

test("(review 2 X4, kills) a reverted send with W's balance read apart on the two RPCs: no `held` from one RPC's word, read again", async () => {
  const a = heldSide({ balance: PART + W_BOUND });
  const b = heldSide({ balance: PART + W_BOUND + 1n });
  const host = { ...finishHost(a), rpcs: [rpcOf(a, []), rpcOf(b, [])] } as unknown as EvmWithdrawHost;
  assert.equal(await finishEvmOnward(host, pendingOf({ ...BIG_CAP, onward: H1 })), null);
});

test("(review 2 X15, the review's RR4, kills) status 0x0 on both RPCs in two different blocks: no end (null), never reverted", async () => {
  const a: Side = { receipt: rcpt("0x0", { bh: "0x" + "e1".repeat(32) }) };
  const b: Side = { receipt: rcpt("0x0", { bh: "0x" + "e2".repeat(32) }) };
  assert.equal(await onwardReceipt([rpcOf(a, []), rpcOf(b, [])] as unknown as EvmWithdrawHost["rpcs"], ONWARD, W, TO), null);
});

test("(review 2, M351) the run's root: a change note that landed this epoch waits for the pool's next boundary and proves on that epoch's root, never the newest; a deposit's own note proves on the newest", async () => {
  const change = await runWorld({ change: true, thisEpoch: true });
  assert.equal((await runEvmPoolWithdraw(change.h, RUN_ASK, TO, PART, MAX)).stage, "sent", "proved on the next epoch's root and sent");
  assert.ok(!change.chain.trees.some((t) => t.newest), "a change note never proves on the newest root");
  assert.ok(change.chain.trees.some((t) => t.beforeMs === NOW + 60_000n), "the next epoch's trees, once the pool's time reached it");
  assert.ok(change.clock.ms >= NOW + 60_000n, "waited on the pool's time");
  const own = await runWorld({ thisEpoch: true });
  assert.equal((await runEvmPoolWithdraw(own.h, RUN_ASK, TO, PART, MAX)).stage, "sent");
  assert.ok(own.chain.trees.some((t) => t.newest), "a deposit's own note: the newest root, at once");
  assert.equal(own.clock.ms < NOW + 60_000n, true, "no wait for the boundary");
});

test("(review 2 P3-5; review 3) the read-back's range: the head spread, the lag margin and a proof's life of the fastest mainnet's blocks stay under the log span; the margin is twice the lag's blocks, in buy, sell and withdraw", async () => {
  const { EVM_BLOCKS_PER_S_MAX } = (await import("../src/pool-buy-evm.ts")) as unknown as { EVM_BLOCKS_PER_S_MAX: bigint };
  assert.equal(typeof EVM_BLOCKS_PER_S_MAX, "bigint", "the fastest mainnet's read rate, named");
  // twice Robinhood mainnet's 9.3 blocks a second, so a faster chain still fits; the numbers pinned
  assert.deepEqual([EVM_BLOCKS_PER_S_MAX, EVM_BUY_LAG_BLOCKS, EVM_BUY_HEAD_SPREAD, EVM_LIFE_MS, EVM_BUY_LOG_SPAN], [20n, 400n, 5_000n, 210_000n, 20_000n]);
  assert.equal(EVM_BUY_HEAD_SPREAD + EVM_BUY_LAG_BLOCKS + (EVM_BLOCKS_PER_S_MAX * EVM_LIFE_MS) / 1000n, 9_600n);
  assert.ok(EVM_BUY_HEAD_SPREAD + EVM_BUY_LAG_BLOCKS + (EVM_BLOCKS_PER_S_MAX * EVM_LIFE_MS) / 1000n < EVM_BUY_LOG_SPAN);
  assert.ok(EVM_BUY_LAG_BLOCKS >= (2n * EVM_BLOCKS_PER_S_MAX * BigInt(EVM_BUY_LAG_MS)) / 1000n);
  assert.equal(EVM_SELL_LAG_BLOCKS, EVM_BUY_LAG_BLOCKS);
});

// ---------- review 3 of 972be65f (verdict FIX): each test red at 972be65f ----------

test("(review 3 P2-B, RR6) one resend per part: a To that runs in eth_call but reverts on chain gets W's nonce-1 resend once; every later pass signs nothing and answers in_transit with what W holds", async () => {
  const side = heldSide({ landsOnSend: false, receipt: rcpt("0x0") });
  const kept: EvmPendingOnward[] = [];
  let pending = pendingOf({ ...BIG_CAP, onward: H1 });
  const raws = new Set<string>();
  const answers: unknown[] = [];
  for (let pass = 0; pass < 4; pass++) {
    // W's nonce: 1 after its nonce-0 send, one more for each send of W's that landed (reverted)
    side.nonce = 1n + BigInt(raws.size);
    const got = await finishEvmOnward({ ...finishHost(side), keep: async (p: EvmPendingOnward) => void kept.push(p) } as unknown as EvmWithdrawHost, pending, undefined, heldOf());
    answers.push(got);
    for (const r of side.sent ?? []) raws.add(r);
    pending = kept.at(-1) ?? pending;
  }
  assert.equal(raws.size, 1, "one resend signed in four passes");
  assert.deepEqual(pending.resends?.map((r) => r.nonce), ["1"]);
  const r1 = rawHashOf([...raws][0]!);
  for (const got of answers) assert.deepEqual(got, { stage: "in_transit", txs: [{ chain: "base", hash: REL }, { chain: "base", hash: r1 }], arrived: {}, held: heldOf() });
});

test("(review 3 P2-B) after the one resend reverted, no later pass signs anything: not at nonce 2 nor past it, nor again at a lower one", async () => {
  for (const nonce of [2n, 3n, 9n]) {
    const side = heldSide({ nonce, receipts: { [R1]: rcpt("0x0") } });
    const kept: EvmPendingOnward[] = [];
    for (let pass = 0; pass < 3; pass++) {
      const got = await finishEvmOnward(finishHost(side, { kept }), pendingOf({ ...BIG_CAP, onward: H1, resends: [{ nonce: "1", hash: R1 }] }), undefined, heldOf());
      if (nonce === 2n) assert.equal(got?.stage, "in_transit", `nonce ${nonce}`);
      else assert.equal(got, null, `nonce ${nonce}: a send no record names, read again`);
    }
    assert.deepEqual([side.sent ?? [], kept], [[], []], `nonce ${nonce}: nothing signed or kept`);
  }
});

test("(review 3 P2-B) every run of W's send carries its fee fields: the resend's, a first send to a To with code, and the To check before any note moves", async () => {
  const feeFields = (calls: Call[]) => calls.filter((c) => c.method === "eth_call" && lower((c.params[0] as { to: string }).to) === lower(TO)).map((c) => c.params[0] as { maxFeePerGas?: string; maxPriorityFeePerGas?: string });
  const MAX_FEE = 2n * BASE_FEE + EVM_ONWARD_TIP;
  // the resend (no code at To on Base: its run is the one a To that reverts on chain passed at a zero gas price)
  const calls: Call[] = [];
  const side = heldSide();
  await finishEvmOnward({ ...finishHost(side), rpcs: [rpcOf(side, calls), rpcOf(side, calls)] } as unknown as EvmWithdrawHost, pendingOf({ ...BIG_CAP, onward: H1 }), undefined, heldOf());
  const resend = feeFields(calls);
  assert.equal(resend.length, 2, "run on both RPCs");
  for (const c of resend) assert.deepEqual([c.maxFeePerGas, c.maxPriorityFeePerGas], [q(MAX_FEE), q(EVM_ONWARD_TIP)]);
  // W's first send to a To with code
  const code = { [TO.toLowerCase()]: "0x6080" };
  const calls2: Call[] = [];
  const first = { ...releaseSide(), landsOnSend: true, code, estimate: () => 30_000n };
  await finishEvmOnward({ ...finishHost(first), rpcs: [rpcOf(first, calls2), rpcOf(first, calls2)] } as unknown as EvmWithdrawHost, pendingOf({ feeCap: (10n ** 15n).toString() }));
  const sends = feeFields(calls2);
  assert.equal(sends.length, 2);
  for (const c of sends) assert.ok(c.maxFeePerGas !== undefined && BigInt(c.maxFeePerGas) >= BASE_FEE && c.maxPriorityFeePerGas !== undefined, "W's first send's run priced");
  // the To check before any note moves
  const calls3: Call[] = [];
  const s3: Side = { code, estimate: () => 30_000n };
  await evmWithdrawCosts(hostOf("base", s3, s3, calls3), { to: TO, from: W, value: 10n ** 14n });
  const checks = feeFields(calls3);
  assert.equal(checks.length, 2);
  for (const c of checks) assert.deepEqual([c.maxFeePerGas, c.maxPriorityFeePerGas], [q(MAX_FEE), q(EVM_ONWARD_TIP)]);
});

// RR7: a proof queue's pass at the boundary the run waits for, as the page's queue runs it: it takes an UNSPENT note
// (HELD, its proof in flight) unless a withdraw's keep-out names it; a drop of an in-flight proof only marks it, and the
// note comes back UNSPENT when that proof ends (queue.ts drop)
const queueAtBoundary = (world: Awaited<ReturnType<typeof runWorld>>, o: { proofEndsMs?: bigint } = {}) => {
  const kept = { ids: new Set<string>(), until: 0n, calls: [] as [string[], bigint][], at: [] as { ms: bigint; trees: number }[] };
  // the host's record: the span from now (the device's clock, here the world's)
  world.h.keepOut = async (ids, spanMs) => {
    kept.calls.push([[...ids], spanMs]);
    kept.at.push({ ms: world.clock.ms, trees: world.chain.trees.length });
    kept.ids = new Set(ids);
    kept.until = world.clock.ms + spanMs;
  };
  const took = { at: null as bigint | null, dropped: false };
  const wait0 = world.h.wait!;
  world.h.wait = async (ms) => {
    await wait0(ms);
    const at = world.clock.ms;
    if (took.at === null && at >= NOW + 60_000n && !(kept.ids.has(world.noteId) && kept.until > at)) {
      took.at = at;
      await world.notes.move(world.noteId, "UNSPENT", "HELD", { deadlineMs: NOW + 400_000n, context: "1" });
    }
    const n = await world.notes.get(world.noteId);
    if (took.at !== null && took.dropped && n?.state === "HELD" && o.proofEndsMs !== undefined && at >= took.at + o.proofEndsMs) await world.notes.move(world.noteId, "HELD", "UNSPENT", { attempt: n.attempt! });
  };
  world.h.drop = async () => void (took.dropped = true);
  return { kept, took };
};

test("(review 3 P2-C, RR7) the root wait on EVM: the run keeps its planned notes out of every proof queue before it waits, past the latest deadline it can bind; the queue's pass at the boundary skips the note and the part goes on; the keep-out cleared at the end", async () => {
  const world = await runWorld({ change: true, thisEpoch: true });
  const { kept, took } = queueAtBoundary(world);
  const got = await runEvmPoolWithdraw(world.h, RUN_ASK, TO, PART, MAX);
  assert.equal(took.at, null, "no queue took the note at the boundary");
  assert.equal(got.stage, "sent");
  assert.equal(world.chain.sends, 1);
  assert.ok(kept.calls.length >= 2, "kept out before the wait, cleared at the end");
  assert.deepEqual(kept.calls[0]![0], [world.noteId], "the plan's notes");
  assert.equal(kept.calls[0]![1], 60_000n + 30_000n + 210_000n, "for the longest a part can take to bind: the next boundary's epoch, its lag and a proof's life");
  assert.deepEqual(kept.calls.at(-1), [[], 0n], "cleared at the run's end");
  // written before any part, again by the part before it frees its note (a part before it may have outrun the span)
  // and before its first tree read and its wait (each part moves the record on), then cleared: four writes
  const SPAN = 60_000n + 30_000n + 210_000n;
  assert.deepEqual(kept.calls, [[[world.noteId], SPAN], [[world.noteId], SPAN], [[world.noteId], SPAN], [[], 0n]]);
  assert.deepEqual(kept.at.slice(0, 3), [{ ms: NOW, trees: 0 }, { ms: NOW, trees: 0 }, { ms: NOW, trees: 0 }], "all before the part's tree read and its wait");
});

test("(review 3 P2-C) a note the page's queue is still proving when the part needs it: dropped, then waited for until that proof ends and frees it; the part goes on. A proof that never ends stops the part, nothing signed", async () => {
  // the keep-out written after the queue took it (another tab's queue, or a pass right before the write)
  const world = await runWorld({ change: true, thisEpoch: true });
  const { took } = queueAtBoundary(world, { proofEndsMs: 5_000n });
  world.h.keepOut = async () => {};
  const got = await runEvmPoolWithdraw(world.h, RUN_ASK, TO, PART, MAX);
  assert.ok(took.at !== null && took.dropped, "the queue took it and the part dropped it");
  assert.equal(got.stage, "sent", "waited for the proof to end");
  const stuck = await runWorld({ change: true, thisEpoch: true });
  queueAtBoundary(stuck);
  stuck.h.keepOut = async () => {};
  const t0 = stuck.clock.ms;
  assert.equal((await runEvmPoolWithdraw(stuck.h, RUN_ASK, TO, PART, MAX)).stage, "stopped");
  assert.ok(stuck.clock.ms - t0 >= 60_000n, "waited out the free budget past the boundary");
  assert.deepEqual([stuck.chain.sends, stuck.chain.sent.length], [0, 0]);
});

test("(review 4 P3) each part writes its keep-out before it frees its note: a note another tab's queue holds is let go at that queue's next pass, which reads the part's own write", async () => {
  const world = await runWorld({ change: true, thisEpoch: true });
  const states: (string | undefined)[] = [];
  let kept = new Set<string>();
  world.h.keepOut = async (ids) => {
    states.push((await world.notes.get(world.noteId))?.state);
    kept = new Set(ids);
  };
  // another tab's queue holds the note; its pass at each wait lets go of a note the record names
  await world.notes.move(world.noteId, "UNSPENT", "HELD", { deadlineMs: NOW + 400_000n, context: "1" });
  const wait0 = world.h.wait!;
  world.h.wait = async (ms) => {
    await wait0(ms);
    const n = await world.notes.get(world.noteId);
    if (n?.state === "HELD" && n.attempt !== undefined && kept.has(world.noteId)) await world.notes.move(world.noteId, "HELD", "UNSPENT", { attempt: n.attempt });
  };
  delete world.h.drop;
  assert.equal((await runEvmPoolWithdraw(world.h, RUN_ASK, TO, PART, MAX)).stage, "sent");
  assert.deepEqual(states.slice(0, 3), ["HELD", "HELD", "UNSPENT"], "the run's write and the part's own, both before its note is freed; the third before the tree read");
});

test("(review 4 P3) a part that stops on a throw (its note never freed) carries its cause out: the run's answer names it in public words", async () => {
  const world = await runWorld({ change: true, thisEpoch: true });
  // another tab's queue holds the note and never lets go
  await world.notes.move(world.noteId, "UNSPENT", "HELD", { deadlineMs: NOW + 400_000n, context: "1" });
  delete world.h.drop;
  const got = await runEvmPoolWithdraw(world.h, RUN_ASK, TO, PART, MAX);
  assert.equal(got.stage, "stopped");
  assert.match(got.cause ?? "", /^Error note\b/, `the part's stop and its word: ${got.cause}`);
});

test("(review 3 P2-C) a pool time read behind the leaf's own block: the epoch root at the next boundary lacks it, so the part waits on to the boundary after, in the same budget, then proves there; every tree read is bounded in time", async () => {
  // the pool's time 50 s into the epoch, the leaf only in the roots from NOW + 120 s: 10 s and 60 s of waits, under one
  // epoch and the boundary lag (90 s)
  const late = await runWorld({ change: true, thisEpoch: true, inFromMs: NOW + 120_000n });
  late.clock.ms = NOW + 50_000n;
  assert.equal((await runEvmPoolWithdraw(late.h, RUN_ASK, TO, PART, MAX)).stage, "sent");
  assert.deepEqual(late.chain.trees.filter((t) => !t.newest).map((t) => t.beforeMs), [NOW, NOW + 60_000n, NOW + 120_000n]);
  assert.ok(late.chain.trees.every((t) => t.signal), "each tree read carries its time limit");
  // past the budget (the leaf only from NOW + 180 s): stopped, nothing bound or sent
  const never = await runWorld({ change: true, thisEpoch: true, inFromMs: NOW + 180_000n });
  never.clock.ms = NOW + 50_000n;
  assert.equal((await runEvmPoolWithdraw(never.h, RUN_ASK, TO, PART, MAX)).stage, "stopped");
  assert.deepEqual([never.chain.binds.length, never.chain.sends], [0, 0]);
  assert.equal((await never.notes.get(never.noteId))?.state, "UNSPENT");
});
