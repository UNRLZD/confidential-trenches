// Card buy-box-quotes-before-funds, release 159: on a fresh $0 account the Solana box drew You receive "—" though the
// signing page answered the box's pool.buy.dry with an out (app live run 43779504700: "the page answered an out, You
// receive reads —"). The page prices a Solana buy with no pool note as the move from Cash it would make (src/pools.ts
// poolBuyDryKind: d.moved, then main.ts dryWithCash's with_cash), which takes longer than the kit client's 10 s for the
// kind (packages/kit/src/signpage/client.ts SIGNPAGE_TIMEOUT_MS["pool.buy.dry"]). The client then ends the request as
// client_timeout and drops the page's later answer, and the box took client_timeout as an answer that is no
// (TradeBox.tsx's asks: coinTapAgainMs(code) null, nothing asked again), so the dash stayed. Base answered inside the 10 s
// on that run, which is why it showed. Every box ask runs the same loop (Solana and NEAR's Fee ask, Base and Robinhood's
// buys ask, Max's ask, the sell's preview), so the loop is driven here as TradeBox runs it, with a client that ends at
// 10 s and a page that answers the Solana answer's real shape (sign run 43779499955: tap_max "0", with_cash "0", out
// "198.82471" for 0.05 SOL).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as M from "../src/screens/trade/model.ts";

type Outcome = { ok: true; result: { tap_max: string; with_cash?: string; out?: string; cost?: string } } | { ok: false; error: { code: string } };

/** The kit client's end for pool.buy.dry. */
const CLIENT_MS = 10_000;
/** The Solana answer of a fresh account, as the page sends it. */
const SOLANA = { tap_max: "0", with_cash: "0", out: "198.82471" };

/**
 * The box's ask loop as TradeBox.tsx runs it, on a virtual clock: ask, take the outcome, ask again after the delay the
 * model gives for a refusal, until an answer or a refusal asked no more. `pageMs[i]` is how long the page takes on the
 * i-th ask; the client ends any ask past CLIENT_MS as client_timeout and drops the page's answer.
 */
function run(pageMs: number[], again: (code: string, tries: number) => number | null): { read: M.FeeRead | null; asks: number; at: number; tags: (string | null)[] } {
  const key = JSON.stringify(["MINT", null, null]);
  const amount = 500n;
  let at = 250; // FEE_ASK_SETTLE_MS
  let read: M.FeeRead | null = null;
  let tries = 0;
  const tags: (string | null)[] = [];
  for (let i = 0; i < pageMs.length; i++) {
    const ms = pageMs[i]!;
    const o: Outcome = ms > CLIENT_MS ? { ok: false, error: { code: "client_timeout" } } : { ok: true, result: SOLANA };
    at += Math.min(ms, CLIENT_MS);
    if (o.ok) {
      read = M.feeReadOf(key, o.result, amount);
      return { read, asks: i + 1, at, tags };
    }
    const d = again(o.error.code, tries);
    if (d === null) return { read, asks: i + 1, at, tags };
    if (o.error.code !== "busy") tries++;
    at += d;
    tags.push(o.error.code);
  }
  return { read, asks: pageMs.length, at, tags };
}

test("a dry the kit client ended at 10 s (client_timeout) is asked again, not taken as no", () => {
  // red at 63ef7015c: coinTapAgainMs("client_timeout") was null, so the box asked once and kept the dash
  assert.notEqual(M.coinTapAgainMs("client_timeout"), null);
  assert.equal(M.dryAgainMs("client_timeout", 0), 0, "asked again at once: the page has the reads it made warm");
  assert.equal(M.dryAgainMs("busy", 99), 1_000, "a busy page: as before, for as long as it is busy");
  assert.equal(M.dryAgainMs("down", 0), 3_000);
  assert.equal(M.dryAgainMs("down", M.DRY_TRIES), null, "bounded");
  assert.equal(M.dryAgainMs("client_timeout", M.DRY_TRIES), null, "bounded: a page that never answers is not asked forever");
  for (const code of ["not_allowed", "not_funded", "quote_check_failed", "timeout"]) assert.equal(M.dryAgainMs(code, 0), null, code);
});

test("the Solana answer that came after the client's 10 s reaches You receive on the next ask", () => {
  const key = JSON.stringify(["MINT", null, null]);
  // the first ask priced past 10 s (the move from Cash read cold), the next inside it
  const r = run([14_000, 6_000], M.dryAgainMs);
  assert.equal(r.asks, 2);
  assert.deepEqual(r.tags, ["client_timeout"]);
  assert.deepEqual(M.receiveShown(r.read, key, 500n), { out: "198.82471", pending: false }, "You receive ≈ 198.82 of the coin");
  // the loop as it was at 63ef7015c (no ask after client_timeout): the dash
  const before = run([14_000, 6_000], (code) => (code === "busy" ? 1_000 : code === "down" ? 3_000 : null));
  assert.equal(M.receiveShown(before.read, key, 500n), null);
  // a page that never answers within 10 s: asked DRY_TRIES more times, then the dash, never a loop
  const never = run([20_000, 20_000, 20_000, 20_000, 20_000, 20_000], M.dryAgainMs);
  assert.equal(never.asks, M.DRY_TRIES + 1);
  assert.equal(never.read, null);
});

test("You receive says Quoting while the coin's dry for this amount runs, the out once it answers, the dash after a no", () => {
  const key = JSON.stringify(["MINT", null, null]);
  const tag = M.dryTag(key, 500n);
  assert.equal(tag, `${key}|500`);
  assert.equal(M.quotingShown(null, key, 500n, tag), true);
  // the answer came: its out, not Quoting
  assert.equal(M.quotingShown(M.feeReadOf(key, SOLANA, 500n), key, 500n, tag), false);
  // a newer amount asked: the last out stays, dimmed, as before, not Quoting
  assert.equal(M.quotingShown(M.feeReadOf(key, SOLANA, 500n), key, 900n, M.dryTag(key, 900n)), false);
  assert.deepEqual(M.receiveShown(M.feeReadOf(key, SOLANA, 500n), key, 900n), { out: "198.82471", pending: true });
  // the ask ended with no out (a refusal asked no more): the dash
  assert.equal(M.quotingShown(null, key, 500n, null), false);
  // another coin's or amount's ask is not this box's quote
  assert.equal(M.quotingShown(null, key, 500n, M.dryTag(key, 900n)), false);
  assert.equal(M.quotingShown(null, key, 500n, M.dryTag("OTHER", 500n)), false);
  // no amount, no coin: nothing is asked
  assert.equal(M.dryTag(key, null), null);
  assert.equal(M.dryTag(key, 0n), null);
  assert.equal(M.dryTag(null, 500n), null);
  assert.equal(M.quotingShown(null, key, null, null), false);
});
