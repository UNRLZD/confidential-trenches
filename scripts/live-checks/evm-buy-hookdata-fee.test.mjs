// node --test scripts/live-checks/evm-buy-hookdata-fee.test.mjs: card evm-buy-hookdata-fee's live check, replayed.
// evm-buy-hookdata-fee.answers.json holds a real run (good: every chain the kit pins, each provider answering the fee's
// state reads at a block 600 s old, on each chain's fee pair) and a real run on Robinhood with its second fee provider
// replaced by robinhood-rpc.publicnode.com, a quote provider (bad: "historical state ... is not available" there).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { AGE_S, QUOTE_ONLY_RH, check, pinned, replayer } from "./evm-buy-hookdata-fee.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-buy-hookdata-fee.answers.json", import.meta.url), "utf8"));

test("the recorded good run passes: every pinned provider of every chain answers the fee's reads 600 s back", async () => {
  const r = await check(replayer(A.good));
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 4);
  for (const l of r.lines) {
    const age = Number(/, (\d+) s older than the newest/.exec(l)?.[1]);
    assert.ok(age >= AGE_S && age < AGE_S + 5, l);
  }
  assert.match(r.lines.find((l) => l.startsWith("robinhood-testnet:")), /rpc\.testnet\.chain\.robinhood\.com and robinhood-testnet\.drpc\.org each answered its 2 fee reads \(0xf5d6ded7, 0x4a2b75c8\)/);
  // every eth_call of the run is at the block found, by hash
  const calls = A.good.filter((e) => e.method === "eth_call");
  assert.ok(calls.length >= 16 && calls.every((e) => /^0x[0-9a-f]{64}$/.test(e.params[1].blockHash) && typeof e.result === "string"));
});

test("the recorded bad run (a Robinhood quote provider, PublicNode, in the fee pair) fails on its pruned state", async () => {
  const rh = pinned().find((c) => c.chain === "robinhood");
  const r = await check(replayer(A.bad), [{ ...rh, providers: [rh.providers[0], QUOTE_ONLY_RH] }]);
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^robinhood: robinhood-rpc\.publicnode\.com: eth_call: RPC error -32000: historical state [0-9a-f]+ is not available$/);
});

// card evm-quote-warm-round fold 8: the check reads each chain's fee pair, never its quote providers
test("the check reads each chain's feeProviders, which a quote provider without the state is not part of", () => {
  for (const c of pinned()) assert.deepEqual(c.providers, evmPoolVenues()[c.chain].feeProviders, c.chain);
  assert.ok(evmPoolVenues().robinhood.providers.includes(QUOTE_ONLY_RH) && !evmPoolVenues().robinhood.feeProviders.includes(QUOTE_ONLY_RH));
});

test("a provider's error on any one fee read fails the check, as does a missing answer", async () => {
  const k = A.good.findIndex((e) => e.method === "eth_call" && e.url === "https://robinhood.drpc.org");
  const bad = A.good.map((e, i) => (i === k ? { url: e.url, method: e.method, params: e.params, error: "RPC error -32000: Unknown state. First available state is 1" } : e));
  const r = await check(replayer(bad));
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /^robinhood: robinhood\.drpc\.org: eth_call: .*Unknown state/.test(l)), r.lines.join("\n"));
  const r2 = await check(replayer(A.good.filter((e, i) => i !== k)));
  assert.equal(r2.ok, false);
});

// review fold 4 LOW-2: one case for each of the check's refusals
test("an answer that is not a 32-byte word fails the check; a word and more passes", async () => {
  const k = A.good.findIndex((e) => e.method === "eth_call" && e.url === "https://robinhood.drpc.org");
  const at = (result) => A.good.map((e, i) => (i === k ? { ...e, result } : e));
  for (const v of ["0x", `0x${"0".repeat(62)}`, `0x${"z".repeat(64)}`, 7]) {
    const r = await check(replayer(at(v)));
    assert.equal(r.ok, false, String(v));
    assert.ok(r.lines.some((l) => l.startsWith("robinhood: robinhood.drpc.org: ") && l.endsWith(", not a word")), r.lines.join("\n"));
  }
  assert.equal((await check(replayer(at(`${A.good[k].result}${"f".repeat(64)}`)))).ok, true);
});

test("a chain with no block AGE_S old (the oldest is newer) fails the check", async () => {
  const u = ["https://one.example", "https://two.example"];
  // 100 blocks 2 s apart, the newest at 10,000 s: the oldest is 198 s old
  const block = (n) => ({ number: hex(n), timestamp: hex(10_000 - 2 * (99 - n)), hash: `0x${n.toString(16).padStart(64, "0")}` });
  const transport = async (url, method, params) => (method === "eth_getBlockByNumber" ? { result: block(params[0] === "latest" ? 99 : Number(BigInt(params[0]))) } : { result: `0x${"0".repeat(64)}` });
  const r = await check(transport, [{ chain: "young", providers: u, reads: [{ to: `0x${"1".repeat(40)}`, data: "0x12345678" }] }]);
  assert.deepEqual(r, { ok: false, lines: [`young: no block ${AGE_S} s old on one.example`] });
});

test("a provider holding another block at the number found fails the check", async () => {
  // the second pinned provider's read of the block the first found, answered with another hash
  const rh = pinned().find((c) => c.chain === "robinhood");
  const ok = await check(replayer(A.good), [rh]);
  const n = /^robinhood: block (\d+) /.exec(ok.lines[0])[1];
  const k = A.good.findIndex((e) => e.method === "eth_getBlockByNumber" && e.url === rh.providers[1] && e.params[0] === hex(BigInt(n)));
  assert.ok(k >= 0);
  const other = `0x${"ee".repeat(32)}`;
  const r = await check(replayer(A.good.map((e, i) => (i === k ? { ...e, result: { ...e.result, hash: other } } : e))), [rh]);
  assert.equal(r.ok, false);
  assert.match(r.lines[0], new RegExp(`^robinhood: ${host(rh.providers[1]).replace(/\./g, "\\.")}: block ${n} is ${other}, not 0x[0-9a-f]{64}$`));
});

const hex = (n) => `0x${BigInt(n).toString(16)}`;
const host = (u) => new URL(u).host;
