// node --test scripts/live-checks/app-console-429.test.mjs: the live check's verdict replays recorded runs
// (app-console-429.answers.json):
//   good:         a local helper at this card, warmed, read by app-console-429.mjs --base <local> --record: PASS;
//   bad_pre_card: the deployed helper at c4e515a (11:19Z): robinhood lists 503, and 4 of 25 candles and trades 503: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHAINS, judge, read, ROUTES } from "./app-console-429.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "app-console-429.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer passes: every read of the crowd and every chain's lists answered 200", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 2 + CHAINS.length + ROUTES("x").length);
});

test("the recorded bad answer (the deployed helper before this card) fails, each failing route named with its status", () => {
  const r = judge(A.bad_pre_card);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r).map((l) => l.split(":")[0]), ["BAD /v1/market/lists?chain=robinhood", "BAD /v1/market/candles", "BAD /v1/market/trades"]);
  assert.ok(bad(r).every((l) => / did not: 503/.test(l)), bad(r).join("\n"));
});

test("planted on the good answer: a 429 names its Retry-After; a missing read, a dropped connection and no Solana lists fail", () => {
  const edit = (f) => {
    const run = structuredClone(A.good);
    f(run);
    return judge(run);
  };
  let r = edit((run) => Object.assign(run.answers.find((a) => a.path.startsWith("/v1/market/holders")), { status: 429, retryAfter: "48" }));
  assert.deepEqual(bad(r), [bad(r)[0]]);
  assert.match(bad(r)[0], /^BAD \/v1\/market\/holders: 24 of 25 answered 200; 1 did not: 429 Retry-After 48 /);
  r = edit((run) => run.answers.pop());
  assert.ok(bad(r).some((l) => /102 reads of 103/.test(l)));
  r = edit((run) => Object.assign(run.answers[0], { status: 0, error: "fetch failed" }));
  assert.ok(bad(r).some((l) => /did not: 0 fetch failed/.test(l)));
  r = edit((run) => Object.assign(run, { mint: null, lists: { ...run.lists, status: 503 }, answers: [] }));
  assert.deepEqual(bad(r), ["BAD GET /v1/market/lists?chain=solana answers 503, the top Trending token none"]);
});

test("read() opens the crowd at once on the top Trending token, with the three chains' lists, and keeps no body", async () => {
  const asked = [];
  const mint = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
  const fetchFn = async (url) => {
    asked.push(url);
    const body = url.includes("lists?chain=solana") ? JSON.stringify({ lists: { trending_1h: [{ token: mint }] } }) : url.includes("/candles?") ? JSON.stringify({ tf: "15m", candles: [[1, "1", "1", "1", "1", "0"]], src: "chain", as_of_ms: 1 }) : "{}";
    return new Response(body, { status: 200 });
  };
  const run = await read("https://helper.test", fetchFn, 3);
  assert.equal(run.mint, mint);
  assert.equal(run.answers.length, CHAINS.length + 3 * 4);
  assert.equal(asked.length, 1 + CHAINS.length + 12);
  assert.ok(run.answers.every((a) => !("body" in a)));
  assert.equal(judge(run).ok, true);
});

// card evm-chart-opens-without-a-vendor-call: the crowd's candles read as the token page reads it (candles-read.mjs)
test("a candles 429 that clears inside the span passes; one still standing after it, or an empty 200, fails with its waits named", async () => {
  const { candlesReader } = await import("./candles-read.mjs");
  const mint = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
  const clock = { t: 0 };
  const wait = async (ms) => {
    const end = clock.t + ms;
    await new Promise((ok) => setImmediate(ok));
    clock.t = Math.max(clock.t, end);
  };
  const crowdRun = async (candles) => {
    clock.t = 0;
    let n = 0;
    const fetchFn = async (url) => {
      if (url.includes("lists?chain=solana")) return new Response(JSON.stringify({ lists: { trending_1h: [{ token: mint }] } }), { status: 200 });
      if (url.includes("/candles?")) return candles(++n);
      return new Response("{}", { status: 200 });
    };
    return read("https://helper.test", fetchFn, 3, candlesReader({ now: () => clock.t, wait }));
  };
  const bars = (k) => new Response(JSON.stringify({ tf: "15m", candles: Array.from({ length: k }, () => [1, "1", "1", "1", "1", "0"]), src: "chain", as_of_ms: 1 }), { status: 200 });
  const refused = () => new Response('{"error":{"code":"rate_limited"}}', { status: 429, headers: { "retry-after": "30" } });
  // the crowd's three candles reads refused once each, then served
  let r = judge(await crowdRun((n) => (n <= 3 ? refused() : bars(2))));
  assert.deepEqual(bad(r), []);
  assert.ok(clock.t <= 30_000, "side by side: one wait for the crowd");
  r = judge(await crowdRun(() => refused()));
  assert.ok(bad(r).some((l) => /^BAD \/v1\/market\/candles: 0 of 3 answered 200; 3 did not: 429 Retry-After 30 after 75 s of reads at each Retry-After \(30, 30, 15 s\)/.test(l)), r.lines.join("\n"));
  r = judge(await crowdRun(() => bars(0)));
  assert.ok(bad(r).some((l) => /^BAD \/v1\/market\/candles: 0 of 3 answered 200; 3 did not: 200 with no bars/.test(l)), r.lines.join("\n"));
});
