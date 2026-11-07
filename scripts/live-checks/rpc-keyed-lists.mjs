#!/usr/bin/env node
// Live check of card rpc-keyed-lists: the deployed helper reads each chain from an ordered list of keyed providers, one
// company each, ahead of the public spares, and GET /v1/health names every list (`rpc`) as "<company> <state>" with
// each URL's last identity read (apps/helper/src/rpc/rpc.ts probe: Base's and Robinhood's chain id, Solana's genesis
// hash, NEAR's chain_id). It passes only when:
//   - GET /v1/health answers 200 with an `rpc` object naming solana, base, robinhood and near, each a list;
//   - every entry is "<domain> <state>" with a known state, and no entry holds a URL, a path, a query or a key;
//   - each chain's list holds each company of WANT (the accounts the owner made on 7 Nov: QuickNode and dRPC for Solana,
//     Base and Robinhood, FastNear for NEAR), in that order, and no company twice (three keys at one company fail
//     together);
//   - every entry of every list "answers" its own chain: a key that is down, held, unread or on another chain is BAD.
// The keys exist only on the helper box: this check reads the health alone, never a provider.
//   node scripts/live-checks/rpc-keyed-lists.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "rpc-keyed-lists";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const CHAINS = ["solana", "base", "robinhood", "near"];
export const WANT = { solana: ["quiknode.pro", "drpc.org"], base: ["quiknode.pro", "drpc.org"], robinhood: ["quiknode.pro", "drpc.org"], near: ["fastnear.com"] };
export const STATES = ["answers", "wrong chain", "held", "down", "unread"];
const ENTRY = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+) (answers|wrong chain|held|down|unread)$/;

export async function read(base = BASE, fetchFn = fetch) {
  const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/health`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  return { base, status: r.status, body: await r.text() };
}

/** The check on one recorded read. */
export function judge({ status, body }, want = WANT) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(status === 200, `GET /v1/health answers ${status}`);
  let b;
  try {
    b = JSON.parse(body);
  } catch {
    b = undefined;
  }
  const rpc = b?.rpc;
  const isObj = typeof rpc === "object" && rpc !== null && !Array.isArray(rpc);
  say(isObj, `rpc ${isObj ? "is" : "is not"} an object`);
  if (!isObj) return { ok: false, lines };
  say(!/https?:|\/|\?|=|apikey|api-key|dkey/i.test(JSON.stringify(rpc)), "no URL, path, query or key in rpc");
  for (const chain of CHAINS) {
    const list = rpc[chain];
    if (!Array.isArray(list)) {
      say(false, `${chain}: no list (${JSON.stringify(list)})`);
      continue;
    }
    const parsed = list.map((e) => (typeof e === "string" ? ENTRY.exec(e) : null));
    say(parsed.every((m) => m !== null), `${chain}: every entry is "<domain> <state>" (${JSON.stringify(list)})`);
    const companies = parsed.filter((m) => m !== null).map((m) => m[1]);
    say(new Set(companies).size === companies.length, `${chain}: one key per company (${companies.join(", ") || "none"})`);
    const at = (want[chain] ?? []).map((c) => companies.indexOf(c));
    say(at.every((i) => i >= 0), `${chain}: holds ${(want[chain] ?? []).join(", ")}`);
    say(at.every((i, k) => k === 0 || i > at[k - 1]), `${chain}: in the order ${(want[chain] ?? []).join(", ")}`);
    for (const m of parsed) if (m !== null) say(m[2] === "answers", `${chain}: ${m[1]} ${m[2]}`);
  }
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = judge(answer);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
