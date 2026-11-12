// node --test packages/signpage/test/restore-speed.test.ts: how long SIGN_HOST's restore takes from the words accepted to
// the Solana pool's notes in the note store, where state.pools' balance is drawn from them (src/pools.ts), for an account
// of 8 pool notes, 3 buys and 2 sells in the pinned Solana pool (card closed-positions-after-a-restore). Recorded shapes
// only, never mainnet: the pool's mark and page accounts byte for byte as the program writes them, on a fake lister and
// a fake pair that each answer every call RTT_MS later, each held to the page's pacing (solanaPacedRpc at
// SOLANA_KEYLESS_RPC_LIMIT, PAGE_SOL_MARK_BATCHES). The all-zero test seed's notes; test values, never money.
// - The reads: the Solana restore alone at a walk gap of 1, so its time is its round trips (printed: seven in a row, the
//   two sizes' lists one after the other so a lister's refusal stops before the next list, each list's mark reads on
//   both RPCs side by side, the pages on both side by side, then both sizes listed again past the pages).
// - The whole wait: the page's run (poolRestore auto, the real solanaRestoreNotes) beside the two EVM pools mainnet pins,
//   each modelled by its reads (EVM_READS round trips) and then evmRestoreNotes's own walk (8 lanes, walkLaneYielding),
//   all on this one thread as on the page. The bound is relative to this machine: one Solana walk timed alone first.
// RESTORE_SPEED_GAP=10000 runs the whole wait at the production walk gap (RESTORE_GAP) and prints it.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, base64 } from "@scure/base";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore } from "@blindfill/wallet/store";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { solanaPacedRpc, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import * as d from "../../wallet/src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { RESTORE_LANES, slices, walkLaneYielding, withSeed, type SeedUse } from "../../wallet/src/notes/restore.ts";
import { SOL_MAINNET_DEPLOY, solanaPageOf, solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { SOL_MARK_TAG, SOL_PRE_MARK_LEN, SOL_SPENT_MARK_LEN, solanaMarkOf, solanaRestoreNotes } from "../../wallet/src/pool/solana-restore.ts";
import { poolRestore, type RestorePool } from "../src/pool-restore.ts";
import { PAGE_SOL_MARK_BATCHES } from "../src/pool-testnet.ts";

const RTT_MS = 150;
const EVM_READS = 10;
const GAP = Number(process.env.RESTORE_SPEED_GAP ?? 1000);
const PROGRAM = SOL_MAINNET_DEPLOY.program;
const SCOPE = solanaPoolOf(PROGRAM).scope;
const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
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
const POOL = pool();

// one provider: the pool's accounts at slot 1,000, every answer RTT_MS after its call, in the page's pacing
let calls = 0;
function provider(url: string, rtt: number): SolanaRpc {
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    calls++;
    await sleep(rtt);
    const ctx = { slot: 1_000 };
    const acct = (data: Uint8Array) => ({ owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(data), "base64"] });
    if (method === "getMultipleAccounts") return { context: ctx, value: (params[0] as string[]).map((a) => { const x = POOL.accounts.get(a) ?? POOL.marks.get(a); return x === undefined ? null : acct(x); }) };
    if (method === "getProgramAccounts") {
      const [size, cmp] = (params[1] as { filters: [{ dataSize: number }, { memcmp: { bytes: string } }] }).filters;
      const high = base58.decode(cmp.memcmp.bytes);
      return { context: ctx, value: [...POOL.marks].filter(([, x]) => x.length === size.dataSize && high.every((b, i) => x[9 + i] === b)).map(([pubkey, x]) => ({ pubkey, account: acct(x) })) };
    }
    throw new Error(`unexpected ${method}`);
  };
  return solanaPacedRpc(Object.assign(f, { url }));
}
let urls = 0;
const solanaReads = (rtt: number) => {
  const n = urls++;
  return { rpcs: [provider(`https://seat-${n}.example`, rtt), provider(`https://helper-${n}.example`, rtt)] as const, lister: provider(`https://marks-${n}.example`, rtt) };
};

const secs = (ms: number): string => (ms / 1000).toFixed(2);

test("the Solana restore's reads: the marks and pages of 8 notes, 3 buys and 2 sells, timed", async () => {
  const r = solanaReads(RTT_MS);
  const t0 = performance.now();
  const got = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: r.rpcs, lister: r.lister, markBatches: PAGE_SOL_MARK_BATCHES, gap: 1 });
  const ms = performance.now() - t0;
  console.log(`restore-speed reads: ${secs(ms)} s at ${RTT_MS} ms a round trip (${got.notes.length} notes)`);
  assert.equal(got.notes.length, 8);
  assert.equal(got.notes.filter((n) => n.state === "SPENT").length, 3);
});

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));

test("the whole wait: the Solana pool's notes are in the store one Solana walk after its reads, never behind the EVM pools' walks", async () => {
  // one Solana walk on this machine, alone, with no read wait: the yardstick
  const solo = solanaReads(0);
  let t0 = performance.now();
  await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: solo.rpcs, lister: solo.lister, markBatches: PAGE_SOL_MARK_BATCHES, gap: GAP });
  const walkMs = performance.now() - t0;

  const store = await openWalletStore({ name: "restore-speed", indexedDB: new IDBFactory() });
  closers.push(() => store.close());
  const r = solanaReads(RTT_MS);
  const pools: RestorePool[] = [
    { chain: "solana", program: PROGRAM, scope: SCOPE, rpcs: () => r.rpcs, lister: () => r.lister, cache: {}, markBatches: PAGE_SOL_MARK_BATCHES },
    { chain: "evm", pin: { network: "base-sepolia", pool: "0x1", feeRecipient: "0x2", fromBlock: 1n }, scope: 22n, rpcs: () => [] },
    { chain: "evm", pin: { network: "robinhood-testnet", pool: "0x3", feeRecipient: "0x4", fromBlock: 1n }, scope: 33n, rpcs: () => [] },
  ];
  let shown = 0;
  const solanaIn = async (): Promise<void> => {
    if (shown > 0) return;
    const notes = await openNoteStore(store);
    try {
      if ((await notes.list()).filter((n) => n.scope === SCOPE).length === 8) shown = performance.now() - t0;
    } finally {
      notes.close();
    }
  };
  const w = poolRestore({
    store: async () => store,
    seed64: async () => SEED.slice(),
    signedIn: async () => true,
    pools: () => pools,
    ids: null,
    pausesMs: [],
    written: () => void solanaIn(),
    solana: ((a: Parameters<typeof solanaRestoreNotes>[0]) => solanaRestoreNotes({ ...a, gap: GAP })) as never,
    // an EVM pool as evmRestoreNotes runs it with wallets false: its reads, then its walk of 8 lanes on this thread (in
    // the walk's turn when the page gives one), no note of this seed
    evm: (async (a: { seed64: SeedUse; signal?: AbortSignal; turn?: <T>(f: () => Promise<T>) => Promise<T> }) => {
      for (let k = 0; k < EVM_READS; k++) await sleep(RTT_MS);
      const walk = async (): Promise<void> => {
        const m = await withSeed(a.seed64, (s) => d.masters(s, "deposit"));
        const slice = slices(a.signal);
        for (let lane = 0; lane < RESTORE_LANES; lane++) await walkLaneYielding(m, 22n, lane, () => false, GAP, null, a.signal, slice);
      };
      await (a.turn ? a.turn(walk) : walk());
      return { notes: [], spends: [], elsewhere: [], wallets: [], block: 1n };
    }) as never,
  });
  t0 = performance.now();
  const first = w.auto();
  const end = Date.now() + 4 * walkMs + 20_000;
  while (shown === 0 && Date.now() < end) await sleep(20);
  w.signedOut();
  await first.catch(() => {});
  await w.idle();
  console.log(`restore-speed whole wait: Solana notes in the store at ${secs(shown)} s; one Solana walk alone ${secs(walkMs)} s; walk gap ${GAP}, ${RTT_MS} ms a round trip, ${calls} calls`);
  assert.ok(shown > 0, "the Solana notes never reached the store");
  assert.ok(shown < 1.5 * walkMs + 1_000, `the Solana notes reached the store at ${secs(shown)} s, past one Solana walk (${secs(walkMs)} s) and its reads`);
});
