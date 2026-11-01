#!/usr/bin/env node
// Live check of card kit-freeze-keys: the wallet's key paths and their vector set, frozen with the kit at Nov 1 06:00Z.
// It reads packages/wallet/test/vectors/a8.json from GitHub (main, then the freeze tag given by --tag) and derives every
// key and address in it again with an implementation of its own that shares no code with the kit: Node's node:crypto
// (PBKDF2, HKDF-SHA512, HMAC-SHA512, SHA-256, ed25519, secp256k1), with Keccak-256, BIP-32 and SLIP-10 hardened
// steps, base58 and the encodings of docs/plan1/wallet.md §2.2 (research ffcba5e) written out here. The kit uses @noble and
// @scure. It compares each one-time id (U, R, V, A, T), each fresh wallet's info, path and address on all six chain
// tags, and the scope and label, byte for byte. The note values (Poseidon) are pinned by their sha256 below, as the
// kit's own test WU-03 derives them.
//   node scripts/live-checks/kit-freeze-keys.mjs [--tag <freeze tag>] [--record <file>]   PASS 0, FAIL 1, error 2
// No key, secret or mnemonic is printed: a line names an entry and says ok or BAD.
import "../net-window.mjs";
import { createECDH, createHash, createHmac, createPrivateKey, createPublicKey, hkdfSync, pbkdf2Sync } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "kit-freeze-keys";
const REPO = "UNRLZD/confidential-trenches";
const FILE = "packages/wallet/test/vectors/a8.json";
export const urlOf = (ref) => `https://raw.githubusercontent.com/${REPO}/${ref}/${FILE}`;

// ---------- pinned ----------
const P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // secp256k1 order
const SALT = "blindfill/v1";
const SCOPE = "blindfill/v1/test-scope";
const CHAINS = { sol: [1, 501, "ed"], evm: [2, 60, "k1"], near: [3, 397, "ed"], "hop-sol": [4, 501, "ed"], "hop-evm": [5, 60, "k1"], "hop-near": [6, 397, "ed"] };
// The A.8 seed is the first published BIP-39 vector: 16 zero bytes. Its words are word 0 eleven times and then the
// word at its checksum's index; these are the two English list words it needs (BIP-39 english.txt lines 1 and 4).
const WORDS = new Map([[0, "abandon"], [3, "about"]]);
// sha256 of JSON.stringify(a8.notes): the 14 note lines of wallet.md §A.8 as the kit's WU-03 checks them.
export const NOTES_SHA256 = "d26d38391f798aa3d4bad018ac4f614887b1925060739a9ab128ec8139d1e3e0";

// ---------- helpers ----------
const hex = (b) => Buffer.from(b).toString("hex");
const big = (h) => BigInt(`0x${h}`);
const be = (x, n) => Buffer.from(x.toString(16).padStart(n * 2, "0"), "hex");
const u32 = (x) => { const b = Buffer.alloc(4); b.writeUInt32BE(x); return b; };
// Keccak-256 (the Ethereum one, pad 0x01), written out: not every Node build's OpenSSL has it (one Node 24 build
// answers "Digest method not supported"). The round constants and rotations come from the Keccak reference's LFSR and
// (x, y) walk, not from a table; the check tests it on keccak-256("") before anything else.
const M64 = (1n << 64n) - 1n;
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64);
const ROT = Array(25).fill(0);
for (let t = 0, x = 1, y = 0; t < 24; t++) { ROT[x + 5 * y] = (((t + 1) * (t + 2)) / 2) % 64; [x, y] = [y, (2 * x + 3 * y) % 5]; }
const RC = [];
for (let r = 0, lfsr = 1; r < 24; r++) {
  let rc = 0n;
  for (let j = 0; j < 7; j++) {
    const bit = lfsr & 1;
    lfsr = lfsr & 0x80 ? ((lfsr << 1) ^ 0x71) & 0xff : (lfsr << 1) & 0xff;
    if (bit) rc ^= 1n << BigInt((1 << j) - 1);
  }
  RC.push(rc);
}
function keccakF(A) {
  for (let r = 0; r < 24; r++) {
    const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
    for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D; }
    const B = Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M64 & B[((x + 2) % 5) + 5 * y]);
    A[0] ^= RC[r];
  }
}
function keccak(data) {
  const rate = 136, msg = Buffer.from(data);
  const padded = Buffer.alloc(Math.floor(msg.length / rate) * rate + rate);
  msg.copy(padded);
  padded[msg.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const A = Array(25).fill(0n);
  for (let o = 0; o < padded.length; o += rate) {
    for (let i = 0; i < rate / 8; i++) A[i] ^= padded.readBigUInt64LE(o + 8 * i);
    keccakF(A);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], 8 * i);
  return out;
}
if (keccak(Buffer.alloc(0)).toString("hex") !== "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
  throw new Error("the check's keccak-256 fails its own test");
const sha256 = (b) => createHash("sha256").update(b).digest();
const hmac = (k, d) => createHmac("sha512", k).update(d).digest();
const hkdf = (seed, info, L) => Buffer.from(hkdfSync("sha512", seed, Buffer.from(SALT), info, L));
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(b) {
  let x = big(hex(b) || "0"), s = "";
  while (x > 0n) { s = B58[Number(x % 58n)] + s; x /= 58n; }
  for (const byte of b) { if (byte !== 0) break; s = "1" + s; }
  return s;
}
function edPub(seed32) {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed32]);
  return createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).subarray(-32);
}
function k1Pub(priv32) {
  const e = createECDH("secp256k1");
  e.setPrivateKey(priv32);
  return e.getPublicKey(); // 65 bytes, uncompressed
}

// ---------- the seed ----------
function seedOf(inputs) {
  if (!inputs || inputs.passphrase !== "" || inputs.entropy !== "00".repeat(16)) throw new Error("the set's inputs are not A.8's (16 zero bytes, empty passphrase)");
  const ent = Buffer.from(inputs.entropy, "hex");
  const bits = [...ent].map((b) => b.toString(2).padStart(8, "0")).join("") + sha256(ent)[0].toString(2).padStart(8, "0").slice(0, 4);
  const words = bits.match(/.{11}/g).map((w) => WORDS.get(parseInt(w, 2)));
  if (words.some((w) => !w)) throw new Error("the set's entropy needs a word this check does not pin");
  return pbkdf2Sync(Buffer.from(words.join(" ").normalize("NFKD")), Buffer.from("mnemonic"), 2048, 64, "sha512");
}

// ---------- the encodings ----------
const fe = (x) => { if (x < 0n || x >= P) throw new Error("not a field element"); return be(x, 32); };
const tag = (c) => { if (!Object.hasOwn(CHAINS, c)) throw new Error(`unknown chain tag ${c}`); return Buffer.of(CHAINS[c][0]); };
const INFO = {
  in: (e) => Buffer.concat([Buffer.from("onetime/in"), fe(big(e.s)), u32(e.i)]),
  return: (e) => Buffer.concat([Buffer.from("onetime/return"), tag(e.c), fe(big(e.l)), u32(e.j)]),
  refund: (e) => Buffer.concat([Buffer.from("onetime/refund"), fe(big(e.l)), u32(e.j)]),
  arm: (e) => Buffer.concat([Buffer.from("onetime/arm"), fe(big(e.l)), u32(e.j)]),
  profile: (e) => Buffer.concat([Buffer.from("profile"), u32(e.k)]),
  wallet: (e) => Buffer.concat([Buffer.from("wallet"), tag(e.c), fe(big(e.l)), u32(e.j)]),
};

// SLIP-10 ed25519 and BIP-32 secp256k1, hardened steps only (every W step is hardened, wallet.md:62)
function slip10(seed, steps) {
  let I = hmac("ed25519 seed", seed);
  for (const i of steps) I = hmac(I.subarray(32), Buffer.concat([Buffer.of(0), I.subarray(0, 32), u32(i + 0x80000000)]));
  return I.subarray(0, 32);
}
function bip32(seed, steps) {
  let I = hmac("Bitcoin seed", seed);
  let k = big(hex(I.subarray(0, 32))), c = I.subarray(32);
  if (k === 0n || k >= N) throw new Error("bad master key");
  for (const i of steps) {
    I = hmac(c, Buffer.concat([Buffer.of(0), be(k, 32), u32(i + 0x80000000)]));
    const t = big(hex(I.subarray(0, 32)));
    k = (t + k) % N;
    if (t >= N || k === 0n) throw new Error("bad child key");
    c = I.subarray(32);
  }
  return be(k, 32);
}

function wallet(seed, e) {
  const [, coin, curve] = CHAINS[e.c] ?? [];
  if (!coin) throw new Error(`unknown chain tag ${e.c}`);
  const info = INFO.wallet(e);
  const ab = hkdf(seed, info, 8);
  const a = ab.readUInt32BE(0) & 0x7fffffff, b = ab.readUInt32BE(4) & 0x7fffffff;
  const path = `m/44'/${coin}'/${a}'/${b}'`;
  let address;
  if (curve === "ed") {
    const pub = edPub(slip10(seed, [44, coin, a, b]));
    address = e.c.endsWith("sol") ? base58(pub) : hex(pub);
  } else address = "0x" + hex(keccak(k1Pub(bip32(seed, [44, coin, a, b])).subarray(1)).subarray(12));
  return { info: hex(info), path, address };
}

// ---------- the check of one set ----------
export function checkSet(set, where) {
  const lines = [];
  const say = (ok, what) => (lines.push(`${ok ? "ok " : "BAD"} ${where}: ${what}`), ok);
  let ok = true;
  const seed = seedOf(set.inputs);
  const s = big(hex(keccak(Buffer.from(SCOPE)))) % P;
  const l = big(hex(keccak(Buffer.concat([be(s, 32), be(1n, 32)])))) % P;
  ok &= say(set.inputs.scope === SCOPE && set.inputs.labelNonce === 1 && big(set.p) === P && big(set.s) === s && big(set.l) === l && set.bitlenL === 254 && l >= 1n << 253n, "p, the scope s and the label l (n = 1)");
  const ids = set.ids ?? [], wallets = set.wallets ?? [];
  const cover = ["in", "return", "refund", "arm", "profile"].every((k) => ids.some((e) => e.kind === k)) &&
    Object.keys(CHAINS).every((c) => [0, 1].every((j) => wallets.some((w) => w.c === c && w.j === j) && ids.some((e) => e.kind === "return" && e.c === c && e.j === j))) &&
    ids.length === 22 && wallets.length === 12;
  ok &= say(cover, `the set holds ${ids.length} ids and ${wallets.length} wallets: U, R, V, A, T, and W and R on all six tags for j = 0 and 1`);
  for (const e of ids) {
    const info = INFO[e.kind]?.(e);
    if (!info) { ok &= say(false, `${e.name}: unknown kind ${e.kind}`); continue; }
    const id = hex(edPub(hkdf(seed, info, 32)));
    ok &= say(id === e.id && (e.info === undefined || e.info === hex(info)), `${e.name}${e.info ? " and its info" : ""}`);
  }
  for (const w of wallets) {
    const r = wallet(seed, w);
    const what = [r.info === w.info || w.info === undefined ? "" : "info", r.path === w.path ? "" : "path", r.address === w.address ? "" : "address"].filter(Boolean);
    ok &= say(what.length === 0, `${w.name} ${w.path}${what.length ? ` differs in ${what.join(", ")}` : " and address"}`);
  }
  const notes = hex(sha256(Buffer.from(JSON.stringify(set.notes ?? null))));
  ok &= say(notes === NOTES_SHA256, `the ${set.notes?.length ?? 0} note lines match the frozen set (sha256 ${notes.slice(0, 12)})`);
  return { ok: Boolean(ok), lines };
}

export async function check({ refs = ["main"], fetchFn = fetch }) {
  const lines = [];
  let ok = true;
  for (const ref of refs) {
    const url = urlOf(ref);
    const r = await fetchFn(url);
    if (r.status !== 200) { lines.push(`BAD ${ref}: ${url} answered ${r.status}`); ok = false; continue; }
    let set;
    try { set = JSON.parse(await r.text()); } catch { lines.push(`BAD ${ref}: not JSON`); ok = false; continue; }
    try {
      const c = checkSet(set, ref);
      lines.push(...c.lines);
      ok &&= c.ok;
    } catch (e) {
      lines.push(`BAD ${ref}: ${String(e.message).split("\n")[0]}`);
      ok = false;
    }
  }
  return { ok, lines };
}

// a fetch that keeps every answer it reads: { url, status, body }
export function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url) => {
    const r = await fetchFn(url);
    const body = await r.text();
    answers.push({ url, status: r.status, body });
    return { status: r.status, text: async () => body };
  };
  return { answers, fetchFn: wrapped };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const rec = recorder();
    const refs = opt("--tag") ? ["main", opt("--tag")] : ["main"];
    const r = await check({ refs, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers, null, 1) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    if (!opt("--tag")) console.log(`live-check ${KEY}: the freeze tag was not read (pass --tag <name> once it exists)`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
