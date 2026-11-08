// What moveout.ts lets a caller sign (card signers-own-bytes, merge note M366 (2)): no export signs calls or bytes its
// caller hands it. The module's signer (the function that makes the signature) is private, and every call of it signs
// a local const that the same function built with a named builder and passed through a named check before the call.
// A new builder-and-sign export adds its builder and check names below in its own commit (BUILDERS, CHECKS); the rule
// then holds it to that shape, and the export list pins what the module offers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as moveout from "../src/deposit/moveout.ts";

const SRC = readFileSync(new URL("../src/deposit/moveout.ts", import.meta.url), "utf8");

/** The builders that make a move's calls from typed inputs, and the checks that hold built calls to the user's ask. */
const BUILDERS = ["moveCalls", "withdrawCalls"];
const CHECKS = ["checkMoveCalls", "checkWithdrawCalls", "checkRegisterCalls"];

const ID = "[A-Za-z_$][\\w$]*";

/** The index just past the bracket that closes the one at `open`, strings and template literals skipped. */
function closeOf(src: string, open: number): number {
  const pair: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let k = open; k < src.length; k++) {
    const c = src[k]!;
    if (c === '"' || c === "'" || c === "`") {
      for (k++; k < src.length && src[k] !== c; k++) if (src[k] === "\\") k++;
      continue;
    }
    if (pair[c]) stack.push(pair[c]!);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return k + 1;
    }
  }
  throw new Error("no matching bracket");
}

/** A call's arguments split at its top level. */
function argsOf(src: string, open: number): string[] {
  const inner = src.slice(open + 1, closeOf(src, open) - 1);
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k]!;
    if (c === '"' || c === "'" || c === "`") {
      for (k++; k < inner.length && inner[k] !== c; k++) if (inner[k] === "\\") k++;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) (out.push(inner.slice(from, k).trim()), (from = k + 1));
  }
  out.push(inner.slice(from).trim());
  return out.filter((a) => a !== "");
}

const uncommented = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Every top-level function of `src`: its name, whether it is exported, and its text to the next top-level line. */
function functionsOf(src: string): { name: string; exported: boolean; body: string }[] {
  const starts = [...src.matchAll(new RegExp(`^(export )?(?:async )?function (${ID})`, "gm"))];
  return starts.map((m, i) => {
    const after = src.slice(m.index + m[0].length);
    const nl = after.indexOf("\n");
    const rest = nl < 0 ? -1 : after.slice(nl + 1).search(/^\S/m);
    const end = nl < 0 ? after.length : rest < 0 ? after.length : nl + 1 + rest;
    // the closing brace of a function at the line start is its own: kept
    return { name: m[2]!, exported: m[1] !== undefined, body: m[0] + after.slice(0, end + (after[end] === "}" ? 1 : 0)) };
  });
}

/** Why `source` lets a caller sign what it did not build and check (none: it does not). */
export function signRule(source: string): string[] {
  const src = uncommented(source);
  const fns = functionsOf(src);
  const why: string[] = [];
  const signers = fns.filter((f) => /\b(?:ed25519|secp256k1)\.sign\(/.test(f.body)).map((f) => f.name);
  if (signers.length === 0) why.push("no signer found");
  for (const s of signers) {
    if (fns.find((f) => f.name === s)!.exported || new RegExp(`export\\s*\\{[^}]*\\b${s}\\b`).test(src)) why.push(`${s} signs and is exported`);
    // the signer is only ever called, never handed on as a value
    const bare = [...src.matchAll(new RegExp(`(?<![\\w$.])${s}(?![\\w$])(?!\\s*\\()`, "g"))].filter((m) => !/function\s+$/.test(src.slice(Math.max(0, m.index - 10), m.index)));
    if (bare.length > 0) why.push(`${s} is handed on as a value`);
  }
  for (const f of fns) {
    if (signers.includes(f.name)) continue;
    for (const s of signers) {
      for (const call of f.body.matchAll(new RegExp(`(?<![\\w$.])${s}\\(`, "g"))) {
        const at = call.index;
        const args = argsOf(f.body, at + s.length);
        const last = args.at(-1) ?? "";
        const where = `${f.name}'s call of ${s}`;
        if (!new RegExp(`^${ID}$`).test(last)) { why.push(`${where} signs ${last || "nothing"}, not a local const`); continue; }
        const made = new RegExp(`\\bconst ${last} = (${BUILDERS.join("|")})\\(`).exec(f.body);
        if (!made) { why.push(`${where} signs ${last}, which no builder (${BUILDERS.join(", ")}) made here`); continue; }
        // what follows the builder's call: nothing but an optional .slice(...)
        const end = closeOf(f.body, made.index + made[0].length - 1);
        const tail = f.body.slice(end, f.body.indexOf(";", end)).trim();
        if (tail !== "" && !/^\.slice\([^()]*\)$/.test(tail)) { why.push(`${where} signs ${last}, built then changed (${tail})`); continue; }
        if (made.index > at) { why.push(`${where} signs ${last} before it is built`); continue; }
        const checked = [...f.body.matchAll(new RegExp(`(?<![\\w$.])(${CHECKS.join("|")})\\(`, "g"))].some(
          (c) => c.index > made.index && c.index < at && argsOf(f.body, c.index + c[1]!.length).includes(last),
        );
        if (!checked) why.push(`${where} signs ${last} with no check (${CHECKS.join(", ")}) of it before the call`);
        if (new RegExp(`(?<![\\w$.])${last}(?:\\[[^\\]]*\\])?\\s*(?:=(?!=)|\\.(?:push|splice|pop|shift|unshift|fill|sort|reverse|copyWithin)\\()`).test(f.body.slice(made.index + made[0].length)))
          why.push(`${where} signs ${last}, changed after it is built`);
      }
    }
  }
  return why;
}

test("moveout.ts exports exactly these, and no signer of what its caller hands it", () => {
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

test("moveout.ts signs only calls it built and checked: every call of its private signer passes the rule", () => {
  assert.deepEqual(signRule(SRC), []);
});

// ---- the rule on planted sources: what it must refuse, and the builder shapes it must accept
const SIGNER = `function signMoveTx(u: string, publicKey: Uint8Array, secretKey: Uint8Array, nonce: bigint, token: string, blockHash: string, calls: readonly MoveCall[]): { hash: string; signed: string } {
  const signature = ed25519.sign(digestOf(calls), secretKey);
  return { hash: "h", signed: String(signature) };
}
`;
const shape = (body: string, signer = SIGNER) => `${signer}\n${body}\n`;

test("the rule refuses: an exported signer, calls or an alias-typed list handed in, the signer before the check, a built list changed", () => {
  const cases: [string, string, RegExp][] = [
    ["an exported signer", shape("", `export ${SIGNER}`), /signMoveTx signs and is exported/],
    ["the signer re-exported", shape("export { signMoveTx };"), /signMoveTx signs and is exported/],
    ["the signer handed on as a value", shape("export const sign = signMoveTx;"), /handed on as a value/],
    [
      "a MoveCall[] parameter signed",
      shape(`export function signGiven(a: { key: OwnKey; token: string; blockHash: string }, calls: readonly MoveCall[]): BuiltMove {
  checkMoveCalls(a.key.id, "to", a.token, calls, 10n, 0n);
  const tx = signMoveTx(a.key.id, a.key.publicKey, a.key.secretKey, 1n, a.token, a.blockHash, calls);
  return { receiver: a.token, calls, amount: 0n, nonce: 1n, ...tx };
}`),
      /signs calls, which no builder/,
    ],
    [
      "an alias-typed list in a field",
      shape(`type Given = readonly MoveCall[];
export function signAliased(a: { key: OwnKey; token: string; blockHash: string; list: Given }): BuiltMove {
  const list = a.list;
  checkMoveCalls(a.key.id, "to", a.token, list, 10n, 0n);
  const tx = signMoveTx(a.key.id, a.key.publicKey, a.key.secretKey, 1n, a.token, a.blockHash, list);
  return { receiver: a.token, calls: list, amount: 0n, nonce: 1n, ...tx };
}`),
      /signs list, which no builder/,
    ],
    [
      "the signer called before the check",
      shape(`export function signFirst(a: { key: OwnKey; to: string; token: string; blockHash: string }): BuiltMove {
  const calls = moveCalls(a.to, 5n, false, 0n);
  const tx = signMoveTx(a.key.id, a.key.publicKey, a.key.secretKey, 1n, a.token, a.blockHash, calls);
  checkMoveCalls(a.key.id, a.to, a.token, calls, 10n, 0n);
  return { receiver: a.token, calls, amount: 5n, nonce: 1n, ...tx };
}`),
      /signs calls with no check/,
    ],
    [
      "the check of another list",
      shape(`export function signOther(a: { key: OwnKey; to: string; token: string; blockHash: string }): BuiltMove {
  const calls = moveCalls(a.to, 5n, false, 0n);
  const shown = moveCalls(a.to, 1n, false, 0n);
  checkMoveCalls(a.key.id, a.to, a.token, shown, 10n, 0n);
  const tx = signMoveTx(a.key.id, a.key.publicKey, a.key.secretKey, 1n, a.token, a.blockHash, calls);
  return { receiver: a.token, calls, amount: 5n, nonce: 1n, ...tx };
}`),
      /signs calls with no check/,
    ],
    [
      "a built list changed after its check",
      shape(`export function signChanged(a: { key: OwnKey; to: string; token: string; blockHash: string; extra: MoveCall }): BuiltMove {
  const calls = moveCalls(a.to, 5n, false, 0n);
  checkMoveCalls(a.key.id, a.to, a.token, calls, 10n, 0n);
  calls.push(a.extra);
  const tx = signMoveTx(a.key.id, a.key.publicKey, a.key.secretKey, 1n, a.token, a.blockHash, calls);
  return { receiver: a.token, calls, amount: 5n, nonce: 1n, ...tx };
}`),
      /changed after it is built/,
    ],
    [
      "a built list extended before the sign",
      shape(`export function signConcat(a: { key: OwnKey; to: string; token: string; blockHash: string; extra: MoveCall }): BuiltMove {
  const calls = moveCalls(a.to, 5n, false, 0n).concat([a.extra]);
  checkMoveCalls(a.key.id, a.to, a.token, calls, 10n, 0n);
  const tx = signMoveTx(a.key.id, a.key.publicKey, a.key.secretKey, 1n, a.token, a.blockHash, calls);
  return { receiver: a.token, calls, amount: 5n, nonce: 1n, ...tx };
}`),
      /built then changed/,
    ],
    [
      "an inline list signed",
      shape(`export function signInline(a: { key: OwnKey; token: string; blockHash: string; calls: MoveCall[] }): BuiltMove {
  const tx = signMoveTx(a.key.id, a.key.publicKey, a.key.secretKey, 1n, a.token, a.blockHash, a.calls);
  return { receiver: a.token, calls: a.calls, amount: 0n, nonce: 1n, ...tx };
}`),
      /signs a\.calls, not a local const/,
    ],
  ];
  for (const [name, src, want] of cases) {
    const why = signRule(src);
    assert.ok(why.some((w) => want.test(w)), `${name}: ${JSON.stringify(why)}`);
  }
});

test("the rule accepts the three builder shapes of exit-ids-out (2e87edff): move out, register, withdraw from intents.near", () => {
  // read at exit-ids-out 2e87edff, packages/wallet/src/deposit/moveout.ts buildMoveOut, buildRegisterOut, buildWithdrawOut,
  // with the signer private and the register's inline check named (checkRegisterCalls)
  const builders = shape(`export function buildMoveOut(a: { read: MoveOutRead; key: OwnKey; kind: "id" | "arm"; to: string; token: string; storageMin: bigint }): BuiltMove {
  checkOwnKey(a.key);
  const keep = a.kind === "id" ? 1n : 0n;
  const storageMin = a.read.registered ? 0n : a.storageMin;
  const calls = moveCalls(a.to, a.read.usdc - keep, !a.read.registered, storageMin);
  checkMoveCalls(a.key.id, a.to, a.token, calls, a.read.usdc + 1n - keep, storageMin);
  const nonce = a.read.nonce + 1n;
  const tx = signMoveTx(a.key.id, a.key.publicKey, a.key.secretKey, nonce, a.token, a.read.blockHash, calls);
  return { receiver: a.token, calls, amount: a.read.usdc - keep, nonce, ...tx };
}

export function buildRegisterOut(a: { read: Pick<MoveOutRead, "nonce" | "blockHash" | "registered">; key: OwnKey; to: string; token: string; storageMin: bigint }): BuiltMove {
  checkOwnKey(a.key);
  checkTypedAccount(a.key.id, a.to, a.token);
  const calls = moveCalls(a.to, 1n, true, a.storageMin).slice(0, 1);
  checkRegisterCalls(a.to, calls, a.storageMin);
  const nonce = a.read.nonce + 1n;
  const tx = signMoveTx(a.key.id, a.key.publicKey, a.key.secretKey, nonce, a.token, a.read.blockHash, calls);
  return { receiver: a.token, calls, amount: 0n, nonce, ...tx };
}

export function buildWithdrawOut(a: { read: WithdrawOutRead; key: OwnKey; kind: "id" | "arm"; to: string; token: string }): BuiltMove {
  checkOwnKey(a.key);
  const keep = a.kind === "id" ? 1n : 0n;
  const calls = withdrawCalls(a.to, a.read.held - keep, a.token);
  checkWithdrawCalls(a.key.id, a.to, a.token, calls, a.read.held, keep);
  const nonce = a.read.nonce + 1n;
  const tx = signMoveTx(a.key.id, a.key.publicKey, a.key.secretKey, nonce, INTENTS, a.read.blockHash, calls);
  return { receiver: INTENTS, calls, amount: a.read.held - keep, nonce, ...tx };
}`);
  assert.deepEqual(signRule(builders), []);
  // and today's moveOutHeld shape: the signature inside a nested closure of the builder's function
  assert.deepEqual(
    signRule(shape(`export async function moveOutHeld(opId: string, to: string | null, deps: MoveOutDeps): Promise<MoveOutOutcome> {
  const calls = moveCalls(typed, read.usdc - 1n, !read.registered, storageMin);
  checkMoveCalls(U, typed, token, calls, read.usdc, storageMin);
  const tx = await seedLock(async () => {
    return signMoveTx(U, k.publicKey, k.secretKey, nonce, token, read.blockHash, calls);
  });
  return { kind: "sent", tx };
}`)),
    [],
  );
});
