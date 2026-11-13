#!/usr/bin/env node
// Live check of card app-a2-e2e: the deployed APP_HOST and helper still give what the devnet buy-and-sell run
// (apps/terminal/test/e2e/buy/run.mjs, AE-11) relies on, read only (it signs nothing, sends nothing, uses no account):
//   - APP_HOST's token route, /token/solana/<mint> (the run's first page): 200 text/html, framed only by SIGN_HOST
//     (frame-ancestors), its connect-src naming the helper; and the scripts the page names hold every mark the run
//     drives (the trade box, its Max line, its amount, its Buy, the Sell side, the sell box and its Sell): a
//     mark renamed or dropped on the deployed build fails here, before a run drives a box no user sees;
//   - /v1/market/token for a Solana mint, asked from APP_HOST's origin: 200, CORS for APP_HOST, and the same fields as the
//     run's one stub (apps/terminal/test/e2e/buy/market-token.json): its top level, its row and its risk keys. The run
//     answers that read itself for the devnet mint, so a field the helper adds or drops makes the stub a shape the
//     deployed helper no longer gives, and this check fails before the run tests a token page no user sees;
//   - /v1/rpc/solana-devnet, asked from SIGN_HOST's origin: getLatestBlockhash answers 200 with CORS for SIGN_HOST and a
//     blockhash (the signing page's devnet reads and the run's second RPC).
// After: app helper
//   node scripts/live-checks/app-a2-e2e.mjs [--as <origin>] [--record <file>]
//     --as asks the helper's reads from another origin (the recorded bad answer: an origin the helper does not serve)
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (the helper's devnet RPC gave no answer: a 429, a
//     failed fetch, a body that is no JSON-RPC answer; provider-answer.mjs rpcAnswer, read again once). The record holds statuses, headers, mark counts and field names, never the values.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "app-a2-e2e";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HELPER = "https://ct-api.unrealized.trade";
export const APP_ORIGIN = "https://ct-app.unrealized.trade";
export const SIGN_ORIGIN = "https://confidential.unrealized.trade";
/** A Solana mint the helper's market data always holds (BONK, a public mint). */
export const LIVE_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // gitleaks:allow (a public Solana mint)
/** The marks the run drives, each a data-testid or a class as the source or the minified build writes it. 13 Nov 07:53Z: removed, the app names no proof: the run no longer waits on a proof mark. */
export const MARKS = ["trade-box", "trade-max", "trade-cta", "trade-side-sell", "sell-box", "sell-cta", "trb-amount", "trb-input"];
const Q = "[`\"']";
const markRe = (m) => new RegExp(`${Q}${m}${Q}`, "g");
/** Each mark's count in one script. */
export const marksOf = (js) => Object.fromEntries(MARKS.map((m) => [m, (js.match(markRe(m)) ?? []).length]));
/** One directive's sources in a policy, or null. */
export const directive = (csp, name) => {
  const d = (csp ?? "").split(";").map((x) => x.trim().split(/\s+/)).find((w) => w[0] === name);
  return d ? d.slice(1) : null;
};
const STUB = path.join(HERE, "../../apps/terminal/test/e2e/buy/market-token.json");

/** The field names the run's stub relies on: the top level, the row's and the risk's, each sorted. */
export function shapeOf(answer) {
  const keys = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort() : null);
  return { top: keys(answer), row: keys(answer?.row), risk: keys(answer?.risk) };
}
export const STUB_SHAPE = shapeOf(JSON.parse(readFileSync(STUB, "utf8")));

/** The verdict on a record: { ok, verdict, lines }: PASS, FAIL on any wrong answer, INCONCLUSIVE when the helper's devnet
 *  RPC gave no answer and nothing else is wrong. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  if (rec?.error) say(false, `error: ${rec.error}`);
  const a = rec?.app ?? {};
  say(a.status === 200 && /^text\/html/.test(a.type ?? ""), `APP_HOST's token route answered ${a.status ?? "nothing"} ${a.type ?? ""}`.trim());
  const anc = directive(a.csp, "frame-ancestors");
  say(Array.isArray(anc) && anc.length === 1 && anc[0] === SIGN_ORIGIN, `APP_HOST framed only by SIGN_HOST: frame-ancestors ${anc?.join(" ") ?? "none"}`);
  say((directive(a.csp, "connect-src") ?? []).includes(HELPER), `APP_HOST's connect-src names the helper`);
  const js = a.js ?? [];
  say(js.length > 0 && js.every((f) => f.status === 200), `${js.length} script(s) named by the page, each answering 200`);
  const missing = MARKS.filter((k) => !js.some((f) => (f.marks?.[k] ?? 0) > 0));
  say(missing.length === 0, missing.length ? `the deployed scripts lack the run's marks: ${missing.join(", ")}` : `the deployed scripts hold every mark the run drives: ${MARKS.join(", ")}`);
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
  const quiet = typeof r.noAnswer === "string";
  if (quiet) lines.push(`--  devnet RPC: ${r.noAnswer}`);
  else {
    say(r.status === 200, `devnet RPC answered ${r.status ?? "nothing"}`);
    say(r.cors === SIGN_ORIGIN, `devnet RPC CORS for SIGN_HOST: ${r.cors ?? "none"}`);
    say(r.blockhash === true, `devnet RPC gave a blockhash: ${r.blockhash === true}`);
  }
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

/** The two reads, from the shipped origins or both from `as`. */
export async function collect({ as = null } = {}) {
  const rec = { at: new Date().toISOString(), helper: HELPER, as };
  try {
    const pr = await fetch(`${APP_ORIGIN}/token/solana/${LIVE_MINT}`, { signal: AbortSignal.timeout(20_000) });
    const html = pr.ok ? await pr.text() : "";
    rec.app = { status: pr.status, type: pr.headers.get("content-type"), csp: pr.headers.get("content-security-policy"), js: [] };
    for (const src of [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((x) => x[1])) {
      const url = new URL(src, APP_ORIGIN).href;
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      rec.app.js.push({ url, status: r.status, marks: r.ok ? marksOf(await r.text()) : null });
    }
    const mr = await fetch(`${HELPER}/v1/market/token?chain=solana&token=${LIVE_MINT}`, { headers: { origin: as ?? APP_ORIGIN }, signal: AbortSignal.timeout(20_000) });
    const mj = mr.ok ? await mr.json() : null;
    rec.market = { status: mr.status, cors: mr.headers.get("access-control-allow-origin"), shape: mj ? shapeOf(mj) : null };
    // asked as SIGN_HOST's page asks (its Origin), so the answer carries its status and CORS header
    const ra = await rpcAnswer(`${HELPER}/v1/rpc/solana-devnet`, "getLatestBlockhash", [{ commitment: "confirmed" }], { headers: { origin: as ?? SIGN_ORIGIN } });
    rec.devnet = { status: ra.status ?? null, cors: ra.acao ?? null, blockhash: typeof ra.result?.value?.blockhash === "string", ...(ra.noAnswer === undefined ? {} : { noAnswer: ra.noAnswer }) };
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
    console.log(`CARD ${KEY} / live: ${v.verdict}`);
    process.exit(EXIT[v.verdict]);
  } catch (e) {
    console.error(`error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
