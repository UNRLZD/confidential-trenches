#!/usr/bin/env node
// Live check of card kit-freeze-vault: the vault's frozen shapes as the public repo serves them. For each ref (main,
// then the Nov 1 06:00Z tag kit-v1 when given) it reads packages/kit/src/vault/shapes.ts and
// packages/kit/test/vectors/vault-v1.json from GitHub and checks, in a sandboxed child (below):
//   - shapes.ts loads as one module with no static import (its types stripped by Node);
//   - every data export equals the values pinned below from the vault paper (research main ffcba5e): the constants
//     (2.2), the fields, the deposit message and its carrier for U, R and V (2.5.1, 7.1), the ft_withdraw path the kit
//     never signs, the calls (2.3, 2.5.2-2.5.5), the proof signals, the events and their field lists (7.1; the CO's call:
//     data is an array) and the six setup-file sha256 values (2.6, vault.md:522-527), since this repo carries no papers;
//   - every function behaves as the paper says on fixed cases, the attached NEAR and the backstop computed here from
//     the paper's numbers;
//   - the 50 vectors recompute with this check's own Borsh and Keccak-256 (read big-endian, mod p) in the paper's 7.1
//     order, shapes.ts's encoders make the same bytes, vaultContextInput reads each request to them, and
//     vaultScopeOf, vaultLabelOf and vaultContextOf give each vector's value.
// The fetched file is code. It runs only in a child `node --permission` that may read this one file and nothing
// else, with no fs write, child process, worker or addon. The child prints its lines and its verdict behind a fresh
// random nonce it reads before loading the file, so an early exit or a forged "PASS" from the file is a FAIL.
// Nothing here imports the kit: the encoders below are written from the paper, apart from shapes.ts's.
//   node scripts/live-checks/kit-freeze-vault.mjs [--tag <tag>] [--record <file>]   PASS exit 0, FAIL exit 1, error exit 2
// --record writes the files the run read to <file> ({ref: {shapes: [lines], vectors: [lines]}}), so the check's test
// can replay them.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, realpathSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const KEY = "kit-freeze-vault";
const SELF = fileURLToPath(import.meta.url);
export const REPO = "UNRLZD/confidential-trenches";
export const FILES = { shapes: "packages/kit/src/vault/shapes.ts", vectors: "packages/kit/test/vectors/vault-v1.json" };
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const E19 = 10n ** 19n;
const U128 = (1n << 128n) - 1n;

// vault.md 7.1 (l.1259) and 2.5.2 row 3: the context's Borsh order
export const CONTEXT_ORDER = ["processor", "recipient", "register_deposit", "fee_recipient", "relay_fee", "refund_precommitment", "deadline_ms", "salt"];

// Every data export of shapes.ts, as the paper fixes it (bigints written as "<n>n").
const CARRIER = {
  signed_as: "NEP-366 DelegateAction", sent_by: "relayer", receiver_id: "TOKEN", method: "ft_transfer_call",
  args: ["receiver_id", "amount", "msg"], deposit_yocto: "1n", gas_tgas: 180, signed_by_kit: true,
};
export const PINNED = {
  VAULT_FIELD_P: `${P}n`,
  VAULT_FIELD_Q: `${Q}n`,
  VAULT_CONSTANTS: {
    TOKEN: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", // gitleaks:allow (a public account id)
    MAX_TREE_DEPTH: 32, MIN_DEPOSIT: "1000000n", MAX_RELAY_FEE_BPS: 5000, PAGE_MAX: 1000, INTENTS: "intents.near",
    GAS_FT_TRANSFER_TGAS: 15, GAS_STORAGE_DEPOSIT_TGAS: 10, GAS_ON_PAYOUT_TGAS: 30, DEPOSIT_STORAGE_BYTES: 756,
    REFUND_RESERVE_BYTES: 389,
  },
  VAULT_STORAGE_BYTE_COST: `${E19}n`,
  VAULT_TOKEN_CODE_HASH: "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q", // gitleaks:allow (a public code hash)
  VAULT_SCOPE_TAG: "blindfill-vault-v1",
  VAULT_NOTE_HASHES: { precommitment: ["nullifier", "secret"], commitment: ["value", "label", "precommitment"], nullifierHash: ["nullifier"] },
  VAULT_DEPOSIT_MESSAGE_FIELDS: ["precommitment", "depositor"],
  VAULT_DEPOSIT_MESSAGE_MAX_BYTES: 1024,
  VAULT_DEPOSIT_CARRIER: CARRIER,
  VAULT_DEPOSIT_SIGNERS: { U: CARRIER, R: CARRIER, V: CARRIER },
  VAULT_ALSO_ACCEPTS: [{ sender: "intents.near", method: "ft_withdraw", signed_by_kit: false }],
  VAULT_STORAGE_PREPAY: { method: "storage_prepay", args: ["precommitment"], min_bytes: 756, bytes_when_a_tree_may_grow: 904 },
  VAULT_DEPOSIT_PRECONDITIONS: [
    "storage_prepay(precommitment) has landed with at least min_bytes × VAULT_STORAGE_BYTE_COST attached",
    "TOKEN.storage_balance_of(vault) is not null (the vault is registered on the token)",
    "TOKEN is not halted, and its code hash equals VAULT_TOKEN_CODE_HASH",
  ],
  VAULT_CONTEXT_FIELDS: [["processor", "account"], ["recipient", "account"], ["register_deposit", "u128"], ["fee_recipient", "account"], ["relay_fee", "u128"], ["refund_precommitment", "u256be"], ["deadline_ms", "u64"], ["salt", "bytes16"]],
  VAULT_WITHDRAW: { method: "withdraw", args: ["withdrawal", "proof", "public_signals"], storage_bytes: 710, tree_growth_bytes: 148, gas_tgas: 300 },
  VAULT_ON_PAYOUT: { method: "on_payout", args: ["spend_index", "to_recipient", "fee"], private: true, results: ["recipient part", "fee part"] },
  VAULT_SETTLE: { method: "settle", args: ["nullifier_hash"], caller: "anyone" },
  VAULT_RAGEQUIT: { method: "ragequit", args: ["proof", "public_signals", "register_deposit", "refund_precommitment"], caller: "the deposit's depositor", storage_bytes: 475 },
  VAULT_WITHDRAW_SIGNALS: ["newCommitmentHash", "existingNullifierHash", "withdrawnValue", "stateRoot", "stateTreeDepth", "ASPRoot", "ASPTreeDepth", "context"],
  VAULT_RAGEQUIT_SIGNALS: ["commitment", "nullifierHash", "value", "label"],
  VAULT_EVENT_STANDARD: "blindfill-vault",
  VAULT_EVENT_VERSION: "1.0.0",
  VAULT_EVENT_DATA: "array",
  VAULT_EVENTS: {
    leaf_inserted: ["tree", "index", "leaf", "root"],
    deposited: ["depositor", "commitment", "label", "value", "precommitment"],
    storage_prepaid: ["precommitment", "payer", "amount"],
    withdrawn: ["processor", "value", "spent_nullifier", "new_commitment"],
    withdrawal_relayed: ["relayer", "recipient", "amount", "fee", "refund_precommitment"],
    ragequit: ["ragequitter", "commitment", "label", "value"],
    payout: ["nullifier_hash", "delivered", "returned"],
    refund_inserted: ["nullifier_hash", "commitment", "label", "value"],
  },
  // vault.md 2.6 (l.522-527): Privacy Pools v1.3.0's circuit and key files
  VAULT_SETUP_FILES: [
    { path: "build/withdraw/withdraw_js/withdraw.wasm", bytes: 2607967, sha256: "36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10" },
    { path: "trusted-setup/final-keys/withdraw.zkey", bytes: 17793015, sha256: "2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677" }, // gitleaks:allow (a public sha256 pin)
    { path: "trusted-setup/final-keys/withdraw.vkey", bytes: 4208, sha256: "666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e" }, // gitleaks:allow (a public sha256 pin)
    { path: "build/commitment/commitment_js/commitment.wasm", bytes: 2380442, sha256: "254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8" },
    { path: "trusted-setup/final-keys/commitment.zkey", bytes: 901233, sha256: "494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3" }, // gitleaks:allow (a public sha256 pin)
    { path: "trusted-setup/final-keys/commitment.vkey", bytes: 3477, sha256: "7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8" }, // gitleaks:allow (a public sha256 pin)
  ],
};

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
const canon = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));
const hex = (b) => Buffer.from(b).toString("hex");

// shapes.ts as a module: its types stripped, loaded from a data URL. A static import cannot resolve from a data URL
// and is refused here first; a dynamic import or process.getBuiltinModule runs, so the child's permissions bound it.
export async function load(text) {
  if (/^\s*(import\s|export\s+\*|export\s+\{[^}]*\}\s+from)/m.test(text)) throw new Error("shapes.ts imports another module");
  const js = stripTypeScriptTypes(text);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

// the checks, run in the child on the loaded module
export async function evaluate(S, vectors) {
  const lines = [];
  const say = (ok, what) => (lines.push(`${ok ? "ok " : "BAD"} ${what}`), ok);
  const results = [say(true, "shapes.ts loads as one module with no static import")];

  // every data export, pinned
  const data = Object.fromEntries(Object.entries(S).filter(([, v]) => typeof v !== "function"));
  const missing = Object.keys(PINNED).filter((k) => !(k in data));
  const extra = Object.keys(data).filter((k) => !(k in PINNED));
  const differ = Object.keys(PINNED).filter((k) => k in data && canon(data[k]) !== canon(PINNED[k]));
  results.push(say(!missing.length && !extra.length && !differ.length,
    `${Object.keys(PINNED).length} data exports equal the paper's values${differ.length ? `; differ: ${differ.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}${extra.length ? `; not pinned: ${extra.join(", ")}` : ""}`));

  // every function, on fixed cases
  const u = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";
  const vault = "vault.confidential.unrlzd.near";
  const now = 1_793_750_000_000;
  const w = { recipient: "bob.near", register_deposit: "0", fee_recipient: "relayer.confidential.unrlzd.near", relay_fee: "30000", refund_precommitment: "7", deadline_ms: now + 600_000, salt: "0".repeat(32) };
  const throws = (f) => { try { f(); return false; } catch { return true; } };
  const fails = [];
  const want = (name, ok) => { if (!ok) fails.push(name); };
  const run = (name, f) => { try { want(name, f()); } catch (e) { fails.push(`${name} (${String(e?.message ?? e).slice(0, 60)})`); } };
  run("vaultDepositMessage writes the two fields", () => S.vaultDepositMessage(5n, u) === `{"precommitment":"5","depositor":"${u}"}`);
  run("vaultDepositMessage refuses a depositor not 64-hex", () => ["alice.near", "intents.near", vault, "0x" + "ab".repeat(20)].every((d) => throws(() => S.vaultDepositMessage(1n, d))));
  run("vaultDepositMessage refuses p", () => throws(() => S.vaultDepositMessage(P, u)));
  run("vaultPrepayYocto", () => S.vaultPrepayYocto(false) === 756n * E19 && S.vaultPrepayYocto(true) === 904n * E19);
  run("vaultWithdrawYocto", () => S.vaultWithdrawYocto(0n, 0n, false) === (710n + 389n) * E19 + 1n && S.vaultWithdrawYocto(5n, 1n, true) === (710n + 389n + 148n) * E19 + 5n + 2n);
  run("vaultRagequitYocto", () => S.vaultRagequitYocto(3n) === (475n + 389n) * E19 + 3n + 1n);
  run("vaultRelayFeeWithinBackstop", () => S.vaultRelayFeeWithinBackstop(50n, 100n) && !S.vaultRelayFeeWithinBackstop(51n, 100n) && S.vaultRelayFeeWithinBackstop(U128 / 2n, U128) && !S.vaultRelayFeeWithinBackstop(U128 / 2n + 1n, U128));
  run("vaultWithdrawalProblems passes a good request", () => S.vaultWithdrawalProblems(w, 1_000_000n, vault, now).length === 0);
  run("vaultWithdrawalProblems refuses each bad one", () => [
    [{ recipient: vault }, 1_000_000n], [{ fee_recipient: "intents.near" }, 1_000_000n], [{ relay_fee: "500001" }, 1_000_000n],
    [{ deadline_ms: now - 1 }, 1_000_000n], [{ salt: "A".repeat(32) }, 1_000_000n], [{}, 0n], [{ refund_precommitment: "0" }, 1_000_000n],
  ].every(([x, wd]) => S.vaultWithdrawalProblems({ ...w, ...x }, wd, vault, now).length > 0));
  run("vaultFieldOf reads big-endian, mod p", () => S.vaultFieldOf(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0))) === 1n && S.vaultFieldOf(new Uint8Array(32).fill(255)) === ((1n << 256n) - 1n) % P);
  run("vaultProof keeps snarkjs's order and refuses q", () => canon(S.vaultProof({ pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] })) === canon({ a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"] })
    && throws(() => S.vaultProof({ pi_a: [String(Q), "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] })));
  run("vaultDecimal and vaultAccountId refuse non-canonical forms", () => throws(() => S.vaultDecimal("01", "n")) && S.vaultDecimal("0", "n") === 0n && throws(() => S.vaultAccountId("A.near", "a")));
  results.push(say(fails.length === 0, `every function behaves as the paper says${fails.length ? `; not: ${fails.join("; ")}` : ""}`));

  // the vectors
  let V;
  try {
    V = JSON.parse(vectors);
  } catch (e) {
    results.push(say(false, `vault-v1.json parses: ${e.message}`));
    return { ok: false, lines };
  }
  const bad = [];
  const one = (kind, i, v, own, theirs, of, value) => {
    const k = keccak(own);
    if (!(hex(own) === v.preimage_hex && hex(k) === v.keccak_hex && field(k).toString() === v[value])) bad.push(`${kind} ${i + 1} does not recompute`);
    for (const [what, f] of [["shapes.ts makes other bytes", () => hex(theirs()) === hex(own)], [`its ${kind} function gives another value`, () => String(of()) === v[value]]]) {
      let ok = false;
      try { ok = f(); } catch {}
      if (!ok) bad.push(`${kind} ${i + 1}: ${what}`);
    }
  };
  const kfn = (b) => new Uint8Array(keccak(Buffer.from(b)));
  (V.scope ?? []).forEach((v, i) => one("scope", i, v, scopeBytes(v), () => S.vaultScopePreimage(v.vault, v.asset), () => S.vaultScopeOf(kfn, v.vault, v.asset), "scope"));
  (V.label ?? []).forEach((v, i) => one("label", i, v, labelBytes(v), () => S.vaultLabelPreimage(BigInt(v.scope), BigInt(v.nonce)), () => S.vaultLabelOf(kfn, BigInt(v.scope), BigInt(v.nonce)), "label"));
  (V.context ?? []).forEach((v, i) => {
    one("context", i, v, contextBytes(v), () => S.vaultContextPreimage(asNumbers(v.input), BigInt(v.scope)), () => S.vaultContextOf(kfn, asNumbers(v.input), BigInt(v.scope)), "context");
    if (BigInt(v.input.deadline_ms) <= BigInt(Number.MAX_SAFE_INTEGER)) {
      const { processor, deadline_ms, ...rest } = v.input;
      let ok = false;
      try { ok = hex(S.vaultContextPreimage(S.vaultContextInput(processor, { ...rest, deadline_ms: Number(deadline_ms) }), BigInt(v.scope))) === hex(contextBytes(v)); } catch {}
      if (!ok) bad.push(`context ${i + 1}: vaultContextInput reads the request to other bytes`);
    }
  });
  const n = [V.scope?.length ?? 0, V.label?.length ?? 0, V.context?.length ?? 0];
  results.push(say(bad.length === 0 && n[0] + n[1] + n[2] === 50,
    `${n[0]} scope, ${n[1]} label and ${n[2]} context vectors recompute (own Borsh and Keccak-256, big-endian mod p), shapes.ts's encoders, vaultContextInput and its value functions agreeing${bad.length ? `; ${bad.slice(0, 4).join("; ")}${bad.length > 4 ? `; and ${bad.length - 4} more` : ""}` : ""}`));
  return { ok: results.every(Boolean), lines };
}

// the child: read {nonce, shapes, vectors} from stdin, then load the file and judge it; every line carries the nonce
async function child() {
  const write = process.stdout.write.bind(process.stdout);
  const exit = process.exit.bind(process);
  process.removeAllListeners("warning"); // stripTypeScriptTypes is marked experimental
  let input = "";
  for await (const c of process.stdin) input += c;
  const { nonce, shapes, vectors } = JSON.parse(input);
  let r;
  try {
    r = await evaluate(await load(shapes), vectors);
  } catch (e) {
    r = { ok: false, lines: [`BAD shapes.ts loads as one module: ${String(e?.message ?? e).split("\n")[0]}`] };
  }
  write(r.lines.map((l) => `${nonce} ${l}\n`).join("") + `${nonce} ${r.ok ? "PASS" : "FAIL"}\n`, () => exit(0));
}

// one ref's files, judged in the sandboxed child
export async function checkFiles({ shapes, vectors }) {
  const nonce = randomBytes(16).toString("hex");
  const r = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${SELF}`, SELF, "--child"], {
    input: JSON.stringify({ nonce, shapes, vectors }), encoding: "utf8", timeout: 60_000, maxBuffer: 16 << 20,
  });
  const mine = (r.stdout ?? "").split("\n").filter((l) => l.startsWith(`${nonce} `)).map((l) => l.slice(nonce.length + 1));
  const verdict = mine.at(-1);
  const lines = mine.slice(0, -1);
  if (r.status !== 0 || (verdict !== "PASS" && verdict !== "FAIL")) {
    lines.push(`BAD the sandboxed run gave no verdict (exit ${r.status ?? r.signal}${r.stderr ? `: ${r.stderr.trim().split("\n").at(-1).slice(0, 120)}` : ""})`);
    return { ok: false, lines };
  }
  return { ok: verdict === "PASS", lines };
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

// a recording keeps each file as an array of its lines, so a scan reads it line by line
export const toLines = (files) => Object.fromEntries(Object.entries(files).map(([ref, f]) => [ref, { shapes: f.shapes.split("\n"), vectors: f.vectors.split("\n") }]));
export const fromLines = (files) => Object.fromEntries(Object.entries(files).map(([ref, f]) => [ref, { shapes: f.shapes.join("\n"), vectors: f.vectors.join("\n") }]));

if (process.argv[1] && realpathSync(process.argv[1]) === SELF) {
  const a = process.argv.slice(2);
  if (a[0] === "--child") {
    await child();
  } else {
    const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
    try {
      const refs = ["main", ...(opt("--tag") ? [opt("--tag")] : [])];
      const files = {};
      for (const ref of refs) files[ref] = await read(ref);
      if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(toLines(files), null, 1) + "\n");
      const r = await check({ refs, files });
      for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
      console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
      process.exit(r.ok ? 0 : 1);
    } catch (e) {
      console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
      process.exit(2);
    }
  }
}
