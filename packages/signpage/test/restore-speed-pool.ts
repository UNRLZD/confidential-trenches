// The pinned Solana pool of the restore's speed measure (card restore-shows-the-balance-in-seconds), shared by the node
// measure (test/restore-speed.test.ts) and the browser run (scripts/restore-speed-browser.mjs): the pool's mark and page
// accounts byte for byte as deposit.rs and release.rs write them, for the all-zero test seed's 8 notes (3 deposits, each
// bought from, 2 sold back), around others' deposits; and one provider's answer to each call the restore makes on it, at
// slot 1,000. Recorded shapes and test values only, never mainnet and never money.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, base64 } from "@scure/base";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import * as d from "../../wallet/src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { SOL_MAINNET_DEPLOY, solanaPageOf, solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { SOL_MARK_TAG, SOL_PRE_MARK_LEN, SOL_SPENT_MARK_LEN, solanaMarkOf } from "../../wallet/src/pool/solana-restore.ts";

/** Each provider's answer comes this long after its call. */
export const RTT_MS = 150;
export const PROGRAM = SOL_MAINNET_DEPLOY.program;
export const SCOPE = solanaPoolOf(PROGRAM).scope;
/** The published all-zero test seed (packages/wallet/test/vectors/a8.json's entropy): test values only. */
export const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
/** The slot every answer is read at. */
export const SLOT = 1_000;
/** The seed's notes in the pool, and how many of them are spent. */
export const NOTES = 8;
export const SPENT = 3;

const be32 = (x: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
};

// ---------- the pool, as deposit.rs and release.rs write it ----------
function pool() {
  const state: { leaf: bigint; t: bigint }[] = [];
  const labels: { leaf: bigint; t: bigint }[] = [];
  const marks = new Map<string, Uint8Array>();
  let t = 1_800_000_000n;
  let releases = 0;
  const P = (ref: NoteRef): bigint => noteSecrets(SEED, ref).precommitment;
  const deposit = (precommitment: bigint, value: bigint): bigint => {
    const nonce = BigInt(labels.length + 1);
    const label = vaultLabelOf(keccak_256, SCOPE, nonce);
    labels.push({ leaf: label, t });
    state.push({ leaf: noteCommitment(value, label, precommitment), t: t++ });
    const m = new Uint8Array(SOL_PRE_MARK_LEN);
    new DataView(m.buffer).setBigUint64(0, value, true);
    new DataView(m.buffer).setBigUint64(8, nonce, true);
    m[16] = SOL_MARK_TAG;
    marks.set(solanaMarkOf(PROGRAM, "pre", precommitment), m);
    return label;
  };
  const release = (nullifierHash: bigint, withdrawn: bigint, change: bigint): void => {
    const m = new Uint8Array(SOL_SPENT_MARK_LEN);
    new DataView(m.buffer).setBigUint64(0, withdrawn, true);
    new DataView(m.buffer).setUint32(8, releases++, true);
    m[12] = SOL_MARK_TAG;
    marks.set(solanaMarkOf(PROGRAM, "spent", nullifierHash), m);
    state.push({ leaf: change, t: t++ });
  };
  // others' deposits around ours, as on a shared pool
  for (let k = 1n; k <= 4n; k++) deposit(k * 7_919n, 15_000_000n);
  // ours: three deposits, each bought from (a release of 10,000,000 with its change note), then two sold back (W's return)
  const values = [50_000_000n, 30_000_000n, 20_000_000n];
  const ls = values.map((v, i) => deposit(P({ kind: "deposit", s: SCOPE, i }), v));
  ls.forEach((l, i) => {
    const ref = { kind: "deposit", s: SCOPE, i } as const;
    release(noteSecrets(SEED, ref).nullifierHash, 10_000_000n, noteCommitment(values[i]! - 10_000_000n, l, P({ kind: "change", l, j: 0 })));
  });
  release(424_242n, 5_000_000n, 99_991n);
  deposit(P({ kind: "return", c: "sol", l: ls[0]!, j: 0 }), 12_000_000n);
  deposit(P({ kind: "return", c: "sol", l: ls[1]!, j: 0 }), 9_000_000n);
  const pages = (tree: 0 | 1, es: readonly { leaf: bigint; t: bigint }[]): [string, Uint8Array][] => {
    const vt = new VaultTree();
    const d = new Uint8Array(16 + 72 * es.length);
    d.set(new TextEncoder().encode("bfpage01"), 0);
    d[8] = tree;
    es.forEach((e, k) => {
      vt.append([e.leaf]);
      const at = 16 + 72 * k;
      d.set(be32(e.leaf), at);
      d.set(be32(vt.root!), at + 32);
      new DataView(d.buffer).setBigInt64(at + 64, e.t, true);
    });
    return [[solanaPageOf(PROGRAM, tree, 0), d]];
  };
  return { accounts: new Map([...pages(0, state), ...pages(1, labels)]), marks };
}
export const POOL = pool();

/** An account as a provider gives it, its data in base64. */
export const solanaAccount = (data: Uint8Array, owner: string = PROGRAM) => ({ owner, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(data), "base64"] });

/**
 * One provider's answer to a call of the restore's (its result, before the JSON-RPC wrapper), at SLOT: the pool's
 * accounts and marks by address (getMultipleAccounts, null for an address it holds none at), and the marks a
 * getProgramAccounts' size and first-bytes filters name. Any other method throws.
 */
export function solanaAnswer(method: string, params: readonly unknown[]): unknown {
  const ctx = { slot: SLOT };
  if (method === "getMultipleAccounts") return { context: ctx, value: (params[0] as string[]).map((a) => { const x = POOL.accounts.get(a) ?? POOL.marks.get(a); return x === undefined ? null : solanaAccount(x); }) };
  if (method === "getProgramAccounts") {
    const [size, cmp] = (params[1] as { filters: [{ dataSize: number }, { memcmp: { bytes: string } }] }).filters;
    const high = base58.decode(cmp.memcmp.bytes);
    return { context: ctx, value: [...POOL.marks].filter(([, x]) => x.length === size.dataSize && high.every((b, i) => x[9 + i] === b)).map(([pubkey, x]) => ({ pubkey, account: solanaAccount(x) })) };
  }
  throw new Error(`unexpected ${method}`);
}
