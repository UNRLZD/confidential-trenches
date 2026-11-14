// Card kit-on-npm: proves the kit's npm tarball works for an app with no TypeScript step, as `npm i @blindfill/kit` gives it.
//   1. `pnpm pack` (its prepack builds dist/, scripts/build.mjs), so publishConfig's dist exports are what ships;
//   2. the tarball holds package.json, README.md, LICENSE (the repository's, byte for byte) and dist/ only, and its
//      exports, main and types name files it holds;
//   3. `npm install <tarball>` in a fresh temp folder, its dependencies from the registry;
//   4. plain node there imports "@blindfill/kit" and "@blindfill/kit/core": each must export exactly the names the
//      workspace's source entry exports, with SIGNPAGE_KINDS and ZK_SETUP_FILES on "." (the kit test's own check);
//   5. tsc --noEmit, strict and without skipLibCheck, on a consumer file that imports types from both entries and holds
//      one @ts-expect-error, so a type that came out as `any` fails too.
//   node packages/kit/scripts/pack-check.mjs [--out <dir>]     prints a line per step, then PASS (exit 0) or FAIL (exit 1);
//   --out keeps the tarball there (scripts/publish.mjs publishes that same file), otherwise everything is removed
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(KIT, "../..");
const TSC = createRequire(path.join(KIT, "package.json")).resolve("typescript/bin/tsc");
const OK_ROOT = new Set(["package/package.json", "package/README.md", "package/LICENSE"]);

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
const fail = (e) => (e?.stderr || e?.stdout || e?.message || String(e)).toString().trim().split("\n").slice(-6).join(" | ");

/** The names the workspace's source entry exports, read by node from src/ (type stripping runs outside node_modules). */
async function sourceNames(entry) {
  return Object.keys(await import(pathToFileURL(path.join(KIT, "src", entry)).href)).sort();
}

const CONSUMER_TS = `import { SIGNPAGE_KINDS, ZK_SETUP_FILES, type ZkSetupFileName } from "@blindfill/kit";
import { restoreNotes, wordsToSeed64 } from "@blindfill/kit/core";
const name: ZkSetupFileName = "withdraw.wasm";
const bytes: number = ZK_SETUP_FILES[name].bytes;
const kinds: readonly string[] = SIGNPAGE_KINDS;
// @ts-expect-error a name that is not a setup file
const wrong: ZkSetupFileName = "nope.wasm";
export const used = [bytes, kinds, wrong, typeof restoreNotes, typeof wordsToSeed64];
`;

const CONSUMER_TSCONFIG = {
  compilerOptions: { target: "es2023", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, skipLibCheck: false, lib: ["es2023", "dom"], types: [] },
  files: ["consumer.ts"],
};

const CONSUMER_MJS = `const out = {};
for (const entry of ["@blindfill/kit", "@blindfill/kit/core"]) out[entry] = Object.keys(await import(entry)).sort();
const kit = await import("@blindfill/kit");
out.signpageKinds = Array.isArray(kit.SIGNPAGE_KINDS) && kit.SIGNPAGE_KINDS.length > 0;
out.setupFiles = kit.ZK_SETUP_FILES !== null && typeof kit.ZK_SETUP_FILES === "object" && "withdraw.zkey" in kit.ZK_SETUP_FILES;
console.log(JSON.stringify(out));
`;

export async function packCheck({ out } = {}) {
  const lines = [];
  let ok = true;
  const say = (good, text) => {
    lines.push(`${good ? "ok " : "BAD"} ${text}`);
    if (!good) ok = false;
    return good;
  };
  const work = mkdtempSync(path.join(tmpdir(), "kit-pack-check-"));
  const dest = out ? path.resolve(out) : path.join(work, "pack");
  mkdirSync(dest, { recursive: true });
  let tarball = null;
  try {
    // 1. pack
    try {
      run("pnpm", ["pack", "--pack-destination", dest], KIT);
      const tgz = readdirSync(dest).filter((f) => f.endsWith(".tgz"));
      if (tgz.length !== 1) throw new Error(`${tgz.length} tarballs in ${dest}`);
      tarball = path.join(dest, tgz[0]);
    } catch (e) {
      say(false, `pnpm pack: ${fail(e)}`);
      return { ok, lines, tarball };
    }
    const bytes = readFileSync(tarball);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    say(true, `packed ${path.basename(tarball)}, ${bytes.length} B, ${integrity}`);

    // 2. what the tarball holds
    const list = run("tar", ["-tzf", tarball], work).split("\n").filter(Boolean);
    const stray = list.filter((f) => !OK_ROOT.has(f) && !f.startsWith("package/dist/"));
    say(stray.length === 0, stray.length ? `the tarball holds ${stray.length} files outside dist/: ${stray.slice(0, 5).join(", ")}` : `the tarball holds package.json, README.md, LICENSE and ${list.length - 3} files in dist/`);
    const unpacked = path.join(work, "unpacked");
    mkdirSync(unpacked);
    run("tar", ["-xzf", tarball, "-C", unpacked], work);
    let licence = null;
    try {
      licence = readFileSync(path.join(unpacked, "package/LICENSE"));
    } catch {}
    say(licence !== null && licence.equals(readFileSync(path.join(ROOT, "LICENSE"))), licence ? "LICENSE is the repository's, byte for byte" : "no LICENSE in the tarball");
    const manifest = JSON.parse(readFileSync(path.join(unpacked, "package/package.json"), "utf8"));
    const targets = [manifest.main, manifest.types, ...Object.values(manifest.exports ?? {}).flatMap((t) => (typeof t === "string" ? [t] : Object.values(t)))];
    const missing = targets.filter((t) => typeof t !== "string" || !list.includes(`package/${t.replace(/^\.\//, "")}`));
    say(missing.length === 0 && targets.every((t) => /\.(js|d\.ts|json)$/.test(t)), missing.length ? `exports, main or types name files not in the tarball: ${missing.map((t) => t ?? "(none)").join(", ")}` : `exports, main and types name ${targets.length} files the tarball holds, none of them .ts source`);

    // 3. a fresh app installs the tarball with npm
    const app = path.join(work, "app");
    mkdirSync(app);
    writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "kit-pack-check-app", private: true, type: "module" }, null, 2));
    try {
      run("npm", ["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"], app);
      say(true, "npm install of the tarball in a fresh folder");
    } catch (e) {
      say(false, `npm install: ${fail(e)}`);
      return { ok, lines, tarball, integrity };
    }

    // 4. plain node imports both entries
    writeFileSync(path.join(app, "consumer.mjs"), CONSUMER_MJS);
    try {
      const got = JSON.parse(run(process.execPath, ["consumer.mjs"], app).trim());
      for (const [entry, file] of [["@blindfill/kit", "index.ts"], ["@blindfill/kit/core", "core.ts"]]) {
        const want = await sourceNames(file);
        const extra = got[entry].filter((n) => !want.includes(n));
        const lost = want.filter((n) => !got[entry].includes(n));
        say(extra.length === 0 && lost.length === 0, `plain node imports ${entry}: ${got[entry].length} names${lost.length ? `, missing ${lost.slice(0, 5).join(", ")}` : ""}${extra.length ? `, extra ${extra.slice(0, 5).join(", ")}` : ""} (source: ${want.length})`);
      }
      say(got.signpageKinds && got.setupFiles, `SIGNPAGE_KINDS ${got.signpageKinds ? "is a list" : "missing"}, ZK_SETUP_FILES ${got.setupFiles ? "holds withdraw.zkey" : "missing"}`);
    } catch (e) {
      say(false, `plain node import: ${fail(e)}`);
    }

    // 5. a TypeScript consumer gets the types
    writeFileSync(path.join(app, "consumer.ts"), CONSUMER_TS);
    writeFileSync(path.join(app, "tsconfig.json"), JSON.stringify(CONSUMER_TSCONFIG, null, 2));
    try {
      run(process.execPath, [TSC, "-p", "tsconfig.json"], app);
      say(true, "tsc --noEmit (strict, no skipLibCheck) on a consumer of both entries' types");
    } catch (e) {
      say(false, `tsc on the consumer: ${fail(e)}`);
    }
    return { ok, lines, tarball, integrity };
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(path.join(KIT, "dist"), { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--out");
  const r = await packCheck({ out: at > 0 ? process.argv[at + 1] : undefined });
  for (const l of r.lines) console.log(l);
  console.log(r.ok ? "PASS" : "FAIL");
  process.exitCode = r.ok ? 0 : 1;
}
