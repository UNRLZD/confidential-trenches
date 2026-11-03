// SPDX-License-Identifier: Apache-2.0
// deploy.mjs's own tests: the cleanup never strands a lamport on the run's funder (a failure planted at every step
// before and inside it; 26 Oct's devnet SOL was stranded on a run key), the sweep's transfer bytes, the funder's need,
// and every committed deployment record's commitment (Poseidon(value, label, precommitment), which the live check
// compares the state leaf against).
//   node --test contracts/pool-solana/scripts/deploy.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanup, compileMessage, newKey, needOf, signTx, transferIx, DEPOSIT, FEE_PER_SIGNATURE } from "./deploy.mjs";
import { b58decode, labelOf, scopeOf, poolAddress, programDataAddress } from "../../../scripts/live-checks/pool-sol-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "../../..");
const req = createRequire(path.join(REPO, "packages/kit/package.json"));
const { poseidon3 } = await import(pathToFileURL(req.resolve("poseidon-lite")).href);
const { ed25519 } = await import(pathToFileURL(req.resolve("@noble/curves/ed25519.js")).href);
const RETURN = "CTnQzcmRUwDYkBx9cuyfcAidQZ6ogo27uGmWFEUyQGvb";

// a funder on a fake chain: each op can be made to throw `failures[op]` times
function chain({ balance = 1_000_000n, upgradeable = false, failures = {} } = {}) {
  const calls = [];
  const fail = (op) => {
    if ((failures[op] ?? 0) > 0) {
      failures[op]--;
      throw new Error(`planted ${op} failure`);
    }
  };
  const ops = {
    closeBuffers: async () => (calls.push("closeBuffers"), fail("closeBuffers"), (balance += 100n)),
    upgradeableByFunder: async () => (calls.push("upgradeableByFunder"), fail("upgradeableByFunder"), upgradeable),
    closeProgram: async () => (calls.push("closeProgram"), fail("closeProgram"), (upgradeable = false), (balance += 1000n)),
    balance: async () => (calls.push("balance"), fail("balance"), balance),
    transfer: async (to, lamports) => {
      calls.push(`transfer ${to} ${lamports}`);
      fail("transfer");
      assert.ok(lamports + FEE_PER_SIGNATURE <= balance);
      balance -= lamports + FEE_PER_SIGNATURE;
      return "sig";
    },
  };
  return { ops, calls, get balance() { return balance; } };
}
const fast = { wait: async () => {} };

test("the cleanup sweeps everything less one fee to the return address", async () => {
  const c = chain();
  const r = await cleanup(c.ops, RETURN, fast);
  assert.deepEqual([r.after, r.swept, r.signature, r.problems], [0n, 1_000_100n - FEE_PER_SIGNATURE, "sig", []]);
  assert.equal(c.balance, 0n);
  assert.ok(c.calls.includes(`transfer ${RETURN} ${1_000_100n - FEE_PER_SIGNATURE}`));
});

test("a program the funder can still upgrade is closed first, and its rent swept too", async () => {
  const c = chain({ upgradeable: true });
  const r = await cleanup(c.ops, RETURN, fast);
  assert.ok(c.calls.indexOf("closeProgram") < c.calls.findIndex((x) => x.startsWith("transfer")));
  assert.equal(r.after, 0n);
  assert.equal(r.swept, 1_001_100n - FEE_PER_SIGNATURE);
});

test("a failure planted at each cleanup step still ends with the funder at 0", async () => {
  for (const op of ["closeBuffers", "upgradeableByFunder", "closeProgram", "balance", "transfer"]) {
    const c = chain({ upgradeable: true, failures: { [op]: 1 } });
    const r = await cleanup(c.ops, RETURN, fast);
    assert.equal(c.balance, 0n, op);
    assert.equal(r.after, 0n, op);
    assert.equal(r.problems.length, 1, `${op}: ${r.problems}`);
    assert.ok(c.calls.includes("closeProgram"), `${op}: the program is still closed`);
    assert.equal(r.swept, 1_001_100n - FEE_PER_SIGNATURE, `${op}: buffer and program rent swept`);
  }
});

test("a sweep that keeps failing reports the funder unread, never claims a sweep", async () => {
  const c = chain({ failures: { transfer: 99 } });
  const r = await cleanup(c.ops, RETURN, { ...fast, tries: 3 });
  assert.deepEqual([r.signature, r.after, r.swept], [null, null, 0n]);
  assert.equal(r.problems.filter((p) => p.startsWith("sweep try")).length, 3);
});

test("a balance of one fee or less is left, and said", async () => {
  for (const b of [0n, FEE_PER_SIGNATURE - 100n]) {
    const c = chain({ balance: b });
    const r = await cleanup({ ...c.ops, closeBuffers: async () => {} }, RETURN, fast);
    assert.equal(r.signature, null);
    assert.equal(r.after, b);
    assert.equal(r.problems.length, b > 0n ? 1 : 0);
  }
});

test("the sweep's transaction: one signer, the system program's Transfer of the amount to the return address", () => {
  const funder = newKey();
  const m = compileMessage(funder.id, [transferIx(funder.id, RETURN, 123_456_789n)], "11111111111111111111111111111111");
  // header: 1 signer, 0 read-only signed, 1 read-only unsigned (the system program); keys funder, return, system
  assert.deepEqual([...m.bytes.subarray(0, 4)], [1, 0, 1, 3]);
  assert.deepEqual(m.bytes.subarray(4, 36), funder.pub);
  assert.deepEqual(m.bytes.subarray(36, 68), b58decode(RETURN));
  const ix = m.bytes.subarray(4 + 96 + 32);
  // 1 instruction: program index 2, accounts [0, 1], data u32 2 || u64 LE amount
  assert.deepEqual([...ix.subarray(0, 5)], [1, 2, 2, 0, 1]);
  assert.equal(ix[5], 12);
  assert.deepEqual([...ix.subarray(6, 10)], [2, 0, 0, 0]);
  assert.equal(Buffer.from(ix.subarray(10, 18)).readBigUInt64LE(), 123_456_789n);
  const tx = Buffer.from(signTx(m, [funder]).base64, "base64");
  assert.equal(tx[0], 1);
  assert.ok(ed25519.verify(tx.subarray(1, 65), m.bytes, funder.pub));
  assert.throws(() => signTx(m, []), /no key for signer/);
});

test("the need counts every rent the run pays, the deposit, the funder's own rent(0) and the fees", async () => {
  const rent = async (n) => (BigInt(n) + 128n) * 6960n; // the cluster's rate: 3480 lamports a byte-year, two years
  const { parts, total } = await needOf(rent, 76_960);
  assert.equal(parts.programdata, (45n + 76_960n + 128n) * 6960n);
  assert.equal(parts.program_account, (36n + 128n) * 6960n);
  assert.equal(parts.deposit, DEPOSIT);
  assert.equal(parts.funder_floor, 128n * 6960n);
  assert.equal(parts.deposit_pages, 2n * (88n + 128n) * 6960n);
  assert.equal(total, Object.values(parts).reduce((a, b) => a + b, 0n));
});

test("every committed deployment record's commitment is Poseidon(value, label, precommitment) of its own ids", () => {
  const dir = path.join(REPO, "scripts/live-checks");
  const records = readdirSync(dir).filter((f) => /^pool-sol-deploy\.(devnet|localnet)\.json$/.test(f));
  const answers = JSON.parse(readFileSync(path.join(dir, "pool-sol-deploy.answers.json"), "utf8"));
  for (const d of [...records.map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"))), answers.deployment]) {
    assert.equal(d.programdata, programDataAddress(d.program_id));
    assert.equal(d.pool, poolAddress(d.program_id).address);
    const label = labelOf(scopeOf(d.program_id, d.pool), BigInt(d.deposit.nonce));
    assert.equal(Buffer.from(label).toString("hex"), d.deposit.label);
    const c = poseidon3([BigInt(d.deposit.value), BigInt("0x" + d.deposit.label), BigInt("0x" + d.deposit.precommitment)]);
    assert.equal(c.toString(16).padStart(64, "0"), d.deposit.commitment);
  }
});

// ---- the devnet run of 90522c4 stopped on one "fetch failed" after its deploy (the cleanup swept it) ----
import { rpc } from "../../../scripts/live-checks/pool-sol-deploy.mjs";

/** A fetch that throws or answers `script` in order, then answers `final`. */
function flaky(script, final = { result: "ok" }) {
  let n = 0;
  const calls = () => n;
  const fetchFn = async () => {
    const step = script[n++];
    if (step === "throw") throw new TypeError("fetch failed");
    const [status, body] = step ?? [200, { jsonrpc: "2.0", id: 1, ...final }];
    return { ok: status === 200, status, json: async () => body };
  };
  return { fetchFn, calls };
}
const noWait = async () => {};

test("rpc retries a transient failure: a network error, a reset, a 429, a 5xx, then answers", async () => {
  for (const script of [["throw"], ["throw", "throw", "throw", "throw"], [[429, null]], [[503, null]], [[502, { error: "bad gateway" }]], [[200, { jsonrpc: "2.0", id: 1, error: { code: -32029 } }]]]) {
    const f = flaky(script);
    assert.equal(await rpc(f.fetchFn, "u", "getBalance", [], noWait), "ok", JSON.stringify(script));
    assert.equal(f.calls(), script.length + 1);
  }
});

test("rpc gives up after five tries, and never retries a real JSON-RPC error", async () => {
  const f = flaky(["throw", "throw", "throw", "throw", "throw", "throw"]);
  await assert.rejects(rpc(f.fetchFn, "u", "getBalance", [], noWait), /fetch failed/);
  assert.equal(f.calls(), 5);
  const e = flaky([[200, { jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed" } }]]);
  await assert.rejects(rpc(e.fetchFn, "u", "sendTransaction", [], noWait), /simulation failed/);
  assert.equal(e.calls(), 1);
});

// ---- the resume (--program): a program refused unless final with this build's code; a pool that exists skips init ----
import { programProblems, poolState } from "./deploy.mjs";

const REC = JSON.parse(readFileSync(path.join(REPO, "scripts/live-checks/pool-sol-deploy.answers.json"), "utf8"));
const RD = REC.deployment;
/** A fetch answering getAccountInfo from the recording, each account changed by `change[address]`. */
function chainOf(change = {}) {
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const a = REC.good.find((x) => x.method === method && x.params[0] === params[0]);
    const json = structuredClone(a?.json ?? { jsonrpc: "2.0", id: 1, result: { value: null } });
    if (change[params[0]]) json.result.value = change[params[0]](json.result.value);
    return { ok: true, status: 200, json: async () => json };
  };
}
const recordedCode = () => {
  const pd = REC.good.find((x) => x.method === "getAccountInfo" && x.params[0] === RD.programdata);
  return Buffer.from(pd.json.result.value.data[0], "base64").subarray(45, 45 + RD.so_len);
};
const withData = (f) => (v) => {
  const d = Buffer.from(v.data[0], "base64");
  f(d);
  return { ...v, data: [d.toString("base64"), "base64"] };
};

test("the resume takes the recorded program: executable, final, this build's code", async () => {
  assert.deepEqual(await programProblems(chainOf(), "u", RD.program_id, recordedCode()), []);
});

test("the resume refuses a program with an authority, other bytes, a non-executable or missing account", async () => {
  const so = recordedCode();
  const auth = await programProblems(chainOf({ [RD.programdata]: withData((d) => (d[12] = 1, d.fill(9, 13, 45))) }), "u", RD.program_id, so);
  assert.match(auth.join(), /upgrade authority \S+ is set/);
  const other = Buffer.from(so);
  other[100] ^= 1;
  assert.match((await programProblems(chainOf(), "u", RD.program_id, other)).join(), /is not this build's/);
  const tail = await programProblems(chainOf({ [RD.programdata]: (v) => ({ ...v, data: [Buffer.concat([Buffer.from(v.data[0], "base64"), Buffer.from([1])]).toString("base64"), "base64"] }) }), "u", RD.program_id, so);
  assert.match(tail.join(), /is not this build's/);
  const notExec = await programProblems(chainOf({ [RD.program_id]: (v) => ({ ...v, executable: false }) }), "u", RD.program_id, so);
  assert.match(notExec.join(), /is not an executable upgradeable-loader program/);
  assert.match((await programProblems(chainOf({ [RD.program_id]: () => null }), "u", RD.program_id, so)).join(), /no account/);
});

test("a pool that exists skips init and its rent; another account at the pool address is refused", async () => {
  const pool = REC.good.find((x) => x.method === "getAccountInfo" && x.params[0] === RD.pool).json.result.value;
  const acc = { owner: pool.owner, data: Buffer.from(pool.data[0], "base64") };
  assert.equal(poolState(acc, RD.program_id), "ours");
  assert.equal(poolState(null, RD.program_id), "missing");
  assert.match(poolState({ ...acc, owner: "11111111111111111111111111111111" }, RD.program_id), /^not the pool/);
  const rent = async (n) => (BigInt(n) + 128n) * 5080n;
  const fresh = await needOf(rent, 77_160);
  const resumed = await needOf(rent, 77_160, { resume: true });
  const initialized = await needOf(rent, 77_160, { resume: true, poolExists: true });
  assert.deepEqual(Object.keys(resumed.parts).sort(), ["deposit", "deposit_mark", "deposit_pages", "fees", "funder_floor", "pool"]);
  assert.equal(initialized.parts.pool, undefined);
  assert.equal(resumed.total - initialized.total, resumed.parts.pool + FEE_PER_SIGNATURE);
  assert.ok(fresh.total - resumed.total > fresh.parts.programdata);
});
