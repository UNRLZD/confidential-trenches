#!/usr/bin/env node
// Live check of card evm-deposit-on-mainnet: SIGN_HOST (https://confidential.unrealized.trade) offers a Base and a
// Robinhood pool deposit address, follows the money sent there, and can take it out again; both mainnet pools answer;
// and the deployed helper prices each pool's withdraw at the fee the device itself computes, so a withdraw binds.
// It passes only when:
//   1. the bundle part (readBundle, judgeBundle; scripts/ci/bundle-checks.mjs runs it on a pull request's own build):
//      SIGN_HOST's served /app.js is the one its index.html pins (its sha384), and in it, as minified, each exactly once:
//      - rule (packages/signpage/src/pool-testnet.ts POOL_WITHDRAW_BUILT, poolWayOut): the chains whose withdraw the build
//        carries are Solana, Base and Robinhood, and the rule is that table's own word for a chain;
//      - addressed (src/main.ts pageAddressPools): pool.address's pools are the page's pool scopes filtered by that rule;
//      - reader (src/main.ts evmWalletRpc, pool-testnet.ts pageEvmWalletRpc): the follow's Base and Robinhood U_X reader
//        is the helper's POST /v1/rpc/{chain} at https://ct-api.unrealized.trade (decision M359), on the mainnet build;
//      - withdraw: the EVM withdraw's marks (evm-withdraw-mainnet.mjs WITHDRAW_MARKS), so money that goes in can come out;
//      - withdrawSites (withdrawSites): the EVM withdraw's host, flow branch, screen deps, run guard and owed finish each
//        on that rule and bound to one another, the host's first statement the rule call alone, so none of them is
//        dropped on SIGN_HOST behind a constant the minifier folds away;
//   2. the chain part (readChain, checkChain), on both of each chain's RPCs (pool-evm-deploy.mjs MAINNETS):
//      - eth_chainId is the chain's (Base 8453, Robinhood 4663);
//      - each mainnet pool (evm-pools-on-mainnet.mjs PINS) has code, the same on both, and its SCOPE() is the same
//        non-zero word on both;
//      - the pool's withdraw sender (the pin's fee recipient) has a balance, printed as read (a "--" line, not judged:
//        funding it is the owner's);
//      - the deployed helper (https://ct-api.unrealized.trade) carries each pool: GET /v1/pool/fee?pool=<pool> answers
//        200 naming that pool, so its withdraw has a relayer;
//   3. the fee part, after every helper deploy too: the device's bind reads (device-evm-fee-read-walks-operators.mjs
//      CHILD, packages/wallet/scripts/bind-fee-live.ts: the wallet's own evmEpochBlock on the pool's pair, the tree depth
//      there and evmBindChainFee on two operators) at the current period's first block, the fee the device computes from
//      them (the kit's evmPoolFee at evmPoolGas(depth) and the block's base fee: the page's evmEpochFee), and the helper's
//      GET /v1/pool/fee?pool=<pool>&epoch=<the period's start>: 200, the same block, and the same fee to the wei, the
//      check packages/wallet/src/pool/evm.ts bind makes before it binds a withdraw ("relayFee: the helper's ... is not
//      the epoch's fee"). The helper's answer for the period before is kept beside it (`other`, a real answer for
//      another block), which the replay judges as the bad answer of this part.
// A provider's no-answer, or a bind that met a provider not yet holding the block, is QUIET and the run INCONCLUSIVE
// (never PASS) unless a wrong answer fails it (provider-answer.mjs).
// What each page part does is held by the signing page's tests (test/pool-way-out.test.ts, test/main-mainnet-pools.test.ts,
// test/pool-withdraw-mainnet-reaches.test.ts, test/pool-mainnet-evm.test.ts, test/pool-deposit-evm-{base,robinhood}-mainnet.test.ts).
// After: sign
// After: helper --part helper
//   node scripts/live-checks/evm-deposit-on-mainnet.mjs [--local] [--part helper] [--record <file>]
//   PASS exit 0, FAIL 1, error 2, INCONCLUSIVE 3. --local judges this tree's SIGN_HOST build (signBuilt) in SIGN_HOST's
//   place; --part helper reads the chain, the fee and the helper only (a helper deploy changes nothing SIGN_HOST
//   serves); --record writes what the run read, which evm-deposit-on-mainnet.test.mjs replays.
import "../net-window.mjs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolFee, evmPoolGas, evmPoolVenues } from "../../packages/kit/src/index.ts";
import { signBuilt } from "../signpage-built.mjs";
import { childArgs } from "./device-evm-fee-read-walks-operators.mjs";
import { HELPER_AT, READER } from "./evm-deposit-route-mainnet.mjs";
import { PINS } from "./evm-pools-on-mainnet.mjs";
import { WITHDRAW_MARKS } from "./evm-withdraw-mainnet.mjs";
import { MAINNETS } from "./pool-evm-deploy.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

export const KEY = "evm-deposit-on-mainnet";
export const SIGN = "https://confidential.unrealized.trade";
export const HELPER = "https://ct-api.unrealized.trade";
/** keccak256("SCOPE()")'s first 4 bytes: the pool's immutable scope (contracts/pool-evm/src/State.sol). */
export const SCOPE_SELECTOR = "0x33d09200";
const EPOCH_MS = 60_000;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
/** The EVM withdraw's path in src/pool-testnet.ts, each site bound to the rule (wayOut: `r=e=>F(e,t.withdrawBuilt)`)
 *  and to one another, so a build that drops the withdraw on SIGN_HOST behind a constant (POOL_TESTNET, folded away)
 *  reads false: the host (evmWithdrawHost), whose first statement is the rule call alone; the flow's pool.withdraw
 *  branch; the screen's deps (withdrawDeps); the run's guard (withdraw); the owed finish of a reload (settle). */
const WAY_OUT = (f) => new RegExp(`[,;{ ](${N})=(${N})=>${esc(f)}\\(\\2,${N}\\.withdrawBuilt\\)[,;]`);
const WITHDRAW_HOST = (w) => new RegExp(`[,;{ ](${N})=\\((${N}),${N}\\)=>\\{if\\(!${esc(w)}\\(\\2\\)\\)return null;let (${N})=(${N})\\(\\2\\);if\\(\\3===null\\)return null;let ${N}=${N}\\.evmQueuePool\\?\\.\\(\\2\\)`);
const WITHDRAW_SITES = (w, host, pool) => ({
  flow: new RegExp(`(${N})\\.kind===${Q}pool\\.withdraw${Q}&&${esc(w)}\\(\\1\\.chain\\)&&(${N})\\.openWithdraw&&${esc(pool)}\\(\\1\\.chain\\)!==null\\?\\2\\.openWithdraw\\(\\1\\.chain,${N}\\)`),
  deps: new RegExp(`[,;{ ]${N}=\\((${N}),${N}\\)=>\\{let (${N})=${esc(w)}\\(\\1\\)\\?${esc(pool)}\\(\\1\\):null;return\\{chain:\\1,keys:\\{pool:\\2\\?\\.pin\\.pool`),
  run: new RegExp(`if\\(!\\(!${N}\\|\\|!${esc(w)}\\((${N})\\.chain\\)\\|\\|\\(\\1\\.chain===${Q}solana${Q}\\?${N}===void 0:${esc(pool)}\\(\\1\\.chain\\)===null\\)\\)\\)`),
  owed: new RegExp(`if\\((${N})===${Q}base${Q}\\|\\|\\1===${Q}robinhood${Q}\\)\\{let ${N}=${esc(host)}\\(\\1,${N}\\)`),
});
/** The EVM withdraw's sites, each found once and bound: { host, flow, deps, run, owed }, every one false without the rule. */
export function withdrawSites(js, f) {
  const way = f && once(WAY_OUT(f), js) ? WAY_OUT(f).exec(js) : null;
  const host = way && once(WITHDRAW_HOST(way[1]), js) ? WITHDRAW_HOST(way[1]).exec(js) : null;
  const sites = host ? WITHDRAW_SITES(way[1], host[1], host[4]) : {};
  return { host: !!host, ...Object.fromEntries(["flow", "deps", "run", "owed"].map((k) => [k, !!host && once(sites[k], js)])) };
}
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
    withdrawSites: withdrawSites(js, rule?.[2]),
  };
}

/** SIGN_HOST's index and /app.js through `fetchFn` (bundle-checks: the build, as the host serves it): { from, page }. */
export async function readBundle(fetchFn = fetch) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`SIGN_HOST ${p}: HTTP ${r.status}`);
    return r.text();
  };
  return { from: SIGN, page: pageFacts(await get("/"), await get("/app.js")) };
}

/** The bundle part's verdict on { page }: { ok, verdict, lines }. */
export function judgeBundle(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const p = run?.page;
  say(typeof p?.pin === "string" && p.pin === p.sha384, `[SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`);
  say(p?.rule === true, "[SIGN_HOST] the build carries Solana's, Base's and Robinhood's withdraw, and its one rule reads that table");
  say(p?.addressed === true, "[SIGN_HOST] pool.address gives a deposit address on each pool chain the rule opens, Base and Robinhood with Solana");
  say(p?.reader === true, "[SIGN_HOST] the follow reads a Base or Robinhood U_X on the helper's /v1/rpc/{chain} alone");
  say(p?.withdraw === WITHDRAW_MARKS.length, `[SIGN_HOST] the build carries the EVM withdraw: ${p?.withdraw ?? "not read"}/${WITHDRAW_MARKS.length} marks`);
  const SITES = { host: "its host opens on the rule alone", flow: "pool.withdraw opens its screen", deps: "the screen's funds and run", run: "a tap's run", owed: "a reload finishes an owed withdraw" };
  for (const [k, what] of Object.entries(SITES)) say(p?.withdrawSites?.[k] === true, `[SIGN_HOST] the EVM withdraw on the rule: ${what} (${k})`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), false);
  return { ok: verdict === "PASS", verdict, lines };
}

const helperGet = async (fetchFn, net, url) => {
  try {
    const r = await fetchFn(url, { redirect: "error" });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { net, status: r.status, body };
  } catch (e) {
    return { net, noAnswer: `${new URL(HELPER).host}: ${e?.name ?? "error"}` };
  }
};

/** The chain's and the helper's reads for each pin: { reads: [{ net, rpc, what, answer }], helper: [{ net, status, body }] }. */
export async function readChain(fetchFn = fetch) {
  const reads = [];
  const helper = [];
  for (const [net, pin] of Object.entries(PINS)) {
    for (const rpc of MAINNETS[net].rpcs) {
      reads.push({ net, rpc, what: "chainId", answer: await rpcAnswer(rpc, "eth_chainId", [], { fetchFn }) });
      reads.push({ net, rpc, what: "code", answer: await rpcAnswer(rpc, "eth_getCode", [pin.pool, "latest"], { fetchFn }) });
      reads.push({ net, rpc, what: "scope", answer: await rpcAnswer(rpc, "eth_call", [{ to: pin.pool, data: SCOPE_SELECTOR }, "latest"], { fetchFn }) });
      reads.push({ net, rpc, what: "senderBalance", answer: await rpcAnswer(rpc, "eth_getBalance", [pin.feeRecipient, "latest"], { fetchFn }) });
    }
    helper.push(await helperGet(fetchFn, net, `${HELPER}/v1/pool/fee?pool=${pin.pool}`));
  }
  return { reads, helper };
}

/** The device's bind reads (the wallet's child, as device-evm-fee-read-walks-operators runs it), then the helper's fee
 *  for that period and the one before: { [net]: { bind, helper, other } }. */
export async function readFee(fetchFn = fetch, runChild = bindChild) {
  const out = await runChild();
  const fee = {};
  for (const [net, pin] of Object.entries(PINS)) {
    const bind = (out?.[net]?.tries ?? []).find((t) => t.ok) ?? out?.[net]?.tries?.at(-1) ?? null;
    const entry = { bind };
    if (bind?.ok) {
      const startMs = Date.parse(bind.start);
      entry.helper = await helperGet(fetchFn, net, `${HELPER}/v1/pool/fee?pool=${pin.pool}&epoch=${startMs}`);
      entry.other = await helperGet(fetchFn, net, `${HELPER}/v1/pool/fee?pool=${pin.pool}&epoch=${startMs - EPOCH_MS}`);
    }
    fee[net] = entry;
  }
  return fee;
}

const bindChild = () =>
  new Promise((res, no) =>
    execFile(process.execPath, childArgs(), { cwd: REPO, timeout: 300_000, maxBuffer: 1 << 20 }, (e, stdout, stderr) =>
      e ? no(new Error(`${KEY}: the bind child failed: ${String(stderr).slice(-300)}`)) : res(JSON.parse(String(stdout).trim().split("\n").at(-1))),
    ),
  );

/** The fee the device binds at: the page's evmEpochFee (the kit's evmPoolFee at evmPoolGas(depth) and the block's base fee). */
export const deviceFee = (bind) => evmPoolFee({ gas: evmPoolGas(Number(bind.depth)), gasPrice: BigInt(bind.baseFeePerGas), chainFee: BigInt(bind.chainFee) });

/** The chain and fee parts' verdict on { reads, helper, fee }: { verdict, lines }. */
export function checkChain(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  const venues = evmPoolVenues();
  for (const [net, pin] of Object.entries(PINS)) {
    const got = { chainId: [], code: [], scope: [] };
    for (const rpc of MAINNETS[net].rpcs) {
      const host = new URL(rpc).host;
      for (const what of ["chainId", "code", "scope", "senderBalance"]) {
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
        const v = a.error === undefined && typeof a.result === "string" ? a.result.toLowerCase() : null;
        if (what === "senderBalance") lines.push(`--  [${net}] the withdraw sender ${pin.feeRecipient} holds ${v === null ? "no read" : `${BigInt(v)} wei`} on ${host}`);
        else got[what].push(v);
      }
    }
    const want = MAINNETS[net].chainId.toLowerCase();
    if (got.chainId.length === 2) say(got.chainId.every((c) => c === want), `[${net}] both RPCs are chain ${BigInt(want)}: ${got.chainId.map((c) => (c === null ? "none" : BigInt(c))).join(", ")}`);
    if (got.code.length === 2) say(got.code[0] !== null && got.code[0].length > 2 && got.code[0] === got.code[1], `[${net}] the pool ${pin.pool} has code, the same on both RPCs`);
    if (got.scope.length === 2) say(got.scope[0] !== null && /^0x[0-9a-f]{64}$/.test(got.scope[0]) && BigInt(got.scope[0]) !== 0n && got.scope[0] === got.scope[1], `[${net}] the pool's SCOPE() answers one non-zero word on both RPCs: ${got.scope.map((s) => s ?? "none").join(", ")}`);
    const h = (run?.helper ?? []).find((x) => x.net === net);
    if (h?.noAnswer !== undefined) {
      quiet = true;
      lines.push(`NOTE [${net}] the helper: ${h.noAnswer}`);
    } else {
      const named = typeof h?.body?.pool === "string" && h.body.pool.toLowerCase() === pin.pool && h.body.network === net;
      say(h?.status === 200 && named, `[${net}] the helper carries the pool's withdraw: GET /v1/pool/fee ${h?.status ?? "not read"}${h?.status === 200 && !named ? ", naming another pool" : ""}`);
    }
    // the fee part: the helper's fee for the bind's period is the device's own, to the wei
    const f = run?.fee?.[net];
    const bind = f?.bind;
    if (!bind) say(false, `[${net}] no device bind read`);
    else if (!bind.ok) {
      const lag = Array.isArray(bind.lagging) || bind.name === "noAnswer";
      if (lag) quiet = true;
      lines.push(`${lag ? "NOTE" : "BAD"} [${net}] the device's bind reads did not bind (${bind.name}): ${String(bind.error).slice(0, 160)}`);
    } else {
      say(String(venues[net]?.pool).toLowerCase() === pin.pool, `[${net}] the device's bind reads the pinned pool: ${venues[net]?.pool}`);
      const fee = deviceFee(bind);
      const a = f.helper;
      if (a?.noAnswer !== undefined) {
        quiet = true;
        lines.push(`NOTE [${net}] the helper's fee: ${a.noAnswer}`);
      } else {
        const b = a?.body;
        const block = typeof b?.block === "string" || typeof b?.block === "number" ? BigInt(b.block).toString() : null;
        const same = a?.status === 200 && b?.network === net && String(b?.pool).toLowerCase() === pin.pool && b?.epoch_start_ms === Date.parse(bind.start) && block === bind.block && b?.fee === fee.toString();
        say(same, `[${net}] the helper's fee for the period at ${bind.start} is the device's own: block ${bind.block} (helper ${block ?? "none"}), depth ${bind.depth}, base fee ${bind.baseFeePerGas}, chain fee ${bind.chainFee}: device ${fee} wei, helper ${a?.status === 200 ? b?.fee : `HTTP ${a?.status ?? "not read"}`}`);
      }
    }
  }
  return { verdict: verdictOf(lines.some((l) => l.startsWith("BAD")), quiet), lines };
}

/** The verdict on one whole run { page?, reads, helper, fee } (a --part helper run has no page): { ok, verdict, lines }. */
export function judge(run) {
  const s = run?.part === "helper" ? { ok: true, lines: [] } : judgeBundle(run);
  const c = checkChain(run);
  const verdict = !s.ok || c.verdict === "FAIL" ? "FAIL" : c.verdict;
  return { ok: verdict === "PASS", verdict, lines: [...s.lines, ...c.lines] };
}

/** SIGN_HOST's index and /app.js (or this tree's build; none for --part helper), then the chain, the fee and the helper. */
export async function read(fetchFn = fetch, { local = false, part } = {}) {
  let page;
  if (part === "helper") page = undefined;
  else if (local) page = pageFacts(readFileSync(path.join(signBuilt(), "index.html"), "utf8"), readFileSync(path.join(signBuilt(), "public/app.js"), "utf8"));
  else page = (await readBundle(fetchFn)).page;
  const [chain, fee] = await Promise.all([readChain(fetchFn), readFee(fetchFn)]);
  return { readAt: new Date().toISOString(), from: part === "helper" ? "helper part" : local ? "local build" : SIGN, ...(part === "helper" ? { part } : { page }), ...chain, fee };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const part = a.includes("--part") ? a[a.indexOf("--part") + 1] : undefined;
    if (part !== undefined && part !== "helper") throw new Error(`--part ${part}: only helper`);
    const run = await read(fetch, { local: a.includes("--local"), part });
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
