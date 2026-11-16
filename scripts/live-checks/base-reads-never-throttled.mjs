#!/usr/bin/env node
// Live check of card base-reads-never-throttled: no Base or Robinhood read through the helper waits on a throttle the
// helper's own work caused, a dRPC refusal on one chain holds no other chain's dRPC, and Base's pool store is at the head
// or gaining on it (so a device's pool reads come from the store, not from a provider). After a helper deploy it reads:
//   - GET /v1/health: on Base, Robinhood and NEAR every dRPC entry ("drpc.live key<n>", NEAR's "drpc.live") answers its
//     chain, none held or unread (live 16 Nov 12:25Z, PR 905: Base's refusals held Robinhood's and NEAR's dRPC, "unread");
//   - ROUNDS rounds, ROUND_GAP_MS apart, of each chain's two kinds of read as the signing page asks them, with Origin
//     SIGN_HOST: eth_blockNumber on /v1/rpc/<chain>, then on ?keyed=only the chain's pool's eth_getLogs over the 100
//     blocks ending LOGS_BACK blocks under that head (a sign-in's pool sync);
//   - Base's pool store: on ?keyed=only one eth_getLogs of the pool from its deploy block (STORE_FROM) to STORE_BACK
//     blocks under the finalized head the helper names. A 200 list within STORE_MS is the store at the head. The
//     route's range cap naming the store's progress ("pool logs kept to block N") is read once more STORE_GAP_MS later:
//     the store gaining at least STORE_GAIN_MIN blocks (Base's own blocks in that time) is a fill catching up;
//     standing still is FAIL (live 16 Nov 12:2xZ: the fill ended on a failed head read, apps/helper/src/rpc/rpc.ts).
// PASS only when the health holds no dRPC entry but "answers", every read answers 200 a JSON-RPC result within SHOWN_MS
// with Server-Timing rpc-wait (the helper's own wait before it sent) at most WAIT_MAX_MS, and the store is at the head or
// gaining. A 429 or 503, a JSON-RPC error, a slower answer or a longer wait FAILs. A health that fails only on a key's
// state is read again every RETRY_EVERY_MS for up to RETRY_MS (the helper reads a key that did not answer again each
// minute, rpc.ts KEYED_RETRY_MS). A route that answers nothing (no connection, a timeout) is INCONCLUSIVE. The keys
// exist only on the helper box: this check reads the helper alone, never a provider.
// After: helper
// Serial: evm-keyed 195 (its reads draw the keyed Base and Robinhood providers)
//   node scripts/live-checks/base-reads-never-throttled.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { mainnetVenues } from "./mainnet-venues.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "base-reads-never-throttled";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
/** The chains whose reads are timed, and the chains whose dRPC entries the health must show answering. */
export const CHAINS = ["base", "robinhood"];
export const HEALTH_CHAINS = ["base", "robinhood", "near"];
/** A shown read's longest send to answer (base-reads-never-starve-max's SHOWN_MS). */
export const SHOWN_MS = 3_000;
/** The longest the helper may hold a read before its send: a pace's turn, never a hold's second. [design: half a second.] */
export const WAIT_MAX_MS = 500;
export const ROUNDS = 3;
export const ROUND_GAP_MS = 2_000;
/** How far under the head the logs page ends: past the newest blocks a provider may not hold yet. */
export const LOGS_BACK = 50;
export const LOGS_SPAN = 100;
/** Base's pool deploy block (apps/helper/src/rpc/pool-logs.ts POOL_LOGS_FROM, the store's start). */
export const STORE_FROM = 54_325_671;
/** Blocks under the helper's finalized head the store read ends: inside the helper's own head read, which it takes at
 *  most every 10 s (rpc.ts FINAL_HEAD_MS, 50 of Base's blocks). [design: one 100-block page.] */
export const STORE_BACK = 100;
/** The store read's longest answer: from the store, nothing upstream. [design: helper-keyed-logs-serve-a-whole-pool-range's HELPER_MS.] */
export const STORE_MS = 5_000;
export const STORE_GAP_MS = 30_000;
/** Base's blocks in STORE_GAP_MS (5 a second, read 16 Nov 12:32Z: 597,982 blocks in 119,597 s): a store that gains less
 *  is not catching up. */
export const STORE_GAIN_MIN = 150;
export const RETRY_MS = 180_000;
export const RETRY_EVERY_MS = 30_000;
export const TIMEOUT_MS = 15_000;
/** Each chain's pool, the kit's pin (its eth_getLogs is what a sign-in's pool sync reads). */
export const POOLS = Object.fromEntries(CHAINS.map((c) => [c, mainnetVenues()[c].pool]));
const DRPC = /^drpc\.live( key[1-9])?( keyless)? (answers|wrong chain|held|down|unread)$/;
const HEX = /^0x[0-9a-f]{1,16}$/i;
const STATE_LINE = /^BAD health [a-z]+: drpc\.live( key[1-9])? (wrong chain|held|down|unread)$/;
const KEPT = /^pool logs kept to block (\d+)$/;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export async function readHealth(base = BASE, fetchFn = fetch) {
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/health`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { noAnswer: String(e?.name ?? e) };
  }
}

/** One run: the health, ROUNDS rounds of each chain's head and logs page, then Base's store read (twice while filling). */
export async function read(base = BASE, fetchFn = fetch, clock = () => performance.now(), sleep = sleepMs) {
  const health = await readHealth(base, fetchFn);
  const reads = [];
  const ask = async (chain, keyed, method, params) => {
    const url = `${base.replace(/\/$/, "")}/v1/rpc/${chain}${keyed ? "?keyed=only" : ""}`;
    const t0 = clock();
    const a = await rpcAnswer(url, method, params, { fetchFn, timeoutMs: TIMEOUT_MS, headers: { origin: SIGN, "cache-control": "no-cache" }, redirect: "manual", keep: ["retry-after", "server-timing"] });
    return { chain, method, keyed, ms: Math.round(clock() - t0), ...a };
  };
  for (let round = 0; round < ROUNDS; round++) {
    if (round > 0) await sleep(ROUND_GAP_MS);
    for (const chain of CHAINS) {
      const head = await ask(chain, false, "eth_blockNumber", []);
      reads.push(head);
      if (typeof head.result !== "string" || !HEX.test(head.result)) continue;
      const to = BigInt(head.result) - BigInt(LOGS_BACK);
      reads.push(await ask(chain, true, "eth_getLogs", [{ address: POOLS[chain], fromBlock: `0x${(to - BigInt(LOGS_SPAN - 1)).toString(16)}`, toBlock: `0x${to.toString(16)}` }]));
    }
  }
  const store = [];
  const final = await ask("base", false, "eth_getBlockByNumber", ["finalized", false]);
  const n = typeof final.result?.number === "string" && HEX.test(final.result.number) ? BigInt(final.result.number) : undefined;
  store.push({ ...final, result: n === undefined ? final.result : { number: final.result.number } });
  if (n !== undefined) {
    const whole = [{ address: POOLS.base, fromBlock: `0x${STORE_FROM.toString(16)}`, toBlock: `0x${(n - BigInt(STORE_BACK)).toString(16)}` }];
    const cut = (a) => (Array.isArray(a.result) ? { ...a, result: undefined, logs: a.result.length } : a);
    const first = await ask("base", true, "eth_getLogs", whole);
    store.push(cut(first));
    if (KEPT.test(String(first.error?.data ?? ""))) {
      await sleep(STORE_GAP_MS);
      store.push(cut(await ask("base", true, "eth_getLogs", whole)));
    }
  }
  return { base, health, reads, store };
}

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
/** The helper's own wait before its send, from Server-Timing's rpc-wait; undefined when it names none. */
export const waitOf = (timing) => {
  const m = /(?:^|,)\s*rpc-wait;dur=(\d+(?:\.\d+)?)/.exec(String(timing ?? ""));
  return m === null ? undefined : Number(m[1]);
};
const keptOf = (a) => {
  const m = KEPT.exec(String(a?.error?.data ?? ""));
  return a?.error?.code === -32602 && m !== null ? Number(m[1]) : undefined;
};

/** The check on one run: { ok, quiet, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  const h = run.health ?? {};
  if (h.status === undefined) {
    quiet = true;
    lines.push(`no-answer health ${h.noAnswer ?? "no HTTP answer"}`);
  } else {
    say(h.status === 200, `health answers ${h.status}`);
    let rpc;
    try {
      rpc = JSON.parse(h.body).rpc;
    } catch {
      rpc = undefined;
    }
    for (const chain of HEALTH_CHAINS) {
      const list = Array.isArray(rpc?.[chain]) ? rpc[chain] : [];
      const keys = list.filter((e) => typeof e === "string" && e.startsWith("drpc.live "));
      say(keys.length >= 1, `health ${chain}: ${keys.length} dRPC entries listed`);
      for (const e of keys) {
        const m = DRPC.exec(e);
        if (m === null) say(false, `health ${chain}: an entry not in the health's form: ${show(e.slice(0, 60))}`);
        else say(m[3] === "answers", `health ${chain}: ${e}`);
      }
    }
  }
  const timed = (tag, r, shaped, maxMs) => {
    if (r.status === undefined || r.status === null) {
      quiet = true;
      lines.push(`no-answer ${tag} ${r.noAnswer ?? "no HTTP answer"}`);
      return false;
    }
    if (r.status !== 200) {
      say(false, `${tag} answers ${r.status} (Retry-After ${show(r.kept?.["retry-after"] ?? undefined)}): the helper held the read`);
      return false;
    }
    say(r.error === undefined && r.noAnswer === undefined && shaped, `${tag} 200 with a result: ${show(r.error ?? r.noAnswer ?? (Array.isArray(r.result) ? `${r.result.length} logs` : r.logs !== undefined ? `${r.logs} logs` : r.result))}`);
    say(Number.isFinite(r.ms) && r.ms >= 0 && r.ms <= maxMs, `${tag} answered in ${show(r.ms)} ms, at most ${maxMs}`);
    const w = waitOf(r.kept?.["server-timing"]);
    say(w !== undefined && w <= WAIT_MAX_MS, `${tag} the helper's wait before its send ${show(w)} ms, at most ${WAIT_MAX_MS}`);
    return true;
  };
  for (const chain of CHAINS) {
    const rs = (run.reads ?? []).filter((x) => x.chain === chain);
    say(rs.length >= ROUNDS * 2, `[${chain}] ${rs.length} reads, ${ROUNDS * 2} wanted`);
    for (const r of rs) timed(`[${chain}${r.keyed ? " keyed" : ""}] ${r.method}`, r, r.method === "eth_blockNumber" ? typeof r.result === "string" && HEX.test(r.result) : Array.isArray(r.result), SHOWN_MS);
  }
  // Base's pool store: at the head (a 200 list), or gaining on it between two reads
  const [final, first, second] = run.store ?? [];
  if (final === undefined) say(false, "[base store] not read");
  else if (final.status === undefined || final.status === null) (quiet = true), lines.push(`no-answer [base store] finalized head ${final.noAnswer ?? "no HTTP answer"}`);
  else if (typeof final.result?.number !== "string" || !HEX.test(final.result.number)) say(false, `[base store] the helper named no finalized head: ${show(final.error ?? final.noAnswer ?? final.status)}`);
  else if (first === undefined) say(false, "[base store] the pool's whole range not read");
  else if (first.status === 200 && first.error === undefined && first.noAnswer === undefined && Number.isInteger(first.logs)) {
    timed("[base store] the pool's whole range", first, true, STORE_MS);
    say(true, `[base store] at the head: ${first.logs} logs from block ${STORE_FROM} to ${BigInt(final.result.number) - BigInt(STORE_BACK)}`);
  } else if (keptOf(first) === undefined) timed("[base store] the pool's whole range", first, false, STORE_MS);
  else if (second === undefined || (second.status === undefined && second.noAnswer !== undefined)) {
    quiet = true;
    lines.push(`no-answer [base store] the second read ${second?.noAnswer ?? "not read"}`);
  } else if (second.status === 200 && Number.isInteger(second.logs)) say(true, `[base store] reached the head between its reads: ${second.logs} logs`);
  else {
    const a = keptOf(first);
    const b = keptOf(second);
    const head = Number(BigInt(final.result.number));
    say(b !== undefined && b - a >= STORE_GAIN_MIN, `[base store] filling: kept to block ${a}, then ${show(b)} ${STORE_GAP_MS / 1000} s later (${b === undefined ? "no progress named" : `${b - a} blocks gained, at least ${STORE_GAIN_MIN}; ${head - b} behind the finalized head`})`);
  }
  const bad = lines.filter((l) => l.startsWith("BAD"));
  return { ok: bad.length === 0 && !quiet, quiet, stateOnly: bad.length > 0 && bad.every((l) => STATE_LINE.test(l)), verdict: verdictOf(bad.length > 0, quiet), lines };
}

/** A run, read again while it fails only on a key's state, up to RETRY_MS. */
export async function run(base = BASE, fetchFn = fetch, clock = () => performance.now(), sleep = sleepMs) {
  const t0 = clock();
  for (;;) {
    const r = await read(base, fetchFn, clock, sleep);
    const j = judge(r);
    if (!j.stateOnly || clock() - t0 + RETRY_EVERY_MS > RETRY_MS) return { run: r, ...j };
    await sleep(RETRY_EVERY_MS);
  }
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const r = await run(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(r.run, null, 1)}\n`);
    for (const l of r.lines) console.log(l);
    console.log(`live-check ${KEY}: ${r.verdict} (${r.run.base})`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
