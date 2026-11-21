// Replays of the sol-tape-trader-is-the-events-user live check (sol-tape-trader-is-the-events-user.answers.json): the
// good run, read from the deployed helper at 18 Nov 11:37Z (8 rows of our own reads, each its event's user), passes; the
// bad run is that run with the shape the helper before the card served planted on its first transaction (the pump.fun
// curve's own sell made inside the trader's sell, served as a second row named by the trader; apps/helper
// trades.test.ts shows the helper at 9096d18cf serving exactly that), and fails; read() asks what judge() judges.
// Card sol-tape-row-only-from-a-decoded-event: `meteora` is coin 9c2gwAWx's four Meteora DBC rows from live run
// 44938731300 with each transaction's log and inner instructions, read again alike on two providers (22 Nov), and
// passes; `meteoraMain` is the three BAD lines main's check printed for them that run, which read the log alone;
// `meteoraBad` is `meteora` with one row one unit over its event's leg, and fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TRADES_RPCS } from "../../apps/helper/src/data/solana/trades.ts";
import { RETRY } from "./provider-answer.mjs";
import { events, EXIT, INNER_ONLY, innerEvents, innerOf, judge, read, units } from "./sol-tape-trader-is-the-events-user.mjs";

RETRY.ms = 0;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "sol-tape-trader-is-the-events-user.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

/** A recorded transaction as a provider answers it: its log, and its inner instructions (innerOf's record) rebuilt
 *  over account keys made from the programs they name. */
function txResult(run, tx) {
  const logs = run.logs[tx];
  if (logs == null) return null;
  const inner = run.inner?.[tx];
  if (inner == null) return { meta: { err: null, logMessages: logs } };
  const keys = [];
  const idx = (p) => {
    const s = p ?? "unnamed";
    if (!keys.includes(s)) keys.push(s);
    return keys.indexOf(s);
  };
  const instructions = inner.map((g) => ({ programIdIndex: idx(g.top), data: "" }));
  const innerInstructions = inner.map((g, index) => ({ index, instructions: g.ixs.map((ix) => ({ programIdIndex: idx(ix.p), ...(ix.h === null ? {} : { stackHeight: ix.h }), data: ix.d ?? "" })) }));
  return { meta: { err: null, logMessages: logs, innerInstructions }, transaction: { message: { accountKeys: keys, instructions } } };
}

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
      return txResult(run, q.params[0]);
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

test("card sol-tape-row-only-from-a-decoded-event: run 44938731300's Meteora DBC rows, recorded with their inner instructions, are each a trader's trade (amt its EvtSwap2's leg, trader null: the event names none): PASS, where main's check printed BAD for each", () => {
  const r = judge(A.meteora);
  assert.equal(r.exit, EXIT.PASS, r.lines.join("\n"));
  assert.deepEqual(bad(r), []);
  for (const tx of Object.keys(A.meteora.logs)) assert.ok(r.lines.some((l) => l.startsWith("ok ") && l.includes(tx.slice(0, 12)) && l.includes("a meteora-dbc trader's trade")), tx);
  // the rows main's check printed BAD for, every one now judged ok on the same transactions
  for (const l of A.meteoraMain.lines) {
    const tx = /trade (\S{12}) /.exec(l)[1];
    assert.ok(r.lines.some((x) => x.startsWith("ok ") && x.includes(`trade ${tx} `)), l);
  }
  // as main's check read it (the log alone): a Meteora log with no inner instructions read is not judged, never BAD
  const logsOnly = { ...A.meteora, inner: {} };
  assert.equal(judge(logsOnly).exit, EXIT.INCONCLUSIVE);
  assert.deepEqual(bad(judge(logsOnly)), []);
});

test("card sol-tape-row-only-from-a-decoded-event: bad: the same DBC rows with one served one unit over its event's leg: FAIL, naming that row alone", () => {
  const r = judge(A.meteoraBad);
  assert.equal(r.exit, EXIT.FAIL);
  assert.equal(bad(r).length, 1, bad(r).join("\n"));
  assert.match(bad(r)[0], /^BAD 9c2gwAWx trade hiKkTrFL6yHK \(b, amt 4895995\.463327, trader null\): amt is no leg of a venue event in its transaction \(meteora-dbc 4895995463326\/990000000\)$/);
});

test("card sol-tape-row-only-from-a-decoded-event: a DBC row one unit off its event's leg, or naming a trader its event does not, fails; a DLMM row (its Swap names `from`) with a null trader fails; inner stack heights that build no stack leave it unjudged", async () => {
  const tape = A.meteora.tapes[0];
  const row = tape.rows[0];
  const one = (r, run = A.meteora) => ({ base: "x", tapes: [{ ...tape, rows: [r] }], decimals: run.decimals, logs: { [r.tx]: run.logs[r.tx] }, inner: { [r.tx]: run.inner[r.tx] } });
  assert.equal(judge(one(row)).exit, EXIT.PASS);
  // one unit (1e-6 of the coin) over and under the EvtSwap2 output_amount
  assert.equal(units(row.amt, 6), 4895995463326n);
  assert.match(bad(judge(one({ ...row, amt: "4895995.463327" })))[0], /amt is no leg of a venue event in its transaction \(meteora-dbc 4895995463326\//);
  assert.match(bad(judge(one({ ...row, amt: "4895995.463325" })))[0], /amt is no leg of a venue event/);
  assert.match(bad(judge(one({ ...row, trader: "11111111111111111111111111111111" })))[0], /trader is not its event's user \(none\)/);
  // a stack height past the frames read: unjudged
  const broken = structuredClone(A.meteora);
  broken.inner[row.tx][0].ixs[0].h = 9;
  assert.equal(judge(one(row, broken)).exit, EXIT.INCONCLUSIVE);
  // DLMM: the helper's recorded buy (apps/helper fixtures/sol-meteora-txs.json), its Swap's `from` the trader
  const f = JSON.parse(readFileSync(path.join(HERE, "../../apps/helper/src/data/solana/fixtures/sol-meteora-txs.json"), "utf8"));
  const d = f.txs["dlmm-buy"];
  const ev = events(d.result.meta.logMessages, innerOf(d.result)).find((e) => e.venue === "meteora-dlmm");
  assert.ok(ev && ev.user !== "", "DLMM names its trader");
  const dl = { base: "x", tapes: [{ coin: "dlmm", status: 200, src: "chain", rows: [] }], decimals: { dlmm: 0 }, logs: { [d.signature]: d.result.meta.logMessages }, inner: { [d.signature]: innerOf(d.result) } };
  const dRow = { tx: d.signature, side: "b", amt: ev.legs[0], trader: ev.user };
  const withRow = (r) => ({ ...dl, tapes: [{ ...dl.tapes[0], rows: [r] }] });
  assert.equal(judge(withRow(dRow)).exit, EXIT.PASS, judge(withRow(dRow)).lines.join("\n"));
  assert.match(bad(judge(withRow({ ...dRow, trader: null })))[0], /trader is not its event's user/);
  assert.equal(INNER_ONLY.length, 3);
  assert.equal(innerEvents([{ top: null, ixs: [{ p: "x", h: 1 }] }]), null);
});

test("read() asks the helper and two providers what judge() judges: each recorded run read again judges the same", async () => {
  for (const k of ["good", "bad", "meteora", "meteoraBad"]) {
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
