// Card kit-on-npm: builds the kit's dist/ for its npm tarball, JS and .d.ts for "." and "./core" (pnpm runs it as
// prepack). The workspace never reads dist/: its exports stay on src/, and only publishConfig points at dist/.
// - tsc emits each entry with its own flags: "./core" under tsconfig.core.json's (it re-exports the wallet's own files,
//   which the kit's stricter flags were never written to), "." under tsconfig.json's. rootDir is packages/, so the kit's
//   files land in dist/kit/src/ and the wallet's in dist/wallet/src/; a wallet file's "@blindfill/kit" import resolves
//   in the tarball to the package's own "." entry.
// - tsc keeps a relative ".ts" import as written in a .d.ts (rewriteRelativeImportExtensions rewrites the .js only), so
//   each one becomes ".js", the file tsc wrote beside it; a consumer's tsc then reads the .d.ts next to that .js.
//   node packages/kit/scripts/build.mjs      prints the count of files written
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(KIT, "dist");
const TSC = createRequire(path.join(KIT, "package.json")).resolve("typescript/bin/tsc");

/** Every relative ".ts" specifier of a .d.ts made ".js": `from "./x.ts"`, `import("./x.ts")`. */
export function dtsSpecifiers(text) {
  return text.replace(/((?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/g, "$1$2$3.js$2");
}

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : [path.join(dir, f)]));

export function build() {
  rmSync(DIST, { recursive: true, force: true });
  for (const config of ["tsconfig.build-core.json", "tsconfig.build.json"]) execFileSync(process.execPath, [TSC, "-p", config], { cwd: KIT, stdio: "inherit" });
  const files = walk(DIST);
  for (const f of files.filter((f) => f.endsWith(".d.ts"))) {
    const text = readFileSync(f, "utf8");
    const out = dtsSpecifiers(text);
    if (out !== text) writeFileSync(f, out);
    // every relative specifier left must name a file tsc wrote
    for (const [, spec] of out.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const to = path.resolve(path.dirname(f), spec);
      if (!spec.endsWith(".js") || !files.includes(to)) throw new Error(`${path.relative(KIT, f)}: ${spec} names no file in dist/`);
    }
  }
  for (const f of files.filter((f) => f.endsWith(".js"))) {
    for (const [, spec] of readFileSync(f, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      if (!files.includes(path.resolve(path.dirname(f), spec))) throw new Error(`${path.relative(KIT, f)}: ${spec} names no file in dist/`);
    }
  }
  return files.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`dist: ${build()} files`);
}
