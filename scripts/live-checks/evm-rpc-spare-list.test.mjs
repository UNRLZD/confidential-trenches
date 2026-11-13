// Replays evm-rpc-spare-list.answers.json through the live check. The good answer is a real run (this Mac, 2026-11-06,
// this card's kit, base-rpc-list-fix, recorded at 4008d804 with the same kit diff; the deployed helper at 2e7ec335): Base's scan list of four and Robinhood's of
// three, on hosts of their own, each spare past the second allowing the app's origin in its preflight and its POST,
// each held Base quote 11.5 s after the one before (past Base's maxLag), every quote with the first two scan providers held (no connection, HTTP 503) ending ok with
// the third asked for logs, every helper caller read with its first two held answered 200 past them, and the address-less
// Transfer read answered with a list on the checkout's reader and on a helper started from the branch (--base, this
// Mac); it passes. The bad answer is a real run at 66d7b60 (main before this card, 2026-11-05 20:09-20:11Z), the same
// holds: each scan list stops at two, so every held quote ends rpc_error and no third is asked, and the address-less
// Base read answers PublicNode's -32701 on the checkout and on the deployed helper (9041265); it fails on each of them.
// The 6 Nov half (the history refusals and the maker list): `good` is re-recorded on this card's branch (8940e38, a
// keyless helper started from it on this Mac as --base), every helper read with its first two held -32002 answered past
// them, the deployed-helper read 50,000 blocks back a list on each chain, and the maker lists of seven and five, each
// spare past the second answering its chain id and that read; it passes. `badHistory` is a real run at 0d130f2f (main
// before this half) against the deployed helper: the -32002 held on the first two is the caller's answer on both chains
// and each maker list is three; it fails on each.
// Card helper-evm-range-cap-walk: `good` is re-recorded on that card's branch at c0cc4d2b (a keyless helper started from it on
// this Mac as --base, 2026-11-06 17:00Z), with its "cap" mode (the first two answering base-pokt.nodies.app's 50-block cap)
// answered past them on each chain and Base's maker list of six (BlockPI dropped); it passes. On merging main 63c90229 it
// is re-recorded on the merged tree (988aa0e7, the same way, 2026-11-07 00:48-00:50Z), Sentio in that maker list. Its bad answers are
// replayed by helper-evm-range-cap-walk.test.mjs.
//   node --test scripts/live-checks/evm-rpc-spare-list.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APP_ORIGIN, LIMIT_CODES, RATE_LIMIT, RETRY, check, makerSpares, preflight, spareVerdict, throttled } from "./evm-rpc-spare-list.mjs";
import { LIMIT_CODES as SHARED_LIMIT_CODES, RATE_LIMIT as SHARED_RATE_LIMIT, RETRY as SHARED_RETRY } from "./provider-answer.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-rpc-spare-list.answers.json", import.meta.url), "utf8"));
const RETRY_MS = RETRY.ms; // as loaded, before a test sets it to 0
const has = (lines, re) => assert.ok(lines.some((l) => re.test(l)), `a line matches ${re}:\n${lines.join("\n")}`);

test("the good answer (card base-rpc-list-fix) passes: Base's four scan providers and Robinhood's three, every held quote ok on the third, every helper read past the first two", () => {
  const r = check(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  has(r.lines, /^PASS base scan list of 4, each on its own host: base-rpc\.publicnode\.com, base\.gateway\.tenderly\.co, base\.api\.pocket\.network, rpc\.sentio\.xyz \(4 at least\)$/);
  has(r.lines, /^PASS base fourth scan provider preflight from https:\/\/ct-app\.unrealized\.trade: 200, allow-origin https:\/\/ct-app\.unrealized\.trade/);
  has(r.lines, /^PASS robinhood scan list of 3, each on its own host: rpc\.mainnet\.chain\.robinhood\.com, robinhood\.daybreak-rpc\.network, robinhood\.api\.pocket\.network \(3 at least\)$/);
  for (const n of ["base-hook", "robinhood-torch"]) for (const m of ["refused", "503"]) has(r.lines, new RegExp(`^PASS ${n}, first two ${m}: ends ok in \\d+ ms`));
  for (const c of ["base", "robinhood"]) for (const m of ["refused", "503", "limit", "history"]) has(r.lines, new RegExp(`^PASS helper ${c}, first two ${m}: HTTP 200`));
  for (const c of ["base", "robinhood"]) for (const w of ["helper", "deployed helper"]) has(r.lines, new RegExp(`^PASS ${w} ${c}, an address-less Transfer read of 1,000 blocks: HTTP 200, \\d+ logs`));
  for (const c of ["base", "robinhood"]) {
    has(r.lines, new RegExp(`^PASS deployed helper ${c}, the PoolManager's logs of 100 blocks 50000 back: HTTP 200, \\d+ logs`));
    has(r.lines, new RegExp(`^PASS helper ${c} maker list of [5-9], each on its own host`));
  }
});

test("the bad answer at 0d130f2f (main before the card's 6 Nov half) fails: a history refusal on the first two is the caller's answer, and each maker list stops at three", () => {
  const r = check(A.badHistory);
  assert.equal(r.ok, false);
  for (const c of ["base", "robinhood"]) has(r.lines, new RegExp(`^FAIL helper ${c}, first two history: HTTP 200, no logs`));
  for (const c of ["base", "robinhood"]) has(r.lines, new RegExp(`^FAIL helper ${c} maker list of 3`));
  // the rest of the card's first half still holds there
  for (const c of ["base", "robinhood"]) for (const m of ["refused", "503", "limit"]) has(r.lines, new RegExp(`^PASS helper ${c}, first two ${m}: HTTP 200`));
});

test("a run whose deployed helper answers a history read with -32002, or a maker spare of another chain, fails", () => {
  const run = structuredClone(A.good);
  run.history.robinhood = { status: 200, results: null, error: "-32002 keyless requests are served for the most recent 5000 blocks only" };
  has(check(run).lines, /^FAIL deployed helper robinhood, the PoolManager's logs of 100 blocks 50000 back: HTTP 200, error -32002/);
  const other = structuredClone(A.good);
  const u = other.makers.base.list[2];
  other.makers.base.spares[u] = { ...other.makers.base.spares[u], chainId: 1 };
  assert.equal(check(other).ok, false);
});

test("the bad answer (66d7b60) fails: each scan list stops at two, and every held quote ends rpc_error with no third asked", () => {
  const r = check(A.bad);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL base scan list of 2/);
  has(r.lines, /^FAIL robinhood scan list of 2/);
  for (const n of ["base-hook", "robinhood-torch"]) for (const m of ["refused", "503"]) has(r.lines, new RegExp(`^FAIL ${n}, first two ${m}: ends rpc_error`));
  has(r.lines, /^FAIL helper base, an address-less Transfer read of 1,000 blocks: HTTP 200, error -32701 Please specify an address/);
  has(r.lines, /^FAIL deployed helper base, an address-less Transfer read of 1,000 blocks: HTTP 200, error -32701 Please specify an address/);
});

test("a run with a helper read answered by one of the first two fails", () => {
  const run = structuredClone(A.good);
  run.helper.base.held[0].answeredBy = run.helper.base.list[1];
  const r = check(run);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL helper base, first two refused: HTTP 200/);
});

test("card base-rpc-list-fix: Base's list of three, or a fourth whose POST names no origin, fails", () => {
  const three = structuredClone(A.good);
  three.scans.base = three.scans.base.slice(0, 3);
  const r = check(three);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL base scan list of 3, each on its own host: .* \(4 at least\)$/);
  const blind = structuredClone(A.good);
  blind.preflight[blind.scans.base[3]] = { ...blind.preflight[blind.scans.base[3]], post: null };
  assert.equal(check(blind).ok, false);
});

// Card evm-spare-list-green: `badSpare` is a real run at 6adacd73 (main, this Mac, 2026-11-06 22:5xZ, against the deployed
// helper at 6adacd73), the same FAIL lines as host=helper live run 42302023037: each held Robinhood quote ends rpc_error
// (the warm quote kept USDG, which the warm-up's prune dropped, and scanned all its pools over the whole depth: about
// 5,000 requests of 2,000 blocks on Pocket, which answers about 400 and then 429 with Retry-After 59), and BlockPI's
// Base maker spare answers Cloudflare's 521 page. `goodSpare` is a real run on this card's branch (aa8728ba, this Mac, 23:05-23:07Z,
// against the same deployed helper; nothing it reads needs the branch's helper deployed): every held Robinhood quote ends ok with
// Pocket asked for logs, and the Base maker list of six answers on every spare. Card helper-evm-range-cap-walk, on merging
// main 63c90229: `goodSpare` is re-recorded on that card's merged tree (988aa0e7, a keyless helper started from it on this
// Mac as --base, 2026-11-07 00:50-00:52Z), since the check's "cap" mode needs the branch's helper; the lines above hold.
test("card evm-spare-list-green: the bad answer at 6adacd73 fails: each held Robinhood quote ends rpc_error, and BlockPI's maker spare answers a Cloudflare page", () => {
  const r = check(A.badSpare);
  assert.equal(r.ok, false);
  for (const m of ["refused", "503"]) has(r.lines, new RegExp(`^FAIL robinhood-torch, first two ${m}: ends rpc_error: rpc_error: the scan provider (limited its rate past|did not answer within) the quote's bound of 60000 ms`));
  has(r.lines, /^FAIL helper base maker spare base\.public\.blockpi\.network: chain id <!DOCTYPE html>/);
});

test("card evm-spare-list-green: the good answer on this card's branch passes: every held Robinhood quote ok on Pocket, and no Base maker spare down", () => {
  const r = check(A.goodSpare);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const m of ["refused", "503"]) has(r.lines, new RegExp(`^PASS robinhood-torch, first two ${m}: ends ok in \\d+ ms`));
  has(r.lines, /^PASS helper base maker list of 6, each on its own host: .*rpc\.sentio\.xyz \(5 at least\)$/);
  assert.ok(!r.lines.some((l) => /blockpi/.test(l)), "no line names BlockPI");
});

// Card evm-spare-check-reads-a-throttle-as-no-answer: `throttledSpare` is helper live run 43464263269 (job
// 132019260570, 13 Nov 16:35Z, the deployed helper at 59087d39a), transcribed from its log: 78 of 79 checks green and
// this one red on 4663.rpc.thirdweb.com's rate-limit answer to GitHub's runner ("You are using a public RPC with rate
// limits, ..."), which answered this Mac {"result":"0x1237"} three times at 16:4xZ. `thirdweb429` is thirdweb's own 429
// to this Mac after a burst of 40 reads (16:4xZ). A throttle is no answer: that spare is INCONCLUSIVE, never FAIL; a
// wrong chain id, any other error and a short list stay FAIL.
test("card evm-spare-check-reads-a-throttle-as-no-answer: run 43464263269's throttled thirdweb spare is INCONCLUSIVE, and no line of the run FAILs", () => {
  const r = check(A.throttledSpare);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.equal(r.ok, false);
  has(r.lines, /^INCONCLUSIVE helper robinhood maker spare 4663\.rpc\.thirdweb\.com: chain id 4663, error You are using a public RPC with rate limits.*: it throttled this reader past its one retry, no answer$/);
  assert.equal(r.lines.filter((l) => /^FAIL /.test(l)).length, 0, r.lines.join("\n"));
  assert.equal(r.lines.length, 54);
});

test("card evm-spare-check-reads-a-throttle-as-no-answer: a planted wrong chain id, a list under its floor, or any other error stays FAIL beside a throttle", () => {
  const u = "https://4663.rpc.thirdweb.com";
  const id = structuredClone(A.throttledSpare);
  id.makers.robinhood.spares[u].chainId = 1;
  const a = check(id);
  assert.equal(a.verdict, "FAIL");
  has(a.lines, /^FAIL helper robinhood maker spare 4663\.rpc\.thirdweb\.com: chain id 1, error You are using a public RPC with rate limits/);
  const short = structuredClone(A.throttledSpare);
  short.makers.robinhood.list = short.makers.robinhood.list.filter((x) => x !== u);
  const b = check(short);
  assert.equal(b.verdict, "FAIL");
  has(b.lines, /^FAIL helper robinhood maker list of 4, each on its own host: .* \(5 at least\)$/);
  const other = structuredClone(A.throttledSpare);
  other.makers.robinhood.spares[u] = { chainId: 4663, results: null, status: 200, error: "-32002 keyless requests are served for the most recent 5000 blocks only" };
  assert.equal(check(other).verdict, "FAIL");
  const page = structuredClone(A.throttledSpare);
  page.makers.robinhood.spares[u] = { idError: "<!DOCTYPE html>", idStatus: 521, results: null, status: 521, error: "<!DOCTYPE html>" };
  assert.equal(check(page).verdict, "FAIL");
  // a throttle on the chain-id read too is no answer; HTTP 429 or code -32005 with no rate-limit words is one
  const idq = structuredClone(A.throttledSpare);
  idq.makers.robinhood.spares[u] = { idError: "-32005 slow down", idStatus: 200, results: null, status: 429, error: "busy" };
  assert.equal(check(idq).verdict, "INCONCLUSIVE");
});

test("card evm-spare-check-reads-a-throttle-as-no-answer: a scan spare whose preflight or POST answers 429 is INCONCLUSIVE; one that answers no origin stays FAIL", () => {
  const run = structuredClone(A.goodSpare);
  const u = run.scans.robinhood[2];
  run.preflight[u] = { status: 204, allow: "https://ct-app.unrealized.trade", headers: "content-type", post: null, postStatus: 429 };
  const r = check(run);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  has(r.lines, /^INCONCLUSIVE robinhood third scan provider preflight from \S+: 204, .*POST 429, allow-origin none: it throttled/);
  run.preflight[u] = { status: 429, allow: null, headers: null, post: null, postStatus: 429 };
  assert.equal(check(run).verdict, "INCONCLUSIVE");
  run.preflight[u] = { status: 204, allow: null, headers: "content-type", post: null, postStatus: 200 };
  assert.equal(check(run).verdict, "FAIL");
});

test("card evm-spare-check-reads-a-throttle-as-no-answer: a maker spare is read again once on thirdweb's recorded 429, then judged by the second answer", async () => {
  RETRY.ms = 0;
  const thirdweb = "https://4663.rpc.thirdweb.com";
  const t = A.thirdweb429;
  const answer = (method) => ({ eth_chainId: "0x1237", eth_blockNumber: "0x1000000", eth_getLogs: [] })[method];
  const fetchOf = (throttles) => {
    const asked = new Map();
    const f = async (url, init) => {
      const { method } = JSON.parse(init.body);
      const k = `${url} ${method}`;
      asked.set(k, (asked.get(k) ?? 0) + 1);
      if (url === thirdweb && asked.get(k) <= throttles) return new Response(t.body, { status: t.status, headers: t.headers });
      return Response.json({ jsonrpc: "2.0", id: 1, result: answer(method) });
    };
    return { f, asked };
  };
  const once = fetchOf(1);
  const ok = await makerSpares("robinhood", once.f);
  assert.deepEqual(ok.spares[thirdweb], { chainId: 4663, results: 0 });
  assert.equal(once.asked.get(`${thirdweb} eth_chainId`), 2);
  const twice = fetchOf(2);
  const quiet = await makerSpares("robinhood", twice.f);
  assert.equal(twice.asked.get(`${thirdweb} eth_chainId`), 2, "read again once, never more");
  assert.equal(quiet.spares[thirdweb].idStatus, 429);
  assert.equal(spareVerdict(quiet.spares[thirdweb], 4663), "INCONCLUSIVE");
  const run = structuredClone(A.throttledSpare);
  run.makers.robinhood = quiet;
  has(check(run).lines, /^INCONCLUSIVE helper robinhood maker spare 4663\.rpc\.thirdweb\.com: chain id HTTP 429 You are using a public-good RPC/);
});

test("card evm-spare-check-reads-a-throttle-as-no-answer: a scan spare's preflight is read again once on a 429, then recorded as answered", async () => {
  RETRY.ms = 0;
  const u = "https://robinhood.api.pocket.network";
  const t = A.thirdweb429;
  const cors = { "access-control-allow-origin": APP_ORIGIN, "access-control-allow-headers": "content-type" };
  const fetchOf = (throttles) => {
    let n = 0;
    const f = async (_url, init) => {
      if (init.method === "OPTIONS") n++;
      if (n <= throttles) return new Response(init.method === "OPTIONS" ? null : t.body, { status: init.method === "OPTIONS" ? 204 : 429 });
      return init.method === "OPTIONS" ? new Response(null, { status: 204, headers: cors }) : Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }, { headers: cors });
    };
    return { f, asked: () => n };
  };
  const once = fetchOf(1);
  const p = (await preflight([u], once.f))[u];
  assert.equal(once.asked(), 2);
  assert.deepEqual(p, { status: 204, allow: APP_ORIGIN, headers: "content-type", post: APP_ORIGIN, postStatus: 200 });
  const twice = fetchOf(2);
  const q = (await preflight([u], twice.f))[u];
  assert.equal(twice.asked(), 2, "read again once, never more");
  assert.equal(q.postStatus, 429);
  const run = structuredClone(A.goodSpare);
  run.preflight[u] = q;
  assert.equal(check(run).verdict, "INCONCLUSIVE");
});

test("card evm-spare-check-reads-a-throttle-as-no-answer: the check's throttle words and codes are provider-answer.mjs's", () => {
  assert.equal(RATE_LIMIT.source, SHARED_RATE_LIMIT.source);
  assert.equal(RATE_LIMIT.flags, SHARED_RATE_LIMIT.flags);
  assert.deepEqual([...LIMIT_CODES].sort(), [...SHARED_LIMIT_CODES].sort());
  assert.equal(RETRY_MS, SHARED_RETRY.ms);
  assert.ok(throttled(undefined, A.throttledSpare.makers.robinhood.spares["https://4663.rpc.thirdweb.com"].error));
});
