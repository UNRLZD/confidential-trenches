// node --test scripts/live-checks/solana-legs-share-wait.test.mjs: the live check replays recorded runs
// (solana-legs-share-wait.answers.json), each a real read of HELPER_HOST and two public Solana RPCs, through the kit's
// own cap search and the trade's room wait (card solana-legs-share-wait).
// - good (2026-11-05 07:47Z): 6 legs at once, every leg 200 at 40, 801 bytes: PASS.
// - bad_deployed_503 (07:48Z, the deployed helper before this card's change): 16 legs at once, 8 answered 503 upstream
//   with no Retry-After, so each ends on it: FAIL, one line per such leg.
// Made from good, each one leg changed: a 429 with a Retry-After that is the leg's last answer (the leg ends on the
// 429: FAIL); a 429 with no Retry-After (FAIL); a 429 with a Retry-After of 2 s and the leg's 200 asked 2.1 s later
// (waited out: PASS); the same 200 asked 0.5 s later (before the wait passed: FAIL); a leg dropped, 5 legs (FAIL).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./solana-legs-share-wait.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "solana-legs-share-wait.answers.json"), "utf8"));
const copy = (x) => JSON.parse(JSON.stringify(x));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const RATE = '{"error":{"code":"rate_limited"}}';
/** good, with its last leg's calls replaced: `calls(first)` gets that leg's recorded 200. */
function planted(calls, known = [null]) {
  const r = copy(A.good);
  const leg = r.legs.at(-1);
  leg.calls = calls(leg.calls[0]);
  leg.known = known;
  return r;
}

test("recorded good run: 6 legs at once all build and assemble within 1,232 bytes, none meets a 429 or 503: PASS", async () => {
  const r = await judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines.at(-1), /^ok {2}the legs' builds: 6 Jupiter calls, 0 waited out, wall time \d+\.\d s \(bound 600 s\)$/);
});

test("recorded bad run on the helper before the card: 8 of 16 legs end on a 503 with no Retry-After: FAIL", async () => {
  const r = await judge(A.bad_deployed_503);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, 8, r.lines.join("\n"));
  for (const l of b) assert.match(l, /^BAD leg \d+: build upstream: upstream: HTTP 503 \(last answer HTTP 503\)$/);
});

test("planted: a 429 with its Retry-After as a leg's last answer, so the leg ends on it: FAIL", async () => {
  const r = await judge(planted((c) => [{ url: c.url, status: 429, body: RATE, ms: 5, sentAt: c.sentAt, retryAfter: "2" }]));
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, 1, r.lines.join("\n"));
  // the kit waited the 2 s and asked again; the record holds no answer to that ask (the kit's message is cut at 120
  // characters), so the leg ended on the 429
  assert.match(b[0], /^BAD leg 6: build upstream: upstream: the helper did not answer: the kit asked https:\/\/\S+ \(last answer HTTP 429, Retry-After 2\)$/);
});

test("planted: a 429 with no Retry-After reaches the leg: FAIL", async () => {
  const r = await judge(planted((c) => [{ url: c.url, status: 429, body: RATE, ms: 5, sentAt: c.sentAt }], []));
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ["BAD leg 6: build upstream: upstream: HTTP 429 (last answer HTTP 429)"]);
});

test("planted: a 429 with a Retry-After of 2 s, waited out, then the leg's 200: PASS, one wait counted", async () => {
  const r = await judge(planted((c) => [{ url: c.url, status: 429, body: RATE, ms: 5, sentAt: c.sentAt, retryAfter: "2" }, { ...c, sentAt: c.sentAt + 2_100 }]));
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines.find((l) => l.includes("leg 6:")), /^ok {2}leg 6: answers 429\(2 s\) 200; caps 40 fits; \d+ bytes; /);
  assert.match(r.lines.at(-1), /7 Jupiter calls, 1 waited out/);
});

test("planted: the leg's next call asked 0.5 s after a 429 that named 2 s: FAIL", async () => {
  const r = await judge(planted((c) => [{ url: c.url, status: 429, body: RATE, ms: 5, sentAt: c.sentAt, retryAfter: "2" }, { ...c, sentAt: c.sentAt + 500 }]));
  assert.equal(r.ok, false);
  assert.match(bad(r).join("\n"), /^BAD leg 6: answers 429\(2 s\) 200; caps 40 fits; \d+ bytes; 1 call\(s\) asked before the Retry-After passed; /);
});

test("planted: 5 legs, fewer than the check's 6: FAIL", async () => {
  const r = copy(A.good);
  r.legs.pop();
  const v = await judge(r);
  assert.equal(v.ok, false);
  assert.deepEqual(bad(v), ["BAD 5 legs, 5 takers (6 to 64 legs, a taker each)"]);
});
