// A paid W never created, its buy past its resumes, that a sell tap reaches before any load once the helper answers
// again: the tap is refused with nothing sent, and the next load still creates W and brings its USDC home.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../../wallet/src/store/index.ts";
import { NEAR_BUY_KEY, NEAR_BUY_RESUMES, nearBuyKind, nearBuyRecordOf, nearSellKind, resumeNearBuys, resumeNearSells, type NearBuyPage } from "../src/near-buy.ts";
import { vaultScope } from "../src/withdraw/checks.ts";

const SEED = new Uint8Array(64).fill(0x42);
const NETWORK = "mainnet" as const;
const SCOPE = vaultScope(NETWORK)!;
const TOKEN = "token.rhealab.near";
const TX = "4".repeat(44);

const worlds: { w: WalletStore; ns: NoteStore }[] = [];
after(() => {
  for (const v of worlds.splice(0)) (v.ns.close(), v.w.close());
});

test("a sell tap that reaches a paid W never created before any load is refused with nothing sent; the next load still creates W and its USDC starts home", async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  worlds.push({ w, ns });
  let n = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
  const label = vaultLabelOf(keccak_256, SCOPE, 1n);
  n = await ns.move(n.id, "PLANNED", "INCOMING");
  await ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value: 5_000_000n, label, commitment: noteCommitment(5_000_000n, label, n.precommitment), leafIndex: 0n } });
  let created = false;
  const no = { name: "none", query: async () => Promise.reject(new Error("no network in tests")), tx: async () => Promise.reject(new Error("no network in tests")) };
  const reads: string[] = [];
  const page: NearBuyPage = {
    network: NETWORK,
    store: async () => w,
    notes: async () => ns,
    seed64: async () => Uint8Array.from(SEED),
    seedLock: (fn) => fn(),
    fee: async () => 20_000n,
    handoff: async (_w, _d, note) => {
      await ns.move(note!, "UNSPENT", "HELD", { deadlineMs: 1n, context: "7" }).then((x) => ns.move(x.id, "HELD", "RESERVED", { attempt: x.attempt!, request: "{}" }));
      await ns.move(note!, "RESERVED", "SPENT");
      return { kind: "arrived", tx: TX };
    },
    settle: async () => ({ outcomes: {} }),
    rpcs: () => {
      throw new Error("no reads here");
    },
    // W was never created: it has no key list, so every read of it is refused (the kit's readNearSwapWallet "rpc")
    readWallet: async (a) => {
      reads.push(a.side);
      if (!created) throw new Error("rpc: W's keys: no account");
      return { account: a.wallet, height: 100, blockHash: "h", nonce: 0n, held: a.side === "buy" ? 3_000_000n : 0n, registered: true, storageMin: 1n, lostfound: 0n } as never;
    },
    pools: async () => [],
    wait: async () => {},
    // the helper is down: no answer
    fetchFn: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    log: () => {},
    // nothing here reaches a network: the move's providers throw, its wait is over before it starts
    bindRpcs: () => [no, no],
    signal: () => AbortSignal.abort(),
  };
  // the tap: the payout lands, then the creation's quote or helper never answers
  const r = nearBuyKind(page)({ token: TOKEN, amount: 3_000_000n, slippageBps: 100 }, { id: "req-1" } as never);
  assert.ok("running" in r);
  await r.after;
  // three page loads while the helper is down
  for (let i = 0; i < NEAR_BUY_RESUMES; i++) await resumeNearBuys(page);
  const rec = nearBuyRecordOf(await w.get("quotes", `${NEAR_BUY_KEY}req-1`))!;
  assert.equal(rec.stage, "sent");
  assert.equal(rec.resumes, NEAR_BUY_RESUMES);
  // the helper is back: a load and a sell tap
  const asked: string[] = [];
  page.fetchFn = (async (_u: unknown, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    asked.push(b.signed_delegates.length === 0 ? "create" : "carry");
    if (b.signed_delegates.length === 0) created = true;
    return new Response(JSON.stringify({ tx_hashes: [TX] }), { status: 200 });
  }) as typeof fetch;
  // a sell tap of the token before any load: W cannot be read, so the sell is refused with nothing sent
  const t = nearSellKind(page)({ token: TOKEN, slippageBps: 100 } as never, { id: "sell-0" } as never);
  if ("running" in t) await t.after;
  const tapped = nearBuyRecordOf(await w.get("quotes", `${NEAR_BUY_KEY}req-1`))!;
  assert.deepEqual([tapped.sell?.stage, tapped.sell?.txs.length], ["refused", 0]);
  assert.deepEqual(asked, []);
  const before = reads.length;
  await resumeNearBuys(page);
  await resumeNearSells(page);
  const s = nearSellKind(page)({ token: TOKEN, slippageBps: 100 } as never, { id: "sell-1" } as never);
  if ("running" in s) await s.after;
  const after2 = nearBuyRecordOf(await w.get("quotes", `${NEAR_BUY_KEY}req-1`))!;
  assert.equal(asked[0], "create", "the load asks W's creation");
  assert.ok(created, `the buy is left at ${after2.stage}/${after2.code} with W never created: no load and no tap goes on (W read ${reads.length - before} times since, sell ${after2.sell?.stage}/${after2.sell?.code})`);
});
