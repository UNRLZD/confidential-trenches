// Solana wire decoding for the device's checks (T2.2): the transaction, its v0 message, address lookup tables and
// associated token addresses, parsed by hand from the bytes. Every input here is hostile: every length is bounded and
// any byte the format does not allow, or any byte left over, throws.
//
// Formats, read 2026-11-01:
// - Transaction: compact-u16 signature count, 64-byte signatures, then the message
//   (https://solana.com/docs/core/transactions, "Transaction").
// - v0 message: prefix 0x80 | version, header (3 u8), compact-u16 static keys, 32-byte blockhash, compact-u16
//   instructions (u8 program index, compact-u16 account indexes as u8, compact-u16 data), compact-u16 lookups
//   (32-byte table, compact-u16 writable u8 indexes, compact-u16 readonly u8 indexes). Loaded keys follow the static
//   keys: every table's writable entries, then every table's readonly entries (solana-sdk `v0::LoadedAddresses`).
// - Lookup table account: 56-byte meta (u32 type = 1, u64 deactivation slot, u64 last extended slot, u8 start index,
//   Option<Pubkey> authority, u16 padding), then 32-byte addresses (`LOOKUP_TABLE_META_SIZE` = 56).
// - Program address: sha256(seeds || program id || "ProgramDerivedAddress"), off the ed25519 curve, bump from 255 down.
import { base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";

export const SOLANA_MAX_TX_BYTES = 1232;
export const SOLANA_ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
export const SOLANA_ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const ALT_META = 56;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

export type SolanaInstruction = { programIndex: number; accounts: number[]; data: Uint8Array };
export type SolanaLookup = { table: string; writable: number[]; readonly: number[] };
export type SolanaMessage = {
  version: 0;
  requiredSignatures: number;
  readonlySigned: number;
  readonlyUnsigned: number;
  staticKeys: string[];
  blockhash: string;
  instructions: SolanaInstruction[];
  lookups: SolanaLookup[];
};
export type SolanaTransaction = { signatures: number; message: SolanaMessage; messageBytes: Uint8Array; size: number };

class Reader {
  o = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  u8(): number {
    const v = this.b[this.o];
    if (v === undefined) throw new Error(`truncated at byte ${this.o}`);
    this.o += 1;
    return v;
  }
  bytes(n: number): Uint8Array {
    if (this.o + n > this.b.length) throw new Error(`truncated: ${n} bytes wanted at ${this.o} of ${this.b.length}`);
    const v = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return v;
  }
  // compact-u16 (short_vec): 1-3 bytes, 7 bits each; a non-minimal form or a value over 0xffff is refused, as the
  // runtime refuses it.
  compact(): number {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const byte = this.u8();
      v |= (byte & 0x7f) << (7 * i);
      if ((byte & 0x80) === 0) {
        if (i > 0 && byte === 0) throw new Error("compact-u16 not in its shortest form");
        if (v > 0xffff) throw new Error("compact-u16 over 0xffff");
        return v;
      }
    }
    throw new Error("compact-u16 longer than 3 bytes");
  }
  key(): string {
    return base58.encode(this.bytes(32));
  }
}

export function solanaDecodeMessage(bytes: Uint8Array): SolanaMessage {
  const r = new Reader(bytes);
  const prefix = r.u8();
  if (prefix !== 0x80) throw new Error(`message prefix ${prefix} is not a v0 message`);
  const requiredSignatures = r.u8();
  const readonlySigned = r.u8();
  const readonlyUnsigned = r.u8();
  const nKeys = r.compact();
  const staticKeys: string[] = [];
  for (let i = 0; i < nKeys; i++) staticKeys.push(r.key());
  if (requiredSignatures === 0 || requiredSignatures > nKeys || readonlySigned >= requiredSignatures || readonlyUnsigned > nKeys - requiredSignatures) {
    throw new Error(`header ${requiredSignatures}/${readonlySigned}/${readonlyUnsigned} does not fit ${nKeys} keys`);
  }
  const blockhash = r.key();
  const nIx = r.compact();
  const instructions: SolanaInstruction[] = [];
  for (let i = 0; i < nIx; i++) {
    const programIndex = r.u8();
    const nAcc = r.compact();
    const accounts = [...r.bytes(nAcc)];
    const data = r.bytes(r.compact()).slice();
    instructions.push({ programIndex, accounts, data });
  }
  const nLookups = r.compact();
  const lookups: SolanaLookup[] = [];
  for (let i = 0; i < nLookups; i++) {
    const table = r.key();
    const writable = [...r.bytes(r.compact())];
    const readonly = [...r.bytes(r.compact())];
    if (writable.length + readonly.length === 0) throw new Error(`lookup ${table} uses no index`);
    lookups.push({ table, writable, readonly });
  }
  if (r.o !== bytes.length) throw new Error(`${bytes.length - r.o} bytes after the message`);
  return { version: 0, requiredSignatures, readonlySigned, readonlyUnsigned, staticKeys, blockhash, instructions, lookups };
}

// A wire transaction: the signature slots (their bytes are not checked: the device signs after the checks) and the
// message. The signature count must equal the header's.
export function solanaDecodeTransaction(bytes: Uint8Array): SolanaTransaction {
  const r = new Reader(bytes);
  const signatures = r.compact();
  r.bytes(64 * signatures);
  const messageBytes = bytes.subarray(r.o);
  const message = solanaDecodeMessage(messageBytes);
  if (message.requiredSignatures !== signatures) throw new Error(`${signatures} signature slots for ${message.requiredSignatures} signers`);
  return { signatures, message, messageBytes, size: bytes.length };
}

export type SolanaLookupTable = { deactivationSlot: bigint; addresses: string[] };

export function solanaDecodeLookupTable(data: Uint8Array): SolanaLookupTable {
  if (data.length < ALT_META || data.length > ALT_META + 256 * 32 || (data.length - ALT_META) % 32 !== 0) throw new Error(`lookup table data of ${data.length} bytes`);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint32(0, true) !== 1) throw new Error(`lookup table type ${v.getUint32(0, true)} is not 1`);
  const tag = data[21];
  if (tag !== 0 && tag !== 1) throw new Error(`lookup table authority tag ${tag}`);
  const addresses: string[] = [];
  for (let o = ALT_META; o < data.length; o += 32) addresses.push(base58.encode(data.subarray(o, o + 32)));
  return { deactivationSlot: v.getBigUint64(4, true), addresses };
}

export const solanaTableIsActive = (t: SolanaLookupTable): boolean => t.deactivationSlot === U64_MAX;

export type SolanaAccountKey = { key: string; signer: boolean; writable: boolean };

// Every account key of the message in index order, with the lookups resolved from tables the caller read.
export function solanaResolveKeys(m: SolanaMessage, tables: Readonly<Record<string, SolanaLookupTable>>): SolanaAccountKey[] {
  const n = m.staticKeys.length;
  const keys: SolanaAccountKey[] = m.staticKeys.map((key, i) => ({
    key,
    signer: i < m.requiredSignatures,
    writable: i < m.requiredSignatures ? i < m.requiredSignatures - m.readonlySigned : i < n - m.readonlyUnsigned,
  }));
  const pick = (l: SolanaLookup, i: number): string => {
    const t = Object.hasOwn(tables, l.table) ? tables[l.table] : undefined;
    if (!t) throw new Error(`lookup table ${l.table} not read`);
    const a = t.addresses[i];
    if (a === undefined) throw new Error(`lookup table ${l.table} has no index ${i}`);
    return a;
  };
  for (const l of m.lookups) for (const i of l.writable) keys.push({ key: pick(l, i), signer: false, writable: true });
  for (const l of m.lookups) for (const i of l.readonly) keys.push({ key: pick(l, i), signer: false, writable: false });
  if (keys.length > 256) throw new Error(`${keys.length} account keys`);
  return keys;
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function onCurve(b: Uint8Array): boolean {
  try {
    // zip215 decoding accepts a non-canonical y, as curve25519-dalek's decompress does in the runtime's check.
    ed25519.Point.fromBytes(b, true);
    return true;
  } catch {
    return false;
  }
}

export function solanaProgramAddress(seeds: Uint8Array[], program: string): string {
  const prog = base58.decode(program);
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), prog, PDA_MARKER];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const h = sha256(buf);
    if (!onCurve(h)) return base58.encode(h);
  }
  throw new Error("no program address");
}

// The associated token account of (owner, mint) under a token program.
export const solanaAta = (owner: string, mint: string, tokenProgram: string): string =>
  solanaProgramAddress([base58.decode(owner), base58.decode(tokenProgram), base58.decode(mint)], SOLANA_ATA_PROGRAM);
