#!/usr/bin/env node
// Live check of card signpage-throttled-read-is-not-asked-again-at-once on SIGN_HOST (https://confidential.unrealized.trade).
// What it holds, and only that: the served /app.js is the one index.html pins (its sha384), it is a released build from
// release-114 on (a packages/signpage/releases/release-<N>.json, N >= 114, names its sha384 for SIGN_HOST), and in it,
// as minified, the holdings readers' throttle rule (packages/wallet/src/throttle.ts, src/pool/buy-wallets.ts):
//   - rule: the wait after a throttle is a pause doubling from 1 s to 10 s, a Retry-After the wait only when longer,
//     finite and above 0, held to 10 s (throttleWaitMs and its bounds);
//   - gate: one provider's gate on that rule, whose round's throttles count once (by epoch) and whose pause goes back
//     to none only after a whole round (ThrottleGate);
//   - held: before each round a reader waits the gate, and refuses, asking nothing, a wait that would end past its read's
//     bound, which is 30 s (HOLDINGS_THROTTLE_MAX_MS);
//   - reader: the page's holdings reader (Solana's; the EVM one is in no SIGN_HOST path, so not in the bundle) waits
//     the gate before each round, and the helper's route gives its readers a gate of its own (never the trade path's);
//   - none of the old shape: no flat wait after a 429 (the old waitAfter: the route's Retry-After or 1 s, every round).
// What each does is held by the card's tests (packages/wallet/test/throttle.test.ts: calls under 60 s of 429s on both
// transports, a run of buys ending, a one-method throttle, Retry-After, the sell's bound, the trade path unheld;
// test/buy-wallets.test.ts; packages/signpage/test/positions.test.ts: the cache, the buys and a sell on a provider its
// own asks throttle). The recorded answers are facts() over a tree's packages/signpage/index.html and public/app.js
// (build-app.mjs), or SIGN_HOST's own page. This file reaches no package code (the import check holds it). The PR's own
// build runs judge(read, { ledger: false }) in scripts/ci/bundle-checks.mjs, since it is cut as a release only after
// its merge.
// After: sign
//   node scripts/live-checks/signpage-throttled-read-is-not-asked-again-at-once.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "signpage-throttled-read-is-not-asked-again-at-once";
export const SIGN = "https://confidential.unrealized.trade";
/** The first release whose holdings readers hold the rule: release-113 is the last cut before it. */
export const FIXED_FROM = 114;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
const esc = (n) => n.replace(/\$/g, "\\$");
const count = (js, re) => (js.match(new RegExp(re.source, "g")) ?? []).length;

// the bounds and the rule: `B = Object.freeze({ firstMs: 1e3, maxMs: 1e4, afterMaxMs: 1e4 }); function f(prev, after, b = B)
// { let pause = isFinite(prev) && prev > 0 ? min(prev * 2, b.maxMs) : b.firstMs, a = typeof after == number && isFinite(after)
// && after > 0 ? min(after, b.afterMaxMs) : 0; return max(pause, a) }`
const BOUNDS = new RegExp(String.raw`(?<b>${I})=Object\.freeze\(\{firstMs:1e3,maxMs:1e4,afterMaxMs:1e4\}\)`);
const RULE = (b) => new RegExp(String.raw`function (?<f>${I})\((${I}),(${I}),(${I})=${esc(b)}\)\{let (${I})=Number\.isFinite\(\2\)&&\2>0\?Math\.min\(\2\*2,\4\.maxMs\):\4\.firstMs,(${I})=typeof \3==\`number\`&&Number\.isFinite\(\3\)&&\3>0\?Math\.min\(\3,\4\.afterMaxMs\):0;return Math\.max\(\5,\6\)\}`);
// the gate: left() the time to its opening; a throttle of the current epoch moves the epoch and grows the pause by the
// rule; answered() of the current epoch sets the pause to none
const GATE = (b, f) => new RegExp(String.raw`(?<g>${I})=class\{#(${I})=0;#(${I})=0;#(${I})=0;#(${I});#(${I});constructor\((${I})=\{\}\)\{this\.#\5=\7\.now\?\?Date\.now,this\.#\6=\7\.bounds\?\?${esc(b)}\}left\(\)\{return Math\.max\(0,this\.#\2-this\.#\5\(\)\)\}epoch\(\)\{return this\.#\4\}throttled\((${I}),(${I})\)\{if\(\8===this\.#\4\)\{this\.#\4\+\+,this\.#\3=${esc(f)}\(this\.#\3,\9,this\.#\6\),this\.#\2=Math\.max\(this\.#\2,this\.#\5\(\)\+this\.#\3\);return\}[^]{0,200}?\}answered\((${I})\)\{\10===this\.#\4&&\(this\.#\3=0\)\}\}`);
// held: `async function h(gate, by, sleep, signal) { let w = gate.left(); if (w !== 0) { if (Date.now() + w > by) throw
// Error(past M/1e3 s); await sleep(w, signal), signal?.throwIfAborted() } }`, with M = 3e4
const HELD = new RegExp(String.raw`async function (?<h>${I})\((${I}),(${I}),(${I}),(${I})\)\{let (${I})=\2\.left\(\);if\(\6!==0\)\{if\(Date\.now\(\)\+\6>\3\)throw Error\(\`its reads drew the provider's 429 past \$\{(?<m>${I})\/1e3\} s\`\);await \4\(\6,\5\),\5\?\.throwIfAborted\(\)\}\}`);
const BOUND = (m) => new RegExp(String.raw`[,\s;]${esc(m)}=3e4[,;]`);
// each reader: `async read(address, signal, by = Date.now() + M) {` ... `await h(x.gate, by, sleep, signal)`
const READS = (m) => new RegExp(String.raw`async read\((${I}),(${I}),(${I})=Date\.now\(\)\+${esc(m)}\)\{`);
const WAITS = (h) => new RegExp(String.raw`await ${esc(h)}\(${I}\.gate,${I},${I},${I}\)`);
// the helper's route: its own gate, made with its paced transport
const ROUTE = (g) => new RegExp(String.raw`wait429:${I}\.wait429,gate:new ${esc(g)}\}`);
// the old shape: a flat wait after a 429, `Math.max(wait429(), Math.min(e instanceof RpcFailed && e.afterMs !== null ? ...`
const OLD = new RegExp(String.raw`Math\.max\(${I}\(\),Math\.min\(${I} instanceof ${I}&&${I}\.afterMs!==null\?`);

/** What the check keeps of SIGN_HOST's page: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const b = BOUNDS.exec(js)?.groups?.b;
  const f = b ? RULE(b).exec(js)?.groups?.f : undefined;
  const g = b && f ? GATE(b, f).exec(js)?.groups?.g : undefined;
  const h = HELD.exec(js)?.groups;
  const bound = Boolean(h) && BOUND(h.m).test(js);
  return {
    index,
    sha384: sha384(js),
    rule: Boolean(f),
    gate: Boolean(g),
    held: bound,
    reader: bound && count(js, READS(h.m)) >= 1 && count(js, WAITS(h.h)) >= 1 && Boolean(g) && ROUTE(g).test(js),
    old: OLD.test(js),
  };
}

/** SIGN_HOST's /app.js sha384 in every release list from `from` (FIXED_FROM) on (packages/signpage/releases/). */
export function fixedReleases(dir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "packages/signpage/releases"), from = FIXED_FROM) {
  const out = new Set();
  for (const f of readdirSync(dir)) {
    const n = /^release-(\d+)\.json$/.exec(f)?.[1];
    if (n === undefined || Number(n) < from) continue;
    const list = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    for (const x of list.hosts?.SIGN_HOST?.files ?? []) if (x.path === "/app.js") out.add(x.sha384);
  }
  return out;
}

/** The verdict on an answer { index, sha384, rule, gate, held, reader, old }, against the release lists' bundles
 *  `fixed` (none with `ledger: false`). */
export function judge(a, { ledger = true, fixed = ledger ? fixedReleases() : null } = {}) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.rule !== true) bad("the wait after a throttle is not a pause doubling from 1 s to 10 s with a capped, finite Retry-After when longer");
  if (a?.gate !== true) bad("no provider gate on that rule: a round's throttles not counted once, or its pause set back by one call's answer");
  if (a?.held !== true) bad("a reader does not wait the gate before a round, or waits past its read's 30 s bound");
  if (a?.reader !== true) bad("the holdings reader does not wait the gate before each round, or the helper's route gives it no gate of its own");
  if (a?.old !== false) bad("the bundle still waits a flat Retry-After or 1 s after every 429: a throttled provider is asked again at once");
  if (fixed && !fixed.has(a?.sha384)) bad(`SIGN_HOST's /app.js is not a release-${FIXED_FROM}-or-later build: ${a?.sha384 ?? "not read"}`);
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
