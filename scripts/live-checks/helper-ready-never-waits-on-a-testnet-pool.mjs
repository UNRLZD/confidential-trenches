#!/usr/bin/env node
// Live check of card helper-ready-never-waits-on-a-testnet-pool: the helper a redeploy started is the one serving, and
// ready, on its mainnet pools alone. On 16 Nov 13:4xZ a redeploy of 80f48ad9a never got ready (redeploy.sh: "not ready
// within 300 s; the old one keeps serving") because its robinhood-testnet pool's start check refused when that test
// network's providers refused every state read; the host kept answering the commit before it (6194790b7). Since the
// card, ready waits only for the mainnet pools' start checks (apps/helper/src/server.ts poolsChecked,
// apps/helper/src/pool/mainnet-only.ts). Read, with no key and no transaction:
//   - GET <helper>/v1/health: 200, X-Helper-Commit the deployed commit (--commit), ready true;
//   - GET <helper>/v1/pool/fee?pool=<pool> for each mainnet pool, from its deploy record (Solana:
//     contracts/pool-solana/deployments/mainnet.json; Base and Robinhood: the kit's pins, which are
//     contracts/pool-evm/deployments/<chain>.json, helper-evm-mainnet-pools holds them equal; EVM read through
//     evm-pool-fee-epoch.mjs): 200, its own chain and network, the pool asked, the same commit. A chain with no block for
//     that minute or the one before is INCONCLUSIVE.
// A test network's pool is not read: it may be down (its providers' answers) and never holds ready.
// Its recorded runs are helper-ready-never-waits-on-a-testnet-pool.answers.json, replayed by its .test.mjs.
// After: helper --commit {commit}
//   node scripts/live-checks/helper-ready-never-waits-on-a-testnet-pool.mjs --commit <sha> [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { evmPoolFeeAsk, noBlockYet } from "./evm-pool-fee-epoch.mjs";
import { EXIT, verdictOf } from "./provider-answer.mjs";

export const BASE = "https://ct-api.unrealized.trade";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHA = /^[0-9a-f]{40}$/;
const TIMEOUT_MS = 15_000;

/** The mainnet pools the helper serves, each with its chain and network, from the deploy records and the kit's pins. */
export function mainnetPools(root = ROOT, venues = evmPoolVenues()) {
  const sol = JSON.parse(readFileSync(path.join(root, "contracts/pool-solana/deployments/mainnet.json"), "utf8"));
  return [
    { chain: "solana", network: "mainnet", pool: String(sol.pool) },
    ...["base", "robinhood"].map((n) => ({ chain: "evm", network: n, pool: String(venues[n]?.pool ?? "").toLowerCase() })),
  ];
}

/** One run: the helper's health and each mainnet pool's fee answer. Never throws: a failed read is recorded. */
export async function read(base = BASE, fetchFn = fetch, pools = mainnetPools()) {
  const at = new Date().toISOString();
  const get = async (url) => {
    try {
      const r = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { status: r.status, commit: r.headers.get("x-helper-commit"), body: (await r.text()).slice(0, 4_000) };
    } catch (e) {
      return { error: String(e?.message ?? e).slice(0, 200) };
    }
  };
  const root = String(base).replace(/\/$/, "");
  const health = await get(`${root}/v1/health`);
  const fees = [];
  for (const p of pools) {
    const answer = p.chain === "evm" ? (await evmPoolFeeAsk((url) => get(url), root, p.pool)).answer : await get(`${root}/v1/pool/fee?pool=${encodeURIComponent(p.pool)}`);
    fees.push({ ...p, answer });
  }
  return { at, base: root, health, fees };
}

const body = (a) => {
  try {
    return JSON.parse(a?.body ?? "null");
  } catch {
    return null;
  }
};

/** The verdict of a run for the deployed `commit`: { ok, verdict, lines }. */
export function judge(run, commit, pools = mainnetPools()) {
  const lines = [];
  const say = (ok, what) => lines.push(`${ok ? "GOOD" : "BAD"} ${what}`);
  if (!SHA.test(String(commit))) say(false, `--commit ${commit ?? "none"} is not a full 40-hex commit`);
  const h = run?.health;
  const hb = body(h);
  say(h?.status === 200 && h?.commit === commit && hb?.commit === commit, `[health] GET /v1/health answers ${h?.status ?? h?.error ?? "none"}, commit ${h?.commit ?? "none"} (deployed ${commit})`);
  say(hb?.ready === true, `[health] ready ${JSON.stringify(hb?.ready ?? null)}`);
  for (const p of pools) {
    const f = run?.fees?.find((x) => x.pool === p.pool && x.network === p.network);
    const tag = `[${p.chain} ${p.network} fee]`;
    if (f === undefined) {
      say(false, `${tag} not read`);
      continue;
    }
    if (p.chain === "evm" && noBlockYet(f.answer)) {
      lines.push(`QUIET ${tag} the helper has no block in the epoch or the one before (503 index_behind)`);
      continue;
    }
    const b = body(f.answer);
    const net = p.chain === "evm" ? b?.network : b?.cluster;
    say(f.answer?.status === 200 && f.answer?.commit === commit && b?.chain === p.chain && net === p.network && b?.pool === p.pool, `${tag} GET /v1/pool/fee?pool=${p.pool} answers ${f.answer?.status ?? f.answer?.error ?? "none"}: chain ${b?.chain ?? "none"}, network ${net ?? "none"}, pool ${b?.pool ?? "none"}, commit ${f.answer?.commit ?? "none"}`);
  }
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), lines.some((l) => l.startsWith("QUIET")));
  return { ok: verdict === "PASS", verdict, lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  try {
    const commit = opt("--commit");
    if (!SHA.test(String(commit))) throw new Error("--commit <full 40-hex sha> is required");
    const run = await read(opt("--base") ?? BASE);
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(run, null, 1) + "\n");
    const r = judge(run, commit);
    for (const l of r.lines) console.log(l);
    console.log(`${r.verdict} helper-ready-never-waits-on-a-testnet-pool`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`helper-ready-never-waits-on-a-testnet-pool: ${e?.message ?? e}`);
    process.exit(2);
  }
}
