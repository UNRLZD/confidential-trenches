// node --test scripts/live-checks/evm-pool-pins.test.mjs: card evm-pool-pins's live check, replayed.
// evm-pool-pins.answers.json holds a real run (2026-11-09 from this Mac): good, the pins the testnet build carries, each
// pool's deploy receipt and code the same on both RPCs and the deployed helper's fee answer naming the pin's fee
// recipient; bad, the 3 Nov pools of pool-evm-deploy.md at their own deploy blocks, which the helper answers 404.
// Good passes; the bad run fails, and so do the good answers under a pin moved by one field; a provider that answers
// nothing makes the run INCONCLUSIVE, never PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BEFORE, check, PINS, replayer } from "./evm-pool-pins.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;

const A = JSON.parse(readFileSync(new URL("./evm-pool-pins.answers.json", import.meta.url), "utf8"));
const opts = { epochMs: A.epochMs };

test("the recorded good answer passes: both testnet pins, read on two RPCs each and on the helper", async () => {
  const r = await check(replayer(A.good.log), opts);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.length, 14);
  assert.ok(r.lines.every((l) => l.startsWith("ok  ")), r.lines.join("\n"));
});

// the recorded bad run asked the fee once (404); the check now asks the epoch before too (card evm-fee-quiet-epoch),
// which a helper that does not carry the pool answers 404 as well: the recording has no such ask, so it answers it so
const asksBefore = (log) => {
  const left = replayer(log);
  return async (url, init) => {
    if (!url.includes("/v1/pool/fee") || !url.endsWith(`&epoch=${A.epochMs - 60_000}`)) return left(url, init);
    const e = log.find((x) => x.url === url.replace(`&epoch=${A.epochMs - 60_000}`, `&epoch=${A.epochMs}`));
    return new Response(e.text, { status: e.status });
  };
};
test("the recorded bad answer fails: the 3 Nov pools, which no helper serves", async () => {
  const r = await check(asksBefore(A.bad.log), { ...opts, pins: BEFORE, txOf: (n) => BEFORE[n].tx });
  assert.equal(r.verdict, "FAIL");
  const fails = r.lines.filter((l) => l.startsWith("FAIL"));
  assert.equal(fails.length, 2, r.lines.join("\n"));
  for (const l of fails) assert.match(l, /the helper's fee answer \(HTTP 404\)/);
});

for (const [field, value] of [["pool", "0xb239a38af69b68e6c5c305df64985f283b5d5fe5"], ["feeRecipient", "0x000000000000000000000000000000000000beef"], ["fromBlock", "55524041"]]) {
  test(`the good answers fail under a Base Sepolia pin with another ${field}`, async () => {
    const pins = { ...PINS, "base-sepolia": { ...PINS["base-sepolia"], [field]: value } };
    // a moved pool asks for other code and another fee answer, which the good run never read: the check fails either way
    const r = await check(async (url, init) => replayer(A.good.log)(url, init).catch(() => new Response('{"error":{"code":"not_found"}}', { status: 404 })), { ...opts, pins });
    assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  });
}

test("a run that names one testnet only fails", async () => {
  const r = await check(replayer(A.good.log), { ...opts, pins: { "base-sepolia": PINS["base-sepolia"] } });
  assert.equal(r.verdict, "FAIL");
});

test("a provider that answers nothing (HTTP 429) makes the good answers INCONCLUSIVE, never PASS", async () => {
  const good = replayer(A.good.log);
  const r = await check(async (url, init) => (url === "https://sepolia.base.org" ? new Response("", { status: 429 }) : good(url, init)), opts);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("QUIET base-sepolia: sepolia.base.org HTTP 429")));
});

// card evm-fee-quiet-epoch: the helper has no block yet in the first moment of a minute (503 index_behind; 404 not_found
// before the helper's change); the check asks the epoch before, and a chain with no block for a minute is INCONCLUSIVE
const NO_BLOCK = [503, '{"error":{"code":"index_behind"}}'];
const NOT_FOUND = [404, '{"error":{"code":"not_found"}}'];
const BEFORE_EPOCH = `&epoch=${A.epochMs - 60_000}`;
/** A fetch that serves the good run, but the helper's fee for a pool: `first` for the epoch asked, `second` for the one before. */
function planted(first, second) {
  const asked = [];
  const rest = replayer(A.good.log.filter((e) => !e.url.includes("/v1/pool/fee")));
  const fetchFn = async (url, init) => {
    if (!url.includes("/v1/pool/fee")) return rest(url, init);
    asked.push(url);
    const before = url.endsWith(BEFORE_EPOCH);
    const a = before ? second : first;
    if (a === "good") return new Response(A.good.log.find((e) => e.url === url.replace(BEFORE_EPOCH, `&epoch=${A.epochMs}`)).text, { status: 200 });
    return new Response(a[1], { status: a[0] });
  };
  return { fetchFn, asked };
}

for (const [name, first] of [["503 index_behind", NO_BLOCK], ["404 not_found", NOT_FOUND]]) {
  test(`the helper's first fee answer ${name} and the epoch before's 200 passes`, async () => {
    const { fetchFn, asked } = planted(first, "good");
    const r = await check(fetchFn, opts);
    assert.equal(r.verdict, "PASS", r.lines.join("\n"));
    assert.equal(asked.length, 4, "each pool asked the epoch, then the epoch before");
    assert.equal(asked.filter((u) => u.endsWith(BEFORE_EPOCH)).length, 2);
  });
}

test("503 index_behind on the epoch and the one before is INCONCLUSIVE, never PASS, with a line that says why", async () => {
  const r = await check(planted(NO_BLOCK, NO_BLOCK).fetchFn, opts);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("QUIET") && /no block in the epoch or the one before/.test(l)), r.lines.join("\n"));
});

test("404 not_found on the epoch and the one before fails: the pool is not carried", async () => {
  const r = await check(planted(NOT_FOUND, NOT_FOUND).fetchFn, opts);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("FAIL") && /the helper's fee answer \(HTTP 404\)/.test(l)));
});
