// Replays card signpage-throttled-provider-has-a-spare's live check on its recorded answers. Good: SIGN_HOST and both
// public seats read from the build Mac (the answers file's `good.at`): the pinned /app.js names both, each seat allows
// the page's origin, and both answer the ten stable accounts with the same bytes. Bad: that run with the spare drifted
// (another hash) and with the spare refusing the page (403, as api.mainnet-beta answers one), both planted; each fails.
//   node --test scripts/live-checks/signpage-throttled-provider-has-a-spare.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check, PROBE, SEATS, STABLE } from "./signpage-throttled-provider-has-a-spare.mjs";

const A = JSON.parse(readFileSync(new URL("./signpage-throttled-provider-has-a-spare.answers.json", import.meta.url), "utf8"));
const SRC = readFileSync(new URL("../../packages/signpage/src/trade.ts", import.meta.url), "utf8");

test("the seats are the page's: provider A first, its spare after it, as src/trade.ts names them", () => {
  assert.match(SRC, new RegExp(`export const SOLANA_PROVIDER_A = "${SEATS[0]}";`));
  assert.match(SRC, new RegExp(`export const SOLANA_PUBLIC_SEAT: readonly string\\[\\] = Object\\.freeze\\(\\[SOLANA_PROVIDER_A, "${SEATS[1]}"\\]\\);`));
  assert.equal(STABLE.length, 10, "publicnode's cap for one getMultipleAccounts");
  assert.match(PROBE.pocket, /40 getAccountInfo in 10 s, 40 answered/);
});

test("the good answer passes: both seats named, each allowing the page, the same bytes", () => {
  const v = check(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("the bad answers fail: a spare that drifts, and a spare that refuses the page", () => {
  const drift = check(A.bad);
  assert.equal(drift.ok, false);
  assert.ok(drift.lines.some((l) => /^BAD the seats answer different bytes/.test(l)), drift.lines.join("\n"));
  const refused = check(A.bad2);
  assert.equal(refused.ok, false);
  assert.ok(refused.lines.some((l) => /^BAD https:\/\/solana\.api\.pocket\.network preflight/.test(l)), refused.lines.join("\n"));
});
