// The NEAR vault's exit (card exit-with-only-the-words): every note of the 12 words in the release's vault, withdrawn
// to the NEAR account the user typed, each by its own one-use account A_{l,j} of the words, with no server of ours.
//
// - The read: the wallet's own restore (./scan.ts exitScanSeed) on the two public RPCs ctx.rpcs names, which must be
//   the release's pair on one network (mainnet unless the pair is testnet's): every read equal on both.
// - The fees: each A pays its own withdraw, settle and DeleteAccount gas, so A is the words' fee wallet for its note.
//   Before a note's withdrawal the command reads A on both RPCs and, while A holds less than nearNeed, says A's address
//   and the amount, then waits (./fund.ts). A's DeleteAccount sends what is left of it to the typed account.
// - The proof: snarkjs on the setup files, each checked against the kit's sha256 pin (./setup.ts) before use.
// - The order, the checks and the resume are ./withdraw.ts's (exitWithdrawOne, exitCloseOne): a spend of ours already
//   paid or refund_pending is settled and its A closed first; then each UNSPENT note, one at a time.
import { vaultWithdrawYocto, VAULT_WITHDRAW, VaultTree, nearPairNetwork, type NearNetwork, type VaultProver, type VaultSyncRpc } from "@blindfill/kit";
import { moveOutRpc, readSettle, settleNeed, type MoveOutRpc, type RestoredNote } from "@blindfill/kit/core";
import type { ExitChain, ExitCtx, ExitResult } from "./chain.ts";
import { fundedOrWait, units } from "./fund.ts";
import { exitAccountAt, exitKey, exitReadStorage, exitRecipient, type ExitRecipient } from "./out.ts";
import { exitReadPages, exitRpc, ExitRpcRefused, EXIT_NETWORKS } from "./rpc.ts";
import { exitScanSeed } from "./scan.ts";
import { exitProver } from "./prover.ts";
import { exitBuildWithdraw, exitCloseOne, exitReadDelete, exitWithdrawIndex, exitWithdrawOne, type ExitSent, type ExitSigned, type ExitWithdrawSteps } from "./withdraw.ts";

const TGAS = 10n ** 12n;
/** nearcore charges prepaid gas at its pessimistic price: the wallet's own margin over the price read (packages/wallet/src/deposit/moveout.ts GAS_PRICE_MARGIN). */
const GAS_PRICE_MARGIN = 12n;
/** What an implicit account with one key keeps locked for its storage, with room: 0.01 NEAR. */
const ACCOUNT_KEEP = 10n ** 22n;
/** The withdraw's send gas on top of the call's (the wallet's MOVE_GAS.send). */
const SEND_GAS = 5n * TGAS;
/** Between two reads of a tx's outcome, and how many reads before it is unread. */
const TX_POLL_MS = 2_000;
const TX_POLLS = 60;
/** The wallet's deadline: block time + 10 min less a random 0-65 s (packages/wallet/src/withdraw/request.ts withdrawDeadlineMs). */
const DEADLINE_MS = 600_000;

/**
 * What A must hold before its note's withdrawal: the withdraw's 300 Tgas and its send at the gas price read times the
 * wallet's margin, the withdraw's attachment (registration of the typed account when due, a tree that may grow), a
 * settle with its refund note attached (the worst case: a payout the token refused), and its account's storage.
 */
export function nearNeed(gasPrice: bigint, registerDeposit: bigint): bigint {
  const withdraw = (BigInt(VAULT_WITHDRAW.gas_tgas) * TGAS + SEND_GAS) * gasPrice * GAS_PRICE_MARGIN + vaultWithdrawYocto(registerDeposit, 0n, true);
  return withdraw + settleNeed({ gasPrice }, "refund_pending") + ACCOUNT_KEEP;
}

/** Tests only: the reads and sends nearExit makes, given. The command gives none. */
export type NearExitOver = {
  rpcs?: readonly [VaultSyncRpc, VaultSyncRpc];
  moveRpcs?: readonly [MoveOutRpc, MoveOutRpc];
  prover?: VaultProver;
  sleep?: (ms: number) => Promise<void>;
};

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const realSleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** The lower final block of both RPCs, with its time in ms, or null. */
async function finalBlock(m: readonly [MoveOutRpc, MoveOutRpc]): Promise<{ height: number; ms: number } | null> {
  const heads = await Promise.all(m.map((r) => r.block({ finality: "final" }).catch(() => null)));
  const hs = heads.map((b) => (isObj(b) && isObj(b.result) && isObj(b.result.header) ? b.result.header : null));
  if (hs.some((h) => h === null || typeof h.height !== "number" || typeof h.timestamp_nanosec !== "string")) return null;
  const low = hs[0]!.height! <= hs[1]!.height! ? hs[0]! : hs[1]!;
  return { height: low.height as number, ms: Number(BigInt(low.timestamp_nanosec as string) / 1_000_000n) };
}

/** The gas price at the final block on both RPCs: the higher of the two. */
async function gasPrice(m: readonly [MoveOutRpc, MoveOutRpc]): Promise<bigint> {
  const prices = await Promise.all(m.map(async (r) => {
    const a = await r.call("gas_price", [null]);
    const p = isObj(a) && isObj(a.result) ? a.result.gas_price : undefined;
    if (typeof p !== "string" || !/^[1-9][0-9]*$/.test(p)) throw new Error("no gas price");
    return BigInt(p);
  }));
  return prices[0]! > prices[1]! ? prices[0]! : prices[1]!;
}

/** A's NEAR on both RPCs, the lower: 0 when both read it absent; a throw when they cannot be read the same way. */
async function nearBalance(m: readonly [MoveOutRpc, MoveOutRpc], account: string): Promise<bigint> {
  const each = await Promise.all(m.map(async (r) => {
    const a = await r.call("query", { request_type: "view_account", account_id: account, finality: "final" });
    if (isObj(a) && isObj(a.result) && typeof a.result.amount === "string") return BigInt(a.result.amount);
    const err = isObj(a) ? (a.error as Obj | undefined) : undefined;
    if (isObj(err) && isObj(err.cause) && err.cause.name === "UNKNOWN_ACCOUNT") return 0n;
    throw new Error(`${r.name ?? "an RPC"}: no answer for ${account}`);
  }));
  return each[0]! < each[1]! ? each[0]! : each[1]!;
}

/** A's tx, sent once through the first RPC, then read on both: FINAL with every receipt a success, or failed, or unread. */
async function sendOnce(m: readonly [MoveOutRpc, MoveOutRpc], signer: string, s: ExitSigned, sleep: (ms: number) => Promise<void>): Promise<ExitSent> {
  await m[0].call("send_tx", { signed_tx_base64: s.signed, wait_until: "NONE" }).catch(() => null);
  for (let k = 0; k < TX_POLLS; k++) {
    const sides = await Promise.all(m.map((r) => r.call("tx", { tx_hash: s.hash, sender_account_id: signer, wait_until: "NONE" }).then((a) => (isObj(a) && isObj(a.result) ? a.result : null), () => null)));
    if (sides.every((r) => r !== null && r.final_execution_status === "FINAL")) {
      const failed = sides.some((r) => [r!.status, ...((r!.receipts_outcome as Obj[] | undefined) ?? []).map((o) => (isObj(o.outcome) ? o.outcome.status : undefined))].some((st) => isObj(st) && "Failure" in st));
      return failed ? "failed" : "ok";
    }
    await sleep(TX_POLL_MS);
  }
  return "unread";
}

/** The trees of a full read of the vault, refused unless their roots are the vault's own at that block. */
function treesOf(s: { leaves: readonly bigint[]; labels: readonly bigint[]; stateTree: { root: bigint }; labelTree: { root: bigint } }) {
  const stateTree = new VaultTree([...s.leaves]);
  const labelTree = new VaultTree([...s.labels]);
  if (stateTree.root !== s.stateTree.root || labelTree.root !== s.labelTree.root) throw new Error("the read trees' roots are not the vault's");
  return { stateTree, labelTree, newestStateRoot: s.stateTree.root, newestLabelRoot: s.labelTree.root };
}

/** The NEAR vault's ExitChain, with the tests' reads when given. */
export function nearExitWith(over: NearExitOver = {}): ExitChain {
  return async (ctx: ExitCtx): Promise<ExitResult> => {
    const sleep = over.sleep ?? realSleep;
    const vrpcs = over.rpcs ?? ([exitRpc(ctx.rpcs[0]), exitRpc(ctx.rpcs[1])] as const);
    const mrpcs = over.moveRpcs ?? ([moveOutRpc(ctx.rpcs[0]), moveOutRpc(ctx.rpcs[1])] as const);
    const network = nearPairNetwork(vrpcs) as NearNetwork | null;
    if (network === null || nearPairNetwork(mrpcs) !== network) throw new ExitRpcRefused(`the two NEAR RPCs are a release pair: ${Object.values(EXIT_NETWORKS).map((n) => n.rpcs.join(" and ")).join(", or ")}`);
    const checked = await exitRecipient(ctx.to, network, vrpcs, sleep);
    if (!checked.ok) throw new ExitRpcRefused(`the NEAR account ${JSON.stringify(ctx.to)} is refused (${checked.code})`);
    const to: ExitRecipient = checked.recipient;
    ctx.say(`reading the vault ${EXIT_NETWORKS[network].vault} on ${network}`);
    const scan = await exitScanSeed(ctx.seed, network, vrpcs);
    const notes = scan.notes.filter((n: RestoredNote) => n.state === "UNSPENT");
    const left = notes.reduce((s, n) => s + n.leaf.value, 0n);
    ctx.say(`${notes.length} note(s) to withdraw, ${units(left, 6)} USDC; ${scan.spends.length} spend(s) of ours read`);
    const txs: string[] = [];
    const steps = (signer: string): Omit<ExitWithdrawSteps, "withdraw"> => ({
      send: (s) => sendOnce(mrpcs, signer, s, sleep),
      record: async (r) => ctx.say(`${r.step} tx ${r.hash}`),
      spend: async (nh) => (await exitReadPages({ network, rpcs: vrpcs, lists: ["spends"] })).spends.find((x) => x.nullifierHash === nh) ?? null,
      account: async (aId) => {
        const b = await finalBlock(mrpcs);
        return b === null ? "unread" : exitAccountAt(vrpcs, aId, b.height, sleep);
      },
      readA: (aId) => readSettle(aId, mrpcs),
      readDelete: (aId, spendIndex, nullifierHash, kept) => exitReadDelete({ network, aId, to, spendIndex, nullifierHash, txs: kept, rpcs: vrpcs, moveRpcs: mrpcs }),
      head: async () => (await finalBlock(mrpcs))?.height ?? null,
      sleep,
    });
    const aOf = (l: bigint, j: number) => {
      const k = exitKey(ctx.seed, { kind: "A", l, j });
      k.secretKey.fill(0);
      return k.id;
    };
    let stopped: string | null = null;
    // the resume: a spend of ours paid or refund_pending is settled, and its A closed, before any new withdrawal
    for (const s of scan.spends) {
      if (s.spend.status !== "paid" && s.spend.status !== "refund_pending") continue;
      const aId = aOf(s.l, s.j);
      const fee = settleNeed({ gasPrice: await gasPrice(mrpcs) }, s.spend.status);
      await fundedOrWait({ address: aId, need: fee, unit: { symbol: "NEAR", decimals: 24 }, balance: () => nearBalance(mrpcs, aId), say: ctx.say, sleep });
      const out = await exitCloseOne({ seed64: ctx.seed, network, to, l: s.l, j: s.j, nullifierHash: s.spend.nullifierHash, steps: steps(aId) });
      txs.push(...out.txs);
      if (out.stage !== "closed") stopped ??= `${out.stage}: ${out.why}`;
    }
    let sent = 0n;
    for (const note of notes) {
      const { l, j } = exitWithdrawIndex(note);
      const aId = aOf(l, j);
      const storage = await exitReadStorage(network, to, vrpcs, sleep);
      const need = nearNeed(await gasPrice(mrpcs), storage.registered ? 0n : storage.storageMin);
      await fundedOrWait({ address: aId, need, unit: { symbol: "NEAR", decimals: 24 }, balance: () => nearBalance(mrpcs, aId), say: ctx.say, sleep });
      const prover = over.prover ?? (await exitProver());
      const out = await exitWithdrawOne({
        seed64: ctx.seed,
        network,
        to,
        steps: {
          ...steps(aId),
          withdraw: async () => {
            const pages = await exitReadPages({ network, rpcs: vrpcs });
            const read = await readSettle(aId, mrpcs);
            const block = await finalBlock(mrpcs);
            if (read === null || block === null) throw new Error(`A ${aId} is not read the same on both RPCs`);
            const rand = globalThis.crypto.getRandomValues(new Uint16Array(1))[0]!;
            ctx.say(`proving the withdrawal of ${units(note.leaf.value, 6)} USDC`);
            return exitBuildWithdraw({ seed64: ctx.seed, network, note, to, prover, ...treesOf(pages), storage, nowMs: block.ms, deadlineMs: block.ms + DEADLINE_MS - rand, read });
          },
        },
      });
      txs.push(...out.txs);
      if (out.stage === "closed" && !out.refund) sent += note.leaf.value;
      else if (out.stage !== "closed") {
        stopped = `${out.stage}: ${out.why}`;
        break;
      }
    }
    if (stopped !== null) throw new Error(`${stopped} (txs so far: ${txs.join(" ") || "none"}); run the exit again to go on`);
    return { chain: "near", txs, sent: sent.toString(), left: (left - sent).toString() };
  };
}

/** The NEAR vault's ExitChain. */
export const nearExit: ExitChain = nearExitWith();
