#!/usr/bin/env node
// Live check of card signpage-throttled-read-is-not-asked-again-at-once on SIGN_HOST (https://confidential.unrealized.trade).
// What it holds, and only that: the served /app.js is the one index.html pins (its sha384), it is a released build from
// release-115 on (a packages/signpage/releases/release-<N>.json, N >= 115, names its sha384 for SIGN_HOST), and in it,
// as minified, the holdings readers' throttle rule (packages/wallet/src/throttle.ts, src/pool/buy-wallets.ts):
//   - rule: the wait after a throttle is a pause doubling from 1 s to 10 s, a Retry-After the wait only when longer,
//     finite and above 0, held to 10 s (throttleWaitMs and its bounds);
//   - gate: one provider's gate on that rule, whose round's throttles count once (by epoch), whose pause goes back to
//     none only after a whole round, whose time is performance.now with left() held to the longest wait, and whose turn
//     goes to one caller at a time, given on when a waiter is stopped (ThrottleGate);
//   - held: before each round a reader waits the gate until it is open, and refuses, asking nothing, a wait that would
//     end past its read's bound, which is 30 s (HOLDINGS_THROTTLE_MAX_MS);
//   - turn: each round runs in the gate's turn: taken before the wait, given back however the round ends;
//   - reader: the page's holdings reader (Solana's; the EVM one is in no SIGN_HOST path, so not in the bundle) runs each
//     round in its gate's turn with its read's bound, and the helper's route gives its readers a gate of its own (never
//     the trade path's);
//   - throttled: a call that draws a 429 tells its gate, with the epoch it was sent in;
//   - answered: a round that goes through whole tells its gate, with the epoch it was sent in;
//   - by: the list read gives every W's read its one bound, from the list's start;
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
/** The first release whose holdings readers hold the rule: release-114 (main 0cf81828) is the last cut before it. */
export const FIXED_FROM = 115;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
const esc = (n) => n.replace(/\$/g, "\\$");

// the bounds and the rule: `B = Object.freeze({ firstMs: 1e3, maxMs: 1e4, afterMaxMs: 1e4 }); function f(prev, after, b = B)
// { let pause = isFinite(prev) && prev > 0 ? min(prev * 2, b.maxMs) : b.firstMs, a = typeof after == number && isFinite(after)
// && after > 0 ? min(after, b.afterMaxMs) : 0; return max(pause, a) }`
const BOUNDS = new RegExp(String.raw`(?<b>${I})=Object\.freeze\(\{firstMs:1e3,maxMs:1e4,afterMaxMs:1e4\}\)`);
const RULE = (b) => new RegExp(String.raw`function (?<f>${I})\((${I}),(${I}),(${I})=${esc(b)}\)\{let (${I})=Number\.isFinite\(\2\)&&\2>0\?Math\.min\(\2\*2,\4\.maxMs\):\4\.firstMs,(${I})=typeof \3==\`number\`&&Number\.isFinite\(\3\)&&\3>0\?Math\.min\(\3,\4\.afterMaxMs\):0;return Math\.max\(\5,\6\)\}`);
// the gate: its time performance.now; left() the time to its opening, never past the longest wait; turn() one caller at
// a time, given on at once when a waiter is stopped; a throttle of the current epoch moves the epoch and grows the
// pause by the rule; answered() of the current epoch sets the pause to none
// groups: 1 the class, 2 until, 3 pause, 4 epoch, 5 the turn's tail, 6 the clock, 7 the bounds, 8 the options; turn:
// 9 its stop, 10 the give-back, 11 its own promise, 13 the turn before, 14 and 15 the wait's ends, 16 its stop handler,
// 17 the caught stop; 18 and 19 a throttle's epoch and Retry-After; 20 an answer's epoch
const GATE = (b, f) => new RegExp(String.raw`(?<g>${I})=class\{#(${I})=0;#(${I})=0;#(${I})=0;#(${I})=Promise\.resolve\(\);#(${I});#(${I});constructor\((${I})=\{\}\)\{this\.#\6=\8\.now\?\?\(\(\)=>performance\.now\(\)\),this\.#\7=\8\.bounds\?\?${esc(b)}\}left\(\)\{return Math\.min\(Math\.max\(0,this\.#\2-this\.#\6\(\)\),Math\.max\(this\.#\7\.maxMs,this\.#\7\.afterMaxMs\)\)\}`
  + String.raw`async turn\((${I})\)\{let (${I}),(${I})=new Promise\((${I})=>\10=\12\),(${I})=this\.#\5;if\(this\.#\5=\13\.then\(\(\)=>\11\),\9===void 0\)return \13\.then\(\(\)=>\10\);try\{\9\.throwIfAborted\(\),await new Promise\(\((${I}),(${I})\)=>\{let (${I})=\(\)=>\15\(\9\.reason\);\9\.addEventListener\(\`abort\`,\16,\{once:!0\}\),\13\.then\(\(\)=>\(\9\.removeEventListener\(\`abort\`,\16\),\14\(\)\)\)\}\)\}catch\((${I})\)\{throw \10\(\),\17\}return \10\}`
  + String.raw`epoch\(\)\{return this\.#\4\}throttled\((${I}),(${I})\)\{if\(\18===this\.#\4\)\{this\.#\4\+\+,this\.#\3=${esc(f)}\(this\.#\3,\19,this\.#\7\),this\.#\2=Math\.max\(this\.#\2,this\.#\6\(\)\+this\.#\3\);return\}[^]{0,200}?\}answered\((${I})\)\{\20===this\.#\4&&\(this\.#\3=0\)\}\}`);
// held: `async function h(gate, by, sleep, signal) { for (let w = gate.left(); w > 0; w = gate.left()) { if (Date.now() +
// w > by) throw new SolanaRpcTransportError("http_429", past M/1e3 s, 1, route, w); await sleep(w, signal),
// signal?.throwIfAborted() } }`, with M = 3e4: past the bound, the provider's 429 as the kit's transport fault, so a sale
// counts it as the provider's (card pool-sell-legs-side-by-side)
const HELD = new RegExp(String.raw`async function (?<h>${I})\((${I}),(${I}),(${I}),(${I})\)\{for\(let (${I})=\2\.left\(\);\6>0;\6=\2\.left\(\)\)\{if\(Date\.now\(\)\+\6>\3\)throw new ${I}\(\`http_429\`,\`its reads drew the provider's 429 past \$\{(?<m>${I})\/1e3\} s\`,1,\`the holdings route\`,\6\);await \4\(\6,\5\),\5\?\.throwIfAborted\(\)\}\}`);
const BOUND = (m) => new RegExp(String.raw`[,\s;]${esc(m)}=3e4[,;]`);
// a round in the gate's turn: `async function t(gate, by, sleep, signal, round) { let give = await gate.turn(signal);
// try { return await h(gate, by, sleep, signal), await round(gate.epoch()) } finally { give() } }`
const INTURN = (h) => new RegExp(String.raw`async function (?<t>${I})\((${I}),(${I}),(${I}),(${I}),(${I})\)\{let (${I})=await \2\.turn\(\5\);try\{return await ${esc(h)}\(\2,\3,\4,\5\),await \6\(\2\.epoch\(\)\)\}finally\{\7\(\)\}\}`);
// the reader: `async read(address, signal, by = Date.now() + M) {` ... `await t(x.gate, by, sleep, signal, async (e) => {
// try { r = await once(min), x.gate.answered(e)`: its round in the turn with its read's bound, a whole round answered
const READS = (m, t) => new RegExp(String.raw`async read\((${I}),(${I}),(${I})=Date\.now\(\)\+${esc(m)}\)\{[^]{0,600}?await ${esc(t)}\((${I})\.gate,\3,(${I}),\2,async (${I})=>\{try\{(${I})=await (${I})\((${I})\)`);
const ANSWERED = (m, t) => new RegExp(READS(m, t).source + String.raw`,\4\.gate\.answered\(\6\)`);
// a call: `let e = x.gate.epoch(); try { return await x.rpc(m, p) } catch (n) { let f = failure(m, n); throw f.http ===
// 429 && x.gate.throttled(e, Math.max(f.afterMs ?? 0, x.hint?.() ?? 0)), ...`
const THROTTLED = new RegExp(String.raw`let (${I})=(${I})\.gate\.epoch\(\);try\{return await \2\.rpc\((${I}),(${I})\)\}catch\((${I})\)\{let (${I})=${I}\(\3,\5\);throw \6\.http===429&&\2\.gate\.throttled\(\1,Math\.max\(\6\.afterMs\?\?0,\2\.hint\?\.\(\)\?\?0\)\)`);
// the list: `u = Date.now() + M; ...; x.holdings = await pools[p].reader.read(address, opts.signal, u)`
const BY = (m) => new RegExp(String.raw`[,\s;](${I})=Date\.now\(\)\+${esc(m)};[^]{0,400}?\.reader\.read\(${I},${I}\.signal,\1\)`);
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
  const t = h ? INTURN(h.h).exec(js)?.groups?.t : undefined;
  return {
    index,
    sha384: sha384(js),
    rule: Boolean(f),
    gate: Boolean(g),
    held: bound,
    turn: Boolean(t),
    reader: bound && Boolean(t) && READS(h.m, t).test(js) && Boolean(g) && ROUTE(g).test(js),
    throttled: THROTTLED.test(js),
    answered: bound && Boolean(t) && ANSWERED(h.m, t).test(js),
    by: bound && BY(h.m).test(js),
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

/** The verdict on an answer { index, sha384, rule, gate, held, turn, reader, throttled, answered, by, old }, against the release lists' bundles
 *  `fixed` (none with `ledger: false`). */
export function judge(a, { ledger = true, fixed = ledger ? fixedReleases() : null } = {}) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.rule !== true) bad("the wait after a throttle is not a pause doubling from 1 s to 10 s with a capped, finite Retry-After when longer");
  if (a?.gate !== true) bad("no provider gate on that rule: a round's throttles not counted once, its pause set back by one call's answer, its time the wall clock, or no turn given on when a waiter stops");
  if (a?.held !== true) bad("a reader does not wait the gate until it opens before a round, or waits past its read's 30 s bound, or refuses past it as anything but the provider's 429");
  if (a?.turn !== true) bad("a round does not run in the gate's turn, taken before its wait and given back however it ends: two reads at once ask past the gate");
  if (a?.reader !== true) bad("the holdings reader does not run each round in its gate's turn with its read's bound, or the helper's route gives it no gate of its own");
  if (a?.throttled !== true) bad("a call that draws a 429 does not tell its gate: the gate never closes");
  if (a?.answered !== true) bad("a round that goes through does not tell its gate: the pause never goes back");
  if (a?.by !== true) bad("the list read does not give each W's read its one bound from the list's start: a list of Ws waits 30 s a W");
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
