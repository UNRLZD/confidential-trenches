// The hand-off with the real relayWithdraw, and the arrival read after it (split from test/withdraw-handoff.test.ts, card
// readme-run-fits-an-agent-timeout; the world in ./withdraw-handoff-world.ts).
// Real proofs: only "hand-off with the real relayWithdraw ...", the hand-off end to end with a real proof to a landed
// change note; every other test reads the relay's outcome and the notes, so its page proves on signalsProver.
//   node --test test/withdraw-handoff-relay.test.ts   (from packages/signpage)
/// <reference types="node" />
// the world first: it loads the 1Click mock and sets __SIGN_NETWORK__ before the modules that read them (./withdraw-handoff-world.ts)
import { RELAY_FEE, T, bytes, expired, handoffOf, helper, leftReserved, openNoteStore, page, pair, settleWith, testnet, view, withdrawSettle, world, zeroed, snarkProver } from "./withdraw-handoff-world.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { RelayOutcome, RelayRpc } from "../../wallet/src/withdraw/relay.ts";
import { untilAborted } from "../../kit/src/abort.ts";
import type { WithdrawRequest } from "../../wallet/src/withdraw/request.ts";
import type { HandoffOver, HandoffPage } from "../src/withdraw/handoff.ts";

// ---------- the real relayWithdraw: the seed zeroed right after the call (it copies the seed before its first await) ----------
const { relayWithdraw } = await import("../../wallet/src/withdraw/relay.ts");
const BLOCK_MS = 1_800_000_000_000;
type Spend = { nh: bigint; withdrawn: bigint; newLeaf: number; context: bigint; h: number };
// the wallet's withdraw-relay.test.ts Chain: a model vault's pages on the testnet release pair
class Chain {
  height = 175_000_000;
  times = new Map<number, bigint>([[this.height, BigInt(BLOCK_MS)]]);
  leaves: { v: bigint; h: number }[] = Array.from({ length: 8 }, (_, k) => ({ v: BigInt(100 + k), h: 0 }));
  spends: Spend[] = [{ nh: 41n, withdrawn: 1_000_000n, newLeaf: 7, context: 43n, h: 0 }];
  status = "in_flight";
  recipient = "a".repeat(64);
  refundValue = "0";
  land(nh: bigint, withdrawn: bigint, leaf: bigint, context: bigint): void {
    this.leaves.push({ v: leaf, h: this.height });
    this.spends.push({ nh, withdrawn, newLeaf: this.leaves.length - 1, context, h: this.height });
  }
  views(at: number) {
    const leaves = this.leaves.filter((l) => l.h <= at);
    const spends = this.spends.filter((s) => s.h <= at);
    const tree = (n: number) => ({ size: n, depth: n <= 1 ? 0 : Math.ceil(Math.log2(n)), root: "7" });
    return {
      state_tree: tree(leaves.length),
      label_tree: tree(0),
      spends: spends.map((s, index) => ({
        index, nullifier_hash: String(s.nh), withdrawn: String(s.withdrawn), new_leaf_index: s.newLeaf, refund_precommitment: "5",
        refund_value: this.refundValue, refund_label: "0", refund_leaf_index: 0, status: this.status,
        payer: "relayer.confidential.unrlzd.near", reserve: "0", recipient: this.recipient, fee: "30000", context: String(s.context),
      })),
      leaves: leaves.map((l) => String(l.v)),
    } as Record<string, unknown>;
  }
  rpcs(): [RelayRpc, RelayRpc] {
    const one = (name: string): RelayRpc => ({
      name,
      query: async (p) => {
        const at = p.finality === "final" ? this.height : (p.block_id as number);
        const args = JSON.parse(atob(p.args_base64 as string)) as { from?: number; limit?: number };
        let view = this.views(at)[p.method_name as string];
        if (Array.isArray(view)) view = view.slice(Math.min(args.from!, view.length), Math.min(args.from! + args.limit!, view.length));
        return { jsonrpc: "2.0", id: "x", result: { block_hash: `hash-${at}`, block_height: at, logs: [], result: [...new TextEncoder().encode(JSON.stringify(view))] } };
      },
      block: async (p) => {
        const block_id = "block_id" in p ? p.block_id : this.height;
        const t = this.times.get(block_id)!;
        return { jsonrpc: "2.0", id: "x", result: { header: { height: block_id, hash: `hash-${block_id}`, timestamp: 0, timestamp_nanosec: (t * 1_000_000n).toString(), gas_price: "100000000" } } };
      },
    });
    return [one(T.fastnear[0]), one(T.drpc)];
  }
}
const sig = (r: WithdrawRequest, k: number): bigint => BigInt(r.body.public_signals[k]);
/** The real relayWithdraw, called synchronously (as the hand-off and the settle pass call it), its own spend landed first. */
const realRelayLanded = (c: Chain): HandoffOver["relay"] => (seed, req, deps) => {
  c.land(sig(req, 1), sig(req, 2), sig(req, 0), sig(req, 7));
  return relayWithdraw(seed, req, { ...deps, rpcs: c.rpcs() });
};

const { withdrawArrival } = await import("../../wallet/src/withdraw/arrival.ts");

test("hand-off with the real relayWithdraw: the seed zeroed after the call, its own spend is still landed with the change note", async () => {
  const v = await world([5_000_000n]);
  const p = page(v, snarkProver); // a real proof, carried the whole way to a landed change note
  const h = await handoffOf(v, p, { relay: realRelayLanded(new Chain()) });
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "landed" });
  assert.ok(zeroed(p.opened[0]!));
  const change = (await v.ns.list()).find((n) => n.ref.kind === "change");
  assert.ok(change, "the change note is written");
  assert.equal(change!.state, "UNSPENT");
});

test("hand-off for the NEAR buy: the note the caller picked is the one spent, and a landing the relayer named a tx for carries that tx", async () => {
  const v = await world([2_000_000n, 5_000_000n, 10_000_000n]);
  const big = (await v.ns.list()).find((n) => n.leaf?.value === 10_000_000n)!;
  let spent = "";
  const TX = "4".repeat(44);
  const h = await handoffOf(v, page(v), {
    relay: async (_seed, req) => {
      spent = req.noteId;
      return { kind: "landed", own: false, change: (await v.ns.get(req.noteId))!, spend: { recipient: req.recipient, status: "paid", refundValue: 0n } as never, tx: TX };
    },
  });
  assert.deepEqual(await h({ recipient: "ab".repeat(32), amount: 3_000_000n }, RELAY_FEE, big.id), { kind: "arrived", tx: TX });
  assert.equal(spent, big.id);
});

test("settle pass with the real relayWithdraw: a stored request whose own spend landed is settled landed, its change written", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const p = page(v);
  const pass = await settleWith(v, realRelayLanded(new Chain()), p);
  assert.deepEqual(pass.outcomes, { [req.noteId]: "landed" });
  const change = (await v.ns.list()).find((n) => n.ref.kind === "change");
  assert.ok(change, "the change note is written (an 'unmatched' here would mark the note SPENT with no change)");
  assert.equal((await v.ns.get(req.noteId))!.state, "SPENT");
  assert.ok(zeroed(p.opened[0]!));
});

test("settle pass: two passes (two tabs) on one RESERVED note, both with the real relay: one change note, the note SPENT, neither pass throws", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const c = new Chain();
  c.land(sig(req, 1), sig(req, 2), sig(req, 0), sig(req, 7));
  const relay: HandoffOver["relay"] = (seed, r, deps) => relayWithdraw(seed, r, { ...deps, rpcs: c.rpcs() });
  const tabB = await openNoteStore(v.w);
  const pB = { ...page(v), notes: async () => tabB };
  const [a, b] = await Promise.all([settleWith(v, relay), settleWith(v, relay, pB as never)]);
  tabB.close();
  const kinds = [a.outcomes[req.noteId], b.outcomes[req.noteId]].sort();
  const changes = (await v.ns.list()).filter((n) => n.ref.kind === "change");
  assert.equal(changes.length, 1, "one change note");
  assert.equal((await v.ns.get(req.noteId))!.state, "SPENT");
  assert.deepEqual(kinds, ["landed", "landed"], `outcomes ${kinds.join(",")}`);
});

test("settle pass: a RESERVED vault note with no stored request is skipped and left RESERVED", async () => {
  const v = await world([5_000_000n]);
  const [n] = await v.ns.list();
  const held = await v.ns.move(n!.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "7" });
  await v.ns.move(n!.id, "HELD", "RESERVED", { attempt: held.attempt });
  let called = 0;
  const p = page(v);
  const pass = await settleWith(v, async () => { called += 1; throw new Error("x"); }, p);
  assert.deepEqual(pass.outcomes, {});
  assert.equal(called, 0);
  assert.equal(p.opened.length, 0);
  assert.equal((await v.ns.get(n!.id))!.state, "RESERVED", "nothing on this page ever frees it");
});


// the r3 re-check (card signpage-withdraw-handoff)
const rejections: unknown[] = [];
process.on("unhandledRejection", (e) => void rejections.push(e));

test("the settle pass: a bad stored request listed after a note whose relay still waits fails alone, its refusal never unhandled meanwhile", async () => {
  const v = await world([5_000_000n, 6_000_000n]);
  const req = await leftReserved(v);
  const other = (await v.ns.list()).find((n) => n.id !== req.noteId && n.ref.kind === "deposit")!;
  const held = await v.ns.move(other.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "7" });
  await v.ns.move(other.id, "HELD", "RESERVED", { attempt: held.attempt, request: "{}" }); // JSON, not a request body
  // the waiting note listed first, the bad one after it
  const list = async () => {
    const all = await v.ns.list();
    return [...all.filter((n) => n.id === req.noteId), ...all.filter((n) => n.id !== req.noteId)];
  };
  const ns = new Proxy(v.ns, { get: (t, k) => (k === "list" ? list : (Reflect.get(t, k) as (...a: unknown[]) => unknown)?.bind?.(t) ?? Reflect.get(t, k)) });
  const p = { ...page(v), notes: async () => ns };
  const before = rejections.length;
  const slow: HandoffOver["relay"] = async (_s, r) => (await new Promise((ok) => setTimeout(ok, 50)), expired(v, r));
  const pass = await withdrawSettle(p, { network: "testnet", rpcs: pair("testnet"), priceRpcs: pair("mainnet"), fetchFn: helper(), relay: slow });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.deepEqual(pass.outcomes, { [req.noteId]: "expired", [other.id]: "failed" });
  assert.ok(zeroed(p.opened[0]!));
  assert.deepEqual(rejections.slice(before), [], "a rejection went unhandled while the first note's relay waited");
});

test("the settle pass on a ragequit whose SPENT move fails (another tab moved the note first): failed, never spent", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const pass = await settleWith(v, async () => {
    await v.ns.move(req.noteId, "RESERVED", "SPENT"); // another tab's pass got there first
    return { kind: "unmatched", spend: { context: 0n } as never };
  });
  assert.deepEqual(pass.outcomes, { [req.noteId]: "failed" });
});

// ---------- card wallet-withdraw-move-out: the vault pays the typed account; the arrival read on the pair ----------
const paidTo = (to: string, status = "paid", refundValue = "0"): Chain => Object.assign(new Chain(), { status, recipient: to, refundValue });
/** A fetch that counts every POST /v1/withdraw (a send) and answers the fee for anything else. */
function counting(posts: string[]): typeof fetch {
  const fee = helper();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(String(init.body));
      return new Response(JSON.stringify({ error: { code: "in_flight" } }), { status: 409, headers: { "content-type": "application/json" } });
    }
    return fee(input, init);
  }) as typeof fetch;
}

test("the hand-off ends at the arrival: landed on the pair, then the spend reads paid to the typed account: arrived", async () => {
  const v = await world([5_000_000n]);
  const c = paidTo("alice.testnet");
  const h = await handoffOf(v, page(v), { relay: realRelayLanded(c), arrivalRpcs: c.rpcs(), arrival: withdrawArrival });
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "arrived" });
});

test("the payout failed (refund_pending): the hand-off ends refunded, never arrived", async () => {
  const v = await world([5_000_000n]);
  const c = paidTo("alice.testnet", "refund_pending", "3188142");
  const h = await handoffOf(v, page(v), { relay: realRelayLanded(c), arrivalRpcs: c.rpcs(), arrival: withdrawArrival });
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "refunded" });
});

test("resume: the page dies after the relay landed, before the arrival read: the rerun sends nothing new and relays nothing", async () => {
  const v = await world([5_000_000n]);
  const c = paidTo("alice.testnet");
  const died = new Error("page died after the relay");
  const h = await handoffOf(v, page(v), { relay: realRelayLanded(c), arrival: async () => Promise.reject(died) });
  // the relay's landing is kept: the change note written, the spent note SPENT; the arrival unread
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "landed" });
  const spent = (await v.ns.list()).find((n) => n.ref.kind !== "change")!;
  assert.equal(spent.state, "SPENT");
  // the rerun (a reload's settle pass) on the same store: no note is RESERVED, so nothing is sent or relayed again
  const posts: string[] = [];
  let relayed = 0;
  const pass = await withdrawSettle(page(v), { network: "testnet", rpcs: c.rpcs(), priceRpcs: pair("mainnet"), fetchFn: counting(posts), relay: async () => (relayed++, Promise.reject(new Error("no relay"))) });
  assert.deepEqual(pass.outcomes, {});
  assert.equal(relayed, 0);
  assert.deepEqual(posts, []);
});

test("resume: the page dies after the send, before landed: the rerun sends the same bytes once, then reads the arrival", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const c = paidTo("alice.testnet");
  const posts: string[] = [];
  let calls = 0;
  const pass = await withdrawSettle(page(v), {
    network: "testnet", rpcs: c.rpcs(), priceRpcs: pair("mainnet"), fetchFn: counting(posts), arrivalRpcs: c.rpcs(),
    relay: (seed, r, deps) => {
      calls++;
      assert.equal(JSON.stringify(r.body), JSON.stringify(req.body), "the stored bytes, never re-proved");
      return realRelayLanded(c)!(seed, r, deps);
    },
  });
  assert.deepEqual(pass.outcomes, { [req.noteId]: "arrived" });
  assert.equal(calls, 1);
  assert.ok(posts.every((b) => b === JSON.stringify(req.body)), "any send is the same bytes");
  // a second rerun: nothing RESERVED, nothing sent
  const again = await withdrawSettle(page(v), { network: "testnet", rpcs: c.rpcs(), priceRpcs: pair("mainnet"), fetchFn: counting(posts), relay: async () => Promise.reject(new Error("no relay")) });
  assert.deepEqual(again.outcomes, {});
});

// review of c19ad399, L3: a landing by another attempt of these words (another device, own false) ends on its spend row
test("a landing that is not own, paid to another account, ends elsewhere (never a bare landed)", async () => {
  const v = await world([5_000_000n]);
  const c = paidTo("eve.testnet");
  const h = await handoffOf(v, page(v), {
    relay: async (_seed, r) => ({ kind: "landed", own: false, change: (await v.ns.get(r.noteId))!, spend: { nullifierHash: BigInt(r.body.public_signals[1]), recipient: "eve.testnet", status: "paid", refundValue: 0n } as never, tx: null }),
    arrivalRpcs: c.rpcs(),
    arrival: async () => Promise.reject(new Error("a landing that is not own reads no arrival")),
  });
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "elsewhere" });
});

// review of c19ad399, L4: one deadline per tap, so a tap never waits HANDOFF_WAIT_MAX_MS twice
test("the relay and the arrival read after it share one deadline: the same signal", async () => {
  const v = await world([5_000_000n]);
  const c = paidTo("alice.testnet");
  let relaySignal: AbortSignal | undefined;
  let arrivalSignal: AbortSignal | undefined;
  const landed = realRelayLanded(c)!;
  const h = await handoffOf(v, page(v), {
    relay: async (seed, r, deps) => ((relaySignal = deps.signal), landed(seed, r, deps)),
    arrivalRpcs: c.rpcs(),
    arrival: async (a) => ((arrivalSignal = a.signal), withdrawArrival(a)),
  });
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "arrived" });
  assert.ok(relaySignal instanceof AbortSignal);
  assert.equal(arrivalSignal, relaySignal, "the arrival waits under the relay's own deadline, not a fresh one");
});

// review of a6903d91, N1: the settle pass follows each note from its own relay to its own arrival, all at once, so a
// note held to the bound never cuts a later note's arrival, and each arrival waits under its own note's deadline (M6)
test("the settle pass: a note held to the bound never ends a later note's arrival, each read under its own note's deadline", async () => {
  const v = await world([5_000_000n, 6_000_000n]);
  const a = await leftReserved(v);
  const b = await leftReserved(v);
  assert.notEqual(a.noteId, b.noteId);
  const list = async () => {
    const all = await v.ns.list();
    return [...all.filter((n) => n.id === a.noteId), ...all.filter((n) => n.id !== a.noteId)];
  };
  const ns = new Proxy(v.ns, { get: (t, k) => (k === "list" ? list : (Reflect.get(t, k) as (...x: unknown[]) => unknown)?.bind?.(t) ?? Reflect.get(t, k)) });
  const c = paidTo("alice.testnet");
  const landed = realRelayLanded(c)!;
  const relaySignals = new Map<string, AbortSignal>();
  const arrivalSignals: AbortSignal[] = [];
  const pass = await withdrawSettle({ ...page(v), notes: async () => ns }, {
    network: "testnet", rpcs: c.rpcs(), priceRpcs: pair("mainnet"), fetchFn: helper(), arrivalRpcs: c.rpcs(), waitMs: 3_000,
    relay: async (seed, r, deps) => {
      relaySignals.set(r.noteId, deps.signal!);
      // A: a pair that never settles, held until its bound
      if (r.noteId === a.noteId) return untilAborted(deps.signal!);
      return landed(seed, r, deps);
    },
    // B's payout runs 500 ms after its landing: the arrival waits for it under its signal, as the pair's rounds do
    arrival: async (x) => {
      arrivalSignals.push(x.signal!);
      await new Promise<void>((ok, no) => {
        if (x.signal!.aborted) return no(x.signal!.reason);
        const t = setTimeout(ok, 500);
        x.signal!.addEventListener("abort", () => (clearTimeout(t), no(x.signal!.reason)), { once: true });
      });
      return withdrawArrival(x);
    },
  });
  assert.deepEqual(pass.outcomes, { [a.noteId]: "failed", [b.noteId]: "arrived" });
  assert.equal(arrivalSignals.length, 1);
  assert.equal(arrivalSignals[0], relaySignals.get(b.noteId), "B's arrival waits under B's own deadline, never a fresh one");
});
