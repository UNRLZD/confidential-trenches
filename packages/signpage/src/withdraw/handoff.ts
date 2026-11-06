// The withdraw form's reads and its hand-off to the wallet's withdraw path (card signpage-withdraw-handoff; wallet.md
// §2.8 the withdraw.open row W:927 and the arming row W:915, §2.5 step 5 W:650; VT-T02's withdraw leg, run in a script
// page until this card: contracts/vault/scripts/testnet-t02.ts).
//
// - The network is the build's (PAGE_NETWORK): mainnet on SIGN_HOST's build, testnet on the testnet build
//   (packages/signpage/scripts/build-app.mjs folds __SIGN_NETWORK__, ../../../wallet/src/pool/network.ts reads it).
//   Every read and the hand-off use that network's release pair only, and the vault and the relayer are that network's
//   release values (NEAR_NETWORKS, RELEASE_WITHDRAW_RELAYER), never an argument: one network per build.
// - available: the largest UNSPENT note of the network's vault scope in this device's note store (./checks.ts
//   withdrawable). No vault named on the network: no note can be in it, 0.
// - fee: the release relayer's quote (GET /v1/withdraw/fee, askWithdrawFee: its answer checked against the release's
//   relayer, byte for byte), refused when above the device's own fee_max (../../../wallet/src/withdraw/feemax.ts, LD5 on
//   the device's own reads), taken at the largest register_deposit any A can need (the token's storage minimum,
//   readTokenStorageMin), so the form names no A before a note is picked. A refusal leaves the fee unread (Busy · Retry).
// - The hand-off (only where the network names a vault and a relayer): the relayer's quote again for the typed amount,
//   the vault's two trees read by the kit's vaultSync on the pair at one block, T the lower of the pair's final block
//   times (agreeing within 60 s, W:650), then the wallet's withdrawRequest (the kit's request and circuit input, this
//   page's prover worker, the picked note's own A and its register_deposit, fee_max bound again) and relayWithdraw
//   (POST /v1/withdraw, followed on the vault's pages to the outcome: landed, expired or unmatched). The seed is opened
//   for it and zeroed after.
// - The wallet's withdraw path pays the note's arming account A_{l,j} (request.ts: the kit makes every withdrawal's
//   recipient A, W:671). The move from A to the typed account (the plain move out row, W:929) is not on this page yet:
//   the typed recipient is checked and kept by the form, not paid by this hand-off.
// Nothing here logs.
import type { HelperReleaseRelayer } from "../../../kit/src/helper/v1.ts";
import type { VaultProver } from "../../../kit/src/prover/prove.ts";
import { VaultTree } from "../../../kit/src/vault/inputs.ts";
import { vaultSync, vaultSyncStart } from "../../../kit/src/vault/sync.ts";
import { NEAR_NETWORKS, type NearNetwork, nearRpc } from "../../../kit/src/near/networks.ts";
import { armingRegisterDepositOf, readTokenStorageMin } from "../../../wallet/src/arming/accounts.ts";
import { readNotes, type NoteStore } from "../../../wallet/src/notes/store.ts";
import { POOL_TESTNET } from "../../../wallet/src/pool/network.ts";
import { readWithdrawFeeMax } from "../../../wallet/src/withdraw/feemax.ts";
import { askWithdrawFee, RELEASE_WITHDRAW_RELAYER, type RelayDeps, type RelayOutcome, relayRpc, type RelayRpc, relayWithdraw } from "../../../wallet/src/withdraw/relay.ts";
import { withdrawDeadlineMs, withdrawRequest, type WithdrawRequest } from "../../../wallet/src/withdraw/request.ts";
import type { WalletStore } from "../../../wallet/src/store/index.ts";
import { vaultScope, withdrawable } from "./checks.ts";
import type { CheckedWithdraw, WithdrawFormDeps } from "./form.ts";

/** The network this build of the page runs on: the build's, mainnet unless it is the testnet build. */
export const PAGE_NETWORK: NearNetwork = POOL_TESTNET ? "testnet" : "mainnet";

/** The most the pair's two final block times may differ before no proof is made (W:650). */
export const BLOCK_TIME_SPREAD_MAX_MS = 60_000;

/** What the page gives the form: its store, the seed and its one prover, each opened when a read or the hand-off needs it. */
export type HandoffPage = {
  store(): Promise<WalletStore>;
  notes(): Promise<NoteStore>;
  seed64(): Promise<Uint8Array>;
  prover: VaultProver;
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
};

const pairOf = (network: NearNetwork): readonly [RelayRpc, RelayRpc] => {
  const net = NEAR_NETWORKS[network];
  return [relayRpc(net.fastnear[0]), relayRpc(net.drpc)];
};

/** The form's reads and hand-off on the build's network. */
export function withdrawFormDeps(page: HandoffPage, over: HandoffOver = {}): WithdrawFormDeps {
  const network = over.network ?? PAGE_NETWORK;
  const net = NEAR_NETWORKS[network];
  const rpcs = over.rpcs ?? pairOf(network);
  const priceRpcs = over.priceRpcs ?? (network === "mainnet" ? rpcs : pairOf("mainnet"));
  const relayer: HelperReleaseRelayer | null = RELEASE_WITHDRAW_RELAYER[network];
  const scope = vaultScope(network);
  const fetchFn = over.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const available = async (): Promise<bigint> => (scope === null ? 0n : withdrawable(await readNotes(await page.store()), scope));
  const deps: WithdrawFormDeps = {
    network,
    rpcs: over.rpcs ?? [nearRpc(net.fastnear[0]), nearRpc(net.drpc)],
    available,
    async fee() {
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
  if (net.vault === null || scope === null || relayer === null) return deps;
  const vault = net.vault;
  const sync = over.sync ?? (async () => {
    const s = await vaultSync({ vault, rpcs, cursor: vaultSyncStart(vault), lists: ["leaves", "labels"] });
    const stateTree = new VaultTree(s.leaves);
    const labelTree = new VaultTree(s.labels);
    if (stateTree.root !== s.stateTree.root || labelTree.root !== s.labelTree.root) throw new Error("the synced trees' roots are not the vault's");
    return { stateTree, labelTree, newestStateRoot: s.stateTree.root, newestLabelRoot: s.labelTree.root };
  });
  const blockNs = over.blockNs ?? (() => lowerFinalTime(rpcs));
  const relay = over.relay ?? relayWithdraw;
  return {
    ...deps,
    async handoff(w: CheckedWithdraw): Promise<RelayOutcome["kind"]> {
      const quote = await askWithdrawFee({ token: net.usdc, relayer, amount: w.amount, fetchFn });
      const [trees, ns] = await Promise.all([sync(), blockNs()]);
      const notes = await page.notes();
      const seed = await page.seed64();
      try {
        const req = await withdrawRequest({
          seed64: seed,
          notes,
          prover: page.prover,
          vaultId: vault,
          token: net.usdc,
          ...trees,
          registerDepositOf: armingRegisterDepositOf(network, rpcs),
          feeRecipient: quote.feeRecipient,
          relayFee: quote.relayFee,
          network,
          rpcs,
          priceRpcs,
          amount: w.amount,
          deadlineMs: withdrawDeadlineMs(ns),
          blockTimestampNanosec: ns,
        });
        return (await relay(seed, req, { notes, network, rpcs, priceRpcs, fetchFn })).kind;
      } finally {
        seed.fill(0);
      }
    },
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
