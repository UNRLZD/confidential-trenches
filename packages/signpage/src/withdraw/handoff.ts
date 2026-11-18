// The withdraw form's reads and its hand-off to the wallet's withdraw path (card signpage-withdraw-handoff; wallet.md
// §2.8 the withdraw.open row W:927 and the arming row W:915, §2.5 step 5 W:650; VT-T02's withdraw leg, run in a script
// page until this card: contracts/vault/scripts/testnet-t02.ts).
//
// - The network is the build's (PAGE_NETWORK): mainnet on SIGN_HOST's build, testnet on the testnet build
//   (packages/signpage/scripts/build-app.mjs folds __SIGN_NETWORK__, ../../../wallet/src/pool/network.ts reads it).
//   Every read and the hand-off use that network's release pair only (any other pair is refused before a read), and the vault and the relayer are that network's
//   release values (NEAR_NETWORKS, RELEASE_WITHDRAW_RELAYER), never an argument: one network per build.
// - cash: the UNSPENT notes of the network's vault scope in this device's note store (./checks.ts cashNotes), which the
//   form plans the amount over, one withdrawal per note; available: the largest of them (./checks.ts withdrawable), what
//   one withdrawal carries. No vault named on the network: no note can be in it, none.
// - fee: the release relayer's quote (GET /v1/withdraw/fee, askWithdrawFee: its answer checked against the release's
//   relayer, byte for byte), refused when above the device's own fee_max (../../../wallet/src/withdraw/feemax.ts, LD5 on
//   the device's own reads), taken at the largest register_deposit any A can need (the token's storage minimum,
//   readTokenStorageMin), so the form names no A before a note is picked. A refusal leaves the fee unread (Busy · Retry).
// - The hand-off (card wallet-withdraw-move-out), offered wherever the release names a vault and a relayer (the
//   testnet build today; SIGN_HOST's once the release writes mainnet's relayer with its vault): the vault pays the
//   NEAR account the user typed straight, as Privacy Pools v1 and the exit tool's vault withdraw row (W:931) do, with
//   fund_recipient false and register_deposit the token's minimum, read on the pair naming no account (typedRegisterDepositOf); A ties
//   nothing more (W:1021), so no hop through the note's A is made. The relayer's quote again for the typed amount
//   (above the drawn fee: the form draws the new fee and nothing is proved), the vault's two trees read by the kit's
//   vaultSync on the pair at one block (their roots the vault's), T the lower of the pair's final block times (agreeing
//   within 60 s, W:650), then the wallet's withdrawRequest (this page's prover worker, fee_max bound again; the note
//   RESERVED with its request body) and relayWithdraw (POST /v1/withdraw, followed on the vault's pages to landed,
//   expired or unmatched). An own landing is then followed to its arrival (../../../wallet/src/withdraw/arrival.ts:
//   the spend row on the pair paid to the typed account, refunded, or paid elsewhere). The seed is zeroed once the
//   request is made and the relay has taken its one derivation; the wait ends on sign out or at HANDOFF_WAIT_MAX_MS.
//   Nothing is signed or sent after the relay, so a page that dies after it leaves nothing to send again.
// - cashWithdrawRun (card cash-withdraws-everything-to-any-chain): the form's plan, one hand-off per note in order, each
//   naming its note and paying the fee the form drew (`exact`: at or above the relayer's quote now, never above the
//   device's fee_max), so every part is exactly as planned and a note planned whole leaves no change. To NEAR the vault
//   pays the typed account; to another chain (./onward.ts) each part first gets its own checked 1Click quote, its refund
//   under V_{l,j} of the change note the part makes, and the vault pays that quote's deposit address. The run stops at
//   the first part that does not leave the vault (a fee that rose, a quote refused, expired, refunded, unmatched,
//   elsewhere, a throw): its note and the parts after it stay in Cash, and the form draws them again.
// - withdrawSettle, on every load: the RESERVED notes a closed page left are followed to settled from their stored
//   request (landed, expired, or SPENT on a spend whose change is not the device's); a HELD one no live tab holds the
//   note store frees when it opens.
// Nothing here logs.
import type { HelperReleaseRelayer } from "../../../kit/src/helper/v1.ts";
import type { VaultProver } from "../../../kit/src/prover/prove.ts";
import { VaultTree } from "../../../kit/src/vault/inputs.ts";
import { vaultSync, vaultSyncStart } from "../../../kit/src/vault/sync.ts";
import { NEAR_NETWORKS, type NearNetwork, nearPairNetwork, nearPairRule } from "../../../kit/src/near/networks.ts";
import { readTokenStorageMin, typedRegisterDepositOf } from "../../../wallet/src/arming/accounts.ts";
import { arrivalOf, type ArrivalOutcome, withdrawArrival } from "../../../wallet/src/withdraw/arrival.ts";
import { changeIndex, refundId } from "../../../wallet/src/derive/index.ts";
import { askDepositQuoteAgain } from "../../../wallet/src/deposit/quote.ts";
import { readNotes, type NoteRecord, type NoteStore } from "../../../wallet/src/notes/store.ts";
import { POOL_TESTNET } from "../../../wallet/src/pool/network.ts";
import { readWithdrawFeeMax } from "../../../wallet/src/withdraw/feemax.ts";
import { pacedNearRpc, viaSeat } from "../../../wallet/src/pace.ts";
import { askWithdrawFee, RELEASE_WITHDRAW_RELAYER, type RelayDeps, type RelayOutcome, relayRpc, type RelayRpc, relayWithdraw } from "../../../wallet/src/withdraw/relay.ts";
import { WITHDRAW_DEADLINE_MAX_MS, withdrawDeadlineMs, withdrawRequest, type WithdrawRequest } from "../../../wallet/src/withdraw/request.ts";
import type { WalletStore } from "../../../wallet/src/store/index.ts";
import { cashNotes, vaultScope, withdrawable } from "./checks.ts";
import type { CheckedCashWithdraw, CheckedWithdraw, StepReport, WithdrawFormDeps } from "./form.ts";
import { checkOnwardQuote, isOnward, onwardQuoteRequest, onwardTo } from "./onward.ts";

/** The network this build of the page runs on: the build's, mainnet unless it is the testnet build. */
export const PAGE_NETWORK: NearNetwork = POOL_TESTNET ? "testnet" : "mainnet";

/** The most the pair's two final block times may differ before no proof is made (W:650). */
export const BLOCK_TIME_SPREAD_MAX_MS = 60_000;

/** The longest the hand-off follows a sent withdrawal: its deadline's most (W:650) and two minutes for the pages. */
export const HANDOFF_WAIT_MAX_MS = WITHDRAW_DEADLINE_MAX_MS + 120_000;

/** What the page gives the form: its store, the seed and its one prover, each opened when a read or the hand-off needs it. */
export type HandoffPage = {
  store(): Promise<WalletStore>;
  notes(): Promise<NoteStore>;
  seed64(): Promise<Uint8Array>;
  prover: VaultProver;
  /** Aborted on sign out (in this tab or another): a relay wait stops, and the note it holds is left to the settle pass. */
  signal?: AbortSignal;
};

/** Tests only: the network and its reads. */
export type HandoffOver = {
  network?: NearNetwork;
  /** A dry's fee (card near-quote-inside-the-kpi): the device's fee cap read within this many ms is taken again, not
   *  read anew (FEE_CAP_DRY_KEPT_MS). Never given on a withdrawal or a buy: those read their own cap before any proof. */
  capKeptMs?: number;
  rpcs?: readonly [RelayRpc, RelayRpc];
  priceRpcs?: readonly [RelayRpc, RelayRpc];
  fetchFn?: typeof fetch;
  /** The trees and the block time (the pair's own reads otherwise). */
  sync?: () => Promise<{ stateTree: VaultTree; labelTree: VaultTree; newestStateRoot: bigint; newestLabelRoot: bigint }>;
  blockNs?: () => Promise<string>;
  /** The higher final height of the pair (upperFinalHeight), read right before RESERVED against the quote's window. */
  height?: () => Promise<number>;
  /** relayWithdraw otherwise. */
  relay?: (seed64: Uint8Array, req: WithdrawRequest, deps: RelayDeps) => Promise<RelayOutcome>;
  /** HANDOFF_WAIT_MAX_MS otherwise. */
  waitMs?: number;
  /** withdrawArrival otherwise. */
  arrival?: typeof withdrawArrival;
  /** The pair the arrival is read on (rpcs otherwise). */
  arrivalRpcs?: readonly [RelayRpc, RelayRpc];
};

/** What a tap's hand-off ends in: the relay's outcome (with the relayer's tx hash of a landing, when it named one), or a
 *  fresh quote above the fee the form drew (nothing proved). */
/** The hand-off's steps a caller may hear (the trace, card buy-shows-every-step): the proof's start and end, and the
 *  relay's send. Public facts only: no key, note or proof is handed over. */
export type HandoffMark = (step: "proof_start" | "proof_done" | "relay_sent", f?: { tx?: string }) => void;
export type HandoffEnd = { kind: RelayOutcome["kind"] | ArrivalOutcome["kind"]; tx?: string } | { kind: "fee"; fee: bigint };

// The release pair (card near-buy-works-on-live): FastNEAR's seat is the helper's keyed route (NEAR_NETWORKS seat), its
// keyless URL the spare (wallet/src/pace.ts viaSeat, the down time shared with the NEAR trade's nearSeatRpc), so the
// hand-off's reads (the trees, the block time, the fee cap and storage minimum, the relay's rounds) keep the key's pace
// and not the keyless 0.39 a second, which held one request's quote-to-send past the helper's quote window (live,
// 14 Nov 20:5xZ); dRPC device-direct. A network with no seat (testnet) has the keyless URL alone.
const seatRelayRpc = (network: NearNetwork): RelayRpc => {
  const net = NEAR_NETWORKS[network];
  const spare = relayRpc(net.fastnear[0]);
  if (net.seat === null) return spare;
  const url = net.seat;
  const seat = relayRpc(url);
  return {
    name: url,
    query: (params, signal) => viaSeat(url, () => seat.query(params, signal), () => spare.query(params, signal), signal),
    block: (params, signal) => viaSeat(url, () => seat.block(params, signal), () => spare.block(params, signal), signal),
  };
};
const pairOf = (network: NearNetwork): readonly [RelayRpc, RelayRpc] => [seatRelayRpc(network), relayRpc(NEAR_NETWORKS[network].drpc)];

type Net = {
  network: NearNetwork;
  net: (typeof NEAR_NETWORKS)[NearNetwork];
  rpcs: readonly [RelayRpc, RelayRpc];
  priceRpcs: readonly [RelayRpc, RelayRpc];
  relayer: HelperReleaseRelayer | null;
  scope: bigint | null;
  fetchFn: typeof fetch;
};
const netOf = (over: HandoffOver): Net => {
  const network = over.network ?? PAGE_NETWORK;
  const rpcs = over.rpcs ?? pairOf(network);
  return {
    network,
    net: NEAR_NETWORKS[network],
    rpcs,
    priceRpcs: over.priceRpcs ?? (network === "mainnet" ? rpcs : pairOf("mainnet")),
    relayer: RELEASE_WITHDRAW_RELAYER[network] ?? null,
    scope: vaultScope(network),
    fetchFn: over.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
  };
};
/** The pair is the network's release pair, or nothing is read: a build reads its own network only. */
const ownPair = ({ network, rpcs, priceRpcs }: Net): void => {
  if (nearPairNetwork(rpcs) !== network) throw new Error(nearPairRule(network));
  if (nearPairNetwork(priceRpcs) !== "mainnet") throw new Error(`priceRpcs: ${nearPairRule("mainnet")}`);
};
/** The trees of one vaultSync read, refused unless their roots are the vault's own at that block. */
export function treesOf(s: { leaves: readonly bigint[]; labels: readonly bigint[]; stateTree: { root: bigint }; labelTree: { root: bigint } }) {
  const stateTree = new VaultTree([...s.leaves]);
  const labelTree = new VaultTree([...s.labels]);
  if (stateTree.root !== s.stateTree.root || labelTree.root !== s.labelTree.root) throw new Error("the synced trees' roots are not the vault's");
  return { stateTree, labelTree, newestStateRoot: s.stateTree.root, newestLabelRoot: s.labelTree.root };
}
/** The sign out's signal and the wait's bound, as one. */
const waitSignal = (page: HandoffPage, over: HandoffOver): AbortSignal => {
  const bound = AbortSignal.timeout(over.waitMs ?? HANDOFF_WAIT_MAX_MS);
  return page.signal ? AbortSignal.any([page.signal, bound]) : bound;
};

/**
 * The fee cap a dry may take again (card near-quote-inside-the-kpi): fee_max (wallet withdraw/feemax.ts) from the gas
 * price and the NEAR/USDC price pool at one block, about 4 reads of each provider. A dry (pool.buy.dry on NEAR) only
 * shows what a buy would cost and signs nothing; it uses the cap to refuse a relayer fee above it before drawing that
 * cost. The withdrawal a buy makes reads its own cap before its proof (this file's fee with no capKeptMs), so a kept cap
 * never caps what the user pays. [design: 60 s: a minute of gas price and NEAR price moves fee_max by far less than its
 * margins (G_cap at 1.5x the gas, S_cap at twice the storage); one cap read a minute, not one an ask.]
 */
export const FEE_CAP_DRY_KEPT_MS = 60_000;
const CAPS_KEPT = new Map<string, { at: number; cap: Promise<bigint> }>();
function keptCap(network: NearNetwork, ms: number, read: () => Promise<bigint>): Promise<bigint> {
  const was = CAPS_KEPT.get(network);
  if (was !== undefined && performance.now() - was.at < ms) return was.cap;
  const cap = read();
  const entry = { at: performance.now(), cap };
  CAPS_KEPT.set(network, entry);
  // a read that failed is not kept
  cap.catch(() => CAPS_KEPT.get(network) === entry && CAPS_KEPT.delete(network));
  return cap;
}

/**
 * The form's reads on the build's network, and the hand-off wherever the release names a vault and a relayer
 * (withdrawHandoff; elsewhere none, and Withdraw is drawn pending, ./form.ts data-pending).
 */
export function withdrawFormDeps(page: HandoffPage, over: HandoffOver = {}): WithdrawFormDeps {
  const n = netOf(over);
  const { network, net, rpcs, priceRpcs, relayer, scope, fetchFn } = n;
  const cash = async () => (scope === null ? [] : cashNotes(await readNotes(await page.store()), scope));
  const available = async (): Promise<bigint> => (scope === null ? 0n : withdrawable(await readNotes(await page.store()), scope));
  const handoff = cashWithdrawRun(page, over);
  return {
    ...(handoff === null ? {} : { handoff }),
    network,
    // each read at its provider's one pace (card wallet-id-reader-paced, review P3-5)
    rpcs: over.rpcs ?? [pacedNearRpc(net.fastnear[0]), pacedNearRpc(net.drpc)],
    cash,
    available,
    async fee(amount?: bigint) {
      ownPair(n);
      if (relayer === null) throw new Error(`the release names no withdrawal relayer on ${network}`);
      // the quote is asked for the most one withdrawal can carry: askWithdrawFee refuses a fee at or above it; with
      // `amount` (card buy-quote-before-any-note: a preview for a user with no Cash note), for a withdrawal of it
      const most = amount ?? (await available());
      const readCap = () => readTokenStorageMin(network, rpcs).then((registerDeposit) => readWithdrawFeeMax({ network, rpcs, priceRpcs, registerDeposit }));
      const [quote, cap] = await Promise.all([askWithdrawFee({ token: net.usdc, relayer, amount: most, fetchFn }), over.capKeptMs === undefined ? readCap() : keptCap(network, over.capKeptMs, readCap)]);
      if (quote.relayFee > cap) throw new Error("relay_fee: above the device's fee_max");
      return quote.relayFee;
    },
  };
}

/**
 * The tap's hand-off: the vault pays the typed account straight (card wallet-withdraw-move-out); null where the network
 * names no vault or relayer. A fresh quote above the fee the form drew ends it before any proof
 * ({ kind: "fee" }: the form draws the new fee). The seed is zeroed once the request is made and the relay has read it
 * (relayWithdraw takes its one derivation before its first await, relay.ts); the relay's wait ends on sign out or at
 * HANDOFF_WAIT_MAX_MS, its note left RESERVED with its request for the settle pass (withdrawSettle).
 */
export function withdrawHandoff(page: HandoffPage, over: HandoffOver = {}): ((w: CheckedWithdraw, drawnFee: bigint, note?: string, exact?: boolean, claim?: () => Promise<void>, mark?: HandoffMark) => Promise<HandoffEnd>) | null {
  const n = netOf(over);
  const { network, net, rpcs, priceRpcs, relayer, scope, fetchFn } = n;
  if (net.vault === null || scope === null || relayer === null) return null;
  const vault = net.vault;
  const sync = over.sync ?? (async () => treesOf(await vaultSync({ vault, rpcs, cursor: vaultSyncStart(vault), lists: ["leaves", "labels"] })));
  const blockNs = over.blockNs ?? (() => lowerFinalTime(rpcs));
  const height = over.height ?? (() => upperFinalHeight(rpcs));
  const relay = over.relay ?? relayWithdraw;
  // `note`: the note the caller picked (the NEAR buy's, withdrawRequest's `note`); none: the request's own pick.
  // `exact`: the request pays the drawn fee (at or above the quote, the relayer takes any fee at or above its fee_min),
  // so a part planned at that fee withdraws exactly what the plan says; else the quote's fee
  // `claim`: a move's claim on its send-by (cash-to-pool.ts), awaited right before the note goes RESERVED
  return async (w, drawnFee, note, exact = false, claim, mark) => {
    if (typeof drawnFee !== "bigint") throw new Error("drawnFee: not a bigint");
    ownPair(n);
    // card near-buy-works-on-live: the quote is asked last, after the trees and the block time, right before the proof;
    // a quote whose window (the helper's FEE_QUOTE_WINDOW_BLOCKS) is about to close when the proof is made is let go
    // before the note goes RESERVED (the note back UNSPENT, nothing sent) and the request is made again on a fresh quote,
    // up to HANDOFF_QUOTE_TRIES times: past the window the helper prices at the fee now and refuses a lower one
    // (fee_too_low), which would hold the note RESERVED until its deadline with nothing paid
    for (let tryNo = 1; ; tryNo++) {
      // the last try's stale quote ends it as a fee end: the note UNSPENT, nothing sent, the fee asked again on a tap
      const end = await once(w, drawnFee, note, exact, claim, mark).catch((e: unknown): HandoffEnd | null => {
        if (!(e instanceof QuoteStale)) throw e;
        return tryNo < HANDOFF_QUOTE_TRIES ? null : { kind: "fee", fee: e.fee };
      });
      if (end !== null) return end;
    }
  };
  async function once(w: CheckedWithdraw, drawnFee: bigint, note: string | undefined, exact: boolean, claim: (() => Promise<void>) | undefined, mark?: HandoffMark): Promise<HandoffEnd> {
    // a caller's mark never stops the hand-off
    const step = (s: Parameters<HandoffMark>[0]): void => {
      try {
        mark?.(s);
      } catch {
        /* the trace only */
      }
    };
    const [trees, ns] = await Promise.all([sync(), blockNs()]);
    const quote = await askWithdrawFee({ token: net.usdc, relayer: relayer!, amount: w.amount, fetchFn });
    if (quote.relayFee > drawnFee) return { kind: "fee", fee: quote.relayFee };
    const notes = await page.notes();
    const seed = await page.seed64();
    let going: Promise<RelayOutcome>;
    // one deadline per tap: the relay's wait and the arrival read after it share HANDOFF_WAIT_MAX_MS
    const signal = waitSignal(page, over);
    // right before RESERVED: the quote still open HANDOFF_QUOTE_MARGIN_BLOCKS past both providers' final heights (the
    // relay's first round and its send), then the caller's own claim
    const fresh = async (): Promise<void> => {
      if ((await height()) + HANDOFF_QUOTE_MARGIN_BLOCKS > quote.validUntilBlock) throw new QuoteStale(quote.relayFee);
      await claim?.();
    };
    try {
      step("proof_start");
      const req = await withdrawRequest({
        seed64: seed,
        notes,
        prover: page.prover,
        vaultId: vault,
        token: net.usdc,
        ...trees,
        registerDepositOf: typedRegisterDepositOf(network, rpcs),
        feeRecipient: quote.feeRecipient,
        relayFee: exact ? drawnFee : quote.relayFee,
        network,
        rpcs,
        priceRpcs,
        amount: w.amount,
        to: w.recipient,
        deadlineMs: withdrawDeadlineMs(ns),
        blockTimestampNanosec: ns,
        // after the typed account's wiring, which wallet-withdraw-move-out reads in the build as it is minified
        ...(note === undefined ? {} : { note }),
        claim: fresh,
      });
      step("proof_done");
      going = relay(seed, req, { notes, network, rpcs, priceRpcs, fetchFn, signal });
      step("relay_sent");
    } finally {
      seed.fill(0);
    }
    const o = await going;
    const kind = await arrivedOf(o, w.recipient, n, over, signal);
    return o.kind === "landed" && typeof o.tx === "string" ? { kind, tx: o.tx } : { kind };
  }
}

/** The tries of one hand-off's request on a fresh quote (withdrawHandoff); past them it ends { kind: "fee" }, the note
 *  UNSPENT and nothing sent. */
export const HANDOFF_QUOTE_TRIES = 3;
/** Blocks the quote must stay open past both providers' final heights when the proof is made: the relay's first round
 *  (the pages, the block time and the fee cap, on the seat) and its send. 30 blocks, about 17 s at mainnet's 0.566 s a
 *  block (224567754 to 224569370 in 915 s, read 14 Nov 21:15Z). The helper's window was 100 blocks then and is 1,200 since
 *  card near-cash-pays-any-amount (apps/helper/src/withdraw/fee.ts FEE_QUOTE_WINDOW_BLOCKS): asked after T, its block at
 *  most 30 s old (the helper's MAX_FINAL_AGE_MS), it outlives the request's last send (deadline_ms -
 *  WITHDRAW_SEND_MARGIN_MS, at most T + 480 s) while NEAR's blocks take 0.43 s or more (1,200 x 0.43 - 30 > 480),
 *  so this check now holds only a tap whose reads and proof outlast the window. A re-quote is made only here, before
 *  RESERVED: a request sent and refused (fee_too_low) stands, and its deadline frees the note (card wallet-withdraw-requote). */
export const HANDOFF_QUOTE_MARGIN_BLOCKS = 30;
/** A quote whose window closes before its request could be sent: the request is made again on a fresh one. */
export class QuoteStale extends Error {
  readonly fee: bigint;
  constructor(fee: bigint) {
    super("the fee quote's window closes before the request could be sent");
    this.name = "QuoteStale";
    this.fee = fee;
  }
}
/** The higher of the two providers' final heights. */
export async function upperFinalHeight(rpcs: readonly [RelayRpc, RelayRpc]): Promise<number> {
  const hs = await Promise.all(
    rpcs.map(async (r) => {
      const a = (await r.block({ finality: "final" })) as { result?: { header?: { height?: unknown } }; error?: unknown } | null;
      const h = a?.error === undefined ? a?.result?.header?.height : undefined;
      if (typeof h !== "number" || !Number.isSafeInteger(h) || h <= 0) throw new Error(`${r.name}: not a final block with its height`);
      return h;
    }),
  );
  return Math.max(...hs);
}

/**
 * The form's run (card cash-withdraws-everything-to-any-chain): the plan's parts in order, one withdrawHandoff each,
 * naming its note at the drawn fee (`exact`). To another chain (w.chain, ./onward.ts) each part's 1Click quote is asked
 * and checked first, its refund under V_{l,j} of the change note the part makes, and the vault pays its deposit address.
 * `step` hears each part start ("sending") and end (its kind, "failed" when it threw). It stops at the first part that
 * does not leave the vault and gives that end; a sign out stops it before the next part. Null where withdrawHandoff is.
 */
export function cashWithdrawRun(page: HandoffPage, over: HandoffOver = {}): ((w: CheckedCashWithdraw, drawnFee: bigint, step?: StepReport) => Promise<HandoffEnd>) | null {
  const one = withdrawHandoff(page, over);
  if (one === null) return null;
  const fetchFn = over.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return async (w, drawnFee, step) => {
    if (!Array.isArray(w.parts) || w.parts.length === 0) throw new Error("parts: no withdrawal planned");
    if (w.parts.reduce((t, p) => t + p.part, 0n) !== w.amount) throw new Error("parts: not the amount");
    const chain = w.chain ?? "near";
    if (chain !== "near" && (!isOnward(chain) || onwardTo(chain, w.recipient) !== w.recipient)) throw new Error("recipient: not an address on the chain");
    let end: HandoffEnd | null = null;
    for (const [i, p] of w.parts.entries()) {
      if (page.signal?.aborted) throw new Error("signed out: the rest stays in Cash");
      step?.(i, "sending");
      try {
        let to = w.recipient;
        if (isOnward(chain)) {
          const req = onwardQuoteRequest(chain, w.recipient, await refundIdOf(page, p.noteId), p.part, Date.now());
          const reply = await askDepositQuoteAgain(req, fetchFn, undefined, undefined, page.signal);
          if (reply.status !== 200) throw new Error(`onward quote: HTTP ${reply.status}`);
          to = checkOnwardQuote(req, reply.body, { chain, to: w.recipient, refundId: req.refundTo, amount: p.part }).depositAddress;
        }
        end = await one({ recipient: to, amount: p.part }, drawnFee, p.noteId, true);
      } catch (e) {
        step?.(i, "failed");
        throw e;
      }
      step?.(i, end.kind);
      if (end.kind !== "arrived" && end.kind !== "landed") return end;
    }
    return end!;
  };
}

/** V_{l,j}: the refund id of the change note a withdrawal of note `id` makes (l its label, j its change index), derived
 *  from the words with the seed zeroed after; its key is zeroed at once, only its id is used. */
async function refundIdOf(page: HandoffPage, id: string): Promise<string> {
  const n = (await (await page.notes()).list()).find((x) => x.id === id);
  if (n?.leaf === undefined) throw new Error("note: not in the store");
  const j = n.ref.kind === "change" ? changeIndex({ kind: "change", j: n.ref.j }) : changeIndex({ kind: "deposit" });
  const seed = await page.seed64();
  try {
    const v = refundId(seed, n.leaf.label, j);
    v.secretKey.fill(0);
    return v.id;
  } finally {
    seed.fill(0);
  }
}

/** What one settle pass did, by note id. */
export type SettlePass = { outcomes: Record<string, RelayOutcome["kind"] | ArrivalOutcome["kind"] | "spent" | "failed"> };

/**
 * The settle pass a page runs on load (modelled on ../../../wallet/src/pool/solana-restore.ts solanaSettleReserved):
 * every RESERVED note of the network's vault scope that holds its request is followed by relayWithdraw, its stored
 * bytes sent again while the relayer's check still takes them: a nullifier spent on both RPCs writes the change note
 * and SPENT (landed), block time on both past its deadline_ms with no spend frees it (expired), a ragequit of it
 * (context 0, no change) leaves it SPENT (spent), and any other spend whose new leaf is not the device's change is a
 * drift: it stays RESERVED and reads "unmatched", as relayWithdraw writes nothing for it. A note whose stored request
 * cannot be read fails alone ("failed"), the others still followed. A HELD note no live tab holds was freed
 * when the note store opened (../../../wallet/src/notes/store.ts settle: its tab lock is gone). One that cannot be
 * settled now (no answer, sign out, the wait's bound) stays RESERVED for the next pass.
 */
export async function withdrawSettle(page: HandoffPage, over: HandoffOver = {}): Promise<SettlePass> {
  const n = netOf(over);
  const { network, net, rpcs, priceRpcs, scope, fetchFn } = n;
  const out: SettlePass = { outcomes: {} };
  if (net.vault === null || scope === null) return out;
  ownPair(n);
  const relay = over.relay ?? relayWithdraw;
  const notes = await page.notes();
  const due = (await notes.list()).filter((n) => n.state === "RESERVED" && n.scope === scope && n.request !== undefined);
  if (due.length === 0) return out;
  const seed = await page.seed64();
  const going: [string, Promise<RelayOutcome>][] = [];
  const typed = new Map<string, string>(); // note id -> the typed account a stored request pays straight
  const signals = new Map<string, AbortSignal>(); // note id -> its one deadline, shared by its relay and its arrival
  try {
    for (const n of due) {
      // one note's bad stored request (or a relay that throws at once) fails that note alone; the pass goes on
      try {
        const req = storedRequest(n);
        if (req.body.fund_recipient === false) typed.set(n.id, req.recipient);
        const signal = waitSignal(page, over);
        signals.set(n.id, signal);
        going.push([n.id, relay(seed, req, { notes, network, rpcs, priceRpcs, fetchFn, signal })]);
      } catch (e) {
        going.push([n.id, Promise.reject(e)]);
      }
    }
  } finally {
    seed.fill(0);
  }
  // each note is followed from its own relay to its own arrival, all at once, each under its own deadline: a note held
  // to its bound never cuts another note's arrival (review of a6903d91, N1). Each is awaited at once with a handler,
  // so a later note's refusal is never unhandled while an earlier one waits.
  const settled = going.map(async ([id, p]): Promise<SettlePass["outcomes"][string]> => {
    try {
      const o = await p;
      // a spend whose new leaf is not this seed's change: only a ragequit (context 0, vault.md l.99) inserts no change,
      // so that alone is SPENT here; any other is a drift (relay.ts writes nothing, restore.ts stops): it stays
      // RESERVED, "unmatched" for the form to show, never dropped
      if (o.kind === "unmatched" && o.spend.context === 0n) {
        await notes.move(id, "RESERVED", "SPENT");
        return "spent";
      }
      return typed.get(id) === undefined ? o.kind : await arrivedOf(o, typed.get(id)!, n, over, signals.get(id)!);
    } catch {
      return "failed";
    }
  });
  const ends = await Promise.all(settled);
  going.forEach(([id], i) => (out.outcomes[id] = ends[i]!));
  return out;
}

/**
 * After a landing of a withdrawal that pays the typed account straight: what the spend row says of the payout to that
 * account (../../../wallet/src/withdraw/arrival.ts: paid to it, refunded, or paid elsewhere). An own landing is followed
 * on the pair until its payout has run, under the same deadline as its relay (`signal`); a landing by another attempt of
 * these words (another device, own false) ends on the row already read, so one paid to another account reads
 * "elsewhere". The relay's kind otherwise. A wait cut short (sign out, the bound, a read that never settles), or a row
 * still in flight, ends "landed": nothing is sent or signed after the relay, so a rerun has nothing to send again.
 */
async function arrivedOf(o: RelayOutcome, recipient: string, n: Net, over: HandoffOver, signal: AbortSignal): Promise<RelayOutcome["kind"] | ArrivalOutcome["kind"]> {
  if (o.kind !== "landed") return o.kind;
  if (!o.own) return arrivalOf(o.spend, recipient)?.kind ?? "landed";
  try {
    const a = await (over.arrival ?? withdrawArrival)({ network: n.network, rpcs: over.arrivalRpcs ?? n.rpcs, nullifierHash: o.spend.nullifierHash, recipient, signal });
    return a.kind;
  } catch {
    return "landed";
  }
}

// A RESERVED note's request as withdrawRequest made it: its body as stored, the change and refund refs of its label.
function storedRequest(n: NoteRecord): WithdrawRequest {
  const body = JSON.parse(n.request!) as WithdrawRequest["body"];
  const l = n.leaf!.label;
  const j = n.ref.kind === "change" ? changeIndex({ kind: "change", j: n.ref.j }) : changeIndex({ kind: "deposit" });
  const withdrawn = BigInt(body.public_signals[2]); // withdrawnValue (the kit's VAULT_WITHDRAW_SIGNALS order)
  return {
    body,
    noteId: n.id,
    recipient: body.withdrawal.recipient,
    change: { kind: "change", l, j },
    refund: { kind: "refund", l, j },
    changeValue: n.leaf!.value - withdrawn,
  };
}

const NS = /^(0|[1-9][0-9]{0,19})$/;
/** T: the lower of the pair's final block times (header.timestamp_nanosec), refused when they differ by over 60 s. */
export async function lowerFinalTime(rpcs: readonly [RelayRpc, RelayRpc]): Promise<string> {
  const times = await Promise.all(
    rpcs.map(async (r) => {
      const a = (await r.block({ finality: "final" })) as { result?: { header?: { timestamp_nanosec?: unknown } }; error?: unknown } | null;
      const t = a?.error === undefined ? a?.result?.header?.timestamp_nanosec : undefined;
      if (typeof t !== "string" || !NS.test(t)) throw new Error(`${r.name}: not a final block with its time`);
      return BigInt(t);
    }),
  );
  const [a, b] = times as [bigint, bigint];
  const gap = a > b ? a - b : b - a;
  if (gap > BigInt(BLOCK_TIME_SPREAD_MAX_MS) * 1_000_000n) throw new Error("the two RPCs' final block times differ by over 60 s");
  return (a < b ? a : b).toString();
}
