// node --test scripts/live-checks/balances-per-chain.test.mjs: the live check's verdict on recorded runs
// (balances-per-chain.answers.json), each read by balances-per-chain.mjs collect() in headless Chromium: the terminal on
// APP_HOST's real name inside the stand-in shell that answers `state` with three pools.
//   good:     this card's terminal build with Portfolio mounted on /portfolio (the one route line of card
//             app-portfolio-mount; this branch does not mount it) (--harness): every pool a row at both widths, in
//             cents, the pool sent with no ready drawn with dashes: PASS;
//   deployed: APP_HOST as served on 3 Nov before this card and app-portfolio-mount deploy: /portfolio draws no pool
//             block: FAIL;
//   planted from good: a pool row missing, a false 0 in Ready where the pool sent none, a SOL balance drawn as dollars
//             ("$12.50"), and the wrong asset: each FAIL.
// Each answer's `at` is when it was recorded.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as check from "./balances-per-chain.mjs";
import { ANSWER, base, judge, POOLS } from "./balances-per-chain.mjs";
import { APP_HOST } from "./app-in-shell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "balances-per-chain.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("base units at the kit's decimals: rounded down, garbage and an unknown asset null", () => {
  assert.equal(base("12.5", "SOL"), "12500000000");
  assert.equal(base("0.25", "ETH"), "250000000000000000");
  assert.equal(base("1.0000001", "USDC"), "1000000");
  assert.equal(base("-1", "SOL"), null);
  assert.equal(base("1e3", "SOL"), null);
  assert.equal(base("1", "BTC"), null);
});

test("the recorded answers are the shell's answer as this check sends it", () => {
  assert.deepEqual(ANSWERS.good.answer, ANSWER);
  assert.deepEqual(ANSWER.pools, POOLS);
});

test("good: this card's build draws every pool at both widths: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.ok(r.ok, bad(r).join("\n"));
});

test("deployed before this card: no pool block: FAIL", () => {
  const r = judge(ANSWERS.deployed);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /pool block is not drawn|want rows/.test(l)), bad(r).join("\n"));
});

test("planted: a pool row missing: FAIL", () => {
  const r = mut((rec) => {
    for (const run of rec.runs) run.rows = run.rows.filter((x) => x.chain !== "base");
  });
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /no row for base/.test(l)), bad(r).join("\n"));
});

test("planted: a SOL balance drawn as dollars: FAIL", () => {
  const r = mut((rec) => {
    rec.runs.find((y) => y.width === "phone").rows.find((y) => y.chain === "solana").text[1] = "$12.50";
  });
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /solana drawn .*no dollar figure/.test(l)), bad(r).join("\n"));
});

test("planted: the wrong asset on a row: FAIL", () => {
  const r = mut((rec) => {
    rec.runs.find((y) => y.width === "desktop").rows.find((y) => y.chain === "base").asset = "SOL";
  });
  assert.equal(r.ok, false);
});

test("planted: a false 0 where the pool sent no ready: FAIL", () => {
  const r = mut((rec) => {
    const x = rec.runs.find((y) => y.width === "desktop").rows.find((y) => y.chain === "base");
    x.ready = "0";
    x.pending = "250000000000000000";
    x.text[2] = "0";
    x.text[3] = "0.25";
  });
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /base sends no ready/.test(l)), bad(r).join("\n"));
});

test("planted: a ready drawn as a dash where the pool sent one: FAIL", () => {
  const r = mut((rec) => {
    const x = rec.runs.find((y) => y.width === "phone").rows.find((y) => y.chain === "solana");
    x.ready = "none";
    x.text[2] = "—";
  });
  assert.equal(r.ok, false);
});

// a page as the check hooks it: Playwright's console and pageerror events, emitted by hand
const SHELL = "https://confidential.unrealized.trade";
const msg = (t, location, type = "error") => ({ type: () => type, text: () => t, location: () => location });
const thrown = (Name, message, at) => {
  const e = new Name(message);
  e.stack = `${e.name}: ${message}${at.map((a) => `\n    at ${a}`).join("")}`;
  return e;
};
function hooked() {
  assert.equal(typeof check.watch, "function", "the check hooks no page errors: it has no watch(page, errors) for its page");
  const page = new EventEmitter();
  const kept = [];
  check.watch(page, kept);
  return { page, kept };
}

test("planted on the good answer: a recorded 429 names its resource's origin and path in the BAD line, and the shell's own and a warning are not the terminal's (card live-console-url)", () => {
  const text = "Failed to load resource: the server responded with a status of 429 ()";
  const { page, kept } = hooked();
  page.emit("console", msg(text, { url: `${APP_HOST}/assets/index-abc.js?v=1` }));
  page.emit("console", msg("the shell's own", { url: `${SHELL}/assets/shell.js` }));
  page.emit("console", msg("a warning", { url: `${APP_HOST}/` }, "warning"));
  assert.deepEqual(kept, [`${text} (${APP_HOST}/assets/index-abc.js)`]);
  const r = mut((rec) => rec.runs[1].errors.push(kept[0]));
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.endsWith(`console ${text} (${APP_HOST}/assets/index-abc.js)`)), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => l.includes("?v=1")), "no query in a line");
});

test("planted on the good answer: an uncaught exception in the terminal's frame is kept and fails the run, named by its top frame's origin and path; the shell's own is not the terminal's (card live-pageerror-hooks)", () => {
  const { page, kept } = hooked();
  page.emit("pageerror", thrown(TypeError, "Cannot read properties of undefined (reading 'pools')", [`Ft (${APP_HOST}/assets/index-abc.js?v=1:1:2345)`, `${APP_HOST}/assets/index-abc.js:1:99`]));
  page.emit("pageerror", thrown(Error, "the shell's own", [`boot (${SHELL}/assets/shell.js:1:2)`]));
  const line = `pageerror TypeError: Cannot read properties of undefined (reading 'pools') (${APP_HOST}/assets/index-abc.js)`;
  assert.deepEqual(kept, [line]);
  const r = mut((rec) => rec.runs[0].errors.push(...kept));
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.endsWith(`console ${line}`)), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => l.includes("?v=1")), "no query in a line");
});

test("planted on the good answer: an error with no location (a console error, a page error with no stack) is kept and fails the run (card live-pageerror-hooks)", () => {
  const { page, kept } = hooked();
  page.emit("console", msg("Uncaught boom", undefined));
  page.emit("console", msg("no url", { url: "", lineNumber: 0, columnNumber: 0 }));
  page.emit("pageerror", thrown(Error, "no stack", []));
  assert.deepEqual(kept, ["Uncaught boom", "no url", "pageerror Error: no stack"]);
  const r = mut((rec) => rec.runs[1].errors.push(...kept));
  assert.equal(r.ok, false);
  for (const k of kept) assert.ok(bad(r).some((l) => l.includes(`console ${k}`)), `${k}: ${r.lines.join("\n")}`);
});
