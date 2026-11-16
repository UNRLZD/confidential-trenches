#!/usr/bin/env node
// Live check of card signpage-tab-title-and-origin (the QA walk of 16 Nov 18:00Z, items 9 and 18). SIGN_HOST is the top
// window and frames APP_HOST (packages/signpage/src/shell.ts), so its own index.html names the browser tab, and its shell
// is what posts to the frame. It reads what SIGN_HOST serves:
//   - index.html's head holds one <title>, the app's name (NAME, the framed app's own title in apps/terminal/index.html;
//     the test holds the two equal): the tab reads it on every page;
//   - the served /app.js is the one index.html pins (its sha384);
//   - in that /app.js the shell's frame (the function that throws "the APP_HOST frame has no window") becomes the
//     shell's peer in its own load listener, never at its insertion: until its first load the frame's window holds its
//     first about:blank, on SIGN_HOST's origin, and a post to it then is the console's "target origin
//     'https://ct-app.unrealized.trade' does not match 'https://confidential.unrealized.trade'" (a sign-in's state change
//     posted right after the words screen closed). Read on the minified text; the bundle checks run this on every pull
//     request's own build, so a reshaped bundle fails there, before a deploy.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/signpage-tab-title-and-origin.mjs [--site <dir>] [--record <file>] [--answer <file>]
// --site reads a build folder (its index.html and public/app.js) in place of SIGN_HOST. PASS exit 0, FAIL exit 1, error
// exit 2. --record writes the answer read; --answer replays one (the test's).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SIGN = "https://confidential.unrealized.trade";
/** The app's name, as the framed app's index.html sets it. */
export const NAME = "Confidential Trenches";
/** The shell's own error when the frame it made has no window: it sits in the function that makes the frame. */
export const FRAME_MARK = "the APP_HOST frame has no window";

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const esc = (s) => s.replace(/[$]/g, "\\$&");

/** The function that makes the frame, from its createElement("iframe") to the end of the statement after FRAME_MARK's
 *  throw; null when /app.js holds no such function. */
export function frameCode(js) {
  const at = js.indexOf(FRAME_MARK);
  if (at < 0) return null;
  const start = Math.max(js.lastIndexOf("createElement(`iframe`)", at), js.lastIndexOf('createElement("iframe")', at));
  const end = js.indexOf("}", at + FRAME_MARK.length);
  if (start < 0 || end < 0 || at - start > 2_000) return null;
  return js.slice(start, end + 1);
}

/** The verdict on an answer { index, app: { sha384, frame } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const index = a.index ?? "";
  const head = /<head>([\s\S]*?)<\/head>/.exec(index)?.[1] ?? "";
  const titles = [...head.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
  if (titles.length !== 1) bad(`index.html's head holds ${titles.length} <title>, not one: the tab reads ${titles.length ? JSON.stringify(titles) : "the address"}`);
  else if (titles[0] !== NAME) bad(`the tab reads ${JSON.stringify(titles[0])}, not the app's name ${JSON.stringify(NAME)}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1];
  if (!pin) bad("index.html pins no /app.js");
  else if (pin !== a.app?.sha384) bad("the served /app.js is not the one index.html pins");
  const code = a.app?.frame ?? null;
  if (code === null) bad(`the served /app.js holds no frame of the shell's ("${FRAME_MARK}")`);
  else {
    const win = /(\w+)=\w+\.contentWindow\b/.exec(code)?.[1];
    const onLoad = /addEventListener\([`"']load[`"'],\(\)=>\{([^}]*)\}/.exec(code)?.[1];
    const tail = code.slice(code.indexOf(FRAME_MARK) + FRAME_MARK.length);
    if (!win) bad("the shell's frame code reads no contentWindow");
    else if (onLoad === undefined) bad("the shell's frame has no load listener");
    else {
      const sets = new RegExp(`(?:^|[^\\w$.])\\w+=${esc(win)}(?![\\w$])`);
      if (sets.test(tail)) bad("the shell posts to its frame from its insertion: the peer is its window before its first load (its about:blank, on SIGN_HOST's origin)");
      if (!sets.test(onLoad)) bad("the shell's frame does not become its peer in its own load listener");
    }
  }
  if (!lines.length) lines.push(`OK the tab reads ${JSON.stringify(NAME)}; the pinned /app.js makes its frame the peer from its load on, nothing posted to it before`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

const answerOf = (index, js) => ({ index, app: { sha384: sha384(js), frame: frameCode(js) } });

/** Reads SIGN_HOST, or a build folder. */
export async function read(site) {
  if (site) return answerOf(readFileSync(path.join(site, "index.html"), "utf8"), readFileSync(path.join(site, "public", "app.js"), "utf8"));
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
    console.log(v.ok ? "PASS signpage-tab-title-and-origin" : "FAIL signpage-tab-title-and-origin");
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR signpage-tab-title-and-origin: ${e?.message ?? e}`);
    process.exit(2);
  }
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `dirs` names the build folders. */
export async function bundle(f, { dirs }) {
  return judge(await read(dirs.sign));
}
