#!/usr/bin/env node
// Live check of card evm-quote-read-gas-starve. Inside Multicall3's aggregate3 a read that runs out of the call's shared
// gas answers as a revert, and the kit's EVM quote prices a reverted route at nothing, so one heavy read starved the
// reads after it. The kit (packages/kit/src/checks/evm/quote.ts) now sends every aggregate3 call with its gas set to
// EVM_READ_CALL_GAS and EVM_READ_GAS_CODE at Multicall3's address (eth_call's state override): each read gets its own
// share of the call's gas, and a read that may have run out of it answers 2, which the kit reads again alone. What it
// proves, and only that: on every provider the kit pins for a mainnet quote (evmPoolVenues: Base and Robinhood, at
// least two each), at its latest block, the kit's own code and gas (its exports, not copied here) answer six planted
// reads (eth_call code overrides at addresses no one holds, read only) as
//   [returns 7, loops forever, returns 7, reverts 0xaa, calls the loop with all its gas then reverts 0xee, returns 7]
//   -> [1 7, 2 empty, 1 7, 0 0xaa, 2 0xee, 1 7]
// so the loop starves none of the reads after it, a real revert stays a revert, and a read that caught a frame running
// out of gas (as a quoter does) is told apart from it; and 64 reads with the loop first answer 2 then 63 of 1. That
// the kit reads a 2 again alone, agrees on it and prices nothing on one answered alone is its test
// (test/evm-quote-attacks.test.ts GS1-GS5 and their mutants in test/evm-quote-mutants.mjs).
//   node scripts/live-checks/evm-quote-read-gas-starve.mjs [--record <file> --as good|bad] [--answer <file> --as good|bad]
// The bad answer is the same run through Multicall3's own code (no override): the loop and the 0xee read answer 0.
// PASS exit 0, FAIL exit 1, error exit 2.
// Runs: once, it reads what a host deploy cannot change: the providers' answers to the kit's per-read gas code (the
// kit's buy quote ships in no host's bundle yet)
import "../net-window.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { EVM_READ_CALL_GAS, EVM_READ_GAS_CODE, evmPoolVenues } from "../../packages/kit/src/index.ts";

const KEY = "evm-quote-read-gas-starve";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const w = (v) => BigInt(v).toString(16).padStart(64, "0");
const LOOP = "0x00000000000000000000000000000000000b0b01";
const SEVEN = "0x00000000000000000000000000000000000b0b02";
const REV = "0x00000000000000000000000000000000000b0b03";
const CATCH = "0x00000000000000000000000000000000000b0b04";
/** The planted code: a loop until out of gas, a return of the word 7, a revert of the word 0xaa, and a call of the loop
 *  with all its gas followed by a revert of the word 0xee (a quoter catching an inner out of gas). */
export const PLANTED = Object.freeze({
  [LOOP]: "0x5b600056",
  [SEVEN]: "0x600760005260206000f3",
  [REV]: "0x60aa60005260206000fd",
  [CATCH]: "0x60006000600060006000" + "73" + LOOP.slice(2) + "5af150" + "60ee60005260206000fd",
});
const SIX = [SEVEN, LOOP, SEVEN, REV, CATCH, SEVEN];
const SIX_WANT = [[1, "7"], [2, ""], [1, "7"], [0, "aa"], [2, "ee"], [1, "7"]];
const SIXTY_FOUR = [LOOP, ...Array(63).fill(SEVEN)];
const SIXTY_FOUR_WANT = "2" + "1".repeat(63);

/** aggregate3((address,bool,bytes)[]) of empty calldata to each of `tos`, every read with allowFailure */
function aggregate(tos) {
  const el = tos.map((to) => w(to) + w(1) + w(0x60) + w(0));
  let at = 32 * el.length;
  const offs = el.map((e) => {
    const o = w(at);
    at += e.length / 2;
    return o;
  });
  return "0x82ad56cb" + w(0x20) + w(el.length) + offs.join("") + el.join("");
}
/** Each read's success word and its return data's last significant hex digits, or null for an answer that is not one */
export function results(r) {
  if (typeof r !== "string" || !/^0x([0-9a-f]{64})+$/i.test(r)) return null;
  const h = r.slice(2);
  const at = (o) => Number(BigInt("0x" + h.slice(2 * o, 2 * o + 64)));
  try {
    return Array.from({ length: at(32) }, (_, i) => {
      const e = 64 + at(64 + 32 * i);
      return [at(e), h.slice(2 * (e + 96), 2 * (e + 96 + at(e + 64))).replace(/^0+/, "")];
    });
  } catch {
    return null;
  }
}

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  return j.result ?? { error: j.error ?? `HTTP ${r.status}` };
}

/** Each mainnet chain's providers' answers at their latest block; `own`: Multicall3's own code (the bad answer) */
export async function collect(own = false) {
  const out = [];
  const state = { ...Object.fromEntries(Object.entries(PLANTED).map(([a, code]) => [a, { code }])), ...(own ? {} : { [MULTICALL3]: { code: EVM_READ_GAS_CODE } }) };
  const gas = "0x" + EVM_READ_CALL_GAS.toString(16);
  for (const [chain, v] of Object.entries(evmPoolVenues())) {
    if (!["base", "robinhood"].includes(chain)) continue;
    const reads = [];
    for (const url of v.providers ?? []) {
      const block = await rpc(url, "eth_getBlockByNumber", ["latest", false]);
      if (typeof block?.hash !== "string") throw new Error(`${new URL(url).host} answered no latest block`);
      const at = { blockHash: block.hash };
      reads.push({
        provider: new URL(url).host,
        block: block.hash,
        six: await rpc(url, "eth_call", [{ to: MULTICALL3, data: aggregate(SIX), gas }, at, state]),
        sixtyFour: await rpc(url, "eth_call", [{ to: MULTICALL3, data: aggregate(SIXTY_FOUR), gas }, at, state]),
      });
    }
    out.push({ chain, reads });
  }
  return { at: new Date().toISOString(), code: own ? "multicall3" : EVM_READ_GAS_CODE, chains: out };
}

/** PASS where each mainnet chain has two providers or more, and each answers both planted calls as the kit's code must */
export function judge(a) {
  const lines = [];
  let ok = true;
  const line = (good, s) => {
    lines.push(`${good ? "ok " : "BAD"} ${s}`);
    if (!good) ok = false;
  };
  line(a?.code === EVM_READ_GAS_CODE, `the run's code is the kit's EVM_READ_GAS_CODE`);
  const chains = a?.chains ?? [];
  line(["base", "robinhood"].every((c) => chains.some((x) => x.chain === c)), "Base and Robinhood were read");
  for (const { chain, reads } of chains) {
    line(reads.length >= 2, `${chain}: ${reads.length} providers`);
    for (const r of reads) {
      const six = results(r.six);
      line(six !== null && JSON.stringify(six) === JSON.stringify(SIX_WANT), `${chain} ${r.provider}: six planted reads answer ${JSON.stringify(six ?? r.six)}`);
      const many = results(r.sixtyFour);
      line(many !== null && many.map((x) => x[0]).join("") === SIXTY_FOUR_WANT, `${chain} ${r.provider}: 64 reads, the loop first, answer ${many === null ? JSON.stringify(r.sixtyFour) : many.map((x) => x[0]).join("")}`);
    }
  }
  return { ok, lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
  try {
    let a;
    if (arg("--answer") !== undefined) a = JSON.parse(readFileSync(arg("--answer"), "utf8"))[arg("--as") ?? "good"];
    else a = await collect(arg("--as") === "bad");
    if (arg("--record") !== undefined) {
      const f = arg("--record");
      const all = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
      all[arg("--as") ?? "good"] = a;
      writeFileSync(f, JSON.stringify(all, null, 1) + "\n");
    }
    const { ok, lines } = judge(a);
    for (const l of lines) console.log(l);
    console.log(`${KEY}: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
