// Replays evm-testnet-delegate-review3.answers.json (recorded on Base Sepolia and Robinhood testnet, each on its two
// RPCs, and HELPER_HOST) through the live check: the recorded good answers (the redeploys at the kit's pins) pass; the
// recorded bad ones (main 0628a2d5's pins, the exact-debit delegates: a frozen 10-field build dispatching 0xbea5695c)
// fail; and the good recording with one thing changed fails: the old delegate's code at the new address, one byte of
// the code flipped, a fee answer naming another fee collector or sell sender or none; a moved kit pin, or a rebuild
// that freezes this build at its address, still passes (a frozen build naming no sell fails); and the runs: each run's
// spoiled answers (a spent nullifier the pool never marked) fail, and so does a helper sell receipt planted with each
// Paid rule broken (no Paid log on one RPC, the log at another address, for another W, one wei short or over, removed,
// a reverted receipt, a zero fee, a Sell paying another recipient) and a chain whose run sold before the redeploy or not
// through the helper.
//   node --test scripts/live-checks/evm-testnet-delegate-review3.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { CHAINS, FUNDINGS, RUN_FUNDINGS, RUN_SENDERS, check, checkHelper, checkRuns, collectorAt, runRecord } from "./evm-testnet-delegate-review3.mjs";
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
const run = (chain, { answers = A.good[chain], d = A.deployments[chain], venues, build } = {}) =>
  check({ deployment: d, fetchFn: replay(answers), rpcs: A.rpcs[chain], sleep: async () => {}, ...(venues ? { venues } : {}), ...(build ? { build } : {}) });
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

test("the recorded good answers pass on both chains: the build pinned to the address, naming and dispatching the 11-field sell", async () => {
  assert.deepEqual(Object.keys(A.deployments).sort(), [...CHAINS].sort());
  for (const chain of CHAINS) {
    const r = await run(chain);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.equal(r.lines.filter((l) => l.startsWith("ok   SellDelegate") && l.includes("code is the build pinned to it")).length, 2, chain);
    assert.ok(r.lines.some((l) => l.startsWith("ok   the build pinned to SellDelegate") && l.endsWith(": 0x0c2cb9ca")), chain);
    assert.equal(r.lines.filter((l) => l.startsWith("ok   SellDelegate") && l.includes("dispatches the 11-field sell")).length, 2, chain);
    assert.ok(!r.lines.some((l) => l.includes("the kit pins")), chain);
  }
});

test("the recorded bad answers fail: main's pins at the exact-debit delegates, a frozen build dispatching the 10-field sell", async () => {
  for (const chain of CHAINS) {
    const b = A.bad[chain];
    const a = b.deployment.contracts.SellDelegate.address;
    const r = await run(chain, { answers: b.answers, d: b.deployment, venues: { [chain]: { sellDelegate: a } } });
    fails(r, new RegExp(`the build pinned to SellDelegate ${a} on ${chain} names the 11-field sell 0x0c2cb9ca: 0xbea5695c`));
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

// the review of 14196e5c: the check runs after every helper deploy, so it holds only its own end state. A later card
// that moves the kit's pin, or rebuilds the delegate (the build file then freezes this build at this address), leaves
// it passing on this record; a frozen build at the address that names no sell is refused, never given a guess
test("a moved kit pin, or a rebuild that freezes this build at its address, still passes; a frozen build naming no sell fails", async () => {
  const later = (sell) => {
    const frozen = { ...BUILD.contracts.SellDelegate, contract: "SellDelegate", note: "a test's freeze", sell, at: Object.fromEntries(CHAINS.map((c) => [c, del(c)])) };
    return { ...BUILD, contracts: { ...BUILD.contracts, SellDelegate: { ...BUILD.contracts.SellDelegate, masked: "0x" + "12".repeat(32), sell: "0x12345678" } }, frozen: { ...BUILD.frozen, "SellDelegate.review3": frozen } };
  };
  for (const chain of CHAINS) {
    for (const venues of [{ [chain]: { sellDelegate: A.bad[chain].deployment.contracts.SellDelegate.address } }, {}]) {
      const r = await run(chain, { venues });
      assert.equal(r.ok, true, r.lines.join("\n"));
    }
    const r = await run(chain, { build: later(BUILD.contracts.SellDelegate.sell) });
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.ok(!r.lines.some((l) => l.includes("(the current one)")), chain);
    fails(await run(chain, { build: later(undefined) }), /names no sell selector/);
  }
});

test("the run record names every redeploy and run transaction, each run key's funding and each sell's Paid log, Money path: yes", async () => {
  const runs = A.runs.map((r) => r.record);
  const { paid } = await checkRuns(runsOf(), (r) => replayer(r.answers), A.deployments);
  const text = runRecord(CHAINS.map((c) => A.deployments[c]), runs, RUN_FUNDINGS, paid);
  assert.match(text, /^CARD evm-testnet-delegate-review3 \/ live: PASS\nMoney path: yes\n/);
  const tx = text.split("\n").filter((l) => l.startsWith("Tx: "));
  const want = [
    ...CHAINS.flatMap((c) => A.deployments[c].txs.map((t) => `Tx: ${c} ${t.hash}`)),
    ...CHAINS.map((c) => `Tx: ${c} ${FUNDINGS[c]}`),
    ...runs.flatMap((r) => [...r.txs.map((t) => `Tx: ${r.chain} ${t.hash}`), `Tx: ${r.chain} ${RUN_FUNDINGS[r.relayer]}`]),
  ];
  assert.deepEqual([...tx].sort(), [...new Set(want)].sort());
  assert.equal(tx.length, new Set(tx).size, "each Tx line once");
  for (const c of CHAINS) assert.ok(paid.some((p) => p.chain === c && p.collector === collectorAt(c) && BigInt(p.value) > 0n), c);
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
const runsOf = (pick = (r) => r.good) => A.runs.map((r) => ({ ...r, answers: pick(r) }));
const runOn = (runs, collectorOf) => checkRuns(runs, (r) => replayer(r.answers), A.deployments, undefined, collectorOf);

// the runs are held to the sell senders and collectors of their own time, which were the kit's pins and HELPER_HOST's
// fee answers then (answers.json "helper"), and stay so when either later moves
test("the runs' senders and collectors are those the kit pinned and HELPER_HOST answered when they ran", () => {
  assert.deepEqual(checkHelper(A.helper).senders, { ...RUN_SENDERS });
  for (const c of CHAINS) {
    assert.equal(collectorAt(c), lower(evmPoolVenues()[c].feeCollector), c);
    assert.equal(JSON.parse(A.helper.find((h) => h.network === c).body).fee_collector.toLowerCase(), collectorAt(c), c);
  }
});

test("no run, or none through the helper, fails on every chain", async () => {
  const r = await checkRuns([], () => replayer([]), A.deployments);
  for (const c of CHAINS) fails(r, new RegExp(`${c}: a run that sold through the helper`));
});

test("the runs through the new delegate pass: each sold through the helper after the redeploy, the collector's Paid log on both RPCs", { skip: NO_RUNS }, async () => {
  for (const c of CHAINS) assert.ok(A.runs.some((r) => r.record.chain === c && !r.record.stopped), c);
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
      if (r.record.chain !== c || r.record.stopped) return r;
      const hash = r.record.txs.find((t) => t.kind === "sell" && t.via === "helper").hash;
      const url = r.urls[1];
      return { ...r, answers: r.answers.map((e) => (e.method === "eth_getTransactionReceipt" && e.params[0] === hash && e.url === url && e.result ? { ...e, result: { ...e.result, logs: e.result.logs.filter((l) => lower(l.address) !== lower(evmPoolVenues()[c].feeCollector)) } } : e)) };
    });
    fails(await runOn(noPaid), new RegExp(`${c} sell 0x[0-9a-f]+: the Sell pays the FeeCollector`));
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

// The review of 14196e5c: each rule of a sell's Paid read, broken on its own in the good recording of the run that sold
// (on both RPCs, so no other rule's cross-RPC read is what fails), fails that sell's line. `f(e, url)` returns the
// changed answer for each eth_getTransactionByHash or eth_getTransactionReceipt answer of the helper sell.
const word = (x) => BigInt(x).toString(16).padStart(64, "0");
function plant(c, f) {
  return runsOf().map((r) => {
    if (r.record.chain !== c || r.record.stopped) return r;
    const hash = r.record.txs.find((t) => t.kind === "sell" && t.via === "helper").hash;
    let n = 0;
    const answers = r.answers.map((e) => {
      if (!["eth_getTransactionByHash", "eth_getTransactionReceipt"].includes(e.method) || e.params[0] !== hash || !e.result) return e;
      n++;
      return f(structuredClone(e));
    });
    assert.ok(n >= 4, "the tx and its receipt on both RPCs");
    return { ...r, answers };
  });
}
const paidLog = (e, c) => e.result.logs.find((l) => lower(l.address) === collectorAt(c));
const receipt = (g) => (e) => (e.method === "eth_getTransactionReceipt" ? g(e) : e);
const sellLine = (c) => new RegExp(`${c} sell 0x[0-9a-f]+: the Sell pays the FeeCollector`);

test("a helper sell's Paid read fails on each rule broken alone: address, W, value one wei short or over, removed, reverted, zero fee, another fee recipient, no collector", { skip: NO_RUNS }, async () => {
  for (const c of CHAINS) {
    const fee = BigInt(A.runs.find((r) => r.record.chain === c && !r.record.stopped).record.txs.find((t) => t.kind === "sell" && t.via === "helper").fee);
    assert.equal(fee, 20000000000000n, c);
    const planted = {
      "the log at another address": receipt((e) => ((paidLog(e, c).address = "0x" + "c0".repeat(20)), e)),
      "topic1 another W": receipt((e) => ((paidLog(e, c).topics[1] = "0x" + word("0x" + "ab".repeat(20))), e)),
      "data at fee - 1": receipt((e) => ((paidLog(e, c).data = "0x" + word(fee - 1n)), e)),
      "data at fee + 1": receipt((e) => ((paidLog(e, c).data = "0x" + word(fee + 1n)), e)),
      "removed true": receipt((e) => ((paidLog(e, c).removed = true), e)),
      "status 0x0": receipt((e) => ((e.result.status = "0x0"), e)),
      // the call's fee word and the Paid value both 0: only the zero fee breaks a rule
      "fee 0": (e) => {
        if (e.method === "eth_getTransactionByHash") e.result.input = e.result.input.slice(0, 10 + 64) + word(0) + e.result.input.slice(10 + 128);
        else paidLog(e, c).data = "0x" + word(0);
        return e;
      },
      // the Sell's feeRecipient (tuple field 8) another address
      "another fee recipient": (e) => {
        if (e.method !== "eth_getTransactionByHash") return e;
        const i = e.result.input;
        const at = 10 + Number(BigInt("0x" + i.slice(10, 10 + 64))) * 2 + 8 * 64;
        assert.equal("0x" + i.slice(at + 24, at + 64), collectorAt(c), "the recorded Sell pays the collector");
        e.result.input = i.slice(0, at) + word("0x" + "fe".repeat(20)) + i.slice(at + 64);
        return e;
      },
    };
    for (const [name, f] of Object.entries(planted)) {
      const r = await runOn(plant(c, f));
      assert.equal(r.ok, false, `${c} ${name}`);
      assert.ok(r.lines.some((l) => l.startsWith("FAIL") && sellLine(c).test(l)), `${c} ${name}: ${r.lines.filter((l) => l.startsWith("FAIL")).join(" | ")}`);
    }
    // no collector deployed on the chain (or only a dry run's), and a record whose feeTo is another address
    const none = await runOn(runsOf(), (chain) => (chain === c ? null : collectorAt(chain)));
    assert.ok(none.lines.some((l) => l.startsWith("FAIL") && new RegExp(`${c} sell 0x[0-9a-f]+: the Sell pays the FeeCollector \\(none\\)`).test(l)), c);
    const feeTo = runsOf().map((r) => (r.record.chain === c ? { ...r, record: { ...r.record, txs: r.record.txs.map((t) => (t.kind === "sell" ? { ...t, feeTo: "0x" + "fe".repeat(20) } : t)) } } : r));
    assert.ok((await runOn(feeTo)).lines.some((l) => l.startsWith("FAIL") && sellLine(c).test(l)), c);
  }
});
