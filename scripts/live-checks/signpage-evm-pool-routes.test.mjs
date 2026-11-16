// node --test scripts/live-checks/signpage-evm-pool-routes.test.mjs: the live check replays its recorded runs
// (signpage-evm-pool-routes.answers.json). good: HELPER_HOST asked from SIGN_HOST's origin on the Base and Robinhood
// mainnet pools, each malformed buy and sale refused bad_shape, SIGN_HOST echoed: PASS. bad: the same asks for the EVM
// test pools, which the helper no longer carries (404 not_found): FAIL. Made from the good run: a sale let through, a
// buy refused with another code, no CORS echo, an ask missing, another pool asked: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mainnetVenues } from "./mainnet-venues.mjs";
import { HELPER, judge, poolsOf, read, ROUTES, SIGN } from "./signpage-evm-pool-routes.mjs";

const A = JSON.parse(readFileSync(new URL("./signpage-evm-pool-routes.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the check asks the mainnets' pools alone, as the kit pins them", () => {
  assert.deepEqual(Object.keys(poolsOf()), ["base", "robinhood"]);
  for (const [n, p] of Object.entries(poolsOf())) assert.equal(p, mainnetVenues()[n].pool.toLowerCase());
});

test("recorded good run (HELPER_HOST, the mainnet pools): every malformed buy and sale refused bad_shape, SIGN_HOST echoed: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.length, 2 * ROUTES.length * 3);
});

test("recorded bad run (the test pools the helper no longer carries): 404 not_found on every ask: FAIL", () => {
  const r = judge(A.bad, A.bad.pools);
  assert.equal(r.verdict, "FAIL");
  assert.equal(bad(r).length, 4, bad(r).join("\n"));
  assert.ok(bad(r).every((l) => / 404 not_found$/.test(l)), bad(r).join("\n"));
});

test("made from the good run: a sale let through, another code, no CORS echo, an ask missing, another pool: each FAIL", () => {
  const edit = (i, f) => ({ ...A.good, asks: A.good.asks.map((a, k) => (k === i ? f({ ...a }) : a)) });
  const sell = A.good.asks.findIndex((a) => a.route === "sell");
  assert.equal(judge(edit(sell, (a) => ((a.status = 200), (a.body = '{"tx":"0x1"}'), a))).ok, false, "a sale let through");
  assert.equal(judge(edit(0, (a) => ((a.body = '{"error":{"code":"bad_signature"}}'), a))).ok, false, "another code");
  assert.equal(judge(edit(0, (a) => ((a.acao = null), a))).ok, false, "no CORS echo");
  assert.equal(judge({ ...A.good, asks: A.good.asks.slice(1) }).ok, false, "an ask missing");
  assert.equal(judge(edit(0, (a) => ((a.pool = "0x0000000000000000000000000000000000000001"), a))).ok, false, "another pool");
});

test("read() posts each route once per pool from SIGN_HOST's origin, with no signature in any body", async () => {
  const asked = [];
  const fetchFn = async (url, init) => {
    asked.push([url, init.method, init.headers.origin, JSON.parse(init.body)]);
    return new Response('{"error":{"code":"bad_shape"}}', { status: 400, headers: { "access-control-allow-origin": SIGN } });
  };
  const run = await read(HELPER, fetchFn);
  assert.equal(judge(run).verdict, "PASS");
  assert.deepEqual(asked.map((a) => a[0].slice(HELPER.length)), ["/v1/pool/evm/send", "/v1/pool/evm/sell", "/v1/pool/evm/send", "/v1/pool/evm/sell"]);
  assert.ok(asked.every((a) => a[1] === "POST" && a[2] === SIGN && !("signature" in a[3]) && !("authorization" in a[3])));
});
