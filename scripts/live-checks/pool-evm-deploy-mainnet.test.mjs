// Replays pool-evm-deploy-mainnet.answers.json through the card's live check. Until the owner's paste has run it is a
// REHEARSAL recording (its notes say so): the check on anvil forks of Base and Robinhood mainnet
// (contracts/pool-evm/script/mainnet-rehearsal.sh), each fork's record and the kit's venue given that record's
// contracts as its pins. The good answer passes; the same recording fails with the kit as it is (no mainnet pin yet),
// with one byte of a contract's code flipped on one RPC, and with a record missing or a dry run's; a dry run's record
// read on the mainnet RPCs fails.
//   node --test scripts/live-checks/pool-evm-deploy-mainnet.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { check as pinCheck, recordOf } from "./evm-venues-pin.mjs";
import { checkMainnets, mainnetRunRecord } from "./pool-evm-deploy-mainnet.mjs";
import { MAINNETS } from "./pool-evm-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-evm-deploy-mainnet.answers.json", import.meta.url), "utf8"));
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
const pinned = Object.fromEntries(Object.keys(A.pins).map((c) => [c, { ...evmPoolVenues()[c], ...A.pins[c] }]));
const run = ({ answers = A.good, venues = pinned, read = (c) => A.records[c] ?? null } = {}) =>
  checkMainnets({ read, venues, rpcsOf: (c) => A.rpcs[c], fetchFn: replay(answers), sleep: async () => {} });
const fails = (r, re) => {
  assert.equal(r.ok, false);
  assert.match(r.lines.filter((l) => / FAIL /.test(l)).join("\n"), re);
};

test("the recording covers both mainnets and says what it is", () => {
  assert.deepEqual(Object.keys(A.records), Object.keys(MAINNETS));
  assert.match(A.notes[0], /^A REHEARSAL recording: .*anvil forks of Base and Robinhood mainnet/);
});

test("the good answer passes: on both mainnets the record's check and the kit's pins pass on both RPCs", async () => {
  const r = await run();
  assert.equal(r.ok, true, r.lines.filter((l) => / FAIL /.test(l)).join("\n"));
  for (const c of Object.keys(MAINNETS)) {
    assert.ok(r.lines.includes(`${c}: PASS the deploy record's check on ${A.rpcs[c].join(" and ")}`), c);
    assert.ok(r.lines.includes(`${c}: PASS the kit's pins are the record's on ${A.rpcs[c].join(" and ")}`), c);
  }
});

test("the kit as it is, with no mainnet pin yet, fails on each pin", async () => {
  const r = await run({ venues: evmPoolVenues() });
  for (const c of Object.keys(MAINNETS)) fails(r, new RegExp(`${c}: kit pin FAIL the pool pin \\(none\\) is the record's PrivacyPoolSimple ${A.records[c].contracts.PrivacyPoolSimple.address}`));
});

test("one byte of the pool's code flipped on one RPC fails", async () => {
  const pool = A.records.base.contracts.PrivacyPoolSimple.address;
  const answers = structuredClone(A.good);
  let n = 0;
  for (const a of answers) {
    if (a.url === A.rpcs.base[1] && a.method === "eth_getCode" && a.params[0].toLowerCase() === pool.toLowerCase()) {
      const h = a.json.result;
      a.json.result = h.slice(0, 100) + (parseInt(h.slice(100, 102), 16) ^ 1).toString(16).padStart(2, "0") + h.slice(102);
      n++;
    }
  }
  assert.ok(n > 0);
  fails(await run({ answers }), /base: (deploy|kit pin) FAIL .*PrivacyPoolSimple|base: kit pin FAIL the pool .*same code on both RPCs/);
});

test("a missing record fails (today's mainnet), and a dry run's record is refused as a mainnet record", async () => {
  fails(await run({ read: (c) => (c === "base" ? null : A.records[c]) }), /base: FAIL no record: the owner's paste has not run: sh contracts\/pool-evm\/script\/mainnet-deploy\.sh base <address>/);
  const f = path.join(mkdtempSync(path.join(tmpdir(), "pedm-")), "robinhood.json");
  writeFileSync(f, JSON.stringify(A.records.robinhood));
  fails(await run({ read: (c) => (c === "robinhood" ? recordOf(c, f) : A.records[c]) }), /robinhood: FAIL .*robinhood\.json is not robinhood's real run/);
});

test("a dry run's record read on the mainnet RPCs fails: a fork's record is read on loopback only", async () => {
  const r = await pinCheck({ chain: "base", venue: pinned.base, deployment: A.records.base, rpcs: MAINNETS.base.rpcs, fetchFn: async () => { throw new Error("offline"); }, sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("FAIL a dry-run record read on a non-loopback RPC"), r.lines.join("\n"));
});

test("no payer is exempt: a recorded transaction sent by anyone but the run key fails, and so does the run key holding more than DUST", async () => {
  const hash = A.records.robinhood.txs[0].hash;
  const answers = structuredClone(A.good);
  let n = 0;
  for (const a of answers) if (a.method === "eth_getTransactionReceipt" && a.params[0] === hash) (a.json.result.from = "0x3333333333333333333333333333333333333333"), n++;
  assert.ok(n > 0);
  fails(await run({ answers }), new RegExp(`robinhood: deploy FAIL deploy WithdrawalVerifier ${hash} succeeded, from the deployer`));
  const key = A.records.base.deployer.toLowerCase();
  const rich = structuredClone(A.good);
  for (const a of rich) if (a.method === "eth_getBalance" && a.params[0].toLowerCase() === key) a.json.result = "0x" + (10n ** 13n + 1n).toString(16);
  fails(await run({ answers: rich }), /base: deploy FAIL deployer .* keeps at most 10000000000000 wei/);
});

test("the mainnets' run record (--write-record's, the money gate's) has Money path: yes and one Tx line per transaction of each record; a dry run's is refused", () => {
  const real = Object.fromEntries(Object.entries(A.records).map(([c, d]) => [c, { ...d, dryRun: false }]));
  const text = mainnetRunRecord(real);
  const lines = text.split("\n");
  assert.equal(lines[0], "CARD pool-evm-deploy-mainnet / live: PASS");
  assert.equal(lines[1], "Money path: yes");
  const tx = lines.filter((l) => l.startsWith("Tx: "));
  assert.deepEqual(tx, Object.keys(MAINNETS).flatMap((c) => real[c].txs.map((t) => `Tx: ${c} ${t.hash}`)));
  assert.throws(() => mainnetRunRecord(A.records), /a dry run/);
});

test("a 61 s throttle (every answer HTTP 429, as Robinhood's RPC gives) is waited out by the check the paste runs: the good answer still passes", async () => {
  let clock = 0;
  const inner = replay(A.good);
  const throttled = async (url, init) => (clock < 61_000 ? { ok: false, status: 429, json: async () => ({ code: 429, message: "Too Many Requests" }) } : inner(url, init));
  const r = await checkMainnets({ read: (c) => A.records[c], venues: pinned, rpcsOf: (c) => A.rpcs[c], fetchFn: throttled, sleep: async (ms) => void (clock += ms) });
  assert.equal(r.ok, true, r.lines.filter((l) => / FAIL /.test(l)).join("\n"));
});
