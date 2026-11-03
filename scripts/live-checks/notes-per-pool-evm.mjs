#!/usr/bin/env node
// Live check of card notes-per-pool-evm: the wallet's EVM pool sync (packages/wallet/src/pool/evm.ts) reads each
// deployed testnet pool on the two money-gate RPCs of its chain (scripts/ci/money-gate.mjs), and every check passes.
// The sync itself runs in packages/wallet/scripts/evm-pool-sync-check.ts, a child process (Blindfill's code stays
// behind the kit's entry for this file; no check here is a second implementation of the sync's). This file makes
// every network call for it, so it records or replays them.
// Per chain:
//   - the deploy tx's receipt on both RPCs: status 1, contractAddress the pinned pool, the same block number and hash
//     on both; that block is the sync's fromBlock;
//   - the sync's full round from that block: eth_chainId the chain's and SCOPE() evmPoolScopeOf(pool, chainId) on both,
//     the finalized and the newest agreed anchors with one hash on both, every Deposited, Withdrawn and Bought log since
//     the deploy block (pages halve on a provider's range cap) rebuilt into trees equal to currentRoot,
//     currentTreeSize, currentLabelRoot and currentLabelTreeSize at the newest anchor on both;
//   - the cut at the pool's time: stateRootTimes and labelRootTimes of its roots are its last leaf's block time. A pool
//     with no leaf yet prints "no leaf yet", which is not a failure (the first testnet deposit is a later card's; from
//     then on this line must pass).
//   node scripts/live-checks/notes-per-pool-evm.mjs [--chain base-sepolia|robinhood-testnet] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every answer read, as the good run of notes-per-pool-evm.answers.json, and its bad run: the same
// answers with currentTreeSize one higher on both RPCs, which the sync must refuse.
import "../net-window.mjs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "notes-per-pool-evm";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
export const SYNC = path.join(REPO, "packages", "wallet", "scripts", "evm-pool-sync-check.ts");

// @noble/hashes from the helper's own dependencies (apps/ is outside Blindfill), for the view selectors' names.
const req = createRequire(new URL("../../apps/helper/package.json", import.meta.url));
const { keccak_256 } = req("@noble/hashes/sha3.js");
const selector = (s) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(s)).subarray(0, 4)).toString("hex")}`;
export const VIEWS = Object.fromEntries(["SCOPE()", "currentRoot()", "currentTreeSize()", "currentLabelRoot()", "currentLabelTreeSize()", "stateRootTimes(uint256)", "labelRootTimes(uint256)"].map((s) => [selector(s), s]));

// The pools and their deploy txs, from card pool-evm-deploy's run records
// (scripts/live-checks/pool-evm-deploy.base-sepolia.json and pool-evm-deploy.robinhood-testnet.json, deployed
// 3 Nov 05:02-05:04Z). The RPCs are the money gate's for each chain (scripts/ci/money-gate.mjs), two operators each.
export const CHAINS = Object.freeze({
  "base-sepolia": Object.freeze({
    chainId: 84532n,
    pool: "0xb239a38af69b68e6c5c305df64985f283b5d5fe5",
    deployTx: "0x388b62ddca5ba87084edb814e5290f097be2ff9b4ecb1dec69b5f2c567cb163a",
    rpcs: Object.freeze(["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"]),
  }),
  "robinhood-testnet": Object.freeze({
    chainId: 46630n,
    pool: "0xe5e948414a89c23e73d76cd740dacdd9364c25d5",
    deployTx: "0x32169e3cd8f365ae90a10f43eca8f1cc32953ee9bc60e3d6cd2f3253ae3cba23",
    rpcs: Object.freeze(["https://rpc.testnet.chain.robinhood.com", "https://robinhood-sepolia-rpc.publicnode.com"]),
  }),
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** One JSON-RPC call over the network: { result } or { error }; a 429, a 5xx or a failed fetch is tried 4 times. */
export async function post(url, method, params) {
  for (let t = 1; ; t++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
      if ((r.status === 429 || r.status >= 500) && t < 4) {
        await pause(1000 * t);
        continue;
      }
      const j = await r.json();
      if (j?.error) return { error: `RPC error ${j.error.code}: ${j.error.message}` };
      if (!r.ok) return { error: `HTTP ${r.status}` };
      return { result: j.result };
    } catch (e) {
      if (t < 4) {
        await pause(1000 * t);
        continue;
      }
      return { error: `fetch failed: ${e?.message ?? e}` };
    }
  }
}

/** A live transport that keeps every answer, in order. */
export function recorder() {
  const log = [];
  const transport = async (url, method, params) => {
    const a = await post(url, method, params);
    log.push({ url, method, params, ...a });
    return a;
  };
  return { transport, log };
}

/** A transport that answers each call with the recorded answers to that same call, in their order; past the last,
 * the last again (a block read twice by number is the same block). */
export function replayer(log) {
  const queues = new Map();
  for (const e of log) {
    const k = JSON.stringify([e.url, e.method, e.params]);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(e);
  }
  return async (url, method, params) => {
    const q = queues.get(JSON.stringify([url, method, params]));
    const e = q?.length > 1 ? q.shift() : q?.[0];
    if (e === undefined) return { error: `no recorded answer to ${method} ${JSON.stringify(params)} on ${url}` };
    return "error" in e ? { error: e.error } : { result: e.result };
  };
}

/** The deploy block: the tx's receipt on both RPCs, the pool's creation, one block and hash on both. */
async function deployBlock(c, transport) {
  const rs = await Promise.all(c.rpcs.map((u) => transport(u, "eth_getTransactionReceipt", [c.deployTx])));
  for (const [k, r] of rs.entries()) {
    if ("error" in r) throw new Error(`receipt on rpc ${k}: ${r.error}`);
    const x = r.result;
    if (x === null || typeof x !== "object") throw new Error(`rpc ${k}: no receipt for ${c.deployTx}`);
    if (x.status !== "0x1") throw new Error(`rpc ${k}: the deploy tx failed (status ${x.status})`);
    if (String(x.contractAddress).toLowerCase() !== c.pool) throw new Error(`rpc ${k}: the deploy tx made ${x.contractAddress}, not the pool ${c.pool}`);
  }
  const [a, b] = rs.map((r) => r.result);
  if (a.blockNumber !== b.blockNumber || a.blockHash !== b.blockHash) throw new Error(`the two RPCs put the deploy tx in two blocks (${a.blockNumber} ${a.blockHash}, ${b.blockNumber} ${b.blockHash})`);
  return { number: BigInt(a.blockNumber), hash: a.blockHash };
}

/** The wallet's sync on one chain, its RPCs bridged to `transport`. Resolves the sync's report, or throws its refusal. */
function runSync(name, c, fromBlock, transport, wait) {
  return new Promise((resolve, reject) => {
    const args = { network: name, pool: c.pool, fromBlock: fromBlock.toString(), urls: c.rpcs, wait };
    const child = spawn(process.execPath, [SYNC, JSON.stringify(args)], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", err = "", settled = false;
    child.stdin.on("error", () => {}); // an answer after the sync has exited
    const settle = (f, v) => (settled ? undefined : ((settled = true), f(v)));
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.rpc) {
          transport(c.rpcs[m.rpc.k], m.rpc.method, m.rpc.params).then((a) => {
            if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ id: m.rpc.id, ...a })}\n`);
          });
        } else if (m.done) settle(resolve, m.done);
        else if (m.fail) settle(reject, new Error(m.fail));
      }
    });
    child.on("close", (code) => {
      child.stdin.destroy();
      settle(reject, new Error(`the sync exited ${code} with no answer${err ? `: ${err.trim().split("\n").slice(-3).join(" ")}` : ""}`));
    });
  });
}

/** A view the sync read at the newest anchor: its one answer on both RPCs. */
function view(r, s) {
  const x = r.views[Object.keys(VIEWS).find((k) => VIEWS[k] === s)];
  if (x === undefined || x[0] === null || x[0] !== x[1]) throw new Error(`${s} at the newest anchor: not one answer on both RPCs`);
  return x[0];
}

/** The check on one chain: { ok, lines }. */
export async function check(name, transport, { wait = true } = {}) {
  const c = CHAINS[name];
  if (c === undefined) throw new Error(`unknown chain ${name}`);
  const lines = [];
  try {
    const d = await deployBlock(c, transport);
    lines.push(`${name}: deploy tx ${c.deployTx} in block ${d.number} (${d.hash}) on both RPCs, creating ${c.pool}`);
    const r = await runSync(name, c, d.number, transport, wait);
    if (r.chainIds.some((x) => x !== c.chainId.toString())) throw new Error(`chain ids ${r.chainIds.join(", ")}, not ${c.chainId}`);
    lines.push(`${name}: eth_chainId ${c.chainId} on both; SCOPE() ${view(r, "SCOPE()")} on both is evmPoolScopeOf(pool, ${c.chainId})`);
    for (const [t, a] of [["finalized", r.finalized], ["newest agreed", r.newest]]) {
      if (a === null || a.hashes[0] === null || a.hashes[0] !== a.hashes[1]) throw new Error(`the ${t} anchor is not one block on both RPCs`);
      lines.push(`${name}: ${t} anchor ${a.number} ${a.hashes[0]} on both`);
    }
    const v = (s) => view(r, s);
    lines.push(`${name}: from block ${d.number} the logs rebuild currentRoot ${v("currentRoot()")}, currentTreeSize ${v("currentTreeSize()")}, currentLabelRoot ${v("currentLabelRoot()")}, currentLabelTreeSize ${v("currentLabelTreeSize()")} at the newest anchor, on both; depth ${r.depth}`);
    lines.push(r.cut === null
      ? `${name}: no leaf yet (no leaf before the pool's time ${r.nowMs} ms): stateRootTimes and labelRootTimes are read from the first deposit on`
      : `${name}: the cut before ${r.cut.beforeMs} ms (${r.cut.stateSize} state, ${r.cut.labelSize} label leaves): stateRootTimes(${r.cut.stateRoot}) and labelRootTimes(${r.cut.labelRoot}) are its last leaves' block times on both`);
    return { ok: true, lines };
  } catch (e) {
    lines.push(`${name}: ${e?.message ?? e}`);
    return { ok: false, lines };
  }
}

/** The bad run kept beside a good one: currentTreeSize one higher in every answer, on both RPCs. */
export function spoil(log) {
  const size = Object.keys(VIEWS).find((k) => VIEWS[k] === "currentTreeSize()");
  return log.map((e) =>
    e.method === "eth_call" && String(e.params?.[0]?.data).startsWith(size) && typeof e.result === "string"
      ? { ...e, result: `0x${(BigInt(e.result) + 1n).toString(16).padStart(64, "0")}` }
      : e,
  );
}

async function main(argv) {
  const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const only = at("--chain");
  const names = only ? [only] : Object.keys(CHAINS);
  const record = at("--record");
  let ok = true;
  const good = {}, bad = {};
  for (const name of names) {
    const rec = recorder();
    const r = await check(name, rec.transport);
    for (const l of r.lines) console.log(`${r.ok ? "PASS" : "FAIL"} ${l}`);
    ok &&= r.ok;
    good[name] = rec.log;
    bad[name] = spoil(rec.log);
  }
  if (record) {
    writeFileSync(record, `${JSON.stringify({ key: KEY, recorded: new Date().toISOString(), good, bad }, null, 1)}\n`);
    console.log(`recorded ${record}`);
  }
  console.log(ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(2)));
