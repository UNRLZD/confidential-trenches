// The Solana pool's exit (card exit-with-only-the-words): every note of the 12 words in the release's pool, released
// whole to its own fresh wallet W and sent on from W to the Solana address the user typed, with no server of ours.
//
// - The reads: the release's two public RPCs on one cluster (./sol-rpc.ts: mainnet's pair, or devnet's), every read
//   the same on both. The notes: the wallet's own Solana restore from the seed (./sol-scan.ts exitSolScanSeed).
// - The fee wallet F: the words' standard Solana key, m/44'/501'/0'/0' (SLIP-10 ed25519, the address a standard wallet
//   shows for these words; fresh wallets use the HKDF paths of packages/wallet/src/derive/keys.ts, so never this one).
//   F is the release's fee payer in place of the helper's: the program takes any fee payer that signs
//   (contracts/pool-solana/src/release.rs:153-156, FeePayerNotSigner) and binds it in the context (row 3). F pays the
//   transaction fee and the rent of the spent mark and the change note's entry (release.rs:43-44), and the release pays
//   the relay fee to F (row 13, release.rs:36-37): the epoch fee the device computes (the kit's solanaPoolFee), which is
//   above that cost, so F is paid back in the same transaction and needs only the float. Before each release the
//   command waits for F to hold it (./fund.ts fundedOrWait).
// - Per note, as the signing page's part (packages/signpage/src/pool-withdraw.ts onePart): the epoch root when it holds
//   the note's leaf, else the newest root both RPCs agree on; the wallet's bind (tip cap 0, a tag 2 pays no tip),
//   checked here against the program's context; the proof; the release (tag 2), alone in its transaction, signed by F
//   and W, sent to the first RPC and read back on both; then W's own System transfer of all it holds less its fee to
//   the typed address, W its only signer and fee payer, read back on both (pool-withdraw.ts sendOnward). Every key is
//   zeroed once it signed.
// - The signatures: @noble/curves' ed25519, as the wallet's own Solana signer (packages/wallet/src/arming/records.ts),
//   at the two sites scripts/ci/sign-sites.mjs lists (sendOnward, solExitWith), proven by test/sol-out.test.ts (b).
// - The resume: a W of ours that still holds lamports (a release that landed before a stop) is sent on first.
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  poolProveWithdraw,
  readSolanaRent,
  solanaCompileV0,
  solanaDecodeTransaction,
  solanaEncodePoolRelease,
  solanaPoolFee,
  solanaPoolTag2Accounts,
  solanaRentMin,
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_POOL_FEE_STEP,
  SOLANA_SYSTEM_PROGRAM,
  type PoolWithdrawInputArgs,
  type SolanaPoolRelease,
  type SolanaRpc,
  type VaultProver,
  type VaultSnarkjsProof,
} from "@blindfill/kit";
import { changeIndex, freshWallet, noteSecrets, slip10Ed25519, solanaContextOf, solanaPool, solanaPoolOf, type SolanaRestoredNote, type SolanaRestoredSpend } from "@blindfill/kit/core";
import type { ExitChain, ExitCtx, ExitResult } from "./chain.ts";
import { fundedOrWait, units } from "./fund.ts";
import { exitProver } from "./prover.ts";
import { EXIT_SOL_CLUSTERS, exitSolReads, exitSolRpc, ExitSolRefused, type ExitSolCluster } from "./sol-rpc.ts";
import { exitSolScanSeed } from "./sol-scan.ts";

/** The release's compute limit (pool-withdraw.ts POOL_WITHDRAW_CU: the program's own tests send a release at 400,000). */
export const SOL_EXIT_RELEASE_CU = 400_000;
/** The fee wallet's path: m/44'/501'/0'/0', every step hardened (SLIP-10 ed25519 takes only hardened steps). */
export const SOL_FEE_WALLET_PATH: readonly number[] = Object.freeze([44, 501, 0, 0].map((x) => x + 0x8000_0000));
/** Between two reads of a sent transaction, and between two sends of the same bytes. */
const TX_POLL_MS = 2_000;
/** A part's wait for an epoch or newest root that holds its leaf: one epoch and 30 s (pool-withdraw.ts WITHDRAW_BOUNDARY_LAG_MS). */
const LEAF_LAG_MS = 30_000n;
/** How many times W's balance is read again while the two RPCs differ (one is a slot behind the release). */
const BALANCE_READS = 15;
/** A blockhash lives 150 blocks after its own (pool-buy.ts BLOCKHASH_LIFE). */
const BLOCKHASH_LIFE = 151;
/** The pool account (contracts/pool-solana src/state.rs; pool-buy.ts POOL_LEN, POOL_DISC, OFF_TREES, TREE_LEN). */
const POOL_LEN = 2179;
const POOL_DISC = "bfpool01";
const OFF_TREES = 49;
const TREE_LEN = 8 + 1 + 33 * 32;
/** The two tag 2 signatures of a release (fee payer and W), lamports. */
const RELEASE_SIGNATURES_FEE = 10_000n;

/** A Solana pool the exit binds and reads trees from: the wallet's solanaPool (its now, trees and bind). */
type SolPool = Pick<ReturnType<typeof solanaPool>, "epochMs" | "lifeMs" | "now" | "trees" | "bind">;

/** Tests only: the reads, the pool, the prover and the clock solExit uses, given. The command gives none. */
export type SolExitOver = {
  rpcs?: readonly [SolanaRpc, SolanaRpc];
  /** the restore's notes and spends (the wallet's restore on rpcs unless given) */
  scan?: (seed64: Uint8Array, cluster: ExitSolCluster, rpcs: readonly [SolanaRpc, SolanaRpc]) => Promise<{ notes: SolanaRestoredNote[]; spends: SolanaRestoredSpend[] }>;
  /** the pool for a fee payer (the wallet's solanaPool on rpcs unless given) */
  pool?: (feePayer: string, program: string, rpcs: readonly [SolanaRpc, SolanaRpc]) => SolPool;
  prover?: VaultProver;
  /** a proof's answer in place of poolProveWithdraw's (a test has no snarkjs setup) */
  prove?: (args: PoolWithdrawInputArgs) => Promise<{ proof: VaultSnarkjsProof; publicSignals: readonly string[] }>;
  sleep?: (ms: number) => Promise<void>;
};

/** A stop of the Solana exit once something may have moved: the run is said again from the chain. */
class SolStop extends Error {
  constructor(why: string) {
    super(why);
    this.name = "SolStop";
  }
}
const stop = (why: string): never => {
  throw new SolStop(why);
};

// ---------- base58, for 32-byte keys and 64-byte signatures ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(b: Uint8Array): string {
  let x = b.reduce((v, n) => (v << 8n) | BigInt(n), 0n);
  let out = "";
  while (x > 0n) {
    out = B58[Number(x % 58n)] + out;
    x /= 58n;
  }
  for (const n of b) {
    if (n !== 0) break;
    out = `1${out}`;
  }
  return out;
}
/** The bytes of a base58 string, or null when it is not base58 or not `len` bytes. */
export function b58decode(s: string, len: number): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0 || s.length > 90) return null;
  let x = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    x = x * 58n + BigInt(i);
  }
  const body: number[] = [];
  while (x > 0n) {
    body.unshift(Number(x & 255n));
    x >>= 8n;
  }
  const zeros = s.length - s.replace(/^1+/, "").length;
  const out = Uint8Array.from([...new Array(zeros).fill(0), ...body]);
  return out.length === len ? out : null;
}
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

/** The fee wallet F of seed64: its address, and its 32-byte secret (the caller zeroes it). */
export function solFeeWallet(seed64: Uint8Array): { address: string; secretKey: Uint8Array } {
  const { key, chainCode } = slip10Ed25519(seed64, [...SOL_FEE_WALLET_PATH]);
  chainCode.fill(0);
  return { address: b58encode(ed25519.getPublicKey(key)), secretKey: key };
}

// ---------- reads on both RPCs ----------
type Pair = readonly [SolanaRpc, SolanaRpc];
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const lamportsOf = (x: unknown): bigint => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : stop("an RPC answer is not a lamport count"));
const intOf = (x: unknown): number => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : stop("an RPC answer is not a whole number"));
const both = <T>(rpcs: Pair, f: (rpc: SolanaRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(rpcs[0]), f(rpcs[1])]);
const realSleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

async function balances(rpcs: Pair, address: string): Promise<[bigint, bigint]> {
  return both(rpcs, async (rpc) => lamportsOf(((await rpc("getBalance", [address, { commitment: "confirmed" }])) as { value?: unknown } | null)?.value));
}
/** The lower of both RPCs' balance: what the fee wallet surely holds. */
const lowerBalance = async (rpcs: Pair, address: string): Promise<bigint> => {
  const [a, b] = await balances(rpcs, address);
  return a < b ? a : b;
};
/** W's balance once both RPCs read it the same, read again while they differ (one a slot behind). */
async function agreedBalance(rpcs: Pair, address: string, sleep: (ms: number) => Promise<void>): Promise<bigint> {
  for (let k = 0; ; k++) {
    const [a, b] = await balances(rpcs, address);
    if (a === b) return a;
    if (k >= BALANCE_READS) stop(`the two RPCs read ${address} differently`);
    await sleep(1_000);
  }
}

/** One account on both RPCs (base64, confirmed): owner, executable and data, or null when there is none. */
async function accountOn(rpc: SolanaRpc, address: string): Promise<{ owner: string; executable: boolean; data: Uint8Array } | null> {
  const r = (await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }])) as { value?: unknown } | null;
  const v = r?.value;
  if (v === null) return null;
  if (!isObj(v) || typeof v.owner !== "string" || typeof v.executable !== "boolean" || !Array.isArray(v.data) || v.data[1] !== "base64" || typeof v.data[0] !== "string") return stop(`an RPC's read of ${address} is not an account`);
  return { owner: v.owner, executable: v.executable, data: unb64(v.data[0]) };
}

/**
 * The typed address, before any money moves (pool-withdraw.ts checkTo, toRefused): a base58 32-byte key that is not the
 * pool or its program, and on both RPCs either no account yet or a System account that is not executable. So never a
 * program, a sysvar, the pool's pages or marks, or a token account: a plain wallet address, as the user's wallet shows it.
 */
export async function solCheckTo(rpcs: Pair, program: string, to: string): Promise<void> {
  if (b58decode(to, 32) === null) throw new ExitSolRefused(`the Solana address ${JSON.stringify(to.slice(0, 60))} is not a base58 32-byte key`);
  const { pool } = solanaPoolOf(program);
  if (to === pool || to === program || to === SOLANA_SYSTEM_PROGRAM) throw new ExitSolRefused(`the Solana address ${to} is the pool's own`);
  const [a, b] = await both(rpcs, (rpc) => accountOn(rpc, to));
  for (const x of [a, b]) {
    if (x === null) continue;
    if (x.executable) throw new ExitSolRefused(`the Solana address ${to} is a program`);
    if (x.owner === program) throw new ExitSolRefused(`the Solana address ${to} is an account of the pool`);
    if (x.owner !== SOLANA_SYSTEM_PROGRAM) throw new ExitSolRefused(`the Solana address ${to} is not a wallet address (its owner is ${x.owner})`);
  }
}

/** The pool account's state tree size on both RPCs, which must be one (pool-buy.ts treeSizesOnce). */
async function stateSizeOf(rpcs: Pair, program: string, pool: string): Promise<number> {
  const sizes = await both(rpcs, async (rpc) => {
    const a = await accountOn(rpc, pool);
    if (a === null || a.owner !== program || a.data.length !== POOL_LEN || new TextDecoder().decode(a.data.subarray(0, 8)) !== POOL_DISC) return stop("the pool account is not the pool's");
    const v = new DataView(a.data.buffer, a.data.byteOffset, a.data.length);
    return { state: intOf(Number(v.getBigUint64(OFF_TREES, true))), label: intOf(Number(v.getBigUint64(OFF_TREES + TREE_LEN, true))) };
  });
  if (sizes[0].state !== sizes[1].state) return stop("the two RPCs read the pool's state tree at two sizes");
  return sizes[0].state;
}

/** The blockhash on RPC 0, valid on RPC 1, and a block height past which nothing on it can land (pool-buy.ts blockhashOf). */
async function blockhashOf(rpcs: Pair): Promise<{ blockhash: string; lastHeight: number }> {
  const r = (await rpcs[0]("getLatestBlockhash", [{ commitment: "confirmed" }])) as { value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } } | null;
  const blockhash = r?.value?.blockhash;
  if (typeof blockhash !== "string" || b58decode(blockhash, 32) === null) return stop("no blockhash");
  const said = intOf(r!.value!.lastValidBlockHeight);
  const ok = (await rpcs[1]("isBlockhashValid", [blockhash, { commitment: "confirmed" }])) as { value?: unknown } | null;
  if (ok?.value !== true) return stop("the blockhash is not valid on the second RPC");
  const height = intOf(await rpcs[1]("getBlockHeight", [{ commitment: "confirmed" }])) + BLOCKHASH_LIFE;
  return { blockhash, lastHeight: said > height ? said : height };
}

/** True once both RPCs' finalized height is past `last`; a failed read is "not yet". */
async function pastOnBoth(rpcs: Pair, last: number): Promise<boolean> {
  try {
    return (await both(rpcs, async (rpc) => intOf(await rpc("getBlockHeight", [{ commitment: "finalized" }])) > last)).every(Boolean);
  } catch {
    return false;
  }
}

/** This very transaction under its signature on one RPC: "none", "ok", "failed" or "other" (pool-buy.ts readBackMeta). */
async function readBack(rpc: SolanaRpc, signature: string, signed: Uint8Array): Promise<"none" | "ok" | "failed" | "other"> {
  const r = (await rpc("getTransaction", [signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as { transaction?: unknown; meta?: unknown } | null;
  if (r === null) return "none";
  const t = r?.transaction;
  if (!Array.isArray(t) || t[1] !== "base64" || typeof t[0] !== "string") return "other";
  const got = unb64(t[0]);
  if (got.length !== signed.length || got.some((x, i) => x !== signed[i])) return "other";
  if (!isObj(r.meta) || !Object.hasOwn(r.meta, "err") || r.meta.err === undefined) return "none";
  return r.meta.err === null ? "ok" : "failed";
}

/** The signed bytes, sent to the first RPC (again every TX_POLL_MS while its blockhash lives) and read back on both. */
async function sendAndRead(rpcs: Pair, signed: Uint8Array, signature: string, lastHeight: number, sleep: (ms: number) => Promise<void>): Promise<"ok" | "failed" | "not_landed"> {
  const wire = b64(signed);
  for (;;) {
    await rpcs[0]("sendTransaction", [wire, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 0 }]).catch(() => null);
    const got = await both(rpcs, (rpc) => readBack(rpc, signature, signed).catch(() => "none" as const));
    if (got[0] === "ok" && got[1] === "ok") return "ok";
    if (got[0] === "failed" && got[1] === "failed") return "failed";
    if (got.includes("other")) stop(`an RPC answers another transaction under ${signature}`);
    if (await pastOnBoth(rpcs, lastHeight)) {
      const last = await both(rpcs, (rpc) => readBack(rpc, signature, signed).catch(() => "none" as const));
      return last[0] === "ok" && last[1] === "ok" ? "ok" : "not_landed";
    }
    await sleep(TX_POLL_MS);
  }
}

/** The network's fee for a message, the same on both RPCs (pool-withdraw.ts feeOf). */
async function feeOf(rpcs: Pair, message: Uint8Array): Promise<bigint> {
  const [a, b] = await both(rpcs, async (rpc) => lamportsOf(((await rpc("getFeeForMessage", [b64(message), { commitment: "confirmed" }])) as { value?: unknown } | null)?.value));
  return a === b ? a : stop("the two RPCs price a message differently");
}

const u32le = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u64le = (v: bigint): number[] => Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 255n));
/** W's onward message: one System transfer of `v` from `from` to `to`, `from` its only signer and fee payer (pool-withdraw.ts onwardMessage). */
export const solOnwardMessage = (from: string, to: string, v: bigint, blockhash: string): Uint8Array =>
  solanaCompileV0(from, [{ program: SOLANA_SYSTEM_PROGRAM, accounts: [{ key: from, signer: true, writable: true }, { key: to, signer: false, writable: true }], data: Uint8Array.of(2, 0, 0, 0, ...u64le(v)) }], blockhash, [], [from]).message;

/** A wire of `n` signature slots and `message`, the slots filled by `sigs` in order. */
function wireOf(message: Uint8Array, sigs: readonly Uint8Array[]): Uint8Array {
  const wire = new Uint8Array(1 + 64 * sigs.length + message.length);
  wire[0] = sigs.length;
  sigs.forEach((s, i) => wire.set(s, 1 + 64 * i));
  wire.set(message, 1 + 64 * sigs.length);
  return wire;
}

// ---------- the release's bytes ----------
const be32 = (x: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
};
const dec = (s: unknown): bigint => (typeof s === "string" && /^(0|[1-9][0-9]{0,77})$/.test(s) ? BigInt(s) : stop("a public signal is not a decimal"));
/** The proof as the program reads it: A, B (each Fq2 imaginary part first), C (pool-buy.ts solanaProofBytes). */
function proofBytes(p: VaultSnarkjsProof): Uint8Array {
  if (p.pi_a[2] !== "1" || p.pi_c[2] !== "1" || p.pi_b[2][0] !== "1" || p.pi_b[2][1] !== "0") stop("the proof is not affine");
  const xs = [p.pi_a[0], p.pi_a[1], p.pi_b[0][1], p.pi_b[0][0], p.pi_b[1][1], p.pi_b[1][0], p.pi_c[0], p.pi_c[1]];
  const out = new Uint8Array(256);
  xs.forEach((x, i) => out.set(be32(dec(x)), i * 32));
  return out;
}

/** W's send onward of all it holds less its fee to `to`: built, signed by W (its key zeroed at once), sent, read back. */
async function sendOnward(rpcs: Pair, seed64: Uint8Array, l: bigint, j: number, to: string, sleep: (ms: number) => Promise<void>, notTo: readonly string[]): Promise<{ signature: string; amount: bigint } | null> {
  const w = freshWallet(seed64, "sol", l, j);
  w.secretKey.fill(0);
  if (to === w.address || notTo.includes(to)) throw new ExitSolRefused(`the Solana address ${to} is an account of the release`);
  const balance = await agreedBalance(rpcs, w.address, sleep);
  if (balance === 0n) return null;
  const bh = await blockhashOf(rpcs);
  const fee = await feeOf(rpcs, solOnwardMessage(w.address, to, balance, bh.blockhash));
  if (balance <= fee) stop(`W ${w.address} holds ${balance} lamports, not more than its own fee ${fee}`);
  const message = solOnwardMessage(w.address, to, balance - fee, bh.blockhash);
  const signer = freshWallet(seed64, "sol", l, j);
  let sig: Uint8Array;
  try {
    if (signer.address !== w.address) stop("W is not the one the bytes were built for");
    sig = ed25519.sign(message, signer.secretKey);
  } finally {
    signer.secretKey.fill(0);
  }
  const signed = wireOf(message, [sig]);
  const signature = b58encode(sig);
  const got = await sendAndRead(rpcs, signed, signature, bh.lastHeight, sleep);
  if (got !== "ok") stop(`W's send onward ${signature} ${got === "failed" ? "failed" : "did not land"}`);
  return { signature, amount: balance - fee };
}

/** The cluster whose release pair ctx.rpcs is, or a refusal before any read. */
function clusterOf(rpcs: readonly string[]): ExitSolCluster {
  const href = (u: string | undefined) => {
    try {
      return u === undefined ? undefined : new URL(u).href;
    } catch {
      return undefined;
    }
  };
  for (const c of Object.keys(EXIT_SOL_CLUSTERS) as ExitSolCluster[]) if (Array.isArray(rpcs) && rpcs.length === 2 && rpcs.every((u, k) => href(u) === EXIT_SOL_CLUSTERS[c].rpcs[k])) return c;
  throw new ExitSolRefused(`the two Solana RPCs are a release pair: ${Object.values(EXIT_SOL_CLUSTERS).map((n) => n.rpcs.join(" and ")).join(", or ")}`);
}

/** The Solana pool's ExitChain, with the tests' reads when given. */
export function solExitWith(over: SolExitOver = {}): ExitChain {
  return async (ctx: ExitCtx): Promise<ExitResult> => {
    const sleep = over.sleep ?? realSleep;
    const cluster = clusterOf(ctx.rpcs);
    const given = over.rpcs ?? ([exitSolRpc(ctx.rpcs[0]), exitSolRpc(ctx.rpcs[1])] as const);
    const { program, rpcs } = exitSolReads(cluster, { rpcs: given });
    const { pool: poolAccount, scope } = solanaPoolOf(program);
    const to = ctx.to;
    await solCheckTo(rpcs, program, to);

    const fw = solFeeWallet(ctx.seed);
    fw.secretKey.fill(0);
    const F = fw.address;
    ctx.say(`reading the pool ${poolAccount} on ${cluster}; the fee wallet of these words is ${F}`);
    const scan = await (over.scan ?? ((s, c, r) => exitSolScanSeed(s, c, r)))(ctx.seed, cluster, rpcs);
    const notes = scan.notes.filter((n) => n.state === "UNSPENT" && n.leaf.value > 0n);
    let left = notes.reduce((s, n) => s + n.leaf.value, 0n);
    ctx.say(`${notes.length} note(s) to send out, ${units(left, 9)} SOL; ${scan.spends.length} spend(s) of ours read`);

    const txs: string[] = [];
    let sent = 0n;
    const fail = (e: unknown): never => {
      throw new Error(`${e instanceof Error ? e.message : String(e)} (txs so far: ${txs.join(" ") || "none"}); run the exit again to go on`);
    };
    try {
      // the resume: a W of ours still holding lamports (its release landed, its send onward did not) is sent on first
      for (const s of scan.spends) {
        const on = await sendOnward(rpcs, ctx.seed, s.l, s.j, to, sleep, [poolAccount, program]);
        if (on === null) continue;
        txs.push(on.signature);
        sent += on.amount;
        ctx.say(`sent ${units(on.amount, 9)} SOL left on ${s.w} on: tx ${on.signature}`);
      }

      const P: SolPool =
        over.pool?.(F, program, rpcs) ??
        solanaPool({
          pin: { program, feePayer: F },
          rpcs,
          // the relay fee is F's own answer: the epoch fee the device computes from the Rent sysvar on both RPCs
          relayFee: async (e) => ({ chain: "solana", program, pool: poolAccount, fee_payer: F, epoch_ms: 60_000, epoch_start_ms: Number(e), fee: solanaPoolFee(await readSolanaRent(rpcs)).toString(), step: SOLANA_POOL_FEE_STEP.toString() }),
        });

      for (const note of notes) {
        const leaf = note.leaf;
        const rent = await readSolanaRent(rpcs);
        const fee = solanaPoolFee(rent);
        // what the program and W's end need of a whole note (release.rs row 8 backstop, 5,000 bps; W at rent(0) at least)
        if (fee * 10_000n > leaf.value * 5_000n || leaf.value - fee < solanaRentMin(rent, 0) + RELEASE_SIGNATURES_FEE) {
          ctx.say(`a note of ${units(leaf.value, 9)} SOL is under the pool's least release at a fee of ${units(fee, 9)} SOL: it stays in the pool`);
          continue;
        }
        // F's float: two signatures, the spent mark's rent and, at worst, a new state page of one entry (release.rs:43-44, 92-96)
        const need = RELEASE_SIGNATURES_FEE + solanaRentMin(rent, 13) + solanaRentMin(rent, 16 + 72);
        await fundedOrWait({ address: F, need, unit: { symbol: "SOL", decimals: 9 }, balance: () => lowerBalance(rpcs, F), say: ctx.say, sleep });

        // the roots: the epoch root when it holds the leaf, else the newest both RPCs agree on, read again for a while
        let nowMs = await P.now();
        let epochStartMs = nowMs - (nowMs % P.epochMs);
        const holds = (t: Awaited<ReturnType<SolPool["trees"]>> | null) => t !== null && leaf.leafIndex < BigInt(t.stateTree.size);
        const tryTrees = (cut: bigint, newest: boolean) => P.trees(cut, undefined, newest ? { newest: true } : undefined).catch(() => null);
        let trees = await tryTrees(epochStartMs, false);
        for (let waited = 0n; !holds(trees); waited += 1_000n) {
          trees = await tryTrees(nowMs + 1n, true);
          if (holds(trees)) break;
          if (waited > P.epochMs + LEAF_LAG_MS) stop(`no root both RPCs agree on holds the note at leaf ${leaf.leafIndex}`);
          await sleep(1_000);
          nowMs = await P.now();
          epochStartMs = nowMs - (nowMs % P.epochMs);
          trees = await tryTrees(epochStartMs, false);
        }
        const t = trees!;
        const deadlineMs = epochStartMs + P.lifeMs;

        const l = leaf.label;
        const j = note.ref.kind === "change" ? changeIndex({ kind: "change", j: note.ref.j }) : changeIndex({ kind: "deposit" });
        const w = freshWallet(ctx.seed, "sol", l, j);
        w.secretKey.fill(0);
        const refundPrecommitment = noteSecrets(ctx.seed, { kind: "refund", l, j }).precommitment;
        const binding = await P.bind({ chunk: leaf.value, wallet: { address: w.address, publicKey: w.publicKey }, refundPrecommitment, epochStartMs, deadlineMs, tipCap: 0n });
        const q = binding.request;
        if (q.program !== program || q.pool !== poolAccount || q.recipient !== w.address || q.feePayer !== F || q.relayFee !== fee || q.relayFeeCap !== fee || binding.feeCap !== fee || q.tipCap !== 0n || q.deadlineMs !== deadlineMs)
          stop("the bind is not this release's (pool, W, fee wallet, fee, tip cap 0, deadline)");
        if (solanaContextOf(q, scope) !== binding.context) stop("the bind's context is not the program's for its fields");

        ctx.say(`proving the release of ${units(leaf.value, 9)} SOL to ${w.address}`);
        const spent = noteSecrets(ctx.seed, note.ref);
        const next = noteSecrets(ctx.seed, { kind: "change", l, j });
        const args: PoolWithdrawInputArgs = {
          stateTree: t.stateTree,
          labelTree: t.labelTree,
          newestStateRoot: t.stateRoot,
          newestLabelRoot: t.labelRoot,
          note: { value: leaf.value, label: l, nullifier: spent.nullifier, secret: spent.secret },
          newNullifier: next.nullifier,
          newSecret: next.secret,
          withdrawn: leaf.value,
          context: binding.context,
        };
        const made = over.prove ? await over.prove(args) : await poolProveWithdraw(over.prover ?? (await exitProver()), args);
        const s = made.publicSignals;
        if (dec(s[2]) !== leaf.value || dec(s[7]) !== binding.context) stop("the proof's signals are not this release's");
        const depth = (x: unknown): number => {
          const d = dec(x);
          return d <= 32n ? Number(d) : stop("a tree depth over 32");
        };
        // each root's index: the root a page holds after its last leaf, so the tree's size less one (solana.ts trees
        // checks that root against the page's at that leaf on both RPCs)
        const release: SolanaPoolRelease = {
          proof: proofBytes(made.proof),
          newCommitmentHash: be32(dec(s[0])),
          existingNullifierHash: be32(dec(s[1])),
          withdrawnValue: leaf.value,
          stateRootIndex: t.stateTree.size - 1,
          stateTreeDepth: depth(s[4]),
          labelRootIndex: t.labelTree.size - 1,
          labelTreeDepth: depth(s[6]),
          relayFee: q.relayFee,
          relayFeeCap: q.relayFeeCap,
          tipCap: q.tipCap,
          deadlineMs: q.deadlineMs,
          salt: Uint8Array.from(q.salt.match(/../g)!.map((x) => parseInt(x, 16))),
        };
        const stateSize = await stateSizeOf(rpcs, program, poolAccount);
        const accounts = solanaPoolTag2Accounts({ program, pool: poolAccount }, w.address, F, release, stateSize);
        // F is the words' own wallet (the address a standard wallet shows for them), so it may be the typed address
        const releaseAccounts = accounts.map((a) => a.key).filter((k) => k !== F);
        if (releaseAccounts.includes(to)) throw new ExitSolRefused(`the Solana address ${to} is an account of the release`);
        const bh = await blockhashOf(rpcs);
        const ixs = [
          { program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.of(2, ...u32le(SOL_EXIT_RELEASE_CU)) },
          { program, accounts, data: solanaEncodePoolRelease(release) },
        ];
        const { message } = solanaCompileV0(F, ixs, bh.blockhash, [], [F, w.address]);
        // the two signers in the message's order: F (fee payer) first, then W (the recipient, release.rs:150-152)
        const keys = solanaDecodeTransaction(wireOf(message, [new Uint8Array(64), new Uint8Array(64)])).message;
        if (keys.requiredSignatures !== 2 || keys.staticKeys[0] !== F || keys.staticKeys[1] !== w.address) stop("the release's signers are not F then W");

        const fk = solFeeWallet(ctx.seed);
        const wk = freshWallet(ctx.seed, "sol", l, j);
        let sigs: Uint8Array[];
        try {
          if (fk.address !== F || wk.address !== w.address) stop("a signer is not the one the bytes were built for");
          sigs = [ed25519.sign(message, fk.secretKey), ed25519.sign(message, wk.secretKey)];
        } finally {
          fk.secretKey.fill(0);
          wk.secretKey.fill(0);
        }
        const signed = wireOf(message, sigs);
        const signature = b58encode(sigs[0]!);
        const got = await sendAndRead(rpcs, signed, signature, bh.lastHeight, sleep);
        if (got !== "ok") stop(`the release ${signature} ${got === "failed" ? "failed" : "did not land"}`);
        txs.push(signature);
        left -= leaf.value;
        ctx.say(`released ${units(leaf.value, 9)} SOL to ${w.address}: tx ${signature}`);

        const on = await sendOnward(rpcs, ctx.seed, l, j, to, sleep, releaseAccounts.filter((k) => k !== w.address));
        if (on === null) stop(`W ${w.address} reads empty after its release`);
        txs.push(on!.signature);
        sent += on!.amount;
        ctx.say(`sent ${units(on!.amount, 9)} SOL to ${to}: tx ${on!.signature}`);
      }
    } catch (e) {
      fail(e);
    }
    return { chain: "solana", txs, sent: sent.toString(), left: left.toString() };
  };
}

/** The Solana pool's ExitChain. */
export const solExit: ExitChain = solExitWith();
