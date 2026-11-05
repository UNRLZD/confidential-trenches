// node --test scripts/live-checks/signpage-sent-read-back.test.mjs: the live check replays its recorded answers
// (signpage-sent-read-back.answers.json). good: this card's testnet build, the pool send's hook after the helper's
// signature `named`: PASS. live: SIGN_HOST's mainnet build, no pool send: PASS. bad: the testnet build of main a95cce2,
// that hook `sent` (the app told the helper's word before any read-back): FAIL. badM2..badM5: this card's testnet build
// with src/pool-buy.ts planted (the review fold's mutants): sent right after named, after one RPC's read, before the read
// loop, with no once flag: each FAIL. Planted on the good one: another /app.js, no pin, the hook `sent`, no hook or two
// found, facts not read, the stretch not read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./signpage-sent-read-back.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-sent-read-back.answers.json", import.meta.url), "utf8"));

test("recorded good answer: the testnet build sends pool transactions and names the helper's signature only to read it back: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded live answer: SIGN_HOST's mainnet build, its pin held, no pool send: PASS with its note", () => {
  const v = judge(ANSWERS.live);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, ["NOTE the bundle sends no pool transaction (no pinned pool on this build)"]);
});

test("recorded bad answer: main a95cce2's testnet build tells sent with the helper's signature before any read-back: FAIL, that fact named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ["BAD the bundle calls sent with the helper's signature before any read-back: the app is told a transaction the chain has not read as its own"]);
});

const NOT_BEHIND = "BAD the bundle's sent is not behind its once-only flag and both RPCs' read of this very transaction: the app may be told a transaction the chain has not read as its own";
const MUTANTS = [
  ["badM2", "sent right after named", "BAD the bundle calls sent 2 times after named: once, behind both RPCs' read-back, is the rule"],
  ["badM3", "sent after one RPC's read", NOT_BEHIND],
  ["badM4", "sent before the read loop", NOT_BEHIND],
  ["badM5", "sent with no once flag, every round", NOT_BEHIND],
];
for (const [k, name, line] of MUTANTS) {
  test(`recorded bad answer ${k}: this card's testnet build planted with ${name}: FAIL, that fact named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [line]);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, sha384: "sha384-other" }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
  assert.equal(judge({ ...g, hooks: ["sent"] }).ok, false, "the hook sent");
  assert.equal(judge({ ...g, hooks: [] }).ok, false, "no hook found");
  assert.equal(judge({ ...g, hooks: ["named", "named"] }).ok, false, "two found");
  for (const k of ["poolSend", "hooks", "stretch"]) assert.equal(judge({ ...g, [k]: undefined }).ok, false, `${k} not read`);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  const js = "fetch(`/v1/pool/solana/send`);if(L.decode(S).length!==64)return b([]);await e.named?.(S);";
  assert.deepEqual([facts("", js).poolSend, facts("", js).hooks], [true, ["named"]]);
  assert.equal(facts("", `${js}let w=[!1,!1];w[t]||=e.mine===!0;!T&&w[0]&&w[1]&&(T=!0,await e.sent?.(S))}function x(){e.sent?.(S)}`).stretch, ".length!==64)return b([]);await e.named?.(S);let w=[!1,!1];w[t]||=e.mine===!0;!T&&w[0]&&w[1]&&(T=!0,await e.sent?.(S))}", "to the function's end, no further");
  assert.equal(facts("", js.replace("named", "sent")).stretch, null);
  assert.deepEqual(facts("", js.replace("named", "sent")).hooks, ["sent"]);
  assert.deepEqual(facts("", js.replace("await e.named?.(S);", "")).hooks, []);
  assert.equal(facts("", js.replace("fetch(`/v1/pool/solana/send`);", "")).poolSend, false);
});
