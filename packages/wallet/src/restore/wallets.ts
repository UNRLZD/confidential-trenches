// Restore of the fresh wallets and the deposit ids from the note walk (card wallet-restore-wallets, row W1.4;
// docs/plan1/wallet.md §2.3 "Restore" steps 4, 5 and 7 l.277-341, device lanes l.247-258, the chain tags l.91-100,
// P-03 l.1075). It runs after restoreNotes (../notes/restore.ts), on what that found.
//
// - Step 4, the wallets: there is no wallet walk and no gap. The wallets are exactly the arms the notes show: for every
//   withdrawal (l, j) of the restore, W_{c,l,j} on the three arm tags (sol, evm, near), each address read for history
//   one per request on its chain: one read on Solana, one on NEAR, two for the evm address (Base and Robinhood, since no
//   record says which one it was used on). A wallet is found when a read shows history or the restore found its return
//   note. For an arm with a wallet found, its three hop targets (hop-sol, hop-evm, hop-near) are read the same way,
//   since any ready wallet may be a hop's source. A read that fails or answers anything but yes or no is listed in
//   `unread`, never taken as no history, and counts as found for reading the arm's hop targets: a missed wallet would
//   leave money where the user cannot see it. The reads go in a random order, never the notes' order; each names one
//   address and nothing else. Every secret key derived here is zeroed at once: only addresses leave this file.
// - Step 5, the deposit ids of each lane: U_{s,i} is read for every index of the lane up to its highest with a note or
//   any history, and on until DEPOSIT_ID_MARGIN indices of the lane in a row past that were never used (in an empty
//   lane, its first DEPOSIT_ID_MARGIN). As BIP-44's gap limit counts addresses with no history, not addresses at zero,
//   an id that was ever used (funded, refunded, withdrawn out) resets the count as money does: a run of used ids
//   now empty never hides money past it. A read that fails counts as money (listed in `unread`, and the lane's highest
//   moves up to it), so a failure never ends a lane early nor lets step 7 name an index that may hold a lost store's
//   send; once DEPOSIT_ID_MARGIN reads of a lane fail with no read showing history between them (so DEPOSIT_ID_MARGIN
//   in a row among them), step 5 stops with an error naming the lane, so a provider that keeps failing ends the
//   restore, to be retried, instead of reading on toward 2^32. Ids with history (or unread) past the note walk's end
//   (NoteRestore laneWalked) end that lane's reads there: the lane returns the index as its `reach`, and restoring
//   again with it (restoreNotes `reach`) walks the notes to it and reads the ids on from there. Nothing loops on its own.
// - Step 7, after the restore: the new store draws its own lane when it opens (../store/index.ts). Its deposit counter
//   for the scope is raised past the lost store's possible index, to its lane's highest with a note or any history plus
//   two of the lane (in an empty lane, its second index). For 72 h of NEAR block time after the restore, every open
//   re-reads, in every lane, each deposit id up to that lane's highest plus two (in an empty lane, its first two) that
//   holds no note (an id read as money, a used id now empty and an id whose read failed included: review N2, as one
//   provider may fake money), so a late send to a quote the lost store named is found. A restore with a lane stopped
//   past its note walk's end is unfinished (`complete` false): step 7 refuses it, raising no counter (review N3).
import { freshWallet, type Chain } from "../derive/index.ts";
import { depositAccount } from "../deposit/account.ts";
import { RESTORE_LANES, type NoteRestore } from "../notes/restore.ts";
import { refKey } from "../notes/store.ts";

/** The tags of an arm's own wallets, and of its hop targets (wallet.md l.91-100). */
export const ARM_TAGS = ["sol", "evm", "near"] as const satisfies readonly Chain[];
export const HOP_TAGS = ["hop-sol", "hop-evm", "hop-near"] as const satisfies readonly Chain[];
/** A chain an address's history is read on: an evm address on both Base and Robinhood. */
export type HistoryChain = "solana" | "near" | "base" | "robinhood";
const READS: Record<Chain, readonly HistoryChain[]> = {
  sol: ["solana"],
  "hop-sol": ["solana"],
  near: ["near"],
  "hop-near": ["near"],
  evm: ["base", "robinhood"],
  "hop-evm": ["base", "robinhood"],
};
/** Deposit ids of a lane in a row past its highest that were never used before the id reads stop (wallet.md l.302-308). */
export const DEPOSIT_ID_MARGIN = 21;
/** How long after a restore every open re-reads the deposit ids (a deposit address's life, D44; wallet.md l.327). */
export const REREAD_MS = 72 * 3_600_000;
const U32 = 0xffffffff;

/**
 * Whether an address has history on a chain: any balance, nonce or transaction (on EVM a balance and a nonce, on Solana
 * one signature, on NEAR the account itself). Throws when it cannot tell.
 */
export type HistoryReader = (chain: HistoryChain, address: string) => Promise<boolean>;
/**
 * What a deposit id (U, a NEAR implicit account) shows. The contract every IdReader keeps (card wallet-restore-id-reader;
 * ./id-reader.ts nearIdReader is the one on NEAR, with the mainnet read behind each rule):
 * - "money": U holds money now: ft_balance_of(U) on the vault's token above 0, or a token inside intents.near above 0.
 * - "used": U holds none, and a read proves it was used: storage_balance_of(U) on the token is not null (D16: a
 *   never-used id has none; 1Click's delivery registers it) or view_account(U) answers an account. has_public_key is no
 *   proof (true for every implicit id, D15), nor is is_nonce_used (intents.near prunes V1 nonces past their deadline),
 *   nor a token listed at 0 (intents.near deletes a balance that falls to 0).
 * - Both providers are read and the stronger answer taken (money over used over unused), each id at one block.
 * - "unused": only when no read on either provider shows money or a trace.
 * - An indexer is a server's word: it may say used, never unused.
 * - Throws when it cannot tell (after its retries): step 5 counts the id as failed, never as unused.
 */
export type IdState = "money" | "used" | "unused";
export type IdReader = (id: string) => Promise<IdState>;

/** A fresh wallet the restore found: its arm (l, j), the note whose withdrawal made it, its path and address. */
export type RestoredWallet = { c: Chain; l: bigint; j: number; note: string; path: string; address: string; history: HistoryChain[]; returnNote: string | null };
export type UnreadWallet = { c: Chain; l: bigint; j: number; address: string; chain: HistoryChain; error: string };
export type WalletRestore = { wallets: RestoredWallet[]; unread: UnreadWallet[] };

type Slot = RestoredWallet & { failed: boolean };

/** A random order of n reads (crypto.getRandomValues unless a test gives `pick`, which returns 0 <= k < n). */
function shuffled<T>(xs: T[], pick: (n: number) => number): T[] {
  for (let k = xs.length - 1; k > 0; k--) {
    const r = pick(k + 1);
    if (!Number.isInteger(r) || r < 0 || r > k) throw new Error("pick is out of range");
    [xs[k], xs[r]] = [xs[r]!, xs[k]!];
  }
  return xs;
}
const randomPick = (n: number): number => {
  const lim = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    const x = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]!;
    if (x < lim) return x % n;
  }
};
const why = (e: unknown): string => (e instanceof Error ? e.message : "the read failed").slice(0, 200);

/** Step 4: every fresh wallet of the restore's withdrawals, on all six chain tags. */
export async function restoreWallets(
  seed64: Uint8Array,
  r: Pick<NoteRestore, "notes" | "spends">,
  read: HistoryReader,
  opts: { pick?: (n: number) => number } = {},
): Promise<WalletRestore> {
  const pick = opts.pick ?? randomPick;
  const returns = new Set(r.notes.filter((n) => n.ref.kind === "return").map((n) => refKey(n.ref)));
  const arms = new Map<string, { l: bigint; j: number; note: string }>();
  for (const s of r.spends) {
    if (!Number.isInteger(s.j) || s.j < 0 || s.j > U32) throw new Error(`spend of ${s.note}: its change index is not a counter`);
    const k = `${s.l}:${s.j}`;
    if (!arms.has(k)) arms.set(k, { l: s.l, j: s.j, note: s.note });
  }
  const unread: UnreadWallet[] = [];
  const slotOf = (c: Chain, a: { l: bigint; j: number; note: string }): Slot => {
    const w = freshWallet(seed64, c, a.l, a.j);
    w.secretKey.fill(0);
    const ret = refKey({ kind: "return", c, l: a.l, j: a.j });
    return { c, l: a.l, j: a.j, note: a.note, path: w.path, address: w.address, history: [], returnNote: returns.has(ret) ? ret : null, failed: false };
  };
  const readAll = async (slots: Slot[]): Promise<void> => {
    for (const [s, chain] of shuffled(slots.flatMap((s) => READS[s.c].map((chain) => [s, chain] as const)), pick)) {
      let yes: unknown;
      try {
        yes = await read(chain, s.address);
        if (typeof yes !== "boolean") throw new Error("the read answered neither yes nor no");
      } catch (e) {
        s.failed = true;
        unread.push({ c: s.c, l: s.l, j: s.j, address: s.address, chain, error: why(e) });
        continue;
      }
      if (yes) s.history.push(chain);
    }
  };
  const found = (s: Slot): boolean => s.history.length > 0 || s.returnNote !== null;

  const own = [...arms.values()].map((a) => ARM_TAGS.map((c) => slotOf(c, a)));
  await readAll(own.flat());
  // an arm with a wallet found, or one whose reads failed, or a hop's return note: its hop targets are read too
  const hopReturn = (a: { l: bigint; j: number }): boolean => HOP_TAGS.some((c) => returns.has(refKey({ kind: "return", c, l: a.l, j: a.j })));
  const armsList = [...arms.values()];
  const hops = own.map((slots, k) => (slots.some((s) => found(s) || s.failed) || hopReturn(armsList[k]!) ? HOP_TAGS.map((c) => slotOf(c, armsList[k]!)) : []));
  await readAll(hops.flat());

  const wallets: RestoredWallet[] = [];
  own.forEach((slots, k) => {
    for (const s of [...slots, ...hops[k]!]) {
      if (!found(s)) continue;
      const { failed: _, ...w } = s;
      w.history.sort((x, y) => x.localeCompare(y));
      wallets.push(w);
    }
  });
  return { wallets, unread };
}

/**
 * One lane's deposit ids: the indices with a note, with money, used and now empty, the ids that could not be read, and
 * the lane's highest of all of them.
 */
export type LaneIds = {
  lane: number;
  notes: number[];
  money: number[];
  used: number[];
  unread: { i: number; id: string; error: string }[];
  highest: number | null;
  readTo: number;
  /**
   * The index of an id with history (or unread) past the note walk's end, where the lane's reads stopped: a note there
   * was never matched, so the user restores again with it as the lane's reach (restoreNotes `reach`). null: the lane
   * was read to its margin.
   */
  reach: number | null;
};

/**
 * Step 5's result: each lane's ids, and whether the restore is complete. `complete` is false when any lane stopped
 * past its note walk's end (its `reach` set, review N3): notes may lie past it, so step 7 refuses the lanes and the
 * user restores again with those reaches.
 */
export type DepositIds = { lanes: LaneIds[]; complete: boolean };

/** Step 5, the deposit ids: every lane of the scope read to DEPOSIT_ID_MARGIN never-used ids past its highest with a note or history. */
export async function restoreDepositIds(
  seed64: Uint8Array,
  scope: bigint,
  r: Pick<NoteRestore, "notes" | "laneHighest" | "laneWalked">,
  holds: IdReader,
  opts: { margin?: number } = {},
): Promise<DepositIds> {
  const margin = opts.margin ?? DEPOSIT_ID_MARGIN;
  if (!Number.isSafeInteger(margin) || margin < 1) throw new Error("margin is a count above 0");
  if (!Array.isArray(r.laneHighest) || r.laneHighest.length !== RESTORE_LANES) throw new Error("laneHighest: one per lane");
  // where the note walk (step 3) ended in each lane, from the restore itself (its gap and reach included, review F4):
  // ids with history past it may hold notes it never matched
  if (!Array.isArray(r.laneWalked) || r.laneWalked.length !== RESTORE_LANES) throw new Error("laneWalked: one per lane");
  const noted = new Set<number>();
  for (const n of r.notes) if (n.ref.kind === "deposit" && n.ref.s === scope) noted.add(n.ref.i);
  const out: LaneIds[] = [];
  for (let lane = 0; lane < RESTORE_LANES; lane++) {
    const notes = [...noted].filter((i) => i % RESTORE_LANES === lane).sort((x, y) => x - y);
    const h = r.laneHighest[lane];
    // the walk's highest must be the highest note of this lane the restore holds: else the lane's ids are read short
    if (h !== (notes.length === 0 ? null : notes[notes.length - 1])) throw new Error(`lane ${lane}: its highest ${String(h)} is not its highest note`);
    const walked = r.laneWalked[lane]!;
    if (!Number.isSafeInteger(walked) || walked < lane || walked > U32 || walked % RESTORE_LANES !== lane || (h !== null && h !== undefined && walked < h))
      throw new Error(`lane ${lane}: its walk end ${String(walked)} is not an index of the lane at or past its highest note`);
    let highest: number | null = h ?? null;
    const money: number[] = [];
    const used: number[] = [];
    const unread: LaneIds["unread"] = [];
    // failed reads since the lane's last read that showed history: margin of them ends the restore with an error
    let failed = 0;
    // the note walk counts a used id with no note as a miss: when ids with history (or unread ids, which may have it)
    // run on past its end, a note there was never matched. Held each time the lane's highest moves: the lane's reads
    // stop there and name it as the reach to restore again with (review F5), so a reader that keeps showing history
    // ends the lane at its walk's end, never at 2^32, and the restore still returns what it found
    let reach: number | null = null;
    let readTo = lane - RESTORE_LANES;
    for (let i = lane; i <= U32 && i <= (highest ?? lane - RESTORE_LANES) + RESTORE_LANES * margin; i += RESTORE_LANES) {
      readTo = i;
      const id = depositAccount(seed64, scope, i).account;
      let state: unknown;
      try {
        state = await holds(id);
        if (state !== "money" && state !== "used" && state !== "unused") throw new Error("the read answered neither money, used nor unused");
      } catch (e) {
        unread.push({ i, id, error: why(e) });
        highest = Math.max(highest ?? i, i);
        if (++failed >= margin) throw new Error(`lane ${lane}: ${failed} id reads failed with none showing history between them (the last at index ${i}: ${why(e)}); the restore stops, to be retried`);
        if (highest > walked) {
          reach = highest;
          break;
        }
        continue;
      }
      if (state === "unused") continue;
      (state === "money" ? money : used).push(i);
      highest = Math.max(highest ?? i, i);
      failed = 0;
      if (highest > walked) {
        reach = highest;
        break;
      }
    }
    out.push({ lane, notes, money, used, unread, highest, readTo, reach });
  }
  return { lanes: out, complete: out.every((x) => x.reach === null) };
}

/** Step 7's plan: the index the new lane's counter was raised to, and the ids every open re-reads until `until`. */
export type AfterRestore = { scope: bigint; lane: number; next: number; until: number; rereads: { lane: number; i: number; id: string }[] };

/** The last index step 7 covers in a lane: its highest with a note or any history plus two of the lane (empty: its second). */
const coverTo = (x: LaneIds): number => (x.highest === null ? x.lane + RESTORE_LANES : x.highest + 2 * RESTORE_LANES);

/**
 * Step 7: raises the store's deposit counter for the scope past the lost store's possible index in the store's lane,
 * and gives the ids to re-read on each open until `until` (the restore's NEAR final block time, `atMs`, plus 72 h).
 */
export async function afterRestore(
  seed64: Uint8Array,
  store: { readonly lane: number; raiseDepositIndex(scope: bigint, min: number): Promise<number> },
  scope: bigint,
  lanes: readonly LaneIds[],
  atMs: number,
): Promise<AfterRestore> {
  if (!Number.isSafeInteger(atMs) || atMs <= 0) throw new Error("atMs is the restore's NEAR block time in ms");
  if (lanes.length !== RESTORE_LANES || !lanes.every((x, k) => x.lane === k)) throw new Error("lanes: one per lane, in order");
  // an unfinished restore (review N3): a lane stopped past its note walk's end was never read past its reach, so no
  // counter is raised and nothing is re-read on its word; the user restores again with the reaches named
  const stopped = lanes.filter((x) => x.reach !== null);
  if (stopped.length > 0)
    throw new Error(`the restore is unfinished: ${stopped.map((x) => `lane ${x.lane} stopped at ${String(x.reach)}`).join(", ")}, past the note walk's end; restore again with ${stopped.map((x) => `reach[${x.lane}] = ${String(x.reach)}`).join(", ")}`);
  const mine = lanes[store.lane]!;
  const next = await store.raiseDepositIndex(scope, coverTo(mine));
  const rereads: AfterRestore["rereads"] = [];
  for (const x of lanes) {
    // ids with a note are the vault's; an id read as money stays in the re-reads until its move lands (review N2): one
    // provider may fake money, which no second read outvotes
    const held = new Set(x.notes);
    for (let i = x.lane; i <= coverTo(x) && i <= U32; i += RESTORE_LANES) if (!held.has(i)) rereads.push({ lane: x.lane, i, id: depositAccount(seed64, scope, i).account });
  }
  return { scope, lane: store.lane, next, until: atMs + REREAD_MS, rereads };
}

/** The ids an open re-reads: step 7's list while the NEAR final block time `nowMs` is before its end, then none. */
export function rereadsDue(plan: Pick<AfterRestore, "until" | "rereads">, nowMs: number): AfterRestore["rereads"] {
  return nowMs < plan.until ? plan.rereads : [];
}
