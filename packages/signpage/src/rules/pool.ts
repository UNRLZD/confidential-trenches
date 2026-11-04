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
//   teardown frames (card solana-sell-teardown) go through the kit's checkSolanaTeardown for W.
// - EVM buy and withdraw: the proof binds a context; the device recomputes it from the relay data and the pinned pool
//   and holds W the recipient, the pinned fee recipient, the fee cap and the deadline. The buy's adapter is a pin, its
//   token the request's; the kit's pinned signer refuses any buy its builder did not return.
// - EVM sell: W's own sell into the pinned pool, the request's token and amount, the device's precommitment (else the
//   proceeds are another's note), the fee cap and deadline held here;
//   the kit's pinned signer refuses any sell its builder did not return.
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
type Checked = "evm.buy" | "evm.withdraw" | "evm.sell" | "evm.authorization";
/** What a check read for its signer: the venue list it checked against, the pool and chain id, a proof's values. */
type Read = { readonly venues: EvmPoolVenueList; readonly pool: string; readonly chainId: bigint; readonly proof?: Readonly<EvmPoolProofBinding> };
const CHECKED: Readonly<Record<Checked, WeakMap<object, Read>>> = Object.freeze({
  "evm.buy": new WeakMap<object, Read>(),
  "evm.withdraw": new WeakMap<object, Read>(),
  "evm.sell": new WeakMap<object, Read>(),
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
  if (rest.length !== 1) return refuse("instructions");
  {
    const t = rest[0]!;
    if (t.program !== SOLANA_SYSTEM_PROGRAM || t.data.length !== 12 || u64le(Uint8Array.of(...t.data.subarray(0, 4), 0, 0, 0, 0), 0) !== 2n) return refuse("transfer");
    if (t.accounts.length !== 2 || !same(t.accounts[0], ctx.wallet, true, true) || !same(t.accounts[1], to, false, true)) return refuse("transfer_to");
    if (u64le(t.data, 4) !== got.withdrawnValue - got.relayFee) return refuse("transfer_amount");
  }
  passedWire(wire);
  return { chain: "solana", op: ask.kind, token: null, amount: got.withdrawnValue - got.relayFee, feeCap: got.relayFeeCap, pool: pin.pool, to, decimals: ask.decimals, back: null };
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
 *  device's own, from its two-RPC pool reads), within the fee cap, unexpired. */
export function checkEvmSell(built: EvmPoolSell, ask: PoolAsk, ctx: PoolContext & { precommitment: bigint }, floor: bigint, testnet = false): PoolDraw {
  if (ask.kind !== "pool.sell") return refuse("kind");
  const chain = evmChainOf(ask, testnet);
  const pins = evmPins(ctx, chain);
  if (built.chain !== chain) return refuse("chain");
  if (lower(built.w) !== lower(ctx.wallet)) return refuse("wallet");
  if (lower(built.pool) !== lower(pins.pool)) return refuse("pool");
  if (lower(built.token) !== lower(ask.token ?? "")) return refuse("token");
  if (built.amount !== ask.amount) return refuse("amount");
  if (built.precommitment !== ctx.precommitment) return refuse("precommitment");
  if (built.feeCap > ctx.feeCap) return refuse("fee_cap_over_device_cap");
  if (built.deadline * 1000n <= ctx.nowMs) return refuse("deadline_past");
  if (typeof floor !== "bigint" || floor <= 0n || built.minOut < floor) return refuse("min_out");
  passed("evm.sell", built, { venues: pins.venues, pool: pins.pool, chainId: pins.chainId });
  return { chain: ask.chain, op: ask.kind, token: built.token, amount: built.amount, feeCap: built.feeCap, pool: pins.pool, to: pins.pool, decimals: ask.decimals, back: built.minOut };
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
  const estimate = hasCode ? agreed(reads.estimate, uint) : null;
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
    // a smart-wallet recipient: its own two-RPC estimate, no padding past it
    if (t.gasLimit !== estimate) return refuse("gas_estimate");
    // and never more than the cap, so a recipient's code cannot burn the withdrawal as gas
    if (t.gasLimit > EVM_ONWARD_GAS_MAX) return refuse("gas_over_cap");
  }
  // no tip that burns the withdrawal
  if (t.maxPriorityFeePerGas > reads.priorityCap) return refuse("priority_fee");
  // no max fee past two base fees and the tip, the standard bound
  if (t.maxFeePerGas > 2n * baseFee + reads.priorityCap) return refuse("max_fee");
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
