// send.ts, one case per path of V 2.10 (f)-(i) and M284's R1-R7 (markets H4.3 checks 8-9, M:1755-1868), the idempotent
// answer to a re-send of carried bytes, U's in-flight slot, the relayer's queue and nonce, the settling of every
// transaction whose outcome was not read, and the store's lock and atomic writes. Most cases run on a fake chain that
// keeps U's key nonce, U's USDC, the vault's deposits pages and every relayer transaction in order; the relayer's own
// cases run createRelayer on two fake providers. Delegates are signed with real ed25519, so checks 1-7 run as they do
// live. The sandbox twin is contracts/vault/tests/relayer_send.rs.
//   node --test apps/helper/src/bind/send.test.ts
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { spawn } from "node:child_process";
import * as nodeFs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { vaultDepositMessage } from "../../../../packages/kit/src/index.ts";
import { NEP366_PREFIX, VAULT_TOKEN, base58, decodeSignedDelegate, type KeyRead } from "./checks.ts";
import {
  MAX_FAILED_SENDS,
  PREPAY_BYTES,
  PREPAY_MAX_BYTES,
  PER_P_WORST_YOCTO,
  RELAYER_FLOOR_YOCTO,
  RpcError,
  USDC_PAUSED,
  base58decode,
  carryDeposit,
  createFileStore,
  createRelayer,
  createSendReads,
  encodeAction,
  insertGrows,
  prepayBytes,
  relayerKey,
  type Answer,
  type DepositStore,
  type Receipt,
  type Relayer,
  type RelayerAction,
  type Rpc,
  type SendDeps,
  type SendReads,
  type Settled,
  type StoreFs,
  type TxOutcome,
  type TxRef,
} from "./send.ts";
import { USDC_CODE_HASH, pausedAt, type TokenStatus } from "../token-status/status.ts";

const VAULT = "vault.confidential.unrlzd.near";
const RELAYER = "bind.test.near";
const T = 1_000_000_000_000n;
const AMOUNT = 25_000_000n;
const P = 1234567890123456789012345678901234567890n;

// ---- signing (as checks.test.ts) ----
const le = (n: bigint, len: number): Buffer => {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
};
const str = (s: string): Buffer => Buffer.concat([le(BigInt(Buffer.byteLength(s)), 4), Buffer.from(s, "utf8")]);
type Key = { priv: KeyObject; pub: Buffer; id: string };
function newKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { priv: privateKey, pub, id: pub.toString("hex") };
}
function signed(k: Key, p: bigint, nonce: bigint, mbh: bigint): { signed_delegate: string } {
  const args = JSON.stringify({ receiver_id: VAULT, amount: AMOUNT.toString(), msg: vaultDepositMessage(p, k.id) });
  const act = Buffer.concat([Buffer.from([2]), str("ft_transfer_call"), str(args), le(180n * T, 8), le(1n, 16)]);
  const delegate = Buffer.concat([str(k.id), str(VAULT_TOKEN), le(1n, 4), act, le(nonce, 8), le(mbh, 8), Buffer.from([0]), k.pub]);
  const hash = createHash("sha256").update(le(BigInt(NEP366_PREFIX), 4)).update(delegate).digest();
  return { signed_delegate: Buffer.concat([delegate, Buffer.from([0]), sign(null, hash, k.priv)]).toString("base64") };
}
function decodeSent(a: RelayerAction): { u: string; nonce: bigint; p: bigint; amount: bigint } {
  assert.equal(a.kind, "delegate");
  const d = decodeSignedDelegate((a as { signed: Uint8Array }).signed);
  const fc = d.actions[0] as { args: Uint8Array };
  const args = JSON.parse(Buffer.from(fc.args).toString("utf8")) as { msg: string; amount: string };
  return { u: d.sender_id, nonce: d.nonce, p: BigInt((JSON.parse(args.msg) as { precommitment: string }).precommitment), amount: BigInt(args.amount) };
}

// ---- the fake chain ----
/** block_height -1: the watch is caught up to the newest final height whenever it is asked. */
const OPEN: TokenStatus = { token: VAULT_TOKEN, caught_up: true, halted: false, vault_blocked: false, code_hash_ok: true, code_hash: USDC_CODE_HASH, block_height: -1, last_event: null };
const HALTED: TokenStatus = { ...OPEN, halted: true };
const LAGGING: TokenStatus = { ...OPEN, caught_up: false, halted: null };

/** What a delegate send does on chain; the "unknown*" ones give the relayer no FINAL answer (the second still ran). */
type SendFate = "lands" | "lands_short" | "refused_by_vault" | "paused" | "paused_elsewhere" | "front_run" | "dropped" | "unknown" | "unknown_lands" | "crash";
type PrepayFate = "lands" | "fails" | "unknown_lands" | "unknown" | "dropped" | "crash";
class Chain {
  final = 1_000n;
  nonce = new Map<string, bigint>();
  usdc = new Map<string, bigint>();
  pages = new Map<string, { depositor: string; value: bigint }>();
  trees = { state: 3n, label: 3n };
  balance = 10n ** 24n;
  txs: { action: RelayerAction; hash: string; height: bigint }[] = [];
  prepaid = new Map<string, bigint>();
  /** What the next delegate send does, then the ones after; the last repeats. */
  fates: SendFate[] = ["lands"];
  prepayFates: PrepayFate[] = ["lands"];
  /** Each transaction's FINAL outcome, as resolve() reads it later; resolveAs overrides it. */
  outcomes = new Map<string, TxOutcome>();
  resolveAs = new Map<string, TxOutcome>();
  resolved: string[] = [];
  statuses: TokenStatus[] = [OPEN];
  statusAsks = 0;
  /** The watch's pause history's answer for a height (status.ts pausedAt). */
  pausedAt: (height: bigint) => boolean | null = () => false;
  resolveOpts: { resend: boolean; gone: boolean }[] = [];
  /** Runs inside a relayer send, after its durable write (a race). */
  during?: () => Promise<void>;
  /** Final height moves by this after each prepay that lands, besides its receipts. */
  prepayAdvance = 0n;
  /** How far the newer provider's final is ahead of the older's. */
  ahead = 0n;
  /** depositSettled answers "unknown" this many more times (the lower provider has not reached the receipt yet). */
  pagesLag = 0;
  relayerNonce = 1n;
  n = 0;

  reads(): SendReads {
    const settled = async (p: bigint): Promise<Settled> => {
      if (this.pagesLag > 0) {
        this.pagesLag--;
        return { state: "unknown" };
      }
      const row = this.pages.get(p.toString());
      return row === undefined ? { state: "absent" } : { state: "held", ...row };
    };
    return {
      accessKey: async (a): Promise<KeyRead> => (this.nonce.has(a) ? { kind: "key", permission: "FullAccess", nonce: this.nonce.get(a)! } : { kind: "no_account" }),
      finalHeight: async () => this.final,
      newestFinalHeight: async () => this.final + this.ahead,
      ftBalance: async (a) => this.usdc.get(a) ?? 0n,
      pUsed: async (p) => this.pages.has(p.toString()),
      deposit: async (p) => this.pages.get(p.toString()) ?? null,
      depositSettled: (p) => settled(p),
      trees: async () => ({ ...this.trees }),
    };
  }
  private next<F>(list: F[]): F {
    return list.length > 1 ? list.shift()! : list[0]!;
  }
  /** One receipt per block, each a block after the last. */
  private receipts(...rs: [string, boolean, string?][]): Receipt[] {
    return rs.map(([executor, ok, failure]) => ({ executor, ok, failure: failure ?? "", height: ++this.final }));
  }
  private runDelegate(action: RelayerAction, hash: string, fate: SendFate): TxOutcome {
    this.txs.push({ action, hash, height: this.final + 1n });
    const d = decodeSent(action);
    this.nonce.set(d.u, d.nonce); // the Delegate ran: U's nonce is used
    if (fate === "lands" || fate === "unknown_lands" || fate === "lands_short") {
      const value = fate === "lands_short" ? d.amount - 1n : d.amount;
      this.usdc.set(d.u, this.usdc.get(d.u)! - value);
      this.pages.set(d.p.toString(), { depositor: d.u, value });
      this.trees.state++;
      this.trees.label++;
      return { kind: "final", tx_hash: hash, receipts: this.receipts([d.u, true], [VAULT_TOKEN, true], [VAULT, true]) };
    }
    if (fate === "front_run") {
      this.pages.set(d.p.toString(), { depositor: "stranger.near", value: d.amount });
      return { kind: "final", tx_hash: hash, receipts: this.receipts([d.u, true], [VAULT, false, "PrecommitmentAlreadyUsed"]) };
    }
    const paused = `{"Failure":{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ${USDC_PAUSED}"}}}}}`;
    if (fate === "paused") return { kind: "final", tx_hash: hash, receipts: this.receipts([d.u, true], [VAULT_TOKEN, false, paused]) };
    if (fate === "paused_elsewhere") return { kind: "final", tx_hash: hash, receipts: this.receipts([d.u, true], [VAULT, false, paused]) };
    return { kind: "final", tx_hash: hash, receipts: this.receipts([d.u, true], [VAULT, false, `{"Failure":"Smart contract panicked: refused"}`]) };
  }
  private runPrepay(action: Extract<RelayerAction, { kind: "storage_prepay" }>, hash: string, fate: PrepayFate): TxOutcome {
    this.txs.push({ action, hash, height: this.final + 1n });
    if (fate === "fails") return { kind: "final", tx_hash: hash, receipts: this.receipts([VAULT, false, "InsufficientStorageDeposit"]) };
    const key = action.precommitment.toString();
    this.prepaid.set(key, (this.prepaid.get(key) ?? 0n) + action.bytes);
    const out: TxOutcome = { kind: "final", tx_hash: hash, receipts: this.receipts([VAULT, true], [RELAYER, true]) };
    this.final += this.prepayAdvance;
    return out;
  }
  relayer(): Relayer {
    return {
      account: RELAYER,
      balance: async () => this.balance,
      resolve: async (tx, opts) => {
        this.resolved.push(tx.tx_hash);
        this.resolveOpts.push(opts);
        return this.resolveAs.get(tx.tx_hash) ?? this.outcomes.get(tx.tx_hash) ?? { kind: "unknown", tx_hash: tx.tx_hash, why: "not found" };
      },
      send: async (action, guard, before) => {
        const code = await guard();
        if (code !== null) return { kind: "guarded", code };
        const hash = base58(createHash("sha256").update(`tx${this.n++}`).digest());
        before({ tx_hash: hash, nonce: String(this.relayerNonce++), signed_tx: "c2lnbmVk" });
        await this.during?.();
        const fate = action.kind === "storage_prepay" ? this.next(this.prepayFates) : this.next(this.fates);
        if (fate === "crash") throw new Error("crash after the durable write");
        if (fate === "dropped") return { kind: "dropped", tx_hash: hash, why: "Expired" };
        if (fate === "unknown") return { kind: "unknown", tx_hash: hash, why: "no answer" };
        const out = action.kind === "storage_prepay" ? this.runPrepay(action, hash, fate as PrepayFate) : this.runDelegate(action, hash, fate as SendFate);
        this.outcomes.set(hash, out);
        return fate === "unknown_lands" ? { kind: "unknown", tx_hash: hash, why: "no answer" } : out;
      },
    };
  }
  deps(store: DepositStore): SendDeps {
    return {
      cfg: { vault: VAULT, token: VAULT_TOKEN, marginK: 20n },
      reads: this.reads(),
      store,
      relayer: this.relayer(),
      tokenStatus: async () => {
        const s = this.statuses[Math.min(this.statusAsks, this.statuses.length - 1)]!;
        this.statusAsks++;
        return { ...s, block_height: s.block_height === -1 ? Number(this.final + this.ahead) : s.block_height };
      },
      pausedAt: async (h) => this.pausedAt(h),
    };
  }
  prepays = () => this.txs.filter((t) => t.action.kind === "storage_prepay");
  sends = () => this.txs.filter((t) => t.action.kind === "delegate");
}

type World = { chain: Chain; store: DepositStore; dir: string; u: Key; deps: SendDeps; carry: (req: unknown) => Promise<Answer>; reopen: () => void };
function world(): World {
  const chain = new Chain();
  const dir = mkdtempSync(join(tmpdir(), "bind-send-"));
  const u = newKey();
  chain.nonce.set(u.id, 100n);
  chain.usdc.set(u.id, 10n * AMOUNT);
  const w = { chain, dir, u } as World;
  w.store = createFileStore(dir);
  w.deps = chain.deps(w.store);
  w.carry = (req) => carryDeposit(req, w.deps);
  /** A restart: the store given up and opened again on the same directory. */
  w.reopen = () => {
    w.store.close();
    w.store = createFileStore(dir);
    w.deps = { ...w.deps, store: w.store };
  };
  return w;
}
const code = (a: Answer) => ("error" in a.body ? a.body.error.code : "ok");
const ok = (a: Answer) => {
  assert.equal(a.status, 200, JSON.stringify(a));
  return (a.body as { tx_hash: string }).tx_hash;
};
/** U's next call on p: the key's next nonce, 100 blocks of room. */
const next = (w: World, p = P) => signed(w.u, p, w.chain.nonce.get(w.u.id)! + 1n, w.chain.final + 100n);
const rec = (w: World) => w.store.get(w.u.id)!;

// ---- (h): the prepay, then the send ----

test("R5's size: 904 B when an insert from now through those in flight grows a tree, else 756 B", () => {
  assert.deepEqual([0n, 1n, 2n, 3n, 4n, 5n, 8n, 1024n, 1023n].map(insertGrows), [true, true, true, false, true, false, true, true, false]);
  assert.equal(prepayBytes({ state: 5n, label: 5n }, 0n), PREPAY_BYTES);
  assert.equal(prepayBytes({ state: 5n, label: 5n }, 2n), PREPAY_BYTES); // 5, 6, 7
  assert.equal(prepayBytes({ state: 5n, label: 5n }, 3n), PREPAY_MAX_BYTES); // 8
  assert.equal(prepayBytes({ state: 5n, label: 8n }, 0n), PREPAY_MAX_BYTES); // the label tree grows
  assert.equal(prepayBytes({ state: 0n, label: 0n }, 0n), PREPAY_MAX_BYTES); // the first insert
  assert.throws(() => encodeAction({ kind: "storage_prepay", precommitment: P, bytes: 905n }), /1\.\.904/);
});

test("(h) the prepay, then the send only after its SuccessValue: one prepay of 756 B, the delegate in a later block, the deposit lands", async () => {
  const w = world();
  const h = ok(await w.carry(next(w)));
  assert.deepEqual(w.chain.txs.map((t) => t.action.kind), ["storage_prepay", "delegate"]);
  const [pre, snd] = [w.chain.prepays()[0]!, w.chain.sends()[0]!];
  assert.equal((pre.action as { bytes: bigint }).bytes, PREPAY_BYTES);
  assert.ok(pre.height < snd.height, "never in the same block");
  assert.equal(snd.hash, h);
  const r = rec(w);
  assert.deepEqual([r.prepaid_bytes, r.failed, r.landed, r.struck, r.sends[0]!.state, r.sends[0]!.counted], [756, 0, true, false, "landed", false]);
});

test("(h) 904 B when a tree may grow: the trees at a power of two, or inserts in flight that reach one", async () => {
  const w = world();
  w.chain.trees = { state: 8n, label: 8n };
  ok(await w.carry(next(w)));
  assert.equal((w.chain.prepays()[0]!.action as { bytes: bigint }).bytes, PREPAY_MAX_BYTES);
  const v = world();
  v.chain.trees = { state: 6n, label: 6n };
  v.deps.insertsInFlight = async () => 2n;
  ok(await v.carry(next(v)));
  assert.equal((v.chain.prepays()[0]!.action as { bytes: bigint }).bytes, PREPAY_MAX_BYTES);
});

test("(h) R4 after the prepay's SuccessValue: under the margin K, resign_needed, no send, not counted; the re-signed call is not prepaid again", async () => {
  const w = world();
  w.chain.prepayAdvance = 90n; // the final height moves past max_block_height - K during the prepay
  assert.equal(code(await w.carry(next(w))), "resign_needed");
  assert.equal(w.chain.sends().length, 0);
  assert.deepEqual([rec(w).failed, rec(w).prepaid_bytes, rec(w).sends.length], [0, 756, 0]);
  w.chain.prepayAdvance = 0n;
  ok(await w.carry(next(w)));
  assert.equal(w.chain.prepays().length, 1, "no second prepay");
});

test("R4 reads the newest final height, before the prepay: one provider 6 ahead puts a call 25 ahead of the other under K, nothing prepaid or written", async () => {
  const w = world();
  w.chain.ahead = 6n;
  assert.equal(code(await w.carry(signed(w.u, P, 101n, w.chain.final + 25n))), "resign_needed"); // check 4 reads the lower: 25 >= K
  assert.deepEqual([w.chain.txs.length, rec(w).prepays.length, rec(w).prepaid_bytes], [0, 0, 0]);
  w.chain.ahead = 0n;
  // K exactly at the send's guard (the prepay's two receipts move the final by 2) is enough
  ok(await w.carry(signed(w.u, P, 101n, w.chain.final + 22n)));
});

// ---- H1: the guard runs inside the relayer's queue ----

test("H1: R4 runs at the send's turn in the queue: the final passing the margin while the call waits answers resign_needed with nothing written", async () => {
  const w = world();
  const real = w.deps.relayer.send;
  w.deps.relayer.send = async (action, guard, before) => {
    if (action.kind === "delegate") w.chain.final += 200n; // the call waited in the queue past its window
    return real(action, guard, before);
  };
  assert.equal(code(await w.carry(next(w))), "resign_needed");
  assert.deepEqual([w.chain.sends().length, rec(w).sends.length, rec(w).failed], [0, 0, 0]);
});

// ---- the idempotent answer and U's in-flight slot ----

test("a re-send of carried bytes answers 200 with that tx_hash, before check 3 (U's nonce moved), and sends nothing; after a restart too", async () => {
  const w = world();
  const req = next(w);
  const h = ok(await w.carry(req));
  const n = w.chain.txs.length;
  assert.equal(ok(await w.carry(req)), h);
  w.reopen();
  assert.equal(ok(await w.carry(req)), h);
  assert.equal(w.chain.txs.length, n);
});

test("a re-send of carried bytes whose send failed answers its tx_hash too, not bad_nonce", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault"];
  const req = next(w);
  const h = ok(await w.carry(req));
  assert.equal(ok(await w.carry(req)), h);
  assert.equal(w.chain.sends().length, 1);
});

test("a re-send of bytes carried on U's earlier P answers its tx_hash after U moved to a new P", async () => {
  const w = world();
  const first = next(w);
  const h = ok(await w.carry(first));
  ok(await w.carry(next(w, P + 1n)));
  assert.equal(rec(w).p, (P + 1n).toString());
  assert.equal(ok(await w.carry(first)), h);
});

test("the count and the carried index are one write before the send goes: a crash in the send still answers its hash", async () => {
  const w = world();
  w.chain.fates = ["crash"];
  const req = next(w);
  await assert.rejects(w.carry(req), /crash/);
  const r = rec(w);
  assert.deepEqual([r.sends.length, r.sends[0]!.state, r.sends[0]!.counted], [1, "pending", true]);
  w.reopen();
  assert.equal(ok(await w.carry(req)), r.sends[0]!.tx_hash);
});

test("a send of ours dropped before inclusion goes again once, signed afresh: U's call lands, nothing counted", async () => {
  const w = world();
  w.chain.fates = ["dropped", "lands"];
  const h = ok(await w.carry(next(w)));
  assert.deepEqual([rec(w).sends.map((x) => x.state), rec(w).failed, rec(w).landed, rec(w).sends[1]!.tx_hash], [["dropped", "landed"], 0, true, h]);
});

test("a send dropped twice frees its bytes: resign_needed, not counted, and the same bytes are carried again", async () => {
  const w = world();
  w.chain.fates = ["dropped", "dropped", "lands"];
  const req = next(w);
  assert.equal(code(await w.carry(req)), "resign_needed");
  assert.deepEqual([rec(w).sends.map((x) => x.state), rec(w).failed], [["dropped", "dropped"], 0]);
  ok(await w.carry(req));
  assert.equal(rec(w).landed, true);
});

test("R3-3: two binds sending the same bytes at once get one send between them, and it counts once", async () => {
  const w = world();
  const req = next(w);
  const [a, b] = await Promise.all([w.carry(req), w.carry(req)]);
  assert.deepEqual([code(a), code(b)].sort(), ["in_flight", "ok"]);
  assert.equal(w.chain.sends().length, 1);
  assert.equal(rec(w).failed, 0);
  assert.equal(ok(await w.carry(req)), w.chain.sends()[0]!.hash);
});

test("the carried index is read again inside U's slot: bytes carried while this call ran its checks answer that hash", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault"]; // P stays out of the pages, so check 6 passes
  const req = next(w);
  const h = ok(await w.carry(req));
  const store = w.deps.store;
  let gets = 0;
  w.deps.store = { ...store, get: (u) => (gets++ === 0 ? null : store.get(u)) }; // step 0 misses it
  w.deps.reads.accessKey = async () => ({ kind: "key", permission: "FullAccess", nonce: 100n }); // check 3 read before it moved
  assert.equal(ok(await w.carry(req)), h);
  assert.equal(w.chain.sends().length, 1);
});

test("R3-3: a second call for U while one is carried: in_flight on the same P, prepay_open on another P, neither counted", async () => {
  const w = world();
  const first = next(w);
  const same = signed(w.u, P, 102n, w.chain.final + 100n);
  const other = signed(w.u, P + 1n, 102n, w.chain.final + 100n);
  let answers: Answer[] = [];
  w.chain.during = async () => {
    w.chain.during = undefined;
    answers = await Promise.all([w.carry(same), w.carry(other)]);
  };
  ok(await w.carry(first));
  assert.deepEqual(answers.map(code), ["in_flight", "prepay_open"]);
  assert.equal(w.chain.sends().length, 1);
  assert.equal(rec(w).failed, 0);
});

// ---- (f) the token's hold ----

test("(f) held before the checks: 503 token_halted, nothing prepaid, sent or counted, no record", async () => {
  const w = world();
  w.chain.statuses = [HALTED];
  const a = await w.carry(next(w));
  assert.deepEqual([a.status, code(a)], [503, "token_halted"]);
  assert.equal(w.chain.txs.length, 0);
  assert.equal(w.store.get(w.u.id), null);
  for (const s of [LAGGING, { ...OPEN, vault_blocked: null }, { ...OPEN, code_hash: "x" }]) {
    w.chain.statuses = [s];
    w.chain.statusAsks = 0;
    assert.equal(code(await w.carry(next(w))), "token_halted");
  }
  assert.equal(w.chain.txs.length, 0);
});

test("(f) held at check 9 (after the checks): nothing written", async () => {
  const w = world();
  w.chain.statuses = [OPEN, HALTED];
  assert.equal(code(await w.carry(next(w))), "token_halted");
  assert.deepEqual([w.chain.txs.length, w.store.get(w.u.id)], [0, null]);
});

test("(f) held at the prepay's turn in the queue: nothing prepaid or written", async () => {
  const w = world();
  w.chain.statuses = [OPEN, OPEN, HALTED]; // before the checks, check 9, the prepay's guard
  assert.equal(code(await w.carry(next(w))), "token_halted");
  assert.deepEqual([w.chain.txs.length, rec(w).prepays.length, rec(w).prepaid_bytes], [0, 0, 0]);
});

test("(f) held at the send's turn: no send, not counted; once open, the same P goes with no new prepay", async () => {
  const w = world();
  w.chain.statuses = [OPEN, OPEN, OPEN, HALTED]; // before the checks, check 9, the prepay's guard, the send's guard
  assert.equal(code(await w.carry(next(w))), "token_halted");
  assert.deepEqual(w.chain.txs.map((t) => t.action.kind), ["storage_prepay"]);
  assert.deepEqual([rec(w).failed, rec(w).sends.length], [0, 0]);
  w.chain.statuses = [OPEN];
  w.chain.statusAsks = 0;
  ok(await w.carry(next(w)));
  assert.deepEqual(w.chain.txs.map((t) => t.action.kind), ["storage_prepay", "delegate"]);
});

test("(f) USDC paused refuses its views: the hold answers token_halted before check 6's balance read throws", async () => {
  const w = world();
  w.chain.statuses = [HALTED];
  w.deps.reads.ftBalance = async () => {
    throw new Error("ft_balance_of: no result bytes");
  };
  const a = await w.carry(next(w));
  assert.deepEqual([a.status, code(a)], [503, "token_halted"]);
  assert.equal(w.chain.txs.length, 0);
});

// ---- (g) the simulation ----

test("(g) U's USDC below the amount at the simulation: amount_above_balance, nothing prepaid", async () => {
  const w = world();
  let asks = 0;
  w.deps.reads.ftBalance = async () => (asks++ === 0 ? 10n * AMOUNT : AMOUNT - 1n); // check 6 reads enough, the simulation not
  assert.equal(code(await w.carry(next(w))), "amount_above_balance");
  assert.equal(w.chain.txs.length, 0);
});

test("(g) U's USDC exactly the amount at the simulation is enough", async () => {
  const w = world();
  w.chain.usdc.set(w.u.id, AMOUNT);
  ok(await w.carry(next(w)));
});

test("(g) U's key nonce moved to the call's nonce by the simulation: bad_nonce, nothing prepaid", async () => {
  const w = world();
  const req = next(w);
  let asks = 0;
  w.deps.reads.accessKey = async () => ({ kind: "key", permission: "FullAccess", nonce: asks++ === 0 ? 100n : 101n });
  assert.equal(code(await w.carry(req)), "bad_nonce");
  assert.equal(w.chain.txs.length, 0);
});

// ---- (i) three failed sends, and what counts ----

test("(i) three failed sends strike U: each retry topped up to 904 B first, never above 904 B; then sender_struck with no send", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault"];
  for (let i = 1; i <= MAX_FAILED_SENDS; i++) {
    ok(await w.carry(next(w)));
    const r = rec(w);
    assert.equal(r.failed, i);
    assert.equal(r.prepaid_bytes, i === 1 ? 756 : 904);
    assert.equal(r.struck, i === MAX_FAILED_SENDS);
  }
  assert.deepEqual(w.chain.prepays().map((t) => (t.action as { bytes: bigint }).bytes), [756n, 148n]);
  assert.equal(w.chain.prepaid.get(P.toString()), PREPAY_MAX_BYTES);
  const n = w.chain.txs.length;
  const a = await w.carry(next(w));
  assert.deepEqual([a.status, code(a)], [403, "sender_struck"]);
  w.reopen(); // on any P, and after a restart
  assert.equal(code(await w.carry(next(w, P + 7n))), "sender_struck");
  assert.equal(w.chain.txs.length, n);
});

test("(i) a struck record refuses inside the slot too, when the ledger's read missed the strike", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault"];
  for (let i = 0; i < MAX_FAILED_SENDS; i++) ok(await w.carry(next(w)));
  const store = w.deps.store;
  w.deps.store = { ...store, get: (u) => (store.get(u) === null ? null : { ...store.get(u)!, struck: false }) };
  const n = w.chain.txs.length;
  assert.equal(code(await w.carry(next(w))), "sender_struck");
  assert.equal(w.chain.txs.length, n);
});

test("(i) the third failure is read in the settle: sender_struck, no prepay and no send", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault", "refused_by_vault", "unknown"];
  ok(await w.carry(next(w)));
  ok(await w.carry(next(w)));
  const h = ok(await w.carry(next(w)));
  w.chain.resolveAs.set(h, { kind: "final", tx_hash: h, receipts: [{ executor: VAULT, ok: false, failure: "refused", height: w.chain.final }] });
  const n = w.chain.txs.length;
  assert.equal(code(await w.carry(signed(w.u, P, w.chain.nonce.get(w.u.id)! + 1n, w.chain.final + 101n))), "sender_struck");
  assert.equal(w.chain.txs.length, n);
});

test("(i) a third failure read in the settle stops the prepay too: sender_struck, nothing prepaid", async () => {
  const w = world();
  w.chain.prepayFates = ["fails", "fails", "unknown"];
  assert.equal(code(await w.carry(next(w))), "resign_needed");
  assert.equal(code(await w.carry(next(w))), "resign_needed");
  assert.equal(code(await w.carry(next(w))), "in_flight");
  const h = rec(w).prepays[2]!.tx_hash;
  w.chain.resolveAs.set(h, { kind: "final", tx_hash: h, receipts: [{ executor: VAULT, ok: false, failure: "x", height: w.chain.final }] });
  const n = rec(w).prepays.length;
  assert.equal(code(await w.carry(next(w))), "sender_struck");
  assert.deepEqual([rec(w).struck, rec(w).failed, rec(w).prepays.length, w.chain.sends().length], [true, 3, n, 0]);
});

test("(i) a send landed for U at another amount, or by a stranger on P, is not U's landing: counted", async () => {
  const w = world();
  w.chain.fates = ["front_run"];
  ok(await w.carry(next(w)));
  assert.deepEqual([rec(w).failed, rec(w).landed, rec(w).sends[0]!.state], [1, false, "failed"]);
  const v = world();
  v.chain.fates = ["lands_short"];
  ok(await v.carry(next(v)));
  assert.deepEqual([rec(v).failed, rec(v).landed, rec(v).sends[0]!.state], [1, false, "failed"]);
});

test("(i) R3's exception: USDC's own receipt failed with its paused error and the watch shows USDC paused at that height: not counted", async () => {
  const w = world();
  w.chain.fates = ["paused", "lands"];
  const asked: bigint[] = [];
  w.chain.pausedAt = (h) => (asked.push(h), true);
  ok(await w.carry(next(w)));
  assert.deepEqual([rec(w).failed, rec(w).sends[0]!.state, rec(w).sends[0]!.counted], [0, "exempt", false]);
  assert.deepEqual(asked, [w.chain.final], "asked at the token receipt's own height");
  w.chain.pausedAt = () => false;
  ok(await w.carry(next(w)));
  assert.equal(rec(w).landed, true);
});

test("PROBE N6: paused at the failure, unpaused, then a blocklist and another pause: the history still says paused there, not counted", async () => {
  const w = world();
  w.chain.fates = ["paused"];
  let failAt = 0n;
  w.chain.pausedAt = (h) => {
    failAt = h;
    const at = Number(h);
    return pausedAt({ from: 0, pausedAtFrom: false, caughtUpTo: at + 50, events: [{ name: "paused", block_height: at - 3 }, { name: "unpaused", block_height: at + 2 }, { name: "paused", block_height: at + 9 }] }, at);
  };
  ok(await w.carry(next(w)));
  assert.ok(failAt > 0n);
  assert.deepEqual([rec(w).failed, rec(w).sends[0]!.state], [0, "exempt"]);
});

test("status.ts pausedAt: the state at a height from the history; a pause or unpause in that block is paused; null outside what was read", () => {
  const h = { from: 100, pausedAtFrom: false, caughtUpTo: 200, events: [{ name: "unpaused" as const, block_height: 150 }, { name: "paused" as const, block_height: 120 }] };
  assert.deepEqual([110, 119, 120, 121, 149, 150, 151, 200].map((x) => pausedAt(h, x)), [false, false, true, true, true, true, false, false]);
  assert.deepEqual([pausedAt(h, 99), pausedAt(h, 201)], [null, null]);
  assert.equal(pausedAt({ ...h, pausedAtFrom: true, events: [] }, 150), true);
});

test("(i) R3's exception waits for the watch: no answer at the failure's height leaves the send pending; a later call settles it", async () => {
  const v = world();
  v.chain.fates = ["paused"];
  v.chain.pausedAt = () => null;
  ok(await v.carry(next(v)));
  assert.deepEqual([rec(v).failed, rec(v).sends[0]!.state, rec(v).sends[0]!.counted], [0, "pending", true]);
  v.chain.pausedAt = () => true;
  v.chain.statuses = [OPEN, OPEN, HALTED]; // before the checks, check 9; the prepay's guard holds
  v.chain.statusAsks = 0;
  assert.equal(code(await v.carry(next(v))), "token_halted");
  assert.deepEqual([rec(v).failed, rec(v).sends[0]!.state], [0, "exempt"]);
});

test("(i) the paused error from a receipt that is not the token's counts, and so does the token's when the history says open there", async () => {
  const w = world();
  w.chain.fates = ["paused_elsewhere"];
  w.chain.pausedAt = () => true;
  ok(await w.carry(next(w)));
  assert.equal(rec(w).failed, 1);
  const v = world();
  v.chain.fates = ["paused"];
  ok(await v.carry(next(v)));
  assert.equal(rec(v).failed, 1);
});

test("a delegate that ran past its max_block_height (DelegateActionExpired) is the relayer's late delivery: dropped, never counted", async () => {
  const w = world();
  const real = w.deps.relayer.send;
  w.deps.relayer.send = async (action, guard, before) => {
    const out = await real(action, guard, before);
    if (action.kind === "delegate" && out.kind === "final") return { ...out, receipts: [{ executor: w.u.id, ok: false, failure: '{"ActionError":{"kind":{"DelegateActionExpired":null}}}', height: w.chain.final }] };
    return out;
  };
  w.chain.fates = ["refused_by_vault"];
  assert.equal(code(await w.carry(next(w))), "resign_needed");
  assert.deepEqual([rec(w).failed, rec(w).sends[0]!.state, w.chain.sends().length], [0, "dropped", 1]);
});

test("(i) a failed prepay counts; with P not in the pages it rolls back and asks for a re-sign; with P in the pages it closes P", async () => {
  const w = world();
  w.chain.prepayFates = ["fails", "lands"];
  assert.equal(code(await w.carry(next(w))), "resign_needed");
  assert.deepEqual([rec(w).failed, rec(w).p_closed, rec(w).prepaid_bytes], [1, false, 0]);
  ok(await w.carry(next(w)));
  assert.deepEqual([rec(w).landed, rec(w).failed], [true, 1]);
  const v = world();
  v.chain.prepayFates = ["fails"];
  v.chain.pages.set(P.toString(), { depositor: "stranger.near", value: AMOUNT });
  v.deps.reads.pUsed = async () => false; // check 6 read P absent: it landed while the prepay ran
  assert.equal(code(await v.carry(next(v))), "p_used");
  assert.deepEqual([rec(v).failed, rec(v).p_closed, v.chain.sends().length], [1, true, 0]);
  assert.equal(code(await v.carry(next(v))), "p_used", "a later call on a closed P, check 6 missing it");
  assert.deepEqual([v.chain.prepays().length, v.chain.sends().length], [1, 0]);
});

test("(i) a prepay's ok needs the vault's own receipt: a FINAL answer with no vault receipt is a failed prepay", async () => {
  const w = world();
  const real = w.deps.relayer.send;
  w.deps.relayer.send = async (action, guard, before) => {
    const out = await real(action, guard, before);
    if (action.kind === "storage_prepay" && out.kind === "final") return { ...out, receipts: out.receipts.filter((r) => r.executor !== VAULT) };
    return out;
  };
  assert.equal(code(await w.carry(next(w))), "resign_needed");
  assert.deepEqual([rec(w).failed, rec(w).prepays[0]!.ok, w.chain.sends().length], [1, false, 0]);
});

test("(i) a prepay whose vault receipt ran but a later receipt failed is a failed prepay", async () => {
  const w = world();
  const real = w.deps.relayer.send;
  w.deps.relayer.send = async (action, guard, before) => {
    const out = await real(action, guard, before);
    if (action.kind === "storage_prepay" && out.kind === "final") return { ...out, receipts: out.receipts.map((r) => (r.executor === RELAYER ? { ...r, ok: false } : r)) };
    return out;
  };
  assert.equal(code(await w.carry(next(w))), "resign_needed");
  assert.deepEqual([rec(w).failed, w.chain.sends().length], [1, 0]);
});

// ---- M1: the pages at a height both providers passed ----

test("M1: a landed send whose pages the lower provider has not reached stays pending, never failed; U is not struck and moves on", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault", "refused_by_vault", "lands"];
  ok(await w.carry(next(w)));
  ok(await w.carry(next(w)));
  w.chain.pagesLag = 1; // the third send lands; the read after it is short of its block
  const third = next(w);
  const h = ok(await w.carry(third));
  assert.deepEqual([rec(w).failed, rec(w).struck, rec(w).sends[2]!.state], [2, false, "pending"]);
  assert.equal(code(await w.carry(next(w))), "p_used"); // check 6: the pages hold P
  ok(await w.carry(next(w, P + 1n))); // R2's move settles it as landed
  assert.deepEqual([rec(w).p, rec(w).struck], [(P + 1n).toString(), false]);
  assert.ok(w.chain.resolved.includes(h));
  assert.equal(ok(await w.carry(third)), h);
});

test("M1: createSendReads.depositSettled answers unknown until both finals pass the height, then reads the pages", async () => {
  const row = { index: 0, precommitment: "77", label: "0", value: "5", leaf_index: 0, depositor: "a".repeat(64) };
  let lowFinal = 1007;
  const mk = (high: boolean): Rpc => async (method, params) => {
    if (method === "block") return { header: { height: high ? 1011 : lowFinal } };
    const q = params as { block_id: number };
    return { result: [...Buffer.from(JSON.stringify(q.block_id >= 1009 ? [row] : []))] };
  };
  const reads = createSendReads([mk(true), mk(false)], { vault: VAULT, token: VAULT_TOKEN }, 50);
  assert.deepEqual(await reads.depositSettled(77n, 1009n), { state: "unknown" });
  lowFinal = 1009;
  assert.deepEqual(await reads.depositSettled(77n, 1009n), { state: "held", depositor: row.depositor, value: 5n });
  assert.deepEqual(await reads.depositSettled(78n, 1009n), { state: "absent" });
});

test("PROBE N5: depositSettled reads the pages at the height that passed, though the lower provider then answers a lower final", async () => {
  const row = { index: 0, precommitment: "77", label: "0", value: "5", leaf_index: 0, depositor: "a".repeat(64) };
  let lowAsks = 0;
  const mk = (high: boolean): Rpc => async (method, params) => {
    if (method === "block") return { header: { height: high ? 1011 : lowAsks++ === 0 ? 1011 : 1007 } }; // a load balancer
    return { result: [...Buffer.from(JSON.stringify((params as { block_id: number }).block_id >= 1009 ? [row] : []))] };
  };
  const reads = createSendReads([mk(true), mk(false)], { vault: VAULT, token: VAULT_TOKEN }, 50);
  assert.deepEqual(await reads.depositSettled(77n, 1009n), { state: "held", depositor: row.depositor, value: 5n });
});

test("createSendReads: two providers that disagree are refused; finalHeight is the lower, newestFinalHeight the higher", async () => {
  const mk = (final: number, balance: string): Rpc => async (method) => {
    if (method === "block") return { header: { height: final } };
    return { result: [...Buffer.from(JSON.stringify(balance))] };
  };
  const reads = createSendReads([mk(1011, "5"), mk(1007, "6")], { vault: VAULT, token: VAULT_TOKEN });
  await assert.rejects(reads.ftBalance("a.near"), /disagree/);
  assert.equal(await reads.finalHeight(), 1007n);
  assert.equal(await reads.newestFinalHeight(), 1011n);
  const flip = createSendReads([mk(1007, "5"), mk(1011, "5")], { vault: VAULT, token: VAULT_TOKEN });
  assert.deepEqual([await flip.finalHeight(), await flip.newestFinalHeight(), await flip.ftBalance("a.near")], [1007n, 1011n, 5n]);
});

test("createSendReads: the deposits index read twice at once skips no row (sandbox case c: a landed deposit was read as a failed send)", async () => {
  const rows = [1n, 2n, 3n].map((p, i) => ({ index: i, precommitment: p.toString(), label: "0", value: "5", leaf_index: i, depositor: "a.near" }));
  const rpc: Rpc = async (method, params) => {
    if (method === "block") return { header: { height: 50 } };
    const q = params as { method_name: string; args_base64: string };
    assert.equal(q.method_name, "deposits");
    const { from, limit } = JSON.parse(Buffer.from(q.args_base64, "base64").toString()) as { from: number; limit: number };
    await new Promise((r) => setTimeout(r, 5));
    return { result: [...Buffer.from(JSON.stringify(rows.slice(from, from + limit)))] };
  };
  const reads = createSendReads([rpc, rpc], { vault: VAULT, token: VAULT_TOKEN });
  assert.deepEqual(await Promise.all([reads.pUsed(9n), reads.pUsed(9n)]), [false, false]);
  rows.push({ index: 3, precommitment: "9", label: "0", value: "5", leaf_index: 3, depositor: "u.near" });
  assert.deepEqual(await reads.deposit(9n), { depositor: "u.near", value: 5n });
});

// ---- M2: every transaction with no read outcome is settled from its stored bytes ----

test("M2: a prepay with no answer stays in the cap and holds (U, P) as in_flight; once it reads landed, nothing is prepaid again", async () => {
  const w = world();
  w.chain.prepayFates = ["unknown_lands", "lands"];
  assert.equal(code(await w.carry(next(w))), "in_flight");
  assert.deepEqual([rec(w).prepaid_bytes, rec(w).prepays[0]!.ok], [756, null]);
  ok(await w.carry(next(w)));
  assert.deepEqual([w.chain.prepays().length, rec(w).prepays[0]!.ok], [1, true]);
});

test("M2: a prepay that never went out is held while unknown, then rolled back once dropped, and prepaid once", async () => {
  const w = world();
  w.chain.prepayFates = ["unknown", "lands"];
  assert.equal(code(await w.carry(next(w))), "in_flight");
  const h = rec(w).prepays[0]!.tx_hash;
  assert.equal(code(await w.carry(next(w))), "in_flight", "still unknown: held, never a second prepay");
  assert.equal(w.chain.prepays().length, 0);
  w.chain.resolveAs.set(h, { kind: "dropped", tx_hash: h, why: "Expired" });
  ok(await w.carry(next(w)));
  assert.deepEqual([w.chain.prepays().length, rec(w).prepaid_bytes, rec(w).prepays.length, rec(w).failed], [1, 756, 1, 0]);
});

test("M2: a prepay dropped at once is rolled back and goes again once; dropped twice, resign_needed, nothing counted", async () => {
  const w = world();
  w.chain.prepayFates = ["dropped", "lands"];
  ok(await w.carry(next(w)));
  assert.deepEqual([rec(w).prepaid_bytes, rec(w).prepays.length, rec(w).failed, w.chain.prepays().length], [756, 1, 0, 1]);
  const v = world();
  v.chain.prepayFates = ["dropped", "dropped", "lands"];
  assert.equal(code(await v.carry(next(v))), "resign_needed");
  assert.deepEqual([rec(v).prepaid_bytes, rec(v).prepays.length, rec(v).failed, v.chain.sends().length], [0, 0, 0, 0]);
});

test("PROBE N8 (carry side): an open send is re-sent only while its delegate is K or more ahead, and is gone once past it", async () => {
  const w = world();
  w.chain.fates = ["unknown", "lands"];
  ok(await w.carry(next(w)));
  const mbh = BigInt(rec(w).sends[0]!.max_block_height);
  for (const [final, want] of [[mbh - 20n, { resend: true, gone: false }], [mbh - 19n, { resend: false, gone: false }], [mbh, { resend: false, gone: true }]] as const) {
    w.chain.final = final;
    w.chain.resolveOpts = [];
    assert.equal(code(await w.carry(signed(w.u, P, 101n, final + 100n))), "in_flight");
    assert.deepEqual(w.chain.resolveOpts, [want]);
  }
});

test("M2: a prepay that failed on chain, read only on the next call, counts once and is rolled back before the next prepay", async () => {
  const w = world();
  w.chain.prepayFates = ["unknown", "lands"];
  assert.equal(code(await w.carry(next(w))), "in_flight");
  const h = rec(w).prepays[0]!.tx_hash;
  w.chain.resolveAs.set(h, { kind: "final", tx_hash: h, receipts: [{ executor: VAULT, ok: false, failure: "x", height: w.chain.final }] });
  ok(await w.carry(next(w)));
  assert.deepEqual([rec(w).failed, rec(w).prepays[0]!.ok, rec(w).prepaid_bytes], [1, false, 756]);
});

test("M2: a send with no answer stays pending and counted; R2's move settles it from its stored bytes", async () => {
  const w = world();
  w.chain.fates = ["unknown_lands"];
  const h = ok(await w.carry(next(w)));
  assert.deepEqual([rec(w).sends[0]!.state, rec(w).sends[0]!.counted, rec(w).failed], ["pending", true, 0]);
  ok(await w.carry(next(w, P + 1n)));
  assert.ok(w.chain.resolved.includes(h));
  assert.equal(rec(w).p, (P + 1n).toString());
});

test("R2's move reads the old P's open send first: a third failure there strikes U, and nothing goes on the new P", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault", "refused_by_vault", "unknown"];
  ok(await w.carry(next(w)));
  ok(await w.carry(next(w)));
  const h = ok(await w.carry(next(w)));
  w.chain.pages.set(P.toString(), { depositor: "stranger.near", value: AMOUNT }); // a stranger's deposit names P
  w.chain.resolveAs.set(h, { kind: "final", tx_hash: h, receipts: [{ executor: VAULT, ok: false, failure: "refused", height: w.chain.final }] });
  const n = w.chain.txs.length;
  assert.equal(code(await w.carry(next(w, P + 1n))), "sender_struck");
  assert.deepEqual([w.chain.txs.length, rec(w).struck, rec(w).p], [n, true, P.toString()]);
});

test("M2: a send with no answer later read as dropped is not counted, and the same P goes again", async () => {
  const w = world();
  w.chain.fates = ["unknown", "lands"];
  const h = ok(await w.carry(next(w)));
  w.chain.resolveAs.set(h, { kind: "dropped", tx_hash: h, why: "the key nonce passed it" });
  ok(await w.carry(next(w)));
  assert.deepEqual([rec(w).sends[0]!.state, rec(w).failed, rec(w).landed, w.chain.prepays().length], ["dropped", 0, true, 1]);
});

test("M2: while a send of (U, P) is unknown, a call for P is in_flight and one for another P is prepay_open, even with P in the pages", async () => {
  const w = world();
  w.chain.fates = ["unknown"];
  ok(await w.carry(next(w)));
  assert.equal(code(await w.carry(next(w))), "in_flight");
  w.chain.pages.set(P.toString(), { depositor: "stranger.near", value: AMOUNT });
  assert.equal(code(await w.carry(next(w, P + 1n))), "prepay_open");
  assert.equal(rec(w).p, P.toString());
});

test("R7: a prepay in flight at a crash counts toward the cap after the restart", async () => {
  const w = world();
  w.chain.prepayFates = ["crash"];
  await assert.rejects(w.carry(next(w)), /crash/);
  w.reopen();
  assert.deepEqual([rec(w).prepaid_bytes, rec(w).prepays.length, rec(w).prepays[0]!.ok], [756, 1, null]);
});

test("R3 after a crash: a third count written before the crash, its outcome never read, is settled before anything else goes", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault", "refused_by_vault", "crash"];
  ok(await w.carry(next(w)));
  ok(await w.carry(next(w)));
  await assert.rejects(w.carry(next(w)), /crash/);
  assert.deepEqual([rec(w).failed, rec(w).struck, rec(w).sends[2]!.state], [2, false, "pending"]);
  w.reopen();
  const n = w.chain.sends().length;
  const h = rec(w).sends[2]!.tx_hash;
  assert.equal(code(await w.carry(signed(w.u, P, w.chain.nonce.get(w.u.id)! + 1n, w.chain.final + 101n))), "in_flight");
  w.chain.resolveAs.set(h, { kind: "final", tx_hash: h, receipts: [{ executor: VAULT, ok: false, failure: "refused", height: w.chain.final }] });
  assert.equal(code(await w.carry(signed(w.u, P, w.chain.nonce.get(w.u.id)! + 1n, w.chain.final + 102n))), "sender_struck");
  assert.deepEqual([w.chain.sends().length, rec(w).struck], [n, true]);
});

// ---- R1, R2, relayer_low ----

test("R2: a new P for U only once the pages hold U's previous P; R1: a P prepaid for U is refused to another sender", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault", "lands"];
  ok(await w.carry(next(w)));
  assert.equal(code(await w.carry(next(w, P + 1n))), "prepay_open");
  const x = newKey();
  w.chain.nonce.set(x.id, 5n);
  w.chain.usdc.set(x.id, AMOUNT);
  assert.equal(code(await w.carry(signed(x, P, 6n, w.chain.final + 100n))), "p_bound");
  ok(await w.carry(next(w))); // lands
  ok(await w.carry(next(w, P + 1n)));
  assert.equal(rec(w).p, (P + 1n).toString());
});

test("R2 inside the slot: a ledger read that missed U's open P still gets prepay_open", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault"];
  ok(await w.carry(next(w)));
  const deposit = w.deps.reads.deposit;
  let asks = 0;
  w.deps.reads.deposit = async (p) => (asks++ === 0 ? { depositor: "x.near", value: 1n } : deposit(p)); // the ledger's openP is fooled once
  assert.equal(code(await w.carry(next(w, P + 1n))), "prepay_open");
  assert.equal(rec(w).p, P.toString());
});

test("R2: a front-run on U's P (a stranger's deposit names it) frees U for its next P", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault"];
  ok(await w.carry(next(w)));
  w.chain.pages.set(P.toString(), { depositor: "stranger.near", value: AMOUNT });
  ok(await w.carry(next(w, P + 1n)));
  assert.equal(rec(w).p, (P + 1n).toString());
});

test("R2: the checks' ledger writes nothing (openP runs outside U's slot)", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault"];
  ok(await w.carry(next(w)));
  const before = JSON.stringify(rec(w));
  w.chain.pages.set(P.toString(), { depositor: "stranger.near", value: AMOUNT });
  w.chain.statuses = [OPEN, HALTED]; // stop right after the checks
  w.chain.statusAsks = 0;
  assert.equal(code(await w.carry(next(w, P + 1n))), "token_halted");
  assert.equal(JSON.stringify(rec(w)), before);
});

test("R1 at once: two senders on one P, each past check 7 before either is bound: one is carried, the other gets p_bound", async () => {
  const w = world();
  const x = newKey();
  w.chain.nonce.set(x.id, 5n);
  w.chain.usdc.set(x.id, 10n * AMOUNT);
  const answers = await Promise.all([w.carry(next(w)), w.carry(signed(x, P, 6n, w.chain.final + 100n))]);
  assert.deepEqual(answers.map(code).sort(), ["ok", "p_bound"]);
  assert.equal(w.chain.prepays().length, 1);
});

test("relayer_low: under 0.310501 N (one send's gas at 1e9 bought up front plus a (U, P)'s worst, 0.010501 N) answers 503 and sends nothing", async () => {
  assert.equal(PER_P_WORST_YOCTO, ((9040n + 3n * 300n + 2n * 280n + 1n) * 10n ** 24n) / 10n ** 6n); // 0.00904 + 3 x 0.0003 + 2 x 0.0002805
  assert.equal(RELAYER_FLOOR_YOCTO, 310_501_000_000_000_000_000_000n);
  const w = world();
  w.chain.balance = RELAYER_FLOOR_YOCTO - 1n;
  const a = await w.carry(next(w));
  assert.deepEqual([a.status, code(a)], [503, "relayer_low"]);
  assert.deepEqual([w.chain.txs.length, w.store.get(w.u.id)], [0, null]);
  w.chain.balance = RELAYER_FLOOR_YOCTO;
  ok(await w.carry(next(w)));
});

test("a request that is not canonical base64 is refused at check 1 and never matches a carried call", async () => {
  const w = world();
  const req = next(w);
  ok(await w.carry(req));
  assert.equal(code(await w.carry({ signed_delegate: req.signed_delegate + "\n" })), "bad_shape");
  assert.equal(code(await w.carry({ signed_delegate: req.signed_delegate, x: 1 })), "bad_shape");
  // the same bytes in a non-canonical base64 (an unused low bit set before the padding) are not a re-send
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let padded = req.signed_delegate;
  for (const p of [P * 10n, P * 100n, P * 1000n]) {
    if (padded.endsWith("=")) break;
    padded = signed(w.u, p, w.chain.nonce.get(w.u.id)! + 1n, w.chain.final + 100n).signed_delegate;
  }
  assert.ok(padded.endsWith("="));
  if (padded !== req.signed_delegate) ok(await w.carry({ signed_delegate: padded }));
  const at = padded.indexOf("=") - 1;
  const loose = padded.slice(0, at) + B64[B64.indexOf(padded[at]!) + 1] + padded.slice(at + 1);
  assert.deepEqual(Buffer.from(loose, "base64"), Buffer.from(padded, "base64"));
  assert.equal(code(await w.carry({ signed_delegate: loose })), "bad_shape");
});


// ---- M3, M4: the store ----

const emptyRecord = (u: string) => ({ u, p: "1", prepaid_bytes: 0, failed: 0, struck: false, landed: false, p_closed: false, prepays: [], sends: [], carried: [] });
/** A child process that opens the store on `dir`, writes `won` or `lost` to `dir/<tag>`, then holds it `holdMs`. */
function storeChild(dir: string, tag: string, holdMs: number) {
  const src = `
    import { writeFileSync } from "node:fs";
    import { createFileStore } from ${JSON.stringify(new URL("./send.ts", import.meta.url).href)};
    let out = "won";
    try { createFileStore(${JSON.stringify(dir)}); } catch (e) { out = "lost " + e.message; }
    writeFileSync(${JSON.stringify(dir)} + "/" + ${JSON.stringify(tag)}, out);
    setTimeout(() => {}, ${holdMs});`;
  return spawn(process.execPath, ["--input-type=module", "-e", src], { stdio: "ignore" });
}
const exited = (c: ReturnType<typeof spawn>) => new Promise((r) => c.on("exit", r));
const until = async (f: () => boolean) => {
  for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 25));
};

test("M3: one process per store: a second open is refused while the first holds it, and opens after close", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-lock-"));
  const a = createFileStore(dir);
  assert.throws(() => createFileStore(dir), /is held by another process/);
  a.close();
  const c = createFileStore(dir);
  c.close();
  assert.throws(() => c.put(emptyRecord("ab".repeat(32))), /closed/);
});

test("PROBE N2: a holder killed with SIGKILL leaves no stale lock: the next start (any PID, PID 1 again in a container) opens the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-kill-"));
  const child = storeChild(dir, "first", 60_000);
  await until(() => existsSync(join(dir, "first")));
  assert.equal(readFileSync(join(dir, "first"), "utf8"), "won");
  assert.throws(() => createFileStore(dir), /is held by another process/);
  child.kill("SIGKILL");
  await exited(child);
  createFileStore(dir).close();
});

test("PROBE N3: starts at the same moment leave exactly one holder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-race-"));
  const kids = ["a", "b", "c", "d"].map((t) => storeChild(dir, t, 1_500));
  await until(() => ["a", "b", "c", "d"].every((t) => existsSync(join(dir, t))));
  const outs = ["a", "b", "c", "d"].map((t) => readFileSync(join(dir, t), "utf8"));
  assert.equal(outs.filter((o) => o === "won").length, 1, outs.join(" | "));
  await Promise.all(kids.map(exited));
});

test("a start that meets a holder in its last moments (a restart overlapping the old process's exit) waits it out and opens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-overlap-"));
  const child = storeChild(dir, "old", 100);
  while (!existsSync(join(dir, "old"))) await new Promise((r) => setTimeout(r, 1));
  assert.equal(readFileSync(join(dir, "old"), "utf8"), "won");
  createFileStore(dir).close(); // the old holder lets go within the wait
  await exited(child);
});

test("PROBE N3, scheduled: B pauses right after any read of the lock while A takes the store; B resumes: still exactly one holder", async () => {
  // the review's interleaving (lockchild2.mjs): a start that reads the lock's contents and acts on them later can
  // remove a live holder's lock; a kernel lock has nothing to read, so the pause point never comes and A waits it out
  const dir = mkdtempSync(join(tmpdir(), "bind-race2-"));
  writeFileSync(join(dir, "lock"), "99990");
  const send = JSON.stringify(new URL("./send.ts", import.meta.url).href);
  const child = (role: "A" | "B") => `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const dir = ${JSON.stringify(dir)};
    const spin = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const waitFor = (f, ms) => { const t0 = Date.now(); while (!fs.existsSync(dir + "/" + f) && Date.now() - t0 < ms) spin(1); };
    if (${JSON.stringify(role)} === "B") {
      const orig = fs.readFileSync;
      fs.readFileSync = function (p, ...rest) {
        const v = orig.call(this, p, ...rest);
        if (String(p).endsWith("/lock") && !fs.existsSync(dir + "/b-read")) { fs.writeFileSync(dir + "/b-read", ""); waitFor("a-done", 5000); }
        return v;
      };
      syncBuiltinESMExports();
    }
    const { createFileStore } = await import(${send});
    if (${JSON.stringify(role)} === "A") waitFor("b-read", 1000);
    let out = "won";
    try { createFileStore(dir); } catch (e) { out = "lost"; }
    fs.writeFileSync(dir + "/" + ${JSON.stringify(role)} + "-" + out, "");
    if (${JSON.stringify(role)} === "A") fs.writeFileSync(dir + "/a-done", "");
    spin(1500);`;
  const kids = (["B", "A"] as const).map((r) => spawn(process.execPath, ["--input-type=module", "-e", child(r)], { stdio: "ignore" }));
  await Promise.all(kids.map(exited));
  assert.equal(readdirSync(dir).filter((f) => /^(A|B)-won$/.test(f)).length, 1, readdirSync(dir).join(" "));
});

test("PROBE N4: temps a crash left (any name) never block a start and are swept once the lock is held; temp names are random", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-tmp-"));
  writeFileSync(join(dir, `.tmp-${process.pid}-0`), "partial");
  writeFileSync(join(dir, ".tmp-1-0"), "{");
  const s = createFileStore(dir);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(".tmp")), []);
  const names: string[] = [];
  const spy = createFileStore(mkdtempSync(join(tmpdir(), "bind-tmpname-")), { ...nodeFs, openSync: ((p: string, f: string) => (names.push(String(p)), nodeFs.openSync(p, f))) as typeof nodeFs.openSync });
  spy.put(emptyRecord("ab".repeat(32)));
  spy.put(emptyRecord("ab".repeat(32)));
  const tmps = names.filter((n) => n.includes(".tmp-"));
  assert.equal(tmps.length, 2);
  assert.ok(tmps.every((n) => /\.tmp-[0-9a-f]{32}$/.test(n)) && tmps[0] !== tmps[1]);
  s.close();
  spy.close();
});

test("M4: create-if-absent is temp write, fsync, close, link, unlink, fsync of the directory; a replace is temp write, fsync, rename, fsync of the directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-order-"));
  const calls: string[] = [];
  const name = (p: unknown) => (typeof p === "string" ? (p === dir ? "dir" : p.includes(".tmp-") ? "tmp" : p.slice(dir.length + 1).replace(/^(u|p)-.*/, "$1")) : "fd");
  const rec = (fn: string, f: (...a: never[]) => unknown) => (...a: unknown[]) => {
    calls.push(`${fn} ${name(a[0])}${fn === "linkSync" || fn === "renameSync" ? " " + name(a[1]) : ""}`);
    return (f as (...a: unknown[]) => unknown)(...a);
  };
  const fs = Object.fromEntries((["closeSync", "fsyncSync", "linkSync", "openSync", "renameSync", "unlinkSync", "writeSync"] as const).map((k) => [k, rec(k, nodeFs[k] as never)]));
  const s = createFileStore(dir, { ...nodeFs, ...fs } as StoreFs);
  const u = "ab".repeat(32);
  const want = (end: string[]) => ["openSync tmp", "writeSync fd", "fsyncSync fd", "closeSync fd", ...end, "openSync dir", "fsyncSync fd", "closeSync fd"];
  calls.length = 0;
  assert.equal(s.create(emptyRecord(u)).created, true);
  assert.deepEqual(calls, want(["linkSync tmp u", "unlinkSync tmp"]));
  calls.length = 0;
  assert.equal(s.create(emptyRecord(u)).created, false);
  assert.deepEqual(calls, want(["linkSync tmp u", "unlinkSync tmp"]), "EEXIST: the temp unlinked, the directory synced");
  assert.equal(s.get(u)!.p, "1");
  calls.length = 0;
  s.put({ ...emptyRecord(u), p: "2" });
  assert.deepEqual(calls, want(["renameSync tmp u"]));
  calls.length = 0;
  assert.equal(s.bind(5n, u), u);
  assert.deepEqual(calls, want(["linkSync tmp p", "unlinkSync tmp"]));
  assert.equal(s.bind(5n, "cd".repeat(32)), u);
  s.close();
});

// ---- the relayer on fake providers that answer as nearcore does ----
// send_tx with wait_until NONE validates the transaction and answers a refusal as INVALID_TRANSACTION, the
// InvalidTxError in `data` (near-jsonrpc-primitives 0.37.4 types/transactions.rs, From<RpcTransactionError>);
// broadcast_tx_async answers only a hash (near-jsonrpc-client 0.22.0, its error type has no variant). A transaction is included after landMs if its nonce is still above the key's, else dropped silently. `tx`
// answers UNKNOWN_TRANSACTION for a hash it has not seen, and a regular provider forgets after its garbage collection.

function relayerSecret(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const j = privateKey.export({ format: "jwk" });
  return "ed25519:" + base58(Buffer.concat([Buffer.from(j.d as string, "base64url"), Buffer.from(j.x as string, "base64url")]));
}
type ParsedTx = { hash: string; nonce: bigint; blockHash: string } & ({ action: 2; precommitment: string; bytes: bigint } | { action: 8; delegate: ReturnType<typeof decodeSignedDelegate> });
function parseTx(b64: string): ParsedTx {
  const b = Buffer.from(b64, "base64");
  let i = 0;
  const s = () => {
    const n = b.readUInt32LE(i);
    i += 4;
    const v = b.subarray(i, i + n);
    i += n;
    return v;
  };
  s();
  i += 33;
  const nonce = b.readBigUInt64LE(i);
  i += 8;
  s();
  const blockHash = base58(b.subarray(i, i + 32));
  i += 32 + 4;
  const tag = b[i++]!;
  const hash = base58(createHash("sha256").update(b.subarray(0, b.length - 65)).digest());
  if (tag === 2) {
    s();
    const args = JSON.parse(s().toString()) as { precommitment: string };
    i += 8;
    let dep = 0n;
    for (let k = 15; k >= 0; k--) dep = (dep << 8n) | BigInt(b[i + k]!);
    return { hash, nonce, blockHash, action: 2, precommitment: args.precommitment, bytes: dep / 10n ** 19n };
  }
  return { hash, nonce, blockHash, action: 8, delegate: decodeSignedDelegate(new Uint8Array(b.subarray(i, b.length - 65))) };
}
const invalidTx = (err: unknown) => new RpcError("send_tx", { code: -32000, name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION" }, data: { TxExecutionError: { InvalidTxError: err } } });

/** One ledger behind two regular providers and an archival one. */
class Node {
  final = 1_000n;
  keyNonce = 10n;
  userNonce = new Map<string, bigint>();
  usdc = new Map<string, bigint>();
  pages = new Map<string, { depositor: string; value: bigint }>();
  prepaid = new Map<string, bigint>();
  blocks = new Map<string, bigint>();
  landed = new Map<string, unknown>();
  /** what the regular providers have forgotten (garbage collection) */
  forgotten = new Set<string>();
  log: { hash: string; kind: string; nonce: bigint; dropped?: string; expired?: boolean }[] = [];
  sent: bigint[] = [];
  landMs: (tx: ParsedTx) => number = () => 1;
  /** provider i (2: archival) fails this method with this error */
  fail?: (i: number, method: string, tx?: ParsedTx) => unknown;
  /** send_tx answers Expired (the block hash is past the validity window) */
  expired = false;
  bh(h: bigint) {
    const hash = base58(createHash("sha256").update(`b${h}`).digest());
    this.blocks.set(hash, h);
    return hash;
  }
  user(): Key {
    const k = newKey();
    this.userNonce.set(k.id, 100n);
    this.usdc.set(k.id, 10n * AMOUNT);
    return k;
  }
  private land(tx: ParsedTx) {
    if (this.landed.has(tx.hash)) return;
    if (tx.nonce <= this.keyNonce) {
      this.log.push({ hash: tx.hash, kind: tx.action === 2 ? "prepay" : "delegate", nonce: tx.nonce, dropped: "InvalidNonce" });
      return;
    }
    this.keyNonce = tx.nonce;
    const r = (executor: string, ok: boolean, failure = "") => {
      this.final += 1n;
      return { block_hash: this.bh(this.final), outcome: { executor_id: executor, status: ok ? { SuccessValue: "" } : { Failure: failure } } };
    };
    if (tx.action === 2) {
      this.prepaid.set(tx.precommitment, (this.prepaid.get(tx.precommitment) ?? 0n) + tx.bytes);
      this.landed.set(tx.hash, { final_execution_status: "FINAL", receipts_outcome: [r(VAULT, true), r(RELAYER, true)] });
      this.log.push({ hash: tx.hash, kind: "prepay", nonce: tx.nonce });
      return;
    }
    const d = tx.delegate;
    const expired = this.final + 1n > d.max_block_height;
    this.log.push({ hash: tx.hash, kind: "delegate", nonce: tx.nonce, expired });
    if (expired) {
      this.landed.set(tx.hash, { final_execution_status: "FINAL", receipts_outcome: [r(d.sender_id, false, '{"ActionError":{"kind":{"DelegateActionExpired":null}}}')] });
      return;
    }
    this.userNonce.set(d.sender_id, d.nonce);
    const msg = JSON.parse((JSON.parse(Buffer.from((d.actions[0] as { args: Uint8Array }).args).toString()) as { msg: string }).msg) as { precommitment: string };
    this.usdc.set(d.sender_id, this.usdc.get(d.sender_id)! - AMOUNT);
    const outcome = { final_execution_status: "FINAL", receipts_outcome: [r(d.sender_id, true), r(VAULT_TOKEN, true), r(VAULT, true)] };
    this.pages.set(msg.precommitment, { depositor: d.sender_id, value: AMOUNT });
    this.landed.set(tx.hash, outcome);
  }
  private rpc(i: number): Rpc {
    return async (method, params) => {
      const tx = method === "send_tx" ? parseTx((params as { signed_tx_base64: string }).signed_tx_base64) : undefined;
      const err = this.fail?.(i, method, tx);
      if (err !== undefined) throw err;
      if (method === "query") {
        const q = params as { request_type: string };
        if (q.request_type === "view_access_key") return { nonce: Number(this.keyNonce), permission: "FullAccess" };
        if (q.request_type === "view_account") return { amount: (10n ** 24n).toString() };
      }
      if (method === "block") {
        const p = params as { block_id?: string };
        if (p.block_id !== undefined) return { header: { height: Number(this.blocks.get(p.block_id) ?? 0n), hash: p.block_id } };
        return { header: { height: Number(this.final), hash: this.bh(this.final) } };
      }
      if (method === "send_tx") {
        assert.equal((params as { wait_until: string }).wait_until, "NONE");
        if (this.landed.has(tx!.hash)) return { final_execution_status: "NONE" };
        if (this.expired) throw invalidTx("Expired");
        if (tx!.nonce <= this.keyNonce) throw invalidTx({ InvalidNonce: { tx_nonce: Number(tx!.nonce), ak_nonce: Number(this.keyNonce) } });
        if (!this.sent.includes(tx!.nonce)) this.sent.push(tx!.nonce);
        setTimeout(() => this.land(tx!), this.landMs(tx!));
        return { final_execution_status: "NONE" };
      }
      if (method === "broadcast_tx_async") {
        // a hash and nothing else: an invalid transaction is dropped silently
        const t = parseTx((params as string[])[0]!);
        if (!this.landed.has(t.hash)) setTimeout(() => this.land(t), this.landMs(t));
        return t.hash;
      }
      if (method === "tx") {
        const h = (params as { tx_hash: string }).tx_hash;
        if (!this.landed.has(h) || (i < 2 && this.forgotten.has(h))) throw new RpcError("tx", { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } });
        return this.landed.get(h);
      }
      throw new Error(`node: ${method}`);
    };
  }
  rpcs = (): [Rpc, Rpc] => [this.rpc(0), this.rpc(1)];
  archival = (): Rpc => this.rpc(2);
  relayer = (waitMs = 1_000) => createRelayer(this.rpcs(), this.archival(), RELAYER, relayerSecret(), VAULT, waitMs);
  reads(): SendReads {
    return {
      accessKey: async (a): Promise<KeyRead> => (this.userNonce.has(a) ? { kind: "key", permission: "FullAccess", nonce: this.userNonce.get(a)! } : { kind: "no_account" }),
      finalHeight: async () => this.final,
      newestFinalHeight: async () => this.final,
      ftBalance: async (a) => this.usdc.get(a) ?? 0n,
      pUsed: async (p) => this.pages.has(p.toString()),
      deposit: async (p) => this.pages.get(p.toString()) ?? null,
      depositSettled: async (p, h) => {
        if (this.final < h) return { state: "unknown" };
        const row = this.pages.get(p.toString());
        return row === undefined ? { state: "absent" } : { state: "held", ...row };
      },
      trees: async () => ({ state: 5n, label: 5n }),
    };
  }
  deps(store: DepositStore, relayer: Relayer): SendDeps {
    return {
      cfg: { vault: VAULT, token: VAULT_TOKEN, marginK: 20n },
      reads: this.reads(),
      store,
      relayer,
      tokenStatus: async () => ({ ...OPEN, block_height: Number(this.final) }),
      pausedAt: async () => false,
    };
  }
}
const prepayAction = (p: bigint): RelayerAction => ({ kind: "storage_prepay", precommitment: p, bytes: 756n });
const open = async () => null;
const keep = (into: TxRef[]) => (t: TxRef) => void into.push(t);
const noResend = { resend: false, gone: false };
const resend = { resend: true, gone: false };
const newStore = () => createFileStore(mkdtempSync(join(tmpdir(), "bind-node-")));

test("PROBE N1: the key's nonce jumps (key re-added); send_tx's InvalidNonce re-reads it, the refused prepay goes again at once, and every later call lands", async () => {
  const node = new Node();
  const store = newStore();
  const deps = node.deps(store, node.relayer(300));
  const u0 = node.user();
  ok(await carryDeposit(signed(u0, P, 101n, node.final + 100n), deps));
  node.keyNonce += 1_000_000n; // AddKey sets a key's nonce to the block height x 1,000,000
  const answers: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const u = node.user();
    answers.push(code(await carryDeposit(signed(u, P + BigInt(i), 101n, node.final + 100n), deps)));
  }
  assert.deepEqual(answers, ["ok", "ok", "ok", "ok", "ok"]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(node.log.filter((x) => x.dropped !== undefined).length, 0, "nothing silently dropped");
  assert.equal(node.prepaid.size, 6);
  store.close();
});

test("PROBE N8: a send that reached no node is not re-sent once its delegate is within K; past its max_block_height it settles dropped, uncounted, and the new call lands", async () => {
  const node = new Node();
  const u = node.user();
  let down = true;
  node.fail = (i, m, tx) => (down && i < 2 && m === "send_tx" && tx?.action === 8 ? new Error("fetch failed") : undefined);
  const store = newStore();
  const deps = node.deps(store, node.relayer(300));
  assert.equal(code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps)), "ok");
  assert.equal(store.get(u.id)!.sends[0]!.state, "pending");
  down = false;
  node.final += 200n; // the device waits out D1's max_block_height and signs D2 for the same P
  assert.equal(code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps)), "ok");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(node.log.filter((x) => x.kind === "delegate" && x.expired).length, 0, "D1 never went out past its window");
  const r = store.get(u.id)!;
  assert.deepEqual([r.sends.map((x) => x.state), r.failed, r.landed], [["dropped", "landed"], 0, true]);
  store.close();
});

test("H1: the queue is released at the send, not at FINAL: a second transaction goes out while the first waits, with the next nonce", async () => {
  const node = new Node();
  let first = "";
  node.landMs = (tx) => (tx.hash === first ? 300 : 400); // included in nonce order, as the pool orders one key's
  const r = node.relayer(3_000);
  const order: string[] = [];
  const a = r.send(prepayAction(1n), open, (tx) => {
    first = tx.tx_hash;
    order.push(`a ${tx.nonce}`);
  });
  let landedAtB = -1;
  const b = r.send(prepayAction(2n), open, (tx) => {
    landedAtB = node.landed.size;
    order.push(`b ${tx.nonce}`);
  });
  const [outA, outB] = await Promise.all([a, b]);
  assert.deepEqual([outA.kind, outB.kind], ["final", "final"]);
  assert.equal(landedAtB, 0, "b signed before a landed");
  assert.deepEqual(order, ["a 11", "b 12"]);
});

test("H1: the guard runs in the queue right before signing; a guarded call signs, writes and sends nothing", async () => {
  const node = new Node();
  const r = node.relayer();
  const wrote: TxRef[] = [];
  const out = await r.send(prepayAction(1n), async () => "resign_needed", keep(wrote));
  assert.deepEqual([out.kind, (out as { code: string }).code, wrote.length, node.sent.length], ["guarded", "resign_needed", 0, 0]);
  await r.send(prepayAction(2n), open, keep(wrote));
  assert.equal(wrote[0]!.nonce, "11", "a guarded call uses no nonce");
});

test("the durable write comes before the send: a write that fails sends nothing", async () => {
  const node = new Node();
  const r = node.relayer();
  await assert.rejects(
    r.send(prepayAction(1n), open, () => {
      throw new Error("ENOSPC");
    }),
    /ENOSPC/,
  );
  assert.equal(node.sent.length, 0);
});

test("nonces: transactions in flight at once get distinct nonces; a refused one is dropped and the next reads the key again", async () => {
  const node = new Node();
  node.landMs = () => 50;
  const r = node.relayer();
  const outs = await Promise.all([1n, 2n, 3n].map((p) => r.send(prepayAction(p), open, () => undefined)));
  assert.deepEqual(outs.map((o) => o.kind), ["final", "final", "final"]);
  assert.deepEqual(node.sent, [11n, 12n, 13n]);
  node.keyNonce = 40n;
  const refused = await r.send(prepayAction(4n), open, () => undefined);
  assert.deepEqual([refused.kind, (refused as { why: string }).why], ["dropped", "the key nonce passed it"]);
  const again: TxRef[] = [];
  assert.equal((await r.send(prepayAction(5n), open, keep(again))).kind, "final");
  assert.equal(again[0]!.nonce, "41");
});

test("an InvalidNonce re-reads the key before the next transaction in the queue: the call queued behind the refused one is signed above the key", async () => {
  const node = new Node();
  node.landMs = () => 50;
  const r = node.relayer(500);
  assert.equal((await r.send(prepayAction(1n), open, () => undefined)).kind, "final");
  node.keyNonce = 40n; // the key moved after the relayer read it
  const tx: TxRef[] = [];
  const [a, b] = await Promise.all([r.send(prepayAction(2n), open, keep(tx)), r.send(prepayAction(3n), open, keep(tx))]);
  assert.deepEqual([a.kind, b.kind], ["dropped", "final"]);
  assert.deepEqual(tx.map((x) => x.nonce), ["12", "41"]);
});

test("a drop read by resolve also re-reads the key for the next transaction", async () => {
  const node = new Node();
  let down = true;
  node.fail = (i, m) => (down && i < 2 && m === "send_tx" ? new Error("fetch failed") : undefined);
  const r = node.relayer(50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  node.keyNonce = 500n; // the key moved while ours never went out
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "dropped");
  down = false;
  const again: TxRef[] = [];
  assert.equal((await r.send(prepayAction(2n), open, keep(again))).kind, "final");
  assert.equal(again[0]!.nonce, "501");
});

test("PROBE E: one provider names the hash unknown past its nonce while the other cannot be read: unknown, never dropped", async () => {
  const node = new Node();
  let down = new Set<string>(["0:send_tx", "1:send_tx"]);
  node.fail = (i, m) => (down.has(`${i}:${m}`) ? new Error("fetch failed") : undefined);
  const r = node.relayer(50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  node.keyNonce = 11n;
  down = new Set(["0:send_tx", "1:send_tx", "1:query", "1:tx"]);
  assert.equal((await r.resolve(tx[0]!, resend)).kind, "unknown");
  down = new Set(["0:send_tx", "1:send_tx"]);
  assert.equal((await r.resolve(tx[0]!, resend)).kind, "dropped");
});

test("PROBE E, gone: a send whose delegate expired is still unknown while one regular provider cannot be read; dropped once both read it unknown", async () => {
  const node = new Node();
  let down = new Set<string>(["0:send_tx", "1:send_tx"]);
  node.fail = (i, m) => (down.has(`${i}:${m}`) ? new Error("fetch failed") : undefined);
  const r = node.relayer(50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  down = new Set(["0:send_tx", "1:send_tx", "1:query", "1:tx"]);
  assert.equal((await r.resolve(tx[0]!, { resend: false, gone: true })).kind, "unknown");
  down = new Set(["0:send_tx", "1:send_tx"]);
  assert.equal((await r.resolve(tx[0]!, { resend: false, gone: true })).kind, "dropped");
});

test("Low 4: a landed transaction a regular provider forgot (garbage collection) reads final from the archival one, never dropped", async () => {
  const node = new Node();
  const r = node.relayer();
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "final");
  node.forgotten.add(tx[0]!.tx_hash);
  node.keyNonce = 99n;
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "final");
  node.fail = (i) => (i === 2 ? new Error("fetch failed") : undefined);
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown", "no archival read: never dropped");
});

test("M2/E: one provider cannot take the send while the other does: the outcome is read, never rolled back on one word", async () => {
  const node = new Node();
  node.fail = (i, m) => (i === 0 && m === "send_tx" ? new Error("fetch failed") : undefined);
  const out = await node.relayer().send(prepayAction(1n), open, () => undefined);
  assert.equal(out.kind, "final");
  assert.equal(node.landed.size, 1);
});

test("M2/C: a send that reached no provider is unknown; resolve() sends the stored bytes again and reads it landed; resend false sends nothing", async () => {
  const node = new Node();
  let down = true;
  node.fail = (i, m) => (down && i < 2 && m === "send_tx" ? new Error("fetch failed") : undefined);
  const r = node.relayer(50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  down = false;
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown");
  assert.equal(node.sent.length, 0, "resend false: not sent");
  await r.resolve(tx[0]!, resend);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "final");
  assert.equal(node.landed.size, 1);
});

test("M2/C: dropped only on Expired, or the key nonce past the tx's on both providers, or gone; always with the hash unknown everywhere", async () => {
  const node = new Node();
  let down = true;
  node.fail = (i, m) => (down && i < 2 && m === "send_tx" ? new Error("fetch failed") : undefined);
  const r = node.relayer(50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown", "the key nonce is below the tx's");
  assert.deepEqual(await r.resolve(tx[0]!, { resend: false, gone: true }), { kind: "dropped", tx_hash: tx[0]!.tx_hash, why: "its delegate expired" });
  down = false;
  node.expired = true;
  assert.deepEqual(await r.resolve(tx[0]!, resend), { kind: "dropped", tx_hash: tx[0]!.tx_hash, why: "Expired" });
  node.expired = false;
  node.keyNonce = 11n;
  assert.deepEqual(await r.resolve(tx[0]!, noResend), { kind: "dropped", tx_hash: tx[0]!.tx_hash, why: "the key nonce passed it" });
  node.fail = (i, m) => (i === 2 && m === "tx" ? new Error("fetch failed") : undefined);
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown", "the archival provider unread: never dropped");
});

test("createRelayer refuses a key whose public half is not its seed's", () => {
  relayerKey(relayerSecret());
  const raw = base58decode(relayerSecret().slice(8));
  raw[63] = raw[63]! ^ 1;
  assert.throws(() => relayerKey("ed25519:" + base58(raw)), /public half/);
  const node = new Node();
  assert.throws(() => createRelayer(node.rpcs(), node.archival(), RELAYER, "ed25519:" + base58(raw), VAULT), /public half/);
});

test("the relayer's transaction: borsh Transaction V0 with the ed25519 key tag and one Delegate (tag 8) of the bytes as signed", async () => {
  const node = new Node();
  const tx: TxRef[] = [];
  const signedDelegate = Buffer.from(signed(node.user(), P, 101n, node.final + 100n).signed_delegate, "base64");
  await node.relayer().send({ kind: "delegate", signed: signedDelegate, receiver: "ab".repeat(32) }, open, keep(tx));
  const b = Buffer.from(tx[0]!.signed_tx, "base64");
  let i = 4 + b.readUInt32LE(0);
  assert.equal(b.subarray(4, i).toString(), RELAYER);
  assert.equal(b[i], 0, "ed25519 key tag");
  assert.equal(b.readBigUInt64LE(i + 33), 11n);
  i += 33 + 8;
  const rl = b.readUInt32LE(i);
  assert.equal(b.subarray(i + 4, i + 4 + rl).toString(), "ab".repeat(32));
  i += 4 + rl + 32;
  assert.equal(b.readUInt32LE(i), 1);
  assert.equal(b[i + 4], 8, "Action::Delegate");
  assert.deepEqual(b.subarray(i + 5, b.length - 65), signedDelegate);
  assert.equal(b[b.length - 65], 0, "ed25519 signature tag");
  assert.equal(tx[0]!.tx_hash, base58(createHash("sha256").update(b.subarray(0, b.length - 65)).digest()));
});

test("a receipt that ran with SuccessReceiptId is ok, a Failure is not; each receipt's height is its block's", async () => {
  const node = new Node();
  const outcomes = [
    { block_hash: "x", outcome: { executor_id: "u", status: { SuccessReceiptId: "r" } } },
    { block_hash: "y", outcome: { executor_id: VAULT, status: { Failure: { ActionError: {} } } } },
  ];
  const [r0, r1] = node.rpcs();
  const over: Rpc = async (m, p) => (m === "tx" ? { final_execution_status: "FINAL", receipts_outcome: outcomes } : m === "block" && (p as { block_id?: string }).block_id === "y" ? { header: { height: 7777 } } : r0(m, p));
  const r = createRelayer([over, r1], node.archival(), RELAYER, relayerSecret(), VAULT, 1_000);
  const out = await r.send(prepayAction(1n), open, () => undefined);
  assert.equal(out.kind, "final");
  const rs = (out as { receipts: Receipt[] }).receipts;
  assert.deepEqual(rs.map((x) => [x.ok, x.executor]), [[true, "u"], [false, VAULT]]);
  assert.equal(rs[1]!.height, 7777n);
  assert.match(rs[1]!.failure, /ActionError/);
});

test("base58decode inverts the checks' base58", () => {
  const b = createHash("sha256").update("x").digest();
  assert.deepEqual(Buffer.from(base58decode(base58(b))), b);
  assert.deepEqual(Buffer.from(base58decode("11" + base58(Buffer.from([1, 2])))), Buffer.from([0, 0, 1, 2]));
});
