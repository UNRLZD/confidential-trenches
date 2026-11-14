// Card kit-on-npm: publishes @blindfill/kit to npm, the tarball pack-check proved, from a commit on origin/main only.
//   1. scripts/pack-check.mjs packs the kit and proves the tarball (plain node and tsc in a fresh npm install), keeping it;
//   2. refuses unless HEAD is on origin/main (read after a fetch) and the kit, the wallet files it ships and the lockfile
//      are as HEAD has them, so the tarball is the commit's;
//   3. refuses unless the registry answers that the version is not there yet (a 404, or a manifest without it);
//   4. reads the token from the macOS Keychain item --keychain-service names into this process only (the public tree
//      names no Keychain item, as the repository's other scripts that take one), writes it to a temp npmrc (mode 600)
//      that only this run's npm reads, and deletes it after, whatever npm did; the token is never printed;
//   5. npm publish <that tarball> --access public, then prints the live check's line for this release.
//   node packages/kit/scripts/publish.mjs --keychain-service <name> [--dry-run]     --dry-run does all of it, with
//   npm publish --dry-run
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// the connect window scripts/net-window.mjs sets for the repository's other tools, set here since the kit imports no
// file outside packages/: Node's own 250 ms cancels a slow IPv4 connect
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(KIT, "../..");
export const NAME = "@blindfill/kit";
export const REGISTRY = "https://registry.npmjs.org/";
export const MANIFEST_URL = "https://registry.npmjs.org/@blindfill%2Fkit";
// what the tarball is built from: a change here not in HEAD would ship code no commit holds
export const BUILT_FROM = ["packages/kit", "packages/wallet/src", "pnpm-lock.yaml"];

const sh = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export const real = {
  packCheck: async (out) => (await import("./pack-check.mjs")).packCheck({ out }),
  git: (args) => sh("git", args),
  manifest: async () => {
    const r = await fetch(MANIFEST_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: await r.text() };
  },
  // stdout only: the token goes to this process and nowhere else
  readToken: (service) => execFileSync("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
  npm: (args, opts) => execFileSync("npm", args, { ...opts, stdio: ["ignore", "inherit", "inherit"] }),
  version: () => JSON.parse(readFileSync(path.join(KIT, "package.json"), "utf8")).version,
  log: (s) => console.log(s),
};

export class PublishRefused extends Error {}

/** The env npm runs in: no npm_config_* from a parent (pnpm run sets some), and our npmrc as its user config. */
export function npmEnv(env, npmrc) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^npm_config_/i.test(k)) out[k] = v;
  out.NPM_CONFIG_USERCONFIG = npmrc;
  return out;
}

export async function publish({ dryRun = false, keychainService, d = real, env = process.env } = {}) {
  if (typeof keychainService !== "string" || !/^[\w.-]+$/.test(keychainService)) throw new PublishRefused("--keychain-service <name> is required: the Keychain item that holds the npm token");
  const work = mkdtempSync(path.join(tmpdir(), "kit-publish-"));
  try {
    // 1. the tarball, proved
    const pc = await d.packCheck(path.join(work, "pack"));
    for (const l of pc.lines) d.log(`pack-check: ${l}`);
    if (!pc.ok || !pc.tarball) throw new PublishRefused("pack-check failed: nothing is published");

    // 2. HEAD is on origin/main and the tree is HEAD's
    d.git(["fetch", "--quiet", "origin", "main"]);
    const head = d.git(["rev-parse", "HEAD"]);
    try {
      d.git(["merge-base", "--is-ancestor", head, "origin/main"]);
    } catch {
      throw new PublishRefused(`HEAD ${head} is not on origin/main (${d.git(["rev-parse", "origin/main"])})`);
    }
    const dirty = d.git(["status", "--porcelain", "--", ...BUILT_FROM]);
    if (dirty) throw new PublishRefused(`the tree differs from HEAD in ${dirty.split("\n").length} paths under ${BUILT_FROM.join(", ")}`);

    // 3. the version is not yet on the registry
    const version = d.version();
    const m = await d.manifest();
    if (m.status === 200) {
      const doc = JSON.parse(m.body);
      if (doc.versions?.[version]) throw new PublishRefused(`${NAME}@${version} is already on the registry`);
    } else if (m.status !== 404) {
      throw new PublishRefused(`the registry answered ${m.status} for ${NAME}: cannot tell whether ${version} is there`);
    }
    d.log(`${NAME}@${version} at ${head}: not on the registry yet; tarball ${pc.integrity}`);

    // 4. the token, into a temp npmrc only npm reads
    let token = "";
    try {
      token = d.readToken(keychainService);
    } catch {}
    if (!/^\S{20,}$/.test(token)) throw new PublishRefused(`no npm token in the Keychain under ${keychainService}`);
    const npmrc = path.join(work, "npmrc");
    writeFileSync(npmrc, `registry=${REGISTRY}\n//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
    token = "";

    // 5. publish the tarball pack-check proved
    const args = ["publish", pc.tarball, "--access", "public", "--userconfig", npmrc, ...(dryRun ? ["--dry-run"] : [])];
    try {
      d.npm(args, { cwd: work, env: npmEnv(env, npmrc) });
    } finally {
      rmSync(npmrc, { force: true });
    }
    d.log(dryRun ? `dry run: ${NAME}@${version} not published` : `published ${NAME}@${version}; check it: node scripts/live-checks/kit-on-npm.mjs --integrity ${pc.integrity}`);
    return { version, integrity: pc.integrity, head };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = process.argv.slice(2);
    await publish({ dryRun: a.includes("--dry-run"), keychainService: a.includes("--keychain-service") ? a[a.indexOf("--keychain-service") + 1] : undefined });
  } catch (e) {
    console.error(`publish: REFUSED: ${e instanceof PublishRefused ? e.message : String(e?.message ?? e).split("\n")[0]}`);
    process.exitCode = 1;
  }
}
