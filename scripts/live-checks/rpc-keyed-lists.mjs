#!/usr/bin/env node
// Live check of card rpc-keyed-lists: the deployed helper reads each chain from an ordered list of keyed providers, one
// company each, ahead of the public spares, and GET /v1/health names every list (`rpc`) as "<company> <state>" with
// each URL's last identity read (apps/helper/src/rpc/rpc.ts probe: Base's and Robinhood's chain id, Solana's genesis
// hash, NEAR's chain_id). It passes only when:
//   - GET /v1/health answers 200 with an `rpc` object naming solana, base, robinhood and near, each a list;
//   - every entry is "<domain>[ key<n>][ keyless] <state>" with a known state, and no entry holds a URL, a path, a query
//     or a key;
//   - each chain's list holds each keyed provider of WANT (the accounts the owner made on 7 Nov: QuickNode and dRPC's
//     three keys, three accounts, for Base and Robinhood; Helius and QuickNode for Solana, since dRPC's free plan serves
//     no Solana; FastNear for NEAR), in that order, and no keyed
//     provider twice (two keys of one account fail together); a dRPC key is its own provider ("drpc.live key2"), and a
//     keyless entry (a company's public endpoint under a keyed name, NEAR_RPC_URL=free.rpc.fastnear.com say) is no key;
//   - every entry of every list "answers" its own chain: a key that is down, held, unread or on another chain is BAD.
//     A run that fails only on such states reads the health again every 30 s for up to 3 min (the helper reads a URL
//     that did not answer again each minute, rpc.ts KEYED_RETRY_MS), so a passing 429 or timeout does not undo a deploy.
// The keys exist only on the helper box: this check reads the health alone, never a provider.
//   node scripts/live-checks/rpc-keyed-lists.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "rpc-keyed-lists";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const CHAINS = ["solana", "base", "robinhood", "near"];
// dRPC's keys are served at lb.drpc.live/<network>/<key> (drpc.org/docs/gettingstarted/firstrequest), so drpc.live.
// Its free plan serves no Solana (solana.drpc.org getSlot, 7 Nov 15:57Z: error 35 "chain is not available on free
// plan"; M359), so Solana's keyed list is its existing Helius key, then QuickNode.
const DRPC = ["drpc.live key1", "drpc.live key2", "drpc.live key3"];
export const WANT = { solana: ["helius-rpc.com", "quiknode.pro"], base: ["quiknode.pro", ...DRPC], robinhood: ["quiknode.pro", ...DRPC], near: ["fastnear.com"] };
export const STATES = ["answers", "wrong chain", "held", "down", "unread"];
const ENTRY = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+(?: key[1-9])?)( keyless)? (answers|wrong chain|held|down|unread)$/;
/** How long a run that fails only on a URL's state reads the health again, and how often. */
export const RETRY_MS = 180_000;
export const RETRY_EVERY_MS = 30_000;

const STATE_LINE = /^BAD [a-z]+: \S+(?: key[1-9])?(?: keyless)? (wrong chain|held|down|unread)$/;

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
    const companies = parsed.filter((m) => m !== null && m[2] === undefined).map((m) => m[1]);
    say(new Set(companies).size === companies.length, `${chain}: one key per keyed provider (${companies.join(", ") || "none"})`);
    const at = (want[chain] ?? []).map((c) => companies.indexOf(c));
    say(at.every((i) => i >= 0), `${chain}: holds ${(want[chain] ?? []).join(", ")}`);
    say(at.every((i, k) => k === 0 || i > at[k - 1]), `${chain}: in the order ${(want[chain] ?? []).join(", ")}`);
    for (const m of parsed) if (m !== null) say(m[3] === "answers", `${chain}: ${m[1]}${m[2] ?? ""} ${m[3]}`);
  }
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

/** A run: the health read and judged, and while it fails only on a URL's state (held, down, unread, wrong chain),
 *  read again every RETRY_EVERY_MS up to RETRY_MS; any other failure ends the run at once. */
export async function run(readFn, sleep = (ms) => new Promise((go) => setTimeout(go, ms)), retryMs = RETRY_MS, everyMs = RETRY_EVERY_MS) {
  for (let waited = 0; ; waited += everyMs) {
    const answer = await readFn();
    const r = judge(answer);
    const stateOnly = !r.ok && r.lines.filter((l) => l.startsWith("BAD")).every((l) => STATE_LINE.test(l));
    if (r.ok || !stateOnly || waited + everyMs > retryMs) return { ...r, answer, waited };
    await sleep(everyMs);
  }
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const { ok, lines, answer, waited } = await run(() => read(opt("--base", BASE)));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.base}${waited > 0 ? `, after ${waited / 1000} s of re-reads` : ""})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
