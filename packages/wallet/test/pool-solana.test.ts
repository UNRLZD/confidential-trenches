// node --test packages/wallet/test/pool-solana.test.ts: the Solana pool as a pool of the proof queue (card
// notes-per-pool-sol, src/pool/solana.ts). The RPC answers are the pool's own accounts as the program writes them: the
// deposits, roots, times and releases of contracts/pool-solana/fixtures/{release,boundary}-spends.json, which the
// LiteSVM tests (contracts/pool-solana/svm-tests/tests/release.rs with_deposits, inserts_cross_the_page_boundary_in_both_trees)
// land and assert page by page: commitment, root and time per entry. Test notes only, never money; no key.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, base64 } from "@scure/base";
import { VaultTree, vaultLabelOf, type SolanaRpc } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets } from "../src/notes/secrets.ts";
import { SOL_RESTORE_LONE_ROUNDS, SOL_RESTORE_QUIET_ROUNDS, SOL_RESTORE_ROUNDS, solanaMarkOf, solanaMarks, solanaMarksUnion, solanaRestore, solanaRestoreNotes, solanaSettleSpent } from "../src/pool/solana-restore.ts";
import { IDBFactory } from "fake-indexeddb";
import { openNoteStore, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore } from "../src/store/index.ts";
import { refKey } from "../src/notes/store.ts";
import { checkPool } from "../src/pool/pool.ts";
import {
  SOL_LAG_TRIES, SOL_LAG_WAIT_MS, SOL_LIFE_MS, type SolanaLagWait, solanaLagRetry, SOL_TIP_CAP, solanaContextOf, solanaEpochFee, solanaNow, solanaPageOf, solanaPool, solanaPoolOf, solanaTreeSync, type SolanaFeeAnswer,
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
/** The fixture's pin: its program and fee payer, as SOL_POOLS holds a cluster's. */
const PIN = { program: PROGRAM, feePayer: FEE_PAYER };
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

type Chain = { accounts: Map<string, Uint8Array>; slot: number; time: (slot: number) => bigint; marks?: Map<string, Uint8Array> };
type Over = { perByte?: number; factor?: number; fee?: number; url?: string };
/** One RPC answering the reads solana.ts makes, from a chain's accounts at its finalized slot. */
function rpc(c: Chain, o: Over = {}, log: string[] = []): SolanaRpc {
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    log.push(method);
    const ctx = { slot: c.slot };
    switch (method) {
      case "getSlot": return c.slot;
      case "getBlockTime": return Number(c.time(params[0] as number));
      case "getAccountInfo": {
        assert.equal(params[0], "SysvarRent111111111111111111111111111111111");
        const d = new Uint8Array(17);
        new DataView(d.buffer).setBigUint64(0, BigInt(o.perByte ?? 5_080), true);
        new DataView(d.buffer).setFloat64(8, o.factor ?? 1, true);
        return { context: ctx, value: { owner: "Sysvar1111111111111111111111111111111111111", lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(d), "base64"] } };
      }
      case "getMultipleAccounts": {
        // an RPC whose slot is below minContextSlot refuses, as the RPC's own -32016 does
        const min = (params[1] as { minContextSlot?: number }).minContextSlot;
        if (min !== undefined && c.slot < min) throw new Error(`Minimum context slot has not been reached: ${c.slot} < ${min}`);
        return { context: ctx, value: (params[0] as string[]).map((a) => (c.accounts.has(a) ? { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(c.accounts.get(a)!), "base64"] } : null)) };
      }
      case "getLatestBlockhash": return { context: ctx, value: { blockhash: base58.encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 1 } };
      case "getFeeForMessage": return { context: ctx, value: o.fee ?? 10_000 };
      case "getProgramAccounts": {
        assert.equal(params[0], PROGRAM);
        const size = (params[1] as { filters: { dataSize: number }[] }).filters[0]!.dataSize;
        assert.deepEqual((params[1] as { filters: unknown }).filters, [{ dataSize: size }]); // the whole set, never a note's address
        assert.equal((params[1] as { withContext?: boolean }).withContext, true);
        const min = (params[1] as { minContextSlot?: number }).minContextSlot;
        if (min !== undefined && c.slot < min) throw new Error(`Minimum context slot has not been reached: ${c.slot} < ${min}`);
        return { context: ctx, value: [...(c.marks ?? new Map())].filter(([, d]) => d.length === size).map(([pubkey, d]) => ({ pubkey, account: { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(d), "base64"] } })) };
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return o.url === undefined ? f : Object.assign(f, { url: o.url });
}
// mainnet rent (the Rent sysvar read 2 Nov 2026): 5,080 a byte, factor 1
const MAINNET: Over = { perByte: 5_080, factor: 1 };

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

const feeAnswer = (epochStartMs: bigint, fee = "1300000", over: Partial<SolanaFeeAnswer> = {}): SolanaFeeAnswer => ({
  chain: "solana", program: PROGRAM, pool: POOL, fee_payer: FEE_PAYER, epoch_ms: 60_000, epoch_start_ms: Number(epochStartMs), fee, step: "100000", ...over,
});
const poolWith = (rpcs: [SolanaRpc, SolanaRpc], fee: (e: bigint) => SolanaFeeAnswer = (e) => feeAnswer(e)) =>
  solanaPool({ pin: PIN, rpcs, relayFee: async (e) => fee(e), salt: () => unhex(R.spends[0]!.salt) });

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
  // RPC b claims a block past the cut but lacks deposit 5, which landed under it
  const short: Chain = { ...relChain(), accounts: new Map([...pages(0, REL_STATE.slice(0, 5)), ...pages(1, REL_LABELS)]) };
  await assert.rejects(poolWith(pair(relChain(), short)).trees(before), /tree 0: the two RPCs differ below the cut/);
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
  assert.deepEqual(b.request, { program: PROGRAM, pool: POOL, recipient: W, feePayer: FEE_PAYER, relayFee: 1_300_000n, relayFeeCap: 1_300_000n, tipCap: SOL_TIP_CAP, deadlineMs: EPOCH + SOL_LIFE_MS, salt: R.spends[0]!.salt });
  assert.equal(b.feeCap, 1_300_000n);
  assert.equal(b.context, solanaContextOf(b.request, SCOPE));
  // the same fields the fixture's landed release carries give the program's context through the same function
  assert.equal(solanaContextOf({ ...b.request, relayFeeCap: BigInt(R.relay_fee_cap), deadlineMs: BigInt(R.deadline_ms) }, SCOPE).toString(), R.spends[0]!.public_signals[7]);
  // a W that is not its public key's base58, and a deadline off the grid
  await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind({ ...args(), wallet: { address: FEE_PAYER, publicKey: unhex(R.w) } }), /base58 of its ed25519 public key/);
  await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind(args({ deadlineMs: EPOCH + SOL_LIFE_MS + 1n })), /deadlineMs/);
});

test("the epoch fee is the device's own: the kit's cost rounded up to the step plus two steps, 1,300,000 at mainnet rent; any other helper answer is refused", async () => {
  assert.deepEqual(solanaEpochFee({ lamportsPerByte: 5_080n, factor: 1n }), { cost: 1_066_640n, fee: 1_300_000n }); // M355 (3)
  assert.equal(SOL_LIFE_MS, 240_000n, "L = 2E + the kit's 90 s send margin + 30 s (M356 (1))");
  const ok = await poolWith(pair(nowChain(), nowChain())).bind(args());
  assert.equal(ok.feeCap, 1_300_000n);
  // RV8 inverted: the helper cannot pick a fee per request; one under, one over, off the step, not a number
  for (const fee of ["1100000", "1200000", "1400000", "1300001", "1.3e6", " 1300000"])
    await assert.rejects(poolWith(pair(nowChain(), nowChain()), (e) => feeAnswer(e, fee)).bind(args()), /is not the epoch's fee 1300000/, fee);
  // a helper naming another fee payer, program, pool, chain, epoch, epoch length or step
  for (const over of [{ fee_payer: W }, { program: W }, { pool: W }, { chain: "evm" }] as Partial<SolanaFeeAnswer>[])
    await assert.rejects(poolWith(pair(nowChain(), nowChain()), (e) => feeAnswer(e, "1300000", over)).bind(args()), /not this pool's/, JSON.stringify(over));
  for (const over of [{ epoch_ms: 30_000 }, { step: "10000" }] as Partial<SolanaFeeAnswer>[])
    await assert.rejects(poolWith(pair(nowChain(), nowChain()), (e) => feeAnswer(e, "1300000", over)).bind(args()), /not this epoch's, or not on the step/, JSON.stringify(over));
  await assert.rejects(poolWith(pair(nowChain(), nowChain()), (e) => feeAnswer(e + 60_000n)).bind(args()), /not this epoch's/);
  // the two RPCs disagree on rent or on the base fee; a base fee that is not two signatures at 5,000
  await assert.rejects(poolWith(pair(nowChain(), nowChain(), MAINNET, { ...MAINNET, perByte: 6_000 })).bind(args()), /disagree on rent/);
  await assert.rejects(poolWith(pair(nowChain(), nowChain(), MAINNET, { ...MAINNET, fee: 20_000 })).bind(args()), /base fee differ/);
  await assert.rejects(poolWith(pair(nowChain(), nowChain(), { ...MAINNET, fee: 15_000 }, { ...MAINNET, fee: 15_000 })).bind(args()), /not the 10000 the release cost counts/);
  // a higher rent on both raises the device's own fee: (136 + 72) x 7,000 + 10,000 = 1,466,000, fee 1,700,000
  const dear = { perByte: 7_000, factor: 1, fee: 10_000 };
  assert.equal((await poolWith(pair(nowChain(), nowChain(), dear, dear), (e) => feeAnswer(e, "1700000")).bind(args())).feeCap, 1_700_000n);
  await assert.rejects(poolWith(pair(nowChain(), nowChain(), dear, dear)).bind(args()), /is not the epoch's fee 1700000/);
});

test("RV1 inverted: no read names W; the base fee is read once per epoch from the pool and the fee payer's fixed message", async () => {
  const seen: [string, unknown[]][] = [];
  const spy = (r: SolanaRpc): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => (seen.push([m, [...p]]), r(m, p)), { url: r.url });
  const [a, b] = pair(nowChain(), nowChain());
  const p = poolWith([spy(a), spy(b)]);
  await p.bind(args());
  const W2 = "09".repeat(32); // a second W, any key
  await p.bind({ ...args(), wallet: { address: b58(W2), publicKey: unhex(W2) } });
  const has = (hay: Uint8Array, needle: Uint8Array): boolean => { for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((x, k) => hay[i + k] === x)) return true; return false; };
  for (const w of [R.w, W2]) {
    const leaks = seen.filter(([m, ps]) => JSON.stringify(ps, (_, v) => (typeof v === "bigint" ? v.toString() : v)).includes(b58(w)) || (m === "getFeeForMessage" && has(base64.decode(ps[0] as string), unhex(w))));
    assert.deepEqual(leaks.map((x) => x[0]), [], "a read names W");
  }
  const fees = seen.filter(([m]) => m === "getFeeForMessage");
  assert.equal(fees.length, 2, "one base fee read per RPC for the epoch, not one per bind");
  const msg = base64.decode(fees[0]![1][0] as string);
  assert.ok(has(msg, unhex(R.fee_payer)) && has(msg, unhex(R.pool)), "its two signers are the fee payer and the pool");
  // the next epoch reads it again
  await p.bind({ ...args(), epochStartMs: EPOCH + 60_000n, deadlineMs: EPOCH + 60_000n + SOL_LIFE_MS });
  assert.equal(seen.filter(([m]) => m === "getFeeForMessage").length, 4);
});

test("bind refuses a deadline too close to send, an epoch off the grid, and W that is the pool or the fee payer", async () => {
  // now is 1,800,000,130 s: an epoch whose deadline is within the send margin of it
  const e = 1_799_999_940_000n; // deadline 1,800,000,120,000, within 30 s of now 1,800,000,130,000 + 30,000
  await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind({ ...args(), epochStartMs: e, deadlineMs: e + SOL_LIFE_MS }), /too close to send/);
  await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind({ ...args(), epochStartMs: EPOCH + 1n, deadlineMs: EPOCH + 1n + SOL_LIFE_MS }), /epochStartMs: not on the epoch grid/);
  await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind({ ...args(), wallet: { address: FEE_PAYER, publicKey: unhex(R.fee_payer) } }), /W is the pool or the fee payer/);
});

test("RV10: two RPCs that are one provider are refused at every entry: the pool, the sync, now and the marks", async () => {
  const r = rpc(relChain(), MAINNET);
  const a = rpc(relChain(), { ...MAINNET, url: "https://rpc.example" });
  const b = rpc(relChain(), { ...MAINNET, url: "https://RPC.example/" });
  for (const rs of [[r, r], [a, b]] as [SolanaRpc, SolanaRpc][]) {
    assert.throws(() => solanaPool({ pin: PIN, rpcs: rs, relayFee: async (e) => feeAnswer(e) }), /one provider twice/);
    assert.throws(() => solanaTreeSync(rs, PROGRAM), /one provider twice/);
    await assert.rejects(solanaNow(rs), /one provider twice/);
    await assert.rejects(solanaMarks(rs, PROGRAM), /one provider twice/);
  }
  assert.throws(() => solanaPool({ pin: { program: PROGRAM, feePayer: POOL }, rpcs: pair(relChain(), relChain()), relayFee: async (e) => feeAnswer(e) }), /feePayer: the pool/);
});

test("bind refuses a chunk the program would refuse at the fee: the backstop, and W left under rent(0)", async () => {
  // at the fee 1,300,000: 2 x fee is 2,600,000; W keeps chunk - fee - the 1,000,000 tip cap, at least rent(0) 650,240
  await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind({ ...args(), chunk: 2_500_000n }), /backstop/);
  await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind({ ...args(), chunk: 2_900_000n }), /under rent\(0\)/);
  assert.equal((await poolWith(pair(nowChain(), nowChain())).bind({ ...args(), chunk: 2_950_240n })).feeCap, 1_300_000n);
});

test("trees refuses a page that is not the program's: another owner, another page's header", async () => {
  const before = T(5) * 1000n + 1n;
  const base = relChain();
  const page0 = solanaPageOf(PROGRAM, 0, 0);
  const owner: Chain = { ...base };
  const o = rpc(owner, MAINNET);
  const foreign: SolanaRpc = async (m, p) => {
    const r = (await o(m, p)) as { value?: { owner: string }[] };
    if (m === "getMultipleAccounts") r.value = r.value!.map((x) => (x === null ? x : { ...x, owner: W }));
    return r;
  };
  await assert.rejects(poolWith([rpc(base, MAINNET), foreign]).trees(before), /not the program's account/);
  const header = new Map(base.accounts);
  const d = header.get(page0)!.slice();
  d[9] = 1; // page_no 1 in page 0's account
  header.set(page0, d);
  await assert.rejects(poolWith(pair(base, { ...base, accounts: header })).trees(before), /not page 0 of tree 0/);
});

// the boundary pool: both trees past one full page (1,024 entries) into page 1
function boundary() {
  const labels = B.deposits.map((_, i) => vaultLabelOf(keccak_256, SCOPE, BigInt(i + 1)));
  const commit = (i: number) => noteCommitment(BigInt(B.deposits[i]!.value), labels[i]!, big(B.deposits[i]!.precommitment));
  const state = entries([
    ...B.deposits.slice(0, 1024).map((_, i) => ({ leaf: commit(i), t: 1_800_000_000n + BigInt(i) })),
    { leaf: big(B.spends[0]!.new_commitment), t: 1_800_002_000n },
    { leaf: commit(1024), t: 1_800_002_001n },
  ]);
  const label = entries(labels.map((leaf, i) => ({ leaf, t: i < 1024 ? 1_800_000_000n + BigInt(i) : 1_800_002_001n })));
  return { state, label };
}

test("incremental sync: a full page is read once; a later call reads only the newest page and any after it", async () => {
  const { state, label } = boundary();
  // first: the pool before deposit 1,024 (state 1,025 entries, label 1,024: label page 0 full, no label page 1)
  const at = (n: number, m: number): Chain => ({ accounts: new Map([...pages(0, state.slice(0, n)), ...pages(1, label.slice(0, m))]), slot: 900, time: () => 1_800_003_000n });
  const chain = { c: at(1025, 1024) };
  const logs: string[][] = [[], []];
  const asked: string[][] = [[], []];
  const spy = (k: number): SolanaRpc => async (m, p) => {
    if (m === "getMultipleAccounts") asked[k]!.push(...(p[0] as string[]));
    return rpc(chain.c, MAINNET, logs[k])(m, p);
  };
  const sync = solanaTreeSync([spy(0), spy(1)], PROGRAM);
  const one = await sync.trees(1_800_002_001_000n);
  assert.equal(one.stateRoot, big(B.state_roots["1024"]!));
  for (const k of [0, 1]) for (const t of [0, 1] as const) assert.ok(asked[k]!.includes(solanaPageOf(PROGRAM, t, 0)), "the first call reads page 0");
  // then deposit 1,024 lands: the second call reads page 1 of each tree and on, never page 0
  chain.c = at(1026, 1025);
  asked[0] = [];
  asked[1] = [];
  const two = await sync.trees(1_800_002_002_000n);
  assert.equal(two.stateRoot, big(B.state_roots["1025"]!));
  assert.equal(two.labelRoot, big(B.label_roots["1024"]!));
  for (const k of [0, 1]) {
    for (const t of [0, 1] as const) assert.ok(!asked[k]!.includes(solanaPageOf(PROGRAM, t, 0)), `rpc ${k} tree ${t}: page 0 is not read again`);
    assert.ok(asked[k]!.includes(solanaPageOf(PROGRAM, 0, 1)) && asked[k]!.includes(solanaPageOf(PROGRAM, 1, 1)), `rpc ${k}: the newest pages are read`);
  }
});

test("incremental sync: a page read before that has changed in a later read is refused", async () => {
  const { state, label } = boundary();
  const chain = { c: { accounts: new Map([...pages(0, state.slice(0, 1000)), ...pages(1, label.slice(0, 1000))]), slot: 900, time: () => 1_800_003_000n } as Chain };
  const sync = solanaTreeSync([async (m, p) => rpc(chain.c, MAINNET)(m, p), async (m, p) => rpc(chain.c, MAINNET)(m, p)], PROGRAM);
  await sync.trees(1_800_001_000_000n);
  // page 0 fills up, with entry 10 changed on both RPCs since it was read
  chain.c = { ...chain.c, accounts: new Map([...pages(0, state.slice(0, 1025), (e, i) => { if (i === 10) e[0] ^= 1; }), ...pages(1, label.slice(0, 1024))]) };
  await assert.rejects(sync.trees(1_800_002_001_000n), /tree 0: page 0 changed since it was read/);
});

test("the fixtures' precommitment marks decode to each deposit's value and the nonce its label hashes", () => {
  const rows = R.deposits as unknown as { value: string; label: string; mark: string }[];
  for (const [i, d] of rows.entries()) {
    const m = unhex(d.mark);
    const v = new DataView(m.buffer);
    assert.equal(m.length, 16);
    assert.equal(v.getBigUint64(0, true), BigInt(d.value), `deposit ${i}: value`);
    assert.equal(vaultLabelOf(keccak_256, SCOPE, v.getBigUint64(8, true)), big(d.label), `deposit ${i}: the nonce's label`);
  }
});

// Restore from the words alone: the all-zero test seed's notes in the fixture pool (test values, never money).
const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
/** A spent mark as the program will write it (M355 (3), card pool-sol-deploy): withdrawnValue u64 LE, 8 bytes. */
const spentData = (withdrawn: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, withdrawn, true);
  return b;
};
const markData = (value: bigint, nonce: bigint): Uint8Array => {
  const b = new Uint8Array(16);
  new DataView(b.buffer).setBigUint64(0, value, true);
  new DataView(b.buffer).setBigUint64(8, nonce, true);
  return b;
};
function restorePool() {
  const P = (ref: Parameters<typeof noteSecrets>[1]) => noteSecrets(SEED, ref).precommitment;
  const state: { leaf: bigint; t: bigint }[] = [];
  const labels: { leaf: bigint; t: bigint }[] = [];
  const marks = new Map<string, Uint8Array>();
  let t = 1_800_000_000n;
  // a deposit as deposit.rs makes it: its mark (value, nonce), its commitment and its label, one second apart
  const deposit = (precommitment: bigint, value: bigint): bigint => {
    const nonce = BigInt(labels.length + 1);
    const label = vaultLabelOf(keccak_256, SCOPE, nonce);
    labels.push({ leaf: label, t });
    state.push({ leaf: noteCommitment(value, label, precommitment), t });
    marks.set(solanaMarkOf(PROGRAM, "pre", precommitment), markData(value, nonce));
    t += 1n;
    return label;
  };
  // another user's deposit first, then ours: deposit notes 0 and 9 (lanes 0 and 1), U_{s,0}'s second arrival 0
  deposit(big(R.deposits[0]!.precommitment), 20_000_000n);
  const l0 = deposit(P({ kind: "deposit", s: SCOPE, i: 0 }), 50_000_000n);
  deposit(P({ kind: "deposit", s: SCOPE, i: 9 }), 10_000_000n);
  deposit(P({ kind: "second", id: { id: "U", s: SCOPE, i: 0 }, n: 0 }), 20_000_000n);
  // the pool just before deposit 0's release, three slots earlier (card sol-restore-race)
  const beforeSpend: Chain = { accounts: new Map([...pages(0, entries(state)), ...pages(1, entries(labels))]), slot: 697, time: () => t + 5n, marks: new Map(marks) };
  // deposit 0 is released whole: its spent mark, its change note of 0 into the state tree
  marks.set(solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash), spentData(50_000_000n));
  state.push({ leaf: noteCommitment(0n, l0, P({ kind: "change", l: l0, j: 0 })), t: (t += 1n) });
  // the pool right after the release, with nothing else landed: only the spent mark and the change leaf are new
  const afterSpend: Chain = { accounts: new Map([...pages(0, entries(state)), ...pages(1, entries(labels))]), slot: 699, time: () => t + 5n, marks: new Map(marks) };
  // the sell's proceeds came back to the pool as W_{sol, l0, 0}'s return note
  deposit(P({ kind: "return", c: "sol", l: l0, j: 0 }), 5_000_000n);
  // someone else's spent mark
  marks.set(solanaMarkOf(PROGRAM, "spent", 12345n), spentData(20_000_000n));
  const chain: Chain = { accounts: new Map([...pages(0, entries(state)), ...pages(1, entries(labels))]), slot: 700, time: () => t + 5n, marks };
  return { chain, l0, P, beforeSpend, afterSpend };
}

test("restore from the words alone: every note and each spent note's W, from the marks and pages on two RPCs", async () => {
  const { chain, l0 } = restorePool();
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain), gap: 4 });
  assert.equal(r.notes.length, 5);
  assert.deepEqual(r.notes.filter((n) => n.state === "SPENT").map((n) => n.ref.kind), ["deposit"]);
  assert.ok(r.notes.some((n) => n.ref.kind === "deposit" && n.ref.i === 0 && n.leaf.value === 50_000_000n && n.leaf.leafIndex === 1n));
  assert.ok(r.notes.some((n) => n.ref.kind === "deposit" && n.ref.i === 9 && n.leaf.leafIndex === 2n));
  assert.ok(r.notes.some((n) => n.ref.kind === "second" && n.leaf.value === 20_000_000n));
  assert.ok(r.notes.some((n) => n.ref.kind === "change" && n.leaf.value === 0n && n.leaf.leafIndex === 4n));
  assert.ok(r.notes.some((n) => n.ref.kind === "return" && n.leaf.value === 5_000_000n && n.leaf.leafIndex === 5n));
  assert.deepEqual(r.spends.map((s) => [s.l, s.j, s.withdrawn, s.w]), [[l0, 0, 50_000_000n, d.freshWallet(SEED, "sol", l0, 0).address]]);
});

test("restore refuses two RPCs whose marks differ, a mark whose nonce is not its label, and a mark not in the state tree", async () => {
  const { chain, P } = restorePool();
  const key = solanaMarkOf(PROGRAM, "pre", P({ kind: "deposit", s: SCOPE, i: 9 }));
  const edit = (f: (m: Map<string, Uint8Array>) => void): Chain => {
    const m = new Map(chain.marks!);
    f(m);
    return { ...chain, marks: m };
  };
  // a key both RPCs hold with different bytes, a pre mark or a spent mark
  const other = edit((m) => m.set(key, markData(10_000_000n, 4n)));
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, other), gap: 4 }), /bytes differ/);
  const spentKey = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(edit((m) => m.set(spentKey, spentData(40_000_000n))), chain), gap: 4 }), /bytes differ/);
  // a spent mark that withdrew more than the note held, or nothing
  for (const w of [50_000_001n, 0n]) await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(...[edit((m) => m.set(spentKey, spentData(w)))].flatMap((c) => [c, c]) as [Chain, Chain]), gap: 4 }), /its spent mark withdrew/);
  // a mark of a size the program never writes
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain).map((r) => Object.assign(async (m: string, p: readonly unknown[]) => {
    const a = (await r(m, p)) as { value?: { account: { data: [string, string] } }[] };
    if (m === "getProgramAccounts" && a.value!.length > 0) a.value![0]!.account.data = [base64.encode(new Uint8Array(3)), "base64"];
    return a;
  }, { url: r.url })) as [SolanaRpc, SolanaRpc], gap: 4 }), /not (8|16) bytes/);
  // both RPCs: the nonce of another deposit (its label is not this note's), another value (not in the state tree)
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(other, other), gap: 4 }), /commitment is not in the state tree/);
  // a mark of value 0 or nonce 0, which the program never writes (R11)
  for (const z of [markData(0n, 3n), markData(10_000_000n, 0n)]) {
    const c = edit((m) => m.set(key, z));
    await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(c, c), gap: 4 }), /is not a label tree leaf/);
  }
  // one RPC lists a mark twice, or an account of another program (R2, R3)
  const twist = (f: (v: { pubkey: string; account: { owner: string } }[]) => void): [SolanaRpc, SolanaRpc] => pair(chain, chain).map((r) => Object.assign(async (m: string, p: readonly unknown[]) => {
    const a = (await r(m, p)) as { value?: { pubkey: string; account: { owner: string } }[] };
    if (m === "getProgramAccounts" && a.value!.length > 0) f(a.value!);
    return a;
  }, { url: r.url })) as [SolanaRpc, SolanaRpc];
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: twist((v) => void v.push(v[0]!)), gap: 4 }), /an account twice/);
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: twist((v) => void (v[0]!.account = { ...v[0]!.account, owner: FEE_PAYER })), gap: 4 }), /not the program's account/);
  const far = edit((m) => m.set(key, markData(10_000_000n, 99n)));
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(far, far), gap: 4 }), /is not a label tree leaf/);
  // both RPCs serve another label at deposit 9's place in the label tree
  const label = { ...chain, accounts: new Map(chain.accounts) };
  const lp = solanaPageOf(PROGRAM, 1, 0);
  const lb = label.accounts.get(lp)!.slice();
  lb[16 + 72 * 2 + 31] ^= 1;
  label.accounts.set(lp, lb);
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(label, label), gap: 4 }), /its label is not the label tree's leaf 2/);
  const value = edit((m) => m.set(key, markData(20_000_000n, 3n)));
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(value, value), gap: 4 }), /commitment is not in the state tree/);
});

test("RV5 inverted: the marks are the union of the two RPCs: one RPC lacking a mark the other has still restores every note", async () => {
  const { chain, P } = restorePool();
  const edit = (f: (m: Map<string, Uint8Array>) => void): Chain => { const m = new Map(chain.marks!); f(m); return { ...chain, marks: m }; };
  const noSpent = edit((m) => m.delete(solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash)));
  const noOurs = edit((m) => m.delete(solanaMarkOf(PROGRAM, "pre", P({ kind: "deposit", s: SCOPE, i: 9 }))));
  for (const rs of [pair(noSpent, chain), pair(chain, noSpent), pair(noOurs, chain), pair(noSpent, noOurs)]) {
    const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: rs, gap: 4 });
    assert.equal(r.notes.length, 5);
    assert.equal(r.spends.length, 1);
  }
});

test("RV6: a spent note's move note and its V, A and R second arrivals come back", async () => {
  const Pf = (ref: Parameters<typeof noteSecrets>[1]) => noteSecrets(SEED, ref).precommitment;
  const state: { leaf: bigint; t: bigint }[] = [];
  const labels: { leaf: bigint; t: bigint }[] = [];
  const marks = new Map<string, Uint8Array>();
  let t = 1_800_000_000n;
  const deposit = (P: bigint, value: bigint): bigint => {
    const nonce = BigInt(labels.length + 1);
    const label = vaultLabelOf(keccak_256, SCOPE, nonce);
    labels.push({ leaf: label, t });
    state.push({ leaf: noteCommitment(value, label, P), t });
    marks.set(solanaMarkOf(PROGRAM, "pre", P), markData(value, nonce));
    t += 1n;
    return label;
  };
  const l0 = deposit(Pf({ kind: "deposit", s: SCOPE, i: 0 }), 50_000_000n);
  marks.set(solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash), spentData(50_000_000n));
  state.push({ leaf: noteCommitment(0n, l0, Pf({ kind: "change", l: l0, j: 0 })), t: (t += 1n) });
  deposit(Pf({ kind: "move", l: l0, j: 0 }), 10_000_000n);
  deposit(Pf({ kind: "second", id: { id: "V", l: l0, j: 0 }, n: 0 }), 10_000_000n);
  deposit(Pf({ kind: "second", id: { id: "A", l: l0, j: 0 }, n: 0 }), 10_000_000n);
  deposit(Pf({ kind: "second", id: { id: "R", c: "sol", l: l0, j: 0 }, n: 0 }), 10_000_000n);
  const chain: Chain = { accounts: new Map([...pages(0, entries(state)), ...pages(1, entries(labels))]), slot: 700, time: () => t + 5n, marks };
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain), gap: 4 });
  const kinds = r.notes.map((n) => (n.ref.kind === "second" ? `second-${n.ref.id.id}` : n.ref.kind)).sort();
  assert.deepEqual(kinds, ["change", "deposit", "move", "second-A", "second-R", "second-V"]);
});

test("R5: a partial release, then its change spent: the change index runs 0 then 1, each W its own, from withdrawnValue", async () => {
  const Pf = (ref: Parameters<typeof noteSecrets>[1]) => noteSecrets(SEED, ref).precommitment;
  const nh = (ref: Parameters<typeof noteSecrets>[1]) => noteSecrets(SEED, ref).nullifierHash;
  const label = vaultLabelOf(keccak_256, SCOPE, 1n);
  const dep = { kind: "deposit", s: SCOPE, i: 0 } as const;
  const c0 = { kind: "change", l: label, j: 0 } as const;
  const c1 = { kind: "change", l: label, j: 1 } as const;
  // 50,000,000 in; a release of 20,000,000 (any amount: another app on the kit); then the 30,000,000 change released whole
  const state = entries([
    { leaf: noteCommitment(50_000_000n, label, Pf(dep)), t: 1_800_000_000n },
    { leaf: noteCommitment(30_000_000n, label, Pf(c0)), t: 1_800_000_010n },
    { leaf: noteCommitment(0n, label, Pf(c1)), t: 1_800_000_020n },
  ]);
  const marks = new Map<string, Uint8Array>([
    [solanaMarkOf(PROGRAM, "pre", Pf(dep)), markData(50_000_000n, 1n)],
    [solanaMarkOf(PROGRAM, "spent", nh(dep)), spentData(20_000_000n)],
    [solanaMarkOf(PROGRAM, "spent", nh(c0)), spentData(30_000_000n)],
  ]);
  const chain: Chain = { accounts: new Map([...pages(0, state), ...pages(1, entries([{ leaf: label, t: 1_800_000_000n }]))]), slot: 700, time: () => 1_800_000_100n, marks };
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain), gap: 4 });
  assert.deepEqual(r.notes.map((n) => [n.ref.kind, n.state, n.leaf.value, n.leaf.leafIndex]), [["deposit", "SPENT", 50_000_000n, 0n], ["change", "SPENT", 30_000_000n, 1n], ["change", "UNSPENT", 0n, 2n]]);
  const w = (j: number) => { const x = d.freshWallet(SEED, "sol", label, j); x.secretKey.fill(0); return x.address; };
  assert.deepEqual(r.spends.map((s) => [s.j, s.withdrawn, s.w]), [[0, 20_000_000n, w(0)], [1, 30_000_000n, w(1)]]);
});

test("RV7: two honest RPCs at different finalized slots still restore, and the pages are read at the higher marks slot", async () => {
  const { chain } = restorePool();
  // RPC a is ahead: someone else's deposit mark landed between the two RPCs' finalized slots
  const ahead: Chain = { ...chain, slot: chain.slot + 3, marks: new Map(chain.marks!).set(solanaMarkOf(PROGRAM, "pre", 777n), markData(10_000_000n, 99n)) };
  const asked: (number | undefined)[] = [];
  const spy = (c: Chain, url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m === "getMultipleAccounts") asked.push((p[1] as { minContextSlot?: number }).minContextSlot);
    // a node at a lower slot that is asked for a higher one answers from a caught-up node (the pages, and the marks
    // read again past them)
    const caughtUp = m === "getMultipleAccounts" || (p[1] as { minContextSlot?: number } | undefined)?.minContextSlot !== undefined;
    return rpc(caughtUp ? ahead : c, MAINNET)(m, p);
  }, { url });
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: [spy(ahead, "https://a.example"), spy(chain, "https://b.example")], gap: 4 });
  assert.equal(r.notes.length, 5);
  assert.ok(asked.length > 0 && asked.every((x) => x === chain.slot + 3), "every page read is at the higher marks slot");
  // an RPC that cannot reach that slot is refused, never read below it
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(ahead, chain), gap: 4 }), /Minimum context slot/);
  // an RPC that ignores minContextSlot and answers from its own lower slot is refused by the device all the same
  const deaf: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m !== "getMultipleAccounts") return rpc(chain, MAINNET)(m, p);
    const { minContextSlot: _, ...cfg } = p[1] as { minContextSlot?: number };
    return rpc(chain, MAINNET)(m, [p[0], cfg]);
  }, { url: "https://b.example" });
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: [rpc(ahead, { ...MAINNET, url: "https://a.example" }), deaf], gap: 4 }), new RegExp(`answered at slot ${chain.slot}, below ${chain.slot + 3}`));
});

test("RV2, RV3, RV4: one RPC short below the cut (either side); the reached check reads its own slot's time; a forged label root", async () => {
  const before = T(5) * 1000n + 1n;
  const short: Chain = { ...relChain(), accounts: new Map([...pages(0, REL_STATE.slice(0, 5)), ...pages(1, REL_LABELS)]) };
  await assert.rejects(poolWith(pair(short, relChain())).trees(before), /tree 0: the two RPCs differ below the cut/);
  // the read is at slot 500, its time T(5) - 1 s; the node's getSlot already says 501, past the cut
  const behind: Chain = { ...relChain(), accounts: new Map([...pages(0, REL_STATE.slice(0, 5)), ...pages(1, REL_LABELS.slice(0, 5))]), time: (sl) => (sl >= 501 ? REL_RELEASE_T + 60n : T(5) - 1n) };
  const late = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => (m === "getSlot" ? 501 : rpc(behind, MAINNET)(m, p)), { url });
  await assert.rejects(solanaTreeSync([late("https://a.example"), late("https://b.example")], PROGRAM).trees(before), /has not reached/);
  const c = relChain();
  const lp = solanaPageOf(PROGRAM, 1, 0);
  const lb = c.accounts.get(lp)!.slice();
  lb[16 + 72 * 5 + 63] ^= 1;
  const forged: Chain = { ...c, accounts: new Map(c.accounts).set(lp, lb) };
  await assert.rejects(poolWith(pair(forged, forged)).trees(before), /tree 1: the root built from the leaves is not the page's root/);
});

test("S9: a read whose block time is the cut's own second, under the cut by 1 ms, has not reached it", async () => {
  const before = T(5) * 1000n + 1n;
  const edge: Chain = { ...relChain(), time: () => T(5) };
  await assert.rejects(poolWith(pair(relChain(), edge)).trees(before), /rpc 1: .* has not reached/);
  assert.equal((await poolWith(pair(relChain(), edge)).trees(T(5) * 1000n)).stateTree.size, 5);
});

test("RV9: the newest read (trees(now + 1), right after now) is at confirmed on both RPCs, and is never kept", async () => {
  const fin = relChain();
  // the finalized block is at 1,800,000,100 s (the release); the confirmed one 13 s later holds one more deposit
  const extra = { leaf: noteCommitment(10_000_000n, vaultLabelOf(keccak_256, SCOPE, 7n), 4242n), t: REL_RELEASE_T + 13n };
  const conf: Chain = { ...fin, slot: 530, accounts: new Map([...pages(0, entries([...REL_DEP, { leaf: big(R.spends[0]!.new_commitment), t: REL_RELEASE_T }, extra])), ...pages(1, entries([...R.deposits.map((x, i) => ({ leaf: big(x.label), t: T(i) })), { leaf: vaultLabelOf(keccak_256, SCOPE, 7n), t: REL_RELEASE_T + 13n }]))]) };
  const at = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    const commitment = (p.at(-1) as { commitment?: string } | undefined)?.commitment;
    const c = m === "getMultipleAccounts" && commitment === "confirmed" ? conf : fin;
    return rpc({ ...c, time: (s) => (s >= 530 ? REL_RELEASE_T + 13n : REL_RELEASE_T) }, MAINNET)(m, p);
  }, { url });
  const rs: [SolanaRpc, SolanaRpc] = [at("https://a.example"), at("https://b.example")];
  const p = poolWith(rs);
  const nowMs = await p.now();
  assert.equal(nowMs, REL_RELEASE_T * 1000n);
  await assert.rejects(p.trees(nowMs + 1n), /has not reached/, "finalized cannot reach now + 1 until the next second");
  const newest = await p.trees(nowMs + 1n, undefined, { newest: true });
  assert.equal(newest.stateTree.size, 7, "the confirmed read reaches now + 1, without the deposit 13 s later");
  assert.equal((await p.trees(nowMs)).stateTree.size, 6, "the epoch read is finalized and held nothing from the confirmed one");
});

test("RV11: an RPC behind what the sync holds, but past the cut, is read at its last slot and not refused as changed", async () => {
  const before = T(5) * 1000n + 1n;
  const chains = { b: relChain() };
  const asked: (number | undefined)[] = [];
  const b: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m === "getMultipleAccounts") asked.push((p[1] as { minContextSlot?: number }).minContextSlot);
    return rpc(chains.b, MAINNET)(m, p);
  }, { url: "https://b.example" });
  const sync = solanaTreeSync([rpc(relChain(), { ...MAINNET, url: "https://a.example" }), b], PROGRAM);
  await sync.trees(before); // holds 7 state entries
  // RPC b's next answer is from a node that lacks the release's change note, its time still past the cut
  chains.b = { ...relChain(), accounts: new Map([...pages(0, REL_STATE.slice(0, 6)), ...pages(1, REL_LABELS)]), time: () => REL_RELEASE_T - 1n };
  const t = await sync.trees(before);
  assert.equal(t.stateTree.size, 6);
  assert.equal(asked.at(-1), 500, "read at or past the slot it answered at before");
});

test("RV12: each malformed page shape is refused (both RPCs serve it)", async () => {
  const before = T(5) * 1000n + 1n;
  const p0 = solanaPageOf(PROGRAM, 0, 0);
  const shape = (f: (x: Uint8Array) => Uint8Array): Chain => { const c = relChain(); return { ...c, accounts: new Map(c.accounts).set(p0, f(c.accounts.get(p0)!)) }; };
  const cases: [Chain, RegExp][] = [
    [shape((x) => x.slice(0, x.length - 1)), /not a page's length/],
    [shape((x) => x.slice(0, 10)), /not a page's length/],
    [shape((x) => x.slice(0, 16)), /0 entries/],
    [shape((x) => { const y = x.slice(); y[8] = 1; return y; }), /not page 0 of tree 0/],
    [shape((x) => { const y = x.slice(); y[0] ^= 1; return y; }), /not page 0 of tree 0/],
  ];
  for (const [c, re] of cases) await assert.rejects(poolWith(pair(c, c)).trees(before), re);
  const tag = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    const r = (await rpc(relChain(), MAINNET)(m, p)) as { value?: ({ data: [string, string] } | null)[] };
    if (m === "getMultipleAccounts") r.value = r.value!.map((x) => (x === null ? x : { ...x, data: [x.data[0], "base58"] }));
    return r;
  }, { url });
  await assert.rejects(poolWith([tag("https://a.example"), tag("https://b.example")]).trees(before), /not base64 data/);
});

test("R4: a state tree that holds one commitment twice stops the restore", () => {
  const P = noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).precommitment;
  const label = vaultLabelOf(keccak_256, SCOPE, 1n);
  const c = noteCommitment(10_000_000n, label, P);
  const marks = { pre: new Map([[solanaMarkOf(PROGRAM, "pre", P), { value: 10_000_000n, nonce: 1n }]]), spent: new Map<string, bigint>(), slot: 1 };
  assert.equal(solanaRestore({ seed64: SEED, program: PROGRAM, scope: SCOPE, stateLeaves: [c], labelLeaves: [label], marks, gap: 2 }).notes.length, 1);
  assert.throws(() => solanaRestore({ seed64: SEED, program: PROGRAM, scope: SCOPE, stateLeaves: [c, c], labelLeaves: [label], marks, gap: 2 }), /state leaf 1 repeats/);
});

test("S5: past a full page, the order of times is checked across the page edge", async () => {
  const { state, label } = boundary();
  const chain = { c: { accounts: new Map([...pages(0, state.slice(0, 1024)), ...pages(1, label.slice(0, 1024))]), slot: 900, time: () => 1_800_003_000n } as Chain };
  const at = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => rpc(chain.c, MAINNET)(m, p), { url });
  const sync = solanaTreeSync([at("https://a.example"), at("https://b.example")], PROGRAM);
  await sync.trees(1_800_001_000_000n); // holds page 0, full: the next read starts at page 1
  // page 1's first entry, on both RPCs, is older than page 0's last
  chain.c = { ...chain.c, accounts: new Map([...pages(0, state.slice(0, 1025), (e, i) => { if (i === 1024) e.fill(0, 64, 72); }), ...pages(1, label.slice(0, 1024))]) };
  await assert.rejects(sync.trees(1_800_001_000_000n), /tree 0: a time goes back at leaf 1024/);
});

test("S6: a behind RPC's shorter read never shrinks what the sync holds: an entry it held and both RPCs now change is refused", async () => {
  const before = T(5) * 1000n + 1n;
  const c = { a: relChain(), b: relChain() };
  const at = (k: "a" | "b", url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => rpc(c[k], MAINNET)(m, p), { url });
  const sync = solanaTreeSync([at("a", "https://a.example"), at("b", "https://b.example")], PROGRAM);
  await sync.trees(before); // holds 7 state entries
  c.b = { ...relChain(), accounts: new Map([...pages(0, REL_STATE.slice(0, 6)), ...pages(1, REL_LABELS)]) };
  assert.equal((await sync.trees(before)).stateTree.size, 6); // b is behind: 6 agreed, 7 still held
  // both RPCs now serve entry 6 (the release's change note, above the cut) changed
  c.a = relChain(500, (e, i) => { if (i === 6) e[0] ^= 1; });
  c.b = c.a;
  await assert.rejects(sync.trees(before), /tree 0: page 0 changed since it was read/);
});

test("S4: a read over several batches is held at its lowest slot, so the next read asks each RPC from there", async () => {
  // 25 pages a tree a batch: 25 full state pages and one more make two batches, the second answered a slot later
  const many = Array.from({ length: 25 * 1024 + 3 }, (_, i) => ({ leaf: BigInt(i + 1), root: 0n, t: 1_800_000_000n }));
  const chain: Chain = { accounts: new Map([...pages(0, many), ...pages(1, many.slice(0, 3))]), slot: 900, time: () => 1_800_000_100n };
  const asked: (number | undefined)[] = [];
  const at = (url: string): SolanaRpc => {
    let calls = 0;
    return Object.assign(async (m: string, p: readonly unknown[]) => {
      if (m !== "getMultipleAccounts") return rpc(chain, MAINNET)(m, p);
      asked.push((p[1] as { minContextSlot?: number }).minContextSlot);
      return rpc({ ...chain, slot: 900 + (calls++ % 2) }, MAINNET)(m, p); // each read: its first batch at 900, its second at 901
    }, { url });
  };
  const sync = solanaTreeSync([at("https://a.example"), at("https://b.example")], PROGRAM);
  const first = await sync.leaves(0);
  assert.equal(first.state.length, many.length);
  assert.deepEqual(first.slots, [901, 901], "the pages' slot a restore reads the marks again past is the highest a batch was answered at");
  asked.length = 0;
  await sync.leaves(0);
  assert.deepEqual(asked, [900, 900], "the next read (one batch: the 25 full pages are held) asks each RPC from the lowest slot its last read was at");
});

// ---------------------------------------------------------------------------------------------- card sol-restore-race
// Two RPCs on one chain that moves on: the first `after` marks reads (getProgramAccounts calls, both RPCs counted) see
// chains[0], the next `after` see chains[1], and so on (the last stays); every other read sees the chain of the latest
// marks read, so the pages are always read after the marks they follow.
function movingPair(chains: readonly Chain[] | ((i: number) => Chain), after = 4, log: { m: string; min?: number; url: string }[] = []): [SolanaRpc, SolanaRpc] {
  let reads = 0;
  const at = (n: number): Chain => (typeof chains === "function" ? chains(Math.floor(n / after)) : chains[Math.min(Math.floor(n / after), chains.length - 1)]!);
  const mk = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    log.push({ m, url, ...((p[1] as { minContextSlot?: number } | undefined)?.minContextSlot === undefined ? {} : { min: (p[1] as { minContextSlot: number }).minContextSlot }) });
    return rpc(m === "getProgramAccounts" ? at(reads++) : at(Math.max(0, reads - 1)), MAINNET)(m, p);
  }, { url });
  return [mk("https://a.example"), mk("https://b.example")];
}

// Two RPCs on a scripted chain: pick(method, n) is the chain a call sees, n the marks reads (getProgramAccounts calls,
// both RPCs counted) made before it, this one included for a marks read.
type RLog = { m: string; url: string; min?: number; slot: number };
function scripted(pick: (m: string, n: number) => Chain, log: RLog[] = []): [SolanaRpc, SolanaRpc] {
  let n = 0;
  const mk = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    const c = m === "getProgramAccounts" ? pick(m, n++) : pick(m, n);
    const min = (p[1] as { minContextSlot?: number } | undefined)?.minContextSlot;
    log.push({ m, url, slot: c.slot, ...(min === undefined ? {} : { min }) });
    return rpc(c, MAINNET)(m, p);
  }, { url });
  return [mk("https://a.example"), mk("https://b.example")];
}
const js = (x: unknown): string => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

test("N1 race (the review's P1): first marks from before the spend, pages from after it: SPENT, with its change", async () => {
  const { chain, beforeSpend, l0 } = restorePool();
  const base = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain), gap: 4 });
  const log: RLog[] = [];
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: scripted((m, n) => (m === "getProgramAccounts" && n < 4 ? beforeSpend : chain), log), gap: 4 });
  assert.ok(log.filter((x) => x.m === "getMultipleAccounts").slice(0, 2).every((x) => x.slot === chain.slot), "the first pages hold the spend's change leaf");
  const d0 = r.notes.find((n) => n.ref.kind === "deposit" && n.leaf.value === 50_000_000n)!;
  assert.equal(d0.state, "SPENT", "the spend landed while the restore read: its note must not come back UNSPENT");
  assert.ok(r.notes.some((n) => n.ref.kind === "change" && n.leaf.label === l0), "its change note");
  assert.equal(js(r), js(base));
  // only the spent mark and its change leaf land (no deposit with them): a new spent mark alone is a new mark
  const { afterSpend } = restorePool();
  const only = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: scripted((m, n) => (m === "getProgramAccounts" && n < 4 ? beforeSpend : afterSpend)), gap: 4 });
  assert.equal(js(only), js(await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(afterSpend, afterSpend), gap: 4 })));
  assert.equal(only.notes.find((n) => n.ref.kind === "deposit" && n.leaf.value === 50_000_000n)!.state, "SPENT");
});

// A pool of these deposits, in order, each a second apart (deposit.rs: its mark, its commitment and its label).
function depositsChain(list: readonly (readonly [bigint, bigint])[], slot: number): Chain {
  const state: { leaf: bigint; t: bigint }[] = [];
  const labels: { leaf: bigint; t: bigint }[] = [];
  const marks = new Map<string, Uint8Array>();
  let t = 1_800_000_000n;
  list.forEach(([P, value], k) => {
    const nonce = BigInt(k + 1);
    const label = vaultLabelOf(keccak_256, SCOPE, nonce);
    labels.push({ leaf: label, t });
    state.push({ leaf: noteCommitment(value, label, P), t });
    marks.set(solanaMarkOf(PROGRAM, "pre", P), markData(value, nonce));
    t += 1n;
  });
  return { accounts: new Map([...pages(0, entries(state)), ...pages(1, entries(labels))]), slot, time: () => t + 5n, marks };
}
const Pof = (ref: Parameters<typeof noteSecrets>[1]): bigint => noteSecrets(SEED, ref).precommitment;
const U = (n: number): readonly [bigint, bigint] => [Pof({ kind: "second", id: { id: "U", s: SCOPE, i: 0 }, n }), 10_000_000n];
const OURS: readonly (readonly [bigint, bigint])[] = [[big(R.deposits[0]!.precommitment), 20_000_000n], [Pof({ kind: "deposit", s: SCOPE, i: 0 }), 50_000_000n], U(0)];
const memo = (f: (i: number) => Chain): ((i: number) => Chain) => {
  const m = new Map<number, Chain>();
  return (i) => m.get(i) ?? (m.set(i, f(i)), m.get(i)!);
};
const gpaCalls = (log: { m: string }[]): number => log.filter((x) => x.m === "getProgramAccounts").length;

test("N1 rounds: the user's own marks growing on every read end in a refusal after the quiet rounds and SOL_RESTORE_ROUNDS walks, never a hang", { timeout: 60_000 }, async () => {
  // every marks read sees one more second arrival of U_{s,0}: the very mark the walk looks up as its miss
  const log: { m: string }[] = [];
  const own = memo((i) => depositsChain([...OURS, ...Array.from({ length: i }, (_, n) => U(n + 1))], 700 + i));
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: movingPair(own, 4, log as never), gap: 4 }), new RegExp(`still grew after ${SOL_RESTORE_ROUNDS} reads`));
  assert.equal(gpaCalls(log), 4 * (1 + SOL_RESTORE_QUIET_ROUNDS + SOL_RESTORE_ROUNDS), "the first read, the quiet rounds, then one read before each walk");
  // the user's own marks landing during the first SOL_RESTORE_QUIET_ROUNDS reads only: read-only rounds, then every one
  const log2: { m: string }[] = [];
  const settled = memo((i) => own(Math.min(i, SOL_RESTORE_QUIET_ROUNDS)));
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: movingPair(settled, 4, log2 as never), gap: 4 });
  assert.equal(gpaCalls(log2), 4 * (SOL_RESTORE_QUIET_ROUNDS + 2));
  assert.equal(js(r), js(await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(own(SOL_RESTORE_QUIET_ROUNDS), own(SOL_RESTORE_QUIET_ROUNDS)), gap: 4 })));
  assert.ok(r.notes.some((n) => n.ref.kind === "second" && n.ref.n === SOL_RESTORE_QUIET_ROUNDS), "the last arrival, landed during the read");
});

test("N1 rounds: other users' marks force only read-only rounds, the result is the same, and the walk's own rule is reached only past the quiet rounds", { timeout: 60_000 }, async () => {
  const busyFor = (k: number) => memo((i) => depositsChain([...OURS, ...Array.from({ length: Math.min(i, k) }, (_, n) => [BigInt(9_000 + n), 10_000_000n] as const)], 700 + Math.min(i, k)));
  for (const k of [1, 3, SOL_RESTORE_QUIET_ROUNDS, 1_000]) {
    const log: { m: string }[] = [];
    const busy = busyFor(k);
    const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: movingPair(busy, 4, log as never), gap: 4 });
    // k reads with new marks: k read-only rounds and one that agrees; past the quiet rounds, the fallback's one walk ends it
    assert.equal(gpaCalls(log), 4 * (Math.min(k, SOL_RESTORE_QUIET_ROUNDS) + 2), String(k));
    const at = Math.min(k, SOL_RESTORE_QUIET_ROUNDS); // the marks the one walk ran on
    assert.equal(js(r), js(await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(busy(at), busy(at)), gap: 4 })), String(k));
  }
});

test("N1 privacy (the review's P3): whether the mark that lands during the read is the user's own never changes the reads", async () => {
  const c0 = depositsChain(OURS, 700);
  const other = depositsChain([...OURS, [424242n, 10_000_000n]], 701); // another user's deposit
  const own = depositsChain([...OURS, U(1)], 701); // the user's own second arrival on U_{s,0}
  const pattern = async (next: Chain): Promise<string[]> => {
    const log: RLog[] = [];
    await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: scripted((_m, n) => (n < 4 ? c0 : next), log), gap: 4 });
    return log.map((x) => `${x.url}:${x.m}:${x.min ?? ""}`);
  };
  assert.deepEqual(await pattern(own), await pattern(other));
});

test("N1 round 2 (MX5): the pages are read again at or past the merged marks' slot, never at the first read's", async () => {
  // a node that serves the pages from before the spend unless asked for slot 700 or later
  const { chain, beforeSpend } = restorePool();
  const base = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain), gap: 4 });
  const lagging = (m: string, n: number, min?: number): Chain => (m === "getProgramAccounts" ? (n < 4 ? beforeSpend : chain) : (min ?? 0) >= chain.slot ? chain : beforeSpend);
  const mk = (url: string, count: { n: number }): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    const min = (p[1] as { minContextSlot?: number } | undefined)?.minContextSlot;
    return rpc(lagging(m, m === "getProgramAccounts" ? count.n++ : count.n, min), MAINNET)(m, p);
  }, { url });
  const count = { n: 0 };
  assert.equal(js(await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: [mk("https://a.example", count), mk("https://b.example", count)], gap: 4 })), js(base));
});

const instant: SolanaLagWait = async () => {};

test("RPC lag: the wait of about a slot comes between two calls, never after the last; no wait for any other error", async () => {
  const lag = () => new Error("RPC error -32016: Minimum context slot has not been reached");
  const run = async (answers: (Error | string)[]): Promise<{ steps: string[]; out: string }> => {
    const steps: string[] = [];
    let k = 0;
    const out = await solanaLagRetry(async () => {
      steps.push("call");
      const a = answers[k++]!;
      if (a instanceof Error) throw a;
      return a;
    }, async (ms) => void steps.push(`wait ${ms}`)).catch((e: Error) => `threw ${e.message.slice(0, 16)}`);
    return { steps, out };
  };
  assert.deepEqual(await run([lag(), lag(), "ok"]), { steps: ["call", "wait 400", "call", "wait 400", "call"], out: "ok" });
  assert.deepEqual(await run([lag(), lag(), lag(), "never"]), { steps: ["call", "wait 400", "call", "wait 400", "call"], out: "threw RPC error -32016" });
  assert.deepEqual(await run([new Error("RPC error -32005: node is unhealthy")]), { steps: ["call"], out: "threw RPC error -32005" });
  assert.deepEqual(await run(["ok"]), { steps: ["call"], out: "ok" });
  assert.equal(SOL_LAG_WAIT_MS, 400);
});

test("RPC lag: a -32016 answer is tried again, SOL_LAG_TRIES calls at most, then refused", async () => {
  const { chain } = restorePool();
  const base = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain), gap: 4 });
  const flaky = (url: string, every: number, calls: string[]): SolanaRpc => {
    let k = 0;
    return Object.assign(async (m: string, p: readonly unknown[]) => {
      calls.push(m);
      if ((p[1] as { minContextSlot?: number } | undefined)?.minContextSlot !== undefined && k++ % every === 0) throw new Error("RPC error -32016: Minimum context slot has not been reached");
      return rpc(chain, MAINNET)(m, p);
    }, { url });
  };
  // each first call with minContextSlot lags once: the restore holds
  const calls: string[] = [];
  assert.equal(js(await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lagWait: instant, rpcs: [flaky("https://a.example", 2, calls), rpc(chain, { ...MAINNET, url: "https://b.example" })], gap: 4 })), js(base));
  // a node that never reaches the slot: refused after SOL_LAG_TRIES calls of that read
  const stuck: string[] = [];
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lagWait: instant, rpcs: [flaky("https://a.example", 1, stuck), rpc(chain, { ...MAINNET, url: "https://b.example" })], gap: 4 }), /-32016/);
  assert.equal(stuck.filter((m) => m === "getMultipleAccounts").length, SOL_LAG_TRIES);
  // any other error is never tried again
  let other = 0;
  const broken: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m === "getProgramAccounts") (other++, (() => { throw new Error("RPC error -32005: node is unhealthy"); })());
    return rpc(chain, MAINNET)(m, p);
  }, { url: "https://a.example" });
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lagWait: instant, rpcs: [broken, rpc(chain, { ...MAINNET, url: "https://b.example" })], gap: 4 }), /-32005/);
  assert.equal(other, 1);
});

test("N1 re-read: each RPC's marks are read again at or past its own pages' slot, and an answer below it is refused", async () => {
  const { chain } = restorePool();
  const log: { m: string; min?: number; url: string }[] = [];
  // the first marks read at 705 and 701; each RPC's pages answered at its own later slot, 708 and 706
  const spy = (markSlot: number, pageSlot: number, url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    const min = (p[1] as { minContextSlot?: number } | undefined)?.minContextSlot;
    log.push({ m, url, ...(min === undefined ? {} : { min }) });
    return rpc({ ...chain, slot: m === "getProgramAccounts" && min === undefined ? markSlot : pageSlot }, MAINNET)(m, p);
  }, { url });
  await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: [spy(705, 708, "https://a.example"), spy(701, 706, "https://b.example")], gap: 4 });
  const again = log.filter((x) => x.m === "getProgramAccounts").slice(4);
  assert.deepEqual(again.map((x) => [x.url, x.min]).sort(), [["https://a.example", 708], ["https://a.example", 708], ["https://b.example", 706], ["https://b.example", 706]]);
  // an RPC that ignores minContextSlot on the marks and answers from below it is refused, never merged
  const deaf: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m !== "getProgramAccounts") return rpc({ ...chain, slot: 703 }, MAINNET)(m, p);
    const { minContextSlot: _, ...cfg } = p[1] as { minContextSlot?: number };
    return rpc(chain, MAINNET)(m, [p[0], cfg]);
  }, { url: "https://b.example" });
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: [rpc({ ...chain, slot: 703 }, { ...MAINNET, url: "https://a.example" }), deaf], gap: 4 }), /rpc 1: getProgramAccounts: answered at slot 700, below 703/);
});

test("N1 union: a mark the second read gives with other bytes than the first is refused (the union rule, M355)", async () => {
  const { chain } = restorePool();
  const spent0 = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const pre9 = solanaMarkOf(PROGRAM, "pre", Pof({ kind: "deposit", s: SCOPE, i: 9 }));
  for (const [k, d] of [[spent0, spentData(40_000_000n)], [pre9, markData(10_000_000n, 4n)], [pre9, markData(10_000_001n, 3n)]] as const) {
    const changed: Chain = { ...chain, marks: new Map(chain.marks!).set(k, d) };
    await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: movingPair([chain, changed]), gap: 4 }), /two reads differ/, k);
  }
  assert.throws(() => solanaMarksUnion({ spent: new Map([["k", 1n]]), pre: new Map(), slot: 1 }, { spent: new Map([["k", 2n]]), pre: new Map(), slot: 2 }), /two reads differ/);
  assert.equal(solanaMarksUnion({ spent: new Map([["k", 1n]]), pre: new Map(), slot: 1 }, { spent: new Map([["j", 2n]]), pre: new Map(), slot: 2 }).slot, 2);
});

// A note store holding deposit note 0 of the pool, RESERVED: proved, taken and sent (queue.ts take), as when the send
// comes back refused as already spent.
const stores: { close(): void }[] = [];
after(() => { for (const x of stores.splice(0)) x.close(); });
async function reservedDeposit0(l0: bigint): Promise<{ ns: NoteStore; id: string }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  stores.push(ns, w);
  const ref = { kind: "deposit", s: SCOPE, i: 0 } as const;
  const P0 = noteSecrets(SEED, ref).precommitment;
  let n = await ns.add({ ref, scope: SCOPE, precommitment: P0, state: "UNSPENT", leaf: { value: 50_000_000n, label: l0, commitment: noteCommitment(50_000_000n, l0, P0), leafIndex: 1n } });
  n = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 1_800_000_200_000n, context: "1" });
  n = await ns.move(n.id, "HELD", "RESERVED", { attempt: n.attempt! });
  return { ns, id: n.id };
}

test("already spent: a send refused as spent marks the note SPENT with its change, only from the chain's marks and pages on two RPCs", async () => {
  const { chain, beforeSpend, l0 } = restorePool();
  // the chain holds the spend: the change is written UNSPENT and the note goes SPENT, so the queue never offers it again
  const a = await reservedDeposit0(l0);
  const r = await solanaSettleSpent({ seed64: SEED, notes: a.ns, noteId: a.id, program: PROGRAM, rpcs: pair(chain, chain) });
  assert.equal(r.kind, "spent");
  assert.equal((await a.ns.get(a.id))!.state, "SPENT");
  const change = (await a.ns.list()).find((n) => n.ref.kind === "change")!;
  assert.deepEqual([change.state, change.parent, change.leaf!.value, change.leaf!.leafIndex], ["UNSPENT", a.id, 0n, 4n]);
  // settled again (another tab, a retry): the change already there is taken
  const again = await solanaSettleSpent({ seed64: SEED, notes: a.ns, noteId: a.id, program: PROGRAM, rpcs: pair(chain, chain) });
  assert.equal(again.kind === "spent" && again.change.id, change.id);

  // no spent mark on either RPC: the refusal's word changes nothing
  const b = await reservedDeposit0(l0);
  assert.deepEqual(await solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, rpcs: pair(beforeSpend, beforeSpend) }), { kind: "unspent" });
  assert.equal((await b.ns.get(b.id))!.state, "RESERVED");
  assert.equal((await b.ns.list()).length, 1);

  // one RPC (with the helper, which saw the nullifier hash in the send) claims the spent mark, but the pages both RPCs
  // agree on hold no change leaf: refused, nothing written
  const spent0 = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const claimed: Chain = { ...beforeSpend, marks: new Map(beforeSpend.marks!).set(spent0, spentData(50_000_000n)) };
  for (const rs of [pair(claimed, beforeSpend), pair(beforeSpend, claimed)]) {
    await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, rpcs: rs }), /is not in the state tree/);
    assert.equal((await b.ns.get(b.id))!.state, "RESERVED");
  }
  // a spent mark over the note's value: refused
  const over: Chain = { ...chain, marks: new Map(chain.marks!).set(spent0, spentData(50_000_001n)) };
  await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, rpcs: pair(over, over) }), /withdrew 50000001 of 50000000/);
  assert.equal((await b.ns.list()).length, 1);
  // a change already in the store at another leaf is never taken for this spend
  const cP = noteSecrets(SEED, { kind: "change", l: l0, j: 0 }).precommitment;
  await b.ns.add({ ref: { kind: "change", l: l0, j: 0 }, scope: SCOPE, precommitment: cP, state: "UNSPENT", parent: b.id, leaf: { value: 0n, label: l0, commitment: noteCommitment(0n, l0, cP), leafIndex: 9n } });
  await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, rpcs: pair(chain, chain) }));
  // a note of another pool is refused before any read
  await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: b58(R.pool), rpcs: pair(chain, chain) }), /not a landed note of this pool/);
});

test("already spent (MX6): the settle reads the pages at or past its marks' slot, and reads them whether or not the mark is there", async () => {
  const { chain, beforeSpend, l0 } = restorePool();
  // a node that serves the pages from before the spend unless asked for the marks' slot or later
  const log: string[] = [];
  const lagging = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    const min = (p[1] as { minContextSlot?: number } | undefined)?.minContextSlot;
    log.push(m);
    return rpc(m === "getProgramAccounts" || (min ?? 0) >= chain.slot ? chain : beforeSpend, MAINNET)(m, p);
  }, { url });
  const a = await reservedDeposit0(l0);
  assert.equal((await solanaSettleSpent({ seed64: SEED, notes: a.ns, noteId: a.id, program: PROGRAM, rpcs: [lagging("https://a.example"), lagging("https://b.example")] })).kind, "spent");
  const spentReads = [...log];
  // the same reads when the chain holds no spend of the note
  log.length = 0;
  const b = await reservedDeposit0(l0);
  const quiet = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => (log.push(m), rpc(beforeSpend, MAINNET)(m, p)), { url });
  assert.equal((await solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, rpcs: [quiet("https://a.example"), quiet("https://b.example")] })).kind, "unspent");
  assert.deepEqual(log, spentReads);
});

// ---------------------------------------------------------------------------------------------- fold 3 (re-check)
// One RPC on its own script: it counts its own marks reads (2 calls a read: dataSize 8, then 16); read i sees marksAt(i),
// and the pages read after read i see pagesAfter(i). Logs every call.
function perRpc(url: string, marksAt: (i: number) => Chain, pagesAfter: (i: number) => Chain, log: string[]): SolanaRpc {
  let calls = 0;
  return Object.assign(async (m: string, p: readonly unknown[]) => {
    log.push(`${url}:${m}`);
    if (m === "getProgramAccounts") return rpc(marksAt(Math.floor(calls++ / 2)), MAINNET)(m, p);
    return rpc(pagesAfter(Math.max(0, Math.floor(calls / 2) - 1)), MAINNET)(m, p);
  }, { url });
}
const FOREIGN = (k: number): readonly [bigint, bigint] => [BigInt(5_000_000 + k), 10_000_000n];
const junkKey = (k: number): string => solanaMarkOf(PROGRAM, "pre", BigInt(880_000 + k));
// RPC b's chain with a mark of its own making added to every read (never looked up by any walk)
const withJunk = (c: (i: number) => Chain) => (i: number): Chain => {
  const ch = c(i);
  const marks = new Map(ch.marks!);
  for (let k = 1; k <= i; k++) marks.set(junkKey(k), markData(1n, 1n));
  return { ...ch, marks };
};

test("fold 3 (Q2a): a pool busy at every read on both RPCs reaches the fallback; what shows is only whether one of the last round's new marks is the user's", { timeout: 60_000 }, async () => {
  // reads 1..8 each add a foreign deposit on both RPCs; read 9 adds X (the user's own U(1), or one more foreign)
  const at = (x: readonly [bigint, bigint]) => memo((i) => depositsChain([...OURS, ...Array.from({ length: Math.min(i, SOL_RESTORE_QUIET_ROUNDS) }, (_, k) => FOREIGN(k)), ...(i > SOL_RESTORE_QUIET_ROUNDS ? [x] : [])], 700 + Math.min(i, SOL_RESTORE_QUIET_ROUNDS + 1)));
  const run = async (x: readonly [bigint, bigint]) => {
    const log: string[] = [];
    const c = at(x);
    const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: [perRpc("https://a.example", c, c, log), perRpc("https://b.example", c, c, log)], gap: 4 });
    return { log, r };
  };
  const own = await run(U(1));
  const other = await run(FOREIGN(99));
  // the same reads through round 9's marks read; then the foreign run ends at its walk and the own one reads on once
  assert.deepEqual(own.log.slice(0, other.log.length), other.log);
  assert.equal(own.log.length - other.log.length, 2 * (1 + 2), "one more round: each RPC's one pages call and its two marks calls");
  assert.ok(own.r.notes.some((n) => n.ref.kind === "second" && n.ref.n === 1));
  // a landing of the user's own inside the busy rounds (read 4 here) reads the same as a foreign one
  const inside = (x: readonly [bigint, bigint]) => memo((i) => depositsChain([...OURS, ...Array.from({ length: Math.min(i, 3) }, (_, k) => FOREIGN(k)), ...(i >= 4 ? [x] : [])], 700 + Math.min(i, 4)));
  const logOf = async (x: readonly [bigint, bigint]) => {
    const log: string[] = [];
    const c = inside(x);
    await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: [perRpc("https://a.example", c, c, log), perRpc("https://b.example", c, c, log)], gap: 4 });
    return log;
  };
  assert.deepEqual(await logOf(U(1)), await logOf(FOREIGN(99)));
});

test("fold 3 (Q2b): one RPC that adds a mark of its own making to every read never brings a quiet pool to the fallback: own and foreign read the same, then a refusal", { timeout: 60_000 }, async () => {
  const honest = (x: readonly [bigint, bigint]) => memo((i) => depositsChain([...OURS, ...(i > SOL_RESTORE_QUIET_ROUNDS ? [x] : [])], 700 + i));
  const run = async (x: readonly [bigint, bigint], junk: boolean) => {
    const log: string[] = [];
    const h = honest(x);
    const out = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: [perRpc("https://a.example", h, h, log), perRpc("https://b.example", junk ? withJunk(h) : h, h, log)], gap: 4 }).then(() => "restored", (e: Error) => `refused: ${e.message}`);
    return { log, out };
  };
  const ownJ = await run(U(1), true);
  const otherJ = await run(FOREIGN(99), true);
  assert.deepEqual(ownJ.log, otherJ.log);
  assert.match(ownJ.out, /one RPC alone gave new marks/);
  assert.equal(otherJ.out, ownJ.out);
  assert.equal(ownJ.log.filter((x) => x.endsWith("getProgramAccounts")).length, 4 * (1 + SOL_RESTORE_LONE_ROUNDS + 2), "the first read, the lone rounds, the busy round 9, and round 10's lone read that ends it");
  // honest RPCs on the same quiet pool: no leak, and the restore holds
  const ownQ = await run(U(1), false);
  const otherQ = await run(FOREIGN(99), false);
  assert.deepEqual(ownQ.log, otherQ.log);
  assert.deepEqual([ownQ.out, otherQ.out], ["restored", "restored"]);
});

test("fold 3 (Q2c): one RPC (with the helper) adds marks of its own making, then the spent mark of a note whose send left: the owner's device and another read the same, then both refuse", { timeout: 60_000 }, async () => {
  const { beforeSpend } = restorePool();
  const sX = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const sOther = solanaMarkOf(PROGRAM, "spent", 4242n);
  const b = (key: string) => (i: number): Chain => {
    const marks = new Map(beforeSpend.marks!);
    for (let k = 1; k <= i; k++) marks.set(junkKey(k), markData(1n, 1n));
    if (i > SOL_RESTORE_QUIET_ROUNDS) marks.set(key, spentData(50_000_000n));
    return { ...beforeSpend, slot: 700 + i, marks };
  };
  const a = (i: number): Chain => ({ ...beforeSpend, slot: 700 + i });
  const run = async (key: string) => {
    const log: string[] = [];
    const out = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: [perRpc("https://a.example", a, a, log), perRpc("https://b.example", b(key), a, log)], gap: 4 }).then(() => "restored", (e: Error) => `refused: ${e.message}`);
    return { log, out };
  };
  const mine = await run(sX);
  const notMine = await run(sOther);
  assert.deepEqual(mine.log, notMine.log);
  assert.match(mine.out, /one RPC alone gave new marks/);
  assert.equal(notMine.out, mine.out);
});

test("fold 3 (L1): an abort during a lag wait stops the read: no RPC call after the abort", async () => {
  const { chain } = restorePool();
  const ctl = new AbortController();
  let afterAbort = 0;
  const lagOnce = (url: string): SolanaRpc => {
    let lagged = false;
    return Object.assign(async (m: string, p: readonly unknown[]) => {
      if (ctl.signal.aborted) afterAbort++;
      if (m === "getMultipleAccounts" && !lagged) {
        lagged = true;
        throw new Error("RPC error -32016: Minimum context slot has not been reached");
      }
      return rpc(chain, MAINNET)(m, p);
    }, { url });
  };
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, signal: ctl.signal, lagWait: async () => ctl.abort(), rpcs: [lagOnce("https://a.example"), lagOnce("https://b.example")], gap: 4 }), { name: "AbortError" });
  await new Promise((ok) => setTimeout(ok, 20)); // let the other RPC's read settle
  assert.equal(afterAbort, 0);
  // and the same for the marks read
  const ctl2 = new AbortController();
  let after2 = 0;
  const lagMarks: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    if (ctl2.signal.aborted) after2++;
    if (m === "getProgramAccounts") throw new Error("RPC error -32016: Minimum context slot has not been reached");
    return rpc(chain, MAINNET)(m, p);
  }, { url: "https://a.example" });
  await assert.rejects(solanaMarks([lagMarks, rpc(chain, { ...MAINNET, url: "https://b.example" })], PROGRAM, ctl2.signal, undefined, async () => ctl2.abort()), { name: "AbortError" });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(after2, 0);
});
