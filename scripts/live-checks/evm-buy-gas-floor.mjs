#!/usr/bin/env node
// Live check of card evm-buy-gas-floor (audit I-4). PrivacyPoolSimple.buy gives a buy's swap at least BUY_SWAP_GAS and
// promises no more, so the kit's EVM buy quote (packages/kit/src/checks/evm/quote.ts) runs each route's swap as the pool
// runs it, the pool's own buySwap sent from the pool with the pool's balance set to the amount, its execution capped at
// 476,190 (500,000 / 1.05), and takes, names or prices against only routes that fit. What it proves, and only that:
//   - deployed: every pool the kit pins (evmPoolVenues: Base, Robinhood and both testnets) reads BUY_SWAP_GAS() 500000,
//     one word, on two of its chain's providers: the number the kit's cap is built on;
//   - the read the kit sends, on Base and Robinhood: the kit's own evmBuySwapFitCall (the call its buy quote sends, built
//     by the kit, not copied here) of a standard v3 route (WETH to USDC, WETH to USDG, 0.01%) at each provider's latest
//     block: the pool's own buySwap through the pinned v3 adapter, from the pool, to the block's fresh recipient, the
//     pool's balance set to the amount, its execution capped at 476,190: both providers answer a result above 0 (the
//     route fits), and the same read capped at 20,000 answers out of gas in words the kit maps to "does not fit"
//     (the kit's own evmIsOutOfGas, its answerOf's words), never another error the kit would refuse on.
//   - the kit's public buy quote of the same routes on Node (card evm-buy-quote-ends-on-node's check, run here as
//     well): on each chain it ends within EVM_QUOTE_MAX_AGE_MS plus 10 s, in at most 2,000 requests, with a quote or
//     a refusal the kit names. No quote fitted the window when recorded (2026-11-08 12:13Z); card
//     evm-buy-quote-in-window.
// Nothing deployed quotes a buy yet: the signing page's bundle carries no EVM buy quote (build-app at 87f280e2 matches a
// fresh build with this card in it). That the floor refuses, names the next route and prices against routes that fit
// is the kit's test (test/evm-quote-attacks.test.ts GF1-GF9 and their mutants in test/evm-quote-mutants.mjs).
//   node scripts/live-checks/evm-buy-gas-floor.mjs [--record <file> --as good|bad [--from <note>] [--sender <address>]]
//     [--answer <file> --as good|bad]   (--sender sends the swap read from another address: how the bad answer was made)
// PASS exit 0, FAIL exit 1, error exit 2.
// Runs: once, it reads what a host deploy cannot change: the pinned pools' BUY_SWAP_GAS (a pool deploy) and the providers' answers to the kit's swap read (the kit's buy quote ships in no host's bundle yet)
import "../net-window.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { evmBuySwapFitCall, evmIsOutOfGas, evmPoolVenues } from "../../packages/kit/src/index.ts";
import { collect as quoteRuns, judge as judgeQuotes } from "./evm-buy-quote-ends-on-node.mjs";

const KEY = "evm-buy-gas-floor";
/** BUY_SWAP_GAS() (PrivacyPoolSimple.sol) and buySwap((address,bytes,uint256,address),address,uint256) */
const SEL_GAS = "0xa27a797e";
const FLOOR = "0x" + (500_000).toString(16).padStart(64, "0");
const CAP = 476_190n;
/** A standard v3 route per mainnet chain: [WETH, buys], 0.01%, at the amount (test/evm-quote-record.ts's cases; "buys",
 *  not "token": gitleaks' generic-api-key rule reads a "token" key with a hex value as a secret) */
export const ROUTES = Object.freeze({
  base: { weth: "0x4200000000000000000000000000000000000006", buys: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amount: 10n ** 16n },
  robinhood: { weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", buys: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", amount: 10n ** 15n },
});
/** The kit's own swap read of `chain`'s route at the block `hash`, its execution capped at `exec`, sent from `from`
 *  (the pool unless given: another sender is how the bad answer was made). */
export function swapCall(chain, exec, hash, from) {
  const { weth, buys, amount } = ROUTES[chain];
  const c = evmBuySwapFitCall(chain, { venue: "uniswap-v3", tokens: [weth, buys], fees: [100] }, amount, hash, exec);
  if (c === null) throw new Error(`${chain} pins no v3 adapter`);
  return [{ ...c.tx, from: from ?? c.tx.from }, { blockHash: hash }, c.override];
}

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  return j.result ?? { error: j.error ?? `HTTP ${r.status}` };
}

/** Each pinned pool's BUY_SWAP_GAS() on the first two of its chain's providers. */
async function pools() {
  const out = [];
  for (const [chain, v] of Object.entries(evmPoolVenues())) {
    if (v.pool === undefined || (v.providers ?? []).length < 2) continue;
    const reads = [];
    for (const url of v.providers.slice(0, 2)) reads.push({ provider: new URL(url).host, result: await rpc(url, "eth_call", [{ to: v.pool, data: SEL_GAS }, "latest"]) });
    out.push({ chain, pool: v.pool, reads });
  }
  return out;
}

/** `chain`'s swap read at the cap and at 20,000 on the first two of its providers (`from`: a sender other than the pool,
 *  for the recorded bad answer). */
async function swaps(chain, from) {
  const reads = [];
  for (const url of evmPoolVenues()[chain].providers.slice(0, 2)) {
    const block = await rpc(url, "eth_getBlockByNumber", ["latest", false]);
    if (typeof block?.hash !== "string") throw new Error(`${new URL(url).host} answered no latest block`);
    reads.push({ provider: new URL(url).host, block: block.hash, cap: await rpc(url, "eth_call", swapCall(chain, CAP, block.hash, from)), low: await rpc(url, "eth_call", swapCall(chain, 20_000n, block.hash, from)) });
  }
  return { chain, reads };
}

export async function collect(from) {
  return { at: new Date().toISOString(), pools: await pools(), swaps: [await swaps("base", from), await swaps("robinhood", from)], quotes: (await quoteRuns()).runs };
}

/** The verdict on an answer { pools, quotes }. */
export function judge(a) {
  const lines = [];
  const say = (ok, m) => lines.push(`${ok ? "ok " : "BAD"} ${m}`);
  const ps = Array.isArray(a?.pools) ? a.pools : [];
  if (ps.length < 2) say(false, "fewer than two pinned pools read");
  for (const p of ps) {
    const good = Array.isArray(p.reads) && p.reads.length >= 2 && p.reads.every((r) => r.result === FLOOR);
    say(good, `${p.chain} pool ${p.pool}: BUY_SWAP_GAS() ${good ? "reads 500000 on" : "does not read 500000 on both of"} ${(p.reads ?? []).map((r) => r.provider).join(" and ")}`);
  }
  const sw = Array.isArray(a?.swaps) ? a.swaps : [];
  for (const chain of Object.keys(ROUTES)) {
    const reads = sw.find((x) => x?.chain === chain)?.reads ?? [];
    if (reads.length < 2) say(false, `${chain}: the swap read on fewer than two providers`);
    for (const r of reads) {
      const fits = typeof r.cap === "string" && /^0x[0-9a-f]{64}$/i.test(r.cap) && BigInt(r.cap) > 0n;
      say(fits, `${chain} ${r.provider}: the swap at the cap ${fits ? `fits, ${BigInt(r.cap)} out` : `does not fit: ${JSON.stringify(r.cap).slice(0, 120)}`}`);
      const m = r.low?.error?.message;
      const oog = typeof m === "string" && evmIsOutOfGas(m);
      say(oog, `${chain} ${r.provider}: the swap at 20,000 ${oog ? `runs out of gas in words the kit maps ("${m}")` : `answers what the kit would refuse on: ${JSON.stringify(r.low).slice(0, 120)}`}`);
    }
  }
  // the kit's public quote, on each chain
  lines.push(...judgeQuotes({ runs: a?.quotes }).lines);
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const as = arg("--as");
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8"))[as] : await collect(arg("--sender"));
    if (arg("--record")) {
      const f = arg("--record");
      const all = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
      all[as] = { ...answer, from: arg("--from") ?? null };
      writeFileSync(f, `${JSON.stringify(all, null, 1)}\n`);
    }
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
