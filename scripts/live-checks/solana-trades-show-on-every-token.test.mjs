// node --test scripts/live-checks/solana-trades-show-on-every-token.test.mjs: the live check replays recorded answers
// (solana-trades-show-on-every-token.answers.json). good: the card branch's pool tape (token.ts toTape) over real
// GeckoTerminal reads of NEARKAT's, BONK's (Solana) and SOGNI's (Base) top pools, 2026-11-14 17:3xZ: PASS. bad_deployed_204ee6b8a: the deployed
// helper before the card, {"trades":[],"src":"chain"} for all three: FAIL. Made from the good answer: a stale tape, a tape
// oldest first, a row out of shape, a 503, an empty tape still filling, a token not read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, RECENT_MS } from "./solana-trades-show-on-every-token.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "solana-trades-show-on-every-token.answers.json"), "utf8"));
const edit = (fn) => {
  const rec = structuredClone(A.good);
  fn(rec);
  return rec;
};
const body = (t, fn) => {
  const b = JSON.parse(t.body);
  fn(b);
  t.body = JSON.stringify(b);
};

test("the good answer passes", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.equal(v.lines.length, 3);
});

test("the deployed helper before the card fails: all three tapes empty", () => {
  const v = judge(A.bad_deployed_204ee6b8a);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ["BAD NEARKAT: no trades (src chain)", "BAD BONK: no trades (src chain)", "BAD SOGNI: no trades (src chain)"]);
});

test("made from the good answer: each fault fails", () => {
  const cases = {
    stale: edit((r) => (r.tokens.NEARKAT.atMs += RECENT_MS + 60_000)),
    oldest_first: edit((r) => body(r.tokens.BONK, (b) => b.trades.reverse())),
    bad_side: edit((r) => body(r.tokens.BONK, (b) => (b.trades[3].side = "buy"))),
    base_stale: edit((r) => (r.tokens.SOGNI.atMs += RECENT_MS + 60_000)),
    base_bad_tx: edit((r) => body(r.tokens.SOGNI, (b) => (b.trades[0].tx = b.trades[0].tx.slice(0, 40)))),
    bad_tx: edit((r) => body(r.tokens.NEARKAT, (b) => (b.trades[0].tx = "0xabc"))),
    bad_usd: edit((r) => body(r.tokens.NEARKAT, (b) => (b.trades[0].usd = 1.5))),
    status_503: edit((r) => (r.tokens.BONK = { ...r.tokens.BONK, status: 503, body: '{"error":{"code":"upstream"}}' })),
    filling_empty: edit((r) => body(r.tokens.NEARKAT, (b) => ((b.trades = []), (b.filling = true)))),
    not_json: edit((r) => (r.tokens.BONK.body = "<html>")),
    not_read: edit((r) => delete r.tokens.BONK),
  };
  for (const [name, rec] of Object.entries(cases)) assert.equal(judge(rec).ok, false, `${name}: ${judge(rec).lines.join("; ")}`);
});
