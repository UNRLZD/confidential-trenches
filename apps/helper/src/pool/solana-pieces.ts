// POST /v1/pool/solana/pieces (card buy-spends-several-pieces): the pure parts of carrying one pool buy made of several
// pieces, every tag 2 first and the tag 3 that buys last, all W-signed, as ONE Jito bundle with the helper's own tip
// transaction last. The carry itself is solanaPoolSender's carryPieces (./solana.ts), which shares the one-piece
// route's state (one send per nullifier, failed_this_epoch, the per-client in-flight limit).
//
// Why a tip transaction of the helper's own: Jito considers a bundle only when it tips with an instruction that
// transfers SOL to a tip account ("can be any instruction, top-level or CPI, that transfers SOL to one of the 8 tip
// accounts", docs.jito.wtf/lowlatencytxnsend, read 2026-11-12), and the pool pays the tag 3's tip by a lamport write
// (contracts/pool-solana/src/release.rs:279-280), which is not one. W signs every piece and the buy, so the helper can
// add no instruction to them; it adds a transaction of its own instead, signed only by its fee payer, last in the bundle,
// so it lands only with the buy. The same page warns that a tip outside the main transaction can be taken by an uncle
// block on its own; the tip is the helper's SOL, at most the cap below, never the user's.
//
// The tip amount: Jito's recent landed tip floor, its 95th percentile, read from bundles.jito.wtf (cached 10 s, a 1 s
// timeout, a bounded body; the answer is hostile: a value that is not a finite number from 0 to 1 SOL is unread), else
// the kit's SOLANA_POOL_JITO_TIP (100,000 lamports), never under SOLANA_JITO_TIP_MIN.
// The cap (piecesTipCap): the tip is paid out of what the bundle's relay fees bring the fee payer over its worst cost of
// carrying them, so carrying a buy never spends the helper's own funds beyond gas, as the one-piece route holds each
// release to (./solana.ts fee_below_cost). Each W-signed transaction brings its relay fee less its cost as that check
// prices it: the release's cost, the page reserve and the priority fee W set; relay fee less cost less reserve is the
// kit's priority budget (solanaPoolPriorityBudget), so each brings its budget less W's priority fee. The tip
// transaction's own signature fee (5,000 lamports) comes off the sum. A floor over the cap is refused before anything is
// sent (422 fee_below_cost, "tip floor over the relay fees").
import { ed25519 } from "@noble/curves/ed25519.js";
import { SOLANA_JITO_TIP_MIN, SOLANA_POOL_JITO_TIP, SOLANA_SYSTEM_PROGRAM, solanaCompileV0 } from "@blindfill/kit";

/** POST /v1/pool/solana/pieces's body limit: the kit's HELPER_V1_PATHS row (8 KB), SOLANA_POOL_BUY_PIECES_MAX
 *  transactions in base64 and the JSON around them. */
export const POOL_SOLANA_PIECES_BODY_MAX = 8_192;
/** Jito's tip floor: the landed tips' percentiles over the recent window, in SOL (docs.jito.wtf/lowlatencytxnsend). */
export const JITO_TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";
/** How long one tip floor read serves [design: Jito's floor moves over minutes; a bundle carry asks it once]. */
export const JITO_TIP_FLOOR_CACHE_MS = 10_000;
/** The longest one tip floor read takes before it counts as unread [design: a bundle waits at most this for it]. */
export const JITO_TIP_FLOOR_TIMEOUT_MS = 1_000;
/** A tip floor answer longer than this is unread [design: the real answer is one object, about 300 bytes]. */
export const JITO_TIP_FLOOR_ANSWER_MAX = 4_096;
/** A floor over this many SOL is absurd and counts as unread [design: ten thousand times the kit's tip,
 *  SOLANA_POOL_JITO_TIP, 0.0001 SOL; a floor between the cap and this is a real market and is refused, not replaced]. */
export const JITO_TIP_FLOOR_ABSURD_SOL = 1;
/** The tip transaction's own fee: one signature at 5,000 lamports, and no priority fee. */
export const SOLANA_TIP_TX_FEE = 5_000n;
const LAMPORTS_PER_SOL = 1_000_000_000;

export type TipFloorFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The 95th percentile of landed tips in one tip floor answer, in lamports rounded up; null when the answer is not
 *  one (a non-finite, negative or absurd value, or any other shape). */
export function tipFloorOf(text: string): bigint | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const row = Array.isArray(j) && j.length >= 1 ? (j[0] as { landed_tips_95th_percentile?: unknown } | null) : null;
  const sol = row !== null && typeof row === "object" ? row.landed_tips_95th_percentile : undefined;
  if (typeof sol !== "number" || !Number.isFinite(sol) || sol < 0 || sol > JITO_TIP_FLOOR_ABSURD_SOL) return null;
  // SOL to lamports, rounded up; the product's float noise (0.00005999 x 1e9 = 59,990.00000000001) cut at a millionth
  return BigInt(Math.ceil(Number((sol * LAMPORTS_PER_SOL).toFixed(6))));
}

/** The tip floor reader: one read serves JITO_TIP_FLOOR_CACHE_MS, unread included (a floor that cannot be read costs
 *  each carry no wait while it is down); a read in flight is shared. */
export function jitoTipFloor(opts: { fetch?: TipFloorFetch; now?: () => number; url?: string; timeoutMs?: number } = {}): () => Promise<bigint | null> {
  const doFetch = opts.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? JITO_TIP_FLOOR_TIMEOUT_MS;
  let cached: { at: number; value: Promise<bigint | null> } | undefined;
  const read = async (): Promise<bigint | null> => {
    const signal = AbortSignal.timeout(timeoutMs);
    const body = (async () => {
      const r = await doFetch(opts.url ?? JITO_TIP_FLOOR_URL, { method: "GET", headers: { accept: "application/json" }, signal, redirect: "error" });
      if (!r.ok || !r.body) return null;
      const reader = r.body.getReader();
      const parts: Uint8Array[] = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > JITO_TIP_FLOOR_ANSWER_MAX) {
          void reader.cancel().catch(() => {});
          return null;
        }
        parts.push(value);
      }
      return tipFloorOf(Buffer.concat(parts).toString("utf8"));
    })();
    // the whole read, body included, within the timeout, whether or not the fetch honours the signal
    let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => {
      t = setTimeout(() => done(null), timeoutMs);
      t.unref?.();
    });
    try {
      return await Promise.race([body.catch(() => null), late]);
    } finally {
      clearTimeout(t);
    }
  };
  return () => {
    const t = now();
    if (cached !== undefined && t - cached.at >= 0 && t - cached.at < JITO_TIP_FLOOR_CACHE_MS) return cached.value;
    const value = read();
    cached = { at: t, value };
    return value;
  };
}

/** The tip a bundle pays: the floor read, else the kit's SOLANA_POOL_JITO_TIP, never under SOLANA_JITO_TIP_MIN. */
export const bundleTip = (floor: bigint | null): bigint => {
  const t = floor ?? SOLANA_POOL_JITO_TIP;
  return t < SOLANA_JITO_TIP_MIN ? SOLANA_JITO_TIP_MIN : t;
};

/** The most the tip may be (the header): the sum over the W-signed transactions of their priority budget (the relay fee
 *  less the release's cost and the page reserve) less the priority fee W set, less the tip transaction's own fee. */
export const piecesTipCap = (txs: readonly { budget: bigint; priority: bigint }[]): bigint => txs.reduce((s, t) => s + t.budget - t.priority, 0n) - SOLANA_TIP_TX_FEE;

/** The tip transaction, signed: one SystemProgram transfer of `lamports` from the fee payer to `tipAccount`, both static
 *  keys (no lookup table: "When tipping make sure to not use Address Lookup Tables for the tip accounts", the same
 *  page), on `blockhash`; the fee payer its only signer. */
export function solanaTipTx(seed: Uint8Array, feePayer: string, tipAccount: string, lamports: bigint, blockhash: string): Uint8Array {
  if (lamports <= 0n || lamports >= 1n << 64n) throw new Error("a tip of 1 to u64 lamports");
  const data = new Uint8Array(12);
  const v = new DataView(data.buffer);
  v.setUint32(0, 2, true); // SystemInstruction::Transfer
  v.setBigUint64(4, lamports, true);
  const ix = { program: SOLANA_SYSTEM_PROGRAM, accounts: [{ key: feePayer, signer: true, writable: true }, { key: tipAccount, signer: false, writable: true }], data };
  const { message } = solanaCompileV0(feePayer, [ix], blockhash, [], [feePayer]);
  return Uint8Array.from([1, ...ed25519.sign(message, seed), ...message]);
}
