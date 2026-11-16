// The recorded good answer of base-reads-never-throttled.answers.json: the live check's own read() against a tree's
// helper RPC in process (apps/helper/src/rpc/rpc.ts createRpc: its handle() for POST /v1/rpc/<chain>[?keyed=only] with
// the Server-Timing server.ts sends, its probe() and keyed() for /v1/health's `rpc`), with made-up QuickNode, Alchemy
// and three dRPC keys' URLs whose providers answer each read (chain ids, a block number, no logs). Nothing leaves the
// process.
//   node scripts/live-checks/base-reads-never-throttled.record-local.mjs > <file>
// Runs: once, it records the check's good answer; the bad one is the deployed helper's own run (--record).
import { createRpc } from "../../apps/helper/src/rpc/rpc.ts";
import { read, SIGN } from "./base-reads-never-throttled.mjs";

const key = (c, n) => `planted${c}${n}key123456789abcd`;
const ENV = {
  BASE_RPC_URL_QUICKNODE: `https://name-two.base-mainnet.quiknode.pro/${key("BASEqn", 0)}/`,
  ROBINHOOD_RPC_URL: `https://robinhood-mainnet.g.alchemy.com/v2/${key("RHal", 0)}`,
  ROBINHOOD_RPC_URL_QUICKNODE: `https://name-two.robinhood-mainnet.quiknode.pro/${key("RHqn", 0)}/`,
  ...Object.fromEntries([1, 2, 3].flatMap((n) => [[`BASE_RPC_URL_DRPC_${n}`, `https://lb.drpc.live/base/${key("BASEdr", n)}`], [`ROBINHOOD_RPC_URL_DRPC_${n}`, `https://lb.drpc.live/robinhood/${key("RHdr", n)}`]])),
};
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const provider = async (url, init) => {
  const req = JSON.parse(String(init.body));
  const robinhood = url.includes("robinhood");
  if (req.method === "eth_chainId") return json({ jsonrpc: "2.0", id: req.id, result: robinhood ? "0x1237" : "0x2105" });
  if (req.method === "eth_blockNumber") return json({ jsonrpc: "2.0", id: req.id, result: robinhood ? "0x6e55a85" : "0x377a871" });
  if (req.method === "eth_getBlockByNumber") return json({ jsonrpc: "2.0", id: req.id, result: { number: robinhood ? "0x6e55a00" : "0x377a800", hash: `0x${"ab".repeat(32)}` } });
  if (req.method === "eth_getLogs") return json({ jsonrpc: "2.0", id: req.id, result: [] });
  return json({ jsonrpc: "2.0", id: req.id, result: "0x" });
};
const rpc = createRpc(ENV, { fetch: provider, log: () => {} });
// as the server's probe timer does: the URLs one dRPC rate's room skipped are read on the next round
for (let i = 0; i < 3; i++) await rpc.probe(), await new Promise((r) => setTimeout(r, 400));
const helper = async (url, init) => {
  const u = new URL(url);
  if (u.pathname === "/v1/health") return new Response(JSON.stringify({ ok: true, rpc: rpc.keyed() }), { status: 200 });
  const chain = u.pathname.split("/").pop();
  const a = await rpc.handle(chain, "application/json", String(init.body), "203.0.113.9", false, u.searchParams.get("keyed") === "only");
  return new Response(a.body, { status: a.status, headers: { "access-control-allow-origin": SIGN, ...(a.timing === undefined ? {} : { "server-timing": a.timing.join(", ") }), ...(a.headers ?? {}) } });
};
const run = await read("http://in-process.test", helper, () => performance.now(), async () => {});
process.stdout.write(`${JSON.stringify(run, null, 1)}\n`);
