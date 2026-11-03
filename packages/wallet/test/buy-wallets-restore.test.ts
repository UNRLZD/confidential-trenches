// node --test packages/wallet/test/buy-wallets-restore.test.ts (card wallet-per-buy): the whole Solana restore from the
// 12 words, through solanaRestoreWallets, on a pool whose notes were spent the way the proof queue spends them: a
// deposit note part-released, its change note released again, and the move note, the V second arrival and the return
// note that release brought back, each released at the queue's j. Every spent note's W is listed at the (l, j) the queue
// paid. The fake RPC answers the reads ./solana-restore.ts makes, as pool-solana.test.ts's does (kept apart from that
// file, which card sol-restore-race is changing). Test notes only, never money; no key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, base64 } from "@scure/base";
import { VaultTree, vaultLabelOf, type SolanaRpc } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { SOL_MARK_TAG, solanaMarkOf } from "../src/pool/solana-restore.ts";
import { solanaPageOf, solanaPoolOf } from "../src/pool/solana.ts";
import { solanaRestoreWallets, type HoldingsReader } from "../src/pool/buy-wallets.ts";
import { jOf } from "../src/pool/queue.ts";

const PROGRAM = base58.encode(new Uint8Array(32).fill(3)); // a test program id
const SCOPE = solanaPoolOf(PROGRAM).scope;
const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const be32 = (x: bigint): Uint8Array => Uint8Array.from(x.toString(16).padStart(64, "0").match(/../g)!.map((b) => parseInt(b, 16)));
const u64s = (...xs: bigint[]): Uint8Array => {
  const b = new Uint8Array(8 * xs.length);
  xs.forEach((x, i) => new DataView(b.buffer).setBigUint64(8 * i, x, true));
  return b;
};

type Entry = { leaf: bigint; root: bigint; t: bigint };
function entries(leaves: readonly { leaf: bigint; t: bigint }[]): Entry[] {
  const tree = new VaultTree();
  return leaves.map(({ leaf, t }) => (tree.append([leaf]), { leaf, root: tree.root!, t }));
}
// one tree's page accounts, as the program's src/state.rs writes them
function pages(tree: 0 | 1, es: readonly Entry[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (let p = 0; p * 1024 < es.length; p++) {
    const part = es.slice(p * 1024, (p + 1) * 1024);
    const b = new Uint8Array(16 + 72 * part.length);
    b.set(new TextEncoder().encode("bfpage01"), 0);
    b[8] = tree;
    new DataView(b.buffer).setUint32(9, p, true);
    part.forEach((e, k) => {
      const at = 16 + 72 * k;
      b.set(be32(e.leaf), at);
      b.set(be32(e.root), at + 32);
      new DataView(b.buffer).setBigInt64(at + 64, e.t, true);
    });
    out.set(solanaPageOf(PROGRAM, tree, p), b);
  }
  return out;
}
type Chain = { accounts: Map<string, Uint8Array>; slot: number; marks: Map<string, Uint8Array> };
function rpc(c: Chain, url: string): SolanaRpc {
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const ctx = { slot: c.slot };
    if (method === "getMultipleAccounts")
      return { context: ctx, value: (params[0] as string[]).map((a) => (c.accounts.has(a) ? { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(c.accounts.get(a)!), "base64"] } : null)) };
    if (method === "getProgramAccounts") {
      const size = (params[1] as { filters: { dataSize: number }[] }).filters[0]!.dataSize;
      return { context: ctx, value: [...c.marks].filter(([, b]) => b.length === size).map(([pubkey, b]) => ({ pubkey, account: { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(b), "base64"] } })) };
    }
    throw new Error(`unexpected ${method}`);
  };
  return Object.assign(f, { url });
}

test("the whole Solana restore lists the W of every spent note: change, move, V second arrival and return, each at the queue's j", async () => {
  const P = (ref: NoteRef) => noteSecrets(SEED, ref).precommitment;
  const state: { leaf: bigint; t: bigint }[] = [];
  const labels: { leaf: bigint; t: bigint }[] = [];
  const marks = new Map<string, Uint8Array>();
  let t = 1_800_000_000n;
  const deposit = (ref: NoteRef, value: bigint): bigint => {
    const nonce = BigInt(labels.length + 1);
    const label = vaultLabelOf(keccak_256, SCOPE, nonce);
    labels.push({ leaf: label, t });
    state.push({ leaf: noteCommitment(value, label, P(ref)), t });
    // the precommitment mark: value u64 LE, nonce u64 LE, the program's tag
    marks.set(solanaMarkOf(PROGRAM, "pre", P(ref)), Uint8Array.of(...u64s(value, nonce), SOL_MARK_TAG));
    t += 1n;
    return label;
  };
  // a release as the queue makes it: the spent mark, and change note (l, jOf(ref)) of what is left
  const release = (ref: NoteRef, l: bigint, value: bigint, withdrawn: bigint): void => {
    // the spent mark (M376): withdrawnValue u64 LE, then the release's number u32 LE, the state tree's size less the
    // label tree's before its change note goes in, then the program's tag
    const number = new Uint8Array(4);
    new DataView(number.buffer).setUint32(0, state.length - labels.length, true);
    marks.set(solanaMarkOf(PROGRAM, "spent", noteSecrets(SEED, ref).nullifierHash), Uint8Array.of(...u64s(withdrawn), ...number, SOL_MARK_TAG));
    state.push({ leaf: noteCommitment(value - withdrawn, l, P({ kind: "change", l, j: jOf(ref) })), t: (t += 1n) });
  };
  const dep: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
  const l0 = deposit(dep, 50_000_000n);
  release(dep, l0, 50_000_000n, 20_000_000n); // change (l0, 0) of 30,000,000
  release({ kind: "change", l: l0, j: 0 }, l0, 30_000_000n, 10_000_000n); // change (l0, 1) of 20,000,000, unspent
  const mv: NoteRef = { kind: "move", l: l0, j: 0 }, v0: NoteRef = { kind: "second", id: { id: "V", l: l0, j: 0 }, n: 0 }, rt: NoteRef = { kind: "return", c: "sol", l: l0, j: 0 };
  const lm = deposit(mv, 10_000_000n), lv = deposit(v0, 10_000_000n), lr = deposit(rt, 10_000_000n);
  for (const [ref, l] of [[mv, lm], [v0, lv], [rt, lr]] as const) release(ref, l, 10_000_000n, 6_000_000n);
  const chain: Chain = { accounts: new Map([...pages(0, entries(state)), ...pages(1, entries(labels))]), slot: 700, marks };
  const read: string[] = [];
  const holdings: HoldingsReader = { chain: "sol", read: async (a) => (read.push(a), { native: 1n, tokens: new Map(), unreadable: [] }) };
  const r = await solanaRestoreWallets({ seed64: SEED, program: PROGRAM, rpcs: [rpc(chain, "https://a.example"), rpc(chain, "https://b.example")], holdings, gap: 4 });
  const w = (l: bigint, j: number) => { const x = d.freshWallet(SEED, "sol", l, j); x.secretKey.fill(0); return x.address; };
  const want = [[l0, 0], [l0, 1], [lm, 0], [lv, 0], [lr, 0]] as const;
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.wallets.map((x) => `${x.l}/${x.j}/${x.address}`).sort(), want.map(([l, j]) => `${l}/${j}/${w(l, j)}`).sort());
  assert.deepEqual(read.sort(), want.map(([l, j]) => w(l, j)).sort(), "each W read once");
  assert.equal(r.notes.filter((n) => n.state === "SPENT").length, 5);
});
