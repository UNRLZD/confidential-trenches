// node --test scripts/live-checks/money-gate-testnet.test.mjs: the live check replays a recorded run
// (money-gate-testnet.answers.json: every RPC answer of a real run on 2026-10-31, the three testnet RPCs and the three
// mainnet ones). The run read two txs of the vault-gas run on NEAR testnet, its first deposit (2026-10-26T03:45:21Z,
// the old tx) and its fifth (03:45:41Z, standing in for the fresh tx, as no testnet tx after FLOOR exists before
// Nov 1). The good answer replays it with the floor between the two: PASS. The bad answer replays the same answers
// under the gate's own FLOOR, where the fifth deposit is old too: FAIL.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, OLD } from "./money-gate-testnet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "money-gate-testnet.answers.json"), "utf8"));
const FRESH = { hash: "4UJNnhT9ktb1pzYknhVsMsoqw2EPfhpzHUrFEifXo8K5", signer: "g1vg-20261026b.testnet" };
const BETWEEN = Date.parse("2026-10-26T03:45:30Z");

// each request gets the recorded answers to the same request in order, the last one again once they run out
function replay(answers) {
  const queues = new Map();
  for (const a of answers) {
    const k = `${a.url} ${a.method} ${JSON.stringify(a.params)}`;
    queues.set(k, [...(queues.get(k) ?? []), a]);
  }
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const q = queues.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!q) throw new Error(`no recorded answer for ${method} on ${url}`);
    const a = q.length > 1 ? q.shift() : q[0];
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json };
  };
}

test("the recording holds the testnet and mainnet RPCs' answers to both txs", () => {
  const urls = new Set(ANSWERS.map((a) => a.url));
  for (const u of ["https://archival-rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://archival-rpc.mainnet.fastnear.com"]) assert.ok(urls.has(u), u);
  const hashes = new Set(ANSWERS.filter((a) => a.method === "tx").map((a) => a.params.tx_hash));
  assert.deepEqual([...hashes].sort(), [OLD.hash, FRESH.hash].sort());
  // no signature is kept: it has a NEAR secret key's shape
  assert.doesNotMatch(JSON.stringify(ANSWERS), /ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}/);
});

test("recorded good answer: fresh after the floor, old before it, the fresh one unknown on mainnet: PASS", async () => {
  const r = await check({ fresh: FRESH, fetchFn: replay(ANSWERS), floor: BETWEEN });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0], /^ok  the fresh tx as near-testnet reads ok on 2 testnet RPC\(s\): /);
  assert.match(r.lines[1], /^ok  the old tx as near-testnet is refused as old: .*old: 2026-10-26T03:45:21\.986Z is before 2026-10-26T03:45:30\.000Z on https:\/\/archival-rpc\.testnet\.fastnear\.com/);
  assert.match(r.lines[2], /^ok  the fresh tx as near is refused on the mainnet RPCs: .*missing on https:\/\/archival-rpc\.mainnet\.fastnear\.com/);
  assert.equal(r.lines[3], "ok  the near-testnet record counts 0 real-money tx(s)");
});

test("recorded bad answer: the fresh tx from before the gate's FLOOR: FAIL", async () => {
  const r = await check({ fresh: FRESH, fetchFn: replay(ANSWERS) });
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines[0], /^BAD the fresh tx as near-testnet reads ok on 0 testnet RPC\(s\): .*old: 2026-10-26T03:45:41\.218Z is before 2026-11-01T00:00:00\.000Z/);
});

test("the CLI with no fresh tx is an error, exit 2", () => {
  const r = spawnSync(process.execPath, [path.join(HERE, "money-gate-testnet.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /live-check money-gate-testnet: ERROR: usage: /);
});
