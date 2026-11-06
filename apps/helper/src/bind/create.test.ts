// create.ts: the relayer creates a one-time id only after the delivery, once. The card's five cases (no delivery, under
// MIN_DEPOSIT, an RPC disagreement, an id that exists, one delivery = one Transfer under concurrent calls), then the
// read-back of a Transfer whose outcome is not known, a restart, reads that lag a landed Transfer, the floor, and the
// Transfer's bytes. The gate reads run on two fake providers through deliveryReads (fee.ts agreedBlock, withdraw/send.ts
// accountAt, viewAt), so a disagreement is the real code's refusal; the relayer is a fake whose queue, like
// createRelayer's, holds only the guard, the write and the broadcast, and whose Transfer applies on the chain later.
//   node --test apps/helper/src/bind/create.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CREATE_YOCTO, createOnDelivery, deliveryKey, deliveryOf, deliveryReads, onStatusAnswer, REREAD_MS, STATUS_ANSWER_MAX, type CreateDeps } from "./create.ts";
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
  /** Every read either provider answered. */
  reads: number;
};
type Acct = "absent" | { keys: string[] };

function world(over: Partial<World> = {}): World {
  return { height: 1000, account: ["absent", "absent"], balance: [MIN_DEPOSIT.toString(), MIN_DEPOSIT.toString()], fork: ["", ""], down: [false, false], reads: 0, ...over };
}

function provider(w: World, i: 0 | 1, id: () => string): Rpc {
  return async (method, params) => {
    if (w.down[i]) throw new Error("fetch failed");
    w.reads++;
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
  const clock = { t: NOW };
  const deps = (): CreateDeps => ({ token: TOKEN, delivery, store, relayer, now: () => clock.t });
  const reopen = () => {
    store.close();
    store = createFileStore(dir);
  };
  return { w, id, relayer, deps, reopen, store: () => store, clock };
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
  assert.equal(rec.last!.state, "landed");
  // the record keeps the Transfer as signed (its b0 height, nonce and bytes, which a read-back resends and judges by)
  const { state: _s, landed_at: _l, delivery: _d, ...signed } = rec.last!;
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
  assert.equal(rec.last!.state, "pending");
  assert.equal(rec.last!.tx_hash, first.tx_hash);
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

test("a Transfer whose outcome a lookup never gives, while the id exists: exists, nothing resolved or sent", async () => {
  const s = setup({}, { outcome: () => "unknown" });
  assert.equal((await createOnDelivery(s.id, s.deps())).code, "in_flight");
  assert.equal(s.store().creation(s.id)!.last!.state, "pending");
  s.w.account = [{ keys: ["ed25519:own"] }, { keys: ["ed25519:own"] }];
  const n = s.relayer.resolved.length;
  assert.deepEqual(await createOnDelivery(s.id, s.deps()), { code: "exists", tx_hash: s.relayer.sent[0]!.tx.tx_hash });
  assert.equal(s.relayer.resolved.length, n);
  assert.equal(s.relayer.sent.length, 1);
  // a read-back whose read fails sends nothing and resolves nothing
  s.w.down = [true, false];
  assert.equal((await createOnDelivery(s.id, s.deps())).code, "unread");
  assert.equal(s.relayer.resolved.length, n);
});

test("a Transfer proved never applied (dropped): the next call reads the gate again and sends one afresh", async () => {
  let kind: TxOutcome["kind"] = "dropped";
  const s = setup({}, { outcome: () => kind });
  assert.equal((await createOnDelivery(s.id, s.deps())).code, "in_flight");
  assert.equal(s.store().creation(s.id)!.last!.state, "dropped");
  kind = "final";
  assert.equal((await createOnDelivery(s.id, s.deps())).code, "created");
  assert.equal(s.relayer.sent.length, 2);
});

test("reads that lag a landed Transfer of ours never count: absent below its receipt's height sends nothing", async () => {
  const s = setup();
  assert.equal((await createOnDelivery(s.id, s.deps())).code, "created");
  const landed = BigInt(s.store().creation(s.id)!.last!.landed_at!);
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

// ---- The trigger: a 1Click status answer the proxy carried (onStatusAnswer, deliveryOf) ----

/** Two status answers as 1Click sent them (fixtures/oneclick-status.json: its source line). */
const STATUS = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/oneclick-status.json"), "utf8")) as { answers: Record<"success_usdc" | "success_sol", Answer> };
type Answer = { status: string; swapDetails: Record<string, unknown>; quoteResponse: { quoteRequest: Record<string, unknown>; quote: Record<string, unknown> } };
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** The recorded USDC delivery, its recipient, token and address set for a test (the fake chain decides what they hold). */
function answer(edit: { id?: string; token?: string; address?: string; status?: string; req?: Record<string, unknown>; out?: unknown; memo?: unknown } = {}): string {
  const a = structuredClone(STATUS.answers.success_usdc);
  if (edit.status !== undefined) a.status = edit.status;
  if (edit.id !== undefined) a.quoteResponse.quoteRequest.recipient = edit.id;
  if (edit.token !== undefined) a.quoteResponse.quoteRequest.destinationAsset = `nep141:${edit.token}`;
  if (edit.address !== undefined) a.quoteResponse.quote.depositAddress = edit.address;
  if ("out" in edit) a.swapDetails.amountOut = edit.out;
  if ("memo" in edit) a.quoteResponse.quote.depositMemo = edit.memo;
  Object.assign(a.quoteResponse.quoteRequest, edit.req ?? {});
  return JSON.stringify(a);
}
const nets = (deps: () => CreateDeps, token = TOKEN) => new Map([[token, async () => deps()]]);

test("deliveryOf on the recorded answers: the USDC delivery names its 64-hex recipient, token and deposit address; the SOL one (a Solana recipient, another token) names none", () => {
  const usdc = JSON.stringify(STATUS.answers.success_usdc);
  assert.deepEqual(deliveryOf(usdc, new Set([USDC])), { id: "386aeb3286b4a6548d1ed2a84557073858cf1b696310359c5100cb06ed233ef8", token: USDC, key: "a998c6585100ca4bccbc0e0bcceb9abd66e59666e87bd03b1d83bb9544f7ce2f#" });
  assert.equal(deliveryOf(usdc, new Set([TOKEN])), null, "a token no carried network holds");
  const sol = JSON.stringify(STATUS.answers.success_sol);
  assert.equal(deliveryOf(sol, new Set([USDC, "sol.omft.near"])), null, "a recipient that is no 64-hex id");
});

test("deliveryOf: only SUCCESS of a live quote to a 64-hex id delivered on the token, with amountOut at least MIN_DEPOSIT; anything malformed is none", () => {
  const t = new Set([TOKEN]);
  const id = "ab".repeat(32);
  assert.notEqual(deliveryOf(answer({ id, token: TOKEN }), t), null);
  for (const status of ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "INCOMPLETE_DEPOSIT", "REFUNDED", "FAILED", "success", ""]) assert.equal(deliveryOf(answer({ id, token: TOKEN, status }), t), null, status);
  for (const bad of ["alice.near", "AB".repeat(32), "ab".repeat(31), `${"ab".repeat(32)}0`, "0x" + "ab".repeat(31)]) assert.equal(deliveryOf(answer({ id: bad, token: TOKEN }), t), null, bad);
  assert.equal(deliveryOf(answer({ id, token: TOKEN, req: { recipient: 7 } }), t), null);
  assert.equal(deliveryOf(answer({ id, token: TOKEN, req: { dry: true } }), t), null, "a dry quote delivers nothing");
  assert.equal(deliveryOf(answer({ id, token: TOKEN, req: { recipientType: "INTENTS" } }), t), null, "delivered inside intents.near, not to the id's own account");
  assert.equal(deliveryOf(answer({ id, token: TOKEN, req: { destinationAsset: TOKEN } }), t), null, "no nep141: prefix");
  assert.equal(deliveryOf(answer({ id, token: TOKEN, out: (MIN_DEPOSIT - 1n).toString() }), t), null, "under MIN_DEPOSIT by 1Click's own word");
  assert.notEqual(deliveryOf(answer({ id, token: TOKEN, out: MIN_DEPOSIT.toString() }), t), null);
  for (const out of [undefined, 5, "-1", "01", "1e9", "9".repeat(40)]) assert.equal(deliveryOf(answer({ id, token: TOKEN, out }), t), null, String(out));
  for (const address of ["", "a b", "x".repeat(129)]) assert.equal(deliveryOf(answer({ id, token: TOKEN, address }), t), null, JSON.stringify(address));
  for (const body of ["", "{", "[]", "null", JSON.stringify({ status: "SUCCESS" }), " ".repeat(STATUS_ANSWER_MAX + 1)]) assert.equal(deliveryOf(body, t), null, body.slice(0, 20));
  // the cap is on the whole answer
  const big = answer({ id, token: TOKEN }).replace("{", `{"pad":"${"x".repeat(STATUS_ANSWER_MAX)}",`);
  assert.equal(deliveryOf(big, t), null);
});

test("hook: a SUCCESS to an absent id that holds the delivery gives one Transfer; every later poll of the same answer sends nothing and reads nothing", async () => {
  const s = setup();
  const body = answer({ id: s.id, token: TOKEN, address: `dep-${s.id}` });
  const first = await onStatusAnswer(body, nets(s.deps));
  assert.equal(first?.code, "created");
  assert.equal(first?.id, s.id);
  assert.equal(s.relayer.sent.length, 1);
  assert.deepEqual(s.relayer.sent[0]!.action, { kind: "transfer", receiver: s.id, amount: CREATE_YOCTO });
  const reads = s.w.reads;
  for (let i = 0; i < 5; i++) assert.deepEqual(await onStatusAnswer(body, nets(s.deps)), { id: s.id, code: "delivery_used", tx_hash: first?.tx_hash });
  assert.equal(s.relayer.sent.length, 1);
  assert.equal(s.w.reads, reads, "a used delivery reads no chain");
});

test("hook: 8 polls of one SUCCESS at once give one Transfer", async () => {
  const s = setup();
  const body = answer({ id: s.id, token: TOKEN, address: `dep-${s.id}` });
  const all = await Promise.all(Array.from({ length: 8 }, () => onStatusAnswer(body, nets(s.deps))));
  assert.equal(s.relayer.sent.length, 1);
  assert.ok(all.every((a) => a?.code === "created"));
});

test("hook: PENDING, a recipient that is no 64-hex id, another token or an id that exists give no Transfer", async () => {
  const s = setup();
  for (const body of [answer({ id: s.id, token: TOKEN, status: "PENDING_DEPOSIT" }), answer({ id: "alice.near", token: TOKEN }), answer({ id: s.id, token: "other.near" })]) assert.equal(await onStatusAnswer(body, nets(s.deps)), null);
  assert.equal(s.w.reads, 0, "an answer that names no delivery reads no chain");
  const e = setup({ account: [{ keys: ["ed25519:k"] }, { keys: ["ed25519:k"] }] });
  assert.deepEqual(await onStatusAnswer(answer({ id: e.id, token: TOKEN, address: `dep-${e.id}` }), nets(e.deps)), { id: e.id, code: "exists" });
  assert.equal(s.relayer.sent.length + e.relayer.sent.length, 0);
});

test("hook, the drain: an id its holder deleted, its token left in it, is never created again by the same delivery (after a restart too); a new 1Click delivery to it is", async () => {
  const s = setup();
  const body = answer({ id: s.id, token: TOKEN, address: `dep-${s.id}` });
  assert.equal((await onStatusAnswer(body, nets(s.deps)))?.code, "created");
  // DeleteAccount by the id's own key: absent again, the token's balance stays with the token contract
  s.w.account = ["absent", "absent"];
  s.w.height += 10;
  assert.equal((await onStatusAnswer(body, nets(s.deps)))?.code, "delivery_used");
  s.reopen();
  assert.equal((await onStatusAnswer(body, nets(s.deps)))?.code, "delivery_used");
  assert.equal(s.relayer.sent.length, 1);
  // a second real swap to the same id (a second arrival): a new deposit address, created once more
  assert.equal((await onStatusAnswer(answer({ id: s.id, token: TOKEN, address: `dep2-${s.id}` }), nets(s.deps)))?.code, "created");
  assert.equal(s.relayer.sent.length, 2);
});

test("hook: a delivery whose Transfer is still open reads it back, never sends a second; one whose Transfer was dropped may be sent afresh", async () => {
  let kind: TxOutcome["kind"] = "unknown";
  const s = setup({}, { outcome: () => kind });
  const body = answer({ id: s.id, token: TOKEN, address: `dep-${s.id}` });
  assert.equal((await onStatusAnswer(body, nets(s.deps)))?.code, "in_flight");
  assert.equal((await onStatusAnswer(body, nets(s.deps)))?.code, "in_flight");
  assert.equal(s.relayer.sent.length, 1);
  assert.equal(s.relayer.resolved.length, 1, "the open Transfer is read again (its stored bytes)");
  kind = "dropped";
  assert.equal((await onStatusAnswer(body, nets(s.deps)))?.code, "in_flight");
  assert.equal(s.relayer.sent.length, 2, "a Transfer known dropped may be signed afresh");
});

test("hook: a network that cannot start rejects (env.ts logs it); the answer was already sent", async () => {
  const body = answer({ id: "cd".repeat(32), token: TOKEN });
  await assert.rejects(onStatusAnswer(body, new Map([[TOKEN, async () => { throw new Error("rpc down"); }]])), /rpc down/);
});

// ---- The review's folds ----

/** Counts the relayer's queue turns (send() calls, whatever the guard answers). */
function counted(r: ReturnType<typeof fakeRelayer>) {
  let turns = 0;
  const send = r.send.bind(r);
  r.send = (async (...args: Parameters<typeof send>) => (turns++, send(...args))) as typeof r.send;
  return { turns: () => turns };
}

test("fold 1: 50 polls of a SUCCESS that cannot create take no queue turn; exists spends the delivery for good, no_delivery, under_min and unread read again at most every REREAD_MS", async () => {
  for (const [code, over] of [
    ["exists", { account: [{ keys: ["ed25519:k"] }, { keys: ["ed25519:k"] }] }],
    ["under_min", { balance: ["5", "5"] }],
    ["no_delivery", { balance: ["0", "0"] }],
    ["unread", { down: [false, true] }],
  ] as const) {
    const s = setup(over as Partial<World>);
    const c = counted(s.relayer);
    const body = answer({ id: s.id, token: TOKEN, address: `dep-${s.id}` });
    const first = await onStatusAnswer(body, nets(s.deps));
    const one = s.w.reads;
    assert.ok(one > 0, `${code}: the first poll reads at once`);
    const all = [first, ...(await Promise.all(Array.from({ length: 25 }, () => onStatusAnswer(body, nets(s.deps)))))];
    for (let i = 0; i < 24; i++) all.push(await onStatusAnswer(body, nets(s.deps)));
    assert.equal(all.length, 50);
    assert.equal(first?.code, code);
    assert.ok(all.slice(1).every((a) => a?.code === (code === "exists" ? "delivery_used" : code)), `${code}: ${JSON.stringify(all.slice(0, 3))}`);
    assert.equal(c.turns(), 0, `${code}: no queue turn`);
    assert.equal(s.w.reads, one, `${code}: one read for 50 polls`);
    s.clock.t += REREAD_MS;
    await onStatusAnswer(body, nets(s.deps));
    assert.equal(s.w.reads, code === "exists" ? one : 2 * one, `${code}: after REREAD_MS`);
    if (code === "exists") assert.deepEqual(s.store().creation(s.id)!.used, [deliveryKey(`dep-${s.id}`, "")]);
    assert.equal(s.relayer.sent.length + c.turns(), 0);
  }
});

test("fold 1: a delivery that may create takes one queue turn and re-reads the gate inside it; a fresh delivery is read at once while another is paced", async () => {
  const s = setup({ balance: ["5", "5"] });
  const c = counted(s.relayer);
  assert.equal((await onStatusAnswer(answer({ id: s.id, token: TOKEN, address: `a-${s.id}` }), nets(s.deps)))?.code, "under_min");
  s.w.balance = [MIN_DEPOSIT.toString(), MIN_DEPOSIT.toString()];
  assert.equal((await onStatusAnswer(answer({ id: s.id, token: TOKEN, address: `a-${s.id}` }), nets(s.deps)))?.code, "under_min", "paced: its answer kept");
  const one = s.w.reads; // one gate read: the first poll's (the second was paced)
  assert.equal((await onStatusAnswer(answer({ id: s.id, token: TOKEN, address: `b-${s.id}` }), nets(s.deps)))?.code, "created", "a fresh delivery is never delayed");
  assert.equal(c.turns(), 1);
  assert.equal(s.w.reads - one, 2 * one, "the gate read outside the queue, then again inside it");
});

test("fold 1: the gate inside the queue still holds: an id that appears between the two reads is never sent to, and spends the delivery", async () => {
  const s = setup();
  const send = s.relayer.send.bind(s.relayer);
  s.relayer.send = (async (...args: Parameters<typeof send>) => {
    s.w.account = [{ keys: ["ed25519:k"] }, { keys: ["ed25519:k"] }];
    return send(...args);
  }) as typeof s.relayer.send;
  const body = answer({ id: s.id, token: TOKEN, address: `dep-${s.id}` });
  assert.equal((await onStatusAnswer(body, nets(s.deps)))?.code, "exists");
  assert.equal(s.relayer.sent.length, 0);
  assert.deepEqual(s.store().creation(s.id)!.used, [deliveryKey(`dep-${s.id}`, "")]);
});

test("fold 2: a crash after the record's write and before the broadcast, the stored bytes landing, then DeleteAccount, then the same SUCCESS: no second Transfer", async () => {
  let kind: TxOutcome["kind"] = "unknown";
  const s = setup({}, { outcome: () => kind });
  const real = s.store();
  let crash = true;
  const pendingWrites: string[] = [];
  const store: CreateDeps["store"] = {
    creation: (id) => real.creation(id),
    putCreation(rec) {
      real.putCreation(rec);
      if (rec.last?.state === "pending") pendingWrites.push(rec.last.tx_hash);
      if (crash && rec.last?.state === "pending") {
        crash = false;
        throw new Error("the process dies here");
      }
    },
  };
  const deps = (): CreateDeps => ({ ...s.deps(), store });
  const body = answer({ id: s.id, token: TOKEN, address: `dep-${s.id}` });
  await assert.rejects(onStatusAnswer(body, nets(deps)), /dies here/);
  assert.equal(s.relayer.sent.length, 0, "never broadcast");
  assert.equal(real.creation(s.id)!.last!.delivery, deliveryKey(`dep-${s.id}`, ""), "the record names its delivery");
  // the restart's read-back resends the stored bytes and they land
  kind = "final";
  assert.equal((await onStatusAnswer(body, nets(deps)))?.code, "created");
  s.w.account = [{ keys: ["ed25519:own"] }, { keys: ["ed25519:own"] }];
  s.w.height += 3;
  // the holder deletes the id (DeleteAccount); its token stays with the token contract
  s.w.account = ["absent", "absent"];
  s.w.height += 10;
  for (let i = 0; i < 3; i++) assert.equal((await onStatusAnswer(body, nets(deps)))?.code, "delivery_used");
  assert.equal(pendingWrites.length, 1, "one Transfer signed for one delivery");
  assert.equal(s.relayer.sent.length, 0);
});

test("fold 3: MEMO deposits share one address: two memos to two ids are two deliveries and two creations; a MEMO answer with no memo, or a SIMPLE one with a memo, names none", async () => {
  const a = setup();
  const b = setup();
  const memo = { req: { depositMode: "MEMO" } };
  const shared = "shared-address-1";
  assert.equal((await onStatusAnswer(answer({ id: a.id, token: TOKEN, address: shared, memo: "1001", ...memo }), nets(a.deps)))?.code, "created");
  assert.equal((await onStatusAnswer(answer({ id: b.id, token: TOKEN, address: shared, memo: "1002", ...memo }), nets(b.deps)))?.code, "created");
  assert.equal(a.relayer.sent.length + b.relayer.sent.length, 2);
  assert.deepEqual(a.store().creation(a.id)!.used, [deliveryKey(shared, "1001")]);
  const t = new Set([TOKEN]);
  assert.deepEqual(deliveryOf(answer({ id: a.id, token: TOKEN, address: shared, memo: "1001", ...memo }), t)?.key, `${shared}#1001`);
  for (const m of [undefined, "", 7, "a b", "x".repeat(129)]) assert.equal(deliveryOf(answer({ id: a.id, token: TOKEN, address: shared, memo: m, ...memo }), t), null, `MEMO with ${JSON.stringify(m)}`);
  assert.equal(deliveryOf(answer({ id: a.id, token: TOKEN, memo: "1001" }), t), null, "SIMPLE with a memo");
  assert.equal(deliveryOf(answer({ id: a.id, token: TOKEN, req: { depositMode: "OTHER" } }), t), null);
  assert.notEqual(deliveryOf(answer({ id: a.id, token: TOKEN, memo: null }), t), null, "SIMPLE, memo null");
});

test("fold 6: the lag guard is the receipt's height, not the signing height: a read between the two is held", async () => {
  const s = setup();
  assert.equal((await onStatusAnswer(answer({ id: s.id, token: TOKEN, address: `a-${s.id}` }), nets(s.deps)))?.code, "created");
  const last = s.store().creation(s.id)!.last!;
  const signed = BigInt(last.height);
  const landed = BigInt(last.landed_at!);
  assert.ok(landed > signed + 1n, `${signed} < ${landed}`);
  // the providers answer a final between the two, where the id still reads absent
  s.w.account = ["absent", "absent"];
  s.w.height = Number(signed) + 1;
  assert.equal((await onStatusAnswer(answer({ id: s.id, token: TOKEN, address: `b-${s.id}` }), nets(s.deps)))?.code, "in_flight");
  assert.equal(s.relayer.sent.length, 1);
});
