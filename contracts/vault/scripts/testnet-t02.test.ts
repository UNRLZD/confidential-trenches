// node --test contracts/vault/scripts/testnet-t02.test.ts: the pure parts of the VT-T02 run (testnet-t02.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountsOf, deadlineMsOf, entropyOf, keyTextOf, localProblems, pageRefusal, runOf } from "./testnet-t02.ts";

const SEED = Buffer.alloc(32, 7);

test("the run's accounts are children of the parent, named by 8 hex of the seed", () => {
  const run = runOf(SEED);
  assert.match(run, /^[0-9a-f]{8}$/);
  assert.deepEqual(accountsOf(run, "p.testnet"), { G: `g-${run}.p.testnet`, R: `r-${run}.p.testnet`, F: `f-${run}.p.testnet`, W: `w-${run}.p.testnet` });
  assert.throws(() => accountsOf("xyz", "p.testnet"), /8 hex/);
});

test("U's entropy is 16 bytes, fixed by the seed; G's and R's keys differ and their text holds seed and public key", () => {
  assert.equal(entropyOf(SEED).length, 16);
  assert.deepEqual(entropyOf(SEED), entropyOf(Buffer.alloc(32, 7)));
  const g = keyTextOf(SEED, "G");
  const r = keyTextOf(SEED, "R");
  assert.notDeepEqual(g.pub, r.pub);
  assert.match(g.secretKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/);
});

test("deadline_ms is the newer final header's ms + 600,000; a non-decimal header is refused", () => {
  assert.equal(deadlineMsOf("1793629202505000000", "1793629201505000000"), 1793629202505 + 600_000);
  assert.throws(() => deadlineMsOf(1793629202505000000, "1"), /decimal/);
});

test("a local path or a machine name in the record is refused", () => {
  assert.deepEqual(localProblems("Tx: near-testnet abc g.testnet", ["somehost"]), []);
  assert.equal(localProblems("see /Users/x/file", []).length, 1);
  assert.equal(localProblems("ran on somehost today", ["somehost"]).length, 1);
});

test("the page server refuses a Host other than 127.0.0.1 or localhost at its port", () => {
  const t = "0123456789abcdef0123456789abcdef";
  assert.equal(pageRefusal("127.0.0.1:47302", 47302, `/${t}/input.json`, t), null);
  assert.equal(pageRefusal("localhost:47302", 47302, `/${t}/result`, t), null);
  for (const host of [undefined, "", "127.0.0.1", "127.0.0.1:1", "evil.example:47302", "localhost.evil.example:47302", "[::1]:47302", "0.0.0.0:47302"])
    assert.equal(pageRefusal(host, 47302, `/${t}/input.json`, t), "host", String(host));
  assert.equal(pageRefusal("evil.example:47302", 47302, "/", t), "host");
});

test("the input and the result are refused without this run's token", () => {
  const t = "0123456789abcdef0123456789abcdef";
  const other = "f".repeat(32);
  for (const p of ["/input.json", "/result", `/${other}/input.json`, `/${other}/result`]) assert.equal(pageRefusal("127.0.0.1:47302", 47302, p, t), "token", p);
  assert.equal(pageRefusal("127.0.0.1:47302", 47302, "/", t), null);
  assert.equal(pageRefusal("127.0.0.1:47302", 47302, "/prover-worker.js", t), null);
});
