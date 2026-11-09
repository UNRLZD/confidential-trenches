#!/usr/bin/env node
// Live check of card app-a2-e2e: the deployed helper still answers the two reads the devnet buy-and-sell run
// (apps/terminal/test/e2e/buy/run.mjs, AE-11) takes from it, in the shape the run relies on:
//   - /v1/market/token for a Solana mint, asked from APP_HOST's origin: 200, CORS for APP_HOST, and the same fields as the
//     run's one stub (apps/terminal/test/e2e/buy/market-token.json): its top level, its row and its risk keys. The run
//     answers that read itself for the devnet mint, so a field the helper adds or drops makes the stub a shape the
//     deployed helper no longer gives, and this check fails before the run tests a token page no user sees;
//   - /v1/rpc/solana-devnet, asked from SIGN_HOST's origin: getLatestBlockhash answers 200 with CORS for SIGN_HOST and a
//     blockhash (the signing page's devnet reads and the run's second RPC).
// After: helper
//   node scripts/live-checks/app-a2-e2e.mjs [--as <origin>] [--record <file>]
//     --as asks both reads from another origin (the recorded bad answer: an origin the helper does not serve)
//     PASS exit 0, FAIL exit 1, error exit 2. The record holds statuses, CORS headers and field names, never the values.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-a2-e2e";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HELPER = "https://ct-api.unrealized.trade";
export const APP_ORIGIN = "https://ct-app.unrealized.trade";
export const SIGN_ORIGIN = "https://confidential.unrealized.trade";
/** A Solana mint the helper's market data always holds (BONK, a public mint). */
export const LIVE_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // gitleaks:allow (a public Solana mint)
const STUB = path.join(HERE, "../../apps/terminal/test/e2e/buy/market-token.json");

/** The field names the run's stub relies on: the top level, the row's and the risk's, each sorted. */
export function shapeOf(answer) {
  const keys = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort() : null);
  return { top: keys(answer), row: keys(answer?.row), risk: keys(answer?.risk) };
}
export const STUB_SHAPE = shapeOf(JSON.parse(readFileSync(STUB, "utf8")));

/** The verdict on a record: { ok, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  if (rec?.error) say(false, `error: ${rec.error}`);
  const m = rec?.market ?? {};
  say(m.status === 200, `market token answered ${m.status ?? "nothing"}`);
  say(m.cors === APP_ORIGIN, `market token CORS for APP_HOST: ${m.cors ?? "none"}`);
  for (const k of ["top", "row", "risk"]) {
    const live = m.shape?.[k] ?? null;
    const want = STUB_SHAPE[k];
    const same = Array.isArray(live) && live.length === want.length && live.every((x, i) => x === want[i]);
    const diff = Array.isArray(live) ? [...live.filter((x) => !want.includes(x)).map((x) => `+${x}`), ...want.filter((x) => !live.includes(x)).map((x) => `-${x}`)].join(" ") : "none";
    say(same, `market token ${k} fields as the run's stub${same ? "" : `: ${diff}`}`);
  }
  const r = rec?.devnet ?? {};
  say(r.status === 200, `devnet RPC answered ${r.status ?? "nothing"}`);
  say(r.cors === SIGN_ORIGIN, `devnet RPC CORS for SIGN_HOST: ${r.cors ?? "none"}`);
  say(r.blockhash === true, `devnet RPC gave a blockhash: ${r.blockhash === true}`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

/** The two reads, from the shipped origins or both from `as`. */
export async function collect({ as = null } = {}) {
  const rec = { at: new Date().toISOString(), helper: HELPER, as };
  try {
    const mr = await fetch(`${HELPER}/v1/market/token?chain=solana&token=${LIVE_MINT}`, { headers: { origin: as ?? APP_ORIGIN }, signal: AbortSignal.timeout(20_000) });
    const mj = mr.ok ? await mr.json() : null;
    rec.market = { status: mr.status, cors: mr.headers.get("access-control-allow-origin"), shape: mj ? shapeOf(mj) : null };
    const rr = await fetch(`${HELPER}/v1/rpc/solana-devnet`, {
      method: "POST",
      headers: { origin: as ?? SIGN_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }),
      signal: AbortSignal.timeout(20_000),
    });
    const rj = rr.ok ? await rr.json().catch(() => null) : null;
    rec.devnet = { status: rr.status, cors: rr.headers.get("access-control-allow-origin"), blockhash: typeof rj?.result?.value?.blockhash === "string" };
  } catch (e) {
    rec.error = String(e?.message ?? e).slice(0, 200);
  }
  return rec;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
  try {
    const rec = await collect({ as: opt("--as") });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 2)}\n`);
    const v = judge(rec);
    for (const l of v.lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${v.ok ? "PASS" : "FAIL"}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
