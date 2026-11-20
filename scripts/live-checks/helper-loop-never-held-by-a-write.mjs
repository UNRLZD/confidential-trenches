#!/usr/bin/env node
// Live check of card helper-loop-never-held-by-a-write: at a live run's load the deployed helper answers a page's
// market reads, never a 503 shed (limits/loop-busy.ts loopShed: a loop sample a second late) and never a bare 503. Live
// run 44625951937 (helper f5639e5bb) shed solana-legs-share-wait's idle probes for 31 s (+16.3 s to +47.8 s, each a 503)
// and gave helper-token-page-cold a 503 with no cause in Server-Timing: the helper's own work held its loop past a
// second at a load one runner makes. It reads the Solana lists, a cached read the helper answers from what it holds,
// PROBES times, one every GAP_MS (the idle probes' pace), with the page's Origin, and passes only when:
//   - every probe answers 200 (a 503 is named with its Server-Timing cause, `loop` for the shed, or as bare when it names
//     none: server.ts SHED_WAIT names the shed's);
//   - no probe takes more than SLOW_MS beyond the run's fastest one (the runner's own round trip): a cached read held
//     that long waited on the helper's loop.
// After: helper
//   node scripts/live-checks/helper-loop-never-held-by-a-write.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-loop-never-held-by-a-write";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const PATH = "/v1/market/lists?chain=solana";
/** Probes in a run [design: 30 over a minute, the span the live run's shed lasted, so a hold in it is read]. */
export const PROBES = 30;
/** Between two probes' starts [design: 2 s, solana-legs-share-wait's idle probes' pace]. */
export const GAP_MS = 2_000;
/** A probe this much over the run's fastest one waited on the loop [design: 1 s, SHED_LATE_MS, the late sample that sheds:
 *  a cached read answers in milliseconds]. */
export const SLOW_MS = 1_000;
/** One probe's bound [design: the page's own 10 s read bound]. */
export const TIMEOUT_MS = 10_000;

/** One probe: its offset from the run's start, status, time, Retry-After and Server-Timing. */
async function probe(base, fetchFn, now, start) {
  const at = Math.round(now() - start);
  const began = now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${PATH}`, { redirect: "manual", headers: { origin: APP }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await r.arrayBuffer();
    return { at, status: r.status, ms: Math.round(now() - began), retryAfter: r.headers.get("retry-after"), timing: r.headers.get("server-timing") };
  } catch (e) {
    return { at, status: null, ms: Math.round(now() - began), error: String(e?.cause?.code ?? e?.name ?? "error") };
  }
}

/** The run: { base, probes }, PROBES probes GAP_MS apart. */
export async function read(base = BASE, fetchFn = fetch, now = () => performance.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), n = PROBES) {
  const start = now();
  const probes = [];
  for (let i = 0; i < n; i++) {
    const due = start + i * GAP_MS;
    if (due > now()) await sleep(due - now());
    probes.push(await probe(base, fetchFn, now, start));
  }
  return { base, probes };
}

/** A 503's cause in Server-Timing (its metric names, `total` aside), or null for a bare one. */
export const causeOf = (timing) => {
  const names = String(timing ?? "").split(",").map((m) => m.trim().split(";")[0]).filter((m) => m !== "" && m !== "total");
  return names.length === 0 ? null : names.join(", ");
};

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const probes = Array.isArray(run?.probes) ? run.probes : [];
  say(probes.length === PROBES, `${probes.length} probes of ${PATH}, ${GAP_MS / 1000} s apart (want ${PROBES})`);
  const failed = probes.filter((p) => p.status !== 200);
  const named = failed.map((p) => `+${(p.at / 1000).toFixed(1)} s ${p.status ?? p.error}${p.retryAfter ? ` Retry-After ${p.retryAfter}` : ""}${p.status === 503 ? ` (${causeOf(p.timing) ?? "bare: no cause in Server-Timing"})` : ""}`);
  say(failed.length === 0, `${probes.length - failed.length} of ${probes.length} probes answered 200${failed.length ? `; not: ${named.slice(0, 8).join(", ")}${named.length > 8 ? ", ..." : ""}` : ""}`);
  const shed = failed.filter((p) => p.status === 503 && /(^|,\s*)loop(;|,|$)/.test(p.timing ?? ""));
  if (shed.length > 0) say(false, `${shed.length} probes shed: the helper's loop held past a second at this load`);
  const bare = failed.filter((p) => p.status === 503 && causeOf(p.timing) === null);
  if (bare.length > 0) say(false, `${bare.length} probes answered 503 with no cause in Server-Timing (a bare 503)`);
  const answered = probes.filter((p) => p.status !== null);
  const floor = answered.length === 0 ? 0 : Math.min(...answered.map((p) => p.ms));
  const slow = answered.filter((p) => p.ms - floor > SLOW_MS);
  say(answered.length > 0 && slow.length === 0, `probes over the fastest (${floor} ms) by more than ${SLOW_MS} ms: ${slow.length}${slow.length ? ` (${slow.slice(0, 8).map((p) => `+${(p.at / 1000).toFixed(1)} s ${p.ms} ms`).join(", ")})` : ""}; slowest ${answered.length ? Math.max(...answered.map((p) => p.ms)) : "none"} ms`);
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    const record = opt("--record", null);
    if (record !== null) writeFileSync(record, `${JSON.stringify(run, null, 2)}\n`);
    const v = judge(run);
    for (const l of v.lines) console.log(l);
    console.log(`live-check ${KEY}: ${v.ok ? "PASS" : "FAIL"}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: error ${e?.message ?? e}`);
    process.exit(2);
  }
}
