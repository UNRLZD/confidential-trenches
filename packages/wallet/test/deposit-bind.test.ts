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
  type BindRpc,
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
const RELAYER = "bind.blindfill-test.testnet"; // the relayer account the tx reads name (deps.relayerAccount)
const pc = (ref: NoteRef): bigint => noteSecrets(SEED, ref).precommitment;

// ---------- the mock chain ----------
type Row = { index: number; precommitment: string; label: string; value: string; leaf_index: number; depositor: string };
type Side = { height: bigint; nonce: bigint; rows: Row[] };
class Chain {
  a: Side;
  b: Side;
  balance = 100_000_000n;
  readsOfKeys = 0;
  /** Every tx the relayer sent, by hash, and those every receipt of which is final. */
  txs = new Map<string, Sent>();
  finals = new Set<string>();
  txReads = 0;
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
  rpcs(): [BindRpc, BindRpc] {
    const replay = replayDepositReads("testnet", publicKeyOf(this.u));
    const side = (k: "a" | "b", r: NearRpc): BindRpc => ({
      name: r.name,
      // the NEAR `tx` read with wait_until FINAL: the tx and its receipts once final, else the node's timeout error
      tx: async ({ tx_hash, sender_account_id }) => {
        this.txReads++;
        const t = this.txs.get(tx_hash);
        if (!t || !this.finals.has(tx_hash) || sender_account_id !== RELAYER) return { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } };
        return {
          jsonrpc: "2.0",
          id: "x",
          result: {
            final_execution_status: "FINAL",
            status: { SuccessValue: "" },
            transaction: {
              hash: tx_hash,
              signer_id: RELAYER,
              receiver_id: t.sender,
              actions: [{ Delegate: { delegate_action: { sender_id: t.sender, receiver_id: t.receiver, actions: [], nonce: Number(t.nonce), max_block_height: Number(t.mbh), public_key: t.pk }, signature: t.sig } }],
            },
            receipts_outcome: [{ outcome: { status: { SuccessReceiptId: "r1" } } }, { outcome: { status: { Failure: {} } } }],
          },
        };
      },
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
type Sent = { nonce: bigint; mbh: bigint; p: bigint; bytes: string; low: bigint; hash: string; sender: string; receiver: string; pk: string; sig: string };
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
    const s: Sent = {
      nonce: dl.nonce, mbh: dl.max_block_height, p: BigInt(msg.precommitment), bytes: body.signed_delegate, low: chain.low(),
      hash: base58.encode(new Uint8Array(32).fill(sent.length + 1)), sender: dl.sender_id, receiver: dl.receiver_id,
      pk: `ed25519:${base58.encode(dl.public_key)}`, sig: `ed25519:${base58.encode(dl.signature)}`,
    };
    sent.push(s);
    chain.blocks(1n); // the hop to the relayer and back takes a block
    const reply = script.shift() ?? "tx";
    if (reply === "lost") throw new TypeError("fetch failed");
    if (reply === "tx") {
      chain.txs.set(s.hash, s);
      onTx(s);
      return Response.json({ tx_hash: s.hash });
    }
    if (reply.startsWith("hash:")) return Response.json({ tx_hash: reply.slice(5) }); // whatever hash the relayer says
    const status = (HELPER_CODE_STATUS as Record<string, number>)[reply] ?? 400;
    return Response.json({ error: { code: reply } }, { status });
  }) as typeof fetch;
  return { sent, fetchFn };
}
// the call lands: U's nonce takes the call's, its USDC goes, and the vault's row is on both sides
const lands = (chain: Chain) => (s: Sent) => {
  chain.finals.add(s.hash);
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
  const deps = { store, rpcs: chain.rpcs(), fetchFn: r.fetchFn, sleep: async () => (sleeps++, chain.tick(), await turn()), signal: AbortSignal.timeout(20_000), relayerAccount: RELAYER };
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
  const deps = { store, rpcs: chain.rpcs(), fetchFn: r.fetchFn, sleep: async () => (chain.tick(), await turn()), signal: AbortSignal.timeout(20_000), relayerAccount: RELAYER };
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
    c.finals.add(s.hash); // every receipt of it final: the vault refused it and the token refunded U
    if (++calls === 2) (c.balance -= AMOUNT, c.addRow(s.p));
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
    c.finals.add(s.hash);
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
  await assert.rejects(checkCleanup("DeleteAccount", t.u, t.deps.rpcs), cleanup); // no record of U's calls: refused
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

// ---------- the review of 971d252 (REVIEW A-K, A2), taken in as written but for the mock's tx reads ----------

// A. The refused branch: U's nonce moved (the Delegate ran late in its window), the amount left U, the vault's
// ft_on_transfer is delayed past max_block_height + 5 (congestion). U still holds >= amount (the notes still to come).
test("REVIEW A (expect FAIL on 971d252): no second call on P while the first call's USDC is in flight to the vault", async () => {
  let pending: Sent | null = null;
  let ran = false;
  let rowAt = -1n;
  const t = await setup(["tx", "tx"], () => (s) => {
    pending ??= s; // the relayer carries the first call; a second on the same P would be refused at row 3
  });
  t.chain.tick = () => {
    t.chain.blocks(1n);
    const h = t.chain.low();
    if (pending && !ran && h >= pending.mbh - 1n) {
      ran = true; // the Delegate receipt runs at max_block_height - 1: U's nonce moves and ft_transfer_call debits U
      t.chain.a.nonce = t.chain.b.nonce = pending.nonce;
      t.chain.balance -= AMOUNT; // 100M -> 75M, still >= the 25M amount
    }
    if (pending && ran && rowAt < 0n && h >= pending.mbh + 9n) {
      rowAt = h; // the vault's ft_on_transfer lands, 10 blocks after the Delegate
      t.chain.addRow(pending.p);
    }
  };
  landed(await bindDeposit(SEED, t.args, t.deps));
  assert.equal(
    t.sent.length,
    1,
    `a second call on the same P was sent at final height ${t.sent[1]?.low} (nonce ${t.sent[1]?.nonce}, first ${t.sent[0]?.nonce}) before the first call's row landed at ${rowAt}`,
  );
});

// B. A relayer answering resign_needed every time (a K above the window, or a hostile relayer): the device re-signs and
// re-sends with no pause between.
test("REVIEW B (expect FAIL on 971d252): resign_needed again and again: a pause between re-signs", async () => {
  const t = await setup([...Array(20).fill("resign_needed"), "tx"]);
  const at: number[] = [];
  const f = t.deps.fetchFn;
  const deps = { ...t.deps, fetchFn: (async (u: string, i: RequestInit) => (at.push(t.sleeps()), f(u, i))) as unknown as typeof fetch };
  landed(await bindDeposit(SEED, t.args, deps));
  assert.equal(t.sent.length, 21);
  assert.ok(new Set(t.sent.map((s) => s.nonce)).size === 1, "every re-sign at the same nonce");
  assert.ok(at[20]! >= 20, `21 calls signed and sent after ${at[20]} pauses`);
});

// C. prepay_open answered while the previous P is already held: the same bytes go again with no pause.
test("REVIEW C (expect FAIL on 971d252): prepay_open with the previous P held: a pause between sends", async () => {
  const store = await noteStore();
  const first = await store.planDeposit(1n, pc);
  const i = (first.ref as { i: number }).i;
  const u = depositAccount(SEED, 1n, i).account;
  const chain = new Chain(u);
  await store.move(first.id, "PLANNED", "INCOMING");
  await store.move(first.id, "INCOMING", "UNSPENT", { leaf: { value: AMOUNT, label: 1000n, commitment: noteCommitment(AMOUNT, 1000n, first.precommitment), leafIndex: 0n } });
  chain.addRow(first.precommitment);
  const ref: NoteRef = { kind: "second", id: { id: "U", s: 1n, i }, n: 0 };
  const second = await store.add({ ref, scope: 1n, precommitment: pc(ref), state: "PLANNED" });
  const r = relayer(chain, [...Array(20).fill("prepay_open"), "tx"], lands(chain));
  let sleeps = 0;
  const at: number[] = [];
  const fetchFn = (async (u: string, init: RequestInit) => (at.push(sleeps), r.fetchFn(u, init))) as unknown as typeof fetch;
  const deps = { store, rpcs: chain.rpcs(), fetchFn, sleep: async () => (sleeps++, chain.tick(), await turn()), signal: AbortSignal.timeout(20_000) };
  landed(await bindDeposit(SEED, { network: "testnet", s: 1n, i, noteId: second.id, amount: AMOUNT }, deps));
  assert.equal(r.sent.length, 21);
  assert.ok(at[20]! >= 20, `21 sends after ${at[20]} pauses`);
});

// D. After a reload (the in-memory record gone), checkCleanup allows DeleteAccount with no read at all while a call U
// signed is inside its window.
test("REVIEW D (expect FAIL on 971d252): after a reload, DeleteAccount is not allowed blind while U's call can land", async () => {
  const t = await setup(["lost"], () => () => {});
  const ac = new AbortController();
  const deps = { ...t.deps, signal: ac.signal, sleep: async () => ac.abort(new Error("page closed")) };
  await assert.rejects(bindDeposit(SEED, t.args, deps));
  const mbh = t.sent[0]!.mbh;
  assert.ok(t.chain.low() < mbh, "the call is inside its window");
  await assert.rejects(checkCleanup("DeleteAccount", t.u, t.deps.rpcs)); // same session: refused
  resetBindSession(); // the page reloads
  const reads = t.chain.readsOfKeys;
  const r = await checkCleanup("DeleteAccount", t.u, t.deps.rpcs).then(() => "allowed", (e: unknown) => e);
  assert.notEqual(r, "allowed", `allowed after a reload with ${t.chain.readsOfKeys - reads} reads, final ${t.chain.low()} <= max_block_height ${mbh}`);
});

// E. checkCleanup takes its record before its RPC read: a call signed while that read is out is not seen.
test("REVIEW E (expect FAIL on 971d252): a call signed while checkCleanup's read is out keeps DeleteAccount refused", async () => {
  const t = await setup();
  const args = { network: "testnet" as const, amount: AMOUNT, precommitment: t.note.precommitment };
  const old = await resignDeposit(SEED, 1n, t.i, args, { sender_id: t.u, nonce: t.chain.a.nonce + 1n, max_block_height: 0n }, "resign_needed", t.deps.rpcs);
  t.chain.blocks(200n); // that call is long dead
  let fresh = null as { max_block_height: bigint } | null; // set inside the hook (a cast, so tsc does not narrow it to null)
  let hooked = false;
  const rpcs = t.deps.rpcs.map((r) => ({
    name: r.name,
    query: async (p: Record<string, unknown>) => {
      if (!hooked && p.request_type === "view_access_key_list") {
        hooked = true; // another tab path in this session signs a new call while the gate's read is out
        fresh = await resignDeposit(SEED, 1n, t.i, args, { sender_id: t.u, nonce: t.chain.a.nonce + 1n, max_block_height: 0n }, "resign_needed", t.deps.rpcs);
      }
      return r.query(p);
    },
  })) as unknown as [NearRpc, NearRpc];
  const r = await checkCleanup("DeleteAccount", t.u, rpcs).then(() => "allowed", (e: unknown) => e);
  assert.ok(fresh !== null && fresh!.max_block_height > t.chain.low() && old.max_block_height < t.chain.low());
  assert.notEqual(r, "allowed", `allowed while a call with max_block_height ${fresh!.max_block_height} can land (final ${t.chain.low()})`);
});

// F. Two-RPC rule: both RPCs hold P but with another row (a lying or forked RPC): never held. (Guard present; no test on
// the branch: mutant M8 survives.)
test("REVIEW F (expect PASS; kills M8): both RPCs hold P with different rows: unsure, never held", async () => {
  const t = await setup();
  const w = new DepositsWatch(VAULT, t.note.precommitment, t.deps.rpcs);
  t.chain.addRow(t.note.precommitment, { side: "a" });
  t.chain.addRow(t.note.precommitment, { side: "b", value: AMOUNT + 1n });
  assert.deepEqual(await w.read(), { state: "unsure" });
  t.chain.b.rows = [];
  t.chain.addRow(t.note.precommitment, { side: "b" });
  t.chain.b.rows[0]!.label = "999";
  assert.deepEqual(await w.read(), { state: "unsure" });
  t.chain.b.rows[0]!.label = t.chain.a.rows[0]!.label;
  t.chain.b.rows[0]!.leaf_index = 7;
  assert.deepEqual(await w.read(), { state: "unsure" });
  t.chain.b.rows[0]!.leaf_index = t.chain.a.rows[0]!.leaf_index;
  t.chain.b.rows[0]!.depositor = "f".repeat(64);
  assert.deepEqual(await w.read(), { state: "unsure" });
  t.chain.b.rows[0]!.depositor = t.chain.a.rows[0]!.depositor;
  assert.equal((await w.read()).state, "held");
});

// G. The clean-up gate covers a re-signed call's later window (R4), not only the first call's. (Mutants M33, M34 survive.)
test("REVIEW G (expect PASS; kills M33/M34): after an R4 re-sign, DeleteAccount waits for the re-signed call's window", async () => {
  const t = await setup(["resign_needed", "tx"]);
  t.chain.tick = () => t.chain.blocks(3n);
  landed(await bindDeposit(SEED, t.args, t.deps));
  const [m1, m2] = [t.sent[0]!.mbh, t.sent[1]!.mbh];
  assert.ok(m2 > m1);
  t.chain.a.height = t.chain.b.height = m1 + LAPSE_MARGIN + 1n;
  if (m2 + LAPSE_MARGIN >= t.chain.a.height) await assert.rejects(checkCleanup("DeleteAccount", t.u, t.deps.rpcs));
  t.chain.a.height = t.chain.b.height = m2 + LAPSE_MARGIN + 1n;
  await checkCleanup("DeleteAccount", t.u, t.deps.rpcs);
});

// H. A note whose stored P is not its ref's (a corrupt or planted record): refused before anything is signed. (M49 survives.)
test("REVIEW H (expect PASS; kills M49): a note whose P is not its ref's is refused, nothing read or sent", async () => {
  const t = await setup();
  await t.store.move(t.note.id, "PLANNED", "INCOMING");
  await t.store.move(t.note.id, "INCOMING", "UNSPENT", { leaf: { value: AMOUNT, label: 1000n, commitment: noteCommitment(AMOUNT, 1000n, t.note.precommitment), leafIndex: 0n } });
  const ref: NoteRef = { kind: "second", id: { id: "U", s: 1n, i: t.i }, n: 0 };
  const bad = await t.store.add({ ref, scope: 1n, precommitment: 12345n, state: "PLANNED" });
  const reads = t.chain.readsOfKeys;
  await assert.rejects(bindDeposit(SEED, { ...t.args, noteId: bad.id }, t.deps), (e: unknown) => e instanceof DepositBindRefused && e.code === "note");
  assert.equal(t.sent.length, 0);
  assert.equal(t.chain.readsOfKeys, reads);
});

// I. Codes the branch's tests never send: in_flight, p_used, expired, bad_nonce settle from the pages; token_halted and
// relayer_low wait and send the same bytes. (M41-M44 survive.)
for (const code of ["in_flight", "p_used", "expired", "bad_nonce"]) {
  test(`REVIEW I (expect PASS; kills M41-M43): ${code} settles from the pages, never stops as refused`, async () => {
    const t = await setup([code], () => () => {});
    let n = 0;
    t.chain.tick = () => {
      t.chain.blocks(1n);
      if (++n === 3) (t.chain.a.nonce = t.chain.b.nonce = t.chain.a.nonce + 1n, (t.chain.balance -= AMOUNT), t.chain.addRow(t.note.precommitment));
    };
    landed(await bindDeposit(SEED, t.args, t.deps));
    assert.equal(t.sent.length, 1);
  });
}
for (const code of ["token_halted", "relayer_low"]) {
  test(`REVIEW I (expect PASS; kills M44): ${code} waits and sends the same signed bytes`, async () => {
    const t = await setup([code, "tx"]);
    landed(await bindDeposit(SEED, t.args, t.deps));
    assert.equal(t.sent.length, 2);
    assert.equal(t.sent[1]!.bytes, t.sent[0]!.bytes);
  });
}

// J. R4 in the flow with U's nonce moved under it: no call at another nonce leaves. (M46 survives.)
test("REVIEW J (expect PASS; kills M46): resign_needed after U's nonce moved: no call at another nonce is sent", async () => {
  const t = await setup(["resign_needed", "tx"], () => () => {});
  const f = t.deps.fetchFn;
  let first = true;
  const deps = {
    ...t.deps,
    fetchFn: (async (u: string, i: RequestInit) => {
      const r = await f(u, i);
      if (first) {
        first = false; // the first call's same-nonce sibling landed somewhere else meanwhile (e.g. another tab's)
        t.chain.a.nonce = t.chain.b.nonce = t.chain.a.nonce + 1n;
        t.chain.balance -= AMOUNT;
        t.chain.addRow(t.note.precommitment);
      }
      return r;
    }) as unknown as typeof fetch,
  };
  landed(await bindDeposit(SEED, t.args, deps));
  assert.ok(t.sent.every((s) => s.nonce === t.sent[0]!.nonce), t.sent.map((s) => s.nonce).join(","));
});

// K. A deposits page read that never ends (an RPC answering full pages forever; or a long real history): the caller's
// AbortSignal is not seen inside the scan.
test("REVIEW K (expect FAIL on 971d252): the caller's AbortSignal stops a scan that does not end", async () => {
  const t = await setup();
  const ac = new AbortController();
  let pages = 0;
  let afterAbort = 0;
  const full = (from: number) =>
    Array.from({ length: 1000 }, (_, k) => ({ index: from + k, precommitment: "1", label: "1", value: "1000000", leaf_index: from + k, depositor: "x.testnet" }));
  const rpcs = t.deps.rpcs.map((r) => ({
    name: r.name,
    tx: r.tx,
    query: async (p: Record<string, unknown>) => {
      if (p.method_name === "deposits") {
        if (++pages === 10) ac.abort(new Error("caller stopped"));
        if (ac.signal.aborted && ++afterAbort > 200) throw new Error("test cap");
        const { from } = JSON.parse(Buffer.from(p.args_base64 as string, "base64").toString());
        return { jsonrpc: "2.0", id: "x", result: { block_height: 275753808, logs: [], result: [...Buffer.from(JSON.stringify(full(from)))] } };
      }
      return r.query(p);
    },
  })) as unknown as [BindRpc, BindRpc];
  await assert.rejects(bindDeposit(SEED, t.args, { ...t.deps, rpcs, signal: ac.signal }), /caller stopped/);
  assert.ok(afterAbort <= 4, `${afterAbort} page reads after the abort`);
});

test("REVIEW A2: the Delegate ran in its window but the token's receipt is delayed too: no second call on P", async () => {
  let pending: Sent | null = null;
  let ran = false, debited = false;
  const t = await setup(["tx", "tx"], () => (s) => { pending ??= s; });
  t.chain.tick = () => {
    t.chain.blocks(1n);
    const h = t.chain.low();
    if (pending && !ran && h >= pending.mbh - 1n) { ran = true; t.chain.a.nonce = t.chain.b.nonce = pending.nonce; }
    if (pending && ran && !debited && h >= pending.mbh + 8n) { debited = true; t.chain.balance -= AMOUNT; t.chain.addRow(pending.p); }
  };
  landed(await bindDeposit(SEED, t.args, t.deps));
  assert.equal(t.sent.length, 1, `second call at ${t.sent[1]?.low}`);
});

// ---------- the fix round (F1, F2) ----------

// The relayer answers the first call with a tx_hash of another final transaction: the device cannot tie it to U's call,
// so it never signs a second call on P, whatever U's nonce and balance say.
test("F1: a relayer's tx_hash that does not carry U's signed call is never trusted: no second call on P", async () => {
  const t = await setup(["hash:" + base58.encode(new Uint8Array(32).fill(0xee))], () => () => {});
  const other: Sent = { ...({} as Sent), nonce: 0n, mbh: 0n, p: 0n, bytes: "", low: 0n, hash: base58.encode(new Uint8Array(32).fill(0xee)), sender: t.u, receiver: NET.token, pk: publicKeyOf(t.u), sig: "ed25519:" + base58.encode(new Uint8Array(64).fill(7)) };
  t.chain.txs.set(other.hash, other);
  t.chain.finals.add(other.hash); // a real final tx, of something else
  const n0 = t.chain.a.nonce;
  const ac = new AbortController();
  let ticks = 0;
  t.chain.tick = () => {
    t.chain.blocks(10n);
    if (ticks === 0) t.chain.a.nonce = t.chain.b.nonce = n0 + 1n; // the call ran and was refused: the USDC is back in U
    if (++ticks === 80) ac.abort(new Error("caller stopped"));
  };
  await assert.rejects(bindDeposit(SEED, t.args, { ...t.deps, signal: ac.signal }), /caller stopped/);
  assert.ok(t.chain.low() > t.sent[0]!.mbh + 100n, "long past the window");
  assert.ok(t.chain.txReads > 0, "the hash was read");
  assert.equal(t.sent.length, 1, t.sent.map((s) => s.nonce).join(","));
});

test("F1: with no relayer account in the release, a refused call's tx cannot be read: the device never signs again on P", async () => {
  const t = await setup(["tx"], (c) => (s) => ((c.a.nonce = c.b.nonce = s.nonce), c.finals.add(s.hash)));
  const ac = new AbortController();
  let ticks = 0;
  t.chain.tick = () => (t.chain.blocks(10n), ++ticks === 60 && ac.abort(new Error("caller stopped")));
  await assert.rejects(bindDeposit(SEED, t.args, { ...t.deps, relayerAccount: null, signal: ac.signal }), /caller stopped/);
  assert.equal(t.sent.length, 1);
});

test("F1: no answer to the first send: the same bytes go again for the tx hash, and only then a new call on P", async () => {
  let calls = 0;
  const t = await setup(["lost", "tx", "tx"], (c) => (s) => {
    c.finals.add(s.hash); // the re-send's answer is the first call's own transaction, final
    if (++calls === 2) lands(c)(s);
  });
  const n0 = t.chain.a.nonce;
  let ticks = 0;
  t.chain.tick = () => {
    t.chain.blocks(10n);
    if (++ticks === 1) t.chain.a.nonce = t.chain.b.nonce = n0 + 1n; // the lost call ran and was refused
  };
  landed(await bindDeposit(SEED, t.args, t.deps));
  assert.equal(t.sent.length, 3);
  assert.equal(t.sent[1]!.bytes, t.sent[0]!.bytes); // the same signed call, sent again for its hash
  assert.equal(t.sent[2]!.nonce, n0 + 2n);
  assert.equal(t.sent[2]!.p, t.sent[0]!.p);
});

// M9: an RPC that reports U's old nonce to the signer after the refusal: the signer would sign at the dead call's
// nonce; that call is dropped and the device reads again.
test("F2 (M9): after a refusal, a new call at or below the dead call's nonce is never sent", async () => {
  let lies = 0;
  let calls = 0;
  const t = await setup(["tx", "tx"], (c) => (s) => {
    c.a.nonce = c.b.nonce = s.nonce;
    c.finals.add(s.hash); // the first: refused, the USDC back in U
    if (++calls === 2) (c.balance -= AMOUNT, c.addRow(s.p));
  });
  const n0 = t.chain.a.nonce;
  let liar = 0;
  const rpcs = t.deps.rpcs.map((r) => ({
    name: r.name,
    tx: async (p: Parameters<BindRpc["tx"]>[0]) => ((liar = 2), r.tx(p)),
    query: async (p: Record<string, unknown>) => {
      const j = (await r.query(p)) as any;
      if (p.request_type === "view_access_key_list" && liar > 0 && lies < 6) (liar--, lies++, (j.result.keys[0].access_key.nonce = Number(n0)));
      return j;
    },
  })) as unknown as [BindRpc, BindRpc];
  t.chain.tick = () => t.chain.blocks(10n);
  landed(await bindDeposit(SEED, t.args, { ...t.deps, rpcs }));
  assert.ok(lies >= 2, `${lies} lying reads`);
  assert.deepEqual(t.sent.map((s) => s.nonce), [n0 + 1n, n0 + 2n]);
});

test("F2 (M11): DeleteAccount is refused while a bind for U runs, even with every call it signed long dead", async () => {
  const store = await noteStore();
  const first = await store.planDeposit(1n, pc);
  const i = (first.ref as { i: number }).i;
  const chain = new Chain(depositAccount(SEED, 1n, i).account);
  const r = relayer(chain, ["tx"], lands(chain));
  const deps = { store, rpcs: chain.rpcs(), fetchFn: r.fetchFn, sleep: async () => (chain.tick(), await turn()), signal: AbortSignal.timeout(20_000), relayerAccount: RELAYER };
  landed(await bindDeposit(SEED, { network: "testnet", s: 1n, i, noteId: first.id, amount: AMOUNT }, deps));
  chain.blocks(500n); // the first call is long dead
  await checkCleanup("DeleteAccount", chain.u, deps.rpcs);
  const ref: NoteRef = { kind: "second", id: { id: "U", s: 1n, i }, n: 0 };
  const second = await store.add({ ref, scope: 1n, precommitment: pc(ref), state: "PLANNED" });
  chain.addRow(second.precommitment, { side: "a" }); // one RPC holds it: the bind pauses before anything is signed
  let during: unknown = null;
  const bindDeps = {
    ...deps,
    sleep: async () => {
      during ??= await checkCleanup("DeleteAccount", chain.u, deps.rpcs).then(() => "allowed", (e: unknown) => e);
      chain.addRow(second.precommitment, { side: "b" });
      await turn();
    },
  };
  landed(await bindDeposit(SEED, { network: "testnet", s: 1n, i, noteId: second.id, amount: AMOUNT }, bindDeps));
  assert.ok(during instanceof DepositBindRefused && during.code === "cleanup" && /being sent/.test(during.message), String(during));
});

test("F2 (M28): the pages' next read starts at the lower count of the two RPCs, so a row the other has yet to show is found", async () => {
  const t = await setup();
  const w = new DepositsWatch(VAULT, t.note.precommitment, t.deps.rpcs);
  for (let k = 0; k < 5; k++) t.chain.addRow(BigInt(k + 1), { side: "a" }); // RPC a answers five rows RPC b does not have
  assert.deepEqual(await w.read(), { state: "absent" });
  t.chain.a.rows = [];
  t.chain.addRow(t.note.precommitment); // the vault's real row 0, on both
  assert.equal((await w.read()).state, "held");
});
