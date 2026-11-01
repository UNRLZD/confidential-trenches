// node --test scripts/live-checks/helper-host-health.test.mjs: the live check replays recorded answers
// (helper-host-health.answers.json). good: apps/helper at 6aa24c5 in its image behind deploy/Caddyfile, run by
// deploy/compose.yaml on a Mac (HELPER_HOST has no server yet, so no served answer exists): PASS. bad_commit: a real
// answer from the same image built with another commit (854f02d): FAIL. bad_star: the good answer with
// Access-Control-Allow-Origin: * on every read: FAIL.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read } from "./helper-host-health.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-host-health.answers.json"), "utf8"));
const COMMIT = A.good.commit;

// a fetch that answers each read with the recorded answer for the request's Origin
const replay = (a) => async (_url, init) => {
  const r = a.reads.find((x) => x.origin === init.headers.origin);
  return new Response(r.body, { status: r.status, headers: r.headers });
};

test("recorded good answer: 200, the six parts, the commit, the two origins echoed, example.com none: PASS", async () => {
  const r = judge(await read("https://api.confidential.unrealized.trade", replay(A.good)), COMMIT);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes('ok  [https://confidential.unrealized.trade] Access-Control-Allow-Origin: "https://confidential.unrealized.trade"'));
  assert.ok(r.lines.includes("ok  [https://example.com] Access-Control-Allow-Origin: none"));
});

test("recorded bad answer: X-Helper-Commit is not main's: FAIL", async () => {
  const r = judge(await read(undefined, replay(A.bad_commit)), COMMIT);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes(`BAD [https://sign.confidential.unrealized.trade] X-Helper-Commit: "${A.bad_commit.reads[0].headers["x-helper-commit"]}", want "${COMMIT}"`), r.lines.join("\n"));
  assert.ok(r.lines.includes("BAD [https://confidential.unrealized.trade] body commit equals it"));
});

test("recorded bad answer: Access-Control-Allow-Origin: *: FAIL", async () => {
  const r = judge(await read(undefined, replay(A.bad_star)), COMMIT);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes('BAD [https://example.com] Access-Control-Allow-Origin: "*", want none'), r.lines.join("\n"));
  assert.ok(r.lines.includes("BAD [https://confidential.unrealized.trade] no * in Access-Control-Allow-Origin"));
});

test("bad answers made from the good one: a part missing, a part added, no Vary, credentials allowed, a 503: FAIL", () => {
  const edit = (fn) => ({ reads: A.good.reads.map((r) => fn(structuredClone(r))) });
  const body = (f) => (r) => ((r.body = JSON.stringify(f(JSON.parse(r.body)))), r);
  const cases = {
    "parts are exactly": edit(body((b) => (delete b.parts.log, b))),
    "parts are exactly ": edit(body((b) => ((b.parts.extra = "down"), b))),
    "each part is": edit(body((b) => ((b.parts.proxy = "maybe"), b))),
    "Vary: none": edit((r) => (delete r.headers.vary, r)),
    "no Access-Control-Allow-Credentials": edit((r) => ((r.headers["access-control-allow-credentials"] = "true"), r)),
    "answers 503": edit((r) => ((r.status = 503), r)),
  };
  for (const [want, answer] of Object.entries(cases)) {
    const r = judge(answer, COMMIT);
    assert.equal(r.ok, false, want);
    assert.ok(r.lines.some((l) => l.startsWith("BAD") && l.includes(want.trim())), `${want}\n${r.lines.join("\n")}`);
  }
  assert.equal(judge(A.good, "main").ok, false, "an expected commit that is not a full sha fails");
});

test("the CLI on a host that does not answer is an error, exit 2", () => {
  const r = spawnSync(process.execPath, [path.join(HERE, "helper-host-health.mjs"), "--base", "http://127.0.0.1:9", "--commit", COMMIT], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /live-check helper-host-health: ERROR: /);
});
