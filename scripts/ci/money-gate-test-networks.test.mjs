// Card money-gate-test-networks-never-proof (owner, 12 Nov: no test networks, mainnet is the proof): a change whose
// record adds a Tx (or Deleted) line on a test network is refused; a test-network line a record held before the change,
// and every one under --all, is named as test-network history and never read; mainnet lines are judged as before.
// Before it, --all read the 585 test-network lines and failed on 215 solana-devnet txs whose only second operator,
// OnFinality's devnet host, keeps history from block 523,247,104 (read 21 Nov). Run: node --test scripts/ci/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moneyGate, outcome, recordsFrom } from "./money-gate.mjs";

const GATE = fileURLToPath(new URL("./money-gate.mjs", import.meta.url));
const SOL_TX = "2z6qyzLaN9dV3SUaNyCGXm4zPQTQ61vuJJnTvbn3vzPkZNwQ8KJhCEETJeN7vtM9y5BeuGDxCDwrkfAHKUc6rZDw";
const SOL_TX2 = "4hN9gQ1PQPSDUJrHAXLHDaYd6mK2C6V3a3KtSoMoUb3nC2X1MEiKswTo6XzGfuoQ7Fb1Le7x3JU648dMwcdrLDA8";
const NEAR_TX = "Bv7hjXuDcC9WePLNbq3qntubUKqDR8x8dvgJSSH7mk8o";
const BASE_TX = "0x" + "ab".repeat(32);
const RPCS = { solana: ["s1", "s2"], "solana-devnet": ["d1", "d2"], near: ["n1", "n2"], "near-testnet": ["t1", "t2"], base: ["b1", "b2"], "base-sepolia": ["e1", "e2"] };
const NOV2 = Date.parse("2026-11-02T00:00:00Z") / 1000;
const HEAD = "CARD demo / live: PASS\nMoney path: yes\n";

/** A host stub that records every read; `answer(url, method)` gives the JSON-RPC body. */
function hosts(answer) {
  const asked = [];
  const fetchFn = async (url, init) => {
    const { method } = JSON.parse(init.body);
    asked.push(`${url} ${method}`);
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ jsonrpc: "2.0", id: 1, ...answer(url, method) }) };
  };
  return { fetchFn, asked, sleep: async () => undefined };
}
const okSolana = (url, method) => (method === "getTransaction" ? { result: { slot: 1, meta: { err: null }, blockTime: NOV2 } } : method === "getFirstAvailableBlock" ? { result: 0 } : {});

/** A git repo with `files` at a base commit and `next` at a head commit (null deletes); runs `fn(dir, base, head)`. */
function repo(files, next, fn) {
  const dir = mkdtempSync(join(tmpdir(), "money-gate-tn-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" }).trim();
  const put = (set) => {
    for (const [f, text] of Object.entries(set)) {
      mkdirSync(join(dir, "scripts/live-checks"), { recursive: true });
      writeFileSync(join(dir, "scripts/live-checks", f), text);
      git("add", `scripts/live-checks/${f}`);
    }
  };
  try {
    git("init", "-q");
    put(files);
    git("commit", "-q", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    put(next);
    git("commit", "-q", "--allow-empty", "-m", "Card demo: head");
    return fn(dir, base, git("rev-parse", "HEAD"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("planted: a change whose record adds a test-network Tx line is refused, on every test network, and nothing is read for it", async () => {
  for (const line of [`Tx: solana-devnet ${SOL_TX}`, `Tx: near-testnet ${NEAR_TX} demo.testnet`, `Tx: base-sepolia ${BASE_TX}`]) {
    await repo({}, { "demo.md": `${HEAD}${line}\n` }, async (dir, base, head) => {
      const { records, every, money } = recordsFrom(dir, [base, head]);
      const h = hosts(() => ({}));
      const r = await moneyGate(records, h.fetchFn, RPCS, { every, money, sleep: h.sleep });
      assert.deepEqual(r.refusals, [`scripts/live-checks/demo.md: ${line.slice(4).split(" ").slice(0, 2).join(" ")}: a test network is never money proof; record the run on mainnet`], line);
      assert.equal(outcome(r), 1, line);
      assert.deepEqual(h.asked, [], line);
    });
  }
});

test("planted: a new test-network line beside one the record held before the change: only the new one is refused, the held one named as history, the mainnet line read", async () => {
  const before = `${HEAD}Tx: solana-devnet ${SOL_TX}\n`;
  await repo({ "demo.md": before }, { "demo.md": `${before}Tx: solana ${SOL_TX2}\nTx: solana-devnet ${SOL_TX2}\n` }, async (dir, base, head) => {
    const { records, every, money } = recordsFrom(dir, [base, head]);
    const h = hosts(okSolana);
    const r = await moneyGate(records, h.fetchFn, RPCS, { every, money, sleep: h.sleep });
    assert.deepEqual(r.refusals, [`scripts/live-checks/demo.md: solana-devnet ${SOL_TX2}: a test network is never money proof; record the run on mainnet`]);
    assert.deepEqual(r.history, [`scripts/live-checks/demo.md: solana-devnet ${SOL_TX}`]);
    assert.deepEqual(r.read, ["s1", "s2"].map((u) => `solana ${SOL_TX2} ok on ${u}`));
    assert.ok(h.asked.every((a) => /^s[12] /.test(a)), h.asked.join(", "));
  });
});

test("planted: a change whose record adds a test-network Deleted line is refused", async () => {
  await repo({}, { "demo.md": `${HEAD}Tx: near-testnet ${NEAR_TX} demo.testnet\nDeleted: near-testnet demo.testnet\n` }, async (dir, base, head) => {
    const { records, every, money } = recordsFrom(dir, [base, head]);
    const h = hosts(() => ({}));
    const r = await moneyGate(records, h.fetchFn, RPCS, { every, money, sleep: h.sleep });
    assert.deepEqual(r.refusals, [`scripts/live-checks/demo.md: near-testnet ${NEAR_TX}: a test network is never money proof; record the run on mainnet`, "scripts/live-checks/demo.md: Deleted near-testnet demo.testnet: a test network is never money proof; record the run on mainnet"]);
    assert.deepEqual(h.asked, []);
  });
});

test("planted: --all over records holding only test-network lines does not fail: each is named as history by file and tx, none read", async () => {
  await repo({ "demo.md": `${HEAD}Tx: solana-devnet ${SOL_TX}\nTx: near-testnet ${NEAR_TX} demo.testnet\n`, "b.md": `CARD b / live: PASS\nMoney path: yes\nTx: base-sepolia ${BASE_TX}\n` }, {}, async (dir) => {
    const { records, every, money } = recordsFrom(dir, ["--all"]);
    const h = hosts(() => ({}));
    const r = await moneyGate(records, h.fetchFn, RPCS, { every, money, sleep: h.sleep });
    assert.deepEqual(r.refusals, []);
    assert.equal(outcome(r), 0);
    assert.deepEqual(r.history.sort(), [`scripts/live-checks/b.md: base-sepolia ${BASE_TX}`, `scripts/live-checks/demo.md: near-testnet ${NEAR_TX}`, `scripts/live-checks/demo.md: solana-devnet ${SOL_TX}`]);
    assert.deepEqual(h.asked, []);
  });
});

test("planted: a mainnet tx absent on two operators is still refused, under --all and in a change, a test-network line beside it or not", async () => {
  const absent = (url, method) => (method === "getTransaction" ? { result: null } : method === "getFirstAvailableBlock" ? { result: 0 } : {});
  const text = `${HEAD}Tx: solana ${SOL_TX2}\nTx: solana-devnet ${SOL_TX}\n`;
  await repo({ "demo.md": text }, {}, async (dir) => {
    const { records, every, money } = recordsFrom(dir, ["--all"]);
    const h = hosts(absent);
    const r = await moneyGate(records, h.fetchFn, RPCS, { every, money, sleep: h.sleep });
    assert.match(r.refusals.join("\n"), new RegExp(`solana ${SOL_TX2}: missing on s1, missing on s2$`));
    assert.equal(outcome(r), 1);
  });
  await repo({}, { "demo.md": `${HEAD}Tx: solana ${SOL_TX2}\n` }, async (dir, base, head) => {
    const { records, every, money } = recordsFrom(dir, [base, head]);
    const h = hosts(absent);
    const r = await moneyGate(records, h.fetchFn, RPCS, { every, money, sleep: h.sleep });
    assert.match(r.refusals.join("\n"), new RegExp(`solana ${SOL_TX2}: missing on s1, missing on s2$`));
  });
});

test("planted: the command line never reads a test network: a change adding a devnet line exits 1 REFUSED, --all over it exits 0 naming it as history", () => {
  repo({}, { "demo.md": `${HEAD}Tx: solana-devnet ${SOL_TX}\n` }, (dir, base, head) => {
    const change = spawnSync(process.execPath, [GATE, base, head], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    assert.equal(change.status, 1, change.stderr);
    assert.match(change.stderr, new RegExp(`REFUSED: scripts/live-checks/demo\\.md: solana-devnet ${SOL_TX}: a test network is never money proof`));
    const all = spawnSync(process.execPath, [GATE, "--all"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, new RegExp(`test-network history, not proof: scripts/live-checks/demo\\.md: solana-devnet ${SOL_TX}`));
    assert.match(all.stdout, /PASS \(1 record\(s\) read, 0 tx read\(s\), 1 test-network line\(s\) named, not read\)/);
  });
});
