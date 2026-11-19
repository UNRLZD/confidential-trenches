// SIGN_HOST's export of one key (card signpage-backup-export; docs/plan1/wallet.md §2.8 row export.open, W:938, §2.9
// rows 12 and "One exported private key", W:957 and W:975, and the W row of §2.2, W:63, at research ffcba5e): the key of
// one wallet of this seed, named by the app by chain and address, in the chain's standard import form, derived on the
// device from the stored seed.
//
// Which wallets are this seed's: a wallet is one only when the seed itself derives the named address, never on a record's
// or the app's word. The candidates are read from the page's own store, and each is derived and its address compared:
// - every W_{c,l,j} a note paid (W:63): l the note's leaf label, j its change index (pool/queue.ts jOf), on the chain's
//   two tags (sol and hop-sol on Solana; evm and hop-evm on Base and Robinhood; near and hop-near on NEAR);
// - every U_{s,i} the page's pool deposit ops and refund records name on a pool chain: U_{s,i}'s ed25519 key on Solana
//   (base58), U^evm_{s,i} on Base and Robinhood.
// A record a broken page wrote cannot make a foreign address match: the address is the seed's derivation or nothing.
//
// The key's forms: Solana, the base58 of the 64-byte secret key (the 32-byte seed, then the public key), as Phantom and
// solana-keygen import it; Base and Robinhood, the 32-byte private key as 0x hex, as MetaMask imports it; NEAR,
// "ed25519:" and the base58 of the same 64 bytes, as NEAR wallets and near-cli import it. Every byte array is zeroed
// here once used; the seed is the caller's to zero. Nothing here logs.
import { base58 } from "@scure/base";
import { depositId, depositIdEvm, freshWallet, type Chain as Tag } from "@blindfill/wallet/derive";
import { jOf } from "../../../wallet/src/pool/queue.ts";
import type { NoteRef } from "../../../wallet/src/notes/secrets.ts";
import { refundRecordOf } from "../leftover-carry.ts";

/** The chains a key is exported on: the kit's Chain. */
export type ExportChain = "solana" | "base" | "robinhood" | "near";
const POOL_CHAINS: readonly string[] = ["solana", "base", "robinhood"];

/** A wallet of this seed the page's records name: a W by its note's label and change index, or a U on a pool chain. */
export type ExportRef = { kind: "w"; l: bigint; j: number } | { kind: "u"; chain: "solana" | "base" | "robinhood"; s: bigint; i: number };

/** The W tags of each chain (wallet.md:91-100). */
const TAGS: Record<ExportChain, readonly Tag[]> = { solana: ["sol", "hop-sol"], base: ["evm", "hop-evm"], robinhood: ["evm", "hop-evm"], near: ["near", "hop-near"] };

/** Whether `chain` is one this page exports on. */
export const exportChain = (chain: unknown): chain is ExportChain => typeof chain === "string" && Object.hasOwn(TAGS, chain);

const DIGITS = /^[0-9]{1,78}$/;
const index = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff;

/**
 * The candidates of the page's own records, each once: `notes` the note store's records (each with a leaf names its W),
 * `ops` the ops store's records (each pool deposit op names its U_X), `refunds` the refund records (each names its U).
 * A record of any other shape names nothing.
 */
export function exportRefs(notes: readonly { ref: NoteRef; leaf?: { label: bigint } }[], ops: readonly unknown[], refunds: readonly unknown[] = []): ExportRef[] {
  const out: ExportRef[] = [];
  const seen = new Set<string>();
  const add = (k: string, r: ExportRef) => void (seen.has(k) || (seen.add(k), out.push(r)));
  for (const n of notes) {
    if (typeof n?.leaf?.label !== "bigint") continue;
    let j: number;
    try {
      j = jOf(n.ref);
    } catch {
      continue;
    }
    add(`w ${n.leaf.label} ${j}`, { kind: "w", l: n.leaf.label, j });
  }
  const u = (chain: unknown, s: unknown, i: unknown) => {
    if (typeof chain !== "string" || !POOL_CHAINS.includes(chain) || typeof s !== "string" || !DIGITS.test(s) || !index(i)) return;
    add(`u ${chain} ${s} ${i}`, { kind: "u", chain: chain as "solana", s: BigInt(s), i });
  };
  for (const v of ops) {
    if (typeof v !== "object" || v === null || (v as { kind?: unknown }).kind !== "pool_deposit") continue;
    const f = (v as { follow?: unknown }).follow;
    if (typeof f === "object" && f !== null) u((f as { chain?: unknown }).chain, (f as { s?: unknown }).s, (f as { i?: unknown }).i);
  }
  for (const v of refunds) {
    const r = refundRecordOf(v);
    if (r !== null) u(r.chain, r.s, r.i);
  }
  return out;
}

const isEvm = (chain: ExportChain): boolean => chain === "base" || chain === "robinhood";
/** The named address in the form the derivation gives: EVM's 0x and 40 hex in any case, read lowercase. */
const sameAddress = (chain: ExportChain, derived: string, named: string): boolean =>
  isEvm(chain) ? /^0x[0-9a-fA-F]{40}$/.test(named) && derived.toLowerCase() === named.toLowerCase() : derived === named;

/** The key of the one ref whose address on `chain` is `address`, its two parts copied out; null when none is. */
function match(seed64: Uint8Array, chain: ExportChain, address: string, refs: readonly ExportRef[]): { secretKey: Uint8Array; publicKey: Uint8Array } | null {
  if (!exportChain(chain) || typeof address !== "string" || address === "") return null;
  for (const r of refs) {
    if (r.kind === "w") {
      for (const tag of TAGS[chain]) {
        const w = freshWallet(seed64, tag, r.l, r.j);
        if (sameAddress(chain, w.address, address)) return { secretKey: w.secretKey, publicKey: w.publicKey };
        w.secretKey.fill(0);
      }
    } else if (r.chain === chain) {
      if (chain === "solana") {
        const k = depositId(seed64, r.s, r.i);
        if (base58.encode(k.publicKey) === address) return { secretKey: k.secretKey, publicKey: k.publicKey };
        k.secretKey.fill(0);
      } else {
        const k = depositIdEvm(seed64, r.s, r.i);
        if (sameAddress(chain, k.address, address)) return { secretKey: k.secretKey, publicKey: k.publicKey };
        k.secretKey.fill(0);
      }
    }
  }
  return null;
}

/** Whether `address` is a wallet of this seed on `chain` among `refs`; no key is kept. */
export function ownsWallet(seed64: Uint8Array, chain: ExportChain, address: string, refs: readonly ExportRef[]): boolean {
  const m = match(seed64, chain, address, refs);
  m?.secretKey.fill(0);
  return m !== null;
}

/** The private key of `address` on `chain` in its standard import form, or null when it is no wallet of this seed. */
export function exportKey(seed64: Uint8Array, chain: ExportChain, address: string, refs: readonly ExportRef[]): string | null {
  const m = match(seed64, chain, address, refs);
  if (m === null) return null;
  const { secretKey, publicKey } = m;
  try {
    if (isEvm(chain)) return `0x${Array.from(secretKey, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    const full = new Uint8Array(64);
    try {
      full.set(secretKey, 0);
      full.set(publicKey, 32);
      return chain === "near" ? `ed25519:${base58.encode(full)}` : base58.encode(full);
    } finally {
      full.fill(0);
    }
  } finally {
    secretKey.fill(0);
  }
}

/** The labels the screen draws: the chain's name, and the address shortened (its first and last 4). */
export const CHAIN_NAME: Record<ExportChain, string> = { solana: "Solana", base: "Base", robinhood: "Robinhood", near: "NEAR" };
export const shortAddress = (a: string): string => (a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);
