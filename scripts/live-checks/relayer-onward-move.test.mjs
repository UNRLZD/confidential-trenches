// node --test scripts/live-checks/relayer-onward-move.test.mjs: the live check replays recorded runs
// (relayer-onward-move.answers.json). good: apps/helper at this card (e81807fb5) run with node src/server.ts on
// 127.0.0.1, NEAR mainnet's bind carried under a stand-in relayer id with no account and a key made for the run (its
// relayer can never start, so nothing can be sent), its two mainnet providers the real ones: the amount-0 move answered
// 400 bad_shape before any read, the amount-1 move 400 no_account, the flipped one 400 bad_signature: PASS.
// bad_deployed: the deployed helper before this card (d17190c21): the amount-0 move ran the deposit checks, which read
// the key first: 400 no_account: FAIL. Made from the good run: an answer that sends, a transaction in an answer,
// another commit, a probe missing or answered otherwise, an id that is not a 64-hex one: each FAIL. The probes' bytes
// are held to the helper's own decoder and checks (apps/helper/src/bind/checks.ts, onward.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HELPER_BIND_ONWARD_CODES, HELPER_CODE_STATUS } from "../../packages/kit/src/index.ts";
import { decodeSignedDelegate, signatureOk } from "../../apps/helper/src/bind/checks.ts";
import { checkOnward, isOnward } from "../../apps/helper/src/bind/onward.ts";
import { freshKey, judge, onwardBody, USDC } from "./relayer-onward-move.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "relayer-onward-move.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const probe = (run, kind, status, body) => ({ ...run, probes: { ...run.probes, [kind]: { status, body: JSON.stringify(body) } } });

test("recorded good run: this card's helper answers the amount-0 move 400 bad_shape before any read, then no_account and bad_signature, nothing sent: PASS", () => {
  const g = judge(A.good);
  assert.equal(g.ok, true, g.lines.join("\n"));
  for (const c of ["bad_shape", "no_account", "bad_signature"]) assert.ok(HELPER_BIND_ONWARD_CODES.includes(c), c);
  assert.equal(HELPER_CODE_STATUS.bad_shape ?? 400, 400);
});

test("recorded bad run: the deployed helper before this card reads the amount-0 move's key first, 400 no_account: FAIL", () => {
  const d = judge(A.bad_deployed);
  assert.equal(d.ok, false);
  assert.deepEqual(bad(d), ["BAD onward move, amount 0, judged before the signature and any read: 400 no_account (want 400 bad_shape, no transaction)"]);
});

test("made from the good run: a send, a transaction in an answer, another commit, a missing or other answer, an id not made for the run: each FAIL", () => {
  assert.equal(judge(probe(A.good, "shape", 200, { tx_hashes: ["x"] })).ok, false, "an answer that sends");
  assert.equal(judge(probe(A.good, "fresh", 400, { error: { code: "no_account" }, tx_hashes: ["x"] })).ok, false, "a transaction beside a refusal");
  assert.equal(judge(probe(A.good, "flipped", 400, { error: { code: "bad_signature", tx_hashes: ["x"] } })).ok, false, "a transaction in the error");
  assert.equal(judge(probe(A.good, "fresh", 403, { error: { code: "id_not_ours" } })).ok, false, "another refusal");
  assert.equal(judge(probe(A.good, "shape", 503, { error: { code: "upstream" } })).ok, false, "upstream");
  assert.equal(judge({ ...A.good, probes: { shape: A.good.probes.shape, fresh: A.good.probes.fresh } }).ok, false, "a probe missing");
  assert.equal(judge({ ...A.good, commit: "0".repeat(40) }).ok, false, "another commit");
  assert.equal(judge({ ...A.good, commit: "" }).ok, false, "no --commit");
  assert.equal(judge({ ...A.good, health: { ...A.good.health, status: 503 } }).ok, false, "health down");
  assert.equal(judge({ ...A.good, sender: "alice.near" }).ok, false, "a sender that is not a 64-hex id");
  assert.equal(judge({ ...A.good, to: A.good.sender }).ok, false, "the move's address the sender itself");
});

test("the probes are the onward kind as the helper decodes it: one ft_transfer on mainnet USDC, max_block_height 1; amount 0 is bad_shape with no read, amount 1 reaches the key read; flipped fails the signature", async () => {
  const k = freshKey();
  const to = "d".repeat(64);
  const dec = (b) => decodeSignedDelegate(new Uint8Array(Buffer.from(JSON.parse(b).signed_delegate, "base64")));
  const one = dec(onwardBody(k, to, "1"));
  assert.equal(one.receiver_id, USDC);
  assert.equal(one.sender_id, k.id);
  assert.equal(one.max_block_height, 1n);
  assert.equal(isOnward(one.actions), true);
  assert.equal(signatureOk(one), true);
  assert.equal(signatureOk(dec(onwardBody(k, to, "1", true))), false);
  const cfg = { token: USDC, vault: "vault.confidential.unrlzd.near", relayer: "bind.confidential.unrlzd.near" };
  const gate = { seen: () => false, quote: () => null };
  let keyReads = 0;
  const reads = { accessKey: async () => (keyReads++, { kind: "no_account" }), finalHeight: async () => 225_838_388n, ftBalance: async () => 0n };
  const zero = await checkOnward(JSON.parse(onwardBody(k, to, "0")), cfg, reads, gate);
  assert.deepEqual([zero.ok, zero.code, keyReads], [false, "bad_shape", 0]);
  const fresh = await checkOnward(JSON.parse(onwardBody(k, to, "1")), cfg, reads, gate);
  assert.deepEqual([fresh.ok, fresh.code, keyReads], [false, "no_account", 1]);
});
