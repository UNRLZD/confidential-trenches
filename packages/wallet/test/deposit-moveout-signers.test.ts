// What moveout.ts lets a caller sign (card signers-own-bytes, merge note M366 (2), reviews 2 and 3): no export signs
// calls or bytes its caller hands it. The rule is the module's own, at run time: a check (checkMoveCalls) reads a deep
// copy, and the copy it passed is sealed (U, the receiver and the calls, deep-frozen, in a module-private set); the
// module-private signer signs only a sealed move, as it holds it. The tests here hold that, and pin the two things the
// run-time rule rests on in the source: the signer is never exported or handed out, and the module signs with
// @noble/curves' ed25519 alone, imported once by that name, its sign called only inside the signer.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import * as moveout from "../src/deposit/moveout.ts";

const FILE = new URL("../src/deposit/moveout.ts", import.meta.url);
const SRC = readFileSync(FILE, "utf8");

/** The module with its private signer exported, loaded from a copy: the signer reached as the module itself calls it. */
async function probe(): Promise<typeof moveout & { signMoveTx: (publicKey: Uint8Array, secretKey: Uint8Array, nonce: bigint, blockHash: string, move: unknown) => { hash: string; signed: string } }> {
  const src = `${SRC.replace(/from "(\.{1,2}\/[^"]+)"/g, (_, p: string) => `from "${new URL(p, FILE).href}"`).replace(/from "([^".][^"]*)"/g, (_, p: string) => `from "${import.meta.resolve(p)}"`)}\nexport { signMoveTx };\n`;
  const dir = mkdtempSync(path.join(tmpdir(), "moveout-probe-"));
  try {
    const f = path.join(dir, "moveout-probe.ts");
    writeFileSync(f, src);
    return await import(pathToFileURL(f).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// RFC 8032 section 7.1 test 1's published key (never a wallet of anyone's); U is its implicit account
const SK = Uint8Array.from(Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"));
const PK = ed25519.getPublicKey(SK);
const U = Buffer.from(PK).toString("hex");
const TOKEN = NEAR_NETWORKS.testnet.usdc;
const TO = "a".repeat(64);
const BH = base58.encode(new Uint8Array(32).fill(7));

test("moveout.ts exports exactly these, and no signer", () => {
  assert.deepEqual(Object.keys(moveout).sort(), [
    "FINAL_TRIES",
    "GAS_PRICE_MARGIN",
    "MOVE_GAS",
    "MoveOutRefused",
    "SETTLE_BLOCKS",
    "TX_VALIDITY_BLOCKS",
    "checkMoveCalls",
    "heldOpOf",
    "moveCalls",
    "moveOutHeld",
    "moveOutRpc",
    "readMoveOut",
  ]);
});

test("the signer signs only a move a check sealed (review 3): an unchecked list, a look-alike, a skipped check, a swapped receiver are refused; a sealed move is frozen", async () => {
  const m = await probe();
  const calls = m.moveCalls(TO, 5n, false, 0n);
  const sealed = m.checkMoveCalls(U, TO, TOKEN, calls, 10n, 0n);
  // a sealed move signs, U's key over exactly its bytes: U, the token as receiver, its calls
  const tx = m.signMoveTx(PK, SK, 1n, BH, sealed);
  const signed = base64.decode(tx.signed);
  const bytes = signed.subarray(0, signed.length - 65);
  assert.equal(tx.hash, base58.encode(sha256(bytes)));
  assert.ok(ed25519.verify(signed.subarray(signed.length - 64), sha256(bytes), PK));
  assert.ok(Buffer.from(bytes).includes(Buffer.from(TOKEN)) && Buffer.from(bytes).includes(Buffer.from(`"receiver_id":"${TO}"`)));
  const refused = (move: unknown, why: string) => assert.throws(() => m.signMoveTx(PK, SK, 1n, BH, move), /not one a check of this module passed/, why);
  // an unchecked list, in the sealed shape
  refused({ signer: U, receiver: TOKEN, calls }, "an unchecked list");
  // a look-alike: the sealed move's own fields in another object, frozen too
  refused(Object.freeze({ ...sealed }), "a look-alike of a sealed move");
  refused(structuredClone(sealed), "a deep copy of a sealed move");
  // a check skipped on a branch: what that branch hands the signer was never sealed
  const fast = true;
  refused(fast ? { signer: U, receiver: TOKEN, calls } : sealed, "a check skipped on a branch");
  // the receiver swapped, in a copy: refused; in the sealed move itself: frozen
  refused({ ...sealed, receiver: "attacker.near" }, "a swapped receiver");
  assert.throws(() => Object.assign(sealed, { receiver: "attacker.near" }), TypeError);
  // the sealed move changed after its check: every level is frozen
  assert.throws(() => { (sealed.calls as unknown as unknown[]).push(sealed.calls[0]); }, TypeError);
  assert.throws(() => { (sealed.calls as unknown as unknown[]).length = 0; }, TypeError);
  assert.throws(() => { (sealed.calls.at(-1)!.args as Record<string, unknown>).amount = "9"; }, TypeError);
  // the list it was handed changed after the check: the sealed copy is not
  (calls.at(-1)!.args as Record<string, unknown>).amount = "9";
  assert.equal(sealed.calls.at(-1)!.args.amount, "5");
  // another key than the move's U
  assert.throws(() => m.signMoveTx(ed25519.getPublicKey(new Uint8Array(32).fill(1)), new Uint8Array(32).fill(1), 1n, BH, sealed), /not the move's U/);
  // a list the check refuses is never sealed
  assert.throws(() => m.checkMoveCalls(U, TO, TOKEN, m.moveCalls(TO, 50n, false, 0n), 10n, 0n), m.MoveOutRefused);
  // a seal of the real module is not one of the copy's, and the copy's are not the module's: one set per module
  refused(moveout.checkMoveCalls(U, TO, TOKEN, moveout.moveCalls(TO, 5n, false, 0n), 10n, 0n), "another module's seal");
});

// ---- the source pins the run-time rule rests on
const uncommented = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Why `source` could sign past the seal (none: it cannot): the signer handed out, or a signature made another way. */
export function signerPin(source: string): string[] {
  const src = uncommented(source);
  const why: string[] = [];
  if (!/^function signMoveTx\(/m.test(src)) why.push("no private signMoveTx");
  if (/^export\s+(?:async\s+)?function\s+signMoveTx\b|export\s*\{[^}]*\bsignMoveTx\b/m.test(src)) why.push("signMoveTx is exported");
  if ([...src.matchAll(/(?<![\w$.])signMoveTx(?![\w$])(?!\s*\()/g)].length > 0) why.push("signMoveTx is handed on as a value");
  // the curves: ed25519 alone, from @noble/curves, imported once by its own name; no other signing library
  const curves = [...src.matchAll(/^import\b[^;]*?from\s*"([^"]+)";/gm)].filter((m) => /curves|nacl|secp|schnorr|ed25519|bls|crypto|sodium|elliptic/i.test(m[1]!));
  if (curves.length !== 1 || curves[0]![0] !== 'import { ed25519 } from "@noble/curves/ed25519.js";') why.push(`the module imports a signing library other than { ed25519 } once: ${curves.map((c) => c[0]).join(" | ") || "none"}`);
  if (/\brequire\(|\bimport\(/.test(src)) why.push("the module loads code at run time");
  // every ed25519 is its sign inside signMoveTx (once) or its getPublicKey
  const body = /^function signMoveTx\([\s\S]*?\n\}\n/m.exec(src)?.[0] ?? "";
  const refs = [...src.matchAll(/(?<![\w$.])ed25519(?![\w$:])(?!\.js")/g)].map((m) => ({ at: m.index, next: src.slice(m.index + 7, m.index + 22) }));
  const importAt = src.indexOf('import { ed25519 } from "@noble/curves/ed25519.js";');
  const bodyAt = body ? src.indexOf(body) : -1;
  let signs = 0;
  for (const r of refs) {
    if (r.at === importAt + 9) continue;
    if (r.next.startsWith(".getPublicKey(")) continue;
    if (r.next.startsWith(".sign(") && bodyAt >= 0 && r.at > bodyAt && r.at < bodyAt + body.length) { signs++; continue; }
    why.push(`ed25519 used as ${JSON.stringify("ed25519" + r.next.slice(0, 8))} outside signMoveTx's one sign`);
  }
  if (signs !== 1) why.push(`signMoveTx makes ${signs} signatures, not one`);
  // and no `.sign(` of anything else
  const other = [...src.matchAll(/(?<![\w$])(?:[\w$]+\s*)?(?:\.\s*sign|\[\s*["'`]sign["'`]\s*\])\s*\(/g)].filter((m) => !/^ed25519\.sign\($/.test(m[0]));
  if (other.length > 0) why.push(`a sign of something else: ${other.map((m) => m[0]).join(" ")}`);
  return why;
}

test("moveout.ts's signer is never handed out, and signs with ed25519 once, inside it", () => {
  assert.deepEqual(signerPin(SRC), []);
});

test("the pin refuses the shapes that would sign past the seal (review 3 M2)", () => {
  const base = SRC;
  const sign = "  const signature = ed25519.sign(digest, secretKey);";
  assert.ok(base.includes(sign));
  const planted: [string, string, RegExp][] = [
    ["the signer exported", base.replace(/^function signMoveTx\(/m, "export function signMoveTx("), /exported/],
    ["the signer re-exported", `${base}\nexport { signMoveTx };\n`, /exported/],
    ["the signer handed out", `${base}\nexport const s = signMoveTx;\n`, /handed on as a value/],
    ["an aliased import", base.replace('import { ed25519 } from "@noble/curves/ed25519.js";', 'import { ed25519 as e } from "@noble/curves/ed25519.js";'), /signing library/],
    ["a namespace import", base.replace('import { ed25519 } from "@noble/curves/ed25519.js";', 'import * as c from "@noble/curves/ed25519.js";'), /signing library/],
    ["schnorr imported", base.replace('import { sha256 }', 'import { schnorr } from "@noble/curves/secp256k1.js";\nimport { sha256 }'), /signing library/],
    ["a destructured sign", `${base}\nconst { sign } = ed25519;\n`, /ed25519 used as/],
    ["a bracketed sign", `${base}\nexport const b = (d: Uint8Array, k: Uint8Array) => ed25519["sign"](d, k);\n`, /ed25519 used as|a sign of something else/],
    ["an arrow signer", `${base}\nexport const signGiven = (d: Uint8Array, k: Uint8Array) => ed25519.sign(d, k);\n`, /outside signMoveTx/],
    ["an object method signer", `${base}\nexport const o = { s(d: Uint8Array, k: Uint8Array) { return ed25519.sign(d, k); } };\n`, /outside signMoveTx/],
    ["a class method signer", `${base}\nexport class C { s(d: Uint8Array, k: Uint8Array) { return ed25519.sign(d, k); } }\n`, /outside signMoveTx/],
    ["a second signature in the signer", base.replace(sign, `${sign}\n  void ed25519.sign(digest, secretKey);`), /2 signatures/],
    ["a sign through a local", base.replace(sign, "  const k = ed25519;\n  const signature = k.sign(digest, secretKey);"), /ed25519 used as|a sign of something else/],
    ["a dynamic import", `${base}\nexport const d = () => import("@noble/curves/ed25519.js");\n`, /run time/],
  ];
  for (const [name, src, want] of planted) {
    const why = signerPin(src);
    assert.ok(why.some((w) => want.test(w)), `${name}: ${JSON.stringify(why)}`);
  }
});
