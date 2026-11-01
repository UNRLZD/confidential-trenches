// send.ts, one case per path of V 2.10 (f)-(i) and M284's R1-R7 (markets H4.3 checks 8-9, M:1755-1868), the idempotent
// answer to a re-send of carried bytes, U's in-flight slot, the relayer's queue and nonce, the settling of every
// transaction whose outcome was not read, and the store's lock and atomic writes. Most cases run on a fake chain that
// keeps U's key nonce, U's USDC, the vault's deposits pages and every relayer transaction in order; the relayer's own
// cases run createRelayer on two fake providers. Delegates are signed with real ed25519, so checks 1-7 run as they do
// live. The sandbox twin is contracts/vault/tests/relayer_send.rs.
//   node --test apps/helper/src/bind/send.test.ts
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { vaultDepositMessage } from "../../../../packages/kit/src/index.ts";
import { NEP366_PREFIX, VAULT_TOKEN, base58, decodeSignedDelegate, type KeyRead } from "./checks.ts";
import {
  MAX_FAILED_SENDS,
  PREPAY_BYTES,
  PREPAY_MAX_BYTES,
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
  type TxOutcome,
  type TxRef,
} from "./send.ts";
import { USDC_CODE_HASH, type TokenStatus } from "../token-status/status.ts";

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
      resolve: async (tx) => {
        this.resolved.push(tx.tx_hash);
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

test("a send dropped before inclusion frees its bytes: resign_needed, not counted, and the same bytes are carried again", async () => {
  const w = world();
  w.chain.fates = ["dropped", "lands"];
  const req = next(w);
  assert.equal(code(await w.carry(req)), "resign_needed");
  assert.deepEqual([rec(w).sends[0]!.state, rec(w).failed], ["dropped", 0]);
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

test("(i) R3's exception: USDC's own receipt failed with its paused error and the watch, caught up, shows the pause: not counted", async () => {
  const w = world();
  w.chain.fates = ["paused", "lands"];
  w.chain.statuses = [OPEN, OPEN, OPEN, OPEN, HALTED]; // before the checks, check 9, the prepay, the send, the read after it
  ok(await w.carry(next(w)));
  assert.deepEqual([rec(w).failed, rec(w).sends[0]!.state, rec(w).sends[0]!.counted], [0, "exempt", false]);
  w.chain.statuses = [OPEN];
  w.chain.statusAsks = 0;
  ok(await w.carry(next(w)));
  assert.equal(rec(w).landed, true);
});

test("(i) R3's exception reads the watch at the failure's height: unpaused only after it still exempts", async () => {
  const w = world();
  w.chain.fates = ["paused"];
  const unpausedLater: TokenStatus = { ...OPEN, last_event: { name: "unpaused", block_height: 1_000_000, receipt_id: "r" } };
  w.chain.statuses = [OPEN, OPEN, OPEN, OPEN, unpausedLater];
  ok(await w.carry(next(w)));
  assert.deepEqual([rec(w).failed, rec(w).sends[0]!.state], [0, "exempt"]);
  const v = world();
  v.chain.fates = ["paused"];
  const unpausedBefore: TokenStatus = { ...OPEN, last_event: { name: "unpaused", block_height: 5, receipt_id: "r" } };
  v.chain.statuses = [OPEN, OPEN, OPEN, OPEN, unpausedBefore];
  ok(await v.carry(next(v)));
  assert.deepEqual([rec(v).failed, rec(v).sends[0]!.state], [1, "failed"]);
});

test("(i) R3's exception waits for the watch: not caught up, or caught up short of the failure's height, leaves the send pending; a later call settles it", async () => {
  for (const short of [LAGGING, { ...HALTED, block_height: 5 }]) {
    const v = world();
    v.chain.fates = ["paused"];
    v.chain.statuses = [OPEN, OPEN, OPEN, OPEN, short];
    ok(await v.carry(next(v)));
    assert.deepEqual([rec(v).failed, rec(v).sends[0]!.state, rec(v).sends[0]!.counted], [0, "pending", true]);
    v.chain.statuses = [OPEN, OPEN, HALTED]; // before the checks, check 9, the settle's read; the prepay's guard holds
    v.chain.statusAsks = 0;
    assert.equal(code(await v.carry(next(v))), "token_halted");
    assert.deepEqual([rec(v).failed, rec(v).sends[0]!.state], [0, "exempt"]);
  }
});

test("(i) the paused error from a receipt that is not the token's counts, and so does the token's while the watch shows USDC open", async () => {
  const w = world();
  w.chain.fates = ["paused_elsewhere"];
  w.chain.statuses = [OPEN, OPEN, OPEN, OPEN, HALTED];
  ok(await w.carry(next(w)));
  assert.equal(rec(w).failed, 1);
  const v = world();
  v.chain.fates = ["paused"];
  ok(await v.carry(next(v)));
  assert.equal(rec(v).failed, 1);
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

test("M2: a prepay that never went out, dropped at once: rolled back, resign_needed, not counted", async () => {
  const w = world();
  w.chain.prepayFates = ["dropped", "lands"];
  assert.equal(code(await w.carry(next(w))), "resign_needed");
  assert.deepEqual([rec(w).prepaid_bytes, rec(w).prepays.length, rec(w).failed], [0, 0, 0]);
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

test("relayer_low: under 0.3302526 N (one send's gas at 1e9 bought up front plus row 7's worst case) answers 503 and sends nothing", async () => {
  assert.equal(RELAYER_FLOOR_YOCTO, 330_252_600_000_000_000_000_000n);
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

test("M3: one process per store: a second open of the directory is refused while the first holds it, and taken after close", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-lock-"));
  const a = createFileStore(dir);
  assert.throws(() => createFileStore(dir), /held by process/);
  a.close();
  createFileStore(dir).close();
  writeFileSync(join(dir, "lock"), "999999999"); // a lock whose process is gone is taken over
  const c = createFileStore(dir);
  assert.throws(() => createFileStore(dir), /held by process/);
  c.close();
  assert.throws(() => c.put({ u: "ab".repeat(32), p: "1", prepaid_bytes: 0, failed: 0, struck: false, landed: false, p_closed: false, prepays: [], sends: [], carried: [] }), /closed/);
});

test("M4: create-if-absent links a written temp file: the name is whole or absent, EEXIST keeps the first, no temp is left", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-once-"));
  writeFileSync(join(dir, ".tmp-1-0"), "{"); // a temp left by a crash before its link: never read as a record
  const s = createFileStore(dir);
  const u = "ab".repeat(32);
  const r = { u, p: "1", prepaid_bytes: 0, failed: 0, struck: false, landed: false, p_closed: false, prepays: [], sends: [], carried: [] };
  assert.equal(s.get(u), null);
  assert.equal(s.create(r).created, true);
  assert.equal(s.create({ ...r, p: "2" }).created, false);
  assert.equal(s.get(u)!.p, "1");
  assert.equal(s.bind(5n, u), u);
  assert.equal(s.bind(5n, "cd".repeat(32)), u);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(".tmp") && f !== ".tmp-1-0"), []);
  s.close();
  assert.equal(existsSync(join(dir, "lock")), false);
});

// ---- the relayer on two fake providers ----

function relayerSecret(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const j = privateKey.export({ format: "jwk" });
  return "ed25519:" + base58(Buffer.concat([Buffer.from(j.d as string, "base64url"), Buffer.from(j.x as string, "base64url")]));
}
const txNonce = (b64: string) => {
  const b = Buffer.from(b64, "base64");
  return b.readBigUInt64LE(4 + b.readUInt32LE(0) + 33);
};
const nearError = (cause: unknown) => new RpcError("broadcast_tx_async", { name: "HANDLER_ERROR", cause });
type ProviderOpts = {
  /** ms until a broadcast lands */
  landMs?: (b64: string) => number;
  /** an error this provider throws for this call, or undefined */
  fail?: (i: number, method: string, b64?: string) => unknown;
};
/** Two fake providers over one ledger: a broadcast lands after landMs and moves the key's nonce; `tx` reads it. */
function providers(opts: ProviderOpts = {}) {
  const state = { keyNonce: 10n, final: 2_000n, landed: new Map<string, bigint>(), nonces: [] as bigint[] };
  const hashOf = (b64: string) => {
    const b = Buffer.from(b64, "base64");
    return base58(createHash("sha256").update(b.subarray(0, b.length - 65)).digest());
  };
  const mk = (i: number): Rpc => async (method, params) => {
    const b64 = method === "broadcast_tx_async" ? (params as string[])[0]! : undefined;
    const err = opts.fail?.(i, method, b64);
    if (err !== undefined) throw err;
    if (method === "block") {
      const p = params as { block_id?: string };
      return { header: { height: Number(state.final), hash: base58(createHash("sha256").update(`b${p.block_id ?? state.final}`).digest()) } };
    }
    if (method === "query") return { nonce: Number(state.keyNonce), amount: (10n ** 24n).toString(), permission: "FullAccess" };
    if (method === "broadcast_tx_async") {
      const h = hashOf(b64!);
      const n = txNonce(b64!);
      if (!state.nonces.includes(n)) state.nonces.push(n);
      setTimeout(() => {
        if (state.landed.has(h)) return;
        state.final += 3n;
        state.landed.set(h, state.final);
        if (n > state.keyNonce) state.keyNonce = n;
      }, opts.landMs?.(b64!) ?? 1);
      return h;
    }
    if (method === "tx") {
      const h = (params as { tx_hash: string }).tx_hash;
      if (!state.landed.has(h)) throw new RpcError("tx", { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } });
      return { final_execution_status: "FINAL", receipts_outcome: [{ block_hash: "bh", outcome: { executor_id: VAULT, status: { SuccessValue: "" } } }] };
    }
    throw new Error(`fake provider: ${method}`);
  };
  return { state, rpcs: [mk(0), mk(1)] as [Rpc, Rpc] };
}
const prepayAction = (p: bigint): RelayerAction => ({ kind: "storage_prepay", precommitment: p, bytes: 756n });
const open = async () => null;
const keep = (into: TxRef[]) => (t: TxRef) => void into.push(t);

test("H1: the queue is released at the broadcast, not at FINAL: a second send goes out while the first waits, with the next nonce", async () => {
  let first = "";
  const { state, rpcs } = providers({ landMs: (b) => (b === first ? 300 : 1) });
  const r = createRelayer(rpcs, RELAYER, relayerSecret(), VAULT, 3_000);
  const order: string[] = [];
  const a = r.send(prepayAction(1n), open, (tx) => {
    first = tx.signed_tx;
    order.push(`a ${tx.nonce}`);
  });
  void a.then(() => order.push("a final"));
  let landedAtB = -1;
  const b = r.send(prepayAction(2n), open, (tx) => {
    landedAtB = state.landed.size;
    order.push(`b ${tx.nonce}`);
  });
  const [outA, outB] = await Promise.all([a, b]);
  assert.deepEqual([outA.kind, outB.kind], ["final", "final"]);
  assert.equal(landedAtB, 0, "b signed before a landed");
  assert.deepEqual(order.slice(0, 2), ["a 11", "b 12"], "b signed and sent before a's FINAL");
});

test("H1: the guard runs in the queue right before signing; a guarded call signs, writes and sends nothing", async () => {
  const { state, rpcs } = providers();
  const r = createRelayer(rpcs, RELAYER, relayerSecret(), VAULT, 2_000);
  const wrote: TxRef[] = [];
  const out = await r.send(prepayAction(1n), async () => "resign_needed", keep(wrote));
  assert.deepEqual([out.kind, (out as { code: string }).code, wrote.length, state.nonces.length], ["guarded", "resign_needed", 0, 0]);
  await r.send(prepayAction(2n), open, keep(wrote));
  assert.equal(wrote[0]!.nonce, "11", "a guarded call uses no nonce");
});

test("the durable write comes before the broadcast: a write that fails sends nothing", async () => {
  const { state, rpcs } = providers();
  const r = createRelayer(rpcs, RELAYER, relayerSecret(), VAULT, 1_000);
  await assert.rejects(
    r.send(prepayAction(1n), open, () => {
      throw new Error("ENOSPC");
    }),
    /ENOSPC/,
  );
  assert.equal(state.nonces.length, 0);
});

test("nonces: sends in flight at once get distinct nonces; after a nonce refusal the key is read again", async () => {
  const { state, rpcs } = providers({ landMs: () => 50, fail: (_i, m, b) => (m === "broadcast_tx_async" && txNonce(b!) <= state.keyNonce ? nearError({ name: "INVALID_TRANSACTION", info: { InvalidNonce: {} } }) : undefined) });
  const r = createRelayer(rpcs, RELAYER, relayerSecret(), VAULT, 1_000);
  const outs = await Promise.all([1n, 2n, 3n].map((p) => r.send(prepayAction(p), open, () => undefined)));
  assert.deepEqual(outs.map((o) => o.kind), ["final", "final", "final"]);
  assert.deepEqual(state.nonces, [11n, 12n, 13n]);
  state.keyNonce = 40n; // the key moved past our local next
  const refused = await r.send(prepayAction(4n), open, () => undefined);
  assert.equal(refused.kind, "dropped", "refused on both, its hash unknown on both and the key nonce past it");
  const again: TxRef[] = [];
  assert.equal((await r.send(prepayAction(5n), open, keep(again))).kind, "final");
  assert.equal(again[0]!.nonce, "41");
});

test("PROBE E: one provider names the hash unknown past its nonce while the other cannot be read: unknown, never dropped", async () => {
  let down = new Set<string>(["0:broadcast_tx_async", "1:broadcast_tx_async"]);
  const { state, rpcs } = providers({ fail: (i, m) => (down.has(`${i}:${m}`) ? new Error("fetch failed") : undefined) });
  const r = createRelayer(rpcs, RELAYER, relayerSecret(), VAULT, 50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  state.keyNonce = 11n; // provider 0 reads the key past the tx's nonce and the hash unknown
  down = new Set(["0:broadcast_tx_async", "1:broadcast_tx_async", "1:query", "1:tx"]);
  assert.equal((await r.resolve(tx[0]!)).kind, "unknown");
  down = new Set(["0:broadcast_tx_async", "1:broadcast_tx_async"]);
  assert.equal((await r.resolve(tx[0]!)).kind, "dropped");
});

test("M2/E: one provider refuses the broadcast while the other takes it: the outcome is read, never rolled back on one word", async () => {
  const { state, rpcs } = providers({ fail: (i, m) => (i === 0 && m === "broadcast_tx_async" ? nearError({ name: "INVALID_TRANSACTION", info: { ShardCongested: null } }) : undefined) });
  const r = createRelayer(rpcs, RELAYER, relayerSecret(), VAULT, 2_000);
  const out = await r.send(prepayAction(1n), open, () => undefined);
  assert.equal(out.kind, "final");
  assert.equal(state.landed.size, 1);
});

test("M2/C: a broadcast that reached no provider is unknown; resolve() sends the stored bytes again and reads it landed", async () => {
  let down = true;
  const { state, rpcs } = providers({ fail: (_i, m) => (down && m === "broadcast_tx_async" ? new Error("fetch failed") : undefined) });
  const r = createRelayer(rpcs, RELAYER, relayerSecret(), VAULT, 50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  down = false;
  await r.resolve(tx[0]!); // it goes out now and lands a moment later
  await new Promise((res) => setTimeout(res, 20));
  assert.equal((await r.resolve(tx[0]!)).kind, "final");
  assert.equal(state.landed.size, 1);
});

test("M2/C: dropped only on Expired, or once the key nonce passed the tx's on both providers with its hash unknown on both", async () => {
  let expired = false;
  const { state, rpcs } = providers({
    fail: (_i, m) => (m !== "broadcast_tx_async" ? undefined : expired ? nearError({ name: "INVALID_TRANSACTION", info: { Expired: null } }) : new Error("fetch failed")),
  });
  const r = createRelayer(rpcs, RELAYER, relayerSecret(), VAULT, 50);
  const tx: TxRef[] = [];
  assert.equal((await r.send(prepayAction(1n), open, keep(tx))).kind, "unknown");
  assert.equal((await r.resolve(tx[0]!)).kind, "unknown", "the key nonce is below the tx's");
  state.keyNonce = 11n;
  assert.equal((await r.resolve(tx[0]!)).kind, "dropped");
  state.keyNonce = 0n;
  expired = true;
  assert.equal((await r.resolve(tx[0]!)).kind, "dropped");
});

test("createRelayer refuses a key whose public half is not its seed's", () => {
  relayerKey(relayerSecret());
  const raw = base58decode(relayerSecret().slice(8));
  raw[63] = raw[63]! ^ 1;
  assert.throws(() => relayerKey("ed25519:" + base58(raw)), /public half/);
  assert.throws(() => createRelayer(providers().rpcs, RELAYER, "ed25519:" + base58(raw), VAULT), /public half/);
});

test("the relayer's transaction: borsh Transaction V0 with the ed25519 key tag and one Delegate (tag 8) of the bytes as signed", async () => {
  const { rpcs } = providers();
  const tx: TxRef[] = [];
  const w = world();
  const signedDelegate = Buffer.from(next(w).signed_delegate, "base64");
  w.store.close();
  const r = createRelayer(rpcs, RELAYER, relayerSecret(), VAULT, 1_000);
  await r.send({ kind: "delegate", signed: signedDelegate, receiver: "ab".repeat(32) }, open, keep(tx));
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
  const { rpcs } = providers();
  const outcomes = [
    { block_hash: "x", outcome: { executor_id: "u", status: { SuccessReceiptId: "r" } } },
    { block_hash: "y", outcome: { executor_id: VAULT, status: { Failure: { ActionError: {} } } } },
  ];
  const r0: Rpc = async (m, p) => (m === "tx" ? { final_execution_status: "FINAL", receipts_outcome: outcomes } : m === "block" && (p as { block_id?: string }).block_id === "y" ? { header: { height: 7777 } } : rpcs[0](m, p));
  const r = createRelayer([r0, rpcs[1]], RELAYER, relayerSecret(), VAULT, 1_000);
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
