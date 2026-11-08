// What moveout.ts lets a caller sign (card signers-own-bytes, merge note M366 (2)): no export signs calls or bytes its
// caller hands it. The module's signer is private; an export that reaches it builds its own calls (moveCalls), checks
// them (checkMoveCalls) and only then signs, and takes no calls or bytes to sign. A new export that signs joins the
// list below in its own commit, and the rule then holds it to that shape.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as moveout from "../src/deposit/moveout.ts";

const SRC = readFileSync(new URL("../src/deposit/moveout.ts", import.meta.url), "utf8");

/** The text from `open` at `from` to its matching close, strings and template literals skipped. */
function span(from: number, open: "(", close: ")"): string {
  let depth = 0;
  for (let k = SRC.indexOf(open, from); k < SRC.length; k++) {
    const c = SRC[k];
    if (c === '"' || c === "'" || c === "`") {
      for (k++; k < SRC.length && SRC[k] !== c; k++) if (SRC[k] === "\\") k++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return SRC.slice(SRC.indexOf(open, from), k + 1);
  }
  throw new Error(`no matching ${close}`);
}

/** Every function declared in the module: its name, parameters and body. */
const FNS = new Map(
  [...SRC.matchAll(/^(?:export )?(?:async )?function ([\w$]+)(?:<[^>]*>)?\(/gm)].map((m) => {
    const params = span(m.index, "(", ")");
    // the rest of the declaration, to the next top-level one: its return type and body
    const after = m.index + m[0].length - 1 + params.length;
    const next = SRC.slice(after).search(/^(?:export |async |function |const |let |type |interface |\/\*\*)/m);
    return [m[1]!, { params, body: SRC.slice(after, next < 0 ? SRC.length : after + next) }];
  }),
);
const calls = (body: string, name: string) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\(`).test(body);

/** The functions that sign: one with a signature in its body, and any that calls one of those. */
function signers(): Set<string> {
  const out = new Set([...FNS].filter(([, f]) => /\bed25519\.sign\(/.test(f.body)).map(([n]) => n));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [n, f] of FNS) if (!out.has(n) && [...out].some((s) => calls(f.body, s))) out.add(n), (grew = true);
  }
  return out;
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

test("no exported function signs calls or bytes its caller hands it: one that signs builds its calls, checks them, then signs", () => {
  const sign = signers();
  assert.ok(sign.size > 0, "the module's signature is found");
  const signs = [...FNS].filter(([, f]) => /\bed25519\.sign\(/.test(f.body)).map(([n]) => n);
  for (const [name, value] of Object.entries(moveout)) {
    if (typeof value !== "function" || /^class\s/.test(Function.prototype.toString.call(value))) continue;
    const f = FNS.get(name);
    assert.ok(f, `${name} is declared in moveout.ts as a function`);
    assert.ok(!signs.includes(name), `${name} is the module's signer, exported`);
    if (!sign.has(name)) continue;
    // it reaches the signer: nothing to sign comes in, and its calls are built and checked here before the signature
    assert.doesNotMatch(f.params, /MoveCall|Uint8Array|\bcalls\b|bytes|message|wire|secretKey/, `${name} takes calls or bytes to sign`);
    const at = (s: string) => f.body.search(new RegExp(`(?<![\\w$.])${s}\\(`));
    const signAt = Math.min(...[...sign].map(at).filter((k) => k >= 0));
    assert.ok(at("moveCalls") >= 0 && at("moveCalls") < at("checkMoveCalls") && at("checkMoveCalls") < signAt, `${name} signs calls it did not build and check first`);
  }
});

test("the rule reads the module's shape: a signer exported, or calls handed in, is found", () => {
  // the reach is followed through the module: moveOutHeld signs through the private signer
  assert.ok(signers().has("moveOutHeld"));
  assert.ok(!signers().has("moveCalls") && !signers().has("checkMoveCalls"));
});
