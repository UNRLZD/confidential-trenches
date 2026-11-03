#!/usr/bin/env node
// No blank pages, in the app (card app-no-blank-pages): this tree built and served at APP_HOST's name inside the stand-in
// shell of app-in-shell.mjs, signed out (a first visit), judged by the live check's own collect() and judge()
// (scripts/live-checks/app-no-blank-pages.mjs): every link the phone header and tab bar and the desktop top bar and
// footer draw, each tapped from "/", opens a main with text (the legal pages' links are named as waiting on their card);
// no link to Orders; Account and Portfolio draw Sign in, which opens the sheet; /verify, opened directly or from the
// pill, draws the panel over the Trenches page.
//   node apps/terminal/test/no-blank-pages/run.mjs [--build <dir>] [--shots <dir>]     PASS exit 0, FAIL exit 1
// --build: a build to test (default: this tree built into a temp dir), e.g. a build of main for the red run.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { collect, judge } from "../../../../scripts/live-checks/app-no-blank-pages.mjs";

const TERMINAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-no-blank-pages-"));
  await build({ root: TERMINAL, logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

const own = opt("--build") ? null : await build();
const dir = path.resolve(opt("--build") ?? own);
let ok = false;
try {
  const rec = await collect({ shots: opt("--shots"), route: await harnessRoute(dir, "tap"), source: `harness, ${opt("--build") ? dir : "this tree"}, signed out` });
  const r = judge(rec);
  for (const l of r.lines) console.log(l);
  console.log(`screenshots: ${rec.shots}`);
  ok = r.ok;
} finally {
  if (own) rmSync(own, { recursive: true, force: true });
}
console.log(ok ? "PASS no link or tab opens a blank page, signed out, at 390 and 1440" : "FAIL a link or tab opens a blank page (BAD lines above)");
process.exit(ok ? 0 : 1);
