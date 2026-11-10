// The restore kind (card pool-restore-wired, src/pool-restore.ts) through the page's api (src/api.ts startApi), with the
// wallet's real store and note store (fake-indexeddb) and the two pool restores replaced by fixed answers: every pool the
// page pins is read, what they find is written to the note store, the request is answered "started" at once, its
// progress says "reading" within every beat and ends "done", or "stalled" when a pool fails (the others' notes still
// written); one run at a time; auto runs once on an empty note store and never on one with notes; signed out it refuses.
// Each pool walked has its deposit ids read (card wallet-restore-id-reader-wired: restore step 5 through the wallet's
// IdReader) on NEAR answers replayed from mainnet (the wallet's test/vectors/id-reader-mainnet.json): a found id holds
// its lane open, and an id unread on both providers stops the run stalled with the walk's notes written. A pool scope
// whose chain has no U_X reads here ends stalled by name (POOL_CHAIN_UNREAD), never done; one whose chain has them (card
// wallet-restore-reads-ux) reads each id's U_X, carries what covers a deposit and names the rest (the tests at the end);
// the tests of the run itself read no deposit id (ids null) unless they say so. The seed is opened per use only, so
// the seed lock is never held across a read.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { resetPaces } from "../../wallet/src/pace.ts";
// each test's clock starts at its own zero: one pace per provider URL is shared by every reader (card wallet-id-reader-paced)
beforeEach(() => resetPaces());
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { noteCommitment } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, refKey } from "../../wallet/src/notes/store.ts";
import type { RestoredNote } from "../../wallet/src/notes/restore.ts";
import { depositAccount, NEAR_NETWORKS, nearPairNetwork, type NearRpc } from "../../wallet/src/deposit/account.ts";
import type { DepositIds } from "../../wallet/src/restore/wallets.ts";
import { APP_ORIGIN, startApi } from "../src/api.ts";
import * as restoreKind from "../src/pool-restore.ts";
import { idsUndone, lanesOf, pagePools, POOL_CHAIN_UNREAD, poolRestore, RESTORE_BEAT_MS, RESTORE_LOCK, type PoolRestoreHost, type RestorePool } from "../src/pool-restore.ts";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { evmPoolProvidersOf, evmPoolVenues } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { MAINNET_POOL_RPCS, pageEvmPoolUrls } from "../src/pool-testnet.ts";
import { RESTORE_GAP, walkEnd, writeRestored, type SeedUse } from "../../wallet/src/notes/restore.ts";
import { base58, hex } from "@scure/base";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { depositIdEvm } from "../../wallet/src/derive/keys.ts";
import { askOf, solanaPoolFollowDeps, type PoolDepositEnd, type PoolUxReads } from "../src/pool-deposit-follow.ts";
import { TRADE_HELPER } from "../src/trade.ts";

const SOL_SCOPE = 11n;
const EVM_SCOPE = 22n;
const LABEL_S = 101n;
const LABEL_E = 202n;
// a pool's restore answer: a deposit note spent into W, its change note, and a second deposit unspent
const notesOf = (scope: bigint, label: bigint, base: bigint): RestoredNote[] => {
  const d0 = { kind: "deposit" as const, s: scope, i: 0 };
  const P = (k: bigint) => base + k;
  const leaf = (value: bigint, l: bigint, pre: bigint, at: bigint) => ({ value, label: l, commitment: noteCommitment(value, l, pre), leafIndex: at });
  return [
    { ref: d0, scope, precommitment: P(1n), leaf: leaf(10_000n, label, P(1n), 0n), state: "SPENT" },
    { ref: { kind: "deposit", s: scope, i: 1 }, scope, precommitment: P(2n), leaf: leaf(20_000n, label + 1n, P(2n), 1n), state: "UNSPENT" },
    { ref: { kind: "change", l: label, j: 0 }, scope, precommitment: P(3n), leaf: leaf(4_000n, label, P(3n), 2n), state: "UNSPENT", parent: refKey(d0) },
  ];
};
const POOLS: readonly RestorePool[] = [
  { chain: "solana", program: "Prog111", scope: SOL_SCOPE, rpcs: () => [async () => null, async () => null] },
  { chain: "evm", pin: { network: "base-sepolia", pool: "0x1", feeRecipient: "0x2", fromBlock: 1n }, scope: EVM_SCOPE, rpcs: () => [async () => null, async () => null] },
];

// ---------- NEAR, replayed from mainnet ----------
const FAST = NEAR_NETWORKS.mainnet.fastnear[0];
const DRPC = NEAR_NETWORKS.mainnet.drpc;
const REC = JSON.parse(readFileSync(new URL("../../wallet/test/vectors/id-reader-mainnet.json", import.meta.url), "utf8")) as {
  ids: Record<string, string>;
  answers: Record<string, unknown[]>;
  pass: { h: number; hash: string };
  intents: Record<string, { tokens: unknown; held: unknown }>;
};
/** What a deposit id of the restore answers as: one of the recorded mainnet ids, "intents" (never_used's token and account
 *  views with money_intents's tokens inside intents.near: money held only there, a refund left under the id), or "down"
 *  (no answer on either provider). Ids not listed answer as never_used. */
type As = "used_storage" | "used_account" | "money_usdc" | "intents" | "down";
const SEED = (): Uint8Array => new Uint8Array(64).fill(7);
const idOf = (scope: bigint, i: number): string => depositAccount(SEED(), scope, i).account;
const argsOf = (p: Record<string, unknown>): Record<string, unknown> => (typeof p.args_base64 === "string" ? JSON.parse(Buffer.from(p.args_base64, "base64").toString()) : {});
// one provider answering from the record, by its URL and the exact params with the restore's id in place of the recorded
// one it answers as. The chain stands at the recorded pass's block: every final read is its first recorded answer
function replay(url: string, as: ReadonlyMap<string, As>, log: string[]): NearRpc {
  const served = new Map<string, number>();
  return {
    name: url,
    query: async (params) => {
      const args = argsOf(params);
      const u = (params.request_type === "view_account" ? params.account_id : args.account_id) as string;
      let p: Record<string, unknown> = params;
      if (u !== "intents.near") {
        log.push(`${url} ${u}`);
        const x = as.get(u);
        if (x === "down") throw new Error("HTTP 503");
        if (x === "intents" && params.account_id === "intents.near") {
          const rec = REC.intents[url]!;
          const a = structuredClone(params.method_name === "mt_tokens_for_owner" ? rec.tokens : rec.held) as { result: Record<string, unknown> };
          Object.assign(a.result, { block_hash: REC.pass.hash, block_height: REC.pass.h });
          return a;
        }
        const id = REC.ids[x === undefined || x === "intents" ? "never_used" : x]!;
        p = params.request_type === "view_account" ? { ...params, account_id: id } : { ...params, args_base64: Buffer.from(JSON.stringify({ ...args, account_id: id })).toString("base64") };
      }
      const k = `${url} ${JSON.stringify(p)}`;
      const xs = REC.answers[k];
      if (xs === undefined) throw new Error(`no recorded answer for ${JSON.stringify(p)}`);
      if (p.finality === "final") return xs[0];
      const n = served.get(k) ?? 0;
      served.set(k, n + 1);
      return xs[Math.min(n, xs.length - 1)];
    },
  };
}
/** The host's deposit id reads on the replayed pair; `found` keeps each scope's step 5 answer. */
function nearOf(as: ReadonlyMap<string, As> = new Map()) {
  const log: string[] = [];
  const found = new Map<bigint, DepositIds>();
  const ids: NonNullable<PoolRestoreHost["ids"]> = { rpcs: () => [replay(FAST, as, log), replay(DRPC, as, log)], opts: { tries: 1, sleep: async () => {}, now: () => performance.now() }, read: (scope, r) => void found.set(scope, r) };
  return { ids, log, found };
}

let db = 0;
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
async function world(over: Partial<PoolRestoreHost> = {}) {
  const store = await openWalletStore({ name: `restore-${db++}`, indexedDB: new IDBFactory() });
  closers.push(() => store.close());
  const seeds: Uint8Array[] = [];
  const seen: string[] = [];
  const ends: { stage: string; why: readonly string[] }[] = [];
  const host: PoolRestoreHost = {
    store: async () => store,
    seed64: async () => {
      const s = new Uint8Array(64).fill(7);
      seeds.push(s);
      return s;
    },
    signedIn: async () => true,
    pools: () => POOLS,
    ids: null,
    ended: (stage, why) => void ends.push({ stage, why }),
    solana: (async (a: { program: string }) => (seen.push(`solana ${a.program}`), { notes: notesOf(SOL_SCOPE, LABEL_S, 1000n), spends: [] })) as never,
    evm: (async (a: { pin: { network: string }; wallets?: unknown; walletRpcs?: unknown; helper?: unknown }) => (seen.push(`evm ${a.pin.network} wallets ${String(a.wallets)} ${"walletRpcs" in a || "helper" in a ? "with W reads" : "no W reads"}`), { notes: notesOf(EVM_SCOPE, LABEL_E, 2000n), spends: [], elsewhere: [], wallets: [], block: 1n })) as never,
    ...over,
  };
  return { store, host, seeds, seen, ends, r: poolRestore(host) };
}

// the page's api with only the restore kind, as the APP_HOST frame asks it
function api(kind: ReturnType<typeof poolRestore>["kind"]) {
  const posted: { id?: string; type?: string; ok?: boolean; result?: unknown; error?: { code: string }; stage?: string }[] = [];
  const parent = { postMessage: (m: never) => void posted.push(m) };
  let send: (data: unknown) => void = () => {};
  startApi({ parent, listen: (fn) => void (send = (data) => fn({ origin: APP_ORIGIN, source: parent, data })), state: () => ({}) as never, kinds: { restore: kind } });
  const ask = (): string => {
    const id = crypto.randomUUID();
    send({ v: 1, id, type: "restore" });
    return id;
  };
  return { posted, ask };
}
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 3000): Promise<void> => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`never: ${what}`);
};
const opOf = (store: WalletStore, id: string) => store.get("ops", id) as Promise<{ kind: string; stage: string; txs: unknown[]; created_ms: number } | undefined>;
const listed = async (store: WalletStore) => {
  const ns = await openNoteStore(store);
  try {
    return (await ns.list()).map((n) => `${refKey(n.ref)} ${n.state}`).sort();
  } finally {
    ns.close();
  }
};

test("restore: answered started at once; every pinned pool read; the notes written with their states; progress reading then done; the op record ends done", async () => {
  const w = await world();
  const a = api(w.r.kind);
  const id = a.ask();
  await until("done", () => a.posted.some((m) => m.id === id && m.stage === "done"));
  const mine = a.posted.filter((m) => m.id === id);
  assert.deepEqual(mine[0], { v: 1, id, ok: true, result: { stage: "started" } });
  assert.deepEqual(mine.slice(1).map((m) => m.stage), ["reading", "done"]);
  // the EVM restore reads the notes alone: no W named to any provider (review L2)
  assert.deepEqual(w.seen.sort(), ["evm base-sepolia wallets false no W reads", "solana Prog111"]);
  await until("op done", async () => (await opOf(w.store, id))?.stage === "done");
  assert.deepEqual(await opOf(w.store, id).then((o) => o && { kind: o.kind, stage: o.stage, txs: o.txs }), { kind: "restore", stage: "done", txs: [] });
  const want = [...notesOf(SOL_SCOPE, LABEL_S, 1000n), ...notesOf(EVM_SCOPE, LABEL_E, 2000n)].map((n) => `${refKey(n.ref)} ${n.state}`).sort();
  assert.deepEqual(await listed(w.store), want);
  // the seed is zeroed once read
  assert.ok(w.seeds.every((x) => x.every((b) => b === 0)));
  // a second restore writes nothing new and ends done
  const again = a.ask();
  await until("again done", () => a.posted.some((m) => m.id === again && m.stage === "done"));
  assert.deepEqual(await listed(w.store), want);
});

test("restore: progress says reading at least every beat while a pool reads; the kit's 10 s holds", async () => {
  assert.ok(RESTORE_BEAT_MS <= 10_000);
  let release: () => void = () => {};
  const slow = new Promise<void>((r) => (release = r));
  const w = await world({ beatMs: 20, solana: (async () => (await slow, { notes: [], spends: [] })) as never });
  const a = api(w.r.kind);
  const id = a.ask();
  await until("4 reading", () => a.posted.filter((m) => m.id === id && m.stage === "reading").length >= 4);
  release();
  await until("done", () => a.posted.some((m) => m.id === id && m.stage === "done"));
});

test("restore: a pool that fails ends stalled, never done, and the other pool's notes are written; a pin with no reads on the page is a failed pool", async () => {
  const w = await world({ evm: (async () => Promise.reject(new Error("a lag that stays"))) as never });
  const a = api(w.r.kind);
  const id = a.ask();
  await until("stalled", () => a.posted.some((m) => m.id === id && m.stage === "stalled"));
  assert.ok(!a.posted.some((m) => m.id === id && m.stage === "done"));
  assert.deepEqual(await listed(w.store), notesOf(SOL_SCOPE, LABEL_S, 1000n).map((n) => `${refKey(n.ref)} ${n.state}`).sort());
  await until("op stalled", async () => (await opOf(w.store, id))?.stage === "stalled");

  const unread: RestorePool = { chain: "evm", pin: { network: "base", pool: "0x1", feeRecipient: "0x2", fromBlock: 1n }, scope: EVM_SCOPE, rpcs: null };
  const x = await world({ pools: () => [unread] });
  const b = api(x.r.kind);
  const id2 = b.ask();
  await until("stalled", () => b.posted.some((m) => m.id === id2 && m.stage === "stalled"));
  assert.deepEqual(x.seen, []);
});

test("restore: one run at a time; a request while one runs follows it", async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>((r) => (release = r));
  let runs = 0;
  const w = await world({ solana: (async () => (runs++, await slow, { notes: [], spends: [] })) as never });
  const a = api(w.r.kind);
  const one = a.ask();
  const two = a.ask();
  await until("both answered", () => [one, two].every((id) => a.posted.some((m) => m.id === id && m.ok)));
  release();
  await until("both done", () => [one, two].every((id) => a.posted.some((m) => m.id === id && m.stage === "done")));
  assert.equal(runs, 1);
});

test("restore: refused not_allowed with no seed stored, and nothing is read", async () => {
  const w = await world({ signedIn: async () => false });
  const a = api(w.r.kind);
  const id = a.ask();
  await until("answer", () => a.posted.some((m) => m.id === id));
  assert.deepEqual(a.posted.find((m) => m.id === id), { v: 1, id, ok: false, error: { code: "not_allowed" } });
  assert.deepEqual(w.seen, []);
  assert.equal(await opOf(w.store, id), undefined);
});

test("auto: a sign-in on an empty note store runs once under an op of its own; on a store with notes it does not run", async () => {
  const w = await world();
  assert.equal(await w.r.auto(), "done");
  assert.equal(w.seen.length, 2);
  const ops = await w.store.keys("ops");
  assert.equal(ops.length, 1);
  assert.equal((await opOf(w.store, ops[0]!))?.stage, "done");
  // the notes are there now: a later sign-in reads nothing
  assert.equal(await w.r.auto(), null);
  assert.equal(w.seen.length, 2);
});

test("signed out mid-run: the run stops, its seed zeroed, nothing written after", async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>((r) => (release = r));
  const w = await world({ solana: (async (a: { signal: AbortSignal }) => (await slow, a.signal.throwIfAborted(), { notes: notesOf(SOL_SCOPE, LABEL_S, 1000n), spends: [] })) as never });
  const run = w.r.auto();
  await until("reading", async () => (await w.store.keys("ops")).length === 1);
  w.r.signedOut();
  release();
  assert.equal(await run, "stalled");
  assert.deepEqual(await listed(w.store), []);
  assert.ok(w.seeds.every((s) => s.every((b) => b === 0)));
  const [k] = await w.store.keys("ops");
  assert.equal((await opOf(w.store, k!))?.stage, "reading");
});

test("pagePools: the mainnet build pins no pool today, so a restore there reads nothing and ends done", () => {
  assert.deepEqual(pagePools(), []);
});

// review M1: a page closed or reloaded mid-run leaves its record running; the next signed-in load reads it stalled, so
// the app offers Retry; a record whose run still lives (its lock held, in any tab) is left as it is
test("settle: a restore record left started or reading by a dead run is written stalled; a live run's is not; other ops are untouched", async () => {
  const w = await world();
  await w.store.put("ops", "dead-1", { kind: "restore", stage: "reading", txs: [], created_ms: 1 });
  await w.store.put("ops", "dead-2", { kind: "restore", stage: "started", txs: [], created_ms: 1 });
  await w.store.put("ops", "ended", { kind: "restore", stage: "done", txs: [], created_ms: 1 });
  await w.store.put("ops", "sell", { kind: "sell", stage: "sent", txs: [], created_ms: 1 });
  // another tab's live run: it holds its op's lock
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await w.store.put("ops", "live", { kind: "restore", stage: "reading", txs: [], created_ms: 1 });
  void navigator.locks.request(`${RESTORE_LOCK}/live`, { mode: "exclusive" }, () => held);
  await until("held", async () => ((await navigator.locks.query()).held ?? []).some((l) => l.name === `${RESTORE_LOCK}/live`));
  await w.r.settle();
  const stage = async (k: string) => ((await w.store.get("ops", k)) as { stage?: string } | undefined)?.stage;
  assert.deepEqual([await stage("dead-1"), await stage("dead-2"), await stage("ended"), await stage("sell"), await stage("live")], ["stalled", "stalled", "done", "sent", "reading"]);
  release();
  // this tab's own run in flight is not settled either
  let go: () => void = () => {};
  const slow = new Promise<void>((r) => (go = r));
  const x = await world({ solana: (async () => (await slow, { notes: [], spends: [] })) as never });
  const run = x.r.auto();
  await until("op written", async () => (await x.store.keys("ops")).length === 1);
  await x.r.settle();
  const [k] = await x.store.keys("ops");
  assert.notEqual(((await x.store.get("ops", k!)) as { stage?: string }).stage, "stalled");
  go();
  assert.equal(await run, "done");
});

// review L4: a deposit index this page named ahead (a PLANNED note, no money) does not make the store look restored
test("auto: a store holding only PLANNED notes is empty; one with a landed note is not", async () => {
  const w = await world();
  const ns = await openNoteStore(w.store);
  // its precommitment is the seed's for its index, as the page names one: the restore names the same for that index
  await ns.planDeposit(SOL_SCOPE, (ref) => (ref.kind === "deposit" && ref.i < 2 ? 1001n + BigInt(ref.i) : 77n));
  ns.close();
  assert.equal(await w.r.auto(), "done");
  assert.equal(w.seen.length, 2);
});

// review L1: two tabs' runs take the restore lock in turn, so their writes never race on one note
test("two pages' runs on one store take turns: both end done, each note written once", async () => {
  const w = await world();
  const other = poolRestore(w.host);
  const [a, b] = await Promise.all([w.r.auto(), other.auto()]);
  assert.deepEqual([a, b].sort(), ["done", "done"]);
  const want = [...notesOf(SOL_SCOPE, LABEL_S, 1000n), ...notesOf(EVM_SCOPE, LABEL_E, 2000n)].map((n) => `${refKey(n.ref)} ${n.state}`).sort();
  assert.deepEqual(await listed(w.store), want);
});

// the end is posted only once its op record landed: the app reads state.ops after "done" and never reads it behind
test("restore: the op record says the end before the end is posted, however slow the store's write", async () => {
  const w = await world();
  const slow = new Proxy(w.store, {
    get: (t, k) =>
      k === "put" ? (...a: Parameters<WalletStore["put"]>) => new Promise((r) => setTimeout(r, 40)).then(() => t.put(...a)) : Reflect.get(t, k, t),
  }) as WalletStore;
  const x = await world({ store: async () => slow });
  const atEnd: Promise<string | undefined>[] = [];
  const id = crypto.randomUUID();
  const d = x.r.kind({}, { id, progress: (s: string) => void (s === "done" && atEnd.push(opOf(w.store, id).then((o) => o?.stage))) } as never);
  await d.after;
  await until("done posted", () => atEnd.length === 1);
  assert.equal(await atEnd[0], "done");
});

// ---------- restore step 5: the deposit ids (card wallet-restore-id-reader-wired) ----------
// each lane's ids, from its first index to its last read (the ids step 5 must read, in lane order)
const laneIds = (scope: bigint, lane: number, to: number): string[] => {
  const out: string[] = [];
  for (let i = lane; i <= to; i += 8) out.push(idOf(scope, i));
  return out;
};

test("deposit ids: every pool walked has its ids read on both providers at one block; an intents-only id and a used id each hold their lane open 21 more; the run ends stalled, each pool's U_X named unread", async () => {
  const as = new Map<string, As>([
    [idOf(SOL_SCOPE, 24), "intents"], // lane 0, past its note at 0: a refund left inside intents.near only
    [idOf(SOL_SCOPE, 162), "used_storage"], // lane 2, empty: its 21st id, registered on USDC and empty now
    [idOf(EVM_SCOPE, 169), "used_account"], // lane 1, the last of the 21 past its note at 1: a NEAR account, nothing held
  ]);
  const n = nearOf(as);
  const w = await world({ ids: n.ids });
  const a = api(w.r.kind);
  const id = a.ask();
  await until("stalled", () => a.posted.some((m) => m.id === id && m.stage === "stalled"), 20_000);
  assert.ok(!a.posted.some((m) => m.id === id && m.stage === "done"));
  // every id read and every lane at its margin: the only reasons are the two pools' chains, not read for U_X
  assert.deepEqual(w.ends, [{ stage: "stalled", why: [`solana: ${POOL_CHAIN_UNREAD}`, `base-sepolia: ${POOL_CHAIN_UNREAD}`] }]);
  const sol = n.found.get(SOL_SCOPE)!, evm = n.found.get(EVM_SCOPE)!;
  assert.ok(sol && evm, "both pools' ids read");
  assert.equal(sol.complete && evm.complete, true);
  const lane = (x: DepositIds, k: number) => ({ notes: x.lanes[k]!.notes, money: x.lanes[k]!.money, used: x.lanes[k]!.used, unread: x.lanes[k]!.unread.length, highest: x.lanes[k]!.highest, readTo: x.lanes[k]!.readTo });
  // found: the intents-only id is money and the lane reads 21 past it; the used one resets the empty lane's count
  assert.deepEqual(lane(sol, 0), { notes: [0], money: [24], used: [], unread: 0, highest: 24, readTo: 24 + 8 * 21 });
  assert.deepEqual(lane(sol, 1), { notes: [1], money: [], used: [], unread: 0, highest: 1, readTo: 1 + 8 * 21 });
  assert.deepEqual(lane(sol, 2), { notes: [], money: [], used: [162], unread: 0, highest: 162, readTo: 162 + 8 * 21 });
  assert.deepEqual(lane(evm, 1), { notes: [1], money: [], used: [169], unread: 0, highest: 169, readTo: 169 + 8 * 21 });
  for (const k of [3, 4, 5, 6, 7]) for (const x of [sol, evm]) assert.deepEqual(lane(x, k), { notes: [], money: [], used: [], unread: 0, highest: null, readTo: k + 8 * 20 });
  // every id asked is one of the scopes' own lanes, in lane order, up to each lane's last read; nothing else is named
  const asked = [...new Set(n.log.map((l) => l.split(" ")[1]!))];
  const want = [SOL_SCOPE, EVM_SCOPE].flatMap((s) => { const x = n.found.get(s)!; return x.lanes.flatMap((l) => laneIds(s, l.lane, l.readTo)); });
  assert.deepEqual(asked, want);
  // an id read as unused is read on both providers (the IdReader's rule): the lane's first id of an empty lane
  const fresh = idOf(SOL_SCOPE, 3);
  assert.deepEqual(n.log.filter((l) => l.endsWith(fresh)).map((l) => l.split(" ")[0]).sort(), [DRPC, DRPC, DRPC, FAST, FAST, FAST]);
  // the walk's notes are written as before, and the seed zeroed once the ids are read
  const notes = [...notesOf(SOL_SCOPE, LABEL_S, 1000n), ...notesOf(EVM_SCOPE, LABEL_E, 2000n)].map((x) => `${refKey(x.ref)} ${x.state}`).sort();
  assert.deepEqual(await listed(w.store), notes);
  assert.ok(w.seeds.length > 0 && w.seeds.every((s) => s.every((b) => b === 0)));
});

test("deposit ids: an id unread on both providers stops the run stalled, never done: no id read after it, the walk's notes written", async () => {
  const down = idOf(EVM_SCOPE, 43); // lane 3 of the second pool, its sixth id
  const n = nearOf(new Map([[down, "down"]]));
  const w = await world({ ids: n.ids });
  const a = api(w.r.kind);
  const id = a.ask();
  await until("stalled", () => a.posted.some((m) => m.id === id && m.stage === "stalled"), 20_000);
  assert.ok(!a.posted.some((m) => m.id === id && m.stage === "done"));
  await until("op stalled", async () => (await opOf(w.store, id))?.stage === "stalled");
  // both providers were asked for it, and then nothing more was read
  const first = n.log.findIndex((l) => l.endsWith(down));
  assert.ok(first >= 0);
  assert.deepEqual(n.log.slice(first).map((l) => l.split(" ")[1]), [down, down]);
  assert.deepEqual(n.log.slice(first).map((l) => l.split(" ")[0]).sort(), [DRPC, FAST]);
  // the first pool's ids were read whole; the second's never reached an answer
  assert.equal(n.found.get(SOL_SCOPE)?.complete, true);
  assert.equal(n.found.has(EVM_SCOPE), false);
  // the floor: the walk's notes are written whatever the ids read
  const notes = [...notesOf(SOL_SCOPE, LABEL_S, 1000n), ...notesOf(EVM_SCOPE, LABEL_E, 2000n)].map((x) => `${refKey(x.ref)} ${x.state}`).sort();
  assert.deepEqual(await listed(w.store), notes);
  assert.ok(w.seeds.every((s) => s.every((b) => b === 0)));
  assert.match(w.ends[0]!.why.join(" | "), /^solana: the pool's own chain is not read .* \| step 5 did not finish: lane 3: /);
});

test("deposit ids: a pass the providers refuse (their blocks at one height differ) stops the run stalled, no id read, the notes written", async () => {
  const log: string[] = [];
  const other = (url: string): NearRpc => {
    const r = replay(url, new Map(), log);
    return { name: url, query: async (p) => {
      const a = (await r.query(p)) as { result?: Record<string, unknown> };
      return p.block_id === REC.pass.h && url === DRPC ? { ...a, result: { ...a.result, block_hash: "4".repeat(44) } } : a;
    } };
  };
  const w = await world({ ids: { rpcs: () => [other(FAST), other(DRPC)], opts: { tries: 1, sleep: async () => {}, now: () => performance.now() } } });
  assert.equal(await w.r.auto(), "stalled");
  assert.deepEqual(log, []);
  assert.equal((await listed(w.store)).length, 6);
});

test("pageIdReads: this build reads deposit ids on the release pair on mainnet, where 1Click lands a pool deposit's refund; each provider reads block headers for the pass's time", () => {
  const r = restoreKind.pageIdReads();
  assert.ok(r !== null);
  const rpcs = r.rpcs();
  assert.deepEqual(rpcs.map((x) => x.name), [FAST, DRPC]);
  assert.equal(nearPairNetwork(rpcs), "mainnet");
  assert.ok(rpcs.every((x) => typeof (x as { block?: unknown }).block === "function"));
});

// ---------- review of 9583f571 (card wallet-restore-id-reader-wired), each planted ----------

// one Solana pool whose walk finds no note, step 5 on the replayed pair (every id never used)
const SOL_ONLY: readonly RestorePool[] = [POOLS[0]!];
const emptyWalk = (async () => ({ notes: [], spends: [] })) as never;

test("planted (review P1): a pool scope whose ids all read unused still ends stalled, its U_X on the pool's chain named unread, never done", async () => {
  const n = nearOf();
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: n.ids });
  assert.equal(await w.r.auto(), "stalled");
  assert.equal(n.found.get(SOL_SCOPE)?.complete, true);
  assert.ok(n.found.get(SOL_SCOPE)!.lanes.every((l) => l.unread.length === 0 && l.money.length === 0 && l.used.length === 0));
  assert.deepEqual(w.ends, [{ stage: "stalled", why: [`solana: ${POOL_CHAIN_UNREAD}`] }]);
});

test("planted (review P2-2): the seed lock is held only for each use of the seed: a seed write and a pool.buy asked during step 5 are granted before it ends", async () => {
  let reading = false;
  let last = 0;
  const n = nearOf();
  const slow = (r: NearRpc): NearRpc => ({ name: r.name, query: async (p) => ((reading = true), await new Promise((x) => setTimeout(x, 1)), (last = performance.now()), r.query(p)) });
  const ids = { ...n.ids, rpcs: () => n.ids.rpcs().map(slow) as unknown as readonly [NearRpc, NearRpc] };
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids });
  const run = w.r.auto();
  await until("step 5 reading", () => reading);
  // nameDeposit's exclusive request, then a pool.buy's shared one, both asked while step 5 reads
  const writer = navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, async () => performance.now());
  const reader = navigator.locks.request(WALLET_SEED_LOCK, { mode: "shared" }, async () => performance.now());
  const [wAt, rAt] = await Promise.all([writer, reader]);
  const stage = await run;
  // granted while step 5 still read: before its last view
  assert.ok(wAt < last && rAt < last, `the seed write at ${wAt.toFixed(0)} ms and the buy at ${rAt.toFixed(0)} ms, step 5's last view at ${last.toFixed(0)} ms`);
  assert.equal(stage, "stalled");
  assert.ok(w.seeds.length > 1 && w.seeds.every((s) => s.every((b) => b === 0)), "the seed opened per window and zeroed after each");
});

test("planted (review P3-4): a deposit note of another scope in a pool's walk stalls the run by name, and that pool's ids are not read", async () => {
  const n = nearOf();
  // a deposit note at scope 99, whole (its own scope too), in the Solana pool's walk
  const drifted = notesOf(SOL_SCOPE, LABEL_S, 1000n).map((x) => (x.ref.kind === "deposit" && x.ref.i === 1 ? { ...x, scope: 99n, ref: { ...x.ref, s: 99n } } : x));
  const w = await world({ pools: () => SOL_ONLY, solana: (async () => ({ notes: drifted, spends: [] })) as never, ids: n.ids });
  assert.equal(await w.r.auto(), "stalled");
  assert.deepEqual(w.ends[0]!.why, [`solana: 1 deposit note of scope 99 in the walk of scope ${SOL_SCOPE}; its ids are not read`]);
  assert.equal(n.found.has(SOL_SCOPE), false);
  assert.deepEqual(n.log, []);
});

test("planted (mutant M13): a sign out during step 5 stops it at the id in flight: no id is asked after it, its answer is not taken", async () => {
  const n = nearOf();
  const asked: string[] = [];
  let hold: () => void = () => {};
  const held = new Promise<void>((x) => (hold = x));
  const third = idOf(SOL_SCOPE, 16);
  const gate = (r: NearRpc): NearRpc => ({ name: r.name, query: async (p) => {
    const u = (p.request_type === "view_account" ? p.account_id : argsOf(p).account_id) as string;
    if (u !== "intents.near") asked.push(u);
    if (u === third) await held;
    return r.query(p);
  } });
  const ids = { ...n.ids, rpcs: () => n.ids.rpcs().map(gate) as unknown as readonly [NearRpc, NearRpc] };
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids });
  const run = w.r.auto();
  await until("the third id in flight", () => asked.includes(third));
  w.r.signedOut();
  hold();
  assert.equal(await run, "stalled");
  assert.deepEqual([...new Set(asked.slice(asked.indexOf(third)))], [third], "nothing asked after the id in flight");
  assert.equal(n.found.has(SOL_SCOPE), false, "no lane's answer taken after the sign out");
});

test("planted (mutants M6b, M6c, M7): each lane's walk end is walkEnd at RESTORE_GAP from its highest note, and its highest is the highest", () => {
  const ref = (i: number) => ({ ref: { kind: "deposit" as const, s: SOL_SCOPE, i } }) as RestoredNote;
  const { laneHighest, laneWalked } = lanesOf([ref(0), ref(8), ref(3), { ref: { kind: "deposit", s: 99n, i: 40 } } as RestoredNote], SOL_SCOPE);
  assert.deepEqual(laneHighest, [8, null, null, 3, null, null, null, null]);
  assert.deepEqual(laneWalked, [8 + 8 * RESTORE_GAP, 1 - 8 + 8 * RESTORE_GAP, 2 - 8 + 8 * RESTORE_GAP, 3 + 8 * RESTORE_GAP, 4 - 8 + 8 * RESTORE_GAP, 5 - 8 + 8 * RESTORE_GAP, 6 - 8 + 8 * RESTORE_GAP, 7 - 8 + 8 * RESTORE_GAP]);
  assert.deepEqual(laneWalked, laneHighest.map((h, l) => walkEnd(l, h === null ? [] : [h], RESTORE_GAP)));
  assert.equal(laneWalked[0], 80_008);
});

test("planted (mutant M5): a lane stopped past its walk's end, or an unread id, is named; only a complete read with none unread is done", () => {
  const lane = (k: number, o: Partial<DepositIds["lanes"][number]> = {}): DepositIds["lanes"][number] => ({ lane: k, notes: [], money: [], used: [], unread: [], highest: null, readTo: k + 8 * 20, reach: null, ...o });
  const all = (o: Partial<DepositIds["lanes"][number]> = {}, k0 = 0) => Array.from({ length: 8 }, (_, k) => (k === k0 ? lane(k, o) : lane(k)));
  assert.deepEqual(idsUndone({ lanes: all(), complete: true }), []);
  assert.deepEqual(idsUndone({ lanes: all({ reach: 80_016, used: [80_016] }, 2), complete: false }), ["lane 2 stopped at 80016, past the note walk's end: restore again from there"]);
  assert.deepEqual(idsUndone({ lanes: all({ unread: [{ i: 5, id: "x", error: "HTTP 503" }] }, 5), complete: true }), ["lane 5: 1 id unread (HTTP 503)"]);
  assert.deepEqual(idsUndone({ lanes: all(), complete: false }), ["the ids' read is unfinished"]);
});

test("planted (mutant M13, between ids): a sign out while the next lane's ids are derived asks no id of that lane", async () => {
  const n = nearOf();
  const asked: string[] = [];
  const log = (r: NearRpc): NearRpc => ({ name: r.name, query: async (p) => {
    const u = (p.request_type === "view_account" ? p.account_id : argsOf(p).account_id) as string;
    if (u !== "intents.near") asked.push(u);
    return r.query(p);
  } });
  const ids = { ...n.ids, rpcs: () => n.ids.rpcs().map(log) as unknown as readonly [NearRpc, NearRpc] };
  let opened = 0;
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids });
  // the seed's second opening is lane 1's first window: the sign out lands while it is open
  const r = poolRestore({ ...w.host, seed64: async () => (++opened === 2 && r.signedOut(), new Uint8Array(64).fill(7)) });
  assert.equal(await r.auto(), "stalled");
  assert.equal(opened, 2);
  assert.ok(asked.length > 0 && asked.every((u) => u === idOf(SOL_SCOPE, Number(laneOf(u)))), "only lane 0's ids were asked");
  assert.ok(!asked.includes(idOf(SOL_SCOPE, 1)), "lane 1's first id never asked");
});
// the index of a lane-0 id of the Solana scope among its first 21 (the lane read before the sign out), else NaN
const laneOf = (u: string): number => {
  for (let i = 0; i <= 8 * 21; i += 8) if (idOf(SOL_SCOPE, i) === u) return i;
  return NaN;
};

// review of e31892ef (P3-1): the signed-in check under the seed lock, with no sign out in this tab: another tab's sign
// out lands after the walk, so the floor's write finds no seed stored, writes nothing and opens no seed after it
test("planted (review P3-1): no seed stored after the walk, with no sign out in this tab: stalled, no note written, no seed opened after", async () => {
  let walked = false;
  let opened = 0;
  const w = await world({
    signedIn: async () => !walked,
    seed64: async () => (opened++, new Uint8Array(64).fill(7)),
    solana: (async () => ((walked = true), { notes: notesOf(SOL_SCOPE, LABEL_S, 1000n), spends: [] })) as never,
    pools: () => SOL_ONLY,
  });
  assert.equal(await w.r.auto(), "stalled");
  assert.deepEqual(await listed(w.store), []);
  assert.equal(opened, 0, "a seed opened after the flip");
  assert.deepEqual(w.ends.map((x) => [x.stage, x.why]), [["stalled", ["the restore stopped: signed out during the restore"]]]);
});

// review of e31892ef (P3-2): another tab signs out and in with other words between two of this run's seed uses, and
// this tab hears of it late: the run is tied to its own seed, so it stops before the next use and writes nothing
test("planted (review P3-2): other words signed in between two seed uses: stalled, nothing written, no id derived from them", async () => {
  let opened = 0;
  const n = nearOf();
  const w = await world({
    // the walk's use opens the run's seed; every opening after is the other words'
    seed64: async () => new Uint8Array(64).fill(opened++ === 0 ? 7 : 9),
    solana: (async (a: { seed64: SeedUse }) => (await a.seed64(() => 0), { notes: notesOf(SOL_SCOPE, LABEL_S, 1000n), spends: [] })) as never,
    pools: () => SOL_ONLY,
    ids: n.ids,
  });
  assert.equal(await w.r.auto(), "stalled");
  assert.deepEqual(await listed(w.store), []);
  assert.deepEqual(n.log, [], "no id read");
  assert.deepEqual(w.ends.map((x) => [x.stage, x.why]), [["stalled", ["the restore stopped: other words were signed in during the restore"]]]);
});

// review of e31892ef (P3-5): the run's end is told with its reasons however it ends: an abort (this tab's sign out) and
// a floor write that throws included
test("planted (review P3-5): `ended` is told once on an abort and on a floor write that throws", async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>((r) => (release = r));
  const a = await world({ pools: () => SOL_ONLY, solana: (async (x: { signal: AbortSignal }) => (await slow, x.signal.throwIfAborted(), { notes: notesOf(SOL_SCOPE, LABEL_S, 1000n), spends: [] })) as never });
  const run = a.r.auto();
  await until("reading", async () => (await a.store.keys("ops")).length === 1);
  a.r.signedOut();
  release();
  assert.equal(await run, "stalled");
  assert.equal(a.ends.length, 1);
  assert.equal(a.ends[0]!.stage, "stalled");
  assert.match(a.ends[0]!.why.join("\n"), /^the restore stopped: /m);
  // the floor's write throws: the store holds one of the walk's notes with another precommitment
  const b = await world({ pools: () => SOL_ONLY });
  const ns = await openNoteStore(b.store);
  try {
    await writeRestored(ns, { notes: notesOf(SOL_SCOPE, LABEL_S, 5000n).slice(0, 1) });
  } finally {
    ns.close();
  }
  const q = api(b.r.kind);
  const id = q.ask();
  await until("stalled", () => q.posted.some((m) => m.id === id && m.stage === "stalled"));
  assert.equal(b.ends.length, 1);
  assert.equal(b.ends[0]!.stage, "stalled");
  assert.match(b.ends[0]!.why.join("\n"), /^the restore stopped: note .* in the store has another precommitment$/m);
});

// ---------- card wallet-restore-reads-ux: each pool deposit id's U_X on the pool's own chain ----------

// the U_X reads: the pool follow's own Solana reader (solanaPoolFollowDeps' balances: getBalance at finalized) on two
// providers replaying the live check's recorded getBalance answers (scripts/live-checks/wallet-restore-reads-ux.answers.json,
// asked from SIGN_HOST's origin on the mainnet pair): a planted U_X answers as the program data account (402,645,880
// lamports on both), every other U_X as the account no one holds (0 on both)
const UXREC = JSON.parse(readFileSync(new URL("../../../scripts/live-checks/wallet-restore-reads-ux.answers.json", import.meta.url), "utf8")).good.clusters.mainnet as {
  providers: { url: string; held: { value: number }; empty: { value: number } }[];
};
const HELD = BigInt(UXREC.providers[0]!.held.value);
// the follow's floor at mainnet rent (one deposit's worst case plus U_X's rent), fixed here: what the floor is, is the
// follow's own tests' (pool-deposit-follow.test.ts); the restore only uses it
const COSTS = { floor: 15_000_000n, perRung: 4_109_120n, keep: 890_880n };
type UxAs = "held" | "empty" | "off";
function uxOf(planted: Map<string, UxAs>, over: { deposit?: (f: { s: string; i: number; u: string; refund_id: string }, amount: bigint) => Promise<PoolDepositEnd>; costs?: typeof COSTS; secondOff?: boolean } = {}) {
  const asked: { url: string; params: unknown[] }[] = [];
  const deposits: { s: string; i: number; u: string; refund_id: string; amount: bigint }[] = [];
  const rpc = (k: number): SolanaRpc => async (method, params) => {
    assert.equal(method, "getBalance");
    asked.push({ url: UXREC.providers[k]!.url, params: params as unknown[] });
    const u = (params as unknown[])[0] as string;
    const as = planted.get(u) ?? "empty";
    const p = UXREC.providers[k]!;
    // "off": the second provider gives one lamport more than the first, the two providers disagreeing
    if (as === "off") return { value: p.held.value + (k === 1 ? 1 : 0) };
    return { value: as === "held" ? p.held.value : p.empty.value };
  };
  const d = solanaPoolFollowDeps({ rpcs: [rpc(0), rpc(1)], program: "Prog111", deposit: async () => ({ end: "down", txs: [] }) });
  const reads: PoolUxReads = {
    balances: d.balances,
    costs: async () => over.costs ?? COSTS,
    ladder: d.ladder,
    deposit: async (f, amount) => {
      deposits.push({ s: f.s, i: f.i, u: f.u, refund_id: f.refund_id, amount });
      const end = over.deposit ? await over.deposit(f, amount) : "filled";
      // a filled deposit empties U_X but its rent, read on both providers as the empty account's 0 here
      if (end === "filled" && !over.deposit) planted.set(f.u, "empty");
      // the follow's deposit's answer (card pool-deposit-op-txs): its end, with the txs it named
      return { end, txs: [] };
    },
  };
  return { reads, asked, deposits };
}
const solUx = (id: string): string => base58.encode(hex.decode(id));

test("planted: a U_X holding money with no note on this device and no trace on NEAR (a delivery the lost store's quote named) is found, its lane read 21 past it, and named with its balance: stalled, never done, nothing carried", async () => {
  const id = idOf(SOL_SCOPE, 3); // lane 3, its first id: 1Click's delivery to U_X, never deposited
  const planted = new Map<string, UxAs>([[solUx(id), "held"]]);
  const ux = uxOf(planted);
  const n = nearOf();
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: n.ids, ux: (chain) => (chain === "solana" ? ux.reads : null) });
  assert.equal(await w.r.auto(), "stalled");
  assert.deepEqual(w.ends, [{ stage: "stalled", why: [`solana: deposit index 3's one-time wallet ${solUx(id)} holds ${HELD}, with no deposit note on this device for its index to carry it into the pool`] }]);
  const lane = n.found.get(SOL_SCOPE)!.lanes[3]!;
  assert.deepEqual({ money: lane.money, highest: lane.highest, readTo: lane.readTo }, { money: [3], highest: 3, readTo: 3 + 8 * 21 });
  assert.deepEqual(ux.deposits, []);
  // every U_X asked on both providers at finalized, one U_X per request, each one of the scope's own ids
  const want = new Set(n.found.get(SOL_SCOPE)!.lanes.flatMap((l) => laneIds(SOL_SCOPE, l.lane, l.readTo)).map(solUx));
  for (const a of ux.asked) {
    assert.equal(a.params.length, 2);
    assert.ok(want.has(a.params[0] as string));
    assert.deepEqual(a.params[1], { commitment: "finalized" });
  }
  assert.deepEqual(new Set(ux.asked.map((a) => a.params[0])), want);
  assert.deepEqual(new Set(ux.asked.map((a) => a.url)), new Set(UXREC.providers.map((p) => p.url)));
});

test("planted: a U_X holding money whose index has a deposit note here (planned on this device, or landed and found by the walk) is carried into the pool from that U_{s,i} at the follow's largest ask; the run ends done", async () => {
  // planned here: the store's PLANNED deposit note (planDeposit's index, in the lane it draws), its U_X holding the delivery
  const planned = new Map<string, UxAs>();
  const ux = uxOf(planned);
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: nearOf().ids, ux: () => ux.reads });
  const ns = await openNoteStore(w.store);
  let at: number;
  try {
    const ref = (await ns.planDeposit(SOL_SCOPE, () => 77n)).ref;
    assert.equal(ref.kind, "deposit");
    at = (ref as { i: number }).i;
  } finally {
    ns.close();
  }
  planned.set(solUx(idOf(SOL_SCOPE, at)), "held");
  // a store holding only a PLANNED note is empty, so the run with no tap reads it
  assert.equal(await w.r.auto(), "done", JSON.stringify(w.ends));
  assert.deepEqual(w.ends, [{ stage: "done", why: [] }]);
  assert.deepEqual(ux.deposits, [{ s: SOL_SCOPE.toString(), i: at, u: solUx(idOf(SOL_SCOPE, at)), refund_id: idOf(SOL_SCOPE, at), amount: askOf(ux.reads.ladder, HELD, COSTS.perRung, COSTS.keep) }]);
  assert.ok(ux.deposits[0]!.amount > 0n);
  // landed and found by the walk: index 1's deposit note, its U_X holding a late second send
  const late = uxOf(new Map([[solUx(idOf(SOL_SCOPE, 1)), "held"]]));
  const v = await world({ pools: () => SOL_ONLY, ids: nearOf().ids, ux: () => late.reads });
  const a = api(v.r.kind);
  const rid = a.ask();
  await until("done", () => a.posted.some((m) => m.id === rid && m.stage === "done"), 20_000);
  assert.deepEqual(late.deposits.map((d) => d.i), [1]);
});

test("planted: the pool chain's two providers giving two balances for a U_X stall the run by name, nothing carried", async () => {
  const id = idOf(SOL_SCOPE, 10);
  const ux = uxOf(new Map([[solUx(id), "off"]]));
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: nearOf().ids, ux: () => ux.reads });
  assert.equal(await w.r.auto(), "stalled");
  assert.deepEqual(ux.deposits, []);
  assert.deepEqual(w.ends[0]!.why, [`solana: lane 2: 1 id unread (its U_X reads ${HELD} and ${HELD + 1n} on the pool chain's two RPCs)`]);
});

test("planted: a carry that does not fill, or a filled one that leaves U_X's balance as it was, stalls the run with the U_X named", async () => {
  const id = idOf(SOL_SCOPE, 0);
  for (const [end, named] of [
    ["not_landed", `holds ${HELD}; its carry into the pool ended not_landed: restore again to carry it`],
    ["filled", `holds ${HELD} after a deposit from it filled: read again`],
  ] as const) {
    const ux = uxOf(new Map([[solUx(id), "held"]]), { deposit: async () => end });
    // the walk finds index 0's deposit note (notesOf), so its U_X is carried from it
    const w = await world({ pools: () => SOL_ONLY, ids: nearOf().ids, ux: () => ux.reads });
    assert.equal(await w.r.auto(), "stalled");
    assert.deepEqual(w.ends[0]!.why, [`solana: deposit index 0's one-time wallet ${solUx(id)} ${named}`]);
    assert.equal(ux.deposits.length, 1);
  }
});

test("planted: a U_X under one deposit's floor (the rent a carried U_X keeps) is left as the follow leaves it; every U_X read empty ends done", async () => {
  const id = idOf(SOL_SCOPE, 5);
  const ux = uxOf(new Map([[solUx(id), "held"]]), { costs: { ...COSTS, floor: HELD + 1n } });
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: nearOf().ids, ux: () => ux.reads });
  assert.equal(await w.r.auto(), "done");
  assert.deepEqual(ux.deposits, []);
  // the same scope with no U_X holding anything: done (POOL_CHAIN_UNREAD only where the chain has no U_X reads)
  const none = uxOf(new Map());
  const v = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: nearOf().ids, ux: () => none.reads });
  assert.equal(await v.r.auto(), "done");
  assert.deepEqual(v.ends, [{ stage: "done", why: [] }]);
});

test("planted: the U_X reads are keyed by the pool's chain from its pin: an EVM pool reads U^evm_{s,i}'s address, a chain with none names U_X unread", async () => {
  const ux = uxOf(new Map());
  const chains: string[] = [];
  const n = nearOf();
  const w = await world({ ids: n.ids, ux: (chain) => (chains.push(chain), chain === "base" ? ux.reads : null) });
  assert.equal(await w.r.auto(), "stalled");
  assert.deepEqual(chains, ["solana", "base"]);
  // the Solana pool has no reads here: named unread; the Base Sepolia pool (Base's chain) is read, every U_X empty
  assert.deepEqual(w.ends, [{ stage: "stalled", why: [`solana: ${POOL_CHAIN_UNREAD}`] }]);
  const read = n.found.get(EVM_SCOPE)!.lanes.flatMap((l) => Array.from({ length: (l.readTo - l.lane) / 8 + 1 }, (_, k) => l.lane + 8 * k));
  const want = new Set(read.map((i) => depositIdEvm(SEED(), EVM_SCOPE, i).address));
  assert.ok(want.size > 8 * 21);
  assert.deepEqual(new Set(ux.asked.map((a) => a.params[0])), want);
});

// ---------- the restore's U_X reads on two public operators, never our helper relay ----------

test("planted (fold 04:33Z): every restore U_X read, balances and costs alike, goes to the two public operators and never names our helper relay", async () => {
  const urls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    urls.push(String(u instanceof Request ? u.url : u));
    const id = (JSON.parse(String(init?.body ?? "{}")) as { id?: unknown }).id ?? 1;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const follow = { ...uxOf(new Map()).reads };
    const ux = restoreKind.restoreUxOf("solana", follow, "Prog111");
    assert.ok(ux !== null);
    assert.deepEqual(await ux.balances({ u: solUx(idOf(SOL_SCOPE, 0)) }), [0n, 0n]);
    await ux.costs({ chain: "solana", s: "1", i: 0, u: solUx(idOf(SOL_SCOPE, 0)), refund_id: idOf(SOL_SCOPE, 0) }).catch(() => {});
  } finally {
    globalThis.fetch = real;
  }
  const hosts = new Set(urls.map((u) => new URL(u).origin));
  assert.ok(urls.length >= 2);
  assert.ok(![...hosts].some((h) => h === TRADE_HELPER), [...hosts].join(", "));
  assert.deepEqual([...hosts].sort(), [...restoreKind.RESTORE_UX_SOLANA].sort());
  // the deposit is the follow's own, and a chain with no follow or no pin has no U_X reads
  const f = uxOf(new Map()).reads;
  assert.equal(restoreKind.restoreUxOf("solana", f, "Prog111")!.deposit, f.deposit);
  assert.equal(restoreKind.restoreUxOf("solana", null, "Prog111"), null);
  assert.equal(restoreKind.restoreUxOf("solana", f, undefined), null);
  assert.equal(restoreKind.restoreUxOf("base", f, "Prog111"), null);
});

test("measured (fold 04:33Z): each id's U_X read runs beside its NEAR read, so step 5 on a planted scope takes about as long with the U_X reads as without them", async () => {
  const slow = (r: NearRpc): NearRpc => ({ name: r.name, query: async (p) => (await new Promise((x) => setTimeout(x, 2)), r.query(p)) });
  const time = async (ux: PoolRestoreHost["ux"]) => {
    const n = nearOf();
    const ids = { ...n.ids, rpcs: () => n.ids.rpcs().map(slow) as unknown as readonly [NearRpc, NearRpc] };
    const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids, ...(ux ? { ux } : {}) });
    const t0 = performance.now();
    await w.r.auto();
    return performance.now() - t0;
  };
  // the U_X pair answers 4 ms after it is asked, each provider on its own
  const u = uxOf(new Map());
  const paced: PoolUxReads = { ...u.reads, balances: async (f) => (await new Promise((x) => setTimeout(x, 4)), u.reads.balances(f)) };
  const without = await time(undefined);
  const withUx = await time(() => paced);
  const sequential = without + 176 * 4;
  console.log(`step 5 on a planted scope (176 ids): ${Math.round(without)} ms without U_X reads, ${Math.round(withUx)} ms with them beside the NEAR reads (one after the other: about ${Math.round(sequential)} ms)`);
  assert.ok(withUx < without * 1.3 + 100, `${withUx} vs ${without}`);
});

// ---------- review P1 of 4cdfd37d: money NEAR reads under a deposit id U_{s,i} keeps the scope from done ----------
/** The replayed pair with U's token balance planted per provider (ft_balance_of answered at the pass's block): `plant`
 *  maps an id to [FastNEAR's, dRPC's] amounts; the id answers as "money_usdc" otherwise (registered on the token). */
function nearPlanted(plant: ReadonlyMap<string, readonly [bigint, bigint]>, as: Map<string, As> = new Map()) {
  for (const id of plant.keys()) if (!as.has(id)) as.set(id, "money_usdc");
  const n = nearOf(as);
  const rpcs = n.ids.rpcs;
  const wrap = (rpc: NearRpc, k: 0 | 1): NearRpc => ({
    name: rpc.name,
    query: async (params) => {
      const u = argsOf(params).account_id as string;
      const at = (x: unknown) => ({ jsonrpc: "2.0", id: "dontcare", result: { result: [...new TextEncoder().encode(JSON.stringify(x))], logs: [], block_height: REC.pass.h, block_hash: REC.pass.hash } });
      if (!plant.has(u)) return rpc.query(params);
      // nothing of it inside intents.near: what the money_usdc id's record never needed read
      if (params.method_name === "mt_tokens_for_owner") return at([]);
      if (params.method_name === "ft_balance_of") return at(plant.get(u)![k].toString());
      return rpc.query(params);
    },
  });
  n.ids.rpcs = () => {
    const [a, b] = rpcs();
    return [wrap(a, 0), wrap(b, 1)];
  };
  return n;
}
const KEEP = (await import("../../wallet/src/deposit/moveout.ts")).ID_KEEP;

test("review P1: a refund left under U_{s,i} inside intents.near, every U_X empty, ends stalled with that money named by asset, never done", async () => {
  const id = idOf(SOL_SCOPE, 3);
  const n = nearOf(new Map<string, As>([[id, "intents"]]));
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: n.ids, ux: () => uxOf(new Map()).reads });
  assert.equal(await w.r.auto(), "stalled");
  assert.deepEqual(n.found.get(SOL_SCOPE)!.lanes[3]!.money, [3]);
  const why = w.ends[0]!.why;
  assert.ok(why.length > 0 && why.every((y) => y.startsWith(`solana: deposit index 3's id ${id} holds `) && y.includes(" on NEAR, above the 1 a move out keeps")), JSON.stringify(why));
});

test("review P1: an id holding only the kept unit a move out leaves (ID_KEEP, on both providers) is a moved-out id: done", async () => {
  assert.equal(KEEP, 1n);
  const id = idOf(SOL_SCOPE, 2);
  const n = nearPlanted(new Map([[id, [KEEP, KEEP] as const]]));
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: n.ids, ux: () => uxOf(new Map()).reads });
  assert.equal(await w.r.auto(), "done", JSON.stringify(w.ends));
  assert.deepEqual(n.found.get(SOL_SCOPE)!.lanes[2]!.money, [2]);
});

test("review P1: the kept unit plus 1 ends stalled with the amount named", async () => {
  const id = idOf(SOL_SCOPE, 2);
  const n = nearPlanted(new Map([[id, [KEEP + 1n, KEEP + 1n] as const]]));
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: n.ids, ux: () => uxOf(new Map()).reads });
  assert.equal(await w.r.auto(), "stalled");
  const usdc = NEAR_NETWORKS.mainnet.usdc;
  assert.deepEqual(w.ends[0]!.why, [`solana: deposit index 2's id ${id} holds ${KEEP + 1n} of ${usdc} on NEAR, above the 1 a move out keeps; a restore does not carry it yet, and it stays under the 12 words`]);
});

test("review P1: two NEAR RPCs that read an id's holding apart stall it, whichever reads the kept unit", async () => {
  const id = idOf(SOL_SCOPE, 2);
  const usdc = NEAR_NETWORKS.mainnet.usdc;
  for (const pair of [[KEEP, 5n], [5n, KEEP]] as const) {
    const n = nearPlanted(new Map([[id, pair]]));
    const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: n.ids, ux: () => uxOf(new Map()).reads });
    assert.equal(await w.r.auto(), "stalled", String(pair));
    assert.deepEqual(w.ends[0]!.why, [`solana: deposit index 2's id ${id} holds ${pair[0]} and ${pair[1]} of ${usdc} on NEAR's two RPCs: read again`]);
  }
});

// on main since wallet-id-reader-paced, the IdReader itself refuses two providers that answer money and used for one id
// at one block (PairDisagrees), so this pair stops step 5 there, before the held reader is asked; the held reader's own
// filter (an asset left out only at 0 on both) is still held by the live check's plants A5 and A6
// (scripts/live-checks/wallet-restore-reads-ux.test.mjs)
test("delta review 2 P2-A: one NEAR RPC reading 0 and the other 5 USDC stalls the id, whichever reads 0 (the pair's disagreement, named)", async () => {
  const id = idOf(SOL_SCOPE, 2);
  for (const pair of [[0n, 5_000_000n], [5_000_000n, 0n]] as const) {
    const n = nearPlanted(new Map([[id, pair]]));
    const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: n.ids, ux: () => uxOf(new Map()).reads });
    assert.equal(await w.r.auto(), "stalled", `${String(pair)}: ${JSON.stringify(w.ends)}`);
    assert.equal(w.ends[0]!.why.length, 1, String(pair));
    assert.match(w.ends[0]!.why[0]!, /^step 5 did not finish: lane 2: at index 2, \S+ answered money where \S+ answered used at block \d+: one of the pair is wrong at one block, so the restore stops, to be retried$/, String(pair));
  }
});

test("review: a U_X holding exactly the floor is carried, one rung, and the restore ends done", async () => {
  const id = idOf(SOL_SCOPE, 0);
  const ux = uxOf(new Map([[solUx(id), "held"]]), { costs: { floor: HELD, perRung: HELD - 10_000_000n - 890_880n, keep: 890_880n } });
  const w = await world({ pools: () => SOL_ONLY, ids: nearOf().ids, ux: () => ux.reads });
  assert.equal(await w.r.auto(), "done", JSON.stringify(w.ends));
  assert.deepEqual(ux.deposits.map((d) => [d.i, d.amount]), [[0, 10_000_000n]]);
});

test("delta review P2-1: the chain's finals move 121 blocks on while step 5 reads its ids, and an id holds only the kept unit on both: done, its held read on the pass opened with it", async () => {
  const id = idOf(SOL_SCOPE, 2);
  const n = nearPlanted(new Map([[id, [KEEP, KEEP] as const]]));
  const inner = n.ids.rpcs;
  let reading = false;
  const late = (rpc: NearRpc): NearRpc => ({
    name: rpc.name,
    query: async (params) => {
      if (params.method_name === "storage_balance_of") reading = true;
      const a = (await rpc.query(params)) as { result?: { block_height?: number } };
      // once the ids are being read, every final block reads VAULT_SYNC_LAG_MAX + 1 past the pass's
      if (reading && params.finality === "final" && a?.result?.block_height !== undefined) return { ...a, result: { ...a.result, block_height: REC.pass.h + 121 } };
      return a;
    },
  });
  n.ids.rpcs = () => {
    const [a, b] = inner();
    return [late(a), late(b)];
  };
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: n.ids, ux: () => uxOf(new Map()).reads });
  assert.equal(await w.r.auto(), "done", JSON.stringify(w.ends));
});

test("delta review P3-4: an asset that is not a fungible token (nep171, nep245) inside intents.near is named at any amount, the kept unit's 1 included", async () => {
  const id = idOf(SOL_SCOPE, 3);
  const n = nearPlanted(new Map([[id, [0n, 0n] as const]]));
  const inner = n.ids.rpcs;
  const nft = "nep171:nft.example.near:7";
  const at = (x: unknown) => ({ jsonrpc: "2.0", id: "dontcare", result: { result: [...new TextEncoder().encode(JSON.stringify(x))], logs: [], block_height: REC.pass.h, block_hash: REC.pass.hash } });
  const withNft = (rpc: NearRpc): NearRpc => ({
    name: rpc.name,
    query: async (params) => {
      if (argsOf(params).account_id === id && params.method_name === "mt_tokens_for_owner") return at([{ token_id: nft }]);
      if (argsOf(params).account_id === id && params.method_name === "mt_batch_balance_of") return at(["1"]);
      return rpc.query(params);
    },
  });
  n.ids.rpcs = () => {
    const [a, b] = inner();
    return [withNft(a), withNft(b)];
  };
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: n.ids, ux: () => uxOf(new Map()).reads });
  assert.equal(await w.r.auto(), "stalled");
  assert.deepEqual(w.ends[0]!.why, [`solana: deposit index 3's id ${id} holds 1 of ${nft} on NEAR, not a fungible token a move out keeps a unit of; a restore does not carry it yet, and it stays under the 12 words`]);
});

// card evm-pool-leaves-any-source: the page's restore keeps the page's hold for the pool (the deposit's sync's too) and
// reads the page's history sources, so a restore after a deposit reads only past the held blocks
test("card evm-pool-leaves-any-source: the restore passes the page's hold and history for each EVM pool", async () => {
  const { pageEvmHold, pageEvmHistory } = await import("../src/pool-testnet.ts");
  const args: { held?: unknown; history?: unknown; pin: { network: string } }[] = [];
  const w = await world({ evm: (async (x: { held?: unknown; history?: unknown; pin: { network: string } }) => (args.push(x), { notes: [], spends: [], elsewhere: [], wallets: [], block: 1n })) as never });
  const a = api(w.r.kind);
  const id = a.ask();
  await until("done", () => a.posted.some((m) => m.id === id && m.stage === "done"));
  const pin = POOLS[1]!.chain === "evm" ? POOLS[1]!.pin : assert.fail("the EVM pool");
  assert.equal(args.length, 1);
  assert.equal(args[0]!.held, pageEvmHold(pin, async () => assert.fail("the restore's hold, made already")));
  assert.deepEqual(args[0]!.history, pageEvmHistory(pin));
});

// ---------- card wallet-id-reader-paced: a Retry reads on, and the run's signal reaches every view and wait ----------

test("a Retry reads on where the last run stopped: no id answered at the kept pass is asked again; a sign out drops what was kept", async () => {
  const down = idOf(SOL_SCOPE, 43); // lane 3, its sixth id
  const as = new Map<string, As>([[down, "down"]]);
  const n = nearOf(as);
  const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids: n.ids });
  assert.equal(await w.r.auto(), "stalled");
  assert.match(w.ends[0]!.why.join(" | "), /step 5 did not finish: lane 3: /);
  const answered = new Set(n.log.map((l) => l.split(" ")[1]!).filter((u) => u !== down));
  assert.ok(answered.size >= 20, `${answered.size} ids answered before the stop`);
  // the Retry, the provider back: only the ids not answered are asked, and the lanes read whole
  as.delete(down);
  n.log.length = 0;
  assert.equal(await w.r.auto(), "stalled");
  assert.equal(n.found.get(SOL_SCOPE)?.complete, true);
  assert.deepEqual(n.log.map((l) => l.split(" ")[1]!).filter((u) => answered.has(u)), [], "an id answered at the kept pass asked again");
  assert.ok(n.log.some((l) => l.endsWith(down)));
  // a sign out drops the kept pass and answers: the next run asks every id again
  w.r.signedOut();
  n.log.length = 0;
  assert.equal(await w.r.auto(), "stalled");
  assert.ok([...answered].every((u) => n.log.some((l) => l.endsWith(u))), "every id asked again after a sign out");
});

test("the run's signal reaches the reader: a sign out ends a view a provider never answers, and a provider's busy wait, at once", async () => {
  for (const how of ["hangs", "busy"] as const) {
    const n = nearOf();
    // the first id, asked within the pace's burst: its views wait no slot on the real clock
    const first = idOf(SOL_SCOPE, 0);
    let reached = false;
    const gate = (r: NearRpc): NearRpc => ({ name: r.name, query: async (p, signal?: AbortSignal) => {
      const u = (p.request_type === "view_account" ? p.account_id : argsOf(p).account_id) as string;
      if (u !== first) return r.query(p);
      reached = true;
      // never answered (only the signal ends it), or busy for good with a Retry-After of 50 s, waited on a real clock
      if (how === "hangs") return new Promise((_, no) => signal?.addEventListener("abort", () => no(signal.reason), { once: true }));
      throw Object.assign(new Error("HTTP 429"), { status: 429, retryAfterMs: 50_000 });
    } });
    const ids = { ...n.ids, opts: { tries: 1 }, rpcs: () => n.ids.rpcs().map(gate) as unknown as readonly [NearRpc, NearRpc] };
    const w = await world({ pools: () => SOL_ONLY, solana: emptyWalk, ids });
    const run = w.r.auto();
    await until("the first id asked", () => reached);
    const t = performance.now();
    w.r.signedOut();
    const stage = await Promise.race([run, new Promise((ok) => setTimeout(() => ok("still running 2 s after the sign out"), 2_000))]);
    assert.equal(stage, "stalled", how);
    assert.ok(performance.now() - t < 2_000, how);
  }
});

// card evm-pool-lists-mainnet: the page's mainnet pool lists are the kit's (evmPoolProvidersOf), seats first, and the
// restore and the deposit read them; copied so SIGN_HOST's build carries no testnet provider (build-network.test.mjs)
test("the page's mainnet EVM pool lists are the kit's pool lists, on both chains, and the mainnet page reads them", () => {
  for (const chain of ["base", "robinhood"] as const) {
    assert.deepEqual(MAINNET_POOL_RPCS[chain], evmPoolProvidersOf(evmPoolVenues()[chain]), chain);
    assert.ok(Object.isFrozen(MAINNET_POOL_RPCS[chain]), `${chain}: frozen`);
    assert.equal(pageEvmPoolUrls(chain), MAINNET_POOL_RPCS[chain], `${chain}: the mainnet page reads it`);
  }
});

// review P3-3 of evm-pool-lists-mainnet: with a mainnet pin planted on each chain (EVM_POOLS is empty today, so
// pagePools() skips EVM on mainnet), the restore's pool reads on MAINNET_POOL_RPCS, end to end through pagePools
test("planted (review P3-3): a mainnet pin on each chain is read on MAINNET_POOL_RPCS, seats first, through pagePools", () => {
  const pin = (network: "base" | "robinhood", b: string) => ({ network, pool: `0x${b.repeat(20)}`, feeRecipient: `0x${"22".repeat(20)}`, fromBlock: 1n });
  const pools = pagePools({ base: pin("base", "aa"), robinhood: pin("robinhood", "bb") });
  const evm = pools.filter((p) => p.chain === "evm");
  assert.deepEqual(evm.map((p) => p.chain === "evm" && p.pin.network), ["base", "robinhood"]);
  for (const p of evm) {
    if (p.chain !== "evm") continue;
    const chain = p.pin.network as "base" | "robinhood";
    assert.ok(p.rpcs !== null, `${chain}: read by the page`);
    assert.deepEqual(p.rpcs().map((r) => r.url), MAINNET_POOL_RPCS[chain].map((u) => new URL(u).href), `${chain}: the kit's pool list`);
  }
});
