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
import { throughApi } from "./api-ends.ts";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { base58, base64 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, freshWallet, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { SOLANA_ATA_PROGRAM, solanaAta, solanaDecodeMessage, solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_CLAIM_CASHBACK, SOLANA_CLOSE_VOLUME_ACCUMULATOR, SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_PUMP_AMM_PROGRAM, SOLANA_PUMP_PROGRAM, SOLANA_SOL_MINT, SOLANA_TOKEN_2022_PROGRAM as TOKEN_2022, SOLANA_TOKEN_PROGRAM, solanaTeardownAddresses, solanaVolumeAccumulator } from "../../kit/src/checks/solana/checks.ts";
import { readSolanaPoolBuyVenue, solanaPoolAccount, solanaPoolFee, solanaPoolPage, solanaPoolSellNeed, solanaRentMin, solanaPoolBuySellNeed, solanaPoolNextPage } from "../../kit/src/trade/solana/pool-buy.ts";
import { readSolanaReference } from "../../kit/src/trade/solana/pool.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { pairDown } from "./outage.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { BuyWallet } from "../../wallet/src/pool/buy-wallets.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { BLOCKHASH, FEE_PAYER, POOL, PROGRAM, fx, providers, rent } from "../../kit/test/solana-pool-buy-fx.ts";
import { POOL_RENT_BACK_MS, POOL_SELL_LOCK, POOL_SELL_READS, POOL_SELL_WAIT_MS, poolSellKind, resumeRentBacks, runPoolSell, settleDeadSellOps, settlePoolSells, solanaSellAfterFull, solanaSellReserve, type OwedRentBack, type PoolSellHost, type PoolSellKindHost, type RentBackTold } from "../src/pool-sell.ts";
import { opOf } from "../src/state.ts";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { checkSolanaSweep, PoolRuleRefused, SOLANA_POOL_MIN_DEPOSIT, SOLANA_POOL_SELL_RESERVE_MAX, solanaDepositRents, solanaSweepFloor, solanaSweepKeep, solanaWithdrawMinPart, withdrawNoteFloor, type PoolAsk } from "../src/rules/pool.ts";
import { tradeLock, type TradeStore } from "../src/trade.ts";

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
/** A front-runner's deposit on the return note's precommitment: the pool's least deposit (contracts/pool-solana/src/lib.rs:78),
 *  the least the program writes a mark for. */
const FRONT_RUN = 1_000_000n;
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
/** A native (WSOL) SPL Token account of `owner` holding `amount` wrapped. */
const nativeAccount = (owner: string, amount: bigint): Uint8Array => {
  const d = new Uint8Array(165);
  d.set(base58.decode(SOLANA_SOL_MINT), 0);
  d.set(base58.decode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1;
  new DataView(d.buffer).setUint32(109, 1, true);
  return d;
};
const tokenAccount = (amount: bigint, state = 1, mint = MINT): Uint8Array => {
  const d = new Uint8Array(165);
  d.set(base58.decode(mint), 0);
  d.set(base58.decode(W.address), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = state;
  return d;
};
const pageBytes = (tree: 0 | 1, leaves: bigint[], pageNo = 0): Uint8Array => {
  const d = new Uint8Array(16 + 72 * leaves.length);
  d.set(enc.encode("bfpage01"));
  d[8] = tree;
  new DataView(d.buffer).setUint32(9, pageNo, true);
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
  /** getTransaction answers this very transaction with a meta that says nothing (a string), landed or not */
  metaJunk?: boolean;
  /** RPC p's finalized block height (1,000 when not given: past the blockhash's last height, 151) */
  finalHeight?: number;
  /** another deposit takes the return note's precommitment just before the sell lands */
  frontRun?: boolean;
  /** RPC 1 never shows this account */
  hideOn1?: string;
  /** RPC p's answer for an account, changed (the chain itself keeps it as it is) */
  mapOn?: (p: 0 | 1, address: string, a: Acc) => Acc;
  /** RPC 1's simulation of the sell fails */
  simFailOn1?: boolean;
  /** the PumpSwap pool says a cashback coin (its is_cashback_coin byte, 244, set in the recorded reads) */
  cashback?: boolean;
  /** W has its PumpSwap volume account and that account's wrapped-SOL account (a PumpSwap buy made them) */
  ammCashback?: boolean;
  /** another deposit takes the return note's precommitment just before the sell lands, at exactly the sell's value */
  frontRunSame?: boolean;
  /** W's token account holds this (AMOUNT when not given) on both RPCs */
  held?: bigint;
  /** leaves on each tree before the sell (N when not given); 1,024 fills page 0, so the deposit opens page 1 on both */
  leaves?: number;
  /** the bonding curve says a cashback coin (its is_cashback_coin byte, 82, set in the recorded reads) */
  curveCashback?: boolean;
  /** of W's PumpSwap cashback accounts, only these (W's PumpSwap volume account, its wrapped-SOL account) */
  ammOnly?: "volume" | "ata";
  /** RPC 1 never shows W's PumpSwap cashback accounts (a lagging RPC) */
  ammHiddenOn1?: boolean;
  /** W's PumpSwap volume account exists but is the system program's (lamports sent to its address) */
  ammVolumeSystem?: boolean;
  /** W's token account's lamports (1 when not given): its rent, as the buy paid it */
  ataLamports?: number;
  /** W's volume accounts the buy made, under each pump program named, at rent(137): owing nothing, or `owed` (its
   *  needs_claim byte set: incentive tokens to claim, so pump keeps it open) */
  volumes?: { program: string; owed?: boolean; unsettled?: boolean; cashback?: bigint; stable?: bigint; claimed?: bigint }[];
  /** RPC 1 alone, until the sell lands, shows both of W's volume accounts owed a claim (pump's stable cashback, PumpSwap's
   *  cashback) where the chain has none (review 2 L4 of 911d7e25: one lying RPC lifts the sell's owed count) */
  owedOn1BeforeSell?: boolean;
  /** PumpSwap's claim_cashback fails as the program refuses it (review L2 of 5592a871: cashback switched off, a layout
   *  the program no longer takes) */
  claimFails?: boolean;
  /** Provider B alone errs on the frame carrying PumpSwap's claim_cashback, its first `n` simulations of it (review M1
   *  of 11c963f9: a lagging backend, a stale balancer, one hostile provider) */
  claimErrOnB?: number;
  /** Provider B throttled once the sell has landed (the devnet run at 0068524a: onfinality's HTTP 429s, each call failing
   *  after page-rpc's own retries): from the first read of W's token account ("read") or the first teardown simulation
   *  ("simulate"), B's next `n` calls fail as the page's RPC fails them */
  throttle?: { on: "read" | "simulate"; n: number };
  /** The first sell's deposit meets a page another deposit filled first: it fails WrongAccount on chain (review L2),
   *  W paying its fee, nothing else moving */
  wrongAccountOnce?: boolean;
  /** getTransaction never finds a teardown frame (one provider slow to index; review M2) */
  unreadTeardown?: boolean;
  /** The first teardown frame fails on chain on both RPCs (review M-A): "dust", a third party sends one token unit to
   *  W's token account just before its close lands; "once", the frame fails with nothing moved */
  teardownFails?: "dust" | "once";
  /** With wrongAccountOnce: the deposit that fills the page first is on the return note's own precommitment (the
   *  user's own deposit from another device), so the sell's note is taken, never dropped (review L-A) */
  wrongAccountTakes?: boolean;
  /** getLatestBlockhash's blockhash (BLOCKHASH when not given): a later load's, so a frame built again is a new one */
  blockhash?: string;
  /** leaves on the label tree (`leaves` when not given): releases grow the state tree alone, so the trees drift apart */
  labelLeaves?: number;
  /** one state leaf (a release's change note) lands after the sell's reads and before the sell itself (card
   *  pool-senders-next-page): at a page's last slot it carries the sell's state entry onto the next page */
  insertFirst?: boolean;
  /** With insertFirst: how many land (1 when not given), and what each is: "release" (a change note, one state leaf) or
   *  "deposit" (another's deposit, a leaf on both trees) (the delta review of 5059541a, T1 and T2) */
  insertCount?: number;
  insertKind?: "release" | "deposit";
};

/** One chain: the planted accounts, the program's deposit applied to a signed sell. */
function chain(plant: Plant = {}) {
  const v = plant.venue ?? "pump";
  const { mint, mintRead, ata } = VF[v];
  const accounts = new Map<string, Acc>();
  const pool = new Uint8Array(2179);
  pool.set(enc.encode("bfpool01"));
  const pv = new DataView(pool.buffer);
  const n0 = plant.leaves ?? N;
  const l0 = plant.labelLeaves ?? n0;
  pv.setBigUint64(9, BigInt(l0), true); // the nonce: l0 deposits so far (each deposit adds one label; a release, a state leaf alone)
  pv.setBigUint64(49, BigInt(n0), true);
  pv.setBigUint64(49 + 1065, BigInt(l0), true);
  accounts.set(POOL, { owner: PROGRAM, lamports: 1, data: pool });
  // each tree's leaves on its pages of 1,024 (state.rs page_for), each page at its rent for its length, as the program
  // leaves it (review M3: pages planted at 1 lamport hid the top-up)
  const leavesOf = { 0: Array.from({ length: n0 }, (_, i) => 1000n + BigInt(i)), 1: Array.from({ length: l0 }, (_, i) => vaultLabelOf(keccak_256, SCOPE, BigInt(i + 1))) };
  for (const tree of [0, 1] as const) {
    for (let p = 0; p === 0 || p * 1024 < leavesOf[tree].length; p++) {
      const data = pageBytes(tree, leavesOf[tree].slice(p * 1024, (p + 1) * 1024), p);
      for (let i = 0; 16 + i * 72 < data.length; i++) new DataView(data.buffer).setBigInt64(16 + i * 72 + 64, BigInt(p * 1024 + i + 1), true); // each leaf's time, after every leaf before it
      accounts.set(solanaPoolPage(PROGRAM, tree, p * 1024), { owner: PROGRAM, lamports: Number(solanaRentMin(rent, data.length)), data });
    }
  }
  accounts.set(fx.rent.account, { owner: fx.rent.answers[0].owner, lamports: 1, data: base64.decode(fx.rent.answers[0].data) });
  accounts.set(mint, { owner: mintRead.owner, lamports: 1, data: base64.decode(mintRead.data[0]) });
  accounts.set(ata, { owner: mintRead.owner, lamports: plant.ataLamports ?? 1, data: tokenAccount(plant.held ?? AMOUNT, 1, mint) });
  for (const vol of plant.volumes ?? []) {
    // UserVolumeAccumulator: discriminator, user @8, needs_claim @40 (kit checks.ts solanaTeardownPlan)
    const d = new Uint8Array(137);
    d.set(base58.decode(W.address), 8);
    if (vol.owed) d[40] = 1;
    // current_sol_volume @57: volume traded and not yet settled into the accumulator (pump keeps the account open)
    if (vol.unsettled) new DataView(d.buffer).setBigUint64(57, 1n, true);
    const uva = solanaVolumeAccumulator(W.address, vol.program);
    // PumpSwap cashback owed (card solana-teardown-cashback): cashback_earned @74, its WSOL in the account's own WSOL
    // account, a native SPL Token account of the volume account holding it on top of its rent
    // cashback_claimed @82 (pump's stable_cashback_claimed @98): what was claimed already, so what is owed is the rest
    if (vol.cashback !== undefined && vol.program === SOLANA_PUMP_AMM_PROGRAM) {
      new DataView(d.buffer).setBigUint64(74, vol.cashback, true);
      const left = vol.cashback - (vol.claimed ?? 0n);
      if (vol.claimed !== undefined) new DataView(d.buffer).setBigUint64(82, vol.claimed, true);
      accounts.set(solanaAta(uva, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), { owner: SOLANA_TOKEN_PROGRAM, lamports: Number(rentMin(165) + left), data: nativeAccount(uva, left) });
    }
    if (vol.claimed !== undefined && vol.program === SOLANA_PUMP_PROGRAM) new DataView(d.buffer).setBigUint64(98, vol.claimed, true);
    // pump's stable cashback owed (stable_cashback_earned @90), with no USDC in the volume account's own account to pay it
    if (vol.stable !== undefined && vol.program === SOLANA_PUMP_PROGRAM) new DataView(d.buffer).setBigUint64(90, vol.stable, true);
    accounts.set(uva, { owner: vol.program, lamports: Number(solanaRentMin(rent, 137)), data: d });
  }
  // W at 0 lamports has no account
  if (plant.lamports !== 0) accounts.set(W.address, { owner: "11111111111111111111111111111111", lamports: plant.lamports ?? ENOUGH, data: new Uint8Array(0) });
  const ammVol = solanaVolumeAccumulator(W.address, SOLANA_PUMP_AMM_PROGRAM);
  const ammAta = solanaAta(ammVol, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM);
  if (plant.ammCashback || plant.ammOnly === "volume") accounts.set(ammVol, { owner: SOLANA_PUMP_AMM_PROGRAM, lamports: 1, data: new Uint8Array(137) });
  if (plant.ammCashback || plant.ammOnly === "ata") accounts.set(ammAta, { owner: SOLANA_TOKEN_PROGRAM, lamports: 1, data: new Uint8Array(165) });
  if (plant.ammVolumeSystem) accounts.set(ammVol, { owner: "11111111111111111111111111111111", lamports: 890_880, data: new Uint8Array(0) });
  const txs = new Map<string, { tx: Uint8Array; err: unknown }>();
  const log: string[] = [];
  const sentTx = new Map<string, Uint8Array>();
  const calls: { p: 0 | 1; method: string; params: readonly unknown[] }[] = [];

  /** The program's deposit of `value` on `pre`: the next nonce's label, both leaves, the mark. */
  const deposit = (pre: bigint, value: bigint): void => {
    const mark = markOf(pre);
    if (accounts.get(mark)?.owner === PROGRAM) throw new Error("PrecommitmentAlreadyUsed");
    const nonce = pv.getBigUint64(9, true) + 1n;
    const label = vaultLabelOf(keccak_256, SCOPE, nonce);
    for (const [tree, leaf] of [[0, noteCommitment(value, label, pre)], [1, label]] as const) {
      const size = Number(pv.getBigUint64(tree === 0 ? 49 : 49 + 1065, true));
      const at = solanaPoolPage(PROGRAM, tree, size);
      const pg = accounts.get(at) ?? { owner: PROGRAM, lamports: 0, data: pageBytes(tree, [], Math.floor(size / 1024)) };
      const entry = new Uint8Array(72);
      entry.set(be32(leaf), 0);
      new DataView(entry.buffer).setBigInt64(64, BigInt(size + 1), true); // its time, after every leaf before it
      const data = new Uint8Array(pg.data.length + 72);
      data.set(pg.data);
      data.set(entry, pg.data.length);
      // state.rs: the page topped up to its rent at its new length, less what it held (a new one: created at it)
      accounts.set(at, { ...pg, data, lamports: Math.max(pg.lamports, Number(solanaRentMin(rent, data.length))) });
    }
    pv.setBigUint64(9, nonce, true);
    pv.setBigUint64(49, pv.getBigUint64(49, true) + 1n, true);
    pv.setBigUint64(49 + 1065, pv.getBigUint64(49 + 1065, true) + 1n, true);
    const md = new Uint8Array(17);
    new DataView(md.buffer).setBigUint64(0, value, true);
    new DataView(md.buffer).setBigUint64(8, nonce, true);
    md[16] = 1;
    accounts.set(mark, { owner: PROGRAM, lamports: Math.max(accounts.get(mark)?.lamports ?? 0, Number(solanaRentMin(rent, 17))), data: md });
  };
  /** Each deposit a landed transaction made: its precommitment and value; `sweep` when it was W's sweep (card
   *  sol-buy-rent-back: a transaction of the deposit alone). */
  const deposits: { pre: bigint; value: bigint; sweep: boolean }[] = [];
  let throttled = 0;
  let claimErred = 0;
  let wrongDone = false;
  let insertDone = false;
  let tearFailed = false;
  /** What a deposit on `pre` takes from its payer beyond its value, as the program prices it (state.rs create_pda and
   *  the page insert): the mark and each page topped up to its rent at its new length, less what it holds. */
  const rentsOf = (pre: bigint): bigint => {
    const need = (at: string, len: number): bigint => {
      const n = solanaRentMin(rent, len) - BigInt(accounts.get(at)?.lamports ?? 0);
      return n > 0n ? n : 0n;
    };
    let total = need(markOf(pre), 17);
    for (const tree of [0, 1] as const) {
      const size = Number(pv.getBigUint64(tree === 0 ? 49 : 49 + 1065, true));
      total += need(solanaPoolPage(PROGRAM, tree, size), 16 + ((size % 1024) + 1) * 72);
    }
    return total;
  };
  /** A teardown frame (card sol-buy-rent-back) as the programs run it, on `on`: each CloseAccount and volume close
   *  moves its account's lamports to W and removes it (a token account holding any token fails), W pays one fee. */
  const teardown = (m: ReturnType<typeof solanaDecodeMessage>, signer: string, on: Map<string, Acc>): void => {
    for (const ix of m.instructions) {
      const program = m.staticKeys[ix.programIndex]!;
      const keys = ix.accounts.map((i) => m.staticKeys[i]!);
      if (program === SOLANA_COMPUTE_BUDGET_PROGRAM) continue;
      let close: string;
      let to: string;
      if (program === SOLANA_ATA_PROGRAM && ix.data.length === 1 && ix.data[0] === 1) {
        // CreateIdempotent: the payer funds a token account of the owner's at the associated address
        const [payer, at, owner, mint] = keys as [string, string, string, string];
        if (at !== solanaAta(owner, mint, keys[5]!)) throw new Error("InvalidSeeds");
        if (on.has(at)) continue;
        const r = Number(rentMin(165));
        if (on.get(payer)!.lamports < r) throw new Error("InsufficientFunds");
        on.set(payer, { ...on.get(payer)!, lamports: on.get(payer)!.lamports - r });
        on.set(at, { owner: keys[5]!, lamports: r, data: mint === SOLANA_SOL_MINT ? nativeAccount(owner, 0n) : new Uint8Array(165) });
        continue;
      }
      if (program === SOLANA_PUMP_AMM_PROGRAM && ix.data.every((b, i) => b === SOLANA_CLAIM_CASHBACK[i]) && ix.data.length === 8) {
        // claim_cashback: what the volume account owes, from its WSOL account to the user's (which must exist)
        const [user, uva, , , from, to2] = keys as [string, string, string, string, string, string];
        const u = on.get(uva)!;
        const owed = new DataView(u.data.buffer).getBigUint64(74, true) - new DataView(u.data.buffer).getBigUint64(82, true);
        const f = on.get(from);
        const t = on.get(to2);
        if (uva !== solanaVolumeAccumulator(user, SOLANA_PUMP_AMM_PROGRAM) || from !== solanaAta(uva, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM) || to2 !== solanaAta(user, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM)) throw new Error("ConstraintSeeds");
        if (!t || !f) throw new Error("AccountNotInitialized");
        if (plant.claimFails) throw new Error("CashbackDisabled");
        const ud = Uint8Array.from(u.data);
        new DataView(ud.buffer).setBigUint64(82, new DataView(ud.buffer).getBigUint64(74, true), true);
        on.set(uva, { ...u, data: ud });
        const move = (a: Acc, by: bigint): Acc => { const d = Uint8Array.from(a.data); const dv = new DataView(d.buffer); dv.setBigUint64(64, dv.getBigUint64(64, true) + by, true); return { ...a, lamports: a.lamports + Number(by), data: d }; };
        on.set(from, move(f, -owed));
        on.set(to2, move(t, owed));
        continue;
      }
      if ((program === SOLANA_TOKEN_PROGRAM || program === TOKEN_2022) && ix.data.length === 1 && ix.data[0] === 9) {
        [close, to] = [keys[0]!, keys[1]!];
        const a = on.get(close);
        const native = a && new DataView(a.data.buffer, a.data.byteOffset + 109, 4).getUint32(0, true) === 1;
        if (!a || (!native && new DataView(a.data.buffer, a.data.byteOffset + 64, 8).getBigUint64(0, true) !== 0n)) throw new Error("NonNativeHasBalance");
      } else if ((program === SOLANA_PUMP_PROGRAM || program === SOLANA_PUMP_AMM_PROGRAM) && ix.data.every((b, i) => b === SOLANA_CLOSE_VOLUME_ACCUMULATOR[i]) && ix.data.length === 8) {
        [close, to] = [keys[1]!, keys[0]!];
        if (keys[0] !== signer || on.get(close)?.owner !== program) throw new Error("ConstraintSeeds");
      } else throw new Error(`not a teardown instruction: ${program}`);
      const a = on.get(close);
      const dest = on.get(to);
      if (!a || !dest) throw new Error("AccountNotFound");
      on.set(to, { ...dest, lamports: dest.lamports + a.lamports });
      on.delete(close);
    }
    const payer = on.get(signer)!;
    const left = payer.lamports - FEE;
    if (left < 0 || (left > 0 && left < Number(solanaRentMin(rent, 0)))) throw new Error("InsufficientFundsForRent");
    on.set(signer, { ...payer, lamports: left });
  };
  /** The sell's deposit (its last instruction) as the program runs it, or a teardown frame; `dry`: checked only (a
   *  simulation), a teardown frame's post-state given back. A landed sell pays W its min out for the tokens sold, and
   *  every deposit takes its value, its fee and its rents from W (contracts/pool-solana/src/deposit.rs). */
  const apply = (tx: Uint8Array, dry: boolean): Map<string, Acc> | void => {
    const message = tx.subarray(1 + 64 * tx[0]!);
    const m = solanaDecodeMessage(message);
    const signer = m.staticKeys[0]!;
    if (!dry && !ed25519.verify(tx.subarray(1, 65), message, base58.decode(signer))) throw new Error("signature");
    const ix = m.instructions.at(-1)!;
    const keys = ix.accounts.map((i) => m.staticKeys[i]!);
    if (m.staticKeys[ix.programIndex] !== PROGRAM) {
      const on = dry ? new Map(accounts) : accounts;
      teardown(m, signer, on);
      return on;
    }
    if (ix.data[0] !== 1 || keys[0] !== POOL || keys[1] !== signer) throw new Error("not a deposit into the pool");
    const value = new DataView(ix.data.buffer, ix.data.byteOffset + 1, 8).getBigUint64(0, true);
    const pre = beInt(ix.data.subarray(9, 41));
    if (accounts.get(markOf(pre))?.owner === PROGRAM) throw new Error("PrecommitmentAlreadyUsed");
    // state.rs page_for (since d3edab1): each tree's entry goes on the page its size now names, which the deposit names
    // as account 2 or 3, or as account 6 or 7 when it names the next pages; any other page fails WrongAccount
    for (const tree of [0, 1] as const) {
      const at = solanaPoolPage(PROGRAM, tree, Number(pv.getBigUint64(tree === 0 ? 49 : 49 + 1065, true)));
      if (keys[2 + tree] !== at && !(keys.length === 8 && keys[6 + tree] === at)) throw new Error("WrongAccount");
    }
    const cost = BigInt(FEE) + rentsOf(pre);
    // the venue's sell first: what W gets, less the cashback accounts it makes at W's cost
    const sellIx = m.instructions.find((x) => x.data.length === 24);
    let gets = 0n;
    if (sellIx) {
      gets = new DataView(sellIx.data.buffer, sellIx.data.byteOffset + 16, 8).getBigUint64(0, true);
      if (m.staticKeys[sellIx.programIndex] === SOLANA_PUMP_AMM_PROGRAM && plant.cashback) {
        for (const [x, owner, size] of [[ammVol, SOLANA_PUMP_AMM_PROGRAM, 137], [ammAta, SOLANA_TOKEN_PROGRAM, 165]] as const) if (accounts.get(x)?.owner !== owner) gets -= solanaRentMin(rent, size);
      }
    }
    // the runtime: W pays it all, and ends at 0 or rent-exempt (a system account at 0 data needs rent(0))
    const ends = BigInt(accounts.get(signer)?.lamports ?? 0) + gets - value - cost;
    if (ends < 0n) throw new Error("InsufficientFunds");
    if (ends > 0n && ends < solanaRentMin(rent, 0)) throw new Error("InsufficientFundsForRent");
    if (dry) return;
    deposit(pre, value);
    // the venue's sell (pump's and PumpSwap's sell(amount, min_out), 24 data bytes): W's tokens out, its min out in
    const sell = m.instructions.find((x) => x.data.length === 24);
    let got = 0n;
    if (sell) {
      const sold = new DataView(sell.data.buffer, sell.data.byteOffset + 8, 8).getBigUint64(0, true);
      got = new DataView(sell.data.buffer, sell.data.byteOffset + 16, 8).getBigUint64(0, true);
      const t = accounts.get(ata)!;
      const d = t.data.slice();
      const dv = new DataView(d.buffer, 64, 8);
      dv.setBigUint64(0, dv.getBigUint64(0, true) - sold, true);
      accounts.set(ata, { ...t, data: d });
      // a PumpSwap sell of a cashback coin makes W's cashback accounts it lacks, at W's cost (pool-sell.ts's `made`)
      if (m.staticKeys[sell.programIndex] === SOLANA_PUMP_AMM_PROGRAM && plant.cashback) {
        for (const [x, owner, size] of [[ammVol, SOLANA_PUMP_AMM_PROGRAM, 137], [ammAta, SOLANA_TOKEN_PROGRAM, 165]] as const) {
          if (accounts.get(x)?.owner === owner) continue;
          got -= solanaRentMin(rent, size);
          accounts.set(x, { owner, lamports: Number(solanaRentMin(rent, size)), data: new Uint8Array(size) });
        }
      }
    }
    deposits.push({ pre, value, sweep: m.instructions.length === 1 });
    const wa = accounts.get(signer);
    if (wa) {
      const left = BigInt(wa.lamports) + got - value - cost;
      if (left < 0n) throw new Error("InsufficientFunds");
      if (left === 0n) accounts.delete(signer);
      else accounts.set(signer, { ...wa, lamports: Number(left) });
    }
  };

  const rpc = (p: 0 | 1): SolanaRpc => {
    const answer = (address: string): unknown => {
      if (p === 1 && plant.hideOn1 === address) return null;
      if (p === 1 && plant.ammHiddenOn1 && (address === ammVol || address === ammAta)) return null;
      if (p === 1 && plant.owedOn1BeforeSell && deposits.length === 0 && (address === ammVol || address === solanaVolumeAccumulator(W.address, SOLANA_PUMP_PROGRAM))) {
        const d = new Uint8Array(137);
        d.set(base58.decode(W.address), 8);
        new DataView(d.buffer).setBigUint64(address === ammVol ? 74 : 90, 12_742_862n, true);
        return { owner: address === ammVol ? SOLANA_PUMP_AMM_PROGRAM : SOLANA_PUMP_PROGRAM, lamports: Number(solanaRentMin(rent, 137)), data: [base64.encode(d), "base64"], executable: false, rentEpoch: 0, space: 137 };
      }
      const held = accounts.get(address);
      if (!held) return null;
      const a = plant.mapOn ? plant.mapOn(p, address, held) : held;
      const data = p === 1 && address === ata && plant.heldOn1 !== undefined ? tokenAccount(plant.heldOn1, 1, mint) : a.data;
      return { owner: a.owner, lamports: a.lamports, data: [base64.encode(data), "base64"], executable: false, rentEpoch: 0, space: data.length };
    };
    const ctx = { context: { slot: VF[v].slot } };
    return (async (method: string, params: readonly unknown[]) => {
      log.push(`${p}:${method}`);
      calls.push({ p, method, params });
      if (p === 1 && plant.throttle && deposits.length > 0 && throttled < plant.throttle.n) {
        const list = method === "getMultipleAccounts" ? (params[0] as string[]) : method === "getAccountInfo" ? [params[0] as string] : [];
        const hit = plant.throttle.on === "read" ? list.includes(ata) : method === "simulateTransaction" && (params[1] as { accounts?: unknown }).accounts !== undefined;
        if (throttled > 0 || hit) {
          throttled++;
          throw new SolanaRpcTransportError("http_429", "HTTP 429", 4, "solana-devnet.api.onfinality.io");
        }
      }
      switch (method) {
        case "getMultipleAccounts": {
          const recorded = fx[v].reads[p][JSON.stringify(params[0])];
          if (recorded && plant.curveCashback) {
            // the bonding curve (owned by pump, under 300 bytes): its cashback byte set
            const r = structuredClone(recorded) as { value: ({ owner: string; data: [string, string] } | null)[] };
            for (const a of r.value) {
              if (a?.owner !== SOLANA_PUMP_PROGRAM) continue;
              const d = base64.decode(a.data[0]);
              if (d.length < 83 || d.length >= 300) continue;
              d[82] = 1;
              a.data[0] = base64.encode(d);
            }
            return r;
          }
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
          return { ...ctx, value: { blockhash: plant.blockhash ?? BLOCKHASH, lastValidBlockHeight: 100 } };
        case "isBlockhashValid":
          return { ...ctx, value: true };
        case "getBlockHeight":
          // confirmed: RPC 1's height beside the blockhash, so the last height is max(100, 0 + 151) = 151
          return (params[0] as { commitment: string }).commitment === "confirmed" ? 0 : (plant.finalHeight ?? 1_000);
        case "getEpochInfo":
          // finalized: each RPC's height and, of the same block, its slot, which pins its mark read (minContextSlot)
          assert.equal((params[0] as { commitment: string }).commitment, "finalized");
          return { blockHeight: plant.finalHeight ?? 1_000, absoluteSlot: VF[v].slot + 10 + p, epoch: 1, slotIndex: 0, slotsInEpoch: 432_000 };
        case "getFeeForMessage":
          return { ...ctx, value: FEE };
        case "simulateTransaction": {
          const tx = base64.decode(params[0] as string);
          assert.equal((params[1] as { sigVerify: boolean }).sigVerify, false);
          assert.deepEqual(tx.subarray(1, 65), new Uint8Array(64), "simulated unsigned");
          try {
            if (p === 1 && plant.simFailOn1) throw new Error("InsufficientFunds");
            if (p === 1 && claimErred < (plant.claimErrOnB ?? 0)) {
              const sm = solanaDecodeMessage(tx.subarray(65));
              if (sm.instructions.some((x) => sm.staticKeys[x.programIndex] === SOLANA_PUMP_AMM_PROGRAM && x.data.length === 8 && x.data.every((b, i) => b === SOLANA_CLAIM_CASHBACK[i]))) {
                claimErred++;
                throw new Error("BlockhashNotFound");
              }
            }
            const after = apply(tx, true);
            const want = (params[1] as { accounts?: { addresses: string[] } }).accounts?.addresses;
            if (want && after) {
              const read = (x: string) => {
                const a = after.get(x);
                return a ? { owner: a.owner, lamports: a.lamports, data: [base64.encode(a.data), "base64"], executable: false, rentEpoch: 0, space: a.data.length } : null;
              };
              return { ...ctx, value: { err: null, logs: [], accounts: want.map(read) } };
            }
            return { ...ctx, value: { err: null, logs: [] } };
          } catch (e) {
            return { ...ctx, value: { err: String(e), logs: [] } };
          }
        }
        case "sendTransaction": {
          const tx = base64.decode(params[0] as string);
          const sig = base58.encode(tx.subarray(1, 65));
          sentTx.set(sig, tx);
          if (plant.frontRun && !accounts.has(markOf(preOf(RETURN)))) deposit(preOf(RETURN), FRONT_RUN); // the least the program takes
          if (plant.frontRunSame && !accounts.has(markOf(preOf(RETURN)))) {
            const m = solanaDecodeMessage(tx.subarray(65));
            const dep = m.instructions.at(-1)!;
            deposit(preOf(RETURN), new DataView(dep.data.buffer, dep.data.byteOffset + 1, 8).getBigUint64(0, true));
          }
          const sm = solanaDecodeMessage(tx.subarray(65));
          if (plant.wrongAccountOnce && !wrongDone && sm.instructions.length > 1 && sm.staticKeys[sm.instructions.at(-1)!.programIndex] === PROGRAM) {
            wrongDone = true;
            // another's deposit landed first, at the tree size this one was built for
            deposit(plant.wrongAccountTakes ? preOf(RETURN) : 424_242n, 1_000_000n);
            txs.set(sig, { tx, err: { InstructionError: [sm.instructions.length - 1, { Custom: 22 }] } });
            const payer = accounts.get(sm.staticKeys[0]!)!;
            accounts.set(sm.staticKeys[0]!, { ...payer, lamports: payer.lamports - FEE });
            return sig;
          }
          if (plant.teardownFails && !tearFailed && !txs.has(sig) && !sm.instructions.some((x) => sm.staticKeys[x.programIndex] === PROGRAM)) {
            tearFailed = true;
            if (plant.teardownFails === "dust") {
              const t = accounts.get(ata)!;
              accounts.set(ata, { ...t, data: tokenAccount(1n, 1, mint) });
            } else {
              txs.set(sig, { tx, err: { InstructionError: [0, "planted"] } });
              return sig;
            }
          }
          if (plant.insertFirst && !insertDone && sm.staticKeys[sm.instructions.at(-1)!.programIndex] === PROGRAM) {
            insertDone = true;
            for (let k = 0; k < (plant.insertCount ?? 1); k++) {
              // another's deposit: a leaf on both trees, on another precommitment
              if (plant.insertKind === "deposit") {
                deposit(900_000n + BigInt(k), 1_000_000n);
                continue;
              }
              // a release's change note: one state leaf at the state tree's size, its page topped up by its payer
              const size = Number(pv.getBigUint64(49, true));
              const at = solanaPoolPage(PROGRAM, 0, size);
              const pg = accounts.get(at) ?? { owner: PROGRAM, lamports: 0, data: pageBytes(0, [], Math.floor(size / 1024)) };
              const data = new Uint8Array(pg.data.length + 72);
              data.set(pg.data);
              data.set(be32(777_777n), pg.data.length);
              new DataView(data.buffer).setBigInt64(pg.data.length + 64, BigInt(size + 1), true);
              accounts.set(at, { ...pg, data, lamports: Math.max(pg.lamports, Number(solanaRentMin(rent, data.length))) });
              pv.setBigUint64(49, BigInt(size + 1), true);
            }
          }
          if (!txs.has(sig) && plant.lands !== false) {
            try {
              apply(tx, false);
              txs.set(sig, { tx, err: null });
            } catch (e) {
              // the program's WrongAccount (Custom 22) at the deposit, the last instruction: W pays its fee, nothing else moves
              if (String(e).includes("WrongAccount")) {
                txs.set(sig, { tx, err: { InstructionError: [sm.instructions.length - 1, { Custom: 22 }] } });
                const payer = accounts.get(sm.staticKeys[0]!)!;
                accounts.set(sm.staticKeys[0]!, { ...payer, lamports: payer.lamports - FEE });
              } else txs.set(sig, { tx, err: { InstructionError: [0, String(e)] } });
            }
          }
          return sig;
        }
        case "getTransaction": {
          const sent = sentTx.get(params[0] as string);
          if (plant.metaJunk && sent) return { slot: VF[v].slot, transaction: [base64.encode(sent), "base64"], meta: "x" };
          const t = txs.get(params[0] as string);
          if (t && plant.unreadTeardown) {
            const tm = solanaDecodeMessage(t.tx.subarray(65));
            if (!tm.instructions.some((x) => tm.staticKeys[x.programIndex] === PROGRAM)) return null;
          }
          return t ? { slot: VF[v].slot, transaction: [base64.encode(t.tx), "base64"], meta: { err: t.err } } : null;
        }
        default:
          throw new Error(`no fixture for ${method}`);
      }
    }) as SolanaRpc;
  };
  return { accounts, deposit, deposits, rpcs: [rpc(0), rpc(1)] as const, txs, log, calls };
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
type World = { c: ReturnType<typeof chain>; ns: NoteStore; store: WalletStore; host: PoolSellHost; seeds: Uint8Array[]; sent: string[]; owed: Map<string, OwedRentBack>; told: RentBackTold[] };
async function world(plant: Plant = {}, wallets: BuyWallet[] = [wallet(AMOUNT, false, VF[plant.venue ?? "pump"].mint)]): Promise<World> {
  const c = chain(plant);
  const { store, ns } = await notes();
  const seeds: Uint8Array[] = [];
  const sent: string[] = [];
  const owed = new Map<string, OwedRentBack>();
  const told: RentBackTold[] = [];
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
    owed: { list: async () => [...owed.values()].map((o) => structuredClone(o)), put: async (r) => void owed.set(r.address, structuredClone(r)), drop: async (a) => void owed.delete(a) },
    told: (t) => void told.push(t),
    now: () => 1_000n,
    reads: 3,
    wait: async () => {},
    pick: () => 2,
  };
  return { c, ns, store, host, seeds, sent, owed, told };
}
/** The settle a state read runs (review L6: the sweep's verdict is the next read's, not the sell lock's). */
const settle = (w: World) => settlePoolSells(w.host, fakeLocks());
const ours = async (ns: NoteStore) => (await ns.list()).filter((n) => n.scope === SCOPE).map((n) => ({ ref: n.ref, state: n.state, value: n.leaf?.value, leafIndex: n.leaf?.leafIndex }));
const rentMin = (size: number): bigint => solanaRentMin(rent, size);
/** What a sell that empties W keeps (card sol-w-sweep), and the note a default world's full sell makes: min out and W's
 *  surplus over the sell's fee, the mark's rent, both pages' growth and that. */
const AFTER = solanaSellAfterFull(rent);
// on a cashback coin, also a later claim's cost (card sol-w-sweep: solanaSweepKeep for one volume account)
const AFTER_CB = solanaSellAfterFull(rent, 1);
const FULL = MIN_OUT + BigInt(ENOUGH) - BigInt(FEE) - rentMin(17) - 2n * 72n * rent.lamportsPerByte * rent.factor - AFTER;
const sends = (w: World) => w.c.log.filter((x) => x.endsWith("sendTransaction"));
/** The notes of W's sells, without its sweep's (card sol-buy-rent-back: after a full sell, every lamport W holds goes
 *  back as its next return note). */
const sells = (w: World, notes: Awaited<ReturnType<typeof ours>>) => notes.filter((n) => !w.c.deposits.some((d) => d.sweep && d.pre === preOf(n.ref)));

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
  assert.deepEqual(sells(w, await ours(w.ns)), [{ ref: RETURN, state: "UNSPENT", value: FULL, leafIndex: BigInt(N) }]);
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
  assert.equal(new DataView(dep.data.buffer, dep.data.byteOffset + 1, 8).getBigUint64(0, true), FULL, "W's surplus with min out: W keeps its fee, the rents and what the sweep needs");
  assert.equal(beInt(dep.data.subarray(9, 41)), preOf(RETURN));
  // simulated on both before W is derived; sent on both
  const log = w.c.log;
  const signSeed = log.lastIndexOf("seed");
  assert.ok(log.indexOf("0:simulateTransaction") < signSeed && log.indexOf("1:simulateTransaction") < signSeed, log.join(" "));
  // the sell's own sends come first (the rent back's follow it: sol-buy-rent-back's tests)
  const sellSig = "stage" in a ? a.txs[0]!.hash : "";
  assert.deepEqual(w.c.calls.filter((c) => c.method === "sendTransaction" && base58.encode(base64.decode(c.params[0] as string).subarray(1, 65)) === sellSig).map((c) => c.p).sort(), [0, 1]);
  assert.ok(w.seeds.length >= 1 && w.seeds.every((s) => s.every((b) => b === 0)), "every seed copy zeroed");
});

test("a W short of lamports keeps them on W: the reserve is its fee, the mark's rent and the pages' growth up to what the rent back's sweep needs (solanaSellAfterFull)", async () => {
  const lamports = 1_000_000;
  const w = await world({ lamports });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled");
  const reserve = BigInt(FEE) + rentMin(17) + 2n * 72n * rent.lamportsPerByte * rent.factor + AFTER - BigInt(lamports);
  assert.ok(reserve > 0n);
  assert.deepEqual(await ours(w.ns), [{ ref: RETURN, state: "UNSPENT", value: MIN_OUT - reserve, leafIndex: BigInt(N) }]);
});

test("an amount over W's holding as both RPCs read it is not_funded; two RPCs that read different amounts are read again once, then failed, the higher never taken: nothing derived, signed or sent", async () => {
  const w = await world({ held: AMOUNT - 1n });
  assert.deepEqual(await runPoolSell(w.host, ASK), { error: "not_funded" });
  assert.equal(w.seeds.length, 0, "the seed never read");
  assert.ok(!w.c.log.some((x) => /simulateTransaction|sendTransaction/.test(x)));
  assert.deepEqual(await ours(w.ns), []);
  // the second re-review (low): RPC 1 reads less, or more (a whole sale it would make look partial, keeping the next
  // sell's need on an empty W): read again once, then failed
  for (const heldOn1 of [AMOUNT - 1n, 2n * AMOUNT]) {
    const x = await world({ heldOn1 }, [wallet(2n * AMOUNT)]);
    assert.deepEqual(await runPoolSell(x.host, ASK), { error: "failed" }, String(heldOn1));
    assert.deepEqual([0, 1].map((p) => x.c.calls.filter((c) => c.p === p && c.method === "getAccountInfo" && c.params[0] === ATA).length), [2, 2], "read twice on each");
    assert.equal(x.seeds.length, 0, "the seed never read");
    assert.ok(!x.c.log.some((l) => /simulateTransaction|sendTransaction/.test(l)));
  }
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
  assert.deepEqual({ ref: n!.ref, state: n!.state, sends: n!.sends }, { ref: RETURN, state: "INCOMING", sends: [{ signature: sig, value: FULL, last_valid_block_height: 151n }] });
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
  assert.deepEqual(sells(w, await ours(w.ns)), [{ ref: RETURN, state: "UNSPENT", value: FULL, leafIndex: BigInt(N) }]);
});

test("card pool-deposits I-3, every path: a stranger's system account at the return note's mark is no mark: the sell is planned and sent, its drop read as dropped (never pending for ever), and the next sell takes the account over and fills", async () => {
  const plant: Plant = { lands: false };
  const w = await world(plant);
  const at = markOf(preOf(RETURN));
  w.c.accounts.set(at, { owner: "11111111111111111111111111111111", lamports: 1_000_000, data: new Uint8Array(0) });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "not_landed", JSON.stringify(a));
  const [n] = (await w.ns.list()).filter((x) => x.scope === SCOPE);
  assert.deepEqual({ ref: n!.ref, state: n!.state }, { ref: RETURN, state: "PLANNED" });
  plant.lands = true;
  const b = await runPoolSell(w.host, ASK);
  assert.equal("stage" in b && b.stage, "filled", JSON.stringify(b));
  assert.deepEqual(sells(w, await ours(w.ns)), [{ ref: RETURN, state: "UNSPENT", value: FULL + rentMin(17), leafIndex: BigInt(N) }]);
  assert.equal(w.c.accounts.get(at)!.owner, PROGRAM);
});

test("another deposit takes the return note's precommitment first: the sell fails on chain as a whole, refused, and that deposit is stored as the user's own note (only the seed names it)", async () => {
  const w = await world({ frontRun: true });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "refused");
  assert.deepEqual(await ours(w.ns), [{ ref: RETURN, state: "UNSPENT", value: FRONT_RUN, leafIndex: BigInt(N) }]);
  // the sell dropped, its precommitment taken by another deposit of another value: not the sale's deposit (not
  // filled), and it can never land (its deposit would be refused): not_landed, the note stored with the mark's value
  const x = await world({ frontRun: true, lands: false });
  const b = await runPoolSell(x.host, ASK);
  assert.equal("stage" in b && b.stage, "not_landed");
  assert.deepEqual(await ours(x.ns), [{ ref: RETURN, state: "UNSPENT", value: FRONT_RUN, leafIndex: BigInt(N) }]);
  // the next sell of that W takes R 0
  const c = await runPoolSell(w.host, ASK);
  assert.equal("stage" in c && c.stage, "filled");
  assert.deepEqual((await ours(w.ns)).find((n) => n.leafIndex === BigInt(N + 1))?.ref, SECOND(0));
});

test("a mark already on both RPCs for the return note, not in the store, is the user's own: adopted UNSPENT with its leaf, and the sell takes second arrival 0", async () => {
  // W's token account at its real rent, which the teardown returns for the sweep (solanaSellAfterFull counts on it)
  const w = await world({ ataLamports: TOKEN_RENT });
  w.c.deposit(preOf(RETURN), 12_345_678n);
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled");
  await settle(w);
  const got = await ours(w.ns);
  assert.deepEqual(sells(w, got).sort((x, y) => Number(x.leafIndex! - y.leafIndex!)), [
    { ref: RETURN, state: "UNSPENT", value: 12_345_678n, leafIndex: BigInt(N) },
    { ref: SECOND(0), state: "UNSPENT", value: FULL, leafIndex: BigInt(N + 1) },
  ]);
  // the refs the store holds are passed over: the full sell's sweep took second arrival 1, so W, given the coin and
  // lamports again, sells into second arrival 2
  assert.deepEqual(got.find((n) => n.leafIndex === BigInt(N + 2))?.ref, SECOND(1));
  w.c.accounts.set(ATA, { owner: TOKEN_PROGRAM, lamports: 1, data: tokenAccount(AMOUNT) });
  w.c.accounts.set(W.address, { owner: "11111111111111111111111111111111", lamports: ENOUGH, data: new Uint8Array(0) });
  const b = await runPoolSell(w.host, ASK);
  assert.equal("stage" in b && b.stage, "filled");
  assert.deepEqual((await ours(w.ns)).find((n) => n.leafIndex === BigInt(N + 3))?.ref, SECOND(2));
});

test("a mark for the return note on one RPC only is that RPC's word against the other's: failed, nothing sent or stored", async () => {
  const w = await world({ hideOn1: markOf(preOf(RETURN)) });
  w.c.deposit(preOf(RETURN), 12_345_678n);
  assert.deepEqual(await runPoolSell(w.host, ASK), { error: "failed" });
  assert.ok(!w.c.log.some((x) => /getLatestBlockhash|simulateTransaction|sendTransaction/.test(x)), "refused at the walk, before the quote");
  assert.deepEqual(await ours(w.ns), []);
});

test("card pool-answer-unknown (review S2): a mark for the return note the two RPCs give at two values is neither's word: failed, nothing sent or stored", async () => {
  const pre = markOf(preOf(RETURN));
  const w = await world({ mapOn: (p, address, a) => (p === 1 && address === pre ? { ...a, data: (() => { const d = a.data.slice(); new DataView(d.buffer).setBigUint64(0, 12_345_679n, true); return d; })() } : a) });
  w.c.deposit(preOf(RETURN), 12_345_678n);
  assert.deepEqual(await runPoolSell(w.host, ASK), { error: "failed" });
  assert.ok(!w.c.log.some((x) => /sendTransaction/.test(x)), "nothing sent");
  assert.deepEqual(await ours(w.ns), []);
});

test("card pool-answer-unknown (review F5): the pool's, the mint's and the Rent sysvar's balances past 2^53 lamports are never parsed (none is priced): the sell fills", async () => {
  const w = await world({ mapOn: (_, address, a) => (address === POOL || address === MINT || address === fx.rent.account ? { ...a, lamports: 2 ** 60 } : a) });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
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
function fakeLocks(modes: string[] = []): Pick<LockManager, "request" | "query"> {
  const held = new Map<string, Promise<void>>();
  return {
    query: (async () => ({ held: [...held.keys()].map((name) => ({ name, mode: "exclusive" })), pending: [] })) as never,
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
  await until(async () => ended.n > 0);
  assert.equal(ended.n, 1);
  assert.equal(POOL_SELL_LOCK, "ct-pool/sell");
  // the rent back after the full sell: under the sell lock again, once the request's lock is free
  assert.deepEqual(modes, ["ct-wallet/seed:shared", "ct-wallet/trade/r1:exclusive?", "ct-pool/sell:exclusive", "ct-pool/sell:exclusive"]);
  assert.deepEqual(sells(w, await ours(w.ns)).map((n) => n.state), ["UNSPENT"]);
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
  // (the sell's own sends: the first run's rent back may still be sending its own)
  const sellSends = () => w.c.calls.filter((c) => c.method === "sendTransaction" && base58.encode(base64.decode(c.params[0] as string).subarray(1, 65)) === sig).length;
  const sendsBefore = sellSends();
  const again = poolSellKind(kindHost(w), locks)(ASK, ctxOf("t1", "aa")) as KindAnswer;
  await again.after;
  assert.deepEqual(again.answer(), { result: { stage: "filled", txs: [{ chain: "solana", hash: sig }] } });
  assert.equal(sellSends(), sendsBefore, "never sent again");
  assert.equal(w.c.deposits.filter((d) => !d.sweep).length, 1, "one sale");
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
  assert.deepEqual(await ours(ns2), [{ ref: RETURN, state: "UNSPENT", value: FULL, leafIndex: BigInt(N) }]);
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
  assert.deepEqual(sells(w, await ours(w.ns)), [{ ref: RETURN, state: "UNSPENT", value: FULL, leafIndex: BigInt(N) }]);
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
  // the cashback accounts' rent is kept on W, out of the deposit, with the mark's rent, the pages' growth and what the sweep needs
  const reserve = BigInt(FEE) + cashbackRent + rentMin(17) + 2n * 72n * rent.lamportsPerByte * rent.factor + AFTER_CB - need;
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
  assert.deepEqual(await ours(w.ns), [{ ref: RETURN, state: "UNSPENT", value: FULL, leafIndex: BigInt(N) }]);
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
test("a request waiting behind another sell already has its record: a re-ask of its id from another tab is never run again, and the settle leaves it while its lock is held", async () => {
  const w = await world();
  const locks = fakeLocks();
  // another sell holds the sell lock (through its verdict)
  let release!: () => void;
  const held = locks.request(POOL_SELL_LOCK, { mode: "exclusive" }, () => new Promise<void>((r) => (release = r)));
  const r = poolSellKind(kindHost(w), locks)(ASK, ctxOf("p1", "cc")) as KindAnswer;
  await until(async () => (await w.store.get("ops", "p1")) !== undefined);
  assert.equal(((await w.store.get("ops", "p1")) as { stage?: string }).stage, "pending");
  // another tab asks the same id while the first waits: answered, not run
  const again = poolSellKind(kindHost(w), locks)(ASK, ctxOf("p1", "cc")) as KindAnswer;
  await again.after;
  assert.deepEqual(again.answer(), { error: "id_reused" });
  assert.equal(sends(w).length, 0);
  // the settle on load leaves a record whose request's lock is held
  await settleDeadSellOps(w.store, locks);
  assert.equal(((await w.store.get("ops", "p1")) as { stage?: string }).stage, "pending");
  release();
  await held;
  await r.after;
  await until(async () => opOf("p1", await w.store.get("ops", "p1"))?.stage === "filled");
  assert.equal(opOf("p1", await w.store.get("ops", "p1"))?.stage, "filled");
});

// The second re-review (low): a page that closed while its request waited leaves "pending" with no signature. The
// re-ask of that id (its lock now free) answers failed at once, never id_reused; the settle on load takes no lock, so
// a re-ask never meets one it holds, and it leaves a record whose request's lock is held.
test("a dead pending sell record: its re-ask answers failed and sends nothing; the settle on load refuses the others without taking a lock", async () => {
  const w = await world();
  const modes: string[] = [];
  const locks = fakeLocks(modes);
  const pending = { kind: "sell", pool: "sol", sha: "cc", stage: "pending", txs: [], created_ms: 1 };
  for (const k of ["d1", "d2", "d3"]) await w.store.put("ops", k, { ...pending });
  const r = poolSellKind(kindHost(w), locks)(ASK, ctxOf("d1", "cc")) as KindAnswer;
  await r.after;
  assert.deepEqual(r.answer(), { error: "failed" });
  assert.equal(sends(w).length, 0);
  assert.deepEqual(opOf("d1", await w.store.get("ops", "d1")), { id: "d1", kind: "sell", stage: "refused", txs: [], code: "failed" });
  // d3's request is live in another tab: its lock is held through the settle
  let release!: () => void;
  const live = locks.request(tradeLock("d3"), { mode: "exclusive" }, () => new Promise<void>((res) => (release = res)));
  modes.length = 0;
  await settleDeadSellOps(w.store, locks);
  assert.deepEqual(modes, [], "the settle takes no lock");
  assert.deepEqual(opOf("d2", await w.store.get("ops", "d2")), { id: "d2", kind: "sell", stage: "refused", txs: [], code: "failed" });
  assert.equal(((await w.store.get("ops", "d3")) as { stage?: string }).stage, "pending");
  release();
  await live;
});

// The second re-review (high): a sell of part of W's holding left W rent(0), so the next sell of the rest could never
// pay its own fee and up-front accounts. While W keeps tokens, the reserve leaves W the next sell's need on every venue
// the coin can reach (the buy's rule); a sell of the whole holding still keeps only rent(0).
const GROWS = 2n * 72n * rent.lamportsPerByte * rent.factor;
/** W's lamports after a sell whose deposit is `value`, from the fixture's recorded min out: what it paid (the fee, the
 *  accounts it made, the mark and the pages' growth) and what the venue paid it over the deposit. */
const wAfter = (lamports: bigint, minOut: bigint, value: bigint, made = 0n) => lamports - BigInt(FEE) - made - rentMin(17) - GROWS + (minOut - value);
const deposited = async (w: World) => (await ours(w.ns))[0]?.value ?? -1n;

test("a PumpSwap sell of part of W's holding leaves W the next sell's need (the fee and the wrapped-SOL account); a sell of all of it, what the sweep needs (solanaSellAfterFull)", async () => {
  const ask = { ...ASK, token: VF.pumpswap.mint };
  const lamports = BigInt(FEE) + rentMin(165); // exactly this sell's own need
  const next = BigInt(FEE) + rentMin(165);
  const part = await world({ venue: "pumpswap", held: 2n * AMOUNT, lamports: Number(lamports) }, [wallet(2n * AMOUNT, false, VF.pumpswap.mint)]);
  const a = await runPoolSell(part.host, ask);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  assert.equal(wAfter(lamports, VF.pumpswap.minOut, await deposited(part)), next);
  const all = await world({ venue: "pumpswap", lamports: Number(lamports) });
  assert.equal("stage" in (await runPoolSell(all.host, ask)) && "filled", "filled");
  assert.equal(wAfter(lamports, VF.pumpswap.minOut, await deposited(all)), AFTER);
});

test("a curve sell of part of W's holding leaves W the PumpSwap need the coin has once it graduates, with both cashback accounts on a cashback coin", async () => {
  for (const curveCashback of [false, true]) {
    const probe = await world({ curveCashback });
    const venue = await readSolanaPoolBuyVenue(probe.host.rpcs, "pump-curve", MINT);
    assert.equal(venue.cashback, curveCashback, "the planted curve");
    // the next sell, on PumpSwap after graduation, from a W with neither of PumpSwap's cashback accounts
    const next = BigInt(FEE) + rentMin(165) + (curveCashback ? rentMin(137) + rentMin(165) : 0n);
    // W as the buy rule leaves it: exactly that need
    const w = await world({ curveCashback, held: 2n * AMOUNT, lamports: Number(next) }, [wallet(2n * AMOUNT)]);
    const a = await runPoolSell(w.host, ASK);
    assert.equal("stage" in a && a.stage, "filled", `${curveCashback} ${JSON.stringify(a)}`);
    assert.equal(wAfter(next, MIN_OUT, await deposited(w)), next, String(curveCashback));
  }
});

test("a partial sell whose reserve for the next sell passes the cap is refused not_funded before it is simulated or signed, never shrunk; the whole holding still sells", async () => {
  // a cashback curve coin's W at the curve's own need (fee + rent(0), as a buy before 40cdc3e left it): under the cap
  // the sell tops W up to the next PumpSwap need from its proceeds; at a page boundary of both trees as well, keeping
  // that need would hold back more than SOLANA_POOL_SELL_RESERVE_MAX from the note
  const lamports = BigInt(FEE) + rentMin(0);
  const next = BigInt(FEE) + rentMin(165) + rentMin(137) + rentMin(165);
  const topped = await world({ curveCashback: true, held: 2n * AMOUNT, lamports: Number(lamports) }, [wallet(2n * AMOUNT)]);
  const t = await runPoolSell(topped.host, ASK);
  assert.equal("stage" in t && t.stage, "filled", JSON.stringify(t));
  assert.equal(wAfter(lamports, MIN_OUT, await deposited(topped)), next);
  const w = await world({ curveCashback: true, held: 2n * AMOUNT, lamports: Number(lamports), leaves: 1024 }, [wallet(2n * AMOUNT)]);
  assert.deepEqual(await runPoolSell(w.host, ASK), { error: "not_funded" });
  assert.ok(!w.c.log.some((x) => /simulateTransaction|sendTransaction/.test(x)), w.c.log.join(" "));
  assert.deepEqual(await ours(w.ns), [], "no note");
  const all = await world({ curveCashback: true, lamports: Number(lamports), leaves: 1024 });
  const a = await runPoolSell(all.host, ASK);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
});

// The second re-review (low): each PumpSwap cashback account is counted on its own, by its owner, and one RPC that does
// not show it yet is no reason to refuse.
test("W's PumpSwap cashback accounts are counted one by one, by owner, there only when both RPCs show them; a split is read again once, then failed", async () => {
  const ask = { ...ASK, token: VF.pumpswap.mint };
  const base = BigInt(FEE) + rentMin(165);
  const cases: [Plant, bigint][] = [
    [{ ammOnly: "volume" }, rentMin(165)],
    [{ ammOnly: "ata" }, rentMin(137)],
    [{ ammCashback: true }, 0n],
    [{ ammVolumeSystem: true }, rentMin(137) + rentMin(165)],
  ];
  for (const [plant, made] of cases) {
    const at = (lamports: bigint) => world({ venue: "pumpswap", cashback: true, ...plant, lamports: Number(lamports) });
    const ok = await at(base + made);
    const a = await runPoolSell(ok.host, ask);
    assert.equal("stage" in a && a.stage, "filled", `${JSON.stringify(plant)} ${JSON.stringify(a)}`);
    assert.equal(wAfter(base + made, VF.pumpswap.minOut, await deposited(ok), made), AFTER_CB, JSON.stringify(plant));
    if (made > 0n) assert.deepEqual(await runPoolSell((await at(base + made - 1n)).host, ask), { error: "not_funded" }, JSON.stringify(plant));
  }
});

// The second re-review of fd5eec3 (medium): one RPC that says W's cashback accounts are there, the other not, would keep
// their rent off W's budget: read again once, then failed, nothing simulated or signed.
test("W's PumpSwap cashback accounts on one RPC only: read again once, then failed before anything is simulated or signed", async () => {
  const ask = { ...ASK, token: VF.pumpswap.mint };
  const vol = solanaVolumeAccumulator(W.address, SOLANA_PUMP_AMM_PROGRAM);
  const need = BigInt(FEE) + rentMin(165) + rentMin(137) + rentMin(165);
  const w = await world({ venue: "pumpswap", cashback: true, ammCashback: true, ammHiddenOn1: true, held: 2n * AMOUNT, lamports: Number(need) }, [wallet(2n * AMOUNT, false, VF.pumpswap.mint)]);
  assert.deepEqual(await runPoolSell(w.host, ask), { error: "failed" });
  assert.deepEqual([0, 1].map((p) => w.c.calls.filter((c) => c.p === p && c.method === "getAccountInfo" && c.params[0] === vol).length), [2, 2], "read twice on each");
  assert.ok(!w.c.log.some((l) => /simulateTransaction|sendTransaction/.test(l)));
  assert.equal(w.seeds.length > 1, false, "never signed");
});

// The second re-review of fd5eec3 (low): a deposit that opens a new page on both trees is a legitimate cost; a W the
// rules funded sells at that boundary, the reserve paying both pages.
test("at a page boundary of both trees a funded W sells: a whole curve sale and a partial PumpSwap sale, the reserve paying both new pages", async () => {
  const pages = 2n * rentMin(16 + 72);
  // the whole holding, from a W at the curve's own need: the fee and rent(0)
  const curveW = BigInt(FEE) + rentMin(0);
  const c = await world({ leaves: 1024, lamports: Number(curveW) });
  const a = await runPoolSell(c.host, ASK);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  const reserve = BigInt(FEE) + rentMin(17) + pages + AFTER - curveW;
  assert.ok(reserve > 2_810_000n, "over the old cap");
  assert.deepEqual(await ours(c.ns), [{ ref: RETURN, state: "UNSPENT", value: MIN_OUT - reserve, leafIndex: 1024n }]);
  // part of the holding on PumpSwap, from a W at PumpSwap's need: it keeps that need for the next sell
  const ask = { ...ASK, token: VF.pumpswap.mint };
  const swapW = BigInt(FEE) + rentMin(165);
  const p = await world({ venue: "pumpswap", leaves: 1024, held: 2n * AMOUNT, lamports: Number(swapW) }, [wallet(2n * AMOUNT, false, VF.pumpswap.mint)]);
  const b = await runPoolSell(p.host, ask);
  assert.equal("stage" in b && b.stage, "filled", JSON.stringify(b));
  const value = await deposited(p);
  assert.equal(value, VF.pumpswap.minOut - (BigInt(FEE) + rentMin(17) + pages));
  assert.equal(swapW - BigInt(FEE) - rentMin(17) - pages + (VF.pumpswap.minOut - value), swapW, "W keeps the next sell's need");
});

// The second re-review of fd5eec3 (medium): the lock-free settle reads the pending records before it asks which locks
// are held, so a sell that takes its lock and writes "pending" between the two is never settled as dead.
test("a sell that takes its lock and writes pending while the settle runs is never settled dead", async () => {
  const w = await world();
  const base = fakeLocks();
  let release!: () => void;
  let live: Promise<unknown> = Promise.resolve();
  const locks = {
    request: base.request,
    // at the settle's query: sell Y takes its lock and writes "pending" (after any read the settle did before it)
    query: (async () => {
      const snap = await base.query();
      await new Promise<void>((started) => {
        live = base.request(tradeLock("y1"), { mode: "exclusive" }, async () => {
          await w.store.put("ops", "y1", { kind: "sell", pool: "sol", sha: "cc", stage: "pending", txs: [], created_ms: 1 });
          started();
          await new Promise<void>((r) => (release = r));
        });
      });
      return snap;
    }) as LockManager["query"],
  };
  // a dead record beside it, so the settle has work to do
  await w.store.put("ops", "d1", { kind: "sell", pool: "sol", sha: "cc", stage: "pending", txs: [], created_ms: 1 });
  await settleDeadSellOps(w.store, locks);
  assert.equal(((await w.store.get("ops", "y1")) as { stage?: string }).stage, "pending", "the live sell untouched");
  assert.equal(((await w.store.get("ops", "d1")) as { stage?: string }).stage, "refused");
  release();
  await live;
});

// the review of 54b2f65 (finding 1, in every path): the read-back is a time budget, so one RPC down (each read its own
// retry) never holds the seed's lock for minutes
test("a sell that never reads back stops at POOL_SELL_READS seconds on the wall clock, whatever its read count: sent, the note INCOMING", async () => {
  const w = await world({ lands: false, finalHeight: 100 });
  let waited = 0;
  const a = await runPoolSell({ ...w.host, reads: 1_000, wait: async (ms: number) => void (waited += ms), now: () => BigInt(1_000 + waited) }, ASK);
  assert.equal("stage" in a && a.stage, "sent");
  assert.ok(waited <= POOL_SELL_READS * POOL_SELL_WAIT_MS, `waited ${waited} ms`);
});

// Card signpage-buy-route-events, fold 1 (L4): readBack (shared with pool-buy.ts) once read a meta that is not an object as
// a failure, so both RPCs answering that way read as "the sale failed on chain". An unreadable meta proves nothing: the
// reads go on and the answer keeps the transaction's ref.
test("this very transaction with an unreadable meta on both RPCs proves nothing: sent with its signature, never refused", async () => {
  const w = await world({ lands: false, metaJunk: true, finalHeight: 50 });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "sent");
  assert.equal((a as { txs: unknown[] }).txs.length, 1);
  assert.equal(w.c.log.filter((x) => x === "0:getTransaction").length, 3, "read back each round");
});

// Card signpage-error-after-timeout: a sell refused after the client's 10 s window still ends the app's sell button.
test("a pool.sell refused (W cannot pay its fee: not_funded) reaches the app as progress refused after its answer", async () => {
  const w = await world({ venue: "pump", lamports: 0 });
  const r = await throughApi("pool.sell", (_p, ctx) => poolSellKind(kindHost(w), fakeLocks())({ ...ASK, token: VF.pump.mint }, ctx), { chain: "solana", token: VF.pump.mint, amount: "1", slippage_bps: 100 });
  assert.deepEqual((r.answer as { error: unknown }).error, { code: "not_funded" });
  assert.deepEqual(r.stages, ["refused"]);
});

// Card sol-buy-rent-back: after a full sell, the rent a pool buy locked in W's accounts comes back to W (the kit's teardown
// frames, after the fill: 06c A9, no sell transaction closes an account), then every lamport W holds goes back into the
// pool as W's next return note, W ending at 0. A partial sell closes nothing and sweeps nothing.
const TOKEN_RENT = Number(rentMin(165));
const VOLUME_RENT = rentMin(137);
const GROWTH = 2n * 72n * rent.lamportsPerByte * rent.factor;
for (const [venue, volume] of [["pump", SOLANA_PUMP_PROGRAM], ["pumpswap", SOLANA_PUMP_AMM_PROGRAM]] as const) {
  test(`a full sell on ${venue}: W's token account and its ${venue} volume account are closed to W after the fill, then all W holds is swept into the pool as W's next return note, W at 0`, async () => {
    const ask = { ...ASK, token: VF[venue].mint };
    const back: string[] = [];
    const w = await world({ venue, ataLamports: TOKEN_RENT, volumes: [{ program: volume }] });
    w.host.back = (s) => void back.push(s);
    const ata = VF[venue].ata;
    const vol = solanaVolumeAccumulator(W.address, volume);
    const a = await runPoolSell(w.host, ask);
    assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
    const sell = w.c.deposits[0]!;
    // the accounts: closed, their rent in W, then W swept to 0
    // each one open is rent locked: W's token account, its volume account, and W's own lamports outside the pool
    assert.deepEqual({ tokenAccount: w.c.accounts.get(ata)?.lamports ?? 0, volumeAccount: w.c.accounts.get(vol)?.lamports ?? 0, w: w.c.accounts.get(W.address)?.lamports ?? 0 }, { tokenAccount: 0, volumeAccount: 0, w: 0 });
    // the sweep: W's lamports after the sell (its own, less the sell's fee and rents, the sale in, the deposit out),
    // plus both rents back, less the two teardown frames' fees (S-4 the token close, S-5 the volume close), less the
    // sweep's own fee, mark and page growth
    const afterSell = BigInt(ENOUGH) + VF[venue].minOut - sell.value - BigInt(FEE) - rentMin(17) - GROWTH;
    const swept = afterSell + BigInt(TOKEN_RENT) + VOLUME_RENT - 2n * BigInt(FEE) - (BigInt(FEE) + rentMin(17) + GROWTH);
    assert.equal(w.c.deposits.length, 2);
    assert.deepEqual(w.c.deposits[1], { pre: preOf(SECOND(0)), value: swept, sweep: true });
    // the sweep sent, the sell lock free: its note INCOMING until the next state read's settle (review L6)
    assert.equal((await ours(w.ns)).find((n) => n.ref.kind === "second")?.state, "INCOMING");
    assert.equal(w.owed.get(W.address)?.passes, 1, "owed until a pass finds nothing left");
    await settle(w);
    assert.deepEqual((await ours(w.ns)).sort((x, y) => Number(x.leafIndex! - y.leafIndex!)), [
      { ref: RETURN, state: "UNSPENT", value: sell.value, leafIndex: BigInt(N) },
      { ref: SECOND(0), state: "UNSPENT", value: swept, leafIndex: BigInt(N + 1) },
    ]);
    // three rent-back transactions, each W's alone and sent on both RPCs: the two teardown frames, then the sweep
    assert.equal(back.length, 3);
    for (const sig of back) {
      const { tx, err } = w.c.txs.get(sig)!;
      assert.equal(err, null);
      assert.ok(ed25519.verify(tx.subarray(1, 65), tx.subarray(65), base58.decode(W.address)));
      assert.equal(w.c.calls.filter((c) => c.method === "sendTransaction" && base58.encode(base64.decode(c.params[0] as string).subarray(1, 65)) === sig).length, 2);
    }
    const sweep = solanaDecodeMessage(w.c.txs.get(back[2]!)!.tx.subarray(65));
    assert.equal(sweep.instructions.length, 1, "the sweep is the deposit alone");
    assert.ok(w.seeds.every((x) => x.every((b) => b === 0)), "every seed copy zeroed");
    assert.deepEqual(w.told.map((t) => `${t.step}:${t.state}`), ["rent_back:sent"]);
    // W and its accounts in one getMultipleAccounts per RPC: what W reads as (whether the pass runs), at the teardown and
    // again at the sweep; never one read per account (one provider's slot each, and one call a throttled provider
    // answers or refuses whole)
    const list = JSON.stringify([W.address, ...solanaTeardownAddresses(W.address, [{ mint: VF[venue].mint, program: VF[venue].mintRead.owner }])]);
    const from = w.c.calls.findIndex((c) => c.method === "getMultipleAccounts" && JSON.stringify(c.params[0]) === list);
    const rentBackCalls = w.c.calls.slice(from);
    for (const p of [0, 1] as const) assert.equal(rentBackCalls.filter((c) => c.p === p && c.method === "getMultipleAccounts" && JSON.stringify(c.params[0]) === list).length, 3, `RPC ${p}`);
    assert.deepEqual(rentBackCalls.filter((c) => c.method === "getAccountInfo" && (list.includes(c.params[0] as string))).map((c) => c.params[0]), []);
    // the next load's pass finds W at 0 and every account closed: owed no more
    await resumeRentBacks(w.host, fakeLocks());
    assert.equal(w.owed.size, 0);
    assert.equal(back.length, 3, "nothing more sent");
  });
}

// Card solana-teardown-cashback: W's PumpSwap volume account owed cashback (12,742,862, the mainnet GATRKVEP…'s) after
// a full sell: the teardown's one frame closes W's token account, then claims to W's own WSOL account (opened with
// that rent, closed to W right after), then closes the volume account, so the sweep carries the claim into W's next
// return note and W still ends at 0.
test("a full sell whose PumpSwap volume account is owed cashback: the teardown claims it to W before the close, and the sweep carries it into the pool, W at 0", async () => {
  const CASHBACK = 12_742_862n;
  const back: string[] = [];
  const w = await world({ venue: "pumpswap", ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_AMM_PROGRAM, cashback: CASHBACK }] });
  w.host.back = (s) => void back.push(s);
  const vol = solanaVolumeAccumulator(W.address, SOLANA_PUMP_AMM_PROGRAM);
  const source = solanaAta(vol, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM);
  const a = await runPoolSell(w.host, { ...ASK, token: VF.pumpswap.mint });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  const sell = w.c.deposits[0]!;
  // the volume account closed, its WSOL account left with its rent alone, W's own WSOL account opened and closed
  assert.equal(w.c.accounts.get(vol), undefined);
  assert.equal(w.c.accounts.get(source)?.lamports, Number(rentMin(165)));
  assert.equal(new DataView(w.c.accounts.get(source)!.data.buffer).getBigUint64(64, true), 0n);
  assert.equal(w.c.accounts.get(solanaAta(W.address, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM)), undefined);
  assert.equal(w.c.accounts.get(W.address)?.lamports ?? 0, 0);
  // the sweep: as a full sell's (one teardown frame here, so one frame's fee), plus the claim
  const afterSell = BigInt(ENOUGH) + VF.pumpswap.minOut - sell.value - BigInt(FEE) - rentMin(17) - GROWTH;
  const swept = afterSell + BigInt(TOKEN_RENT) + VOLUME_RENT + CASHBACK - BigInt(FEE) - (BigInt(FEE) + rentMin(17) + GROWTH);
  assert.deepEqual(w.c.deposits[1], { pre: preOf(SECOND(0)), value: swept, sweep: true });
  // the one frame: compute limit, W's token account closed, W's WSOL account opened, the claim, its close to W, then
  // the volume close; then the sweep
  assert.equal(back.length, 2);
  const f = solanaDecodeMessage(w.c.txs.get(back[0]!)!.tx.subarray(65));
  assert.deepEqual(f.instructions.map((x) => f.staticKeys[x.programIndex]), [SOLANA_COMPUTE_BUDGET_PROGRAM, VF.pumpswap.mintRead.owner, SOLANA_ATA_PROGRAM, SOLANA_PUMP_AMM_PROGRAM, SOLANA_TOKEN_PROGRAM, SOLANA_PUMP_AMM_PROGRAM]);
  assert.deepEqual(w.told.map((t) => `${t.step}:${t.state}`), ["rent_back:sent"]);
});

// Review L2 of 5592a871: the claim rides in the teardown's last frame and the verdict covers every frame, so a claim
// that does not simulate refused the whole teardown, W's token account's close with it. Planned again with claims off,
// W's token account still closes to W, and the owed volume account stays open, its cashback in its own WSOL account and
// the reason told. Card sol-w-sweep: that kept account left every lamport on W (11c963f9: W kept the sell's surplus and
// the token account's rent, swept nothing); now the sweep goes, W keeps exactly what the later claim needs
// (solanaSweepKeep: rent(0), the claim frame's fee, the claim account's rent; review L4 of 0068524a), and W stays owed
// (review M1 of 11c963f9: at 11c963f9 the rent back ended "kept" and the record was dropped, so nothing claimed it).
test("a full sell whose PumpSwap cashback claim does not simulate: planned again with claims off, W's token account still closes to W, the owed volume account stays open with its cashback and the reason, and the sweep leaves W only the claim's cost, owed for the next pass", async () => {
  const CASHBACK = 12_742_862n;
  const back: string[] = [];
  // a cashback coin (its pool's is_cashback_coin set), whose W already holds both cashback accounts
  const plant: Plant = { venue: "pumpswap", cashback: true, ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_AMM_PROGRAM, cashback: CASHBACK }], claimFails: true };
  const w = await world(plant);
  w.host.back = (s) => void back.push(s);
  const vol = solanaVolumeAccumulator(W.address, SOLANA_PUMP_AMM_PROGRAM);
  const source = solanaAta(vol, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM);
  const before = w.c.accounts.get(vol)!.lamports;
  const a = await runPoolSell(w.host, { ...ASK, token: VF.pumpswap.mint });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  const sell = w.c.deposits[0]!;
  // W's token account closed to W; the volume account and its cashback untouched; W's own WSOL account never opened
  assert.equal(w.c.accounts.get(solanaAta(W.address, VF.pumpswap.mint, VF.pumpswap.mintRead.owner)), undefined, "W's token account closed");
  assert.equal(w.c.accounts.get(vol)?.lamports, before);
  assert.equal(new DataView(w.c.accounts.get(source)!.data.buffer).getBigUint64(64, true), CASHBACK);
  assert.equal(w.c.accounts.get(solanaAta(W.address, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM)), undefined);
  // the teardown's one frame (the compute limit and the token close alone), then the sweep
  assert.equal(back.length, 2, JSON.stringify(w.told));
  const f = solanaDecodeMessage(w.c.txs.get(back[0]!)!.tx.subarray(65));
  assert.deepEqual(f.instructions.map((x) => f.staticKeys[x.programIndex]), [SOLANA_COMPUTE_BUDGET_PROGRAM, VF.pumpswap.mintRead.owner]);
  // the sell kept AFTER_CB on W; the sweep took all of it and the token account's rent but the claim's cost
  const keep = rentMin(0) + BigInt(FEE) + rentMin(165);
  assert.equal(BigInt(w.c.accounts.get(W.address)?.lamports ?? 0), keep);
  const afterSell = BigInt(ENOUGH) + VF.pumpswap.minOut - sell.value - BigInt(FEE) - rentMin(17) - GROWTH;
  assert.equal(afterSell, AFTER_CB);
  const swept = afterSell + BigInt(TOKEN_RENT) - BigInt(FEE) - (BigInt(FEE) + rentMin(17) + GROWTH) - keep;
  assert.ok(swept >= solanaSweepFloor(rent), "the sweep's note is one a withdraw can spend");
  assert.deepEqual(w.c.deposits[1], { pre: preOf(SECOND(0)), value: swept, sweep: true });
  assert.deepEqual(w.told.map((t) => `${t.step}:${t.state}`), ["rent_back:sent"]);
  // owed for the next pass, which claims the cashback and sweeps it with the rest
  assert.equal(w.owed.get(W.address)?.passes, 1);
  // the next load, the claim taken now: from the claim's cost alone, the claim and the volume close in one frame, then
  // the sweep carries the cashback, the volume account's rent and the claim's cost into the pool, W at 0
  await settle(w);
  plant.claimFails = false;
  w.told.length = 0;
  await resumeRentBacks(w.host, fakeLocks());
  assert.equal(w.c.accounts.get(vol), undefined, "the volume account closed");
  assert.equal(new DataView(w.c.accounts.get(source)!.data.buffer).getBigUint64(64, true), 0n, "its cashback claimed");
  assert.equal(w.c.accounts.get(W.address)?.lamports ?? 0, 0, JSON.stringify(w.told));
  assert.equal(back.length, 4);
  const again = keep - BigInt(FEE) + CASHBACK + VOLUME_RENT - (BigInt(FEE) + rentMin(17) + GROWTH);
  assert.deepEqual(w.c.deposits[2], { pre: preOf(SECOND(1)), value: again, sweep: true });
  assert.deepEqual(w.told.map((t) => `${t.step}:${t.state}`), ["rent_back:sent"]);
});

// Card sol-w-sweep: what a full sell keeps on W is exactly what lifts the sweep to the floor when the teardown closes
// only W's token account (one frame, its fee, rent(165) back) and the sweep opens a page on both trees: the floor, the
// sweep's fee, mark and two pages' opening (rent(16 + 72) each), that frame's fee, less rent(165); at mainnet's rent
// 4,052,720, and per volume account owed a claim, that claim's cost more. Review L2 of 38faee89: priced at one entry's
// growth (72 bytes a tree), a sweep at a page boundary landed under the floor, ended "floor" and left ~4.07M on W.
const FLOOR = solanaSweepFloor(rent) > SOLANA_POOL_MIN_DEPOSIT ? solanaSweepFloor(rent) : SOLANA_POOL_MIN_DEPOSIT;
test("a full sell whose teardown closes W's token account alone: the sweep's note is the floor and what a page's opening would cost over an entry's, exactly the floor when the sweep opens a page on both trees, and W ends at 0; the kept amount pinned at mainnet's rent", async () => {
  const mainnet = { lamportsPerByte: 5_080n, factor: 1n } as typeof rent;
  assert.equal(solanaSellAfterFull(mainnet), 2_600_000n + 5_000n + 736_600n + 2n * 1_097_280n + 5_000n - 1_488_440n);
  assert.equal(solanaSellAfterFull(mainnet), 4_052_720n);
  assert.equal(solanaSellAfterFull(mainnet, 1), 4_052_720n + 650_240n + 5_000n + 1_488_440n);
  assert.equal(solanaSellAfterFull(mainnet, 2), 4_052_720n + 650_240n + 2n * (5_000n + 1_488_440n));
  // off a page boundary: the sweep pays an entry's growth on each tree, the rest of a page's opening goes into its note
  const w = await world({ ataLamports: TOKEN_RENT });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  assert.equal(w.c.accounts.has(ATA), false);
  assert.equal(w.c.accounts.get(W.address)?.lamports ?? 0, 0, JSON.stringify(w.told));
  const margin = 2n * (rentMin(16 + 72) - 72n * rent.lamportsPerByte * rent.factor);
  assert.deepEqual(w.c.deposits.filter((d) => d.sweep).map((d) => d.value), [FLOOR + margin]);
  // read 65 entries from each page's end (outside the window, so the sell is priced at an entry's growth), then 64
  // others' deposits land first: the sell takes entry 1,023 and the sweep opens page 1 on both trees, exactly the floor
  const b = await world({ ataLamports: TOKEN_RENT, leaves: 959, labelLeaves: 959, insertFirst: true, insertKind: "deposit", insertCount: 64 });
  const sb = await runPoolSell(b.host, ASK);
  assert.equal("stage" in sb && sb.stage, "filled", JSON.stringify(sb));
  assert.equal(b.c.accounts.get(W.address)?.lamports ?? 0, 0, JSON.stringify(b.told));
  assert.deepEqual(b.c.deposits.filter((d) => d.sweep).map((d) => d.value), [FLOOR]);
  assert.deepEqual(b.told.map((t) => `${t.step}:${t.state}`), ["rent_back:sent"]);
  for (const tree of [0, 1] as const) assert.ok(b.c.accounts.has(solanaPoolPage(PROGRAM, tree, 1_024)), `the sweep opened tree ${tree}'s page 1`);
});

// Card sol-w-sweep, review L3 of 38faee89: owed cashback on a coin that is not a cashback coin (W's volume account
// earned it trading another). At 38faee89 the sell kept no claim's cost, so with the claim failing nothing was swept and
// ~4.07M stayed on W. The sell reads W's volume accounts and keeps the cost of each claim owed: the sweep goes, W keeps
// exactly that claim's cost, owed for the pass that claims it.
test("owed cashback on a coin that is not a cashback coin, its claim failing: the sell kept the claim's cost, so the sweep goes and W keeps only that cost, owed for the next pass", async () => {
  const w = await world({ venue: "pumpswap", ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_AMM_PROGRAM, cashback: 12_742_862n }], claimFails: true });
  const a = await runPoolSell(w.host, { ...ASK, token: VF.pumpswap.mint });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  assert.equal(w.c.deposits.length, 2, "swept");
  assert.ok(w.c.deposits[1]!.value >= FLOOR);
  assert.equal(BigInt(w.c.accounts.get(W.address)?.lamports ?? 0), solanaSweepKeep(rent, 1));
  assert.deepEqual(w.told.map((t) => `${t.step}:${t.state}`), ["rent_back:sent"]);
  assert.equal(w.owed.get(W.address)?.passes, 1);
});

// The review of c1fd2d20, 2b: a load that reads W the same skips the pass only after an end W's own state decides (under
// the floor, holding, an account kept). An "owed" end waits on the program taking the claim, which no read of W shows:
// each load tries the claim again, and the load after the program takes it claims and sweeps.
test("an owed claim is tried again on every load though W reads the same, and claimed once the program takes it", async () => {
  const plant: Plant = { venue: "pumpswap", ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_AMM_PROGRAM, cashback: 12_742_862n }], claimFails: true };
  const w = await world(plant);
  const a = await runPoolSell(w.host, { ...ASK, token: VF.pumpswap.mint });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  await settle(w);
  const loaded: PoolSellHost = { ...w.host, wallets: async () => [{ ...wallet(AMOUNT, false, VF.pumpswap.mint), holdings: { native: 1n, tokens: new Map([[VF.pumpswap.mint, { amount: 0n, frozen: false }]]), unreadable: [] } }] };
  for (let i = 0; i < 2; i++) {
    w.told.length = 0;
    await resumeRentBacks(loaded, fakeLocks());
    assert.equal(w.told.at(-1)?.state, "owed", JSON.stringify(w.told));
  }
  plant.claimFails = false;
  await resumeRentBacks(loaded, fakeLocks());
  assert.equal(w.c.accounts.get(solanaVolumeAccumulator(W.address, SOLANA_PUMP_AMM_PROGRAM)), undefined, "claimed and closed");
  assert.equal(w.c.accounts.get(W.address)?.lamports ?? 0, 0);
});

// Review L3 of 38faee89: one RPC's word that nothing is owed never lowers what W keeps: RPC B reads W's PumpSwap volume
// account owing nothing, RPC A reads its cashback; the sell keeps the claim's cost.
test("the sell counts a volume account owed a claim when either RPC reads it owed: what W keeps holds the claim's cost", async () => {
  const vol = solanaVolumeAccumulator(W.address, SOLANA_PUMP_AMM_PROGRAM);
  const zeroed = (a: Acc): Acc => { const d = Uint8Array.from(a.data); new DataView(d.buffer).setBigUint64(74, 0n, true); return { ...a, data: d }; };
  const w = await world({ venue: "pumpswap", ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_AMM_PROGRAM, cashback: 12_742_862n }], claimFails: true, mapOn: (p, address, a) => (p === 1 && address === vol ? zeroed(a) : a) });
  await runPoolSell(w.host, { ...ASK, token: VF.pumpswap.mint });
  const sell = w.c.deposits[0]!;
  const afterSell = BigInt(ENOUGH) + VF.pumpswap.minOut - sell.value - BigInt(FEE) - rentMin(17) - GROWTH;
  assert.equal(afterSell, solanaSellAfterFull(rent, 1));
});

// Review 2 L3 of 911d7e25: the mirror, RPC A reading W's PumpSwap volume account owing nothing and RPC B its cashback
// (owesOn reading RPC A alone survived the one above).
test("the sell counts a volume account owed a claim when RPC B alone reads it owed: what W keeps holds the claim's cost", async () => {
  const vol = solanaVolumeAccumulator(W.address, SOLANA_PUMP_AMM_PROGRAM);
  const zeroed = (a: Acc): Acc => { const d = Uint8Array.from(a.data); new DataView(d.buffer).setBigUint64(74, 0n, true); return { ...a, data: d }; };
  const w = await world({ venue: "pumpswap", ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_AMM_PROGRAM, cashback: 12_742_862n }], claimFails: true, mapOn: (p, address, a) => (p === 0 && address === vol ? zeroed(a) : a) });
  await runPoolSell(w.host, { ...ASK, token: VF.pumpswap.mint });
  const sell = w.c.deposits[0]!;
  const afterSell = BigInt(ENOUGH) + VF.pumpswap.minOut - sell.value - BigInt(FEE) - rentMin(17) - GROWTH;
  assert.equal(afterSell, solanaSellAfterFull(rent, 1));
});

// Review 2 L3 of 911d7e25: what is owed is what was earned less what was claimed (cashback_claimed @82, pump's
// stable_cashback_claimed @98); a claimed amount read a byte off (@83, @97) survived, every fixture claiming nothing.
test("a volume account's claimed cashback is taken off what it earned: all of it claimed owes nothing, part of it owes the claim's cost", async () => {
  const after = async (plant: Plant, venue: Venue) => {
    const w = await world({ venue, ataLamports: TOKEN_RENT, claimFails: true, ...plant });
    const a = await runPoolSell(w.host, { ...ASK, token: VF[venue].mint });
    assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
    return BigInt(ENOUGH) + VF[venue].minOut - w.c.deposits[0]!.value - BigInt(FEE) - rentMin(17) - GROWTH;
  };
  assert.equal(await after({ volumes: [{ program: SOLANA_PUMP_AMM_PROGRAM, cashback: 12_742_862n, claimed: 12_742_862n }] }, "pumpswap"), solanaSellAfterFull(rent, 0));
  assert.equal(await after({ volumes: [{ program: SOLANA_PUMP_AMM_PROGRAM, cashback: 12_742_862n, claimed: 12_742_861n }] }, "pumpswap"), solanaSellAfterFull(rent, 1));
  assert.equal(await after({ volumes: [{ program: SOLANA_PUMP_PROGRAM, stable: 3_000_000n, claimed: 3_000_000n }] }, "pump"), solanaSellAfterFull(rent, 0));
  assert.equal(await after({ volumes: [{ program: SOLANA_PUMP_PROGRAM, stable: 3_000_000n, claimed: 1_000_000n }] }, "pump"), solanaSellAfterFull(rent, 1));
});

// Review 2 L3 and L4 of 911d7e25, end to end: W at what a curve buy leaves (1,493,440), a full sell whose note with the
// sweep's keep would be over the pool's least deposit and under the floor keeps rent(0) instead (the device's fallback,
// its floor the sweep's: one priced at SOLANA_POOL_MIN_DEPOSIT keeps the sweep's keep and the rule refuses it); the
// sweep then ends "floor", and W's record stays for a later pass.
test("a full sell whose note with the sweep's keep lands under the floor keeps rent(0), fills, and the sweep under the floor keeps W's record", async () => {
  const lamports = 1_493_440n;
  const { amount, minOut } = await amountFor(5_800_000n);
  const r0 = solanaRentMin(rent, 0);
  const w = await world({ held: amount, lamports: Number(lamports), ataLamports: TOKEN_RENT }, [wallet(amount)]);
  const a = await runPoolSell(w.host, { ...ASK, amount });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  const sell = w.c.deposits[0]!;
  const short = minOut - sell.value - r0; // the fee and the rents less W's lamports
  const kept = minOut - (short + solanaSellAfterFull(rent, 0));
  assert.ok(kept >= SOLANA_POOL_MIN_DEPOSIT && kept < FLOOR, `with the keep: ${kept}`);
  assert.equal(short, BigInt(FEE) + 1_468_120n - lamports);
  assert.equal(w.c.deposits.length, 1, "nothing swept");
  assert.equal(w.owed.get(W.address)?.passes, 1, "W's record kept");
  assert.equal(typeof w.owed.get(W.address)?.seen, "string", "with what W read as");
});

// Review 3 L-b of 446d830f and the review of c1fd2d20 (2a, 2b): a W left under the floor is never forgotten. Its record,
// after the floor end, met five loads with both RPCs down, and the pass bound dropped it ("owed no more after 5 passes")
// with 2,133,680 left on W. The record is dropped only when both RPCs read W empty; a load that reads W as it was at
// its last end signs nothing and passes nothing more, one read a load.
test("a W left under the floor keeps its record through any run of faulted loads, and a load that reads W the same runs no pass", async () => {
  const lamports = 1_493_440n;
  const { amount } = await amountFor(5_800_000n);
  const w = await world({ held: amount, lamports: Number(lamports), ataLamports: TOKEN_RENT }, [wallet(amount)]);
  const a = await runPoolSell(w.host, { ...ASK, amount });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  const onW = w.c.accounts.get(W.address)?.lamports ?? 0;
  assert.ok(onW > 0);
  const s0 = sends(w).length;
  const loaded: PoolSellHost = { ...w.host, wallets: async () => [{ ...wallet(amount), holdings: { native: 1n, tokens: new Map([[MINT, { amount: 0n, frozen: false }]]), unreadable: [] } }] };
  // the loads' own reads fail (both providers down at page load): many times any bound, and the record stays
  const down: PoolSellHost = { ...loaded, rpcs: [async () => { throw new Error("down"); }, async () => { throw new Error("down"); }] as never };
  for (let i = 0; i < 12; i++) await resumeRentBacks(down, fakeLocks());
  assert.ok(w.owed.has(W.address), "W's record kept");
  assert.equal(w.told.filter((t) => t.detail.startsWith("owed no more")).length, 0);
  // the next healthy load reads W again: under the floor, nothing signed
  await resumeRentBacks(loaded, fakeLocks());
  const seen = w.owed.get(W.address)?.seen;
  assert.equal(typeof seen, "string");
  // and the loads after read W the same: one read of W on each RPC, no pass (nothing told, nothing more read)
  const told = w.told.length;
  const calls = w.c.calls.length;
  const passes = w.owed.get(W.address)!.passes;
  for (let i = 0; i < 3; i++) await resumeRentBacks(loaded, fakeLocks());
  assert.equal(w.told.length, told, "no pass ran");
  assert.equal(w.owed.get(W.address)?.passes, passes);
  assert.deepEqual([...new Set(w.c.calls.slice(calls).filter((c) => c.method === "getMultipleAccounts" && (c.params[0] as string[]).includes(W.address)).map((c) => c.p))].sort(), [0, 1]);
  assert.equal(sends(w).length - s0, 0, "a floor pass signs nothing");
  // lamports sent to W: W reads otherwise, so the pass runs again (and sweeps once the note clears the floor)
  w.c.accounts.set(W.address, { ...w.c.accounts.get(W.address)!, lamports: onW + 3_000_000 });
  await resumeRentBacks(loaded, fakeLocks());
  assert.equal(w.c.deposits.filter((d) => d.sweep).length, 1, "swept once W can make a note");
  assert.equal(w.c.accounts.get(W.address)?.lamports ?? 0, 0);
  await resumeRentBacks(loaded, fakeLocks());
  assert.equal(w.owed.has(W.address), false, "dropped once both RPCs read W empty");
});

// The review of c1fd2d20, probe 1: faults before the first floor end dropped W. Provider B throttled once the sell lands:
// the sell's own rent back gives up, and four more loads hit the pass bound ("owed no more"), 2,138,680 left on W.
test("a rent back that faults on every load keeps W's record: no pass bound, W's lamports still owed", async () => {
  const lamports = 1_493_440n;
  const { amount } = await amountFor(5_800_000n);
  const plant: Plant = { held: amount, lamports: Number(lamports), ataLamports: TOKEN_RENT, throttle: { on: "read", n: 1_000_000 } };
  const w = await world(plant, [wallet(amount)]);
  const a = await runPoolSell(w.host, { ...ASK, amount });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  assert.equal(w.told.at(-1)?.state, "gave_up");
  const loaded: PoolSellHost = { ...w.host, wallets: async () => [{ ...wallet(amount), holdings: { native: 1n, tokens: new Map([[MINT, { amount: 0n, frozen: false }]]), unreadable: [] } }] };
  for (let i = 0; i < 8; i++) await resumeRentBacks(loaded, fakeLocks());
  assert.ok(w.owed.has(W.address), "W's record kept");
  assert.equal(w.told.filter((t) => t.detail.startsWith("owed no more")).length, 0);
  assert.ok((w.c.accounts.get(W.address)?.lamports ?? 0) > 0);
  // the provider back: the next load closes W's token account and finds W under the floor, owed still
  plant.throttle = undefined;
  await resumeRentBacks(loaded, fakeLocks());
  assert.equal(w.c.accounts.has(ATA), false);
  assert.equal(w.told.at(-1)?.state, "floor", JSON.stringify(w.told.at(-1)));
  assert.ok(w.owed.has(W.address));
});

// The review of c1fd2d20, probe 2: one reader's word dropped W. The page's holdings (the helper's one-reader route) show
// W holding another token (a broken-in helper, an airdrop of any mint): the pass ends "holds", and a W under the floor
// was dropped after one load. Every end but "nothing" (both RPCs reading W empty) keeps the record.
test("a W the page's holdings show holding another token keeps its record: one reader's word never drops it", async () => {
  const lamports = 1_493_440n;
  const { amount } = await amountFor(5_800_000n);
  const w = await world({ held: amount, lamports: Number(lamports), ataLamports: TOKEN_RENT }, [wallet(amount)]);
  const a = await runPoolSell(w.host, { ...ASK, amount });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  const spam = "So11111111111111111111111111111111111111112";
  const lying: PoolSellHost = { ...w.host, wallets: async () => [{ ...wallet(amount), holdings: { native: 1n, tokens: new Map([[MINT, { amount: 0n, frozen: false }], [spam, { amount: 1n, frozen: false }]]), unreadable: [] } }] };
  await resumeRentBacks(lying, fakeLocks());
  assert.equal(w.told.at(-1)?.state, "holds");
  assert.ok(w.owed.has(W.address), "W's record kept");
  for (let i = 0; i < 3; i++) await resumeRentBacks(lying, fakeLocks());
  assert.ok(w.owed.has(W.address));
});

// Review 2 L4 of 911d7e25: RPC B reads W's two volume accounts owed claims until the sell lands, the chain owing none:
// the sell keeps two claims' cost, its note under the floor with it, so it keeps rent(0); the sweep ends "floor". At
// 911d7e25 a "floor" end dropped W's record, so one lying RPC made the device forget W; kept, a later sweep retries.
test("one RPC's lie of two claims owed forces the rent(0) sell: the sweep ends under the floor and W's record is kept", async () => {
  const lamports = 1_493_440n;
  const { amount, minOut } = await amountFor(8_000_000n);
  const w = await world({ held: amount, lamports: Number(lamports), ataLamports: TOKEN_RENT, owedOn1BeforeSell: true }, [wallet(amount)]);
  const a = await runPoolSell(w.host, { ...ASK, amount });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  const short = BigInt(FEE) + 1_468_120n - lamports;
  assert.ok(minOut - (short + solanaSellAfterFull(rent, 0)) >= FLOOR, "honest, the keep would have gone");
  assert.equal(w.c.deposits[0]!.value, minOut - short - solanaRentMin(rent, 0));
  assert.equal(w.c.deposits.length, 1, "nothing swept");
  assert.equal(w.owed.get(W.address)?.passes, 1, "W's record kept");
  assert.equal(typeof w.owed.get(W.address)?.seen, "string", "with what W read as");
});

// Review L3 and Info of 38faee89: two volume accounts owed a claim neither can take this pass (PumpSwap's cashback, its
// claim refused; pump's stable cashback, with no USDC in the volume account's own account to pay it): the sell keeps
// both claims' cost, the sweep goes, and W keeps exactly solanaSweepKeep for two (the owedOf 2 -> 1 mutant survived,
// since no run had two).
test("two volume accounts owed claims that cannot go this pass: the sell keeps both claims' cost, the sweep goes, W keeps exactly two claims' cost, owed for the next pass", async () => {
  const w = await world({ venue: "pumpswap", ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_AMM_PROGRAM, cashback: 12_742_862n }, { program: SOLANA_PUMP_PROGRAM, stable: 3_000_000n }], claimFails: true });
  const a = await runPoolSell(w.host, { ...ASK, token: VF.pumpswap.mint });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  assert.equal(w.c.deposits.length, 2, "swept");
  assert.ok(w.c.deposits[1]!.value >= FLOOR);
  assert.equal(BigInt(w.c.accounts.get(W.address)?.lamports ?? 0), solanaSweepKeep(rent, 2));
  assert.ok(w.c.accounts.has(solanaVolumeAccumulator(W.address, SOLANA_PUMP_PROGRAM)) && w.c.accounts.has(solanaVolumeAccumulator(W.address, SOLANA_PUMP_AMM_PROGRAM)), "both owed volume accounts kept");
  assert.deepEqual(w.told.map((t) => `${t.step}:${t.state}`), ["rent_back:sent"]);
  assert.equal(w.owed.get(W.address)?.passes, 1);
});

// Review M1 of 38faee89: a full sell whose own note, after the keep for the sweep, lands under the floor keeps rent(0)
// only, as before the card: its note stays one a withdraw spends. Mainnet's rent, W at what a curve buy leaves
// (1,493,440), min out 4,000,000, six rents 1,468,120: at 38faee89 the note was 1,430,640 under a 2,600,000 floor.
test("solanaSellReserve at mainnet's rent: a full sell whose note would land under the floor with the sweep's keep keeps rent(0) instead, its note 3,370,080", () => {
  const mainnet = { lamportsPerByte: 5_080n, factor: 1n } as typeof rent;
  const p = { fee: 5_000n, made: 0n, rents: 1_468_120n, lamports: 1_493_440n, minOut: 4_000_000n, keeps: false };
  const full = solanaSellAfterFull(mainnet);
  const r0 = solanaRentMin(mainnet, 0);
  // min out 4,000,000: with the sweep's keep (4,052,720 since review L2) the reserve, 4,032,400, is over the min out;
  // 6,000,000: the keep leaves a 1,967,600 note, over the pool's least deposit and under the floor
  assert.deepEqual(solanaSellReserve({ ...p, after: full, swept: full - r0 }), { refused: "quote_check_failed" });
  assert.deepEqual(solanaSellReserve({ ...p, minOut: 6_000_000n, after: full, swept: full - r0 }), { reserve: 4_032_400n, value: 1_967_600n });
  // the device's pricing (pool-sell.ts form: base rent(0), floor the sweep's): rent(0), notes a withdraw spends
  assert.deepEqual(solanaSellReserve({ ...p, after: full, swept: full - r0, base: r0, floor: 2_600_000n }), { reserve: 629_920n, value: 3_370_080n });
  assert.deepEqual(solanaSellReserve({ ...p, minOut: 6_000_000n, after: full, swept: full - r0, base: r0, floor: 2_600_000n }), { reserve: 629_920n, value: 5_370_080n });
  // a min out whose note clears the floor with the keep still keeps it
  const big = solanaSellReserve({ ...p, minOut: 9_000_000n, after: full, swept: full - r0, base: r0, floor: 2_600_000n });
  assert.ok(!("refused" in big) && big.value >= 2_600_000n && big.reserve === 5_000n + 1_468_120n + full - 1_493_440n);
});

// Review M1 of 11c963f9: one provider erring once on the claim's frame turned claims off for good (the fallback took
// any SIM refusal, and the rent back then ended "kept", its owed record dropped), so W's cashback, the volume
// account's rent and W's lamports stayed on W. One provider's error is a fault, read again: the next try claims.
test("provider B errs once on the frame carrying the cashback claim: a fault read again, the claim lands on the retry, the volume account closes, the sweep takes W to 0", async () => {
  const CASHBACK = 12_742_862n;
  const w = await world({ venue: "pumpswap", ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_AMM_PROGRAM, cashback: CASHBACK }], claimErrOnB: 1 });
  const vol = solanaVolumeAccumulator(W.address, SOLANA_PUMP_AMM_PROGRAM);
  const a = await runPoolSell(w.host, { ...ASK, token: VF.pumpswap.mint });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  assert.equal(w.c.accounts.get(vol), undefined, "the volume account closed");
  assert.equal(new DataView(w.c.accounts.get(solanaAta(vol, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM))!.data.buffer).getBigUint64(64, true), 0n, "its cashback claimed");
  assert.equal(w.c.accounts.get(W.address)?.lamports ?? 0, 0, JSON.stringify(w.told));
  assert.equal(w.c.deposits.filter((d) => d.sweep).length, 1);
  assert.ok(w.told.some((t) => t.step === "teardown" && t.state === "fault"), JSON.stringify(w.told));
  assert.equal(w.told.at(-1)?.state, "sent");
});

// The devnet run at 0068524a: the sell filled, then provider B answered HTTP 429 to the rent back's reads, and the
// whole rent back stopped there, every rent left on W. A provider's fault is read again from the top, a second apart.
for (const on of ["read", "simulate"] as const) {
  test(`provider B throttled when the rent back starts (its ${on === "read" ? "account reads" : "teardown simulations"}): read again, every rent comes back and W ends at 0`, async () => {
    const w = await world({ ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }], throttle: { on, n: 3 } });
    const a = await runPoolSell(w.host, ASK);
    assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
    assert.deepEqual({ tokenAccount: w.c.accounts.get(ATA)?.lamports ?? 0, volumeAccount: w.c.accounts.get(solanaVolumeAccumulator(W.address, SOLANA_PUMP_PROGRAM))?.lamports ?? 0, w: w.c.accounts.get(W.address)?.lamports ?? 0 }, { tokenAccount: 0, volumeAccount: 0, w: 0 });
    assert.equal(w.c.deposits.filter((d) => d.sweep).length, 1);
    // each fault told by its step and its name (a rent back's fault is never silent)
    assert.ok(w.told.some((t) => t.step === (on === "read" ? "teardown" : "teardown") && t.state === "fault" && t.detail === "http_429 at solana-devnet.api.onfinality.io"), JSON.stringify(w.told));
    assert.equal(w.told.at(-1)?.state, "sent");
  });
}

// Review L4 of 0068524a: an account the plan keeps (owed incentives or cashback, unsettled volume) was left open while
// the sweep took W to 0, so W could never pay the fee to claim or close it. Nothing is swept while the plan keeps one.
for (const [what, vol] of [["owes incentive tokens (needs_claim)", { owed: true }], ["has volume not yet settled (current_sol_volume)", { unsettled: true }]] as const) {
  test(`a full sell whose volume account ${what} keeps that account open and sweeps nothing: the token account's rent comes back to W, which keeps the fee to close it later`, async () => {
    const w = await world({ ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM, ...vol }] });
    const a = await runPoolSell(w.host, ASK);
    assert.equal("stage" in a && a.stage, "filled");
    const sell = w.c.deposits[0]!;
    const afterSell = BigInt(ENOUGH) + VF.pump.minOut - sell.value - BigInt(FEE) - rentMin(17) - GROWTH;
    assert.deepEqual({ tokenAccount: w.c.accounts.get(ATA)?.lamports ?? 0, volumeAccount: w.c.accounts.get(solanaVolumeAccumulator(W.address, SOLANA_PUMP_PROGRAM))?.lamports ?? 0, w: BigInt(w.c.accounts.get(W.address)?.lamports ?? 0) }, { tokenAccount: 0, volumeAccount: Number(VOLUME_RENT), w: afterSell + BigInt(TOKEN_RENT) - BigInt(FEE) });
    assert.equal(w.c.deposits.filter((d) => d.sweep).length, 0);
    assert.equal(w.told.at(-1)?.state, "kept");
    // review of c1fd2d20, 2a: kept, with what W read as, so a later load passes again only once W reads otherwise
    assert.equal(w.owed.get(W.address)?.passes, 1, "a kept account stays owed");
    assert.equal(typeof w.owed.get(W.address)?.seen, "string");
  });
}

test("a full sell whose pages hold more than their rent (anyone may send lamports to one): the sweep is priced by what the program takes, and W still ends at 0", async () => {
  const w = await world({ ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }] });
  // 500,000 sent to each page the deposits write before the run (more than the sell's entry, so the sweep's is cheaper too) (a mark's address is unknown until its deposit names
  // the precommitment, so only a page can be sent to ahead)
  for (const tree of [0, 1] as const) {
    const page = solanaPoolPage(PROGRAM, tree, 0);
    w.c.accounts.set(page, { ...w.c.accounts.get(page)!, lamports: w.c.accounts.get(page)!.lamports + 500_000 });
  }
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled");
  assert.equal(w.c.accounts.get(W.address)?.lamports ?? 0, 0, JSON.stringify(w.told));
  assert.equal(w.c.deposits.filter((d) => d.sweep).length, 1);
});

// Review M1 of 0068524a: W after its teardown made a note no withdraw can spend (the devnet run's 2,154,336 under
// 2,600,000), so the sweep stopped at the floor and those lamports stayed on W, out of the app's sight (card sol-w-sweep,
// signpage-pool-sell's re-review LOW 4). A full sell now keeps on W exactly what lifts the sweep to the floor
// (solanaSellAfterFull) and deposits the rest with its proceeds; the teardown's rents then carry the sweep past the
// floor, and W ends at 0.
test("a full sell from W at its sell's least need: W keeps only what the sweep needs, the rents come back to W, and the sweep takes W to 0, nothing left on W", async () => {
  const need = solanaPoolSellNeed({ kind: "pump-curve", cashback: false }, rent);
  const w = await world({ lamports: Number(need), ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }] });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  assert.equal(w.c.accounts.has(ATA), false);
  assert.equal(w.c.accounts.has(solanaVolumeAccumulator(W.address, SOLANA_PUMP_PROGRAM)), false);
  assert.equal(w.c.accounts.get(W.address)?.lamports ?? 0, 0, JSON.stringify(w.told));
  // the sell's note: min out less its fee, the mark's rent, the pages' growth and what W keeps, over what W held
  const sell = w.c.deposits[0]!;
  assert.equal(sell.value, MIN_OUT - (BigInt(FEE) + rentMin(17) + GROWTH + AFTER - need));
  // the sweep's: what W kept and the two closed rents, less two teardown frames' fees and its own costs, over the floor
  const sweep = w.c.deposits.find((d) => d.sweep)!;
  assert.equal(sweep.value, AFTER + BigInt(TOKEN_RENT) + VOLUME_RENT - 2n * BigInt(FEE) - (BigInt(FEE) + rentMin(17) + GROWTH));
  assert.ok(sweep.value >= solanaSweepFloor(rent));
  assert.equal(w.told.at(-1)?.state, "sent");
});

// A full sell too small to hold the sweep's share back (the reserve would pass its cap or leave the note under the
// program's least deposit) keeps rent(0) only, as before card sol-w-sweep: priced with what the sweep needs first.
test("solanaSellReserve: a full sell deposits W's surplus over the fee, rents and what it keeps (a reserve under 0); a partial sell leaves it on W", () => {
  const p = { fee: 5_000n, made: 0n, rents: 1_000_000n, after: AFTER, minOut: 50_000_000n };
  const lamports = 10_000_000n;
  assert.deepEqual(solanaSellReserve({ ...p, lamports, keeps: false }), { reserve: 5_000n + 1_000_000n + AFTER - lamports, value: 50_000_000n + lamports - 5_000n - 1_000_000n - AFTER });
  assert.ok(5_000n + 1_000_000n + AFTER - lamports < 0n);
  assert.deepEqual(solanaSellReserve({ ...p, lamports, keeps: true }), { reserve: 0n, value: 50_000_000n });
  // at the floor of what the sweep needs, under its cap: priced with it
  assert.ok(5_000n + 1_000_000n + AFTER < 5_420_920n);
  assert.ok(AFTER >= rentMin(0));
});

// Review M2 of 0068524a: the teardown's read-back had no wall-clock bound: one slow provider held the seed lock and the
// device-wide sell lock for its whole read count.
test("a teardown frame no provider indexes stops the rent back at POOL_RENT_BACK_MS on the wall clock, owed for the next load, nothing swept", async () => {
  let waited = 0;
  // the frames' blockhash never past on either RPC (finalized height 0): only the wall clock ends the read-back
  const w = await world({ ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }], unreadTeardown: true, finalHeight: 0 });
  const a = await runPoolSell({ ...w.host, reads: 100_000, wait: async (ms: number) => void (waited += ms), now: () => BigInt(1_000 + waited) }, ASK);
  assert.equal("stage" in a && a.stage, "filled");
  assert.ok(waited <= POOL_RENT_BACK_MS + POOL_SELL_READS * POOL_SELL_WAIT_MS, `waited ${waited} ms`);
  assert.equal(w.c.deposits.filter((d) => d.sweep).length, 0);
  assert.equal(w.told.at(-1)?.state, "gave_up");
  assert.equal(w.owed.get(W.address)?.passes, 1);
});

// Review L7: a rent back that gives up, or a page closed before it ran, is owed: recorded before the
// sell leaves the device and run again on the next load until nothing is left on W.
test("a rent back owed is recorded before the sell's send and run again on the next load: one that gave up (a provider down past every try) finishes there", async () => {
  const plant: Plant = { ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }], throttle: { on: "read", n: 1_000_000 } };
  const w = await world(plant);
  let atSend: OwedRentBack | undefined;
  w.host.signed = () => void (atSend ??= w.owed.get(W.address));
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled");
  assert.deepEqual(atSend, { address: W.address, l: L.toString(), j: J, mints: [{ mint: MINT, program: TOKEN_PROGRAM }], passes: 0 });
  assert.equal(w.c.accounts.has(ATA), true, "the provider never answered: nothing closed");
  assert.equal(w.told.at(-1)?.state, "gave_up");
  assert.equal(w.owed.get(W.address)?.passes, 1);
  // the next load, the provider back: the holdings now read the token at 0
  delete plant.throttle;
  const loaded: PoolSellHost = { ...w.host, wallets: async () => [{ ...wallet(AMOUNT), holdings: { native: 1n, tokens: new Map([[MINT, { amount: 0n, frozen: false }]]), unreadable: [] } }] };
  await resumeRentBacks(loaded, fakeLocks());
  assert.deepEqual({ tokenAccount: w.c.accounts.has(ATA), volumeAccount: w.c.accounts.has(solanaVolumeAccumulator(W.address, SOLANA_PUMP_PROGRAM)), w: w.c.accounts.get(W.address)?.lamports ?? 0 }, { tokenAccount: false, volumeAccount: false, w: 0 });
  assert.equal(w.c.deposits.filter((d) => d.sweep).length, 1);
  await resumeRentBacks(loaded, fakeLocks());
  assert.equal(w.owed.size, 0, "the pass after finds nothing left");
});

// The review of c1fd2d20, 2c: resumeRentBacks held the sell lock around its whole list, so a sell tapped meanwhile
// waited for every owed W's pass (up to POOL_RENT_BACK_MS each against a throttled provider). It takes the lock per W:
// a tap waits for the one W in flight, and the rest wait for the next load.
/** Locks as the Web Locks API grants them: in request order, `ifAvailable` only when none is held or waiting. */
function fifoLocks(): Pick<LockManager, "request"> {
  const q = new Map<string, { busy: boolean; waiters: (() => void)[] }>();
  return {
    request: (async (name: string, opts: { mode: string; ifAvailable?: boolean }, f: (l: unknown) => Promise<unknown>) => {
      const s = q.get(name) ?? { busy: false, waiters: [] };
      q.set(name, s);
      if (s.busy || s.waiters.length > 0) {
        if (opts.ifAvailable) return f(null);
        await new Promise<void>((r) => s.waiters.push(r));
      }
      s.busy = true;
      try {
        return await f({ name });
      } finally {
        const next = s.waiters.shift();
        if (next) next();
        else s.busy = false;
      }
    }) as never,
  };
}
test("a sell tapped while owed Ws run their rent backs waits for the one W in flight, never the list", async () => {
  const w = await world({});
  const others = ["CTsw1111111111111111111111111111111111111111", "CTsw2222222222222222222222222222222222222222", "CTsw3333333333333333333333333333333333333333"];
  for (const [k, address] of others.entries()) await w.host.owed!.put({ address, l: "9", j: k, mints: [{ mint: MINT, program: TOKEN_PROGRAM }], passes: 0 });
  const started = new Set<string>();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const gated = (r: SolanaRpc): SolanaRpc => (async (method: string, params: readonly unknown[]) => {
    const hit = method === "getMultipleAccounts" ? others.find((a) => (params[0] as string[]).includes(a)) : undefined;
    if (hit !== undefined) {
      started.add(hit);
      await gate;
    }
    return r(method, params);
  }) as SolanaRpc;
  const host: PoolSellHost = { ...w.host, rpcs: [gated(w.host.rpcs[0]), gated(w.host.rpcs[1])], wallets: async () => others.map((address, k) => ({ ...wallet(0n), address, l: 9n, j: k, holdings: { native: 0n, tokens: new Map(), unreadable: [] } })) };
  const locks = fifoLocks();
  const run = resumeRentBacks(host, locks);
  for (let i = 0; i < 200 && started.size === 0; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(started.size, 1, "one W's pass in flight");
  let atTap = -1;
  const tap = locks.request(POOL_SELL_LOCK, { mode: "exclusive" }, async () => void (atTap = started.size));
  release();
  await Promise.all([run, tap]);
  assert.equal(atTap, 1, "the tap's sell starts after the one W in flight");
  // that W read empty on both RPCs: dropped; the two after it wait for the next load, still owed
  assert.deepEqual(others.map((a) => w.owed.has(a)), [false, true, true]);
  await resumeRentBacks(host, locks);
  assert.equal(w.owed.size, 0);
});

// The review of c1fd2d20 (2a, 2b): no pass bound. A provider down past every try on every load never makes the device
// stop owing W: the record stays, nothing told as given up for good, W's token account still open for the next load.
test("a rent back that gives up on every load stays owed, never given up for good, what is left still on W", async () => {
  const w = await world({ ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }], throttle: { on: "read", n: 1_000_000 } });
  await runPoolSell(w.host, ASK);
  const loaded: PoolSellHost = { ...w.host, wallets: async () => [{ ...wallet(AMOUNT), holdings: { native: 1n, tokens: new Map([[MINT, { amount: 0n, frozen: false }]]), unreadable: [] } }] };
  for (let i = 1; i < 10; i++) await resumeRentBacks(loaded, fakeLocks());
  assert.equal(w.owed.get(W.address)?.passes, 10);
  assert.equal(w.told.some((t) => /owed no more/.test(t.detail)), false);
  assert.equal(w.c.accounts.has(ATA), true);
});

// Review L2 of 0068524a: a deposit built at a tree size another deposit took first (its page full at 1,023 entries
// before it lands) fails WrongAccount; the sell is built again from new reads instead of being refused.
test("a sell whose deposit fails WrongAccount on chain on both RPCs (a page another deposit filled first) is built again from new reads and fills", async () => {
  const w = await world({ wrongAccountOnce: true, leaves: 1023 });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  const sellSends = new Set(w.c.calls.filter((c) => c.method === "sendTransaction").map((c) => base58.encode(base64.decode(c.params[0] as string).subarray(1, 65))));
  assert.ok([...sellSends].filter((sig) => solanaDecodeMessage(w.c.txs.get(sig)!.tx.subarray(65)).instructions.some((x) => x.data.length === 24)).length === 2, "the failed sell, then its rebuild");
  assert.equal(w.c.deposits.filter((d) => !d.sweep).length, 1);
});

test("a partial sell closes nothing and sweeps nothing: W keeps its token account, its volume account and the next sell's need", async () => {
  const back: string[] = [];
  const w = await world({ held: 2n * AMOUNT, ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }] }, [wallet(2n * AMOUNT)]);
  w.host.back = (s) => void back.push(s);
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled");
  assert.equal(w.c.accounts.has(ATA), true);
  assert.equal(w.c.accounts.has(solanaVolumeAccumulator(W.address, SOLANA_PUMP_PROGRAM)), true);
  assert.ok((w.c.accounts.get(W.address)?.lamports ?? 0) > 0);
  assert.deepEqual(back, []);
  assert.equal(sends(w).length, 2, "the sell alone");
  assert.deepEqual((await ours(w.ns)).map((n) => n.ref), [RETURN]);
});

test("a full sell from a W that holds another token closes nothing and sweeps nothing: what that token's sell needs stays on W", async () => {
  const back: string[] = [];
  const other = "So11111111111111111111111111111111111111112";
  const holding: BuyWallet = { ...wallet(AMOUNT), holdings: { native: 0n, tokens: new Map([[MINT, { amount: AMOUNT, frozen: false }], [other, { amount: 5n, frozen: false }]]), unreadable: [] } };
  const w = await world({ ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }] }, [holding]);
  w.host.back = (s) => void back.push(s);
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled");
  assert.deepEqual(back, []);
  assert.equal(w.c.accounts.has(solanaVolumeAccumulator(W.address, SOLANA_PUMP_PROGRAM)), true);
  assert.equal(w.c.deposits.filter((d) => d.sweep).length, 0);
});

test("the sweep's rule: W the only signer, the deposit alone, its value exactly W's lamports less the fee and the deposit's rents, at least the pool's least deposit", async () => {
  const pre = preOf(SECOND(0));
  const sizes = { stateSize: N + 1, labelSize: N + 1 };
  const ctx = { nowMs: 1_000n, wallet: W.address, feeCap: 0n, solana: PIN, precommitment: pre };
  const reads = { blockhash: BLOCKHASH, tables: {}, ...sizes };
  const costs = BigInt(FEE) + rentMin(17) + GROWTH;
  const dep = (value: bigint, wallet = W.address, p = pre) => ({
    program: PROGRAM,
    accounts: [
      { key: POOL, signer: false, writable: true },
      { key: wallet, signer: true, writable: true },
      { key: solanaPoolPage(PROGRAM, 0, sizes.stateSize), signer: false, writable: true },
      { key: solanaPoolPage(PROGRAM, 1, sizes.labelSize), signer: false, writable: true },
      { key: markOf(p), signer: false, writable: true },
      { key: "11111111111111111111111111111111", signer: false, writable: false },
      // each tree's next page (card pool-senders-next-page: the sweep's rule takes the eight only)
      { key: solanaPoolPage(PROGRAM, 0, (Math.floor(sizes.stateSize / 1024) + 1) * 1024), signer: false, writable: true },
      { key: solanaPoolPage(PROGRAM, 1, (Math.floor(sizes.labelSize / 1024) + 1) * 1024), signer: false, writable: true },
    ],
    data: Uint8Array.of(1, ...new Uint8Array(new BigUint64Array([value]).buffer), ...be32(p)),
  });
  const wire = (ixs: ReturnType<typeof dep>[] | { program: string; accounts: never[]; data: Uint8Array }[], payer = W.address) => {
    const { message } = solanaCompileV0(payer, ixs as never, BLOCKHASH, []);
    const x = new Uint8Array(65 + message.length);
    x[0] = 1;
    x.set(message, 65);
    return x;
  };
  // the three accounts as the program leaves them: no mark, each page at its rent for its N + 1 entries
  const page = rentMin(16 + (N + 1) * 72);
  const held = { mark: [null, null], state: [page, page], label: [page, page] } as const;
  const lamports = 5_000_000n;
  assert.equal(checkSolanaSweep(wire([dep(lamports - costs)]), ctx, reads, lamports, rent, held), lamports - costs);
  const refused = (f: () => unknown, rule: string) => assert.throws(f, (e: unknown) => e instanceof PoolRuleRefused && (e as PoolRuleRefused).rule === rule, rule);
  refused(() => checkSolanaSweep(wire([dep(lamports - costs - 1n)]), ctx, reads, lamports, rent, held), "sweep_amount");
  refused(() => checkSolanaSweep(wire([dep(lamports - costs + 1n)]), ctx, reads, lamports, rent, held), "sweep_amount");
  refused(() => checkSolanaSweep(wire([dep(lamports - costs, W.address, pre + 1n)]), ctx, reads, lamports, rent, held), "precommitment");
  refused(() => checkSolanaSweep(wire([{ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 0, 0) }, dep(lamports - costs)] as never), ctx, reads, lamports, rent, held), "instructions");
  refused(() => checkSolanaSweep(wire([dep(lamports - costs), dep(1n)] as never), ctx, reads, lamports, rent, held), "instructions");
  refused(() => checkSolanaSweep(wire([dep(lamports - costs, FEE_PAYER)], FEE_PAYER), ctx, reads, lamports, rent, held), "signers");
  // the six, the form before d3edab1: a sweep the device builds always names the next pages
  const six = dep(lamports - costs);
  refused(() => checkSolanaSweep(wire([{ ...six, accounts: six.accounts.slice(0, 6) }]), ctx, reads, lamports, rent, held), "deposit_accounts");
  const small = costs + SOLANA_POOL_MIN_DEPOSIT - 1n;
  refused(() => checkSolanaSweep(wire([dep(small - costs)]), ctx, reads, small, rent, held), "amount");
  // card sol-w-sweep: per volume account still owed cashback, W keeps exactly what its later claim costs (rent(0), the
  // claim frame's fee, the claim account's rent), and nothing more or less; no more owed accounts than the two programs
  const big = 10_000_000n;
  const keep = (n: bigint) => (n === 0n ? 0n : rentMin(0) + n * (BigInt(FEE) + rentMin(165)));
  assert.equal(solanaSweepKeep(rent, 0), 0n);
  for (const n of [1, 2] as const) {
    assert.equal(solanaSweepKeep(rent, n), keep(BigInt(n)));
    assert.equal(checkSolanaSweep(wire([dep(big - costs - keep(BigInt(n)))]), ctx, reads, big, rent, held, n), big - costs - keep(BigInt(n)));
    refused(() => checkSolanaSweep(wire([dep(big - costs - keep(BigInt(n)) + 1n)]), ctx, reads, big, rent, held, n), "sweep_amount");
    refused(() => checkSolanaSweep(wire([dep(big - costs - keep(BigInt(n)) - 1n)]), ctx, reads, big, rent, held, n), "sweep_amount");
  }
  refused(() => checkSolanaSweep(wire([dep(big - costs - keep(1n))]), ctx, reads, big, rent, held), "sweep_amount");
  for (const n of [3, -1, 1.5, Number.NaN]) refused(() => checkSolanaSweep(wire([dep(big - costs - keep(1n))]), ctx, reads, big, rent, held, n), "sweep_reads");
});

// Review M1 of 0068524a: the sweep's floor was the pool's least deposit (1,000,000), not the smallest note the device can
// spend: a note between them can never be withdrawn or buy, and the deposit's rents are gone with it.
test("the sweep's rule refuses a note under the smallest one a withdraw spends (solanaSweepFloor), though over the pool's least deposit", () => {
  const floor = solanaSweepFloor(rent);
  assert.equal(floor, withdrawNoteFloor({ fee: solanaPoolFee(rent), wFee: 5_000n, minPart: solanaWithdrawMinPart(rent, solanaPoolFee(rent), 5_000n) }));
  assert.ok(floor > SOLANA_POOL_MIN_DEPOSIT);
  const pre = preOf(SECOND(0));
  const sizes = { stateSize: N + 1, labelSize: N + 1 };
  const ctx = { nowMs: 1_000n, wallet: W.address, feeCap: 0n, solana: PIN, precommitment: pre };
  const reads = { blockhash: BLOCKHASH, tables: {}, ...sizes };
  const page = rentMin(16 + (N + 1) * 72);
  const held = { mark: [null, null], state: [page, page], label: [page, page] } as const;
  const costs = BigInt(FEE) + rentMin(17) + GROWTH;
  const wire = (value: bigint) => {
    const { message } = solanaCompileV0(W.address, [{ program: PROGRAM, accounts: [{ key: POOL, signer: false, writable: true }, { key: W.address, signer: true, writable: true }, { key: solanaPoolPage(PROGRAM, 0, sizes.stateSize), signer: false, writable: true }, { key: solanaPoolPage(PROGRAM, 1, sizes.labelSize), signer: false, writable: true }, { key: markOf(pre), signer: false, writable: true }, { key: "11111111111111111111111111111111", signer: false, writable: false }, { key: solanaPoolPage(PROGRAM, 0, (Math.floor(sizes.stateSize / 1024) + 1) * 1024), signer: false, writable: true }, { key: solanaPoolPage(PROGRAM, 1, (Math.floor(sizes.labelSize / 1024) + 1) * 1024), signer: false, writable: true }], data: Uint8Array.of(1, ...new Uint8Array(new BigUint64Array([value]).buffer), ...be32(pre)) }], BLOCKHASH, []);
    const x = new Uint8Array(65 + message.length);
    x[0] = 1;
    x.set(message, 65);
    return x;
  };
  const under = (SOLANA_POOL_MIN_DEPOSIT + floor) / 2n;
  assert.throws(() => checkSolanaSweep(wire(under), ctx, reads, under + costs, rent, held), (e: unknown) => e instanceof PoolRuleRefused && e.rule === "amount");
  assert.equal(checkSolanaSweep(wire(floor), ctx, reads, floor + costs, rent, held), floor);
});

// Review L1 of 0068524a: the deposit's rents were the device's own formula, not what the program takes: a page or a mark
// holding more than its rent (anyone may send lamports to one) takes less from W, so the sweep left W a remainder.
test("the deposit's rents are what the program takes: a page or mark holding lamports already is topped up only by the rest, and two RPCs that differ are refused", () => {
  const sizes = { stateSize: N + 1, labelSize: N + 1 };
  const page = rentMin(16 + (N + 1) * 72);
  const grow = rentMin(16 + (N + 2) * 72) - page;
  assert.equal(solanaDepositRents(rent, sizes, { mark: [null, null], state: [page, page], label: [page, page] }), rentMin(17) + 2n * grow);
  assert.equal(solanaDepositRents(rent, sizes, { mark: [100n, 100n], state: [page + 10n, page + 10n], label: [page + grow, page + grow] }), rentMin(17) - 100n + grow - 10n);
  // a new page (the tree's size at a page's first entry): created at the rent for its header and one entry
  assert.equal(solanaDepositRents(rent, { stateSize: 1024, labelSize: 2048 }, { mark: [null, null], state: [null, null], label: [null, null] }), rentMin(17) + 2n * rentMin(16 + 72));
  assert.throws(() => solanaDepositRents(rent, sizes, { mark: [null, null], state: [page, page + 1n], label: [page, page] }), (e: unknown) => e instanceof PoolRuleRefused && e.rule === "deposit_reads");
});

// Review M-A of eca191d8: a teardown frame that failed on chain on both RPCs counted as done, so the sweep still took W
// to 0 with an account open and nothing left to pay its close. The sweep reads W and its accounts again first.
test("a teardown frame that fails on chain because a token unit was sent to W's token account before its close: that account stays open with W's lamports to close it, nothing swept", async () => {
  const w = await world({ ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }], teardownFails: "dust" });
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  assert.equal(w.c.accounts.has(ATA), true, "the close failed: the token account is open");
  assert.equal(w.c.accounts.has(solanaVolumeAccumulator(W.address, SOLANA_PUMP_PROGRAM)), false, "the volume close landed");
  assert.ok((w.c.accounts.get(W.address)?.lamports ?? 0) > FEE, "W keeps the fee to close what is open");
  assert.equal(w.c.deposits.filter((d) => d.sweep).length, 0);
  assert.equal(w.told.at(-1)?.state, "kept", JSON.stringify(w.told));
});

test("a teardown frame that fails on chain on both RPCs with nothing moved: no sweep, owed, and the next load closes it and sweeps W to 0", async () => {
  const plant: Plant = { ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }], teardownFails: "once" };
  const w = await world(plant);
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  assert.equal(w.c.accounts.has(ATA), true);
  assert.ok((w.c.accounts.get(W.address)?.lamports ?? 0) > FEE);
  assert.equal(w.c.deposits.filter((d) => d.sweep).length, 0);
  assert.equal(w.told.at(-1)?.state, "gave_up", JSON.stringify(w.told));
  assert.equal(w.owed.get(W.address)?.passes, 1);
  const loaded: PoolSellHost = { ...w.host, wallets: async () => [{ ...wallet(AMOUNT), holdings: { native: 1n, tokens: new Map([[MINT, { amount: 0n, frozen: false }]]), unreadable: [] } }] };
  // the next load, a later blockhash: the close built again is a new transaction
  plant.blockhash = base58.encode(new Uint8Array(32).fill(9));
  assert.notEqual(plant.blockhash, BLOCKHASH);
  await resumeRentBacks(loaded, fakeLocks());
  assert.deepEqual({ tokenAccount: w.c.accounts.has(ATA), w: w.c.accounts.get(W.address)?.lamports ?? 0 }, { tokenAccount: false, w: 0 }, JSON.stringify(w.told));
  assert.equal(w.c.deposits.filter((d) => d.sweep).length, 1);
});

// Review M-B of eca191d8: the owed record is written before the sell's send; one whose sell never filled (or has not
// yet) skipped the holds check on its own mint, so the next load closed W's volume and wrapped-SOL accounts while W still
// held the token, and "kept" dropped the record, so a sell landing late never got its rent back.
test("a stale owed record while W still holds the token closes nothing and stays owed, its sell note INCOMING or PLANNED again", async () => {
  const plant: Plant = { ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }, { program: SOLANA_PUMP_AMM_PROGRAM }], lands: false, finalHeight: 0 };
  const w = await world(plant);
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "sent", JSON.stringify(a));
  const open = () => ({ ata: w.c.accounts.has(ATA), volume: w.c.accounts.has(solanaVolumeAccumulator(W.address, SOLANA_PUMP_PROGRAM)), ammVolume: w.c.accounts.has(solanaVolumeAccumulator(W.address, SOLANA_PUMP_AMM_PROGRAM)) });
  const allOpen = { ata: true, volume: true, ammVolume: true };
  const sent = sends(w).length;
  // the reload while the sell may still land: W holds the token on both RPCs
  await resumeRentBacks(w.host, fakeLocks());
  assert.deepEqual(open(), allOpen);
  assert.equal(sends(w).length, sent, "nothing built or sent");
  assert.equal(w.told.at(-1)?.state, "holds", JSON.stringify(w.told));
  assert.ok(w.owed.has(W.address), "owed while the sell's note is INCOMING");
  // past its blockhash: the settle plans the note again (the sell never landed); W still holds, so the record stays
  // (review of c1fd2d20, 2a: only both RPCs reading W empty drop it) and nothing of W is closed
  plant.finalHeight = 1_000;
  await settle(w);
  assert.equal((await ours(w.ns)).find((n) => n.ref.kind === "return")?.state, "PLANNED");
  await resumeRentBacks(w.host, fakeLocks());
  assert.deepEqual(open(), allOpen);
  assert.ok(w.owed.has(W.address));
});

// Review L-A of eca191d8: the rebuild flag was set before the settle, so a WrongAccount failure whose note was taken
// or is still pending built the sell again; on pending the rebuild threw on the INCOMING note, refused flipping to failed.
for (const [what, plant] of [["still pending (its mark on one RPC only)", { hideOn1: markOf(preOf(RETURN)) }], ["taken (the user's own deposit on its precommitment)", {}]] as const) {
  test(`a sell whose deposit fails WrongAccount on both RPCs with its note ${what} is refused once, never built again`, async () => {
    const w = await world({ wrongAccountOnce: true, wrongAccountTakes: true, leaves: 1023, ...plant });
    const a = await runPoolSell(w.host, ASK);
    assert.equal("stage" in a && a.stage, "refused", JSON.stringify(a));
    const sellSends = new Set(w.c.calls.filter((c) => c.method === "sendTransaction").map((c) => base58.encode(base64.decode(c.params[0] as string).subarray(1, 65))));
    assert.equal(sellSends.size, 1, "the one sell, never built again");
  });
}

// Review L-B of eca191d8: the kind's answer was fixed at the first send, so a sell built again (L2) named the attempt
// that failed. The answer read after the run, and the request's record, name the signature that landed.
test("a sell built again after WrongAccount: the kind's answer and the request's record name the signature that landed, never the failed attempt's", async () => {
  const w = await world({ wrongAccountOnce: true, leaves: 1023 });
  const stages: string[] = [];
  const ended = { n: 0 };
  const r = poolSellKind(kindHost(w, ended), fakeLocks())(ASK, ctxOf("lb1", "00", stages)) as KindAnswer;
  await r.after;
  await until(async () => ended.n > 0);
  const landed = [...w.c.txs].filter(([, t]) => t.err === null && solanaDecodeMessage(t.tx.subarray(65)).instructions.some((x) => x.data.length === 24)).map(([sig]) => sig);
  assert.equal(landed.length, 1);
  assert.deepEqual(r.answer().result, { stage: "filled", txs: [{ chain: "solana", hash: landed[0] }] });
  const op = (await w.store.get("ops", "lb1")) as { stage: string; txs: { hash: string }[] };
  assert.deepEqual({ stage: op.stage, txs: op.txs.map((t) => t.hash) }, { stage: "filled", txs: landed });
  assert.deepEqual(stages, ["filled"]);
});

// Review L-C of eca191d8: the sweep's seed copy was zeroed only after returnNote returned, so each try that threw (the
// expected path while the sell's note is pending) left one live for up to POOL_RENT_BACK_MS.
test("the sweep's seed copy is zeroed when the walk for its note throws, before the next try", async () => {
  const w = await world({ ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }] });
  // the walk throws while the sweep's note's mark reads on one RPC only: planted on RPC 0 once the sell has landed
  const mark = markOf(preOf(SECOND(0)));
  const md = new Uint8Array(17);
  md[16] = 1;
  const [rpc0, rpc1] = w.c.rpcs;
  const rpcs = [(async (m: string, p: readonly unknown[]) => {
    if (m === "getAccountInfo" && p[0] === mark && w.c.deposits.length > 0) return { context: { slot: 1 }, value: { owner: PROGRAM, lamports: 1, data: [base64.encode(md), "base64"], executable: false, rentEpoch: 0, space: 17 } };
    return rpc0(m, p);
  }) as SolanaRpc, rpc1] as const;
  let tries = 0;
  let live = 0;
  // at each wait between tries, every seed copy taken before it is zeroed already
  const wait = async (): Promise<void> => {
    tries++;
    live = Math.max(live, w.seeds.filter((c) => c.some((b) => b !== 0)).length);
  };
  const a = await runPoolSell({ ...w.host, rpcs, wait }, ASK);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  assert.ok(w.told.some((t) => t.step === "sweep" && t.state === "fault"), JSON.stringify(w.told));
  assert.ok(tries > 1);
  assert.equal(live, 0, "no seed copy live between tries");
  assert.equal(w.c.deposits.filter((d) => d.sweep).length, 0);
});

// Review Low 2 of 9b23f6ae: two rules no test held. W's token account holding tokens on one RPC only is that RPC's word:
// read again, never "holds" (which would drop what is owed on one RPC's word, the rent left on W).
test("an owed rent back whose token account holds tokens on one RPC only reads again, never ends holds: still owed", async () => {
  const plant: Plant = { ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }], throttle: { on: "read", n: 1_000_000 } };
  const w = await world(plant);
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled");
  assert.equal((await ours(w.ns)).find((n) => n.ref.kind === "return")?.state, "UNSPENT");
  assert.equal(w.owed.get(W.address)?.passes, 1);
  delete plant.throttle;
  const list = JSON.stringify([W.address, ...solanaTeardownAddresses(W.address, [{ mint: MINT, program: TOKEN_PROGRAM }])]);
  const [rpc0, rpc1] = w.c.rpcs;
  // RPC 0 shows one token unit on W's token account; RPC 1 none
  const shows = (async (m: string, p: readonly unknown[]) => {
    const r = await rpc0(m, p);
    if (m !== "getMultipleAccounts" || JSON.stringify(p[0]) !== list) return r;
    const out = structuredClone(r) as { value: ({ data: [string, string] } | null)[] };
    const i = (p[0] as string[]).indexOf(ATA);
    out.value[i] = { ...out.value[i]!, data: [base64.encode(tokenAccount(1n)), "base64"] };
    return out;
  }) as SolanaRpc;
  const told = w.told.length;
  await resumeRentBacks({ ...w.host, rpcs: [shows, rpc1], wallets: async () => [{ ...wallet(AMOUNT), holdings: { native: 1n, tokens: new Map([[MINT, { amount: 0n, frozen: false }]]), unreadable: [] } }] }, fakeLocks());
  const now = w.told.slice(told);
  assert.ok(now.some((t) => t.step === "teardown" && t.state === "fault" && /one RPC only/.test(t.detail)), JSON.stringify(now));
  assert.ok(!now.some((t) => t.state === "holds"), JSON.stringify(now));
  assert.equal(w.owed.get(W.address)?.passes, 2, "still owed for the next load");
  assert.equal(w.c.accounts.has(ATA), true);
});

// The sweep's own read finds an account the plan keeps (a volume account owing incentive tokens appears after the
// teardown): no sweep is built, W keeps the fee to claim and close it.
test("the sweep's read finds an account the plan keeps: no sweep built, kept", async () => {
  const w = await world({ ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }] });
  const list = JSON.stringify([W.address, ...solanaTeardownAddresses(W.address, [{ mint: MINT, program: TOKEN_PROGRAM }])]);
  const amm = solanaVolumeAccumulator(W.address, SOLANA_PUMP_AMM_PROGRAM);
  const d = new Uint8Array(137);
  d.set(base58.decode(W.address), 8);
  d[40] = 1;
  const owedVolume = { owner: SOLANA_PUMP_AMM_PROGRAM, lamports: Number(VOLUME_RENT), data: [base64.encode(d), "base64"], executable: false, rentEpoch: 0, space: 137 };
  const reads = [0, 0];
  const rpcs = w.c.rpcs.map((r, k) => (async (m: string, p: readonly unknown[]) => {
    const got = await r(m, p);
    if (m !== "getMultipleAccounts" || JSON.stringify(p[0]) !== list || ++reads[k]! < 2) return got;
    // the sweep's read (the teardown's was the first): W's PumpSwap volume account there, owing incentive tokens
    const out = structuredClone(got) as { value: unknown[] };
    out.value[(p[0] as string[]).indexOf(amm)] = owedVolume;
    return out;
  }) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];
  const a = await runPoolSell({ ...w.host, rpcs }, ASK);
  assert.equal("stage" in a && a.stage, "filled");
  assert.equal(w.c.accounts.has(ATA), false, "the teardown ran");
  assert.equal(w.c.deposits.filter((d) => d.sweep).length, 0);
  assert.equal(w.told.at(-1)?.state, "kept", JSON.stringify(w.told));
  assert.match(w.told.at(-1)!.detail, new RegExp(amm));
});

// Card pool-read-down: one provider down past the page's own retry, from each of its calls in turn (the devnet run at
// 967c52d6). Before W signs, the sell answers "down" (api.ts RETRY_CODES: the same request again runs again), never
// failed or not_allowed: the seed never read for W's key, nothing signed or sent, no note written; the other provider's
// word alone is never taken. From W's signature on, it is never "down": the transaction may land.
for (const p of [0, 1] as const) {
  test(`card pool-read-down: provider ${p} down past the page's retry answers down before W signs, and never down after`, async () => {
    let before = 0;
    let after = 0;
    for (let from = 0; ; from++) {
      const w = await world();
      const d = pairDown(w.host.rpcs, p, from);
      const a = await runPoolSell({ ...w.host, rpcs: d.rpcs }, ASK);
      if (!d.fired()) break;
      if (w.sent.length === 0 && !w.c.log.some((x) => x.endsWith("sendTransaction"))) {
        before++;
        assert.deepEqual(a, { error: "down" }, `from call ${from}`);
        assert.deepEqual(await ours(w.ns), [], `from call ${from}: no note written`);
      } else {
        after++;
        assert.notDeepEqual(a, { error: "down" }, `from call ${from}`);
      }
    }
    assert.ok(before > 0 && after > 0, `${before} before, ${after} after`);
  });
}

// Card pool-senders-next-page: the sell's deposit back names each tree's next page (tag 1 of 8 accounts, deposit.rs:72-76
// since d3edab1) whenever the sell still fits 1,232 bytes with them; the largest, a PumpSwap cashback sell with no lookup
// table, keeps the six (the form before d3edab1), and the rule takes both.
test("the sell's deposit names each tree's next page when the sell fits 1,232 bytes with them; a PumpSwap cashback sell keeps the six", async () => {
  const depositOf = (w: Awaited<ReturnType<typeof world>>) => {
    const sent = w.c.calls.filter((c) => c.method === "sendTransaction").map((c) => base64.decode(c.params[0] as string));
    assert.ok(sent.length > 0, "a sell sent");
    const tx = sent[0]!;
    const m = solanaDecodeMessage(tx.subarray(65));
    const ix = m.instructions.at(-1)!;
    return { size: tx.length, keys: ix.accounts.map((i) => m.staticKeys[i]) };
  };
  const next = (tree: 0 | 1) => solanaPoolPage(PROGRAM, tree, (Math.floor(N / 1024) + 1) * 1024);
  const pump = await world({});
  const s = await runPoolSell(pump.host, ASK);
  assert.equal("stage" in s && s.stage, "filled", JSON.stringify(s));
  const p = depositOf(pump);
  assert.equal(p.keys.length, 8, `pump: ${p.size} B`);
  assert.deepEqual(p.keys.slice(6), [next(0), next(1)]);
  const ask = { ...ASK, token: VF.pumpswap.mint };
  const cashbackRent = rentMin(137) + rentMin(165);
  const big = await world({ venue: "pumpswap", cashback: true, lamports: Number(BigInt(FEE) + rentMin(165) + cashbackRent) });
  const a = await runPoolSell(big.host, ask);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  const b = depositOf(big);
  assert.equal(b.keys.length, 6, `pumpswap cashback: ${b.size} B`);
  assert.ok(b.size + 64 > 1232, `pumpswap cashback: ${b.size} B fits the next pages`);
});

// Review of 14b04117, M1: the sell's reserve priced the deposit's pages at the read sizes only. One state leaf landing
// between the read and the sell (a release's change note) carries the sell's state entry onto the next page, which
// costs rent(16 + 72) where the read page's top-up was 72 bytes; at exactly min out W then ended under the next sell's
// need. The reserve prices an 8-account deposit with the kit's next-page window (solanaPoolDepositCost's rule).
test("a partial sell at a page's last slots, with one insert between its read and its landing, still leaves W the next sell's need", async () => {
  const probe = await world({});
  const venue = await readSolanaPoolBuyVenue(probe.host.rpcs, "pump-curve", MINT);
  const need = solanaPoolBuySellNeed(venue, rent);
  const w = await world({ leaves: 1023, labelLeaves: 1000, insertFirst: true, held: 2n * AMOUNT, lamports: Number(need) }, [wallet(2n * AMOUNT)]);
  const a = await runPoolSell(w.host, ASK);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  assert.ok(w.c.accounts.has(solanaPoolPage(PROGRAM, 0, 1024)), "the sell's state entry opened the next page");
  const left = BigInt(w.c.accounts.get(W.address)?.lamports ?? 0);
  assert.ok(left >= need, `W keeps ${left}, short of ${need} by ${need - left}`);
});

// The delta review of 5059541a. The sell's sent deposits, in order: each its account count and whether it landed.
const sellDeposits = (w: World) =>
  [...new Set(w.c.calls.filter((c) => c.method === "sendTransaction").map((c) => c.params[0] as string))]
    .map((b) => base64.decode(b))
    .map((tx) => ({ sig: base58.encode(tx.subarray(1, 65)), m: solanaDecodeMessage(tx.subarray(65)) }))
    .filter(({ m }) => m.instructions.length > 1 && m.staticKeys[m.instructions.at(-1)!.programIndex] === PROGRAM)
    .map(({ sig, m }) => ({ keys: m.instructions.at(-1)!.accounts.length, err: w.c.txs.has(sig) ? w.c.txs.get(sig)!.err : "unsent" }));
const partialAtNeed = async (plant: Plant) => {
  const probe = await world({});
  const need = solanaPoolBuySellNeed(await readSolanaPoolBuyVenue(probe.host.rpcs, "pump-curve", MINT), rent);
  const w = await world({ ...plant, held: 2n * AMOUNT, lamports: Number(need) }, [wallet(2n * AMOUNT)]);
  return { w, need, a: await runPoolSell(w.host, ASK) };
};

// T1 (kills M1d and M1e, one tree priced exactly): both trees at their page's last slot and another's deposit, a leaf on
// both, landing between the read and the sell, so both entries go on the next pages: the eight lands at once, both next
// pages opened, and W keeps the next sell's need; priced for one tree alone, W would end one page's opening short.
test("T1: both trees at 1,023 and a deposit landing first: the partial sell's eight lands at once, both next pages opened, W keeps the next sell's need", async () => {
  const { w, need, a } = await partialAtNeed({ leaves: 1023, labelLeaves: 1023, insertFirst: true, insertKind: "deposit" });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  assert.deepEqual(sellDeposits(w), [{ keys: 8, err: null }]);
  for (const tree of [0, 1] as const) assert.ok(w.c.accounts.has(solanaPoolPage(PROGRAM, tree, 1024)), `tree ${tree}'s next page opened`);
  const left = BigInt(w.c.accounts.get(W.address)?.lamports ?? 0);
  assert.ok(left >= need, `W keeps ${left}, short of ${need} by ${need - left}`);
});

// M1c (the window's boundary): at size % 1,024 = 960 a tree is 64 entries from its page's end, inside the window, so the
// partial sell names the next pages and prices both openings; 64 deposits landing first carry both entries onto them.
test("the window's edge: both trees at 960 (64 from the page's end) and 64 deposits landing first: the eight, priced at both openings, lands at once and W keeps the need", async () => {
  const { w, need, a } = await partialAtNeed({ leaves: 960, labelLeaves: 960, insertFirst: true, insertKind: "deposit", insertCount: 64 });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  assert.deepEqual(sellDeposits(w), [{ keys: 8, err: null }]);
  for (const tree of [0, 1] as const) assert.ok(w.c.accounts.has(solanaPoolPage(PROGRAM, tree, 1024)), `tree ${tree}'s next page opened`);
  const left = BigInt(w.c.accounts.get(W.address)?.lamports ?? 0);
  assert.ok(left >= need, `W keeps ${left}, short of ${need} by ${need - left}`);
});

// T2 (LOW 1): a tree outside the window (state 959, 65 from its page's end; label 500) on a partial sell: the six, priced
// exactly; 65 releases landing first carry the state entry onto the next page, so the six fails WrongAccount, W paying
// its fee alone, and the sell is built again from new reads and lands; W keeps the next sell's need. Named as the eight,
// it landed and W paid the page's opening out of that need, ending 731,520 short at 5,080 a byte.
test("T2: a partial sell with a tree outside the window sends the six; 65 releases landing first fail it WrongAccount, it is built again and W keeps the need", async () => {
  const { w, need, a } = await partialAtNeed({ leaves: 959, labelLeaves: 500, insertFirst: true, insertCount: 65 });
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  const sent = sellDeposits(w);
  assert.equal(sent.length, 2, JSON.stringify(sent));
  assert.deepEqual(sent[0], { keys: 6, err: { InstructionError: [sent[0]!.err && (sent[0]!.err as { InstructionError: [number] }).InstructionError[0], { Custom: 22 }] } });
  assert.equal(sent[1]!.err, null);
  const left = BigInt(w.c.accounts.get(W.address)?.lamports ?? 0);
  assert.ok(left >= need, `W keeps ${left}, short of ${need} by ${need - left}`);
});

// LOW 1, each tree: one tree inside the window and the other out (1,023/500, 500/1,023): a partial sell sends the six.
test("a partial sell with one tree inside the window and the other out sends the six; a full sell there still sends the eight", async () => {
  for (const [leaves, labelLeaves] of [[1023, 500], [500, 1023]] as const) {
    const { w, a } = await partialAtNeed({ leaves, labelLeaves });
    assert.equal("stage" in a && a.stage, "filled", `${leaves}/${labelLeaves} ${JSON.stringify(a)}`);
    assert.deepEqual(sellDeposits(w), [{ keys: 6, err: null }], `${leaves}/${labelLeaves}`);
    const full = await world({ leaves, labelLeaves, ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }] });
    const f = await runPoolSell(full.host, ASK);
    assert.equal("stage" in f && f.stage, "filled", JSON.stringify(f));
    assert.equal(sellDeposits(full)[0]!.keys, 8, `${leaves}/${labelLeaves} full`);
  }
});

// LOW 3: the window raises the eight's reserve by both openings (1,463,040 at 5,080 a byte). The least min out with W at
// exactly what it keeps after: 2,473,120 for the six at any size, 3,936,160 for the eight inside the window. In between,
// the eight is refused and the six carries the sell, as on main; under 2,473,120 both are refused.
test("LOW 3: the reserve's band edges at 5,080 a byte: the eight from 3,936,160 min out, the six from 2,473,120, nothing under", () => {
  assert.equal(rent.lamportsPerByte * rent.factor, 5_080n, "the fixture's rent");
  const after = 1_493_440n;
  const at = (n: number) => ({ mark: [null, null] as const, state: [solanaRentMin(rent, 16 + (n % 1024) * 72), solanaRentMin(rent, 16 + (n % 1024) * 72)] as const, label: [solanaRentMin(rent, 16 + (n % 1024) * 72), solanaRentMin(rent, 16 + (n % 1024) * 72)] as const });
  const price = (size: number, next: boolean, minOut: bigint) => solanaSellReserve({ fee: 5_000n, made: 0n, rents: solanaDepositRents(rent, { stateSize: size, labelSize: size }, at(size), next), after, lamports: after, minOut, keeps: true });
  for (const size of [960, 1023]) {
    assert.deepEqual(price(size, true, 3_936_160n), { reserve: 2_936_160n, value: SOLANA_POOL_MIN_DEPOSIT }, `${size} eight at its edge`);
    assert.deepEqual(price(size, true, 3_936_159n), { refused: "quote_check_failed" }, `${size} eight under its edge`);
    assert.deepEqual(price(size, false, 3_936_159n), { reserve: 1_473_120n, value: 2_463_039n }, `${size} six in the band`);
    assert.deepEqual(price(size, false, 2_473_120n), { reserve: 1_473_120n, value: SOLANA_POOL_MIN_DEPOSIT }, `${size} six at its edge`);
    assert.deepEqual(price(size, false, 2_473_119n), { refused: "quote_check_failed" }, `${size} six under its edge`);
  }
  // outside the window the eight is priced as the six
  assert.deepEqual(price(500, true, 2_473_120n), price(500, false, 2_473_120n));
  // the cap: a partial sell's reserve over it is not_funded, a full sell's quote_check_failed
  assert.deepEqual(solanaSellReserve({ fee: 0n, made: 0n, rents: 0n, after: SOLANA_POOL_SELL_RESERVE_MAX + 1n, lamports: 0n, minOut: 10n ** 9n, keeps: true }), { refused: "not_funded" });
  assert.deepEqual(solanaSellReserve({ fee: 0n, made: 0n, rents: 0n, after: SOLANA_POOL_SELL_RESERVE_MAX + 1n, lamports: 0n, minOut: 10n ** 9n, keeps: false }), { refused: "quote_check_failed" });
});

// LOW 3 on the sell: both trees inside the window and W at exactly what it keeps after; a sell of fewer tokens, so its
// min out (the curve's, less the slippage) falls in the band the window opened, is sent as the six, as on main, and
// lands; one at the eight's edge or above goes as the eight; one under the six's edge is refused before signing.
/** The least amount whose min out (the sell's own: the reference's expected out less SLIPPAGE) is at least `target`. */
const amountFor = async (target: bigint): Promise<{ amount: bigint; minOut: bigint }> => {
  const minOutOf = async (amount: bigint) => ((await readSolanaReference(providers("pump"), { side: "sell", token: MINT, amount }))!.pools.find((p) => p.venue === "pump-curve")!.expectedOut * BigInt(10_000 - SLIPPAGE)) / 10_000n;
  let [lo, hi] = [1n, AMOUNT];
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await minOutOf(mid)) >= target) hi = mid;
    else lo = mid + 1n;
  }
  return { amount: lo, minOut: await minOutOf(lo) };
};
test("LOW 3: inside the window with W at what it keeps, a sell whose min out falls in the window's band goes as the six and lands; at the eight's edge, the eight; under the six's edge, refused", async () => {
  const probe = await world({});
  const need = solanaPoolBuySellNeed(await readSolanaPoolBuyVenue(probe.host.rpcs, "pump-curve", MINT), rent);
  assert.equal(need, 1_493_440n, "what W keeps after, at 5,080 a byte");
  const sell = async (target: bigint) => {
    const { amount, minOut } = await amountFor(target);
    const w = await world({ leaves: 1023, labelLeaves: 1023, held: 2n * amount, lamports: Number(need) }, [wallet(2n * amount)]);
    return { minOut, w, a: await runPoolSell(w.host, { ...ASK, amount }) };
  };
  // in the band: the eight's reserve leaves the deposit under the least deposit, the six's does not
  const band = await sell(3_000_000n);
  assert.ok(band.minOut > 2_473_120n && band.minOut < 3_936_160n, String(band.minOut));
  assert.equal("stage" in band.a && band.a.stage, "filled", JSON.stringify(band.a));
  assert.deepEqual(sellDeposits(band.w), [{ keys: 6, err: null }]);
  // at the eight's edge or above: the eight
  const edge = await sell(3_936_160n);
  assert.ok(edge.minOut >= 3_936_160n, String(edge.minOut));
  assert.equal("stage" in edge.a && edge.a.stage, "filled", JSON.stringify(edge.a));
  assert.deepEqual(sellDeposits(edge.w), [{ keys: 8, err: null }]);
  // under the six's edge: refused before anything is signed, as on main
  const { amount } = await amountFor(2_400_000n);
  const under = await world({ leaves: 1023, labelLeaves: 1023, held: 2n * amount, lamports: Number(need) }, [wallet(2n * amount)]);
  assert.deepEqual(await runPoolSell(under.host, { ...ASK, amount }), { error: "quote_check_failed" });
  assert.deepEqual(sellDeposits(under), []);
});

// Review of 14b04117, M2: the trees sit on different pages (releases grow the state tree alone), so each tree's next
// page comes from its own size.
test("the sell's and the sweep's deposits name each tree's own next page when the trees are on different pages", async () => {
  for (const [stateSize, labelSize] of [[1030, 1000], [1000, 1030]] as const) {
    const w = await world({ leaves: stateSize, labelLeaves: labelSize, ataLamports: TOKEN_RENT, volumes: [{ program: SOLANA_PUMP_PROGRAM }] });
    const a = await runPoolSell(w.host, ASK);
    assert.equal("stage" in a && a.stage, "filled", `${stateSize}/${labelSize} ${JSON.stringify(a)}`);
    const sent = w.c.calls.filter((c) => c.method === "sendTransaction").map((c) => solanaDecodeMessage(base64.decode(c.params[0] as string).subarray(65)));
    const deps = sent.filter((m) => m.staticKeys[m.instructions.at(-1)!.programIndex] === PROGRAM);
    // the sell, then W's sweep (a transaction of the deposit alone, review L1: the sweep takes eight only)
    assert.ok(deps[0]!.instructions.length > 1, "the sell first");
    assert.ok(deps.some((m) => m.instructions.length === 1), `${stateSize}/${labelSize}: a sweep sent`);
    const dedup = new Set<string>();
    for (const m of deps) {
      const ix = m.instructions.at(-1)!;
      if (dedup.has(base64.encode(ix.data))) continue;
      dedup.add(base64.encode(ix.data));
      const keys = ix.accounts.map((i) => m.staticKeys[i]);
      const sizes = m.instructions.length === 1 ? [stateSize + 1, labelSize + 1] : [stateSize, labelSize]; // the sweep lands after the sell
      assert.equal(keys.length, 8, `${stateSize}/${labelSize}`);
      assert.deepEqual(keys.slice(2, 4), [solanaPoolPage(PROGRAM, 0, sizes[0]!), solanaPoolPage(PROGRAM, 1, sizes[1]!)]);
      assert.deepEqual(keys.slice(6), [solanaPoolNextPage(PROGRAM, 0, sizes[0]!), solanaPoolNextPage(PROGRAM, 1, sizes[1]!)], `${stateSize}/${labelSize} ${m.instructions.length === 1 ? "sweep" : "sell"}`);
    }
  }
});
