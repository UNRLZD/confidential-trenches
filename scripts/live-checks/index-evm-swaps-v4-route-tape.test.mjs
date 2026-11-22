// node --test scripts/live-checks/index-evm-swaps-v4-route-tape.test.mjs: the live check replays its recorded answers
// (index-evm-swaps-v4-route-tape.answers.json). bad_run_44942886709: live run 44942886709's tape of Base 0x86fb3335, its
// USDC side pool's rows while its cbBTC pool traded 214 swaps over the scan: FAIL by name. good_*: a helper with the
// card's change, the coin the scan picked and its whole third-quoted pool's tape: PASS. Made from the answers: a scan whose busiest third-quoted coin trades more in a v2 or v3 pool, whose pool is near
// a tie with the coin's other trading (Base 0x95669a65's two third-quoted pools, 5 against 14 swaps over 1,500 blocks and
// 65 against 53 over 12,000, read 21 Nov 23:4xZ), or with none at all, judges no coin (INCONCLUSIVE); a run that judged
// another coin than the scan picks, a tape from the vendor, or a tape short of one of the pool's swaps: each FAIL. The scan's reads go through provider-answer.mjs: a provider's 429 is left out while
// two others answer alike, and a scan every provider throttles judges nothing (INCONCLUSIVE), never FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { candidates, DOMINANCE, judge, pick, read, scan } from "./index-evm-swaps-v4-route-tape.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;
const RPCS = ["https://a.example", "https://b.example", "https://c.example"];
const PM = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const POOL = `0x${"ab".repeat(32)}`;
const COIN = `0x${"11".repeat(20)}`;
const QUOTE = `0x${"22".repeat(20)}`;
const w = (a) => a.slice(2).padStart(64, "0");
/** Providers that answer as the chain does (one third-quoted pool, 4 swaps), `down` answering 429 to everything. */
const chain = (down) => async (url, o) => {
  if (down.includes(url)) return new Response("Too Many Requests", { status: 429 });
  const one = ({ id, method, params }) => {
    const p = params[0];
    if (method === "eth_blockNumber") return { jsonrpc: "2.0", id, result: "0x3e8000" };
    if (method === "eth_getLogs" && p.address === PM) return { jsonrpc: "2.0", id, result: p.fromBlock === `0x${(0x3e8000 - 10 - 1_499).toString(16)}` ? [0, 1, 2, 3].map((i) => ({ transactionHash: `0x${String(i).repeat(64)}`, blockNumber: p.fromBlock, logIndex: `0x${i}`, topics: [p.topics[0], POOL], data: "0x" })) : [] };
    if (method === "eth_getLogs") return { jsonrpc: "2.0", id, result: [] };
    if (method === "eth_call") return { jsonrpc: "2.0", id, result: `0x${w(COIN)}${w(QUOTE)}${"0".repeat(64 * 3)}` };
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "no such method" } };
  };
  const b = JSON.parse(o.body);
  return new Response(JSON.stringify(Array.isArray(b) ? b.map(one) : one(b)), { status: 200 });
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "index-evm-swaps-v4-route-tape.answers.json"), "utf8"));
const BAD = A.bad_run_44942886709;
const GOOD = Object.entries(A).filter(([k]) => k.startsWith("good"));
const copy = (x) => JSON.parse(JSON.stringify(x));

test("bad_run_44942886709: the cbBTC pool's swaps are not on the tape, its USDC side pool's are: FAIL by name", () => {
  const v = judge(BAD);
  assert.equal(v.verdict, "FAIL", v.lines.join("\n"));
  assert.ok(v.lines.some((l) => /^BAD \d+ of \d+ swap transactions of the coin's busiest pool 0xc265b42f/.test(l)), v.lines.join("\n"));
});

test("the bad answer's own tape made whole (every swap of the cbBTC pool in its range on it) passes this check's rule", () => {
  const r = copy(BAD);
  const p = r.scan.pools.find((x) => x.id === r.pool);
  const tms = (b) => 1793901601000 + (b - 53556127) * 200;
  r.trades.body = JSON.stringify({ trades: [...p.txs].sort((a, b) => b[1] - a[1]).map(([tx, b]) => ({ t_ms: tms(b), tx })), src: "chain" });
  const v = judge(r);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
});

test("pick: a coin a v2 or v3 pool outtrades is never judged; a scan with no third-quoted coin judges none (INCONCLUSIVE)", () => {
  const r = copy(BAD);
  assert.deepEqual(pick(r.scan), { coin: r.coin, pool: r.pool });
  r.scan.elsewhere[r.coin] = { pool: `0x${"aa".repeat(20)}`, transfers: 999 };
  assert.equal(pick(r.scan), null);
  assert.equal(judge(r).verdict, "INCONCLUSIVE");
  const tie = copy(BAD);
  tie.scan.others[tie.coin] = Math.floor(tie.scan.pools.find((p) => p.id === tie.pool).n / DOMINANCE) + 1;
  assert.equal(pick(tie.scan), null, "a pool near a tie with the coin's other trading is not judged");
  tie.scan.others[tie.coin]--;
  assert.deepEqual(pick(tie.scan), { coin: tie.coin, pool: tie.pool });
  const none = copy(BAD);
  none.scan.pools = none.scan.pools.filter((p) => p.id !== none.pool);
  assert.equal(candidates(none.scan).length, 0);
  assert.equal(judge(none).verdict, "INCONCLUSIVE");
});

test("a run that judged another coin than the scan picks, or whose tape is the vendor's: FAIL", () => {
  const other = copy(BAD);
  other.coin = `0x${"bb".repeat(20)}`;
  assert.equal(judge(other).verdict, "FAIL");
  const vendor = copy(BAD);
  vendor.trades.headers["x-helper-source"] = "coingecko";
  assert.ok(judge(vendor).lines.some((l) => /^BAD trades: 200 coingecko/.test(l)));
});

for (const [name, run] of GOOD)
  test(`${name}: a helper with the card's change, the scan's coin on its third-quoted pool's whole tape: PASS; the tape short of the pool's newest swap: FAIL`, () => {
    const v = judge(run);
    assert.equal(v.verdict, "PASS", v.lines.join("\n"));
    const r = copy(run);
    const p = r.scan.pools.find((x) => x.id === r.pool);
    const keep = p.txs.filter(([, b]) => b <= r.scan.head - 120).sort((a, b) => b[1] - a[1])[0][0];
    const body = JSON.parse(r.trades.body);
    r.trades.body = JSON.stringify({ ...body, trades: body.trades.filter((t) => t.tx !== keep) });
    assert.equal(judge(r).verdict, "FAIL");
  });

test("a provider's 429 is left out, never judged: the two that answer alike read the scan", async () => {
  const s = await scan(chain([RPCS[0]]), RPCS);
  assert.equal(s.unread, undefined, s.unread);
  assert.equal(s.pools.length, 1);
  assert.deepEqual([s.pools[0].id, s.pools[0].n, s.pools[0].c0, s.pools[0].c1], [POOL, 4, COIN, QUOTE]);
});

test("a scan every provider but one throttles is unread: INCONCLUSIVE naming the no-answers, never FAIL (and the helper is never asked)", async () => {
  let asked = 0;
  const f = chain(RPCS.slice(0, 2));
  const run = await read("https://helper.example", async (u, o) => (u.startsWith("https://helper.example") && asked++, f(u, o)), RPCS);
  assert.equal(run.scan, null);
  const v = judge(run);
  assert.equal(v.verdict, "INCONCLUSIVE", v.lines.join("\n"));
  assert.equal(asked, 0);
});
