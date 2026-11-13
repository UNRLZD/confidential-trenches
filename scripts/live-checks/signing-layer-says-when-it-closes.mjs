#!/usr/bin/env node
// Live check of card signing-layer-says-when-it-closes on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and its code, as minified, tells an
// app on kit 1.13 or later, once, when an open's layer has closed and the app's frame is live again:
//   - the api's notice (packages/signpage/src/api.ts startApi `closed`) is { v: 1, type: "closed", id } and nothing
//     else, posted only at the current level (`closed:e=>{r===\`current\`&&a({v:1,type:\`closed\`,id:e})}`), through
//     the one post that sends what the shaper returns (`a=(t,n)=>{let r=i(t,n);r!==null&&e.parent.postMessage(r,`), r
//     being the level a hello sets (`return void(r=Jg(c))`); it is the bundle's one `type:\`closed\``;
//   - the shell (src/shell.ts) calls it once, from its one `.closed(` call: in the timer that wakes the kept frame
//     PROTECT_MS (500 ms) after a layer closed, after the frame's inert is cleared and it has focus, for each open
//     recorded since, each id once (added to the done set), and only when that open's layer was over this same frame
//     (`n.over===e&&p.closed(n.id)`): a frame taken out under a typed screen is told nothing;
//   - every open's ok answer the page makes says a notice comes (`{pending:!0,closes:!0}`, src/main.ts decide and
//     openPoolWithdraw): an app reads `closes` as this page's promise, and onClosed returns null without it.
// What an app below kit 1.13 is sent (no closes, no notice) is kit-frame-version's (the closes strip at every lower
// level); the notice's order, once-only and every way a layer ends are packages/signpage/test/shell.test.ts and
// main-closed-notice.test.ts; the kit's reading of it, all four app and page pairings, packages/kit/test/
// signpage-client-closed.test.mjs.
// The recorded answers are facts() over packages/signpage/scripts/build-app.mjs bundle(pkg) of each tree (mainnet, as
// SIGN_HOST serves; this file reaches no package code: the import check holds it).
// After: sign
//   node scripts/live-checks/signing-layer-says-when-it-closes.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signing-layer-says-when-it-closes";
export const SIGN = "https://confidential.unrealized.trade";
/** src/guard.ts PROTECT_MS: the frame stays inert this long after a layer closes, and the notice waits for it. */
export const PROTECT_MS = 500;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The api's notice: posted at the current level alone, the type and the id alone (groups: id, level, post). */
const NOTICE = /closed:([\w$]+)=>\{([\w$]+)===`current`&&([\w$]+)\(\{v:1,type:`closed`,id:\1\}\)\}/;
/** The shell's waking timer: the kept frame unlocked and focused, then each open recorded since told once, when its
 *  layer was over this frame (groups: the frame, the done set, the delay). */
const TIMER = /setTimeout\(\(\)=>\{if\([\w$]+=null,[\w$]+!==([\w$]+)\|\|![\w$]+\.hidden\)return;\1\.inert=!1,\1\.focus\?\.\(\);let ([\w$]+)=([\w$]+);\3=\[\];for\(let ([\w$]+) of \2\)([\w$]+)\.add\(\4\.id\),\5\.size>[\w$]+&&\5\.delete\(\5\.values\(\)\.next\(\)\.value\),\4\.over===\1&&[\w$]+\.closed\(\4\.id\)\},(\d+)\)/;

/** What the check keeps of the reads: the index, the served bundle's sha384, and the facts read from the bundle. */
export function facts(index, js) {
  const notice = NOTICE.exec(js);
  // the notice's post is the one through the shaper, its level the one a hello sets
  const post = notice ? new RegExp(`(?:^|[^\\w$.])${notice[3].replace(/\$/g, "\\$")}=\\(([\\w$]+),([\\w$]+)\\)=>\\{let ([\\w$]+)=[\\w$]+\\(\\1,\\2\\);\\3!==null&&[\\w$]+\\.parent\\.postMessage\\(\\3,`).exec(js) : null;
  const level = notice ? new RegExp(`return void\\(${notice[2].replace(/\$/g, "\\$")}=[\\w$]+\\([\\w$]+\\)\\)`).test(js) : false;
  const timer = TIMER.exec(js);
  return {
    index,
    sha384: sha384(js),
    notice: notice?.[0] ?? null,
    post: post?.[0] ?? null,
    level,
    notices: (js.match(/type:`closed`/g) ?? []).length,
    timer: timer?.[0] ?? null,
    delay: timer ? Number(timer[6]) : null,
    calls: (js.match(/\.closed\(/g) ?? []).length,
    opens: (js.match(/pending:!0/g) ?? []).length,
    closing: (js.match(/\{pending:!0,closes:!0\}/g) ?? []).length,
  };
}

/** The verdict on an answer { index, sha384, notice, post, level, notices, timer, delay, calls, opens, closing }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (typeof a?.notice !== "string") bad("the page has no closed notice of the type and the id alone, sent at the current level only: an app is never told an open's layer closed");
  else {
    if (typeof a.post !== "string") bad("the closed notice does not go through the shaper's one post");
    if (a.level !== true) bad("the closed notice's level is not the one a hello sets: an older kit may be sent it");
    if (a.notices !== 1) bad(`the bundle holds ${Number.isInteger(a.notices) ? a.notices : "no count of"} closed notices, not exactly one`);
  }
  if (typeof a?.timer !== "string") bad("the shell does not tell an open's close from the timer that wakes the kept frame, after it is live, once per open, only for a layer over that frame");
  else {
    if (a.delay !== PROTECT_MS) bad(`the shell tells an open's close ${a.delay} ms after it, not ${PROTECT_MS} (PROTECT_MS): the app may tap the frame while it is still inert`);
    if (a.calls !== 1) bad(`the bundle calls closed( ${Number.isInteger(a.calls) ? a.calls : "an unknown number of"} times, not exactly once (the waking timer)`);
  }
  if (!Number.isInteger(a?.opens) || a.opens < 1 || a.closing !== a.opens) bad(`${a?.closing ?? "no"} of the bundle's ${a?.opens ?? "?"} open answers say a notice comes: an app reads no closes on the others, and keeps its own bound alone`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"));
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
