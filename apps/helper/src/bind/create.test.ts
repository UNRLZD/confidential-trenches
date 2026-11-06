// create.ts: the relayer creates a one-time id only after the delivery, once. The card's five cases (no delivery, under
// MIN_DEPOSIT, an RPC disagreement, an id that exists, one delivery = one Transfer under concurrent calls), then the
// read-back of a Transfer whose outcome is not known, a restart, reads that lag a landed Transfer, the floor, and the
// Transfer's bytes. The gate reads run on two fake providers through deliveryReads (fee.ts agreedBlock, withdraw/send.ts
// accountAt, viewAt), so a disagreement is the real code's refusal; the relayer is a fake whose queue, like
// createRelayer's, holds only the guard, the write and the broadcast, and whose Transfer applies on the chain later.
//   node --test apps/helper/src/bind/create.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CREATE_YOCTO, createOnDelivery, deliveryReads, type CreateDeps } from "./create.ts";
import { MIN_DEPOSIT, base58 } from "./checks.ts";
import { RELAYER_FLOOR_YOCTO, RpcError, createFileStore, encodeAction, type DepositStore, type Relayer, type RelayerAction, type Rpc, type TxOutcome, type TxRef } from "./send.ts";
import { hashOf } from "../../test/token-status/near.ts";

const TOKEN = "usdc.test.near";
const NOW = 1_800_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ids = 0;
const freshId = () => (++ids).toString(16).padStart(64, "a");

/** One chain as two providers see it: per provider, the id's account and balance, and the final height and fork. */
type World = {
  height: number;
  /** Per provider: absent, or an account with its keys. */
  account: [Acct, Acct];
  balance: [string, string];
  fork: [string, string];
  down: [boolean, boolean];
};
type Acct = "absent" | { keys: string[] };

function world(over: Partial<World> = {}): World {
  return { height: 1000, account: ["absent", "absent"], balance: [MIN_DEPOSIT.toString(), MIN_DEPOSIT.toString()], fork: ["", ""], down: [false, false], ...over };
}

function provider(w: World, i: 0 | 1, id: () => string): Rpc {
  return async (method, params) => {
    if (w.down[i]) throw new Error("fetch failed");
    const p = params as Record<string, unknown>;
    const h = p.finality === "final" ? w.height : Number(p.block_id);
    const at = { block_height: h, block_hash: hashOf(h, w.fork[i]) };
    if (method === "block") return { header: { height: h, hash: at.block_hash, prev_height: h - 1, gas_price: "100000000", timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString() } };
    if (method !== "query") throw new Error(`no method ${method}`);
    if (p.account_id !== id() && p.request_type !== "call_function") throw new Error(`a read of another account ${String(p.account_id)}`);
    const a = w.account[i];
    if (p.request_type === "view_account") {
      if (a === "absent") throw new RpcError("query", { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} } });
      return { amount: CREATE_YOCTO.toString(), locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, ...at };
    }
    if (p.request_type === "view_access_key_list") return { keys: a === "absent" ? [] : a.keys.map((k) => ({ public_key: k, access_key: { nonce: 0, permission: "FullAccess" } })), ...at };
    if (p.request_type === "call_function" && p.account_id === TOKEN && p.method_name === "ft_balance_of") {
      const args = JSON.parse(Buffer.from(String(p.args_base64), "base64").toString("utf8")) as { account_id: string };
      assert.equal(args.account_id, id());
      return { result: [...Buffer.from(JSON.stringify(w.balance[i]))], logs: [], ...at };
    }
    throw new Error(`no view ${String(p.method_name)}`);
  };
}

type Sent = { action: RelayerAction; tx: TxRef };

/**
 * A relayer as createRelayer queues it: the guard, the write and the broadcast in one queue; the wait for the outcome
 * outside it. A Transfer applies on the chain `applyMs` after its broadcast (the account appears on both providers,
 * the height moves on) and reads final `finalMs` after it; `outcome` overrides that (unknown: not read in time).
 */
function fakeRelayer(w: World, o: { applyMs?: number; finalMs?: number; outcome?: () => TxOutcome["kind"]; near?: bigint } = {}) {
  let queue: Promise<unknown> = Promise.resolve();
  let n = 0;
  const sent: Sent[] = [];
  const resolved: { tx: string; resend: boolean }[] = [];
  const applied = new Set<string>();
  const outcome = (tx: TxRef): TxOutcome => {
    const kind = o.outcome?.() ?? (applied.has(tx.tx_hash) ? "final" : "unknown");
    if (kind === "final") return { kind, tx_hash: tx.tx_hash, receipts: [{ executor: "x", ok: true, failure: "", height: BigInt(w.height) }] };
    if (kind === "dropped") return { kind, tx_hash: tx.tx_hash, why: "test" };
    return { kind: "unknown", tx_hash: tx.tx_hash, why: "test" };
  };
  const apply = (tx: TxRef) =>
    setTimeout(() => {
      applied.add(tx.tx_hash);
      w.account = [{ keys: ["ed25519:own"] }, { keys: ["ed25519:own"] }];
      w.height += 3;
    }, o.applyMs ?? 20);
  const r: Relayer & { sent: Sent[]; resolved: typeof resolved } = {
    account: "bind.test.near",
    key: "bind.test.near/ed25519:test",
    sent,
    resolved,
    balance: async () => o.near ?? 10n ** 24n,
    async send<C extends string>(action: RelayerAction, guard: () => Promise<C | null>, before: (tx: TxRef) => void) {
      const turn = queue.then(async () => {
        const code = await guard();
        if (code !== null) return { guarded: code };
        n++;
        const tx: TxRef = { tx_hash: base58(createHash("sha256").update(`${r.account} tx ${n} ${ids}`).digest()), nonce: String(n), height: String(w.height), block_hash: hashOf(w.height), signed_tx: Buffer.from(`tx ${n}`).toString("base64") };
        before(tx);
        sent.push({ action, tx });
        if (o.outcome === undefined) apply(tx);
        return { tx };
      });
      queue = turn.catch(() => undefined);
      const t = await turn;
      if ("guarded" in t) return { kind: "guarded" as const, code: t.guarded as C };
      await sleep(o.finalMs ?? 40);
      return outcome(t.tx);
    },
    async resolve(tx, opts) {
      resolved.push({ tx: tx.tx_hash, resend: opts.resend });
      return outcome(tx);
    },
  };
  return r;
}

function setup(over: Partial<World> = {}, o: Parameters<typeof fakeRelayer>[1] = {}) {
  const w = world(over);
  const id = freshId();
  const dir = mkdtempSync(join(tmpdir(), "create-u-"));
  let store: DepositStore = createFileStore(dir);
  const relayer = fakeRelayer(w, o);
  const delivery = deliveryReads([provider(w, 0, () => id), provider(w, 1, () => id)], TOKEN, () => NOW);
  const deps = (): CreateDeps => ({ token: TOKEN, delivery, store, relayer });
  const reopen = () => {
    store.close();
    store = createFileStore(dir);
  };
  return { w, id, relayer, deps, reopen, store: () => store };
}

// ---- The card's five cases ----

test("no delivery: the id holds none of the token, so no Transfer", async () => {
  const s = setup({ balance: ["0", "0"] });
  assert.deepEqual(await createOnDelivery(s.id, s.deps()), { code: "no_delivery" });
  assert.equal(s.relayer.sent.length, 0);
  assert.equal(s.store().creation(s.id), null);
});

test("a delivery under MIN_DEPOSIT: no Transfer; exactly MIN_DEPOSIT: one", async () => {
  const under = setup({ balance: [(MIN_DEPOSIT - 1n).toString(), (MIN_DEPOSIT - 1n).toString()] });
  assert.deepEqual(await createOnDelivery(under.id, under.deps()), { code: "under_min" });
  assert.equal(under.relayer.sent.length, 0);
  const at = setup({ balance: [MIN_DEPOSIT.toString(), MIN_DEPOSIT.toString()] });
  assert.equal((await createOnDelivery(at.id, at.deps())).code, "created");
  assert.equal(at.relayer.sent.length, 1);
});

test("an RPC disagreement: on the balance, on the account, on the block, or one provider down, so no Transfer", async () => {
  const cases: [string, Partial<World>][] = [
    ["balance", { balance: [MIN_DEPOSIT.toString(), "0"] }],
    ["balance (the other way)", { balance: ["0", MIN_DEPOSIT.toString()] }],
    ["account", { account: ["absent", { keys: ["ed25519:own"] }] }],
    ["block", { fork: ["", "-fork"] }],
    ["down", { down: [false, true] }],
  ];
  for (const [what, over] of cases) {
    const s = setup(over);
    const a = await createOnDelivery(s.id, s.deps());
    assert.equal(a.code, "unread", what);
    assert.ok(typeof a.why === "string" && a.why.length > 0, what);
    assert.equal(s.relayer.sent.length, 0, what);
    assert.equal(s.store().creation(s.id), null, what);
  }
});

test("an id that exists already, with a key or none: no Transfer, whatever it holds", async () => {
  for (const keys of [["ed25519:own"], ["ed25519:own", "ed25519:other"], []]) {
    const s = setup({ account: [{ keys }, { keys }], balance: ["5000000", "5000000"] });
    assert.deepEqual(await createOnDelivery(s.id, s.deps()), { code: "exists" });
    assert.equal(s.relayer.sent.length, 0, JSON.stringify(keys));
  }
});

test("one delivery: exactly one Transfer, of CREATE_YOCTO to the id, under eight concurrent calls and every call after", async () => {
  const s = setup();
  const answers = await Promise.all(Array.from({ length: 8 }, () => createOnDelivery(s.id, s.deps())));
  assert.equal(s.relayer.sent.length, 1);
  assert.deepEqual(s.relayer.sent[0]!.action, { kind: "transfer", receiver: s.id, amount: CREATE_YOCTO });
  for (const a of answers) assert.deepEqual(a, { code: "created", tx_hash: s.relayer.sent[0]!.tx.tx_hash });
  const rec = s.store().creation(s.id)!;
  assert.equal(rec.last.state, "landed");
  // the record keeps the Transfer as signed (its b0 height, nonce and bytes, which a read-back resends and judges by)
  const { state: _s, landed_at: _l, ...signed } = rec.last;
  assert.deepEqual(signed, s.relayer.sent[0]!.tx);
  // later calls read the id as existing
  assert.deepEqual(await createOnDelivery(s.id, s.deps()), { code: "exists" });
  s.reopen();
  assert.deepEqual(await createOnDelivery(s.id, s.deps()), { code: "exists" });
  assert.equal(s.relayer.sent.length, 1);
});

// ---- Never twice: the read-back, a restart, lagging reads ----

test("a Transfer whose outcome is not read: every later call reads it back (its bytes resent) and sends nothing new, across a restart", async () => {
  let kind: TxOutcome["kind"] = "unknown";
  const s = setup({}, { outcome: () => kind });
  const first = await createOnDelivery(s.id, s.deps());
  assert.equal(first.code, "in_flight");
  assert.equal(s.relayer.sent.length, 1);
  const rec = s.store().creation(s.id)!;
  assert.equal(rec.last.state, "pending");
  assert.equal(rec.last.tx_hash, first.tx_hash);
  // the chain still shows the id absent and delivered: nothing new goes out while ours may land
  for (let i = 0; i < 3; i++) assert.deepEqual(await createOnDelivery(s.id, s.deps()), { code: "in_flight", tx_hash: first.tx_hash });
  s.reopen();
  assert.deepEqual(await createOnDelivery(s.id, s.deps()), { code: "in_flight", tx_hash: first.tx_hash });
  assert.equal(s.relayer.sent.length, 1);
  assert.ok(s.relayer.resolved.length >= 4 && s.relayer.resolved.every((r) => r.tx === first.tx_hash && r.resend));
  // then it reads final: created, and still one Transfer
  kind = "final";
  assert.deepEqual(await createOnDelivery(s.id, s.deps()), { code: "created", tx_hash: first.tx_hash });
  assert.equal(s.relayer.sent.length, 1);
});

test("a Transfer proved never applied (dropped): the next call reads the gate again and sends one afresh", async () => {
  let kind: TxOutcome["kind"] = "dropped";
  const s = setup({}, { outcome: () => kind });
  assert.equal((await createOnDelivery(s.id, s.deps())).code, "in_flight");
  assert.equal(s.store().creation(s.id)!.last.state, "dropped");
  kind = "final";
  assert.equal((await createOnDelivery(s.id, s.deps())).code, "created");
  assert.equal(s.relayer.sent.length, 2);
});

test("reads that lag a landed Transfer of ours never count: absent below its receipt's height sends nothing", async () => {
  const s = setup();
  assert.equal((await createOnDelivery(s.id, s.deps())).code, "created");
  const landed = BigInt(s.store().creation(s.id)!.last.landed_at!);
  // the providers answer an older final, where the id was still absent
  s.w.height = Number(landed) - 2;
  s.w.account = ["absent", "absent"];
  assert.deepEqual(await createOnDelivery(s.id, s.deps()), { code: "in_flight" });
  assert.equal(s.relayer.sent.length, 1);
  // past it, absent again (U deleted itself by its clean-up) and delivered again: a new arrival is created again
  s.w.height = Number(landed) + 5;
  assert.equal((await createOnDelivery(s.id, s.deps())).code, "created");
  assert.equal(s.relayer.sent.length, 2);
});

// ---- The rest ----

test("not a 64-hex implicit id: nothing read, nothing sent", async () => {
  const s = setup();
  for (const id of ["alice.near", s.id.toUpperCase(), `${s.id}0`, s.id.slice(1), `0x${"a".repeat(40)}`, ""]) {
    assert.deepEqual(await createOnDelivery(id, s.deps()), { code: "not_implicit" }, id);
  }
  assert.equal(s.relayer.sent.length, 0);
});

test("the floor: a gas account under one deposit's worst plus the Transfer sends nothing", async () => {
  const low = setup({}, { near: RELAYER_FLOOR_YOCTO + CREATE_YOCTO - 1n });
  assert.deepEqual(await createOnDelivery(low.id, low.deps()), { code: "relayer_low" });
  assert.equal(low.relayer.sent.length, 0);
  const at = setup({}, { near: RELAYER_FLOOR_YOCTO + CREATE_YOCTO });
  assert.equal((await createOnDelivery(at.id, at.deps())).code, "created");
});

test("the Transfer's bytes: borsh Action::Transfer (3) and the amount as a u128 little-endian; CREATE_YOCTO is 182 B x 1e19", () => {
  assert.equal(CREATE_YOCTO, 182n * 10n ** 19n);
  const b = encodeAction({ kind: "transfer", receiver: "x", amount: CREATE_YOCTO });
  assert.equal(b.length, 17);
  assert.equal(b[0], 3);
  assert.equal(BigInt(`0x${Buffer.from(b.subarray(1)).reverse().toString("hex")}`), CREATE_YOCTO);
  assert.throws(() => encodeAction({ kind: "transfer", receiver: "x", amount: 0n }), /amount/);
  assert.throws(() => encodeAction({ kind: "transfer", receiver: "x", amount: 1n << 128n }), /amount/);
});
