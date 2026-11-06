// The restore kind (card pool-restore-wired, src/pool-restore.ts) through the page's api (src/api.ts startApi), with the
// wallet's real store and note store (fake-indexeddb) and the two pool restores replaced by fixed answers: every pool the
// page pins is read, what they find is written to the note store, the request is answered "started" at once, its
// progress says "reading" within every beat and ends "done", or "stalled" when a pool fails (the others' notes still
// written); one run at a time; auto runs once on an empty note store and never on one with notes; signed out it refuses.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { noteCommitment } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, refKey } from "../../wallet/src/notes/store.ts";
import type { RestoredNote } from "../../wallet/src/notes/restore.ts";
import { APP_ORIGIN, startApi } from "../src/api.ts";
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
  { chain: "solana", program: "Prog111", rpcs: () => [async () => null, async () => null] },
  { chain: "evm", pin: { network: "base-sepolia", pool: "0x1", feeRecipient: "0x2", fromBlock: 1n }, rpcs: () => [async () => null, async () => null] },
];

let db = 0;
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
async function world(over: Partial<PoolRestoreHost> = {}) {
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
    solana: (async (a: { program: string }) => (seen.push(`solana ${a.program}`), { notes: notesOf(SOL_SCOPE, LABEL_S, 1000n), spends: [] })) as never,
    evm: (async (a: { pin: { network: string }; wallets?: unknown; walletRpcs?: unknown; helper?: unknown }) => (seen.push(`evm ${a.pin.network} wallets ${String(a.wallets)} ${"walletRpcs" in a || "helper" in a ? "with W reads" : "no W reads"}`), { notes: notesOf(EVM_SCOPE, LABEL_E, 2000n), spends: [], elsewhere: [], wallets: [], block: 1n })) as never,
    ...over,
  };
  return { store, host, seeds, seen, r: poolRestore(host) };
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

  const unread: RestorePool = { chain: "evm", pin: { network: "base", pool: "0x1", feeRecipient: "0x2", fromBlock: 1n }, rpcs: null };
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
  await ns.planDeposit(SOL_SCOPE, () => 77n);
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
