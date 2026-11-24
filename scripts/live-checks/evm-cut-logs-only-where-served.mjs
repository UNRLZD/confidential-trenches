#!/usr/bin/env node
// Live check of card evm-cut-logs-only-where-served: a warm buy tap reads the pools its last quote's prune dropped
// (the PoolManager's Swap and ModifyLiquidity logs over the newest blocks: the kit's checks/evm/quote.ts unmovedSince)
// only from the quote providers its venue lists as answering them (buy-unpinned.ts logProviders), and each of those
// answers that read. Before the card the read went to every quote provider: robinhood-rpc.publicnode.com answers it
// -32602 "Archive requests require a personal token", robinhood.rpc.blxrbdn.com -32601 "Method not available on this
// endpoint" and mainnet.base.org -32011 "request limit reached" (read 2026-11-24 20:46Z), and release 202's sign run
// 45482874085 met bloXroute's -32601 on a fresh account's walk (evm-tree-reads-only-when-needed).
// Two reads, both read only (nothing is signed or sent):
//  1. each mainnet's quote providers asked the read as the kit sends it (the block before, the logs of the newest
//     CUT_LOG_SPAN blocks, the last block, one batch), TRIES times: each listed provider must answer logs and refuse
//     none (a rate limit or no answer is its no-answer, as provider-answer.mjs reads one); each other one's answers
//     are printed;
//  2. the kit's own tap (evmPoolBuyQuoteTap) on each chain's coin (COINS: Base NVDAc, whose prune drops about 77 pools,
//     and Robinhood ANT), once cold and twice warm, after the chain's pool index's sync from SIGN_HOST's
//     snapshot (SIGN, --sign <origin>), each post read beside it: every eth_getLogs of the PoolManager's Swap and
//     ModifyLiquidity, its host and whether its answer is a log list. It fails on any such read sent to a provider the
//     venue does not list, or refused by one it does. Taps that sent no such read (no prune, or the warm range passed)
//     have nothing to judge; with none on either chain the check is INCONCLUSIVE.
// After: sign
// Bundle: out EVM RPC quotes
//   node scripts/live-checks/evm-cut-logs-only-where-served.mjs [--sign <origin>] [--record <file>]
//   PASS exit 0, FAIL 1, error 2 (and nothing to judge). --record writes what the run read, which the check's test replays.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { evmPoolBuyQuote, evmPoolBuyQuoteTap, evmPoolIndexFromSnapshot, evmPoolIndexRefresh } from "../../packages/kit/src/index.ts";
import { mainnetVenues } from "./mainnet-venues.mjs";
import { nothingToJudge, rpcAnswer, rpcBatchAnswer } from "./provider-answer.mjs";

const KEY = "evm-cut-logs-only-where-served";
export const SIGN = "https://confidential.unrealized.trade";
/** Each chain's coin whose prune drops pools: Base NVDAc (evm-warm-tap-skips-pools-it-pruned's) and Robinhood ANT, of
 *  evm-buy-and-sell-on-mainnet's top rows (its warm taps read the cut logs; MOW, HOOKR, CASHCAT and GLDSTN read none,
 *  2026-11-24 20:5xZ). */
export const COINS = Object.freeze({ base: "0xb20000000000000000000078ee7ce2fe4908108c", robinhood: "0xbbb6c29bcc3a1028a2b54310df73f4f7a3bcb373" });
export const AMOUNT = 10n ** 15n;
/** The kit's CUT_LOG_SPAN (checks/evm/quote.ts): the blocks one of its reads spans. */
export const SPAN = Object.freeze({ base: 10, robinhood: 100 });
export const TRIES = 2;
const SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const MODIFY_LIQUIDITY = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
const hx = (n) => "0x" + n.toString(16);
const hostOf = (u) => new URL(u).host;

/** The calls of a post's JSON-RPC body that are the cut-log read: eth_getLogs of the two events as an OR. */
export function cutLogIds(body) {
  let calls;
  try {
    const b = JSON.parse(body);
    calls = Array.isArray(b) ? b : [b];
  } catch {
    return [];
  }
  return calls.filter((c) => c?.method === "eth_getLogs" && Array.isArray(c.params?.[0]?.topics?.[0]) && c.params[0].topics[0].includes(SWAP) && c.params[0].topics[0].includes(MODIFY_LIQUIDITY)).map((c) => c.id);
}

/** One answer of a provider to the read: logs (their count), its refusal (code and words) or its no-answer. */
const outcome = (a) => (a?.noAnswer !== undefined ? { no: a.noAnswer } : a?.error !== undefined ? { refused: `${a.error?.code} ${String(a.error?.message ?? "").slice(0, 70)}` } : Array.isArray(a?.result) ? { logs: a.result.length } : { refused: "no log list" });

async function probe(fetchFn, chain, v) {
  const h = await rpcAnswer(v.providers[0], "eth_blockNumber", [], { fetchFn });
  const head = h.result === undefined ? null : Number(BigInt(h.result)) - 3;
  const out = {};
  for (const u of v.providers) {
    out[hostOf(u)] = [];
    if (head === null) continue;
    for (let i = 0; i < TRIES; i++) {
      const from = head - SPAN[chain] + 1 - i * SPAN[chain];
      const to = from + SPAN[chain] - 1;
      const r = await rpcBatchAnswer(u, [["eth_getBlockByNumber", [hx(from - 1), false]], ["eth_getLogs", [{ address: v.poolManager, fromBlock: hx(from), toBlock: hx(to), topics: [[SWAP, MODIFY_LIQUIDITY]] }]], ["eth_getBlockByNumber", [hx(to), false]]], { fetchFn });
      out[hostOf(u)].push(r.answers === undefined ? outcome(r) : outcome(r.answers[1]));
    }
  }
  return { head, providers: out };
}

export async function read(fetchFn = fetch, o = {}) {
  const venues = mainnetVenues();
  const run = { at: new Date().toISOString(), chains: {} };
  for (const chain of ["base", "robinhood"]) {
    const v = venues[chain];
    run.chains[chain] = { listed: (v.logProviders ?? []).map(hostOf), probe: await probe(fetchFn, chain, v), taps: [] };
  }
  let tap = null;
  // every post the kit sends, read beside it: each cut-log read it carries, its host and its answer's kind
  const counted = async (url, init) => {
    const r = await fetchFn(url, init);
    if (tap === null || typeof init?.body !== "string") return r;
    const ids = cutLogIds(init.body);
    if (ids.length === 0) return r;
    let answers = [];
    try {
      const j = JSON.parse(await r.clone().text());
      answers = Array.isArray(j) ? j : [j];
    } catch {}
    for (const id of ids) {
      const a = answers.find((x) => x?.id === id);
      tap.cut.push({ host: hostOf(String(url)), status: r.status, ...(a === undefined ? { refused: `HTTP ${r.status} no answer for the call` } : outcome(a)) });
    }
    return r;
  };
  const real = globalThis.fetch;
  globalThis.fetch = counted;
  try {
    for (const chain of ["base", "robinhood"]) {
      const v = venues[chain];
      // the device's start: SIGN_HOST's pool index snapshot (as the page serves it), synced to the head; none (a read
      // that fails) syncs from nothing
      const snap = await fetchFn(`${o.sign ?? SIGN}/evm-index/${chain}.json`, { signal: AbortSignal.timeout(30_000) }).then((r) => (r.status === 200 ? r.json() : null)).catch(() => null);
      let ix = null;
      try {
        ix = snap === null ? null : evmPoolIndexFromSnapshot(snap, { chainId: v.chainId, poolManager: v.poolManager, cap: v.index.cap });
      } catch {
        ix = null;
      }
      await evmPoolIndexRefresh(chain, ix, counted).catch(() => null);
      for (const kind of ["cold", "warm", "warm"]) {
        tap = { kind, cut: [] };
        const t0 = performance.now();
        let end;
        try {
          await evmPoolBuyQuoteTap({ chain, token: (o.coins ?? COINS)[chain], amountIn: AMOUNT, slippageBps: 300 }, { quote: (req) => evmPoolBuyQuote(req) });
          end = { ok: true };
        } catch (e) {
          end = { ok: false, code: e?.code ?? "thrown" };
        }
        run.chains[chain].taps.push({ ms: Math.round(performance.now() - t0), ...end, ...tap });
        tap = null;
      }
    }
  } finally {
    globalThis.fetch = real;
  }
  return run;
}

export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const show = (x) => (x.logs !== undefined ? `${x.logs} logs` : x.refused !== undefined ? `refused ${x.refused}` : `no answer (${x.no})`);
  let judged = 0;
  for (const [chain, c] of Object.entries(run.chains ?? {})) {
    const listed = new Set(c.listed ?? []);
    if (listed.size < 2) say(false, `[${chain}] the venue lists ${listed.size} log provider(s): a warm tap needs two that agree`);
    for (const [host, got] of Object.entries(c.probe?.providers ?? {})) {
      const text = got.length === 0 ? "not asked (no head)" : got.map(show).join(" | ");
      if (!listed.has(host)) {
        lines.push(`--  [${chain}] ${host} (not listed): ${text}`);
        continue;
      }
      const refused = got.filter((x) => x.refused !== undefined);
      if (refused.length > 0) say(false, `[${chain}] ${host} (listed) refuses the read: ${text}`);
      else if (got.some((x) => x.logs !== undefined)) say(true, `[${chain}] ${host} (listed) answers the read: ${text}`);
      else lines.push(`--  [${chain}] ${host} (listed): ${text}`);
    }
    const cut = (c.taps ?? []).flatMap((t) => t.cut ?? []);
    lines.push(`--  [${chain}] taps ${(c.taps ?? []).map((t) => `${t.kind} ${t.ms} ms ${t.ok ? "quoted" : `refused ${t.code}`}, ${(t.cut ?? []).length} cut-log reads`).join("; ")}`);
    if (cut.length === 0) {
      lines.push(`--  [${chain}] no tap read the pruned pools' logs: nothing to judge on this chain`);
      continue;
    }
    judged++;
    const off = cut.filter((x) => !listed.has(x.host));
    const byHost = (xs) => [...new Set(xs.map((x) => x.host))].map((h) => `${h} ${xs.filter((x) => x.host === h).length}`).join(", ");
    say(off.length === 0, `[${chain}] the taps' ${cut.length} cut-log reads, ${off.length} to providers the venue does not list: ${byHost(off.length > 0 ? off : cut)}`);
    const refused = cut.filter((x) => listed.has(x.host) && x.refused !== undefined);
    say(refused.length === 0, `[${chain}] no listed provider refused a tap's cut-log read${refused.length > 0 ? `: ${refused.slice(0, 3).map((x) => `${x.host} ${x.refused}`).join("; ")}` : ""}`);
  }
  const bad = lines.some((l) => l.startsWith("BAD"));
  return { ok: !bad, quiet: !bad && judged === 0, lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const run = await read(fetch, { sign: opt("--sign") });
    const rec = opt("--record");
    if (rec) writeFileSync(rec, JSON.stringify(run, null, 2) + "\n");
    const v = judge(run);
    for (const l of v.lines) console.log(l);
    if (v.quiet) {
      const n = nothingToJudge(KEY, "base and robinhood mainnet");
      console.log(n.line);
      process.exit(n.code);
    }
    console.log(`live-check ${KEY}: ${v.ok ? "PASS" : "FAIL"} (base and robinhood mainnet)`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.log(`live-check ${KEY}: error ${e?.message ?? e}`);
    process.exit(2);
  }
}
