#!/usr/bin/env node
// Live check of card solana-send-browser-origin: every keyless path the signing page sends a Solana tx on answers a
// request from the page's Origin, and SIGN_HOST's connect-src names no Solana host that refuses one. It sends no
// transaction; it reads, with SIGN_HOST's Origin as the page's browser sends it:
//   - SIGN_HOST's served CSP: connect-src names each send path's origin, and none of REFUSED;
//   - each send path's CORS preflight (OPTIONS, POST and content-type asked) admits the page's Origin;
//   - the public send path (the kit's SOLANA_PUBLIC_RPC_URL, the page's provider A): getLatestBlockhash answers a
//     blockhash, neither 401 nor 403, readable by the page (Access-Control-Allow-Origin * or the page's);
//   - Jito's transactions endpoint: getHealth answers (its JSON-RPC "Invalid method" is an answer), neither 401 nor 403,
//     readable by the page;
//   - Helius Sender, which serves sendTransaction alone (getHealth answers 500 "Unknown method"): its documented /ping
//     answers 2xx, readable by the page.
// A host that gives no answer (a fetch that failed, a 429, a 5xx) is that host's moment: INCONCLUSIVE (exit 3), never a
// pass. REFUSED is read, not assumed: with the page's Origin, 2026-11-18 12:03:10-12:03:40Z, api.mainnet-beta.solana.com
// answered the preflight 200 but getHealth and getLatestBlockhash 403 {"code":403,"message":"Access forbidden"} (200 with
// no Origin); api.mainnet.solana.com 403'd a page the same way on 2026-11-11 (packages/signpage/src/trade.ts).
// After: sign
// Bundle: out the send hosts' answers to the page's Origin are reads past the build, and the CSP is a header the host adds
//   node scripts/live-checks/solana-send-browser-origin.mjs [--rpc <url>] [--record <file>] [--answer <file>]
// --rpc reads <url> as the public send path in place of publicnode (the test's bad answer: api.mainnet-beta).
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes the answer read; --answer replays one.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { EXIT, pageRefuses, preflight, preflightRefuses, RPC_TIMEOUT_MS, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "solana-send-browser-origin";
export const SIGN = "https://confidential.unrealized.trade";
// the kit's keyless send paths (packages/kit/src/trade/solana/send.ts), written out here, not read from the repo;
// solana-send-browser-origin.test.mjs holds them equal to the kit's
export const SENDER = "https://sender.helius-rpc.com/fast?swqos_only=true";
export const SENDER_PING = "https://sender.helius-rpc.com/ping";
export const JITO = "https://mainnet.block-engine.jito.wtf/api/v1/transactions";
export const RPC = "https://solana-rpc.publicnode.com";
export const REFUSED = Object.freeze(["https://api.mainnet-beta.solana.com", "https://api.mainnet.solana.com"]);

const admits = (acao) => acao === "*" || acao === SIGN;
const refusedStatus = (s) => s === 401 || s === 403;
const passing = (s) => s === 429 || (s >= 500 && s <= 599);

/** The verdict on an answer { csp, rpc: { url, preflight, post }, jito: { preflight, post }, sender: { preflight, ping } }. */
export function judge(a) {
  const lines = [];
  let bad = false;
  let quiet = false;
  const say = (ok, m) => {
    if (!ok) bad = true;
    lines.push(`${ok ? "ok " : "BAD"} ${m}`);
  };
  const hush = (m) => {
    quiet = true;
    lines.push(`--  ${m}: no answer, INCONCLUSIVE`);
  };
  const connect = (a?.csp ?? "").split(";").map((d) => d.trim().split(/\s+/)).find((d) => d[0] === "connect-src") ?? [];
  const rpcUrl = a?.rpc?.url ?? "";
  for (const u of [rpcUrl, JITO, SENDER]) {
    const o = URL.canParse(u) ? new URL(u).origin : u;
    say(connect.includes(o), `connect-src names the send path ${o}`);
  }
  for (const h of REFUSED) say(!connect.includes(h), `connect-src names no host that refuses the page's Origin (${h})`);

  for (const [name, url, p] of [["rpc", rpcUrl, a?.rpc?.preflight], ["jito", JITO, a?.jito?.preflight], ["sender", SENDER, a?.sender?.preflight]]) {
    if (p?.noAnswer !== undefined) hush(`${name} preflight: ${p.noAnswer}`);
    else {
      const why = preflightRefuses(url, p, SIGN);
      say(why === null, `${name}: its CORS preflight admits ${SIGN}${why ? `: ${why}` : ""}`);
    }
  }

  // a JSON-RPC answer read with the page's Origin: refused (401, 403, unreadable), no answer, or answered
  const post = (name, url, r, need) => {
    if (r === undefined || r === null) return say(false, `${name}: not read`);
    if (typeof r.status === "number" && refusedStatus(r.status)) return say(false, `${name} ${new URL(url).host} HTTP ${r.status}: refuses ${SIGN}`);
    const why = pageRefuses(url, r, SIGN);
    if (why !== null) return say(false, why);
    if (r.noAnswer !== undefined) return hush(`${name}: ${r.noAnswer}`);
    need(r);
  };
  post("rpc", rpcUrl, a?.rpc?.post, (r) => {
    const bh = r.result?.value?.blockhash;
    say(r.error === undefined && typeof bh === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(bh), `rpc ${rpcUrl}: getLatestBlockhash from ${SIGN} answers a blockhash${r.error ? ` (error ${JSON.stringify(r.error).slice(0, 80)})` : ""}`);
  });
  post("jito", JITO, a?.jito?.post, (r) => say(r.result !== undefined || r.error !== undefined, `jito: getHealth from ${SIGN} answers (HTTP ${r.status})`));

  const ping = a?.sender?.ping;
  if (ping?.noAnswer !== undefined || passing(ping?.status)) hush(`sender ping: ${ping?.noAnswer ?? `HTTP ${ping?.status}`}`);
  else say(typeof ping?.status === "number" && ping.status >= 200 && ping.status <= 299 && admits(ping.acao), `sender: ${SENDER_PING} from ${SIGN} answers HTTP ${ping?.status}, Access-Control-Allow-Origin ${String(ping?.acao)}`);

  return { verdict: verdictOf(bad, quiet), lines };
}

/** GET of Sender's /ping with the page's Origin: its status and Access-Control-Allow-Origin, or a no-answer. */
async function ping(fetchFn) {
  try {
    const r = await fetchFn(SENDER_PING, { headers: { origin: SIGN }, redirect: "error", signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
    await r.arrayBuffer().catch(() => {});
    return { status: r.status, acao: r.headers.get("access-control-allow-origin") };
  } catch (e) {
    return { noAnswer: `${new URL(SENDER_PING).host}: no answer (${e?.cause?.code ?? e?.name ?? e})` };
  }
}

/** Reads SIGN_HOST's CSP and each send path's answer to its Origin. `rpcUrl` stands in for the public send path. */
export async function read(fetchFn = fetch, rpcUrl = RPC) {
  const page = await fetchFn(`${SIGN}/`, { redirect: "error" });
  await page.arrayBuffer().catch(() => {});
  const csp = page.headers.get("content-security-policy") ?? "";
  const headers = { origin: SIGN };
  const rpc = { url: rpcUrl, preflight: await preflight(rpcUrl, SIGN, { fetchFn }), post: await rpcAnswer(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }], { fetchFn, headers }) };
  const jito = { preflight: await preflight(JITO, SIGN, { fetchFn }), post: await rpcAnswer(JITO, "getHealth", [], { fetchFn, headers }) };
  // Sender and Jito take one request a second per IP: the preflight and the read a second apart
  await new Promise((r) => setTimeout(r, 1_100));
  const senderPre = await preflight(SENDER, SIGN, { fetchFn });
  await new Promise((r) => setTimeout(r, 1_100));
  return { readAt: new Date().toISOString(), csp, rpc, jito, sender: { preflight: senderPre, ping: await ping(fetchFn) } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(fetch, arg("--rpc") ?? RPC);
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${v.verdict} ${KEY}`);
    process.exit(EXIT[v.verdict]);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
