// node --test packages/wallet/test/buy-wallets.test.ts (card wallet-per-buy; plan v2 W3): from the 12 words alone a
// restore finds every Solana and EVM wallet a buy used, and what each one still holds, read on two providers that must
// agree. The chains are fakes; the seed is the all-zero entropy of vectors/a8.json, whose W addresses the restore must
// give. Every request is logged, so a test checks no request names two of the user's wallets.
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
import { buyWallets, evmHoldingsReader, solanaHoldingsReader, solanaSpentNotes, spentNotesOf, type BuyPool, type EvmRpc, type HoldingsReader } from "../src/pool/buy-wallets.ts";

const A8 = JSON.parse(readFileSync(new URL("./vectors/a8.json", import.meta.url), "utf8")) as { inputs: { entropy: string }; l: string; wallets: { name: string; c: string; l: string; j: number; path: string; address: string }[] };
const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(Buffer.from(A8.inputs.entropy, "hex"))));
const L = BigInt(`0x${A8.l}`);
const L2 = 77n; // another label: an EVM note of its own
const vec = (c: string, j: number): string => A8.wallets.find((w) => w.c === c && w.j === j && w.l === A8.l)!.address;
const SOL_SCOPE = 1001n, EVM_SCOPE = 2002n, OTHER_SCOPE = 3003n;
const key32 = (k: number): string => base58.encode(new Uint8Array(32).fill(k));
const MINT_A = key32(7), MINT_B = key32(8);
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", TOKEN_X = "0x00000000000000000000000000000000000000aa";

// ---------- fake chains ----------
type SolAcct = { pubkey: string; program: string; mint: string; owner: string; amount: bigint; state?: number };
type SolChain = { lamports: Map<string, unknown>; accounts: SolAcct[] };
function tokenData(a: SolAcct): string {
  const b = new Uint8Array(165);
  b.set(base58.decode(a.mint), 0);
  b.set(base58.decode(a.owner), 32);
  new DataView(b.buffer).setBigUint64(64, a.amount, true);
  b[108] = a.state ?? 1;
  return base64.encode(b);
}
function solRpc(c: SolChain, url: string, log: string[][], edit: (method: string, out: unknown) => unknown = (_m, o) => o): SolanaRpc {
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    log.push([method, JSON.stringify(params)]);
    const owner = params[0] as string;
    if (method === "getBalance") return edit(method, { context: { slot: 9 }, value: c.lamports.get(owner) ?? 0 });
    if (method === "getTokenAccountsByOwner") {
      const program = (params[1] as { programId: string }).programId;
      const value = c.accounts.filter((a) => a.owner === owner && a.program === program).map((a) => ({ pubkey: a.pubkey, account: { owner: a.program, lamports: 2_039_280, executable: false, data: [tokenData(a), "base64"] } }));
      return edit(method, { context: { slot: 9 }, value });
    }
    throw new Error(`fake solana: ${method}`);
  };
  return Object.assign(f, { url });
}
type EvmChain = { wei: Map<string, bigint>; tokens: Map<string, Map<string, bigint>> };
function evmRpc(c: EvmChain, url: string, log: string[][], edit: (method: string, out: unknown) => unknown = (_m, o) => o): EvmRpc {
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    log.push([method, JSON.stringify(params)]);
    assert.equal(params[params.length - 1], "finalized");
    if (method === "eth_getBalance") return edit(method, `0x${(c.wei.get(params[0] as string) ?? 0n).toString(16)}`);
    if (method === "eth_call") {
      const { to, data } = params[0] as { to: string; data: string };
      assert.equal(data.slice(0, 10), "0x70a08231");
      const who = `0x${data.slice(-40)}`;
      return edit(method, `0x${(c.tokens.get(to)?.get(who) ?? 0n).toString(16).padStart(64, "0")}`);
    }
    throw new Error(`fake evm: ${method}`);
  };
  return Object.assign(f, { url });
}

const solW = (j: number) => vec("sol", j);
const evmW = (l: bigint, j: number) => { const w = d.freshWallet(SEED, "evm", l, j); w.secretKey.fill(0); return w.address; };
function chains() {
  const sol: SolChain = {
    lamports: new Map([[solW(0), 5_000_000], [solW(1), 0]]),
    accounts: [
      { pubkey: key32(20), program: SOLANA_TOKEN_PROGRAM, mint: MINT_A, owner: solW(0), amount: 100n },
      { pubkey: key32(21), program: SOLANA_TOKEN_PROGRAM, mint: MINT_A, owner: solW(0), amount: 23n },
      { pubkey: key32(22), program: SOLANA_TOKEN_2022_PROGRAM, mint: MINT_B, owner: solW(0), amount: 7n },
      { pubkey: key32(23), program: SOLANA_TOKEN_PROGRAM, mint: MINT_A, owner: key32(99), amount: 1n }, // someone else's
    ],
  };
  const e0 = evmW(L, 0).toLowerCase(), e2 = evmW(L2, 0).toLowerCase();
  const evm: EvmChain = { wei: new Map([[e0, 123n], [e2, 9n]]), tokens: new Map([[USDC, new Map([[e0, 1_000_000n]])], [TOKEN_X, new Map([[e2, 5n]])]]) };
  return { sol, evm };
}
const log: string[][] = [];
const solReaders = (a: SolChain, b: SolChain = a, ea?: Parameters<typeof solRpc>[3], eb?: Parameters<typeof solRpc>[3]): [HoldingsReader, HoldingsReader] => [solanaHoldingsReader(solRpc(a, "https://sol-a.example", log, ea)), solanaHoldingsReader(solRpc(b, "https://sol-b.example", log, eb))];
const evmReaders = (a: EvmChain, b: EvmChain = a, ea?: Parameters<typeof evmRpc>[3], eb?: Parameters<typeof evmRpc>[3]): [HoldingsReader, HoldingsReader] => [evmHoldingsReader(evmRpc(a, "https://evm-a.example", log, ea), [USDC, TOKEN_X]), evmHoldingsReader(evmRpc(b, "https://evm-b.example", log, eb), [USDC, TOKEN_X])];

// ---------- a seeded store ----------
const opened: { w: WalletStore; ns: NoteStore }[] = [];
after(() => { for (const o of opened) (o.ns.close(), o.w.close()); });
async function storeWith(notes: { ref: NoteRef; scope: bigint; label: bigint; spent: boolean }[]): Promise<NoteStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  opened.push({ w, ns });
  for (const [k, n] of notes.entries()) {
    const precommitment = noteSecrets(SEED, n.ref).precommitment;
    const leaf = { value: 10_000_000n, label: n.label, commitment: noteCommitment(10_000_000n, n.label, precommitment), leafIndex: BigInt(k) };
    const r = await ns.add({ ref: n.ref, scope: n.scope, precommitment, state: "UNSPENT", leaf });
    if (n.spent) await ns.move(r.id, "UNSPENT", "SPENT");
  }
  return ns;
}
const SEEDED = [
  { ref: { kind: "deposit", s: SOL_SCOPE, i: 0 }, scope: SOL_SCOPE, label: L, spent: true }, // W_{sol, l, 0}
  { ref: { kind: "change", l: L, j: 0 }, scope: SOL_SCOPE, label: L, spent: true }, // W_{sol, l, 1}
  { ref: { kind: "change", l: L, j: 1 }, scope: SOL_SCOPE, label: L, spent: false }, // unspent: no W yet
  { ref: { kind: "deposit", s: EVM_SCOPE, i: 0 }, scope: EVM_SCOPE, label: L, spent: true }, // W_{evm, l, 0}
  { ref: { kind: "return", c: "evm", l: L, j: 0 }, scope: EVM_SCOPE, label: L2, spent: true }, // W_{evm, L2, 0}
  { ref: { kind: "deposit", s: OTHER_SCOPE, i: 0 }, scope: OTHER_SCOPE, label: L, spent: true }, // a pool not asked
] satisfies { ref: NoteRef; scope: bigint; label: bigint; spent: boolean }[];

test("a seeded store's spent notes on Solana and EVM: each W (the A.8 addresses) and its holdings, read on two providers", async () => {
  const ns = await storeWith(SEEDED);
  const { sol, evm } = chains();
  log.length = 0;
  const pools: BuyPool[] = [
    { id: "sol", chain: "sol", spent: await spentNotesOf(ns, SOL_SCOPE), readers: solReaders(sol) },
    { id: "base", chain: "evm", spent: await spentNotesOf(ns, EVM_SCOPE), readers: evmReaders(evm) },
  ];
  const ws = await buyWallets(SEED, pools);
  assert.deepEqual(ws.map((w) => [w.pool, w.chain, w.l, w.j, w.address]), [
    ["sol", "sol", L, 0, vec("sol", 0)],
    ["sol", "sol", L, 1, vec("sol", 1)],
    ["base", "evm", L, 0, d.toChecksum(vec("evm", 0))],
    ["base", "evm", L2, 0, evmW(L2, 0)],
  ]);
  assert.deepEqual(ws.map((w) => w.note), [refKey(SEEDED[0]!.ref), refKey(SEEDED[1]!.ref), refKey(SEEDED[3]!.ref), refKey(SEEDED[4]!.ref)]);
  assert.equal(ws[0]!.path, A8.wallets.find((w) => w.name === "W_{sol,l,0}")!.path);
  const h = ws.map((w) => [w.holdings.native, Object.fromEntries(w.holdings.tokens)]);
  assert.deepEqual(h, [
    [5_000_000n, { [MINT_A]: 123n, [MINT_B]: 7n }],
    [0n, {}],
    [123n, { [USDC]: 1_000_000n, [TOKEN_X]: 0n }],
    [9n, { [USDC]: 0n, [TOKEN_X]: 5n }],
  ]);
  // every W read on both providers: Solana 3 calls each, EVM 1 + 2 tokens each
  assert.equal(log.length, 2 * (2 * 3 + 2 * 3));
  // privacy: no request names two of the user's wallets, and none names a note's (l, j) or anything but one W
  const mine = ws.map((w) => w.address.toLowerCase().replace(/^0x/, ""));
  for (const [, p] of log) assert.equal(mine.filter((a) => p.toLowerCase().includes(a)).length, 1, p);
});

test("the EVM side takes its spent notes as input: W_{evm,l,1} of change note 0 is the A.8 address", async () => {
  const { evm } = chains();
  const ws = await buyWallets(SEED, [{ id: "base", chain: "evm", spent: [{ ref: { kind: "change", l: L, j: 0 }, label: L }], readers: evmReaders(evm) }]);
  assert.deepEqual(ws.map((w) => [w.j, w.address.toLowerCase(), w.holdings.native]), [[1, vec("evm", 1), 0n]]);
});

test("two providers that disagree on a holding refuse: lamports, a token's amount, a token only one holds, wei, a balanceOf", async () => {
  const ns = await storeWith(SEEDED);
  const solSpent = await spentNotesOf(ns, SOL_SCOPE), evmSpent = await spentNotesOf(ns, EVM_SCOPE);
  const run = (readers: [HoldingsReader, HoldingsReader], chain: "sol" | "evm") => buyWallets(SEED, [{ id: chain, chain, spent: chain === "sol" ? solSpent : evmSpent, readers }]);
  const { sol, evm } = chains();
  const solB = (f: (c: SolChain) => void): SolChain => { const c = chains().sol; f(c); return c; };
  await assert.rejects(run(solReaders(sol, solB((c) => c.lamports.set(solW(0), 5_000_001))), "sol"), /holdings of its W differ/);
  await assert.rejects(run(solReaders(sol, solB((c) => (c.accounts[2]!.amount = 8n))), "sol"), /holdings of its W differ/);
  await assert.rejects(run(solReaders(sol, solB((c) => c.accounts.push({ pubkey: key32(30), program: SOLANA_TOKEN_2022_PROGRAM, mint: key32(31), owner: solW(1), amount: 0n }))), "sol"), /holdings of its W differ/);
  const evmB = (f: (c: EvmChain) => void): EvmChain => { const c = chains().evm; f(c); return c; };
  await assert.rejects(run(evmReaders(evm, evmB((c) => c.wei.set(evmW(L, 0).toLowerCase(), 124n))), "evm"), /holdings of its W differ/);
  await assert.rejects(run(evmReaders(evm, evmB((c) => c.tokens.get(USDC)!.set(evmW(L, 0).toLowerCase(), 1n))), "evm"), /holdings of its W differ/);
  // the same chain on both: no refusal
  assert.equal((await run(solReaders(sol, chains().sol), "sol")).length, 2);
});

test("a hostile provider's answer is refused: another program's or owner's account, an account twice, a bad balance or word", async () => {
  const spent = [{ ref: { kind: "deposit", s: SOL_SCOPE, i: 0 } as NoteRef, label: L }];
  const sol = (edit: Parameters<typeof solRpc>[3], c: SolChain = chains().sol) => buyWallets(SEED, [{ id: "sol", chain: "sol", spent, readers: solReaders(c, chains().sol, edit) }]);
  const accts = (f: (v: { pubkey: string; account: { owner: string } }[]) => void): Parameters<typeof solRpc>[3] => (m, o) => {
    if (m === "getTokenAccountsByOwner") f((o as { value: { pubkey: string; account: { owner: string } }[] }).value);
    return o;
  };
  await assert.rejects(sol(accts((v) => v[0] && (v[0].account.owner = "11111111111111111111111111111111"))), /not an account of the program asked/);
  await assert.rejects(sol(accts((v) => v[0] && v.push(v[0]))), /an account twice/);
  const foreign: Parameters<typeof solRpc>[3] = (m, o) => {
    if (m !== "getTokenAccountsByOwner") return o;
    const v = (o as { value: { pubkey: string; account: { owner: string; data: [string, string] } }[] }).value;
    if (v[0]) v[0].account.data = [tokenData({ pubkey: v[0].pubkey, program: SOLANA_TOKEN_PROGRAM, mint: MINT_A, owner: key32(99), amount: 1n }), "base64"];
    return o;
  };
  await assert.rejects(sol(foreign), /an account of another owner/);
  await assert.rejects(sol((m, o) => (m === "getBalance" ? { context: { slot: 9 }, value: 1.5 } : o)), /getBalance: not a whole number/);
  await assert.rejects(sol((m, o) => (m === "getBalance" ? { context: { slot: 9 }, value: "5" } : o)), /getBalance: not a whole number/);
  await assert.rejects(sol((m, o) => (m === "getTokenAccountsByOwner" ? { context: { slot: 9 } } : o)), /not a list/);

  const espent = [{ ref: { kind: "deposit", s: EVM_SCOPE, i: 0 } as NoteRef, label: L }];
  const evm = (edit: Parameters<typeof evmRpc>[3]) => buyWallets(SEED, [{ id: "base", chain: "evm", spent: espent, readers: evmReaders(chains().evm, chains().evm, edit) }]);
  await assert.rejects(evm((m, o) => (m === "eth_getBalance" ? "0x07b" : o)), /eth_getBalance: not a quantity/);
  await assert.rejects(evm((m, o) => (m === "eth_getBalance" ? 123 : o)), /eth_getBalance: not a quantity/);
  await assert.rejects(evm((m, o) => (m === "eth_call" ? "0x" : o)), /balanceOf on .*: not one 32-byte word/);
  await assert.rejects(evm((m, o) => (m === "eth_call" ? `${o as string}00` : o)), /not one 32-byte word/);
  assert.throws(() => evmHoldingsReader(evmRpc(chains().evm, "x", log), [USDC, USDC.toUpperCase().replace("0X", "0x")]), /a token twice/);
});

test("two spent notes that give one W refuse, and so do two readers of one provider or of another chain", async () => {
  const { sol, evm } = chains();
  const n = { ref: { kind: "deposit", s: SOL_SCOPE, i: 0 } as NoteRef, label: L };
  await assert.rejects(buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [n, n], readers: solReaders(sol) }]), /its W is another spent note's/);
  const [a, b] = solReaders(sol);
  await assert.rejects(buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [n], readers: [a, a] }]), /one provider twice/);
  await assert.rejects(buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [n], readers: [a, { ...b, name: a.name }] }]), /one provider twice/);
  await assert.rejects(buyWallets(SEED, [{ id: "sol", chain: "sol", spent: [n], readers: [a, evmReaders(evm)[0]] }]), /a reader not of chain sol/);
});

test("a Solana restore's spends must be its spent notes, each at the queue's (l, j)", () => {
  const leaf = (label: bigint) => ({ value: 1n, label, commitment: 1n, leafIndex: 0n });
  const dep: NoteRef = { kind: "deposit", s: SOL_SCOPE, i: 0 }, chg: NoteRef = { kind: "change", l: L, j: 0 };
  const notes = [
    { ref: dep, scope: SOL_SCOPE, precommitment: 1n, leaf: leaf(L), state: "SPENT" as const },
    { ref: chg, scope: SOL_SCOPE, precommitment: 2n, leaf: leaf(L), state: "SPENT" as const },
    { ref: { kind: "change", l: L, j: 1 } as NoteRef, scope: SOL_SCOPE, precommitment: 3n, leaf: leaf(L), state: "UNSPENT" as const },
  ];
  const spends = [{ l: L, j: 0, note: refKey(dep), w: solW(0), withdrawn: 1n }, { l: L, j: 1, note: refKey(chg), w: solW(1), withdrawn: 1n }];
  assert.deepEqual(solanaSpentNotes({ notes, spends }), [{ ref: dep, label: L }, { ref: chg, label: L }]);
  assert.throws(() => solanaSpentNotes({ notes, spends: spends.slice(1) }), /its spends are not its spent notes/);
  assert.throws(() => solanaSpentNotes({ notes, spends: [spends[0]!, { ...spends[1]!, j: 2 }] }), /spend 1 is not its note's/);
  assert.throws(() => solanaSpentNotes({ notes, spends: [spends[0]!, { ...spends[1]!, l: L2 }] }), /spend 1 is not its note's/);
  assert.throws(() => solanaSpentNotes({ notes, spends: [spends[1]!, spends[0]!] }), /spend 0 is not its note's/);
  assert.throws(() => solanaSpentNotes({ notes, spends: [{ ...spends[0]!, note: refKey({ kind: "deposit", s: SOL_SCOPE, i: 9 }) }, spends[1]!] }), /spend 0 is not its note's/);
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
