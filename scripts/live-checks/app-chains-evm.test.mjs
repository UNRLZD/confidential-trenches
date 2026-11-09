// node --test scripts/live-checks/app-chains-evm.test.mjs: the live check's verdict replays recorded runs
// (app-chains-evm.answers.json), each read on 9 Nov by app-chains-evm.mjs collect() with --build, the terminal's build
// served at APP_HOST's name inside the stand-in shell, HELPER_HOST live, headless Chrome 157:
//   good: the build of card/app-chains-evm: Discover reads and draws Base's and Robinhood's lists beside Solana's at
//         both widths, and a live Base and Robinhood token each open their page: PASS;
//   bad:  the build of main 182241d7 (Discover reads Solana's lists alone): FAIL on Discover's Base and Robinhood lines;
//         its token pages pass, as main already drew /token/base and /token/robinhood.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./app-chains-evm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-chains-evm.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));

test("recorded good answer: Base and Robinhood read and drawn on Discover at both widths, and each opens its token page: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const c of ["base", "robinhood"]) {
    assert.ok(r.lines.includes(`ok  ${c}: 2 Discover load(s) of 2 and 1 token page load(s) of 1 judged`), r.lines.join("\n"));
    assert.ok(r.lines.some((l) => new RegExp(`^ok  app-discover-live: desktop /discover \\(framed\\): ${c}: the lists read at HELPER_HOST 200, \\d+ rows each with exactly the 38 fields; [1-9]\\d* ${c} row`).test(l)), c);
    assert.ok(r.lines.some((l) => new RegExp(`^ok  app-token-route: desktop /token/${c}/<live token>: ready, data-token 0x[0-9a-f]{40} `).test(l)), c);
  }
});

test("recorded bad answer: main's build reads no Base or Robinhood list and draws none of their rows: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  for (const w of ["phone", "desktop"])
    for (const c of ["base", "robinhood"]) assert.ok(b.includes(`BAD app-discover-live: ${w} /discover (framed): ${c}: the page read no ${c} lists answer; Discover draws no ${c} row`), r.lines.join("\n"));
  assert.ok(!b.some((l) => l.includes("app-token-route")), r.lines.join("\n"));
});

test("a run with a part missing, or whose part judged no Base or Robinhood load, fails", () => {
  const r = judge({ discover: ANSWERS.good.discover });
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).includes("BAD base: 2 Discover load(s) of 2 and 0 token page load(s) of 1 judged"), r.lines.join("\n"));
  const rec = structuredClone(ANSWERS.good);
  rec.discover.loads.pop();
  assert.equal(judge(rec).ok, false);
});
