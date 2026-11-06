// node --test scripts/live-checks/helper-page-jup-429.test.mjs: the check replays its recorded answers
// (helper-page-jup-429.answers.json, each part's source in its _about): a build with its waits named and a cold page
// named within 1 s, its Jupiter row held for a re-read within one window, passes, with Jupiter's window full (named on
// chain) and with room (Jupiter's row in time); a page named on chain past 1 s, the deployed helper before the card (a
// build with no Server-Timing), live run 42143211092's bare 503, live run 42137763380's page a Jupiter 429 held 4 s and
// a page whose search Jupiter held each fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CAUSES, judge, read, REREAD_MS } from "./helper-page-jup-429.mjs";

const A = JSON.parse(readFileSync(new URL("./helper-page-jup-429.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answers: Jupiter's window full, the page named on chain in 804 ms and its row held at +6 s; with room, Jupiter's row in 633 ms: PASS", () => {
  for (const k of ["good", "good_jupiter"]) {
    const r = judge(A[k]);
    assert.equal(r.ok, true, `${k}\n${r.lines.join("\n")}`);
    assert.equal(r.lines.length, k === "good" ? 4 : 5, r.lines.join("\n"));
  }
  assert.match(judge(A.good).lines[1], /named "ASV" \(row src chain\)/);
  assert.match(judge(A.good_jupiter).lines[2], /named "RRCx" \(row src jupiter\)/);
});

test("the recorded bad answers: a page named on chain in 1292 ms, no Server-Timing on the build, a bare 503, a page a Jupiter 429 held 4 s, a page whose search Jupiter held: FAIL", () => {
  assert.deepEqual(bad(judge(A.bad_chain_slow)).map((l) => l.slice(0, 44)), ["BAD the page's helper time 1292 ms (at most "]);
  assert.ok(bad(judge(A.bad_deployed)).includes("BAD Server-Timing names the call's turn and send: none"));
  assert.deepEqual(bad(judge(A.bad_bare_503)), ["BAD a 503 names its cause in Server-Timing: none (a bare 503)"]);
  const slow = bad(judge(A.bad_page_429));
  assert.ok(slow.some((l) => /^BAD the page's helper time 4073 ms/.test(l)), slow.join("\n"));
  const held = bad(judge(A.bad_page_held));
  assert.ok(held.some((l) => /answered 503 named by nothing/.test(l)), held.join("\n"));
  assert.ok(held.some((l) => /^BAD no re-read within/.test(l)), held.join("\n"));
});

test("planted: a 503 naming each cause passes; an unknown cause, a cause only inside another entry's desc, or our 429 fails; a page with no symbol, an empty one, another row source, no re-read, a re-read past one window or holding a row read before the send fails", () => {
  for (const c of CAUSES) assert.equal(judge({ ...A.bad_bare_503, timing: `budget;dur=0, turn;dur=3001, cause;desc="${c}"`, retryAfter: "4" }).ok, true, c);
  assert.equal(judge({ ...A.bad_bare_503, timing: 'cause;desc="other"' }).ok, false);
  assert.equal(judge({ ...A.bad_bare_503, timing: 'send;desc="x cause;desc=429"' }).ok, false);
  assert.equal(judge({ ...A.good_jupiter, status: 429, timing: null }).ok, false);
  const waited = judge({ ...A.good_jupiter, timing: 'budget;dur=0, turn;dur=1003, 429;desc="1", send;dur=240' });
  assert.equal(waited.ok, true);
  assert.match(waited.lines[1], /\(1 Jupiter 429 waited out\)$/);
  const pg = A.good.page;
  const page = (p) => judge({ ...A.good, page: { ...pg, ...p } }).ok;
  assert.equal(page({}), true);
  assert.equal(page({ symbol: null }), false, "no symbol");
  assert.equal(page({ symbol: "  " }), false, "an empty symbol");
  assert.equal(page({ rowSrc: "cache" }), false, "a row from another source");
  assert.equal(page({ status: 503 }), false, "not 200");
  assert.equal(page({ timing: null }), false, "a page with no Server-Timing");
  assert.equal(page({ rereads: [] }), false, "no re-read");
  const hit = pg.rereads.at(-1);
  assert.equal(page({ rereads: [{ ...hit, at: pg.sentAt + REREAD_MS + 2_000 }] }), false, "a re-read past one window");
  assert.equal(page({ rereads: [{ ...hit, jupAt: pg.sentAt - 60_000 }] }), false, "a row read a minute before the send");
  assert.equal(page({ rereads: [{ ...hit, src: "none" }] }), false, "a re-read still without the row");
  assert.equal(judge({ ...A.good, page: { mint: null, listsStatus: 503, poolSize: 0 } }).ok, false, "no cold page to read");
});

test("read() asks the build as the kit does, by POST to the proxy path, then one page of a token off the lists", async () => {
  const asked = [];
  const answer = (url, init) => {
    asked.push({ url, init });
    if (url.endsWith("/v1/market/lists?chain=solana")) return new Response(JSON.stringify({ lists: { new: [{ token: "So11111111111111111111111111111111111111112" }] } }));
    if (url.startsWith("https://lite-api.jup.ag/")) return new Response(JSON.stringify([{ id: "So11111111111111111111111111111111111111112" }, { id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }]));
    if (url.includes("/v1/market/token")) return new Response(JSON.stringify({ row: { symbol: "USDC", src: "chain" }, risk: { holders: { src: "jupiter", as_of_ms: Date.now() } } }), { headers: { "server-timing": "total;dur=40" } });
    return new Response('{"ok":1}', { status: 503, headers: { "server-timing": 'cause;desc="5xx"', "retry-after": "2" } });
  };
  const r = await read("https://helper.invalid", async (url, init) => answer(url, init));
  const u = new URL(asked[0].url);
  assert.equal(asked[0].init.method, "POST");
  assert.equal(u.pathname, "/v1/proxy/jupiter/swap/v2/build");
  assert.equal(u.searchParams.get("maxAccounts"), "40");
  assert.deepEqual([r.status, r.timing, r.retryAfter], [503, 'cause;desc="5xx"', "2"]);
  assert.equal(r.page.mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "the listed token is left out");
  assert.deepEqual([r.page.status, r.page.src, r.page.timing, r.page.symbol, r.page.rowSrc], [200, "jupiter", "total;dur=40", "USDC", "chain"]);
  assert.equal(r.page.rereads.length, 1, "one re-read: it held the row");
  assert.equal(asked.filter((a) => a.url.includes("/v1/market/token")).length, 2);
});
