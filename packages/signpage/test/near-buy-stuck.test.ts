// A paid W that was never created, once its buy's resumes are spent: the money paid to W has a way home once the helper
// answers again (src/near-buy.ts resumeNearSells, createNearW).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../../wallet/src/store/index.ts";
import type { HelperBindTradeRequest } from "../../kit/src/helper/v1.ts";
import { NEAR_BUY_KEY, NEAR_BUY_RESUMES, nearBuyKind, nearBuyRecordOf, resumeNearBuys, resumeNearSells, type NearBuyPage } from "../src/near-buy.ts";
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

test("a paid W whose creation never came (the helper down through the buy and its resumes) is created once the helper answers again, and its USDC starts home", async () => {
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
      // created: no token, the payout's USDC
      return { account: a.wallet, height: 1, blockHash: "b", nonce: 1n, held: a.side === "sell" ? 0n : 3_000_000n, registered: true, storageMin: 0n, lostfound: 0n };
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
  // the helper is back: the creation body (no delegate) makes W
  const bodies: HelperBindTradeRequest[] = [];
  page.fetchFn = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as HelperBindTradeRequest;
    bodies.push(body);
    if (body.signed_delegates.length === 0) created = true;
    return new Response(JSON.stringify({ tx_hashes: ["5".repeat(44)] }), { status: 200 });
  }) as typeof fetch;
  await resumeNearBuys(page);
  assert.equal(bodies.length, 0, "the buy is past its resumes");
  await resumeNearSells(page);
  assert.deepEqual(bodies.map((b) => [b.trade.side, b.trade.wallet, b.trade.token, b.signed_delegates.length]), [["buy", rec.w, TOKEN, 0]]);
  assert.ok(created);
  const after2 = nearBuyRecordOf(await w.get("quotes", `${NEAR_BUY_KEY}req-1`))!;
  // W's USDC on its way home: the sale's return note written with its call before the move (the move itself is the
  // vault suites'; here its providers are down, so the sell stops sent and the next load goes on)
  assert.equal(after2.sell?.stage, "sent");
  const home = (await ns.list()).filter((x) => x.ref.kind === "return" && x.ref.c === "near");
  assert.equal(home.length, 1);
  assert.equal(home[0]!.calls?.length ?? 0, 0);
});

test("W read absent: the sell's resume asks its creation only past the buy's resumes and with the payout landed by its own proof", async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  worlds.push({ w, ns });
  let n = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
  const label = vaultLabelOf(keccak_256, SCOPE, 1n);
  n = await ns.move(n.id, "PLANNED", "INCOMING");
  await ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value: 5_000_000n, label, commitment: noteCommitment(5_000_000n, label, n.precommitment), leafIndex: 0n } });
  const x = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "7" });
  await ns.move(x.id, "HELD", "RESERVED", { attempt: x.attempt!, request: "{}" });
  await ns.move(n.id, "RESERVED", "SPENT");
  await w.put("quotes", `${NEAR_BUY_KEY}r1`, { v: 1, id: "r1", network: NETWORK, token: TOKEN, amount: "3000000", slippage_bps: 100, w: "ab".repeat(32), l: "1", j: 0, note: n.id, fee: "1", created_ms: 1, resumes: 0, stage: "sent", step: "create", txs: [], payout: "landed" });
  let asked = 0;
  const page = {
    network: NETWORK,
    store: async () => w,
    notes: async () => ns,
    readWallet: async () => Promise.reject(new Error("rpc: W's keys: no account")),
    fetchFn: (async () => (asked++, new Response("{}", { status: 200 }))) as typeof fetch,
    log: () => {},
  } as unknown as NearBuyPage;
  await resumeNearSells(page);
  assert.equal(asked, 0);
  // past its resumes with its payout not proven landed (only asked): nothing is asked
  await w.put("quotes", `${NEAR_BUY_KEY}r1`, { ...((await w.get("quotes", `${NEAR_BUY_KEY}r1`)) as object), resumes: NEAR_BUY_RESUMES, payout: "asked" });
  await resumeNearSells(page);
  assert.equal(asked, 0);
  // past its resumes with its payout landed, the record's creation is asked once per load
  await w.put("quotes", `${NEAR_BUY_KEY}r1`, { ...((await w.get("quotes", `${NEAR_BUY_KEY}r1`)) as object), payout: "landed" });
  await resumeNearSells(page);
  assert.equal(asked, 1);
});

test("a payout proven landed with its note not (yet) SPENT in this store (a RESERVED request naming W, the vault's spend row): the W is paid for its way home and for a sell", async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  worlds.push({ w, ns });
  await w.put("quotes", `${NEAR_BUY_KEY}r1`, { v: 1, id: "r1", network: NETWORK, token: TOKEN, amount: "3000000", slippage_bps: 100, w: "ab".repeat(32), l: "1", j: 0, note: "not-in-this-store", fee: "1", created_ms: 1, resumes: NEAR_BUY_RESUMES, stage: "sent", step: "create", txs: [], payout: "landed" });
  let asked = 0;
  const page = {
    network: NETWORK,
    store: async () => w,
    notes: async () => ns,
    readWallet: async () => Promise.reject(new Error("rpc: W's keys: no account")),
    fetchFn: (async () => (asked++, new Response(JSON.stringify({ tx_hashes: [] }), { status: 200 }))) as typeof fetch,
    log: () => {},
  } as unknown as NearBuyPage;
  await resumeNearSells(page);
  assert.equal(asked, 1);
});
