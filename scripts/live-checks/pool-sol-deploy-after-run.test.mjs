// SPDX-License-Identifier: Apache-2.0
// Replays pool-sol-deploy-after-run.answers.json through the live check: the recorded good answer (mainnet, both RPCs,
// every run key of the record and its kept journals at 0) passes; each recorded bad answer (a funder, the buffer a
// deploy drained, a closed account or a program id holding lamports) fails on its own line. The recorded inputs are the
// committed files' own.
//   node --test scripts/live-checks/pool-sol-deploy-after-run.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check, inputs } from "./pool-sol-deploy-after-run.mjs";
import { MAINNET_RPCS } from "./pool-sol-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-sol-deploy-after-run.answers.json", import.meta.url), "utf8"));

function replay(answers) {
  const used = new Set();
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const i = answers.findIndex((a, j) => !used.has(j) && a.url === url && a.method === method && JSON.stringify(a.params) === JSON.stringify(params));
    if (i < 0) throw new Error(`no recorded answer for ${method} ${JSON.stringify(params).slice(0, 80)} on ${url}`);
    used.add(i);
    const a = answers[i];
    return { ok: a.status === 200, status: a.status, json: async () => a.json };
  };
}
const run = (answers, { record = A.record, journals = A.journals } = {}) => check({ record, journals, fetchFn: replay(answers), rpcs: A.rpcs, sleep: async () => {} });
function patched(bad) {
  const out = structuredClone(A.good);
  for (const a of out) if (a.method === bad.method && a.params[0] === bad.address && (bad.url === "both" || a.url === bad.url)) a.json.result.value = bad.value;
  return out;
}

test("the recorded good answer passes: every run key of the record and its journals at 0 on both mainnet RPCs", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(A.rpcs, MAINNET_RPCS);
  // the funders, the buffer paste 2 deployed through, the account paste 1's CLI closed, on each RPC; both program ids
  assert.equal(r.lines.filter((l) => /^ok {3}\S+ \(.*\) holds 0 lamports on /.test(l)).length, 2 * 4, r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => /holds no lamports or is a deployed program/.test(l)).length, 2 * 2);
});

for (const bad of A.bad) {
  test(`recorded bad answer fails: ${bad.name}`, async () => {
    const r = await run(patched(bad));
    assert.equal(r.ok, false, r.lines.join("\n"));
    assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), new RegExp(bad.fails, "m"));
  });
}

test("the recorded inputs are the committed record's and journals'", () => {
  assert.deepEqual(inputs(), { record: A.record, journals: A.journals });
});

test("a buffer the record names (a run since card pool-sol-deploy-after-run) is a run key: holding lamports FAILs", async () => {
  const BUF = "5NnSH7DQ5bAq8gC1G6e2dQoE1LVCxjnxc7xnpERoaQvo";
  const r = await run(patched({ method: "getBalance", address: BUF, url: "both", value: 7 }), { record: { ...A.record, buffer: BUF } });
  assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), new RegExp(`${BUF} \\(.*\\) holds 0 lamports on \\S+: 7$`, "m"));
});
