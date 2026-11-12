#!/usr/bin/env node
// Live check of card restore-shows-the-balance-in-seconds: the deployed signing page walks a restore's deposit indices in
// Web Workers, so the 12 words give back the balance in seconds, not after a minute of one thread's walk. It reads what
// SIGN_HOST serves: the page, every script the page names, and /walk-worker.js, and checks:
//   - the page's script starts each lane's walk in a module Worker of this origin's /walk-worker.js
//     (packages/signpage/src/walk-workers.ts walkWorkerPort), made a TrustedScriptURL by the policy `walk-worker`;
//   - the page hands those Workers to the restore (src/main.ts: poolRestore's host carries `walkers`, its last key);
//   - /walk-worker.js is the walk itself, not the page's index a host answers for a path it has no file for: it answers
//     a lane's walk and refuses a lane outside 0 to 7 and masters that are not bigints
//     (packages/wallet/src/restore/walk.ts answerWalk).
// The page's CSP (trusted-types prover-worker walk-worker) and the walk file's own CSP are signpage-skeleton's; the
// walks' equality with the page's own walk is the packages' tests (packages/wallet/test/walk-lanes.test.ts,
// packages/signpage/test/main-walk-workers.test.ts); the seconds are the browser run's.
// After: sign --host sign
//   node scripts/live-checks/restore-shows-the-balance-in-seconds.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the marks each file holds, its pin and its sha384, not the files), so the check's
// test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "restore-shows-the-balance-in-seconds";
export const SIGN_URL = "https://confidential.unrealized.trade/";
export const WALK_PATH = "/walk-worker.js";
// a minifier may quote a string with any of the three quotes and rename any identifier
const Q = "[`\"']";
const ID = "[\\w$]+";
/** The marks, and what each file holds when the change is in place. */
export const MARKS = {
  sign: [
    ["each lane walks in a module Worker of /walk-worker.js", new RegExp(`new Worker\\(${ID}\\(\\),\\{type:${Q}module${Q},name:${Q}walk${Q}\\}\\)`)],
    ["its URL is made by the policy walk-worker", new RegExp(`${ID}=${Q}walk-worker${Q},${ID}=${Q}/walk-worker\\.js${Q}`)],
    ["the page hands the restore its Workers", new RegExp(`\\},walkers:${ID}\\}\\)`)],
  ],
  walk: [
    ["the walk Worker refuses a lane outside 0 to 7", new RegExp(`${Q}lane: not 0-7${Q}`)],
    ["the walk Worker refuses masters that are not bigints", new RegExp(`${Q}scope and masters: not bigints${Q}`)],
  ],
};
export const NAMES = { sign: MARKS.sign.map(([n]) => n), walk: MARKS.walk.map(([n]) => n) };

/** The page's scripts: the `src` of each script tag, with its `integrity` when it has one. */
export const scriptsOf = (html) =>
  [...html.matchAll(/<script\b[^>]*>/gi)].flatMap((m) => {
    const src = /\bsrc="([^"]+)"/i.exec(m[0])?.[1];
    return src ? [{ src, integrity: /\bintegrity="([^"]+)"/i.exec(m[0])?.[1] ?? null }] : [];
  });
/** A script's sha384, as an integrity attribute names it. */
export const sha384 = (text) => `sha384-${createHash("sha384").update(text).digest("base64")}`;
/** The names of `set`'s marks a file holds. */
export const marksIn = (set, text) => MARKS[set].filter(([, re]) => re.test(text)).map(([n]) => n);

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { sign: { source, pageStatus, js: [{ url, status, integrity, sha384, found }], walk: { url,
 *  status, sha384, found } } }; one that holds no host fails. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const h = rec.sign;
  say(h !== undefined, `hosts read: ${h === undefined ? "none" : "sign"}`);
  if (h !== undefined) {
    say(h.pageStatus === 200, `sign: the page answers ${h.pageStatus ?? "nothing"}`);
    const js = h.js ?? [];
    say(js.length > 0 && js.every((f) => f.status === 200), `sign: ${js.length} script(s) named by the page, each answering 200`);
    // each script's bytes are the ones its page pins: the browser runs no other, so marks in another file prove nothing
    const off = js.filter((f) => typeof f.integrity !== "string" || f.integrity !== f.sha384);
    say(off.length === 0, off.length ? `sign: not the script its page pins: ${off.map((f) => f.url).join(", ")}` : "sign: each script is the one its page pins");
    const held = new Set(js.flatMap((f) => f.found ?? []));
    const miss = NAMES.sign.filter((n) => !held.has(n));
    say(miss.length === 0, miss.length ? `sign: the scripts lack: ${miss.join("; ")}` : `sign: ${NAMES.sign.join("; ")}`);
    const w = h.walk;
    say(w?.status === 200, `sign: ${WALK_PATH} answers ${w?.status ?? "nothing"}`);
    const wmiss = NAMES.walk.filter((n) => !(w?.found ?? []).includes(n));
    say(wmiss.length === 0, wmiss.length ? `sign: ${WALK_PATH} lacks: ${wmiss.join("; ")}` : `sign: ${WALK_PATH}: ${NAMES.walk.join("; ")}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
/** What SIGN_HOST serves, read with `fetchFn` (scripts/ci/bundle-checks.mjs passes one that answers from the build). */
export async function collect({ fetchFn = fetch } = {}) {
  const http = async (u) => {
    const r = await fetchFn(u, { redirect: "manual" });
    return { status: r.status, text: await r.text() };
  };
  const page = await http(SIGN_URL);
  const sign = { source: SIGN_URL, pageStatus: page.status, js: [], walk: null };
  for (const { src, integrity } of scriptsOf(page.text)) {
    const f = await http(new URL(src, SIGN_URL).href);
    sign.js.push({ url: src, status: f.status, integrity, sha384: sha384(f.text), found: marksIn("sign", f.text) });
  }
  const w = await http(new URL(WALK_PATH, SIGN_URL).href);
  sign.walk = { url: WALK_PATH, status: w.status, sha384: sha384(w.text), found: marksIn("walk", w.text) };
  return { at: new Date().toISOString(), sign };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const h = opt("--host", "sign");
  try {
    if (h !== "sign") throw new Error(`--host sign, not ${h}`);
    const rec = await collect();
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.sign.source})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
