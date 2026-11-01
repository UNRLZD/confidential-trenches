// Card wallet-note-secrets: each note's secrets come from the 12 words by fixed paths (docs/plan1/wallet.md §2.3
// l.175-191 at research ffcba5e), and the note hashes are the kit's frozen note (vault.md:1256, VAULT_NOTE_HASHES).
//   node --test test/note-secrets.test.ts      (from packages/wallet)
// WU-03 (wallet.md:1042) on the notes of the §A.8 vector set (test/vectors/a8.json, the paper's lines transcribed),
// starting from the words. The test words are the A.8 seed and the second published BIP-39 vector, made here from
// their entropy; no assertion prints a word, a seed, a master, a nullifier or a secret.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VAULT_FIELD_P, VAULT_NOTE_HASHES } from "@blindfill/kit";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import * as d from "../src/derive/index.ts";
import { type NoteRef, noteSecrets, noteSecretsFromWords, vaultNote } from "../src/notes/secrets.ts";

const A8 = JSON.parse(readFileSync(new URL("./vectors/a8.json", import.meta.url), "utf8"));
const big = (h: string): bigint => BigInt(`0x${h}`);
const fe = (x: bigint): string => x.toString(16).padStart(64, "0");
const WORDS = d.entropyToWords(new Uint8Array(16)); // A.8's input: the first published BIP-39 vector
const OTHER_WORDS = d.entropyToWords(new Uint8Array(16).fill(0x7f)); // the second published BIP-39 vector
const SEED = d.wordsToSeed64(WORDS);
const S = big(A8.s);
const L = big(A8.l);

type Line = { name: string; note: string; s?: string; i?: number; l?: string; j?: number; c?: d.Chain; id?: string; n?: number; precommitment: string; nullifierHash: string; value?: string; label?: string; commitment?: string };
function ref(e: Line): NoteRef {
  switch (e.note) {
    case "deposit": return { kind: "deposit", s: big(e.s!), i: e.i! };
    case "change": return { kind: "change", l: big(e.l!), j: e.j! };
    case "return": return { kind: "return", c: e.c!, l: big(e.l!), j: e.j! };
    case "move": return { kind: "move", l: big(e.l!), j: e.j! };
    case "refund": return { kind: "refund", l: big(e.l!), j: e.j! };
    case "second": {
      const id = e.id === "U" ? { id: "U" as const, s: big(e.s!), i: e.i! } : e.id === "R" ? { id: "R" as const, c: e.c!, l: big(e.l!), j: e.j! } : { id: e.id as "V" | "A", l: big(e.l!), j: e.j! };
      return { kind: "second", id, n: e.n! };
    }
    default: throw new Error(`unknown note line ${e.name}`);
  }
}
const LINES = A8.notes as Line[];
// The frozen derivation (../src/derive/notes.ts, card kit-freeze-keys) called directly, for comparison.
function frozen(r: NoteRef): d.NoteSecrets {
  switch (r.kind) {
    case "deposit": return d.depositNote(SEED, r.s, r.i);
    case "change": return d.changeNote(SEED, r.l, r.j);
    case "return": return d.returnNote(SEED, r.c, r.l, r.j);
    case "move": return d.moveNote(SEED, r.l, r.j);
    case "refund": return d.refundNote(SEED, r.l, r.j);
    case "second": return d.secondNote(SEED, r.id, r.n);
  }
}

test("the vector set has every note kind of wallet.md:175-191 and the 29 note lines of A.8", () => {
  assert.deepEqual([...new Set(LINES.map((e) => e.note))].sort(), ["change", "deposit", "move", "refund", "return", "second"]);
  assert.equal(LINES.reduce((n, e) => n + 2 + (e.commitment ? 1 : 0), 0), 29);
});

test("WU-03 from the 12 words: every A.8 note's precommitment, nullifier hash and the deposit's commitment", () => {
  for (const e of LINES) {
    const r = noteSecretsFromWords(WORDS, ref(e));
    assert.equal(fe(r.precommitment), e.precommitment, `${e.name} precommitment`);
    assert.equal(fe(r.nullifierHash), e.nullifierHash, `${e.name} nullifierHash`);
    if (e.commitment) {
      const note = vaultNote(r, BigInt(e.value!), big(e.label!));
      assert.equal(fe(note.commitment), e.commitment, `${e.name} commitment`);
      assert.equal(note.value, BigInt(e.value!));
      assert.equal(note.label, big(e.label!));
    }
  }
});

test("the hashes are the kit's frozen note: its input order, and equal to the frozen derivation's own", () => {
  assert.deepEqual(VAULT_NOTE_HASHES, { precommitment: ["nullifier", "secret"], commitment: ["value", "label", "precommitment"], nullifierHash: ["nullifier"] });
  for (const e of LINES) {
    const r = noteSecrets(SEED, ref(e));
    assert.equal(r.precommitment, poseidon2([r.nullifier, r.secret]), e.name);
    assert.equal(r.nullifierHash, poseidon1([r.nullifier]), e.name);
    // the swapped order would be another note
    assert.notEqual(r.precommitment, poseidon2([r.secret, r.nullifier]), e.name);
    const k = frozen(ref(e));
    assert.deepEqual([r.nullifier, r.secret, r.precommitment, r.nullifierHash], [k.nullifier, k.secret, k.precommitment, k.nullifierHash], e.name);
  }
  const dep = noteSecrets(SEED, { kind: "deposit", s: S, i: 0 });
  assert.equal(vaultNote(dep, 7n, L).commitment, poseidon3([7n, L, dep.precommitment]));
  assert.equal(vaultNote(dep, 7n, L).commitment, d.commitment(7n, L, dep.precommitment));
});

test("determinism: the same words and fields give the same secrets on every run; another index, label, kind or words do not", () => {
  const refs: NoteRef[] = [
    { kind: "deposit", s: S, i: 0 },
    { kind: "deposit", s: S, i: 1 },
    { kind: "deposit", s: S - 1n, i: 0 },
    { kind: "change", l: L, j: 0 },
    { kind: "change", l: L, j: 1 },
    { kind: "change", l: L - 1n, j: 0 },
    { kind: "move", l: L, j: 0 },
    { kind: "refund", l: L, j: 0 },
    { kind: "return", c: "sol", l: L, j: 0 },
    { kind: "return", c: "evm", l: L, j: 0 },
    { kind: "second", id: { id: "V", l: L, j: 0 }, n: 0 },
    { kind: "second", id: { id: "A", l: L, j: 0 }, n: 0 },
    { kind: "second", id: { id: "A", l: L, j: 0 }, n: 1 },
  ];
  const once = refs.map((r) => noteSecretsFromWords(WORDS, r));
  const again = refs.map((r) => noteSecretsFromWords(` ${WORDS.split(" ").join("  ")} `, r)); // the same words, typed loosely
  assert.deepEqual(again, once);
  const all = once.flatMap((x) => [x.nullifier, x.secret]);
  assert.equal(new Set(all).size, all.length, "two notes, or a nullifier and a secret, share a value");
  const other = refs.map((r) => noteSecretsFromWords(OTHER_WORDS, r));
  for (let k = 0; k < refs.length; k++) {
    assert.notEqual(other[k]!.nullifier, once[k]!.nullifier, `ref ${k}`);
    assert.notEqual(other[k]!.secret, once[k]!.secret, `ref ${k}`);
  }
  // one checksum-breaking word is refused, never turned into another seed
  const broken = WORDS.split(" ");
  broken[11] = "abandon";
  assert.throws(() => noteSecretsFromWords(broken.join(" "), refs[0]!), /not 12 valid BIP-39 English words/);
});

test("field: every derived element is below p; the HKDF bytes of a master are reduced mod p; inputs at p are refused", () => {
  assert.equal(d.P, VAULT_FIELD_P);
  // wallet.md:65, :89: master = Poseidon(x mod p), x = the 64 HKDF bytes big-endian. x is a 512-bit value, so the
  // reduction is not a no-op, and it is mod p (not a truncation to 32 bytes or mod 2^254).
  for (const kind of ["deposit", "return", "move", "refund", "second"] as const) {
    const m = d.masters(SEED, kind);
    for (const part of ["nullifier", "secret"] as const) {
      const okm = d.hkdfSeed(SEED, new TextEncoder().encode(d.masterInfo(kind, part)), 64);
      const x = big(Buffer.from(okm).toString("hex"));
      assert.ok(x >= VAULT_FIELD_P, `${kind}/${part}: x already below p`);
      assert.equal(m[part], poseidon1([x % VAULT_FIELD_P]), `${kind}/${part}`);
      assert.notEqual(m[part], poseidon1([x & ((1n << 254n) - 1n)]), `${kind}/${part}`);
      assert.ok(m[part] < VAULT_FIELD_P);
    }
  }
  // every output below p, over the vector set and a spread of indices up to the counter's top, 2^32 - 1
  const outs: bigint[] = [];
  for (const e of LINES) {
    const r = noteSecrets(SEED, ref(e));
    outs.push(r.nullifier, r.secret, r.precommitment, r.nullifierHash);
  }
  for (const i of [0, 1, 2, 255, 256, 65_535, 2 ** 31, 2 ** 32 - 1]) {
    const r = noteSecrets(SEED, { kind: "deposit", s: S, i });
    outs.push(r.nullifier, r.secret, r.precommitment, r.nullifierHash, vaultNote(r, (1n << 128n) - 1n, L).commitment);
  }
  assert.ok(outs.every((x) => typeof x === "bigint" && x >= 0n && x < VAULT_FIELD_P));

  // the edge: p - 1 is a field element, p is not. poseidon-lite would take p as 0 (the reason for the guard)
  assert.equal(poseidon1([VAULT_FIELD_P]), poseidon1([0n]));
  const top = noteSecrets(SEED, { kind: "deposit", s: VAULT_FIELD_P - 1n, i: 0 });
  assert.ok(top.nullifier < VAULT_FIELD_P && top.secret < VAULT_FIELD_P);
  assert.notDeepEqual(top, noteSecrets(SEED, { kind: "deposit", s: 0n, i: 0 }));
  assert.throws(() => noteSecrets(SEED, { kind: "deposit", s: VAULT_FIELD_P, i: 0 }), /not a field element/);
  assert.throws(() => noteSecrets(SEED, { kind: "change", l: VAULT_FIELD_P, j: 0 }), /not a field element/);
  assert.throws(() => noteSecrets(SEED, { kind: "deposit", s: -1n, i: 0 }), /not a field element/);
  assert.throws(() => noteSecrets(SEED, { kind: "deposit", s: S, i: 2 ** 32 }), /not a counter/);
  const dep = noteSecrets(SEED, { kind: "deposit", s: S, i: 0 });
  assert.equal(vaultNote(dep, 1n, VAULT_FIELD_P - 1n).label, VAULT_FIELD_P - 1n);
  assert.throws(() => vaultNote(dep, 1n, VAULT_FIELD_P), /label is not a field element/);
  assert.throws(() => vaultNote(dep, 1n << 128n, L), /u128/);
  assert.throws(() => vaultNote({ ...dep, precommitment: dep.precommitment + 1n }, 1n, L), /does not match/);
  assert.throws(() => vaultNote({ ...dep, nullifier: VAULT_FIELD_P }, 1n, L), /nullifier is not a field element/);
});

test("unknown kinds and ids are refused", () => {
  assert.throws(() => noteSecrets(SEED, { kind: "other" } as unknown as NoteRef), /unknown note kind/);
  assert.throws(() => noteSecrets(SEED, { kind: "return", c: "btc" as d.Chain, l: L, j: 0 }), /unknown chain tag/);
  assert.throws(() => noteSecrets(SEED, { kind: "second", id: { id: "X" } as unknown as d.SecondId, n: 0 }), /unknown second-arrival id/);
  assert.throws(() => noteSecrets(new Uint8Array(32), { kind: "deposit", s: S, i: 0 }), /seed64 must be 64 bytes/);
});
