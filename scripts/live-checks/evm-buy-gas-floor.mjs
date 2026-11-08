#!/usr/bin/env node
// Live check of card evm-buy-gas-floor (audit I-4). PrivacyPoolSimple.buy gives a buy's swap at least BUY_SWAP_GAS and
// promises no more, so the kit's EVM buy quote (packages/kit/src/checks/evm/quote.ts) runs each route's swap as the pool
// runs it, the pool's own buySwap sent from the pool with the pool's balance set to the amount, its execution capped at
// 476,190 (500,000 / 1.05), and takes, names or prices against only routes that fit. What it proves, and only that:
//   - deployed: every pool the kit pins (evmPoolVenues: Base, Robinhood and both testnets) reads BUY_SWAP_GAS() 500000,
//     one word, on two of its chain's providers: the number the kit's cap is built on;
//   - the read the kit sends, on Base and Robinhood: the pool's own buySwap of a standard v3 route (WETH to USDC, WETH
//     to USDG, 0.01%) through the pinned v3 adapter, from the pool, the pool's balance set to the amount, its execution
//     capped at 476,190, the same bytes the kit's fitRead builds (compared 2026-11-08 07:45Z): both providers answer a
//     result above 0 (the route fits), and the same read capped at 20,000 answers out of gas in a form the kit maps to
//     "does not fit" (/^out of gas(: gas required exceeds:? \d+)?$/i), never another error the kit would refuse on.
// Nothing deployed quotes a buy yet: the signing page's bundle carries no EVM buy quote (build-app at 87f280e2 matches a
// fresh build with this card in it). The kit's public buy quote is not run here: on Node it does not end (it asked 583
// requests in 45 s on Base before this card too, at 7b4e5113), a finding for the CO. That the floor refuses, names the
// next route and prices against routes that fit is the kit's test (test/evm-quote-attacks.test.ts GF1-GF9 and their
// mutants in test/evm-quote-mutants.mjs).
//   node scripts/live-checks/evm-buy-gas-floor.mjs [--record <file> --as good|bad [--from <note>] [--sender <address>]]
//     [--answer <file> --as good|bad]   (--sender sends the swap read from another address: how the bad answer was made)
// PASS exit 0, FAIL exit 1, error exit 2.
// Runs: once, it reads what a host deploy cannot change: the pinned pools' BUY_SWAP_GAS (a pool deploy) and the providers' answers to the kit's swap read (the kit's buy quote ships in no host's bundle yet)
import "../net-window.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";

const KEY = "evm-buy-gas-floor";
/** BUY_SWAP_GAS() (PrivacyPoolSimple.sol) and buySwap((address,bytes,uint256,address),address,uint256) */
const SEL_GAS = "0xa27a797e";
const SEL_BUY_SWAP = "0x25faf2a3";
const FLOOR = "0x" + (500_000).toString(16).padStart(64, "0");
/** the kit's out-of-gas words (quote.ts answerOf) */
const OUT_OF_GAS = /^out of gas(: gas required exceeds:? \d+)?$/i;
const CAP = 476_190n;
/** A standard v3 route per mainnet chain: [WETH, buys], 0.01%, at the amount (test/evm-quote-record.ts's cases; "buys",
 *  not "token": gitleaks' generic-api-key rule reads a "token" key with a hex value as a secret) */
export const ROUTES = Object.freeze({
  base: { weth: "0x4200000000000000000000000000000000000006", buys: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amount: 10n ** 16n },
  robinhood: { weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", buys: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", amount: 10n ** 15n },
});
const word = (v) => v.toString(16).padStart(64, "0");
/** The kit's fitRead of `chain`'s route (quote.ts): buySwap(Buy(adapter, data, 1, token), W, amount) from `from`. */
export function swapCall(chain, exec, from) {
  const v = evmPoolVenues()[chain];
  const { weth, buys: token, amount } = ROUTES[chain];
  const data = weth.slice(2) + "000064" + token.slice(2);
  const len = BigInt(data.length / 2);
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
  const call = SEL_BUY_SWAP + word(0x60n) + word(0x9116a1e7147d594ae107fe8b0e67f9d4de4b1e76n) + word(amount) + word(BigInt(v.adapters.v3)) + word(0x80n) + word(1n) + word(BigInt(token)) + word(len) + padded;
  let intrinsic = 21_000n;
  for (let k = 2; k < call.length; k += 2) intrinsic += call.slice(k, k + 2) === "00" ? 4n : 16n;
  return [{ from: from ?? v.pool, to: v.pool, data: call, gas: "0x" + (intrinsic + exec).toString(16) }, "latest", { [v.pool]: { balance: "0x" + amount.toString(16) } }];
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
    reads.push({ provider: new URL(url).host, cap: await rpc(url, "eth_call", swapCall(chain, CAP, from)), low: await rpc(url, "eth_call", swapCall(chain, 20_000n, from)) });
  }
  return { chain, reads };
}

export async function collect(from) {
  return { at: new Date().toISOString(), pools: await pools(), swaps: [await swaps("base", from), await swaps("robinhood", from)] };
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
      const oog = typeof m === "string" && OUT_OF_GAS.test(m);
      say(oog, `${chain} ${r.provider}: the swap at 20,000 ${oog ? `runs out of gas in words the kit maps ("${m}")` : `answers what the kit would refuse on: ${JSON.stringify(r.low).slice(0, 120)}`}`);
    }
  }
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
