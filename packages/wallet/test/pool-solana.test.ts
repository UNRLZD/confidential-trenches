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
import { SOLANA_ANSWER_MAX_BYTES, VaultTree, solanaJsonRpc, vaultLabelOf, type SolanaRpc } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets } from "../src/notes/secrets.ts";
import { SOL_MARK_BUCKET, SOL_MARK_TAG, SOL_PRE_MARK_LEN, SOL_SETTLE_ROUNDS, SOL_SPENT_MARK_LEN, type SolanaPoolCache, solanaMarkOf, solanaMarksListed, solanaMarksUnion, solanaRestore, solanaRestoreNotes, solanaSettleReserved, solanaSettleSpent, type SolanaSpentMark } from "../src/pool/solana-restore.ts";
import { IDBFactory } from "fake-indexeddb";
import { openNoteStore, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore } from "../src/store/index.ts";
import { refKey } from "../src/notes/store.ts";
import { checkPool } from "../src/pool/pool.ts";
import {
  SOL_LAG_SLOTS, SOL_LAG_WAIT_MS, SOL_PAGES_A_CALL, SOL_LIFE_MS, type SolanaLagWait, solanaLagRetry, SOL_TIP_CAP, solanaContextOf, solanaEpochFee, solanaNow, solanaPageOf, solanaPool, solanaPoolOf, solanaTreeSync, type SolanaFeeAnswer,
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
// each mark's size, the program's (contracts/pool-solana/src/state.rs): a spent mark 13 bytes, a precommitment mark 17
const SPENT_LEN = SOL_SPENT_MARK_LEN;
const PRE_LEN = SOL_PRE_MARK_LEN;
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
/** The bytes of a getProgramAccounts answer of n marks of `size` bytes, as a real RPC writes it (base64, withContext,
 * rent-exempt lamports, rentEpoch at u64 max, space); the largest the fake has answered so far. */
function gpaAnswerBytes(n: number, size: number): number {
  const one = { account: { data: [base64.encode(new Uint8Array(size)), "base64"], executable: false, lamports: 1_002_240, owner: PROGRAM, rentEpoch: "18446744073709551615", space: size }, pubkey: PROGRAM };
  const env = { jsonrpc: "2.0", id: 4_294_967_295, result: { context: { apiVersion: "2.2.0", slot: 400_000_000 }, value: [] as unknown[] } };
  return JSON.stringify(env).length + n * (JSON.stringify(one).length - 2 + 1);
}
let gpaBiggest = 0;
type Over = { perByte?: number; factor?: number; fee?: number; url?: string };
/** One RPC answering the reads solana.ts makes, from a chain's accounts at its finalized slot. */
function rpc(c: Chain, o: Over = {}, log: string[] = []): SolanaRpc {
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    // a macrotask, as a real request is: a restore that loops without end fails at its test's timeout, never hangs it
    await new Promise((ok) => setImmediate(ok));
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
        // an answer past the kit's cap is refused, as its JSON-RPC client does (trade/solana/send.ts)
        // a page, or a mark read by its address (card exit-pool-notes: a listed restore reads every listed mark so)
        const at = (a: string): Uint8Array | undefined => c.accounts.get(a) ?? c.marks?.get(a);
        const answer = { context: ctx, value: (params[0] as string[]).map((a) => (at(a) !== undefined ? { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(at(a)!), "base64"] } : null)) };
        if (JSON.stringify({ jsonrpc: "2.0", id: 1, result: answer }).length > SOLANA_ANSWER_MAX_BYTES) throw new Error("answer too large");
        return answer;
      }
      case "getLatestBlockhash": return { context: ctx, value: { blockhash: base58.encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 1 } };
      case "getFeeForMessage": return { context: ctx, value: o.fee ?? 10_000 };
      case "getProgramAccounts": {
        assert.equal(params[0], PROGRAM);
        const filters = (params[1] as { filters: [{ dataSize: number }, { memcmp: { offset: number; bytes: string } }] }).filters;
        const size = filters[0].dataSize;
        // a bucket of the marks of one size: the counter's bytes past its low byte (offset 9), then the program's tag,
        // never a note's address
        assert.ok(size === SPENT_LEN || size === PRE_LEN, `dataSize ${size}`);
        assert.equal(filters.length, 2);
        assert.deepEqual(Object.keys(filters[1]), ["memcmp"]);
        assert.equal(filters[1].memcmp.offset, 9);
        const high = base58.decode(filters[1].memcmp.bytes);
        assert.equal(high.length, size === SPENT_LEN ? 4 : 8);
        assert.equal(high[high.length - 1], SOL_MARK_TAG, "the memcmp ends with the tag");
        assert.equal((params[1] as { withContext?: boolean }).withContext, true);
        const min = (params[1] as { minContextSlot?: number }).minContextSlot;
        if (min !== undefined && c.slot < min) throw new Error(`Minimum context slot has not been reached: ${c.slot} < ${min}`);
        const answer = { context: ctx, value: [...(c.marks ?? new Map())].filter(([, d]) => d.length === size && high.every((x, i) => d[9 + i] === x)).map(([pubkey, d]) => ({ pubkey, account: { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(d), "base64"] } })) };
        // an answer past the kit's cap is refused, as its JSON-RPC client does (trade/solana/send.ts), measured in a real
        // RPC's shape: rent-exempt lamports, rentEpoch at u64 max and space on every account
        const bytes = gpaAnswerBytes(answer.value.length, size);
        gpaBiggest = Math.max(gpaBiggest, bytes);
        if (bytes > SOLANA_ANSWER_MAX_BYTES) throw new Error("answer too large");
        return answer;
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
// a restore's or a settle's count refusal (solanaMarkCounts): D deposits and R releases listed, each RPC's own
// [state, label] leaf counts
const marksAre = (d: number, r: number, a: readonly [number, number], b: readonly [number, number]) =>
  `restore: the lister listed ${d} deposits and ${r} releases (${d} label and ${d + r} state leaves), but rpc 0's pages hold ${a[0]} state and ${a[1]} label leaves and rpc 1's hold ${b[0]} state and ${b[1]} label leaves`;
const exactly = (m: string) => new RegExp(`^${m.replace(/[()]/g, "\\$&")}$`);

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

test("bind for a withdraw (tipCap 0, card signpage-pool-withdraw-form): no tip is bound and none counts in W's rent floor; no other tip cap is taken", async () => {
  const rent0 = (128n * 5_080n);
  const fee = 1_300_000n;
  const b = await poolWith(pair(nowChain(), nowChain())).bind({ ...args(), tipCap: 0n });
  assert.equal(b.request.tipCap, 0n);
  assert.equal(b.context, solanaContextOf(b.request, SCOPE));
  // the floor without the tip: W holds chunk - fee after the release, at least rent(0); the backstop 2 x fee
  const floor = fee + rent0 > 2n * fee ? fee + rent0 : 2n * fee;
  assert.equal((await poolWith(pair(nowChain(), nowChain())).bind({ ...args(), chunk: floor, tipCap: 0n })).request.tipCap, 0n);
  await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind({ ...args(), chunk: floor - 1n, tipCap: 0n }), /chunk/);
  // a buy's chunk at that floor is still refused: its tip cap counts
  await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind({ ...args(), chunk: floor }), /chunk/);
  // only the two tip caps every user binds: a tip cap per request would mark one user
  for (const tipCap of [1n, SOL_TIP_CAP - 1n, SOL_TIP_CAP + 1n, -1n]) await assert.rejects(poolWith(pair(nowChain(), nowChain())).bind({ ...args(), tipCap }), /tipCap/, String(tipCap));
});

test("the epoch fee is the device's own: the kit's cost rounded up to the step plus two steps, 1,300,000 at mainnet rent; any other helper answer is refused", async () => {
  assert.deepEqual(solanaEpochFee({ lamportsPerByte: 5_080n, factor: 1n }), { cost: 1_092_040n, fee: 1_300_000n }); // M355 (3), M376: the 13-byte spent mark
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
  // a higher rent on both raises the device's own fee: (128 + 13 + 72) x 7,000 + 10,000 = 1,501,000, fee 1,800,000
  const dear = { perByte: 7_000, factor: 1, fee: 10_000 };
  assert.equal((await poolWith(pair(nowChain(), nowChain(), dear, dear), (e) => feeAnswer(e, "1800000")).bind(args())).feeCap, 1_800_000n);
  await assert.rejects(poolWith(pair(nowChain(), nowChain(), dear, dear)).bind(args()), /is not the epoch's fee 1800000/);
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
    await assert.rejects(solanaMarksListed(rs[0], rs, PROGRAM), /one provider twice/);
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
    assert.equal(m.length, PRE_LEN);
    assert.equal(m[16], SOL_MARK_TAG, `deposit ${i}: the tag`);
    assert.equal(v.getBigUint64(0, true), BigInt(d.value), `deposit ${i}: value`);
    assert.equal(vaultLabelOf(keccak_256, SCOPE, v.getBigUint64(8, true)), big(d.label), `deposit ${i}: the nonce's label`);
  }
});

// Restore from the words alone: the all-zero test seed's notes in the fixture pool (test values, never money).
const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
// another device: the 12 words of entropy 0x01..01, holding none of SEED's notes
const SEED_OTHER = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16).fill(1)));
// busy rounds in the schedules below (fold 4's quiet-round count, kept as the attacker's bought rounds)
const Q = 8;
/** A spent mark as the program writes it (M355 (3), M376): withdrawnValue u64 LE, then the release's number u32 LE
 * (the count of releases before it), then the tag, 13 bytes (contracts/pool-solana/src/release.rs). */
const spentData = (withdrawn: bigint, number: number): Uint8Array => {
  const b = new Uint8Array(SPENT_LEN);
  new DataView(b.buffer).setBigUint64(0, withdrawn, true);
  new DataView(b.buffer).setUint32(8, number, true);
  b[12] = SOL_MARK_TAG;
  return b;
};
/** A precommitment mark as the program writes it (M353): value u64 LE, then the nonce u64 LE, then the tag, 17 bytes
 * (contracts/pool-solana/src/deposit.rs). */
const markData = (value: bigint, nonce: bigint): Uint8Array => {
  const b = new Uint8Array(PRE_LEN);
  new DataView(b.buffer).setBigUint64(0, value, true);
  new DataView(b.buffer).setBigUint64(8, nonce, true);
  b[16] = SOL_MARK_TAG;
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
  marks.set(solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash), spentData(50_000_000n, 0));
  state.push({ leaf: noteCommitment(0n, l0, P({ kind: "change", l: l0, j: 0 })), t: (t += 1n) });
  // the pool right after the release, with nothing else landed: only the spent mark and the change leaf are new
  const afterSpend: Chain = { accounts: new Map([...pages(0, entries(state)), ...pages(1, entries(labels))]), slot: 699, time: () => t + 5n, marks: new Map(marks) };
  // the sell's proceeds came back to the pool as W_{sol, l0, 0}'s return note
  deposit(P({ kind: "return", c: "sol", l: l0, j: 0 }), 5_000_000n);
  // someone else's release, as release.rs makes it: its spent mark (the pool's second release, number 1) and its change leaf
  marks.set(solanaMarkOf(PROGRAM, "spent", 12345n), spentData(20_000_000n, 1));
  state.push({ leaf: 12346n, t: (t += 1n) });
  const chain: Chain = { accounts: new Map([...pages(0, entries(state)), ...pages(1, entries(labels))]), slot: 700, time: () => t + 5n, marks };
  // the same pool from an RPC whose state page stops one leaf short (the last release's change left out)
  const shortState: Chain = { accounts: new Map([...pages(0, entries(state.slice(0, -1))), ...pages(1, entries(labels))]), slot: 700, time: () => t + 5n, marks };
  // the same pool with one more deposit of someone else's on top, at `slot`
  const withDeposit = (precommitment: bigint, value: bigint, slot: number): Chain => {
    deposit(precommitment, value);
    const c: Chain = { accounts: new Map([...pages(0, entries(state)), ...pages(1, entries(labels))]), slot, time: () => t + 5n, marks: new Map(marks) };
    state.pop();
    labels.pop();
    marks.delete(solanaMarkOf(PROGRAM, "pre", precommitment));
    return c;
  };
  return { chain, l0, P, beforeSpend, afterSpend, withDeposit, shortState };
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

// card exit-pool-notes: one RPC lists the marks by bucket (getProgramAccounts), and both RPCs read every listed mark by
// its address (getMultipleAccounts), equal byte for byte. The two never serve getProgramAccounts (as
// solana-rpc.publicnode.com refuses it, read 9 Nov 2026 18:40Z), and every mark is read, so neither learns which are ours.
const noGpa = (c: Chain, url: string, log: string[] = []): SolanaRpc => {
  const r = rpc(c, { ...MAINNET, url }, log);
  return Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m === "getProgramAccounts") throw new Error("Indexed requests require a personal token");
    return r(m, p);
  }, { url });
};
const lister = (c: Chain, log: string[] = []): SolanaRpc => rpc(c, { ...MAINNET, url: "https://l.example" }, log);

test("listed restore: one RPC lists the marks, both read each listed mark and the pages, and the notes are the bucket scan's", async () => {
  const { chain } = restorePool();
  const base = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain), gap: 4 });
  const logs: string[][] = [[], [], []];
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lister(chain, logs[2]), rpcs: [noGpa(chain, "https://a.example", logs[0]), noGpa(chain, "https://b.example", logs[1])], gap: 4 });
  const js = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? `${v}` : v));
  assert.equal(js(r), js(base));
  // the two RPCs read accounts by address only; the lister lists and reads nothing else
  for (const k of [0, 1]) assert.ok(logs[k]!.length > 0 && logs[k]!.every((m) => m === "getMultipleAccounts"), `rpc ${k}: ${logs[k]}`);
  assert.ok(logs[2]!.length > 0 && logs[2]!.every((m) => m === "getProgramAccounts"));
});

test("listed restore refuses a lister's lies: a hidden mark, a made-up address, a moved spent mark, an empty list, and short pages", async () => {
  const { chain, afterSpend } = restorePool();
  const [a, b] = [noGpa(chain, "https://a.example"), noGpa(chain, "https://b.example")];
  const run = (l: SolanaRpc, rpcs: readonly [SolanaRpc, SolanaRpc] = [a, b]) => solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: l, rpcs, gap: 4 });
  const marks = [...chain.marks!];
  const spentKey = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const listing = (m: Map<string, Uint8Array>): SolanaRpc => lister({ ...chain, marks: m });
  // a hidden mark: the lister leaves out one deposit's, and the pages on both RPCs count one deposit more
  await assert.rejects(run(listing(new Map(marks.filter(([k]) => k !== marks[1]![0])))), /the lister listed 4 deposits and 2 releases \(4 label and 6 state leaves\), but rpc 0's pages hold 7 state and 5 label leaves and rpc 1's hold 7 state and 5 label leaves$/);
  // a made-up address in a bucket: both RPCs read nothing there
  const fake = base58.encode(new Uint8Array(32).fill(9));
  await assert.rejects(run(listing(new Map([...marks, [fake, markData(1_000_000n, 99n)]]))), new RegExp(`rpc 0: listed mark ${fake} is not on it`));
  // our spent mark's record listed at another address, in place of its own: that address reads nothing on both RPCs
  await assert.rejects(run(listing(new Map([...marks.filter(([k]) => k !== spentKey), [fake, chain.marks!.get(spentKey)!]]))), /listed mark \S+ is not on it/);
  // one RPC holding another record at a listed mark's address: the two RPCs' bytes differ
  const moved = new Map(chain.marks!);
  moved.set(spentKey, spentData(40_000_000n, 0));
  await assert.rejects(run(lister(chain), [a, noGpa({ ...chain, marks: moved }, "https://b.example")]), /listed mark \S+: the two RPCs' bytes differ/);
  // a lister that answers every bucket empty while the pages count marks: the restore stops and says so
  await assert.rejects(run(listing(new Map())), /the lister listed 0 deposits and 0 releases \(0 label and 0 state leaves\), but rpc 0's pages hold 7 state and 5 label leaves/);
  // short pages on both RPCs (the pool before the last deposit and release), every mark listed: refused
  const short: Chain = { ...afterSpend, marks: chain.marks!, slot: chain.slot };
  await assert.rejects(run(lister(chain), [noGpa(short, "https://a.example"), noGpa(short, "https://b.example")]), /the lister listed 5 deposits and 2 releases \(5 label and 7 state leaves\), but rpc 0's pages hold 5 state and 4 label leaves and rpc 1's hold 5 state and 4 label leaves$/);
  // a listed account with no record the program wrote (a zero-filled one of a mark's size, which anyone can make): passed
  // over, never counted, as sol-marks-scale's RV-B1 holds (an honest lister's memcmp holds the tag, so this one adds it to
  // its first precommitment bucket itself); one whose first 8 bytes are not 0 but has no tag is refused
  const zeroed = new Map(chain.marks!);
  zeroed.set(fake, new Uint8Array(PRE_LEN));
  const both = { ...chain, marks: zeroed };
  const plain = lister(chain);
  const adds: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    const r = (await plain(m, p)) as { value: { pubkey: string }[] };
    const f = (p[1] as { filters: [{ dataSize: number }, { memcmp: { bytes: string } }] }).filters;
    if (f[0].dataSize === PRE_LEN && base58.decode(f[1].memcmp.bytes)[0] === 0) r.value.push({ pubkey: fake });
    return r;
  }, { url: "https://l.example" });
  const js = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? `${v}` : v));
  assert.equal(js(await run(adds, [noGpa(both, "https://a.example"), noGpa(both, "https://b.example")])), js(await run(lister(chain))));
  const untagged = markData(1_000_000n, 99n);
  untagged[PRE_LEN - 1] = 0;
  zeroed.set(fake, untagged);
  await assert.rejects(run(adds, [noGpa(both, "https://a.example"), noGpa(both, "https://b.example")]), new RegExp(`^Error: listed mark ${fake}: no record the program wrote$`));
});

// review of exit-pool-notes, P1-1: with a lister, each RPC's own pages must count the listed marks, so a lister and one
// RPC working together cannot roll the pool back past a release (the shared part of the two RPCs' pages hid it)
const listedCounts = (d: number, r: number, a: [number, number], b: [number, number]) =>
  new RegExp(`^Error: restore: the lister listed ${d} deposits and ${r} releases \\(${d} label and ${d + r} state leaves\\), but rpc 0's pages hold ${a[0]} state and ${a[1]} label leaves and rpc 1's hold ${b[0]} state and ${b[1]} label leaves$`);

test("listed restore refuses a lister and one RPC rolling the pool back past a release; the other RPC's pages count it", async () => {
  const { beforeSpend, afterSpend } = restorePool();
  // rpc a claims afterSpend's slot but serves beforeSpend's pages and marks, and lists them; rpc b is honest
  const liar: Chain = { ...beforeSpend, slot: afterSpend.slot };
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lister(liar), rpcs: [noGpa(liar, "https://a.example"), noGpa(afterSpend, "https://b.example")], gap: 4 }), listedCounts(4, 0, [4, 4], [5, 4]));
  // the same with the honest RPC first
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lister(liar), rpcs: [noGpa(afterSpend, "https://a.example"), noGpa(liar, "https://b.example")], gap: 4 }), listedCounts(4, 0, [5, 4], [4, 4]));
});

test("listed restore refuses a spent mark the lister hides plus one RPC's state page a leaf short; the other RPC's pages count it", async () => {
  const { chain, shortState } = restorePool();
  const userSpent = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const marks = new Map(chain.marks!);
  marks.delete(userSpent);
  const hidden: Chain = { ...chain, marks };
  // the pair reads every listed mark; shortState's state page stops a leaf short (the last release's change)
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lister(hidden), rpcs: pair(shortState, chain), gap: 4 }), exactly(`Error: ${marksAre(5, 1, [6, 5], [7, 5])}`));
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lister(hidden), rpcs: pair(chain, shortState), gap: 4 }), exactly(`Error: ${marksAre(5, 1, [7, 5], [6, 5])}`));
});

test("listed restore refuses one RPC whose label page is one leaf short, every mark listed and its state page whole", async () => {
  const { chain } = restorePool();
  const accounts = new Map(chain.accounts);
  const k1 = solanaPageOf(PROGRAM, 1, 0);
  accounts.set(k1, accounts.get(k1)!.subarray(0, accounts.get(k1)!.length - 72));
  const short: Chain = { ...chain, accounts };
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lister(chain), rpcs: [noGpa(short, "https://a.example"), noGpa(chain, "https://b.example")], gap: 4 }), listedCounts(5, 2, [7, 4], [7, 5]));
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lister(chain), rpcs: [noGpa(chain, "https://a.example"), noGpa(short, "https://b.example")], gap: 4 }), listedCounts(5, 2, [7, 5], [7, 4]));
});

test("listed restore refuses a lister and one RPC hiding an older release and cutting the newest state leaf", async () => {
  const { chain } = restorePool();
  const userSpent = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const marks = new Map(chain.marks!);
  marks.delete(userSpent);
  const accounts = new Map(chain.accounts);
  const k0 = solanaPageOf(PROGRAM, 0, 0);
  accounts.set(k0, accounts.get(k0)!.subarray(0, accounts.get(k0)!.length - 72));
  const liar: Chain = { ...chain, accounts, marks };
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lister(liar), rpcs: [noGpa(liar, "https://a.example"), noGpa(chain, "https://b.example")], gap: 4 }), /restore: the lister listed 5 deposits and 1 releases|the listed releases' numbers are not 0 to 0/);
});

test("listed restore refuses counters with a hole: release numbers 0 to R - 1 and deposit nonces 1 to D, each once", async () => {
  const { chain } = restorePool();
  const run = (c: Chain) => solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lister(c), rpcs: [noGpa(c, "https://a.example"), noGpa(c, "https://b.example")], gap: 4 });
  const other = solanaMarkOf(PROGRAM, "spent", 12345n);
  const spentHole = new Map(chain.marks!);
  spentHole.set(other, spentData(20_000_000n, 5));
  await assert.rejects(run({ ...chain, marks: spentHole }), /^Error: restore: the listed releases' numbers are not 0 to 1$/);
  const stranger = solanaMarkOf(PROGRAM, "pre", big(R.deposits[0]!.precommitment));
  const preHole = new Map(chain.marks!);
  preHole.set(stranger, markData(20_000_000n, 9n));
  await assert.rejects(run({ ...chain, marks: preHole }), /^Error: restore: the listed deposits' nonces are not 1 to 5$/);
});

test("listed restore refuses a lister or an RPC breaking a mark's rules: its bucket, its counter, listed twice, a low slot, a foreign owner", async () => {
  const { chain } = restorePool();
  const fake = base58.encode(new Uint8Array(32).fill(9));
  const run = (l: SolanaRpc, c: Chain = chain, a?: SolanaRpc) => solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: l, rpcs: [a ?? noGpa(c, "https://a.example"), noGpa(c, "https://b.example")], gap: 4 });
  // the lister's answer to the first precommitment bucket, changed by f
  const listing = (c: Chain, f: (v: { pubkey: string }[]) => void): SolanaRpc => {
    const plain = lister(c);
    return Object.assign(async (m: string, p: readonly unknown[]) => {
      const r = (await plain(m, p)) as { value: { pubkey: string }[] };
      const fl = (p[1] as { filters: [{ dataSize: number }, { memcmp: { bytes: string } }] }).filters;
      if (m === "getProgramAccounts" && fl[0].dataSize === PRE_LEN && base58.decode(fl[1].memcmp.bytes)[0] === 0) f(r.value);
      return r;
    }, { url: "https://l.example" });
  };
  // a real mark of bucket 1 (nonce 300) listed in bucket 0
  const far = { ...chain, marks: new Map([...chain.marks!, [fake, markData(1_000_000n, 300n)]]) };
  await assert.rejects(run(listing(far, (v) => void v.push({ pubkey: fake })), far), new RegExp(`listed mark ${fake}: counter 300 is not in bucket 0`));
  // two marks of one counter (nonce 2)
  const twice = { ...chain, marks: new Map([...chain.marks!, [fake, markData(1_000_000n, 2n)]]) };
  await assert.rejects(run(lister(twice), twice), /listed mark \S+: counter 2 is mark \S+'s/);
  // one address listed twice in one answer
  await assert.rejects(run(listing(chain, (v) => void v.push(v[0]!))), /lister: mark \S+ listed twice/);
  // an RPC answering a listed mark's read at a slot below the one asked
  const low: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    const r = (await noGpa(chain, "https://a.example")(m, p)) as { context: { slot: number } };
    const min = (p[1] as { minContextSlot?: number }).minContextSlot;
    if (m === "getMultipleAccounts" && min !== undefined && (p[0] as string[]).some((x) => chain.marks!.has(x))) r.context.slot = min - 1;
    return r;
  }, { url: "https://a.example" });
  await assert.rejects(run(lister(chain), chain, low), /rpc 0: getMultipleAccounts: not one account per listed mark at or past slot 700/);
  // a lister answering at a slot below the one asked (the pages' slot): its list may be short of the pages, refused
  const plainLister = lister(chain);
  const lowLister: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    const r = (await plainLister(m, p)) as { context: { slot: number } };
    const min = (p[1] as { minContextSlot?: number }).minContextSlot;
    if (min !== undefined) r.context.slot = min - 1;
    return r;
  }, { url: "https://l.example" });
  await assert.rejects(run(lowLister), /^Error: lister: getProgramAccounts: answered at slot 699, below 700$/);
  // an RPC behind the lister's slot is asked for the lister's slot, and refuses
  await assert.rejects(run(lister({ ...chain, slot: 900 })), /Minimum context slot has not been reached: 700 < 900/);
  // a listed mark another program owns on one RPC
  const foreign: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    const r = (await noGpa(chain, "https://a.example")(m, p)) as { value: ({ owner: string } | null)[] };
    if (m === "getMultipleAccounts") (p[0] as string[]).forEach((x, i) => chain.marks!.has(x) && r.value[i] && (r.value[i]!.owner = FEE_PAYER));
    return r;
  }, { url: "https://a.example" });
  await assert.rejects(run(lister(chain), chain, foreign), /rpc 0: listed mark \S+: not the program's account/);
});

test("listed restore asks the lister for the pages' slot: a lister behind them catches up instead of listing short", async () => {
  const { beforeSpend, afterSpend } = restorePool();
  const honest = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(afterSpend, afterSpend), gap: 4 });
  // the lister answers at 697 unless asked for a later slot, then at 699 (as an RPC answers minContextSlot once it reaches it)
  const behind = lister(beforeSpend);
  const ahead = lister(afterSpend);
  const lagging: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => (((p[1] as { minContextSlot?: number }).minContextSlot ?? 0) > beforeSpend.slot ? ahead : behind)(m, p), { url: "https://l.example" });
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lagging, rpcs: [noGpa(afterSpend, "https://a.example"), noGpa(afterSpend, "https://b.example")], gap: 4 });
  const js = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? `${v}` : v));
  assert.equal(js(r), js(honest));
});

test("listed restore past one bucket: 300 deposits listed in two buckets, each mark read once on each RPC across rounds", async () => {
  const state: { leaf: bigint; t: bigint }[] = [];
  const labels: { leaf: bigint; t: bigint }[] = [];
  const marks = new Map<string, Uint8Array>();
  for (let n = 1n; n <= 300n; n++) {
    const label = vaultLabelOf(keccak_256, SCOPE, n);
    const P = 10_000n + n;
    labels.push({ leaf: label, t: 1_800_000_000n + n });
    state.push({ leaf: noteCommitment(1_000_000n, label, P), t: 1_800_000_000n + n });
    marks.set(solanaMarkOf(PROGRAM, "pre", P), markData(1_000_000n, n));
  }
  const c: Chain = { accounts: new Map([...pages(0, entries(state)), ...pages(1, entries(labels))]), slot: 700, time: () => 1_800_001_000n, marks };
  const reads = [0, 0];
  const counting = (k: number, url: string): SolanaRpc => {
    const r = noGpa(c, url);
    return Object.assign(async (m: string, p: readonly unknown[]) => {
      if (m === "getMultipleAccounts") reads[k]! += (p[0] as string[]).filter((x) => marks.has(x)).length;
      return r(m, p);
    }, { url });
  };
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lister(c), rpcs: [counting(0, "https://a.example"), counting(1, "https://b.example")], gap: 4 });
  assert.equal(r.notes.length, 0);
  assert.deepEqual(reads, [300, 300], "a mark never changes: each is read once on each RPC, however many rounds");
});

test("restore refuses two RPCs whose marks differ, a mark whose nonce is not its label, and a mark not in the state tree", async () => {
  const { chain, P } = restorePool();
  const key = solanaMarkOf(PROGRAM, "pre", P({ kind: "deposit", s: SCOPE, i: 9 }));
  const edit = (f: (m: Map<string, Uint8Array>) => void): Chain => {
    const m = new Map(chain.marks!);
    f(m);
    return { ...chain, marks: m };
  };
  // a key both RPCs hold with different bytes, a pre mark (another value at its own nonce) or a spent mark
  const nonce9 = new DataView(chain.marks!.get(key)!.buffer).getBigUint64(8, true);
  const other = edit((m) => m.set(key, markData(10_000_001n, nonce9)));
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, other), gap: 4 }), /bytes differ/);
  // the nonce of another deposit: on both RPCs that counter is the other deposit's mark's (sol-marks-scale fold 1,
  // review S3: a counter is one mark's); on one, the two RPCs' bytes differ
  const taken = edit((m) => m.set(key, markData(10_000_000n, 4n)));
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, taken), gap: 4 }), /listed mark \S+: the two RPCs' bytes differ$/);
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(taken, taken), gap: 4 }), /counter 4 is mark \S+'s$/);
  const spentKey = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(edit((m) => m.set(spentKey, spentData(40_000_000n, 0))), chain), gap: 4 }), /bytes differ/);
  // a spent mark that withdrew more than the note held, or nothing: withdrawn 0 is no mark (a stranger's zeroed account,
  // sol-marks-scale fold 1, review S1), passed over, so the pages hold a release's leaf with no mark and the leaf count
  // refuses
  for (const [w, re] of [[50_000_001n, /its spent mark withdrew/], [0n, exactly(`Error: ${marksAre(5, 1, [7, 5], [7, 5])}`)]] as const) await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(...[edit((m) => m.set(spentKey, spentData(w, 0)))].flatMap((c) => [c, c]) as [Chain, Chain]), gap: 4 }), re);
  // a mark of a size the program never writes, as both RPCs read it by its address
  const reads = (f: (x: { data: [string, string]; owner: string }) => void, which: readonly number[] = [0, 1]): [SolanaRpc, SolanaRpc] => pair(chain, chain).map((r, k) => Object.assign(async (m: string, p: readonly unknown[]) => {
    const a = (await r(m, p)) as { value?: ({ data: [string, string]; owner: string } | null)[] };
    if (m === "getMultipleAccounts" && which.includes(k)) (p[0] as string[]).forEach((x, i) => chain.marks!.has(x) && a.value![i] && f(a.value![i]!));
    return a;
  }, { url: r.url })) as [SolanaRpc, SolanaRpc];
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: reads((x) => void (x.data = [base64.encode(new Uint8Array(3)), "base64"])), gap: 4 }), /^Error: listed mark \S+: not (13|17) bytes$/);
  // both RPCs: another value (not in the state tree)
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(other, other), gap: 4 }), /commitment is not in the state tree/);
  // a mark of value 0 or nonce 0, which the program never writes (R11): value 0 is no mark (a stranger's zeroed account,
  // sol-marks-scale fold 1, review S1), passed over, so the pages hold a deposit's leaves with no mark and the leaf count
  // refuses; nonce 0 is no deposit's counter, refused at its read
  for (const [z, re] of [[markData(0n, 3n), exactly(`Error: ${marksAre(4, 2, [7, 5], [7, 5])}`)], [markData(10_000_000n, 0n), /counter 0 is not in bucket 0/]] as const) {
    const c = edit((m) => m.set(key, z));
    await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(c, c), gap: 4 }), re);
  }
  // the lister names a mark twice (R2); one RPC reads a listed mark as an account of another program (R3)
  const twice: [SolanaRpc, SolanaRpc] = pair(chain, chain).map((r) => Object.assign(async (m: string, p: readonly unknown[]) => {
    const a = (await r(m, p)) as { value?: { pubkey: string }[] };
    if (m === "getProgramAccounts" && a.value!.length > 0) a.value!.push(a.value![0]!);
    return a;
  }, { url: r.url })) as [SolanaRpc, SolanaRpc];
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: twice, gap: 4 }), /^Error: lister: mark \S+ listed twice$/);
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: reads((x) => void (x.owner = FEE_PAYER), [1]), gap: 4 }), /^Error: rpc 1: listed mark \S+: not the program's account$/);
  // a nonce past every deposit's on both RPCs: the counters are not 1 to D, refused before the walk (card exit-pool-notes)
  const far = edit((m) => m.set(key, markData(10_000_000n, 99n)));
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(far, far), gap: 4 }), /^Error: restore: the listed deposits' nonces are not 1 to 5$/);
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

test("RV5 inverted: one RPC a slot behind, lacking a mark the other has, catches up to the lister's slot and every note restores; one of the pair lacking a listed mark at an equal or later slot is refused, and so is a lister hiding one", async () => {
  const { chain, P } = restorePool();
  const edit = (f: (m: Map<string, Uint8Array>) => void, slot: number): Chain => { const m = new Map(chain.marks!); f(m); return { ...chain, slot, marks: m }; };
  const noSpent = (slot: number) => edit((m) => m.delete(solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash)), slot);
  const noOurs = (slot: number) => edit((m) => m.delete(solanaMarkOf(PROGRAM, "pre", P({ kind: "deposit", s: SCOPE, i: 9 }))), slot);
  // a node a slot behind: its first marks read lacks the mark; asked past the other's slot, it answers caught up
  const behind = (c: Chain, url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => rpc((p[1] as { minContextSlot?: number } | undefined)?.minContextSlot === undefined ? c : chain, MAINNET)(m, p), { url });
  const ahead = (url: string): SolanaRpc => rpc(chain, { ...MAINNET, url });
  for (const lag of [noSpent(chain.slot - 1), noOurs(chain.slot - 1)])
    for (const rs of [[behind(lag, "https://a.example"), ahead("https://b.example")], [ahead("https://a.example"), behind(lag, "https://b.example")]] as [SolanaRpc, SolanaRpc][]) {
      const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: rs, gap: 4 });
      assert.equal(r.notes.length, 5);
      assert.equal(r.spends.length, 1);
    }
  // the user's spend lands between the two RPCs' slots, the lister the RPC ahead: the one behind reads its mark once it
  // catches up to the lister's slot
  const { beforeSpend } = restorePool();
  for (const ahead of [0, 1] as const) {
    const at = (sl: number): Chain => ({ ...(sl >= 702 ? chain : beforeSpend), slot: sl });
    const rs: [SolanaRpc, SolanaRpc] = [skewRpc("https://a.example", ahead === 0 ? 0 : 1, at, []), skewRpc("https://b.example", ahead === 1 ? 0 : 1, at, [])];
    const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lagWait: instant, lister: rs[ahead], rpcs: rs, gap: 4 });
    assert.equal(js(r), js(await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain), gap: 4 })), `rpc ${ahead} ahead`);
  }
  // one of the pair lacking a listed mark at the lister's slot or past it: no mark is ever closed, so it lies
  for (const rs of [pair(chain, noOurs(chain.slot)), pair(noSpent(chain.slot - 1), noOurs(chain.slot - 1)), pair(chain, noSpent(chain.slot + 1))])
    await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: rs, gap: 4 }), /^Error: rpc 1: listed mark \S+ is not on it$/);
  // the lister (rpcs[0]) hiding a mark both pages count: the counts refuse
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(noSpent(chain.slot), chain), gap: 4 }), exactly(`Error: ${marksAre(5, 1, [7, 5], [7, 5])}`));
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(noOurs(chain.slot), chain), gap: 4 }), exactly(`Error: ${marksAre(4, 2, [7, 5], [7, 5])}`));
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
  marks.set(solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash), spentData(50_000_000n, 0));
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
    [solanaMarkOf(PROGRAM, "spent", nh(dep)), spentData(20_000_000n, 0)],
    [solanaMarkOf(PROGRAM, "spent", nh(c0)), spentData(30_000_000n, 1)],
  ]);
  const chain: Chain = { accounts: new Map([...pages(0, state), ...pages(1, entries([{ leaf: label, t: 1_800_000_000n }]))]), slot: 700, time: () => 1_800_000_100n, marks };
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain), gap: 4 });
  assert.deepEqual(r.notes.map((n) => [n.ref.kind, n.state, n.leaf.value, n.leaf.leafIndex]), [["deposit", "SPENT", 50_000_000n, 0n], ["change", "SPENT", 30_000_000n, 1n], ["change", "UNSPENT", 0n, 2n]]);
  const w = (j: number) => { const x = d.freshWallet(SEED, "sol", label, j); x.secretKey.fill(0); return x.address; };
  assert.deepEqual(r.spends.map((s) => [s.j, s.withdrawn, s.w]), [[0, 20_000_000n, w(0)], [1, 30_000_000n, w(1)]]);
});

test("RV7: two honest RPCs at different finalized slots still restore, and the pages are read at the higher marks slot", async () => {
  const { chain, withDeposit } = restorePool();
  // RPC a is ahead: someone else's deposit landed between the two RPCs' finalized slots
  const ahead: Chain = withDeposit(777n, 10_000_000n, chain.slot + 3);
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
  // an RPC that ignores minContextSlot and answers from its own lower slot is refused by the device all the same, at its
  // first read (the listed marks')
  const deaf: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m !== "getMultipleAccounts") return rpc(chain, MAINNET)(m, p);
    const { minContextSlot: _, ...cfg } = p[1] as { minContextSlot?: number };
    return rpc(chain, MAINNET)(m, [p[0], cfg]);
  }, { url: "https://b.example" });
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: [rpc(ahead, { ...MAINNET, url: "https://a.example" }), deaf], gap: 4 }), new RegExp(`^Error: rpc 1: getMultipleAccounts: not one account per listed mark at or past slot ${chain.slot + 3}$`));
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
  const marks = { pre: new Map([[solanaMarkOf(PROGRAM, "pre", P), { value: 10_000_000n, nonce: 1n }]]), spent: new Map<string, SolanaSpentMark>(), slot: 1 };
  assert.equal(solanaRestore({ seed64: SEED, program: PROGRAM, scope: SCOPE, stateLeaves: [c], labelLeaves: [label], marks, gap: 2 }).notes.length, 1);
  assert.throws(() => solanaRestore({ seed64: SEED, program: PROGRAM, scope: SCOPE, stateLeaves: [c, c], labelLeaves: [label], marks, gap: 2 }), /state leaf 1 repeats/);
});

test("sol-marks-scale fold 1 R11: solanaRestore refuses a deposit mark of value 0 or nonce 0 handed to it directly (the marks read passes over the first and refuses the second)", () => {
  const P = noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).precommitment;
  const label = vaultLabelOf(keccak_256, SCOPE, 1n);
  for (const m of [{ value: 0n, nonce: 1n }, { value: 10_000_000n, nonce: 0n }]) {
    const marks = { pre: new Map([[solanaMarkOf(PROGRAM, "pre", P), m]]), spent: new Map<string, SolanaSpentMark>(), slot: 1 };
    assert.throws(() => solanaRestore({ seed64: SEED, program: PROGRAM, scope: SCOPE, stateLeaves: [noteCommitment(m.value, label, P)], labelLeaves: [label], marks, gap: 2 }), /its mark's nonce \d+ is not a label tree leaf/);
  }
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
// The lister's getProgramAccounts calls in one marks read: one bucket of each size (every pool here holds fewer than 256
// marks of a size). Only the lister lists; the pair reads each listed mark by its address.
const MARKS_CALLS = 2;
// Two RPCs on one chain that moves on: the first `after` getProgramAccounts calls (the lister's, rpcs[0]) see chains[0],
// the next `after` see chains[1], and so on (the last stays); every other read sees the chain of the latest call, so the
// listed marks and the pages are always read after the list they follow.
function movingPair(chains: readonly Chain[] | ((i: number) => Chain), after = MARKS_CALLS, log: { m: string; min?: number; url: string }[] = []): [SolanaRpc, SolanaRpc] {
  let reads = 0;
  const at = (n: number): Chain => (typeof chains === "function" ? chains(Math.floor(n / after)) : chains[Math.min(Math.floor(n / after), chains.length - 1)]!);
  const mk = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    log.push({ m, url, ...((p[1] as { minContextSlot?: number } | undefined)?.minContextSlot === undefined ? {} : { min: (p[1] as { minContextSlot: number }).minContextSlot }) });
    return rpc(m === "getProgramAccounts" ? at(reads++) : at(Math.max(0, reads - 1)), MAINNET)(m, p);
  }, { url });
  return [mk("https://a.example"), mk("https://b.example")];
}

// Two RPCs on a scripted chain: pick(method, n) is the chain a call sees, n the getProgramAccounts calls (the lister's)
// made before it, this one included for a list call.
type RLog = { m: string; url: string; min?: number; slot: number };
// a restore that reads the marks more than SCRIPTED_READS times (MARKS_CALLS calls a read) ends in another error, so a
// loop that never walks fails its test, never spins to its timeout (fold 8: M7); each script here walks by its third read
const SCRIPTED_READS = 16;
function scripted(pick: (m: string, n: number) => Chain, log: RLog[] = []): [SolanaRpc, SolanaRpc] {
  let n = 0;
  const mk = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m === "getProgramAccounts" && n >= MARKS_CALLS * SCRIPTED_READS) throw new Error("RPC error -32005: the fake's reads ran past SCRIPTED_READS");
    const c = m === "getProgramAccounts" ? pick(m, n++) : pick(m, n);
    const min = (p[1] as { minContextSlot?: number } | undefined)?.minContextSlot;
    log.push({ m, url, slot: c.slot, ...(min === undefined ? {} : { min }) });
    return rpc(c, MAINNET)(m, p);
  }, { url });
  return [mk("https://a.example"), mk("https://b.example")];
}
const js = (x: unknown): string => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

test("N1 race (the review's P1): first marks from before the spend, pages from after it: SPENT, with its change", { timeout: 20_000 }, async () => {
  const { chain, beforeSpend, l0 } = restorePool();
  const base = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain), gap: 4 });
  const log: RLog[] = [];
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: scripted((m, n) => (m === "getProgramAccounts" && n < MARKS_CALLS ? beforeSpend : chain), log), gap: 4 });
  assert.ok(log.filter((x) => x.m === "getMultipleAccounts").slice(0, 2).every((x) => x.slot === chain.slot), "the first pages hold the spend's change leaf");
  const d0 = r.notes.find((n) => n.ref.kind === "deposit" && n.leaf.value === 50_000_000n)!;
  assert.equal(d0.state, "SPENT", "the spend landed while the restore read: its note must not come back UNSPENT");
  assert.ok(r.notes.some((n) => n.ref.kind === "change" && n.leaf.label === l0), "its change note");
  assert.equal(js(r), js(base));
  // only the spent mark and its change leaf land (no deposit with them): a new spent mark alone is a new mark
  const { afterSpend } = restorePool();
  const only = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: scripted((m, n) => (m === "getProgramAccounts" && n < MARKS_CALLS ? beforeSpend : afterSpend)), gap: 4 });
  assert.equal(js(only), js(await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(afterSpend, afterSpend), gap: 4 })));
  assert.equal(only.notes.find((n) => n.ref.kind === "deposit" && n.leaf.value === 50_000_000n)!.state, "SPENT");
});

// A pool of these deposits, in order, each a second apart (deposit.rs: its mark, its commitment and its label).
// deposits as deposit.rs makes them, then `releases` releases of other users as release.rs makes them (a spent mark and a
// change leaf each)
function depositsChain(list: readonly (readonly [bigint, bigint])[], slot: number, releases = 0): Chain {
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
  for (let k = 1; k <= releases; k++) {
    marks.set(solanaMarkOf(PROGRAM, "spent", BigInt(770_000 + k)), spentData(1n, k - 1)); // release k is the pool's k-th: k - 1 releases before it
    state.push({ leaf: BigInt(990_000 + k), t: (t += 1n) });
  }
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

test("N1 rounds: the user's own marks landing on every read for a while: the restore reads on as the chain moves, then walks once at the first read with no new mark, with every arrival", { timeout: 20_000 }, async () => {
  // reads 1..n each see one more second arrival of U_{s,0}: the very mark the walk looks up as its miss
  const own = memo((i) => depositsChain([...OURS, ...Array.from({ length: i }, (_, n) => U(n + 1))], 700 + i));
  for (const n of [1, Q, 3 * Q]) {
    const log: { m: string }[] = [];
    const settled = memo((i) => own(Math.min(i, n)));
    const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: movingPair(settled, MARKS_CALLS, log as never), gap: 4 });
    assert.equal(gpaCalls(log), MARKS_CALLS * (n + 2), "the first read, n reads with a new mark, then the read with none");
    assert.equal(js(r), js(await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(own(n), own(n)), gap: 4 })));
    assert.ok(r.notes.some((x) => x.ref.kind === "second" && x.ref.n === n), "the last arrival, landed during the read");
  }
});

test("N1 rounds: other users' marks only make the restore read on: the result is the same, and the reads are the same whoever's marks land", { timeout: 20_000 }, async () => {
  const busyFor = (k: number) => memo((i) => depositsChain([...OURS, ...Array.from({ length: Math.min(i, k) }, (_, n) => [BigInt(9_000 + n), 10_000_000n] as const)], 700 + Math.min(i, k)));
  for (const k of [1, 3, Q, 3 * Q]) {
    const log: { m: string }[] = [];
    const busy = busyFor(k);
    const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: movingPair(busy, MARKS_CALLS, log as never), gap: 4 });
    // k reads with new marks, then the read with none; the walk runs on the marks of read k
    assert.equal(gpaCalls(log), MARKS_CALLS * (k + 2), String(k));
    assert.equal(js(r), js(await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(busy(k), busy(k)), gap: 4 })), String(k));
  }
});

test("N1 privacy (the review's P3): whether the mark that lands during the read is the user's own never changes the reads", async () => {
  const c0 = depositsChain(OURS, 700);
  const other = depositsChain([...OURS, [424242n, 10_000_000n]], 701); // another user's deposit
  const own = depositsChain([...OURS, U(1)], 701); // the user's own second arrival on U_{s,0}
  const pattern = async (next: Chain): Promise<string[]> => {
    const log: RLog[] = [];
    await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: scripted((_m, n) => (n < MARKS_CALLS ? c0 : next), log), gap: 4 });
    return log.map((x) => `${x.url}:${x.m}:${x.min ?? ""}`);
  };
  assert.deepEqual(await pattern(own), await pattern(other));
});

test("N1 round 2 (MX5): the pages are read again at or past the merged marks' slot, never at the first read's", async () => {
  // a node that serves the pages from before the spend unless asked for slot 700 or later
  const { chain, beforeSpend } = restorePool();
  const base = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain), gap: 4 });
  const lagging = (m: string, n: number, min?: number): Chain => (m === "getProgramAccounts" ? (n < MARKS_CALLS ? beforeSpend : chain) : (min ?? 0) >= chain.slot ? chain : beforeSpend);
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
  // a lag for the whole budget: SOL_LAG_SLOTS waits of a slot, one call more, then the last -32016 as it came
  const budget = [...Array.from({ length: SOL_LAG_SLOTS }, () => ["call", "wait 400"]).flat(), "call"];
  assert.deepEqual(await run([...Array.from({ length: SOL_LAG_SLOTS + 1 }, lag), "never"]), { steps: budget, out: "threw RPC error -32016" });
  assert.deepEqual(await run([...Array.from({ length: SOL_LAG_SLOTS }, lag), "ok"]), { steps: budget, out: "ok" });
  assert.equal(SOL_LAG_SLOTS, 32);
  assert.deepEqual(await run([new Error("RPC error -32005: node is unhealthy")]), { steps: ["call"], out: "threw RPC error -32005" });
  assert.deepEqual(await run(["ok"]), { steps: ["call"], out: "ok" });
  assert.equal(SOL_LAG_WAIT_MS, 400);
});

test("RPC lag: a -32016 answer is tried again a slot apart, SOL_LAG_SLOTS waits at most, then refused", { timeout: 20_000 }, async () => {
  const { chain } = restorePool();
  const base = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain), gap: 4 });
  // a run of lags past the budget's SOL_LAG_SLOTS + 1 calls ends in another error, so a read with no budget fails, never spins
  const flaky = (url: string, every: number, calls: string[]): SolanaRpc => {
    let k = 0, run = 0;
    return Object.assign(async (m: string, p: readonly unknown[]) => {
      calls.push(m);
      if ((p[1] as { minContextSlot?: number } | undefined)?.minContextSlot !== undefined && k++ % every === 0) {
        if (++run > SOL_LAG_SLOTS + 1) throw new Error("RPC error -32005: the fake's lag ran past the budget");
        throw new Error("RPC error -32016: Minimum context slot has not been reached");
      }
      run = 0;
      return rpc(chain, MAINNET)(m, p);
    }, { url });
  };
  // each first call with minContextSlot lags once: the restore holds
  const calls: string[] = [];
  assert.equal(js(await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lagWait: instant, rpcs: [flaky("https://a.example", 2, calls), rpc(chain, { ...MAINNET, url: "https://b.example" })], gap: 4 })), js(base));
  // a node that never reaches the slot: refused after SOL_LAG_SLOTS waits, SOL_LAG_SLOTS + 1 calls of that read
  const stuck: string[] = [];
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lagWait: instant, rpcs: [flaky("https://a.example", 1, stuck), rpc(chain, { ...MAINNET, url: "https://b.example" })], gap: 4 }), /-32016/);
  assert.equal(stuck.filter((m) => m === "getMultipleAccounts").length, SOL_LAG_SLOTS + 1);
  // any other error is never tried again
  let other = 0;
  const broken: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m === "getProgramAccounts") (other++, (() => { throw new Error("RPC error -32005: node is unhealthy"); })());
    return rpc(chain, MAINNET)(m, p);
  }, { url: "https://a.example" });
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lagWait: instant, rpcs: [broken, rpc(chain, { ...MAINNET, url: "https://b.example" })], gap: 4 }), /-32005/);
  // one call, the lister's first bucket, never tried again; no other bucket is asked for after it
  assert.equal(other, 1);
});

test("N1 re-read: the marks are listed again at or past the highest slot either RPC answered its pages at, and a list below it is refused", async () => {
  const { chain } = restorePool();
  const log: { m: string; min?: number; url: string }[] = [];
  // the lister's first list at 705 and b's own at 701, when asked for no slot; asked for a slot, each answers at its own
  // later slot, 708 and 706, or at the one asked once it reaches it (as an RPC answers minContextSlot)
  const spy = (markSlot: number, pageSlot: number, url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    const min = (p[1] as { minContextSlot?: number } | undefined)?.minContextSlot;
    log.push({ m, url, ...(min === undefined ? {} : { min }) });
    return rpc({ ...chain, slot: m === "getProgramAccounts" && min === undefined ? markSlot : Math.max(pageSlot, min ?? 0) }, MAINNET)(m, p);
  }, { url });
  await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: [spy(705, 708, "https://a.example"), spy(701, 706, "https://b.example")], gap: 4 });
  const again = log.filter((x) => x.m === "getProgramAccounts").slice(MARKS_CALLS);
  assert.deepEqual(again.map((x) => [x.url, x.min]), [["https://a.example", 708], ["https://a.example", 708]]);
  // a lister that ignores minContextSlot and answers from below it is refused, never merged
  const deaf: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m !== "getProgramAccounts") return rpc({ ...chain, slot: 703 }, MAINNET)(m, p);
    const { minContextSlot: _, ...cfg } = p[1] as { minContextSlot?: number };
    return rpc(chain, MAINNET)(m, [p[0], cfg]);
  }, { url: "https://b.example" });
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: deaf, rpcs: [rpc({ ...chain, slot: 703 }, { ...MAINNET, url: "https://a.example" }), deaf], gap: 4 }), /^Error: lister: getProgramAccounts: answered at slot 700, below 703$/);
});

test("N1 union: two reads of one mark with other records are refused (the union rule, M355)", () => {
  const sm = (withdrawn: bigint, number = 0): SolanaSpentMark => ({ withdrawn, number });
  assert.throws(() => solanaMarksUnion({ spent: new Map([["k", sm(1n)]]), pre: new Map(), slot: 1 }, { spent: new Map([["k", sm(2n)]]), pre: new Map(), slot: 2 }), /two reads differ/);
  assert.throws(() => solanaMarksUnion({ spent: new Map([["k", sm(1n, 0)]]), pre: new Map(), slot: 1 }, { spent: new Map([["k", sm(1n, 9)]]), pre: new Map(), slot: 2 }), /two reads differ/, "the release number alone");
  assert.equal(solanaMarksUnion({ spent: new Map([["k", sm(1n)]]), pre: new Map(), slot: 1 }, { spent: new Map([["j", sm(2n)]]), pre: new Map(), slot: 2 }).slot, 2);
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

  // the lister (the helper, which saw the nullifier hash in the send) claims the spent mark: one of the pair lacks it,
  // at the lister's slot or a slot past it (no mark is ever closed); both of the pair hold it, but their pages hold no
  // release. Refused, nothing written
  const spent0 = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const claimed: Chain = { ...beforeSpend, marks: new Map(beforeSpend.marks!).set(spent0, spentData(50_000_000n, 0)) };
  const later: Chain = { ...beforeSpend, slot: beforeSpend.slot + 1 };
  for (const rs of [pair(claimed, beforeSpend), pair(beforeSpend, claimed), pair(claimed, later), pair(later, claimed)]) {
    await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, lister: lister(claimed), rpcs: rs }), new RegExp(`^Error: rpc [01]: listed mark ${spent0} is not on it$`));
    assert.equal((await b.ns.get(b.id))!.state, "RESERVED");
  }
  await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, lister: lister(claimed), rpcs: pair(claimed, claimed) }), exactly(`Error: ${marksAre(4, 1, [4, 4], [4, 4])}`));
  assert.equal((await b.ns.get(b.id))!.state, "RESERVED");
  // a spent mark over the note's value: refused
  const over: Chain = { ...chain, marks: new Map(chain.marks!).set(spent0, spentData(50_000_001n, 0)) };
  await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, rpcs: pair(over, over) }), /withdrew 50000001 of 50000000/);
  assert.equal((await b.ns.list()).length, 1);
  // a change already in the store at another leaf is never taken for this spend
  const cP = noteSecrets(SEED, { kind: "change", l: l0, j: 0 }).precommitment;
  await b.ns.add({ ref: { kind: "change", l: l0, j: 0 }, scope: SCOPE, precommitment: cP, state: "UNSPENT", parent: b.id, leaf: { value: 0n, label: l0, commitment: noteCommitment(0n, l0, cP), leafIndex: 9n } });
  await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, rpcs: pair(chain, chain) }));
  // a note of another pool is refused before any read
  await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: b58(R.pool), rpcs: pair(chain, chain) }), /not a landed note of this pool/);
});

test("a pass over RESERVED notes: spent is settled; no mark and both RPCs' block time past the deadline frees; else it is held", async () => {
  const { chain, beforeSpend, l0 } = restorePool();
  const DEADLINE_S = 1_800_000_200n; // reservedDeposit0's deadline_ms, in the Clock's seconds
  const at = (c: Chain, s: bigint): Chain => ({ ...c, time: () => s });
  const pass = (ns: NoteStore, rs: [SolanaRpc, SolanaRpc]) => solanaSettleReserved({ seed64: SEED, notes: ns, program: PROGRAM, rpcs: rs });
  // the chain holds the spend: settled, SPENT with its change, whatever the time
  const a = await reservedDeposit0(l0);
  assert.deepEqual(await pass(a.ns, pair(at(chain, DEADLINE_S - 100n), at(chain, DEADLINE_S - 100n))), { spent: [a.id], freed: [], held: [] });
  assert.equal((await a.ns.get(a.id))!.state, "SPENT");
  // no mark: held while either RPC's finalized block is not past the deadline (its send may still land), freed after
  const b = await reservedDeposit0(l0);
  for (const [x, y] of [[DEADLINE_S - 1n, DEADLINE_S - 1n], [DEADLINE_S, DEADLINE_S], [DEADLINE_S + 5n, DEADLINE_S], [DEADLINE_S, DEADLINE_S + 5n]] as const) {
    assert.deepEqual(await pass(b.ns, pair(at(beforeSpend, x), at(beforeSpend, y))), { spent: [], freed: [], held: [b.id] }, `${x} ${y}`);
    assert.equal((await b.ns.get(b.id))!.state, "RESERVED");
  }
  // the lister lists a spent mark one RPC shows and the other lacks: held, never freed, though both are past the deadline
  const spent0 = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const claimed: Chain = { ...beforeSpend, marks: new Map(beforeSpend.marks!).set(spent0, spentData(50_000_000n, 0)) };
  for (const [x, y] of [[claimed, beforeSpend], [beforeSpend, claimed]] as const) {
    assert.deepEqual(await solanaSettleReserved({ seed64: SEED, notes: b.ns, program: PROGRAM, lister: lister(claimed), rpcs: pair(at(x, DEADLINE_S + 1n), at(y, DEADLINE_S + 1n)) }), { spent: [], freed: [], held: [b.id] });
    assert.equal((await b.ns.get(b.id))!.state, "RESERVED");
  }
  // both past it, no mark on either: freed, so the queue proves it again
  assert.deepEqual(await pass(b.ns, pair(at(beforeSpend, DEADLINE_S + 1n), at(beforeSpend, DEADLINE_S + 1n))), { spent: [], freed: [b.id], held: [] });
  assert.equal((await b.ns.get(b.id))!.state, "UNSPENT");
  // nothing RESERVED: no read at all
  const quiet: SolanaRpc = Object.assign(async () => assert.fail("no read"), { url: "https://q.example" });
  assert.deepEqual(await pass(b.ns, [quiet, Object.assign(async () => assert.fail("no read"), { url: "https://r.example" })]), { spent: [], freed: [], held: [] });
});

test("a spent mark the lister hides never frees the note: each RPC's own pages must count every listed mark (review P2-1, P1 of 369a87a8)", async () => {
  const { chain, l0, shortState } = restorePool();
  const DEADLINE_S = 1_800_000_200n;
  const at = (c: Chain, s: bigint): Chain => ({ ...c, time: () => s });
  // the chain holds the spend and its change leaf, both RPCs of the pair read every listed mark and agree on the pages,
  // and the lister leaves the spent mark out
  const spent0 = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const marks = new Map(chain.marks!);
  assert.ok(marks.delete(spent0));
  const hidden: Chain = { ...chain, marks };
  const b = await reservedDeposit0(l0);
  await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, lister: lister(hidden), rpcs: pair(chain, chain) }), exactly(`Error: ${marksAre(5, 1, [7, 5], [7, 5])}`));
  assert.deepEqual(await solanaSettleReserved({ seed64: SEED, notes: b.ns, program: PROGRAM, lister: lister(hidden), rpcs: pair(at(chain, DEADLINE_S + 1n), at(chain, DEADLINE_S + 1n)) }), { spent: [], freed: [], held: [b.id] });
  assert.equal((await b.ns.get(b.id))!.state, "RESERVED");
  // and one RPC's state page short by a release's change, so the leaves both agree on count one release fewer: each
  // RPC's own counts are held to the marks, never the shorter agreed part (review P2-1 with exit-pool-notes P1-1)
  for (const [rs, counts] of [[pair(at(chain, DEADLINE_S + 1n), at(shortState, DEADLINE_S + 1n)), [[7, 5], [6, 5]]], [pair(at(shortState, DEADLINE_S + 1n), at(chain, DEADLINE_S + 1n)), [[6, 5], [7, 5]]]] as const) {
    await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, lister: lister(hidden), rpcs: rs }), exactly(`Error: ${marksAre(5, 1, counts[0], counts[1])}`));
    assert.deepEqual(await solanaSettleReserved({ seed64: SEED, notes: b.ns, program: PROGRAM, lister: lister(hidden), rpcs: rs }), { spent: [], freed: [], held: [b.id] });
    assert.equal((await b.ns.get(b.id))!.state, "RESERVED");
  }
});

// review P1 of 369a87a8: on mainnet the helper served both getProgramAccounts answers, so it could hide a spent mark and
// give its exact record under a made-up address: the counts held, and the note was freed. Now the helper only lists, and
// every listed address is read on the pair, one of which (publicnode) is not ours.
test("both mark routes swap the user's spent mark for a made-up address with the same record: never unspent", async () => {
  const { chain, l0 } = restorePool();
  const DEADLINE_S = 1_800_000_200n;
  const at = (c: Chain, s: bigint): Chain => ({ ...c, time: () => s });
  const spent0 = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const fake = base58.encode(new Uint8Array(32).fill(9));
  const marks = new Map(chain.marks!);
  const record = marks.get(spent0)!;
  assert.ok(marks.delete(spent0));
  marks.set(fake, record);
  const forged: Chain = { ...chain, marks };
  const forger = rpc(forged, { ...MAINNET, url: "https://l.example" });
  // the pair: both honest, or the second with the helper (it holds the made-up account too)
  for (const [name, x, y] of [["an honest pair", chain, chain], ["one of the pair with the helper", chain, forged]] as const) {
    const b = await reservedDeposit0(l0);
    await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, lister: forger, rpcs: pair(x, y) }), new RegExp(`^Error: rpc 0: listed mark ${fake} is not on it$`), name);
    assert.deepEqual(await solanaSettleReserved({ seed64: SEED, notes: b.ns, program: PROGRAM, lister: forger, rpcs: pair(at(x, DEADLINE_S + 1n), at(y, DEADLINE_S + 1n)) }), { spent: [], freed: [], held: [b.id] }, name);
    assert.equal((await b.ns.get(b.id))!.state, "RESERVED", name);
    await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: forger, rpcs: pair(x, y), gap: 4 }), new RegExp(`^Error: rpc 0: listed mark ${fake} is not on it$`), name);
  }
});

test("already spent (MX6): the settle reads the pages at or past its marks' slot, and reads them whether or not the mark is there", async () => {
  const { chain, beforeSpend, l0 } = restorePool();
  // a node that serves the pages from before the spend unless asked for the marks' slot or later
  const log: string[] = [];
  const lagging = (c: Chain, url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    const min = (p[1] as { minContextSlot?: number } | undefined)?.minContextSlot;
    log.push(m);
    return rpc(m === "getProgramAccounts" || (min ?? 0) >= c.slot ? c : beforeSpend, MAINNET)(m, p);
  }, { url });
  const a = await reservedDeposit0(l0);
  assert.equal((await solanaSettleSpent({ seed64: SEED, notes: a.ns, noteId: a.id, program: PROGRAM, rpcs: [lagging(chain, "https://a.example"), lagging(chain, "https://b.example")] })).kind, "spent");
  const spentReads = [...log];
  // the same reads when the chain holds no spend of the note: the same pool, its release another user's
  log.length = 0;
  const spent0 = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const others: Chain = { ...chain, marks: new Map([...chain.marks!].map(([k, v]) => [k === spent0 ? solanaMarkOf(PROGRAM, "spent", 4242n) : k, v])) };
  const b = await reservedDeposit0(l0);
  assert.equal((await solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, rpcs: [lagging(others, "https://a.example"), lagging(others, "https://b.example")] })).kind, "unspent");
  assert.deepEqual(log, spentReads);
});

// ---------------------------------------------------------------------------------------------- fold 3 (re-check)
// One RPC on its own script. clock, shared by the pair (and a lister of its own), counts the marks reads: each list's
// first call (the spent marks' bucket 0) moves it on. As the lister, its list in read i sees marksAt(i); its other reads
// (a listed mark's, the pages) after read i's list starts see pagesAfter(i). Logs every call.
type Clock = { i: number };
const newClock = (): Clock => ({ i: -1 });
function perRpc(url: string, marksAt: (i: number) => Chain, pagesAfter: (i: number) => Chain, log: string[], clock: Clock): SolanaRpc {
  return Object.assign(async (m: string, p: readonly unknown[]) => {
    log.push(`${url}:${m}`);
    if (m === "getProgramAccounts") {
      const f = (p[1] as { filters: [{ dataSize: number }, { memcmp: { bytes: string } }] }).filters;
      if (f[0].dataSize === SPENT_LEN && base58.decode(f[1].memcmp.bytes)[0] === 0) clock.i++;
      return rpc(marksAt(clock.i), MAINNET)(m, p);
    }
    return rpc(pagesAfter(Math.max(0, clock.i)), MAINNET)(m, p);
  }, { url });
}
const FOREIGN = (k: number): readonly [bigint, bigint] => [BigInt(5_000_000 + k), 10_000_000n];
const junkKey = (k: number): string => solanaMarkOf(PROGRAM, "pre", BigInt(880_000 + k));
// a made-up deposit mark at a nonce no deposit holds (200 + k, past every pool here): a made-up mark at a held nonce is
// refused at its read (a counter is one mark's, sol-marks-scale fold 1), so this one tests the never-closed rule
const junkData = (k: number): Uint8Array => markData(1n, BigInt(200 + k));
// RPC b's chain with a mark of its own making added to every read (never looked up by any walk)
const withJunk = (c: (i: number) => Chain) => (i: number): Chain => {
  const ch = c(i);
  const marks = new Map(ch.marks!);
  for (let k = 1; k <= i; k++) marks.set(junkKey(k), junkData(k));
  return { ...ch, marks };
};

// An honest RPC `who` on one chain (review round 3): 0 is a; 1 is b, steadily one slot behind a. As the lister, its list
// of read i answers at slot 700 + 2i - who. Its reads after list call c (a listed mark's or the pages): at its own slot
// for read floor((c - 1) / 2), or, when that is below the read's minContextSlot, -32016 once (solanaLagRetry tries again)
// and then at minContextSlot (it caught up during the wait). One of the pair that never lists stays at read 0's slot, so
// it lags once and then answers at each slot the lister's reads ask for.
function skewRpc(url: string, who: 0 | 1, chainAt: (slot: number) => Chain, log: string[]): SolanaRpc {
  let gpa = 0;
  const lagged = new Set<number>();
  const tag = url.slice(8, 9);
  return Object.assign(async (m: string, p: readonly unknown[]) => {
    const min = (p[1] as { minContextSlot?: number } | undefined)?.minContextSlot ?? 0;
    if (m === "getProgramAccounts") {
      const i = Math.floor(gpa++ / 2);
      const slot = 700 + 2 * i - who;
      if (slot < min) throw new Error("RPC error -32016: Minimum context slot has not been reached");
      log.push(`${tag}:marks@${slot}`);
      return rpc(chainAt(slot), MAINNET)(m, p);
    }
    const i = Math.max(0, Math.floor((gpa - 1) / 2));
    let slot = 700 + 2 * i - who;
    if (slot < min) {
      if (!lagged.has(i)) {
        lagged.add(i);
        log.push(`${tag}:pages -32016`);
        throw new Error("RPC error -32016: Minimum context slot has not been reached");
      }
      slot = min;
    }
    log.push(`${tag}:pages@${slot}`);
    return rpc(chainAt(slot), MAINNET)(m, p);
  }, { url });
}
// A pool where foreign deposit k lands at landing[k]'s slot (sorted), the user's own OURS before them.
const landingPool = (landing: readonly number[]) => {
  const byN = new Map<number, Chain>();
  return (slot: number): Chain => {
    const n = landing.filter((s) => s <= slot).length;
    if (!byN.has(n)) byN.set(n, depositsChain([...OURS, ...Array.from({ length: n }, (_, k) => FOREIGN(k))], 0));
    return { ...byN.get(n)!, slot };
  };
};
const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => "restored", (e: Error) => `refused: ${e.message}`);

test("fold 3 (Q2a): a pool busy at every read on both RPCs: the restore reads on and walks at the first quiet read; whether a landing is the user's never changes the reads", { timeout: 20_000 }, async () => {
  // reads 1..Q each add a foreign deposit on both RPCs; read Q + 1 adds X (the user's own U(1), or one more foreign)
  const at = (x: readonly [bigint, bigint]) => memo((i) => depositsChain([...OURS, ...Array.from({ length: Math.min(i, Q) }, (_, k) => FOREIGN(k)), ...(i > Q ? [x] : [])], 700 + Math.min(i, Q + 1)));
  const run = async (x: readonly [bigint, bigint]) => {
    const log: string[] = [];
    const c = at(x);
    const clock = newClock();
    const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: [perRpc("https://a.example", c, c, log, clock), perRpc("https://b.example", c, c, log, clock)], gap: 4 });
    return { log, r };
  };
  const own = await run(U(1));
  const other = await run(FOREIGN(99));
  assert.deepEqual(own.log, other.log);
  assert.equal(own.log.filter((x) => x.endsWith("getProgramAccounts")).length, MARKS_CALLS * (Q + 3), "the first read, Q + 1 reads with a new mark, the read with none");
  assert.ok(own.r.notes.some((n) => n.ref.kind === "second" && n.ref.n === 1));
});

test("fold 3 (Q2b): a lister that adds a mark of its own making to every read never brings a quiet pool to the fallback: own and foreign read the same, then a refusal at the lie", { timeout: 20_000 }, async () => {
  const honest = (x: readonly [bigint, bigint]) => memo((i) => depositsChain([...OURS, ...(i > Q ? [x] : [])], 700 + i));
  const run = async (x: readonly [bigint, bigint], junk: "a" | "b" | null) => {
    const log: string[] = [];
    const h = honest(x);
    const clock = newClock();
    const rs: [SolanaRpc, SolanaRpc] = [perRpc("https://a.example", junk === "a" ? withJunk(h) : h, h, log, clock), perRpc("https://b.example", junk === "b" ? withJunk(h) : h, h, log, clock)];
    // the liar lists: its made-up mark is no account on the pair (the liar's own reads by address included)
    const out = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: rs[junk === "b" ? 1 : 0], rpcs: rs, gap: 4 }).then(() => "restored", (e: Error) => `refused: ${e.message}`);
    return { log, out };
  };
  for (const liar of ["a", "b"] as const) {
    const ownJ = await run(U(1), liar);
    const otherJ = await run(FOREIGN(99), liar);
    assert.deepEqual(ownJ.log, otherJ.log, liar);
    assert.match(ownJ.out, new RegExp(`^refused: rpc [01]: listed mark ${junkKey(1)} is not on it$`), liar);
    assert.equal(otherJ.out, ownJ.out, liar);
    assert.equal(ownJ.log.filter((x) => x.endsWith("getProgramAccounts")).length, MARKS_CALLS * 2, "the first read, then round 1's, whose made-up mark the pair lacks");
  }
  // the liar a slot ahead of the other RPC: its made-up mark lands in its list a round later, and the other, caught up
  // to the list's slot, lacks it
  const quiet = honest(FOREIGN(99))(0);
  const log: string[] = [];
  const out = await outcome(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lagWait: instant, rpcs: [skewRpc("https://a.example", 0, (sl) => ({ ...withJunk(() => quiet)(sl > 700 ? 1 : 0), slot: sl }), log), skewRpc("https://b.example", 1, (sl) => ({ ...quiet, slot: sl }), log)], gap: 4 }));
  assert.equal(out, `refused: rpc 1: listed mark ${junkKey(1)} is not on it`);
  assert.equal(log.filter((y) => y.includes("marks@")).length, 2 * MARKS_CALLS, "two reads (the first; round 1, the made-up mark a slot ahead), the lister's calls");
  // honest RPCs on the same quiet pool: no leak, and the restore holds
  const ownQ = await run(U(1), null);
  const otherQ = await run(FOREIGN(99), null);
  assert.deepEqual(ownQ.log, otherQ.log);
  assert.deepEqual([ownQ.out, otherQ.out], ["restored", "restored"]);
});

test("fold 3 (Q2c): the lister (the helper) adds marks of its own making, then the spent mark of a note whose send left: the owner's device and another read the same, then both refuse", { timeout: 60_000 }, async () => {
  const { beforeSpend } = restorePool();
  const sX = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const sOther = solanaMarkOf(PROGRAM, "spent", 4242n);
  const b = (key: string) => (i: number): Chain => {
    const marks = new Map(beforeSpend.marks!);
    for (let k = 1; k <= i; k++) marks.set(junkKey(k), junkData(k));
    if (i > Q) marks.set(key, spentData(50_000_000n, 0));
    return { ...beforeSpend, slot: 700 + i, marks };
  };
  const a = (i: number): Chain => ({ ...beforeSpend, slot: 700 + i });
  // the helper is the lister; the pair is honest
  const run = async (key: string) => {
    const log: string[] = [];
    const clock = newClock();
    const out = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: perRpc("https://l.example", b(key), a, log, clock), rpcs: [perRpc("https://a.example", a, a, log, clock), perRpc("https://b.example", a, a, log, clock)], gap: 4 }).then(() => "restored", (e: Error) => `refused: ${e.message}`);
    return { log, out };
  };
  const mine = await run(sX);
  const notMine = await run(sOther);
  assert.deepEqual(mine.log, notMine.log);
  assert.match(mine.out, new RegExp(`^refused: rpc 0: listed mark ${junkKey(1)} is not on it$`));
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
  await assert.rejects(solanaMarksListed(lagMarks, [lagMarks, rpc(chain, { ...MAINNET, url: "https://b.example" })], PROGRAM, ctl2.signal, undefined, async () => ctl2.abort()), { name: "AbortError" });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(after2, 0);
});

test("fold 3: new spent marks both RPCs give (a pool busy with releases) make the restore read on, then walk at the first quiet read", { timeout: 20_000 }, async () => {
  const log: { m: string }[] = [];
  const n = 3 * Q;
  const releases = memo((i) => depositsChain(OURS, 700 + Math.min(i, n), Math.min(i, n))); // other users' releases
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: movingPair(releases, MARKS_CALLS, log as never), gap: 4 });
  assert.equal(gpaCalls(log), MARKS_CALLS * (n + 2), "n reads with a new spent mark, then the read with none");
  assert.equal(js(r), js(await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(releases(0), releases(0)), gap: 4 })));
});

// ---------------------------------------------------------------------------------------------- fold 4 (M368)
test("fold 4 (H1): honest RPCs one slot apart on a busy pool never make the restore refuse: it reads on as the chain moves and walks at the first quiet read, on every device alike", { timeout: 20_000 }, async () => {
  const run = async (seed64: Uint8Array, who: 0 | 1, landing: readonly number[]) => {
    const pool = landingPool(landing);
    const log: string[] = [];
    const out = await outcome(solanaRestoreNotes({ seed64, program: PROGRAM, lagWait: instant, rpcs: [skewRpc("https://a.example", 0, pool, log), skewRpc("https://b.example", who, pool, log)], gap: 4 }));
    return { out, log, reads: log.filter((x) => x.includes("marks@")).length / MARKS_CALLS };
  };
  const busy = (n: number) => Array.from({ length: n }, (_, r) => 702 + 2 * r); // a landing at each of a's read slots 1..n
  assert.equal((await run(SEED, 0, busy(12))).out, "restored", "both RPCs at one slot");
  assert.equal((await run(SEED, 1, busy(12))).out, "restored", "b one slot behind a");
  assert.equal((await run(SEED, 1, Array.from({ length: 24 }, (_, r) => 701 + r))).out, "restored", "b one slot behind, a landing at every slot");
  // busy for n rounds (past fold 4's quiet rounds and walks, 8 + 4), then quiet: a's last landing is in read n, b has
  // it in read n + 1, which gives nothing new: the walk. The owner's device and another read the same
  for (const n of [Q + 4 + 1, 5 * Q]) {
    const mine = await run(SEED, 1, busy(n));
    const other = await run(SEED_OTHER, 1, busy(n));
    assert.equal(mine.out, "restored", String(n));
    assert.equal(other.out, "restored", String(n));
    assert.equal(mine.reads, 1 + n + 1, `${n}: the first read, n reads with a new mark, the read with none`);
    assert.deepEqual(mine.log, other.log, String(n));
  }
});

test("fold 5 (Q2d closed): Q bought busy rounds both RPCs see, then the lister, a slot ahead, adds the spent mark of a nullifier hash it holds: the device holding that note and another make the same reads to the same refusal", { timeout: 20_000 }, async () => {
  const sX = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  // a lists read i at 700 + 2i, and b, a slot behind, catches up to it; a landing at 699 + 2i reaches both in read i. The
  // attacker buys landings in reads 1..last; RPC a (the lister) adds sX from read `at` on
  const run = async (seed64: Uint8Array, at: number, last: number) => {
    const pool = landingPool(Array.from({ length: last }, (_, r) => 701 + 2 * r));
    const planted = (slot: number): Chain => {
      const c = pool(slot);
      return slot >= 700 + 2 * at ? { ...c, marks: new Map(c.marks!).set(sX, spentData(50_000_000n, 0)) } : c;
    };
    const log: string[] = [];
    const out = await outcome(solanaRestoreNotes({ seed64, program: PROGRAM, lagWait: instant, rpcs: [skewRpc("https://a.example", 0, planted, log), skewRpc("https://b.example", 1, pool, log)], gap: 4 }));
    return { log, out };
  };
  for (const [at, last] of [[Q + 1, Q], [Q + 1, Q + 1], [Q + 2, Q + 4], [Q, Q + 4], [1, Q]] as const) {
    const mine = await run(SEED, at, last);
    const other = await run(SEED_OTHER, at, last);
    assert.deepEqual(mine.log, other.log, `${at}/${last}: the same reads`);
    assert.equal(mine.out, other.out, `${at}/${last}: the same outcome`);
    assert.equal(mine.out, `refused: rpc 1: listed mark ${sX} is not on it`, `${at}/${last}`);
  }
});

test("fold 4 (Q2e): the lister, one of the pair, plants the spent mark of a nullifier hash it holds: refused at the lie on the owner's device and on another alike", { timeout: 20_000 }, async () => {
  const { beforeSpend } = restorePool();
  const sX = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const sOther = solanaMarkOf(PROGRAM, "spent", 4242n);
  const run = async (key: string, liar: "a" | "b") => {
    const log: string[] = [];
    const honest = (i: number): Chain => ({ ...beforeSpend, slot: 700 + i });
    const planted = (i: number): Chain => ({ ...beforeSpend, slot: 700 + i, marks: new Map(beforeSpend.marks!).set(key, spentData(50_000_000n, 0)) });
    const clock = newClock();
    const rs: [SolanaRpc, SolanaRpc] = [perRpc("https://a.example", liar === "a" ? planted : honest, honest, log, clock), perRpc("https://b.example", liar === "b" ? planted : honest, honest, log, clock)];
    const out = await outcome(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: rs[liar === "a" ? 0 : 1], rpcs: rs, gap: 4 }));
    return { log, out };
  };
  for (const liar of ["a", "b"] as const) {
    const mine = await run(sX, liar);
    const notMine = await run(sOther, liar);
    assert.deepEqual(mine.log, notMine.log, liar);
    assert.match(mine.out, new RegExp(`^refused: rpc [01]: listed mark ${sX} is not on it$`), liar);
    assert.equal(mine.out.replace(sX, "K"), notMine.out.replace(sOther, "K"), liar);
  }
});

test("fold 4 (Q2f): the lister, one of the pair, hides the pool's old marks, then gives one back per read with a made-up one: own and foreign read the same, refused at the lie", { timeout: 20_000 }, async () => {
  const old = Array.from({ length: 12 }, (_, k) => FOREIGN(k));
  const honest = (x: readonly [bigint, bigint]) => memo((i) => depositsChain([...OURS, ...old, ...(i > Q ? [x] : [])], 700 + i));
  const hidden = old.map(([P]) => solanaMarkOf(PROGRAM, "pre", P));
  const liar = (h: (i: number) => Chain) => (i: number): Chain => {
    const c = h(i);
    const marks = new Map(c.marks!);
    for (let k = i; k < hidden.length; k++) marks.delete(hidden[k]!); // read i gives back old marks 0..i-1
    for (let k = 1; k <= i; k++) marks.set(junkKey(k), markData(1n, 1n));
    return { ...c, marks };
  };
  const run = async (x: readonly [bigint, bigint]) => {
    const log: string[] = [];
    const h = honest(x);
    const clock = newClock();
    const rs: [SolanaRpc, SolanaRpc] = [perRpc("https://a.example", h, h, log, clock), perRpc("https://b.example", liar(h), h, log, clock)];
    const out = await outcome(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: rs[1], rpcs: rs, gap: 4 }));
    return { log, out };
  };
  const own = await run(U(1));
  const other = await run(FOREIGN(99));
  assert.deepEqual(own.log, other.log);
  assert.equal(own.out, `refused: rpc 0: listed mark ${junkKey(1)} is not on it`);
  assert.equal(other.out, own.out);
});

// ---------------------------------------------------------------------------------------------- fold 6 (review round 4)
test("fold 6 (T1): one RPC pages a deposit short (its marks honest, its slot at the minimum): refused on the owner's device and on another alike", { timeout: 20_000 }, async () => {
  const full = (i: number): Chain => depositsChain([...OURS, U(1)], 700 + i);
  const short = (i: number): Chain => ({ ...depositsChain(OURS, 0), slot: 700 + i, marks: full(i).marks }); // U(1)'s leaves left out
  for (const liar of ["a", "b"] as const) {
    const run = async (seed64: Uint8Array) => {
      const log: string[] = [];
      const clock = newClock();
      const out = await outcome(solanaRestoreNotes({ seed64, program: PROGRAM, rpcs: [perRpc("https://a.example", full, liar === "a" ? short : full, log, clock), perRpc("https://b.example", full, liar === "b" ? short : full, log, clock)], gap: 4 }));
      return { log, out };
    };
    const mine = await run(SEED);
    const other = await run(SEED_OTHER);
    assert.deepEqual(mine.log, other.log, liar);
    assert.equal(mine.out, `refused: ${marksAre(4, 0, liar === "a" ? [3, 3] : [4, 4], liar === "a" ? [4, 4] : [3, 3])}`, liar);
    assert.equal(other.out, mine.out, liar);
  }
  // the label tree alone short (its state pages whole)
  const labelPage = solanaPageOf(PROGRAM, 1, 0);
  const labelShort = (i: number): Chain => { const c = full(i); return { ...c, accounts: new Map(c.accounts).set(labelPage, short(i).accounts.get(labelPage)!) }; };
  const outs = await Promise.all([SEED, SEED_OTHER].map((seed64) => outcome(solanaRestoreNotes({ seed64, program: PROGRAM, rpcs: ((clock) => [perRpc("https://a.example", full, full, [], clock), perRpc("https://b.example", full, labelShort, [], clock)] as [SolanaRpc, SolanaRpc])(newClock()), gap: 4 }))));
  assert.deepEqual(outs, Array(2).fill(`refused: ${marksAre(4, 0, [4, 4], [4, 3])}`));
});

test("fold 6 (T2): one RPC pages without the change leaf of the user's release (its marks honest): refused on the owner's device and on another alike", { timeout: 20_000 }, async () => {
  const { chain, beforeSpend } = restorePool();
  const short = (i: number): Chain => ({ ...beforeSpend, slot: 700 + i, marks: chain.marks }); // the release's change leaf left out
  const full = (i: number): Chain => ({ ...chain, slot: 700 + i });
  for (const liar of ["a", "b"] as const) {
    const run = async (seed64: Uint8Array) => {
      const log: string[] = [];
      const clock = newClock();
      const out = await outcome(solanaRestoreNotes({ seed64, program: PROGRAM, rpcs: [perRpc("https://a.example", full, liar === "a" ? short : full, log, clock), perRpc("https://b.example", full, liar === "b" ? short : full, log, clock)], gap: 4 }));
      return { log, out };
    };
    const mine = await run(SEED);
    const other = await run(SEED_OTHER);
    assert.deepEqual(mine.log, other.log, liar);
    assert.equal(mine.out, `refused: ${marksAre(5, 2, liar === "a" ? [4, 4] : [7, 5], liar === "a" ? [7, 5] : [4, 4])}`, liar);
    assert.equal(other.out, mine.out, liar);
  }
  // the state tree alone cut just before the change leaf (the label tree whole): what a relayer that knows the change
  // commitment can serve
  const statePage = solanaPageOf(PROGRAM, 0, 0);
  const cut = (i: number): Chain => ({ ...full(i), accounts: new Map(chain.accounts).set(statePage, beforeSpend.accounts.get(statePage)!) });
  const outs = await Promise.all([SEED, SEED_OTHER].map((seed64) => outcome(solanaRestoreNotes({ seed64, program: PROGRAM, rpcs: ((clock) => [perRpc("https://a.example", full, full, [], clock), perRpc("https://b.example", full, cut, [], clock)] as [SolanaRpc, SolanaRpc])(newClock()), gap: 4 }))));
  assert.deepEqual(outs, Array(2).fill(`refused: ${marksAre(5, 2, [7, 5], [4, 5])}`));
});

test("fold 6 (T3): an honest pair on the same pools: both devices restore", async () => {
  const { chain } = restorePool();
  const full = (i: number): Chain => depositsChain([...OURS, U(1)], 700 + i);
  const pool = (i: number): Chain => ({ ...chain, slot: 700 + i });
  for (const c of [full, pool])
    for (const seed64 of [SEED, SEED_OTHER]) assert.equal(await outcome(solanaRestoreNotes({ seed64, program: PROGRAM, rpcs: ((clock) => [perRpc("https://a.example", c, c, [], clock), perRpc("https://b.example", c, c, [], clock)] as [SolanaRpc, SolanaRpc])(newClock()), gap: 4 })), "restored");
});

test("fold 6 (G7): the lister, a slot ahead, plants the spent mark of a nullifier hash it holds in its first read only, then drops it: refused at the lie on the owner's device and on another alike", async () => {
  const { beforeSpend } = restorePool();
  const sX = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const pool = (slot: number): Chain => ({ ...beforeSpend, slot });
  const planted = (slot: number): Chain => (slot === 700 ? { ...pool(slot), marks: new Map(beforeSpend.marks!).set(sX, spentData(50_000_000n, 0)) } : pool(slot));
  const run = async (seed64: Uint8Array) => {
    const log: string[] = [];
    const out = await outcome(solanaRestoreNotes({ seed64, program: PROGRAM, lagWait: instant, rpcs: [skewRpc("https://a.example", 0, planted, log), skewRpc("https://b.example", 1, pool, log)], gap: 4 }));
    return { log, out };
  };
  const mine = await run(SEED);
  const other = await run(SEED_OTHER);
  assert.deepEqual(mine.log, other.log);
  assert.equal(mine.out, `refused: rpc 1: listed mark ${sX} is not on it`);
  assert.equal(other.out, mine.out);
});

test("fold 6 (LAG): an honest RPC up to SOL_LAG_SLOTS finalized slots behind the other, on a quiet pool, never makes the restore refuse; one further behind is refused", { timeout: 20_000 }, async () => {
  const { chain } = restorePool();
  const base = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: pair(chain, chain), gap: 4 });
  // one clock: a is at `now`, b `skew` slots behind it; each lag wait is a slot
  const run = async (skew: number) => {
    let now = 700;
    const at = (behind: number): SolanaRpc => async (m: string, p: readonly unknown[]) => {
      const slot = now - behind;
      const min = (p[1] as { minContextSlot?: number } | undefined)?.minContextSlot ?? 0;
      if (slot < min) throw new Error("RPC error -32016: Minimum context slot has not been reached");
      return rpc({ ...chain, slot }, MAINNET)(m, p);
    };
    const rpcs = [Object.assign(at(0), { url: "https://a.example" }), Object.assign(at(skew), { url: "https://b.example" })] as [SolanaRpc, SolanaRpc];
    return outcome(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lagWait: async () => void now++, rpcs, gap: 4 }).then((r) => assert.equal(js(r), js(base))));
  };
  for (const skew of [0, 1, 2, 3, 4, 6, 13, SOL_LAG_SLOTS]) assert.equal(await run(skew), "restored", String(skew));
  assert.match(await run(SOL_LAG_SLOTS + 1), /-32016/);
});

test("fold 6 (M376): a full call of pages stays under the kit's answer cap, and a pool of 30 full pages in both trees syncs", { timeout: 60_000 }, async () => {
  // the answer a provider sends for SOL_PAGES_A_CALL full pages, every number at u64 width
  const page = base64.encode(new Uint8Array(16 + 72 * 1024).fill(255));
  const u64 = "18446744073709551615";
  const acct = `{"data":["${page}","base64"],"executable":false,"lamports":${u64},"owner":"${PROGRAM}","rentEpoch":${u64},"space":${16 + 72 * 1024}}`;
  const full = `{"jsonrpc":"2.0","id":${u64},"result":{"context":{"apiVersion":"9.99.999","slot":${u64}},"value":[${Array(SOL_PAGES_A_CALL).fill(acct).join(",")}]}}`;
  assert.equal(SOL_PAGES_A_CALL, 8);
  assert.ok(acct.length - page.length < 200, "the JSON around one account");
  assert.ok(full.length < SOLANA_ANSWER_MAX_BYTES * 0.8, `${full.length} bytes`);
  // 30 full pages a tree (30,720 leaves; the roots are not read by leaves()), each call under the cap the fake keeps
  const es = Array.from({ length: 30 * 1024 }, (_, i) => ({ leaf: BigInt(1_000 + i), root: 1n, t: 1_800_000_000n + BigInt(i) }));
  const c: Chain = { accounts: new Map([...pages(0, es), ...pages(1, es)]), slot: 700, time: () => 1_900_000_000n };
  const log: string[] = [];
  const got = await solanaTreeSync([rpc(c, { ...MAINNET, url: "https://a.example" }, log), rpc(c, { ...MAINNET, url: "https://b.example" })], PROGRAM).leaves(0);
  assert.deepEqual([got.state.length, got.label.length], [30 * 1024, 30 * 1024]);
  assert.equal(log.filter((m) => m === "getMultipleAccounts").length, Math.ceil(31 / (SOL_PAGES_A_CALL / 2)), "pages 0..30 of each tree (30 is the empty one), SOL_PAGES_A_CALL a call");
});

// fold 10 (the review of f05379b, probe d): a spent mark is withdrawnValue then the release's number, then the tag (13
// bytes), and the pair must read the same bytes for it. The lister, RPC a, gives a new release's spent mark from read 1
// on with number 9 in its reads; RPC b reads it with number 0: refused on every device.
test("fold 10 (number): a spent mark whose release number differs between the pair's reads is refused on every device", async () => {
  const c0 = (slot: number): Chain => depositsChain(OURS, slot, 0);
  const r = (slot: number, number = 0): Chain => {
    const ch = depositsChain(OURS, slot, 1);
    return number === 0 ? ch : { ...ch, marks: new Map(ch.marks!).set(solanaMarkOf(PROGRAM, "spent", 770_001n), spentData(1n, number)) };
  };
  const aAt = (i: number) => (i === 0 ? c0(700) : r(701 + i, 9));
  const bAt = (i: number) => (i === 0 ? c0(700) : r(701 + i));
  const two = (a: (i: number) => Chain, b: (i: number) => Chain): [SolanaRpc, SolanaRpc] => {
    const clock = newClock();
    return [perRpc("https://a.example", a, a, [], clock), perRpc("https://b.example", b, b, [], clock)];
  };
  for (const seed64 of [SEED, SEED_OTHER]) {
    const out = await outcome(solanaRestoreNotes({ seed64, program: PROGRAM, rpcs: two(aAt, bAt), gap: 4 }));
    assert.match(out, /^refused: listed mark \S+: the two RPCs' bytes differ$/);
  }
  // the same mark with its true number on both restores
  assert.equal(await outcome(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: two(bAt, bAt), gap: 4 })), "restored");
});

// ---------------------------------------------------------------------------------------------- card sol-marks-scale
// A pool of any size: each mark size is read in buckets of 256 consecutive counters (M376 (1)), so no answer comes near
// the kit's 1 MiB cap. The pool: nPre deposits and nSpent releases of strangers' (keys and leaves made up, as the walk
// never reads them), with ours on top: deposit note 0 at the last nonce, released whole as the last release (both in
// the last bucket of their size), its change note of 0. Roots are not read by a restore, so they are 0.
function bigPool(nPre: number, nSpent: number, slot = 700): { chain: Chain; P0: bigint; label: bigint } {
  const key = (tag: number, k: number): string => {
    const b = new Uint8Array(32);
    b[0] = tag;
    new DataView(b.buffer).setUint32(1, k);
    return base58.encode(b);
  };
  const marks = new Map<string, Uint8Array>();
  const state: Entry[] = [];
  const labels: Entry[] = [];
  const t = 1_800_000_000n;
  for (let k = 1; k < nPre; k++) {
    marks.set(key(1, k), markData(10_000_000n, BigInt(k)));
    labels.push({ leaf: BigInt(1_000_000 + k), root: 0n, t });
    state.push({ leaf: BigInt(2_000_000 + k), root: 0n, t });
  }
  for (let k = 0; k < nSpent - 1; k++) {
    marks.set(key(2, k), spentData(10_000_000n, k));
    state.push({ leaf: BigInt(3_000_000 + k), root: 0n, t });
  }
  const P0 = noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).precommitment;
  const label = vaultLabelOf(keccak_256, SCOPE, BigInt(nPre));
  marks.set(solanaMarkOf(PROGRAM, "pre", P0), markData(50_000_000n, BigInt(nPre)));
  labels.push({ leaf: label, root: 0n, t });
  state.push({ leaf: noteCommitment(50_000_000n, label, P0), root: 0n, t });
  marks.set(solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash), spentData(50_000_000n, nSpent - 1));
  state.push({ leaf: noteCommitment(0n, label, noteSecrets(SEED, { kind: "change", l: label, j: 0 }).precommitment), root: 0n, t });
  return { chain: { accounts: new Map([...pages(0, state), ...pages(1, labels)]), slot, time: () => t + 5n, marks }, P0, label };
}
const counted = (c: Chain, url: string, log: string[]): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => rpc(c, MAINNET, log)(m, p), { url });
/** A restore of bigPool(nPre, nSpent) on two RPCs: its outcome, and the calls of each method on both RPCs together. */
async function restoreBig(nPre: number, nSpent: number): Promise<{ notes: number; spent: number; gpa: number; gma: number; calls: number }> {
  const { chain } = bigPool(nPre, nSpent);
  const log: string[] = [];
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: [counted(chain, "https://a.example", log), counted(chain, "https://b.example", log)], gap: 4 });
  return { notes: r.notes.length, spent: r.notes.filter((n) => n.state === "SPENT").length, gpa: log.filter((m) => m === "getProgramAccounts").length, gma: log.filter((m) => m === "getMultipleAccounts").length, calls: log.length };
}

test("sol-marks-scale F4a: a pool of 5,000 deposits restores through the kit's own JSON-RPC client and its 1 MiB cap", async () => {
  const { chain } = bigPool(5_000, 10);
  // a real RPC's answer shape (rent-exempt lamports, rentEpoch at u64 max, space), so the kit's cap is measured on it
  const f = async (_url: string, init?: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init!.body)) as { id: string; method: string; params: unknown[] };
    let result: unknown;
    try {
      result = await rpc(chain, MAINNET)(req.method, req.params);
    } catch (e) {
      if ((e as Error).message !== "answer too large") throw e;
      // the fake measured it past the cap: answer it whole anyway, so the kit's client is what refuses it
      const all = { ...req, params: [req.params[0], { ...(req.params[1] as object), filters: [(req.params[1] as { filters: unknown[] }).filters[0]] }] };
      result = { context: { slot: chain.slot }, value: [...chain.marks!].filter(([, d]) => d.length === (all.params[1] as { filters: [{ dataSize: number }] }).filters[0].dataSize).map(([pubkey, d]) => ({ pubkey, account: { data: [base64.encode(d), "base64"] } })) };
    }
    let text = JSON.stringify({ jsonrpc: "2.0", id: req.id, result });
    if (req.method === "getProgramAccounts") text = text.replace(/"account":\{/g, `"account":{"executable":false,"lamports":1002240,"owner":"${PROGRAM}","rentEpoch":18446744073709551615,"space":16,`).replace(/"owner":"[^"]+","lamports":1,"executable":false,"rentEpoch":0,/g, "");
    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  };
  const rpcs: [SolanaRpc, SolanaRpc] = [solanaJsonRpc("https://a.example", { fetch: f }), solanaJsonRpc("https://b.example", { fetch: f })];
  const out = await outcome(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs, gap: 4 }));
  assert.equal(out, "restored");
});

test("sol-marks-scale: a pool of 20,000 marks restores, and no getProgramAccounts answer comes near the 1 MiB cap", async () => {
  gpaBiggest = 0;
  const big20 = await restoreBig(14_000, 6_000);
  assert.deepEqual([big20.notes, big20.spent], [2, 1], "deposit note 0, spent, and its change note");
  assert.ok(gpaBiggest > 0 && gpaBiggest <= gpaAnswerBytes(SOL_MARK_BUCKET, 16), `the biggest answer ${gpaBiggest} B is one full bucket at most`);
  assert.ok(gpaAnswerBytes(SOL_MARK_BUCKET, 16) < SOLANA_ANSWER_MAX_BYTES / 8, "a full bucket is under an eighth of the cap");
  const big1 = await restoreBig(700, 300);
  assert.deepEqual([big1.notes, big1.spent], [2, 1]);
  // two lists (the first, then the one after the pages, which gives nothing new), by the lister alone (rpcs[0]), bucket
  // by bucket until one is short: 14,000 pre marks (nonces 1-14,000) fill buckets 0-53 and 54 is short: 55 calls; 6,000
  // spent marks (numbers 0-5,999) fill 0-22 and 23 is short: 24 calls; 700 pre and 300 spent marks: buckets 0-2 and 0-1.
  // The second list asks only for the short bucket of each size: every full one is whole and held (solanaMarksListed)
  console.log(`# calls, both RPCs, the whole restore: 1,000 marks ${big1.gpa} getProgramAccounts + ${big1.gma} getMultipleAccounts (${big1.calls} in all); 20,000 marks ${big20.gpa} + ${big20.gma} (${big20.calls}); the biggest marks answer ${gpaBiggest} B`);
  assert.equal(big20.gpa, 55 + 24 + 2);
  assert.equal(big1.gpa, 3 + 2 + 2);
});

test("sol-marks-scale: one RPC missing a listed mark in one bucket, at the same slot, is refused on every device", async () => {
  const { chain } = bigPool(2_000, 10);
  // a stranger's deposit at nonce 1,300 (bucket 5), which RPC b lacks at the same slot
  const missing = [...chain.marks!].find(([, d]) => d.length === PRE_LEN && new DataView(d.buffer, d.byteOffset).getBigUint64(8, true) === 1_300n)![0];
  const short: Chain = { ...chain, marks: new Map([...chain.marks!].filter(([k]) => k !== missing)) };
  for (const seed64 of [SEED, SEED_OTHER]) {
    const out = await outcome(solanaRestoreNotes({ seed64, program: PROGRAM, rpcs: pair(chain, short), gap: 4 }));
    assert.equal(out, `refused: rpc 1: listed mark ${missing} is not on it`);
  }
});

test("sol-marks-scale: a bucket whose lister lags is listed again a slot later, and refused past the budget", async () => {
  const { chain } = bigPool(2_000, 10);
  const bucket5 = (p: readonly unknown[]): boolean => {
    const f = (p[1] as { filters: [{ dataSize: number }, { memcmp: { bytes: string } }] }).filters;
    return f[0].dataSize === PRE_LEN && base58.decode(f[1].memcmp.bytes)[0] === 5;
  };
  const lagging = (lags: number, asked: { n: number }): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m === "getProgramAccounts" && bucket5(p) && asked.n++ < lags) throw new Error("RPC error -32016: Minimum context slot has not been reached");
    return rpc(chain, MAINNET)(m, p);
  }, { url: "https://b.example" });
  const instant: SolanaLagWait = async () => {};
  const twice = { n: 0 };
  const ok = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lagging(2, twice), rpcs: pair(chain, chain), gap: 4, lagWait: instant });
  assert.equal(ok.notes.length, 2);
  assert.equal(twice.n, 2 + 1, "the first read's bucket 5: two lags, then its answer; the second read lists none: bucket 5 is whole and held");
  const ever = { n: 0 };
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lagging(Infinity, ever), rpcs: pair(chain, chain), gap: 4, lagWait: instant }), /RPC error -32016/);
  assert.equal(ever.n, SOL_LAG_SLOTS + 1, "the budget's calls of that one bucket");
});

test("sol-marks-scale: a lister naming a bucket full of made-up marks, a slot past the pair, is refused at that bucket's read: the pair, asked for the lister's slot, holds none of them", async () => {
  // the pair, honest, nodes that answer at slot 700 or at the minContextSlot asked for: 300 deposits, buckets 0 (full),
  // 1 (short) and 2 (empty)
  const { chain } = bigPool(300, 10);
  const honest = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => rpc({ ...chain, slot: Math.max(chain.slot, (p[1] as { minContextSlot?: number } | undefined)?.minContextSlot ?? 0) }, MAINNET)(m, p), { url });
  // the lister answers bucket 1 as if full and bucket 2 full of made-up marks, at slot 701 (past the pair's 700)
  const fake = (k: number, nonce: number): [string, Uint8Array] => [solanaMarkOf(PROGRAM, "pre", BigInt(990_000 + k)), markData(10_000_000n, BigInt(nonce))];
  const full: Chain = { ...chain, slot: 701, marks: new Map([...chain.marks!, ...Array.from({ length: 512 - 301 }, (_, k) => fake(k, 301 + k)), ...Array.from({ length: 256 }, (_, k) => fake(1_000 + k, 512 + k))]) };
  const log: string[] = [];
  const liar: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    const f = (p[1] as { filters: [{ dataSize: number }, { memcmp: { bytes: string } }] }).filters;
    if (f[0].dataSize === PRE_LEN) log.push(`l ${base58.decode(f[1].memcmp.bytes)[0]}`);
    return rpc(full, MAINNET)(m, p);
  }, { url: "https://l.example" });
  await assert.rejects(solanaMarksListed(liar, [honest("https://a.example"), honest("https://b.example")], PROGRAM), new RegExp(`^Error: rpc [01]: listed mark ${fake(0, 301)[0]} is not on it$`));
  // the deposit marks' buckets 0 and 1, the refusal at bucket 1's read: no list after it
  assert.deepEqual(log, ["l 0", "l 1"]);
});

test("sol-marks-scale: a listed mark outside the bucket asked for is refused (a lister that ignores the filter)", async () => {
  const { chain } = bigPool(200, 10);
  // the lister answers every bucket with every mark of the size: bucket 0's answer holds counters past 255 once the pool
  // passes them, so the pool here holds 200 deposits and the lister moves one to nonce 300
  const k7 = [...chain.marks!].find(([, d]) => d.length === PRE_LEN && new DataView(d.buffer, d.byteOffset).getBigUint64(8, true) === 7n)![0];
  const moved: Chain = { ...chain, marks: new Map(chain.marks!).set(k7, markData(10_000_000n, 300n)) };
  const deaf: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    const size = (p[1] as { filters: [{ dataSize: number }] }).filters[0].dataSize;
    return { context: { slot: chain.slot }, value: [...chain.marks!].filter(([, d]) => d.length === size).map(([pubkey]) => ({ pubkey, account: { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: ["", "base64"] } })) };
  }, { url: "https://l.example" });
  await assert.rejects(solanaMarksListed(deaf, pair(moved, moved), PROGRAM), new RegExp(`^Error: listed mark ${k7}: counter 300 is not in bucket 0$`));
});

// ------------------------------------------------------------------------------------- card sol-marks-scale, fold 1
// The review's probes (RV-*). Every getProgramAccounts here is answered by this file's own fake, in a real RPC's JSON
// shape, through the kit's own JSON-RPC client (solanaJsonRpc, its 1 MiB cap), applying dataSize and each memcmp itself
// with its own base58 decoder (the RPC spec: memcmp {offset, bytes base58}, a match when data[offset..offset+len]
// equals the bytes, no match past the data's end).
const RV_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function rvB58decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = RV_ALPHA.indexOf(ch);
    if (v < 0) throw new Error("not base58");
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  let zeros = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    zeros++;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...out]);
}
function rvMatches(d: Uint8Array, filters: readonly Record<string, unknown>[]): boolean {
  for (const f of filters) {
    if ("dataSize" in f) {
      if (d.length !== f.dataSize) return false;
    } else if ("memcmp" in f) {
      const m = f.memcmp as { offset: number; bytes: string; encoding?: string };
      const want = m.encoding === "base64" ? base64.decode(m.bytes) : rvB58decode(m.bytes);
      if (m.offset + want.length > d.length) return false;
      for (let i = 0; i < want.length; i++) if (d[m.offset + i] !== want[i]) return false;
    } else throw new Error(`filter ${JSON.stringify(f)}`);
  }
  return true;
}
function rvPrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rvKey = (r: () => number): string => base58.encode(Uint8Array.from({ length: 32 }, () => Math.floor(r() * 256)));
type RvSnap = { chain: Chain; slot: number } | { lag: true };
type RvStat = { calls: number; gpa: number; biggest: number };
const rvStat = (): RvStat => ({ calls: 0, gpa: 0, biggest: 0 });
/**
 * One RPC in a real RPC's JSON shape through the kit's client; `at` picks the snapshot (and slot) each call is answered at.
 * lax: it also gives every account of the size asked whose first 8 bytes are 0, whatever the memcmp (the device's zero
 * skip, kept behind the tag as defence in depth).
 */
function rvRpc(url: string, at: (method: string, min: number, params: readonly unknown[]) => RvSnap, st: RvStat, lax = false): SolanaRpc {
  const f = async (_u: string, init?: RequestInit): Promise<Response> => {
    await new Promise((ok) => setImmediate(ok));
    const req = JSON.parse(String(init!.body)) as { id: string; method: string; params: unknown[] };
    st.calls++;
    const opts = (req.params[1] ?? {}) as { minContextSlot?: number; filters?: Record<string, unknown>[] };
    const s = at(req.method, typeof opts === "object" && opts !== null ? opts.minContextSlot ?? 0 : 0, req.params);
    let text: string;
    if ("lag" in s) text = JSON.stringify({ jsonrpc: "2.0", error: { code: -32016, message: "Minimum context slot has not been reached" }, id: req.id });
    else if (req.method === "getProgramAccounts") {
      st.gpa++;
      const rows: string[] = [];
      for (const [pubkey, d] of s.chain.marks ?? new Map<string, Uint8Array>())
        if (rvMatches(d, opts.filters ?? []) || (lax && rvMatches(d, (opts.filters ?? []).filter((x) => "dataSize" in x)) && d.subarray(0, 8).every((v) => v === 0)))
          rows.push(`{"account":{"data":["${base64.encode(d)}","base64"],"executable":false,"lamports":${(128 + d.length) * 5080},"owner":"${PROGRAM}","rentEpoch":18446744073709551615,"space":${d.length}},"pubkey":"${pubkey}"}`);
      text = `{"jsonrpc":"2.0","result":{"context":{"apiVersion":"3.0.6","slot":${s.slot}},"value":[${rows.join(",")}]},"id":"${req.id}"}`;
      st.biggest = Math.max(st.biggest, text.length);
    } else {
      const result = await rpc({ ...s.chain, slot: s.slot }, MAINNET)(req.method, req.params);
      text = JSON.stringify({ jsonrpc: "2.0", result, id: req.id });
    }
    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  };
  return solanaJsonRpc(url, { fetch: f });
}
/** A node fixed at `slot` that catches up at once to a minContextSlot past it (as the next slot's answer would). */
const rvAt = (chain: Chain, slot: number) => (_m: string, min: number): RvSnap => ({ chain, slot: Math.max(slot, min) });
const rvOut = (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: Error) => `refused: ${e.message}`);
const rvInstant: SolanaLagWait = async () => {};
/** A pool of strangers' marks only: deposits with nonces 1..nPre, releases numbered 0..nSpent-1. */
function rvPool(nPre: number, nSpent: number, r = rvPrng(1)): Chain {
  const marks = new Map<string, Uint8Array>();
  for (let k = 1; k <= nPre; k++) marks.set(rvKey(r), markData(10_000_000n, BigInt(k)));
  for (let k = 0; k < nSpent; k++) marks.set(rvKey(r), spentData(10_000_000n, k));
  return { accounts: new Map(), slot: 700, time: () => 0n, marks };
}

// card fresh-run-margin: the default run reads the first pool, of 5,000 deposits; FULL_RUNS=1 (the package's
// test:mutants script, run by CI's test-mutants split) all three, to 50,000
const RV_A_POOLS = ([[5_000, 3_000], [20_000, 6_000], [50_000, 20_000]] as const).slice(0, process.env.FULL_RUNS === "1" ? 3 : 1);
test(`sol-marks-scale fold 1 RV-A (F4a, memcmp applied): the marks of ${RV_A_POOLS.map(([n]) => n.toLocaleString("en-US")).join(" / ")} deposits through the kit's client and its 1 MiB cap`, async () => {
  for (const [nPre, nSpent] of RV_A_POOLS) {
    const c = rvPool(nPre, nSpent);
    const sa = rvStat(), sb = rvStat();
    let got: { pre: number; spent: number } | undefined;
    // the lister is the pair's first RPC: it lists, and both read every listed mark by its address
    const ra = rvRpc("https://a.example", rvAt(c, 700), sa);
    const out = await rvOut(solanaMarksListed(ra, [ra, rvRpc("https://b.example", rvAt(c, 700), sb)], PROGRAM).then((m) => (got = { pre: m.pre.size, spent: m.spent.size })));
    console.log(`# RV-A ${nPre} deposits + ${nSpent} releases: ${out}${got ? ` (pre ${got.pre}, spent ${got.spent})` : ""}; getProgramAccounts calls ${sa.gpa} + ${sb.gpa}, calls in all ${sa.calls} + ${sb.calls}; the biggest list ${sa.biggest} B`);
    assert.equal(sb.gpa, 0, "only the lister lists");
    assert.equal(out, "ok");
    assert.deepEqual(got, { pre: nPre, spent: nSpent });
    assert.ok(sa.biggest < SOLANA_ANSWER_MAX_BYTES / 8);
  }
});

test("sol-marks-scale fold 1 RV-B1 (stranger): one 17-byte all-zero account the program owns (system CreateAccount, owner = the program), given by RPCs that pass it whatever the memcmp, is passed over by the restore and the settle", async () => {
  const { chain, l0 } = restorePool();
  const r = rvPrng(7);
  const zero: Chain = { ...chain, marks: new Map([...chain.marks!, [rvKey(r), new Uint8Array(PRE_LEN)]]) };
  const two = (c: Chain): [SolanaRpc, SolanaRpc] => [rvRpc("https://a.example", rvAt(c, 700), rvStat(), true), rvRpc("https://b.example", rvAt(c, 700), rvStat(), true)];
  const clean = await rvOut(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: two(chain), gap: 4 }));
  const restore = await rvOut(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: two(zero), gap: 4 }));
  const a = await reservedDeposit0(l0);
  const settleClean = await solanaSettleSpent({ seed64: SEED, notes: a.ns, noteId: a.id, program: PROGRAM, rpcs: two(chain) }).then((x) => x.kind, (e: Error) => `refused: ${e.message}`);
  const b = await reservedDeposit0(l0);
  const settle = await solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, rpcs: two(zero) }).then((x) => x.kind, (e: Error) => `refused: ${e.message}`);
  console.log(`# RV-B1 clean restore: ${clean}; with one 17-byte zero account: restore ${restore}; settle clean ${settleClean}, settle with it ${settle}`);
  assert.equal(clean, "ok");
  assert.equal(settleClean, "spent");
  // the pass condition of a fix: a zero account is no mark the program wrote (deposit.rs:76 value >= MIN_DEPOSIT,
  // release.rs:218 withdrawn != 0), so neither the restore nor the settle may stop on it
  assert.equal(restore, "ok", "restore stopped by a stranger's zero account");
  assert.equal(settle, "spent", "settle stopped by a stranger's zero account");
});

test("sol-marks-scale fold 1 RV-B2 (stranger): one 13-byte all-zero account the program owns, given by RPCs that pass it whatever the memcmp, is passed over, so the leaf count holds", async () => {
  const { chain, l0 } = restorePool();
  const r = rvPrng(8);
  const zero: Chain = { ...chain, marks: new Map([...chain.marks!, [rvKey(r), new Uint8Array(SPENT_LEN)]]) };
  const two = (c: Chain): [SolanaRpc, SolanaRpc] => [rvRpc("https://a.example", rvAt(c, 700), rvStat(), true), rvRpc("https://b.example", rvAt(c, 700), rvStat(), true)];
  const restore = await rvOut(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: two(zero), gap: 4 }));
  const b = await reservedDeposit0(l0);
  const settle = await solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, rpcs: two(zero) }).then((x) => x.kind, (e: Error) => `refused: ${e.message}`);
  console.log(`# RV-B2 with one 13-byte zero account: restore ${restore}; settle ${settle}`);
  assert.equal(restore, "ok", "restore stopped by a stranger's zero account");
  assert.equal(settle, "spent");
});

// card pool-sol-mark-tag: every mark ends with the program's tag (contracts/pool-solana/src/state.rs MARK_TAG), and each
// bucket's memcmp holds it, so a zero-filled account a stranger makes matches no bucket. Before the tag, every one sat in
// bucket 0: 4,400 zero 12-byte accounts gave a 1,069,538 B answer, past the kit's 1 MiB cap, and every restore and
// settle was refused.
test("sol-marks-scale fold 1 RV-B3 (stranger, card pool-sol-mark-tag): 5,000 zero accounts the program owns at each mark size, old (12, 16) and new (13, 17), match no bucket: the restore and the settle read every bucket under 1 MiB and return the right notes", async () => {
  const { chain, l0 } = restorePool();
  const r = rvPrng(9);
  const strangers = [12, SPENT_LEN, 16, PRE_LEN].flatMap((size) => Array.from({ length: 5_000 }, () => [rvKey(r), new Uint8Array(size)] as [string, Uint8Array]));
  const zero: Chain = { ...chain, marks: new Map([...chain.marks!, ...strangers]) };
  const sts: RvStat[] = [];
  const two = (c: Chain): [SolanaRpc, SolanaRpc] => {
    const st = [rvStat(), rvStat()];
    sts.push(...st);
    return [rvRpc("https://a.example", rvAt(c, 700), st[0]!), rvRpc("https://b.example", rvAt(c, 700), st[1]!)];
  };
  const notesOf = (x: Awaited<ReturnType<typeof solanaRestoreNotes>>): string => JSON.stringify({ notes: x.notes.map((n) => [refKey(n.ref), n.state, n.leaf.value, n.leaf.leafIndex, n.parent ?? ""]), spends: x.spends }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  const clean = notesOf(await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: two(chain), gap: 4 }));
  const restore = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: two(zero), gap: 4 }).then(notesOf, (e: Error) => `refused: ${e.message}`);
  const a = await reservedDeposit0(l0);
  const settle = await solanaSettleSpent({ seed64: SEED, notes: a.ns, noteId: a.id, program: PROGRAM, rpcs: two(zero) }).then((x) => `${x.kind} ${x.kind === "spent" ? `${refKey(x.change.ref)} ${x.change.leaf?.value} ${x.withdrawn}` : ""}`, (e: Error) => `refused: ${e.message}`);
  const b = await reservedDeposit0(l0);
  const settleClean = await solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, rpcs: two(chain) }).then((x) => `${x.kind} ${x.kind === "spent" ? `${refKey(x.change.ref)} ${x.change.leaf?.value} ${x.withdrawn}` : ""}`, (e: Error) => `refused: ${e.message}`);
  const biggest = Math.max(...sts.map((x) => x.biggest));
  console.log(`# RV-B3 20,000 zero accounts (5,000 each of 12, 13, 16, 17 B): restore ${restore === clean ? "the clean restore's notes" : restore}; settle ${settle} (clean: ${settleClean}); the biggest answer ${biggest} B`);
  assert.ok(biggest < SOLANA_ANSWER_MAX_BYTES / 8, `an answer of ${biggest} B`);
  assert.ok(clean.includes("SPENT"), "the clean restore holds a spent note and its change");
  assert.equal(restore, clean, "the restore with the stranger's accounts returns the clean restore's notes");
  assert.match(settleClean, /^spent /);
  assert.equal(settle, settleClean, "the settle with the stranger's accounts writes the clean settle's change");
});

test("card pool-sol-mark-tag: a record the lister names in a bucket without the program's tag, its first 8 bytes not 0, read so on both RPCs, is refused", async () => {
  const { chain } = restorePool();
  const r = rvPrng(13);
  for (const [size, d] of [[SPENT_LEN, spentData(10_000_000n, 0)], [PRE_LEN, markData(10_000_000n, 1n)]] as const) {
    const bad = d.slice();
    bad[size - 1] = 0;
    const key = rvKey(r);
    const lax: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
      const out = (await rpc(chain, MAINNET)(m, p)) as { value: unknown[] };
      if (m === "getProgramAccounts" && (p[1] as { filters: [{ dataSize: number }] }).filters[0].dataSize === size)
        out.value = [...out.value, { pubkey: key, account: { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: ["", "base64"] } }];
      return out;
    }, { url: "https://l.example" });
    const held: Chain = { ...chain, marks: new Map(chain.marks!).set(key, bad) };
    await assert.rejects(solanaMarksListed(lax, pair(held, held), PROGRAM), new RegExp(`^Error: listed mark ${key}: no record the program wrote$`), `${size} B`);
  }
});

test("sol-marks-scale fold 1 RV-C (point 3): a lister that answers every bucket full, at a slot past the pair's, is refused at its first bucket's read, never left to run until the signal", async () => {
  const { chain } = restorePool();
  const r = rvPrng(10);
  let liarCalls = 0;
  const honest: SolanaRpc = rvRpc("https://a.example", rvAt(chain, 700), rvStat());
  const liar: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m !== "getProgramAccounts") return rpc({ ...chain, slot: Math.max(701, (p[1] as { minContextSlot?: number })?.minContextSlot ?? 0) }, MAINNET)(m, p);
    liarCalls++;
    const f = (p[1] as { filters: Record<string, unknown>[] }).filters;
    const size = (f[0] as { dataSize: number }).dataSize;
    const mc = f.find((x) => "memcmp" in x) as { memcmp: { bytes: string } } | undefined;
    const value: unknown[] = [];
    const row = (d: Uint8Array) => ({ pubkey: rvKey(r), account: { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(d), "base64"] } });
    if (mc === undefined) {
      // main's whole-set read: the honest marks plus as many made-up ones as fit under the cap
      for (const [k, d] of chain.marks!) if (d.length === size) value.push({ pubkey: k, account: { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(d), "base64"] } });
      for (let k = 0; k < 3_000; k++) value.push(row(size === PRE_LEN ? markData(10_000_000n, BigInt(1_000 + k)) : spentData(10_000_000n, 1_000 + k)));
    } else {
      // the bucketed read: every bucket full of made-up marks of its own counters
      const hi = rvB58decode(mc.memcmp.bytes).subarray(0, -1); // the counter's high bytes, without the tag
      let b = 0n;
      for (let i = hi.length - 1; i >= 0; i--) b = b * 256n + BigInt(hi[i]!);
      for (let lo = size === PRE_LEN && b === 0n ? 1 : 0; lo < 256; lo++) {
        const c = b * 256n + BigInt(lo);
        value.push(row(size === PRE_LEN ? markData(10_000_000n, c) : spentData(10_000_000n, Number(c))));
      }
    }
    await new Promise((ok) => setImmediate(ok));
    return { context: { slot: 701 + liarCalls }, value };
  }, { url: "https://b.example" });
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  const out = await rvOut(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: liar, rpcs: [honest, rvRpc("https://c.example", rvAt(chain, 700), rvStat())], gap: 4, lagWait: rvInstant, signal: AbortSignal.timeout(3_000) }));
  const heap1 = process.memoryUsage().heapUsed;
  console.log(`# RV-C liar: ${out} after ${Date.now() - t0} ms; the liar's getProgramAccounts calls ${liarCalls}; heap +${Math.round((heap1 - heap0) / 1e6)} MB`);
  // the pass condition of a fix: the liar is refused on its own answers, never left to run until the signal
  assert.match(out, /^refused: rpc [01]: listed mark \S+ is not on it$/, "the liar ran until the signal");
  assert.equal(liarCalls, 1, "refused at its first bucket");
});

test("sol-marks-scale fold 1 RV-D (point 1): two honest RPCs, marks landing across bucket edges (255/256, 511/512) while they read, each call at its own slot: never refused", async () => {
  // the chain: 250 deposits and 250 releases at slot 1000, then 9 deposits and 5 releases a slot, interleaved, until
  // slot 1030 (530 deposits, 400 releases); every deposit a label leaf and a state leaf, every release a state leaf
  type Ev = { slot: number; kind: "pre" | "spent"; key: string; n: number };
  const r = rvPrng(11);
  const evs: Ev[] = [];
  let D = 0, Rn = 0;
  const land = (slot: number, kind: "pre" | "spent") => evs.push(kind === "pre" ? { slot, kind, key: rvKey(r), n: ++D } : { slot, kind, key: rvKey(r), n: Rn++ });
  for (let k = 0; k < 250; k++) land(1000, "pre"), land(1000, "spent");
  for (let s = 1001; s <= 1030; s++) for (let k = 0; k < 9; k++) { land(s, "pre"); if (k < 5) land(s, "spent"); }
  const snaps = new Map<number, Chain>();
  const snap = (slot: number): Chain => {
    const s = Math.min(slot, 1030);
    let c = snaps.get(s);
    if (c === undefined) {
      const marks = new Map<string, Uint8Array>();
      const state: Entry[] = [], labels: Entry[] = [];
      for (const e of evs) {
        if (e.slot > s) break;
        if (e.kind === "pre") {
          marks.set(e.key, markData(10_000_000n, BigInt(e.n)));
          labels.push({ leaf: BigInt(1_000_000 + e.n), root: 0n, t: 1_800_000_000n });
          state.push({ leaf: BigInt(2_000_000 + e.n), root: 0n, t: 1_800_000_000n });
        } else {
          marks.set(e.key, spentData(10_000_000n, e.n));
          state.push({ leaf: BigInt(3_000_000 + e.n), root: 0n, t: 1_800_000_000n });
        }
      }
      c = { accounts: new Map([...pages(0, state), ...pages(1, labels)]), slot: s, time: () => 1_800_000_005n, marks };
      snaps.set(s, c);
    }
    return c;
  };
  let refusals = 0, restored = 0, marksOk = 0;
  const notes: string[] = [];
  for (let trial = 0; trial < 60; trial++) {
    const rr = rvPrng(100 + trial);
    // (1) one marks read, each call at a slot of its own, not monotone on one RPC (a load-balanced provider)
    const base = [995 + Math.floor(rr() * 30), 995 + Math.floor(rr() * 30)];
    const jitter = (k: number) => (_m: string, min: number): RvSnap => {
      const s = Math.max(min, base[k]! + Math.floor(rr() * 9) - 4);
      return { chain: snap(s), slot: s };
    };
    const ra = rvRpc("https://a.example", jitter(0), rvStat());
    const m = await rvOut(solanaMarksListed(ra, [ra, rvRpc("https://b.example", jitter(1), rvStat())], PROGRAM));
    if (m === "ok") marksOk++;
    else (refusals++, notes.push(`marks trial ${trial}: ${m}`));
    // (2) a whole restore, each RPC's slot moving on by 0-2 a call from its own start
    const cur = [995 + Math.floor(rr() * 25), 995 + Math.floor(rr() * 25)];
    const moving = (k: number) => (_m: string, min: number): RvSnap => {
      cur[k] = Math.max(cur[k]!, min) + Math.floor(rr() * 3);
      return { chain: snap(cur[k]!), slot: cur[k]! };
    };
    const out = await rvOut(solanaRestoreNotes({ seed64: SEED_OTHER, program: PROGRAM, rpcs: [rvRpc("https://a.example", moving(0), rvStat()), rvRpc("https://b.example", moving(1), rvStat())], gap: 4, lagWait: rvInstant }));
    if (out === "ok") restored++;
    else (refusals++, notes.push(`restore trial ${trial}: ${out}`));
  }
  console.log(`# RV-D honest pairs: ${marksOk}/60 marks reads ok, ${restored}/60 restores ok, ${refusals} refused${notes.length ? `: ${notes.slice(0, 3).join(" | ")}` : ""}`);
  assert.equal(refusals, 0);
});

test("sol-marks-scale fold 1 RV-F: a lister's bucket answer of more marks than the bucket holds (two of one counter) is refused before any read", async () => {
  const c = rvPool(300, 10);
  const r = rvPrng(12);
  const liar: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    const f = (p[1] as { filters: Record<string, unknown>[] }).filters;
    const mc = f.find((x) => "memcmp" in x) as { memcmp: { bytes: string } } | undefined;
    const size = (f[0] as { dataSize: number }).dataSize;
    const value: unknown[] = [];
    for (const [k, d] of c.marks!) if (rvMatches(d, f)) value.push({ pubkey: k, account: { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(d), "base64"] } });
    // 2,000 made-up deposit marks, all with counters already taken in bucket 0
    if (size === PRE_LEN && mc !== undefined && rvB58decode(mc.memcmp.bytes).subarray(0, -1).every((x) => x === 0))
      for (let k = 0; k < 2_000; k++) value.push({ pubkey: rvKey(r), account: { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(markData(10_000_000n, BigInt(1 + (k % 255)))), "base64"] } });
    await new Promise((ok) => setImmediate(ok));
    return { context: { slot: 701 }, value };
  }, { url: "https://b.example" });
  const sa = rvStat(), sb = rvStat();
  const out = await rvOut(solanaMarksListed(liar, [rvRpc("https://a.example", rvAt(c, 700), sa), rvRpc("https://b.example", rvAt(c, 700), sb)], PROGRAM));
  console.log(`# RV-F a bucket answer of 2,255 deposit marks in counters 1..255: ${out}; the pair's calls ${sa.calls} + ${sb.calls}`);
  assert.equal(out, "refused: lister: bucket 0 lists 2255 marks, past its 255");
  // the spent marks' one bucket read, never the 2,255 addresses (10 releases: one call each)
  assert.deepEqual([sa.calls, sb.calls], [1, 1]);
});

// RV-C2: the same liar, but it copies every real mark and makes up only the counters past the pool's last, so no counter
// meets a real one: only an answer of the honest RPC at the liar's slot can refute it. The restore and the settle.
function rvRunaway(chain: Chain, r: () => number, count: { n: number }): SolanaRpc {
  return Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m !== "getProgramAccounts") return rpc({ ...chain, slot: Math.max(701, (p[1] as { minContextSlot?: number })?.minContextSlot ?? 0) }, MAINNET)(m, p);
    count.n++;
    const f = (p[1] as { filters: Record<string, unknown>[] }).filters;
    const size = (f[0] as { dataSize: number }).dataSize;
    const mc = f.find((x) => "memcmp" in x) as { memcmp: { bytes: string } };
    const hi = rvB58decode(mc.memcmp.bytes).subarray(0, -1); // the counter's high bytes, without the tag
    let b = 0n;
    for (let i = hi.length - 1; i >= 0; i--) b = b * 256n + BigInt(hi[i]!);
    const value: unknown[] = [];
    const taken = new Set<bigint>();
    for (const [k, d] of chain.marks!) if (rvMatches(d, f)) {
      value.push({ pubkey: k, account: { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(d), "base64"] } });
      const v = new DataView(d.buffer, d.byteOffset, d.length);
      taken.add(size === PRE_LEN ? v.getBigUint64(8, true) : BigInt(v.getUint32(8, true)));
    }
    const last = size === PRE_LEN ? BigInt([...chain.marks!.values()].filter((d) => d.length === PRE_LEN).length) : BigInt([...chain.marks!.values()].filter((d) => d.length === SPENT_LEN).length - 1);
    for (let lo = 0n; lo < 256n; lo++) {
      const c = b * 256n + lo;
      if (c <= last || taken.has(c)) continue;
      value.push({ pubkey: rvKey(r), account: { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(size === PRE_LEN ? markData(10_000_000n, c) : spentData(10_000_000n, Number(c))), "base64"] } });
    }
    await new Promise((ok) => setImmediate(ok));
    return { context: { slot: 701 + count.n }, value };
  }, { url: "https://b.example" });
}
test("sol-marks-scale fold 1 RV-C2 (point 3): a runaway lister (real marks, made-up ones only past the pool's last counter, every bucket full, slots ahead) is refused by the restore and the settle", async () => {
  const { chain, l0 } = restorePool();
  const honest = rvRpc("https://a.example", rvAt(chain, 700), rvStat());
  const c1 = { n: 0 };
  const t0 = Date.now();
  const out = await rvOut(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: rvRunaway(chain, rvPrng(13), c1), rpcs: [honest, rvRpc("https://c.example", rvAt(chain, 700), rvStat())], gap: 4, lagWait: rvInstant, signal: AbortSignal.timeout(3_000) }));
  const ms1 = Date.now() - t0;
  const b = await reservedDeposit0(l0);
  const c2 = { n: 0 };
  const settle = await solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, lister: rvRunaway(chain, rvPrng(14), c2), rpcs: [rvRpc("https://a.example", rvAt(chain, 700), rvStat()), rvRpc("https://c.example", rvAt(chain, 700), rvStat())], lagWait: rvInstant, signal: AbortSignal.timeout(3_000) }).then((x) => x.kind, (e: Error) => `refused: ${e.message}`);
  console.log(`# RV-C2 runaway: restore ${out} after ${ms1} ms (${c1.n} of its calls); settle ${settle} (${c2.n} of its calls)`);
  assert.match(out, /^refused: rpc [01]: listed mark \S+ is not on it$/, "the restore ran until the signal");
  assert.match(settle, /^refused: rpc [01]: listed mark \S+ is not on it$/, "the settle ran until the signal");
  assert.deepEqual([c1.n, c2.n], [1, 1], "refused at the runaway's first bucket");
});

test("sol-marks-scale fold 1 S4, inverted by review P1 of 369a87a8: the settle lists both mark sizes, as a restore does: its count needs every deposit and every release (solanaMarkCounts)", async () => {
  const { chain, l0 } = restorePool();
  const sizes: number[] = [];
  const watched = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m === "getProgramAccounts") sizes.push((p[1] as { filters: [{ dataSize: number }] }).filters[0].dataSize);
    return rpc(chain, MAINNET)(m, p);
  }, { url });
  const a = await reservedDeposit0(l0);
  const out = await solanaSettleSpent({ seed64: SEED, notes: a.ns, noteId: a.id, program: PROGRAM, rpcs: [watched("https://a.example"), watched("https://b.example")] });
  assert.equal(out.kind, "spent");
  assert.deepEqual(sizes, [SPENT_LEN, PRE_LEN], "one bucket of each size, spent marks first");
});

test("sol-marks-scale fold 1 S2: a throw on one RPC, or the caller's abort, stops every marks read: no call after the refusal", async () => {
  // 100 releases: the spent marks' bucket 0 is 10 reads by address on each RPC
  const { chain } = bigPool(300, 100);
  const turns = async (): Promise<void> => {
    for (let k = 0; k < 50; k++) await new Promise((ok) => setImmediate(ok));
  };
  // (1) RPC a fails its first read of the listed marks; RPC b reads on unless the throw on a stops it
  const a: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    await new Promise((ok) => setImmediate(ok));
    if (m === "getMultipleAccounts") throw new Error("RPC error -32000: a's node is down");
    return rpc(chain, MAINNET)(m, p);
  }, { url: "https://a.example" });
  const count = { n: 0 };
  const b: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m === "getMultipleAccounts") count.n++;
    return rpc(chain, MAINNET)(m, p);
  }, { url: "https://b.example" });
  const out = await rvOut(solanaMarksListed(lister(chain), [a, b], PROGRAM, undefined, undefined, rvInstant));
  const at = count.n;
  await turns();
  console.log(`# S2 stop: ${out}; b's reads at the refusal ${at}, after 50 turns ${count.n}`);
  assert.equal(out, "refused: RPC error -32000: a's node is down");
  assert.equal(count.n, at, "b read on after the refusal");
  assert.ok(at <= 2, `b's reads ${at}`);
  // (2) the same throw while b's node lags (-32016 on every call): b's wait for its slot ends at the refusal
  let lagged = 0;
  const lagging: SolanaRpc = Object.assign(async (m: string) => {
    if (m === "getMultipleAccounts") lagged++;
    throw new Error("RPC error -32016: Minimum context slot has not been reached");
  }, { url: "https://b.example" });
  const slotTurn: SolanaLagWait = () => new Promise((ok) => setImmediate(ok));
  assert.equal(await rvOut(solanaMarksListed(lister(chain), [a, lagging], PROGRAM, undefined, undefined, slotTurn)), "refused: RPC error -32000: a's node is down");
  const lagAt = lagged;
  await turns();
  assert.equal(lagged, lagAt, "b's lag wait read on after the refusal");
  assert.ok(lagAt <= 4, `b's calls ${lagAt}`);
  // (3) the caller's abort during the lister's lag wait: refused as aborted, no call after it
  const ctl = new AbortController();
  let afterAbort = 0;
  const watch = (url: string): SolanaRpc => Object.assign(async () => {
    if (ctl.signal.aborted) afterAbort++;
    throw new Error("RPC error -32016: Minimum context slot has not been reached");
  }, { url });
  await assert.rejects(solanaMarksListed(watch("https://l.example"), [watch("https://a.example"), watch("https://b.example")], PROGRAM, ctl.signal, undefined, async () => ctl.abort()), { name: "AbortError" });
  await turns();
  assert.equal(afterAbort, 0);
  // a signal aborted before the read: no call at all
  await assert.rejects(solanaMarksListed(watch("https://l.example"), [watch("https://a.example"), watch("https://b.example")], PROGRAM, ctl.signal, undefined, rvInstant), { name: "AbortError" });
  await turns();
  assert.equal(afterAbort, 0);
});

test("sol-marks-scale fold 1 S2: a throw, the caller's signal: every listener the marks read adds to it is removed, whether the read resolves or is refused", async () => {
  const { chain } = restorePool();
  const ctl = new AbortController();
  const live = new Set<unknown>();
  let added = 0, removed = 0;
  const sig = ctl.signal;
  const add = sig.addEventListener.bind(sig), remove = sig.removeEventListener.bind(sig);
  Object.assign(sig, {
    addEventListener: (type: string, f: EventListenerOrEventListenerObject, o?: AddEventListenerOptions) => (added++, live.add(f), add(type, f, o)),
    removeEventListener: (type: string, f: EventListenerOrEventListenerObject, o?: EventListenerOptions) => (removed++, live.delete(f), remove(type, f, o)),
  });
  // a read that resolves
  const ok = await solanaMarksListed(lister(chain), pair(chain, chain), PROGRAM, sig);
  assert.ok(ok.pre.size > 0);
  // a read that is refused
  const down: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m === "getProgramAccounts") throw new Error("RPC error -32000: the lister's node is down");
    return rpc(chain, MAINNET)(m, p);
  }, { url: "https://l.example" });
  await assert.rejects(solanaMarksListed(down, pair(chain, chain), PROGRAM, sig), /the lister's node is down/);
  assert.deepEqual([added, removed, live.size], [2, 2, 0]);
});

test("sol-marks-scale fold 1 S3: a lister naming one mark in two buckets is refused before the second is read", async () => {
  // the lister lists a stranger's deposit mark (nonce 5, bucket 0) again in its bucket 1 answer
  const { chain } = bigPool(300, 10);
  const k5 = [...chain.marks!].find(([, d]) => d.length === PRE_LEN && new DataView(d.buffer, d.byteOffset).getBigUint64(8, true) === 5n)![0];
  const plain = lister(chain);
  const twice: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    const r = (await plain(m, p)) as { value: { pubkey: string }[] };
    const f = (p[1] as { filters: [{ dataSize: number }, { memcmp: { bytes: string } }] }).filters;
    if (f[0].dataSize === PRE_LEN && base58.decode(f[1].memcmp.bytes)[0] === 1) r.value.push({ pubkey: k5 });
    return r;
  }, { url: "https://l.example" });
  await assert.rejects(solanaMarksListed(twice, pair(chain, chain), PROGRAM), new RegExp(`^Error: lister: mark ${k5} listed twice$`));
});

// review of 369a87a8, P1 (its probe, scratchpad rvq-forge-test.snippet.ts): on that head both mark lists were the
// helper's, so the helper alone could hide the user's spent mark and give its record under a made-up address. Here both
// RPCs' mark lists (getProgramAccounts, the helper's routes) are forged and every other read (the pages, each account
// read by its address) is honest: red at 369a87a8 (settle "unspent", the pass "freed", restore deposit 0 UNSPENT), green
// once the list only names addresses and both RPCs read each one.
test("the mark list alone forged (the user's spent mark under a made-up address, every read by address honest): never unspent", async () => {
  const { chain, l0 } = restorePool();
  const DEADLINE_S = 1_800_000_200n;
  const spent0 = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const marks = new Map(chain.marks!);
  const real = marks.get(spent0)!;
  assert.ok(marks.delete(spent0));
  marks.set(base58.encode(new Uint8Array(32).fill(9)), real);
  const forged: Chain = { ...chain, marks };
  const route = (c: Chain, url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => rpc(m === "getProgramAccounts" ? forged : c, MAINNET)(m, p), { url });
  const routes = (c: Chain): [SolanaRpc, SolanaRpc] => [route(c, "https://a.example"), route(c, "https://b.example")];
  const late: Chain = { ...chain, time: () => DEADLINE_S + 1n };
  const b = await reservedDeposit0(l0);
  await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, rpcs: routes(chain) }));
  assert.deepEqual(await solanaSettleReserved({ seed64: SEED, notes: b.ns, program: PROGRAM, rpcs: routes(late) }), { spent: [], freed: [], held: [b.id] });
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: routes(chain), gap: 4 }));
});

// ---------------------------------------------------------------------------------------- review of a34c1626
// The mainnet wiring: the lister is the helper's marks route, seat 0 of the pair publicnode (read directly), seat 1 the
// helper's keyed route. So the helper alone holds the lister and seat 1; seat 0 is honest in every test below.
const zkey = (k: number): string => {
  const b = new Uint8Array(32).fill(7);
  new DataView(b.buffer).setUint32(0, k);
  return base58.encode(b);
};
const filt = (p: readonly unknown[]) => {
  const f = (p[1] as { filters: [{ dataSize: number }, { memcmp: { bytes: string } }] }).filters;
  return { size: f[0].dataSize, high: base58.decode(f[1].memcmp.bytes) };
};

test("review A1: the helper as lister and seat 1, lying on every method (the user's spent mark hidden, its state page a leaf short, its deadline past): never unspent, never freed, the restore refused", async () => {
  const { chain, l0, shortState } = restorePool();
  const DEADLINE_S = 1_800_000_200n;
  const spent0 = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const marks = new Map(chain.marks!);
  assert.ok(marks.delete(spent0));
  // the helper's view: no spent mark of the user's (null for it by address too), its state page a leaf short
  const helperView: Chain = { ...shortState, marks, time: () => DEADLINE_S + 1_000n };
  const helperSeat = rpc(helperView, { ...MAINNET, url: "https://b.example" });
  const helperLister = rpc(helperView, { ...MAINNET, url: "https://l.example" });
  const honest = rpc({ ...chain, time: () => DEADLINE_S + 1n }, { ...MAINNET, url: "https://a.example" });
  const b = await reservedDeposit0(l0);
  await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, lister: helperLister, rpcs: [honest, helperSeat] }), exactly(`Error: ${marksAre(5, 1, [7, 5], [6, 5])}`));
  assert.deepEqual(await solanaSettleReserved({ seed64: SEED, notes: b.ns, program: PROGRAM, lister: helperLister, rpcs: [honest, helperSeat] }), { spent: [], freed: [], held: [b.id] });
  assert.equal((await b.ns.get(b.id))!.state, "RESERVED");
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: helperLister, rpcs: [honest, helperSeat], gap: 4 }), exactly(`Error: ${marksAre(5, 1, [7, 5], [6, 5])}`));
});

test("review A2: the helper lists a real zeroed 13-byte account in place of the user's spent mark (passed over on both RPCs): the count refuses, seat 1 honest or a leaf short", async () => {
  const { chain, l0, shortState } = restorePool();
  const DEADLINE_S = 1_800_000_200n;
  const spent0 = solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).nullifierHash);
  const z = zkey(1);
  // the true chain also holds a stranger's zeroed account (anyone can make one)
  const real: Chain = { ...chain, marks: new Map(chain.marks!).set(z, new Uint8Array(SPENT_LEN)), time: () => DEADLINE_S + 1n };
  const plain = rpc(real, { ...MAINNET, url: "https://l.example" });
  const swap: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    const r = (await plain(m, p)) as { value: { pubkey: string }[] };
    if (m !== "getProgramAccounts") return r;
    const { size, high } = filt(p);
    if (size === SPENT_LEN && high[0] === 0 && high[1] === 0 && high[2] === 0) r.value = [...r.value.filter((x) => x.pubkey !== spent0), { pubkey: z }];
    return r;
  }, { url: "https://l.example" });
  const honest = rpc(real, { ...MAINNET, url: "https://a.example" });
  for (const [name, seat, counts1] of [["seat 1 honest", rpc(real, { ...MAINNET, url: "https://b.example" }), [7, 5]], ["seat 1 a state leaf short", rpc({ ...shortState, marks: real.marks!, time: real.time }, { ...MAINNET, url: "https://b.example" }), [6, 5]]] as const) {
    const b = await reservedDeposit0(l0);
    await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, lister: swap, rpcs: [honest, seat] }), exactly(`Error: ${marksAre(5, 1, [7, 5], counts1)}`), name);
    assert.deepEqual(await solanaSettleReserved({ seed64: SEED, notes: b.ns, program: PROGRAM, lister: swap, rpcs: [honest, seat] }), { spent: [], freed: [], held: [b.id] }, name);
    await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: swap, rpcs: [honest, seat], gap: 4 }), exactly(`Error: ${marksAre(5, 1, [7, 5], counts1)}`), name);
  }
});

test("review A3: the helper invents a deposit mark, or changes the user's own one's value, on its own seat: seat 0 lacks it, or the bytes differ", async () => {
  const { chain } = restorePool();
  const fake = zkey(2);
  const helperInv: Chain = { ...chain, marks: new Map(chain.marks!).set(fake, markData(99_000_000n, 6n)) };
  const honest = rpc(chain, { ...MAINNET, url: "https://a.example" });
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: rpc(helperInv, { ...MAINNET, url: "https://l.example" }), rpcs: [honest, rpc(helperInv, { ...MAINNET, url: "https://b.example" })], gap: 4 }), exactly(`Error: rpc 0: listed mark ${fake} is not on it`));
  // the user's own deposit mark (deposit 0, 50,000,000) served as 500,000,000 by the helper's seat
  const own = solanaMarkOf(PROGRAM, "pre", noteSecrets(SEED, { kind: "deposit", s: SCOPE, i: 0 }).precommitment);
  const changed: Chain = { ...chain, marks: new Map(chain.marks!).set(own, markData(500_000_000n, 2n)) };
  await assert.rejects(solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: rpc(chain, { ...MAINNET, url: "https://l.example" }), rpcs: [honest, rpc(changed, { ...MAINNET, url: "https://b.example" })], gap: 4 }), exactly(`Error: listed mark ${own}: the two RPCs' bytes differ`));
});

test("review P2-1: a lister naming the same 256 real zeroed accounts in every bucket is refused within its first two lists, the settle and the restore alike (the walk ends on counted marks)", { timeout: 10_000 }, async () => {
  const { chain, l0 } = restorePool();
  // 256 zeroed 13-byte accounts the program owns, really on chain (both RPCs hold them): about 0.18 SOL of rent, once
  const zs = Array.from({ length: 256 }, (_, k) => zkey(1_000 + k));
  const marks = new Map(chain.marks!);
  for (const k of zs) marks.set(k, new Uint8Array(SPENT_LEN));
  const real: Chain = { ...chain, marks };
  for (const run of ["settle", "restore"] as const) {
    const logs: string[][] = [[], []];
    let lists = 0;
    const liar: SolanaRpc = Object.assign(async (m: string) => {
      await new Promise((ok) => setImmediate(ok));
      assert.equal(m, "getProgramAccounts");
      lists++;
      return { context: { slot: real.slot }, value: zs.map((pubkey) => ({ pubkey })) };
    }, { url: "https://l.example" });
    const rpcs: [SolanaRpc, SolanaRpc] = [rpc(real, { ...MAINNET, url: "https://a.example" }, logs[0]), rpc(real, { ...MAINNET, url: "https://b.example" }, logs[1])];
    const b = await reservedDeposit0(l0);
    const p = run === "settle" ? solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, lister: liar, rpcs }) : solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: liar, rpcs, gap: 4 });
    // the spent marks' bucket 0: 256 zeroed, counted 0, the walk ends; the deposit marks' bucket 0: 256 past its 255
    await assert.rejects(p, exactly("Error: lister: bucket 0 lists 256 marks, past its 255"), run);
    assert.equal(lists, 2, run);
    assert.deepEqual(logs.map((l) => l.filter((x) => x === "getMultipleAccounts").length), [26, 26], run);
    assert.equal((await b.ns.get(b.id))!.state, "RESERVED");
  }
});

test("review M6d: a real deposit mark of 4,294,967,296 lamports (its first 4 bytes 0, its 5th 1) is counted, never passed over as zeroed", async () => {
  const { withDeposit } = restorePool();
  const P = big(R.deposits[1]!.precommitment);
  const c = withDeposit(P, 4_294_967_296n, 700);
  const key = solanaMarkOf(PROGRAM, "pre", P);
  assert.deepEqual([...c.marks!.get(key)!.subarray(0, 8)], [0, 0, 0, 0, 1, 0, 0, 0]);
  const m = await solanaMarksListed(lister(c), pair(c, c), PROGRAM);
  assert.deepEqual(m.pre.get(key), { value: 4_294_967_296n, nonce: 6n });
  // the restore's count closes only with it counted: 6 deposits and 2 releases, as the pages hold
  const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: lister(c), rpcs: pair(c, c), gap: 4 });
  assert.equal(r.notes.length, 5);
});

test("review M15: the reserved pass reads the marks at or past the slots its block time came from: a node that would serve the marks and pages from before the spend never frees the note", async () => {
  const { chain, beforeSpend, l0 } = restorePool();
  const DEADLINE_S = 1_800_000_200n;
  const late: Chain = { ...chain, time: () => DEADLINE_S + 1n };
  const lateBefore: Chain = { ...beforeSpend, time: () => DEADLINE_S + 1n };
  // a node whose finalized slot and time are past the deadline, but which answers any read not held to that slot from
  // its view before the user's release (slot 697: no spent mark, no change leaf)
  const lagging = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m === "getSlot" || m === "getBlockTime") return rpc(late, MAINNET)(m, p);
    const min = (p[1] as { minContextSlot?: number } | undefined)?.minContextSlot ?? 0;
    return rpc(min >= late.slot ? late : lateBefore, MAINNET)(m, p);
  }, { url });
  const b = await reservedDeposit0(l0);
  assert.deepEqual(await solanaSettleReserved({ seed64: SEED, notes: b.ns, program: PROGRAM, lister: lagging("https://l.example"), rpcs: [lagging("https://a.example"), lagging("https://b.example")] }), { spent: [b.id], freed: [], held: [] });
  assert.equal((await b.ns.get(b.id))!.state, "SPENT");
});

// A pool where a deposit lands while the settle reads: the lister, the pair's mark reads and the pages all see the
// world `w`; the first pages read of each list moves the world on one deposit (until `lands` have landed), before it
// answers, so that read's pages count one deposit more than the list did.
function landingReads(world: (w: number) => Chain, lands: number) {
  let w = 0;
  let landed = 0;
  let listing = 0;
  let landedFor = -1;
  const log = { lists: 0, pages: [0, 0], marks: [0, 0] };
  const lister: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    assert.equal(m, "getProgramAccounts");
    const { size, high } = filt(p);
    if (size === SPENT_LEN && high[0] === 0 && high[1] === 0 && high[2] === 0) listing++;
    log.lists++;
    return rpc(world(w), MAINNET)(m, p);
  }, { url: "https://l.example" });
  const seat = (k: 0 | 1, url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    const pagesRead = m === "getMultipleAccounts" && (p[0] as string[]).includes(solanaPageOf(PROGRAM, 0, 0));
    if (pagesRead) {
      log.pages[k]!++;
      if (landed < lands && landedFor !== listing) (landedFor = listing), landed++, w++;
    } else if (m === "getMultipleAccounts") log.marks[k]!++;
    return rpc(world(w), MAINNET)(m, p);
  }, { url });
  return { lister, rpcs: [seat(0, "https://a.example"), seat(1, "https://b.example")] as [SolanaRpc, SolanaRpc], log };
}

test("review P2-2 (C2): a stranger's deposit landing between the marks and the pages: the settle lists the marks again past the pages and closes (SPENT with its change), never refused", async () => {
  const { chain, l0, withDeposit } = restorePool();
  const after = withDeposit(big(R.deposits[1]!.precommitment), 10_000_000n, chain.slot + 1);
  const r = landingReads((w) => (w === 0 ? chain : after), 1);
  // the lister a slot behind the pages unless asked for their slot: it lists the new deposit only when the settle asks
  // at or past the slot the pages were read at
  const behind: SolanaRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    const min = (p[1] as { minContextSlot?: number }).minContextSlot ?? 0;
    return min >= after.slot ? r.lister(m, p) : rpc(chain, MAINNET)(m, p);
  }, { url: "https://l.example" });
  const b = await reservedDeposit0(l0);
  const s = await solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, lister: behind, rpcs: r.rpcs });
  assert.equal(s.kind, "spent");
  assert.equal((await b.ns.get(b.id))!.state, "SPENT");
  // the second list (spent then pre, one bucket each) at the pages' slot; the pages twice; it reads only the new mark
  assert.deepEqual(r.log, { lists: 2, pages: [2, 2], marks: [1 + 1 + 1, 1 + 1 + 1] });
});

test("review P2-2: a deposit landing inside every read: the settle reads on, then closes once the pool is quiet, or refuses after SOL_SETTLE_ROUNDS reads of the pages (held, never freed)", async () => {
  const l = vaultLabelOf(keccak_256, SCOPE, 2n);
  const worlds = memo((w) => depositsChain([...OURS, ...Array.from({ length: w }, (_, k) => FOREIGN(k))], 700 + w));
  // three landings, each inside one read: the fourth read of the pages closes
  const quiet = landingReads(worlds, 3);
  const a = await reservedDeposit0(l);
  assert.deepEqual(await solanaSettleSpent({ seed64: SEED, notes: a.ns, noteId: a.id, program: PROGRAM, lister: quiet.lister, rpcs: quiet.rpcs }), { kind: "unspent" });
  assert.deepEqual(quiet.log.pages, [4, 4]);
  // one inside every read: refused after the last round, with its numbers; nothing written
  const busy = landingReads(worlds, Infinity);
  const b = await reservedDeposit0(l);
  await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: b.ns, noteId: b.id, program: PROGRAM, lister: busy.lister, rpcs: busy.rpcs }), /^Error: restore: the lister listed 10 deposits and 0 releases/);
  assert.deepEqual(busy.log.pages, [SOL_SETTLE_ROUNDS, SOL_SETTLE_ROUNDS]);
  assert.equal((await b.ns.get(b.id))!.state, "RESERVED");
  assert.equal((await b.ns.list()).length, 1);
  // a quiet pool and a lister hiding one deposit: its list again gives no new mark, so the count cannot close and the
  // settle refuses at once: one read of the pages and one list again, never reading on to the last round
  const quiet0 = worlds(2);
  const hidden = landingReads(() => ({ ...quiet0, marks: new Map([...quiet0.marks!].filter(([k]) => k !== solanaMarkOf(PROGRAM, "pre", FOREIGN(1)[0]))) }), 0);
  const pagesRead = [0, 0];
  const pair2 = ([0, 1] as const).map((k) => Object.assign(async (m: string, p: readonly unknown[]) => {
    if (m === "getMultipleAccounts" && (p[0] as string[]).includes(solanaPageOf(PROGRAM, 0, 0))) pagesRead[k]!++;
    return rpc(quiet0, MAINNET)(m, p);
  }, { url: k === 0 ? "https://a.example" : "https://b.example" })) as [SolanaRpc, SolanaRpc];
  const c = await reservedDeposit0(l);
  await assert.rejects(solanaSettleSpent({ seed64: SEED, notes: c.ns, noteId: c.id, program: PROGRAM, lister: hidden.lister, rpcs: pair2 }), /^Error: restore: the lister listed 4 deposits and 0 releases/);
  assert.deepEqual([pagesRead, hidden.log.lists], [[1, 1], 4]);
});

test("review P2-2 (C1): with the page's cache a second settle makes a few reads at any pool size, and a restore after it reads no mark again", { timeout: 120_000 }, async () => {
  const out: string[] = [];
  for (const [nPre, nSpent] of [[200, 200], [1_000, 1_000], [2_500, 2_500]] as const) {
    const { chain, label } = bigPool(nPre, nSpent);
    const logs: string[][] = [[], [], []];
    const rpcs: [SolanaRpc, SolanaRpc] = [counted(chain, "https://a.example", logs[0]!), counted(chain, "https://b.example", logs[1]!)];
    const l = counted(chain, "https://l.example", logs[2]!);
    const w = await openWalletStore({ indexedDB: new IDBFactory() });
    const ns = await openNoteStore(w);
    stores.push(ns, w);
    const ref = { kind: "deposit", s: SCOPE, i: 0 } as const;
    const P0 = noteSecrets(SEED, ref).precommitment;
    let n = await ns.add({ ref, scope: SCOPE, precommitment: P0, state: "UNSPENT", leaf: { value: 50_000_000n, label, commitment: noteCommitment(50_000_000n, label, P0), leafIndex: BigInt(nPre - 1 + nSpent - 1) } });
    n = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 1_800_000_200_000n, context: "1" });
    n = await ns.move(n.id, "HELD", "RESERVED", { attempt: n.attempt! });
    const count = () => [logs[0]!.filter((m) => m === "getMultipleAccounts").length, logs[1]!.filter((m) => m === "getMultipleAccounts").length, logs[2]!.filter((m) => m === "getProgramAccounts").length] as const;
    const cache: SolanaPoolCache = {};
    assert.equal((await solanaSettleSpent({ seed64: SEED, notes: ns, noteId: n.id, program: PROGRAM, lister: l, rpcs, cache })).kind, "spent");
    const c1 = count();
    assert.equal((await solanaSettleSpent({ seed64: SEED, notes: ns, noteId: n.id, program: PROGRAM, lister: l, rpcs, cache })).kind, "spent");
    const c2 = count();
    const marks = nPre + nSpent;
    out.push(`${marks} marks: settle 1 getMultipleAccounts ${c1[0]} / ${c1[1]}, lists ${c1[2]}; settle 2 +${c2[0] - c1[0]} / +${c2[1] - c1[1]}, lists +${c2[2] - c1[2]}`);
    // the first reads every mark once on each seat; the second, the newest page of each tree and the newest bucket of
    // each mark size: the same few reads at 400 marks and at 5,000
    assert.ok(c1[0] >= marks / 10 && c1[1] >= marks / 10);
    assert.deepEqual([c2[0] - c1[0], c2[1] - c1[1], c2[2] - c1[2]], [1, 1, 2], `${marks} marks`);
    // a restore on the same cache: every mark held, so no mark is read again, only the newest bucket of each size listed
    const r = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, lister: l, rpcs, gap: 4, cache });
    assert.deepEqual([r.notes.length, r.notes.filter((x) => x.state === "SPENT").length], [2, 1]);
    const c3 = count();
    assert.deepEqual([c3[0] - c2[0], c3[1] - c2[1], c3[2] - c2[2]], [1, 1, 4], `${marks} marks: the restore's newest pages once, and its two lists of the newest buckets`);
  }
  console.log(`# reads per seat: ${out.join("; ")}`);
});
