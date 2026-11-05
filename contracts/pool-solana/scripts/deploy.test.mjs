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
import { cleanup, compileMessage, newKey, needOf, signTx, transferIx, CLEANUP_RESERVE, DEPOSIT, FEE_PER_SIGNATURE } from "./deploy.mjs";
import { b58decode, labelOf, scopeOf, poolAddress, programDataAddress } from "../../../scripts/live-checks/pool-sol-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "../../..");
const req = createRequire(path.join(REPO, "packages/kit/package.json"));
const { poseidon3 } = await import(pathToFileURL(req.resolve("poseidon-lite")).href);
const { ed25519 } = await import(pathToFileURL(req.resolve("@noble/curves/ed25519.js")).href);
const RETURN = "CTnQzcmRUwDYkBx9cuyfcAidQZ6ogo27uGmWFEUyQGvb";

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
  const before = new Set(ls(tmpdir()).filter((f) => f.startsWith("pool-sol-deploy-")));
  const said = [];
  const realLog = console.log;
  console.log = (s) => said.push(String(s));
  try {
    await assert.rejects(main(["--url", "http://127.0.0.1:1", "--no-build", "--so", soFile, "--program", RD.program_id, "--return", RETURN, "--out", path.join(work, "record.json")], fetchFn,
      { wait: async () => {}, cli: () => ({ status: 0, stdout: "", stderr: "" }) }));
  } finally {
    console.log = realLog;
  }
  const kept = ls(tmpdir()).filter((f) => f.startsWith("pool-sol-deploy-") && !before.has(f)).map((f) => path.join(tmpdir(), f));
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
    throw new Error("no other call before the code is CI's");
  };
  const run = (args, opts = {}) => main(["--url", "https://api.devnet.solana.com", "--return", RETURN, ...args], devnet, opts);
  for (const args of [[], ["--no-build"], ["--no-build", "--so", "x.so"]]) await assert.rejects(run(args), /devnet takes CI's build only: --ci-run/);
  const f = fakeGh({ view: { jobs: [{ name: "pool-solana", conclusion: "failure", databaseId: 126061058748 }] } });
  await assert.rejects(run(["--ci-run", "41677243428"], { gh: f.gh }), /pool-solana job is failure/);
  assert.equal(f.calls.length, 1);
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
  const before = new Set(ls(tmpdir()).filter((x) => x.startsWith("pool-sol-deploy-")));
  const work = mkdtempSync(path.join(tmpdir(), "deploy-test-"));
  const realLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(main(["--url", "http://127.0.0.1:1", "--ci-run", "41677243428", "--return", RETURN, "--out", path.join(work, "record.json")], fetchFn, { wait: async () => {}, cli, gh: f.gh }), /stop after the deploy call/);
  } finally {
    console.log = realLog;
    rmSync(work, { recursive: true, force: true });
    for (const k of ls(tmpdir()).filter((x) => x.startsWith("pool-sol-deploy-") && !before.has(x))) rmSync(path.join(tmpdir(), k), { recursive: true, force: true });
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
    const data = b.subarray(o + 1, o + 1 + b[o]);
    o += 1 + b[o];
    ixs.push({ program, keys: ks, data });
  }
  return { signature, payer: keys[0], ixs };
}
const SYSTEM_ID = "11111111111111111111111111111111";
const FUND_SIG = "5".repeat(87);
function cluster({ funderStart = 1_000_000_000n, landAfter = () => 0, onSend = () => {}, poolMissing = false, onRead = () => {} } = {}) {
  // `funding`: whether the funder's incoming transfer (FUND_SIG) has landed; a funder that starts funded has it
  const c = { t: 0, bal: new Map(), txs: new Map(), sent: [], funder: null, credit: [], funding: funderStart > 0n, said: [], accounts: new Map() };
  const balOf = (a) => c.bal.get(a) ?? 0n;
  const apply = (tx) => {
    const ix = tx.ixs[0];
    let cost = FEE_PER_SIGNATURE;
    let to = null;
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
        return ok(REC.good.find((x) => x.method === method && x.params[0] === params[0])?.json.result ?? { value: null });
      }
      case "getBalance": {
        if (params[0] !== RETURN && !c.funder) (c.funder = params[0]), c.bal.set(params[0], funderStart);
        return ok({ value: Number(balOf(params[0])) });
      }
      case "getSignaturesForAddress": {
        const mine = [...c.txs.values()].filter((x) => x.landed && x.tx.payer === params[0]).map((x) => ({ signature: x.tx.signature, err: x.err }));
        return ok(params[0] === c.funder && c.funding ? [...mine.reverse(), { signature: FUND_SIG, err: null }] : mine.reverse());
      }
      case "getProgramAccounts": return ok([]);
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
        const payer = x ? x.tx.payer : RETURN;
        return ok({ slot: x ? Math.floor(x.landAt / 400) + 1 : 0, meta: { err: x ? x.err : null }, transaction: { message: { accountKeys: [payer], instructions: [] } } });
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  c.io = { wait: async (ms) => void (c.t += ms), now: () => c.t, cli: () => ({ status: 0, stdout: "", stderr: "" }) };
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
const isDeposit = (tx) => tx.ixs[0].program !== SYSTEM_ID && tx.ixs[0].data[0] === 1;
const isInit = (tx) => tx.ixs[0].program !== SYSTEM_ID && tx.ixs[0].data[0] === 0;
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
const sweptTo = (c) => c.sent.filter((x) => x.landed && !x.err && x.tx.ixs[0].program === SYSTEM_ID && x.tx.ixs[0].keys[1] === RETURN)
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
  assert.equal(r.kept, false, "the keys are removed after the sweep read the funder 0");
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
