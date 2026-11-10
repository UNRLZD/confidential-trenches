// Replays card evm-quote-read-gas-starve's live check on its recorded answers (evm-quote-read-gas-starve.answers.json).
// Good: `good`, a real run (its `at`) on every pinned mainnet quote provider (Base 4, Robinhood 5), all of a chain at
// one block, the lowest of their latest (rpc-robinhood.globalstake.io answered its call of 64 reads HTTP 500, a
// no-answer, so Robinhood is judged on four): the kit's EVM_READ_GAS_CODE at Multicall3 with EVM_READ_CALL_GAS answers the six planted reads
// [1 7, 2 empty, 1 7, 0 0xaa, 2 0xee, 1 7], 64 reads with the loop first 2 then 63 of 1, six reads, the first a revert
// after 14M gas, [0 0xbb, then five of 1 7], and the loop then five reads of 1.5M [2, then five of 1 7], each answer
// ending in the code's marker, each read's gas used beside its answer, the same on every provider of a chain (card
// evm-quote-gas-used). Bad: `bad`, the same run
// through Multicall3's own code, as the kit sent its reads before the card: the loop and the read that caught its
// inner out of gas answer 0, a revert, as the kit priced them. Split: `split`, a real run as the check read before card
// evm-read-gas-one-unit-apart, each provider at its own latest block: every read's answer right on each, and the loop's
// gas used in the call of 64 one apart on Robinhood (29,533,497 and 29,533,498), as Nitro cuts a call's gas by its L1
// data cost, which moves with the block's base fee and L1 price (live run 42755053001 failed so, its floor loop
// 31,046,540 on publicnode and 31,046,541 on the four others); gas used is compared at one block only.
//   node --test scripts/live-checks/evm-quote-read-gas-starve.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { collect, EXIT, gasOf, judge } from "./evm-quote-read-gas-starve.mjs";
import { RETRY } from "./provider-answer.mjs";
import { JUDGED_403, NO_ANSWERS } from "./provider-answer.plants.mjs";

// a no-answer is read again at once here, not after provider-answer.mjs's pause
RETRY.ms = 0;

const A = JSON.parse(readFileSync(new URL("./evm-quote-read-gas-starve.answers.json", import.meta.url), "utf8"));

test("the good answer (the kit's per-read gas code) passes on every provider of both chains", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.verdict, "PASS");
  const reads = A.good.chains.flatMap((c) => c.reads);
  const answered = reads.filter((x) => x.noAnswer === undefined).length;
  assert.ok(answered >= 4, `${answered} providers`);
  // per chain its count, its one block and its gas used alike; per provider five lines, or one for a no-answer
  assert.equal(r.lines.length, 4 + 3 * A.good.chains.length + 5 * answered + (reads.length - answered));
  for (const c of A.good.chains) assert.ok(r.lines.includes(`ok  ${c.chain}: every provider answers the same gas used for each read`), r.lines.join("\n"));
});

test("the split answer (each provider at its own latest block, the loop's gas one apart) fails on its blocks, never on a provider's gas", () => {
  const r = judge(A.split);
  assert.equal(r.verdict, "FAIL");
  // the recording holds the gap: Robinhood's loop in the call of 64 one apart, its providers at more than one block
  const rh = A.split.chains.find((c) => c.chain === "robinhood").reads.filter((x) => x.noAnswer === undefined);
  const loop = new Set(rh.map((x) => gasOf(x.sixtyFour)[0][1]));
  assert.equal(loop.size, 2, [...loop].join(", "));
  assert.equal(Math.max(...loop) - Math.min(...loop), 1);
  assert.ok(new Set(rh.map((x) => x.block)).size > 1);
  // every provider's own lines pass; the only BAD lines are each chain's blocks, and no gas comparison across blocks
  const bad = r.lines.filter((l) => l.startsWith("BAD"));
  assert.deepEqual(bad.map((l) => l.replace(/: \d+ blocks.*/, "")), ["BAD base: every provider read at one block", "BAD robinhood: every provider read at one block"], r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => l.includes("same gas used")), r.lines.join("\n"));
});

test("the bad answer (Multicall3's own code) fails: the loop and the caught out of gas answer as reverts on every provider", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "FAIL");
  const providers = A.bad.chains.reduce((n, c) => n + c.reads.filter((x) => x.noAnswer === undefined).length, 0);
  assert.equal(r.lines.filter((l) => l.startsWith("BAD")).length, 1 + 5 * providers, r.lines.join("\n"));
});

test("planted: one provider on a chain, a chain missing, a read answered 0 where 2 is due, a heavy revert answered 2, a read behind the loop answered 2, an error for an answer, no marker, a gas used wrong or differing", () => {
  const plant = (f) => {
    const a = structuredClone(A.good);
    f(a);
    return judge(a).ok;
  };
  assert.equal(plant(() => {}), true, "control");
  assert.equal(plant((a) => (a.chains[0].reads = a.chains[0].reads.slice(0, 1))), false, "one provider");
  assert.equal(plant((a) => (a.chains = a.chains.slice(0, 1))), false, "one chain");
  assert.equal(plant((a) => (a.chains[1].reads[0].six = A.bad.chains[1].reads[0].six)), false, "a 2 answered as 0");
  assert.equal(plant((a) => (a.chains[0].reads[1].sixtyFour = { error: { code: -32000, message: "out of gas" } })), false, "an error");
  // the heavy revert answered 2, as the even share of 206d625f's code answered it (the warm quote's re-reads)
  const twoFirst = (r) => {
    const h = r.slice(2);
    const e = 64 + Number(BigInt("0x" + h.slice(128, 192)));
    return "0x" + h.slice(0, 2 * e) + "2".padStart(64, "0") + h.slice(2 * e + 64);
  };
  assert.equal(plant((a) => (a.chains[0].reads[0].heavy = twoFirst(a.chains[0].reads[0].heavy))), false, "a heavy revert answered 2");
  // a read behind the loop answered 2, as a code that keeps nothing for the reads after the one it runs answers it
  const twoSecond = (r) => {
    const h = r.slice(2);
    const e = 64 + Number(BigInt("0x" + h.slice(192, 256)));
    return "0x" + h.slice(0, 2 * e) + "2".padStart(64, "0") + h.slice(2 * e + 64);
  };
  assert.equal(plant((a) => (a.chains[1].reads[2].floor = twoSecond(a.chains[1].reads[2].floor))), false, "a read behind the loop answered 2");
  // a provider that stopped applying the code override answers Multicall3's own shape, which has no marker
  assert.equal(plant((a) => (a.chains[1].reads[1].six = a.chains[1].reads[1].six.slice(0, -64))), false, "no marker");
  // card evm-quote-gas-used: the first read's gas used answered as `g` (the 14M revert's as 100,000, or one provider's
  // differing from the others by one)
  const usedFirst = (r, g) => {
    const h = r.slice(2);
    const e = 64 + Number(BigInt("0x" + h.slice(128, 192)));
    return "0x" + h.slice(0, 2 * (e + 32)) + g.toString(16).padStart(64, "0") + h.slice(2 * (e + 64));
  };
  assert.equal(plant((a) => (a.chains[0].reads[2].heavy = usedFirst(a.chains[0].reads[2].heavy, 100_000))), false, "the 14M revert answered as using 100,000");
  assert.equal(plant((a) => (a.chains[1].reads[3].sixtyFour = usedFirst(a.chains[1].reads[3].sixtyFour, 29_533_582))), false, "one provider's gas used differs");
  // at one block, one gas apart is a wrong answer (live run 42755053001's floor loop, 31,046,540 against 31,046,541):
  // every provider of a chain answers the same gas there, as the kit requires of the two it agrees on
  const loopOf = (r) => gasOf(r)[0][1];
  for (const d of [1, -1]) assert.equal(plant((a) => (a.chains[1].reads[0].floor = usedFirst(a.chains[1].reads[0].floor, loopOf(a.chains[1].reads[0].floor) + d))), false, `the loop's gas used ${d} on one provider`);
  assert.equal(plant((a) => (a.chains[0].reads[2].six = usedFirst(a.chains[0].reads[2].six, gasOf(a.chains[0].reads[2].six)[0][1] + 1))), false, "a return of 7's gas used one more on one Base provider");
  // a provider read at another block: not judged alike, a FAIL
  assert.equal(plant((a) => (a.chains[1].reads[1].block = "0x" + "11".repeat(32))), false, "one provider at another block");
  // a provider's read answered with another value (7 as 8) at the same block and gas
  const eight = (r) => {
    const h = r.slice(2);
    const e = 64 + Number(BigInt("0x" + h.slice(128, 192)));
    assert.equal(BigInt("0x" + h.slice(2 * (e + 128), 2 * (e + 160))), 7n);
    return "0x" + h.slice(0, 2 * (e + 128)) + "8".padStart(64, "0") + h.slice(2 * (e + 160));
  };
  assert.equal(plant((a) => (a.chains[1].reads[2].six = eight(a.chains[1].reads[2].six))), false, "a read's answer 7 as 8");
});

// card evm-read-gas-one-unit-apart: collect reads every provider of a chain at one block, the lowest of their latest,
// whatever block each answers as its latest; a provider whose latest block is no block is a no-answer, never the block
test("collect reads every provider of a chain at the lowest of their latest blocks", async () => {
  const real = globalThis.fetch;
  const at = new Map();
  const byHost = new Map(A.good.chains.flatMap((c) => c.reads.filter((r) => r.noAnswer === undefined).map((r) => [r.provider, r])));
  // each host's latest block its own: number 100 + its index, hash 0x<index>...
  const hosts = [...byHost.keys()];
  globalThis.fetch = async (url, init) => {
    const host = new URL(url).host;
    const { method, params } = JSON.parse(init.body);
    const k = hosts.indexOf(host);
    if (k < 0) return new Response("", { status: 200 });
    if (method === "eth_getBlockByNumber") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { hash: "0x" + String(k).padStart(64, "0"), number: "0x" + (100 + ((k * 7) % 5)).toString(16) } }), { status: 200 });
    append(at, host, params[1].blockHash);
    const r = byHost.get(host);
    const n = at.get(host).length;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [r.six, r.sixtyFour, r.heavy, r.floor][n - 1] }), { status: 200 });
  };
  try {
    const a = await collect();
    for (const c of a.chains) {
      const mine = c.reads.filter((r) => r.noAnswer === undefined);
      const ks = mine.map((r) => hosts.indexOf(r.provider));
      // the lowest number, the first in the provider order at it
      const low = ks.reduce((m, k) => ((k * 7) % 5 < (m * 7) % 5 ? k : m));
      const want = "0x" + String(low).padStart(64, "0");
      for (const r of mine) {
        assert.equal(r.block, want, `${c.chain} ${r.provider}`);
        assert.deepEqual(at.get(r.provider), [want, want, want, want], `${c.chain} ${r.provider}: every call at the one block`);
      }
      assert.ok(new Set(mine.map((r) => r.head)).size > 1, `${c.chain}: the heads differ`);
    }
    const j = judge({ ...a, code: A.good.code });
    assert.equal(j.verdict, "PASS", j.lines.join("\n"));
  } finally {
    globalThis.fetch = real;
  }
});
const append = (m, k, v) => m.set(k, [...(m.get(k) ?? []), v]);

// live run 42552050303 died on a provider's empty body ("Unexpected end of JSON input", exit 2). The run itself, its
// fetch answered from the recorded good answer by host and read (block, six, sixtyFour, heavy, floor), with a planted
// answer on the hosts named in `down`: `answer(n)` is that host's nth answer
async function run(down) {
  const byHost = new Map(A.good.chains.flatMap((c) => c.reads.map((r) => [r.provider, [{ hash: r.block, number: r.head }, r.six, r.sixtyFour, r.heavy, r.floor]])));
  const seen = new Map();
  const planted = new Map();
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const host = new URL(url).host;
    const n = seen.get(host) ?? 0;
    seen.set(host, n + 1);
    if (down[host] !== undefined) {
      const x = down[host](n);
      if (x !== undefined) {
        planted.set(host, (planted.get(host) ?? 0) + 1);
        return x;
      }
    }
    // `skipped` planted answers take no recorded answer's place, counted once they were answered
    const k = n - Math.min(down[host]?.skipped ?? 0, planted.get(host) ?? 0);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: byHost.get(host)[k] }), { status: 200 });
  };
  try {
    return { ...judge({ ...(await collect()), code: A.good.code }), seen };
  } finally {
    globalThis.fetch = real;
  }
}
const always = (res) => () => res();
const empty = () => new Response("", { status: 200 });
const html429 = () => new Response("<html><head><title>429 Too Many Requests</title></head><body>rate limited</body></html>", { status: 429, headers: { "content-type": "text/html" } });

test("planted (live run 42552050303): an empty body, an HTML 429 page, two providers of one chain down, all but one down, and a no-answer beside a wrong answer", async () => {
  const control = await run({});
  assert.equal(control.verdict, "PASS", control.lines.join("\n"));
  // an empty body every time: named with its host and HTTP status, read again once, the chain judged on the other three
  const e = await run({ "base.api.pocket.network": always(empty) });
  assert.equal(e.verdict, "PASS", e.lines.join("\n"));
  assert.ok(e.lines.includes("--- base base.api.pocket.network: no answer: base.api.pocket.network HTTP 200: empty body"), e.lines.join("\n"));
  assert.equal(e.seen.get("base.api.pocket.network"), 2, "read again once");
  // an empty body once, then the answer: read again, answered, no line
  const once = Object.assign((n) => (n === 0 ? empty() : undefined), { skipped: 1 });
  const o = await run({ "robinhood.drpc.org": once });
  assert.equal(o.verdict, "PASS", o.lines.join("\n"));
  assert.ok(!o.lines.some((l) => l.includes("robinhood.drpc.org: no answer")), o.lines.join("\n"));
  // an HTML 429 page
  const h = await run({ "rpc.mainnet.chain.robinhood.com": always(html429) });
  assert.equal(h.verdict, "PASS", h.lines.join("\n"));
  assert.ok(h.lines.some((l) => l.startsWith("--- robinhood rpc.mainnet.chain.robinhood.com: no answer: rpc.mainnet.chain.robinhood.com HTTP 429: 429 Too Many Requests")), h.lines.join("\n"));
  // a JSON-RPC rate limit with HTTP 200, as some providers answer, after the block read: a no-answer, not a wrong answer
  const limited = (n) => (n === 0 ? undefined : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit exceeded" } }), { status: 200 }));
  const l = await run({ "base-rpc.publicnode.com": limited });
  assert.equal(l.verdict, "PASS", l.lines.join("\n"));
  assert.ok(l.lines.some((x) => x.startsWith("--- base base-rpc.publicnode.com: no answer: base-rpc.publicnode.com HTTP 200: rate limit")), l.lines.join("\n"));
  // two providers of one chain down: Base has four, so two answer and the chain is judged on them; each down one named
  const two = await run({ "base.api.pocket.network": always(empty), "mainnet.base.org": always(html429) });
  assert.equal(two.verdict, "PASS", two.lines.join("\n"));
  assert.equal(two.lines.filter((x) => x.startsWith("--- base ")).length, 2, two.lines.join("\n"));
  // all but one of a chain down: INCONCLUSIVE with each named, never a pass on one provider, never a crash
  const three = await run({ "base.api.pocket.network": always(empty), "mainnet.base.org": always(html429), "base-mainnet.public.blastapi.io": always(() => new Response("upstream timeout", { status: 504 })) });
  assert.equal(three.verdict, "INCONCLUSIVE", three.lines.join("\n"));
  assert.equal(EXIT[three.verdict], 3);
  assert.ok(three.lines.includes("INCONCLUSIVE base: 1 of 4 providers answered (base-mainnet.public.blastapi.io, mainnet.base.org, base.api.pocket.network did not)"), three.lines.join("\n"));
  assert.ok(three.lines.some((x) => x.includes("base-mainnet.public.blastapi.io HTTP 504: not JSON")), three.lines.join("\n"));
  // every provider of a chain down: INCONCLUSIVE
  const none = await run(Object.fromEntries(A.good.chains[1].reads.map((r) => [r.provider, always(empty)])));
  assert.equal(none.verdict, "INCONCLUSIVE", none.lines.join("\n"));
  // a no-answer beside a wrong answer: the wrong answer fails the run
  const wrong = (n) => (n === 1 ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: A.bad.chains[0].reads[0].six }), { status: 200 }) : undefined);
  const w = await run({ "base.api.pocket.network": always(empty), "mainnet.base.org": always(html429), "base-mainnet.public.blastapi.io": always(empty), "base-rpc.publicnode.com": wrong });
  assert.equal(w.verdict, "FAIL", w.lines.join("\n"));
  // a JSON-RPC error that is not a rate limit stays an answer, judged: a provider that stops applying the override
  const refused = (n) => (n === 1 ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "state override not supported" } }), { status: 200 }) : undefined);
  const r = await run({ "robinhood-rpc.publicnode.com": refused });
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
});

// card live-checks-provider-no-answer (review of evm-quote-gas-used, P3-1 and P3-2): every kind of no-answer in the
// shared plants (an empty body, a 429, an HTTP-200 rate limit in each of the kit's wordings, drpc's code 27 state miss,
// a lagging backend's "header not found", a 403 with a state miss inside), on the block read and on a call, is named
// and left out; beside a wrong answer the run still FAILs; a 403 that carries a real JSON-RPC error is judged
test("planted: each shared no-answer kind, on the block read and on a call; beside a wrong answer; a judged 403", async () => {
  // the host's kth answer planted; `skipped`: planted answers that take no recorded answer's place
  const at = (k, res, skipped = 0) => Object.assign((n) => (n === k ? res() : undefined), { skipped });
  for (const [name, status, body] of NO_ANSWERS) {
    const res = () => new Response(body, { status });
    // the block read (answer 0) and its read again (1): the host is a no-answer, the chain judged on the other three
    const b = await run({ "mainnet.base.org": always(res) });
    assert.equal(b.verdict, "PASS", `${name}: ${b.lines.join("\n")}`);
    assert.ok(b.lines.some((l) => l.startsWith(`--- base mainnet.base.org: no answer: mainnet.base.org HTTP ${status}: `)), `${name}: ${b.lines.join("\n")}`);
    // the second call (answer 2), read again once and then answered: no line, a pass
    const c = await run({ "robinhood.drpc.org": at(2, res, 1) });
    assert.equal(c.verdict, "PASS", `${name}: ${c.lines.join("\n")}`);
    assert.ok(!c.lines.some((l) => l.includes("robinhood.drpc.org: no answer")), `${name}: ${c.lines.join("\n")}`);
    assert.equal(c.seen.get("robinhood.drpc.org"), 6, `${name}: read again once`);
    // beside a wrong answer on another provider of the chain: FAIL
    const wrong = at(1, () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: A.bad.chains[0].reads[0].six }), { status: 200 }));
    const w = await run({ "mainnet.base.org": always(res), "base-rpc.publicnode.com": wrong });
    assert.equal(w.verdict, "FAIL", `${name}: ${w.lines.join("\n")}`);
  }
  // a 403 that carries a real JSON-RPC error, on a call: judged, a FAIL
  const j = await run({ "robinhood-rpc.publicnode.com": at(1, () => new Response(JUDGED_403[1], { status: JUDGED_403[0] })) });
  assert.equal(j.verdict, "FAIL", j.lines.join("\n"));
});
