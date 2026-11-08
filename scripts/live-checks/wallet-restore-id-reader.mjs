#!/usr/bin/env node
// Live check of card wallet-restore-id-reader: restore answers money, used or unused for every deposit id from public
// reads on the release's two NEAR providers (packages/wallet/src/restore/id-reader.ts): storage_balance_of(U) on the
// USDC token (a never-used implicit id has no storage there, a registered one has), view_account(U) (the account
// exists or UNKNOWN_ACCOUNT), money held now and the intents.near tokens. The end state on what is deployed:
//   - SIGN_HOST's served CSP lets the page reach both providers (connect-src);
//   - / names one module script, /app.js, with its integrity, /app.js's sha384 is that integrity, and /app.js holds the
//     card's rules that the page carries (string literals and patterns that minifying keeps): the walk's reach, the
//     index a walk-end error names, which a restore reads to before its gap counts (the walk's error says "restore again
//     with reach[lane] = i"): the reach checked as an index of its lane, the floor it sets, and misses counted only past it;
//     and, since card wallet-restore-id-reader-wired (the page's restore kind, src/pool-restore.ts, runs step 5 through
//     the IdReader), the IdReader's rules: an id is a 64-hex implicit account, storage on the token is null or a
//     balance, intents.near's list is a token list, the stronger of the two providers' answers taken (money over used
//     over unused), the pass's finals meet or the restore does not start, a stale pass refused, step 5's lane stopped
//     after DEPOSIT_ID_MARGIN failed reads, and the page's own wiring: the first id unread stops every read after it, and
//     a lane unread or unfinished ends the run stalled;
//   - each provider, asked with Origin SIGN_ORIGIN as the page asks (a POST with content-type application/json, so its
//     preflight first), answers with CORS for the page's origin, and answers what the IdReader decides on:
//       a registered id (REGISTERED, a NearBlocks USDC holder read 8 Nov 2026, registered on USDC) reads registered
//       (storage_balance_of a balance, view_account an account), and a fresh implicit id, 32 random bytes made for the
//       run, reads unused (storage_balance_of null, view_account UNKNOWN_ACCOUNT).
// Until card wallet-restore-id-reader-wired the IdReader's code was not in the served bundle (at f11b13ac nothing in
// packages/signpage/src imported restore/id-reader.ts, and main 610143c2's public/app.js holds none of the id_ and ids_
// markers below); its rules joined MARK once src/pool-restore.ts imported it. What this check cannot read: whether a
// restore on SIGN_HOST reads any id today, as the mainnet build pins no pool yet (src/pool-restore.ts pagePools), so its
// step 5 runs on the first pool pinned there.
// After: sign
//   node scripts/live-checks/wallet-restore-id-reader.mjs [--url <origin>] [--record <file>]
//   node scripts/live-checks/wallet-restore-id-reader.mjs --local [--root <signpage dir>] [--record <file>]
//     --local judges this tree's committed build and _headers (--root: another packages/signpage folder, as a checkout of
//     an older commit, to record what that build fails on); the providers are read live either way.
//   PASS exit 0, FAIL exit 1, error exit 2. The record holds the CSP's connect-src, the script's path, integrity, size,
//   sha384, each marker's count and each provider's answers (keyed by its place), never the bytes.
import "../net-window.mjs";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "wallet-restore-id-reader";
export const SIGN_ORIGIN = "https://confidential.unrealized.trade";
const SIGNPAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/signpage");
/** The release pair (the kit's NEAR_NETWORKS.mainnet: one FastNEAR URL and the dRPC URL), asked in this order. */
export const PAIR = Object.freeze(["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]); // near-rpc-operators: two operators (the release pair)
/** The record's key for provider i (a place, not the host: a record naming both in one object would read as a pair). */
export const PLACES = PAIR.map((_, i) => `rpc_${i}`);
/** Mainnet USDC, the vault's asset (the kit's VAULT_CONSTANTS.TOKEN). */
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** A registered id: 9c484fa5… holds USDC storage on both providers (packages/wallet/test/vectors/id-reader-mainnet.json's used_storage). */
export const REGISTERED = "9c484fa5d2d069569ba063fc555c34e621ccd88fdbb0295fc79bad232621c5c1";
const HEX64 = /^[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;

/** The card's strings in the bundle, as the minifier writes them. The two patterns bind the minifier's names. */
export const MARK = Object.freeze({
  reach_error: "reach: not an index of lane",
  // the walk's floor: `let o=a??-1,` (a lane's reach, or -1 when none)
  reach_floor: /let ([\w$]+)=([\w$]+)\?\?-1,/g,
  // a miss counts only past the floor: `r(l)?(s.push(a),u=0):a>o&&u++` (the index pushed is the one compared, the counter is the one reset)
  reach_misses: /\)\?\([\w$]+\.push\(([\w$]+)\),([\w$]+)=0\):\1>[\w$]+&&\2\+\+/g,
  // the IdReader (packages/wallet/src/restore/id-reader.ts nearIdReader, openRestorePass) and step 5
  // (restore/wallets.ts restoreDepositIds), as the page's restore kind imports them
  id_hex: "an id is a 64-hex implicit account id",
  id_storage: "storage_balance_of: neither null nor a balance",
  id_intents: "mt_tokens_for_owner: not a token list",
  // the stronger answer of the two providers: `{unused:0,used:1,money:2}`
  id_rank: "{unused:0,used:1,money:2}",
  id_pass_meet: "did not meet; the restore does not start",
  id_pass_stale: "blocks past it; open a fresh pass",
  ids_margin: "id reads failed with none showing history between them",
  // the page's wiring (src/pool-restore.ts readDepositIds): the first unread id stops every read after it,
  // `if(r.throwIfAborted(),o!==void 0)throw o;try{return await a(e)}catch(e){throw o??=e,e}`
  ids_stop: /\.throwIfAborted\(\),([\w$]+)!==void 0\)throw \1;try\{return await [\w$]+\(([\w$]+)\)\}catch\(([\w$]+)\)\{throw \1\?\?=\3,\3\}/g,
  // and a lane unread or unfinished ends the run stalled: `!t.complete||t.lanes.some(e=>e.unread.length>0))return!1`
  ids_stall: /!([\w$]+)\.complete\|\|\1\.lanes\.some\(\(?([\w$]+)\)?=>\2\.unread\.length>0\)\)return!1/g,
});
/** The markers' names, as the record keys their counts. */
export const MARKERS = Object.keys(MARK);
const countOf = (text, k) => (k instanceof RegExp ? [...text.matchAll(k)].length : text.split(k).length - 1);
const cors = (v) => v === "*" || v === SIGN_ORIGIN;

/** The bundle's lines of the verdict on a record: { pass, lines } (no network, no headers: a build alone answers them). */
export function judgeBundle(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const s = rec?.index ?? {};
  say(s.scripts === 1 && s.src === "/app.js" && s.module === true && /^sha384-[A-Za-z0-9+/]{64}$/.test(s.integrity ?? ""),
    `/ names one module script, /app.js, with its integrity (${s.scripts ?? "?"} script(s), ${s.src ?? "none"})`);
  const a = rec?.app ?? {};
  say(a.status === 200 && Number.isSafeInteger(a.bytes) && a.bytes > 0 && a.sha384 === s.integrity,
    `/app.js is the script / names: its sha384 is the integrity (HTTP ${a.status ?? "?"}, ${a.bytes ?? "?"} bytes)`);
  const m = a.markers ?? {};
  const missing = MARKERS.filter((k) => !(Number.isSafeInteger(m[k]) && m[k] >= 1));
  say(missing.length === 0, `/app.js carries the restore walk's reach and the IdReader's rules (${missing.length ? `missing ${missing.join(", ")}` : `${MARKERS.length} marks found`})`);
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

// what one provider's reads must answer, as the IdReader decides on them
const WANT = Object.freeze({
  registered: { storage: "registered", account: "account" },
  unused: { storage: "null", account: "UNKNOWN_ACCOUNT" },
});
const hasWord = (list, word) => (list ?? "").split(",").map((x) => x.trim().toLowerCase()).some((x) => x === "*" || x === word);

/** The verdict on a record: { pass, lines }. */
export function judge(rec) {
  const { lines } = judgeBundle(rec);
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const connect = (rec?.connect_src ?? "").split(" ");
  const lacks = PAIR.filter((h) => !connect.includes(h));
  say(lacks.length === 0, `SIGN_HOST's connect-src reaches both providers (${lacks.length ? `lacks ${lacks.join(", ")}` : "both"})`);
  const ids = rec?.ids ?? {};
  say(ids.registered === REGISTERED && HEX64.test(ids.unused ?? "") && ids.unused !== REGISTERED, `the ids read are the registered one and a fresh one (${String(ids.registered ?? "none").slice(0, 8)}, ${String(ids.unused ?? "none").slice(0, 8)})`);
  PLACES.forEach((k, i) => {
    const p = rec?.rpc?.[k] ?? {};
    const f = p.preflight ?? {};
    say([200, 204].includes(f.http) && cors(f.acao) && hasWord(f.acam, "post") && hasWord(f.acah, "content-type"),
      `provider ${i} answers the page's preflight for its origin (POST, content-type: ${f.http ?? "?"}, CORS ${f.acao ?? "none"}, methods ${f.acam ?? "none"}, headers ${f.acah ?? "none"})`);
    for (const [who, want] of Object.entries(WANT)) {
      const r = p[who] ?? {};
      const s = r.storage ?? {}, a = r.account ?? {};
      say(s.http === 200 && cors(s.acao) && s.read === want.storage && a.http === 200 && cors(a.acao) && a.read === want.account,
        `provider ${i} reads the ${who} id ${who === "registered" ? "registered" : "unused"} for the page's origin (storage ${s.read ?? s.error ?? "no answer"} ${s.http ?? "?"} CORS ${s.acao ?? "none"}; account ${a.read ?? a.error ?? "no answer"} ${a.http ?? "?"} CORS ${a.acao ?? "none"})`);
    }
  });
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

/** Answers / and /app.js from a packages/signpage folder (this tree's), with the CSP of its _headers' /* rule, as SIGN_HOST serves them. */
export const localFetchOf = (dir) => async (url) => {
  const p = new URL(url).pathname;
  const file = p === "/" ? path.join(dir, "index.html") : p === "/app.js" ? path.join(dir, "public/app.js") : null;
  if (file === null) return new Response("", { status: 404 });
  const csp = /^\/\*\n {2}Content-Security-Policy: (.*)$/m.exec(readFileSync(path.join(dir, "public/_headers"), "utf8"))?.[1] ?? "";
  return new Response(readFileSync(file), { status: 200, headers: p === "/" ? { "content-security-policy": csp } : {} });
};
export const localFetch = localFetchOf(SIGNPAGE);

/** The page as a browser reads it from `origin`: the CSP's connect-src, the script tag and /app.js's markers (never the bytes). */
export async function readBundle(fetchFn = fetch, origin = SIGN_ORIGIN) {
  const get = (p) => fetchFn(new URL(p, origin), { redirect: "error", headers: { accept: "*/*" }, signal: AbortSignal.timeout(20_000) });
  const page = await get("/");
  const html = await page.text();
  const csp = page.headers.get("content-security-policy") ?? "";
  const connect_src = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "))?.slice("connect-src ".length) ?? "";
  const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((t) => t[0]);
  const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
  const tag = tags[0] ?? "";
  const index = { status: page.status, scripts: tags.length, src: attr(tag, "src"), integrity: attr(tag, "integrity"), module: attr(tag, "type") === "module" };
  if (index.src !== "/app.js") return { connect_src, index, app: {} };
  const res = await get(index.src);
  const body = Buffer.from(await res.arrayBuffer());
  const text = body.toString("utf8");
  return { connect_src, index, app: { status: res.status, bytes: body.length, sha384: `sha384-${createHash("sha384").update(body).digest("base64")}`, markers: Object.fromEntries(MARKERS.map((k) => [k, countOf(text, MARK[k])])) } };
}

/** One request to provider `url` with Origin SIGN_ORIGIN as the page sends it: its status, CORS answers and JSON body. A 429 or a
 *  408 (dRPC's free plan stops a slow view that way) is asked again after its Retry-After (10 s when it names none, 30 s at
 *  most), three times at most (four asks in all): a throttle says nothing of what the page reads. */
async function ask(fetchFn, url, init, wait) {
  const out = {};
  try {
    let res;
    for (let k = 0; ; k++) {
      res = await fetchFn(url, { ...init, headers: { ...init.headers, origin: SIGN_ORIGIN }, signal: AbortSignal.timeout(20_000) });
      if ((res.status !== 429 && res.status !== 408) || k === 3) break;
      const after = Number(res.headers.get("retry-after"));
      await wait(1000 * (Number.isFinite(after) && after > 0 ? Math.min(after, 30) : 10));
    }
    out.http = res.status;
    out.acao = res.headers.get("access-control-allow-origin") ?? undefined;
    out.acam = res.headers.get("access-control-allow-methods") ?? undefined;
    out.acah = res.headers.get("access-control-allow-headers") ?? undefined;
    const j = init.method === "POST" ? await res.json().catch(() => null) : null;
    return { out, j };
  } catch (e) {
    out.error = String(e?.name ?? e);
    return { out, j: null };
  }
}
const rpcBody = (params) => JSON.stringify({ jsonrpc: "2.0", id: KEY, method: "query", params });
const JSON_POST = { method: "POST", headers: { "content-type": "application/json" } };
const errorName = (j) => (j?.error ? String(j.error.cause?.name ?? j.error.name ?? "error") : undefined);
const asText = (bytes) => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)));
  } catch {
    return undefined;
  }
};

/** What one provider answers for one id: storage_balance_of on USDC (registered | null | other | an error's name) and view_account (account | UNKNOWN_ACCOUNT | other | an error's name). */
async function readId(fetchFn, url, id, wait) {
  const args = Buffer.from(JSON.stringify({ account_id: id })).toString("base64");
  const [st, ac] = await Promise.all([
    ask(fetchFn, url, { ...JSON_POST, body: rpcBody({ request_type: "call_function", account_id: USDC, method_name: "storage_balance_of", args_base64: args, finality: "final" }) }, wait),
    ask(fetchFn, url, { ...JSON_POST, body: rpcBody({ request_type: "view_account", account_id: id, finality: "final" }) }, wait),
  ]);
  const storage = { http: st.out.http, acao: st.out.acao, error: st.out.error };
  if (st.j) {
    const v = Array.isArray(st.j.result?.result) ? asText(st.j.result.result) : undefined;
    storage.read = errorName(st.j) ?? (v === null ? "null" : v && typeof v === "object" && typeof v.total === "string" && DIGITS.test(v.total) ? "registered" : "other");
  }
  const account = { http: ac.out.http, acao: ac.out.acao, error: ac.out.error };
  if (ac.j) account.read = errorName(ac.j) ?? (typeof ac.j.result?.amount === "string" && DIGITS.test(ac.j.result.amount) ? "account" : "other");
  return { storage, account };
}

/** Each provider's preflight and reads of the registered id and the fresh one, keyed by PLACES. */
async function rpcRead(fetchFn, ids, wait) {
  const one = async (url) => {
    const pre = await ask(fetchFn, url, { method: "OPTIONS", headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }, wait);
    const [registered, unused] = await Promise.all([readId(fetchFn, url, ids.registered, wait), readId(fetchFn, url, ids.unused, wait)]);
    return { preflight: pre.out, registered, unused };
  };
  return Object.fromEntries(await Promise.all(PAIR.map(async (u, i) => [PLACES[i], await one(u)])));
}

/** Reads `origin` as a browser does, and both providers, and returns the record. `unused`: the fresh id (32 random bytes unless given). */
export async function probe(origin, fetchFn = fetch, rpcFetch = fetch, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), unused = randomBytes(32).toString("hex")) {
  const ids = { registered: REGISTERED, unused };
  const page = await readBundle(fetchFn, origin);
  return { key: KEY, url: origin, at: new Date().toISOString(), ...page, ids, rpc: await rpcRead(rpcFetch, ids, wait) };
}

/** SIGN_HOST's bundle record, read with `fetchFn` (scripts/ci/bundle-checks.mjs runs readBundle and judgeBundle on a pull request's build). */
export const read = (fetchFn = fetch) => readBundle(fetchFn);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const local = args.includes("--local");
    const rec = await probe(local ? SIGN_ORIGIN : (opt("--url") ?? SIGN_ORIGIN), local ? localFetchOf(opt("--root") ? path.resolve(opt("--root")) : SIGNPAGE) : fetch);
    if (local) rec.url = opt("--root") ? `local build of ${path.basename(path.resolve(opt("--root")))}` : "local build";
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.pass ? "PASS" : "FAIL"} (${rec.url})`);
    process.exit(r.pass ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
