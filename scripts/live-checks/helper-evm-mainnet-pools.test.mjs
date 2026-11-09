// node --test scripts/live-checks/helper-evm-mainnet-pools.test.mjs: the live check replays its recorded runs
// (helper-evm-mainnet-pools.answers.json). good: the deployed helper serving both mainnet pools at the kit's pins: PASS.
// bad: the helper's sender code before the start check, started with each mainnet's pinned SellDelegate as its pool:
// FAIL. Made from the good run: a pool, collector or sell sender off the pin, a foreign address served, the two
// providers disagreeing on the pool's code or the block, a provider off the kit's pair, a chain missing: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { judge, MAINNETS, pinsOf, read } from "./helper-evm-mainnet-pools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-evm-mainnet-pools.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const onChain = (run, chain, f) => ({ ...run, chains: run.chains.map((c) => (c.chain === chain ? f(structuredClone(c)) : c)) });
const feeBody = (c, f) => ({ ...c, fee: { ...c.fee, body: JSON.stringify(f(JSON.parse(c.fee.body))) } });

test("recorded good run: the deployed helper serves each mainnet pool at the kit's pin, with the pinned collector and sell sender, the pool read the same on two RPCs: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.verdict, "PASS");
  assert.deepEqual(A.good.chains.map((c) => c.chain), MAINNETS);
});

test("recorded bad run: a helper started with a foreign pool address answers 404 for the pins and carries the foreign one: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  for (const chain of MAINNETS) {
    assert.ok(bad(r).some((l) => l.startsWith(`BAD [${chain} fee]`) && l.includes("answers 404")), bad(r).join("\n"));
    assert.ok(bad(r).some((l) => l.startsWith(`BAD [${chain} foreign]`) && !l.includes("404")), bad(r).join("\n"));
  }
});

test("the kit's pins are the mainnet deploy records' (contracts/pool-evm/deployments/<chain>.json)", () => {
  const pins = pinsOf();
  for (const chain of MAINNETS) {
    const rec = JSON.parse(readFileSync(path.join(HERE, `../../contracts/pool-evm/deployments/${chain}.json`), "utf8"));
    assert.equal(pins[chain].pool, rec.contracts.PrivacyPoolSimple.address.toLowerCase(), chain);
    assert.equal(pins[chain].feeCollector, rec.contracts.FeeCollector.address.toLowerCase(), chain);
    assert.equal(pins[chain].sellSender, rec.contracts.FeeCollector.sink.toLowerCase(), chain);
    assert.equal(pins[chain].sellDelegate, rec.contracts.SellDelegate.address.toLowerCase(), chain);
    assert.equal(pins[chain].providers.length, 2, chain);
  }
});

test("made from the good run: each break of the end state FAILs, naming its chain", () => {
  const OTHER = "0x000000000000000000000000000000000000beef";
  for (const chain of MAINNETS) {
    const cases = {
      "pool off the pin": (c) => feeBody(c, (b) => ({ ...b, pool: OTHER })),
      "collector off the pin": (c) => feeBody(c, (b) => ({ ...b, fee_collector: OTHER })),
      "sell sender off the pin": (c) => feeBody(c, (b) => ({ ...b, sell_sender: OTHER })),
      "another network": (c) => feeBody(c, (b) => ({ ...b, network: chain === "base" ? "robinhood" : "base" })),
      "no commit": (c) => ({ ...c, fee: { ...c.fee, commit: null } }),
      "the fee read failed": (c) => ({ ...c, fee: { pool: c.fee.pool, error: "fetch failed" } }),
      "a foreign address served": (c) => ({ ...c, foreign: { ...c.foreign, status: 200, body: c.fee.body } }),
      "the code differs": (c) => ((c.providers[1].codeSha256 = "0".repeat(64)), c),
      "no code": (c) => ((c.providers[0].codeBytes = 0), c),
      "the block differs": (c) => ((c.providers[1].blockHash = "0x" + "1".repeat(64)), c),
      "a provider off the kit's pair": (c) => ((c.providers[1].url = "https://rpc.example"), c),
      "one provider only": (c) => ((c.providers = c.providers.slice(0, 1)), c),
      "a provider failed": (c) => ((c.providers[0] = { url: c.providers[0].url, error: "eth_getCode 429" }), c),
    };
    for (const [what, f] of Object.entries(cases)) {
      const r = judge(onChain(A.good, chain, f));
      assert.equal(r.ok, false, `${chain} ${what}: passed`);
      assert.ok(bad(r).every((l) => l.startsWith(`BAD [${chain}`)), `${chain} ${what}: ${bad(r).join("\n")}`);
    }
    // a provider's no-answer (provider-answer.mjs) is INCONCLUSIVE, never PASS; with a wrong answer beside it, FAIL
    const quiet = judge(onChain(A.good, chain, (c) => ((c.providers[0] = { url: c.providers[0].url, noAnswer: "x HTTP 429: 429 Too Many Requests" }), c)));
    assert.equal(quiet.verdict, "INCONCLUSIVE", quiet.lines.join("\n"));
    const both = judge(onChain(A.good, chain, (c) => ((c.providers[0] = { url: c.providers[0].url, noAnswer: "x HTTP 429" }), feeBody(c, (b) => ({ ...b, pool: OTHER })))));
    assert.equal(both.verdict, "FAIL");
    const r = judge({ ...A.good, chains: A.good.chains.filter((c) => c.chain !== chain) });
    assert.equal(r.ok, false);
    assert.ok(bad(r).includes(`BAD [${chain}] not read`), bad(r).join("\n"));
  }
});

// review P3-2: the helper answers 404 for the pin's fee while the minute's epoch has no first block yet on its providers
// (a read at the minute's edge); the check asks the previous minute's epoch then, so the edge never fails a good helper.
// A helper that answers 404 for both epochs (it serves no such pool) still fails.
test("a fee read at the minute's edge: a 404 for the current epoch is asked again at the previous minute's epoch, and a helper that serves the pool PASSes", async () => {
  const pins = pinsOf();
  const HOST = "http://helper.test";
  const asked = [];
  const fake = (edgeOnly) => async (url, init) => {
    const u = new URL(String(url));
    if (u.origin === HOST) {
      asked.push(u.search);
      const pool = u.searchParams.get("pool");
      const c = A.good.chains.find((x) => pins[x.chain].pool === pool);
      const headers = { "x-helper-commit": "a".repeat(40) };
      if (c === undefined) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404, headers });
      const epoch = u.searchParams.get("epoch");
      if (epoch === null || !edgeOnly) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404, headers });
      return new Response(c.fee.body, { status: 200, headers });
    }
    const { method } = JSON.parse(init.body);
    const result = method === "eth_getCode" ? "0x6080" : { hash: "0x" + "ab".repeat(32) };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  const now = Date.now();
  const r = judge(await read(HOST, fake(true), pins));
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  const epochs = asked.map((q) => new URLSearchParams(q).get("epoch")).filter((e) => e !== null).map(Number);
  assert.equal(epochs.length, MAINNETS.length, asked.join(" "));
  for (const e of epochs) {
    assert.equal(e % 60_000, 0, "a whole minute");
    assert.ok(e <= now && e >= now - 2 * 60_000 - 60_000, `the previous minute's epoch: ${e} at ${now}`);
  }
  const never = judge(await read(HOST, fake(false), pins));
  assert.equal(never.verdict, "FAIL");
  for (const chain of MAINNETS) assert.ok(bad(never).some((l) => l.startsWith(`BAD [${chain} fee]`) && l.includes("answers 404")), bad(never).join("\n"));
});

// review P3-3 (mutant "pins not lowercased"): the kit's pins are judged in lower case whatever case the kit writes them in
test("pins the kit writes in upper case are judged as the same addresses", () => {
  const kit = evmPoolVenues();
  const up = (a) => "0x" + a.slice(2).toUpperCase();
  const upper = Object.fromEntries(MAINNETS.map((c) => [c, { ...kit[c], pool: up(kit[c].pool), feeCollector: up(kit[c].feeCollector), sellSender: up(kit[c].sellSender), sellDelegate: up(kit[c].sellDelegate) }]));
  assert.equal(judge(A.good, pinsOf({ ...kit, ...upper })).verdict, "PASS");
});
