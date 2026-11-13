#!/usr/bin/env node
// The bundle checks on a pull request's own build (card signpage-check-shapes-on-build): every SIGN_HOST and APP_HOST
// live check whose verdict reads only what the host serves from the build (index.html and the scripts it names) runs
// its own read and judge on this checkout's build, so a change that breaks one of their facts, or only reshapes the
// code one reads, fails here, before a deploy, and not on the live host after it (host=sign run 42348279478: release-73
// served a correct reader whose minified shape signpage-withdraw-own-spend's old regex did not know).
//   SIGN_HOST's build is packages/signpage's index.html and public/, built from this checkout's sources first
//   (scripts/signpage-built.mjs, the build-app.mjs build the deploy makes; card signpage-generated-merge-free). APP_HOST's is apps/terminal/dist, from `pnpm --filter terminal build` run first (the
//   deploy's own vite build).
// Two ways a check runs:
//   IN_PROCESS: the check's exported read with a fetch that answers from the build folders as the host would (a path
//     on SIGN_HOST from index.html and public/, on APP_HOST from dist/); a request to any other origin throws, so a
//     check that reads more than the build cannot pass here;
//   CHILD_RUNS: the check's own local mode (--local, --root), which reads this checkout's build itself.
// Not run here, and why (OUT): a check that needs a browser, the network past the build (an RPC, the helper, a run
// record's transactions), or the response headers the host adds (the deploys' own gates read the build's _headers).
//   pnpm --filter terminal build && node scripts/ci/bundle-checks.mjs
// PASS exit 0; any check FAIL or ERROR exit 1.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHECKS_DIR, headerLines, readChecks } from "./live-after.mjs";
import { signBuilt } from "../signpage-built.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SIGN = "https://confidential.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const SIGN_DIR = path.join(ROOT, "packages/signpage");
export const APP_DIR = path.join(ROOT, "apps/terminal/dist");

// Each check says how it runs here in its own header (card ci-stops-costing-reruns: three shared lists, appended to by every
// card that added a check, made each ready branch conflict with the next merge; the hosts' lists moved to the checks'
// After lines the same way, scripts/ci/live-after.mjs). One `// Bundle:` line per run, in the check's leading comment block:
//   // Bundle: read <sign|app>          run in this process: the check's own bundle(fetch, { host, dirs, SIGN, APP,
//                                       readFileSync, path }) when it exports one, else judge(await read(fetch))
//   // Bundle: child <sign|app> <args>  run as a child process in the check's own local mode, with <args>
//   // Bundle: out <reason>             not run here, and why
// bundlePlan() reads them; a line it cannot read is a problem the test names, never a skipped check.
export const BUNDLE_HOSTS = ["sign", "app"];

/** The runs the checks' Bundle lines name under `root`: { inProcess, childRuns, out, problems }, each list by key. */
export function bundlePlan(root = ROOT) {
  const inProcess = [];
  const childRuns = [];
  const out = {};
  const problems = [];
  for (const [key, text] of Object.entries(readChecks(root))) {
    const file = path.join(root, CHECKS_DIR, `${key}.mjs`);
    const seen = new Set();
    for (const value of headerLines(text, "Bundle")) {
      const [mode, ...rest] = value.split(/\s+/);
      const where = `${key}: "Bundle: ${value}"`;
      if (mode === "out") {
        const why = value.slice(3).trim();
        if (!why) problems.push(`${where}: no reason`);
        else if (Object.hasOwn(out, key)) problems.push(`${where}: left out twice`);
        else out[key] = why;
        continue;
      }
      const [host, ...args] = rest;
      if (mode !== "read" && mode !== "child") {
        problems.push(`${where}: the mode is read, child or out`);
        continue;
      }
      if (!BUNDLE_HOSTS.includes(host)) {
        problems.push(`${where}: the host is ${BUNDLE_HOSTS.join(" or ")}`);
        continue;
      }
      if (mode === "read" && args.length) problems.push(`${where}: a read takes no arguments`);
      const id = `${mode} ${host} ${args.join(" ")}`;
      if (seen.has(id)) problems.push(`${where}: twice`);
      seen.add(id);
      if (mode === "read") inProcess.push({ key, host, load: () => import(pathToFileURL(file).href), run: async (m, f, dirs) => (typeof m.bundle === "function" ? m.bundle(f, { host, dirs, SIGN, APP, readFileSync, path }) : m.judge(await m.read(f))) });
      else childRuns.push({ key, host, args });
    }
    if (Object.hasOwn(out, key) && seen.size) problems.push(`${key}: run here and left out`);
  }
  return { inProcess, childRuns, out, problems };
}
const PLAN = bundlePlan();
/** The checks run in this process. */
export const IN_PROCESS = PLAN.inProcess;
/** The checks run in their own local mode, as a child process: the arguments after the check's path. */
export const CHILD_RUNS = PLAN.childRuns;
/** The deploys' checks left out, with the reason. */
export const OUT = PLAN.out;

/** A fetch that answers from the build folders: SIGN_HOST's / and index.html, every other path public/<path>; APP_HOST's dist/<path>. */
export function buildFetch({ sign, app }) {
  return async (input) => {
    const u = new URL(String(input));
    const p = decodeURIComponent(u.pathname);
    let file;
    if (u.origin === SIGN) file = p === "/" || p === "/index.html" ? path.join(sign, "index.html") : path.join(sign, "public", p);
    else if (u.origin === APP) file = path.join(app, p === "/" ? "index.html" : p);
    else throw new Error(`${u.origin}: not this build (the check reads past the bundle)`);
    const base = u.origin === SIGN ? sign : app;
    if (!path.resolve(file).startsWith(path.resolve(base) + path.sep) || !existsSync(file)) return new Response("", { status: 404 });
    return new Response(readFileSync(file), { status: 200 });
  };
}

/** Runs the checks on the build folders: [{ key, host, ok, lines }], one per run. */
export async function run({ sign = SIGN_DIR, app = APP_DIR, inProcess = IN_PROCESS, childRuns = CHILD_RUNS, root = ROOT } = {}) {
  if (sign === SIGN_DIR) signBuilt(); // this checkout's build, made from its sources
  const f = buildFetch({ sign, app });
  const out = [];
  for (const c of inProcess) {
    try {
      const m = await c.load();
      const v = await c.run(m, f, { sign, app });
      const ok = (v?.ok ?? v?.pass) === true; // the checks' judges answer { ok, lines } or { pass, lines }
      out.push({ key: c.key, host: c.host, ok, lines: ok ? [] : (v?.lines ?? []) });
    } catch (e) {
      out.push({ key: c.key, host: c.host, ok: false, lines: [`ERROR ${e?.message ?? e}`] });
    }
  }
  for (const c of childRuns) {
    const r = spawnSync(process.execPath, [path.join(root, "scripts/live-checks", `${c.key}.mjs`), ...c.args], { cwd: root, encoding: "utf8", timeout: 120_000 });
    const lines = `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").filter((l) => l.trim());
    out.push({ key: c.key, host: c.host, ok: r.status === 0, lines: r.status === 0 ? [] : lines.slice(-12) });
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(path.join(APP_DIR, "index.html"))) {
    console.error(`no APP_HOST build at ${path.relative(ROOT, APP_DIR)}: run pnpm --filter terminal build first`);
    process.exit(1);
  }
  const results = await run();
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.key} (${r.host})`);
    for (const l of r.lines) console.log(`  ${l}`);
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad ? `${bad} of ${results.length} bundle check runs FAIL on this build` : `all ${results.length} bundle check runs PASS on this build`);
  process.exit(bad ? 1 : 0);
}
