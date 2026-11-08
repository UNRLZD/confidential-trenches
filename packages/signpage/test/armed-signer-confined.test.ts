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

test("only the signing page's trade names the blind signer: the wallet that makes it and signpage/src/trade.ts", () => {
  const naming = ["packages", "apps", "scripts"].flatMap((d) => code(d)).filter((f) => readFileSync(path.join(ROOT, f), "utf8").includes("solanaArmedSigner")).sort();
  assert.deepEqual(naming, ["packages/signpage/src/trade.ts", "packages/wallet/src/arming/records.ts"]);
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
  const makers = ["packages", "apps"].flatMap((d) => code(d)).filter((f) => /(?<![\w$.])tradeKind\(/.test(uncommented(readFileSync(path.join(ROOT, f), "utf8")))).sort();
  assert.deepEqual(makers, ["packages/signpage/src/main.ts", "packages/signpage/src/trade.ts"]);
  const main = uncommented(readFileSync(path.join(ROOT, "packages/signpage/src/main.ts"), "utf8"));
  assert.deepEqual(main.match(/tradeKind\([^;]*\);/g), ["tradeKind({ store: () => open(), seed64: () => openSeed64(), deps: releaseTradeDeps() });"]);
});
