#!/usr/bin/env node
// Live check of card near-quote-inside-the-kpi: SIGN_HOST's NEAR quote keeps its pool lists across page loads in its own
// storage (packages/signpage/src/near-pools.ts keptDb, rheaPoolsKept, dclPoolsKept), so a NEAR buy box's quote asks the
// pool lists' count, not their pages, on a load. It reads what SIGN_HOST serves:
//   - the served /app.js is the one index.html pins (its sha384);
//   - that /app.js holds the kept lists: their IndexedDB ("ct-near-kept") and their two keys ("rhea-pools:",
//     "dcl-pools:").
// The shared view_account and the DCL path picked per hop leave no text in a build: packages/kit
// test/near-quote-reads.test.ts holds them, and the browser measure after the release reads their time.
// The markers are written out here, not read from the repo.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/near-quote-inside-the-kpi.mjs [--site <dir>] [--record <file>] [--answer <file>]
// --site reads a build folder (its index.html and public/app.js) in place of SIGN_HOST: the answer this tree's build
// gives, which the deployed page must match. PASS exit 0, FAIL exit 1, error exit 2. --record writes the answer read;
// --answer replays one (the test's).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SIGN = "https://confidential.unrealized.trade";
export const MARKERS = ["ct-near-kept", "rhea-pools:", "dcl-pools:"];

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The verdict on an answer { index, app: { sha384, markers } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a.index ?? "")?.[1];
  if (!pin) bad("index.html pins no /app.js");
  else if (pin !== a.app?.sha384) bad("the served /app.js is not the one index.html pins");
  for (const m of MARKERS) if (!(a.app?.markers ?? []).includes(m)) bad(`the served /app.js keeps no NEAR pool list across loads (${JSON.stringify(m)})`);
  if (!lines.length) lines.push("OK the pinned /app.js keeps the NEAR pool lists across page loads");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

const answerOf = (index, js) => ({ index, app: { sha384: sha384(js), markers: MARKERS.filter((m) => js.includes(m)) } });

/** Reads SIGN_HOST, or a build folder. */
export async function read(site) {
  // a build folder as served (build-app.mjs --out: app.js beside index.html), or the package's (public/app.js)
  if (site) return answerOf(readFileSync(path.join(site, "index.html"), "utf8"), readFileSync(existsSync(path.join(site, "app.js")) ? path.join(site, "app.js") : path.join(site, "public", "app.js"), "utf8"));
  const index = await (await fetch(`${SIGN}/`)).text();
  const js = await (await fetch(`${SIGN}/app.js`)).text();
  return answerOf(index, js);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(arg("--site"));
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? "PASS near-quote-inside-the-kpi" : "FAIL near-quote-inside-the-kpi");
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR near-quote-inside-the-kpi: ${e?.message ?? e}`);
    process.exit(2);
  }
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `f` answers from the build
 *  folders as the host would; `dirs` names them (card ci-stops-costing-reruns, moved from bundle-checks.mjs). */
export async function bundle(f, { dirs }) {
  return judge(await read(dirs.sign));
}
