// The Ws a buy of several pieces may have left holding SOL (card buy-spends-several-pieces), found from the notes
// alone, so a restored device (which has no owed record of that buy) finds them too.
//
// A buy of several pieces pays W, the own W of its buy's note, from other notes' releases (tag 2s), then spends that
// note in its buy (tag 3). When the releases land and the buy never does, the buy's note stays unspent and its own W
// holds what the releases paid. So the device derives the own W of each of the pool's UNSPENT and HELD notes and reads
// how much SOL each holds: on mainnet in one getMultipleAccounts on the helper's seat per 100 Ws (never on a public
// provider: one public request that names several Ws links them for that provider), in the testnet build, which has no
// helper seat, one W a request. A W that holds SOL gets a rent back owed (pool-sell.ts OwedRentBack `found`), which
// reads W alone on both RPCs, sweeps only a W both read owning no token account and past its latest transaction's
// blockhash life (foundQuiet: no buy signed before it can still land), and keeps the rest on W.
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";

/** Ws per getMultipleAccounts on the helper's seat (its route's own cap). */
export const FOUND_BATCH = 100;

export type FoundW = { address: string; l: bigint; j: number };

/** The own W (W_{sol, label, j}) of each of `scope`'s UNSPENT and HELD landed notes, but those in `skip`; each key
 *  zeroed at once. */
export function ownWs(seed64: Uint8Array, notes: readonly NoteRecord[], scope: bigint, skip: ReadonlySet<string> = new Set()): FoundW[] {
  const out = new Map<string, FoundW>();
  for (const n of notes) {
    if (n.scope !== scope || (n.state !== "UNSPENT" && n.state !== "HELD") || n.leaf === undefined) continue;
    const j = jOf(n.ref);
    const w = freshWallet(seed64, "sol", n.leaf.label, j);
    w.secretKey.fill(0);
    if (!skip.has(w.address)) out.set(w.address, { address: w.address, l: n.leaf.label, j });
  }
  return [...out.values()];
}

/** The Ws of `ws` that hold any lamports: read in batches of FOUND_BATCH on `batch` (the helper's seat), or, with no
 *  such seat, one W a request on `one`. A read that fails or answers out of shape throws: nothing is found on it. */
export async function heldWs(ws: readonly FoundW[], batch: SolanaRpc | null, one: SolanaRpc): Promise<FoundW[]> {
  const lamportsOf = (v: unknown): bigint | null => {
    if (v === null) return 0n;
    const l = (v as { lamports?: unknown } | undefined)?.lamports;
    if (typeof l !== "number" || !Number.isSafeInteger(l) || l < 0) throw new Error("an account's lamports are not a count");
    return BigInt(l);
  };
  const out: FoundW[] = [];
  if (batch !== null) {
    for (let i = 0; i < ws.length; i += FOUND_BATCH) {
      const part = ws.slice(i, i + FOUND_BATCH);
      const r = (await batch("getMultipleAccounts", [part.map((w) => w.address), { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }])) as { value?: unknown };
      if (!Array.isArray(r?.value) || r.value.length !== part.length) throw new Error("getMultipleAccounts: not one answer a W");
      part.forEach((w, k) => {
        if (lamportsOf((r.value as unknown[])[k])! > 0n) out.push(w);
      });
    }
    return out;
  }
  for (const w of ws) {
    const r = (await one("getAccountInfo", [w.address, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }])) as { value?: unknown };
    if (r === null || typeof r !== "object" || !("value" in r)) throw new Error("getAccountInfo: no value");
    if (lamportsOf(r.value)! > 0n) out.push(w);
  }
  return out;
}
