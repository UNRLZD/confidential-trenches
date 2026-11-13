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
//   note's whole value at fee 0, proved here on the hash-checked setup files (src/setup.ts) against the newest roots
//   both RPCs agree on, signed by W, and sent by the gas wallet G, which pays its gas. Then W sends what it holds less
//   its own gas to the typed address. A W a spend of the restore names (an earlier release whose onward send never ran)
//   is swept the same way.
// - G is the words' first EVM account at the standard path m/44'/60'/0'/0/0, the one any EVM wallet shows for these
//   words, so the user can fund it there. When G holds less than a release's gas bound, the tool prints G's address
//   and the amount, and stops this chain: the notes left stay in the pool for the next run.
// - Every read is on both RPCs and must agree; a transaction counts only once both read its receipt in one block.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { HDKey } from "@scure/bip32";
import {
  EVM_CHAIN_IDS,
  EVM_POOLS,
  evmMemoryHold,
  evmPoolContextOf,
  evmPoolScopeOf,
  evmRelayDataBytes,
  evmRestoreNotes,
  evmTreeSync,
  freshWallet,
  jOf,
  noteSecrets,
  type EvmPoolPin,
  type EvmRelayData,
  type EvmRestoredNote,
  type EvmRpc,
} from "@blindfill/kit/core";
import { evmPoolChainFee, evmPoolChainFeeReads, poolProveWithdraw, solanaJsonRpc, solanaSameProvider, type VaultProver, type VaultSnarkjsProof, type VaultWithdrawSignals } from "@blindfill/kit";
import type { ExitChain, ExitCtx, ExitResult } from "./chain.ts";
import { exitSetupFiles } from "./setup.ts";

type Chain = "base" | "robinhood";

/** The pool's own pair per chain, the providers the kit syncs the pool on (buy-unpinned.ts poolProviders): each pages
 *  the pool's logs from its deploy block. The command passes these, or two of the user's own. */
export const EXIT_EVM_RPCS: Readonly<Record<Chain, readonly [string, string]>> = Object.freeze({
  base: Object.freeze(["https://base-rpc.publicnode.com", "https://base.api.pocket.network"] as const),
  robinhood: Object.freeze(["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.api.pocket.network"] as const),
});
/** G's path: the first account of BIP-44 coin 60, the one every EVM wallet opens on. No W shares it (W's paths are
 *  four hardened steps, m/44'/60'/a'/b'). */
export const EXIT_GAS_PATH = "m/44'/60'/0'/0/0";
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
  /** the prover; else snarkjs on the hash-checked setup files */
  prover?: VaultProver;
  wait?: (ms: number) => Promise<void>;
};

const hexOf = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
const bytesOf = (h: string): Uint8Array => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) refuse(`not hex: ${h.slice(0, 20)}`);
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
};
const qty = (v: bigint): string => `0x${v.toString(16)}`;
const quantity = (x: unknown, what: string): bigint => (typeof x === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(x) ? BigInt(x) : refuse(`${what}: not a quantity`));
const lower = (s: string): string => s.toLowerCase();
const cat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const word = (v: bigint): Uint8Array => {
  if (v < 0n || v >= 1n << 256n) refuse("a word out of range");
  return bytesOf(v.toString(16).padStart(64, "0"));
};
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Both RPCs' answers to one call. */
const both = <T>(rpcs: readonly [EvmRpc, EvmRpc], f: (rpc: EvmRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(rpcs[0]), f(rpcs[1])]);
const agreed = <T>(p: readonly [T, T], what: string): T => (p[0] === p[1] ? p[0] : refuse(`${what}: the two RPCs answer ${String(p[0])} and ${String(p[1])}`));

/** ETH, exactly, from wei. */
export function exitEth(wei: bigint): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${v / 10n ** 18n}${frac ? `.${frac}` : ""} ETH`;
}

// ---------- signing ----------

/** RLP of a byte string, an unsigned integer and a list (EIP-1559's fields). */
const rlpBytes = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? b : cat([rlpLen(b.length, 0x80), b]));
const rlpUint = (v: bigint): Uint8Array => rlpBytes(v === 0n ? new Uint8Array(0) : bytesOf(v.toString(16).padStart(v.toString(16).length + (v.toString(16).length % 2), "0")));
const rlpList = (items: readonly Uint8Array[]): Uint8Array => {
  const body = cat(items);
  return cat([rlpLen(body.length, 0xc0), body]);
};
function rlpLen(n: number, base: number): Uint8Array {
  if (n < 56) return Uint8Array.of(base + n);
  const len = bytesOf(n.toString(16).padStart(n.toString(16).length + (n.toString(16).length % 2), "0"));
  return cat([Uint8Array.of(base + 55 + len.length), len]);
}

/** One EIP-1559 (type 2) transaction, signed: 0x02 ‖ rlp([chainId, nonce, tip, maxFee, gas, to, value, data, [], v, r, s]). */
export type ExitEvmTx = { chainId: bigint; nonce: bigint; tip: bigint; maxFee: bigint; gas: bigint; to: string; value: bigint; data: Uint8Array };
export function exitSignTx(secretKey: Uint8Array, t: ExitEvmTx): { raw: Uint8Array; hash: string } {
  const fields = [rlpUint(t.chainId), rlpUint(t.nonce), rlpUint(t.tip), rlpUint(t.maxFee), rlpUint(t.gas), rlpBytes(bytesOf(t.to)), rlpUint(t.value), rlpBytes(t.data), rlpList([])];
  const digest = keccak_256(cat([Uint8Array.of(2), rlpList(fields)]));
  const rec = secp256k1.sign(digest, secretKey, { prehash: false, lowS: true, format: "recovered" });
  const be = (b: Uint8Array): bigint => BigInt(hexOf(b));
  const raw = cat([Uint8Array.of(2), rlpList([...fields, rlpUint(BigInt(rec[0]!)), rlpUint(be(rec.subarray(1, 33))), rlpUint(be(rec.subarray(33, 65)))])]);
  return { raw, hash: hexOf(keccak_256(raw)) };
}

/** The address of a secp256k1 secret key: the last 20 bytes of keccak-256 of its 64-byte public key, lowercase. */
export const exitEvmAddress = (secretKey: Uint8Array): string => hexOf(keccak_256(secp256k1.getPublicKey(secretKey, false).subarray(1)).subarray(12));

/** W's EIP-712 Withdraw signature, r ‖ s ‖ v with s low, as PrivacyPool.withdraw checks it (WITHDRAW_TYPEHASH, the
 *  Blindfill domain, version 1, this chain and pool). */
export function exitWithdrawSignature(secretKey: Uint8Array, chainId: bigint, pool: string, nullifierHash: bigint, context: bigint, value: bigint): Uint8Array {
  const domain = keccak_256(cat([keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak_256(utf8("Blindfill")), keccak_256(utf8("1")), word(chainId), word(BigInt(pool))]));
  const struct = keccak_256(cat([keccak_256(utf8("Withdraw(uint256 nullifier,uint256 context,uint256 value)")), word(nullifierHash), word(context), word(value)]));
  const rec = secp256k1.sign(keccak_256(cat([Uint8Array.of(0x19, 0x01), domain, struct])), secretKey, { prehash: false, lowS: true, format: "recovered" });
  const out = new Uint8Array(65);
  out.set(rec.subarray(1, 65), 0);
  out[64] = 27 + rec[0]!;
  return out;
}

const WITHDRAW_SELECTOR = keccak_256(utf8("withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)")).subarray(0, 4);
/** withdraw(Withdrawal{pool, abi.encode(relay)}, proof, fee, signature) in its canonical ABI encoding: 1,028 bytes. */
export function exitWithdrawCalldata(pool: string, relay: EvmRelayData, proof: VaultSnarkjsProof, signals: VaultWithdrawSignals, fee: bigint, signature: Uint8Array): Uint8Array {
  if (signals.length !== 8 || signature.length !== 65) refuse("calldata: eight signals and a 65-byte signature");
  const dec = (s: string): bigint => BigInt(s);
  const proofWords = [
    dec(proof.pi_a[0]), dec(proof.pi_a[1]),
    dec(proof.pi_b[0][1]), dec(proof.pi_b[0][0]), dec(proof.pi_b[1][1]), dec(proof.pi_b[1][0]),
    dec(proof.pi_c[0]), dec(proof.pi_c[1]),
    ...signals.map(dec),
  ].map(word);
  const tail = (b: Uint8Array): Uint8Array[] => {
    const padded = new Uint8Array(Math.ceil(b.length / 32) * 32);
    padded.set(b);
    return [word(BigInt(b.length)), padded];
  };
  const HEAD = 19n; // the Withdrawal's offset, the proof's 16 words, the fee, the signature's offset
  const withdrawal = [word(BigInt(pool)), word(0x40n), ...tail(evmRelayDataBytes(relay))];
  const sigAt = HEAD + BigInt(withdrawal.reduce((n, p) => n + p.length, 0) / 32);
  return cat([WITHDRAW_SELECTOR, word(32n * HEAD), ...proofWords, word(fee), word(32n * sigAt), ...withdrawal, ...tail(signature)]);
}

// ---------- keys ----------

/** G's secret key, from the seed at EXIT_GAS_PATH. The caller zeroes it. */
export function exitGasKey(seed64: Uint8Array): Uint8Array {
  const node = HDKey.fromMasterSeed(seed64).derive(EXIT_GAS_PATH);
  const k = node.privateKey;
  if (!k) refuse("G: no key at its path");
  const out = Uint8Array.from(k!);
  node.wipePrivateData();
  return out;
}

// ---------- the prover ----------

/** snarkjs's Groth16 prover on the hash-checked setup files (src/setup.ts), loaded once. */
export function exitSnarkjsProver(): VaultProver {
  let files: Promise<Map<string, Uint8Array>> | null = null;
  return {
    async load() {
      files ??= exitSetupFiles(["withdraw.wasm", "withdraw.zkey"]) as Promise<Map<string, Uint8Array>>;
      await files;
    },
    async prove(_circuit, input) {
      const f = await files!;
      // @ts-expect-error snarkjs ships no types
      const snarkjs = (await import("snarkjs")) as { groth16: { fullProve(i: unknown, w: unknown, z: unknown): Promise<{ proof: unknown; publicSignals: unknown }> } };
      const t0 = performance.now();
      const r = await snarkjs.groth16.fullProve(input, { type: "mem", data: f.get("withdraw.wasm") }, { type: "mem", data: f.get("withdraw.zkey") });
      return { proof: r.proof, publicSignals: r.publicSignals, proveMs: performance.now() - t0 } as Awaited<ReturnType<VaultProver["prove"]>>;
    },
  };
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

/** W's whole balance less its gas, to `to`: null when W holds less than its gas. */
async function sweep(rpcs: readonly [EvmRpc, EvmRpc], chain: Chain, chainId: bigint, key: Uint8Array, to: string, wait: (ms: number) => Promise<void>): Promise<{ hash: string; value: bigint } | null> {
  const w = exitEvmAddress(key);
  const b = await newest(rpcs);
  const tag = qty(b.number);
  const bal = await balanceOf(rpcs, w, tag);
  if (bal === 0n) return null;
  const nonce = await nonceOf(rpcs, w, tag);
  const { maxFee, tip } = feesAt(chain, b);
  // a plain send's gas, both RPCs' estimate (21,000 to no code on Base; Nitro's includes its L1 cost; a To with code
  // its own), a fifth more when To has code
  const est = await both(rpcs, async (r) => quantity(await r("eth_estimateGas", [{ from: w, to, value: "0x1" }, tag]), "eth_estimateGas"));
  const code = agreed(await both(rpcs, async (r) => (await r("eth_getCode", [to, tag])) !== "0x"), "To's code");
  const hi = est[0] > est[1] ? est[0] : est[1];
  const gas = code ? hi + hi / 5n : hi;
  const bound = gas * maxFee + (await l1Fee(rpcs, chain, gas, 128n, tag));
  if (bal <= bound) return null;
  const value = bal - bound;
  const { raw, hash } = exitSignTx(key, { chainId, nonce, tip, maxFee, gas, to, value, data: new Uint8Array(0) });
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
    const fresh = freshWallet(ctx.seed, "evm", l, j);
    try {
      if (swept.has(lower(fresh.address))) return;
      swept.add(lower(fresh.address));
      const s = await sweep(rpcs, chain, chainId, fresh.secretKey, to, wait);
      if (s === null) return;
      txs.push(s.hash);
      sent += s.value;
      ctx.say(`${name}: ${exitEth(s.value)} sent to ${ctx.to} (${s.hash})`);
    } finally {
      fresh.secretKey.fill(0);
    }
  };
  // a W an earlier release paid, whose onward send never ran: its balance out first
  for (const s of r.spends) {
    if (s.token !== null) ctx.say(`${name}: ${s.w} holds a token a buy paid it (${s.token}); this tool moves its ETH only`);
    await sweepW(s.l, s.j);
  }
  const sync = evmTreeSync({ rpcs, pin, held });
  const prover = opts.prover ?? exitSnarkjsProver();
  const gasKey = exitGasKey(ctx.seed);
  const g = exitEvmAddress(gasKey);
  try {
    for (const n of open) {
      const j = jOf(n.ref);
      const l = n.leaf.label;
      const spent = noteSecrets(ctx.seed, n.ref);
      const change = noteSecrets(ctx.seed, { kind: "change", l, j });
      const refund = noteSecrets(ctx.seed, { kind: "refund", l, j }).precommitment;
      const w = freshWallet(ctx.seed, "evm", l, j);
      try {
        // the newest roots both RPCs agree on, and a deadline from that block's time
        const nowMs = await sync.now();
        const trees = await sync.trees(nowMs + 1n, undefined, { newest: true });
        if (n.leaf.leafIndex >= BigInt(trees.stateTree.size)) refuse(`note at leaf ${n.leaf.leafIndex}: not under the newest root yet, run again`);
        const salt = hexOf(crypto.getRandomValues(new Uint8Array(16)));
        const relay: EvmRelayData = { recipient: w.address, feeRecipient: pin.feeRecipient, feeCap: 0n, deadlineMs: nowMs + EXIT_EVM_DEADLINE_MS, refundPrecommitment: refund, salt };
        const context = evmPoolContextOf({ processooor: lower(pin.pool), relay }, scope);
        ctx.say(`${name}: proving the withdrawal of ${exitEth(n.leaf.value)}`);
        const made = await poolProveWithdraw(prover, {
          stateTree: trees.stateTree, labelTree: trees.labelTree, newestStateRoot: trees.stateRoot, newestLabelRoot: trees.labelRoot,
          note: { value: n.leaf.value, label: l, nullifier: spent.nullifier, secret: spent.secret },
          newNullifier: change.nullifier, newSecret: change.secret, withdrawn: n.leaf.value, context,
        });
        const signature = exitWithdrawSignature(w.secretKey, chainId, pin.pool, spent.nullifierHash, context, n.leaf.value);
        const data = exitWithdrawCalldata(pin.pool, relay, made.proof, made.publicSignals, 0n, signature);
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
        const tx = exitSignTx(gasKey, { chainId, nonce, tip, maxFee, gas, to: pin.pool, value: 0n, data });
        const end = await land(rpcs, tx.raw, tx.hash, wait);
        txs.push(tx.hash);
        if (end !== "ok") refuse(`the release ${tx.hash} reverted on both RPCs`);
        left -= n.leaf.value;
        ctx.say(`${name}: released ${exitEth(n.leaf.value)} to its one-time wallet ${w.address} (${tx.hash})`);
        await sweepW(l, j);
      } finally {
        w.secretKey.fill(0);
      }
    }
  } finally {
    gasKey.fill(0);
  }
  return { chain, txs, sent: exitEth(sent), left: exitEth(left) };
}

export const exitBase: ExitChain = (ctx) => exitEvm("base", ctx);
export const exitRobinhood: ExitChain = (ctx) => exitEvm("robinhood", ctx);
