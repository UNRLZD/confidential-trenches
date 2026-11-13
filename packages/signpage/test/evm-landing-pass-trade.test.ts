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
