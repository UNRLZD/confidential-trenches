// node --test apps/terminal/test/e2e/buy/judge.test.mjs (card app-a2-e2e): the devnet buy's verdict replayed from
// recorded runs, so the judge's rules are held without a browser or money. good: the green run as recorded; cut: the
// same run with the buy cut (no tap, no pool.buy, no buy transaction, the box never Filled), which must fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { b58, judge, unb58 } from "./run.mjs";

const answers = JSON.parse(readFileSync(new URL("./run.answers.json", import.meta.url), "utf8"));

test("the recorded green run passes", () => {
  const v = judge(answers.good);
  assert.ok(v.ok, v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
});

test("the same run with the buy cut fails, on the buy", () => {
  const v = judge(answers.cut);
  assert.equal(v.ok, false);
  const bad = v.lines.filter((l) => l.startsWith("BAD")).join("\n");
  assert.match(bad, /the buy tapped once: 0/);
  assert.match(bad, /the buy's transactions sent: 0/);
});

test("a buy transaction that did not read back ok on both RPCs fails", () => {
  const rec = structuredClone(answers.good);
  const t = rec.txs.find((x) => x.step === "buy");
  t.reads[1] = { status: null, err: "none" };
  assert.equal(judge(rec).ok, false);
});

test("a host past the devnet RPC and the helper fails", () => {
  const rec = structuredClone(answers.good);
  rec.hosts = [...rec.hosts, "api.mainnet-beta.solana.com"];
  assert.equal(judge(rec).ok, false);
});

test("base58 round-trips a signature and a key", () => {
  for (const s of answers.good.txs.map((t) => t.sig).concat(answers.good.u)) assert.equal(b58(unb58(s)), s);
});
