// node --test scripts/live-checks/wallet-restore-transfer-rpcs.test.mjs: card wallet-restore-transfer-rpcs's live
// check, replayed. wallet-restore-transfer-rpcs.answers.json holds a real run (6 Nov 02:59-03:01Z from the Mac, card
// restore-check-bounded, the pager's ceiling expiring after EVM_LOG_CEILING_PAGES; first card evm-transfer-rpc-spares's
// fold, decision M359) (good: the Base Sepolia W's USDC read on base-sepolia.gateway.tenderly.co and
// base-testnet.api.pocket.network alike, the newest 100,000 blocks of Robinhood read on the helper's route
// (POST https://api.confidential.unrealized.trade/v1/rpc/robinhood, one reader) and the newest 10,000 of Robinhood
// testnet on its list, each provider's refusals past its cap among the answers, every call through the device's own
// client; the newest 50,000 blocks of Base on the helper's route, after card evm-rpc-spare-list's deploy) and the same answers with every Transfer log of the Base
// Sepolia W taken out (bad). The wallet's own read runs on the replay: good passes, bad fails, its USDC not listed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { CHECK, JOBS, USDC, W, check, replayer, spoil } from "./wallet-restore-transfer-rpcs.mjs";

const A = JSON.parse(readFileSync(new URL("./wallet-restore-transfer-rpcs.answers.json", import.meta.url), "utf8"));
// a replay reaches no provider, so it waits for none: each run ends in seconds, the helper route's 50,000 blocks of Base
// included (about 80 pages, which the live run paces at the holdings readers' limit). The bound is 30 s: a paced replay
// took 163 s, and an unpaced one took up to 11 s on a loaded Mac, so it fails the first and never the second
const REPLAY_MS = 30_000;
const timed = async (f) => {
  const t0 = performance.now();
  const r = await f();
  return { ...r, ms: performance.now() - t0 };
};

test("the recorded good run passes: each testnet's pair reads its W alike, Base's and Robinhood's Ws are read on the helper's route only, and the Base Sepolia W lists the USDC it bought", async () => {
  // the pagers met each provider's real cap: the helper's Base provider's 1,000 blocks and Robinhood's 2,000, and dRPC's code 35
  const refused = new Set(A.good.filter((e) => e.method === "eth_getLogs" && e.error).map((e) => new URL(e.url).host));
  for (const h of ["api.confidential.unrealized.trade", "robinhood-testnet.drpc.org"]) assert.ok(refused.has(h), `${h}: ${[...refused].join(", ")}`);
  // no mainnet W read on any provider but the helper's route (decision M359)
  const mainnet = A.good.filter((e) => e.network === "base" || e.network === "robinhood");
  assert.ok(mainnet.length > 0 && mainnet.every((e) => e.url === `https://api.confidential.unrealized.trade/v1/rpc/${e.network}`), [...new Set(mainnet.map((e) => e.url))].join(", "));
  assert.ok(mainnet.some((e) => e.network === "base") && mainnet.some((e) => e.network === "robinhood"));
  const r = await timed(() => check(replayer(A.good), { wait: false }));
  assert.ok(r.ms < REPLAY_MS, `the good replay took ${Math.round(r.ms)} ms`);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, JOBS.length);
  assert.match(r.lines[0], new RegExp(`^base-sepolia: base-sepolia\\.gateway\\.tenderly\\.co and base-testnet\\.api\\.pocket\\.network read W 0x809286a1bf1585b1eeeefcc7a7f3508158fd078e from block 54553944 to \\d+ alike: .*${USDC}`));
  // each network read over at least the review's span: Base 50,000 blocks, Robinhood 100,000, Robinhood testnet 10,000
  for (const [i, [n, span]] of [["base", 50_000], ["robinhood", 100_000], ["robinhood-testnet", 10_000]].entries()) {
    const m = new RegExp(`^${n}: .* from block (\\d+) to (\\d+)`).exec(r.lines[i + 1]);
    assert.ok(m && Number(m[2]) - Number(m[1]) >= span, r.lines[i + 1]);
  }
  assert.match(r.lines[1], /^base: the helper's route https:\/\/api\.confidential\.unrealized\.trade\/v1\/rpc\/base read W /);
  assert.match(r.lines[2], /^robinhood: the helper's route https:\/\/api\.confidential\.unrealized\.trade\/v1\/rpc\/robinhood read W /);
});

test("the recorded bad run (the Base Sepolia W's Transfer logs taken out) fails, its USDC not listed, and is the good run but that", async () => {
  assert.deepEqual(A.bad, spoil(A.good));
  const changed = A.bad.filter((e, i) => JSON.stringify(e) !== JSON.stringify(A.good[i]));
  assert.ok(changed.length >= 1 && changed.every((e) => e.network === "base-sepolia" && e.method === "eth_getLogs" && e.result.length === 0));
  const r = await timed(() => check(replayer(A.bad), { wait: false }));
  assert.ok(r.ms < REPLAY_MS, `the bad replay took ${Math.round(r.ms)} ms`);
  assert.equal(r.ok, false);
  assert.match(r.lines[0], new RegExp(`^base-sepolia: W 0x809286a1bf1585b1eeeefcc7a7f3508158fd078e lists no token, not ${USDC}$`));
});

test("a replay whose Base Sepolia pair refuses every page, one block too (dRPC's code 19 there), fails: never a pass on a W unread", async () => {
  const refusing = A.good.map((e) => (e.network === "base-sepolia" && e.method === "eth_getLogs" ? { network: e.network, url: e.url, method: e.method, params: e.params, error: "RPC error 19: Temporary internal error. Please retry" } : e));
  const r = await check(replayer(refusing), { wait: false });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^base-sepolia: /);
  assert.doesNotMatch(r.lines[0], /alike/);
});

test("a replay whose Base Sepolia seat is out for hours (thirdweb's HTTP 429, Retry-After 26,741 s, on every call) passes on the list's spare: the out provider swapped at its first call, never a wait (card evm-transfer-rpc-spares)", async () => {
  const OUT = "https://base-testnet.api.pocket.network", SPARE = "https://84532.rpc.thirdweb.com";
  // the spare answers what the out provider answered in the real run; the out provider answers only the quota's 429
  const planted = A.good.flatMap((e) => (e.url === OUT ? [{ ...e, url: SPARE }, { network: e.network, url: OUT, method: e.method, params: e.params, error: "HTTP 429 (http_429, 1 try at base-testnet.api.pocket.network)", name: "SolanaRpcTransportError", afterMs: 26_741_000 }] : [e]));
  let outAsked = 0;
  const replay = replayer(planted);
  // the Base Sepolia job alone, with real waits: a wait begun would show in its time; the helper's mainnet jobs pace at
  // the holdings readers' limit when waiting, and are the good run's above
  const r = await timed(() => check((network, url, method, params) => (url === OUT && outAsked++, replay(network, url, method, params)), { wait: true, jobs: JOBS.filter((j) => j.network === "base-sepolia") }));
  assert.ok(r.ms < REPLAY_MS, `the replay took ${Math.round(r.ms)} ms`);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0], new RegExp(`^base-sepolia: base-sepolia\\.gateway\\.tenderly\\.co and 84532\\.rpc\\.thirdweb\\.com read W .* alike: .*${USDC}.*; swapped out base-testnet\\.api\\.pocket\\.network$`));
  assert.equal(outAsked, 1);
});

test("the replayer answers a call by the call and its context, never by the calls before it (card spares-replay-order)", async () => {
  const U = "https://rpc.example", V = "https://spare.example";
  const page = [{ address: W, fromBlock: "0x10", toBlock: "0x20" }];
  const timeout = { error: "no answer in 3500 ms (timeout, 1 try at rpc.example)", name: "SolanaRpcTransportError", afterMs: null };
  const head = (n) => ({ number: `0x${n.toString(16)}` });
  const log = [
    // run 42330914189's case: a page refused twice before its answer, in the case that read it
    { ctx: "out", network: "n", url: U, method: "eth_getLogs", params: page, ...timeout },
    { ctx: "out", network: "n", url: U, method: "eth_getLogs", params: page, ...timeout },
    { ctx: "out", network: "n", url: U, method: "eth_getLogs", params: page, result: [] },
    // each case's own heads, in the order it read them
    { ctx: "live", network: "n", url: V, method: "eth_getBlockByNumber", params: ["latest", false], result: head(100) },
    { ctx: "live", network: "n", url: V, method: "eth_getBlockByNumber", params: ["latest", false], result: head(101) },
    { ctx: "out", network: "n", url: V, method: "eth_getBlockByNumber", params: ["latest", false], result: head(200) },
    // a call never answered keeps its refusal
    { ctx: "out", network: "n", url: V, method: "eth_chainId", params: [], ...timeout },
  ];
  const r = replayer(log);
  // the page's answer at its first ask and every later one
  for (let i = 0; i < 3; i++) assert.deepEqual(await r("n", U, "eth_getLogs", page, "out"), { result: [] });
  // the later case asked first gets its own head; the first case its own two in order, then its last again
  assert.deepEqual(await r("n", V, "eth_getBlockByNumber", ["latest", false], "out"), { result: head(200) });
  assert.deepEqual(await r("n", V, "eth_getBlockByNumber", ["latest", false], "live"), { result: head(100) });
  assert.deepEqual(await r("n", V, "eth_getBlockByNumber", ["latest", false], "live"), { result: head(101) });
  assert.deepEqual(await r("n", V, "eth_getBlockByNumber", ["latest", false], "live"), { result: head(101) });
  assert.deepEqual(await r("n", V, "eth_chainId", [], "out"), timeout);
  // a call read in no recorded case has no answer
  assert.match((await r("n", U, "eth_getLogs", page, "live")).error, /^no recorded answer to eth_getLogs /);
});

test("a replay's child reads a clock that stands still, so the wallet's spare walk takes one way on every runner (card spares-replay-order)", async () => {
  const { STILL_CLOCK } = await import("./wallet-restore-transfer-rpcs.mjs");
  assert.ok(Array.isArray(STILL_CLOCK), "no still clock for a replay's child");
  const r = spawnSync(process.execPath, [...STILL_CLOCK, "-e", "const a = Date.now(); setTimeout(() => console.log(a, Date.now()), 25)"], { encoding: "utf8" });
  const [a, b] = r.stdout.trim().split(" ").map(Number);
  assert.ok(a > 0 && a === b, `${r.stdout}${r.stderr}`);
});

test("every stdio bridge of the wallet's checks hands a replay's answers one at a time in the read's own order, and every live check that runs one gives its replay the still clock (card spares-replay-order: one fix on every bridge)", () => {
  // the bridges' folder, by the path the live check itself runs its bridge from (CHECK), so no file here names it
  const dir = pathToFileURL(path.dirname(CHECK) + path.sep);
  const bridges = readdirSync(dir).filter((f) => f.endsWith(".ts") && /createInterface\(\{ input: process\.stdin \}\)/.test(readFileSync(new URL(f, dir), "utf8")));
  assert.ok(bridges.length >= 4, bridges.join(", "));
  for (const f of bridges) {
    const s = readFileSync(new URL(f, dir), "utf8");
    assert.match(s, /bridgeAnswers<[^>]*>\(a\.wait !== false, /, `${f}: its answers are not taken through bridgeAnswers`);
    assert.match(s, /\.on\("line", \(line\) => take\(JSON\.parse\(line\)\)\)/, `${f}: a stdin line not handed to take`);
  }
  const here = new URL("./", import.meta.url);
  for (const f of readdirSync(here).filter((x) => x.endsWith(".mjs") && !x.endsWith(".test.mjs"))) {
    const s = readFileSync(new URL(f, here), "utf8");
    for (const b of bridges) {
      if (!s.includes(`"${b}"`)) continue;
      assert.match(s, /spawn\(process\.execPath, \[\.\.\.\((?:args\.)?wait \? \[\] : STILL_CLOCK\), /, `${f} runs ${b} with no still clock for its replay`);
    }
  }
});
