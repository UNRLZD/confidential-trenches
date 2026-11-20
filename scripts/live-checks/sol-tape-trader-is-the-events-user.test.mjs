// Replays of the sol-tape-trader-is-the-events-user live check (sol-tape-trader-is-the-events-user.answers.json): the
// good run, read from the deployed helper at 18 Nov 11:37Z (8 rows of our own reads, each its event's user), passes; the
// bad run is that run with the shape the helper before the card served planted on its first transaction (the pump.fun
// curve's own sell made inside the trader's sell, served as a second row named by the trader; apps/helper
// trades.test.ts shows the helper at 9096d18cf serving exactly that), and fails; read() asks what judge() judges.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TRADES_RPCS } from "../../apps/helper/src/data/solana/trades.ts";
import { RETRY } from "./provider-answer.mjs";
import { events, EXIT, judge, read, units } from "./sol-tape-trader-is-the-events-user.mjs";

RETRY.ms = 0;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "sol-tape-trader-is-the-events-user.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

/** A fetch that answers a recorded run: the helper's lists and tapes, and each provider's replies from the record. */
function replay(run) {
  return async (url, init) => {
    const u = new URL(url);
    if (url.startsWith(run.base)) {
      if (u.pathname === "/v1/market/lists") return new Response(JSON.stringify({ lists: { new: run.tapes.map((t) => ({ token: t.coin })) } }), { status: 200 });
      const t = run.tapes.find((x) => x.coin === u.searchParams.get("token"));
      return new Response(JSON.stringify({ trades: t.rows, src: t.src }), { status: t.status });
    }
    assert.ok(TRADES_RPCS.includes(url), url);
    const q = JSON.parse(init.body);
    const result = (() => {
      if (q.method === "getAccountInfo") {
        const d = run.decimals[q.params[0]];
        if (!Number.isSafeInteger(d)) return null;
        const b = Buffer.alloc(82);
        b[44] = d;
        b[45] = 1;
        return { context: { slot: 1 }, value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [b.toString("base64"), "base64"] } };
      }
      const logs = run.logs[q.params[0]];
      return logs == null ? null : { meta: { err: null, logMessages: logs } };
    })();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }), { status: 200 });
  };
}

test("good: the deployed helper's Solana tapes of our own reads, every judged row a trader's trade named by its event's user: PASS", () => {
  const r = judge(A.good);
  assert.deepEqual(bad(r), []);
  assert.equal(r.exit, EXIT.PASS);
  assert.ok(r.lines.some((l) => /^ok {2}[1-9]\d* rows judged/.test(l)), r.lines.join("\n"));
});

test("bad: a venue program's own swap inside the trader's, served as the trader's second row: FAIL, naming it", () => {
  const r = judge(A.bad);
  assert.equal(r.exit, EXIT.FAIL);
  assert.equal(bad(r).length, 1, bad(r).join("\n"));
  assert.match(bad(r)[0], /a venue program's own swap, made inside another venue's instruction, is on the tape/);
});

test("read() asks the helper and two providers what judge() judges: each recorded run read again judges the same", async () => {
  for (const k of ["good", "bad"]) {
    const again = await read(A[k].base, replay(A[k]));
    assert.deepEqual(judge(again).lines, judge(A[k]).lines, k);
  }
});

test("a row named by another trade's user, a null trader for an event that names one, or an amt no event moved fails; an unread transaction is not judged, and none judged is INCONCLUSIVE", () => {
  const tape = A.good.tapes.find((t) => t.src === "chain" && t.rows.length > 0);
  const one = (row, logs = A.good.logs[row.tx]) => ({ base: "x", tapes: [{ ...tape, rows: [row] }], decimals: A.good.decimals, logs: { [row.tx]: logs } });
  const row = tape.rows[0];
  assert.equal(judge(one(row)).exit, EXIT.PASS);
  assert.match(bad(judge(one({ ...row, trader: "11111111111111111111111111111111" })))[0], /trader is not its event's user/);
  assert.match(bad(judge(one({ ...row, trader: null })))[0], /trader is not its event's user/);
  assert.match(bad(judge(one({ ...row, amt: `${row.amt}1` })))[0], /amt is no leg of a venue event/);
  assert.equal(judge(one(row, null)).exit, EXIT.INCONCLUSIVE);
  assert.equal(judge(one(row, [...A.good.logs[row.tx], "Log truncated"])).exit, EXIT.INCONCLUSIVE);
  assert.equal(judge({ base: "x", tapes: [], decimals: {}, logs: {} }).exit, EXIT.FAIL);
  assert.equal(events(["Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [2]"]), null); // a stack that does not start at 1
  assert.equal(units("1.5", 6), 1500000n);
  assert.equal(units("1.5e3", 6), null);
});
