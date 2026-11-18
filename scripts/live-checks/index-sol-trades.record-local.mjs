#!/usr/bin/env node
// The recorded good answer of index-sol-trades.answers.json (card index-sol-trades-2): the live check's own read()
// against this tree's Solana trade reads (apps/helper/src/data/solana/trades.ts) run in process behind the check's three
// routes, on the public mainnet endpoints (TRADES_RPCS, the public websocket), with Discover's lists passed through from
// the deployed helper (the tokens it holds are the ones this one opens). Each answer carries the given commit in
// X-Helper-Commit, its own src in X-Helper-Source and its as_of time in X-Fetched-At, as the server sets them.
//   node scripts/live-checks/index-sol-trades.record-local.mjs <commit> [--meteora] > <file>
// --meteora records the Meteora part alone ({ base, meteora }): with this process's own stream on the public websocket,
// the pump.fun part's second connection was refused five times in a row on five runs (18 Nov 14:52-14:59Z).
// Runs: once, it records the good answer (the bad one is the deployed helper's own answer before the card, read by the check)
import { createServer } from "node:http";
import { createSolanaTrades, TRADES_RPCS } from "../../apps/helper/src/data/solana/trades.ts";
import { APP, BASE, judge, judgeMeteora, METEORA, read, readBack, readMeteora } from "./index-sol-trades.mjs";

const commit = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
  console.error("usage: index-sol-trades.record-local.mjs <40-hex commit>");
  process.exit(2);
}
const lists = await fetch(`${BASE}/v1/market/lists?chain=solana`, { headers: { origin: APP }, signal: AbortSignal.timeout(10_000) });
const listsBody = await lists.text();
if (lists.status !== 200) throw new Error(`lists answered ${lists.status}`);
const held = new Set(Object.values(JSON.parse(listsBody).lists ?? {}).flat().map((r) => r.token));
const t = createSolanaTrades({ rpcs: TRADES_RPCS, listed: async (m) => held.has(m), log: () => undefined });
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const head = (a) => ({ "content-type": "application/json; charset=utf-8", "access-control-allow-origin": APP, "x-helper-commit": commit, ...(a.src ? { "x-helper-source": a.src } : {}), ...(a.asOfMs ? { "x-fetched-at": new Date(a.asOfMs).toISOString() } : {}) });
  try {
    if (u.pathname === "/v1/market/lists") return void (res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": APP, "x-helper-commit": commit }), res.end(listsBody));
    const token = u.searchParams.get("token") ?? "";
    const limit = Number(u.searchParams.get("limit") ?? 50);
    const a = u.pathname === "/v1/market/trades" ? await t.trades(token, limit) : u.pathname === "/v1/market/candles" ? await t.candles(token, u.searchParams.get("tf") ?? "1s", null, limit) : { status: 404, body: "{}" };
    res.writeHead(a.status, head(a));
    res.end(a.body);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e?.message));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const run = process.argv.includes("--meteora") ? { base, meteora: await readMeteora(base, Object.values(JSON.parse(listsBody).lists ?? {}).flat()) } : await read(base);
server.close();
t.stop();
// the Meteora trades read back again once this process's own helper has stopped: its reads on the same public RPC drew
// 429s on the check's read back (18 Nov 15:07-15:14Z); the deployed helper reads from another host
await new Promise((r) => setTimeout(r, 10_000));
for (const v of Object.keys(METEORA)) if (run.meteora?.[v]?.sig) run.meteora[v].reads = await readBack(run.meteora[v].sig);
const { ok, lines } = process.argv.includes("--meteora") ? judgeMeteora(run.meteora) : judge(run);
for (const l of lines) console.error(l);
console.error(`record-local: ${ok ? "PASS" : "FAIL"}`);
process.stdout.write(`${JSON.stringify(run, null, 1)}\n`);
process.exit(0);
