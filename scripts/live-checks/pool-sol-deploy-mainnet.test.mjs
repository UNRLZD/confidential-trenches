// Replays pool-sol-deploy-mainnet.answers.json through the mainnet live check. The base (the dry run's answers moved to
// mainnet's URLs and genesis, the programdata holding the pinned code, the frozen table) passes; each recorded bad answer
// (an upgrade authority set, another hash, two RPCs that differ, a table with a live authority, deactivated, short one
// address, or differing between the RPCs) fails on its own line. Once the owner's paste has written
// contracts/pool-solana/deployments/mainnet.json, its own recording on mainnet (pool-sol-deploy-mainnet.good.json) is
// the good answer and passes.
//   node --test scripts/live-checks/pool-sol-deploy-mainnet.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkMainnet, DEPLOYMENT as RECORD } from "./pool-sol-deploy-mainnet.mjs";
import { operatorProblems, MAINNET_CODE_SHA, MAINNET_RPCS, RPCS } from "./pool-sol-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-sol-deploy-mainnet.answers.json", import.meta.url), "utf8"));
const D = A.deployment;
const GOOD = new URL("./pool-sol-deploy-mainnet.good.json", import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

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
const run = (answers, deployment = D, rpcs = A.rpcs) => checkMainnet({ deployment, fetchFn: replay(answers), rpcs, sleep: async () => {} });
/** The base with one recorded bad answer's patch applied to every read of its address on its URL (or both). */
function patched(bad) {
  const out = structuredClone(A.base);
  for (const a of out) {
    if (a.method !== "getAccountInfo" || a.params[0] !== bad.address || (bad.url !== "both" && a.url !== bad.url)) continue;
    let d = Buffer.from(a.json.result.value.data[0], "base64");
    if (bad.hex) Buffer.from(bad.hex, "hex").copy(d, bad.at);
    if (bad.xor) d[bad.at] ^= bad.xor;
    if (bad.truncate) d = d.subarray(0, d.length - bad.truncate);
    a.json.result.value.data[0] = d.toString("base64");
  }
  return out;
}
const failsOn = (r, re) => {
  assert.equal(r.ok, false);
  assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), re);
};

test("the base the bad answers are cut from passes, every line ok on both mainnet RPCs", async () => {
  const r = await run(A.base);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /lookup table \S+ is the table program's, active, authority none \(frozen\) on https:\/\/api.mainnet-beta.solana.com/.test(l)));
  assert.ok(r.lines.some((l) => /the table reads the same bytes on .*: true/.test(l)));
  assert.ok(r.lines.some((l) => /the programdata reads the same bytes on .*: true/.test(l)));
  assert.equal(D.table_addresses.length, 25);
});

for (const bad of A.bad) {
  test(`recorded bad answer fails: ${bad.name}`, async () => {
    failsOn(await run(patched(bad)), new RegExp(bad.fails));
  });
}

test("a record of other code than the reviewed build fails, and the pin is the findings file's", async () => {
  failsOn(await run(A.base, { ...D, so_sha256: "0".repeat(64) }), /the record's code is the reviewed build/);
  const findings = readFileSync(path.join(HERE, "../../contracts/pool-review-2.md"), "utf8");
  assert.deepEqual([...findings.matchAll(/^Program sha256: `([0-9a-f]{64})`/gm)].map((m) => m[1]), [MAINNET_CODE_SHA]);
});

test("a record without its table, or a table list without this pool, fails", async () => {
  failsOn(await run(A.base, { ...D, table: undefined }), /names the pool buy's lookup table \(none\)/);
  failsOn(await run(A.base, { ...D, table_addresses: D.table_addresses.filter((a) => a !== D.pool) }), /its list holding pool/);
});

test("mainnet needs mainnet's genesis on its two operators", async () => {
  assert.deepEqual(operatorProblems(MAINNET_RPCS, "mainnet"), []);
  assert.match(operatorProblems(RPCS, "mainnet")[0], /only 0 known mainnet operator/);
  assert.match(operatorProblems([MAINNET_RPCS[0], MAINNET_RPCS[0]], "mainnet")[0], /only 1 known mainnet operator/);
  const devnet = structuredClone(A.base);
  for (const a of devnet) if (a.method === "getGenesisHash") a.json.result = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  failsOn(await run(devnet), /genesis EtWTRAB\S+ is mainnet's/);
  failsOn(await run(A.base, { ...D, cluster: "devnet" }), /the record's cluster is mainnet: devnet/);
});

test("the owner's paste's own recording on mainnet passes, once its record exists", { skip: existsSync(RECORD) ? false : "no mainnet record yet: the paste writes it and its recording" }, async () => {
  assert.ok(existsSync(GOOD), "the paste recorded its live check's answers");
  const g = JSON.parse(readFileSync(GOOD, "utf8"));
  assert.deepEqual(g.deployment, JSON.parse(readFileSync(RECORD, "utf8")));
  assert.deepEqual(g.rpcs, MAINNET_RPCS);
  const r = await checkMainnet({ deployment: g.deployment, fetchFn: replay(g.answers), rpcs: g.rpcs, sleep: async () => {} });
  assert.equal(r.ok, true, r.lines.join("\n"));
  // and it fails with the table's authority set back, as the base's bad answer does
  const tableBad = A.bad.find((b) => /live authority/.test(b.name));
  const answers = structuredClone(g.answers);
  for (const a of answers) if (a.method === "getAccountInfo" && a.params[0] === g.deployment.table && a.json.result.value) {
    const d = Buffer.from(a.json.result.value.data[0], "base64");
    Buffer.from(tableBad.hex, "hex").copy(d, tableBad.at);
    a.json.result.value.data[0] = d.toString("base64");
  }
  failsOn(await checkMainnet({ deployment: g.deployment, fetchFn: replay(answers), rpcs: g.rpcs, sleep: async () => {} }), /authority none \(frozen\)/);
});
