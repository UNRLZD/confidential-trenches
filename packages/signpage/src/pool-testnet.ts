// The pool kinds' pins and providers in the testnet build (card signpage-pool-flow; ../../wallet/src/pool/network.ts).
// - Solana: the devnet pool SOL_POOLS pins in that build, read on two devnet RPCs of different operators, the pair
//   scripts/live-checks/helper-pool-senders.mjs reads the devnet Rent sysvar on (RENT_RPCS.devnet).
// - Base Sepolia and Robinhood testnet: the two RPCs each testnet pin was read on (scripts/live-checks/pool-evm-deploy.mjs
//   CHAINS, card evm-venues-pin), each answered as the app's "base" and "robinhood". A chain is pinned only when the
//   wallet's EVM_POOLS holds its testnet pool, so until then every EVM pool kind is refused, as on mainnet.
// - The flow (card signpage-pool-notes): pool.deposit on the devnet pool (src/pool-deposit.ts), with the page's own
//   note store and seed; every other op is refused until its card. A signed-in load finishes the pool's INCOMING notes,
//   and so does each state read of the page while one is open (card signpage-pool-notes-2), one pass at a time.
// - The next buy's proof (card signpage-pool-notes-2): each landed deposit note runs a pass of the wallet's proof queue
//   (../../wallet/src/pool/queue.ts openProofQueue), opened at the first landing on the page's prover
//   (src/prover-host.ts, its `vault`), its own note store and a copy of the seed, with the devnet pool
//   (../../wallet/src/pool/solana.ts solanaPool: the pin, the two devnet RPCs, the helper's GET /v1/pool/fee). The queue
//   proves only UNSPENT notes, so none for a note still INCOMING. Sign out (this tab's or another's) closes the queue,
//   which frees its notes and zeroes its seed copy, and ends the prover's worker; a landing after it finds no seed.
// main.ts takes these only in the testnet build; SIGN_HOST's build keeps its mainnet deps and carries none of this.
import { solanaJsonRpc, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { HELPER_FETCH_INIT, HELPER_V1_PATHS } from "../../kit/src/helper/v1.ts";
import type { VaultProver } from "../../kit/src/prover/prove.ts";
import type { WalletStore } from "@blindfill/wallet/store";
import { openNoteStore, readNotes, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import { openProofQueue, type ProofQueue, type QueuePass } from "../../wallet/src/pool/queue.ts";
import { poolDepositKind, type PoolDepositHost } from "./pool-deposit.ts";
import { proverHost } from "./prover-host.ts";
import { TRADE_HELPER } from "./trade.ts";
import { SOL_POOLS, solanaPool, solanaPoolOf, type SolanaFeeAnswer } from "../../wallet/src/pool/solana.ts";
import { EVM_POOLS } from "../../wallet/src/pool/evm.ts";
import type { PoolKindsDeps, PoolRpc } from "./pool-kinds.ts";
import type { PoolChain } from "./rules/pool.ts";

// The freezes are marked pure, so SIGN_HOST's build, which never reads these, drops them whole (scripts/build-network.test.mjs).
/** Each chain's two testnet RPCs, as the app names the chain. */
export const TESTNET_RPCS: Readonly<Record<PoolChain, readonly [string, string]>> = /* @__PURE__ */ Object.freeze({
  solana: /* @__PURE__ */ Object.freeze(["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"] as const),
  base: /* @__PURE__ */ Object.freeze(["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"] as const),
  robinhood: /* @__PURE__ */ Object.freeze(["https://rpc.testnet.chain.robinhood.com", "https://robinhood-sepolia-rpc.publicnode.com"] as const),
});
const EVM_TESTNET = /* @__PURE__ */ Object.freeze({ base: "base-sepolia", robinhood: "robinhood-testnet" } as const);

/** The testnet build's deps for poolKinds, with `flow` the ops' flow (none: every checked request is refused). */
export function testnetPoolDeps(flow?: PoolKindsDeps["flow"]): PoolKindsDeps {
  return {
    pinned: (chain) => (chain === "solana" ? SOL_POOLS.devnet !== undefined : EVM_POOLS[EVM_TESTNET[chain]] !== undefined),
    rpcs: (chain) => TESTNET_RPCS[chain].map((u) => solanaJsonRpc(u) as PoolRpc) as unknown as readonly [PoolRpc, PoolRpc],
    ...(flow ? { flow } : {}),
  };
}

/** What the page gives the testnet flow: its wallet store and the seed, each opened when a run needs it. */
export type TestnetPage = { store(): Promise<WalletStore>; seed64(): Promise<Uint8Array> };

/** Tests only: the pool, the prover, the RPCs, the fee's fetch and the thread count the page would use. */
export type TestnetOver = {
  pool?: Pool<unknown>;
  prover?: { vault: VaultProver; stop(): void };
  rpcs?: readonly [SolanaRpc, SolanaRpc];
  fetch?: typeof fetch;
  hardwareConcurrency?: number;
};

const FEE_TIMEOUT_MS = 10_000;

/** GET /v1/pool/fee for the devnet pool and one epoch, as solanaPool's relayFee: the answer as the helper gave it, which
 *  solanaPool's bind refuses unless every field is this pool's, this epoch's and the fee the device computes. */
export async function devnetRelayFee(pool: string, epochStartMs: bigint, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<SolanaFeeAnswer> {
  const url = `${TRADE_HELPER}/v1/pool/fee?cluster=devnet&pool=${encodeURIComponent(pool)}&epoch=${epochStartMs}`;
  const timeout = AbortSignal.timeout(FEE_TIMEOUT_MS);
  const res = await fetchFn(url, { ...HELPER_FETCH_INIT, redirect: "error", method: "GET", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (res.status !== 200) throw new Error(`pool fee: HTTP ${res.status}`);
  // the helper's fee answer is this small (its v1 table's limit for GET /v1/pool/fee); read here, so SIGN_HOST's build,
  // which never calls this, carries no table
  const FEE_ANSWER_MAX = HELPER_V1_PATHS.find((p) => p.method === "GET" && p.path === "/v1/pool/fee")!.limitBytes!;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > FEE_ANSWER_MAX) throw new Error(`pool fee: an answer over ${FEE_ANSWER_MAX} B`);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as SolanaFeeAnswer;
}

export type TestnetPool = {
  /** The pool kinds' flow: pool.deposit on the devnet pool. */
  flow: NonNullable<PoolKindsDeps["flow"]>;
  /** The deposit run's host (a new one per run): its `landed` runs the proof queue's pass. */
  host(): PoolDepositHost;
  /** The INCOMING notes finished (src/pool-deposit.ts settlePoolDeposits), one pass at a time: a signed-in load. */
  settle(): Promise<void>;
  /** A signed-in state read: settle, when a note of the pool is still INCOMING and no pass runs. */
  stateRead(): Promise<void>;
  /** The proof queue's pass, the queue opened first when none is: what each landed note runs. */
  proofs(): Promise<QueuePass | null>;
  /** Sign out: the queue closed (its notes freed, its seed copy zeroed), its note store closed, the worker ended. */
  signedOut(): Promise<void>;
};

/** The testnet build's devnet pool on this page: the deposit flow, its settling and the next buy's proofs. */
export function testnetPool(page: TestnetPage, over: TestnetOver = {}): TestnetPool {
  const pin = SOL_POOLS.devnet;
  const rpcs = (): readonly [SolanaRpc, SolanaRpc] => over.rpcs ?? [solanaJsonRpc(TESTNET_RPCS.solana[0]), solanaJsonRpc(TESTNET_RPCS.solana[1])];
  const prover = over.prover ?? proverHost();

  // the proof queue: opened at the first landing, closed at sign out
  let open: Promise<{ queue: ProofQueue<unknown>; notes: NoteStore }> | null = null;
  const openQueue = async (): Promise<{ queue: ProofQueue<unknown>; notes: NoteStore }> => {
    const notes = await openNoteStore(await page.store());
    let seed64: Uint8Array | null = null;
    try {
      seed64 = await page.seed64();
      const pool = over.pool ?? solanaPool({ pin: pin!, rpcs: rpcs(), relayFee: (e, s) => devnetRelayFee(solanaPoolOf(pin!.program).pool, e, s, over.fetch) });
      const hardwareConcurrency = over.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency;
      return { queue: openProofQueue({ seed64, notes, pool, provers: [prover.vault], hardwareConcurrency }), notes };
    } catch (e) {
      notes.close();
      throw e;
    } finally {
      seed64?.fill(0); // the queue keeps its own copy
    }
  };
  const proofs = async (): Promise<QueuePass | null> => {
    const p = (open ??= openQueue());
    try {
      return await (await p).queue.refresh();
    } catch {
      // a queue that could not open (no seed: signed out) is dropped, so the next landing opens it again
      if (open === p) await p.then(() => {}, () => void (open = null));
      return null;
    }
  };
  const signedOut = async (): Promise<void> => {
    const p = open;
    open = null;
    prover.stop();
    if (!p) return;
    const q = await p.catch(() => null);
    if (!q) return;
    try {
      await q.queue.close();
    } finally {
      q.notes.close();
    }
  };

  const host = (end?: () => void): PoolDepositHost => {
    let notes: NoteStore | null = null;
    return {
      pin: pin!,
      rpcs: rpcs(),
      notes: async () => (notes = await openNoteStore(await page.store())),
      seed64: page.seed64,
      landed: () => void proofs(),
      end: () => {
        notes?.close();
        end?.();
      },
    };
  };

  const deposit = poolDepositKind(() => host());
  let settling: Promise<void> | null = null;
  const settle = (): Promise<void> => {
    if (pin === undefined) return Promise.resolve();
    if (settling) return settling;
    let done!: () => void;
    const p = new Promise<void>((r) => (done = r)).finally(() => {
      if (settling === p) settling = null;
    });
    settling = p;
    const r = poolDepositKind(() => host(done))(null, null);
    // refused before it ran (no Web Locks), or failed before its host was made: no end will come
    if ("error" in r) done();
    else
      void r.after.then(() => {
        const a = r.answer();
        if (a === null || "error" in a) done();
      });
    return p;
  };
  const scope = pin === undefined ? null : solanaPoolOf(pin.program).scope;
  // one state read's pass at a time: set before its first await, so a read that comes while it runs (its note read
  // included) gets the same promise and never starts a second pass. No follow-up pass: a note turns INCOMING only in an
  // ask's run, which holds POOL_DEPOSIT_LOCK and finishes that note itself; a later state read settles what it leaves.
  let reading: Promise<void> | null = null;
  const stateRead = (): Promise<void> => {
    if (scope === null) return Promise.resolve();
    if (reading) return reading;
    const p = (async () => {
      try {
        if (settling) return await settling;
        if ((await readNotes(await page.store())).some((n) => n.state === "INCOMING" && n.scope === scope)) await settle();
      } catch {
        // a state read never fails for this; the next read tries again
      }
    })().finally(() => {
      if (reading === p) reading = null;
    });
    reading = p;
    return p;
  };
  return {
    flow: (ask, ctx) => (ask.kind === "pool.deposit" && ask.chain === "solana" && pin !== undefined ? deposit(ask, ctx) : { error: "not_allowed" }),
    host: () => host(),
    settle,
    stateRead,
    proofs,
    signedOut,
  };
}
