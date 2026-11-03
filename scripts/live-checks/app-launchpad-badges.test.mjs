// node --test scripts/live-checks/app-launchpad-badges.test.mjs: the live check's verdict replays recorded runs
// (app-launchpad-badges.answers.json), each read by app-launchpad-badges.mjs collect() in headless Chromium 153:
//   good:     2026-11-03 12:50Z, this card's build answering for APP_HOST (Playwright routed APP_HOST's address to the
//             build's files under its own _headers; a stand-in page at SIGN_HOST framed it at the same path, as the
//             shell does), the lists read live from HELPER_HOST: 254 rows at each width, 149 with a launchpad badge,
//             every row its chain mark: PASS;
//   liveMain: 2026-11-03 12:45Z, APP_HOST as deployed from main before this card: every row draws no badge and the
//             desktop rows draw the raw id ("pump.fun") as text: FAIL.
// Planted on the good answer: a missing badge, a wrong pad, a wrong hover, a logo that did not load, a badge on a
// row served null, a served id with no table row, a raw id, a missing chain mark, a clipped badge: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, rowFaults, WIDTHS } from "./app-launchpad-badges.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-launchpad-badges.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
/** The good answer with `f` applied to the first desktop row whose served launchpad satisfies `pick`. */
const mut = (pick, f) => {
  const rec = structuredClone(ANSWERS.good);
  const row = rec.loads[1].rows.find((r) => pick(r.served.launchpad));
  f(row);
  return { ...judge(rec), faults: rowFaults(row) };
};
const padded = (id) => id === "pump.fun";

test("recorded good answer: every row's launchpad and chain drawn as logo badges with their names, no raw id, nothing clipped: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const w of WIDTHS) assert.ok(r.lines.some((l) => new RegExp(`^ok  ${w.name} /discover: \\d+ rows, \\d+ with a launchpad badge \\([^)]*pump\\.fun[^)]*\\), every row its chain mark, no raw id, nothing clipped$`).test(l)), w.name);
  for (const l of ANSWERS.good.loads) {
    assert.ok(l.rows.length > 100);
    assert.ok(l.rows.some((x) => x.served.launchpad === null && x.pad === null && x.chain?.id === "solana"), "a row served null draws only the chain mark");
    assert.ok(l.rows.some((x) => x.pad?.id === "pump.fun" && x.pad.title === "pump.fun" && x.pad.loaded));
  }
});

test("recorded bad answer: APP_HOST as deployed from main draws no badge and the raw id as text: FAIL", () => {
  const r = judge(ANSWERS.liveMain);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /^BAD phone \/discover: \d+ of \d+ rows wrong, first new\/\w+: (no [^;]+ badge; )?no chain badge/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r.lines).some((l) => /^BAD desktop \/discover: .*no pump\.fun badge; no chain badge; raw id "pump\.fun" drawn as text/.test(l)), r.lines.join("\n"));
});

test("planted on the good answer: each way a badge can be wrong: FAIL", () => {
  const cases = [
    [padded, (x) => (x.pad = null), /no pump\.fun badge/],
    [padded, (x) => (x.pad.id = "met-dbc"), /launchpad badge says "met-dbc", served "pump\.fun"/],
    [padded, (x) => (x.pad.title = "pump.fun launchpad"), /launchpad hover "pump\.fun launchpad", not "pump\.fun"/],
    [padded, (x) => (x.pad.loaded = false), /pump\.fun logo did not load/],
    [(id) => id === null, (x) => (x.pad = { id: "pump.fun", title: "pump.fun", loaded: true }), /a launchpad badge \("pump\.fun"\) where none was served/],
    [padded, (x) => ((x.served.launchpad = "moonshot"), (x.pad = null)), /launchpad "moonshot" has no row in the table/],
    [padded, (x) => x.texts.push("pump.fun"), /raw id "pump\.fun" drawn as text/],
    [padded, (x) => (x.chain = null), /no chain badge/],
    [padded, (x) => (x.chain.id = "base"), /chain badge says "base", served "solana"/],
    [padded, (x) => (x.chain.loaded = false), /chain mark did not load/],
    [padded, (x) => x.clipped.push("launchpad badge cut by its box"), /clipped: launchpad badge cut by its box/],
    [padded, (x) => (x.served = null), /not in the lists answer the page read/],
  ];
  for (const [pick, f, want] of cases) {
    const r = mut(pick, f);
    assert.equal(r.ok, false, String(want));
    assert.ok(r.faults.some((m) => want.test(m)), `${want}: ${r.faults.join("; ")}`);
    assert.ok(bad(r.lines).some((l) => /^BAD desktop \/discover: 1 of \d+ rows wrong/.test(l)), r.lines.join("\n"));
  }
});

test("a run that never drew Discover, or read no lists, or lost a width: FAIL", () => {
  let rec = structuredClone(ANSWERS.good);
  rec.loads[0].state = null;
  assert.ok(bad(judge(rec).lines).some((l) => /phone \/discover: Discover not drawn/.test(l)));
  rec = structuredClone(ANSWERS.good);
  rec.loads[1].lists = null;
  assert.ok(bad(judge(rec).lines).some((l) => /desktop \/discover: Discover ready, lists not read/.test(l)));
  rec = structuredClone(ANSWERS.good);
  rec.loads[1].rows = [];
  assert.ok(bad(judge(rec).lines).some((l) => /desktop \/discover: no rows drawn/.test(l)));
  rec = structuredClone(ANSWERS.good);
  rec.loads.pop();
  assert.ok(bad(judge(rec).lines).some((l) => /1 loads of 2/.test(l)));
});
