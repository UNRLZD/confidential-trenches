// node --test contracts/vault/scripts/source-gate.test.mjs: the mainnet money run's source gate (card
// vault-mainnet-money, review 4 F1), offline. Each case plants one way a clone could differ from the commit its paste
// names, in a fresh clone of a local bare repo whose origin is then set to the public repo's URL (the gate reads origin
// and origin/main locally; the paste line's clone is the fetch), and the gate must refuse it. Then the driver: on
// mainnet it refuses before anything is read, and a tree changed after its start never signs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cloneProblems, gateArgs, REPO } from "./source-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(HERE, "../../..");
const GATE = path.join(HERE, "source-gate.mjs");
const DRIVER = path.join(HERE, "mainnet-money.ts");
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), "vmm-gate-")));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...a) => {
  const r = spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (root, file, text) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};

// a bare "public repo" with two commits on main (old, head) and one on a card branch only; the files the gate's module
// check resolves from (the wallet's bind.ts, the kit's and the wallet's package.json)
function origin() {
  const root = path.join(TMP, String(n++));
  const bare = path.join(root, "remote.git");
  const src = path.join(root, "src");
  mkdirSync(root);
  git(root, "init", "-q", "--bare", bare);
  git(root, "init", "-q", "-b", "main", src);
  put(src, ".gitignore", "node_modules/\ndist/\n");
  put(src, "packages/kit/package.json", JSON.stringify({ name: "@blindfill/kit", main: "index.js" }));
  put(src, "packages/kit/index.js", "export {};\n");
  put(src, "packages/wallet/package.json", JSON.stringify({ name: "@blindfill/wallet" }));
  put(src, "packages/wallet/src/deposit/bind.ts", "export const x = 1;\n");
  put(src, "packages/wallet/src/withdraw/request.ts", "export const y = 1;\n");
  git(src, "add", "--", ".gitignore", "packages");
  git(src, "commit", "-q", "-m", "old");
  const old = git(src, "rev-parse", "HEAD");
  put(src, "packages/wallet/src/deposit/bind.ts", "export const x = 2;\n");
  git(src, "commit", "-q", "-am", "head");
  const head = git(src, "rev-parse", "HEAD");
  git(src, "push", "-q", bare, "main");
  git(src, "checkout", "-q", "-b", "card");
  put(src, "packages/wallet/src/deposit/bind.ts", "export const x = 3;\n");
  git(src, "commit", "-q", "-am", "card");
  const card = git(src, "rev-parse", "HEAD");
  git(src, "push", "-q", bare, "card");
  return { root, bare, old, head, card };
}
// the paste line's clone: a new folder, origin the public repo's URL, the commit checked out detached
function clone(o, commit = o.head, { install = true } = {}) {
  const dir = path.join(o.root, `clone-${n++}`);
  git(o.root, "clone", "-q", o.bare, dir);
  git(dir, "remote", "set-url", "origin", `${REPO}.git`);
  git(dir, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", commit);
  if (install) {
    // pnpm's layout: the store under node_modules/.pnpm, each package's links into it, the workspace kit linked to its folder
    for (const name of ["snarkjs", "fake-indexeddb"]) put(dir, `node_modules/.pnpm/${name}@1/node_modules/${name}/package.json`, JSON.stringify({ name, main: "index.js" })), put(dir, `node_modules/.pnpm/${name}@1/node_modules/${name}/index.js`, "\n");
    mkdirSync(path.join(dir, "packages/kit/node_modules"), { recursive: true });
    mkdirSync(path.join(dir, "packages/wallet/node_modules/@blindfill"), { recursive: true });
    symlinkSync("../../../node_modules/.pnpm/snarkjs@1/node_modules/snarkjs", path.join(dir, "packages/kit/node_modules/snarkjs"));
    symlinkSync("../../../node_modules/.pnpm/fake-indexeddb@1/node_modules/fake-indexeddb", path.join(dir, "packages/wallet/node_modules/fake-indexeddb"));
    symlinkSync("../../../kit", path.join(dir, "packages/wallet/node_modules/@blindfill/kit"));
  }
  return dir;
}
const refuses = (dir, commit, re, opts = {}) => {
  const p = cloneProblems({ root: dir, commit, ...opts });
  assert.ok(p.length > 0, `not refused: ${re}`);
  assert.match(p.join("\n"), re);
};

test("F1: a fresh clone at the paste's commit, on main, installed, passes; before the install, with no node_modules, too", () => {
  const o = origin();
  assert.deepEqual(cloneProblems({ root: clone(o), commit: o.head }), []);
  assert.deepEqual(cloneProblems({ root: clone(o, o.head, { install: false }), commit: o.head, installed: false }), []);
  // node_modules before the install is a path the commit does not hold
  refuses(clone(o), o.head, /path\(s\) the commit does not hold \(node_modules/, { installed: false });
});

test("F1: HEAD must be the paste's commit, and that commit on the public repo's main", () => {
  const o = origin();
  refuses(clone(o, o.old), o.head, /HEAD is [0-9a-f]{40}, not the paste's commit/);
  // an older commit on main is on main, but it is not the commit the paste names: the line checks out what it names
  assert.deepEqual(cloneProblems({ root: clone(o, o.old), commit: o.old }), []);
  // a pushed card branch's commit is not merged: refused on main, passed only with onMain false (the rehearsal)
  refuses(clone(o, o.card), o.card, /is not on https:\/\/github\.com\/UNRLZD\/confidential-trenches's main/);
  assert.deepEqual(cloneProblems({ root: clone(o, o.card), commit: o.card, onMain: false }), []);
  const other = clone(o);
  git(other, "remote", "set-url", "origin", "https://github.com/someone/confidential-trenches.git");
  refuses(other, o.head, /origin is https:\/\/github\.com\/someone/);
  refuses(clone(o), "abc", /not a 40-hex commit/);
});

test("F1: an untracked file is refused, also when git config hides untracked files (env or the clone's config), or a .gitignore of its own hides it", () => {
  const o = origin();
  const a = clone(o);
  put(a, "packages/wallet/src/evil.ts", "x\n");
  refuses(a, o.head, /does not hold \(packages\/wallet\/src\/evil\.ts\)/);
  // GIT_CONFIG_COUNT in the caller's environment, as a global config would set it: the gate drops every GIT_* of it
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "status.showUntrackedFiles", GIT_CONFIG_VALUE_0: "no" });
  try {
    refuses(a, o.head, /evil\.ts/);
  } finally {
    for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) if (saved[k] === undefined) delete process.env[k];
  }
  const b = clone(o);
  git(b, "config", "status.showUntrackedFiles", "no");
  refuses(b, o.head, /git config holds status\.showuntrackedfiles/i);
  // an untracked .gitignore that ignores itself and its folder: git status shows nothing, the gate's own walk does
  const c = clone(o);
  put(c, "packages/wallet/src/hide/.gitignore", "*\n");
  put(c, "packages/wallet/src/hide/evil.ts", "x\n");
  assert.equal(git(c, "status", "--porcelain"), "", "git status hides it");
  refuses(c, o.head, /packages\/wallet\/src\/hide/);
  // an ignored path (dist/) is refused: only pnpm's node_modules folders may stand beside the commit's files
  const d = clone(o);
  put(d, "dist/x.js", "x\n");
  refuses(d, o.head, /does not hold \(dist\)/);
});

test("F1: an edit behind assume-unchanged, skip-worktree or a kept size and time is refused: files are read against the commit's tree", () => {
  const o = origin();
  const a = clone(o);
  git(a, "update-index", "--assume-unchanged", "packages/wallet/src/deposit/bind.ts");
  put(a, "packages/wallet/src/deposit/bind.ts", "export const x = 9;\n");
  assert.equal(git(a, "status", "--porcelain"), "", "git status hides it");
  refuses(a, o.head, /differ from commit [0-9a-f]{12} \(packages\/wallet\/src\/deposit\/bind\.ts\)/);
  const b = clone(o);
  git(b, "update-index", "--skip-worktree", "packages/wallet/src/withdraw/request.ts");
  put(b, "packages/wallet/src/withdraw/request.ts", "export const y = 9;\n");
  assert.equal(git(b, "status", "--porcelain"), "", "git status hides it");
  refuses(b, o.head, /packages\/wallet\/src\/withdraw\/request\.ts/);
  const c = clone(o);
  const f = path.join(c, "packages/wallet/src/deposit/bind.ts");
  const st = statSync(f);
  writeFileSync(f, "export const x = 8;\n");
  utimesSync(f, st.atime, st.mtime);
  refuses(c, o.head, /bind\.ts/);
  // a tracked file replaced by a symlink to the same bytes outside the clone, and a missing file
  const d = clone(o);
  put(o.root, "outside.ts", readFileSync(path.join(d, "packages/wallet/src/deposit/bind.ts"), "utf8"));
  unlinkSync(path.join(d, "packages/wallet/src/deposit/bind.ts"));
  symlinkSync(path.join(o.root, "outside.ts"), path.join(d, "packages/wallet/src/deposit/bind.ts"));
  refuses(d, o.head, /bind\.ts/);
  const e = clone(o);
  unlinkSync(path.join(e, "packages/wallet/src/withdraw/request.ts"));
  refuses(e, o.head, /request\.ts \(missing\)/);
});

test("F1: the clone's git config is git clone's own: url.insteadOf, an include, an exclude pattern, alternates or a worktree are refused", () => {
  const o = origin();
  const a = clone(o);
  git(a, "config", `url.${o.bare}.insteadOf`, REPO);
  refuses(a, o.head, /git config holds url\./);
  const b = clone(o);
  git(b, "config", "include.path", "/dev/null");
  refuses(b, o.head, /include\.path/);
  const c = clone(o);
  writeFileSync(path.join(c, ".git/info/exclude"), "# git's own comment\nevil.ts\n");
  refuses(c, o.head, /info\/exclude holds a pattern/);
  const d = clone(o);
  writeFileSync(path.join(d, ".git/objects/info/alternates"), path.join(o.bare, "objects") + "\n");
  refuses(d, o.head, /\.git\/objects\/info\/alternates/);
  const wt = path.join(o.root, "wt");
  git(clone(o), "worktree", "add", "-q", "--detach", wt, o.head);
  refuses(wt, o.head, /not a clone's own folder/);
});

test("F1: what the run loads from node_modules resolves inside the clone: a planted @blindfill/kit or snarkjs is refused", () => {
  const o = origin();
  const a = clone(o);
  // the wallet's @blindfill/kit pointed at a planted package outside the clone
  put(o.root, "evil-kit/package.json", JSON.stringify({ name: "@blindfill/kit", main: "index.js" }));
  put(o.root, "evil-kit/index.js", "\n");
  unlinkSync(path.join(a, "packages/wallet/node_modules/@blindfill/kit"));
  symlinkSync(path.join(o.root, "evil-kit"), path.join(a, "packages/wallet/node_modules/@blindfill/kit"));
  refuses(a, o.head, /@blindfill\/kit from packages\/wallet\/src\/deposit\/bind\.ts resolves to .*evil-kit\/index\.js, outside packages\/kit of the clone/);
  // a copy in the wallet's node_modules, inside the clone but not the workspace's kit
  const b = clone(o);
  unlinkSync(path.join(b, "packages/wallet/node_modules/@blindfill/kit"));
  cpSync(path.join(o.root, "evil-kit"), path.join(b, "packages/wallet/node_modules/@blindfill/kit"), { recursive: true });
  refuses(b, o.head, /@blindfill\/kit .* outside packages\/kit/);
  const c = clone(o);
  unlinkSync(path.join(c, "packages/kit/node_modules/snarkjs"));
  symlinkSync(path.join(o.root, "evil-kit"), path.join(c, "packages/kit/node_modules/snarkjs"));
  refuses(c, o.head, /snarkjs from packages\/kit\/package\.json resolves to .*outside node_modules\/\.pnpm/);
  const d = clone(o);
  rmSync(path.join(d, "packages/kit/node_modules"), { recursive: true });
  refuses(d, o.head, /snarkjs does not resolve/);
});

test("F1: --not-on-main is the testnet rehearsal's only, and the CLI refuses with exit 1 before anything runs", () => {
  assert.throws(() => gateArgs(["--commit", "a".repeat(40), "--not-on-main"]), /testnet rehearsal only/);
  assert.throws(() => gateArgs(["--commit", "a".repeat(40), "--not-on-main", "--network", "mainnet"]), /testnet rehearsal only/);
  assert.deepEqual(gateArgs(["--commit", "a".repeat(40), "--not-on-main", "--network", "testnet"]), { commit: "a".repeat(40), network: "testnet", notOnMain: true, beforeInstall: false });
  const o = origin();
  const a = clone(o, o.card, { install: false });
  const cli = (args) => spawnSync(process.execPath, [GATE, ...args], { cwd: a, encoding: "utf8" });
  let r = cli(["--commit", o.card, "--before-install"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^refused, nothing signed: commit [0-9a-f]{40} is not on/);
  r = cli(["--commit", o.card, "--before-install", "--not-on-main"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /testnet rehearsal only/);
  r = cli(["--commit", o.card, "--before-install", "--not-on-main", "--network", "testnet"]);
  assert.equal(r.status, 0, r.stderr);
});

// ---- the driver ----

// a fetch that logs every call and answers sweep-u's reads on testnet (the release values of testnet-v1.json); plan.plant
// names a file the stub writes into the clone when U's balance is read, after the command's start and before U signs
const REC = JSON.parse(readFileSync(path.join(HERE, "..", "deployments", "testnet-v1.json"), "utf8"));
const STUB = path.join(TMP, "stub.mjs");
writeFileSync(STUB, `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const plan = JSON.parse(readFileSync(process.env.VMM_PLAN, "utf8"));
const out = (o) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...o }), { status: 200 });
const view = (v) => out({ result: { result: [...Buffer.from(JSON.stringify(v))], logs: [], block_height: 1 } });
const ok = { status: { SuccessValue: "" }, final_execution_status: "FINAL", receipts_outcome: [{ outcome: { status: { SuccessValue: "" }, executor_id: "x" } }], receipts: [], transaction: {} };
globalThis.fetch = async (url, init) => {
  const b = JSON.parse(init.body);
  const p = b.params ?? {};
  const a = p.args_base64 ? JSON.parse(Buffer.from(p.args_base64, "base64").toString("utf8")) : {};
  appendFileSync(process.env.VMM_LOG, JSON.stringify({ url: String(url), method: b.method, request_type: p.request_type, method_name: p.method_name }) + "\\n");
  if (plan.none) throw new Error("no fetch was planned");
  if (b.method === "block") return out({ result: { header: { hash: "11111111111111111111111111111111", height: 1 } } });
  if (b.method === "send_tx" || b.method === "EXPERIMENTAL_tx_status") return out({ result: ok });
  if (p.request_type === "view_access_key_list") return out({ result: { keys: [] } });
  if (p.request_type === "view_access_key") return out({ result: { nonce: 7, permission: "FullAccess" } });
  if (p.request_type === "view_account") return out({ result: { amount: "1000", code_hash: p.account_id === plan.vault ? plan.code_hash : "11111111111111111111111111111111" } });
  if (p.method_name === "config") return view({ asset: plan.token, scope: plan.scope, min_deposit: "1000000" });
  if (p.method_name === "ft_balance_of") {
    if (plan.plant && a.account_id === plan.U) writeFileSync(plan.plant, "planted after the start\\n");
    return view(a.account_id === plan.U ? "2000000" : "0");
  }
  if (p.method_name === "storage_balance_of") return view({ total: "1", available: "0" });
  return out({ error: { name: "STUB", cause: { name: "UNPLANNED " + p.method_name } } });
};
`);
function driverRun(cwd, driver, args, plan) {
  const root = path.join(TMP, `run-${n++}`);
  mkdirSync(root);
  const log = path.join(root, "calls.jsonl");
  const planFile = path.join(root, "plan.json");
  writeFileSync(planFile, JSON.stringify({ vault: REC.account_id, token: REC.asset, scope: REC.scope, code_hash: REC.code_hash, ...plan }));
  const r = spawnSync(process.execPath, ["--import", STUB, driver, ...args], { cwd, encoding: "utf8", timeout: 60_000, env: { ...process.env, VMM_PLAN: planFile, VMM_LOG: log } });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...r, out: r.stdout + r.stderr, calls, sends: calls.filter((c) => c.method === "send_tx") };
}

test("F4 (15, 16): on mainnet every command refuses before anything is read without --commit, with --not-on-main, or from a checkout that is not the commit's fresh clone", () => {
  const st = path.join(TMP, "mainnet-state");
  const head = spawnSync("git", ["-C", WT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const cmds = [["run", "--state", st, "--to", "owner.near"], ["resume", "--state", st, "--to", "owner.near"], ["open-u", "--state", st, "--payer", "p.near", "--key-file", "/nonexistent"], ["sweep-u", "--state", st], ["record", "--state", st, "--fund-tx", "1".repeat(44), "s.near"]];
  for (const c of cmds) {
    let r = driverRun(WT, DRIVER, c, { none: true });
    assert.equal(r.status, 1, c[0] + r.out);
    assert.match(r.out, /refused, nothing signed: a mainnet command runs only from a fresh clone at the commit its paste line names/, c[0]);
    assert.deepEqual(r.calls, [], c[0]);
    r = driverRun(WT, DRIVER, [...c, "--commit", head, "--not-on-main"], { none: true });
    assert.equal(r.status, 1, c[0] + r.out);
    assert.match(r.out, /--not-on-main is for the testnet rehearsal only/, c[0]);
    assert.deepEqual(r.calls, [], c[0]);
    // this worktree is a linked checkout, not a fresh clone: the gate refuses it, nothing read
    r = driverRun(WT, DRIVER, [...c, "--commit", head], { none: true });
    assert.equal(r.status, 1, c[0] + r.out);
    assert.match(r.out, /refused before anything is read, nothing signed: /, c[0]);
    assert.deepEqual(r.calls, [], c[0]);
  }
  assert.ok(!existsSync(st), "no state folder made");
});

// the driver's own files in a fresh clone: this checkout's HEAD with its uncommitted driver changes laid over it, committed
// in the clone with fixed names, installed from the lockfile (pnpm, from its local store when it can)
let ownClone;
function driverClone() {
  if (ownClone) return ownClone;
  const dir = path.join(TMP, "own-clone");
  git(TMP, "clone", "-q", "--no-local", WT, dir);
  const dirty = spawnSync("git", ["-C", WT, "ls-files", "-z", "-m", "-o", "--exclude-standard"], { encoding: "utf8" }).stdout.split("\0").filter(Boolean);
  for (const f of dirty) if (existsSync(path.join(WT, f))) cpSync(path.join(WT, f), path.join(dir, f));
  if (dirty.length) git(dir, "add", "--", ...dirty.filter((f) => existsSync(path.join(WT, f))));
  if (git(dir, "status", "--porcelain")) git(dir, "commit", "-q", "-m", "the worktree's own changes");
  const commit = git(dir, "rev-parse", "HEAD");
  git(dir, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", commit);
  const pnpm = spawnSync("pnpm", ["--version"]).status === 0 ? ["pnpm"] : ["corepack", "pnpm"];
  const r = spawnSync(pnpm[0], [...pnpm.slice(1), "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"], { cwd: dir, encoding: "utf8", env: { ...process.env, CI: "true", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  ownClone = { dir, commit };
  return ownClone;
}

test("F1: from the commit's fresh clone the driver signs; a file planted in the clone after its start is refused right before U signs", async () => {
  const { dir, commit } = driverClone();
  assert.deepEqual(cloneProblems({ root: dir, commit, onMain: false }), [], "the clone is the commit's");
  const { fingerprintOf, seed64Of } = await import(DRIVER);
  const { depositAccount } = await import("../../../packages/wallet/src/deposit/account.ts");
  const { randomBytes } = await import("node:crypto");
  const folder = () => {
    const state = path.join(TMP, `state-${n++}`);
    mkdirSync(state, { mode: 0o700 });
    return state;
  };
  const seedIn = async (state) => {
    const seed = randomBytes(32);
    writeFileSync(path.join(state, "seed"), seed.toString("hex") + "\n", { mode: 0o600 });
    const U = depositAccount(await seed64Of(seed), BigInt(REC.scope), 0).account;
    writeFileSync(path.join(state, "run.json"), JSON.stringify({ fingerprint: fingerprintOf(seed), network: "testnet", U, i: 0, to: "owner.testnet", commit }));
    return U;
  };
  const args = (state) => ["sweep-u", "--network", "testnet", "--bind-relayer", "g-2b700409.bf-vt-20261102t071444.testnet", "--commit", commit, "--not-on-main", "--state", state];
  const driver = path.join(dir, "contracts/vault/scripts/mainnet-money.ts");
  const good = folder();
  let r = driverRun(dir, driver, args(good), { U: await seedIn(good) });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.sends.length, 1, r.out);
  assert.equal(JSON.parse(readFileSync(path.join(good, "sweep.json"), "utf8")).commit, commit, "the step file names the commit");
  // the same, with a file planted in the clone while the command runs (at U's balance read): nothing signed
  const bad = folder();
  const plant = path.join(dir, "packages/wallet/src/planted.ts");
  r = driverRun(dir, driver, args(bad), { U: await seedIn(bad), plant });
  rmSync(plant, { force: true });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /refused before [0-9a-f]{64} signs, nothing signed: 1 path\(s\) the commit does not hold \(packages\/wallet\/src\/planted\.ts\)/);
  assert.deepEqual(r.sends, []);
  assert.ok(r.calls.some((c) => c.method_name === "ft_balance_of"), "planted after the start");
  // a folder another commit wrote is refused before anything is signed
  const other = folder();
  await seedIn(other);
  const run = JSON.parse(readFileSync(path.join(other, "run.json"), "utf8"));
  writeFileSync(path.join(other, "run.json"), JSON.stringify({ ...run, commit: "f".repeat(40) }));
  r = driverRun(dir, driver, args(other), { U: run.U });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /written by commit f{40}, not this paste's [0-9a-f]{40}/);
  assert.deepEqual(r.sends, []);
});

test("F1: in the run, the gate stands right before U's deposit signature, the prover's load and the withdrawal's signature, and before each sendTx", () => {
  const SRC = readFileSync(DRIVER, "utf8");
  assert.match(SRC, /sourceGate\("U signs its deposit"\);\n\s+const outcome = await bindDeposit\(/);
  assert.match(SRC, /sourceGate\("the prover loads and sees the note's secrets"\);\n\s+const prover = await nodeProver\(\);/);
  assert.match(SRC, /sourceGate\("the withdrawal is signed"\);\n\s+const out = await relayWithdraw\(/);
  assert.match(SRC, /async function sendTx\([^\n]*\n  sourceGate\(`\$\{signer\} signs`\);\n/);
  // a row of P met while the run waits is a stop unless ownDeposit proves it U's own
  assert.match(SRC, /const own = await ownDeposit\(\{ rows, want: wantOf\(\)[^\n]*\n\s+if \(own\.why !== null\) throw new Error\(`deposit: /);
  // each command starts with its source held, before anything is read
  for (const fn of ["go(argv: string[], create: boolean)", "openU(argv: string[])", "sweepU(argv: string[])"]) {
    const body = SRC.slice(SRC.indexOf(`async function ${fn}`));
    assert.match(body.slice(0, 400), /^[^\n]*\n[^\n]*flags\([^\n]*\n  const o = await opened\(started\(v\), /, fn);
  }
  assert.match(SRC.slice(SRC.indexOf("async function record(")), /const o = await opened\(started\(v\), /);
});
