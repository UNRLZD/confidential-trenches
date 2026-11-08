#!/usr/bin/env node
// Live check of card evm-pool-index: the device's index of every v4 pool (packages/kit/src/checks/evm/pool-index.ts)
// can be proven on each chain's two index readers as the kit lists them (evmPoolVenues(), through the kit's public
// entry). For Base and Robinhood it reads, as the index does, the newest SPANS spans of `index.span` blocks below N,
// the lower of the two readers' heads: on each reader one batch a span, its Initialize logs and its last block. It
// passes when, on each chain:
//   - the venue lists an index: two readers on two operators (another registrable domain), neither ours (the helper
//     is not a reader: the money rule's attacker is a broken-in helper), 10,000-block spans, the card's margin (Base
//     474, Robinhood 7,119) and a cap;
//   - each reader answers the browser's CORS preflight of a JSON POST from the app's origin, and its POST, allowing it
//     (the device reads them from the page);
//   - every span is answered on both readers with its last block in the same batch, under INDEX_SPAN_LOGS logs, the
//     same last-block hash on both (block N's is the pin) and the same pools on both (by pool id), at least one pool in
//     all, each batch within the kit's RPC timeout (10 s).
// What it proves, and only that: the readers the deployed kit names serve the index's reads and agree. That quotes read
// their pools from the index is card evm-pool-index-route's check.
// After: app
//   node scripts/live-checks/evm-pool-index.mjs [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2. --record writes the run, for the test's replay (evm-pool-index.answers.json:
// its bad answer is this script run in a checkout of the kit before this card). Reads only: no key, no transaction, no
// money moves.
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";

export const KEY = "evm-pool-index";
export const APP_ORIGIN = "https://ct-app.unrealized.trade";
export const OURS = /(^|\.)unrealized\.trade$/i;
export const CHAINS = Object.freeze({ base: { margin: 474 }, robinhood: { margin: 7_119 } });
export const SPAN = 10_000;
export const SPANS = 3;
export const SPAN_LOGS = 10_000;
export const TIMEOUT_MS = 10_000;
const INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

const operator = (u) => new URL(u).hostname.split(".").slice(-2).join(".");

/** The verdict on a run: { chains: { [chain]: { index, preflight, heads, spans } } }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const [chain, want] of Object.entries(CHAINS)) {
    const c = run?.chains?.[chain];
    const ix = c?.index;
    if (!ix) {
      say(false, `${chain}: the kit's venue lists no index`);
      continue;
    }
    const rs = Array.isArray(ix.readers) ? ix.readers : [];
    say(rs.length === 2 && operator(rs[0]) !== operator(rs[1]), `${chain}: two index readers on two operators: ${rs.join(", ")}`);
    say(rs.every((u) => !OURS.test(new URL(u).hostname)), `${chain}: no reader is ours (the helper is not a reader)`);
    say(ix.span === SPAN && ix.margin === want.margin && Number.isInteger(ix.cap) && ix.cap > 0, `${chain}: span ${ix.span}, margin ${ix.margin} (the card's ${want.margin}), cap ${ix.cap}`);
    for (const u of rs) {
      const p = c.preflight?.[u];
      const allows = (v) => v === "*" || v === APP_ORIGIN;
      say(p !== undefined && p.status >= 200 && p.status < 300 && allows(p.allow) && /content-type|\*/i.test(p.headers ?? "") && allows(p.post), `${chain}: ${u} preflight from ${APP_ORIGIN}: ${p ? `${p.status}, allow-origin ${p.allow}, allow-headers ${p.headers}; POST allow-origin ${p.post}` : "not read"}`);
    }
    const heads = c.heads ?? [];
    say(heads.length === 2 && heads.every((h) => Number.isInteger(h)), `${chain}: both readers answered a head: ${heads.join(", ")}`);
    const n = Math.min(...heads);
    const spans = c.spans ?? [];
    say(spans.length === SPANS && spans[0]?.b === n, `${chain}: ${spans.length} spans read, the newest ending at N ${n}`);
    let pools = 0;
    for (const s of spans) {
      const [x, y] = s.on ?? [];
      const both = x && y && typeof x.last === "string" && typeof y.last === "string";
      say(both, `${chain} ${s.a}-${s.b}: both readers answered it with its last block in the same batch`);
      if (!both) continue;
      say(x.last === y.last, `${chain} ${s.a}-${s.b}: the same last block on both${s.b === n ? " (the pin)" : ""}: ${x.last.slice(0, 10)} ${y.last.slice(0, 10)}`);
      say(x.logs < SPAN_LOGS && y.logs < SPAN_LOGS, `${chain} ${s.a}-${s.b}: under ${SPAN_LOGS} logs (${x.logs}, ${y.logs})`);
      const same = JSON.stringify([...x.ids].sort()) === JSON.stringify([...y.ids].sort());
      say(same, `${chain} ${s.a}-${s.b}: the same ${x.ids.length} pools on both${same ? "" : ` (${y.ids.length} on the second)`}`);
      say(x.ms <= TIMEOUT_MS && y.ms <= TIMEOUT_MS, `${chain} ${s.a}-${s.b}: answered in ${x.ms} and ${y.ms} ms`);
      pools += x.ids.length;
    }
    say(pools > 0, `${chain}: ${pools} pools in the newest ${SPANS * SPAN} blocks`);
  }
  return { pass: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

async function post(url, body, fetchFn) {
  const t = performance.now();
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const j = await r.json();
  const arr = Array.isArray(j) ? j : [j];
  return { byId: new Map(arr.map((a) => [a?.id, a])), ms: Math.round(performance.now() - t) };
}

/** One run's reads on the venue list `venues`. */
export async function read(venues, fetchFn = fetch) {
  const chains = {};
  for (const chain of Object.keys(CHAINS)) {
    const v = venues[chain];
    const ix = v?.index;
    if (!ix) {
      chains[chain] = { index: null };
      continue;
    }
    const index = { readers: [...ix.readers], span: ix.span, margin: ix.margin, cap: ix.cap };
    const preflight = {};
    for (const u of ix.readers) {
      try {
        const r = await fetchFn(u, { method: "OPTIONS", headers: { Origin: APP_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const p = await fetchFn(u, { method: "POST", headers: { Origin: APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(TIMEOUT_MS) });
        await p.text();
        preflight[u] = { status: r.status, allow: r.headers.get("access-control-allow-origin"), headers: r.headers.get("access-control-allow-headers"), post: p.headers.get("access-control-allow-origin") };
      } catch (e) {
        preflight[u] = { status: 0, allow: null, headers: null, post: null, error: String(e?.cause?.code ?? e?.message ?? e).slice(0, 120) };
      }
    }
    const heads = await Promise.all(ix.readers.map(async (u) => {
      const h = (await post(u, [{ jsonrpc: "2.0", id: 0, method: "eth_blockNumber", params: [] }], fetchFn)).byId.get(0)?.result;
      return typeof h === "string" ? Number(h) : null;
    }));
    const n = Math.min(...heads.filter((h) => h !== null));
    const spans = [];
    for (let i = 0; i < SPANS; i++) {
      const b = n - i * ix.span;
      const a = b - ix.span + 1;
      const on = await Promise.all(ix.readers.map(async (u) => {
        try {
          const { byId, ms } = await post(u, [
            { jsonrpc: "2.0", id: 0, method: "eth_getLogs", params: [{ address: v.poolManager, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16), topics: [INITIALIZE] }] },
            { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] },
          ], fetchFn);
          const logs = byId.get(0)?.result;
          const blk = byId.get(1)?.result;
          return { logs: Array.isArray(logs) ? logs.length : -1, ids: Array.isArray(logs) ? logs.map((l) => String(l?.topics?.[1]).toLowerCase()) : [], last: typeof blk?.hash === "string" && Number(blk.number) === b ? blk.hash.toLowerCase() : null, ms };
        } catch (e) {
          return { logs: -1, ids: [], last: null, ms: TIMEOUT_MS + 1, error: String(e?.message ?? e).slice(0, 120) };
        }
      }));
      spans.push({ a, b, on });
    }
    chains[chain] = { index, preflight, heads, spans };
  }
  return { at: new Date().toISOString(), chains };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  try {
    const run = await read(evmPoolVenues());
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(run) + "\n");
    const v = judge(run);
    for (const l of v.lines) console.log(l);
    console.log(`${v.pass ? "PASS" : "FAIL"} ${KEY}`);
    process.exit(v.pass ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.stack ?? e}`);
    process.exit(2);
  }
}
