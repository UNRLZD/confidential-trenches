// Restore step 5's reads of the arm ids R, V and A, step 7's second-scan wait, and step 7's arms with nothing visible
// (card wallet-restore-id-reader; docs/plan1/wallet.md §2.3 "Restore" step 5 l.293-306, step 7 "The second scan"
// l.335-342, "An arm with nothing visible" l.343-345, block time from the chain l.346-348). It runs after
// restoreWallets (./wallets.ts), on what restoreNotes (../notes/restore.ts) and it found.
//
// - Step 5 (l.293-301): R_{c,l,j} for every wallet found or left unread (a wallet whose read failed may have history,
//   as its hop targets are read; review F3), hop targets included (c the wallet's tag), and V_{l,j} for
//   every withdrawal found, are read for what they hold inside intents.near (mt_tokens_for_owner) and on the vault's
//   token (ft_balance_of, since 1Click delivers to the id's own NEAR account). A_{l,j}, for every withdrawal found, is
//   read for its USDC on NEAR, its NEAR, and what it holds inside intents.near (a 1Click refund to A, or §8 item 10's
//   fallback). One account per request, in a random order (as step 4), never the notes' order. A read that fails or
//   answers anything but a balance is listed in `unread`, never taken as zero; a view that fails with
//   "FiatToken: paused" is a halt, never a zero (l.295-296), listed with `halt`, and the device reads again. Every
//   secret key derived here is zeroed at once: only account ids leave this file.
// - Step 7, the second scan (l.335-342): a withdrawal the lost store signed lands until its deadline_ms, an arming
//   delegate until its max_block_height, so steps 3-5 run once more only after both RPCs' final blocks are past both
//   bounds, plus 1Click's delivery time counted from the later of the two. Block time and height are read from the chain on two RPCs, never the device
//   clock (l.346-348).
// - Step 7, an arm with nothing visible (l.343-345): an arm whose spends row shows it landed, but whose A, W and V
//   hold nothing, has its money in flight with 1Click or due as a late refund to V: its W and V are re-read on each
//   open until money shows. quietArms gives that list; the open loop is the caller's.
import { armAccount, freshWallet, refundId, returnId, type Chain } from "../derive/index.ts";
import type { NoteRestore } from "../notes/restore.ts";
import { arrivalOf } from "../withdraw/arrival.ts";
import type { NearNetwork, NearRpc } from "../deposit/account.ts";
import { openRestorePass, type PassOpts, type RestorePass } from "./id-reader.ts";
import { ARM_TAGS, type HistoryChain, type WalletRestore } from "./wallets.ts";

/** A balance read: "usdc" ft_balance_of on the vault's token, "near" the account's NEAR, "intents" its intents.near holdings. */
export type ArmRead = "usdc" | "near" | "intents";
/** What an account holds on one read; only > 0n matters here. Throws when it cannot tell. */
export type BalanceReader = (what: ArmRead, account: string) => Promise<bigint>;
export type ArmKind = "R" | "V" | "A";
/** An arm id read in step 5: R_{c,l,j}, V_{l,j} or A_{l,j}, and the reads that showed more than zero. */
export type ArmAccount = { kind: ArmKind; c?: Chain; l: bigint; j: number; account: string; holds: ArmRead[] };
/** A read that failed or answered no balance; `halt` when the token answered "FiatToken: paused". */
export type UnreadArm = { kind: ArmKind; c?: Chain; l: bigint; j: number; account: string; what: ArmRead; error: string; halt?: true };
export type ArmRestore = { accounts: ArmAccount[]; unread: UnreadArm[] };

/** The reads of each kind (l.293-301): R and V on intents.near and the token; A on the token, NEAR and intents.near. */
const READS: Record<ArmKind, readonly ArmRead[]> = { R: ["intents", "usdc"], V: ["intents", "usdc"], A: ["usdc", "near", "intents"] };
const ORDER: readonly ArmRead[] = ["usdc", "near", "intents"];
const PAUSED = "FiatToken: paused";

/** A random order of n reads (crypto.getRandomValues unless a test gives `pick`, which returns 0 <= k < n); as ./wallets.ts. */
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
const idOf = (k: { id: string; secretKey: Uint8Array }): string => {
  k.secretKey.fill(0);
  return k.id;
};
const armKey = (l: bigint, j: number): string => `${l}:${j}`;

/** Step 5: R of every wallet found or unread, V and A of every withdrawal, each read for what it holds. */
export async function restoreArmAccounts(
  seed64: Uint8Array,
  r: Pick<NoteRestore, "spends">,
  w: Pick<WalletRestore, "wallets" | "unread">,
  read: BalanceReader,
  opts: { pick?: (n: number) => number } = {},
): Promise<ArmRestore> {
  const pick = opts.pick ?? randomPick;
  const accounts: ArmAccount[] = [];
  const seen = new Set<string>();
  for (const x of [...w.wallets, ...w.unread]) {
    const k = `R:${x.c}:${armKey(x.l, x.j)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    accounts.push({ kind: "R", c: x.c, l: x.l, j: x.j, account: idOf(returnId(seed64, x.c, x.l, x.j)), holds: [] });
  }
  for (const s of r.spends) {
    const k = armKey(s.l, s.j);
    if (seen.has(k)) continue;
    seen.add(k);
    accounts.push({ kind: "V", l: s.l, j: s.j, account: idOf(refundId(seed64, s.l, s.j)), holds: [] });
    accounts.push({ kind: "A", l: s.l, j: s.j, account: idOf(armAccount(seed64, s.l, s.j)), holds: [] });
  }
  const unread: UnreadArm[] = [];
  for (const [a, what] of shuffled(accounts.flatMap((a) => READS[a.kind].map((what) => [a, what] as const)), pick)) {
    let v: unknown;
    try {
      v = await read(what, a.account);
      if (typeof v !== "bigint" || v < 0n) throw new Error("the read answered no balance");
    } catch (e) {
      const halt = e instanceof Error && e.message.includes(PAUSED);
      unread.push({ kind: a.kind, ...(a.c === undefined ? {} : { c: a.c }), l: a.l, j: a.j, account: a.account, what, error: why(e), ...(halt ? { halt: true as const } : {}) });
      continue;
    }
    if (v > 0n) a.holds.push(what);
  }
  for (const a of accounts) a.holds.sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));
  return { accounts, unread };
}

/**
 * The second scan's wait (l.338-342). A withdrawal the lost store signed lands until its deadline_ms, at most 10 min
 * past the restore (the longest deadline_ms of §2.5 step 5); no delegate from an id or an arming account reaches more
 * than 600 blocks past it (§2.8 deposit call row); and 1Click delivers within 2 min of the last possible delegate
 * (21-25 s in P1).
 */
export const SECOND_SCAN_WAIT_MS = 10 * 60_000;
export const SECOND_SCAN_BLOCKS = 600;
export const SECOND_SCAN_DELIVERY_MS = 2 * 60_000;

/** Both RPCs' final block heights and timestamps (ms), in rpcs order. */
export type FinalPair = { heights: [number, number]; timesMs: [number, number] };
const pair = (xs: unknown, name: string): [number, number] => {
  if (!Array.isArray(xs) || xs.length !== 2) throw new Error(`${name}: two, one per RPC`);
  for (const x of xs) if (!Number.isSafeInteger(x) || (x as number) <= 0) throw new Error(`${name}: each is a safe positive integer`);
  return xs as [number, number];
};

/** The first block past the second scan's height bound: the higher restore height plus SECOND_SCAN_BLOCKS plus one. */
export function secondScanBoundHeight(at: Pick<FinalPair, "heights">): number {
  return Math.max(...pair(at?.heights, "at.heights")) + SECOND_SCAN_BLOCKS + 1;
}

/**
 * The second scan's own pass (review P1): it exists to see money that lands after the bound, so a pass whose block is
 * not above secondScanBoundHeight(at) is refused, and the restore's own pass is never reused for it.
 */
export function openSecondScanPass(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], at: Pick<FinalPair, "heights">, opts: Omit<PassOpts, "after"> = {}): Promise<RestorePass> {
  return openRestorePass(network, rpcs, { ...opts, after: secondScanBoundHeight(at) });
}

/**
 * Step 7: whether the second scan is due. `at` is both RPCs' final blocks read at the restore, `now` both RPCs' final
 * blocks now, and `bound` both RPCs' timestamps (ms) of block secondScanBoundHeight(at), or null while it is not read.
 * Due only when both heights are past the higher restore height by more than SECOND_SCAN_BLOCKS, and both RPCs' final
 * block time is more than SECOND_SCAN_DELIVERY_MS past the later of the two bounds: SECOND_SCAN_WAIT_MS past the higher
 * restore time, and the higher time of the bound block (l.338-342: "Then it waits 2 more minutes of block time", after
 * both; with slow blocks the height bound is the later, and a delegate landing in its last block gets its 2 minutes).
 */
export function secondScanDue(at: FinalPair, now: FinalPair, bound: [number, number] | null): boolean {
  const atH = pair(at?.heights, "at.heights"), atT = pair(at?.timesMs, "at.timesMs");
  const nowH = pair(now?.heights, "now.heights"), nowT = pair(now?.timesMs, "now.timesMs");
  const h = Math.max(...atH) + SECOND_SCAN_BLOCKS;
  if (!nowH.every((x) => x > h)) return false;
  if (bound === null) throw new Error("the bound block's times are needed once both heights are past it");
  const b = pair(bound, "bound");
  const t = Math.max(Math.max(...atT) + SECOND_SCAN_WAIT_MS, ...b) + SECOND_SCAN_DELIVERY_MS;
  return nowT.every((x) => x > t);
}

/** A landed arm with nothing visible: its own W (each on its chains) and its V, re-read on each open until money shows. */
export type QuietArm = { l: bigint; j: number; note: string; w: { c: Chain; address: string; chains: HistoryChain[] }[]; v: string };
const W_CHAINS: Record<(typeof ARM_TAGS)[number], HistoryChain[]> = { sol: ["solana"], evm: ["base", "robinhood"], near: ["near"] };

/**
 * Step 7: the arms whose withdrawal landed at A_{l,j} (arrivalOf, ../withdraw/arrival.ts: the spends row's recipient is
 * A, and its status is "paid" or "settled" with refund_value 0, the kit's VaultSpendRow, packages/kit/src/vault/sync.ts
 * l.117-132, status per the vault's on_payout, docs/plan1/vault.md l.466-467) but whose A, V, R and every W show
 * nothing: no step 5 read of the arm holds money or is unread, and no wallet of the arm was found or left unread in
 * step 4. A wallet found means money showed there (its history), so its arm is left out. The W listed are the arm's own
 * three (a hop needs a ready wallet as its source, so none of an arm with no wallet found).
 */
export function quietArms(
  seed64: Uint8Array,
  r: Pick<NoteRestore, "spends">,
  arms: ArmRestore,
  w: Pick<WalletRestore, "wallets" | "unread">,
): QuietArm[] {
  const out: QuietArm[] = [];
  const done = new Set<string>();
  const ofArm = <T extends { l: bigint; j: number }>(xs: readonly T[], l: bigint, j: number): T[] => xs.filter((x) => x.l === l && x.j === j);
  for (const s of r.spends) {
    const k = armKey(s.l, s.j);
    if (done.has(k)) continue;
    done.add(k);
    const a = idOf(armAccount(seed64, s.l, s.j));
    if (arrivalOf(s.spend, a)?.kind !== "arrived") continue;
    const v = idOf(refundId(seed64, s.l, s.j));
    const mine = ofArm(arms.accounts, s.l, s.j);
    const readA = mine.find((x) => x.kind === "A" && x.account === a);
    const readV = mine.find((x) => x.kind === "V" && x.account === v);
    if (readA === undefined || readV === undefined) throw new Error(`arm (l ${s.l}, j ${s.j}): no step 5 read of its A and V`);
    if (mine.some((x) => x.holds.length > 0) || ofArm(arms.unread, s.l, s.j).length > 0) continue;
    if (ofArm(w.wallets, s.l, s.j).length > 0 || ofArm(w.unread, s.l, s.j).length > 0) continue;
    const ws = ARM_TAGS.map((c) => {
      const x = freshWallet(seed64, c, s.l, s.j);
      x.secretKey.fill(0);
      return { c, address: x.address, chains: [...W_CHAINS[c]] };
    });
    out.push({ l: s.l, j: s.j, note: s.note, w: ws, v });
  }
  return out;
}
