// node --test scripts/live-checks/balances-per-chain.test.mjs: the live check's verdict on recorded runs
// (balances-per-chain.answers.json), each read by balances-per-chain.mjs collect() in headless Chromium: the terminal on
// APP_HOST's real name inside the stand-in shell that answers `state` with three pools.
//   good:     card screens-never-say-proof's terminal build, recorded 13 Nov (--harness): every pool a row at both widths,
//             in its own asset, one Balance column header and no Ready or Pending anywhere in the block, though the
//             answer sends a ready for one pool: PASS;
//   main:     main's build 4c1826a75 before that card (--harness --build), which still draws Ready and Pending columns
//             and a data-ready and data-pending mark on each row: FAIL (13 Nov 07:53Z: removed, the app names no proof);
//   deployed: APP_HOST as served on 3 Nov before this card and app-portfolio-mount deploy: /portfolio draws no pool
//             block: FAIL;
//   planted from good: a pool row missing, a Ready or Pending header or text back, a data-ready mark on a row, a SOL
//             balance drawn as dollars ("$12.50"), and the wrong asset: each FAIL.
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
import { consoleLine } from "./console-errors.mjs";
import { footerUrl } from "../../apps/terminal/src/shell/footer.ts";
import { VERIFY_RELEASES } from "../../apps/terminal/src/screens/verify/release.ts";

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

test("main's build before the card: Ready and Pending columns and marks on each row: FAIL", () => {
  const r = judge(ANSWERS.main);
  assert.equal(r.ok, false);
  for (const w of ["phone", "desktop"]) {
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w} /portfolio: the column headers are ["Balance","Ready","Pending"], want one, Balance`)), r.lines.join("\n"));
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w} /portfolio: the block says "Ready"`)), r.lines.join("\n"));
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w} /portfolio: solana row marks ["data-ready","data-pending"]`)), r.lines.join("\n"));
  }
  // what main got right stays right: the rows, their assets and balances
  assert.ok(!bad(r).some((l) => /balance \d+ base units|drawn \[/.test(l)), bad(r).join("\n"));
});

test("good: one Balance header, no text of Ready or Pending, no mark on a row, and the answer still sends a ready", () => {
  for (const x of ANSWERS.good.runs) {
    assert.deepEqual(x.headers, ["Balance"], x.width);
    assert.doesNotMatch(x.blockText, /ready|pending/i, x.width);
    assert.ok(x.rows.every((y) => y.marks.length === 0), x.width);
  }
  assert.ok(ANSWERS.good.answer.pools.some((p) => p.ready !== undefined));
});

test("planted: a Ready or Pending header, text of either, or a data-ready mark on a row: FAIL", () => {
  const head = mut((rec) => void (rec.runs[0].headers = ["Balance", "Ready", "Pending"]));
  assert.ok(bad(head).some((l) => /the column headers are \["Balance","Ready","Pending"\]/.test(l)), bad(head).join("\n"));
  assert.equal(mut((rec) => void (rec.runs[1].headers = [])).ok, false);
  assert.equal(mut((rec) => void delete rec.runs[1].headers).ok, false);
  const text = mut((rec) => void (rec.runs[1].blockText += " Pending —"));
  assert.ok(bad(text).some((l) => /the block says "Pending"/.test(l)), bad(text).join("\n"));
  assert.equal(mut((rec) => void delete rec.runs[0].blockText).ok, false);
  const mark = mut((rec) => void (rec.runs[0].rows.find((x) => x.chain === "solana").marks = ["data-ready"]));
  assert.ok(bad(mark).some((l) => /solana row marks \["data-ready"\]/.test(l)), bad(mark).join("\n"));
  assert.equal(mut((rec) => void delete rec.runs[0].rows.find((x) => x.chain === "solana").marks).ok, false);
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

test("planted on the good answer: /portfolio's failed footer read of a release NEAR RPC passes only beside a desktop footer showing the pair answered, any other failed load of a release RPC fails (card app-shell-rpc-outage-judge)", () => {
  const near = new URL(VERIFY_RELEASES.mainnet.rpcs[0]).origin;
  const cors = (url) => consoleLine(`Access to fetch at '${url}' from origin '${APP_HOST}' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: It does not have HTTP ok status.`, `${APP_HOST}/`);
  const tagged = cors(footerUrl(VERIFY_RELEASES.mainnet.rpcs[0]));
  assert.ok(tagged.endsWith(" [footer read]"));
  const on = { conn: "on", block: "223500000", ms: 5000 };
  const plant = (errors, footer, width = "desktop") => {
    return bad(mut((rec) => {
      const x = rec.runs.find((r) => r.width === width);
      x.errors.push(...errors);
      x.footer = footer;
    }));
  };
  assert.deepEqual(plant([tagged], on), []);
  assert.match(plant([tagged], { ...on, conn: "off" }).join("\n"), /a footer read, and the footer shows off/);
  assert.match(plant([tagged], null).join("\n"), /a footer read, and /);
  assert.match(plant([tagged], { conn: "wait", block: "", ms: 5000 }, "phone").join("\n"), /a footer read, and the footer shows wait/);
  assert.match(plant([cors(`${near}/`)], on).join("\n"), /is a release RPC, not shown Unverified: code not drawn/);
  assert.match(plant([tagged, "Uncaught boom"], on).join("\n"), /Uncaught boom/);
});
