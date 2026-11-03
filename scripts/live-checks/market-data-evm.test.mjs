// node --test scripts/live-checks/market-data-evm.test.mjs: the live check replays recorded answers
// (market-data-evm.answers.json). good: apps/helper at d8f408e run on a Mac against the real GeckoTerminal and Base
// providers, with every RPC answer the maker re-read got: PASS. bad_not_deployed: the deployed helper before this card,
// 404: FAIL. Made from the good answer: a tagged row's pad swapped for another table pad (wrong tag), an untagged row from
// no listed factory given a tag, a row missing a frozen field, a pad no table row has: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROW_FIELDS } from "../../apps/terminal/src/screens/discover/fields.ts";
import { FIELDS, judge, read, rereadMakers, sample } from "./market-data-evm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "market-data-evm.answers.json"), "utf8"));

// a fetch that answers the helper's recorded answer and each RPC request with its recorded answer; an RPC request not
// recorded fails the test, so the check can only ask what it asked when recorded
const replay = (a) => async (url, init) => {
  if (url.startsWith("https://api.confidential.unrealized.trade")) {
    assert.equal(url, "https://api.confidential.unrealized.trade/v1/market/lists?chain=base");
    assert.equal(init.headers.origin, "https://confidential.unrealized.trade");
    return new Response(a.answer.body, { status: a.answer.status, headers: a.answer.headers });
  }
  const hit = a.rpc.find((r) => r.url === url && JSON.stringify(r.request) === init.body);
  assert.ok(hit, `unrecorded RPC request to ${url}`);
  return new Response(JSON.stringify(hit.answer), { status: hit.status, headers: { "content-type": "application/json" } });
};
const run = async (a) => {
  const r = await read("base", undefined, replay(a));
  r.readAt = a.answer.readAt; // the recorded read's own time, for the freshness windows
  let lists = {};
  try {
    lists = JSON.parse(r.body)?.lists ?? {};
  } catch {
    lists = {};
  }
  const makers = await rereadMakers("base", sample(lists), replay(a), [], Date.parse(a.answer.readAt));
  return judge("base", r, makers);
};
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (fn) => {
  const s = JSON.parse(A.good.answer.body);
  fn(s);
  return { ...A.good, answer: { ...A.good.answer, body: JSON.stringify(s) } };
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
