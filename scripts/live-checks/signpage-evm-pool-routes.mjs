#!/usr/bin/env node
// Live check of the routes the signing page's EVM pool buy and sale go through, on the mainnet pools (card
// live-checks-read-mainnet-only: the mainnet half of signpage-evm-pool-buy and signpage-evm-pool-sell, whose testnet runs
// are read once). For each mainnet pool the kit pins (mainnetVenues(): Base, Robinhood), asked from SIGN_HOST's origin:
//   - POST /v1/pool/evm/send with a buy that is not one (the buy selector alone) is refused bad_shape (400 or 422)
//     before any send;
//   - POST /v1/pool/evm/sell with a sale that is not one (the sell selector alone, no authorization) is refused
//     bad_shape (400) before any send;
//   - each answer echoes SIGN_HOST in Access-Control-Allow-Origin, so the page can read its refusals.
// Neither body carries a signature, so nothing can be sent. The bundle's EVM buy and sale and its pins are
// evm-buy-and-sell-on-mainnet's.
// After: sign helper
// Bundle: out the helper's routes, asked from SIGN_HOST's origin; no bundle is read
//   node scripts/live-checks/signpage-evm-pool-routes.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { mainnetVenues } from "./mainnet-venues.mjs";
import { EXIT, verdictOf } from "./provider-answer.mjs";

const KEY = "signpage-evm-pool-routes";
export const HELPER = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
/** PrivacyPoolSimple.buy's selector (signpage-evm-pool-buy.mjs BUY_SELECTOR) */
export const BUY_SELECTOR = "0x3edadd79";
/** SellDelegate.sell's selector (signpage-evm-pool-sell.mjs SELL_SELECTOR) */
export const SELL_SELECTOR = "0x0c2cb9ca";
/** Each route asked, its body for `pool`, and the statuses its bad_shape may come with. */
export const ROUTES = Object.freeze([
  { route: "send", body: (pool) => ({ pool, data: BUY_SELECTOR, epoch: 0 }), statuses: [400, 422] },
  { route: "sell", body: (pool) => ({ pool, w: pool, data: SELL_SELECTOR }), statuses: [400] },
]);

const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The pools asked: { network: pool }, the mainnets'. */
export const poolsOf = (venues = mainnetVenues()) => Object.fromEntries(Object.entries(venues).map(([n, v]) => [n, String(v.pool).toLowerCase()]));

/** The check on one run: { asks: [{ network, pool, route, status, acao, body }] }, against `pools`. */
export function judge(run, pools = poolsOf()) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const [network, pool] of Object.entries(pools))
    for (const { route, statuses } of ROUTES) {
      const tag = `[${network} /v1/pool/evm/${route}]`;
      const a = (run?.asks ?? []).find((x) => x.network === network && x.route === route);
      if (!a) {
        say(false, `${tag} not asked`);
        continue;
      }
      say(a.pool === pool, `${tag} asked for the pinned pool ${pool}: ${a.pool}`);
      const code = json(a.body)?.error?.code;
      say(statuses.includes(a.status) && code === "bad_shape", `${tag} a malformed ${route === "send" ? "buy" : "sale"} refused before any send: ${a.status} ${code ?? String(a.body).slice(0, 80)}`);
      say(a.acao === SIGN, `${tag} CORS allow-origin ${a.acao ?? "none"}`);
    }
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), false);
  return { ok: verdict === "PASS", verdict, lines };
}

/** The run: each route asked once for each pool, from SIGN_HOST's origin. */
export async function read(base = HELPER, fetchFn = fetch, pools = poolsOf()) {
  const asks = [];
  for (const [network, pool] of Object.entries(pools))
    for (const { route, body } of ROUTES) {
      const r = await fetchFn(`${base}/v1/pool/evm/${route}`, { method: "POST", redirect: "manual", headers: { origin: SIGN, "content-type": "application/json" }, body: JSON.stringify(body(pool)), signal: AbortSignal.timeout(15_000) });
      asks.push({ network, pool, route, status: r.status, acao: r.headers.get("access-control-allow-origin"), commit: r.headers.get("x-helper-commit"), body: (await r.text()).slice(0, 2_000) });
    }
  return { readAt: new Date().toISOString(), base, asks };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const run = await read(opt("--base") ?? HELPER);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
