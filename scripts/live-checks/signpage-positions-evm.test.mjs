// node --test scripts/live-checks/signpage-positions-evm.test.mjs: the live check replays recorded runs
// (signpage-positions-evm.answers.json). good: the card's Base Sepolia buy and sell read back on both pool RPCs, W
// holding none of the token after, and SIGN_HOST's build joining the EVM positions and carrying the EVM pass (the page
// part re-made from a mainnet build of card evm-pools-on-mainnet, which pins both EVM pools): PASS. bad: the same run's record naming U's deposit as the sell (a sale that never reached W), read with
// SIGN_HOST as it served before the card (no join): FAIL. Made from the good run: W still holding the token on one RPC, a reverted sell, a sell to another
// address, a Bought for another W, the sell in another block on one RPC, a sell before the buy, a page with no join, a
// mainnet page with no EVM pass, a bundle that is not the pinned one: each FAIL; an RPC with
// no answer: INCONCLUSIVE, never a pass. JOIN counts the state read's EVM join in the bare form before card
// move-sends-or-says-why (T1) and in T1's bounded form, and none when the join or base or robinhood is gone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RETRY } from "./provider-answer.mjs";
import { judge, pageFacts, read, runOf, SIGN } from "./signpage-positions-evm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
RETRY.ms = 0;
const A = JSON.parse(readFileSync(path.join(HERE, "signpage-positions-evm.answers.json"), "utf8"));
const RECORD = readFileSync(path.join(HERE, "signpage-positions-evm.md"), "utf8");

// a fetch that answers each call with the recorded read for it, after checking the check asked the right thing
const replay = (rec) => async (url, init) => {
  if (url.startsWith(SIGN)) return new Response("", { status: 200 }); // the page's facts are the recording's (rec.page)
  assert.equal(init.method, "POST");
  const body = JSON.parse(init.body);
  const of = body.method === "eth_call" ? `${rec.run.w} ${body.params[0].to}` : body.params[0];
  if (body.method === "eth_call") assert.equal(body.params[0].data, `0x70a08231${rec.run.w.slice(2).padStart(64, "0")}`, "balanceOf(W) only");
  const r = rec.reads.find((x) => x.rpc === url && x.method === body.method && x.of === of);
  assert.ok(r, `a recorded read for ${url} ${body.method}`);
  if (r.answer.noAnswer !== undefined) return new Response("", { status: 429 });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...r.answer }), { status: 200 });
};
const mdOf = (r) => `W: ${r.w}\nAsset: ${r.asset}\nBuy: base-sepolia ${r.buy}\nSell: base-sepolia ${r.sell}\n`;
const run = async (rec) => judge({ ...(await read(mdOf(rec.run), replay(rec))), page: rec.page });
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (rec, f) => ({ ...rec, reads: rec.reads.map((x) => f(x) ?? x) });
const result = (x, f) => ({ ...x, answer: { result: f(x.answer.result) } });
const on = (method, of, f, pub = true) => (x) => (x.method === method && x.of === of && (!pub || x.rpc.includes("publicnode")) ? result(x, f) : undefined);

test("the run record is the recorded good run's, and its buy and sell are Tx lines too", () => {
  assert.deepEqual(runOf(RECORD), A.good.run);
  for (const h of [A.good.run.buy, A.good.run.sell]) assert.ok(RECORD.includes(`Tx: base-sepolia ${h}\n`));
});

test("good: the buy and the sell on both pool RPCs, W holding none after: PASS", async () => {
  const r = await run(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
});

test("bad (recorded): U's deposit named as the sell, a sale that never reached W: FAIL", async () => {
  const r = await run(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => l.includes("the sell to W")), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => l.includes("joins each EVM chain")), r.lines.join("\n"));
});

test("made from the good run: each broken fact FAILs, and no answer is INCONCLUSIVE", async () => {
  const g = A.good;
  const { w, asset, buy, sell } = g.run;
  const cases = {
    "W still holds the token on one RPC": edit(g, on("eth_call", `${w} ${asset}`, () => `0x${"1".padStart(64, "0")}`)),
    "the sell reverted": edit(g, on("eth_getTransactionReceipt", sell, (rc) => ({ ...rc, status: "0x0" }))),
    "the sell went to another address": edit(g, on("eth_getTransactionByHash", sell, (tx) => ({ ...tx, to: `0x${"99".repeat(20)}` }))),
    "the Bought names another W": edit(g, on("eth_getTransactionReceipt", buy, (rc) => ({ ...rc, logs: rc.logs.map((l) => ({ ...l, topics: l.topics.map((t) => t.toLowerCase().replace(w.slice(2), "99".repeat(20))), data: String(l.data).toLowerCase().replaceAll(w.slice(2), "99".repeat(20)) })) }))),
    "the sell in another block on one RPC": edit(g, on("eth_getTransactionReceipt", sell, (rc) => ({ ...rc, blockNumber: `0x${(BigInt(rc.blockNumber) + 1n).toString(16)}` }))),
    "the sell before the buy": edit(g, on("eth_getTransactionReceipt", sell, (rc) => ({ ...rc, blockNumber: "0x1" }), false)),
    "a page with no join": { ...g, page: { ...g.page, marks: { ...g.page.marks, join: 0 } } },
    "a mainnet page with no EVM pass": { ...g, page: { ...g.page, marks: { ...g.page.marks, pass: 0 } } },
    "a bundle that is not the pinned one": { ...g, page: { ...g.page, sha384: `sha384-${"A".repeat(64)}` } },
  };
  for (const [name, rec] of Object.entries(cases)) {
    const r = await run(rec);
    assert.equal(r.verdict, "FAIL", `${name}: ${r.lines.join("\n")}`);
  }
  const silent = { ...g, reads: g.reads.map((x) => (x.method === "eth_call" && x.rpc.includes("publicnode") ? { ...x, answer: { noAnswer: "HTTP 429" } } : x)) };
  assert.equal((await run(silent)).verdict, "INCONCLUSIVE");
});

// JOIN on the state read as each build minified it: before card move-sends-or-says-why (T1) each read bare; since T1
// each bounded by STATE_READ_MS (src/pool-testnet.ts `within(positions.read(), ...)`), as release 142 serves it.
const PRE_T1 = "positions:async()=>{let[e,...t]=await Promise.all([c.read(),...[`base`,`robinhood`].map(e=>Wt(e)?.read()??Promise.resolve([]))]);";
const PRE_T1_GUARD = "positions:async()=>{let e=et,n=Ut,[r,...i]=await Promise.all([Bt.read(),...[`base`,`robinhood`].map(e=>Wt(e)?.read()??Promise.resolve([]))]);";
const T1 = "positions:async()=>{let e=et,n=Ut,[r,...i]=await Promise.all([Tz(Bt.read(),r5,`solana's positions`).catch(()=>null),...[`base`,`robinhood`].map(e=>Tz(Wt(e)?.read()??Promise.resolve([]),r5,`${e}'s positions`).catch(()=>[]))]);";
const joins = (js) => pageFacts("", js).marks.join;

test("JOIN: the bare reads before T1 and T1's bounded reads each count once", () => {
  for (const [name, js] of Object.entries({ PRE_T1, PRE_T1_GUARD, T1 })) assert.equal(joins(js), 1, name);
});

test("JOIN: a build with the EVM join gone, or base or robinhood dropped from the map, counts none", () => {
  const cases = {
    "Solana's read alone (T1)": "positions:async()=>{let e=et,n=Ut,[r]=await Promise.all([Tz(Bt.read(),r5,`solana's positions`).catch(()=>null)]);",
    "no Promise.all (T1)": "positions:async()=>{let r=await Tz(Bt.read(),r5,`solana's positions`).catch(()=>null);",
    "base dropped (T1)": T1.replace("`base`,", ""),
    "robinhood dropped (T1)": T1.replace(",`robinhood`", ""),
    "base dropped (pre-T1)": PRE_T1.replace("`base`,", ""),
    "robinhood dropped (pre-T1)": PRE_T1.replace(",`robinhood`", ""),
    "another chain's name in the bound (T1)": T1.replace("`solana's positions`", "`base's positions`"),
  };
  for (const [name, js] of Object.entries(cases)) assert.equal(joins(js), 0, name);
});
