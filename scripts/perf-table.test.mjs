// scripts/perf-table.mjs: a planted good record makes the table; each planted broken record is refused.
//   node --test scripts/perf-table.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRecord, loadRuns, renderReadme, renderDoc, replaceBlock, nearestRank, BEGIN, END } from "./perf-table.mjs";

const SIG = "2btTg7crbv6EL6DJtpNo67Vv9J2vioFHz4uMTuHR2hrWnJMumu7PQb9gYQwToV3ac55LGw418hL28JvChi8oc4Rv";
const good = () => ({
  schema: "perf-run/1", id: "solana-phone-test", chain: "solana", network: "mainnet", signer: "phone", date: "2026-10-26",
  source: "proofs/g1-phone-trade/results/live.json",
  series: [{ step: "buy", samples: [
    { ok: true, value: 1200, txs: [{ chain: "solana", network: "mainnet", id: SIG }], fee: { amount: "105000", unit: "lamports" } },
    { ok: true, value: 3225, txs: [] }, { ok: true, value: 900, txs: [] }, { ok: true, value: 1300, txs: [] }, { ok: true, value: 1000, txs: [] },
  ] }],
});
const dirWith = (records) => {
  const d = mkdtempSync(join(tmpdir(), "perf-runs-"));
  records.forEach((r, i) => writeFileSync(join(d, `r${i}.json`), typeof r === "string" ? r : JSON.stringify(r)));
  return d;
};

test("a good record makes the README row and the doc, p95 rounded up, links built from the id", () => {
  const d = dirWith([good()]);
  try {
    const runs = loadRuns(d);
    const block = renderReadme(runs);
    assert.ok(block.startsWith(BEGIN) && block.endsWith(END));
    assert.match(block, /\| Solana \| Buy \| 1\.2 s \/ 3\.3 s \| 5 of 5 \| mainnet, phone browser \| \[solana-phone-test\]\(docs\/performance\.md#solana-phone-test\) \|/);
    const doc = renderDoc(runs);
    assert.match(doc, /\| Buy \| tap to filled \| 5 \| 5 \| 1,200 ms \/ 3,225 ms \| 3,225 ms \| 0\.000105 SOL median \(n=1\) \|/);
    assert.ok(doc.includes(`(https://solscan.io/tx/${SIG})`));
  } finally { rmSync(d, { recursive: true }); }
});

test("nearest rank, and a failed sample counts as infinitely slow", () => {
  assert.equal(nearestRank([5, 1, 4, 2, 3], 50), 3);
  assert.equal(nearestRank([5, 1, 4, 2, 3], 95), 5);
  const r = good();
  r.series[0].samples.push({ ok: false, value: null, txs: [] });
  const block = renderReadme([checkRecord(r)]);
  assert.match(block, /\| 1\.2 s \/ failed \| 5 of 6 \|/);
});

const broken = {
  "an unknown chain": (r) => { r.chain = "bsc"; },
  "an unknown network": (r) => { r.network = "localnet"; },
  "a value that is not a number": (r) => { r.series[0].samples[0].value = "1200"; },
  "a negative value": (r) => { r.series[0].samples[1].value = -5; },
  "a value on a failed sample": (r) => { r.series[0].samples[1].ok = false; },
  "a tx id of the wrong chain": (r) => { r.series[0].samples[0].txs[0].id = "0x" + "ab".repeat(32); },
  "a URL in place of a tx id": (r) => { r.series[0].samples[0].txs[0].id = "https://evil.example/tx"; },
  "an extra field (a link from the record)": (r) => { r.series[0].samples[0].url = "https://evil.example"; },
  "a tx on a network with no reader": (r) => { r.series[0].samples[0].txs[0].network = "devnet"; },
  "markup in the note": (r) => { r.note = "<script>alert(1)</script>"; },
  "a source path that climbs out": (r) => { r.source = "../../etc/passwd"; },
  "no samples": (r) => { r.series[0].samples = []; },
  "a fee that is not a decimal string": (r) => { r.series[0].samples[0].fee.amount = 1e5; },
};
for (const [name, plant] of Object.entries(broken)) {
  test(`refused: ${name}`, () => {
    const r = good();
    plant(r);
    assert.throws(() => checkRecord(r, "planted.json"), /perf record planted\.json: /);
  });
}

test("refused: a record that is not JSON, and an id used twice", () => {
  let d = dirWith(["{not json"]);
  try { assert.throws(() => loadRuns(d), /not JSON/); } finally { rmSync(d, { recursive: true }); }
  d = dirWith([good(), good()]);
  try { assert.throws(() => loadRuns(d), /used twice/); } finally { rmSync(d, { recursive: true }); }
});

test("the README block is replaced between its markers, and a README without them is refused", () => {
  const readme = `# X\n\n${BEGIN}\nold\n${END}\n\nafter\n`;
  assert.equal(replaceBlock(readme, `${BEGIN}\nnew\n${END}`), `# X\n\n${BEGIN}\nnew\n${END}\n\nafter\n`);
  assert.throws(() => replaceBlock("# X\n", "b"), /no perf-table block/);
});
