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
//   device's, the deadline ahead; then exactly one transfer, from W to the address typed on SIGN_HOST, of the release's
//   whole net value (withdrawn less the relay fee: tag 2 pays no tip), so the draw is what lands there.
// - Solana buy, tag 3: the kit's checkSolanaPoolBuy against the pinned pool (it rebuilds every byte from the device's
//   reads), with W, the token and the release bound to the request here.
// - Solana sell: the kit's venue sell of the request's amount from W, a min out at least the device's floor, then the
//   deposit back into the pinned pool (tag 1, W the depositor, the device's precommitment) as the last instruction, of
//   exactly that min out less the device's reserve for W's fees. Its
//   teardown frames (card solana-sell-teardown) go through the kit's checkSolanaTeardown for W; after a full sell, W's
//   sweep (card sol-buy-rent-back) is one tag 1 deposit of exactly what W holds less its fee and the deposit's rents, on
//   the device's precommitment, so W ends at 0 (checkSolanaSweep).
// - EVM buy and withdraw: the proof binds a context; the device recomputes it from the relay data and the pinned pool
//   and holds W the recipient, the pinned fee recipient, the fee cap and the deadline. The buy is one the kit built from
//   the device's own quote (kit trade/evm/quoted.ts evmQuotedBuy: its route, min out and empty hook data the device's,
//   card evm-buy-hookdata-fee), its adapter a pin, its token the request's; any other build is refused before signing.
// - EVM sell: W's own sell into the pinned pool, the request's token and amount, the device's precommitment (else the
//   proceeds are another's note), the fee cap and deadline held here; a sell the kit built from the device's own sell
//   quote only (quoted.ts evmQuotedSell: its route and min out the device's, its fee cap within the device's fee rule),
//   any other build refused before signing.
// - EVM authorization (EIP-7702): only the chain's pinned sell delegate, at W's account nonce read on two RPCs.
// - The request: its amount in the pool asset's decimals (SOL 9, ETH 18), or for a sell the token's, from the device's
//   two-RPC read of the mint or decimals() (tokenDecimalsOf); bound by u64 on Solana and uint256 on EVM.
//
// - Everywhere: a compute budget within the runtime's limit and the kit's price cap, so no payer is made to pay more than
//   1,400,000 lamports of priority fee; an EVM buy's or sell's min out at least the floor the device made from its own
//   two-RPC reads; and each signer below signs only what a check passed, as the check read it (a copy, a byte or value
//   changed after, or a proof checked as one op signed as another is refused "unchecked").
//
// Every other op, chain or instruction is refused. Draws are what the page shows before the press: chain, token,
// amount, fee cap and the pool, as the pins name it (drawPool; its words are drafts until the owner picks them, but the
// two picked 3 Nov 20:26Z: "To private balance" and "Max fee").
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
import { SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_CU_PRICE_MAX, SOLANA_LAMPORTS_PER_SIGNATURE, SOLANA_SYSTEM_PROGRAM, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, checkSolanaTeardown, type SolanaTeardownReads } from "../../../kit/src/checks/solana/checks.ts";
import {
  SOLANA_POOL_TAG_RELEASE,
  checkSolanaPoolBuy,
  solanaDecodePoolRelease,
  solanaEncodePoolRelease,
  solanaPoolFee,
  solanaPoolPage,
  solanaPoolReleaseAccounts,
  solanaPoolSellMinOut,
  solanaPoolSellSteps,
  solanaRentMin,
  type SolanaPoolBuyReads,
  type SolanaPoolBuyRequest,
  type SolanaPoolBuyVenue,
  type SolanaPoolRelease,
  type SolanaRent,
} from "../../../kit/src/trade/solana/pool-buy.ts";
import { pinnedSignBuy, venuePins, type EvmPoolBuy, type EvmPoolChain, type EvmPoolProofBinding, type EvmPoolVenueList } from "../../../kit/src/trade/evm/buy-unpinned.ts";
import { EVM_SELL_SIM, pinnedSignSell, pinnedSignSellAuthorization, pinnedSignSimSell, type EvmPoolSell, type EvmPoolSellAuthorization, type EvmSellSim } from "../../../kit/src/trade/evm/sell-unpinned.ts";
import { evmIsQuotedBuy, evmIsQuotedSell } from "../../../kit/src/trade/evm/quoted.ts";
import { evmPoolContextOf, evmPoolScopeOf, EVM_CHAIN_IDS, EVM_LADDER, type EvmPoolPin, type EvmRelayData } from "../../../wallet/src/pool/evm.ts";

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
/** The most one transaction W signs alone can cost W: one signature and the priority fee at the compute and price caps
 *  above (5,000 + 1,400,000 lamports). */
export const SOLANA_POOL_TX_FEE_MAX = SOLANA_LAMPORTS_PER_SIGNATURE + (BigInt(SOLANA_POOL_CU_LIMIT_MAX) * SOLANA_CU_PRICE_MAX) / 1_000_000n;
/** The most rent per byte the sell's reserve cap allows: the Rent sysvar's long-standing rate, 3,480 lamports a
 *  byte-year exempt at 2 years (6,960 lamports a byte; devnet asks less). */
export const SOLANA_RENT_PER_BYTE_MAX = 6_960n;
/** The most a sell may keep on W, out of the pool: its worst legitimate cost on W beyond what W holds as the buy and
 *  sell rules leave it (src/pool-sell.ts: W holds the sell's own need before it, and keeps rent(0) after a whole sale
 *  or the next sell's need after a partial one), so the cap refuses only an illegitimate short, never a funded W:
 *  the sell's fee at its cap, the rent of the precommitment's mark (17 bytes) and, at a page boundary of both trees,
 *  of a new page on each (a 16-byte header and one 72-byte entry), every account's rent being (128 + bytes) × rate:
 *      1,405,000   SOLANA_POOL_TX_FEE_MAX
 *    + 1,009,200   (128 + 17) × 6,960
 *    + 3,006,720   2 × (128 + 16 + 72) × 6,960
 *    = 5,420,920 lamports.
 *  A larger reserve is money held back from the user's note, whoever asks for it (the re-review of signpage-pool-sell
 *  fd5eec3: the old cap, two fees, 2,810,000, refused a funded W whose deposit opened a page on both trees). */
export const SOLANA_POOL_SELL_RESERVE_MAX = SOLANA_POOL_TX_FEE_MAX + (128n + 17n) * SOLANA_RENT_PER_BYTE_MAX + 2n * (128n + 16n + 72n) * SOLANA_RENT_PER_BYTE_MAX;

// Every payload a check passed, by identity and by what it is, with what the check read: the signers below sign only
// these, and only from that read (the pins, the venue list, the proof's values), never from a payload or a context
// read again, so no path reaches a key around a check, and a proof checked as a buy is never signed as a withdraw
type Checked = "evm.buy" | "evm.withdraw" | "evm.sell" | "evm.sim" | "evm.authorization";
/** What a check read for its signer: the venue list it checked against, the pool and chain id, a proof's values. */
type Read = { readonly venues: EvmPoolVenueList; readonly pool: string; readonly chainId: bigint; readonly proof?: Readonly<EvmPoolProofBinding>; readonly sim?: { readonly blockTimestamp: bigint; readonly nowMs: bigint } };
const CHECKED: Readonly<Record<Checked, WeakMap<object, Read>>> = Object.freeze({
  "evm.buy": new WeakMap<object, Read>(),
  "evm.withdraw": new WeakMap<object, Read>(),
  "evm.sell": new WeakMap<object, Read>(),
  "evm.sim": new WeakMap<object, Read>(),
  "evm.authorization": new WeakMap<object, Read>(),
});
const passed = (as: Checked, x: object, read: Read): void => {
  CHECKED[as].set(x, Object.freeze({ ...read }));
};
const mustHavePassed = (as: Checked, x: object): Read => {
  const r = typeof x === "object" && x !== null ? CHECKED[as].get(x) : undefined;
  return r ?? refuse("unchecked");
};
// A proof's values are an object its holder can still write to (or read through a getter): the values the check read
// are kept frozen beside it, a proof that reads otherwise now is refused, and the signer signs the kept values
const snapProof = (p: EvmPoolProofBinding): Readonly<EvmPoolProofBinding> => Object.freeze({ nullifier: p.nullifier, context: p.context, value: p.value });
const proofMustHavePassed = (as: Checked, p: EvmPoolProofBinding): Read & { proof: Readonly<EvmPoolProofBinding> } => {
  const r = mustHavePassed(as, p);
  const k = r.proof;
  if (!k || p.nullifier !== k.nullifier || p.context !== k.context || p.value !== k.value) return refuse("unchecked");
  return { ...r, proof: k };
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
export type PoolAsk = { kind: PoolKind; chain: PoolChain; token: string | null; amount: bigint; slippageBps: number; decimals: number };

/** Whether `token` is an address on `chain` (a 32-byte base58 key on Solana, 0x and 40 hex on EVM): checked before
 *  the device reads anything for it. */
export function poolTokenAddress(chain: PoolChain, token: unknown): token is string {
  return typeof token === "string" && (chain === "solana" ? SOL_KEY(token) : EVM_ADDRESS.test(token));
}
export const SOL_KEY = (s: string): boolean => {
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
};
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(0|[1-9]\d{0,29})(?:\.(\d{1,18}))?$/;
const lower = (s: string) => s.toLowerCase();

/** Each pool chain's pool asset's decimals: the Solana pool holds SOL (9), the EVM pools the native ETH (18,
 *  PrivacyPoolSimple's Constants.NATIVE_ASSET). Fixed here, never a caller's. */
export const POOL_ASSET_DECIMALS_OF: Readonly<Record<PoolChain, number>> = Object.freeze({ solana: 9, base: 18, robinhood: 18 });
/** The most base units an amount may be: a Solana u64; an EVM uint256 (a pool deposit's own bound is the contract's). */
const AMOUNT_BOUND: Readonly<Record<PoolChain, bigint>> = Object.freeze({ solana: 1n << 64n, base: 1n << 256n, robinhood: 1n << 256n });

/** A token's decimals as two providers answered the device's own read of it (src/pool-reads.ts): the Solana mint
 *  account (getAccountInfo, base64) or the ERC-20's decimals() (eth_call), each answer raw and hostile until parsed. */
export type TokenDecimalsReads = readonly [unknown, unknown];
const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function decimalsAnswer(chain: PoolChain, a: unknown): number {
  if (chain === "solana") {
    // getAccountInfo's value: an SPL Token mint (82 bytes) or a Token-2022 mint (82 padded to 165, then account type
    // 1 = Mint), initialized (byte 45); decimals at byte 44
    const v = typeof a === "object" && a !== null ? (a as { value?: unknown }).value : undefined;
    const o = typeof v === "object" && v !== null ? (v as { owner?: unknown; data?: unknown }) : null;
    if (!o || !Array.isArray(o.data) || o.data[1] !== "base64" || typeof o.data[0] !== "string") return refuse("decimals");
    let d: Uint8Array;
    try {
      d = b64(o.data[0]);
    } catch {
      return refuse("decimals");
    }
    // a 355-byte account is a multisig, never a mint, as spl-token-2022's own unpack refuses it
    const mint = o.owner === SOLANA_TOKEN_PROGRAM ? d.length === 82 : o.owner === SOLANA_TOKEN_2022_PROGRAM && (d.length === 82 || (d.length > 165 && d.length !== 355 && d[165] === 1));
    if (!mint || d[45] !== 1) return refuse("decimals");
    return d[44]!;
  }
  // decimals() returns uint8, ABI-encoded as one 32-byte word under 256
  if (typeof a !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(a)) return refuse("decimals");
  const n = BigInt(a);
  if (n > 255n) return refuse("decimals");
  return Number(n);
}
/** The token's decimals: both providers' answers parsed, and the two the same; else refused "decimals". */
export function tokenDecimalsOf(chain: PoolChain, reads: TokenDecimalsReads): number {
  if (!Array.isArray(reads) || reads.length !== 2) return refuse("decimals");
  const a = decimalsAnswer(chain, reads[0]);
  if (decimalsAnswer(chain, reads[1]) !== a) return refuse("decimals");
  return a;
}

/** The request checked against its kind: the chain a pool chain, the token an address of that chain (buy and sell),
 *  the amount a decimal above 0 within its decimals (the pool asset's for a deposit or a buy, the token's from the
 *  device's two reads for a sell: never the caller's), the slippage in range; withdraw takes nothing but its chain. */
export function checkPoolRequest(p: PoolRequest, tokenReads?: TokenDecimalsReads): PoolAsk {
  if (typeof p !== "object" || p === null || !(POOL_KINDS as readonly string[]).includes(p.kind)) return refuse("kind");
  if (!(POOL_CHAINS as readonly string[]).includes(p.chain)) return refuse("chain");
  const chain = p.chain as PoolChain;
  const asset = POOL_ASSET_DECIMALS_OF[chain];
  if (p.kind === "pool.withdraw") return { kind: p.kind, chain, token: null, amount: 0n, slippageBps: 0, decimals: asset };
  const token = p.token;
  if (p.kind !== "pool.deposit" && (typeof token !== "string" || !(chain === "solana" ? SOL_KEY(token) : EVM_ADDRESS.test(token)))) return refuse("token");
  const decimals = p.kind === "pool.sell" ? tokenDecimalsOf(chain, tokenReads as TokenDecimalsReads) : asset;
  const m = typeof p.amount === "string" ? DECIMAL.exec(p.amount) : null;
  if (!m || (m[2] ?? "").length > decimals) return refuse("amount");
  const amount = BigInt(m[1]! + (m[2] ?? "").padEnd(decimals, "0"));
  if (amount === 0n || amount >= AMOUNT_BOUND[chain]) return refuse("amount");
  if (p.kind === "pool.deposit") return { kind: p.kind, chain, token: null, amount, slippageBps: 0, decimals };
  const s = p.slippage_bps;
  if (typeof s !== "number" || !Number.isInteger(s) || s < 0 || s > POOL_MAX_SLIPPAGE_BPS) return refuse("slippage");
  return { kind: p.kind, chain, token: token!, amount, slippageBps: s, decimals };
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

/** What the page draws before the press. `pool` is the pin's address, `to` where the money lands; `amount` in
 *  `decimals` (the ask's: the pool asset's, or a sold token's as the device read it); `feeCap` and a sell's `back` (what
 *  goes into the pool: the Solana deposit, the EVM sell's min out) in the pool asset's. */
export type PoolDraw = { chain: PoolChain; op: PoolKind; token: string | null; amount: bigint; feeCap: bigint; pool: string; to: string; decimals: number; back: bigint | null };

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
  return { chain: "solana", op: ask.kind, token: null, amount: ask.amount, feeCap: 0n, pool: pin.pool, to: pin.pool, decimals: ask.decimals, back: null };
}

/** A Solana pool withdraw's release (card signpage-pool-withdraw-form, the review of #232): the device's own release
 *  to W through the pinned pool, alone after the compute budget (the helper sends nothing else with a tag 2), so it
 *  lands or fails on the pool's own rules, never on a transfer W's holder could make fail. The draw is where it lands:
 *  W. W's own send onward to the typed address is a second transaction (checkSolanaOnwardSend). */
export function checkSolanaWithdraw(wire: Uint8Array, ask: PoolAsk, ctx: PoolContext, release: SolanaPoolRelease, reads: SolanaPoolReads): PoolDraw {
  if (ask.kind !== "pool.withdraw" || ask.chain !== "solana") return refuse("kind");
  const pin = pinOf(ctx);
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
  // byte for byte the device's own release (its proof): a field the bytes changed is not the device's
  const want = solanaEncodePoolRelease(release);
  if (want.length !== rel.data.length || want.some((b, i) => b !== rel.data[i])) return refuse("release_not_devices");
  checkFeeAndDeadline(got.relayFee, got.relayFeeCap, got.deadlineMs, ctx);
  const accounts = solanaPoolReleaseAccounts(pin, ctx.wallet, pin.feePayer, got, reads.stateSize);
  if (!sameList(rel.accounts, accounts)) return refuse("release_accounts");
  // the release alone: nothing after it
  if (d.ixs.length > n + 1) return refuse("instructions");
  passedWire(wire);
  return { chain: "solana", op: ask.kind, token: null, amount: got.withdrawnValue - got.relayFee, feeCap: got.relayFeeCap, pool: pin.pool, to: ctx.wallet, decimals: ask.decimals, back: null };
}

/** The keys the Solana runtime keeps read-only in every transaction: its reserved account keys (agave
 *  reserved-account-keys/src/lib.rs RESERVED_ACCOUNTS at f2046e514dd0, the ids from solana-sdk sdk-ids/src/lib.rs at
 *  28c48986ed): the builtin programs and the sysvars. A transfer to one can never land. */
export const SOLANA_RESERVED_KEYS: readonly string[] = Object.freeze([
  // builtin programs
  "AddressLookupTab1e1111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "Config1111111111111111111111111111111111111",
  "Ed25519SigVerify111111111111111111111111111",
  "Feature111111111111111111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  "KeccakSecp256k11111111111111111111111111111",
  "Secp256r1SigVerify1111111111111111111111111",
  "StakeConfig11111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "11111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  "ZkE1Gama1Proof11111111111111111111111111111",
  "ZkTokenProof1111111111111111111111111111111",
  // sysvars
  "SysvarC1ock11111111111111111111111111111111",
  "SysvarEpochRewards1111111111111111111111111",
  "SysvarEpochSchedu1e111111111111111111111111",
  "SysvarFees111111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "SysvarLastRestartS1ot1111111111111111111111",
  "SysvarRecentB1ockHashes11111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarRewards111111111111111111111111111111",
  "SysvarS1otHashes111111111111111111111111111",
  "SysvarS1otHistory11111111111111111111111111",
  "SysvarStakeHistory1111111111111111111111111",
  // other
  "NativeLoader1111111111111111111111111111111",
  "Sysvar1111111111111111111111111111111111111",
]);

/** The device's reads for W's onward send, each as its two RPCs answered (they must agree): W's balance once its
 *  release landed, the network's fee for this very message (getFeeForMessage), whether the typed address is an
 *  executable account; with the release's own accounts, none of which is ever the destination. */
export type SolanaOnwardReads = {
  readonly blockhash: string;
  readonly balance: readonly [bigint, bigint];
  readonly fee: readonly [bigint, bigint];
  readonly toExecutable: readonly [boolean, boolean];
  readonly releaseAccounts: readonly string[];
};

/** W's onward send of a Solana pool withdraw: one System transfer of all W holds less its own fee to `to`, the address
 *  typed on SIGN_HOST, W its only signer and fee payer, so W ends at 0 and nothing else is in the transaction. */
export function checkSolanaOnwardSend(wire: Uint8Array, ask: PoolAsk, ctx: PoolContext, to: string, reads: SolanaOnwardReads): PoolDraw {
  if (ask.kind !== "pool.withdraw" || ask.chain !== "solana") return refuse("kind");
  const pin = pinOf(ctx);
  // the typed address: a key, never W, the pool, its program, the fee payer, an account of the release (its pages or
  // mark), a key the runtime keeps read-only (SOLANA_RESERVED_KEYS, System among them) or an executable account
  if (!SOL_KEY(to) || [ctx.wallet, pin.pool, pin.program, pin.feePayer, ...reads.releaseAccounts].includes(to) || SOLANA_RESERVED_KEYS.includes(to)) return refuse("to");
  if (!Array.isArray(reads.toExecutable) || reads.toExecutable.length !== 2 || reads.toExecutable.some((x) => x !== false)) return refuse("to");
  const agreed = (p: readonly [bigint, bigint]): bigint => (Array.isArray(p) && p.length === 2 && typeof p[0] === "bigint" && p[0] >= 0n && p[0] === p[1] ? p[0] : refuse("reads"));
  const balance = agreed(reads.balance);
  const fee = agreed(reads.fee);
  const d = decode(wire, { blockhash: reads.blockhash, tables: {}, stateSize: 0, labelSize: 0 });
  // W alone signs and pays: no fee payer of ours, nobody else's key
  if (d.signers.length !== 1 || d.signers[0] !== ctx.wallet) return refuse("signers");
  // one transfer, no compute budget (W pays the base fee only) and nothing beside it
  if (d.ixs.length !== 1) return refuse("instructions");
  const t = d.ixs[0]!;
  if (t.program !== SOLANA_SYSTEM_PROGRAM || t.data.length !== 12 || u64le(Uint8Array.of(...t.data.subarray(0, 4), 0, 0, 0, 0), 0) !== 2n) return refuse("transfer");
  if (t.accounts.length !== 2 || !same(t.accounts[0], ctx.wallet, true, true) || !same(t.accounts[1], to, false, true)) return refuse("transfer_to");
  // all W holds less the fee: W ends at 0, nothing left on it, never more than it holds
  const amount = u64le(t.data, 4);
  if (amount === 0n || amount + fee !== balance) return refuse("transfer_amount");
  passedWire(wire);
  return { chain: "solana", op: ask.kind, token: null, amount, feeCap: fee, pool: pin.pool, to, decimals: ask.decimals, back: null };
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
  return { chain: "solana", op: ask.kind, token: ask.token, amount: ask.amount, feeCap: release.relayFeeCap, pool: pin.pool, to: ctx.wallet, decimals: ask.decimals, back: null };
}

/** A Solana pool sell: the kit's venue sell of the request's amount from W at a min out no lower than the device's
 *  floor, then, last, by W, the deposit into the pinned pool of exactly that min out less `reserve`, the lamports the
 *  device keeps on W for the sell's own fees (its own number, never a server's); the draw shows that deposit. */
export function checkSolanaSell(
  wire: Uint8Array,
  ask: PoolAsk,
  ctx: PoolContext & { precommitment: bigint },
  venue: SolanaPoolBuyVenue,
  reference: Parameters<typeof solanaPoolSellMinOut>[2],
  slot: number,
  reads: SolanaPoolReads,
  reserve: bigint,
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
  if (typeof reserve !== "bigint" || reserve < 0n || reserve > SOLANA_POOL_SELL_RESERVE_MAX || reserve >= minOut) return refuse("reserve");
  const back = depositOf(dep, pin, ctx.wallet, ctx.precommitment, reads);
  if (back !== minOut - reserve) return refuse("deposit_amount");
  passedWire(wire);
  return { chain: "solana", op: ask.kind, token: ask.token, amount: ask.amount, feeCap: 0n, pool: pin.pool, to: pin.pool, decimals: ask.decimals, back };
}

/** The least a Solana pool deposit may be: contracts/pool-solana/src/lib.rs MIN_DEPOSIT (MinimumDepositAmount). */
export const SOLANA_POOL_MIN_DEPOSIT = 1_000_000n;
const SWEEP_MARK_LEN = 17;
const SWEEP_PAGE_HEADER = 16;
const SWEEP_PAGE_ENTRY = 72;
const SWEEP_PAGE_ENTRIES = 1024;

/** A part's smallest arrival: rent(0), so To (when new) and W after its release (part + W's fee on it) are both
 *  rent-exempt; and at least the relay fee less W's fee, so the chunk (part + fee + W's fee) meets the program's
 *  backstop of 2 x fee. A withdraw binds tipCap 0 (its tag 2 pays no tip), so no tip cap counts here. */
export const solanaWithdrawMinPart = (rent: SolanaRent, fee: bigint, wFee: bigint): bigint => {
  const r = solanaRentMin(rent, 0);
  return fee - wFee > r ? fee - wFee : r;
};
/** What every withdraw part costs: the epoch's relay fee, W's own fee for its send onward, and the smallest part. */
export type WithdrawCosts = { fee: bigint; wFee: bigint; minPart: bigint };
/** The smallest note one part can withdraw: a change under it (and above 0) could never leave the pool, so no part
 *  leaves one (review #232 HIGH 2). */
export const withdrawNoteFloor = (c: WithdrawCosts): bigint => c.fee + c.wFee + c.minPart;
/** The smallest note the device ever makes from W's own lamports (card sol-buy-rent-back, review M1): one a withdraw
 *  can spend, at the epoch's relay fee (the kit's solanaPoolFee), W's one signature and the smallest part. Under it the
 *  lamports stay on W, under the device's key, where they are worth their face; in the pool they would be a note no
 *  withdraw and no buy can spend, and the deposit's rents would be gone too. */
export const solanaSweepFloor = (rent: SolanaRent): bigint => {
  const fee = solanaPoolFee(rent);
  return withdrawNoteFloor({ fee, wFee: SOLANA_LAMPORTS_PER_SIGNATURE, minPart: solanaWithdrawMinPart(rent, fee, SOLANA_LAMPORTS_PER_SIGNATURE) });
};

/** The lamports a tag 1 deposit's three accounts hold before it, on each RPC (null: no account): its mark, and the
 *  state and label pages it writes to. */
export type SolanaDepositHeld = { mark: readonly [bigint | null, bigint | null]; state: readonly [bigint | null, bigint | null]; label: readonly [bigint | null, bigint | null] };

/**
 * What a tag 1 deposit takes from its depositor beyond its value, as the program prices it (contracts/pool-solana
 * src/state.rs create_pda and the page insert): each of the mark (17 bytes) and the two pages it writes (the header and
 * one entry more than the tree's size in that page) is topped up to its rent at its new length, less what it holds
 * already (anyone may send lamports to a page or a mark's address). `held` must be the same on both RPCs.
 */
export function solanaDepositRents(rent: SolanaRent, sizes: { stateSize: number; labelSize: number }, held: SolanaDepositHeld): bigint {
  const one = (pair: readonly [bigint | null, bigint | null], len: number): bigint => {
    if (pair[0] !== pair[1]) return refuse("deposit_reads");
    const have = pair[0] ?? 0n;
    const need = solanaRentMin(rent, len) - have;
    return need > 0n ? need : 0n;
  };
  const page = (size: number): number => SWEEP_PAGE_HEADER + ((size % SWEEP_PAGE_ENTRIES) + 1) * SWEEP_PAGE_ENTRY;
  return one(held.mark, SWEEP_MARK_LEN) + one(held.state, page(sizes.stateSize)) + one(held.label, page(sizes.labelSize));
}

/**
 * W's sweep after a full sell and its teardown (card sol-buy-rent-back): every lamport W holds back into the pinned pool
 * as one tag 1 deposit, W the depositor and the only signer, the device's precommitment (W's next return note), no
 * compute budget (W's fee is its one signature, SOLANA_LAMPORTS_PER_SIGNATURE), nothing else. The value is exactly
 * `lamports` (W's balance, the same on both RPCs) less that fee and the rents the deposit takes from W as the program
 * prices them (solanaDepositRents, from the three accounts' lamports read on both RPCs), so W ends at 0 and no lamport is
 * left on it or sent anywhere but the user's own note. Under the smallest note the device spends (solanaSweepFloor),
 * refused: those lamports stay on W.
 */
export function checkSolanaSweep(wire: Uint8Array, ctx: PoolContext & { precommitment: bigint }, reads: SolanaPoolReads, lamports: bigint, rent: SolanaRent, held: SolanaDepositHeld): bigint {
  const pin = pinOf(ctx);
  const d = decode(wire, reads);
  if (d.signers.length !== 1 || d.signers[0] !== ctx.wallet) return refuse("signers");
  if (head(d.ixs) !== 0 || d.ixs.length !== 1) return refuse("instructions");
  const value = depositOf(d.ixs[0]!, pin, ctx.wallet, ctx.precommitment, reads);
  if (typeof lamports !== "bigint" || typeof rent?.lamportsPerByte !== "bigint" || typeof rent.factor !== "bigint" || rent.lamportsPerByte < 0n || rent.factor < 0n) return refuse("sweep_reads");
  if (value + SOLANA_LAMPORTS_PER_SIGNATURE + solanaDepositRents(rent, reads, held) !== lamports) return refuse("sweep_amount");
  if (value < SOLANA_POOL_MIN_DEPOSIT || value < solanaSweepFloor(rent)) return refuse("amount");
  passedWire(wire);
  return value;
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
  return ed25519.sign(read.subarray(1 + 64 * read[0]!), secretKey);
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
  if (!Number.isSafeInteger(venue.chainId) || venue.chainId <= 0) return refuse("chain");
  return { ...p, pool: p.pool, chainId: BigInt(venue.chainId), feeRecipient: e.feeRecipient, venues: e.venues };
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
export function checkEvmBuy(built: EvmPoolBuy, pool: string, given: EvmPoolProofBinding, relay: EvmRelayData, ask: PoolAsk, ctx: PoolContext, floor: bigint, testnet = false): PoolDraw {
  if (ask.kind !== "pool.buy") return refuse("kind");
  // only a buy built from the device's own quote: never a server's route, hook data or min out
  if (!evmIsQuotedBuy(built)) return refuse("not_quoted");
  const proof = snapProof(given);
  const chain = evmChainOf(ask, testnet);
  const pins = evmPins(ctx, chain);
  if (built.chain !== chain) return refuse("chain");
  if (lower(pool) !== lower(pins.pool)) return refuse("pool");
  if (![pins.v3, pins.v4].some((a) => a !== undefined && lower(a) === lower(built.adapter))) return refuse("adapter");
  if (lower(built.token) !== lower(ask.token ?? "")) return refuse("token");
  if (proof.value !== ask.amount) return refuse("amount");
  if (typeof floor !== "bigint" || floor <= 0n || built.minOut < floor) return refuse("min_out");
  checkRelay(proof, relay, pins, ctx);
  const read = { venues: pins.venues, pool: pins.pool, chainId: pins.chainId, proof };
  passed("evm.buy", built, read);
  passed("evm.buy", given, read);
  return { chain: ask.chain, op: ask.kind, token: built.token, amount: ask.amount, feeCap: relay.feeCap, pool: pins.pool, to: ctx.wallet, decimals: ask.decimals, back: null };
}

/** An EVM pool withdraw: Withdraw(nullifier, context, value) on the pinned pool, the relay data paying W. */
export function checkEvmWithdraw(pool: string, given: EvmPoolProofBinding, relay: EvmRelayData, ask: PoolAsk, ctx: PoolContext, testnet = false): PoolDraw {
  if (ask.kind !== "pool.withdraw") return refuse("kind");
  const proof = snapProof(given);
  const chain = evmChainOf(ask, testnet);
  const pins = evmPins(ctx, chain);
  if (lower(pool) !== lower(pins.pool)) return refuse("pool");
  if (proof.value === 0n) return refuse("amount");
  checkRelay(proof, relay, pins, ctx);
  passed("evm.withdraw", given, { venues: pins.venues, pool: pins.pool, chainId: pins.chainId, proof });
  return { chain: ask.chain, op: ask.kind, token: null, amount: proof.value, feeCap: relay.feeCap, pool: pins.pool, to: ctx.wallet, decimals: ask.decimals, back: null };
}

/** An EVM pool sell: W's own Sell into the pinned pool, the request's token and amount, a min out at least `floor` (the
 *  device's own, from its two-RPC pool reads), within the fee cap, its fee paid to the venue's pinned FeeCollector,
 *  unexpired. */
export function checkEvmSell(built: EvmPoolSell, ask: PoolAsk, ctx: PoolContext & { precommitment: bigint }, floor: bigint, testnet = false): PoolDraw {
  if (ask.kind !== "pool.sell") return refuse("kind");
  // only a sell built from the device's own sell quote: never a server's route, min out or fee cap
  if (!evmIsQuotedSell(built)) return refuse("not_quoted");
  const chain = evmChainOf(ask, testnet);
  const pins = evmPins(ctx, chain);
  if (built.chain !== chain) return refuse("chain");
  if (lower(built.w) !== lower(ctx.wallet)) return refuse("wallet");
  if (lower(built.pool) !== lower(pins.pool)) return refuse("pool");
  if (lower(built.token) !== lower(ask.token ?? "")) return refuse("token");
  if (built.amount !== ask.amount) return refuse("amount");
  if (built.precommitment !== ctx.precommitment) return refuse("precommitment");
  if (built.feeCap > ctx.feeCap) return refuse("fee_cap_over_device_cap");
  // SellDelegate pays the fee to the Sell's fee recipient (card pool-review-3, L-1): the venue's pinned FeeCollector,
  // the one recipient the helper sends a Sell for (card evm-testnet-delegate-review3), never the withdraw relayer's
  // fee recipient a release binds (checkRelay)
  if (pins.feeCollector === undefined) return refuse("evm_not_pinned");
  if (lower(built.feeRecipient) !== lower(pins.feeCollector)) return refuse("fee_recipient");
  if (built.deadline * 1000n <= ctx.nowMs) return refuse("deadline_past");
  if (typeof floor !== "bigint" || floor <= 0n || built.minOut < floor) return refuse("min_out");
  passed("evm.sell", built, { venues: pins.venues, pool: pins.pool, chainId: pins.chainId });
  return { chain: ask.chain, op: ask.kind, token: built.token, amount: built.amount, feeCap: built.feeCap, pool: pins.pool, to: pins.pool, decimals: ask.decimals, back: built.minOut };
}

/** A sim sell (card evm-quote-exec-sim): the device's sell quote prices a route through a hook the venue does not list
 *  only where W's own sell through it executes, an eth_call of SellDelegate.sell that needs W's signature. W signs one
 *  only where it can never land, and the one guarantee is its pool: EVM_SELL_SIM has no code (no key or init code is
 *  known for it), so the deposit into it reverts when its empty answer is decoded. Its deadline is at most
 *  `blockTimestamp`, the quote's agreed block's, and that timestamp at most the device's clock, but the deadline does
 *  not stop a landing: later blocks can share that timestamp (Robinhood blocks 105948851-105948858 share one), and
 *  SellDelegate.sol:140 refuses only after it. It sells the request's own token and amount from W, on a chain that
 *  pins a sell delegate. Any route: the sim is what drops a route that is not real. */
export function checkEvmSellSim(sim: EvmSellSim, blockTimestamp: bigint, ask: PoolAsk, ctx: PoolContext, testnet = false): void {
  if (ask.kind !== "pool.sell") return refuse("kind");
  const chain = evmChainOf(ask, testnet);
  const pins = evmPins(ctx, chain);
  if (!pins.sellDelegate) return refuse("delegate_not_pinned");
  if (sim.chain !== chain) return refuse("chain");
  if (lower(sim.w) !== lower(ctx.wallet)) return refuse("wallet");
  if (lower(sim.token) !== lower(ask.token ?? "")) return refuse("token");
  if (sim.amount !== ask.amount) return refuse("amount");
  if (lower(sim.pool) !== EVM_SELL_SIM) return refuse("sim_pool");
  if (typeof blockTimestamp !== "bigint" || typeof sim.deadline !== "bigint" || sim.deadline > blockTimestamp) return refuse("sim_deadline");
  if (blockTimestamp * 1000n > ctx.nowMs) return refuse("sim_block_after_clock");
  passed("evm.sim", sim, { venues: pins.venues, pool: pins.pool, chainId: pins.chainId, sim: { blockTimestamp, nowMs: ctx.nowMs } });
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
  passed("evm.authorization", out, { venues: pins.venues, pool: pins.pool, chainId: pins.chainId });
  return out;
}

// The signers: each takes only what its check passed and signs it as the check read it (its venue list, pool, chain id
// and proof values), through the kit's pinned signer where the kit has one; `ctx` is not read again.

/** W's Buy signature (the kit's pinned signer: a buy its builder did not return is refused not_built). */
export function signEvmBuy(secretKey: Uint8Array, _ctx: PoolContext, built: EvmPoolBuy, pool: string, proof: EvmPoolProofBinding): Uint8Array {
  const b = mustHavePassed("evm.buy", built);
  const read = proofMustHavePassed("evm.buy", proof);
  // the built and the proof one check passed together: each check keeps one proof snapshot for both
  if (lower(pool) !== lower(read.pool) || b.pool !== read.pool || b.venues !== read.venues || b.proof !== read.proof) return refuse("unchecked");
  return pinnedSignBuy(read.venues, secretKey, built.chain, read.pool, built, read.proof);
}
/** W's Sell signature (the kit's pinned signer: a sell its builder did not return is refused not_built). */
export function signEvmSell(secretKey: Uint8Array, _ctx: PoolContext, built: EvmPoolSell): Uint8Array {
  const read = mustHavePassed("evm.sell", built);
  return pinnedSignSell(read.venues, secretKey, built.chain, built);
}
/** W's signature of a sim sell checkEvmSellSim passed, at the block timestamp and clock it read (the kit's pinned sim
 *  signer holds the same three rules again). */
export function signEvmSellSim(secretKey: Uint8Array, _ctx: PoolContext, sim: EvmSellSim): Uint8Array {
  const read = mustHavePassed("evm.sim", sim);
  return pinnedSignSimSell(read.venues, secretKey, sim.chain, sim, read.sim!.blockTimestamp, Number(read.sim!.nowMs));
}
/** W's EIP-7702 authorization of the chain's pinned sell delegate only, at the nonce checkEvmAuthorization passed. */
export function signEvmAuthorization(secretKey: Uint8Array, _ctx: PoolContext, checked: EvmAuthorizationChecked): EvmPoolSellAuthorization {
  const read = mustHavePassed("evm.authorization", checked);
  return pinnedSignSellAuthorization(read.venues, secretKey, checked.chain, checked.nonce);
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
export function signEvmWithdraw(secretKey: Uint8Array, _ctx: PoolContext, _ask: PoolAsk, pool: string, proof: EvmPoolProofBinding, _testnet = false): Uint8Array {
  const read = proofMustHavePassed("evm.withdraw", proof);
  if (lower(pool) !== lower(read.pool)) return refuse("pool");
  const rec = secp256k1.sign(evmWithdrawDigest(read.chainId, read.pool, read.proof), secretKey, { prehash: false, lowS: true, format: "recovered" });
  const out = new Uint8Array(65);
  out.set(rec.slice(1, 65), 0);
  out[64] = 27 + rec[0]!;
  return out;
}

// ---------- EVM: W's onward send ----------
// An EVM pool withdraw pays W (the pool requires its recipient's signature, contracts/pool-evm/src/PrivacyPool.sol), then
// W sends what it holds on to the address the user typed on SIGN_HOST: one EIP-1559 transfer, checked here field by field
// against the device's own two-RPC reads, and signed only as this check read it.

/** W's onward send: an EIP-1559 (type 2) transaction. `data` is hex ("0x" for a plain send). */
export type EvmOnwardSend = {
  readonly type: 2;
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimit: bigint;
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
  readonly accessList: readonly unknown[];
};
/** The device's reads for W's onward send, each as its two RPCs answered (they must agree): W's nonce, W's balance after
 *  the withdraw landed, whether the typed address has code and, when it has, eth_estimateGas of the send to it, the
 *  base fee, and the L1 data fee W must also hold on an OP Stack chain (Base: GasPriceOracle.getL1FeeUpperBound of the
 *  signed size; 0 on a chain without one); with the device's own cap on the priority fee. */
export type EvmOnwardReads = {
  readonly nonce: readonly [bigint, bigint];
  readonly balance: readonly [bigint, bigint];
  readonly toHasCode: readonly [boolean, boolean];
  readonly estimate: readonly [bigint, bigint] | null;
  readonly baseFee: readonly [bigint, bigint];
  readonly l1Fee: readonly [bigint, bigint];
  readonly priorityCap: bigint;
};
/** A plain transfer's gas, and the most a contract recipient (a smart wallet) may take: its estimate, never more. */
export const EVM_ONWARD_GAS = 21_000n;
export const EVM_ONWARD_GAS_MAX = 100_000n;
const ONWARD_KEYS = "accessList,chainId,data,gasLimit,maxFeePerGas,maxPriorityFeePerGas,nonce,to,type,value";
const U256 = 1n << 256n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
type OnwardRead = EvmOnwardSend & { readonly wallet: string };
// each send a check passed, with the check's own copy of it: a signer signs only that copy, and only while the send
// still reads as it
const ONWARD_CHECKED = new WeakMap<object, OnwardRead>();
/** The send's fields, each read once, into a frozen copy: refused "type" when it is not a type 2 send of exactly
 *  these fields, "tx_fields" when a field is out of its range. */
function onwardCopy(tx: EvmOnwardSend): EvmOnwardSend {
  // no EIP-7702 delegation (type 4) of W slipped in, no legacy send, no field beside the nine
  if (typeof tx !== "object" || tx === null || Object.keys(tx).sort().join() !== ONWARD_KEYS || tx.type !== 2) return refuse("type");
  const t = { type: 2 as const, chainId: tx.chainId, nonce: tx.nonce, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, maxFeePerGas: tx.maxFeePerGas, gasLimit: tx.gasLimit, to: tx.to, value: tx.value, data: tx.data, accessList: tx.accessList };
  const uint = (x: unknown): x is bigint => typeof x === "bigint" && x >= 0n && x < U256;
  // every number a uint256 (the nonce under 2^64 - 1, EIP-2681), the address and data strings, the list an array
  if (![t.chainId, t.maxPriorityFeePerGas, t.maxFeePerGas, t.gasLimit, t.value].every(uint) || !uint(t.nonce) || t.nonce >= (1n << 64n) - 1n) return refuse("tx_fields");
  if (typeof t.to !== "string" || typeof t.data !== "string" || !Array.isArray(t.accessList)) return refuse("tx_fields");
  return Object.freeze({ ...t, accessList: Object.freeze([...t.accessList]) });
}
const agreed = <T>(pair: readonly [T, T] | null | undefined, ok: (x: unknown) => boolean): T => {
  if (!Array.isArray(pair) || pair.length !== 2 || !ok(pair[0]) || pair[0] !== pair[1]) return refuse("reads");
  return pair[0];
};

/** W's onward send of its whole balance, less the send's fee bound, to `to`, the address typed on SIGN_HOST, on the
 *  pinned chain: each field held to `reads`, the device's own two-RPC reads. */
export function checkEvmOnwardSend(tx: EvmOnwardSend, ask: PoolAsk, ctx: PoolContext, to: string, reads: EvmOnwardReads, testnet = false): PoolDraw {
  // only a pool withdraw's second step, on an EVM pool chain
  if (ask.kind !== "pool.withdraw") return refuse("kind");
  const chain = evmChainOf(ask, testnet);
  const pins = evmPins(ctx, chain);
  // W, the fresh wallet the check holds the send to (its nonce, its balance, its key at the signer)
  if (typeof ctx.wallet !== "string" || !EVM_ADDRESS.test(ctx.wallet)) return refuse("wallet");
  const t = onwardCopy(tx);
  const uint = (x: unknown) => typeof x === "bigint" && x >= 0n && x < U256;
  // two providers' answers that differ are no read at all
  const nonce = agreed(reads.nonce, uint);
  const balance = agreed(reads.balance, uint);
  const hasCode = agreed(reads.toHasCode, (x) => typeof x === "boolean");
  const baseFee = agreed(reads.baseFee, uint);
  const l1Fee = agreed(reads.l1Fee, uint);
  // Robinhood (Arbitrum Nitro) charges its L1 data as gas: a plain send's gas is its own estimate there, on any To
  const nitro = ask.chain === "robinhood";
  const estimate = hasCode || nitro ? agreed(reads.estimate, uint) : null;
  // and no L1 fee beside it: Nitro has no separate one to hold
  if (nitro && l1Fee !== 0n) return refuse("l1_fee");
  if (!uint(reads.priorityCap)) return refuse("reads");
  // the pinned chain's id: no replay of W's send on another chain
  if (t.chainId !== pins.chainId) return refuse("chain_id");
  // the typed address: an address, never the zero address (a burn), the pool or W itself (the money back where it was)
  if (typeof to !== "string" || !EVM_ADDRESS.test(to) || lower(to) === ZERO_ADDRESS || lower(to) === lower(pins.pool) || lower(to) === lower(ctx.wallet)) return refuse("to");
  // the send goes to the typed address: no redirect
  if (lower(t.to) !== lower(to)) return refuse("transfer_to");
  // W's nonce on two RPCs: no replacing a send of W's, no queueing behind one
  if (t.nonce !== nonce) return refuse("nonce");
  // a plain send: no contract call dressed as one
  if (t.data !== "0x") return refuse("data");
  // no access list: nothing beside the send
  if (t.accessList.length !== 0) return refuse("access_list");
  if (estimate === null) {
    // no code at the address: a plain transfer's gas, no fee bound padded past it
    if (t.gasLimit !== EVM_ONWARD_GAS) return refuse("gas_limit");
  } else {
    // a smart-wallet recipient, or any send on Nitro: its own two-RPC estimate, no padding past it
    if (t.gasLimit !== estimate) return refuse("gas_estimate");
    // and never more than the cap, so a recipient's code cannot burn the withdrawal as gas
    if (t.gasLimit > EVM_ONWARD_GAS_MAX) return refuse("gas_over_cap");
  }
  // no tip that burns the withdrawal, nor one above the max fee (a send no node includes)
  if (t.maxPriorityFeePerGas > reads.priorityCap || t.maxPriorityFeePerGas > t.maxFeePerGas) return refuse("priority_fee");
  // no max fee past two base fees and the tip, the standard bound, nor under the base fee (a send that never lands,
  // its nonce held, the money stuck on W)
  if (t.maxFeePerGas > 2n * baseFee + reads.priorityCap || t.maxFeePerGas < baseFee) return refuse("max_fee");
  // the whole balance less the fee bound: no skim left in W, no overspend, never nothing
  const feeBound = t.gasLimit * t.maxFeePerGas + l1Fee;
  if (t.value === 0n || t.value + feeBound !== balance) return refuse("value");
  ONWARD_CHECKED.set(tx, Object.freeze({ ...t, wallet: lower(ctx.wallet) }));
  return { chain: ask.chain, op: "pool.withdraw", token: null, amount: t.value, feeCap: feeBound, pool: pins.pool, to, decimals: ask.decimals, back: null };
}

// RLP (the Ethereum yellow paper, appendix B): a byte string or a list, each with its length prefix
const beBytes = (v: bigint): Uint8Array => {
  const b: number[] = [];
  for (let x = v; x > 0n; x >>= 8n) b.unshift(Number(x & 0xffn));
  return Uint8Array.from(b);
};
const rlpHead = (n: number, short: number): Uint8Array => {
  if (n <= 55) return Uint8Array.of(short + n);
  const l = beBytes(BigInt(n));
  return Uint8Array.of(short + 55 + l.length, ...l);
};
const rlpBytes = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? b : cat(rlpHead(b.length, 0x80), b));
const rlpUint = (v: bigint): Uint8Array => rlpBytes(beBytes(v));
const rlpList = (items: Uint8Array[]): Uint8Array => {
  const body = cat(...items);
  return cat(rlpHead(body.length, 0xc0), body);
};
const hexBytes = (h: string): Uint8Array => {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(h)) return refuse("tx_fields");
  return Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));
};
/** The nine fields of a type 2 send, RLP-encoded (EIP-1559); its access list is always empty here. */
const onwardFields = (t: EvmOnwardSend): Uint8Array[] => {
  if (t.accessList.length !== 0) refuse("access_list");
  return [rlpUint(t.chainId), rlpUint(t.nonce), rlpUint(t.maxPriorityFeePerGas), rlpUint(t.maxFeePerGas), rlpUint(t.gasLimit), rlpBytes(hexBytes(t.to)), rlpUint(t.value), rlpBytes(hexBytes(t.data)), rlpList([])];
};
/** The digest W signs for a type 2 send: keccak256(0x02 ‖ rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
 *  gasLimit, to, value, data, accessList])), EIP-1559. */
export function evmOnwardSendDigest(tx: EvmOnwardSend): Uint8Array {
  return keccak_256(cat(Uint8Array.of(2), rlpList(onwardFields(tx))));
}

/** W's signed onward send, the raw transaction 0x02 ‖ rlp([...the nine fields, yParity, r, s]), s low: only the very
 *  send checkEvmOnwardSend passed, while it reads as the check read it, and only with W's own key. */
export function signEvmOnwardSend(secretKey: Uint8Array, tx: EvmOnwardSend): Uint8Array {
  const read = typeof tx === "object" && tx !== null ? ONWARD_CHECKED.get(tx) : undefined;
  if (!read) return refuse("unchecked");
  let now: EvmOnwardSend;
  try {
    now = onwardCopy(tx);
  } catch {
    return refuse("unchecked");
  }
  const fields = ["type", "chainId", "nonce", "maxPriorityFeePerGas", "maxFeePerGas", "gasLimit", "to", "value", "data"] as const;
  if (fields.some((k) => now[k] !== read[k]) || now.accessList.length !== 0) return refuse("unchecked");
  if (lower(hex(keccak_256(secp256k1.getPublicKey(secretKey, false).subarray(1)).subarray(12))) !== read.wallet) return refuse("wallet");
  const rec = secp256k1.sign(evmOnwardSendDigest(read), secretKey, { prehash: false, lowS: true, format: "recovered" });
  // noble's recovered form is the recovery bit, then r and s
  const sig = [rlpUint(BigInt(rec[0]!)), rlpUint(be32(rec.subarray(1, 33))), rlpUint(be32(rec.subarray(33, 65)))];
  return cat(Uint8Array.of(2), rlpList([...onwardFields(read), ...sig]));
}
const hex = (b: Uint8Array): string => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// ---------- EVM: U's same-chain deposit (card pool-deposits, slice 3) ----------
// The one-time wallet U (derive/keys.ts depositIdEvm) puts one rung into the pinned pool: one EIP-1559 call of
// deposit(value, precommitment) with msg.value = value, its bytes the wallet's evmSameChainDeposit encoded after its
// evmNextNote pick (this file holds no encoding of the deposit: the signer guard, test/signer-guard.ts, holds every one
// to a pick). Each field is held here to that call, to the device's pin and to the device's own two-RPC reads, and the
// signer signs only the send this check passed, as it read it, with U's key alone.

/** The device's reads for U's deposit, each as its two RPCs answered: U's nonce, base fee, eth_estimateGas of the call
 *  from U, the L1 fee bound (Base: the kit's evmPoolChainFeeReads; 0 on Robinhood, Nitro's L1 cost is in its gas) and
 *  the pool's two tree depths (State.sol currentTreeDepth, currentLabelTreeDepth) must agree; U's balance is each RPC's
 *  own reading, and the deposit must go on both; the device's priority-fee cap. */
export type EvmDepositReads = {
  readonly nonce: readonly [bigint, bigint];
  readonly balance: readonly [bigint, bigint];
  readonly estimate: readonly [bigint, bigint];
  readonly baseFee: readonly [bigint, bigint];
  readonly l1Fee: readonly [bigint, bigint];
  readonly stateDepth: readonly [bigint, bigint];
  readonly labelDepth: readonly [bigint, bigint];
  readonly priorityCap: bigint;
};
/** The device's side of U's deposit: U's address, the note's precommitment, the call the wallet's evmSameChainDeposit
 *  returned for it (frozen), and the device's pin of the pool (the wallet's EVM_POOLS entry of the page's network). */
export type EvmDepositContext = { readonly wallet: string; readonly precommitment: bigint; readonly call: { readonly to: string; readonly value: bigint; readonly data: string }; readonly pin: EvmPoolPin };
/** The most gas the two RPCs' estimate of U's deposit may name: the cap keeps their word from spending U's money as gas
 *  (Nitro adds its L1 cost as gas). */
export const EVM_DEPOSIT_GAS_MAX = 1_000_000n;
/** Gas one tree level may add to an insert: the kit's EVM_POOL_GAS_PER_LEVEL (G(depth)'s slope, 21,518, measured per
 *  level of a release's insert; held equal by test/rules-pool-deposit-evm.test.ts). A level whose index bit is set
 *  hashes (one PoseidonT3) where a clear bit only stores: on the Base Sepolia pool one such level measured 15,868 more
 *  (eth_simulateV1, 2026-11-07, our deposit after 0 to 36 others in its block). */
export const EVM_DEPOSIT_GAS_PER_LEVEL = 21_518n;
/** The deepest tree the pool takes (State.sol MAX_TREE_DEPTH). */
const EVM_DEPOSIT_MAX_DEPTH = 32n;
/**
 * The headroom over the estimate U's deposit is signed with: G(depth) in the deposit's terms. A deposit inserts one leaf
 * in each of the pool's two trees (InternalLeanIMT._insert: one Poseidon per set bit of the next index, below the tree's
 * depth), and the estimate is of the index at the block it was read; the deposit lands behind any others in its block,
 * at any later index. The worst insert at a tree's depth d hashes at every level, and one deposit ahead can raise the
 * depth by one, so each tree may take d + 1 levels more than the estimate's: (stateDepth + 1 + labelDepth + 1) x the
 * per-level gas. Gas U does not use is never charged (EIP-1559 charges gasUsed), so only U's balance must cover it.
 */
export function evmDepositHeadroom(stateDepth: bigint, labelDepth: bigint): bigint {
  for (const d of [stateDepth, labelDepth]) if (typeof d !== "bigint" || d < 0n || d > EVM_DEPOSIT_MAX_DEPTH) throw new PoolRuleRefused("depth");
  return (stateDepth + 1n + labelDepth + 1n) * EVM_DEPOSIT_GAS_PER_LEVEL;
}
/** The pool's deposit(uint256,uint256) selector (PrivacyPool.sol:82). */
export const EVM_DEPOSIT_SELECTOR = "0xe2bbb158";
const DEPOSIT_CHECKED = new WeakMap<object, OnwardRead>();
/** The pool's least deposit: its ladder's one, PrivacyPool.sol:53 MIN_DEPOSIT (the kit's EVM_POOL_MIN_DEPOSIT, held equal
 *  by test/rules-pool-deposit-evm.test.ts; this file imports no kit module beside its checks and builders). */
const EVM_DEPOSIT_MIN = EVM_LADDER.one;
/** The BN254 scalar field's order, below which a precommitment is (the kit's VAULT_FIELD_P, held equal by the test). */
export const EVM_DEPOSIT_FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const evmWord = (v: bigint): string => v.toString(16).padStart(64, "0");
const EVM_NETWORK_OF: Readonly<Record<"base" | "robinhood", readonly [string, string]>> = Object.freeze({ base: ["base", "base-sepolia"], robinhood: ["robinhood", "robinhood-testnet"] });

/** U's deposit of one rung into the pinned pool on the ask's chain: each field held to the call, the pin and `reads`. */
export function checkEvmDeposit(tx: EvmOnwardSend, ask: PoolAsk, ctx: EvmDepositContext, reads: EvmDepositReads, testnet = false): PoolDraw {
  if (ask.kind !== "pool.deposit") return refuse("kind");
  if (ask.chain === "solana") return refuse("chain");
  const pin = ctx?.pin;
  // the pin of the ask's chain on the page's network: no deposit into a pool of another chain or network
  if (!pin || typeof pin.pool !== "string" || !EVM_ADDRESS.test(pin.pool) || pin.network !== EVM_NETWORK_OF[ask.chain][testnet ? 1 : 0]) return refuse("evm_not_pinned");
  const chainId = EVM_CHAIN_IDS[pin.network];
  const u = ctx.wallet;
  if (typeof u !== "string" || !EVM_ADDRESS.test(u)) return refuse("wallet");
  const d = onwardCopy(tx);
  const isUint = (x: unknown) => typeof x === "bigint" && x >= 0n && x < U256;
  // two providers' answers that differ are no read at all; U's balance is each one's own reading
  const uNonce = agreed(reads.nonce, isUint);
  const base = agreed(reads.baseFee, isUint);
  const estimate = agreed(reads.estimate, isUint);
  const l1 = agreed(reads.l1Fee, isUint);
  const stateDepth = agreed(reads.stateDepth, isUint);
  const labelDepth = agreed(reads.labelDepth, isUint);
  const tipCap = reads.priorityCap;
  if (!Array.isArray(reads.balance) || reads.balance.length !== 2 || !reads.balance.every(isUint) || !isUint(tipCap)) return refuse("reads");
  // Nitro charges its L1 data as gas, inside the estimate: no L1 fee beside it
  if (ask.chain === "robinhood" && l1 !== 0n) return refuse("l1_fee");
  // the pinned chain's id: no replay of U's deposit on another chain
  if (d.chainId !== chainId) return refuse("chain_id");
  // the pinned pool, and the call the wallet built for it
  const call = ctx.call;
  if (call === null || typeof call !== "object" || !Object.isFrozen(call) || typeof call.to !== "string" || typeof call.data !== "string" || typeof call.value !== "bigint") return refuse("call");
  if (lower(call.to) !== lower(pin.pool) || lower(d.to) !== lower(pin.pool)) return refuse("to");
  // the rung: the pool's own bounds (PrivacyPool.sol:86-90), never more than asked, msg.value the call's value
  const rung = call.value;
  if (rung < EVM_DEPOSIT_MIN || rung >= (1n << 128n) - 1n || rung > ask.amount) return refuse("amount");
  if (d.value !== rung) return refuse("value");
  // the note's own precommitment, below p, and the call's bytes exactly: selector, value, precommitment, nothing else
  const pre = ctx.precommitment;
  if (typeof pre !== "bigint" || pre <= 0n || pre >= EVM_DEPOSIT_FIELD_P) return refuse("precommitment");
  const data = lower(call.data);
  if (!/^0x[0-9a-f]{136}$/.test(data) || data.slice(0, 10) !== EVM_DEPOSIT_SELECTOR || data.slice(10) !== evmWord(rung) + evmWord(pre)) return refuse("data");
  if (lower(d.data) !== data) return refuse("data");
  // U's nonce on two RPCs: no replacing a send of U's, no queueing behind one
  if (d.nonce !== uNonce) return refuse("nonce");
  // no access list: nothing beside the call
  if (d.accessList.length > 0) return refuse("access_list");
  // the two-RPC estimate, never past the cap, and exactly the tree's headroom over it: no padding past that bound
  if (estimate === 0n || estimate > EVM_DEPOSIT_GAS_MAX) return refuse("gas_over_cap");
  if (d.gasLimit !== estimate + evmDepositHeadroom(stateDepth, labelDepth)) return refuse("gas_estimate");
  // no tip past the device's cap nor above the max fee; no max fee past two base fees and the tip, nor under the base fee
  if (d.maxPriorityFeePerGas > tipCap || d.maxPriorityFeePerGas > d.maxFeePerGas) return refuse("priority_fee");
  if (d.maxFeePerGas > 2n * base + tipCap || d.maxFeePerGas < base) return refuse("max_fee");
  // the rung and its fee bound within U's balance on each RPC's reading: neither RPC's word prices it
  const bound = d.gasLimit * d.maxFeePerGas + l1;
  if (reads.balance.some((b) => rung + bound > b)) return refuse("balance");
  DEPOSIT_CHECKED.set(tx, Object.freeze({ ...d, wallet: lower(u) }));
  return { chain: ask.chain, op: "pool.deposit", token: null, amount: rung, feeCap: bound, pool: pin.pool, to: pin.pool, decimals: ask.decimals, back: null };
}

/** U's signed deposit, the raw transaction 0x02 ‖ rlp([...the nine fields, yParity, r, s]), s low: only the very send
 *  checkEvmDeposit passed, while it reads as the check read it, and only with U's own key. */
export function signEvmDeposit(secretKey: Uint8Array, tx: EvmOnwardSend): Uint8Array {
  const passed = typeof tx === "object" && tx !== null ? DEPOSIT_CHECKED.get(tx) : undefined;
  if (passed === undefined) return refuse("unchecked");
  let again: EvmOnwardSend;
  try {
    again = onwardCopy(tx);
  } catch {
    return refuse("unchecked");
  }
  // the send as the check read it, field for field
  const keys = ["type", "chainId", "nonce", "maxPriorityFeePerGas", "maxFeePerGas", "gasLimit", "to", "value", "data"] as const;
  if (keys.some((k) => again[k] !== passed[k]) || again.accessList.length > 0) return refuse("unchecked");
  // U's own key: its address is the one the check held the send to
  const signer = lower(hex(keccak_256(secp256k1.getPublicKey(secretKey, false).subarray(1)).subarray(12)));
  if (signer !== passed.wallet) return refuse("wallet");
  const rec = secp256k1.sign(evmOnwardSendDigest(passed), secretKey, { prehash: false, lowS: true, format: "recovered" });
  const vrs = [rlpUint(BigInt(rec[0]!)), rlpUint(be32(rec.subarray(1, 33))), rlpUint(be32(rec.subarray(33, 65)))];
  return cat(Uint8Array.of(2), rlpList([...onwardFields(passed), ...vrs]));
}
// ---------- the draw ----------

/** An amount in base units as a decimal at `decimals`, trailing zeros dropped (12.5, not 12.500000000). */
export function poolUnits(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${amount / base}.${frac}` : `${amount / base}`;
}

/** The page's lines for a checked payload, label then value, each amount in the decimals the check bound. A withdraw and
 *  a sell show where the money lands ("To", the withdraw form's label). Picked by the owner (3 Nov 20:26Z): a sell's
 *  second amount "To private balance" and "Max fee"; the other words are drafts until the owner picks them. */
export function drawPool(d: PoolDraw): [string, string][] {
  const asset = POOL_ASSET_DECIMALS_OF[d.chain];
  const lines: [string, string][] = [["Chain", d.chain === "solana" ? "Solana" : d.chain === "base" ? "Base" : "Robinhood"]];
  if (d.token !== null) lines.push(["Token", d.token]);
  lines.push(["Amount", poolUnits(d.amount, d.decimals)]);
  if (d.op === "pool.withdraw" || d.op === "pool.sell") lines.push(["To", d.to]);
  if (d.back !== null) lines.push(["To private balance", poolUnits(d.back, asset)]); // owner 3 Nov 20:26Z
  lines.push(["Max fee", poolUnits(d.feeCap, asset)], ["Pool", d.pool]); // "Max fee": owner 3 Nov 20:26Z; "Pool": draft
  return lines;
}
