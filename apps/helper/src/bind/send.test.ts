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
  OUTCOME_WAIT_MS,
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
  remember,
  CACHE_MAX,
  lockRound,
  receiptIdOf,
  startLockRounds,
  startRelayer,
  transactionValidityPeriod,
  type Answer,
  type DepositStore,
  type Receipt,
  type Relayer,
  type RelayerStore,
  type RelayerAction,
  type Rpc,
  type SendDeps,
  type SendReads,
  type Settled,
  type StoreFs,
  type TxOutcome,
  type TxRef,
} from "./send.ts";
import { createTokenWatch, pausedFrom, USDC, USDC_CODE_HASH, type HoldAt, type TokenStatus } from "../token-status/status.ts";
import { A, B, hashOf, nearPair, PAUSED } from "../../test/token-status/near.ts";
import { watchDeps } from "./env.ts";

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
  /** Each hold's H rule as asked (status.ts HoldAt). */
  holds: HoldAt[] = [];
  /** The watch's answer for a height (status.ts pausedAt). */
  pausedAt: (height: bigint) => boolean | null | Promise<boolean | null> = () => false;
  resolveOpts: { resend: boolean }[] = [];
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
      key: `${RELAYER}/ed25519:test`,
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
        before({ tx_hash: hash, nonce: String(this.relayerNonce++), height: this.final.toString(), block_hash: "11111111111111111111111111111111", signed_tx: "c2lnbmVk" });
        await this.during?.();
        const fate = action.kind === "storage_prepay" ? this.next(this.prepayFates) : this.next(this.fates);
        if (fate === "crash") throw new Error("crash after the durable write");
        if (fate === "dropped") return { kind: "dropped", tx_hash: hash, why: "past its validity period" };
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
      tokenStatus: async (at) => {
        this.holds.push(at);
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

test("R4 after (f): a hold that waits at the send's turn while the final passes the margin answers resign_needed, nothing sent; and a re-send the same way", async () => {
  const w = world();
  const real = w.deps.relayer.send;
  const hold = w.deps.tokenStatus;
  let queued = false;
  w.deps.relayer.send = async (action, guard, before) => {
    queued = action.kind === "delegate";
    return real(action, guard, before);
  };
  w.deps.tokenStatus = async (at) => {
    if (queued) w.chain.final += 200n; // the hold waited (a lagging provider, a 429) while the chain moved on
    return hold(at);
  };
  assert.equal(code(await w.carry(next(w))), "resign_needed");
  assert.deepEqual([w.chain.sends().length, rec(w).sends.length, rec(w).failed], [0, 0, 0]);
  // the settle's re-send: K ahead before the hold, under K after it: read, never re-sent
  const v = world();
  v.chain.fates = ["unknown", "lands"];
  ok(await v.carry(next(v)));
  const mbh = BigInt(rec(v).sends[0]!.max_block_height);
  v.chain.final = mbh - 20n; // K ahead
  const vh = v.deps.tokenStatus;
  v.deps.tokenStatus = async (at) => ((v.chain.final += 1n), vh(at)); // the hold waits a block
  v.chain.resolveOpts = [];
  await lockRound(v.deps); // the background round: the settle's own hold, then its margin
  assert.deepEqual(v.chain.resolveOpts, [{ resend: false }]);
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

test("(f) every hold of a deposit asks at the higher of the two finals (markets.md check 10's H for the ids' calls): before the checks, check 9, the prepay's and the send's turns, a re-send", async () => {
  const w = world();
  w.chain.fates = ["paused", "lands"];
  w.chain.pausedAt = () => null; // the paused send stays pending: the next call re-reads it under the hold
  ok(await w.carry(next(w)));
  await w.carry(next(w));
  assert.ok(w.chain.holds.length >= 5, String(w.chain.holds.length));
  assert.deepEqual([...new Set(w.chain.holds)], ["higher"]);
});

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

test("PROBE N6, by views: paused at the failure, unpaused two blocks later, then another pause: the views at the failure's block and the one before still say paused there, not counted", async () => {
  const w = world();
  w.chain.fates = ["paused"];
  let failAt = 0n;
  w.chain.pausedAt = (h) => {
    failAt = h;
    // the halt switches at h-3 (paused), h+2 (unpaused), h+9 (paused): only h-1 and h are read
    const open = (x: bigint) => !(x >= h - 3n && x < h + 2n) && x < h + 9n;
    const o = (x: bigint) => (open(x) ? { at: Number(x), answer: '"5"' } : { at: Number(x), panic: "FiatToken: paused" });
    return pausedFrom([o(h - 1n), o(h)], [o(h - 1n), o(h)]);
  };
  ok(await w.carry(next(w)));
  assert.ok(failAt > 0n);
  assert.deepEqual([rec(w).failed, rec(w).sends[0]!.state], [0, "exempt"]);
});

test("status.ts pausedFrom: paused at the block before or at the block; null unless all four reads are known and the providers agree", () => {
  const open = (at: number) => ({ at, answer: '"20000"' });
  const paused = (at: number) => ({ at, panic: "FiatToken: paused" });
  assert.equal(pausedFrom([open(9), open(10)], [open(9), open(10)]), false);
  assert.equal(pausedFrom([paused(9), open(10)], [paused(9), open(10)]), true, "paused before the block, unpaused in it: the receipt may have run before the unpause");
  assert.equal(pausedFrom([open(9), paused(10)], [open(9), paused(10)]), true, "paused in the block");
  assert.equal(pausedFrom([open(9), open(10)], [open(9), paused(10)]), null, "the providers disagree");
  assert.equal(pausedFrom([open(9), undefined], [open(9), open(10)]), null, "a read missing");
  assert.equal(pausedFrom([open(9), { at: 10, panic: "FiatToken: paused!" }], [open(9), open(10)]), null, "a panic that is not exactly USDC's");
  assert.equal(pausedFrom([open(9), { at: 10, answer: "null" }], [open(9), { at: 10, answer: "null" }]), null, "an answer that is not a balance");
  // named limit: a pause and an unpause inside one block read as open at both heights
  assert.equal(pausedFrom([open(9), open(10)], [open(9), open(10)]), false);
});

test("(i) through the network's own watch (env.ts watchDeps, status.ts pausedAt on two providers): a send that failed on USDC's paused error while USDC's views show it paused there is resolved exempt, and U is free again", async () => {
  const w = world();
  w.chain.fates = ["paused", "lands"];
  // two providers answering as nearcore does: USDC paused from the failure's block on, its code the pin
  const near = nearPair({ final: () => Number(w.chain.final) + 3, balance: (h) => (BigInt(h) >= w.chain.final ? { error: PAUSED } : '"5"') });
  const watch = createTokenWatch("mainnet", { NEAR_RPC_URL: A, NEAR_RPC_URL_B: B, BIND_VAULT_MAINNET: VAULT }, { fetch: near.fetch });
  const deps = watchDeps(watch, USDC);
  w.chain.pausedAt = (h) => deps.pausedAt(h);
  ok(await w.carry(next(w)));
  assert.deepEqual([rec(w).failed, rec(w).sends[0]!.state, rec(w).sends[0]!.counted], [0, "exempt", false], "resolved, not counted");
  const f = Number(w.chain.final);
  const [before, at] = [hashOf(f - 1), hashOf(f)];
  assert.deepEqual(
    [...new Set(near.seen.map((r) => `${r.url === A ? "A" : "B"} ${r.method === "block" ? "block" : String(r.params.method_name ?? r.params.request_type)} ${String(r.params.block_id)}`))].sort(),
    ["A", "B"].flatMap((p) => [`${p} block ${f}`, `${p} ft_balance_of ${before}`, `${p} ft_balance_of ${at}`, `${p} view_account ${before}`, `${p} view_account ${at}`]).sort(),
  );
  // U is free again: the next deposit from U is carried and lands (no in_flight on its P, no prepay_open for a new one)
  ok(await w.carry(next(w)));
  assert.equal(rec(w).landed, true);
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

test("RECHECK R3 (B): a delegate that ran past its max_block_height (DelegateActionExpired) counts: five re-signed rounds on one (U, P), each expiring after the guard passed, strike U after the third", async () => {
  const w = world();
  const real = w.deps.relayer.send;
  w.deps.relayer.send = async (action, guard, before) => {
    const out = await real(action, guard, before);
    // the guard passed (max_block_height - newest >= K); the Delegate receipt ran more than K blocks after it
    if (action.kind === "delegate" && out.kind === "final") return { ...out, receipts: [{ executor: w.u.id, ok: false, failure: '{"ActionError":{"index":0,"kind":"DelegateActionExpired"}}', height: w.chain.final }] };
    return out;
  };
  w.chain.fates = ["refused_by_vault"];
  const answers: string[] = [];
  for (let i = 0; i < 5; i++) answers.push(code(await w.carry(next(w))));
  assert.deepEqual(answers, ["ok", "ok", "ok", "sender_struck", "sender_struck"]);
  assert.deepEqual([rec(w).failed, rec(w).struck, rec(w).sends.map((x) => x.state).join(","), w.chain.sends().length], [3, true, "failed,failed,failed", 3]);
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
    const q = params as { block_id: number; args_base64: string };
    const { from } = JSON.parse(Buffer.from(q.args_base64, "base64").toString()) as { from: number };
    return { result: [...Buffer.from(JSON.stringify((q.block_id >= 1009 ? [row] : []).slice(from)))], block_height: q.block_id, block_hash: blockHashAt(q.block_id) };
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
    const q = params as { block_id: number; args_base64: string };
    const h = q.block_id;
    const { from } = JSON.parse(Buffer.from(q.args_base64, "base64").toString()) as { from: number };
    return { result: [...Buffer.from(JSON.stringify((h >= 1009 ? [row] : []).slice(from)))], block_height: h, block_hash: blockHashAt(h) };
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
    const q = params as { method_name: string; args_base64: string; block_id: number };
    assert.equal(q.method_name, "deposits");
    const { from, limit } = JSON.parse(Buffer.from(q.args_base64, "base64").toString()) as { from: number; limit: number };
    await new Promise((r) => setTimeout(r, 5));
    return { result: [...Buffer.from(JSON.stringify(rows.slice(from, from + limit)))], block_height: q.block_id, block_hash: blockHashAt(q.block_id) };
  };
  const reads = createSendReads([rpc, rpc], { vault: VAULT, token: VAULT_TOKEN });
  assert.deepEqual(await Promise.all([reads.pUsed(9n), reads.pUsed(9n)]), [false, false]);
  rows.push({ index: 3, precommitment: "9", label: "0", value: "5", leaf_index: 3, depositor: "u.near" });
  assert.deepEqual(await reads.deposit(9n), { depositor: "u.near", value: 5n });
});

test("createSendReads: a deposits page counts only at the block asked, with one block hash on both providers and each row at its index (near/pages.ts, the spends index's rule)", async () => {
  const rows = [{ index: 0, precommitment: "9", label: "0", value: "5", leaf_index: 0, depositor: "u.near" }];
  const mk = (o: { hash?: (h: number) => string; height?: (h: number) => number; rows?: unknown[] } = {}): Rpc => async (method, params) => {
    if (method === "block") return { header: { height: 50 } };
    const h = (params as { block_id: number }).block_id;
    return { result: [...Buffer.from(JSON.stringify(o.rows ?? rows))], block_height: (o.height ?? ((x) => x))(h), block_hash: (o.hash ?? blockHashAt)(h) };
  };
  const pUsed = (a: Rpc, b: Rpc) => createSendReads([a, b], { vault: VAULT, token: VAULT_TOKEN }).pUsed(9n);
  assert.equal(await pUsed(mk(), mk()), true);
  await assert.rejects(pUsed(mk(), mk({ hash: (h) => blockHashAt(h + 1_000_000) })), /different blocks/, "another hash at the same height");
  await assert.rejects(pUsed(mk({ height: (h) => h - 1 }), mk({ height: (h) => h - 1 })), /not answered at the block asked/, "both at the block before");
  await assert.rejects(pUsed(mk({ rows: [{ ...rows[0], index: 1 }] }), mk({ rows: [{ ...rows[0], index: 1 }] })), /not at its index/);
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
  w.chain.resolveAs.set(h, { kind: "dropped", tx_hash: h, why: "past its validity period" });
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

test("PROBE N8 (carry side): an open send is re-sent only while its delegate is K or more ahead; past it, it is still read, never re-sent", async () => {
  const w = world();
  w.chain.fates = ["unknown", "lands"];
  ok(await w.carry(next(w)));
  const mbh = BigInt(rec(w).sends[0]!.max_block_height);
  for (const [final, want] of [[mbh - 20n, { resend: true }], [mbh - 19n, { resend: false }], [mbh, { resend: false }]] as const) {
    w.chain.final = final;
    w.chain.resolveOpts = [];
    assert.equal(code(await w.carry(signed(w.u, P, 101n, final + 100n))), "in_flight");
    assert.deepEqual(w.chain.resolveOpts, [want]);
  }
  // R4 reads the newer provider's final: K ahead on the lower one but not on the newer is no re-send
  w.chain.final = mbh - 20n;
  w.chain.ahead = 1n;
  w.chain.resolveOpts = [];
  assert.equal(code(await w.carry(signed(w.u, P, 101n, w.chain.final + 100n))), "in_flight");
  assert.deepEqual(w.chain.resolveOpts, [{ resend: false }]);
});

test("C: (f) holds at a re-send: a watch that turns halted after check 9 keeps a pending prepay's and a pending send's bytes in", async () => {
  const w = world();
  w.chain.prepayFates = ["unknown"];
  assert.equal(code(await w.carry(next(w))), "in_flight");
  w.chain.statuses = [OPEN, OPEN, HALTED]; // before the checks, check 9, then the settle
  w.chain.statusAsks = 0;
  w.chain.resolveOpts = [];
  assert.equal(code(await w.carry(next(w))), "in_flight");
  assert.deepEqual(w.chain.resolveOpts, [{ resend: false }], "the prepay");
  const v = world();
  v.chain.fates = ["unknown"];
  ok(await v.carry(next(v)));
  v.chain.statuses = [OPEN, OPEN, HALTED];
  v.chain.statusAsks = 0;
  v.chain.resolveOpts = [];
  assert.equal(code(await v.carry(signed(v.u, P, 101n, v.chain.final + 100n))), "in_flight");
  assert.deepEqual(v.chain.resolveOpts, [{ resend: false }], "the send");
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

test("relayer_low: under 0.3302526 N (one send's gas at 1e9 bought up front plus A1's row-7 maximum, 0.0302526 N) answers 503 and sends nothing", async () => {
  const n7 = (x: bigint) => x * 10n ** 17n; // N with 7 decimals, in yocto
  assert.equal(PER_P_WORST_YOCTO, n7(90_400n) + 3n * n7(3_000n) + 2n * n7(101_563n)); // 0.00904 + 3 x 0.0003 + 2 x 0.0101563
  assert.equal(RELAYER_FLOOR_YOCTO, 330_252_600_000_000_000_000_000n);
  const w = world();
  w.chain.balance = RELAYER_FLOOR_YOCTO - 1n;
  const a = await w.carry(next(w));
  assert.deepEqual([a.status, code(a)], [503, "relayer_low"]);
  assert.deepEqual([w.chain.txs.length, w.store.get(w.u.id)], [0, null]);
  w.chain.balance = RELAYER_FLOOR_YOCTO;
  ok(await w.carry(next(w)));
});

test("F: a relayer at the floor still holds 0.3 N after a row-7 refusal (a 904 B prepay and a send that burns row 7's 0.0101563 N), and after A1's row-7 maximum", async () => {
  const n7 = (x: bigint) => x * 10n ** 17n;
  const w = world();
  w.chain.trees = { state: 4n, label: 4n }; // a tree grows: 904 B
  w.chain.fates = ["refused_by_vault"];
  w.chain.balance = RELAYER_FLOOR_YOCTO;
  const real = w.deps.relayer.send;
  w.deps.relayer.send = async (action, guard, before) => {
    const out = await real(action, guard, before);
    // what each transaction costs the gas account: a prepay its bytes and 0.0003 N of gas; a refused send row 7's burn
    if (out.kind !== "guarded") w.chain.balance -= action.kind === "storage_prepay" ? action.bytes * 10n ** 19n + n7(3_000n) : n7(101_563n);
    return out;
  };
  ok(await w.carry(next(w)));
  assert.deepEqual([rec(w).prepaid_bytes, rec(w).failed], [904, 1]);
  assert.ok(w.chain.balance >= 300_000_000_000_000n * 1_000_000_000n, `${w.chain.balance} yocto left`);
  assert.equal(RELAYER_FLOOR_YOCTO - PER_P_WORST_YOCTO, 300_000_000_000_000n * 1_000_000_000n, "A1's row-7 maximum leaves exactly 0.3 N");
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

/** A base58 block hash for height `h` (32 bytes), as nearcore names a block. */
const blockHashAt = (h: number) => base58(createHash("sha256").update(`block ${h}`).digest());
const emptyRecord = (u: string) => ({ u, p: "1", prepaid_bytes: 0, failed: 0, struck: false, landed: false, p_closed: false, prepays: [], sends: [], carried: [] });
/** How long a lock probe's child holds the store at most while it waits for the other children's results. */
const PROBE_HOLD_CAP_MS = 10_000;
/**
 * A child process that opens the store on `dir`, writes `won` or `lost` to `dir/<tag>` whole (`<tag>.part` renamed in,
 * so the file is never seen empty: CI run 41689364892 read `''` between a plain write's create and its bytes), then
 * holds it: `hold` ms; or, `{ until }`, until `dir/<until>` exists (at most PROBE_HOLD_CAP_MS), then exits; or, with
 * `peers`, until every peer has written its own result (at most PROBE_HOLD_CAP_MS), so two wins can only mean two
 * holders at once, never a start that came after a holder's exit on a slow runner.
 */
function storeChild(dir: string, tag: string, hold: number | { until: string }, peers?: string[]) {
  const src = `
    import { existsSync, renameSync, writeFileSync } from "node:fs";
    import { createFileStore } from ${JSON.stringify(new URL("./send.ts", import.meta.url).href)};
    const dir = ${JSON.stringify(dir)};
    let out = "won";
    try { globalThis.store = createFileStore(dir); } catch (e) { out = "lost " + e.message; } // kept for the hold
    // not a ".tmp-" name: a store's start sweeps those, and another child may be starting on this directory
    writeFileSync(dir + "/" + ${JSON.stringify(tag)} + ".part", out);
    renameSync(dir + "/" + ${JSON.stringify(tag)} + ".part", dir + "/" + ${JSON.stringify(tag)});
    const peers = ${JSON.stringify(peers ?? null)};
    const hold = ${JSON.stringify(hold)};
    const spin = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    if (peers !== null) for (const t0 = Date.now(); !peers.every((t) => existsSync(dir + "/" + t)) && Date.now() - t0 < ${PROBE_HOLD_CAP_MS}; ) await new Promise((r) => setTimeout(r, 5));
    else if (typeof hold === "number") setTimeout(() => {}, hold);
    else {
      for (const t0 = Date.now(); !existsSync(dir + "/" + hold.until) && Date.now() - t0 < ${PROBE_HOLD_CAP_MS}; ) spin(1);
      process.exit(0); // the lock goes with the process
    }`;
  return spawn(process.execPath, ["--input-type=module", "-e", src], { stdio: "ignore" });
}
const exited = (c: ReturnType<typeof spawn>) => new Promise((r) => c.on("exit", r));
const until = async (f: () => boolean) => {
  for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 25));
};

test("RC3 Low 2: a store nothing references any more keeps its lock through a full GC: a second process is still refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-gc-"));
  const src = `
    import { writeFileSync } from "node:fs";
    import { createFileStore } from ${JSON.stringify(new URL("./send.ts", import.meta.url).href)};
    createFileStore(${JSON.stringify(dir)}); // not kept
    globalThis.gc(); await new Promise((r) => setTimeout(r, 50)); globalThis.gc();
    writeFileSync(${JSON.stringify(dir)} + "/first", "won");
    setTimeout(() => {}, 5000);`;
  const c = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", src], { stdio: "ignore" });
  await until(() => existsSync(join(dir, "first")));
  assert.ok(existsSync(join(dir, "first")));
  assert.throws(() => createFileStore(dir), /is held by another process/);
  c.kill("SIGKILL");
  await exited(c);
});

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

test("E (RECHECK R6): the holder reading every other file of its store (records, bindings, the directory) keeps its lock; only the lock's own path may never be opened", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-reads-"));
  const u = "ab".repeat(32);
  const src = `
    import { writeFileSync, readFileSync, readdirSync } from "node:fs";
    import { createFileStore } from ${JSON.stringify(new URL("./send.ts", import.meta.url).href)};
    const dir = ${JSON.stringify(dir)};
    const s = createFileStore(dir);
    s.create(${JSON.stringify(emptyRecord(u))});
    s.bind(7n, ${JSON.stringify(u)});
    s.get(${JSON.stringify(u)}); s.boundTo(7n);
    for (const f of readdirSync(dir)) if (f !== "lock") readFileSync(dir + "/" + f);
    writeFileSync(dir + "/ready", "");
    setTimeout(() => s.close(), 5000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", src], { stdio: "ignore" });
  await until(() => existsSync(join(dir, "ready")));
  assert.ok(existsSync(join(dir, "ready")));
  assert.throws(() => createFileStore(dir), /is held by another process/);
  child.kill("SIGKILL");
  await exited(child);
});

test("PROBE N3: starts at the same moment leave exactly one holder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-race-"));
  const tags = ["a", "b", "c", "d"];
  const kids = tags.map((t) => storeChild(dir, t, 0, tags));
  const done = kids.map(exited); // listened from the start: a child may exit before the results are read
  await until(() => ["a", "b", "c", "d"].every((t) => existsSync(join(dir, t))));
  const outs = ["a", "b", "c", "d"].map((t) => readFileSync(join(dir, t), "utf8"));
  assert.equal(outs.filter((o) => o === "won").length, 1, outs.join(" | "));
  await Promise.all(done);
});

test("a start that meets a holder in its last moments (a restart overlapping the old process's exit) waits it out and opens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-overlap-"));
  const child = storeChild(dir, "old", { until: "go" });
  const gone = exited(child); // listened from the start
  await until(() => existsSync(join(dir, "old")));
  assert.equal(readFileSync(join(dir, "old"), "utf8"), "won");
  assert.throws(() => createFileStore(dir), /is held by another process/, "the old process holds the store until told to go");
  // the old process exits on this signal: the start below begins while it still holds and waits its exit out, so the
  // test waits on the holder's real exit, not a fixed time
  writeFileSync(join(dir, "go"), "");
  createFileStore(dir).close();
  assert.equal(await gone, 0, "the old process exited on its own");
});

test("planted: a start that meets a holder that does not let go within the wait refuses (a restart that cannot open is never passed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-overlap-held-"));
  const child = storeChild(dir, "old", { until: "go" });
  const gone = exited(child);
  await until(() => existsSync(join(dir, "old")));
  assert.equal(readFileSync(join(dir, "old"), "utf8"), "won");
  assert.throws(() => createFileStore(dir), /is held by another process/);
  assert.equal(child.exitCode, null, "the holder is still running");
  child.kill("SIGKILL");
  await gone;
});

/**
 * The review's interleaving (lockchild2.mjs): a start that reads the lock's contents and acts on them later can remove
 * a live holder's lock; a kernel lock has nothing to read, so B's pause point never comes and A waits it out. Each child
 * holds its store until the other has written its result (at most PROBE_HOLD_CAP_MS), so two wins mean two holders at
 * once. `aAfterBWonMs`: A starts that long after B has won (a slow runner), instead of after B's read of the lock.
 */
async function scheduledLockProbe(aAfterBWonMs?: number): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "bind-race2-"));
  writeFileSync(join(dir, "lock"), "99990");
  const send = JSON.stringify(new URL("./send.ts", import.meta.url).href);
  const child = (role: "A" | "B") => `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const dir = ${JSON.stringify(dir)};
    const spin = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const waitFor = (fs_, ms) => { const t0 = Date.now(); while (!fs_.some((f) => fs.existsSync(dir + "/" + f)) && Date.now() - t0 < ms) spin(1); };
    if (${JSON.stringify(role)} === "B") {
      const orig = fs.readFileSync;
      fs.readFileSync = function (p, ...rest) {
        const v = orig.call(this, p, ...rest);
        if (String(p).endsWith("/lock") && !fs.existsSync(dir + "/b-read")) { fs.writeFileSync(dir + "/b-read", ""); waitFor(["a-done"], 5000); }
        return v;
      };
      syncBuiltinESMExports();
    }
    const { createFileStore } = await import(${send});
    const delay = ${JSON.stringify(aAfterBWonMs ?? null)};
    if (${JSON.stringify(role)} === "A") {
      if (delay === null) waitFor(["b-read"], 1000);
      else { waitFor(["B-won", "B-lost"], ${PROBE_HOLD_CAP_MS}); spin(delay); }
    }
    let out = "won";
    try { createFileStore(dir); } catch (e) { out = "lost"; }
    fs.writeFileSync(dir + "/" + ${JSON.stringify(role)} + "-" + out, "");
    if (${JSON.stringify(role)} === "A") fs.writeFileSync(dir + "/a-done", "");
    const other = ${JSON.stringify(role)} === "A" ? "B" : "A";
    waitFor([other + "-won", other + "-lost"], ${PROBE_HOLD_CAP_MS});`;
  const kids = (["B", "A"] as const).map((r) => spawn(process.execPath, ["--input-type=module", "-e", child(r)], { stdio: "ignore" }));
  await Promise.all(kids.map(exited));
  return readdirSync(dir).filter((f) => /^(A|B)-(won|lost)$/.test(f)).sort();
}

test("PROBE N3, scheduled: B pauses right after any read of the lock while A takes the store; B resumes: still exactly one holder", async () => {
  const results = await scheduledLockProbe();
  assert.equal(results.filter((f) => f.endsWith("-won")).length, 1, results.join(" "));
  assert.equal(results.length, 2, results.join(" "));
});

test("PROBE N3, scheduled, a slow runner: A starts 400 ms after B has won; B still holds, so A loses", async () => {
  assert.deepEqual(await scheduledLockProbe(400), ["A-lost", "B-won"]);
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
  const name = (p: unknown) => (typeof p === "string" ? (p === dir ? "dir" : p.includes(".tmp-") ? "tmp" : p.slice(dir.length + 1).replace(/^(u|p|k|d)-.*/, "$1")) : "fd");
  const all: string[] = [];
  const rec = (fn: string, f: (...a: never[]) => unknown) => (...a: unknown[]) => {
    const c = `${fn} ${name(a[0])}${fn === "linkSync" || fn === "renameSync" ? " " + name(a[1]) : ""}`;
    calls.push(c);
    all.push(c);
    return (f as (...a: unknown[]) => unknown)(...a);
  };
  const fs = Object.fromEntries((["closeSync", "fsyncSync", "linkSync", "openSync", "renameSync", "unlinkSync", "writeSync"] as const).map((k) => [k, rec(k, nodeFs[k] as never)]));
  const reads = { readFileSync: ((p: string, o: never) => (all.push(`readFileSync ${name(p)}`), nodeFs.readFileSync(p, o))) as typeof nodeFs.readFileSync, readdirSync: ((p: string) => (all.push(`readdirSync ${name(p)}`), nodeFs.readdirSync(p))) as typeof nodeFs.readdirSync };
  const s = createFileStore(dir, { ...nodeFs, ...fs, ...reads } as StoreFs);
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
  calls.length = 0;
  assert.equal(s.nonceCas("k", null, 2n), true);
  assert.deepEqual(calls, want(["linkSync tmp k", "unlinkSync tmp"]));
  calls.length = 0;
  assert.equal(s.nonceCas("k", 2n, 3n), true);
  assert.deepEqual(calls, want(["renameSync tmp k"]));
  s.setFoundAt("1".repeat(32), { height: "7", hash: "h" });
  assert.deepEqual(s.foundAt("1".repeat(32)), { height: "7", hash: "h" });
  assert.ok(all.some((c) => c.startsWith("readFileSync")) && all.some((c) => c.startsWith("readdirSync")), "reads are recorded too");
  s.close();
  assert.deepEqual(all.filter((c) => / lock\b/.test(c)), [], "nothing in the store's own fs calls opens the lock file (only take() does, through node:sqlite)");
});

// ---- the relayer on fake providers that answer as nearcore does ----
// send_tx with wait_until NONE is nearcore's send_tx_async: it answers {final_execution_status: NONE} for every
// transaction and validates nothing first (chain/jsonrpc lib.rs l.1191-1206; read live on near-sandbox 2.13.4: NONE
// for a stale nonce and for an expired block hash, while INCLUDED refuses both). The node then drops an invalid one
// silently: here a transaction is included after landMs if its block hash is within the validity period and its nonce
// is above the key's, else dropped with nothing said. view_access_key answers the nonce with the block it was read
// at. `tx` answers UNKNOWN_TRANSACTION for a hash it has not seen, and a regular provider forgets after its garbage
// collection; the archival one (index 2) never does.

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
const unknownTx = () => new RpcError("tx", { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } });
const unknownBlock = () => new RpcError("query", { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK", info: {} } });
type KeyChange = { height: bigint; nonce: bigint | null; cause: Record<string, string> };

/** One ledger behind two regular providers and an archival one. */
class Node {
  /** lookups by hash (the tx method) answered so far */
  lookups = 0;
  final = 1_000n;
  /**
   * The relayer key's history: each change in the block that made it, as EXPERIMENTAL_changes lists it (a nonce of
   * null: the key deleted). view_access_key by block_id reads the nonce at that block from it.
   */
  keyChanges: KeyChange[] = [];
  /** heights with no block */
  skipped = new Set<bigint>();
  /** the vault's account changes (EXPERIMENTAL_changes account_changes), each in the block of the receipt that made it */
  vaultChanges: { height: bigint; cause: Record<string, string> }[] = [];
  /** providers (by index) that answer every EXPERIMENTAL_changes with an empty list (save_state_changes off, F54) */
  noChanges = new Set<number>();
  /** ms added to every block's time on a provider (by index): two providers that disagree on a block's time */
  msSkew = [0n, 0n, 0n];
  nonceAt(h: bigint): bigint | null {
    let n: bigint | null = 10n;
    for (const c of this.keyChanges) if (c.height <= h) n = c.nonce;
    return n;
  }
  /** The key's nonce at the newest block; set, it changes in a new block by a receipt (AddKey again, say). */
  get keyNonce(): bigint {
    return this.nonceAt(this.final) ?? -1n;
  }
  set keyNonce(n: bigint) {
    this.final += 1n;
    this.keyChanges.push({ height: this.final, nonce: n, cause: { type: "receipt_processing", receipt_hash: "AddKey" } });
  }
  /** The key deleted by a receipt in a new block. */
  deleteKey() {
    this.final += 1n;
    this.keyChanges.push({ height: this.final, nonce: null, cause: { type: "receipt_processing", receipt_hash: "DeleteKey" } });
  }
  /** The block whose chunk applied a transaction of the key (its nonce change names its hash). */
  appliedAt(hash: string): bigint | undefined {
    return this.keyChanges.find((c) => c.cause.tx_hash === hash)?.height;
  }
  prevOf(h: bigint): bigint {
    let p = h - 1n;
    while (this.skipped.has(p)) p--;
    return p;
  }
  /** transaction_validity_period, in blocks (86,400 on mainnet) */
  validity = 100n;
  userNonce = new Map<string, bigint>();
  usdc = new Map<string, bigint>();
  pages = new Map<string, { depositor: string; value: bigint }>();
  prepaid = new Map<string, bigint>();
  blocks = new Map<string, bigint>();
  landed = new Map<string, unknown>();
  /** what the regular providers have forgotten (garbage collection) */
  forgotten = new Set<string>();
  /** `tx` answers UNKNOWN_TRANSACTION for these hashes on every provider this many more times (a lagging index) */
  hideTx = new Map<string, number>();
  log: { hash: string; kind: string; nonce: bigint; dropped?: string; expired?: boolean }[] = [];
  sent: bigint[] = [];
  landMs: (tx: ParsedTx) => number = () => 1;
  /** provider i (2: archival) fails this method with this error */
  fail?: (i: number, method: string, tx?: ParsedTx) => unknown;
  /** how far each regular provider's final is behind the chain's */
  finalLag: [bigint, bigint] = [0n, 0n];
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
    const kind = tx.action === 2 ? "prepay" : "delegate";
    const signedAt = this.blocks.get(tx.blockHash);
    if (signedAt === undefined || this.final - signedAt > this.validity) {
      this.log.push({ hash: tx.hash, kind, nonce: tx.nonce, dropped: "Expired" });
      return;
    }
    const key = this.nonceAt(this.final);
    if (key === null) {
      this.log.push({ hash: tx.hash, kind, nonce: tx.nonce, dropped: "InvalidAccessKey" });
      return;
    }
    if (tx.nonce <= key) {
      this.log.push({ hash: tx.hash, kind, nonce: tx.nonce, dropped: "InvalidNonce" });
      return;
    }
    // applied in the next block: the key's nonce change names the transaction, its receipts run in the blocks after
    this.final += 1n;
    this.keyChanges.push({ height: this.final, nonce: tx.nonce, cause: { type: "transaction_processing", tx_hash: tx.hash } });
    const transaction_outcome = { block_hash: this.bh(this.final), id: tx.hash, outcome: { executor_id: RELAYER, status: { SuccessReceiptId: "r" } } };
    const r = (executor: string, ok: boolean, failure = "") => {
      this.final += 1n;
      return { block_hash: this.bh(this.final), outcome: { executor_id: executor, status: ok ? { SuccessValue: "" } : { Failure: failure } } };
    };
    if (tx.action === 2) {
      this.prepaid.set(tx.precommitment, (this.prepaid.get(tx.precommitment) ?? 0n) + tx.bytes);
      const id = receiptIdOf(tx.hash, this.final);
      const vaultReceipt = r(VAULT, true);
      for (const type of ["receipt_processing", "action_receipt_gas_reward"]) this.vaultChanges.push({ height: this.final, cause: { type, receipt_hash: id } });
      this.landed.set(tx.hash, { final_execution_status: "FINAL", transaction_outcome, receipts_outcome: [vaultReceipt, r(RELAYER, true)] });
      this.log.push({ hash: tx.hash, kind, nonce: tx.nonce });
      return;
    }
    const d = tx.delegate;
    const expired = this.final + 1n > d.max_block_height;
    this.log.push({ hash: tx.hash, kind, nonce: tx.nonce, expired });
    if (expired) {
      this.landed.set(tx.hash, { final_execution_status: "FINAL", transaction_outcome, receipts_outcome: [r(d.sender_id, false, '{"ActionError":{"kind":{"DelegateActionExpired":null}}}')] });
      return;
    }
    this.userNonce.set(d.sender_id, d.nonce);
    const msg = JSON.parse((JSON.parse(Buffer.from((d.actions[0] as { args: Uint8Array }).args).toString()) as { msg: string }).msg) as { precommitment: string };
    this.usdc.set(d.sender_id, this.usdc.get(d.sender_id)! - AMOUNT);
    const outcome = { final_execution_status: "FINAL", transaction_outcome, receipts_outcome: [r(d.sender_id, true), r(VAULT_TOKEN, true), r(VAULT, true)] };
    this.pages.set(msg.precommitment, { depositor: d.sender_id, value: AMOUNT });
    this.landed.set(tx.hash, outcome);
  }
  private rpc(i: number): Rpc {
    return async (method, params) => {
      const tx = method === "send_tx" ? parseTx((params as { signed_tx_base64: string }).signed_tx_base64) : undefined;
      const err = this.fail?.(i, method, tx);
      if (err !== undefined) throw err;
      const top = this.final - (i < 2 ? this.finalLag[i]! : 0n); // this provider's final
      /** A height this provider holds a block at, else UNKNOWN_BLOCK. */
      const at = (id: unknown): bigint => {
        if (typeof id !== "number") throw new Error(`node: block_id ${String(id)}`);
        const h = BigInt(id);
        if (this.skipped.has(h) || h > top) throw unknownBlock();
        return h;
      };
      // timestamp_nanosec as nearcore writes it (a decimal string): 600 ms a block from 1.7e12 ms; timestamp (a JSON number past 2^53) is never read
      const header = (h: bigint) => ({ header: { height: Number(h), hash: this.bh(h), prev_height: Number(this.prevOf(h)), timestamp_nanosec: ((1_700_000_000_000n + h * 600n + (this.msSkew[i] ?? 0n)) * 1_000_000n + 999_999n).toString(), timestamp: 9_007_199_254_740_993_000 } });
      if (method === "query") {
        const q = params as { request_type: string; block_id?: unknown; public_key?: string };
        if (q.request_type === "view_access_key") {
          const h = q.block_id === undefined ? top : at(q.block_id);
          const n = this.nonceAt(h);
          // nearcore answers an absent key as a result holding `error`, not an RPC error (read live on mainnet)
          if (n === null) return { block_hash: this.bh(h), block_height: Number(h), error: `access key ${q.public_key} does not exist while viewing`, logs: [] };
          return { nonce: Number(n), permission: "FullAccess", block_height: Number(h), block_hash: this.bh(h) };
        }
        if (q.request_type === "view_account") return { amount: (10n ** 24n).toString() };
      }
      if (method === "EXPERIMENTAL_protocol_config") return { transaction_validity_period: Number(this.validity) };
      if (method === "EXPERIMENTAL_changes") {
        const q = params as { changes_type: string; keys: { account_id: string; public_key: string }[]; account_ids?: string[]; block_id: unknown };
        const h = at(q.block_id);
        if (q.changes_type === "account_changes") {
          assert.deepEqual(q.account_ids, [VAULT]);
          return { block_hash: this.bh(h), changes: this.vaultChanges.filter((c) => c.height === h).map((c) => ({ cause: c.cause, type: "account_update", change: { account_id: VAULT, amount: "1" } })) };
        }
        assert.equal(q.changes_type, "single_access_key_changes");
        const k = q.keys[0]!;
        const changes = this.noChanges.has(i)
          ? []
          : this.keyChanges
              .filter((c) => c.height === h)
              .map((c) =>
                c.nonce === null
                  ? { cause: c.cause, type: "access_key_deletion", change: { account_id: k.account_id, public_key: k.public_key } }
                  : { cause: c.cause, type: "access_key_update", change: { account_id: k.account_id, public_key: k.public_key, access_key: { nonce: Number(c.nonce), permission: "FullAccess" } } },
              );
        return { block_hash: this.bh(h), changes };
      }
      if (method === "block") {
        const p = params as { block_id?: unknown };
        if (typeof p.block_id === "string") {
          const h = this.blocks.get(p.block_id);
          if (h === undefined) throw unknownBlock();
          return header(h);
        }
        return header(p.block_id === undefined ? top : at(p.block_id));
      }
      if (method === "send_tx") {
        assert.equal((params as { wait_until: string }).wait_until, "NONE");
        if (!this.sent.includes(tx!.nonce)) this.sent.push(tx!.nonce);
        if (!this.landed.has(tx!.hash)) setTimeout(() => this.land(tx!), this.landMs(tx!));
        return { final_execution_status: "NONE" };
      }
      if (method === "tx") {
        this.lookups++;
        const h = (params as { tx_hash: string }).tx_hash;
        const hid = this.hideTx.get(h) ?? 0;
        if (hid > 0) {
          this.hideTx.set(h, hid - 1);
          throw unknownTx();
        }
        if (!this.landed.has(h) || (i < 2 && this.forgotten.has(h))) throw unknownTx();
        return this.landed.get(h);
      }
      throw new Error(`node: ${method}`);
    };
  }
  rpcs = (): [Rpc, Rpc] => [this.rpc(0), this.rpc(1)];
  archival = (): Rpc => this.rpc(2);
  /** the gas account's one key: every relayer this node makes signs with it, as a restart does */
  secret = relayerSecret();
  /** the gas account's store (its key's counter, the blocks D found): every relayer this node makes shares it, as a restart does */
  private rstore?: DepositStore;
  get relayerStore(): DepositStore {
    return (this.rstore ??= newStore());
  }
  relayerOn = (rpcs: readonly [Rpc, Rpc], waitMs = 1_000) => createRelayer(rpcs, this.archival(), RELAYER, this.secret, VAULT, this.validity, this.relayerStore, waitMs);
  relayer = (waitMs = 1_000) => this.relayerOn(this.rpcs(), waitMs);
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
const noResend = { resend: false };
const resend = { resend: true };
const newStore = () => createFileStore(mkdtempSync(join(tmpdir(), "bind-node-")));
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Every provider's send_tx fails while `down()` (the send reached no node). */
const sendDown = (node: Node, down: () => boolean, only?: 2 | 8) => (node.fail = (i, m, tx) => (down() && i < 2 && m === "send_tx" && (only === undefined || tx?.action === only) ? new Error("fetch failed") : undefined));

test("the fake answers send_tx NONE as nearcore does: NONE for a stale nonce and for an expired block hash, then drops both silently", async () => {
  const node = new Node();
  const r = node.relayer(50);
  assert.equal((await r.send(prepayAction(1n), open, () => undefined)).kind, "final");
  const tx: TxRef[] = [];
  node.landMs = () => ((node.keyNonce = 9_000n), 1); // the key moves after the relayer read it, before inclusion
  const real = node.rpcs()[0];
  // (a2): the key's nonce passed it at a block whose change names another cause, so it can never land
  assert.equal((await r.send(prepayAction(2n), open, keep(tx))).kind, "dropped");
  await sleepMs(10); // the node tries it
  const drops = () => node.log.filter((x) => x.dropped !== undefined).map((x) => x.dropped);
  assert.ok(drops().length > 0 && drops().every((x) => x === "InvalidNonce"), String(drops()));
  const before = drops().length;
  assert.deepEqual(await real("send_tx", { signed_tx_base64: tx[0]!.signed_tx, wait_until: "NONE" }), { final_execution_status: "NONE" });
  await sleepMs(10);
  assert.deepEqual(drops().slice(before), ["InvalidNonce"]);
  node.final += 101n;
  assert.deepEqual(await real("send_tx", { signed_tx_base64: tx[0]!.signed_tx, wait_until: "NONE" }), { final_execution_status: "NONE" });
  await sleepMs(10);
  assert.equal(node.log.at(-1)!.dropped, "Expired");
});

test("the validity period is read live on both providers; the relayer refuses to start when they differ", async () => {
  const node = new Node();
  assert.equal(await transactionValidityPeriod(node.rpcs()), 100n);
  const [a, b] = node.rpcs();
  const other: Rpc = async (m, p) => (m === "EXPERIMENTAL_protocol_config" ? { transaction_validity_period: 86_400 } : b(m, p));
  await assert.rejects(transactionValidityPeriod([a, other]), /disagree on transaction_validity_period/);
  await assert.rejects(startRelayer([a, other], node.archival(), RELAYER, relayerSecret(), VAULT, node.relayerStore), /disagree/);
  const r = await startRelayer(node.rpcs(), node.archival(), RELAYER, relayerSecret(), VAULT, node.relayerStore, 50);
  assert.equal((await r.send(prepayAction(1n), open, () => undefined)).kind, "final");
});

test("PROBE N1: the key's nonce jumps (key re-added); the next signing reads it, nothing is dropped, and every later call lands", async () => {
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
  await sleepMs(20);
  assert.equal(node.log.filter((x) => x.dropped !== undefined).length, 0, "nothing silently dropped");
  assert.equal(node.prepaid.size, 6);
  store.close();
});

/**
 * The window of a test where calls queue at once and every one must land: the production one. The first call's first
 * outcome read shares the process with the next call's turn (its counter write is two fsyncs), and a window a slow
 * disk or a busy runner can outlast leaves that read the last one, made before the landing: 'unknown' at random.
 * A call that lands is read on the next poll, so the window costs nothing when the test passes.
 */
const QUEUED_WAIT_MS = OUTCOME_WAIT_MS;
async function twoQueuedAfterKeyMove(node: Node, r: Relayer) {
  assert.equal((await r.send(prepayAction(1n), open, () => undefined)).kind, "final");
  node.keyNonce = 40n; // the key moved after the relayer last read it
  const tx: TxRef[] = [];
  const [a, b] = await Promise.all([r.send(prepayAction(2n), open, keep(tx)), r.send(prepayAction(3n), open, keep(tx))]);
  const c: TxRef[] = [];
  const third = await r.send(prepayAction(4n), open, keep(c));
  assert.deepEqual({ kinds: [a.kind, b.kind, third.kind], nonces: [...tx.map((x) => x.nonce), c[0]!.nonce] }, { kinds: ["final", "final", "final"], nonces: ["41", "42", "43"] });
  assert.equal(node.log.filter((x) => x.dropped !== undefined).length, 0);
}

test("RECHECK R1: after the key moved, two calls queued at once are both signed above the key and land; nothing is dropped", async () => {
  const node = new Node();
  node.landMs = () => 50;
  await twoQueuedAfterKeyMove(node, node.relayer(QUEUED_WAIT_MS));
});

test("RECHECK R1 on a slow disk: the second call's counter write blocks the process for 600 ms while the first call's outcome is read; both still land final", async () => {
  const node = new Node();
  node.landMs = () => 50;
  const disk = node.relayerStore;
  let writes = 0;
  const slow: RelayerStore = {
    ...disk,
    nonceCas(key, expected, next) {
      // the third write is the second queued call's; a loaded disk holds its fsync, and the whole process with it
      if (++writes === 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
      return disk.nonceCas(key, expected, next);
    },
  };
  await twoQueuedAfterKeyMove(node, createRelayer(node.rpcs(), node.archival(), RELAYER, node.secret, VAULT, node.validity, slow, QUEUED_WAIT_MS));
  assert.equal(writes, 4);
});

test("RECHECK R1b: after a key jump, three deposits at once all land with no silent drop", async () => {
  const node = new Node();
  node.landMs = () => 20;
  const store = newStore();
  const deps = node.deps(store, node.relayer(QUEUED_WAIT_MS));
  ok(await carryDeposit(signed(node.user(), P, 101n, node.final + 100n), deps));
  node.keyNonce += 1_000_000n;
  const answers = await Promise.all([1n, 2n, 3n].map((i) => carryDeposit(signed(node.user(), P + i, 101n, node.final + 100n), deps)));
  assert.deepEqual(answers.map(code), ["ok", "ok", "ok"]);
  await sleepMs(30);
  assert.equal(node.log.filter((x) => x.dropped !== undefined).length, 0);
  store.close();
});

test("RECHECK R2: a prepay that reached no node and outlived its validity period is judged dropped by (b), K's nonce below its own at F past b0 + the period, rolled back, and P is prepaid afresh", async () => {
  const node = new Node();
  const u = node.user();
  let down = true;
  sendDown(node, () => down);
  const store = newStore();
  const deps = node.deps(store, node.relayer(300));
  const answers = [code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps))];
  down = false;
  node.final += 150n; // the outage outlasts the validity window (100 blocks here; 86,400 on mainnet)
  answers.push(code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps)));
  assert.deepEqual(answers, ["in_flight", "ok"]);
  assert.equal(node.prepaid.get(P.toString()), PREPAY_BYTES, "one prepay landed");
  assert.deepEqual([store.get(u.id)!.prepays.length, store.get(u.id)!.failed], [1, 0]);
  store.close();
});

test("RECHECK R4: the settle never re-sends U's stored delegate once the token watch turned halted", async () => {
  const node = new Node();
  const u = node.user();
  let cut = true;
  let halted = false;
  let sentWhileHalted = 0;
  const base = node.rpcs();
  const wrap = (r: Rpc): Rpc => async (m, p) => {
    if (m === "send_tx" && parseTx((p as { signed_tx_base64: string }).signed_tx_base64).action === 8) {
      if (cut) throw new Error("fetch failed");
      if (halted) sentWhileHalted++;
    }
    return r(m, p);
  };
  const relayer = node.relayerOn([wrap(base[0]), wrap(base[1])], 300);
  const store = newStore();
  const deps = node.deps(store, relayer);
  deps.tokenStatus = async () => (halted ? { ...HALTED, block_height: Number(node.final) } : { ...OPEN, block_height: Number(node.final) });
  assert.equal(code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps)), "ok"); // answered as sent; the delegate reached no node
  assert.equal(store.get(u.id)!.sends[0]!.state, "pending");
  cut = false;
  // the watch turns halted after check 9 read it open, while the settle runs: the call's first two holds (before the
  // checks, check 9) read open, the settle's own hold reads halted (the hold comes before R4's margin, guardFor)
  let asks = 0;
  const watch = deps.tokenStatus;
  deps.tokenStatus = async (at) => ((halted ||= ++asks > 2), watch(at));
  assert.equal(code(await carryDeposit(signed(u, P, 101n, node.final + 90n), deps)), "in_flight");
  assert.equal(asks, 3);
  assert.equal(sentWhileHalted, 0);
  store.close();
});

test("RECHECK R5: every provider's `tx` lags behind a landed prepay for a while: it is never judged dropped, and P is prepaid once", async () => {
  const node = new Node();
  const u = node.user();
  const store = newStore();
  const relayer = node.relayer(2_000);
  const real = relayer.send;
  relayer.send = (a, g, before) => real(a, g, (tx) => (before(tx), a.kind === "storage_prepay" && node.hideTx.size === 0 && node.hideTx.set(tx.tx_hash, 6), undefined));
  ok(await carryDeposit(signed(u, P, 101n, node.final + 100n), node.deps(store, relayer)));
  assert.equal(node.prepaid.get(P.toString()), PREPAY_BYTES);
  store.close();
});

test("D: past its validity period, a landed transaction the index hides for one read is found on the next a block later: final, never dropped", async () => {
  const node = new Node();
  const r = node.relayer(50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "final");
  node.final += 200n;
  node.hideTx.set(tx[0]!.tx_hash, 3); // one read of all three providers
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown");
  node.final += 1n;
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "final");
});

test("R01: a prepay that reached no node is sent again by the next call's settle, lands, and the call goes on to the send", async () => {
  const node = new Node();
  const u = node.user();
  let down = true;
  sendDown(node, () => down);
  const store = newStore();
  const deps = node.deps(store, node.relayer(300));
  assert.equal(code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps)), "in_flight");
  down = false;
  assert.equal(code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps)), "in_flight", "sent again, read at once: not landed yet");
  await sleepMs(20);
  ok(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps));
  assert.deepEqual([node.prepaid.get(P.toString()), store.get(u.id)!.prepays.length, store.get(u.id)!.landed], [PREPAY_BYTES, 1, true]);
  store.close();
});

test("PROBE N8: a send that reached no node is not re-sent once its delegate is within K; with nothing else of the key landed it settles dropped by (b) past its validity period, uncounted, and the new call lands", async () => {
  const node = new Node();
  const u = node.user();
  let down = true;
  sendDown(node, () => down, 8);
  const store = newStore();
  const deps = node.deps(store, node.relayer(300));
  assert.equal(code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps)), "ok");
  assert.equal(store.get(u.id)!.sends[0]!.state, "pending");
  down = false;
  node.final += 200n; // the device waits out D1's max_block_height (and its validity period) and signs D2 for the same P
  assert.equal(code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps)), "ok");
  await sleepMs(20);
  assert.equal(node.log.filter((x) => x.kind === "delegate" && x.expired).length, 0, "D1 never went out past its window");
  const r = store.get(u.id)!;
  assert.deepEqual([r.sends.map((x) => x.state), r.failed, r.landed], [["dropped", "landed"], 0, true]);
  store.close();
});

test("H1: the queue is released at the send, not at FINAL: a second transaction goes out while the first waits, with the next nonce", async () => {
  const node = new Node();
  let first = "";
  node.landMs = (tx) => (tx.hash === first ? 300 : 400); // included in nonce order, as the pool orders one key's
  const r = node.relayer(QUEUED_WAIT_MS);
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

test("nonces: transactions in flight at once get distinct nonces; each is signed on the block the key was read at, which its record keeps", async () => {
  const node = new Node();
  node.landMs = () => 50;
  const r = node.relayer(QUEUED_WAIT_MS);
  const tx: TxRef[] = [];
  const outs = await Promise.all([1n, 2n, 3n].map((p) => r.send(prepayAction(p), open, keep(tx))));
  assert.deepEqual(outs.map((o) => o.kind), ["final", "final", "final"]);
  assert.deepEqual(node.sent, [11n, 12n, 13n]);
  assert.deepEqual(tx.map((x) => x.height), ["1000", "1000", "1000"]);
  assert.deepEqual(tx.map((x) => node.blocks.get(parseTx(x.signed_tx).blockHash)), [1000n, 1000n, 1000n]);
  node.keyNonce = 40n;
  const again: TxRef[] = [];
  assert.equal((await r.send(prepayAction(5n), open, keep(again))).kind, "final");
  assert.equal(again[0]!.nonce, "41");
});

test("PROBE E: past the validity period, with one regular provider unreadable, never dropped; dropped by (b) once both read K at F", async () => {
  const node = new Node();
  let down = new Set<string>(["0:send_tx", "1:send_tx"]);
  node.fail = (i, m) => (down.has(`${i}:${m}`) ? new Error("fetch failed") : undefined);
  const r = node.relayer(50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  node.final += 150n;
  down = new Set(["0:send_tx", "1:send_tx", "1:block", "1:tx"]);
  const kinds: string[] = [];
  kinds.push((await r.resolve(tx[0]!, noResend)).kind);
  node.final += 1n;
  kinds.push((await r.resolve(tx[0]!, noResend)).kind);
  down = new Set(["0:send_tx", "1:send_tx"]);
  kinds.push((await r.resolve(tx[0]!, noResend)).kind);
  assert.deepEqual(kinds, ["unknown", "unknown", "dropped"]);
});

test("A: the window is judged at F, the lower of the two finals: one provider's final past it alone never drops a transaction", async () => {
  const node = new Node();
  sendDown(node, () => true);
  const r = node.relayer(50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  const b0 = BigInt(tx[0]!.height);
  node.finalLag = [0n, 80n];
  node.final = b0 + 102n; // past b0 + validity on provider 0 only
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown");
  node.final += 1n;
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown", "provider 1's final is still inside the window");
  node.final = b0 + 180n; // provider 1 at b0 + 100: at the window's end, a block may still include it
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown");
  node.final += 1n;
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "dropped");
});

test("X17: an unreadable final keeps the round: the other provider's final alone never drops a transaction", async () => {
  const node = new Node();
  sendDown(node, () => true);
  let down = true;
  const [r0, r1] = node.rpcs();
  const blind: Rpc = async (m, p) => (down && m === "block" && (p as { finality?: string }).finality === "final" ? Promise.reject(new Error("fetch failed")) : r1(m, p));
  const r = node.relayerOn([r0, blind], 50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  node.final += 150n;
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown");
  node.final += 1n;
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown");
  down = false;
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "dropped");
});

test("the relayer's caches keep at most CACHE_MAX entries, the oldest dropped first", () => {
  const m = new Map<number, number>();
  for (let i = 0; i < CACHE_MAX + 10; i++) remember(m, i, i);
  assert.equal(m.size, CACHE_MAX);
  assert.equal(m.has(9), false);
  assert.equal(m.has(10), true);
  remember(m, 10, 10); // touched again: now the newest
  remember(m, -1, -1);
  assert.deepEqual([m.has(10), m.has(11)], [true, false]);
});

test("Low 4: a landed transaction a regular provider forgot (garbage collection) reads final from the archival one, never dropped", async () => {
  const node = new Node();
  const r = node.relayer();
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "final");
  node.forgotten.add(tx[0]!.tx_hash);
  node.final += 200n;
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "final");
  node.fail = (i) => (i === 2 ? new Error("fetch failed") : undefined);
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown", "no archival read: never dropped");
  node.final += 1n;
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
  sendDown(node, () => down);
  const r = node.relayer(50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  down = false;
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown");
  assert.equal(node.sent.length, 0, "resend false: not sent");
  await r.resolve(tx[0]!, resend);
  await sleepMs(20);
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "final");
  assert.equal(node.landed.size, 1);
});

test("M2/C (b): with K's nonce below the transaction's at F, it is dropped only once F is past b0 + the validity period", async () => {
  const node = new Node();
  sendDown(node, () => true);
  const r = node.relayer(50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  node.final = BigInt(tx[0]!.height) + 100n; // at b0 + validity: a block may still include it
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown");
  node.final += 1n;
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "dropped");
});

// ---- the 57dd5df re-check (RC2): F the lower final with its hash on both, (a2), the durable nonce counter ----

/** The node's two providers, provider i's answers passed through `edit`. */
function edited(node: Node, i: 0 | 1, edit: (method: string, params: Record<string, unknown>, real: () => Promise<unknown>) => Promise<unknown>): [Rpc, Rpc] {
  const rs = node.rpcs();
  const r = rs[i];
  rs[i] = (m, p) => edit(m, p as Record<string, unknown>, () => r(m, p));
  return rs;
}
/** A block answer with another hash. */
const otherHash = async (real: () => Promise<unknown>) => {
  const a = (await real()) as { header: Record<string, unknown> };
  return { header: { ...a.header, hash: base58(createHash("sha256").update("another fork").digest()) } };
};
/** A prepay of ours that reached no node, signed at b0 = 1000. */
async function unsent(node: Node, r: Relayer): Promise<TxRef> {
  sendDown(node, () => true);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  node.fail = undefined;
  return tx[0]!;
}

test("RC2-1 (a2): U's prepay reached no node, then V's deposit landed with higher nonces: U's prepay is dropped at once, not after the validity period, and U's next call lands", async () => {
  const node = new Node();
  const store = newStore();
  const deps = node.deps(store, node.relayer(300));
  const u = node.user();
  let down = true;
  sendDown(node, () => down);
  const answers = [code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps))];
  down = false;
  ok(await carryDeposit(signed(node.user(), P + 1n, 101n, node.final + 100n), deps)); // the key's nonce passes U's prepay's
  const pre = store.get(u.id)!.prepays[0]!;
  assert.ok(node.final < BigInt(pre.height) + node.validity, "well inside its validity period");
  answers.push(code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps)));
  assert.deepEqual(answers, ["in_flight", "ok"]);
  const r = store.get(u.id)!;
  assert.deepEqual([r.prepays.length, r.failed, r.landed, node.prepaid.get(P.toString())], [1, 0, true, PREPAY_BYTES]);
  store.close();
});

test("PROBE N8 (a2): a delegate that reached no node is dropped, uncounted, once another transaction of the key overtook it; U's next delegate lands with no wait for the window", async () => {
  const node = new Node();
  const u = node.user();
  let down = true;
  sendDown(node, () => down, 8);
  const store = newStore();
  const deps = node.deps(store, node.relayer(300));
  assert.equal(code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps)), "ok");
  assert.equal(store.get(u.id)!.sends[0]!.state, "pending");
  down = false;
  ok(await carryDeposit(signed(node.user(), P + 1n, 101n, node.final + 100n), deps)); // V's deposit lands above D1's nonce
  assert.equal(code(await carryDeposit(signed(u, P, 101n, node.final + 99n), deps)), "ok");
  const r = store.get(u.id)!;
  assert.deepEqual([r.sends.map((x) => x.state), r.failed, r.landed], [["dropped", "landed"], 0, true]);
  store.close();
});

test("RC2-3: one provider's final far ahead (broken or hostile) never makes a live prepay look dropped: F is the lower final, and P is prepaid once", async () => {
  const node = new Node();
  node.landMs = () => 700; // inclusion after the second poll (POLL_MS 500)
  let ahead = 0;
  const rs = edited(node, 1, async (m, p, real) => {
    if (m === "block" && p.finality === "final") {
      const h = node.final + node.validity + 10n + BigInt(ahead++);
      return { header: { height: Number(h), hash: node.bh(h), prev_height: Number(h - 1n) } };
    }
    return real();
  });
  const store = newStore();
  const u = node.user();
  const deps = node.deps(store, node.relayerOn(rs, 3_000));
  ok(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps));
  await sleepMs(50);
  const r = store.get(u.id)!;
  assert.equal(node.log.filter((x) => x.kind === "prepay" && x.dropped === undefined).length, 1);
  assert.deepEqual([node.prepaid.get(P.toString()), r.failed, r.struck, r.prepaid_bytes], [PREPAY_BYTES, 0, false, Number(PREPAY_BYTES)]);
  store.close();
});

test("F's hash differing between the providers keeps the round, past the window as inside it", async () => {
  const node = new Node();
  let fork = true;
  const rs = edited(node, 1, async (m, p, real) => (fork && m === "block" && p.block_id === Number(node.final) ? otherHash(real) : real()));
  const r = node.relayerOn(rs, 50);
  const tx = await unsent(node, r);
  node.final += 150n;
  assert.equal((await r.resolve(tx, noResend)).kind, "unknown");
  node.final += 1n;
  assert.equal((await r.resolve(tx, noResend)).kind, "unknown");
  fork = false;
  assert.equal((await r.resolve(tx, noResend)).kind, "dropped");
});

test("b0's hash answered otherwise by the other provider keeps the round", async () => {
  const node = new Node();
  let fork = true;
  const rs = edited(node, 1, async (m, p, real) => (fork && m === "block" && p.block_id === 1000 ? otherHash(real) : real()));
  const r = node.relayerOn(rs, 50);
  const tx = await unsent(node, r);
  assert.equal(tx.height, "1000");
  node.final += 150n;
  assert.equal((await r.resolve(tx, noResend)).kind, "unknown");
  node.final += 1n;
  assert.equal((await r.resolve(tx, noResend)).kind, "unknown");
  fork = false;
  assert.equal((await r.resolve(tx, noResend)).kind, "dropped");
});

test("(a2): D's hash differing between the providers keeps the round; once they agree, the change at D names another transaction and it is dropped", async () => {
  const node = new Node();
  let fork = true;
  const rs = edited(node, 1, async (m, p, real) => (fork && m === "block" && p.block_id === 1005 ? otherHash(real) : real()));
  const r = node.relayerOn(rs, 50);
  const tx = await unsent(node, r);
  node.keyChanges.push({ height: 1005n, nonce: 50n, cause: { type: "transaction_processing", tx_hash: "another" } });
  node.final = 1010n;
  assert.equal((await r.resolve(tx, noResend)).kind, "unknown");
  fork = false;
  assert.equal((await r.resolve(tx, noResend)).kind, "dropped");
});

test("(a2) search: a height with no block, shown by the next block's prev_height, is skipped and D is found past it", async () => {
  const node = new Node();
  const r = node.relayer(50);
  const tx = await unsent(node, r);
  node.skipped.add(1010n);
  node.keyChanges.push({ height: 1011n, nonce: 50n, cause: { type: "transaction_processing", tx_hash: "another" } });
  node.final = 1020n;
  assert.equal((await r.resolve(tx, noResend)).kind, "dropped");
});

test("(a2) search: UNKNOWN_BLOCK at a height whose block the next block's prev_height names is an error that keeps the round", async () => {
  const node = new Node();
  let lag = true;
  const lagging = (i: 0 | 1, rs: [Rpc, Rpc]) => {
    const r = rs[i];
    rs[i] = async (m, p) => (lag && m === "query" && (p as { block_id?: unknown }).block_id === 1010 ? Promise.reject(unknownBlock()) : r(m, p));
    return rs;
  };
  const r = node.relayerOn(lagging(1, lagging(0, node.rpcs())), 50);
  const tx = await unsent(node, r);
  node.keyChanges.push({ height: 1011n, nonce: 50n, cause: { type: "transaction_processing", tx_hash: "another" } });
  node.final = 1020n;
  assert.equal((await r.resolve(tx, noResend)).kind, "unknown");
  lag = false;
  assert.equal((await r.resolve(tx, noResend)).kind, "dropped");
});

test("(a2) search: UNKNOWN_BLOCK at a height that is a block keeps that round even when a second read there answers; the next round finds D", async () => {
  const node = new Node();
  let first = 2; // one read on each provider
  const lagOnce = (rs: [Rpc, Rpc]) =>
    rs.map((r) => (async (m: string, p: unknown) => (m === "query" && (p as { block_id?: unknown }).block_id === 1010 && first-- > 0 ? Promise.reject(unknownBlock()) : r(m, p))) as Rpc) as [Rpc, Rpc];
  const r = node.relayerOn(lagOnce(node.rpcs()), 50);
  const tx = await unsent(node, r);
  node.keyChanges.push({ height: 1011n, nonce: 50n, cause: { type: "transaction_processing", tx_hash: "another" } });
  node.final = 1020n;
  first = 2;
  assert.equal((await r.resolve(tx, noResend)).kind, "unknown");
  assert.equal((await r.resolve(tx, noResend)).kind, "dropped");
});

test("a stored D the providers now answer with another hash (both, alike) keeps the round", async () => {
  const node = new Node();
  const tx: TxRef[] = [];
  const r = node.relayer(50);
  sendDown(node, () => true);
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  node.fail = undefined;
  node.hideTx.set(tx[0]!.tx_hash, 3);
  await r.resolve(tx[0]!, resend);
  await sleepMs(10);
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown", "D found and stored; lookups behind");
  const d = Number(node.appliedAt(tx[0]!.tx_hash)!);
  const fork = base58(createHash("sha256").update("another fork").digest());
  const swap = (x: Rpc): Rpc => async (m, p) => {
    const a = await x(m, p);
    const at = (p as { block_id?: unknown }).block_id;
    if (m === "block" && at === d) return { header: { ...(a as { header: object }).header, hash: fork } };
    if (m === "EXPERIMENTAL_changes" && at === d) return { ...(a as object), block_hash: fork };
    if (m === "tx") return { ...(a as object), transaction_outcome: { block_hash: fork } }; // every answer agrees on the swapped D
    return a;
  };
  const [s0, s1] = node.rpcs().map(swap);
  const swapped = createRelayer([s0!, s1!], swap(node.archival()), RELAYER, node.secret, VAULT, node.validity, node.relayerStore, 50);
  assert.equal((await swapped.resolve(tx[0]!, noResend)).kind, "unknown");
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "final");
});

/** Both providers' answers passed through `edit`. */
const bothEdited = (node: Node, edit: (method: string, params: Record<string, unknown>, real: () => Promise<unknown>) => Promise<unknown>): [Rpc, Rpc] =>
  node.rpcs().map((r) => ((m: string, p: unknown) => edit(m, p as Record<string, unknown>, () => r(m, p))) as Rpc) as [Rpc, Rpc];
/** A prepay that landed, then F moved past its validity period; the answers come through `rs` from then on. */
async function landedPast(node: Node, edit: (method: string, params: Record<string, unknown>, real: () => Promise<unknown>) => Promise<unknown>, one?: 0 | 1) {
  let on = false;
  const rs = one === undefined ? bothEdited(node, (m, p, real) => (on ? edit(m, p, real) : real())) : edited(node, one, (m, p, real) => (on ? edit(m, p, real) : real()));
  const r = node.relayerOn(rs, 50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "final");
  node.final += 150n;
  on = true;
  return { r, tx: tx[0]!, d: Number(node.appliedAt(tx[0]!.tx_hash)!), off: () => (on = false) };
}

test("one provider answering K at F as unspent while the other shows it spent keeps the round: a landed prepay past its window is never dropped on one provider's word", async () => {
  const node = new Node();
  const { r, tx, off } = await landedPast(node, async (m, p, real) => (m === "query" && typeof p.block_id === "number" ? { ...((await real()) as object), nonce: 10 } : real()), 0);
  assert.equal((await r.resolve(tx, noResend)).kind, "unknown");
  off();
  assert.equal((await r.resolve(tx, noResend)).kind, "final");
});

test("view_access_key answered at another height than the one asked keeps the round", async () => {
  const node = new Node();
  const { r, tx, off } = await landedPast(node, async (m, p, real) => (m === "query" && typeof p.block_id === "number" ? { nonce: 10, permission: "FullAccess", block_height: 1000, block_hash: node.bh(1000n) } : real()));
  assert.equal((await r.resolve(tx, noResend)).kind, "unknown");
  off();
  assert.equal((await r.resolve(tx, noResend)).kind, "final");
});

test("a change list at D answered under another block's hash keeps the round", async () => {
  const node = new Node();
  const { r, tx, d, off } = await landedPast(node, async (m, p, real) =>
    m === "EXPERIMENTAL_changes" && p.block_id === d ? { block_hash: node.bh(BigInt(d) + 1n), changes: [{ cause: { type: "receipt_processing", receipt_hash: "x" }, type: "access_key_update", change: { account_id: RELAYER, public_key: (p.keys as { public_key: string }[])[0]!.public_key, access_key: { nonce: 99, permission: "FullAccess" } } }] } : real(),
  );
  assert.equal((await r.resolve(tx, noResend)).kind, "unknown");
  off();
  assert.equal((await r.resolve(tx, noResend)).kind, "final");
});

test("a change list at D naming another key keeps the round", async () => {
  const node = new Node();
  const { r, tx, d, off } = await landedPast(node, async (m, p, real) =>
    m === "EXPERIMENTAL_changes" && p.block_id === d ? { block_hash: node.bh(BigInt(d)), changes: [{ cause: { type: "receipt_processing", receipt_hash: "x" }, type: "access_key_update", change: { account_id: RELAYER, public_key: "ed25519:11111111111111111111111111111111", access_key: { nonce: 99, permission: "FullAccess" } } }] } : real(),
  );
  assert.equal((await r.resolve(tx, noResend)).kind, "unknown");
  off();
  assert.equal((await r.resolve(tx, noResend)).kind, "final");
});

test("(a2): K turned into a function-call key below the transaction's nonce (not a plain key any more) fails P, and the change there names no transaction of ours", async () => {
  const node = new Node();
  const rs = bothEdited(node, async (m, p, real) => {
    const a = await real();
    return m === "query" && typeof p.block_id === "number" && p.block_id >= 1005 && isObjAnswer(a) ? { ...a, permission: { FunctionCall: { allowance: null, receiver_id: VAULT, method_names: [] } } } : a;
  });
  const r = node.relayerOn(rs, 50);
  const tx = await unsent(node, r);
  node.keyChanges.push({ height: 1005n, nonce: 10n, cause: { type: "receipt_processing", receipt_hash: "AddKey" } });
  node.final = 1010n;
  assert.equal((await r.resolve(tx, noResend)).kind, "dropped");
});
const isObjAnswer = (a: unknown): a is Record<string, unknown> => typeof a === "object" && a !== null && "nonce" in a;

test("(a2) search: K answered at a height that has no block (the next block's prev_height skips it) keeps the round", async () => {
  const node = new Node();
  node.skipped.add(1009n);
  const rs = bothEdited(node, async (m, p, real) => (m === "query" && p.block_id === 1009 ? { nonce: 10, permission: "FullAccess", block_height: 1009, block_hash: node.bh(1009n) } : real()));
  const r = node.relayerOn(rs, 50);
  const tx = await unsent(node, r);
  node.keyChanges.push({ height: 1010n, nonce: 50n, cause: { type: "transaction_processing", tx_hash: "another" } });
  node.final = 1020n;
  assert.equal((await r.resolve(tx, noResend)).kind, "unknown");
});

// ---- the f487d98 re-check (RC3): the background round settles open records inside the providers' garbage collection ----

/** Regular providers that garbage-collect: blocks, keys and changes below `gc` blocks under their final are gone. */
const gcRpcs = (node: Node, gc: bigint): [Rpc, Rpc] =>
  node.rpcs().map((r, i) => async (m: string, p: unknown) => {
    const id = (p as { block_id?: unknown })?.block_id;
    if (typeof id === "number" && BigInt(id) < node.final - node.finalLag[i]! - gc) {
      if (m === "query") throw new RpcError("query", { name: "HANDLER_ERROR", cause: { name: "GARBAGE_COLLECTED_BLOCK", info: {} } });
      throw unknownBlock();
    }
    return r(m, p as never);
  }) as [Rpc, Rpc];

test("RC3-4: a prepay that landed but read unknown in the call's wait is settled by the background round with no call from U, inside the providers' garbage collection; U's next call after it lands", async () => {
  const node = new Node();
  node.landMs = () => 1_500; // lands after the call's 300 ms wait
  const GC = 500n; // regular providers keep this many blocks (about 5 epochs on mainnet)
  const store = newStore();
  const deps = node.deps(store, node.relayerOn(gcRpcs(node, GC), 300));
  const u = node.user();
  const answers = [code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps))];
  assert.deepEqual(store.open(), [u.id]);
  const stop = startLockRounds(deps, 100);
  await until(() => store.get(u.id)!.prepays[0]!.ok !== null);
  stop();
  assert.equal(store.get(u.id)!.prepays[0]!.ok, true, "settled by the background round");
  assert.deepEqual(store.open(), []);
  node.final += GC + 50n; // U returns after the regular providers forgot b0 and D
  answers.push(code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps)));
  assert.deepEqual(answers, ["in_flight", "ok"]);
  assert.equal(node.prepaid.get(P.toString()), PREPAY_BYTES);
  store.close();
});

test("RC3-5: a prepay that never landed is settled dropped by (b) in the background round, past its validity period and inside the garbage collection; U's call after the collection prepays afresh", async () => {
  const node = new Node();
  const GC = 500n;
  const store = newStore();
  const deps = node.deps(store, node.relayerOn(gcRpcs(node, GC), 300));
  const u = node.user();
  let down = true;
  sendDown(node, () => down);
  const answers = [code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps))];
  down = false;
  node.final += 150n; // past b0 + validity (100), inside the collection
  const stop = startLockRounds(deps, 100);
  await until(() => store.get(u.id)!.prepays.length === 0);
  stop();
  assert.deepEqual([store.get(u.id)!.prepays.length, store.get(u.id)!.prepaid_bytes, store.open().length], [0, 0, 0]);
  node.final += GC + 50n;
  answers.push(code(await carryDeposit(signed(u, P, 101n, node.final + 100n), deps)));
  assert.deepEqual(answers, ["in_flight", "ok"]);
  assert.equal(node.prepaid.get(P.toString()), PREPAY_BYTES);
  store.close();
});

test("the background round leaves a U being carried to that call, and holds U's slot while it settles U: U's call then answers in_flight and sends nothing", async () => {
  const node = new Node();
  node.landMs = () => 1_500;
  const store = newStore();
  let gets = 0;
  const counted: DepositStore = { ...store, get: (u) => (gets++, store.get(u)) };
  const deps = node.deps(counted, node.relayerOn(node.rpcs(), 300));
  const u = node.user();
  const sd = signed(u, P, 101n, node.final + 100n);
  assert.equal(code(await carryDeposit(sd, deps)), "in_flight");
  await until(() => node.prepaid.get(P.toString()) === PREPAY_BYTES);
  // U's call holds U's slot: a round started while its send is out reads nothing of U's
  node.landMs = () => 1;
  const n0 = node.sent.length;
  const call = carryDeposit(sd, deps);
  await until(() => node.sent.length > n0);
  gets = 0;
  const skipped = lockRound(deps);
  assert.equal(gets, 0, "the round read a record whose U is being carried");
  await skipped;
  assert.equal(code(await call), "ok");
  // a round settling U holds U's slot: U's call meanwhile answers in_flight and sends nothing
  const v = new Node();
  v.landMs = () => 1_500;
  const vs = newStore();
  const slow = bothEdited(v, async (m, _p, real) => {
    if (m === "tx") await sleepMs(300);
    return real();
  });
  const vd = v.deps(vs, v.relayerOn(slow, 300));
  const w = v.user();
  const wd = signed(w, P, 101n, v.final + 100n);
  assert.equal(code(await carryDeposit(wd, vd)), "in_flight");
  await until(() => v.prepaid.get(P.toString()) === PREPAY_BYTES);
  const sent = v.sent.length;
  const round = lockRound(vd);
  assert.equal(code(await carryDeposit(wd, vd)), "in_flight");
  assert.equal(v.sent.length, sent, "U's call sent while the round held U's slot");
  await round;
  vs.close();
  store.close();
});

test("an error on one record keeps it for the next round and never stops the round for the records after it", async () => {
  const node = new Node();
  node.landMs = () => 1_500;
  const store = newStore();
  const deps = node.deps(store, node.relayerOn(node.rpcs(), 300));
  const [a, b] = [node.user(), node.user()];
  assert.equal(code(await carryDeposit(signed(a, P, 101n, node.final + 100n), deps)), "in_flight");
  assert.equal(code(await carryDeposit(signed(b, P + 1n, 101n, node.final + 100n), deps)), "in_flight");
  assert.deepEqual(store.open(), [a.id, b.id]);
  await until(() => node.prepaid.get((P + 1n).toString()) === PREPAY_BYTES);
  let broken = true;
  const deps2 = { ...deps, store: { ...store, get: (u: string) => (broken && u === a.id ? { ...store.get(u)!, p: "not a number" } : store.get(u)) } };
  await lockRound(deps2);
  assert.equal(store.get(b.id)!.prepays[0]!.ok, true, "the record after the broken one was not settled");
  assert.equal(store.get(a.id)!.prepays[0]!.ok, null);
  broken = false;
  await lockRound(deps2);
  assert.equal(store.get(a.id)!.prepays[0]!.ok, true, "kept for the next round");
  store.close();
});

test("the store's open records survive a restart: read once as the lock is taken", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-open-"));
  const s = createFileStore(dir);
  const u = "ab".repeat(32);
  const pending = { ...emptyRecord(u), prepays: [{ tx_hash: "t", nonce: "1", height: "1", block_hash: "h", signed_tx: "", bytes: 756, ok: null }] };
  s.put(pending);
  s.put({ ...emptyRecord("cd".repeat(32)) });
  assert.deepEqual(s.open(), [u]);
  // a send not known yet is open too, and so is a record created open
  const sending = { ...emptyRecord("ef".repeat(32)), sends: [{ tx_hash: "s", nonce: "2", height: "1", block_hash: "h", signed_tx: "", sha256: "x", amount: "1", max_block_height: "9", state: "pending" as const, counted: true }] };
  s.put(sending);
  assert.equal(s.create({ ...pending, u: "01".repeat(32) }).created, true);
  assert.deepEqual(s.open().sort(), [u, "ef".repeat(32), "01".repeat(32)].sort());
  s.put({ ...sending, sends: [{ ...sending.sends[0]!, state: "landed" as const }] });
  s.put({ ...pending, u: "01".repeat(32), prepays: [] });
  assert.deepEqual(s.open(), [u]);
  s.close();
  const t = createFileStore(dir);
  assert.deepEqual(t.open(), [u]);
  t.put({ ...pending, prepays: [{ ...pending.prepays[0]!, ok: true }] });
  assert.deepEqual(t.open(), []);
  t.close();
});

// ---- F56: one hash, two outcomes; a prepay's receipt read from blocks ----

test("receiptIdOf: nearcore's receipt id for a transaction at a height (F64's live vector)", () => {
  assert.equal(receiptIdOf("6jvSQwan375v77pzg53GGnbGGKjQEoq7THEmjnSGCwzV", 221_384_610n), "A2mdwHyTn7Thxtk4AF8MbN2ahqftwh5xVWrozdLseoAo");
  assert.notEqual(receiptIdOf("6jvSQwan375v77pzg53GGnbGGKjQEoq7THEmjnSGCwzV", 221_384_611n), "A2mdwHyTn7Thxtk4AF8MbN2ahqftwh5xVWrozdLseoAo");
});

type Edit = (method: string, params: Record<string, unknown>, real: () => Promise<unknown>) => Promise<unknown>;
/**
 * Every provider, the archival one included, answering `tx` with the transaction_outcome at another block (F56); `edit`
 * then changes the regular providers' answers (provider `one` only, when given).
 */
function x1Relayer(node: Node, edit?: Edit, one?: 0 | 1) {
  const x1 = node.bh(990n);
  const named = (q: Rpc): Rpc => async (m, p) => {
    const a = await q(m, p);
    return m === "tx" ? { ...(a as object), transaction_outcome: { ...(a as { transaction_outcome: object }).transaction_outcome, block_hash: x1 } } : a;
  };
  const rs = node.rpcs().map(named).map((q, i) => (edit === undefined || (one !== undefined && one !== i) ? q : (((m: string, p: unknown) => edit(m, p as Record<string, unknown>, () => q(m, p as never))) as Rpc)));
  return createRelayer([rs[0]!, rs[1]!], named(node.archival()), RELAYER, node.secret, VAULT, node.validity, node.relayerStore, 50);
}
/** A prepay applied at D with its vault receipt at E, sent and read final by a relayer whose lookups name D. */
async function prepaid(node: Node) {
  const tx: TxRef[] = [];
  assert.equal((await node.relayer(50).send(prepayAction(1n), open, keep(tx))).kind, "final");
  const r = receiptIdOf(tx[0]!.tx_hash, node.appliedAt(tx[0]!.tx_hash)!);
  return { tx: tx[0]!, r, e: node.vaultChanges.find((c) => c.cause.receipt_hash === r)!.height };
}

test("RC3-6 (F56): a prepay applied at D whose every lookup names another block is read final from blocks: r from its hash and D's height, E where the vault's changes name r", async () => {
  const node = new Node();
  const tx: TxRef[] = [];
  assert.equal((await node.relayer(50).send(prepayAction(1n), open, keep(tx))).kind, "final");
  const out = await x1Relayer(node).resolve(tx[0]!, noResend);
  assert.equal(out.kind, "final");
  const rs = (out as { receipts: Receipt[] }).receipts;
  assert.deepEqual(rs.map((x) => [x.executor, x.ok]), [[VAULT, true]]);
  assert.equal(rs[0]!.height, node.vaultChanges.find((c) => c.cause.receipt_hash === receiptIdOf(tx[0]!.tx_hash, node.appliedAt(tx[0]!.tx_hash)!))!.height);
});

test("F56: no block up to F naming r keeps the round (r pending); the vault's changes naming r only under its gas reward (F61: a failed call is rolled back, its reward kept) read the receipt as failed", async () => {
  const node = new Node();
  const tx: TxRef[] = [];
  assert.equal((await node.relayer(50).send(prepayAction(1n), open, keep(tx))).kind, "final");
  node.vaultChanges = node.vaultChanges.filter((c) => c.cause.type === "action_receipt_gas_reward");
  const e = node.vaultChanges[0]!.height;
  node.vaultChanges.push({ height: e, cause: { type: "receipt_processing", receipt_hash: "another receipt in E" } });
  const d = node.appliedAt(tx[0]!.tx_hash)!;
  node.finalLag = [node.final - d, node.final - d]; // F = D: E is not final yet
  const r = x1Relayer(node);
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown", "r pending");
  node.finalLag = [0n, 0n];
  const out = await r.resolve(tx[0]!, noResend);
  assert.equal(out.kind, "final");
  assert.deepEqual((out as { receipts: Receipt[] }).receipts.map((x) => [x.executor, x.ok]), [[VAULT, false]]);
});

test("F56: a delegate whose every lookup names another block keeps the round (its receipts run on U, the token and the vault, so no single block read gives its outcome)", async () => {
  const node = new Node();
  const tx: TxRef[] = [];
  const signedDelegate = Buffer.from(signed(node.user(), P, 101n, node.final + 100n).signed_delegate, "base64");
  assert.equal((await node.relayer(50).send({ kind: "delegate", signed: signedDelegate, receiver: "ab".repeat(32) }, open, keep(tx))).kind, "final");
  const d = node.appliedAt(tx[0]!.tx_hash)!;
  node.vaultChanges.push({ height: d + 1n, cause: { type: "receipt_processing", receipt_hash: receiptIdOf(tx[0]!.tx_hash, d) } });
  assert.equal((await x1Relayer(node).resolve(tx[0]!, noResend)).kind, "unknown");
});

test("F56: block reads that cannot be trusted keep the round: another hash, the providers disagreeing, a gap the next block does not show, a block past F", async () => {
  const cases: [string, (node: Node, e: bigint) => [Edit, (0 | 1)?]][] = [
    ["account_changes at E under another block's hash", (node, e) => [async (m, p, real) => {
      const a = await real();
      return m === "EXPERIMENTAL_changes" && p.changes_type === "account_changes" && p.block_id === Number(e) ? { ...(a as object), block_hash: node.bh(e + 7n) } : a;
    }, 1]],
    ["the first provider's list at E empty while the other's names r", (_node, e) => [async (m, p, real) => {
      const a = await real();
      return m === "EXPERIMENTAL_changes" && p.changes_type === "account_changes" && p.block_id === Number(e) ? { ...(a as object), changes: [] } : a;
    }, 0]],
    ["the second provider's list at E empty while the other's names r", (_node, e) => [async (m, p, real) => {
      const a = await real();
      return m === "EXPERIMENTAL_changes" && p.changes_type === "account_changes" && p.block_id === Number(e) ? { ...(a as object), changes: [] } : a;
    }, 1]],
    ["block E's prev_height naming a gap that is not there, on both", (_node, e) => [async (m, p, real) => {
      const a = (await real()) as { header?: Record<string, unknown> };
      return m === "block" && p.block_id === Number(e) ? { header: { ...a.header, prev_height: Number(e) - 2 } } : a;
    }]],
    ["E above F (final on both is D), though both serve E by height", (_node, e) => [async (m, p, real) => {
      if (m === "block" && p.block_id === undefined) return real().then(() => ({ header: { height: Number(e) - 1, hash: _node.bh(e - 1n), prev_height: Number(_node.prevOf(e - 1n)) } }));
      return real();
    }]],
  ];
  for (const [name, make] of cases) {
    const node = new Node();
    const { tx, e } = await prepaid(node);
    const [edit, one] = make(node, e);
    assert.equal((await x1Relayer(node, edit, one).resolve(tx, noResend)).kind, "unknown", name);
    assert.equal((await x1Relayer(node).resolve(tx, noResend)).kind, "final", `${name}: the same record read final once the answers are good`);
  }
});

// ---- the a984d9e re-check (RC4) ----

test("RC4-1: an unreadable u-*.json never stops a start: it counts as open, the round keeps it, and the store opens again in this process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-rc4-"));
  const s = createFileStore(dir);
  s.put({ ...emptyRecord("ab".repeat(32)) });
  s.close();
  writeFileSync(join(dir, `u-${"cd".repeat(32)}.json`), "{ torn");
  writeFileSync(join(dir, `u-${"ef".repeat(32)}.json`), "null");
  const t = createFileStore(dir);
  assert.deepEqual(t.open().sort(), ["cd".repeat(32), "ef".repeat(32)]);
  const node = new Node();
  await lockRound(node.deps(t, node.relayer(50))); // the round's own catch keeps each
  assert.deepEqual(t.open().sort(), ["cd".repeat(32), "ef".repeat(32)]);
  t.put({ ...emptyRecord("cd".repeat(32)) }); // an unreadable record can still be written over
  assert.deepEqual(t.open(), ["ef".repeat(32)]);
  t.close();
  createFileStore(dir).close();
});

test("RC4-1: a start that throws once the lock is held gives the lock up, so this process can open the store again", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-rc4-throw-"));
  createFileStore(dir).close();
  const failing = { ...nodeFs, readdirSync: (() => { throw new Error("EIO: the directory cannot be read"); }) as unknown as typeof nodeFs.readdirSync };
  assert.throws(() => createFileStore(dir, failing), /EIO/);
  createFileStore(dir).close();
});

/** Moves a prepay's vault receipt from D+1 to D+gap+1, the heights between with no block (`skip`) or quiet blocks. */
async function farE(node: Node, gap: bigint, skip: boolean) {
  const { tx, e } = await prepaid(node);
  const d = e - 1n;
  for (const c of node.vaultChanges) if (c.height === e) c.height = d + gap + 1n;
  if (skip) for (let h = d + 1n; h <= d + gap; h++) node.skipped.add(h);
  node.final = d + gap + 20n;
  return { tx, d };
}

test("RC4-2: F56 across a run of heights with no block longer than one round's reads: the next round goes on from the next height, so E is found", async () => {
  const seen: string[] = [];
  for (const gap of [150n, 250n, 450n]) {
    const node = new Node();
    const { tx } = await farE(node, gap, true);
    const r = x1Relayer(node);
    const kinds: string[] = [];
    while (kinds.length < 4 && kinds.at(-1) !== "final") kinds.push((await r.resolve(tx, noResend)).kind);
    seen.push(`gap ${gap}: ${kinds.join(",")}`);
  }
  assert.deepEqual(seen, ["gap 150: final", "gap 250: unknown,final", "gap 450: unknown,unknown,final"]);
});

test("RC4-3: F56 with E 450 quiet blocks after D: each round goes on from where the last stopped, found on the third; a restarted relayer reads again from D", async () => {
  const node = new Node();
  const { tx } = await farE(node, 450n, false);
  for (const name of ["first", "restarted"]) {
    const r = x1Relayer(node);
    const kinds: string[] = [];
    for (let i = 0; i < 3; i++) kinds.push((await r.resolve(tx, noResend)).kind);
    assert.deepEqual(kinds, ["unknown", "unknown", "final"], name);
  }
});

test("L4: a D the relayer stored is deleted once its entry closes (a verdict written, or the entry dropped from the record)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-d-"));
  const s = createFileStore(dir);
  const u = "ab".repeat(32);
  const entry = (tx: string, ok: boolean | null) => ({ tx_hash: tx, nonce: "1", height: "1", block_hash: "h", signed_tx: "", bytes: 756, ok });
  const [a, b] = ["11111111111111111111111111111111", "22222222222222222222222222222222"];
  const send = { tx_hash: "33333333333333333333333333333333", nonce: "3", height: "1", block_hash: "h", signed_tx: "", sha256: "x", amount: "1", max_block_height: "9", state: "pending" as const, counted: true };
  for (const t of [a, b, send.tx_hash]) s.setFoundAt(t, { height: "5", hash: "D" });
  const ds = () => readdirSync(dir).filter((f) => f.startsWith("d-")).sort();
  s.put({ ...emptyRecord(u), prepays: [entry(a, null), entry(b, null)], sends: [send] });
  assert.equal(ds().length, 3, "open entries keep their D");
  s.put({ ...emptyRecord(u), prepays: [entry(a, true), entry(b, null)], sends: [send] });
  assert.deepEqual(ds(), [`d-${b}.json`, `d-${send.tx_hash}.json`].sort(), "a verdict deletes its D");
  s.put({ ...emptyRecord(u), prepays: [entry(a, true)], sends: [send] });
  assert.deepEqual(ds(), [`d-${send.tx_hash}.json`], "an entry dropped from the record deletes its D");
  s.put({ ...emptyRecord(u), prepays: [entry(a, true)], sends: [{ ...send, state: "landed" as const }] });
  assert.deepEqual(ds(), []);
  assert.equal(s.foundAt(b), null);
  // a record that could not be read is written over with a closed entry: its D goes too
  s.setFoundAt(b, { height: "5", hash: "D" });
  writeFileSync(join(dir, `u-${u}.json`), "{ torn");
  s.put({ ...emptyRecord(u), prepays: [entry(b, false)] });
  assert.deepEqual(ds(), []);
  s.close();
});

test("L4: a deposit carried through a lookup that lags past D leaves no D in the store once its entries close", async () => {
  const node = new Node();
  const dir = mkdtempSync(join(tmpdir(), "bind-d-carry-"));
  const store = createFileStore(dir);
  node.landMs = () => 1_500;
  const relayer = createRelayer(node.rpcs(), node.archival(), RELAYER, node.secret, VAULT, node.validity, store, 300);
  const deps = node.deps(store, relayer);
  const u = node.user();
  const sd = signed(u, P, 101n, node.final + 100n);
  assert.equal(code(await carryDeposit(sd, deps)), "in_flight");
  await until(() => node.prepaid.get(P.toString()) === PREPAY_BYTES);
  const prepay = store.get(u.id)!.prepays[0]!.tx_hash;
  node.hideTx.set(prepay, 1_000); // applied at D, the lookups not there yet
  assert.equal(code(await carryDeposit(sd, deps)), "in_flight");
  assert.ok(existsSync(join(dir, `d-${prepay}.json`)), "D stored while the entry is open");
  node.landMs = () => 1;
  node.hideTx.delete(prepay);
  for (let i = 0; i < 5 && code(await carryDeposit(sd, deps)) !== "ok"; i++);
  assert.equal(store.get(u.id)!.landed, true);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("d-")), []);
  store.close();
});

test("(a2): K deleted before the transaction was applied: the deletion at D names no transaction of ours, so it is dropped", async () => {
  const node = new Node();
  const r = node.relayer(50);
  const tx = await unsent(node, r);
  node.deleteKey();
  await r.resolve(tx, resend);
  await sleepMs(10);
  assert.equal(node.log.at(-1)!.dropped, "InvalidAccessKey");
  assert.equal((await r.resolve(tx, noResend)).kind, "dropped");
});

test("K deleted after the transaction was applied: D is its block, the change there names it, and it reads final", async () => {
  const node = new Node();
  const r = node.relayer(50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "final");
  node.deleteKey();
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "final");
});

test("an applied prepay whose one provider's lookup names a block other than D is read from blocks (F56), never from that lookup", async () => {
  const node = new Node();
  const rs = edited(node, 0, async (m, _p, real) => {
    const a = await real();
    return m === "tx" ? { ...(a as object), transaction_outcome: { block_hash: node.bh(999n) } } : a;
  });
  const r = node.relayerOn(rs, 50);
  const tx: TxRef[] = [];
  const out = await r.send(prepayAction(1n), open, keep(tx));
  assert.equal(out.kind, "final");
  assert.deepEqual((out as { receipts: Receipt[] }).receipts.map((x) => [x.executor, x.ok]), [[VAULT, true]]);
});

test("an empty change list at D, on one provider or on both (save_state_changes off, F54), keeps the round", async () => {
  const node = new Node();
  node.noChanges.add(1);
  const r = node.relayer(50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  node.noChanges.add(0);
  node.final += 150n;
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "unknown");
  node.noChanges.clear();
  assert.equal((await r.resolve(tx[0]!, noResend)).kind, "final");
});

test("D is found once: a restart's relayer reads it from the store and needs no search", async () => {
  const node = new Node();
  node.landMs = () => 1;
  const tx: TxRef[] = [];
  const first = node.relayer(50);
  sendDown(node, () => true);
  assert.equal((await first.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  node.fail = undefined;
  node.hideTx.set(tx[0]!.tx_hash, 3); // the lookups lag one round
  await first.resolve(tx[0]!, resend);
  await sleepMs(10);
  node.final += 30n;
  assert.equal((await first.resolve(tx[0]!, noResend)).kind, "unknown", "applied at D, its lookups behind");
  let searched = 0;
  const d = node.appliedAt(tx[0]!.tx_hash)!;
  const rs = node.rpcs().map((r) => (async (m: string, p: unknown) => {
    const h = (p as { block_id?: unknown }).block_id;
    if (m === "query" && typeof h === "number" && BigInt(h) > 1000n && BigInt(h) < node.final) searched++;
    return r(m, p);
  }) as Rpc) as [Rpc, Rpc];
  const restarted = node.relayerOn(rs, 50);
  assert.equal((await restarted.resolve(tx[0]!, noResend)).kind, "final");
  assert.equal(searched, 0, `D (${d}) read from the store`);
});

test("the nonce counter: a restart while a transaction is in flight signs the next nonce, never the same one", async () => {
  const node = new Node();
  node.landMs = () => 200;
  const a: TxRef[] = [];
  const outA = node.relayer(50).send(prepayAction(1n), open, keep(a)); // in flight when the process restarts
  await sleepMs(20);
  const b: TxRef[] = [];
  await node.relayer(50).send(prepayAction(2n), open, keep(b)); // the restart: a new relayer on the same store
  await outA;
  await sleepMs(250);
  assert.deepEqual([a[0]!.nonce, b[0]!.nonce], ["11", "12"]);
  assert.equal(node.log.filter((x) => x.dropped !== undefined).length, 0, "both land");
});

test("the nonce counter: two signers on one key at once never both take n; the one that loses the compare-and-set takes the next", async () => {
  const node = new Node();
  node.landMs = () => 30;
  assert.equal((await node.relayer(QUEUED_WAIT_MS).send(prepayAction(9n), open, () => undefined)).kind, "final"); // the counter holds 12
  const tx: TxRef[] = [];
  const outs = await Promise.all([node.relayer(QUEUED_WAIT_MS).send(prepayAction(1n), open, keep(tx)), node.relayer(QUEUED_WAIT_MS).send(prepayAction(2n), open, keep(tx))]);
  assert.deepEqual(outs.map((o) => o.kind), ["final", "final"]);
  assert.deepEqual(tx.map((x) => x.nonce).sort(), ["12", "13"]);
  assert.equal(node.relayerStore.nonceNext(`${RELAYER}/ed25519:${base58(relayerKey(node.secret).pub)}`), 14n);
});

test("F58: the relayer refuses to sign a nonce at or above b0 x 10^6; nothing is written or sent", async () => {
  const node = new Node();
  const r = node.relayer(50);
  node.keyNonce = (node.final + 1n) * 1_000_000n - 2n; // n = b0 x 10^6 - 1, with b0 the block the key changed at
  const wrote: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(wrote))).kind, "final");
  node.keyNonce = (node.final + 1n) * 1_000_000n - 1n; // n = b0 x 10^6
  await assert.rejects(r.send(prepayAction(2n), open, keep(wrote)), /10\^6/);
  assert.deepEqual([wrote.length, node.sent.length], [1, 1]);
});

test("a gas account key that is not full-access at final is refused at signing; nothing is written or sent", async () => {
  const node = new Node();
  const rs = edited(node, 0, async (m, p, real) => (m === "query" && p.request_type === "view_access_key" && p.finality === "final" ? { ...((await real()) as object), permission: { FunctionCall: { allowance: null, receiver_id: VAULT, method_names: [] } } } : real()));
  const wrote: TxRef[] = [];
  await assert.rejects(node.relayerOn(rs, 50).send(prepayAction(1n), open, keep(wrote)), /not a full-access key/);
  assert.deepEqual([wrote.length, node.sent.length], [0, 0]);
});

test("the store's nonce counter: a compare-and-set on the value read, durable across a reopen; a set from a stale value writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-counter-"));
  const s = createFileStore(dir);
  const k = "bind.test.near/ed25519:11111111111111111111111111111111";
  assert.equal(s.nonceNext(k), null);
  assert.equal(s.nonceCas(k, null, 12n), true);
  assert.equal(s.nonceCas(k, null, 13n), false);
  assert.equal(s.nonceCas(k, 11n, 13n), false);
  assert.equal(s.nonceNext(k), 12n);
  assert.equal(s.nonceCas(k, 12n, 13n), true);
  s.close();
  const t = createFileStore(dir);
  assert.equal(t.nonceNext(k), 13n);
  t.close();
});

test("U's key read: nearcore answers an absent key with a result holding `error`; it reads as no key, and any other error is refused", async () => {
  const at = (answer: unknown): Rpc => async (m) => (m === "block" ? { header: { height: 5 } } : answer);
  const absent = { block_hash: "h", block_height: 5, error: "access key ed25519:x does not exist while viewing", logs: [] };
  const reads = (a: unknown, b: unknown) => createSendReads([at(a), at(b)], { vault: VAULT, token: VAULT_TOKEN });
  assert.deepEqual(await reads(absent, absent).accessKey("ab".repeat(32), "ed25519:x"), { kind: "no_key" });
  await assert.rejects(reads({ ...absent, error: "something else" }, { ...absent, error: "something else" }).accessKey("ab".repeat(32), "ed25519:x"));
  await assert.rejects(reads(absent, { nonce: 5, permission: "FullAccess", block_height: 5, block_hash: "h" }).accessKey("ab".repeat(32), "ed25519:x"), /disagree/);
});

test("createRelayer refuses a key whose public half is not its seed's", () => {
  relayerKey(relayerSecret());
  const raw = base58decode(relayerSecret().slice(8));
  raw[63] = raw[63]! ^ 1;
  assert.throws(() => relayerKey("ed25519:" + base58(raw)), /public half/);
  const node = new Node();
  assert.throws(() => createRelayer(node.rpcs(), node.archival(), RELAYER, "ed25519:" + base58(raw), VAULT, node.validity, node.relayerStore), /public half/);
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
    { block_hash: node.bh(1_500n), outcome: { executor_id: "u", status: { SuccessReceiptId: "r" } } },
    { block_hash: "y", outcome: { executor_id: VAULT, status: { Failure: { ActionError: {} } } } },
  ];
  const [r0, r1] = node.rpcs();
  const over: Rpc = async (m, p) => {
    if (m === "tx") {
      const at = node.appliedAt((p as { tx_hash: string }).tx_hash);
      if (at === undefined) throw unknownTx();
      return { final_execution_status: "FINAL", transaction_outcome: { block_hash: node.bh(at) }, receipts_outcome: outcomes };
    }
    return m === "block" && (p as { block_id?: string }).block_id === "y" ? { header: { height: 7777 } } : r0(m, p);
  };
  const r = node.relayerOn([over, r1]);
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

test("a vault call read from blocks only (the withdrawal relayer's fromBlocks): no lookup by hash, its receipt found at E with E's time from timestamp_nanosec; wait false answers once sent", async () => {
  const node = new Node();
  const r = node.relayer(2_000);
  const sent = await r.send(prepayAction(1n), open, () => undefined, { wait: false });
  assert.equal(sent.kind, "unknown");
  const tx: TxRef[] = [];
  const out = await r.send(prepayAction(2n), open, keep(tx), { fromBlocks: true });
  assert.equal(out.kind, "final");
  if (out.kind !== "final") return;
  assert.equal(out.receipts.length, 1);
  const e = out.receipts[0]!;
  assert.equal(e.executor, VAULT);
  assert.equal(e.ok, true);
  assert.equal(e.ms, 1_700_000_000_000n + e.height * 600n, "E's time: timestamp_nanosec / 10^6, the sub-ms part dropped");
  assert.equal(node.lookups, 0, "never a lookup by hash");
  const again = await r.resolve(tx[0]!, { resend: false, fromBlocks: true });
  assert.equal(again.kind, "final");
  assert.equal(node.lookups, 0);
});

test("from blocks, the two providers' block times must agree: a block whose time differs on them gives no final outcome", async () => {
  const node = new Node();
  const r = node.relayer(2_000);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx), { fromBlocks: true })).kind, "final");
  node.msSkew[1] = 1n;
  const out = await r.resolve(tx[0]!, { resend: false, fromBlocks: true }).catch((e: Error) => ({ kind: "threw", why: e.message }));
  assert.notEqual(out.kind, "final", JSON.stringify(out));
  node.msSkew[1] = 0n;
  assert.equal((await r.resolve(tx[0]!, { resend: false, fromBlocks: true })).kind, "final");
});

test("from blocks reads only a transaction to the vault: one to any other receiver is refused", async () => {
  const node = new Node();
  const r = node.relayer(2_000);
  const tx: TxRef[] = [];
  const call = (receiver: string) => r.send({ kind: "call", receiver, method: "m", args: "{}", gas: 30_000_000_000_000n, deposit: 0n }, open, keep(tx), { fromBlocks: true }).catch((e: Error) => ({ kind: "threw", why: e.message }));
  // the same call to the vault reads final from its receipt in the vault's changes; to another receiver, the vault's
  // changes are never read for it, however they read
  assert.equal((await call(VAULT)).kind, "final");
  const out = await call("other.test.near");
  assert.notEqual(out.kind, "final", JSON.stringify(out));
  assert.notEqual((await r.resolve(tx[1]!, { resend: false, fromBlocks: true })).kind, "final");
});

test("a FunctionCall encodes as nearcore's Action::FunctionCall: tag 2, method, args, gas u64, deposit u128; gas past 300 Tgas or a deposit past u128 refused", () => {
  const a = encodeAction({ kind: "call", receiver: VAULT, method: "settle", args: '{"nullifier_hash":"1"}', gas: 150_000_000_000_000n, deposit: 148n * 10n ** 19n });
  const le = (n: bigint, len: number) => Buffer.from(Array.from({ length: len }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn)));
  const str = (x: string) => Buffer.concat([le(BigInt(Buffer.byteLength(x)), 4), Buffer.from(x)]);
  assert.deepEqual(a, Buffer.concat([Buffer.from([2]), str("settle"), str('{"nullifier_hash":"1"}'), le(150_000_000_000_000n, 8), le(148n * 10n ** 19n, 16)]));
  assert.throws(() => encodeAction({ kind: "call", receiver: VAULT, method: "m", args: "{}", gas: 300_000_000_000_001n, deposit: 0n }), /gas/);
  assert.throws(() => encodeAction({ kind: "call", receiver: VAULT, method: "m", args: "{}", gas: 1n, deposit: 1n << 128n }), /deposit/);
});
