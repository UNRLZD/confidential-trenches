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
import { openWalletStore } from "@blindfill/wallet/store";
import { solanaAta, solanaDecodeMessage, solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_COMPUTE_BUDGET_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { solanaPoolAccount, solanaPoolPage, solanaRentMin } from "../../kit/src/trade/solana/pool-buy.ts";
import { readSolanaReference } from "../../kit/src/trade/solana/pool.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { BuyWallet } from "../../wallet/src/pool/buy-wallets.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { BLOCKHASH, FEE_PAYER, POOL, PROGRAM, fx, providers, rent } from "../../kit/test/solana-pool-buy-fx.ts";
import { POOL_SELL_LOCK, poolSellKind, runPoolSell, type PoolSellHost } from "../src/pool-sell.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const L = 7n;
const J = 0;
const W = freshWallet(SEED64, "sol", L, J);
W.secretKey.fill(0);
const PIN = { program: PROGRAM, feePayer: FEE_PAYER };
const { scope: SCOPE } = solanaPoolOf(PROGRAM);
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
const SLOT = REF.slot! + 2;
const MIN_OUT = (REF.pools.find((p) => p.venue === "pump-curve")!.expectedOut * BigInt(10_000 - SLIPPAGE)) / 10_000n;

type Acc = { owner: string; lamports: number; data: Uint8Array };
const tokenAccount = (amount: bigint, state = 1): Uint8Array => {
  const d = new Uint8Array(165);
  d.set(base58.decode(MINT), 0);
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
};

/** One chain: the planted accounts, the program's deposit applied to a signed sell. */
function chain(plant: Plant = {}) {
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
  accounts.set(MINT, { owner: MINT_READ.owner, lamports: 1, data: base64.decode(MINT_READ.data[0]) });
  accounts.set(ATA, { owner: TOKEN_PROGRAM, lamports: 1, data: tokenAccount(AMOUNT) });
  accounts.set(W.address, { owner: "11111111111111111111111111111111", lamports: plant.lamports ?? ENOUGH, data: new Uint8Array(0) });
  const txs = new Map<string, { tx: Uint8Array; err: unknown }>();
  const log: string[] = [];

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
      const data = p === 1 && address === ATA && plant.heldOn1 !== undefined ? tokenAccount(plant.heldOn1) : a.data;
      return { owner: a.owner, lamports: a.lamports, data: [base64.encode(data), "base64"], executable: false, rentEpoch: 0, space: data.length };
    };
    const ctx = { context: { slot: SLOT } };
    return (async (method: string, params: readonly unknown[]) => {
      log.push(`${p}:${method}`);
      switch (method) {
        case "getMultipleAccounts": {
          const recorded = fx.pump.reads[p][JSON.stringify(params[0])];
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
          return t ? { slot: SLOT, transaction: [base64.encode(t.tx), "base64"], meta: { err: t.err } } : null;
        }
        default:
          throw new Error(`no fixture for ${method}`);
      }
    }) as SolanaRpc;
  };
  return { accounts, deposit, rpcs: [rpc(0), rpc(1)] as const, txs, log };
}

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
async function notes(): Promise<NoteStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  return ns;
}
const wallet = (amount: bigint, frozen = false): BuyWallet => ({
  pool: PROGRAM, chain: "sol", note: "n1", l: L, j: J, path: W.path, address: W.address,
  holdings: { native: 0n, tokens: new Map([[MINT, { amount, frozen }]]), unreadable: [] },
});
type World = { c: ReturnType<typeof chain>; ns: NoteStore; host: PoolSellHost; seeds: Uint8Array[]; sent: string[] };
async function world(plant: Plant = {}, wallets: BuyWallet[] = [wallet(AMOUNT)]): Promise<World> {
  const c = chain(plant);
  const ns = await notes();
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
  return { c, ns, host, seeds, sent };
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

test("a sell that never reads back, its blockhash never past on both RPCs, is sent: no note stored (the next sell or a restore finds it)", async () => {
  const w = await world({ lands: false, finalHeight: 50 });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "sent");
  assert.equal((a as { txs: unknown[] }).txs.length, 1);
  assert.deepEqual(await ours(w.ns), []);
  assert.equal(w.c.log.filter((x) => x === "0:getTransaction").length, 3, "read back each round");
});

test("past the blockhash's last height on both RPCs with no mark: not_landed, no note", async () => {
  const w = await world({ lands: false });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "not_landed");
  assert.deepEqual(await ours(w.ns), []);
});

test("another deposit takes the return note's precommitment first: the sell fails on chain as a whole, refused, and nothing is stored", async () => {
  const w = await world({ frontRun: true });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "refused");
  assert.deepEqual(await ours(w.ns), []);
  // the sell dropped, its precommitment taken by another deposit of another value: not the sale's deposit, never
  // stored as one (the next sell's walk adopts that mark as the user's note); past the last height, not_landed
  const x = await world({ frontRun: true, lands: false });
  const b = await runPoolSell(x.host, ASK);
  assert.equal("stage" in b && b.stage, "not_landed");
  assert.deepEqual(await ours(x.ns), []);
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

test("the kind runs under the seed's shared lock and the sell lock (one sell at a time, every tab), answers at the send, then posts filled", async () => {
  const w = await world();
  const modes: string[] = [];
  const locks = { request: (name: string, opts: { mode: string }, f: () => Promise<void>) => (modes.push(`${name}:${opts.mode}`), f()) } as unknown as Pick<LockManager, "request">;
  const stages: string[] = [];
  let ended = 0;
  const r = poolSellKind(() => ({ ...w.host, end: () => void ended++ }), locks)(ASK, { id: "r1", sha: "00", progress: (s: string) => void stages.push(s) } as never) as { running: true; after: Promise<void>; answer: () => { result?: { stage: string; txs: { hash: string }[] } } };
  assert.equal(r.running, true);
  await r.after;
  const ans = r.answer();
  assert.equal(ans.result?.stage, "sent");
  assert.equal(ans.result?.txs.length, 1);
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(stages, ["filled"]);
  assert.equal(ended, 1);
  assert.equal(POOL_SELL_LOCK, "ct-pool/sell");
  assert.deepEqual(modes, ["ct-wallet/seed:shared", "ct-pool/sell:exclusive"]);
  assert.deepEqual((await ours(w.ns)).map((n) => n.state), ["UNSPENT"]);
  // another kind, or no Web Locks: refused, nothing run
  assert.deepEqual(poolSellKind(() => w.host, locks)({ ...ASK, kind: "pool.buy" }, null), { error: "not_allowed" });
  assert.deepEqual(poolSellKind(() => w.host, null)(ASK, null), { error: "not_allowed" });
});
