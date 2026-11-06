// Replays evm-testnet-delegate-review3.answers.json (recorded on Base Sepolia and Robinhood testnet, each on its two
// RPCs) through the live check: the recorded good answers (the redeploys at the kit's pins) pass; the recorded bad ones
// (main 0628a2d5's pins, the exact-debit delegates: a frozen 10-field build dispatching 0xbea5695c) fail; and the good
// recording with one thing changed fails: the old delegate's code at the new address, one byte of the code flipped,
// and a kit pin naming another delegate or none.
//   node --test scripts/live-checks/evm-testnet-delegate-review3.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, check, runRecord } from "./evm-testnet-delegate-review3.mjs";
import { BUILD } from "./pool-evm-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-testnet-delegate-review3.answers.json", import.meta.url), "utf8"));
const lower = (s) => String(s).toLowerCase();

function replay(answers) {
  const used = new Set();
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const i = answers.findIndex((a, j) => !used.has(j) && a.url === url && a.method === method && JSON.stringify(a.params) === JSON.stringify(params));
    if (i < 0) throw new Error(`no recorded answer for ${method} ${JSON.stringify(params).slice(0, 80)} on ${url}`);
    used.add(i);
    const a = answers[i];
    return { ok: a.status === 200, status: a.status, json: async () => a.json };
  };
}
const run = (chain, { answers = A.good[chain], d = A.deployments[chain], venues } = {}) =>
  check({ deployment: d, fetchFn: replay(answers), rpcs: A.rpcs[chain], sleep: async () => {}, ...(venues ? { venues } : {}) });
const del = (chain) => A.deployments[chain].contracts.SellDelegate.address;
const isCode = (addr) => (a) => a.method === "eth_getCode" && lower(a.params[0]) === lower(addr);
/** the chain's good recording with every code answer at the new delegate on both RPCs set by `f` */
function withCode(chain, f) {
  const out = structuredClone(A.good[chain]);
  let n = 0;
  for (const a of out) if (isCode(del(chain))(a)) (a.json.result = f(a.json.result), n++);
  assert.ok(n >= 4, "both reads on both RPCs");
  return out;
}
const fails = (r, re) => {
  assert.equal(r.ok, false);
  assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), re);
};

test("the recorded good answers pass on both chains: the current build at the kit's pin, dispatching the 11-field sell", async () => {
  assert.deepEqual(Object.keys(A.deployments).sort(), [...CHAINS].sort());
  for (const chain of CHAINS) {
    const r = await run(chain);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.startsWith("ok   SellDelegate") && l.includes("(the current one)")), chain);
    assert.equal(r.lines.filter((l) => l.startsWith("ok   SellDelegate") && l.includes("dispatches the 11-field sell")).length, 2, chain);
    assert.ok(r.lines.some((l) => l.startsWith("ok   the kit pins SellDelegate")), chain);
  }
});

test("the recorded bad answers fail: main's pins at the exact-debit delegates, a frozen build dispatching the 10-field sell", async () => {
  for (const chain of CHAINS) {
    const b = A.bad[chain];
    const a = b.deployment.contracts.SellDelegate.address;
    const r = await run(chain, { answers: b.answers, d: b.deployment, venues: { [chain]: { sellDelegate: a } } });
    fails(r, /is not an address the build file froze to an older build/);
    fails(r, /dispatches the 11-field sell the kit signs, not the 10-field one, on \S+: 0x0c2cb9ca absent, 0xbea5695c dispatched/);
  }
});

test("the old delegate's code at the new address fails, and so does one byte flipped", async () => {
  for (const chain of CHAINS) {
    const b = A.bad[chain];
    const old = b.answers.find(isCode(b.deployment.contracts.SellDelegate.address)).json.result;
    assert.equal((old.length - 2) / 2, BUILD.frozen["SellDelegate.exact-debit"].length, "the bad recording holds the frozen build");
    const r = await run(chain, { answers: withCode(chain, () => old) });
    fails(r, /code is the build pinned to it/);
    fails(r, /0xbea5695c dispatched/);
    fails(await run(chain, { answers: withCode(chain, (c) => c.slice(0, 4) + (c[4] === "0" ? "1" : "0") + c.slice(5)) }), /code is the build pinned to it/);
  }
});

test("a kit pin naming another delegate, or none, fails", async () => {
  for (const chain of CHAINS) {
    fails(await run(chain, { venues: { [chain]: { sellDelegate: A.bad[chain].deployment.contracts.SellDelegate.address } } }), /the kit pins SellDelegate/);
    fails(await run(chain, { venues: {} }), /the kit pins SellDelegate .*: none/);
  }
});

test("the run record names every redeploy transaction and each run key's funding, Money path: yes", () => {
  const text = runRecord(CHAINS.map((c) => A.deployments[c]));
  assert.match(text, /^CARD evm-testnet-delegate-review3 \/ live: PASS\nMoney path: yes\n/);
  const tx = text.split("\n").filter((l) => l.startsWith("Tx: "));
  assert.equal(tx.length, 6);
  for (const c of CHAINS) for (const t of A.deployments[c].txs) assert.ok(tx.includes(`Tx: ${c} ${t.hash}`), t.hash);
  assert.equal(text, readFileSync(new URL("./evm-testnet-delegate-review3.md", import.meta.url), "utf8"));
});
