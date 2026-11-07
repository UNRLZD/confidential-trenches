// W's releases at a sell (card evm-sell-no-release-in-flight; audit E-01, Pillow Auditors v1.0, 7 Nov): no sale is built
// for a one-time wallet W while a release that pays W ETH is on its way.
//
// SellDelegate's minOut counts every wei W's balance gains during the sale (contracts/pool-evm/src/SellDelegate.sol:
// `_gained = address(this).balance - _eth`, and W's open receive()), and the pool's reentrancy guard is not held during
// a sell. So hostile code in a signed route (a token, a hook, a target) could land a release still pending for W (a
// withdraw, or a buy that reaches its fallback: PrivacyPoolSimple.sol buy's `_push(_data.recipient, ...)`, which emits
// Withdrawn) in the middle of the swap, keep the swap's output and still pass minOut with the release's ETH
// (test/Sell.t.sol test_pillow_E01_foreignEthDuringTheSellMeetsMinOut). The deployed delegate is final, so the guard is
// here, and the verdict is the kit's own read: the sell quote (checks/evm/quote.ts evmPoolSellQuote) reads W's releases
// at its agreed block and carries the verdict inside the quote, and the sell builder (quoted.ts evmQuotedSell) builds
// only from a quote whose verdict is for its chain, its W and its block and holds nothing pending (review of 982a19bd,
// F1: a verdict the caller made from its own read let an app hand the kit an empty one).
//
// What pays W ETH, and when it is final:
// - a Withdrawn to W (a withdraw, or a buy's fallback) in a block above the finalized one (the tail) is pending: a reorg
//   can put it back in the mempool, where a route can still land it mid-sell. At or below the finalized block it can
//   never move again;
// - a Bought to W in the tail is pending too, but for the buy that funded this sale (the quote's token, landed in the
//   quote's boughtBlock: review of 982a19bd, F2, which held W's own buy until its block was final, ~15 min). A replayed
//   buy is the same proof and signature, and whether it lands as Bought or as Withdrawn is decided as it runs
//   (PrivacyPoolSimple.sol buy): a route that moves the buy's pool first fails its swap, and the pool's fallback pays the
//   chunk to W in ETH mid-sell, E-01 again (review of 181fd050, R2-3; contracts/pool-evm test/Buy.t.sol `_paysOut`: a
//   failed swap pays W in ETH and logs Withdrawn, and test/Sell.t.sol's E-01 PoC: ETH landing mid-sell meets minOut).
//   The funding buy is the exception because, reorged out, it
//   leaves W without the token the sale sells, so the sale cannot land at all; replayed whole, it reverts the sale at
//   the exact-debit check (test_aBoughtReplayedMidSellRevertsAtTheExactDebit). Either kind counts as landed, so a
//   release the device sent that landed clears its own wait;
// - a release the device sent that has not landed lands only while the chain's time is at most its deadline
//   (PrivacyPool.sol _spendChecked: `block.timestamp * 1000 > _deadlineMs` reverts), so it is pending until it lands or
//   the finalized block's time is past its deadline. The device names these (its store's RESERVED notes that pay W: the
//   wallet's pool/evm-releases.ts), and the releases its store saw land in a block not yet final, with no deadline
//   (review of 181fd050, info: one above every provider's "latest" dropped out of both): such a one is pending until
//   the read finds it. That list can only add waits, never clear one the read found;
// - a release to W above the quote's agreed block is pending too (review of 982a19bd, F3), once a second provider holds
//   its block with it (checks/evm/quote.ts releasesConfirmed: one provider's word alone held every sale, review of
//   181fd050, R2-1). It is dropped only where more than half of the whole provider list holds its block without it or
//   is more than maxLag below it (review of e21c5611, R4-1: on a list of two, one answer never decides); a low head, an
//   error or a head past the block without it is no answer, and the quote waits or is refused with the claimant held,
//   never built over it (review of 9c2a87d5, R3-1; of e21c5611, R4-4).
import type { EvmPoolChain } from "./buy-unpinned.ts";
import { EvmPoolSellError } from "./sell-unpinned.ts";

/** One release to W that is not final yet, and what the sell waits for: `landed`, the block a Withdrawn to W landed in,
 *  until the finalized block reaches it; or `deadlineMs`, a release the device sent and that has not landed, until it
 *  lands or a final block's time passes its deadline. `note` names the device's note (null for a release it did not
 *  name). */
export type EvmReleasePending =
  | { readonly note: string | null; readonly landed: bigint }
  | { readonly note: string; readonly deadlineMs: bigint | null };

/** A release the device sent to W that has not landed final as far as its store knows: its note, the note's nullifier
 *  hash and the attempt's deadline (block time, ms), or no deadline for one the store saw land in a block not yet final. */
export type EvmSellSent = { readonly note: string; readonly nullifier: bigint; readonly deadlineMs?: bigint };

/** The kit's verdict on W's releases, read by the sell quote at its agreed block `block` with the finalized block
 *  `finalBlock` (the lower of two providers'). The sell builder takes only one the quote read, and only with `pending`
 *  empty. */
export type EvmSellReleases = {
  readonly chain: EvmPoolChain;
  readonly w: string;
  readonly block: bigint;
  readonly finalBlock: bigint;
  readonly pending: readonly EvmReleasePending[];
};

/** A pool release event to W: Withdrawn (`withdraw`) or Bought (`buy`, with its _token), its block and its
 *  _spentNullifier. */
export type EvmReleaseLog = { readonly kind: "withdraw" | "buy"; readonly block: bigint; readonly nullifier: bigint; readonly token: string | null };

/** The most releases a device names for one W: a W is one note's (l, j), so a handful at most. */
export const EVM_SELL_SENT_MAX = 64;

const isNat = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n;

/** The device's `sent` list read once into a frozen copy, or null where it is not a list of at most EVM_SELL_SENT_MAX
 *  releases, each a note, a nullifier and a deadline. */
export function evmSellSentOf(sent: unknown): readonly EvmSellSent[] | null {
  if (!Array.isArray(sent) || sent.length > EVM_SELL_SENT_MAX) return null;
  const out: EvmSellSent[] = [];
  for (const s of [...sent] as unknown[]) {
    const { note, nullifier, deadlineMs } = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
    if (typeof note !== "string" || note.length === 0 || !isNat(nullifier) || (deadlineMs !== undefined && !isNat(deadlineMs))) return null;
    out.push(Object.freeze(deadlineMs === undefined ? { note, nullifier } : { note, nullifier, deadlineMs }));
  }
  return Object.freeze(out);
}

// every verdict evmSellReleasesAt made: a copy, a spread or a hand-made object is not in it
const MADE = new WeakSet<EvmSellReleases>();

/** The verdict at the quote's read (checks/evm/quote.ts): `agreed`, W's releases in the blocks above `fin` up to `block`
 *  that both providers gave the same; `above`, those above `block` either provider gave; `sent`, the device's. Not in
 *  the index: only the quote makes one. */
export function evmSellReleasesAt(r: { chain: EvmPoolChain; w: string; block: bigint; fin: { number: bigint; timestamp: bigint }; agreed: readonly EvmReleaseLog[]; above: readonly EvmReleaseLog[]; sent: readonly EvmSellSent[]; funding: { token: string; block: bigint } }): EvmSellReleases {
  const { chain, block, fin } = r;
  const finalMs = fin.timestamp * 1000n;
  const noteOf = new Map(r.sent.map((s) => [s.nullifier, s.note]));
  const landed = new Set<bigint>();
  const pending: EvmReleasePending[] = [];
  for (const e of [...r.agreed, ...r.above]) {
    if (landed.has(e.nullifier)) throw new EvmPoolSellError("release_in_flight", "W's releases cannot be read: a nullifier released twice");
    landed.add(e.nullifier);
  }
  // a release to W in the tail, agreed or above the quote's block, but for the buy that funded this sale: its ETH can
  // still land mid-sell
  // (one buy funds a sale: a second of its shape is held as any other)
  let funded = false;
  for (const e of [...r.agreed, ...r.above]) {
    if (!funded && e.kind === "buy" && e.token === r.funding.token.toLowerCase() && e.block === r.funding.block) funded = true;
    else pending.push(Object.freeze({ note: noteOf.get(e.nullifier) ?? null, landed: e.block }));
  }
  // sent and not landed in the tail: with a deadline, until the finalized block's time passes it; with none (seen landed
  // in a block not yet final), until the read finds it
  for (const s of r.sent) if (!landed.has(s.nullifier) && (s.deadlineMs === undefined || finalMs <= s.deadlineMs)) pending.push(Object.freeze({ note: s.note, deadlineMs: s.deadlineMs ?? null }));
  const v: EvmSellReleases = Object.freeze({ chain, w: r.w.toLowerCase(), block, finalBlock: fin.number, pending: Object.freeze(pending) });
  MADE.add(v);
  return v;
}

const waitOf = (p: EvmReleasePending): string =>
  "landed" in p
    ? `${p.note ?? "a release"} landed in block ${p.landed}, above the finalized block: the sell waits until block ${p.landed} is final on both RPCs`
    : p.deadlineMs === null
      ? `${p.note} landed in a block the providers do not show yet: the sell waits until its block is final on both RPCs`
      : `${p.note} was sent and has not landed: the sell waits until it lands in a final block or a final block's time passes its deadline ${p.deadlineMs} ms`;

/** Refuses a sell from `quote` unless its `releases` is a verdict the sell quote read for the quote's chain, W and block,
 *  with nothing pending (release_in_flight, naming the wait). */
export function evmSellReleasesClear(quote: { chain: EvmPoolChain; w: string; block: { number: bigint }; releases?: unknown }): void {
  const releases = quote.releases;
  if (typeof releases !== "object" || releases === null || !MADE.has(releases as EvmSellReleases)) {
    throw new EvmPoolSellError("release_in_flight", "a sell is built only with W's releases the sell quote read");
  }
  const v = releases as EvmSellReleases;
  if (v.chain !== quote.chain || v.w !== quote.w.toLowerCase()) throw new EvmPoolSellError("release_in_flight", "the releases read is another chain's or another W's");
  if (v.block !== quote.block.number) throw new EvmPoolSellError("release_in_flight", `the releases read is at block ${v.block}, not the quote's block ${quote.block.number}`);
  if (v.pending.length > 0) {
    throw new EvmPoolSellError("release_in_flight", `${v.pending.length} release${v.pending.length === 1 ? "" : "s"} to W not final on two RPCs: ${v.pending.map(waitOf).join("; ")}`);
  }
}
