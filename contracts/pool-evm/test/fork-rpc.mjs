// SPDX-License-Identifier: Apache-2.0
// The fork tests' RPC (test/BuyFork.t.sol), served from test/fixtures/fork-rpc.json: every JSON-RPC answer the tests
// need, recorded once from the chains' public RPCs at the pinned blocks. Replaying it, forge reads no network, so the
// fork tests give the same answer on every run and cannot fail on a public RPC. A request that was not recorded is
// answered with an error that names it, so the test fails loudly instead of reaching a chain.
//   node contracts/pool-evm/test/fork-rpc.mjs -- forge test --root contracts/pool-evm     replay, run forge, exit with its code
//   node contracts/pool-evm/test/fork-rpc.mjs --record -- forge test --mp test/BuyFork.t.sol --no-storage-caching
//                                   (from contracts/pool-evm) record from the public RPCs below, then write the file
// foundry.toml's rpc_endpoints point at http://127.0.0.1:47545/<chain>.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fork-rpc.json");
const PORT = 47545;
const UPSTREAM = { base: "https://mainnet.base.org", robinhood: "https://rpc.mainnet.chain.robinhood.com" };

const keyOf = (r) => `${r.method} ${JSON.stringify(r.params ?? [])}`;

/** Answers one JSON-RPC request (or a batch) for `chain` from `book`, or from upstream when recording. */
async function answer(book, chain, req, record) {
  if (Array.isArray(req)) return Promise.all(req.map((r) => answer(book, chain, r, record)));
  const key = keyOf(req);
  const have = book[chain]?.[key];
  if (have !== undefined) return { jsonrpc: "2.0", id: req.id, ...have };
  if (!record || !UPSTREAM[chain]) {
    return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: `fork-rpc: not recorded for ${chain}: ${key}` } };
  }
  let got;
  for (let i = 0; i < 5 && !got; i++) {
    try {
      const res = await fetch(UPSTREAM[chain], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...req, id: 1 }) });
      if (res.ok) got = await res.json();
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
  const record = args[0] === "--record";
  const cmd = args.slice(args.indexOf("--") + 1);
  if (args.indexOf("--") < 0 || cmd.length === 0) {
    console.error("usage: fork-rpc.mjs [--record] -- <command...>");
    process.exit(2);
  }
  const book = record ? {} : JSON.parse(readFileSync(FILE, "utf8"));
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
