// The exit tool's way out of the Base and Robinhood pools with only the 12 words and public RPCs (Blindfill v2 lite
// paper §5: "any other sender, or the phone itself, can send"). No server of ours is in the path: the helper's sender,
// which the app's withdraw uses (packages/signpage/src/pool-withdraw-evm.ts), is replaced by a gas wallet of the words.
//
// - The pool: the pin the wallet holds for the chain (EVM_POOLS, held equal to contracts/pool-evm/deployments/<chain>.json
//   by test/evm-out.test.ts), its deploy block where the scan starts.
// - The notes: the wallet's own restore (evmRestoreNotes, `wallets: false`): every leaf event of the pool from its deploy
//   block, on the two RPCs, which must agree byte for byte and make the pool's own roots and sizes; each RPC pages
//   eth_getLogs on its own and narrows a page any provider refuses (a 5,500 or 10,001 block cap included) down to one
//   block. No read names a note.
// - Each UNSPENT note leaves in two transactions, as the app's withdraw does. The release (PrivacyPool.withdraw): the
//   pool pays only a recipient that signed it (PrivacyPool.sol:181), so the recipient is the note's W_{evm, l, j}, the
//   note's whole value at fee 0, proved against the newest roots both RPCs agree on, signed by W, and sent by the gas
//   wallet G, which pays its gas. Then W sends what it holds less its own gas to the typed address. A W a spend of the
//   restore names (an earlier release whose onward send never ran) is swept the same way.
// - The keys stay in the wallet: every signature is the wallet's (packages/wallet/src/pool/evm-exit.ts, through the
//   kit's ./core), which derives its own key from the seed and signs only the shapes it checks. This file holds none.
// - G is the words' first EVM account at m/44'/60'/0'/0/0, the one any EVM wallet shows for these words, so the user
//   can fund it there. When G holds less than a release's gas bound, the tool prints G's address and the amount, and
//   stops this chain: the notes left stay in the pool for the next run.
// - The prover is the command's (a VaultProver: snarkjs on the hash-checked setup files of src/setup.ts), given once
//   with exitEvmProver; the kit's poolProveWithdraw holds its answer to the input's public signals.
// - Every read is on both RPCs and must agree; a transaction counts only once both read its receipt in one block.
// - sent and left are wei, decimal.
import {
  EVM_CHAIN_IDS,
  EVM_POOLS,
  evmExitGasAddress,
  evmExitSignSend,
  evmExitW,
  evmExitWithdrawCalldata,
  evmExitWithdrawSignature,
  evmMemoryHold,
  evmPoolContextOf,
  evmPoolScopeOf,
  evmRestoreNotes,
  evmTreeSync,
  jOf,
  noteSecrets,
  type EvmPoolPin,
  type EvmRelayData,
  type EvmRestoredNote,
  type EvmRpc,
} from "@blindfill/kit/core";
import { evmPoolChainFee, evmPoolChainFeeReads, poolProveWithdraw, solanaJsonRpc, solanaSameProvider, type VaultProver } from "@blindfill/kit";
import type { ExitChain, ExitCtx, ExitResult } from "./chain.ts";

type Chain = "base" | "robinhood";

/** The pool's own pair per chain, the providers the kit syncs the pool on (buy-unpinned.ts poolProviders): each pages
 *  the pool's logs from its deploy block. The command passes these, or two of the user's own. */
export const EXIT_EVM_RPCS: Readonly<Record<Chain, readonly [string, string]>> = Object.freeze({
  base: Object.freeze(["https://base-rpc.publicnode.com", "https://base.api.pocket.network"] as const),
  robinhood: Object.freeze(["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.api.pocket.network"] as const),
});
/** Base's tip cap, wei per gas (the app's EVM_ONWARD_TIP); Robinhood (Arbitrum Nitro) pays no tip. */
export const EXIT_EVM_TIP = 10_000_000n;
/** The release's gas: both RPCs' estimate, the higher, and a quarter more. */
const GAS_MARGIN = (g: bigint): bigint => g + g / 4n;
/** A release's deadline from the newest block both RPCs agree on: the pool refuses it after (PrivacyPool.sol:241). */
export const EXIT_EVM_DEADLINE_MS = 600_000n;
/** How long a sent transaction's receipt is read for on both RPCs, and how often. */
export const EXIT_EVM_RECEIPT_MS = 180_000;
const RECEIPT_EVERY_MS = 2_000;

export class ExitEvmRefused extends Error {
  constructor(why: string) {
    super(why);
    this.name = "ExitEvmRefused";
  }
}
const refuse = (why: string): never => {
  throw new ExitEvmRefused(why);
};

/** What a test or the command may put in place of the live parts. */
export type ExitEvmOpts = {
  /** the pair, built by the caller (a test's fork); else ctx.rpcs */
  rpcs?: readonly [EvmRpc, EvmRpc];
  /** the prover; else the one exitEvmProver was given */
  prover?: VaultProver;
  wait?: (ms: number) => Promise<void>;
};

let commandProver: VaultProver | null = null;
/** The command's prover for exitBase and exitRobinhood, given once before they run. */
export function exitEvmProver(p: VaultProver): void {
  commandProver = p;
}

const hexOf = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
const qty = (v: bigint): string => `0x${v.toString(16)}`;
const quantity = (x: unknown, what: string): bigint => (typeof x === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(x) ? BigInt(x) : refuse(`${what}: not a quantity`));
const lower = (s: string): string => s.toLowerCase();

/** Both RPCs' answers to one call. */
const both = <T>(rpcs: readonly [EvmRpc, EvmRpc], f: (rpc: EvmRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(rpcs[0]), f(rpcs[1])]);
const agreed = <T>(p: readonly [T, T], what: string): T => (p[0] === p[1] ? p[0] : refuse(`${what}: the two RPCs answer ${String(p[0])} and ${String(p[1])}`));

/** ETH, exactly, from wei: for the lines the user reads. */
export function exitEth(wei: bigint): string {
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${wei / 10n ** 18n}${frac ? `.${frac}` : ""} ETH`;
}

// ---------- reads on both RPCs ----------

type Block = { number: bigint; timestamp: bigint; baseFee: bigint };
/** The newest block both RPCs hold: the lower of their latest, read by number on both, one hash. */
async function newest(rpcs: readonly [EvmRpc, EvmRpc]): Promise<Block> {
  const heads = await both(rpcs, async (r) => quantity(await r("eth_blockNumber", []), "eth_blockNumber"));
  const n = heads[0] < heads[1] ? heads[0] : heads[1];
  const blocks = await both(rpcs, async (r) => (await r("eth_getBlockByNumber", [qty(n), false])) as { hash?: unknown; timestamp?: unknown; baseFeePerGas?: unknown } | null);
  if (!blocks[0] || !blocks[1] || blocks[0].hash !== blocks[1].hash) refuse(`block ${n}: the two RPCs hold different blocks`);
  return { number: n, timestamp: quantity(blocks[0]!.timestamp, "timestamp"), baseFee: quantity(blocks[0]!.baseFeePerGas, "baseFeePerGas") };
}
const balanceOf = async (rpcs: readonly [EvmRpc, EvmRpc], a: string, tag: string): Promise<bigint> => agreed(await both(rpcs, async (r) => quantity(await r("eth_getBalance", [a, tag]), "eth_getBalance")), `${a}'s balance`);
const nonceOf = async (rpcs: readonly [EvmRpc, EvmRpc], a: string, tag: string): Promise<bigint> => agreed(await both(rpcs, async (r) => quantity(await r("eth_getTransactionCount", [a, tag]), "eth_getTransactionCount")), `${a}'s nonce`);

/** Base's L1 data fee bound for `bytes` of transaction (the kit's chain fee reads, on both RPCs, the same); 0 on
 *  Robinhood, whose L1 cost is in the gas. */
async function l1Fee(rpcs: readonly [EvmRpc, EvmRpc], chain: Chain, gas: bigint, bytes: bigint, tag: string): Promise<bigint> {
  if (chain === "robinhood") return 0n;
  const answers: [bigint[], bigint[]] = [[], []];
  for (const c of evmPoolChainFeeReads(chain, gas, bytes)) {
    const [a, b] = await both(rpcs, async (r) => {
      const x = await r("eth_call", [{ to: c.to, data: c.data }, tag]);
      return typeof x === "string" && /^0x[0-9a-fA-F]{64,}$/.test(x) ? BigInt(`0x${x.slice(2, 66)}`) : refuse("the L1 fee read");
    });
    answers[0].push(a);
    answers[1].push(b);
  }
  return agreed([evmPoolChainFee(chain, bytes, answers[0]), evmPoolChainFee(chain, bytes, answers[1])], "the L1 fee");
}

/** The fee fields at this block: Base twice the base fee and the tip; Robinhood twice the base fee, no tip (Nitro pays
 *  the base fee only, so the rest stays with the sender). */
const feesAt = (chain: Chain, b: Block): { maxFee: bigint; tip: bigint } => (chain === "base" ? { maxFee: 2n * b.baseFee + EXIT_EVM_TIP, tip: EXIT_EVM_TIP } : { maxFee: 2n * b.baseFee, tip: 0n });

/** A signed transaction sent to both RPCs (again every tenth read) until both read its receipt in one block: its status. */
async function land(rpcs: readonly [EvmRpc, EvmRpc], raw: Uint8Array, hash: string, wait: (ms: number) => Promise<void>): Promise<"ok" | "failed"> {
  type Receipt = { status?: unknown; blockHash?: unknown };
  for (let at = 0, k = 0; at <= EXIT_EVM_RECEIPT_MS; at += RECEIPT_EVERY_MS, k++) {
    if (k % 10 === 0) await Promise.allSettled(rpcs.map((r) => r("eth_sendRawTransaction", [hexOf(raw)])));
    const rs = (await Promise.all(rpcs.map((r) => Promise.resolve().then(() => r("eth_getTransactionReceipt", [hash])).catch(() => null)))) as (Receipt | null)[];
    if (rs[0] && rs[1] && rs[0].blockHash === rs[1].blockHash && rs[0].status === rs[1].status && (rs[0].status === "0x1" || rs[0].status === "0x0")) return rs[0].status === "0x1" ? "ok" : "failed";
    await wait(RECEIPT_EVERY_MS);
  }
  return refuse(`${hash}: no receipt on both RPCs in ${EXIT_EVM_RECEIPT_MS / 1000} s`);
}

/** W_{evm, l, j}'s whole balance less its gas, to `to`: null when W holds less than its gas. */
async function sweep(rpcs: readonly [EvmRpc, EvmRpc], chain: Chain, chainId: bigint, seed: Uint8Array, l: bigint, j: number, to: string, wait: (ms: number) => Promise<void>): Promise<{ hash: string; value: bigint } | null> {
  const w = evmExitW(seed, l, j);
  const b = await newest(rpcs);
  const tag = qty(b.number);
  const bal = await balanceOf(rpcs, w, tag);
  if (bal === 0n) return null;
  const nonce = await nonceOf(rpcs, w, tag);
  const { maxFee, tip } = feesAt(chain, b);
  // a plain send's gas, both RPCs' estimate, the higher (21,000 to no code on Base; Nitro's holds its L1 cost), a fifth
  // more when To has code
  const est = await both(rpcs, async (r) => quantity(await r("eth_estimateGas", [{ from: w, to, value: "0x1" }, tag]), "eth_estimateGas"));
  const code = agreed(await both(rpcs, async (r) => (await r("eth_getCode", [to, tag])) !== "0x"), "To's code");
  const hi = est[0] > est[1] ? est[0] : est[1];
  const gas = code ? hi + hi / 5n : hi;
  const bound = gas * maxFee + (await l1Fee(rpcs, chain, gas, 128n, tag));
  if (bal <= bound) return null;
  const value = bal - bound;
  const { raw, hash } = evmExitSignSend(seed, { kind: "w", l, j }, { chainId, nonce, tip, maxFee, gas, to, value, data: new Uint8Array(0) });
  const end = await land(rpcs, raw, hash, wait);
  if (end !== "ok") refuse(`${w}'s send ${hash} reverted on both RPCs`);
  return { hash, value };
}

// ---------- the exit ----------

/** The chain's pin, its pair checked to be two providers on the chain. */
async function pairOf(chain: Chain, ctx: ExitCtx, opts: ExitEvmOpts): Promise<{ pin: EvmPoolPin; rpcs: readonly [EvmRpc, EvmRpc]; chainId: bigint }> {
  const pin = EVM_POOLS[chain];
  if (pin === undefined) return refuse(`${chain}: no pinned pool`);
  const chainId = EVM_CHAIN_IDS[chain];
  const rpcs = opts.rpcs ?? ([0, 1].map((k) => solanaJsonRpc(ctx.rpcs[k]!, { timeoutMs: 15_000, retry: { deadlineMs: 60_000, backoffMs: 1_000 }, init: { credentials: "omit", referrerPolicy: "no-referrer" } })) as [EvmRpc, EvmRpc]);
  if (solanaSameProvider(rpcs[0], rpcs[1])) refuse(`${chain}: one RPC twice is one read`);
  const ids = await both(rpcs, async (r) => quantity(await r("eth_chainId", []), "eth_chainId"));
  if (ids[0] !== chainId || ids[1] !== chainId) refuse(`${chain}: the RPCs are on chains ${ids[0]} and ${ids[1]}, not ${chainId}`);
  return { pin, rpcs, chainId };
}

/** One chain's exit: every UNSPENT note out to ctx.to, and every W of a spend swept there. */
export async function exitEvm(chain: Chain, ctx: ExitCtx, opts: ExitEvmOpts = {}): Promise<ExitResult> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(ctx.to) || BigInt(ctx.to) < 0x10000n) refuse(`${ctx.to}: not an EVM address to pay`);
  const to = lower(ctx.to);
  const prover = opts.prover ?? commandProver ?? refuse("no prover: the command gives one with exitEvmProver");
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { pin, rpcs, chainId } = await pairOf(chain, ctx, opts);
  if (to === lower(pin.pool)) refuse(`${ctx.to}: the pool itself`);
  const name = chain === "base" ? "Base" : "Robinhood";
  const txs: string[] = [];
  let sent = 0n;
  ctx.say(`${name}: reading the pool ${pin.pool} from block ${pin.fromBlock} on ${ctx.rpcs.join(" and ")}`);
  // one hold of the pool's sync: the tree reads after the restore read only the blocks past it
  const held = evmMemoryHold();
  const r = await evmRestoreNotes({ seed64: ctx.seed, pin, rpcs, wallets: false, held });
  const open = r.notes.filter((n): n is EvmRestoredNote => n.state === "UNSPENT" && n.leaf.value > 0n);
  let left = open.reduce((s, n) => s + n.leaf.value, 0n);
  ctx.say(`${name}: ${open.length} note(s) in the pool, ${exitEth(left)}; ${r.spends.length} spent before`);
  const scope = evmPoolScopeOf(pin.pool, chainId);
  const swept = new Set<string>();
  const sweepW = async (l: bigint, j: number): Promise<void> => {
    const key = `${l}:${j}`;
    if (swept.has(key)) return;
    swept.add(key);
    const s = await sweep(rpcs, chain, chainId, ctx.seed, l, j, to, wait);
    if (s === null) return;
    txs.push(s.hash);
    sent += s.value;
    ctx.say(`${name}: ${exitEth(s.value)} sent to ${ctx.to} (${s.hash})`);
  };
  // a W an earlier release paid, whose onward send never ran: its balance out first
  for (const s of r.spends) {
    if (s.token !== null) ctx.say(`${name}: ${s.w} holds a token a buy paid it (${s.token}); this tool moves its ETH only`);
    await sweepW(s.l, s.j);
  }
  const sync = evmTreeSync({ rpcs, pin, held });
  const g = evmExitGasAddress(ctx.seed);
  for (const n of open) {
    const j = jOf(n.ref);
    const l = n.leaf.label;
    const spent = noteSecrets(ctx.seed, n.ref);
    const change = noteSecrets(ctx.seed, { kind: "change", l, j });
    const refund = noteSecrets(ctx.seed, { kind: "refund", l, j }).precommitment;
    const w = evmExitW(ctx.seed, l, j);
    // the newest roots both RPCs agree on, and a deadline from that block's time
    const nowMs = await sync.now();
    const trees = await sync.trees(nowMs + 1n, undefined, { newest: true });
    if (n.leaf.leafIndex >= BigInt(trees.stateTree.size)) refuse(`note at leaf ${n.leaf.leafIndex}: not under the newest root yet, run again`);
    const salt = hexOf(crypto.getRandomValues(new Uint8Array(16)));
    const relay: EvmRelayData = { recipient: w, feeRecipient: pin.feeRecipient, feeCap: 0n, deadlineMs: nowMs + EXIT_EVM_DEADLINE_MS, refundPrecommitment: refund, salt };
    const context = evmPoolContextOf({ processooor: lower(pin.pool), relay }, scope);
    ctx.say(`${name}: proving the withdrawal of ${exitEth(n.leaf.value)}`);
    const made = await poolProveWithdraw(prover, {
      stateTree: trees.stateTree, labelTree: trees.labelTree, newestStateRoot: trees.stateRoot, newestLabelRoot: trees.labelRoot,
      note: { value: n.leaf.value, label: l, nullifier: spent.nullifier, secret: spent.secret },
      newNullifier: change.nullifier, newSecret: change.secret, withdrawn: n.leaf.value, context,
    });
    const signature = evmExitWithdrawSignature(ctx.seed, l, j, { chainId, pool: pin.pool, relay, nullifierHash: spent.nullifierHash, context, value: n.leaf.value });
    const data = evmExitWithdrawCalldata(pin.pool, relay, made.proof, made.publicSignals, 0n, signature);
    // G sends it, paying its gas
    const b = await newest(rpcs);
    const tag = qty(b.number);
    const est = await both(rpcs, async (rpc) => quantity(await rpc("eth_estimateGas", [{ from: g, to: pin.pool, data: hexOf(data) }, tag]), "the release's eth_estimateGas"));
    const gas = GAS_MARGIN(est[0] > est[1] ? est[0] : est[1]);
    const { maxFee, tip } = feesAt(chain, b);
    const need = gas * maxFee + (await l1Fee(rpcs, chain, gas, BigInt(data.length + 200), tag));
    const has = await balanceOf(rpcs, g, tag);
    if (has < need) {
      ctx.say(`${name}: the gas wallet ${g} holds ${exitEth(has)}; send it at least ${exitEth(need - has)} on ${name} and run again`);
      break;
    }
    const nonce = await nonceOf(rpcs, g, tag);
    const tx = evmExitSignSend(ctx.seed, { kind: "gas", pool: pin.pool }, { chainId, nonce, tip, maxFee, gas, to: pin.pool, value: 0n, data });
    const end = await land(rpcs, tx.raw, tx.hash, wait);
    txs.push(tx.hash);
    if (end !== "ok") refuse(`the release ${tx.hash} reverted on both RPCs`);
    left -= n.leaf.value;
    ctx.say(`${name}: released ${exitEth(n.leaf.value)} to its one-time wallet ${w} (${tx.hash})`);
    await sweepW(l, j);
  }
  return { chain, txs, sent: sent.toString(), left: left.toString() };
}

export const exitBase: ExitChain = (ctx) => exitEvm("base", ctx);
export const exitRobinhood: ExitChain = (ctx) => exitEvm("robinhood", ctx);
