// card evm-first-proof-inside-ten-seconds: the one proof pass a landing of the device's own deposit starts reads as that
// deposit's last step (the trade's pool, on the deposit's pair and sync), so it never waits for a host window the
// landing's own reads filled (a Base mainnet copy of 13 Nov 05:38Z: 152 requests per host in the 10 s before it, the
// pass's first read waited 9.1 s). Only that pass: the deposit kind's landed (called once the round on the pool's two
// RPCs holds the note's Deposited, src/pool-deposit-evm.ts) starts it; a state read's pass, the pass after the landing's
// and every other one read on the pass pool, on their hosts' budget. Two pools are planted (evmQueuePools) and record
// which one each of the queue's reads went to.
//   node --test test/evm-landing-pass-trade.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { VAULT_FIELD_P, vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { testnetPool } = await import("../src/pool-testnet.ts");
const { EVM_EPOCH_MS, EVM_LADDER, EVM_LIFE_MS, EVM_SEND_MARGIN_MS, evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
type EvmPoolPin = import("../../wallet/src/pool/evm.ts").EvmPoolPin;
type EvmRpc = import("../../wallet/src/pool/evm.ts").EvmRpc;

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const PIN: EvmPoolPin = Object.freeze({ network: "base-sepolia", pool: "0x00000000000000000000000000000000000F0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n });
const SCOPE = evmPoolScopeOf(PIN.pool, 84532n);
const RUNG = EVM_LADDER.min;
const NOW = 1_800_000_000_000n + 1_000n;
const D0: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
const L0 = vaultLabelOf(keccak_256, SCOPE, 1n);
const P0 = noteSecrets(SEED64, D0).precommitment;
const ASK = { kind: "pool.deposit", chain: "base", token: null, amount: RUNG, slippageBps: 0, decimals: 18 } as const;
const CTX = { id: "dep", sha: "00", progress: () => {} };

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
async function wallet(): Promise<{ w: WalletStore; ns: NoteStore }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  await ns.add({ ref: D0, scope: SCOPE, precommitment: P0, state: "UNSPENT", leaf: { value: RUNG, label: L0, commitment: noteCommitment(RUNG, L0, P0), leafIndex: 0n } });
  return { w, ns };
}
/** A fake pool holding deposit 0's leaf, each read recorded as `<name>:<method>`. */
function recPool(name: string, calls: string[]): Pool<{ w: string }> {
  const state = [noteCommitment(RUNG, L0, P0)], labels = [L0];
  return {
    id: `evm:base-sepolia:${PIN.pool.toLowerCase()}`,
    chain: "evm",
    scope: SCOPE,
    ladder: EVM_LADDER,
    epochMs: EVM_EPOCH_MS,
    lifeMs: EVM_LIFE_MS,
    sendMarginMs: EVM_SEND_MARGIN_MS,
    now: async () => (calls.push(`${name}:now`), NOW),
    trees: async () => {
      calls.push(`${name}:trees`);
      const s = new VaultTree(state), l = new VaultTree(labels);
      return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
    },
    bind: async (b) => {
      calls.push(`${name}:bind`);
      const bytes = new TextEncoder().encode(`${b.wallet.address}|${b.chunk}|${b.deadlineMs}`);
      return { context: BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P, feeCap: 10n ** 12n, request: { w: b.wallet.address } };
    },
  };
}
const unread = (): readonly EvmRpc[] => ["https://a.example", "https://b.example"].map((url) => Object.assign(async () => assert.fail("no RPC read"), { url }));
const until = async (f: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
};
type Host = { landed?: (n?: unknown) => void };

function page(w: WalletStore, calls: string[], hosts: (() => Host)[]) {
  return testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED64.slice() }, {
    prover: { vault: signalsProver(), stop: () => {} },
    hardwareConcurrency: 2,
    evmPin: (c: string) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => Promise.reject(new Error("no settle round here")) }),
    evmQueuePools: () => ({ pass: recPool("pass", calls), trade: recPool("trade", calls) }),
    depositKinds: { solana: () => () => ({ error: "not_allowed" }), evm: (host: () => Host) => () => (hosts.push(host), { error: "not_allowed" }) },
  } as never);
}

test("the pass a landing starts reads every pool read (the time, the trees, the binding) on the deposit's own pool; the pass after it reads on the pass pool", async () => {
  const { w } = await wallet();
  const calls: string[] = [];
  const hosts: (() => Host)[] = [];
  const t = page(w, calls, hosts);
  t.flow(ASK as never, CTX);
  assert.equal(hosts.length, 1, "the Base deposit kind was built");
  hosts[0]!().landed!();
  await until(() => calls.includes("trade:bind"));
  const landing = calls.splice(0);
  assert.ok(landing.length >= 3 && landing.every((c) => c.startsWith("trade:")), `the landing's pass on the deposit's pool alone: ${landing.join(", ")}`);
  assert.ok(landing.includes("trade:now") && landing.includes("trade:trees") && landing.includes("trade:bind"), landing.join(", "));
  // a state read's pass after it: the pass pool alone
  await t.stateRead();
  await until(() => calls.some((c) => c.endsWith(":now")));
  assert.ok(calls.length > 0 && calls.every((c) => c.startsWith("pass:")), `the next pass on the pass pool: ${calls.join(", ")}`);
});

test("the notes one round claims start one landing pass, and a page with no landing never reads on the deposit's pool", async () => {
  const { w } = await wallet();
  const calls: string[] = [];
  const hosts: (() => Host)[] = [];
  const t = page(w, calls, hosts);
  t.flow(ASK as never, CTX);
  const h = hosts[0]!();
  // three notes claimed in one round: one tick, one pass
  h.landed!();
  h.landed!();
  h.landed!();
  await until(() => calls.includes("trade:bind"));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.filter((c) => c === "trade:now").length, 1, `one landing pass: ${calls.join(", ")}`);

  const { w: w2 } = await wallet();
  const calls2: string[] = [];
  const t2 = page(w2, calls2, []);
  for (let i = 0; i < 3; i++) await t2.stateRead();
  await until(() => calls2.some((c) => c.endsWith(":bind")));
  assert.ok(calls2.length > 0, "the state reads ran a pass");
  assert.ok(calls2.every((c) => c.startsWith("pass:")), `no landing: the pass pool alone: ${calls2.join(", ")}`);
});

test("the pool's history is read once a deposit is in sight (evmPoolOf: a quote's floor, its follow, a restore), on the pool's pass sync, once a page; a failed read is asked again", async () => {
  const { w } = await wallet();
  let rounds = 0;
  let fail = true;
  const t = testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED64.slice() }, {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c: string) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => (rounds++, fail ? Promise.reject(new Error("down")) : { fin: {}, anchor: {}, events: [] }) }),
  } as never);
  assert.notEqual(t.evmPoolOf("base"), null);
  await until(() => rounds === 1);
  await new Promise((r) => setTimeout(r, 20));
  fail = false;
  t.evmPoolOf("base");
  await until(() => rounds === 2);
  t.evmPoolOf("base");
  t.evmPoolOf("base");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rounds, 2, "one read after the failed one, then none");
  assert.equal(t.evmPoolOf("robinhood"), null, "no pin: no pool, nothing read");
});

// the deposit's round and the history read (evmWarmWait): the round waits for the read the page started, at most the
// bound, then reads its own; a read that fails is asked again once, and after a second failure the round reads as before.
// The two syncs are told apart by when the page makes them: the deposit's first (its own pair), then the pass sync.
type Round = { round?: (signal?: AbortSignal) => Promise<unknown> };
function twoSyncs(w: WalletStore, pass: () => Promise<unknown>, o: { waitMs?: number } = {}) {
  const calls: string[] = [];
  const hosts: (() => Round)[] = [];
  let made = 0;
  const t = testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED64.slice() }, {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c: string) => (c === "base" ? PIN : undefined),
    evmSync: () => {
      const name = made++ === 0 ? "deposit" : "pass";
      return { events: async () => (calls.push(`${name}:events`), name === "pass" ? pass() : { fin: { number: 1n }, anchor: {}, events: [] }) };
    },
    ...(o.waitMs === undefined ? {} : { evmWarmWaitMs: o.waitMs }),
    depositKinds: { solana: () => () => ({ error: "not_allowed" }), evm: (host: () => Round) => () => (hosts.push(host), { error: "not_allowed" }) },
  } as never);
  t.flow(ASK as never, CTX);
  return { t, calls, round: (signal?: AbortSignal) => hosts[0]!().round!(signal) };
}
test("the deposit's round waits for the pool's history read the page started, then reads on its own sync (its hold): it never reads beside it", async () => {
  const { w } = await wallet();
  let done: (v: unknown) => void = () => {};
  const s = twoSyncs(w, () => new Promise((r) => (done = r)));
  assert.notEqual(s.t.evmPoolOf("base"), null);
  await until(() => s.calls.includes("pass:events"));
  const r = s.round();
  await new Promise((x) => setTimeout(x, 80));
  assert.deepEqual(s.calls, ["pass:events"], "the round has read nothing while the history read runs");
  done({ fin: {}, anchor: {}, events: [] });
  await r;
  assert.deepEqual(s.calls, ["pass:events", "deposit:events"]);
  // read once: the next round waits on nothing
  await s.round();
  assert.deepEqual(s.calls, ["pass:events", "deposit:events", "deposit:events"]);
});

test("the wait is bounded (EVM_WARM_WAIT_MS, 20 s): past it the round reads as before, on its own sync", async () => {
  const { EVM_WARM_WAIT_MS } = await import("../src/pool-testnet.ts");
  assert.equal(EVM_WARM_WAIT_MS, 20_000);
  const { w } = await wallet();
  const s = twoSyncs(w, () => new Promise(() => {}), { waitMs: 120 });
  s.t.evmPoolOf("base");
  const r = s.round();
  await new Promise((x) => setTimeout(x, 40));
  assert.deepEqual(s.calls, ["pass:events"], "inside the bound (120 ms) the round has read nothing");
  const got = await Promise.race([r.then(() => "read"), new Promise((x) => setTimeout(() => x("still waiting"), 2_000))]);
  assert.equal(got, "read", "past the bound the round reads, the history read still running");
  assert.deepEqual(s.calls, ["pass:events", "deposit:events"]);
});

test("a history read that fails is asked again once; after a second failure the round reads as before, and one asked again that reads is waited for", async () => {
  const { w } = await wallet();
  const s = twoSyncs(w, () => Promise.reject(new Error("down")));
  s.t.evmPoolOf("base");
  await until(() => s.calls.includes("pass:events"));
  await new Promise((x) => setTimeout(x, 20));
  await s.round();
  assert.deepEqual(s.calls, ["pass:events", "pass:events", "deposit:events"], "the failed read asked again once, then the round's own");

  const { w: w2 } = await wallet();
  let k = 0;
  let done: (v: unknown) => void = () => {};
  const s2 = twoSyncs(w2, () => (k++ === 0 ? Promise.reject(new Error("down")) : new Promise((r) => (done = r))));
  const r = s2.round();
  await until(() => s2.calls.filter((c) => c === "pass:events").length === 2);
  await new Promise((x) => setTimeout(x, 50));
  assert.deepEqual(s2.calls, ["pass:events", "pass:events"], "the round waits for the read asked again");
  done({ fin: {}, anchor: {}, events: [] });
  await r;
  assert.deepEqual(s2.calls, ["pass:events", "pass:events", "deposit:events"]);
});

// review of evm-first-proof-inside-ten-seconds, items 4, 5 and 7: the deposit kind asks its round with no signal (a note's
// try and its verdict, src/pool-deposit-evm.ts), so the wait ends at the page's reads' stop as it was at the call; a sign
// out (or the round's own signal) tapped during the wait ends the round at once, its reason thrown, and no read is asked
// after it; the wait leaves no listener on the signal, and a round after the read holds waits on nothing.
test("a sign out during the wait ends the round at once: thrown, no read after the tap, none asked again", async () => {
  const { w } = await wallet();
  const s = twoSyncs(w, () => new Promise(() => {}));
  s.t.evmPoolOf("base");
  await until(() => s.calls.includes("pass:events"));
  const r = s.round();
  await new Promise((x) => setTimeout(x, 30));
  (s.t as unknown as { signingOut: () => void }).signingOut();
  const got = await Promise.race([r.then(() => "read", () => "thrown"), new Promise((x) => setTimeout(() => x("still waiting"), 500))]);
  assert.equal(got, "thrown", "the round ends at the sign out, not at the 20 s bound");
  await new Promise((x) => setTimeout(x, 50));
  assert.deepEqual(s.calls, ["pass:events"], "no read after the tap, the history read not asked again");
});

test("the round's own signal ends the wait the same way; the wait leaves no listener, and once the read holds a round waits on nothing", async () => {
  const { w } = await wallet();
  const s = twoSyncs(w, () => new Promise(() => {}));
  s.t.evmPoolOf("base");
  await until(() => s.calls.includes("pass:events"));
  const c = new AbortController();
  const p = s.round(c.signal);
  await new Promise((x) => setTimeout(x, 30));
  c.abort(new Error("stopped"));
  await assert.rejects(p, /stopped/);
  assert.deepEqual(s.calls, ["pass:events"], "no read after the round's signal");

  const { w: w2 } = await wallet();
  let done: (v: unknown) => void = () => {};
  const s2 = twoSyncs(w2, () => new Promise((x) => (done = x)));
  s2.t.evmPoolOf("base");
  await until(() => s2.calls.includes("pass:events"));
  const c2 = new AbortController();
  let live = 0, added = 0;
  const add = c2.signal.addEventListener.bind(c2.signal), rem = c2.signal.removeEventListener.bind(c2.signal);
  c2.signal.addEventListener = ((t: string, f: never, o?: never) => (t === "abort" && (live++, added++), add(t, f, o))) as never;
  c2.signal.removeEventListener = ((t: string, f: never, o?: never) => (t === "abort" && live--, rem(t, f, o))) as never;
  const p2 = s2.round(c2.signal);
  await until(() => added > 0);
  done({ fin: {}, anchor: {}, events: [] });
  await p2;
  assert.equal(live, 0, "the wait's abort listener removed");
  await s2.round(c2.signal);
  assert.equal(live, 0, "a round after the read holds leaves no listener either");
  assert.deepEqual(s2.calls, ["pass:events", "deposit:events", "deposit:events"], "and waits on nothing");
});

// review of 584af1495, P2-1: once a round has read on the deposit's own sync (the wait's bound passed, the history read
// still running), every later round of the session reads at once: that sync's hold has the pool, so none waits the 20 s
// again, the round that sees the landing included. A sign out clears it with the rest of the session.
test("a round that read on its own sync past the bound: the next round reads at once, the history read still running", async () => {
  const { w } = await wallet();
  const s = twoSyncs(w, () => new Promise(() => {}), { waitMs: 400 });
  s.t.evmPoolOf("base");
  await until(() => s.calls.includes("pass:events"));
  await s.round();
  // the second round against a timer short of the 400 ms bound: a round that waits the bound again loses the race
  const second = await Promise.race([s.round().then(() => "read"), new Promise((r) => setTimeout(() => r("waited"), 300))]);
  assert.equal(second, "read", "the second round waited the bound again though its own sync already read");
  assert.deepEqual(s.calls, ["pass:events", "deposit:events", "deposit:events"]);
});

// review of 584af1495, P3-1: a round given its own signal (the end follow's, which fires only at signedOut) ends at a
// sign out tapped during its wait too: thrown, no read after the tap.
test("a round with a signal the tap leaves alone still ends at the sign out tap: no read after it", async () => {
  const { w } = await wallet();
  const s = twoSyncs(w, () => new Promise(() => {}), { waitMs: 300 });
  s.t.evmPoolOf("base");
  await until(() => s.calls.includes("pass:events"));
  const follows = new AbortController(); // the page's follows signal: aborted only at signedOut
  const r = s.round(follows.signal).then(() => "read", () => "thrown");
  await new Promise((x) => setTimeout(x, 30));
  (s.t as unknown as { signingOut: () => void }).signingOut();
  const got = await Promise.race([r, new Promise((x) => setTimeout(() => x("still waiting"), 1_000))]);
  assert.equal(got, "thrown", "the round ends at the tap");
  await new Promise((x) => setTimeout(x, 50));
  assert.deepEqual(s.calls, ["pass:events"], "no read after the tap");
});

// delta review of 679ec10f7, P2: a sign out tapped while the history read runs, then refused (the backup not done:
// signingOut, never signedOut, so the maps stay), leaves no history read that ended for good: the next ask reads it
// again for the session still signed in, and the deposit's round waits for that one
test("a sign out refused after its tap stopped the history read: the next ask reads the history again and the round waits for it", async () => {
  const { w } = await wallet();
  const calls: string[] = [];
  const hosts: (() => Round)[] = [];
  let made = 0;
  let passes = 0;
  const t = testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED64.slice() }, {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c: string) => (c === "base" ? PIN : undefined),
    evmSync: () => {
      const name = made++ === 0 ? "deposit" : "pass";
      return {
        events: async (signal?: AbortSignal) => {
          calls.push(`${name}:events`);
          if (name === "deposit") return { fin: { number: 1n }, anchor: {}, events: [] };
          // the first history read ends only at its stop; the one asked again answers after 150 ms
          if (passes++ === 0) return new Promise((_, rej) => signal?.addEventListener("abort", () => rej(signal.reason), { once: true }));
          return new Promise((r) => setTimeout(() => r({ fin: {}, anchor: {}, events: [] }), 150));
        },
      };
    },
    evmWarmWaitMs: 2_000,
    depositKinds: { solana: () => () => ({ error: "not_allowed" }), evm: (host: () => Round) => () => (hosts.push(host), { error: "not_allowed" }) },
  } as never);
  t.flow(ASK as never, CTX);
  t.evmPoolOf("base");
  await until(() => calls.includes("pass:events"));
  (t as unknown as { signingOut: () => void }).signingOut();
  await new Promise((x) => setTimeout(x, 30));
  t.evmPoolOf("base");
  await hosts[0]!().round!();
  assert.deepEqual(calls, ["pass:events", "pass:events", "deposit:events"], "the history read asked again, the round after it");
});

// review of evm-first-proof-inside-ten-seconds, item 1: every wallet pool the page makes of an EVM pin (the queue's pass
// pool, the landing pass's pool on the deposit's pair, a withdraw's) binds on the chain's one period fee hold, so a pass
// in a held period reads no period fee again (the wallet's pool-evm.test.ts: two pools of one pin on one hold read it once)
test("every wallet pool the page makes binds on the chain's one fee hold", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/pool-testnet.ts", import.meta.url), "utf8");
  const made = src.split("walletEvmPool({").slice(1);
  assert.equal(made.length, 4, "the pass pool, the landing's pool, a withdraw's and a deposit in sight's (card evm-landing-reads-batched)");
  for (const [i, body] of made.entries()) assert.match(body.slice(0, 600), /\n\s+feeHold: evmFeeHoldOf\(e\.pin\),\n/, `pool ${i + 1} on the fee hold`);
});
