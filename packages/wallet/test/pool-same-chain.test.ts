// node --test packages/wallet/test/pool-same-chain.test.ts: the same-chain deposit's next step (card pool-deposits,
// src/pool/same-chain.ts). The Solana side runs on the devnet pool's recorded account
// (packages/signpage/test/fixtures/pool-devnet.json: program, tree sizes) with its marks applied as the program makes
// them; the EVM side on Deposited events planted as evmTreeSync gives them for the pinned base-sepolia pool
// (pool-evm-taken.test.ts's way). Test seed only: the all-zero entropy of vectors/a8.json; never money.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, base64 } from "@scure/base";
import { solanaPoolTreeSizes, vaultLabelOf } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { refKey, type NoteState } from "../src/notes/store.ts";
import { evmPoolScopeOf, EVM_LADDER, type EvmPoolEvent, type EvmPoolPin } from "../src/pool/evm.ts";
import { ladderSplit, poolDepositPlan } from "../src/pool/ladder.ts";
import { evmSameChainDeposit, type HeldNote, sameChainNext, solanaChainNext, solanaSameChainDeposit } from "../src/pool/same-chain.ts";
import { SOL_LADDER, solanaPoolOf } from "../src/pool/solana.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const DEVNET = JSON.parse(readFileSync(new URL("../../signpage/test/fixtures/pool-devnet.json", import.meta.url), "utf8")) as { program: string; answers: { accounts: Record<string, { data: [string, string] } | null> }[] };
const PROGRAM = DEVNET.program;
const SCOPE = solanaPoolOf(PROGRAM).scope;
const SIZES = solanaPoolTreeSizes(base64.decode(DEVNET.answers[0]!.accounts.pool!.data[0]));
const BLOCKHASH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const RUNG = SOL_LADDER.min; // 0.01 SOL
const U0: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
const U0n = (n: number): NoteRef => ({ kind: "second", id: { id: "U", s: SCOPE, i: 0 }, n });
const P = (ref: NoteRef) => noteSecrets(SEED, ref).precommitment;

/** One Solana U run as the device would make it, every deposit landing at once: the values deposited, the refs, what U keeps. */
function runSolana(balance: bigint, cost: bigint, floor: bigint) {
  const held: HeldNote[] = [];
  const marks = new Set<bigint>();
  const out: { ref: NoteRef; value: bigint }[] = [];
  for (let k = 0; k < 64; k++) {
    const step = solanaSameChainDeposit({ program: PROGRAM, seed64: SEED, scope: SCOPE, ladder: SOL_LADDER, first: U0, held, marked: (p) => marks.has(p), balance, cost, floor, sizes: SIZES, blockhash: BLOCKHASH });
    if (step.kind === "keep") return { out, left: step.left, u: step.u };
    assert.equal(step.kind, "deposit");
    if (step.kind !== "deposit") throw new Error("unreachable");
    assert.ok(step.tx !== undefined);
    out.push({ ref: step.ref, value: step.value });
    marks.add(step.precommitment);
    held.push({ ref: step.ref, state: "UNSPENT" });
    balance -= step.value + cost;
    assert.equal(balance, step.left);
  }
  throw new Error("no end");
}

test("only the ladder sum goes in: U's notes are exactly the ladder plan's, refs and rungs, and the remainder stays in U", () => {
  const B = 87_654_321n; // 0.087654321 SOL
  const plan = poolDepositPlan(SEED, SCOPE, SOL_LADDER, U0, B);
  const run = runSolana(B, 0n, 0n);
  assert.deepEqual(run.out.map((x) => [refKey(x.ref), x.value]), plan.notes.map((n) => [refKey(n.ref), n.value]));
  assert.equal(run.left, plan.left);
  assert.equal(run.left, B - plan.notes.reduce((a, n) => a + n.value, 0n));
  assert.ok(run.left < SOL_LADDER.min);
  // U is the frozen one-time id U_{scope, 0} as a Solana account
  const u = d.depositId(SEED, SCOPE, 0);
  u.secretKey.fill(0);
  assert.equal(run.u, base58.encode(u.publicKey));
});

test("the fee is carried by U: each note a rung, rungs + costs + what U keeps = what U got, and U never keeps less than an empty account's rent", () => {
  const cost = 1_010_000n, floor = 890_880n;
  for (const B of [10_000_000n, 11_000_000n, 11_500_000n, 31_000_000n, 87_654_321n, 1_234_567_890n]) {
    const run = runSolana(B, cost, floor);
    const sum = run.out.reduce((a, x) => a + x.value, 0n);
    assert.equal(sum + BigInt(run.out.length) * cost + run.left, B, `B=${B}`);
    for (const x of run.out) assert.deepEqual(ladderSplit(SOL_LADDER, x.value), { notes: [x.value], left: 0n });
    assert.ok(run.left === 0n || run.left >= floor || run.out.length === 0, `B=${B}: U keeps ${run.left}`);
    // nothing U keeps could carry one more rung with its cost and still end at 0 or the floor
    const after = run.left - RUNG - cost;
    assert.ok(after < 0n || (after > 0n && after < floor), `B=${B}: U keeps ${run.left}, enough for another rung`);
  }
  // 0.01 SOL + the cost exactly: one rung, U ends at 0
  assert.deepEqual(runSolana(RUNG + cost, cost, floor).out.map((x) => x.value), [RUNG]);
  // a rung that would leave U under an empty account's rent steps down to the next rung
  const B = 2n * RUNG + cost + floor - 1n;
  assert.deepEqual(runSolana(B, cost, floor).out.map((x) => x.value).slice(0, 1), [RUNG]);
});

test("a reload mid-way settles the open note and never deposits again at a new index", () => {
  const B = 80_000_000n; // 0.05 + 0.02 + 0.01
  const plan = poolDepositPlan(SEED, SCOPE, SOL_LADDER, U0, B);
  assert.deepEqual(plan.notes.map((n) => n.value), [50_000_000n, 20_000_000n, 10_000_000n]);
  const base = { program: PROGRAM, seed64: SEED, scope: SCOPE, ladder: SOL_LADDER, first: U0, cost: 0n, floor: 0n, sizes: SIZES, blockhash: BLOCKHASH };
  // U's deposit note landed; second arrival 0 was signed and written INCOMING, then the page reloaded before it landed
  const held = (s: NoteState): HeldNote[] => [{ ref: U0, state: "UNSPENT" }, { ref: U0n(0), state: s }];
  const pending = solanaSameChainDeposit({ ...base, held: held("INCOMING"), marked: (p) => p === P(U0), balance: 30_000_000n });
  assert.deepEqual([pending.kind, "ref" in pending ? refKey(pending.ref) : null], ["settle", refKey(U0n(0))]);
  assert.equal(pending.tx, undefined);
  // it landed while the page was closed: still settled first (its value is the send's), nothing new signed
  const landed = solanaSameChainDeposit({ ...base, held: held("INCOMING"), marked: (p) => p === P(U0) || p === P(U0n(0)), balance: 10_000_000n });
  assert.equal(landed.kind, "settle");
  // once settled, the next deposit is second arrival 1, the plan's last note, never another index
  const next = solanaSameChainDeposit({ ...base, held: held("UNSPENT"), marked: (p) => p === P(U0) || p === P(U0n(0)), balance: 10_000_000n });
  assert.equal(next.kind, "deposit");
  if (next.kind !== "deposit") return;
  assert.deepEqual([refKey(next.ref), next.value, next.precommitment], [refKey(plan.notes[2]!.ref), plan.notes[2]!.value, plan.notes[2]!.precommitment]);
  // the page closed between a note's mark and its store write (PLANNED, no send): its mark is claimed first, the next
  // deposit waits for that write
  const claim = solanaSameChainDeposit({ ...base, held: held("PLANNED"), marked: (p) => p === P(U0) || p === P(U0n(0)), balance: 10_000_000n });
  assert.deepEqual([claim.kind, "refs" in claim ? claim.refs.map(refKey) : null], ["claim", [refKey(U0n(0))]]);
  // a store that lost note 0 entirely: the chain names it, so it is claimed, never deposited past
  const lost = solanaSameChainDeposit({ ...base, held: [{ ref: U0, state: "UNSPENT" }], marked: (p) => p === P(U0) || p === P(U0n(0)), balance: 10_000_000n });
  assert.equal(lost.kind, "claim");
  // a chain read behind the store (one that misses a landed note) is refused, never planned at that note again
  assert.throws(() => solanaSameChainDeposit({ ...base, held: held("UNSPENT"), marked: (p) => p === P(U0), balance: 10_000_000n }), /at or past the chain's next note/);
});

test("the next note's precommitment is recomputed from the words, and a note of another chain is refused", () => {
  const args = { seed64: SEED, scope: SCOPE, ladder: SOL_LADDER, first: U0, held: [], balance: RUNG, cost: 0n, floor: 0n };
  assert.equal(sameChainNext({ ...args, next: { ref: U0, precommitment: P(U0) } }).kind, "deposit");
  assert.throws(() => sameChainNext({ ...args, next: { ref: U0, precommitment: P(U0) + 1n } }), /not this note's precommitment/);
  const other: NoteRef = { kind: "deposit", s: SCOPE, i: 1 };
  assert.throws(() => sameChainNext({ ...args, next: { ref: other, precommitment: P(other) } }), /not of U's chain/);
  assert.throws(() => sameChainNext({ ...args, first: { kind: "deposit", s: SCOPE + 1n, i: 0 }, next: { ref: U0, precommitment: P(U0) } }), /scope is its s/);
  assert.deepEqual(solanaChainNext(SEED, SCOPE, U0, () => false), { ref: U0, precommitment: P(U0) });
  // a scope that is not the program's pool's is refused before any key is derived
  assert.throws(() => solanaSameChainDeposit({ program: PROGRAM, seed64: SEED, scope: SCOPE + 1n, ladder: SOL_LADDER, first: { kind: "deposit", s: SCOPE + 1n, i: 0 }, held: [], marked: () => false, balance: RUNG, cost: 0n, floor: 0n, sizes: SIZES, blockhash: BLOCKHASH }), /not the program's pool's/);
  // below the smallest rung with its cost: U keeps it all
  assert.deepEqual(sameChainNext({ ...args, balance: RUNG - 1n, next: { ref: U0, precommitment: P(U0) } }), { kind: "keep", left: RUNG - 1n });
});

// ---- EVM: the pinned base-sepolia pool, its events planted ----
const POOL = "0xb239a38af69b68e6c5c305df64985f283b5d5fe5"; // the kit's base-sepolia pin (packages/kit/src/trade/evm/buy-unpinned.ts:313)
const PIN: EvmPoolPin = { network: "base-sepolia", pool: POOL, feeRecipient: "0x0000000000000000000000000000000000000001", fromBlock: 0n };
const SELECTOR = "0xe2bbb158"; // deposit(uint256,uint256)
const RECORDED = JSON.parse(readFileSync(new URL("./vectors/evm-pool-deposit.json", import.meta.url), "utf8")) as { answers: { rpc: string; to: string; value: string; input: string; status: string }[] };
const ESCOPE = evmPoolScopeOf(POOL, 84532n);
const E0: NoteRef = { kind: "deposit", s: ESCOPE, i: 0 };
const E0n = (n: number): NoteRef => ({ kind: "second", id: { id: "U", s: ESCOPE, i: 0 }, n });
const ERUNG = EVM_LADDER.min; // 0.001 ETH
function events(deps: readonly { pre: bigint; value: bigint; block?: bigint }[]): EvmPoolEvent[] {
  return deps.map((x, k) => {
    const label = vaultLabelOf(keccak_256, ESCOPE, BigInt(k + 1));
    return { block: x.block ?? BigInt(10 + k), blockHash: `0x${"ab".repeat(32)}`, logIndex: 0n, bytes: "", kind: "deposit", state: noteCommitment(x.value, label, x.pre), label, value: x.value, precommitment: x.pre, nullifier: null, recipient: null, token: null };
  }) as EvmPoolEvent[];
}
const word = (v: bigint) => v.toString(16).padStart(64, "0");

test("EVM: the deposit is picked through evmNextNote and built by the kit on the pinned pool; a reload settles the open note first", () => {
  const PE = noteSecrets(SEED, E0).precommitment, PE0 = noteSecrets(SEED, E0n(0)).precommitment, PE1 = noteSecrets(SEED, E0n(1)).precommitment;
  const base = { pin: PIN, seed64: SEED, scope: ESCOPE, ladder: EVM_LADDER, first: E0, cost: 0n };
  // nothing yet: U's deposit note, the largest rung of 0.0071 ETH (0.005), U keeps the rest for its next deposits
  const first = evmSameChainDeposit({ ...base, held: [], events: events([]), finalBlock: 100n, balance: 71n * 10n ** 14n });
  assert.equal(first.kind, "deposit");
  if (first.kind !== "deposit") return;
  assert.deepEqual([refKey(first.ref), first.value, first.left], [refKey(E0), 5n * ERUNG, 21n * 10n ** 14n]);
  assert.deepEqual(first.call, { to: POOL, value: 5n * ERUNG, data: SELECTOR + word(5n * ERUNG) + word(PE) });
  // reload: U's note landed and is held; second arrival 0 was sent (INCOMING) and sits in a block not final yet
  const ev = events([{ pre: PE, value: 5n * ERUNG }, { pre: PE0, value: 2n * ERUNG, block: 200n }]);
  const held: HeldNote[] = [{ ref: E0, state: "UNSPENT" }, { ref: E0n(0), state: "INCOMING" }];
  const open = evmSameChainDeposit({ ...base, held, events: ev, finalBlock: 100n, balance: 1n * 10n ** 14n + ERUNG });
  assert.deepEqual([open.kind, "ref" in open ? refKey(open.ref) : null, open.call], ["settle", refKey(E0n(0)), undefined]);
  // a store that never wrote it (another device's take, not final): wait, never sign second arrival 1 past it
  const wait = evmSameChainDeposit({ ...base, held: [{ ref: E0, state: "UNSPENT" }], events: ev, finalBlock: 100n, balance: ERUNG });
  assert.deepEqual([wait.kind, "refs" in wait ? wait.refs.map(refKey) : null], ["wait", [refKey(E0n(0))]]);
  // final but not in the store: claimed first (evmClaimTaken), then the deposit goes on second arrival 1
  const claim = evmSameChainDeposit({ ...base, held: [{ ref: E0, state: "UNSPENT" }], events: ev, finalBlock: 300n, balance: ERUNG });
  assert.deepEqual([claim.kind, "refs" in claim ? claim.refs.map(refKey) : null], ["claim", [refKey(E0n(0))]]);
  const next = evmSameChainDeposit({ ...base, held: [{ ref: E0, state: "UNSPENT" }, { ref: E0n(0), state: "UNSPENT" }], events: ev, finalBlock: 300n, balance: 1n * 10n ** 14n + ERUNG });
  assert.equal(next.kind, "deposit");
  if (next.kind !== "deposit") return;
  assert.deepEqual([refKey(next.ref), next.value, next.left, next.call?.data], [refKey(E0n(1)), ERUNG, 10n ** 14n, SELECTOR + word(ERUNG) + word(PE1)]);
});

test("EVM: the call has the shape of the deposit pool-evm-testnet-run landed on the pinned pool (both RPCs, status 1)", () => {
  const [a, b] = RECORDED.answers;
  assert.notEqual(a!.rpc, b!.rpc);
  assert.deepEqual([a!.status, b!.status], ["0x1", "0x1"]);
  assert.deepEqual([a!.to, a!.value, a!.input], [b!.to, b!.value, b!.input]);
  // its value word is its msg.value, and its precommitment a field element: the same call the device builds for its own
  assert.equal(a!.input.length, 2 + 8 + 128);
  assert.ok(a!.input.startsWith(SELECTOR));
  assert.equal(BigInt("0x" + a!.input.slice(10, 74)), BigInt(a!.value));
  const value = BigInt(a!.value);
  assert.deepEqual(ladderSplit(EVM_LADDER, value).left, 0n);
  const got = evmSameChainDeposit({ pin: PIN, seed64: SEED, scope: ESCOPE, ladder: EVM_LADDER, first: E0, held: [], events: events([]), finalBlock: 1n, balance: 5n * ERUNG, cost: 0n });
  assert.equal(got.kind, "deposit");
  assert.equal(got.call?.to.toLowerCase(), a!.to.toLowerCase());
  assert.equal(got.call?.data.length, a!.input.length);
  assert.equal(got.call?.data.slice(0, 10), a!.input.slice(0, 10));
  // a scope that is not the pinned pool's is refused before any pick
  assert.throws(() => evmSameChainDeposit({ pin: PIN, seed64: SEED, scope: SCOPE, ladder: EVM_LADDER, first: { kind: "deposit", s: SCOPE, i: 0 }, held: [], events: [], finalBlock: 1n, balance: ERUNG, cost: 0n }), /not the pinned pool's/);
});
