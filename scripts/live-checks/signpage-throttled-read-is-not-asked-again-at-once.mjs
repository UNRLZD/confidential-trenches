#!/usr/bin/env node
// Live check of card signpage-throttled-read-is-not-asked-again-at-once on SIGN_HOST (https://confidential.unrealized.trade).
// What it holds, and only that: the served /app.js is the one index.html pins (its sha384), it is a released build from
// release-115 on (a packages/signpage/releases/release-<N>.json, N >= 115, names its sha384 for SIGN_HOST), and in it,
// as minified, the holdings readers' throttle rule (packages/wallet/src/throttle.ts, src/pool/buy-wallets.ts):
//   - rule: the wait after a throttle is a pause doubling from 1 s to 10 s, a Retry-After the wait only when longer,
//     finite and above 0, held to 10 s (throttleWaitMs and its bounds);
//   - gate: one provider's gate on that rule, whose round's throttles count once (by epoch), whose pause keeps doubling
//     until the provider has been open its quiet time (10 s) since the pause's end, an answer only clearing its doubt
//     (card signpage-throttled-provider-has-a-spare: run 9's one or two 200s set the pause back to 1 s, and every
//     parked read left at once into the next 429), whose time is performance.now with left() held to the longest wait,
//     and whose turn goes to one caller at a time, given on when a waiter is stopped (ThrottleGate);
//   - held: before each round a reader waits the gate until it is open, and refuses, asking nothing, a wait that would
//     end past its read's bound, or past 30 s of the route in doubt (HOLDINGS_THROTTLE_MAX_MS: the gate's doubtMs, card
//     wallets-found-in-one-read: a provider refusing one method for good ends a list there);
//   - turn: each round runs in the gate's turn: taken before the wait, given back however the round ends (since card
//     wallets-found-in-one-read the host's pass turn taken inside it, after the wait);
//   - reader: the page's holdings reader (Solana's; the EVM one is in no SIGN_HOST path, so not in the bundle) runs each
//     round in its gate's turn with its read's bound, and the helper's route gives its readers a gate of its own (never
//     the trade path's, nor the host's lane's: a finder 429 never pauses a trade);
//   - throttled: a call that draws a 429 tells its gate, with the epoch it was sent in;
//   - answered: a round that goes through whole tells its gate, with the epoch it was sent in;
//   - by: the list read gives no W's read a bound from the list's start (card wallets-found-in-one-read: 100 Ws at the
//     pace take 165 s); the route's 30 s in doubt bounds it (held), so a list of Ws never waits 30 s a W;
//   - none of the old shape: no flat wait after a 429 (the old waitAfter: the route's Retry-After or 1 s, every round).
// What each does is held by the card's tests (packages/wallet/test/throttle.test.ts: calls under 60 s of 429s on both
// transports, a run of buys ending, a one-method throttle, Retry-After, the sell's bound, the trade path unheld;
// test/buy-wallets.test.ts; packages/signpage/test/positions.test.ts: the cache, the buys and a sell on a provider its
// own asks throttle). The recorded answers are facts() over a tree's packages/signpage/index.html and public/app.js
// (build-app.mjs), or SIGN_HOST's own page. This file reaches no package code (the import check holds it). The PR's own
// build runs judge(read, { ledger: false }) in scripts/ci/bundle-checks.mjs, since it is cut as a release only after
// its merge.
// After: sign
// Bundle: read sign
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
// a time, given on at once when a waiter is stopped; a throttle marks the gate in doubt and, of the current epoch, moves
// the epoch and grows the pause by the rule from the last pause while the provider has been open less than its quiet
// time (bounds.quietMs, else 10 s), from none after it; answered() of the current epoch clears the doubt only
// groups: 1 the class, 2 until, 3 pause, 4 epoch, 5 doubt, 6 the turn's tail, 7 the clock, 8 the bounds, 9 the options;
// turn: 10 its stop, 11 the give-back, 12 its own promise, 14 the turn before, 15 and 16 the wait's ends, 17 its stop
// handler, 18 the caught stop; 19 and 20 a throttle's epoch and Retry-After, 21 its now, 22 the pause it grows from; 23
// an answer's epoch
const GATE = (b, f) => new RegExp(String.raw`(?<g>${I})=class\{#(${I})=0;#(${I})=0;#(${I})=0;#(${I})=!1;#${I}=0;#(${I})=Promise\.resolve\(\);#(${I});#(${I});constructor\((${I})=\{\}\)\{this\.#\7=\9\.now\?\?\(\(\)=>performance\.now\(\)\),this\.#\8=\9\.bounds\?\?${esc(b)}\}left\(\)\{return Math\.min\(Math\.max\(0,this\.#\2-this\.#\7\(\)\),Math\.max\(this\.#\8\.maxMs,this\.#\8\.afterMaxMs\)\)\}`
  + String.raw`async turn\((${I})\)\{let (${I}),(${I})=new Promise\((${I})=>\11=\13\),(${I})=this\.#\6;if\(this\.#\6=\14\.then\(\(\)=>\12\),\10===void 0\)return \14\.then\(\(\)=>\11\);try\{\10\.throwIfAborted\(\),await new Promise\(\((${I}),(${I})\)=>\{let (${I})=\(\)=>\16\(\10\.reason\);\10\.addEventListener\(\`abort\`,\17,\{once:!0\}\),\14\.then\(\(\)=>\(\10\.removeEventListener\(\`abort\`,\17\),\15\(\)\)\)\}\)\}catch\((${I})\)\{throw \11\(\),\18\}return \11\}`
  + String.raw`epoch\(\)\{return this\.#\4\}throttled\((${I}),(${I})\)\{if\(\(!this\.#\5\|\|this\.#\7\(\)-this\.#\2>=\(this\.#\8\.quietMs\?\?1e4\)\)&&\(this\.#${I}=this\.#\7\(\)\),this\.#\5=!0,\19===this\.#\4\)\{this\.#\4\+\+;let (${I})=this\.#\7\(\),(${I})=\21-this\.#\2<\(this\.#\8\.quietMs\?\?1e4\)\?this\.#\3:0;this\.#\3=${esc(f)}\(\22,\20,this\.#\8\),this\.#\2=Math\.max\(this\.#\2,\21\+this\.#\3\);return\}[^]{0,200}?\}answered\((${I})\)\{\23===this\.#\4&&\(this\.#\5=!1\)\}suspect\(\)\{return this\.#\5\}doubtMs\(\)\{return this\.#\5\?this\.#\7\(\)-this\.#${I}:0\}\}`);
// held: `async function h(gate, by, sleep, signal) { for (let w = gate.left(); w > 0; w = gate.left()) { if (Date.now() +
// w > by || gate.doubtMs() + w > 3e4) throw new SolanaRpcTransportError("http_429", past M/1e3 s, 1, route, w); await
// sleep(w, signal), signal?.throwIfAborted() } }`, with M = 3e4: past a bound, the provider's 429 as the kit's transport
// fault, so a sale counts it as the provider's (card pool-sell-legs-side-by-side)
const HELD = new RegExp(String.raw`async function (?<h>${I})\((${I}),(${I}),(${I}),(${I})\)\{for\(let (${I})=\2\.left\(\);\6>0;\6=\2\.left\(\)\)\{if\(Date\.now\(\)\+\6>\3\|\|\2\.doubtMs\(\)\+\6>3e4\)throw new ${I}\(\`http_429\`,\`its reads drew the provider's 429 past \$\{(?<m>${I})\/1e3\} s\`,1,\`the holdings route\`,\6\);await \4\(\6,\5\),\5\?\.throwIfAborted\(\)\}\}`);
const BOUND = (m) => new RegExp(String.raw`[,\s;]${esc(m)}=3e4[,;]`);
// a round in the gate's turn: `async function t(gate, by, sleep, signal, round, lane, kind = `pass`) { let give = await
// gate.turn(signal); try { return await h(gate, by, sleep, signal), lane && await lane.turn(kind, signal, !1, ...), await
// round(gate.epoch()) } finally { give() } }`: the host's turn after the gate's wait, inside the turn, a pass's unless
// its reader names a trade's (card evm-quote-rides-out-a-one-block-answer: a sale's finder read at its tap)
const INTURN = (h) => new RegExp(String.raw`async function (?<t>${I})\((${I}),(${I}),(${I}),(${I}),(${I}),(${I}),(${I})=\`pass\`\)\{let (${I})=await \2\.turn\(\5\);try\{return await ${esc(h)}\(\2,\3,\4,\5\),\7&&await \7\.turn\(\8,\5,!1,[^]{0,120}?\),await \6\(\2\.epoch\(\)\)\}finally\{\9\(\)\}\}`);
// the reader: `async read(address, signal, by = 1/0) {` ... `await t(x.gate, by, sleep, signal, async (e) => {
// try { r = await once(min), x.gate.answered(e)`: its round in the turn with its read's bound (none of its own unless a
// caller gives one: the route's 30 s in doubt in held bounds it), a whole round answered
const READS = (m, t) => new RegExp(String.raw`async read\((${I}),(${I}),(${I})=1\/0\)\{[^]{0,600}?await ${esc(t)}\((${I})\.gate,\3,(${I}),\2,async (${I})=>\{try\{(${I})=await (${I})\((${I})\)`);
const ANSWERED = (m, t) => new RegExp(READS(m, t).source + String.raw`,\4\.gate\.answered\(\6\)`);
// a call: `let e = x.gate.epoch(); try { return await x.rpc(m, p) } catch (n) { let f = failure(m, n); throw f.http ===
// 429 && x.gate.throttled(e, Math.max(f.afterMs ?? 0, x.hint?.() ?? 0)), ...`
const THROTTLED = new RegExp(String.raw`let (${I})=(${I})\.gate\.epoch\(\);try\{return await \2\.rpc\((${I}),(${I})\)\}catch\((${I})\)\{let (${I})=${I}\(\3,\5\);throw \6\.http===429&&\2\.gate\.throttled\(\1,Math\.max\(\6\.afterMs\?\?0,\2\.hint\?\.\(\)\?\?0\)\)`);
// the list: `u = 1/0; ...; x.holdings = await pools[p].reader.read(address, opts.signal, u)`: no bound from the list's
// start, so a long list is not refused for its length; the route's own bound (held's doubt) ends one throttled for good
const BY = () => new RegExp(String.raw`[,\s;](${I})=1\/0;[^]{0,800}?\.reader\.read\(${I},${I}\.signal,\1\)`);
// the helper's route: its own gate, made with its paced transport (and the host's lane for its pass turns, never its gate)
const ROUTE = (g) => new RegExp(String.raw`wait429:${I}\.wait429,gate:new ${esc(g)}(?:,lane:[^}]{0,60})?\}`);
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
    by: bound && BY().test(js),
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
  if (a?.held !== true) bad("a reader does not wait the gate until it opens before a round, or waits past its read's bound or 30 s of the route in doubt, or refuses past it as anything but the provider's 429");
  if (a?.turn !== true) bad("a round does not run in the gate's turn, taken before its wait and given back however it ends: two reads at once ask past the gate");
  if (a?.reader !== true) bad("the holdings reader does not run each round in its gate's turn with its read's bound, or the helper's route gives it no gate of its own");
  if (a?.throttled !== true) bad("a call that draws a 429 does not tell its gate: the gate never closes");
  if (a?.answered !== true) bad("a round that goes through does not tell its gate: the pause never goes back");
  if (a?.by !== true) bad("the list read bounds its Ws from the list's start, or not by the route's 30 s in doubt: a long list is refused for its length, or waits 30 s a W");
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

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `f` answers from the build
 *  folders as the host would; `dirs` names them (card ci-stops-costing-reruns, moved from bundle-checks.mjs). */
export async function bundle(f) {
  return judge(await read(f), { ledger: false });
}
