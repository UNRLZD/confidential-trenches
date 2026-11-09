// node --test scripts/live-checks/app-verify-mount.test.mjs: the release's pins against the vault deploy records as
// they are in this tree, and the live check's verdict on recorded runs (app-verify-mount.answers.json), each read by
// app-verify-mount.mjs collect() in headless Chromium on the harness: the terminal on APP_HOST's real name inside the
// stand-in shell, the release's NEAR RPCs reached live.
//   good:       this card's build for testnet (VITE_NEAR_NETWORK=testnet): Verify drawn from a live read of
//               vault.bf-vt-20261102t071444.testnet on test.rpc.fastnear.com (FastNEAR) and near-testnet.drpc.org
//               (dRPC), every check ok at both widths, each open leaving loading only once both RPCs answered it, every
//               NEAR request to the pair and of the release's accounts, and the pill's second open read afresh: PASS;
//   goodMainnet: this card's build for mainnet (VITE_NEAR_NETWORK unset), served locally on the hosts' names: Verify drawn
//               from a live read of vault.confidential.unrlzd.near on rpc.mainnet.fastnear.com (FastNEAR) and near.drpc.org
//               (dRPC) against contracts/vault/deployments/mainnet-v1.json, every check ok at both widths: PASS;
//   noVault:    the tree before the mainnet vault's deploy, built for mainnet, as APP_HOST served it then: every check
//               Unverified, no RPC named, no NEAR request: PASS against its own time (no record); FAIL once the record
//               exists (planted);
//   notMounted: the build of main before this card (Screen.tsx draws an empty main for /verify): FAIL, no panel;
//   cached:     this card's build with one change in VerifyRoute.tsx: each read kept in a module-level LAST and drawn at
//               once on the next open before it reads (`if (LAST) setView(LAST);`): FAIL, the pill's open leaves loading
//               before either RPC answered it.
// Each answer's `at` is when it was recorded. Each planted bad case is a recorded run with one thing changed.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { footerUrl } from "../../apps/terminal/src/shell/footer.ts";
import { VERIFY_RELEASES } from "../../apps/terminal/src/screens/verify/release.ts";
import { consoleLine } from "./console-errors.mjs";
import * as check from "./app-verify-mount.mjs";
import { APP_HOST, CHECKS, judge, pinsOf, pinsProblems, recorded, releaseRecord, WIDTHS } from "./app-verify-mount.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-verify-mount.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (name, f) => {
  const rec = structuredClone(ANSWERS[name]);
  f(rec);
  return judge(rec);
};
const desktop = (rec) => rec.runs.find((x) => x.width === "desktop");

test("the release's pins are each network's vault deploy record, and none exactly where no record exists", () => {
  for (const [network, r] of Object.entries(VERIFY_RELEASES)) {
    assert.deepEqual(pinsProblems(network, pinsOf(r.pins), releaseRecord(network)), [], network);
  }
  assert.equal(releaseRecord("testnet").account_id, VERIFY_RELEASES.testnet.pins.vault);
  // mainnet's record exists since the vault's deploy on 7 Nov (contracts/vault/deployments/mainnet-v1.json): its vault is named
  assert.equal(releaseRecord("mainnet").account_id, VERIFY_RELEASES.mainnet.pins.vault);
  assert.equal(releaseRecord("mainnet").code_hash, VERIFY_RELEASES.mainnet.pins.release);
});

test("a deploy record that moves, appears or goes, against the release's pins, is a problem", () => {
  const rec = releaseRecord("testnet");
  const pins = pinsOf(VERIFY_RELEASES.testnet.pins);
  assert.deepEqual(pinsProblems("testnet", pins, { ...rec, account_id: "vault.other.testnet" }), [`release.ts vault ${pins.vault}, the deploy record vault.other.testnet`]);
  assert.equal(pinsProblems("testnet", pins, { ...rec, asset: "usdc.other.testnet" }).length, 1);
  assert.equal(pinsProblems("testnet", pins, { ...rec, code_hash: "11111111111111111111111111111111" }).length, 1);
  assert.equal(pinsProblems("testnet", pins, { ...rec, network: "mainnet" }).length, 1);
  assert.match(pinsProblems("mainnet", null, { network: "mainnet", account_id: "vault.near", asset: "a", code_hash: "c" })[0], /release\.ts names none/);
  assert.match(pinsProblems("testnet", pins, null)[0], /no deploy record exists/);
});

test("recorded good answer: Verify read live on two operators, every check ok at both widths, read again on the pill's open: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.network, "testnet");
  assert.deepEqual(ANSWERS.good.pins, pinsOf(VERIFY_RELEASES.testnet.pins));
  for (const w of WIDTHS) {
    const run = ANSWERS.good.runs.find((x) => x.width === w.name);
    assert.deepEqual(run.panel.rpcs, ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"]);
    assert.ok(r.lines.includes(`ok  ${w.name} /verify: panel read, code ok, funds ok; checks ${CHECKS.map((c) => `${c} ok`).join(", ")}`), w.name);
  }
  const d = desktop(ANSWERS.good);
  assert.equal(d.footer.firstState, "loading");
  for (const u of d.panel.rpcs) assert.ok(d.requests.some((q) => q.phase === "reopen" && q.method === "POST" && q.url.startsWith(u) && q.status === 200), u);
  assert.ok(r.lines.includes("ok  desktop /verify again: panel read, code ok, funds ok; checks " + CHECKS.map((c) => `${c} ok`).join(", ")));
});

test("recorded good answer, mainnet: Verify read live on its own pair against its vault's deploy record, every check ok at both widths: PASS", () => {
  const rec = ANSWERS.goodMainnet;
  const r = judge(rec);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(rec.network, "mainnet");
  assert.deepEqual(rec.pins, pinsOf(VERIFY_RELEASES.mainnet.pins));
  assert.deepEqual(rec.record, releaseRecord("mainnet"));
  for (const w of WIDTHS) {
    const run = rec.runs.find((x) => x.width === w.name);
    assert.deepEqual(run.panel.rpcs, VERIFY_RELEASES.mainnet.rpcs);
    assert.ok(r.lines.includes(`ok  ${w.name} /verify: panel read, code ok, funds ok; checks ${CHECKS.map((c) => `${c} ok`).join(", ")}`), w.name);
  }
  assert.ok(r.lines.includes("ok  desktop /verify again: panel read, code ok, funds ok; checks " + CHECKS.map((c) => `${c} ok`).join(", ")));
});

test("a recorded run writes each market read's token as <mint>, and every recorded answer holds none bare", () => {
  const mint = "DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF"; // a public Solana mint the page reads
  const rec = { runs: [{ requests: [{ url: `https://${APP_HOST}/v1/market/token?chain=solana&token=${mint}`, rpcId: null }] }] };
  const out = recorded(rec);
  assert.ok(!out.includes(mint), out);
  assert.ok(out.includes("/v1/market/token?chain=solana&token=<mint>"), out);
  assert.equal(recorded({ u: "https://x/a?token=<mint>&b=1" }).includes("token=<mint>&b=1"), true);
  for (const [k, a] of Object.entries(ANSWERS)) assert.deepEqual(JSON.stringify(a).match(/[?&]token=(?!<)[^&"\\]+/g), null, k);
});

test("planted: mainnet's build with no vault named, once the vault's deploy record exists: FAIL", () => {
  const stale = mut("noVault", (rec) => (rec.record = releaseRecord("mainnet")));
  assert.equal(stale.ok, false);
  assert.ok(bad(stale).some((l) => l.includes("a deploy record names vault vault.confidential.unrlzd.near on mainnet, but release.ts names none")), stale.lines.join("\n"));
});

test("recorded good answer, mainnet with no vault yet: every check Unverified, no RPC named, no NEAR request: PASS", () => {
  const r = judge(ANSWERS.noVault);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual([ANSWERS.noVault.network, ANSWERS.noVault.pins, ANSWERS.noVault.record], ["mainnet", null, null]);
  for (const w of WIDTHS) assert.ok(r.lines.includes(`ok  ${w.name} /verify: no vault named: the panel names no RPC; 0 request(s) to a NEAR RPC`), w.name);
});

test("recorded bad answer: main's build mounts no Verify: FAIL", () => {
  const r = judge(ANSWERS.notMounted);
  assert.equal(r.ok, false);
  for (const w of WIDTHS) assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w.name} /verify: no Verify panel`)), w.name);
});

test("planted: the deploy record moved while release.ts did not, or names a vault the run did not have: FAIL", () => {
  const moved = mut("good", (rec) => (rec.record.account_id = "vault.other.testnet"));
  assert.equal(moved.ok, false);
  assert.ok(bad(moved).some((l) => /release\.ts vault vault\.bf-vt-20261102t071444\.testnet, the deploy record vault\.other\.testnet/.test(l)));
  assert.equal(mut("noVault", (rec) => (rec.record = { network: "mainnet", account_id: "vault.near", asset: "a", code_hash: "c" })).ok, false);
  assert.equal(mut("good", (rec) => delete rec.record).ok, false);
});

test("planted: the pill's second open starts from the last read, or reads nothing afresh: FAIL", () => {
  const cached = mut("good", (rec) => (desktop(rec).footer.firstState = "read"));
  assert.equal(cached.ok, false);
  assert.ok(bad(cached).some((l) => /opens it again 1 time\(s\), starting read/.test(l)));
  const noReads = mut("good", (rec) => (desktop(rec).requests = desktop(rec).requests.filter((q) => q.phase !== "reopen")));
  assert.equal(noReads.ok, false);
  assert.ok(bad(noReads).some((l) => /^BAD desktop \/verify again: this page read test\.rpc\.fastnear\.com 0 time\(s\)/.test(l)));
  assert.equal(mut("good", (rec) => (desktop(rec).footer.panel = null)).ok, false);
  assert.equal(mut("good", (rec) => (desktop(rec).footer.panel.checks.balance = "warn")).ok, false);
});

test("recorded bad answer: the pill's open draws the last read at once, then reads (a module-level cache): FAIL", () => {
  const r = judge(ANSWERS.cached);
  assert.equal(r.ok, false);
  assert.match(ANSWERS.cached.source, /build-cached/);
  const d = desktop(ANSWERS.cached);
  // the panel is drawn loading and turns to the cached read before any answer: its first state alone does not show it
  assert.deepEqual(d.timeline.filter((e) => e.open === 1).map((e) => e.state), ["loading", "read"]);
  assert.ok(bad(r).some((l) => /^BAD desktop \/verify again: left loading for read at \d+ ms, 0 of 2 RPCs answered by then/.test(l)), r.lines.join("\n"));
  // the same run had the cached open's own read answered 200 before the close: only the timing refuses it
  const answered = mut("cached", (rec) => desktop(rec).requests.filter((q) => q.phase === "reopen").forEach((q) => (q.status = 200)));
  assert.equal(answered.ok, false);
  assert.deepEqual(bad(answered).map((l) => l.replace(/\d+ ms/, "N ms")), ["BAD desktop /verify again: left loading for read at N ms, 0 of 2 RPCs answered by then, 0 NEAR read(s) of this open still unanswered"]);
  // the first open of each width has nothing cached and passes
  assert.ok(r.lines.some((l) => /^ok  phone \/verify: left loading for read at \d+ ms, 2 of 2 RPCs answered by then, 0 NEAR read/.test(l)));
});

test("planted: an open that leaves loading before both RPCs answered it, or with a read of its own unanswered: FAIL", () => {
  const early = mut("good", (rec) => {
    const r = rec.runs[0];
    const leave = r.timeline.find((e) => e.open === 0 && e.state !== "loading");
    leave.t = Math.min(...r.rpcTiming.map((e) => e.end)) - 1;
  });
  assert.equal(early.ok, false);
  assert.ok(bad(early).some((l) => /^BAD phone \/verify: left loading for read at \d+ ms, \d of 2 RPCs answered by then/.test(l)));
  const pending = mut("good", (rec) => {
    const r = rec.runs[0];
    const leave = r.timeline.find((e) => e.open === 0 && e.state !== "loading");
    r.rpcTiming.push({ name: "https://near-testnet.drpc.org/", start: leave.t - 5, end: leave.t + 500 });
  });
  assert.equal(pending.ok, false);
  assert.ok(bad(pending).some((l) => /1 NEAR read\(s\) of this open still unanswered/.test(l)));
  assert.equal(mut("good", (rec) => (desktop(rec).timeline = desktop(rec).timeline.filter((e) => !(e.open === 1 && e.state === "loading")))).ok, false);
  assert.equal(mut("good", (rec) => (rec.runs[0].timeline = [])).ok, false);
  assert.equal(mut("good", (rec) => (rec.runs[0].rpcTiming = [])).ok, false);
});

test("planted: the pill's click drawing two panels, or the second open read from the wrong index: FAIL", () => {
  const twice = mut("good", (rec) => (desktop(rec).footer.newOpens = 2));
  assert.equal(twice.ok, false);
  assert.ok(bad(twice).some((l) => /opens it again 2 time\(s\)/.test(l)));
  assert.equal(mut("good", (rec) => delete desktop(rec).footer.newOpens).ok, false);
});

test("planted: a NEAR read of an account that is not the release's vault or asset: FAIL", () => {
  const other = mut("good", (rec) => (rec.runs[0].requests.find((q) => q.phase === "open" && q.account === rec.pins.vault).account = "vault.other.testnet"));
  assert.equal(other.ok, false);
  assert.ok(bad(other).some((l) => /^BAD phone \/verify: .*account vault\.other\.testnet in open/.test(l)));
  assert.equal(mut("good", (rec) => (desktop(rec).requests.find((q) => q.phase === "reopen" && q.account).account = null)).ok, false);
  for (const w of WIDTHS) {
    const posts = ANSWERS.good.runs.find((x) => x.width === w.name).requests.filter((q) => q.method === "POST");
    assert.ok(posts.length > 0 && posts.every((q) => [ANSWERS.good.pins.vault, ANSWERS.good.pins.asset].includes(q.account) && q.rpcId === "verify"), w.name);
  }
});

test("planted: stray NEAR requests between and after the opens: FAIL", () => {
  const post = (url, phase, rpcId = "other") => ({ url, method: "POST", type: "fetch", status: 200, phase, account: ANSWERS.good.pins.vault, rpcId });
  const cases = [
    ["noVault", "https://near.drpc.org/", "between", /no vault named: 1 NEAR request\(s\) over the whole run \(near\.drpc\.org in between\)/],
    ["noVault", "https://rpc.mainnet.fastnear.com/", "after", /no vault named: 1 NEAR request\(s\) over the whole run \(rpc\.mainnet\.fastnear\.com in after\)/], // near-rpc-operators: one operator (planted strays, one request each)
    ["good", "https://rpc.testnet.near.org/", "between", /rpc\.testnet\.near\.org \(not the pair\) in between/], // near-rpc-operators: one operator (planted strays, one request each)
    ["good", "https://test.rpc.fastnear.com/", "after", /a Verify read in after/, "verify"], // near-rpc-operators: one operator (planted strays, one request each)
    ["good", "https://rpc.mainnet.fastnear.com/", "after", /rpc\.mainnet\.fastnear\.com \(not the pair\) in after/], // near-rpc-operators: one operator (planted strays, one request each)
  ];
  for (const [name, url, phase, line, rpcId] of cases) {
    const r = mut(name, (rec) => desktop(rec).requests.push(post(url, phase, rpcId)));
    assert.equal(r.ok, false, `${name} ${url} ${phase}`);
    assert.ok(bad(r).some((l) => l.startsWith("BAD desktop /verify: ") && line.test(l)), `${name} ${url} ${phase}\n${bad(r).join("\n")}`);
  }
});

test("the footer's block read (card app-footer-bar) on the pair, in any phase, is not Verify's; one in another form or off the pair: FAIL", () => {
  const pair = ANSWERS.good.rpcs;
  const footer = (base, phase, over = {}) => ({ url: `${base.replace(/\/$/, "")}/?ct=footer`, method: "POST", type: "fetch", status: 200, phase, account: null, rpcId: "ct-footer", rpcMethod: "block", rpcParams: JSON.stringify({ finality: "final" }), ...over });
  // footer reads on both RPCs of the pair, before, during and after the opens, some unanswered: still PASS
  const ok = mut("good", (rec) => {
    for (const phase of ["open", "between", "reopen", "after"]) for (const u of pair) desktop(rec).requests.push(footer(u, phase, phase === "open" ? { status: null } : {}));
    desktop(rec).rpcTiming = [...(desktop(rec).rpcTiming ?? []), ...pair.map((u) => ({ name: `${u.replace(/\/$/, "")}/?ct=footer`, start: 0, end: 0 }))];
  });
  assert.equal(ok.ok, true, ok.lines.join("\n"));
  assert.ok(ok.lines.some((l) => /and 8 footer block read\(s\)/.test(l)), ok.lines.join("\n"));
  const cases = [
    [{ account: ANSWERS.good.pins.vault }, /naming vault\./],
    [{ rpcMethod: "query" }, /a footer-tagged query/],
    [{ rpcParams: JSON.stringify({ block_id: 1 }) }, /a footer-tagged block .*not the footer's block read/],
    [{ rpcId: "verify" }, /not the footer's block read/],
  ];
  for (const [over, line] of cases) {
    const r = mut("good", (rec) => desktop(rec).requests.push(footer(pair[0], "between", over)));
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.ok(bad(r).some((l) => line.test(l)), `${JSON.stringify(over)}\n${bad(r).join("\n")}`);
  }
  // the footer's tag on an RPC that is not the pair
  const off = mut("good", (rec) => desktop(rec).requests.push(footer("https://rpc.testnet.near.org", "after"))); // near-rpc-operators: one operator (a planted stray)
  assert.equal(off.ok, false);
  assert.ok(bad(off).some((l) => /footer-tagged block to rpc\.testnet\.near\.org/.test(l)), bad(off).join("\n"));
});

test("planted: any NEAR request with no vault named, or a panel naming an RPC it never asked: FAIL", () => {
  const post = (url) => ({ url, method: "POST", type: "fetch", status: 200, phase: "open", account: ANSWERS.good.pins.vault, rpcId: "verify" });
  // a POST to a NEAR RPC the panel does not name (not one of the release's pair)
  assert.equal(mut("noVault", (rec) => rec.runs[0].requests.push(post("https://rpc.mainnet.near.org/"))).ok, false);
  // a panel naming no RPC while the page asks near.drpc.org
  const silent = mut("noVault", (rec) => rec.runs[1].requests.push(post("https://near.drpc.org/")));
  assert.equal(silent.ok, false);
  assert.ok(bad(silent).some((l) => /names no RPC; 1 request\(s\) to a NEAR RPC \(near\.drpc\.org\)/.test(l)));
  // the panel names a pair with no vault named
  assert.equal(mut("noVault", (rec) => (rec.runs[0].panel.rpcs = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"])).ok, false);
  // with a vault named, a POST to a third NEAR RPC
  assert.equal(mut("good", (rec) => rec.runs[0].requests.push(post("https://rpc.testnet.near.org/"))).ok, false);
});

test("planted: the testnet pair on a mainnet run, two RPCs of one operator, the other network's record: FAIL", () => {
  const crossed = mut("good", (rec) => {
    rec.network = "mainnet";
    rec.record = { network: "mainnet", account_id: rec.record.account_id, asset: rec.record.asset, code_hash: rec.record.code_hash };
  });
  assert.equal(crossed.ok, false);
  assert.ok(bad(crossed).some((l) => /\(fastnear, drpc; testnet, testnet\), want two operators on mainnet/.test(l)));
  const one = mut("good", (rec) => (rec.runs[0].panel.rpcs = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"])); // near-rpc-operators: one operator (planted)
  assert.equal(one.ok, false);
  assert.ok(bad(one).some((l) => /\(fastnear, fastnear; testnet, testnet\)/.test(l)));
});

test("planted: every check Unverified, one check not ok, or RPCs disagree, with a vault named: FAIL", () => {
  assert.equal(mut("good", (rec) => rec.runs.forEach((run) => Object.assign(run.panel, { state: "unverified", code: "warn", funds: "warn" }))).ok, false);
  assert.equal(mut("good", (rec) => (rec.runs[0].panel.checks.balance = "danger")).ok, false);
  assert.equal(mut("good", (rec) => (rec.runs[1].panel.checks.code = "warn")).ok, false);
  assert.equal(mut("good", (rec) => (rec.runs[0].panel.state = "disagree")).ok, false);
  assert.equal(mut("good", (rec) => delete rec.runs[1].panel.checks.keys).ok, false);
  assert.equal(mut("noVault", (rec) => (rec.runs[1].panel.checks.keys = "ok")).ok, false);
});

test("planted: rows drawn with no read of this open, a failed read, a CSP violation, a console error, a missing width: FAIL", () => {
  assert.equal(mut("good", (rec) => (rec.runs[0].requests = rec.runs[0].requests.filter((q) => q.phase !== "open"))).ok, false);
  assert.equal(mut("good", (rec) => (rec.runs[0].requests.find((q) => q.phase === "open" && q.url.includes("drpc")).status = 429)).ok, false);
  assert.equal(mut("good", (rec) => rec.runs[0].violations.push({ directive: "connect-src", blocked: "https://near-testnet.drpc.org" })).ok, false);
  assert.equal(mut("good", (rec) => rec.runs[1].errors.push("boom")).ok, false);
  assert.equal(mut("good", (rec) => (desktop(rec).footer.closedTo = "/verify")).ok, false);
  assert.equal(mut("good", (rec) => rec.runs.pop()).ok, false);
  assert.equal(mut("good", (rec) => rec.runs.forEach((run) => (run.panel = null))).ok, false);
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
  const r = mut("good", (rec) => rec.runs[1].errors.push(kept[0]));
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
  const r = mut("good", (rec) => rec.runs[0].errors.push(...kept));
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
  const r = mut("good", (rec) => rec.runs[1].errors.push(...kept));
  assert.equal(r.ok, false);
  for (const k of kept) assert.ok(bad(r).some((l) => l.includes(`console ${k}`)), `${k}: ${r.lines.join("\n")}`);
});

test("planted on the mainnet answer: a down NEAR RPC's preflight error is let through when the page shows it, never when it shows ok (card app-shell-rpc-outage-judge)", () => {
  const near = new URL(VERIFY_RELEASES.mainnet.rpcs[0]).origin;
  const cors = (url) => consoleLine(`Access to fetch at '${url}' from origin '${APP_HOST}' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: It does not have HTTP ok status.`, `${APP_HOST}/verify`);
  const line = (r) => r.lines.find((l) => l.includes("desktop /verify: ") && /no console error|console /.test(l));
  const plant = (errors, dom) => line(mut("goodMainnet", (rec) => Object.assign(desktop(rec), { errors: [...desktop(rec).errors, ...errors], dom })));
  const amber = { verify: { state: "read", code: "warn", funds: "warn", pools: {} }, footer: { conn: "on", block: "223500000", ms: 5000 } };
  // a Verify read: shown amber passes the line, shown ok or not drawn fails it
  assert.equal(plant([cors(`${near}/`)], amber), `ok  desktop /verify: no CSP violation, no console error; RPC down, shown: ${near.replace("https://", "")}`);
  assert.match(plant([cors(`${near}/`)], { ...amber, verify: { ...amber.verify, code: "ok" } }), /^BAD desktop \/verify: console Access to fetch .*\[.* is a release RPC, not shown Unverified: code ok, funds warn\]$/);
  assert.match(plant([cors(`${near}/`)], undefined), /not shown Unverified: code not drawn, funds not drawn\]$/);
  // a footer read: the footer on with its block passes, anything else fails
  const tagged = cors(footerUrl(VERIFY_RELEASES.mainnet.rpcs[0]));
  assert.ok(tagged.endsWith(" [footer read]"));
  assert.equal(plant([tagged], { ...amber, verify: { state: "read", code: "ok", funds: "ok", pools: {} } }), `ok  desktop /verify: no CSP violation, no console error; RPC down, shown: ${near.replace("https://", "")}`);
  assert.match(plant([tagged], { ...amber, footer: { conn: "off", block: "223500000", ms: 5000 } }), /a footer read, and the footer shows off, block 223500000, not the pair answered\]$/);
  // any other error beside it still fails
  assert.match(plant([cors(`${near}/`), "Uncaught boom"], amber), /^BAD desktop \/verify: console Uncaught boom$/);
});

test("planted on the mainnet answer: amber rows and the down RPC's non-200 reads pass only beside a shown outage of that origin, in the same load (card app-shell-rpc-outage-judge)", () => {
  const near = new URL(VERIFY_RELEASES.mainnet.rpcs[0]).origin;
  const other = new URL(VERIFY_RELEASES.mainnet.rpcs[1]).origin;
  const load = (origin, status) => consoleLine(`Failed to load resource: the server responded with a status of ${status} ()`, `${origin}/`);
  const amberChecks = { keys: "warn", code: "warn", asset: "warn", registration: "warn", tokenCode: "warn", balance: "warn" };
  const verifyDom = (code, funds) => ({ state: "read", code, funds, pools: {} });
  const down = (rec, { errors, dom, rows = "warn", status = 503, origin = near } = {}) => {
    const d = desktop(rec);
    d.errors = [...d.errors, ...errors];
    d.dom = { verify: dom, footer: { conn: "on", block: "223500000", ms: 5000 } };
    for (const p of [d.panel, d.footer?.panel].filter(Boolean)) Object.assign(p, { code: rows, funds: rows, checks: Object.fromEntries(Object.keys(p.checks).map((c) => [c, rows])) });
    for (const x of d.requests) if (x.method === "POST" && x.url.startsWith(origin)) x.status = status;
    return rec;
  };
  const desk = (r) => r.lines.filter((l) => l.includes("desktop /verify"));
  const run = (o) => mut("goodMainnet", (rec) => down(rec, o));
  const good = { errors: [load(near, 503)], dom: verifyDom("warn", "warn") };
  // the shown outage: every desktop line passes
  const ok = run(good);
  assert.deepEqual(bad(ok), [], ok.lines.join("\n"));
  // 429 and no answer at all read as down as well
  assert.deepEqual(bad(run({ ...good, status: 429, errors: [load(near, 429)] })), []);
  assert.deepEqual(bad(run({ ...good, status: null })), []);
  // the same amber rows with no failed load of that origin, or with the page's DOM showing them ok, are unexplained warns
  assert.ok(bad(run({ ...good, errors: [] })).some((l) => /panel read, code warn/.test(l)), "amber rows with no failed load");
  assert.ok(bad(run({ ...good, dom: verifyDom("ok", "ok") })).some((l) => /console Failed to load resource/.test(l)), "failed load of an RPC the DOM shows ok");
  // one amber row of two, or a check that is ok among the amber ones, fails
  assert.ok(bad(run({ ...good, dom: verifyDom("warn", "ok") })).length > 0);
  assert.ok(bad(run({ ...good, rows: "ok", dom: verifyDom("warn", "warn") })).some((l) => /panel read, code ok/.test(l)), "outage shown by the DOM but the panel record says ok");
  // a 4xx other than 429 on the down RPC's reads is no outage
  assert.ok(bad(run({ ...good, status: 404 })).some((l) => /not all 200/.test(l)), "404 beside the outage");
  // the other RPC of the pair answering 500 while only the first is shown down fails
  assert.ok(bad(run({ ...good, origin: other, status: 500 })).some((l) => /not all 200/.test(l)), "a read of the RPC that is not shown down");
  // a failed load of the origin plus a page error beside it still fails
  assert.ok(bad(run({ ...good, errors: [...good.errors, "Uncaught boom"] })).some((l) => l.endsWith("console Uncaught boom")));
  assert.ok(desk(ok).length > 0);
});
