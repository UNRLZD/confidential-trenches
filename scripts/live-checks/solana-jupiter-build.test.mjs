// node --test scripts/live-checks/solana-jupiter-build.test.mjs: the live check replays recorded runs
// (solana-jupiter-build.answers.json), each a real read of HELPER_HOST at 7001a7e and two public Solana RPCs on
// 2026-11-02. good (05:06Z): a pump.fun token, the four shapes at 739 to 769 bytes: PASS. bad_oversize (05:05Z): a
// token whose uncapped sell route (GoonFi V2 + Kipseli + Raydium CLMM + Whirlpool) assembles to 1,244 bytes, refused
// too_large: FAIL. Made from the good run: a shape the helper answered 503, and a capped shape asked without
// maxAccounts=40: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./solana-jupiter-build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "solana-jupiter-build.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const copy = (x) => JSON.parse(JSON.stringify(x));

test("recorded good run: the four shapes build through the helper and assemble within 1,232 bytes: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const name of ["S-1 buy, maxAccounts=40", "S-1 buy, uncapped", "S-2 sell, maxAccounts=40", "S-2 sell, uncapped"]) {
    assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && / \d{3,4} bytes \(limit 1232\)/.test(l)), name);
  }
});

test("recorded oversize build: the uncapped sell assembles to 1,244 bytes and is refused: FAIL", () => {
  const r = judge(A.bad_oversize);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ["BAD S-2 sell, uncapped: refused: too_large: 1244 bytes > 1232 (route GoonFi V2 + Kipseli + Raydium CLMM + Whirlpool)"]);
});

test("made from the good run: a shape the helper answered 503 upstream: FAIL", () => {
  const g = copy(A.good);
  g.shapes[2] = { ...g.shapes[2], status: 503, body: '{"error":{"code":"upstream"}}' };
  const r = judge(g);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ['BAD S-2 sell, maxAccounts=40: HTTP 503 {"error":{"code":"upstream"}}']);
});

test("made from the good run: the capped buy asked without maxAccounts=40: FAIL", () => {
  const g = copy(A.good);
  g.shapes[0] = { ...g.shapes[0], query: g.shapes[0].query.replace("&maxAccounts=40", "") };
  const r = judge(g);
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 1);
  assert.match(bad(r)[0], /^BAD S-1 buy, maxAccounts=40: asked .* not the kit's query/);
});
