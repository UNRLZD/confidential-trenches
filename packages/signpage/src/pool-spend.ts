// Whose release spent a note (card signpage-withdraw-own-spend, read for a buy too by card signpage-buy-own-spend):
// another device signed in with the same 12 words spends the same note to the same W from its own note store, so a
// spent mark and a full W never say whose spend it is. spendOwner reads it on both RPCs at finalized: this attempt's
// own transaction by its signature, else W's history. Moved here from pool-withdraw.ts as it was, so pool-buy.ts
// (sendAndSettle) and pool-withdraw.ts (runPoolWithdraw, finishPoolOnward) both import it and neither imports the other
// for it. Every read names W or a transaction of its history; nothing here logs.
import { base58, base64 } from "@scure/base";
import { solanaDecodeTransaction, type SolanaMessage } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_POOL_PROOF_BYTES, SOLANA_POOL_PROOF_COMPRESSED_BYTES, SOLANA_POOL_TAG_RELEASE, SOLANA_POOL_TAG_RELEASE_AND_BUY, solanaDecodePoolRelease } from "../../kit/src/trade/solana/pool-buy.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { solanaContextOf, solanaPoolOf, type SolanaPoolPin, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";

class Stop extends Error {}
const stop = (why: string): never => {
  throw new Stop(why);
};

/** The page of W's history getSignaturesForAddress gives at most (its documented limit). */
export const HISTORY_PAGE = 1_000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const be = (b: Uint8Array): bigint => b.reduce((v, x) => (v << 8n) | BigInt(x), 0n);
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** A landed transaction's message, v0 or legacy, or null when the bytes are neither. A legacy message is a v0 one with
 *  no version prefix and no lookup list, so it is read by the same strict decoder with both put back: a release of this
 *  note wrapped in a legacy message (the pool program takes either) is read, never skipped. Its keys are keysOf's. */
function landedMessage(wire: Uint8Array): SolanaMessage | null {
  try {
    const n = wire[0]!;
    if (n === 0 || n >= 0x80 || wire.length <= 1 + 64 * n) return null;
    const body = wire.subarray(1 + 64 * n);
    if (body[0]! & 0x80) return solanaDecodeTransaction(wire).message;
    const v0 = new Uint8Array(1 + 64 * n + 1 + body.length + 1);
    v0.set(wire.subarray(0, 1 + 64 * n));
    v0[1 + 64 * n] = 0x80;
    v0.set(body, 2 + 64 * n);
    return solanaDecodeTransaction(v0).message;
  } catch {
    return null;
  }
}

const isKey = (k: unknown): k is string => {
  if (typeof k !== "string" || k.length < 32 || k.length > 44) return false;
  try {
    return base58.decode(k).length === 32;
  } catch {
    return false;
  }
};
/** Every key of a landed message in index order: the static keys, then the keys its lookups load, as the RPC's
 *  getTransaction meta gives them (loadedAddresses: every lookup's writable keys, then every lookup's readonly ones,
 *  the runtime's order). A message with no lookup list has its static keys only. With one, the meta must name exactly
 *  as many keys of each kind as the lookups do, each an address, else null: the keys are not known, so the message
 *  is no one's spend (a tag 3 loads the pool account from our lookup table, kit pool-buy.ts solanaPoolBuyTableAccounts). */
export function keysOf(message: SolanaMessage, meta: Record<string, unknown>): string[] | null {
  if (message.lookups.length === 0) return message.staticKeys;
  const loaded = meta.loadedAddresses;
  if (!isObj(loaded)) return null;
  const { writable, readonly } = loaded;
  const count = (k: "writable" | "readonly"): number => message.lookups.reduce((n, l) => n + l[k].length, 0);
  if (!Array.isArray(writable) || !Array.isArray(readonly) || writable.length !== count("writable") || readonly.length !== count("readonly")) return null;
  if (!writable.every(isKey) || !readonly.every(isKey)) return null;
  return [...message.staticKeys, ...writable, ...readonly];
}
/** Tag 3's flags the pool program takes (contracts/pool-solana src/buy.rs FLAG_COMPRESSED 1, FLAG_NEXT_PAGE 2): any
 *  other bit is refused there, so such a tag 3 never landed. */
const TAG3_FLAGS = 3;
/** Tag 3's bytes after the fields, before its inner instructions: the tip (u64) and the inner count (u8). */
const TAG3_TAIL = 9;
/** The release's field bytes, tag 2's run after the proof (contracts/pool-solana src/release.rs FIELDS_LEN). */
const RELEASE_FIELDS = 130;

/** One transaction read on one RPC, at finalized: "none" when the RPC holds none under `sig`, "skip" when it is no
 *  landed pool instruction naming the note's nullifier hash (failed, or another kind, or another note's), else the
 *  spend and whether it is this attempt's. */
async function spendIn(rpc: SolanaRpc, pin: SolanaPoolPin, w: string, nullifierHash: bigint, context: string, sig: string): Promise<"none" | "skip" | { sig: string; mine: boolean }> {
  const r = await rpc("getTransaction", [sig, { encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
  if (r === null) return "none";
  const t = isObj(r) ? r.transaction : undefined;
  const meta = isObj(r) ? r.meta : undefined;
  if (!Array.isArray(t) || t[1] !== "base64" || typeof t[0] !== "string" || !isObj(meta) || !Object.hasOwn(meta, "err")) return stop("read");
  const wire = base64.decode(t[0]);
  // the transaction the RPC was asked for: its first signature is the id
  if (wire.length < 65 || base58.encode(wire.subarray(1, 65)) !== sig) return stop("read");
  if (meta.err !== null) return "skip";
  // anyone can land a transaction naming W, in any message format: one that is not a whole legacy or v0 message is
  // not the spend (review HIGH 1: a throw here left every finish undecided)
  const message = landedMessage(wire);
  if (message === null) return "skip";
  const { scope } = solanaPoolOf(pin.program);
  const keys = keysOf(message, meta);
  if (keys === null) return "skip";
  for (const ix of message.instructions) {
    if (keys[ix.programIndex] !== pin.program) continue;
    const d = ix.data;
    // where the release's fields start: after tag 2's full proof, or after tag 3's flags and its proof (compressed
    // when flag bit 0 is set, as buy.rs release_and_buy reads it); a tag 3 the program would refuse is not the spend
    const tag3At = 2 + (d[1]! & 1 ? SOLANA_POOL_PROOF_COMPRESSED_BYTES : SOLANA_POOL_PROOF_BYTES);
    const fieldsAt = d[0] === SOLANA_POOL_TAG_RELEASE ? 1 + SOLANA_POOL_PROOF_BYTES
      : d[0] === SOLANA_POOL_TAG_RELEASE_AND_BUY && d.length >= tag3At + RELEASE_FIELDS + TAG3_TAIL && (d[1]! & ~TAG3_FLAGS) === 0 ? tag3At
      : -1;
    const at = fieldsAt + 32;
    if (fieldsAt < 0 || d.length < at + 32 || be(d.subarray(at, at + 32)) !== nullifierHash) continue;
    // the spend (the spent mark lets one release of the note land): this attempt's only when it is a release (tag 2) or
    // a release and buy (tag 3) to W, every account in the message, whose context is this attempt's. Both tags reach
    // one context (contracts/pool-solana src/release.rs settle, row 3: program, the pool at account 0, W at 1, the fee
    // payer at 2, then the fields' relay fee cap, tip cap, deadline and salt; buy.rs release_and_buy reads tag 3's
    // fields at 2 + its proof, the same 130 bytes as tag 2), so tag 3's are read from its own data as tag 2's
    const acc = ix.accounts.map((i) => keys[i]);
    if (acc.length < 3 || acc.some((k) => k === undefined) || acc[1] !== w) return { sig, mine: false };
    try {
      const rel = solanaDecodePoolRelease(d[0] === SOLANA_POOL_TAG_RELEASE ? d : Uint8Array.of(SOLANA_POOL_TAG_RELEASE, ...new Uint8Array(SOLANA_POOL_PROOF_BYTES), ...d.subarray(fieldsAt, fieldsAt + RELEASE_FIELDS)));
      const q: SolanaReleaseRequest = {
        program: pin.program, pool: acc[0]!, recipient: acc[1]!, feePayer: acc[2]!, relayFee: rel.relayFee, relayFeeCap: rel.relayFeeCap, tipCap: rel.tipCap, deadlineMs: rel.deadlineMs, salt: hex(rel.salt),
      };
      return { sig, mine: solanaContextOf(q, scope).toString() === context };
    } catch {
      return { sig, mine: false };
    }
  }
  return "skip";
}

/** The entries of W's history one pass reads at most, on each RPC (fold 3, review LOW 4: entries, not pages): a pass
 *  ends, and the next goes on from where it stopped (HistoryPlaces), so a history of any length is read to its end. */
export const HISTORY_PASS = 2_000;
/** One RPC's place in W's history between passes (the last entry read, moved on after each one, so a pass that fails
 *  part way keeps what it read: fold 5, review MEDIUM), and the spend's signature once found. A find is only a place:
 *  each pass reads it again on the RPC asking now, so one RPC's find never stands for another's (fold 5, review LOW). */
type Place = { before?: string; found?: string };
/** The places of W's history read so far, kept by the caller across the passes of one owed send (pool-testnet keeps
 *  one per op): by the RPC's index among the page's two, W, the note's nullifier hash and the attempt's context (a
 *  found spend's `mine` is that context's). Never by the RPC function: the page makes new ones on every pass (fold 4,
 *  review HIGH: a place so keyed was never found again, and a spend under 2,001 entries never reached). */
export type HistoryPlaces = Map<string, Place>;
const placeOf = (places: HistoryPlaces, at: string): Place => {
  let p = places.get(at);
  if (!p) places.set(at, (p = {}));
  return p;
};

/** One RPC's word on the spend, from W's history (newest first): the landed transaction whose pool instruction names
 *  the nullifier hash, and whether it is this attempt's; null when this pass found none (the history read to its end,
 *  or this pass's share of it read and the rest left for the next). */
async function spendOn(rpc: SolanaRpc, place: Place, pin: SolanaPoolPin, w: string, nullifierHash: bigint, context: string, minSlot: number): Promise<{ sig: string; mine: boolean } | null> {
  if (place.found !== undefined) {
    const again = await spendIn(rpc, pin, w, nullifierHash, context, place.found);
    if (typeof again === "object") return again;
    // not the spend on this RPC (it serves none under that name, or no spend of the note): its history decides
    delete place.found;
  }
  let before = place.before;
  let read = 0;
  while (read < HISTORY_PASS) {
    const page = await rpc("getSignaturesForAddress", [w, { commitment: "finalized", limit: Math.min(HISTORY_PAGE, HISTORY_PASS - read), minContextSlot: minSlot, ...(before !== undefined ? { before } : {}) }]);
    if (!Array.isArray(page) || page.length > HISTORY_PAGE) return stop("read");
    // the end of W's history: read from the newest again next pass (a spend may land after this pass began)
    if (page.length === 0) {
      delete place.before;
      return null;
    }
    for (const e of page) {
      if (!isObj(e) || typeof e.signature !== "string" || e.signature === before) return stop("read");
      // one the RPC lists but does not serve yet is read again once the history is read to its end
      const got = await spendIn(rpc, pin, w, nullifierHash, context, e.signature);
      before = place.before = e.signature;
      read++;
      if (typeof got === "object") {
        delete place.before;
        place.found = got.sig;
        return got;
      }
    }
  }
  return null;
}

/** Whose spend it is: this attempt's, with the signature of the transaction that spent the note (the one a filled
 *  answer names); another's; or not known yet. */
export type SpendOwner = { mine: string } | "other" | null;

/** Whose release spent the note (round-3 review LOW 1): two devices on the same 12 words derive the same note and the
 *  same W, so a spent note and a full W never say it.
 *  - This attempt's own release, read back by its own signature (`release`, kept with the owed send) at finalized on
 *    both RPCs, landed without error and carrying `context`: mine (its signature), with no read of W's history (fold 3, review HIGH
 *    2: anyone can grow W's history without bound).
 *  - Else W's history names it: on both RPCs, at or past `minSlot`, the one landed pool instruction naming the note's
 *    nullifier hash (a release, or a release and buy). Mine (that transaction's signature) when on both it is the same transaction and a release
 *    to W carrying `context`; "other" when on both it is the same transaction and not; null otherwise (an RPC holds
 *    none yet, or they differ): the money may be this attempt's, so nothing is decided.
 *  The history is read on from `places` (each RPC's place and find, kept by the caller across passes).
 *  The reads name W, which the balance reads name already, and transactions of its history. */
export async function spendOwner(rpcs: readonly [SolanaRpc, SolanaRpc], pin: SolanaPoolPin, w: string, nullifierHash: bigint, context: string, minSlot: number, release: string | undefined, places: HistoryPlaces): Promise<SpendOwner> {
  if (release !== undefined && release !== "") {
    const own = await Promise.all(rpcs.map((rpc) => spendIn(rpc, pin, w, nullifierHash, context, release)));
    if (own.every((o) => typeof o === "object" && o.mine)) return { mine: release };
  }
  const at = rpcs.map((_, i) => placeOf(places, `${i}:${w}:${nullifierHash}:${context}`));
  const [a, b] = await Promise.all(rpcs.map((rpc, i) => spendOn(rpc, at[i]!, pin, w, nullifierHash, context, minSlot)));
  if (!a || !b) return null;
  if (a.sig !== b.sig || a.mine !== b.mine) {
    // the two name different spends: neither is kept, both are read again
    for (const p of at) delete p.found;
    return null;
  }
  return a.mine ? { mine: a.sig } : "other";
}
