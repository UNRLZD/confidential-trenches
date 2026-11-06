// A Pages deploy is done only when its public address serves the build it uploaded (card pages-deploy-readback). On
// 6 Nov 09:21Z wrangler 4.151.1 printed "Deployment complete! However, we couldn't ascertain the final status of your
// deployment." and exited 0 while Cloudflare marked the deployment Failure, and SIGN_HOST kept serving the release
// before. So after wrangler exits 0, both deploy scripts (packages/signpage/scripts/deploy.mjs,
// apps/terminal/scripts/deploy.mjs) read the address's / and every same-origin script the built index.html loads (the
// main bundle), each with its own cache-buster, and compare their sha256 with the build folder's files. A try passes
// only when every path answers 200 with the build's bytes; TRIES tries GAP_MS apart (about a minute) and then it fails,
// naming each path's served and built hash. The full check of every file and header is the live check signpage-release
// --host sign|app, run after the deploy; this is the deploy's own stop.
import "./net-window.mjs";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const TRIES = 6;
export const GAP_MS = 12_000; // 5 gaps: the last try a minute after the first
const READ_MS = 15_000; // one read's bound, so a hung connection fails its try instead of holding the deploy
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** The paths read back, each with the build file it must equal: / (index.html) and each same-origin script it loads. */
export function readPaths(dir, origin) {
  const page = readFileSync(join(dir, "index.html"), "utf8");
  const paths = ["/"];
  for (const m of page.matchAll(/<script\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)) {
    const u = new URL(m[1], `${origin}/`);
    if (u.origin === origin && !paths.includes(u.pathname)) paths.push(u.pathname);
  }
  return paths.map((path) => ({ path, file: join(dir, path === "/" ? "index.html" : decodeURIComponent(path.slice(1))) }));
}

/** Reads `origin` until it serves the build in `dir`: { ok, lines }. `net` holds the fetch and the sleep (a test's stand-ins). */
export async function readBack(origin, dir, { fetch: fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = TRIES, gapMs = GAP_MS } = {}) {
  const want = readPaths(dir, origin).map((p) => ({ ...p, sha256: sha256(readFileSync(p.file)) }));
  let last = [];
  for (let t = 1; t <= tries; t++) {
    if (t > 1) await sleep(gapMs);
    last = [];
    for (const w of want) {
      const url = `${origin}${w.path}?readback=${randomBytes(8).toString("hex")}`;
      try {
        const r = await fetchFn(url, { redirect: "manual", cache: "no-store", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(READ_MS) });
        const got = Buffer.from(await r.arrayBuffer());
        if (r.status !== 200) last.push(`${w.path} answers ${r.status}, the build's sha256 ${w.sha256}`);
        else if (sha256(got) !== w.sha256) last.push(`${w.path} serves ${got.length} B sha256 ${sha256(got)}, the build's sha256 ${w.sha256}`);
      } catch (e) {
        last.push(`${w.path} cannot be read (${e.cause?.code ?? e.name}: ${e.message}), the build's sha256 ${w.sha256}`);
      }
    }
    if (!last.length) return { ok: true, lines: [`${origin} serves the build: ${want.map((w) => `${w.path} sha256 ${w.sha256}`).join(", ")} (try ${t} of ${tries})`] };
  }
  const span = Math.round(((tries - 1) * gapMs) / 1000);
  return { ok: false, lines: [`${origin} does not serve the build after ${tries} tries over ${span} s, though wrangler exited 0:`, ...last.map((l) => `  ${l}`), "the upload did not land (Cloudflare's deployment list may mark it Failure): deploy again"] };
}
