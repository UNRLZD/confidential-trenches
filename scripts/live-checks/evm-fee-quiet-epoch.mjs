#!/usr/bin/env node
// Live check of card evm-fee-quiet-epoch: the deployed helper never answers an EVM pool it carries 404 at a minute's
// turn. It prices an EVM epoch at the epoch's first block (apps/helper/src/pool/evm.ts feeOf); until its provider holds
// a block at or after the start it has no fee, and it answered that 404 not_found, the answer for a pool it does not
// carry: helper live run 42726731385 went red on it (robinhood-testnet, 10 Nov 00:15:00Z), and this card's own reads
// caught it again on the deployed helper at 00:37:00.0-00:37:00.32Z and 00:38:00.0-00:38:00.06Z, 200 a second later,
// with Robinhood testnet making about six blocks a second. From this card on that answer is 503
// { error: { code: "index_behind" } } with Retry-After (apps/helper/src/server.ts).
// After: helper
// For each EVM pool a deploy record names (scripts/ci/helper-live-checks.mjs evmPools), at the next minute's turn (it
// waits for it, at most a minute): GET <helper>/v1/pool/fee?pool=<pool> at each of TURN_OFFSETS_MS after the turn, the
// helper's now, all asked at once; then &epoch=<the epoch before the turn>, which has its first block; and once
// GET /v1/pool/fee?pool=<NOT_CARRIED>, an address no helper carries.
//   PASS: every ask at the turn answers 200 for that pool and the turn's epoch (or the one before, on a helper clock a
//         moment behind), or 503 index_behind with Retry-After;
//         the epoch before answers 200 for that pool and epoch; NOT_CARRIED answers 404 not_found.
//   FAIL: a 404 for a pool the helper carries, any other answer.
//   INCONCLUSIVE: an ask with no answer (a timeout, a 429 or a 503 upstream: the helper's provider), read as live-rerun
//         reads a no-answer; never a pass.
// Whether any ask fell before the helper's provider held the turn's first block is the chain's timing; the lines count
// the asks that met 503 index_behind, so a run shows when the case was hit.
//   node scripts/live-checks/evm-fee-quiet-epoch.mjs [--base <helper url>] [--local] [--record <file> --as good|bad]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
// --local asks this tree's helper code in process instead (server.ts handler on 127.0.0.1, its EVM pool senders from
// the deploy records' pools with a throwaway sender key made at run time, which holds nothing and sends nothing, over
// the kit's providers): how the good answer was recorded before the deploy.
// --record writes the run under `--as` in the file (evm-fee-quiet-epoch.answers.json), replayed by
// evm-fee-quiet-epoch.test.mjs.
import "../net-window.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { evmPools } from "../ci/helper-live-checks.mjs";
import { epochOf, feeUrl, noBlockYet, notFound, POOL_EPOCH_MS } from "./evm-pool-fee-epoch.mjs";
import { EXIT, verdictOf } from "./provider-answer.mjs";

export const BASE = "https://ct-api.unrealized.trade";
/** When after the turn the helper's now is asked: the window the deployed helper answered 404 in was 0 to 320 ms. */
export const TURN_OFFSETS_MS = [0, 80, 160, 240, 320, 480];
/** An address no helper carries as a pool: one past the zero address. */
export const NOT_CARRIED = "0x0000000000000000000000000000000000000001";
const TIMEOUT_MS = 15_000;

const bodyOf = (a) => {
  try {
    return typeof a?.body === "string" ? JSON.parse(a.body) : a?.body;
  } catch {
    return null;
  }
};

/** One ask: { status, retryAfter, body } (the body as text), or { error } when no HTTP answer came. */
const ask = async (fetchFn, url) => {
  try {
    const r = await fetchFn(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: r.status, retryAfter: r.headers.get("retry-after"), body: (await r.text()).slice(0, 2_000) };
  } catch (e) {
    return { error: String(e?.name ?? e?.message ?? e).slice(0, 120) };
  }
};

/** One run: the turn, and per pool its asks at the turn, its ask for the epoch before, and the not-carried ask. */
export async function collect(base = BASE, fetchFn = fetch, pools = evmPools(), { now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const live = Object.entries(pools).filter(([, p]) => p !== null);
  const turnMs = epochOf(now()) + POOL_EPOCH_MS;
  const before = turnMs - POOL_EPOCH_MS;
  const at = await Promise.all(
    live.flatMap(([network, pool]) =>
      TURN_OFFSETS_MS.map(async (o) => {
        await wait(Math.max(0, turnMs + o - now()));
        return { network, pool, offsetMs: o, askedMs: now(), answer: await ask(fetchFn, feeUrl(base, pool)) };
      }),
    ),
  );
  const runs = [];
  for (const [network, pool] of live) runs.push({ network, pool, turn: at.filter((x) => x.pool === pool), before: await ask(fetchFn, feeUrl(base, pool, before)) });
  return { turnMs, runs, notCarried: await ask(fetchFn, feeUrl(base, NOT_CARRIED)) };
}

/** PASS, BAD and no-answer lines for one run, and its verdict. */
export function judge(run) {
  const lines = [];
  let quiet = false;
  const say = (ok, line) => lines.push(`${ok ? "PASS" : "BAD"} ${line}`);
  const host = (() => {
    try {
      return new URL(run?.base ?? BASE).host;
    } catch {
      return "helper";
    }
  })();
  // no HTTP answer, a throttle or a provider's fault on the helper: a no-answer, worded as live-rerun's noAnswerHosts reads it
  const noAnswer = (a) => (a?.error !== undefined ? `${host}: no answer (${a.error})` : a?.status === 429 || (a?.status === 503 && bodyOf(a)?.error?.code === "upstream") ? `${host} HTTP ${a.status}: ${String(a.body).slice(0, 80)}` : null);
  const show = (a) => JSON.stringify({ status: a?.status, body: bodyOf(a) ?? null }).slice(0, 200);
  const turnMs = run?.turnMs;
  const runs = Array.isArray(run?.runs) ? run.runs : [];
  if (runs.length === 0 || typeof turnMs !== "number" || turnMs % POOL_EPOCH_MS !== 0) say(false, "no EVM pool asked at a minute's turn");
  for (const r of runs) {
    const n = `${r?.network} ${r?.pool}`;
    const turn = Array.isArray(r?.turn) ? r.turn : [];
    // a 200 at the turn may be for the epoch before it when the helper's clock is a moment behind this one's
    const fine = (a, ...epochs) => a?.status === 200 && bodyOf(a)?.pool === r.pool && bodyOf(a)?.network === r.network && epochs.includes(bodyOf(a)?.epoch_start_ms);
    let behind = 0;
    let bad = 0;
    for (const t of turn) {
      const why = noAnswer(t?.answer);
      if (why !== null) {
        quiet = true;
        lines.push(`--- ${n} +${t?.offsetMs} ms: ${why}`);
      } else if (noBlockYet(t?.answer) && /^[1-9][0-9]*$/.test(t?.answer?.retryAfter ?? "")) behind++;
      else if (!fine(t?.answer, turnMs, turnMs - POOL_EPOCH_MS)) {
        bad++;
        say(false, `${n}: asked ${t?.offsetMs} ms after the turn ${new Date(turnMs).toISOString()}, the helper answered ${show(t?.answer)}${notFound(t?.answer) ? " (404 for a pool it carries: its no block yet read as a pool it does not carry)" : ""}`);
      }
    }
    if (turn.length !== TURN_OFFSETS_MS.length) say(false, `${n}: ${turn.length} asks at the turn, not ${TURN_OFFSETS_MS.length}`);
    else if (bad === 0) say(true, `${n}: ${turn.length} asks 0 to ${TURN_OFFSETS_MS.at(-1)} ms after the turn ${new Date(turnMs).toISOString()}: ${turn.length - behind} answered 200, ${behind} answered 503 index_behind with a wait, none 404`);
    const b = noAnswer(r?.before);
    if (b !== null) {
      quiet = true;
      lines.push(`--- ${n} the epoch before: ${b}`);
    } else say(fine(r?.before, turnMs - POOL_EPOCH_MS), `${n}: the epoch before the turn, ${new Date(turnMs - POOL_EPOCH_MS).toISOString()}, answered ${show(r?.before)}`);
  }
  const nc = noAnswer(run?.notCarried);
  if (nc !== null) {
    quiet = true;
    lines.push(`--- ${NOT_CARRIED}: ${nc}`);
  } else say(notFound(run?.notCarried), `${NOT_CARRIED}, carried by no helper, answered ${show(run?.notCarried)}`);
  const verdict = verdictOf(lines.length === 0 || lines.some((l) => l.startsWith("BAD")), quiet);
  return { verdict, ok: verdict === "PASS", lines };
}

/** This tree's helper in process on 127.0.0.1: { base, close }. */
async function localHelper() {
  const { randomBytes } = await import("node:crypto");
  const { createServer } = await import("node:http");
  const { handler } = await import("../../apps/helper/src/server.ts");
  const { evmPoolSendersFromEnv } = await import("../../apps/helper/src/pool/evm.ts");
  const env = {};
  for (const [network, pool] of Object.entries(evmPools())) {
    if (pool === null) continue;
    const NAME = network.toUpperCase().replace(/-/g, "_");
    env[`POOL_EVM_ADDRESS_${NAME}`] = pool;
    env[`POOL_EVM_SENDER_KEY_${NAME}`] = `0x${randomBytes(32).toString("hex")}`;
  }
  const { execFileSync } = await import("node:child_process");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const h = createServer(handler(commit, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null, new Map(), evmPoolSendersFromEnv(env)));
  await new Promise((ok) => h.listen(0, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${h.address().port}`, close: () => (h.closeAllConnections(), h.close()) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  try {
    const local = args.includes("--local") ? await localHelper() : null;
    const base = local?.base ?? opt("--base") ?? BASE;
    const run = { base, ...(await collect(base)) };
    local?.close();
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    const file = opt("--record");
    if (file !== undefined) {
      const as = opt("--as");
      if (as !== "good" && as !== "bad") throw new Error("--record takes --as good or --as bad");
      const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      all[as] = { at: new Date().toISOString(), ...run };
      writeFileSync(file, `${JSON.stringify(all, null, 1)}\n`);
    }
    console.log(`${r.verdict} evm-fee-quiet-epoch`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`evm-fee-quiet-epoch: ${e?.message ?? e}`);
    process.exit(2);
  }
}
