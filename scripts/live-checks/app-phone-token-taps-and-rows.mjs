#!/usr/bin/env node
// Live check of card app-phone-token-taps-and-rows: on a phone the token page's chart marks are tapped through a 44 px
// area while each stays 12 px to the eye, and the trades list holds still as trades arrive (app-shell run 42773072293:
// "tap under 44 px: button.tm:12x12" on phone / and /verify, and CLS 0.0039 from a div.tkl-trow.tkl-tr moved 44 px by a
// trade arriving above it). The read is app-shell's (app-shell.mjs collect): every route at 390 x 844 (phone, dpr 2,
// touch) and 1440 x 900 inside SIGN_HOST's shell, the token page's tape planted on every run (plantTape: marks in the
// chart's own bars, one more trade pushed every 400 ms), so the page is judged with marks and arriving trades whatever
// the live token's book holds. This check judges the token page's loads:
//   - the phone's token page (TOKEN_PAGE: the first token its "/" lists; since 12 Nov the phone's "/" and the page under
//     Verify's panel are the Trenches list): marks drawn, each 12 x 12 px, no tap target under 44 px;
//   - that page on the phone and / on the desktop: trade rows drawn, 2 trades or more arrived while it settled;
//   - each of them at CLS 0 (every shift counted, the hadRecentInput exclusion not applied), inside SIGN_HOST's shell.
// The rest of each load (CSP, integrity, console, text size) is app-shell's to judge.
// After: app
// Bundle: out a browser
//   node scripts/live-checks/app-phone-token-taps-and-rows.mjs [--url <origin>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (app-shell's record) to <file>; apps/terminal/test/bar10/run.mjs --record writes the
// same record from the build in the harness, which the check's test replays.
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collect, shiftsOf, TOKEN_PAGE } from "./app-shell.mjs";

const KEY = "app-phone-token-taps-and-rows";
/** APP_HOST, the terminal's address, held in each app-* check as its own literal (check-deploy.test.ts). */
export const APP_HOST = "https://ct-app.unrealized.trade";
/** The loads judged: [width, path, route drawn]. */
export const LOADS = [
  ["phone", TOKEN_PAGE, "token"],
  ["desktop", "/", "token"],
];
const MARK_PX = 12;

export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const [w, p, id] of LOADS) {
    const l = (rec.loads ?? []).find((x) => x.width === w && x.path === p);
    if (!l) {
      say(false, `${w} ${p}: not loaded`);
      continue;
    }
    const t = l.tape ?? {};
    const bad = [];
    if (l.framed !== true) bad.push(`not inside SIGN_HOST's shell (top window at ${l.top ?? "unknown"})`);
    if (l.route !== id) bad.push(`drew ${l.route ?? "nothing"}`);
    if (w === "phone") {
      if (!(t.marks > 0)) bad.push("no trade mark on the chart");
      else if (t.markPx?.[0] !== MARK_PX || t.markPx?.[1] !== MARK_PX) bad.push(`a mark drawn ${t.markPx ? t.markPx.join("x") : "at no size"} px, want ${MARK_PX}x${MARK_PX}`);
      if (l.smallTaps?.length) bad.push(`tap under 44 px: ${l.smallTaps.join(", ")}`);
    }
    if (id === "token") {
      if (!(t.rows > 0)) bad.push("no trade row");
      if (!(t.pushed >= 2)) bad.push(`${t.pushed ?? 0} trade(s) arrived while it settled, want 2 or more`);
    }
    if (l.cls !== 0) bad.push(`CLS ${Number(l.cls).toFixed(4)} above 0${shiftsOf(l.shifts)}`);
    say(bad.length === 0, `${w} ${p} (${id}): ${bad.length ? bad.join("; ") : `${t.marks} mark(s)${w === "phone" ? ` at ${t.markPx.join("x")} px, every tap 44 px or more` : ""}${id === "token" ? `, ${t.rows} row(s), ${t.pushed} trade(s) arrived` : ""}, CLS 0`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ url: opt("--url", APP_HOST), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (Chrome ${rec.browser})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
