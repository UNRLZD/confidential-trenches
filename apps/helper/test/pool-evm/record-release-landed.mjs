// Writes apps/helper/src/pool/fixtures/release-landed.json (card helper-evm-sender-2): every withdraw and buy the
// testnet runs landed (scripts/live-checks/pool-evm-testnet-run.<network>.json), each read with
// eth_getTransactionByHash on two public RPCs of its chain, which must agree byte for byte on its input and its target,
// and with eth_getTransactionReceipt on both (status 1). Only what the helper's test reads is kept: the network, the
// hash, the pool it ran on, its calldata and the W the run named (the recipient that signed it).
//   node apps/helper/test/pool-evm/record-release-landed.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const OUT = join(ROOT, "apps/helper/src/pool/fixtures/release-landed.json");
const RPCS = {
  "base-sepolia": ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
  "robinhood-testnet": ["https://rpc.testnet.chain.robinhood.com", "https://robinhood-testnet.drpc.org"],
};
async function call(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  const j = await r.json();
  if (j.error || j.result == null) throw new Error(`${url} ${method}: ${JSON.stringify(j.error ?? null)}`);
  return j.result;
}
const txs = [];
for (const [network, urls] of Object.entries(RPCS)) {
  const run = JSON.parse(readFileSync(join(ROOT, `scripts/live-checks/pool-evm-testnet-run.${network}.json`), "utf8"));
  for (const t of run.txs.filter((x) => x.kind === "withdraw" || x.kind === "buy")) {
    const [a, b] = await Promise.all(urls.map((u) => call(u, "eth_getTransactionByHash", [t.hash])));
    const [ra, rb] = await Promise.all(urls.map((u) => call(u, "eth_getTransactionReceipt", [t.hash])));
    if (a.input !== b.input || a.to?.toLowerCase() !== b.to?.toLowerCase()) throw new Error(`${t.hash}: the two RPCs differ`);
    if (ra.status !== "0x1" || rb.status !== "0x1") throw new Error(`${t.hash}: not status 1 on both`);
    if (a.to.toLowerCase() !== run.pool.toLowerCase()) throw new Error(`${t.hash}: not sent to the run's pool`);
    txs.push({ network, kind: t.kind, hash: t.hash, readOn: urls, pool: a.to.toLowerCase(), w: t.w, input: a.input });
  }
}
writeFileSync(OUT, `${JSON.stringify({ about: "Every withdraw and buy the testnet runs landed (scripts/live-checks/pool-evm-testnet-run.<network>.json), each read with eth_getTransactionByHash and eth_getTransactionReceipt (status 1) on two RPCs, byte-equal; only the calldata, its pool and the run's W kept", readAt: new Date().toISOString(), txs }, null, 1)}\n`);
console.log(`wrote ${OUT}: ${txs.length} txs`);
