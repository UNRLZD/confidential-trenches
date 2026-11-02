// The arm records and the Solana signer that trusts nothing else (card signpage-solana-trade; docs/plan1/wallet.md §2.3
// the `wallets` row of the note store table, §2.5 "Arming one wallet" steps 1, 6 and 8, §2.8 the "Buy from fresh
// wallets" row: "only from a W whose arm (l, j) is the device's own withdrawal").
//
// - An arm record is the `wallets` store's record of one fresh wallet W_{c,l,j}, under the key `${c}:${l}:${j}` (l in
//   decimal, j a u32). Only the arming writes one, once the device's own withdrawal to A_{l,j} has succeeded: the
//   vault's `spends` record for its nullifier hash carries a context this device recorded, read on two RPCs (§2.5
//   step 6). That context is the record's `own.context`. The store seals every record under K_wrap with its store and
//   key as aad (store/index.ts), so no page, frame or server can write one; and no code in this package or the signing
//   page writes a record with `own` in it (the arming card does, test/arm-records.test.ts checks the sources).
// - solanaArmedSigner signs for a wallet only when the store holds a record for it that passes armRecordOf with state
//   READY or IN_POSITION, and W_{sol,l,j} derived from this device's own seed is that wallet. Every other wallet is
//   refused with ArmRefused before the seed is opened, so a request, a bug or the kit's own `arm.own` flag cannot sign
//   from a wallet funded by someone else (solana-buy-flow's review finding 4: arm.own was only the caller's word).
// - moveArmRecord changes a record's state (and the token of a position) only on a record that already passes
//   armRecordOf; it never makes a record and never touches `own`.
// Nothing here logs; a key is zeroed once its signature is made, the seed when the signer closes.
import { ed25519 } from "@noble/curves/ed25519.js";
import { CHAINS, type Chain, P, freshWallet } from "../derive/index.ts";
import type { WalletStore } from "../store/index.ts";

export const ARM_STATES = ["PLANNED", "ARMING", "READY", "IN_POSITION", "RETURNING", "EMPTY"] as const;
export type ArmState = (typeof ARM_STATES)[number];
/** The states a wallet may sign a trade in. */
export const ARM_SIGNING_STATES: readonly ArmState[] = ["READY", "IN_POSITION"];

export interface ArmRecord {
  v: 1;
  chain: Chain;
  l: bigint;
  j: number;
  /** W_{c,l,j}'s address (Solana: base58 of its public key). */
  address: string;
  role: "fresh" | "hop";
  /** The ladder size it was armed at, in USD cents. */
  size_cents: bigint;
  state: ArmState;
  /** The context of the device's own withdrawal to A_{l,j}, as recorded before the proof and read back in `spends`. */
  own: { context: string };
  /** a_k: what a buy from this wallet spends, in the chain's base units (lamports on Solana), set by the arming at READY. */
  spend: bigint;
  /** The token held, once IN_POSITION. */
  token?: string;
}

/** The store key of W_{c,l,j}'s record. */
export function armKey(chain: Chain, l: bigint, j: number): string {
  return `${chain}:${l}:${j}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const KEY = /^([a-z-]+):(0|[1-9][0-9]{0,77}):(0|[1-9][0-9]{0,9})$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** The record under `key` when it is a well-formed arm record for that key; null otherwise. */
export function armRecordOf(key: string, rec: unknown): ArmRecord | null {
  const m = typeof key === "string" ? KEY.exec(key) : null;
  if (!m || !Object.hasOwn(CHAINS, m[1]!) || !isObj(rec)) return null;
  const l = BigInt(m[2]!);
  const j = Number(m[3]!);
  if (l >= P || j > 0xffffffff) return null;
  const own = rec.own;
  if (rec.v !== 1 || rec.chain !== m[1] || rec.l !== l || rec.j !== j) return null;
  if (typeof rec.address !== "string" || (rec.role !== "fresh" && rec.role !== "hop")) return null;
  if (typeof rec.size_cents !== "bigint" || rec.size_cents <= 0n || typeof rec.spend !== "bigint" || rec.spend <= 0n) return null;
  if (!(ARM_STATES as readonly unknown[]).includes(rec.state)) return null;
  if (!isObj(own) || typeof own.context !== "string" || !HEX64.test(own.context)) return null;
  if (rec.token !== undefined && typeof rec.token !== "string") return null;
  return rec as unknown as ArmRecord;
}

/** Every arm record of `chain` in the store, with its key; a record that is not one is left out. */
export async function armRecords(store: Pick<WalletStore, "keys" | "get">, chain: Chain): Promise<{ key: string; rec: ArmRecord }[]> {
  const keys = (await store.keys("wallets")).filter((k) => k.startsWith(`${chain}:`));
  const out: { key: string; rec: ArmRecord }[] = [];
  for (const key of keys) {
    const rec = armRecordOf(key, await store.get("wallets", key).catch(() => undefined));
    if (rec) out.push({ key, rec });
  }
  return out;
}

export type ArmRefusalCode = "not_armed" | "state" | "not_this_seed";
export class ArmRefused extends Error {
  readonly code: ArmRefusalCode;
  constructor(code: ArmRefusalCode, detail: string) {
    super(`not signed (${code}): ${detail}`);
    this.name = "ArmRefused";
    this.code = code;
  }
}

/** The fresh Solana wallet the device armed by its own withdrawal, ready to sign; ArmRefused otherwise. */
export async function ownSolanaArm(store: Pick<WalletStore, "keys" | "get">, wallet: string): Promise<{ key: string; rec: ArmRecord }> {
  const found = (await armRecords(store, "sol")).filter((r) => r.rec.address === wallet && r.rec.role === "fresh");
  if (found.length !== 1) throw new ArmRefused("not_armed", `${wallet} has ${found.length === 0 ? "no" : "more than one"} arm record of this device's own withdrawal`);
  const one = found[0]!;
  if (!ARM_SIGNING_STATES.includes(one.rec.state)) throw new ArmRefused("state", `${wallet} is ${one.rec.state}`);
  return one;
}

export interface SolanaArmedSigner {
  /** The 64-byte ed25519 signature of `message` by `wallet`'s key; ArmRefused, before the seed is opened, for any wallet this device did not arm. */
  sign(wallet: string, message: Uint8Array): Promise<Uint8Array>;
  /** Zeroes the seed, if it was opened. */
  close(): void;
}

/**
 * A signer for one trade. `seed64` opens the seed (BIP-39 seed of the 12 words) and is called at most once, only after
 * a wallet passes its arm check; the signer keeps it until close().
 */
export function solanaArmedSigner(store: Pick<WalletStore, "keys" | "get">, seed64: () => Promise<Uint8Array>): SolanaArmedSigner {
  let seed: Promise<Uint8Array> | null = null;
  let closed = false;
  return {
    async sign(wallet, message) {
      if (closed) throw new Error("the signer is closed");
      if (!(message instanceof Uint8Array) || message.length === 0) throw new Error("no message to sign");
      const { rec } = await ownSolanaArm(store, wallet);
      const s = await (seed ??= seed64());
      if (closed) throw new Error("the signer is closed");
      const w = freshWallet(s, "sol", rec.l, rec.j);
      try {
        if (w.address !== wallet) throw new ArmRefused("not_this_seed", `${wallet} is not W_{sol,${rec.l},${rec.j}} of this seed`);
        return ed25519.sign(message, w.secretKey);
      } finally {
        w.secretKey.fill(0);
      }
    },
    close() {
      closed = true;
      void seed?.then((s) => s.fill(0), () => {});
    },
  };
}

/**
 * Moves an existing arm record from one state to another, with the token it holds when it goes IN_POSITION. It makes
 * no record and leaves `own` as it is: a record that does not pass armRecordOf, or is not in `from`, is left alone.
 */
export async function moveArmRecord(
  store: Pick<WalletStore, "get" | "put">,
  key: string,
  from: ArmState,
  to: ArmState,
  token?: string,
): Promise<boolean> {
  const rec = armRecordOf(key, await store.get("wallets", key));
  if (!rec || rec.state !== from) return false;
  const next: ArmRecord = { ...rec, state: to };
  if (token !== undefined) next.token = token;
  await store.put("wallets", key, next);
  return true;
}
