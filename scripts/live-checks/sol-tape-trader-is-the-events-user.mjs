#!/usr/bin/env node
// Live check of card sol-tape-trader-is-the-events-user: every Solana trade row the deployed helper serves from its own
// chain reads is a trader's trade, named by the user its venue's event names, never by the transaction's other trade,
// and never a venue program's own swap made inside another venue's instruction (that swap stays in the bars and off
// the tape, as a v4 hook's own swap on Base since card market-reads-hold-under-load). Before the card each row of a
// transaction was named by the transaction's first trade's user, so a venue's own fee swap in a trader's transaction
// showed as a second trade of that trader (latent on mainnet today: no decoded venue makes one; the bad answer plants
// that shape on a recorded transaction, as the helper's own test trades.test.ts does).
// It reads the Solana Discover lists at HELPER_HOST with Origin APP_HOST and, token by token (New first), the tape
// (GET /v1/market/trades?chain=solana&token=<t>&limit=50) of up to TOKENS tokens, the first ROWS rows of each tape from
// our own reads (src "chain"), until JUDGE_ENOUGH rows are judged. Each row's transaction and its token's decimals are
// read on the helper's two public Solana providers (TRADES_RPCS), which must give them alike. The check walks the
// transaction's log invoke stack itself and decodes each venue event's bytes (decode.ts decodeEvent: the event layouts,
// cited there); a row is judged when both reads agree and the log is whole: its amt must be a leg of a venue event of
// the transaction; that event must not be logged while another decoded venue runs below it in the stack (a venue's own
// swap); and the row's trader must be that event's user (null only for an event that names none: Orca, Raydium CPMM,
// LaunchLab). It passes when a row is judged and none is wrong; none judged is INCONCLUSIVE (exit 3); no tape of our
// own reads to read is a FAIL.
// After: helper
//   node scripts/live-checks/sol-tape-trader-is-the-events-user.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, so the check's
//   test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { decodeEvent, ORCA, PUMP, PUMP_AMM, RAY_CLMM, RAY_CPMM, RAY_LAUNCHLAB } from "../../apps/helper/src/data/solana/decode.ts";
import { TRADES_RPCS } from "../../apps/helper/src/data/solana/trades.ts";
import { rpcAnswer } from "./provider-answer.mjs";

const KEY = "sol-tape-trader-is-the-events-user";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const TOKENS = 12;
export const ROWS = 4;
export const JUDGE_ENOUGH = 8;
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, ERROR: 2, INCONCLUSIVE: 3 });
// the venue programs whose events the tape decodes, written out here so the check does not take the rule it checks
// (decode.ts VENUES) from the helper
export const VENUE_PROGRAMS = [PUMP, PUMP_AMM, ORCA, RAY_CLMM, RAY_CPMM, RAY_LAUNCHLAB];
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const END = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed.*)$/;
const DATA = /^Program data: ([A-Za-z0-9+/=]+)$/;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** A tape's decimal amt in the token's smallest unit, or null. */
export function units(amt, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(amt));
  if (m === null || (m[2] ?? "").length > decimals) return null;
  return BigInt(m[1] + (m[2] ?? "").padEnd(decimals, "0"));
}

/** Each venue event a whole log holds, with `nested` true when another decoded venue runs below the frame that logged
 *  it; null for a log that is cut or builds no invoke stack. */
export function events(logs) {
  if (!Array.isArray(logs)) return null;
  const stack = [];
  const out = [];
  for (const line of logs) {
    if (typeof line !== "string" || line === "Log truncated") return null;
    let m = INVOKE.exec(line);
    if (m !== null) {
      if (Number(m[2]) !== stack.length + 1) return null;
      stack.push(m[1]);
      continue;
    }
    m = END.exec(line);
    if (m !== null) {
      if (stack.at(-1) !== m[1]) return null;
      stack.pop();
      continue;
    }
    m = DATA.exec(line);
    if (m === null || stack.length === 0) continue;
    const t = decodeEvent(stack.at(-1), Buffer.from(m[1], "base64"));
    if (t !== null) out.push({ venue: t.venue, user: t.user, legs: [t.amt.toString(), t.quote.toString()], nested: stack.slice(0, -1).some((p) => VENUE_PROGRAMS.includes(p)) });
  }
  return stack.length === 0 ? out : null;
}

/** The check on one run: { base, lists, tapes: [{ coin, status, src, rows }], decimals: { coin: n }, logs: { tx: [..] } }. */
export function judge(run) {
  const lines = [];
  const bad = (s) => lines.push(`BAD ${s}`);
  let judged = 0;
  const ours = (run.tapes ?? []).filter((t) => t.status === 200 && t.src === "chain" && Array.isArray(t.rows) && t.rows.length > 0);
  if (ours.length === 0) bad(`no tape of our own reads with a row (${run.lists ?? `${(run.tapes ?? []).length} tapes read`})`);
  for (const tape of ours) {
    const dec = run.decimals?.[tape.coin];
    for (const row of tape.rows) {
      const name = `${tape.coin.slice(0, 8)} trade ${row.tx.slice(0, 12)} (${row.side}, amt ${row.amt}, trader ${row.trader ?? "null"})`;
      const ev = events(run.logs?.[row.tx]);
      if (!Number.isSafeInteger(dec) || ev === null) {
        lines.push(`--  ${name}: ${!Number.isSafeInteger(dec) ? "the token's decimals" : run.logs?.[row.tx] == null ? "its transaction" : "its whole log"} not given alike by two providers`);
        continue;
      }
      judged++;
      const want = units(row.amt, dec)?.toString();
      const legs = ev.filter((e) => e.legs.includes(want));
      if (legs.length === 0) {
        bad(`${name}: amt is no leg of a venue event in its transaction (${ev.map((e) => `${e.venue} ${e.legs.join("/")}`).join(", ") || "none"})`);
        continue;
      }
      const traders = legs.filter((e) => !e.nested);
      if (traders.length === 0) {
        bad(`${name}: a venue program's own swap, made inside another venue's instruction, is on the tape (event user ${legs[0].user || "none"})`);
        continue;
      }
      const named = traders.filter((e) => (row.trader === null ? e.user === "" : e.user === row.trader));
      if (named.length === 0) bad(`${name}: trader is not its event's user (${traders.map((e) => e.user || "none").join(", ")})`);
      else lines.push(`ok  ${name}: a ${named[0].venue} trader's trade, named by its event's user`);
    }
  }
  if (ours.length > 0 && judged === 0) lines.push(`--  no row judged on ${ours.length} tape${ours.length === 1 ? "" : "s"}`);
  else if (judged > 0) lines.push(`ok  ${judged} row${judged === 1 ? "" : "s"} judged on ${ours.length} tape${ours.length === 1 ? "" : "s"} of our own reads`);
  const failed = lines.some((l) => l.startsWith("BAD"));
  return { ok: !failed && judged > 0, exit: failed ? EXIT.FAIL : judged === 0 ? EXIT.INCONCLUSIVE : EXIT.PASS, lines };
}

async function getJson(base, path, fetchFn) {
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
    let body = null;
    try {
      body = await r.json();
    } catch {
      // not JSON: judged by its status
    }
    return { status: r.status, body };
  } catch (e) {
    return { status: `no answer (${e.message})`, body: null };
  }
}

/** One call's result two providers gave alike (by `pick`), or null; a provider's no-answer passed over for the next. */
async function agreed(method, params, pick, fetchFn, rpcs) {
  const got = [];
  for (const url of rpcs) {
    if (got.length === 2) break;
    const a = await rpcAnswer(url, method, params, { fetchFn });
    if (a.noAnswer === undefined && a.error === undefined && a.result != null) got.push(JSON.stringify(pick(a.result)));
  }
  return got.length === 2 && got[0] === got[1] ? JSON.parse(got[0]) : null;
}
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
/** A mint account's decimals (an SPL or Token-2022 mint, initialized: byte 44, and 45 set), or null. */
const decimalsOf = (r) => {
  const v = r?.value;
  if (!isObj(v) || !TOKEN_PROGRAMS.includes(v.owner) || !Array.isArray(v.data) || typeof v.data[0] !== "string") return null;
  const d = Buffer.from(v.data[0], "base64");
  return d.length >= 82 && d[45] === 1 ? d[44] : null;
};
const logsOf = (r) => (isObj(r?.meta) && r.meta.err === null && Array.isArray(r.meta.logMessages) ? r.meta.logMessages : null);

/** What the check reads at `base`. */
export async function read(base = BASE, fetchFn = fetch, rpcs = TRADES_RPCS) {
  const run = { base, at: new Date().toISOString(), tapes: [], decimals: {}, logs: {} };
  const l = await getJson(base, "/v1/market/lists?chain=solana", fetchFn);
  if (l.status !== 200 || !isObj(l.body?.lists)) {
    run.lists = `lists ${l.status}`;
    return run;
  }
  const order = ["new", ...Object.keys(l.body.lists).filter((k) => k !== "new")];
  const coins = [];
  for (const k of order) for (const row of l.body.lists[k] ?? []) if (B58.test(row?.token ?? "") && !coins.includes(row.token)) coins.push(row.token);
  let judged = 0;
  for (const coin of coins.slice(0, TOKENS)) {
    if (judged >= JUDGE_ENOUGH) break;
    const t = await getJson(base, `/v1/market/trades?chain=solana&token=${coin}&limit=50`, fetchFn);
    const rows = Array.isArray(t.body?.trades)
      ? t.body.trades.filter((x) => B58.test(x?.tx ?? "")).slice(0, ROWS).map((x) => ({ tx: x.tx, side: x.side, amt: String(x.amt), trader: typeof x.trader === "string" ? x.trader : null }))
      : null;
    const tape = { coin, status: t.status, src: typeof t.body?.src === "string" ? t.body.src : null, rows };
    run.tapes.push(tape);
    if (tape.status !== 200 || tape.src !== "chain" || rows === null || rows.length === 0) continue;
    run.decimals[coin] = await agreed("getAccountInfo", [coin, { encoding: "base64", commitment: "confirmed" }], decimalsOf, fetchFn, rpcs);
    for (const tx of new Set(rows.map((r) => r.tx))) {
      if (tx in run.logs) continue;
      run.logs[tx] = await agreed("getTransaction", [tx, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], logsOf, fetchFn, rpcs);
    }
    if (Number.isSafeInteger(run.decimals[coin])) judged += rows.filter((r) => Array.isArray(run.logs[r.tx])).length;
  }
  return run;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const run = await read(base);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { exit, lines } = judge(run);
    for (const line of lines) console.log(line);
    console.log(`live-check ${KEY}: ${exit === EXIT.PASS ? "PASS" : exit === EXIT.FAIL ? "FAIL" : "INCONCLUSIVE"} (${base})`);
    process.exit(exit);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
