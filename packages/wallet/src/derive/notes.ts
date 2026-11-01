// Note masters and note secrets (docs/plan1/wallet.md §2.2 note master rows and §2.3 Secrets at research ffcba5e).
// A master is Poseidon(x), x = HKDF-SHA512(seed64, salt "blindfill/v1", info, 64 B) read big-endian, mod p (wallet.md:89).
// The rest is Privacy Pools v1's (D37): a note's nullifier and secret are Poseidon(master*, a, b[, ...]); its
// precommitment is Poseidon(nullifier, secret), its nullifier hash Poseidon(nullifier), and its commitment
// Poseidon(value, label, precommitment). Poseidon inputs are field elements, counters and tags as the integers they hold.
// Nothing here logs; a nullifier, a secret and a master never leave the device (wallet.md:162-164).
import { poseidon1, poseidon2, poseidon3, poseidon4, poseidon5 } from "poseidon-lite";
import { CHAINS, type Chain, P } from "./constants.ts";
import { chainTag, counter, field, hkdfSeed } from "./keys.ts";

export type MasterKind = "deposit" | "return" | "move" | "refund" | "second";
const LABEL: Record<MasterKind, string> = {
  deposit: "notes",
  return: "notes/return",
  move: "notes/move",
  refund: "notes/refund",
  second: "notes/second",
};
// The HKDF info of a master: "notes/nullifier", "notes/secret", "notes/return/nullifier", ... (12-22 B, wallet.md:83).
export const masterInfo = (kind: MasterKind, part: "nullifier" | "secret"): string => `${LABEL[kind]}/${part}`;

export interface Masters {
  nullifier: bigint;
  secret: bigint;
}
const toBig = (b: Uint8Array): bigint => b.reduce((v, x) => (v << 8n) | BigInt(x), 0n);
export function masters(seed64: Uint8Array, kind: MasterKind): Masters {
  if (!Object.hasOwn(LABEL, kind)) throw new Error(`unknown master kind ${String(kind)}`);
  const one = (part: "nullifier" | "secret") =>
    poseidon1([toBig(hkdfSeed(seed64, new TextEncoder().encode(masterInfo(kind, part)), 64)) % P]);
  return { nullifier: one("nullifier"), secret: one("secret") };
}

export interface NoteSecrets {
  nullifier: bigint;
  secret: bigint;
  precommitment: bigint;
  nullifierHash: bigint;
}
function secrets(m: Masters, inputs: bigint[]): NoteSecrets {
  const h = inputs.length === 2 ? poseidon3 : inputs.length === 3 ? poseidon4 : poseidon5;
  const nullifier = h([m.nullifier, ...inputs]);
  const secret = h([m.secret, ...inputs]);
  return { nullifier, secret, precommitment: poseidon2([nullifier, secret]), nullifierHash: poseidon1([nullifier]) };
}
const fe = (name: string, x: bigint): bigint => (field(name, x), x);
const ctr = (name: string, x: number): bigint => (counter(name, x), BigInt(x));

// Deposit number i into the pool of scope s.
export const depositNote = (seed64: Uint8Array, s: bigint, i: number) =>
  secrets(masters(seed64, "deposit"), [fe("s", s), ctr("i", i)]);
// Change note j of label l (j by changeIndex, keys.ts).
export const changeNote = (seed64: Uint8Array, l: bigint, j: number) =>
  secrets(masters(seed64, "deposit"), [fe("l", l), ctr("j", j)]);
// The note the return of W_{c,l,j} makes.
export const returnNote = (seed64: Uint8Array, c: Chain, l: bigint, j: number) =>
  secrets(masters(seed64, "return"), [BigInt(chainTag(c)), fe("l", l), ctr("j", j)]);
// The note made when a 1Click refund under V_{l,j} goes back into the vault.
export const moveNote = (seed64: Uint8Array, l: bigint, j: number) =>
  secrets(masters(seed64, "move"), [fe("l", l), ctr("j", j)]);
// The refund note the vault writes when the token refuses the payout of the withdrawal that makes change note (l, j).
export const refundNote = (seed64: Uint8Array, l: bigint, j: number) =>
  secrets(masters(seed64, "refund"), [fe("l", l), ctr("j", j)]);

// Arrival n (from 0) after the first under one id: (kind, a, b) names U_{s,i}, V_{l,j}, A_{l,j} or R_{c,l,j}.
export type SecondId =
  | { id: "U"; s: bigint; i: number }
  | { id: "V"; l: bigint; j: number }
  | { id: "A"; l: bigint; j: number }
  | { id: "R"; c: Chain; l: bigint; j: number };
export function secondNote(seed64: Uint8Array, who: SecondId, n: number): NoteSecrets {
  const m = masters(seed64, "second");
  const nn = ctr("n", n);
  switch (who.id) {
    case "U":
      return secrets(m, [0x01n, fe("s", who.s), ctr("i", who.i), nn]);
    case "V":
      return secrets(m, [0x02n, fe("l", who.l), ctr("j", who.j), nn]);
    case "A":
      return secrets(m, [0x03n, fe("l", who.l), ctr("j", who.j), nn]);
    case "R":
      if (!Object.hasOwn(CHAINS, who.c)) throw new Error(`unknown chain tag ${String(who.c)}`);
      return secrets(m, [BigInt(0x10 + CHAINS[who.c].tag), fe("l", who.l), ctr("j", who.j), nn]);
    default:
      throw new Error("unknown second-arrival id");
  }
}

// The vault computes this from what it received (D29); the device checks it against the deposits pages.
export function commitment(value: bigint, label: bigint, precommitment: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 128n) throw new Error("value must be a u128");
  return poseidon3([value, fe("label", label), fe("precommitment", precommitment)]);
}
