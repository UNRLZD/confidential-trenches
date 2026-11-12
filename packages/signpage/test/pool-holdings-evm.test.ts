// A Base W's buy record rebuilt on a device that never made the buy (src/pool-holdings-evm.ts), on SIGN_HOST's build
// (this file sets no network: POOL_TESTNET is false, the mainnet pins): the W, the token and the buy's transaction hash
// from the pool sync's round (both RPCs' agreed rows), the route from the helper's answer for that hash alone, held to
// the hash, the pool and the token, the decimals on both pool RPCs. A fresh device's record, position and sale plan; a
// reload; a sold and a partly sold W; a refused buy; a round the RPCs read apart; a helper that lies, withholds or
// fails; and the page's own wiring, which names no buy to a public provider.
//   node --test test/pool-holdings-evm.test.ts      (from packages/signpage)
// The seed is the published all-zero vector (packages/wallet/test/vectors/a8.json). The type 2 transaction in
// test/fixtures/base-type2-tx.json is a real Base one (one public read), its sender dropped.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import { EVM_CHAIN_IDS, EVM_POOLS, evmPoolScopeOf, type EvmPoolEvent, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { evmPoolVenues, pinnedBuild } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { BOUGHT } from "../../kit/test/evm-sell-quote-fx.ts";

// the page's channels live as long as the page (test/pool-mainnet-evm.test.ts): the process ends with them open
const BC = globalThis.BroadcastChannel;
(globalThis as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel = class extends BC {
  constructor(name: string) {
    super(name);
    (this as unknown as { unref?: () => void }).unref?.();
  }
};
const { evmBuyCalldata } = await import("../src/evm-send.ts");
const { EVM_POSITION_COSTS_KEY } = await import("../src/pool-buy-evm.ts");
const { EVM_CARRY_DONE_KEY } = await import("../src/pool-carry-evm.ts");
const { evmType2Hash, rebuildEvmHoldings } = await import("../src/pool-holdings-evm.ts");
type Host = import("../src/pool-holdings-evm.ts").EvmHoldingsHost;
const { evmPositionsPass } = await import("../src/positions-evm.ts");
const { planEvmSell } = await import("../src/pool-sell-evm.ts");
const { testnetPool } = await import("../src/pool-testnet.ts");
const { TRADE_HELPER } = await import("../src/trade.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");

assert.equal(POOL_TESTNET, false, "this file runs as SIGN_HOST's build");
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const PIN = EVM_POOLS.base!;
const POOL = PIN.pool.toLowerCase();
const SCOPE = evmPoolScopeOf(POOL, EVM_CHAIN_IDS.base);
const V4 = evmPoolVenues().base!.adapters!.v4!.toLowerCase();
const q = (v: bigint | number) => "0x" + BigInt(v).toString(16);
const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
const DECIMALS = "0x313ce567";
const BALANCE_OF = "0x70a08231";
const BUY_BLOCK = 40_000_000n;
const BH = "0x" + "cd".repeat(32);
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));

/** A token's buy route: BOUGHT's v4 path, ending at `token`. */
const routeTo = (token: string) => ({ ...BOUGHT, hops: [{ ...BOUGHT.hops[0]!, currency: token.toLowerCase() }] });

/** The device's i-th spent deposit note of the pool (as a restore from the words writes it), its W and its nullifier. */
function noteOf(i: number): { n: NoteRecord; w: string; nullifier: bigint } {
  const ref: NoteRef = { kind: "deposit", s: SCOPE, i };
  const label = vaultLabelOf(keccak_256, SCOPE, BigInt(i + 1));
  const pre = noteSecrets(SEED, ref).precommitment;
  const value = 10n ** 15n;
  const n: NoteRecord = { id: `n${i}`, ref, scope: SCOPE, precommitment: pre, state: "SPENT", leaf: { value, label, commitment: noteCommitment(value, label, pre), leafIndex: BigInt(i) } };
  const k = freshWallet(SEED, "evm", label, jOf(ref));
  k.secretKey.fill(0);
  return { n, w: k.address.toLowerCase(), nullifier: noteSecrets(SEED, ref).nullifierHash };
}

/** W's buy of `token` as sent: its signed type 2 transaction (the fields an RPC answers) and its hash. */
function buyTx(w: string, token: string, nonce = 0) {
  const built = pinnedBuild(evmPoolVenues(), "base", V4, routeTo(token) as never, 5n, token, true);
  const relay = { recipient: w, feeRecipient: PIN.feeRecipient, feeCap: 1n, deadlineMs: 1n, refundPrecommitment: 9n, salt: "0x" + "ab".repeat(16) };
  const proof = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] };
  const input = "0x" + Buffer.from(evmBuyCalldata(POOL, relay as never, proof as never, ["1", "2", "3", "4", "5", "6", "7", "8"] as never, 1n, built, new Uint8Array(65))).toString("hex");
  const tx: Record<string, unknown> = { type: "0x2", chainId: q(8453), nonce: q(nonce), maxPriorityFeePerGas: q(1_000_000), maxFeePerGas: q(50_000_000), gas: q(900_000), to: POOL, value: "0x0", input, accessList: [], yParity: "0x1", v: "0x1", r: "0x" + "5a".repeat(32), s: "0x" + "3c".repeat(32) };
  tx.hash = evmType2Hash(tx);
  return tx as Record<string, unknown> & { hash: string; input: string };
}

/** A release row of the round as the pool sync gives it (decodeLog's bytes: block, hash, log index, tx, ...). */
function row(kind: "buy" | "withdraw", nullifier: bigint, w: string, tx: string, token: string | null, logIndex: bigint): EvmPoolEvent {
  return { block: BUY_BLOCK, blockHash: BH, logIndex, bytes: [q(BUY_BLOCK), BH, q(logIndex), tx, "0x0", POOL, "t0", "t1", "0x"].join(" "), kind, state: 5n + logIndex, label: null, value: 10n ** 15n, precommitment: null, nullifier, recipient: w, token: token === null ? null : token.toLowerCase() } as EvmPoolEvent;
}

const stores = async (): Promise<WalletStore> => {
  const ws = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => ws.close());
  return ws;
};
let tokens = 0;
/** A token no earlier test read the decimals of (the page keeps them: pool-kinds.ts keptTokenDecimals). */
const freshToken = () => "0x" + (0xf20000 + ++tokens).toString(16).padStart(40, "0");

/** The world of one device: its notes, the round, the helper's route and the pool's two RPCs, each call kept. */
function world(o: { notes: NoteRecord[]; events: EvmPoolEvent[]; txs: Record<string, unknown>[]; decimals?: [bigint, bigint]; ws: WalletStore }) {
  const helperAsked: string[] = [];
  const publicAsked: string[][] = [[], []];
  const helper = { mode: "ok" as "ok" | "withhold" | "fail" | "forge" | "other-token", forged: null as Record<string, unknown> | null };
  const help: EvmRpc = async (method, params) => {
    helperAsked.push(`${method} ${JSON.stringify(params)}`);
    if (method !== "eth_getTransactionByHash") throw new Error(`no ${method} on the helper`);
    if (helper.mode === "fail") throw new Error("HTTP 503");
    if (helper.mode === "withhold") return null;
    const t = o.txs.find((x) => x.hash === params[0]);
    if (t === undefined) return null;
    if (helper.mode === "forge" || helper.mode === "other-token") return helper.forged;
    return t;
  };
  const pub = (k: 0 | 1): EvmRpc => async (method, params) => {
    publicAsked[k]!.push(`${method} ${JSON.stringify(params)}`);
    const c = params[0] as { to?: string; data?: string };
    if (method === "eth_call" && c?.data === DECIMALS) return word((o.decimals ?? [18n, 18n])[k]);
    throw new Error(`unmocked ${method}`);
  };
  const seeds: Uint8Array[] = [];
  const round = { fail: false, reads: 0 };
  const host: Host = {
    chain: "base",
    network: "base",
    pin: PIN,
    scope: SCOPE,
    rpcs: [pub(0), pub(1)],
    helper: help,
    round: async () => {
      round.reads++;
      if (round.fail) throw new Error("the RPCs' logs differ: refused");
      return { events: o.events };
    },
    notes: async () => o.notes,
    seed64: async () => (seeds.push(SEED.slice()), seeds.at(-1)!),
    held: async () => o.ws,
  };
  return { host, helper, round, helperAsked, publicAsked, seeds };
}
const recordsOf = async (ws: WalletStore) => ((await ws.get("meta", EVM_POSITION_COSTS_KEY)) ?? {}) as Record<string, unknown>;

/** The chain's positions as the page's mainnet pass reads them: W's balance on the helper (`one`), heads and decimals on
 *  the pool's pair. */
async function positionsOf(ws: WalletStore, held: Map<string, bigint>) {
  const head: EvmRpc = async (m) => (m === "eth_blockNumber" ? q(BUY_BLOCK + 10n) : word(18n));
  const one: EvmRpc = async (m, p) => {
    if (m === "eth_getBlockByNumber") return { number: q(BUY_BLOCK + 10n), hash: "0x" + "4b".repeat(32) };
    const c = p[0] as { to: string; data: string };
    if (m === "eth_call" && c.data.startsWith(BALANCE_OF)) return word(held.get(`0x${c.data.slice(-40)} ${c.to.toLowerCase()}`) ?? 0n);
    throw new Error(`unmocked ${m}`);
  };
  const r = await evmPositionsPass(
    { chain: "base", rpcs: [head, head], signal: new AbortController().signal, holdings: () => recordsOf(ws), decimals: async () => 18, one },
    { held: new Map(), decimals: new Map() } as never,
  );
  return r.positions.map((p) => `${p.token} ${p.amount} ${p.wallets.join(",")}`);
}

test("the hash of a signed type 2 transaction from its RPC fields: a real Base transaction; any field changed, another hash", () => {
  const { tx } = JSON.parse(readFileSync(new URL("./fixtures/base-type2-tx.json", import.meta.url), "utf8")) as { tx: Record<string, unknown> & { hash: string } };
  assert.equal(evmType2Hash(tx), tx.hash);
  for (const [k, v] of [["nonce", "0x1"], ["value", "0x1"], ["input", "0x00"], ["to", POOL], ["yParity", tx.yParity === "0x0" ? "0x1" : "0x0"]] as const)
    assert.notEqual(evmType2Hash({ ...tx, [k]: v, ...(k === "yParity" ? { v } : {}) }), tx.hash, `${k} changed`);
  assert.throws(() => evmType2Hash({ ...tx, type: "0x0" }), /not a type 2/);
  assert.throws(() => evmType2Hash({ ...tx, nonce: "0x01" }), /not a quantity/);
});

test("a fresh device (the notes from the words, no record): W's record is rebuilt from the round and the helper's transaction; its position shows; the sale's plan finds W on the buy's route; the seed zeroed", async () => {
  const ws = await stores();
  const token = freshToken();
  const a = noteOf(0);
  const tx = buyTx(a.w, token);
  const x = world({ notes: [a.n], events: [row("buy", a.nullifier, a.w, tx.hash, token, 3n)], txs: [tx], ws });
  assert.deepEqual(await rebuildEvmHoldings(x.host), [a.w]);
  const rec = (await recordsOf(ws))[a.w];
  assert.deepEqual(rec, { mint: token, decimals: 18, chain: "base", state: "filled", route: { venue: "uniswap-v4", adapter: V4, path: routeTo(token), tx: tx.hash, block: BUY_BLOCK.toString() } });
  assert.ok(x.seeds.length > 0 && x.seeds.every((s) => s.every((b) => b === 0)), "every seed copy zeroed");
  assert.deepEqual(await positionsOf(ws, new Map([[`${a.w} ${token}`, 7n * 10n ** 18n]])), [`${token} 7 ${a.w}`], "the position shows");
  // the sale's plan (pool-sell-evm.ts planEvmSell) takes the rebuilt record: W on the buy's own route and block
  const bal: EvmRpc = async (m, p) => (m === "eth_blockNumber" ? q(BUY_BLOCK + 10n) : (p[0] as { data: string }).data.startsWith(BALANCE_OF) ? word(7n * 10n ** 18n) : assert.fail(m));
  const plan = await planEvmSell(
    { chain: "base", scope: SCOPE, rpcs: [bal, bal], notes: async () => ({ list: async () => [a.n] }) as never, seed64: async () => SEED.slice(), holdings: () => recordsOf(ws) },
    { kind: "pool.sell", chain: "base", token, amount: 10n ** 18n, slippageBps: 100, decimals: 18 },
  );
  assert.deepEqual(plan.legs.map((l) => [l.w.w, l.w.route, l.w.block, l.units]), [[a.w, routeTo(token), BUY_BLOCK, 10n ** 18n]]);
});

test("a reload: a second pass writes nothing and asks the helper nothing (the record is there)", async () => {
  const ws = await stores();
  const token = freshToken();
  const a = noteOf(0);
  const tx = buyTx(a.w, token);
  const x = world({ notes: [a.n], events: [row("buy", a.nullifier, a.w, tx.hash, token, 3n)], txs: [tx], ws });
  assert.deepEqual(await rebuildEvmHoldings(x.host), [a.w]);
  const once = structuredClone(await recordsOf(ws));
  const asked = x.helperAsked.length;
  assert.deepEqual(await rebuildEvmHoldings(x.host), []);
  assert.deepEqual(await recordsOf(ws), once, "one record");
  assert.equal(x.helperAsked.length, asked, "no second read");
  assert.equal(x.round.reads, 1, "every spent note's W has a record: the second pass reads no round");
});

test("a W already sold shows no position; a W partly sold shows what it still holds; a W this device bought keeps its own record", async () => {
  const ws = await stores();
  const token = freshToken();
  const [a, b, c] = [noteOf(0), noteOf(1), noteOf(2)];
  const txs = [buyTx(a.w, token), buyTx(b.w, token), buyTx(c.w, token)];
  const own = { mint: token, decimals: 18, chain: "base", state: "pending", route: { venue: "uniswap-v4", adapter: V4, path: routeTo(token) }, buy: { nullifier: "1" } };
  await ws.update("meta", EVM_POSITION_COSTS_KEY, () => ({ [c.w]: own }));
  const x = world({ notes: [a.n, b.n, c.n], events: [a, b, c].map((n, i) => row("buy", n.nullifier, n.w, txs[i]!.hash, token, BigInt(i))), txs, ws });
  assert.deepEqual((await rebuildEvmHoldings(x.host)).sort(), [a.w, b.w].sort());
  assert.deepEqual((await recordsOf(ws))[c.w], own, "the buy's own record kept (its follow fills it)");
  assert.ok(x.helperAsked.every((l) => !l.includes(txs[2]!.hash)), "W with a record: its transaction never asked");
  // a sold all, b sold 2 of 5
  const rows = await positionsOf(ws, new Map([[`${a.w} ${token}`, 0n], [`${b.w} ${token}`, 3n * 10n ** 18n]]));
  assert.deepEqual(rows, [`${token} 3 ${b.w}`], "no ghost row for the sold W, the remaining amount for the other");
});

test("a refused buy (the release a Withdrawn) writes no record and asks the helper nothing: the carry owns its ETH", async () => {
  const ws = await stores();
  const a = noteOf(0);
  const x = world({ notes: [a.n], events: [row("withdraw", a.nullifier, a.w, "0x" + "77".repeat(32), null, 3n)], txs: [], ws });
  assert.deepEqual(await rebuildEvmHoldings(x.host), []);
  assert.equal(await ws.get("meta", EVM_POSITION_COSTS_KEY), undefined);
  assert.deepEqual(x.helperAsked, []);
  // once the carry has ended W (pool-carry-evm.ts EVM_CARRY_DONE_KEY), a pass reads no round for it
  const reads = x.round.reads;
  await ws.update("meta", EVM_CARRY_DONE_KEY, () => ({ [a.w]: { chain: "base", end: "carried" } }));
  assert.deepEqual(await rebuildEvmHoldings(x.host), []);
  assert.equal(x.round.reads, reads, "a W the carry ended: no round read");
});

test("a round the two RPCs read apart (the sync refuses it, wallet test/pool-evm.test.ts \"the same differing logs with no reorg are refused at once\") writes nothing; a Bought to another W, or of another note, writes nothing; decimals the two RPCs read apart write nothing", async () => {
  const ws = await stores();
  const token = freshToken();
  const a = noteOf(0);
  const tx = buyTx(a.w, token);
  const x = world({ notes: [a.n], events: [row("buy", a.nullifier, a.w, tx.hash, token, 3n)], txs: [tx], decimals: [18n, 6n], ws });
  x.round.fail = true;
  await assert.rejects(rebuildEvmHoldings(x.host), /differ/);
  assert.deepEqual(x.helperAsked, [], "nothing asked of a round refused");
  x.round.fail = false;
  // decimals apart: nothing written, asked again on the next pass
  assert.deepEqual(await rebuildEvmHoldings(x.host), []);
  assert.equal(await ws.get("meta", EVM_POSITION_COSTS_KEY), undefined);
  // the round's Bought names another W for the note, or another note's nullifier
  const other = noteOf(9);
  for (const e of [row("buy", a.nullifier, other.w, tx.hash, token, 3n), row("buy", other.nullifier, a.w, tx.hash, token, 3n)]) {
    const y = world({ notes: [a.n], events: [e], txs: [tx], ws });
    assert.deepEqual(await rebuildEvmHoldings(y.host), []);
    assert.deepEqual(y.helperAsked, []);
  }
  assert.equal(await ws.get("meta", EVM_POSITION_COSTS_KEY), undefined);
});

test("a helper that answers another transaction for the hash, a Buy of another token, or a call to another contract: nothing written", async () => {
  const ws = await stores();
  const token = freshToken();
  const a = noteOf(0);
  const tx = buyTx(a.w, token);
  const x = world({ notes: [a.n], events: [row("buy", a.nullifier, a.w, tx.hash, token, 3n)], txs: [tx], ws });
  const forged = [
    // another route for the token, the agreed hash pasted on: its fields hash to another
    { ...buyTx(a.w, token, 1), hash: tx.hash },
    // the agreed transaction with its input swapped for a Buy of another token
    { ...tx, input: buyTx(a.w, freshToken()).input },
    // a call to another contract
    { ...tx, to: "0x" + "e1".repeat(20) },
  ];
  for (const f of forged) {
    x.helper.mode = "forge";
    x.helper.forged = f;
    assert.deepEqual(await rebuildEvmHoldings(x.host), []);
    assert.equal(await ws.get("meta", EVM_POSITION_COSTS_KEY), undefined);
  }
  // the helper's transaction is right, but its hash is not the round's: a Bought row with another hash
  const y = world({ notes: [a.n], events: [row("buy", a.nullifier, a.w, "0x" + "99".repeat(32), token, 3n)], txs: [{ ...tx, hash: "0x" + "99".repeat(32) }], ws });
  assert.deepEqual(await rebuildEvmHoldings(y.host), []);
  assert.equal(await ws.get("meta", EVM_POSITION_COSTS_KEY), undefined);
});

test("a helper that withholds (null) or fails (5xx): nothing written, no crash, asked again on the next pass, which writes once it answers", async () => {
  const ws = await stores();
  const token = freshToken();
  const a = noteOf(0);
  const tx = buyTx(a.w, token);
  const x = world({ notes: [a.n], events: [row("buy", a.nullifier, a.w, tx.hash, token, 3n)], txs: [tx], ws });
  for (const mode of ["withhold", "fail"] as const) {
    x.helper.mode = mode;
    const asked = x.helperAsked.length;
    assert.deepEqual(await rebuildEvmHoldings(x.host), [], mode);
    assert.equal(x.helperAsked.length, asked + 1, `${mode}: asked`);
    assert.equal(await ws.get("meta", EVM_POSITION_COSTS_KEY), undefined, `${mode}: no record`);
    assert.deepEqual(await positionsOf(ws, new Map()), [], `${mode}: no ghost row`);
  }
  x.helper.mode = "ok";
  assert.deepEqual(await rebuildEvmHoldings(x.host), [a.w]);
});

test("the pass sends the pool's public RPCs only the token's decimals: no read names W, the buy's transaction or its block", async () => {
  const ws = await stores();
  const token = freshToken();
  const a = noteOf(0);
  const tx = buyTx(a.w, token);
  const x = world({ notes: [a.n], events: [row("buy", a.nullifier, a.w, tx.hash, token, 3n)], txs: [tx], ws });
  assert.deepEqual(await rebuildEvmHoldings(x.host), [a.w]);
  const decimals = `eth_call ${JSON.stringify([{ to: token, data: DECIMALS }, "latest"])}`;
  assert.deepEqual(x.publicAsked, [[decimals], [decimals]], "one decimals() on each RPC, nothing else");
  assert.deepEqual(x.helperAsked, [`eth_getTransactionByHash ${JSON.stringify([tx.hash])}`], "the buy's transaction on the helper alone");
});

// The page's own wiring (src/pool-testnet.ts evmHoldings, at each state read): SIGN_HOST's build, a device restored
// from the words (a spent Base note, no buy record), the round from the pool sync, the helper's route through fetch
// (pageEvmWalletRpc: TRADE_HELPER/v1/rpc/base). The record is written, the position shows on the helper's balance,
// and no public provider is asked for the buy (no log filtered to it, no block at its height, no transaction by hash).
test("SIGN_HOST's page: a state read on a restored device rebuilds W's record through the helper's route, the position shows, and no public read names the buy", async () => {
  const ws = await stores();
  await ws.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
  const ns = await openNoteStore(ws);
  const a = noteOf(0);
  const added = await ns.add({ ref: a.n.ref, scope: SCOPE, precommitment: a.n.precommitment, state: "UNSPENT", leaf: a.n.leaf! });
  await ns.move(added.id, "UNSPENT", "SPENT");
  ns.close();
  const token = freshToken();
  const tx = buyTx(a.w, token);
  const events = [row("buy", a.nullifier, a.w, tx.hash, token, 3n)];
  const publicAsked: string[] = [];
  const pub = (url: string): EvmRpc => Object.assign(async (method: string, params: readonly unknown[]) => {
    publicAsked.push(`${method} ${JSON.stringify(params)}`.toLowerCase());
    const c = params[0] as { to?: string; data?: string } | undefined;
    if (method === "eth_blockNumber") return q(BUY_BLOCK + 10n);
    if (method === "eth_getBlockByNumber") return { number: q(BUY_BLOCK + 10n), hash: "0x" + "4b".repeat(32), timestamp: "0x1", baseFeePerGas: "0xf4240" };
    if (method === "eth_call" && c?.data === DECIMALS) return word(18n);
    if (method === "eth_getTransactionCount" || method === "eth_getBalance") return "0x0";
    throw new Error(`unmocked ${method}`);
  }, { url });
  const pair = [pub("https://a.example"), pub("https://b.example")] as const;
  const helperAsked: string[] = [];
  let helperDown = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`${TRADE_HELPER}/v1/rpc/base`)) throw new Error(`no fetch of ${url}`);
    if (helperDown) return new Response("{}", { status: 503 });
    const body = JSON.parse(String(init?.body)) as { id: unknown; method: string; params: unknown[] } | { id: unknown; method: string; params: unknown[] }[];
    const one = (r: { id: unknown; method: string; params: unknown[] }) => {
      helperAsked.push(r.method);
      const c = r.params[0] as { to?: string; data?: string } | undefined;
      const result =
        r.method === "eth_getTransactionByHash" ? (r.params[0] === tx.hash ? tx : null)
        : r.method === "eth_getBlockByNumber" ? { number: q(BUY_BLOCK + 10n), hash: "0x" + "4b".repeat(32) }
        : r.method === "eth_call" && c?.data?.startsWith(BALANCE_OF) && c.data.endsWith(a.w.slice(2)) && String(c.to).toLowerCase() === token ? word(4n * 10n ** 18n)
        : r.method === "eth_call" ? word(0n)
        : null;
      return { jsonrpc: "2.0", id: r.id, result };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const timers: (() => void)[] = [];
    const t = testnetPool({ store: async () => ws, held: async () => ws, seed64: async () => SEED.slice() }, {
      evmRpcs: (chain) => (chain === "base" ? pair : null),
      evmSync: () => ({ events: async () => ({ events, fin: { number: BUY_BLOCK } }) as never }),
      positions: { setTimer: (f: () => void) => (timers.push(f), f), clearTimer: () => {} },
    });
    // the helper down: nothing written, no crash
    await t.stateRead();
    await new Promise((ok) => setTimeout(ok, 100));
    assert.equal((await recordsOf(ws))[a.w], undefined, "the helper down: no record");
    // the helper back: the next state read writes it, and the positions show W's amount
    helperDown = false;
    let rows: string[] = [];
    for (let i = 0; i < 200 && rows.length === 0; i++) {
      if (i % 20 === 0) await t.stateRead();
      for (const f of timers.splice(0)) f();
      await new Promise((ok) => setTimeout(ok, 25));
      rows = ((await t.positions()) ?? []).filter((p) => p.chain === "base").map((p) => `${p.token.toLowerCase()} ${p.amount}`);
    }
    assert.equal(((await recordsOf(ws))[a.w] as { route?: { tx?: string } } | undefined)?.route?.tx, tx.hash, "the record rebuilt");
    assert.deepEqual(rows, [`${token} 4`], "the position shows");
    assert.ok(helperAsked.includes("eth_getTransactionByHash"), "the buy's transaction read on the helper");
    const named = publicAsked.filter((l) => l.includes(a.w.slice(2)) || l.includes(tx.hash.slice(2)) || l.includes(q(BUY_BLOCK)) || l.startsWith("eth_gettransactionbyhash") || l.startsWith("eth_getlogs"));
    assert.deepEqual(named, [], "no public read names W, the buy's transaction or its block");
    await t.signedOut();
  } finally {
    globalThis.fetch = realFetch;
  }
});
