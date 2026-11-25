// node --test --test-isolation=none scripts/live-checks/notes-per-pool-evm.test.mjs: card notes-per-pool-evm's live
// check, replayed. notes-per-pool-evm.answers.json holds a real run on both mainnet pools, Base and Robinhood (good,
// card evm-trees-from-one-verified-source: no test network), and the same answers with currentTreeSize one higher on
// both RPCs (bad). The wallet's own sync runs on the replay: good passes on every chain, bad fails on every chain,
// refused by the pool's own size. Card notes-per-pool-evm-base-hang: Base's pair, on a stand-in for the chain that
// answers each provider's eth_getLogs with its own cap read live, pages the pool's whole life at the pager's full page;
// and a sync with no end fails at its deadline, naming the call it is stuck on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { CHAINS, VIEWS, check, post, replayer, spoil } from "./notes-per-pool-evm.mjs";
import { RETRY } from "./provider-answer.mjs";

const A = JSON.parse(readFileSync(new URL("./notes-per-pool-evm.answers.json", import.meta.url), "utf8"));
/** The page the pool sync's page counts are held to, in blocks: the pager's first and widest before card
 * evm-pool-sync-wide-pages (packages/wallet/src/pool/evm.ts EVM_LOG_PAGE_BLOCKS), a bound its wider pages keep. */
const PAGE = 10_000;
/** The pool sync's first page on each provider since that card (evm.ts EVM_POOL_LOG_PAGE_BLOCKS). */
const FIRST = 100_000;
/** The Base mainnet pool's deploy block, and its time (base-rpc.publicnode.com and base.rpc.blxrbdn.com alike, 15 Nov
 * 06:33Z). */
const DEPLOY_BLOCK = 54_325_671, DEPLOY_TIME = 1_794_055_509;
/** Base's head at the read below (base-rpc.publicnode.com, 15 Nov 06:33Z): the pool's life is 3,344,350 blocks. */
const HEAD = 57_670_020;
/** Each Base seat's answer to the pool's eth_getLogs over its cap, read live 15 Nov 06:33Z over 1,000, 10,000, 50,000,
 * 100,000 and 200,000 blocks from the deploy block. */
const CAPS = {
  "base-rpc.publicnode.com": [50_000, "RPC error -32701: exceed maximum block range: 50000"],
  "base.rpc.blxrbdn.com": [100_000, "RPC error -32602: query exceeds max block range 100000"],
};

/** A stand-in for Base at HEAD, a block every 200 ms, with the pool and none of its leaves: each provider's
 * eth_getLogs over its cap (CAPS) refused in its own words, every other read answered alike on every host, the deploy
 * receipt and SCOPE() as the recorded run read them. `hold(host, method)`: a call that never answers. `pages`: each
 * host's eth_getLogs calls. */
function standIn(hold = () => false) {
  const rec = A.good.base;
  const receipt = rec.find((e) => e.method === "eth_getTransactionReceipt" && e.result).result;
  const scopeSel = Object.keys(VIEWS).find((k) => VIEWS[k] === "SCOPE()");
  const scope = rec.find((e) => e.method === "eth_call" && e.params[0].data === scopeSel && e.result).result;
  const block = (n) => (n > HEAD ? null : { number: `0x${n.toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, timestamp: `0x${(DEPLOY_TIME + Math.floor((n - DEPLOY_BLOCK) / 5)).toString(16)}`, baseFeePerGas: "0x1" });
  const pages = new Map();
  const transport = async (url, method, params) => {
    const h = new URL(url).host;
    if (hold(h, method)) return new Promise(() => {});
    switch (method) {
      case "eth_getTransactionReceipt": return { result: receipt };
      case "eth_chainId": return { result: "0x2105" };
      case "eth_getBlockByNumber": return { result: block(params[0] === "latest" ? HEAD : params[0] === "finalized" ? HEAD - 6_000 : Number(BigInt(params[0]))) };
      case "eth_getBlockByHash": return { result: block(Number(BigInt(params[0]))) };
      case "eth_call": return { result: params[0].data === scopeSel ? scope : `0x${"0".repeat(64)}` };
      case "eth_getLogs": {
        pages.set(h, (pages.get(h) ?? 0) + 1);
        const size = Number(BigInt(params[0].toBlock) - BigInt(params[0].fromBlock)) + 1;
        return CAPS[h] && size > CAPS[h][0] ? { error: CAPS[h][1] } : { result: [] };
      }
    }
    return { error: `unexpected ${method}` };
  };
  return { transport, pages };
}

test("the recorded good run passes on both chains, through the sync's every step", async () => {
  assert.deepEqual(Object.keys(A.good).sort(), Object.keys(CHAINS).sort());
  for (const name of Object.keys(CHAINS)) {
    const r = await check(name, replayer(A.good[name]), { wait: false });
    assert.equal(r.ok, true, `${name}: ${r.lines.join("\n")}`);
    assert.equal(r.lines.length, 6, name);
    assert.match(r.lines[0], new RegExp(`deploy tx ${CHAINS[name].deployTx} in block \\d+`));
    assert.match(r.lines[2], /finalized anchor \d+ 0x[0-9a-f]{64} on both/);
    assert.match(r.lines[3], /newest agreed anchor \d+ 0x[0-9a-f]{64} on both/);
    assert.match(r.lines[4], /currentTreeSize [1-9]\d*, .* currentLabelTreeSize [1-9]\d* at the newest anchor, on both; depth \d+ \(\d+ calls in [\d.]+ s\)/);
    // both pools hold leaves now: the cut at the pool's time is read on both
    assert.match(r.lines[5], /the cut before \d+ ms \([1-9]\d* state, [1-9]\d* label leaves\): stateRootTimes\(\d+\) and labelRootTimes\(\d+\)/);
  }
  // the Base run read the pool's life at the pager's full page on each provider
  const span = Number(BigInt(A.good.base.find((e) => e.method === "eth_getBlockByNumber" && e.params[0] === "latest").result.number)) - DEPLOY_BLOCK + 1;
  for (const u of CHAINS.base.rpcs) {
    const n = A.good.base.filter((e) => e.method === "eth_getLogs" && e.url === u).length;
    assert.ok(n <= Math.ceil(span / PAGE) + 10, `${u}: ${n} pages for ${span} blocks`);
  }
});

test("the recorded bad run (currentTreeSize one higher on both RPCs) fails on both chains, and is the good run but that", async () => {
  const size = Object.keys(VIEWS).find((k) => VIEWS[k] === "currentTreeSize()");
  for (const name of Object.keys(CHAINS)) {
    assert.deepEqual(A.bad[name], spoil(A.good[name]), name);
    const changed = A.bad[name].filter((e, i) => JSON.stringify(e) !== JSON.stringify(A.good[name][i]));
    assert.ok(changed.length >= 2 && changed.every((e) => e.params[0].data === size), name);
    const r = await check(name, replayer(A.bad[name]), { wait: false });
    assert.equal(r.ok, false, name);
    assert.match(r.lines.at(-1), /the state tree from the logs \(\d+ leaves\) is not the pool's/);
  }
});

test("a replay with one RPC's answer missing is a failure, never a pass", async () => {
  const log = A.good.robinhood;
  const i = log.findIndex((e) => e.method === "eth_call");
  const r = await check("robinhood", replayer(log.filter((_, j) => j !== i)), { wait: false });
  assert.equal(r.ok, false);
});

test("the sync's reads are the recorded run's, fast or slow: every eth_call answered past the newest block's reuse window", async () => {
  // card evm-trees-from-one-verified-source: on the real reuse clock a run slower than EVM_NEWEST_REUSE_MS (1 s) between
  // a round's anchor and its root times read the newest block again, so its fast replay asked stateRootTimes at a block
  // the run never read ("no recorded answer to eth_call ... 0x4b278d9c", Base mainnet 15 Nov 06:32Z); the sync's child
  // keeps that clock still, so how long an answer takes never changes what is read
  const count = (calls) => calls.reduce((m, e) => m.set(JSON.stringify([e.url, e.method, e.params]), (m.get(JSON.stringify([e.url, e.method, e.params])) ?? 0) + 1), new Map());
  const want = [...count(A.good.base)].sort();
  for (const ms of [0, 1_100]) {
    const r0 = replayer(A.good.base);
    const asked = [];
    const t = async (url, method, params) => {
      asked.push({ url, method, params });
      const a = await r0(url, method, params);
      if (ms > 0 && method === "eth_call") await new Promise((r) => setTimeout(r, ms));
      return a;
    };
    const r = await check("base", t, { wait: false });
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.deepEqual([...count(asked)].sort(), want, `answers held ${ms} ms: the reads differ from the run's`);
  }
});

test("the replayer answers a block by number from the same URL's tag read of that block, and nothing else", async () => {
  const log = A.good.base;
  const tagged = log.find((e) => e.method === "eth_getBlockByNumber" && e.params[0] === "latest");
  const n = tagged.result.number;
  assert.ok(!log.some((e) => e.method === "eth_getBlockByNumber" && e.params[0] === n && e.url === tagged.url), "the run read the anchor by tag only");
  const r = replayer(log);
  assert.deepEqual(await r(tagged.url, "eth_getBlockByNumber", [n, false]), { result: tagged.result });
  const other = CHAINS.robinhood.rpcs[0];
  assert.match((await r(other, "eth_getBlockByNumber", [n, false])).error, /^no recorded answer/);
  assert.match((await r(tagged.url, "eth_getBlockByNumber", [`0x${(BigInt(n) + 1_000_000n).toString(16)}`, false])).error, /^no recorded answer/);
  assert.match((await r(tagged.url, "eth_getBlockByNumber", [n, true])).error, /^no recorded answer/);
});

test("Base's pair pages the pool's whole life at the pager's full page, each provider under its own cap", async () => {
  // card notes-per-pool-evm-base-hang: on sepolia.base.org's 200-block cap the pager's pages were 156 blocks, about
  // 8,250 for the pool's 1,287,712 blocks (41 min at the 0.3 s a page read live); the check printed nothing in 20 min
  const { transport, pages } = standIn();
  const r = await check("base", transport, { wait: false });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[5], /no leaf yet/);
  const budget = Math.ceil((HEAD - DEPLOY_BLOCK + 1) / PAGE) + 10;
  for (const u of CHAINS.base.rpcs) {
    const n = pages.get(new URL(u).host) ?? 0;
    assert.ok(n > 0 && n <= budget, `${new URL(u).host}: ${n} eth_getLogs pages, over ${budget} (${[...pages].map(([h, k]) => `${h} ${k}`).join(", ")})`);
  }
});

/** A local provider answering every POST with `status` and `body`; `n()` the posts it took. */
async function provider(status, body) {
  let posts = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      posts++;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, n: () => posts, close: () => new Promise((ok) => server.close(ok)) };
}

test("a provider's 429 past its tries is that provider's no-answer, never an RPC error the sync is refused on", async () => {
  // card notes-per-pool-evm-throttle-is-no-answer: from the Mac on 25 Nov 04:0xZ the Robinhood run printed "FAIL
  // robinhood: RPC error undefined: undefined", robinhood.api.pocket.network's throttle of an eth_getLogs page read as
  // a JSON-RPC error with no code and no words; the same page answered 200 twice at 04:1xZ, and the run PASS at 04:13Z
  const was = RETRY.ms;
  RETRY.ms = 0;
  const p = await provider(429, JSON.stringify({ error: "Too Many Requests" }));
  try {
    const a = await post(p.url, "eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]);
    assert.equal(a.noAnswer, true, JSON.stringify(a));
    assert.ok(a.error.startsWith(`${new URL(p.url).host} HTTP 429: `), a.error);
    assert.ok(!/undefined/.test(a.error), a.error);
    assert.equal(p.n(), 4, "the call is read 4 times before it is a no-answer, as before");
  } finally {
    RETRY.ms = was;
    await p.close();
  }
});

test("a provider's JSON-RPC error is its answer in its own words: a range cap keeps its span, an error with no words reads as its JSON", async () => {
  const cap = await provider(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32701, message: "exceed maximum block range: 50000" } }));
  const bare = await provider(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { reason: "busy" } }));
  try {
    assert.deepEqual(await post(cap.url, "eth_getLogs", [{}]), { error: "RPC error -32701: exceed maximum block range: 50000" });
    assert.deepEqual(await post(bare.url, "eth_getLogs", [{}]), { error: 'RPC error {"reason":"busy"}' });
    assert.equal(cap.n() + bare.n(), 2, "an answer is read once");
  } finally {
    await cap.close();
    await bare.close();
  }
});

/** The Base stand-in, but every read on the second seat past the deploy receipt answered `answer` (the sync needs both
 *  seats' chain id, anchors and views; a page of logs it walks to the other seat). */
function secondAnswers(answer) {
  const { transport } = standIn();
  const second = new URL(CHAINS.base.rpcs[1]).host;
  return async (url, method, params) => (new URL(url).host === second && method !== "eth_getTransactionReceipt" ? answer : transport(url, method, params));
}

test("a sync refused on a provider's no-answer it was given is INCONCLUSIVE, naming the provider; any other refusal stays FAIL", async () => {
  const host = new URL(CHAINS.base.rpcs[1]).host;
  const throttled = { error: `${host} HTTP 429: 429 Too Many Requests`, noAnswer: true };
  const r = await check("base", secondAnswers(throttled), { wait: false, deadlineMs: 60_000 });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.ok(r.lines.at(-1).includes(`${host} HTTP 429`), r.lines.at(-1));
  const refused = await check("base", secondAnswers({ error: "RPC error -32000: execution aborted" }), { wait: false, deadlineMs: 60_000 });
  assert.equal(refused.ok, false);
  assert.equal(refused.verdict, "FAIL", refused.lines.join("\n"));
  // the recorded runs keep their verdicts
  for (const name of Object.keys(CHAINS)) {
    assert.equal((await check(name, replayer(A.good[name]), { wait: false })).verdict, "PASS", name);
    assert.equal((await check(name, replayer(A.bad[name]), { wait: false })).verdict, "FAIL", name);
  }
});

test("a recorded no-answer replays as one", async () => {
  const e = { url: CHAINS.base.rpcs[0], method: "eth_chainId", params: [], error: "base-rpc.publicnode.com HTTP 429: 429 Too Many Requests", noAnswer: true };
  assert.deepEqual(await replayer([e])(e.url, e.method, e.params), { error: e.error, noAnswer: true });
});

test("a sync with no end fails at its deadline, naming the call it is stuck on: the host only, the method, the range and the try", async () => {
  const second = new URL(CHAINS.base.rpcs[1]).host;
  const { transport } = standIn((h, method) => h === second && method === "eth_getLogs");
  const t0 = Date.now();
  const r = await check("base", transport, { wait: false, deadlineMs: 3_000 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 15_000, `ended after ${Date.now() - t0} ms`);
  const want = `stuck on eth_getLogs ${DEPLOY_BLOCK}..${DEPLOY_BLOCK + FIRST - 1} (${FIRST} blocks) on ${second}, try 1, no answer in `;
  assert.match(r.lines.at(-1), /^base: no end in 3\.0 s \(\d+ calls\): /);
  assert.ok(r.lines.at(-1).includes(want), r.lines.at(-1));
  assert.ok(!/https?:\/\//.test(r.lines.at(-1)), r.lines.at(-1));
});
