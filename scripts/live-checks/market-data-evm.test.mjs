// node --test scripts/live-checks/market-data-evm.test.mjs: the live check replays recorded answers
// (market-data-evm.answers.json). good: apps/helper on card/market-data-evm-lists-fold (15:09Z) run on a Mac against the
// real GeckoTerminal and Base providers, with every RPC answer the maker re-read got: PASS. bad_not_deployed: the deployed helper before this card,
// 404: FAIL. Made from the good answer: a tagged row's pad swapped for another table pad (wrong tag), an untagged row from
// no listed factory given a tag, a row missing a frozen field, a pad no table row has: each FAIL. good_robinhood: the
// helper's Robinhood lists on card/pad-torch-robinhood (19:33Z, TorchFactory in the table; TORCH re-read as torch): PASS; a
// wrong tag (TORCH tagged pons among them) and a Base pad on a Robinhood row: FAIL. A tagged row served
// untagged and not named unsettled (the deployed a0f19f5's Paper): FAIL; `unsettled` missing, naming a tagged token or
// over half the tokens: FAIL.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROW_FIELDS } from "../../apps/terminal/src/screens/discover/fields.ts";
import { FIELDS, judge, read, rereadMakers, sample } from "./market-data-evm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "market-data-evm.answers.json"), "utf8"));

// a fetch that answers the helper's recorded answer and each RPC request with its recorded answer; an RPC request not
// recorded fails the test, so the check can only ask what it asked when recorded. Block reads are answered per block from
// any recorded read of it (a block's number and time never change), "latest" in the order recorded (Robinhood's head
// moved between the reads)
const blockReads = (a) => {
  const byNumber = new Map();
  const latest = [];
  for (const r of a.rpc) {
    if (r.request === undefined) continue; // recorded by its sha256: not a block read
    const reqs = Array.isArray(r.request) ? r.request : [r.request];
    const ans = Array.isArray(r.answer) ? r.answer : [r.answer];
    for (const q of reqs) {
      if (q?.method !== "eth_getBlockByNumber") continue;
      const got = ans.find((x) => x?.id === q.id)?.result;
      if (got?.number === undefined) continue;
      if (q.params[0] === "latest") latest.push(got);
      else byNumber.set(q.params[0], got);
    }
  }
  return { byNumber, latest };
};
const replay = (a, chain = "base") => {
  const used = new Set();
  const blocks = blockReads(a);
  let head = 0;
  return async (url, init) => {
  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  if (Array.isArray(body) && body.length > 0 && body.every((q) => q.method === "eth_getBlockByNumber")) {
    const out = body.map((q) => {
      const got = q.params[0] === "latest" ? blocks.latest[Math.min(head++, blocks.latest.length - 1)] : blocks.byNumber.get(q.params[0]);
      assert.ok(got, `unrecorded block ${q.params[0]}`);
      return { jsonrpc: "2.0", id: q.id, result: got };
    });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.startsWith("https://ct-api.unrealized.trade")) {
    assert.equal(url, `https://ct-api.unrealized.trade/v1/market/lists?chain=${chain}`);
    assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
    return new Response(a.answer.body, { status: a.answer.status, headers: a.answer.headers });
  }
  const sha = createHash("sha256").update(init.body).digest("hex");
  const same = (r) => r.url === url && (r.request === undefined ? r.request_sha256 === sha : JSON.stringify(r.request) === init.body);
  const i = a.rpc.findIndex((r, k) => !used.has(k) && same(r));
  const hit = i >= 0 ? (used.add(i), a.rpc[i]) : a.rpc.findLast(same);
  assert.ok(hit, `unrecorded RPC request to ${url}`);
  return new Response(JSON.stringify(hit.answer), { status: hit.status, headers: { "content-type": "application/json" } });
  };
};
const run = async (a, chain = "base") => {
  const r = await read(chain, undefined, replay(a, chain));
  r.readAt = a.answer.readAt; // the recorded read's own time, for the freshness windows
  let body = {};
  try {
    body = JSON.parse(r.body) ?? {};
  } catch {
    body = {};
  }
  const makers = await rereadMakers(chain, sample(body.lists ?? {}, body.unsettled), replay(a, chain), [], Date.parse(a.answer.readAt));
  return judge(chain, r, makers);
};
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (fn, g = A.good) => {
  const s = JSON.parse(g.answer.body);
  fn(s);
  return { ...g, answer: { ...g.answer, body: JSON.stringify(s) } };
};
const rows = (s) => ["new", "trending_5m", "trending_1h", "trending"].flatMap((k) => s.lists[k]);
const each = (s, token, fn) => rows(s).filter((r) => r.token === token).forEach(fn);

test("the frozen list is the terminal's ROW_FIELDS", () => assert.deepEqual(FIELDS, [...ROW_FIELDS]));

test("good: the local helper's Base lists and their makers re-read on chain: PASS", async () => {
  const r = await run(A.good);
  assert.deepEqual(bad(r), []);
  assert.equal(r.ok, true);
  assert.ok(r.lines.filter((l) => /tagged "[a-z]+", the creation events/.test(l)).length >= 2, "tagged rows re-read");
  assert.ok(r.lines.some((l) => /tagged null, the creation events read on chain \(two providers that agree\) name null/.test(l)), "an untagged row re-read as none");
});

test("bad_not_deployed: the deployed helper before this card answers 404: FAIL", async () => {
  const r = await run(A.bad_not_deployed);
  assert.equal(r.ok, false);
  assert.match(bad(r)[0], /answers 404/);
});

test("a wrong tag: a tagged row's pad swapped for another table pad: FAIL", async () => {
  const s0 = JSON.parse(A.good.answer.body);
  const t = sample(s0.lists).find((r) => typeof r.launchpad === "string");
  const other = t.launchpad === "zora" ? "clanker" : "zora";
  const r = await run(edit((s) => each(s, t.token, (x) => (x.launchpad = other))));
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes(t.token) && l.includes(`tagged "${other}"`)), bad(r).join("\n"));
});

test("a tag on a token no listed factory made: FAIL", async () => {
  const s0 = JSON.parse(A.good.answer.body);
  const u = sample(s0.lists).find((r) => r.launchpad === null);
  const r = await run(edit((s) => each(s, u.token, (x) => (x.launchpad = "zora"))));
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes(u.token) && l.includes("name null")), bad(r).join("\n"));
});

test("a missing field, a pad no table row has, a stale read: each FAIL", async () => {
  const missing = await run(edit((s) => delete s.lists.new[0].launchpad));
  assert.equal(missing.ok, false);
  assert.ok(bad(missing).some((l) => l.includes("missing launchpad")));
  const unknown = await run(edit((s) => (s.lists.new[0].launchpad = "pump.fun")));
  assert.equal(unknown.ok, false);
  assert.ok(bad(unknown).some((l) => l.includes("not a table pad")));
  const stale = await run({ ...A.good, answer: { ...A.good.answer, readAt: new Date(Date.parse(A.good.answer.readAt) + 11 * 60_000).toISOString() } });
  assert.equal(stale.ok, false);
});

test("good_robinhood: the local helper's Robinhood lists and their makers re-read on chain: PASS; a wrong tag and a Base pad on a Robinhood row: FAIL", async () => {
  const g = A.good_robinhood;
  const r = await run(g, "robinhood");
  assert.deepEqual(bad(r), []);
  assert.equal(r.ok, true);
  assert.ok(r.lines.filter((l) => /tagged "[a-z]+", the creation events/.test(l)).length >= 2, "tagged rows re-read");
  const s0 = JSON.parse(g.answer.body);
  const t = sample(s0.lists).find((x) => typeof x.launchpad === "string");
  const other = t.launchpad === "pons" ? "clanker" : "pons";
  const wrong = await run(edit((s) => each(s, t.token, (x) => (x.launchpad = other)), g), "robinhood");
  assert.equal(wrong.ok, false);
  assert.ok(bad(wrong).some((l) => l.includes(t.token) && l.includes(`tagged "${other}"`)), bad(wrong).join("\n"));
  // a tag on an untagged row moves it into the tagged sample, which reorders the re-reads; Robinhood's block search
  // depends on the head each read saw, so that case is replayed on Base above (the judge is the same for both chains)
  const zora = await run(edit((s) => (s.lists.new[0].launchpad = "zora"), g), "robinhood");
  assert.equal(zora.ok, false, "a Base pad on a Robinhood row");
  const TORCH = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed1111";
  assert.ok(r.lines.some((l) => l.includes(TORCH) && /tagged "torch", the creation events read on chain \(two providers that agree\) name "torch"/.test(l)), "TORCH re-read as torch");
  const asPons = await run(edit((s) => each(s, TORCH, (x) => (x.launchpad = "pons")), g), "robinhood");
  assert.equal(asPons.ok, false);
  assert.ok(bad(asPons).some((l) => l.includes(TORCH) && l.includes('tagged "pons"') && l.includes('name "torch"')), bad(asPons).join("\n"));
});

test("unsettled: a tagged row served untagged and not named unsettled (Paper's shape at a0f19f5, null where the chain names clanker): FAIL; the same row named unsettled is said, not failed; no unsettled list, a tagged token in it, or over half the tokens in it: FAIL", async () => {
  const s0 = JSON.parse(A.good.answer.body);
  const t = sample(s0.lists, s0.unsettled).find((r) => typeof r.launchpad === "string");
  const dropped = await run(edit((s) => each(s, t.token, (x) => (x.launchpad = null))));
  assert.equal(dropped.ok, false);
  assert.ok(bad(dropped).some((l) => l.includes(t.token) && l.includes("tagged null") && l.includes(`name "${t.launchpad}"`)), bad(dropped).join("\n"));
  const named = await run(edit((s) => (each(s, t.token, (x) => (x.launchpad = null)), s.unsettled.push(t.token))));
  assert.ok(!bad(named).some((l) => l.includes(t.token)), "a row named unsettled is not compared");
  const none = await run(edit((s) => delete s.unsettled));
  assert.equal(none.ok, false);
  assert.ok(bad(none).some((l) => l.startsWith("BAD unsettled")));
  const taggedIn = await run(edit((s) => s.unsettled.push(t.token)));
  assert.ok(bad(taggedIn).some((l) => l.startsWith("BAD unsettled")), "a tagged token named unsettled");
  const most = await run(edit((s) => (s.unsettled = [...new Set(["new", "trending_5m", "trending_1h"].flatMap((k) => s.lists[k].map((r) => (r.launchpad = null, r.token))))].filter((x, i, a) => a.indexOf(x) === i), s.lists.trending = s.lists.trending_1h)));
  assert.ok(bad(most).some((l) => l.startsWith("BAD unsettled")), "every token unsettled");
});
