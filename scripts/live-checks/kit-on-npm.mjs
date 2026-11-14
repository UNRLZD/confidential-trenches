#!/usr/bin/env node
// Live check of card kit-on-npm: the registry's @blindfill/kit is this repository's kit release. It reads the
// registry's manifest of @blindfill/kit and the release's tarball, and checks:
//   - the manifest is there (today's answer is a 404) and holds the version packages/kit/package.json names, which is
//     its latest dist-tag;
//   - that version's dist.tarball is the registry's own address for it, and the tarball read from there hashes to the
//     manifest's dist.integrity (sha512) and dist.shasum (sha1), and to --integrity when given (the line
//     scripts/publish.mjs prints after it publishes);
//   - the tarball's package.json is that name and version under Apache-2.0, its "." and "./core" exports name built
//     JS and .d.ts in dist/ that the tarball holds, it holds no .ts source, and it holds the LICENSE.
//   node scripts/live-checks/kit-on-npm.mjs [--version <v>] [--integrity <sha512-...>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes the run's answers (the manifest's status and body, and what the tarball held) to <file>, so the
// check's test can replay it.
// Runs: once, after each publish of @blindfill/kit to npm (packages/kit/scripts/publish.mjs); no host deploy changes the registry
import "../net-window.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "kit-on-npm";
export const NAME = "@blindfill/kit";
export const REGISTRY = "https://registry.npmjs.org";
export const MANIFEST_URL = `${REGISTRY}/@blindfill%2Fkit`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The registry's own address of a version's tarball. */
export const tarballUrl = (version) => `${REGISTRY}/${NAME}/-/kit-${version}.tgz`;

/** The version the repository's kit names. */
export const repoVersion = () => JSON.parse(readFileSync(path.join(ROOT, "packages/kit/package.json"), "utf8")).version;

/** One GET of the manifest: { status, body }. */
export async function getManifest() {
  const r = await fetch(MANIFEST_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  return { status: r.status, body: await r.text() };
}

/** One GET of a tarball, and what it holds: { status, bytes, sha512, sha1, files, manifest }. */
export async function getTarball(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (r.status !== 200) return { status: r.status };
  const buf = Buffer.from(await r.arrayBuffer());
  const dir = mkdtempSync(path.join(tmpdir(), "kit-on-npm-"));
  try {
    const tgz = path.join(dir, "kit.tgz");
    writeFileSync(tgz, buf);
    const files = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(Boolean).sort();
    const manifest = JSON.parse(execFileSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" }));
    return {
      status: 200,
      bytes: buf.length,
      sha512: `sha512-${createHash("sha512").update(buf).digest("base64")}`,
      sha1: createHash("sha1").update(buf).digest("hex"),
      files,
      manifest,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The check. `manifest()` gives the registry's answer ({ status, body }), `tarball(url)` what a tarball holds
 * (getTarball's shape); both are replaced by recorded answers in the test.
 */
export async function check({ manifest = getManifest, tarball = getTarball, version = repoVersion(), integrity } = {}) {
  const lines = [];
  const say = (good, text) => (lines.push(`${good ? "ok " : "BAD"} ${text}`), good);
  const m = await manifest();
  if (m.status !== 200) {
    say(false, `${NAME} is not on the registry: ${m.status} ${m.body.slice(0, 80)}`);
    return { ok: false, lines };
  }
  const doc = JSON.parse(m.body);
  const v = doc.versions?.[version];
  const latest = doc["dist-tags"]?.latest;
  if (!say(doc.name === NAME && v != null && latest === version, `${doc.name} on the registry holds ${version}${v ? "" : " NOT"}; latest is ${latest} (versions: ${Object.keys(doc.versions ?? {}).join(", ")})`)) return { ok: false, lines };
  const url = tarballUrl(version);
  const urlOk = say(v.dist?.tarball === url, `dist.tarball ${v.dist?.tarball}${v.dist?.tarball === url ? "" : ` (want ${url})`}`);
  const t = await tarball(v.dist?.tarball ?? url);
  if (!say(t.status === 200, `the tarball answers ${t.status}`)) return { ok: false, lines };
  const hashOk = say(
    t.sha512 === v.dist?.integrity && t.sha1 === v.dist?.shasum && (integrity == null || integrity === t.sha512),
    `the tarball (${t.bytes} B) hashes to ${t.sha512} sha1 ${t.sha1}; dist.integrity ${v.dist?.integrity}, dist.shasum ${v.dist?.shasum}` +
      (integrity == null ? "" : `; the release ${integrity}`),
  );
  const pkg = t.manifest ?? {};
  const files = new Set(t.files ?? []);
  const has = (p) => typeof p === "string" && files.has(`package/${p.replace(/^\.\//, "")}`);
  const entries = [".", "./core"].map((k) => [k, pkg.exports?.[k]]);
  const built = entries.every(([, e]) => e && /^\.\/dist\/.+\.d\.ts$/.test(e.types) && /^\.\/dist\/.+\.js$/.test(e.default) && has(e.types) && has(e.default));
  const source = [...files].filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
  const pkgOk = say(
    pkg.name === NAME && pkg.version === version && pkg.license === "Apache-2.0" && built && source.length === 0 && files.has("package/LICENSE"),
    `its package.json: ${pkg.name}@${pkg.version}, ${pkg.license}; exports ${entries.map(([k, e]) => `${k} -> ${e?.default ?? "none"}`).join(", ")}` +
      `${built ? " (built, in the tarball)" : " (NOT built JS and .d.ts in the tarball)"}; ${source.length} .ts source files; LICENSE ${files.has("package/LICENSE") ? "held" : "missing"}`,
  );
  return { ok: urlOk && hashOk && pkgOk, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = { read_at: new Date().toISOString() };
    const r = await check({
      version: opt("--version", repoVersion()),
      integrity: opt("--integrity"),
      manifest: async () => (rec.manifest = await getManifest()),
      tarball: async (u) => (rec.tarball = await getTarball(u)),
    });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec, null, 1) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
