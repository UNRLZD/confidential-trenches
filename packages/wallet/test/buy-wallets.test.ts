// node --test packages/wallet/test/buy-wallets.test.ts (card wallet-per-buy; plan v2 W3): from the 12 words alone a
// restore finds every Solana and EVM wallet a buy used, and what each one still holds, each W's reads at one state.
// The chains are fakes; the seed is the all-zero entropy of vectors/a8.json, whose W addresses the restore must give.
// Every request is logged, so a test checks no request names two of the user's wallets.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { HDKey } from "@scure/bip32";
import { base58, base64 } from "@scure/base";
import { SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, type SolanaRpc } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, refKey, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";
import { buyWallets, evmHelperHoldings, evmHoldingsReader, SOL_HOLDINGS_ROUNDS, solanaHelperHoldings, solanaHoldingsReader, solanaSpentNotes, spentNotesOf, type BuyPool, type HoldingsReader, type JsonRpc } from "../src/pool/buy-wallets.ts";

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
const solReader = (c: SolChain = solChain(), e?: Edit): HoldingsReader => solanaHoldingsReader(solRpc(c, e));
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
  // every W a pool pays comes from freshWallet, called where the queue proves and where a restore lists it
  const calls = files.filter((f) => /\bfreshWallet\s*\(/.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length)).sort();
  assert.deepEqual(calls, ["packages/wallet/src/derive/keys.ts", "packages/wallet/src/pool/buy-wallets.ts", "packages/wallet/src/pool/queue.ts", "packages/wallet/src/pool/solana-restore.ts"]);
});
