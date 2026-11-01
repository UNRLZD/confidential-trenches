// Each note's secrets from the 12 words, by fixed paths, so a wiped device finds every note again (card
// wallet-note-secrets; docs/plan1/wallet.md §2.3 Secrets l.175-191 and §2.2 l.61-114 at research ffcba5e).
//
// - The nullifier and secret come from the wallet's frozen derivations (../derive, card kit-freeze-keys): a master is
//   Poseidon(x), x = HKDF-SHA512(seed64, salt "blindfill/v1", info "notes/…", 64 B) read big-endian and reduced mod p
//   (wallet.md:65, :89); a note's nullifier or secret is Poseidon(master, the note's fields) (D37, wallet.md:175-191).
// - The precommitment, the nullifier hash and the commitment are made here exactly as the kit's frozen note says
//   (@blindfill/kit VAULT_NOTE_HASHES, the vault paper §7.1 Note row, vault.md:1256): each hash takes its inputs in the
//   kit's order, by name.
// - Field rule (the vault's, card vault-poseidon): every Poseidon input is in [0, p) and is refused otherwise, never
//   reduced. poseidon-lite reduces silently (poseidon1([p]) equals poseidon1([0])), which would make a note the vault
//   never computes; the HKDF bytes of a master are the one value the paper reduces, and ../derive does that.
// Nothing here logs; the words, seed64, masters, nullifiers and secrets never leave the device (wallet.md:162-164).
import { VAULT_FIELD_P, VAULT_NOTE_HASHES, type VaultNote, type VaultNoteSecrets } from "@blindfill/kit";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import {
  type Chain,
  changeNote,
  depositNote,
  moveNote,
  type NoteSecrets,
  P,
  refundNote,
  returnNote,
  type SecondId,
  secondNote,
  wordsToSeed64,
} from "../derive/index.ts";

if (P !== VAULT_FIELD_P) throw new Error("the wallet's p is not the kit's VAULT_FIELD_P");

// Which note: the fields its secrets come from (wallet.md:175-191). i, j and n are counters < 2^32; s and l field
// elements; c a chain tag. j is fixed by the spent note (changeIndex), i by the store's counter.
export type NoteRef =
  | { kind: "deposit"; s: bigint; i: number }
  | { kind: "change"; l: bigint; j: number }
  | { kind: "return"; c: Chain; l: bigint; j: number }
  | { kind: "move"; l: bigint; j: number }
  | { kind: "refund"; l: bigint; j: number }
  | { kind: "second"; id: SecondId; n: number };

/** A note's two secrets and the two hashes that need nothing from the vault. */
export type DeviceNoteSecrets = VaultNoteSecrets & { precommitment: bigint; nullifierHash: bigint };

const POSEIDON = [poseidon1, poseidon2, poseidon3] as const;
type HashName = keyof typeof VAULT_NOTE_HASHES;
function noteHash<N extends HashName>(name: N, from: Record<(typeof VAULT_NOTE_HASHES)[N][number], bigint>): bigint {
  const inputs = VAULT_NOTE_HASHES[name].map((k: (typeof VAULT_NOTE_HASHES)[N][number]) => {
    const x = from[k];
    if (typeof x !== "bigint" || x < 0n || x >= VAULT_FIELD_P) throw new Error(`${name}: ${k} is not a field element in [0, p)`);
    return x;
  });
  const out = POSEIDON[inputs.length - 1]!(inputs);
  if (out < 0n || out >= VAULT_FIELD_P) throw new Error(`${name} is not below p`);
  return out;
}

function derived(seed64: Uint8Array, ref: NoteRef): NoteSecrets {
  switch (ref?.kind) {
    case "deposit": return depositNote(seed64, ref.s, ref.i);
    case "change": return changeNote(seed64, ref.l, ref.j);
    case "return": return returnNote(seed64, ref.c, ref.l, ref.j);
    case "move": return moveNote(seed64, ref.l, ref.j);
    case "refund": return refundNote(seed64, ref.l, ref.j);
    case "second": return secondNote(seed64, ref.id, ref.n);
    default: throw new Error("unknown note kind");
  }
}

/** The note's secrets from seed64 (the store holds the seed; restore walks the refs). */
export function noteSecrets(seed64: Uint8Array, ref: NoteRef): DeviceNoteSecrets {
  const { nullifier, secret } = derived(seed64, ref);
  return {
    nullifier,
    secret,
    precommitment: noteHash("precommitment", { nullifier, secret }),
    nullifierHash: noteHash("nullifierHash", { nullifier }),
  };
}

/**
 * The same from the 12 words: the BIP-39 checksum first, then seed64 with an empty passphrase (wallet.md:49, :54).
 * seed64 is zeroed once the secrets are made.
 */
export function noteSecretsFromWords(words: string, ref: NoteRef): DeviceNoteSecrets {
  const seed64 = wordsToSeed64(words);
  try {
    return noteSecrets(seed64, ref);
  } finally {
    seed64.fill(0);
  }
}

/** The commitment the vault computes for a note (kit order: value, label, precommitment); needs no secret. */
export function noteCommitment(value: bigint, label: bigint, precommitment: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 128n) throw new Error("value must be a u128");
  return noteHash("commitment", { value, label, precommitment });
}

/** The whole note once the vault has given it a value and a label (the deposit's amount and label, or settle's). */
export function vaultNote(s: DeviceNoteSecrets, value: bigint, label: bigint): VaultNote {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 128n) throw new Error("value must be a u128");
  const precommitment = noteHash("precommitment", { nullifier: s.nullifier, secret: s.secret });
  if (precommitment !== s.precommitment) throw new Error("precommitment does not match the note's secrets");
  return {
    nullifier: s.nullifier,
    secret: s.secret,
    value,
    label,
    precommitment,
    commitment: noteHash("commitment", { value, label, precommitment }),
    nullifierHash: noteHash("nullifierHash", { nullifier: s.nullifier }),
  };
}
