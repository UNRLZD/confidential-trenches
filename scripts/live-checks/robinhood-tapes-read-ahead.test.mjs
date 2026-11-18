// node --test scripts/live-checks/robinhood-tapes-read-ahead.test.mjs: the live check's verdict replays recorded runs
// (robinhood-tapes-read-ahead.answers.json):
//   good:        the branch helper (card robinhood-tapes-read-ahead, the lists' tapes read ahead) run on the Mac, keyless,
//                the 12 listed coins of each chain opened at once after its lists loaded: every tape whole inside 45 s: PASS;
//   bad_run:     live helper run 44279880076 (18 Nov 10:07Z, helper at ff65a0403), helper-robinhood-capacity's printed
//                lines as this check records them: 9 Robinhood tapes still filling past 45 s, 2 CoinGecko's rows: FAIL;
//   bad_deployed: the deployed helper read keyless from the Mac by this check: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read, TOKENS, tokensOf } from "./robinhood-tapes-read-ahead.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "robinhood-tapes-read-ahead.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer passes: both chains' listed coins opened at once on the branch helper, every tape whole inside 45 s", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const c of A.good.chains) assert.ok(c.answers.length >= 6, c.chain);
  assert.ok(r.lines.some((l) => /^ {4}robinhood: (\d+) of \1 tapes whole inside 45 s/.test(l)), r.lines.join("\n"));
});

test("the recorded bad answer of live run 44279880076 fails: 9 Robinhood tapes still filling past 45 s, 2 CoinGecko's, and no Base read", () => {
  const r = judge(A.bad_run);
  assert.equal(r.ok, false);
  assert.equal(bad(r).filter((l) => /^BAD robinhood trades 0x[0-9a-f]{40}: still filling 45\d{3} ms after its first read \(21 reads\), past 45000 ms$/.test(l)).length, 9, bad(r).join("\n"));
  assert.equal(bad(r).filter((l) => / 200 src "coingecko" /.test(l)).length, 2, bad(r).join("\n"));
  assert.ok(bad(r).includes("BAD both chains read (robinhood, base)"));
});

test("the recorded bad answer of the deployed helper fails, a tape named by its chain, status and time", () => {
  const r = judge(A.bad_deployed);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).every((l) => /^BAD (robinhood|base) trades 0x[0-9a-f]{40}: /.test(l)), bad(r).join("\n"));
});

test("planted faults fail: a chain missing, a list not read, a tape 503, a fill past 45 s, a tape that never filled, too few tokens", () => {
  const edit = (f) => {
    const run = structuredClone(A.good);
    f(run);
    return judge(run);
  };
  assert.equal(edit((r) => r.chains.pop()).ok, false);
  assert.equal(edit((r) => (r.chains[0].lists.status = 500)).ok, false);
  assert.equal(edit((r) => Object.assign(r.chains[0].answers[0], { status: 503, shape: null, body: "busy" })).ok, false);
  assert.equal(edit((r) => Object.assign(r.chains[0].answers[0], { filling: true, filled: { status: 200, filling: false, shape: "tape", ms: 45_001, reads: 22 } })).ok, false);
  assert.equal(edit((r) => Object.assign(r.chains[1].answers[0], { filling: true, filled: { status: 200, filling: true, shape: "tape", ms: 45_200, reads: 21 } })).ok, false);
  assert.equal(edit((r) => Object.assign(r.chains[1].answers[0], { filling: true })).ok, false);
  assert.equal(edit((r) => (r.chains[0].answers = r.chains[0].answers.slice(0, 5)) && (r.chains[0].lists.tokens = 5)).ok, false);
  assert.equal(edit((r) => (r.chains[0].answers[0].shape = 'src "coingecko"')).ok, false);
});

test("tokensOf takes Trending 1h, then 5m, then New, each once, at most TOKENS", () => {
  const t = (i) => `0x${i.toString(16).padStart(40, "0")}`;
  const body = JSON.stringify({ lists: { new: [{ token: t(1) }, { token: t(2) }], trending_5m: [{ token: t(3) }, { token: t(1) }], trending_1h: Array.from({ length: 11 }, (_, i) => ({ token: t(10 + i) })) } });
  assert.deepEqual(tokensOf(body), [...Array.from({ length: 11 }, (_, i) => t(10 + i)), t(3)]);
  assert.equal(tokensOf(body).length, TOKENS);
  assert.deepEqual(tokensOf("not json"), []);
});

test("read: both chains' lists, their tokens' tapes at once, a filling tape read again until whole", async () => {
  const t = `0x${"ab".repeat(20)}`;
  let n = 0;
  const fetchFn = async (url) => {
    if (url.includes("/v1/market/lists")) return new Response(JSON.stringify({ lists: { trending_1h: [{ token: t }] } }), { status: 200 });
    n++;
    return new Response(JSON.stringify({ trades: [], ...(n === 1 ? { filling: true } : {}), src: "chain", as_of_ms: 1 }), { status: 200 });
  };
  const run = await read("http://h", fetchFn, { sleep: async () => {}, pollMs: 0 });
  assert.deepEqual(run.chains.map((c) => [c.chain, c.lists.tokens]), [["robinhood", 1], ["base", 1]]);
  assert.equal(run.chains[0].answers[0].filling, true);
  assert.equal(run.chains[0].answers[0].filled.filling, false);
  assert.equal(run.chains[1].answers[0].filling, undefined);
});
