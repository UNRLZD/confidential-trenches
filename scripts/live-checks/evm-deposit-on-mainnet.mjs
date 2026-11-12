#!/usr/bin/env node
// Live check of card evm-deposit-on-mainnet: SIGN_HOST (https://confidential.unrealized.trade) offers a Base and a
// Robinhood pool deposit address, follows the money sent there, and can take it out again; and both mainnet pools answer.
// It passes only when:
//   1. SIGN_HOST's served /app.js is the one its index.html pins (its sha384), and in it, as minified, each exactly once:
//      - rule (packages/signpage/src/pool-testnet.ts POOL_WITHDRAW_BUILT, poolWayOut): the chains whose withdraw the build
//        carries are Solana, Base and Robinhood, and the rule is that table's own word for a chain;
//      - addressed (src/main.ts pageAddressPools): pool.address's pools are the page's pool scopes filtered by that rule;
//      - reader (src/main.ts evmWalletRpc, pool-testnet.ts pageEvmWalletRpc): the follow's Base and Robinhood U_X reader
//        is the helper's POST /v1/rpc/{chain} at https://ct-api.unrealized.trade (decision M359), on the mainnet build;
//      - withdraw: the EVM withdraw's marks (evm-withdraw-mainnet.mjs WITHDRAW_MARKS), so money that goes in can come out;
//   2. each mainnet pool (evm-pools-on-mainnet.mjs PINS) answers on both of its chain's RPCs (pool-evm-deploy.mjs
//      MAINNETS): code at the pool, the same on both, and its SCOPE() the same non-zero word on both;
//   3. the deployed helper (https://ct-api.unrealized.trade) carries each pool: GET /v1/pool/fee?pool=<pool> answers 200
//      naming that pool, so its withdraw has a relayer.
// A provider's no-answer is QUIET and the run INCONCLUSIVE (never PASS) unless a wrong answer fails it (provider-answer.mjs).
// What each part does is held by the signing page's tests (test/pool-way-out.test.ts, test/main-mainnet-pools.test.ts,
// test/pool-mainnet-evm.test.ts, test/pool-deposit-evm-{base,robinhood}-mainnet.test.ts).
// After: sign
//   node scripts/live-checks/evm-deposit-on-mainnet.mjs [--local] [--record <file>]
//   PASS exit 0, FAIL 1, error 2, INCONCLUSIVE 3. --local judges this tree's SIGN_HOST build (signBuilt) in SIGN_HOST's
//   place; --record writes what the run read, which evm-deposit-on-mainnet.test.mjs replays.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";
import { PINS } from "./evm-pools-on-mainnet.mjs";
import { WITHDRAW_MARKS } from "./evm-withdraw-mainnet.mjs";
import { MAINNETS } from "./pool-evm-deploy.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

export const KEY = "evm-deposit-on-mainnet";
export const SIGN = "https://confidential.unrealized.trade";
export const HELPER = "https://ct-api.unrealized.trade";
/** keccak256("SCOPE()")'s first 4 bytes: the pool's immutable scope (contracts/pool-evm/src/State.sol). */
export const SCOPE_SELECTOR = "0x33d09200";

const N = "[\\w$]+";
const Q = "`";
const esc = (s) => s.replace(/[$]/g, "\\$");
const once = (re, js) => [...js.matchAll(new RegExp(re.source, "g"))].length === 1;
/** The rule's table and its reader: X=Object.freeze({solana:!0,base:!0,robinhood:!0}),F=(e,t=X)=>t[e]===!0 */
const RULE = new RegExp(`[,; ](${N})=Object\\.freeze\\(\\{solana:!0,base:!0,robinhood:!0\\}\\),(${N})=\\((${N}),(${N})=\\1\\)=>\\4\\[\\3\\]===!0[,;]`);
/** pageAddressPools: the pool scopes filtered by the rule, and pool.address handed them. */
const ADDRESSED = (f) => new RegExp(`function (${N})\\(\\)\\{return (${N})\\(\\)\\.filter\\((${N})=>${esc(f)}\\(\\3\\.chain\\)\\)\\}`);
const ADDRESS_HOST = (a) => new RegExp(`"pool\\.address":${N}\\(\\{pools:${esc(a)},`);
/** The follow's quote route: its wallet reader the page's helper reader. */
const ROUTE = new RegExp(`\\(\\{network:${N},pool:(${N})=>${N}\\?\\.evmPoolOf\\(\\1\\)\\?\\?null,wallet:(${N})=>(${N})\\(\\2\\),notes:`);
/** pageEvmWalletRpc on the mainnet build: no testnet return taken, the helper's route at TRADE_HELPER's /v1/rpc/{chain}. */
const READER = (z) =>
  new RegExp(
    `[,; ]${esc(z)}=\\((${N}),(${N})=!1\\)=>\\{if\\(\\2\\)return;let (${N})=(${N})\\.get\\(\\1\\);if\\(\\3===void 0\\)\\{let (${N})=${N}\\((${N}),\\1\\);\\4\\.set\\(\\1,\\3=Object\\.assign\\(\\((${N}),(${N})\\)=>\\5\\(\\7,\\8\\),\\{url:${Q}\\$\\{\\6\\}/v1/rpc/\\$\\{\\1\\}${Q}\\}\\)\\)\\}return \\3\\}`,
  );
const HELPER_AT = (h) => new RegExp(`[,; ]${esc(h)}=${Q}https://ct-api\\.unrealized\\.trade${Q}[,;]`);
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** What the check keeps of SIGN_HOST's build: its pin and sha384, and each marker found exactly once and bound. */
export function pageFacts(index, js) {
  const rule = once(RULE, js) ? RULE.exec(js) : null;
  const addressed = rule && once(ADDRESSED(rule[2]), js) ? ADDRESSED(rule[2]).exec(js) : null;
  const route = once(ROUTE, js) ? ROUTE.exec(js) : null;
  const reader = route && once(READER(route[3]), js) ? READER(route[3]).exec(js) : null;
  return {
    pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null,
    sha384: sha384(js),
    rule: !!rule,
    addressed: !!addressed && once(ADDRESS_HOST(addressed[1]), js),
    reader: !!reader && once(HELPER_AT(reader[6]), js),
    withdraw: WITHDRAW_MARKS.filter((m) => js.includes(m)).length,
  };
}

/** The chain's and the helper's reads for each pin: { net, rpc, what, answer } and { net, status, body }. */
export async function readChain(fetchFn = fetch) {
  const reads = [];
  const helper = [];
  for (const [net, pin] of Object.entries(PINS)) {
    for (const rpc of MAINNETS[net].rpcs) {
      reads.push({ net, rpc, what: "code", answer: await rpcAnswer(rpc, "eth_getCode", [pin.pool, "latest"], { fetchFn }) });
      reads.push({ net, rpc, what: "scope", answer: await rpcAnswer(rpc, "eth_call", [{ to: pin.pool, data: SCOPE_SELECTOR }, "latest"], { fetchFn }) });
    }
    try {
      const r = await fetchFn(`${HELPER}/v1/pool/fee?pool=${pin.pool}`, { redirect: "error" });
      const text = await r.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      helper.push({ net, status: r.status, body });
    } catch (e) {
      helper.push({ net, noAnswer: `${new URL(HELPER).host}: ${e?.name ?? "error"}` });
    }
  }
  return { reads, helper };
}

/** The verdict on one run { page, reads, helper }: { ok, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  const p = run?.page;
  say(typeof p?.pin === "string" && p.pin === p.sha384, `[SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`);
  say(p?.rule === true, "[SIGN_HOST] the build carries Solana's, Base's and Robinhood's withdraw, and its one rule reads that table");
  say(p?.addressed === true, "[SIGN_HOST] pool.address gives a deposit address on each pool chain the rule opens, Base and Robinhood with Solana");
  say(p?.reader === true, "[SIGN_HOST] the follow reads a Base or Robinhood U_X on the helper's /v1/rpc/{chain} alone");
  say(p?.withdraw === WITHDRAW_MARKS.length, `[SIGN_HOST] the build carries the EVM withdraw: ${p?.withdraw ?? "not read"}/${WITHDRAW_MARKS.length} marks`);
  for (const [net, pin] of Object.entries(PINS)) {
    const codes = [];
    const scopes = [];
    for (const rpc of MAINNETS[net].rpcs) {
      const host = new URL(rpc).host;
      for (const what of ["code", "scope"]) {
        const a = (run?.reads ?? []).find((r) => r.net === net && r.rpc === rpc && r.what === what)?.answer;
        if (a === undefined) {
          say(false, `[${net}] ${host}: no ${what} read`);
          continue;
        }
        if (a.noAnswer !== undefined) {
          quiet = true;
          lines.push(`NOTE [${net}] ${a.noAnswer}`);
          continue;
        }
        (what === "code" ? codes : scopes).push(a.error === undefined && typeof a.result === "string" ? a.result.toLowerCase() : null);
      }
    }
    if (codes.length === 2) say(codes[0] !== null && codes[0].length > 2 && codes[0] === codes[1], `[${net}] the pool ${pin.pool} has code, the same on both RPCs`);
    if (scopes.length === 2) say(scopes[0] !== null && /^0x[0-9a-f]{64}$/.test(scopes[0]) && BigInt(scopes[0]) !== 0n && scopes[0] === scopes[1], `[${net}] the pool's SCOPE() answers one non-zero word on both RPCs: ${scopes.map((s) => s ?? "none").join(", ")}`);
    const h = (run?.helper ?? []).find((x) => x.net === net);
    if (h?.noAnswer !== undefined) {
      quiet = true;
      lines.push(`NOTE [${net}] the helper: ${h.noAnswer}`);
    } else {
      const named = typeof h?.body?.pool === "string" && h.body.pool.toLowerCase() === pin.pool && h.body.network === net;
      say(h?.status === 200 && named, `[${net}] the helper carries the pool's withdraw: GET /v1/pool/fee ${h?.status ?? "not read"}${h?.status === 200 && !named ? ", naming another pool" : ""}`);
    }
  }
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

/** SIGN_HOST's index and /app.js (or this tree's build), then the chain and the helper. */
export async function read(fetchFn = fetch, local = false) {
  let index;
  let js;
  if (local) {
    index = readFileSync(path.join(signBuilt(), "index.html"), "utf8");
    js = readFileSync(path.join(signBuilt(), "public/app.js"), "utf8");
  } else {
    const get = async (p) => {
      const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
      if (r.status !== 200) throw new Error(`SIGN_HOST ${p}: HTTP ${r.status}`);
      return r.text();
    };
    index = await get("/");
    js = await get("/app.js");
  }
  return { readAt: new Date().toISOString(), from: local ? "local build" : SIGN, page: pageFacts(index, js), ...(await readChain(fetchFn)) };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = await read(fetch, a.includes("--local"));
    if (a.includes("--record")) writeFileSync(a[a.indexOf("--record") + 1], `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
