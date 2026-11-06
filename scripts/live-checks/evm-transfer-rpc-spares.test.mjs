// node --test scripts/live-checks/evm-transfer-rpc-spares.test.mjs: card evm-transfer-rpc-spares's live check,
// replayed. evm-transfer-rpc-spares.answers.json holds a real run on every network's pool list and each testnet's
// Transfer list (good: the newest 2,000 blocks read with every provider live, then once per provider but thirdweb's with
// that one answering as thirdweb's daily quota, HTTP 429 with Retry-After 26,741,000 ms) and the same answers with every
// answer of Base's pool list but its first provider's a quota 429 too (bad: one provider left there). The wallet's own
// read runs on the replay: good passes, bad fails on Base's pool list only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LISTS, spares, spoil } from "./evm-transfer-rpc-spares.mjs";
import { replayer } from "./wallet-restore-transfer-rpcs.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-transfer-rpc-spares.answers.json", import.meta.url), "utf8"));
const CASE = /^([a-z-]+ (?:pool|transfer)), (\S+) out: (?:(\S+) and (\S+) read alike from block \d+ to \d+, the out one asked [01] times?|(skipped: .+))$/;

test("the recorded good run passes: on every list with any one provider out the read runs alike on two others; a case skipped says why in its line", async () => {
  const r = await spares(replayer(A.good), { wait: false });
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const l of LISTS) {
    assert.ok(r.lines.some((x) => x.startsWith(`${l.label}, every provider live: `) && / read alike from block /.test(x)), `${l.label}: no live read`);
    const cases = r.lines.filter((x) => x.startsWith(`${l.label}, `) && !x.includes("every provider live"));
    assert.equal(cases.length, (l.pool ?? l.urls).filter((u) => !u.includes(".thirdweb.com")).length, `${l.label}: one case per provider but thirdweb's`);
    for (const c of cases) {
      const m = CASE.exec(c);
      assert.ok(m, c);
      if (m[5] === undefined) assert.ok(m[2] !== m[3] && m[2] !== m[4], c);
    }
  }
  // Base's pool list holds four providers and Robinhood's five: no case of theirs is skipped
  assert.ok(r.lines.filter((x) => /^(base|robinhood) pool, /.test(x)).every((x) => !/skipped/.test(x)), r.lines.join("\n"));
});

test("the recorded bad run (Base's pool list down to one) fails on Base's pool list only, and is the good run but that", async () => {
  assert.deepEqual(A.bad, spoil(A.good));
  const r = await spares(replayer(A.bad), { wait: false });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("base pool, ") && !/read alike|skipped/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.filter((l) => !l.startsWith("base pool, ")).every((l) => /read alike|skipped/.test(l)), r.lines.join("\n"));
});
