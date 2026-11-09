// node --test scripts/live-checks/evm-pool-sync-holds.test.mjs: card evm-pool-sync-holds's live check, replayed.
// evm-pool-sync-holds.answers.json holds a real run (good: every Base and Robinhood pool source's floor read by
// bisection, the helper's keyed-only route included) and the bad run (its `bad.note`: every Base source but the helper's
// route answering no logs from the deploy block down). Good passes, naming each source's floor and date; bad fails on
// Base with the helper alone. Planted on the good one: a source silent where two could still reach is INCONCLUSIVE, the
// helper counted once however many of its lines reach.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, check, plantedBad, replayer } from "./evm-pool-sync-holds.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-pool-sync-holds.answers.json", import.meta.url), "utf8"));
const run = (log, chains = A.good.chains) => check(replayer(log), chains);

test("the good run is a run on both pools' sources as the signing page lists them, the helper's keyed-only route one of them", () => {
  assert.deepEqual(A.good.chains, JSON.parse(JSON.stringify(CHAINS)));
  for (const c of A.good.chains) assert.ok(c.sources.some((s) => s.op === "helper" && s.url.endsWith(`/v1/rpc/${c.name}?keyed=only`)));
  assert.deepEqual(A.good.chains[0].sources.map((s) => s.url), ["https://base-rpc.publicnode.com", "https://base.api.pocket.network", "https://ct-api.unrealized.trade/v1/rpc/base?keyed=only", "https://base.rpc.blxrbdn.com"]);
});

test("the recorded good run passes: each chain two operators or more reach the deploy block 7 days out, each source's floor and date named", async () => {
  const r = await run(A.good.log);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.match(r.lines[0], /^PASS base: head \d+ at [\d.]+ blocks\/s; \d operator\(s\) reach the deploy block 7 days out \(.*helper.*\)$/);
  // every source has its line; each that answered names its floor and date (Base's Pocket gave an empty body on this
  // run, as on two of four that day: a quiet line, never judged)
  for (const c of A.good.chains) for (const s of c.sources) {
    const l = r.lines.find((x) => x.includes(` ${c.name} ${s.op} ${new URL(s.url).host}:`));
    assert.ok(l, `${c.name} ${s.op}`);
    if (!l.startsWith("quiet")) assert.match(l, /floor \d+, the deploy block \d+ leaves its window ~\d{4}-\d\d-\d\dT\d\d:\d\dZ$|does not reach the deploy block/);
  }
  for (const host of ["base-rpc.publicnode.com", "ct-api.unrealized.trade", "rpc.mainnet.chain.robinhood.com"]) assert.ok(r.lines.some((l) => l.startsWith("ok ") && l.includes(host)), host);
  assert.ok(r.lines.some((l) => /^PASS robinhood: /.test(l)));
});

test("the recorded bad run fails: only the helper reaches Base's deploy block", async () => {
  const r = await run(A.bad.log, A.bad.chains);
  assert.equal(r.verdict, "FAIL");
  assert.match(r.lines[0], /^FAIL base: .*1 operator\(s\) reach the deploy block 7 days out \(helper\)$/);
  assert.ok(r.lines.some((l) => /^PASS robinhood: /.test(l)));
});

test("the bad run is the good one planted: plantedBad builds the file's bad run", () => {
  assert.deepEqual(plantedBad({ chains: A.good.chains, log: A.good.log }), { chains: A.bad.chains, log: A.bad.log });
});

test("a source silent where it and the helper could still make two is INCONCLUSIVE, never judged", async () => {
  const base = A.good.chains[0];
  const keep = base.sources.find((s) => s.op === "publicnode.com").url;
  const helper = base.sources.find((s) => s.op === "helper").url;
  const log = A.good.log.map((e) => (e.method === "eth_getLogs" && base.sources.some((s) => s.url === e.url) && e.url !== helper ? (e.url === keep ? { url: e.url, method: e.method, params: e.params, noAnswer: "base-rpc.publicnode.com HTTP 429: 429 Too Many Requests" } : { url: e.url, method: e.method, params: e.params, result: [] }) : e));
  const r = await run(log);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.match(r.lines[0], /^INCONCLUSIVE base: /);
});

test("the helper counts once: a second keyed-only route of it adds no operator", async () => {
  const base = A.good.chains[0];
  const helper = base.sources.find((s) => s.op === "helper");
  const chains = [{ ...base, sources: [helper, { ...helper }] }];
  // the head and the rate read from the helper's route: the good run's reads of them on Base's first source
  const heads = A.good.log.filter((e) => e.url === base.sources[0].url && e.method === "eth_getBlockByNumber").map((e) => ({ ...e, url: helper.url }));
  const r = await run([...heads, ...A.good.log], chains);
  assert.equal(r.verdict, "FAIL");
  assert.match(r.lines[0], /1 operator\(s\) reach .*\(helper\)$/);
});

test("the check reads providers only through provider-answer.mjs", () => {
  const src = readFileSync(new URL("./evm-pool-sync-holds.mjs", import.meta.url), "utf8");
  assert.match(src, /from "\.\/provider-answer\.mjs"/);
  assert.doesNotMatch(src, /jsonrpc/);
});
