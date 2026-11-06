#!/usr/bin/env node
// Live check of card kit-freeze-vault: the vault's frozen shapes as the public repo serves them. For each ref (main,
// then the Nov 1 06:00Z tag kit-v1 when given) it reads packages/kit/src/vault/shapes.ts and
// packages/kit/test/vectors/vault-v1.json from GitHub and checks, in a sandboxed child (below):
//   - shapes.ts loads as one module with no static import (its types stripped by Node);
//   - every data export equals the values pinned below from the vault paper (research main ffcba5e): the constants
//     (2.2), the fields, the deposit message and its carrier for U, R and V (2.5.1, 7.1), the ft_withdraw path the kit
//     never signs, the calls (2.3, 2.5.2-2.5.5), the proof signals, the events and their field lists (7.1; decided:
//     data is an array), since this repo carries no papers (the setup files' pins are ZK_SETUP_FILES's, checked by
//     vault-setup-files's own live check);
//   - every function behaves as the paper says on fixed cases (the depositor in every refused form, upper case
//     included), the attached NEAR and the backstop computed here from the paper's numbers;
//   - the 50 vectors recompute with this check's own Borsh and Keccak-256 (read big-endian, mod p) in the paper's 7.1
//     order, shapes.ts's encoders make the same bytes, vaultContextInput reads each request to them, and
//     vaultScopeOf, vaultLabelOf and vaultContextOf give each vector's value.
// The fetched file is code. It runs only in a child `node --permission` with an empty environment, which may read this
// one file and nothing else, with no fs write, child process, worker or addon. The child judges nothing: it loads the
// file, makes the calls this process asks for and prints one line, a fresh random nonce and a JSON report of the data
// exports and the answers. This process never loads the file and makes every comparison and the verdict.
// What the child defends: before the file loads it takes every builtin its report code uses (Object.keys,
// Array.isArray, ArrayBuffer.isView, JSON.stringify, Reflect.apply, BigInt, Uint8Array, TextEncoder's encode,
// process.exit and fs.writeSync), and it writes the line to fd 1 with that writeSync, never through process.stdout.
// So a file that replaces a prototype method or JSON.stringify, or process.stdout's write or _write, cannot change the
// report. A file can still make the run fail (throw, hang, exit, print, close fd 1): a child that exits early, exits
// non-zero, times out or prints any other line is a FAIL.
// Pins per ref: main is held to PINNED, the values as they stand; the freeze tag kit-v1 to the same with the pins the
// vault reviews moved after Nov 1 put back as kit-v1 froze them (MOVED_SINCE_KIT_V1, each naming its review item), so
// each ref is held to its own values and `--tag kit-v1` still passes.
// Nothing here imports the kit: the encoders below are written from the paper, apart from shapes.ts's.
//   node scripts/live-checks/kit-freeze-vault.mjs [--tag <tag>] [--record <file>]   PASS exit 0, FAIL exit 1, error exit 2
// --record writes the files the run read to <file> ({ref: {shapes: [lines], vectors: [lines]}}), so the check's test
// can replay them.
// Runs: once, the kit freeze: the vault's shapes on GitHub at the freeze tag, not what a host serves
if (!process.argv.includes("--child")) await import("../net-window.mjs"); // the sandboxed child may read this one file only
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, writeSync, realpathSync } from "node:fs";
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
  VAULT_WITHDRAW: { method: "withdraw", args: ["withdrawal", "proof", "public_signals"], storage_bytes: 791, tree_growth_bytes: 148, gas_tgas: 300 },
  VAULT_ON_PAYOUT: { method: "on_payout", args: ["spend_index", "to_recipient", "fee"], private: true, results: ["payout"] },
  VAULT_SETTLE: { method: "settle", args: ["nullifier_hash"], caller: "anyone" },
  VAULT_RAGEQUIT: { method: "ragequit", args: ["proof", "public_signals", "register_deposit", "refund_precommitment"], caller: "the deposit's depositor", storage_bytes: 556 },
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

// ---- the parent judges; the child only reports ----
// The calls the child makes: [group, function name, arguments, the parent's test of its answer]. An argument is plain
// JSON, with {$big}, {$bytes}, {$keccak} (the child's own Keccak-256) and {$ret: id} (an earlier call's raw answer).
// An answer comes back as {v} (bigints as {$big}, bytes as {$bytes}) or {t: message} when the call threw.
const B = (x) => ({ $big: `${x}` });
const KECCAK = { $keccak: true };
const threw = (r) => "t" in r;
const is = (want) => (r) => !threw(r) && canon(r.v) === canon(want);
const nonEmpty = (r) => !threw(r) && Array.isArray(r.v) && r.v.length > 0;
/**
 * The pins the vault reviews and cards moved after the kit-v1 freeze (Nov 1 06:00Z): each with its review item or card
 * and the value kit-v1 holds. main is held to PINNED; kit-v1 to PINNED with these put back (pinsFor, fixedCalls).
 */
export const MOVED_SINCE_KIT_V1 = {
  // (in PINNED's order) withdraw reserves its refund precommitment in precommitments: 81 B more
  VAULT_WITHDRAW: { card: "vault-refund-precommit-reserve", value: { method: "withdraw", args: ["withdrawal", "proof", "public_signals"], storage_bytes: 710, tree_growth_bytes: 148, gas_tgas: 300 } },
  // A-01: the vault pays out in one receipt on the token, all or none, so on_payout reads one result
  VAULT_ON_PAYOUT: { review: "A-01", value: { method: "on_payout", args: ["spend_index", "to_recipient", "fee"], private: true, results: ["recipient part", "fee part"] } },
  // ragequit reserves its refund precommitment too (card vault-refund-precommit-reserve)
  VAULT_RAGEQUIT: { card: "vault-refund-precommit-reserve", value: { method: "ragequit", args: ["proof", "public_signals", "register_deposit", "refund_precommitment"], caller: "the deposit's depositor", storage_bytes: 475 } },
};
/** The fixed call moved after kit-v1 (R-01: the vault refuses precommitment 0), by its name on main. */
export const R01_CALL = "vaultDepositMessage refuses 0 (vault review R-01)";
/** The data pins one ref is held to. */
export const pinsFor = (ref) =>
  ref === "kit-v1" ? { ...PINNED, ...Object.fromEntries(Object.entries(MOVED_SINCE_KIT_V1).map(([k, m]) => [k, m.value])) } : PINNED;

function fixedCalls(ref = "main") {
  const u = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";
  const vault = "vault.confidential.unrlzd.near";
  const now = 1_793_750_000_000;
  const w = { recipient: "bob.near", register_deposit: "0", fee_recipient: "relayer.confidential.unrlzd.near", relay_fee: "30000", refund_precommitment: "7", deadline_ms: now + 600_000, salt: "0".repeat(32) };
  const snark = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] };
  // the attached NEAR from the ref's own pins (kit-v1: 710 and 475; main: 791 and 556, card vault-refund-precommit-reserve)
  const withdrawBytes = BigInt(pinsFor(ref).VAULT_WITHDRAW.storage_bytes);
  const ragequitBytes = BigInt(pinsFor(ref).VAULT_RAGEQUIT.storage_bytes);
  const out = [
    ["vaultDepositMessage writes the two fields", "vaultDepositMessage", [B(5n), u], is(`{"precommitment":"5","depositor":"${u}"}`)],
    ["vaultDepositMessage refuses p", "vaultDepositMessage", [B(P), u], threw],
    ref === "kit-v1"
      ? ["vaultDepositMessage writes 0, as kit-v1 froze it (vault review R-01 moved it to a refusal)", "vaultDepositMessage", [B(0n), u], is(`{"precommitment":"0","depositor":"${u}"}`)]
      : [R01_CALL, "vaultDepositMessage", [B(0n), u], threw],
    ["vaultPrepayYocto", "vaultPrepayYocto", [false], is(756n * E19)],
    ["vaultPrepayYocto", "vaultPrepayYocto", [true], is(904n * E19)],
    ["vaultWithdrawYocto", "vaultWithdrawYocto", [B(0n), B(0n), false], is((withdrawBytes + 389n) * E19 + 1n)],
    ["vaultWithdrawYocto", "vaultWithdrawYocto", [B(5n), B(1n), true], is((withdrawBytes + 389n + 148n) * E19 + 5n + 2n)],
    ["vaultRagequitYocto", "vaultRagequitYocto", [B(3n)], is((ragequitBytes + 389n) * E19 + 3n + 1n)],
    ["vaultRelayFeeWithinBackstop", "vaultRelayFeeWithinBackstop", [B(50n), B(100n)], is(true)],
    ["vaultRelayFeeWithinBackstop", "vaultRelayFeeWithinBackstop", [B(51n), B(100n)], is(false)],
    ["vaultRelayFeeWithinBackstop", "vaultRelayFeeWithinBackstop", [B(U128 / 2n), B(U128)], is(true)],
    ["vaultRelayFeeWithinBackstop", "vaultRelayFeeWithinBackstop", [B(U128 / 2n + 1n), B(U128)], is(false)],
    ["vaultWithdrawalProblems passes a good request", "vaultWithdrawalProblems", [w, B(1_000_000n), vault, now], is([])],
    ["vaultFieldOf reads big-endian, mod p", "vaultFieldOf", [{ $bytes: "00".repeat(31) + "01" }], is(1n)],
    ["vaultFieldOf reads big-endian, mod p", "vaultFieldOf", [{ $bytes: "ff".repeat(32) }], is(((1n << 256n) - 1n) % P)],
    ["vaultProof keeps snarkjs's order and refuses q", "vaultProof", [snark], is({ a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"] })],
    ["vaultProof keeps snarkjs's order and refuses q", "vaultProof", [{ ...snark, pi_a: [String(Q), "2", "1"] }], threw],
    ["vaultDecimal and vaultAccountId refuse non-canonical forms", "vaultDecimal", ["01", "n"], threw],
    ["vaultDecimal and vaultAccountId refuse non-canonical forms", "vaultDecimal", ["0", "n"], is(0n)],
    ["vaultDecimal and vaultAccountId refuse non-canonical forms", "vaultAccountId", ["A.near", "a"], threw],
  ];
  for (const d of ["alice.near", "intents.near", vault, "0x" + "ab".repeat(20), u.toUpperCase(), u.slice(0, 63) + "A"]) {
    out.push(["vaultDepositMessage refuses a depositor not lowercase 64-hex", "vaultDepositMessage", [B(1n), d], threw]);
  }
  for (const [x, wd] of [[{ recipient: vault }, 1_000_000n], [{ fee_recipient: "intents.near" }, 1_000_000n], [{ relay_fee: "500001" }, 1_000_000n],
    [{ deadline_ms: now - 1 }, 1_000_000n], [{ salt: "A".repeat(32) }, 1_000_000n], [{}, 0n], [{ refund_precommitment: "0" }, 1_000_000n]]) {
    out.push(["vaultWithdrawalProblems refuses each bad one", "vaultWithdrawalProblems", [{ ...w, ...x }, B(wd), vault, now], nonEmpty]);
  }
  return out;
}

// the vectors' calls: each vector's bytes and value through shapes.ts, and each JSON request through vaultContextInput
function vectorCalls(V) {
  const out = [];
  const bytes = (b) => is({ $bytes: hex(b) });
  const value = (x) => is(BigInt(x));
  (V.scope ?? []).forEach((v, i) => {
    out.push([`scope ${i + 1}: shapes.ts makes other bytes`, "vaultScopePreimage", [v.vault, v.asset], bytes(scopeBytes(v))]);
    out.push([`scope ${i + 1}: its scope function gives another value`, "vaultScopeOf", [KECCAK, v.vault, v.asset], value(v.scope)]);
  });
  (V.label ?? []).forEach((v, i) => {
    out.push([`label ${i + 1}: shapes.ts makes other bytes`, "vaultLabelPreimage", [B(v.scope), B(v.nonce)], bytes(labelBytes(v))]);
    out.push([`label ${i + 1}: its label function gives another value`, "vaultLabelOf", [KECCAK, B(v.scope), B(v.nonce)], value(v.label)]);
  });
  (V.context ?? []).forEach((v, i) => {
    const c = Object.fromEntries(Object.entries(v.input).map(([k, x]) => [k, /^(register_deposit|relay_fee|refund_precommitment|deadline_ms)$/.test(k) ? B(x) : x]));
    out.push([`context ${i + 1}: shapes.ts makes other bytes`, "vaultContextPreimage", [c, B(v.scope)], bytes(contextBytes(v))]);
    out.push([`context ${i + 1}: its context function gives another value`, "vaultContextOf", [KECCAK, c, B(v.scope)], value(v.context)]);
    if (BigInt(v.input.deadline_ms) <= BigInt(Number.MAX_SAFE_INTEGER)) {
      const { processor, deadline_ms, ...rest } = v.input;
      out.push([`context ${i + 1}: vaultContextInput reads the request to other bytes`, "vaultContextInput", [processor, { ...rest, deadline_ms: Number(deadline_ms) }], () => true, `in${i}`]);
      out.push([`context ${i + 1}: vaultContextInput reads the request to other bytes`, "vaultContextPreimage", [{ $ret: `in${i}` }, B(v.scope)], bytes(contextBytes(v))]);
    }
  });
  return out;
}

// an answer from the child, back to values: {$big} to a bigint, {$bytes} kept as {$bytes} for comparison
function decode(x) {
  if (Array.isArray(x)) return x.map(decode);
  if (x && typeof x === "object") {
    if (typeof x.$big === "string" && Object.keys(x).length === 1) return BigInt(x.$big);
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, decode(v)]));
  }
  return x;
}

// one ref's files: the child loads shapes.ts and reports; this process, which never loads it, judges
// The child gets env: {}. macOS's CoreFoundation still sets this one name in every new process, whatever its parent
// passes (a text-encoding id, never a secret); any other name the child sees is a FAIL.
const OS_MADE_ENV = ["__CF_USER_TEXT_ENCODING"];

export async function checkFiles({ shapes, vectors }, ref = "main") {
  const lines = [];
  const say = (ok, what) => (lines.push(`${ok ? "ok " : "BAD"} ${what}`), ok);
  let V;
  try {
    V = JSON.parse(vectors);
  } catch (e) {
    say(false, `vault-v1.json parses: ${e.message}`);
    return { ok: false, lines };
  }
  const fixed = fixedCalls(ref);
  const PINNED = pinsFor(ref);
  const vec = vectorCalls(V);
  const all = [...fixed, ...vec];
  const calls = all.map(([, fn, args, , id], i) => [id ?? `c${i}`, fn, args]);
  const nonce = randomBytes(16).toString("hex");
  const r = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${SELF}`, SELF, "--child"], {
    input: JSON.stringify({ nonce, shapes, calls }), encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20, env: {},
  });
  const out = r.stdout ?? "";
  const one = out.endsWith("\n") && out.indexOf("\n") === out.length - 1 && out.startsWith(`${nonce} `);
  let rep;
  try {
    rep = one && r.status === 0 ? JSON.parse(out.slice(nonce.length + 1)) : undefined;
  } catch {}
  if (!rep) {
    const why = r.status !== 0 ? `exit ${r.status ?? r.signal}` : one ? "not JSON" : `printed ${out.split("\n").filter(Boolean).length} line(s), not its one report line`;
    say(false, `the sandboxed child gave one report (${why}${r.stderr ? `: ${r.stderr.trim().split("\n").at(-1).slice(0, 120)}` : ""})`);
    return { ok: false, lines };
  }
  if (typeof rep.error === "string") {
    say(false, `shapes.ts loads as one module: ${rep.error}`);
    return { ok: false, lines };
  }
  const seen = Array.isArray(rep.env) ? rep.env.filter((n) => !OS_MADE_ENV.includes(n)) : undefined;
  const results = [say(seen?.length === 0,
    `shapes.ts loads as one module with no static import, in a child that sees ${seen ? seen.length : "?"} environment variable(s) of this process's`)];

  // every data export, pinned
  const data = decode(rep.data ?? {});
  const missing = Object.keys(PINNED).filter((k) => !(k in data));
  const extra = Object.keys(data).filter((k) => !(k in PINNED));
  const differ = Object.keys(PINNED).filter((k) => k in data && canon(data[k]) !== canon(PINNED[k]));
  results.push(say(!missing.length && !extra.length && !differ.length,
    `${Object.keys(PINNED).length} data exports equal the paper's values${differ.length ? `; differ: ${differ.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}${extra.length ? `; not pinned: ${extra.join(", ")}` : ""}`));

  // every call's answer, judged here
  const answer = (id) => {
    const a = rep.calls?.[id];
    if (!a || typeof a !== "object") return { t: "no answer" };
    return "t" in a ? { t: String(a.t) } : { v: decode(a.v) };
  };
  const failed = (list) => [...new Set(list.filter(([, , , test], i) => {
    try {
      return !test(answer(calls[all.indexOf(list[i])][0]));
    } catch {
      return true;
    }
  }).map(([group]) => group))];
  const f1 = failed(fixed);
  results.push(say(f1.length === 0, `every function behaves as the paper says${f1.length ? `; not: ${f1.join("; ")}` : ""}`));
  const bad = [];
  for (const [kind, list] of [["scope", V.scope ?? []], ["label", V.label ?? []], ["context", V.context ?? []]]) {
    list.forEach((v, i) => {
      const own = kind === "scope" ? scopeBytes(v) : kind === "label" ? labelBytes(v) : contextBytes(v);
      const k = keccak(own);
      if (!(hex(own) === v.preimage_hex && hex(k) === v.keccak_hex && field(k).toString() === v[kind])) bad.push(`${kind} ${i + 1} does not recompute`);
    });
  }
  bad.push(...failed(vec));
  const n = [V.scope?.length ?? 0, V.label?.length ?? 0, V.context?.length ?? 0];
  results.push(say(bad.length === 0 && n[0] + n[1] + n[2] === 50,
    `${n[0]} scope, ${n[1]} label and ${n[2]} context vectors recompute (own Borsh and Keccak-256, big-endian mod p), shapes.ts's encoders, vaultContextInput and its value functions agreeing${bad.length ? `; ${bad.slice(0, 4).join("; ")}${bad.length > 4 ? `; and ${bad.length - 4} more` : ""}` : ""}`));
  return { ok: results.every(Boolean), lines };
}

// the child: read {nonce, shapes, calls}, decode the calls, take every builtin it uses, then load the file, make the
// calls and print one line: the nonce and a JSON report {env, data, calls} (or {error}). It compares nothing. The line
// goes straight to fd 1 with fs.writeSync taken before the load, never through process.stdout, whose write and _write
// the file can replace.
async function child() {
  const wsync = writeSync;
  const utf8 = TextEncoder.prototype.encode.bind(new TextEncoder());
  const exit = process.exit.bind(process);
  const keysOf = Object.keys;
  const isArray = Array.isArray;
  const isView = ArrayBuffer.isView;
  const quote = JSON.stringify;
  const apply = Reflect.apply;
  const Big = BigInt;
  const U8 = Uint8Array;
  const HEX = "0123456789abcdef";
  const env = keysOf(process.env);
  process.removeAllListeners("warning"); // stripTypeScriptTypes is marked experimental
  let input = "";
  for await (const c of process.stdin) input += c;
  const { nonce, shapes, calls } = JSON.parse(input);
  const kf = (b) => new U8(keccak256(b));
  const ret = Object.create(null);
  const dec = (x) => {
    if (isArray(x)) {
      const a = [];
      for (let i = 0; i < x.length; i++) a[i] = dec(x[i]);
      return a;
    }
    if (x && typeof x === "object") {
      if (typeof x.$big === "string") return Big(x.$big);
      if (typeof x.$bytes === "string") {
        const b = new U8(x.$bytes.length / 2);
        for (let i = 0; i < b.length; i++) b[i] = parseInt(x.$bytes.slice(2 * i, 2 * i + 2), 16);
        return b;
      }
      if (x.$keccak === true) return kf;
      if (typeof x.$ret === "string") return { $ret: x.$ret };
      const o = {};
      const ks = keysOf(x);
      for (let i = 0; i < ks.length; i++) o[ks[i]] = dec(x[ks[i]]);
      return o;
    }
    return x;
  };
  const todo = [];
  for (let i = 0; i < calls.length; i++) todo[i] = [calls[i][0], calls[i][1], dec(calls[i][2])];
  const enc = (v) => {
    if (v === null || v === undefined) return "null";
    const t = typeof v;
    if (t === "bigint") return '{"$big":"' + v + '"}';
    if (t === "string") return quote(v);
    if (t === "number" || t === "boolean") return "" + v;
    if (t === "function") return '{"$fn":true}';
    if (isView(v)) {
      let h = "";
      for (let i = 0; i < v.length; i++) h += HEX[v[i] >> 4] + HEX[v[i] & 15];
      return '{"$bytes":"' + h + '"}';
    }
    if (isArray(v)) {
      let s = "[";
      for (let i = 0; i < v.length; i++) s += (i ? "," : "") + enc(v[i]);
      return s + "]";
    }
    const ks = keysOf(v);
    let s = "{";
    for (let i = 0; i < ks.length; i++) s += (i ? "," : "") + quote(ks[i]) + ":" + enc(v[ks[i]]);
    return s + "}";
  };
  let report;
  try {
    const S = await load(shapes);
    const names = keysOf(S);
    let data = "";
    for (let i = 0; i < names.length; i++) if (typeof S[names[i]] !== "function") data += (data ? "," : "") + quote(names[i]) + ":" + enc(S[names[i]]);
    let out = "";
    for (let i = 0; i < todo.length; i++) {
      const [id, fn, args] = todo[i];
      for (let j = 0; j < args.length; j++) if (args[j] && typeof args[j] === "object" && typeof args[j].$ret === "string") args[j] = ret[args[j].$ret];
      let a;
      try {
        const v = apply(S[fn], undefined, args);
        ret[id] = v;
        a = '{"v":' + enc(v) + "}";
      } catch (e) {
        a = '{"t":' + quote("" + (e && e.message)) + "}";
      }
      out += (out ? "," : "") + quote(id) + ":" + a;
    }
    report = '{"env":' + enc(env) + ',"data":{' + data + '},"calls":{' + out + "}}";
  } catch (e) {
    report = '{"error":' + quote(("" + (e && e.message)).split("\n")[0]) + "}";
  }
  const bytes = utf8(nonce + " " + report + "\n");
  for (let off = 0; off < bytes.length; ) {
    try {
      off += wsync(1, bytes, off, bytes.length - off);
    } catch (e) {
      if (!e || e.code !== "EAGAIN") throw e; // a full non-blocking pipe: write the rest when the parent has read
    }
  }
  exit(0);
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
    const r = await checkFiles(files[ref], ref);
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
