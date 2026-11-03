// Replays pool-sol-deploy.answers.json through the live check: the recorded good answer (the dry run on a local
// validator, read on two loopback URLs) passes; the same recording with one thing changed fails: an upgrade authority
// set, other code bytes, bytes after the code, a program the loader does not own, a missing pool, a mark that
// disagrees with its leaves, a mark without the program's tag, a leaf that disagrees with its mark, a funder holding a
// lamport, and RPCs that are not two devnet operators.
//   node --test scripts/live-checks/pool-sol-deploy.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check, operatorProblems, preMarkAddress, pageAddress, RPCS, DEVNET_GENESIS } from "./pool-sol-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-sol-deploy.answers.json", import.meta.url), "utf8"));
const D = A.deployment;

// answers served in recorded order by (url, method, params)
function replay(answers) {
  const used = new Set();
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const i = answers.findIndex((a, j) => !used.has(j) && a.url === url && a.method === method && JSON.stringify(a.params) === JSON.stringify(params));
    if (i < 0) throw new Error(`no recorded answer for ${method} ${JSON.stringify(params).slice(0, 80)} on ${url}`);
    used.add(i);
    const a = answers[i];
    return { ok: a.status === 200, status: a.status, json: async () => a.json };
  };
}
const run = (answers, deployment = D, rpcs = A.rpcs) => check({ deployment, fetchFn: replay(answers), rpcs, sleep: async () => {} });
// the recording with every getAccountInfo answer for `addr` changed by `f(data bytes, value)`
function mutate(addr, f) {
  const out = structuredClone(A.good);
  for (const a of out) {
    if (a.method !== "getAccountInfo" || a.params[0] !== addr) continue;
    const v = a.json.result.value;
    if (!v) continue;
    const data = Buffer.from(v.data[0], "base64");
    const r = f(data, v);
    if (r === null) a.json.result.value = null;
    else v.data[0] = data.toString("base64");
  }
  return out;
}
const fails = (r, re) => {
  assert.equal(r.ok, false);
  assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), re);
};
const mark = preMarkAddress(D.program_id, Buffer.from(D.deposit.precommitment, "hex")).address;

test("the recorded good answer passes, every line ok on both RPCs", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => / on http/.test(l)).length, 2 * (9 + 1 + D.funders.length));
  assert.ok(D.funders.length >= 1);
});

test("an upgrade authority set fails", async () => {
  fails(await run(mutate(D.programdata, (d) => (d[12] = 1, d.fill(7, 13, 45)))), /upgrade authority is none on \S+: [1-9A-HJ-NP-Za-km-z]{32,44}$/m);
});

test("other code bytes fail, and so do bytes after the code", async () => {
  fails(await run(mutate(D.programdata, (d) => (d[45 + 1000] ^= 1))), new RegExp(`code sha256 of ${D.so_len} bytes [0-9a-f]{64} equals the build's`));
  // the account grown by 3 bytes, the last one not 0: the code a later write could reach
  const extra = structuredClone(A.good);
  for (const a of extra) if (a.method === "getAccountInfo" && a.params[0] === D.programdata) {
    a.json.result.value.data[0] = Buffer.concat([Buffer.from(a.json.result.value.data[0], "base64"), Buffer.from([0, 0, 1])]).toString("base64");
  }
  fails(await run(extra), /3 bytes after it all 0: false/);
});

test("a program the upgradeable loader does not own, or not executable, fails", async () => {
  const owned = structuredClone(A.good);
  for (const a of owned) if (a.method === "getAccountInfo" && a.params[0] === D.program_id) a.json.result.value.owner = "BPFLoader2111111111111111111111111111111111";
  fails(await run(owned), /is an executable upgradeable-loader program/);
  const notExec = structuredClone(A.good);
  for (const a of notExec) if (a.method === "getAccountInfo" && a.params[0] === D.program_id) a.json.result.value.executable = false;
  fails(await run(notExec), /executable false/);
});

test("a missing pool fails", async () => {
  fails(await run(mutate(D.pool, () => null)), /pool \S+ is the program's.*: missing/);
});

test("a mark that disagrees with its leaves fails: another value, another nonce", async () => {
  fails(await run(mutate(mark, (d) => d.writeBigUInt64LE(20_000_000n, 0))), /mark \S+ reads value 20000000 nonce 1/);
  fails(await run(mutate(mark, (d) => d.writeBigUInt64LE(2n, 8))), /reads value 10000000 nonce 2/);
  fails(await run(mutate(mark, () => null)), /mark .*: missing/);
});

test("card pool-sol-mark-tag: a mark without the program's tag fails: its tag byte 0, or the 16-byte mark of a build before the tag", async () => {
  fails(await run(mutate(mark, (d) => (d[16] = 0))), /mark \S+ reads value 10000000 nonce 1 tag 0, the record's 10000000 and 1, tag 1/);
  const untagged = structuredClone(A.good);
  for (const a of untagged) if (a.method === "getAccountInfo" && a.params[0] === mark && a.json.result.value) {
    a.json.result.value.data[0] = Buffer.from(a.json.result.value.data[0], "base64").subarray(0, 16).toString("base64");
  }
  fails(await run(untagged), /mark \S+ reads value \? nonce \? tag \?, .* \(16 bytes\)/);
});

test("a leaf that disagrees with its mark fails: the state leaf, the label leaf", async () => {
  const state = pageAddress(D.program_id, 0, 0n).address;
  const label = pageAddress(D.program_id, 1, 0n).address;
  fails(await run(mutate(state, (d) => (d[16] ^= 1))), /state page 0 entry 0 holds the record's commitment/);
  fails(await run(mutate(label, (d) => (d[16 + 31] ^= 1))), /label page 0 entry 0 holds keccak256\(scope, nonce\) mod p/);
});

test("a devnet record needs devnet's genesis on two devnet operators", async () => {
  fails(await run(A.good, { ...D, cluster: "devnet" }), /genesis \S+ is devnet's/);
  assert.deepEqual(operatorProblems(RPCS, "devnet"), []);
  assert.match(operatorProblems(["https://api.devnet.solana.com", "https://api.devnet.solana.com"], "devnet")[0], /only 1 known devnet operator/);
  assert.match(operatorProblems(A.rpcs, "devnet")[0], /only 0 known devnet operator/);
  assert.match(operatorProblems(["https://api.devnet.solana.com", "http://127.0.0.1:8899"], "localnet")[0], /non-loopback/);
  assert.equal(DEVNET_GENESIS, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  fails(await run(A.good, { ...D, cluster: "mainnet" }), /cluster is devnet or localnet: mainnet/);
});

test("a funder holding one lamport fails, on either RPC; a record with no funder fails", async () => {
  for (const url of A.rpcs) {
    const out = structuredClone(A.good);
    for (const a of out) if (a.url === url && a.method === "getBalance" && a.params[0] === D.funders[0]) a.json.result.value = 1;
    fails(await run(out), new RegExp(`funder ${D.funders[0]} holds 0 lamports on ${url.replace(/[.[\]]/g, "\\$&")}: 1$`, "m"));
  }
  fails(await run(A.good, { ...D, funders: [], funder: undefined }), /names the run's funders: 0/);
});
