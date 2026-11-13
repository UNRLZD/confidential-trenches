// The Solana pool sell's fake chain (card signpage-pool-sell), shared by test/pool-sell.test.ts and the sign-out tests
// (test/sign-out-mid-run.test.ts): the venue's answers are the kit's recorded reads (packages/kit/test/fixtures/
// solana-pool-buy.json), the pool account, its pages, the precommitment marks, W and its token account planted around
// them, and a sent deposit applied as the program applies it (contracts/pool-solana/src/deposit.rs). The seed is the
// published all-zero entropy vector (packages/wallet/test/vectors/a8.json).
import assert from "node:assert/strict";
import { base58, base64 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, freshWallet, wordsToSeed64 } from "@blindfill/wallet/derive";
import { SOLANA_ATA_PROGRAM, solanaAta, solanaDecodeMessage, solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_CLAIM_CASHBACK, SOLANA_CLOSE_VOLUME_ACCUMULATOR, SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_PUMP_AMM_PROGRAM, SOLANA_PUMP_PROGRAM, SOLANA_SOL_MINT, SOLANA_TOKEN_2022_PROGRAM as TOKEN_2022, SOLANA_TOKEN_PROGRAM, solanaVolumeAccumulator } from "../../kit/src/checks/solana/checks.ts";
import { solanaPoolPage, solanaRentMin } from "../../kit/src/trade/solana/pool-buy.ts";
import { readSolanaReference } from "../../kit/src/trade/solana/pool.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { BLOCKHASH, FEE_PAYER, POOL, PROGRAM, fx, providers, rent } from "../../kit/test/solana-pool-buy-fx.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

export const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
export const L = 7n;
export const J = 0;
export const W = freshWallet(SEED64, "sol", L, J);
W.secretKey.fill(0);
export const PIN = { program: PROGRAM, feePayer: FEE_PAYER };
export const { scope: SCOPE } = solanaPoolOf(PROGRAM);
export type Venue = "pump" | "pumpswap";
/** Each recorded venue's mint, its read (a Token-2022 mint on both), W's token account under it, the reference both
 *  providers give for exactly this sell and the floor the run's min out comes from. */
export const VF = {} as Record<Venue, { mint: string; mintRead: { owner: string; data: [string, string] }; ata: string; slot: number; minOut: bigint }>;
export const MINT = fx.pump.mint as string;
/** 4,000,000 tokens (6 decimals): the recorded curve gives about 0.11 SOL for them. */
export const AMOUNT = 4_000_000_000_000n;
export const SLIPPAGE = 300;
export const ASK: PoolAsk = { kind: "pool.sell", chain: "solana", token: MINT, amount: AMOUNT, slippageBps: SLIPPAGE, decimals: 6 };
/** ASK's amount in whole units at its decimals, as its ops record names it (card kit-portfolio-reads). */
export const UNITS = "4000000";
export const FEE = 5_000;
/** The fee the runtime charges a message: FEE (one signature) and its priority, compute unit limit x price, rounded up. */
export const feeOf = (m: ReturnType<typeof solanaDecodeMessage>): bigint => {
  let limit = 0n;
  let price = 0n;
  for (const x of m.instructions) {
    if (m.staticKeys[x.programIndex] !== SOLANA_COMPUTE_BUDGET_PROGRAM) continue;
    const dv = new DataView(x.data.buffer, x.data.byteOffset, x.data.byteLength);
    if (x.data[0] === 2) limit = BigInt(dv.getUint32(1, true));
    if (x.data[0] === 3) price = dv.getBigUint64(1, true);
  }
  return BigInt(FEE) + (limit * price + 999_999n) / 1_000_000n;
};
export const N = 6; // leaves on each tree before the sell
export const ENOUGH = 1_000_000_000; // W's lamports: a reserve of 0
export const enc = new TextEncoder();
export const be32 = (x: bigint): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => Number((x >> BigInt(8 * (31 - i))) & 255n));
export const beInt = (b: Uint8Array): bigint => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
/** A front-runner's deposit on the return note's precommitment: the pool's least deposit (contracts/pool-solana/src/lib.rs:78),
 *  the least the program writes a mark for. */
export const FRONT_RUN = 1_000_000n;
export const markOf = (pre: bigint, program = PROGRAM): string => solanaProgramAddress([enc.encode("pre"), be32(pre)], program);
export const RETURN: NoteRef = { kind: "return", c: "sol", l: L, j: J };
export const SECOND = (n: number): NoteRef => ({ kind: "second", id: { id: "R", c: "sol", l: L, j: J }, n });
export const preOf = (ref: NoteRef): bigint => noteSecrets(SEED64, ref).precommitment;

// the mint as both providers answered it in the recorded run (a Token-2022 mint): its owner is the venue's token program
export const MINT_READ = (Object.entries(fx.pump.reads[0]).find(([k]) => JSON.parse(k)[0] === MINT)![1] as { value: { owner: string; data: [string, string] }[] }).value[0]!;
export const TOKEN_PROGRAM = MINT_READ.owner;
export const ATA = solanaAta(W.address, MINT, TOKEN_PROGRAM);
// the reference both providers give for exactly this sell, and its slot: what the run's floor comes from
export const REF = (await readSolanaReference(providers("pump"), { side: "sell", token: MINT, amount: AMOUNT }))!;
export const MIN_OUT = (REF.pools.find((p) => p.venue === "pump-curve")!.expectedOut * BigInt(10_000 - SLIPPAGE)) / 10_000n;
for (const v of ["pump", "pumpswap"] as const) {
  const mint = fx[v].mint as string;
  const mintRead = (Object.entries(fx[v].reads[0]).find(([k]) => JSON.parse(k)[0] === mint)![1] as { value: { owner: string; data: [string, string] }[] }).value[0]!;
  const ref = (await readSolanaReference(providers(v), { side: "sell", token: mint, amount: AMOUNT }))!;
  VF[v] = { mint, mintRead, ata: solanaAta(W.address, mint, mintRead.owner), slot: ref.slot! + 2, minOut: (ref.pools[0]!.expectedOut * BigInt(10_000 - SLIPPAGE)) / 10_000n };
}

export type Acc = { owner: string; lamports: number; data: Uint8Array };
/** A native (WSOL) SPL Token account of `owner` holding `amount` wrapped. */
export const nativeAccount = (owner: string, amount: bigint): Uint8Array => {
  const d = new Uint8Array(165);
  d.set(base58.decode(SOLANA_SOL_MINT), 0);
  d.set(base58.decode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1;
  new DataView(d.buffer).setUint32(109, 1, true);
  return d;
};
export const tokenAccount = (amount: bigint, state = 1, mint = MINT, owner = W.address): Uint8Array => {
  const d = new Uint8Array(165);
  d.set(base58.decode(mint), 0);
  d.set(base58.decode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = state;
  return d;
};
export const pageBytes = (tree: 0 | 1, leaves: bigint[], pageNo = 0): Uint8Array => {
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

export type Plant = {
  /** the page's cluster (devnet, no priority fee, when not given); on mainnet the sell pays one (solanaSellBudget) */
  cluster?: "mainnet" | "devnet";
  /** the units each simulation answers it used (none when not given) */
  units?: number;
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
  /** RPC 1 never answers getTransaction with the transaction (a lagging or lying RPC) */
  txNoneOn1?: boolean;
  /** neither RPC answers getTransaction with the transaction, landed or not (both backends behind) */
  txNone?: boolean;
  /** RPC 1's getSignatureStatuses answers from a backend behind the slot it is past at (its context slot 1) */
  statusLagOn1?: boolean;
  /** RPC p's finalized block height (1,000 when not given: past the blockhash's last height, 151) */
  finalHeight?: number;
  /** the block height of W's latest transaction, before the test's own sends (500 when not given: 1,000 is past it + 151) */
  wLastHeight?: number;
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
  /** a Mayhem coin: the bonding curve's is_mayhem_mode byte (81) or the PumpSwap Pool's (243) set in the recorded reads */
  mayhem?: boolean;
  /** the bonding curve's real SOL (bytes 32..40) in the recorded reads: what the curve can pay a sale */
  curveRealSol?: bigint;
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
  throttle?: { on: "read" | "simulate"; n: number; plain?: true };
  /** The first sell's deposit meets a page another deposit filled first: it fails WrongAccount on chain (review L2),
   *  W paying its fee, nothing else moving */
  wrongAccountOnce?: boolean;
  /** getTransaction never finds a teardown frame (one provider slow to index; review M2) */
  unreadTeardown?: boolean;
  /** The first teardown frame fails on chain on both RPCs (review M-A): "dust", a third party sends one token unit to
   *  W's token account just before its close lands; "once", the frame fails with nothing moved */
  teardownFails?: "dust" | "once";
  /** the RPCs' metas give no post token balances */
  noPostBalances?: true;
  /** RPC B's meta reads every post token balance at 9 */
  postDiffers?: true;
  /** a stranger's units of the mint land on W's token account right after the sell fills */
  dustAfterFill?: bigint;
  /** a hostile RPC, holding the signed sell, front-runs a stranger's units of the mint to W's token account just before
   *  the sell lands (review of bf467ae7, F1): the full sell sells exactly what both RPCs read, leaving these on W */
  dustBeforeSell?: bigint;
  /** getTransaction at finalized finds no sell yet (it landed, confirmed, not final; review of bf467ae7, F5) */
  unfinalSell?: boolean;
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
  /** W's buy record (pool-buy.ts BuyMints): the venue's mint when not given; null, none (a buy from before it was
   *  written, or a restored device) */
  buy?: { mint: string; program: string; rebuilt?: true } | null;
  /** More of the user's buy wallets holding the venue's token (card pool-sell-share-across-wallets: each buy lands in a
   *  fresh W): each at (l, j), its token account holding `held`, its lamports (ENOUGH when not given) */
  others?: { l: bigint; j: number; held: bigint; lamports?: number }[];
};

/** One chain: the planted accounts, the program's deposit applied to a signed sell. */
export function chain(plant: Plant = {}) {
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
  // the pinned relayer's account, a funded system account as on mainnet: the sweep pays its rest under the grid there
  accounts.set(FEE_PAYER, { owner: "11111111111111111111111111111111", lamports: 5_000_000_000, data: new Uint8Array(0) });
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
  for (const o of plant.others ?? []) {
    const x = freshWallet(SEED64, "sol", o.l, o.j);
    x.secretKey.fill(0);
    accounts.set(solanaAta(x.address, mint, mintRead.owner), { owner: mintRead.owner, lamports: plant.ataLamports ?? 1, data: tokenAccount(o.held, 1, mint, x.address) });
    if (o.lamports !== 0) accounts.set(x.address, { owner: "11111111111111111111111111111111", lamports: o.lamports ?? ENOUGH, data: new Uint8Array(0) });
  }
  // the token account a sale takes its tokens from: its signer's (W's, or another buy wallet's)
  const ataOf = (signer: string): string => solanaAta(signer, mint, mintRead.owner);
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
  const txs = new Map<string, { tx: Uint8Array; err: unknown; post?: unknown[] }>();
  const log: string[] = [];
  const sentTx = new Map<string, Uint8Array>();
  const calls: { p: 0 | 1; method: string; params: readonly unknown[] }[] = [];
  // W's history (getSignaturesForAddress, newest first) and each block's height (getBlock): before the test one
  // transaction at wLastHeight; one the test lands on W is its latest, in a block at the finalized height
  const W_PAST = base58.encode(new Uint8Array(64).fill(7));
  const wHistory = [{ signature: W_PAST, slot: VF[v].slot - 300 }];
  const heightAt = new Map<number, number>([[wHistory[0]!.slot, plant.wLastHeight ?? 500]]);

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
  // whether a venue sell has landed (card every-lamport-can-move: a full sell lands with no deposit)
  let sellLanded = false;
  let throttled = 0;
  let claimErred = 0;
  let wrongDone = false;
  let insertDone = false;
  let tearFailed = false;
  let dustDone = false;
  let frontDone = false;
  const burned: { at: string; amount: bigint }[] = [];
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
        // as the ATA program runs it (review 6 of 13898c19, F1): on a System account with no data (lamports anyone sent
        // there) it moves only the shortfall to the rent, allocates and assigns, then InitializeAccount3 (a native
        // account's amount = its lamports less its rent); a made account is left as it is
        const prior = on.get(at);
        if (prior && (prior.owner !== "11111111111111111111111111111111" || prior.data.length !== 0)) continue;
        const r = Number(rentMin(165));
        const have = prior?.lamports ?? 0;
        const short = Math.max(0, r - have);
        if (on.get(payer)!.lamports < short) throw new Error("InsufficientFunds");
        on.set(payer, { ...on.get(payer)!, lamports: on.get(payer)!.lamports - short });
        on.set(at, { owner: keys[5]!, lamports: have + short, data: mint === SOLANA_SOL_MINT ? nativeAccount(owner, BigInt(have + short - r)) : new Uint8Array(165) });
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
      if ((program === SOLANA_TOKEN_PROGRAM || program === TOKEN_2022) && ix.data.length === 9 && ix.data[0] === 8) {
        // Burn(amount): the owner signs, the account's mint is the mint named, the amount at most what it holds
        const [at, mint, owner] = keys as [string, string, string];
        const t = on.get(at);
        const amount = new DataView(ix.data.buffer, ix.data.byteOffset + 1, 8).getBigUint64(0, true);
        if (!t || t.owner !== program) throw new Error("AccountNotFound");
        if (base58.encode(t.data.subarray(0, 32)) !== mint) throw new Error("MintMismatch");
        if (owner !== signer || base58.encode(t.data.subarray(32, 64)) !== owner) throw new Error("OwnerMismatch");
        const d = Uint8Array.from(t.data);
        const dv = new DataView(d.buffer, 64, 8);
        if (dv.getBigUint64(0, true) < amount) throw new Error("InsufficientFunds");
        dv.setBigUint64(0, dv.getBigUint64(0, true) - amount, true);
        on.set(at, { ...t, data: d });
        if (on === accounts) burned.push({ at, amount });
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
    // the pool's instruction where there is one (a sweep's deposit, before its transfer of the rest under the grid to the
    // pool's account, review P3-1 of T1+T2), else the last
    const ix = m.instructions.find((x) => m.staticKeys[x.programIndex] === PROGRAM) ?? m.instructions.at(-1)!;
    const keys = ix.accounts.map((i) => m.staticKeys[i]!);
    // a sell with no deposit back (card sol-sell-deposit-back-floor): the venue's sell alone, its whole min out to W,
    // which pays the fee and what the sell makes; W ends at 0 or rent-exempt
    const venueSell = m.instructions.find((x) => x.data.length === 24 && (m.staticKeys[x.programIndex] === SOLANA_PUMP_PROGRAM || m.staticKeys[x.programIndex] === SOLANA_PUMP_AMM_PROGRAM));
    if (venueSell && !m.instructions.some((x) => m.staticKeys[x.programIndex] === PROGRAM)) {
      const sold = new DataView(venueSell.data.buffer, venueSell.data.byteOffset + 8, 8).getBigUint64(0, true);
      let got = new DataView(venueSell.data.buffer, venueSell.data.byteOffset + 16, 8).getBigUint64(0, true);
      const made: [string, string, number][] = m.staticKeys[venueSell.programIndex] === SOLANA_PUMP_AMM_PROGRAM && plant.cashback ? ([[ammVol, SOLANA_PUMP_AMM_PROGRAM, 137], [ammAta, SOLANA_TOKEN_PROGRAM, 165]] as [string, string, number][]).filter(([x, owner]) => accounts.get(x)?.owner !== owner) : [];
      for (const [, , size] of made) got -= solanaRentMin(rent, size);
      const ends = BigInt(accounts.get(signer)?.lamports ?? 0) + got - feeOf(m);
      if (ends < 0n) throw new Error("InsufficientFunds");
      if (ends > 0n && ends < solanaRentMin(rent, 0)) throw new Error("InsufficientFundsForRent");
      if (dry) return;
      const t = accounts.get(ataOf(signer))!;
      const d = t.data.slice();
      const dv = new DataView(d.buffer, 64, 8);
      dv.setBigUint64(0, dv.getBigUint64(0, true) - sold, true);
      accounts.set(ataOf(signer), { ...t, data: d });
      for (const [x, owner, size] of made) accounts.set(x, { owner, lamports: Number(solanaRentMin(rent, size)), data: new Uint8Array(size) });
      sellLanded = true;
      accounts.set(signer, { ...(accounts.get(signer) ?? { owner: "11111111111111111111111111111111", data: new Uint8Array(0), lamports: 0 }), lamports: Number(ends) });
      return;
    }
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
    // System transfers from W in the same transaction (the sweep's rest under the grid), to whatever account each names,
    // as the runtime moves them: each receiver credited and left at 0 or rent-exempt
    const sends = m.instructions.filter((x) => m.staticKeys[x.programIndex] === "11111111111111111111111111111111" && x.data[0] === 2).map((x) => ({ to: m.staticKeys[x.accounts[1]!]!, v: new DataView(x.data.buffer, x.data.byteOffset + 4, 8).getBigUint64(0, true) }));
    const paid = sends.reduce((t, x) => t + x.v, 0n);
    for (const x of sends) {
      const after = BigInt(accounts.get(x.to)?.lamports ?? 0) + x.v;
      if (after > 0n && after < solanaRentMin(rent, accounts.get(x.to)?.data.length ?? 0)) throw new Error("InsufficientFundsForRent");
    }
    const cost = feeOf(m) + rentsOf(pre) + paid;
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
    for (const x of sends) accounts.set(x.to, { ...(accounts.get(x.to) ?? { owner: "11111111111111111111111111111111", data: new Uint8Array(0), lamports: 0 }), lamports: (accounts.get(x.to)?.lamports ?? 0) + Number(x.v) });
    deposit(pre, value);
    // the venue's sell (pump's and PumpSwap's sell(amount, min_out), 24 data bytes): W's tokens out, its min out in
    const sell = m.instructions.find((x) => x.data.length === 24);
    let got = 0n;
    if (sell) {
      sellLanded = true;
      const sold = new DataView(sell.data.buffer, sell.data.byteOffset + 8, 8).getBigUint64(0, true);
      got = new DataView(sell.data.buffer, sell.data.byteOffset + 16, 8).getBigUint64(0, true);
      const t = accounts.get(ataOf(signer))!;
      const d = t.data.slice();
      const dv = new DataView(d.buffer, 64, 8);
      dv.setBigUint64(0, dv.getBigUint64(0, true) - sold, true);
      accounts.set(ataOf(signer), { ...t, data: d });
      // a PumpSwap sell of a cashback coin makes W's cashback accounts it lacks, at W's cost (pool-sell.ts's `made`)
      if (m.staticKeys[sell.programIndex] === SOLANA_PUMP_AMM_PROGRAM && plant.cashback) {
        for (const [x, owner, size] of [[ammVol, SOLANA_PUMP_AMM_PROGRAM, 137], [ammAta, SOLANA_TOKEN_PROGRAM, 165]] as const) {
          if (accounts.get(x)?.owner === owner) continue;
          got -= solanaRentMin(rent, size);
          accounts.set(x, { owner, lamports: Number(solanaRentMin(rent, size)), data: new Uint8Array(size) });
        }
      }
    }
    // a sweep: a deposit with no venue sell (card every-lamport-can-move: its compute budget may come first)
    deposits.push({ pre, value, sweep: sellIx === undefined });
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
      if (p === 1 && plant.owedOn1BeforeSell && !sellLanded && (address === ammVol || address === solanaVolumeAccumulator(W.address, SOLANA_PUMP_PROGRAM))) {
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
      if (p === 1 && plant.throttle && sellLanded && throttled < plant.throttle.n) {
        const list = method === "getMultipleAccounts" ? (params[0] as string[]) : method === "getAccountInfo" ? [params[0] as string] : [];
        const hit = plant.throttle.on === "read" ? list.includes(ata) : method === "simulateTransaction" && (params[1] as { accounts?: unknown }).accounts !== undefined;
        if (throttled > 0 || hit) {
          throttled++;
          throw plant.throttle.plain ? new Error("an answer that does not parse") : new SolanaRpcTransportError("http_429", "HTTP 429", 4, "solana-devnet.api.onfinality.io");
        }
      }
      switch (method) {
        case "getMultipleAccounts": {
          const recorded = fx[v].reads[p][JSON.stringify(params[0])];
          if (recorded && plant.mayhem) {
            const r = structuredClone(recorded) as { value: ({ owner: string; data: [string, string] } | null)[] };
            for (const a of r.value) {
              const d = a ? base64.decode(a.data[0]) : null;
              const at = !a || !d ? -1 : a.owner === SOLANA_PUMP_PROGRAM && d.length >= 83 && d.length < 300 ? 81 : a.owner === SOLANA_PUMP_AMM_PROGRAM && d.length >= 245 && d.length < 600 ? 243 : -1;
              if (at < 0) continue;
              d![at] = 1;
              a!.data[0] = base64.encode(d!);
            }
            return r;
          }
          if (recorded && plant.curveRealSol !== undefined) {
            // the bonding curve (owned by pump, under 300 bytes): its real SOL set
            const r = structuredClone(recorded) as { value: ({ owner: string; data: [string, string] } | null)[] };
            for (const a of r.value) {
              const d = a?.owner === SOLANA_PUMP_PROGRAM ? base64.decode(a.data[0]) : null;
              if (!d || d.length < 83 || d.length >= 300) continue;
              new DataView(d.buffer, d.byteOffset).setBigUint64(32, plant.curveRealSol, true);
              a!.data[0] = base64.encode(d);
            }
            return r;
          }
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
          // confirmed: RPC 1's height and its slot beside the blockhash check (pool-buy.ts blockhashValid), at the
          // check's own slot, so the last height is max(100, 0 + 151) = 151
          if ((params[0] as { commitment: string }).commitment === "confirmed") return { blockHeight: 0, absoluteSlot: VF[v].slot, epoch: 1, slotIndex: 0, slotsInEpoch: 432_000 };
          // finalized: each RPC's height and, of the same block, its slot, which pins its mark read (minContextSlot)
          assert.equal((params[0] as { commitment: string }).commitment, "finalized");
          return { blockHeight: plant.finalHeight ?? 1_000, absoluteSlot: VF[v].slot + 10 + p, epoch: 1, slotIndex: 0, slotsInEpoch: 432_000 };
        case "getFeeForMessage":
          return { ...ctx, value: Number(feeOf(solanaDecodeMessage(base64.decode(params[0] as string)))) };
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
              return { ...ctx, value: { err: null, logs: [], accounts: want.map(read), ...(plant.units === undefined ? {} : { unitsConsumed: plant.units }) } };
            }
            return { ...ctx, value: { err: null, logs: [], ...(plant.units === undefined ? {} : { unitsConsumed: plant.units }) } };
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
          // a teardown frame: no deposit and no venue sell (card every-lamport-can-move: a full sell carries no deposit)
          if (plant.teardownFails && !tearFailed && !txs.has(sig) && !sm.instructions.some((x) => sm.staticKeys[x.programIndex] === PROGRAM || x.data.length === 24)) {
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
          if (!txs.has(sig) && plant.lands !== false && sm.staticKeys.includes(W.address)) {
            wHistory.unshift({ signature: sig, slot: VF[v].slot + 1 });
            heightAt.set(VF[v].slot + 1, plant.finalHeight ?? 1_000);
          }
          if (!txs.has(sig) && plant.lands !== false) {
            if (plant.dustBeforeSell !== undefined && !frontDone && sm.instructions.some((x) => x.data.length === 24 && sm.staticKeys[x.programIndex] !== PROGRAM)) {
              frontDone = true;
              const t = accounts.get(ata)!;
              const d = t.data.slice();
              const dv = new DataView(d.buffer, 64, 8);
              dv.setBigUint64(0, dv.getBigUint64(0, true) + plant.dustBeforeSell, true);
              accounts.set(ata, { ...t, data: d });
            }
            try {
              apply(tx, false);
              // the meta's post token balances, as an RPC gives them: each token account the transaction names, after it
              const post = sm.staticKeys.flatMap((k, i) => {
                const t = accounts.get(k);
                if (!t || t.data.length < 72 || (t.owner !== SOLANA_TOKEN_PROGRAM && t.owner !== TOKEN_2022)) return [];
                return [{ accountIndex: i, mint: base58.encode(t.data.subarray(0, 32)), owner: base58.encode(t.data.subarray(32, 64)), uiTokenAmount: { amount: new DataView(t.data.buffer, t.data.byteOffset + 64, 8).getBigUint64(0, true).toString(), decimals: 6 } }];
              });
              txs.set(sig, { tx, err: null, post });
              // after the sell landed, with its deposit back or without one (kept on W): the venue's sell is in it
              if (plant.dustAfterFill !== undefined && !dustDone && sm.instructions.some((x) => x.data.length === 24 && sm.staticKeys[x.programIndex] !== PROGRAM)) {
                dustDone = true;
                const t = accounts.get(ata)!;
                accounts.set(ata, { ...t, data: tokenAccount(plant.dustAfterFill, 1, mint) });
              }
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
        case "getSignatureStatuses": {
          // over its whole history, at a context slot past each RPC's finalized one (getEpochInfo's), unless it lags
          assert.deepEqual(params[1], { searchTransactionHistory: true });
          const t = txs.get((params[0] as string[])[0]!);
          const slot = p === 1 && plant.statusLagOn1 ? 1 : VF[v].slot + 20;
          return { context: { slot }, value: [t && !(p === 1 && plant.statusLagOn1) ? { slot: VF[v].slot, confirmations: null, err: t.err, confirmationStatus: "finalized" } : null] };
        }
        case "getTransaction": {
          const sent = sentTx.get(params[0] as string);
          if (p === 1 && plant.txNoneOn1) return null;
          if (plant.txNone) return null;
          if (plant.metaJunk && sent) return { slot: VF[v].slot, transaction: [base64.encode(sent), "base64"], meta: "x" };
          const t = txs.get(params[0] as string);
          if (t && plant.unfinalSell && (params[1] as { commitment?: string } | undefined)?.commitment === "finalized" && solanaDecodeMessage(t.tx.subarray(65)).instructions.some((x) => x.data.length === 24)) return null;
          if (t && plant.unreadTeardown) {
            const tm = solanaDecodeMessage(t.tx.subarray(65));
            // a teardown frame: no deposit and no venue sell (card every-lamport-can-move: a full sell carries no deposit)
            if (!tm.instructions.some((x) => tm.staticKeys[x.programIndex] === PROGRAM || x.data.length === 24)) return null;
          }
          return t ? { slot: VF[v].slot, transaction: [base64.encode(t.tx), "base64"], meta: { err: t.err, ...(t.post && !plant.noPostBalances ? { postTokenBalances: p === 1 && plant.postDiffers ? t.post.map((e) => ({ ...(e as object), uiTokenAmount: { amount: "9", decimals: 6 } })) : t.post } : {}) } } : null;
        }
        case "getSignaturesForAddress": {
          // W's own history only, newest first, at most the limit asked: its latest one, or each one after `until`
          assert.equal(params[0], W.address);
          const o = params[1] as { until?: string; limit: number; commitment: string };
          if (o.until === undefined) assert.deepEqual(o, { limit: 1, commitment: "confirmed" });
          else assert.deepEqual(Object.keys(o).sort(), ["commitment", "limit", "until"]);
          assert.equal(o.commitment, "confirmed");
          const at = o.until === undefined ? -1 : wHistory.findIndex((e) => e.signature === o.until);
          return (at < 0 ? wHistory : wHistory.slice(0, at)).slice(0, o.limit).map((e) => ({ signature: e.signature, slot: e.slot, err: null, memo: null, blockTime: null, confirmationStatus: "finalized" }));
        }
        case "getBlock": {
          // exactly the one config the helper forwards (apps/helper/src/rpc/rpc.ts BLOCK_HEADER, its test pins the same)
          assert.deepEqual({ ...(params[1] as object) }, { commitment: "finalized", encoding: "json", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 });
          assert.equal(params.length, 2);
          const h = heightAt.get(params[0] as number);
          return h === undefined ? null : { blockHeight: h, blockhash: BLOCKHASH, parentSlot: (params[0] as number) - 1, blockTime: null };
        }
        case "getTokenAccountsByOwner": {
          // every token account of the program asked whose owner field (bytes 32..64) is the owner asked
          const { programId } = params[1] as { programId: string };
          const value = [...accounts.entries()].filter(([, x]) => x.owner === programId && x.data.length >= 64 && base58.encode(x.data.subarray(32, 64)) === params[0]).map(([pubkey, x]) => ({ pubkey, account: { owner: x.owner, lamports: x.lamports, data: [base64.encode(x.data), "base64"] } }));
          return { ...ctx, value };
        }
        default:
          throw new Error(`no fixture for ${method}`);
      }
    }) as SolanaRpc;
  };
  return { accounts, deposit, deposits, rpcs: [rpc(0), rpc(1)] as const, txs, log, calls, burned };
}

export const rentMin = (size: number): bigint => solanaRentMin(rent, size);
