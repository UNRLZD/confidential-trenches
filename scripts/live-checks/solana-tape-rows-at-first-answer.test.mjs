// Replays of the solana-tape-rows-at-first-answer live check (solana-tape-rows-at-first-answer.answers.json): the good run,
// read from this card's Solana tape, passes; the deployed helper's flooded coin served from a vendor's tape, and live run
// 43689567273's 0 rows, fail; read() asks what judge() judges.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COLD_SIGS as HELPER_COLD_SIGS, TRADES_RPCS } from "../../apps/helper/src/data/solana/trades.ts";
import { EXIT as EXIT_OF, RETRY } from "./provider-answer.mjs";
import { COLD_SIGS, judge, pathOf, read, RPCS } from "./solana-tape-rows-at-first-answer.mjs";

RETRY.ms = 0;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "solana-tape-rows-at-first-answer.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the pinned figures are the helper's: its first read's signatures and its public Solana providers", () => {
  assert.equal(COLD_SIGS, HELPER_COLD_SIGS);
  assert.deepEqual(RPCS, [...TRADES_RPCS]);
});

test("good: this card's tape, two flooded coins answered our own chain rows at their first answer: PASS", () => {
  const r = judge(A.good);
  assert.deepEqual(bad(r), []);
  assert.equal(r.verdict, "PASS");
  assert.ok(A.good.tapes.filter((t) => t.flooded).length >= 1);
});

test("bad: the deployed helper 0d308d3bc served a flooded coin CoinGecko's tape, its own first read holding none: FAIL, naming it", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(bad(r).map((l) => l.split(" ")[2]), ["9nxbR8JVEvrFS5UbPGksGFdCofoefQnFznt2DzApump"]);
  assert.match(bad(r)[0], /src coingecko/);
});

test("bad_zero: live run 43689567273, CjRGc8wH...pump 0 rows at its first answer: FAIL", () => {
  const r = judge(A.bad_zero);
  assert.equal(r.verdict, "FAIL");
  assert.match(bad(r)[0], /^BAD tape CjRGc8wHEbHaLTnRYVqAEdnESsnkGwhCDajnysxwpump .*0 row\(s\)/);
});

test("planted from the good answer: a tape's 0 rows, a 503, or a flooded coin's vendor rows FAIL; with no flooded coin opened, INCONCLUSIVE", () => {
  const at = (f) => {
    const run = structuredClone(A.good);
    f(run);
    return judge(run).verdict;
  };
  assert.equal(at((r) => (r.tapes[2].rows = 0)), "FAIL");
  assert.equal(at((r) => (r.tapes[1].status = 503)), "FAIL");
  assert.equal(at((r) => (r.tapes[0].src = "geckoterminal")), "FAIL");
  assert.equal(at((r) => (r.tapes[2].src = "coingecko")), "PASS", "a coin not flooded may be served its pool's vendor tape");
  assert.equal(at((r) => r.tapes.forEach((t) => (t.flooded = false))), "INCONCLUSIVE");
  assert.equal(at((r) => (r.lists.status = 503)), "FAIL");
  assert.equal(EXIT_OF.INCONCLUSIVE, 3);
});

/** A fetch that answers a recorded run: the helper's lists and tapes, and each pick's newest signatures as recorded. */
function replay(run) {
  return async (url, init) => {
    if (url.startsWith(run.base)) {
      const u = new URL(url);
      const json = { "content-type": "application/json" };
      if (u.pathname === "/v1/market/lists") return new Response(JSON.stringify({ lists: { new: run.picks.map((p) => ({ token: p.mint, launchpad: "pump.fun", buys_5m: p.buys_5m })) } }), { status: run.lists.status, headers: json });
      const t = run.tapes.find((x) => x.mint === u.searchParams.get("token"));
      const timing = typeof t.path === "string" ? { "server-timing": `${t.path}, total;dur=${t.ms}` } : {};
      return new Response(JSON.stringify({ trades: Array.from({ length: t.rows }, () => ({})), ...(t.filling ? { filling: true } : {}), src: t.src, as_of_ms: 0 }), { status: t.status, headers: { ...json, ...timing } });
    }
    assert.ok(RPCS.includes(url), url);
    const q = JSON.parse(init.body);
    const p = run.picks.find((x) => x.mint === q.params[0]);
    const sigs = Array.from({ length: p.newest.sigs }, (_, i) => ({ signature: `s${i}`, slot: 1, err: i < p.newest.ok ? null : { InstructionError: [0, { Custom: 1 }] } }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: sigs }), { status: 200 });
  };
}

test("read() asks the helper and the providers what judge() judges: each recorded run read again judges the same", async () => {
  for (const k of ["good", "bad", "path_run"]) {
    const again = await read(A[k].base, replay(A[k]));
    const strip = (lines) => lines.map((l) => l.replace(/, \d+ ms$/, ""));
    assert.deepEqual(strip(judge(again).lines), strip(judge(A[k]).lines), k);
  }
});

// card solana-flooded-coin-first-answer-holds-rows: each tape's line names its path (its Server-Timing's sol-open,
// sol-whole-cut and sol-vendor-read), so a red says how the helper answered. path_run: the deployed helper read with this
// card's check, every tape's path recorded and named.
test("path_run: each tape's line names how its first read was answered (sol-open); a recorded run without paths names none", () => {
  const r = judge(A.path_run);
  assert.equal(r.verdict, "INCONCLUSIVE");
  const tapes = r.lines.filter((l) => l.slice(4).startsWith("tape "));
  assert.equal(tapes.length, A.path_run.tapes.length);
  for (const l of tapes) assert.match(l, /, path \[sol-open;desc="listed \d, account \d+, watch \d+, answer by [a-z]+ after \d+ rounds \d+"\], \d+ ms$/, l);
  assert.ok(judge(A.bad).lines.every((l) => !l.includes("path [")));
  // planted from the bad answer: its flooded coin's vendor rows past a cut name the cut in the red line
  const run = structuredClone(A.bad);
  run.tapes[0].path = 'sol-vendor-read;desc="rows read 3 ms ago", sol-whole-cut;desc="a Meteora trade unread 2 s ago: past the 7 a second busy coins share"';
  const red = bad(judge(run));
  assert.equal(red.length, 1);
  assert.match(red[0], /src coingecko, path \[sol-vendor-read;desc="rows read 3 ms ago", sol-whole-cut;desc="a Meteora trade unread 2 s ago: past the 7 a second busy coins share"\], \d+ ms$/);
});

test("pathOf: only the tape's own parts, each bounded, null when it names none", () => {
  assert.equal(pathOf('sol-open;desc="listed 0, account 33, watch 46, answer by bound after 0 rounds 1999", sol-read-to;desc="x", total;dur=2001'), 'sol-open;desc="listed 0, account 33, watch 46, answer by bound after 0 rounds 1999"');
  assert.equal(pathOf("total;dur=3"), null);
  assert.equal(pathOf(""), null);
  assert.equal(pathOf(null), null);
  // a hostile header: a desc past 200 characters is not taken, and at most four parts
  assert.equal(pathOf(`sol-open;desc="${"x".repeat(201)}"`), null);
  assert.equal(pathOf(Array.from({ length: 9 }, () => 'sol-open;desc="a"').join(", ")), Array.from({ length: 4 }, () => 'sol-open;desc="a"').join(", "));
});
