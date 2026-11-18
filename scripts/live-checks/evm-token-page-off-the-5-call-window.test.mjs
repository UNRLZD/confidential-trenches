// node --test scripts/live-checks/evm-token-page-off-the-5-call-window.test.mjs: the live check replays recorded answers
// (evm-token-page-off-the-5-call-window.answers.json). bad_deployed: the deployed helper at ff65a04030cd (main before
// this card), 18 Nov 09:54Z, 5 listed tokens a chain read at once: 3 of 10 holders counts, each from GeckoTerminal's
// keyless window, the rest src none: FAIL. good: made from it, each count CoinGecko's keyed info as the card answers
// it: PASS (no run of the card is deployed to record yet). Made from the good answer: a holders 429, a page 503, a
// holders src "geckoterminal", a page risk.holders src "geckoterminal", and a chain with no CoinGecko count: each FAIL;
// a chain with one CoinGecko count and the rest src none: PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP, BASE, CHAINS, judge, picks, read, READS } from "./evm-token-page-off-the-5-call-window.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "evm-token-page-off-the-5-call-window.answers.json"), "utf8"));

// a fetch that answers with the recorded answers, after checking the check asked the right thing
const replay = (rec) => async (url, init) => {
  assert.equal(init.headers.origin, APP);
  for (const chain of CHAINS) {
    const c = rec.chains[chain];
    if (url === `${BASE}${READS.lists(chain)}`) return new Response(c.lists.body, { status: c.lists.status });
    for (const [t, r] of Object.entries(c.tokens))
      for (const k of ["token", "holders"]) if (url === `${BASE}${READS[k](chain, t)}`) return new Response(r[k].body, { status: r[k].status });
  }
  assert.fail(`unexpected ${url}`);
};
const run = async (rec) => judge(await read(undefined, replay(rec)));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
/** The good run with each chosen read edited: fn(chain, token, kind, read). */
const edit = (fn) => {
  const rec = structuredClone(A.good.run);
  for (const chain of CHAINS) for (const [t, r] of Object.entries(rec.chains[chain].tokens)) for (const k of ["token", "holders"]) fn(chain, t, k, r[k]);
  return rec;
};
const body = (r, f) => {
  const b = JSON.parse(r.body);
  f(b);
  r.body = JSON.stringify(b);
};

test("the recorded runs read 5 listed tokens a chain", () => {
  for (const k of ["good", "bad_deployed"]) for (const chain of CHAINS) assert.equal(picks(JSON.parse(A[k].run.chains[chain].lists.body)).length, 5, `${k} ${chain}`);
});

test("good: every page and holders 200, counts from CoinGecko's keyed info: PASS", async () => {
  const r = await run(A.good.run);
  assert.deepEqual(bad(r), []);
  assert.equal(r.ok, true);
});

test("bad_deployed: the deployed helper before the card, counts from GeckoTerminal's keyless window or none: FAIL", async () => {
  const r = await run(A.bad_deployed.run);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /holders src "geckoterminal"/.test(l)));
  assert.ok(bad(r).some((l) => /base: 0 of 5 holders answers carry a count/.test(l)));
});

test("a holders 429, a page 503, a GeckoTerminal src on holders or on the page: each FAIL", async () => {
  const first = (chain) => Object.keys(A.good.run.chains[chain].tokens)[0];
  const cases = [
    [(c, t, k, r) => c === "base" && t === first("base") && k === "holders" && Object.assign(r, { status: 429, body: '{"error":{"code":"rate_limited"}}' }), /holders 429/],
    [(c, t, k, r) => c === "robinhood" && t === first("robinhood") && k === "token" && Object.assign(r, { status: 503, body: '{"error":{"code":"upstream"}}' }), /page 503/],
    [(c, t, k, r) => c === "base" && k === "holders" && body(r, (b) => (b.src = "geckoterminal")), /holders src "geckoterminal"/],
    [(c, t, k, r) => c === "robinhood" && k === "token" && body(r, (b) => (b.risk.holders.src = "geckoterminal")), /risk\.holders src "geckoterminal"/],
  ];
  for (const [fn, re] of cases) {
    const r = await run(edit(fn));
    assert.equal(r.ok, false, String(re));
    assert.ok(bad(r).some((l) => re.test(l)), `${re}: ${bad(r).join(" | ")}`);
  }
});

test("a chain with no CoinGecko count FAILs; one count and the rest src none PASSes", async () => {
  const none = (b) => Object.assign(b, { total: null, top_bps: null, src: "none" });
  const all = await run(edit((c, t, k, r) => c === "robinhood" && k === "holders" && body(r, none)));
  assert.equal(all.ok, false);
  assert.ok(bad(all).some((l) => /robinhood: 0 of 5 holders answers carry a count/.test(l)));
  const keep = Object.keys(A.good.run.chains.robinhood.tokens)[2];
  const one = await run(edit((c, t, k, r) => c === "robinhood" && k === "holders" && t !== keep && body(r, none)));
  assert.deepEqual(bad(one), []);
});
