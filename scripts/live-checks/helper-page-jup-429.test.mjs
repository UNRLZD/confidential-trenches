// node --test scripts/live-checks/helper-page-jup-429.test.mjs: the check replays its recorded answers
// (helper-page-jup-429.answers.json): this branch's proxy answering a real Jupiter build passes; the deployed helper
// before the card (a 200 with no Server-Timing) and live run 42143211092's bare 503 fail; a 503 naming its cause passes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CAUSES, judge, read } from "./helper-page-jup-429.mjs";

const A = JSON.parse(readFileSync(new URL("./helper-page-jup-429.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer (this branch's proxy, a real Jupiter build): PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answers: the deployed helper before the card (no Server-Timing) and the 01:21Z bare 503: FAIL", () => {
  const r = judge(A.bad_deployed);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ["BAD Server-Timing names the call's turn and send: none"]);
  const b = judge(A.bad_bare_503);
  assert.equal(b.ok, false);
  assert.deepEqual(bad(b), ["BAD a 503 names its cause in Server-Timing: none (a bare 503)"]);
});

test("planted: a 503 naming each cause passes; an unknown cause, a cause only inside another entry's desc, or our 429 fails", () => {
  for (const c of CAUSES) assert.equal(judge({ ...A.bad_bare_503, timing: `budget;dur=0, turn;dur=3001, cause;desc="${c}"`, retryAfter: "4" }).ok, true, c);
  assert.equal(judge({ ...A.bad_bare_503, timing: 'cause;desc="other"' }).ok, false);
  assert.equal(judge({ ...A.bad_bare_503, timing: 'send;desc="x cause;desc=429"' }).ok, false);
  assert.equal(judge({ ...A.good, status: 429, timing: null }).ok, false);
  const waited = judge({ ...A.good, timing: 'budget;dur=0, turn;dur=1003, 429;desc="1", send;dur=240' });
  assert.equal(waited.ok, true);
  assert.match(waited.lines[1], /\(1 Jupiter 429 waited out\)$/);
});

test("read() asks the build as the kit does, by POST to the proxy path, and keeps the headers that name the waits", async () => {
  let asked;
  const answer = new Response('{"ok":1}', { status: 503, headers: { "server-timing": 'cause;desc="5xx"', "retry-after": "2" } });
  const r = await read("https://helper.invalid", async (url, init) => ((asked = { url, init }), answer));
  const u = new URL(asked.url);
  assert.equal(asked.init.method, "POST");
  assert.equal(u.pathname, "/v1/proxy/jupiter/swap/v2/build");
  assert.equal(u.searchParams.get("maxAccounts"), "40");
  assert.deepEqual([r.status, r.timing, r.retryAfter], [503, 'cause;desc="5xx"', "2"]);
});
