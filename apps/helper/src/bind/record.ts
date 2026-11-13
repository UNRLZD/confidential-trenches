// POST /v1/bind/record (card near-holdings-restore): a device restoring from its 12 words asks, for each of its NEAR
// trade wallets W, what the helper's trade store holds (trade.ts TradeRecord): the token W's first carried call named,
// and every call carried for W: a landed or failed one with its relayer transaction's signed bytes, which hold W's own
// NEP-366 SignedDelegateAction; a pending or dropped one with its delegate's max_block_height alone, never its bytes (a
// delegate not on chain stays with the helper). The device believes a call only when W's own signature checks (signpage
// near-w-calls.ts), and
// a state here only for when to look again, never for what W holds; nothing here is trusted for a signature.
//
// Only a W the vault paid gets its record: the vault's spends list, both providers at one final block, a row whose
// recipient is W, paid or settled with refund_value 0 (trade.ts createTradeReads payoutsLanded, the creation's rule),
// read once per request whatever the number of wallets, by pages that name no wallet. A W not paid, or with no record,
// answers the same empty shape, so the answer is no oracle of which W exist. A read that fails answers upstream and
// nothing is kept.
//
// The store is only read (TradeStore.get, a whole file each: every write is a whole replace by rename, so a record
// mid-write reads as its last write), never written, and W's carry slot (send.ts accountSlots) is never taken, so a
// carry is never held up by a restore. Nothing here logs.
import { HELPER_BIND_RECORD_WALLETS_MAX, HELPER_V1_PATHS, type HelperBindRecord, type HelperBindRecordAnswer, type HelperBindRecordCode, type HelperV1Path } from "@blindfill/kit";
import { decodeSignedDelegate } from "./checks.ts";
import type { RecordReads, TradeStore } from "./trade.ts";

/** The kit's HELPER_V1_PATHS row for POST /v1/bind/record (8 KB). */
export const RECORD_BODY_MAX = HELPER_V1_PATHS.find((r): r is Extract<HelperV1Path, { path: "/v1/bind/record" }> => r.path === "/v1/bind/record")!.limitBytes;

export type RecordRequest = { network: "mainnet" | "testnet"; wallets: string[] };
export type RecordAnswer = { status: 200; body: HelperBindRecordAnswer } | { status: number; body: { error: { code: HelperBindRecordCode } } };
export type RecordDeps = { reads: RecordReads; store: Pick<TradeStore, "get"> };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const IMPLICIT = /^[0-9a-f]{64}$/;

/** The body, exactly {network, wallets} with 1 to HELPER_BIND_RECORD_WALLETS_MAX distinct 64-lowercase-hex ids; else null. */
export function parseRecordBody(body: unknown): RecordRequest | null {
  if (!isObj(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("network") || !keys.includes("wallets")) return null;
  const { network, wallets } = body;
  if (network !== "mainnet" && network !== "testnet") return null;
  if (!Array.isArray(wallets) || wallets.length < 1 || wallets.length > HELPER_BIND_RECORD_WALLETS_MAX) return null;
  if (!wallets.every((w): w is string => typeof w === "string" && IMPLICIT.test(w))) return null;
  if (new Set(wallets).size !== wallets.length) return null;
  return { network, wallets: [...wallets] };
}

const empty = (wallet: string): HelperBindRecord => ({ wallet, token: null, calls: [], created: null });

/** The max_block_height of the one Delegate in a relayer transaction (send.ts encodeTransaction of encodeAction's
 *  delegate: Transaction V0, one Action::Delegate, then the relayer's ed25519 signature), as {max_block_height}; {} when
 *  the bytes are not that shape. */
function mbhOf(signedTx: string): { max_block_height?: string } {
  try {
    const b = Buffer.from(signedTx, "base64");
    let i = 0;
    const str = () => (i += 4 + b.readUInt32LE(i));
    str(); // signer
    if (b[i] !== 0) return {};
    i += 1 + 32 + 8; // key, nonce
    str(); // receiver
    i += 32; // block hash
    if (b.readUInt32LE(i) !== 1 || b[i + 4] !== 8) return {};
    i += 5;
    const sigAt = b.length - 65;
    if (sigAt <= i || b[sigAt] !== 0) return {};
    return { max_block_height: decodeSignedDelegate(b.subarray(i, sigAt)).max_block_height.toString() };
  } catch {
    return {};
  }
}

/** Each asked wallet's record, in the asked order; 503 upstream when the payout read or a store read fails. */
export async function readRecords(wallets: readonly string[], deps: RecordDeps): Promise<RecordAnswer> {
  try {
    const paid = await deps.reads.payoutsLanded(wallets);
    if (paid.length !== wallets.length) throw new Error("payoutsLanded: not one answer per wallet");
    const records = wallets.map((w, i): HelperBindRecord => {
      if (paid[i] !== true) return empty(w);
      const rec = deps.store.get(w);
      if (rec === null) return empty(w);
      return {
        wallet: w,
        token: rec.token,
        calls: rec.carried.map((x) => {
          // a delegate not final on chain (pending, or dropped and so never on it) is not handed out: anyone holding its
          // bytes could send it; its last block alone says when it can no longer land
          const out = x.state === "landed" || x.state === "failed" ? { signed_tx: x.signed_tx } : mbhOf(x.signed_tx);
          return { tx_hash: x.tx_hash, ...out, method: x.method, side: x.side, state: x.state, ...(x.refunded === true && { refunded: true as const }) };
        }),
        created: rec.creation === null ? null : { tx_hash: rec.creation.tx_hash, height: rec.creation.height, state: rec.creation.state },
      };
    });
    return { status: 200, body: { records } };
  } catch {
    return { status: 503, body: { error: { code: "upstream" } } };
  }
}
