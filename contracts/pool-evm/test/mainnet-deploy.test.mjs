// The owner's mainnet paste (script/mainnet-deploy.sh, card pool-evm-deploy-mainnet) with node and forge stubbed on
// PATH: each form runs exactly the commands it names, a bad form runs none, it reads nothing from stdin (no key or
// phrase is typed), and a deploy that fails never reaches the live check.
//   node --test contracts/pool-evm/test/mainnet-deploy.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PASTE = path.join(HERE, "../script/mainnet-deploy.sh");
const A = "0x49f2425b7f33f3a10912de8add6839226ce663a2";

/** Runs a copy of the paste in a folder of its own (its repository root) with stub node and forge; deploy.mjs's stub
 * writes the chain's record, as a completed run does; `fail` names a node script whose stub exits 2. Returns its
 * exit, output, root and the node calls, each as its argv. */
function paste(args, { fail = null, forge = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "pool-evm-paste-"));
  const root = path.join(dir, "root");
  mkdirSync(path.join(root, "contracts/pool-evm/script"), { recursive: true });
  copyFileSync(PASTE, path.join(root, "contracts/pool-evm/script/mainnet-deploy.sh"));
  const calls = path.join(dir, "calls");
  writeFileSync(calls, "");
  writeFileSync(path.join(dir, "node"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\ncase "$1" in ${fail ?? "__none__"}) exit 2 ;; esac\nif [ "$1" = contracts/pool-evm/script/deploy.mjs ] && [ "$5" = --return ]; then echo "{}" > "contracts/pool-evm/deployments/$4.json"; fi\nexit 0\n`);
  chmodSync(path.join(dir, "node"), 0o755);
  if (forge) writeFileSync(path.join(dir, "forge"), "#!/bin/sh\nexit 0\n"), chmodSync(path.join(dir, "forge"), 0o755);
  const r = spawnSync("sh", [path.join(root, "contracts/pool-evm/script/mainnet-deploy.sh"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }, timeout: 20_000 });
  return { status: r.status, out: r.stdout + r.stderr, root, calls: readFileSync(calls, "utf8").split("\n").filter(Boolean) };
}

test("the paste exists and is the one the deploy script names", () => {
  assert.ok(existsSync(PASTE), PASTE);
  assert.match(readFileSync(path.join(HERE, "../script/deploy.mjs"), "utf8"), /sh contracts\/pool-evm\/script\/mainnet-deploy\.sh \$\{chainName\} --sweep-kept/);
});

test("a deploy: deploy.mjs --mainnet with the chain and the return address, then the live check on its record; stdin is never read", () => {
  for (const chain of ["base", "robinhood"]) {
    const r = paste([chain, A]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.calls, [
      `contracts/pool-evm/script/deploy.mjs --mainnet --chain ${chain} --return ${A}`,
      `scripts/live-checks/pool-evm-deploy.mjs --deployment contracts/pool-evm/deployments/${chain}.json`,
    ]);
    // the record is the one-deploy guard: the paste names its folder, says to commit it now and to paste only there
    assert.ok(r.out.includes(`mainnet-deploy: the record contracts/pool-evm/deployments/${chain}.json in ${r.root} is the one-deploy guard: commit it now, and run every later paste for ${chain} in ${r.root}`), r.out);
  }
});

test("the sweep form: deploy.mjs --sweep-kept with the chain's journal and no address (the journal's return address only)", () => {
  const r = paste(["robinhood", "--sweep-kept"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, ["contracts/pool-evm/script/deploy.mjs --mainnet --chain robinhood --sweep-kept contracts/pool-evm/deployments/robinhood.journal.json"]);
});

test("a deploy that fails never reaches the live check, and the paste fails", () => {
  const r = paste(["base", A], { fail: "contracts/pool-evm/script/deploy.mjs" });
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.calls.length, 1, r.calls.join("\n"));
});

test("a bad form runs nothing: no chain, another chain, no address, a flag for an address, a third word; no forge runs nothing", () => {
  for (const args of [[], ["ethereum", A], ["base-sepolia", A], ["base"], ["base", "--return"], ["base", A, "x"], [A]]) {
    const r = paste(args);
    assert.equal(r.status, 1, args.join(" ") + r.out);
    assert.match(r.out, /^usage: sh contracts\/pool-evm\/script\/mainnet-deploy\.sh <base\|robinhood>/m);
    assert.deepEqual(r.calls, [], args.join(" "));
  }
  const r = paste(["base", A], { forge: false });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /forge is not on PATH/);
  assert.deepEqual(r.calls, []);
});
