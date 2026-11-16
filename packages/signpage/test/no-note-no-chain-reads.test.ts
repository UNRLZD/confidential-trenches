// A device with no note on a chain reads nothing of that chain's pool (card robinhood-note-spendable; release 132's live
// run 43540749124, wallet-passkey-prf: 112 then 63 page errors, every one a fetch to rpc.mainnet.chain.robinhood.com
// refused for a doubled Access-Control-Allow-Origin, on a fresh passkey's account that holds nothing anywhere). The page
// as main.ts builds it, signed in on a store with a seed and no note, with each pool read counted by the chain it reads:
// each RPC of the chain's pool pair (its own provider first, as MAINNET_POOL_RPCS lists it), the helper's route, the pool's
// round (its sync pages the pool's logs from the deploy block on the pair's seats: Robinhood's own provider is the one that
// serves those ranges, ../../wallet/src/pool/evm.ts EVM_LOG_PAGE_BLOCKS_WIDE) and the pool index. The load, then the
// focus, show and visibility events a signed-in tab sees (each a state read since release 132's proof front), read no
// pool of a chain the device holds no note on; a note on Base reads Base's pool and still nothing of Robinhood's. Each
// chain's pool index (the kit's quote reads it, so a buy on a chain the money is not on yet quotes a launchpad hook's
// pool) is synced on a device that holds money anywhere, a Solana note or Cash too, and never on one that holds nothing.
//   node --test test/no-note-no-chain-reads.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { proofFront } from "../src/proof-front.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { testnetPool } = await import("../src/pool-testnet.ts");
const { EVM_LADDER, evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
type EvmPoolPin = import("../../wallet/src/pool/evm.ts").EvmPoolPin;
type EvmRpc = import("../../wallet/src/pool/evm.ts").EvmRpc;
type Chain = "base" | "robinhood";

const closers: (() => unknown)[] = [];
// any fetch that leaves the page past the planted readers, by URL
const leaked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: unknown) => (leaked.push(String(u instanceof Request ? u.url : u)), Promise.reject(new Error("offline")))) as typeof fetch;
afterEach(async () => {
  for (const f of closers.splice(0)) await f();
  leaked.splice(0);
});
after(() => void (globalThis.fetch = realFetch));

const PINS: Record<Chain, EvmPoolPin> = {
  base: Object.freeze({ network: "base-sepolia", pool: "0x00000000000000000000000000000000000B0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n }),
  robinhood: Object.freeze({ network: "robinhood-testnet", pool: "0x00000000000000000000000000000000000F0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n }),
};
// a scope no EVM pin of the page has: a Solana pool's note (the page's own Solana pin is null here, so nothing reads it)
const SOLANA_SCOPE = 0x50111n;
const chainOfPin = (p: EvmPoolPin): Chain => (p.network === PINS.base.network ? "base" : "robinhood");

/** One origin's Web Locks with no other tab: every ask granted at once. */
function soloLocks(): Pick<LockManager, "request" | "query"> {
  return {
    request(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const cb = (typeof a === "function" ? a : b) as (lock: Lock | null) => unknown;
      return Promise.resolve().then(() => cb({ name, mode: "exclusive" } as Lock));
    },
    query: async () => ({ held: [], pending: [] }),
  } as unknown as Pick<LockManager, "request" | "query">;
}
function tabDoc() {
  const on = new Map<string, (() => void)[]>();
  return {
    visibilityState: "visible",
    hasFocus: () => true,
    addEventListener: (type: string, f: () => void) => void on.set(type, [...(on.get(type) ?? []), f]),
    fire(type: string) {
      for (const f of on.get(type) ?? []) f();
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

/** A signed-in page whose store holds a seed and no note, or one on Base or in a Solana pool, every pool read (and each
 *  pool index sync, "index") counted by its chain. */
async function page(noteOn: "base" | "solana" | "named" | "named+solana" | null = null, more: Record<string, unknown> = {}) {
  const w: WalletStore = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  if (noteOn === "named" || noteOn === "named+solana") {
    // a fresh account as the page leaves it at its sign-in: the deposit naming (src/deposit-name.ts nameScope) plans a
    // PLANNED deposit note in every pool's scope, Base's, Robinhood's and Solana's, for the addresses it shows; none
    // holds money
    const seed = wordsToSeed64(entropyToWords(new Uint8Array(16)));
    const ns = await openNoteStore(w);
    for (const scope of [evmPoolScopeOf(PINS.base.pool, 84532n), evmPoolScopeOf(PINS.robinhood.pool, 46630n), SOLANA_SCOPE]) await ns.planDeposit(scope, (ref) => noteSecrets(seed, ref).precommitment);
    ns.close();
  }
  if (noteOn === "base" || noteOn === "solana" || noteOn === "named+solana") {
    // one landed note, in Base's pool or in another pool's scope (a Solana pool's), the published all-zero entropy
    // vector's (a8.json)
    const scope = noteOn === "base" ? evmPoolScopeOf(PINS.base.pool, 84532n) : SOLANA_SCOPE;
    // beside the named notes, index 8: a first plan takes the device's lane, 0-7 (wallet src/store/index.ts:430), so index
    // 0 met the lane-0 PLANNED Solana note one run in 8 (card no-note-test-picks-a-free-index: release 158's queue run
    // 43770188326, "note deposit/327953/0 is already in the store")
    const ref: NoteRef = { kind: "deposit", s: scope, i: noteOn === "named+solana" ? 8 : 0 };
    const label = vaultLabelOf(keccak_256, scope, 1n);
    const pre = noteSecrets(wordsToSeed64(entropyToWords(new Uint8Array(16))), ref).precommitment;
    const ns = await openNoteStore(w);
    await ns.add({ ref, scope, precommitment: pre, state: "UNSPENT", leaf: { value: EVM_LADDER.min, label, commitment: noteCommitment(EVM_LADDER.min, label, pre), leafIndex: 0n } });
    ns.close();
  }
  const reads: Record<Chain, string[]> = { base: [], robinhood: [] };
  const rpc = (chain: Chain, url: string): EvmRpc => Object.assign(async (m: string) => (reads[chain].push(`${url} ${m}`), Promise.reject(new Error("offline"))), { url }) as unknown as EvmRpc;
  const doc = tabDoc();
  const t = testnetPool(
    { store: async () => w, seed64: async () => new Uint8Array(64), signedIn: async () => true },
    {
      prover: { vault: signalsProver(), stop: () => {} },
      pin: null,
      locks: soloLocks(),
      fetch: (async () => Promise.reject(new Error("offline"))) as typeof fetch,
      evmPin: (c) => PINS[c],
      evmRpcs: (c) => (c === "robinhood" ? [rpc(c, "https://rpc.mainnet.chain.robinhood.com"), rpc(c, "https://robinhood.api.pocket.network")] : [rpc(c, "https://base-rpc.publicnode.com"), rpc(c, "https://base.api.pocket.network")]),
      evmHelper: (c) => rpc(c, `https://helper/${c}`),
      evmIndexSync: async (c) => (reads[c].push("index"), Promise.reject(new Error("offline"))),
      evmIndexStore: null,
      evmSync: (p) => ({ events: async () => (reads[chainOfPin(p)].push("round"), Promise.reject(new Error("offline"))) }),
      evmRound: (p) => async () => (reads[chainOfPin(p)].push("round"), Promise.reject(new Error("offline"))),
      evmTurn: { setTimeout: () => 0, clearTimeout: () => {}, visibility: null },
      front: proofFront(soloLocks(), doc, doc, () => {}, () => {}),
      withdrawBuilt: { base: true, robinhood: true },
      ...more,
    } as Parameters<typeof testnetPool>[1],
  );
  closers.push(() => t.signedOut().catch(() => {}));
  return { t, doc, reads };
}
/** The load and what a signed-in tab sees after it: focus, show, a visibility change, each twice, and a state read. */
async function loadAndLook(t: { stateRead(): Promise<void> }, doc: ReturnType<typeof tabDoc>): Promise<void> {
  for (let i = 0; i < 10; i++) await tick();
  for (let k = 0; k < 2; k++) {
    for (const e of ["focus", "pageshow", "visibilitychange"]) doc.fire(e);
    for (let i = 0; i < 10; i++) await tick();
  }
  await t.stateRead();
  for (let i = 0; i < 20; i++) await tick();
}

test("signed in with no note anywhere: the load and the tab's focus, show and visibility read no pool on Base or Robinhood", async () => {
  const { t, doc, reads } = await page();
  await loadAndLook(t, doc);
  const own = reads.robinhood.filter((r) => r.startsWith("https://rpc.mainnet.chain.robinhood.com")).length;
  console.log(`robinhood reads ${reads.robinhood.length} (its own provider ${own}, rounds ${reads.robinhood.filter((r) => r === "round").length}); base reads ${reads.base.length}`);
  assert.deepEqual(reads.robinhood, [], "no Robinhood pool read with no Robinhood note");
  assert.deepEqual(reads.base, [], "no Base pool read with no Base note");
  assert.deepEqual(leaked.filter((u) => /robinhood|base/.test(u)), [], "no fetch to a Base or Robinhood provider");
});

// card evm-tree-reads-only-when-needed: a fresh 0-dollar passkey account on release 157 sent 1,305 Base RPC posts in
// 264 s (1,946 eth_getLogs, publicnode 429 on 11 of 13 screens), most of them both chains' pool index, synced because the
// deposit naming's PLANNED notes counted as money. A PLANNED deposit note is an address shown, never money: the page
// syncs no index and reads no pool on its word, on the load or on the tab's focus, show and visibility
test("a fresh account as its sign-in leaves it (a PLANNED deposit note in every pool's scope): no pool read and no pool index on Base or Robinhood", async () => {
  const { t, doc, reads } = await page("named");
  await loadAndLook(t, doc);
  console.log(`named: base reads ${reads.base.length} (${reads.base.join(", ")}); robinhood reads ${reads.robinhood.length} (${reads.robinhood.join(", ")})`);
  assert.deepEqual(reads.base, [], "no Base pool read nor index sync for an address the page named");
  assert.deepEqual(reads.robinhood, [], "no Robinhood pool read nor index sync for an address the page named");
  assert.deepEqual(leaked.filter((u) => /robinhood|base/.test(u)), [], "no fetch to a Base or Robinhood provider");
});

test("the same named account once it holds money (a Solana note beside its PLANNED ones): both chains' indexes are synced, and neither pool is read", async () => {
  const { t, doc, reads } = await page("named+solana");
  await loadAndLook(t, doc);
  for (const c of ["base", "robinhood"] as const) {
    assert.ok(reads[c].includes("index"), `${c}: its pool index is synced (${reads[c].join(", ")})`);
    assert.deepEqual(reads[c].filter((r) => r !== "index"), [], `${c}: no pool read with only a PLANNED note there`);
  }
});

const pool = (rs: string[]) => rs.filter((r) => r !== "index");

test("signed in with a note on Base alone: Base's pool is read, Robinhood's never; both chains' indexes are synced", async () => {
  const { t, doc, reads } = await page("base");
  await loadAndLook(t, doc);
  assert.ok(pool(reads.base).length > 0, `the note's chain is read (the counters are wired): ${reads.base.join(", ")}`);
  assert.deepEqual(pool(reads.robinhood), [], "no Robinhood pool read with no Robinhood note");
  assert.ok(reads.robinhood.includes("index") && reads.base.includes("index"), "a device holding money syncs every chain's pool index");
  assert.deepEqual(leaked.filter((u) => /robinhood/.test(u)), [], "no fetch to a Robinhood provider");
});

test("signed in with a Solana note alone (or Cash, the vault scope's notes in the same store): Base's and Robinhood's indexes are synced for a buy there, and neither pool is read", async () => {
  const { t, doc, reads } = await page("solana");
  await loadAndLook(t, doc);
  for (const c of ["base", "robinhood"] as const) {
    assert.ok(reads[c].includes("index"), `${c}: its pool index is synced (${reads[c].join(", ")})`);
    assert.deepEqual(pool(reads[c]), [], `${c}: no pool read with no note or record there`);
  }
  assert.deepEqual(leaked.filter((u) => /robinhood|base/.test(u)), [], "no other fetch to a Base or Robinhood provider");
});

// Card robinhood-quote-answers-cold: a fresh account (its named addresses only) syncs no index at its load, and its
// first EVM coin quote starts one from the release's snapshot (public/evm-index/<chain>.json): the sync is handed the
// snapshot as the index it reads on from, so it reads only the blocks past it, and the quote is told once it is served.
// On release 159 and main every cold Robinhood dry quote of such an account ended stale_quote (box run 03:24Z).
test("a fresh account's first Robinhood coin quote starts the chain's index from the release's snapshot; its load starts none", async () => {
  const { evmPoolIndexSnapshotOf } = await import("../../kit/src/checks/evm/pool-index.ts");
  const { evmPoolVenues } = await import("../../kit/src/trade/evm/buy-unpinned.ts");
  const v = evmPoolVenues().robinhood;
  const through = 115_000_000;
  const shipped = { v: 1 as const, chainId: v.chainId, poolManager: v.poolManager!.toLowerCase(), from: through - 9_999_999, through, head: { number: through + 7_119, hash: "0x" + "ab".repeat(32) }, spans: [[through - 9_999_999, through] as const], pools: [] };
  const prevs: (number | null)[] = [];
  let snapshots = 0;
  const { t, doc, reads } = await page("named", {
    evmPin: (c: Chain) => (c === "robinhood" ? Object.freeze({ ...PINS.robinhood, network: "robinhood" }) : PINS[c]),
    evmIndexSnapshot: async () => (snapshots++, JSON.parse(JSON.stringify(evmPoolIndexSnapshotOf(shipped as never)))),
    evmIndexSync: async (c: Chain, prev: { through: number } | null) => {
      reads[c].push("index");
      prevs.push(prev?.through ?? null);
      const n = through + 20_000;
      return { index: { ...shipped, through: n - 7_119, head: { number: n, hash: "0x" + "cd".repeat(32) }, spans: [[shipped.from, n - 7_119]] }, coversThrough: n, pools: [], error: null, stats: {} };
    },
  });
  await loadAndLook(t, doc);
  assert.deepEqual(reads.robinhood, [], "the load synced Robinhood's index");
  assert.equal(snapshots, 0, "the load read the snapshot");
  const ready = (t as unknown as { evmIndexReady?: (c: Chain) => Promise<boolean> }).evmIndexReady;
  assert.equal(typeof ready, "function", "the page has no evmIndexReady");
  assert.equal(await ready!("robinhood"), true);
  assert.deepEqual(prevs, [through], "the sync was not started from the snapshot");
  // served: a second quote neither syncs nor reads the snapshot again
  assert.equal(await ready!("robinhood"), true);
  assert.equal(snapshots, 1);
  assert.deepEqual(prevs, [through]);
});
