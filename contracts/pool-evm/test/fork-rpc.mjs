// SPDX-License-Identifier: Apache-2.0
// The fork tests' RPC (test/BuyFork.t.sol), served from test/fixtures/fork-rpc.json: every JSON-RPC answer the tests
// need, recorded once from the chains' public RPCs at the pinned blocks. Replaying it, forge reads no network, so the
// fork tests give the same answer on every run and cannot fail on a public RPC. A request that was not recorded is
// answered with an error that names it, so the test fails loudly instead of reaching a chain.
//   node contracts/pool-evm/test/fork-rpc.mjs -- forge test --root contracts/pool-evm     replay, run forge, exit with its code
//   node contracts/pool-evm/test/fork-rpc.mjs --record -- forge test --mp test/BuyFork.t.sol --no-storage-caching
//                                   (from contracts/pool-evm) add what is not recorded yet from the public RPCs below
//                                   (each read tried twice, 30 s each), then write the file
// foundry.toml's rpc_endpoints point at http://127.0.0.1:47545/<chain>.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fork-rpc.json");
const PORT = 47545;
/** One upstream try's bound (FORK_RPC_UPSTREAM_MS, a test's own; 30 s by default). */
const UPSTREAM_MS = Number(process.env.FORK_RPC_UPSTREAM_MS ?? 30_000);
const UPSTREAM = { base: "https://mainnet.base.org", robinhood: "https://rpc.mainnet.chain.robinhood.com" };

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
  return `${r.method} ${JSON.stringify(params)}`;
}

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
  // each try is bounded (UPSTREAM_MS), then one more, then a failure that names the read: an upstream that never
  // answers once held anvil's fork reads, and so every request to the fork, for 300 s
  let got;
  for (let i = 0; i < 2 && !got; i++) {
    try {
      const res = await fetch(UPSTREAM[chain], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...req, id: 1 }), signal: AbortSignal.timeout(UPSTREAM_MS) });
      if (res.ok) got = await res.json();
    } catch {}
    if (!got && i === 0) await new Promise((r) => setTimeout(r, 500));
  }
  if (!got) throw new Error(`fork-rpc: ${UPSTREAM[chain]} did not answer ${key} in 2 tries of ${UPSTREAM_MS / 1000} s`);
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
  const record = args[0] === "--record";
  const cmd = args.slice(args.indexOf("--") + 1);
  if (args.indexOf("--") < 0 || cmd.length === 0) {
    console.error("usage: fork-rpc.mjs [--record] -- <command...>");
    process.exit(2);
  }
  // recording adds to what is recorded, so runs with two Foundry versions each add what theirs asks
  const book = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
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
