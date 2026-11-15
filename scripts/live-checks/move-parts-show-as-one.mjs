#!/usr/bin/env node
// Live check of card move-parts-show-as-one: the deployed app reads a move from Cash sent in parts as one move. The
// signing page sends a move bigger than any one Cash note as parts, the first under the move's id and the rest under
// `<id>/1`, `<id>/2`, ... (packages/signpage/src/cash-to-pool.ts sendParts). It reads what APP_HOST serves: the page,
// then every script the page names, and checks the bundle holds (apps/terminal/src/screens/portfolio/move.ts wholeMove):
//   - every move op under the move's id is read with it, and its parts are the ids `<id>/<n>`;
//   - its stage is failed when any part failed, else the least advanced part's, done only when every part is done;
//   - its amount and what landed are the parts' sums;
//   - the Move sheet (moveOp) and the Activity row (activity) both read the move over its parts.
// The behaviour (three parts with one on its way, one failed, every stage in order) is apps/terminal's own test,
// apps/terminal/test/move-parts-show-as-one.test.ts.
// After: app
// Bundle: read app
//   node scripts/live-checks/move-parts-show-as-one.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the marks each file holds, its pin and its sha384, not the files), so the check's
// test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "move-parts-show-as-one";
export const APP_URL = "https://ct-app.unrealized.trade/";
// a minifier may quote a string with any of the three quotes and rename any identifier
const Q = "[`\"']";
const ID = "[\\w$]+";
/** The marks: each name, and what the bundle holds when the change is in place. */
export const MARKS = [
  ["every move op under the move's id is read with it", new RegExp(`${ID}\\.filter\\(${ID}=>${ID}\\.kind===${Q}move${Q}&&${ID}\\.id\\.startsWith\\(\`\\$\\{${ID}\\.id\\}/\`\\)\\)`)],
  ["its parts are the ids <id>/<n>", new RegExp(`${ID}=/\\^\\[1-9\\]\\\\d\\*\\$/[\\s\\S]{0,1200}?${ID}\\.test\\(${ID}\\.id\\.slice\\(${ID}\\.id\\.length\\+1\\)\\)`)],
  ["failed if any part failed, else the least advanced part, done only when every part is", new RegExp(`${ID}\\.some\\(${ID}=>${ID}\\.stage===${Q}failed${Q}\\)\\?${Q}failed${Q}:${ID}\\(${ID}\\)\\?\\?${ID}\\(${ID}\\)\\?\\?\\(${ID}\\.some\\(${ID}=>${ID}\\.stage===${Q}refunded${Q}\\)\\?${Q}refunded${Q}:${Q}done${Q}\\)`)],
  ["its amount and what landed are the parts' sums", new RegExp(`${ID}=${ID}\\(${ID}\\.map\\(${ID}=>${ID}\\.amount\\)\\),${ID}=${ID}\\(${ID}\\.map\\(${ID}=>${ID}\\.out\\)\\)`)],
  ["the Move sheet reads the move over its parts", new RegExp(`${ID}\\.id===${ID}\\?${ID}=${ID}:${ID}\\.push\\(${ID}\\)\\}\\}return ${ID}===null\\?null:${ID}\\(${ID},${ID}\\)`)],
  ["an Activity row reads the move over its parts", new RegExp(`kind===${Q}move${Q}\\)\\{let ${ID}=${ID}\\(${ID},${ID}\\?\\?\\[\\]\\),${ID}=\\{from:${ID}\\.from`)],
];
export const NAMES = MARKS.map(([n]) => n);

/** The page's scripts: the `src` of each script tag, with its `integrity` when it has one. */
export const scriptsOf = (html) =>
  [...html.matchAll(/<script\b[^>]*>/gi)].flatMap((m) => {
    const src = /\bsrc="([^"]+)"/i.exec(m[0])?.[1];
    return src ? [{ src, integrity: /\bintegrity="([^"]+)"/i.exec(m[0])?.[1] ?? null }] : [];
  });
/** A script's sha384, as an integrity attribute names it. */
export const sha384 = (text) => `sha384-${createHash("sha384").update(text).digest("base64")}`;
/** The names of the marks a script holds. */
export const marksIn = (text) => MARKS.filter(([, re]) => re.test(text)).map(([n]) => n);

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { app: { source, pageStatus, js: [{ url, status, integrity, sha384, found }] } }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const h = rec?.app;
  say(h !== undefined, `app read: ${h ? h.source : "none"}`);
  if (h !== undefined) {
    say(h.pageStatus === 200, `the page answers ${h.pageStatus ?? "nothing"}`);
    const js = h.js ?? [];
    say(js.length > 0 && js.every((f) => f.status === 200), `${js.length} script(s) named by the page, each answering 200`);
    // each script's bytes are the ones its page pins: the browser runs no other, so marks in another file prove nothing
    const off = js.filter((f) => typeof f.integrity !== "string" || f.integrity !== f.sha384);
    say(off.length === 0, off.length ? `not the script its page pins: ${off.map((f) => f.url).join(", ")}` : "each script is the one its page pins");
    const held = new Set(js.flatMap((f) => f.found ?? []));
    const miss = NAMES.filter((n) => !held.has(n));
    say(miss.length === 0, miss.length ? `the scripts lack: ${miss.join("; ")}` : NAMES.join("; "));
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
/** What APP_HOST serves, read with `fetchFn` (scripts/ci/bundle-checks.mjs passes one that answers from the build). */
export async function collect({ fetchFn = fetch } = {}) {
  const http = async (u) => {
    const r = await fetchFn(u, { redirect: "manual" });
    return { status: r.status, text: await r.text() };
  };
  const page = await http(APP_URL);
  const app = { source: APP_URL, pageStatus: page.status, js: [] };
  for (const { src, integrity } of scriptsOf(page.text)) {
    const f = await http(new URL(src, APP_URL).href);
    app.js.push({ url: src, status: f.status, integrity, sha384: sha384(f.text), found: marksIn(f.text) });
  }
  return { at: new Date().toISOString(), app };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const file = a.includes("--record") ? a[a.indexOf("--record") + 1] : null;
  try {
    const rec = await collect();
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${APP_URL})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `f` answers from the build
 *  folder as the host would. */
export async function bundle(f) {
  return judge(await collect({ fetchFn: f }));
}
