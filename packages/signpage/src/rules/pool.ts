// The signing page's pool rules: what SIGN_HOST will sign for a pool deposit, buy, sell and withdraw, and nothing else
// (card signpage-pool-kinds, plan v2 W4; merge notes M366, M370, M377). The app's request, the helper's builds and
// every RPC answer are hostile. A payload is signed only when every field below reads, from the signed bytes or from
// the device's own two-RPC reads, as the user's request and the device's pins say; the first field that does not is
// refused "not_allowed" with nothing signed, and `rule` names it for the device's own log.
//
// What the device holds and passes in (PoolContext), never a server's word:
// - the pins: the Solana pool's program and fee payer (the wallet's SOL_POOLS), the EVM venue list (the kit's
//   evmPoolVenues(): the pool, the buy adapters, the sell delegate, the chain id) and the EVM fee recipient (the
//   wallet's EVM_POOLS);
// - W, the fresh wallet this device derived for the op, and the precommitment of the note a deposit makes;
// - the fee cap, the device's clock, and the reads (blockhash, lookup tables, tree sizes) agreed on two providers.
//
// Per chain and op:
// - Solana deposit, tag 1 (contracts/pool-solana/src/deposit.rs: accounts pool, depositor, state page, label page,
//   precommitment mark, system; data tag, value u64 LE, precommitment 32 B): the pinned program and pool, W the depositor
//   and the only signer, the value the request's, the precommitment the device's, the pages at the tree sizes read.
// - Solana withdraw, tag 2 (src/release.rs): the device's own release, byte for byte, through the pinned program and
//   pool, paid to W, the pinned fee payer and W the only signers, the relay fee within its cap and the cap within the
//   device's, the deadline ahead; then at most one transfer, from W to the address typed on SIGN_HOST.
// - Solana buy, tag 3: the kit's checkSolanaPoolBuy against the pinned pool (it rebuilds every byte from the device's
//   reads), with W, the token and the release bound to the request here.
// - Solana sell: the kit's venue sell of the request's amount from W, a min out at least the device's floor, then the
//   deposit back into the pinned pool (tag 1, W the depositor) as the last instruction, of at most that min out. Its
//   teardown frames (card solana-sell-teardown) go through the kit's checkSolanaTeardown for W.
// - EVM buy and withdraw: the proof binds a context; the device recomputes it from the relay data and the pinned pool
//   and holds W the recipient, the pinned fee recipient, the fee cap and the deadline. The buy's adapter is a pin, its
//   token the request's; the kit's pinned signer refuses any buy its builder did not return.
// - EVM sell: W's own sell into the pinned pool, the request's token and amount, the fee cap and deadline held here;
//   the kit's pinned signer refuses any sell its builder did not return.
// - EVM authorization (EIP-7702): only the chain's pinned sell delegate, at W's account nonce read on two RPCs.
//
// - Everywhere: a compute budget within the runtime's limit and the kit's price cap, so no payer is made to pay more than
//   1,400,000 lamports of priority fee; an EVM buy's or sell's min out at least the floor the device made from its own
//   two-RPC reads; and each signer below signs only what a check passed, as the check read it (a copy, a byte or value
//   changed after, or a proof checked as one op signed as another is refused "unchecked").
//
// Every other op, chain or instruction is refused. Draws are what the page shows before the press: chain, token,
// amount, fee cap and the pool, as the pins name it (drawPool; its words are drafts until the owner picks them).
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58 } from "@scure/base";
import {
  SOLANA_ALT_PROGRAM,
  SOLANA_MAX_TX_BYTES,
  solanaDecodeLookupTable,
  solanaDecodeMessage,
  solanaProgramAddress,
  solanaResolveKeys,
  solanaTableIsActive,
  type SolanaLookupTable,
} from "../../../kit/src/checks/solana/message.ts";
import { SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_CU_PRICE_MAX, SOLANA_SYSTEM_PROGRAM, checkSolanaTeardown, type SolanaTeardownReads } from "../../../kit/src/checks/solana/checks.ts";
import {
  SOLANA_POOL_TAG_RELEASE,
  checkSolanaPoolBuy,
  solanaDecodePoolRelease,
  solanaEncodePoolRelease,
  solanaPoolPage,
  solanaPoolReleaseAccounts,
  solanaPoolSellMinOut,
  solanaPoolSellSteps,
  type SolanaPoolBuyReads,
  type SolanaPoolBuyRequest,
  type SolanaPoolBuyVenue,
  type SolanaPoolRelease,
} from "../../../kit/src/trade/solana/pool-buy.ts";
import { pinnedSignBuy, venuePins, type EvmPoolBuy, type EvmPoolChain, type EvmPoolProofBinding, type EvmPoolVenueList } from "../../../kit/src/trade/evm/buy-unpinned.ts";
import { pinnedSignSell, pinnedSignSellAuthorization, type EvmPoolSell, type EvmPoolSellAuthorization } from "../../../kit/src/trade/evm/sell-unpinned.ts";
import { evmPoolContextOf, evmPoolScopeOf, type EvmRelayData } from "../../../wallet/src/pool/evm.ts";

/** The four pool kinds the page signs for (the kit's messages.ts). */
export const POOL_KINDS = ["pool.deposit", "pool.buy", "pool.sell", "pool.withdraw"] as const;
export type PoolKind = (typeof POOL_KINDS)[number];
/** The chains a pool runs on. NEAR's money is the vault's, never a pool's. */
export const POOL_CHAINS = ["solana", "base", "robinhood"] as const;
export type PoolChain = (typeof POOL_CHAINS)[number];
/** Tag 1: deposit(value u64, precommitment), contracts/pool-solana/src/lib.rs TAG_DEPOSIT. */
export const SOLANA_POOL_TAG_DEPOSIT = 1;
/** Tag 1's data: the tag, value u64 LE, the precommitment (32 bytes, big-endian). */
export const SOLANA_POOL_DEPOSIT_LEN = 41;
/** The most a user may give up to slippage on a pool trade: 50%, the trade box's own bound. */
export const POOL_MAX_SLIPPAGE_BPS = 5_000;
/** The most compute a Solana transaction may ask: the runtime's MAX_COMPUTE_UNIT_LIMIT. With the kit's price cap
 *  (SOLANA_CU_PRICE_MAX) it bounds the priority fee a payer can be made to pay at 1,400,000 lamports. */
export const SOLANA_POOL_CU_LIMIT_MAX = 1_400_000;

// Every payload a check passed, by identity and by what it is: the signers below sign only these, so no path reaches a
// key around a check, and a proof checked as a buy is never signed as a withdraw
type Checked = "evm.buy" | "evm.withdraw" | "evm.sell" | "evm.authorization";
const CHECKED: Readonly<Record<Checked, WeakSet<object>>> = Object.freeze({
  "evm.buy": new WeakSet<object>(),
  "evm.withdraw": new WeakSet<object>(),
  "evm.sell": new WeakSet<object>(),
  "evm.authorization": new WeakSet<object>(),
});
const passed = (as: Checked, ...xs: object[]): void => {
  for (const x of xs) CHECKED[as].add(x);
};
const mustHavePassed = (as: Checked, ...xs: object[]): void => {
  if (!xs.every((x) => typeof x === "object" && x !== null && CHECKED[as].has(x))) refuse("unchecked");
};
// A proof's values are an object its holder can still write to: the values the check read are kept beside it
const PROOF_READ = new WeakMap<object, string>();
const proofKey = (p: EvmPoolProofBinding): string => `${p.nullifier}:${p.context}:${p.value}`;
const passedProof = (as: Checked, p: EvmPoolProofBinding): void => {
  passed(as, p);
  PROOF_READ.set(p, `${as}:${proofKey(p)}`);
};
const proofMustHavePassed = (as: Checked, p: EvmPoolProofBinding): void => {
  mustHavePassed(as, p);
  if (PROOF_READ.get(p) !== `${as}:${proofKey(p)}`) refuse("unchecked");
};
// A Solana wire is an array its holder can still write to: the bytes a check read are kept beside it, and signing
// compares them, so a byte changed after the check is a wire no check passed
const SOLANA_CHECKED = new WeakMap<Uint8Array, Uint8Array>();
const passedWire = (...wires: readonly Uint8Array[]): void => {
  for (const w of wires) SOLANA_CHECKED.set(w, w.slice());
};

/** A refusal: the answer is "not_allowed"; `rule` names the field for the device's own log, never the app's. */
export class PoolRuleRefused extends Error {
  readonly code = "not_allowed";
  readonly rule: string;
  constructor(rule: string) {
    super(`pool request not allowed: ${rule}`);
    this.name = "PoolRuleRefused";
    this.rule = rule;
  }
}
const refuse = (rule: string): never => {
  throw new PoolRuleRefused(rule);
};

// ---------- the request ----------

/** A pool request's params as the kit's schema let them through: still hostile in value. */
export type PoolRequest = { kind: PoolKind; chain: string; token?: string; amount?: string; slippage_bps?: number };
/** The request in the device's terms: the amount in base units of the pool's asset, or of the token for a sell. */
export type PoolAsk = { kind: PoolKind; chain: PoolChain; token: string | null; amount: bigint; slippageBps: number };

const SOL_KEY = (s: string): boolean => {
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
};
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(0|[1-9]\d{0,29})(?:\.(\d{1,18}))?$/;
const lower = (s: string) => s.toLowerCase();

/** The request checked against its kind: the chain a pool chain, the token an address of that chain (buy and sell),
 *  the amount a decimal above 0 within `decimals`, the slippage in range; withdraw takes nothing but its chain. */
export function checkPoolRequest(p: PoolRequest, decimals: number): PoolAsk {
  if (typeof p !== "object" || p === null || !(POOL_KINDS as readonly string[]).includes(p.kind)) return refuse("kind");
  if (!(POOL_CHAINS as readonly string[]).includes(p.chain)) return refuse("chain");
  const chain = p.chain as PoolChain;
  if (p.kind === "pool.withdraw") return { kind: p.kind, chain, token: null, amount: 0n, slippageBps: 0 };
  const m = typeof p.amount === "string" ? DECIMAL.exec(p.amount) : null;
  if (!m || !Number.isInteger(decimals) || decimals < 0 || decimals > 18 || (m[2] ?? "").length > decimals) return refuse("amount");
  const amount = BigInt(m[1]! + (m[2] ?? "").padEnd(decimals, "0"));
  if (amount === 0n || amount >= 1n << 64n) return refuse("amount");
  if (p.kind === "pool.deposit") return { kind: p.kind, chain, token: null, amount, slippageBps: 0 };
  const token = p.token;
  if (typeof token !== "string" || !(chain === "solana" ? SOL_KEY(token) : EVM_ADDRESS.test(token))) return refuse("token");
  const s = p.slippage_bps;
  if (typeof s !== "number" || !Number.isInteger(s) || s < 0 || s > POOL_MAX_SLIPPAGE_BPS) return refuse("slippage");
  return { kind: p.kind, chain, token, amount, slippageBps: s };
}

// ---------- the device's context ----------

/** The Solana pool's pin: its program and the fee payer the helper signs with (the wallet's SOL_POOLS). */
export type SolanaPin = { readonly program: string; readonly feePayer: string };
/** What the device holds for one op: never a server's word. */
export type PoolContext = {
  /** The device's clock, ms. */
  readonly nowMs: bigint;
  /** W: the fresh wallet this device derived for the op (base58 on Solana, 0x on EVM). */
  readonly wallet: string;
  /** The most fee the user pays a relayer for this op, in the pool asset's base units. */
  readonly feeCap: bigint;
  readonly solana?: SolanaPin;
  readonly evm?: { readonly venues: EvmPoolVenueList; readonly feeRecipient: string };
};

/** What the page draws before the press. `pool` is the pin's address, `to` where the money lands. */
export type PoolDraw = { chain: PoolChain; op: PoolKind; token: string | null; amount: bigint; feeCap: bigint; pool: string; to: string };

const solanaPoolOf = (program: string): string => solanaProgramAddress([new TextEncoder().encode("pool")], program);
const pinOf = (ctx: PoolContext): SolanaPin & { pool: string } => {
  const s = ctx.solana;
  if (!s || !SOL_KEY(s.program) || !SOL_KEY(s.feePayer)) return refuse("solana_not_pinned");
  return { program: s.program, feePayer: s.feePayer, pool: solanaPoolOf(s.program) };
};
const checkFeeAndDeadline = (fee: bigint, cap: bigint, deadlineMs: bigint, ctx: PoolContext): void => {
  if (fee > cap) refuse("fee_over_cap");
  if (cap > ctx.feeCap) refuse("fee_cap_over_device_cap");
  if (deadlineMs <= ctx.nowMs) refuse("deadline_past");
};

// ---------- Solana: the signed bytes ----------

type Ix = { program: string; accounts: { key: string; signer: boolean; writable: boolean }[]; data: Uint8Array };
type Decoded = { message: Uint8Array; signers: string[]; ixs: Ix[]; blockhash: string };

/** The tables a Solana op may use, as each of two providers answered them (the device's own reads). */
export type SolanaTables = Readonly<Record<string, readonly [{ owner: string; data: Uint8Array } | null, { owner: string; data: Uint8Array } | null]>>;
/** The device's reads for a Solana op: its blockhash, the tables on two providers, the pool's two tree sizes. */
export type SolanaPoolReads = { readonly blockhash: string; readonly tables: SolanaTables; readonly stateSize: number; readonly labelSize: number };

/** The wire (signature slots, then the message) read back: every key resolved through tables both providers agree on. */
function decode(wire: Uint8Array, reads: SolanaPoolReads): Decoded {
  if (!(wire instanceof Uint8Array) || wire.length > SOLANA_MAX_TX_BYTES || wire.length < 1) return refuse("wire");
  const slots = wire[0]!;
  if (slots < 1 || slots > 2) return refuse("signature_slots");
  const message = wire.subarray(1 + 64 * slots);
  let m: ReturnType<typeof solanaDecodeMessage>;
  try {
    m = solanaDecodeMessage(message);
  } catch {
    return refuse("decode");
  }
  const tables: Record<string, SolanaLookupTable> = {};
  for (const l of m.lookups) {
    const pair = Object.hasOwn(reads.tables, l.table) ? reads.tables[l.table] : undefined;
    const [a, b] = (pair ?? [null, null]).map((x) => (x && x.owner === SOLANA_ALT_PROGRAM ? solanaDecodeLookupTable(x.data) : null));
    if (!a || !b || !solanaTableIsActive(a) || !solanaTableIsActive(b)) return refuse("table");
    if ([...l.writable, ...l.readonly].some((i) => a.addresses[i] === undefined || a.addresses[i] !== b.addresses[i])) return refuse("table");
    tables[l.table] = a;
  }
  const keys = solanaResolveKeys(m, tables);
  if (m.blockhash !== reads.blockhash) return refuse("blockhash");
  const signers = keys.filter((k) => k.signer).map((k) => k.key);
  if (signers.length !== slots) return refuse("signature_slots");
  const ixs = m.instructions.map((x) => {
    const program = keys[x.programIndex]?.key;
    if (program === undefined || x.accounts.some((i) => keys[i] === undefined)) return refuse("decode");
    return { program, accounts: x.accounts.map((i) => keys[i]!), data: x.data };
  });
  return { message, signers, ixs, blockhash: m.blockhash };
}

/** The compute budget head: at most a limit (2) then a price (3), each within its cap, nothing else of that program. */
function head(ixs: Ix[]): number {
  let n = 0;
  if (ixs[n]?.program === SOLANA_COMPUTE_BUDGET_PROGRAM && ixs[n]!.data[0] === 2 && ixs[n]!.data.length === 5 && ixs[n]!.accounts.length === 0) {
    if (new DataView(ixs[n]!.data.buffer, ixs[n]!.data.byteOffset + 1, 4).getUint32(0, true) > SOLANA_POOL_CU_LIMIT_MAX) refuse("cu_limit");
    n++;
  }
  if (ixs[n]?.program === SOLANA_COMPUTE_BUDGET_PROGRAM && ixs[n]!.data[0] === 3 && ixs[n]!.data.length === 9 && ixs[n]!.accounts.length === 0) {
    if (u64le(ixs[n]!.data, 1) > SOLANA_CU_PRICE_MAX) refuse("cu_price");
    n++;
  }
  if (ixs.slice(n).some((x) => x.program === SOLANA_COMPUTE_BUDGET_PROGRAM)) refuse("compute_budget");
  return n;
}

const u64le = (d: Uint8Array, at: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);
const be32 = (d: Uint8Array): bigint => d.reduce((a, b) => (a << 8n) | BigInt(b), 0n);
const same = (a: { key: string; signer: boolean; writable: boolean } | undefined, key: string, signer: boolean, writable: boolean): boolean =>
  a !== undefined && a.key === key && a.signer === signer && a.writable === writable;
/** `got` is `want` key for key, each key with the privileges a message gives it: the most any of `want` asks for it
 *  (a key named twice, as a release's root page and its new page can be, is one account in the message). */
const sameList = (got: Ix["accounts"], want: readonly { key: string; signer: boolean; writable: boolean }[]): boolean => {
  if (got.length !== want.length) return false;
  const merged = new Map<string, { signer: boolean; writable: boolean }>();
  for (const a of want) {
    const m = merged.get(a.key);
    merged.set(a.key, { signer: a.signer || (m?.signer ?? false), writable: a.writable || (m?.writable ?? false) });
  }
  return want.every((a, i) => same(got[i], a.key, merged.get(a.key)!.signer, merged.get(a.key)!.writable));
};

/** One tag 1 deposit into the pinned pool by `depositor`: its value, read from its bytes. */
function depositOf(x: Ix, pin: SolanaPin & { pool: string }, depositor: string, precommitment: bigint, reads: SolanaPoolReads): bigint {
  if (x.program !== pin.program) return refuse("program");
  if (x.data.length !== SOLANA_POOL_DEPOSIT_LEN || x.data[0] !== SOLANA_POOL_TAG_DEPOSIT) return refuse("deposit_data");
  if (x.accounts.length !== 6) return refuse("deposit_accounts");
  const [pool, from, statePage, labelPage, mark, system] = x.accounts;
  if (!same(pool, pin.pool, false, true)) return refuse("pool");
  if (!same(from, depositor, true, true)) return refuse("depositor");
  const pre = x.data.subarray(9, 41);
  if (be32(pre) !== precommitment) return refuse("precommitment");
  if (!same(statePage, solanaPoolPage(pin.program, 0, reads.stateSize), false, true)) return refuse("state_page");
  if (!same(labelPage, solanaPoolPage(pin.program, 1, reads.labelSize), false, true)) return refuse("label_page");
  if (!same(mark, solanaProgramAddress([new TextEncoder().encode("pre"), pre], pin.program), false, true)) return refuse("precommitment_mark");
  if (!same(system, SOLANA_SYSTEM_PROGRAM, false, false)) return refuse("system");
  const value = u64le(x.data, 1);
  if (value === 0n) return refuse("amount");
  return value;
}

/** A Solana pool deposit of the request's amount from W, the device's precommitment: CU head, one tag 1, nothing else. */
export function checkSolanaDeposit(wire: Uint8Array, ask: PoolAsk, ctx: PoolContext & { precommitment: bigint }, reads: SolanaPoolReads): PoolDraw {
  if (ask.kind !== "pool.deposit" || ask.chain !== "solana") return refuse("kind");
  const pin = pinOf(ctx);
  const d = decode(wire, reads);
  if (d.signers.length !== 1 || d.signers[0] !== ctx.wallet) return refuse("signers");
  const n = head(d.ixs);
  if (d.ixs.length !== n + 1) return refuse("instructions");
  if (depositOf(d.ixs[n]!, pin, ctx.wallet, ctx.precommitment, reads) !== ask.amount) return refuse("amount");
  passedWire(wire);
  return { chain: "solana", op: ask.kind, token: null, amount: ask.amount, feeCap: 0n, pool: pin.pool, to: pin.pool };
}

/** A Solana pool withdraw: the device's own release to W through the pinned pool, then at most one transfer from W to
 *  `to`, the address the user typed on SIGN_HOST, of no more than the release leaves W. */
export function checkSolanaWithdraw(wire: Uint8Array, ask: PoolAsk, ctx: PoolContext, release: SolanaPoolRelease, to: string, reads: SolanaPoolReads): PoolDraw {
  if (ask.kind !== "pool.withdraw" || ask.chain !== "solana") return refuse("kind");
  const pin = pinOf(ctx);
  if (!SOL_KEY(to)) return refuse("to");
  const d = decode(wire, reads);
  if (d.signers.length !== 2 || d.signers[0] !== pin.feePayer || d.signers[1] !== ctx.wallet) return refuse("signers");
  const n = head(d.ixs);
  const rel = d.ixs[n];
  if (!rel || rel.program !== pin.program) return refuse("program");
  if (rel.data[0] !== SOLANA_POOL_TAG_RELEASE) return refuse("tag");
  let got: SolanaPoolRelease;
  try {
    got = solanaDecodePoolRelease(rel.data);
  } catch {
    return refuse("release_data");
  }
  // byte for byte the device's own release (its ready proof): a field the bytes changed is not the device's
  const want = solanaEncodePoolRelease(release);
  if (want.length !== rel.data.length || want.some((b, i) => b !== rel.data[i])) return refuse("release_not_devices");
  checkFeeAndDeadline(got.relayFee, got.relayFeeCap, got.deadlineMs, ctx);
  const accounts = solanaPoolReleaseAccounts(pin, ctx.wallet, pin.feePayer, got, reads.stateSize);
  if (!sameList(rel.accounts, accounts)) return refuse("release_accounts");
  const rest = d.ixs.slice(n + 1);
  if (rest.length > 1) return refuse("instructions");
  if (rest.length === 1) {
    const t = rest[0]!;
    if (t.program !== SOLANA_SYSTEM_PROGRAM || t.data.length !== 12 || u64le(Uint8Array.of(...t.data.subarray(0, 4), 0, 0, 0, 0), 0) !== 2n) return refuse("transfer");
    if (t.accounts.length !== 2 || !same(t.accounts[0], ctx.wallet, true, true) || !same(t.accounts[1], to, false, true)) return refuse("transfer_to");
    if (u64le(t.data, 4) > got.withdrawnValue - got.relayFee) return refuse("transfer_amount");
  }
  passedWire(wire);
  return { chain: "solana", op: ask.kind, token: null, amount: got.withdrawnValue - got.relayFee, feeCap: got.relayFeeCap, pool: pin.pool, to };
}

/** A Solana pool buy (tag 3): the kit's checks on every byte against the pinned pool, the request bound to them here. */
export function checkSolanaBuy(
  wire: Uint8Array,
  ask: PoolAsk,
  ctx: PoolContext,
  release: SolanaPoolRelease,
  venue: SolanaPoolBuyVenue,
  req: SolanaPoolBuyRequest,
  reads: SolanaPoolBuyReads,
): PoolDraw {
  if (ask.kind !== "pool.buy" || ask.chain !== "solana") return refuse("kind");
  const pin = pinOf(ctx);
  if (req.wallet !== ctx.wallet) return refuse("wallet");
  if (req.feePayer !== pin.feePayer) return refuse("fee_payer");
  if (req.token !== ask.token || venue.mint !== ask.token) return refuse("token");
  if (req.spend !== ask.amount) return refuse("amount");
  if (reads.reference.slippageBps !== ask.slippageBps) return refuse("slippage");
  checkFeeAndDeadline(release.relayFee, release.relayFeeCap, release.deadlineMs, ctx);
  const verdict = checkSolanaPoolBuy(wire, { program: pin.program, pool: pin.pool }, release, venue, req, reads);
  if (!verdict.ok) return refuse(`buy_${verdict.results.find((r) => !r.ok)?.id ?? "checks"}`);
  passedWire(wire);
  return { chain: "solana", op: ask.kind, token: ask.token, amount: ask.amount, feeCap: release.relayFeeCap, pool: pin.pool, to: ctx.wallet };
}

/** A Solana pool sell: the kit's venue sell of the request's amount from W at a min out no lower than the device's
 *  floor, then the deposit of at most that min out back into the pinned pool, last, by W. */
export function checkSolanaSell(
  wire: Uint8Array,
  ask: PoolAsk,
  ctx: PoolContext & { precommitment: bigint },
  venue: SolanaPoolBuyVenue,
  reference: Parameters<typeof solanaPoolSellMinOut>[2],
  slot: number,
  reads: SolanaPoolReads,
): PoolDraw {
  if (ask.kind !== "pool.sell" || ask.chain !== "solana") return refuse("kind");
  const pin = pinOf(ctx);
  if (venue.mint !== ask.token) return refuse("token");
  if (reference.slippageBps !== ask.slippageBps) return refuse("slippage");
  let floor: bigint;
  try {
    floor = solanaPoolSellMinOut(venue, ask.amount, reference, slot);
  } catch {
    return refuse("floor");
  }
  const d = decode(wire, reads);
  if (d.signers.length !== 1 || d.signers[0] !== ctx.wallet) return refuse("signers");
  const n = head(d.ixs);
  const body = d.ixs.slice(n);
  const dep = body.at(-1);
  const sell = body.slice(0, -1);
  if (!dep) return refuse("instructions");
  // the min out the bytes carry: the venue sell's last 8 data bytes (pump's and PumpSwap's sell(amount, min_out))
  const venueIx = sell.find((x) => x.data.length === 24);
  if (!venueIx) return refuse("sell");
  const minOut = u64le(venueIx.data, 16);
  if (minOut < floor) return refuse("min_out");
  const want = solanaPoolSellSteps(venue, ctx.wallet, ask.amount, minOut);
  if (sell.length !== want.length) return refuse("sell");
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = sell[i]!;
    if (g.program !== w.program || g.data.length !== w.data.length || g.data.some((b, j) => b !== w.data[j])) return refuse("sell");
    if (!sameList(g.accounts, w.accounts)) return refuse("sell_accounts");
  }
  if (depositOf(dep, pin, ctx.wallet, ctx.precommitment, reads) > minOut) return refuse("deposit_over_min_out");
  passedWire(wire);
  return { chain: "solana", op: ask.kind, token: ask.token, amount: ask.amount, feeCap: 0n, pool: pin.pool, to: pin.pool };
}

/** A sell's teardown frames (card solana-sell-teardown): the kit's checkSolanaTeardown for W, nothing else. */
export function checkSolanaTeardownFrames(wires: readonly Uint8Array[], ctx: PoolContext, reads: SolanaTeardownReads): void {
  const v = checkSolanaTeardown(wires, ctx.wallet, reads);
  if (!v.ok) refuse("teardown");
  passedWire(...wires);
}

/** W's ed25519 signature of a checked Solana message: `wire` must be the very array a check above passed (a copy, or
 *  one changed after, is refused unchecked: the check read these bytes, so a change is bytes no check read). */
export function signSolana(secretKey: Uint8Array, wire: Uint8Array): Uint8Array {
  const read = wire instanceof Uint8Array ? SOLANA_CHECKED.get(wire) : undefined;
  if (!read || read.length !== wire.length || read.some((b, i) => b !== wire[i])) return refuse("unchecked");
  const slots = wire[0]!;
  return ed25519.sign(wire.subarray(1 + 64 * slots), secretKey);
}

// ---------- EVM ----------

const EVM_CHAIN: Readonly<Record<"base" | "robinhood", EvmPoolChain>> = Object.freeze({ base: "base", robinhood: "robinhood" });
const evmChainOf = (ask: PoolAsk, testnet: boolean): EvmPoolChain => {
  if (ask.chain === "solana") return refuse("chain");
  return testnet ? (ask.chain === "base" ? "base-sepolia" : "robinhood-testnet") : EVM_CHAIN[ask.chain];
};
const evmPins = (ctx: PoolContext, chain: EvmPoolChain) => {
  const e = ctx.evm;
  if (!e || !EVM_ADDRESS.test(e.feeRecipient)) return refuse("evm_not_pinned");
  let p: ReturnType<typeof venuePins>;
  try {
    p = venuePins(e.venues, chain);
  } catch {
    return refuse("chain");
  }
  if (p.pool === undefined) return refuse("evm_not_pinned");
  const venue = e.venues[chain]!;
  return { ...p, pool: p.pool, chainId: BigInt(venue.chainId), feeRecipient: e.feeRecipient };
};

/** The relay data a proof's context binds, held to W, the pinned fee recipient, the fee cap and the deadline, and the
 *  context recomputed from it on the pinned pool: a proof bound to any other request is not this one. */
function checkRelay(proof: EvmPoolProofBinding, relay: EvmRelayData, pins: ReturnType<typeof evmPins>, ctx: PoolContext): void {
  if (lower(relay.recipient) !== lower(ctx.wallet)) refuse("recipient");
  if (lower(relay.feeRecipient) !== lower(pins.feeRecipient)) refuse("fee_recipient");
  if (relay.feeCap > ctx.feeCap) refuse("fee_cap_over_device_cap");
  if (relay.deadlineMs <= ctx.nowMs) refuse("deadline_past");
  let context: bigint;
  try {
    context = evmPoolContextOf({ processooor: pins.pool, relay }, evmPoolScopeOf(pins.pool, pins.chainId));
  } catch {
    return refuse("relay");
  }
  if (proof.context !== context) refuse("context");
}

/** An EVM pool buy: the kit's pinned Buy, the request's token and amount, a min out at least `floor` (the device's
 *  own floor from its two-RPC pool reads, less the user's slippage), the proof's relay data the device's. */
export function checkEvmBuy(built: EvmPoolBuy, pool: string, proof: EvmPoolProofBinding, relay: EvmRelayData, ask: PoolAsk, ctx: PoolContext, floor: bigint, testnet = false): PoolDraw {
  if (ask.kind !== "pool.buy") return refuse("kind");
  const chain = evmChainOf(ask, testnet);
  const pins = evmPins(ctx, chain);
  if (built.chain !== chain) return refuse("chain");
  if (lower(pool) !== lower(pins.pool)) return refuse("pool");
  if (![pins.v3, pins.v4].some((a) => a !== undefined && lower(a) === lower(built.adapter))) return refuse("adapter");
  if (lower(built.token) !== lower(ask.token ?? "")) return refuse("token");
  if (proof.value !== ask.amount) return refuse("amount");
  if (typeof floor !== "bigint" || floor <= 0n || built.minOut < floor) return refuse("min_out");
  checkRelay(proof, relay, pins, ctx);
  passed("evm.buy", built);
  passedProof("evm.buy", proof);
  return { chain: ask.chain, op: ask.kind, token: built.token, amount: ask.amount, feeCap: relay.feeCap, pool: pins.pool, to: ctx.wallet };
}

/** An EVM pool withdraw: Withdraw(nullifier, context, value) on the pinned pool, the relay data paying W. */
export function checkEvmWithdraw(pool: string, proof: EvmPoolProofBinding, relay: EvmRelayData, ask: PoolAsk, ctx: PoolContext, testnet = false): PoolDraw {
  if (ask.kind !== "pool.withdraw") return refuse("kind");
  const chain = evmChainOf(ask, testnet);
  const pins = evmPins(ctx, chain);
  if (lower(pool) !== lower(pins.pool)) return refuse("pool");
  if (proof.value === 0n) return refuse("amount");
  checkRelay(proof, relay, pins, ctx);
  passedProof("evm.withdraw", proof);
  return { chain: ask.chain, op: ask.kind, token: null, amount: proof.value, feeCap: relay.feeCap, pool: pins.pool, to: ctx.wallet };
}

/** An EVM pool sell: W's own Sell into the pinned pool, the request's token and amount, a min out at least `floor` (the
 *  device's own, from its two-RPC pool reads), within the fee cap, unexpired. */
export function checkEvmSell(built: EvmPoolSell, ask: PoolAsk, ctx: PoolContext, floor: bigint, testnet = false): PoolDraw {
  if (ask.kind !== "pool.sell") return refuse("kind");
  const chain = evmChainOf(ask, testnet);
  const pins = evmPins(ctx, chain);
  if (built.chain !== chain) return refuse("chain");
  if (lower(built.w) !== lower(ctx.wallet)) return refuse("wallet");
  if (lower(built.pool) !== lower(pins.pool)) return refuse("pool");
  if (lower(built.token) !== lower(ask.token ?? "")) return refuse("token");
  if (built.amount !== ask.amount) return refuse("amount");
  if (built.feeCap > ctx.feeCap) return refuse("fee_cap_over_device_cap");
  if (built.deadline * 1000n <= ctx.nowMs) return refuse("deadline_past");
  if (typeof floor !== "bigint" || floor <= 0n || built.minOut < floor) return refuse("min_out");
  passed("evm.sell", built);
  return { chain: ask.chain, op: ask.kind, token: built.token, amount: built.amount, feeCap: built.feeCap, pool: pins.pool, to: pins.pool };
}

/** The pinned sell delegate W's EIP-7702 authorization names, at `nonce`, W's account nonce read on two RPCs. */
export type EvmAuthorizationChecked = { readonly chain: EvmPoolChain; readonly delegate: string; readonly nonce: bigint };
export function checkEvmAuthorization(ask: PoolAsk, ctx: PoolContext, nonce: bigint, nonceReads: readonly [bigint, bigint], testnet = false): EvmAuthorizationChecked {
  if (ask.kind !== "pool.sell") return refuse("kind");
  const chain = evmChainOf(ask, testnet);
  const pins = evmPins(ctx, chain);
  if (pins.sellDelegate === undefined) return refuse("delegate_not_pinned");
  if (nonceReads[0] !== nonceReads[1] || nonce !== nonceReads[0]) return refuse("nonce");
  const out = Object.freeze({ chain, delegate: pins.sellDelegate, nonce });
  passed("evm.authorization", out);
  return out;
}

// The signers: each takes only what its check passed, through the kit's pinned signer where the kit has one.

/** W's Buy signature (the kit's pinned signer: a buy its builder did not return is refused not_built). */
export function signEvmBuy(secretKey: Uint8Array, ctx: PoolContext, built: EvmPoolBuy, pool: string, proof: EvmPoolProofBinding): Uint8Array {
  mustHavePassed("evm.buy", built);
  proofMustHavePassed("evm.buy", proof);
  return pinnedSignBuy(ctx.evm!.venues, secretKey, built.chain, pool, built, proof);
}
/** W's Sell signature (the kit's pinned signer: a sell its builder did not return is refused not_built). */
export function signEvmSell(secretKey: Uint8Array, ctx: PoolContext, built: EvmPoolSell): Uint8Array {
  mustHavePassed("evm.sell", built);
  return pinnedSignSell(ctx.evm!.venues, secretKey, built.chain, built);
}
/** W's EIP-7702 authorization of the chain's pinned sell delegate only, at the nonce checkEvmAuthorization passed. */
export function signEvmAuthorization(secretKey: Uint8Array, ctx: PoolContext, checked: EvmAuthorizationChecked): EvmPoolSellAuthorization {
  mustHavePassed("evm.authorization", checked);
  return pinnedSignSellAuthorization(ctx.evm!.venues, secretKey, checked.chain, checked.nonce);
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const word = (v: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 31, x = v; i >= 0; i--, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
};
const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of p) out.set(x, (at += x.length) - x.length);
  return out;
};

/** The EIP-712 digest of Withdraw(nullifier, context, value) on `pool`, as PrivacyPool.withdraw makes it
 *  (contracts/pool-evm/src/PrivacyPool.sol: WITHDRAW_TYPEHASH, the Blindfill domain at version 1). */
export function evmWithdrawDigest(chainId: bigint, pool: string, proof: EvmPoolProofBinding): Uint8Array {
  const domain = keccak_256(
    cat(keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak_256(utf8("Blindfill")), keccak_256(utf8("1")), word(chainId), word(BigInt(pool))),
  );
  const struct = keccak_256(cat(keccak_256(utf8("Withdraw(uint256 nullifier,uint256 context,uint256 value)")), word(proof.nullifier), word(proof.context), word(proof.value)));
  return keccak_256(cat(Uint8Array.of(0x19, 0x01), domain, struct));
}

/** W's Withdraw signature, 65 bytes r ‖ s ‖ v, s low: only after checkEvmWithdraw passed for this pool and proof. */
export function signEvmWithdraw(secretKey: Uint8Array, ctx: PoolContext, ask: PoolAsk, pool: string, proof: EvmPoolProofBinding, testnet = false): Uint8Array {
  proofMustHavePassed("evm.withdraw", proof);
  const pins = evmPins(ctx, evmChainOf(ask, testnet));
  if (lower(pool) !== lower(pins.pool)) return refuse("pool");
  const rec = secp256k1.sign(evmWithdrawDigest(pins.chainId, pins.pool, proof), secretKey, { prehash: false, lowS: true, format: "recovered" });
  const out = new Uint8Array(65);
  out.set(rec.slice(1, 65), 0);
  out[64] = 27 + rec[0]!;
  return out;
}

// ---------- the draw ----------

/** The page's lines for a checked payload, label then value: drafts until the owner picks the words. */
export function drawPool(d: PoolDraw, fmt: (amount: bigint) => string): [string, string][] {
  const lines: [string, string][] = [
    ["Chain", d.chain === "solana" ? "Solana" : d.chain === "base" ? "Base" : "Robinhood"],
    ["Amount", fmt(d.amount)],
  ];
  if (d.token !== null) lines.splice(1, 0, ["Token", d.token]);
  lines.push(["Fee cap", fmt(d.feeCap)], ["Pool", d.pool]);
  return lines;
}
