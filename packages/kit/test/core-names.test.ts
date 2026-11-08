// Card exit-note-scan: the kit's ./core export (src/core.ts) holds exactly the wallet names the CO approved for
// packages/ tools, so it never gains or loses one silently, and the kit's public entry never reaches it.
//   node --test test/core-names.test.ts      (from packages/kit)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as CORE from "../src/core.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const CORE_FILE = path.join(SRC, "core.ts");
const WALLET = fileURLToPath(new URL("../../wallet/", import.meta.url));

/** The values core exports, and its types: 16 names in all. */
const VALUES = ["RESTORE_GAP", "RESTORE_LANES", "entropyToWords", "noteCommitment", "noteSecrets", "refKey", "restoreNotes", "restorePages", "typedSeed", "walkLane", "wordsToSeed64"];
const TYPES = ["LaneWalk", "NoteRef", "NoteRestore", "RestoredNote", "RestoredSpend"];

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
    assert.match(spec, /^\.\.\/\.\.\/wallet\/src\/(notes\/(restore|secrets|store)|signin\/words|derive\/keys)\.ts$/, spec);
  }
});

test("the kit's public entry never reaches core.ts or the wallet", () => {
  // every relative import, export-from and import() of src/index.ts, followed file by file
  const seen = new Set<string>();
  const todo = [path.join(SRC, "index.ts")];
  while (todo.length > 0) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const r of ts.preProcessFile(readFileSync(f, "utf8"), true, true).importedFiles) {
      if (!r.fileName.startsWith(".")) continue;
      const to = path.resolve(path.dirname(f), r.fileName);
      const file = [to, `${to}.ts`, path.join(to, "index.ts")].find((p) => existsSync(p) && p.endsWith(".ts"));
      assert.ok(file, `${path.relative(SRC, f)}: ${r.fileName} does not resolve`);
      assert.notEqual(file, CORE_FILE, `${path.relative(SRC, f)} reaches core.ts`);
      assert.ok(!file.startsWith(WALLET), `${path.relative(SRC, f)} reaches the wallet: ${r.fileName}`);
      todo.push(file);
    }
  }
  assert.ok(seen.size > 20, `the walk read ${seen.size} files`);
});
