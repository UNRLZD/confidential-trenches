// node --test scripts/live-checks/market-data-evm-token.test.mjs: the live check replays recorded answers
// (market-data-evm-token.answers.json). good and good_cold: apps/helper at card/market-data-evm-token run on a Mac
// against the real GeckoTerminal, each chain's lists the deployed helper's: PASS. bad_not_deployed: the deployed helper
// before this card, 404 on the token and holders of both chains: FAIL. bad_holders_429: the deployed helper at ed0f714a
// (14:54Z), base's holders 429 behind the GeckoTerminal budget (card evm-holders-never-starve): FAIL. Made from the good answer: a page missing a
// field, a row with an extra field, the other chain's tag, a launchpad other than the lists', a Risk field not a Field,
// holders missing `top_bps`, an unlisted address answered 200, a stale read and no CORS echo: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROW_FIELDS as TERMINAL_FIELDS } from "../../apps/terminal/src/screens/discover/fields.ts";
import { HOLDERS_FIELDS, PAGE_FIELDS, RISK_FIELDS } from "../../apps/helper/src/data/solana/token.ts";
import { CHAINS, HOLDERS, judge, PAGE, pick, read, READS, RISK, ROW, UNLISTED } from "./market-data-evm-token.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "market-data-evm-token.answers.json"), "utf8"));
const BASE = "https://ct-api.unrealized.trade";

// a fetch that answers with the recorded answers, after checking the check asked the right thing
const replay = (rec) => async (url, init) => {
  assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
  for (const chain of CHAINS) {
    const c = rec.chains[chain];
    const row = pick(JSON.parse(c.lists.body));
    for (const [k, p] of [["lists", READS.lists(chain)], ["token", READS.token(chain, row.token)], ["holders", READS.holders(chain, row.token)], ["unlisted", READS.token(chain, UNLISTED)]])
      if (url === `${BASE}${p}`) return new Response(c[k].body, { status: c[k].status, headers: c[k].headers });
  }
  assert.fail(`unexpected ${url}`);
};
const run = async (rec) => {
  const r = await read(undefined, replay(rec));
  // each read judged at its recorded time
  r.readAt = rec.readAt;
  for (const chain of CHAINS) for (const k of Object.keys(r.chains[chain])) r.chains[chain][k].at = rec.chains[chain][k].at;
  return judge(r);
};
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
/** The good run with one chain's read body or headers edited. */
const edit = (chain, k, fn, headers, status) => {
  const rec = structuredClone(A.good.run);
  const c = rec.chains[chain][k];
  if (fn) {
    const b = JSON.parse(c.body);
    fn(b);
    c.body = JSON.stringify(b);
  }
  if (headers) Object.assign(c.headers, headers);
  if (status !== undefined) c.status = status;
  return rec;
};

test("the pinned lists are the helper's own and the terminal's Row", () => {
  assert.deepEqual(ROW, [...TERMINAL_FIELDS]);
  assert.deepEqual(PAGE, [...PAGE_FIELDS]);
  assert.deepEqual(RISK, [...RISK_FIELDS]);
  assert.deepEqual(HOLDERS, [...HOLDERS_FIELDS]);
});

test("good: the recorded runs PASS, a launchpad-tagged token read on each chain", async () => {
  for (const k of ["good", "good_cold"]) {
    const r = await run(A[k].run);
    assert.deepEqual(bad(r), [], k);
    assert.equal(r.ok, true, k);
  }
  for (const chain of CHAINS) assert.equal(typeof pick(JSON.parse(A.good.run.chains[chain].lists.body)).launchpad, "string", chain);
});

test("bad_not_deployed: the deployed helper before this card (404 on both reads) FAILs", async () => {
  const r = await run(A.bad_not_deployed.run);
  assert.equal(r.ok, false);
  for (const chain of CHAINS) {
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${chain}: GET /v1/market/token`) && l.endsWith("answers 404")), chain);
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${chain}: GET /v1/market/holders`) && l.endsWith("answers 404")), chain);
  }
});

// card evm-holders-never-starve: the deployed helper at ed0f714a, 14:54Z, answered base's holders 429 rate_limited
test("bad_holders_429: a holders read the budget refused (429) FAILs, naming it", async () => {
  const r = await run(A.bad_holders_429.run);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.startsWith("BAD base: GET /v1/market/holders") && l.endsWith("answers 429")), bad(r).join("\n"));
});

test("made from the good answer: each fault FAILs, naming it", async () => {
  const cases = [
    [edit("base", "token", (b) => delete b.decimals), /base token: .*page: missing decimals/],
    [edit("robinhood", "token", (b) => delete b.filling), /robinhood token: .*page: missing filling/],
    [edit("base", "token", (b) => (b.row.extra = 1)), /base token: .*row: extra extra/],
    [edit("base", "token", (b) => delete b.row.launchpad), /base token: .*row: missing launchpad/],
    [edit("robinhood", "token", (b) => (b.row.chain = "base")), /robinhood token: .*row.chain "base"/],
    [edit("robinhood", "token", (b) => (b.row.launchpad = b.row.launchpad === "pons" ? "doppler" : "pons")), /robinhood token: .*row.launchpad/],
    [edit("base", "token", (b) => (b.row.launchpad = null)), /base token: .*row.launchpad null/],
    [edit("base", "token", (b) => (b.risk.holders = 5)), /base token: .*risk.holders 5/],
    [edit("base", "token", (b) => delete b.risk.honeypot), /base token: .*risk: missing honeypot/],
    [edit("base", "token", (b) => (b.decimals = 99)), /base token: .*decimals 99/],
    [edit("base", "holders", (b) => delete b.top_bps), /base holders: .*missing top_bps/],
    [edit("robinhood", "holders", (b) => (b.holders = [{ addr: "x", amt: "1.5", bps: 1 }])), /robinhood holders: .*holder row/],
    [edit("base", "unlisted", undefined, undefined, 200), /BAD base: GET .*dead \(no list holds it\) answers 200/],
    [edit("base", "token", undefined, { "x-fetched-at": "2026-11-09T01:00:00.000Z" }), /BAD base token X-Fetched-At/],
    [edit("robinhood", "holders", undefined, { "access-control-allow-origin": "*" }), /BAD robinhood holders Access-Control-Allow-Origin/],
    [edit("base", "token", undefined, undefined, 404), /BAD base: GET \/v1\/market\/token.* answers 404/],
  ];
  for (const [rec, want] of cases) {
    const r = await run(rec);
    assert.equal(r.ok, false, String(want));
    assert.ok(bad(r).some((l) => want.test(l)), `${want}: ${bad(r).join(" | ")}`);
  }
});
