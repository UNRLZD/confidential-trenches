#!/usr/bin/env node
// Live check of card token-page-data-complete-and-fast: a Solana token page's logo, links and trade tape on the
// deployed helper. It reads at HELPER_HOST (Origin APP_HOST):
//   GET /v1/market/lists?chain=solana
//   GET /v1/logo/solana/<t>                       for the first LOGOS rows with icon true, and one with icon false
//   GET /v1/market/token?chain=solana&token=<t>   for the busiest pump.fun row
//   GET /v1/market/trades?chain=solana&token=<t>&limit=50, at once and FRESH_MS later, for the TAPES busiest pump.fun rows
// and passes only when:
//   - the lists answer 200 and at least one row has icon true;
//   - every logo read of an icon-true row answers either 200 with an image (png, jpeg, webp or gif, its first bytes that
//     format's, at most 262144 bytes), X-Content-Type-Options nosniff, Content-Security-Policy "default-src 'none';
//     sandbox" and Cache-Control "public, max-age=86400", or 204 with no body (its source refused; a 404 is a failed
//     load the browser logs as a console error, card app-live-run-green-after-119); at least one is 200;
//   - a row with icon false answers no logo: 204 with no body (404 before that card, as the app never asks for it);
//   - the token page answers 200 with a `links` object whose every value is an http(s) URL;
//   - each busy pump.fun token's tape holds at least one trade in a read made within FRESH_MS of the first.
// After: helper
// Serial: jupiter-budget 50 a page check (the lists, one listed pump.fun token's page and three tapes): last of the pages, before the builds
//   node scripts/live-checks/token-page-data-complete-and-fast.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const FRESH_MS = 2_000;
const LOGOS = 3;
const TAPES = 3;
const MAX_BYTES = 262_144;
const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const CSP = "default-src 'none'; sandbox";

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The image format the first bytes (hex) show, or null. */
export function magic(hex) {
  const b = Buffer.from(hex ?? "", "hex");
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString())) return "image/gif";
  return null;
}

/** The busiest pump.fun rows of the lists (by 5m buys, at least 10), and the icon-true and icon-false rows. A run keeps
 *  each row's address as `mint`. */
export function picks(rows) {
  const pump = rows.filter((r) => r.launchpad === "pump.fun" && Number.isSafeInteger(r.buys_5m) && r.buys_5m >= 10).sort((a, b) => b.buys_5m - a.buys_5m);
  return { tapes: pump.slice(0, TAPES).map((r) => r.mint), icons: rows.filter((r) => r.icon === true).slice(0, LOGOS).map((r) => r.mint), plain: rows.find((r) => r.icon === false)?.mint ?? null, page: pump[0]?.mint ?? null };
}

/** The check on one run: { base, lists: { status, rows }, logos: [{ token, status, headers, length, head }], plain,
 *  page: { mint, status, links }, tapes: [{ mint, reads: [{ atMs, status, rows }] }] }; logos and plain also by mint. */
export function judge(run) {
  const lines = [];
  const say = (ok, line) => lines.push(`${ok ? "ok " : "BAD"} ${line}`);
  say(run.lists?.status === 200, `lists answer ${show(run.lists?.status)}`);
  const rows = Array.isArray(run.lists?.rows) ? run.lists.rows : [];
  say(rows.some((r) => r.icon === true), `${rows.filter((r) => r.icon === true).length} of ${rows.length} rows have icon true`);
  let served = 0;
  for (const l of run.logos ?? []) {
    const h = l.headers ?? {};
    if (l.status === 204) {
      say(l.length === 0, `logo ${l.mint}: 204 with ${l.length} bytes (its source refused)`);
      continue;
    }
    const type = h["content-type"];
    const ok = l.status === 200 && TYPES.includes(type) && magic(l.head) === type && l.length > 0 && l.length <= MAX_BYTES && h["x-content-type-options"] === "nosniff" && h["content-security-policy"] === CSP && h["cache-control"] === "public, max-age=86400";
    if (ok) served++;
    say(ok, `logo ${l.mint}: ${l.status} ${show(type)} (bytes show ${show(magic(l.head))}), ${l.length} bytes, nosniff ${show(h["x-content-type-options"])}, CSP ${show(h["content-security-policy"])}, cache ${show(h["cache-control"])}`);
  }
  say(served >= 1, `${served} of ${(run.logos ?? []).length} listed logos served as images`);
  if (run.plain !== null && run.plain !== undefined) say((run.plain.status === 204 || run.plain.status === 404) && run.plain.length === 0, `a row with icon false: logo ${run.plain.status}, ${run.plain.length} bytes`);
  const links = run.page?.links;
  say(run.page?.status === 200 && isObj(links) && Object.values(links).every((v) => typeof v === "string" && /^https?:\/\//.test(v)), `token page ${show(run.page?.mint)}: ${show(run.page?.status)}, links ${show(links)}`);
  say((run.tapes ?? []).length >= 1, `${(run.tapes ?? []).length} busy pump.fun tapes read`);
  for (const t of run.tapes ?? []) {
    const t0 = t.reads?.[0]?.atMs ?? 0;
    const hit = (t.reads ?? []).find((r) => r.status === 200 && r.rows > 0 && r.atMs - t0 <= FRESH_MS);
    say(hit !== undefined, `tape ${t.mint}: ${(t.reads ?? []).map((r) => `${r.status}/${r.rows} rows at +${r.atMs - t0} ms`).join(", ")}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

async function get(base, path) {
  const r = await fetch(base + path, { headers: { Origin: APP }, signal: AbortSignal.timeout(15_000) });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: Object.fromEntries(r.headers), buf };
}

/** One run against `base`. */
export async function read(base) {
  const l = await get(base, "/v1/market/lists?chain=solana");
  let all = [];
  try {
    const j = JSON.parse(l.buf.toString());
    const seen = new Set();
    for (const v of Object.values(j.lists ?? {})) for (const r of v) if (!seen.has(r.token)) (seen.add(r.token), all.push({ mint: r.token, icon: r.icon, launchpad: r.launchpad, buys_5m: r.buys_5m }));
  } catch {
    all = [];
  }
  const p = picks(all);
  const logo = async (t) => {
    const a = await get(base, `/v1/logo/solana/${t}`);
    const keep = ["content-type", "x-content-type-options", "content-security-policy", "cache-control"];
    return { mint: t, status: a.status, headers: Object.fromEntries(keep.filter((k) => a.headers[k] !== undefined).map((k) => [k, a.headers[k]])), length: a.buf.length, head: a.buf.subarray(0, 16).toString("hex") };
  };
  const logos = await Promise.all(p.icons.map(logo));
  const plain = p.plain === null ? null : await logo(p.plain);
  const page = p.page === null ? null : await get(base, `/v1/market/token?chain=solana&token=${p.page}`);
  const tapes = await Promise.all(p.tapes.map(async (t) => {
    const reads = [];
    for (const wait of [0, 1_500]) {
      await new Promise((r) => setTimeout(r, wait));
      const atMs = Date.now();
      const a = await get(base, `/v1/market/trades?chain=solana&token=${t}&limit=50`);
      let n = 0;
      try {
        n = JSON.parse(a.buf.toString()).trades.length;
      } catch {
        n = 0;
      }
      reads.push({ atMs, status: a.status, rows: n });
    }
    return { mint: t, reads };
  }));
  let links;
  try {
    links = page === null ? undefined : JSON.parse(page.buf.toString()).links;
  } catch {
    links = undefined;
  }
  return { base, lists: { status: l.status, rows: all }, logos, plain, page: page === null ? null : { mint: p.page, status: page.status, links }, tapes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => (process.argv.indexOf(k) > 0 ? process.argv[process.argv.indexOf(k) + 1] : undefined);
  try {
    const run = await read(arg("--base") ?? BASE);
    if (arg("--record")) writeFileSync(arg("--record"), JSON.stringify(run, null, 1));
    const r = judge(run);
    for (const line of r.lines) console.log(line);
    console.log(r.ok ? "PASS" : "FAIL");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
