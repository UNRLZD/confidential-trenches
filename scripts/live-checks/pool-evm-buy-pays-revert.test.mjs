// Replays pool-evm-buy-pays-revert.answers.json through the card's live check. Until the owner's paste has run, the good
// answer is the mainnet rehearsal's (contracts/pool-evm/script/mainnet-rehearsal.sh on anvil forks of Base and Robinhood
// mainnet at this card's build, each fork read on two loopback names; its notes say so): it passes. The bad answer is
// the pool before this card, the code the Base Sepolia pool runs (eth_getCode of the 3 Nov testnet pool on a public
// RPC, recorded): it fails, on the build and on buySwap. A record missing, or the two RPCs answering different code,
// fails too.
//   node --test scripts/live-checks/pool-evm-buy-pays-revert.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check } from "./pool-evm-buy-pays-revert.mjs";
import { MAINNETS } from "./pool-evm-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-evm-buy-pays-revert.answers.json", import.meta.url), "utf8"));
function replay(answers) {
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const a = answers.find((x) => x.url === url && x.method === method && JSON.stringify(x.params) === JSON.stringify(params));
    if (!a) throw new Error(`no recorded answer for ${method} ${JSON.stringify(params).slice(0, 80)} on ${url}`);
    return { ok: a.status === 200, status: a.status, json: async () => a.json };
  };
}
const run = ({ answers = A.good, read = (c) => A.records[c] ?? null } = {}) =>
  check({ read, rpcsOf: (c) => A.rpcs[c], fetchFn: replay(answers), sleep: async () => {} });
const failed = (r) => r.lines.filter((l) => / FAIL /.test(l)).join("\n");

test("the recording covers both mainnets and says what it is", () => {
  assert.deepEqual(Object.keys(A.records), Object.keys(MAINNETS));
  assert.match(A.notes[0], /REHEARSAL/);
  assert.match(A.notes[1], /bad answer/);
});

test("the good answer passes: on both mainnets the pool is the reviewed build, the same on both RPCs, with buySwap", async () => {
  const r = await run();
  assert.equal(r.ok, true, failed(r));
  for (const c of Object.keys(MAINNETS)) {
    const pool = A.records[c].contracts.PrivacyPoolSimple.address;
    assert.ok(r.lines.includes(`${c}: PASS the pool ${pool} holds the same code on ${A.rpcs[c].join(" and ")}`), c);
    assert.ok(r.lines.some((l) => l.startsWith(`${c}: PASS the pool ${pool} is the reviewed build`)), c);
    assert.ok(r.lines.includes(`${c}: PASS the pool ${pool} dispatches buySwap (0x25faf2a3): a buy whose swap fails pays out`), c);
  }
});

test("the bad answer fails: the pool before this card (the Base Sepolia pool's code) is not the reviewed build and has no buySwap", async () => {
  const r = await run({ answers: A.bad });
  assert.equal(r.ok, false);
  for (const c of Object.keys(MAINNETS)) {
    assert.match(failed(r), new RegExp(`${c}: FAIL the pool 0x[0-9a-f]{40} is the reviewed build: length 9441`));
    assert.match(failed(r), new RegExp(`${c}: FAIL the pool 0x[0-9a-f]{40} dispatches buySwap`));
  }
});

test("no record (the paste has not run) fails on each mainnet", async () => {
  const r = await run({ read: () => null });
  assert.equal(r.ok, false);
  for (const c of Object.keys(MAINNETS)) assert.match(failed(r), new RegExp(`${c}: FAIL no record of the pool: the owner's paste has not run`));
});

test("the two RPCs answering different code fails", async () => {
  const c = Object.keys(MAINNETS)[0];
  const [, second] = A.rpcs[c];
  const answers = A.good.map((a) => (a.url === second && a.method === "eth_getCode" ? { ...a, json: { ...a.json, result: a.json.result.slice(0, -2) + (a.json.result.endsWith("00") ? "01" : "00") } } : a));
  const r = await run({ answers });
  assert.match(failed(r), new RegExp(`${c}: FAIL the pool 0x[0-9a-f]{40} holds the same code on`));
});
