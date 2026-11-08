#!/usr/bin/env node
// Live check of card terminal-harness-sign-spa: the terminal's own test harness serves the signing page as SIGN_HOST
// does. SIGN_HOST is a Pages project with no 404.html, so a path with no file answers its index: 200 text/html, the same
// bytes as / (read 8 Nov 07:31Z: /favicon.ico, /_headers and /no-such-path, the 382-byte index). The harness
// (apps/terminal/test/harness/harness.mjs defaultSites) serves sign.ct.test with spa: true, so a terminal e2e run never
// passes or fails on a 404 the live page never gives (sign-harness-like-live made every live-check harness so; this one
// was left).
// It reads SIGN_HOST's /, /favicon.ico, /_headers and /no-such-path, and the harness's own site map, and passes when
// each path answers 200 text/html with the index's bytes (sha256) and the harness serves SIGN_HOST's build with spa;
// it fails when SIGN_HOST answers a path with no file otherwise (a 404.html shipped, the _headers file served) or the
// harness does not fall back, since then the two differ.
// After: sign
//   node scripts/live-checks/terminal-harness-sign-spa.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultSites, HOSTS } from "../../apps/terminal/test/harness/harness.mjs";

const KEY = "terminal-harness-sign-spa";
export const SIGN_ORIGIN = "https://confidential.unrealized.trade";
/** The paths with no file on SIGN_HOST that a run reads, after the index itself. */
export const PATHS = Object.freeze(["/favicon.ico", "/_headers", "/no-such-path"]);

/** One answer as the record keeps it: status, content type, length and the body's sha256. */
async function answer(f, url) {
  const r = await f(url, { redirect: "manual" });
  const body = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get("content-type"), bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
}

/** The read: SIGN_HOST's index and PATHS, and whether the harness's SIGN_HOST site falls back to its index. */
export async function read(f = fetch, origin = SIGN_ORIGIN) {
  const answers = {};
  for (const p of ["/", ...PATHS]) answers[p] = await answer(f, `${origin}${p}`);
  return { origin, answers, harness: { sign: HOSTS.sign, spa: defaultSites("/nonexistent")[HOSTS.sign]?.spa === true } };
}

/** The verdict on one read: { pass, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const index = rec.answers?.["/"];
  const html = (a) => /^text\/html\b/.test(a?.type ?? "");
  say(index?.status === 200 && html(index) && index.bytes > 0, `SIGN_HOST's index: ${index?.status ?? "no answer"} ${index?.type ?? ""}, ${index?.bytes ?? 0} bytes`);
  for (const p of PATHS) {
    const a = rec.answers?.[p];
    const same = a?.status === 200 && html(a) && a.sha256 === index?.sha256;
    say(same, `SIGN_HOST ${p}: ${a?.status ?? "no answer"} ${a?.type ?? ""}, ${a?.bytes ?? 0} bytes, ${a?.sha256 === index?.sha256 ? "the index" : "not the index"}`);
  }
  say(rec.harness?.spa === true, `the terminal's harness serves ${rec.harness?.sign ?? "SIGN_HOST"} ${rec.harness?.spa ? "with" : "without"} the index for a path with no file`);
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  try {
    const rec = await read();
    if (a.includes("--record")) writeFileSync(a[a.indexOf("--record") + 1], `${JSON.stringify({ at: new Date().toISOString(), ...rec }, null, 1)}\n`);
    const { pass, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${pass ? "PASS" : "FAIL"}`);
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
