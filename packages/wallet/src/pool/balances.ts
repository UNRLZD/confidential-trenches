// The private balance per chain's pool, read from the device's own notes, and how much of it is ready to buy (card
// balances-per-chain; the signing page's state.pools, @blindfill/kit SignpageState). Pure: no store, no network, no
// clock; the caller reads the notes and hands them in.
//
// - balance: the leaf values of the pool's notes (scope === pool.scope) in UNSPENT, HELD or RESERVED: what the pool
//   holds for the user until the chain spends it (card pool-buy-record-never-stays-sent: a RESERVED note counted
//   nothing, so a buy in flight read the money gone, and a buy not landed read 0 until its note was freed). A RESERVED
//   note whose release the device read landed (`landed`: its attempt and the value it withdrew, both RPCs reading this
//   very transaction succeeded) counts only its change, value less that, until the settle writes the change UNSPENT and
//   the note SPENT, so a bought token is never counted twice. Not counted: PLANNED and INCOMING (no value until the leaf
//   lands; an incoming deposit shows as its op), SPENT and TAKEN. `ready` still counts HELD proofs only.
// - ready: the chunks of the proof queue's ready proofs for the pool whose note is still in the store, HELD by the same
//   attempt (a proof whose note moved is not ready), each note counted once. Absent from every entry when no ready list
//   is given (no queue runs), never "0" in its place; with `open` (the pool ids whose queue runs), absent from each chain
//   none of whose pools is in it, so a chain whose queue is not open never reads ready "0".
// - tap_max: the most one tap can spend on the chain. A tap spends the ready proofs bound to one W (card
//   buy-spends-several-pieces: a pool with piecesMax above 1 binds them all to its owner's W, ./queue.ts; any other
//   pool gives each note its own W, so one proof), and only a set that holds the owner's note, the note whose own W it
//   is (its label and jOf(ref) are the W's l and j), so every W a buy pays is a spent note's own. So tap_max is the
//   largest spendOf(the set's pieces: each chunk, fee cap and tip cap) over the sets of proofs `ready` counts, across
//   the chain's pools, never their sum and never below 0. A set with no owner's note (proofs left bound to a W whose
//   note a buy took, until the queue makes them again) counts nothing. spendOf is the pool's, from its caller: solanaTapSpendOf (the kit's solanaPoolBuyMaxSpend on the worst
//   venue, or on the coin's own for pool.buy.dry, at the proof's own tip cap, the most tip its release lets the tap
//   pay, and the rent the caller read on two RPCs) or evmTapSpendOf (the chunk itself: an EVM tap asks for a whole
//   chunk, the signing page's checkEvmBuy refusing any other amount, and the relay fee comes out on chain). Present only
//   with ready, and only when every pool on the chain gives a spendOf; "0" when no proof is counted.
// - One entry per chain, in the order the chain first appears in the pool table, carrying the chain's pool asset; pools
//   on one chain sum into it. Two assets on one chain are refused: the kit's state keeps one entry per chain.
// - Amounts: exact decimals of base units / the asset's 1.0, 10^POOL_ASSET_DECIMALS[asset] from the kit's one table
//   (12.5 SOL is "12.5"), never a ladder's `one` (a chunk step: SOL_LADDER.one is 0.001 SOL); bigint only, no trailing
//   zeros after the point, "0" for zero.
// `chain` is the app's chain (the kit's: solana, base, robinhood, near), not the derivation tag of ../derive, which
// names Base and Robinhood alike.
import {
  CHAINS,
  POOL_ASSETS,
  POOL_ASSET_DECIMALS,
  SOLANA_POOL_WORST_BUY_VENUE,
  solanaPoolBuyMaxSpend,
  type Chain,
  type PoolAsset,
  type SolanaPoolBuyVenue,
  type SolanaRent,
} from "@blindfill/kit";
import type { NoteRecord } from "../notes/store.ts";
import type { ReadyProof } from "./pool.ts";
import { jOf } from "./queue.ts";

/** One ready proof as a piece of a tap: its chunk, its fee cap and its tip cap (its binding's request.tipCap; undefined
 * when the request names none). */
export type TapPiece = { chunk: bigint; feeCap: bigint; tipCap: bigint | undefined };
/** What the ready proofs bound to one W can spend at one tap, in base units. */
export type TapSpendOf = (pieces: readonly TapPiece[]) => bigint;
/** A pool on the device's pool table: its id (ReadyProof.poolId), the app chain, its scope and its asset, and what one
 * of its ready proofs can spend (none: its chain's entry has no tap_max). Built with solanaBalancePool or
 * evmBalancePool, so the asset follows the pool's kind. */
export type BalancePool = { id: string; chain: Chain; scope: bigint; asset: PoolAsset; spendOf?: TapSpendOf };
/** What poolBalances reads of a ready proof. */
export type BalanceProof = Pick<ReadyProof, "noteId" | "attempt" | "poolId" | "chunk"> & { wallet: Pick<ReadyProof["wallet"], "l" | "j" | "address">; binding: Pick<ReadyProof["binding"], "feeCap"> & { request?: unknown } };
export type PoolBalance = { chain: Chain; asset: PoolAsset; balance: string; ready?: string; tap_max?: string; making?: string };
/** A RESERVED note's release the device read landed, by note id: the attempt that sent it and the value it withdrew. */
export type LandedRelease = { attempt: string; withdrawn: bigint };

/** The Solana pool's table entry: it holds SOL (the wrapped-SOL mint its scope hashes, ./solana.ts SOL_NATIVE_MINT). */
export function solanaBalancePool(id: string, scope: bigint, spendOf?: TapSpendOf): BalancePool {
  return Object.freeze({ id, chain: "solana", scope, asset: "SOL", ...(spendOf === undefined ? {} : { spendOf }) });
}
/** An EVM pool's table entry: PrivacyPoolSimple holds native ETH (./evm.ts EVM_NATIVE_ASSET), on Base or Robinhood. */
export function evmBalancePool(id: string, chain: "base" | "robinhood", scope: bigint, spendOf?: TapSpendOf): BalancePool {
  if (chain !== "base" && chain !== "robinhood") throw new Error(`pool ${id}: an EVM pool's chain is base or robinhood, not ${String(chain)}`);
  return Object.freeze({ id, chain, scope, asset: "ETH", ...(spendOf === undefined ? {} : { spendOf }) });
}

// What a Solana pool buy takes from the ladder's least rung, 0.01 SOL (SOL_LADDER.min), on mainnet at the worst venue
// (card sol-small-note-buys). Reads of 5 Nov 2026 19:10:24Z on api.mainnet-beta.solana.com and
// solana-rpc.publicnode.com, the two answering alike: the Rent sysvar 5,080 lamports per byte-year, exemption threshold
// 1.0 (slots 465,818,293 and 465,818,299), and getMinimumBalanceForRentExemption 0 B 650,240, 13 B 716,280, 16 B
// 731,520, 72 B 1,016,000, 137 B 1,346,200, 165 B 1,488,440, 195 B 1,640,840 (rent(n) = (128 + n) x 5,080). The
// helper's GET /v1/pool/fee for the devnet pool 2S5wpE7U… answered fee 1,300,000 at 19:14:28Z (devnet rent is the
// same 650,240 for 0 B), the kit's solanaPoolFee at this rent. In lamports:
//   relay fee        1,300,000  gone: the fee payer's release cost 1,092,040 (the spent mark rent(13) 716,280 and the
//                               change note's page entry 72 x 5,080 = 365,760, both kept: the program closes no account; two
//                               signatures 10,000), the page reserve 715 and up to 207,245 of priority, the rest the
//                               relayer's. The priority is inside it: 207,245 at 300,000 CU is 690,816 micro-lamports a
//                               CU; getRecentPrioritizationFees for pump's program read p50 0, p90 199,996, max
//                               3,087,670 (150 slots). Nothing of it comes from the chunk beyond the fee.
//   tip cap          1,000,000  at most; the tap pays its tip (at least Jito's 1,000) and the rest stays in W. Jito's
//                               tip floor at 19:09:35Z: p25 1,000, p50 1,440, p75 10,000, p95 4,250,000, p99 11,062,988.
//   token account    1,640,840  rent(195), Token-2022's largest; 1,488,440 for a Token mint. Back after a full
//                               sell: the teardown closes it to W once the sell has filled (card sol-buy-rent-back,
//                               signpage src/pool-sell.ts rentBack; the sell itself closes nothing, 06c A9), and
//                               W's sweep puts it into the pool when the sweep runs (below). A partial sell keeps it.
//   volume account   1,346,200  rent(137), pump's volume account for W, made by the buy. Back after a full sell,
//                               closed by the teardown, unless pump keeps it open: it owes incentive tokens, volume
//                               or cashback (the kit's solanaTeardownPlan reads it on two RPCs).
//   sell reserve     4,328,080  kept in W so a curve coin that graduates can still be sold on PumpSwap
//                               (solanaPoolBuySellNeed): the sell's fee 5,000 (gone), W's wrapped-SOL account rent(165)
//                               1,488,440 (back: the sell closes it), and on a cashback coin W's PumpSwap volume account
//                               rent(137) 1,346,200 and its wrapped-SOL account rent(165) 1,488,440, which the sell
//                               makes and keeps. A sell on the curve uses only its fee: the rest stays in W as SOL.
//                               After a full sell, W's sweep deposits every lamport W holds (the reserve left, the
//                               rents the teardown closed) as W's next return note, W at 0; the cashback volume
//                               account closes as the volume account above, while its wrapped-SOL account (that
//                               account's, not W's) stays. The sweep costs its fee, the mark's rent and two page
//                               entries, 5,000 + 736,600 + 731,520 (as the program prices them: less what a page or
//                               the mark already holds), and each teardown frame its fee, 5,000. No sweep while the
//                               teardown keeps an account (W keeps the fee to close it later), nor when the note would
//                               be under the smallest a withdraw spends (signpage rules/pool.ts solanaSweepFloor:
//                               fee 1,300,000 + W's 5,000 + part 1,295,000 = 2,600,000): then W keeps its SOL.
//   spend (tap_max)    384,880  what the buy can spend. Total 10,000,000.
// So the least rung buys at today's mainnet rent: tap_max 0.00038488 SOL at the worst venue; on a Token mint's coin
// with no cashback the same rung could spend 3,371,920, on the curve or on PumpSwap. At the older rate of 6,960 a byte (3,480 x 2)
// the same rung's tap_max is 0 (test/pools-testnet.test.ts in packages/signpage pins both). Only the relay fee and
// the tip it pays are certain costs; the rents and the reserve are held in W, in accounts or as SOL, and after a full
// sell come back to W, and into the user's pool balance when the sweep runs, less the teardown's and its own costs above.
// On this rung after a full curve sell W holds about 3.6M after its teardown, a note of about 2.15M: under the floor,
// so those lamports stay on W (devnet run of 5 Nov 21:12Z, W HFGAyAxq…, before the floor: its sweep made 2,154,336).
/** A Solana tap's spend from the ready proofs bound to one W: the kit's solanaPoolBuyMaxSpend over them as pieces (card
 * buy-spends-several-pieces: each pays its chunk less its relay fee, the tip and W's costs once) on `venue`, each relay
 * fee at the proof's fee cap, the tip at the largest of the proofs' tip caps (./solana.ts SOL_TIP_CAP, 0.001 SOL: the most the release lets the tap tip, so a tap at
 * any tip it may pay fills) and `rent`, the Rent sysvar the caller read on two RPCs (./solana.ts solanaCostReads, the
 * kit's readSolanaRent). `venue`: the coin's own (its kind, token account size and cashback, as the kit's
 * readSolanaPoolBuyVenue reads them on two providers: card max-is-priced-for-the-coin, the 0.01 SOL rung spends
 * 3,371,920 on a Token mint's coin with no cashback, on the curve or on PumpSwap), or, before the tap knows its coin,
 * SOLANA_POOL_WORST_BUY_VENUE (384,880 on that rung), which any coin's venue funds. A proof whose request names no tip
 * cap is refused. */
export function solanaTapSpendOf(rent: SolanaRent, venue: Pick<SolanaPoolBuyVenue, "kind" | "tokenAccountSize" | "cashback"> = SOLANA_POOL_WORST_BUY_VENUE): TapSpendOf {
  return (pieces) => {
    let tip = 0n;
    for (const { tipCap } of pieces) {
      if (typeof tipCap !== "bigint" || tipCap < 0n) throw new Error("a Solana proof's request names no tip cap");
      if (tipCap > tip) tip = tipCap;
    }
    return solanaPoolBuyMaxSpend(pieces.map((p) => ({ withdrawnValue: p.chunk, relayFee: p.feeCap })), venue, tip, rent);
  };
}
/** An EVM proof's ask at the tap: the whole chunk. The signing page's checkEvmBuy (signpage src/rules/pool.ts) refuses
 * an EVM pool.buy whose amount is not the proof's value; the relay fee comes out of it on chain (contracts/pool-evm
 * PrivacyPoolSimple.sol:64), so the trade box asks for chunks on EVM. */
export const evmTapSpendOf: TapSpendOf = (pieces) => pieces.reduce((m, p) => (p.chunk > m ? p.chunk : m), 0n);

/** The asset's decimals from the kit's table; an asset not in it is refused. */
function decimalsOf(p: BalancePool): number {
  if (Object.hasOwn(p, "one")) throw new Error(`pool ${p.id}: a pool names its asset, never a one`);
  if (!(POOL_ASSETS as readonly unknown[]).includes(p.asset)) throw new Error(`pool ${p.id}: unknown asset ${String(p.asset)}`);
  return POOL_ASSET_DECIMALS[p.asset];
}

/** units / 10^d as an exact decimal string: no trailing zeros after the point, "0" for zero. */
function decimal(units: bigint, d: number): string {
  const s = units.toString().padStart(d + 1, "0");
  const int = s.slice(0, s.length - d);
  const frac = s.slice(s.length - d).replace(/0+$/, "");
  return frac === "" ? int : `${int}.${frac}`;
}

/** Each chain's pool balance from the device's notes (see PoolBalance and the kit's SignpageState.pools). `making`: the
 *  notes whose first proof the queue is making now (queue.ts readyWith); each HELD one with no ready proof counts its
 *  value in the chain's `making`, given beside `ready` (card buy-spends-several-pieces). */
export function poolBalances(notes: readonly NoteRecord[], pools: readonly BalancePool[], ready?: readonly BalanceProof[], open?: ReadonlySet<string>, landed?: ReadonlyMap<string, LandedRelease>, making?: ReadonlySet<string>): PoolBalance[] {
  const ids = new Set<string>();
  const scopes = new Set<bigint>();
  // per chain, in table order: its asset's decimals, then the sums in base units
  const chains = new Map<Chain, { asset: PoolAsset; d: number; balance: bigint; ready: bigint; tapMax: bigint; making: bigint; spends: boolean; open: boolean }>();
  for (const p of pools) {
    if (typeof p.id !== "string" || p.id.length === 0) throw new Error("pool: no id");
    if (!(CHAINS as readonly unknown[]).includes(p.chain)) throw new Error(`pool ${p.id}: unknown chain ${String(p.chain)}`);
    if (typeof p.scope !== "bigint") throw new Error(`pool ${p.id}: scope is not a bigint`);
    const d = decimalsOf(p);
    // one id or one scope twice would count the same notes or proofs twice
    if (ids.has(p.id) || scopes.has(p.scope)) throw new Error(`pool ${p.id}: its id or scope is in the pool table twice`);
    ids.add(p.id);
    scopes.add(p.scope);
    const c = chains.get(p.chain);
    if (p.spendOf !== undefined && typeof p.spendOf !== "function") throw new Error(`pool ${p.id}: spendOf is not a function`);
    const runs = open === undefined || open.has(p.id);
    if (c === undefined) chains.set(p.chain, { asset: p.asset, d, balance: 0n, ready: 0n, tapMax: 0n, making: 0n, spends: p.spendOf !== undefined, open: runs });
    else if (c.asset !== p.asset) throw new Error(`pool ${p.id}: chain ${p.chain} holds asset ${c.asset}, not ${p.asset}: one asset per chain`);
    else {
      if (p.spendOf === undefined) c.spends = false;
      if (runs) c.open = true;
    }
  }
  const byId = new Map(notes.map((n) => [n.id, n]));
  const counted = new Set<string>(); // a note's proof counts once
  const sets = new Map<string, { owned: boolean; pieces: TapPiece[] }>(); // a pool's counted proofs by their W
  for (const p of pools) {
    const c = chains.get(p.chain)!;
    for (const n of notes) {
      if (n.scope !== p.scope || (n.state !== "UNSPENT" && n.state !== "HELD" && n.state !== "RESERVED")) continue;
      const v = n.leaf?.value;
      if (typeof v !== "bigint" || v < 0n) throw new Error(`note ${n.id}: ${n.state} with no leaf value`);
      const out = n.state === "RESERVED" ? landed?.get(n.id) : undefined;
      const w = out !== undefined && out.attempt === n.attempt ? out.withdrawn : 0n;
      if (typeof w !== "bigint" || w < 0n || w > v) throw new Error(`note ${n.id}: its landed release withdrew more than it holds`);
      c.balance += v - w;
      // a note the queue is making its first proof for (HELD by that proof, none ready): its value is being made ready
      if (n.state === "HELD" && making?.has(n.id) === true && !(ready ?? []).some((r) => r.noteId === n.id)) c.making += v;
    }
    for (const r of ready ?? []) {
      if (r.poolId !== p.id || counted.has(r.noteId)) continue;
      const n = byId.get(r.noteId);
      if (n === undefined || n.scope !== p.scope || n.state !== "HELD" || n.attempt !== r.attempt) continue;
      if (typeof r.chunk !== "bigint" || r.chunk < 0n) throw new Error(`ready proof for note ${r.noteId}: chunk is not a bigint`);
      counted.add(r.noteId);
      c.ready += r.chunk;
      if (p.spendOf === undefined) continue;
      const feeCap = r.binding?.feeCap;
      if (typeof feeCap !== "bigint" || feeCap < 0n) throw new Error(`ready proof for note ${r.noteId}: its fee cap is not a bigint at least 0`);
      const tipCap = (r.binding.request as { tipCap?: unknown } | undefined)?.tipCap;
      if (tipCap !== undefined && (typeof tipCap !== "bigint" || tipCap < 0n)) throw new Error(`ready proof for note ${r.noteId}: its tip cap is not a bigint at least 0`);
      const address = r.wallet?.address;
      if (typeof address !== "string") throw new Error(`ready proof for note ${r.noteId}: no wallet`);
      const set = sets.get(address) ?? { owned: false, pieces: [] };
      sets.set(address, set);
      set.pieces.push({ chunk: r.chunk, feeCap, tipCap: tipCap as bigint | undefined });
      // the owner's note: the one whose own W this is
      if (r.wallet.l === n.leaf?.label && r.wallet.j === jOf(n.ref)) set.owned = true;
    }
    if (p.spendOf === undefined) continue;
    for (const set of sets.values()) {
      if (!set.owned) continue;
      let spend = p.spendOf(set.pieces);
      const sum = set.pieces.reduce((a, x) => a + x.chunk, 0n);
      if (typeof spend !== "bigint" || spend > sum) throw new Error(`pool ${p.id}: the spend of ${sum} in chunks is not a bigint at most them`);
      if (spend < 0n) spend = 0n;
      if (spend > c.tapMax) c.tapMax = spend;
    }
    sets.clear();
  }
  return [...chains].map(([chain, c]) => ({
    chain,
    asset: c.asset,
    balance: decimal(c.balance, c.d),
    ...(ready === undefined || !c.open ? {} : { ready: decimal(c.ready, c.d), ...(c.spends ? { tap_max: decimal(c.tapMax, c.d) } : {}), ...(making === undefined ? {} : { making: decimal(c.making, c.d) }) }),
  }));
}
