#!/usr/bin/env node
// Live check of card evm-quote-reads-need-no-old-state: SIGN_HOST serves a page whose Base and Robinhood reads of state
// at an older block need no provider that has dropped it. Two reads asked for it (packages/kit/src/checks/evm):
// - the pool index's one-reader state read (pool-index.ts F5) went to the sync's pinned block N, seconds to minutes old
//   once the spans were read, and a reader keeping only the newest blocks' state answered -32000 "historical state ...
//   is not available"; it now reads at the newest block both readers agree on, at or past N (MARK_INDEX, its refusal
//   when they agree on none);
// - a ban's evidence (quote.ts blamed: the replay at the trade's parent block, the system slots and the market read
//   there) walked the quote list alone, where on Robinhood bloXroute and Globalstake answer -32000 at every age; it now
//   walks the venue's read list first (evmEvidenceProviders, MARK_EVIDENCE, its refusal).
// It passes only when, on SIGN_HOST:
//   1. the served /app.js is the one its index.html pins (sha384);
//   2. the bundle carries the index's state read at the newest agreed block (MARK_INDEX);
//   3. the bundle carries the evidence's walk list (MARK_EVIDENCE).
// What it cannot see from outside: a sync or a ban run on the page; the card's tests hold them
// (packages/kit/test/evm-pool-index.test.ts "F5's state read needs no old block", packages/kit/test/
// evm-quote-attacks.test.ts "card evm-quote-reads-need-no-old-state").
// After: sign
// Bundle: out SIGN_HOST's index.html and /app.js
//   node scripts/live-checks/evm-quote-reads-need-no-old-state.mjs [--record <file>] [--dir <build dir>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read (the pin, the bundle's sha384 and the two
//   marks' counts), so the check's test can replay it; --dir reads a build-app.mjs --out folder in place of SIGN_HOST.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "evm-quote-reads-need-no-old-state";
export const SIGN = "https://confidential.unrealized.trade";
/** pool-index.ts: the sync's refusal when its readers agree on no block at or past N for the state reads. */
export const MARK_INDEX = "the index readers agree on no block at or past N to read the PoolManager's state at";
/** quote.ts evmEvidenceProviders' refusal: only the evidence's walk list carries it. */
export const MARK_EVIDENCE = "a ban's evidence has no providers on ";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const count = (js, m) => js.split(m).length - 1;

/** What the check keeps of a page: its index's /app.js pin, the served bundle's sha384 and the two marks' counts. */
export function pageFacts(index, js) {
  return { pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null, sha384: sha384(js), marks: { index: count(js, MARK_INDEX), evidence: count(js, MARK_EVIDENCE) } };
}

/** The verdict on one recorded read: { ok, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const f = rec?.facts ?? {};
  say(typeof f.pin === "string" && f.pin === f.sha384, `the served /app.js is the one index.html pins (${f.pin ?? "no pin"})`);
  say(Number.isInteger(f.marks?.index) && f.marks.index >= 1, `the pool index reads one-reader pools' state at the newest block both readers agree on (${f.marks?.index ?? "unread"} marks)`);
  say(Number.isInteger(f.marks?.evidence) && f.marks.evidence >= 1, `a ban's evidence walks the operators that keep the trade's block (${f.marks?.evidence ?? "unread"} marks)`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

async function read(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    const d = process.argv.indexOf("--dir");
    const dir = d > 0 ? process.argv[d + 1] : null;
    const [index, js] = dir !== null ? [readFileSync(path.join(dir, "index.html"), "utf8"), readFileSync(path.join(dir, "app.js"), "utf8")] : await Promise.all([read(`${SIGN}/`), read(`${SIGN}/app.js`)]);
    const rec = { source: dir !== null ? "build-app.mjs --out" : `live ${SIGN}`, at: new Date().toISOString(), facts: pageFacts(index, js) };
    const i = process.argv.indexOf("--record");
    if (i > 0) writeFileSync(process.argv[i + 1], `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, ${rec.at})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.stack ?? e}`);
    process.exit(2);
  }
}
