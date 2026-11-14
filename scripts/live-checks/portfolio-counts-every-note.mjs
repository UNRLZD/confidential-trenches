#!/usr/bin/env node
// Live check of card portfolio-counts-every-note on SIGN_HOST (https://confidential.unrealized.trade).
// What it holds, signed out, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as
// minified, the page's state answer (src/api.ts): the state read, its answer posted, then, when the read took
// STATE_SLOW_MS or longer from the request's arrival, a console line naming the time and the same state posted as a
// `state` event too. The app's kit drops a state answer past its 5 s wait and keeps its last state (the owner's
// Portfolio on 14 Nov 11:06Z showed totals hours old); an event has no wait, so the app gets the newest state.
// What it does is held by packages/signpage/test/api.test.ts ("a state answer slower than the app's wait"); the
// reader half (one refused note record never zeroes the others) by packages/signpage/test/state-counts-every-note.test.ts.
// The recorded answers are facts() over each tree's packages/signpage/index.html and app.js as build-app.mjs builds them.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/portfolio-counts-every-note.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "portfolio-counts-every-note";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const ID = "[\\w$]+";
// the read, its answer, then the slow one named and posted again as a state event, the same state
const SLOW = new RegExp(
  `let (${ID})=await ${ID}\\(\\);${ID}\\(\\{v:1,id:${ID},ok:!0,result:\\1\\},${ID}\\);let (${ID})=${ID}\\(\\)-${ID};\\2>=${ID}&&\\(console\\.warn\\(\`state read took \\$\\{\\2\\} ms[^\`]*\`\\),${ID}\\(\\{v:1,type:\`state\`,state:\\1\\}\\)\\)`,
);

/** What the check keeps of the reads: the index, the served bundle's sha384, and whether the bundle holds the mark. */
export function facts(index, js) {
  return { index, sha384: sha384(js), slow: SLOW.test(js) };
}

/** The verdict on an answer { index, sha384, slow }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.slow !== true) bad("a state answer slower than the app's wait is not posted again as a state event: the app can stay on an older state");
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
