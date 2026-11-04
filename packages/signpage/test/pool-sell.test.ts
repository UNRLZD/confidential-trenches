// Card signpage-pool-sell: one tap on the signing page sells a token W holds on its venue and puts what the sale gives
// back into the Solana pool in the same transaction, as a note of the user's own (src/pool-sell.ts). The note is stored
// only once both RPCs show its deposit.
// The venue's answers are the kit's recorded reads (packages/kit/test/fixtures/solana-pool-buy.json: the LiteSVM run on
// copies of mainnet's pump program and accounts, both providers' answers, the Rent sysvar as both answered it); the pool
// account, its pages, the precommitment marks, W and its token account are planted around them, and a sent deposit is
// applied as the program applies it (contracts/pool-solana/src/deposit.rs: nonce + 1, the label keccak256(scope ‖
// nonce) mod p, the commitment Poseidon(value, label, precommitment), one leaf on each tree's page, the 17-byte mark;
// a deposit on a precommitment whose mark exists fails, and the whole transaction with it), only once W's signature
// verifies. The note store is the wallet's own on fake-indexeddb; the seed the published all-zero entropy vector
// (packages/wallet/test/vectors/a8.json).
//   node --test test/pool-sell.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { base58, base64 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, freshWallet, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { solanaAta, solanaDecodeMessage, solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_PUMP_AMM_PROGRAM, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM, solanaVolumeAccumulator } from "../../kit/src/checks/solana/checks.ts";
import { solanaPoolAccount, solanaPoolPage, solanaRentMin } from "../../kit/src/trade/solana/pool-buy.ts";
import { readSolanaReference } from "../../kit/src/trade/solana/pool.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { BuyWallet } from "../../wallet/src/pool/buy-wallets.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { BLOCKHASH, FEE_PAYER, POOL, PROGRAM, fx, providers, rent } from "../../kit/test/solana-pool-buy-fx.ts";
import { POOL_SELL_LOCK, poolSellKind, runPoolSell, type PoolSellHost, type PoolSellKindHost } from "../src/pool-sell.ts";
import { opOf } from "../src/state.ts";
import type { TradeStore } from "../src/trade.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const L = 7n;
const J = 0;
const W = freshWallet(SEED64, "sol", L, J);
W.secretKey.fill(0);
const PIN = { program: PROGRAM, feePayer: FEE_PAYER };
const { scope: SCOPE } = solanaPoolOf(PROGRAM);
type Venue = "pump" | "pumpswap";
/** Each recorded venue's mint, its read (a Token-2022 mint on both), W's token account under it, the reference both
 *  providers give for exactly this sell and the floor the run's min out comes from. */
const VF = {} as Record<Venue, { mint: string; mintRead: { owner: string; data: [string, string] }; ata: string; slot: number; minOut: bigint }>;
const MINT = fx.pump.mint as string;
/** 4,000,000 tokens (6 decimals): the recorded curve gives about 0.11 SOL for them. */
const AMOUNT = 4_000_000_000_000n;
const SLIPPAGE = 300;
const ASK: PoolAsk = { kind: "pool.sell", chain: "solana", token: MINT, amount: AMOUNT, slippageBps: SLIPPAGE, decimals: 6 };
const FEE = 5_000;
const N = 6; // leaves on each tree before the sell
const ENOUGH = 1_000_000_000; // W's lamports: a reserve of 0
const enc = new TextEncoder();
const be32 = (x: bigint): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => Number((x >> BigInt(8 * (31 - i))) & 255n));
const beInt = (b: Uint8Array): bigint => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const markOf = (pre: bigint, program = PROGRAM): string => solanaProgramAddress([enc.encode("pre"), be32(pre)], program);
const RETURN: NoteRef = { kind: "return", c: "sol", l: L, j: J };
const SECOND = (n: number): NoteRef => ({ kind: "second", id: { id: "R", c: "sol", l: L, j: J }, n });
const preOf = (ref: NoteRef): bigint => noteSecrets(SEED64, ref).precommitment;

// the mint as both providers answered it in the recorded run (a Token-2022 mint): its owner is the venue's token program
const MINT_READ = (Object.entries(fx.pump.reads[0]).find(([k]) => JSON.parse(k)[0] === MINT)![1] as { value: { owner: string; data: [string, string] }[] }).value[0]!;
const TOKEN_PROGRAM = MINT_READ.owner;
const ATA = solanaAta(W.address, MINT, TOKEN_PROGRAM);
// the reference both providers give for exactly this sell, and its slot: what the run's floor comes from
const REF = (await readSolanaReference(providers("pump"), { side: "sell", token: MINT, amount: AMOUNT }))!;
const MIN_OUT = (REF.pools.find((p) => p.venue === "pump-curve")!.expectedOut * BigInt(10_000 - SLIPPAGE)) / 10_000n;
for (const v of ["pump", "pumpswap"] as const) {
  const mint = fx[v].mint as string;
  const mintRead = (Object.entries(fx[v].reads[0]).find(([k]) => JSON.parse(k)[0] === mint)![1] as { value: { owner: string; data: [string, string] }[] }).value[0]!;
  const ref = (await readSolanaReference(providers(v), { side: "sell", token: mint, amount: AMOUNT }))!;
  VF[v] = { mint, mintRead, ata: solanaAta(W.address, mint, mintRead.owner), slot: ref.slot! + 2, minOut: (ref.pools[0]!.expectedOut * BigInt(10_000 - SLIPPAGE)) / 10_000n };
}

type Acc = { owner: string; lamports: number; data: Uint8Array };
const tokenAccount = (amount: bigint, state = 1, mint = MINT): Uint8Array => {
  const d = new Uint8Array(165);
  d.set(base58.decode(mint), 0);
  d.set(base58.decode(W.address), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = state;
  return d;
};
const pageBytes = (tree: 0 | 1, leaves: bigint[]): Uint8Array => {
  const d = new Uint8Array(16 + 72 * leaves.length);
  d.set(enc.encode("bfpage01"));
  d[8] = tree;
  leaves.forEach((leaf, i) => {
    d.set(be32(leaf), 16 + i * 72);
    new DataView(d.buffer).setBigInt64(16 + i * 72 + 64, BigInt(i + 1), true);
  });
  return d;
};

type Plant = {
  /** the recorded venue the sell goes to (pump's curve when not given) */
  venue?: Venue;
  /** W's lamports (ENOUGH when not given) */
  lamports?: number;
  /** RPC 1's read of W's token account: this amount */
  heldOn1?: bigint;
  /** a sent transaction lands (true when not given) */
  lands?: boolean;
  /** RPC p's finalized block height (1,000 when not given: past the blockhash's last height, 151) */
  finalHeight?: number;
  /** another deposit takes the return note's precommitment just before the sell lands */
  frontRun?: boolean;
  /** RPC 1 never shows this account */
  hideOn1?: string;
  /** RPC 1's simulation of the sell fails */
  simFailOn1?: boolean;
  /** the PumpSwap pool says a cashback coin (its is_cashback_coin byte, 244, set in the recorded reads) */
  cashback?: boolean;
  /** W has its PumpSwap volume account and that account's wrapped-SOL account (a PumpSwap buy made them) */
  ammCashback?: boolean;
  /** another deposit takes the return note's precommitment just before the sell lands, at exactly the sell's value */
  frontRunSame?: boolean;
};

/** One chain: the planted accounts, the program's deposit applied to a signed sell. */
function chain(plant: Plant = {}) {
  const v = plant.venue ?? "pump";
  const { mint, mintRead, ata } = VF[v];
  const accounts = new Map<string, Acc>();
  const pool = new Uint8Array(2179);
  pool.set(enc.encode("bfpool01"));
  const pv = new DataView(pool.buffer);
  pv.setBigUint64(9, BigInt(N), true); // the nonce: N deposits so far
  pv.setBigUint64(49, BigInt(N), true);
  pv.setBigUint64(49 + 1065, BigInt(N), true);
  accounts.set(POOL, { owner: PROGRAM, lamports: 1, data: pool });
  accounts.set(solanaPoolPage(PROGRAM, 0, 0), { owner: PROGRAM, lamports: 1, data: pageBytes(0, Array.from({ length: N }, (_, i) => 1000n + BigInt(i))) });
  accounts.set(solanaPoolPage(PROGRAM, 1, 0), { owner: PROGRAM, lamports: 1, data: pageBytes(1, Array.from({ length: N }, (_, i) => vaultLabelOf(keccak_256, SCOPE, BigInt(i + 1)))) });
  accounts.set(fx.rent.account, { owner: fx.rent.answers[0].owner, lamports: 1, data: base64.decode(fx.rent.answers[0].data) });
  accounts.set(mint, { owner: mintRead.owner, lamports: 1, data: base64.decode(mintRead.data[0]) });
  accounts.set(ata, { owner: mintRead.owner, lamports: 1, data: tokenAccount(AMOUNT, 1, mint) });
  // W at 0 lamports has no account
  if (plant.lamports !== 0) accounts.set(W.address, { owner: "11111111111111111111111111111111", lamports: plant.lamports ?? ENOUGH, data: new Uint8Array(0) });
  if (plant.ammCashback) {
    const vol = solanaVolumeAccumulator(W.address, SOLANA_PUMP_AMM_PROGRAM);
    accounts.set(vol, { owner: SOLANA_PUMP_AMM_PROGRAM, lamports: 1, data: new Uint8Array(137) });
    accounts.set(solanaAta(vol, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), { owner: SOLANA_TOKEN_PROGRAM, lamports: 1, data: new Uint8Array(165) });
  }
  const txs = new Map<string, { tx: Uint8Array; err: unknown }>();
  const log: string[] = [];
  const calls: { p: 0 | 1; method: string; params: readonly unknown[] }[] = [];

  /** The program's deposit of `value` on `pre`: the next nonce's label, both leaves, the mark. */
  const deposit = (pre: bigint, value: bigint): void => {
    const mark = markOf(pre);
    if (accounts.has(mark)) throw new Error("PrecommitmentAlreadyUsed");
    const nonce = pv.getBigUint64(9, true) + 1n;
    const label = vaultLabelOf(keccak_256, SCOPE, nonce);
    for (const [tree, leaf] of [[0, noteCommitment(value, label, pre)], [1, label]] as const) {
      const at = solanaPoolPage(PROGRAM, tree, 0);
      const pg = accounts.get(at)!;
      const entry = new Uint8Array(72);
      entry.set(be32(leaf), 0);
      new DataView(entry.buffer).setBigInt64(64, BigInt((pg.data.length - 16) / 72 + 1), true);
      const data = new Uint8Array(pg.data.length + 72);
      data.set(pg.data);
      data.set(entry, pg.data.length);
      accounts.set(at, { ...pg, data });
    }
    pv.setBigUint64(9, nonce, true);
    pv.setBigUint64(49, pv.getBigUint64(49, true) + 1n, true);
    pv.setBigUint64(49 + 1065, pv.getBigUint64(49 + 1065, true) + 1n, true);
    const md = new Uint8Array(17);
    new DataView(md.buffer).setBigUint64(0, value, true);
    new DataView(md.buffer).setBigUint64(8, nonce, true);
    md[16] = 1;
    accounts.set(mark, { owner: PROGRAM, lamports: 1, data: md });
  };
  /** The sell's deposit (its last instruction) as the program runs it; `dry`: checked only (a simulation). */
  const apply = (tx: Uint8Array, dry: boolean): void => {
    const message = tx.subarray(1 + 64 * tx[0]!);
    const m = solanaDecodeMessage(message);
    const signer = m.staticKeys[0]!;
    if (!dry && !ed25519.verify(tx.subarray(1, 65), message, base58.decode(signer))) throw new Error("signature");
    const ix = m.instructions.at(-1)!;
    const keys = ix.accounts.map((i) => m.staticKeys[i]!);
    if (m.staticKeys[ix.programIndex] !== PROGRAM || ix.data[0] !== 1 || keys[0] !== POOL || keys[1] !== signer) throw new Error("not a deposit into the pool");
    const value = new DataView(ix.data.buffer, ix.data.byteOffset + 1, 8).getBigUint64(0, true);
    const pre = beInt(ix.data.subarray(9, 41));
    if (dry) {
      if (accounts.has(markOf(pre))) throw new Error("PrecommitmentAlreadyUsed");
      return;
    }
    deposit(pre, value);
  };

  const rpc = (p: 0 | 1): SolanaRpc => {
    const answer = (address: string): unknown => {
      if (p === 1 && plant.hideOn1 === address) return null;
      const a = accounts.get(address);
      if (!a) return null;
      const data = p === 1 && address === ata && plant.heldOn1 !== undefined ? tokenAccount(plant.heldOn1, 1, mint) : a.data;
      return { owner: a.owner, lamports: a.lamports, data: [base64.encode(data), "base64"], executable: false, rentEpoch: 0, space: data.length };
    };
    const ctx = { context: { slot: VF[v].slot } };
    return (async (method: string, params: readonly unknown[]) => {
      log.push(`${p}:${method}`);
      calls.push({ p, method, params });
      switch (method) {
        case "getMultipleAccounts": {
          const recorded = fx[v].reads[p][JSON.stringify(params[0])];
          if (recorded && plant.cashback) {
            // the PumpSwap Pool account (owned by the AMM, 245 bytes or more, under 600): its cashback byte set
            const r = structuredClone(recorded) as { value: ({ owner: string; data: [string, string] } | null)[] };
            for (const a of r.value) {
              if (a?.owner !== SOLANA_PUMP_AMM_PROGRAM) continue;
              const d = base64.decode(a.data[0]);
              if (d.length < 245 || d.length >= 600) continue;
              d[244] = 1;
              a.data[0] = base64.encode(d);
            }
            return r;
          }
          if (recorded) return structuredClone(recorded);
          return { ...ctx, value: (params[0] as string[]).map(answer) };
        }
        case "getAccountInfo":
          return { ...ctx, value: answer(params[0] as string) };
        case "getLatestBlockhash":
          return { ...ctx, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } };
        case "isBlockhashValid":
          return { ...ctx, value: true };
        case "getBlockHeight":
          // confirmed: RPC 1's height beside the blockhash, so the last height is max(100, 0 + 151) = 151
          return (params[0] as { commitment: string }).commitment === "confirmed" ? 0 : (plant.finalHeight ?? 1_000);
        case "getSlot":
          // finalized: the slot each RPC answers its past read at, which pins its mark read (minContextSlot)
          return VF[v].slot + 10 + p;
        case "getFeeForMessage":
          return { ...ctx, value: FEE };
        case "simulateTransaction": {
          const tx = base64.decode(params[0] as string);
          assert.equal((params[1] as { sigVerify: boolean }).sigVerify, false);
          assert.deepEqual(tx.subarray(1, 65), new Uint8Array(64), "simulated unsigned");
          try {
            if (p === 1 && plant.simFailOn1) throw new Error("InsufficientFunds");
            apply(tx, true);
            return { ...ctx, value: { err: null, logs: [] } };
          } catch (e) {
            return { ...ctx, value: { err: String(e), logs: [] } };
          }
        }
        case "sendTransaction": {
          const tx = base64.decode(params[0] as string);
          const sig = base58.encode(tx.subarray(1, 65));
          if (plant.frontRun && !accounts.has(markOf(preOf(RETURN)))) deposit(preOf(RETURN), 1n);
          if (plant.frontRunSame && !accounts.has(markOf(preOf(RETURN)))) {
            const m = solanaDecodeMessage(tx.subarray(65));
            const dep = m.instructions.at(-1)!;
            deposit(preOf(RETURN), new DataView(dep.data.buffer, dep.data.byteOffset + 1, 8).getBigUint64(0, true));
          }
          if (!txs.has(sig) && plant.lands !== false) {
            try {
              apply(tx, false);
              txs.set(sig, { tx, err: null });
            } catch (e) {
              txs.set(sig, { tx, err: { InstructionError: [0, String(e)] } });
            }
          }
          return sig;
        }
        case "getTransaction": {
          const t = txs.get(params[0] as string);
          return t ? { slot: VF[v].slot, transaction: [base64.encode(t.tx), "base64"], meta: { err: t.err } } : null;
        }
        default:
          throw new Error(`no fixture for ${method}`);
      }
    }) as SolanaRpc;
  };
  return { accounts, deposit, rpcs: [rpc(0), rpc(1)] as const, txs, log, calls };
}

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
async function notes(): Promise<{ store: WalletStore; ns: NoteStore }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  return { store: w, ns };
}
const wallet = (amount: bigint, frozen = false, mint = MINT): BuyWallet => ({
  pool: PROGRAM, chain: "sol", note: "n1", l: L, j: J, path: W.path, address: W.address,
  holdings: { native: 0n, tokens: new Map([[mint, { amount, frozen }]]), unreadable: [] },
});
type World = { c: ReturnType<typeof chain>; ns: NoteStore; store: WalletStore; host: PoolSellHost; seeds: Uint8Array[]; sent: string[] };
async function world(plant: Plant = {}, wallets: BuyWallet[] = [wallet(AMOUNT, false, VF[plant.venue ?? "pump"].mint)]): Promise<World> {
  const c = chain(plant);
  const { store, ns } = await notes();
  const seeds: Uint8Array[] = [];
  const sent: string[] = [];
  const host: PoolSellHost = {
    pin: PIN,
    rpcs: c.rpcs,
    notes: async () => ns,
    seed64: async () => {
      c.log.push("seed");
      const s = SEED64.slice();
      seeds.push(s);
      return s;
    },
    wallets: async () => wallets,
    sent: (s) => void sent.push(s),
    now: () => 1_000n,
    reads: 3,
    wait: async () => {},
    pick: () => 2,
  };
  return { c, ns, store, host, seeds, sent };
}
const ours = async (ns: NoteStore) => (await ns.list()).filter((n) => n.scope === SCOPE).map((n) => ({ ref: n.ref, state: n.state, value: n.leaf?.value, leafIndex: n.leaf?.leafIndex }));
const rentMin = (size: number): bigint => solanaRentMin(rent, size);
const sends = (w: World) => w.c.log.filter((x) => x.endsWith("sendTransaction"));

test("the fixture: the recorded curve prices the sell well above the reserve's cap, and the mint is the venue's token program's", () => {
  assert.ok(MIN_OUT > 100_000_000n, String(MIN_OUT));
  assert.equal(TOKEN_PROGRAM, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  assert.equal(solanaPoolAccount(PROGRAM), POOL);
});

test("a sell: checked, simulated unsigned on both RPCs, signed by W, sent on both, and the return note stored UNSPENT only once both show its deposit", async () => {
  const w = await world();
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  const sig = (a as { txs: { hash: string }[] }).txs[0]!.hash;
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: "solana", hash: sig }] });
  assert.deepEqual(w.sent, [sig], "answered at the send with W's own signature");
  // the note: the return note of W's (l, j), UNSPENT, with the deposit's leaf (the next state leaf)
  assert.deepEqual(await ours(w.ns), [{ ref: RETURN, state: "UNSPENT", value: MIN_OUT, leafIndex: BigInt(N) }]);
  // the bytes: one signature slot, W's; no compute budget; the venue's sell, then last the deposit into the pinned pool
  const { tx } = w.c.txs.get(sig)!;
  assert.equal(tx[0], 1);
  const message = tx.subarray(65);
  assert.ok(ed25519.verify(tx.subarray(1, 65), message, base58.decode(W.address)), "W's signature over the message");
  assert.equal(base58.encode(tx.subarray(1, 65)), sig);
  const m = solanaDecodeMessage(message);
  assert.equal(m.staticKeys[0], W.address);
  assert.equal(m.blockhash, BLOCKHASH);
  assert.ok(!m.staticKeys.includes(SOLANA_COMPUTE_BUDGET_PROGRAM), "no priority fee");
  const dep = m.instructions.at(-1)!;
  assert.equal(m.staticKeys[dep.programIndex], PROGRAM);
  assert.equal(m.staticKeys[dep.accounts[0]!], POOL);
  assert.equal(new DataView(dep.data.buffer, dep.data.byteOffset + 1, 8).getBigUint64(0, true), MIN_OUT, "a reserve of 0: W keeps its rent and fees");
  assert.equal(beInt(dep.data.subarray(9, 41)), preOf(RETURN));
  // simulated on both before W is derived; sent on both
  const log = w.c.log;
  const signSeed = log.lastIndexOf("seed");
  assert.ok(log.indexOf("0:simulateTransaction") < signSeed && log.indexOf("1:simulateTransaction") < signSeed, log.join(" "));
  assert.deepEqual(sends(w).sort(), ["0:sendTransaction", "1:sendTransaction"]);
  assert.ok(w.seeds.length >= 1 && w.seeds.every((s) => s.every((b) => b === 0)), "every seed copy zeroed");
});

test("a W short of lamports keeps them on W: the reserve is its fee, the mark's rent and the pages' growth up to an empty account's rent", async () => {
  const lamports = 1_000_000;
  const w = await world({ lamports });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled");
  const reserve = BigInt(FEE) + rentMin(17) + 2n * 72n * rent.lamportsPerByte * rent.factor + rentMin(0) - BigInt(lamports);
  assert.ok(reserve > 0n);
  assert.deepEqual(await ours(w.ns), [{ ref: RETURN, state: "UNSPENT", value: MIN_OUT - reserve, leafIndex: BigInt(N) }]);
});

test("an amount over W's holding, the lower of the two RPCs' reads, is not_funded: nothing derived, signed or sent", async () => {
  const w = await world({ heldOn1: AMOUNT - 1n });
  assert.deepEqual(await runPoolSell(w.host, ASK), { error: "not_funded" });
  assert.equal(w.seeds.length, 0, "the seed never read");
  assert.ok(!w.c.log.some((x) => /simulateTransaction|sendTransaction/.test(x)));
  assert.deepEqual(await ours(w.ns), []);
  // no W holds the amount (short, frozen, or none at all): not_funded with no read at all
  for (const ws of [[wallet(AMOUNT - 1n)], [wallet(AMOUNT, true)], []]) {
    const x = await world({}, ws);
    assert.deepEqual(await runPoolSell(x.host, ASK), { error: "not_funded" });
    assert.deepEqual(x.c.log, [], "no read");
  }
  // a frozen token account on chain: not_allowed
  const f = await world();
  f.c.accounts.set(ATA, { owner: TOKEN_PROGRAM, lamports: 1, data: tokenAccount(AMOUNT, 2) });
  assert.deepEqual(await runPoolSell(f.host, ASK), { error: "not_allowed" });
  assert.equal(sends(f).length, 0);
});

test("proceeds bent to any pool but the pinned one are refused by the rule before W signs: nothing simulated, signed or sent", async () => {
  const w = await world();
  // a host whose pin moves under the run: the run's reads and build see another program's pool, the rule the page's pin
  const EVIL = base58.encode(new Uint8Array(32).fill(3));
  const evilPool = solanaPoolAccount(EVIL);
  w.c.accounts.set(evilPool, { ...w.c.accounts.get(POOL)!, owner: EVIL });
  let reads = 0;
  Object.defineProperty(w.host, "pin", { get: () => (reads++ === 0 ? { program: EVIL, feePayer: FEE_PAYER } : PIN) });
  assert.deepEqual(await runPoolSell(w.host, ASK), { error: "quote_check_failed" });
  assert.ok(w.c.log.includes(`0:getFeeForMessage`), "built before the check");
  assert.ok(!w.c.log.some((x) => /simulateTransaction|sendTransaction/.test(x)), w.c.log.join(" "));
  assert.equal(w.seeds.length, 1, "the seed read once, for the note's precommitment: never for W's key");
  assert.ok(w.seeds.every((s) => s.every((b) => b === 0)));
  assert.deepEqual(w.sent, []);
  assert.deepEqual(await ours(w.ns), []);
});

test("a sell that never reads back, its blockhash never past on both RPCs, is sent: its note INCOMING with W's send (written before the send), for the next load to settle", async () => {
  const w = await world({ lands: false, finalHeight: 50 });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "sent");
  assert.equal((a as { txs: unknown[] }).txs.length, 1);
  const sig = (a as { txs: { hash: string }[] }).txs[0]!.hash;
  const [n] = (await w.ns.list()).filter((x) => x.scope === SCOPE);
  assert.deepEqual({ ref: n!.ref, state: n!.state, sends: n!.sends }, { ref: RETURN, state: "INCOMING", sends: [{ signature: sig, value: MIN_OUT, last_valid_block_height: 151n }] });
  assert.equal(w.c.log.filter((x) => x === "0:getTransaction").length, 3, "read back each round");
});

test("past the blockhash's last height on both RPCs with no mark: not_landed, the note PLANNED again (its send dropped), and the next sell deposits on that same note", async () => {
  const plant: Plant = { lands: false };
  const w = await world(plant);
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "not_landed");
  const [n] = (await w.ns.list()).filter((x) => x.scope === SCOPE);
  assert.deepEqual({ ref: n!.ref, state: n!.state, sends: n!.sends }, { ref: RETURN, state: "PLANNED", sends: undefined });
  // the next sell takes the same return note, never R 0, so the restore's walk (return, then R 0, 1, ... with no gap)
  // finds every note that lands
  plant.lands = true;
  const b = await runPoolSell(w.host, ASK);
  assert.equal("stage" in b && b.stage, "filled");
  assert.deepEqual(await ours(w.ns), [{ ref: RETURN, state: "UNSPENT", value: MIN_OUT, leafIndex: BigInt(N) }]);
});

test("another deposit takes the return note's precommitment first: the sell fails on chain as a whole, refused, and that deposit is stored as the user's own note (only the seed names it)", async () => {
  const w = await world({ frontRun: true });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "refused");
  assert.deepEqual(await ours(w.ns), [{ ref: RETURN, state: "UNSPENT", value: 1n, leafIndex: BigInt(N) }]);
  // the sell dropped, its precommitment taken by another deposit of another value: not the sale's deposit (not
  // filled), and it can never land (its deposit would be refused): not_landed, the note stored with the mark's value
  const x = await world({ frontRun: true, lands: false });
  const b = await runPoolSell(x.host, ASK);
  assert.equal("stage" in b && b.stage, "not_landed");
  assert.deepEqual(await ours(x.ns), [{ ref: RETURN, state: "UNSPENT", value: 1n, leafIndex: BigInt(N) }]);
  // the next sell of that W takes R 0
  const c = await runPoolSell(w.host, ASK);
  assert.equal("stage" in c && c.stage, "filled");
  assert.deepEqual((await ours(w.ns)).find((n) => n.leafIndex === BigInt(N + 1))?.ref, SECOND(0));
});

test("a mark already on both RPCs for the return note, not in the store, is the user's own: adopted UNSPENT with its leaf, and the sell takes second arrival 0", async () => {
  const w = await world();
  w.c.deposit(preOf(RETURN), 12_345_678n);
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled");
  const got = await ours(w.ns);
  assert.deepEqual(got.sort((x, y) => Number(x.leafIndex! - y.leafIndex!)), [
    { ref: RETURN, state: "UNSPENT", value: 12_345_678n, leafIndex: BigInt(N) },
    { ref: SECOND(0), state: "UNSPENT", value: MIN_OUT, leafIndex: BigInt(N + 1) },
  ]);
  // the refs the store holds are passed over: the next sell takes second arrival 1
  const b = await runPoolSell(w.host, ASK);
  assert.equal("stage" in b && b.stage, "filled");
  assert.deepEqual((await ours(w.ns)).find((n) => n.leafIndex === BigInt(N + 2))?.ref, SECOND(1));
});

test("a mark for the return note on one RPC only is that RPC's word against the other's: failed, nothing sent or stored", async () => {
  const w = await world({ hideOn1: markOf(preOf(RETURN)) });
  w.c.deposit(preOf(RETURN), 12_345_678n);
  assert.deepEqual(await runPoolSell(w.host, ASK), { error: "failed" });
  assert.ok(!w.c.log.some((x) => /getLatestBlockhash|simulateTransaction|sendTransaction/.test(x)), "refused at the walk, before the quote");
  assert.deepEqual(await ours(w.ns), []);
});

test("a simulation that fails on either RPC is failed: W never derived, nothing sent or stored", async () => {
  const w = await world({ simFailOn1: true });
  assert.deepEqual(await runPoolSell(w.host, ASK), { error: "failed" });
  assert.ok(w.c.log.includes("0:simulateTransaction") && w.c.log.includes("1:simulateTransaction"));
  assert.equal(w.seeds.length, 1, "the seed read once, for the note's precommitment: never for W's key");
  assert.ok(w.seeds.every((s) => s.every((b) => b === 0)));
  assert.equal(sends(w).length, 0);
  assert.deepEqual(await ours(w.ns), []);
});

test("a token or chain that is not the ask's own is refused not_allowed with no read", async () => {
  const w = await world();
  for (const ask of [{ ...ASK, kind: "pool.buy" }, { ...ASK, chain: "base" }, { ...ASK, token: null }] as PoolAsk[]) assert.deepEqual(await runPoolSell(w.host, ask), { error: "not_allowed" });
  assert.deepEqual(w.c.log, []);
});

/** Web Locks as one tab sees them: each name held by one callback at a time; ifAvailable gets null while it is held. */
function fakeLocks(modes: string[] = []): Pick<LockManager, "request"> {
  const held = new Map<string, Promise<void>>();
  return {
    request: (async (name: string, opts: { mode: string; ifAvailable?: boolean }, f: (l: unknown) => Promise<unknown>) => {
      modes.push(`${name}:${opts.mode}${opts.ifAvailable ? "?" : ""}`);
      if (opts.mode === "shared") return f({ name });
      if (held.has(name)) {
        if (opts.ifAvailable) return f(null);
        while (held.has(name)) await held.get(name);
      }
      let done!: () => void;
      held.set(name, new Promise<void>((r) => (done = r)));
      try {
        return await f({ name });
      } finally {
        held.delete(name);
        done();
      }
    }) as never,
  };
}
/** Waits, a few ms apart, until `f` holds (2 s at most). */
async function until(f: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await f()); i++) await new Promise((res) => setTimeout(res, 10));
}
type KindAnswer = { running: true; after: Promise<void>; answer: () => { result?: { stage: string; txs: { hash: string }[] }; error?: string } };
const kindHost = (w: World, ended = { n: 0 }): (() => PoolSellKindHost) => () => ({ ...w.host, ops: async () => w.store, end: () => void ended.n++ });
const ctxOf = (id: string, sha = "00", stages: string[] = []) => ({ id, sha, progress: (s: string) => void stages.push(s) }) as never;

test("the kind runs under the seed's shared lock, the request's own lock and the sell lock (one sell at a time, every tab), answers at the send, then posts filled", async () => {
  const w = await world();
  const modes: string[] = [];
  const locks = fakeLocks(modes);
  const stages: string[] = [];
  const ended = { n: 0 };
  const r = poolSellKind(kindHost(w, ended), locks)(ASK, ctxOf("r1", "00", stages)) as KindAnswer;
  assert.equal(r.running, true);
  await r.after;
  const ans = r.answer();
  assert.equal(ans.result?.stage, "sent");
  assert.equal(ans.result?.txs.length, 1);
  await until(async () => stages.length > 0);
  assert.deepEqual(stages, ["filled"]);
  assert.equal(ended.n, 1);
  assert.equal(POOL_SELL_LOCK, "ct-pool/sell");
  assert.deepEqual(modes, ["ct-wallet/seed:shared", "ct-wallet/trade/r1:exclusive?", "ct-pool/sell:exclusive"]);
  assert.deepEqual((await ours(w.ns)).map((n) => n.state), ["UNSPENT"]);
  // another kind, no Web Locks or no request: refused, nothing run
  assert.deepEqual(poolSellKind(kindHost(w), locks)({ ...ASK, kind: "pool.buy" }, ctxOf("r2")), { error: "not_allowed" });
  assert.deepEqual(poolSellKind(kindHost(w), null)(ASK, ctxOf("r3")), { error: "not_allowed" });
  assert.deepEqual(poolSellKind(kindHost(w), locks)(ASK, null), { error: "not_allowed" });
});

// The review of signpage-pool-sell 4b6223a (medium): the kit's client gives pool.sell 10 s; a run's reads before the
// send can take longer, so the app gets client_timeout while the page still signs, and a re-tap (or a reload's retry)
// with the same id sold again. Each request id now has an ops record, as trade.ts keeps a trade's.
test("a request id seen before never runs twice: answered from its ops record, which the app reads in state.ops as the running sell's stage", async () => {
  const w = await world();
  const locks = fakeLocks();
  const r = poolSellKind(kindHost(w), locks)(ASK, ctxOf("t1", "aa")) as KindAnswer;
  await r.after;
  const sig = r.answer().result!.txs[0]!.hash;
  await until(async () => ((await w.store.get("ops", "t1")) as { stage?: string } | undefined)?.stage === "filled");
  // the record, as state.ts's op contract reads it: a sell, its stage and W's signature, nothing secret
  const rec = (await w.store.get("ops", "t1")) as Record<string, unknown>;
  assert.deepEqual(opOf("t1", rec), { id: "t1", kind: "sell", stage: "filled", txs: [{ chain: "solana", hash: sig }] });
  assert.deepEqual(Object.keys(rec).sort(), ["created_ms", "kind", "pool", "sha", "stage", "txs"]);
  // the same id again (a reload, or the app's retry after client_timeout): its record's answer, no second sale
  const sendsBefore = sends(w).length;
  const again = poolSellKind(kindHost(w), locks)(ASK, ctxOf("t1", "aa")) as KindAnswer;
  await again.after;
  assert.deepEqual(again.answer(), { result: { stage: "filled", txs: [{ chain: "solana", hash: sig }] } });
  assert.equal(sends(w).length, sendsBefore, "never sent again");
  // the same id with another request: id_reused
  const other = poolSellKind(kindHost(w), locks)(ASK, ctxOf("t1", "bb")) as KindAnswer;
  await other.after;
  assert.deepEqual(other.answer(), { error: "id_reused" });
});

test("the same id in a second tab while the first runs is id_reused at once; the app reads 'sent' in the record while the verdict runs", async () => {
  const plant: Plant = { lands: false, finalHeight: 50 };
  const w = await world(plant);
  const locks = fakeLocks();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const host = (): PoolSellKindHost => ({ ...w.host, reads: 2, wait: () => gate, ops: async () => w.store });
  const first = poolSellKind(host, locks)(ASK, ctxOf("t2")) as KindAnswer;
  await first.after;
  const sig = first.answer().result!.txs[0]!.hash;
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(opOf("t2", await w.store.get("ops", "t2")), { id: "t2", kind: "sell", stage: "sent", txs: [{ chain: "solana", hash: sig }] });
  const second = poolSellKind(host, locks)(ASK, ctxOf("t2")) as KindAnswer;
  await second.after;
  assert.deepEqual(second.answer(), { error: "id_reused" });
  release();
});

// The review of signpage-pool-sell 4b6223a (critical): W pays the sell's fee before anything runs. The runtime refuses
// a fee payer with no account (W at 0 lamports), short of the fee, or left between 0 and rent(0) after it; PumpSwap's
// sell makes W's wrapped-SOL account (165 bytes) before any proceeds arrive. Such a sell can never pass simulation,
// so the run refuses it plainly before it builds anything.
const NEED = { pump: BigInt(FEE) + rentMin(0), pumpswap: BigInt(FEE) + rentMin(165) };
const nothingBuilt = (w: World) => assert.ok(!w.c.log.some((x) => /getFeeForMessage|simulateTransaction|sendTransaction/.test(x)), w.c.log.join(" "));

test("W at 0 lamports (no account) cannot pay its sell's fee: not_funded before anything is built, nothing signed, sent or stored", async () => {
  for (const venue of ["pump", "pumpswap"] as const) {
    const w = await world({ venue, lamports: 0 });
    assert.deepEqual(await runPoolSell(w.host, { ...ASK, token: VF[venue].mint }), { error: "not_funded" }, venue);
    nothingBuilt(w);
    assert.deepEqual(w.sent, []);
    assert.deepEqual(await ours(w.ns), []);
  }
});

test("PumpSwap: W at exactly rent(165), the old max-spend buy's W, cannot pay the fee and the wrapped-SOL account its sell makes first: not_funded before anything is built", async () => {
  const w = await world({ venue: "pumpswap", lamports: Number(rentMin(165)) });
  assert.deepEqual(await runPoolSell(w.host, { ...ASK, token: VF.pumpswap.mint }), { error: "not_funded" });
  nothingBuilt(w);
  assert.deepEqual(w.sent, []);
});

test("W at exactly what its sell needs up front sells, on both venues; a lamport less is not_funded before anything is built", async () => {
  for (const venue of ["pump", "pumpswap"] as const) {
    const ask = { ...ASK, token: VF[venue].mint };
    const ok = await world({ venue, lamports: Number(NEED[venue]) });
    const a = await runPoolSell(ok.host, ask);
    assert.equal("stage" in a && a.stage, "filled", `${venue}: ${JSON.stringify(a)}`);
    const short = await world({ venue, lamports: Number(NEED[venue] - 1n) });
    assert.deepEqual(await runPoolSell(short.host, ask), { error: "not_funded" }, venue);
    nothingBuilt(short);
  }
});

// The review of signpage-pool-sell 4b6223a (high): the note was stored only once both RPCs showed its mark, so a page
// closed or reloaded between the send and finality lost it on this device until a restore. Its record is now written
// before the send and settled on load by the same verdict rules.
test("a page killed right after the send keeps the note: the reload's settle stores it UNSPENT once both RPCs show it, and writes the request's stage", async () => {
  const w = await world();
  const locks = fakeLocks();
  // the page dies at the send: no verdict read at all
  const r = poolSellKind(() => ({ ...w.host, reads: 0, ops: async () => w.store }), locks)(ASK, ctxOf("k1")) as KindAnswer;
  await r.after;
  const sig = r.answer().result!.txs[0]!.hash;
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual((await w.ns.list()).filter((n) => n.scope === SCOPE).map((n) => ({ ref: n.ref, state: n.state })), [{ ref: RETURN, state: "INCOMING" }]);
  // the reload: a new note store on the same wallet store, the settle the page runs at its state reads
  const ns2 = await openNoteStore(w.store);
  closers.push(() => ns2.close());
  const { settlePoolSells, settleSellOps } = await import("../src/pool-sell.ts");
  const ends: Promise<void>[] = [];
  await settlePoolSells({ pin: PIN, rpcs: w.c.rpcs, notes: async () => ns2, settled: (s, stage) => void ends.push(settleSellOps(w.store, s, stage)) }, locks);
  await Promise.all(ends);
  assert.deepEqual(await ours(ns2), [{ ref: RETURN, state: "UNSPENT", value: MIN_OUT, leafIndex: BigInt(N) }]);
  assert.deepEqual(opOf("k1", await w.store.get("ops", "k1")), { id: "k1", kind: "sell", stage: "filled", txs: [{ chain: "solana", hash: sig }] });
  // settled once: a second pass changes nothing
  await settlePoolSells({ pin: PIN, rpcs: w.c.rpcs, notes: async () => ns2 }, locks);
  assert.deepEqual((await ours(ns2)).length, 1);
});

test("a page killed after a send that never lands: the reload's settle waits while the blockhash lives, then plans the note again and writes not_landed; the next sell deposits on it", async () => {
  const plant: Plant = { lands: false, finalHeight: 50 };
  const w = await world(plant);
  const locks = fakeLocks();
  const r = poolSellKind(() => ({ ...w.host, reads: 0, ops: async () => w.store }), locks)(ASK, ctxOf("k2")) as KindAnswer;
  await r.after;
  await new Promise((res) => setTimeout(res, 20));
  const { settlePoolSells, settleSellOps } = await import("../src/pool-sell.ts");
  const pass = async () => {
    const ends: Promise<void>[] = [];
    await settlePoolSells({ pin: PIN, rpcs: w.c.rpcs, notes: async () => w.ns, settled: (s, stage) => void ends.push(settleSellOps(w.store, s, stage)) }, locks);
    await Promise.all(ends);
  };
  await pass();
  assert.deepEqual((await w.ns.list()).filter((n) => n.scope === SCOPE).map((n) => n.state), ["INCOMING"], "its blockhash still lives");
  plant.finalHeight = 1_000;
  await pass();
  assert.deepEqual((await w.ns.list()).filter((n) => n.scope === SCOPE).map((n) => n.state), ["PLANNED"]);
  assert.equal(opOf("k2", await w.store.get("ops", "k2"))?.stage, "not_landed");
  plant.lands = true;
  const b = await runPoolSell(w.host, ASK);
  assert.equal("stage" in b && b.stage, "filled");
  assert.deepEqual(await ours(w.ns), [{ ref: RETURN, state: "UNSPENT", value: MIN_OUT, leafIndex: BigInt(N) }]);
});

test("the next sell of a W whose last sell a closed page left landing is refused while it may still land, and settles it first once it has", async () => {
  const plant: Plant = { lands: false, finalHeight: 50 };
  const w = await world(plant);
  w.host.reads = 0;
  await runPoolSell(w.host, ASK);
  assert.deepEqual(await runPoolSell({ ...w.host, reads: 3 }, ASK), { error: "failed" });
  assert.equal(sends(w).length, 2, "one sale sent, never a second");
});

// The re-review of 3bdca74 (critical): a coin bought on pump's curve that graduates sells on PumpSwap only, and on a
// cashback coin PumpSwap's sell names W's PumpSwap volume account and its wrapped-SOL account, which a curve buy never
// made: W pays their rent up front too, and keeps it out of the deposit.
test("a graduated cashback coin bought on the curve sells on PumpSwap from a W at the new need (the fee, the wrapped-SOL account and both cashback accounts); at 3bdca74's need it is refused before anything is built", async () => {
  const ask = { ...ASK, token: VF.pumpswap.mint };
  const cashbackRent = rentMin(137) + rentMin(165);
  const need = BigInt(FEE) + rentMin(165) + cashbackRent;
  const ok = await world({ venue: "pumpswap", cashback: true, lamports: Number(need) });
  const a = await runPoolSell(ok.host, ask);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  // the cashback accounts' rent is kept on W, out of the deposit, with the mark's rent, the pages' growth and rent(0)
  const reserve = BigInt(FEE) + cashbackRent + rentMin(17) + 2n * 72n * rent.lamportsPerByte * rent.factor + rentMin(0) - need;
  assert.deepEqual(await ours(ok.ns), [{ ref: RETURN, state: "UNSPENT", value: VF.pumpswap.minOut - reserve, leafIndex: BigInt(N) }]);
  // 3bdca74's PumpSwap need (the fee and the wrapped-SOL account) without the cashback accounts: refused, unbuilt
  for (const lamports of [BigInt(FEE) + rentMin(165), need - 1n]) {
    const short = await world({ venue: "pumpswap", cashback: true, lamports: Number(lamports) });
    assert.deepEqual(await runPoolSell(short.host, ask), { error: "not_funded" }, String(lamports));
    nothingBuilt(short);
  }
  // a W whose PumpSwap buy made both cashback accounts needs only the fee and the wrapped-SOL account
  const made = await world({ venue: "pumpswap", cashback: true, ammCashback: true, lamports: Number(BigInt(FEE) + rentMin(165)) });
  const b = await runPoolSell(made.host, ask);
  assert.equal("stage" in b && b.stage, "filled", JSON.stringify(b));
});

// The re-review (low): the mark read that decides "not landed" is pinned to the slot each RPC was past at.
test("past the blockhash, the note's mark is read on each RPC at the finalized slot it was past at (minContextSlot)", async () => {
  const w = await world({ lands: false });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "not_landed");
  const mark = markOf(preOf(RETURN));
  const pinned = w.c.calls.filter((c) => c.method === "getAccountInfo" && c.params[0] === mark && (c.params[1] as { minContextSlot?: number }).minContextSlot !== undefined);
  assert.deepEqual(pinned.map((c) => [c.p, (c.params[1] as { minContextSlot: number }).minContextSlot]).sort(), [[0, VF.pump.slot + 10], [1, VF.pump.slot + 11]]);
});

// The re-review (low): our transaction failed on both and another deposit took the precommitment at exactly our value:
// the sale did not happen, so refused, and that deposit is still the user's own note.
test("failed on both RPCs with another deposit's mark of exactly the sell's value: refused, never filled, the note stored UNSPENT", async () => {
  const w = await world({ frontRunSame: true });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "refused");
  assert.deepEqual(await ours(w.ns), [{ ref: RETURN, state: "UNSPENT", value: MIN_OUT, leafIndex: BigInt(N) }]);
});

// The re-review (low): an error after the send is no refusal: the transaction may land.
test("an error after the send answers and records 'sent' with W's signature, never refused or failed, so the settle finishes it", async () => {
  const dies = async (): Promise<void> => { throw new Error("the page's timer died"); };
  const v = await world({ lands: false, finalHeight: 50 });
  const a = await runPoolSell({ ...v.host, reads: 3, wait: dies }, ASK);
  assert.equal("stage" in a && a.stage, "sent", JSON.stringify(a));
  assert.equal("stage" in a && a.txs.length, 1);
  assert.equal(sends(v).length, 2, "sent on both RPCs");
  const w = await world({ lands: false, finalHeight: 50 });
  const locks = fakeLocks();
  const host = (): PoolSellKindHost => ({ ...w.host, reads: 3, wait: dies, ops: async () => w.store });
  const r = poolSellKind(host, locks)(ASK, ctxOf("e1")) as KindAnswer;
  await r.after;
  await until(async () => ((await w.store.get("ops", "e1")) as { stage?: string } | undefined)?.stage !== "signed");
  await new Promise((res) => setTimeout(res, 20));
  const rec = opOf("e1", await w.store.get("ops", "e1"));
  assert.equal(rec?.stage, "sent");
  assert.equal(rec?.txs.length, 1);
  assert.equal((rec as { code?: string }).code, undefined);
});

// The re-review (low): the "signed" record is written before the send; one that cannot be written sends nothing.
test("the request's record names W's signature before the transaction leaves the device: a record write that fails sends nothing", async () => {
  const w = await world();
  const locks = fakeLocks();
  const failing: TradeStore = { ...w.store, get: w.store.get, keys: w.store.keys, update: w.store.update, put: async (st, k, v) => {
    if ((v as { stage?: string }).stage === "signed") throw new Error("the store is gone");
    return w.store.put(st, k, v);
  } };
  const r = poolSellKind(() => ({ ...w.host, ops: async () => failing }), locks)(ASK, ctxOf("s1")) as KindAnswer;
  await r.after;
  assert.deepEqual(r.answer(), { error: "failed" });
  assert.equal(sends(w).length, 0, "nothing sent");
  // and with a working store, the signed record is there before the first send
  const x = await world();
  const order: string[] = [];
  const watched: TradeStore = { ...x.store, get: x.store.get, keys: x.store.keys, update: x.store.update, put: async (st, k, v) => {
    await x.store.put(st, k, v);
    order.push(`put:${(v as { stage?: string }).stage}`);
  } };
  const rpcs = x.c.rpcs.map((rpc) => (async (m: string, p: readonly unknown[]) => (m === "sendTransaction" && order.push("send"), rpc(m, p)))) as unknown as typeof x.c.rpcs;
  const r2 = poolSellKind(() => ({ ...x.host, rpcs, ops: async () => watched }), locks)(ASK, ctxOf("s2")) as KindAnswer;
  await r2.after;
  assert.ok(order.indexOf("put:signed") >= 0 && order.indexOf("put:signed") < order.indexOf("send"), order.join(" "));
});

// The re-review (medium): the record is written under the request's own lock, before the wait for the sell lock.
test("a request waiting behind another sell already has its record: a reload's re-ask of its id is never run again, and once its page is gone the settle refuses it", async () => {
  const w = await world();
  const locks = fakeLocks();
  // another sell holds the sell lock (through its verdict)
  let release!: () => void;
  const held = locks.request(POOL_SELL_LOCK, { mode: "exclusive" }, () => new Promise<void>((r) => (release = r)));
  const r = poolSellKind(kindHost(w), locks)(ASK, ctxOf("p1", "cc")) as KindAnswer;
  await until(async () => (await w.store.get("ops", "p1")) !== undefined);
  assert.equal(((await w.store.get("ops", "p1")) as { stage?: string }).stage, "pending");
  // a reload (another page, its own locks: the first page's lock went with it) asks the same id: answered, not run
  const reload = poolSellKind(kindHost(w), fakeLocks())(ASK, ctxOf("p1", "cc")) as KindAnswer;
  await reload.after;
  assert.deepEqual(reload.answer(), { error: "id_reused" });
  assert.equal(sends(w).length, 0);
  // while its request's lock is held the settle leaves it; a page that died while waiting leaves it "pending" with no
  // signature, which the settle (its lock free) refuses as failed
  const { settleDeadSellOps } = await import("../src/pool-sell.ts");
  await settleDeadSellOps(w.store, locks);
  assert.equal(((await w.store.get("ops", "p1")) as { stage?: string }).stage, "pending");
  await settleDeadSellOps(w.store, fakeLocks());
  assert.deepEqual(opOf("p1", await w.store.get("ops", "p1")), { id: "p1", kind: "sell", stage: "refused", txs: [], code: "failed" });
  release();
  await held;
  await r.after;
});
