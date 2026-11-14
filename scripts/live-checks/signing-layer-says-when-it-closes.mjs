#!/usr/bin/env node
// Live check of card signing-layer-says-when-it-closes on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and its code, as minified, tells an
// app on kit 1.13 or later exactly once that an open answered closes: true has ended, with the app's frame live again:
//   - the api's notice (packages/signpage/src/api.ts startApi `closed`) is { v: 1, type: "closed", id } and nothing
//     else, posted only once a hello read since the frame's last ready named the current level
//     (`closed:e=>{i&&r===\`current\`&&o({v:1,type:\`closed\`,id:e})}`), through the one post that sends what the
//     shaper returns (`o=(t,n)=>{let r=a(t,n);r!==null&&e.parent.postMessage(r,`); the hello sets the level and the flag
//     together (`return void(r=Jg(l),i=!0)`), and each ready clears the flag at once, its queued reset setting the level
//     back after any hello the old document sent before it (`p=()=>{i=!1,d=d.then(()=>{r=\`1.4\`,`); it is the bundle's
//     one `type:\`closed\``;
//   - the shell (src/shell.ts) records each open's id over the frame it opened over (`open`), moves the ids shown on to
//     be told at its close and wakes the frame (`close`), takes an open that showed no layer the same way (`told`), and
//     calls the notice once, from its one `.closed(` call: in the timer that wakes the kept frame PROTECT_MS (500 ms)
//     after, once the frame's inert is cleared and it has focus, each id once (the done set), and only when that open's
//     layer was over this same frame (`n.over===e&&p.closed(n.id)`): a frame taken out under a typed screen is told
//     nothing. The four share one list of ids shown, one of ids to tell, one done set and one frame;
//   - every open's ok answer the page makes says a notice comes (`{pending:!0,closes:!0}`, src/main.ts decide and
//     openPoolWithdraw), and each runs through runOpen, whose step opens the layer with the open's id (openLayer passes
//     it to the shell's open) or, when the run ends with none (a page not shown, a read that failed), has the shell tell
//     it (`.finally(()=>{n||Q1?.told(e)})`): an app reads `closes` as this page's promise, and onClosed returns null
//     without it.
// What an app below kit 1.13 is sent (no closes, no notice) is kit-frame-version's (the closes strip at every lower
// level); the notice's order, once-only and every way an open ends are packages/signpage/test/shell.test.ts,
// main-closed-notice.test.ts and main-closed-notice-ends.test.ts; the kit's reading of it, all four app and page
// pairings, packages/kit/test/signpage-client-closed.test.mjs.
// The recorded answers are facts() over packages/signpage/scripts/build-app.mjs bundle(pkg) of each tree (mainnet, as
// SIGN_HOST serves; this file reaches no package code: the import check holds it).
// After: sign
// Bundle: read sign
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

/** The api's notice: posted with a hello read since the last ready, at the current level alone, the type and the id
 *  alone (groups: id, hello flag, level, post); from kit 1.14 (card solana-buy-preview-complete) at the current level
 *  or kit-v1.13's, the two that read it, as NOTICE_1_14 (its groups the same, in the same order); from kit 1.15 (card
 *  one-balance-buys-on-every-chain) kit-v1.14's level too, in the same expression. */
const NOTICE = /closed:([\w$]+)=>\{([\w$]+)&&([\w$]+)===`current`&&([\w$]+)\(\{v:1,type:`closed`,id:\1\}\)\}/;
const NOTICE_1_14 = /closed:([\w$]+)=>\{!([\w$]+)\|\|([\w$]+)!==`current`(?:&&\3!==`1\.14`)?&&\3!==`1\.13`\|\|([\w$]+)\(\{v:1,type:`closed`,id:\1\}\)\}/;
const esc = (v) => v.replace(/\$/g, "\\$");
/** The shell's open: the id recorded to tell, over the frame it opened over, unless done, shown or to tell already
 *  (groups: id, done, shown, to tell, frame). */
const OPEN = /open\([\w$]+=!1,([\w$]+)\)\{\1===void 0\|\|([\w$]+)\.has\(\1\)\|\|([\w$]+)\.some\(([\w$]+)=>\4\.id===\1\)\|\|([\w$]+)\.some\(([\w$]+)=>\6\.id===\1\)\|\|\3\.push\(\{id:\1,over:([\w$]+)\}\),/;
/** The shell's close: the ids shown moved on to tell, then the frame woken (groups: to tell, shown, frame, wake). */
const CLOSE = /close\(\)\{if\([\w$]+\.hidden=!0,[\w$]+=null,([\w$]+)\.push\(\.\.\.([\w$]+)\),\2=\[\],!([\w$]+)\)\{[^}]*\}([\w$]+)\(\3\)\}/;
/** The shell's told: an open that showed no layer, to tell over this frame, the frame woken; while a layer shows, at its
 *  close (groups: id, done, shown, to tell, frame, wake). */
const TOLD = /told\(([\w$]+)\)\{if\(!\(([\w$]+)\.has\(\1\)\|\|([\w$]+)\.some\(([\w$]+)=>\4\.id===\1\)\|\|([\w$]+)\.some\(([\w$]+)=>\6\.id===\1\)\)\)\{if\(![\w$]+\.hidden\|\|!([\w$]+)\)return void \3\.push\(\{id:\1,over:\7\}\);\5\.push\(\{id:\1,over:\7\}\),([\w$]+)\(\7\)\}\}/;
/** The shell's wake: the frame inert, then after the delay live and focused, each id to tell told once, when its layer
 *  was over this frame (groups: wake, frame, the shell's frame, to tell, done, delay). */
const TIMER = /function ([\w$]+)\(([\w$]+)\)\{\2\.inert=!0,([\w$]+)!==null&&clearTimeout\(\3\),\3=setTimeout\(\(\)=>\{if\(\3=null,([\w$]+)!==\2\|\|![\w$]+\.hidden\)return;\2\.inert=!1,\2\.focus\?\.\(\);let ([\w$]+)=([\w$]+);\6=\[\];for\(let ([\w$]+) of \5\)([\w$]+)\.add\(\7\.id\),\8\.size>[\w$]+&&\8\.delete\(\8\.values\(\)\.next\(\)\.value\),\7\.over===\2&&[\w$]+\.closed\(\7\.id\)\},(\d+)\)\}/;
/** main.ts runOpen: the step's layer() opens the id's layer, or the run's end has the shell tell it (groups: runOpen,
 *  id, step, its flag, openLayer). */
const RUN_OPEN = /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{let ([\w$]+)=!1;[\w$]+\(\(\)=>\3\(\(\)=>\{([\w$]+)\(\2\),\4=!0\}\)\)\.finally\(\(\)=>\{\4\|\|[\w$]+\?\.told\(\2\)\}\)\}/;

/** What the check keeps of the reads: the index, the served bundle's sha384, and the facts read from the bundle. */
export function facts(index, js) {
  const notice = NOTICE.exec(js) ?? NOTICE_1_14.exec(js);
  // the notice's post is the one through the shaper; its level and flag the ones a hello sets, the flag cleared by ready
  const post = notice ? new RegExp(`(?:^|[^\\w$.])${esc(notice[4])}=\\(([\\w$]+),([\\w$]+)\\)=>\\{let ([\\w$]+)=[\\w$]+\\(\\1,\\2\\);\\3!==null&&[\\w$]+\\.parent\\.postMessage\\(\\3,`).exec(js) : null;
  const level = notice ? new RegExp(`return void\\(${esc(notice[3])}=[\\w$]+\\([\\w$]+\\),${esc(notice[2])}=!0\\)`).test(js) : false;
  const fresh = notice ? new RegExp(`=\\(\\)=>\\{${esc(notice[2])}=!1,([\\w$]+)=\\1\\.then\\(\\(\\)=>\\{${esc(notice[3])}=\`[^\`]+\`,`).test(js) : false;
  const timer = TIMER.exec(js);
  const open = OPEN.exec(js);
  const close = CLOSE.exec(js);
  const told = TOLD.exec(js);
  const run = RUN_OPEN.exec(js);
  // openLayer passes its own id to the shell's open, as its last argument
  const layer = run ? new RegExp(`function ${esc(run[5])}\\(([\\w$]+)\\)\\{[\\w$]+\\?\\.open\\((?:[^()]|\\([^()]*\\))*,\\1\\)`).test(js) : false;
  // one list of ids shown, one to tell, one done set, one frame and one wake across open, close, told and the timer
  const tied =
    !!(timer && open && close && told) &&
    new Set([open[3], close[2], told[3]]).size === 1 &&
    new Set([open[5], close[1], told[5], timer[6]]).size === 1 &&
    new Set([open[2], told[2], timer[8]]).size === 1 &&
    new Set([open[7], close[3], told[7], timer[4]]).size === 1 &&
    new Set([close[4], told[8], timer[1]]).size === 1;
  return {
    index,
    sha384: sha384(js),
    notice: notice?.[0] ?? null,
    post: post?.[0] ?? null,
    level,
    fresh,
    notices: (js.match(/type:`closed`/g) ?? []).length,
    timer: timer?.[0] ?? null,
    delay: timer ? Number(timer[9]) : null,
    calls: (js.match(/\.closed\(/g) ?? []).length,
    open: open?.[0] ?? null,
    close: close?.[0] ?? null,
    told: told?.[0] ?? null,
    tied,
    run: run?.[0] ?? null,
    layer,
    opens: (js.match(/pending:!0/g) ?? []).length,
    closing: (js.match(/\{pending:!0,closes:!0\}/g) ?? []).length,
    routed: run ? (js.match(new RegExp(`\\{pending:!0,closes:!0\\},then:\\(\\)=>${esc(run[1])}\\(`, "g")) ?? []).length : 0,
  };
}

/** The verdict on an answer { index, sha384, notice, post, level, fresh, notices, timer, delay, calls, open, close, told,
 *  tied, run, layer, opens, closing, routed }. */
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
    if (a.fresh !== true) bad("a ready does not clear the closed notice's hello at once, its queued reset setting the level back: a new app document may be sent it at the old one's level");
    if (a.notices !== 1) bad(`the bundle holds ${Number.isInteger(a.notices) ? a.notices : "no count of"} closed notices, not exactly one`);
  }
  if (typeof a?.timer !== "string") bad("the shell does not tell an open's close from the timer that wakes the kept frame, after it is live, once per open, only for a layer over that frame");
  else {
    if (a.delay !== PROTECT_MS) bad(`the shell tells an open's close ${a.delay} ms after it, not ${PROTECT_MS} (PROTECT_MS): the app may tap the frame while it is still inert`);
    if (a.calls !== 1) bad(`the bundle calls closed( ${Number.isInteger(a.calls) ? a.calls : "an unknown number of"} times, not exactly once (the waking timer)`);
  }
  if (typeof a?.open !== "string") bad("the shell's open does not record its id over the frame it opened over: no layer's close tells its open");
  if (typeof a?.close !== "string") bad("the shell's close does not move the ids shown on to be told and wake the frame: no open is told its layer closed");
  if (typeof a?.told !== "string") bad("the shell has no told: an open that ends with no layer shown is never told");
  if (typeof a?.timer === "string" && typeof a.open === "string" && typeof a.close === "string" && typeof a.told === "string" && a.tied !== true) bad("the shell's open, close, told and waking timer do not share one list of ids to tell, one done set and one frame: an open may be told twice or never");
  if (typeof a?.run !== "string") bad("the page's opens do not end through one run that opens the id's layer or else has the shell tell it: an open that shows no layer is never told");
  else if (a.layer !== true) bad("the page's layer opens without its open's id: the shell records nothing to tell");
  if (!Number.isInteger(a?.opens) || a.opens < 1 || a.closing !== a.opens) bad(`${a?.closing ?? "no"} of the bundle's ${a?.opens ?? "?"} open answers say a notice comes: an app reads no closes on the others, and keeps its own bound alone`);
  else if (typeof a?.run === "string" && a.routed !== a.opens) bad(`${Number.isInteger(a?.routed) ? a.routed : "no"} of the bundle's ${a.opens} open answers that say a notice comes end through that run: the others may end untold`);
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
