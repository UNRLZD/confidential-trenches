// node --test scripts/live-checks/near-dcl-helper-relay.test.mjs: the live check replays recorded runs
// (near-dcl-helper-relay.answers.json). good: this card's branch (17e93aa0) carryTrade run in process with its real
// mainnet trade reads (createTradeReads on rpc.mainnet.fastnear.com and near.drpc.org, the mainnet vault), a relayer that
// throws on any send and a temp store, its /v1/health answer composed by the recorder (the branch's commit, bind
// mainnet): the DCL buy for a fresh W read no vault payout on both providers, 409 no_payout; both mixed bodies 400
// bad_shape; PASS. bad_deployed: the deployed helper before this card (4528a8a0, read 16 Nov 09:08Z): 400 bad_shape on
// the DCL buy, the string pool ids read as a bad body, FAIL. Made from the good run: an answer that sends, any other
// refusal (token_untrusted included), a transaction in the answer, a mix taken, another commit, no mainnet carry, a W
// that is not a 64-hex id: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dclPoolOf, HELPER_BIND_TRADE_CODES, HELPER_CODE_STATUS, NEAR_DCL } from "../../packages/kit/src/index.ts";
import { DCL_TRADE, judge, MIXED, probeBody } from "./near-dcl-helper-relay.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "near-dcl-helper-relay.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const probe = (run, name, status, body) => ({ ...run, probes: { ...run.probes, [name]: { status, body: JSON.stringify(body) } } });

test("recorded good run: this card's relay takes a DCL buy and reaches the payout read, 409 no_payout, nothing sent: PASS", () => {
  const g = judge(A.good);
  assert.equal(g.ok, true, g.lines.join("\n"));
  assert.ok(HELPER_BIND_TRADE_CODES.includes("no_payout"));
  assert.equal(HELPER_CODE_STATUS.no_payout, 409);
});

test("recorded bad run: the deployed helper before this card reads the DCL buy as a bad body, 400 bad_shape: FAIL", () => {
  const d = judge(A.bad_deployed);
  assert.equal(d.ok, false);
  assert.deepEqual(bad(d), ["BAD mainnet: a DCL buy for a W the vault never paid: 400 bad_shape (want 409 no_payout, no transaction)"]);
});

test("made from the good run: a send, another refusal, a transaction, a mix taken, another commit, no carry or a bad W each FAIL", () => {
  const g = A.good;
  const fails = {
    "a creation sent": probe(g, "dcl", 200, { tx_hashes: ["x"] }),
    "the DCL pools read as untrusted": probe(g, "dcl", 400, { error: { code: "token_untrusted" } }),
    "the DCL body still bad_shape": probe(g, "dcl", 400, { error: { code: "bad_shape" } }),
    "a start failed": probe(g, "dcl", 503, { error: { code: "upstream" } }),
    "no_payout with a transaction": probe(g, "dcl", 409, { error: { code: "no_payout" }, tx_hashes: ["x"] }),
    "a classic-first mix taken": probe(g, "classic_first", 409, { error: { code: "no_payout" } }),
    "a DCL-first mix taken": probe(g, "dcl_first", 409, { error: { code: "no_payout" } }),
    "a mix answered otherwise": probe(g, "dcl_first", 400, { error: { code: "token_untrusted" } }),
    "a probe not read": { ...g, probes: { dcl: g.probes.dcl } },
    "no mainnet carry": { ...g, probes: {} },
    "another commit": { ...g, commit: "0".repeat(40) },
    "no --commit": { ...g, commit: "" },
    "a W that is not 64-hex": { ...g, wallet: "alice.near" },
    "health down": { ...g, health: { ...g.health, status: 503 } },
  };
  for (const [name, run] of Object.entries(fails)) assert.equal(judge(run).ok, false, name);
});

test("the probe bodies: the DCL buy's hops are DCL pool ids the kit parses; each mix holds one classic hop and one DCL hop", () => {
  const b = JSON.parse(probeBody("a".repeat(64)));
  assert.deepEqual(Object.keys(b), ["trade", "signed_delegates"]);
  assert.deepEqual(b.signed_delegates, []);
  assert.equal(b.trade.network, "mainnet");
  assert.ok("mainnet" in NEAR_DCL);
  assert.equal(b.trade.side, "buy");
  for (const h of DCL_TRADE.hops) assert.notEqual(dclPoolOf(h.pool), null, h.pool);
  for (const hops of Object.values(MIXED)) {
    assert.equal(hops.filter((h) => typeof h.pool === "number").length, 1);
    assert.equal(hops.filter((h) => typeof h.pool === "string" && dclPoolOf(h.pool) !== null).length, 1);
  }
});
