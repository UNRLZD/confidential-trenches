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
import { fingerprintOf, recipientProblems, recordProblems, replanAt, requestProblems, stateDir, storeOfLane, sweepProblems, uSigner } from "./mainnet-money.ts";
import { createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { noteSecrets } from "../../../packages/wallet/src/notes/secrets.ts";
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
  assert.match(SRC, /requestProblems\(req, to\)[\s\S]{0,400}relayWithdraw\(/, "the request is checked before it is sent");
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
  assert.throws(() => stateDir(d2, ROOTS, { create: false }), /holds no seed/);
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
  assert.match(SRC, /deposit: \$\{json\(outcome\)\}[^`]*sweep-u/);
  assert.match(SRC, /still holds \$\{left\} USDC[^`]*sweep-u/);
  assert.match(SRC, /\.\.\.withdraws, \.\.\.sweeps,/, "the record holds every sweep");
  const paste = readFileSync(path.join(HERE, "mainnet-money", "4-sweep-u.sh"), "utf8");
  assert.match(paste, /mainnet-money\.ts sweep-u --state /);
  assert.match(readFileSync(path.join(HERE, "mainnet-money", "1-run.sh"), "utf8"), /one transfer/);
});

test("the usage line names every command", () => {
  const r = spawnSync(process.execPath, [path.join(HERE, "mainnet-money.ts")], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /check\|run\|resume\|open-u\|sweep-u\|record/);
});
