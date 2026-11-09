// node --test contracts/vault/scripts/mainnet-money-state.test.ts: the mainnet money run's review folds (card
// vault-mainnet-money), offline. The withdrawal goes to the account the owner names, which must exist on both RPCs, with
// fund_recipient false and no change note (F1, F3, F7); a stop resumes from the seed with no time bound and no advice to
// start over (F2); the seed is written once, mode 600, and each step in its own file, so a stop mid-write loses neither
// (F4); a step of another seed is never used (F5); the record holds every tx (F8); and U is opened by this script's own
// signing, with no package downloaded next to the key (F9).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, linkSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bindProblem, ownDeposit, runStepProblems, feeProblems, recordRead, fingerprintOf, registerProblems, retried, sendAnswerError, noteToWithdraw, recipientProblems, recordProblems, relayerTxProblems, replanAt, requestProblems, stateDir, storeOfLane, sweepProblems, uSigner } from "./mainnet-money.ts";
import { createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import * as MM from "./mainnet-money.ts";
import { noteCommitment, noteSecrets } from "../../../packages/wallet/src/notes/secrets.ts";
import { restorePages, writeRestored } from "../../../packages/wallet/src/notes/restore.ts";
import { depositAccount } from "../../../packages/wallet/src/deposit/account.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const SRC = readFileSync(path.join(HERE, "mainnet-money.ts"), "utf8");
const VAULT = "vault.confidential.unrlzd.near";
const TOKEN = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const fresh = () => mkdtempSync(path.join(tmpdir(), "vmm-state-"));
const ROOTS = [ROOT];

test("F1: the named account must exist on both RPCs; the vault, intents.near, the token or a bad id is refused", () => {
  const ok = { amount: "1" };
  assert.deepEqual(recipientProblems("owner.near", { vault: VAULT, token: TOKEN, reads: [ok, ok] }), []);
  assert.match(recipientProblems("owner.near", { vault: VAULT, token: TOKEN, reads: ["absent", "absent"] }).join(), /no such account on either RPC/);
  assert.match(recipientProblems("owner.near", { vault: VAULT, token: TOKEN, reads: [ok, "absent"] }).join(), /no such account on one RPC/);
  assert.match(recipientProblems("owner.near", { vault: VAULT, token: TOKEN, reads: [ok, null] }).join(), /two operators/);
  assert.match(recipientProblems("owner.near", { vault: VAULT, token: TOKEN, reads: [ok] }).join(), /two operators/);
  for (const to of [VAULT, "intents.near", TOKEN]) assert.match(recipientProblems(to, { vault: VAULT, token: TOKEN, reads: [ok, ok] }).join(), /the vault, intents.near or the token/);
  for (const to of [undefined, "", "Owner.near", "a", "x".repeat(65), "owner..near"]) assert.match(recipientProblems(to, { vault: VAULT, token: TOKEN, reads: [ok, ok] }).join(), /not a NEAR account id/);
});

test("H1: the named account may not be U, the fee recipient or the relayer: the payout would go to the run's own accounts", () => {
  const ok = { amount: "1" };
  const others = ["a".repeat(64), "f.near", "r.near"];
  for (const to of others) assert.match(recipientProblems(to, { vault: VAULT, token: TOKEN, others, reads: [ok, ok] }).join(), /U, the fee recipient or the relayer/, to);
  assert.deepEqual(recipientProblems("owner.near", { vault: VAULT, token: TOKEN, others, reads: [ok, ok] }), []);
  assert.match(SRC, /recipientProblems\(to, \{ vault: o\.vault, token: o\.token, others: \[o\.relayers\.withdraw\.relayer_account, o\.relayers\.withdraw\.fee_recipient, \.\.\.others\]/);
  assert.match(SRC, /checkRecipient\(o, v\["--to"\], \[U\]\)/);
});

test("F1, F7: a request that pays anyone but the named account, funds a recipient or leaves change is refused before it is sent", () => {
  const req = { noteId: "n1", recipient: "owner.near", changeValue: 0n, body: { fund_recipient: false } };
  assert.deepEqual(requestProblems(req, "owner.near", "n1"), []);
  // main's withdrawRequest ignores `to` and pays the note's A_{l,j} with fund_recipient true: two refusals
  const arming = { noteId: "n1", recipient: "a".repeat(64), changeValue: 0n, body: { fund_recipient: true } };
  const p = requestProblems(arming, "owner.near", "n1");
  assert.ok(p.some((x) => /pays a{64}, not owner.near/.test(x)) && p.some((x) => /fund_recipient is true/.test(x)), p.join("\n"));
  assert.match(requestProblems({ ...req, changeValue: 1n }, "owner.near", "n1").join(), /change note of 1/);
  // F4 (27): a request that spends a note other than the one the run picked is refused, the proof made and nothing sent
  assert.match(requestProblems({ ...req, noteId: "n2" }, "owner.near", "n1").join(), /spends note n2, not the run's n1/);
});

test("F1, F7: the driver withdraws the note's whole value less one fee to --to, through the wallet's own request", () => {
  assert.match(SRC, /amount: value - fee\.relayFee, to,/);
  assert.doesNotMatch(SRC, /withdrawHandoff\(/, "the form's two-quote draw leaves a lower quote's difference as change");
  assert.match(SRC, /requestProblems\(req, to, pick\.id\);\n\s+if \(rp\.length\) throw[\s\S]{0,700}relayWithdraw\(/, "the request is checked before it is sent");
});

test("F2: resume is a command, the wait for U has no time bound, and U holds at least min_deposit, not a fixed amount", () => {
  assert.match(SRC, /resume: \(\) => go\(rest, false\)/);
  assert.doesNotMatch(SRC, /FUND_BOUND_MS|AMOUNT = 5_000_000n/);
  assert.match(SRC, /BigInt\(usdc\) >= minDeposit/);
  assert.match(SRC, /restoreNotes\(\{ seed64, vault, token, rpcs \}\)/);
  // a fresh store draws its lane at random: the run's index i is planned again in a store of lane i % 8
  assert.match(SRC, /storeOfLane\(i % LANES\)/);
});

test("F2: a stopped run plans the same index, U and precommitment again, in a fresh store of the index's lane", async () => {
  const seed64 = Uint8Array.from({ length: 64 }, (_, k) => k + 1);
  const scope = 12345n;
  const lanes = new Set<number>();
  for (let t = 0; t < 12; t++) {
    const a = await storeOfLane(null);
    const n1 = await a.ns.planDeposit(scope, (ref: any) => noteSecrets(seed64, ref).precommitment);
    lanes.add(a.w.lane);
    a.ns.close();
    a.w.close();
    const i = n1.ref.i as number;
    assert.equal(i % 8, a.w.lane);
    const b = await storeOfLane(i % 8);
    const n2 = await replanAt(b.w, b.ns, seed64, scope, i);
    assert.equal(n2.ref.i, i);
    assert.equal(n2.precommitment, n1.precommitment);
    assert.equal(depositAccount(seed64, scope, n2.ref.i).account, depositAccount(seed64, scope, i).account);
    b.ns.close();
    b.w.close();
  }
  assert.ok(lanes.size > 1, "fresh stores drew one lane only: the case a lane change makes is not covered");
});

test("F2: no refusal tells the owner to start a new run or move the state folder", () => {
  const msgs = [...SRC.matchAll(/(?:new Error|log|console\.error)\(`([^`]*)`/g)].map((m) => m[1]!);
  assert.ok(msgs.length > 20, `${msgs.length} messages read`);
  for (const m of msgs) assert.doesNotMatch(m, /new --state|another --state|a fresh --state|move the|rename|delete the|remove the/i, m);
  assert.throws(() => stateDir(fresh(), ROOTS, { create: false }), (e: Error) => /holds no seed/.test(e.message) && !/new|move/.test(e.message));
});

test("F4: the seed is written once, mode 600, by a temporary file, fsync and link; never overwritten", () => {
  const dir = path.join(fresh(), "run");
  const calls: string[] = [];
  const fs = {
    openSync: (p: string, f: string, m?: number) => (calls.push(`open ${path.basename(p).replace(/\..*\.tmp$/, ".tmp")} ${f} ${m?.toString(8) ?? ""}`.trim()), openSync(p, f, m)),
    writeSync: (fd: number, s: string) => (calls.push("write"), writeSync(fd, s)),
    fsyncSync: (fd: number) => (calls.push("fsync"), fsyncSync(fd)),
    closeSync: (fd: number) => (calls.push("close"), closeSync(fd)),
    linkSync: (a: string, b: string) => (calls.push(`link ${path.basename(b)}`), linkSync(a, b)),
    renameSync: (a: string, b: string) => (calls.push(`rename ${path.basename(b)}`), renameSync(a, b)),
    unlinkSync: (p: string) => (calls.push("unlink tmp"), unlinkSync(p)),
  } as never;
  const a = stateDir(dir, ROOTS, { create: true, fs });
  assert.deepEqual(calls, ["open seed.tmp wx 600", "write", "fsync", "close", "link seed", "unlink tmp", "open run r", "fsync", "close"]);
  assert.equal(statSync(path.join(dir, "seed")).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const seed = readFileSync(path.join(dir, "seed"), "utf8");
  // a second open, of either kind, reads the same seed and writes nothing
  calls.length = 0;
  const b = stateDir(dir, ROOTS, { create: true, fs });
  assert.deepEqual(calls, []);
  assert.deepEqual(b.seed, a.seed);
  assert.equal(readFileSync(path.join(dir, "seed"), "utf8"), seed);
  assert.deepEqual(readdirSync(dir), ["seed"]);
  // a seed readable by others, or not a seed, is refused
  const d2 = path.join(fresh(), "r");
  stateDir(d2, ROOTS, { create: true });
  writeFileSync(path.join(d2, "seed"), "nope\n", { mode: 0o600 });
  assert.throws(() => stateDir(d2, ROOTS, { create: false }), /not a seed this driver wrote/);
  // inside the repository is refused
  assert.throws(() => stateDir(path.join(ROOT, "tmp-state"), ROOTS, { create: true }), /inside the repository/);
});

test("F4: each step is its own file, written by temporary file, fsync and rename; a failed write leaves the old step and the seed", () => {
  const dir = path.join(fresh(), "run");
  const st = stateDir(dir, ROOTS, { create: true });
  const seed = readFileSync(path.join(dir, "seed"), "utf8");
  st.write("run", { i: 3 });
  st.write("deposit", { amount: "1000000" });
  assert.deepEqual(readdirSync(dir).sort(), ["deposit.json", "run.json", "seed"]);
  assert.equal(statSync(path.join(dir, "run.json")).mode & 0o777, 0o600);
  // a stop between the temporary file's write and its rename: the step reads as before, the seed as before
  const broken = stateDir(dir, ROOTS, {
    create: false,
    fs: { openSync, writeSync, fsyncSync, closeSync, linkSync, unlinkSync, renameSync: () => { throw new Error("stopped"); } } as never,
  });
  assert.throws(() => broken.write("run", { i: 4 }), /stopped/);
  assert.deepEqual(st.read("run"), { i: 3 });
  assert.deepEqual(st.read("deposit"), { amount: "1000000" });
  assert.equal(readFileSync(path.join(dir, "seed"), "utf8"), seed);
  assert.throws(() => st.write("seed" as never, {}), /no step/);
});

test("L1: the run step is written once, as the seed is: a second first plan on the folder is refused, the first kept", () => {
  const dir = path.join(fresh(), "run");
  const a = stateDir(dir, ROOTS, { create: true });
  const b = stateDir(dir, ROOTS, { create: true });
  a.writeOnce("run", { i: 2, U: "u2" });
  assert.throws(() => b.writeOnce("run", { i: 5, U: "u5" }), /planned first[^]*paste the same line again/);
  assert.deepEqual(b.read("run"), { i: 2, U: "u2" });
  assert.equal(statSync(path.join(dir, "run.json")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).sort(), ["run.json", "seed"]);
  assert.match(SRC, /st\.writeOnce\("run", run\)/);
  assert.doesNotMatch(SRC, /st\.write\("run"/);
});

test("L1: a seed file not in this driver's own format (64 lowercase hex and one newline, mode 600) is refused", () => {
  for (const text of ["A".repeat(64) + "\n", "a".repeat(64), "a".repeat(64) + "\n\n", " " + "a".repeat(64) + "\n", '{"seed":"' + "a".repeat(64) + '"}\n']) {
    const dir = path.join(fresh(), "r");
    stateDir(dir, ROOTS, { create: true });
    writeFileSync(path.join(dir, "seed"), text, { mode: 0o600 });
    assert.throws(() => stateDir(dir, ROOTS, { create: false }), /not a seed this driver wrote/, JSON.stringify(text));
  }
});

test("F5: a step of another seed is told apart by its fingerprint; the driver checks it before U is used", () => {
  const a = stateDir(path.join(fresh(), "a"), ROOTS, { create: true });
  const b = stateDir(path.join(fresh(), "b"), ROOTS, { create: true });
  assert.notEqual(fingerprintOf(a.seed), fingerprintOf(b.seed));
  assert.equal(fingerprintOf(a.seed), fingerprintOf(Buffer.from(a.seed)));
  assert.doesNotMatch(fingerprintOf(a.seed), new RegExp(a.seed.toString("hex")));
  // every command that uses the run step (check, run/resume, open-u, sweep-u, record) refuses one of another seed
  assert.equal([...SRC.matchAll(/fingerprint !== (?:fingerprintOf\(st\.seed\)|fp)/g)].length, 5);
  assert.doesNotMatch(SRC, /\.u`|\.u"/, "no loose U file beside the state");
});

test("F8: the record holds U's opening, its funding, the deposit and the withdrawal, and the settle of a settled row", () => {
  const all = { fund: 1, deposit: 1, withdraw: 1, status: "paid", settle: 0 };
  assert.deepEqual(recordProblems(all), []);
  assert.deepEqual(recordProblems({ ...all, status: "settled", settle: 1 }), []);
  assert.match(recordProblems({ ...all, fund: 0 }).join(), /--fund-tx/);
  assert.match(recordProblems({ ...all, deposit: 0 }).join(), /deposit tx/);
  assert.match(recordProblems({ ...all, withdraw: 0 }).join(), /withdrawal tx/);
  assert.match(recordProblems({ ...all, status: "settled" }).join(), /--settle-tx/);
  assert.match(recordProblems({ ...all, status: "in_flight" }).join(), /not paid or settled/);
  // every relayer tx is kept in the heard step the moment it is heard, so a stop loses none
  assert.match(SRC, /heard\[leg\]\.push\(h\);\s*st\.write\("heard", heard\)/);
});

test("F9: U is opened by this script's own signing from the key file; no package is downloaded or run beside the key", () => {
  assert.match(SRC, /"open-u": \(\) => openU\(rest\)/);
  assert.match(SRC, /loadKey\(v\["--key-file"\], payer, repoRoots\(\)\)/);
  const paste = readFileSync(path.join(HERE, "mainnet-money", "2-open-u.sh"), "utf8");
  assert.doesNotMatch(paste, /npx|near-cli|npm exec|pnpm dlx|curl|wget/);
  assert.match(paste, /mainnet-money\.ts open-u /);
});

test("H2: sweep-u signs as U with U's own key, derived here from the seed: the key's public side is U", () => {
  const seed64 = Uint8Array.from({ length: 64 }, (_, k) => 200 - k);
  const scope = 777n;
  for (const i of [0, 5, 13]) {
    const U = depositAccount(seed64, scope, i).account;
    const k = uSigner(seed64, scope, i, U);
    assert.equal(Buffer.from(k.pub).toString("hex"), U);
    const msg = Buffer.from("sweep");
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(k.pub).toString("base64url") }, format: "jwk" });
    assert.ok(edVerify(null, msg, pub, edSign(null, msg, k.privateKey)));
    assert.throws(() => uSigner(seed64, scope, i + 1, U), /not the run's U/);
  }
});

test("H2: a sweep sends U's whole USDC to the named account, refused when the account cannot take it", () => {
  assert.deepEqual(sweepProblems({ balance: 4_000_000n, toRegistered: true }), []);
  assert.match(sweepProblems({ balance: 0n, toRegistered: true }).join(), /holds no USDC/);
  assert.match(sweepProblems({ balance: 4_000_000n, toRegistered: false }).join(), /not registered on the token/);
  assert.match(SRC, /"sweep-u": \(\) => sweepU\(rest\)/);
  assert.match(SRC, /act\.call\("ft_transfer", \{ receiver_id: to, amount: String\(balance\) \}, 30n \* TGAS, 1n\)/);
  // every way USDC stays at U names the way out: a bind that did not deposit, and USDC left after the deposit
  assert.match(SRC, /deposit: \$\{why\} \(\$\{json\(outcome\)\}\)[^`]*sweep-u/);
  assert.match(SRC, /still holds \$\{left\} USDC[^`]*sweep-u/);
  assert.match(SRC, /\.\.\.withdraws, \.\.\.sweeps,/, "the record holds every sweep");
  const paste = readFileSync(path.join(HERE, "mainnet-money", "4-sweep-u.sh"), "utf8");
  assert.match(paste, /mainnet-money\.ts sweep-u --commit "\$1" --state /);
  assert.match(readFileSync(path.join(HERE, "mainnet-money", "1-run.sh"), "utf8"), /one transfer/);
});

// a transaction as EXPERIMENTAL_tx_status returns it (result.transaction)
const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64");
const RUN = { U: "c".repeat(64), G: "g.near", R: "r.near", vault: VAULT, token: TOKEN, P: "123", value: "5000000", nf: "456" };
const depTx = (o: Record<string, unknown> = {}, fc: Record<string, unknown> = {}, args: Record<string, unknown> = {}) => ({
  signer_id: RUN.G, receiver_id: RUN.U,
  actions: [{ Delegate: { delegate_action: { sender_id: RUN.U, receiver_id: RUN.token, actions: [{ FunctionCall: { method_name: "ft_transfer_call", args: b64({ receiver_id: RUN.vault, amount: RUN.value, msg: JSON.stringify({ precommitment: RUN.P, depositor: RUN.U }), ...args }), gas: 1, deposit: "1", ...fc } }] }, signature: "ed25519:x" } }],
  ...o,
});
const wdTx = (o: Record<string, unknown> = {}, signals = ["9", RUN.nf, RUN.value, "1", "1", "1", "1", "1"], method = "withdraw") => ({
  signer_id: RUN.R, receiver_id: RUN.vault, actions: [{ FunctionCall: { method_name: method, args: b64({ withdrawal: {}, proof: {}, public_signals: signals }), gas: 1, deposit: "0" } }], ...o,
});

test("M1: a deposit or withdrawal tx named for the record must be the run's: signer, receiver, method, amount, P or nullifier", () => {
  assert.deepEqual(relayerTxProblems("deposit", depTx(), RUN), []);
  assert.deepEqual(relayerTxProblems("withdraw", wdTx(), RUN), []);
  for (const t of [depTx({ signer_id: "x.near" }), depTx({ receiver_id: "d".repeat(64) }), depTx({}, { method_name: "ft_transfer" }), depTx({}, {}, { amount: "4000000" }), depTx({}, {}, { receiver_id: "other.near" }), depTx({}, {}, { msg: JSON.stringify({ precommitment: "9", depositor: RUN.U }) }), { ...depTx(), actions: [] }])
    assert.ok(relayerTxProblems("deposit", t, RUN).length > 0, JSON.stringify(t).slice(0, 120));
  for (const t of [wdTx({ signer_id: "x.near" }), wdTx({ receiver_id: "v.near" }), wdTx({}, undefined, "ragequit"), wdTx({}, ["9", "457", RUN.value, "1", "1", "1", "1", "1"]), wdTx({}, ["9", RUN.nf, "4700000", "1", "1", "1", "1", "1"]), { ...wdTx(), actions: [{ Transfer: { deposit: "1" } }] }])
    assert.ok(relayerTxProblems("withdraw", t, RUN).length > 0, JSON.stringify(t).slice(0, 120));
  assert.ok(relayerTxProblems("deposit", null, RUN).length > 0);
});

test("LB: a deposit tx is the run's only as U's one delegate to the token, of one ft_transfer_call, by U as depositor", () => {
  const da = (t: any) => t.actions[0].Delegate.delegate_action;
  const toOther = depTx();
  da(toOther).receiver_id = "other.near";
  const fromOther = depTx();
  da(fromOther).sender_id = "d".repeat(64);
  const twoInner = depTx();
  da(twoInner).actions = [da(depTx()).actions[0], da(depTx()).actions[0]];
  const twoOuter = { ...depTx(), actions: [depTx().actions[0], depTx().actions[0]] };
  const otherDepositor = depTx({}, {}, { msg: JSON.stringify({ precommitment: RUN.P, depositor: "d".repeat(64) }) });
  for (const [name, t] of [["the delegate to another contract", toOther], ["another sender's delegate", fromOther], ["two calls in the delegate", twoInner], ["two actions", twoOuter], ["another depositor", otherDepositor]] as const)
    assert.ok(relayerTxProblems("deposit", t, RUN).length > 0, name);
});

test("LB: the balances are asked up to 5 times; a deposit that lands mid-wait is restored into a fresh store of the lane", () => {
  assert.match(SRC, /const balances = async[\s\S]{0,700}\}, 5\)\) \?\? \{ at: new Date\(\)\.toISOString\(\), unread: true \};/);
  assert.match(SRC, /ns\.close\(\);\n\s+w\.close\(\);\n\s+\(\{ w, ns \} = await storeOfLane\(i % LANES\)\);\n\s+await writeRestored\(ns, await restoreNotes\(/);
});

test("M1: record takes --deposit-tx and --withdraw-tx, checks every relayer tx against the run, and open-u keeps its hash before the send", () => {
  assert.match(SRC, /a === "--fund-tx" \|\| a === "--settle-tx" \|\| a === "--deposit-tx" \|\| a === "--withdraw-tx"/);
  assert.match(SRC, /relayerTxProblems\("deposit", t, want\)/);
  assert.match(SRC, /relayerTxProblems\("withdraw", t, want\)/);
  assert.doesNotMatch(SRC, /\(\) => \{\}\)/, "no send drops its hash");
  assert.match(SRC, /keep\(hash\); \/\/ the hash is kept before it is sent/);
});

test("L2: resume withdraws the run's UNSPENT note of its label (the deposit note, or its refund note after a refunded payout), never a zero change or another label's", () => {
  const leaf = (label: bigint, value: bigint) => ({ value, label, commitment: 1n, leafIndex: 0n });
  const dep = (state: string) => ({ id: "d", ref: { kind: "deposit", s: 1n, i: 3 }, state, leaf: leaf(7n, 5_000_000n) });
  // the vault gives a refund note a fresh label (settle.rs), so its leaf label is never the deposit's: it is found by its parent
  const refund = { id: "r", ref: { kind: "refund", l: 7n, j: 0 }, state: "UNSPENT", parent: "d", leaf: leaf(8n, 4_816_554n) };
  const zero = { id: "c", ref: { kind: "change", l: 7n, j: 0 }, state: "UNSPENT", parent: "d", leaf: leaf(7n, 0n) };
  const other = { id: "o", ref: { kind: "deposit", s: 1n, i: 11 }, state: "UNSPENT", leaf: leaf(9n, 1_000_000n) };
  const stranger = { id: "x", ref: { kind: "refund", l: 9n, j: 0 }, state: "UNSPENT", parent: "o", leaf: leaf(8n, 2_000_000n) };
  // a refund note's own refund (a second refunded payout) is still the run's
  const refund2 = { id: "r2", ref: { kind: "refund", l: 8n, j: 0 }, state: "UNSPENT", parent: "r", leaf: leaf(6n, 4_600_000n) };
  assert.equal(noteToWithdraw([dep("UNSPENT"), other], 3)?.id, "d");
  assert.equal(noteToWithdraw([dep("SPENT"), stranger, refund, zero, other], 3)?.id, "r");
  assert.equal(noteToWithdraw([dep("SPENT"), stranger, { ...refund, state: "SPENT" }, zero, refund2, other], 3)?.id, "r2");
  // F4 (23): the store lists by random id (store.ts getAllKeys), so a child may come before its parent: the walk goes on
  // until the line stops growing, and the refund of a refund listed first is still found
  assert.equal(noteToWithdraw([refund2, dep("SPENT"), { ...refund, state: "SPENT" }, other, stranger], 3)?.id, "r2");
  assert.equal(noteToWithdraw([refund2, { ...refund, state: "SPENT" }, zero, dep("SPENT")], 3)?.id, "r2");
  assert.equal(noteToWithdraw([dep("SPENT"), zero, other, stranger], 3), null);
  assert.equal(noteToWithdraw([other], 3), null);
  // the arrival read follows the note withdrawn last, and the request must spend the picked note
  assert.match(SRC, /const pick = noteToWithdraw\(/);
  assert.match(SRC, /requestProblems\(req, to, pick\.id\)/);
});

test("MA: after a refunded and settled payout, the refund note the wallet restores (the vault's fresh label) is the one withdrawn next", async () => {
  const seed64 = Uint8Array.from({ length: 64 }, (_, k) => (k * 7 + 3) & 255);
  const scope = 12345n, i = 3, V = 5_000_000n;
  const L = 777n, L2 = 888n; // the deposit's label; the vault's fresh label for the refund note
  const dref = { kind: "deposit", s: scope, i } as const;
  const { precommitment: P, nullifierHash: nf } = noteSecrets(seed64, dref);
  const cP = noteSecrets(seed64, { kind: "change", l: L, j: 0 }).precommitment;
  const rP = noteSecrets(seed64, { kind: "refund", l: L, j: 0 }).precommitment;
  const U = depositAccount(seed64, scope, i).account;
  const pages = {
    deposits: [{ index: 0, precommitment: P, label: L, value: V, leafIndex: 0n, depositor: U }],
    spends: [{ index: 0, nullifierHash: nf, withdrawn: V, newLeafIndex: 1n, refundPrecommitment: rP, refundValue: V, refundLabel: L2, refundLeafIndex: 2n, status: "settled", payer: "r.near", reserve: 0n, recipient: "owner.near", fee: 300_000n, context: 1n }],
    leaves: [noteCommitment(V, L, P), noteCommitment(0n, L, cP), noteCommitment(V, L2, rP)],
  };
  const r = restorePages(seed64, scope, pages as any, { gap: 2 });
  const { w, ns } = await storeOfLane(i % 8);
  try {
    await writeRestored(ns, r);
    const pick = noteToWithdraw(await ns.list(), i);
    assert.equal(pick?.ref.kind, "refund");
    assert.equal(pick?.leaf?.label, L2);
    assert.equal(pick?.leaf?.value, V);
  } finally {
    ns.close();
    w.close();
  }
});

test("LA: a second transfer that reached U after its deposit landed is no front-run: the run goes on with the deposit's note", async () => {
  const U = RUN.U;
  const want = { ...RUN, value: undefined } as never;
  const P = BigInt(RUN.P);
  const rowU = { precommitment: P, depositor: U, value: 5_000_000n };
  const reads = (byHash: Record<string, unknown>) => async (h: string) => {
    if (!(h in byHash)) throw new Error(`${h}: not a success on both RPCs`);
    return byHash[h];
  };
  assert.deepEqual(await bindProblem("deposited", { rows: [], want, amount: 5_000_000n, txs: ["h1"], readTx: reads({ h1: depTx() }) }), { why: null });
  assert.deepEqual(await bindProblem("struck", { rows: [], want, amount: 5_000_000n, txs: [], readTx: reads({}) }), { why: "struck" });
  // the earlier call landed 5 USDC, its tx heard and read back as the run's; U now holds the 2 USDC of a later transfer
  const own = await bindProblem("front_run", { rows: [{ precommitment: 9n, depositor: "x.near", value: 1n }, rowU], want, amount: 2_000_000n, txs: ["h1"], readTx: reads({ h1: depTx() }) });
  assert.equal(own.why, null);
  assert.equal(own.row, rowU);
  // P deposited by another account: a real front-run, named for what it is, and U's USDC is still at U
  const other = await bindProblem("front_run", { rows: [{ precommitment: P, depositor: "x.near", value: 1_000_000n }], want, amount: 5_000_000n, txs: ["h1"], readTx: reads({ h1: depTx() }) });
  assert.match(String(other.why), /^front-run: P was deposited by x\.near, not U, with 1000000; U's 5000000 USDC stays at U/);
  assert.match(String((await bindProblem("front_run", { rows: [], want, amount: 5_000_000n, txs: [], readTx: reads({}) })).why), /no row of P/);
});

test("F2: a row of P naming U is U's own only when a deposit tx of U for P with the row's value reads back a success", async () => {
  const U = RUN.U;
  const want = { ...RUN, value: undefined } as never;
  const P = BigInt(RUN.P);
  const reads = (byHash: Record<string, unknown>) => async (h: string) => {
    if (!(h in byHash)) throw new Error(`${h}: not a success on both RPCs`);
    return byHash[h];
  };
  // the reviewer's case: a front-runner rides P's prepay naming U, and no tx of U for P landed: a stop, never U's own
  const front = { precommitment: P, depositor: U, value: 1_000_000n };
  const stop = /^front-run: P was deposited naming U with 1000000, but no deposit tx of U for P with that value reads back a success/;
  assert.match(String((await ownDeposit({ rows: [front], want, amount: 5_000_000n, txs: [], readTx: reads({}) })).why), stop);
  // U's own call heard but failed on chain (PrecommitmentAlreadyUsed: a failed receipt): readTx throws, a stop
  assert.match(String((await ownDeposit({ rows: [front], want, amount: 5_000_000n, txs: ["h1"], readTx: reads({}) })).why), stop);
  // a landed tx of U for P but of another value (U's 5 USDC) does not make the front-runner's 1 USDC row U's
  assert.match(String((await ownDeposit({ rows: [front], want, amount: 5_000_000n, txs: ["h1"], readTx: reads({ h1: depTx() }) })).why), stop);
  // a landed tx that is not U's delegate for P (another precommitment) proves nothing
  assert.match(String((await ownDeposit({ rows: [{ ...front, value: 5_000_000n }], want, amount: 5_000_000n, txs: ["h1"], readTx: reads({ h1: depTx({}, {}, { msg: JSON.stringify({ precommitment: "9", depositor: U }) }) }) })).why), /naming U with 5000000, but no deposit tx/);
  // F4 (22): the pages not read (null) is never U's own
  assert.match(String((await ownDeposit({ rows: null, want, amount: 5_000_000n, txs: ["h1"], readTx: reads({ h1: depTx() }) })).why), /pages were not read/);
  // F4 (21): the row is P's own row, never another row of the page
  const rows = [{ precommitment: 77n, depositor: U, value: 5_000_000n }, { precommitment: P, depositor: "x.near", value: 5_000_000n }];
  assert.match(String((await ownDeposit({ rows, want, amount: 5_000_000n, txs: ["h1"], readTx: reads({ h1: depTx() }) })).why), /deposited by x\.near/);
  assert.match(String((await ownDeposit({ rows: rows.slice(0, 1), want, amount: 5_000_000n, txs: ["h1"], readTx: reads({ h1: depTx() }) })).why), /no row of P/);
  // the driver: a front_run reads P's row, then asks ownDeposit with the note's calls and every heard or named deposit tx,
  // each read back on both release RPCs; a row of P met while it waits goes through the same proof
  assert.match(SRC, /const \{ why, row \} = await bindProblem\(outcome\.kind, \{ rows, want: wantOf\(\), amount, txs: \[\.\.\.callTxs, \.\.\.depositTxs\(\)\], readTx \}\);/);
  assert.match(SRC, /const own = await ownDeposit\(\{ rows, want: wantOf\(\)/);
  assert.match(SRC, /const readTx = \(h: string\) => readBackBoth\(o\.urls, h, relayers\.bind\)\.catch\(\(\) => recordRead\(network, h, relayers\.bind\)\);/);
  assert.doesNotMatch(SRC, /r\.depositor === U\)/, "no row's depositor alone makes a deposit U's own");
  // the way out when U's own tx was not heard: run/resume --deposit-tx <hash>, a tx hash, read like every heard one
  assert.match(SRC, /const v = flags\(argv, \["--state", "--to"\], \[[^\]]*"--deposit-tx"[^\]]*\]/);
  assert.match(SRC, /const named = v\["--deposit-tx"\];\n\s+if \(named !== undefined && !\/\^\[1-9A-HJ-NP-Za-km-z\]\{43,44\}\$\/\.test\(named\)\) throw/);
  assert.match(SRC, /const depositTxs = \(\): string\[\] => \[\.\.\.heard\.bind, \.\.\.\(named === undefined \? \[\] : \[named\]\)\];/);
});

test("M1 (review 5): every path to the prover holds the run's deposit leaf to a landed tx of U for P at its value: bind, wait, resume, restore", async () => {
  const leafProblem = (MM as any).leafProblem;
  assert.equal(typeof leafProblem, "function", "one check that every path to the prover passes");
  const want = { ...RUN, value: undefined } as never;
  const reads = (byHash: Record<string, unknown>) => async (h: string) => {
    if (!(h in byHash)) throw new Error(`${h}: not a success on both RPCs`);
    return byHash[h];
  };
  const stop = (v: string) => new RegExp(`^no deposit tx of U for P with ${v} reads back a success on both RPCs`);
  // the deposit note of index i as the wallet restores it from the vault's pages (restore matches a row by P alone)
  const seed64 = Uint8Array.from({ length: 64 }, (_, k) => (k * 5 + 1) & 255);
  const scope = 12345n, i = 2, L = 555n;
  const { precommitment: P } = noteSecrets(seed64, { kind: "deposit", s: scope, i });
  const U = depositAccount(seed64, scope, i).account;
  const restored = async (depositor: string, value: bigint) => {
    const pages = { deposits: [{ index: 0, precommitment: P, label: L, value, leafIndex: 0n, depositor }], spends: [], leaves: [noteCommitment(value, L, P)] };
    const { w, ns } = await storeOfLane(i % 8);
    try {
      await writeRestored(ns, restorePages(seed64, scope, pages as any, { gap: 2 }));
      return await ns.list();
    } finally {
      ns.close();
      w.close();
    }
  };
  const wantU = { ...want, U, P: String(P) } as never;
  const txU = (value: string) => {
    const t: any = depTx({ receiver_id: U }, {}, { amount: value, msg: JSON.stringify({ precommitment: String(P), depositor: U }) });
    t.actions[0].Delegate.delegate_action.sender_id = U;
    return t;
  };
  // (a) a resume: U's 5 USDC row restored, the only heard tx failed on chain (PrecommitmentAlreadyUsed): a stop
  const mine = await restored(U, 5_000_000n);
  assert.match(String(await leafProblem({ notes: mine, i, want: wantU, txs: ["h1"], readTx: reads({}) })), stop("5000000"));
  assert.match(String(await leafProblem({ notes: mine, i, want: wantU, txs: [], readTx: reads({}) })), stop("5000000"));
  assert.equal(await leafProblem({ notes: mine, i, want: wantU, txs: ["h0", "h1"], readTx: reads({ h1: txU("5000000") }) }), null);
  // (c) a stranger's row of P (1 USDC, naming anyone) restored as mine: U's own landed 5 USDC tx proves nothing for it
  const theirs = await restored("x.near", 1_000_000n);
  assert.equal(theirs.find((n: any) => n.ref.kind === "deposit" && n.ref.i === i)?.leaf?.value, 1_000_000n, "restore takes the stranger's row as the run's note");
  assert.match(String(await leafProblem({ notes: theirs, i, want: wantU, txs: ["h1"], readTx: reads({ h1: txU("5000000") }) })), stop("1000000"));
  // no deposit note of i with a leaf: nothing to withdraw is proven
  assert.match(String(await leafProblem({ notes: [], i, want: wantU, txs: [], readTx: reads({}) })), /no deposit note of index 2 with a leaf/);
  // (b) bind answered "deposited" at U's amount (a stranger's exact-amount row naming U), its only tx failed: a stop
  assert.match(String((await bindProblem("deposited", { rows: [], want, amount: 5_000_000n, txs: ["h1"], readTx: reads({}) })).why), stop("5000000"));
  assert.match(String((await bindProblem("deposited", { rows: [], want, amount: 5_000_000n, txs: [], readTx: reads({}) })).why), stop("5000000"));
  // the driver: one leafProblem right before the prover's gate, on every path, with every tx the run holds for the
  // deposit (the note's calls, the deposit step's, the heard and the named); the restored step only after it passes
  assert.match(SRC, /const why = await leafProblem\(\{ notes: await ns\.list\(\), i, want: wantOf\(\), txs: \[\.\.\.noteTxs, \.\.\.\(st\.read\("deposit"\)\?\.txs \?\? \[\]\), \.\.\.depositTxs\(\)\], readTx \}\);\n\s+if \(why !== null\) throw[^\n]*\n(\s*\/\/[^\n]*\n)*\s+const held = st\.read\("deposit"\);\n\s+if \(held === undefined && note\.leaf !== undefined\)/);
  const prover = SRC.indexOf('sourceGate("the prover loads');
  assert.ok(SRC.indexOf("await leafProblem(") > 0 && SRC.indexOf("await leafProblem(") < prover, "the check stands before the prover's gate");
  assert.equal(SRC.split("await leafProblem(").length, 2, "one check, every path through it");
  // the stop's way out is pasteable: line 1 again with --deposit-tx <hash> at its end
  assert.match(SRC, /paste line 1 again with --deposit-tx <hash> at its end/);
  assert.doesNotMatch(SRC, /resume \.\.\. --deposit-tx/);
});

test("N3 (R7, review 6): the leaf held to U's tx is the deposit note of the run's own index, never another deposit note in the store", async () => {
  const leafProblem = (MM as any).leafProblem;
  const want = { ...RUN, value: undefined } as never;
  const reads = (byHash: Record<string, unknown>) => async (h: string) => {
    if (!(h in byHash)) throw new Error(`${h}: not a success on both RPCs`);
    return byHash[h];
  };
  // another deposit note first (index 9, U's 5 USDC, its tx landed), the run's index 2 a stranger's 1 USDC row
  const notes = [{ ref: { kind: "deposit", i: 9 }, leaf: { value: 5_000_000n } }, { ref: { kind: "deposit", i: 2 }, leaf: { value: 1_000_000n } }];
  assert.match(String(await leafProblem({ notes, i: 2, want, txs: ["h1"], readTx: reads({ h1: depTx() }) })), /^no deposit tx of U for P with 1000000 reads back/);
  assert.equal(await leafProblem({ notes, i: 9, want, txs: ["h1"], readTx: reads({ h1: depTx() }) }), null);
});

test("N2 (review 6): the deposit step keeps every tx that may have proved the leaf, a --deposit-tx included, so a later resume and paste 3 need no retyped hash", () => {
  assert.match(SRC, /st\.write\("deposit", \{ amount: String\(note\.leaf\.value\), txs: \[\.\.\.new Set\(\[\.\.\.noteTxs, \.\.\.depositTxs\(\)\]\)\], relayer: relayers\.bind, restored: true,/);
  assert.match(SRC, /else if \(held !== undefined && named !== undefined && !\(held\.txs \?\? \[\]\)\.includes\(named\)\) st\.write\("deposit", \{ \.\.\.held, txs: \[\.\.\.\(held\.txs \?\? \[\]\), named\] \}\);/);
  assert.doesNotMatch(SRC, /txs: \[\], relayer: relayers\.bind, restored: true/);
});

test("record key (review 6): the testnet record is its own key, vault-mainnet-money-testnet, that the money gate parses; the mainnet record stays vault-mainnet-money", async () => {
  const { parseLive } = await import("../../../scripts/ci/money-gate.mjs");
  const { recordFiles, recordText } = MM as any;
  const txs = [{ hash: "9ogyXiM7VWYUR34XzeZL6jRs2cFXcpNwKLwTncYdKmYd", signer: "p.testnet" }];
  const t = parseLive(recordText(txs, ["prose"], "testnet"), "vault-mainnet-money-testnet");
  assert.deepEqual(t?.problems, []);
  assert.equal(t?.txs.length, 1);
  const m = parseLive(recordText([{ ...txs[0], signer: "p.near" }], ["prose"], "mainnet"), "vault-mainnet-money");
  assert.deepEqual(m?.problems, []);
  assert.deepEqual(recordFiles("/s", "testnet"), { run: "/s/vault-mainnet-money-testnet.run.json", md: "/s/vault-mainnet-money-testnet.md" });
  assert.deepEqual(recordFiles("/s", "mainnet"), { run: "/s/vault-mainnet-money.run.json", md: "/s/vault-mainnet-money.md" });
});

test("L3 (review 5): the code a wait or a resume reads txs with is loaded before the seed, so no code loads with seed64 in memory but under a gate", () => {
  const seed = SRC.indexOf("const seed64 = await seed64Of(st.seed);");
  const goAt = SRC.indexOf("async function go(");
  for (const m of ['await import("./testnet-t04.mjs")', 'await import("../../../scripts/ci/money-gate.mjs")']) {
    const at = SRC.indexOf(m, goAt);
    assert.ok(at > goAt && at < seed, `${m} is loaded in go() before the seed is read`);
  }
});

test("L1 (G, review 5): a step file that names no commit is refused by a run that names one", () => {
  const A = "a".repeat(40);
  for (const body of [{ amount: "1" }, { amount: "1", commit: null }]) {
    const dir = path.join(fresh(), "run");
    stateDir(dir, ROOTS, { create: true, commit: A });
    writeFileSync(path.join(dir, "deposit.json"), JSON.stringify(body));
    assert.throws(() => stateDir(dir, ROOTS, { create: false, commit: A }), new RegExp(`written by commit none, not this paste's ${A}`), JSON.stringify(body));
  }
});

test("F4 (28): a run step of another seed or network, or one that pays another account than --to, is refused", () => {
  const run = { fingerprint: "f", network: "mainnet", to: "x.near" };
  assert.deepEqual(runStepProblems(run, { fingerprint: "f", network: "mainnet", to: "x.near" }), []);
  assert.match(runStepProblems(run, { fingerprint: "f", network: "mainnet", to: "y.near" }).join(), /this run pays x\.near; paste the same line with x\.near/);
  assert.match(runStepProblems(run, { fingerprint: "g", network: "mainnet", to: "x.near" }).join(), /not this seed's/);
  assert.match(runStepProblems(run, { fingerprint: "f", network: "testnet", to: "x.near" }).join(), /another network's/);
  assert.match(SRC, /const rsp = runStepProblems\(run, \{ fingerprint: fp, network, to \}\);\n\s+if \(rsp\.length\) throw/);
});

test("F1: every step file names the commit that wrote it; a folder another commit wrote is refused, not gone on with", () => {
  const A = "a".repeat(40), B = "b".repeat(40);
  const dir = path.join(fresh(), "run");
  const st = stateDir(dir, ROOTS, { create: true, commit: A });
  st.writeOnce("run", { i: 1 });
  st.write("deposit", { amount: "1" });
  assert.equal(JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")).commit, A);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "deposit.json"), "utf8")).commit, A);
  assert.deepEqual(st.read("deposit"), { amount: "1" });
  // a resume from a new clone at the same commit goes on; at another commit, or with none, it is refused
  assert.deepEqual(stateDir(dir, ROOTS, { create: false, commit: A }).read("run"), { i: 1 });
  assert.throws(() => stateDir(dir, ROOTS, { create: false, commit: B }), new RegExp(`written by commit ${A}, not this paste's ${B}`));
  assert.throws(() => stateDir(dir, ROOTS, { create: false }), /not this paste's none/);
  assert.equal(stateDir(dir, ROOTS, { create: false, commit: A }).commit, A);
});

// LC: every request the record's read of T02's 6-day-old withdrawal tx made on 2026-11-08 and each host's answer: dRPC
// and FastNEAR's regular host no longer know it (UNKNOWN_TRANSACTION), FastNEAR's archival hosts read it. The run's
// values are T02's own record (deployments/testnet-t02-run.json); the tx is its partial withdrawal (1.5 of 2 USDC)
const READS = JSON.parse(readFileSync(path.join(HERE, "mainnet-money-reads.answers.json"), "utf8")).answers as { url: string; method: string; params: unknown; status: number; text: string }[];
const T02R = JSON.parse(readFileSync(path.join(HERE, "..", "deployments", "testnet-t02-run.json"), "utf8"));
const T02 = { hash: "DFFUVXsCGfsZ8jCiesFpnhsc2M5HDcSWZHD3Nm1bMczF", signer: T02R.accounts.R };
const T02_RUN = { U: T02R.accounts.U, G: T02R.accounts.G, R: T02R.accounts.R, vault: T02R.vault, token: T02R.asset, P: T02R.deposit.precommitment, value: T02R.withdraw.withdrawn, nf: T02R.withdraw.nullifier_hash };
// a replay of READS, in order per host, method and params (a block another host was asked for is answered as that host
// answered it: one chain); `edit` changes one host's answer to a method
function replay(edit: (host: string, method: string, text: string) => string = (_h, _m, t) => t) {
  const queue = new Map<string, { status: number; text: string }[]>();
  for (const a of READS) {
    const k = `${a.url} ${a.method} ${JSON.stringify(a.params)}`;
    queue.set(k, [...(queue.get(k) ?? []), { status: a.status, text: a.text }]);
  }
  return (async (url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    const k = `${url} ${b.method} ${JSON.stringify(b.params)}`;
    const q = queue.get(k) ?? (b.method === "block" ? [...queue].find(([key]) => key.endsWith(` block ${JSON.stringify(b.params)}`))?.[1] : undefined);
    if (q === undefined) throw new Error(`not recorded: ${k.slice(0, 200)}`);
    const a = q.length > 1 ? q.shift()! : q[0]!;
    return new Response(edit(new URL(url).host, b.method, a.text), { status: a.status });
  }) as unknown as typeof fetch;
}
const nowait = async () => {};

test("LC: record reads a tx older than the release pair keeps on the money gate's archival hosts, proven against dRPC's final block", async () => {
  const t = await recordRead("testnet", T02.hash, T02.signer, replay(), nowait);
  assert.deepEqual(relayerTxProblems("withdraw", t, T02_RUN), []);
  // the same answers with FastNEAR's tx JSON changed (another amount): its bytes no longer hash to the id, so one
  // operator's read is not proven and nothing is recorded
  const bump = (text: string) => {
    const j = JSON.parse(text);
    j.result.transaction.nonce += 1;
    return JSON.stringify(j);
  };
  const forged = (h: string, m: string, text: string) => ((h.includes("fastnear") || h.includes("near.org")) && m === "EXPERIMENTAL_tx_status" && text.includes('"result"') ? bump(text) : text);
  await assert.rejects(recordRead("testnet", T02.hash, T02.signer, replay(forged), nowait), /read by one operator and not proven/);
  // dRPC reading it failed refuses it, whatever FastNEAR says
  const fastnearTx = READS.find((a) => a.url.includes("archival-rpc.testnet.fastnear.com") && a.method === "EXPERIMENTAL_tx_status")!.text;
  const failedOnDrpc = (h: string, m: string, text: string) => (h === "near-testnet.drpc.org" && m === "EXPERIMENTAL_tx_status" ? fastnearTx.replace('"status":{"SuccessValue"', '"status":{"Failure":{},"x"') : text);
  await assert.rejects(recordRead("testnet", T02.hash, T02.signer, replay(failedOnDrpc), nowait), /failed[^,]* on https:\/\/near-testnet\.drpc\.org/);
  // read ok by two operators (dRPC still keeping it), it needs no proof
  const sameOnDrpc = (h: string, m: string, text: string) => (h === "near-testnet.drpc.org" && m === "EXPERIMENTAL_tx_status" ? fastnearTx : h.includes("fastnear") && m === "EXPERIMENTAL_light_client_proof" ? "{}" : text);
  assert.deepEqual(relayerTxProblems("withdraw", await recordRead("testnet", T02.hash, T02.signer, replay(sameOnDrpc), nowait), T02_RUN), []);
  // two operators that read it must return one transaction
  const otherOnDrpc = (h: string, m: string, text: string) => (h === "near-testnet.drpc.org" && m === "EXPERIMENTAL_tx_status" ? bump(fastnearTx) : text);
  await assert.rejects(recordRead("testnet", T02.hash, T02.signer, replay(otherOnDrpc), nowait), /the RPCs return different transactions/);
  // every read of the record goes this way; the release pair's read stays for the tx this script just sent
  const rec = SRC.slice(SRC.indexOf("async function record("), SRC.indexOf("function flags("));
  assert.doesNotMatch(rec, /readBackBoth/);
  assert.match(SRC, /async function landedOf\(network: Network,[\s\S]{0,300}mine\(await recordRead\(network, hash, signer\)\)/);
});

// R1: at 9 Nov 04:24Z archival-rpc.mainnet.near.org (FastNEAR's) answered the run's machine 429 with Retry-After 447,
// after FastNEAR and dRPC had read the tx, and the record waited it out. T02's recorded reads, each mainnet host
// answered by its testnet twin (a proof checks the chain its status names, so a proven read runs on the testnet list,
// whose third host is FastNEAR's too); `limited` answers a host's n-th request 429 with that Retry-After (null: as recorded)
const TWIN: Record<string, string> = { "archival-rpc.mainnet.fastnear.com": "archival-rpc.testnet.fastnear.com", "near.drpc.org": "near-testnet.drpc.org", "archival-rpc.mainnet.near.org": "archival-rpc.testnet.near.org" };
function limitedOn(network: "mainnet" | "testnet", f: typeof fetch, limited: (host: string, n: number) => number | null) {
  const asked = new Map<string, number>();
  const fn = (async (url: string, init: { body: string }) => {
    const host = new URL(url).host;
    if (network === "mainnet" && !TWIN[host]) throw new Error(`not a mainnet host of the gate's list: ${host}`);
    const n = (asked.get(host) ?? 0) + 1;
    asked.set(host, n);
    const after = limited(host, n);
    if (after !== null) return new Response("", { status: 429, headers: { "retry-after": String(after) } });
    return (f as any)(network === "mainnet" ? `https://${TWIN[host]}` : url, init);
  }) as unknown as typeof fetch;
  return { fn, asked };
}

test("R1: record waits out a 429 only while the host could add a second operator, the money gate's rule (money-gate.mjs moneyGate)", async () => {
  const fastnearTx = READS.find((a) => a.url.includes("archival-rpc.testnet.fastnear.com") && a.method === "EXPERIMENTAL_tx_status")!.text;
  const sameOnDrpc = (h: string, m: string, text: string) => (h === "near-testnet.drpc.org" && m === "EXPERIMENTAL_tx_status" ? fastnearTx : text);
  const NEAR_ORG = "archival-rpc.mainnet.near.org";
  const run = async (f: typeof fetch, limited: (host: string, n: number) => number | null, network: "mainnet" | "testnet" = "mainnet") => {
    const pauses: number[] = [];
    const m = limitedOn(network, f, limited);
    const t = await recordRead(network, T02.hash, T02.signer, m.fn, async (ms) => void pauses.push(ms));
    return { t, pauses, asked: m.asked };
  };
  // FastNEAR and dRPC read it ok: near.org's 429 Retry-After 447 is asked once and not waited
  const two = await run(replay(sameOnDrpc), (h) => (h === NEAR_ORG ? 447 : null));
  assert.deepEqual(relayerTxProblems("withdraw", two.t, T02_RUN), []);
  assert.deepEqual(two.pauses.filter((ms) => ms >= 2000), [], "no rate-limit wait");
  assert.equal(two.asked.get(NEAR_ORG), 1);
  // FastNEAR alone reads it (dRPC no longer keeps it): near.org is FastNEAR's, so its 429 could add no second
  // operator and is not waited; the read passes only by FastNEAR's proof against dRPC's final block
  const TEST_ORG = "archival-rpc.testnet.near.org";
  const one = await run(replay(), (h) => (h === TEST_ORG ? 447 : null), "testnet");
  assert.deepEqual(relayerTxProblems("withdraw", one.t, T02_RUN), []);
  assert.deepEqual(one.pauses.filter((ms) => ms >= 2000), [], "no rate-limit wait");
  assert.equal(one.asked.get(TEST_ORG), 1);
  // FastNEAR read it ok and dRPC's 429 could add the second operator: it is waited out, as the gate waits it
  const drpc = await run(replay(sameOnDrpc), (h, n) => (h === "near.drpc.org" && n === 1 ? 447 : null));
  assert.deepEqual(relayerTxProblems("withdraw", drpc.t, T02_RUN), []);
  assert.deepEqual(drpc.pauses.filter((ms) => ms >= 2000), [447_000]);
  // plant: FastNEAR's two hosts read it ok, dRPC does not, and FastNEAR's proof is broken: two hosts of one operator are
  // one operator, so it is refused, never counted as two
  const noProof = (h: string, m: string, text: string) => (h.includes("fastnear") && m === "EXPERIMENTAL_light_client_proof" ? "{}" : text);
  await assert.rejects(
    run(replay(noProof), () => null, "testnet"),
    (e: Error) => /ok on https:\/\/archival-rpc\.testnet\.fastnear\.com/.test(e.message) && /ok on https:\/\/archival-rpc\.testnet\.near\.org/.test(e.message) && /read by one operator and not proven/.test(e.message), // near-rpc-operators: one operator (the plant names FastNEAR's two hosts to show they count as one)
  );
});

test("L3: the fee is held to the withdrawal's own bound before any deposit: 2 * fee < the note (withdrawRequest's fee < amount, the vault's fee <= withdrawn / 2)", () => {
  const feeMax = 10_000_000n;
  assert.deepEqual(feeProblems({ relayFee: 499_999n, feeMax, note: 1_000_000n }), []);
  for (const relayFee of [500_000n, 700_000n, 999_999n]) assert.match(feeProblems({ relayFee, feeMax, note: 1_000_000n }).join(), /half the note/, String(relayFee));
  // checked again on the amount at U right before its deposit is signed
  assert.match(SRC, /await feeOf\(amount\);[\s\S]{0,800}bindDeposit\(seed64/);
});

test("L4: a read that fails or disagrees for a block is asked again, and after a landing never stops the run", async () => {
  let n = 0;
  assert.equal(await retried(async () => (++n < 3 ? Promise.reject(new Error("disagree")) : "ok"), 3, async () => {}), "ok");
  assert.equal(n, 3);
  assert.equal(await retried(async () => Promise.reject(new Error("down")), 3, async () => {}), null);
  assert.match(SRC, /const balances = async[^\n]*retried\(/);
});

test("L4: a deposit that lands while the run waits ends the wait (P in the deposits pages): no second bind", () => {
  assert.match(SRC, /if \(rows !== null && rows\.some\(\(r\) => r\.precommitment === BigInt\(run\.precommitment\)\)\) \{/);
  assert.match(SRC, /if \(landed !== undefined\)[\s\S]{0,200}else \{[\s\S]{0,1500}bindDeposit\(seed64/);
});

test("L4: a send's error is read from send_tx's answer, kept in the step file and reported at once", () => {
  assert.equal(sendAnswerError({ jsonrpc: "2.0", result: { status: {} } }), null);
  assert.equal(sendAnswerError(null), null, "no answer: the read-back decides");
  assert.match(String(sendAnswerError({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION" }, data: { TxExecutionError: { InvalidTxError: "InvalidNonce" } } } })), /INVALID_TRANSACTION[^]*InvalidNonce/);
  assert.equal(sendAnswerError({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } }), null, "a timeout is no answer");
  assert.match(SRC, /keep\(hash, err\)/);
});

test("open-u --register: the payer registers an existing, unregistered account on the token; anything else is refused before any send", () => {
  const ok = { amount: "1" };
  assert.deepEqual(registerProblems("owner.testnet", { reads: [ok, ok], registered: [false, false] }), []);
  assert.match(registerProblems("Owner", { reads: [ok, ok], registered: [false, false] }).join(), /not a NEAR account id/);
  assert.match(registerProblems("owner.testnet", { reads: ["absent", "absent"], registered: [false, false] }).join(), /does not exist/);
  assert.match(registerProblems("owner.testnet", { reads: [ok, "absent"], registered: [false, false] }).join(), /does not exist/);
  assert.match(registerProblems("owner.testnet", { reads: [ok, null], registered: [false, false] }).join(), /two operators/);
  assert.match(registerProblems("owner.testnet", { reads: [ok, ok], registered: [true, true] }).join(), /already registered/);
  assert.match(registerProblems("owner.testnet", { reads: [ok, ok], registered: [true, false] }).join(), /disagree/);
  // checked before U's opening sends anything, and the registration's hash kept before its send like the others
  assert.match(SRC, /const rp = v\["--register"\] === undefined \? \[\] : registerProblems\([\s\S]{0,600}if \(acct\.every/);
  assert.match(SRC, /keep\(`storage_deposit of \$\{reg\} on \$\{o\.token\}`\)/);
});

test("the usage line names every command", () => {
  const r = spawnSync(process.execPath, [path.join(HERE, "mainnet-money.ts")], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /check\|run\|resume\|open-u\|sweep-u\|record/);
});
