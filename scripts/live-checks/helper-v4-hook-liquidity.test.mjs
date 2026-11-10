// node --test scripts/live-checks/helper-v4-hook-liquidity.test.mjs: the live check replays recorded answers
// (helper-v4-hook-liquidity.answers.json). good: apps/helper at the card's fix (14067ea) run on a Mac against Base's real
// lists and providers, every judged v4 trade the token its trader moved, PASS. bad: the deployed helper at 46c6593 read
// 3 minutes before, the buy in Base tx 0x454c1f11 on its tape as the pool's 2,357.007 where its trader got 2,332.259,
// FAIL. robinhood: the fix against Robinhood, where routers send the take straight to the trader, PASS. quiet: ten
// Base tapes of a live read of 2026-11-10 06:29Z with no trade on them (a launch-only market): INCONCLUSIVE, exit 3.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SWAP_RPCS } from "../../apps/helper/src/data/evm/swaps.ts";
import { noAnswerHosts } from "../ci/live-rerun.mjs";
import { BUDGET_MS, EXIT, judge, MAX_TOKENS, read, TOKENS } from "./helper-v4-hook-liquidity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-v4-hook-liquidity.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const judgedOf = (r) => Number(r.lines.find((l) => /^ok {2}\d+ v4 trades? judged/.test(l))?.match(/\d+/)?.[0] ?? 0);
const TX454 = "0x454c1f113ccd21df881cf0539e92367a7359474550f5d47eb6c51cb32a10a11f";

/** A fetch that answers a recorded run: the lists (its coins as the New list), the tapes, and the providers' replies,
 *  one call or a batch. */
function replay(run) {
  const chain = run.chain ?? "base";
  return async (url, init) => {
    const u = String(url);
    if (SWAP_RPCS[chain].includes(u)) {
      const q = JSON.parse(init.body);
      const one = (c) => ({ jsonrpc: "2.0", id: c.id, result: (c.method === "eth_getTransactionReceipt" ? run.receipts[c.params[0]] : c.method === "eth_call" ? `0x${(run.decimals[c.params[0].to] ?? 18).toString(16).padStart(64, "0")}` : undefined) ?? null });
      return Response.json(Array.isArray(q) ? q.map(one) : one(q));
    }
    if (u.endsWith(`/v1/market/lists?chain=${chain}`)) return Response.json({ lists: { new: run.coins.map((c) => ({ ["tok" + "en"]: c })) } });
    const coin = new URL(u).searchParams.get("token");
    const t = run.tapes[coin];
    return t.status === 200 ? Response.json({ trades: t.trades, src: "chain", as_of_ms: 0 }) : Response.json({ error: { code: "upstream" } }, { status: t.status });
  };
}

test("good: the fix's Base tapes, every judged v4 trade the token its trader moved (Base tx 0x454c1f11's buy the 2,332.259 its trader got): PASS, read again from its answers the same", async () => {
  const r = judge(A.good);
  assert.ok(r.ok, bad(r).join("\n"));
  assert.ok(judgedOf(r) >= 50, r.lines.at(-1));
  const t = A.good.tapes["0x7a6d797910c7148d6f598146b56ebe9b789f7ba3"].trades.find((x) => x.tx === TX454 && x.side === "b");
  assert.equal(t.amt, "2332.259212434009614487");
  const again = await read("https://helper.test", replay(A.good));
  assert.deepEqual(judge(again).lines, r.lines);
});

test("bad: 46c6593's tape shows Base tx 0x454c1f11's buy as the pool's 2,357.007, its hook's cut counted in: FAIL, naming it", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, 1, b.join("\n"));
  assert.match(b[0], /0x7a6d797910c7148d6f598146b56ebe9b789f7ba3 trade 0x454c1f11.* amt 2357\.007794273885411305 is not the 2332259212434009614487 its trader 0x103502909141f7025a94b7b99a276dcd128e21a8 got/);
});

test("robinhood: the fix's Robinhood tapes, where a router sends the take straight to the trader, judged and PASS, read again the same", async () => {
  const r = judge(A.robinhood);
  assert.ok(r.ok, bad(r).join("\n"));
  assert.ok(judgedOf(r) >= 50, r.lines.at(-1));
  const again = await read("https://helper.test", replay(A.robinhood), "robinhood");
  assert.deepEqual(judge(again).lines, r.lines);
});

test("a receipt two providers answered and differ on, or no token on the lists, is a BAD line: FAIL", () => {
  assert.match(bad(judge({ ...A.good, receipts: { ...A.good.receipts, [TX454]: null } })).join("\n"), /two providers answered and their receipts differ/);
  assert.equal(judge({ ...A.good, receipts: { ...A.good.receipts, [TX454]: null } }).verdict, "FAIL");
  const r = judge({ ...A.good, coins: [] });
  assert.match(bad(r).join("\n"), /no base token read from the lists/);
  assert.equal(r.verdict, "FAIL");
});

test("quiet market, recorded: ten live Base tapes with no trade on them judge nothing: INCONCLUSIVE (exit 3), no BAD line, never a pass, and the lines say what was read", () => {
  const r = judge(A.quiet);
  assert.equal(r.verdict, "INCONCLUSIVE");
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), []);
  assert.equal(EXIT[r.verdict], 3);
  assert.ok(r.lines.includes("ok  read 10 of 10 base tapes, 0 trades, 0 receipts agreed by two providers"), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^INCONCLUSIVE no v4 trade to judge on 10 base tapes \(0 trades read, 0 with no single sender's move of the token\): nothing checked, not a pass$/.test(l)), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => /v4 trades? judged/.test(l)));
  // trades whose receipts name no single sender's move of the token are the same quiet market
  const none = { ...A.good, receipts: Object.fromEntries(Object.entries(A.good.receipts).map(([tx, x]) => [tx, x && { ...x, logs: x.logs.filter((l) => l.topics?.[0] !== "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f") }])) };
  const q = judge(none);
  assert.equal(q.verdict, "INCONCLUSIVE");
  assert.deepEqual(bad(q), []);
  assert.match(q.lines.join("\n"), /INCONCLUSIVE no v4 trade to judge on \d+ base tapes \(\d+ trades read, [1-9]\d* with no single sender's move/);
});

test("the good, bad and robinhood answers print what they read, and PASS or FAIL as before", () => {
  for (const [name, verdict] of [["good", "PASS"], ["bad", "FAIL"], ["robinhood", "PASS"]]) {
    const r = judge(A[name]);
    assert.equal(r.verdict, verdict, name);
    assert.ok(r.lines.some((l) => /^ok {2}read \d+ of \d+ \w+ tapes, \d+ trades, \d+ receipts agreed by two providers$/.test(l)), name);
  }
});

/** A recorded run of the first TOKENS quiet coins (the ten live quiet tapes and two empty tapes) and then `more`, a list of
 *  [coin, run] whose tapes and receipts come from that recorded run. */
const quietThen = (more) => {
  const empty = ["0x" + "1".repeat(40), "0x" + "2".repeat(40)];
  const coins = [...A.quiet.coins, ...empty];
  const run = { ...A.quiet, coins, tapes: { ...A.quiet.tapes, ...Object.fromEntries(empty.map((c) => [c, { status: 200, trades: [] }])) }, decimals: {}, receipts: {} };
  assert.equal(coins.length, TOKENS);
  for (const [coin, from] of more) {
    run.coins.push(coin);
    run.tapes[coin] = from.tapes[coin];
    run.decimals[coin] = from.decimals[coin];
    for (const t of from.tapes[coin].trades) run.receipts[t.tx] = from.receipts[t.tx];
  }
  return run;
};
const COIN = "0x7a6d797910c7148d6f598146b56ebe9b789f7ba3";
/** How many tapes a replayed read asked for. */
const counting = (run) => {
  const f = replay(run);
  const asked = [];
  return { asked, fetch: async (u, i) => (String(u).includes("/v1/market/trades?") && asked.push(new URL(String(u)).searchParams.get("token")), f(u, i)) };
};

test("a quiet first twelve tapes: the read goes on to the next coin of the lists; a trade there is judged and PASSes, a wrong one FAILs naming it (the cut counted in: 46c6593's 2,357.007)", async () => {
  for (const [from, verdict] of [[A.good, "PASS"], [A.bad, "FAIL"]]) {
    const run = quietThen([[COIN, from]]);
    const c = counting(run);
    const got = await read("https://helper.test", c.fetch);
    assert.equal(got.coins.length, TOKENS + 1);
    assert.equal(c.asked.length, TOKENS + 1);
    const r = judge(got);
    assert.equal(r.verdict, verdict, r.lines.join("\n"));
    if (verdict === "FAIL") assert.match(bad(r).join("\n"), /trade 0x454c1f11.* amt 2357\.007794273885411305 is not the 2332259212434009614487 its trader/);
    else assert.ok(judgedOf(r) > 0);
  }
});

test("a first twelve with a judgeable trade reads no more tapes; one that is quiet reads on only to MAX_TOKENS tapes and to BUDGET_MS", async () => {
  const lone = { ...A.good, coins: [...A.good.coins, ...Array.from({ length: 5 }, (_, i) => `0x${String(i + 3).repeat(40)}`)] };
  for (const c of lone.coins.slice(A.good.coins.length)) lone.tapes[c] = { status: 200, trades: [] };
  const a = counting(lone);
  await read("https://helper.test", a.fetch);
  assert.equal(a.asked.length, TOKENS, "judgeable trades in the first twelve: no more read");
  // nothing to judge on a long list: stops at MAX_TOKENS
  const longList = { ...A.quiet, coins: Array.from({ length: MAX_TOKENS + 10 }, (_, i) => `0x${(i + 16).toString(16).padStart(2, "0").repeat(20)}`) };
  longList.tapes = Object.fromEntries(longList.coins.map((c) => [c, { status: 200, trades: [] }]));
  const b = counting(longList);
  const got = await read("https://helper.test", b.fetch);
  assert.equal(b.asked.length, MAX_TOKENS);
  assert.equal(judge(got).verdict, "INCONCLUSIVE");
  // a spent budget stops the widening at the first twelve
  let t = 0;
  const c = counting(longList);
  await read("https://helper.test", c.fetch, "base", undefined, { budgetMs: BUDGET_MS, now: () => (t += BUDGET_MS) });
  assert.equal(c.asked.length, TOKENS);
});

test("the command: a quiet market ends INCONCLUSIVE with exit 3 and the verdict line the live run reads; a lists answer of 503 is a FAIL, exit 1", async () => {
  const lists = { lists: { new: A.quiet.coins.map((c) => ({ ["tok" + "en"]: c })), trending: [] } };
  let down = false;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (down) return res.writeHead(503).end("{}");
    res.end(JSON.stringify(req.url.startsWith("/v1/market/lists") ? lists : { trades: [], src: "chain", as_of_ms: 0 }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = () =>
    new Promise((ok) => {
      const p = spawn(process.execPath, [path.join(HERE, "helper-v4-hook-liquidity.mjs"), "--base", base], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => ok({ status, stdout, stderr }));
    });
  try {
    const quiet = await run();
    assert.equal(quiet.status, 3, quiet.stdout + quiet.stderr);
    assert.match(quiet.stdout, /\nINCONCLUSIVE no v4 trade to judge on 10 base tapes/);
    assert.match(quiet.stdout, /live-check helper-v4-hook-liquidity: INCONCLUSIVE \(http:\/\/127\.0\.0\.1:\d+, base\)\n$/);
    down = true;
    const dead = await run();
    assert.equal(dead.status, 1, dead.stdout + dead.stderr);
    assert.match(dead.stdout, /live-check helper-v4-hook-liquidity: FAIL/);
  } finally {
    server.close();
  }
});

// Base tx 0xfaaa9cc9... (block 53,537,870), cut to its launch-trade logs: the buy's Swap (178), the hook's cut paid out
// to it (180), the pool's ModifyLiquidity (189), and the buyer's 44,726,051,716,064 minted as PoolManager claims (197).
const FAAA = "0xfaaa9cc939fffb787b906da0c1309746e5229d722df371b1a44322b2994c1460";
const coin = "0xe2969931f5f0d2e2d53e8077e6a923b16512eba3";
const PM = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const POOL = "0x894c4d2aac7d50f1a6e4367e2928a0a1bb876a9cb435d43fe024d2fcd76ef173";
const word = (a) => `0x${a.slice(2).padStart(64, "0")}`;
const CLAIMS_BUY = {
  logs: [
    { address: PM, topics: ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", POOL, word("0xf8cd946adb3e56c6c246fd8eaa32c4c94ec889ed")], data: "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff79d00000000000000000000000000000000000000000000000000002e65fc1021b80000000000000000000000000000000000025c64ad57fb18d558a41852b05664000000000000000000000000000000000000000000000bd1819559a425426917000000000000000000000000000000000000000000000000000000000003a5970000000000000000000000000000000000000000000000000000000000001b58" },
    { address: coin, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", word(PM), word("0x9982538f41f2ae29ddb9d3d9307010052984fdbb")], data: "0x000000000000000000000000000000000000000000000000000005b863a365d8" },
    { address: PM, topics: ["0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec", POOL, word("0x9982538f41f2ae29ddb9d3d9307010052984fdbb")], data: "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffff2766000000000000000000000000000000000000000000000000000000000000d89a0000000000000000000000000000000000000000000000000000000000050455f84d425564d25e000e629db464057c45d862ce4a5dd192c74cfc9ab2250404026" },
    { address: PM, topics: ["0x1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac728859", word("0x0"), word("0xf8cd946adb3e56c6c246fd8eaa32c4c94ec889ed"), word(coin)], data: "0x000000000000000000000000f8cd946adb3e56c6c246fd8eaa32c4c94ec889ed000000000000000000000000000000000000000000000000000028ad986cbbe0" },
  ],
};
const claimsRun = (amt) => ({ coins: [coin], tapes: { [coin]: { status: 200, trades: [{ tx: FAAA, side: "b", amt }] } }, decimals: { [coin]: 18 }, receipts: { [FAAA]: CLAIMS_BUY } });

test("a buy taken as PoolManager claims by its router (Base tx 0xfaaa9cc9...) is judged against the claims minted to it: the 44,726,051,716,064 its buyer got PASSes, 04bb10f's 0.000051015555490232 (live run 41990876403) FAILs", () => {
  const r = judge(claimsRun("0.000044726051716064"));
  assert.ok(r.ok, bad(r).join("\n"));
  assert.equal(judgedOf(r), 1);
  assert.match(bad(judge(claimsRun("0.000051015555490232"))).join("\n"), /amt 0\.000051015555490232 is not the 44726051716064 its trader 0xf8cd946adb3e56c6c246fd8eaa32c4c94ec889ed got/);
});

// ------------------------------------------------------------------------------------------------ a provider's no-answer
// Base tx 0xfaaa9cc9's real receipt (above), asked of three providers, each behaving as planted: it answers, it is silent
// (a 429, a 503 or a fetch that fails), or it answers a receipt that differs (one log left out).
const HOSTS = ["https://rpc-a.test", "https://rpc-b.test", "https://rpc-c.test"];
function providers(behave) {
  const run = claimsRun("0.000044726051716064");
  return async (url, init) => {
    const u = String(url);
    const host = HOSTS.find((h) => u === h);
    if (host === undefined) return replay(run)(url, init);
    const how = behave[HOSTS.indexOf(host)];
    if (how === "throws") throw Object.assign(new Error("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    if (how === "429") return new Response("{}", { status: 429 });
    if (how === "503") return new Response("upstream", { status: 503 });
    const q = JSON.parse(init.body);
    const one = (c) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "eth_getTransactionReceipt" ? (how === "differs" ? { ...CLAIMS_BUY, logs: CLAIMS_BUY.logs.slice(1) } : CLAIMS_BUY) : `0x${(18).toString(16).padStart(64, "0")}` });
    return Response.json(q.map(one));
  };
}
const quietRun = (behave) => read("https://helper.test", providers(behave), "base", HOSTS);

test("one provider answers and the other two are silent (a 429, a 503, a timed-out fetch): the receipt has fewer than two answers, INCONCLUSIVE (exit 3), worded for the rerun to name the silent hosts, no BAD line", async () => {
  for (const behave of [["ok", "429", "503"], ["throws", "ok", "429"], ["503", "throws", "ok"]]) {
    const got = await quietRun(behave);
    assert.deepEqual(Object.keys(got.quiet), [`receipt ${FAAA}`]);
    const r = judge(got);
    assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
    assert.equal(EXIT[r.verdict], 3);
    assert.deepEqual(bad(r), []);
    const silent = HOSTS.map((h, i) => [new URL(h).host, behave[i]]).filter(([, how]) => how !== "ok").map(([h]) => h).sort();
    assert.deepEqual(noAnswerHosts(r.lines.join("\n")), silent, r.lines.join("\n"));
    assert.match(r.lines.join("\n"), /INCONCLUSIVE receipt 0xfaaa9cc9\w+: .*(HTTP (429|503): |: no answer \(ETIMEDOUT\))/);
    assert.match(r.lines.join("\n"), /1 read fewer than two providers answered/);
  }
});

test("one provider silent and two that answer alike: the receipt is agreed, judged, PASS; two that answer and differ: FAIL naming it, even with a third silent", async () => {
  const pass = judge(await quietRun(["429", "ok", "ok"]));
  assert.equal(pass.verdict, "PASS", pass.lines.join("\n"));
  assert.equal(judgedOf(pass), 1);
  for (const behave of [["ok", "differs", "ok"], ["differs", "ok", "429"], ["ok", "429", "differs"]]) {
    const r = judge(await quietRun(behave));
    assert.equal(r.verdict, "FAIL", behave.join());
    assert.equal(EXIT[r.verdict], 1);
    assert.match(bad(r).join("\n"), /trade 0xfaaa9cc9\w+: two providers answered and their receipts differ/);
  }
});

test("a wrongly reported v4 trade is a FAIL whatever else was read, a silent receipt beside it included; a silent receipt beside good trades is no pass", () => {
  const withQuiet = (run) => ({ ...run, quiet: { "receipt 0x1111111111111111111111111111111111111111111111111111111111111111": ["rpc-a.test: no answer (ETIMEDOUT)", "rpc-b.test HTTP 429: 429 Too Many Requests"] } });
  const wrong = judge(withQuiet(A.bad));
  assert.equal(wrong.verdict, "FAIL");
  assert.match(bad(wrong).join("\n"), /amt 2357\.007794273885411305 is not the 2332259212434009614487/);
  const good = judge(withQuiet(A.good));
  assert.equal(good.verdict, "INCONCLUSIVE");
  assert.equal(good.ok, false);
  assert.ok(judgedOf(good) >= 50, "the trades it could judge are still judged");
  assert.deepEqual(noAnswerHosts(good.lines.join("\n")), ["rpc-a.test", "rpc-b.test"]);
});

test("the token's decimals met by fewer than two providers: the trade is not judged and the run is INCONCLUSIVE, not a BAD amount", async () => {
  const run = claimsRun("0.000044726051716064");
  const f = providers(["ok", "ok", "ok"]);
  const noCall = async (url, init) => {
    if (HOSTS.includes(String(url)) && JSON.parse(init.body)[0].method === "eth_call") return new Response("{}", { status: 429 });
    return f(url, init);
  };
  const got = await read("https://helper.test", noCall, "base", HOSTS);
  assert.deepEqual(Object.keys(got.quiet), [`decimals of ${coin}`]);
  const r = judge(got);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.deepEqual(bad(r), []);
  assert.equal(run.decimals[coin], 18);
});
