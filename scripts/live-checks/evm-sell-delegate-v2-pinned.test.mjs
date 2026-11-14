// Replays evm-sell-delegate-v2-pinned.answers.json through the live check: the good run (this card's sign build, which
// names SellDelegate v2 on both mainnets and neither first-set delegate, and both chains' answers on two RPCs) passes;
// the bad run (SIGN_HOST's bundle before the pin, which names the first set's delegates) fails, and so does the good run
// with one chain's v2 code flipped on one RPC, or a bundle that names v2 and still the first set's.
//   node --test scripts/live-checks/evm-sell-delegate-v2-pinned.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { replayer } from "./evm-pool-pins.mjs";
import { check, CHAINS, judgeBundle } from "./evm-sell-delegate-v2-pinned.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;
const A = JSON.parse(readFileSync(new URL("./evm-sell-delegate-v2-pinned.answers.json", import.meta.url), "utf8"));
const G = A.good;
const run = (o = {}) => check({ b: o.b ?? G.bundle, fetchFn: replayer(o.log ?? G.log), rpcsOf: (c) => G.rpcs[c], read: (c) => G.deployments[c] });

test("good: the sign build names v2 on both mainnets and no first-set delegate, and each v2 holds the build's code on two RPCs: PASS", async () => {
  const r = await run();
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  for (const c of CHAINS) assert.ok(r.lines.some((l) => l.startsWith(`GOOD [${c}]`)), c);
});

test("bad: SIGN_HOST's bundle before the pin (the first set's delegates) FAILs on both chains", async () => {
  const r = await run({ b: A.bad.bundle });
  assert.equal(r.verdict, "FAIL");
  for (const c of CHAINS) assert.ok(r.lines.some((l) => l.startsWith(`BAD [${c}]`) && l.includes("does not name SellDelegate v2")), c);
});

test("bad: a bundle naming v2 and still a first-set delegate FAILs", () => {
  const b = structuredClone(G.bundle);
  b.names.robinhood.v1 = true;
  const j = judgeBundle(b, Object.fromEntries(CHAINS.map((c) => [c, { v2: G.deployments[c].contracts.SellDelegate.address.toLowerCase(), v1: "0x" }])));
  assert.equal(j.ok, false);
});

test("bad: one chain's v2 code with a byte flipped on one RPC FAILs", async () => {
  const log = structuredClone(G.log);
  const v2 = G.deployments.base.contracts.SellDelegate.address.toLowerCase();
  let n = 0;
  for (const e of log) {
    const q = e.body ? JSON.parse(e.body) : null;
    if (e.url === G.rpcs.base[0] && q?.method === "eth_getCode" && String(q.params?.[0]).toLowerCase() === v2) {
      const j = JSON.parse(e.text);
      j.result = j.result.slice(0, -2) + (j.result.endsWith("00") ? "01" : "00");
      e.text = JSON.stringify(j);
      n++;
    }
  }
  assert.ok(n > 0, "the code answer was found");
  assert.equal((await run({ log })).verdict, "FAIL");
});
