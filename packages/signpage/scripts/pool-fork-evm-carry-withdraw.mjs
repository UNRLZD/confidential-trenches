// The signing page's own Base or Robinhood deposit address, carry, balance, withdraw and restore on a local fork of the
// chain's mainnet, the deployed pool (the wallet's EVM_POOLS pin) at the fork block, with
// nothing signed or sent on any real chain:
//   node contracts/pool-evm/test/fork-rpc.mjs [--record] --book pools -- node packages/signpage/scripts/pool-fork-evm-carry-withdraw.mjs <base|robinhood> <out.json> --slots <S>
// (a long run). It starts anvil itself on ANVIL_PORT (default 48701 Base, 48702 Robinhood),
// forking the chain at fork-rpc.mjs POOLS_FORK_BLOCKS through fork-rpc.mjs on FORK_RPC_PORT (default 47545), with
// --slots-in-an-epoch <S>: finalized is the head less 2 x S blocks, and the run mines 2 x S + 1 blocks, the last at the
// wall clock, wherever the page waits for a block to be final. The mainnet build: __SIGN_NETWORK__ is not set, so the pins and lists are
// SIGN_HOST's (the wallet's EVM_POOLS, src/pool-testnet.ts MAINNET_POOL_RPCS, the helper route of pageEvmWalletRpc).
// - Every request is answered on this machine: the chain's hosts the page and the kit name by the fork's anvil (each URL
//   kept, so a pair stays two providers); the helper's origin (src/trade.ts TRADE_HELPER) by the helper's own handler
//   (apps/helper/src/server.ts) on a local port, its EVM pool sender the helper's evmPoolSender on the fork with the
//   published test key sha256("helper-pool-senders/test-key/EVM_SENDER") (funded on the fork only) and its /v1/rpc route
//   the helper's createRpc with the fork as its keyed provider. Any other host throws: nothing reaches a real chain, the
//   real helper or 1Click.
// - The seed is the published all-zero test vector (packages/wallet/test/vectors/a8.json). 1Click's delivery to U_X is
//   the one thing played: anvil_setBalance on U_X, and its status read answers SUCCESS. Everything after is the page's.
// - What differs from the page in a browser, and only that: the prover is snarkjs's fullProve in this process on the
//   kit's pinned withdraw files, and the wallet store is fake-indexeddb in memory.
// Steps, each printed as `<iso time> +<s> <step>: <json>` with the transactions it sent (the page's raw sends and the
// helper sender's, counted apart):
//   1. device A, a fresh profile: the restore from the seed alone (the seed's notes in the pool at the fork block, none),
//      then the deposit namer names U_X, the address pool.address answers for the chain (src/deposit-name.ts);
//   2. refused, 0 sent: pool.deposit under the ladder's least rung (the app's own kind, src/pool-kinds.ts);
//   3. refused, 0 sent: U_X holds one wei under the floor; the follow (src/pool-deposit-follow.ts followPoolQuote over
//      evmQuoteRoute's deps, as src/main.ts wires them: U_X read on the helper's route) reads it and carries nothing;
//   4. the carry: U_X topped up to the floor, the same follow carries it into the pool (pool.deposit from U_X), the note
//      shows in the balance once its block is final (blocks mined as above), the follow ends once the deposit reads final
//      on both of the pool's RPCs;
//   4a. the deposit is the pool's first leaf (the pool's size 0 before it, 1 at its block): the page's state shows a ready
//      proof for it inside its first minute (read, no tap), a withdraw tapped inside that minute ends sent, and a second
//      withdraw of the change note at depth 1 ends sent, with what the page shows between the two (balance, the form's
//      Max, the refusal's words);
//   5. the restore's U_X read (src/pool-restore.ts restoreUxOf): U_X on the pool's own pair, empty after the carry;
//   6. a withdraw whose release the helper answers 503: the op as the page left it, nothing sent; the user's retry (a
//      second tap on the screen, or the page's state reads) finishes it, sent, the amount at To; a stop past the proof's
//      deadline is timed on the wall clock (stopPastDeadlineMs, seen within one round of about 12 s);
//   6a. every tap waits, as the user would, for a note the screen can spend (tapWaitMs in the record);
//   7. a withdraw whose onward send from W is lost (every page raw send dropped): it ends in_transit with the part owed;
//      a reload (a new page on the same store) runs the state reads' finish and the op ends sent;
//   8. device C, a fresh profile: the restore from the seed alone shows the spent notes SPENT and the same balance as A.
// It writes every step, each transaction's receipt (gas used, price, its signed bytes' length for Base's L1 fee) and the
// helper calls to <out.json>, and exits 0 only when every step held. Nothing here logs a key or the words.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const USAGE = "usage: pool-fork-evm-carry-withdraw.mjs <base|robinhood> <out.json> --slots <n>";
const [CHAIN, OUT] = process.argv.slice(2);
const SLOTS_AT = process.argv.indexOf("--slots");
const SLOTS = SLOTS_AT > 0 && /^\d+$/.test(process.argv[SLOTS_AT + 1] ?? "") ? BigInt(process.argv[SLOTS_AT + 1]) : 0n;
if ((CHAIN !== "base" && CHAIN !== "robinhood") || !OUT || OUT.startsWith("-") || SLOTS <= 0n) {
  console.error(USAGE);
  process.exit(2);
}
const { POOLS_FORK_BLOCKS } = await import("../../../contracts/pool-evm/test/fork-rpc.mjs");
const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? (CHAIN === "base" ? 48701 : 48702));
const ANVIL = `http://127.0.0.1:${ANVIL_PORT}`;
const anvilProc = spawn("anvil", ["--port", String(ANVIL_PORT), "--fork-url", `http://127.0.0.1:${process.env.FORK_RPC_PORT ?? 47545}/${CHAIN}`, "--fork-block-number", String(POOLS_FORK_BLOCKS[CHAIN]), "--slots-in-an-epoch", String(SLOTS), "--no-storage-caching", "--silent"], { stdio: "inherit" });
process.on("exit", () => anvilProc.kill());
const t0 = Date.now();
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const log = (step, o) => console.log(`${new Date().toISOString()} +${((Date.now() - t0) / 1000).toFixed(1)}s ${step}: ${JSON.stringify(o ?? {}, big)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => `0x${BigInt(n).toString(16)}`;

// the sends, counted where they leave: the page's raw sends (through this fetch) and the helper sender's (its providers)
const sent = { page: 0, helper: 0, dropped: 0 };
const sends = () => sent.page + sent.helper;
let losing = false;
const realFetch = globalThis.fetch;
const route = { fork: new Set(), helper: new Set(), local: null };
const refused = new Map();
// while `tracing`, each chain read the page makes and what it answered (method, its error or the answer's first bytes):
// the record of a step that stopped, where the page's own cause names no message (pool-sell.ts legCause)
let tracing = null;
const traced = (host, init, res) => {
  if (tracing === null) return res;
  const at = Date.now() - t0;
  let req = null;
  try {
    req = JSON.parse(String(init?.body ?? "null"));
  } catch {}
  const methods = (Array.isArray(req) ? req : [req]).map((r) => `${r?.method}${r?.method === "eth_call" ? ` ${String(r?.params?.[0]?.data ?? "").slice(0, 10)}` : ""}`);
  // the reads that failed only: an HTTP error, or a JSON-RPC error in the answer
  res.clone().text().then((t) => (res.status !== 200 || /"error"/.test(t)) && keep({ at, host, methods, status: res.status, answer: t.slice(0, 240) }), () => {});
  return res;
};
// and, while tracing, each error whose stack is read (the page's legCause reads it): its message, which the cause leaves out
const keep = (x) => tracing !== null && tracing.length < 2000 && tracing.push(x);
// (undici's own socket errors, thrown and caught inside fetch, are left out: 800 of base5's 825 entries)
Error.prepareStackTrace = (err, frames) => {
  if (!String(frames[0] ?? "").includes("internal/deps/undici")) keep({ at: Date.now() - t0, thrown: `${err?.name}: ${String(err?.message).slice(0, 300)}`, frames: frames.slice(0, 5).map(String) });
  return `${err?.name}: ${err?.message}\n${frames.map((f) => `    at ${f}`).join("\n")}`;
};
// every request the page sends a pool host, by host and time (the windows around the landing, the ready step)
const hostSends = [];
// card evm-first-proof-inside-ten-seconds: the first leaf's proof ready inside READY_MS of its block, and each pool host
// sent at most HOST_WINDOW_BOUND requests (each of a batch counted) in any 10 s window from 10 s before that block to the
// proof. The reads go from the page to the pool's public providers on the deposit's lane, which has no budget: the
// copies of 13 Nov measured 58 to 74. HOST_WINDOW_BOUND is a regression guard on the page's own pattern (a change that
// sends a host more fails the copy), never a provider's limit: what a provider takes is read by sending it the window
// as sent, its times and batches (scripts/evm-landing-replay.mjs, review of 584af1495, P3-2)
const READY_MS = 10_000;
const HOST_WINDOW_BOUND = 80;
/** A request body's method (an eth_call's selector beside it), each of a batch. */
const methodsOf = (body) => {
  try {
    const b = JSON.parse(String(body));
    return (Array.isArray(b) ? b : [b]).map((x) => ({ m: x?.method === "eth_call" ? `eth_call ${String(x.params?.[0]?.data ?? "").slice(0, 10)}` : String(x?.method), from: x?.method === "eth_getLogs" ? x.params?.[0]?.fromBlock : undefined }));
  } catch {
    return [{ m: "?" }];
  }
};
/** Per host, the most requests sent from `from` to `to` (the landing's: never one sent after the ready proof, such as
 *  the withdraw tapped next) in any HOST_WINDOW_MS (10 s) window, with its start (ms after `zero`) and its requests by
 *  method. */
const windowMax = (from, to, zero) => {
  const out = {};
  for (const h of new Set(hostSends.map((x) => x.host))) {
    const xs = hostSends.filter((x) => x.host === h && x.at >= from && x.at <= to).sort((a, b) => a.at - b.at);
    let best = { n: 0, i: 0, j: -1 };
    for (let i = 0, j = 0; j < xs.length; j++) {
      while (xs[j].at - xs[i].at >= 10_000) i++;
      if (j - i + 1 > best.n) best = { n: j - i + 1, i, j };
    }
    const by = {};
    for (const x of xs.slice(best.i, best.j + 1)) by[x.m] = (by[x.m] ?? 0) + 1;
    out[h] = { n: best.n, fromMs: best.n === 0 ? null : xs[best.i].at - zero, by };
  }
  return out;
};
// a state read at a block older than its host keeps, refused as that host refuses it (anvil keeps every block's state):
// a read-only probe of 13 Nov 07:50Z (eth_call by block hash at blocks 0 to 80 s old, on every pool and fee provider of
// both chains) found one: robinhood-rpc.publicnode.com, HTTP 403 "Archive requests require a personal token" from 12 s
// back (6 s answered); every other provider answered at 80 s (Base) and 44 s (Robinhood)
const STATE_KEPT_MS = new Map([["robinhood-rpc.publicnode.com", 10_000]]);
const STATE_METHODS = new Set(["eth_call", "eth_getBalance", "eth_getTransactionCount", "eth_getCode", "eth_getStorageAt", "eth_estimateGas"]);
const stateRefused = [];
/** The oldest block a request's state reads name, its age (ms) behind the head; null for none (a tag, or no block). */
const stateAgeOf = async (body) => {
  let calls;
  try {
    const b = JSON.parse(String(body));
    calls = Array.isArray(b) ? b : [b];
  } catch {
    return null;
  }
  let most = null;
  for (const c of calls) {
    if (!STATE_METHODS.has(c?.method)) continue;
    const at = c.params?.at(-1);
    const byHash = typeof at === "object" && at !== null && typeof at.blockHash === "string" ? at.blockHash : null;
    const byNumber = typeof at === "string" && at.startsWith("0x") ? at : typeof at?.blockNumber === "string" ? at.blockNumber : null;
    if (byHash === null && byNumber === null) continue;
    const blk = byHash !== null ? await anvil("eth_getBlockByHash", [byHash, false]) : await anvil("eth_getBlockByNumber", [byNumber, false]);
    const top = await anvil("eth_getBlockByNumber", ["latest", false]);
    if (!blk || !top) continue;
    const age = (Number(BigInt(top.timestamp)) - Number(BigInt(blk.timestamp))) * 1000;
    if (most === null || age > most.age) most = { age, m: c.method === "eth_call" ? `eth_call ${String(c.params?.[0]?.data ?? "").slice(0, 10)}` : c.method, id: c.id };
  }
  return most;
};
// review of 584af1495, P2-2: the providers as the page meets them, not one local anvil.
// - CT_HOST_DELAYS_FILE (scripts/evm-host-delays.mjs, measured read-only from the real providers): each request a host
//   answers waits that host's median answer time for its kind (a log page, a view, else a block), a batch its slowest
//   kind's; a host or kind with no figure waits the chain's median of every figure. Recorded in the run.
// - CT_LAG_HOST: that host serves the head one block behind ("latest" in a request's params is the block before the
//   head, and eth_blockNumber answers it), as a seat a block behind its pair does.
const HOST_DELAYS = process.env.CT_HOST_DELAYS_FILE ? JSON.parse(readFileSync(process.env.CT_HOST_DELAYS_FILE, "utf8")) : null;
const LAG_HOST = process.env.CT_LAG_HOST ?? null;
const delayFigures = HOST_DELAYS === null ? [] : Object.values(HOST_DELAYS.hosts).flatMap((h) => [h.block, h.call, h.logs]).filter((x) => typeof x === "number").sort((a, b) => a - b);
const DELAY_MEDIAN = delayFigures.length === 0 ? 0 : delayFigures[Math.floor((delayFigures.length - 1) / 2)];
const delayKind = (m) => (m === "eth_getLogs" ? "logs" : m.startsWith("eth_call") || m === "eth_estimateGas" ? "call" : "block");
const delayOf = (host, ms) => (HOST_DELAYS === null ? 0 : Math.max(0, ...ms.map(({ m }) => HOST_DELAYS.hosts[host]?.[delayKind(m)] ?? DELAY_MEDIAN)));
/** `body` as LAG_HOST serves it: "latest" the block before the head. */
const lagged = async (body) => {
  const behind = hex(BigInt((await head()).number) - 1n);
  const b = JSON.parse(String(body));
  const one = (c) => ({ ...c, params: Array.isArray(c?.params) ? JSON.parse(JSON.stringify(c.params).replaceAll('"latest"', JSON.stringify(behind))) : c?.params });
  return { body: JSON.stringify(Array.isArray(b) ? b.map(one) : one(b)), behind };
};
let batches = 0;
globalThis.fetch = async (input, init) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  if (u.origin === ANVIL || (route.local !== null && u.origin === route.local)) return realFetch(input, init);
  if (route.fork.has(u.host)) {
    const batch = ++batches;
    const ms = methodsOf(init?.body);
    for (const { m, from } of ms) hostSends.push({ host: u.host, at: Date.now(), m, from, batch });
    const wait = delayOf(u.host, ms);
    if (wait > 0) await sleep(wait);
    const kept = STATE_KEPT_MS.get(u.host);
    const old = kept === undefined ? null : await stateAgeOf(init?.body);
    if (old !== null && old.age > kept) {
      stateRefused.push({ host: u.host, at: Date.now(), m: old.m, ageMs: old.age });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: old.id ?? null, error: { code: -32602, message: "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode" } }), { status: 403, headers: { "content-type": "application/json" } });
    }
    if (typeof init?.body === "string" && init.body.includes("eth_sendRawTransaction")) {
      if (losing) {
        sent.dropped++;
        throw new TypeError("fetch failed");
      }
      sent.page++;
    }
    if (LAG_HOST === u.host && typeof init?.body === "string") {
      const l = await lagged(init.body);
      const res = await realFetch(ANVIL, { ...init, body: l.body });
      const j = await res.json();
      const asked = JSON.parse(l.body);
      const fix = (a, q) => (q?.method === "eth_blockNumber" && typeof a?.result === "string" ? { ...a, result: l.behind } : a);
      const out = Array.isArray(j) ? j.map((a) => fix(a, (Array.isArray(asked) ? asked : [asked]).find((q) => String(q.id) === String(a?.id)))) : fix(j, asked);
      return traced(u.host, init, new Response(JSON.stringify(out), { status: res.status, headers: { "content-type": "application/json" } }));
    }
    return traced(u.host, init, await realFetch(ANVIL, init));
  }
  if (route.helper.has(u.origin)) return traced(`helper${u.pathname}`, init, await realFetch(`${route.local}${u.pathname}${u.search}`, init));
  if (!refused.has(u.host)) log("refused host", { host: u.host, path: u.pathname });
  refused.set(u.host, (refused.get(u.host) ?? 0) + 1);
  throw new Error(`pool-fork-evm-carry-withdraw: no request past the fork (${u.host})`);
};

const { entropyToWords, wordsToSeed64 } = await import("../../wallet/src/derive/index.ts");
const { evmAddress } = await import("../../wallet/src/derive/keys.ts");
const { depositKey, depositRecordOf, openWalletStore } = await import("../../wallet/src/store/index.ts");
const { openNoteStore, readNotes } = await import("../../wallet/src/notes/store.ts");
const { writeRestored } = await import("../../wallet/src/notes/restore.ts");
const { EVM_CHAIN_IDS, EVM_EPOCH_MS, EVM_LADDER, EVM_POOLS, evmPoolScopeOf, evmTreeSync } = await import("../../wallet/src/pool/evm.ts");
const { PoolNoLeafError } = await import("../../wallet/src/pool/pool.ts");
const { evmRestoreNotes } = await import("../../wallet/src/pool/evm-restore.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { evmPoolVenues } = await import("../../kit/src/trade/evm/buy-unpinned.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { MAINNET_EVM_FEE_RPCS, MAINNET_POOL_HISTORY, MAINNET_POOL_RPCS, pageEvmHold, pageEvmPoolRpcs, pageEvmWalletRpc, testnetPool, testnetPoolDeps } = await import("../src/pool-testnet.ts");
const { depositToEnd, evmQuoteRoute, followPoolQuote, uxNoteLanded, uxNoteOpen } = await import("../src/pool-deposit-follow.ts");
const { readEvmPoolFloor } = await import("../src/pool-deposit-address.ts");
const { depositNamer } = await import("../src/deposit-name.ts");
const { restoreUxOf } = await import("../src/pool-restore.ts");
const { checkPoolAmount, checkPoolTo, parseUnits, poolRefusalWords, poolSendable } = await import("../src/withdraw/pool-form.ts");
const { evmBalancePool, poolBalances } = await import("../../wallet/src/pool/balances.ts");
const { TRADE_HELPER } = await import("../src/trade.ts");
const { handler } = await import("../../../apps/helper/src/server.ts");
const { evmPoolSender } = await import("../../../apps/helper/src/pool/evm.ts");
const { createRpc } = await import("../../../apps/helper/src/rpc/rpc.ts");

if (POOL_TESTNET) throw new Error("this is the mainnet build's run: __SIGN_NETWORK__ must not be set");
const PIN = EVM_POOLS[CHAIN];
if (!PIN) throw new Error(`the mainnet build pins no ${CHAIN} pool`);
const scope = evmPoolScopeOf(PIN.pool, EVM_CHAIN_IDS[CHAIN]);

// the chain's hosts, as the page and the kit name them; a host the other chain also names is refused, never guessed
const urlsIn = (v, out = []) => {
  if (typeof v === "string" && /^https:\/\//.test(v)) out.push(v);
  else if (v && typeof v === "object") for (const x of Object.values(v)) urlsIn(x, out);
  return out;
};
const hostsOf = (c) => new Set([...MAINNET_POOL_RPCS[c], ...MAINNET_EVM_FEE_RPCS[c], ...MAINNET_POOL_HISTORY[c], ...urlsIn(evmPoolVenues()[c])].map((u) => new URL(u).host));
const other = hostsOf(CHAIN === "base" ? "robinhood" : "base");
for (const h of hostsOf(CHAIN)) if (!other.has(h)) route.fork.add(h);

let id = 0;
const anvil = async (method, params) => {
  const j = await (await realFetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json();
  if (j.error) throw new Error(`RPC error ${j.error.code}: ${String(j.error.message).slice(0, 200)}`);
  return j.result;
};
const head = async () => anvil("eth_getBlockByNumber", ["latest", false]);
for (let k = 0; ; k++) {
  try {
    await anvil("eth_chainId", []);
    break;
  } catch (e) {
    if (k >= 60) throw e;
    await sleep(500);
  }
}
// the fork block's base fee, held on every block mined here: anvil lowers it 12.5% a block that is not full, which on a
// chain mined every 2 s drops the device's floor under a top-up read a minute before (the Base run of 12 Nov 23:43Z:
// one wei under the first floor read carried twice)
const BASE_FEE = BigInt((await head()).baseFeePerGas);
// Robinhood's chain fee is ArbGasInfo's getL1BaseFeeEstimate (kit pool-fee.ts), a precompile at 0x...6c that anvil does
// not have: the chain answers eth_getCode 0xfe there, which anvil runs as INVALID (the Robinhood run of 13 Nov 00:24Z:
// "EVM error InvalidFEOpcode" on both stand-ins, the withdraw's bind stopped). The one stand-in: code at 0x...6c that
// returns the chain's own answer, read upstream at the fork block through fork-rpc (kept in its book). The page's reads
// and the fee rule are unchanged; the value is the chain's at the fork block.
if (CHAIN === "robinhood") {
  const ARB_GAS_INFO = "0x000000000000000000000000000000000000006c";
  const r = await (await realFetch(`http://127.0.0.1:${process.env.FORK_RPC_PORT ?? 47545}/robinhood`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: ARB_GAS_INFO, data: "0xf5d6ded7" }, hex(POOLS_FORK_BLOCKS.robinhood)] }) })).json();
  if (!/^0x[0-9a-f]{64}$/i.test(r.result ?? "")) throw new Error(`ArbGasInfo at the fork block: ${JSON.stringify(r)}`);
  // PUSH32 <answer> PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN
  await anvil("anvil_setCode", [ARB_GAS_INFO, `0x7f${r.result.slice(2)}60005260206000f3`]);
  log("robinhood ArbGasInfo stand-in", { l1BaseFeeEstimate: BigInt(r.result).toString(), atBlock: POOLS_FORK_BLOCKS.robinhood });
}
const mineAt = async (ts) => {
  await anvil("anvil_setNextBlockBaseFeePerGas", [hex(BASE_FEE)]);
  await anvil("evm_mine", [hex(ts)]);
};
// finalized and safe trail the head by 2 x slots blocks (pool-fork-evm.sh): mined past it, the last block's time the
// wall clock's, never ahead of it (the 23:43Z run's chain ran ahead of the helper's clock: the device asked the fee of an
// epoch the helper had no block in, 404, and a part's deadline passed early), so it waits for the clock when it must
// one miner at a time: the ticker's block and finalize's run never interleave their timestamps
let mining = Promise.resolve();
const exclusive = (fn) => {
  const run = mining.then(fn);
  mining = run.catch(() => {});
  return run;
};
const finalize = () => exclusive(async () => {
  const h = await head();
  const n = 2 * Number(SLOTS) + 1;
  const ahead = Number(BigInt(h.timestamp)) + n - Math.floor(Date.now() / 1000);
  if (ahead > 0) await sleep(ahead * 1000);
  const start = Math.max(Number(BigInt((await head()).timestamp)) + 1, Math.floor(Date.now() / 1000) - n + 1);
  for (let k = 0; k < n; k++) await mineAt(start + k);
});
await finalize(); // the head at the wall clock, finalized 2 x slots blocks back
// the chain goes on as Base and Robinhood do: a block every 2 s at the wall clock, so each epoch has its first block and
// finalized trails the head by 2 x slots blocks
let ticking = true;
const tick = async () => {
  while (ticking) {
    await sleep(2_000);
    if (!ticking) break;
    try {
      const h = await head();
      const now = Math.floor(Date.now() / 1000);
      // a block in this second unless the chain is already at it (never ahead of the clock)
      if (Number(BigInt(h.timestamp)) < now) await exclusive(async () => (Number(BigInt((await head()).timestamp)) < now ? mineAt(now) : undefined));
    } catch {}
  }
};
const ticker = tick();
const forkHead = await head();
log("fork", { chain: CHAIN, pool: PIN.pool, head: BigInt(forkHead.number), headAgeS: Math.round(Date.now() / 1000 - Number(BigInt(forkHead.timestamp))), forkHosts: [...route.fork], helper: TRADE_HELPER });

// the helper in this process: its own handler, its EVM pool sender on the fork with the published test key
const KEY = new Uint8Array(createHash("sha256").update("helper-pool-senders/test-key/EVM_SENDER").digest());
const sideRpc = async (method, params) => {
  if (method === "eth_sendRawTransaction") sent.helper++;
  return anvil(method, params);
};
// the sender signs with the very bytes it is given (apps/helper/src/pool/evm.ts cfg.senderKey), as the helper's own start
// gives it a buffer it never wipes: wiping KEY here would zero the sender's key ("invalid private key" at its first send)
const sender = evmPoolSender({ network: CHAIN, pool: PIN.pool, senderKey: KEY, feeRecipient: PIN.feeRecipient, log: (line) => log("helper sender", { line }) }, [sideRpc, (m, p) => sideRpc(m, p)]);
await anvil("anvil_setBalance", [sender.sender, "0xde0b6b3a7640000"]);
const rpcRoute = createRpc({ [CHAIN === "base" ? "BASE_RPC_URL" : "ROBINHOOD_RPC_URL"]: ANVIL }, { log: (line) => log("helper rpc", { line }) });
const helperLines = [];
// the helper's handler answers a sender's throw 500 {"error":"internal"} and logs nothing (server.ts .catch): the run
// keeps the throw's message and frames, so a 500 has its cause in the record (the Base run of 13 Nov 00:40Z: no cause)
const senderThrows = [];
const carry = async (body, client) => {
  try {
    return await sender.carry(body, client);
  } catch (e) {
    const t = { atMs: Date.now() - t0, name: e?.name, message: String(e?.message ?? e).slice(0, 600), frames: String(e?.stack ?? "").split("\n").slice(1, 6).map((l) => l.trim()) };
    senderThrows.push(t);
    log("helper sender threw", t);
    throw e;
  }
};
const serve = handler("0".repeat(40), {}, rpcRoute, {}, {}, {}, {}, {}, {}, null, new Map(), new Map([[sender.pool, { ...sender, carry }]]), () => Date.now(), {}, {}, () => true, Promise.resolve(), () => ({}), { count: () => {} }, {}, undefined, (line) => (helperLines.push(line), log("helper", { line })));
// the helper's answers this run plants: `down503` POST /v1/pool/evm/send answered 503 before the handler sees them
const plant = { down503: 0 };
const helperCalls = [];
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const call = { atMs: Date.now() - t0, verb: req.method, path, planted: plant.down503 > 0 && path === "/v1/pool/evm/send", status: null, body: null };
  helperCalls.push(call);
  const end = res.end.bind(res);
  res.end = (chunk, ...rest) => {
    call.status = res.statusCode;
    if (path !== "/v1/rpc/" + CHAIN) call.body = chunk === undefined ? null : String(chunk).slice(0, 4000);
    return end(chunk, ...rest);
  };
  if (plant.down503 > 0 && req.method === "POST" && path === "/v1/pool/evm/send") {
    plant.down503--;
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { code: "down" } }));
  }
  return serve(req, res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
route.local = `http://127.0.0.1:${server.address().port}`;
route.helper.add(new URL(TRADE_HELPER).origin);
const walletRpcUrl = pageEvmWalletRpc(CHAIN)?.url;
if (!walletRpcUrl) throw new Error("the mainnet build has no U_X reader on the helper");
route.helper.add(new URL(walletRpcUrl).origin);
log("helper", { local: route.local, sender: sender.sender, pool: sender.pool, walletReader: walletRpcUrl });

// the prover: snarkjs's fullProve in this process, on the release's pinned withdraw files
const KIT_ZK = new URL("../../kit/zk/", import.meta.url);
const file = (name) => {
  const b = readFileSync(new URL(name, KIT_ZK));
  if (createHash("sha256").update(b).digest("hex") !== ZK_SETUP_FILES[name].sha256) throw new Error(`${name}: not the pinned setup file`);
  return new Uint8Array(b);
};
const WASM = file("withdraw.wasm");
const ZKEY = file("withdraw.zkey");
const snarkjs = createRequire(new URL("../../kit/package.json", import.meta.url))("snarkjs");
const vault = {
  load: async () => {},
  prove: async (circuit, input) => {
    if (circuit !== "withdraw") throw new Error(`no ${circuit} prover here`);
    const s = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY, undefined, undefined, { singleThread: true });
    const ms = Math.round(performance.now() - s);
    log("proved", { ms });
    return { proof, publicSignals, proveMs: ms };
  },
};

const ENTROPY = new Uint8Array(16); // the all-zero test vector
const seed64 = wordsToSeed64(entropyToWords(ENTROPY));
const profile = async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: Date.now() });
  return { w, ns: await openNoteStore(w) };
};
const mine = async (w) => (await readNotes(w)).filter((n) => n.scope === scope);
const LIVE = ["UNSPENT", "HELD", "RESERVED"];
const balanceOf = async (w) => (await mine(w)).filter((n) => LIVE.includes(n.state)).reduce((s, n) => s + n.leaf.value, 0n);
const statesOf = async (w) => (await mine(w)).map((n) => ({ ref: n.ref.kind, i: n.ref.i ?? null, state: n.state, value: n.leaf?.value ?? null }));
const restoreInto = async (ns) => {
  const r = await evmRestoreNotes({ seed64: seed64.slice(), pin: PIN, rpcs: pageEvmPoolRpcs(CHAIN), wallets: false });
  await writeRestored(ns, r);
  return r;
};

// what the record was made by: the commit the run ran on and this script's own bytes, so a record names the code it holds
// for; the fork block and the book its answers were recorded into (fork-rpc.mjs FORK_RPC_BOOK_FILE), to replay it offline
const SCRIPT = new URL(import.meta.url);
const run = { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "", scriptSha256: createHash("sha256").update(readFileSync(SCRIPT)).digest("hex"), forkBlock: POOLS_FORK_BLOCKS[CHAIN], book: process.env.FORK_RPC_BOOK_FILE ?? null };
const record = { by: "packages/signpage/scripts/pool-fork-evm-carry-withdraw.mjs", run, providers: { delays: HOST_DELAYS, delayMedianMs: DELAY_MEDIAN, lagHost: LAG_HOST, intoMs: Number(process.env.CT_DEPOSIT_INTO_MS ?? 0), heldNote: process.env.CT_HELD_NOTE === "1" }, chain: CHAIN, pool: PIN.pool, anvil: ANVIL, slots: SLOTS, helperSender: sender.sender, steps: [], txs: [], helperCalls, helperLines, refusedHosts: {} };
const failures = [];
const step = (name, o, ok) => {
  record.steps.push({ name, atMs: Date.now() - t0, ok, ...o });
  log(name, { ok, ...o });
  if (!ok) failures.push(name);
};
const txHashes = new Map(); // hash -> what it was
const finish = async (code) => {
  for (const [hash, what] of txHashes) {
    const [rc, tx, raw] = await Promise.all([anvil("eth_getTransactionReceipt", [hash]), anvil("eth_getTransactionByHash", [hash]), anvil("eth_getRawTransactionByHash", [hash]).catch(() => null)]);
    record.txs.push({ what, hash, from: tx?.from, to: tx?.to, value: tx?.value ? BigInt(tx.value) : null, block: rc?.blockNumber ? BigInt(rc.blockNumber) : null, status: rc?.status ?? null, gasUsed: rc?.gasUsed ? BigInt(rc.gasUsed) : null, effectiveGasPrice: rc?.effectiveGasPrice ? BigInt(rc.effectiveGasPrice) : null, signedBytes: typeof raw === "string" ? (raw.length - 2) / 2 : null });
  }
  record.refusedHosts = Object.fromEntries(refused);
  record.sent = { ...sent };
  ticking = false;
  await ticker;
  // every transaction the run sent succeeded on the fork
  const bad = record.txs.filter((x) => x.status !== "0x1");
  if (bad.length > 0) failures.push(`transactions not 0x1: ${bad.map((x) => `${x.what} ${x.hash} ${x.status}`).join(", ")}`);
  record.failures = failures;
  record.senderThrows = senderThrows;
  record.tapWaitMs = tapWaitMs;
  record.plannedAs = plannedAs;
  writeFileSync(OUT, JSON.stringify(record, big, 2) + "\n");
  log("wrote", { out: OUT, failures, txs: record.txs.map((t) => [t.what, t.status, t.gasUsed]) });
  seed64.fill(0);
  server.close();
  process.exit(code);
};
const guard = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    step(name, { threw: String(e?.message ?? e).slice(0, 300) }, false);
    await finish(1);
  }
};

const page = (w) => ({ store: async () => w, held: async () => w, seed64: async () => seed64.slice(), openWithdraw: () => ({ result: { pending: true }, then: () => {} }) });
const poolOn = (w) => testnetPool(page(w), { prover: { vault, stop: () => {} } });

// 1. device A: the restore, then U_X named
const A = await profile();
const t = poolOn(A.w);
// the page's state reads in the carry and the first-leaf watch at the page's own pace: a read at each change the page
// pushes (its watch: a proof made, a record written; many changes while one read runs make one more, as src/api.ts
// host.watch) and at each stage of the deposit the app is shown (the app asks state for what it shows), never on a timer
// (the page has none: src/api.ts, main.ts state). A timer of 500 ms, then 5 s, ran the settle round far past that pace
let pushReads = 0;
let pushRunning = null;
let pushAgain = false;
const pushRead = () => {
  if (pushRunning !== null) return void (pushAgain = true);
  pushReads++;
  pushRunning = t.stateRead().catch(() => {}).finally(() => {
    pushRunning = null;
    if (pushAgain) (pushAgain = false), pushRead();
  });
};
t.watch(pushRead);
const kinds = poolKinds(testnetPoolDeps(t.flow));
await guard("restore A", async () => {
  const s = Date.now();
  const r = await restoreInto(A.ns);
  const bal = await balanceOf(A.w);
  step("restore A", { ms: Date.now() - s, block: r.block, notes: await statesOf(A.w), balance: bal }, true);
});
// review of 584af1495, P2-2, CT_HELD_NOTE=1: a note of this device already in the pool and ready when the measured
// deposit lands, so the queue's pass holds the period's fee and the landing's pass binds on that held fee (the chain's
// one fee hold, pool-testnet.ts evmFeeHoldOf): a first U_X named and funded to the floor, its rung carried by the
// page's own deposit from U_X (the follow's deposit), and its proof ready; the measured deposit is then the pool's
// second leaf, and the run ends after its ready steps
const HELD = process.env.CT_HELD_NOTE === "1";
if (HELD) await guard("held note", async () => {
  const s0 = Date.now();
  const namer0 = depositNamer({ top: true, scope: () => null, pools: () => [{ chain: CHAIN, scope }], open: async () => A.w, startup: async () => {}, resyncing: () => null });
  namer0.name(ENTROPY.slice());
  await namer0.named();
  const r0 = depositRecordOf(await A.w.get("meta", depositKey(scope)));
  const fl = await readEvmPoolFloor(pageEvmPoolRpcs(CHAIN), PIN);
  await anvil("anvil_setBalance", [r0.evm, hex(fl)]);
  t.evmPoolOf(CHAIN);
  const end = await depositToEnd((p, ctx) => t.depositFrom(p, { s: scope, i: r0.index, u: r0.evm }, ctx), CHAIN, 18, EVM_LADDER.min, new AbortController().signal);
  for (const x of end.txs ?? []) if (typeof x?.hash === "string") txHashes.set(x.hash, "held note deposit");
  let ready = null;
  for (let k = 0; k < 900 && ready === null; k++) {
    const r = await t.readyWith(async () => null).catch(() => ({ ready: [] }));
    const mineNow = await mine(A.w);
    ready = (r.ready ?? []).find((q) => mineNow.some((n) => n.id === q.noteId && n.ref.kind === "deposit" && n.ref.i === r0.index)) ?? null;
    if (ready === null) await sleep(100);
  }
  step("held note", { index: r0.index, end: end.end, ms: Date.now() - s0, readyRoot: ready?.root ?? null, poolSize: Number(BigInt(await anvil("eth_call", [{ to: PIN.pool, data: "0xa8f0f95a" }, "latest"]))) }, (end.end === "filled" || end.end === "part_filled") && ready !== null);
});
const ux = await guard("U_X named", async () => {
  const namer = depositNamer({ top: true, scope: () => null, pools: () => [{ chain: CHAIN, scope }], open: async () => A.w, startup: async () => {}, resyncing: () => null });
  namer.name(ENTROPY.slice());
  await namer.named();
  const rec = depositRecordOf(await A.w.get("meta", depositKey(scope)));
  // a U_X no note of the store has deposited from yet (the device's lane decides its index)
  const used = (await mine(A.w)).some((n) => n.ref.kind === "deposit" && n.ref.i === rec?.index && n.state !== "PLANNED");
  step("U_X named", { index: rec?.index, u: rec?.evm, refundId: rec?.id }, typeof rec?.evm === "string" && !used);
  return rec;
});
const floor = await readEvmPoolFloor(pageEvmPoolRpcs(CHAIN), PIN);
log("floor", { floor, ladderMin: EVM_LADDER.min });

// 2. refused, 0 sent: a pool.deposit under the least rung
await guard("under the least rung", async () => {
  const before = sends();
  const units = (v) => (Number(v) / 1e18).toFixed(18).replace(/0+$/, "");
  const r = kinds["pool.deposit"]({ chain: CHAIN, amount: units(EVM_LADDER.min - EVM_LADDER.one) }, { id: "under", sha: "00", progress: () => {} });
  if ("after" in r) await r.after;
  const answer = "after" in r ? r.answer() : r;
  step("under the least rung", { answer, sent: sends() - before }, sends() === before && (answer === null || "error" in answer || !["filled", "part_filled", "sent"].includes(answer?.result?.stage)));
});

// 3 and 4. the follow of U_X: one wei under the floor carries nothing; topped up to the floor it carries the rung
// the quote's deadline already past: the carry step reads the follow's end (in_pool read on past the deadline, as the
// page ends a follow), which a future deadline would hold open past the run; no other step reads the deadline
const f = { chain: CHAIN, s: scope.toString(), i: ux.index, u: ux.evm, refund_id: ux.id, address: "0x" + "00".repeat(20), deadline_ms: Date.now() - 1_000, origin: "nep141:base.omft.near", min_out: floor.toString() };
// when the page is first asked for the pool (the warm read of its history starts then: pool-testnet.ts evmWarm)
let poolOfFirstMs = null;
const evmRoute = evmQuoteRoute({ network: "mainnet", pool: (c) => ((poolOfFirstMs ??= Date.now()), t.evmPoolOf(c)), wallet: (c) => pageEvmWalletRpc(c), notes: () => readNotes(A.w) });
const depositFromUx = (g, amount, signal) => depositToEnd((p, ctx) => t.depositFrom(p, { s: BigInt(g.s), i: g.i, u: g.u }, ctx), g.chain, 18, amount, signal);
const noRefund = Object.assign(async () => "none", { settle: async () => true });
const d = evmRoute.deps(CHAIN, depositFromUx, () => noRefund);
if (d === null) throw new Error("the mainnet build has no follow route for this chain");
const stages = [];
const stageAt = {};
const carried = [];
const follows = new AbortController();
let rounds = 0;
const deps = {
  ...d,
  status: async () => ({ status: "SUCCESS" }), // 1Click's word once it delivered: played here
  noted: async (g) => uxNoteLanded(await readNotes(A.w), g),
  open: async (g) => uxNoteOpen(await readNotes(A.w), g),
  stage: async (s) => void (stages.push(s), (stageAt[s] ??= Date.now()), log("follow stage", { stage: s }), pushRead()),
  txs: async (x) => void carried.push(...x),
  signal: follows.signal,
  // the page's own pace (pool-deposit-follow.ts: 2 s while 1Click's word is SUCCESS, as played here, then 15 s doubling to
  // 60 s once in_pool). A 1 s cap before in_pool (card evm-first-proof-inside-ten-seconds) read the floor's fee oracle
  // and pool every second on the pool's two hosts, twice the page's own rate, so the window before the landing held
  // reads the page never makes
  sleep: (ms, sg) => (rounds++, new Promise((r) => { const k = setTimeout(r, ms); sg.addEventListener("abort", () => (clearTimeout(k), r()), { once: true }); })),
};
await anvil("anvil_setBalance", [ux.evm, hex(floor - 1n)]);
const beforeUnder = sends();
const followRun = followPoolQuote(f, deps, "quote_checked");
for (let k = 0; k < 40 && rounds < 4; k++) await sleep(500);
step("U_X one wei under the floor", { rounds, sent: sends() - beforeUnder, stages: [...stages], uxBalance: BigInt(await anvil("eth_getBalance", [ux.evm, "latest"])) }, sends() === beforeUnder && !stages.includes("in_pool"));

// the withdraw screen: pool.withdraw opens it, its funds read for To, its two fields checked as the screen checks them
const toKey = keccak_256(Uint8Array.from([...seed64, ...new TextEncoder().encode("withdraw-to")]));
const TO = evmAddress(secp256k1.getPublicKey(toKey, false));
toKey.fill(0);
const toBalance = async () => BigInt(await anvil("eth_getBalance", [TO, "latest"]));
// a tap after a withdraw waits, as the user would, for the change note the screen can spend (its leaf's block final):
// the safe block mined and the page's state read, at most 30 rounds; the wait is kept per op
const tapWaitMs = {};
// the taps whose fixed amount was asked as the screen's nearest lower one (op -> the amount, below and above)
const plannedAs = {};
const fmt18 = (w) => { const x = w.toString().padStart(19, "0"); return `${x.slice(0, -18)}.${x.slice(-18)}`.replace(/\.?0+$/, ""); };
const tap = async (pool, op, amount) => {
  const w0 = Date.now();
  const want = parseUnits(amount, 18);
  for (let k = 0; k < 30 && !(await mine(A.w)).some((n) => (n.state === "UNSPENT" || n.state === "HELD") && n.leaf.value > want); k++) {
    await finalize();
    await pool.stateRead().catch(() => {});
  }
  tapWaitMs[op] = Date.now() - w0;
  pool.flow({ kind: "pool.withdraw", chain: CHAIN, token: null, amount: 0n, slippageBps: 0, decimals: 18 }, { id: op, sha: "00", progress: () => {} });
  const wd = pool.withdrawDeps(CHAIN, op);
  const to = checkPoolTo(CHAIN, TO, wd.keys);
  if (!to.ok) throw new Error("To refused by the screen");
  const funds = await wd.funds(to.to);
  let m = checkPoolAmount(CHAIN, amount, funds);
  // a fixed amount the notes cannot make whole (the fees at the fork block set the notes' values: Robinhood run 7's one
  // note of 2.887e14 made 7.8e13 or 2.18e14, not 1e14) is asked as the nearest lower amount the screen offers for it
  if (!m.ok && m.code === "unplannable" && typeof m.below === "bigint" && m.below > 0n) {
    plannedAs[op] = { asked: amount, below: m.below, above: m.above ?? null };
    m = checkPoolAmount(CHAIN, fmt18(m.below), funds);
  }
  if (!m.ok) throw new Error(`the amount is refused: ${JSON.stringify(m, big)}`);
  if (typeof wd.handoff !== "function") throw new Error("the screen has no run for this chain");
  const ready = { chain: CHAIN, to: to.to, amount: m.amount, maxFee: m.maxFee };
  await pool.withdraw(ready, op);
  return ready;
};
const opOf = async (op) => ({ op: (await A.w.get("ops", op)) ?? null, owed: (await A.w.get("meta", `owed/${op}`)) ?? null });
const txsOf = (o, what) => {
  for (const x of o?.txs ?? []) if (!txHashes.has(x.hash)) txHashes.set(x.hash, what);
};
// the page's state reads, the safe block mined past each send, until the op ends sent (or, with endOnStop, stopped);
// each round is one finalize (it waits 2 x slots + 1 s for the clock) and a second, so an end is seen within ~12 s of it
const seenAt = {};
const readUntilSent = async (pools, op, { endOnStop = false } = {}) => {
  for (let k = 0; k < 40; k++) {
    const stage = (await A.w.get("ops", op))?.stage;
    if (stage === "sent" || (endOnStop && stage === "stopped")) break;
    await finalize();
    await Promise.all(pools.map((p) => p.stateRead()));
    await sleep(1_000);
  }
  const stage = (await A.w.get("ops", op))?.stage;
  seenAt[op] = { stage, wallMs: Date.now() };
  return stage;
};
// the pool's leaf count at a block (State.sol currentTreeSize), and LeanIMT's depth for it (wallet pool/evm.ts depthOf)
const SIZE_SEL = "0x" + Buffer.from(keccak_256(new TextEncoder().encode("currentTreeSize()"))).toString("hex").slice(0, 8);
const poolSize = async (tag = "latest") => Number(BigInt(await anvil("eth_call", [{ to: PIN.pool, data: SIZE_SEL }, tag])));
const depthOfSize = (n) => { let d = 0; while (2 ** d < n) d++; return d; };
const chainMs = async () => Number(BigInt((await head()).timestamp)) * 1000;
const EPOCH = Number(EVM_EPOCH_MS);
const epochOf = (ms) => ms - (ms % EPOCH);

// the deposit as the pool's first leaf, in an epoch's first seconds (the chain's blocks run at the wall clock), so the
// ready proof and the withdraw below fall inside the deposit's own minute
// CT_DEPOSIT_INTO_MS (card evm-first-proof-inside-ten-seconds): the carry that many ms into an epoch instead (a landing
// mid-period, its period's first block then older than a host above keeps)
const sizeBefore = await poolSize();
const INTO_MS = Number(process.env.CT_DEPOSIT_INTO_MS ?? 0);
const into = Date.now() % EPOCH;
if (into < INTO_MS || into > INTO_MS + 1_000) await sleep(((INTO_MS - into + EPOCH) % EPOCH) + 250);
const carryAt = Date.now();
// CT_TRACE=1: every failed chain read and every error read from the carry to the ready proof, kept in the ready step
// (landingTrace), so a slow landing names what it waited on
if (process.env.CT_TRACE === "1") tracing = [];
const balanceBefore = await balanceOf(A.w);
await anvil("anvil_setBalance", [ux.evm, hex(floor)]);
let shownMs = null;
// the page's ready proofs watched from the carry on, every 100 ms (its queue's own view: no request), so the first
// leaf's is timed when it is made, not when the carry's wait below ends
const readyAt = new Map();
let watching = true;
const watch = (async () => {
  while (watching) {
    const { ready } = await t.readyWith(async () => null).catch(() => ({ ready: [] }));
    for (const p of ready ?? []) if (!readyAt.has(p.noteId)) readyAt.set(p.noteId, { at: Date.now(), p });
    await sleep(100);
  }
})();
// the deposit's block is left to the chain's own pace (the ticker's block every 2 s; finalized 2 x slots blocks back),
// as on Base and Robinhood, whose blocks go on while a block waits to be final. A finalize here (card
// evm-first-proof-inside-ten-seconds) held the miner up to 2 x slots + 1 s for the clock at the send: no block past the
// deposit's for 11 s, which no chain does, so the landing's pass met no newer block for its cut
for (let k = 0; k < 240 && shownMs === null; k++) {
  await sleep(500);
  if ((await balanceOf(A.w)) >= balanceBefore + EVM_LADDER.min) shownMs = Date.now() - carryAt;
}

// the first leaf's first minute: the page's state shows a ready proof for it (read, no tap), then a withdraw tapped
// inside the same minute ends sent (before the typed no-leaf cut: "no leaf before", stopped)
const depNote = (await mine(A.w)).find((n) => n.ref.kind === "deposit" && n.ref.i === ux.index && n.leaf !== undefined);
const depHash = carried[0]?.hash ?? depNote?.evmSends?.[0]?.hash;
const depRc = depHash === undefined ? null : await anvil("eth_getTransactionReceipt", [depHash]);
const depAtMs = depRc === null ? null : Number(BigInt((await anvil("eth_getBlockByNumber", [depRc.blockNumber, false])).timestamp)) * 1000;
const sizeAtDep = depRc === null ? null : await poolSize(depRc.blockNumber);
const first = { sizeBefore, depositBlock: depRc ? BigInt(depRc.blockNumber) : null, depositAtMs: depAtMs, depositEpochStartMs: depAtMs === null ? null : epochOf(depAtMs), sizeAtDeposit: sizeAtDep };
// the part's tree reads, as pool-withdraw-evm.ts makes them, on the wallet's own sync over the pool's two RPCs (the fork,
// each URL kept, read directly), after the send so the tap is not held: the epoch cut at the tap's epoch start, refused
// as no leaf (PoolNoLeafError code no_leaf), then the newest root; and the state root the release bound (its proof's
// public signal 3, read from its calldata: withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),
// uint256,bytes), the signals words 9 to 16), which must be the pool's own root at the deposit block: the newest root at
// the part's time, its one leaf (the newest read here comes after the send, the change leaf in it: kept as read)
const ROOT_SEL = "0x" + Buffer.from(keccak_256(new TextEncoder().encode("currentRoot()"))).toString("hex").slice(0, 8);
const noLeafRead = async (op, cutMs) => {
  const direct = (url) => Object.assign((m, p) => anvil(m, p), { url });
  const sync = evmTreeSync({ rpcs: MAINNET_POOL_RPCS[CHAIN].map(direct), pin: PIN, held: pageEvmHold(PIN, async () => A.w) });
  const cut = await sync.trees(BigInt(cutMs)).then(() => "a leaf", (e) => (e instanceof PoolNoLeafError ? e.code : `${e?.name}: ${String(e?.message).slice(0, 160)}`));
  const newest = await sync.trees(BigInt(await chainMs()) + 1n, undefined, { newest: true }).catch(() => null);
  let boundStateRoot = null;
  for (const x of op?.txs ?? []) {
    const tx = await anvil("eth_getTransactionByHash", [x.hash]);
    if (tx?.to?.toLowerCase() !== PIN.pool.toLowerCase() || typeof tx.input !== "string") continue;
    boundStateRoot = BigInt("0x" + tx.input.slice(10 + 64 * 12, 10 + 64 * 13));
  }
  const poolRootAtDeposit = depRc === null ? null : BigInt(await anvil("eth_call", [{ to: PIN.pool, data: ROOT_SEL }, depRc.blockNumber]));
  return { cut, cutMs, newestAfterSendStateRoot: newest?.stateRoot ?? null, newestAfterSendSize: newest?.stateTree.size ?? null, boundStateRoot, poolRootAtDeposit };
};
await guard("first leaf: a ready proof inside its first minute", async () => {
  let found = null;
  let reads = 0;
  while (found === null && depAtMs !== null && depNote !== undefined && Date.now() < depAtMs + 50_000) {
    reads++;
    found = readyAt.get(depNote.id)?.p ?? null;
    if (found === null) await sleep(100);
  }
  watching = false;
  await watch;
  const at = found === null ? Date.now() : readyAt.get(depNote.id).at;
  const windows = depAtMs === null ? null : windowMax(depAtMs - 10_000, at, depAtMs);
  const deployPages = depAtMs === null ? null : hostSends.filter((x) => x.m === "eth_getLogs" && x.from !== undefined && BigInt(x.from) === PIN.fromBlock && x.at > depAtMs - 10_000 && x.at <= at).length;
  step("first leaf: a ready proof inside its first minute", { ...first, reads, pushReads, hostWindowMax: windows, deployPages, poolOfFirstMs: poolOfFirstMs === null || depAtMs === null ? null : poolOfFirstMs - depAtMs, readyMsAfterDeposit: found === null ? null : at - depAtMs, root: found?.root ?? null, proofEpochStartMs: found?.epochStartMs ?? null, deadlineMs: found?.deadlineMs ?? null }, found !== null && sizeBefore === (HELD ? 1 : 0) && sizeAtDep === sizeBefore + 1 && at - depAtMs < EPOCH && found.root === "newest" && found.epochStartMs === BigInt(epochOf(depAtMs)));
  // card evm-first-proof-inside-ten-seconds: the proof ready inside READY_MS of the deposit's block, every pool host sent
  // at most HOST_WINDOW_BOUND requests (each of a batch counted) in any 10 s window from 10 s before that block to the
  // proof, and no log read from the pool's deploy block among them
  const most = windows === null ? null : Math.max(0, ...Object.values(windows).map((w) => w.n));
  const refusedOld = depAtMs === null ? [] : stateRefused.filter((x) => x.at > depAtMs - 10_000 && x.at <= at);
  // review of 584af1495, P3-2: every request each host was sent from 10 s before the deposit's block to the proof, as
  // sent (ms after that block, its batch), so scripts/evm-landing-replay.mjs sends the real providers the same times and
  // batches
  const landingTrace = process.env.CT_TRACE === "1" ? tracing.map((x) => ({ ...x, msAfterDeposit: depAtMs === null ? null : x.at + t0 - depAtMs })) : undefined;
  if (process.env.CT_TRACE === "1") tracing = null;
  const sentInWindow = depAtMs === null ? [] : hostSends.filter((x) => x.at >= depAtMs - 10_000 && x.at <= at).map((x) => ({ host: x.host, ms: x.at - depAtMs, batch: x.batch, m: x.m }));
  step("first leaf: ready inside 10 s, each pool host inside its window", { readyMsAfterDeposit: found === null ? null : at - depAtMs, depositIntoPeriodMs: depAtMs === null ? null : depAtMs - epochOf(depAtMs), stateRefusedInWindow: refusedOld, stateRefusedRun: stateRefused.length, sentInWindow, ...(landingTrace ? { landingTrace } : {}), readyBoundMs: READY_MS, hostWindowMost: most, hostWindowBound: HOST_WINDOW_BOUND, deployPages }, found !== null && at - depAtMs <= READY_MS && most !== null && most <= HOST_WINDOW_BOUND && deployPages === 0);
});
// the held-note copy measures the landing beside a held note; the withdraw steps below are the first leaf's
if (HELD) {
  follows.abort();
  await finish(failures.length === 0 ? 0 : 1);
}
await guard("withdraw: the first leaf, tapped inside its first minute", async () => {
  const AMOUNT = "0.0001";
  const toWas = await toBalance();
  const size = await poolSize();
  const tapChainMs = await chainMs();
  const s = Date.now();
  const ready = await tap(t, "wfirst", AMOUNT);
  const runMs = Date.now() - s;
  const end = await readUntilSent([t], "wfirst", { endOnStop: true });
  const o = await opOf("wfirst");
  txsOf(o.op, "withdraw first leaf");
  const got = (await toBalance()) - toWas;
  const noLeaf = await noLeafRead(o.op, epochOf(tapChainMs));
  step("withdraw: the first leaf, tapped inside its first minute", { ...first, sizeAtTap: size, depthAtTap: depthOfSize(size), tapChainMs, tapEpochStartMs: epochOf(tapChainMs), tapMsAfterDeposit: tapChainMs - depAtMs, runMs, sentMs: seenAt.wfirst.wallMs - s, end, ...o, arrived: got, asked: ready.amount, noLeaf }, end === "sent" && got === ready.amount && sizeAtDep === 1 && epochOf(tapChainMs) === epochOf(depAtMs) && noLeaf.cut === "no_leaf" && noLeaf.boundStateRoot !== null && noLeaf.boundStateRoot === noLeaf.poolRootAtDeposit);
});
await guard("withdraw: the second, at depth 1", async () => {
  const AMOUNT = "0.0001";
  const toWas = await toBalance();
  // the first withdraw's change note shows once its leaf's block is final: the page's state reads, the safe block mined
  // (the screen's funds: UNSPENT and HELD notes, withdrawSources), so the tap waits for one
  const c0 = Date.now();
  const notesAtFirstSent = await statesOf(A.w);
  const spendable = async () => (await mine(A.w)).some((n) => (n.state === "UNSPENT" || n.state === "HELD") && n.leaf.value > EVM_LADDER.one);
  // what the page shows in that window, each round: the balance (the page's own rule, wallet pool/balances.ts), the
  // form's Max (poolSendable over the funds the screen reads) and the words a tap of the amount draws
  const windowRows = [];
  const shown = async () => {
    const r = await t.readyWith(() => readNotes(A.w));
    const id = [...r.open][0];
    const b = id === undefined ? null : poolBalances(r.value, [evmBalancePool(id, CHAIN, scope)], r.ready, r.open, r.landed, r.making).find((x) => x.chain === CHAIN) ?? null;
    t.flow({ kind: "pool.withdraw", chain: CHAIN, token: null, amount: 0n, slippageBps: 0, decimals: 18 }, { id: "wsecond-form", sha: "00", progress: () => {} });
    const wd = t.withdrawDeps(CHAIN, "wsecond-form");
    const to = checkPoolTo(CHAIN, TO, wd.keys);
    const funds = to.ok ? await wd.funds(to.to) : null;
    const m = checkPoolAmount(CHAIN, AMOUNT, funds);
    windowRows.push({ ms: Date.now() - c0, balance: b?.balance ?? null, max: funds === null ? null : poolSendable(funds), refusal: m.ok ? null : poolRefusalWords(CHAIN, m.code, m.min, m), states: (await statesOf(A.w)).map((n) => n.state) });
  };
  await shown();
  for (let k = 0; k < 30 && !(await spendable()); k++) {
    await finalize();
    await t.stateRead().catch(() => {});
    await shown();
  }
  const changeShownMs = Date.now() - c0;
  log("withdraw: the second, its change", { notesAtFirstSent, changeShownMs, notes: await statesOf(A.w), windowRows });
  const size = await poolSize();
  const s = Date.now();
  const ready = await tap(t, "wsecond", AMOUNT);
  const runMs = Date.now() - s;
  const end = await readUntilSent([t], "wsecond", { endOnStop: true });
  const o = await opOf("wsecond");
  txsOf(o.op, "withdraw second");
  const got = (await toBalance()) - toWas;
  step("withdraw: the second, at depth 1", { changeShownMs, windowRows, sizeAtTap: size, depthAtTap: depthOfSize(size), runMs, sentMs: seenAt.wsecond.wallMs - s, end, ...o, arrived: got, asked: ready.amount }, end === "sent" && got === ready.amount && depthOfSize(size) === 1);
});
const inPoolMs = stageAt.in_pool === undefined ? null : stageAt.in_pool - carryAt;
// the follow's end reads the deposit final on both RPCs
await finalize();
const ended = await Promise.race([followRun.then((s) => s), sleep(60_000).then(() => null)]);
if (ended === null) follows.abort();
const uxNotes = (await mine(A.w)).filter((n) => n.ref.kind === "deposit" && n.ref.i === ux.index);
for (const n of uxNotes) for (const s of n.evmSends ?? []) txHashes.set(s.hash, "carry: U_X deposit");
for (const x of carried) txHashes.set(x.hash, "carry: U_X deposit");
step("carry", { shownMs, inPoolMs, followEnd: ended, stages: [...stages], txs: carried, sent: sends() - beforeUnder, balance: await balanceOf(A.w), notes: await statesOf(A.w), uxLeft: BigInt(await anvil("eth_getBalance", [ux.evm, "latest"])) }, shownMs !== null && ended === "in_pool" && carried.length === 1);

// 5. the restore's U_X read: the pool's own pair, never the helper
await guard("restore reads U_X", async () => {
  const calls = helperCalls.length;
  const reads = restoreUxOf(CHAIN, { deposit: depositFromUx }, undefined, undefined, (c) => t.evmPoolOf(c));
  const b = reads === null ? null : await reads.balances({ u: ux.evm });
  step("restore reads U_X", { balances: b, helperCalls: helperCalls.length - calls }, b !== null && b[0] === b[1] && b[0] < floor && helperCalls.length === calls);
});

// 6. the helper answers 503 at the release: nothing sent, then the retry finishes it
await guard("withdraw: helper 503", async () => {
  const AMOUNT = "0.0003";
  const toWas = await toBalance();
  const before = { ...sent };
  plant.down503 = 1;
  const s = Date.now();
  tracing = [];
  const ready = await tap(t, "w503", AMOUNT);
  const after = await opOf("w503");
  await sleep(200);
  record.trace = tracing;
  const plantedLeft = plant.down503;
  plant.down503 = 0;
  const helperSent = sent.helper - before.helper;
  step("withdraw: helper 503, the page's state", { ms: Date.now() - s, plantedHit: plantedLeft === 0, ...after, helperSent, notes: await statesOf(A.w) }, plantedLeft === 0);
  txsOf(after.op, "withdraw 503");
  let op = "w503";
  // the retry: the state reads finish an op the run left in transit (after the 503 nothing was sent: the page waits out
  // the proof's deadline on chain, then ends it stopped); a stopped one is tapped again, as the user would
  // the stop is seen within one round (~12 s) of the page writing it: the gap past the proof's deadline is the page's
  let end = after.op?.stage === "stopped" ? "stopped" : await readUntilSent([t], op, { endOnStop: true });
  const stoppedAtMs = Date.now() - t0;
  const stoppedWallMs = Date.now();
  const deadlineMs = after.owed ? Object.values(after.owed)[0]?.deadlineMs ?? null : null;
  const stopPastDeadlineMs = end === "stopped" && deadlineMs !== null ? stoppedWallMs - Number(deadlineMs) : null;
  let againMs = null;
  if (end === "stopped") {
    op = "w503-again";
    const s2 = Date.now();
    await tap(t, op, AMOUNT);
    end = await readUntilSent([t], op, { endOnStop: true });
    againMs = Date.now() - s2;
  }
  const o = await opOf(op);
  txsOf(o.op, "withdraw 503 retry");
  const got = (await toBalance()) - toWas;
  step("withdraw: helper 503, the retry", { retriedAs: op, stoppedAtMs, stoppedWallMs, deadlineMs, stopPastDeadlineMs, againMs, end, ...o, arrived: got, asked: ready.amount, notes: await statesOf(A.w), balance: await balanceOf(A.w) }, end === "sent" && got === ready.amount);
});

// 7. W's onward send lost: in_transit and owed, then a reload finishes it
await guard("withdraw: onward lost", async () => {
  // the ladder's one: what is left after four withdraws at Robinhood's fee (6e13 wei a part) plans no 0.0002
  const AMOUNT = "0.0001";
  const toWas = await toBalance();
  losing = true;
  const ready = await tap(t, "wlost", AMOUNT);
  losing = false;
  const first = await opOf("wlost");
  txsOf(first.op, "withdraw lost-send");
  step("withdraw: onward lost, the run's end", { ...first, dropped: sent.dropped, arrivedYet: (await toBalance()) - toWas }, first.op?.stage === "in_transit" && first.owed !== null && sent.dropped > 0);
  await t.signedOut();
  const reload = poolOn(A.w);
  const end = await readUntilSent([reload], "wlost");
  // nothing owed: the page drops each owed send from the op's record (src/pool-testnet.ts dropSend), {} once none is left
  const o = await opOf("wlost");
  txsOf(o.op, "withdraw lost-send finished");
  const got = (await toBalance()) - toWas;
  step("withdraw: onward lost, finished on the next load", { end, ...o, arrived: got, asked: ready.amount, notes: await statesOf(A.w), balance: await balanceOf(A.w) }, end === "sent" && got === ready.amount && (o.owed === null || Object.keys(o.owed).length === 0));
  await reload.signedOut();
});

// the fee: every period fee the helper published during the withdraws equals the device's rule at its block, from this
// fork's own reads (the kit's evmPoolFee at evmPoolGas(depth), the block's base fee and the chain fee reads of
// evmPoolChainFeeReads, as the page's evmEpochFee binds it); the depths met are named: the first withdraw's tree holds
// the deposit alone, the second's the change note too (depth 1)
await guard("withdraw fee: the device's rule is the helper's", async () => {
  const { EVM_POOL_TX_BYTES, evmPoolChainFee, evmPoolChainFeeReads, evmPoolFee, evmPoolGas } = await import("../../kit/src/trade/evm/pool-fee.ts");
  const SIZE = "0x" + Buffer.from(keccak_256(new TextEncoder().encode("currentTreeSize()"))).toString("hex").slice(0, 8);
  // LeanIMT's depth for a size (wallet pool/evm.ts depthOf): ceil(log2(size)), 0 for 0 or 1
  const depthOf = (n) => { let d = 0; while (2 ** d < n) d++; return d; };
  const seen = new Map();
  for (const c of helperCalls.filter((x) => x.path === "/v1/pool/fee" && x.status === 200 && x.body)) {
    const a = JSON.parse(c.body);
    if (seen.has(a.block)) continue;
    const b = await anvil("eth_getBlockByNumber", [a.block, false]);
    const size = Number(BigInt(await anvil("eth_call", [{ to: PIN.pool, data: SIZE }, a.block])));
    const depth = depthOf(size);
    const reads = evmPoolChainFeeReads(CHAIN, evmPoolGas(depth));
    const answers = await Promise.all(reads.map(async (r) => BigInt(await anvil("eth_call", [r, a.block]))));
    const chainFee = evmPoolChainFee(CHAIN, EVM_POOL_TX_BYTES, answers);
    const device = evmPoolFee({ gas: evmPoolGas(depth), gasPrice: BigInt(b.baseFeePerGas), chainFee });
    seen.set(a.block, { block: Number(BigInt(a.block)), size, depth, baseFee: BigInt(b.baseFeePerGas), chainFee, device, helper: BigInt(a.fee) });
  }
  const rows = [...seen.values()];
  step("withdraw fee: the device's rule is the helper's", { rows, depths: [...new Set(rows.map((r) => r.depth))] }, rows.length > 0 && rows.every((r) => r.device === r.helper) && rows.some((r) => r.depth >= 1));
});

// 8. device C, a fresh profile: the restore with notes already spent
await guard("restore C", async () => {
  const C = await profile();
  const s = Date.now();
  const r = await restoreInto(C.ns);
  const [a, c] = [await balanceOf(A.w), await balanceOf(C.w)];
  const spent = (await statesOf(C.w)).filter((n) => n.state === "SPENT").length;
  step("restore C with notes spent", { ms: Date.now() - s, block: r.block, spends: r.spends?.length ?? null, notes: await statesOf(C.w), balanceC: c, balanceA: a }, c === a && spent >= 1);
  C.ns.close();
  C.w.close();
});

await finish(failures.length === 0 ? 0 : 1);
