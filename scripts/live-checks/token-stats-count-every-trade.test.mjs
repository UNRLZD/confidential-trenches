// node --test scripts/live-checks/token-stats-count-every-trade.test.mjs: the check replays its recorded answers
// (token-stats-count-every-trade.answers.json, each part's source in its _about): the card's answers pass; the deployed
// helper before the card fails on each chain; a filling tape that claims a reach and a reach past its read fail; the
// read polls a filling tape until it settles, READ_MS at most. Card vendor-tapes-name-their-reach-every-chain: a Solana
// or NEAR vendor tape that claims a reach names its read's age within the chain's bound (bad_vendor, the deployed helper
// before that card, fails on Solana and NEAR alone).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, COINS, judge, POLL_MS, read, READ_MS, VENDOR, vendorReadOf } from "./token-stats-count-every-trade.mjs";

const A = JSON.parse(readFileSync(new URL("./token-stats-count-every-trade.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(":")[0]);

test("the recorded good answer: every chain's settled tapes claim a reach: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer, the deployed helper before the card: FAIL on each chain", () => {
  assert.deepEqual(bad(judge(A.bad_deployed)), CHAINS.map((c) => `BAD ${c}`));
});

test("the recorded bad answer, the deployed helper before card vendor-tapes-name-their-reach-every-chain: FAIL on Solana and NEAR alone, each vendor tape naming no read", () => {
  const r = judge(A.bad_vendor);
  assert.deepEqual([...new Set(bad(r))], ["BAD solana", "BAD near"], r.lines.join("\n"));
  assert.ok(r.lines.filter((l) => l.startsWith("BAD")).every((l) => / naming no read | ms before its request /.test(l)), r.lines.join("\n"));
});

test("planted: a vendor tape whose named read or as_of_ms is past the chain's bound fails; at the bound it passes; a chain tape is never judged by the vendor's rule", () => {
  const plant = (chain, f) => {
    const r = structuredClone(A.good);
    const x = r.chains[chain].tapes.flatMap((t) => t.reads).find((x) => x.whole_ms !== undefined && x.src !== VENDOR[chain].own);
    assert.ok(x, `the good run holds a ${chain} vendor tape with a reach`);
    f(x, VENDOR[chain]);
    return [...new Set(bad(judge(r)))];
  };
  const named = (x, v, ms) => (x.timing = x.timing.replace(/rows read \d+ ms ago/, `rows read ${ms} ms ago`));
  for (const chain of ["solana", "near"]) {
    assert.deepEqual(plant(chain, (x, v) => named(x, v, v.ms)), [], `${chain}: at the bound`);
    assert.deepEqual(plant(chain, (x, v) => named(x, v, v.ms + 1)), [`BAD ${chain}`], `${chain}: past the bound by the helper's word`);
    assert.deepEqual(plant(chain, (x) => (x.timing = "total;dur=1")), [`BAD ${chain}`], `${chain}: naming no read`);
    assert.deepEqual(plant(chain, (x, v) => (x.as_of_ms = x.at - v.ms - 2_001)), [`BAD ${chain}`], `${chain}: as_of_ms past the bound and the clocks`);
  }
  // a Solana chain tape (src chain) claims its reach by its own rule, with no vendor read: bad_vendor's two complete
  // chain tapes are not judged by the vendor's, its one vendor tape is
  const chainTapes = A.bad_vendor.chains.solana.tapes.filter((t) => t.reads.some((x) => x.src === "chain" && x.whole_ms !== undefined));
  assert.equal(chainTapes.length, 2);
  const lines = judge(A.bad_vendor).lines.filter((l) => l.startsWith("BAD solana"));
  assert.ok(lines.length > 0 && lines.every((l) => chainTapes.every((t) => !l.includes(t.coin.slice(0, 10)))), lines.join("\n"));
  // the entry is the chain's own, whole
  assert.equal(vendorReadOf("sol-vendor-read", 'a;dur=1, sol-vendor-read;desc="rows read 12 ms ago", total;dur=3'), 12);
  assert.equal(vendorReadOf("sol-vendor-read", 'x-sol-vendor-read;desc="rows read 2 ms ago"'), null);
  assert.equal(vendorReadOf("near-vendor-read", 'evm-vendor-read;desc="rows read 2 ms ago"'), null);
});

test("planted: a filling tape with a reach, a reach past its read, a non-200 answer: each fails alone", () => {
  const plant = (f) => {
    const r = structuredClone(A.good);
    f(r);
    return bad(judge(r));
  };
  assert.deepEqual(plant((r) => r.chains.base.tapes[0].reads.unshift({ status: 200, n: 0, oldest_ms: null, filling: true, whole_ms: 0, src: "chain", as_of_ms: 1 })), ["BAD base"]);
  assert.deepEqual(plant((r) => { const x = r.chains.near.tapes[0].reads.at(-1); x.whole_ms = x.as_of_ms + 120_000; }), ["BAD near"]);
  assert.deepEqual(plant((r) => (r.chains.solana.tapes[1].reads.at(-1).status = 503)), ["BAD solana"]);
});

test("read: each chain's first COINS Trending coins, a filling tape read every POLL_MS until it settles, READ_MS at most", async () => {
  let t = 0;
  let n = 0;
  const fetchFn = async (url) => {
    const u = new URL(url);
    const body =
      u.pathname === "/v1/market/lists"
        ? { lists: { trending_1h: [{ token: "a" }, { token: "b" }, { token: "c" }, { token: "d" }] } }
        : u.searchParams.get("token") === "a" && u.searchParams.get("chain") === "base" && ++n < 3
          ? { trades: [], filling: true, src: "chain", as_of_ms: 5 }
          : { trades: [{ t_ms: 3 }, { t_ms: 1 }], whole_ms: 1_001, src: "chain", as_of_ms: 5 };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const r = await read("https://h.test", fetchFn, async (ms) => void (t += ms), () => t);
  assert.deepEqual(r.chains.base.tapes.map((x) => x.coin), ["a", "b", "c"].slice(0, COINS));
  assert.equal(r.chains.base.tapes[0].reads.length, 3);
  assert.equal(t, 2 * POLL_MS);
  assert.deepEqual(r.chains.base.tapes[0].reads.at(-1), { at: 2 * POLL_MS, status: 200, timing: "", n: 2, oldest_ms: 1, filling: false, whole_ms: 1_001, src: "chain", as_of_ms: 5 });
  // never settling: READ_MS of reads
  n = -1e9;
  t = 0;
  const never = await read("https://h.test", fetchFn, async (ms) => void (t += ms), () => t);
  assert.equal(never.chains.base.tapes[0].reads.length, READ_MS / POLL_MS + 1);
});
