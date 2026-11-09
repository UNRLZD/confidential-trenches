// node --test scripts/live-checks/evm-pool-leaves-any-source.test.mjs: card evm-pool-leaves-any-source's live check,
// replayed. evm-pool-leaves-any-source.answers.json holds a real run (good: both pools' head on two operators, their
// views at the head hash, the leaf logs from the helper's keyed route, the two trees rebuilt equal to the views) and the
// bad run (see its `bad.note`: a planted leaf, since both pools hold none yet). Good passes; bad fails naming the tree
// whose size is not the pool's. Planted on the good one: two operators that differ on the head block or on a view, a log
// that is not the pool's. Held on a synthetic pool with leaves (the real ones hold none): a root that differs at equal
// size, a leaf dropped, a log in the head block under another hash, a refused page asked again, a range refusal that
// halves the page, an empty pool that passes only with no logs and root 0.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VaultTree } from "../../packages/kit/src/index.ts";
import { CHAINS, POOL_TOPICS, VIEWS, check, decode, fabricated, plantedBad, replayer } from "./evm-pool-leaves-any-source.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-pool-leaves-any-source.answers.json", import.meta.url), "utf8"));
const run = (r) => check(replayer(r.log), r.chains);

test("the good run is a run on both pools: Base and Robinhood, two operators each, the helper's route as the history", () => {
  assert.deepEqual(A.good.chains, JSON.parse(JSON.stringify(CHAINS)));
  assert.deepEqual(A.good.chains.map((c) => c.name), ["base", "robinhood"]);
  for (const c of A.good.chains) assert.equal(c.history, `https://ct-api.unrealized.trade/v1/rpc/${c.name}`);
});

test("the recorded good run passes: both pools' trees from the helper's logs equal their views at one head hash on two operators", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 2);
  assert.match(r.lines[0], /^PASS base: head \d+ 0x[0-9a-f]{64}, state size \d+ root 0x[0-9a-f]+, label size \d+ root 0x[0-9a-f]+, \d+ logs in \d+ pages from ct-api\.unrealized\.trade \(\d+ refused\), operators base-rpc\.publicnode\.com and base\.api\.pocket\.network agree$/);
  assert.match(r.lines[1], /^PASS robinhood: head \d+ 0x[0-9a-f]{64}, state size \d+ root 0x[0-9a-f]+, label size \d+ root 0x[0-9a-f]+, \d+ logs in \d+ pages from ct-api\.unrealized\.trade \(\d+ refused\), operators rpc\.mainnet\.chain\.robinhood\.com and robinhood\.api\.pocket\.network agree$/);
});

test("the recorded bad run fails: a history source that gives other leaves than the pool holds, its tree not the pool's", async () => {
  assert.ok(A.bad !== null && typeof A.bad.note === "string", "the file names how its bad run was made");
  const r = await run(A.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^FAIL the state tree from \d+ logs has (\d+ leaves, not the pool's \d+|root 0x[0-9a-f]+, not the pool's 0x[0-9a-f]+): /.test(l)), r.lines.join("\n"));
});

test("a leaf the pool does not hold, added to a pool's history, fails on that pool's state tree, size named, and the other pool still passes", async () => {
  for (const [k, name] of [[0, "base"], [1, "robinhood"]]) {
    const c = A.good.chains[k];
    let done = false;
    const log = A.good.log.map((e) => {
      if (done || e.url !== c.history || e.method !== "eth_getLogs" || !Array.isArray(e.result)) return e;
      done = true;
      return { ...e, result: [...e.result, fabricated(c.pool, c.from)] };
    });
    assert.equal(done, true, name);
    const r = await run({ ...A.good, log });
    assert.equal(r.ok, false, name);
    assert.match(r.lines[k], /^FAIL the state tree from 1 logs has 1 leaves, not the pool's 0: /, r.lines[k]);
    assert.match(r.lines[k], new RegExp(`${name} at 0x[0-9a-f]{64} \\(block \\d+\\) from ct-api\\.unrealized\\.trade$`));
    assert.match(r.lines[1 - k], /^PASS /);
  }
});

test("the bad run is the good one with that leaf planted: plantedBad builds the file's bad run", () => {
  assert.deepEqual(plantedBad(A.good).log, A.bad.log);
});

test("two operators that differ on the head block's hash fail, and on a view fail", async () => {
  const c = A.good.chains[0];
  const h = A.good.log.map((e) => (e.url === c.ops[1] && e.method === "eth_getBlockByNumber" ? { ...e, result: { ...e.result, hash: `0x${"ab".repeat(32)}` } } : e));
  const hr = await run({ ...A.good, log: h });
  assert.equal(hr.ok, false);
  assert.match(hr.lines[0], /^FAIL base: the operators differ on block \d+: /);
  const v = A.good.log.map((e) => (e.url === c.ops[1] && e.method === "eth_call" && e.params[0].data === VIEWS.size ? { ...e, result: `0x${"0".repeat(63)}1` } : e));
  const vr = await run({ ...A.good, log: v });
  assert.equal(vr.ok, false);
  assert.match(vr.lines[0], /^FAIL base: the operators differ on size at 0x[0-9a-f]{64}: /);
});

const decodeError = (raw) => {
  try {
    decode(raw, CHAINS[0].pool, 1n, 10n, "t");
  } catch (e) {
    return e.message;
  }
  return "no error";
};

test("a log that is not the pool's, outside its page, removed, of another event, of the wrong length or a leaf of 0 is refused", () => {
  const ok = fabricated(CHAINS[0].pool, 5);
  assert.equal(decodeError(ok), "no error");
  assert.match(decodeError({ ...ok, address: `0x${"9".repeat(40)}` }), /not the pool's log/);
  assert.match(decodeError({ ...ok, blockNumber: "0xb" }), /outside 1\.\.10/);
  assert.match(decodeError({ ...ok, removed: true }), /a removed log/);
  assert.match(decodeError({ ...ok, topics: [`0x${"1".repeat(64)}`, ok.topics[1]] }), /not Deposited, Withdrawn or Bought/);
  assert.match(decodeError({ ...ok, data: ok.data.slice(0, -64) }), /not 4 data words/);
  assert.match(decodeError({ ...ok, data: `0x${"0".repeat(256)}` }), /a leaf is not a field element above 0/);
});

// ---- a synthetic pool: the pager and the empty pool

const HASH = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const word = (v) => v.toString(16).padStart(64, "0");
const depositLog = (pool, block, index, commitment, label) => ({
  address: pool,
  blockNumber: `0x${block.toString(16)}`,
  blockHash: HASH(block),
  logIndex: `0x${index.toString(16)}`,
  transactionHash: HASH(1000 + block),
  transactionIndex: "0x0",
  topics: [POOL_TOPICS[0], `0x${"0".repeat(64)}`],
  data: `0x${word(commitment)}${word(label)}${word(5n)}${word(7n)}`,
  removed: false,
});

/** Two operators agreeing on a pool at `head` with these deposits, and a history that refuses ranges over `limit` blocks. */
function synthetic({ head = 100, deposits, limit = 100_000, flaky = 0, mutate = (l) => l }) {
  const pool = "0x" + "a".repeat(40);
  const state = new VaultTree(deposits.map((d) => d.commitment));
  const label = new VaultTree(deposits.map((d) => d.label));
  const ops = ["https://one.example", "https://two.example"];
  const chain = { name: "synth", ops, history: "https://history.example/rpc", pool, from: 10 };
  const calls = [];
  let refusals = flaky;
  const transport = async (url, method, params) => {
    calls.push([url, method, params]);
    if (method === "eth_blockNumber") return { result: `0x${(url === ops[0] ? head + 3 : head).toString(16)}` };
    if (method === "eth_getBlockByNumber") return { result: { number: params[0], hash: HASH(head) } };
    if (method === "eth_call") {
      const v = { [VIEWS.root]: state.root ?? 0n, [VIEWS.size]: BigInt(state.size), [VIEWS.labelRoot]: label.root ?? 0n, [VIEWS.labelSize]: BigInt(label.size) }[params[0].data];
      return { result: `0x${word(v)}` };
    }
    const [f] = params;
    const from = Number(BigInt(f.fromBlock));
    const to = Number(BigInt(f.toBlock));
    if (refusals > 0) {
      refusals--;
      return { error: "HTTP 503" };
    }
    if (to - from + 1 > limit) return { error: "HTTP 400 RPC error -32602: query exceeds max block range 1000" };
    return { result: mutate(deposits.map((d, i) => depositLog(pool, d.block, i, d.commitment, d.label)).filter((l) => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to)) };
  };
  return { chain, transport, calls };
}

const deposits = [
  { block: 12, commitment: 111n, label: 11n },
  { block: 40, commitment: 222n, label: 22n },
  { block: 100, commitment: 333n, label: 33n },
];

test("a synthetic pool passes with its logs in one page, and the head is the lower of the two operators'", async () => {
  const s = synthetic({ deposits });
  const r = await check(s.transport, [s.chain]);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0], /^PASS synth: head 100 0x0+64, state size 3 root 0x[0-9a-f]+, label size 3 root 0x[0-9a-f]+, 3 logs in 1 pages /);
});

test("a range refusal halves the page until the source answers; a refused page is asked again twice before it is halved", async () => {
  const s = synthetic({ deposits, limit: 30 });
  const r = await check(s.transport, [s.chain]);
  assert.equal(r.ok, true, r.lines.join("\n"));
  const sizes = s.calls.filter((c) => c[1] === "eth_getLogs").map((c) => Number(BigInt(c[2][0].toBlock) - BigInt(c[2][0].fromBlock)) + 1);
  // blocks 10..100 are 91: refused at 91, again twice at 91 (3 reads), then 45 (3 reads), then 22 answers
  assert.deepEqual(sizes.slice(0, 7), [91, 91, 91, 45, 45, 45, 22]);
  assert.match(r.lines[0], /3 logs in 5 pages from history\.example \(6 refused\)/);
  const f = synthetic({ deposits, flaky: 2 });
  const fr = await check(f.transport, [f.chain]);
  assert.equal(fr.ok, true, fr.lines.join("\n"));
  assert.match(fr.lines[0], /3 logs in 1 pages from history\.example \(2 refused\)/);
  const g = synthetic({ deposits, flaky: 3 });
  const gr = await check(g.transport, [g.chain]);
  assert.equal(gr.ok, false, "three refusals that are no range refusal end the walk");
  assert.match(gr.lines[0], /^FAIL history\.example: the pool's logs 10-100: HTTP 503$/);
});

test("a leaf changed in a log fails on the root at the same size; a log dropped fails on the size", async () => {
  const changed = synthetic({ deposits, mutate: (l) => l.map((x, i) => (i === 1 ? { ...x, data: `0x${word(999n)}${x.data.slice(66)}` } : x)) });
  const c = await check(changed.transport, [changed.chain]);
  assert.equal(c.ok, false);
  assert.match(c.lines[0], /^FAIL the state tree from 3 logs has root 0x[0-9a-f]+, not the pool's 0x[0-9a-f]+: synth at 0x0+64 \(block 100\) from history\.example$/);
  const dropped = synthetic({ deposits, mutate: (l) => l.slice(1) });
  const d = await check(dropped.transport, [dropped.chain]);
  assert.equal(d.ok, false);
  assert.match(d.lines[0], /^FAIL the state tree from 2 logs has 2 leaves, not the pool's 3: /);
  const labels = synthetic({ deposits, mutate: (l) => l.map((x, i) => (i === 2 ? { ...x, data: `${x.data.slice(0, 66)}${word(77n)}${x.data.slice(130)}` } : x)) });
  const lr = await check(labels.transport, [labels.chain]);
  assert.equal(lr.ok, false);
  assert.match(lr.lines[0], /^FAIL the label tree from 3 logs has root 0x[0-9a-f]+, not the pool's 0x[0-9a-f]+: /);
});

test("a log in the head block under another hash fails", async () => {
  const s = synthetic({ deposits, mutate: (l) => l.map((x) => (x.blockNumber === "0x64" ? { ...x, blockHash: `0x${"cd".repeat(32)}` } : x)) });
  const r = await check(s.transport, [s.chain]);
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^FAIL history\.example: .*a log in the head block 100 carries 0x(cd)+, not the head hash 0x0+64$/);
});

test("an empty pool passes only with no logs and root 0; a pool with leaves the source does not give fails", async () => {
  const e = synthetic({ deposits: [] });
  const er = await check(e.transport, [e.chain]);
  assert.equal(er.ok, true, er.lines.join("\n"));
  assert.match(er.lines[0], /state size 0 root 0x0, label size 0 root 0x0, 0 logs in 1 pages /);
  const s = synthetic({ deposits, mutate: () => [] });
  const r = await check(s.transport, [s.chain]);
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^FAIL the state tree from 0 logs has 0 leaves, not the pool's 3: /);
});

test("two operators of one company fail before any read", async () => {
  const s = synthetic({ deposits });
  const r = await check(s.transport, [{ ...s.chain, ops: ["https://rpc.mainnet.chain.robinhood.com", "https://rpc.testnet.chain.robinhood.com"] }]);
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^FAIL synth: the two operators are not two companies: /);
  assert.equal(s.calls.length, 0);
});

// card live-checks-provider-no-answer: every provider read goes through provider-answer.mjs; a provider's no-answer,
// still one after three reads, makes that chain INCONCLUSIVE (exit 3), never a FAIL or a PASS
test("a no-answer from an operator or from the history source makes that chain INCONCLUSIVE, the other still judged", async () => {
  const { EXIT } = await import("./provider-answer.mjs");
  const { WAIT } = await import("./evm-pool-leaves-any-source.mjs");
  WAIT.ms = 0;
  for (const [name, quiet] of [
    ["an operator's view", (url, method) => url === "https://two.example" && method === "eth_call"],
    ["the history's page", (_url, method) => method === "eth_getLogs"],
  ]) {
    const s = synthetic({ deposits });
    const t = async (url, method, params) => (quiet(url, method) ? { noAnswer: `${new URL(url).host} HTTP 429: 429 Too Many Requests` } : s.transport(url, method, params));
    const r = await check(t, [s.chain]);
    assert.equal(r.verdict, "INCONCLUSIVE", name);
    assert.equal(r.ok, false, name);
    assert.match(r.lines[0], /^INCONCLUSIVE synth: .*HTTP 429/, name);
    assert.equal(EXIT[r.verdict], 3);
  }
  // a wrong answer on one chain is a FAIL whatever the other chain's no-answer
  const w = synthetic({ deposits, mutate: (l) => l.slice(1) });
  const q = synthetic({ deposits });
  const other = { ...q.chain, name: "other", pool: `0x${"b".repeat(40)}` };
  const pick = (params) => params?.[0]?.to ?? params?.[0]?.address;
  const t = async (url, method, params) => {
    if (pick(params) !== other.pool) return w.transport(url, method, params);
    return method === "eth_getLogs" ? { noAnswer: "history.example: no answer (ETIMEDOUT)" } : q.transport(url, method, params);
  };
  const r = await check(t, [w.chain, other]);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.match(r.lines[0], /^FAIL the state tree from 2 logs has 2 leaves, not the pool's 3: /);
  assert.match(r.lines[1], /^INCONCLUSIVE other: the pool's logs 10-100: history\.example: no answer \(ETIMEDOUT\)$/);
});

test("the pool's topics are robinhood-mainnet-rpcs's, and the check reads providers only through provider-answer.mjs", async () => {
  const { POOL_TOPICS: theirs } = await import("./robinhood-mainnet-rpcs.mjs");
  assert.deepEqual([...POOL_TOPICS], [...theirs]);
  const src = readFileSync(new URL("./evm-pool-leaves-any-source.mjs", import.meta.url), "utf8");
  assert.match(src, /from "\.\/provider-answer\.mjs"/);
  assert.doesNotMatch(src, /jsonrpc/);
});

test("a no-answer read again is judged on the answer that follows (the helper's 429 waited out)", async () => {
  const { WAIT } = await import("./evm-pool-leaves-any-source.mjs");
  WAIT.ms = 0;
  const s = synthetic({ deposits });
  let n = 0;
  const t = async (url, method, params) => (method === "eth_getLogs" && n++ < 4 ? { noAnswer: "history.example HTTP 429: 429 Too Many Requests" } : s.transport(url, method, params));
  const r = await check(t, [s.chain]);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
});
