// U's deposit from the signed call to the note's leaf (card wallet-deposit-bind; wallet.md §2.4 W:446-480 and W2.3
// W:1101, vault.md 2.10 (c)-(d) V:674-692, POST /v1/bind M:3341, at research 6e55c52).
//   node --test test/deposit-bind.test.ts   (from packages/wallet)
// A mock chain behind two RPCs of the testnet pair: U's reads are test/vectors/deposit-account.json's real answers
// (replay-deposit-reads.ts) and the vault's pages test/vectors/deposit-bind-pages.json's real (empty) testnet pages,
// each with its height, U's nonce and balance and the page's rows set by the test; each RPC side has its own height and
// rows, so one can lag. A mock POST /v1/bind answers from a script and decodes every body with the helper's own decoder
// (apps/helper/src/bind/checks.ts), so each nonce asserted is the one inside the signed bytes. The note store is the
// real one on fake-indexeddb. Test secrets come from the first published BIP-39 vector (all-zero entropy).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { HELPER_CODE_STATUS } from "@blindfill/kit";
import { base58 } from "@scure/base";
import { IDBFactory } from "fake-indexeddb";
import { decodeSignedDelegate } from "../../../apps/helper/src/bind/checks.ts";
import { depositAccount, NEAR_NETWORKS, type NearRpc } from "../src/deposit/account.ts";
import {
  type BindDepositArgs,
  type BindOutcome,
  bindDeposit,
  checkCleanup,
  DepositBindRefused,
  DepositsWatch,
  LAPSE_MARGIN,
  resetBindSession,
  resignDeposit,
} from "../src/deposit/bind.ts";
import { RELEASE_BIND_URL } from "../src/deposit/delegate.ts";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, type NoteRecord, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";
import { replayDepositReads } from "./replay-deposit-reads.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const PAGES = JSON.parse(readFileSync(new URL("./vectors/deposit-bind-pages.json", import.meta.url), "utf8"));
const NET = NEAR_NETWORKS.testnet;
const VAULT = NET.vault;
assert.equal(PAGES.vault, VAULT);
const AMOUNT = 25_000_000n;
const pc = (ref: NoteRef): bigint => noteSecrets(SEED, ref).precommitment;

// ---------- the mock chain ----------
type Row = { index: number; precommitment: string; label: string; value: string; leaf_index: number; depositor: string };
type Side = { height: bigint; nonce: bigint; rows: Row[] };
class Chain {
  a: Side;
  b: Side;
  balance = 100_000_000n;
  readsOfKeys = 0;
  /** Runs on each sleep: the test's clock. Default: one block on each side. */
  tick: () => void = () => this.blocks(1n);
  readonly u: string;
  constructor(u: string, height = 275753808n, nonce = 275753000000001n) {
    this.u = u;
    this.a = { height, nonce, rows: [] };
    this.b = { height: height + 1n, nonce, rows: [] };
  }
  blocks(n: bigint, side?: "a" | "b") {
    if (side !== "b") this.a.height += n;
    if (side !== "a") this.b.height += n;
  }
  low = () => (this.a.height < this.b.height ? this.a.height : this.b.height);
  /** A row of the vault's DepositView shape, on one side or both. */
  addRow(p: bigint, { depositor = this.u, value = AMOUNT, side }: { depositor?: string; value?: bigint; side?: "a" | "b" } = {}) {
    for (const s of side === undefined ? [this.a, this.b] : [this[side]]) {
      const index = s.rows.length;
      s.rows.push({ index, precommitment: p.toString(), label: (1000n + BigInt(index)).toString(), value: value.toString(), leaf_index: 2 * index, depositor });
    }
  }
  rpcs(): [NearRpc, NearRpc] {
    const replay = replayDepositReads("testnet", publicKeyOf(this.u));
    const side = (k: "a" | "b", r: NearRpc): NearRpc => ({
      name: r.name,
      query: async (params) => {
        const s = this[k];
        if (params.method_name === "deposits") {
          const { from, limit } = JSON.parse(Buffer.from(params.args_base64 as string, "base64").toString());
          const j = structuredClone(PAGES.answers[k].json);
          j.result.block_height = Number(s.height);
          j.result.result = [...Buffer.from(JSON.stringify(s.rows.slice(from, from + limit)))];
          return j;
        }
        const j = (await r.query(params)) as any;
        j.result.block_height = Number(s.height);
        if (params.request_type === "view_access_key_list") {
          this.readsOfKeys++;
          j.result.keys[0].public_key = publicKeyOf(this.u);
          j.result.keys[0].access_key.nonce = Number(s.nonce);
        }
        if (params.method_name === "ft_balance_of") j.result.result = [...Buffer.from(JSON.stringify(this.balance.toString()))];
        return j;
      },
    });
    return [side("a", replay[0]), side("b", replay[1])];
  }
}
const turn = () => new Promise<void>((ok) => setImmediate(ok));
const publicKeyOf = (u: string) => `ed25519:${base58.encode(Uint8Array.from(u.match(/../g)!, (h) => parseInt(h, 16)))}`;

// ---------- the mock relayer ----------
type Sent = { nonce: bigint; mbh: bigint; p: bigint; bytes: string; low: bigint };
type Reply = "tx" | "lost" | string; // "tx": 200 {tx_hash}; "lost": no answer; else an error code
function relayer(chain: Chain, script: Reply[], onTx: (s: Sent) => void = () => {}) {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    assert.equal(url, RELEASE_BIND_URL);
    const body = JSON.parse(init.body as string);
    assert.deepEqual(Object.keys(body), ["signed_delegate"]); // nothing else leaves: no key, no words, no other id
    const dl = decodeSignedDelegate(new Uint8Array(Buffer.from(body.signed_delegate, "base64")));
    const a = dl.actions[0]!;
    assert.equal(a.kind, "FunctionCall");
    const msg = JSON.parse(JSON.parse(Buffer.from((a as { args: Uint8Array }).args).toString()).msg);
    const s: Sent = { nonce: dl.nonce, mbh: dl.max_block_height, p: BigInt(msg.precommitment), bytes: body.signed_delegate, low: chain.low() };
    sent.push(s);
    chain.blocks(1n); // the hop to the relayer and back takes a block
    const reply = script.shift() ?? "tx";
    if (reply === "lost") throw new TypeError("fetch failed");
    if (reply === "tx") {
      onTx(s);
      return Response.json({ tx_hash: base58.encode(new Uint8Array(32).fill(sent.length)) });
    }
    const status = (HELPER_CODE_STATUS as Record<string, number>)[reply] ?? 400;
    return Response.json({ error: { code: reply } }, { status });
  }) as typeof fetch;
  return { sent, fetchFn };
}
// the call lands: U's nonce takes the call's, its USDC goes, and the vault's row is on both sides
const lands = (chain: Chain) => (s: Sent) => {
  chain.a.nonce = chain.b.nonce = s.nonce;
  chain.balance -= AMOUNT;
  chain.addRow(s.p);
};

// ---------- the note store ----------
const opened: WalletStore[] = [];
const stores: NoteStore[] = [];
after(() => (opened.forEach((s) => s.close()), stores.forEach((n) => n.close())));
async function noteStore(): Promise<NoteStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  opened.push(w);
  const ns = await openNoteStore(w);
  stores.push(ns);
  return ns;
}
beforeEach(() => resetBindSession());

// U = U_{1,i}: scope 1's deposit index i, the store's next
async function setup(script: Reply[] = [], onTx?: (c: Chain) => (s: Sent) => void) {
  const store = await noteStore();
  const note = await store.planDeposit(1n, pc);
  assert.equal(note.ref.kind, "deposit");
  const i = (note.ref as { i: number }).i;
  const u = depositAccount(SEED, 1n, i).account;
  const chain = new Chain(u);
  const r = relayer(chain, script, (onTx ?? lands)(chain));
  const args: BindDepositArgs = { network: "testnet", s: 1n, i, noteId: note.id, amount: AMOUNT };
  let sleeps = 0;
  const deps = { store, rpcs: chain.rpcs(), fetchFn: r.fetchFn, sleep: async () => (sleeps++, chain.tick(), await turn()), signal: AbortSignal.timeout(20_000) };
  return { store, note, i, u, chain, sent: r.sent, args, deps, sleeps: () => sleeps };
}
const landed = (o: BindOutcome, kind: "deposited" | "front_run" = "deposited"): NoteRecord => {
  assert.equal(o.kind, kind, JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  return (o as { note: NoteRecord }).note;
};

test("tx_hash: one call at U's nonce + 1, confirmed from the pages on both RPCs, the note UNSPENT with the vault's leaf", async () => {
  const t = await setup(["tx"]);
  const n0 = t.chain.a.nonce;
  const note = landed(await bindDeposit(SEED, t.args, t.deps));
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0]!.nonce, n0 + 1n);
  assert.equal(t.sent[0]!.p, t.note.precommitment);
  assert.equal(note.state, "UNSPENT");
  assert.deepEqual(note.leaf, { value: AMOUNT, label: 1000n, commitment: noteCommitment(AMOUNT, 1000n, t.note.precommitment), leafIndex: 0n });
});

test("planted: a page read from one RPC only does not confirm; the note stays INCOMING until both hold the row", async () => {
  let landedAt = -1;
  const t = await setup(["tx"], (c) => (s) => {
    c.a.nonce = c.b.nonce = s.nonce;
    c.balance -= AMOUNT;
    c.addRow(s.p, { side: "a" }); // only RPC a holds it
  });
  let polls = 0;
  t.chain.tick = () => {
    t.chain.blocks(1n);
    if (++polls === 6) (t.chain.addRow(t.note.precommitment, { side: "b" }), (landedAt = polls));
  };
  // the watch itself: one side holding P is unsure, never held
  const w = new DepositsWatch(VAULT, t.note.precommitment, t.deps.rpcs);
  t.chain.addRow(t.note.precommitment, { side: "a" });
  assert.deepEqual(await w.read(), { state: "unsure" });
  t.chain.a.rows = [];
  const watched: string[] = [];
  const store = t.deps.store;
  const spy = { ...t.deps, sleep: async () => (watched.push((await store.get(t.note.id))!.state), t.chain.tick(), await turn()) };
  landed(await bindDeposit(SEED, t.args, spy));
  assert.equal(landedAt, 6);
  assert.ok(watched.length >= 5 && watched.every((s) => s === "INCOMING"), watched.join(","));
  assert.equal(t.sent.length, 1);
});

test("prepay_open (R2): waits until both RPCs hold U's previous P, then sends the same signed bytes at the same nonce", async () => {
  const store = await noteStore();
  const first = await store.planDeposit(1n, pc);
  const i = (first.ref as { i: number }).i;
  const u = depositAccount(SEED, 1n, i).account;
  const chain = new Chain(u);
  // the first note landed in the store; the chain's pages hold it only on RPC a for now
  await store.move(first.id, "PLANNED", "INCOMING");
  await store.move(first.id, "INCOMING", "UNSPENT", { leaf: { value: AMOUNT, label: 1000n, commitment: noteCommitment(AMOUNT, 1000n, first.precommitment), leafIndex: 0n } });
  chain.addRow(first.precommitment, { side: "a" });
  const ref: NoteRef = { kind: "second", id: { id: "U", s: 1n, i }, n: 0 };
  const second = await store.add({ ref, scope: 1n, precommitment: pc(ref), state: "PLANNED" });
  const r = relayer(chain, ["prepay_open", "tx"], lands(chain));
  let polls = 0;
  let heldAt = -1;
  chain.tick = () => {
    chain.blocks(1n);
    if (++polls === 4) (chain.addRow(first.precommitment, { side: "b" }), (heldAt = polls));
  };
  const deps = { store, rpcs: chain.rpcs(), fetchFn: r.fetchFn, sleep: async () => (chain.tick(), await turn()), signal: AbortSignal.timeout(20_000) };
  const note = landed(await bindDeposit(SEED, { network: "testnet", s: 1n, i, noteId: second.id, amount: AMOUNT }, deps));
  assert.equal(heldAt, 4);
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1]!.bytes, r.sent[0]!.bytes); // the same signed call, so the same nonce
  assert.equal(r.sent[1]!.nonce, r.sent[0]!.nonce);
  assert.equal(r.sent[0]!.p, second.precommitment);
  assert.equal(note.leaf!.leafIndex, 2n); // the second row
});

test("prepay_open on U's first note: no earlier P of U exists, so the device stops and sends nothing more", async () => {
  const t = await setup(["prepay_open"]);
  assert.deepEqual(await bindDeposit(SEED, t.args, t.deps), { kind: "refused", code: "prepay_open" });
  assert.equal(t.sent.length, 1);
});

test("resign_needed (R4): signs again at the same nonce with a new window; the second call lands", async () => {
  const t = await setup(["resign_needed", "tx"]);
  t.chain.tick = () => t.chain.blocks(3n);
  const n0 = t.chain.a.nonce;
  const note = landed(await bindDeposit(SEED, t.args, t.deps));
  assert.equal(t.sent.length, 2);
  for (const s of t.sent) assert.equal(s.nonce, n0 + 1n);
  assert.notEqual(t.sent[1]!.bytes, t.sent[0]!.bytes);
  assert.equal(t.sent[1]!.p, t.sent[0]!.p);
  assert.equal(note.state, "UNSPENT");
});

test("sender_struck (R3): stops at once, tells the caller to open the way out, and signs nothing more for U", async () => {
  const t = await setup(["sender_struck"]);
  assert.deepEqual(await bindDeposit(SEED, t.args, t.deps), { kind: "struck", account: t.u });
  assert.equal(t.sent.length, 1);
  const reads = t.chain.readsOfKeys;
  await assert.rejects(bindDeposit(SEED, t.args, t.deps), (e: unknown) => e instanceof DepositBindRefused && e.code === "struck");
  assert.equal(t.sent.length, 1);
  assert.equal(t.chain.readsOfKeys, reads); // not even read again
  assert.equal((await t.store.get(t.note.id))!.state, "INCOMING"); // the money is in U, not in the vault
});

for (const reply of ["tx", "lost"] as const) {
  test(`nothing landed (${reply === "tx" ? "a tx_hash" : "no answer"}): signs again only past max_block_height + 5 on both RPCs, at the same nonce`, async () => {
    // the first call is never carried; the second lands
    let calls = 0;
    const t = await setup([reply, "tx"], (c) => (s) => {
      if (++calls > (reply === "tx" ? 1 : 0)) lands(c)(s);
    });
    t.chain.tick = () => {
      t.chain.blocks(6n, "a");
      t.chain.b.height = t.chain.a.height - 4n; // RPC b lags RPC a
    };
    const n0 = t.chain.a.nonce;
    landed(await bindDeposit(SEED, t.args, t.deps));
    assert.equal(t.sent.length, 2);
    assert.equal(t.sent[0]!.nonce, n0 + 1n);
    assert.equal(t.sent[1]!.nonce, n0 + 1n);
    assert.ok(t.sent[1]!.low > t.sent[0]!.mbh + LAPSE_MARGIN, `re-signed at ${t.sent[1]!.low}, window ${t.sent[0]!.mbh}`);
    assert.ok(t.sent[1]!.mbh > t.sent[0]!.mbh);
  });
}

test("refused: U's nonce moved past the call, P not held and the USDC back in U: a new call on the same P, past the dead nonce", async () => {
  let calls = 0;
  const t = await setup(["tx", "tx"], (c) => (s) => {
    c.a.nonce = c.b.nonce = s.nonce; // the call ran
    if (++calls === 2) (c.balance -= AMOUNT, c.addRow(s.p)); // the first was refused by the vault (the token refunds U)
  });
  t.chain.tick = () => t.chain.blocks(10n);
  const n0 = t.chain.a.nonce;
  landed(await bindDeposit(SEED, t.args, t.deps));
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[0]!.nonce, n0 + 1n);
  assert.equal(t.sent[1]!.nonce, n0 + 2n);
  assert.equal(t.sent[1]!.p, t.sent[0]!.p);
  assert.ok(t.sent[1]!.low > t.sent[0]!.mbh + LAPSE_MARGIN);
});

test("refused with the USDC not back in U yet: the device keeps reading and signs nothing until it is", async () => {
  let calls = 0;
  const t = await setup(["tx", "tx"], (c) => (s) => {
    c.a.nonce = c.b.nonce = s.nonce;
    if (++calls === 1) c.balance = 0n; // the USDC is on its way back
    else (c.balance -= AMOUNT, c.addRow(s.p));
  });
  let polls = 0;
  let backAt = -1;
  t.chain.tick = () => {
    t.chain.blocks(10n);
    if (++polls === 30) ((t.chain.balance = 100_000_000n), (backAt = Number(t.chain.low())));
  };
  landed(await bindDeposit(SEED, t.args, t.deps));
  assert.equal(t.sent.length, 2);
  assert.ok(t.sent[1]!.low >= backAt, `sent at ${t.sent[1]!.low}, the USDC back at ${backAt}`);
});

test("planted: a lapse re-sign before max_block_height + 5 on both RPCs' final heights is refused, and signs nothing", async () => {
  const t = await setup();
  const earlier = { sender_id: t.u, nonce: t.chain.a.nonce + 1n, max_block_height: t.chain.low() - 2n };
  const args = { network: "testnet" as const, amount: AMOUNT, precommitment: t.note.precommitment };
  // one RPC at max_block_height + 5 exactly, the other past it
  t.chain.a.height = earlier.max_block_height + LAPSE_MARGIN;
  t.chain.b.height = earlier.max_block_height + LAPSE_MARGIN + 3n;
  const before = t.chain.readsOfKeys;
  await assert.rejects(resignDeposit(SEED, 1n, t.i, args, earlier, "lapse", t.deps.rpcs), (e: unknown) => e instanceof DepositBindRefused && e.code === "early");
  assert.equal(t.chain.readsOfKeys - before, 2); // the gate's own read on both, and no signer's read
  t.chain.a.height = earlier.max_block_height + LAPSE_MARGIN + 1n;
  const call = await resignDeposit(SEED, 1n, t.i, args, earlier, "lapse", t.deps.rpcs);
  assert.equal(call.nonce, earlier.nonce);
});

test("planted: a re-sign at a new nonce is impossible: a moved nonce is refused, and so is one that moves between the gate and the signer", async () => {
  const t = await setup();
  const earlier = { sender_id: t.u, nonce: t.chain.a.nonce + 1n, max_block_height: t.chain.low() - 10n };
  const args = { network: "testnet" as const, amount: AMOUNT, precommitment: t.note.precommitment };
  const refusedNonce = (e: unknown) => e instanceof DepositBindRefused && e.code === "nonce";
  // U's nonce already past the earlier call: not a lapse
  t.chain.a.nonce = t.chain.b.nonce = earlier.nonce;
  await assert.rejects(resignDeposit(SEED, 1n, t.i, args, earlier, "lapse", t.deps.rpcs), refusedNonce);
  // R4 with U's nonce moved: the signer would sign at nonce + 2, and that call is dropped
  await assert.rejects(resignDeposit(SEED, 1n, t.i, args, earlier, "resign_needed", t.deps.rpcs), refusedNonce);
  // the gate reads the old nonce, the signer's read sees it moved
  t.chain.a.nonce = t.chain.b.nonce = earlier.nonce - 1n;
  const at = t.chain.readsOfKeys;
  const rpcs = t.deps.rpcs.map((r) => ({
    name: r.name,
    query: async (p: Record<string, unknown>) => {
      if (p.request_type === "view_access_key_list" && t.chain.readsOfKeys - at >= 2) t.chain.a.nonce = t.chain.b.nonce = earlier.nonce;
      return r.query(p);
    },
  })) as unknown as [NearRpc, NearRpc];
  await assert.rejects(resignDeposit(SEED, 1n, t.i, args, earlier, "lapse", rpcs), refusedNonce);
});

test("planted: storage_unregister on U is always refused; DeleteAccount is refused while a call U signed can land", async () => {
  const cleanup = (e: unknown) => e instanceof DepositBindRefused && e.code === "cleanup";
  // the call lands on RPC a at once and on RPC b at the next block, so the bind waits one poll
  const t = await setup(["tx"], (c) => (s) => {
    c.a.nonce = c.b.nonce = s.nonce;
    c.balance -= AMOUNT;
    c.addRow(s.p, { side: "a" });
  });
  await assert.rejects(checkCleanup("storage_unregister", t.u, t.deps.rpcs), cleanup);
  await checkCleanup("DeleteAccount", t.u, t.deps.rpcs); // no call signed yet: not this gate's to refuse
  let during: unknown = null;
  const deps = {
    ...t.deps,
    sleep: async () => {
      during ??= await checkCleanup("DeleteAccount", t.u, t.deps.rpcs).then(() => "allowed", (e: unknown) => e);
      t.chain.blocks(1n);
      if (t.chain.b.rows.length === 0) t.chain.addRow(t.note.precommitment, { side: "b" });
    },
  };
  landed(await bindDeposit(SEED, t.args, deps));
  assert.ok(cleanup(during), String(during)); // while the bind runs
  // after it: refused until both final heights are past the call's max_block_height + 5
  const mbh = t.sent[0]!.mbh;
  t.chain.a.height = mbh + LAPSE_MARGIN + 1n;
  t.chain.b.height = mbh + LAPSE_MARGIN;
  await assert.rejects(checkCleanup("DeleteAccount", t.u, t.deps.rpcs), cleanup);
  t.chain.b.height = mbh + LAPSE_MARGIN + 1n;
  await checkCleanup("DeleteAccount", t.u, t.deps.rpcs);
  await assert.rejects(checkCleanup("storage_unregister", t.u, t.deps.rpcs), cleanup);
  await assert.rejects(checkCleanup("Transfer", t.u, t.deps.rpcs), cleanup);
});

test("already in the pages (a reload): the note lands and nothing is signed or sent", async () => {
  const t = await setup();
  t.chain.addRow(t.note.precommitment);
  const reads = t.chain.readsOfKeys;
  landed(await bindDeposit(SEED, t.args, t.deps));
  assert.equal(t.sent.length, 0);
  assert.equal(t.chain.readsOfKeys, reads);
});

test("a front-run on P: the note lands with that leaf as front_run, and nothing is sent", async () => {
  const t = await setup();
  t.chain.addRow(t.note.precommitment, { value: 1_000_000n, depositor: "f".repeat(64) });
  const note = landed(await bindDeposit(SEED, t.args, t.deps), "front_run");
  assert.equal(note.leaf!.value, 1_000_000n);
  assert.equal(t.sent.length, 0);
});

test("a check code from the relayer stops the bind with that code; nothing more is sent", async () => {
  const t = await setup(["gas_too_low"]);
  assert.deepEqual(await bindDeposit(SEED, t.args, t.deps), { kind: "refused", code: "gas_too_low" });
  assert.equal(t.sent.length, 1);
});

test("the note must be in the store, U's, and its P its ref's: else refused before anything is read or sent", async () => {
  const t = await setup();
  const reads = t.chain.readsOfKeys;
  const refusedNote = (e: unknown) => e instanceof DepositBindRefused && e.code === "note";
  await assert.rejects(bindDeposit(SEED, { ...t.args, noteId: "f".repeat(32) }, t.deps), refusedNote);
  await assert.rejects(bindDeposit(SEED, { ...t.args, i: t.i + 1 }, t.deps), refusedNote); // the note is U_{1,i}'s, not U_{1,i+1}'s
  assert.equal(t.sent.length, 0);
  assert.equal(t.chain.readsOfKeys, reads);
});
