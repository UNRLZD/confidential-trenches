// node --test scripts/live-checks/helper-loop-never-held-by-a-read.test.mjs: the live check's verdict replays recorded
// runs (helper-loop-never-held-by-a-read.answers.json):
//   good: a copy of the helper at this card's branch (095b59584) on mainnet's public providers, read by
//         helper-loop-never-held-by-a-read.mjs --record from the Mac, 20 Nov 02:58Z: 200, the app's Origin echoed, Server-Timing
//         and Retry-After exposed: PASS;
//   bad:  the deployed helper (f5639e5bb) read by the same --record, 20 Nov 02:42Z: Retry-After exposed, Server-Timing
//         not, so a page reads every 503 as bare: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP, judge, read } from "./helper-loop-never-held-by-a-read.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-loop-never-held-by-a-read.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const OK = { base: "https://helper.invalid", status: 200, origin: APP, expose: "X-Helper-Commit, X-Helper-Source, X-Fetched-At, Retry-After, Server-Timing", commit: "0".repeat(40) };

test("the recorded good answer passes: Server-Timing and Retry-After exposed to the app's Origin", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer (the deployed helper before this card) fails: Server-Timing not exposed", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.deepEqual(bad(r), ['BAD Access-Control-Expose-Headers "X-Helper-Commit, X-Helper-Source, X-Fetched-At, Retry-After" names Server-Timing']);
});

test("planted: a non-200, another Origin, no expose header, and each exposed header missing fail, named; case and spacing do not matter", () => {
  assert.equal(judge(OK).ok, true);
  assert.equal(judge({ ...OK, expose: "server-timing,retry-after" }).ok, true, "header names are case-insensitive");
  assert.ok(bad(judge({ ...OK, status: 503 })).some((l) => /answers 503/.test(l)));
  assert.ok(bad(judge({ ...OK, origin: "*" })).some((l) => /Allow-Origin "\*"/.test(l)));
  assert.equal(bad(judge({ ...OK, expose: null })).length, 2);
  assert.ok(bad(judge({ ...OK, expose: "Retry-After" })).some((l) => /names Server-Timing/.test(l)));
  assert.ok(bad(judge({ ...OK, expose: "Server-Timing" })).some((l) => /names Retry-After/.test(l)));
  assert.equal(judge(null).ok, false);
});

test("read: one GET of the lists with the app's Origin, its status and CORS headers kept", async () => {
  const asked = [];
  const fetchFn = async (url, init) => {
    asked.push([url, init.headers.origin]);
    return new Response("{}", { status: 200, headers: { "access-control-allow-origin": APP, "access-control-expose-headers": OK.expose, "x-helper-commit": OK.commit } });
  };
  const run = await read("https://helper.invalid/", fetchFn);
  assert.deepEqual(asked, [["https://helper.invalid/v1/market/lists?chain=solana", APP]]);
  assert.deepEqual(run, { ...OK, base: "https://helper.invalid/" });
});
