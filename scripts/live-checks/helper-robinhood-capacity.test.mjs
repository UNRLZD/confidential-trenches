// node --test scripts/live-checks/helper-robinhood-capacity.test.mjs: the live check's verdict replays recorded runs
// (helper-robinhood-capacity.answers.json):
//   good:         the branch helper at 61f16646 (card robinhood-listed-tape-opens) on the Mac, read by
//                 helper-robinhood-capacity.mjs --base <local> --record: 12 of 12 tapes 200: PASS;
//   bad_listed_dropped: the deployed helper at 358d8f4f (live run 42345906841, 06:12Z): 3 of 12 listed tokens' tapes
//                 404 not_found in ~800 ms, gone from the lists' next answer: FAIL;
//   bad_pre_card: the deployed helper at 6832227 (19:07Z): 6 of 12 503 after 52-57 s and 3 timeouts at 60 s: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read, TOKENS, TOKENS_MIN, tokensOf } from "./helper-robinhood-capacity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-robinhood-capacity.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (f) => {
  const run = structuredClone(A.good);
  f(run);
  return judge(run);
};

test("the recorded good answer passes: 12 listed Robinhood tokens at once, every tape 200 from the chain, each tape's time printed", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(A.good.answers.length, TOKENS);
  assert.match(r.lines.at(-1), /12 of 12 tapes 200 at once \(p50 \d+ ms, max \d+ ms\)/);
  assert.ok(r.lines.filter((l) => l.startsWith("ok  trades ")).every((l) => / 200 tape in \d+ ms$/.test(l)), r.lines.join("\n"));
});

test("the recorded bad answer (the deployed helper before this card) fails, each tape named by its status and time", () => {
  const r = judge(A.bad_pre_card);
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 9, r.lines.join("\n"));
  assert.equal(bad(r).filter((l) => / 503 .* in \d+ ms$/.test(l)).length, 6, bad(r).join("\n"));
  assert.equal(bad(r).filter((l) => / 0 .*aborted due to timeout/.test(l)).length, 3, bad(r).join("\n"));
  assert.match(r.lines.at(-1), /3 of 12 tapes 200 at once/);
});

test("the recorded bad answer of card robinhood-listed-tape-opens (a listed token's tape refused once a refresh dropped it) fails, each 404 named", () => {
  const r = judge(A.bad_listed_dropped);
  assert.equal(r.ok, false);
  assert.deepEqual(
    bad(r).map((l) => l.replace(/ in \d+ ms$/, "")),
    ["0x451b42a15100c340ca12f7c66de06fac5ea2d751", "0xf44702b17d9abd53815f703e772f35e9c71a53af", "0xdcd7face6a1d0bdd0665ea1b0842fc9ce797862b"].map((t) => `BAD trades ${t}: 404 {"error":{"code":"not_found"}}`),
  );
  assert.match(r.lines.at(-1), /9 of 12 tapes 200 at once/);
});

test("planted on the good answer: one 429, one 503, a tape not from the chain, too few tokens and failed lists each fail; a slow 200 tape passes with its time printed", () => {
  let r = edit((run) => (run.answers[3].ms = 40_000));
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => / 200 tape in 40000 ms$/.test(l)));
  r = edit((run) => Object.assign(run.answers[2], { status: 503, retryAfter: null, shape: null, body: '{"error":{"code":"upstream"}}' }));
  assert.equal(bad(r).length, 1);
  assert.match(bad(r)[0], / 503 \{"error":\{"code":"upstream"\}\} in \d+ ms$/);
  r = edit((run) => Object.assign(run.answers[0], { status: 429, retryAfter: "30", shape: null, body: "{}" }));
  assert.match(bad(r)[0], /429 Retry-After 30/);
  r = edit((run) => (run.answers[5].shape = 'src "gecko"'));
  assert.equal(bad(r).length, 1);
  r = edit((run) => {
    run.answers = run.answers.slice(0, TOKENS_MIN - 1);
    run.lists.tokens = run.answers.length;
  });
  assert.match(bad(r)[0], /^BAD GET \/v1\/market\/lists\?chain=robinhood answers 200, 5 listed tokens/);
  r = edit((run) => {
    run.answers.pop();
  });
  assert.equal(r.ok, false, "a tape read missing from the listed tokens");
  r = edit((run) => Object.assign(run, { lists: { status: 503, ms: 10, tokens: 0 }, answers: [] }));
  assert.deepEqual(bad(r), ["BAD GET /v1/market/lists?chain=robinhood answers 503, 0 listed tokens read (at least 6)"]);
});

test("tokensOf takes Trending 1h, then 5m, then New, each address once, at most TOKENS, and refuses a non-address", () => {
  const a = (i) => `0x${i.toString(16).padStart(40, "0")}`;
  const body = JSON.stringify({ lists: { trending_1h: [{ token: a(1) }, { token: "0xBAD" }, { token: a(2) }], trending_5m: [{ token: a(2) }, { token: a(3) }], new: Array.from({ length: 20 }, (_, i) => ({ token: a(10 + i) })) } });
  const t = tokensOf(body);
  assert.equal(t.length, TOKENS);
  assert.deepEqual(t.slice(0, 4), [a(1), a(2), a(3), a(10)]);
  assert.deepEqual(tokensOf("not json"), []);
});

test("read() asks the lists with the app's Origin, then every token's tape at once, and keeps no 200 body", async () => {
  const asked = [];
  const a = (i) => `0x${i.toString(16).padStart(40, "0")}`;
  const fetchFn = async (url, init) => {
    asked.push([url, init.headers.origin]);
    if (url.includes("/v1/market/lists")) return new Response(JSON.stringify({ lists: { trending_1h: Array.from({ length: 8 }, (_, i) => ({ token: a(i + 1) })) } }), { status: 200 });
    return new Response(JSON.stringify({ trades: [], src: "chain", as_of_ms: 1 }), { status: 200 });
  };
  const run = await read("https://helper.test", fetchFn);
  assert.equal(asked.length, 9);
  assert.ok(asked.every(([, o]) => o === "https://confidential.unrealized.trade"));
  assert.ok(run.answers.every((x) => !("body" in x) && x.shape === "tape"));
  assert.equal(judge(run).ok, true);
});
