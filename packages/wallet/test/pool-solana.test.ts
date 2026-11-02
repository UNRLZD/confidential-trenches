// node --test packages/wallet/test/pool-solana.test.ts: the Solana pool as a pool of the proof queue (card
// notes-per-pool-sol, src/pool/solana.ts). The RPC answers are the pool's own accounts as the program writes them: the
// deposits, roots, times and releases of contracts/pool-solana/fixtures/{release,boundary}-spends.json, which the
// LiteSVM tests (contracts/pool-solana/svm-tests/tests/release.rs with_deposits, inserts_cross_the_page_boundary_in_both_trees)
// land and assert page by page: commitment, root and time per entry. Test notes only, never money; no key.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, base64 } from "@scure/base";
import { VaultTree, vaultLabelOf, type SolanaRpc } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets } from "../src/notes/secrets.ts";
import { solanaMarkOf, solanaMarks, solanaRestore, type SolanaDepositRow } from "../src/pool/solana-restore.ts";
import { refKey } from "../src/notes/store.ts";
import { checkPool } from "../src/pool/pool.ts";
import {
  SOL_LADDER, SOL_LIFE_MS, SOL_TIP_CAP, solanaContextOf, solanaFeeBound, solanaPageOf, solanaPool, solanaPoolOf, type SolanaFeeAnswer,
} from "../src/pool/solana.ts";

type Spend = { name: string; note: number; new_commitment: string; withdrawn: string; state_root_index: number; label_root_index: number; salt: string; public_signals: string[] };
const fx = (f: string) => JSON.parse(readFileSync(new URL(`../../../contracts/pool-solana/fixtures/${f}`, import.meta.url), "utf8"));
const R = fx("release-spends.json") as { program: string; pool: string; w: string; fee_payer: string; scope: string; relay_fee_cap: string; tip_cap: string; deadline_ms: string; deposits: { value: string; precommitment: string; label: string; commitment: string }[]; state_roots: string[]; label_roots: string[]; spends: Spend[] };
const B = fx("boundary-spends.json") as { deposits: { value: string; precommitment: string }[]; state_roots: Record<string, string>; label_roots: Record<string, string>; spends: Spend[] };

const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const big = (s: string): bigint => BigInt(`0x${s}`);
const b58 = (h: string): string => base58.encode(unhex(h));
const PROGRAM = b58(R.program);
const POOL = b58(R.pool);
const W = b58(R.w);
const FEE_PAYER = b58(R.fee_payer);
const SCOPE = big(R.scope);
/** The LiteSVM tests' deposit clock: deposit i lands at 1,800,000,000 + 13 i seconds (release.rs deposit_time). */
const T = (i: number): bigint => 1_800_000_000n + 13n * BigInt(i);

type Entry = { leaf: bigint; root: bigint; t: bigint };
/** One tree's entries, its roots taken one insert at a time as the program's insert does. */
function entries(leaves: readonly { leaf: bigint; t: bigint }[]): Entry[] {
  const tree = new VaultTree();
  return leaves.map(({ leaf, t }) => (tree.append([leaf]), { leaf, root: tree.root!, t }));
}
const be32 = (x: bigint): Uint8Array => unhex(x.toString(16).padStart(64, "0"));
/** The page accounts of one tree, byte for byte as src/state.rs writes them. */
function pages(tree: 0 | 1, es: readonly Entry[], edit: (b: Uint8Array, i: number) => void = () => {}): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (let p = 0; p * 1024 < es.length; p++) {
    const part = es.slice(p * 1024, (p + 1) * 1024);
    const d = new Uint8Array(16 + 72 * part.length);
    d.set(new TextEncoder().encode("bfpage01"), 0);
    d[8] = tree;
    new DataView(d.buffer).setUint32(9, p, true);
    part.forEach((e, k) => {
      const at = 16 + 72 * k;
      d.set(be32(e.leaf), at);
      d.set(be32(e.root), at + 32);
      new DataView(d.buffer).setBigInt64(at + 64, e.t, true);
      edit(d.subarray(at, at + 72), p * 1024 + k);
    });
    out.set(solanaPageOf(PROGRAM, tree, p), d);
  }
  return out;
}

type Chain = { accounts: Map<string, Uint8Array>; slot: number; time: (slot: number) => bigint };
type Over = { rent0?: number; rent72?: number; fee?: number; url?: string };
/** One RPC answering the reads solana.ts makes, from a chain's accounts at its finalized slot. */
function rpc(c: Chain, o: Over = {}, log: string[] = []): SolanaRpc {
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    log.push(method);
    const ctx = { slot: c.slot };
    switch (method) {
      case "getSlot": return c.slot;
      case "getBlockTime": return Number(c.time(params[0] as number));
      case "getMultipleAccounts":
        return { context: ctx, value: (params[0] as string[]).map((a) => (c.accounts.has(a) ? { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(c.accounts.get(a)!), "base64"] } : null)) };
      case "getMinimumBalanceForRentExemption": {
        const n = params[0] as number;
        return n === 0 ? (o.rent0 ?? 890_880) : n === 72 ? (o.rent72 ?? 1_392_000) : (128 + n) * 6_960;
      }
      case "getLatestBlockhash": return { context: ctx, value: { blockhash: base58.encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 1 } };
      case "getFeeForMessage": return { context: ctx, value: o.fee ?? 10_000 };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return o.url === undefined ? f : Object.assign(f, { url: o.url });
}
// mainnet rent (release.rs row 8, read 2 Nov 2026): 650,240 for 0 bytes, 5,080 a byte
const MAINNET: Over = { rent0: 650_240, rent72: 650_240 + 72 * 5_080 };

// release-spends.json's pool after its six deposits, then the 'release' spend's change note at 1,800,000,100 s
const REL_DEP = R.deposits.map((d, i) => ({ leaf: big(d.commitment), t: T(i) }));
const REL_LABELS = entries(R.deposits.map((d, i) => ({ leaf: big(d.label), t: T(i) })));
const REL_RELEASE_T = 1_800_000_100n;
const REL_STATE = entries([...REL_DEP, { leaf: big(R.spends[0]!.new_commitment), t: REL_RELEASE_T }]);
const relChain = (slot = 500, edit?: (b: Uint8Array, i: number) => void): Chain => ({
  accounts: new Map([...pages(0, REL_STATE, edit), ...pages(1, REL_LABELS)]),
  slot,
  time: () => REL_RELEASE_T + 60n,
});
const pair = (a: Chain, b: Chain, oa: Over = MAINNET, ob: Over = MAINNET): [SolanaRpc, SolanaRpc] => [rpc(a, { ...oa, url: "https://a.example" }), rpc(b, { ...ob, url: "https://b.example" })];

const feeAnswer = (epochStartMs: bigint, fee = "1100000", over: Partial<SolanaFeeAnswer> = {}): SolanaFeeAnswer => ({
  chain: "solana", program: PROGRAM, pool: POOL, fee_payer: FEE_PAYER, epoch_ms: 60_000, epoch_start_ms: Number(epochStartMs), fee, step: "100000", ...over,
});
const poolWith = (rpcs: [SolanaRpc, SolanaRpc], fee: (e: bigint) => SolanaFeeAnswer = (e) => feeAnswer(e)) =>
  solanaPool({ program: PROGRAM, rpcs, feePayer: FEE_PAYER, relayFee: async (e) => fee(e), salt: () => unhex(R.spends[0]!.salt) });

test("the pool's address and scope are the program's (deposit.rs init, context.rs scope_of)", () => {
  assert.deepEqual(solanaPoolOf(PROGRAM), { pool: POOL, scope: SCOPE });
  checkPool(poolWith(pair(relChain(), relChain())));
});

test("the context of each landed release equals the program's: its proof's 8th signal", () => {
  for (const s of R.spends.filter((s) => s.name !== "other_pool")) {
    const req = { program: PROGRAM, pool: POOL, recipient: W, feePayer: FEE_PAYER, relayFee: 0n, relayFeeCap: BigInt(R.relay_fee_cap), tipCap: BigInt(R.tip_cap), deadlineMs: BigInt(R.deadline_ms), salt: s.salt };
    assert.equal(solanaContextOf(req, SCOPE).toString(), s.public_signals[7], s.name);
  }
});

test("trees: the roots at each cut are the program's, and the proofs' roots", async () => {
  const p = poolWith(pair(relChain(), relChain()));
  // every deposit in: the root after deposit 5, which the 'release' spend proved against (state_root_index 5)
  const all = await p.trees(T(5) * 1000n + 1n);
  assert.equal(all.stateRoot, big(R.state_roots[5]!));
  assert.equal(all.labelRoot, big(R.label_roots[5]!));
  assert.equal(all.stateRoot.toString(), R.spends[0]!.public_signals[3]);
  assert.equal(all.stateTree.size, 6);
  // a cut at deposit 4's time keeps deposits 0-3: the root the 'old_root' spend proved against (index 3)
  const old = await p.trees(T(4) * 1000n);
  assert.equal(old.stateRoot, big(R.state_roots[3]!));
  assert.equal(old.labelRoot, big(R.label_roots[3]!));
  assert.equal(old.stateRoot.toString(), R.spends.find((s) => s.name === "old_root")!.public_signals[3]);
  // past the release: its change note is in, the label tree is not grown
  const after = await p.trees((REL_RELEASE_T + 1n) * 1000n);
  assert.equal(after.stateTree.size, 7);
  assert.equal(after.labelRoot, big(R.label_roots[5]!));
});

test("trees across a page boundary: roots 1,023, 1,024 and 1,025 are the program's", async () => {
  const labels = B.deposits.map((_, i) => vaultLabelOf(keccak_256, SCOPE, BigInt(i + 1)));
  const commit = (i: number) => noteCommitment(BigInt(B.deposits[i]!.value), labels[i]!, big(B.deposits[i]!.precommitment));
  // the LiteSVM order: 1,024 deposits, the boundary release's change note, then deposit 1,024
  const state = entries([
    ...B.deposits.slice(0, 1024).map((_, i) => ({ leaf: commit(i), t: 1_800_000_000n + BigInt(i) })),
    { leaf: big(B.spends[0]!.new_commitment), t: 1_800_002_000n },
    { leaf: commit(1024), t: 1_800_002_001n },
  ]);
  const label = entries(labels.map((leaf, i) => ({ leaf, t: i < 1024 ? 1_800_000_000n + BigInt(i) : 1_800_002_001n })));
  for (const k of ["1023", "1024", "1025"]) assert.equal(state[Number(k)]!.root, big(B.state_roots[k]!), `state root ${k}`);
  for (const k of ["1023", "1024"]) assert.equal(label[Number(k)]!.root, big(B.label_roots[k]!), `label root ${k}`);
  const chain: Chain = { accounts: new Map([...pages(0, state), ...pages(1, label)]), slot: 900, time: () => 1_800_003_000n };
  const t = await poolWith(pair(chain, chain)).trees(1_800_002_002_000n);
  assert.equal(t.stateRoot, big(B.state_roots["1025"]!));
  assert.equal(t.labelRoot, big(B.label_roots["1024"]!));
  const cut = await poolWith(pair(chain, chain)).trees(1_800_002_000_000n);
  assert.equal(cut.stateRoot, big(B.state_roots["1023"]!));
});

test("trees refuses an RPC that has not reached the cut, two RPCs that differ, and a page root not the leaves'", async () => {
  const before = T(5) * 1000n + 1n;
  // RPC b's finalized block is at T(5) - 1 s: deposit 5 could still land under the cut
  const lag: Chain = { ...relChain(), time: () => T(5) - 1n };
  await assert.rejects(poolWith(pair(relChain(), lag)).trees(before), /rpc 1: .* has not reached/);
  await assert.rejects(poolWith(pair(lag, relChain())).trees(before), /rpc 0: .* has not reached/);
  // one byte of one leaf differs on RPC b
  const off = relChain(500, (e, i) => { if (i === 2) e[31] ^= 1; });
  await assert.rejects(poolWith(pair(relChain(), off)).trees(before), /tree 0: the two RPCs differ/);
  // both RPCs serve the same forged root at the cut
  const forged = relChain(500, (e, i) => { if (i === 5) e[63] ^= 1; });
  await assert.rejects(poolWith(pair(forged, forged)).trees(before), /not the page's root/);
  // a time that goes back
  const back = relChain(500, (e, i) => { if (i === 3) new DataView(e.buffer, e.byteOffset).setBigInt64(64, T(1), true); });
  await assert.rejects(poolWith(pair(back, back)).trees(before), /a time goes back/);
  // a cut before the first leaf has no root to prove against
  await assert.rejects(poolWith(pair(relChain(), relChain())).trees(T(0) * 1000n), /no leaf before/);
});

test("now is the lower of the two RPCs' finalized block times", async () => {
  const a: Chain = { ...relChain(), time: () => 1_800_000_500n };
  const b: Chain = { ...relChain(), time: () => 1_800_000_499n };
  assert.equal(await poolWith(pair(a, b)).now(), 1_800_000_499_000n);
  assert.equal(await poolWith(pair(b, a)).now(), 1_800_000_499_000n);
});

const CHUNK = 10_000_000n;
const nowChain = (o: Partial<Chain> = {}): Chain => ({ ...relChain(), time: () => 1_800_000_130n, ...o });
const EPOCH = 1_800_000_120_000n;
const args = (over: { deadlineMs?: bigint } = {}) => ({ chunk: CHUNK, wallet: { address: W, publicKey: unhex(R.w) }, refundPrecommitment: 1n, epochStartMs: EPOCH, deadlineMs: EPOCH + SOL_LIFE_MS, ...over });

test("bind: the program's context over W, the pinned fee payer, the epoch fee as the cap, the tip cap and the grid deadline", async () => {
  const b = await poolWith(pair(nowChain(), nowChain())).bind(args());
  assert.deepEqual(b.request, { program: PROGRAM, pool: POOL, recipient: W, feePayer: FEE_PAYER, relayFee: 1_100_000n, relayFeeCap: 1_100_000n, tipCap: SOL_TIP_CAP, deadlineMs: EPOCH + SOL_LIFE_MS, salt: R.spends[0]!.salt });
  assert.equal(b.feeCap, 1_100_000n);
  assert.equal(b.context, solanaContextOf(b.request, SCOPE));
  // the same fields the fixture's landed release carries give the program's context through the same function
  assert.equal(solanaContextOf({ ...b.request, relayFeeCap: BigInt(R.relay_fee_cap), deadlineMs: BigInt(R.deadline_ms) }, SCOPE).toString(), R.spends[0]!.public_signals[7]);
  // a W that is not its public key's base58, and a deadline off the grid
  await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind({ ...args(), wallet: { address: FEE_PAYER, publicKey: unhex(R.w) } }), /base58 of its ed25519 public key/);
  await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind(args({ deadlineMs: EPOCH + SOL_LIFE_MS + 1n })), /deadlineMs/);
});

test("the fee bound: the device's own figures from rent and base fee read on two RPCs, 1,300,000 at mainnet rent", async () => {
  assert.deepEqual(solanaFeeBound({ rent0: 650_240n, rent72: 650_240n + 365_760n, baseFee: 10_000n }), { cost: 1_026_000n, bound: 1_300_000n });
  const ok = await poolWith(pair(nowChain(), nowChain()), (e) => feeAnswer(e, "1300000")).bind(args());
  assert.equal(ok.feeCap, 1_300_000n);
  // over the bound, below the cost, off the step
  await assert.rejects(poolWith(pair(nowChain(), nowChain()), (e) => feeAnswer(e, "1400000")).bind(args()), /above the device's bound 1300000/);
  await assert.rejects(poolWith(pair(nowChain(), nowChain()), (e) => feeAnswer(e, "1000000")).bind(args()), /below a release's cost 1026000/);
  await assert.rejects(poolWith(pair(nowChain(), nowChain()), (e) => feeAnswer(e, "1150000")).bind(args()), /off the 100,000-lamport step/);
  // a helper naming another fee payer, another pool, or another epoch
  await assert.rejects(poolWith(pair(nowChain(), nowChain()), (e) => feeAnswer(e, "1100000", { fee_payer: W })).bind(args()), /not this pool's/);
  await assert.rejects(poolWith(pair(nowChain(), nowChain()), (e) => feeAnswer(e, "1100000", { pool: W })).bind(args()), /not this pool's/);
  await assert.rejects(poolWith(pair(nowChain(), nowChain()), (e) => feeAnswer(e + 60_000n)).bind(args()), /not this epoch's/);
  // the two RPCs disagree on rent or the base fee: no bound, no bind
  await assert.rejects(poolWith(pair(nowChain(), nowChain(), MAINNET, { ...MAINNET, rent72: 650_240 + 72 * 6_000 })).bind(args()), /rent or base fee differ/);
  await assert.rejects(poolWith(pair(nowChain(), nowChain(), MAINNET, { ...MAINNET, fee: 20_000 })).bind(args()), /rent or base fee differ/);
  // a higher rent on both raises the device's own bound: the fee follows what the chain charges, not the helper
  // (7,000 a byte: cost 896,000 + 504,000 + 10,000 = 1,410,000, bound 1,500,000 + 200,000)
  const dear = { rent0: 128 * 7_000, rent72: 200 * 7_000, fee: 10_000 };
  const up = await poolWith(pair(nowChain(), nowChain(), dear, dear), (e) => feeAnswer(e, "1700000")).bind(args());
  assert.equal(up.feeCap, 1_700_000n);
  await assert.rejects(poolWith(pair(nowChain(), nowChain(), dear, dear), (e) => feeAnswer(e, "1800000")).bind(args()), /above the device's bound 1700000/);
});

test("bind refuses a chunk the program would refuse at the fee: the backstop, and W left under rent(0)", async () => {
  await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind({ ...args(), chunk: 2_100_000n }), /backstop/);
  await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind({ ...args(), chunk: 2_700_000n }), /under rent\(0\)/);
});

// Restore from the words alone: the all-zero test seed's notes in the fixture pool (test values, never money).

test("restore from the words alone: every note, each spent note's W, from whole-set reads only", async () => {
  const seed = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
  const P = (ref: Parameters<typeof noteSecrets>[1]) => noteSecrets(seed, ref).precommitment;
  const leaves: bigint[] = [];
  const labels: bigint[] = [];
  const rows: SolanaDepositRow[] = [];
  const marks = new Set<string>();
  // another user's deposit first, then ours: deposit notes 0 and 9 (lanes 0 and 1), U_{s,0}'s second arrival 0
  const deposit = (precommitment: bigint, value: bigint): bigint => {
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(labels.length + 1));
    labels.push(label);
    rows.push({ precommitment, value, label, leafIndex: BigInt(leaves.length) });
    leaves.push(noteCommitment(value, label, precommitment));
    marks.add(solanaMarkOf(PROGRAM, "pre", precommitment));
    return label;
  };
  deposit(big(R.deposits[0]!.precommitment), 20_000_000n);
  const l0 = deposit(P({ kind: "deposit", s: SCOPE, i: 0 }), 50_000_000n);
  deposit(P({ kind: "deposit", s: SCOPE, i: 9 }), 10_000_000n);
  deposit(P({ kind: "second", id: { id: "U", s: SCOPE, i: 0 }, n: 0 }), 20_000_000n);
  // deposit 0 is released whole: its spent mark, its change note of 0 into the state tree
  marks.add(solanaMarkOf(PROGRAM, "spent", noteSecrets(seed, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash));
  leaves.push(noteCommitment(0n, l0, P({ kind: "change", l: l0, j: 0 })));
  // the sell's proceeds came back to the pool as W_{sol, l0, 0}'s return note
  deposit(P({ kind: "return", c: "sol", l: l0, j: 0 }), 5_000_000n);
  // someone else's spent mark
  marks.add(solanaMarkOf(PROGRAM, "spent", 12345n));

  const gpa = (set: Set<string>): SolanaRpc => async (m, p) => {
    assert.equal(m, "getProgramAccounts");
    assert.deepEqual((p[1] as { filters: unknown }).filters, [{ dataSize: 0 }]); // the whole set, never one note's address
    return [...set].map((pubkey) => ({ pubkey, account: { owner: PROGRAM, lamports: 890_880, data: ["", "base64"], executable: false } }));
  };
  const got = await solanaMarks([gpa(marks), gpa(marks)], PROGRAM);
  const r = solanaRestore({ seed64: seed, program: PROGRAM, scope: SCOPE, ladder: SOL_LADDER, stateLeaves: leaves, labelLeaves: labels, marks: got, deposits: rows, gap: 4 });
  const keys = r.notes.map((n) => `${refKey(n.ref)}:${n.state}`).sort();
  assert.equal(keys.length, 5);
  assert.deepEqual(r.notes.filter((n) => n.state === "SPENT").map((n) => n.ref.kind), ["deposit"]);
  assert.ok(r.notes.some((n) => n.ref.kind === "return" && n.leaf.value === 5_000_000n));
  assert.ok(r.notes.some((n) => n.ref.kind === "change" && n.leaf.value === 0n && n.leaf.leafIndex === 4n));
  assert.ok(r.notes.some((n) => n.ref.kind === "deposit" && n.ref.i === 9));
  assert.ok(r.notes.some((n) => n.ref.kind === "second"));
  assert.deepEqual(r.spends.map((s) => [s.l, s.j, s.withdrawn, s.w]), [[l0, 0, 50_000_000n, d.freshWallet(seed, "sol", l0, 0).address]]);

  // hostile inputs: two RPCs whose mark sets differ; a row moved off its leaf; a row with no precommitment mark
  await assert.rejects(solanaMarks([gpa(marks), gpa(new Set([...marks].slice(1)))], PROGRAM), /marks differ/);
  const moved = rows.map((x, i) => (i === 2 ? { ...x, leafIndex: 0n } : x));
  assert.throws(() => solanaRestore({ seed64: seed, program: PROGRAM, scope: SCOPE, ladder: SOL_LADDER, stateLeaves: leaves, labelLeaves: labels, marks: got, deposits: moved, gap: 4 }), /not the state tree's leaf/);
  const noMark = new Set([...got].filter((m) => m !== solanaMarkOf(PROGRAM, "pre", rows[2]!.precommitment)));
  assert.throws(() => solanaRestore({ seed64: seed, program: PROGRAM, scope: SCOPE, ladder: SOL_LADDER, stateLeaves: leaves, labelLeaves: labels, marks: noMark, deposits: rows, gap: 4 }), /no precommitment mark/);
});
