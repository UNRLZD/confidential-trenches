#!/usr/bin/env node
// Live check of card base-reads-never-throttled: no Base or Robinhood read through the helper waits on a throttle the
// helper's own work caused. dRPC limits the helper's one IP, its keys together, at a rate it
// changes; the helper draws every dRPC key from one rate, and a refusal of any of them holds them all and halves the pace
// (apps/helper/src/limits/limits.ts RATE_BACK_MAX_S), so a caller's read goes to the next provider instead of into the
// same refusal. After a helper deploy it reads:
//   - GET /v1/health: every dRPC key on Base's and Robinhood's lists ("drpc.live key<n>") answers its chain, none held;
//   - ROUNDS rounds, ROUND_GAP_MS apart, of each chain's two kinds of read as the signing page asks them, with Origin
//     SIGN_HOST: eth_blockNumber on /v1/rpc/<chain>, then on ?keyed=only the chain's pool's eth_getLogs over the 100
//     blocks ending LOGS_BACK blocks under that head (dRPC's span, so dRPC's keys serve it: a sign-in's pool sync).
// PASS only when the health holds no dRPC key but "answers", and every read answers 200 a JSON-RPC result (a block
// number; a list of logs) within SHOWN_MS of its send, its Server-Timing rpc-wait (the helper's own wait for a hold or a
// pace before it sent) at most WAIT_MAX_MS. A 429 or 503 (the helper's "every provider held"), a JSON-RPC error, a
// slower answer or a longer wait FAILs. A health that fails only on a key's state is read again every RETRY_EVERY_MS for
// up to RETRY_MS (the helper reads a key that did not answer again each minute, rpc.ts KEYED_RETRY_MS). A route that
// answers nothing (no connection, a timeout) is INCONCLUSIVE. The keys exist only on the helper box: this check reads
// the helper alone, never a provider.
// After: helper
// Serial: evm-keyed 195 (its reads draw the keyed Base and Robinhood providers)
//   node scripts/live-checks/base-reads-never-throttled.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "base-reads-never-throttled";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
export const CHAINS = ["base", "robinhood"];
/** A shown read's longest send to answer (base-reads-never-starve-max's SHOWN_MS). */
export const SHOWN_MS = 3_000;
/** The longest the helper may hold a read before its send: a pace's turn, never a hold's second. [design: half a second.] */
export const WAIT_MAX_MS = 500;
export const ROUNDS = 3;
export const ROUND_GAP_MS = 2_000;
/** How far under the head the logs page ends: past the newest blocks a provider may not hold yet. */
export const LOGS_BACK = 50;
export const LOGS_SPAN = 100;
export const RETRY_MS = 180_000;
export const RETRY_EVERY_MS = 30_000;
export const TIMEOUT_MS = 15_000;
/** Each chain's pool, the kit's pin (its eth_getLogs is what a sign-in's pool sync reads). */
export const POOLS = Object.fromEntries(CHAINS.map((c) => [c, evmPoolVenues()[c].pool]));
const DRPC_KEY = /^drpc\.live key[1-9]( keyless)? (answers|wrong chain|held|down|unread)$/;
const HEX = /^0x[0-9a-f]{1,16}$/i;
const STATE_LINE = /^BAD health [a-z]+: drpc\.live key[1-9] (wrong chain|held|down|unread)$/;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export async function readHealth(base = BASE, fetchFn = fetch) {
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/health`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { noAnswer: String(e?.name ?? e) };
  }
}

/** One run: the health, then ROUNDS rounds of each chain's head and logs page. */
export async function read(base = BASE, fetchFn = fetch, clock = () => performance.now(), sleep = sleepMs) {
  const health = await readHealth(base, fetchFn);
  const reads = [];
  const ask = async (chain, keyed, method, params) => {
    const url = `${base.replace(/\/$/, "")}/v1/rpc/${chain}${keyed ? "?keyed=only" : ""}`;
    const t0 = clock();
    const a = await rpcAnswer(url, method, params, { fetchFn, timeoutMs: TIMEOUT_MS, headers: { origin: SIGN, "cache-control": "no-cache" }, redirect: "manual", keep: ["retry-after", "server-timing"] });
    const r = { chain, method, keyed, ms: Math.round(clock() - t0), ...a };
    reads.push(r);
    return r;
  };
  for (let round = 0; round < ROUNDS; round++) {
    if (round > 0) await sleep(ROUND_GAP_MS);
    for (const chain of CHAINS) {
      const head = await ask(chain, false, "eth_blockNumber", []);
      if (typeof head.result !== "string" || !HEX.test(head.result)) continue;
      const to = BigInt(head.result) - BigInt(LOGS_BACK);
      await ask(chain, true, "eth_getLogs", [{ address: POOLS[chain], fromBlock: `0x${(to - BigInt(LOGS_SPAN - 1)).toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
    }
  }
  return { base, health, reads };
}

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
/** The helper's own wait before its send, from Server-Timing's rpc-wait; undefined when it names none. */
export const waitOf = (timing) => {
  const m = /(?:^|,)\s*rpc-wait;dur=(\d+(?:\.\d+)?)/.exec(String(timing ?? ""));
  return m === null ? undefined : Number(m[1]);
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
    for (const chain of CHAINS) {
      const list = Array.isArray(rpc?.[chain]) ? rpc[chain] : [];
      const keys = list.filter((e) => typeof e === "string" && e.startsWith("drpc.live "));
      say(keys.length >= 1, `health ${chain}: ${keys.length} dRPC keys listed`);
      for (const e of keys) {
        const m = DRPC_KEY.exec(e);
        if (m === null) say(false, `health ${chain}: an entry not in the health's form: ${show(e.slice(0, 60))}`);
        else say(m[2] === "answers", `health ${chain}: ${e}`);
      }
    }
  }
  for (const chain of CHAINS) {
    const rs = (run.reads ?? []).filter((x) => x.chain === chain);
    say(rs.length >= ROUNDS * 2, `[${chain}] ${rs.length} reads, ${ROUNDS * 2} wanted`);
    for (const r of rs) {
      const tag = `[${chain}${r.keyed ? " keyed" : ""}] ${r.method}`;
      if (r.status === undefined || r.status === null) {
        quiet = true;
        lines.push(`no-answer ${tag} ${r.noAnswer ?? "no HTTP answer"}`);
        continue;
      }
      if (r.status !== 200) {
        say(false, `${tag} answers ${r.status} (Retry-After ${show(r.kept?.["retry-after"] ?? undefined)}): the helper held the read`);
        continue;
      }
      const shaped = r.method === "eth_blockNumber" ? typeof r.result === "string" && HEX.test(r.result) : Array.isArray(r.result);
      say(r.error === undefined && r.noAnswer === undefined && shaped, `${tag} 200 with a result: ${show(r.error ?? r.noAnswer ?? (Array.isArray(r.result) ? `${r.result.length} logs` : r.result))}`);
      say(Number.isFinite(r.ms) && r.ms >= 0 && r.ms <= SHOWN_MS, `${tag} answered in ${show(r.ms)} ms, at most ${SHOWN_MS}`);
      const w = waitOf(r.kept?.["server-timing"]);
      say(w !== undefined && w <= WAIT_MAX_MS, `${tag} the helper's wait before its send ${show(w)} ms, at most ${WAIT_MAX_MS}`);
    }
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
