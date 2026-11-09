#!/usr/bin/env node
// Live check of card held-move-forgotten-tx: a held deposit's move out that landed reads Moved however long ago it
// landed. Both release RPCs forget old txs (mainnet: fastnear keeps about 100,000 to 180,000 blocks, dRPC under 230,000;
// read 8 Nov 2026), so the wallet reads a recorded move they both answer UNKNOWN_TRANSACTION for on the network's archival
// RPCs (the kit's NEAR_NETWORKS.mainnet.archival, every one asked, settled only on an equal word from all) before it
// settles it, and only while U holds at most 1 base unit (money in U is always movable). The end state on what is deployed:
//   - SIGN_HOST's served CSP lets the page reach both mainnet archival hosts (connect-src);
//   - / names one module script, /app.js, with its integrity, /app.js's sha384 is that integrity, and /app.js holds the
//     archival hosts, the move's archival rule and its whole-list rule (the delta review of c3e71713: a part of the list
//     is refused, which f0f8f02c's bundle lacks), the one rule's four lines (money in U always movable: Moved only with
//     U at most 1 base unit, more replaced or open; delta review 2), a tx still running kept followed and the archival
//     hosts asked again after a throttle (delta review 3), the kit version 1.6 (a moved-out deposit carries
//     moved_out, so the app draws no Held mark for it) and the kit-v1.5 level that leaves that fact out (string
//     literals, which minifying keeps);
//   - each archival host, asked with Origin SIGN_ORIGIN as the page asks, answers `tx` with wait_until NONE for a mainnet
//     tx of ours that landed on 7 Nov 2026 (scripts/live-checks/vault-mainnet-test.md, its first Tx line) FINAL with
//     SuccessValue, included in block 223168356, and serves that block by height (the block an UNKNOWN_TRANSACTION is
//     checked against, moveout.ts archivedState), each with access-control-allow-origin * or SIGN_ORIGIN.
// After: sign
//   node scripts/live-checks/held-move-forgotten-tx.mjs [--url <origin>] [--record <file>]
//   node scripts/live-checks/held-move-forgotten-tx.mjs --local [--record <file>]   this tree's committed build and _headers
//   PASS exit 0, FAIL exit 1, error exit 2. The record holds the CSP's connect-src, the script's path, integrity, size,
//   sha384, each marker's count and each archival host's answers (keyed by its place in ARCHIVAL), never the bytes.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "held-move-forgotten-tx";
export const SIGN_ORIGIN = "https://confidential.unrealized.trade"; // SIGN_HOST by the hosts' name since hosts-main-on-top (main dfe122d2)
const SIGNPAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/signpage");
/** The kit's mainnet archival list (packages/kit/src/near/networks.ts), every one asked. */
export const ARCHIVAL = ["https://archival-rpc.mainnet.near.org", "https://archival-rpc.mainnet.fastnear.com"]; // near-rpc-operators: one operator (the archival list, every one asked)
/** A mainnet tx of ours that landed on 7 Nov 2026 (vault-mainnet-test.md), and the block that included it (read on both
 *  archival hosts 8 Nov 2026 11:2xZ): each archival host must still read both. */
export const OLD_TX = { hash: "HtFfu1gbhPxKv1QyBFBbbRRAGenYgdSVzwagQB49iiiY", signer: "unrlzd.near", height: 223168356, block: "D9GM7wsALNLQbkand4QZA6BXVnat6xsg2T8CcfqZuCcF" };
/** The record's key for archival host i (a place, not the host: see MARKERS). */
export const HOSTS = ARCHIVAL.map((_, i) => `archival_${i}`);
/** This card's strings in the bundle, as the minifier writes them: the archival hosts, the move's archival rule, the
 *  kit version the page reads in full (1.6: a deposit's moved_out fact; from kit-v1.7, kit-v1.6's own level) and the
 *  kit-v1.5 level that leaves it out. */
export const MARK = Object.freeze({
  archival_0: ARCHIVAL[0],
  archival_1: ARCHIVAL[1],
  rule: "an archival RPC is not the op's network's",
  list_rule: "the list must be none or exactly the network's",
  // the one rule, money in U always movable, as the minifier writes it (delta review 2 of c3e71713, L3): landed only with
  // U at most 1; a settled record with U above 1 replaced; a moved op's resume moved only with U at most 1; follow()
  // open with U above 1
  landed_at_1: "usdc<=1n)return`landed`",
  replaced_above_1: "usdc>1n)return{gone:`replaced`",
  moved_at_1: "usdc<=1n)return{kind:`moved`",
  follow_open_above_1: "usdc>1n?(await",
  // delta review 3: a tx still running (any final_execution_status short of FINAL) keeps its record followed, on either
  // RPC's word; the archival hosts asked again after a throttle (HTTP 429 or 5xx, or a JSON-RPC -429)
  running_states: "[`INCLUDED`,`EXECUTED_OPTIMISTIC`,`INCLUDED_FINAL`,`EXECUTED`]",
  // (delta review 4: the running word read after the expired test, so it stands alone: `.some(e=>e===`pending`))return`live``)
  running_live: "===`pending`))return`live`",
  archival_retry: "code===-429))return",
  // delta review 4, item 1 (delta review 5, item 4): once the archival hosts answer, U is read again and landed is
  // decided on that second read (the archival asks can take seconds, and a late deposit may reach U meanwhile). Its
  // read's names are the minifier's, so this one mark is a pattern that binds them (delta review 6, F3): the read of U
  // into one name, that name's null check, then landed on that name's usdc; a build deciding on the first read (mutant
  // R1: another name's usdc) has none; the name starts where a name can (delta review 7, item 5: a read into `ac` with
  // checks on `c` is no match)
  u_second_read: /(?<![\w$])([\w$]+)=await [\w$]+\([\w$]+,[\w$]+\.to,[\w$]+,[\w$]+\)\.catch\(\(\)=>null\);if\(\1===null\)return`live`;if\([\w$]+===`ok`&&\1\.usdc<=1n\)return`landed`/g,
  // delta review 9, ruling 1 (delta review 10, F5): the tap reads an op of U stored none, PENDING_DEPOSIT or
  // INCOMPLETE_DEPOSIT once again before it signs (the minifier writes its `continue` as `||(`)
  tap_reread: "follow.status!==`INCOMPLETE_DEPOSIT`||(",
  // delta review 10, F1: a landed move that marked no op of U answers moved only at MIN_DEPOSIT or more (dust is nothing
  // to move); delta review 11, F1: on what U held, the move's amount + 1 (a build flooring the moved amount has none)
  dust_floor: /\.amount\)\+1n>=[\w$]+\.MIN_DEPOSIT\?\{kind:`moved`/g,
  // card pool-deposit-stages: kit-v1.6 reads the moved_out fact in full, as the version the page reads everything at
  // (release-94 to 107) or, once the page reads kit-v1.7 in full, as kit-v1.6's own level, which keeps moved_out
  kit_1_6: /`1\.6`\.split\(|\(1,6\)\?`1\.6`:/g,
  level_1_5: "`1.5`",
});
/** The markers' names, as the record keys their counts (a name, not the host: a record naming both archival hosts in one
 *  object would read as a pair of one operator's reads to scripts/ci/near-rpc-operators.mjs). */
export const MARKERS = Object.keys(MARK);
// a string by its occurrences; a pattern (global) by its matches, never by split, which returns its captures too
const countOf = (text, k) => (k instanceof RegExp ? [...text.matchAll(k)].length : text.split(k).length - 1);

/** The verdict on a record: { pass, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const connect = (rec?.connect_src ?? "").split(" ");
  const lacks = ARCHIVAL.filter((h) => !connect.includes(h));
  say(lacks.length === 0, `SIGN_HOST's connect-src reaches the archival RPCs (${lacks.length ? `lacks ${lacks.join(", ")}` : "both"})`);
  const s = rec?.index ?? {};
  say(s.scripts === 1 && s.src === "/app.js" && s.module === true && /^sha384-[A-Za-z0-9+/]{64}$/.test(s.integrity ?? ""),
    `/ names one module script, /app.js, with its integrity (${s.scripts ?? "?"} script(s), ${s.src ?? "none"})`);
  const a = rec?.app ?? {};
  say(a.status === 200 && Number.isSafeInteger(a.bytes) && a.bytes > 0 && a.sha384 === s.integrity,
    `/app.js is the script / names: its sha384 is the integrity (HTTP ${a.status ?? "?"}, ${a.bytes ?? "?"} bytes)`);
  const m = a.markers ?? {};
  const missing = MARKERS.filter((k) => !(Number.isSafeInteger(m[k]) && m[k] >= 1));
  say(missing.length === 0, `/app.js reads a forgotten move on the archival RPCs (${missing.length ? `missing ${missing.join(", ")}` : `${MARKERS.length} marks found`})`);
  const cors = (v) => v === "*" || v === SIGN_ORIGIN;
  HOSTS.forEach((k, i) => {
    const t = rec?.archival?.[k] ?? {};
    say(t.http === 200 && cors(t.acao) && t.final_execution_status === "FINAL" && t.success === true && t.hash === OLD_TX.hash && t.block_hash === OLD_TX.block,
      `archival host ${i} reads the 7 Nov tx FINAL and a success, in its block, for the page's origin (${t.http ?? "?"}, ${t.final_execution_status ?? t.error ?? "no answer"}, CORS ${t.acao ?? "none"})`);
    const b = t.block ?? {};
    say(b.http === 200 && cors(b.acao) && b.height === OLD_TX.height && b.hash === OLD_TX.block,
      `archival host ${i} serves the tx's block by height, for the page's origin (${b.http ?? "?"}, ${b.height ?? b.error ?? "no answer"}, CORS ${b.acao ?? "none"})`);
  });
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

/** Answers / and /app.js from this tree's committed build, with the CSP of its _headers' /* rule, as SIGN_HOST serves them. */
export const localFetch = async (url) => {
  const p = new URL(url).pathname;
  const file = p === "/" ? path.join(SIGNPAGE, "index.html") : p === "/app.js" ? path.join(SIGNPAGE, "public/app.js") : null;
  if (file === null) return new Response("", { status: 404 });
  const csp = /^\/\*\n {2}Content-Security-Policy: (.*)$/m.exec(readFileSync(path.join(SIGNPAGE, "public/_headers"), "utf8"))?.[1] ?? "";
  return new Response(readFileSync(file), { status: 200, headers: p === "/" ? { "content-security-policy": csp } : {} });
};

/** One JSON-RPC call to archival host `url`, with Origin SIGN_ORIGIN as the page sends it: its status, CORS answer, result.
 *  A 429 is asked again after its Retry-After (10 s when it names none, 30 s at most), three times at most (four asks in all): near.org's
 *  archival host rate-limits a few quick reads (read 8 Nov 2026 11:0xZ), which says nothing of what the page reads. */
async function call(fetchFn, url, method, params, wait) {
  const out = {};
  try {
    let res;
    for (let k = 0; ; k++) {
      res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", origin: SIGN_ORIGIN }, body: JSON.stringify({ jsonrpc: "2.0", id: KEY, method, params }), signal: AbortSignal.timeout(20_000) });
      if (res.status !== 429 || k === 3) break;
      const after = Number(res.headers.get("retry-after"));
      await wait(1000 * (Number.isFinite(after) && after > 0 ? Math.min(after, 30) : 10));
    }
    out.http = res.status;
    out.acao = res.headers.get("access-control-allow-origin") ?? undefined;
    const j = await res.json().catch(() => null);
    if (j?.error) out.error = j.error.cause?.name ?? j.error.name ?? "error";
    return { out, r: j?.result };
  } catch (e) {
    out.error = String(e?.name ?? e);
    return { out, r: undefined };
  }
}
/** Each archival host's answer to `tx` for OLD_TX (wait_until NONE) and to `block` at OLD_TX's height, keyed by HOSTS. */
async function archivalRead(fetchFn, wait) {
  const one = async (url) => {
    const tx = await call(fetchFn, url, "tx", { tx_hash: OLD_TX.hash, sender_account_id: OLD_TX.signer, wait_until: "NONE" }, wait);
    const r = tx.r;
    if (r) Object.assign(tx.out, { final_execution_status: r.final_execution_status, success: typeof r.status === "object" && r.status !== null && Object.hasOwn(r.status, "SuccessValue"), hash: r.transaction?.hash, block_hash: r.transaction_outcome?.block_hash });
    const b = await call(fetchFn, url, "block", { block_id: OLD_TX.height }, wait);
    if (b.r?.header) Object.assign(b.out, { height: b.r.header.height, hash: b.r.header.hash });
    return { ...tx.out, block: b.out };
  };
  return Object.fromEntries(await Promise.all(ARCHIVAL.map(async (u, i) => [HOSTS[i], await one(u)])));
}

/** Reads `origin` as a browser does, and both archival hosts, and returns the record. */
export async function probe(origin, fetchFn = fetch, rpcFetch = fetch, wait = (ms) => new Promise((ok) => setTimeout(ok, ms))) {
  const get = (p) => fetchFn(new URL(p, origin), { redirect: "error", headers: { accept: "*/*" }, signal: AbortSignal.timeout(20_000) });
  const page = await get("/");
  const html = await page.text();
  const csp = page.headers.get("content-security-policy") ?? "";
  const connect_src = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "))?.slice("connect-src ".length) ?? "";
  const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((t) => t[0]);
  const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
  const tag = tags[0] ?? "";
  const index = { status: page.status, scripts: tags.length, src: attr(tag, "src"), integrity: attr(tag, "integrity"), module: attr(tag, "type") === "module" };
  const rec = { key: KEY, url: origin, at: new Date().toISOString(), connect_src, index, app: {}, archival: await archivalRead(rpcFetch, wait) };
  if (index.src !== "/app.js") return rec;
  const res = await get(index.src);
  const body = Buffer.from(await res.arrayBuffer());
  const text = body.toString("utf8");
  rec.app = { status: res.status, bytes: body.length, sha384: `sha384-${createHash("sha384").update(body).digest("base64")}`, markers: Object.fromEntries(MARKERS.map((k) => [k, countOf(text, MARK[k])])) };
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
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.pass ? "PASS" : "FAIL"} (${rec.url})`);
    process.exit(r.pass ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
