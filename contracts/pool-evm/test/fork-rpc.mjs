// SPDX-License-Identifier: Apache-2.0
// The fork tests' RPC (test/BuyFork.t.sol), served from test/fixtures/fork-rpc.json: every JSON-RPC answer the tests
// need, recorded once from the chains' public RPCs at the pinned blocks. Replaying it, forge reads no network, so the
// fork tests give the same answer on every run and cannot fail on a public RPC. A request that was not recorded is
// answered with an error that names it, so the test fails loudly instead of reaching a chain.
//   node contracts/pool-evm/test/fork-rpc.mjs -- forge test --root contracts/pool-evm     replay, run forge, exit with its code
//   node contracts/pool-evm/test/fork-rpc.mjs --record -- forge test --mp test/BuyFork.t.sol --no-storage-caching
//                                   (from contracts/pool-evm) add what is not recorded yet from the public RPCs below
//                                   (with up to 5 tries each), then write the file
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
  pools: { file: "fixtures/fork-rpc-pools.json", upstream: { base: "https://base-rpc.publicnode.com", robinhood: "https://rpc.mainnet.chain.robinhood.com" } },
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
/** The most upstream requests one recording makes; past it the request is refused and the run stops, so a run that
 *  loops never floods a public RPC. */
export const UPSTREAM_CAP = 400;
let upstreamN = 0;
const bookArg = process.argv.indexOf("--book");
const BOOK = BOOKS[bookArg > 0 && process.argv.indexOf("--") > bookArg ? process.argv[bookArg + 1] : "forge"];
if (!BOOK) throw new Error("fork-rpc: --book is forge or pools");
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), BOOK.file);
const PORT = Number(process.env.FORK_RPC_PORT ?? 47545);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`fork-rpc: FORK_RPC_PORT ${process.env.FORK_RPC_PORT} is no port`);
const UPSTREAM = BOOK.upstream;

// A block named by its hash ({"blockHash": h}, as Foundry 1.8 asks) is the same block as its number (as 1.7 asks):
// the key names it by number, read from the recorded eth_getBlockByNumber answer
function keyOf(book, chain, r) {
  const byHash = {};
  for (const [k, v] of Object.entries(book[chain] ?? {})) {
    if (k.startsWith("eth_getBlockByNumber ") && v.result?.hash) byHash[v.result.hash.toLowerCase()] = v.result.number;
  }
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
async function answer(book, chain, req, record) {
  if (Array.isArray(req)) return Promise.all(req.map((r) => answer(book, chain, r, record)));
  const key = keyOf(book, chain, req);
  const have = book[chain]?.[key];
  if (have !== undefined) return { jsonrpc: "2.0", id: req.id, ...have };
  if (!record || !UPSTREAM[chain]) {
    console.error(`fork-rpc: not recorded for ${chain}: ${key}`);
    return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: `fork-rpc: not recorded for ${chain}: ${key}` } };
  }
  if (++upstreamN > UPSTREAM_CAP) throw new Error(`fork-rpc: ${UPSTREAM_CAP} upstream requests, stopped (${key})`);
  console.error(`fork-rpc: upstream ${upstreamN} ${chain}: ${key.slice(0, 160)}`);
  let got;
  for (let i = 0; i < 5 && !got; i++) {
    try {
      const res = await fetch(UPSTREAM[chain], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...req, id: 1 }) });
      if (res.ok) got = await res.json();
      // a 429 is waited out as the provider names it (Retry-After), never pushed
      else if (res.status === 429) await new Promise((r) => setTimeout(r, 1000 * Math.min(30, Number(res.headers.get("retry-after")) || 2 ** (i + 1))));
    } catch {}
    if (!got) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  if (!got) throw new Error(`fork-rpc: ${UPSTREAM[chain]} did not answer ${key}`);
  const kept = "error" in got ? { error: got.error } : { result: got.result };
  (book[chain] ??= {})[key] = kept;
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
  const server = await serve(book, record);
  // forge runs as a child while this process answers its requests
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
  const code = await new Promise((ok) => child.on("exit", (c) => ok(c ?? 1)));
  server.close();
  if (record) {
    const sorted = Object.fromEntries(Object.keys(book).sort().map((c) => [c, Object.fromEntries(Object.entries(book[c]).sort())]));
    writeFileSync(FILE, JSON.stringify(sorted, null, 1) + "\n");
    console.error(`fork-rpc: wrote ${Object.values(book).reduce((n, b) => n + Object.keys(b).length, 0)} answers to ${FILE}`);
  }
  process.exit(code);
}
