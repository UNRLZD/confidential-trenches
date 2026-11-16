#!/usr/bin/env node
// Live check of card helper-mainnet-pools-only: the helper a deploy started serves no test network's pool (owner,
// 12 Nov: no test networks). Since the card the helper's pool readers name the mainnets alone (apps/helper/src/pool/
// evm.ts POOL_EVM_ENV, pool/solana.ts POOL_SOLANA_ENV, held to pool/mainnet-only.ts MAINNET_POOL_NETWORKS), so a test
// pool's lines left in the host's environment load nothing. Before it, 6194790b7 served the Solana devnet pools and the
// Base Sepolia and Robinhood testnet pools, and a test network's provider could hold a deploy (16 Nov 13:4xZ).
// Read, with no key and no transaction:
//   - GET <helper>/v1/health: 200, X-Helper-Commit the deployed commit (--commit), ready true;
//   - GET <helper>/v1/pool/fee?pool=<pool> for each test pool (testPools: every EVM test network the kit pins a pool
//     for, the Solana devnet pool of contracts/pool-solana/deployments/devnet.json, and the devnet pool before its
//     re-pin, DEVNET_BEFORE), EVM read through evm-pool-fee-epoch.mjs: 404 not_found, the pool the helper does not
//     carry, with the same commit. Any other answer (200 served, 503 loaded but down, no answer) is BAD.
// The mainnet pools' own answers are helper-ready-never-waits-on-a-testnet-pool's.
// Its recorded runs are helper-mainnet-pools-only.answers.json, replayed by its .test.mjs.
// After: helper --commit {commit}
//   node scripts/live-checks/helper-mainnet-pools-only.mjs --commit <sha> [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { evmPoolFeeAsk } from "./evm-pool-fee-epoch.mjs";
import { EXIT, verdictOf } from "./provider-answer.mjs";

export const BASE = "https://ct-api.unrealized.trade";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHA = /^[0-9a-f]{40}$/;
const TIMEOUT_MS = 15_000;
/** The mainnets the helper serves (apps/helper/src/pool/mainnet-only.ts MAINNET_POOL_NETWORKS.evm). */
const EVM_MAINNETS = new Set(["base", "robinhood"]);
/** The Solana devnet pool before its re-pin (card pool-senders-next-page-helper's move, DEVNET_MOVE at fd2f2a6e1),
 *  which 6194790b7 still served on 16 Nov 15:0xZ beside devnet.json's. */
export const DEVNET_BEFORE = "2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr";

/** The test pools the helper must not carry: each EVM test network's kit pin, and the Solana devnet pools. */
export function testPools(root = ROOT, venues = evmPoolVenues()) {
  const dev = JSON.parse(readFileSync(path.join(root, "contracts/pool-solana/deployments/devnet.json"), "utf8"));
  const evm = Object.entries(venues)
    .filter(([n, v]) => !EVM_MAINNETS.has(n) && typeof v?.pool === "string")
    .map(([n, v]) => ({ chain: "evm", network: n, pool: v.pool.toLowerCase() }));
  return [...evm, ...[...new Set([String(dev.pool), DEVNET_BEFORE])].map((pool) => ({ chain: "solana", network: "devnet", pool }))];
}

/** One run: the helper's health and each test pool's fee answer. Never throws: a failed read is recorded. */
export async function read(base = BASE, fetchFn = fetch, pools = testPools()) {
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
export function judge(run, commit, pools = testPools()) {
  const lines = [];
  const say = (ok, what) => lines.push(`${ok ? "GOOD" : "BAD"} ${what}`);
  if (!SHA.test(String(commit))) say(false, `--commit ${commit ?? "none"} is not a full 40-hex commit`);
  const h = run?.health;
  const hb = body(h);
  say(h?.status === 200 && h?.commit === commit && hb?.commit === commit, `[health] GET /v1/health answers ${h?.status ?? h?.error ?? "none"}, commit ${h?.commit ?? "none"} (deployed ${commit})`);
  say(hb?.ready === true, `[health] ready ${JSON.stringify(hb?.ready ?? null)}`);
  if (pools.length === 0) say(false, "no test pool to read");
  for (const p of pools) {
    const f = run?.fees?.find((x) => x.pool === p.pool && x.network === p.network);
    const tag = `[${p.chain} ${p.network} ${p.pool}]`;
    if (f === undefined) {
      say(false, `${tag} not read`);
      continue;
    }
    const b = body(f.answer);
    say(f.answer?.status === 404 && b?.error?.code === "not_found" && f.answer?.commit === commit, `${tag} GET /v1/pool/fee answers ${f.answer?.status ?? f.answer?.error ?? "none"} ${b?.error?.code ?? (b?.chain ? `(served: ${b.chain} ${b.network ?? b.cluster})` : "")}, commit ${f.answer?.commit ?? "none"}: want 404 not_found`);
  }
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), false);
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
    console.log(`${r.verdict} helper-mainnet-pools-only`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`helper-mainnet-pools-only: ${e?.message ?? e}`);
    process.exit(2);
  }
}
