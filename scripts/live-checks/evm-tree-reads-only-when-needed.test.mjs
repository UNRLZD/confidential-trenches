// node --test scripts/live-checks/evm-tree-reads-only-when-needed.test.mjs: the live check replays its recorded answers
// (evm-tree-reads-only-when-needed.answers.json). good: a fresh account's walk on this card's SIGN_HOST build (the
// check's --sign-dir, every other request live): PASS. liveBefore: the same walk on the live hosts at release 157,
// before this card: FAIL, both chains' pool index read for an account that holds nothing. release158: the walk on the
// live hosts at release 158 with each answer's JSON-RPC errors read: PASS. Planted on the good one: each
// fault put in FAILs, a provider's refusal FAILs and the page's own cancel does not, and the summary reads a filter's
// kind from its topics and counts each chain's eth_getLogs by load.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUY_SWAP, callName, callOf, errorsOf, INITIALIZE, isFitRead, judge, LOGS_PER_LOAD, refusalsOf, summarize } from "./evm-tree-reads-only-when-needed.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./evm-tree-reads-only-when-needed.answers.json", import.meta.url), "utf8"));

test("recorded good answer: no pool index read, no EVM answer refused, the logs under the bound: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.equal(ANSWERS.good.logs.index, 0);
});

test("recorded answer release158 (SIGN_HOST live, 15 Nov 23:24Z, the reader that reads each answer's errors): PASS, no provider refusal", () => {
  const v = judge(ANSWERS.release158);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(ANSWERS.release158.refused, {});
  assert.equal(ANSWERS.release158.signDir, null);
});

test("recorded answer liveBefore (release 157): FAIL, the pool index read for an account that holds nothing", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.match(v.lines[0], /^BAD the page read the pool index \d+ times/);
});

test("planted on the good answer: each fault FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, logs: { ...g.logs, index: 3 } }).lines, ["BAD the page read the pool index 3 times (the PoolManager's Initialize logs) for an account that holds nothing"]);
  assert.deepEqual(judge({ ...g, refused: { "base-rpc.publicnode.com 429": 2 } }).lines, ["BAD base-rpc.publicnode.com 429: 2 EVM RPC answers refused"]);
  assert.deepEqual(judge({ ...g, refused: { "rpc.mainnet.chain.robinhood.com failed net::ERR_FAILED": 1 } }).lines, ["BAD rpc.mainnet.chain.robinhood.com failed net::ERR_FAILED: 1 EVM RPC answers refused"]);
  const over = LOGS_PER_LOAD * g.loads + 1;
  assert.deepEqual(judge({ ...g, methods: { ...g.methods, eth_getLogs: over } }).lines, [`BAD ${over} eth_getLogs in ${g.loads} loads, over ${LOGS_PER_LOAD} a load`]);
  for (const bad of [null, {}, { ...g, loads: 0 }, { ...g, logs: undefined }]) assert.deepEqual(judge(bad).lines, ["BAD the walk was not read"]);
});

test("the summary: an Initialize filter alone is the index, one with a currency a quote scan, any other a pool read; a 429 and a failure are refused", () => {
  const post = (url, status, ...calls) => ({ url, method: "POST", status, calls });
  const logs = (topics) => ({ method: "eth_getLogs", params: [{ topics }] });
  const a = summarize(
    [
      { ...post("https://base-rpc.publicnode.com/", 200, logs([INITIALIZE]), { method: "eth_getBlockByNumber", params: [] }), load: 1 },
      { ...post("https://base.api.pocket.network/", 429, logs([INITIALIZE, null, "0x" + "1".repeat(64)])), load: 2 },
      { ...post("https://ct-api.unrealized.trade/v1/rpc/base?keyed=only", 200, logs([["0x" + "a".repeat(64)]])), load: 2 },
      post("https://base.rpc.blxrbdn.com/", 200, logs([["0x" + "a".repeat(64), "0x" + "b".repeat(64)]])),
      { ...post("https://rpc.mainnet.chain.robinhood.com/", undefined, { method: "eth_chainId", params: [] }), failed: "net::ERR_FAILED" },
      post("https://ct-api.unrealized.trade/v1/rpc/solana", 200, { method: "getAccountInfo", params: [] }),
      { url: "https://base-rpc.publicnode.com/", method: "GET", status: 200, calls: [{ method: "eth_getLogs", params: [{ topics: [INITIALIZE] }] }] },
    ],
    2,
  );
  assert.deepEqual(a.logs, { index: 1, scan: 1, other: 2 });
  assert.deepEqual(a.posts, { "base-rpc.publicnode.com": 1, "base.api.pocket.network": 1, "ct-api.unrealized.trade": 1, "base.rpc.blxrbdn.com": 1, "rpc.mainnet.chain.robinhood.com": 1 });
  assert.deepEqual(a.refused, { "base.api.pocket.network 429 [eth_getLogs]": 1, "rpc.mainnet.chain.robinhood.com failed net::ERR_FAILED [eth_chainId]": 1 });
  assert.equal(a.methods.eth_getLogs, 4);
  // by load: the helper's Base route is Base's; a post with no load is the walk's last
  assert.deepEqual(a.byLoad, { base: [1, 3] });
});

// release 158's sign run 43773291937 (job 132993911514) failed on one "base.rpc.blxrbdn.com failed net::ERR_ABORTED":
// the page's own cancel (a navigation between loads, its AbortController), no provider's refusal. A provider's refusal
// stays BAD: an HTTP 4xx or 5xx, any other network failure, a JSON-RPC error that is no range cap.
test("planted refusals: the page's own ERR_ABORTED alone passes; a 429, a 5xx, an ERR_FAILED and a JSON-RPC rate-limit error each FAIL; a range cap is the pager's probe", () => {
  const g = ANSWERS.good;
  const req = (extra) => ({ url: "https://base.rpc.blxrbdn.com/", method: "POST", status: 200, load: 2, calls: [{ method: "eth_blockNumber", params: [] }], ...extra });
  const verdict = (extra) => judge({ ...g, refused: summarize([req(extra)], g.loads).refused });
  assert.equal(verdict({ status: undefined, failed: "net::ERR_ABORTED" }).ok, true, "the page's own cancel");
  assert.equal(verdict({ errors: errorsOf('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"eth_getLogs range too wide, maximum block range: 10000"}}') }).ok, true, "a named range cap");
  const bad = [
    [{ status: 429 }, "base.rpc.blxrbdn.com 429 [eth_blockNumber]"],
    [{ status: 503 }, "base.rpc.blxrbdn.com 503 [eth_blockNumber]"],
    [{ status: 403 }, "base.rpc.blxrbdn.com 403 [eth_blockNumber]"],
    [{ status: undefined, failed: "net::ERR_FAILED" }, "base.rpc.blxrbdn.com failed net::ERR_FAILED [eth_blockNumber]"],
    [{ status: undefined, failed: "net::ERR_CONNECTION_RESET" }, "base.rpc.blxrbdn.com failed net::ERR_CONNECTION_RESET [eth_blockNumber]"],
    [{ errors: errorsOf('{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"rate limit exceeded"}}') }, "base.rpc.blxrbdn.com rpc error -32005 eth_blockNumber"],
    [{ errors: errorsOf('[{"jsonrpc":"2.0","id":1,"result":"0x1"},{"jsonrpc":"2.0","id":2,"error":{"code":429,"message":"Too Many Requests"}}]') }, "base.rpc.blxrbdn.com rpc error 429 eth_blockNumber"],
  ];
  for (const [extra, key] of bad) assert.deepEqual(verdict(extra).lines, [`BAD ${key}: 1 EVM RPC answers refused`], key);
  assert.deepEqual(refusalsOf({ failed: "net::ERR_ABORTED", status: 502 }), ["502"], "a cancel after a 5xx is the 5xx");
});

// release 175's sign run 44300899132 failed on "robinhood-rpc.publicnode.com rpc error 3" and "robinhood.drpc.org rpc
// error 3", one reverted eth_call each, which the answer could not name. A refusal names its call: the method, and for
// an eth_call the contract it asks and the 4-byte selector, matched by the error's JSON-RPC id inside a batch; never the
// call's arguments (an address of the account sits there).
test("a refusal names its call: an eth_call's contract and selector, the batch member its error's id answers, never its arguments", () => {
  const to = "0x" + "Ab".repeat(20);
  const account = "1".repeat(40);
  const data = "0x70a08231" + "0".repeat(24) + account;
  const shaped = callOf({ jsonrpc: "2.0", id: 7, method: "eth_call", params: [{ to, data }, "latest"] });
  assert.deepEqual(shaped, { id: 7, to: to.toLowerCase(), sel: "0x70a08231" });
  assert.equal(JSON.stringify(shaped).includes(account), false, "no argument kept");
  const calls = [{ method: "eth_blockNumber", params: [], id: 6 }, { method: "eth_call", params: [], ...shaped }];
  const errors = errorsOf('[{"jsonrpc":"2.0","id":6,"result":"0x1"},{"jsonrpc":"2.0","id":7,"error":{"code":3,"message":"execution reverted","data":"0x"}}]');
  assert.deepEqual(errors, [{ code: 3, cap: false, rev: true, id: 7 }]);
  const r = { url: "https://robinhood.drpc.org/", method: "POST", status: 200, load: 4, calls, errors };
  assert.deepEqual(refusalsOf(r), [`rpc error 3 eth_call ${to.toLowerCase()}:0x70a08231`]);
  assert.deepEqual(summarize([r], 6).refused, { [`robinhood.drpc.org rpc error 3 eth_call ${to.toLowerCase()}:0x70a08231`]: 1 });
  assert.equal(callName({ method: "eth_call" }), "eth_call", "an eth_call with no contract read is its method");
});

// release 175 (SIGN_HOST live, 18 Nov 13:01Z, this card's naming reader): FAIL, each refusal named. The pool's own
// buySwap (0x25faf2a3, the quote's swap-gas fit read) answered JSON-RPC error 3 on robinhood-rpc.publicnode.com and
// robinhood.drpc.org, and the pool sync's first round of views (SCOPE, currentRoot, currentTreeSize, currentLabelRoot,
// currentLabelTreeSize) failed on Robinhood's own RPC with no response the page could read.
test("recorded answer release175: FAIL, the reverted buySwap and the views' failed posts named", () => {
  const v = judge(ANSWERS.release175);
  assert.equal(v.ok, false);
  const pool = "0x9306359433127c4f3be426f6faeb00a3c41f66db";
  for (const host of ["robinhood-rpc.publicnode.com", "robinhood.drpc.org"]) assert.ok(v.lines.includes(`BAD ${host} rpc error 3 eth_call ${pool}:0x25faf2a3: 1 EVM RPC answers refused`), host);
  for (const sel of ["0x33d09200", "0xfdab463d", "0xa8f0f95a", "0x50f3e219", "0x4181445b"]) assert.ok(v.lines.includes(`BAD rpc.mainnet.chain.robinhood.com failed net::ERR_FAILED [eth_call ${pool}:${sel}]: 2 EVM RPC answers refused`), sel);
  assert.equal(ANSWERS.release175.signDir, null);
});

// The fit read (the pool's own buySwap from the pool, the kit's evmBuySwapFitCall): a revert or an out-of-gas error is
// its answer, "the route's swap does not run as the pool runs it", as the kit reads it (quote.ts answerOf). Release
// 175's two "rpc error 3" were this read of the buy tap's v3 tier for a coin with no v3 pool. Any other call's revert,
// any other contract's buySwap, and the fit read's provider refusal stay BAD.
test("the fit read's revert or out of gas is its answer; any other revert, another contract's buySwap, and its provider refusal stay BAD", () => {
  const pool = "0x9306359433127c4f3be426f6faeb00a3c41f66db";
  const base = "0xaa080e74ec99cf5c684548c77ca145edfcf899cf";
  const fit = (to, sel = BUY_SWAP) => ({ method: "eth_call", params: [], id: 1, to, sel });
  const r = (call, answer) => ({ url: "https://robinhood.drpc.org/", method: "POST", status: 200, load: 4, calls: [{ method: "eth_blockNumber", params: [], id: 0 }, call], errors: errorsOf(answer) });
  const reverted = '[{"jsonrpc":"2.0","id":0,"result":"0x1"},{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x"}}]';
  assert.equal(isFitRead(fit(pool)), true);
  assert.equal(isFitRead(fit(base)), true, "Base's pinned pool");
  assert.deepEqual(refusalsOf(r(fit(pool), reverted)), [], "the fit read's revert (release 175's)");
  assert.deepEqual(refusalsOf(r(fit(base), '[{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"execution reverted"}}]')), [], "a revert named by its message");
  assert.deepEqual(refusalsOf(r(fit(pool), '[{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"out of gas"}}]')), [], "its out of gas (geth)");
  assert.deepEqual(refusalsOf(r(fit(pool), '[{"jsonrpc":"2.0","id":1,"error":{"code":-32003,"message":"out of gas: gas required exceeds: 476190"}}]')), [], "its out of gas (reth)");
  assert.deepEqual(refusalsOf(r(fit(pool, "0xfdab463d"), reverted)), [`rpc error 3 eth_call ${pool}:0xfdab463d`], "the pool's currentRoot reverting is no answer");
  const other = "0x" + "12".repeat(20);
  assert.deepEqual(refusalsOf(r(fit(other), reverted)), [`rpc error 3 eth_call ${other}:${BUY_SWAP}`], "a buySwap of a contract that is no pinned pool");
  assert.deepEqual(refusalsOf(r(fit(pool), '[{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"rate limit exceeded"}}]')), [`rpc error -32005 eth_call ${pool}:${BUY_SWAP}`], "the fit read's rate limit");
  assert.deepEqual(refusalsOf({ ...r(fit(pool), reverted), status: 429, errors: [] }), [`429 [eth_blockNumber, eth_call ${pool}:${BUY_SWAP}]`], "the fit read's post answered 429");
  assert.deepEqual(refusalsOf({ ...r(fit(pool), reverted), status: undefined, failed: "net::ERR_FAILED", errors: [] }), [`failed net::ERR_FAILED [eth_blockNumber, eth_call ${pool}:${BUY_SWAP}]`], "the fit read's post that failed");
});

// card robinhood-reads-draw-no-revert's build (the check's --sign-dir, every other request live, 18 Nov 13:3xZ): PASS,
// no refused answer on any host.
test("recorded answer robinhoodNoRevertLocal (this card's SIGN_HOST build): PASS, no provider refusal", () => {
  const v = judge(ANSWERS.robinhoodNoRevertLocal);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(ANSWERS.robinhoodNoRevertLocal.refused, {});
  assert.equal(ANSWERS.robinhoodNoRevertLocal.signDir, "local build");
});
