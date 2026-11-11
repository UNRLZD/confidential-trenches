#!/usr/bin/env node
// Live check of card helper-gives-a-trade-its-reads on HELPER_HOST: one caller draws from each mainnet RPC route the
// signing page reads what one page asks of it in its busiest 10 s, with no 429. On 11 Nov 05:09Z /v1/rpc/solana answered
// 16 getSlot of one address and refused the 17th (429, retry-after 6), while the page reads it as its seat B
// (packages/signpage/src/trade.ts) and a trade alone reads it 22 times beside the page's other reads.
// For each route in WINDOW, one after another, from this one address with Origin SIGN_HOST as the page sends them: the
// route's count of cheap reads (getSlot; eth_blockNumber; on the mark list its only method, the restore's
// getProgramAccounts bucket scan on the mainnet pool's program) in one of the helper's fixed 10 s windows (limits.ts
// LIMIT_WINDOW_MS), from a second into it, each after the last answered and spread over SPREAD_MS, as a page's reads
// spread over its window (the helper paces a keyed provider's sends to its second, so a burst at once is not a page's
// draw). Each read goes through provider-answer.mjs rpcAnswer with the page's Origin. It passes only when every read
// answers 200 with a JSON-RPC answer (a result, or the provider's own JSON-RPC error). A 429 is a FAIL, named with its
// read's place: the helper refused this caller (its share, or a provider's hold it passes on; it never sends which).
// A 5xx or another no-answer is a provider down, not the share: with no 429 the run is INCONCLUSIVE (exit 3). A route
// stops at its first read that is not served, so rpcAnswer's one read again never takes the draw past the window. The mark list is read only once the mainnet pool's deploy record names its program
// (helper-rpc-sell-methods.mjs mainnetPoolProgram); until then its line reads n/a with the reason.
// It draws each route's window once: 42 + 30 + 30 (+ 30) reads in about 40 s, nothing signed, no money moved; a route
// stops at its first read not served.
// After: helper
//   node scripts/live-checks/helper-gives-a-trade-its-reads.mjs [--base <helper url>] [--record <file>]
//   node scripts/live-checks/helper-gives-a-trade-its-reads.mjs --answer <file>     judge a recorded answer, no network
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3; the last line is "<verdict> helper-gives-a-trade-its-reads".
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mainnetPoolProgram, PARAMS } from "./helper-rpc-sell-methods.mjs";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

const KEY = "helper-gives-a-trade-its-reads";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
/** One page's busiest 10 s on each route (apps/helper/src/rpc/rpc.ts RPC_PAGE_NEED, where the numbers are cited; a test
 *  holds the two equal): Solana, the page's seat B, 42; the mark list and the EVM pools' routes, read by its passes, 30. */
export const WINDOW = Object.freeze({ solana: 42, "solana-marks": 30, base: 30, robinhood: 30 });
/** Each route's cheap read. */
export const READ = Object.freeze({
  solana: () => ["getSlot", [{ commitment: "confirmed" }]],
  "solana-marks": (program) => ["getProgramAccounts", PARAMS.getProgramAccounts(program)],
  base: () => ["eth_blockNumber", []],
  robinhood: () => ["eth_blockNumber", []],
});
/** The helper's share window, fixed on the epoch. */
export const WINDOW_MS = 10_000;
/** Past a window's start, so a clock a second off the helper's still lands the draw in one window. */
const INTO_WINDOW_MS = 1_000;
/** The draw's spread inside the window: it ends 2 s before the window does. */
export const SPREAD_MS = 7_000;

/** The check on one recorded run: { program, routes: { [route]: { reads: [{ i, status, ok, retryAfter?, code?, why? }] } | { na } } }. */
export function judge(a) {
  const lines = [];
  let bad = false;
  let unsure = false;
  for (const [route, need] of Object.entries(WINDOW)) {
    const r = a?.routes?.[route];
    if (route === "solana-marks" && a?.program === null && r?.na) {
      lines.push(`ok  [${route}] n/a: ${r.na}`);
      continue;
    }
    const reads = Array.isArray(r?.reads) ? r.reads : [];
    if (reads.length !== need && reads.every((x) => x.ok)) {
      bad = true;
      lines.push(`BAD [${route}] ${reads.length} reads recorded, the window is ${need}`);
      continue;
    }
    const refused = reads.filter((x) => x.status === 429);
    const other = reads.filter((x) => x.status !== 429 && !x.ok);
    if (refused.length > 0) {
      bad = true;
      const f = refused[0];
      const named = [f.code, f.retryAfter === undefined || f.retryAfter === null ? undefined : `retry-after ${f.retryAfter}`].filter(Boolean).join(", ");
      lines.push(`BAD [${route}] ${f.i} of ${need} served: read ${f.i + 1} refused 429${named ? ` (${named})` : ""}`);
    } else if (other.length > 0) {
      unsure = true;
      const f = other[0];
      lines.push(`??  [${route}] read ${f.i + 1} not served (${f.why ?? `HTTP ${f.status}`}): a provider down, not the share`);
    } else lines.push(`ok  [${route}] ${need} of ${need} served in one window`);
  }
  const verdict = bad ? "FAIL" : unsure ? "INCONCLUSIVE" : "PASS";
  return { verdict, ok: verdict === "PASS", lines, exit: EXIT[verdict] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Each route's window, read from `base`. `clock` is the epoch ms (tests move it in `wait`). */
export async function read(base = BASE, fetchFn = fetch, { program = mainnetPoolProgram(), wait = sleep, clock = Date.now } = {}) {
  const out = { program, routes: {} };
  for (const [route, need] of Object.entries(WINDOW)) {
    if (route === "solana-marks" && program === null) {
      out.routes[route] = { na: "no scripts/live-checks/pool-sol-deploy.mainnet.json: no mainnet pool program to scan" };
      continue;
    }
    const now = clock();
    const start = Math.ceil((now - INTO_WINDOW_MS) / WINDOW_MS) * WINDOW_MS + INTO_WINDOW_MS;
    await wait(Math.max(0, start - now));
    const reads = [];
    for (let i = 0; i < need; i++) {
      const at = start + Math.round((i * SPREAD_MS) / need);
      const left = at - clock();
      if (left > 0) await wait(left);
      const [method, params] = READ[route](program);
      const a = await rpcAnswer(`${base.replace(/\/$/, "")}/v1/rpc/${route}`, method, params, { fetchFn, headers: { origin: SIGN }, redirect: "manual" });
      const ok = a.noAnswer === undefined && a.status === 200;
      reads.push(ok ? { i, status: a.status, ok } : { i, status: a.status ?? null, ok, why: String(a.noAnswer ?? `HTTP ${a.status}`).slice(0, 120) });
      if (!ok) break; // the route's verdict is named: nothing more is sent
    }
    out.routes[route] = { reads };
  }
  return out;
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(arg("--base") ?? BASE);
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${v.verdict} ${KEY}`);
    process.exit(v.exit);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
