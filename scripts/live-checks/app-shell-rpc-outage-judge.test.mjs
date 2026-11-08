// node --test scripts/live-checks/app-shell-rpc-outage-judge.test.mjs: the live check's verdict replays recorded runs
// (app-shell-rpc-outage-judge.answers.json, whose notes say how each was made). Both are real runs of the terminal's
// build in the harness, the hosts' real names answered from local files (app-shell-rpc-outage-judge.mjs --harness
// --record), at 390 and 1440:
//   good: Solana's first RPC answering every request 503 (--outage solana): the Solana row goes amber and the page
//         logs the failed loads: PASS, the outage shown Unverified;
//   bad:  both NEAR RPCs answering the footer's block reads 503 and Verify's reads answered (--outage footer-pair): the
//         footer shows Offline while its reads log a failed load of each release RPC: FAIL, a double outage, which fails
//         closed.
// The other bad answers are the good one with one fact changed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge } from "./app-shell-rpc-outage-judge.mjs";
import { VERIFY_RELEASES } from "../../apps/terminal/src/screens/verify/release.ts";

const A = JSON.parse(readFileSync(new URL("./app-shell-rpc-outage-judge.answers.json", import.meta.url), "utf8"));
const bad = (r) => judge(r).lines.filter((l) => l.startsWith("BAD"));
const SOLANA = new URL(VERIFY_RELEASES.mainnet.pools.solana.rpcs[0]).origin;
const mutate = (f) => {
  const r = structuredClone(A.good);
  f(r);
  return r;
};

test("recorded good answer: Solana's first RPC answers 503, its row is amber, the other rows are ok: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const w of ["phone", "desktop"]) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${w} /verify: panel drawn (code ok, funds ok, solana warn, base ok, robinhood ok), RPC down and shown: ${SOLANA.replace("https://", "")}`)), `${w}: ${r.lines.join("\n")}`);
  // the failed loads are in the record: the run really made the outage, the judge did not skip it
  for (const l of A.good.loads) assert.ok(l.consoleErrors.some((e) => e.startsWith("Failed to load resource: ") && e.endsWith(`(${SOLANA}/)`)), l.width);
});

test("recorded bad answer: both NEAR RPCs fail the footer's reads, the footer shows Offline: FAIL on the desktop load", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  assert.equal(bad(A.bad).length, 1, r.lines.join("\n"));
  assert.match(bad(A.bad)[0], /^BAD desktop \/verify: a release RPC failed to load and the page does not show it: Failed to load resource: .* \[footer read\] \[https:\/\/\S+ is a release RPC, a footer read, and both RPCs of the pair failed it\]/);
  assert.equal(A.bad.loads[1].footer.conn, "off");
});

test("planted on the good answer: a row shown ok or loading beside a failed load of its RPC, a panel with no evidence: FAIL", () => {
  assert.deepEqual(bad(mutate((r) => (r.loads[0].verify.pools.solana = "ok"))).length, 1);
  assert.match(bad(mutate((r) => (r.loads[0].verify.pools.solana = "ok")))[0], /^BAD phone \/verify: .*solana ok\]$/);
  assert.match(bad(mutate((r) => (r.loads[1].verify.pools.solana = "loading")))[0], /^BAD desktop \/verify: the panel's reads did not end or a row is not drawn \(solana loading\); .*solana loading\]$/);
  assert.match(bad(mutate((r) => (r.loads[0].verify = null)))[0], /^BAD phone \/verify: no Verify panel in the DOM; .*solana not drawn\]$/);
  assert.match(bad(mutate((r) => delete r.loads[1].verify.code))[0], /code not drawn/);
});

test("planted on the good answer: not inside SIGN_HOST's shell, a load missing, no network named: FAIL", () => {
  assert.match(bad(mutate((r) => (r.loads[0].framed = false)))[0], /^BAD phone \/verify: not inside SIGN_HOST's shell/);
  assert.ok(bad(mutate((r) => r.loads.pop())).includes("BAD 1 load(s) of /verify of 2 (both widths)"));
  // a record naming a network the release has none of names no RPC, so nothing is let through
  assert.ok(bad(mutate((r) => (r.network = "nowhere"))).some((l) => /^BAD the release names 0 RPC origin/.test(l)));
});

test("a failed load of an origin the release does not name is app-shell's to judge, not this check's", () => {
  const r = judge(mutate((rec) => rec.loads[0].consoleErrors.push("Failed to load resource: net::ERR_FAILED (https://rpc.example.org/)")));
  assert.equal(r.ok, true, r.lines.join("\n"));
});
