#!/usr/bin/env node
// Live check of card kit-freeze-vault: the vault's frozen shapes as the public repo serves them. For each ref (main,
// then the Nov 1 06:00Z tag when given) it reads packages/kit/src/vault/shapes.ts and
// packages/kit/test/vectors/vault-v1.json from GitHub and checks:
//   - shapes.ts loads as one module with no imports (its types stripped by Node);
//   - the deposit message has exactly two fields, precommitment then depositor, and depositMessage() writes only them;
//   - U, R and V each move money in by their own ft_transfer_call on TOKEN, and no shape signs an ft_withdraw;
//   - the six setup-file sha256 values equal the vault paper's 2.6 (vault.md:522-527, pinned below, since this repo
//     carries no papers);
//   - the 50 vectors recompute with this check's own Borsh and Node's keccak-256 (read big-endian, mod p) in the
//     paper's 7.1 order, and shapes.ts's own encoders make the same bytes.
// Nothing here imports the kit: the encoders below are written from the paper, apart from shapes.ts's.
//   node scripts/live-checks/kit-freeze-vault.mjs [--tag <tag>] [--record <file>]   PASS exit 0, FAIL exit 1, error exit 2
// --record writes the files the run read to <file> ({ref: {shapes, vectors}}), so the check's test can replay them.
import { createHash } from "node:crypto";
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
const keccak = (b) => createHash("keccak-256").update(b).digest();
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
    `${n[0]} scope, ${n[1]} label and ${n[2]} context vectors recompute (own Borsh, keccak-256 big-endian mod p), shapes.ts making the same bytes${bad.length ? `; ${bad.slice(0, 4).join("; ")}${bad.length > 4 ? `; and ${bad.length - 4} more` : ""}` : ""}`));
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
