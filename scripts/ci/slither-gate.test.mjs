// The Slither gate (slither-gate.mjs) on reports in Slither's --json shape: a planted untriaged Medium hit and an
// untriaged High hit are refused, a triaged one passes, a Low hit needs no entry, and a triage entry that matches no hit,
// has no reason or names another impact is refused, as is a run that did not finish; the CLI exits 1 on the planted hit
// and 0 once it is triaged. And the job: ci.yml's slither job installs the hashed slither-analyzer 0.11.6 and runs the
// gate on its report, and the repo's triage file reads.
//   node --test scripts/ci/slither-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gate } from "./slither-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "scripts/ci/slither-gate.mjs");

// one detector result as Slither 0.11 writes it (slither/utils/output.py): the element's name, its source mapping and,
// for a node, its function as the parent
const fn = (check, impact, file, name) => ({
  elements: [{ type: "function", name, source_mapping: { filename_relative: file, lines: [118, 119] }, type_specific_fields: { signature: name } }],
  description: `${name} (${file}#118-119) ${check}\n`,
  check, impact, confidence: "Medium", id: "0".repeat(64),
});
const node = (check, impact, file, fnName, expr) => ({
  elements: [{ type: "node", name: expr, source_mapping: { filename_relative: file, lines: [7] }, type_specific_fields: { parent: { type: "function", name: fnName } } }],
  description: `${fnName} ${check}\n`, check, impact, confidence: "High", id: "1".repeat(64),
});
const report = (...detectors) => ({ success: true, error: null, results: { detectors } });
const SEND = fn("arbitrary-send-eth", "High", "src/PrivacyPoolSimple.sol", "_push(address,uint256)");
const SEND_T = { check: "arbitrary-send-eth", impact: "High", file: "src/PrivacyPoolSimple.sol", element: "_push(address,uint256)", reason: "the payee is the one W signs for; the pool pays only a proven note" };
const PLANTED = node("reentrancy-no-eth", "Medium", "src/SellDelegate.sol", "sell(SellDelegate.Sell,uint256,bytes)", "_sell.target.call(_sell.data)");
const LOW = fn("missing-zero-check", "Low", "src/adapters/UniswapV3Adapter.sol", "constructor(address)");

test("a triaged High hit passes, and a Low hit needs no entry", () => {
  assert.deepEqual(gate(report(SEND, LOW), { findings: [SEND_T] }).refusals, []);
});

test("the planted untriaged Medium hit is refused, printed as the entry to add", () => {
  const r = gate(report(SEND, PLANTED, LOW), { findings: [SEND_T] }).refusals;
  assert.equal(r.length, 1);
  assert.match(r[0], /^untriaged Medium hit/);
  assert.ok(r[0].includes('"element":"sell(SellDelegate.Sell,uint256,bytes): _sell.target.call(_sell.data)"'), r[0]);
});

test("an untriaged High hit is refused", () => {
  assert.equal(gate(report(SEND), { findings: [] }).refusals.length, 1);
});

test("an entry for the same element under another detector does not triage a hit", () => {
  const r = gate(report(SEND), { findings: [{ ...SEND_T, check: "low-level-calls" }] }).refusals;
  assert.equal(r.length, 2, r.join("\n"));
});

test("a triage entry that matches no hit, has no reason or names another impact is refused", () => {
  assert.match(gate(report(), { findings: [SEND_T] }).refusals[0], /matches no hit/);
  assert.match(gate(report(SEND), { findings: [{ ...SEND_T, reason: "" }] }).refusals[0], /has no reason/);
  assert.match(gate(report(SEND), { findings: [{ ...SEND_T, impact: "Medium" }] }).refusals[0], /says Medium, Slither says High/);
});

test("a run that did not finish is refused, and a clean run passes", () => {
  assert.match(gate({ success: false, error: "forge build failed", results: {} }, { findings: [] }).refusals[0], /not a finished Slither run/);
  assert.match(gate({}, { findings: [] }).refusals[0], /not a finished Slither run/);
  assert.deepEqual(gate({ success: true, error: null, results: {} }, { findings: [] }).refusals, []);
});

test("the CLI exits 1 on the planted hit and 0 once it is triaged", () => {
  const dir = mkdtempSync(join(tmpdir(), "slither-gate-"));
  try {
    const rp = join(dir, "r.json");
    const tp = join(dir, "t.json");
    writeFileSync(rp, JSON.stringify(report(SEND, PLANTED)));
    writeFileSync(tp, JSON.stringify({ findings: [SEND_T] }));
    const red = spawnSync(process.execPath, [GATE, rp, tp], { encoding: "utf8" });
    assert.equal(red.status, 1, red.stderr);
    assert.match(red.stderr, /REFUSED: untriaged Medium hit/);
    const planted = { check: "reentrancy-no-eth", impact: "Medium", file: "src/SellDelegate.sol", element: "sell(SellDelegate.Sell,uint256,bytes): _sell.target.call(_sell.data)", reason: "the planted hit, triaged" };
    writeFileSync(tp, JSON.stringify({ findings: [SEND_T, planted] }));
    const green = spawnSync(process.execPath, [GATE, rp, tp], { encoding: "utf8" });
    assert.equal(green.status, 0, green.stderr);
    assert.match(green.stdout, /2 hits \(High 1, Medium 1\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ci.yml's slither job installs the hashed slither-analyzer 0.11.6 and gates its report; the triage file reads", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const job = ci.slice(ci.indexOf("\n  slither:\n"));
  assert.ok(ci.includes("\n  slither:\n"), "the slither job");
  const end = job.slice(1).search(/\n {2}[\w-]+:\n/);
  const body = end < 0 ? job : job.slice(0, end + 1);
  assert.match(body, /bin\/pip"? install --require-hashes --no-deps -r contracts\/pool-evm\/slither\/requirements\.txt/);
  assert.match(body, /slither \. --json \S+ --fail-none/);
  assert.match(body, /node scripts\/ci\/slither-gate\.mjs /);
  for (const u of body.match(/uses:\s*\S+/g) ?? []) assert.match(u, /@[0-9a-f]{40}$/, `${u} pinned by sha`);
  const req = readFileSync(join(ROOT, "contracts/pool-evm/slither/requirements.txt"), "utf8");
  assert.match(req, /^slither-analyzer==0\.11\.6 \\$/m);
  for (const pkg of req.split("\n").filter((l) => /^[a-z0-9-]+==/.test(l))) assert.ok(pkg.endsWith(" \\"), `${pkg} carries its hashes`);
  const triage = JSON.parse(readFileSync(join(ROOT, "contracts/pool-evm/slither/triage.json"), "utf8"));
  assert.ok(Array.isArray(triage.findings));
  assert.deepEqual(gate({ success: true, error: null, results: {} }, triage).refusals.filter((r) => !/matches no hit/.test(r)), []);
});
