// POST /v1/pool/solana/send (card helper-pool-senders; v2 M3): the helper's Solana fee payer carries a pool release W
// signed, exactly as signed, or refuses it. It adds its own signature in slot 0 and nothing else, after the checks and a
// simulation, and sends through the kit's Solana sender (sendSolanaSet). The fee payer is an operating key holding only
// gas, read from the host's environment; it is paid back by the release's relay_fee, which the checks hold to the
// published fee (./fee.ts) and to the fee payer's worst cost, so carrying a release never spends the helper's own funds
// beyond gas.
//
// The body: { "pool": "<the pool account>", "tx": "<base64 of the v0 transaction>" }, slot 0 (the fee payer's) all zero, slot 1 W's signature.
// Checks, each a refusal before any send (422 unless named):
//   bad_shape           not one v0 transaction of two signers (the fee payer first and writable, W second and
//                       writable), slot 0 not zero, or over SOLANA_MAX_TX_BYTES (400);
//   bad_signature       W's signature does not verify over the message bytes: any byte changed after W signed;
//   not_pool            the instruction after the compute budget is not the configured pool program's tag 2 or tag 3,
//                       or its first account is not the pool;
//   extra_instruction   any instruction other than at most one compute unit limit and one compute unit price, before
//                       exactly one pool instruction;
//   fee_payer_named     the fee payer named anywhere but the payer (key 0) and the pool instruction's account 2: as a
//                       program, another account of any instruction, or an account a tag 3 inner instruction names
//                       (lookup tables cannot name it: the runtime refuses a key loaded twice);
//   fee_off             relay_fee is not the fee this helper publishes for the pool;
//   fee_below_cost      relay_fee under the fee payer's cost of a release (SOLANA_RELEASE_COST, 1,026,000) plus the
//                       priority fee W set; a release whose change opens a page costs 731,520 more and is carried;
//   simulation_failed   the simulation of W's transaction (no signature check, its own blockhash) failed;
//   upstream (503)      the simulation or the blockhash read could not be made.
// Answer: 200 { signature } (the fee payer's, the transaction id). The device reads the fill itself.
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_MAX_TX_BYTES,
  SOLANA_POOL_TAG3_MAX_INNER,
  SOLANA_POOL_TAG_RELEASE,
  SOLANA_POOL_TAG_RELEASE_AND_BUY,
  sendSolanaSet,
  solanaDecodePoolRelease,
  solanaDecodeTransaction,
  solanaJsonRpc,
  solanaPoolAccount,
  type SolanaRpc,
  type SolanaSendPath,
  type SolanaSignedTx,
} from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import { base58decode } from "../bind/send.ts";
import { oncePerNullifier } from "./once.ts";
import { epochStartOf, POOL_EPOCH_MS, POOL_FEE_STEP, SOLANA_RELEASE_COST, solanaPoolFee, type PoolFeeAnswer } from "./fee.ts";

/** POST /v1/pool/solana/send's body limit: a 1,232-byte transaction in base64 and the JSON around it. */
export const POOL_SOLANA_BODY_MAX = 4_096;
const RAW_LEN = 387; // tag 2's data; tag 3's bytes 2 to 387 are the same run (contracts/pool-solana/TAG3.md)
const PROOF_RAW = 256;
const PROOF_COMPRESSED = 128;
const FIELDS = RAW_LEN - 1 - PROOF_RAW; // 130: newCommitmentHash to salt
const RELAY_FEE_AT = 32 + 32 + 8 + 4 + 1 + 4 + 1; // in the fields run
const DEFAULT_CU_PER_IX = 200_000n; // the runtime's limit per instruction when no SetComputeUnitLimit is given
const MICRO = 1_000_000n;

export type PoolSendCode =
  | "bad_shape"
  | "bad_signature"
  | "not_pool"
  | "extra_instruction"
  | "fee_payer_named"
  | "fee_off"
  | "fee_below_cost"
  | "simulation_failed"
  | "upstream";
export type PoolSendAnswer = { status: number; body: { signature: string } | { error: { code: PoolSendCode; detail?: string } } };

/** What a pool instruction carries that the checks read: its tag, its relay fee and the accounts tag 3's inner instructions name. */
export type SolanaPoolIx = { tag: 2 | 3; relayFee: bigint; nullifier: string; innerAccounts: number[]; innerPrograms: number[] };

/** Tag 2's or tag 3's data, read; throws on any layout TAG3.md and release.rs do not allow. */
export function solanaReadPoolIx(d: Uint8Array): SolanaPoolIx {
  if (d[0] === SOLANA_POOL_TAG_RELEASE) {
    const r = solanaDecodePoolRelease(d); // exactly 387 bytes
    return { tag: 2, relayFee: r.relayFee, nullifier: Buffer.from(r.existingNullifierHash).toString("hex"), innerAccounts: [], innerPrograms: [] };
  }
  if (d[0] !== SOLANA_POOL_TAG_RELEASE_AND_BUY || d.length < 2) throw new Error("not tag 2 or tag 3");
  const flags = d[1]!;
  if ((flags & ~1) !== 0) throw new Error("tag 3 flags other than bit 0");
  const proof = flags & 1 ? PROOF_COMPRESSED : PROOF_RAW;
  const fieldsAt = 2 + proof;
  const tipAt = fieldsAt + FIELDS;
  if (d.length < tipAt + 9) throw new Error("tag 3 too short");
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const relayFee = v.getBigUint64(fieldsAt + RELAY_FEE_AT, true);
  const count = d[tipAt + 8]!;
  if (count < 1 || count > SOLANA_POOL_TAG3_MAX_INNER) throw new Error("tag 3 inner count out of 1 to 8");
  let at = tipAt + 9;
  const innerAccounts: number[] = [];
  const innerPrograms: number[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 2 > d.length) throw new Error("tag 3 inner instruction truncated");
    innerPrograms.push(d[at]!);
    const n = d[at + 1]!;
    at += 2;
    if (at + n + 2 > d.length) throw new Error("tag 3 inner accounts truncated");
    innerAccounts.push(...d.subarray(at, at + n));
    at += n;
    const len = v.getUint16(at, true);
    at += 2 + len;
    if (at > d.length) throw new Error("tag 3 inner data truncated");
  }
  if (at !== d.length) throw new Error("tag 3 bytes after the last inner instruction");
  return { tag: 3, relayFee, nullifier: Buffer.from(d.subarray(fieldsAt + 32, fieldsAt + 64)).toString("hex"), innerAccounts, innerPrograms };
}

/** The priority fee W set, lamports: price (micro-lamports per CU) x limit, rounded up, as the runtime charges it. */
const priorityFee = (price: bigint, limit: bigint): bigint => (price * limit + MICRO - 1n) / MICRO;

/** A transaction that passed every check: its bytes, its message, W, its relay fee and its nullifier hash (64 hex). */
export type SolanaPoolChecked = { wire: Uint8Array; messageBytes: Uint8Array; w: string; relayFee: bigint; nullifier: string };
export type SolanaPoolCheck = { ok: true; tx: SolanaPoolChecked } | { ok: false; status: number; code: PoolSendCode; detail?: string };

/** Every check before the simulation, on the bytes as received. Pure: no read, no clock. */
export function checkSolanaPoolTx(wire: Uint8Array, cfg: { program: string; pool: string; feePayer: string; fee: bigint }): SolanaPoolCheck {
  const no = (code: PoolSendCode, detail?: string, status = 422): SolanaPoolCheck => ({ ok: false, status, code, ...(detail ? { detail } : {}) });
  if (wire.length > SOLANA_MAX_TX_BYTES) return no("bad_shape", "over 1,232 bytes", 400);
  let tx;
  try {
    tx = solanaDecodeTransaction(wire);
  } catch {
    return no("bad_shape", "not one v0 transaction", 400);
  }
  const m = tx.message;
  if (tx.signatures !== 2 || m.readonlySigned !== 0) return no("bad_shape", "not two writable signers", 400);
  if (m.staticKeys[0] !== cfg.feePayer) return no("bad_shape", "the payer is not this helper's fee payer", 400);
  // wire: compact(2) = 1 byte, then slot 0 (the fee payer's) and slot 1 (W's)
  if (wire.subarray(1, 65).some((b) => b !== 0)) return no("bad_shape", "the fee payer's slot is not empty", 400);
  const w = m.staticKeys[1]!;
  let good = false;
  try {
    good = ed25519.verify(wire.subarray(65, 129), tx.messageBytes, base58decode(w));
  } catch {
    good = false;
  }
  if (!good) return no("bad_signature");

  const ixs = m.instructions;
  const keyOf = (i: number): string | undefined => m.staticKeys[i]; // programs are static keys (a v0 message cannot invoke a loaded one)
  let limit: bigint | null = null;
  let price: bigint | null = null;
  let k = 0;
  for (; k < ixs.length && keyOf(ixs[k]!.programIndex) === SOLANA_COMPUTE_BUDGET_PROGRAM; k++) {
    const { accounts, data } = ixs[k]!;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (accounts.length === 0 && data.length === 5 && data[0] === 2 && limit === null) limit = BigInt(dv.getUint32(1, true));
    else if (accounts.length === 0 && data.length === 9 && data[0] === 3 && price === null) price = dv.getBigUint64(1, true);
    else return no("extra_instruction", "a compute budget instruction other than one limit and one price");
  }
  if (ixs.length !== k + 1) return no("extra_instruction", "not exactly one instruction after the compute budget");
  const pix = ixs[k]!;
  if (pix.programIndex === 0) return no("fee_payer_named", "as a program");
  if (keyOf(pix.programIndex) !== cfg.program) return no("not_pool", "another program");
  let p: SolanaPoolIx;
  try {
    p = solanaReadPoolIx(pix.data);
  } catch (e) {
    return no("not_pool", (e as Error).message);
  }
  if (pix.accounts.length < 8 || (p.tag === 2 && pix.accounts.length !== 8)) return no("not_pool", "not the release's accounts");
  const poolKey = keyOf(pix.accounts[0]!);
  if (pix.accounts[0]! < m.staticKeys.length && poolKey !== cfg.pool) return no("not_pool", "another pool");
  if (pix.accounts[1] !== 1) return no("bad_shape", "account 1 is not W", 400);
  if (pix.accounts[2] !== 0) return no("fee_payer_named", "the pool's account 2 is not the fee payer");
  if (pix.accounts.some((a, i) => a === 0 && i !== 2)) return no("fee_payer_named", "as another pool account");
  // tag 3's inner instructions index this instruction's accounts: position 2 is the fee payer
  if (p.innerAccounts.includes(2) || p.innerPrograms.includes(2)) return no("fee_payer_named", "in an inner instruction");
  if ([...p.innerAccounts, ...p.innerPrograms].some((i) => i >= pix.accounts.length)) return no("not_pool", "an inner index past the accounts");

  if (p.relayFee !== cfg.fee) return no("fee_off", `relay_fee ${p.relayFee}, published ${cfg.fee}`);
  const cost = SOLANA_RELEASE_COST + priorityFee(price ?? 0n, limit ?? DEFAULT_CU_PER_IX);
  if (p.relayFee < cost) return no("fee_below_cost", `relay_fee ${p.relayFee}, cost ${cost}`);
  return { ok: true, tx: { wire, messageBytes: tx.messageBytes, w, relayFee: p.relayFee, nullifier: p.nullifier } };
}

/** The fee payer's signature in slot 0; every other byte as received (checked, so a change here throws, never sends). */
export function signAsFeePayer(tx: SolanaPoolChecked, seed: Uint8Array): Uint8Array {
  const out = tx.wire.slice();
  out.set(ed25519.sign(tx.messageBytes, seed), 1);
  if (out.length !== tx.wire.length || out.some((b, i) => (i < 1 || i >= 65) && b !== tx.wire[i])) throw new Error("the signed bytes differ from W's");
  return out;
}

export type SolanaPoolSenderDeps = {
  /** Provider A (simulation, blockhash height) and provider B: the kit's sender reads fills on both. */
  providers: readonly [SolanaRpc, SolanaRpc];
  /** Where the signed transaction goes; default sendTransaction on both providers. */
  paths?: readonly SolanaSendPath[];
  /** The kit's sender; replaced in tests. */
  send?: typeof sendSolanaSet;
  /** How many nullifiers ./once.ts remembers (POOL_SEND_MEMORY). */
  memory?: number;
};

export type SolanaPoolSender = {
  readonly cluster: string;
  readonly program: string;
  readonly pool: string;
  readonly feePayer: string;
  /** GET /v1/pool/fee: the fee for the epoch holding `atMs`; the same for every caller. */
  fee(atMs: number): PoolFeeAnswer;
  /** POST /v1/pool/solana/send for a parsed body. */
  carry(body: unknown): Promise<PoolSendAnswer>;
};

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The fee payer's key: base58 of 64 bytes (seed then public key, the Solana CLI's keypair), its public half checked. */
export function feePayerKey(secret: string): { seed: Uint8Array; address: string } {
  let b: Uint8Array;
  try {
    b = base58decode(secret);
  } catch {
    throw new Error("fee payer key: not base58");
  }
  if (b.length !== 64) throw new Error("fee payer key: not 64 bytes");
  const seed = b.slice(0, 32);
  const pub = ed25519.getPublicKey(seed);
  if (!pub.every((x, i) => x === b[32 + i])) throw new Error("fee payer key: its public half is not its seed's");
  return { seed, address: base58(pub) };
}

export function solanaPoolSender(cfg: { cluster: string; program: string; feePayerSecret: string; fee: bigint }, deps: SolanaPoolSenderDeps): SolanaPoolSender {
  const { seed, address: feePayer } = feePayerKey(cfg.feePayerSecret);
  const pool = solanaPoolAccount(cfg.program);
  const fee = cfg.fee;
  if (fee % POOL_FEE_STEP !== 0n) throw new Error("the fee is not on its step");
  const [a, b] = deps.providers;
  const send = deps.send ?? sendSolanaSet;
  const paths: readonly SolanaSendPath[] =
    deps.paths ??
    deps.providers.map((rpc, i) => ({
      name: `rpc${i}`,
      send: async (tx: string) => String(await rpc("sendTransaction", [tx, { encoding: "base64", skipPreflight: true, maxRetries: 0 }])),
    }));
  const no = (status: number, code: PoolSendCode, detail?: string): PoolSendAnswer => ({ status, body: { error: { code, ...(detail ? { detail } : {}) } } });
  const once = oncePerNullifier<PoolSendAnswer>(deps.memory);
  return {
    cluster: cfg.cluster,
    program: cfg.program,
    pool,
    feePayer,
    fee: (atMs) => ({
      chain: "solana",
      cluster: cfg.cluster,
      program: cfg.program,
      pool,
      fee_payer: feePayer,
      epoch_ms: POOL_EPOCH_MS,
      epoch_start_ms: epochStartOf(atMs),
      fee: fee.toString(),
      step: POOL_FEE_STEP.toString(),
    }),
    async carry(body) {
      if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 2 || (body as { pool?: unknown }).pool !== pool) return no(400, "bad_shape");
      const raw = (body as { tx?: unknown }).tx;
      if (typeof raw !== "string" || raw.length > 1_644 || !B64.test(raw)) return no(400, "bad_shape");
      const wire = new Uint8Array(Buffer.from(raw, "base64"));
      if (Buffer.from(wire).toString("base64") !== raw) return no(400, "bad_shape");
      const c = checkSolanaPoolTx(wire, { program: cfg.program, pool, feePayer, fee });
      if (!c.ok) return no(c.status, c.code, c.detail);
      // one send per nullifier (./once.ts): a repeat gets the first answer and sends nothing
      return once.run(c.tx.nullifier, () => simulateSignSend(raw, c.tx));
    },
  };
  async function simulateSignSend(raw: string, tx: SolanaPoolChecked): Promise<PoolSendAnswer> {
      // the simulation of W's bytes as received (slot 0 empty, so no signature check), on its own blockhash; and the
      // newest blockhash's last valid height, which bounds how long the sender rebroadcasts (W's is no newer)
      let sim: unknown;
      let height: number;
      try {
        const [s, h] = await Promise.all([
          a("simulateTransaction", [raw, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "processed" }]),
          a("getLatestBlockhash", [{ commitment: "processed" }]),
        ]);
        sim = s;
        height = (h as { value?: { lastValidBlockHeight?: unknown } })?.value?.lastValidBlockHeight as number;
      } catch {
        return no(503, "upstream");
      }
      const v = (sim as { value?: { err?: unknown } } | null)?.value;
      if (typeof v !== "object" || v === null || !("err" in v)) return no(503, "upstream");
      if (v.err !== null) return no(422, "simulation_failed", JSON.stringify(v.err).slice(0, 200));
      if (!Number.isSafeInteger(height) || height <= 0) return no(503, "upstream");
      const signed: SolanaSignedTx = { wire: signAsFeePayer(tx, seed), lastValidBlockHeight: height };
      const h = send([signed], { paths, providers: [a, b] });
      // a send the chain ended without the spend (failed, or its blockhash expired) frees the nullifier for a retry
      void h.done
        .then((r) => {
          const state = r.txs[0]?.state;
          if (state === "failed" || state === "expired") once.forget(tx.nullifier);
        })
        .catch(() => {});
      return { status: 200, body: { signature: h.signatures[0]! } };
  }
}

/** Per cluster: the pool program, the fee payer's key, the fee (lamports) and two RPC URLs ("a,b"). */
export const POOL_SOLANA_ENV = {
  mainnet: ["POOL_SOLANA_PROGRAM_MAINNET", "POOL_SOLANA_FEE_PAYER_KEY_MAINNET", "POOL_SOLANA_FEE_MAINNET", "POOL_SOLANA_RPCS_MAINNET"],
  devnet: ["POOL_SOLANA_PROGRAM_DEVNET", "POOL_SOLANA_FEE_PAYER_KEY_DEVNET", "POOL_SOLANA_FEE_DEVNET", "POOL_SOLANA_RPCS_DEVNET"],
} as const;

/** The Solana pool senders the host's environment sets, by pool address; a cluster with none of its names set is off. */
export function solanaPoolSendersFromEnv(env: Record<string, string | undefined>, fetchFn?: typeof fetch): Map<string, SolanaPoolSender> {
  const out = new Map<string, SolanaPoolSender>();
  for (const [cluster, names] of Object.entries(POOL_SOLANA_ENV)) {
    const [program, key, fee, rpcs] = names.map((n) => env[n] ?? "");
    if (program === "" && key === "" && fee === "" && rpcs === "") continue;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(program!)) throw new Error(`${names[0]} must be a program id`);
    const urls = rpcs!.split(",");
    if (urls.length !== 2 || urls[0] === urls[1]) throw new Error(`${names[3]} must be two different RPC URLs`);
    const providers = urls.map((u) => solanaJsonRpc(u, fetchFn ? { fetch: fetchFn } : {})) as unknown as readonly [SolanaRpc, SolanaRpc];
    const s = solanaPoolSender({ cluster, program: program!, feePayerSecret: key!, fee: solanaPoolFee(fee!, names[2]) }, { providers });
    out.set(s.pool, s);
  }
  return out;
}
