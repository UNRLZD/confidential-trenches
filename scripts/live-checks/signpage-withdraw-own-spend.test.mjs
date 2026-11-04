// node --test scripts/live-checks/signpage-withdraw-own-spend.test.mjs: the live check replays its recorded answers
// (signpage-withdraw-own-spend.answers.json). good: this card's build, the wallet store with "owed" and a reader that
// leaves it out: PASS. bad: SIGN_HOST before the deploy, the paper's seven stores only: FAIL. Planted on the good one:
// a served /app.js that is not the pinned one, a reader that needs "owed", a store list without it: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./signpage-withdraw-own-spend.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-withdraw-own-spend.answers.json", import.meta.url), "utf8"));

test("recorded good answer: the bundle's wallet store has \"owed\" and its reader leaves it out: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST before the deploy, no \"owed\" store: FAIL, both facts named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.equal(v.lines.length, 2, v.lines.join("\n"));
});

test("planted on the good answer: another /app.js, no pin, a reader that needs \"owed\", no store list: each FAIL", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, sha384: "sha384-other" }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
  assert.equal(judge({ ...g, readerSkipsOwed: false }).ok, false);
  assert.equal(judge({ ...g, stores: null }).ok, false);
  assert.equal(judge({ ...g, stores: g.stores.replace(/,`owed`/, "") }).ok, false);
});

test("the facts read from a bundle: the store list after the seven, the reader's filter, quoted either way", () => {
  const js = 'var a=[`notes`,`wallets`,`quotes`,`orders`,`ops`,`counters`,`meta`,`owed`],b=a.filter(e=>e!==`owed`);';
  const f = facts('<script src="/app.js" integrity="x"></script>', js);
  assert.equal(f.stores, "[`notes`,`wallets`,`quotes`,`orders`,`ops`,`counters`,`meta`,`owed`]");
  assert.equal(f.readerSkipsOwed, true);
  assert.equal(facts("", js.replace(/,b=.*$/, ";")).readerSkipsOwed, false);
  assert.equal(facts("", '["notes","wallets","quotes","orders","ops","counters","meta","owed"]').stores?.includes('"owed"'), true);
});
