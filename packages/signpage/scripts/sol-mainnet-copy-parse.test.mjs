// The mainnet copy run's own parsing (./sol-mainnet-copy-parse.mjs): the clone plan, the lookup table's reset, the coins picked from the
// helper's lists, and each transaction's record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALT_PROGRAM, COMPUTE_BUDGET, RENT_FEATURES, UPGRADEABLE_LOADER, clonePlan, copyAccountFile, cuLimitOf, listCandidates, pendingFeature, simFailure, txRecord } from "./sol-mainnet-copy-parse.mjs";

const b64 = (b) => Buffer.from(b).toString("base64");
/** A frozen lookup table's bytes: tag 1, deactivation u64::MAX, last extended `slot` at start index 24, no authority. */
const table = (slot) => {
  const d = Buffer.alloc(56 + 32 * 2);
  d.writeUInt32LE(1, 0);
  d.writeBigUInt64LE(0xffffffffffffffffn, 4);
  d.writeBigUInt64LE(slot, 12);
  d[20] = 24;
  d.fill(7, 56);
  return d;
};

test("a lookup table's last extended slot is set to 0 and nothing else changes", () => {
  const raw = table(468_000_000n);
  const { file, reset } = copyAccountFile("T", { lamports: 5, owner: ALT_PROGRAM, executable: false, data: [b64(raw), "base64"] });
  const got = Buffer.from(file.account.data[0], "base64");
  assert.equal(reset, true);
  assert.equal(got.readBigUInt64LE(12), 0n);
  assert.deepEqual(got.subarray(0, 12), raw.subarray(0, 12));
  assert.deepEqual(got.subarray(20), raw.subarray(20));
  assert.equal(file.account.space, raw.length);
  assert.equal(raw.readBigUInt64LE(12), 468_000_000n, "the read's own bytes are left alone");
});

test("any other account is copied byte for byte", () => {
  const raw = table(9n); // the same bytes under another owner are not a table
  const { file, reset } = copyAccountFile("A", { lamports: 1, owner: "11111111111111111111111111111111", executable: false, data: [b64(raw), "base64"] });
  assert.equal(reset, false);
  assert.equal(file.account.data[0], b64(raw));
  assert.throws(() => copyAccountFile("B", { lamports: 1, owner: "x", data: ["", "base58"] }), /not a base64 account/);
});

test("the clone plan: upgradeable programs, files, keys mainnet lacks, and other executables left to the validator", () => {
  const plain = { lamports: 1, owner: "Own", executable: false, data: ["", "base64"] };
  const plan = clonePlan(["P", "A", "N", "L"], [{ ...plain, owner: UPGRADEABLE_LOADER, executable: true }, plain, null, { ...plain, owner: "BPFLoader2111111111111111111111111111111111", executable: true }]);
  assert.deepEqual(plan.programs, ["P"]);
  assert.deepEqual(plan.files.map((f) => f.pubkey), ["A"]);
  assert.deepEqual(plan.missing, ["N"]);
  assert.deepEqual(plan.skipped, ["L"]);
  assert.throws(() => clonePlan(["P", "A"], [null]), /does not answer every key/);
});

test("a pending feature account holds activated_at None", () => {
  for (const f of RENT_FEATURES) {
    const a = pendingFeature(f).account;
    assert.equal(a.owner, "Feature111111111111111111111111111111111111");
    assert.deepEqual([...Buffer.from(a.data[0], "base64")], new Array(9).fill(0));
  }
});

test("the coins come from pump.fun tokens of the helper's lists, each once, new and graduating first", () => {
  const lists = {
    chain: "solana",
    lists: {
      trending: [{ token: "Gpump", launchpad: null, symbol: "G" }, { token: "cbBTC", launchpad: null }],
      new: [{ token: "Npump", launchpad: "pump.fun", symbol: "N" }, { token: "Other", launchpad: "bonk" }],
      graduating: [{ token: "Cx", launchpad: "pump.fun" }, { token: "Npump", launchpad: "pump.fun" }],
    },
  };
  assert.deepEqual(listCandidates(lists).map((c) => [c.mint, c.list]), [["Npump", "new"], ["Cx", "graduating"], ["Gpump", "trending"]]);
  assert.throws(() => listCandidates({ error: { code: "not_found" } }), /not a lists answer/);
});

test("a transaction's record: result, compute units against its limit, fee, logs on a failure, watched lamports", () => {
  const limit = Buffer.alloc(5);
  limit[0] = 2;
  limit.writeUInt32LE(450_000, 1);
  const tx = (err) => ({
    slot: 120,
    transaction: { message: { accountKeys: ["FP", "W", COMPUTE_BUDGET], instructions: [{ programIdIndex: 2, data: b64(limit), accounts: [] }], addressTableLookups: [{ accountKey: "T" }] } },
    meta: { err, fee: 10_000, computeUnitsConsumed: 312_345, logMessages: Array.from({ length: 20 }, (_, i) => `line ${i}`), preBalances: [5, 100, 1], postBalances: [6, 40, 1], loadedAddresses: { writable: ["TIP"], readonly: [] } },
  });
  tx(null).meta.preBalances.push(0);
  const ok = txRecord("curve", "buy", "S", { ...tx(null), meta: { ...tx(null).meta, preBalances: [5, 100, 1, 0], postBalances: [6, 40, 1, 100_000] } }, { W: "W", tip: "TIP" });
  assert.deepEqual(
    { ok: ok.ok, cu: ok.cu, cuLimit: ok.cuLimit, fee: ok.fee, lookups: ok.lookups, logs: ok.logsTail, w: ok.lamports.W.change, tip: ok.lamports.tip.change },
    { ok: true, cu: 312_345, cuLimit: 450_000, fee: 10_000, lookups: ["T"], logs: undefined, w: -60, tip: 100_000 },
  );
  const bad = txRecord("mayhem", "buy", "S2", tx({ InstructionError: [3, { Custom: 6000 }] }));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.err, { InstructionError: [3, { Custom: 6000 }] });
  assert.deepEqual(bad.logsTail, Array.from({ length: 12 }, (_, i) => `line ${i + 8}`));
  assert.deepEqual(txRecord("x", "sell", "S3", null), { coin: "x", step: "sell", signature: "S3", found: false });
  assert.equal(cuLimitOf(["A"], [{ programIdIndex: 0, data: b64(limit) }], (x) => Buffer.from(x, "base64")), null);
});

test("a failed simulation keeps its error, units and last log lines; a good one is none", () => {
  assert.equal(simFailure({ err: null, logs: ["a"] }), null);
  assert.deepEqual(simFailure({ err: "X", unitsConsumed: 5, logs: ["a", "b"] }), { err: "X", cu: 5, logsTail: ["a", "b"] });
});
