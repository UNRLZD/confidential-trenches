// The restore kind (card pool-restore-wired, src/pool-restore.ts) through the page's api (src/api.ts startApi), with the
// wallet's real store and note store (fake-indexeddb) and the two pool restores replaced by fixed answers: every pool the
// page pins is read, what they find is written to the note store, the request is answered "started" at once, its
// progress says "reading" within every beat and ends "done", or "stalled" when a pool fails (the others' notes still
// written); one run at a time; auto runs once on an empty note store and never on one with notes; signed out it refuses.
// Each pool walked has its deposit ids read (card wallet-restore-id-reader-wired: restore step 5 through the wallet's
// IdReader) on NEAR answers replayed from mainnet (the wallet's test/vectors/id-reader-mainnet.json): a found id holds
// its lane open, and an id unread on both providers stops the run stalled with the walk's notes written.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { noteCommitment } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, refKey } from "../../wallet/src/notes/store.ts";
import type { RestoredNote } from "../../wallet/src/notes/restore.ts";
import { depositAccount, NEAR_NETWORKS, nearPairNetwork, type NearRpc } from "../../wallet/src/deposit/account.ts";
import type { DepositIds } from "../../wallet/src/restore/wallets.ts";
import { APP_ORIGIN, startApi } from "../src/api.ts";
import * as restoreKind from "../src/pool-restore.ts";
import { pagePools, poolRestore, RESTORE_BEAT_MS, RESTORE_LOCK, type PoolRestoreHost, type RestorePool } from "../src/pool-restore.ts";

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
  const ids: NonNullable<PoolRestoreHost["ids"]> = { rpcs: () => [replay(FAST, as, log), replay(DRPC, as, log)], opts: { tries: 1, sleep: async () => {} }, read: (scope, r) => void found.set(scope, r) };
  return { ids, log, found };
}

let db = 0;
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
async function world(over: Partial<PoolRestoreHost> = {}) {
  const near = nearOf();
  const store = await openWalletStore({ name: `restore-${db++}`, indexedDB: new IDBFactory() });
  closers.push(() => store.close());
  const seeds: Uint8Array[] = [];
  const seen: string[] = [];
  const host: PoolRestoreHost = {
    store: async () => store,
    seed64: async () => {
      const s = new Uint8Array(64).fill(7);
      seeds.push(s);
      return s;
    },
    signedIn: async () => true,
    pools: () => POOLS,
    ids: near.ids,
    solana: (async (a: { program: string }) => (seen.push(`solana ${a.program}`), { notes: notesOf(SOL_SCOPE, LABEL_S, 1000n), spends: [] })) as never,
    evm: (async (a: { pin: { network: string }; wallets?: unknown; walletRpcs?: unknown; helper?: unknown }) => (seen.push(`evm ${a.pin.network} wallets ${String(a.wallets)} ${"walletRpcs" in a || "helper" in a ? "with W reads" : "no W reads"}`), { notes: notesOf(EVM_SCOPE, LABEL_E, 2000n), spends: [], elsewhere: [], wallets: [], block: 1n })) as never,
    ...over,
  };
  return { store, host, seeds, seen, near, r: poolRestore(host) };
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
  assert.ok(w.seeds.length === 1 && w.seeds[0]!.every((b) => b === 0));
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
  await until("reading", async () => (await w.store.keys("ops")).length === 1 && w.seeds.length === 1);
  w.r.signedOut();
  release();
  assert.equal(await run, "stalled");
  assert.deepEqual(await listed(w.store), []);
  assert.ok(w.seeds[0]!.every((b) => b === 0));
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

test("deposit ids: every pool walked has its ids read on both providers at one block; an intents-only id and a used id each hold their lane open 21 more; the run ends done", async () => {
  const as = new Map<string, As>([
    [idOf(SOL_SCOPE, 24), "intents"], // lane 0, past its note at 0: a refund left inside intents.near only
    [idOf(SOL_SCOPE, 162), "used_storage"], // lane 2, empty: its 21st id, registered on USDC and empty now
    [idOf(EVM_SCOPE, 169), "used_account"], // lane 1, the last of the 21 past its note at 1: a NEAR account, nothing held
  ]);
  const n = nearOf(as);
  const w = await world({ ids: n.ids });
  const a = api(w.r.kind);
  const id = a.ask();
  await until("done", () => a.posted.some((m) => m.id === id && m.stage === "done"), 20_000);
  assert.ok(!a.posted.some((m) => m.id === id && m.stage === "stalled"));
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
  assert.ok(w.seeds.length === 1 && w.seeds[0]!.every((b) => b === 0));
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
  assert.ok(w.seeds[0]!.every((b) => b === 0));
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
  const w = await world({ ids: { rpcs: () => [other(FAST), other(DRPC)], opts: { tries: 1, sleep: async () => {} } } });
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
