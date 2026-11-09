#!/usr/bin/env node
// Live check of card evm-pool-leaves-any-source: a device rebuilds each EVM mainnet pool's two trees from logs any
// sources give, held to the pool's views at one head block, and takes them only as two operators give them byte for
// byte. For Base and Robinhood, read now:
//   1. the helper's keyed-only mode is deployed: POST <helper>/v1/rpc/<chain>?keyed=bogus is refused (the route's 400
//      method_not_allowed); a helper that answers it reads no flag, so its ?keyed=only would relay its public fallback
//      (the device's own providers) and count one operator twice;
//   2. the wallet's own sync (packages/wallet/src/pool/evm.ts evmTreeSync, run in packages/wallet/scripts/
//      evm-pool-sources-check.ts, a child process: Blindfill's code stays behind the kit's entry for this file and no
//      check here is a second implementation of the sync's) on the signing page's mainnet list (MAINNET_POOL_RPCS in
//      packages/signpage/src/pool-testnet.ts, two operators) for the head, the anchors and the views, with every seat's
//      eth_getLogs refused, so every log comes from the sources: the helper's keyed-only route (operator "helper") and
//      the list's providers. The sync passes only on two operators' byte-identical logs whose trees are the pool's views
//      at the anchor's hash;
//   3. at least two operators answered the sync's log reads.
// Every call is made here, through provider-answer.mjs (rpcAnswer), and recorded or replayed: a provider's no-answer
// reaches the wallet as the error the device would see. A sync refused with a provider silent makes that chain
// INCONCLUSIVE; a sync refused on logs whose trees are not the pool's, or with every provider answering, FAILs.
// Pure reads of public RPCs and the helper's route: no key, no write.
// After: helper
//   node scripts/live-checks/evm-pool-leaves-any-source.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (provider-answer.mjs EXIT)
// --record writes every answer read, as the good run of evm-pool-leaves-any-source.answers.json, and the bad run: the
// good answers with a leaf the pool does not hold added to every Base log page holding the deploy block, on every source
// (plantedBad; the file's note says so).
import "../net-window.mjs";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "evm-pool-leaves-any-source";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
export const SYNC = path.join(REPO, "packages", "wallet", "scripts", "evm-pool-sources-check.ts");
/** A replay's clock stands still, so the wallet's paces and waits are the recording's (wallet-restore-transfer-rpcs). */
const STILL_CLOCK = Object.freeze(["--import", "data:text/javascript,const t=Date.now();Date.now=()=>t;"]);
/** A chain's sync still going then fails, naming the call it is stuck on. */
export const CHAIN_DEADLINE_MS = 480_000;

/** The pool's three events (packages/wallet/src/pool/evm.ts EVM_POOL_EVENTS), keccak256 of each signature; the test
 *  holds them equal to robinhood-mainnet-rpcs.mjs's POOL_TOPICS. */
export const POOL_TOPICS = Object.freeze([
  "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549", // Deposited(address,uint256,uint256,uint256,uint256)
  "0xfabb9e7afa4ef595f60e1ae9041b2b311b4acb27aeaed4b11b6f2abf689af10a", // Withdrawn(address,address,uint256,uint256,uint256,uint256)
  "0xb8a1e6c10d45357f60b093ab761ca4af74bf300c039aa105fb946f7e5105727d", // Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)
]);

export const HELPER = "https://ct-api.unrealized.trade";
/** The two mainnet pools: the deployments' addresses (contracts/pool-evm/deployments/<chain>.json) and their deploy
 *  blocks; `list` the signing page's MAINNET_POOL_RPCS. */
export const CHAINS = Object.freeze([
  {
    name: "base",
    list: ["https://base-rpc.publicnode.com", "https://base.api.pocket.network"],
    helper: `${HELPER}/v1/rpc/base?keyed=only`,
    pool: "0xaa080e74ec99cf5c684548c77ca145edfcf899cf",
    from: 54325671,
  },
  {
    name: "robinhood",
    list: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.api.pocket.network"],
    helper: `${HELPER}/v1/rpc/robinhood?keyed=only`,
    pool: "0x9306359433127c4f3be426f6faeb00a3c41f66db",
    from: 108420674,
  },
]);

/** A provider's read: provider-answer.mjs's rpcAnswer, { result } or { error } (a JSON-RPC error, judged) or
 *  { noAnswer } (the provider's no-answer, named). */
export const live = (url, method, params) => rpcAnswer(url, method, params);

/** The live transport, each answer kept in order: the good run's recording. */
export function recorder(read = live) {
  const log = [];
  const transport = async (url, method, params) => {
    const a = await read(url, method, params);
    log.push({ url, method, params, ...a });
    return a;
  };
  return { transport, log };
}

/** A transport that answers each call with the recorded answers to that same call, in their order; past the last, the
 *  last again. A call with none recorded is a no-answer (never judged on). */
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
    if (e === undefined) return { noAnswer: `no recorded answer to ${method} ${JSON.stringify(params)} on ${url}` };
    return "noAnswer" in e ? { noAnswer: e.noAnswer } : "error" in e ? { error: e.error } : { result: e.result };
  };
}

/** A JSON-RPC error's words, as the device's client gives them to the wallet. */
const words = (e) => (typeof e === "string" ? e : typeof e?.message === "string" ? `RPC error ${e.code ?? ""}: ${e.message}` : `RPC error: ${JSON.stringify(e)}`);
const host = (u) => new URL(u).host;
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** The wallet's sync on one chain, its calls answered by `transport`, ended at `deadlineMs`: its report, or its
 *  refusal; `quiet` names the first provider no-answer it was handed. */
function runSync(c, transport, wait, deadlineMs) {
  return new Promise((resolve) => {
    const args = { network: c.name, pool: c.pool, fromBlock: String(c.from), list: c.list, helper: c.helper, wait };
    const t0 = Date.now();
    const child = spawn(process.execPath, [...(wait ? [] : STILL_CLOCK), SYNC, JSON.stringify(args)], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", err = "", settled = false, calls = 0, quiet = null;
    const open = new Map();
    child.stdin.on("error", () => {});
    const settle = (v) => (settled ? undefined : ((settled = true), clearTimeout(timer), resolve({ ...v, calls, ms: Date.now() - t0, quiet })));
    const timer = setTimeout(() => {
      const o = [...open.values()].sort((a, b) => a.at - b.at)[0];
      settle({ fail: `no end in ${secs(deadlineMs)} (${calls} calls)${o ? `: stuck on ${o.method} on ${host(o.url)}, no answer in ${secs(Date.now() - o.at)}` : ""}` });
      child.kill("SIGKILL");
    }, deadlineMs);
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.rpc) {
          calls++;
          open.set(m.rpc.id, { url: m.rpc.url, method: m.rpc.method, at: Date.now() });
          transport(m.rpc.url, m.rpc.method, m.rpc.params).then((a) => {
            open.delete(m.rpc.id);
            if ("noAnswer" in a) quiet ??= a.noAnswer;
            const back = "result" in a ? { result: a.result } : { error: "noAnswer" in a ? a.noAnswer : words(a.error) };
            if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ id: m.rpc.id, ...back })}\n`);
          });
        } else if (m.done) settle({ done: m.done });
        else if (m.fail) settle({ fail: m.fail, logs: m.logs });
      }
    });
    child.on("close", (code) => {
      child.stdin.destroy();
      settle({ fail: `the sync exited ${code} with no answer${err ? `: ${err.trim().split("\n").slice(-3).join(" ")}` : ""}` });
    });
  });
}

/** The helper's keyed-only mode: ?keyed=bogus refused with the route's 400 method_not_allowed. */
async function keyedMode(c, transport) {
  const probe = c.helper.replace(/\?keyed=only$/, "?keyed=bogus");
  const a = await transport(probe, "eth_blockNumber", []);
  if ("noAnswer" in a) return { quiet: a.noAnswer };
  if ("result" in a) return { bad: `the helper's route answered ?keyed=bogus (${JSON.stringify(a.result)}): no keyed-only mode is deployed, so its ?keyed=only relays its public fallback` };
  if (a.error?.code !== "method_not_allowed") return { bad: `the helper's route refused ?keyed=bogus with ${JSON.stringify(a.error)}, not method_not_allowed` };
  return {};
}

/** One chain: a line and its verdict. */
async function chain(c, transport, wait, deadlineMs) {
  const k = await keyedMode(c, transport);
  if (k.bad) return { verdict: "FAIL", line: `FAIL ${c.name}: ${k.bad}` };
  if (k.quiet) return { verdict: "INCONCLUSIVE", line: `INCONCLUSIVE ${c.name}: the helper's route gave no answer (${k.quiet})` };
  const r = await runSync(c, transport, wait, deadlineMs);
  if (r.done) {
    const d = r.done;
    const by = Object.entries(d.logs).map(([op, n]) => `${op} ${n.answered}${n.refused > 0 ? ` (${n.refused} refused)` : ""}`).join(", ");
    const answered = Object.values(d.logs).filter((n) => n.answered > 0).length;
    if (answered < 2) return { verdict: "FAIL", line: `FAIL ${c.name}: the sync took logs that fewer than two operators answered (${by})` };
    return { verdict: "PASS", line: `PASS ${c.name}: head ${d.anchor.number} ${d.anchor.hash}, state size ${d.stateSize} root 0x${BigInt(d.stateRoot).toString(16)}, label size ${d.labelSize} root 0x${BigInt(d.labelRoot).toString(16)}, ${d.events} events from the sources alone; log reads answered: ${by} (${r.calls} calls, ${secs(r.ms)})` };
  }
  // a refusal on logs that are not the pool's is judged whatever else was silent; any other with a provider silent is not
  const judged = /is not the pool's|not of the anchor/.test(r.fail);
  if (!judged && r.quiet !== null) return { verdict: "INCONCLUSIVE", line: `INCONCLUSIVE ${c.name}: ${r.fail.slice(0, 600)} (a provider gave no answer: ${r.quiet})` };
  return { verdict: "FAIL", line: `FAIL ${c.name}: ${r.fail.slice(0, 1200)}` };
}

/** The check on `chains`: { ok, verdict, lines }. */
export async function check(transport, chains = CHAINS, { wait = true, deadlineMs = CHAIN_DEADLINE_MS } = {}) {
  const rs = await Promise.all(chains.map((c) => chain(c, transport, wait, deadlineMs)));
  const verdict = verdictOf(rs.some((r) => r.verdict === "FAIL"), rs.some((r) => r.verdict === "INCONCLUSIVE"));
  return { ok: verdict === "PASS", verdict, lines: rs.map((r) => r.line) };
}

/** A Deposited log of `pool` in `block` that no pool holds: _commitment 5, _label 6, value 1, precommitment 2. */
export function fabricated(pool, block) {
  const w = (v) => v.toString(16).padStart(64, "0");
  return {
    address: pool,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: `0x${"ab".repeat(32)}`,
    logIndex: "0x0",
    transactionHash: `0x${"cd".repeat(32)}`,
    transactionIndex: "0x0",
    topics: [POOL_TOPICS[0], `0x${"0".repeat(64)}`],
    data: `0x${w(5n)}${w(6n)}${w(1n)}${w(2n)}`,
    removed: false,
  };
}

/** The good recording with that leaf added to every Base log page holding the deploy block, on every source: the bad
 *  run (two operators agree on a leaf the pool does not hold). */
export function plantedBad(good) {
  const base = good.chains[0];
  let n = 0;
  const log = good.log.map((e) => {
    const f = e.params?.[0];
    if (e.method !== "eth_getLogs" || !Array.isArray(e.result) || BigInt(f.fromBlock) > BigInt(base.from) || BigInt(f.toBlock) < BigInt(base.from) || f.address !== base.pool) return e;
    n++;
    return { ...e, result: [fabricated(base.pool, base.from), ...e.result] };
  });
  if (n < 2) throw new Error("fewer than two sources read the deploy block's page: nothing to plant two operators' leaf in");
  return { chains: good.chains, log };
}

async function main(argv) {
  const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const record = at("--record");
  const rec = recorder();
  const r = await check(rec.transport);
  for (const l of r.lines) console.log(l);
  if (record) {
    if (r.verdict !== "PASS") throw new Error("the good run did not pass: nothing to record");
    const good = { chains: JSON.parse(JSON.stringify(CHAINS)), log: rec.log };
    const bad = plantedBad(good);
    const b = await check(replayer(bad.log), bad.chains, { wait: false });
    if (b.verdict !== "FAIL") throw new Error(`the planted bad run did not fail: ${b.lines.join(" | ")}`);
    for (const l of b.lines) console.log(`bad: ${l}`);
    const note = {
      good: "a real run from a Mac, read only: every answer the two operators of each list and the helper's keyed-only route gave",
      bad: "NOT a real source's answer: the good recording with one Deposited log (_commitment 5, _label 6) added to every Base log page holding the deploy block, on every source, a leaf the pool does not hold (both pools held no leaves when this was recorded: the planted run stands for two operators that agree on other leaves than the pool holds)",
    };
    writeFileSync(record, `${JSON.stringify({ key: KEY, recorded: new Date().toISOString(), good: { note: note.good, ...good }, bad: { note: note.bad, ...bad } }, null, 1)}\n`);
    console.log(`recorded ${record}`);
  }
  console.log(`${r.verdict} ${KEY}`);
  return EXIT[r.verdict];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(EXIT.ERROR)));
