#!/usr/bin/env node
// Live check of card helper-token-watch: HELPER_HOST reports USDC's status (markets paper H7 row GET /v1/token-status,
// M:3336; H3.4 check 10, M:1388). It reads /v1/token-status for mainnet USDC, and for another token, with Origin
// APP_HOST, and passes only when:
//   - USDC answers 200 with exactly the kit's HelperTokenStatusAnswer fields, each of its type, token = USDC;
//   - code_hash equals the release's pin DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q (vault.md:22; research
//     proofs/g1-vault-gas/RESULT.md:36), at a positive block_height;
//   - it is not halted: halted is never true, and the vault is never blocked;
//   - the kit's rule holds: while caught_up is false, halted, vault_blocked and code_hash_ok are null; once true, each is
//     a boolean and code_hash_ok says whether code_hash is the pin;
//   - another token answers 404 { error: { code: "token_not_watched" } };
//   - both answers carry a full-sha X-Helper-Commit and echo APP_HOST in Access-Control-Allow-Origin.
// The status line says whether the watch is caught up: until the event watch exists (USDC has no halt view, W:1494),
// halted is null, not false, and the relayers hold every move.
// After: helper
//   node scripts/live-checks/helper-token-watch.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-token-watch";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const PIN = "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q";
export const OTHER = "usdt.tether-token.near";
const FIELDS = ["token", "caught_up", "halted", "vault_blocked", "code_hash_ok", "code_hash", "block_height", "last_event"];
const SHA = /^[0-9a-f]{40}$/;
const EVENTS = ["paused", "unpaused", "blocklist", "unblocklist"];

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};
const boolOrNull = (v) => v === null || typeof v === "boolean";

/** The check on one recorded run: { reads: [{ asked, status, headers, body }] } (asked: the token id the read named). */
export function judge({ reads }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const u = reads.find((r) => r.asked === USDC);
  const o = reads.find((r) => r.asked === OTHER);
  if (!u || !o) {
    say(false, `reads: USDC ${u ? "read" : "missing"}, other token ${o ? "read" : "missing"}`);
    return { ok: false, lines };
  }
  say(u.status === 200, `GET /v1/token-status?token=USDC answers ${u.status}`);
  const b = json(u.body);
  const keys = b && typeof b === "object" ? Object.keys(b) : [];
  say(JSON.stringify(keys) === JSON.stringify(FIELDS), `fields: ${show(keys)}`);
  say(b?.token === USDC, `token: ${show(b?.token)}`);
  say(b?.code_hash === PIN, `code_hash ${show(b?.code_hash)} is the pin ${PIN}`);
  say(Number.isSafeInteger(b?.block_height) && b.block_height > 0, `block_height: ${show(b?.block_height)}`);
  say(typeof b?.caught_up === "boolean" && boolOrNull(b?.halted) && boolOrNull(b?.vault_blocked) && boolOrNull(b?.code_hash_ok), "caught_up a boolean; halted, vault_blocked and code_hash_ok each a boolean or null");
  say(b?.halted !== true, `not halted: halted ${show(b?.halted)}`);
  say(b?.vault_blocked !== true, `the vault not blocked: vault_blocked ${show(b?.vault_blocked)}`);
  if (b?.caught_up === false) say(b.halted === null && b.vault_blocked === null && b.code_hash_ok === null, "not caught up, so halted, vault_blocked and code_hash_ok are null (the kit's rule)");
  else if (b?.caught_up === true) say(typeof b.halted === "boolean" && typeof b.vault_blocked === "boolean" && b.code_hash_ok === (b.code_hash === PIN), "caught up: halted and vault_blocked are booleans and code_hash_ok matches the pin");
  const ev = b?.last_event;
  say(ev === null || (ev && EVENTS.includes(ev.name) && Number.isSafeInteger(ev.block_height) && typeof ev.receipt_id === "string"), `last_event: ${show(ev)}`);
  say(Buffer.byteLength(u.body) <= 1024, `${Buffer.byteLength(u.body)} bytes, within 1 KB (H7)`);
  say(o.status === 404 && json(o.body)?.error?.code === "token_not_watched", `token=${OTHER} answers ${o.status} ${o.body.slice(0, 80)}`);
  for (const r of [u, o]) {
    const tag = r === u ? "[USDC]" : "[other]";
    say(SHA.test(r.headers["x-helper-commit"] ?? ""), `${tag} X-Helper-Commit: ${show(r.headers["x-helper-commit"])}`);
    say(r.headers["access-control-allow-origin"] === APP && r.headers["access-control-allow-credentials"] === undefined, `${tag} Access-Control-Allow-Origin: ${show(r.headers["access-control-allow-origin"])}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines, caughtUp: b?.caught_up };
}

export async function read(base = BASE, fetchFn = fetch) {
  const reads = [];
  for (const token of [USDC, OTHER]) {
    const readAt = new Date().toISOString();
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/token-status?token=${encodeURIComponent(token)}`, {
      method: "GET",
      redirect: "manual",
      headers: { origin: APP, "cache-control": "no-cache" },
    });
    const headers = {};
    for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
    reads.push({ asked: token, readAt, status: r.status, headers, body: await r.text() });
  }
  return { base, reads };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines, caughtUp } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`watch caught up: ${show(caughtUp)}${caughtUp === true ? "" : " (the relayers hold every move until it is)"}`);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
