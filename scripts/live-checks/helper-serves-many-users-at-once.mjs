#!/usr/bin/env node
// Live check of card helper-serves-many-users-at-once on HELPER_HOST: each mainnet RPC route the signing page reads
// beside a trade (solana, base, robinhood) serves at least MIN_PAGES pages at their full share at once, by the budget the
// deployed helper reports. On 11 Nov the helper sized each chain's 10 s total for its first key alone (100), so Solana
// served (100 - 3) / 42 = 2 pages at once while its second keyed provider stood idle; the card sums each route's keyed
// providers (apps/helper/src/rpc/rpc.ts summedTotal).
// One cheap read (getSlot; eth_blockNumber) per route, through provider-answer.mjs rpcAnswer with the page's Origin, one
// connection, three reads in all: well under one page's draw. Every /v1/rpc answer carries the chain's budget in the
// IETF RateLimit-Policy field (draft-ietf-httpapi-ratelimit-headers-11): `"chain";q=<total>;w=10, "client";q=<share>;w=10`
// (rpc.ts policyOf). It passes only when, for each route, the field is there and well formed, the share is at least one
// page's draw (rpc.ts RPC_PAGE_NEED) and (total - the helper's own reserve, rpc.ts RPC_RESERVE) / share is at least
// MIN_PAGES. A route whose read gets no field is FAIL (a helper before this card); a read the helper could not answer
// still carries it, so a provider down never hides the budget.
// After: helper
//   node scripts/live-checks/helper-serves-many-users-at-once.mjs [--base <helper url>] [--record <file>]
//   node scripts/live-checks/helper-serves-many-users-at-once.mjs --answer <file>     judge one recorded run, no network
// PASS exit 0, FAIL exit 1, error exit 2; the last line is "<verdict> helper-serves-many-users-at-once".
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RPC_PAGE_NEED, RPC_RESERVE } from "../../apps/helper/src/rpc/rpc.ts";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

const KEY = "helper-serves-many-users-at-once";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
/** Pages at their full share at once each route must serve. [design: three, the bar below which the owner is asked to
 *  buy a plan.] */
export const MIN_PAGES = 3;
export const ROUTES = Object.freeze({ solana: "getSlot", base: "eth_blockNumber", robinhood: "eth_blockNumber" });
const POLICY = /^"chain";q=([0-9]{1,9});w=10, "client";q=([0-9]{1,9});w=10$/;

/** The check on one recorded run: { routes: { [route]: { status, policy } } }. */
export function judge(a) {
  const lines = [];
  for (const route of Object.keys(ROUTES)) {
    const r = a?.routes?.[route];
    const m = POLICY.exec(typeof r?.policy === "string" ? r.policy : "");
    if (!m) {
      lines.push(`BAD [${route}] no budget reported (RateLimit-Policy ${r?.policy === undefined || r?.policy === null ? "none" : JSON.stringify(String(r.policy).slice(0, 80))}, HTTP ${r?.status ?? "none"})`);
      continue;
    }
    const total = Number(m[1]);
    const share = Number(m[2]);
    const need = RPC_PAGE_NEED[route];
    const pages = share > 0 ? Math.floor((total - RPC_RESERVE[route]) / share) : 0;
    const ok = share >= need && pages >= MIN_PAGES;
    lines.push(`${ok ? "ok " : "BAD"} [${route}] total ${total}, share ${share} (a page's ${need}): ${pages} pages at once${ok ? "" : `, under ${MIN_PAGES}`}`);
  }
  const verdict = lines.every((l) => l.startsWith("ok ")) ? "PASS" : "FAIL";
  return { verdict, ok: verdict === "PASS", lines, exit: EXIT[verdict] };
}

export async function read(base = BASE, fetchFn = fetch) {
  const routes = {};
  for (const [route, method] of Object.entries(ROUTES)) {
    const a = await rpcAnswer(`${base.replace(/\/$/, "")}/v1/rpc/${route}`, method, [], { fetchFn, headers: { origin: SIGN }, redirect: "manual", keep: ["ratelimit-policy"] });
    routes[route] = { status: a.status ?? null, policy: a.kept?.["ratelimit-policy"] ?? null };
  }
  return { routes };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(arg("--base") ?? BASE);
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${v.verdict} ${KEY}`);
    process.exit(v.exit);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
