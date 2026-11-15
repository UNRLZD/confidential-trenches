#!/usr/bin/env node
// Live check of card helper-rpc-takes-batches: HELPER_HOST's POST /v1/rpc/{base,robinhood} answers every read the
// signing page's EVM pool sync sends to it. The page seats the helper's keyed route (?keyed=only) in each chain's pool
// pair (packages/signpage/src/pool-testnet.ts pageEvmPoolRpcs: Robinhood's second seat, Base's last member) and reads
// each W on the plain route (pageEvmWalletRpc); the sync asks every seat eth_chainId and a leaf's block by its hash
// (packages/wallet/src/pool/evm.ts round, timeOf, evmHoldsAnchor). Off the kit's list both were HTTP 400
// method_not_allowed: a console error at every sign-in (live run 43651091646, jobs signpage-signin-kinds and
// wallet-passkey-prf) that rested the seat and walked it to a slow spare. A batch of listed methods was always taken
// (apps/helper/src/rpc/rpc.test.ts holds both). For each chain, on both routes, with the signing page's Origin:
//   - eth_chainId answers the chain's id (Base 0x2105, Robinhood 0x1237);
//   - eth_getBlockByNumber("finalized", false) answers a block with a 32-byte hash, and eth_getBlockByHash(that hash,
//     false) answers that block (its hash and number).
// A 400 from the helper is its refusal: FAIL. A read the shared module calls a no-answer (a 429, a 5xx, no answer) is the
// moment's, never the build's: INCONCLUSIVE (exit 3) naming it.
// After: helper
// Serial: evm-keyed 10
//   node scripts/live-checks/helper-rpc-takes-batches.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read (each HTTP answer as
//   it came), so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { classify, EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "helper-rpc-takes-batches";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
export const CHAINS = Object.freeze({ base: "0x2105", robinhood: "0x1237" });
export const ROUTES = Object.freeze(["plain", "keyed"]);
export const KINDS = Object.freeze(["chainId", "finalized", "byHash"]);
const HASH = /^0x[0-9a-f]{64}$/;
const QTY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const cut = (s) => String(s).slice(0, 160);
const urlOf = (base, chain, route) => `${base.replace(/\/$/, "")}/v1/rpc/${chain}${route === "keyed" ? "?keyed=only" : ""}`;

/** The check on one recorded run: { reads: [{ chain, route, kind, status, body }] }, each the last HTTP answer of its
 *  read (a no-answer is read again once). */
export function judge({ reads }) {
  const lines = [];
  let bad = false, quiet = false;
  const say = (ok, text) => ((bad ||= !ok), lines.push(`${ok ? "ok " : "BAD"} ${text}`));
  for (const [chain, id] of Object.entries(CHAINS)) {
    for (const route of ROUTES) {
      const tag = `[${chain} ${route}]`;
      const got = {};
      for (const kind of KINDS) {
        const r = reads.findLast((x) => x.chain === chain && x.route === route && x.kind === kind);
        if (!r) {
          say(false, `${tag} ${kind}: no read`);
          continue;
        }
        if (r.status === 400) {
          say(false, `${tag} ${kind}: the helper refuses it, 400 ${cut(r.body)}`);
          continue;
        }
        const a = classify(new URL(BASE).host, r.status, r.body, { page: true });
        if (a.noAnswer !== undefined) {
          quiet = true;
          lines.push(`--  ${tag} ${kind}: ${a.noAnswer}`);
          continue;
        }
        got[kind] = a;
      }
      if (got.chainId) say(got.chainId.result === id, `${tag} eth_chainId is ${id}: ${JSON.stringify(got.chainId.result ?? got.chainId.error)}`);
      const fin = got.finalized?.result;
      const finOk = typeof fin?.hash === "string" && HASH.test(fin.hash) && QTY.test(fin.number ?? "");
      if (got.finalized) say(finOk, `${tag} the finalized block has a hash and number: ${cut(JSON.stringify(fin?.number ?? got.finalized.error ?? null))}`);
      // card helper-live-run-holds-its-own-load: with no finalized block read (its read a no-answer), the read by hash
      // asked for no block, so its answer proves nothing either way (live run 43683445143 judged that null BAD)
      if (got.byHash && !got.finalized) {
        quiet = true;
        lines.push(`--  ${tag} byHash: no finalized block was read to ask by`);
      } else if (got.byHash) {
        const h = got.byHash.result;
        say(finOk && h?.hash === fin.hash && h?.number === fin.number, `${tag} eth_getBlockByHash answers that block: ${cut(JSON.stringify(h?.number ?? got.byHash.error ?? null))}`);
      }
    }
  }
  return { verdict: verdictOf(bad, quiet), lines };
}

export async function read(base = BASE, fetchFn = fetch) {
  const reads = [];
  for (const chain of Object.keys(CHAINS)) {
    for (const route of ROUTES) {
      const ask = async (kind, method, params) => {
        // each HTTP answer kept as it came, so the record replays through the shared module's own reading
        const keep = async (url, init) => {
          const r = await fetchFn(url, init);
          const body = await r.text();
          reads.push({ chain, route, kind, readAt: new Date().toISOString(), status: r.status, body });
          return new Response(body, { status: r.status, headers: r.headers });
        };
        return rpcAnswer(urlOf(base, chain, route), method, params, { fetchFn: keep, headers: { origin: SIGN }, redirect: "manual" });
      };
      await ask("chainId", "eth_chainId", []);
      const fin = await ask("finalized", "eth_getBlockByNumber", ["finalized", false]);
      const hash = typeof fin.result?.hash === "string" ? fin.result.hash : `0x${"0".repeat(64)}`;
      await ask("byHash", "eth_getBlockByHash", [hash, false]);
    }
  }
  return { base, reads };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${run.base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
