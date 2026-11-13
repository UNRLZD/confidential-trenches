#!/usr/bin/env node
// Live check for card verify-row-survives-one-provider: Verify's Solana row stays ok when one provider of its list
// refuses the page's read. The 12 Nov app live runs (43314363472, job 131528465964) failed on Pocket's HTTP 400 to the
// page's getMultipleAccounts from GitHub's runners, and the fixed pair drew the row Unverified; the page now reads Solana
// on two operators of a list of three (apps/terminal/src/screens/verify/pools.ts readPool, the walk the EVM lists use).
//   First the runner reads the page's own Solana read (getMultipleAccounts of the program and its programdata, with the
//   page's Origin) on every host of the list (card verify-check-plants-on-a-live-operator: Pocket refused that read from
//   GitHub's runners on its own, live run 43449871228, so the plant took a second operator down and the row rightly
//   warned). The refusal is planted only on hosts that answered: the phone the first of them, the desktop the second.
//   Fewer than three answered: one planted would leave fewer than two, nothing to judge, INCONCLUSIVE (exit 3, run again
//   by scripts/ci/live-rerun.mjs), each silent host named.
//   Each width then opens APP_HOST/verify as a visitor with its planted host's reads answered HTTP 400 in the browser,
//   and passes when:
//   - every rule of verify-pools.mjs holds (each row ok on two operators of its list, each read all 200, the refused
//     host walked past, no CSP violation and no console error but that walked-past 400);
//   - the page asked the refused host and got the planted 400;
//   - the Solana row is ok, read on two hosts of its list, neither the refused one.
//   A host of the list the page got no 200 from that was not planted is the runner losing a second operator during the
//   run: that width's Solana lines (its row, its reads, console lines naming a host of the list) cannot be judged, and
//   the verdict is INCONCLUSIVE naming the host, never PASS. With only the planted host down, a row that warns FAILs.
// After: app --network {network}
// Bundle: out a browser and chain RPCs
//   node scripts/live-checks/verify-row-survives-one-provider.mjs [--network mainnet] [--shots <dir>] [--record <file>]
//     the deployed hosts: APP_HOST/verify as it is served, two loads (one per width)
//   node scripts/live-checks/verify-row-survives-one-provider.mjs --harness [--build <dir>] ...
//     a local build on the hosts' real names (verify-pools.mjs --harness), the release's RPCs real but the planted one
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST, harnessRoute, recorded } from "./app-verify-mount.mjs";
import { EXIT, pageRefuses, rpcAnswer } from "./provider-answer.mjs";
import { CHAINS, collect, judge as poolsJudge, PATH } from "./verify-pools.mjs";

const KEY = "verify-row-survives-one-provider";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const host = (u) => new URL(u).host;
/** The 400 the browser gets for a planted refusal, with the headers that let the page read its status. */
const REFUSAL = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS", "content-type": "application/json" };

/** Which Solana host each width refuses: the phone the first of `list` (the hosts that answered the probe, in the list's
 *  order), the desktop its second. */
export const plantsOf = (list) => ({ phone: host(list[0]), desktop: host(list[1]) });
/** One planted down leaves two to read: the probe must find this many answering. */
export const NEED = 3;

/** The page's Solana read on each host of `list` from this runner, with the page's Origin (pools.ts readPool): a host
 *  answered when its answer is two accounts the page may read; else why not, as provider-answer.mjs names a no-answer. */
export async function probe(list, pin, { origin = APP_HOST, read = rpcAnswer } = {}) {
  const params = [[pin.program, pin.programdata], { encoding: "base64", commitment: "finalized" }];
  const hosts = await Promise.all(
    list.map(async (url) => {
      const a = await read(url, "getMultipleAccounts", params, { headers: { origin }, redirect: "error" });
      const why = a.noAnswer ?? pageRefuses(url, a, origin) ?? (a.error !== undefined ? `${host(url)} HTTP ${a.status}: JSON-RPC error ${JSON.stringify(a.error).slice(0, 80)}` : Array.isArray(a.result?.value) && a.result.value.length === 2 ? null : `${host(url)} HTTP ${a.status}: not two accounts`);
      return { host: host(url), answered: why === null, ...(why === null ? {} : { why }) };
    }),
  );
  return { at: new Date().toISOString(), hosts };
}

/** The hosts of the Solana list that refused a width's page, other than its planted one: the runner's own outage. A
 *  refusal is an HTTP status other than 200, or a failed request the page did not abort itself (net::ERR_ABORTED is the
 *  page's own walk giving up a read, never the provider's word, so it never excuses a warning row). */
export function outageOf(run, list, planted) {
  const out = new Map();
  for (const x of run.requests ?? []) {
    if (x.method !== "POST" || x.phase !== "open") continue;
    const h = host(x.url);
    if (h === planted || !list.includes(h) || x.status === 200) continue;
    if ((x.status === null || x.status === undefined) && (!x.failure || /ERR_ABORTED/.test(x.failure))) continue;
    if (!out.has(h)) out.set(h, x.status === null || x.status === undefined ? `${h}: no answer (${x.failure ?? "none"})` : `${h} HTTP ${x.status}: refused the page's read from this runner, not planted`);
  }
  return [...out.values()];
}

/** A route step that answers the planted host's reads 400 for the width whose page asked, and null for any other request. */
const refuse = (plants) => (route) => {
  const q = route.request();
  let width = null;
  try {
    width = (q.frame().page().viewportSize()?.width ?? 0) < 800 ? "phone" : "desktop";
  } catch {
    return null;
  }
  if (host(q.url()) !== plants[width]) return null;
  if (q.method() === "OPTIONS") return route.fulfill({ status: 204, headers: REFUSAL, body: "" });
  // the status is the refusal (pools.ts poolRpc throws on any status but 200); the body is no JSON-RPC answer
  return route.fulfill({ status: 400, headers: REFUSAL, body: JSON.stringify({ error: "planted refusal" }) });
};

/** The verdict on one recorded run: { verdict: PASS | FAIL | INCONCLUSIVE, ok, lines }. */
export function judge(rec) {
  const list = (rec.release?.solana?.rpcs ?? rec.list ?? []).map(host);
  const answered = (rec.probe?.hosts ?? []).filter((x) => x.answered).map((x) => x.host);
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  // the probe: one planted down must leave two that answer
  say(rec.probe !== undefined, `the runner read the page's Solana read on ${rec.probe ? rec.probe.hosts.map((x) => `${x.host} (${x.answered ? "answered" : "silent"})`).join(", ") : "no host: no probe recorded"}`);
  if (rec.probe !== undefined && answered.length < NEED) {
    for (const x of rec.probe.hosts) if (!x.answered) lines.push(`--  ${x.why}`);
    lines.push(`INCONCLUSIVE ${answered.length} of the Solana list answered this runner, ${NEED} needed to plant one refusal and read the row on two`);
    return { verdict: "INCONCLUSIVE", ok: false, lines };
  }
  lines.push(...poolsJudge(rec).lines);
  const plants = rec.plants ?? {};
  say(Object.keys(plants).length === 2 && plants.phone !== plants.desktop, `the run refused ${Object.entries(plants).map(([w, h]) => `${h} on the ${w}`).join(" and ") || "no host"}`);
  if (rec.probe !== undefined) say(Object.values(plants).every((h) => answered.includes(h)), `each planted host answered the runner's probe (${Object.values(plants).join(", ")} of ${answered.join(", ") || "none"})`);
  for (const r of rec.runs ?? []) {
    const n = `${r.width} ${PATH}`;
    const planted = plants[r.width];
    const hits = (r.requests ?? []).filter((x) => x.method === "POST" && x.phase === "open" && planted && host(x.url) === planted);
    say(hits.length > 0 && hits.every((x) => x.status === 400), `${n}: the page asked ${planted ?? "no host"} ${hits.length} time(s)${hits.length ? `, answered ${[...new Set(hits.map((x) => x.status ?? x.failure ?? "nothing"))].join(", ")}` : ""}, want the planted 400`);
    const row = r.pools?.rows?.solana;
    const on = row?.rpcs ?? [];
    say(row?.status === "ok" && on.length === 2 && !on.includes(planted), `${n} solana: row ${row?.status ?? "not drawn"}, read on ${on.join(" and ") || "no host"}, with ${planted ?? "no host"} refusing`);
  }
  // a width whose page lost a host it was not planted on: its Solana lines are the runner's outage, not the build's
  const excused = new Set();
  for (const r of rec.runs ?? []) {
    const lost = outageOf(r, list, plants[r.width]);
    if (lost.length === 0) continue;
    const named = (item) => list.some((h) => item.includes(h));
    for (const l of lines) {
      if (!l.startsWith("BAD")) continue;
      if (l.startsWith(`BAD ${r.width} ${PATH} solana:`)) excused.add(l);
      const head = `BAD ${r.width} ${PATH}: `;
      if (l.startsWith(head)) {
        const items = l.slice(head.length).split(/; (?=console |CSP )/);
        if (items.every((x) => x.startsWith("console ") && named(x))) excused.add(l);
      }
    }
    for (const why of lost) lines.push(`--  ${r.width} ${PATH}: ${why}`);
  }
  const bad = lines.filter((l) => l.startsWith("BAD") && !excused.has(l));
  if (bad.length > 0) return { verdict: "FAIL", ok: false, lines };
  if (excused.size > 0) {
    lines.push(`INCONCLUSIVE the runner lost a Solana operator it was not planted on (${excused.size} line(s) of that width not judged): two of the list down, nothing to judge`);
    return { verdict: "INCONCLUSIVE", ok: false, lines };
  }
  return { verdict: "PASS", ok: lines.length > 0, lines };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const shots = opt("--shots") ?? path.join(tmpdir(), `${KEY}-${Date.now()}`);
  const harness = args.includes("--harness");
  const network = opt("--network") ?? "mainnet";
  const { VERIFY_RELEASES } = await import("../../apps/terminal/src/screens/verify/release.ts");
  const release = VERIFY_RELEASES[network];
  const list = release?.pools?.solana?.rpcs ?? [];
  if (list.length < NEED) throw new Error(`${network}: Verify's Solana list is ${list.length} host(s), not ${NEED} or more: nothing to refuse one of`);
  const probed = await probe(list, release.pools.solana.pin);
  const live = list.filter((u) => probed.hosts.find((x) => x.host === host(u))?.answered);
  if (live.length < NEED) {
    const rec = { check: KEY, at: new Date().toISOString(), source: harness ? "harness" : `live ${APP_HOST}`, network, list, probe: probed, plants: null };
    const record = opt("--record");
    if (record) writeFileSync(record, recorded(rec));
    return finish(judge(rec), rec.source, null);
  }
  const plants = plantsOf(live);
  const plant = refuse(plants);
  const pass = (route) => plant(route) ?? route.continue();
  const build = path.resolve(opt("--build") ?? path.join(REPO, "apps/terminal/dist"));
  const rpcs = [...release.rpcs, ...CHAINS.flatMap((c) => release.pools[c]?.rpcs ?? [])];
  const route = harness ? await harnessRoute(build, rpcs, pass) : pass;
  const source = harness ? `harness, terminal build, the release's ${network} RPCs live but the planted one` : `live ${APP_HOST}`;
  const rec = { ...(await collect({ shots, route, network, source })), check: KEY, probe: probed, plants };
  const record = opt("--record");
  if (record) writeFileSync(record, recorded(rec));
  finish(judge(rec), rec.source, `Chrome ${rec.browser}, shots ${shots}`);
}

function finish(r, source, more) {
  for (const l of r.lines) console.log(l);
  console.log(`${KEY}: ${r.verdict} (${[source, more].filter(Boolean).join(", ")})`);
  process.exit(EXIT[r.verdict]);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
