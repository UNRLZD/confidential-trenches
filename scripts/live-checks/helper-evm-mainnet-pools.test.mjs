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
import { judge, MAINNETS, pinsOf } from "./helper-evm-mainnet-pools.mjs";

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
