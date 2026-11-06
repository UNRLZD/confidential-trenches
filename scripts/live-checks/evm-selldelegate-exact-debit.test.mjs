// Replays evm-selldelegate-exact-debit.answers.json (recorded on Base Sepolia and Robinhood testnet, each on its two
// RPCs) through the live check: the recorded good answers pass; the same recording with one thing changed fails: the
// evm-sell-v4 delegate's code (the build before the exact-debit check) at the new address, one byte of the code
// flipped, a record naming an address the build file froze to another build (the evm-sell-v4 one) or to no older
// build (the current build, since pool review round 2 moved it on) (the kit's pin moved on with card
// evm-testnet-delegate-review3, whose check holds it);
// and the runs through it: each run's recorded answers pass and its spoiled ones (a spent nullifier the pool never
// marked) fail, a chain whose only runs stopped fails, and so does a run from before the redeploy.
//   node --test scripts/live-checks/evm-selldelegate-exact-debit.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS as RUN_CHAINS, check, checkRuns } from "./evm-selldelegate-exact-debit.mjs";
import { replayer } from "./notes-per-pool-evm.mjs";
import { BUILD, CHAINS } from "./pool-evm-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-selldelegate-exact-debit.answers.json", import.meta.url), "utf8"));
const V4 = JSON.parse(readFileSync(new URL("./evm-sell-v4.answers.json", import.meta.url), "utf8"));
const CHAIN_NAMES = Object.keys(CHAINS);
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
const run = (chain, answers = A.good[chain], d = A.deployments[chain]) =>
  check({ deployment: d, fetchFn: replay(answers), rpcs: A.rpcs[chain], sleep: async () => {} });
const del = (chain) => A.deployments[chain].contracts.SellDelegate.address;
const isCode = (addr) => (a) => a.method === "eth_getCode" && lower(a.params[0]) === lower(addr);
/** the chain's recording with every answer `pick(a)` selects changed by `f(a.json)`, on the first RPC only */
function mutate(chain, pick, f) {
  const out = structuredClone(A.good[chain]);
  let n = 0;
  for (const a of out) if (a.url === A.rpcs[chain][0] && pick(a)) (f(a.json), n++);
  assert.ok(n > 0, "the mutation found its answer");
  return out;
}
const fails = (r, re) => {
  assert.equal(r.ok, false);
  assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), re);
};

test("the recorded good answers pass on both chains: the exact-debit build frozen to its address", async () => {
  assert.deepEqual(Object.keys(A.deployments).sort(), CHAIN_NAMES.slice().sort());
  for (const chain of CHAIN_NAMES) {
    const r = await run(chain);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.startsWith("ok   SellDelegate") && l.includes("code is the build pinned to it:")), chain);
    assert.ok(r.lines.some((l) => l.startsWith("ok   SellDelegate") && l.endsWith("is pinned to the exact-debit build the build file froze")), chain);
  }
});

test("the evm-sell-v4 delegate's code (no exact-debit check) at the new address fails, and so does one byte flipped", async () => {
  for (const chain of CHAIN_NAMES) {
    const old = V4.deployments[chain].contracts.SellDelegate.address;
    const code = V4.good[chain].find((a) => isCode(old)(a)).json.result;
    assert.notEqual(code.length, 2 + 2 * BUILD.frozen["SellDelegate.exact-debit"].length, "the old build has another length");
    fails(await run(chain, mutate(chain, isCode(del(chain)), (j) => (j.result = code))), /code is the build pinned to it/);
    fails(await run(chain, mutate(chain, isCode(del(chain)), (j) => (j.result = j.result.slice(0, 40) + (j.result[40] === "0" ? "1" : "0") + j.result.slice(41)))), /code is the build pinned to it/);
  }
});

test("a record naming another address fails: one the build file froze to the evm-sell-v4 build, or one it pins to no older build", async () => {
  const chain = "base-sepolia";
  for (const at of [BUILD.frozen["SellDelegate.v4"].at[chain], "0x" + "ab".repeat(20)]) {
    const d = structuredClone(A.deployments[chain]);
    d.contracts.SellDelegate.address = at;
    const r = await check({ deployment: d, fetchFn: async () => { throw new Error("no read"); }, rpcs: A.rpcs[chain], sleep: async () => {} });
    fails(r, /SellDelegate \S+ is pinned to the exact-debit build the build file froze/);
  }
});

const runsOf = (pick = (r) => r.good) => A.runs.map((r) => ({ ...r, answers: pick(r) }));
const runOn = (runs) => checkRuns(runs, (r) => replayer(r.answers), A.deployments);

test("the runs through the new delegate pass, and each chain has one that sold", async () => {
  assert.ok(A.runs.length >= RUN_CHAINS.length);
  const r = await runOn(runsOf());
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const c of RUN_CHAINS) assert.ok(r.lines.some((l) => l.startsWith(`ok   ${c}: a run that sold`)), c);
});

test("a run's spoiled answers fail; a chain with only stopped runs, or a run from before the redeploy, fails", async () => {
  fails(await runOn(runsOf((r) => r.bad)), /run /);
  for (const c of RUN_CHAINS) {
    const stoppedOnly = runsOf().map((r) => (r.record.chain === c ? { ...r, record: { ...r.record, stopped: r.record.stopped ?? "stopped (planted)" } } : r));
    fails(await runOn(stoppedOnly), new RegExp(`${c}: a run that sold`));
    const early = runsOf().map((r) => (r.record.chain === c ? { ...r, record: { ...r.record, at: "2026-11-04T07:00:00.000Z" } } : r));
    fails(await runOn(early), new RegExp(`${c}: a run that sold`));
  }
});
