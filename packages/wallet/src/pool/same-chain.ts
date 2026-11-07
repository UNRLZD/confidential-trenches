// The same-chain deposit into a pool (card pool-deposits, slice 1): the device's next step for a one-time wallet U that
// holds money on the pool's own chain, and the kit's builder for it.
//
// The map (M377 (2), research docs/spec/11-merge-notes.md:387; card pool-deposits Step 1):
// - Who sends: the user, once, from any wallet or exchange on the pool's chain, to U's address. An exchange withdrawal
//   or a wallet that cannot call a program works, and the user signs nothing of ours.
// - To which address: U = U_{s,i}, the one-time id of deposit number i of the pool's scope s, derived on the device from
//   the 12 words (derive/keys.ts depositId, HKDF info "onetime/in" ‖ s ‖ i; docs/plan1/wallet.md:64 at research). On
//   Solana U's ed25519 key is a Solana account as it is (the signing page's pool.deposit has used it since card
//   signpage-pool-notes, packages/signpage/src/pool-deposit.ts:5). On Base and Robinhood U needs a secp256k1 key, which
//   the frozen path does not give: that derivation is a later slice and goes to the CO first (derive/ is outside this
//   card's paths); the EVM call here names no sender.
// - How the device deposits, its fee carried: U pays each deposit's costs out of what it holds (Solana: the fee, the
//   17-byte precommitment mark's rent and each page's growth, M353 (1), kit solanaPoolDepositCost; EVM: gas), so the
//   user sends once and never tops up a fee. Each note of the ladder plan is its own deposit, largest rung first
//   (./ladder.ts poolDepositPlan: U's deposit note, then U's second arrivals n = 0, 1, ...). Only rungs go in; what is
//   left below the smallest rung, or too little to carry another deposit's cost, stays in U for its next deposit
//   (M350 (4), research 11-merge-notes.md:358), so no note is ever off the ladder. A later send to the same address is
//   a second arrival of the same U.
// - The reload rule: no second deposit at a new index. The note to deposit is the first note of U's chain that no
//   deposit on chain names (Solana: its precommitment mark ["pre", P] absent on both RPCs; EVM: the wallet's
//   evmNextNote over the pool's events), and every note before it must be held landed in the store. An open note (its
//   deposit signed and written INCOMING before it left, notes/store.ts:125) is settled first, never passed over: its
//   precommitment fixes its index, so a resend lands on the same note or is refused by the pool
//   (PrecommitmentAlreadyUsed), and the store refuses second arrival n + 1 until n has landed (notes/store.ts:631).
// - Why this is the default over the user's wallet app signing a kit-built deposit (the kit's builders serve that
//   path too, for any app): both pay the same deposit costs (the program and the pool contract charge the depositor
//   alike); the one-time address adds one plain transfer (5,000 lamports a signature on Solana; 21,000 gas on EVM) and
//   keeps the dust in U, while the wallet-app path needs a wallet that can call the pool and one signature per note,
//   and shows a precommitment from the user's own address (a public link from that address to the note's deposit).
//   Fewer steps for the user and no link from their wallet: the one-time address.
//
// Nothing here logs or reads a network; the caller reads on two RPCs and hands the reads in. U's secret key is derived
// only for its address and zeroed at once.
import { EVM_POOL_MIN_DEPOSIT, solanaPoolDepositTx, VAULT_FIELD_P } from "@blindfill/kit";
import { base58 } from "@scure/base";
import { depositId } from "../derive/keys.ts";
import { noteSecrets, type NoteRef } from "../notes/secrets.ts";
import { refKey, type NoteState } from "../notes/store.ts";
import { evmNextNote } from "./evm-restore.ts";
import { EVM_CHAIN_IDS, evmPoolScopeOf, type EvmPoolEvent, type EvmPoolPin } from "./evm.ts";
import { rungsUpTo, type Ladder } from "./ladder.ts";
import { solanaPoolOf } from "./solana.ts";

const U32 = 0xffffffff;
const LANDED: readonly NoteState[] = ["UNSPENT", "HELD", "RESERVED", "SPENT", "TAKEN"];

/** A note the store holds: its ref and state (a NoteRecord is one). */
export type HeldNote = { readonly ref: NoteRef; readonly state: NoteState };

/** The device's next step for U. */
export type SameChainStep =
  /** an open note of U (signed, INCOMING): read its verdict and settle it first; nothing new is signed */
  | { kind: "settle"; ref: NoteRef }
  /** notes of U's chain a deposit on chain names that the store does not hold landed: write them first */
  | { kind: "claim"; refs: NoteRef[] }
  /** a deposit of U's chain sits in a block not final yet: read again once it is */
  | { kind: "wait"; refs: NoteRef[] }
  /** deposit one rung on the chain's next note; U keeps `left` after it */
  | { kind: "deposit"; ref: NoteRef; value: bigint; precommitment: bigint; left: bigint }
  /** nothing to deposit: U keeps what it holds for its next deposit */
  | { kind: "keep"; left: bigint };

/** U's id of a chain's first note (a deposit note), or a refusal. */
function uOf(first: NoteRef, scope: bigint): { s: bigint; i: number } {
  if (first?.kind !== "deposit") throw new Error("a same-chain deposit starts at U's deposit note");
  if (first.s !== scope) throw new Error("a deposit note's scope is its s");
  return { s: first.s, i: first.i };
}

/** A note's place in U's chain: -1 for the deposit note, n for second arrival n of U; null for another chain's note. */
function indexIn(first: Extract<NoteRef, { kind: "deposit" }>, ref: NoteRef): number | null {
  if (ref.kind === "deposit") return ref.s === first.s && ref.i === first.i ? -1 : null;
  if (ref.kind === "second" && ref.id.id === "U") return ref.id.s === first.s && ref.id.i === first.i ? ref.n : null;
  return null;
}
const refAt = (first: Extract<NoteRef, { kind: "deposit" }>, n: number): NoteRef => (n < 0 ? first : { kind: "second", id: { id: "U", s: first.s, i: first.i }, n });

/**
 * The next step for U from the reads: `next` is the first note of U's chain no deposit on chain names; `held` the
 * store's notes; `balance` U's money now (the lower of two RPCs), `cost` one deposit's cost to U, `floor` the least U
 * may keep when it keeps anything (Solana: an empty account's rent; EVM: 0).
 */
export function sameChainNext(a: { seed64: Uint8Array; scope: bigint; ladder: Ladder; first: NoteRef; next: { ref: NoteRef; precommitment: bigint }; held: readonly HeldNote[]; balance: bigint; cost: bigint; floor: bigint }): SameChainStep {
  uOf(a.first, a.scope);
  const first = a.first as Extract<NoteRef, { kind: "deposit" }>;
  for (const [k, v] of [["balance", a.balance], ["cost", a.cost], ["floor", a.floor]] as const) if (typeof v !== "bigint" || v < 0n) throw new Error(`${k}: a bigint at or above 0`);
  const at = indexIn(first, a.next.ref);
  if (at === null) throw new Error("the next note is not of U's chain");
  if (noteSecrets(a.seed64, a.next.ref).precommitment !== a.next.precommitment) throw new Error(`${refKey(a.next.ref)}: not this note's precommitment`);
  const chain = a.held.map((h) => ({ h, n: indexIn(first, h.ref) })).filter((x): x is { h: HeldNote; n: number } => x.n !== null).sort((x, y) => x.n - y.n);
  // an open note is settled first, whatever the chain says: its deposit may still land
  const open = chain.find((x) => x.h.state === "INCOMING");
  if (open !== undefined) return { kind: "settle", ref: open.h.ref };
  // a note at or past `next` held landed: the chain read missed a deposit the store saw land
  const ahead = chain.find((x) => x.n >= at && x.h.state !== "PLANNED");
  if (ahead !== undefined) throw new Error(`${refKey(ahead.h.ref)} is ${ahead.h.state} at or past the chain's next note: a read that missed it`);
  // every note before `next` held landed, else written first: the next deposit is never at a new index past a gap
  const landed = new Set(chain.filter((x) => LANDED.includes(x.h.state)).map((x) => x.n));
  const missing: NoteRef[] = [];
  for (let n = -1; n < at; n++) if (!landed.has(n)) missing.push(refAt(first, n));
  if (missing.length > 0) return { kind: "claim", refs: missing };
  // the largest rung U can carry with its cost, leaving 0 or at least the floor; else U keeps it all
  const avail = a.balance - a.cost;
  for (const r of avail > 0n ? rungsUpTo(a.ladder, avail) : []) {
    const left = avail - r;
    if (left === 0n || left >= a.floor) return { kind: "deposit", ref: a.next.ref, value: r, precommitment: a.next.precommitment, left };
  }
  return { kind: "keep", left: a.balance };
}

/** The first note of U's chain whose precommitment mark is not on chain (`marked`: the marks both RPCs hold, read at
 *  finalized), on the Solana pool. */
export function solanaChainNext(seed64: Uint8Array, scope: bigint, first: NoteRef, marked: (precommitment: bigint) => boolean): { ref: NoteRef; precommitment: bigint } {
  uOf(first, scope);
  for (let n = -1; n <= U32; n++) {
    const ref = refAt(first as Extract<NoteRef, { kind: "deposit" }>, n);
    const precommitment = noteSecrets(seed64, ref).precommitment;
    if (!marked(precommitment)) return { ref, precommitment };
  }
  throw new Error("no second arrival left on this id");
}

/** The Solana step, with the unsigned tx of a deposit step (U its signer and fee payer). */
export function solanaSameChainDeposit(a: {
  program: string;
  seed64: Uint8Array;
  scope: bigint;
  ladder: Ladder;
  first: NoteRef;
  held: readonly HeldNote[];
  marked: (precommitment: bigint) => boolean;
  balance: bigint;
  cost: bigint;
  floor: bigint;
  sizes: { stateSize: number; labelSize: number };
  blockhash: string;
}): SameChainStep & { u: string; tx?: { message: Uint8Array; wire: Uint8Array } } {
  const { s, i } = uOf(a.first, a.scope);
  if (solanaPoolOf(a.program).scope !== a.scope) throw new Error("the scope is not the program's pool's");
  const id = depositId(a.seed64, s, i);
  id.secretKey.fill(0);
  const u = base58.encode(id.publicKey);
  const step = sameChainNext({ ...a, next: solanaChainNext(a.seed64, a.scope, a.first, a.marked) });
  if (step.kind !== "deposit") return { ...step, u };
  return { ...step, u, tx: solanaPoolDepositTx(a.program, u, { value: step.value, precommitment: step.precommitment }, a.sizes, a.blockhash) };
}

/** The deposit to send on the EVM pool: the pinned pool, msg.value = the value, and deposit(value, precommitment). */
export type EvmDepositCall = { readonly to: string; readonly value: bigint; readonly data: string };
const word = (v: bigint): string => v.toString(16).padStart(64, "0");

/**
 * The EVM step, with the deposit call of a deposit step: the note picked through evmNextNote over the pool's events
 * (both RPCs, evmTreeSync), up to `finalBlock`. The call is deposit(uint256 _value, uint256 _precommitmentHash) on the
 * pinned pool with msg.value = _value (contracts/pool-evm/src/PrivacyPool.sol:82-109; PrivacyPoolSimple.sol:108-111
 * `_pull` refuses any other msg.value). It is encoded here, after the pick, and nowhere else: a pending deposit shows
 * its precommitment, which anyone can take first with MIN_DEPOSIT, so the signing page's guard holds every device
 * encoding of the deposit to an evmNextNote run before it (packages/signpage/test/signer-guard.ts; card
 * precommit-taken-recover). The pool refuses a value below MIN_DEPOSIT or at 2^128 - 1 and a precommitment at p
 * (PrivacyPool.sol:86-90); so does this, before any bytes.
 */
export function evmSameChainDeposit(a: {
  pin: EvmPoolPin;
  seed64: Uint8Array;
  scope: bigint;
  ladder: Ladder;
  first: NoteRef;
  held: readonly HeldNote[];
  events: readonly EvmPoolEvent[];
  finalBlock: bigint;
  balance: bigint;
  cost: bigint;
}): SameChainStep & { call?: EvmDepositCall } {
  uOf(a.first, a.scope);
  if (evmPoolScopeOf(a.pin.pool, EVM_CHAIN_IDS[a.pin.network]) !== a.scope) throw new Error("the scope is not the pinned pool's");
  const pick = evmNextNote(a.seed64, a.scope, a.events, a.first, a.finalBlock);
  const step = sameChainNext({ ...a, next: pick.next, floor: 0n });
  // an open note is settled first; a take not final yet holds every later note (evmNextNote passes over it)
  if (step.kind === "settle") return step;
  if (pick.pending.length > 0) return { kind: "wait", refs: pick.pending };
  if (step.kind !== "deposit") return step;
  if (step.value < EVM_POOL_MIN_DEPOSIT || step.value >= (1n << 128n) - 1n) throw new Error(`${refKey(step.ref)}: a value the pool refuses`);
  if (step.precommitment <= 0n || step.precommitment >= VAULT_FIELD_P) throw new Error(`${refKey(step.ref)}: a precommitment the pool refuses`);
  return { ...step, call: Object.freeze({ to: a.pin.pool, value: step.value, data: "0xe2bbb158" + word(step.value) + word(step.precommitment) }) };
}
