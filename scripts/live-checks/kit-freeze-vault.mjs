#!/usr/bin/env node
// Live check of card kit-freeze-vault: the vault's frozen shapes as the public repo serves them. For each ref (main,
// then the Nov 1 06:00Z tag when given) it reads packages/kit/src/vault/shapes.ts and
// packages/kit/test/vectors/vault-v1.json from GitHub and checks:
//   - shapes.ts loads as one module with no imports (its types stripped by Node);
//   - the deposit message has exactly two fields, precommitment then depositor, and depositMessage() writes only them;
//   - U, R and V each move money in by their own ft_transfer_call on TOKEN, and no shape signs an ft_withdraw;
//   - the six setup-file sha256 values equal the vault paper's 2.6 (vault.md:522-527, pinned below, since this repo
//     carries no papers);
//   - the 50 vectors recompute with this check's own Borsh and Keccak-256 (read big-endian, mod p) in the paper's 7.1
//     order, and shapes.ts's own encoders make the same bytes.
// Nothing here imports the kit: the encoders below are written from the paper, apart from shapes.ts's.
//   node scripts/live-checks/kit-freeze-vault.mjs [--tag <tag>] [--record <file>]   PASS exit 0, FAIL exit 1, error exit 2
// --record writes the files the run read to <file> ({ref: {shapes, vectors}}), so the check's test can replay them.
import { writeFileSync, realpathSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const KEY = "kit-freeze-vault";
export const REPO = "UNRLZD/confidential-trenches";
export const FILES = { shapes: "packages/kit/src/vault/shapes.ts", vectors: "packages/kit/test/vectors/vault-v1.json" };
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// vault.md 2.6 (research main ffcba5e, l.522-527): Privacy Pools v1.3.0's circuit and key files
export const SETUP_SHA256 = [
  ["build/withdraw/withdraw_js/withdraw.wasm", "36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10"],
  ["trusted-setup/final-keys/withdraw.zkey", "2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677"], // gitleaks:allow (a public sha256 pin)
  ["trusted-setup/final-keys/withdraw.vkey", "666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e"], // gitleaks:allow (a public sha256 pin)
  ["build/commitment/commitment_js/commitment.wasm", "254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8"],
  ["trusted-setup/final-keys/commitment.zkey", "494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3"], // gitleaks:allow (a public sha256 pin)
  ["trusted-setup/final-keys/commitment.vkey", "7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8"], // gitleaks:allow (a public sha256 pin)
];
// vault.md 7.1 (l.1259) and 2.5.2 row 3: the context's Borsh order
export const CONTEXT_ORDER = ["processor", "recipient", "register_deposit", "fee_recipient", "relay_fee", "refund_precommitment", "deadline_ms", "salt"];

// ---- this check's own encoders ----
// Keccak-256: FIPS 202's Keccak-f[1600] with Keccak's own 0x01 padding, rate 136 bytes, written from the spec. Node's
// crypto has no keccak-256 in the official builds (Node 24.12 on Linux: "Digest method not supported"), so the check
// carries its own; the test holds it to Keccak's published answers.
const M64 = (1n << 64n) - 1n;
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]; // r[x + 5y]
const rot = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64);
export function keccak256(data) {
  const padded = new Uint8Array((Math.floor(data.length / 136) + 1) * 136);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const A = Array(25).fill(0n);
  for (let o = 0; o < padded.length; o += 136) {
    for (let i = 0; i < 17; i++) for (let b = 7; b >= 0; b--) A[i] ^= BigInt(padded[o + 8 * i + b]) << BigInt(8 * b);
    for (let r = 0; r < 24; r++) {
      const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) A[x + y] ^= C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1);
      const B = Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rot(A[x + 5 * y], ROT[x + 5 * y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M64 & B[((x + 2) % 5) + 5 * y]);
      A[0] ^= RC[r];
    }
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((A[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}
const keccak = (b) => Buffer.from(keccak256(b));
const field = (digest) => BigInt("0x" + digest.toString("hex")) % P;
const str = (s) => {
  const b = Buffer.from(s, "utf8");
  const n = Buffer.alloc(4);
  n.writeUInt32LE(b.length);
  return Buffer.concat([n, b]);
};
const le = (n, len) => Buffer.from(Array.from({ length: len }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn)));
const be = (n, len) => Buffer.from(n.toString(16).padStart(2 * len, "0"), "hex");
const ENCODE = {
  processor: str, recipient: str, fee_recipient: str,
  register_deposit: (v) => le(BigInt(v), 16), relay_fee: (v) => le(BigInt(v), 16),
  refund_precommitment: (v) => be(BigInt(v), 32), deadline_ms: (v) => le(BigInt(v), 8),
  salt: (v) => Buffer.from(v, "hex"),
};
const scopeBytes = (v) => Buffer.concat([str("blindfill-vault-v1"), str(v.vault), str(v.asset)]);
const labelBytes = (v) => Buffer.concat([be(BigInt(v.scope), 32), be(BigInt(v.nonce), 32)]);
const contextBytes = (v) => Buffer.concat([...CONTEXT_ORDER.map((k) => ENCODE[k](v.input[k])), be(BigInt(v.scope), 32)]);
const asNumbers = (i) => Object.fromEntries(Object.entries(i).map(([k, x]) => [k, /^(register_deposit|relay_fee|refund_precommitment|deadline_ms)$/.test(k) ? BigInt(x) : x]));

// shapes.ts as a module: its types stripped, loaded from a data URL, so it may import nothing
export async function load(text) {
  if (/^\s*(import|export\s+\*|export\s+\{[^}]*\}\s+from)\b/m.test(text)) throw new Error("shapes.ts imports another module");
  const js = stripTypeScriptTypes(text);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

// every object reachable from the module's exports
function* walk(v, seen = new Set()) {
  if (v === null || typeof v !== "object" || seen.has(v)) return;
  seen.add(v);
  yield v;
  for (const x of Object.values(v)) yield* walk(x, seen);
}

export async function checkFiles({ shapes, vectors }) {
  const lines = [];
  const say = (ok, what) => (lines.push(`${ok ? "ok " : "BAD"} ${what}`), ok);
  let S;
  try {
    S = await load(shapes);
  } catch (e) {
    say(false, `shapes.ts loads as one module: ${String(e.message).split("\n")[0]}`);
    return { ok: false, lines };
  }
  const results = [say(true, "shapes.ts loads as one module with no imports")];

  // the deposit message
  let msgKeys = [];
  try {
    msgKeys = Object.keys(JSON.parse(S.depositMessage(1n, "ab.near")));
  } catch (e) {
    msgKeys = [`error: ${e.message}`];
  }
  const fields = JSON.stringify(S.DEPOSIT_MESSAGE_FIELDS);
  results.push(say(fields === '["precommitment","depositor"]' && JSON.stringify(msgKeys) === fields,
    `the deposit message has exactly two fields: DEPOSIT_MESSAGE_FIELDS ${fields}, depositMessage() writes ${JSON.stringify(msgKeys)}`));

  // the carrier
  const signers = S.DEPOSIT_SIGNERS ?? {};
  const ids = Object.keys(signers);
  const carriers = ids.map((id) => `${id} ${signers[id]?.method} on ${signers[id]?.receiver_id}${signers[id]?.signed_by_kit === true ? "" : " (not signed by the kit)"}`);
  const okIds = JSON.stringify(ids) === '["U","R","V"]' && ids.every((id) => signers[id]?.method === "ft_transfer_call" && signers[id]?.receiver_id === "TOKEN" && signers[id]?.signed_by_kit === true);
  const signedWithdraws = [];
  for (const [name, v] of Object.entries(S)) for (const o of walk(v)) if (o.method === "ft_withdraw" && o.signed_by_kit !== false) signedWithdraws.push(name);
  results.push(say(okIds && signedWithdraws.length === 0,
    `the carrier: ${carriers.join("; ")}; shapes that sign an ft_withdraw: ${signedWithdraws.length ? [...new Set(signedWithdraws)].join(", ") : "none"}`));

  // the setup files
  const got = (S.SETUP_FILES ?? []).map((f) => [f.path, f.sha256]);
  const diff = SETUP_SHA256.filter(([p, h], i) => got[i]?.[0] !== p || got[i]?.[1] !== h).map(([p]) => p);
  results.push(say(got.length === 6 && diff.length === 0, `the six setup-file sha256 values equal vault.md 2.6${diff.length ? `; differ: ${diff.join(", ")}` : got.length !== 6 ? `; ${got.length} listed` : ""}`));

  // the vectors
  let V;
  try {
    V = JSON.parse(vectors);
  } catch (e) {
    results.push(say(false, `vault-v1.json parses: ${e.message}`));
    return { ok: false, lines };
  }
  const order = JSON.stringify((S.CONTEXT_FIELDS ?? []).map(([n]) => n));
  results.push(say(order === JSON.stringify(CONTEXT_ORDER), `the context order in shapes.ts: ${order}`));
  const bad = [];
  const one = (kind, i, v, own, theirs, value) => {
    const k = keccak(own);
    const okOwn = own.toString("hex") === v.preimage_hex && k.toString("hex") === v.keccak_hex && field(k).toString() === v[value];
    let okTheirs = false;
    try {
      okTheirs = Buffer.from(theirs()).toString("hex") === own.toString("hex");
    } catch {}
    if (!okOwn) bad.push(`${kind} ${i + 1} does not recompute`);
    if (!okTheirs) bad.push(`${kind} ${i + 1}: shapes.ts makes other bytes`);
  };
  (V.scope ?? []).forEach((v, i) => one("scope", i, v, scopeBytes(v), () => S.scopePreimage(v.vault, v.asset), "scope"));
  (V.label ?? []).forEach((v, i) => one("label", i, v, labelBytes(v), () => S.labelPreimage(BigInt(v.scope), BigInt(v.nonce)), "label"));
  (V.context ?? []).forEach((v, i) => one("context", i, v, contextBytes(v), () => S.contextPreimage(asNumbers(v.input), BigInt(v.scope)), "context"));
  const n = [V.scope?.length ?? 0, V.label?.length ?? 0, V.context?.length ?? 0];
  results.push(say(bad.length === 0 && n[0] + n[1] + n[2] === 50,
    `${n[0]} scope, ${n[1]} label and ${n[2]} context vectors recompute (own Borsh and Keccak-256, big-endian mod p), shapes.ts making the same bytes${bad.length ? `; ${bad.slice(0, 4).join("; ")}${bad.length > 4 ? `; and ${bad.length - 4} more` : ""}` : ""}`));
  return { ok: results.every(Boolean), lines };
}

export async function read(ref, fetchFn = fetch) {
  const out = {};
  for (const [k, path] of Object.entries(FILES)) {
    const url = `https://raw.githubusercontent.com/${REPO}/${ref}/${path}`;
    const r = await fetchFn(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    out[k] = await r.text();
  }
  return out;
}

// refs: main, then the 06:00Z tag; every ref must pass
export async function check({ refs = ["main"], files }) {
  const lines = [];
  let ok = true;
  for (const ref of refs) {
    const r = await checkFiles(files[ref]);
    for (const l of r.lines) lines.push(`${ref}: ${l}`);
    ok &&= r.ok;
  }
  return { ok, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  // Node marks stripTypeScriptTypes experimental; its one warning says nothing about the result
  process.removeAllListeners("warning");
  try {
    const refs = ["main", ...(opt("--tag") ? [opt("--tag")] : [])];
    const files = {};
    for (const ref of refs) files[ref] = await read(ref);
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(files, null, 1) + "\n");
    const r = await check({ refs, files });
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
