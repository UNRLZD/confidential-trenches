// SPDX-License-Identifier: Apache-2.0
// The fork tests' RPC (test/BuyFork.t.sol), served from test/fixtures/fork-rpc.json: every JSON-RPC answer the tests
// need, recorded once from the chains' public RPCs at the pinned blocks. Replaying it, forge reads no network, so the
// fork tests give the same answer on every run and cannot fail on a public RPC. A request that was not recorded is
// answered with an error that names it, so the test fails loudly instead of reaching a chain.
//   node contracts/pool-evm/test/fork-rpc.mjs -- forge test --root contracts/pool-evm     replay, run forge, exit with its code
//   node contracts/pool-evm/test/fork-rpc.mjs --record -- forge test --mp test/BuyFork.t.sol --no-storage-caching
//                                   (from contracts/pool-evm) add what is not recorded yet from the public RPCs below
//                                   (up to 5 tries each, each bounded at 30 s), then write the file
//   node contracts/pool-evm/test/fork-rpc.mjs [--record] --book pools -- <command...>
//                                   the deployed pools' fork (card evm-money-shows-and-spends-at-once): anvil forks
//                                   Base and Robinhood mainnet at POOLS_FORK_BLOCKS, served from fixtures/fork-rpc-pools.json,
//                                   recorded from publicnode (Base: eth_getLogs pages of 50,000 blocks) and Robinhood's own
//                                   RPC (Pocket's Robinhood node keeps no state that old: "historical state ... is not
//                                   available", 12 Nov 21:41Z)
// It listens on FORK_RPC_PORT (default 47545, where foundry.toml's rpc_endpoints point: http://127.0.0.1:47545/<chain>),
// so two fork jobs on one machine each take their own port; the command it runs inherits FORK_RPC_PORT.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOOKS = {
  forge: { file: "fixtures/fork-rpc.json", upstream: { base: "https://mainnet.base.org", robinhood: "https://rpc.mainnet.chain.robinhood.com" } },
  pools: { file: "fixtures/fork-rpc-pools.json", upstream: { base: ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"], robinhood: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org", "https://robinhood.api.pocket.network", "https://rpc-robinhood.globalstake.io"] } },
  // Robinhood's last two (read 13 Nov 09:4xZ): Pocket answered a balance 200 blocks back and a 10,000-block
  // eth_getLogs; globalstake the log read, and "historical state" for the balance (a failed try here, never recorded)
};
/** The pools' fork blocks: after each pool's deploy (wallet EVM_POOLS fromBlock 54,325,671 and 108,420,674). Base: read
 *  12 Nov 20:49Z as both providers' agreed head less a few hundred blocks. Robinhood: its own RPC's head less 200, read
 *  12 Nov 22:0xZ and recorded at once, since it keeps state about 3,000 blocks back (5 min) and Pocket's less.
 *  POOLS_FORK_BLOCK_BASE / POOLS_FORK_BLOCK_ROBINHOOD name another block (a run recorded at a fresh head, replayed at
 *  the block it was recorded at); anything but a block number after the pool's deploy is refused. */
const forkBlock = (env, dflt, deployed) => {
  const v = process.env[env];
  const n = v === undefined ? dflt : /^[0-9]+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < deployed) throw new Error(`fork-rpc: ${env} ${v} is no block after the pool's deploy (${deployed})`);
  return n;
};
export const POOLS_FORK_BLOCKS = Object.freeze({ base: forkBlock("POOLS_FORK_BLOCK_BASE", 56_630_000, 54_325_671), robinhood: forkBlock("POOLS_FORK_BLOCK_ROBINHOOD", 112_859_537, 108_420_674) });
/** The most upstream requests one recording sends to one host: a host at it is asked nothing more that run, and a
 *  request with no host of its list left is refused and the run stops, so a run that loops never floods a public RPC.
 *  Per host, since a copy run's list spreads its reads over several providers (Base pass B sent 462 in all), and 1,000:
 *  a Robinhood pass asks about 600 of each of its three wide hosts (run 34, 13 Nov: 568 eth_getLogs and 561 full blocks,
 *  each a key the book did not hold, stopped at 400 each). */
export const UPSTREAM_CAP = 1_000;
const SENT = new Map();
const bookArg = process.argv.indexOf("--book");
const BOOK = BOOKS[bookArg > 0 && process.argv.indexOf("--") > bookArg ? process.argv[bookArg + 1] : "forge"];
if (!BOOK) throw new Error("fork-rpc: --book is forge or pools");
// FORK_RPC_BOOK_FILE: another file for the book (a copy run's own, kept beside its record so the run replays offline)
const FILE = process.env.FORK_RPC_BOOK_FILE ? path.resolve(process.env.FORK_RPC_BOOK_FILE) : path.join(path.dirname(fileURLToPath(import.meta.url)), BOOK.file);
const PORT = Number(process.env.FORK_RPC_PORT ?? 47545);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`fork-rpc: FORK_RPC_PORT ${process.env.FORK_RPC_PORT} is no port`);
const UPSTREAM = BOOK.upstream;
// each upstream host's tries this run (no path, no key)
const HOSTS = {};
/** Each chain's next upstream in turn. */
const turn = {};
/** The upstream hosts that answered 403 this run. */
const REFUSED = new Set();
/** A provider's answer that it holds no state for the block asked. */
const STATELESS = /missing trie node|header not found|state.*(not available|pruned)|historical state|unknown block|block not found|usage limit|rate limit|too many requests|exceeded|upgrade/i;
/** An upstream read slower than this is printed. */
const SLOW_MS = 3_000;
/** The block a request names: its last parameter that is a tag, a number or a block object. */
const blockTagOf = (r) => {
  for (const p of [...(r.params ?? [])].reverse()) {
    if (typeof p === "string" && (/^0x[0-9a-f]{1,16}$/i.test(p) || /^(latest|safe|finalized|pending|earliest)$/.test(p))) return p;
    if (p && typeof p === "object" && !Array.isArray(p)) return p.blockHash ?? p.blockNumber ?? (p.fromBlock !== undefined ? `${p.fromBlock}..${p.toBlock}` : "-");
  }
  return "-";
};
/** One upstream try's bound (FORK_RPC_UPSTREAM_MS, a test's own; 30 s by default). */
const UPSTREAM_MS = Number(process.env.FORK_RPC_UPSTREAM_MS ?? 30_000);

// A block named by its hash ({"blockHash": h}, as Foundry 1.8 asks) is the same block as its number (as 1.7 asks):
// the key names it by number, read from the recorded eth_getBlockByNumber answer. Each chain's hash map is read from
// its book once and then kept up as answer() adds to that book (a book only grows: a recorded key is never asked
// again), so a request costs no walk over every recorded answer (1.5 ms a request at 10,600 answers, 13 Nov)
const HASHES = new WeakMap();
const addHash = (byHash, k, v) => {
  if (k.startsWith("eth_getBlockByNumber ") && typeof v?.result?.hash === "string") byHash[v.result.hash.toLowerCase()] = v.result.number;
};
function hashesOf(b) {
  let byHash = HASHES.get(b);
  if (byHash === undefined) {
    byHash = {};
    for (const [k, v] of Object.entries(b)) addHash(byHash, k, v);
    HASHES.set(b, byHash);
  }
  return byHash;
}
export function keyOf(book, chain, r) {
  const byHash = book[chain] === undefined ? {} : hashesOf(book[chain]);
  const params = (r.params ?? []).map((p) =>
    p && typeof p === "object" && !Array.isArray(p) && typeof p.blockHash === "string" && byHash[p.blockHash.toLowerCase()]
      ? byHash[p.blockHash.toLowerCase()]
      : p && typeof p === "object" && !Array.isArray(p) && typeof p.blockNumber === "string" ? p.blockNumber : p,
  );
  return `${r.method} ${JSON.stringify(r.method === "eth_getLogs" ? params.map(logFilter) : params)}`;
}

// An eth_getLogs filter's topic alternatives in one order: the page asks a log's topics in a new random order on every
// read (each position's list is one OR set), so the same read is one key whatever the order it came in
const logFilter = (f) => (f && typeof f === "object" && Array.isArray(f.topics) ? { ...f, topics: f.topics.map((t) => (Array.isArray(t) ? [...t].sort() : t)) } : f);
/** A book read from its file, each key in that one order (a book recorded before it holds the same answer twice). */
const normal = (book) =>
  Object.fromEntries(Object.entries(book).map(([c, b]) => [c, Object.fromEntries(Object.entries(b).map(([k, v]) => {
    const at = k.indexOf(" ");
    return [k.slice(0, at) === "eth_getLogs" ? `eth_getLogs ${JSON.stringify(JSON.parse(k.slice(at + 1)).map(logFilter))}` : k, v];
  }))]));

/** Answers one JSON-RPC request (or a batch) for `chain` from `book`, or from upstream when recording. */
export async function answer(book, chain, req, record) {
  if (Array.isArray(req)) return Promise.all(req.map((r) => answer(book, chain, r, record)));
  const key = keyOf(book, chain, req);
  const have = book[chain]?.[key];
  if (have !== undefined) return { jsonrpc: "2.0", id: req.id, ...have };
  if (!record || !UPSTREAM[chain]) {
    console.error(`fork-rpc: not recorded for ${chain}: ${key}`);
    return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: `fork-rpc: not recorded for ${chain}: ${key}` } };
  }
  // each try is bounded (UPSTREAM_MS), then a failure that names the read: an upstream that never answers once held
  // anvil's fork reads, and so every request to the fork, for 300 s
  // a chain's upstreams in turn, one request after another (a list spreads a burst of fork reads over its providers),
  // each try on the next; a provider's answer that it lacks the block's state is a failed try, never recorded
  // a log read only to the providers that serve the page's wide ranges (base.drpc.org answers 400 and 1rpc.io 410 to a
  // 50,000-block eth_getLogs, read 13 Nov 03:4xZ; mainnet.base.org answered 429 to all 100 of a copy run's log reads,
  // 13 Nov 04:23-04:27Z, each after about 2.4 s)
  const all = [UPSTREAM[chain]].flat();
  const wide = all.filter((u) => !/drpc\.org|1rpc\.io|mainnet\.base\.org/.test(u));
  // and a block by number: mainnet.base.org and base.drpc.org answered 429 to most of a copy run's (13 Nov 06:4xZ)
  const fit = (req.method === "eth_getLogs" || req.method === "eth_getBlockByNumber") && wide.length > 0 ? wide : all;
  // and none that answered 403 this run while another is left: it refused this machine (robinhood-rpc.publicnode.com
  // answered 403 to 711 of a Robinhood copy run's reads from one test machine, 13 Nov 09:1xZ, each try a backoff)
  const open = fit.filter((u) => !REFUSED.has(new URL(u).host));
  const list = open.length > 0 ? open : fit;
  const sent = (u) => SENT.get(new URL(u).host) ?? 0;
  if (list.every((u) => sent(u) >= UPSTREAM_CAP)) throw new Error(`fork-rpc: ${UPSTREAM_CAP} upstream requests, stopped (${key}): ${list.map((u) => new URL(u).host).join(", ")} each at the cap`);
  const first = (turn[chain] = ((turn[chain] ?? -1) + 1) % list.length);
  let got;
  for (let i = 0; i < 5 && !got; i++) {
    // the next host with room: one at the cap is asked nothing more
    const url = [...Array(list.length).keys()].map((k) => list[(first + i + k) % list.length]).find((u) => sent(u) < UPSTREAM_CAP);
    if (url === undefined) break;
    SENT.set(new URL(url).host, sent(url) + 1);
    console.error(`fork-rpc: upstream ${new URL(url).host} ${sent(url)} ${chain}: ${key.slice(0, 160)}`);
    const t0 = Date.now();
    let outcome = "ok";
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...req, id: 1 }), signal: AbortSignal.timeout(UPSTREAM_MS) });
      if (res.ok) {
        const j = await res.json();
        if (STATELESS.test(String(j?.error?.message ?? ""))) outcome = `no state: ${String(j.error.message).slice(0, 80)}`;
        else got = j;
      } else {
        outcome = `http ${res.status}`;
        if (res.status === 403) REFUSED.add(new URL(url).host);
        // a 429 is waited out as the provider names it (Retry-After), never pushed
        if (res.status === 429) await new Promise((r) => setTimeout(r, 1000 * Math.min(30, Number(res.headers.get("retry-after")) || 2 ** (i + 1))));
      }
    } catch (e) {
      outcome = String(e?.name ?? "error");
    }
    const ms = Date.now() - t0;
    // each slow or failed upstream read, by its host, method and block (no path, no key)
    const h = (HOSTS[new URL(url).host] ??= { ok: 0, failed: 0, s429: 0, ms: 0 });
    h.ms += ms;
    if (outcome === "ok") h.ok++;
    else if (outcome === "http 429") h.s429++;
    else h.failed++;
    if (outcome !== "ok" || ms > SLOW_MS) console.error(`fork-rpc upstream ${new URL(url).host} ${req.method} ${blockTagOf(req)} ${ms} ms ${outcome}`);
    if (!got) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  if (!got) throw new Error(`fork-rpc: ${list.map((u) => new URL(u).host).join(", ")} did not answer ${key} in 5 tries of ${UPSTREAM_MS / 1000} s`);
  const kept = "error" in got ? { error: got.error } : { result: got.result };
  const b = (book[chain] ??= {});
  b[key] = kept;
  if (HASHES.has(b)) addHash(HASHES.get(b), key, kept);
  return { jsonrpc: "2.0", id: req.id, ...kept };
}

export function serve(book, record) {
  const server = createServer((q, s) => {
    let body = "";
    q.on("data", (c) => (body += c));
    q.on("end", async () => {
      const chain = q.url.replace(/^\/+/, "");
      try {
        const out = await answer(book, chain, JSON.parse(body), record);
        s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      } catch (e) {
        s.writeHead(502).end(String(e));
      }
    });
  });
  return new Promise((ok) => server.listen(PORT, "127.0.0.1", () => ok(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const record = args.indexOf("--record") >= 0 && args.indexOf("--record") < args.indexOf("--");
  const cmd = args.slice(args.indexOf("--") + 1);
  if (args.indexOf("--") < 0 || cmd.length === 0) {
    console.error("usage: fork-rpc.mjs [--record] -- <command...>");
    process.exit(2);
  }
  // recording adds to what is recorded, so runs with two Foundry versions each add what theirs asks
  const book = existsSync(FILE) ? normal(JSON.parse(readFileSync(FILE, "utf8"))) : {};
  // an answer recorded from a provider that lacked the state or was over its limit is no answer: dropped, asked again
  for (const b of Object.values(book)) for (const [k, v] of Object.entries(b)) if (STATELESS.test(String(v?.error?.message ?? ""))) delete b[k];
  const server = await serve(book, record);
  // forge runs as a child while this process answers its requests
  // the child names the copy's upstreams in its record (no path, no key: hosts only)
  process.env.FORK_RPC_UPSTREAMS = JSON.stringify(Object.fromEntries(Object.entries(UPSTREAM ?? {}).map(([c, u]) => [c, [u].flat().map((x) => new URL(x).host)])));
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
  const code = await new Promise((ok) => child.on("exit", (c) => ok(c ?? 1)));
  server.close();
  if (record) {
    const sorted = Object.fromEntries(Object.keys(book).sort().map((c) => [c, Object.fromEntries(Object.entries(book[c]).sort())]));
    writeFileSync(FILE, JSON.stringify(sorted, null, 1) + "\n");
    // the copy's upstreams, each one's tries: a copy stall is read as the upstreams', never as the product's
    console.error(`fork-rpc: upstreams ${JSON.stringify(HOSTS)}`);
    console.error(`fork-rpc: wrote ${Object.values(book).reduce((n, b) => n + Object.keys(b).length, 0)} answers to ${FILE}`);
  }
  process.exit(code);
}
