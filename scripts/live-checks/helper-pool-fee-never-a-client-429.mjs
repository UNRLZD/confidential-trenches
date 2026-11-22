#!/usr/bin/env node
// Live check of card helper-pool-fee-never-a-client-429: GET /v1/pool/fee never answers a client 429, whether the helper
// is minutes or hours old. helper-25 on ee5c7dac4 (live run 45032297159) answered relayer-cost-guards "GET /v1/pool/fee
// answers 429, fee none": each pool epoch is 60 s (apps/helper/src/pool/fee.ts POOL_EPOCH_MS), and the first ask of each
// read the Rent sysvar on the pool's two public providers, whose throttle went to the client. Now an epoch whose read
// fails carries the newest fee read (apps/helper/src/pool/solana.ts feeOf).
// For each Solana pool a deploy record names (helper-live-checks.mjs solanaPools), it asks the fee of the epoch now and
// of each of the EPOCHS_BACK epochs before it (?epoch=, inside the helper's POOL_LIFE_MAX_MS), one after another: each
// epoch the helper has not read is a rent read of its own on both providers, the asks a page and a burst of proofs make.
// PASS when every answer is 200 with a fee in lamports and the epoch asked; any 429 (or other status) FAILs, naming it.
// It moves no money: it reads.
// After: helper
//   node scripts/live-checks/helper-pool-fee-never-a-client-429.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { solanaPools } from "../ci/helper-live-checks.mjs";

const KEY = "helper-pool-fee-never-a-client-429";
export const BASE = "https://ct-api.unrealized.trade";
const APP = "https://ct-app.unrealized.trade";
/** The pool epoch (apps/helper/src/pool/fee.ts POOL_EPOCH_MS). */
export const EPOCH_MS = 60_000;
/** Epochs asked before the one now: 8, so the oldest stays inside the helper's 10-minute window (POOL_LIFE_MAX_MS)
 *  with a minute of the runner's clock off the helper's. */
export const EPOCHS_BACK = 8;
const DEC = /^(0|[1-9][0-9]{0,18})$/;

const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The check on one recorded run: { base, pools: [{ pool, asks: [{ epoch, status, body }] }] }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const pools = run.pools ?? [];
  say(pools.length > 0, `Solana pools read: ${pools.map((p) => p.pool).join(", ") || "none"}`);
  for (const p of pools) {
    const tag = `[solana ${String(p.pool).slice(0, 8)}]`;
    say((p.asks ?? []).length === EPOCHS_BACK + 1, `${tag} ${(p.asks ?? []).length} fee asks, ${EPOCHS_BACK + 1} wanted`);
    for (const a of p.asks ?? []) {
      const f = json(a.body);
      const code = f?.error?.code;
      const ok = a.status === 200 && DEC.test(f?.fee ?? "") && (a.epoch === null || f?.epoch_start_ms === a.epoch);
      say(ok, `${tag} GET /v1/pool/fee${a.epoch === null ? "" : ` epoch ${a.epoch}`}: ${a.status}${ok ? ` fee ${f.fee}` : ` ${code ?? (a.status === 200 ? "no fee for the epoch asked" : "")}`}`);
    }
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

/** One run against `base`: each pool's fee now, then each of the EPOCHS_BACK epochs before it, oldest last. */
export async function read(base, fetchFn = fetch, now = Date.now(), pools = solanaPools()) {
  const get = async (url) => {
    const r = await fetchFn(url, { redirect: "error", headers: { origin: APP }, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: (await r.text()).slice(0, 2_000) };
  };
  const out = [];
  const start = now - (now % EPOCH_MS);
  for (const pool of Object.values(pools).filter((p) => p !== null)) {
    const asks = [{ epoch: null, ...(await get(`${base}/v1/pool/fee?pool=${encodeURIComponent(pool)}`)) }];
    for (let k = 1; k <= EPOCHS_BACK; k++) {
      const epoch = start - k * EPOCH_MS;
      asks.push({ epoch, ...(await get(`${base}/v1/pool/fee?pool=${encodeURIComponent(pool)}&epoch=${epoch}`)) });
    }
    out.push({ pool, asks });
  }
  return { base, pools: out };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const run = await read(opt("--base") ?? BASE);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
