// state.positions on SIGN_HOST's top-level page (card signpage-state-holdings): the tokens the pool's buy wallets hold,
// each amount read on both RPCs, one pass at a time, run at the first signed-in state read and again when a pool buy or
// sell ends; red before this card, where every signed-in state sent positions: [] (src/state.ts stateOf).
//   node --test test/positions.test.ts
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import type { SignpageState } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { solanaAta } from "../../kit/src/checks/solana/message.ts";
import { SIGNPAGE_RESULT_SCHEMAS as V1_8_SCHEMAS } from "./fixtures/kit-v1.8/signpage/schema.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import type { HoldingsReader } from "../../wallet/src/pool/buy-wallets.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { POSITION_COSTS_KEY, positionCost, positionsCache, positionsPass, recordPoolBuy, usdOf, withPositions, type Position, type PositionsReads } from "../src/positions.ts";
import { stateFor } from "../src/kit-version.ts";
import { testnetPool } from "../src/pool-testnet.ts";

const MINT = base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 7 : 0))); // a 32-byte key, as a mint is (low entropy: gitleaks reads a recorded "token" as a key otherwise)
const MINT2 = "Mint2222222222222222222222222222222222222222";
const W1 = "W1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const W2 = "W2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SIGNED_IN: SignpageState = { release: "sp-1", api: 1, signed_in: true, code_saved: true, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Reads over a fixed chain: `found` what the finder names, `chain` each (W, mint)'s amount both RPCs agree on. */
const reads = (found: Record<string, string[]>, chain: Record<string, bigint>, decimals: Record<string, number> = { [MINT]: 6, [MINT2]: 9 }): PositionsReads & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    wallets: async () => Object.entries(found).map(([address, tokens]) => ({ address, tokens })),
    held: async (w, m) => {
      asked.push(`${w}/${m}`);
      const v = chain[`${w}/${m}`];
      if (v === undefined) throw new Error("the two RPCs read it apart");
      return v;
    },
    decimals: async (m) => decimals[m]!,
  };
};

test("a pass: one position per token, its amount the sum over its Ws at the token's decimals, cost unknown; a token at 0 is not held", async () => {
  const got = await positionsPass(reads({ [W1]: [MINT, MINT2], [W2]: [MINT] }, { [`${W1}/${MINT}`]: 1_500_000n, [`${W1}/${MINT2}`]: 0n, [`${W2}/${MINT}`]: 2_250_001n }));
  assert.deepEqual(got, [{ chain: "solana", token: MINT, amount: "3.750001", cost: "0", wallets: [W1, W2], decimals: 6 }]);
  assert.deepEqual(await positionsPass(reads({}, {})), [], "no buy wallets: no positions");
});

test("a pass fails whole when one amount is not the same on both RPCs, or the finder cannot list: never part of a pass", async () => {
  await assert.rejects(positionsPass(reads({ [W1]: [MINT], [W2]: [MINT] }, { [`${W1}/${MINT}`]: 5n })));
  await assert.rejects(positionsPass({ ...reads({}, {}), wallets: async () => Promise.reject(new Error("the buy wallets' holdings could not be read")) }));
});

test("the cache: one pass at a time, a refresh while one runs runs once more after it; a failed pass keeps the last and is tried again", async () => {
  const timers: (() => void)[] = [];
  let answer: Position[] | Error = [];
  let calls = 0;
  let gate: (() => void) | null = null;
  const c = positionsCache(
    async () => {
      calls++;
      if (gate === null) await new Promise<void>((r) => (gate = r));
      if (answer instanceof Error) throw answer;
      return answer;
    },
    { retries: 2, setTimer: (f) => timers.push(f), clearTimer: () => {} },
  );
  let told = 0;
  c.watch(() => told++);
  assert.equal(c.get(), null, "before the first pass: none (the state keeps its [])");
  c.first();
  c.first();
  c.refresh();
  await tick();
  assert.equal(calls, 1, "one pass at a time");
  const P: Position = { chain: "solana", token: MINT, amount: "1", cost: "0", wallets: [W1], decimals: 0 };
  answer = [P];
  (gate as unknown as () => void)();
  await c.idle();
  assert.equal(calls, 2, "the refresh asked meanwhile ran once more after it");
  assert.deepEqual(c.get(), [P]);
  assert.equal(told, 1, "told once: the second pass changed nothing");
  answer = new Error("one RPC behind");
  c.refresh();
  await c.idle();
  assert.deepEqual(c.get(), [P], "a failed pass keeps the last whole one");
  assert.equal(timers.length, 1, "and is tried again later");
  answer = [];
  timers.shift()!();
  await c.idle();
  assert.deepEqual(c.get(), [], "a full sell: the position is gone");
  assert.equal(told, 2);
  c.clear();
  assert.equal(c.get(), null, "sign out drops them");
});

test("the cache: retries stop after their count; a pass running at sign out is dropped", async () => {
  const timers: (() => void)[] = [];
  let calls = 0;
  const c = positionsCache(async () => (calls++, Promise.reject(new Error("down"))), { retries: 2, setTimer: (f) => timers.push(f), clearTimer: () => {} });
  c.refresh();
  for (let i = 0; i < 5; i++) {
    await c.idle();
    timers.shift()?.();
  }
  await c.idle();
  assert.equal(calls, 3, "the first pass and two tries");
  let release!: () => void;
  const d = positionsCache(() => new Promise<Position[]>((r) => (release = () => r([{ chain: "solana", token: MINT, amount: "1", cost: "0", wallets: [W1] }]))));
  d.refresh();
  d.clear();
  release();
  await d.idle();
  assert.equal(d.get(), null, "the answer of a pass from before the sign out is never kept");
});

test("withPositions: signed in with a pass, the state carries them, valid at kit 1.9 and at kit 1.8 (decimals kept), kit 1.7 without decimals", () => {
  const P: Position[] = [{ chain: "solana", token: MINT, amount: "3.750001", cost: "0", wallets: [W1, W2], decimals: 6 }];
  const s = withPositions(SIGNED_IN, P);
  assert.deepEqual(s.positions, P);
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(s), true, "kit 1.9");
  const v18 = stateFor("1.8", s);
  assert.deepEqual(v18.positions, P, "kit 1.8 reads a position's decimals (card signpage-state-holdings shipped them at 1.8)");
  assert.equal(V1_8_SCHEMAS.state(v18), true, "kit-v1.8's own schema");
  assert.deepEqual(stateFor("1.7", s).positions, [{ chain: "solana", token: MINT, amount: "3.750001", cost: "0", wallets: [W1, W2] }]);
  assert.equal(withPositions(SIGNED_IN, null), SIGNED_IN, "no pass yet: the state as it is");
  const out = { ...SIGNED_IN, signed_in: false } as unknown as SignpageState;
  assert.equal(withPositions(out, P), out, "signed out: never");
  // a position the kit's schema refuses (an amount past its decimals) never goes: the state as it was
  assert.equal(withPositions(SIGNED_IN, [{ ...P[0]!, amount: "1.1234567" }]), SIGNED_IN);
});

// ---------------------------------------------------- the page's wiring (src/pool-testnet.ts), on a fake chain
const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const PIN = { program: "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8", feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" }; // the devnet pool (wallet/src/pool/solana.ts SOL_POOLS)
const SCOPE = solanaPoolOf(PIN.program).scope;
const LIVE_STATE = new URL("../../../apps/terminal/test/sell-positions/live-state.json", import.meta.url);
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));

/** A wallet store with one SPENT note of the pool: one buy wallet W. */
async function spentWallet(): Promise<WalletStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  const ref = { kind: "deposit" as const, s: SCOPE, i: 0 };
  const precommitment = noteSecrets(SEED64, ref).precommitment;
  const label = 77n;
  const r = await ns.add({ ref, scope: SCOPE, precommitment, state: "UNSPENT", leaf: { value: 10_000_000n, label, commitment: noteCommitment(10_000_000n, label, precommitment), leafIndex: 0n } });
  await ns.move(r.id, "UNSPENT", "SPENT");
  ns.close();
  return w;
}

/** A fake chain both RPCs read: the mint (6 decimals) and each W's associated token account of it, `amounts[k]` per RPC. */
function chain() {
  const mintData = new Uint8Array(82);
  mintData[44] = 6;
  mintData[45] = 1;
  const amounts: [bigint, bigint] = [0n, 0n];
  const owners = new Map<string, string>(); // ATA -> W
  const rpc = (k: 0 | 1) => async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getAccountInfo");
    const address = params[0] as string;
    if (address === MINT) return { context: { slot: 10 }, value: { owner: SOLANA_TOKEN_PROGRAM, lamports: 1, data: [base64.encode(mintData), "base64"] } };
    const w = owners.get(address);
    if (w === undefined || amounts[k] === 0n) return { context: { slot: 10 }, value: null };
    const d = new Uint8Array(165);
    d.set(base58.decode(MINT), 0);
    d.set(base58.decode(w), 32);
    new DataView(d.buffer).setBigUint64(64, amounts[k], true);
    d[108] = 1;
    return { context: { slot: 10 }, value: { owner: SOLANA_TOKEN_PROGRAM, lamports: 1, data: [base64.encode(d), "base64"] } };
  };
  const finder: HoldingsReader = {
    chain: "sol",
    read: async (address) => {
      owners.set(solanaAta(address, MINT, SOLANA_TOKEN_PROGRAM), address);
      return { native: 0n, tokens: new Map(amounts[0] > 0n ? [[MINT, { amount: amounts[0], frozen: false }]] : []), unreadable: [] };
    },
  };
  return { amounts, rpcs: [rpc(0), rpc(1)] as const, finder, owners };
}

test("the page: the first signed-in read starts a pass, a sell's end reads again, a full sell's position is gone, sign out drops them", async () => {
  const w = await spentWallet();
  const c = chain();
  c.amounts[0] = c.amounts[1] = 1_081_590_213_565n;
  const timers: (() => void)[] = [];
  let ended!: () => void;
  const ran: string[] = [];
  const sell = () => (ask: unknown, ctx: { id: string }) => {
    ran.push(ctx.id);
    return { running: true as const, after: new Promise<void>((r) => (ended = r)), answer: () => ({ result: { stage: "filled", txs: [] } }) };
  };
  const tp = testnetPool(
    { store: async () => w, seed64: async () => SEED64.slice() },
    // @ts-expect-error a stand-in sell kind: only its run's end matters here
    { pin: PIN, rpcs: c.rpcs, holdings: () => c.finder, tradeKinds: { sell }, positions: { setTimer: (f: () => void) => timers.push(f), clearTimer: () => {} } },
  );
  let told = 0;
  tp.watch(() => told++);
  assert.equal(tp.positions(), null, "no pass yet: the state keeps its []");
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(f());
  };
  await until(() => tp.positions() !== null);
  const [p] = tp.positions()!;
  assert.deepEqual({ ...p, wallets: p!.wallets.length }, { chain: "solana", token: MINT, amount: "1081590.213565", cost: "0", wallets: 1, decimals: 6 });
  assert.equal(p!.wallets[0], [...c.owners.values()][0], "W, the spent note's buy wallet");
  assert.ok(told >= 1, "the page's state is read again when the positions change");
  // what SIGN_HOST then sends the app: the terminal's sell test reads this very state (apps/terminal/test/sell-live.test.ts)
  const sent = withPositions(SIGNED_IN, tp.positions());
  if (process.env.RECORD_LIVE_STATE === "1") writeFileSync(LIVE_STATE, `${JSON.stringify(sent, null, 2)}\n`);
  assert.deepEqual(sent, JSON.parse(readFileSync(LIVE_STATE, "utf8")), "the terminal's recorded state is the page's own");
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(sent), true);
  assert.equal(V1_8_SCHEMAS.state(stateFor("1.8", sent)), true);
  // a full sell: its run ends, both RPCs read 0, the position is gone with no reload
  c.amounts[0] = c.amounts[1] = 0n;
  const r = tp.flow({ kind: "pool.sell", chain: "solana", token: MINT, amount: 1n, slippageBps: 100, decimals: 6 }, { id: "s1", sha: "00", progress: () => {} } as never);
  assert.ok("running" in r);
  assert.deepEqual(ran, ["s1"]);
  assert.equal(tp.positions()!.length, 1, "nothing read again before the run ends");
  ended();
  await until(() => tp.positions()!.length === 0);
  // one RPC reads tokens the other does not: not shown, the last whole pass stays, tried again
  c.amounts[0] = 5n;
  const s2 = tp.flow({ kind: "pool.sell", chain: "solana", token: MINT, amount: 1n, slippageBps: 100, decimals: 6 }, { id: "s2", sha: "00", progress: () => {} } as never);
  assert.ok("running" in s2);
  ended();
  await until(() => timers.length > 0);
  assert.deepEqual(tp.positions(), [], "a balance one RPC alone reports is not shown");
  c.amounts[1] = 5n;
  timers.shift()!();
  await until(() => tp.positions()!.length === 1);
  assert.equal(tp.positions()![0]!.amount, "0.000005");
  await tp.signedOut();
  assert.equal(tp.positions(), null, "sign out drops them");
});

// ---------------------------------------------------- cost, and the pool buy's records
const PRICE = { price: "15000000000", expo: -8, published_s: 1, read_ms: 1 }; // 150 USD a SOL, the page's own read

test("a pool buy's USD: its spend at the page's own price, exact; no price that reads, none", () => {
  assert.equal(usdOf(10_000_000n, 9, PRICE), "1.5");
  assert.equal(usdOf(12_345_678n, 9, { ...PRICE, price: "14999999999" }), "1.85185169987654322");
  assert.equal(usdOf(1n, 9, { ...PRICE, price: "0" }), null);
  assert.equal(usdOf(1n, 9, { ...PRICE, expo: 2 }), null);
});

test("a position's cost: each W's spend times what it holds over what it received (a sell takes it off pro rata); any W with no record of the mint: unknown", () => {
  const costs = { [W1]: { mint: MINT, cost_usd: "1.5", received: "1000" }, [W2]: { mint: MINT, cost_usd: "3", received: "10" } };
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 1_000_000_000n }], costs), "1.5", "all of it held");
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 250_000_000n }], costs), "0.375", "a quarter held after a sell");
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 500_000_000n }, { address: W2, amount: 10_000_000n }], costs), "3.75");
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 2_000_000_000n }], costs), "1.5", "never more than it spent");
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 1n }, { address: "Wnone", amount: 1n }], costs), "0", "a W with no record");
  assert.equal(positionCost(MINT2, 6, [{ address: W1, amount: 1n }], costs), "0", "a record of another mint");
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 1n }], { [W1]: { mint: MINT, cost_usd: "x", received: "1" } }), "0");
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 1n }], { [W1]: { mint: MINT, cost_usd: "1", received: "0" } }), "0");
  const third = positionCost(MINT, 6, [{ address: W1, amount: 1n }], { [W1]: { mint: MINT, cost_usd: "1", received: "0.000003" } });
  assert.equal(third, "0.333333333333", "cut at 12 decimals");
  const p: Position = { chain: "solana", token: MINT, amount: "0.000001", cost: third, wallets: [W1], decimals: 6 };
  assert.deepEqual(withPositions(SIGNED_IN, [p]).positions, [p], "a cost at 12 decimals fits the kit's schema");
});

/** A wallet store's ops and meta, in memory. */
const memStore = () => {
  const ops = new Map<string, unknown>();
  const meta = new Map<string, unknown>();
  return {
    ops,
    meta,
    get: async (_s: "ops", k: string) => ops.get(k),
    put: async (_s: "ops", k: string, v: unknown) => void ops.set(k, v),
    update: async (_s: "meta", k: string, f: (v: unknown) => unknown) => void meta.set(k, f(meta.get(k))),
  };
};
const FACTS = { token: MINT, spend: 10_000_000n, spendDecimals: 9, price: PRICE, createdMs: 1_800_000_000_000, wallet: W1, out: "1081590.213565" };

test("a pool buy's records: filled, its ops record (time, chain, token, USD) and W's cost; refused or not landed, its ops record and no cost; sent, id_reused or seen before, nothing", async () => {
  const { opOf } = await import("../src/state.ts");
  const s = memStore();
  await recordPoolBuy(s, "b1", FACTS, { result: { stage: "filled", txs: [{ chain: "solana", hash: "Sig1" }] } });
  assert.deepEqual(opOf("b1", s.ops.get("b1")), { id: "b1", kind: "buy", stage: "filled", txs: [{ chain: "solana", hash: "Sig1" }], created_ms: 1_800_000_000_000, chain: "solana", token: MINT, amount_usd: "1.5" });
  assert.deepEqual(s.meta.get(POSITION_COSTS_KEY), { [W1]: { mint: MINT, cost_usd: "1.5", received: "1081590.213565" } });
  await recordPoolBuy(s, "b2", { ...FACTS, wallet: W2 }, { error: "quote_check_failed" });
  assert.deepEqual(opOf("b2", s.ops.get("b2")), { id: "b2", kind: "buy", stage: "refused", txs: [], code: "quote_check_failed", created_ms: 1_800_000_000_000, chain: "solana", token: MINT, amount_usd: "1.5" });
  await recordPoolBuy(s, "b3", { ...FACTS, wallet: W2 }, { result: { stage: "not_landed", txs: [] } });
  assert.equal((s.ops.get("b3") as { stage: string }).stage, "not_landed");
  assert.deepEqual(Object.keys(s.meta.get(POSITION_COSTS_KEY) as object), [W1], "no cost for a buy that did not fill");
  await recordPoolBuy(s, "b4", FACTS, { result: { stage: "sent", txs: [{ chain: "solana", hash: "Sig4" }] } });
  await recordPoolBuy(s, "b5", FACTS, { error: "id_reused" });
  await recordPoolBuy(s, "b6", FACTS, null);
  assert.deepEqual([...s.ops.keys()], ["b1", "b2", "b3"], "no record for an answer with no end, another tab's run or none");
  await recordPoolBuy(s, "b1", FACTS, { error: "failed" });
  assert.equal((s.ops.get("b1") as { stage: string }).stage, "filled", "a record already there is never written over");
  const n = memStore();
  await recordPoolBuy(n, "b7", { ...FACTS, price: null }, { result: { stage: "filled", txs: [] } });
  assert.equal((n.ops.get("b7") as { amount_usd?: string }).amount_usd, undefined, "no price read: no USD");
  assert.equal(n.meta.get(POSITION_COSTS_KEY), undefined, "and no cost: the position's cost stays unknown");
});

test("the page: a pool buy's end writes its records and reads the positions again, with its cost", async () => {
  const w = await spentWallet();
  const c = chain();
  let ended!: () => void;
  const buy = () => (ask: { amount: bigint }, ctx: { route?: (r: unknown) => void }) => {
    assert.equal(ask.amount, 10_000_000n);
    // the run tells W once it is bound and the amount W received once both RPCs read it (pool-buy.ts's route facts)
    ctx.route?.({ wallet: [...c.owners.values()][0]! });
    ctx.route?.({ out: "1081590.213565" });
    return { running: true as const, after: new Promise<void>((r) => (ended = r)), answer: () => ({ result: { stage: "filled", txs: [{ chain: "solana", hash: "SigB" }] } }) };
  };
  const routed: unknown[] = [];
  const tp = testnetPool(
    { store: async () => w, seed64: async () => SEED64.slice(), price: () => PRICE },
    // @ts-expect-error a stand-in buy kind: only its route facts, answer and end matter here
    { pin: PIN, rpcs: c.rpcs, table: "Table111111111111111111111111111111111111111", holdings: () => c.finder, tradeKinds: { buy }, positions: { setTimer: () => {}, clearTimer: () => {} } },
  );
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(f());
  };
  assert.equal(tp.positions(), null);
  await until(() => tp.positions() !== null);
  assert.deepEqual(tp.positions(), [], "nothing bought yet");
  const r = tp.flow({ kind: "pool.buy", chain: "solana", token: MINT, amount: 10_000_000n, slippageBps: 100, decimals: 9 }, { id: "pb1", sha: "00", progress: () => {}, route: (x: unknown) => routed.push(x) } as never);
  assert.ok("running" in r);
  c.amounts[0] = c.amounts[1] = 1_081_590_213_565n;
  ended();
  await until(() => (tp.positions() ?? []).length === 1);
  assert.equal(tp.positions()![0]!.cost, "1.5", "the buy's spend at the page's price, all of it held");
  assert.deepEqual(routed, [{ wallet: [...c.owners.values()][0] }, { out: "1081590.213565" }], "the run's route facts still reach the app");
  const op = (await w.get("ops", "pb1")) as { stage: string; amount_usd: string; token: string };
  assert.deepEqual([op.stage, op.amount_usd, op.token], ["filled", "1.5", MINT], "the pool buy shows in state.ops (review P3-1)");
});

test("the page: a pool buy answered early as sent (its fill read later) is recorded at the end stage its run posts, once", async () => {
  const w = await spentWallet();
  const c = chain();
  let answered!: () => void;
  let progress!: (s: string) => void;
  const buy = () => (_ask: unknown, ctx: { route?: (r: unknown) => void; progress: (s: string) => void }) => {
    progress = ctx.progress;
    ctx.route?.({ wallet: [...c.owners.values()][0]! });
    ctx.route?.({ out: "5" });
    return { running: true as const, after: new Promise<void>((r) => (answered = r)), answer: () => ({ result: { stage: "sent", txs: [{ chain: "solana", hash: "SigS" }] } }) };
  };
  const posted: string[] = [];
  const tp = testnetPool(
    { store: async () => w, seed64: async () => SEED64.slice(), price: () => PRICE },
    // @ts-expect-error a stand-in buy kind
    { pin: PIN, rpcs: c.rpcs, table: "Table111111111111111111111111111111111111111", holdings: () => c.finder, tradeKinds: { buy }, positions: { setTimer: () => {}, clearTimer: () => {} } },
  );
  tp.positions();
  for (let i = 0; i < 200 && tp.positions() === null; i++) await new Promise((r) => setTimeout(r, 5));
  tp.flow({ kind: "pool.buy", chain: "solana", token: MINT, amount: 10_000_000n, slippageBps: 100, decimals: 9 }, { id: "pb2", sha: "00", progress: (s: string) => posted.push(s) } as never);
  answered();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await w.get("ops", "pb2"), undefined, "sent is no end: nothing written yet");
  progress("filled");
  progress("filled");
  for (let i = 0; i < 200 && (await w.get("ops", "pb2")) === undefined; i++) await new Promise((r) => setTimeout(r, 5));
  const op = (await w.get("ops", "pb2")) as { stage: string; txs: unknown[] };
  assert.deepEqual([op.stage, op.txs], ["filled", [{ chain: "solana", hash: "SigS" }]]);
  assert.deepEqual(posted, ["filled", "filled"], "the app still gets every progress the run posts");
  assert.deepEqual(await w.get("meta", POSITION_COSTS_KEY), { [[...c.owners.values()][0]!]: { mint: MINT, cost_usd: "1.5", received: "5" } });
});
