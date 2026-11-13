#!/usr/bin/env node
// Live check of card signpage-evm-pool-buy: what the signing page's EVM pool buy stands on, read without a seed. It
// passes only when:
//   1. each buy of the card's run record (signpage-evm-pool-buy.md, its Buy lines) reads back on both of its chain's
//      testnet pool RPCs (RPCS: the pair the page reads a buy back on) as PrivacyPoolSimple.buy (selector 0x3edadd79) to
//      that chain's pinned pool (evm-pool-pins.mjs PINS), on the chain's own id, succeeded, in one block on both, with
//      the pool's Bought log;
//   2. HELPER_HOST's POST /v1/pool/evm/send, the route the page sends a buy through, asked from SIGN_HOST's origin with
//      a buy that is not one (the selector alone) for each testnet pool, refuses it bad_shape before any send and
//      echoes SIGN_HOST in Access-Control-Allow-Origin;
//   3. SIGN_HOST's served /app.js is the one its index.html pins, and it is the mainnet build with the EVM buy in it
//      beside its way back ("uniswap-v4", its route search; "owed/carry-evm-open", the carry of a refused buy's ETH on W
//      back into the pool, src/pool-carry-evm.ts) and no testnet pool: the buy opens on Base and Robinhood where the
//      build carries the chain's withdraw (change evm-buy-and-sell-on-mainnet, packages/signpage/test/
//      pool-mainnet-evm.test.ts). The buy records' key, "owed/cost-evm", is no mark: the positions pass reads it too.
// RPCS, CHAIN_IDS, BOUGHT and BUY_SELECTOR are this file's own (it reaches no package code: check:imports holds it);
// packages/signpage/test/pool-buy-evm.test.ts holds each equal to the page's own (TESTNET_RPCS, EVM_CHAIN_IDS,
// keccak256 of EVM_POOL_EVENTS.Bought, evm-send.ts EVM_BUY_SIGNATURE).
// After: sign
// Bundle: out a run record's buys on two testnet RPCs each and the helper's send route; on the build, the mainnet refusal its bundle part reads is held by packages/signpage/test/pool-network.test.ts (pool.buy on Base and Robinhood not_allowed)
//   node scripts/live-checks/signpage-evm-pool-buy.mjs [--record <file>] [--txs <md>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (a pool RPC gave no answer, provider-answer.mjs: never a
//   pass). --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PINS } from "./evm-pool-pins.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "signpage-evm-pool-buy";
export const HELPER = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
export const BUY_SELECTOR = "0x3edadd79";
/** keccak256("Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)"). */
export const BOUGHT = "0xb8a1e6c10d45357f60b093ab761ca4af74bf300c039aa105fb946f7e5105727d";
export const RPCS = Object.freeze({
  "base-sepolia": Object.freeze(["https://base-sepolia-rpc.publicnode.com", "https://base-testnet.api.pocket.network"]),
  "robinhood-testnet": Object.freeze(["https://rpc.testnet.chain.robinhood.com", "https://robinhood-sepolia-rpc.publicnode.com"]),
});
export const CHAIN_IDS = Object.freeze({ "base-sepolia": 84532n, "robinhood-testnet": 46630n });
/** Strings only the EVM buy's code and its carry carry in a bundle (src/pool-buy-evm.ts, src/pool-carry-evm.ts). */
export const EVM_BUY_MARKS = Object.freeze(["uniswap-v4", "owed/carry-evm-open"]);
/** The testnet pools (the kit's evmTestnetVenues): in the testnet build only. */
export const TESTNET_POOL_MARKS = Object.freeze(["0xeb967dfc1b4ffb22942f833c76866ea85fc42266", "0xed9fac860e6bc5e932455232eedca8b71c44da4d"]);
/** Each testnet's pinned pool, by network. */
export const PINS_OF = Object.freeze(Object.fromEntries(Object.entries(PINS).map(([k, v]) => [k, v.pool])));
const RECORD = new URL("./signpage-evm-pool-buy.md", import.meta.url);
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The buys of a run record: its `Buy: <network> <hash>` lines on the two testnets (each also a Tx line). */
export const txsOf = (md) => [...md.matchAll(/^Buy: (base-sepolia|robinhood-testnet) (0x[0-9a-f]{64})$/gm)].map((m) => ({ network: m[1], hash: m[2] }));

/** What the check keeps of SIGN_HOST: its index's /app.js pin, the served bundle's sha384, the EVM buy marks and the
 *  testnet pools it holds. */
export function pageFacts(index, js) {
  return { pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null, sha384: sha384(js), marks: EVM_BUY_MARKS.filter((m) => js.includes(m)), testnet: TESTNET_POOL_MARKS.filter((m) => js.includes(m)) };
}

const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The check on one run: { txs, reads: [{ network, hash, rpc, method, answer }] (answer: rpcAnswer's), sends: [{ network,
 *  status, headers, body }], page: pageFacts }, against the pins (PINS) and pairs (RPCS). A pool RPC's no-answer is a
 *  NOTE and leaves the run INCONCLUSIVE, never a pass. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  say(run.txs.length >= 2 && new Set(run.txs.map((t) => t.network)).size === 2, `the record names a buy on each testnet: ${run.txs.map((t) => t.network).join(", ") || "none"}`);
  for (const { network, hash } of run.txs) {
    const pin = PINS[network];
    const rpcs = RPCS[network];
    const tag = `[${network} ${hash.slice(0, 10)}]`;
    if (!pin) {
      say(false, `${tag} no pinned pool`);
      continue;
    }
    const blocks = [];
    let silentHere = false;
    for (const rpc of rpcs) {
      const host = new URL(rpc).host;
      const got = ["eth_getTransactionByHash", "eth_getTransactionReceipt"].map((m) => run.reads.find((r) => r.hash === hash && r.rpc === rpc && r.method === m)?.answer);
      const silent = got.find((a) => a?.noAnswer !== undefined);
      if (silent) {
        quiet = silentHere = true;
        lines.push(`NOTE ${tag} ${silent.noAnswer}`);
        blocks.push(null);
        continue;
      }
      const [tx, rc] = got.map((a) => a?.result);
      say(tx?.hash?.toLowerCase() === hash && tx?.to?.toLowerCase() === pin.pool && typeof tx?.input === "string" && tx.input.startsWith(BUY_SELECTOR) && BigInt(tx?.chainId ?? -1) === CHAIN_IDS[network], `${tag} ${host}: buy() to the pinned pool ${pin.pool} on chain ${CHAIN_IDS[network]}: to ${tx?.to ?? "none"}, input ${String(tx?.input ?? "none").slice(0, 10)}`);
      const bought = Array.isArray(rc?.logs) && rc.logs.some((l) => l?.address?.toLowerCase() === pin.pool && l?.topics?.[0] === BOUGHT);
      say(rc?.status === "0x1" && bought, `${tag} ${host}: succeeded with the pool's Bought: status ${rc?.status ?? "none"}, Bought ${bought}`);
      blocks.push(rc?.blockNumber ?? null);
    }
    if (!silentHere) say(blocks.length === 2 && blocks[0] !== null && blocks[0] === blocks[1], `${tag} one block on both RPCs: ${blocks.join(", ")}`);
  }
  for (const network of Object.keys(RPCS)) {
    const s = run.sends.find((x) => x.network === network);
    const tag = `[helper /v1/pool/evm/send ${network}]`;
    if (!s) {
      say(false, `${tag} no read`);
      continue;
    }
    const code = json(s.body)?.error?.code;
    say((s.status === 400 || s.status === 422) && code === "bad_shape", `${tag} a malformed buy refused before any send: ${s.status} ${code ?? s.body.slice(0, 80)}`);
    say(s.headers["access-control-allow-origin"] === SIGN, `${tag} CORS allow-origin ${s.headers["access-control-allow-origin"] ?? "none"}`);
  }
  const p = run.page;
  say(typeof p?.pin === "string" && p.pin === p.sha384, `[SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`);
  say(Array.isArray(p?.marks) && p.marks.length === EVM_BUY_MARKS.length && Array.isArray(p?.testnet) && p.testnet.length === 0, `[SIGN_HOST] the mainnet build carries the EVM buy beside its carry and no testnet pool: buy ${Array.isArray(p?.marks) ? p.marks.join(", ") || "none" : "not read"}; testnet ${Array.isArray(p?.testnet) ? p.testnet.join(", ") || "none" : "not read"}`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

/** The run's reads: each recorded buy on its chain's two pool RPCs, the helper's send route from SIGN_HOST, SIGN_HOST's page. */
export async function read(md = readFileSync(RECORD, "utf8"), fetchFn = fetch, helper = HELPER) {
  const txs = txsOf(md);
  const reads = [];
  for (const { network, hash } of txs)
    for (const rpc of RPCS[network] ?? [])
      // a null for a recorded, landed buy is that backend not holding it (a load-balanced provider, Pocket on
      // 2026-11-10): read again once, then no answer (INCONCLUSIVE), never a FAIL or a PASS on it
      for (const method of ["eth_getTransactionByHash", "eth_getTransactionReceipt"]) reads.push({ network, hash, rpc, method, answer: await rpcAnswer(rpc, method, [hash], { fetchFn, nullNoAnswer: true }) });
  const sends = [];
  for (const network of Object.keys(RPCS)) {
    const pool = PINS[network].pool;
    const r = await fetchFn(`${helper}/v1/pool/evm/send`, { method: "POST", redirect: "manual", headers: { origin: SIGN, "content-type": "application/json" }, body: JSON.stringify({ pool, data: BUY_SELECTOR, epoch: 0 }) });
    const headers = {};
    for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
    sends.push({ network, status: r.status, headers: { "access-control-allow-origin": headers["access-control-allow-origin"] ?? null }, body: (await r.text()).slice(0, 2_000) });
  }
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`SIGN_HOST ${path}: HTTP ${r.status}`);
    return r.text();
  };
  const page = pageFacts(await get("/"), await get("/app.js"));
  return { readAt: new Date().toISOString(), txs, reads, sends, page };
}

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
