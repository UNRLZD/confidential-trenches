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
//   sizes are the pool account's as read on two RPCs (solanaPoolTreeSizes); then each tree's next page, state (w) and
//   label (w), the program's optional pair since d3edab1 (deposit.rs:72-76).
// - the program refuses a value below MIN_DEPOSIT (lib.rs:78), a precommitment at or above p or 0, and a precommitment
//   whose mark exists; the builder refuses the first three itself, so it never hands out a message that cannot land.
// - the builder passes all 8 accounts: a deposit planned at a page's last slot (size 1023 mod 1024) that an insert
//   overtakes writes its entry on the next page and lands (state::page_for takes the next page only when the page the
//   size named is not the entry's).
// - the depositor pays every rent the deposit makes (M353 (1)), as the program charges it (src/state.rs create_pda and
//   push_entry): the mark's rent-exempt minimum of 17 bytes less what the mark's address already holds, and each page's
//   minimum at its new length (16 + 72 x (slot + 1)) less what the page holds, never below 0; plus the fee. Lamports a
//   stranger sends to a page or a mark's address lower that cost, so it is priced from both accounts' balances, read on
//   two RPCs (solanaPoolDepositCost), never from a page's expected size. An entry the next page takes opens it (16 + 72
//   bytes, 731,520 lamports more a tree at mainnet rent): a tree within SOLANA_POOL_NEXT_PAGE_WINDOW entries of its
//   page's end is priced at that opening, so U holds it; what the deposit does not spend stays in U for its next deposit.
import { solanaProgramAddress } from "../../checks/solana/message.ts";
import { SOLANA_SYSTEM_PROGRAM } from "../../checks/solana/checks.ts";
import { VAULT_FIELD_P } from "../../vault/shapes.ts";
import { solanaCompileV0, type SolanaApiInstruction } from "./build.ts";
import { solanaPoolAccount, solanaPoolNextPage, solanaPoolPage, SOLANA_POOL_PAGE_ENTRIES, solanaRentMin, type SolanaRent } from "./pool-buy.ts";

/**
 * How near its page's end (entries from the size read to the page's last slot, inclusive: 1 at slot 1,023) a tree's
 * size must be for a deposit to be priced at the next page's opening: within it, inserts that land between the read and
 * the deposit can carry its entry onto the next page (src/state.rs page_for). Outside it the price is exact, and a
 * deposit that more inserts than this overtake fails on chain as before, losing only its fee. Whatever a deposit priced
 * this way does not spend stays in U for its next deposit (M350 (4), packages/wallet/src/pool/same-chain.ts).
 */
export const SOLANA_POOL_NEXT_PAGE_WINDOW = 64;

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
const MARK_TAG = 1;
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

/** The two tree sizes of the pool account (both RPCs' read, the caller's to compare first): the program's own account
 *  at its 2,179 bytes, else refused. */
export function solanaPoolTreeSizes(account: { owner: string; data: Uint8Array }, program: string): { stateSize: number; labelSize: number } {
  if (account === null || typeof account !== "object" || account.owner !== program) return refuse("the pool account is not the program's");
  const data = account.data;
  if (!(data instanceof Uint8Array) || data.length !== POOL_LEN || !POOL_DISC.every((b, i) => data[i] === b)) return refuse("not the pool account");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const at = (o: number) => size(Number(v.getBigUint64(o, true)), "a tree's size");
  return { stateSize: at(OFF_TREES), labelSize: at(OFF_TREES + TREE_LEN) };
}

/** The precommitment mark of a precommitment: the account the deposit makes, which a reload reads to tell it landed. */
export const solanaPoolPreMark = (program: string, precommitment: bigint): string => solanaProgramAddress([enc.encode("pre"), be32(checkPrecommitment(precommitment))], program);

/** A precommitment mark as the deposit wrote it: its value and the nonce its label hashes. */
export type SolanaPoolPreMark = { readonly value: bigint; readonly nonce: bigint };

/**
 * The read of a mark's address: null when no deposit has used the precommitment (no account, or a system account a
 * stranger funded, which the deposit takes over: src/state.rs create_pda); the deposit's record when the program owns
 * it at 17 bytes with its tag (src/state.rs PRE_MARK_LEN, MARK_TAG); anything else refused, never read as either.
 */
export function solanaPoolPreMarkOf(account: { owner: string; data: Uint8Array } | null, program: string): SolanaPoolPreMark | null {
  if (account === null) return null;
  if (typeof account !== "object" || typeof account.owner !== "string" || !(account.data instanceof Uint8Array)) return refuse("a mark read is an account or null");
  if (account.owner === SOLANA_SYSTEM_PROGRAM && account.data.length === 0) return null;
  if (account.owner !== program) return refuse("the mark's address is held by another program");
  const d = account.data;
  if (d.length !== SOLANA_POOL_PRE_MARK_LEN || d[16] !== MARK_TAG) return refuse("not a precommitment mark");
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const value = v.getBigUint64(0, true), nonce = v.getBigUint64(8, true);
  if (value < SOLANA_POOL_MIN_DEPOSIT || nonce === 0n) return refuse("a mark the program never writes");
  return Object.freeze({ value, nonce });
}

function checkPrecommitment(p: unknown): bigint {
  if (typeof p !== "bigint" || p <= 0n || p >= VAULT_FIELD_P) return refuse("the precommitment is not a field element above 0");
  return p;
}

/** The tag 1 instruction of one note by `depositor` into the pool of `program`, at the trees' sizes now, naming each
 *  tree's next page. */
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
      { key: solanaPoolNextPage(program, 0, sizes.stateSize), signer: false, writable: true },
      { key: solanaPoolNextPage(program, 1, sizes.labelSize), signer: false, writable: true },
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

/**
 * What one note's deposit costs its depositor beyond the value, as the program charges it (src/state.rs create_pda,
 * push_entry): the fee, max(0, rent(17) - the mark address's lamports), and for each tree max(0, rent(16 + 72 x (slot +
 * 1)) - its page's lamports), slot = size mod 1024 (a page not made yet holds what strangers sent it, often 0). `rent`
 * is the Rent sysvar read on two RPCs (readSolanaRent); the balances are the lower of two RPCs'. An entry the next page
 * takes (inserts that landed first carried it there) opens that page instead, rent(16 + 72): 731,520 lamports more a
 * tree at mainnet rent. A tree whose size sits within SOLANA_POOL_NEXT_PAGE_WINDOW entries of its page's end is priced
 * at that opening when it is more (the next page priced as holding nothing), so the deposit lands either way.
 */
export function solanaPoolDepositCost(fee: bigint, rent: SolanaRent, sizes: { stateSize: number; labelSize: number }, have: { mark: bigint; statePage: bigint; labelPage: bigint }): bigint {
  for (const x of [fee, have.mark, have.statePage, have.labelPage]) if (typeof x !== "bigint" || x < 0n) refuse("the fee and the balances are bigints at or above 0");
  const short = (need: bigint, held: bigint): bigint => (need > held ? need - held : 0n);
  const open = solanaRentMin(rent, SOLANA_POOL_PAGE_HEADER + SOLANA_POOL_PAGE_ENTRY);
  const page = (s: number, held: bigint): bigint => {
    const here = short(solanaRentMin(rent, SOLANA_POOL_PAGE_HEADER + SOLANA_POOL_PAGE_ENTRY * ((s % SOLANA_POOL_PAGE_ENTRIES) + 1)), held);
    const near = SOLANA_POOL_PAGE_ENTRIES - (s % SOLANA_POOL_PAGE_ENTRIES) <= SOLANA_POOL_NEXT_PAGE_WINDOW;
    return near && open > here ? open : here;
  };
  return fee + short(solanaRentMin(rent, SOLANA_POOL_PRE_MARK_LEN), have.mark) + page(size(sizes.stateSize, "stateSize"), have.statePage) + page(size(sizes.labelSize, "labelSize"), have.labelPage);
}
