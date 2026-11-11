#!/usr/bin/env node
// Live check of card signpage-state-holdings on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and
// only that:
//   - / names exactly one module script, /app.js, with its integrity, and /app.js's sha384 is that integrity;
//   - that /app.js is the /app.js of a written release list whose commit holds this card's commit (CARD_COMMIT) in its
//     history (packages/signpage/releases/release-<N>.json, its `commit`, read with git): its bytes are a build of a
//     main that holds this card's fix, whose tests ran on it; a release cut from a main without it fails, whatever its
//     number. This is what tells the fix from its absence: the marks below are shapes
//     a broken build keeps (the review's seven broken builds all had them), and only the ledger ties the served bytes
//     to the source the card's tests hold;
//   - and in it, as minified, the state step's wiring: vault_balance from the device's own notes (SUM, FILL), positions
//     from the device's own pass (SET, PASS, COSTS, KEPT, SOLD), the state read asking the pass (FIRST), the cache
//     running it with its stop and a sell's read (RUN), the pass reading only the Ws this device bought (RECORDS), and a
//     sell's read holding the passes off until it ends (PREEMPT). A build that drops any of them fails; one that keeps
//     the shapes and breaks what they do is the ledger's to fail.
// What it cannot see from outside: a signed-in device's positions, its requests, or a pass's timing. They need the
// device's seed and a buy on it, and a runner holds neither; they are held by the card's tests, on the source the
// release names (packages/signpage/test/positions.test.ts, positions-requests.test.ts: the mainnet build's every
// request; pool-buy.test.ts: the buy's decimals). The recorded answers are probe()'s records of SIGN_HOST, or of a tree's
// build (--local). The PR's own build runs judge(read, { ledger: false }) in scripts/ci/bundle-checks.mjs, since it is
// cut as a release only after its merge.
// After: sign
//   node scripts/live-checks/signpage-state-holdings.mjs [--url <origin>] [--record <file>]
//   node scripts/live-checks/signpage-state-holdings.mjs --local [--record <file>]   this tree's build (no ledger)
//   PASS exit 0, FAIL exit 1, error exit 2. The record holds the script's path, integrity, size, sha384 and each
//   mark's count, never the bytes.
import "../net-window.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

const KEY = "signpage-state-holdings";
export const SIGN_ORIGIN = "https://confidential.unrealized.trade";
/** This card's commit: its fix (positions.ts's looked-for rule, the stops), which a release's commit must hold. */
export const CARD_COMMIT = "afda031fe2eb4e2bb824551fcd7b6fcefb4e9c71";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RELEASES = path.join(ROOT, "packages/signpage/releases");
const SHA = /^[0-9a-f]{40}$/;
const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
let fetched = false;
/** Whether `commit` holds `card` in its history, by this checkout's git; a shallow checkout (a runner's) is fetched whole
 *  once, blobs left out. Throws when git still cannot tell, so the check fails rather than guesses. */
export function gitHolds(card, commit) {
  if (!SHA.test(card) || !SHA.test(commit)) return false;
  for (;;) {
    const r = git(["merge-base", "--is-ancestor", card, commit]);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    if (fetched) throw new Error(`git cannot tell whether ${commit} holds ${card}: ${String(r.stderr).trim().slice(0, 200)}`);
    fetched = true;
    const shallow = git(["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";
    git(["fetch", "--quiet", "--no-tags", "--filter=blob:none", ...(shallow ? ["--unshallow"] : []), "origin"]);
  }
}
/** The SIGN_HOST /app.js of every written release list whose commit holds this card's: its sha384 to its release. */
export function releasedAppJs(dir = RELEASES, holds = (commit) => gitHolds(CARD_COMMIT, commit)) {
  const out = new Map();
  for (const f of readdirSync(dir)) {
    const n = /^release-(\d+)\.json$/.exec(f)?.[1];
    if (n === undefined) continue;
    const rec = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    const app = rec.hosts?.SIGN_HOST?.files?.find((x) => x.path === "/app.js");
    if (typeof app?.sha384 === "string" && typeof rec.commit === "string" && holds(rec.commit)) out.set(app.sha384, `release-${n}`);
  }
  return out;
}
/** The sum's refusal, as src/vault-balance.ts writes it. */
export const SUM = "vault balance: a counted note has no leaf value";
/** vault_balance set from the sum of an awaited notes read, at 6 decimals: `vault_balance:f(g(await r(),s),6)`. */
export const FILL = /vault_balance:[\w$]+\([\w$]+\(await [\w$]+\(\),[\w$]+\),6\)/g;
/** withPositions: the state with positions from the pass, `{...e,positions:t}`. */
export const SET = /\{\.\.\.[\w$]+,positions:[\w$]+\}/g;
/** positionsPass: `chain:"solana",token:i,amount:f(a.amount,t),cost:g(` (a backtick or quote, as the minifier writes). */
export const PASS = /chain:[`"]solana[`"],token:[\w$]+,amount:[\w$]+\([\w$]+\.amount,[\w$]+\),cost:[\w$]+\(/g;
/** The buy records' key in the wallet store's meta (src/positions.ts POSITION_COSTS_KEY). */
export const COSTS = "owed/cost-sol";
/** The kept pass's key (src/positions.ts POSITIONS_KEPT_KEY). */
export const KEPT = "owed/positions-sol";
/** The full sells' key (src/positions.ts POSITIONS_SOLD_KEY). */
export const SOLD = "owed/sold-sol";
/** The state read's positions(): the cache's read, which reads the kept pass, asks the sign-in's first pass and answers
 *  the last unless a sign out overtook it: `read:async()=>{let e=s;if(await c.ready(),e!==s)return null;return c.first(),l}`
 *  (src/positions.ts), and the page's `positions:()=>c.read()` (src/pool-testnet.ts), or since card
 *  signpage-positions-evm the same read first in the page's join of Solana's and each EVM chain's:
 *  `positions:async()=>{let[e,...t]=await Promise.all([c.read(),...`. */
export const FIRST = /positions:\(\)=>[\w$]+\.read\(\)|positions:async\(\)=>\{let ?(?:[\w$]+=[\w$]+,)*\[[\w$]+,\.\.\.[\w$]+\]=await Promise\.all\(\[[\w$]+\.read\(\),/g;
/** positionsCache's run calls the pass with its stop and a fed read: `e(c,{signal:g.signal,..._===null?{}:{found:_}})`. */
export const RUN = /[\w$]+\([\w$]+,\{signal:[\w$]+\.signal,\.\.\.[\w$]+===null\?\{\}:\{found:[\w$]+\}\}\)/g;
/** positionsPass asks the finder for the Ws this device bought only: `.wallets(new Set(c.map(({address:e})=>e)))`. */
export const RECORDS = /\.wallets\(new Set\([\w$]+\.map\(\(\{address:[\w$]+\}\)=>[\w$]+\)\)\)/g;
/** The sell host's read holds the passes off first, then feeds or releases them in a finally: `wallets:async()=>{let
 *  e=c.preempt(),t=null;try{...}finally{t===null?e.release():e.feed(t)}`. */
export const PREEMPT = /wallets:async\(\)=>\{let ([\w$]+)=[\w$]+\.preempt\(\),([\w$]+)=null;try\{[^]{0,400}?\}finally\{\2===null\?\1\.release\(\):\1\.feed\(\2\)\}/g;
const countOf = (text, k) => (k instanceof RegExp ? [...text.matchAll(k)].length : text.split(k).length - 1);

/** The verdict on a record: { pass, lines }, against the release lists' /app.js files (none with `ledger: false`). */
export function judge(rec, { ledger = true, released = ledger ? releasedAppJs() : null } = {}) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const s = rec?.index ?? {};
  say(s.scripts === 1 && s.src === "/app.js" && s.module === true && /^sha384-[A-Za-z0-9+/]{64}$/.test(s.integrity ?? ""),
    `/ names one module script, /app.js, with its integrity (${s.scripts ?? "?"} script(s), ${s.src ?? "none"})`);
  const a = rec?.app ?? {};
  say(a.status === 200 && Number.isSafeInteger(a.bytes) && a.bytes > 0 && a.sha384 === s.integrity,
    `/app.js is the script / names: its sha384 is the integrity (HTTP ${a.status ?? "?"}, ${a.bytes ?? "?"} bytes)`);
  if (released) say(released.has(a.sha384), `/app.js is a release whose commit holds ${CARD_COMMIT.slice(0, 8)}, a build of the source this card's tests hold (${released.get(a.sha384) ?? `none: ${a.sha384 ?? "not read"}`})`);
  const m = a.marks ?? {};
  const sum = Number.isSafeInteger(m.sum) && m.sum >= 1;
  const fill = Number.isSafeInteger(m.fill) && m.fill >= 1;
  say(sum && fill, `/app.js fills vault_balance from the device's own notes (sum ${m.sum ?? "?"}, fill ${m.fill ?? "?"})`);
  const at = (k) => Number.isSafeInteger(m[k]) && m[k] >= 1;
  say(at("set") && at("pass") && at("costs") && at("kept") && at("sold"),
    `/app.js fills positions from the device's own pass, with its cost (set ${m.set ?? "?"}, pass ${m.pass ?? "?"}, costs ${m.costs ?? "?"}, kept ${m.kept ?? "?"}, sold ${m.sold ?? "?"})`);
  say(at("first") && at("run") && at("records") && at("preempt"),
    `/app.js runs the pass from the state read, on the device's buy records, stopped by a sell's read (first ${m.first ?? "?"}, run ${m.run ?? "?"}, records ${m.records ?? "?"}, preempt ${m.preempt ?? "?"})`);
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

/** Answers / and /app.js from this tree's build, made from its sources (signBuilt), as SIGN_HOST serves them. */
export const localFetch = async (url) => {
  const p = new URL(url).pathname;
  const file = p === "/" ? path.join(signBuilt(), "index.html") : p === "/app.js" ? path.join(signBuilt(), "public/app.js") : null;
  if (file === null) return new Response("", { status: 404 });
  return new Response(readFileSync(file), { status: 200 });
};

/** Reads `origin` as a browser does and returns the record. */
export async function probe(origin, fetchFn = fetch) {
  const get = (p) => fetchFn(new URL(p, origin), { redirect: "error", headers: { accept: "*/*" }, signal: AbortSignal.timeout(20_000) });
  const page = await get("/");
  const html = await page.text();
  const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((t) => t[0]);
  const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
  const tag = tags[0] ?? "";
  const index = { status: page.status, scripts: tags.length, src: attr(tag, "src"), integrity: attr(tag, "integrity"), module: attr(tag, "type") === "module" };
  const rec = { key: KEY, url: origin, at: new Date().toISOString(), index, app: {} };
  if (index.src !== "/app.js") return rec;
  const res = await get(index.src);
  const body = Buffer.from(await res.arrayBuffer());
  const text = body.toString("utf8");
  rec.app = {
    status: res.status,
    bytes: body.length,
    sha384: `sha384-${createHash("sha384").update(body).digest("base64")}`,
    marks: { sum: countOf(text, SUM), fill: countOf(text, FILL), set: countOf(text, SET), pass: countOf(text, PASS), costs: countOf(text, COSTS), kept: countOf(text, KEPT), sold: countOf(text, SOLD), first: countOf(text, FIRST), run: countOf(text, RUN), records: countOf(text, RECORDS), preempt: countOf(text, PREEMPT) },
  };
  return rec;
}

/** SIGN_HOST's record, read with `fetchFn` (scripts/ci/bundle-checks.mjs runs read and judge on a pull request's build). */
export const read = (fetchFn = fetch) => probe(SIGN_ORIGIN, fetchFn);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const local = args.includes("--local");
    const rec = await probe(local ? SIGN_ORIGIN : (opt("--url") ?? SIGN_ORIGIN), local ? localFetch : fetch);
    if (local) rec.url = "local build";
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    // a tree's own build is cut as a release only after its merge: its marks and its pin, not the ledger
    const r = judge(rec, { ledger: !local });
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.pass ? "PASS" : "FAIL"} (${rec.url})`);
    process.exit(r.pass ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
