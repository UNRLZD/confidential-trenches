#!/usr/bin/env node
// Live check of card withdraw-form-shows-what-you-can-send on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and it carries the pool withdraw
// screen's marks (packages/signpage/src/withdraw/pool-form.ts, ./chain-mark.ts):
//   - each pool chain's mark, Solana, Base and Robinhood, as a data: URL whose bytes are the app's own brand file
//     (apps/terminal/src/screens/market/logos/, their sha256 written out here as MARKS);
//   - what can be sent, drawn as a control whose action is `sendable`;
//   - the To field's cleaning of what a paste carries, the one pattern [\p{White_Space}\p{Cf}] with the u flag.
// What the screen does with them (the value is the largest the amount check accepts, a tap fills it, a paste's address
// passes, the press hands over only what was drawn) is held by packages/signpage/test/pool-withdraw-sendable.test.ts and
// pool-withdraw-paste.test.ts, and drawn in Chrome under the page's policy by test/pool-withdraw-screens/run.mjs.
// The recorded answers are facts() over packages/signpage/scripts/build-app.mjs builds (mainnet, as SIGN_HOST serves).
// After: sign
//   node scripts/live-checks/withdraw-form-shows-what-you-can-send.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "withdraw-form-shows-what-you-can-send";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** The app's chain marks (apps/terminal/src/screens/market/logos/), sha256 of each file. */
export const MARKS = Object.freeze({
  solana: "3d3401109aa061dec40a8659f1847817a8e647f98de1e65e76e86a95bbe1f08a",
  base: "b4f2b487011713f98481cc53c4ce095629b4876acbdbc2f0f3ad69a9688ba82e",
  robinhood: "ba5ceda948b2ae29cde81074262f848a5a5480093ce8fc4d1bc147934cc6102b",
});
const DATA = /data:image\/(?:svg\+xml|png);base64,([A-Za-z0-9+/]+=*)/g;
/** The cleaning pattern as the bundler keeps a regular expression literal: its source and its u flag. */
const CLEAN = /\/\[\\p\{White_Space\}\\p\{Cf\}\]\/[a-z]*u[a-z]*/;
const SENDABLE = /[`"']sendable[`"']/;

/** What the check keeps of the reads: the index, the served bundle's sha384, and the facts read from the bundle. */
export function facts(index, js) {
  return {
    index,
    sha384: sha384(js),
    marks: [...new Set([...js.matchAll(DATA)].map((m) => sha256(Buffer.from(m[1], "base64"))))].sort(),
    clean: CLEAN.exec(js)?.[0] ?? null,
    sendable: SENDABLE.test(js),
  };
}

/** The verdict on an answer { index, sha384, marks, clean, sendable }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  const missing = Object.entries(MARKS).filter(([, h]) => !(Array.isArray(a?.marks) && a.marks.includes(h))).map(([c]) => c);
  if (missing.length) bad(`the bundle draws no mark of ${missing.join(", ")} as the app's own file: the withdraw screen does not show its chain`);
  if (a?.sendable !== true) bad("the bundle has no sendable control: the withdraw screen does not show what can be sent");
  if (typeof a?.clean !== "string") bad("the bundle does not take what a paste carries out of To: a pasted address with an invisible character is refused");
  return { ok: lines.length === 0, lines };
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
