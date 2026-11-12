// node --test scripts/live-checks/evm-withdraw-mainnet.test.mjs: the live check replays recorded runs
// (evm-withdraw-mainnet.answers.json). both: the card's record with its Robinhood and Base Sepolia withdraws, every
// line ok: PASS. robinhood: the Robinhood withdraws alone (a release and W's onward send each) read back on both pool
// RPCs, and SIGN_HOST's bundle: every line ok but "a withdraw on each testnet": FAIL. bad_buys: the EVM buy run's buys named as withdraws: FAIL. bad_page: the testnet build before this change
// (an EVM pool, no withdraw in it): FAIL. Made from the robinhood run, each adding a BAD line of its own: a release
// or a send reverted, to another pool, on another chain id, no Withdrawn, the send from another address, to another,
// one wei off the part, with calldata, in another block, a bundle that is not the pinned one, no page read; a read one
// RPC answers null: a NOTE, never a pass.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RETRY } from "./provider-answer.mjs";
import { EVM_BUY_MARKS, SIGN, WITHDRAWN, WITHDRAW_MARKS, judge, pageFacts, read, withdrawsOf } from "./evm-withdraw-mainnet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
RETRY.ms = 0;
const A = JSON.parse(readFileSync(path.join(HERE, "evm-withdraw-mainnet.answers.json"), "utf8"));
const RECORD = readFileSync(path.join(HERE, "evm-withdraw-mainnet.md"), "utf8");

// a fetch that answers each call with the recorded read for it, after checking the check asked the right thing
const replay = (run) => async (url, init) => {
  if (url.startsWith(SIGN)) return new Response("", { status: 200 }); // the page's facts are the recording's (rec.page)
  assert.equal(init.method, "POST");
  const body = JSON.parse(init.body);
  const r = run.reads.find((x) => x.rpc === url && x.method === body.method && x.hash === body.params[0]);
  assert.ok(r, `a recorded read for ${url} ${body.method} ${body.params[0]}`);
  if (r.answer.noAnswer !== undefined) return new Response("", { status: 429 });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...r.answer }), { status: 200 });
};
const mdOf = (run) => run.withdraws.map((t) => `Withdraw: ${t.network} ${t.release} ${t.onward} ${t.to} ${t.part}`).join("\n");
const run = async (rec) => judge({ ...(await read(mdOf(rec), replay(rec))), page: rec.page });
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
// the BAD lines beside the one a record with no Base Sepolia withdraw has
const extra = (r) => bad(r).filter((l) => !l.startsWith("BAD the record names a withdraw on each testnet"));
const editRead = (rec, f) => ({ ...rec, reads: rec.reads.map((x) => f(x) ?? x) });
const withResult = (x, f) => ({ ...x, answer: { result: f(x.answer.result) } });
const onward = (rec) => new Set(rec.withdraws.map((w) => w.onward));
// a change to what one pool RPC (PublicNode, one of each pair) reads of the release or the send
const at = (rec, which, method, f) => (x) => (x.method === method && x.rpc.includes("publicnode") && onward(rec).has(x.hash) === (which === "onward") ? withResult(x, f) : undefined);

test("the run record's Withdraw lines are the recorded run's withdraws, and each transaction is a Tx line too", () => {
  assert.deepEqual(withdrawsOf(RECORD), A.both.withdraws);
  assert.match(RECORD, /^Money path: yes$/m);
  for (const w of A.both.withdraws) for (const h of [w.release, w.onward]) assert.ok(RECORD.includes(`Tx: ${w.network} ${h}\n`), h);
});

test("recorded good run: the Robinhood and Base Sepolia withdraws read back on both pool RPCs of each chain: PASS", async () => {
  const r = await run(A.both);
  assert.deepEqual(bad(r), [], r.lines.join("\n"));
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.deepEqual([...new Set(A.both.withdraws.map((w) => w.network))].sort(), ["base-sepolia", "robinhood-testnet"]);
});

test("pageFacts reads the index's pin, the bundle's sha384, the EVM buy's marks and the EVM withdraw's", () => {
  const f = pageFacts('<script src="/app.js" integrity="sha384-AAAA"></script>', `x("${EVM_BUY_MARKS[0]}","${WITHDRAW_MARKS[0]}","${WITHDRAW_MARKS[1]}")`);
  assert.equal(f.pin, "sha384-AAAA");
  assert.deepEqual(f.marks, [EVM_BUY_MARKS[0]]);
  assert.deepEqual(f.withdraw, [...WITHDRAW_MARKS]);
  assert.deepEqual(pageFacts("", "plain").withdraw, []);
});

test("recorded bad run: the Robinhood withdraws alone, each read back exactly the part to To; FAIL only for the testnet with none", async () => {
  const r = await run(A.robinhood);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(bad(r), ["BAD the record names a withdraw on each testnet: robinhood-testnet, robinhood-testnet"], r.lines.join("\n"));
});

test("recorded bad run: the EVM buy run's buys named as withdraws: FAIL", async () => {
  const r = await run(A.bad_buys);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes("the release is withdraw()")));
});

test("recorded bad run: the testnet build before this change, an EVM pool and no withdraw in it: FAIL", async () => {
  const r = await run({ ...A.robinhood, page: A.bad_page.page });
  assert.equal(extra(r).length, 1, r.lines.join("\n"));
  assert.match(extra(r)[0], /a build with an EVM pool carries its withdraw/);
});

test("a build with no EVM pool and no EVM withdraw (the mainnet build until its pools are pinned) passes the bundle part; one with only part of the withdraw fails", async () => {
  const g = A.robinhood;
  assert.deepEqual(extra(await run({ ...g, page: { ...g.page, marks: [], withdraw: [] } })), []);
  assert.deepEqual(extra(await run({ ...g, page: { ...g.page, marks: [...EVM_BUY_MARKS], withdraw: [...WITHDRAW_MARKS] } })), []);
  assert.equal(extra(await run({ ...g, page: { ...g.page, marks: [...EVM_BUY_MARKS], withdraw: [WITHDRAW_MARKS[0]] } })).length, 1);
});

test("made from the Robinhood run: each break adds a BAD line of its own", async () => {
  const g = A.robinhood;
  const R = "eth_getTransactionReceipt";
  const T = "eth_getTransactionByHash";
  const cases = {
    "release on one RPC only": editRead(g, at(g, "release", T, () => null)),
    "send on one RPC only": editRead(g, at(g, "onward", R, () => null)),
    "release reverted": editRead(g, at(g, "release", R, (r) => ({ ...r, status: "0x0" }))),
    "send reverted": editRead(g, at(g, "onward", R, (r) => ({ ...r, status: "0x0" }))),
    "no Withdrawn": editRead(g, at(g, "release", R, (r) => ({ ...r, logs: r.logs.filter((l) => l.topics[0] !== WITHDRAWN) }))),
    "another contract's Withdrawn": editRead(g, at(g, "release", R, (r) => ({ ...r, logs: r.logs.map((l) => (l.topics[0] === WITHDRAWN ? { ...l, address: "0x00000000000000000000000000000000000f0011" } : l)) }))),
    "release to another pool": editRead(g, at(g, "release", T, (t) => ({ ...t, to: "0x00000000000000000000000000000000000f0011" }))),
    "release on another chain": editRead(g, at(g, "release", T, (t) => ({ ...t, chainId: "0x1" }))),
    "not withdraw()": editRead(g, at(g, "release", T, (t) => ({ ...t, input: "0x3edadd79" + t.input.slice(10) }))),
    "send from another address": editRead(g, at(g, "onward", T, (t) => ({ ...t, from: "0x00000000000000000000000000000000000000aa" }))),
    "send to another address": editRead(g, at(g, "onward", T, (t) => ({ ...t, to: "0x00000000000000000000000000000000000000aa" }))),
    "one wei short": editRead(g, at(g, "onward", T, (t) => ({ ...t, value: "0x" + (BigInt(t.value) - 1n).toString(16) }))),
    "one wei over": editRead(g, at(g, "onward", T, (t) => ({ ...t, value: "0x" + (BigInt(t.value) + 1n).toString(16) }))),
    "send with calldata": editRead(g, at(g, "onward", T, (t) => ({ ...t, input: "0xa9059cbb" }))),
    "send on another chain": editRead(g, at(g, "onward", T, (t) => ({ ...t, chainId: "0x1" }))),
    "release in another block": editRead(g, at(g, "release", R, (r) => ({ ...r, blockNumber: "0x1" }))),
    "send in another block": editRead(g, at(g, "onward", R, (r) => ({ ...r, blockNumber: "0x1" }))),
    "To is the pool": { ...g, withdraws: g.withdraws.map((w) => ({ ...w, to: "0xeb967dfc1b4ffb22942f833c76866ea85fc42266" })) },
    "another part": { ...g, withdraws: g.withdraws.map((w) => ({ ...w, part: (BigInt(w.part) + 1n).toString() })) },
    "not the pinned bundle": { ...g, page: { ...g.page, sha384: "sha384-other" } },
    "page not read": { ...g, page: undefined },
  };
  for (const [name, rec] of Object.entries(cases)) {
    const r = await run(rec);
    // a read one RPC answers null is that backend not holding it yet: a NOTE (never a pass), as the buy check reads it
    const silent = name.endsWith("on one RPC only");
    assert.ok(silent ? r.lines.some((l) => l.startsWith("NOTE")) && r.verdict !== "PASS" : extra(r).length > 0, `${name}: ${r.lines.join("\n")}`);
  }
});

test("a pool RPC with no answer is a NOTE, never a pass on its reads; a wrong answer beside it is still BAD", async () => {
  const quiet = editRead(A.robinhood, (x) => (!x.rpc.includes("publicnode") ? { ...x, answer: { noAnswer: `${new URL(x.rpc).host}: HTTP 429` } } : undefined));
  const q = await run(quiet);
  assert.deepEqual(extra(q), [], q.lines.join("\n"));
  assert.ok(q.lines.some((l) => l.startsWith("NOTE [robinhood-testnet")), "a NOTE for the silent RPC");
  // with every other line ok, the silent RPC alone leaves the verdict INCONCLUSIVE (verdictOf), never PASS
  assert.equal(judge({ ...q, lines: undefined, withdraws: [], reads: [], page: A.robinhood.page }).verdict, "FAIL", "no withdraw at all: FAIL");
  const both = editRead(quiet, at(A.robinhood, "onward", "eth_getTransactionReceipt", (rc) => ({ ...rc, status: "0x0" })));
  assert.ok(extra(await run(both)).length > 0);
});
