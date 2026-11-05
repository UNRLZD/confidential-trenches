// SPDX-License-Identifier: Apache-2.0
// deploy.mjs's own tests: the cleanup never strands a lamport on the run's funder (a failure planted at every step
// before and inside it; 26 Oct's devnet SOL was stranded on a run key), the sweep's transfer bytes, the funder's need,
// and every committed deployment record's commitment (Poseidon(value, label, precommitment), which the live check
// compares the state leaf against).
//   node --test contracts/pool-solana/scripts/deploy.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanup, compileMessage, newKey, needOf, signTx, transferIx, tableProblems, ALT_PROGRAM, COMPUTE_BUDGET, CLEANUP_RESERVE, DEPOSIT, FEE_PER_SIGNATURE, PRIORITY_CU_BOUND, PRIORITY_MICRO_LAMPORTS } from "./deploy.mjs";
import { b58decode, labelOf, scopeOf, poolAddress, programDataAddress } from "../../../scripts/live-checks/pool-sol-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "../../..");
const req = createRequire(path.join(REPO, "packages/kit/package.json"));
const { poseidon3 } = await import(pathToFileURL(req.resolve("poseidon-lite")).href);
const { ed25519 } = await import(pathToFileURL(req.resolve("@noble/curves/ed25519.js")).href);
const RETURN = "CTnQzcmRUwDYkBx9cuyfcAidQZ6ogo27uGmWFEUyQGvb";
// no test writes a key folder into the real ~/.local/state: keysBase() refuses this temp folder, so a main() without
// its own keysBase fails instead
process.env.XDG_STATE_HOME = path.join(tmpdir(), "deploy-test-no-home-keys");
// the tests' own key base (main() makes it 0700)
const TEST_KEYS = path.join(tmpdir(), "deploy-test-keys");
mkdirSync(TEST_KEYS, { recursive: true, mode: 0o700 });

// a funder on a fake chain, as the real ops do: each close and transfer costs the funder one fee, a close's rent goes to
// the return address (--recipient), and each op can be made to throw `failures[op]` times
const START = 10_000_000n;
function chain({ balance = START, upgradeable = false, failures = {} } = {}) {
  const calls = [];
  let returned = 0n;
  let fees = 0n;
  const fail = (op) => {
    if ((failures[op] ?? 0) > 0) {
      failures[op]--;
      throw new Error(`planted ${op} failure`);
    }
  };
  const pay = (rent) => ((balance -= FEE_PER_SIGNATURE), (fees += FEE_PER_SIGNATURE), (returned += rent));
  const ops = {
    closeBuffers: async () => (calls.push("closeBuffers"), fail("closeBuffers"), pay(100n)),
    upgradeableByFunder: async () => (calls.push("upgradeableByFunder"), fail("upgradeableByFunder"), upgradeable),
    closeProgram: async () => (calls.push("closeProgram"), fail("closeProgram"), (upgradeable = false), pay(1000n)),
    balance: async () => (calls.push("balance"), fail("balance"), balance),
    transfer: async (to, lamports) => {
      calls.push(`transfer ${to} ${lamports}`);
      fail("transfer");
      assert.ok(lamports + FEE_PER_SIGNATURE <= balance);
      balance -= lamports;
      pay(lamports);
      return `sig${calls.length}`;
    },
  };
  return { ops, calls, get balance() { return balance; }, get returned() { return returned; }, get fees() { return fees; } };
}
const fast = { wait: async () => {} };
const firstTransfer = (c) => c.calls.findIndex((x) => x.startsWith("transfer"));
const lastTransfer = (c) => c.calls.findLastIndex((x) => x.startsWith("transfer"));

test("the cleanup sweeps the bulk first, then closes, then the rest: everything less the fees reaches the return address", async () => {
  const c = chain();
  const r = await cleanup(c.ops, RETURN, fast);
  assert.deepEqual([r.after, r.problems, r.signatures.length], [0n, [], 2]);
  assert.equal(c.balance, 0n);
  assert.equal(c.calls[firstTransfer(c)], `transfer ${RETURN} ${START - CLEANUP_RESERVE - FEE_PER_SIGNATURE}`, "the bulk leaves first, less the reserve");
  assert.ok(firstTransfer(c) < c.calls.indexOf("closeBuffers"), "before the slow closes");
  assert.equal(c.returned + c.fees, START + 100n);
  assert.equal(r.swept, START - CLEANUP_RESERVE - FEE_PER_SIGNATURE + (CLEANUP_RESERVE - 2n * FEE_PER_SIGNATURE));
});

test("a program the funder can still upgrade is closed after the bulk, its rent to the return address", async () => {
  const c = chain({ upgradeable: true });
  const r = await cleanup(c.ops, RETURN, fast);
  assert.ok(firstTransfer(c) < c.calls.indexOf("closeProgram") && c.calls.indexOf("closeProgram") < lastTransfer(c));
  assert.equal(r.after, 0n);
  assert.equal(c.returned + c.fees, START + 1100n);
});

test("a failure planted at each cleanup step still ends with the funder at 0 and the program closed", async () => {
  for (const op of ["closeBuffers", "upgradeableByFunder", "closeProgram", "balance", "transfer"]) {
    const c = chain({ upgradeable: true, failures: { [op]: 1 } });
    const r = await cleanup(c.ops, RETURN, fast);
    assert.equal(c.balance, 0n, op);
    assert.equal(r.after, 0n, op);
    assert.equal(r.problems.length, 1, `${op}: ${r.problems}`);
    assert.ok(c.calls.includes("closeProgram"), `${op}: the program is still closed`);
    assert.equal(c.returned + c.fees, START + 1100n, `${op}: buffer and program rent returned`);
  }
});

test("a sweep that keeps failing reports the funder unread, never claims a sweep", async () => {
  const c = chain({ failures: { transfer: 99 } });
  const r = await cleanup(c.ops, RETURN, { ...fast, tries: 3 });
  assert.deepEqual([r.signatures, r.after, r.swept], [[], null, 0n]);
  assert.equal(r.problems.filter((p) => p.startsWith("sweep try")).length, 3);
  assert.equal(r.problems.filter((p) => p.startsWith("first sweep")).length, 1);
});

test("a balance of one fee or less is left, and said", async () => {
  for (const b of [0n, FEE_PER_SIGNATURE - 100n]) {
    const c = chain({ balance: b });
    const r = await cleanup({ ...c.ops, closeBuffers: async () => {} }, RETURN, fast);
    assert.deepEqual(r.signatures, []);
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
  // the precommitment mark: value, nonce and the tag, 17 bytes (contracts/pool-solana/src/state.rs PRE_MARK_LEN)
  assert.equal(parts.deposit_mark, (17n + 128n) * 6960n);
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

test("the resume refuses a program another loader owns, programdata another program owns, a pointer elsewhere, a buffer", async () => {
  const so = recordedCode();
  const p = (change) => programProblems(chainOf(change), "u", RD.program_id, so).then((x) => x.join());
  assert.match(await p({ [RD.program_id]: (v) => ({ ...v, owner: "BPFLoader2111111111111111111111111111111111" }) }), /not an executable upgradeable-loader program/);
  assert.match(await p({ [RD.programdata]: (v) => ({ ...v, owner: "11111111111111111111111111111111" }) }), /missing or not the loader's/);
  assert.match(await p({ [RD.program_id]: withData((d) => d.fill(5, 4, 36)) }), /pointing at/);
  assert.match(await p({ [RD.programdata]: withData((d) => (d[0] = 1)) }), /missing or not the loader's/);
});

// ---- the cleanup's keys and the two-transaction --final (review of bc57e12) ----
import { buildOf, chainOps, chainRecord, ciCode, main } from "./deploy.mjs";
import { existsSync, mkdtempSync, readdirSync as ls, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

test("main keeps the run's key folder when the sweep fails: the funder still holds its lamports", async () => {
  // a local chain where every send fails: the resume's init throws, and the cleanup's sweeps fail 99 times over
  const work = mkdtempSync(path.join(tmpdir(), "deploy-test-"));
  const soFile = path.join(work, "code.so");
  writeFileSync(soFile, recordedCode());
  let sends = 0;
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
    switch (method) {
      case "getGenesisHash": return ok("FakeLocalGenesis1111111111111111111111111111");
      case "getAccountInfo": return ok(REC.good.find((x) => x.method === method && x.params[0] === params[0])?.json.result ?? { value: null });
      case "getMinimumBalanceForRentExemption": return ok((params[0] + 128) * 6960);
      case "getBalance": return ok({ value: 1_000_000_000 });
      case "getSignaturesForAddress": case "getProgramAccounts": return ok([]);
      case "getLatestBlockhash": return ok({ value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 150 } });
      case "getBlockHeight": return ok(151); // every send's blockhash is past: the settle reads each expired
      case "sendTransaction": sends++; return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Blockhash not found" } }) };
      case "getSignatureStatuses": return ok({ value: [null] });
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const before = new Set(ls(TEST_KEYS).filter((f) => f.startsWith("pool-sol-deploy-")));
  const said = [];
  const realLog = console.log;
  console.log = (s) => said.push(String(s));
  try {
    await assert.rejects(main(["--url", "http://127.0.0.1:1", "--no-build", "--so", soFile, "--program", RD.program_id, "--return", RETURN, "--out", path.join(work, "record.json")], fetchFn,
      { wait: async () => {}, cli: () => ({ status: 0, stdout: "", stderr: "" }), keysBase: TEST_KEYS }));
  } finally {
    console.log = realLog;
  }
  const kept = ls(TEST_KEYS).filter((f) => f.startsWith("pool-sol-deploy-") && !before.has(f)).map((f) => path.join(TEST_KEYS, f));
  try {
    assert.ok(sends > 5, "the sweep was tried");
    assert.equal(kept.length, 1, "the key folder is kept");
    assert.ok(existsSync(path.join(kept[0], "funder.json")));
    assert.ok(said.some((l) => l.includes(`KEYS KEPT in ${kept[0]}`) && /1000000000/.test(l)), said.join("\n"));
  } finally {
    for (const k of kept) rmSync(k, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("the cleanup reads the authority at confirmed: a deploy whose SetAuthority never landed is closed", async () => {
  // the deploy landed a moment ago: finalized reads nothing yet, confirmed shows the funder as the upgrade authority
  const funder = newKey();
  const pd = REC.good.find((x) => x.method === "getAccountInfo" && x.params[0] === RD.programdata).json.result.value;
  const data = Buffer.from(pd.data[0], "base64");
  data[12] = 1;
  Buffer.from(funder.pub).copy(data, 13);
  let closed = false;
  const reads = [];
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
    if (method === "getAccountInfo") {
      reads.push(params[1].commitment);
      const show = params[1].commitment === "confirmed" && !closed;
      return ok({ value: show ? { ...pd, data: [data.toString("base64"), "base64"] } : null });
    }
    throw new Error(`unexpected ${method}`);
  };
  const runs = [];
  const ops = chainOps({ fetchFn, url: "u", second: "u", funder, programId: RD.program_id, keyFile: "k", returnTo: RETURN, wait: async () => {}, say: () => {},
    cli: (args) => (runs.push(args.slice(0, 3).join(" ")), args[1] === "close" && args[2] === RD.program_id && (closed = true), { status: 0, stdout: "", stderr: "" }) });
  assert.equal(await ops.upgradeableByFunder(), true);
  await cleanup({ ...ops, balance: async () => 0n }, RETURN, fast);
  assert.ok(runs.includes(`program close ${RD.program_id}`), runs.join("; "));
  assert.ok(reads.every((c) => c === "confirmed"));
  // and a read that fails throws: never taken for "not upgradeable"
  const down = chainOps({ fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "node behind" } }) }),
    url: "u", second: "u", funder, programId: RD.program_id, keyFile: "k", returnTo: RETURN });
  await assert.rejects(down.upgradeableByFunder(), /node behind/);
});

test("what is left keeps the keys: a lamport on either RPC, a buffer or programdata under the funder", async () => {
  const funder = newKey();
  const run = async ({ bal = {}, gpa = {} }) => {
    const fetchFn = async (url, init) => {
      const { method, params } = JSON.parse(init.body);
      const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
      if (method === "getBalance") return ok({ value: bal[url] ?? 0 });
      if (method === "getProgramAccounts") {
        const f = params[1].filters;
        assert.equal(f[1].memcmp.bytes, (await import("../../../scripts/live-checks/pool-sol-deploy.mjs")).b58encode(Uint8Array.from([1, ...funder.pub])));
        return ok(gpa[f[1].memcmp.offset] ?? []);
      }
      if (method === "getAccountInfo") return ok({ value: null });
      throw new Error(`unexpected ${method}`);
    };
    return chainOps({ fetchFn, url: "a", second: "b", funder, programId: RD.program_id, keyFile: "k", returnTo: RETURN, wait: async () => {} }).leftovers();
  };
  assert.deepEqual(await run({}), []);
  assert.match((await run({ bal: { b: 1 } })).join(), /holds 1 lamports on b/);
  assert.match((await run({ gpa: { 4: [{ pubkey: "Buf1" }] } })).join(), /buffer Buf1/);
  assert.match((await run({ gpa: { 12: [{ pubkey: "Pd1" }] } })).join(), /upgradeable program's data Pd1/);
});

test("the record from chain reads: the programdata's SetAuthority gets a line, funders are the fee payers, slot order", async () => {
  const D0 = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";
  const tx = (slot, payer, loaderTag) => ({ slot, meta: { err: null }, transaction: { message: { accountKeys: [payer, "BPFLoaderUpgradeab1e11111111111111111111111"],
    instructions: loaderTag === undefined ? [] : [{ programIdIndex: 1, data: (loaderTag === 4 ? "5" : "3") }] } } });
  const chainTx = { fund: tx(1, D0), dep: tx(2, "F1", 2), auth: tx(3, "F1", 4), init: tx(4, "F2") };
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
    if (method === "getSignaturesForAddress") return ok([{ signature: "auth", err: null }, { signature: "dep", err: null }]);
    if (method === "getTransaction") return ok(chainTx[params[0]]);
    throw new Error(`unexpected ${method}`);
  };
  const r = await chainRecord(fetchFn, "u", { programdata: "PD", return_to: D0, txs: [{ step: "init", signature: "init" }, { step: "funding", signature: "fund" }, { step: "deploy", signature: "dep" }] });
  assert.deepEqual(r.txs.map((t) => t.signature), ["fund", "dep", "auth", "init"]);
  assert.match(r.txs[2].step, /SetAuthority/);
  assert.equal(r.txs[1].step, "deploy", "a known step keeps its name");
  assert.deepEqual(r.funders, ["F1", "F2"]);
  chainTx.auth = { ...chainTx.auth, meta: { err: { InstructionError: [0, "x"] } } };
  await assert.rejects(chainRecord(fetchFn, "u", { programdata: "PD", return_to: D0, txs: [] }), /failed/);
});

// card pool-sol-mark-tag: the record's toolchain is read from the binaries that built the code, never a fixed string (a
// final program's record that names the wrong builder stays wrong for good, and a judge checks the hash against it)
test("the record names the toolchain read at build time: cargo-build-sbf's --version with its platform-tools, and the agave release", () => {
  const sbf = "cargo-build-sbf 4.5.0\nDefault platform-tools: v1.57\nDefault Rust: 1.95.0\n";
  const sol = "solana-cli 4.4.0 (src:9ef63128; feat:dddabd53, client:Agave)\n";
  assert.equal(buildOf(sbf, sol), "cargo-build-sbf 4.5.0; Default platform-tools: v1.57; Default Rust: 1.95.0; solana-cli 4.4.0 (src:9ef63128; feat:dddabd53, client:Agave); cargo-build-sbf --sbf-out-dir out -- --locked");
  assert.match(buildOf("cargo-build-sbf 4.4.0\nDefault platform-tools: v1.58\n", sol), /^cargo-build-sbf 4\.4\.0; Default platform-tools: v1\.58; solana-cli 4\.4\.0/);
  for (const [s, c] of [["", sol], [undefined, sol], ["cargo-build-sbf 4.5.0\n", sol], ["error: no such command\n", sol], [sbf, ""], [sbf, "solana-cli 4.4.0\n"]])
    assert.throws(() => buildOf(s, c), /not a version answer/, JSON.stringify([s, c]));
  // no record is written with a toolchain typed by hand
  const src = readFileSync(new URL("./deploy.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /build: "cargo-build-sbf/);
  assert.match(src, /so_sha256: soSha, build,/);
});

// a fake gh: run <id>'s view, its pool-solana job log and its artifact, each one changeable
function fakeGh({ code = recordedCode(), view = {}, log = (l) => l, files = (f) => f } = {}) {
  const sha = createHash("sha256").update(code).digest("hex");
  const commit = "e3f946dc4b7a208318986c80698efa16d27e5200";
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "run" && args[1] === "view")
      return JSON.stringify({ databaseId: 41677243428, workflowName: "ci", headSha: "fa4cd79e25fa11326c74541ccbdd05da11da2adb", jobs: [{ name: "gitleaks", conclusion: "success", databaseId: 1 }, { name: "pool-solana", conclusion: "success", databaseId: 126061058748 }], ...view });
    if (args[0] === "api") {
      assert.equal(args[1], "repos/UNRLZD/confidential-trenches/actions/jobs/126061058748/logs");
      return log([
        "2026-11-03T16:45:30.5Z ##[group]Run sha256sum blindfill_pool_solana.so | tee blindfill_pool_solana.so.sha256",
        `2026-11-03T16:45:30.5Z \u001b[36;1mecho "pool-solana code: sha256 $(cut -d' ' -f1 blindfill_pool_solana.so.sha256), $(wc -c < blindfill_pool_solana.so) bytes, commit $(git rev-parse HEAD)"\u001b[0m`,
        `2026-11-03T16:45:30.6Z ${sha}  blindfill_pool_solana.so`,
        `2026-11-03T16:45:30.6Z pool-solana code: sha256 ${sha}, ${code.length} bytes, commit ${commit}`,
        "2026-11-03T16:45:30.7Z pool-solana toolchain: cargo-build-sbf 4.5.0",
        "2026-11-03T16:45:30.7Z pool-solana toolchain: Default platform-tools: v1.57",
        "2026-11-03T16:45:30.7Z pool-solana toolchain: Default Rust: 1.95.0",
        "2026-11-03T16:45:30.8Z pool-solana toolchain: solana-cli 4.4.0 (src:9ef63128; feat:dddabd53, client:Agave)",
      ].join("\n"));
    }
    if (args[0] === "run" && args[1] === "download") {
      assert.deepEqual(args.slice(2, 7), ["41677243428", "-R", "UNRLZD/confidential-trenches", "-n", "pool-solana-so"]);
      const dir = args[args.indexOf("-D") + 1];
      const f = files({ "blindfill_pool_solana.so": code, "blindfill_pool_solana.so.sha256": `${sha}  blindfill_pool_solana.so\n` });
      for (const [name, body] of Object.entries(f)) writeFileSync(path.join(dir, name), body);
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, sha, commit, calls };
}

test("a public cluster's code is CI's build: the artifact whose sha256 and size the pool-solana job's log printed", () => {
  const f = fakeGh();
  const c = ciCode("41677243428", { gh: f.gh });
  assert.ok(c.so.equals(recordedCode()));
  assert.equal(c.sha, f.sha);
  assert.equal(c.commit, f.commit);
  assert.equal(c.build, `cargo-build-sbf 4.5.0; Default platform-tools: v1.57; Default Rust: 1.95.0; solana-cli 4.4.0 (src:9ef63128; feat:dddabd53, client:Agave); cargo-build-sbf --sbf-out-dir out -- --locked; CI run 41677243428, pool-solana job 126061058748, commit ${f.commit}`);
  const refused = (opts, re) => assert.throws(() => ciCode("41677243428", { gh: fakeGh(opts).gh }), re);
  // another file than the one CI built, or a sha256 file that disagrees
  refused({ files: (x) => ({ ...x, "blindfill_pool_solana.so": Buffer.concat([recordedCode(), Buffer.of(0)]) }) }, /artifact is .* its log says/);
  refused({ files: (x) => { const c = Buffer.from(recordedCode()); c[100] ^= 1; return { ...x, "blindfill_pool_solana.so": c }; } }, /artifact is .* its log says/);
  refused({ files: (x) => ({ ...x, "blindfill_pool_solana.so.sha256": `${"0".repeat(64)}  blindfill_pool_solana.so\n` }) }, /its sha256 file says 0{64}/);
  // a log that states the code twice, never, or names no toolchain
  refused({ log: (l) => l + "\n" + l.split("\n")[3] }, /states the code 2 times/);
  refused({ log: (l) => l.split("\n").filter((x) => !x.includes("pool-solana code: sha256 ") || x.includes("echo")).join("\n") }, /states the code 0 times/);
  refused({ log: (l) => l.split("\n").filter((x) => !x.includes("toolchain: solana-cli")).join("\n") }, /solana --version: not a version answer/);
  // a run whose pool-solana job failed or is missing, another workflow's run, a run id that is not one
  refused({ view: { jobs: [{ name: "pool-solana", conclusion: "failure", databaseId: 126061058748 }] } }, /pool-solana job is failure, not a success/);
  refused({ view: { jobs: [] } }, /pool-solana job is missing/);
  refused({ view: { workflowName: "live" } }, /is live's, not ci's/);
  assert.throws(() => ciCode("1; rm -rf /", { gh: f.gh }), /not a run id/);
});

test("devnet refuses a host build and --no-build: only --ci-run, before any key or transaction", async () => {
  const devnet = async (u, init) => {
    if (JSON.parse(init.body).method === "getGenesisHash") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }) };
    if (isReturnRead(init)) return okR(sysAccount());
    throw new Error("no other call before the code is CI's");
  };
  const run = (args, opts = {}) => main(["--url", "https://api.devnet.solana.com", "--return", RETURN, ...args], devnet, opts);
  for (const args of [[], ["--no-build"], ["--no-build", "--so", "x.so"]]) await assert.rejects(run(args), /devnet takes CI's build only: --ci-run/);
  const f = fakeGh({ view: { jobs: [{ name: "pool-solana", conclusion: "failure", databaseId: 126061058748 }] } });
  await assert.rejects(run(["--ci-run", "41677243428"], { gh: f.gh }), /pool-solana job is failure/);
  assert.equal(f.calls.length, 1);
});

test("devnet refuses CI's build when its sha256 is not the pinned code, before any key or transaction", async () => {
  const devnet = async (u, init) => {
    if (JSON.parse(init.body).method === "getGenesisHash") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }) };
    if (isReturnRead(init)) return okR(sysAccount());
    throw new Error("no other call before the code is the pinned code");
  };
  const before = new Set(ls(TEST_KEYS).filter((x) => x.startsWith("pool-sol-deploy-")));
  // the record and its journal go to a folder of the test's own, never the repo's, should the refusal ever not hold
  const work = mkdtempSync(path.join(tmpdir(), "deploy-test-"));
  let made = [];
  const realLog = console.log;
  console.log = () => {};
  try {
    // the recorded devnet code is an older build: the findings file's pin is not its hash
    const f = fakeGh();
    await assert.rejects(main(["--url", "https://api.devnet.solana.com", "--ci-run", "41677243428", "--return", RETURN, "--out", path.join(work, "record.json")], devnet, { gh: f.gh, keysBase: TEST_KEYS, wait: async () => {} }), new RegExp(`devnet refused: the code's sha256 ${f.sha} is not the pinned [0-9a-f]{64} \\(contracts/pool-review-2.md\\)`));
    // a planted pin: one hex digit off the build's own hash
    const off = f.sha.slice(0, 63) + (f.sha[63] === "0" ? "1" : "0");
    await assert.rejects(main(["--url", "https://api.devnet.solana.com", "--ci-run", "41677243428", "--return", RETURN, "--out", path.join(work, "record.json")], devnet, { gh: fakeGh().gh, keysBase: TEST_KEYS, wait: async () => {}, pin: off }), /is not the pinned/);
    // the pinned hash itself passes the check: the run goes on to its next step, a resume's read of the program (here
    // missing), still before any key
    const missing = async (u, init) => {
      const { method } = JSON.parse(init.body);
      if (method === "getAccountInfo" && !isReturnRead(init)) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: null } }) };
      return devnet(u, init);
    };
    await assert.rejects(main(["--url", "https://api.devnet.solana.com", "--ci-run", "41677243428", "--program", RD.program_id, "--return", RETURN, "--out", path.join(work, "record.json")], missing, { gh: f.gh, keysBase: TEST_KEYS, wait: async () => {}, pin: f.sha }), new RegExp(`--program ${RD.program_id} refused`));
  } finally {
    console.log = realLog;
    rmSync(work, { recursive: true, force: true });
    made = ls(TEST_KEYS).filter((x) => x.startsWith("pool-sol-deploy-") && !before.has(x));
    for (const k of made) rmSync(path.join(TEST_KEYS, k), { recursive: true, force: true });
  }
  assert.deepEqual(made, [], "no key was made");
});

test("the CLI deploys the very bytes hashed: CI's artifact, from a file in the run's own folder", async () => {
  const f = fakeGh();
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
    switch (method) {
      case "getGenesisHash": return ok("FakeLocalGenesis1111111111111111111111111111");
      case "getMinimumBalanceForRentExemption": return ok((params[0] + 128) * 6960);
      case "getBalance": return ok({ value: 1_000_000_000 });
      case "getSignaturesForAddress": case "getProgramAccounts": return ok([]);
      case "getAccountInfo": return ok({ value: null });
      default: throw new Error(`unexpected ${method}`);
    }
  };
  let deployed = null;
  const cli = (args) => {
    if (args[0] === "program" && args[1] === "deploy") {
      deployed = { file: args[2], sha: createHash("sha256").update(readFileSync(args[2])).digest("hex") };
      throw new Error("stop after the deploy call");
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const before = new Set(ls(TEST_KEYS).filter((x) => x.startsWith("pool-sol-deploy-")));
  const work = mkdtempSync(path.join(tmpdir(), "deploy-test-"));
  const realLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(main(["--url", "http://127.0.0.1:1", "--ci-run", "41677243428", "--return", RETURN, "--out", path.join(work, "record.json")], fetchFn, { wait: async () => {}, cli, gh: f.gh, keysBase: TEST_KEYS }), /stop after the deploy call/);
  } finally {
    console.log = realLog;
    rmSync(work, { recursive: true, force: true });
    for (const k of ls(TEST_KEYS).filter((x) => x.startsWith("pool-sol-deploy-") && !before.has(x))) rmSync(path.join(TEST_KEYS, k), { recursive: true, force: true });
  }
  assert.ok(deployed, "the CLI was asked to deploy");
  assert.equal(deployed.sha, f.sha);
  assert.match(path.basename(path.dirname(deployed.file)), /^pool-sol-deploy-/);
});

// ---- however the run stops, every lamport is swept back (card pool-sol-deploy-sweep) ----
// A mock cluster for main(): a virtual clock (the run's wait advances it), balances, and transactions that land when
// the test says (each landing debits its payer: a fee, a transfer's amount, the deposit's amount and rents; refused
// with InsufficientFundsForRent when the payer cannot pay). Its block height moves one block per 700 ms, so a
// blockhash stays valid 105 s.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (bytes) => {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let s = "";
  while (n > 0n) (s = B58[Number(n % 58n)] + s), (n /= 58n);
  for (const b of bytes) if (b === 0) s = "1" + s; else break;
  return s;
};
function decodeTx(b64) {
  const b = Buffer.from(b64, "base64");
  let o = 1;
  const signature = b58(b.subarray(o, o + 64));
  o += 64 * b[0] + 3;
  const keys = [];
  for (let n = b[o++], i = 0; i < n; i++, o += 32) keys.push(b58(b.subarray(o, o + 32)));
  o += 32;
  const ixs = [];
  for (let n = b[o++], i = 0; i < n; i++) {
    const program = keys[b[o++]];
    const ks = [...b.subarray(o + 1, o + 1 + b[o])].map((j) => keys[j]);
    o += 1 + b[o];
    // the data's length is a compact-u16 (two bytes past 127: the lookup table's extend)
    const n = b[o] < 0x80 ? [b[o], 1] : [(b[o] & 0x7f) | (b[o + 1] << 7), 2];
    const data = b.subarray(o + n[1], o + n[1] + n[0]);
    o += n[1] + n[0];
    ixs.push({ program, keys: ks, data });
  }
  return { signature, payer: keys[0], ixs };
}
const SYSTEM_ID = "11111111111111111111111111111111";
const FUND_SIG = "5".repeat(87);
function cluster({ funderStart = 1_000_000_000n, landAfter = () => 0, onSend = () => {}, poolMissing = false, onRead = () => {} } = {}) {
  // `funding`: whether the funder's incoming transfer (FUND_SIG) has landed; a funder that starts funded has it
  const c = { t: 0, bal: new Map(), txs: new Map(), sent: [], funder: null, credit: [], funding: funderStart > 0n, said: [], accounts: new Map(), tables: new Map() };
  const balOf = (a) => c.bal.get(a) ?? 0n;
  const apply = (tx) => {
    // a compute unit price instruction (mainnet's own sends) costs nothing here; the lookup table's are the table
    // program's: create and extend make the table (its authority the signer), freeze sets its authority to none
    const ix = tx.ixs.find((x) => x.program !== COMPUTE_BUDGET);
    let cost = FEE_PER_SIGNATURE;
    let to = null;
    if (ix.program === ALT_PROGRAM) {
      // the create pays the table's rent; an extend or freeze only its fee
      if (balOf(tx.payer) < cost + (ix.data[0] === 0 ? 3_000_000n : 0n)) return { InsufficientFundsForRent: { account_index: 0 } };
      c.bal.set(tx.payer, balOf(tx.payer) - cost - (ix.data[0] === 0 ? 3_000_000n : 0n));
      const table = ix.keys[0];
      for (const x of tx.ixs.filter((y) => y.program === ALT_PROGRAM)) {
        if (x.data[0] === 0) c.tables.set(table, { authority: x.keys[1], list: [] });
        else if (x.data[0] === 2) for (let i = 12; i < x.data.length; i += 32) c.tables.get(table).list.push(b58(x.data.subarray(i, i + 32)));
        else if (x.data[0] === 1) c.tables.get(table).authority = null;
        const t = c.tables.get(table);
        const meta = Buffer.alloc(56);
        meta.writeUInt32LE(1, 0), meta.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 4);
        if (t.authority) (meta[21] = 1), Buffer.from(b58decode(t.authority)).copy(meta, 22);
        c.accounts.set(table, { owner: ALT_PROGRAM, executable: false, lamports: 3_000_000, data: [Buffer.concat([meta, ...t.list.map((a) => Buffer.from(b58decode(a)))]).toString("base64"), "base64"] });
      }
      return null;
    }
    if (ix.program === SYSTEM_ID) (cost += ix.data.readBigUInt64LE(4)), (to = ix.keys[1]);
    else if (ix.data[0] === 0) cost += 3_000_000n; // init: the pool's rent
    else cost += DEPOSIT + 2_000_000n; // the deposit and its mark and page rents
    if (balOf(tx.payer) < cost) return { InsufficientFundsForRent: { account_index: 0 } };
    c.bal.set(tx.payer, balOf(tx.payer) - cost);
    if (ix.program !== SYSTEM_ID && ix.data[0] === 1) depositAccounts(c, ix);
    if (to) c.bal.set(to, balOf(to) + cost - FEE_PER_SIGNATURE);
    return null;
  };
  const tick = () => {
    for (const f of c.credit) if (!f.done && c.t >= f.at) (f.done = true), f.fn();
    for (const x of c.txs.values()) if (!x.landed && c.t >= x.landAt) (x.landed = true), (x.err = apply(x.tx));
  };
  const height = () => Math.floor(c.t / 700);
  c.fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
    const err = (message) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32002, message } }) });
    tick();
    onRead(method, params, c);
    switch (method) {
      case "getGenesisHash": return ok("FakeLocalGenesis1111111111111111111111111111");
      case "getMinimumBalanceForRentExemption": return ok((params[0] + 128) * 6960);
      case "getAccountInfo": {
        if (poolMissing && params[0] === RD.pool && ![...c.txs.values()].some((x) => x.landed && !x.err && x.tx.ixs[0].data[0] === 0 && x.tx.ixs[0].program !== SYSTEM_ID)) return ok({ value: null });
        if (c.accounts.has(params[0])) return ok({ value: c.accounts.get(params[0]) });
        if (c.bal.has(params[0]) && params[0] !== c.funder && params[0] !== RETURN && !REC.good.some((x) => x.method === method && x.params[0] === params[0]))
          return ok({ value: { owner: SYSTEM_ID, executable: false, lamports: Number(c.bal.get(params[0])), data: ["", "base64"] } });
        return ok(REC.good.find((x) => x.method === method && x.params[0] === params[0])?.json.result ?? { value: null });
      }
      case "getBalance": {
        if (params[0] !== RETURN && !c.funder) (c.funder = params[0]), c.bal.set(params[0], funderStart);
        return ok({ value: Number(balOf(params[0])) });
      }
      case "getSignaturesForAddress": {
        const mine = [...c.txs.values()].filter((x) => x.landed && (x.tx.payer === params[0] || x.tx.ixs[0].keys.includes(params[0]))).map((x) => ({ signature: x.tx.signature, err: x.err }));
        return ok(params[0] === c.funder && c.funding ? [...mine.reverse(), { signature: FUND_SIG, err: null }] : mine.reverse());
      }
      case "getProgramAccounts": return ok([]);
      case "getSlot": return ok(400_000_000);
      case "getLatestBlockhash": return ok({ value: { blockhash: SYSTEM_ID, lastValidBlockHeight: height() + 150 } });
      case "getBlockHeight": return ok(height());
      case "sendTransaction": {
        const tx = decodeTx(params[0]);
        const known = c.txs.get(tx.signature);
        if (known?.landed) return err("Transaction simulation failed: This transaction has already been processed");
        if (!known) {
          const x = { tx, sentAt: c.t, landAt: c.t + landAfter(tx), landed: false, err: null };
          c.txs.set(tx.signature, x);
          c.sent.push(x);
          onSend(tx, c);
          tick();
        }
        return ok(tx.signature);
      }
      case "getSignatureStatuses": return ok({ value: params[0].map((s) => {
        if (s === FUND_SIG && c.funding) return { confirmationStatus: "finalized", err: null };
        const x = c.txs.get(s);
        return x?.landed ? { confirmationStatus: "finalized", err: x.err } : null;
      }) });
      case "getTransaction": {
        const x = c.txs.get(params[0]);
        if (params[0] !== FUND_SIG && !x?.landed) return ok(null);
        if (!x) {
          const d = Buffer.alloc(12);
          d.writeUInt32LE(2, 0), d.writeBigUInt64LE(c.fundAmount ?? 1n, 4);
          return ok({ slot: 0, blockTime: c.fundBlockTime ?? null, meta: { err: null }, transaction: { message: { accountKeys: [c.fundFrom ?? RETURN, c.funder, SYSTEM_ID], instructions: [{ programIdIndex: 2, accounts: [0, 1], data: b58(d) }] } } });
        }
        return ok({ slot: Math.floor(x.landAt / 400) + 1, meta: { err: x.err }, transaction: { message: { accountKeys: [x.tx.payer], instructions: [] } } });
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  c.io = { wait: async (ms) => void (c.t += ms), now: () => c.t, cli: () => ({ status: 0, stdout: "", stderr: "" }), keysBase: TEST_KEYS };
  return c;
}
/** What a landed deposit makes, as the program does: its mark (value, nonce, tag 1) and both page leaves (the state
 * leaf Poseidon(value, label, precommitment), the label leaf keccak256(scope, nonce) mod p), at the pool's next nonce. */
function depositAccounts(c, ix) {
  const [pool, , page0, page1, mark] = ix.keys;
  const poolData = Buffer.from(REC.good.find((x) => x.method === "getAccountInfo" && x.params[0] === pool).json.result.value.data[0], "base64");
  const nonce = poolData.readBigUInt64LE(49) + 1n;
  const value = ix.data.readBigUInt64LE(1);
  const pre = Buffer.from(ix.data.subarray(9, 41));
  const label = Buffer.from(labelOf(scopeOf(ix.program, pool), nonce));
  const commitment = Buffer.from(poseidon3([value, BigInt("0x" + label.toString("hex")), BigInt("0x" + pre.toString("hex"))]).toString(16).padStart(64, "0"), "hex");
  const acc = (data) => ({ owner: ix.program, executable: false, lamports: 1, data: [data.toString("base64"), "base64"] });
  const m = Buffer.alloc(17);
  m.writeBigUInt64LE(value, 0), m.writeBigUInt64LE(nonce, 8), (m[16] = 1);
  c.accounts.set(mark, acc(m));
  const slot = Number((nonce - 1n) % 1024n) * 72 + 16;
  for (const [addr, leaf] of [[page0, commitment], [page1, label]]) {
    const d = Buffer.alloc(slot + 72);
    leaf.copy(d, slot);
    c.accounts.set(addr, acc(d));
  }
}
const own = (tx) => tx.ixs.find((x) => x.program !== COMPUTE_BUDGET);
const isDeposit = (tx) => own(tx).program !== SYSTEM_ID && own(tx).program !== ALT_PROGRAM && own(tx).data[0] === 1;
const isInit = (tx) => own(tx).program !== SYSTEM_ID && own(tx).program !== ALT_PROGRAM && own(tx).data[0] === 0;
/** Runs main() (a resume of the recorded program, so no CLI deploy) on `c`; returns its error, log, record and key dir. */
async function runOn(c, extra = []) {
  const work = mkdtempSync(path.join(tmpdir(), "deploy-test-"));
  const soFile = path.join(work, "code.so");
  writeFileSync(soFile, recordedCode());
  const out = path.join(work, "record.json");
  c.out = out;
  c.journal = path.join(work, "record.journal.json");
  const said = (c.said = []);
  const realLog = console.log;
  console.log = (s) => said.push(String(s));
  let error = null;
  try {
    await main(["--url", "http://127.0.0.1:1", "--no-build", "--so", soFile, "--program", RD.program_id, "--return", RETURN, "--out", out, ...extra], c.fetchFn, c.io);
  } catch (e) {
    error = e;
  } finally {
    console.log = realLog;
  }
  const dir = keyDirOf(said);
  const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
  const record = read(out);
  const journal = read(c.journal);
  const kept = dir && existsSync(dir);
  if (dir) rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  return { error, said, record, journal, dir, kept };
}
const keyDirOf = (said) => said.map((l) => l.match(/the run's keys are in (\S+) until/)?.[1]).find(Boolean);
const sweptTo = (c, to = RETURN) => c.sent.filter((x) => x.landed && !x.err && x.tx.ixs[0].program === SYSTEM_ID && x.tx.ixs[0].keys[1] === to)
  .reduce((s, x) => s + x.tx.ixs[0].data.readBigUInt64LE(4), 0n);

test("a send that lands 95 s after it was sent, past its 90 s wait, is in the record and swept after it lands", async () => {
  const c = cluster({ landAfter: (tx) => (isDeposit(tx) ? 95_000 : 0) });
  const r = await runOn(c);
  assert.match(String(r.error?.message), /not confirmed in 90 s/);
  const dep = c.sent.find((x) => isDeposit(x.tx));
  assert.ok(r.journal?.txs.some((t) => t.signature === dep.tx.signature), "the deposit's signature is in the run's journal");
  assert.ok(dep.landed && !dep.err, "the deposit landed at 95 s");
  assert.deepEqual(r.journal.txs.find((t) => t.signature === dep.tx.signature), { step: "deposit 0.01 SOL (tag 1)", signature: dep.tx.signature, state: "landed" });
  // the sweep came after the deposit landed: the return address got all the funder had less the deposit and the fees
  const fees = BigInt(c.sent.filter((x) => x.landed).length) * FEE_PER_SIGNATURE;
  assert.equal(sweptTo(c), 1_000_000_000n - (DEPOSIT + 2_000_000n) - fees);
  assert.equal(c.bal.get(c.funder), 0n);
  for (const x of c.sent.filter((x) => x.tx.ixs[0].program === SYSTEM_ID)) {
    assert.ok(x.sentAt >= dep.landAt, "no sweep was sent before the late send landed");
    assert.ok(r.journal.txs.some((t) => t.signature === x.tx.signature && t.state === "landed"), "every sweep is in the record");
  }
  assert.equal(r.journal.complete, false);
  assert.equal(r.record, null, "a stopped run writes its journal, never the record: the record path keeps what it held");
  assert.deepEqual(absolutePaths(r.journal), [], "the journal names no absolute path");
  assert.equal(r.kept, false, "the keys are removed once the funder reads 0");
});

test("SIGHUP mid-deploy (a terminal closing) stops the run at its next step and sweeps, like SIGINT and SIGTERM", async () => {
  const listeners = process.listenerCount("SIGHUP");
  const c = cluster({
    poolMissing: true,
    onSend: (tx) => {
      if (isInit(tx)) process.emit("SIGHUP", "SIGHUP");
      if (isDeposit(tx)) throw new Error("planted: the deposit was sent after the SIGHUP");
    },
  });
  const r = await runOn(c);
  assert.match(String(r.error?.message), /stopped by SIGHUP/);
  assert.ok(!c.sent.some((x) => isDeposit(x.tx)), "no step after the SIGHUP was sent");
  const fees = BigInt(c.sent.filter((x) => x.landed).length) * FEE_PER_SIGNATURE;
  assert.equal(sweptTo(c), 1_000_000_000n - 3_000_000n - fees);
  assert.equal(c.bal.get(c.funder), 0n);
  assert.ok(r.journal.txs.some((t) => t.step === "init (tag 0)" && t.state === "landed"));
  assert.equal(r.journal.stopped, "SIGHUP");
  assert.equal(r.kept, false);
  assert.equal(process.listenerCount("SIGHUP"), listeners, "the run's SIGHUP handler is removed when it ends");
});

test("a stop during the funding wait watches the balance 60 s: funding landing 30 s after the stop is swept, its key file kept until then", async () => {
  let stopAt = null;
  let keyFileAtFunding = null;
  const c = cluster({
    funderStart: 0n,
    onRead: (method, params, c) => {
      if (method !== "getBalance" || params[0] !== c.funder || stopAt !== null) return;
      stopAt = c.t;
      process.emit("SIGTERM", "SIGTERM");
      c.credit.push({ at: stopAt + 30_000, fn: () => {
        keyFileAtFunding = existsSync(path.join(keyDirOf(c.said), "funder.json"));
        c.bal.set(c.funder, 50_000_000n);
        c.funding = true;
      } });
    },
  });
  const r = await runOn(c);
  assert.ok(stopAt !== null, "the stop came during the funding wait");
  assert.match(String(r.error?.message), /stopped/);
  assert.equal(sweptTo(c), 50_000_000n - FEE_PER_SIGNATURE * BigInt(c.sent.filter((x) => x.landed).length), "the late funding was swept back");
  assert.equal(keyFileAtFunding, true, "the key file was there when the funding landed");
  assert.match(String(r.error?.message), /stopped by SIGTERM/);
  assert.equal(c.bal.get(c.funder), 0n);
  assert.ok(c.sent.every((x) => x.sentAt >= stopAt + 30_000), "the sweep came after the funding");
  assert.ok(r.journal.txs.some((t) => t.step === "funding (to the funder)" && t.signature === FUND_SIG && t.state === "landed"));
  // a stop before the funding was read keeps the keys (card pool-sol-deploy-sweep fold 2 B), the journal says so
  assert.equal(r.kept, true, "the keys are kept: the run stopped before its funding was read");
  assert.equal(r.journal.keys.state, "kept");
});

/** Every string in `v` holding an absolute file path (a temp folder, a home), URLs aside. */
function absolutePaths(v, out = []) {
  if (typeof v === "string") {
    if (/(^|[\s"'(=,;])(\/(?!\/)[^\s"',;]+|[A-Za-z]:\\)/.test(v.replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, ""))) out.push(v);
  } else if (v && typeof v === "object") for (const x of Object.values(v)) absolutePaths(x, out);
  return out;
}

test("a completed run writes its full record only at its end, and removes its journal then", async () => {
  let recordDuringRun = null;
  let journalDuringRun = null;
  const c = cluster({
    onSend: (tx, c) => {
      if (isDeposit(tx)) (recordDuringRun = existsSync(c.out)), (journalDuringRun = existsSync(c.journal) && JSON.parse(readFileSync(c.journal, "utf8")));
    },
  });
  const r = await runOn(c);
  assert.equal(r.error, null, String(r.error?.stack));
  assert.equal(recordDuringRun, false, "the record path is not written while the run is under way");
  assert.ok(journalDuringRun?.txs.some((t) => t.step === "deposit 0.01 SOL (tag 1)" && t.state === "sent"), "the journal held the deposit before its send");
  assert.equal(r.journal, null, "the journal is removed once the full record is written");
  assert.equal(r.record.complete, undefined);
  assert.equal(r.record.program_id, RD.program_id);
  assert.deepEqual(r.record.txs.map((t) => t.step), ["funding (to the funder)", "deposit 0.01 SOL (tag 1)", "sweep (the funder's rest back)", "sweep (the funder's rest back)"]);
  assert.deepEqual(r.record.funders, [c.funder]);
  assert.deepEqual(absolutePaths(r.record), [], "the record names no absolute path");
  assert.equal(c.bal.get(c.funder), 0n);
  assert.equal(r.kept, false);
});

test("no committed deployment record or journal names an absolute path (a run's temp folder, a home)", () => {
  const dir = path.join(REPO, "scripts/live-checks");
  const files = readdirSync(dir).filter((f) => /^pool-sol-deploy.*\.json$/.test(f));
  assert.ok(files.length >= 3, files.join());
  for (const f of files) {
    const j = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    const records = f.endsWith(".answers.json") ? [j.deployment] : [j];
    for (const d of records) assert.deepEqual(absolutePaths(d), [], `${f} names an absolute path`);
  }
  // the scan itself: a temp folder and a home are found, a URL and a repo path are not
  assert.deepEqual(absolutePaths({ a: "/var/folders/m3/x/T/pool-sol-deploy-8bKbth", b: ["kept in /Users/x/y"], c: "https://api.devnet.solana.com/x", d: "contracts/pool-solana/out", e: "pool-sol-deploy-8bKbth (the OS temp folder)" }).length, 2);
});

// ---- fold 2 (the review of dea0937): each finding a test, red at dea0937 ----
const wrap = (c, f) => {
  const real = c.fetchFn;
  c.fetchFn = async (url, init) => f(url, JSON.parse(init.body), () => real(url, init));
  return c;
};
const okR = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
const errR = (message) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32002, message } }) });
/** main() on `c` (a resume of the recorded program) to `out`; leaves the key folder for the test to read and remove. */
async function runAt(c, out, extra = [], argv = null) {
  const soDir = mkdtempSync(path.join(tmpdir(), "probe-so-"));
  const soFile = path.join(soDir, "code.so");
  writeFileSync(soFile, recordedCode());
  const said = (c.said = []);
  const realLog = console.log;
  console.log = (s) => said.push(String(s));
  let error = null;
  let value = null;
  try {
    value = await main(argv ?? ["--url", "http://127.0.0.1:1", "--no-build", "--so", soFile, "--program", RD.program_id, "--return", RETURN, "--out", out, ...extra], c.fetchFn, c.io);
  } catch (e) {
    error = e;
  } finally {
    console.log = realLog;
    rmSync(soDir, { recursive: true, force: true });
  }
  return { error, said, value, dir: keyDirOf(said) };
}
const stopInWait = (sig = "SIGINT", then = () => {}) => (m, p, c) => {
  if (m === "getBalance" && p[0] === c.funder && c.stopAt === undefined) (c.stopAt = c.t), process.emit(sig, sig), then(c);
};
const work = () => {
  const w = mkdtempSync(path.join(tmpdir(), "fold2-"));
  return { w, out: path.join(w, "record.json"), journal: path.join(w, "record.journal.json") };
};
const SOURCE = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"; // a funding wallet that is not the run's --return

test("fold 2 A: a run refuses before making any key when its journal exists, names it, and leaves it byte for byte", async () => {
  const { w, out, journal } = work();
  const first = JSON.stringify({ complete: false, funder: "a stopped run's", keys: { state: "kept" } }) + "\n";
  writeFileSync(journal, first);
  const c = cluster();
  const r = await runAt(c, out);
  try {
    assert.ok(r.error && r.error.message.includes(journal), `refused naming ${journal}: ${r.error?.message}`);
    assert.equal(readFileSync(journal, "utf8"), first, "the first journal is byte-identical");
    assert.equal(r.dir, undefined, "no key folder was made");
    assert.equal(c.sent.length, 0);
  } finally {
    if (r.dir) rmSync(r.dir, { recursive: true, force: true });
    rmSync(w, { recursive: true, force: true });
  }
});

test("fold 2 B: a stop before the funding was read keeps the keys and says so; funding landing after the run is swept later by the journal's command, to the funding's source", async () => {
  const { w, out, journal } = work();
  const c = cluster({ funderStart: 0n, onRead: stopInWait("SIGHUP") });
  const r = await runAt(c, out);
  try {
    assert.match(String(r.error?.message), /stopped by SIGHUP/);
    assert.equal(existsSync(r.dir), true, "the key folder is kept");
    const j = JSON.parse(readFileSync(journal, "utf8"));
    assert.equal(j.keys.state, "kept");
    assert.match(j.keys.why.join(), /stopped before its funding was read/);
    assert.match(j.keys.sweep, /^node contracts\/pool-solana\/scripts\/deploy\.mjs --sweep-kept \S+record\.journal\.json --url http:\/\/127\.0\.0\.1:1$/);
    assert.equal(j.keys.folder, path.basename(r.dir));
    // the paste lands 66 s after the stop, the run long gone, from a wallet that is not --return
    c.t += 66_000;
    Object.assign(c, { fundFrom: SOURCE, fundAmount: 50_000_000n, funding: true });
    c.bal.set(c.funder, 50_000_000n);
    const s = await runAt(c, out, [], ["--url", "http://127.0.0.1:1", "--sweep-kept", journal]);
    assert.equal(s.error, null, String(s.error?.stack));
    assert.equal(sweptTo(c, SOURCE), 50_000_000n - FEE_PER_SIGNATURE, "swept to the funding's own source");
    assert.equal(c.bal.get(c.funder), 0n);
    assert.equal(existsSync(r.dir), false, "the keys are removed once both RPCs read 0");
    const j2 = JSON.parse(readFileSync(journal, "utf8"));
    assert.equal(j2.keys.state, "removed");
    assert.ok(j2.txs.some((t) => t.signature === FUND_SIG && t.step === "funding (to the funder)"));
    assert.ok(j2.txs.some((t) => t.step.startsWith("sweep (kept keys") && t.state === "landed"));
  } finally {
    if (r.dir) rmSync(r.dir, { recursive: true, force: true });
    rmSync(w, { recursive: true, force: true });
  }
});

test("fold 2 C: TERM in the funding wait with the funding there: the first sweep goes at once, before the 60 s watch (a KILL 10 s later finds it swept)", async () => {
  const { w, out } = work();
  // in one 5 s poll of the funding wait: the funding lands, then TERM (the run sees the stop before its next read)
  const c = cluster({ funderStart: 0n });
  const tick = c.io.wait;
  c.io = { ...c.io, wait: async (ms) => {
    if (c.stopAt === undefined && c.funder) (c.stopAt = c.t), c.bal.set(c.funder, 1_000_000_000n), (c.funding = true), process.emit("SIGTERM", "SIGTERM");
    return tick(ms);
  } };
  const r = await runAt(c, out);
  try {
    const sweeps = c.sent.filter((x) => x.tx.ixs[0].program === SYSTEM_ID);
    assert.ok(sweeps.length >= 1);
    assert.ok(sweeps[0].sentAt - c.stopAt <= 10_000, `first sweep at stop + ${(sweeps[0].sentAt - c.stopAt) / 1000} s`);
    assert.equal(c.bal.get(c.funder), 0n);
  } finally {
    if (r.dir) rmSync(r.dir, { recursive: true, force: true });
    rmSync(w, { recursive: true, force: true });
  }
});

test("fold 2 D: the settle only reads: a deposit the RPC refused at preflight is never sent again, so it never lands", async () => {
  const { w, out, journal } = work();
  let skips = 0;
  const c = wrap(cluster(), (url, { method, params }, real) => {
    if (method === "sendTransaction" && params[1]?.skipPreflight) skips++;
    if (method === "sendTransaction" && !params[1]?.skipPreflight && isDeposit(decodeTx(params[0]))) return errR("Transaction simulation failed: Blockhash not found");
    return real();
  });
  const r = await runAt(c, out);
  try {
    assert.equal(skips, 0, "nothing is sent with skipPreflight");
    assert.equal(c.sent.some((x) => isDeposit(x.tx)), false, "the deposit never reached the cluster");
    const j = JSON.parse(readFileSync(journal, "utf8"));
    assert.equal(j.txs.find((t) => t.step.startsWith("deposit")).state, "expired");
    const fees = BigInt(c.sent.filter((x) => x.landed).length) * FEE_PER_SIGNATURE;
    assert.equal(sweptTo(c), 1_000_000_000n - fees, "every lamport but the fees came back");
  } finally {
    if (r.dir) rmSync(r.dir, { recursive: true, force: true });
    rmSync(w, { recursive: true, force: true });
  }
});

test("fold 2 E: what is left reads the program id too: lamports there keep the keys unless it is a deployed program", async () => {
  const funder = newKey();
  const run = async (acc) => {
    const fetchFn = async (url, init) => {
      const { method, params } = JSON.parse(init.body);
      if (method === "getBalance") return okR({ value: 0 });
      if (method === "getProgramAccounts") return okR([]);
      if (method === "getAccountInfo") return okR({ value: params[0] === RD.program_id ? acc : null });
      throw new Error(`unexpected ${method}`);
    };
    return chainOps({ fetchFn, url: "a", second: "b", funder, programId: RD.program_id, keyFile: "k", returnTo: RETURN, wait: async () => {} }).leftovers();
  };
  assert.match((await run({ owner: SYSTEM_ID, executable: false, lamports: 50_000_000, data: ["", "base64"] })).join(), new RegExp(`program id ${RD.program_id} holds 50000000 lamports on a`));
  assert.deepEqual(await run({ owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true, lamports: 1_141_440, data: ["", "base64"] }), []);
  assert.deepEqual(await run(null), []);
});

test("fold 2 F: the funding read failing once right after the wait: the journal still lists the funding, and the keys stay", async () => {
  const { w, out, journal } = work();
  let n = 0;
  const c = wrap(cluster(), (url, { method }, real) => (method === "getSignaturesForAddress" && n++ === 0 ? errR("planted: getSignaturesForAddress failed") : real()));
  const r = await runAt(c, out);
  try {
    const j = JSON.parse(readFileSync(journal, "utf8"));
    assert.ok(j.txs.some((t) => t.signature === FUND_SIG && t.step === "funding (to the funder)"), JSON.stringify(j.txs.map((t) => t.step)));
    assert.equal(j.keys.state, "kept");
    assert.equal(c.bal.get(c.funder), 0n);
  } finally {
    if (r.dir) rmSync(r.dir, { recursive: true, force: true });
    rmSync(w, { recursive: true, force: true });
  }
});

test("fold 2 G: the final journal says whether the keys were kept or removed, and why", async () => {
  const a = work();
  // kept: the second RPC reads 7 lamports on the funder
  const c1 = wrap(cluster({ landAfter: (tx) => (isDeposit(tx) ? 95_000 : 0) }), (url, { method, params }, real) => (method === "getBalance" && url.includes("localhost") && params[0] !== RETURN ? okR({ value: 7 }) : real()));
  const r1 = await runAt(c1, a.out);
  const b = work();
  const c2 = cluster({ landAfter: (tx) => (isDeposit(tx) ? 95_000 : 0) });
  const r2 = await runAt(c2, b.out);
  try {
    const j1 = JSON.parse(readFileSync(a.journal, "utf8"));
    assert.equal(j1.keys.state, "kept");
    assert.match(j1.keys.why.join(), /holds 7 lamports on http:\/\/localhost:1/);
    const j2 = JSON.parse(readFileSync(b.journal, "utf8"));
    assert.equal(j2.keys.state, "removed");
    assert.ok(j2.keys.why.length >= 1);
  } finally {
    for (const r of [r1, r2]) if (r.dir) rmSync(r.dir, { recursive: true, force: true });
    for (const x of [a, b]) rmSync(x.w, { recursive: true, force: true });
  }
});

test("fold 2 6c: the CLI's own transactions are journaled after each CLI call (cli: true), and never put in the record", async () => {
  const { w, out, journal } = work();
  const CLI_SIG = "4".repeat(87);
  const c = cluster({ poolMissing: true, onSend: (tx) => { if (isInit(tx)) process.emit("SIGHUP", "SIGHUP"); } });
  c.io = { ...c.io, cli: (args) => {
    // the CLI's buffer close: a transaction the funder pays, which this run never signs itself
    if (args[0] === "program" && args[1] === "close") c.txs.set(CLI_SIG, { tx: { signature: CLI_SIG, payer: c.funder, ixs: [{ program: SYSTEM_ID, keys: [c.funder], data: Buffer.alloc(12) }] }, landed: true, err: null, landAt: c.t, sentAt: c.t });
    return { status: 0, stdout: "", stderr: "" };
  } };
  const r = await runAt(c, out);
  try {
    const j = JSON.parse(readFileSync(journal, "utf8"));
    assert.deepEqual(j.txs.find((t) => t.signature === CLI_SIG), { step: "the solana CLI: program close", signature: CLI_SIG, state: "landed", cli: true });
  } finally {
    if (r.dir) rmSync(r.dir, { recursive: true, force: true });
    rmSync(w, { recursive: true, force: true });
  }
});

test("fold 2 8: the signal handlers stay until the record is written; a journal with an unlanded transaction rebuilds to a record of the landed ones", async () => {
  const { w, out } = work();
  const before = process.listenerCount("SIGHUP");
  let duringRecord = null;
  const c = wrap(cluster(), (url, { method }, real) => {
    if (method === "getTransaction" && duringRecord === null) duringRecord = process.listenerCount("SIGHUP");
    return real();
  });
  const r = await runAt(c, out);
  const d = work();
  let rr = null;
  const cd = wrap(cluster(), (url, { method, params }, real) => (method === "sendTransaction" && !params[1]?.skipPreflight && isDeposit(decodeTx(params[0])) ? errR("Transaction simulation failed: Blockhash not found") : real()));
  const rd = await runAt(cd, d.out);
  try {
    assert.equal(r.error, null, String(r.error?.stack));
    assert.equal(duringRecord, before + 1, "the run's handler was still there while it read its record");
    assert.equal(process.listenerCount("SIGHUP"), before);
    const j = JSON.parse(readFileSync(d.journal, "utf8"));
    assert.ok(j.txs.some((t) => t.state === "expired"), "the journal holds an unlanded transaction");
    rr = await runAt(cd, d.out, [], ["--url", "http://127.0.0.1:1", "--rebuild-record", d.journal]);
    assert.equal(rr.error, null, String(rr.error?.stack));
    const rec = JSON.parse(readFileSync(d.out, "utf8"));
    assert.deepEqual(rec.txs.map((t) => t.step), j.txs.filter((t) => t.state === "landed" && !t.cli).map((t) => t.step));
    for (const k of ["pool", "so_sha256", "need", "build", "program_id", "funder"]) assert.ok(rec[k], `the rebuilt record has ${k}`);
    assert.equal(rec.complete, undefined);
  } finally {
    for (const x of [r, rd]) if (x.dir) rmSync(x.dir, { recursive: true, force: true });
    rmSync(w, { recursive: true, force: true });
    rmSync(d.w, { recursive: true, force: true });
  }
});

test("fold 2 9: the journal says when the stop came (stopped_at, the wall clock) and names its RPC by host only", async () => {
  const { w, out, journal } = work();
  const t0 = Date.now();
  const c = cluster({ funderStart: 0n, onRead: stopInWait("SIGINT") });
  const r = await runAt(c, out);
  try {
    const j = JSON.parse(readFileSync(journal, "utf8"));
    const at = Date.parse(j.stopped_at);
    assert.ok(at >= t0 - 1000 && at <= Date.now() + 1000, `stopped_at ${j.stopped_at}`);
    assert.equal(j.rpc, "127.0.0.1:1");
  } finally {
    if (r.dir) rmSync(r.dir, { recursive: true, force: true });
    rmSync(w, { recursive: true, force: true });
  }
});

test("fold 2 4: a run's key folder is durable: under XDG_STATE_HOME or ~/.local/state, never OS temp, a git repo or ~/.confidential-trenches", async () => {
  const m = await import("./deploy.mjs");
  assert.equal(typeof m.keysBase, "function", "deploy.mjs exports keysBase");
  const home = mkdtempSync(path.join(tmpdir(), "fold2-home-"));
  try {
    // a home outside any temp folder is needed for the default: read it from the real home's parent shape
    assert.equal(m.keysBase({ XDG_STATE_HOME: "/srv/state" }, "/home/x"), "/srv/state/pool-sol-deploy");
    assert.equal(m.keysBase({}, "/home/x"), "/home/x/.local/state/pool-sol-deploy");
    assert.throws(() => m.keysBase({ XDG_STATE_HOME: path.join(tmpdir(), "s") }, "/home/x"), /OS temp folder/);
    assert.throws(() => m.keysBase({ XDG_STATE_HOME: path.join(REPO, "state") }, "/home/x"), /inside the git repo or worktree/);
    assert.throws(() => m.keysBase({ XDG_STATE_HOME: "/home/x/.confidential-trenches/state" }, "/home/x"), /under ~\/\.confidential-trenches/);
    assert.throws(() => m.keysBase({}, home), /OS temp folder/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- card pool-sol-deploy-mainnet: the owner's mainnet run ----
const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MAIN_URL = "https://api.mainnet-beta.solana.com";
// pump Global as two mainnet providers answered it (the kit's recorded buy reads, packages/kit/test/fixtures)
const PUMP_FX = JSON.parse(readFileSync(path.join(REPO, "packages/kit/test/fixtures/solana-pool-buy.json"), "utf8")).pump;
const PUMP_KEY = Object.keys(PUMP_FX.reads[0]).find((k) => JSON.parse(k).length === 3);
const PUMP_GLOBAL = JSON.parse(PUMP_KEY)[2];
const PUMP_GLOBAL_ANSWER = { context: PUMP_FX.reads[0][PUMP_KEY].context, value: [PUMP_FX.reads[0][PUMP_KEY].value[2]] };
/** `c` answering as mainnet: its genesis on every URL, and pump Global at finalized. */
const asMainnet = (c, genesis2 = MAINNET) => {
  // CI's build of the recorded code, pinned for the test: never the real gh
  const f = fakeGh();
  Object.assign(c.io, { gh: f.gh, pin: f.sha });
  return asMainnetReads(c, genesis2);
};
const asMainnetReads = (c, genesis2) => wrap(c, (url, { method, params }, real) => {
  if (method === "getGenesisHash") return okR(url === MAIN_URL ? MAINNET : genesis2);
  if (method === "getAccountInfo" && params[0] === RETURN) return okR(sysAccount());
  if (method === "getMultipleAccounts") {
    assert.deepEqual(params[0], [PUMP_GLOBAL]);
    assert.equal(params[1].commitment, "finalized");
    return okR(structuredClone(PUMP_GLOBAL_ANSWER));
  }
  return real();
});
const mainArgs = (out, extra = []) => ["--mainnet", "--url", MAIN_URL, "--ci-run", "41677243428", "--return", RETURN, "--out", out, ...extra];

test("mainnet: refused before any key without --mainnet, with --mainnet on another cluster, on another URL, when the second RPC is not mainnet, or for code that is not the pin", async () => {
  const before = new Set(ls(TEST_KEYS).filter((x) => x.startsWith("pool-sol-deploy-")));
  const { w, out } = work();
  const realLog = console.log;
  console.log = () => {};
  const noCall = (label) => async () => { throw new Error(`${label}: no call after the refusal`); };
  try {
    const f = fakeGh();
    const genesisOnly = (g1, g2 = g1) => async (url, init) => {
      if (JSON.parse(init.body).method === "getGenesisHash") return okR(url === MAIN_URL ? g1 : g2);
      if (isReturnRead(init)) return okR(sysAccount());
      return noCall("read")();
    };
    const io = { gh: f.gh, keysBase: TEST_KEYS, wait: async () => {}, pin: f.sha };
    await assert.rejects(main(mainArgs(out).filter((a) => a !== "--mainnet"), genesisOnly(MAINNET), io), /mainnet refused: its deploy is the owner's.*passes --mainnet/);
    await assert.rejects(main(mainArgs(out), genesisOnly("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"), io), /--mainnet refused: genesis EtWTRAB\S+ at https:\/\/api.mainnet-beta.solana.com is not mainnet's/);
    await assert.rejects(main(mainArgs(out).map((a) => (a === MAIN_URL ? "https://solana-rpc.publicnode.com" : a)), genesisOnly(MAINNET, MAINNET), io), /mainnet refused: --url https:\/\/solana-rpc.publicnode.com is not https:\/\/api.mainnet-beta.solana.com/);
    await assert.rejects(main(mainArgs(out), genesisOnly(MAINNET, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"), io), /mainnet refused: https:\/\/solana-rpc.publicnode.com answers genesis EtWTRAB\S+, not mainnet's/);
    assert.equal(f.calls.length, 0, "no CI read before both RPCs answer mainnet");
    await assert.rejects(main(mainArgs(out), genesisOnly(MAINNET), { ...io, pin: "0".repeat(64) }), /mainnet refused: the code's sha256 [0-9a-f]{64} is not the pinned 0{64}/);
    // the findings file's own pin (c86fc7fc..., 79,088 B) refuses the recorded older build
    await assert.rejects(main(mainArgs(out), genesisOnly(MAINNET), { gh: fakeGh().gh, keysBase: TEST_KEYS, wait: async () => {} }), /mainnet refused: the code's sha256 [0-9a-f]{64} is not the pinned c86fc7fc1b442851c660c5ec0c4f3c4ad8648a5965b5a0da59189fbf0fdb5162/);
  } finally {
    console.log = realLog;
    rmSync(w, { recursive: true, force: true });
  }
  const made = ls(TEST_KEYS).filter((x) => x.startsWith("pool-sol-deploy-") && !before.has(x));
  for (const k of made) rmSync(path.join(TEST_KEYS, k), { recursive: true, force: true });
  assert.deepEqual(made, [], "no key was made");
});

test("--table is the local dry run's only: refused on devnet before any key", async () => {
  const devnet = async (u, init) => {
    if (JSON.parse(init.body).method === "getGenesisHash") return okR("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    if (isReturnRead(init)) return okR(sysAccount());
    throw new Error("no other call");
  };
  await assert.rejects(main(["--url", "https://api.devnet.solana.com", "--return", RETURN, "--table"], devnet, { keysBase: TEST_KEYS }), /--fail-after, --flaky and --table are for the local dry run only/);
});

test("mainnet: the need is the program, the pool, the frozen table, the funder's rent(0), the fees and each priced transaction's bound; no test deposit", async () => {
  const rent = async (n) => BigInt((n + 128) * 6960);
  const soLen = 79_088;
  const writes = BigInt(Math.ceil(soLen / 900));
  const { parts, total } = await needOf(rent, soLen, { mainnet: true, tableLen: 25 });
  assert.deepEqual(Object.keys(parts), ["program_account", "programdata", "pool", "lookup_table", "funder_floor", "fees", "priority"]);
  assert.equal(parts.programdata, BigInt((45 + soLen + 128) * 6960));
  assert.equal(parts.lookup_table, BigInt((56 + 32 * 25 + 128) * 6960));
  assert.equal(parts.fees, FEE_PER_SIGNATURE * (2n + writes + 2n + 1n + 2n + 1n + 2n + 100n));
  assert.equal(parts.priority, (2n + writes + 2n + 100n + 1n + 2n) * (PRIORITY_CU_BOUND * PRIORITY_MICRO_LAMPORTS / 1_000_000n));
  assert.equal(total, Object.values(parts).reduce((a, b) => a + b, 0n));
  // a resume whose pool exists: the table, the floor, its fees and priority only
  const r = await needOf(rent, soLen, { mainnet: true, tableLen: 25, resume: true, poolExists: true });
  assert.deepEqual(Object.keys(r.parts), ["lookup_table", "funder_floor", "fees", "priority"]);
});

test("mainnet: the CLI deploys with mainnet's compute unit price", async () => {
  const f = fakeGh();
  let args = null;
  const c = asMainnet(cluster());
  c.io.cli = (a) => {
    if (a[1] === "deploy") (args = a), (() => { throw new Error("stop after the deploy call"); })();
    return { status: 0, stdout: "", stderr: "" };
  };
  const { w, out } = work();
  const r = await runAt(c, out, [], mainArgs(out));
  try {
    assert.match(String(r.error?.message), /stop after the deploy call/);
    assert.ok(args, "the CLI was asked to deploy");
    assert.deepEqual(args.slice(args.indexOf("--with-compute-unit-price"), args.indexOf("--with-compute-unit-price") + 2), ["--with-compute-unit-price", String(PRIORITY_MICRO_LAMPORTS)]);
    assert.ok(args.includes("--final"));
  } finally {
    if (r.dir) rmSync(r.dir, { recursive: true, force: true });
    rmSync(w, { recursive: true, force: true });
  }
  void f;
});

test("mainnet: init, then the table made from the kit's list, read back, frozen and read back; no deposit; every own send priced; the keys removed once the table is frozen", async () => {
  const f = fakeGh();
  const c = asMainnet(cluster({ poolMissing: true }));
  const { w, out } = work();
  const r = await runAt(c, out, [], mainArgs(out, ["--program", RD.program_id]));
  try {
    assert.equal(r.error, null, String(r.error?.stack) + "\n" + r.said.join("\n"));
    const rec = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(rec.cluster, "mainnet");
    assert.equal(rec.deposit, undefined, "no test deposit on mainnet");
    assert.equal(c.sent.filter((x) => isDeposit(x.tx)).length, 0);
    // the list: the kit's solanaPoolBuyTableAccounts for this pool, pump Global's fee accounts, pages to entry 2,047
    const kit = await import(pathToFileURL(path.join(REPO, "packages/kit/src/trade/solana/pool-buy.ts")).href);
    const venue = await kit.readSolanaPoolBuyVenue([0, 1].map((p) => async (m, params) => structuredClone(PUMP_FX.reads[p][JSON.stringify(params[0])])), "pump-curve", PUMP_FX.mint, () => 0);
    const want = [...new Set(kit.solanaPoolBuyTableAccounts({ program: RD.program_id, pool: RD.pool }, venue, kit.solanaPoolPages(RD.program_id, 1024, 1024)))];
    assert.deepEqual(rec.table_addresses, want);
    assert.equal(want.length, 25);
    const t = c.tables.get(rec.table);
    assert.ok(t, "the record's table is the one made");
    assert.equal(t.authority, null, "frozen");
    assert.deepEqual(t.list, want);
    assert.deepEqual(tableProblems({ owner: ALT_PROGRAM, data: Buffer.from(c.accounts.get(rec.table).data[0], "base64") }, want, null), []);
    // the order: init, create and extend, freeze, then the sweeps; each own send but the sweeps carries the price
    const steps = rec.txs.map((x) => x.step);
    assert.deepEqual(steps.filter((s) => !/funding|sweep/.test(s)), ["init (tag 0)", "lookup table: create and extend with 25 addresses", "lookup table: freeze (authority none)"]);
    for (const x of c.sent) {
      const priced = x.tx.ixs[0].program === COMPUTE_BUDGET;
      assert.equal(priced, x.tx.ixs[0].program !== SYSTEM_ID || x.tx.ixs.length > 1, `${x.tx.ixs.map((i) => i.program).join(",")}`);
      if (priced) assert.equal(Buffer.from(x.tx.ixs[0].data).readBigUInt64LE(1), PRIORITY_MICRO_LAMPORTS);
    }
    assert.ok(c.sent.some((x) => x.tx.ixs[0].program === COMPUTE_BUDGET && x.tx.ixs[1].program === ALT_PROGRAM));
    assert.equal(r.journal, undefined);
    assert.equal(existsSync(r.dir), false, "the keys were removed: the funder at 0 and the table frozen");
    assert.match(r.said.join("\n"), /lookup table \S+ is frozen \(authority none\) and holds exactly the list on both RPCs at finalized/);
  } finally {
    if (r.dir) rmSync(r.dir, { recursive: true, force: true });
    rmSync(w, { recursive: true, force: true });
  }
  void f;
});

test("mainnet: a table the funder still holds authority over keeps the keys, and the journal says why", async () => {
  const c = asMainnet(cluster({ poolMissing: true }));
  // the freeze never lands: the RPC refuses it at preflight each time
  const cc = wrap(c, (url, { method, params }, real) => {
    if (method === "sendTransaction") {
      const tx = decodeTx(params[0]);
      if (tx.ixs.some((x) => x.program === ALT_PROGRAM && x.data[0] === 1)) return errR("Transaction simulation failed: Blockhash not found");
    }
    return real();
  });
  const { w, out, journal } = work();
  const r = await runAt(cc, out, [], mainArgs(out, ["--program", RD.program_id]));
  try {
    assert.match(String(r.error?.message), /Blockhash not found/);
    const j = JSON.parse(readFileSync(journal, "utf8"));
    assert.equal(j.complete, false);
    assert.equal(j.keys.state, "kept");
    assert.ok(j.keys.why.some((x) => /lookup table \S+ still has the funder as its authority/.test(x)), j.keys.why.join("; "));
    assert.match(j.keys.sweep, / --mainnet$/);
    assert.ok(existsSync(r.dir), "the keys stay");
  } finally {
    if (r.dir) rmSync(r.dir, { recursive: true, force: true });
    rmSync(w, { recursive: true, force: true });
  }
});

test("a transaction over 1,232 bytes is refused before it is journaled or sent", async () => {
  const k = newKey();
  const big = { program: SYSTEM_ID, keys: [{ id: k.id, signer: true, writable: true }], data: new Uint8Array(1200) };
  let sent = 0;
  const journal = { signed: () => assert.fail("journaled"), settled: () => {}, pending: () => [] };
  const fetchFn = async (u, init) => {
    const { method } = JSON.parse(init.body);
    if (method === "getLatestBlockhash") return okR({ value: { blockhash: SYSTEM_ID, lastValidBlockHeight: 10 } });
    sent++;
    return okR(null);
  };
  const { sendAndConfirm } = await import("./deploy.mjs");
  await assert.rejects(sendAndConfirm(fetchFn, "http://x", [big], k, [k], { step: "big", journal }), /big: \d+ bytes, over 1232: not signed for sending/);
  assert.equal(sent, 0);
});

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
test("--final's SetAuthority finalized a moment after the deploy: the run waits for authority none at finalized instead of failing a final program (rehearsal 5 Nov)", async () => {
  const f = fakeGh();
  const code = recordedCode();
  let ids = null;
  let pdReads = 0;
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
    switch (method) {
      case "getGenesisHash": return ok("FakeLocalGenesis1111111111111111111111111111");
      case "getMinimumBalanceForRentExemption": return ok((params[0] + 128) * 6960);
      case "getBalance": return ok({ value: 1_000_000_000 });
      case "getSignaturesForAddress": case "getProgramAccounts": return ok([]);
      case "getLatestBlockhash": throw new Error("stop after the deploy's read-back");
      case "getAccountInfo": {
        if (!ids) return ok({ value: null });
        const pdAddr = programDataAddress(ids.program);
        const acc = (owner, executable, data) => ({ value: { owner, executable, lamports: 1, data: [Buffer.from(data).toString("base64"), "base64"] } });
        if (params[0] === ids.program) return ok(acc(LOADER, true, Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.from(b58decode(pdAddr))])));
        if (params[0] === pdAddr) {
          // the finalized reads show the funder as authority twice, then none: --final's second transaction finalizing
          const finalized = params[1]?.commitment === undefined || params[1].commitment === "finalized";
          const meta = Buffer.alloc(45);
          meta.writeUInt32LE(3, 0);
          if (finalized && pdReads++ < 2) (meta[12] = 1), Buffer.from(b58decode(ids.funder)).copy(meta, 13);
          return ok(acc(LOADER, false, Buffer.concat([meta, code])));
        }
        return ok({ value: null });
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const keyOf = (file) => b58(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))).subarray(32, 64));
  const cli = (args) => {
    if (args[1] === "deploy") {
      ids = { program: keyOf(args[args.indexOf("--program-id") + 1]), funder: keyOf(args[args.indexOf("--upgrade-authority") + 1]) };
      return { status: 0, stdout: JSON.stringify({ programId: ids.program, signature: "4".repeat(87) }), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const before = new Set(ls(TEST_KEYS).filter((x) => x.startsWith("pool-sol-deploy-")));
  const w = mkdtempSync(path.join(tmpdir(), "deploy-test-"));
  const realLog = console.log;
  const said = [];
  console.log = (s) => said.push(String(s));
  try {
    await assert.rejects(main(["--url", "http://127.0.0.1:1", "--ci-run", "41677243428", "--return", RETURN, "--out", path.join(w, "record.json")], fetchFn, { wait: async () => {}, cli, gh: f.gh, keysBase: TEST_KEYS }), /stop after the deploy's read-back/);
  } finally {
    console.log = realLog;
    rmSync(w, { recursive: true, force: true });
    for (const k of ls(TEST_KEYS).filter((x) => x.startsWith("pool-sol-deploy-") && !before.has(x))) rmSync(path.join(TEST_KEYS, k), { recursive: true, force: true });
  }
  assert.ok(said.some((l) => /deployed \S+, upgrade authority none/.test(l)), said.join("\n"));
  assert.ok(pdReads >= 3);
});

// ---- the review of ae4a874: each finding a test, red at ae4a874 ----
/** A getAccountInfo of the run's --return (a public cluster reads it before any key). */
function isReturnRead(init) {
  const { method, params } = JSON.parse(init.body);
  return method === "getAccountInfo" && params[0] === RETURN;
}
/** A system account holding `lamports`, as getAccountInfo answers it. */
function sysAccount(lamports = 5_000_000_000) {
  return { context: { slot: 1 }, value: { owner: SYSTEM_ID, executable: false, lamports, data: ["", "base64"], rentEpoch: 0, space: 0 } };
}

test("review 1: mainnet refuses a --return that is off the curve, not a system account, empty, or read differently on the two RPCs, before any key or CI read; a good one is read and the funding line says send from it", async () => {
  const before = new Set(ls(TEST_KEYS).filter((x) => x.startsWith("pool-sol-deploy-")));
  const { w, out } = work();
  const realLog = console.log;
  console.log = () => {};
  const PROGRAM_OWNED = { context: { slot: 1 }, value: { owner: RD.program_id, executable: false, lamports: 1_000_000, data: ["", "base64"] } };
  // a fetch: mainnet's genesis on both, `answer(url, address)` for getAccountInfo, nothing else
  const reads = (answer) => async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "getGenesisHash") return okR(MAINNET);
    if (method === "getAccountInfo") return okR(answer(url, params[0]));
    throw new Error(`no ${method} after the refusal`);
  };
  try {
    const f = fakeGh();
    const io = { gh: f.gh, keysBase: TEST_KEYS, wait: async () => {}, pin: f.sha };
    const withReturn = (r) => mainArgs(out).map((a) => (a === RETURN ? r : a));
    // the pool address: a PDA, 32 bytes that no key signs for
    await assert.rejects(main(withReturn(RD.pool), reads(() => sysAccount()), io), new RegExp(`mainnet refused: --return ${RD.pool} is not on the ed25519 curve`));
    await assert.rejects(main(mainArgs(out), reads(() => PROGRAM_OWNED), io), new RegExp(`mainnet refused: --return ${RETURN} is owned by ${RD.program_id}, not the system program, on ${MAIN_URL.replace(/\./g, "\\.")}`));
    await assert.rejects(main(mainArgs(out), reads(() => ({ context: { slot: 1 }, value: null })), io), new RegExp(`mainnet refused: --return ${RETURN} holds no lamports on ${MAIN_URL.replace(/\./g, "\\.")}`));
    await assert.rejects(main(mainArgs(out), reads((u) => (u === MAIN_URL ? sysAccount() : { context: { slot: 1 }, value: null })), io), /mainnet refused: --return \S+ holds no lamports on https:\/\/solana-rpc\.publicnode\.com/);
    assert.equal(f.calls.length, 0, "no CI read before the return address reads right");
  } finally {
    console.log = realLog;
    rmSync(w, { recursive: true, force: true });
  }
  const made = ls(TEST_KEYS).filter((x) => x.startsWith("pool-sol-deploy-") && !before.has(x));
  for (const k of made) rmSync(path.join(TEST_KEYS, k), { recursive: true, force: true });
  assert.deepEqual(made, [], "no key was made");
  // a good one: the run goes on, and the funding line names where to send from
  const c = asMainnet(cluster({ poolMissing: true }));
  const { w: w2, out: out2 } = work();
  const r = await runAt(c, out2, [], mainArgs(out2, ["--program", RD.program_id]));
  try {
    assert.equal(r.error, null, String(r.error?.stack));
    assert.ok(r.said.some((l) => l.includes(`waiting for `) && l.includes(`send from ${RETURN}`)), r.said.join("\n"));
  } finally {
    if (r.dir) rmSync(r.dir, { recursive: true, force: true });
    rmSync(w2, { recursive: true, force: true });
  }
});

test("review 4: a close or freeze the cleanup gives up on keeps the reserve in the funder, so --sweep-kept can still pay for it", async () => {
  const c = chain({ failures: { closeBuffers: 99 } });
  const r = await cleanup(c.ops, RETURN, fast);
  assert.equal(r.after, CLEANUP_RESERVE, "the reserve stays");
  assert.equal(c.balance, CLEANUP_RESERVE);
  assert.ok(r.problems.some((p) => /kept \d+ lamports in the funder for --sweep-kept: buffer close/.test(p)), r.problems.join("; "));
  // a freeze of the run's live table runs in the cleanup too, after the bulk, before the rest
  const f = chain();
  const r2 = await cleanup({ ...f.ops, freezeTable: async () => void f.calls.push("freezeTable") }, RETURN, fast);
  assert.equal(r2.after, 0n);
  assert.ok(firstTransfer(f) < f.calls.indexOf("freezeTable") && f.calls.indexOf("freezeTable") < lastTransfer(f), f.calls.join(", "));
});

/** A stopped run's journal with its keys kept, made by hand: a funder key in a folder of TEST_KEYS; `extra` fields. */
function keptRun(c, extra = {}) {
  const funder = newKey();
  const dir = mkdtempSync(path.join(TEST_KEYS, "pool-sol-deploy-"));
  writeFileSync(path.join(dir, "funder.json"), JSON.stringify([...funder.secret, ...funder.pub]), { mode: 0o600 });
  const { w, journal } = work();
  const j = { cluster: "localnet", genesis_hash: "FakeLocalGenesis1111111111111111111111111111", program_id: newKey().id, funder: funder.id, return_to: RETURN, complete: false, keys: { folder: path.basename(dir), state: "kept", why: [] }, txs: [], ...extra };
  writeFileSync(journal, JSON.stringify(j));
  // the funder holds what the cleanup kept, funded from the return address
  c.funder = funder.id;
  c.bal.set(funder.id, CLEANUP_RESERVE);
  const order = (c.order = []);
  wrap(c, (url, { method }, real) => (method === "sendTransaction" && order.push("send"), real()));
  return { funder, dir, w, journal, j, done: () => (rmSync(dir, { recursive: true, force: true }), rmSync(w, { recursive: true, force: true })) };
}
const LOCAL_SWEEP = (journal) => ["--url", "http://127.0.0.1:1", "--sweep-kept", journal];
const readJ = (f) => JSON.parse(readFileSync(f, "utf8"));

test("review 4a: --sweep-kept closes a buffer the funder still holds, before its sweep, then removes the keys", async () => {
  const c = cluster();
  const k = keptRun(c);
  const BUF = newKey().id;
  let closed = false;
  c.io.cli = (args) => {
    if (args[1] === "close" && args[2] === "--buffers") (closed = true), c.order.push("close"), assert.equal(args[args.indexOf("--recipient") + 1], RETURN);
    return { status: 0, stdout: "", stderr: "" };
  };
  wrap(c, (url, { method, params }, real) => (method === "getProgramAccounts" && !closed && params[1].filters[0].memcmp.bytes === b58(Uint8Array.of(1, 0, 0, 0)) ? okR([{ pubkey: BUF, account: {} }]) : real()));
  try {
    const s = await runAt(c, path.join(k.w, "x.json"), [], LOCAL_SWEEP(k.journal));
    assert.equal(s.error, null, String(s.error?.stack));
    assert.ok(closed, "the buffer was closed");
    assert.equal(c.order[0], "close", c.order.join(", "));
    assert.equal(c.bal.get(k.funder.id), 0n);
    assert.equal(readJ(k.journal).keys.state, "removed", readJ(k.journal).keys.why.join("; "));
    assert.equal(existsSync(k.dir), false);
  } finally {
    k.done();
  }
});

test("review 4b: --sweep-kept closes a program the funder can still upgrade, before its sweep, then removes the keys", async () => {
  const c = cluster();
  const k = keptRun(c);
  const pd = programDataAddress(k.j.program_id);
  const meta = Buffer.alloc(45);
  meta.writeUInt32LE(3, 0), (meta[12] = 1), Buffer.from(b58decode(k.funder.id)).copy(meta, 13);
  c.accounts.set(pd, { owner: LOADER, executable: false, lamports: 1_000_000, data: [meta.toString("base64"), "base64"] });
  let closed = false;
  c.io.cli = (args) => {
    if (args[1] === "close" && args[2] === k.j.program_id) (closed = true), c.order.push("close"), c.accounts.delete(pd);
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    const s = await runAt(c, path.join(k.w, "x.json"), [], LOCAL_SWEEP(k.journal));
    assert.equal(s.error, null, String(s.error?.stack));
    assert.ok(closed, "the program was closed");
    assert.equal(c.order[0], "close", c.order.join(", "));
    assert.equal(readJ(k.journal).keys.state, "removed", readJ(k.journal).keys.why.join("; "));
  } finally {
    k.done();
  }
});

test("review 4c: --sweep-kept on mainnet freezes the run's table the funder still holds, priced, before its sweep, then removes the keys", async () => {
  const c = asMainnet(cluster());
  const T = newKey().id;
  const k = keptRun(c, { cluster: "mainnet", genesis_hash: MAINNET, table: T });
  const meta = Buffer.alloc(56);
  meta.writeUInt32LE(1, 0), meta.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 4), (meta[21] = 1), Buffer.from(b58decode(k.funder.id)).copy(meta, 22);
  c.tables.set(T, { authority: k.funder.id, list: [RD.pool] });
  c.accounts.set(T, { owner: ALT_PROGRAM, executable: false, lamports: 3_000_000, data: [Buffer.concat([meta, Buffer.from(b58decode(RD.pool))]).toString("base64"), "base64"] });
  c.bal.set(k.funder.id, 10_000_000n);
  try {
    const s = await runAt(c, path.join(k.w, "x.json"), [], ["--mainnet", "--url", MAIN_URL, "--sweep-kept", k.journal]);
    assert.equal(s.error, null, String(s.error?.stack));
    assert.equal(c.tables.get(T).authority, null, "frozen");
    const freeze = c.sent.find((x) => x.tx.ixs.some((i) => i.program === ALT_PROGRAM && i.data[0] === 1));
    assert.equal(freeze.tx.ixs[0].program, COMPUTE_BUDGET, "priced on mainnet");
    assert.equal(c.sent.indexOf(freeze), 0, "before the sweep");
    const j = readJ(k.journal);
    assert.ok(j.txs.some((t) => /lookup table: freeze/.test(t.step) && t.signature === freeze.tx.signature), JSON.stringify(j.txs));
    assert.equal(j.keys.state, "removed", j.keys.why.join("; "));
  } finally {
    k.done();
  }
});

test("review 4d: the run's cleanup freezes its table when the run's own freeze failed; the journal of a mainnet paste names the paste's sweep form", async () => {
  const c = asMainnet(cluster({ poolMissing: true }));
  let refused = 0;
  const cc = wrap(c, (url, { method, params }, real) => {
    if (method === "sendTransaction" && refused === 0 && decodeTx(params[0]).ixs.some((x) => x.program === ALT_PROGRAM && x.data[0] === 1)) return refused++, errR("Transaction simulation failed: Blockhash not found");
    return real();
  });
  const { w, out, journal } = work();
  const r = await runAt(cc, out, [], mainArgs(out, ["--program", RD.program_id]));
  try {
    assert.match(String(r.error?.message), /Blockhash not found/);
    const table = [...c.tables.values()][0];
    assert.equal(table.authority, null, "frozen by the cleanup");
    const j = readJ(journal);
    assert.equal(j.keys.state, "removed", j.keys.why.join("; "));
    assert.ok(j.txs.some((t) => /lookup table: freeze/.test(t.step) && t.state === "landed"));
  } finally {
    if (r.dir) rmSync(r.dir, { recursive: true, force: true });
    rmSync(w, { recursive: true, force: true });
  }
  const { sweepCommand } = await import("./deploy.mjs");
  assert.equal(sweepCommand(path.join(REPO, "contracts/pool-solana/deployments/mainnet.journal.json"), MAIN_URL, "mainnet"), "sh contracts/pool-solana/scripts/mainnet-deploy.sh --sweep-kept");
  assert.equal(sweepCommand(path.join(REPO, "x/record.journal.json"), "http://127.0.0.1:1", "localnet"), "node contracts/pool-solana/scripts/deploy.mjs --sweep-kept x/record.journal.json --url http://127.0.0.1:1");
});
