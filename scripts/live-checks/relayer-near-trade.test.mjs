// node --test scripts/live-checks/relayer-near-trade.test.mjs: the live check replays recorded runs
// (relayer-near-trade.answers.json). good: apps/helper at this card's branch (37472793) run with node src/server.ts,
// testnet carried with a fresh unfunded gas key, its two testnet providers the real ones (test.rpc.fastnear.com,
// near-testnet.drpc.org) behind a forwarder that answered only the throwaway gas account's own key and balance reads
// (it has no account on chain); the trade probe for a fresh W read W absent and no vault payout on both real
// providers: 409 no_payout; the carry probe, a delegate signed by a key made for the run for its own W, read W with no
// account on both: 400 no_account; the same with a flipped signature: 400 bad_signature; PASS. bad_deployed: the
// deployed helper before this card (a1e175da, read 12 Nov 07:17Z) on mainnet and testnet: 400 bad_shape on each probe,
// the trade body read as a deposit, FAIL. Made from the good run: an answer that sends (200), any other refusal, a
// transaction in the answer, another commit, no carried network, a W that is not a 64-hex id, a carry probe missing
// or answered otherwise: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HELPER_BIND_TRADE_CODES, HELPER_CODE_STATUS } from "../../packages/kit/src/index.ts";
import { decodeSignedDelegate, signatureOk } from "../../apps/helper/src/bind/checks.ts";
import { carryProbe, judge, probeBody, PROBE_TRADES } from "./relayer-near-trade.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "relayer-near-trade.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const carry = (run, kind, status, body) => ({ ...run, carries: { testnet: { ...run.carries.testnet, [kind]: { ...run.carries.testnet[kind], status, body: JSON.stringify(body) } } } });
const probe = (run, net, status, body) => ({ ...run, probes: { ...run.probes, [net]: { status, body: JSON.stringify(body) } } });

test("recorded good run: this card's helper refuses a trade for a W the vault never paid with 409 no_payout, nothing sent: PASS", () => {
  const g = judge(A.good);
  assert.equal(g.ok, true, g.lines.join("\n"));
  assert.deepEqual(Object.keys(A.good.probes), ["testnet"]);
  // the code and its status are the kit's
  assert.ok(HELPER_BIND_TRADE_CODES.includes("no_payout"));
  assert.equal(HELPER_CODE_STATUS.no_payout, 409);
});

test("recorded bad run: the deployed helper before this card reads the trade as a deposit, 400 bad_shape: FAIL", () => {
  const d = judge(A.bad_deployed);
  assert.equal(d.ok, false);
  assert.deepEqual(bad(d), [
    "BAD mainnet: a trade for a W the vault never paid: 400 bad_shape (want 409 no_payout, no transaction)",
    "BAD testnet: a trade for a W the vault never paid: 400 bad_shape (want 409 no_payout, no transaction)",
    "BAD mainnet: a delegate W signed, W with no account: 400 bad_shape (want 400 no_account, no transaction)",
    "BAD mainnet: the same delegate with a flipped signature: 400 bad_shape (want 400 bad_signature, no transaction)",
    "BAD testnet: a delegate W signed, W with no account: 400 bad_shape (want 400 no_account, no transaction)",
    "BAD testnet: the same delegate with a flipped signature: 400 bad_shape (want 400 bad_signature, no transaction)",
  ]);
});

test("made from the good run: a send, another refusal, a transaction, another commit, no carry or a bad W each FAIL", () => {
  const g = A.good;
  const fails = {
    "a creation sent": probe(g, "testnet", 200, { tx_hashes: ["x"] }),
    "W read as existing": probe(g, "testnet", 409, { error: { code: "wallet_exists" } }),
    "a start failed": probe(g, "testnet", 503, { error: { code: "upstream" } }),
    "no_payout with a transaction": probe(g, "testnet", 409, { error: { code: "no_payout" }, tx_hashes: ["x"] }),
    "another commit": { ...g, commit: "0".repeat(40) },
    "no --commit": { ...g, commit: "" },
    "no carried network": { ...g, probes: {} },
    "a network the probe does not know": probe(g, "betanet", 409, { error: { code: "no_payout" } }),
    "a W that is not 64-hex": { ...g, wallet: "alice.near" },
    "health down": { ...g, health: { ...g.health, status: 503 } },
    "no carry probes": { ...g, carries: {} },
    "a signed delegate for an absent W carried": carry(g, "signed", 200, { tx_hashes: ["x"] }),
    "an absent W read as a bad key": carry(g, "signed", 400, { error: { code: "bad_key" } }),
    "a flipped signature taken": carry(g, "flipped", 400, { error: { code: "no_account" } }),
    "a carry answered upstream": carry(g, "flipped", 503, { error: { code: "upstream" } }),
  };
  for (const [name, run] of Object.entries(fails)) assert.equal(judge(run).ok, false, name);
});

test("the probe body is a trade the helper parses, with no delegate: only the creation path's reads run", () => {
  for (const n of Object.keys(PROBE_TRADES)) {
    const b = JSON.parse(probeBody(n, "a".repeat(64)));
    assert.deepEqual(Object.keys(b), ["trade", "signed_delegates"]);
    assert.deepEqual(b.signed_delegates, []);
    assert.deepEqual(Object.keys(b.trade).sort(), ["amount_in", "hops", "network", "side", "slippage_bps", "token", "venue_out", "wallet"]);
    assert.equal(b.trade.side, "buy");
  }
});

test("the carry probes: a delegate the helper decodes, W its key's own implicit id, the signature good, and with flip bad; it expires at block 1", () => {
  for (const n of Object.keys(PROBE_TRADES)) {
    for (const flip of [false, true]) {
      const c = carryProbe(PROBE_TRADES[n].token, 1_250_000_000_000_000_000_000n, flip);
      const d = decodeSignedDelegate(new Uint8Array(Buffer.from(c.delegate, "base64")));
      assert.equal(d.sender_id, c.wallet);
      assert.equal(Buffer.from(d.public_key).toString("hex"), c.wallet);
      assert.equal(d.receiver_id, PROBE_TRADES[n].token);
      assert.equal(d.max_block_height, 1n);
      assert.equal(signatureOk(d), !flip);
    }
  }
});
