#!/usr/bin/env node
// Live check of card signpage-evm-pool-sell: what the signing page's EVM pool sell stands on, read without a seed. It
// passes only when:
//   1. each sale of the card's run record (signpage-evm-pool-sell.md, its Sell lines) reads back on both of its chain's
//      testnet pool RPCs (RPCS) as one EIP-7702 transaction (type 0x4) on the chain's own id, sent by the chain's pinned
//      sell sender (SELL_PINS) to W, calling SellDelegate.sell (selector 0x0c2cb9ca) under an authorization of the
//      pinned sell delegate on that chain id; succeeded, in one block on both, with the pinned pool's Deposited log
//      whose depositor is that W (the return note's deposit);
//   2. HELPER_HOST's POST /v1/pool/evm/sell, the route the page sends a sale through, asked from SIGN_HOST's origin
//      with a sale that is not one (the selector alone, no authorization) for each testnet pool, refuses it bad_shape
//      before any send and echoes SIGN_HOST in Access-Control-Allow-Origin;
//   3. SIGN_HOST's served /app.js is the one its index.html pins, and it is the mainnet build with the EVM sell in it
//      ("nonce()", its read of W's SellDelegate nonce; the Sell type string, the typed data W signs) and no testnet
//      pool: the sale opens on Base and Robinhood where the build carries the chain's withdraw (change
//      evm-buy-and-sell-on-mainnet, packages/signpage/test/pool-mainnet-evm.test.ts). The open sales' and the buy
//      records' keys are no marks: the positions pass reads both.
// RPCS, CHAIN_IDS, DEPOSITED, SELL_SELECTOR and SELL_PINS are this file's own (it reaches no package code:
// check:imports holds it); packages/signpage/test/pool-sell-evm.test.ts holds each equal to the page's own.
// After: sign
//   node scripts/live-checks/signpage-evm-pool-sell.mjs [--record <file>] [--txs <md>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (a pool RPC gave no answer, provider-answer.mjs: never a
//   pass). --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PINS } from "./evm-pool-pins.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "signpage-evm-pool-sell";
export const HELPER = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
/** sell((address,uint256,address,bytes,uint256,address,uint256,uint256,address,uint256,uint256),uint256,bytes) */
export const SELL_SELECTOR = "0x0c2cb9ca";
/** keccak256("Deposited(address,uint256,uint256,uint256,uint256)"). */
export const DEPOSITED = "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";
export const RPCS = Object.freeze({
  "base-sepolia": Object.freeze(["https://base-sepolia-rpc.publicnode.com", "https://base-testnet.api.pocket.network"]),
  "robinhood-testnet": Object.freeze(["https://rpc.testnet.chain.robinhood.com", "https://robinhood-sepolia-rpc.publicnode.com"]),
});
export const CHAIN_IDS = Object.freeze({ "base-sepolia": 84532n, "robinhood-testnet": 46630n });
/** Each testnet's pinned sell delegate and sell sender (the kit's evmPoolVenues). */
export const SELL_PINS = Object.freeze({
  "base-sepolia": Object.freeze({ sellDelegate: "0x7a034461193cc6b1a7d5d0f5fe4a36b34e7ebc12", sellSender: "0xd378cda68babba6a9dc1d52335bb76ca9e6a7553" }),
  "robinhood-testnet": Object.freeze({ sellDelegate: "0xcec6c1b18be682cfa1679568eab309db79fe3cce", sellSender: "0xd12d83097671d731df2db731e973ad9a07673607" }),
});
/** Strings only the EVM sell's code carries in a bundle (src/pool-sell-evm.ts: the SellDelegate nonce() call it reads
 *  on W; the kit's sell-unpinned.ts: the Sell typed data W signs). The helper's route table names /v1/pool/evm/sell in every build, and the positions pass reads the open
 *  sales' and the buy records' keys (owed/sell-evm, owed/cost-evm), so none of them is a mark. */
export const EVM_SELL_MARKS = Object.freeze([
  "nonce()",
  "Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)",
]);
const RECORD = new URL("./signpage-evm-pool-sell.md", import.meta.url);
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const lower = (s) => (typeof s === "string" ? s.toLowerCase() : null);
const addrOfTopic = (t) => (typeof t === "string" && t.length === 66 ? `0x${t.slice(26).toLowerCase()}` : null);

/** The sales of a run record: its `Sell: <network> <hash>` lines on the two testnets (each also a Tx line). */
export const txsOf = (md) => [...md.matchAll(/^Sell: (base-sepolia|robinhood-testnet) (0x[0-9a-f]{64})$/gm)].map((m) => ({ network: m[1], hash: m[2] }));

/** The testnet pools (the kit's evmTestnetVenues): in the testnet build only. */
export const TESTNET_POOL_MARKS = Object.freeze(["0xeb967dfc1b4ffb22942f833c76866ea85fc42266", "0xed9fac860e6bc5e932455232eedca8b71c44da4d"]);
/** What the check keeps of SIGN_HOST: its index's /app.js pin, the served bundle's sha384, the EVM sell marks and the
 *  testnet pools it holds. */
export function pageFacts(index, js) {
  return { pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null, sha384: sha384(js), marks: EVM_SELL_MARKS.filter((m) => js.includes(m)), testnet: TESTNET_POOL_MARKS.filter((m) => js.includes(m)) };
}

const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The check on one run: { txs, reads: [{ network, hash, rpc, method, answer }], sends: [{ network, status, headers,
 *  body }], page: pageFacts }. A pool RPC's no-answer is a NOTE and leaves the run INCONCLUSIVE, never a pass. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  say(run.txs.length >= 2 && new Set(run.txs.map((t) => t.network)).size === 2, `the record names a sale on each testnet: ${run.txs.map((t) => t.network).join(", ") || "none"}`);
  for (const { network, hash } of run.txs) {
    const pin = PINS[network];
    const sell = SELL_PINS[network];
    const rpcs = RPCS[network];
    const tag = `[${network} ${hash.slice(0, 10)}]`;
    if (!pin || !sell) {
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
      const auth = Array.isArray(tx?.authorizationList) ? tx.authorizationList : [];
      const authOk = auth.length === 1 && lower(auth[0]?.address) === sell.sellDelegate && BigInt(auth[0]?.chainId ?? -1) === CHAIN_IDS[network];
      say(lower(tx?.hash) === hash && tx?.type === "0x4" && BigInt(tx?.chainId ?? -1) === CHAIN_IDS[network] && lower(tx?.from) === sell.sellSender && typeof tx?.input === "string" && tx.input.startsWith(SELL_SELECTOR) && authOk, `${tag} ${host}: a type 4 sell() from the pinned sell sender under the pinned delegate's authorization on chain ${CHAIN_IDS[network]}: type ${tx?.type ?? "none"}, from ${tx?.from ?? "none"}, input ${String(tx?.input ?? "none").slice(0, 10)}, authorization ${auth.map((a) => `${a?.address}@${a?.chainId}`).join(",") || "none"}`);
      const w = lower(tx?.to);
      const dep = Array.isArray(rc?.logs) && rc.logs.some((l) => lower(l?.address) === pin.pool && l?.topics?.[0] === DEPOSITED && addrOfTopic(l?.topics?.[1]) === w);
      say(rc?.status === "0x1" && dep, `${tag} ${host}: succeeded with the pool's Deposited from W ${w ?? "none"}: status ${rc?.status ?? "none"}, Deposited ${dep}`);
      blocks.push(rc?.blockNumber ?? null);
    }
    if (!silentHere) say(blocks.length === 2 && blocks[0] !== null && blocks[0] === blocks[1], `${tag} one block on both RPCs: ${blocks.join(", ")}`);
  }
  for (const network of Object.keys(RPCS)) {
    const s = run.sends.find((x) => x.network === network);
    const tag = `[helper /v1/pool/evm/sell ${network}]`;
    if (!s) {
      say(false, `${tag} no read`);
      continue;
    }
    const code = json(s.body)?.error?.code;
    say(s.status === 400 && code === "bad_shape", `${tag} a malformed sale refused before any send: ${s.status} ${code ?? s.body.slice(0, 80)}`);
    say(s.headers["access-control-allow-origin"] === SIGN, `${tag} CORS allow-origin ${s.headers["access-control-allow-origin"] ?? "none"}`);
  }
  const p = run.page;
  say(typeof p?.pin === "string" && p.pin === p.sha384, `[SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`);
  say(Array.isArray(p?.marks) && p.marks.length === EVM_SELL_MARKS.length && Array.isArray(p?.testnet) && p.testnet.length === 0, `[SIGN_HOST] the mainnet build carries the EVM sell and no testnet pool: sell ${Array.isArray(p?.marks) ? p.marks.length : "not read"}/${EVM_SELL_MARKS.length} marks; testnet ${Array.isArray(p?.testnet) ? p.testnet.join(", ") || "none" : "not read"}`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

/** The run's reads: each recorded sale on its chain's two pool RPCs, the helper's sell route from SIGN_HOST, SIGN_HOST's page. */
export async function read(md = readFileSync(RECORD, "utf8"), fetchFn = fetch, helper = HELPER) {
  const txs = txsOf(md);
  const reads = [];
  for (const { network, hash } of txs)
    for (const rpc of RPCS[network] ?? [])
      // a null for a recorded, landed sale is that backend not holding it: read again once, then no answer
      // (INCONCLUSIVE), never a FAIL or a PASS on it
      for (const method of ["eth_getTransactionByHash", "eth_getTransactionReceipt"]) reads.push({ network, hash, rpc, method, answer: await rpcAnswer(rpc, method, [hash], { fetchFn, nullNoAnswer: true }) });
  const sends = [];
  for (const network of Object.keys(RPCS)) {
    const pool = PINS[network].pool;
    const r = await fetchFn(`${helper}/v1/pool/evm/sell`, { method: "POST", redirect: "manual", headers: { origin: SIGN, "content-type": "application/json" }, body: JSON.stringify({ pool, w: pool, data: SELL_SELECTOR }) });
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
