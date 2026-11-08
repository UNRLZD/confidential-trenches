// node --test scripts/live-checks/intents-u-registered-first.test.mjs: the live check replays its recorded answers
// (intents-u-registered-first.answers.json). good: this card's build, whose signing page signs no intent of a deposit
// id U until storage_balance_of(U) on USDC reads registered on both RPCs: PASS. bad: SIGN_HOST as served before the
// card (main 2f62a05c's build): FAIL, every mark named. Planted on the good one: another /app.js, no pin, each mark
// taken away: each FAIL; and planted bundles with each mark's line changed so the gate no longer holds: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MARKS } from "./intents-u-registered-first.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./intents-u-registered-first.answers.json", import.meta.url), "utf8"));
const ALL = Object.keys(MARKS).map((k) => `BAD the served bundle has no ${k}`);
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer (SIGN_HOST before the card, main 2f62a05c's build): FAIL, every mark named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, usdc: false }).lines, ["BAD the served bundle does not name mainnet's USDC"]);
  for (const [i, k] of Object.keys(MARKS).entries()) assert.deepEqual(judge({ ...g, carries: { ...g.carries, [k]: false } }).lines, [ALL[i]]);
  assert.equal(judge(null).ok, false);
});

// The minified lines as the good build spells them (packages/signpage/public/app.js), each changed so its rule no
// longer holds.
const JS = [
  "let o=Kk([a[0].held,a[1].held],qk,`held`);if(n.role===`U`&&(a[0].registered!==!0||a[1].registered!==!0))return Z(`unregistered`);let s=a[0].blockTimeNs/1000000n",
  "VO(i,e,`current_salt`,{},c),n===null?Promise.resolve(null):VO(i,e,`is_nonce_used`,{account_id:t,nonce:n},c),VO(i,a,`storage_balance_of`,{account_id:t},c)]);if(o===null||typeof s!=`string`||!EO.test(s)||typeof l!=`string`||!/^[0-9a-f]{8}$/.test(l)||n!==null&&typeof u!=`boolean`)return null;let f=d;return f!==null&&(typeof f!=`object`||Array.isArray(f)||typeof f.total!=`string`||!EO.test(f.total))?null:{timeNs:o.timeNs,held:BigInt(s),salt:l,used:u,registered:f!==null}",
  "reads:[{blockTimeNs:l.timeNs,held:l.held,registered:l.registered},{blockTimeNs:u.timeNs,held:u.held,registered:u.registered}],held:l.held",
  "let n=t.now??Date.now,[r,i]=e.reads;if(r.held!==i.held||r.held<=0n)return{kind:`refused`,why:`held`};if(r.registered!==!0||i.registered!==!0)return{kind:`refused`,why:`unregistered`};let a=r.held;",
  "refund:NA({read:(e,t)=>HO(`intents.near`,e.refund_id,t,e.origin,d(),q.mainnet.usdc),floor:async e=>LD(n,r,e.u)",
].join(";");
const INDEX = (js) => `<script type="module" src="/app.js" integrity="${facts("", js).sha384}"></script>`;
const check = (js) => {
  const served = `${js};"${USDC}"`;
  return judge(facts(INDEX(served), served));
};

test("planted bundles: the good lines PASS; each line changed so the gate no longer holds FAILs on its own mark", () => {
  assert.deepEqual(check(JS).lines, []);
  const planted = [
    // the rule gates only one RPC's read, or every role but U, or passes on a null
    [0, JS.replace("||a[1].registered!==!0", "")],
    [0, JS.replace("n.role===`U`&&", "n.role===`V`&&")],
    [0, JS.replace("a[0].registered!==!0||a[1].registered!==!0", "a[0].registered===!1&&a[1].registered===!1")],
    // the read takes the registration from another block, or reads it on intents.near, or takes any answer as registered
    [1, JS.replace("VO(i,a,`storage_balance_of`,{account_id:t},c)", "VO(i,a,`storage_balance_of`,{account_id:t},`final`)")],
    [1, JS.replace("VO(i,a,`storage_balance_of`", "VO(i,e,`storage_balance_of`")],
    [1, JS.replace("registered:f!==null}", "registered:!0}")],
    [1, JS.replace("typeof f.total!=`string`||!EO.test(f.total)", "!1")],
    // one RPC's registration copied to both
    [2, JS.replace("registered:u.registered}]", "registered:l.registered}]")],
    // the refund move quotes while unregistered, or on one RPC's word
    [3, JS.replace("if(r.registered!==!0||i.registered!==!0)return{kind:`refused`,why:`unregistered`};", "")],
    [3, JS.replace("r.registered!==!0||i.registered!==!0", "r.registered!==!0")],
    // the pool refund carry reads registration on another token
    [4, JS.replace("d(),q.mainnet.usdc)", "d(),q.testnet.usdc)")],
  ];
  for (const [i, js] of planted) {
    assert.notEqual(js, JS, `planted ${i} changed nothing`);
    assert.deepEqual(check(js).lines, [ALL[i]], `planted ${i}`);
  }
});

// ---- the mainnet run's read-back (intents-u-registered-first-run.mjs): the owner's run, not made yet, so its answers
// here are built in the RPC's own shape (EXPERIMENTAL_tx_status, call_function's storage_balance_of), not recorded ----
const R = await import("./intents-u-registered-first-run.mjs");
const U = "0fddd0bfdaa562c5cc85461d6d8f33b344d054d48490c5dac1ffe17ad178dd22";
const RUN = { u: U, reg: "9EhDqfwUH1ZmDmrSS2d2d7sHtoefquSaBBVaGmGJj4Rv", intent: "6fb2C7emjPC3zruNHm3maqTifGjQYwFWaazHKz9N6J5w", relayer: "bind.confidential.unrlzd.near" };
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64");
const status = (receiver, method, args, ok = true) => ({
  status: ok ? { SuccessValue: "" } : { Failure: {} },
  transaction: { signer_id: RUN.relayer, receiver_id: receiver, actions: [{ FunctionCall: { method_name: method, args: b64(args), gas: 1, deposit: "0" } }] },
  transaction_outcome: { block_hash: "h", outcome: { status: { SuccessReceiptId: "r" } } },
  receipts_outcome: [{ outcome: { status: ok ? { SuccessValue: "" } : { Failure: {} } } }],
});
const REG = status(R.USDC, "storage_deposit", { account_id: U, registration_only: true });
const payload = JSON.stringify({ signer_id: U, verifying_contract: "intents.near", deadline: "2026-11-09T02:00:00.000Z", nonce: "x", intents: [] });
const INTENT = status(R.INTENTS, "execute_intents", { signed: [{ standard: "raw_ed25519", payload, public_key: "ed25519:1", signature: "ed25519:1" }] });
const BAL = { total: "1250000000000000000000", available: "0" };
const GOOD_RUN = { reg: [REG, REG], intent: [INTENT, INTENT], heights: { reg: 100, intent: 105 }, before: { reg: [null, null], intent: [BAL, BAL] } };

test("mainnet run read-back: a fresh U registered by the relayer before its intent: PASS; each planted fault FAILs", () => {
  assert.deepEqual(R.judge(RUN, GOOD_RUN).lines, []);
  const planted = [
    ["intent before registration", { ...GOOD_RUN, heights: { reg: 105, intent: 100 } }, "BAD the registration's block is not before the intent's"],
    ["U unregistered before its intent", { ...GOOD_RUN, before: { ...GOOD_RUN.before, intent: [null, null] } }, "BAD storage_balance_of(U) not registered on both RPCs before its intent"],
    ["one RPC says null before the intent", { ...GOOD_RUN, before: { ...GOOD_RUN.before, intent: [BAL, null] } }, "BAD storage_balance_of(U) not registered on both RPCs before its intent"],
    ["U registered before (not fresh)", { ...GOOD_RUN, before: { ...GOOD_RUN.before, reg: [BAL, BAL] } }, "BAD U was not fresh: storage_balance_of(U) not null on both RPCs before its registration"],
    ["another account registered", { ...GOOD_RUN, reg: [status(R.USDC, "storage_deposit", { account_id: "b".repeat(64), registration_only: true }), status(R.USDC, "storage_deposit", { account_id: "b".repeat(64), registration_only: true })] }, "BAD the reg tx does not register exactly U, registration_only"],
    ["registration failed", { ...GOOD_RUN, reg: [status(R.USDC, "storage_deposit", { account_id: U, registration_only: true }, false), status(R.USDC, "storage_deposit", { account_id: U, registration_only: true }, false)] }, "BAD the reg tx did not succeed in every receipt"],
    ["the RPCs disagree", { ...GOOD_RUN, intent: [INTENT, REG] }, "BAD the intent tx does not read alike on both RPCs"],
  ];
  for (const [name, a, line] of planted) assert.deepEqual(R.judge(RUN, a).lines, [line], name);
  assert.throws(() => R.argsOf({ ...RUN, u: "alice.near" }));
  assert.throws(() => R.argsOf({ ...RUN, intent: RUN.reg }));
  assert.match(R.record(RUN), /^CARD intents-u-registered-first \/ mainnet run: PASS\nMoney path: yes\nTx: near 9EhD\S+ bind\.confidential\.unrlzd\.near\nTx: near 6fb2\S+ bind\.confidential\.unrlzd\.near\n/);
});
