// node --test packages/wallet/test/buy-wallets.test.ts (card wallet-per-buy; plan v2 W3): from the 12 words alone a
// restore finds every Solana and EVM wallet a buy used, and what each one still holds, each W's reads at one state.
// The chains are fakes; the seed is the all-zero entropy of vectors/a8.json, whose W addresses the restore must give.
// Every request is logged, so a test checks no request names two of the user's wallets.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { onTestClock } from "../../kit/test/test-clock.ts";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { HDKey } from "@scure/bip32";
import { base58, base64 } from "@scure/base";
import { SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaHelperRpc, solanaJsonRpc, solanaPacedRpc, type SolanaRpc } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, refKey, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";
import { SOL_LAG_SLOTS, SOL_LAG_WAIT_MS } from "../src/pool/solana.ts";
import { hostLane, PASS_BUDGET, ThrottleGate } from "../src/throttle.ts";
import { type ReaderOpts, buyWallets, derivedBuyWallets, wantedBuyWallets, EVM_HOLDINGS_ROUNDS, evmHelperHoldings, HOLDINGS_RPC_LIMIT, HOLDINGS_THROTTLE_MAX_MS, evmHoldingsReader, RETRY_AFTER_DEFAULT_MS, RETRY_AFTER_MAX_MS, retryAfterMs, SOL_HOLDINGS_ROUNDS, solanaHelperHoldings, solanaHoldingsReader, solanaSpentNotes, spentNotesOf, type BuyPool, type HoldingsReader, type JsonRpc } from "../src/pool/buy-wallets.ts";

const A8 = JSON.parse(readFileSync(new URL("./vectors/a8.json", import.meta.url), "utf8")) as { inputs: { entropy: string }; l: string; wallets: { name: string; c: string; l: string; j: number; path: string; address: string }[] };
const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(Buffer.from(A8.inputs.entropy, "hex"))));
const L = BigInt(`0x${A8.l}`);
const L2 = 77n; // another label: an EVM note of its own
const vec = (c: string, j: number): string => A8.wallets.find((w) => w.c === c && w.j === j && w.l === A8.l)!.address;
const SOL_SCOPE = 1001n, EVM_SCOPE = 2002n, OTHER_SCOPE = 3003n;
const key32 = (k: number): string => base58.encode(new Uint8Array(32).fill(k));
const MINT_A = key32(7), MINT_B = key32(8);
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", TOKEN_X = "0x00000000000000000000000000000000000000aa", TOKEN_R = "0x00000000000000000000000000000000000000bb";
const solW = (j: number) => vec("sol", j);
const evmW = (l: bigint, j: number) => { const w = d.freshWallet(SEED, "evm", l, j); w.secretKey.fill(0); return w.address; };
const DEP: NoteRef = { kind: "deposit", s: SOL_SCOPE, i: 0 };

// ---------- a fake Solana provider: its state by slot, answering at its slot, refusing a minContextSlot past it ----------
type SolAcct = { pubkey: string; program: string; mint: string; owner: string; amount: bigint; state?: number; len?: number; type?: number };
type SolState = { lamports: Map<string, unknown>; accounts: SolAcct[] };
type SolChain = { slot: number; at: (slot: number) => SolState; onCall?: (method: string, c: SolChain) => void };
function tokenData(a: SolAcct): string {
  const b = new Uint8Array(a.len ?? 165);
  b.set(base58.decode(a.mint), 0);
  b.set(base58.decode(a.owner), 32);
  new DataView(b.buffer).setBigUint64(64, a.amount, true);
  b[108] = a.state ?? 1;
  if (a.type !== undefined) b[165] = a.type;
  return base64.encode(b);
}
type Edit = (method: string, out: unknown, params: readonly unknown[]) => unknown;
const log: string[][] = [];
function solRpc(c: SolChain, edit: Edit = (_m, o) => o): SolanaRpc {
  return async (method: string, params: readonly unknown[]): Promise<unknown> => {
    log.push([method, JSON.stringify(params)]);
    const owner = params[0] as string;
    const cfg = params[params.length - 1] as { commitment?: string; minContextSlot?: number };
    assert.equal(cfg.commitment, "finalized");
    if (cfg.minContextSlot !== undefined && c.slot < cfg.minContextSlot) throw new Error("RPC error -32016: Minimum context slot has not been reached");
    const slot = c.slot, s = c.at(slot);
    c.onCall?.(method, c);
    if (method === "getBalance") return edit(method, { context: { slot }, value: s.lamports.get(owner) ?? 0 }, params);
    if (method === "getTokenAccountsByOwner") {
      const program = (params[1] as { programId: string }).programId;
      const value = s.accounts.filter((a) => a.owner === owner && a.program === program).map((a) => ({ pubkey: a.pubkey, account: { owner: a.program, lamports: 2_039_280, executable: false, data: [tokenData(a), "base64"] } }));
      return edit(method, { context: { slot }, value }, params);
    }
    throw new Error(`fake solana: ${method}`);
  };
}
const solState = (): SolState => ({
  lamports: new Map([[solW(0), 5_000_000], [solW(1), 0]]),
  accounts: [
    { pubkey: key32(20), program: SOLANA_TOKEN_PROGRAM, mint: MINT_A, owner: solW(0), amount: 100n },
    { pubkey: key32(21), program: SOLANA_TOKEN_PROGRAM, mint: MINT_A, owner: solW(0), amount: 23n },
    { pubkey: key32(22), program: SOLANA_TOKEN_2022_PROGRAM, mint: MINT_B, owner: solW(0), amount: 7n, len: 182, type: 2 },
    { pubkey: key32(23), program: SOLANA_TOKEN_PROGRAM, mint: MINT_A, owner: key32(99), amount: 1n }, // someone else's
  ],
});
const solChain = (s: SolState = solState()): SolChain => ({ slot: 500, at: () => s });

// ---------- a fake EVM provider: blocks by hash, "latest" the newest ----------
type EvmState = { wei: Map<string, bigint>; tokens: Map<string, Map<string, bigint>>; reverts?: Set<string>; noCode?: Set<string> };
type EvmChain = { blocks: EvmState[]; onLatest?: (c: EvmChain) => void };
const hashOf = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
function evmRpc(c: EvmChain, edit: Edit = (_m, o) => o): JsonRpc {
  return async (method: string, params: readonly unknown[]): Promise<unknown> => {
    log.push([method, JSON.stringify(params)]);
    if (method === "eth_getBlockByNumber") {
      assert.deepEqual(params, ["latest", false]);
      const n = c.blocks.length - 1;
      c.onLatest?.(c);
      return edit(method, { hash: hashOf(n), number: `0x${n.toString(16)}` }, params);
    }
    const at = params[params.length - 1] as { blockHash?: string };
    const n = c.blocks.findIndex((_b, i) => hashOf(i) === at.blockHash);
    if (n < 0) throw new Error("RPC error -32000: header not found");
    const s = c.blocks[n]!;
    if (method === "eth_getBalance") return edit(method, `0x${(s.wei.get(params[0] as string) ?? 0n).toString(16)}`, params);
    if (method === "eth_call") {
      const { to, data } = params[0] as { to: string; data: string };
      assert.equal(data.slice(0, 10), "0x70a08231");
      if (s.reverts?.has(to)) throw new Error("RPC error 3: execution reverted: some provider text 0xdeadbeef");
      if (s.noCode?.has(to)) return edit(method, "0x", params);
      return edit(method, `0x${(s.tokens.get(to)?.get(`0x${data.slice(-40)}`) ?? 0n).toString(16).padStart(64, "0")}`, params);
    }
    throw new Error(`fake evm: ${method}`);
  };
}
const evmState = (): EvmState => {
  const e0 = evmW(L, 0).toLowerCase(), e2 = evmW(L2, 0).toLowerCase();
  return { wei: new Map([[e0, 123n], [e2, 9n]]), tokens: new Map([[USDC, new Map([[e0, 1_000_000n]])], [TOKEN_X, new Map([[e2, 5n]])]]) };
};
const evmChain = (s: EvmState = evmState()): EvmChain => ({ blocks: [s] });
const TOKENS = [USDC, TOKEN_X];
const solReader = (c: SolChain = solChain(), e?: Edit, o?: ReaderOpts): HoldingsReader => solanaHoldingsReader(solRpc(c, e), o);
const evmReader = (c: EvmChain = evmChain(), e?: Edit, tokens = TOKENS): HoldingsReader => evmHoldingsReader(evmRpc(c, e), tokens);
const view = (h: { native: bigint; tokens: ReadonlyMap<string, { amount: bigint; frozen: boolean }>; unreadable: readonly string[] }) =>
  [h.native, Object.fromEntries([...h.tokens].map(([k, v]) => [k, v.frozen ? `${v.amount} frozen` : v.amount])), h.unreadable];

// ---------- a seeded store ----------
const opened: { w: WalletStore; ns: NoteStore }[] = [];
after(() => { for (const o of opened) (o.ns.close(), o.w.close()); });
type Seed = { ref: NoteRef; scope: bigint; label: bigint; state: "UNSPENT" | "HELD" | "RESERVED" | "SPENT" };
async function storeWith(notes: readonly Seed[]): Promise<NoteStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  opened.push({ w, ns });
  for (const [k, n] of notes.entries()) {
    const precommitment = noteSecrets(SEED, n.ref).precommitment;
    const leaf = { value: 10_000_000n, label: n.label, commitment: noteCommitment(10_000_000n, n.label, precommitment), leafIndex: BigInt(k) };
    const r = await ns.add({ ref: n.ref, scope: n.scope, precommitment, state: "UNSPENT", leaf });
    if (n.state === "SPENT") await ns.move(r.id, "UNSPENT", "SPENT");
    if (n.state === "HELD" || n.state === "RESERVED") {
      const h = await ns.move(r.id, "UNSPENT", "HELD", { deadlineMs: 1_800_000_000_000n, context: String(k + 1) });
      if (n.state === "RESERVED") await ns.move(r.id, "HELD", "RESERVED", { attempt: h.attempt! });
    }
  }
  return ns;
}
const SEEDED: Seed[] = [
  { ref: DEP, scope: SOL_SCOPE, label: L, state: "SPENT" }, // W_{sol, l, 0}
  { ref: { kind: "change", l: L, j: 0 }, scope: SOL_SCOPE, label: L, state: "RESERVED" }, // W_{sol, l, 1}: its proof left
  { ref: { kind: "deposit", s: SOL_SCOPE, i: 2 }, scope: SOL_SCOPE, label: 56n, state: "HELD" }, // its proof never left: no W
  { ref: { kind: "deposit", s: SOL_SCOPE, i: 1 }, scope: SOL_SCOPE, label: 55n, state: "UNSPENT" }, // no W
  { ref: { kind: "deposit", s: EVM_SCOPE, i: 0 }, scope: EVM_SCOPE, label: L, state: "SPENT" }, // W_{evm, l, 0}
  { ref: { kind: "return", c: "evm", l: L, j: 0 }, scope: EVM_SCOPE, label: L2, state: "SPENT" }, // W_{evm, L2, 0}
  { ref: { kind: "deposit", s: OTHER_SCOPE, i: 0 }, scope: OTHER_SCOPE, label: L, state: "SPENT" }, // a pool not asked
];

test("a seeded store's spent and reserved notes on Solana and EVM: each W (the A.8 addresses) and its holdings; no request names two Ws", async () => {
  const ns = await storeWith(SEEDED);
  assert.deepEqual((await ns.list()).sort((x, y) => (x.leaf!.leafIndex < y.leaf!.leafIndex ? -1 : 1)).map((n) => n.state), SEEDED.map((n) => n.state), "the store holds each note in its seeded state");
  log.length = 0;
  const pools: BuyPool[] = [
    { id: "sol", chain: "sol", spent: await spentNotesOf(ns, SOL_SCOPE), reader: solReader() },
    { id: "base", chain: "evm", spent: await spentNotesOf(ns, EVM_SCOPE), reader: evmReader() },
  ];
  const r = await buyWallets(SEED, pools);
  assert.deepEqual(r.failed, []);
  const ws = r.wallets;
  assert.deepEqual(ws.map((w) => [w.pool, w.chain, w.l, w.j, w.address]), [
    ["sol", "sol", L, 0, vec("sol", 0)],
    ["sol", "sol", L, 1, vec("sol", 1)],
    ["base", "evm", L, 0, d.toChecksum(vec("evm", 0))],
    ["base", "evm", L2, 0, evmW(L2, 0)],
  ]);
  assert.deepEqual(ws.map((w) => w.note), [refKey(SEEDED[0]!.ref), refKey(SEEDED[1]!.ref), refKey(SEEDED[4]!.ref), refKey(SEEDED[5]!.ref)]);
  assert.equal(ws[0]!.path, A8.wallets.find((w) => w.name === "W_{sol,l,0}")!.path);
  assert.deepEqual(ws.map((w) => view(w.holdings)), [
    [5_000_000n, { [MINT_A]: 123n, [MINT_B]: 7n }, []],
    [0n, {}, []],
    [123n, { [USDC]: 1_000_000n, [TOKEN_X]: 0n }, []],
    [9n, { [USDC]: 0n, [TOKEN_X]: 5n }, []],
  ]);
  assert.equal(log.length, 2 * 3 + 2 * (2 + 2), "Solana 3 reads a W, EVM a block, a balance and one call a token");
  const mine = ws.map((w) => w.address.toLowerCase().replace(/^0x/, ""));
  for (const [m, p] of log) if (m !== "eth_getBlockByNumber") assert.equal(mine.filter((a) => p.toLowerCase().includes(a)).length, 1, p);
});

test("the EVM side takes its spent notes as input: W_{evm,l,1} of change note 0 is the A.8 address", async () => {
  const r = await buyWallets(SEED, [{ id: "base", chain: "evm", spent: [{ ref: { kind: "change", l: L, j: 0 }, label: L }], reader: evmReader() }]);
  assert.deepEqual(r.wallets.map((w) => [w.j, w.address.toLowerCase(), w.holdings.native]), [[1, vec("evm", 1), 0n]]);
});

test("Solana: a swap landing between a W's reads is read again at the higher slot, so the holdings are one slot's; refused past the bound", async () => {
  // slot 100: 5 SOL and no token. Slot 101: 1 SOL and 1000 of MINT_A. The swap lands right after getBalance answers.
  const at = (slot: number): SolState => ({ lamports: new Map([[solW(0), slot === 100 ? 5_000_000_000 : 1_000_000_000]]), accounts: slot === 100 ? [] : [{ pubkey: key32(20), program: SOLANA_TOKEN_PROGRAM, mint: MINT_A, owner: solW(0), amount: 1000n }] });
  const c: SolChain = { slot: 100, at, onCall: (m, ch) => { if (m === "getBalance" && ch.slot === 100) ch.slot = 101; } };
  log.length = 0;
  const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }], reader: solReader(c) }]);
  assert.deepEqual(r.wallets.map((w) => view(w.holdings)), [[1_000_000_000n, { [MINT_A]: 1000n }, []]]);
  assert.equal(log.length, 6, "the three reads, then the three again at slot 101");
  assert.ok(log.slice(3).every(([, p]) => p.includes('"minContextSlot":101')));
  // a chain that moves at every read never meets at one slot: refused after SOL_HOLDINGS_ROUNDS rounds
  const moving: SolChain = { slot: 1, at: () => solState(), onCall: (_m, ch) => void (ch.slot += 1) };
  log.length = 0;
  const f = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }], reader: solReader(moving) }]);
  assert.deepEqual(f.failed, [{ pool: "sol", error: `wallet 0: its reads met at no one slot in ${SOL_HOLDINGS_ROUNDS} rounds` }]);
  assert.equal(log.length, 3 * SOL_HOLDINGS_ROUNDS);
  // an answer below the minContextSlot asked is refused
  const behind: Edit = (m, o, p) => ((p[p.length - 1] as { minContextSlot?: number }).minContextSlot ? { ...(o as object), context: { slot: 100 } } : o);
  const f2 = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }], reader: solReader({ slot: 100, at, onCall: c.onCall! }, behind) }]);
  assert.match(f2.failed[0]!.error, /no context slot at or past the one asked/);
});

test("EVM: one block is read and every call names its hash, so a block landing between calls changes nothing", async () => {
  const before = evmState();
  const later: EvmState = { wei: new Map(), tokens: new Map([[USDC, new Map([[evmW(L, 0).toLowerCase(), 5_000_000n]])]]) };
  const c: EvmChain = { blocks: [before], onLatest: (ch) => void ch.blocks.push(later) };
  log.length = 0;
  const r = await buyWallets(SEED, [{ id: "base", chain: "evm", spent: [{ ref: { kind: "deposit", s: EVM_SCOPE, i: 0 }, label: L }], reader: evmReader(c) }]);
  assert.deepEqual(r.wallets.map((w) => view(w.holdings)), [[123n, { [USDC]: 1_000_000n, [TOKEN_X]: 0n }, []]]);
  for (const [m, p] of log.slice(1)) assert.ok(p.endsWith(`{"blockHash":"${hashOf(0)}"}]`), `${m} at the block read`);
});

test("one failure hides nothing else: a failing pool reports and the others list; a token that reverts or has no code is unreadable", async () => {
  const s = evmState();
  s.reverts = new Set([TOKEN_R]);
  s.noCode = new Set([TOKEN_X]);
  const broken: SolanaRpc = async () => { throw new Error("fetch failed: https://key-in-url.example/abc"); };
  const r = await buyWallets(SEED, [
    { id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }], reader: solanaHoldingsReader(broken) },
    { id: "base", chain: "evm", spent: [{ ref: { kind: "deposit", s: EVM_SCOPE, i: 0 }, label: L }], reader: evmReader(evmChain(s), undefined, [USDC, TOKEN_X, TOKEN_R]) },
  ]);
  assert.deepEqual(r.failed, [{ pool: "sol", error: "wallet 0: getBalance: the call failed" }]);
  assert.deepEqual(r.wallets.map((w) => [w.pool, ...view(w.holdings)]), [["base", 123n, { [USDC]: 1_000_000n }, [TOKEN_X, TOKEN_R]]]);
  // a transport failure on a token's call is the pool's, never "unreadable"
  const t: Edit = (m, o, p) => { if (m === "eth_call" && (p[0] as { to: string }).to === USDC) throw new Error("socket hang up"); return o; };
  const f = await buyWallets(SEED, [{ id: "base", chain: "evm", spent: [{ ref: { kind: "deposit", s: EVM_SCOPE, i: 0 }, label: L }], reader: evmReader(evmChain(), t) }]);
  assert.deepEqual(f.failed, [{ pool: "base", error: "wallet 0: eth_call: the call failed" }]);
});

test("Solana: a frozen account flags its mint; one pubkey under both token programs is refused", async () => {
  const s = solState();
  s.accounts[0]!.state = 2; // the first of MINT_A's two accounts: the second, not frozen, must not clear the flag
  const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }], reader: solReader(solChain(s)) }]);
  assert.deepEqual(r.wallets.map((w) => view(w.holdings)), [[5_000_000n, { [MINT_A]: "123 frozen", [MINT_B]: 7n }, []]]);
  const twice = solState();
  twice.accounts.push({ ...twice.accounts[0]!, program: SOLANA_TOKEN_2022_PROGRAM });
  const f = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }], reader: solReader(solChain(twice)) }]);
  assert.deepEqual(f.failed, [{ pool: "sol", error: "wallet 0: getTokenAccountsByOwner: an account twice" }]);
});

test("a hostile provider's answer stops its pool: another program's or owner's account, an account twice, a mint, a bad balance, block or word", async () => {
  const one = async (reader: HoldingsReader, chain: "sol" | "evm" = "sol") => {
    const r = await buyWallets(SEED, [{ id: "p", chain, spent: [{ ref: chain === "sol" ? DEP : { kind: "deposit", s: EVM_SCOPE, i: 0 }, label: L }], reader }]);
    assert.equal(r.wallets.length, 0);
    return r.failed[0]!.error;
  };
  const accts = (f: (v: { pubkey: string; account: { owner: string; data: [string, string] } }[]) => void): Edit => (m, o) => {
    if (m === "getTokenAccountsByOwner") f((o as { value: { pubkey: string; account: { owner: string; data: [string, string] } }[] }).value);
    return o;
  };
  assert.match(await one(solReader(solChain(), accts((v) => v[0] && (v[0].account.owner = "11111111111111111111111111111111")))), /not an account of the program asked/);
  assert.match(await one(solReader(solChain(), accts((v) => v[0] && v.push(v[0])))), /an account twice/);
  assert.match(await one(solReader(solChain(), accts((v) => v[0] && (v[0].account.data = [tokenData({ pubkey: v[0].pubkey, program: SOLANA_TOKEN_PROGRAM, mint: MINT_A, owner: key32(99), amount: 1n }), "base64"])))), /an account of another owner/);
  assert.match(await one(solReader(solChain(), accts((v) => v[0] && (v[0].account.data = [tokenData({ pubkey: v[0].pubkey, program: SOLANA_TOKEN_PROGRAM, mint: MINT_A, owner: solW(0), amount: 1n, len: 166, type: 1 }), "base64"])))), /not a token account/);
  assert.match(await one(solReader(solChain(), (m, o) => (m === "getBalance" ? { context: { slot: 500 }, value: 1.5 } : o))), /getBalance: not a whole number/);
  assert.match(await one(solReader(solChain(), (m, o) => (m === "getBalance" ? { context: { slot: 500 }, value: "5" } : o))), /getBalance: not a whole number/);
  assert.match(await one(solReader(solChain(), (m, o) => (m === "getBalance" ? { value: 5 } : o))), /getBalance: no context slot/);
  assert.match(await one(solReader(solChain(), (m, o) => (m === "getTokenAccountsByOwner" ? { context: { slot: 500 } } : o))), /not a list/);
  assert.match(await one(evmReader(evmChain(), (m, o) => (m === "eth_getBlockByNumber" ? { hash: "0x12", number: "0x0" } : o)), "evm"), /eth_getBlockByNumber: not a block/);
  assert.match(await one(evmReader(evmChain(), (m, o) => (m === "eth_getBlockByNumber" ? null : o)), "evm"), /eth_getBlockByNumber: not a block/);
  assert.match(await one(evmReader(evmChain(), (m, o) => (m === "eth_getBalance" ? "0x07b" : o)), "evm"), /eth_getBalance: not a quantity/);
  assert.match(await one(evmReader(evmChain(), (m, o) => (m === "eth_getBalance" ? 123 : o)), "evm"), /eth_getBalance: not a quantity/);
  assert.match(await one(evmReader(evmChain(), (m, o) => (m === "eth_call" ? `${o as string}00` : o)), "evm"), /eth_call: token 0: not one 32-byte word/);
  assert.throws(() => evmHoldingsReader(evmRpc(evmChain()), [USDC, USDC.toUpperCase().replace("0X", "0x")]), /a token twice/);
});

test("errors carry an index, never a note's ref or label, W or its path; an RPC's own text is cut to its code", async () => {
  const chg: NoteRef = { kind: "change", l: L, j: 0 };
  const errs: string[] = [];
  const dup = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }, { ref: chg, label: L }, { ref: chg, label: L }], reader: solReader() }]);
  errs.push(dup.failed[0]!.error);
  assert.equal(dup.failed[0]!.error, "wallet 2: its W is wallet 1's");
  const rpcErr: Edit = (m) => { if (m === "getBalance") throw new Error(`RPC error -32602: Invalid param: ${solW(1)} at ${A8.l}`); return undefined; };
  const e = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: chg, label: L }], reader: solReader(solChain(), rpcErr) }]);
  errs.push(e.failed[0]!.error);
  assert.equal(e.failed[0]!.error, "wallet 0: getBalance: rpc error -32602");
  const wrong = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }], reader: evmReader() }]);
  assert.deepEqual(wrong.failed, [{ pool: "sol", error: "the reader is not of chain sol" }]);
  for (const m of errs) for (const bad of [solW(0), solW(1), A8.l, L.toString(), "m/44'", refKey(chg), refKey(DEP)]) assert.ok(!m.includes(bad), m);
});

test("the Ws are read in a random order across the pools, never the notes' order", async () => {
  const spent = [0, 1, 2, 3].map((j) => (j === 0 ? { ref: DEP, label: L } : { ref: { kind: "change", l: L, j: j - 1 } as NoteRef, label: L }));
  const order = async (pick?: (n: number) => number): Promise<number[]> => {
    log.length = 0;
    const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent, reader: solReader() }], pick ? { pick } : {});
    const seen = [...new Set(log.map(([, p]) => JSON.parse(p)[0] as string))];
    return seen.map((a) => r.wallets.findIndex((w) => w.address === a));
  };
  // Fisher-Yates with pick = 0 at every step moves each last W to the front in turn: [1, 2, 3, 0]
  assert.deepEqual(await order(() => 0), [1, 2, 3, 0]);
  assert.deepEqual((await order()).sort(), [0, 1, 2, 3]);
  await assert.rejects(order(() => 9), /pick: not an index/);
});

test("derived first, read later: the Ws come from the seed at once, so the caller zeroes it before any read; a read of only some Ws reads and answers only those", async () => {
  const spent = [0, 1, 2].map((j) => (j === 0 ? { ref: DEP, label: L } : { ref: { kind: "change", l: L, j: j - 1 } as NoteRef, label: L }));
  const seed = SEED.slice();
  const derived = derivedBuyWallets(seed, [{ id: "sol", chain: "sol", spent, reader: solReader() }]);
  seed.fill(0);
  log.length = 0;
  const all = await derived.read();
  const want = (await buyWallets(SEED, [{ id: "sol", chain: "sol", spent, reader: solReader() }])).wallets.map((w) => w.address);
  assert.deepEqual(all.wallets.map((w) => w.address), want, "the Ws of the seed as it was when derived");
  assert.equal(want[0], solW(0));
  log.length = 0;
  const some = await derived.read({ only: new Set([want[1]!]) });
  assert.deepEqual(some.wallets.map((w) => w.address), [want[1]]);
  assert.deepEqual([...new Set(log.map(([, p]) => JSON.parse(p)[0] as string))], [want[1]], "no other W is read");
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(derived.read({ signal: stop.signal }), { name: "AbortError" });
});

test("card wallets-found-in-one-read: a list read in part reads only the Ws asked for, one per request, and answers every other with holdings null, never empty; a pool that does not derive fails with none asked", async () => {
  const spent = [0, 1, 2].map((j) => (j === 0 ? { ref: DEP, label: L } : { ref: { kind: "change", l: L, j: j - 1 } as NoteRef, label: L }));
  const seed = SEED.slice();
  const derived = derivedBuyWallets(seed, [{ id: "sol", chain: "sol", spent, reader: solReader() }]);
  seed.fill(0);
  const [w0, w1, w2] = derived.wallets.map((w) => w.address);
  assert.deepEqual([w0, w1, derived.wallets.length], [solW(0), solW(1), 3]);
  assert.ok(derived.wallets.every((w) => !("holdings" in w)), "a derived W has no holdings to read as empty");
  log.length = 0;
  const asked: string[] = [];
  const got = await wantedBuyWallets(derived, async (a) => (asked.push(a), a === solW(1)));
  assert.deepEqual(asked, [w0, w1, w2]);
  assert.deepEqual([...new Set(log.map(([, p]) => JSON.parse(p)[0] as string))], [solW(1)], "no other W is read");
  assert.deepEqual(got.wallets.map((w) => [w.address, w.holdings === null]), [[w0, true], [w1, false], [w2, true]]);
  assert.deepEqual(got.failed, []);
  log.length = 0;
  const none = await wantedBuyWallets(derived, () => false);
  assert.equal(log.length, 0);
  assert.ok(none.wallets.every((w) => w.holdings === null));
  // a pool whose reader is not of its chain derives nothing: failed, whatever is asked
  const bad = derivedBuyWallets(SEED, [{ id: "x", chain: "evm", spent, reader: solReader() }]);
  assert.deepEqual(await wantedBuyWallets(bad, () => false), { wallets: [], failed: [{ pool: "x", error: "the reader is not of chain evm" }] });
});

test("card wallets-found-in-one-read: a read's `first` Ws go before the rest, whatever the shuffle, and `each` is told every W as it is read, in that order", async () => {
  const spent = [0, 1, 2].map((j) => (j === 0 ? { ref: DEP, label: L } : { ref: { kind: "change", l: L, j: j - 1 } as NoteRef, label: L }));
  const d = derivedBuyWallets(SEED, [{ id: "sol", chain: "sol", spent, reader: solReader() }]);
  const [w0, w1, w2] = d.wallets.map((w) => w.address);
  for (const pick of [() => 0, (n: number) => n - 1]) {
    log.length = 0;
    const told: string[] = [];
    await d.read({ pick, first: new Set([w2!]), each: (w) => void told.push(w.address) });
    const order = [...new Set(log.map(([, p]) => JSON.parse(p)[0] as string))];
    assert.equal(order[0], w2);
    assert.deepEqual(new Set(order), new Set([w0, w1, w2]));
    assert.deepEqual(told, order);
  }
});

test("a Solana restore's spends must be its spent notes, each at the queue's (l, j)", () => {
  const leaf = (label: bigint) => ({ value: 1n, label, commitment: 1n, leafIndex: 0n });
  const chg: NoteRef = { kind: "change", l: L, j: 0 };
  const notes = [
    { ref: DEP, scope: SOL_SCOPE, precommitment: 1n, leaf: leaf(L), state: "SPENT" as const },
    { ref: chg, scope: SOL_SCOPE, precommitment: 2n, leaf: leaf(L), state: "SPENT" as const },
    { ref: { kind: "change", l: L, j: 1 } as NoteRef, scope: SOL_SCOPE, precommitment: 3n, leaf: leaf(L), state: "UNSPENT" as const },
  ];
  const spends = [{ l: L, j: 0, note: refKey(DEP), w: solW(0), withdrawn: 1n }, { l: L, j: 1, note: refKey(chg), w: solW(1), withdrawn: 1n }];
  assert.deepEqual(solanaSpentNotes({ notes, spends }), [{ ref: DEP, label: L }, { ref: chg, label: L }]);
  assert.throws(() => solanaSpentNotes({ notes, spends: spends.slice(1) }), /its spends are not its spent notes/);
  assert.throws(() => solanaSpentNotes({ notes, spends: [spends[0]!, { ...spends[1]!, j: 2 }] }), /spend 1 is not its note's/);
  assert.throws(() => solanaSpentNotes({ notes, spends: [spends[0]!, { ...spends[1]!, l: L2 }] }), /spend 1 is not its note's/);
  assert.throws(() => solanaSpentNotes({ notes, spends: [spends[1]!, spends[0]!] }), /spend 0 is not its note's/);
  assert.throws(() => solanaSpentNotes({ notes, spends: [{ ...spends[0]!, note: refKey({ kind: "deposit", s: SOL_SCOPE, i: 9 }) }, spends[1]!] }), /spend 0 is not its note's/);
});

test("production readers go through the helper's /v1/rpc/{chain} only, and take an origin only", async () => {
  const asked: string[] = [];
  const fetchSpy = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    asked.push(`${String(url)} ${JSON.parse(String(init?.body)).method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(init?.body)).id, result: { hash: hashOf(0), number: "0x0" } }), { headers: { "content-type": "application/json" } });
  };
  const real = globalThis.fetch;
  globalThis.fetch = fetchSpy as typeof fetch;
  try {
    await evmHelperHoldings("https://api.example", "robinhood", []).read(evmW(L, 0)).catch(() => undefined);
    await solanaHelperHoldings("https://api.example").read(solW(0)).catch(() => undefined);
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(asked.slice(0, 2), ["https://api.example/v1/rpc/robinhood eth_getBlockByNumber", "https://api.example/v1/rpc/robinhood eth_getBalance"]);
  assert.ok(asked.slice(2).length > 0 && asked.slice(2).every((a) => a.startsWith("https://api.example/v1/rpc/solana ")), asked.join("\n"));
  assert.throws(() => evmHelperHoldings("https://api.example/v1", "base", []), /origin only/);
});

test("W is on the standard path: a stock BIP-32 at the A.8 EVM path and SLIP-10 at the A.8 Solana path give the A.8 addresses", () => {
  const steps = (p: string): number[] => p.split("/").slice(1).map((s) => Number(s.replace("'", "")) + 0x80000000);
  for (const j of [0, 1]) {
    const e = A8.wallets.find((w) => w.c === "evm" && w.j === j)!;
    const node = HDKey.fromMasterSeed(SEED).derive(e.path);
    assert.equal(d.evmAddress(node.publicKey!).toLowerCase(), e.address, e.name);
    assert.equal(d.walletPath(SEED, "evm", L, j).path, e.path);
    const s = A8.wallets.find((w) => w.c === "sol" && w.j === j)!;
    const k = d.slip10Ed25519(SEED, steps(s.path)).key;
    assert.equal(d.walletPath(SEED, "sol", L, j).path, s.path);
    const w = d.freshWallet(SEED, "sol", L, j);
    assert.deepEqual(w.secretKey, k, s.name);
    assert.equal(w.address, s.address, s.name);
  }
});

// One derivation of W: no file of Blindfill or the apps derives a key from a path but derive/keys.ts.
test("no second key derivation: only derive/keys.ts holds BIP-32, SLIP-10 or a wallet path", () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const dirs = ["packages/wallet/src", "packages/kit/src", "packages/signpage/src", "packages/exit", "apps/terminal/src", "apps/helper/src"];
  const files: string[] = [];
  const walk = (p: string): void => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const f of readdirSync(p)) if (f !== "node_modules") walk(join(p, f)); }
    else if (/\.(ts|tsx|js|mjs)$/.test(p)) files.push(p);
  };
  for (const dir of dirs) walk(join(root, dir));
  assert.ok(files.length > 50, "the walk found the sources");
  const derivation = /@scure\/bip32|\bHDKey\b|"ed25519 seed"|\bslip10Ed25519\s*\(|\bwalletPath\s*\(|derivePath|ed25519-hd-key|micro-key-producer/;
  const hits = files.filter((f) => derivation.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length));
  assert.deepEqual(hits, ["packages/wallet/src/derive/keys.ts"]);
  // every W a pool pays comes from freshWallet, called where the queue proves, where a restore lists it, and where an
  // armed W signs a buy (arming/records.ts solanaArmedSigner: it derives W_{sol,l,j} of the arm record, refuses unless
  // the address is the record's, signs the one message and zeroes the key, test/arm-key-zero.test.ts). The other
  // callers zero W's key at once and export no signer, so the signer derives W itself rather than through a pass-through.
  // And where a pool buy signs at the tap (signpage src/pool-buy.ts runPoolBuy: W_{sol,l,j} of the ready proof, refused
  // unless it is the proof's recipient, signs only the message signSolana's check passed, its key zeroed in a finally;
  // card signpage-pool-buy), and where a pool sell signs at the tap (signpage src/pool-sell.ts runPoolSell: W_{sol,l,j}
  // of the buy wallet it picked, refused unless it is the W the checked bytes were built for, signs only the message
  // checkSolanaSell passed, its key zeroed in a finally; card signpage-pool-sell), and where a pool withdraw signs at the
  // press (signpage src/pool-withdraw.ts onePart: W_{sol,l,j} of the note it proves, its key zeroed at once for the
  // binding's address; at the sign, W again, refused unless it is the binding's W the bytes were built for, signs only the
  // message checkSolanaWithdraw passed, its key zeroed in a finally; card signpage-pool-withdraw-form). And where the
  // vault restore lists the fresh wallets of its withdrawals (wallet src/restore/wallets.ts restoreWallets: W on all six
  // chain tags, its key zeroed at once for the address and no signer exported; test/pool-zeroing.test.ts; card
  // wallet-restore-wallets), and where step 7 lists a landed arm's W to re-read (wallet src/restore/arms.ts quietArms:
  // the arm's own three W, each key zeroed at once for the address, no signer exported; test/pool-zeroing.test.ts; card
  // wallet-restore-id-reader). And where an EVM pool buy signs at the tap (signpage src/pool-buy-evm.ts runEvmPoolBuy:
  // W_{evm,l,j} of the ready proof, refused unless it is the proof's W and the relay data's recipient, signs only the buy
  // checkEvmBuy passed, its key zeroed once it has signed and again in a finally; card signpage-evm-pool-buy). And where
  // an EVM pool sell signs at the tap (signpage src/pool-sell-evm.ts signPicked: W_{evm,l,j} of the buy record it sells,
  // refused unless it is that record's W, after its return note's evmNextNote pick, signs only the sim checkEvmSellSim,
  // the Sell checkEvmSell and the authorization checkEvmAuthorization passed, its key zeroed once it has signed and again
  // in signLeg's finally; card signpage-evm-pool-sell). And where an EVM pool withdraw signs (signpage
  // src/pool-withdraw-evm.ts: onePart's release, W_{evm,l,j} of the note it proves, refused unless it is the binding's W
  // and the relay data's recipient, signs only what checkEvmWithdraw passed; sendOnward's and resendHeld's send to To,
  // refused unless the derived W is the W read, signs only the send checkEvmOnwardSend passed; each key zeroed in a
  // finally, and every other call (spendOf, wOf, the plan's Ws) zeroes it at once for the address; card
  // evm-withdraw-mainnet). And where a NEAR fresh wallet signs its Rhea calls (wallet
  // src/near/swap-delegate.ts signNearSwapDelegates: W_{near,l,j}, refused unless it is the read's and the request's W,
  // signs only the calls the kit's nearSwapCheck passed on its own copy, its key zeroed in a finally; nearSwapWallet
  // zeroes it at once for the id; test/near-swap-delegate.test.ts; card near-private-trading). And where a NEAR sell's W
  // moves its USDC back into the vault on its return note (wallet src/deposit/delegate.ts moverDepositDelegate: W_{near,l,j}
  // in U's place, refused unless the two-RPC read is W's, signs only the release's vaultDepositCall with W the depositor,
  // its key zeroed in a finally; moverAccount zeroes it at once for the id; test/deposit-delegate.test.ts; card
  // near-private-trading).
  const calls = files.filter((f) => /\bfreshWallet\s*\(/.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length)).sort();
  assert.deepEqual(calls, ["packages/signpage/src/pool-buy-evm.ts", "packages/signpage/src/pool-buy.ts", "packages/signpage/src/pool-sell-evm.ts", "packages/signpage/src/pool-sell.ts", "packages/signpage/src/pool-withdraw-evm.ts", "packages/signpage/src/pool-withdraw.ts", "packages/wallet/src/arming/records.ts", "packages/wallet/src/deposit/delegate.ts", "packages/wallet/src/derive/keys.ts", "packages/wallet/src/near/swap-delegate.ts", "packages/wallet/src/pool/buy-wallets.ts", "packages/wallet/src/pool/evm-restore.ts", "packages/wallet/src/pool/queue.ts", "packages/wallet/src/pool/solana-restore.ts", "packages/wallet/src/restore/arms.ts", "packages/wallet/src/restore/wallets.ts"]);
});

// ---------- fold 2 ----------
test("EVM: only a revert (code 3) or no code makes a token unreadable; a lagging, limited or failing provider's error fails the pool", async () => {
  const at = (code: number): Edit => (m, o) => { if (m === "eth_call") throw new Error(`RPC error ${code}: some text`); return o; };
  const run = (e: Edit) => buyWallets(SEED, [{ id: "base", chain: "evm", spent: [{ ref: { kind: "deposit", s: EVM_SCOPE, i: 0 }, label: L }], reader: evmReader(evmChain(), e, [USDC]) }]);
  for (const code of [-32000, -32001, -32005, -32603]) assert.deepEqual((await run(at(code))).failed, [{ pool: "base", error: `wallet 0: eth_call: rpc error ${code}` }], `code ${code}`);
  const r = await run(at(3));
  assert.deepEqual([r.failed, r.wallets[0]!.holdings.unreadable], [[], [USDC]]);
});

test("Solana: a re-read a backend refuses with -32016 is asked again a slot later, within SOL_LAG_SLOTS waits, never a failed round", async () => {
  // round 1: getBalance at 100, the token reads at 101; round 2 (min 101): getBalance answers -32016; a slot later: all at 101
  let n = 0;
  const c: SolChain = { slot: 101, at: () => solState() };
  const e: Edit = (m, o, p) => {
    const min = (p[p.length - 1] as { minContextSlot?: number }).minContextSlot;
    n++;
    if (min === undefined && m === "getBalance") return { ...(o as object), context: { slot: 100 } };
    if (min !== undefined && m === "getBalance" && n <= 6) throw new Error("RPC error -32016: Minimum context slot has not been reached");
    return o;
  };
  log.length = 0;
  const waits: number[] = [];
  const opts: ReaderOpts = { sleep: async (ms) => void waits.push(ms) };
  const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }], reader: solReader(c, e, opts) }]);
  assert.deepEqual(r.failed, []);
  assert.equal(r.wallets[0]!.holdings.native, 5_000_000n);
  assert.equal(log.length, 9, "three reads of three");
  assert.deepEqual(waits, [SOL_LAG_WAIT_MS], "one wait of a slot");
  // a backend behind for more than SOL_HOLDINGS_ROUNDS reads, within SOL_LAG_SLOTS slots: read, never refused
  let k = 0;
  const behind: Edit = (m, o, p) => {
    const min = (p[p.length - 1] as { minContextSlot?: number }).minContextSlot;
    if (min === undefined && m === "getBalance") return { ...(o as object), context: { slot: 100 } };
    if (min !== undefined && m === "getBalance" && ++k <= SOL_LAG_SLOTS) throw new Error("RPC error -32016: Minimum context slot has not been reached");
    return o;
  };
  waits.length = 0;
  const b = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }], reader: solReader(c, behind, opts) }]);
  assert.deepEqual(b.failed, []);
  assert.equal(waits.length, SOL_LAG_SLOTS);
  // a backend that never catches up: the bound, then the refusal
  // its getBalance lags past the budget's SOL_LAG_SLOTS + 1 calls end in another error, so a reader with no budget fails,
  // never spins
  let lagged = 0;
  const never: Edit = (m, o, p) => {
    const min = (p[p.length - 1] as { minContextSlot?: number }).minContextSlot;
    if (min === undefined && m === "getBalance") return { ...(o as object), context: { slot: 100 } };
    if (min !== undefined && m === "getBalance" && ++lagged > SOL_LAG_SLOTS + 1) throw new Error("RPC error -32005: the fake's lag ran past the budget");
    if (min !== undefined) throw new Error("RPC error -32016: Minimum context slot has not been reached");
    return o;
  };
  waits.length = 0;
  const f = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }], reader: solReader(c, never, opts) }]);
  assert.equal(f.failed.length, 1);
  assert.match(f.failed[0]!.error, /^wallet 0: \w+: rpc error -32016$/);
  assert.equal(waits.length, SOL_LAG_SLOTS, "the budget, then the refusal");
});

test("the helper's Solana reader is paced in the kit's provider queue: a burst of Ws is spread over the limit's window", () => onTestClock(async () => {
  const starts: number[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    starts.push(Date.now());
    const q = JSON.parse(String(init?.body)) as { id: string; method: string };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: { context: { slot: 1 }, value: q.method === "getBalance" ? 0 : [] } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const reader = solanaHelperHoldings("https://api.example");
    const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }, { ref: { kind: "change", l: L, j: 0 }, label: L }], reader }]);
    assert.deepEqual(r.failed, []);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(starts.length, 6);
  assert.ok(starts[3]! - starts[0]! >= HOLDINGS_RPC_LIMIT.windowMs, `the second W's reads wait for the window: ${starts[3]! - starts[0]!} ms`);
}));

test("card wallets-found-in-one-read: the finder's rounds are held by the host's pass budget: with the page's window full, a round waits for room instead of only being counted", () => onTestClock(async () => {
  const sol = stubFetch("https://lane-sol.example", (m, id) => solOk(m, id));
  try {
    // the page has sent the host its passes' budget in this window
    const lane = hostLane("https://lane-sol.example");
    for (let i = 0; i < PASS_BUDGET; i++) lane.count();
    const t0 = Date.now();
    await solanaHelperHoldings("https://lane-sol.example").read(solW(0));
    // the round left once the window's oldest requests did (10 s), never at once
    assert.ok(sol.starts[0]![0] - t0 >= 9_000, `${sol.starts[0]![0] - t0} ms`);
  } finally {
    sol.restore();
  }
}));

test("card wallets-found-in-one-read: on a provider that takes about 10 getTokenAccountsByOwner in 10 s (mainnet-beta, the helper's fallback), 20 Ws at the pace all read: each 429 is waited out on the one throttle rule, never a failed list", () => onTestClock(async () => {
  // a sliding window of 10 getTokenAccountsByOwner in any 10 s, as measured; past it a 429 with no Retry-After
  const taken: number[] = [];
  let n429 = 0;
  const sol = stubFetch("https://fallback-sol.example", (m, id) => {
    if (m !== "getTokenAccountsByOwner") return solOk(m, id);
    const now = Date.now();
    while (taken.length > 0 && taken[0]! <= now - 10_000) taken.shift();
    if (taken.length >= 10) return n429++, too();
    taken.push(now);
    return solOk(m, id);
  });
  try {
    const spent = Array.from({ length: 20 }, (_, i) => ({ ref: { kind: "deposit", s: 1n, i } as NoteRef, label: 500n + BigInt(i) }));
    const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent, reader: solanaHelperHoldings("https://fallback-sol.example") }]);
    assert.deepEqual(r.failed, []);
    assert.equal(r.wallets.length, 20);
    assert.ok(n429 > 0, "the pace is past this provider's: it throttled");
  } finally {
    sol.restore();
  }
}));

test("card wallets-found-in-one-read: a finder 429 never pauses a trade: the finder's throttle is its route's own, the host's lane stays open for a trade's read", () => onTestClock(async () => {
  const origin = "https://finder-429.example";
  const sol = stubFetch(origin, (m, id) => (m === "getTokenAccountsByOwner" ? too("10") : solOk(m, id)));
  try {
    const stop = new AbortController();
    const read = solanaHelperHoldings(origin).read(solW(0), stop.signal).catch(() => "stopped");
    while (sol.starts.length < 3) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50)); // the round's 429s are in
    const lane = hostLane(`${origin}/v1/rpc/solana`);
    assert.equal(lane.gate.left(), 0, "the host's lane is not paused by the finder's 429");
    const went = await Promise.race([lane.turn("trade").then(() => "went"), new Promise((r) => setTimeout(() => r("held"), 1))]);
    assert.equal(went, "went", "a trade's read goes at once");
    stop.abort();
    await read;
  } finally {
    sol.restore();
  }
}));

test("card wallets-found-in-one-read: a provider refusing one method for good (getTokenAccountsByOwner always 429, Retry-After 10) while it answers the rest, and a trade's reads on the host going through: the list ends at the bound, nothing asked past 30 s", () => onTestClock(async () => {
  const origin = "https://one-method-429.example";
  // a call asked past the bound, and the list's end past it with a second of room
  let pastBound = false, late = false, past = 0;
  const bound = setTimeout(() => (pastBound = true), HOLDINGS_THROTTLE_MAX_MS);
  const ends = setTimeout(() => (late = true), HOLDINGS_THROTTLE_MAX_MS + 1_000);
  const sol = stubFetch(origin, (m, id) => (pastBound && past++, m === "getTokenAccountsByOwner" ? too("10") : solOk(m, id)));
  // a trade's reads on the same host answer every second, as page-rpc.ts reports them to the host's lane
  const lane = hostLane(`${origin}/v1/rpc/solana`);
  let trading = true;
  const trade = (async () => {
    while (trading) {
      lane.answered(lane.gate.epoch());
      await new Promise((r) => setTimeout(r, 1_000));
    }
  })();
  try {
    const spent = Array.from({ length: 5 }, (_, i) => ({ ref: { kind: "deposit", s: 1n, i } as NoteRef, label: 700n + BigInt(i) }));
    const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent, reader: solanaHelperHoldings(origin) }]);
    assert.equal(r.failed.length, 1, "refused, with its cause");
    assert.match(r.failed[0]!.error, /429/);
    assert.equal(past, 0, "no call past the bound");
    assert.equal(late, false, "the list ended at the bound");
  } finally {
    clearTimeout(bound);
    clearTimeout(ends);
    trading = false;
    await trade;
    sol.restore();
  }
}));

test("one pool given twice: its W is listed once, and the later pool is refused", async () => {
  const p: BuyPool = { id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }], reader: solReader() };
  const r = await buyWallets(SEED, [p, { ...p, id: "sol-again" }]);
  assert.deepEqual(r.wallets.map((w) => w.pool), ["sol"]);
  assert.deepEqual(r.failed, [{ pool: "sol-again", error: "wallet 0: its W is pool 0 wallet 0's" }]);
});

// ---------- the readers' pace (M367): HOLDINGS_RPC_LIMIT on their own queue, a round as one unit, the helper's 429 a failed round ----------
/** A stub fetch for one test origin: `answer` gives each call's Response; the real fetch serves every other URL. */
function stubFetch(origin: string, answer: (method: string, id: string, n: number) => Response): { starts: [number, string][]; restore: () => void } {
  const real = globalThis.fetch, starts: [number, string][] = [];
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    if (!String(u).startsWith(origin)) return real(u, init);
    const q = JSON.parse(String(init?.body)) as { id: string; method: string };
    starts.push([Date.now(), q.method]);
    return answer(q.method, q.id, starts.length);
  }) as typeof fetch;
  return { starts, restore: () => { globalThis.fetch = real; } };
}
const ok = (id: string, result: unknown): Response => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
const solOk = (method: string, id: string): Response => ok(id, { context: { slot: 1 }, value: method === "getBalance" ? 0 : [] });
const evmOk = (method: string, id: string): Response => ok(id, method === "eth_getBlockByNumber" ? { hash: hashOf(0), number: "0x0" } : "0x0");
const too = (retryAfter?: string): Response => new Response("slow down", { status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } });

const gaps = (starts: readonly [number, string][], method: string): number[] => {
  const t = starts.filter(([, m]) => m === method).map(([at]) => at);
  return t.slice(1).map((x, k) => x - t[k]!);
};
/** The start times of a Solana reader's rounds: its calls in threes, as they started. */
const rounds = (starts: readonly [number, string][]): number[][] => {
  const t = starts.map(([at]) => at);
  return Array.from({ length: Math.ceil(t.length / 3) }, (_, k) => t.slice(3 * k, 3 * k + 3));
};
const spread = (r: readonly number[]): number => Math.max(...r) - Math.min(...r);

test("HOLDINGS_RPC_LIMIT is the reader's part of the helper's route: a Solana round's three calls start at one instant, one round in 1,667 ms (6 in 10 s); every reader of a route on one queue", () => onTestClock(async () => {
  assert.deepEqual({ ...HOLDINGS_RPC_LIMIT }, { windowMs: 1_667, total: 3, perMethod: 2 });
  // two Solana readers of one route (two pools) read a W each, and an EVM reader two Ws (two calls a W)
  const sol = stubFetch("https://pace-sol.example", (m, id) => solOk(m, id));
  const evm = stubFetch("https://pace-evm.example", (m, id) => evmOk(m, id));
  try {
    const er = evmHelperHoldings("https://pace-evm.example", "base", []);
    await Promise.all([
      (async () => { await solanaHelperHoldings("https://pace-sol.example").read(solW(0)); await solanaHelperHoldings("https://pace-sol.example").read(solW(1)); })(),
      (async () => { await er.read(evmW(L, 0)); await er.read(evmW(L, 1)); })(),
    ]);
  } finally {
    evm.restore();
    sol.restore();
  }
  const r = rounds(sol.starts);
  assert.equal(r.length, 2);
  for (const x of r) assert.ok(spread(x) < 50, `a round's three calls start at one instant: ${spread(x)} ms`);
  assert.ok(r[1]![0]! - r[0]![0]! >= HOLDINGS_RPC_LIMIT.windowMs, `the second reader's round waits the window: ${r[1]![0]! - r[0]![0]!} ms`);
  // EVM: four calls, at most three in any 3 s
  assert.equal(evm.starts.length, 4);
  assert.ok(evm.starts[3]![0] - evm.starts[0]![0] >= HOLDINGS_RPC_LIMIT.windowMs, `EVM: the fourth call waits the window`);
}));

test("a read stopped while its calls wait their turn on the paced route sends none of them: no W of a stopped read is named after the stop", () => onTestClock(async () => {
  const bodies: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    if (!url.startsWith("https://stop-sol.example") && !url.startsWith("https://stop-evm.example")) return real(u, init);
    bodies.push(String(init?.body));
    const q = JSON.parse(String(init?.body)) as { id: string; method: string };
    return url.startsWith("https://stop-sol.example") ? solOk(q.method, q.id) : evmOk(q.method, q.id);
  }) as typeof fetch;
  try {
    const sol = solanaHelperHoldings("https://stop-sol.example");
    const evm = evmHelperHoldings("https://stop-evm.example", "base", []);
    // the first read takes the window's turns; the second's calls wait theirs, and it is stopped while they do
    const first = [sol.read(solW(0)), evm.read(evmW(L, 0)), evm.read(evmW(L, 1))];
    const stop = new AbortController();
    const second = [sol.read(solW(1), stop.signal), evm.read(evmW(L, 2), stop.signal)].map((p) => p.then(() => "read", (e: unknown) => (stop.signal.aborted && e === stop.signal.reason ? "stopped" : `failed: ${String(e)}`)));
    await new Promise((r) => setTimeout(r, 50));
    stop.abort();
    await Promise.all(first);
    assert.deepEqual(await Promise.all(second), ["stopped", "stopped"]);
    // past the window the queued calls would have gone out in
    await new Promise((r) => setTimeout(r, HOLDINGS_RPC_LIMIT.windowMs + 500));
    assert.equal(bodies.filter((b) => b.includes(solW(1)) || b.toLowerCase().includes(evmW(L, 2).slice(2).toLowerCase())).length, 0, "a stopped read's W named after its stop");
    assert.ok(bodies.some((b) => b.includes(solW(0))), "the first read went out");
  } finally {
    globalThis.fetch = real;
  }
}));

/** globalThis.fetch for `origin`: each call answered after `ms`, every body kept. */
const slowFetch = (origin: string, ms: number) => {
  const real = globalThis.fetch;
  const sent: { method: string; body: string }[] = [];
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    if (!String(u).startsWith(origin)) return real(u, init);
    const q = JSON.parse(String(init?.body)) as { id: string; method: string };
    sent.push({ method: q.method, body: String(init?.body) });
    await new Promise((r) => setTimeout(r, ms));
    return evmOk(q.method, q.id);
  }) as typeof fetch;
  return { sent, restore: () => void (globalThis.fetch = real) };
};
const endOf = (p: Promise<unknown>, s: AbortSignal) => p.then(() => "read", (e: unknown) => (s.aborted && e === s.reason ? "stopped" : `failed: ${String(e)}`));
const names = (body: string, w: string) => body.toLowerCase().includes(w.slice(2).toLowerCase());

test("b07: the EVM reader stopped with its block read in flight sends no balance read naming W", async () => {
  const f = slowFetch("https://b07.example", 200);
  try {
    const r = evmHelperHoldings("https://b07.example", "base", [USDC]);
    const stop = new AbortController();
    const end = endOf(r.read(evmW(L, 0), stop.signal), stop.signal);
    await new Promise((r) => setTimeout(r, 50));
    stop.abort();
    assert.equal(await end, "stopped");
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(f.sent.filter((x) => names(x.body, evmW(L, 0))).map((x) => x.method), [], "no call named W after the stop");
  } finally {
    f.restore();
  }
});

test("b08: the EVM reader's token read waiting its turn on the route when its read is stopped is never sent", () => onTestClock(async () => {
  // W's own first three calls (block, balance, the first token) fill the route's window (HOLDINGS_RPC_LIMIT: 3 in 3 s),
  // so its second token read waits its turn in the queue; another reader of the route waits for the gate's turn
  // (card signpage-throttled-read-is-not-asked-again-at-once), so it never fills the window under W
  const real = globalThis.fetch;
  const sent: { method: string; body: string }[] = [];
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    if (!String(u).startsWith("https://b08.example")) return real(u, init);
    const q = JSON.parse(String(init?.body)) as { id: string; method: string };
    sent.push({ method: q.method, body: String(init?.body) });
    await new Promise((r) => setTimeout(r, 200));
    return q.method === "eth_call" ? ok(q.id, `0x${"0".repeat(64)}`) : evmOk(q.method, q.id);
  }) as typeof fetch;
  try {
    const r = evmHelperHoldings("https://b08.example", "base", [USDC, TOKEN_X, TOKEN_R]);
    const stop = new AbortController();
    const w = evmW(L, 1);
    const end = endOf(r.read(w, stop.signal), stop.signal);
    await new Promise((r) => setTimeout(r, 1_000));
    assert.ok(sent.some((x) => x.method === "eth_call" && names(x.body, w) && names(x.body, USDC)), "W's first token read went out");
    stop.abort();
    assert.equal(await end, "stopped");
    await new Promise((r) => setTimeout(r, 5_000));
    assert.deepEqual(sent.filter((x) => x.method === "eth_call" && (names(x.body, TOKEN_X) || names(x.body, TOKEN_R))).map((x) => x.method), [], "W's token read sent after the stop");
  } finally {
    globalThis.fetch = real;
  }
}));

test("a chain whose finalized slot moves every 400 ms: every W's round answers at one slot, so each is read", () => onTestClock(async () => {
  // as Solana's does; a minContextSlot past the slot is refused with -32016, as the RPC does
  const t0 = Date.now();
  const slotNow = () => 1_000 + Math.floor((Date.now() - t0) / 400);
  const st = stubFetch("https://slot-moves.example", (m, id) => ok(id, { context: { slot: slotNow() }, value: m === "getBalance" ? 0 : [] }));
  let r: Awaited<ReturnType<typeof buyWallets>>;
  try {
    const spent = [0, 1, 2].map((i) => ({ ref: i === 0 ? DEP : { kind: "change" as const, l: L, j: i - 1 }, label: L }));
    r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent, reader: solanaHelperHoldings("https://slot-moves.example") }]);
  } finally {
    st.restore();
  }
  assert.deepEqual(r.failed, []);
  assert.equal(r.wallets.length, 3);
  assert.ok(st.starts.length <= 3 * 4, `a W takes a round, rarely two: ${st.starts.length / 3} rounds`);
}));

test("a round failed by a 429 leaves no call behind it: its three calls went out at once, and the next round is three more", () => onTestClock(async () => {
  const st = stubFetch("https://leftover.example", (m, id, n) => (n === 1 ? too("0") : solOk(m, id)));
  try {
    await solanaHelperHoldings("https://leftover.example").read(solW(0));
  } finally {
    st.restore();
  }
  const r = rounds(st.starts);
  assert.equal(st.starts.length, 6, "two rounds of three, nothing after either");
  assert.ok(spread(r[0]!) < 50 && spread(r[1]!) < 50, `each round at one instant: ${spread(r[0]!)}, ${spread(r[1]!)} ms`);
  assert.ok(r[1]![0]! - r[0]![2]! >= HOLDINGS_RPC_LIMIT.windowMs - 50, "the second round waits the window");
}));

test("SOL_HOLDINGS_ROUNDS is 8: a W whose reads meet at one slot only in its eighth round is read", async () => {
  // a swap lands between getBalance and the token reads in each of the first seven rounds
  let balances = 0;
  const c: SolChain = { ...solChain(), onCall: (m, ch) => { if (m === "getBalance" && ++balances < SOL_HOLDINGS_ROUNDS) ch.slot++; } };
  const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }], reader: solReader(c) }]);
  assert.equal(SOL_HOLDINGS_ROUNDS, 8);
  assert.deepEqual(r.failed, []);
  assert.equal(balances, 8);
});

test("a restore never slows the trade path: the readers' queue is their own, not the helper URL's", () => onTestClock(async () => {
  // a restore of three Ws runs on the helper's Solana route while the trade path makes five calls of one method on the
  // same URL through the kit's queue at its own limit: they all start at once, not paced at the readers' limit
  const st = stubFetch("https://trade.example", (m, id) => solOk(m, id));
  const trade = solanaPacedRpc(solanaHelperRpc("https://trade.example"), { windowMs: 10_000, total: 100, perMethod: 40 });
  let tradeStarts: number[] = [];
  try {
    const reader = solanaHelperHoldings("https://trade.example");
    const restore = (async () => { for (const j of [0, 1, 0]) await reader.read(solW(j)); })();
    restore.catch(() => undefined); // awaited below; a throw before then must not leave it unhandled
    await new Promise((r) => setTimeout(r, 1_300)); // the restore is between its reads, its queue full
    const t0 = st.starts.length;
    await Promise.all(Array.from({ length: 5 }, () => trade("getBalance", [solW(1), { commitment: "finalized" }])));
    tradeStarts = st.starts.slice(t0).filter(([, m]) => m === "getBalance").map(([at]) => at).slice(0, 5);
    await restore;
  } finally {
    st.restore();
  }
  assert.equal(tradeStarts.length, 5);
  assert.ok(tradeStarts[4]! - tradeStarts[0]! < 200, `the trade path's calls start at once: ${tradeStarts[4]! - tradeStarts[0]!} ms`);
}));

test("a Retry-After is a delay in seconds or an HTTP date, capped at 10 s; absent or not one of the two, 1 s", () => {
  const now = Date.parse("2026-11-03T02:00:00Z");
  assert.equal(RETRY_AFTER_MAX_MS, 10_000);
  assert.equal(RETRY_AFTER_DEFAULT_MS, 1_000);
  assert.equal(retryAfterMs("3", now), 3_000);
  assert.equal(retryAfterMs(" 0 ", now), 0);
  assert.equal(retryAfterMs("60", now), 10_000);
  assert.equal(retryAfterMs("Tue, 03 Nov 2026 02:00:05 GMT", now), 5_000);
  assert.equal(retryAfterMs("Tue, 03 Nov 2026 02:01:00 GMT", now), 10_000);
  assert.equal(retryAfterMs("Tue, 03 Nov 2026 01:59:00 GMT", now), 0);
  for (const h of [null, "", "-1", "1.5", "soon", "2026-11-03T02:00:05Z"]) assert.equal(retryAfterMs(h, now), 1_000, String(h));
  // past the cap is the cap, never the default: a long digit string, and one too long for a number (Infinity)
  for (const h of ["99999999999", "9".repeat(400), "Fri, 31 Dec 9999 23:59:59 GMT"]) assert.equal(retryAfterMs(h, now), 10_000, h.slice(0, 20));
});

test("the helper's 429 is a failed round on both chains: the reader waits its Retry-After and reads again", () => onTestClock(async () => {
  // the first call of each route draws a 429 with Retry-After 4: the next round waits 4 s, past the pace's 3 s
  const sol = stubFetch("https://r429-sol.example", (m, id, n) => (n === 1 ? too("4") : solOk(m, id)));
  const evm = stubFetch("https://r429-evm.example", (m, id, n) => (n === 1 ? too("4") : evmOk(m, id)));
  const t0 = Date.now();
  let s: Awaited<ReturnType<HoldingsReader["read"]>> | undefined, e: typeof s;
  try {
    await Promise.all([
      (async () => { s = await solanaHelperHoldings("https://r429-sol.example").read(solW(0)); })(),
      (async () => { e = await evmHelperHoldings("https://r429-evm.example", "base", []).read(evmW(L, 0)); })(),
    ]);
  } finally {
    evm.restore();
    sol.restore();
  }
  const took = Date.now() - t0;
  assert.ok(took >= 3_990 && took < 6_000, `Retry-After 4 is a 4 s wait: ${took} ms`);
  assert.equal(s!.native, 0n);
  assert.equal(e!.native, 0n);
  assert.equal(sol.starts.length, 6, "two rounds of three");
  assert.ok(sol.starts[3]![0] - sol.starts[0]![0] >= 3_990, "Solana's second round after the wait");
  assert.deepEqual(evm.starts.map(([, m]) => m), ["eth_getBlockByNumber", "eth_getBlockByNumber", "eth_getBalance"]);
  assert.ok(evm.starts[1]![0] - evm.starts[0]![0] >= 3_990, "EVM's second round after the wait");
  // no Retry-After: the default wait
  const bare = stubFetch("https://r429-bare.example", (m, id, n) => (n === 1 ? too() : evmOk(m, id)));
  try {
    await evmHelperHoldings("https://r429-bare.example", "base", []).read(evmW(L, 0));
  } finally {
    bare.restore();
  }
  const w = bare.starts[1]![0] - bare.starts[0]![0];
  assert.ok(w >= RETRY_AFTER_DEFAULT_MS - 10 && w < 2_000, `no Retry-After waits 1 s: ${w} ms`);
}));

test("a 429 on every round is a refusal at the bound, after a growing wait between rounds; another HTTP status fails at once", async () => {
  // each reader on a provider of its own (a reader's gate is its rpc's); the waits grow from the route's Retry-After
  // (1234), doubled by the gate's rule (card signpage-throttled-read-is-not-asked-again-at-once), never a flat one
  // (a gate on a clock that only its reader's waits move, so each wait is the rule's exactly)
  const always429 = (): JsonRpc => async () => { throw new Error("HTTP 429"); };
  const waits: number[] = [];
  const opts = { wait429: () => 1234, sleep: async (ms: number) => void waits.push(ms) };
  const own = () => {
    let t = 0;
    return { wait429: () => 1234, sleep: async (ms: number) => void (waits.push(ms), (t += ms)), gate: new ThrottleGate({ now: () => t }) };
  };
  // Solana: the gate's own bound comes first (card wallets-found-in-one-read: a provider in doubt for
  // HOLDINGS_THROTTLE_MAX_MS on the gate's clock is not waited: 18.5 s of waits, then a 10 s one would end at 28.5 s, the
  // next past 30 s); EVM's 4 rounds come before it
  const runs = [
    // the refusal as the kit's transport fault (card pool-sell-legs-side-by-side: a sale counts it as the provider's)
    ["sol", solanaHoldingsReader(always429(), own()), "its reads drew the provider's 429 past 30 s (http_429, 1 try at the holdings route)", [1234, 2468, 4936, 9872, 10_000]],
    ["evm", evmHoldingsReader(always429(), [], own()), `its reads drew the helper's 429 in ${EVM_HOLDINGS_ROUNDS} rounds`, [1234, 2468, 4936]],
  ] as const;
  for (const [chain, reader, error, want] of runs) {
    waits.length = 0;
    const r = await buyWallets(SEED, [{ id: chain, chain, spent: [{ ref: chain === "sol" ? DEP : { kind: "deposit", s: EVM_SCOPE, i: 0 }, label: L }], reader }]);
    assert.deepEqual(r.failed, [{ pool: chain, error: `wallet 0: ${error}` }], chain);
    assert.deepEqual(waits, want, `${chain}: a growing wait between rounds, none after the last`);
  }
  // a 429 in a later round, after reads at different slots, is still a failed round and the next reads again
  let n = 0;
  const late: Edit = (m, o, p) => {
    n++;
    const min = (p[p.length - 1] as { minContextSlot?: number }).minContextSlot;
    if (min === undefined && m === "getBalance") return { ...(o as object), context: { slot: 499 } };
    if (min !== undefined && n <= 6) throw new Error("HTTP 429");
    return o;
  };
  waits.length = 0;
  const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [{ ref: DEP, label: L }], reader: solanaHoldingsReader(solRpc(solChain(), late), own()) }]);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(waits, [1234]);
  for (const [chain, reader] of [["sol", solanaHoldingsReader(async () => { throw new Error("HTTP 503"); }, opts)], ["evm", evmHoldingsReader(async () => { throw new Error("HTTP 503"); }, [], opts)]] as const) {
    waits.length = 0;
    const f = await buyWallets(SEED, [{ id: chain, chain, spent: [{ ref: chain === "sol" ? DEP : { kind: "deposit", s: EVM_SCOPE, i: 0 }, label: L }], reader }]);
    assert.match(f.failed[0]!.error, /^wallet 0: (getBalance|getTokenAccountsByOwner|eth_getBlockByNumber): http 503$/, chain);
    assert.deepEqual(waits, [], chain);
  }
});

// ---- card wallet-rpc-hex-case: an RPC's hex in either case ----

/** robinhood-testnet.drpc.org's case (eth_chainId "0xB626", read 3 Nov 23:07Z): every hex digit upper-cased, "0x" kept. */
const upperHex = (v: unknown): unknown =>
  typeof v === "string" && /^0x[0-9a-f]+$/.test(v) ? `0x${v.slice(2).toUpperCase()}`
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, upperHex(x)]))
  : v;

test("EVM: an upper-case provider reads as lower case (the block's hash is sent back lower-cased); a \"0X\" prefix or a digit that is not hex is refused", async () => {
  // block 11: its hash and number carry letters (…0b, 0xb)
  const c = (): EvmChain => ({ blocks: [...Array(11).fill({ wei: new Map(), tokens: new Map() }), evmState()] });
  const want = await evmReader(c()).read(evmW(L, 0));
  assert.deepEqual(view(want), [123n, { [USDC]: 1_000_000n, [TOKEN_X]: 0n }, []]);
  log.length = 0;
  assert.deepEqual(view(await evmReader(c(), (_m, o) => upperHex(o)).read(evmW(L, 0))), view(want));
  for (const [m, p] of log.slice(1)) assert.ok(p.endsWith(`{"blockHash":"${hashOf(11)}"}]`), `${m} at the block read, lower-cased`);
  const bad = (method: string, f: (o: string) => string): Edit => (m, o) => (m === method && typeof o === "string" ? f(o) : m === method ? { ...(o as object), number: f((o as { number: string }).number) } : o);
  await assert.rejects(evmReader(c(), bad("eth_getBlockByNumber", (n) => n.replace("0x", "0X"))).read(evmW(L, 0)), /eth_getBlockByNumber: not a block/);
  await assert.rejects(evmReader(c(), bad("eth_getBalance", (n) => n.replace("0x", "0X"))).read(evmW(L, 0)), /eth_getBalance: not a quantity/);
  await assert.rejects(evmReader(c(), bad("eth_getBalance", () => "0x7G")).read(evmW(L, 0)), /eth_getBalance: not a quantity/);
  await assert.rejects(evmReader(c(), bad("eth_call", (n) => n.replace("0x", "0X"))).read(evmW(L, 0)), /not one 32-byte word/);
});

// card pool-sell-share-across-wallets (its 5-wallet devnet run): the kit's own JSON-RPC client, past its retry, throws a
// provider's throttle as a SolanaRpcTransportError ("HTTP 429 (http_429, 1 try at <host>)", or a -32029 in a 200); one
// such 429 on the testnet build's devnet RPC failed every sell's wallet list. Each is a failed round like the helper's,
// read again after the provider's own Retry-After when it is the longer wait (capped)
test("a throttle as the kit's JSON-RPC client throws it (HTTP 429, or -32029 in a 200) is a failed round on both chains: read again after its Retry-After", async () => {
  for (const [what, status, body, header, want] of [
    ["HTTP 429, Retry-After 4", 429, "slow down", "4", 4_000],
    ["HTTP 429, Retry-After 60 (capped)", 429, "slow down", "60", RETRY_AFTER_MAX_MS],
    ["-32029 in a 200, no Retry-After", 200, null, null, 1234],
  ] as const) {
    for (const chain of ["sol", "evm"] as const) {
      // the kit's own client, its fetch answering the throttle until the reader's first wait (each call's retry gives up:
      // a 429's Retry-After is past its deadline at once; the -32029's next backoff after two tries, 60 ms apart)
      let slept = false;
      const fetch = (async (_u: string, init: RequestInit) => {
        const { id } = JSON.parse(String(init.body)) as { id: string };
        if (!slept) return new Response(body ?? JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32029, message: "rate limited" } }), { status, headers: header === null ? {} : { "retry-after": header } });
        const m = (JSON.parse(String(init.body)) as { method: string }).method;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: chain === "sol" ? (m === "getBalance" ? { context: { slot: 5 }, value: 1 } : { context: { slot: 5 }, value: [] }) : m === "eth_getBlockByNumber" ? { number: "0x5", hash: "0x" + "ab".repeat(32) } : "0x0" }), { status: 200 });
      }) as never;
      const rpc = solanaJsonRpc("https://throttle.invalid", { fetch, retry: { deadlineMs: 100, backoffMs: 60 } });
      const waits: number[] = [];
      let t = 0; // the gate's clock: only the reader's waits move it
      const opts = { wait429: () => 1234, sleep: async (ms: number) => { slept = true; waits.push(ms); t += ms; }, gate: new ThrottleGate({ now: () => t }) };
      const reader = chain === "sol" ? solanaHoldingsReader(rpc, opts) : evmHoldingsReader(rpc, [], opts);
      const r = await buyWallets(SEED, [{ id: chain, chain, spent: [{ ref: chain === "sol" ? DEP : { kind: "deposit", s: EVM_SCOPE, i: 0 }, label: L }], reader }]);
      assert.deepEqual(r.failed, [], `${what}, ${chain}`);
      assert.deepEqual(waits, [Math.max(1234, want)], `${what}, ${chain}`);
    }
  }
});

// re-review of 29c72ffe: only a throttle is a failed round; the kit's own client's 5xx or timeout, past its retry, is the
// list's refusal at once, with no wait
test("the kit's JSON-RPC client's 5xx or timeout past its retry refuses the wallet list at once on both chains, with no wait", async () => {
  const hang = (async (_u: string, init: RequestInit) =>
    new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(init.signal!.reason)))) as never;
  const five = (async () => new Response("down", { status: 503 })) as never;
  for (const [what, fetch, want] of [["HTTP 503", five, /http 503/], ["a timeout", hang, /the call failed/]] as const) {
    for (const chain of ["sol", "evm"] as const) {
      const rpc = solanaJsonRpc("https://down.invalid", { fetch, timeoutMs: 20, retry: { deadlineMs: 60, backoffMs: 20 } });
      const waits: number[] = [];
      const opts = { wait429: () => 1234, sleep: async (ms: number) => void waits.push(ms) };
      const reader = chain === "sol" ? solanaHoldingsReader(rpc, opts) : evmHoldingsReader(rpc, [], opts);
      const r = await buyWallets(SEED, [{ id: chain, chain, spent: [{ ref: chain === "sol" ? DEP : { kind: "deposit", s: EVM_SCOPE, i: 0 }, label: L }], reader }]);
      assert.equal(r.failed.length, 1, `${what}, ${chain}`);
      assert.match(r.failed[0]!.error, want, `${what}, ${chain}`);
      assert.deepEqual(waits, [], `${what}, ${chain}: no wait`);
    }
  }
});

// Card sell-right-after-a-buy, item 6 (a measure, no fix): a sale's wallet list (signpage pool-testnet.ts sellHost.wallets
// -> poolBuyWallets -> buyWallets) reads every W the pool's spent notes paid, one after another (readDerived), each W one
// round of three calls on the helper's route, paced at HOLDINGS_RPC_LIMIT (one round in 3 s). So its time grows with the
// past buys: about (N - 1) x 3 s for N Ws, with every answer at its first try (one round a W).
test("item 6: a sale's wallet list on the mainnet pace: one finder round per past W, (N - 1) x HOLDINGS_RPC_LIMIT.windowMs for N Ws (1, 5, 20)", () => onTestClock(async () => {
  const got: Record<number, { rounds: number; ms: number }> = {};
  for (const n of [1, 5, 20]) {
    const sol = stubFetch(`https://pace-many-${n}.example`, (m, id) => solOk(m, id));
    try {
      const reader = solanaHelperHoldings(`https://pace-many-${n}.example`);
      const spent = Array.from({ length: n }, (_, i) => ({ ref: { ...DEP, i } as NoteRef, label: L + BigInt(i) }));
      const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent, reader }]);
      assert.deepEqual(r.failed, []);
      assert.equal(r.wallets.length, n);
      // from the first round's start to the last's, as the stub logged them on the test clock
      got[n] = { rounds: rounds(sol.starts).length, ms: sol.starts.at(-1)![0] - sol.starts[0]![0] };
    } finally {
      sol.restore();
    }
  }
  console.log(`item 6: ${JSON.stringify(got)}`);
  for (const n of [1, 5, 20]) {
    assert.equal(got[n]!.rounds, n, `${n} Ws: one round each`);
    assert.ok(got[n]!.ms >= (n - 1) * HOLDINGS_RPC_LIMIT.windowMs && got[n]!.ms < (n - 1) * HOLDINGS_RPC_LIMIT.windowMs + 1_000, `${n} Ws: ${got[n]!.ms} ms from the first round to the last`);
  }
}));

// ---------- a W's buy from its own history (card restore-rebuilds-buy-records) ----------
import { SOL_BUY_PAGE, SOL_BUY_PAGES, SOL_BUY_TXS, solanaBuyIn, solanaBuyReader, solanaHelperBuys, solanaReleaseIn } from "../src/pool/buy-wallets.ts";

const BUY_POOL = key32(40), FEE_PAYER = key32(41), STRANGER_KEY = key32(42), VENUE = key32(43);
const WSOL = "So11111111111111111111111111111111111111112";
const tb = (accountIndex: number, mint: string, owner: string, amount: bigint, programId = SOLANA_TOKEN_PROGRAM) => ({ accountIndex, mint, owner, programId, uiTokenAmount: { amount: amount.toString(), decimals: 6 } });
/** A transaction as getTransaction's json answer has it. `signers` the keys that sign, first; tag 3 to `pool` naming `to`. */
function txOf(o: { signers: string[]; keys?: string[]; ix?: { program: string; to: string; tag: number }[]; pre?: unknown[]; post?: unknown[]; err?: unknown }) {
  const keys = [...o.signers, ...(o.keys ?? []), BUY_POOL, VENUE];
  const at = (k: string) => (keys.includes(k) ? keys.indexOf(k) : keys.push(k) - 1);
  const instructions = (o.ix ?? []).map((x) => ({ programIdIndex: at(x.program), accounts: [at(BUY_POOL), at(x.to), at(FEE_PAYER)], data: base58.encode(Uint8Array.of(x.tag, 1, 2, 3)) }));
  return { slot: 9, meta: { err: o.err ?? null, preTokenBalances: o.pre ?? [], postTokenBalances: o.post ?? [] }, transaction: { signatures: o.signers.map(() => "s"), message: { header: { numRequiredSignatures: o.signers.length }, accountKeys: keys, instructions } } };
}
const W = solW(0), W2 = solW(1);
const buyTx = (w = W, mint = MINT_A, program = SOLANA_TOKEN_PROGRAM) => txOf({ signers: [FEE_PAYER, w], ix: [{ program: BUY_POOL, to: w, tag: 3 }], post: [tb(4, mint, w, 5_000_000n, program), tb(5, WSOL, w, 0n)], pre: [tb(5, WSOL, w, 0n)] });

test("a W's buy is read from its own transaction: W signs it, the pinned pool's tag 3 names W, one mint other than wrapped SOL rises in W's accounts", () => {
  assert.deepEqual(solanaBuyIn(buyTx(), W, BUY_POOL), { mint: MINT_A, program: SOLANA_TOKEN_PROGRAM });
  assert.deepEqual(solanaBuyIn(buyTx(W, MINT_B, SOLANA_TOKEN_2022_PROGRAM), W, BUY_POOL), { mint: MINT_B, program: SOLANA_TOKEN_2022_PROGRAM });
  // a stranger's send of a token to W: W does not sign it
  assert.equal(solanaBuyIn(txOf({ signers: [STRANGER_KEY], keys: [W], post: [tb(2, MINT_B, W, 9n)] }), W, BUY_POOL), null, "a stranger's send");
  // a stranger's send dressed as the pool's call: W still does not sign
  assert.equal(solanaBuyIn(txOf({ signers: [STRANGER_KEY], keys: [W], ix: [{ program: BUY_POOL, to: W, tag: 3 }], post: [tb(2, MINT_B, W, 9n)] }), W, BUY_POOL), null, "the pool's call in a stranger's tx");
  // W signs, but no release-and-buy of the pinned pool naming W
  assert.equal(solanaBuyIn(txOf({ signers: [FEE_PAYER, W], ix: [{ program: VENUE, to: W, tag: 3 }], post: [tb(4, MINT_A, W, 5n)] }), W, BUY_POOL), null, "another program");
  assert.equal(solanaBuyIn(txOf({ signers: [FEE_PAYER, W], ix: [{ program: BUY_POOL, to: W, tag: 2 }], post: [tb(4, MINT_A, W, 5n)] }), W, BUY_POOL), null, "a release with no buy");
  assert.equal(solanaBuyIn(txOf({ signers: [FEE_PAYER, W, W2], ix: [{ program: BUY_POOL, to: W2, tag: 3 }], post: [tb(4, MINT_A, W, 5n)] }), W, BUY_POOL), null, "a release to another W");
  assert.equal(solanaBuyIn(buyTx(), W, key32(44)), null, "another pool");
  // what W's accounts show must be one buy
  assert.equal(solanaBuyIn({ ...buyTx(), meta: { ...buyTx().meta, err: { InstructionError: [0, "x"] } } }, W, BUY_POOL), null, "a failed transaction");
  assert.equal(solanaBuyIn(txOf({ signers: [FEE_PAYER, W], ix: [{ program: BUY_POOL, to: W, tag: 3 }], post: [tb(4, MINT_A, W, 5n), tb(6, MINT_B, W, 5n)] }), W, BUY_POOL), null, "two mints rise");
  assert.equal(solanaBuyIn(txOf({ signers: [FEE_PAYER, W], ix: [{ program: BUY_POOL, to: W, tag: 3 }], post: [tb(5, WSOL, W, 5n)] }), W, BUY_POOL), null, "wrapped SOL only");
  assert.equal(solanaBuyIn(txOf({ signers: [FEE_PAYER, W], ix: [{ program: BUY_POOL, to: W, tag: 3 }], post: [tb(4, MINT_A, STRANGER_KEY, 5n)] }), W, BUY_POOL), null, "the token rose in an account W does not own");
  assert.equal(solanaBuyIn(txOf({ signers: [FEE_PAYER, W], ix: [{ program: BUY_POOL, to: W, tag: 3 }], post: [tb(4, MINT_A, W, 5n, VENUE)] }), W, BUY_POOL), null, "not a token program");
  assert.equal(solanaBuyIn(txOf({ signers: [FEE_PAYER, W], ix: [{ program: BUY_POOL, to: W, tag: 3 }], pre: [tb(4, MINT_A, W, 9n)], post: [tb(4, MINT_A, W, 5n)] }), W, BUY_POOL), null, "a sale: the token falls");
  assert.equal(solanaBuyIn(null, W, BUY_POOL), null);
  // the pool's plain release naming W: tag 2 with no tag 3, landed, W a signer
  assert.equal(solanaReleaseIn(txOf({ signers: [FEE_PAYER, W], ix: [{ program: BUY_POOL, to: W, tag: 2 }], post: [] }), W, BUY_POOL), true, "a plain release");
  assert.equal(solanaReleaseIn(buyTx(), W, BUY_POOL), false, "a release and buy is no plain release");
  assert.equal(solanaReleaseIn(txOf({ signers: [FEE_PAYER, W], ix: [{ program: BUY_POOL, to: W, tag: 2 }, { program: BUY_POOL, to: W, tag: 3 }], post: [] }), W, BUY_POOL), false, "a tag 2 beside a tag 3");
  assert.equal(solanaReleaseIn(txOf({ signers: [STRANGER_KEY], keys: [W], ix: [{ program: BUY_POOL, to: W, tag: 2 }], post: [] }), W, BUY_POOL), false, "a stranger's tx dressed as one");
  assert.equal(solanaReleaseIn({ ...buyTx(), meta: { ...buyTx().meta, err: { x: 1 } } }, W, BUY_POOL), false, "failed");
  assert.equal(solanaReleaseIn(txOf({ signers: [FEE_PAYER, W], ix: [{ program: BUY_POOL, to: W, tag: 1 }], post: [] }), W, BUY_POOL), false, "another tag");
  assert.equal(solanaReleaseIn(txOf({ signers: [FEE_PAYER, W], ix: [{ program: VENUE, to: W, tag: 2 }], post: [] }), W, BUY_POOL), false, "another program");
});

/** A fake route of W's history: its signatures newest first, each with its transaction; every request logged. */
function historyRpc(hist: Map<string, { sigs: { signature: string; err: unknown }[]; txs: Map<string, unknown> }>) {
  const log: { method: string; params: unknown[] }[] = [];
  const rpc = (async (method: string, params: readonly unknown[]) => {
    log.push({ method, params: [...params] });
    if (method === "getSignaturesForAddress") {
      const h = hist.get(params[0] as string);
      const o = params[1] as { limit: number; before?: string };
      const all = h?.sigs ?? [];
      const from = o.before === undefined ? 0 : all.findIndex((x) => x.signature === o.before) + 1;
      return all.slice(from, from + o.limit);
    }
    if (method === "getTransaction") {
      for (const h of hist.values()) if (h.txs.has(params[0] as string)) return h.txs.get(params[0] as string);
      return null;
    }
    throw new Error(`unexpected ${method}`);
  }) as unknown as SolanaRpc;
  return { rpc, log };
}

test("a W's buy from its history: its oldest successful transactions, past a failed try and a stranger's send that came first; every request names one W or one signature", async () => {
  const hist = new Map([
    // newest first: a sale, a stranger's send, the buy, a stranger's send before it (W named by a failed try), the failed try
    [W, { sigs: [{ signature: "sell", err: null }, { signature: "drop2", err: null }, { signature: "buy", err: null }, { signature: "drop1", err: null }, { signature: "try", err: { x: 1 } }], txs: new Map<string, unknown>([["buy", buyTx()], ["drop1", txOf({ signers: [STRANGER_KEY], keys: [W], post: [tb(2, MINT_B, W, 9n)] })], ["drop2", txOf({ signers: [STRANGER_KEY], keys: [W], post: [tb(2, MINT_B, W, 9n)] })]]) }],
    [W2, { sigs: [{ signature: "drop3", err: null }], txs: new Map<string, unknown>([["drop3", txOf({ signers: [STRANGER_KEY], keys: [W2], post: [tb(2, MINT_B, W2, 9n)] })]]) }],
  ]);
  const { rpc, log } = historyRpc(hist);
  const r = solanaBuyReader(rpc, BUY_POOL);
  assert.deepEqual(await r.read(W), { mint: MINT_A, program: SOLANA_TOKEN_PROGRAM });
  assert.deepEqual(log.map((l) => `${l.method} ${String(l.params[0]).slice(0, 5)}`), [`getSignaturesForAddress ${W.slice(0, 5)}`, "getTransaction drop1", "getTransaction buy"], "the failed try is not read; the oldest successful first");
  // a W whose history holds only a stranger's send: no buy
  assert.equal(await r.read(W2), null, "a stranger's token is no buy");
  for (const l of log) {
    const body = JSON.stringify(l.params);
    assert.ok(!(body.includes(W) && body.includes(W2)), "no request names two Ws");
  }
});

test("a W's history the reader cannot tell is no buy: none at all, a listed transaction the route no longer returns (the read ends there, a buy after it unread), past SOL_BUY_PAGES pages, no pool release read; the pool's release with no buy is final", async () => {
  const drop = (n: number) => ({ signature: `drop${n}`, err: null });
  const dropTx = txOf({ signers: [STRANGER_KEY], keys: [W], post: [tb(2, MINT_B, W, 9n)] });
  const cases: [string, { sigs: { signature: string; err: unknown }[]; txs: Map<string, unknown> }, number][] = [
    ["no history", { sigs: [], txs: new Map() }, 1],
    ["pruned", { sigs: [{ signature: "buy", err: null }], txs: new Map() }, 2],
    // review of 42a99f81 (b): a pruned transaction ends the read; one skipped would read the buy after it
    ["pruned before a buy", { sigs: [{ signature: "buy", err: null }, { signature: "gone", err: null }], txs: new Map<string, unknown>([["buy", buyTx()]]) }, 2],
    ["fewer than SOL_BUY_TXS, none a buy", { sigs: Array.from({ length: SOL_BUY_TXS - 1 }, (_, i) => drop(i)), txs: new Map<string, unknown>(Array.from({ length: SOL_BUY_TXS - 1 }, (_, i) => [`drop${i}`, dropTx] as [string, unknown])) }, SOL_BUY_TXS],
    ["SOL_BUY_TXS sends, one pruned", { sigs: Array.from({ length: SOL_BUY_TXS }, (_, i) => drop(i)), txs: new Map<string, unknown>(Array.from({ length: SOL_BUY_TXS - 1 }, (_, i) => [`drop${i}`, dropTx] as [string, unknown])) }, 2],
    ["past the pages", { sigs: [...Array.from({ length: SOL_BUY_PAGE * SOL_BUY_PAGES }, (_, i) => drop(i)), { signature: "buy", err: null }], txs: new Map<string, unknown>([["buy", buyTx()]]) }, SOL_BUY_PAGES],
  ];
  for (const [what, h, calls] of cases) {
    const { rpc, log } = historyRpc(new Map([[W, h]]));
    assert.equal(await solanaBuyReader(rpc, BUY_POOL).read(W), null, what);
    assert.equal(log.length, calls, `${what}: ${log.length} calls`);
  }
  // review of ae2cfe28, P2: "none" only once the pool's release naming W is read and holds no buy (W's note spent). A
  // buy that failed on chain names W, so sends may come before the retry's buy: read past them, up to SOL_BUY_TXS
  const sends = (n: number) => ({ sigs: Array.from({ length: n }, (_, i): { signature: string; err: unknown } => drop(i)), txs: new Map<string, unknown>(Array.from({ length: n }, (_, i) => [`drop${i}`, dropTx] as [string, unknown])) });
  const after = (h: ReturnType<typeof sends>, sig: string, tx: unknown) => ({ sigs: [{ signature: sig, err: null }, ...h.sigs], txs: new Map<string, unknown>([[sig, tx], ...h.txs]) });
  const plainRelease = txOf({ signers: [FEE_PAYER, W], ix: [{ program: BUY_POOL, to: W, tag: 2 }], post: [] });
  const readOf = async (h: ReturnType<typeof sends>) => {
    const { rpc, log } = historyRpc(new Map([[W, h]]));
    return { got: await solanaBuyReader(rpc, BUY_POOL).read(W), calls: log.length };
  };
  // a failed buy, then four sends, then the retry's buy: its record back
  const failedFirst = after({ sigs: [...sends(4).sigs, { signature: "failed", err: { x: 1 } }], txs: sends(4).txs }, "buy", buyTx());
  assert.deepEqual(await readOf(failedFirst), { got: { mint: MINT_A, program: SOLANA_TOKEN_PROGRAM }, calls: 1 + 5 }, "four sends then the buy");
  // no pool release among those read: null, never "none" (SOL_BUY_TXS sends; a provider's list cut short of the release)
  assert.deepEqual(await readOf(sends(SOL_BUY_TXS)), { got: null, calls: 1 + SOL_BUY_TXS }, "SOL_BUY_TXS sends, no release");
  assert.deepEqual(await readOf(sends(2)), { got: null, calls: 3 }, "a shortened list");
  assert.deepEqual(await readOf(after(sends(SOL_BUY_TXS), "buy", buyTx())), { got: null, calls: 1 + SOL_BUY_TXS }, "the buy past the bound");
  // the pool's plain release naming W, after two sends: W's note spent with no buy, for good
  assert.deepEqual(await readOf(after(sends(2), "release", plainRelease)), { got: "none", calls: 1 + 3 }, "the release, no buy");
  // review of 0430db23, P2: a landed tag 3 always ran its buy, so one whose buy is not read is no answer, never "none"
  const tag3 = (post: unknown[] | undefined, pre: unknown[] = []) => {
    const t = txOf({ signers: [FEE_PAYER, W], ix: [{ program: BUY_POOL, to: W, tag: 3 }], pre, post: post ?? [] });
    return post === undefined ? { ...t, meta: { err: null, preTokenBalances: pre } } : t;
  };
  const { owner: _o, ...noOwner } = tb(4, MINT_A, W, 5n);
  const { programId: _p, ...noProgram } = tb(4, MINT_A, W, 5n);
  for (const [what, tx] of [
    ["no owner", tag3([noOwner])],
    ["no programId", tag3([noProgram])],
    ["no postTokenBalances", tag3(undefined)],
    ["two mints rise", tag3([tb(4, MINT_A, W, 5n), tb(6, MINT_B, W, 5n)])],
  ] as const) {
    assert.equal(solanaBuyIn(tx, W, BUY_POOL), null, `${what}: no buy read`);
    assert.deepEqual(await readOf(after(sends(1), "t3", tx)), { got: null, calls: 1 + 2 }, `${what}: a landed tag 3 unread is no answer`);
  }
  // the read stops at that tag 3: W's one note is spent there, so nothing after it is read
  const later = after(after(sends(1), "t3", tag3(undefined)), "drop9", dropTx);
  assert.deepEqual(await readOf(later), { got: null, calls: 1 + 2 }, "nothing read past the release");
  // within the pages: the buy past a full first page is found
  const long = new Map([[W, { sigs: [...Array.from({ length: SOL_BUY_PAGE + 2 }, (_, i) => drop(i)).map((x, i) => (i === SOL_BUY_PAGE + 1 ? { signature: "buy", err: null } : x))], txs: new Map<string, unknown>([["buy", buyTx()]]) }]]);
  const l2 = historyRpc(long);
  assert.deepEqual(await solanaBuyReader(l2.rpc, BUY_POOL).read(W), { mint: MINT_A, program: SOLANA_TOKEN_PROGRAM }, "a second page read");
  assert.deepEqual(l2.log.map((l) => l.method), ["getSignaturesForAddress", "getSignaturesForAddress", "getTransaction"]);
});

// Review of 42a99f81 (c): each buy read's call is a round of its gate, and its answer clears the gate's doubt, as the
// finder's round does; without it the gate stays in doubt after a 429 however many reads go through since
test("a buy read's answer clears its gate's doubt after a 429", async () => {
  let t = 0;
  const gate = new ThrottleGate({ now: () => t });
  let n = 0;
  const { rpc: good } = historyRpc(new Map([[W, { sigs: [], txs: new Map() }]]));
  const rpc = (async (m: string, p: readonly unknown[]) => (++n === 1 ? Promise.reject(new Error("HTTP 429")) : good(m, p))) as unknown as SolanaRpc;
  const r = solanaBuyReader(rpc, BUY_POOL, { gate, sleep: async (ms) => void (t += ms) });
  await assert.rejects(r.read(W));
  assert.equal(gate.suspect(), true, "the 429 counted");
  assert.equal(await r.read(W), null);
  assert.equal(gate.suspect(), false, "the next read's answer cleared the doubt");
});

// Review of ae2cfe28, P3: the doubt clears on a whole read, not on one call's answer. A provider that throttles
// getTransaction alone while it answers getSignaturesForAddress stays in doubt from its first 429, so past the bound
// the reads are refused without asking; a clear at each answer restarted the doubt at every W and asked it forever
test("a provider throttling getTransaction alone stays in doubt across Ws, and past the bound is refused without asking", async () => {
  let t = 0;
  const gate = new ThrottleGate({ now: () => t });
  const asked: string[] = [];
  const rpc = (async (m: string) => {
    asked.push(m);
    return m === "getSignaturesForAddress" ? [{ signature: "s", err: null }] : Promise.reject(new Error("HTTP 429"));
  }) as unknown as SolanaRpc;
  const r = solanaBuyReader(rpc, BUY_POOL, { gate, sleep: async (ms) => void (t += ms) });
  for (let i = 0; i < 12; i++) await r.read(W).catch(() => {});
  assert.ok(gate.doubtMs() > 0, "in doubt");
  assert.ok(gate.doubtMs() >= t - 10_000, `the doubt runs from the first 429: ${gate.doubtMs()} of ${t} ms`);
  const before = asked.length;
  await assert.rejects(r.read(W), /429/);
  assert.equal(asked.length, before, "past the bound: refused without asking");
});

// Review of 42a99f81, P2: the buy reads share the finder's paced queue on the helper (one budget at the provider) but
// never its gate. A 429 the rebuild met (the helper throttling the history methods) paused the finder's next read for
// its Retry-After, so a sale's wallet list waited behind it, or was refused
test("a 429 on a buy read pauses the buy reads only: the finder's next read on the same route goes at the queue's pace, and the next buy read waits the Retry-After", () => onTestClock(async () => {
  const origin = "https://buy-gate.example";
  const st = stubFetch(origin, (m, id) => (m === "getSignaturesForAddress" ? too("10") : m === "getTransaction" ? ok(id, null) : solOk(m, id)));
  let at429 = 0, finderAt = 0;
  try {
    await assert.rejects(solanaHelperBuys(origin, BUY_POOL).read(W));
    at429 = st.starts.findLast(([, m]) => m === "getSignaturesForAddress")![0];
    const before = st.starts.length;
    await solanaHelperHoldings(origin).read(solW(1));
    finderAt = st.starts[before]![0];
    const sigs = st.starts.filter(([, m]) => m === "getSignaturesForAddress").length;
    await assert.rejects(solanaHelperBuys(origin, BUY_POOL).read(W));
    const next = st.starts.filter(([, m]) => m === "getSignaturesForAddress")[sigs]![0];
    assert.ok(next - at429 >= 9_990, `the next buy read waits its own gate's Retry-After: ${next - at429} ms`);
  } finally {
    st.restore();
  }
  assert.ok(finderAt - at429 <= HOLDINGS_RPC_LIMIT.windowMs + 10, `the finder's read is not held by the buy reads' 429: ${finderAt - at429} ms`);
  assert.equal(hostLane(`${origin}/v1/rpc/solana`).gate.left(), 0, "nor the host's lane");
}));

// Review of 42a99f81 (b): each buy read's call takes the host's pass turn (inTurn's lane), as the finder's rounds do, so
// a trade's reads go first: with the page's window full, the read waits for room
test("a buy read's calls are held by the host's pass budget: with the page's window full, the read waits for room", () => onTestClock(async () => {
  const origin = "https://buy-lane.example";
  const st = stubFetch(origin, (m, id) => (m === "getSignaturesForAddress" ? ok(id, []) : solOk(m, id)));
  try {
    const lane = hostLane(`${origin}/v1/rpc/solana`);
    for (let i = 0; i < PASS_BUDGET; i++) lane.count();
    const t0 = Date.now();
    assert.equal(await solanaHelperBuys(origin, BUY_POOL).read(W), null);
    assert.ok(st.starts[0]![0] - t0 >= 9_000, `${st.starts[0]![0] - t0} ms`);
  } finally {
    st.restore();
  }
}));
