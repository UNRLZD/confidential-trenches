#!/usr/bin/env node
// Live check of card sol-settle-fix-review-p3s on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - follow: a buy whose run ended "sent" hands its note to the page's late follow (src/pool-testnet.ts buyHost
//     follow -> lateFollow), never to one settle pass alone;
//   - loop: the late follow runs the settle pass, ends once no followed buy is left, and otherwise waits and runs it
//     again, the wait doubling from 2 s to 60 s (LATE_BUY_WAIT_MS), the loop ending at the session's stop (a sign out);
//     a buy that ends "sent" while it runs wakes its wait, so that buy's pass comes at once and the wait starts again
//     from 2 s; a loop whose session stopped (a sign out during its pass) waits nothing and takes no wake;
//   - none of the old shape: a follow that runs the settle pass once and leaves the buy's end to the app's next state
//     read (review P3-3 of 5253be08: the buy sat on "sent" when the lister was down or throttled for the whole run).
// What each does is held by the card's tests (packages/signpage/test/pool-testnet.test.ts "a buy that ended sent is
// settled again by the page's own passes"; the slot and refusal tests in test/pool-buy.test.ts and
// packages/wallet/test/pool-solana.test.ts W1 change no bundle). The recorded answers are facts() over a tree's
// packages/signpage/index.html and public/app.js (build-app.mjs), or SIGN_HOST's own page. This file reaches no package
// code (the import check holds it). The PR's own build runs it in scripts/ci/bundle-checks.mjs.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/sol-settle-fix-review-p3s.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "sol-settle-fix-review-p3s";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const I = "[\\w$]+"; // a minified name
const Q = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// the buy host's follow: `follow: (post) => { if (taken === null) return; lateBuys.set(taken.noteId, { r: taken, post,
// places: new Map() }); void <then> }`, `then` the late follow's call (FOLLOW) or the old single pass (OLD)
const followOf = (then) => new RegExp(String.raw`follow:(?<p>${I})=>\{(?<m>${I})!==null&&\((?<l>${I})\.set\(\k<m>\.noteId,\{r:\k<m>,post:\k<p>,places:new Map\}\),${then}\)\}`);
const FOLLOW = followOf(String.raw`(?<f>${I})\(\)`);
const OLD = followOf(String.raw`${I}\(\)\.catch\(\(\)=>\{\}\)`);
// the late follow: `const stop = solanaStop.signal; if (!locks) return; if (lateFollowing === stop) { lateNew = true;
// lateWake?.(); return; } ... let ms = LATE_BUY_WAIT_MS.min; while (!stop.aborted) { lateNew = false; await
// settleReserved().catch(() => {}); if (lateBuys.size === 0) return; if (!lateNew) await waitUnless(ms, stop); ms =
// lateNew ? LATE_BUY_WAIT_MS.min : Math.min(ms * 2, LATE_BUY_WAIT_MS.max); }`
const loopOf = (f, lateBuys) =>
  new RegExp(
    String.raw`${Q(f)}=async\(\)=>\{let (?<s>${I})=${I}\.signal;if\(${I}\)\{if\((?<g>${I})===\k<s>\)(?<n>${I})=!0,(?<k>${I})\?\.\(\);else\{\k<g>=\k<s>;try\{let (?<t>${I})=(?<w>${I})\.min;for\(;!\k<s>\.aborted;\)\{if\(\k<n>=!1,await ${I}\(\)\.catch\(\(\)=>\{\}\),${Q(lateBuys)}\.size===0\)return;\k<n>\|\|await (?<u>${I})\(\k<t>,\k<s>\),\k<t>=\k<n>\?\k<w>\.min:Math\.min\(\k<t>\*2,\k<w>\.max\)\}`,
  );
// the late follow's wait: `waitUnless = (ms, stop) => new Promise((done) => { if (stop.aborted) return done(); const end =
// () => { stop.removeEventListener("abort", end); if (lateWake === end) lateWake = null; done(); }; lateWake = end; ...`:
// the wake a new follow calls, never taken (and no wait made) by a loop whose session stopped already
const waitOf = (u, k) =>
  new RegExp(String.raw`${Q(u)}=\(${I},(?<sg>${I})\)=>new Promise\((?<d>${I})=>\{if\(\k<sg>\.aborted\)return \k<d>\(\);let (?<e>${I})=\(\)=>\{\k<sg>\.removeEventListener\(\`abort\`,\k<e>\),${Q(k)}===\k<e>&&\(${Q(k)}=null\),\k<d>\(\)\};${Q(k)}=\k<e>,`);

/** What the check keeps of SIGN_HOST's page: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const f = FOLLOW.exec(js);
  const loop = f ? loopOf(f.groups.f, f.groups.l).exec(js) : null;
  const bounds = loop ? new RegExp(String.raw`(?:^|[,;\s])${Q(loop.groups.w)}=Object\.freeze\(\{min:2e3,max:6e4\}\)`).test(js) : false;
  const wake = loop ? waitOf(loop.groups.u, loop.groups.k).test(js) : false;
  return { index, sha384: sha384(js), follow: f !== null, loop: loop !== null && bounds && wake, old: OLD.test(js) };
}

/** The verdict on an answer { index, sha384, follow, loop, old }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.follow !== true) bad("a buy that ended sent is not handed to the page's late follow");
  if (a?.loop !== true) bad("the late follow does not run the settle pass again at a wait doubling from 2 s to 60 s until no followed buy is left, a buy that ends sent meanwhile waking it");
  if (a?.old !== false) bad("the bundle still settles a buy that ended sent once, leaving its end to the app's next state read");
  return { ok: !lines.length, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
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
