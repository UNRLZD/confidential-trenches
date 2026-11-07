// node --test contracts/vault/scripts/mainnet-v1-pastes.test.mjs: the mainnet vault's pastes (mainnet-v1/), offline.
// gh, node and npx are stubs put first on PATH: each records its arguments and does what the case plants (gh answers the
// run's identity and writes the downloaded wasm, node exits as the case says and prints its lines). Nothing reaches a
// network or a key: the key file path is only passed on.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { MAINNET_PINS, MAINNET_RPCS } from "./deploy.mjs";
import { RPCS, registration, senderProblems } from "./mainnet-v1/reads.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "mainnet-v1");
const PIN = JSON.parse(readFileSync(path.join(HERE, "..", "deployments", "mainnet-v1.pin.json"), "utf8"));
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), "mainnet-v1-pastes-")));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GOOD_RUN = `UNRLZD/confidential-trenches ${PIN.source_commit} .github/workflows/vault-build.yml completed success`;
let n = 0;

// a temp repo-shaped tree holding `paste` at contracts/vault/scripts/mainnet-v1/, with `edit` applied to its text,
// and a bin of stubs; returns its paths
function world(paste, { edit = (s) => s, run = GOOD_RUN, wasm = "not the vault", nodeExit = 0, nodeOut = "", record = false, npxExit = 0, pending = null } = {}) {
  const root = path.join(TMP, String(n++));
  const dir = path.join(root, "contracts", "vault", "scripts", "mainnet-v1");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  for (const d of [dir, bin, home, path.join(root, "contracts", "vault", "deployments"), path.join(root, "scripts", "live-checks")]) mkdirSync(d, { recursive: true });
  const pend = path.join(root, "scripts", "live-checks", "vault-mainnet-deploy.pending");
  if (pending !== null) writeFileSync(pend, pending);
  if (record) writeFileSync(path.join(root, "contracts", "vault", "deployments", "mainnet-v1.json"), "{}\n");
  writeFileSync(path.join(dir, paste), edit(readFileSync(path.join(DIR, paste), "utf8")));
  const log = path.join(root, "calls");
  const stub = (name, body) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  writeFileSync(path.join(root, "wasm"), wasm);
  writeFileSync(path.join(root, "node-out"), nodeOut);
  stub("gh", `case "$1" in api) printf '%s\\n' ${JSON.stringify(run)} ;; run) while [ $# -gt 0 ]; do [ "$1" = -D ] && D="$2"; shift; done; cp "${root}/wasm" "$D/blindfill_vault.wasm" ;; esac`);
  stub("node", `cat "${root}/node-out"; exit ${nodeExit}`);
  stub("npx", `[ -f "${pend}" ] && printf 'pending at npx: %s\\n' "$(tr '\\n' ' ' < "${pend}")" >> "${log}"; [ ${npxExit} = 0 ] || exit ${npxExit}; echo "Transaction ID: ${"7".repeat(44)}"`);
  return { root, file: path.join(dir, paste), home, bin, log, pend };
}
const exec = (w) => spawnSync("/bin/sh", [w.file], { encoding: "utf8", timeout: 30_000, env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home } });
const calls = (w) => (existsSync(w.log) ? readFileSync(w.log, "utf8").trim().split("\n") : []);
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("2-deploy.sh pins the run, the commit and the sha256 that mainnet-v1.pin.json and MAINNET_PINS hold, for vault.confidential.unrlzd.near", () => {
  const s = readFileSync(path.join(DIR, "2-deploy.sh"), "utf8");
  const v = (k) => new RegExp(`^${k}=(\\S+)$`, "m").exec(s)?.[1];
  assert.equal(v("RUN"), String(PIN.artifact.run));
  assert.equal(v("REVIEWED"), PIN.source_commit);
  assert.equal(v("PIN"), PIN.wasm_sha256);
  assert.equal(MAINNET_PINS[PIN.account_id], PIN.wasm_sha256);
  assert.match(s, /--parent confidential\.unrlzd\.near \\\n  --vault vault\.confidential\.unrlzd\.near \\\n/);
  assert.match(s, /--deployment contracts\/vault\/deployments\/mainnet-v1\.pin\.json --out contracts\/vault\/deployments\/mainnet-v1\.json \\\n  \$\{RESUME:\+--resume-tx "\$RESUME"\}\n$/);
});

test("2-deploy.sh refuses a run that is not the reviewed commit's, before any download or deploy", () => {
  const w = world("2-deploy.sh", { run: GOOD_RUN.replace(PIN.source_commit, "f".repeat(40)) });
  const r = exec(w);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /not UNRLZD\/confidential-trenches at e0623bf3\S+, completed and successful: nothing was sent/);
  assert.deepEqual(calls(w).map((c) => c.split(" ").slice(0, 2).join(" ")), ["gh api"]);
});

test("2-deploy.sh refuses a wasm whose sha256 is not the pin, before deploy.mjs runs", () => {
  const w = world("2-deploy.sh", { wasm: "a wasm that is not the pinned build" });
  const r = exec(w);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`hashes to ${sha("a wasm that is not the pinned build")}, not the pin ${PIN.wasm_sha256}: nothing was sent`));
  assert.ok(!calls(w).some((c) => c.startsWith("node ")), calls(w).join("\n"));
});

test("2-deploy.sh with the pin's wasm runs deploy.mjs once, on mainnet, from the pin record to mainnet-v1.json", () => {
  const wasm = "a planted wasm standing in for the pinned build";
  const w = world("2-deploy.sh", { wasm, edit: (s) => s.replace(/^PIN=.*$/m, `PIN=${sha(wasm)}`) });
  const r = exec(w);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const node = calls(w).filter((c) => c.startsWith("node "));
  assert.equal(node.length, 1);
  assert.match(node[0], new RegExp(`^node contracts/vault/scripts/deploy\\.mjs --network mainnet --parent confidential\\.unrlzd\\.near --vault vault\\.confidential\\.unrlzd\\.near --key-file ${w.home}/\\.confidential-trenches/keys/confidential\\.unrlzd\\.near\\.json --wasm \\S+/blindfill_vault\\.wasm --deployment contracts/vault/deployments/mainnet-v1\\.pin\\.json --out contracts/vault/deployments/mainnet-v1\\.json$`));
});

test("3-readback-write.sh signs nothing without mainnet-v1.json, or when the check's reads do not pass", () => {
  const none = world("3-readback-write.sh", { nodeExit: 3 });
  let r = exec(none);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no contracts\/vault\/deployments\/mainnet-v1\.json: run paste 2 first; nothing was signed/);
  assert.deepEqual(calls(none), []);
  const failed = world("3-readback-write.sh", { nodeExit: 1, record: true, nodeOut: "live-check vault-mainnet: FAIL\n" });
  r = exec(failed);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /the reads did not pass \(exit 1\): nothing was signed/);
  assert.ok(!calls(failed).some((c) => c.startsWith("npx ")));
});

test("3-readback-write.sh sends the printed storage_prepay once, then reads it back by its id and records the answer", () => {
  const line = `near call vault.confidential.unrlzd.near storage_prepay '{"precommitment":"12345"}' --useAccount confidential.unrlzd.near --depositYocto 7560000000000000000000 --gas 30000000000000 --networkId mainnet`;
  const w = world("3-readback-write.sh", { nodeExit: 3, record: true, nodeOut: `${line}\n` });
  exec(w);
  const c = calls(w).filter((x) => !x.startsWith("pending at npx: "));
  assert.equal(c[0], "node scripts/live-checks/vault-mainnet-deploy.mjs");
  assert.equal(c[1], `npx --yes near-cli-rs@0.30.1 contract call-function as-transaction vault.confidential.unrlzd.near storage_prepay json-args {"precommitment":"12345"} prepaid-gas 30 Tgas attached-deposit 7560000000000000000000 yoctoNEAR sign-as confidential.unrlzd.near network-config mainnet sign-with-access-key-file ${w.home}/.confidential-trenches/keys/confidential.unrlzd.near.json send`);
  assert.equal(c[2], `node scripts/live-checks/vault-mainnet-deploy.mjs --precommitment 12345 --tx ${"7".repeat(44)} --record scripts/live-checks/vault-mainnet-deploy.answers.json`);
});

test("4-fee-recipient.sh registers fees.unrlzd.near only, with exactly USDC's 0.00125 N bound, from the parent's key file", () => {
  const s = readFileSync(path.join(DIR, "4-fee-recipient.sh"), "utf8");
  assert.match(s, /^FEES=fees\.unrlzd\.near$/m);
  assert.match(s, /^MIN=1250000000000000000000$/m);
  assert.match(s, /^USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1$/m);
  assert.equal(PIN.asset, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  const w = world("4-fee-recipient.sh", { nodeExit: 1 });
  const r = exec(w);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /the reads did not pass \(exit 1\): nothing was sent/);
  assert.ok(!calls(w).some((c) => c.startsWith("npx ")));
});

test("1-fund-parent.sh sends 2 NEAR from unrlzd.near to confidential.unrlzd.near only, after the sender reads enough, with near-cli-rs's log kept in a private TMPDIR", () => {
  const s = readFileSync(path.join(DIR, "1-fund-parent.sh"), "utf8");
  assert.match(s, /^SENDER=unrlzd\.near$/m);
  assert.match(s, /^NEED=2010000000000000000000000$/m);
  assert.match(s, /TMPDIR="\$PRIV" npx --yes near-cli-rs@0\.30\.1 --quiet tokens "\$SENDER" send-near confidential\.unrlzd\.near '2 NEAR' \\\n  network-config mainnet sign-with-seed-phrase\n/);
  const w = world("1-fund-parent.sh");
  const r = exec(w);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = calls(w);
  assert.equal(c.length, 2);
  assert.match(c[0], /^node \S+\/reads\.mjs sender unrlzd\.near 2010000000000000000000000$/);
  assert.match(c[1], /^npx --yes near-cli-rs@0\.30\.1 --quiet tokens unrlzd\.near send-near confidential\.unrlzd\.near 2 NEAR /);
  assert.match(r.stdout, /Press Cmd-K now to clear this window/);
});

// review H1: a sender that cannot pay is refused before near-cli-rs prompts for its seed phrase
test("1-fund-parent.sh with a sender short of 2 NEAR + the fee margin: refused, near-cli-rs never runs, no phrase is asked", () => {
  const w = world("1-fund-parent.sh", { nodeExit: 1 });
  const r = exec(w);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /cannot pay 2 NEAR \+ the 0\.01 NEAR fee margin on both RPCs \(above\): nothing was typed or sent/);
  assert.ok(!calls(w).some((c) => c.startsWith("npx ")), calls(w).join("\n"));
});

// reads.mjs on planted answers: each RPC is asked, at final, and each answer decides
const answering = (byUrl) => {
  const asked = [];
  const f = async (url, init) => {
    const { params } = JSON.parse(init.body);
    asked.push([url, params.request_type, params.method_name ?? null, params.finality]);
    const a = byUrl(url, params);
    return { json: async () => (a instanceof Error ? { error: { name: a.message } } : { result: a }) };
  };
  return Object.assign(f, { asked });
};
const bytes = (o) => ({ result: [...Buffer.from(JSON.stringify(o))], block_height: 1 });
const silent = () => {};

test("reads.mjs sender: the account's amount minus its storage must cover the need on both RPCs; the shortfall is named", async () => {
  assert.deepEqual(RPCS, MAINNET_RPCS);
  const need = 2010000000000000000000000n;
  // unrlzd.near as read 7 Nov 12:4xZ: 0.459170778124110700000000 N, 264 B
  const short = answering(() => ({ amount: "459170778124110700000000", storage_usage: 264, block_height: 1 }));
  const p = await senderProblems({ fetchFn: short, account: "unrlzd.near", need, log: silent });
  assert.equal(p.length, 2);
  assert.match(p[0], /^unrlzd\.near can spend 0\.4565307781241107 N on https:\/\/rpc\.mainnet\.fastnear\.com, short of 2\.01 N by 1\.5534692218758893 N$/);
  assert.deepEqual(short.asked.map((a) => [a[0], a[1], a[3]]), RPCS.map((u) => [u, "view_account", "final"]));
  // exactly enough after storage passes; one yocto less fails; storage counts
  const exact = (n) => answering(() => ({ amount: String(n + 264n * 10n ** 19n), storage_usage: 264, block_height: 1 }));
  assert.deepEqual(await senderProblems({ fetchFn: exact(need), account: "unrlzd.near", need, log: silent }), []);
  assert.equal((await senderProblems({ fetchFn: exact(need - 1n), account: "unrlzd.near", need, log: silent })).length, 2);
  // enough on one RPC only, or an error on one: refused
  const split = answering((u) => (u === RPCS[0] ? { amount: "9000000000000000000000000", storage_usage: 264 } : { amount: "1", storage_usage: 264 }));
  assert.equal((await senderProblems({ fetchFn: split, account: "unrlzd.near", need, log: silent })).length, 1);
  const down = answering((u) => (u === RPCS[1] ? new Error("UNKNOWN_ACCOUNT") : { amount: "9000000000000000000000000", storage_usage: 264 }));
  assert.match((await senderProblems({ fetchFn: down, account: "unrlzd.near", need, log: silent })).join(";"), /UNKNOWN_ACCOUNT/);
});

test("reads.mjs registration: bounds must be min = max = the attached amount on both RPCs; registered or not must agree", async () => {
  const MIN = 1250000000000000000000n;
  const chain = ({ bounds = { min: String(MIN), max: String(MIN) }, of = [null, null] } = {}) => answering((u, params) => (params.method_name === "storage_balance_bounds" ? bytes(bounds) : bytes(of[RPCS.indexOf(u)])));
  const T = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const fresh = await registration({ fetchFn: chain(), token: T, account: "fees.unrlzd.near", min: MIN, log: silent });
  assert.deepEqual(fresh, { state: "unregistered", problems: [] });
  for (const bounds of [{ min: String(MIN), max: String(MIN * 2n) }, { min: "1", max: "1" }, null]) {
    const r = await registration({ fetchFn: chain({ bounds }), token: T, account: "fees.unrlzd.near", min: MIN, log: silent });
    assert.equal(r.state, undefined, JSON.stringify(bounds));
    assert.match(r.problems.join(";"), /storage_balance_bounds on .* not min = max = 1250000000000000000000/);
  }
  const reg = { total: String(MIN), available: "0" };
  assert.deepEqual(await registration({ fetchFn: chain({ of: [reg, reg] }), token: T, account: "fees.unrlzd.near", min: MIN, log: silent }), { state: "registered", problems: [] });
  assert.match((await registration({ fetchFn: chain({ of: [reg, null] }), token: T, account: "fees.unrlzd.near", log: silent })).problems.join(";"), /the RPCs disagree/);
  // fee-after reads no bounds
  const after = chain({ bounds: null, of: [reg, reg] });
  assert.deepEqual(await registration({ fetchFn: after, token: T, account: "fees.unrlzd.near", log: silent }), { state: "registered", problems: [] });
  assert.ok(after.asked.every((a) => a[2] === "storage_balance_of" && a[3] === "final"));
});

test("4-fee-recipient.sh tells the owner to rerun when the send fails, and a rerun reads before it sends", () => {
  const w = world("4-fee-recipient.sh", { npxExit: 1 });
  const r = exec(w);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /the send failed, or its answer was lost\. Rerun this paste: it reads fees\.unrlzd\.near's registration first and sends nothing once it is registered on both RPCs/);
  assert.match(calls(w)[0], /^node \S+\/reads\.mjs fee-before 17208628\S+ fees\.unrlzd\.near 1250000000000000000000$/);
});

// review L3: one storage_prepay at most
test("3-readback-write.sh writes P to its pending file before the send and the tx after, then reads back and removes the file", () => {
  const line = `near call vault.confidential.unrlzd.near storage_prepay '{"precommitment":"12345"}' --useAccount confidential.unrlzd.near --depositYocto 7560000000000000000000 --gas 30000000000000 --networkId mainnet`;
  const w = world("3-readback-write.sh", { nodeExit: 3, record: true, nodeOut: `${line}\n` });
  exec(w);
  assert.ok(calls(w).includes("pending at npx: P 12345 "), calls(w).join("\n"));
});

test("3-readback-write.sh with a pending P and no tx sends nothing and says how to finish; with the tx given it reads that P back", () => {
  const stuck = world("3-readback-write.sh", { record: true, pending: "P 777\n" });
  let r = exec(stuck);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /a storage_prepay of precommitment 777 may have been sent already .*nothing was signed\. .*3-readback-write\.sh <its id>/);
  assert.deepEqual(calls(stuck), []);
  const tx = "5".repeat(44);
  const given = world("3-readback-write.sh", { record: true, pending: "P 777\n" });
  r = spawnSync("/bin/sh", [given.file, tx], { encoding: "utf8", timeout: 30_000, env: { PATH: `${given.bin}:/usr/bin:/bin`, HOME: given.home } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(given), [`node scripts/live-checks/vault-mainnet-deploy.mjs --precommitment 777 --tx ${tx} --record scripts/live-checks/vault-mainnet-deploy.answers.json`]);
  assert.equal(existsSync(given.pend), false);
  const kept = world("3-readback-write.sh", { record: true, pending: `P 777\nTX ${tx}\n` });
  exec(kept);
  assert.deepEqual(calls(kept), [`node scripts/live-checks/vault-mainnet-deploy.mjs --precommitment 777 --tx ${tx} --record scripts/live-checks/vault-mainnet-deploy.answers.json`]);
});

test("3-readback-write.sh whose send fails says not to send again and keeps the pending P", () => {
  const line = `near call vault.confidential.unrlzd.near storage_prepay '{"precommitment":"12345"}' --useAccount confidential.unrlzd.near --depositYocto 7560000000000000000000 --gas 30000000000000 --networkId mainnet`;
  const w = world("3-readback-write.sh", { nodeExit: 3, record: true, nodeOut: `${line}\n`, npxExit: 1 });
  const r = exec(w);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /do not send again\. If it landed, run: sh contracts\/vault\/scripts\/mainnet-v1\/3-readback-write\.sh <its Transaction ID>/);
  assert.equal(readFileSync(w.pend, "utf8"), "P 12345\n");
});

test("2-deploy.sh --resume-tx <hash> passes the resume to deploy.mjs after the same run and sha checks; any other argument is refused", () => {
  const wasm = "a planted wasm standing in for the pinned build";
  const hash = "6".repeat(44);
  const w = world("2-deploy.sh", { wasm, edit: (s) => s.replace(/^PIN=.*$/m, `PIN=${sha(wasm)}`) });
  const r = spawnSync("/bin/sh", [w.file, "--resume-tx", hash], { encoding: "utf8", timeout: 30_000, env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const node = calls(w).filter((c) => c.startsWith("node "));
  assert.equal(node.length, 1);
  assert.match(node[0], new RegExp(`--out contracts/vault/deployments/mainnet-v1\\.json --resume-tx ${hash}$`));
  const bad = spawnSync("/bin/sh", [w.file, "--other"], { encoding: "utf8", env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home } });
  assert.equal(bad.status, 2);
});
