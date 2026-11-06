// Replays pool-sol-deploy-mainnet.answers.json through the mainnet live check. The base (the dry run's answers moved to
// mainnet's URLs and genesis, the programdata holding the pinned code, the frozen table) passes; each recorded bad answer
// (an upgrade authority set, another hash, two RPCs that differ, a table with a live authority, deactivated, short one
// address, differing between the RPCs, or a table and its record that agree but hold another address at a fixed venue
// entry, which only the kit's own list catches) fails on its own line. Once the owner's paste has written
// contracts/pool-solana/deployments/mainnet.json, its own recording on mainnet (pool-sol-deploy-mainnet.good.json) is
// the good answer and passes.
//   node --test scripts/live-checks/pool-sol-deploy-mainnet.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkMainnet, DEPLOYMENT as RECORD } from "./pool-sol-deploy-mainnet.mjs";
import { b58decode, b58encode as b58e, mainnetRunRecord, operatorProblems, MAINNET_CODE_SHA, MAINNET_RPCS, RPCS } from "./pool-sol-deploy.mjs";
import { earlierAttempts } from "./pool-sol-deploy-mainnet.mjs";

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
/** The base with one recorded bad answer's patch applied to every read of its address on its URL (or both); a `swap`
 * puts another address at one entry of the table and of the record's list alike, so the two still agree. */
function patched(bad) {
  const out = structuredClone(A.base);
  if (bad.swap) out.deployment = { ...D, table_addresses: D.table_addresses.map((a, i) => (i === bad.swap.index ? bad.swap.with : a)) };
  for (const a of out) {
    if (bad.method === "getBalance") {
      // a balance answer: `value` in place of the recorded one
      if (a.method === "getBalance" && a.params[0] === bad.address && (bad.url === "both" || a.url === bad.url)) a.json.result.value = bad.value;
      continue;
    }
    if (a.method !== "getAccountInfo" || a.params[0] !== bad.address || (bad.url !== "both" && a.url !== bad.url)) continue;
    let d = Buffer.from(a.json.result.value.data[0], "base64");
    if (bad.hex) Buffer.from(bad.hex, "hex").copy(d, bad.at);
    if (bad.xor) d[bad.at] ^= bad.xor;
    if (bad.truncate) d = d.subarray(0, d.length - bad.truncate);
    if (bad.swap) Buffer.from(b58decode(bad.swap.with)).copy(d, 56 + 32 * bad.swap.index);
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
    const p = patched(bad);
    failsOn(await run(p, p.deployment ?? D), new RegExp(bad.fails));
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

test("review 2: the table's list is the kit's own for this pool, the venue's 9 keys (pump Global's fee recipient and 8 buyback recipients) the only entries taken from the list", async () => {
  // the 9 venue keys are free: another fee recipient (Global's own may change) still passes
  const venue = structuredClone(A.base);
  const swapped = D.table_addresses.map((a, i) => (i === 13 ? "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" : a));
  for (const a of venue) if (a.method === "getAccountInfo" && a.params[0] === D.table) {
    const d = Buffer.from(a.json.result.value.data[0], "base64");
    Buffer.from(b58decode(swapped[13])).copy(d, 56 + 32 * 13);
    a.json.result.value.data[0] = d.toString("base64");
  }
  const r = await run(venue, { ...D, table_addresses: swapped });
  assert.equal(r.ok, true, r.lines.join("\n"));
  // any fixed entry swapped fails: each one of the 16 that are not the venue's
  for (const i of [0, 1, 5, 6, 10, 11, 12, 14, 15, 16]) {
    const list = D.table_addresses.map((a, j) => (j === i ? "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" : a));
    failsOn(await run(A.base, { ...D, table_addresses: list }), /the record's table list is the kit's/);
  }
  // one address more or fewer fails too
  failsOn(await run(A.base, { ...D, table_addresses: [...D.table_addresses, D.pool] }), /the record's table list is the kit's/);
});

/** The base with each of `txs` ({ signature, keys, ixs: [[program index, [account indexes], data bytes]] }) answered by
 * getTransaction at finalized on both RPCs, and `balances` ({ address: lamports }) by getBalance. */
function withTxs(txs, balances = {}) {
  const answers = structuredClone(A.base);
  const res = (result) => ({ status: 200, json: { jsonrpc: "2.0", id: 1, result } });
  for (const url of A.rpcs) {
    for (const t of D.txs) {
      const x = txs.find((y) => y.signature === t.signature) ?? { signature: t.signature, keys: [D.funder, "BPFLoaderUpgradeab1e11111111111111111111111"], ixs: [[1, [0], Buffer.from([2, 0, 0, 0])]] };
      answers.push({ url, method: "getTransaction", params: [x.signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }],
        ...res({ slot: 1, meta: { err: null }, transaction: { message: { accountKeys: x.keys, instructions: x.ixs.map(([p, a, d]) => ({ programIdIndex: p, accounts: a, data: b58e(d) })) } } }) });
    }
    for (const [addr, value] of Object.entries(balances)) answers.push({ url, method: "getBalance", params: [addr, { commitment: "finalized" }], ...res({ context: { slot: 1 }, value }) });
  }
  return answers;
}
const transferData = (lamports) => { const d = Buffer.alloc(12); d.writeUInt32LE(2, 0), d.writeBigUInt64LE(BigInt(lamports), 4); return d; };
const SYS = "11111111111111111111111111111111";

test("re-review 6 (card pool-sol-deploy-after-run A.2): a payer whose every transaction in the record is one plain transfer into a run key is an info line, never a FAIL; the run record names it apart", async () => {
  const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const fund = D.txs[0].signature; // the record's funding, paid by OTHER into the run's funder
  const answers = withTxs([{ signature: fund, keys: [OTHER, D.funder, SYS], ixs: [[2, [0, 1], transferData(449_137_520)]] }], { [OTHER]: 2_000_000_000 });
  const r = await run(answers, { ...D, funders: [...D.funders, OTHER] });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith(`info fee payer ${OTHER} holds 2000000000 lamports`) && l.includes("not a run key")), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith(`ok   funder ${D.funder} holds 0 lamports`)), r.lines.join("\n"));
  assert.deepEqual(r.foreign, [OTHER]);
  const md = mainnetRunRecord({ ...D, funders: [...D.funders, OTHER], need: "1" }, MAINNET_RPCS, [], r.foreign);
  const funders = md.split("\n").find((l) => l.startsWith("Funders: "));
  assert.ok(funders.startsWith(`Funders: ${D.funder}, run keys`) && !funders.includes(OTHER), funders);
  assert.ok(md.split("\n").some((l) => l === `Funding wallets, not run keys: ${OTHER}; each only sent the run a plain System Transfer, and its balance is its own.`), md);
});

test("card pool-sol-deploy-after-run A.2: a payer other than the funder that holds lamports FAILs unless every one of its record transactions is a plain transfer into a run key: one more instruction, a transfer elsewhere, a loader instruction, or no transaction at all", async () => {
  const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const fund = D.txs[0].signature;
  const cases = {
    "a transfer to the return address, not a run key": [{ signature: fund, keys: [OTHER, D.return_to, SYS], ixs: [[2, [0, 1], transferData(5)]] }],
    "a transfer beside a second instruction": [{ signature: fund, keys: [OTHER, D.funder, SYS], ixs: [[2, [0, 1], transferData(5)], [2, [0, 1], transferData(5)]] }],
    "a loader instruction (a run key's deploy)": [{ signature: fund, keys: [OTHER, "BPFLoaderUpgradeab1e11111111111111111111111"], ixs: [[1, [0], Buffer.from([2, 0, 0, 0])]] }],
    "the funding plus another of its own that is no funding": [{ signature: fund, keys: [OTHER, D.funder, SYS], ixs: [[2, [0, 1], transferData(5)]] }, { signature: D.txs[1].signature, keys: [OTHER, "BPFLoaderUpgradeab1e11111111111111111111111"], ixs: [[1, [0], Buffer.from([4, 0, 0, 0])]] }],
    "no transaction of its own in the record": [],
  };
  for (const [name, txs] of Object.entries(cases)) {
    const r = await run(withTxs(txs, { [OTHER]: 1 }), { ...D, funders: [...D.funders, OTHER] });
    failsOn(r, new RegExp(`funder ${OTHER} holds 0 lamports on \\S+: 1$`, "m"));
    assert.ok(!r.lines.some((l) => l.startsWith("info")), `${name}: ${r.lines.join("\n")}`);
  }
  // and a record transaction that is not found at finalized fails the read: never sorted from the label
  const missing = withTxs([{ signature: fund, keys: [OTHER, D.funder, SYS], ixs: [[2, [0, 1], transferData(5)]] }], { [OTHER]: 1 });
  for (const a of missing) if (a.method === "getTransaction" && a.params[0] === fund) a.json.result = null;
  failsOn(await run(missing, { ...D, funders: [...D.funders, OTHER] }), /not found at finalized/);
});

test("paste 1's stopped journal is named in the run's record, and its words never make a Tx line", () => {
  const attempts = earlierAttempts();
  assert.deepEqual(attempts.map((a) => a.file), ["contracts/pool-solana/deployments/mainnet.attempt-1.journal.json"]);
  const md = mainnetRunRecord({ ...D, txs: [{ signature: "s".repeat(88), step: "funding (to the funder)" }], need: "1" }, MAINNET_RPCS, attempts);
  const line = md.split("\n").find((l) => l.includes("mainnet.attempt-1.journal.json"));
  assert.ok(line, md);
  assert.match(line, /^Paste 1 \(2026-11-05T18:16:25\.178Z\) stopped mid-upload and is kept as contracts\/pool-solana\/deployments\/mainnet\.attempt-1\.journal\.json: 42 transactions, its keys removed with every lamport read back at 0 on both RPCs; this record is paste 2's\.$/);
  assert.equal(md.split("\n").filter((l) => l.startsWith("Tx: ")).length, 1, "the earlier attempt adds no Tx line");
  // no earlier attempt, no line
  assert.ok(!mainnetRunRecord({ ...D, txs: [], need: "1" }, MAINNET_RPCS).includes("attempt-1"));
});

test("the run record passes the money gate's reader: a step that names an address (paste 2's --sweep-kept to the return address) never puts it on the steps line", async () => {
  const { parseLive } = await import("../ci/money-gate.mjs");
  const txs = [
    { signature: "5wGExGuraxHFnnnobPR85vr3fBu7mW6BEgrpZWotwMZupKtdRSUj1jBExFbm7wiFeeHR8tqUUbZMAfnH8EM7uQPM", step: "funding (to the funder)" },
    { signature: "3CUZ2CpNwk8DabVSSD5T62AFJ2JWy8rdU1E8A2ZWMZsYW6RLbRgNXzpQPGHsiWd6s2beD7NRt8hsJUp2KCDJHTRb", step: `sweep (kept keys, to the run's return address ${D.return_to})` },
    { signature: "2XdxFtwv6hvgGreUGVKfwN5AdvCsvsHkErThG1pg86G732DqRgMLmHNi2mjMU6PUzanU4SZvsxsEhZvpQDu6S8kU", step: `sweep (kept keys, to a sender of the funding ${D.funder})` },
  ];
  const md = mainnetRunRecord({ ...D, txs, need: "1" }, MAINNET_RPCS, earlierAttempts());
  const r = parseLive(md, "pool-sol-deploy-mainnet");
  assert.deepEqual(r.problems, [], md);
  assert.equal(r.txs.length, 3);
  const steps = md.split("\n").find((l) => l.startsWith("The run: "));
  assert.match(steps, /sweep \(kept keys, to the run's return address\), sweep \(kept keys, to a sender of the funding\)\.$/);
  // and the committed record, the one the money gate reads on this card
  const committed = parseLive(readFileSync(path.join(HERE, "pool-sol-deploy-mainnet.md"), "utf8"), "pool-sol-deploy-mainnet");
  assert.deepEqual(committed.problems, []);
  assert.equal(committed.txs.length, 8);
});

test("review 1136 6 (M16): the two RPCs sorting the record's payers differently FAILs, though each one's balances pass", async () => {
  const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const fund = D.txs[0].signature;
  const answers = withTxs([{ signature: fund, keys: [OTHER, D.funder, SYS], ixs: [[2, [0, 1], transferData(449_137_520)]] }], { [OTHER]: 0 });
  // PublicNode answers the same transaction as another instruction of OTHER's: a run key there, at 0 lamports
  for (const a of answers) if (a.url === A.rpcs[1] && a.method === "getTransaction" && a.params[0] === fund) a.json.result.transaction.message.instructions = [{ programIdIndex: 2, accounts: [0, 1], data: b58e(Buffer.from([9, 0, 0, 0])) }];
  const r = await run(answers, { ...D, funders: [...D.funders, OTHER] });
  failsOn(r, /the record's payers sort differently on the two RPCs/);
});
