// trade.ts, POST /v1/bind's trade kind (card relayer-near-trade): W's creation, then the carry of W's signed calls,
// every refusal the rule names held by its own test with nothing sent. The quotes are real: the kit's rheaQuote
// replayed on recorded mainnet answers of both providers (fixtures/near-rhea-quotes.json, copied from the kit's); the calls
// are the kit's nearSwapCalls, each signed here as a NEP-366 delegate with real ed25519 by a key made in the test.
//   node --test apps/helper/src/bind/trade.test.ts
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  HELPER_BIND_TRADE_CODES,
  HELPER_BIND_TRADE_CREATE_YOCTO,
  HELPER_BIND_TRADE_STORAGE_MAX,
  HELPER_CODE_STATUS,
  NEAR_SWAP_STORAGE_MAX,
  nearSwapCalls,
  rheaQuote,
  type NearSwapCall,
  type RheaQuote,
} from "../../../../packages/kit/src/index.ts";
import { BIND_MAX_BYTES, decodeSignedDelegate, NEP366_PREFIX, type KeyRead } from "./checks.ts";
import { RELAYER_FLOOR_YOCTO, type Relayer, type RelayerAction, type TxOutcome, type TxRef } from "./send.ts";
import { carryTrade, createTradeStore, TRADE_COST_MAX, TRADE_GAS_PRICE, TRADE_STORAGE_MAX, TRADE_SWAP_FAILS_MAX, type AccountState, type TradeAnswer, type TradeDeps, type TradeReads, type TradeRecord, type TradeStore } from "./trade.ts";
import { CREATE_YOCTO } from "./create.ts";

const FAST = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const RHEA = "token.rhealab.near";
const EX = "v2.ref-finance.near";
const MIN = 1_250_000_000_000_000_000_000n; // token.rhealab.near's storage minimum, 0.00125 N
const FINAL = 180_000_000n;
const K = 30n;
const { runs } = JSON.parse(readFileSync(new URL("./fixtures/near-rhea-quotes.json", import.meta.url), "utf8"));

async function quoteOf(name: string): Promise<RheaQuote> {
  const r = runs.find((x: { name: string }) => x.name === name);
  const rpcs = [FAST, DRPC].map((url) => ({
    name: url,
    async query(params: Record<string, unknown>) {
      const hit = r.log.find((l: { url: string; params: unknown }) => l.url === url && JSON.stringify(l.params) === JSON.stringify(params));
      if (!hit) throw new Error("not recorded");
      return hit.answer;
    },
  })) as unknown as Parameters<typeof rheaQuote>[0]["rpcs"];
  return rheaQuote({ network: "mainnet", rpcs, side: r.side, token: r.token, amountIn: BigInt(r.amountIn), pools: r.pools });
}

// ---- W's key, and its calls signed as NEP-366 delegates ----

type Key = { priv: KeyObject; pub: Buffer; id: string };
function newKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { priv: privateKey, pub, id: pub.toString("hex") };
}
const le = (n: bigint, len: number): Buffer => {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
};
const str = (s: string | Uint8Array): Buffer => {
  const b = typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s);
  return Buffer.concat([le(BigInt(b.length), 4), b]);
};
type Sig = { nonce: bigint; mbh?: bigint; signer?: Key; sender?: string; extra?: Buffer };
/** One call as W's delegate: borsh DelegateAction, signed over sha256(u32le(2^30 + 366) || it). */
function delegate(c: NearSwapCall, k: Key, s: Sig): string {
  const f = c.actions[0].FunctionCall;
  const action = Buffer.concat([Buffer.from([2]), str(f.method_name), str(JSON.stringify(f.args)), le(BigInt(f.gas), 8), le(BigInt(f.deposit), 16)]);
  const signer = s.signer ?? k;
  const d = Buffer.concat([str(s.sender ?? c.sender_id), str(c.receiver_id), le(s.extra ? 2n : 1n, 4), action, ...(s.extra ? [s.extra] : []), le(s.nonce, 8), le(s.mbh ?? FINAL + 120n, 8), Buffer.from([0]), signer.pub]);
  const hash = createHash("sha256").update(le(BigInt(NEP366_PREFIX), 4)).update(d).digest();
  return Buffer.concat([d, Buffer.from([0]), sign(null, hash, signer.priv)]).toString("base64");
}

// ---- The world: reads, a relayer that records, a store in memory ----

type World = {
  exists?: boolean;
  keyNonce?: bigint;
  payout?: boolean;
  storageMin?: bigint;
  /** W's registration per token (default: registered everywhere but a creation's output token, set by `fresh`). */
  registered?: (token: string) => boolean;
  balance?: bigint;
  relayerNear?: bigint;
  held?: boolean;
  fail?: number; // the index of a send whose receipt fails
  unknown?: boolean; // every outcome read again stays unknown
  hopsReal?: boolean;
  permission?: "FullAccess" | "FunctionCall";
  /** What send n's transaction and receipts burnt, as both providers read it (default: not read, so its worst counts). */
  burnt?: (n: number, action: RelayerAction) => bigint;
  /** The receipts of send n (default: one ok receipt, or a failed one at `fail`). */
  receipts?: (n: number) => { executor: string; ok: boolean; failure: string; height: bigint }[];
};
type Sent = { action: RelayerAction; tx: TxRef };

function world(w: string, o: World = {}) {
  const sent: Sent[] = [];
  const recs = new Map<string, TradeRecord>();
  const state = { exists: o.exists ?? false, keyNonce: o.keyNonce ?? FINAL * 1_000_000n - 5_000_000n, registered: o.registered ?? ((_t: string) => true) };
  const reads: TradeReads = {
    finalHeight: async () => FINAL,
    newestFinalHeight: async () => FINAL,
    account: async (id): Promise<AccountState> => (id === w && state.exists ? { kind: "account" } : { kind: "absent" }),
    accessKey: async (id): Promise<KeyRead> => (id === w && state.exists ? { kind: "key", permission: o.permission ?? "FullAccess", nonce: state.keyNonce } : { kind: "no_account" }),
    ftBalance: async () => o.balance ?? 10n ** 30n,
    storageMin: async () => o.storageMin ?? MIN,
    registered: async (tokens) => tokens.map((t) => state.registered(t)),
    payoutLanded: async (id) => id === w && (o.payout ?? true),
    hopsReal: async () => o.hopsReal ?? true,
  };
  const store: TradeStore = {
    get: (id) => (recs.has(id) ? structuredClone(recs.get(id)!) : null),
    create(rec) {
      if (recs.has(rec.w)) return { created: false, rec: structuredClone(recs.get(rec.w)!) };
      recs.set(rec.w, structuredClone(rec));
      return { created: true, rec };
    },
    put: (rec) => void recs.set(rec.w, structuredClone(rec)),
    close() {},
  };
  const relayer: Relayer = {
    account: "relayer.testnet",
    key: "relayer.testnet/ed25519:x",
    balance: async () => o.relayerNear ?? 10n ** 26n,
    async send(action, guard, before) {
      const code = await guard();
      if (code !== null) return { kind: "guarded", code };
      const n = sent.length;
      const tx: TxRef = { tx_hash: `tx${n}`, nonce: String(n + 1), height: String(FINAL), block_hash: "h", signed_tx: "" };
      before(tx);
      sent.push({ action, tx });
      if (action.kind === "transfer") state.exists = true;
      if (o.unknown) return { kind: "unknown", tx_hash: tx.tx_hash, why: "not read yet" };
      const okay = o.fail !== n;
      return { kind: "final", tx_hash: tx.tx_hash, receipts: o.receipts?.(n) ?? [{ executor: w, ok: okay, failure: okay ? "" : "failed", height: FINAL + 2n }], ...(o.burnt && { burnt: o.burnt(n, action) }) } as TxOutcome;
    },
    resolve: async (tx) => (o.unknown ? { kind: "unknown", tx_hash: tx.tx_hash, why: "not read yet" } : { kind: "final", tx_hash: tx.tx_hash, receipts: [{ executor: w, ok: true, failure: "", height: FINAL + 2n }] }),
  };
  const deps: TradeDeps = { cfg: { network: "mainnet", marginK: K }, reads, store, relayer, held: async () => o.held ?? false };
  return { deps, sent, recs, state };
}
/** W not registered on the token bought (a fresh W): registered on USDC by the vault's payout only. */
const fresh = (t: string) => t === USDC;

const tradeOf = (q: RheaQuote, w: string, slippage = 100) => ({
  network: "mainnet" as const,
  side: q.side,
  token: q.token,
  wallet: w,
  amount_in: q.amountIn.toString(),
  slippage_bps: slippage,
  venue_out: q.venueOut.toString(),
  hops: q.hops.map((h) => ({ pool: h.pool, token_in: h.tokenIn, token_out: h.tokenOut })),
});
/** The kit's calls for W: the swap (and the claim when W's lost-found holds some), W registered on the output. */
const callsOf = (q: RheaQuote, w: string, o: { lostfound?: bigint } = {}) =>
  nearSwapCalls({ quote: q, wallet: w, slippageBps: 100, registered: true, storageMin: MIN, lostfound: o.lostfound ?? 0n }, { network: "mainnet", side: q.side, token: q.token, amountIn: q.amountIn, wallet: w, slippageBps: 100 });
/** The kit's registration call for an unregistered W: the storage_deposit nearSwapCalls writes for it. */
const registrationOf = (q: RheaQuote, w: string) =>
  nearSwapCalls({ quote: q, wallet: w, slippageBps: 100, registered: false, storageMin: MIN, lostfound: 0n }, { network: "mainnet", side: q.side, token: q.token, amountIn: q.amountIn, wallet: w, slippageBps: 100 }).filter((c) => c.actions[0].FunctionCall.method_name === "storage_deposit");
const clone = (c: readonly NearSwapCall[]) => JSON.parse(JSON.stringify(c)) as NearSwapCall[];
const signAll = (calls: readonly NearSwapCall[], k: Key, base: bigint, s: Partial<Sig> = {}) => calls.map((c, i) => delegate(c, k, { nonce: base + BigInt(i) + 1n, ...s }));
const code = (a: TradeAnswer) => ("error" in a.body ? a.body.error.code : "ok");

test("T1 a buy: W created once by one Transfer of its account alone (the relayer pays the deposits W's calls attach), after the payout; then the registration alone; then, once it reads back, the swap and the claim", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const { deps, sent, state } = world(k.id, { registered: fresh });
  const created = await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [] }, deps);
  assert.deepEqual(created, { status: 200, body: { tx_hashes: ["tx0"] } });
  assert.equal(HELPER_BIND_TRADE_CREATE_YOCTO, CREATE_YOCTO); // the kit's number is the helper's one-time id amount
  assert.deepEqual(sent.map((s) => s.action), [{ kind: "transfer", receiver: k.id, amount: CREATE_YOCTO }]);
  const reg = signAll(registrationOf(q, k.id), k, state.keyNonce);
  assert.deepEqual(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: reg }, deps), { status: 200, body: { tx_hashes: ["tx1"] } });
  state.keyNonce += 1n;
  state.registered = () => true; // the registration read back on both providers
  const calls = callsOf(q, k.id, { lostfound: 7n });
  assert.equal(calls.length, 2);
  const signed = signAll(calls, k, state.keyNonce);
  // the body, two delegates and a two-hop trade, fits POST /v1/bind's 4 KB
  assert.ok(JSON.stringify({ trade: tradeOf(q, k.id), signed_delegates: signed }).length < BIND_MAX_BYTES);
  assert.deepEqual(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signed }, deps), { status: 200, body: { tx_hashes: ["tx2", "tx3"] } });
  assert.deepEqual(
    sent.slice(1).map((s) => s.action.kind === "delegate" && [Buffer.from(s.action.signed).toString("base64"), s.action.receiver]),
    [...reg, ...signed].map((b) => [b, k.id]),
  );
});

test("T3 a buy whose swap is quoted again after the registration reads back (venue_out moved): the registration alone takes no side, so the swap is carried, and a second swap after it is still trade_used", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const { deps, state } = world(k.id, { registered: fresh });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [] }, deps)), "ok");
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(registrationOf(q, k.id), k, state.keyNonce) }, deps)), "ok");
  state.keyNonce += 1n;
  state.registered = () => true;
  const again = { ...q, venueOut: q.venueOut - 1_000n }; // the fresh quote at the registered read
  assert.deepEqual(await carryTrade({ trade: tradeOf(again, k.id), signed_delegates: signAll(callsOf(again, k.id), k, state.keyNonce) }, deps), { status: 200, body: { tx_hashes: ["tx2"] } });
  state.keyNonce += 1n;
  const third = { ...q, venueOut: q.venueOut - 2_000n };
  assert.equal(code(await carryTrade({ trade: tradeOf(third, k.id), signed_delegates: signAll(callsOf(third, k.id), k, state.keyNonce) }, deps)), "trade_used");
});

test("T2 a sell: the swap alone (W registered on the token and on USDC), carried", async () => {
  const k = newKey();
  const q = await quoteOf("sell RHEA through wNEAR");
  const { deps, sent, state } = world(k.id, { exists: true });
  const calls = callsOf(q, k.id);
  assert.deepEqual(calls.map((c) => c.receiver_id), [RHEA]);
  const a = await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(calls, k, state.keyNonce) }, deps);
  assert.deepEqual(a, { status: 200, body: { tx_hashes: ["tx0"] } });
  assert.equal(sent.length, 1);
});

test("R1 a call the kit's nearSwapCheck refuses is refused by its name, nothing sent", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const cases: [string, (c: NearSwapCall[]) => void][] = [
    ["swap_n4", (c) => (c[0]!.actions[0].FunctionCall.args.msg = (c[0]!.actions[0].FunctionCall.args.msg as string).replace('"force":0,', '"force":0,"swap_out_recipient":"evil.near",'))],
    ["swap_n7", (c) => (c[0]!.actions[0].FunctionCall.gas = 300e12)],
    ["swap_n3", (c) => (c[1]!.actions[0].FunctionCall.deposit = "2")],
    ["swap_n1", (c) => (c[0]!.actions[0].FunctionCall.args.amount = "5000001")],
  ];
  for (const [want, change] of cases) {
    const { deps, sent, state } = world(k.id, { exists: true });
    const calls = clone(callsOf(q, k.id, { lostfound: 3n }));
    change(calls);
    const a = await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(calls, k, state.keyNonce) }, deps);
    assert.equal(code(a), want, want);
    assert.equal(sent.length, 0, want);
  }
});

test("R2 a receiver that is not the input token, the output token or the exchange: swap_n2, nothing sent", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const { deps, sent, state } = world(k.id, { exists: true });
  const calls = clone(callsOf(q, k.id, { lostfound: 1n }));
  calls[1]!.receiver_id = "evil.near"; // the claim, sent to another contract
  const a = await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(calls, k, state.keyNonce) }, deps);
  assert.equal(code(a), "swap_n2");
  assert.equal(sent.length, 0);
  assert.ok(HELPER_BIND_TRADE_CODES.includes("swap_n2"));
});

test("R3 a W with no landed vault payout gets nothing: not created, nothing carried", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const absent = world(k.id, { payout: false, registered: fresh });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [] }, absent.deps)), "no_payout");
  assert.equal(absent.sent.length, 0);
  // a W that exists (funded by anyone) and never was paid by the vault: its calls are not carried
  const present = world(k.id, { payout: false, exists: true });
  const a = await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id), k, present.state.keyNonce) }, present.deps);
  assert.equal(code(a), "no_payout");
  assert.equal(present.sent.length, 0);
});

test("R4 a second creation of one W is refused, nothing sent: by its record, and by the store's create-if-absent on disk", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const { deps, sent, state } = world(k.id, { registered: fresh });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [] }, deps)), "ok");
  // W exists now; and even when W reads absent again (deleted by its holder), the record holds: never a second Transfer
  state.exists = false;
  const again = await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [] }, deps);
  assert.deepEqual(again, { status: 409, body: { error: { code: "wallet_created" }, tx_hashes: ["tx0"] } });
  assert.equal(sent.length, 1);
  // two calls at once: one Transfer
  const k2 = newKey();
  const two = world(k2.id, { registered: fresh });
  const both = await Promise.all([0, 1].map(() => carryTrade({ trade: tradeOf(q, k2.id), signed_delegates: [] }, two.deps)));
  assert.deepEqual(both.map(code).sort(), ["in_flight", "ok"]);
  assert.equal(two.sent.length, 1);
  // the store's claim is one create-if-absent on disk
  const s = createTradeStore(mkdtempSync(join(tmpdir(), "trade-store-")));
  const rec: TradeRecord = { w: k.id, creation: null, adopted: false, token: null, carried: [] };
  assert.equal(s.create(rec).created, true);
  assert.equal(s.create(rec).created, false);
  s.close();
});

test("R5 an amount over the cap: a registration attaching over 0.0125 N is refused at the carry; the creation is W's account alone whatever the token's minimum; nothing sent", async () => {
  assert.equal(TRADE_STORAGE_MAX, NEAR_SWAP_STORAGE_MAX);
  assert.equal(HELPER_BIND_TRADE_STORAGE_MAX, 12_500_000_000_000_000_000_000n);
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const over = HELPER_BIND_TRADE_STORAGE_MAX + 1n;
  // the creation never pays the token's storage: the same Transfer at any minimum
  const a = world(k.id, { storageMin: over, registered: fresh });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [] }, a.deps)), "ok");
  assert.deepEqual(a.sent[0]!.action, { kind: "transfer", receiver: k.id, amount: CREATE_YOCTO });
  // the carry: a registration over the cap, signed to match the token's (over-cap) minimum
  const b = world(k.id, { exists: true, storageMin: over, registered: fresh });
  const calls = clone(registrationOf(q, k.id));
  calls[0]!.actions[0].FunctionCall.deposit = over.toString();
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(calls, k, b.state.keyNonce) }, b.deps)), "storage_above_cap");
  assert.equal(b.sent.length, 0);
  // the gas account one yocto short of its floor and the creation: relayer_low
  const k3 = newKey();
  const lw = world(k3.id, { relayerNear: RELAYER_FLOOR_YOCTO + CREATE_YOCTO - 1n, registered: fresh });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k3.id), signed_delegates: [] }, lw.deps)), "relayer_low");
  assert.equal(lw.sent.length, 0);
});

test("R6 a delegate past its height window: expired at or under the final height and over 600 ahead, resign_needed under K; nothing sent", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  for (const [mbh, want] of [
    [FINAL, "expired"],
    [FINAL - 1n, "expired"],
    [FINAL + 601n, "expired"],
    [FINAL + K - 1n, "resign_needed"],
  ] as const) {
    const { deps, sent, state } = world(k.id, { exists: true });
    const calls = callsOf(q, k.id, { lostfound: 1n });
    // the last delegate alone is out of its window
    const signed = calls.map((c, i) => delegate(c, k, { nonce: state.keyNonce + BigInt(i) + 1n, ...(i === calls.length - 1 && { mbh }) }));
    assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signed }, deps)), want, `${mbh}`);
    assert.equal(sent.length, 0);
  }
  // inside the window at both ends: carried
  for (const mbh of [FINAL + K, FINAL + 600n]) {
    const { deps, state } = world(k.id, { exists: true });
    assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id), k, state.keyNonce, { mbh }) }, deps)), "ok");
  }
});

test("R7 a replayed delegate: the same bytes again send nothing (the same transactions answered); under another trade, replayed; below the key's nonce, bad_nonce", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const { deps, sent, state } = world(k.id, { exists: true });
  const signed = signAll(callsOf(q, k.id, { lostfound: 1n }), k, state.keyNonce);
  const body = { trade: tradeOf(q, k.id), signed_delegates: signed };
  assert.deepEqual(await carryTrade(body, deps), { status: 200, body: { tx_hashes: ["tx0", "tx1"] } });
  state.keyNonce += 2n; // the chain spent both nonces
  assert.deepEqual(await carryTrade(structuredClone(body), deps), { status: 200, body: { tx_hashes: ["tx0", "tx1"] } });
  // answered before anything else is read: a gas account below its floor still answers them, nothing spent
  assert.deepEqual(await carryTrade(structuredClone(body), { ...deps, relayer: { ...deps.relayer, balance: async () => 0n } }), { status: 200, body: { tx_hashes: ["tx0", "tx1"] } });
  assert.equal(sent.length, 2);
  // the same bytes named for another trade
  assert.equal(code(await carryTrade({ trade: { ...tradeOf(q, k.id), slippage_bps: 50 }, signed_delegates: signed }, deps)), "replayed");
  assert.equal(sent.length, 2);
  // bytes this helper never carried, at or below the key's nonce (landed some other way): bad_nonce
  const other = world(k.id, { exists: true });
  const old = signAll(callsOf(q, k.id), k, other.state.keyNonce - 1n);
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: old }, other.deps)), "bad_nonce");
  assert.equal(other.sent.length, 0);
});

test("R8 the delegate checks: signature, signer W with W's own key, rising nonces, one FunctionCall; nothing sent", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const calls = callsOf(q, k.id, { lostfound: 1n });
  const run = async (signed: string[], o: World = {}) => {
    const { deps, sent } = world(k.id, { exists: true, ...o });
    const a = await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signed }, deps);
    assert.equal(sent.length, 0);
    return code(a);
  };
  const n = FINAL * 1_000_000n - 5_000_000n;
  const good = signAll(calls, k, n);
  const flipped = Buffer.from(good[1]!, "base64");
  flipped[flipped.length - 1]! ^= 1;
  assert.equal(await run([good[0]!, flipped.toString("base64")]), "bad_signature");
  assert.equal(await run(calls.map((c, i) => delegate(c, k, { nonce: n + BigInt(i) + 1n, signer: newKey() }))), "bad_key");
  assert.equal(await run(calls.map((c, i) => delegate(c, k, { nonce: n + BigInt(i) + 1n, sender: "f".repeat(64) }))), "bad_sender");
  assert.equal(await run([delegate(calls[0]!, k, { nonce: n + 2n }), delegate(calls[1]!, k, { nonce: n + 1n })]), "bad_nonce");
  assert.equal(await run([delegate(calls[0]!, k, { nonce: n + 1n, extra: Buffer.concat([Buffer.from([7]), str("evil.near")]) }), good[1]!]), "not_one_action");
  assert.equal(await run(good, { exists: false }), "no_account");
  assert.equal(await run(good, { balance: q.amountIn - 1n }), "amount_above_balance");
  assert.equal(await run(good, { held: true }), "token_halted");
  assert.equal(await run([good[1]!, good[0]!]), "bad_nonce");
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: ["not base64!"] }, world(k.id).deps)), "bad_shape");
});

test("R9 one buy and one sell per W; a failed call stops the carry: nothing after it is sent", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const { deps, sent, state } = world(k.id, { exists: true });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id), k, state.keyNonce) }, deps)), "ok");
  state.keyNonce += 1n;
  const second = await carryTrade({ trade: { ...tradeOf(q, k.id), slippage_bps: 200 }, signed_delegates: signAll(callsOf(q, k.id), k, state.keyNonce) }, deps);
  assert.equal(code(second), "trade_used");
  assert.equal(sent.length, 1);
  const f = world(k.id, { exists: true, fail: 0 });
  const a = await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id, { lostfound: 1n }), k, f.state.keyNonce) }, f.deps);
  assert.deepEqual(a, { status: 502, body: { error: { code: "carry_failed" }, tx_hashes: ["tx0"] } });
  assert.equal(f.sent.length, 1);
});

test("R10 every code the trade carry answers is one of the kit's HELPER_BIND_TRADE_CODES, so the device and the helper cannot drift", () => {
  const src = readFileSync(new URL("./trade.ts", import.meta.url), "utf8");
  const used = new Set([...src.matchAll(/(?:no|bad)\("([a-z_0-9]+)"/g)].map((m) => m[1]!).concat([...src.matchAll(/return "([a-z_0-9]+)"/g)].map((m) => m[1]!)));
  for (const c of used) assert.ok((HELPER_BIND_TRADE_CODES as readonly string[]).includes(c), c);
  for (const n of ["input", "n1", "n2", "n3", "n4", "n7"]) assert.ok((HELPER_BIND_TRADE_CODES as readonly string[]).includes(`swap_${n}`));
  assert.ok(Object.isFrozen(HELPER_BIND_TRADE_CODES));
  void EX;
});

test("R11 the landing order is never the helper's to choose (review ruling): a registration and a swap in one request, bad_order; a swap before W's registration reads back on two providers, not_registered; nothing sent", async () => {
  const k = newKey();
  const buy = await quoteOf("buy RHEA through wNEAR");
  // the planted bad order: the registration and the swap signed as one set
  const both = world(k.id, { exists: true, registered: fresh });
  const set = signAll([...registrationOf(buy, k.id), ...callsOf(buy, k.id)], k, both.state.keyNonce);
  assert.equal(code(await carryTrade({ trade: tradeOf(buy, k.id), signed_delegates: set }, both.deps)), "bad_order");
  assert.equal(both.sent.length, 0);
  // the swap alone while W is not registered on the output token
  const early = world(k.id, { exists: true, registered: fresh });
  assert.equal(code(await carryTrade({ trade: tradeOf(buy, k.id), signed_delegates: signAll(callsOf(buy, k.id), k, early.state.keyNonce) }, early.deps)), "not_registered");
  assert.equal(early.sent.length, 0);
  // a sell while W is not registered on the input token (USDC registered)
  const sell = await quoteOf("sell RHEA through wNEAR");
  const s = world(k.id, { exists: true, registered: fresh });
  assert.equal(code(await carryTrade({ trade: tradeOf(sell, k.id), signed_delegates: signAll(callsOf(sell, k.id), k, s.state.keyNonce) }, s.deps)), "not_registered");
  // a sell while W is not registered on the output token, USDC
  const s2 = world(k.id, { exists: true, registered: (t) => t !== USDC });
  assert.equal(code(await carryTrade({ trade: tradeOf(sell, k.id), signed_delegates: signAll(callsOf(sell, k.id), k, s2.state.keyNonce) }, s2.deps)), "not_registered");
  assert.equal(s.sent.length + s2.sent.length, 0);
});

test("R12 one carried delegate at a time per W: while one of W's reads not final on two providers, nothing else of W's is accepted; and one swap per side per W, ever", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  // the swap sent, its outcome not read yet
  const w1 = world(k.id, { exists: true, unknown: true });
  const [swap, claim] = signAll(callsOf(q, k.id, { lostfound: 1n }), k, w1.state.keyNonce);
  assert.deepEqual(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [swap!] }, w1.deps), { status: 400, body: { error: { code: "in_flight" }, tx_hashes: ["tx0"] } });
  // the planted bad order: the claim sent next, while the swap may still be landing
  assert.deepEqual(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [claim!] }, w1.deps), { status: 400, body: { error: { code: "in_flight" }, tx_hashes: ["tx0"] } });
  assert.equal(w1.sent.length, 1);
  // two swaps for one W record: after the buy's swap, the same trade's swap signed again (a new nonce) is refused
  const w2 = world(k.id, { exists: true });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id), k, w2.state.keyNonce) }, w2.deps)), "ok");
  w2.state.keyNonce += 1n;
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id), k, w2.state.keyNonce) }, w2.deps)), "trade_used");
  assert.equal(w2.sent.length, 1);
});

// ---- Bounds, reads and floors: every hole held by a planted bad case ----

const req = (q: RheaQuote, w: string, slippageBps: number) => ({ network: "mainnet" as const, side: q.side, token: q.token, amountIn: q.amountIn, wallet: w, slippageBps });
const requoted = (q: RheaQuote, w: string, slippageBps: number) => nearSwapCalls({ quote: q, wallet: w, slippageBps, registered: true, storageMin: MIN, lostfound: 0n }, req(q, w, slippageBps));

test("R13 one claim a side per W: a second claim_lostfound after the side's swap and claim is trade_used, on a buy and on a sell; nothing more sent", async () => {
  for (const name of ["buy RHEA through wNEAR", "sell RHEA through wNEAR"]) {
    const k = newKey();
    const q = await quoteOf(name);
    const { deps, sent, state } = world(k.id, { exists: true });
    const [swap, claim] = callsOf(q, k.id, { lostfound: 1n });
    const n = state.keyNonce;
    const S = delegate(swap!, k, { nonce: n + 1n });
    assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [S, delegate(claim!, k, { nonce: n + 2n })] }, deps)), "ok", name);
    state.keyNonce = n + 2n;
    for (let i = 1; i <= 3; i++) {
      assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [S, delegate(claim!, k, { nonce: n + 2n + BigInt(i) })] }, deps)), "trade_used", `${name} claim ${i}`);
    }
    assert.equal(sent.length, 2, name);
  }
  // the bound is per side: one W's buy claim leaves its sell claim free
  const k = newKey();
  const { deps, sent, state } = world(k.id, { exists: true });
  for (const name of ["buy RHEA through wNEAR", "sell RHEA through wNEAR"]) {
    const q = await quoteOf(name);
    const [swap, claim] = callsOf(q, k.id, { lostfound: 1n });
    assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [delegate(swap!, k, { nonce: state.keyNonce + 1n }), delegate(claim!, k, { nonce: state.keyNonce + 2n })] }, deps)), "ok", name);
    state.keyNonce += 2n;
  }
  assert.equal(sent.length, 4);
});

test("R14 registrations: refused while W reads registered on the token (the helper's own read, passed to the kit's check), and after one was carried; W is bound to the token its first carried call named", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  // W reads registered: a registration round is refused, nothing sent
  const reg = registrationOf(q, k.id)[0]!;
  const done = world(k.id, { exists: true, registered: () => true });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [delegate(reg, k, { nonce: done.state.keyNonce + 1n })] }, done.deps)), "already_registered");
  assert.equal(done.sent.length, 0);
  // W unregistered: one registration carried; a second one (new bytes, W still reading unregistered) refused
  const one = world(k.id, { exists: true, registered: fresh });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [delegate(reg, k, { nonce: one.state.keyNonce + 1n })] }, one.deps)), "ok");
  one.state.keyNonce += 1n;
  const q2 = { ...q, venueOut: q.venueOut - 1_000n }; // another trade id
  assert.equal(code(await carryTrade({ trade: tradeOf(q2, k.id), signed_delegates: [delegate(reg, k, { nonce: one.state.keyNonce + 1n })] }, one.deps)), "already_registered");
  assert.equal(one.sent.length, 1);
  // bound to RHEA: a swap naming another token for this W is refused, nothing sent
  one.state.registered = () => true;
  const other = { ...q, token: "other-token.near", tokenOut: "other-token.near", hops: q.hops.map((h, i) => (i === q.hops.length - 1 ? { ...h, tokenOut: "other-token.near" } : h)) } as RheaQuote;
  const swap = nearSwapCalls({ quote: other, wallet: k.id, slippageBps: 100, registered: true, storageMin: MIN, lostfound: 0n }, req(other, k.id, 100));
  assert.equal(code(await carryTrade({ trade: tradeOf(other, k.id), signed_delegates: signAll(swap, k, one.state.keyNonce) }, one.deps)), "token_mismatch");
  assert.equal(one.sent.length, 1);
});

test("R15 a side is taken only when its swap's transaction is signed: a refusal in the relayer's guard (resign_needed at the newest final, token_halted) takes nothing and the re-signed swap is carried", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const { deps, sent, state } = world(k.id, { exists: true });
  deps.reads.newestFinalHeight = async () => FINAL + 20n; // the guard reads a newer final than the check
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id), k, state.keyNonce, { mbh: FINAL + K + 5n }) }, deps)), "resign_needed");
  deps.reads.newestFinalHeight = async () => FINAL;
  let calls = 0;
  deps.held = async () => ++calls >= 2; // open at the check, held in the guard
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id, 150), signed_delegates: signAll(requoted(q, k.id, 150), k, state.keyNonce) }, deps)), "token_halted");
  deps.held = async () => false;
  assert.equal(sent.length, 0);
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id, 200), signed_delegates: signAll(requoted(q, k.id, 200), k, state.keyNonce) }, deps)), "ok");
  assert.equal(sent.length, 1);
});

test("R16 a swap that failed on chain frees its side only with W's input back in full, at most 3 times a side; a failed swap whose input is not back keeps the side used", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  // every swap fails on chain; W's USDC reads back in full each time
  const back = world(k.id, { exists: true, receipts: () => [{ executor: EX, ok: false, failure: "E68: slippage error", height: FINAL + 2n }] });
  for (let i = 0; i < 3; i++) {
    assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id, 100 + i), signed_delegates: signAll(requoted(q, k.id, 100 + i), k, back.state.keyNonce) }, back.deps)), "carry_failed", `swap ${i}`);
    back.state.keyNonce += 1n;
  }
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id, 110), signed_delegates: signAll(requoted(q, k.id, 110), k, back.state.keyNonce) }, back.deps)), "trade_used");
  assert.equal(back.sent.length, 3);
  // the input not back on W (balance below amount_in after the failure): the side stays used
  const k2 = newKey();
  const gone = world(k2.id, { exists: true, fail: 0 });
  let balanceReads = 0;
  gone.deps.reads.ftBalance = async () => (++balanceReads === 1 ? 10n ** 30n : 0n); // spent at the check, not back after
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k2.id), signed_delegates: signAll(callsOf(q, k2.id), k2, gone.state.keyNonce) }, gone.deps)), "carry_failed");
  gone.state.keyNonce += 1n;
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k2.id, 150), signed_delegates: signAll(requoted(q, k2.id, 150), k2, gone.state.keyNonce) }, gone.deps)), "trade_used");
  // one yocto short of the input back is not back: the side stays used
  const k3 = newKey();
  const short = world(k3.id, { exists: true, fail: 0 });
  const amountIn = BigInt(tradeOf(q, k3.id).amount_in);
  let shortReads = 0;
  short.deps.reads.ftBalance = async () => (++shortReads === 1 ? 10n ** 30n : amountIn - 1n);
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k3.id), signed_delegates: signAll(callsOf(q, k3.id), k3, short.state.keyNonce) }, short.deps)), "carry_failed");
  short.state.keyNonce += 1n;
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k3.id, 150), signed_delegates: signAll(requoted(q, k3.id, 150), k3, short.state.keyNonce) }, short.deps)), "trade_used");
  // exactly the input back frees it
  const k4 = newKey();
  const exact = world(k4.id, { exists: true, fail: 0 });
  let exactReads = 0;
  exact.deps.reads.ftBalance = async () => (++exactReads === 1 ? 10n ** 30n : amountIn);
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k4.id), signed_delegates: signAll(callsOf(q, k4.id), k4, exact.state.keyNonce) }, exact.deps)), "carry_failed");
  exact.state.keyNonce += 1n;
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k4.id, 150), signed_delegates: signAll(requoted(q, k4.id, 150), k4, exact.state.keyNonce) }, exact.deps)), "ok");
});

test("R17 a crash between a swap's signing and its send leaves it pending: the next request reads it again (its bytes sent again), so the side never takes two swaps", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const { deps, state } = world(k.id, { exists: true });
  const sends: string[] = [];
  let crash = true;
  deps.relayer = {
    ...deps.relayer,
    async send(action, guard, before) {
      const c = await guard();
      if (c !== null) return { kind: "guarded", code: c };
      const tx: TxRef = { tx_hash: `tx${sends.length}`, nonce: "1", height: String(FINAL), block_hash: "h", signed_tx: "c2lnbmVk" };
      before(tx);
      if (crash) throw new Error("the process stopped before the send");
      sends.push(tx.tx_hash);
      return { kind: "final", tx_hash: tx.tx_hash, receipts: [{ executor: k.id, ok: true, failure: "", height: FINAL + 2n }] };
    },
    resolve: async (tx, o) => {
      assert.equal(o.resend, true);
      sends.push(`resent ${tx.tx_hash}`);
      return { kind: "final", tx_hash: tx.tx_hash, receipts: [{ executor: k.id, ok: true, failure: "", height: FINAL + 2n }] };
    },
  };
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id), k, state.keyNonce) }, deps)), "upstream");
  crash = false;
  // another swap for the side: the pending one is read again first (landed), and the side is used
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id, 150), signed_delegates: signAll(requoted(q, k.id, 150), k, state.keyNonce + 1n) }, deps)), "trade_used");
  assert.deepEqual(sends, ["resent tx0"]);
});

test("R18 a W someone else's Transfer created (its payout landed) is taken as it is: 200 with no transaction, then wallet_created; its calls are carried under the same bounds", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const { deps, sent, state } = world(k.id, { exists: true, registered: fresh });
  assert.deepEqual(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [] }, deps), { status: 200, body: { tx_hashes: [] } });
  assert.deepEqual(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [] }, deps), { status: 409, body: { error: { code: "wallet_created" } } });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(registrationOf(q, k.id), k, state.keyNonce) }, deps)), "ok");
  assert.equal(sent.length, 1);
  // a W that exists with no landed payout gets nothing
  const k2 = newKey();
  const unpaid = world(k2.id, { exists: true, payout: false });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k2.id), signed_delegates: [] }, unpaid.deps)), "no_payout");
  // a sell names a W that already holds the token: never a creation
  const sell = await quoteOf("sell RHEA through wNEAR");
  const s = world(k2.id);
  assert.equal(code(await carryTrade({ trade: tradeOf(sell, k2.id), signed_delegates: [] }, s.deps)), "no_account");
  assert.equal(s.sent.length, 0);
});

test("R19 a token whose hops are not Rhea pools holding their two tokens is refused before anything is sent (token_untrusted)", async () => {
  const k = newKey();
  const q = await quoteOf("sell RHEA through wNEAR");
  const { deps, sent, state } = world(k.id, { exists: true, hopsReal: false });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id), k, state.keyNonce) }, deps)), "token_untrusted");
  assert.equal(sent.length, 0);
});

test("R20 the gas account's floor with the calls' deposits, outside and again in the relayer's guard; the creation's guard reads W absent again", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  // outside: below the floor plus the registration's deposit
  const out = world(k.id, { exists: true, registered: fresh, relayerNear: RELAYER_FLOOR_YOCTO + MIN - 1n });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(registrationOf(q, k.id), k, out.state.keyNonce) }, out.deps)), "relayer_low");
  assert.equal(out.sent.length, 0);
  // inside the guard: enough at the check, short in the queue
  const inside = world(k.id, { exists: true, registered: fresh });
  let reads = 0;
  inside.deps.relayer.balance = async () => (++reads >= 2 ? RELAYER_FLOOR_YOCTO : 10n ** 26n);
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(registrationOf(q, k.id), k, inside.state.keyNonce) }, inside.deps)), "relayer_low");
  assert.equal(inside.sent.length, 0);
  // the creation: W absent at the check, present in the queue: wallet_exists, no Transfer
  const k2 = newKey();
  const c = world(k2.id, { registered: fresh });
  let looks = 0;
  c.deps.reads.account = async () => (++looks >= 2 ? { kind: "account" } : { kind: "absent" });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k2.id), signed_delegates: [] }, c.deps)), "wallet_exists");
  assert.equal(c.sent.length, 0);
  // the creation held by the token watch
  const h = world(newKey().id, { held: true });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, newKey().id), signed_delegates: [] }, h.deps)), "no_payout");
  const k4 = newKey();
  const h4 = world(k4.id, { held: true });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k4.id), signed_delegates: [] }, h4.deps)), "token_halted");
  assert.equal(h4.sent.length, 0);
});

test("R21 a read that fails or that the providers disagree on answers upstream (503), nothing sent; the device asks again", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const { deps, sent, state } = world(k.id, { exists: true });
  deps.reads.registered = async () => {
    throw new Error("storage_balance_of at block 1: the providers' bytes differ");
  };
  assert.deepEqual(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id), k, state.keyNonce) }, deps), { status: 503, body: { error: { code: "upstream" } } });
  const c = world(newKey().id);
  c.deps.reads.payoutLanded = async () => {
    throw new Error("spends: rpc 1 no answer");
  };
  assert.equal(code(await carryTrade({ trade: tradeOf(q, newKey().id), signed_delegates: [] }, c.deps)), "upstream");
  assert.equal(sent.length + c.sent.length, 0);
  assert.equal(HELPER_CODE_STATUS.upstream, 503);
  assert.ok((HELPER_BIND_TRADE_CODES as readonly string[]).includes("upstream"));
});

test("R22 an outcome is landed only when it has receipts and every one ran: one failed receipt among ok ones, or none at all, is not landed", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const mixed = world(k.id, { exists: true, receipts: () => [{ executor: k.id, ok: true, failure: "", height: FINAL + 1n }, { executor: EX, ok: false, failure: "E68", height: FINAL + 2n }] });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id), k, mixed.state.keyNonce) }, mixed.deps)), "carry_failed");
  const none = world(k.id, { exists: true, receipts: () => [] });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id), k, none.state.keyNonce) }, none.deps)), "carry_failed");
  // a creation whose Transfer failed is never followed by another one
  const k2 = newKey();
  const f = world(k2.id, { fail: 0 });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k2.id), signed_delegates: [] }, f.deps)), "carry_failed");
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k2.id), signed_delegates: [] }, f.deps)), "wallet_created");
  assert.equal(f.sent.length, 1);
});

test("R23 the key and the nonces: a function-call key is refused (bad_key); two delegates with one nonce are refused (bad_nonce); nothing sent", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const fc = world(k.id, { exists: true, permission: "FunctionCall" });
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id), k, fc.state.keyNonce) }, fc.deps)), "bad_key");
  const eq = world(k.id, { exists: true });
  const [swap, claim] = callsOf(q, k.id, { lostfound: 1n });
  const n = eq.state.keyNonce + 1n;
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [delegate(swap!, k, { nonce: n }), delegate(claim!, k, { nonce: n })] }, eq.deps)), "bad_nonce");
  assert.equal(fc.sent.length + eq.sent.length, 0);
});

test("R24 the args' JSON as W signed it: a duplicate key or a space is refused (bad_shape), nothing sent; keys in another order read the same and are carried", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const [swapCall] = callsOf(q, k.id);
  const a = swapCall!.actions[0].FunctionCall.args as { receiver_id: string; amount: string; msg: string };
  const texts: [string, string][] = [
    [`{"receiver_id":"evil.near","receiver_id":${JSON.stringify(a.receiver_id)},"amount":${JSON.stringify(a.amount)},"msg":${JSON.stringify(a.msg)}}`, "bad_shape"],
    [`{"receiver_id": ${JSON.stringify(a.receiver_id)},"amount":${JSON.stringify(a.amount)},"msg":${JSON.stringify(a.msg)}}`, "bad_shape"],
    [`{"amount":${JSON.stringify(a.amount)},"receiver_id":${JSON.stringify(a.receiver_id)},"msg":${JSON.stringify(a.msg)}}`, "ok"],
  ];
  for (const [t, want] of texts) {
    const { deps, sent, state } = world(k.id, { exists: true });
    const f = swapCall!.actions[0].FunctionCall;
    const action = Buffer.concat([Buffer.from([2]), str(f.method_name), str(t), le(BigInt(f.gas), 8), le(BigInt(f.deposit), 16)]);
    const d = Buffer.concat([str(k.id), str(swapCall!.receiver_id), le(1n, 4), action, le(state.keyNonce + 1n, 8), le(FINAL + 120n, 8), Buffer.from([0]), k.pub]);
    const hash = createHash("sha256").update(le(BigInt(NEP366_PREFIX), 4)).update(d).digest();
    const b64 = Buffer.concat([d, Buffer.from([0]), sign(null, hash, k.priv)]).toString("base64");
    assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: [b64] }, deps)), want, t.slice(0, 40));
    assert.equal(sent.length, want === "ok" ? 1 : 0);
  }
});

// ---- The gas account's bound per payout, whatever the token's contract does ----

const methodOf = (a: RelayerAction) => (a.kind === "delegate" ? (decodeSignedDelegate(a.signed).actions[0] as { method_name?: string }).method_name ?? "" : a.kind);
/** What the sends can cost the gas account at worst: the creation as paid on mainnet, each call's prepaid gas and 1 Tgas at the bound price, and its deposit. */
const worst = (sent: Sent[]) =>
  sent.reduce((a, s) => {
    if (s.action.kind !== "delegate") return a + HELPER_BIND_TRADE_CREATE_YOCTO + 7_120_000_000_000_000_000_000n;
    const f = decodeSignedDelegate(s.action.signed).actions[0] as { gas: bigint; deposit: bigint };
    return a + (f.gas + 10n ** 12n) * TRADE_GAS_PRICE + f.deposit;
  }, 0n);

test("R25 a stranger's token with its own Rhea pool, one payout: its storage minimum at the cap, swaps that burn their gas and fail with the input read back, claims; the gas account stops at TRADE_COST_MAX", async () => {
  const k = newKey();
  const EVIL = "evil-token.near";
  const mk = (side: "buy" | "sell", venue: bigint) =>
    ({ network: "mainnet", exchange: EX, side, token: EVIL, tokenIn: side === "buy" ? USDC : EVIL, tokenOut: side === "buy" ? EVIL : USDC, amountIn: 1_000_000n, venueOut: venue, hops: [{ pool: 7, tokenIn: side === "buy" ? USDC : EVIL, tokenOut: side === "buy" ? EVIL : USDC, amountIn: 0n, amountOut: 0n, feeBps: 0 }] }) as unknown as RheaQuote;
  // the token's views: storage minimum at the cap; unregistered until the registration; ft_balance_of always enough;
  // each call burns all its prepaid gas and its transaction's own, read so on both providers
  const allGas = (_n: number, a: RelayerAction) => (a.kind === "delegate" ? ((decodeSignedDelegate(a.signed).actions[0] as { gas: bigint }).gas + 10n ** 12n) * TRADE_GAS_PRICE : 0n);
  const { deps, sent, state } = world(k.id, { storageMin: HELPER_BIND_TRADE_STORAGE_MAX, registered: fresh, burnt: allGas });
  // the swaps the token wants failed fail on chain, after burning the call's gas
  let failsLeft = { buy: 2, sell: 2 };
  let side: "buy" | "sell" = "buy";
  const send0 = deps.relayer.send.bind(deps.relayer);
  deps.relayer.send = (async (action, guard, before) => {
    const out = await send0(action, guard, before);
    if (out.kind === "final" && methodOf(action) === "ft_transfer_call" && failsLeft[side] > 0) {
      failsLeft = { ...failsLeft, [side]: failsLeft[side] - 1 };
      return { ...out, receipts: [{ ...out.receipts[0]!, ok: false, failure: "Exceeded the prepaid gas" }] };
    }
    return out;
  }) as typeof deps.relayer.send;
  const go = async (q: RheaQuote, o: { registered: boolean; lostfound: bigint }) => {
    const calls = nearSwapCalls({ quote: q, wallet: k.id, slippageBps: 100, registered: o.registered, storageMin: HELPER_BIND_TRADE_STORAGE_MAX, lostfound: o.lostfound }, { network: "mainnet", side: q.side, token: EVIL, amountIn: q.amountIn, wallet: k.id, slippageBps: 100 });
    const a = await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(calls, k, state.keyNonce) }, deps);
    state.keyNonce += BigInt(calls.length);
    return code(a);
  };
  const log: string[] = [];
  log.push(code(await carryTrade({ trade: tradeOf(mk("buy", 1000n), k.id), signed_delegates: [] }, deps))); // creation
  log.push(await go(mk("buy", 1000n), { registered: false, lostfound: 0n })); // registration at the cap
  state.registered = () => true;
  for (const s of ["buy", "sell"] as const) {
    side = s;
    log.push(await go(mk(s, 1000n), { registered: true, lostfound: 0n }));
    log.push(await go(mk(s, 999n), { registered: true, lostfound: 0n }));
    log.push(await go(mk(s, 998n), { registered: true, lostfound: 1n }));
    log.push(await go(mk(s, 997n), { registered: true, lostfound: 1n }));
  }
  // creation 0.00894 + registration 0.0136 + two failed buys 0.0302 + the buy and its claim 0.0252 = 0.07794 N; the
  // sell's first swap would make 0.09304 N, past the bound: refused, and every request after it
  assert.deepEqual(log, ["ok", "ok", "carry_failed", "carry_failed", "ok", "trade_used", "trade_used", "trade_used", "trade_used", "trade_used"]);
  assert.deepEqual(sent.map((s) => methodOf(s.action)), ["transfer", "storage_deposit", "ft_transfer_call", "ft_transfer_call", "ft_transfer_call", "claim_lostfound"]);
  assert.ok(worst(sent) <= TRADE_COST_MAX, `${worst(sent)}`);
  assert.equal(worst(sent), 77_940_000_000_000_000_000_000n + 4n);
});

test("R26 an honest payout fits the bound: a buy with its registration at the cap, one failed swap, the swap and its claim, then a sell and its claim", async () => {
  const k = newKey();
  const buy = await quoteOf("buy RHEA through wNEAR");
  const sell = await quoteOf("sell RHEA through wNEAR");
  const { deps, sent, state } = world(k.id, { storageMin: HELPER_BIND_TRADE_STORAGE_MAX, registered: fresh });
  let fails = 1;
  const send0 = deps.relayer.send.bind(deps.relayer);
  deps.relayer.send = (async (action, guard, before) => {
    const out = await send0(action, guard, before);
    if (out.kind === "final" && methodOf(action) === "ft_transfer_call" && fails-- > 0) return { ...out, receipts: [{ ...out.receipts[0]!, ok: false, failure: "E68: slippage error" }] };
    return out;
  }) as typeof deps.relayer.send;
  const run = async (q: RheaQuote, calls: NearSwapCall[], slippage = 100) => {
    const a = code(await carryTrade({ trade: tradeOf(q, k.id, slippage), signed_delegates: signAll(calls, k, state.keyNonce) }, deps));
    state.keyNonce += BigInt(calls.length);
    return a;
  };
  const reg = nearSwapCalls({ quote: buy, wallet: k.id, slippageBps: 100, registered: false, storageMin: HELPER_BIND_TRADE_STORAGE_MAX, lostfound: 0n }, req(buy, k.id, 100)).filter((c) => c.actions[0].FunctionCall.method_name === "storage_deposit");
  const log = [
    code(await carryTrade({ trade: tradeOf(buy, k.id), signed_delegates: [] }, deps)),
    await run(buy, reg),
  ];
  state.registered = () => true;
  log.push(await run(buy, requoted(buy, k.id, 101), 101));
  log.push(await run(buy, callsOf(buy, k.id, { lostfound: 1n })));
  log.push(await run(sell, callsOf(sell, k.id, { lostfound: 1n })));
  assert.deepEqual(log, ["ok", "ok", "carry_failed", "ok", "ok"]);
  assert.equal(sent.length, 7);
  // 0.00894 + 0.0136 + 3 x 0.0151 + 2 x 0.0101 = 0.08804 N (and 5 yocto), under 0.09 N
  assert.equal(worst(sent), 88_040_000_000_000_000_000_000n + 5n);
  assert.ok(worst(sent) <= TRADE_COST_MAX);
});

test("R27 a W the vault never paid: its carry answers no_payout before the helper reads any token's contract", async () => {
  const k = newKey();
  const q = await quoteOf("buy RHEA through wNEAR");
  const { deps, sent, state } = world(k.id, { exists: true, payout: false });
  const touched: string[] = [];
  deps.reads.registered = async (tokens) => (touched.push("registered"), tokens.map(() => true));
  deps.reads.storageMin = async () => (touched.push("storageMin"), MIN);
  deps.reads.hopsReal = async () => (touched.push("hopsReal"), true);
  deps.reads.ftBalance = async () => (touched.push("ftBalance"), 10n ** 30n);
  assert.equal(code(await carryTrade({ trade: tradeOf(q, k.id), signed_delegates: signAll(callsOf(q, k.id), k, state.keyNonce) }, deps)), "no_payout");
  assert.deepEqual(touched, []);
  assert.equal(sent.length, 0);
});

/** What mainnet receipts burnt (11 Nov reads): a registration about 0.00031 N, a swap 0.00164 N, a claim 0.0003 N. */
const MAINNET_BURNT: Record<string, bigint> = { storage_deposit: 310_000_000_000_000_000_000n, ft_transfer_call: 1_640_000_000_000_000_000_000n, claim_lostfound: 300_000_000_000_000_000_000n };

test("R28 an honest W counted at what its calls burnt once final: a registration at the cap, TRADE_SWAP_FAILS_MAX failed buys, a failed sell, then the sell and its claim are carried", async () => {
  const k = newKey();
  const buy = await quoteOf("buy RHEA through wNEAR");
  const sell = await quoteOf("sell RHEA through wNEAR");
  const { deps, sent, state } = world(k.id, { storageMin: HELPER_BIND_TRADE_STORAGE_MAX, registered: fresh, burnt: (_n, a) => MAINNET_BURNT[methodOf(a)] ?? 0n });
  let fails = TRADE_SWAP_FAILS_MAX + 1;
  const send0 = deps.relayer.send.bind(deps.relayer);
  deps.relayer.send = (async (action, guard, before) => {
    const out = await send0(action, guard, before);
    if (out.kind === "final" && methodOf(action) === "ft_transfer_call" && fails-- > 0) return { ...out, receipts: [{ ...out.receipts[0]!, ok: false, failure: "E68: slippage error" }] };
    return out;
  }) as typeof deps.relayer.send;
  const run = async (q: RheaQuote, calls: NearSwapCall[], slippage: number) => {
    const a = code(await carryTrade({ trade: tradeOf(q, k.id, slippage), signed_delegates: signAll(calls, k, state.keyNonce) }, deps));
    state.keyNonce += BigInt(calls.length);
    return a;
  };
  const reg = nearSwapCalls({ quote: buy, wallet: k.id, slippageBps: 100, registered: false, storageMin: HELPER_BIND_TRADE_STORAGE_MAX, lostfound: 0n }, req(buy, k.id, 100)).filter((c) => c.actions[0].FunctionCall.method_name === "storage_deposit");
  const log = [code(await carryTrade({ trade: tradeOf(buy, k.id), signed_delegates: [] }, deps)), await run(buy, reg, 100)];
  state.registered = () => true;
  for (let i = 0; i < TRADE_SWAP_FAILS_MAX; i++) log.push(await run(buy, requoted(buy, k.id, 101 + i), 101 + i));
  log.push(await run(sell, requoted(sell, k.id, 120), 120));
  const [swap, claim] = nearSwapCalls({ quote: sell, wallet: k.id, slippageBps: 121, registered: true, storageMin: MIN, lostfound: 1n }, req(sell, k.id, 121));
  log.push(await run(sell, [swap!, claim!], 121));
  assert.deepEqual(log, ["ok", "ok", ...Array(TRADE_SWAP_FAILS_MAX).fill("carry_failed"), "carry_failed", "ok"]);
  assert.deepEqual(sent.map((x) => methodOf(x.action)).slice(-2), ["ft_transfer_call", "claim_lostfound"]);
  // counted: 0.00894 + (0.00031 + 0.0125) + 5 x 0.00164 + 0.0003 N = 0.03025 N and the calls' yocto deposits
  const rec = deps.store.get(k.id)!;
  assert.equal(rec.carried.reduce((a, x) => a + BigInt(x.cost), 0n), 310_000_000_000_000_000_000n + HELPER_BIND_TRADE_STORAGE_MAX + 5n * 1_640_000_000_000_000_000_000n + 300_000_000_000_000_000_000n + 6n);
});
