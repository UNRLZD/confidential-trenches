#!/usr/bin/env node
// Live check of card evm-pool-reads-throttle: a Base Sepolia pool buy's reads, every one before W signs, survive a
// provider that throttles once. On 5 Nov 13:55-13:58Z Robinhood's own RPC answered HTTP 429 with no Retry-After, and
// Pocket and daybreak each gave one eth_getBlockByNumber no answer in 3.5 s; one such answer on a pool read was the
// whole buy's failure. This check runs the reads through the wallet's own code (packages/wallet/scripts/
// pool-reads-throttle-check.ts, a child process, so Blindfill's code stays behind the kit's entry for this file and no
// check here is a second implementation of the wallet's): the pool's now(), trees(the epoch's start) and bind for one
// chunk at that epoch (the epoch's first block, the depth there, the chain fee on the fee pair), on the kit's pinned
// pool and fee pair for Base Sepolia, every call through the device's own client (the kit's solanaJsonRpc with
// SOLANA_RPC_RETRY). The sync's pair is SYNC, not the kit's pinned one: sepolia.base.org caps a log page at 200
// blocks, and the pool's logs span 1,057,182 blocks (its deploy block 53,801,443 to 54,858,625, read 5 Nov 15:50Z),
// about 6,800 pages for a cold sync; PublicNode answered a 50,000-block page in 292 ms and Pocket a 10,000-block page
// in 985 ms (15:52Z), about 130 pages. Between the device and each provider sits a stand-in that answers the first call of each kind
// (eth_chainId; a block by tag, by number and by hash; each view by its selector; a log page) as the device's client
// ends a throttled call: HTTP 429 with no Retry-After, and no answer in 3.5 s for the first block by number. Every
// later call reaches the provider. Nothing is signed or sent.
// It passes when the binding is made (the epoch's deadline, a fee, W the recipient) and the stand-in throttled every
// kind once on both providers; it fails if any read is refused or a kind was never met.
//   node scripts/live-checks/evm-pool-reads-throttle.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every provider answer read, as the good run of evm-pool-reads-throttle.answers.json, and its bad
// run: the same answers with every eth_chainId of the second provider a throttle, never an answer (a read the bound
// gives up on, by name).
// Runs: once, it reads no host: the wallet at the checkout against Base Sepolia's public RPCs; the wallet tests hold every read's bound
import "../net-window.mjs";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { poolFile } from "./pool-evm-deploy.mjs";
import { recorder, replayer } from "./wallet-restore-transfer-rpcs.mjs";

const KEY = "evm-pool-reads-throttle";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
export const CHECK = path.join(REPO, "packages", "wallet", "scripts", "pool-reads-throttle-check.ts");
export const NETWORK = "base-sepolia";
/** The fee recipient the binding names: a test address, neither the pool nor zero (no fee is ever paid here). */
export const FEE_TO = "0x000000000000000000000000000000000000fee1";
/** The pool's deploy (its newest pool set's record, pool-evm-deploy.mjs poolFile): its receipt's block is the sync's start. */
const DEPLOY = JSON.parse(readFileSync(poolFile(NETWORK), "utf8")).txs.find((t) => t.step === "deploy PrivacyPoolSimple").hash;
/** The sync's pair: two keyless providers of two operators that page the pool's logs wide (see the header). */
export const SYNC = Object.freeze(["https://base-sepolia-rpc.publicnode.com", "https://base-testnet.api.pocket.network"]);
/** The kinds of read the stand-in throttles once on each sync provider; each must be met (a fee provider: a view). */
export const KINDS = Object.freeze(["eth_chainId", "block finalized", "block latest", "block number", "block hash", "view", "eth_getLogs"]);
const VIEW_MIN = 6; // SCOPE, currentRoot, currentTreeSize, currentLabelRoot, currentLabelTreeSize, stateRootTimes (and more)

const host = (u) => new URL(u).host;
/** A call's kind, and its key: one throttle per key on each provider. */
function kindOf(method, params) {
  if (method === "eth_getBlockByNumber") {
    const at = params[0];
    const kind = at === "finalized" || at === "latest" ? `block ${at}` : "block number";
    return { kind, key: kind };
  }
  if (method === "eth_getBlockByHash") return { kind: "block hash", key: "block hash" };
  if (method === "eth_call") return { kind: "view", key: `view ${String(params[0]?.data).slice(0, 10)}` };
  return { kind: method, key: method };
}

/** The provider stand-in: the first call of each key on each URL is answered as the device's client ends a throttled
 * call (a timeout for the first block by number, else HTTP 429 with no Retry-After); every later one reaches
 * `transport`. `met` counts the throttles by kind and URL. */
export function standIn(transport) {
  const seen = new Set();
  const met = new Map();
  const through = async (url, method, params) => {
    const { kind, key } = kindOf(method, params);
    const id = `${url} ${key}`;
    if (!seen.has(id)) {
      seen.add(id);
      met.set(`${kind} ${url}`, (met.get(`${kind} ${url}`) ?? 0) + 1);
      return kind === "block number"
        ? { error: `no answer in 3500 ms (timeout, 1 try at ${host(url)})`, name: "SolanaRpcTransportError", afterMs: null }
        : { error: `HTTP 429 (http_429, 4 tries at ${host(url)})`, name: "SolanaRpcTransportError", afterMs: null };
    }
    return transport(url, method, params);
  };
  return { through, met, seen };
}

/** The wallet's pool reads, its RPCs bridged to `transport`. Resolves its report, or throws its refusal. */
function runCheck(args, transport) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHECK, JSON.stringify(args)], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", err = "", settled = false;
    child.stdin.on("error", () => {});
    const settle = (f, v) => (settled ? undefined : ((settled = true), f(v)));
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.rpc) {
          transport(m.rpc.url, m.rpc.method, m.rpc.params).then((a) => {
            if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ id: m.rpc.id, ...a })}\n`);
          });
        } else if (m.done) settle(resolve, m.done);
        else if (m.fail) settle(reject, new Error(m.fail));
      }
    });
    child.on("close", (code) => {
      child.stdin.destroy();
      settle(reject, new Error(`the check exited ${code} with no answer${err ? `: ${err.trim().split("\n").slice(-3).join(" ")}` : ""}`));
    });
  });
}

/** The check: { ok, lines }. `transport(network, url, method, params)`, the URLs the kit's pinned providers. */
export async function check(transport, { wait = true } = {}) {
  const lines = [];
  const venue = evmPoolVenues()[NETWORK];
  const fees = venue.feeProviders ?? venue.providers;
  const urls = [...new Set([...SYNC, ...fees])];
  const t = (url, method, params) => transport(NETWORK, url, method, params);
  try {
    // the sync's start: the pool's deploy block, read on the first provider (the check's own read, never throttled)
    const rc = await t(SYNC[0], "eth_getTransactionReceipt", [DEPLOY]);
    if (rc.error !== undefined || typeof rc.result?.blockNumber !== "string") throw new Error(`the pool's deploy receipt: ${rc.error ?? "none"}`);
    const fromBlock = BigInt(rc.result.blockNumber).toString();
    const s = standIn(t);
    let calls = 0;
    const counted = (url, method, params) => (++calls % 50 === 0 && wait && process.stderr.write(`${calls} reads\n`), s.through(url, method, params));
    const r = await runCheck({ network: NETWORK, fromBlock, feeRecipient: FEE_TO, rpcs: SYNC, wait }, counted);
    if (BigInt(r.deadlineMs) !== BigInt(r.epochStartMs) + 210_000n) throw new Error(`the binding's deadline ${r.deadlineMs} is not the epoch's ${r.epochStartMs} + 210 s`);
    if (!(BigInt(r.fee) > 0n)) throw new Error(`the binding's fee ${r.fee} is not above 0`);
    const missed = [];
    for (const u of SYNC) for (const k of KINDS) if (!(s.met.get(`${k} ${u}`) >= 1)) missed.push(`${k} at ${host(u)}`);
    for (const u of fees) if (!(s.met.get(`view ${u}`) >= 1)) missed.push(`view at ${host(u)}`);
    const views = new Set([...s.seen].filter((id) => SYNC.some((u) => id.startsWith(`${u} view `))).map((id) => id.split(" ").pop())).size;
    if (missed.length) throw new Error(`the stand-in never throttled: ${missed.join(", ")}`);
    if (views < VIEW_MIN) throw new Error(`only ${views} view kinds were throttled, under ${VIEW_MIN}`);
    const throttled = [...s.met.values()].reduce((x, y) => x + y, 0);
    lines.push(`${NETWORK}: pool ${r.pool} from block ${fromBlock}: now ${r.nowMs}, the trees at epoch ${r.epochStartMs} (${r.size} leaves), bound for W ${r.recipient} at fee ${r.fee} wei, deadline ${r.deadlineMs}, with ${throttled} reads throttled once on ${urls.map(host).join(", ")} (${KINDS.join(", ")}; views of ${views} kinds)`);
    return { ok: true, lines };
  } catch (e) {
    lines.push(`${NETWORK}: ${e?.message ?? e}`);
    return { ok: false, lines };
  }
}

/** The bad run kept beside a good one: every eth_chainId the sync's second provider answered, a throttle instead. */
export function spoil(log) {
  const second = SYNC[1];
  return log.map((e) => (e.url === second && e.method === "eth_chainId" ? { network: e.network, url: e.url, method: e.method, params: e.params, error: `HTTP 429 (http_429, 4 tries at ${host(e.url)})`, name: "SolanaRpcTransportError", afterMs: null } : e));
}

async function main(argv) {
  const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const record = at("--record");
  const rec = recorder();
  const r = await check(rec.transport);
  for (const l of r.lines) console.log(`${r.ok ? "PASS" : "FAIL"} ${l}`);
  if (record) {
    writeFileSync(record, `${JSON.stringify({ key: KEY, recorded: new Date().toISOString(), good: rec.log, bad: spoil(rec.log) }, null, 1)}\n`);
    console.log(`recorded ${record}`);
  }
  console.log(r.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(2)));
