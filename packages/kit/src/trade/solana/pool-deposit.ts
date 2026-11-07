// The Solana pool's deposit, built by the kit (card pool-deposits): one tag 1 instruction by one depositor, of one note
// of the ladder plan (packages/wallet/src/pool/ladder.ts poolDepositPlan, one rung and its precommitment). Each note is
// its own deposit; the remainder below the smallest rung is never deposited (M350 (4)) because only a planned note is
// built. Who signs it is the caller's: the device's one-time wallet U (packages/wallet/src/pool/same-chain.ts), or any
// wallet app an app hands the unsigned message to.
//
// The layout, as contracts/pool-solana/src/deposit.rs reads it:
// - data, 41 bytes: tag 1 ‖ value u64 LE ‖ precommitment (32, big-endian);
// - accounts: pool (w), depositor (w, signer), state page (w), label page (w), precommitment mark ["pre",
//   precommitment] (w), system program; each page the one holding entry `size` of its tree (state::page_for), so the
//   sizes are the pool account's as read on two RPCs (solanaPoolTreeSizes).
// - the program refuses a value below MIN_DEPOSIT (lib.rs:78), a precommitment at or above p or 0, and a precommitment
//   whose mark exists; the builder refuses the first three itself, so it never hands out a message that cannot land.
// - the depositor pays every rent the deposit makes (M353 (1)): the 17-byte mark and each page's entry (or a new page),
//   plus the fee. U's cost of one note is solanaPoolDepositCost's.
import { solanaProgramAddress } from "../../checks/solana/message.ts";
import { SOLANA_SYSTEM_PROGRAM } from "../../checks/solana/checks.ts";
import { VAULT_FIELD_P } from "../../vault/shapes.ts";
import { solanaCompileV0, type SolanaApiInstruction } from "./build.ts";
import { solanaPoolAccount, solanaPoolPage, SOLANA_POOL_PAGE_ENTRIES } from "./pool-buy.ts";

/** The deposit's tag and data length (contracts/pool-solana/src/lib.rs:84, deposit.rs:69). */
export const SOLANA_POOL_TAG_DEPOSIT = 1;
export const SOLANA_POOL_DEPOSIT_LEN = 41;
/** The pool's smallest deposit, lamports (lib.rs:78). */
export const SOLANA_POOL_MIN_DEPOSIT = 1_000_000n;
/** The precommitment mark's bytes (value u64 ‖ nonce u64 ‖ tag, src/state.rs PRE_MARK_LEN), and a page entry's and a
 *  new page's header bytes (src/state.rs). */
export const SOLANA_POOL_PRE_MARK_LEN = 17;
export const SOLANA_POOL_PAGE_ENTRY = 72;
export const SOLANA_POOL_PAGE_HEADER = 16;

// the pool account (src/state.rs Pool::store): "bfpool01", then the trees, each size u64 LE ‖ depth u8 ‖ 33 x 32
const POOL_LEN = 2179;
const POOL_DISC = /* @__PURE__ */ new TextEncoder().encode("bfpool01");
const OFF_TREES = 49;
const TREE_LEN = 8 + 1 + 33 * 32;
const U64 = 1n << 64n;
const enc = /* @__PURE__ */ new TextEncoder();

/** One note to deposit: a rung of the plan and its precommitment. */
export type SolanaPoolDepositNote = { readonly value: bigint; readonly precommitment: bigint };

export class SolanaPoolDepositError extends Error {
  constructor(m: string) {
    super(`solana pool deposit: ${m}`);
    this.name = "SolanaPoolDepositError";
  }
}
const refuse = (m: string): never => {
  throw new SolanaPoolDepositError(m);
};

const be32 = (x: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
};
const u64le = (x: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, x, true);
  return b;
};
const size = (x: unknown, name: string): number => (Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) < 2 ** 32 ? (x as number) : refuse(`${name} is not a tree size`));

/** The two tree sizes of the pool account's bytes (both RPCs' bytes, the caller's to compare first). */
export function solanaPoolTreeSizes(data: Uint8Array): { stateSize: number; labelSize: number } {
  if (!(data instanceof Uint8Array) || data.length !== POOL_LEN || !POOL_DISC.every((b, i) => data[i] === b)) return refuse("not the pool account");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const at = (o: number) => size(Number(v.getBigUint64(o, true)), "a tree's size");
  return { stateSize: at(OFF_TREES), labelSize: at(OFF_TREES + TREE_LEN) };
}

/** The precommitment mark of a precommitment: the account the deposit makes, which a reload reads to tell it landed. */
export const solanaPoolPreMark = (program: string, precommitment: bigint): string => solanaProgramAddress([enc.encode("pre"), be32(checkPrecommitment(precommitment))], program);

function checkPrecommitment(p: unknown): bigint {
  if (typeof p !== "bigint" || p <= 0n || p >= VAULT_FIELD_P) return refuse("the precommitment is not a field element above 0");
  return p;
}

/** The tag 1 instruction of one note by `depositor` into the pool of `program`, at the trees' sizes now. */
export function solanaPoolDepositIx(program: string, depositor: string, note: SolanaPoolDepositNote, sizes: { stateSize: number; labelSize: number }): SolanaApiInstruction {
  const { value, precommitment } = note;
  if (typeof value !== "bigint" || value < SOLANA_POOL_MIN_DEPOSIT || value >= U64) refuse(`the value is not a u64 at or above ${SOLANA_POOL_MIN_DEPOSIT}`);
  const pre = be32(checkPrecommitment(precommitment));
  return {
    program,
    accounts: [
      { key: solanaPoolAccount(program), signer: false, writable: true },
      { key: depositor, signer: true, writable: true },
      { key: solanaPoolPage(program, 0, size(sizes.stateSize, "stateSize")), signer: false, writable: true },
      { key: solanaPoolPage(program, 1, size(sizes.labelSize, "labelSize")), signer: false, writable: true },
      { key: solanaProgramAddress([enc.encode("pre"), pre], program), signer: false, writable: true },
      { key: SOLANA_SYSTEM_PROGRAM, signer: false, writable: false },
    ],
    data: Uint8Array.of(SOLANA_POOL_TAG_DEPOSIT, ...u64le(value), ...pre),
  };
}

/** The deposit as an unsigned v0 transaction, `depositor` its one signer and fee payer: the wire bytes with its
 *  signature slot zeroed, for the depositor to sign and the caller to simulate on two RPCs first. */
export function solanaPoolDepositTx(program: string, depositor: string, note: SolanaPoolDepositNote, sizes: { stateSize: number; labelSize: number }, blockhash: string): { message: Uint8Array; wire: Uint8Array } {
  const { message } = solanaCompileV0(depositor, [solanaPoolDepositIx(program, depositor, note, sizes)], blockhash, []);
  const wire = new Uint8Array(1 + 64 + message.length);
  wire[0] = 1;
  wire.set(message, 65);
  return { message, wire };
}

/** What one note's deposit costs its depositor beyond the value: the fee, the mark's rent and each page's growth (a
 *  72-byte entry, or a new page's rent at a page boundary), from the Rent sysvar read on two RPCs (`rentMin(n)`: the
 *  rent-exempt minimum of n bytes; `perByte`: lamports per byte-year x the exemption factor). */
export function solanaPoolDepositCost(fee: bigint, rentMin: (bytes: number) => bigint, perByte: bigint, sizes: { stateSize: number; labelSize: number }): bigint {
  const grow = (s: number): bigint => (s % SOLANA_POOL_PAGE_ENTRIES === 0 ? rentMin(SOLANA_POOL_PAGE_HEADER + SOLANA_POOL_PAGE_ENTRY) : BigInt(SOLANA_POOL_PAGE_ENTRY) * perByte);
  if (typeof fee !== "bigint" || fee < 0n || typeof perByte !== "bigint" || perByte < 0n) refuse("the fee and the rent are bigints at or above 0");
  return fee + rentMin(SOLANA_POOL_PRE_MARK_LEN) + grow(size(sizes.stateSize, "stateSize")) + grow(size(sizes.labelSize, "labelSize"));
}
