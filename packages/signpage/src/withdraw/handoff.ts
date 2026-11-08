// The withdraw form's reads and its hand-off to the wallet's withdraw path (card signpage-withdraw-handoff; wallet.md
// §2.8 the withdraw.open row W:927 and the arming row W:915, §2.5 step 5 W:650; VT-T02's withdraw leg, run in a script
// page until this card: contracts/vault/scripts/testnet-t02.ts).
//
// - The network is the build's (PAGE_NETWORK): mainnet on SIGN_HOST's build, testnet on the testnet build
//   (packages/signpage/scripts/build-app.mjs folds __SIGN_NETWORK__, ../../../wallet/src/pool/network.ts reads it).
//   Every read and the hand-off use that network's release pair only (any other pair is refused before a read), and the vault and the relayer are that network's
//   release values (NEAR_NETWORKS, RELEASE_WITHDRAW_RELAYER), never an argument: one network per build.
// - available: the largest UNSPENT note of the network's vault scope in this device's note store (./checks.ts
//   withdrawable). No vault named on the network: no note can be in it, 0.
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
// - withdrawSettle, on every load: the RESERVED notes a closed page left are followed to settled from their stored
//   request (landed, expired, or SPENT on a spend whose change is not the device's); a HELD one no live tab holds the
//   note store frees when it opens.
// Nothing here logs.
import type { HelperReleaseRelayer } from "../../../kit/src/helper/v1.ts";
import type { VaultProver } from "../../../kit/src/prover/prove.ts";
import { VaultTree } from "../../../kit/src/vault/inputs.ts";
import { vaultSync, vaultSyncStart } from "../../../kit/src/vault/sync.ts";
import { NEAR_NETWORKS, type NearNetwork, nearPairNetwork, nearPairRule, nearRpc } from "../../../kit/src/near/networks.ts";
import { readTokenStorageMin, typedRegisterDepositOf } from "../../../wallet/src/arming/accounts.ts";
import { arrivalOf, type ArrivalOutcome, withdrawArrival } from "../../../wallet/src/withdraw/arrival.ts";
import { changeIndex } from "../../../wallet/src/derive/index.ts";
import { readNotes, type NoteRecord, type NoteStore } from "../../../wallet/src/notes/store.ts";
import { POOL_TESTNET } from "../../../wallet/src/pool/network.ts";
import { readWithdrawFeeMax } from "../../../wallet/src/withdraw/feemax.ts";
import { askWithdrawFee, RELEASE_WITHDRAW_RELAYER, type RelayDeps, type RelayOutcome, relayRpc, type RelayRpc, relayWithdraw } from "../../../wallet/src/withdraw/relay.ts";
import { WITHDRAW_DEADLINE_MAX_MS, withdrawDeadlineMs, withdrawRequest, type WithdrawRequest } from "../../../wallet/src/withdraw/request.ts";
import type { WalletStore } from "../../../wallet/src/store/index.ts";
import { vaultScope, withdrawable } from "./checks.ts";
import type { CheckedWithdraw, WithdrawFormDeps } from "./form.ts";

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
  rpcs?: readonly [RelayRpc, RelayRpc];
  priceRpcs?: readonly [RelayRpc, RelayRpc];
  fetchFn?: typeof fetch;
  /** The trees and the block time (the pair's own reads otherwise). */
  sync?: () => Promise<{ stateTree: VaultTree; labelTree: VaultTree; newestStateRoot: bigint; newestLabelRoot: bigint }>;
  blockNs?: () => Promise<string>;
  /** relayWithdraw otherwise. */
  relay?: (seed64: Uint8Array, req: WithdrawRequest, deps: RelayDeps) => Promise<RelayOutcome>;
  /** HANDOFF_WAIT_MAX_MS otherwise. */
  waitMs?: number;
  /** withdrawArrival otherwise. */
  arrival?: typeof withdrawArrival;
  /** The pair the arrival is read on (rpcs otherwise). */
  arrivalRpcs?: readonly [RelayRpc, RelayRpc];
};

/** What a tap's hand-off ends in: the relay's outcome, or a fresh quote above the fee the form drew (nothing proved). */
export type HandoffEnd = { kind: RelayOutcome["kind"] | ArrivalOutcome["kind"] } | { kind: "fee"; fee: bigint };

const pairOf = (network: NearNetwork): readonly [RelayRpc, RelayRpc] => {
  const net = NEAR_NETWORKS[network];
  return [relayRpc(net.fastnear[0]), relayRpc(net.drpc)];
};

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
 * The form's reads on the build's network, and the hand-off wherever the release names a vault and a relayer
 * (withdrawHandoff; elsewhere none, and Withdraw is drawn pending, ./form.ts data-pending).
 */
export function withdrawFormDeps(page: HandoffPage, over: HandoffOver = {}): WithdrawFormDeps {
  const n = netOf(over);
  const { network, net, rpcs, priceRpcs, relayer, scope, fetchFn } = n;
  const available = async (): Promise<bigint> => (scope === null ? 0n : withdrawable(await readNotes(await page.store()), scope));
  const handoff = withdrawHandoff(page, over);
  return {
    ...(handoff === null ? {} : { handoff }),
    network,
    rpcs: over.rpcs ?? [nearRpc(net.fastnear[0]), nearRpc(net.drpc)],
    available,
    async fee() {
      ownPair(n);
      if (relayer === null) throw new Error(`the release names no withdrawal relayer on ${network}`);
      // the quote is asked for the most one withdrawal can carry: askWithdrawFee refuses a fee at or above it
      const most = await available();
      const [quote, cap] = await Promise.all([
        askWithdrawFee({ token: net.usdc, relayer, amount: most, fetchFn }),
        readTokenStorageMin(network, rpcs).then((registerDeposit) => readWithdrawFeeMax({ network, rpcs, priceRpcs, registerDeposit })),
      ]);
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
export function withdrawHandoff(page: HandoffPage, over: HandoffOver = {}): ((w: CheckedWithdraw, drawnFee: bigint) => Promise<HandoffEnd>) | null {
  const n = netOf(over);
  const { network, net, rpcs, priceRpcs, relayer, scope, fetchFn } = n;
  if (net.vault === null || scope === null || relayer === null) return null;
  const vault = net.vault;
  const sync = over.sync ?? (async () => treesOf(await vaultSync({ vault, rpcs, cursor: vaultSyncStart(vault), lists: ["leaves", "labels"] })));
  const blockNs = over.blockNs ?? (() => lowerFinalTime(rpcs));
  const relay = over.relay ?? relayWithdraw;
  return async (w, drawnFee) => {
    if (typeof drawnFee !== "bigint") throw new Error("drawnFee: not a bigint");
    ownPair(n);
    const quote = await askWithdrawFee({ token: net.usdc, relayer, amount: w.amount, fetchFn });
    if (quote.relayFee > drawnFee) return { kind: "fee", fee: quote.relayFee };
    const [trees, ns] = await Promise.all([sync(), blockNs()]);
    const notes = await page.notes();
    const seed = await page.seed64();
    let going: Promise<RelayOutcome>;
    // one deadline per tap: the relay's wait and the arrival read after it share HANDOFF_WAIT_MAX_MS
    const signal = waitSignal(page, over);
    try {
      const req = await withdrawRequest({
        seed64: seed,
        notes,
        prover: page.prover,
        vaultId: vault,
        token: net.usdc,
        ...trees,
        registerDepositOf: typedRegisterDepositOf(network, rpcs),
        feeRecipient: quote.feeRecipient,
        relayFee: quote.relayFee,
        network,
        rpcs,
        priceRpcs,
        amount: w.amount,
        to: w.recipient,
        deadlineMs: withdrawDeadlineMs(ns),
        blockTimestampNanosec: ns,
      });
      going = relay(seed, req, { notes, network, rpcs, priceRpcs, fetchFn, signal });
    } finally {
      seed.fill(0);
    }
    return { kind: await arrivedOf(await going, w.recipient, n, over, signal) };
  };
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
  // each is awaited in turn below: a later note's refusal waits for its turn with a handler, never unhandled meanwhile
  for (const [, p] of going) p.catch(() => {});
  for (const [id, p] of going) {
    try {
      const o = await p;
      // a spend whose new leaf is not this seed's change: only a ragequit (context 0, vault.md l.99) inserts no change,
      // so that alone is SPENT here; any other is a drift (relay.ts writes nothing, restore.ts stops): it stays
      // RESERVED, "unmatched" for the form to show, never dropped
      if (o.kind === "unmatched" && o.spend.context === 0n) {
        await notes.move(id, "RESERVED", "SPENT");
        out.outcomes[id] = "spent";
      } else out.outcomes[id] = typed.get(id) === undefined ? o.kind : await arrivedOf(o, typed.get(id)!, n, over, signals.get(id)!);
    } catch {
      out.outcomes[id] = "failed";
    }
  }
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
