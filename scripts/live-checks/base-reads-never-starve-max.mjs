#!/usr/bin/env node
// Live check of card base-reads-never-starve-max: a Base token page shows Max and You receive within seconds for an
// account that holds Base money. The device's half lives in the signing page's bundle (the EVM per-W route holds at most
// EVM_PASS_IN_QUEUE background calls in its queue and the positions pass reads in its shown lane, packages/wallet
// buy-wallets.ts; a Base or Robinhood pool.buy.dry whose read fails answers down, so the box asks again,
// packages/signpage pool-buy-evm.ts evmBuyDry); the helper's half is its route and its log (a held or refused EVM read
// names its method and params shape, apps/helper rpc.ts rpcShape).
// The helper part (after a helper deploy): one read of each EVM route as the positions pass's shown read asks it, with
// Origin SIGN_HOST: POST /v1/rpc/base and /v1/rpc/robinhood, eth_call balanceOf(address 1) of Base's USDC at "latest".
// PASS only when each answers 200 a JSON-RPC result that is "0x" or one 32-byte word within SHOWN_MS of its send, with
// Access-Control-Allow-Origin SIGN_HOST. A 429 or 503 (the helper's "every provider held", the owner's live Base page
// of 15 Nov 16:00Z), any other status, a JSON-RPC error or a slower answer FAILs: a read that cannot answer in SHOWN_MS
// is a Max that cannot show. A route that answers nothing (no connection, a timeout) is INCONCLUSIVE.
// The sign part (--part sign, after a sign deploy): SIGN_HOST's index.html pins this commit's /app.js and serves it
// (withdraw-fee-busy-waits.mjs readSign and judgeSign: the served bytes are this commit's build; that the lane and the
// answer run is the wallet's and the signing page's tests at the commit).
// After: helper
// After: sign --part sign
// Bundle: read sign
//   node scripts/live-checks/base-reads-never-starve-max.mjs [--base <url>] [--record <file>]
//   node scripts/live-checks/base-reads-never-starve-max.mjs --part sign [--sign <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXIT, verdictOf } from "./provider-answer.mjs";
import { judgeSign, pinOf, readSign } from "./withdraw-fee-busy-waits.mjs";

const KEY = "base-reads-never-starve-max";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
/** The longest a shown read may take on the helper's route, send to answer: Max within seconds needs each of its reads
 *  well inside it (16:2xZ on 15 Nov from this Mac: base 0.76 s, robinhood 0.67 s). */
export const SHOWN_MS = 3_000;
export const TIMEOUT_MS = 15_000;
/** Base's USDC (Circle's; its address on basescan): a balanceOf any token answers, a word or "0x" where it has no code. */
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const CHAINS = ["base", "robinhood"];
/** The shown read: balanceOf(address 1), as the positions pass reads one W (positions-evm.ts), at "latest". */
export const READ = { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: BASE_USDC, data: `0x70a08231${"1".padStart(64, "0")}` }, "latest"] };
const ANSWER = /^0x([0-9a-f]{64})?$/i;

/** Reads each route once with Origin SIGN_HOST: { chain, status, ms, headers, body } or { chain, noAnswer }. */
export async function read(base = BASE, fetchFn = fetch, clock = () => performance.now()) {
  const reads = [];
  for (const chain of CHAINS) {
    const url = `${base.replace(/\/$/, "")}/v1/rpc/${chain}`;
    const t0 = clock();
    try {
      const r = await fetchFn(url, { method: "POST", redirect: "manual", headers: { origin: SIGN, "content-type": "application/json", "cache-control": "no-cache" }, body: JSON.stringify(READ), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = await r.text();
      const headers = {};
      for (const k of ["retry-after", "access-control-allow-origin", "server-timing"]) {
        const v = r.headers.get(k);
        if (v !== null) headers[k] = v;
      }
      reads.push({ chain, status: r.status, ms: Math.round(clock() - t0), headers, body });
    } catch (e) {
      reads.push({ chain, noAnswer: `${new URL(url).host}: no answer (${e?.cause?.code ?? e?.name ?? e?.message ?? e})` });
    }
  }
  return { base, reads };
}

const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));

/** The check on one recorded run: { ok, quiet, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  for (const chain of CHAINS) {
    const r = run.reads?.find((x) => x.chain === chain);
    const tag = `[${chain}]`;
    if (!r) {
      say(false, `${tag} no read`);
      continue;
    }
    if (r.noAnswer !== undefined) {
      quiet = true;
      lines.push(`no-answer ${tag} ${r.noAnswer}`);
      continue;
    }
    const b = json(r.body);
    if (r.status !== 200) {
      say(false, `${tag} answers ${r.status} ${String(r.body).slice(0, 80)} (Retry-After ${show(r.headers?.["retry-after"])}): a shown read the helper did not answer`);
    } else {
      const result = b?.result;
      say(b?.jsonrpc === "2.0" && b?.id === READ.id && b?.error === undefined && typeof result === "string" && ANSWER.test(result), `${tag} 200 with a balanceOf answer: ${show(result ?? b?.error)}`);
    }
    say(Number.isFinite(r.ms) && r.ms >= 0 && r.ms <= SHOWN_MS, `${tag} answered in ${show(r.ms)} ms, at most ${SHOWN_MS}`);
    say(r.headers?.["access-control-allow-origin"] === SIGN, `${tag} Access-Control-Allow-Origin ${show(r.headers?.["access-control-allow-origin"])}`);
  }
  const bad = lines.some((l) => l.startsWith("BAD"));
  return { ok: !bad && !quiet, quiet, verdict: verdictOf(bad, quiet), lines };
}

export { judgeSign, readSign };

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const sign = opt("--part", "helper") === "sign";
    const run = sign ? await readSign(opt("--sign", SIGN)) : await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = sign ? judgeSign(run) : judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}${sign ? " (sign)" : ""}: ${verdict} (${sign ? run.sign : run.base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `f` answers from the build
 *  folders as the host would; `dirs` names them. */
export async function bundle(f, { dirs, SIGN: sign }) {
  return judgeSign(await readSign(sign, f, pinOf(readFileSync(path.join(dirs.sign, "index.html"), "utf8"))));
}
