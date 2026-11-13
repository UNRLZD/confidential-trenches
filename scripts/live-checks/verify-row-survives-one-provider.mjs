#!/usr/bin/env node
// Live check for card verify-row-survives-one-provider: Verify's Solana row stays ok when one provider of its list
// refuses the page's read. The 12 Nov app live runs (43314363472, job 131528465964) failed on Pocket's HTTP 400 to the
// page's getMultipleAccounts from GitHub's runners, and the fixed pair drew the row Unverified; the page now reads Solana
// on two operators of a list of three (apps/terminal/src/screens/verify/pools.ts readPool, the walk the EVM lists use).
//   Each width opens APP_HOST/verify as a visitor with one Solana provider's reads answered HTTP 400 in the browser (the
//   phone the list's first, the desktop its second, so the two the page reads first are each refused once), and passes
//   when:
//   - every rule of verify-pools.mjs holds (each row ok on two operators of its list, each read all 200, the refused
//     host walked past, no CSP violation and no console error but that walked-past 400);
//   - the page asked the refused host and got the planted 400;
//   - the Solana row is ok, read on two hosts of its list, neither the refused one.
// After: app --network {network}
// Bundle: out a browser and chain RPCs
//   node scripts/live-checks/verify-row-survives-one-provider.mjs [--network mainnet] [--shots <dir>] [--record <file>]
//     the deployed hosts: APP_HOST/verify as it is served, two loads (one per width)
//   node scripts/live-checks/verify-row-survives-one-provider.mjs --harness [--build <dir>] ...
//     a local build on the hosts' real names (verify-pools.mjs --harness), the release's RPCs real but the planted one
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST, harnessRoute, recorded } from "./app-verify-mount.mjs";
import { CHAINS, collect, judge as poolsJudge, PATH } from "./verify-pools.mjs";

const KEY = "verify-row-survives-one-provider";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const host = (u) => new URL(u).host;
/** The 400 the browser gets for a planted refusal, with the headers that let the page read its status. */
const REFUSAL = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS", "content-type": "application/json" };

/** Which Solana host each width refuses: the phone the list's first, the desktop its second. */
export const plantsOf = (list) => ({ phone: host(list[0]), desktop: host(list[1]) });

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

export function judge(rec) {
  const base = poolsJudge(rec);
  const lines = [...base.lines];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const plants = rec.plants ?? {};
  say(Object.keys(plants).length === 2 && plants.phone !== plants.desktop, `the run refused ${Object.entries(plants).map(([w, h]) => `${h} on the ${w}`).join(" and ") || "no host"}`);
  for (const r of rec.runs ?? []) {
    const n = `${r.width} ${PATH}`;
    const planted = plants[r.width];
    const hits = (r.requests ?? []).filter((x) => x.method === "POST" && x.phase === "open" && planted && host(x.url) === planted);
    say(hits.length > 0 && hits.every((x) => x.status === 400), `${n}: the page asked ${planted ?? "no host"} ${hits.length} time(s)${hits.length ? `, answered ${[...new Set(hits.map((x) => x.status ?? x.failure ?? "nothing"))].join(", ")}` : ""}, want the planted 400`);
    const row = r.pools?.rows?.solana;
    const on = row?.rpcs ?? [];
    say(row?.status === "ok" && on.length === 2 && !on.includes(planted), `${n} solana: row ${row?.status ?? "not drawn"}, read on ${on.join(" and ") || "no host"}, with ${planted ?? "no host"} refusing`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok")), lines };
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
  if (list.length < 3) throw new Error(`${network}: Verify's Solana list is ${list.length} host(s), not three or more: nothing to refuse one of`);
  const plants = plantsOf(list);
  const plant = refuse(plants);
  const pass = (route) => plant(route) ?? route.continue();
  const build = path.resolve(opt("--build") ?? path.join(REPO, "apps/terminal/dist"));
  const rpcs = [...release.rpcs, ...CHAINS.flatMap((c) => release.pools[c]?.rpcs ?? [])];
  const route = harness ? await harnessRoute(build, rpcs, pass) : pass;
  const source = harness ? `harness, terminal build, the release's ${network} RPCs live but the planted one` : `live ${APP_HOST}`;
  const rec = { ...(await collect({ shots, route, network, source })), check: KEY, plants };
  const record = opt("--record");
  if (record) writeFileSync(record, recorded(rec));
  const r = judge(rec);
  for (const l of r.lines) console.log(l);
  console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, Chrome ${rec.browser}, shots ${shots})`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
