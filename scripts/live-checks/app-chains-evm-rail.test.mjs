// node --test scripts/live-checks/app-chains-evm-rail.test.mjs: the live check's verdict replays recorded runs
// (app-chains-evm-rail.answers.json), each read on 9 Nov by app-chains-evm-rail.mjs collect() with --build, the
// terminal's build served at APP_HOST's name inside the stand-in shell, HELPER_HOST live, headless Chrome 157:
//   good: this card's build: a live Base and Robinhood token page's rail draws all three chains on All and only the
//         page's chain once the chain chip picks it, the page's own token marked: PASS;
//   bad:  the build of card/app-chains-evm at 7b5770f3 (the rail reads Solana's lists alone): Solana rows only, on All
//         and on the page's chain: FAIL.
// Planted from the good run: a rail of one chain on All, a row of another chain on the pick, the own token unmarked.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHAINS, judge } from "./app-chains-evm-rail.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-chains-evm-rail.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: each chain's page draws every chain's rail on All and its own chain's on the pick: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(ANSWERS.good.loads.map((l) => l.chain), CHAINS);
  for (const l of ANSWERS.good.loads) {
    assert.ok(Object.keys(l.all).length > 1, `${l.chain}: more than one chain on All`);
    assert.deepEqual(Object.keys(l.picked), [l.chain]);
  }
});

test("recorded bad answer: the base build's rail draws Solana rows alone on every pick: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const c of CHAINS) {
    assert.ok(bad(r.lines).some((l) => l.includes(`/token/${c}/`) && /the rail on All draws \d+ solana; want rows of more than one chain/.test(l)), r.lines.join("\n"));
    assert.ok(bad(r.lines).some((l) => l.includes(`/token/${c}/`) && new RegExp(`the rail on ${c} draws \\d+ solana; want ${c} rows only`).test(l)), r.lines.join("\n"));
  }
});

test("planted: one chain on All, another chain's row on the pick, the own token unmarked, a missing chain's load each fail", () => {
  const one = mut((rec) => {
    rec.loads[0].all = { base: 19 };
  });
  assert.ok(bad(one.lines).some((l) => /\/token\/base\/.*the rail on All draws 19 base/.test(l)), one.lines.join("\n"));
  const mixed = mut((rec) => {
    rec.loads[1].picked = { robinhood: 16, solana: 1 };
  });
  assert.ok(bad(mixed.lines).some((l) => /\/token\/robinhood\/.*the rail on robinhood draws 16 robinhood, 1 solana/.test(l)), mixed.lines.join("\n"));
  const unmarked = mut((rec) => {
    rec.loads[0].marked = false;
  });
  assert.ok(bad(unmarked.lines).some((l) => /listed but not marked/.test(l)), unmarked.lines.join("\n"));
  const missing = mut((rec) => {
    rec.loads = rec.loads.slice(0, 1);
  });
  assert.equal(missing.ok, false);
  const notReady = mut((rec) => {
    rec.loads[0].state = "error";
  });
  assert.equal(notReady.ok, false);
});
