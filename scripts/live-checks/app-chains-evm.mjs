#!/usr/bin/env node
// Live check of card app-chains-evm: Discover and the token page show Base and Robinhood tokens from the helper's live
// data, in the same field list and the same screens as Solana. It runs the two checks the card extended, on one load
// each, and passes only when both pass:
//   - app-discover-live: Discover read GET /v1/market/lists?chain=base and ?chain=robinhood at HELPER_HOST (200, every
//     row exactly the terminal's ROW_FIELDS, as Solana's) and draws Base and Robinhood rows, each a link to its page;
//   - app-token-route: a live Base token and a live Robinhood token (the third row of that chain's Trending column) open
//     at APP_HOST/token/<chain>/<id>, ready, with their token read 200 for that token.
// Each part's own lines are kept, prefixed with its key.
// After: app
//   node scripts/live-checks/app-chains-evm.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --build serves that terminal build at APP_HOST's name inside the stand-in shell, the helper still answered live;
// --record writes what the run read, so the check's test can replay it through judge().
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as discover from "./app-discover-live.mjs";
import * as token from "./app-token-route.mjs";

const KEY = "app-chains-evm";
/** The host both parts open (app-discover-live and app-token-route name the same). */
export const APP_HOST = "https://ct-app.unrealized.trade";

/** The check on one recorded run: both parts' verdicts, and each part's Base and Robinhood lines present. */
export function judge(rec) {
  const d = discover.judge(rec.discover ?? {});
  const t = token.judge(rec.token ?? {});
  const lines = [...d.lines.map((l) => `${l.slice(0, 4)}app-discover-live: ${l.slice(4)}`), ...t.lines.map((l) => `${l.slice(0, 4)}app-token-route: ${l.slice(4)}`)];
  for (const c of discover.EVM_CHAINS) {
    const dn = d.lines.filter((l) => l.includes(`/discover`) && l.includes(`: ${c}: `)).length;
    const tn = t.lines.filter((l) => l.includes(`/token/${c}/`)).length;
    const ok = dn === discover.WIDTHS.length && tn === 1;
    lines.push(`${ok ? "ok " : "BAD"} ${c}: ${dn} Discover load(s) of ${discover.WIDTHS.length} and ${tn} token page load(s) of 1 judged`);
  }
  return { ok: d.ok && t.ok && lines.every((l) => l.startsWith("ok ")), lines };
}

export async function collect({ build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  const d = await discover.collect({ build, shots: path.join(shots, "discover") });
  const t = await token.collect({ build, shots: path.join(shots, "token") });
  return { at: new Date().toISOString(), discover: { ...d, shots: undefined }, token: { ...t, shots: undefined }, shots };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ build: opt("--build", null), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the shots
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
