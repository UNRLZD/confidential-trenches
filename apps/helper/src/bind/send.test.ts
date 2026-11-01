// send.ts, one case per path of V 2.10 (f)-(i) and M284's R1-R7 (markets H4.3 checks 8-9, M:1755-1868), the idempotent
// answer to a re-send of carried bytes and U's in-flight slot (review R3-3). The chain is a fake that keeps U's key
// nonce, U's USDC, the vault's deposits pages and every relayer transaction in order; delegates are signed with real
// ed25519 so checks 1-7 run as they do live. The sandbox twin is contracts/vault/tests/relayer_send.rs.
//   node --test apps/helper/src/bind/send.test.ts
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { vaultDepositMessage } from "../../../../packages/kit/src/index.ts";
import { NEP366_PREFIX, VAULT_TOKEN, decodeSignedDelegate, type KeyRead } from "./checks.ts";
import {
  MAX_FAILED_SENDS,
  PREPAY_BYTES,
  PREPAY_MAX_BYTES,
  RELAYER_FLOOR_YOCTO,
  USDC_PAUSED,
  base58decode,
  carryDeposit,
  createFileStore,
  encodeAction,
  insertGrows,
  prepayBytes,
  type Answer,
  type DepositStore,
  type Relayer,
  type RelayerAction,
  type SendDeps,
  type SendReads,
  type TxOutcome,
} from "./send.ts";
import { USDC_CODE_HASH, type TokenStatus } from "../token-status/status.ts";

const VAULT = "vault.confidential.unrlzd.near";
const T = 1_000_000_000_000n;
const AMOUNT = 25_000_000n;

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

// ---- the fake chain ----
const OPEN: TokenStatus = { token: VAULT_TOKEN, caught_up: true, halted: false, vault_blocked: false, code_hash_ok: true, code_hash: USDC_CODE_HASH, block_height: 1, last_event: null };
const HALTED: TokenStatus = { ...OPEN, halted: true };

type SendFate = "lands" | "refused_by_vault" | "paused" | "not_included" | "unknown";
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
  prepayFails = false;
  statuses: TokenStatus[] = [OPEN];
  statusAsks = 0;
  /** Runs inside a relayer send, before its outcome (a race). */
  during?: () => Promise<void>;
  /** Final height moves by this after each prepay (R4 after SuccessValue). */
  prepayAdvance = 1n;
  n = 0;

  reads(): SendReads {
    return {
      accessKey: async (a): Promise<KeyRead> => (this.nonce.has(a) ? { kind: "key", permission: "FullAccess", nonce: this.nonce.get(a)! } : { kind: "no_account" }),
      finalHeight: async () => this.final,
      ftBalance: async (a) => this.usdc.get(a) ?? 0n,
      pUsed: async (p) => this.pages.has(p.toString()),
      deposit: async (p) => this.pages.get(p.toString()) ?? null,
      trees: async () => ({ ...this.trees }),
    };
  }
  relayer(): Relayer {
    return {
      account: "bind.test.near",
      balance: async () => this.balance,
      send: async (action, before): Promise<TxOutcome> => {
        const hash = base58(createHash("sha256").update(`tx${this.n++}`).digest());
        before(hash);
        await this.during?.();
        if (action.kind === "storage_prepay") {
          this.txs.push({ action, hash, height: ++this.final });
          if (this.prepayFails) return { kind: "final", tx_hash: hash, receipts: [{ executor: VAULT, ok: false, failure: "InsufficientStorageDeposit" }] };
          const key = action.precommitment.toString();
          this.prepaid.set(key, (this.prepaid.get(key) ?? 0n) + action.bytes);
          this.final += this.prepayAdvance - 1n;
          return { kind: "final", tx_hash: hash, receipts: [{ executor: VAULT, ok: true, failure: "" }, { executor: "bind.test.near", ok: true, failure: "" }] };
        }
        const fate = this.fates.length > 1 ? this.fates.shift()! : this.fates[0]!;
        if (fate === "not_included") return { kind: "refused", tx_hash: hash, why: "InvalidNonce" };
        this.txs.push({ action, hash, height: ++this.final });
        if (fate === "unknown") return { kind: "unknown", tx_hash: hash, why: "timeout" };
        const d = decodeSent(action);
        this.nonce.set(d.u, d.nonce); // the Delegate ran: U's nonce is used
        if (fate === "lands") {
          this.usdc.set(d.u, this.usdc.get(d.u)! - AMOUNT);
          this.pages.set(d.p.toString(), { depositor: d.u, value: AMOUNT });
          this.trees.state++;
          this.trees.label++;
          return { kind: "final", tx_hash: hash, receipts: [{ executor: d.u, ok: true, failure: "" }, { executor: VAULT_TOKEN, ok: true, failure: "" }, { executor: VAULT, ok: true, failure: "" }] };
        }
        const failure = fate === "paused" ? `{"Failure":{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ${USDC_PAUSED}"}}}}}` : `{"Failure":"Smart contract panicked: refused"}`;
        return { kind: "final", tx_hash: hash, receipts: [{ executor: d.u, ok: true, failure: "" }, { executor: fate === "paused" ? VAULT_TOKEN : VAULT, ok: false, failure }] };
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
        return s;
      },
    };
  }
  prepays = () => this.txs.filter((t) => t.action.kind === "storage_prepay");
  sends = () => this.txs.filter((t) => t.action.kind === "delegate");
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}
function decodeSent(a: RelayerAction): { u: string; nonce: bigint; p: bigint } {
  assert.equal(a.kind, "delegate");
  const d = decodeSignedDelegate((a as { signed: Uint8Array }).signed);
  const fc = d.actions[0] as { args: Uint8Array };
  const msg = JSON.parse((JSON.parse(Buffer.from(fc.args).toString("utf8")) as { msg: string }).msg) as { precommitment: string };
  return { u: d.sender_id, nonce: d.nonce, p: BigInt(msg.precommitment) };
}

function world(): { chain: Chain; store: DepositStore; dir: string; u: Key; deps: SendDeps; carry: (req: unknown) => Promise<Answer> } {
  const chain = new Chain();
  const dir = mkdtempSync(join(tmpdir(), "bind-send-"));
  const store = createFileStore(dir);
  const u = newKey();
  chain.nonce.set(u.id, 100n);
  chain.usdc.set(u.id, 10n * AMOUNT);
  const deps = chain.deps(store);
  return { chain, store, dir, u, deps, carry: (req) => carryDeposit(req, deps) };
}
const P = 1234567890123456789012345678901234567890n;
const code = (a: Answer) => ("error" in a.body ? a.body.error.code : "ok");
const ok = (a: Answer) => {
  assert.equal(a.status, 200, JSON.stringify(a));
  return (a.body as { tx_hash: string }).tx_hash;
};
const next = (w: ReturnType<typeof world>) => signed(w.u, P, w.chain.nonce.get(w.u.id)! + 1n, w.chain.final + 100n);

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

test("(h) the prepay, then the send only after its SuccessValue: one prepay of 756 B, the delegate later, the deposit lands", async () => {
  const w = world();
  const h = ok(await w.carry(next(w)));
  assert.deepEqual(w.chain.txs.map((t) => t.action.kind), ["storage_prepay", "delegate"]);
  const [pre, snd] = [w.chain.prepays()[0]!, w.chain.sends()[0]!];
  assert.equal((pre.action as { bytes: bigint }).bytes, PREPAY_BYTES);
  assert.ok(pre.height < snd.height, "never in the same block");
  assert.equal(snd.hash, h);
  const rec = w.store.get(w.u.id)!;
  assert.deepEqual([rec.prepaid_bytes, rec.failed, rec.landed, rec.struck], [756, 0, true, false]);
  rmSync(w.dir, { recursive: true });
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

test("(h) R4: under the margin K after the prepay's SuccessValue: resign_needed, no send, not counted; the re-signed call is not prepaid again", async () => {
  const w = world();
  w.chain.prepayAdvance = 90n; // the final height moves past max_block_height - K during the prepay
  assert.equal(code(await w.carry(next(w))), "resign_needed");
  assert.equal(w.chain.sends().length, 0);
  assert.deepEqual([w.store.get(w.u.id)!.failed, w.store.get(w.u.id)!.prepaid_bytes], [0, 756]);
  w.chain.prepayAdvance = 1n;
  ok(await w.carry(next(w)));
  assert.equal(w.chain.prepays().length, 1, "no second prepay");
});

test("(h) R4 before the prepay: under K, nothing prepaid", async () => {
  const w = world();
  const req = signed(w.u, P, 101n, w.chain.final + 25n);
  w.chain.final += 6n; // checks pass at 25 ahead; by the prepay it is 19
  const d = w.deps;
  const fh = d.reads.finalHeight;
  let asks = 0;
  d.reads.finalHeight = async () => (asks++ === 0 ? w.chain.final - 6n : fh());
  assert.equal(code(await carryDeposit(req, d)), "resign_needed");
  assert.equal(w.chain.txs.length, 0);
});

// ---- the idempotent answer and U's in-flight slot ----

test("a re-send of carried bytes answers 200 with that tx_hash, before check 3 (U's nonce moved), and sends nothing", async () => {
  const w = world();
  const req = next(w);
  const h = ok(await w.carry(req));
  const n = w.chain.txs.length;
  assert.equal(ok(await w.carry(req)), h);
  // after a restart: a new store on the same directory
  assert.equal(ok(await carryDeposit(req, { ...w.deps, store: createFileStore(w.dir) })), h);
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

test("R3-3: two binds sending the same bytes at once get one send between them, and it counts once", async () => {
  const w = world();
  const req = next(w);
  const [a, b] = await Promise.all([w.carry(req), w.carry(req)]);
  const codes = [code(a), code(b)].sort();
  assert.ok(codes[0] === "in_flight" || (code(a) === "ok" && code(b) === "ok"), JSON.stringify(codes));
  assert.equal(w.chain.sends().length, 1);
  assert.equal(w.store.get(w.u.id)!.failed, 0);
  assert.equal(ok(await w.carry(req)), w.chain.sends()[0]!.hash);
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
  assert.equal(w.store.get(w.u.id)!.failed, 0);
});

// ---- (f) the token's hold ----

test("(f) held at check 9: 503 token_halted, nothing prepaid, sent or counted, no record", async () => {
  const w = world();
  w.chain.statuses = [HALTED];
  const a = await w.carry(next(w));
  assert.deepEqual([a.status, code(a)], [503, "token_halted"]);
  assert.equal(w.chain.txs.length, 0);
  assert.equal(w.store.get(w.u.id), null);
  for (const s of [{ ...OPEN, caught_up: false }, { ...OPEN, vault_blocked: null }, { ...OPEN, code_hash: "x" }]) {
    w.chain.statuses = [s];
    w.chain.statusAsks = 0;
    assert.equal(code(await w.carry(next(w))), "token_halted");
  }
  assert.equal(w.chain.txs.length, 0);
});

test("(f) held between the prepay and the send: no send, not counted; once open, the same P goes with no new prepay", async () => {
  const w = world();
  w.chain.statuses = [OPEN, OPEN, HALTED]; // check 9, before the prepay, before the send
  assert.equal(code(await w.carry(next(w))), "token_halted");
  assert.deepEqual(w.chain.txs.map((t) => t.action.kind), ["storage_prepay"]);
  assert.equal(w.store.get(w.u.id)!.failed, 0);
  w.chain.statuses = [OPEN];
  w.chain.statusAsks = 0;
  ok(await w.carry(next(w)));
  assert.deepEqual(w.chain.txs.map((t) => t.action.kind), ["storage_prepay", "delegate"]);
});

// ---- (g) the simulation ----

test("(g) U's USDC below the amount at the simulation: amount_above_balance, nothing prepaid", async () => {
  const w = world();
  const d = w.deps;
  let asks = 0;
  d.reads.ftBalance = async () => (asks++ === 0 ? 10n * AMOUNT : AMOUNT - 1n); // check 6 reads enough, the simulation not
  assert.equal(code(await carryDeposit(next(w), d)), "amount_above_balance");
  assert.equal(w.chain.txs.length, 0);
});

test("(g) U's key nonce moved to the call's nonce by the simulation: bad_nonce, nothing prepaid", async () => {
  const w = world();
  const d = w.deps;
  const req = next(w);
  let asks = 0;
  d.reads.accessKey = async () => ({ kind: "key", permission: "FullAccess", nonce: asks++ === 0 ? 100n : 101n });
  assert.equal(code(await carryDeposit(req, d)), "bad_nonce");
  assert.equal(w.chain.txs.length, 0);
});

// ---- (i) three failed sends ----

test("(i) three failed sends strike U: each retry topped up to 904 B first, never above 904 B; then sender_struck with no send", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault"];
  for (let i = 1; i <= MAX_FAILED_SENDS; i++) {
    ok(await w.carry(next(w)));
    const rec = w.store.get(w.u.id)!;
    assert.equal(rec.failed, i);
    assert.equal(rec.prepaid_bytes, i === 1 ? 756 : 904);
    assert.equal(rec.struck, i === MAX_FAILED_SENDS);
  }
  assert.deepEqual(w.chain.prepays().map((t) => (t.action as { bytes: bigint }).bytes), [756n, 148n]);
  assert.equal(w.chain.prepaid.get(P.toString()), PREPAY_MAX_BYTES);
  const n = w.chain.txs.length;
  const a = await w.carry(next(w));
  assert.deepEqual([a.status, code(a)], [403, "sender_struck"]);
  // on any P, and after a restart
  assert.equal(code(await carryDeposit(signed(w.u, P + 7n, w.chain.nonce.get(w.u.id)! + 1n, w.chain.final + 100n), { ...w.deps, store: createFileStore(w.dir) })), "sender_struck");
  assert.equal(w.chain.txs.length, n);
});

test("(i) a send that fails with USDC's paused error while the watch shows the halt is not counted (R3's exception)", async () => {
  const w = world();
  w.chain.fates = ["paused", "lands"];
  w.chain.statuses = [OPEN, OPEN, OPEN, HALTED]; // check 9, the prepay, the send, the read after the failure
  ok(await w.carry(next(w)));
  assert.equal(w.store.get(w.u.id)!.failed, 0);
  w.chain.statuses = [OPEN];
  w.chain.statusAsks = 0;
  ok(await w.carry(next(w)));
  assert.equal(w.store.get(w.u.id)!.landed, true);
});

test("(i) the paused error while the watch shows USDC open counts", async () => {
  const w = world();
  w.chain.fates = ["paused"];
  ok(await w.carry(next(w)));
  assert.equal(w.store.get(w.u.id)!.failed, 1);
});

test("(i) a failed prepay counts toward the three and closes P: nothing sent on it again", async () => {
  const w = world();
  w.chain.prepayFails = true;
  assert.equal(code(await w.carry(next(w))), "p_used");
  const rec = w.store.get(w.u.id)!;
  assert.deepEqual([rec.failed, rec.p_closed, rec.prepaid_bytes], [1, true, 0]);
  w.chain.prepayFails = false;
  assert.equal(code(await w.carry(next(w))), "p_used");
  assert.equal(w.chain.sends().length, 0);
  assert.equal(w.chain.prepays().length, 1);
});

test("(i) a send refused before inclusion is not counted; one with no FINAL answer stays counted (R7: written before the send)", async () => {
  const w = world();
  w.chain.fates = ["not_included", "unknown"];
  await assert.rejects(w.carry(next(w)), /refused before inclusion/);
  assert.equal(w.store.get(w.u.id)!.failed, 0);
  ok(await w.carry(next(w)));
  assert.equal(w.store.get(w.u.id)!.failed, 1);
});

test("R7: a count written before a send survives a crash in it (the process dies before the outcome)", async () => {
  const w = world();
  w.chain.during = async () => {
    w.chain.during = undefined;
    throw new Error("crash");
  };
  await assert.rejects(w.carry(next(w)), /crash/);
  // the crash came during the prepay: its bytes stay counted toward the cap
  assert.equal(w.store.get(w.u.id)!.prepaid_bytes, 756);
  const rec = createFileStore(w.dir).get(w.u.id)!;
  assert.equal(rec.prepays.length, 1);
});

// ---- R1, R2, relayer_low ----

test("R2: a new P for U only once the pages hold U's previous P; R1: a P prepaid for U is refused to another sender", async () => {
  const w = world();
  w.chain.fates = ["refused_by_vault", "lands"];
  ok(await w.carry(next(w)));
  assert.equal(code(await w.carry(signed(w.u, P + 1n, w.chain.nonce.get(w.u.id)! + 1n, w.chain.final + 100n))), "prepay_open");
  const x = newKey();
  w.chain.nonce.set(x.id, 5n);
  w.chain.usdc.set(x.id, AMOUNT);
  assert.equal(code(await w.carry(signed(x, P, 6n, w.chain.final + 100n))), "p_bound");
  ok(await w.carry(next(w))); // lands
  ok(await w.carry(signed(w.u, P + 1n, w.chain.nonce.get(w.u.id)! + 1n, w.chain.final + 100n)));
  assert.equal(w.store.get(w.u.id)!.p, (P + 1n).toString());
});

test("relayer_low: the gas account under one (U, P)'s worst case answers 503 and sends nothing", async () => {
  const w = world();
  w.chain.balance = RELAYER_FLOOR_YOCTO - 1n;
  const a = await w.carry(next(w));
  assert.deepEqual([a.status, code(a)], [503, "relayer_low"]);
  assert.equal(w.chain.txs.length, 0);
});

test("base58decode inverts the checks' base58", () => {
  const b = createHash("sha256").update("x").digest();
  assert.deepEqual(Buffer.from(base58decode(base58(b))), b);
  assert.deepEqual(Buffer.from(base58decode("11" + base58(Buffer.from([1, 2])))), Buffer.from([0, 0, 1, 2]));
});
