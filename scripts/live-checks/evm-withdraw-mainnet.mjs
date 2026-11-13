#!/usr/bin/env node
// Live check of card evm-withdraw-mainnet: money leaves a Base or Robinhood pool to the address typed, read without a
// seed. It passes only when:
//   1. each withdraw of the card's run record (evm-withdraw-mainnet.md, its Withdraw lines: the network, the release,
//      W's onward send, To and the part in wei) reads back on both of its chain's pool RPCs (RPCS_OF: a testnet's
//      signpage-evm-pool-buy.mjs RPCS, Base's and Robinhood's mainnet pool-evm-deploy.mjs MAINNETS), and the record
//      names a withdraw on Base and on Robinhood, each from its testnet or its mainnet, and once it names a mainnet one,
//      one on Base mainnet and one on Robinhood mainnet;
//      - the release: PrivacyPool.withdraw (selector WITHDRAW_SELECTOR) to the network's pinned pool (PIN_OF: a testnet's
//        evm-pool-pins.mjs PINS, a mainnet's evm-pools-on-mainnet.mjs PINS), on the network's own id, succeeded, with
//        the pool's Withdrawn naming W;
//      - the onward send: from that W, to To (never the pool, never W), exactly the part, no calldata, on the chain's id,
//        succeeded;
//      - each in one block on both RPCs;
//   2. SIGN_HOST's served /app.js is the one its index.html pins, and wherever it carries an EVM pool (the EVM buy's
//      marks, signpage-evm-pool-buy.mjs EVM_BUY_MARKS) it carries the EVM withdraw too (WITHDRAW_MARKS): a build that
//      pins a Base or Robinhood pool opens its withdraw screen, so money that goes in there can come out.
// WITHDRAW_SELECTOR, WITHDRAWN and WITHDRAW_MARKS are this file's own (it reaches no package code: check:imports holds
// it); packages/signpage/test/pool-withdraw-evm.test.ts holds each equal to the page's own.
// After: sign
// Bundle: out a run record's withdraws (each a release and W's onward send) on two testnet RPCs each; on the build, its bundle part is held by packages/signpage/scripts/build-network.test.mjs (the EVM withdraw's release in both builds)
//   node scripts/live-checks/evm-withdraw-mainnet.mjs [--record <file>] [--txs <md>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (a pool RPC gave no answer, provider-answer.mjs: never a
//   pass). --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { PINS } from "./evm-pool-pins.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";
import { PINS as MAINNET_PINS } from "./evm-pools-on-mainnet.mjs";
import { MAINNETS } from "./pool-evm-deploy.mjs";
import { CHAIN_IDS, EVM_BUY_MARKS, RPCS, pageFacts as buyFacts } from "./signpage-evm-pool-buy.mjs";

/** Each network a Withdraw line may name: the testnets, and Base's and Robinhood's mainnet. */
export const PIN_OF = Object.freeze({ ...PINS, base: MAINNET_PINS.base, robinhood: MAINNET_PINS.robinhood });
export const RPCS_OF = Object.freeze({ ...RPCS, base: MAINNETS.base.rpcs, robinhood: MAINNETS.robinhood.rpcs });
export const CHAIN_ID_OF = Object.freeze({ ...CHAIN_IDS, base: BigInt(MAINNETS.base.chainId), robinhood: BigInt(MAINNETS.robinhood.chainId) });
/** The chain each network is: Base Sepolia is Base's testnet, Robinhood's testnet Robinhood's. */
const CHAIN_OF = Object.freeze({ "base-sepolia": "base", base: "base", "robinhood-testnet": "robinhood", robinhood: "robinhood" });

const KEY = "evm-withdraw-mainnet";
export const SIGN = "https://confidential.unrealized.trade";
/** keccak256 of withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes), its first 4 bytes. */
export const WITHDRAW_SELECTOR = "0x94374b2b";
/** keccak256("Withdrawn(address,address,uint256,uint256,uint256,uint256)"). */
export const WITHDRAWN = "0xfabb9e7afa4ef595f60e1ae9041b2b311b4acb27aeaed4b11b6f2abf689af10a";
/** Strings only the EVM withdraw's code carries in a bundle: the release's signature (src/evm-send.ts) and the epoch
 *  fee's probe key (src/pool-withdraw-evm.ts). */
export const WITHDRAW_MARKS = Object.freeze(["withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)", "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"]);
const RECORD = new URL("./evm-withdraw-mainnet.md", import.meta.url);
const lower = (s) => (typeof s === "string" ? s.toLowerCase() : s);

/** The withdraws of a run record: its `Withdraw: <network> <release> <onward> <to> <part wei>` lines. */
export const withdrawsOf = (md) =>
  [...md.matchAll(/^Withdraw: (base-sepolia|robinhood-testnet|base|robinhood) (0x[0-9a-f]{64}) (0x[0-9a-f]{64}) (0x[0-9a-fA-F]{40}) ([0-9]+)$/gm)].map((m) => ({ network: m[1], release: m[2], onward: m[3], to: m[4].toLowerCase(), part: m[5] }));

/** What the check keeps of SIGN_HOST: the buy check's facts (the pin, the bundle's sha384, the EVM buy marks) and the
 *  EVM withdraw marks the bundle holds. */
export function pageFacts(index, js) {
  return { ...buyFacts(index, js), withdraw: WITHDRAW_MARKS.filter((m) => js.includes(m)) };
}

/** The check on one run: { withdraws, reads: [{ network, hash, rpc, method, answer }], page }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  const chains = new Set(run.withdraws.map((t) => CHAIN_OF[t.network]));
  say(chains.has("base") && chains.has("robinhood"), `the record names a withdraw on Base and on Robinhood: ${run.withdraws.map((t) => t.network).join(", ") || "none"}`);
  // once the record names one mainnet withdraw, it names one on each mainnet: a testnet line never stands in for a
  // mainnet one (the mainnet lines are the owner's withdraw taps after the deploy, evm-withdraw-mainnet.md)
  const mainnet = run.withdraws.filter((t) => t.network === "base" || t.network === "robinhood").map((t) => t.network);
  if (mainnet.length > 0) say(mainnet.includes("base") && mainnet.includes("robinhood"), `the record names a mainnet withdraw on Base and on Robinhood once it names one: ${mainnet.join(", ")}`);
  for (const wd of run.withdraws) {
    const pin = PIN_OF[wd.network];
    const tag = `[${wd.network} ${wd.release.slice(0, 10)}]`;
    if (!pin) {
      say(false, `${tag} no pinned pool`);
      continue;
    }
    const blocks = { release: [], onward: [] };
    let silentHere = false;
    for (const rpc of RPCS_OF[wd.network]) {
      const host = new URL(rpc).host;
      const got = (hash, m) => run.reads.find((r) => r.hash === hash && r.rpc === rpc && r.method === m)?.answer;
      const answers = [got(wd.release, "eth_getTransactionByHash"), got(wd.release, "eth_getTransactionReceipt"), got(wd.onward, "eth_getTransactionByHash"), got(wd.onward, "eth_getTransactionReceipt")];
      const silent = answers.find((a) => a?.noAnswer !== undefined);
      if (silent) {
        quiet = silentHere = true;
        lines.push(`NOTE ${tag} ${silent.noAnswer}`);
        continue;
      }
      const [rt, rr, ot, or] = answers.map((a) => a?.result);
      say(lower(rt?.hash) === wd.release && lower(rt?.to) === pin.pool && typeof rt?.input === "string" && rt.input.startsWith(WITHDRAW_SELECTOR) && BigInt(rt?.chainId ?? -1) === CHAIN_ID_OF[wd.network], `${tag} ${host}: the release is withdraw() to the pinned pool ${pin.pool} on chain ${CHAIN_ID_OF[wd.network]}: to ${rt?.to ?? "none"}, input ${String(rt?.input ?? "none").slice(0, 10)}`);
      const withdrawn = Array.isArray(rr?.logs) ? rr.logs.find((l) => lower(l?.address) === pin.pool && l?.topics?.[0] === WITHDRAWN) : undefined;
      const w = typeof withdrawn?.topics?.[1] === "string" ? `0x${withdrawn.topics[1].slice(26)}`.toLowerCase() : null;
      say(rr?.status === "0x1" && w !== null, `${tag} ${host}: the release succeeded with the pool's Withdrawn: status ${rr?.status ?? "none"}, W ${w ?? "none"}`);
      say(w !== null && lower(ot?.hash) === wd.onward && lower(ot?.from) === w && lower(ot?.to) === wd.to && wd.to !== pin.pool && wd.to !== w && BigInt(ot?.value ?? -1) === BigInt(wd.part) && (ot?.input === "0x" || ot?.input === "") && BigInt(ot?.chainId ?? -1) === CHAIN_ID_OF[wd.network], `${tag} ${host}: W's onward send is exactly the part ${wd.part} wei from W to ${wd.to}: from ${ot?.from ?? "none"}, to ${ot?.to ?? "none"}, value ${ot?.value === undefined ? "none" : BigInt(ot.value)}, input ${String(ot?.input ?? "none").slice(0, 10)}`);
      say(or?.status === "0x1" && lower(or?.from) === w && lower(or?.to) === wd.to, `${tag} ${host}: W's onward send succeeded: status ${or?.status ?? "none"}`);
      blocks.release.push(rr?.blockNumber ?? null);
      blocks.onward.push(or?.blockNumber ?? null);
    }
    if (!silentHere)
      for (const [k, b] of Object.entries(blocks)) say(b.length === 2 && b[0] !== null && b[0] === b[1], `${tag} the ${k} in one block on both RPCs: ${b.join(", ")}`);
  }
  const p = run.page;
  say(typeof p?.pin === "string" && p.pin === p.sha384, `[SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`);
  const evm = Array.isArray(p?.marks) && p.marks.length > 0;
  const out = Array.isArray(p?.withdraw) && p.withdraw.length === WITHDRAW_MARKS.length;
  say(Array.isArray(p?.marks) && Array.isArray(p?.withdraw) && (!evm || out), `[SIGN_HOST] a build with an EVM pool carries its withdraw: EVM buy marks ${Array.isArray(p?.marks) ? p.marks.length : "not read"}, EVM withdraw marks ${Array.isArray(p?.withdraw) ? `${p.withdraw.length}/${WITHDRAW_MARKS.length}` : "not read"}`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

/** The run's reads: each recorded withdraw's two transactions on its chain's two pool RPCs, and SIGN_HOST's page. */
export async function read(md = readFileSync(RECORD, "utf8"), fetchFn = fetch) {
  const withdraws = withdrawsOf(md);
  const reads = [];
  for (const wd of withdraws)
    for (const rpc of RPCS_OF[wd.network] ?? [])
      for (const hash of [wd.release, wd.onward])
        for (const method of ["eth_getTransactionByHash", "eth_getTransactionReceipt"]) reads.push({ network: wd.network, hash, rpc, method, answer: await rpcAnswer(rpc, method, [hash], { fetchFn, nullNoAnswer: true }) });
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`SIGN_HOST ${path}: HTTP ${r.status}`);
    return r.text();
  };
  const page = pageFacts(await get("/"), await get("/app.js"));
  return { readAt: new Date().toISOString(), withdraws, reads, page };
}

export { EVM_BUY_MARKS };

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--txs") ? readFileSync(opt("--txs"), "utf8") : undefined);
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
