// Replays sol-pool-venue-tables.answers.json through the sol-pool-venue-tables live check, with no network. The good
// answer (recorded live: the mainnet pump curve's generation 1, devnet's pump curve and PumpSwap generation 1; mainnet
// PumpSwap not deployed yet) passes and names the venue not deployed yet apart from the passes. Each recorded bad answer
// is one patch on it and fails on its own line: a table missing an address, a table with an authority, the two RPCs
// answering different bytes, a deactivated table, and a table and record that agree but differ from the kit's list.
// Planted here: a pinned table with no record row, a generation's tx that failed, a tree past 80 percent of the newest
// pinned generation, a record generation past the pins (the named state "not pinned yet"), a provider's no-answer
// (INCONCLUSIVE), and the pins as the wallet's source writes them.
//   node --test scripts/live-checks/sol-pool-venue-tables.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RPCS as MONEY_RPCS } from "../ci/money-gate.mjs";
import { b58decode } from "./pool-sol-deploy.mjs";
import { RETRY } from "./provider-answer.mjs";
import { checkTables, CLUSTERS, GROWS, parsePins, PINS_SOURCE, readRecord, TX_RPCS, VENUES } from "./sol-pool-venue-tables.mjs";

const A = JSON.parse(readFileSync(new URL("./sol-pool-venue-tables.answers.json", import.meta.url), "utf8"));
const REC = A.records;
const PINS = A.pins;
const TABLE = REC.mainnet.tables["pump-curve"][0].table;
const [FIRST, SECOND] = CLUSTERS.mainnet.rpcs;
RETRY.ms = 0;

function replay(answers) {
  const used = new Set();
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const i = answers.findIndex((a, j) => !used.has(j) && a.url === url && a.method === method && JSON.stringify(a.params) === JSON.stringify(params));
    if (i < 0) throw new Error(`no recorded answer for ${method} ${JSON.stringify(params).slice(0, 80)} on ${url}`);
    used.add(i);
    const a = answers[i];
    return new Response(a.json === null ? "" : JSON.stringify(a.json), { status: a.status });
  };
}
const run = (answers = A.answers, records = REC, pins = PINS) => checkTables({ records, pins, fetchFn: replay(answers) });
const failLines = (r) => r.lines.filter((l) => l.startsWith("FAIL")).join("\n");
const nowhere = async () => {
  throw new Error("no read");
};

/** The good answers and records with one recorded bad answer's patch applied to the mainnet curve table's bytes on its
 * RPC(s); a `swap` puts another address at one entry of the record's list as well, so the table and the record agree. */
function patched(bad) {
  const answers = structuredClone(A.answers);
  const records = structuredClone(REC);
  if (bad.swap) records.mainnet.tables["pump-curve"][0].addresses[bad.swap.index] = bad.swap.with;
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

test("the good answer passes: three deployed generations ok on both RPCs, mainnet PumpSwap named not deployed yet", async () => {
  const r = await run();
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.summary, "PASS (3 deployed, 1 not deployed yet, 0 not pinned yet)");
  assert.deepEqual(r.lines.filter((l) => l.endsWith("not deployed yet")), ["mainnet pumpswap: not deployed yet"]);
  assert.ok(r.lines.every((l) => l.endsWith("not deployed yet") || l.startsWith("ok   ")), r.lines.join("\n"));
  for (const want of [/^ok   mainnet pump-curve g1: the table is active, authority none \(frozen\), and holds exactly the record's list \(25 addresses, in order\)$/m, /^ok   devnet pumpswap g1: the newest generation holds exactly the kit's list/m, /^ok   devnet pumpswap: the state tree at \d+ is under 80 percent of generation 1/m, /^ok   mainnet pump-curve g1: lookup table: freeze \(authority none\) \S+ reads back succeeded/m])
    assert.match(r.lines.join("\n"), want);
  // the curve has no tree alarm: it fits at any tree size (packages/kit/test/solana-pool-venue-tables.test.ts)
  assert.deepEqual(GROWS, ["pumpswap"]);
  assert.ok(!r.lines.some((l) => /pump-curve: the (state|label) tree/.test(l)));
  assert.deepEqual(VENUES, ["pump-curve", "pumpswap"]);
});

for (const bad of A.bad) {
  test(`recorded bad answer fails: ${bad.name}`, async () => {
    const p = patched(bad);
    const r = await run(p.answers, p.records);
    assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
    assert.match(failLines(r), new RegExp(bad.fails));
    assert.equal(r.summary, "FAIL (1 of 3 deployed failing, 1 not deployed yet, 0 not pinned yet)");
    assert.ok(r.lines.filter((l) => l.startsWith("FAIL")).every((l) => l.startsWith("FAIL mainnet pump-curve g1: ")), failLines(r));
  });
}

test("a pinned table with no record row fails: a generation past the record's, or a venue the record does not hold", async () => {
  const pins = structuredClone(PINS);
  pins.devnet.pumpswap = [...pins.devnet.pumpswap, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"];
  let r = await run(A.answers, REC, pins);
  assert.match(failLines(r), /^FAIL devnet pumpswap: pinned g2 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin is the record's generation 2: the record has no row$/m);
  const other = structuredClone(PINS);
  other.mainnet.pumpswap = ["9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"];
  r = await run(A.answers, REC, other);
  assert.match(failLines(r), /^FAIL mainnet pumpswap: pinned, with no record row$/m);
  // pins in another order than the record's generations fail too
  const swapped = structuredClone(PINS);
  swapped.devnet["pump-curve"] = [PINS.devnet.pumpswap[0]];
  assert.match(failLines(await run(A.answers, REC, swapped)), /FAIL devnet pump-curve: pinned g1 \S+ is the record's generation 1: the record has C2vL/);
});

test("a record generation past the pins is the named state not pinned yet, its table still judged", async () => {
  const pins = structuredClone(PINS);
  pins.devnet.pumpswap = [];
  const r = await run(A.answers, REC, pins);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.summary, "PASS (3 deployed, 1 not deployed yet, 1 not pinned yet)");
  assert.ok(r.lines.includes(`devnet pumpswap g1: deployed, not pinned yet (${REC.devnet.tables.pumpswap[0].table})`));
  assert.ok(r.lines.some((l) => l.startsWith("ok   devnet pumpswap g1: the table is active")));
  // no pinned generation: no tree alarm to judge
  assert.ok(!r.lines.some((l) => /devnet pumpswap: the state tree/.test(l)));
});

test("a generation's tx that failed, or that one reader does not hold, fails the row", async () => {
  const sig = REC.devnet.tables.pumpswap[0].txs[1].signature;
  for (const edit of [(a) => (a.json.result.meta.err = { InstructionError: [0, "Custom"] }), (a) => (a.json.result = null)]) {
    const answers = structuredClone(A.answers);
    const a = answers.find((x) => x.method === "getTransaction" && x.params[0] === sig && x.url === TX_RPCS.devnet[1] && x.json?.result);
    edit(a);
    assert.match(failLines(await run(answers)), new RegExp(`^FAIL devnet pumpswap g1: lookup table: extend with 4 addresses ${sig.slice(0, 12)}\\.\\.\\. reads back succeeded at finalized on .*: false$`, "m"));
  }
  // the readers are the money gate's own
  assert.deepEqual(TX_RPCS, { mainnet: MONEY_RPCS.solana, devnet: MONEY_RPCS["solana-devnet"] });
});

test("a tree past 80 percent of the newest pinned generation fails, naming the entries left", async () => {
  // devnet PumpSwap's generation 1 holds pages 0 and 1: it warns at 1,638 entries of each tree
  for (const [tree, at] of [["state", 49], ["label", 49 + 8 + 1 + 33 * 32]]) {
    const answers = structuredClone(A.answers);
    for (const a of answers)
      if (a.method === "getAccountInfo" && a.params[0] === REC.devnet.pool && a.url === CLUSTERS.devnet.rpcs[1] && a.json?.result) {
        const d = Buffer.from(a.json.result.value.data[0], "base64");
        d.writeBigUInt64LE(1638n, at);
        a.json.result.value.data[0] = d.toString("base64");
      }
    const r = await run(answers);
    assert.match(failLines(r), new RegExp(`^FAIL devnet pumpswap: the ${tree} tree at 1638 is past 80 percent of generation 1 \\(warns at 1638, ends at 2048\\): 410 entries left: make the next generation`, "m"));
    assert.equal(r.failed, 1);
  }
});

test("a provider's no-answer (a 429, an empty body) is INCONCLUSIVE on its own line, never a FAIL and never a PASS", async () => {
  for (const [status, json] of [[429, { jsonrpc: "2.0", id: 1, error: { code: 429, message: "Too many requests" } }], [200, null]]) {
    const answers = structuredClone(A.answers);
    for (const a of answers) if (a.url === SECOND && a.method === "getAccountInfo" && a.params[0] === TABLE) Object.assign(a, { status, json });
    answers.push(...answers.filter((a) => a.url === SECOND && a.method === "getAccountInfo" && a.params[0] === TABLE).map((a) => structuredClone(a)));
    const r = await run(answers);
    assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
    assert.equal(failLines(r), "");
    assert.match(r.lines.join("\n"), /^quiet mainnet pump-curve g1: a provider gave no answer, not judged/m);
    assert.equal(r.summary, "INCONCLUSIVE (1 of 3 deployed not answered by both providers, 1 not deployed yet, 0 not pinned yet)");
  }
});

test("neither pinned nor recorded is the named state, with no network read; a hostile record fails before any read", async () => {
  const none = { mainnet: { ...REC.mainnet, tables: {} }, devnet: null };
  const empty = { mainnet: {}, devnet: {} };
  const r = await checkTables({ records: none, pins: empty, fetchFn: nowhere });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines, ["mainnet pump-curve: not deployed yet", "mainnet pumpswap: not deployed yet", "devnet pump-curve: not deployed yet", "devnet pumpswap: not deployed yet"]);
  assert.equal(r.summary, "PASS (0 deployed, 4 not deployed yet, 0 not pinned yet)");
  // an inherited venue name is no record row
  assert.equal((await checkTables({ records: { mainnet: { cluster: "mainnet" }, devnet: { cluster: "devnet", tables: Object.create({ "pump-curve": [] }) } }, pins: empty, fetchFn: nowhere })).notDeployed, 4);
  const hostile = structuredClone(REC);
  hostile.mainnet.tables["pump-curve"] = { table: TABLE };
  assert.match(failLines(await checkTables({ records: hostile, pins: PINS, fetchFn: replay(A.answers) })), /FAIL mainnet pump-curve: the record's tables entry is not a list of generations/);
  const pages = structuredClone(REC);
  pages.devnet.tables.pumpswap[0].pages = { state: [3, 2], label: [0, 1] };
  assert.match(failLines(await run(A.answers, pages)), /FAIL devnet pumpswap g1: the record's pages are not two \[from, to\] page ranges/);
  const asDevnet = { mainnet: null, devnet: structuredClone(REC.mainnet) };
  assert.match(failLines(await checkTables({ records: asDevnet, pins: { mainnet: {}, devnet: { "pump-curve": [TABLE] } }, fetchFn: replay(A.answers) })), /^FAIL devnet pump-curve: the record's cluster is devnet: mainnet$/m);
});

test("the pins as the wallet's source writes them; a reshaped literal is an error, never an empty pass", () => {
  const src = readFileSync(PINS_SOURCE, "utf8");
  const pins = parsePins(src);
  assert.deepEqual(Object.keys(pins).sort(), ["devnet", "mainnet"]);
  assert.equal(pins.mainnet["pump-curve"][0], REC.mainnet.tables["pump-curve"][0].table);
  // the recorded pins are today's source's (re-record the good answer when a pin changes)
  assert.deepEqual(pins, PINS);
  assert.throws(() => parsePins(src.replace("export const SOL_POOL_TABLES", "export const SOL_TABLES")), /not found/);
  assert.throws(() => parsePins(src.replace(/\bdevnet: Object\.freeze\(\{/, "devnet: freeze({")), /no mainnet or no devnet/);
  assert.throws(() => parsePins(src.replace(/Object\.freeze\(\["(\w+)"\]\)/, "Object.freeze([X.table])")), /not a list of address literals/);
});

test("a missing record file is the named state; the committed records only name venues the kit builds, each a list", () => {
  assert.equal(readRecord("devnet", "/nonexistent-folder"), null);
  for (const c of ["mainnet", "devnet"]) for (const [v, gens] of Object.entries(readRecord(c)?.tables ?? {})) assert.ok(VENUES.includes(v) && Array.isArray(gens), `${c} ${v}`);
});
