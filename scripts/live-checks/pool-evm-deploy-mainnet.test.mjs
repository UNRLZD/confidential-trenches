// Replays pool-evm-deploy-mainnet.answers.json through the card's live check. Until the owner's paste has run it is a
// REHEARSAL recording (its notes say so): the check on anvil forks of Base and Robinhood mainnet
// (contracts/pool-evm/script/mainnet-rehearsal.sh), each fork's record and the kit's venue given that record's
// contracts as its pins. The good answer passes; the same recording fails with the kit as it is (no mainnet pin yet),
// with one byte of a contract's code flipped on one RPC, and with a record missing or a dry run's; a dry run's record
// read on the mainnet RPCs fails. The recording predates FeeCollector in the mainnet set (card evm-mainnet-senders), and
// the rehearsal's next run needs the kit's mainnet sell sender pins: until it is re-recorded, each chain's recording
// gains a CONSTRUCTED fee collector (withCollector below).
//   node --test scripts/live-checks/pool-evm-deploy-mainnet.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { check as pinCheck, recordOf } from "./evm-venues-pin.mjs";
import { checkMainnets, mainnetRunRecord } from "./pool-evm-deploy-mainnet.mjs";
import { BUILD, EIP1967, MAINNETS, selector } from "./pool-evm-deploy.mjs";

const R = JSON.parse(readFileSync(new URL("./pool-evm-deploy-mainnet.answers.json", import.meta.url), "utf8"));
// the constructed collectors' sink: a made-up sell sender pin (the kit pins none on a mainnet yet)
const PIN = "0x5151515151515151515151515151515151515151";
/**
 * The rehearsal recording with a CONSTRUCTED FeeCollector on each chain, nothing else changed: its record entry (the
 * sink PIN) and deploy transaction, the kit venue's sellSender PIN, and on both RPCs the answers a collector built with
 * that sink gives (Base Sepolia's collector code as read on chain, evm-fee-collector.answers.json, its sink word
 * rewritten; the slots 0; owner() reverting; the deploy's receipt), the sink's empty code and the run key's nonce one
 * more. Replaced by a real recording once the rehearsal runs with the kit's pins.
 */
function withCollector(rec) {
  const a = JSON.parse(JSON.stringify(rec));
  const fc = JSON.parse(readFileSync(new URL("./evm-fee-collector.answers.json", import.meta.url), "utf8"));
  const seen = fc.deployments["base-sepolia"].contracts.FeeCollector.address.toLowerCase();
  const code0 = fc.good["base-sepolia"].find((x) => x.method === "eth_getCode" && x.params[0].toLowerCase() === seen).json.result;
  const at = 2 + 2 * BUILD.contracts.FeeCollector.immutables[0][0];
  const code = code0.slice(0, at) + PIN.slice(2).padStart(64, "0") + code0.slice(at + 64);
  const ok = (result) => ({ jsonrpc: "2.0", id: 1, result });
  for (const [i, c] of Object.keys(MAINNETS).entries()) {
    const d = a.records[c];
    const address = "0x" + "fc".repeat(19) + String(i + 1).padStart(2, "0");
    const hash = "0x" + "fc".repeat(31) + String(i + 1).padStart(2, "0");
    const deployer = d.deployer.toLowerCase();
    d.contracts.FeeCollector = { address, sink: PIN };
    d.txs.splice(d.txs.findIndex((t) => !t.contract), 0, { step: "deploy FeeCollector", hash, contract: "FeeCollector" });
    a.pins[c] = { ...a.pins[c], sellSender: PIN };
    for (const x of a.good) if (x.method === "eth_getTransactionCount" && x.params[0].toLowerCase() === deployer) x.json.result = "0x" + (BigInt(x.json.result) + 1n).toString(16);
    for (const url of a.rpcs[c]) {
      const add = (method, params, json) => a.good.push({ url, method, params, status: 200, json });
      add("eth_getCode", [PIN, "latest"], ok("0x"));
      add("eth_getCode", [address, "latest"], ok(code));
      for (const s of Object.values(EIP1967)) add("eth_getStorageAt", [address, s, "latest"], ok("0x" + "00".repeat(32)));
      add("eth_call", [{ to: address, data: selector("owner()") }, "latest"], { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: "0x" } });
      add("eth_getTransactionReceipt", [hash], ok({ status: "0x1", from: deployer, contractAddress: address }));
    }
  }
  return a;
}
const A = withCollector(R);
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
  for (const c of Object.keys(MAINNETS)) assert.deepEqual(Object.keys(A.records[c].contracts), MAINNETS[c].contracts, `${c}: the recording and its constructed collector name the mainnet set`);
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

test("a constructed collector whose sink is not the kit's sell sender pin fails, and so does the kit with no pin", async () => {
  const other = Object.fromEntries(Object.entries(pinned).map(([c, v]) => [c, { ...v, sellSender: "0x6262626262626262626262626262626262626262" }]));
  fails(await run({ venues: other }), /base: deploy FAIL the record's FeeCollector sink 0x(51){20} is the sell sender the kit pins on base: 0x(62){20}/);
  const none = Object.fromEntries(Object.entries(pinned).map(([c, v]) => [c, { ...v, sellSender: undefined }]));
  fails(await run({ venues: none }), /robinhood: deploy FAIL FeeCollector's immutable holds one word, the sell sender the kit pins on robinhood \(none\)/);
});
