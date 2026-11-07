// W's releases at a sell (card evm-sell-no-release-in-flight; audit E-01, Pillow Auditors v1.0, 7 Nov): no sale is built
// for a one-time wallet W while a release to W is on its way.
//
// SellDelegate's minOut counts every wei W's balance gains during the sale (contracts/pool-evm/src/SellDelegate.sol:
// `_gained = address(this).balance - _eth`, and W's open receive()), and the pool's reentrancy guard is not held during
// a sell. So hostile code in a signed route (a token, a hook, a target) could land a release still pending for W (a
// withdraw, or a buy that reaches its fallback: PrivacyPoolSimple.sol buy's `_push(_data.recipient, ...)`) in the middle
// of the swap, keep the swap's output and still pass minOut with the release's ETH
// (test/Sell.t.sol test_pillow_E01_foreignEthDuringTheSellMeetsMinOut). The deployed delegate is final, so the guard is
// here: the kit's sell builder (quoted.ts evmQuotedSell) builds only with a verdict this file made for the quote's chain
// and W whose `pending` is empty, and W signs only what that builder returned.
//
// A release to W is final once it can no longer move ETH onto W:
// - landed: its Withdrawn or Bought is in a block at or below the finalized anchor both RPCs agree on. One in a block
//   above it (the tail) is pending: a reorg can put it back in the mempool, where a route can still land it;
// - sent and not landed: it lands only while the chain's time is at most its deadline (PrivacyPool.sol _spendChecked:
//   `block.timestamp * 1000 > _deadlineMs` reverts), so it is final once the finalized block's time is past it;
// - any release in the tail paid to W is pending whether the device sent it or not (another device on the words, or a
//   proof the device lost track of).
// The device's read (the wallet's pool/evm-releases.ts) hands the round its tree sync read on two RPCs (the finalized
// anchor and every release event up to the newest agreed block) and every release it sent to W that its store has not
// seen settled (its RESERVED notes); nothing here reads a chain.
import type { EvmPoolChain } from "./buy-unpinned.ts";
import { EvmPoolSellError } from "./sell-unpinned.ts";

/** One release to W that is not final yet, and what the sell waits for: `landed`, the block it landed in, until the
 *  finalized block reaches it; or `deadlineMs`, a release sent and not landed, until it lands in a final block or a final
 *  block's time passes its deadline. `note` names the device's note (null for a release the device did not send). */
export type EvmReleasePending =
  | { readonly note: string | null; readonly landed: bigint }
  | { readonly note: string; readonly deadlineMs: bigint };

/** The verdict evmSellReleases made for `w` on `chain` at the finalized block `finalBlock`. The sell builder takes only
 *  one it made, and only with `pending` empty. */
export type EvmSellReleases = {
  readonly chain: EvmPoolChain;
  readonly w: string;
  readonly finalBlock: bigint;
  readonly pending: readonly EvmReleasePending[];
};

/** What the device's read gives: the round's finalized anchor, every release event of the pool in the round (Withdrawn
 *  and Bought, both RPCs' answer byte for byte up to the newest agreed block), and every release the device sent to W
 *  that its store has not seen settled, with its note's nullifier hash and its deadline (block time, ms). */
export type EvmReleaseRead = {
  chain: EvmPoolChain;
  w: string;
  fin: { number: bigint; timestamp: bigint };
  releases: readonly { block: bigint; recipient: string; nullifier: bigint }[];
  sent: readonly { note: string; nullifier: bigint; deadlineMs: bigint }[];
};

const CHAINS: readonly string[] = ["base", "robinhood", "base-sepolia", "robinhood-testnet"];
const isAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const isNat = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n;
const bad = (m: string): never => {
  throw new EvmPoolSellError("release_in_flight", `W's releases cannot be read: ${m}`);
};
// a list read once into a copy, each item an object
const listOf = (a: unknown, what: string): Record<string, unknown>[] => {
  if (!Array.isArray(a)) return bad(`${what} is not a list`);
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < a.length; i++) {
    const x: unknown = a[i];
    if (typeof x !== "object" || x === null) return bad(`${what} ${i} is not an object`);
    out.push(x as Record<string, unknown>);
  }
  return out;
};

// every verdict evmSellReleases made: a copy, a spread or a hand-made object is not in it
const MADE = new WeakSet<EvmSellReleases>();

/** The verdict on W's releases at the round `r` read (see the header): every release to W that is not final. */
export function evmSellReleases(r: EvmReleaseRead): EvmSellReleases {
  if (typeof r !== "object" || r === null) return bad("the read is not an object");
  const { chain, w, fin } = r;
  if (typeof chain !== "string" || !CHAINS.includes(chain)) return bad("no such chain");
  if (!isAddress(w)) return bad("W is not an address");
  if (typeof fin !== "object" || fin === null || !isNat(fin.number) || !isNat(fin.timestamp)) return bad("the finalized block is not a number and a time");
  const finalBlock = fin.number;
  const finalMs = fin.timestamp * 1000n;
  const me = w.toLowerCase();
  const landed = new Map<bigint, bigint>();
  const paidW: { block: bigint; nullifier: bigint }[] = [];
  for (const e of listOf(r.releases, "release")) {
    const { block, recipient, nullifier } = e;
    if (!isNat(block) || !isAddress(recipient) || !isNat(nullifier)) return bad("a release is not a block, a recipient and a nullifier");
    if (landed.has(nullifier)) return bad("a nullifier released twice");
    landed.set(nullifier, block);
    if (recipient.toLowerCase() === me) paidW.push({ block, nullifier });
  }
  const sent = listOf(r.sent, "sent release").map((s) => {
    const { note, nullifier, deadlineMs } = s;
    if (typeof note !== "string" || note.length === 0 || !isNat(nullifier) || !isNat(deadlineMs)) return bad("a sent release is not a note, a nullifier and a deadline");
    return { note, nullifier, deadlineMs };
  });
  const noteOf = new Map(sent.map((s) => [s.nullifier, s.note]));
  const pending: EvmReleasePending[] = [];
  // landed on W in a block the finalized anchor has not reached
  for (const p of paidW) if (p.block > finalBlock) pending.push(Object.freeze({ note: noteOf.get(p.nullifier) ?? null, landed: p.block }));
  // sent, not landed, and the finalized block's time not yet past its deadline: it can still land
  for (const s of sent) if (!landed.has(s.nullifier) && finalMs <= s.deadlineMs) pending.push(Object.freeze({ note: s.note, deadlineMs: s.deadlineMs }));
  const v: EvmSellReleases = Object.freeze({ chain: chain as EvmPoolChain, w: me, finalBlock, pending: Object.freeze(pending) });
  MADE.add(v);
  return v;
}

const waitOf = (p: EvmReleasePending): string =>
  "landed" in p
    ? `${p.note ?? "a release"} landed in block ${p.landed}, above the finalized block: the sell waits until block ${p.landed} is final on both RPCs`
    : `${p.note} was sent and has not landed: the sell waits until it lands in a final block or a final block's time passes its deadline ${p.deadlineMs} ms`;

/** Refuses a sell for `w` on `chain` unless `releases` is a verdict evmSellReleases made for that chain and W with
 *  nothing pending (release_in_flight, naming the wait). */
export function evmSellReleasesClear(chain: EvmPoolChain, w: string, releases: unknown): void {
  if (typeof releases !== "object" || releases === null || !MADE.has(releases as EvmSellReleases)) {
    throw new EvmPoolSellError("release_in_flight", "a sell is built only with W's releases read by evmSellReleases");
  }
  const v = releases as EvmSellReleases;
  if (v.chain !== chain || typeof w !== "string" || v.w !== w.toLowerCase()) throw new EvmPoolSellError("release_in_flight", "the releases read is another chain's or another W's");
  if (v.pending.length > 0) {
    throw new EvmPoolSellError("release_in_flight", `${v.pending.length} release${v.pending.length === 1 ? "" : "s"} to W not final on two RPCs: ${v.pending.map(waitOf).join("; ")}`);
  }
}
