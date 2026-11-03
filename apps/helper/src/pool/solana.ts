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
//   fee_below_cost      the priority fee W set (CU limit x price) over the kit's solanaPoolPriorityBudget: the fee
//                       less the release's cost and the page reserve (M355, M356 (5));
//   no_cu_limit         a compute unit price without a compute unit limit (the runtime's default limit is not ours
//                       to guess, so the priority fee would be unbounded by what the helper priced);
//   deadline_near       the release's deadline is under now plus the kit's SOLANA_POOL_SEND_MARGIN_MS (M356 (1)): a send
//                       that cannot land before it would only be a paid failure;
//   inner_program       a tag 3 inner instruction invokes a program off the kit's SOLANA_POOL_STEP_PROGRAMS (helper
//                       policy, M356 (1): a program W chose could fail on chain after passing the simulation);
//   bad_table           a lookup table the message loads is not an active table both providers read the same at
//                       every index used (read only when the message has lookups; at most SOLANA_POOL_LOOKUPS_MAX);
//   failed_this_epoch   this nullifier's send already failed on chain in this epoch (M356 (1): at most one paid
//                       failure per nullifier per epoch);
//   simulation_failed   the simulation of W's transaction (no signature check, its own blockhash) failed;
//   upstream (503)      the simulation or the blockhash read could not be made.
// Answer: 200 { signature } (the fee payer's, the transaction id). The device reads the fill itself.
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  SOLANA_ALT_PROGRAM,
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_MAX_TX_BYTES,
  SOLANA_POOL_SEND_MARGIN_MS,
  SOLANA_POOL_STEP_PROGRAMS,
  SOLANA_POOL_TAG3_MAX_INNER,
  SOLANA_POOL_TAG_RELEASE,
  SOLANA_POOL_TAG_RELEASE_AND_BUY,
  sendSolanaSet,
  solanaDecodeLookupTable,
  solanaDecodePoolRelease,
  solanaDecodeTransaction,
  solanaJsonRpc,
  readSolanaRent,
  solanaPoolAccount,
  solanaPoolPriorityBudget,
  solanaResolveKeys,
  solanaTableIsActive,
  type SolanaLookupTable,
  type SolanaMessage,
  type SolanaRent,
  type SolanaRpc,
  type SolanaSendPath,
  type SolanaSignedTx,
} from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import { base58decode } from "../bind/send.ts";
import { oncePerNullifier } from "./once.ts";
import { epochStartOf, POOL_EPOCH_MS, POOL_FEE_STEP, solanaConfiguredFee, type PoolFeeAnswer } from "./fee.ts";

/** POST /v1/pool/solana/send's body limit: a 1,232-byte transaction in base64 and the JSON around it. */
export const POOL_SOLANA_BODY_MAX = 4_096;
const RAW_LEN = 387; // tag 2's data; tag 3's bytes 2 to 387 are the same run (contracts/pool-solana/TAG3.md)
const PROOF_RAW = 256;
const PROOF_COMPRESSED = 128;
const FIELDS = RAW_LEN - 1 - PROOF_RAW; // 130: newCommitmentHash to salt
const RELAY_FEE_AT = 32 + 32 + 8 + 4 + 1 + 4 + 1; // in the fields run
const MICRO = 1_000_000n;
const DEADLINE_AT = RELAY_FEE_AT + 8 + 8 + 8; // after relay_fee, relay_fee_cap and tip_cap
/** The most lookup tables one carried message may load [design: the kit's buy loads one; four bounds the reads]. */
export const SOLANA_POOL_LOOKUPS_MAX = 4;

export type PoolSendCode =
  | "bad_shape"
  | "bad_signature"
  | "not_pool"
  | "extra_instruction"
  | "fee_payer_named"
  | "fee_off"
  | "fee_below_cost"
  | "no_cu_limit"
  | "deadline_near"
  | "inner_program"
  | "bad_table"
  | "failed_this_epoch"
  | "simulation_failed"
  | "upstream";
export type PoolSendAnswer = { status: number; body: { signature: string } | { error: { code: PoolSendCode; detail?: string } } };

/** What a pool instruction carries that the checks read: its tag, its relay fee and the accounts tag 3's inner instructions name. */
export type SolanaPoolIx = { tag: 2 | 3; relayFee: bigint; deadlineMs: bigint; nullifier: string; innerAccounts: number[]; innerPrograms: number[] };

/** Tag 2's or tag 3's data, read; throws on any layout TAG3.md and release.rs do not allow. */
export function solanaReadPoolIx(d: Uint8Array): SolanaPoolIx {
  if (d[0] === SOLANA_POOL_TAG_RELEASE) {
    const r = solanaDecodePoolRelease(d); // exactly 387 bytes
    return { tag: 2, relayFee: r.relayFee, deadlineMs: r.deadlineMs, nullifier: Buffer.from(r.existingNullifierHash).toString("hex"), innerAccounts: [], innerPrograms: [] };
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
  return { tag: 3, relayFee, deadlineMs: v.getBigUint64(fieldsAt + DEADLINE_AT, true), nullifier: Buffer.from(d.subarray(fieldsAt + 32, fieldsAt + 64)).toString("hex"), innerAccounts, innerPrograms };
}

/** The priority fee W set, lamports: price (micro-lamports per CU) x limit, rounded up, as the runtime charges it. */
const priorityFee = (price: bigint, limit: bigint): bigint => (price * limit + MICRO - 1n) / MICRO;

/** A transaction that passed every check: its bytes, its message, W, its relay fee and its nullifier hash (64 hex). */
export type SolanaPoolChecked = {
  wire: Uint8Array;
  messageBytes: Uint8Array;
  w: string;
  relayFee: bigint;
  deadlineMs: bigint;
  nullifier: string;
  /** The message, and the message indexes a loaded key must resolve to: the pool (account 0) and every inner program. */
  message: SolanaMessage;
  poolIndex: number;
  innerProgramIndexes: number[];
};
export type SolanaPoolCheck = { ok: true; tx: SolanaPoolChecked } | { ok: false; status: number; code: PoolSendCode; detail?: string };

/** Every check before any read, on the bytes as received and the caller's clock. Pure: no read. */
export function checkSolanaPoolTx(wire: Uint8Array, cfg: { program: string; pool: string; feePayer: string; fee: bigint; budget: bigint; nowMs: number }): SolanaPoolCheck {
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
  if (m.lookups.length > SOLANA_POOL_LOOKUPS_MAX) return no("bad_shape", `more than ${SOLANA_POOL_LOOKUPS_MAX} lookup tables`, 400);
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
  if (price !== null && limit === null) return no("no_cu_limit", "a compute unit price needs a compute unit limit");
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
  // the pool at account 0: a static key here, a loaded one once its table is read (checkSolanaPoolKeys)
  if (pix.accounts[0]! < m.staticKeys.length && keyOf(pix.accounts[0]!) !== cfg.pool) return no("not_pool", "another pool");
  if (pix.accounts[1] !== 1) return no("bad_shape", "account 1 is not W", 400);
  if (pix.accounts[2] !== 0) return no("fee_payer_named", "the pool's account 2 is not the fee payer");
  if (pix.accounts.some((a, i) => a === 0 && i !== 2)) return no("fee_payer_named", "as another pool account");
  // tag 3's inner instructions index this instruction's accounts: position 2 is the fee payer
  if (p.innerAccounts.includes(2) || p.innerPrograms.includes(2)) return no("fee_payer_named", "in an inner instruction");
  if ([...p.innerAccounts, ...p.innerPrograms].some((i) => i >= pix.accounts.length)) return no("not_pool", "an inner index past the accounts");

  if (p.relayFee !== cfg.fee) return no("fee_off", `relay_fee ${p.relayFee}, published ${cfg.fee}`);
  const priority = priorityFee(price ?? 0n, limit ?? 0n); // a price comes with a limit (no_cu_limit)
  if (priority > cfg.budget) return no("fee_below_cost", `priority ${priority}, budget ${cfg.budget}`);
  if (p.deadlineMs < BigInt(cfg.nowMs) + SOLANA_POOL_SEND_MARGIN_MS) return no("deadline_near", `deadline ${p.deadlineMs}, now ${cfg.nowMs}`);
  // tag 3's inner programs, by their message index; a static one is checked now, a loaded one after its table's read
  const innerProgramIndexes = p.innerPrograms.map((i) => pix.accounts[i]!);
  if (innerProgramIndexes.some((i) => i < m.staticKeys.length && !SOLANA_POOL_STEP_PROGRAMS.includes(m.staticKeys[i]!))) return no("inner_program", "an inner instruction invokes a program off the kit's list");
  const checked: SolanaPoolChecked = { wire, messageBytes: tx.messageBytes, w, relayFee: p.relayFee, deadlineMs: p.deadlineMs, nullifier: p.nullifier, message: m, poolIndex: pix.accounts[0]!, innerProgramIndexes };
  return { ok: true, tx: checked };
}

/**
 * The checks on keys the message loads from lookup tables, once the tables are read: the pool at account 0 and every
 * inner program on the kit's list. `tables` holds each table the message names, as both providers answered.
 */
export function checkSolanaPoolKeys(tx: SolanaPoolChecked, cfg: { pool: string }, tables: Readonly<Record<string, readonly [SolanaLookupTable | null, SolanaLookupTable | null]>>): { ok: true } | { ok: false; code: PoolSendCode; detail: string } {
  const m = tx.message;
  const one: Record<string, SolanaLookupTable> = {};
  for (const l of m.lookups) {
    const [a, b] = Object.hasOwn(tables, l.table) ? tables[l.table]! : [null, null];
    if (!a || !b) return { ok: false, code: "bad_table", detail: `${l.table} is not a table on both providers` };
    if (!solanaTableIsActive(a) || !solanaTableIsActive(b)) return { ok: false, code: "bad_table", detail: `${l.table} is deactivated` };
    if ([...l.writable, ...l.readonly].some((i) => a.addresses[i] === undefined || a.addresses[i] !== b.addresses[i])) return { ok: false, code: "bad_table", detail: `${l.table}: the providers disagree or an index is past its end` };
    one[l.table] = a;
  }
  let keys: string[];
  try {
    keys = solanaResolveKeys(m, one).map((k) => k.key);
  } catch (e) {
    return { ok: false, code: "bad_table", detail: (e as Error).message };
  }
  if (keys[tx.poolIndex] !== cfg.pool) return { ok: false, code: "not_pool", detail: "another pool" };
  if (tx.innerProgramIndexes.some((i) => !SOLANA_POOL_STEP_PROGRAMS.includes(keys[i]!))) return { ok: false, code: "inner_program", detail: "an inner instruction invokes a program off the kit's list" };
  return { ok: true };
}

/** A lookup table as one provider answers getAccountInfo (base64): null when absent or not owned by the table program. */
function tableOf(value: unknown): SolanaLookupTable | null {
  const v = (value as { value?: { owner?: unknown; data?: unknown } } | null)?.value;
  if (!v || v.owner !== SOLANA_ALT_PROGRAM || !Array.isArray(v.data) || v.data[1] !== "base64" || typeof v.data[0] !== "string") return null;
  try {
    return solanaDecodeLookupTable(new Uint8Array(Buffer.from(v.data[0], "base64")));
  } catch {
    return null;
  }
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
  /** The clock, ms; replaced in tests. */
  now?: () => number;
  /** The rent, when the caller read it already (tests); else read on both providers at start. */
  rent?: SolanaRent;
};

export type SolanaPoolSender = {
  readonly cluster: string;
  readonly program: string;
  readonly pool: string;
  readonly feePayer: string;
  /** Settles once the Rent sysvar is read on both providers and the fee is the kit's for it; rejects otherwise, and the
   * helper does not start (server.ts awaits it). */
  readonly ready: Promise<void>;
  /** GET /v1/pool/fee: the fee for the epoch holding `atMs`; the same for every caller. Throws before `ready`. */
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

export function solanaPoolSender(cfg: { cluster: string; program: string; feePayerSecret: string; fee: string }, deps: SolanaPoolSenderDeps): SolanaPoolSender {
  const { seed, address: feePayer } = feePayerKey(cfg.feePayerSecret);
  const pool = solanaPoolAccount(cfg.program);
  const [a, b] = deps.providers;
  // M356 (6): the fee and the priority budget from the kit's one definition, for the rent both providers read now
  let fee: bigint | null = null;
  let budget = 0n;
  const take = (rent: SolanaRent) => {
    fee = solanaConfiguredFee(cfg.fee, rent, `the ${cfg.cluster} pool fee`);
    budget = solanaPoolPriorityBudget(rent, fee);
  };
  if (deps.rent) take(deps.rent);
  // else read once, on the first ask (server.ts asks at start), so building a sender reads nothing
  let readyP: Promise<void> | null = deps.rent ? Promise.resolve() : null;
  const ready = (): Promise<void> => (readyP ??= readSolanaRent([a, b]).then(take));
  const feeNow = (): bigint => {
    if (fee === null) throw new Error("the pool fee is not read yet");
    return fee;
  };
  const send = deps.send ?? sendSolanaSet;
  const paths: readonly SolanaSendPath[] =
    deps.paths ??
    deps.providers.map((rpc, i) => ({
      name: `rpc${i}`,
      send: async (tx: string) => String(await rpc("sendTransaction", [tx, { encoding: "base64", skipPreflight: true, maxRetries: 0 }])),
    }));
  const no = (status: number, code: PoolSendCode, detail?: string): PoolSendAnswer => ({ status, body: { error: { code, ...(detail ? { detail } : {}) } } });
  const once = oncePerNullifier<PoolSendAnswer>(deps.memory);
  const now = deps.now ?? Date.now;
  // M356 (1)/(2): a nullifier whose send failed on chain waits for the next epoch; one whose outcome is unknown is held
  // until its deadline (after it the release cannot land). Both bounded like once's memory.
  const failedIn = new Map<string, number>();
  const heldUntil = new Map<string, { entry: Promise<PoolSendAnswer> | undefined; deadline: number }>();
  const bounded = <V>(m: Map<string, V>, k: string, v: V) => {
    m.delete(k);
    m.set(k, v);
    while (m.size > (deps.memory ?? 10_000)) m.delete(m.keys().next().value as string);
  };
  return {
    cluster: cfg.cluster,
    program: cfg.program,
    pool,
    feePayer,
    get ready() {
      return ready();
    },
    fee: (atMs) => ({
      chain: "solana",
      cluster: cfg.cluster,
      program: cfg.program,
      pool,
      fee_payer: feePayer,
      epoch_ms: POOL_EPOCH_MS,
      epoch_start_ms: epochStartOf(atMs),
      fee: feeNow().toString(),
      step: POOL_FEE_STEP.toString(),
    }),
    async carry(body) {
      if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 2 || (body as { pool?: unknown }).pool !== pool) return no(400, "bad_shape");
      const raw = (body as { tx?: unknown }).tx;
      if (typeof raw !== "string" || raw.length > 1_644 || !B64.test(raw)) return no(400, "bad_shape");
      const wire = new Uint8Array(Buffer.from(raw, "base64"));
      if (Buffer.from(wire).toString("base64") !== raw) return no(400, "bad_shape");
      if (fee === null) {
        try {
          await ready();
        } catch {
          return no(503, "upstream");
        }
      }
      const at = now();
      const c = checkSolanaPoolTx(wire, { program: cfg.program, pool, feePayer, fee: feeNow(), budget, nowMs: at });
      if (!c.ok) return no(c.status, c.code, c.detail);
      const nf = c.tx.nullifier;
      const failed = failedIn.get(nf);
      if (failed !== undefined) {
        if (failed === epochStartOf(at)) return no(422, "failed_this_epoch");
        failedIn.delete(nf);
      }
      const held = heldUntil.get(nf);
      if (held !== undefined && at >= held.deadline) {
        heldUntil.delete(nf);
        if (once.get(nf) === held.entry) once.forget(nf);
      }
      // one send per nullifier (./once.ts): a repeat gets the first answer and sends nothing
      return once.run(nf, () => simulateSignSend(raw, c.tx));
    },
  };
  async function simulateSignSend(raw: string, tx: SolanaPoolChecked): Promise<PoolSendAnswer> {
      // the simulation of W's bytes as received (slot 0 empty, so no signature check), on its own blockhash; and the
      // newest blockhash's last valid height, which bounds how long the sender rebroadcasts (W's is no newer)
      // a message that loads keys: its tables on both providers first, then the pool and inner programs they resolve to
      if (tx.message.lookups.length > 0) {
        const tables: Record<string, readonly [SolanaLookupTable | null, SolanaLookupTable | null]> = {};
        try {
          await Promise.all(
            tx.message.lookups.map(async (l) => {
              const read = (rpc: SolanaRpc) => rpc("getAccountInfo", [l.table, { encoding: "base64", commitment: "processed" }]);
              const [x, y] = await Promise.all([read(a), read(b)]);
              tables[l.table] = [tableOf(x), tableOf(y)];
            }),
          );
        } catch {
          return no(503, "upstream");
        }
        const k = checkSolanaPoolKeys(tx, { pool }, tables);
        if (!k.ok) return no(422, k.code, k.detail);
      }
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
      // the send's end frees the nullifier only if once still holds this send's entry (a newer one stays):
      //   expired (never landed, no fee paid): free now; failed (a paid failure): free, and refuse it until the next
      //   epoch; unknown, or no answer: held until the release's deadline, after which it cannot land
      const nf = tx.nullifier;
      const entry = once.get(nf); // this carry's own entry: once set it before the first await above
      const mine = (): boolean => entry !== undefined && once.get(nf) === entry;
      const hold = () => {
        if (mine()) bounded(heldUntil, nf, { entry, deadline: Number(tx.deadlineMs) });
      };
      void h.done
        .then((r) => {
          const state = r.txs[0]?.state;
          if (state === "filled") return;
          if (state === "expired" || state === "failed") {
            if (state === "failed") bounded(failedIn, nf, epochStartOf(now()));
            if (mine()) once.forget(nf);
            return;
          }
          hold();
        })
        .catch(hold);
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
    if (!/^[1-9][0-9]{0,18}$/.test(fee!)) throw new Error(`${names[2]} must be a whole number of lamports`);
    const s = solanaPoolSender({ cluster, program: program!, feePayerSecret: key!, fee: fee! }, { providers });
    out.set(s.pool, s);
  }
  return out;
}
