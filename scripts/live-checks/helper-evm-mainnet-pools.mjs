#!/usr/bin/env node
// Live check of card helper-evm-mainnet-pools: HELPER_HOST serves EVM pool withdraws, buys and sells on Base and
// Robinhood at the pool the kit pins for each (evmPoolVenues() pool, set from contracts/pool-evm/deployments/<chain>.json
// by card pool-evm-deploy-mainnet), and the helper's start refuses any other pool address (apps/helper/src/pool/evm.ts
// evmPoolSendersFromEnv). Per mainnet, with no key and no transaction:
//   - GET <helper>/v1/pool/fee?pool=<the kit's pool pin>: 200, network the chain, pool the pin, fee_collector and
//     sell_sender the kit's pins, a block and a fee in wei, and a full-sha X-Helper-Commit: the helper carries the pin;
//   - GET <helper>/v1/pool/fee?pool=<the chain's pinned SellDelegate> (a contract the kit pins, never a pool): 404
//     not_found, so no sender of the helper is keyed on it;
//   - on the kit's two fee providers for the chain (feeProviders, the two RPCs the helper's fee reads go to):
//     eth_getCode of the pin, the same non-empty bytes on both, and eth_getBlockByNumber of the helper's block, the same
//     hash on both: the pool the helper reads is the deployed one, read on two RPCs.
// Its recorded runs are helper-evm-mainnet-pools.answers.json, replayed by helper-evm-mainnet-pools.test.mjs.
// After: helper
//   node scripts/live-checks/helper-evm-mainnet-pools.mjs [--base <helper url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (a provider gave no answer, provider-answer.mjs: the
//   pool's two reads need both).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

export const BASE = "https://ct-api.unrealized.trade";
export const MAINNETS = ["base", "robinhood"];
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const TIMEOUT_MS = 15_000;
const HELPER_TRIES = 3;
const HELPER_PAUSE_MS = 2_000;

/** The kit's pins per mainnet: pool, fee collector, sell sender, sell delegate and the two fee providers. */
export function pinsOf(venues = evmPoolVenues()) {
  return Object.fromEntries(
    MAINNETS.map((chain) => {
      const v = venues[chain];
      const low = (x) => String(x ?? "").toLowerCase();
      return [chain, { pool: low(v?.pool), feeCollector: low(v?.feeCollector), sellSender: low(v?.sellSender), sellDelegate: low(v?.sellDelegate), providers: [...(v?.feeProviders ?? [])] }];
    }),
  );
}

/** One run: the helper's answers and the two providers' reads, per mainnet. Never throws: a failed read is recorded. */
export async function read(base = BASE, fetchFn = fetch, pins = pinsOf()) {
  const at = new Date().toISOString();
  const chains = [];
  for (const chain of MAINNETS) {
    const p = pins[chain];
    // the helper's own provider read can miss once (503 upstream, 429): asked again up to HELPER_TRIES times,
    // HELPER_PAUSE_MS apart, and the last answer judged (a helper that cannot answer the fee serves no withdraw)
    const get = async (pool) => {
      let a;
      for (let i = 0; i < HELPER_TRIES; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, HELPER_PAUSE_MS));
        try {
          const r = await fetchFn(`${base}/v1/pool/fee?pool=${pool}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
          a = { pool, status: r.status, commit: r.headers.get("x-helper-commit"), body: await r.text() };
        } catch (e) {
          a = { pool, error: String(e?.message ?? e).slice(0, 200) };
        }
        if (a.status !== 503 && a.status !== 429 && a.error === undefined) break;
      }
      return a;
    };
    const fee = await get(p.pool);
    const foreign = await get(p.sellDelegate);
    let block;
    try {
      block = JSON.parse(fee.body ?? "null")?.block;
    } catch {
      block = undefined;
    }
    const providers = [];
    for (const url of p.providers) {
      // each read through provider-answer.mjs: a provider's no-answer is recorded as one (INCONCLUSIVE), never judged
      const one = { url };
      const code = await rpcAnswer(url, "eth_getCode", [p.pool, "latest"], { fetchFn });
      if (code.noAnswer !== undefined) one.noAnswer = code.noAnswer;
      else if (code.error !== undefined) one.error = JSON.stringify(code.error).slice(0, 200);
      else {
        one.codeBytes = typeof code.result === "string" ? (code.result.length - 2) / 2 : null;
        one.codeSha256 = typeof code.result === "string" ? createHash("sha256").update(code.result.toLowerCase()).digest("hex") : null;
        if (typeof block === "string") {
          const b = await rpcAnswer(url, "eth_getBlockByNumber", [block, false], { fetchFn, nullNoAnswer: true });
          if (b.noAnswer !== undefined) one.noAnswer = b.noAnswer;
          else if (b.error !== undefined) one.error = JSON.stringify(b.error).slice(0, 200);
          else one.blockHash = b.result?.hash ?? null;
        }
      }
      providers.push(one);
    }
    chains.push({ chain, fee, foreign, providers });
  }
  return { at, base, chains };
}

/** The verdict of a run against the kit's pins: { ok, verdict, lines }; a provider's no-answer is a QUIET line. */
export function judge(run, pins = pinsOf()) {
  const lines = [];
  const say = (ok, what) => lines.push(`${ok ? "GOOD" : "BAD"} ${what}`);
  for (const chain of MAINNETS) {
    const p = pins[chain];
    const c = run?.chains?.find((x) => x.chain === chain);
    if (c === undefined) {
      say(false, `[${chain}] not read`);
      continue;
    }
    for (const [k, v] of Object.entries({ pool: p.pool, feeCollector: p.feeCollector, sellSender: p.sellSender, sellDelegate: p.sellDelegate })) if (!ADDRESS.test(v)) say(false, `[${chain}] the kit pins no ${k}`);
    let body = null;
    try {
      body = JSON.parse(c.fee?.body ?? "null");
    } catch {
      body = null;
    }
    const feeOk =
      c.fee?.status === 200 &&
      SHA.test(String(c.fee?.commit ?? "")) &&
      body?.chain === "evm" &&
      body?.network === chain &&
      body?.pool === p.pool &&
      body?.fee_collector === p.feeCollector &&
      body?.sell_sender === p.sellSender &&
      /^0x[0-9a-f]+$/.test(String(body?.block)) &&
      /^[1-9][0-9]*$/.test(String(body?.fee));
    say(feeOk, `[${chain} fee] GET /v1/pool/fee?pool=${p.pool} answers ${c.fee?.status ?? c.fee?.error ?? "none"}: network ${body?.network ?? "none"}, pool ${body?.pool ?? "none"}, fee_collector ${body?.fee_collector ?? "none"}, sell_sender ${body?.sell_sender ?? "none"}, block ${body?.block ?? "none"}, fee ${body?.fee ?? "none"}, commit ${c.fee?.commit ?? "none"}`);
    let fbody = null;
    try {
      fbody = JSON.parse(c.foreign?.body ?? "null");
    } catch {
      fbody = null;
    }
    say(c.foreign?.pool === p.sellDelegate && c.foreign?.status === 404 && fbody?.error?.code === "not_found", `[${chain} foreign] GET /v1/pool/fee?pool=${c.foreign?.pool ?? "none"} (the pinned SellDelegate) answers ${c.foreign?.status ?? c.foreign?.error ?? "none"} ${fbody?.error?.code ?? ""}`.trim());
    const pr = c.providers ?? [];
    const urls = pr.map((x) => x.url);
    say(urls.length === 2 && urls[0] === p.providers[0] && urls[1] === p.providers[1], `[${chain} providers] read on ${urls.join(", ") || "none"} (the kit's fee providers: ${p.providers.join(", ")})`);
    const quiet = pr.filter((x) => x.noAnswer !== undefined);
    for (const x of quiet) lines.push(`QUIET [${chain} ${x.url}] ${x.noAnswer}`);
    for (const x of pr.filter((y) => y.noAnswer === undefined)) say(x.error === undefined && Number(x.codeBytes) > 0 && HASH.test(String(x.blockHash)), `[${chain} ${x.url}] pool code ${x.codeBytes ?? "none"} bytes sha256 ${x.codeSha256 ?? "none"}, block ${body?.block ?? "none"} hash ${x.blockHash ?? x.error ?? "none"}`);
    if (pr.length === 2 && quiet.length === 0) {
      say(pr[0].codeSha256 !== null && pr[0].codeSha256 !== undefined && pr[0].codeSha256 === pr[1].codeSha256, `[${chain} code] the pool's code is the same on both providers`);
      say(HASH.test(String(pr[0].blockHash)) && pr[0].blockHash === pr[1].blockHash, `[${chain} block] the helper's block has the same hash on both providers`);
    }
  }
  const verdict = lines.length === 0 ? "FAIL" : verdictOf(lines.some((l) => l.startsWith("BAD")), lines.some((l) => l.startsWith("QUIET")));
  return { ok: verdict === "PASS", verdict, lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  try {
    const run = await read(opt("--base") ?? BASE);
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(run, null, 1) + "\n");
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(`${r.verdict} helper-evm-mainnet-pools`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`helper-evm-mainnet-pools: ${e?.message ?? e}`);
    process.exit(2);
  }
}
