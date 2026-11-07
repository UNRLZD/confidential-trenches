// node --test contracts/pool-evm/test/abi-tie.test.mjs (card helper-evm-abi-tie): every string the helper, the kit, the
// wallet and the signing page name the EVM pool or the sell delegate by is the one the contracts compile to
// (contracts/pool-evm/abi.json, which test/abi-snapshot.test.mjs holds to the build). It reads each source as text (a
// file outside packages/ and contracts/ may not reach them, scripts/ci/kit-reach.mjs, so the tie lives here, as
// test/sell-type-helper.test.mjs): each string literal named after a function, event or error of either contract whose
// parentheses hold only ABI types must be that one's canonical signature, each named after one of their EIP-712 types
// must be that type string, and a file that hashes the EIP-712 domain hashes the contracts' name and version. At
// 654e8293 the helper's withdraw was withdraw(...,uint256) with no signature, which neither pool runs: this fails there.
// The money paths' strings are listed (MONEY_PATHS) so one built some other way, or dropped, fails too.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SNAP = JSON.parse(readFileSync(path.join(REPO, "contracts/pool-evm/abi.json"), "utf8"));
const CONTRACTS = Object.keys(SNAP).filter((k) => k !== "about");
/** Every source the tie reads: the money paths, then the pool's own scripts and the live checks. */
const DIRS = ["apps/helper/src", "packages/kit/src", "packages/wallet/src", "packages/signpage/src", "packages/exit/src", "apps/terminal/src", "contracts/pool-evm/script", "scripts/live-checks"];

/** Each name the contracts compile, with every canonical string it has there (a function and an error may share none). */
const abiStrings = new Map();
const typeStrings = new Map();
const add = (m, s) => {
  const name = s.slice(0, s.indexOf("("));
  m.set(name, new Set([...(m.get(name) ?? []), s]));
};
for (const c of CONTRACTS) {
  for (const k of ["functions", "events", "errors"]) for (const s of Object.keys(SNAP[c][k])) add(abiStrings, s);
  for (const s of Object.keys(SNAP[c].types)) add(typeStrings, s);
}
const domains = new Set(CONTRACTS.filter((c) => SNAP[c].domain !== null).map((c) => JSON.stringify([SNAP[c].domain.name, SNAP[c].domain.version])));
assert.equal(domains.size, 1, "the pool and the sell delegate sign in one EIP-712 domain name and version");
const [DOMAIN_NAME, DOMAIN_VERSION] = JSON.parse([...domains][0]);

/**
 * A string that starts with a contract's name and "(" but is not the build's, named on purpose, each with why: a recorded
 * run's ABI a check replays, one a check refuses, or words in a refusal or a check line. A template's substitutions are
 * written ${…}, as stringsOf writes them.
 */
const HISTORICAL = Object.freeze([
  {
    file: "scripts/live-checks/pool-evm-testnet-run.mjs",
    string: "sell((address,uint256,address,bytes,uint256,address,uint256,uint256,uint256,uint256),uint256,bytes)",
    why: "the testnet runs' recorded sells before card evm-testnet-delegate-review3 (pool-evm-testnet-run.<chain>.json, e.g. Base Sepolia 0x32bb0d25..., input 0xbea5695c on sepolia.base.org and base-sepolia-rpc.publicnode.com) went through the SellDelegate before card helper-sell-fee-recipient added feeRecipient; a run through that card's redeploy is read with the build's",
  },
  {
    file: "scripts/live-checks/helper-evm-abi-tie.mjs",
    string: "withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256)",
    why: "the helper's withdraw before this card, which the check reads no pool dispatches and the helper refuses",
  },
  {
    file: "packages/wallet/src/pool/evm.ts",
    string: "SCOPE(): not the scope of ${…} on ${…}",
    why: "a refusal's words, naming the read",
  },
  {
    file: "packages/wallet/src/pool/evm.ts",
    string: "stateRootTimes(root)",
    why: "a read's label in its refusal, the root it asked",
  },
  {
    file: "packages/wallet/src/pool/evm.ts",
    string: "labelRootTimes(root)",
    why: "a read's label in its refusal, the root it asked",
  },
  {
    file: "scripts/live-checks/pool-evm-testnet-run.mjs",
    string: "stateRootTimes(${…}) is 0: not a root the pool recorded",
    why: "a check line's words",
  },
  {
    file: "scripts/live-checks/pool-evm-testnet-run.mjs",
    string: "nullifierHashes(${…}) is not set on both: a spend the pool did not mark",
    why: "a check line's words",
  },
  {
    file: "scripts/live-checks/pool-evm-testnet-run.mjs",
    string: "usedPrecommitments(${…}) is not set on both",
    why: "a check line's words",
  },
]);

/** Selectors the contracts compiled before and no longer do: one written as hex is drift too, unless listed below. */
const OLD_SELECTORS = Object.freeze({
  "8a3bff22": "withdraw with no signature, the helper's before this card",
  bea5695c: "the ten-field sell, before card helper-sell-fee-recipient",
});
const BUILD = new Map([...abiStrings, ...typeStrings].flatMap(([, set]) => [...set].map((s) => [s, typeStrings.has(s.slice(0, s.indexOf("("))) && /\w \w/.test(s) ? "type" : "abi"])));
const NAMES = new Set([...abiStrings.keys(), ...typeStrings.keys()]);
const SUB = "${…}";

/**
 * Every string `text` (the file `file`, read by the TypeScript parser, so a comment is never one) holds: each string
 * literal, each template with each substitution written ${…}, and each number literal's text, for the hex check.
 */
export function stringsOf(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const out = [];
  const walk = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push({ s: n.text });
    else if (ts.isTemplateExpression(n)) out.push({ s: n.head.text + n.templateSpans.map((t) => SUB + t.literal.text).join("") });
    else if (ts.isNumericLiteral(n)) out.push({ s: n.getText(sf), number: true });
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/** The build's strings `text` names, each once, with its kind. */
export function literalsOf(file, text) {
  return stringsOf(file, text).filter(({ s, number }) => !number && BUILD.has(s)).map(({ s }) => ({ kind: BUILD.get(s), s }));
}

/**
 * Each refusal `text` (the file `file`) earns: a string that starts with one of the contracts' names and "(" (after a
 * function, event or error keyword, if any) and is not the build's string, however it is written (a template, a
 * concatenation's first part, spaces, other types); an old selector's hex; or an EIP-712 domain hashed without the
 * contracts' name and version. A string HISTORICAL lists for the file is not drift.
 */
export function driftOf(file, text) {
  const bad = [];
  const listed = (s) => HISTORICAL.some((h) => h.file === file && h.string === s);
  for (const { s, number } of stringsOf(file, text)) {
    for (const [sel, why] of Object.entries(OLD_SELECTORS)) {
      if (new RegExp(`(^|[^0-9a-f])(0x)?${sel}($|[^0-9a-f])`, "i").test(s) && !listed(s)) bad.push(`${file}: ${JSON.stringify(s.slice(0, 80))} holds the old selector ${sel} (${why})`);
    }
    if (number) continue;
    const m = /^\s*(?:(?:function|event|error)\s+)?([A-Za-z_]\w*)\s*\(/.exec(s);
    if (!m || !NAMES.has(m[1]) || BUILD.has(s) || listed(s)) continue;
    bad.push(`${file}: ${JSON.stringify(s.slice(0, 160))} is not the build's (${[...(abiStrings.get(m[1]) ?? []), ...(typeStrings.get(m[1]) ?? [])].join(" | ")})`);
  }
  if (literalsOf(file, text).some(({ s }) => s.startsWith("EIP712Domain("))) {
    for (const v of [DOMAIN_NAME, DOMAIN_VERSION]) if (!new RegExp(`\\(["'\`]${v}["'\`]\\)`).test(text)) bad.push(`${file}: hashes the EIP-712 domain but not the contracts' "${v}"`);
  }
  return bad;
}

const FILES = execFileSync("git", ["ls-files", "--", ...DIRS], { cwd: REPO, encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\.|\/test\/|\/fixtures\//.test(f));
const read = (f) => readFileSync(path.join(REPO, f), "utf8");

/**
 * The money paths' pool-evm strings, each file's sorted: the helper's sends and reads, the kit's buy and sell builders,
 * the wallet's pool sync, the signing page's withdraw signature. A string added, built some other way or dropped
 * changes this list, so the tie never passes on a file it cannot read.
 */
const MONEY_PATHS = {
  "apps/helper/src/pool/evm.ts": [
    "Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)",
    "Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value)",
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    "Paid(address,uint256)",
    "Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)",
    "Withdraw(uint256 nullifier,uint256 context,uint256 value)",
    "buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)",
    "currentTreeDepth()",
    "sell((address,uint256,address,bytes,uint256,address,uint256,uint256,address,uint256,uint256),uint256,bytes)",
    "withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)",
  ],
  "packages/kit/src/trade/evm/buy-unpinned.ts": [
    "Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value)",
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ],
  "packages/kit/src/trade/evm/sell-unpinned.ts": [
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    "Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)",
    "sell((address,uint256,address,bytes,uint256,address,uint256,uint256,address,uint256,uint256),uint256,bytes)",
  ],
  "packages/signpage/src/rules/pool.ts": [
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    "Withdraw(uint256 nullifier,uint256 context,uint256 value)",
  ],
  "packages/wallet/src/pool/evm.ts": [
    "Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)",
    "Deposited(address,uint256,uint256,uint256,uint256)",
    "SCOPE()",
    "Withdrawn(address,address,uint256,uint256,uint256,uint256)",
    "currentLabelRoot()",
    "currentLabelTreeSize()",
    "currentRoot()",
    "currentTreeSize()",
    "labelRootTimes(uint256)",
    "stateRootTimes(uint256)",
  ],
};
const MONEY_DIRS = DIRS.slice(0, 6);

test("every pool-evm string in the helper, the kit, the wallet, the signing page, the pool's scripts and the live checks is the build's", () => {
  assert.ok(FILES.length > 100, `read ${FILES.length} files`);
  assert.deepEqual(FILES.flatMap((f) => driftOf(f, read(f))), []);
});

test("the money paths name the pool by exactly the listed strings", () => {
  const got = {};
  for (const f of FILES.filter((f) => MONEY_DIRS.some((d) => f.startsWith(`${d}/`)))) {
    const found = [...new Set(literalsOf(f, read(f)).map(({ s }) => s))].sort();
    if (found.length > 0) got[f] = found;
  }
  assert.deepEqual(got, MONEY_PATHS);
});

test("each historical string is still read where it is listed, and is not the build's", () => {
  for (const h of HISTORICAL) {
    assert.ok(stringsOf(h.file, read(h.file)).some(({ s }) => s === h.string), `${h.file} still names ${h.string}`);
    assert.equal(abiStrings.get(h.string.slice(0, h.string.indexOf("(")))?.has(h.string), false, `${h.string} is not the build's: drop it from HISTORICAL once the build has it`);
  }
});

// Planted drift, one per kind of string: each fails the tie, in a copy of the file that names it.
test("planted: a changed withdraw, sell, event, view, error, EIP-712 type or domain fails the tie", () => {
  const plant = (file, from, to) => {
    const text = read(file);
    assert.ok(text.includes(from), `${file} holds ${from}`);
    return driftOf(file, text.replace(from, to));
  };
  const cases = [
    // the helper's withdraw at 654e8293: three arguments, no signature
    ["apps/helper/src/pool/evm.ts", 'uint256[8]),uint256,bytes)"', 'uint256[8]),uint256)"'],
    ["apps/helper/src/pool/evm.ts", 'uint256,uint256,address,uint256,uint256),uint256,bytes)"', 'uint256,uint256,uint256,uint256),uint256,bytes)"'],
    ["apps/helper/src/pool/evm.ts", '"currentTreeDepth()"', '"currentTreeDepth(uint256)"'],
    ["packages/kit/src/trade/evm/sell-unpinned.ts", 'address feeRecipient,uint256 deadline,uint256 nonce)"', 'uint256 deadline,uint256 nonce)"'],
    ["packages/kit/src/trade/evm/buy-unpinned.ts", 'uint256 context,uint256 value)"', 'uint256 context)"'],
    ["packages/kit/src/trade/evm/buy-unpinned.ts", 'encode("Blindfill")', 'encode("Blindfil")'],
    ["packages/signpage/src/rules/pool.ts", '"Withdraw(uint256 nullifier,uint256 context,uint256 value)"', '"Withdraw(uint256 nullifier,uint256 context)"'],
    ["packages/signpage/src/rules/pool.ts", 'utf8("1")', 'utf8("2")'],
    ["packages/wallet/src/pool/evm.ts", '"Withdrawn(address,address,uint256,uint256,uint256,uint256)"', '"Withdrawn(address,uint256,uint256,uint256,uint256)"'],
    ["packages/wallet/src/pool/evm.ts", '"stateRootTimes(uint256)"', '"stateRootTimes(uint128)"'],
    ["contracts/pool-evm/script/testnet-run-lib.mjs", '"FeeOverCap()"', '"FeeOverCap(uint256)"'],
    // the fee collector's Paid, the helper's proof a sale's fee was paid
    ["apps/helper/src/pool/evm.ts", '"Paid(address,uint256)"', '"Paid(address,uint128)"'],
    // the helper's own release strings (card helper-evm-sender-2): W's Buy and Withdraw it checks, the buy it reads, the
    // Bought log that releases a buy's held gas
    ["apps/helper/src/pool/evm.ts", 'address token,uint256 nullifier,uint256 context,uint256 value)"));', 'address token,uint256 nullifier,uint256 context)"));'],
    ["apps/helper/src/pool/evm.ts", '"Withdraw(uint256 nullifier,uint256 context,uint256 value)"', '"Withdraw(uint256 nullifier,uint256 value,uint256 context)"'],
    ["apps/helper/src/pool/evm.ts", '(address,bytes,uint256,address),bytes)"', '(address,bytes,uint256),bytes)"'],
    ["apps/helper/src/pool/evm.ts", '"Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)"', '"Bought(address,uint256,uint256,uint256,uint256,address,uint256)"'],
    // the same withdraw written other ways: a template, a concatenation, a space, a keyword, the old selector as hex
    ["apps/helper/src/pool/evm.ts", '"withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)"', "`withdraw(${W},(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)`"],
    ["apps/helper/src/pool/evm.ts", '"withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)"', '"withdraw((address,bytes)," + PROOF + ",uint256,bytes)"'],
    ["apps/helper/src/pool/evm.ts", '"withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)"', '"withdraw((address, bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)"'],
    ["apps/helper/src/pool/evm.ts", '"withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)"', '"function withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256)"'],
    ["apps/helper/src/pool/evm.ts", "export const WITHDRAW_SELECTOR = selectorOf(WITHDRAW_SIGNATURE);", 'export const WITHDRAW_SELECTOR = "8a3bff22";'],
    ["apps/helper/src/pool/evm.ts", "export const WITHDRAW_SELECTOR = selectorOf(WITHDRAW_SIGNATURE);", "export const WITHDRAW_SELECTOR = 0x8a3bff22;"],
  ];
  for (const [file, from, to] of cases) assert.ok(plant(file, from, to).length > 0, `${file}: ${from} -> ${to}`);
});
