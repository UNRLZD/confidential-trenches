// Card exit-note-scan: the core's names are pinned here. The kit's ./core export (src/core.ts) holds exactly these
// wallet names for packages/ tools, so it never gains or loses one silently, and the kit's public entry never reaches it.
//   node --test test/core-names.test.ts      (from packages/kit)
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as CORE from "../src/core.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const CORE_FILE = path.join(SRC, "core.ts");
const WALLET = fileURLToPath(new URL("../../wallet/", import.meta.url));

/** The values core exports, and its types: 39 names in all. */
const VALUES = [
  "RESTORE_GAP", "RESTORE_LANES", "entropyToWords", "noteCommitment", "noteSecrets", "refKey", "restoreNotes", "restorePages", "typedSeed", "walkLane", "wordsToSeed64",
  // card exit-ids-out: the ids' keys and their moves out
  "armAccount", "depositId", "refundId", "returnId", "buildMoveOut", "buildRegisterOut", "buildWithdrawOut", "moveOutRpc", "MoveOutRefused", "readMoveOutFor", "readWithdrawOut", "HEIGHT_SPREAD_MAX",
  // and the settle of a spend of ours by its own arming account (step 4)
  "buildSettleOut", "readSettle", "settleNeed",
  // and the token's storage minimum, an unregistered typed account's registration
  "readTokenStorageMin",
];
const TYPES = ["LaneWalk", "NoteRef", "NoteRestore", "RestoredNote", "RestoredSpend", "BuiltMove", "MoveOutReadFor", "MoveOutRpc", "OwnKey", "RegisterOutReadFor", "WithdrawOutReadFor", "SettleReadFor"];

/** Every name core.ts exports, as its export declarations write them (types included). */
function declaredNames(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const names: string[] = [];
  for (const s of src.statements) {
    if (ts.isExportDeclaration(s)) {
      // only named re-exports: an `export *` would let core grow with the file it names
      assert.ok(s.exportClause && ts.isNamedExports(s.exportClause), "core.ts names every export (no export *)");
      for (const e of s.exportClause.elements) names.push(e.name.text);
    } else if (ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      assert.fail(`core.ts declares an export of its own (${ts.SyntaxKind[s.kind]}): it only re-exports the wallet's code`);
    }
  }
  return names.sort();
}

test("core exports exactly the approved wallet names, values and types", () => {
  assert.deepEqual(Object.keys(CORE).sort(), VALUES.slice().sort(), "core's runtime exports");
  assert.deepEqual(declaredNames(CORE_FILE), [...VALUES, ...TYPES].sort(), "core.ts's export declarations");
});

test("core re-exports the wallet's own code by relative path, not a copy", () => {
  const src = ts.createSourceFile(CORE_FILE, readFileSync(CORE_FILE, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  for (const s of src.statements) {
    if (!ts.isExportDeclaration(s)) continue;
    const spec = (s.moduleSpecifier as ts.StringLiteral).text;
    assert.match(spec, /^\.\.\/\.\.\/wallet\/src\/(notes\/(restore|secrets|store)|signin\/words|derive\/keys|deposit\/(moveout|account)|arming\/accounts)\.ts$/, spec);
  }
});

const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));
const RESOLVE: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true, noEmit: true };

/**
 * Every file of packages/ that src/index.ts reaches, by every import, export-from and import() each file writes, each
 * specifier resolved as TypeScript resolves it (relative, bare and the kit's own package name through its exports,
 * `@blindfill/kit/core` included). A file in `planted` is read from there instead of from disk.
 */
function entryReach(planted: ReadonlyMap<string, string> = new Map()): Map<string, string> {
  const from = new Map<string, string>(); // file -> the file and specifier it was reached by
  const todo = [path.join(SRC, "index.ts")];
  from.set(todo[0]!, "the entry");
  while (todo.length > 0) {
    const f = todo.pop()!;
    for (const r of ts.preProcessFile(planted.get(f) ?? readFileSync(f, "utf8"), true, true).importedFiles) {
      if (r.fileName.startsWith("node:")) continue;
      const hit = ts.resolveModuleName(r.fileName, f, RESOLVE, ts.sys).resolvedModule;
      assert.ok(hit, `${path.relative(PACKAGES, f)}: ${r.fileName} does not resolve`);
      const file = realpathSync(hit.resolvedFileName);
      if (!file.startsWith(PACKAGES) || file.includes(`${path.sep}node_modules${path.sep}`)) continue; // an npm package
      if (from.has(file)) continue;
      from.set(file, `${path.relative(PACKAGES, f)}: ${r.fileName}`);
      todo.push(file);
    }
  }
  return from;
}
const offLimits = (reach: Map<string, string>) => [...reach].filter(([f]) => f === CORE_FILE || f.startsWith(WALLET)).map(([f, by]) => `${path.relative(PACKAGES, f)} (by ${by})`);

test("the kit's public entry never reaches core.ts or the wallet", () => {
  const reach = entryReach();
  assert.deepEqual(offLimits(reach), []);
  assert.ok(reach.size > 20, `the walk read ${reach.size} files`);
});

test("the walk sees core by the kit's own name, by relative path and by import() one file deeper (planted)", () => {
  const plant = (file: string, line: string) => new Map([[path.join(SRC, file), `${readFileSync(path.join(SRC, file), "utf8")}${line}\n`]]);
  const cases: [string, string, RegExp][] = [
    ["index.ts", 'export { typedSeed } from "@blindfill/kit/core";', /^kit\/src\/core\.ts \(by kit\/src\/index\.ts: @blindfill\/kit\/core\)$/],
    ["near/networks.ts", 'export const loadCore = () => import("@blindfill/kit/core");', /^kit\/src\/core\.ts \(by kit\/src\/near\/networks\.ts: @blindfill\/kit\/core\)$/],
    ["index.ts", 'export { typedSeed } from "./core.ts";', /^kit\/src\/core\.ts \(by kit\/src\/index\.ts: \.\/core\.ts\)$/],
    ["near/networks.ts", 'export type { NoteRef } from "../../../wallet/src/notes/secrets.ts";', /^wallet\/src\/notes\/secrets\.ts \(by kit\/src\/near\/networks\.ts: /],
  ];
  for (const [file, line, want] of cases) {
    const got = offLimits(entryReach(plant(file, line)));
    assert.ok(got.length > 0 && want.test(got[0]!), `${file} + ${line}: ${JSON.stringify(got)}`);
  }
});
