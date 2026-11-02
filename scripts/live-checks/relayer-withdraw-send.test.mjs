// node --test scripts/live-checks/relayer-withdraw-send.test.mjs: the live check replays recorded runs
// (relayer-withdraw-send.answers.json). good: apps/helper at this card's commit with the testnet network carried, its
// real proof for another vault refused bad_proof at check 2: PASS; good_uncarried: no network carried, bad_shape:
// PASS. bad_unmounted: main before this card, /v1/withdraw not served (404): FAIL. Made from the good run: a send
// (200 with a tx_hash), a 5xx, a missing commit, another origin, a refusal the ask does not call for: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { asks, judge } from "./relayer-withdraw-send.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "relayer-withdraw-send.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (run, name, f) => ({ ...run, reads: run.reads.map((x) => (x.asked === name ? f(x) : x)) });
const TESTNET = "a real proof for another vault, the testnet token";

test("recorded good runs: the testnet network carried (bad_proof at check 2) and none carried (bad_shape): PASS", () => {
  const g = judge(A.good);
  assert.equal(g.ok, true, g.lines.join("\n"));
  assert.ok(g.lines.includes(`ok  ${TESTNET}: 400 bad_proof (want 400 bad_proof or 400 bad_shape)`), g.lines.join("\n"));
  const u = judge(A.good_uncarried);
  assert.equal(u.ok, true, u.lines.join("\n"));
  assert.equal(A.good.reads.length, asks().length);
});

test("recorded bad run: main before this card, the route not served: FAIL", () => {
  const r = judge(A.bad_unmounted);
  assert.equal(r.ok, false);
  assert.ok(bad(r).includes('BAD GET: 404 {"error":"not_found"} (want 405 method_not_allowed)'), bad(r).join("\n"));
  assert.equal(bad(r).filter((l) => / 404 /.test(l)).length, asks().length);
});

test("made from the good run: a send, a 5xx, no commit, another origin, an unasked refusal, a missing read: each FAIL", () => {
  const g = A.good;
  const sent = edit(g, TESTNET, (x) => ({ ...x, status: 200, body: JSON.stringify({ tx_hash: "4YsDRNYepeb4u16677E9WYB5DSF69EwnUuG6XLAV7eBL", state: "submitted" }) }));
  assert.equal(judge(sent).ok, false);
  assert.equal(judge(edit(g, TESTNET, (x) => ({ ...x, status: 503, body: JSON.stringify({ error: { code: "upstream" } }) }))).ok, false);
  assert.equal(judge(edit(g, "not JSON", (x) => ({ ...x, headers: { ...x.headers, "x-helper-commit": "main" } }))).ok, false);
  assert.equal(judge(edit(g, "not JSON", (x) => ({ ...x, headers: { ...x.headers, "access-control-allow-origin": "*" } }))).ok, false);
  assert.equal(judge(edit(g, "over 8 KB", (x) => ({ ...x, status: 400, body: JSON.stringify({ error: { code: "bad_shape" } }) }))).ok, false);
  assert.equal(judge(edit(g, "GET", (x) => ({ ...x, headers: { ...x.headers, allow: "GET, POST" } }))).ok, false);
  assert.equal(judge({ ...g, reads: g.reads.filter((x) => x.asked !== TESTNET) }).ok, false);
});

test("every ask the check sends is refused before a chain read or at check 2: none can be carried", () => {
  const fixture = JSON.parse(readFileSync(path.join(HERE, "../../apps/helper/src/withdraw/fixtures/withdraw-request.json"), "utf8"));
  // the proof was made for another vault: its context binds that vault, never the release's
  assert.notEqual(fixture.vault, "vault.bf-vt-20261102t071444.testnet");
  for (const a of asks()) for (const [s] of a.want) assert.ok(s >= 400 && s < 500, a.name);
});
