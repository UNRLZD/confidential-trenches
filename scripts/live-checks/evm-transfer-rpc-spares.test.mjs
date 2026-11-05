// node --test scripts/live-checks/evm-transfer-rpc-spares.test.mjs: card evm-transfer-rpc-spares's live check,
// replayed. evm-transfer-rpc-spares.answers.json holds a real run on Base's and Robinhood's Transfer lists (good: each
// network's newest 2,000 blocks read for a W with every provider live, then once per provider with that one answering
// as thirdweb's daily quota, HTTP 429 with Retry-After 26,741,000 ms) and the same answers with every answer of Base's
// dRPC a quota 429 too (bad: with thirdweb's own quota out then, one provider left on Base whenever one more is out). The wallet's own read runs on the replay: good
// passes, bad fails on Base.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NETWORKS, spares, spoil } from "./evm-transfer-rpc-spares.mjs";
import { replayer } from "./wallet-restore-transfer-rpcs.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-transfer-rpc-spares.answers.json", import.meta.url), "utf8"));

test("the recorded good run passes: with any one provider of any network's list out, the W read runs alike on two others of two operators", async () => {
  const r = await spares(replayer(A.good), { wait: false });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.length >= 3 * NETWORKS.length, r.lines.join("\n"));
  for (const n of NETWORKS) assert.ok(r.lines.filter((l) => l.startsWith(`${n}, `)).length >= 3, `${n}: three providers out in turn`);
  for (const l of r.lines) {
    const m = /^[a-z-]+, (\S+) out: (\S+) and (\S+) read W alike from block \d+ to \d+, the out one asked [01] times?$/.exec(l);
    assert.ok(m && m[1] !== m[2] && m[1] !== m[3], l);
  }
});

test("the recorded bad run (Base's dRPC out too) fails on Base, and is the good run but that", async () => {
  assert.deepEqual(A.bad, spoil(A.good));
  const r = await spares(replayer(A.bad), { wait: false });
  assert.equal(r.ok, false);
  const base = r.lines.filter((l) => l.startsWith("base, "));
  assert.ok(base.some((l) => !/read W alike/.test(l)), base.join("\n"));
  assert.ok(r.lines.filter((l) => !l.startsWith("base, ")).every((l) => /read W alike/.test(l)), r.lines.join("\n"));
});
