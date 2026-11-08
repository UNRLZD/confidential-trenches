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
import { bindProblem, feeProblems, recordRead, fingerprintOf, registerProblems, retried, sendAnswerError, noteToWithdraw, recipientProblems, recordProblems, relayerTxProblems, replanAt, requestProblems, stateDir, storeOfLane, sweepProblems, uSigner } from "./mainnet-money.ts";
import { createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
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
  const req = { recipient: "owner.near", changeValue: 0n, body: { fund_recipient: false } };
  assert.deepEqual(requestProblems(req, "owner.near"), []);
  // main's withdrawRequest ignores `to` and pays the note's A_{l,j} with fund_recipient true: two refusals
  const arming = { recipient: "a".repeat(64), changeValue: 0n, body: { fund_recipient: true } };
  const p = requestProblems(arming, "owner.near");
  assert.ok(p.some((x) => /pays a{64}, not owner.near/.test(x)) && p.some((x) => /fund_recipient is true/.test(x)), p.join("\n"));
  assert.match(requestProblems({ ...req, changeValue: 1n }, "owner.near").join(), /change note of 1/);
});

test("F1, F7: the driver withdraws the note's whole value less one fee to --to, through the wallet's own request", () => {
  assert.match(SRC, /amount: value - fee\.relayFee, to,/);
  assert.doesNotMatch(SRC, /withdrawHandoff\(/, "the form's two-quote draw leaves a lower quote's difference as change");
  assert.match(SRC, /requestProblems\(req, to\)[\s\S]{0,700}relayWithdraw\(/, "the request is checked before it is sent");
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
  assert.match(paste, /mainnet-money\.ts sweep-u --state /);
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
  assert.equal(noteToWithdraw([dep("SPENT"), zero, other, stranger], 3), null);
  assert.equal(noteToWithdraw([other], 3), null);
  // the arrival read follows the note withdrawn last, and the request must spend the picked note
  assert.match(SRC, /const pick = noteToWithdraw\(/);
  assert.match(SRC, /req\.noteId !== pick\.id/);
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

test("LA: a second transfer that reached U after its deposit landed is no front-run: the run goes on with the deposit's note", () => {
  const U = "a".repeat(64);
  assert.equal(bindProblem("deposited", undefined, U, 5_000_000n), null);
  // the earlier call landed 5 USDC; U now holds the 2 USDC of a later transfer, which this bind read
  assert.equal(bindProblem("front_run", { depositor: U, value: 5_000_000n }, U, 2_000_000n), null);
  // P deposited by another account: a real front-run, named for what it is, and U's USDC is still at U
  assert.match(String(bindProblem("front_run", { depositor: "x.near", value: 1_000_000n }, U, 5_000_000n)), /^front-run: P was deposited by x\.near, not U, with 1000000; U's 5000000 USDC stays at U/);
  assert.match(String(bindProblem("front_run", undefined, U, 5_000_000n)), /no row of P/);
  assert.equal(bindProblem("struck", undefined, U, 5_000_000n), "struck");
  // the driver reads P's row on both RPCs for a front_run and records the deposit's own value, not the read at U
  assert.match(SRC, /outcome\.kind === "front_run"[\s\S]{0,400}r\.precommitment === BigInt\(run\.precommitment\)[\s\S]{0,200}const why = bindProblem\(outcome\.kind, row, U, amount\);/);
  assert.match(SRC, /st\.write\("deposit", \{ amount: String\(leaf\.value\)/);
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
  assert.match(SRC, /r\.precommitment === BigInt\(run\.precommitment\) && r\.depositor === U/);
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
