// Replays evm-testnet-delegate-review3.answers.json (recorded on Base Sepolia and Robinhood testnet, each on its two
// RPCs, and HELPER_HOST) through the live check: the recorded good answers (the redeploys at the kit's pins) pass; the
// recorded bad ones (main 0628a2d5's pins, the exact-debit delegates: a frozen 10-field build dispatching 0xbea5695c)
// fail; and the good recording with one thing changed fails: the old delegate's code at the new address, one byte of
// the code flipped, a kit pin naming another delegate or none, a fee answer naming another fee collector or sell
// sender or none; and the runs: each run's spoiled answers (a spent nullifier the pool never marked) fail, a helper
// sell whose receipt lacks the collector's Paid log on one RPC fails, and so does a chain whose run sold before the
// redeploy or not through the helper.
//   node --test scripts/live-checks/evm-testnet-delegate-review3.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { CHAINS, check, checkHelper, checkRuns, runRecord } from "./evm-testnet-delegate-review3.mjs";
import { replayer } from "./notes-per-pool-evm.mjs";
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

// each half of the selector rule on its own: code that dispatches both sells (the 10-field one beside the 11-field)
// fails, and so does code that dispatches neither
test("code dispatching both sells, or neither, fails on the selector line", async () => {
  for (const chain of CHAINS) {
    const both = await run(chain, { answers: withCode(chain, (c) => c + "63bea5695c") });
    fails(both, /dispatches the 11-field sell the kit signs, not the 10-field one, on \S+: 0x0c2cb9ca dispatched, 0xbea5695c dispatched/);
    const neither = await run(chain, { answers: withCode(chain, (c) => c.split("630c2cb9ca").join("63deadbeef")) });
    fails(neither, /dispatches the 11-field sell the kit signs, not the 10-field one, on \S+: 0x0c2cb9ca absent, 0xbea5695c absent/);
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

test("HELPER_HOST's fee answers name the kit's fee collector and sell sender; another of either, or no answer, fails", () => {
  const h = checkHelper(A.helper);
  assert.equal(h.ok, true, h.lines.join("\n"));
  for (const c of CHAINS) assert.equal(h.senders[c], lower(evmPoolVenues()[c].sellSender), c);
  for (const i of A.helper.keys())
    for (const [field, re] of [["fee_collector", /fee collector/], ["sell_sender", /sell sender/]]) {
      const bad = structuredClone(A.helper);
      const b = JSON.parse(bad[i].body);
      b[field] = "0x" + "ba".repeat(20);
      bad[i].body = JSON.stringify(b);
      fails(checkHelper(bad), re);
    }
  fails(checkHelper(A.helper.map((a) => ({ ...a, status: 503 }))), /fee collector/);
  fails(checkHelper([]), /fee collector \(none\)/);
});

// the runs through the helper are recorded after the helper's deploy at main with these pins; until then these skip
const NO_RUNS = (A.runs ?? []).length === 0 && "the sells through the helper are not recorded yet";
const senders = () => checkHelper(A.helper).senders;
const runsOf = (pick = (r) => r.good) => A.runs.map((r) => ({ ...r, answers: pick(r) }));
const runOn = (runs) => checkRuns(runs, (r) => replayer(r.answers), A.deployments, senders());

test("no run, or none through the helper, fails on every chain", async () => {
  const r = await checkRuns([], () => replayer([]), A.deployments, senders());
  for (const c of CHAINS) fails(r, new RegExp(`${c}: a run that sold through the helper`));
});

test("the runs through the new delegate pass: each sold through the helper after the redeploy, the collector's Paid log on both RPCs", { skip: NO_RUNS }, async () => {
  assert.equal(A.runs.length, CHAINS.length);
  const r = await runOn(runsOf());
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const c of CHAINS) {
    assert.ok(r.lines.some((l) => l.startsWith(`ok   ${c}: a run that sold through the helper`)), c);
    assert.ok(r.lines.some((l) => l.startsWith(`ok   ${c} sell `) && l.includes("Paid(W")), c);
  }
});

test("a run's spoiled answers fail; a sell receipt with no Paid log on one RPC, a run from before the redeploy, or a run with no helper sell, fails", { skip: NO_RUNS }, async () => {
  fails(await runOn(runsOf((r) => r.bad)), /run\]/);
  for (const c of CHAINS) {
    const noPaid = runsOf().map((r) => {
      if (r.record.chain !== c) return r;
      const hash = r.record.txs.find((t) => t.kind === "sell" && t.via === "helper").hash;
      const url = r.urls[1];
      return { ...r, answers: r.answers.map((e) => (e.method === "eth_getTransactionReceipt" && e.params[0] === hash && e.url === url && e.result ? { ...e, result: { ...e.result, logs: e.result.logs.filter((l) => lower(l.address) !== lower(evmPoolVenues()[c].feeCollector)) } } : e)) };
    });
    fails(await runOn(noPaid), new RegExp(`${c} sell 0x[0-9a-f]+: its receipt carries the FeeCollector`));
    const early = runsOf().map((r) => (r.record.chain === c ? { ...r, record: { ...r.record, at: "2026-11-06T00:00:00.000Z" } } : r));
    fails(await runOn(early), new RegExp(`${c}: a run that sold through the helper`));
    const notHelper = runsOf().map((r) => (r.record.chain === c ? { ...r, record: { ...r.record, txs: r.record.txs.map((t) => (t.kind === "sell" ? { ...t, via: undefined } : t)) } } : r));
    fails(await runOn(notHelper), new RegExp(`${c}: a run that sold through the helper`));
  }
});

test("a run record with a run but no funding line for its key is refused", () => {
  const ds = CHAINS.map((c) => A.deployments[c]);
  const fake = { chain: CHAINS[0], chainId: 1, at: "2026-11-07T00:00:00.000Z", pool: "0x", coin: "0x", venues: ["v4"], txs: [], relayer: "0x", need: "0", return: "0x" };
  assert.throws(() => runRecord(ds, [fake], {}), /no funding recorded/);
});
