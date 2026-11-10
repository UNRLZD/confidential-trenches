#!/usr/bin/env node
// Live check of card evm-sell-hook-converge on HELPER_HOST (https://ct-api.unrealized.trade): a sale the
// device's quote routes through a pool behind a v4 hook no venue lists is one the helper's EVM pool sender carries, so
// such a pool can never freeze a token's sales. The device's quote takes that route only where it sets the reference,
// at the reference's minOut, and bans the pool on this device, for an hour at first, where the real sale's revert proves
// its hook at fault on the device's own reads (packages/kit/src/checks/evm/quote.ts evmSellRevertedPools,
// packages/wallet/src/pool/evm-sell-bans.ts; the kit's attack tests HC1-HC6, RV1-RV11 and RVX hold that). What is deployed and
// read here is the one part on a server: the sender's read-back of a signed Sell (the kit's evmSellRouteOf, the one
// definition, apps/helper/src/pool/evm.ts sellHeld) takes such a route, where before the card it refused it bad_route.
// For each testnet pool pool-evm-deploy's records name, it reads GET /v1/pool/fee?pool=<pool> (the fee collector the
// Sell must pay), then POSTs two sells built by helper-evm-sender.mjs's plantsOf with a throwaway W key, each good but
// for a deadline 59 s away (the helper sends only 60 s or more before it), so neither is ever sent:
//   - "listed_deadline_near": one hookless v4 hop: 422 deadline_near (the control: the plant reaches the deadline check);
//   - "hooked_deadline_near": the same hop through the pool behind HOOK, a hook no venue lists: 422 deadline_near, past
//     the route check (a helper before the card answers 422 bad_route).
// It passes only when there is at least one pool, the fee answers 200 with a fee collector, each plant answers its own
// status and code with no hash, and every answer carries a full-sha X-Helper-Commit.
// After: helper
//   node scripts/live-checks/evm-sell-hook-converge.mjs [--base <url>] [--record <file>]
//   node scripts/live-checks/evm-sell-hook-converge.mjs --local [--record <file>]   (the same plants through this tree's
//     helper sender in process, throwaway keys, no provider: what a deploy of this tree answers)
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (the helper has no block in the epoch or the one before: the
// fee is read through evm-pool-fee-epoch.mjs, and a pool with no fee to read has no plant sent). Reads and refused POSTs only: no key of ours, no transaction, no money moves.
import "../net-window.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { evmPoolFeeAsk, noBlockYet } from "./evm-pool-fee-epoch.mjs";
import { EXIT, verdictOf } from "./provider-answer.mjs";
import { BASE, evmPoolRecords, feeCollectorOf, plantsOf, randomKey, v4PathThrough } from "./helper-evm-sender.mjs";

const KEY = "evm-sell-hook-converge";
/** A hook no venue lists (the kit's attack tests' UNPINNED). */
export const HOOK = "0x00000000000000000000000000000000000020cc";
/** Each plant, the status and the code it must get. */
export const PLANTS = [
  ["listed_deadline_near", 422, "deadline_near"],
  ["hooked_deadline_near", 422, "deadline_near"],
];
const SHA = /^[0-9a-f]{40}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The two plants for `pool` on `network`, paying `feeRecipient`, at `nowMs`. */
export function plants({ network, pool, feeRecipient, nowMs = Date.now() }) {
  const listed = plantsOf({ network, pool, feeRecipient, nowMs }).plants.deadline_near;
  const hooked = plantsOf({ network, pool, feeRecipient, nowMs, data: v4PathThrough(HOOK) }).plants.deadline_near;
  return { listed_deadline_near: listed, hooked_deadline_near: hooked };
}

/** The verdict on a run { base, pools: [{ network, pool, reads: [{ asked, status, headers, body }] }] }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  const pools = Array.isArray(run?.pools) ? run.pools : [];
  say(pools.length > 0, `pools read: ${pools.map((p) => `${p.network} ${p.pool}`).join(", ") || "none"}`);
  for (const p of pools) {
    const reads = Array.isArray(p.reads) ? p.reads : [];
    const f = reads.find((r) => r.asked === "fee");
    const c = feeCollectorOf(f?.body ?? "");
    if (noBlockYet(f)) {
      // the chain made no block for over a minute: no fee to read, so no plant was sent
      quiet = true;
      lines.push(`QUIET [${p.network} fee] the helper has no block in the epoch or the one before (GET /v1/pool/fee answers ${f.status} index_behind)`);
    } else {
      say(f?.status === 200 && typeof c === "string" && ADDRESS.test(c), `[${p.network} fee] GET /v1/pool/fee answers ${f?.status}, fee collector ${c ?? "none"}`);
      for (const [asked, status, code] of PLANTS) {
        const r = reads.find((x) => x.asked === asked);
        const e = json(r?.body ?? "");
        say(r?.status === status && e?.error?.code === code && e?.hash === undefined, `[${p.network} ${asked}] POST /v1/pool/evm/sell answers ${r?.status} ${String(r?.body ?? "").slice(0, 120)} (want ${status} ${code})`);
      }
    }
    for (const r of reads) say(SHA.test(r.headers?.["x-helper-commit"] ?? ""), `[${p.network} ${r.asked}] X-Helper-Commit: ${r.headers?.["x-helper-commit"] ?? "none"}`);
  }
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

/** The run on the helper at `base`. The fee is asked for the epoch and, when the helper has no block in it yet, the one
 *  before (evm-pool-fee-epoch.mjs): both asks are recorded, the first as "fee_first". */
export async function read(base, fetchFn = fetch) {
  const pools = [];
  for (const [network, pool] of Object.entries(evmPoolRecords())) {
    const reads = [];
    const get = async (asked, url, init = {}) => {
      const r = await fetchFn(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
      const read = { asked, readAt: new Date().toISOString(), status: r.status, headers: { "x-helper-commit": r.headers.get("x-helper-commit") }, body: (await r.text()).slice(0, 2_000) };
      reads.push(read);
      return read;
    };
    const fee = await evmPoolFeeAsk((url) => get("fee", url), base, pool);
    if (fee.first) fee.first.asked = "fee_first";
    // no fee to read (no block in the epoch or the one before): no plant is sent
    if (noBlockYet(fee.answer)) {
      pools.push({ network, pool, reads });
      continue;
    }
    const ps = plants({ network, pool, feeRecipient: feeCollectorOf(fee.answer.body) ?? "0x000000000000000000000000000000000000dead" });
    for (const [asked] of PLANTS) await get(asked, `${base}/v1/pool/evm/sell`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ps[asked]) });
    pools.push({ network, pool, reads });
  }
  return { base, pools };
}

/** The same plants through this tree's helper sender in process (apps/helper/src/pool/evm.ts evmPoolSender), with two
 *  throwaway keys made here as its senders and the kit's pinned fee collector, on providers that refuse
 *  every call (the sell's checks up to the deadline read none). Each answer's X-Helper-Commit is this tree's HEAD. */
export async function readLocal() {
  const { evmPoolSender } = await import("../../apps/helper/src/pool/evm.ts");
  const { evmPoolVenues } = await import("../../packages/kit/src/index.ts");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // throwaway keys: the checks up to the deadline sign nothing with them
  const [senderKey, sellKey] = [randomKey(), randomKey()];
  const none = async () => {
    throw new Error("no provider in a local run");
  };
  const pools = [];
  for (const [network, pool] of Object.entries(evmPoolRecords())) {
    const feeCollector = evmPoolVenues()[network]?.feeCollector?.toLowerCase();
    const s = evmPoolSender({ network, pool, senderKey, sellKey, feeCollector }, [none, none]);
    const reads = [{ asked: "fee", readAt: new Date().toISOString(), status: 200, headers: { "x-helper-commit": head }, body: JSON.stringify({ fee_collector: feeCollector }) }];
    const ps = plants({ network, pool, feeRecipient: feeCollector });
    for (const [asked] of PLANTS) {
      const a = await s.sell(ps[asked]);
      reads.push({ asked, readAt: new Date().toISOString(), status: a.status, headers: { "x-helper-commit": head }, body: JSON.stringify(a.body).slice(0, 2_000) });
    }
    pools.push({ network, pool, reads });
  }
  return { base: `in process at ${head}`, pools };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (key) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
  try {
    const run = args.includes("--local") ? await readLocal() : await read(opt("--base") ?? BASE);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(`${r.verdict} ${KEY}`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`${KEY}: ${e.message}`);
    process.exit(2);
  }
}
