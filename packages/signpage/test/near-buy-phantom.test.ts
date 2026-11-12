// A buy whose payout was only asked (its hand-off threw before the note was held), the note then spent by another
// withdrawal: never paid for the sell, so a tap sells the W that holds the token.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../../wallet/src/store/index.ts";
import { depsOf, NEAR_BUY_KEY, nearBuyKind, nearBuyRecordOf, nearPositions, nearSellKind, resumeNearBuys, resumeNearSells, type NearBuyPage } from "../src/near-buy.ts";
import { vaultScope } from "../src/withdraw/checks.ts";

const SEED = new Uint8Array(64).fill(0x42);
const NETWORK = "mainnet" as const;
const SCOPE = vaultScope(NETWORK)!;
const TX = "4".repeat(44);
const OTHER = "cd".repeat(32);
const X = "x.near";

globalThis.fetch = (async () => {
  throw new Error("no network in tests");
}) as typeof fetch;
const worlds: { w: WalletStore; ns: NoteStore }[] = [];
after(() => {
  for (const v of worlds.splice(0)) (v.ns.close(), v.w.close());
});

test("a tap's sell of a token is never held up by a buy whose note another withdrawal spent", async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  worlds.push({ w, ns });
  for (const [k, value] of [5_000_000n, 6_000_000n].entries()) {
    let n = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(k + 1));
    n = await ns.move(n.id, "PLANNED", "INCOMING");
    await ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value, label, commitment: noteCommitment(value, label, n.precommitment), leafIndex: BigInt(k) } });
  }
  let failHandoff = true;
  const page: NearBuyPage = {
    network: NETWORK,
    store: async () => w,
    notes: async () => ns,
    seed64: async () => Uint8Array.from(SEED),
    seedLock: (fn) => fn(),
    fee: async () => 20_000n,
    // the first buy's hand-off fails before withdrawRequest holds the note (the relayer's fee quote did not answer)
    handoff: async (_w, _d, note) => {
      if (failHandoff) throw new Error("fee quote: no answer");
      const n = await ns.move(note!, "UNSPENT", "HELD", { deadlineMs: 1n, context: "9" });
      await ns.move(n.id, "HELD", "RESERVED", { attempt: n.attempt!, request: JSON.stringify({ withdrawal: { recipient: _w.recipient } }) });
      await ns.move(note!, "RESERVED", "SPENT");
      return { kind: "arrived", tx: TX };
    },
    settle: async () => ({ outcomes: {} }),
    rpcs: () => {
      throw new Error("no reads here");
    },
    // no W reads here: a W never created reads as nothing (the kit's readNearSwapWallet refuses it)
    readWallet: async () => {
      throw new Error("rpc: W's keys: no account");
    },
    pools: async () => [],
    wait: async () => {},
    log: () => {},
  };
  // buy 1 of X: its payout asked, the hand-off throws before the note is held; the flow answers sent (not_known)
  const r1 = nearBuyKind(page)({ token: X, amount: 3_000_000n, slippageBps: 100 }, { id: "buy-1" } as never);
  assert.ok("running" in r1);
  await r1.after;
  const one = nearBuyRecordOf(await w.get("quotes", `${NEAR_BUY_KEY}buy-1`))!;
  assert.equal(one.stage, "sent");
  assert.equal(one.payout, "asked");
  // buy 2 of X: its own note, landed, filled with the token on its W (a position)
  failHandoff = false;
  const d2 = depsOf(page, null, "buy-2");
  const b2 = (await d2.begin({ token: X, amount: 3_000_000n, slippageBps: 100 }))!;
  assert.notEqual(b2.w.id, one.w);
  assert.equal((await d2.payout()).kind, "landed");
  await d2.progress({ step: "receive", stage: "filled", txs: [{ chain: "near", hash: TX }], fill: { out: "5000", decimals: 0 } });
  d2.release();
  assert.equal((await nearPositions(page))[0]?.wallets.length, 1);
  // the withdraw form (or a Solana pool buy) spends buy 1's note, which is UNSPENT and not held, to another account
  const n1 = (await ns.get(one.note))!;
  assert.equal(n1.state, "UNSPENT");
  const h = await ns.move(n1.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "7" });
  await ns.move(h.id, "HELD", "RESERVED", { attempt: h.attempt!, request: JSON.stringify({ withdrawal: { recipient: OTHER } }) });
  await ns.move(n1.id, "RESERVED", "SPENT");
  // the user sells X twice (no reload in between), then the page loads, then a third tap
  for (const id of ["sell-1", "sell-2"]) {
    const s = nearSellKind(page)({ token: X, slippageBps: 100 } as never, { id } as never);
    if ("running" in s) await s.after;
  }
  await resumeNearBuys(page);
  await resumeNearSells(page);
  const s3 = nearSellKind(page)({ token: X, slippageBps: 100 } as never, { id: "sell-3" } as never);
  if ("running" in s3) await s3.after;
  const a = nearBuyRecordOf(await w.get("quotes", `${NEAR_BUY_KEY}buy-1`))!;
  const b = nearBuyRecordOf(await w.get("quotes", `${NEAR_BUY_KEY}buy-2`))!;
  assert.ok(
    b.sell !== undefined,
    `every tap took buy 1 (never paid: its note went to another account) and never buy 2's W, which holds the token; buy 1 is left ${a.stage}/${a.code}, payout ${a.payout}, sell ${a.sell?.stage}/${a.sell?.code} (id ${a.sell?.id})`,
  );
});
