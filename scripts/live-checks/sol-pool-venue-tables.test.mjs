// Replays sol-pool-venue-tables.answers.json through the sol-pool-venue-tables live check, with no network. The good answer
// (recorded live on mainnet: the pump-curve table, frozen, 25 addresses; pumpswap and devnet not deployed yet) passes
// and names the venues not deployed yet apart from the passes. Each recorded bad answer is one patch on it and fails on its
// own line: a table missing an address, a table with an authority, the two RPCs answering different bytes, a deactivated
// table, and a table and record that agree but differ from the kit's list at a fixed entry. A venue absent in the record
// is the named state "not deployed yet", never a pass and never a failure.
//   node --test scripts/live-checks/sol-pool-venue-tables.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { b58decode } from "./pool-sol-deploy.mjs";
import { checkTables, CLUSTERS, readRecord, VENUES } from "./sol-pool-venue-tables.mjs";

const A = JSON.parse(readFileSync(new URL("./sol-pool-venue-tables.answers.json", import.meta.url), "utf8"));
const REC = A.records;
const TABLE = REC.mainnet.tables["pump-curve"].table;
const [FIRST, SECOND] = CLUSTERS.mainnet.rpcs;

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
const run = (answers = A.answers, records = REC) => checkTables({ records, fetchFn: replay(answers), sleep: async () => {} });
const failLines = (r) => r.lines.filter((l) => l.startsWith("FAIL")).join("\n");

/** The good answers and records with one recorded bad answer's patch applied to the table's bytes on its RPC(s); a `swap`
 * puts another address at one entry of the record's list as well, so the table and the record still agree. */
function patched(bad) {
  const answers = structuredClone(A.answers);
  const records = structuredClone(REC);
  if (bad.swap) records.mainnet.tables["pump-curve"].addresses[bad.swap.index] = bad.swap.with;
  const on = { both: [FIRST, SECOND], first: [FIRST], second: [SECOND] }[bad.url];
  for (const a of answers) {
    if (a.method !== "getAccountInfo" || a.params[0] !== TABLE || !on.includes(a.url)) continue;
    let d = Buffer.from(a.json.result.value.data[0], "base64");
    if (bad.hex) Buffer.from(bad.hex, "hex").copy(d, bad.at);
    if (bad.xor) d[bad.at] ^= bad.xor;
    if (bad.truncate) d = d.subarray(0, d.length - bad.truncate);
    if (bad.swap) Buffer.from(b58decode(bad.swap.with)).copy(d, 56 + 32 * bad.swap.index);
    a.json.result.value.data[0] = d.toString("base64");
  }
  return { answers, records };
}

test("the good answer passes: one deployed row, ok on both mainnet RPCs, the other three named not deployed yet", async () => {
  const r = await run();
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.summary, "PASS (1 deployed, 3 not deployed yet)");
  assert.deepEqual([r.deployed, r.failed, r.notDeployed], [1, 0, 3]);
  assert.deepEqual(r.lines.filter((l) => l.endsWith("not deployed yet")), ["mainnet pumpswap: not deployed yet", "devnet pump-curve: not deployed yet", "devnet pumpswap: not deployed yet"]);
  assert.ok(r.lines.every((l) => l.endsWith("not deployed yet") || l.startsWith("ok   mainnet pump-curve: ")), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /reads the same bytes at finalized on .*: true/.test(l)));
  assert.ok(r.lines.some((l) => /holds exactly the record's list \(25 addresses, in order\)/.test(l)));
  assert.ok(r.lines.some((l) => /holds exactly the kit's list for this program and pool \(25 addresses, in order\)/.test(l)));
  assert.deepEqual(VENUES, ["pump-curve", "pumpswap"]);
});

for (const bad of A.bad) {
  test(`recorded bad answer fails: ${bad.name}`, async () => {
    const p = patched(bad);
    const r = await run(p.answers, p.records);
    assert.equal(r.ok, false, r.lines.join("\n"));
    assert.match(failLines(r), new RegExp(bad.fails));
    assert.match(r.summary, /^FAIL \(1 of 1 deployed failing, 3 not deployed yet\)$/);
    assert.equal(r.lines.filter((l) => l.startsWith("FAIL")).every((l) => l.startsWith("FAIL mainnet pump-curve: ")), true);
  });
}

test("a venue absent in every record is the named state, counted apart: no pass row, no failure, no network read", async () => {
  const none = { mainnet: { ...REC.mainnet, tables: {} }, devnet: null };
  const r = await checkTables({ records: none, fetchFn: async () => { throw new Error("no network read for a state that is not deployed"); }, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines, ["mainnet pump-curve: not deployed yet", "mainnet pumpswap: not deployed yet", "devnet pump-curve: not deployed yet", "devnet pumpswap: not deployed yet"]);
  assert.equal(r.summary, "PASS (0 deployed, 4 not deployed yet)");
  assert.equal(r.lines.filter((l) => /^(ok|FAIL)/.test(l)).length, 0);
  // a record with no `tables` at all (the older shape) is the same state, as is a venue that is only an inherited name
  assert.equal((await checkTables({ records: { mainnet: { cluster: "mainnet" }, devnet: { cluster: "devnet", tables: Object.create({ "pump-curve": {} }) } }, fetchFn: async () => { throw new Error("no read"); }, sleep: async () => {} })).notDeployed, 4);
});

test("one venue absent beside a failing one: the failure still fails, the absent one is still named apart", async () => {
  const p = patched(A.bad[1]);
  const r = await run(p.answers, p.records);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("mainnet pumpswap: not deployed yet"));
  assert.equal(r.deployed, 1);
});

test("a deployed devnet venue is read on devnet's two operators and genesis; a record of another cluster, or a hostile one, fails before any read", async () => {
  const nowhere = async () => { throw new Error("no read"); };
  const mainnetRecordAsDevnet = { mainnet: null, devnet: structuredClone(REC.mainnet) };
  let r = await checkTables({ records: mainnetRecordAsDevnet, fetchFn: nowhere, sleep: async () => {} });
  assert.match(failLines(r), /FAIL devnet pump-curve: the record's cluster is devnet: mainnet/);
  assert.equal(r.summary, "FAIL (1 of 1 deployed failing, 3 not deployed yet)");
  const hostile = structuredClone(REC);
  hostile.mainnet.tables["pump-curve"].addresses = Array.from({ length: 257 }, () => REC.mainnet.pool);
  r = await checkTables({ records: hostile, fetchFn: nowhere, sleep: async () => {} });
  assert.match(failLines(r), /the record's addresses are not a list of 1 to 256 addresses/);
  const noTable = structuredClone(REC);
  noTable.mainnet.tables["pump-curve"].table = "not an address";
  assert.match(failLines(await checkTables({ records: noTable, fetchFn: nowhere, sleep: async () => {} })), /the record's table is not an address/);
  // devnet's pair is two operators of devnet, as pool-table-devnet.mjs reads
  assert.deepEqual(CLUSTERS.devnet.rpcs, ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"]);
});

test("an RPC answering another cluster's genesis fails the row", async () => {
  const answers = structuredClone(A.answers);
  for (const a of answers) if (a.method === "getGenesisHash" && a.url === SECOND) a.json.result = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  assert.match(failLines(await run(answers)), /genesis EtWTRABZaYq6 is mainnet's on https:\/\/solana-rpc.publicnode.com/);
});

test("a missing record file is the named state; the committed mainnet record, if it holds tables, only names venues the kit builds", () => {
  assert.equal(readRecord("devnet", "/nonexistent-folder"), null);
  const mainnet = readRecord("mainnet");
  for (const v of Object.keys(mainnet?.tables ?? {})) assert.ok(VENUES.includes(v), `${v} is not a venue the kit builds`);
});
