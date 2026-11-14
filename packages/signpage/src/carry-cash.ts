// A leftover's carry to Cash (card leftovers-carry-to-cash): what a one-time wallet keeps under one deposit's floor (a
// U_X a deposit left money at, short or past its end, and a W's tail) is sent whole to Cash's own deposit quote (a fresh
// U, the vault's one-time deposit account, src/deposit-wire.ts depositQuoteHost), one wallet a send: no send carries two
// wallets' money, and nothing tops a wallet up. The chain's sender (CarrySender: Solana's in ./carry-cash-sol.ts, Base's
// and Robinhood's in ./carry-cash-evm.ts) is all that names the wallet to its chain's RPCs, and only in its own pass.
import type { PoolChain } from "../../kit/src/signpage/messages.ts";

/** The wallet a leftover is on and how the device derives its key: a U_X (U_{s,i} of the chain, the pool's scope `s`), or
 *  a W (W_{sol, l, j}). `address` is the wallet's own, checked against the key derived before anything is signed. */
export type CarrySource =
  | { chain: PoolChain; kind: "ux"; address: string; s: string; i: number }
  | { chain: "solana"; kind: "w"; address: string; l: string; j: number };

/** One signed send, recorded before it leaves (an EVM send's nonce; a Solana send's blockhash's last valid height). */
export type CarrySend = { hash: string; value: string; sentMs: string; nonce?: string; lastValid?: string };

/** The open carry of one wallet: the checked deposit address it pays, the amount quoted (exactly what it sends), the id
 *  of the quote's follow op, and each send signed for it. Written before the first send leaves. */
export type CarryOpen = { to: string; amount: string; quote: string; quotedMs: string; sends: CarrySend[] };

/** How a send ended: landed (read on both RPCs, the wallet's money at the address); pending (it may still land: read
 *  again next pass); dead (it cannot land and nothing of it did: quote again); short (the wallet's lower balance less the
 *  send's bound is under the amount quoted: quote again at what it holds); fault (a read or the rule failed: next pass). */
export type CarryEnd = "landed" | "pending" | "dead" | "short" | "fault";

export type CarrySender = {
  /** The wallet's whole lower balance on the chain's two RPCs less the send's fee bound, in the coin's base units: the
   *  amount a send of it can carry; null when a read fails or they disagree past what the sender takes. */
  sendable(src: CarrySource, signal?: AbortSignal): Promise<bigint | null>;
  /** Sends exactly `open.amount` to `open.to` from the wallet (its key derived for the signature and zeroed after), each
   *  signed send added through `keep` before it leaves; an open record's sends are read first, so a reload never sends
   *  twice what can still land. */
  send(src: CarrySource, open: CarryOpen, keep: (o: CarryOpen) => Promise<void>, signal?: AbortSignal): Promise<CarryEnd>;
};
