// The wallet's solanaArmedSigner is a blind signer (card signers-own-bytes, review 1 M2): it signs any message with a
// blockhash for a wallet this device armed and this trade marked, and reads no registry of checked bytes. It is safe
// only while runSolanaTrade is the one thing it signs for, as that run's deps.sign: the kit's flow hands it only the
// wires its checks passed (packages/kit/src/trade/solana/own-wires.ts). This test fails when anything else names it,
// when trade.ts hands it, or its sign, anywhere but the kit run's deps.sign, or when that run can be another function.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP = new Set(["node_modules", "dist", "public", "test", "tests", "fixtures", ".git", ".claude"]);

/** Every code file under packages/, apps/ and scripts/ but tests and built bundles, relative to the root. */
function code(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) { if (!SKIP.has(name)) code(rel, out); }
    else if (CODE.test(name) && !/\.test\.[cm]?[jt]sx?$/.test(name)) out.push(rel);
  }
  return out;
}

/** The text with its comments taken out (a `//` inside a string such as a URL stays). */
const uncommented = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

// The sign-site census (scripts/ci/sign-sites.mjs) names every sign site, these two too, but can reach none: it names
// the signer and the trade kind only as the text of their one entries and imports nothing but node's own modules and
// the TypeScript parser, so it reads the source as text.
const CENSUS = "scripts/ci/sign-sites.mjs";
const ENTRIES: [string, string][] = [["solanaArmedSigner", '"packages/wallet/src/arming/records.ts:solanaArmedSigner"'], ["tradeKind", '"packages/signpage/src/trade.ts:tradeKind"']];
function censusReachesNothing(src: string): string[] {
  const why: string[] = [];
  for (const [name, ENTRY] of ENTRIES) {
    const at = [...src.matchAll(new RegExp(`\\b${name}\\b`, "g"))].map((m) => m.index);
    const entry = src.indexOf(ENTRY);
    if (at.length !== 1 || entry < 0 || at[0] !== entry + ENTRY.indexOf(name)) why.push(`names ${name} other than as its one entry, ${ENTRY}`);
  }
  // every load, read by the TypeScript parser: an import's or export-from's module, an import() or require() argument
  const sf = ts.createSourceFile(CENSUS, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const loads: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) loads.push(ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : n.moduleSpecifier.getText(sf));
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      const a = n.arguments[0];
      loads.push(a && ts.isStringLiteral(a) ? `"${a.text}"` : (a?.getText(sf) ?? ""));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const l of loads) if (!/^"?node:[a-z/_]+"?$/.test(l) && l !== "typescript") why.push(`loads ${l}, not one of node's own modules or the TypeScript parser`);
  return why;
}

test("only the signing page's trade names the blind signer: the wallet that makes it, signpage/src/trade.ts, and the census as text", () => {
  const naming = ["packages", "apps", "scripts"].flatMap((d) => code(d)).filter((f) => readFileSync(path.join(ROOT, f), "utf8").includes("solanaArmedSigner")).sort();
  assert.deepEqual(naming, ["packages/signpage/src/trade.ts", "packages/wallet/src/arming/records.ts", CENSUS]);
  const census = readFileSync(path.join(ROOT, CENSUS), "utf8");
  assert.deepEqual(censusReachesNothing(census), []);
  // planted: the census reading the signer through an import, a dynamic import or a require, or naming it twice
  const imp = census.replace('import path from "node:path";', 'import path from "node:path";\nimport { solanaArmedSigner } from "../../packages/wallet/src/arming/records.ts";');
  assert.notEqual(imp, census);
  assert.ok(censusReachesNothing(imp).some((w) => /loads \.\.\/\.\.\/packages\/wallet/.test(w)) && censusReachesNothing(imp).some((w) => /names solanaArmedSigner other than/.test(w)));
  const kind = census.replace('import path from "node:path";', 'import path from "node:path";\nimport { tradeKind } from "../../packages/signpage/src/trade.ts";');
  assert.notEqual(kind, census);
  assert.ok(censusReachesNothing(kind).some((w) => /loads \.\.\/\.\.\/packages\/signpage/.test(w)) && censusReachesNothing(kind).some((w) => /names tradeKind other than/.test(w)));
  assert.ok(censusReachesNothing(census.replace('import ts from "typescript";', 'import ts from "typescript";\nimport nacl from "tweetnacl";')).some((w) => /loads tweetnacl/.test(w)));
  assert.ok(censusReachesNothing(`${census}\nconst k = await import("../../packages/wallet/src/arming/records.ts");\n`).some((w) => /loads "\.\.\/\.\.\/packages/.test(w)));
  assert.ok(censusReachesNothing(`${census}\nconst k = require("@blindfill/wallet");\n`).some((w) => /loads "@blindfill\/wallet"/.test(w)));
  assert.ok(censusReachesNothing(census.replace('import { fileURLToPath } from "node:url";', 'import { fileURLToPath } from "node:url";\nimport "../../packages/kit/src/index.ts";')).some((w) => /loads \.\.\/\.\.\/packages\/kit/.test(w)));
});

test("trade.ts hands the blind signer's sign to the kit's runSolanaTrade alone, as its deps.sign", () => {
  const src = uncommented(readFileSync(path.join(ROOT, "packages/signpage/src/trade.ts"), "utf8"));
  // made once, kept in one name
  assert.equal(src.match(/solanaArmedSigner\(/g)?.length, 1);
  assert.match(src, /const signer = solanaArmedSigner\(/);
  // that name read twice besides: its sign inside the run's deps.sign, and its close
  const uses = [...src.matchAll(/(?<![\w$.])signer(?![\w$])/g)].map((m) => src.slice(m.index, m.index + 40));
  assert.equal(uses.length, 3, uses.join("\n"));
  assert.equal(src.match(/signer\.sign\(/g)?.length, 1);
  assert.equal(src.match(/signer\.close\(\)/g)?.length, 1);
  const call = /record = await run\(req, \{([\s\S]*?)\n {8}\}\);/.exec(src);
  assert.ok(call, "the run's call is found");
  assert.match(call[1]!, /\n {10}sign: \(wallet, message, tx\) => \{\n {12}signing = true;\n {12}return signer\.sign\(wallet, message, tx\);\n {10}\},/);
  // the run is the kit's runSolanaTrade, or a test's stand-in the page itself never sets
  assert.match(src, /const run = host\.run \?\? runSolanaTrade;/);
  assert.match(src, /import \{ runSolanaTrade,[^}]*\} from "\.\.\/\.\.\/kit\/src\/trade\/solana\/flow\.ts";/);
  // the page builds the one trade host, with the store, the seed and the release's deps alone: no run of its own
  // any naming of it (a call, `T.tradeKind(`, `import { tradeKind as tk }`), in code outside tests: main.ts and trade.ts only
  // (and the census, as the text of its one entry: censusReachesNothing above)
  const makers = ["packages", "apps", "scripts"].flatMap((d) => code(d)).filter((f) => /\btradeKind\b/.test(uncommented(readFileSync(path.join(ROOT, f), "utf8")))).sort();
  assert.deepEqual(makers, ["packages/signpage/src/main.ts", "packages/signpage/src/trade.ts", CENSUS]);
  assert.deepEqual(censusReachesNothing(readFileSync(path.join(ROOT, CENSUS), "utf8")), []);
  const main = uncommented(readFileSync(path.join(ROOT, "packages/signpage/src/main.ts"), "utf8"));
  assert.deepEqual(main.match(/tradeKind\([^;]*\);/g), ["tradeKind({ store: () => open(), seed64: () => openSeed64(), deps: releaseTradeDeps() });"]);
  // main.ts names it twice: its import, under its own name, and that one call
  assert.equal(main.match(/\btradeKind\b/g)?.length, 2);
  assert.match(main, /import \{ releaseTradeDeps, tradeKind \} from "\.\/trade\.ts";/);
});
