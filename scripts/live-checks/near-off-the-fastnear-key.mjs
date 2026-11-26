#!/usr/bin/env node
// Live check of card near-off-the-fastnear-key: the deployed helper counts every request it sends to its FastNEAR key
// (NEAR_RPC_URL_FASTNEAR, a Pro key shared with UNRLZD) per UTC day, its own reads apart from the reads it relays for
// devices, and names them with the daily ceiling on GET /v1/health's X-Helper-Near-Key-Reads (apps/helper/src/limits/
// key-reads.ts). One command reads it: curl -sI https://ct-api.unrealized.trade/v1/health | grep -i near-key-reads.
// It moves no money: it reads the health, asks one withdraw fee quote for mainnet USDC (the quote reads the NEAR pair,
// FastNEAR's key first: token-status/status.ts pairFetch), waits SETTLE_MS, and reads the health again. It passes only
// when:
//   - both health reads answer 200 with the header as "<today> helper=<n> seat=<n> of <ceiling> open|hit, <yesterday>
//     helper=<n> seat=<n> of <ceiling> open|hit", today the UTC day of the read, no URL, query or key in it;
//   - the ceiling is the same in both, and today's count was open (under it) at the first read: at the ceiling the key is
//     not asked, so nothing shows the key in use;
//   - the fee quote answers 200, and the helper's count rose between the two reads while the seat's did not fall: the
//     helper asked the key it holds, and the count is the one the helper keeps.
// After: helper
//   node scripts/live-checks/near-off-the-fastnear-key.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "near-off-the-fastnear-key";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Mainnet USDC, the vault's one token (packages/kit/src/vault/shapes.ts VAULT_CONSTANTS.TOKEN). */
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // gitleaks:allow (a public account id)
export const HEADER = "x-helper-near-key-reads";
/** The wait after the quote: past twice the helper's DAY_SYNC_MS (1 s), so a second helper's count (a handover's) is
 *  written and read again before the second health read. */
export const SETTLE_MS = 2_500;
const DAY = /^(\d{4}-\d{2}-\d{2}) helper=(\d+) seat=(\d+) of (\d+) (open|hit)$/;

/** One run: the health, one fee quote, SETTLE_MS, the health again, each with its time. */
export async function read(base = BASE, fetchFn = fetch, sleep = (ms) => new Promise((go) => setTimeout(go, ms)), now = Date.now) {
  const b = base.replace(/\/$/, "");
  const opts = { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } };
  const health = async () => {
    const at = now();
    const r = await fetchFn(`${b}/v1/health`, opts);
    await r.text();
    return { at, status: r.status, line: r.headers.get(HEADER) };
  };
  const before = await health();
  const f = await fetchFn(`${b}/v1/withdraw/fee?token=${USDC}`, opts);
  const fee = { status: f.status, body: (await f.text()).slice(0, 2_048) };
  await sleep(SETTLE_MS);
  const after = await health();
  return { base, before, fee, after };
}

/** A header line as its two days, or null when it is not one. */
export function daysOf(line) {
  if (typeof line !== "string") return null;
  const parts = line.split(", ");
  if (parts.length !== 2) return null;
  const days = parts.map((p) => DAY.exec(p));
  if (days.some((d) => d === null)) return null;
  return days.map((d) => ({ day: d[1], helper: Number(d[2]), seat: Number(d[3]), ceiling: Number(d[4]), state: d[5] }));
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The check on one recorded run. */
export function judge({ before, fee, after }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const read = [before, after].map((h) => daysOf(h?.line));
  for (const [i, h] of [before, after].entries()) {
    const which = i === 0 ? "first" : "second";
    say(h?.status === 200, `GET /v1/health (${which}) answers ${h?.status}`);
    say(read[i] !== null, `${HEADER} (${which}): ${JSON.stringify(h?.line ?? null)} names today and yesterday`);
    say(!/https?:|\/\/|\?|api-?key|fastnear|drpc/i.test(h?.line ?? ""), `${HEADER} (${which}): no URL, query or key`);
    const d = read[i];
    if (d === null) continue;
    say(d[0].day === utcDay(h.at), `${HEADER} (${which}): today is ${d[0].day} (UTC day of the read: ${utcDay(h.at)})`);
    say(d[1].day === utcDay(Date.parse(`${d[0].day}T00:00:00Z`) - 86_400_000), `${HEADER} (${which}): the day before is ${d[1].day}`);
    say(d.every((x) => x.ceiling > 0) && d[0].ceiling === d[1].ceiling, `${HEADER} (${which}): one ceiling, ${d[0].ceiling}`);
  }
  const [a, b] = read;
  if (a !== null && b !== null) {
    say(a[0].ceiling === b[0].ceiling, `the ceiling is the same in both reads (${a[0].ceiling}, ${b[0].ceiling})`);
    say(a[0].state === "open", `today's key reads were under the ceiling at the first read (${a[0].helper + a[0].seat} of ${a[0].ceiling}, ${a[0].state})`);
    say(a[0].day === b[0].day, `both reads on one UTC day (${a[0].day}, ${b[0].day})`);
  }
  say(fee?.status === 200, `GET /v1/withdraw/fee for USDC: ${fee?.status} (want 200)`);
  if (a !== null && b !== null && a[0].day === b[0].day) {
    say(b[0].helper > a[0].helper, `the helper's key reads moved: ${a[0].helper} -> ${b[0].helper}`);
    say(b[0].seat >= a[0].seat, `the seat's key reads did not fall: ${a[0].seat} -> ${b[0].seat}`);
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
