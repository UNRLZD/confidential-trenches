// node --test scripts/live-checks/wallet-mainnet-relayer-pins.test.mjs: the live check replays its recorded answers
// (wallet-mainnet-relayer-pins.answers.json; its _note says where and when each was read).
//   good: this branch's own SIGN_HOST build, with the helper and both RPCs read live: PASS.
//   bad: SIGN_HOST as served (release-95), both pins null in its bundle: FAIL.
//   bad_throwaway: a build pinning helper-mainnet-vault-env's Mac test relayer, whose chain reads alone would pass: FAIL.
// Planted on good: each fact broken FAILs, naming it. And the pins are read from this checkout's source, in the shape
// bind.ts and relay.ts write them. Planted on a world answering as good did: a read with no answer (a timeout, a 429, a
// 5xx) on both its tries is INCONCLUSIVE naming its host and path, and a wrong answer beside one still FAILs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { noAnswerHosts, reasonOf } from "../ci/live-rerun.mjs";
import { RETRY } from "./provider-answer.mjs";
import {
  bundle,
  FEE_RECIPIENT,
  HELPER,
  implicitKey,
  judge,
  judgeBundle,
  KEY,
  loadPins,
  loadWithdrawPins,
  PAIR,
  pinsOf,
  read,
  SIGN,
  THROWAWAY,
  verdictLines,
  withdrawPinsOf,
} from "./wallet-mainnet-relayer-pins.mjs";

const A = JSON.parse(readFileSync(new URL("./wallet-mainnet-relayer-pins.answers.json", import.meta.url), "utf8"));
const CARRY = "f874a24241077a92d78daebf0e20585b2b6c89f7da30b05a67fb1969f70388cc";
const RELAYER = "4519129d35447942d92ef046ffa52af0430fb06b95b59936d7173290a6972756";
const BAD_BUNDLE = [
  `BAD deposit: the bundle holds 0 frozen copies of the deposit pin ${CARRY}, not one`,
  `BAD withdraw: the bundle holds 0 frozen copies of the withdrawal pin ${RELAYER}, not one`,
];

test("recorded good: this branch's build carries both pins, the helper names each, each relayer holds its own one key on both RPCs: PASS", () => {
  const v = judge(A.good);
  assert.deepEqual(v.lines, []);
  assert.equal(v.ok, true);
  assert.deepEqual(A.good.bundle.pins, { deposit: CARRY, withdraw: { relayer_account: RELAYER, fee_recipient: FEE_RECIPIENT } });
  assert.equal(A.good.bundle.deposit, 1);
  assert.equal(A.good.bundle.withdraw, 1);
  for (const [a, id] of [[A.good.chain.deposit, CARRY], [A.good.chain.withdraw, RELAYER]])
    for (const r of a.view_access_key_list) assert.deepEqual(r.json.result.keys.map((k) => [k.public_key, k.access_key.permission]), [[implicitKey(id), "FullAccess"]]);
});

test("recorded bad: SIGN_HOST as served (release-95) carries neither pin, though every chain fact holds: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, BAD_BUNDLE);
});

test("recorded bad_throwaway: FAIL by the refusal and the helper's answer, though the account holds its own one key on both RPCs", () => {
  const v = judge(A.bad_throwaway);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [
    `BAD bundle: the bundle names the throwaway relayer ${THROWAWAY}`,
    "BAD withdraw: the helper's GET /v1/withdraw/fee for mainnet USDC answered 404, naming no relayer",
    `BAD withdraw: ${THROWAWAY} is the throwaway relayer of helper-mainnet-vault-env's Mac test run`,
  ]);
  // the chain rule alone would take it: one full-access key, its own, on both RPCs
  for (const r of A.bad_throwaway.chain.withdraw.view_access_key_list) assert.deepEqual(r.json.result.keys.map((k) => [k.public_key, k.access_key.permission]), [[implicitKey(THROWAWAY), "FullAccess"]]);
});

const written = () => structuredClone(A.good);

test("planted on good: each broken fact FAILs, naming it", () => {
  const bad = (f, re) => {
    const a = written();
    f(a);
    const v = judge(a);
    assert.equal(v.ok, false, String(re));
    assert.ok(v.lines.some((l) => re.test(l)), `${re}: ${v.lines.join(" | ")}`);
  };
  bad((a) => (a.bundle.withdraw = 0), /BAD withdraw: the bundle holds 0 frozen copies/);
  bad((a) => (a.bundle.deposit = 2), /BAD deposit: the bundle holds 2 frozen copies/);
  bad((a) => (a.bundle.sha384 = "sha384-x"), /BAD bundle: SIGN_HOST's served \/app.js is not the one index.html pins/);
  bad((a) => (a.chain.fee.body.fee_recipient = "f.near"), /BAD withdraw: the helper names .* not the pin's/);
  bad((a) => (a.chain.health.bind.mainnet = "ab".repeat(32)), /BAD deposit: the helper names .* not the pin/);
  bad((a) => (a.bundle.pins.withdraw.fee_recipient = a.chain.pins.withdraw.fee_recipient = a.chain.fee.body.fee_recipient = "other.near"), /BAD withdraw: the pin's fee recipient is other.near, not fees.unrlzd.near/);
  bad((a) => a.chain.withdraw.view_access_key_list[1].json.result.keys.push({ access_key: { nonce: 1, permission: "FullAccess" }, public_key: implicitKey(THROWAWAY) }), /holds 2 keys on https:\/\/near\.drpc\.org, not one/);
  bad((a) => (a.chain.withdraw.view_access_key_list[0].json.result.keys[0].access_key.permission = { FunctionCall: {} }), /is not its own full-access key/);
  bad((a) => (a.chain.withdraw.view_account[0] = { url: PAIR[0], status: 200, json: { error: { cause: { name: "UNKNOWN_ACCOUNT" } } } }), /does not exist on https:\/\/rpc\.mainnet\.fastnear\.com/);
  bad((a) => (a.chain.feeRecipient.storage_balance_of[1].json.result.result = [...Buffer.from("null")]), /not registered on mainnet USDC on https:\/\/near\.drpc\.org/);
  bad((a) => (a.chain.deposit.view_access_key_list[1].url = "https://rpc.mainnet.near.org"), /was not read on/);
  bad((a) => (a.chain.pins.withdraw.relayer_account = "ef".repeat(32)), /BAD bundle: the bundle and the chain were read for different pins/);
  bad((a) => {
    a.bundle.pins.withdraw.relayer_account = a.chain.pins.withdraw.relayer_account = a.chain.fee.body.relayer_account = CARRY;
    a.chain.withdraw = structuredClone(a.chain.deposit);
  }, /BAD withdraw: the withdrawal relayer is the deposit carry/);
});

test("the bundle part alone (what bundle-checks.mjs runs on a build) reads only the build's facts", () => {
  assert.deepEqual(judgeBundle(A.bad.bundle).lines, BAD_BUNDLE);
  assert.deepEqual(judgeBundle(A.good.bundle).lines, []);
  const nulls = structuredClone(A.bad.bundle);
  nulls.pins = { deposit: null, withdraw: null };
  assert.deepEqual(judgeBundle(nulls).lines, [
    "BAD deposit: the release names no mainnet deposit carry (bind.ts RELEASE_RELAYER.mainnet is null)",
    "BAD withdraw: the release names no mainnet withdrawal relayer (relay.ts RELEASE_WITHDRAW_RELAYER.mainnet is null)",
  ]);
  assert.equal(judgeBundle(undefined).ok, false);
});

test("the pins are this checkout's source: bind.ts's mainnet carry, relay.ts's mainnet relayer as written or null", () => {
  assert.deepEqual(loadPins(), { deposit: CARRY, withdraw: { relayer_account: RELAYER, fee_recipient: FEE_RECIPIENT } });
  const bind = 'export const RELEASE_RELAYER: Readonly<Record<NearNetwork, string | null>> = Object.freeze({\n  mainnet: "aa",\n  testnet: null,\n});';
  const relay = (mainnet) => `export const RELEASE_WITHDRAW_RELAYER: Readonly<Record<NearNetwork, HelperReleaseRelayer | null>> = Object.freeze({\n  mainnet: ${mainnet},\n  testnet: POOL_TESTNET ? x : null,\n});`;
  const pair = 'Object.freeze({\n    relayer_account: "r", // gitleaks:allow (a public account id)\n    fee_recipient: "fees.unrlzd.near", // gitleaks:allow (a public account id)\n  })';
  assert.deepEqual(pinsOf(bind, relay(pair)), { deposit: "aa", withdraw: { relayer_account: "r", fee_recipient: "fees.unrlzd.near" } });
  assert.deepEqual(pinsOf(bind.replace('"aa"', "null"), relay("null")), { deposit: null, withdraw: null });
  assert.throws(() => pinsOf(bind.replace('"aa"', "CARRY"), relay("null")), /RELEASE_RELAYER's mainnet pin is not null or one string/);
  assert.throws(() => pinsOf(bind, relay("PAIR")), /RELEASE_WITHDRAW_RELAYER's mainnet pin is not null/);
  // both networks' withdrawal pairs (what relayer-withdraw-fee holds the helper to)
  assert.deepEqual(loadWithdrawPins().mainnet, loadPins().withdraw);
  assert.equal(loadWithdrawPins().testnet.fee_recipient, "f-2b700409.bf-vt-20261102t071444.testnet"); // gitleaks:allow (a public account id)
  const tn = (t) => `export const RELEASE_WITHDRAW_RELAYER: Readonly<Record<NearNetwork, HelperReleaseRelayer | null>> = Object.freeze({\n  mainnet: ${pair},\n  testnet: ${t},\n});`;
  const tPair = `POOL_TESTNET\n    ? ${pair.replace('"r"', '"t"')}\n    : null`;
  assert.deepEqual(withdrawPinsOf(tn(tPair)), { mainnet: { relayer_account: "r", fee_recipient: "fees.unrlzd.near" }, testnet: { relayer_account: "t", fee_recipient: "fees.unrlzd.near" } });
  assert.deepEqual(withdrawPinsOf(tn("null")).testnet, null);
  assert.throws(() => withdrawPinsOf(tn("TESTNET_PAIR")), /testnet pin is not null/);
});

// ---------- a read that gets no answer (card relayer-pins-check-names-a-slow-read) ----------
// Live sign run 44651083107 (20 Nov 01:06Z) ended `ERROR wallet-mainnet-relayer-pins: The operation was aborted due to
// timeout`, exit 2, naming no read: one of SIGN_HOST's two GETs met its 15 s bound and the throw ended the run. Now each
// read gets a second try inside its bound, a read still unanswered is named by host and path, and the run ends
// INCONCLUSIVE (exit 3, which live-rerun runs again), never ERROR and never a BAD line for that read.

const TIMEOUT = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const bodyOf = (init) => JSON.parse(init.body).params;
/** A world that answers every read as the recorded good run did: SIGN_HOST's index and a script carrying both pins, the
 *  helper's two answers, and each RPC read from A.good.chain. `plant(url, init, n)` answers first when it returns
 *  something (n counts that URL's asks); a function it returns is thrown. */
function world(plant = () => undefined) {
  const js = `const a=Object.freeze({mainnet:"${CARRY}",testnet:null});const b=Object.freeze({mainnet:Object.freeze({relayer_account:"${RELAYER}",fee_recipient:"${FEE_RECIPIENT}"}),testnet:null});`;
  const index = A.good.bundle.index.replace(/integrity="[^"]+"/, `integrity="sha384-${createHash("sha384").update(js).digest("base64")}"`);
  const asks = new Map();
  const g = A.good.chain;
  const rpc = (url, p) => {
    const i = PAIR.indexOf(url);
    if (p.request_type === "call_function") return g.feeRecipient.storage_balance_of[i];
    const a = p.account_id === CARRY ? g.deposit : g.withdraw;
    return a[p.request_type][i];
  };
  const f = async (input, init = {}) => {
    const url = String(input);
    const key = init.body ? `${url} ${bodyOf(init).request_type} ${bodyOf(init).account_id}` : url;
    const n = (asks.get(key) ?? 0) + 1;
    asks.set(key, n);
    const planted = plant(url, init, n);
    if (typeof planted === "function") throw planted();
    if (planted) return planted;
    if (url === `${SIGN}/`) return new Response(index, { status: 200 });
    if (url === `${SIGN}/app.js`) return new Response(js, { status: 200 });
    if (url === `${HELPER}/v1/health`) return Response.json({ bind: g.health.bind }, { headers: { "x-helper-commit": g.health.commit } });
    if (url.startsWith(`${HELPER}/v1/withdraw/fee?token=`)) return Response.json(g.fee.body, { headers: { "x-helper-commit": g.fee.commit } });
    if (PAIR.includes(url)) return Response.json(rpc(url, bodyOf(init)).json);
    throw new Error(`the world has no ${url}`);
  };
  f.asks = asks;
  return f;
}

test("a world answering as the recorded good run did: read() PASSes, each read asked once", async () => {
  RETRY.ms = 0;
  const f = world();
  const v = judge(await read(f));
  assert.deepEqual([v.verdict, v.lines, v.misses], ["PASS", [], []]);
  assert.equal(v.ok, true);
  assert.ok([...f.asks.values()].every((n) => n === 1));
});

test("planted: SIGN_HOST's /app.js times out on both tries: INCONCLUSIVE naming its host and path, no BAD line, never thrown", async () => {
  RETRY.ms = 0;
  const f = world((url) => (url === `${SIGN}/app.js` ? TIMEOUT : undefined));
  const v = judge(await read(f));
  assert.equal(v.verdict, "INCONCLUSIVE");
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, []);
  assert.equal(v.misses.length, 1);
  assert.match(v.misses[0], /^confidential\.unrealized\.trade: no answer \(GET \/app\.js: TimeoutError after \d+\.\d s, on its second try\)$/);
  assert.equal(f.asks.get(`${SIGN}/app.js`), 2, "read again once inside its bound");
  // what live-rerun reads from the run's output: the host that did not answer, and the line that says why
  const out = verdictLines(v).join("\n");
  assert.deepEqual(noAnswerHosts(out), ["confidential.unrealized.trade"]);
  assert.match(reasonOf(KEY, out), /GET \/app\.js/);
});

test("planted: a body that times out mid-read (SIGN_HOST's /) is the same no-answer", async () => {
  RETRY.ms = 0;
  const stall = () => new Response(new ReadableStream({ pull: (c) => c.error(TIMEOUT()) }), { status: 200 });
  const v = judge(await read(world((url) => (url === `${SIGN}/` ? stall() : undefined))));
  assert.equal(v.verdict, "INCONCLUSIVE");
  assert.match(v.misses.join(" | "), /confidential\.unrealized\.trade: no answer \(GET \/: TimeoutError/);
});

test("planted: a read that times out once and answers on its second try PASSes", async () => {
  RETRY.ms = 0;
  const f = world((url, _i, n) => (n === 1 && (url === `${SIGN}/app.js` || url === `${HELPER}/v1/health` || url === PAIR[1]) ? TIMEOUT : undefined));
  const v = judge(await read(f));
  assert.deepEqual([v.verdict, v.lines, v.misses], ["PASS", [], []]);
});

test("planted: the helper's /v1/health and /v1/withdraw/fee get no answer (a timeout, a 503): INCONCLUSIVE naming each, not 'answered 0'", async () => {
  RETRY.ms = 0;
  const f = world((url) => (url === `${HELPER}/v1/health` ? TIMEOUT : url.startsWith(`${HELPER}/v1/withdraw/fee`) ? new Response("busy", { status: 503 }) : undefined));
  const v = judge(await read(f));
  assert.equal(v.verdict, "INCONCLUSIVE");
  assert.deepEqual(v.lines, []);
  assert.match(v.misses[0], /^ct-api\.unrealized\.trade: no answer \(GET \/v1\/health: TimeoutError after \d+\.\d s, on its second try\)$/);
  assert.equal(v.misses[1], "ct-api.unrealized.trade HTTP 503: GET /v1/withdraw/fee, on its second try");
  assert.deepEqual(noAnswerHosts(verdictLines(v).join("\n")), ["ct-api.unrealized.trade"]);
});

test("planted: one RPC times out on a key list and the other answers 429: INCONCLUSIVE naming each, not 'does not exist'", async () => {
  RETRY.ms = 0;
  const f = world((url, init) => {
    const p = init.body ? bodyOf(init) : {};
    if (url === PAIR[0] && p.request_type === "view_access_key_list" && p.account_id === RELAYER) return TIMEOUT;
    if (url === PAIR[1] && p.request_type === "view_account" && p.account_id === CARRY) return new Response("", { status: 429 });
    return undefined;
  });
  const v = judge(await read(f));
  assert.equal(v.verdict, "INCONCLUSIVE");
  assert.deepEqual(v.lines, []);
  assert.deepEqual(v.misses, [
    `near.drpc.org HTTP 429: 429 Too Many Requests (view_account of ${CARRY})`,
    `rpc.mainnet.fastnear.com: no answer (TimeoutError) (view_access_key_list of ${RELAYER})`,
  ]);
  assert.deepEqual(noAnswerHosts(verdictLines(v).join("\n")), ["near.drpc.org", "rpc.mainnet.fastnear.com"]);
});

test("planted: a wrong answer beside a read with no answer still FAILs, naming both", async () => {
  RETRY.ms = 0;
  const f = world((url) =>
    url === `${HELPER}/v1/health` ? Response.json({ bind: { mainnet: "ab".repeat(32) } }) : url === `${SIGN}/app.js` ? TIMEOUT : undefined,
  );
  const v = judge(await read(f));
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(v.lines, [`BAD deposit: the helper names ${"ab".repeat(32)} as its mainnet carry, not the pin ${CARRY}`]);
  assert.match(v.misses[0], /GET \/app\.js/);
});

test("the recorded answers keep their verdicts, and a no-answer in a record replays as INCONCLUSIVE, exit 3, through the check's own CLI", () => {
  assert.equal(judge(A.good).verdict, "PASS");
  assert.equal(judge(A.bad).verdict, "FAIL");
  assert.equal(judge(A.bad_throwaway).verdict, "FAIL");
  const a = written();
  a.chain.withdraw.view_access_key_list[0] = { url: PAIR[0], noAnswer: "rpc.mainnet.fastnear.com: no answer (TimeoutError)" };
  const dir = mkdtempSync(path.join(tmpdir(), "relayer-pins-"));
  const file = path.join(dir, "a.json");
  writeFileSync(file, JSON.stringify(a));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./wallet-mainnet-relayer-pins.mjs", import.meta.url)), "--answer", file], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), `INCONCLUSIVE ${KEY}: 1 read got no answer: rpc.mainnet.fastnear.com: no answer (TimeoutError) (view_access_key_list of ${RELAYER}); every read that answered holds: run again`);
  assert.deepEqual(noAnswerHosts(r.stdout), ["rpc.mainnet.fastnear.com"]);
});

test("the bundle part on a build (bundle-checks.mjs) never passes a read it did not get", async () => {
  RETRY.ms = 0;
  const v = await bundle(world((url) => (url === `${SIGN}/app.js` ? new Response("", { status: 502 }) : undefined)));
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ["-- confidential.unrealized.trade HTTP 502: GET /app.js, on its second try"]);
});

test("implicitKey is the key the server script prints for its account", () => {
  assert.equal(implicitKey(CARRY), "ed25519:HisG7d9D3eQBP8sDw3oLpJDrSrxiqTTgDh2Cwuxv8rEo");
  assert.equal(implicitKey("00".repeat(32)), `ed25519:${"1".repeat(32)}`);
});
