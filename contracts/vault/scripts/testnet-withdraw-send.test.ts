// The pure parts of testnet-withdraw-send.ts (card relayer-withdraw-send): the relayer's account and key from the
// run's seed, the deadline from two final headers, D's balance check, the spends row check, and the record, which the
// money gate must read with no problem and which names no host, user or local path.
//   node --test contracts/vault/scripts/testnet-withdraw-send.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { relayerKey } from "../../../apps/helper/src/bind/send.ts";
import { isAccountId } from "../../../apps/helper/src/withdraw/checks.ts";
import { parseLive } from "../../../scripts/ci/money-gate.mjs";
import { deadlineMsOf, dShortfall, localProblems, parseArgs, recordText, relayAccountOf, relayKeyOf, spendRowProblems, localNames, NOTE, CARD } from "./testnet-withdraw-send.ts";

const SEED = Buffer.alloc(32, 7);
const P = "bf-vt-20261102t071444.testnet";
const D = "4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a";

test("the relayer account is relay-<8 hex>.<parent>, a NEAR account id, the same for the same seed", () => {
  const a = relayAccountOf(SEED, P);
  assert.match(a, /^relay-[0-9a-f]{8}\.bf-vt-20261102t071444\.testnet$/);
  assert.ok(isAccountId(a));
  assert.equal(relayAccountOf(SEED, P), a);
  assert.notEqual(relayAccountOf(Buffer.alloc(32, 8), P), a);
  assert.throws(() => relayAccountOf(SEED, "x".repeat(60) + ".testnet"), /account id/);
});

test("the relayer's key text is the seed's key, as startRelayer reads it", () => {
  const k = relayKeyOf(SEED);
  assert.match(k.secretKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  assert.deepEqual(Buffer.from(relayerKey(k.secretKey).pub), Buffer.from(k.pub));
  assert.notDeepEqual(Buffer.from(relayKeyOf(Buffer.alloc(32, 8)).pub), Buffer.from(k.pub));
});

test("deadline_ms is the newer final's timestamp_nanosec / 1e6 + 600,000, never header.timestamp", () => {
  assert.equal(deadlineMsOf("1762070400123456789", "1762070399000000000"), 1762070400123 + 600_000);
  assert.equal(deadlineMsOf("1762070399000000000", "1762070400999999999"), 1762070400999 + 600_000);
  assert.throws(() => deadlineMsOf("1762070400123456789", 1762070400123456789 as unknown as string), /timestamp_nanosec/);
  assert.throws(() => deadlineMsOf("-1", "1"), /timestamp_nanosec/);
});

test("D's balances: enough passes, short USDC or NEAR stops with what is missing", () => {
  const need = 300_000_000_000_000_000_000_000n;
  assert.equal(dShortfall({ usdc: 3_000_000n, near: 932_448_318_861_943_499_999_994n }, need), null);
  assert.match(dShortfall({ usdc: NOTE - 1n, near: need }, need) ?? "", /USDC 999999, needs 1000000/);
  assert.match(dShortfall({ usdc: NOTE, near: need - 1n }, need) ?? "", /NEAR/);
  assert.match(dShortfall({ usdc: null, near: null }, need) ?? "", /USDC none/);
});

test("the spends row: settled, recipient D, fee = relay_fee, payer the relayer, the whole note", () => {
  const want = { recipient: D, fee: 123_456n, payer: "relay-0a1b2c3d.p.testnet", withdrawn: NOTE };
  const row = { status: "settled", recipient: D, fee: 123_456n, payer: "relay-0a1b2c3d.p.testnet", withdrawn: NOTE };
  assert.deepEqual(spendRowProblems(row, want), []);
  assert.equal(spendRowProblems(undefined, want).length, 1);
  assert.match(spendRowProblems({ ...row, status: "paid" }, want).join(), /status paid/);
  assert.match(spendRowProblems({ ...row, recipient: "x.testnet" }, want).join(), /recipient/);
  assert.match(spendRowProblems({ ...row, fee: 1n }, want).join(), /fee/);
  assert.match(spendRowProblems({ ...row, payer: D }, want).join(), /payer/);
  assert.match(spendRowProblems({ ...row, withdrawn: 1n }, want).join(), /withdrawn/);
});

const H = (c: string) => c.repeat(44);
const record = {
  accounts: { P, D, R: "relay-0a1b2c3d.bf-vt-20261102t071444.testnet" },
  txs: [
    { step: "setup", method: "CreateAccount (R)", hash: H("A"), signer: P },
    { step: "deposit", method: "storage_prepay", hash: H("B"), signer: D },
    { step: "withdraw", method: "withdraw", hash: H("C"), signer: "relay-0a1b2c3d.bf-vt-20261102t071444.testnet" },
  ],
  prose: ["Steps: P makes R; D deposits; R withdraws and settles.", "Spends row #3: settled, fee 123456."],
};

test("the record reads in the money gate as a money-path live record listing every tx, with no problem", () => {
  const text = recordText(record);
  const r = parseLive(text, CARD);
  assert.ok(r);
  assert.deepEqual(r.problems, []);
  assert.equal(r.moneyPath, true);
  assert.deepEqual(r.txs.map((t: { hash: string }) => t.hash), record.txs.map((t) => t.hash));
  assert.deepEqual(r.real, []);
  assert.deepEqual(localProblems(text), []);
});

test("a record line naming a tx no Tx line lists is refused by the gate", () => {
  const text = recordText({ ...record, prose: [...record.prose, `The settle tx ${H("Z")} landed.`] });
  assert.match(parseLive(text, CARD).problems.join(), /no parsed Tx line lists/);
});

test("a host, user or local path in the record is refused", () => {
  const names = ["box-host-1", "someone"];
  for (const bad of ["/home/u/rws/state.json", "/Users/u/x", "ran on box-host-1", "by someone today", "C:\\Users\\x", "/private/tmp/x"]) {
    assert.equal(localProblems(recordText({ ...record, prose: [bad] }), names).length, 1, bad);
  }
  assert.deepEqual(localProblems(recordText(record), names), []);
  // this machine's own names are read at run time, never written here
  for (const n of localNames()) assert.equal(localProblems(`x ${n} y`).length, 1, "this machine's name");
});

test("the arguments: --dry needs nothing; a run needs --parent, --key-file, --t04-state and --state", () => {
  assert.deepEqual(parseArgs(["--dry"]), { dry: true });
  const full = ["--parent", P, "--key-file", "/k.json", "--t04-state", "/t.json", "--state", "/s.json"];
  assert.deepEqual(parseArgs(full), { dry: false, parent: P, keyFile: "/k.json", t04State: "/t.json", state: "/s.json", out: "scripts/live-checks/relayer-withdraw-send.md" });
  assert.equal(parseArgs([...full, "--out", "x.md"]).out, "x.md");
  assert.throws(() => parseArgs(full.slice(2)), /--parent/);
  assert.throws(() => parseArgs([...full, "--key"]), /unknown argument --key/);
});
