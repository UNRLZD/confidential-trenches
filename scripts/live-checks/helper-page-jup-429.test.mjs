// node --test scripts/live-checks/helper-page-jup-429.test.mjs: the check replays its recorded answers
// (helper-page-jup-429.answers.json, each part's source in its _about): a build with its waits named and a cold page
// with its Jupiter row in time and no Jupiter 429 passes; the deployed helper before the card (a build with no
// Server-Timing), live run 42143211092's bare 503, live run 42137763380's page held by a Jupiter 429 and a page whose
// search Jupiter held each fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CAUSES, judge, read } from "./helper-page-jup-429.mjs";

const A = JSON.parse(readFileSync(new URL("./helper-page-jup-429.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer (a build with its waits named, a cold page with its Jupiter row in 55 ms and no 429): PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 5);
});

test("the recorded bad answers: no Server-Timing on the build, a bare 503, a page a Jupiter 429 held 4 s, a page whose search Jupiter held: FAIL", () => {
  assert.deepEqual(bad(judge(A.bad_deployed)), ["BAD Server-Timing names the call's turn and send: none"]);
  assert.deepEqual(bad(judge(A.bad_bare_503)), ["BAD a 503 names its cause in Server-Timing: none (a bare 503)"]);
  const slow = bad(judge(A.bad_page_429));
  assert.equal(slow.length, 2, slow.join("\n"));
  assert.match(slow[0], /^BAD the page's helper time 4073 ms/);
  assert.match(slow[1], /^BAD no Jupiter 429 on the page's way: Server-Timing .*jup-429;desc="1"/);
  const held = bad(judge(A.bad_page_held));
  assert.ok(held.some((l) => /answered 503 with its Jupiter row not read for it/.test(l)), held.join("\n"));
  assert.ok(held.some((l) => /^BAD no Jupiter 429 on the page's way: Server-Timing search-held/.test(l)), held.join("\n"));
});

test("planted: a 503 naming each cause passes; an unknown cause, a cause only inside another entry's desc, or our 429 fails; a page served from what was held is not cold", () => {
  for (const c of CAUSES) assert.equal(judge({ ...A.bad_bare_503, timing: `budget;dur=0, turn;dur=3001, cause;desc="${c}"`, retryAfter: "4" }).ok, true, c);
  assert.equal(judge({ ...A.bad_bare_503, timing: 'cause;desc="other"' }).ok, false);
  assert.equal(judge({ ...A.bad_bare_503, timing: 'send;desc="x cause;desc=429"' }).ok, false);
  assert.equal(judge({ ...A.good, status: 429, timing: null }).ok, false);
  const waited = judge({ ...A.good, timing: 'budget;dur=0, turn;dur=1003, 429;desc="1", send;dur=240' });
  assert.equal(waited.ok, true);
  assert.match(waited.lines[1], /\(1 Jupiter 429 waited out\)$/);
  assert.equal(judge({ ...A.good, page: { ...A.good.page, jupAt: A.good.page.sentAt - 60_000 } }).ok, false, "a row read a minute before the send");
  assert.equal(judge({ ...A.good, page: { ...A.good.page, timing: null } }).ok, false, "a page with no Server-Timing");
  assert.equal(judge({ ...A.good, page: { mint: null, listsStatus: 503, poolSize: 0 } }).ok, false, "no cold page to read");
});

test("read() asks the build as the kit does, by POST to the proxy path, then one page of a token off the lists", async () => {
  const asked = [];
  const answer = (url, init) => {
    asked.push({ url, init });
    if (url.endsWith("/v1/market/lists?chain=solana")) return new Response(JSON.stringify({ lists: { new: [{ token: "So11111111111111111111111111111111111111112" }] } }));
    if (url.startsWith("https://lite-api.jup.ag/")) return new Response(JSON.stringify([{ id: "So11111111111111111111111111111111111111112" }, { id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }]));
    if (url.includes("/v1/market/token")) return new Response(JSON.stringify({ risk: { holders: { src: "jupiter", as_of_ms: Date.now() } } }), { headers: { "server-timing": "total;dur=40" } });
    return new Response('{"ok":1}', { status: 503, headers: { "server-timing": 'cause;desc="5xx"', "retry-after": "2" } });
  };
  const r = await read("https://helper.invalid", async (url, init) => answer(url, init));
  const u = new URL(asked[0].url);
  assert.equal(asked[0].init.method, "POST");
  assert.equal(u.pathname, "/v1/proxy/jupiter/swap/v2/build");
  assert.equal(u.searchParams.get("maxAccounts"), "40");
  assert.deepEqual([r.status, r.timing, r.retryAfter], [503, 'cause;desc="5xx"', "2"]);
  assert.equal(r.page.mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "the listed token is left out");
  assert.deepEqual([r.page.status, r.page.src, r.page.timing], [200, "jupiter", "total;dur=40"]);
});
