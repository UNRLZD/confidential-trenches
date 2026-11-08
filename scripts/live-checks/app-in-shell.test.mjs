// node --test scripts/live-checks/app-in-shell.test.mjs: the live check's verdict replays recorded runs
// (app-in-shell.answers.json), each read on 2026-11-01 by app-in-shell.mjs --harness --record on the Mac, in
// Playwright 1.63's Chromium, Firefox and WebKit, at 390 and 1440 wide, with the signed, late, silent, tap and update runs:
//   good: this card's terminal build at APP_HOST and the stand-in shells at SIGN_HOST: PASS;
//   bad:  main 7435ff5's terminal, before this card, with the same shells: APP_HOST stays top-level with SIGN_HOST
//         framed (which the shell's frame-ancestors 'none' refuses): FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP_HOST, ENGINES, frameErrors, judge, KINDS, MOVE_TO, PATH, SIGN_HOST, WIDTHS } from "./app-in-shell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-in-shell.answers.json"), "utf8"));

test("recorded good answer: every engine and width lands on SIGN_HOST with the path kept and reads signed in, no hop: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const e of ENGINES) {
    for (const w of WIDTHS) {
      const n = `${e} ${w.name}`;
      assert.ok(r.lines.includes(`ok  ${n}: APP_HOST${PATH} top-level lands on ${SIGN_HOST}${PATH}`), n);
      assert.ok(r.lines.includes(`ok  ${n}: APP_HOST top-level drew nothing before it moved`), n);
      assert.ok(r.lines.includes(`ok  ${n}: the shell frames ${APP_HOST}${PATH}`), n);
      assert.ok(r.lines.includes(`ok  ${n}: inside the shell, signing page ready, header S1.4 (want ready, S1.4)`), n);
      assert.ok(r.lines.some((l) => l.startsWith(`ok  ${n}: no hop`)), n);
      assert.ok(r.lines.some((l) => new RegExp(`^ok  ${n}: READY at \\d+ ms of the terminal's start, limit 5000 ms$`).test(l)), n);
      assert.ok(r.lines.some((l) => new RegExp(`^ok  ${n} late: READY at \\d+ ms, never down, with the shell's ready held 7000 ms, limit 5000 ms$`).test(l)), n);
      assert.ok(r.lines.includes(`ok  ${n} late: after the shell's late ready came, signing page ready, no reload`), n);
      assert.ok(r.lines.some((l) => new RegExp(`^ok  ${n} silent: down at 5\\d{3} ms, limit 6500 ms$`).test(l)), n);
      assert.ok(r.lines.includes(`ok  ${n} silent: the down toast shows ("Couldn't load. Your funds are safe.Retry")`), n);
      assert.ok(r.lines.some((l) => new RegExp(`^ok  ${n} silent: READY again at \\d+ ms, once the shell's late ready came, no reload$`).test(l)), n);
      assert.ok(r.lines.some((l) => new RegExp(`^ok  ${n} tap: the tap shows "Not available" \\(refused, Retry not shown, in the sheet\\) \\d+ ms after it, limit 6500 ms$`).test(l)), n);
      assert.ok(r.lines.includes(`ok  ${n} tap: the top window stayed on SIGN_HOST, 2 top navigation(s)`), n);
      assert.ok(r.lines.includes(`ok  ${n} tap: no pop-up`), n);
      assert.ok(r.lines.includes(`ok  ${n}: after a tap on ${MOVE_TO}, the top window's address is ${SIGN_HOST}${MOVE_TO}, the terminal at ${APP_HOST}${MOVE_TO}`), n);
      assert.ok(r.lines.includes(`ok  ${n}: after a reload of the top window, the address is ${SIGN_HOST}${MOVE_TO}, the shell frames ${APP_HOST}${MOVE_TO}, signing page ready`), n);
      assert.ok(r.lines.includes(`ok  ${n} update: the shell's other message API shows the update state, Reload on screen`), n);
      assert.ok(r.lines.includes(`ok  ${n} update: Reload reloads the top window, address ${SIGN_HOST}${PATH}`), n);
    }
  }
});

test("recorded bad answer: today's APP_HOST stays top-level with SIGN_HOST framed: FAIL on landing, drawing and the frame", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const e of ENGINES) {
    for (const w of WIDTHS) {
      const n = `${e} ${w.name}`;
      assert.ok(r.lines.includes(`BAD ${n}: APP_HOST${PATH} top-level ends at ${APP_HOST}${PATH}`), n);
      assert.ok(r.lines.includes(`BAD ${n}: APP_HOST top-level drew the app`), n);
      assert.ok(r.lines.includes(`BAD ${n}: no APP_HOST frame in the top window`), n);
    }
  }
});

test("a run missing, an engine missing, or the header signed out where signed in is expected: FAIL", () => {
  const drop = structuredClone(ANSWERS.good);
  drop.runs = drop.runs.filter((x) => x.engine !== "webkit");
  assert.ok(judge(drop).lines.includes("BAD webkit phone: no run"));
  const out = structuredClone(ANSWERS.good);
  out.runs[0].app.header = "S1.1";
  assert.equal(judge(out).ok, false);
  const hop = structuredClone(ANSWERS.good);
  hop.runs.find((x) => x.kind === "signed").topNavigations.push(`${SIGN_HOST}/`);
  assert.equal(judge(hop).ok, false);
  // the engines asked: CI's browser job asks Chromium only and is judged on Chromium in full; an asked engine with no
  // run, or a record that names no engine or an unknown one, fails
  const chromium = structuredClone(ANSWERS.good);
  chromium.engines = ["chromium"];
  chromium.runs = chromium.runs.filter((x) => x.engine === "chromium");
  assert.equal(judge(chromium).ok, true, judge(chromium).lines.join("\n"));
  assert.ok(judge(chromium).lines.every((l) => !/^(ok |BAD) (firefox|webkit) /.test(l)));
  const asked = structuredClone(chromium);
  asked.engines = ["chromium", "webkit"];
  assert.ok(judge(asked).lines.includes("BAD webkit phone: no run"));
  assert.equal(judge(asked).ok, false);
  for (const engines of [[], ["chromium", "chromium"], ["safari"], "chromium"]) {
    const bad = structuredClone(chromium);
    bad.engines = engines;
    assert.equal(judge(bad).ok, false, JSON.stringify(engines));
  }
  const slow = structuredClone(ANSWERS.good);
  slow.runs.find((x) => x.kind === "signed").app.timeline = [{ s: "connecting", t: 10 }, { s: "ready", t: 5200 }];
  assert.ok(judge(slow).lines.some((l) => /^BAD \w+ \w+: READY at 5200 ms of the terminal's start, limit 5000 ms$/.test(l)));
});

test("planted on the good answer: the late run goes down or reloads, the silent run reloads or never goes down, the tap shows nothing or moves the top window: FAIL", () => {
  const mut = (kind, f) => {
    const rec = structuredClone(ANSWERS.good);
    f(rec.runs.find((x) => x.kind === kind));
    return judge(rec).lines.filter((l) => l.startsWith("BAD"));
  };
  assert.ok(mut("late", (r) => r.app.timeline.push({ s: "down", t: 5_010 })).some((l) => /late: READY at \d+ ms, down at 5010 ms/.test(l)));
  assert.ok(mut("late", (r) => (r.app.timeline = [{ s: "connecting", t: 5 }, { s: "down", t: 5_005 }, { s: "ready", t: 7_010 }])).some((l) => /late: READY at 7010 ms, down at 5005 ms/.test(l)));
  assert.ok(mut("late", (r) => (r.reloaded = true)).some((l) => /late: after the shell's late ready came, .*, after a reload$/.test(l)));
  assert.ok(mut("late", (r) => (r.lateReady = false)).some((l) => /late: after the shell's late ready never came/.test(l)));
  assert.ok(mut("silent", (r) => (r.reloaded = true)).some((l) => /silent: READY again .*, after a reload$/.test(l)));
  assert.ok(mut("silent", (r) => (r.app.timeline = r.app.timeline.filter((e) => e.s !== "down"))).some((l) => /silent: down never/.test(l)));
  assert.ok(mut("silent", (r) => (r.toast = { visible: false, text: null })).some((l) => /silent: the down toast does not show/.test(l)));
  assert.ok(mut("tap", (r) => Object.assign(r, { outcome: "none", ms: null, line: null, control: "on" })).some((l) => /tap: the tap shows nothing \(control on\)/.test(l)));
  assert.ok(mut("tap", (r) => (r.topAfter = `${APP_HOST}/`)).some((l) => /tap: the top window moved to/.test(l)));
  assert.ok(mut("tap", (r) => r.dialogs.push("alert")).some((l) => /tap: pop-ups alert/.test(l)));
  assert.ok(mut("tap", (r) => (r.line.why = "silent")).some((l) => /tap: the tap shows .*\(silent/.test(l)));
  // the address does not follow the app (no nav), a reload loses the page, Reload reloads the frame alone
  assert.ok(mut("signed", (r) => (r.moved.top = `${SIGN_HOST}${PATH}`)).some((l) => l.includes(`after a tap on ${MOVE_TO}, the top window's address is ${SIGN_HOST}${PATH}`)));
  assert.ok(mut("signed", (r) => Object.assign(r.afterReload, { top: `${SIGN_HOST}${PATH}`, frame: `${APP_HOST}${PATH}` })).some((l) => l.includes("after a reload of the top window, the address is")));
  assert.ok(mut("signed", (r) => (r.afterReload.signpage = "down")).some((l) => l.includes("signing page down")));
  assert.ok(mut("update", (r) => (r.update.topReloaded = false)).some((l) => /update: Reload does not reload the top window/.test(l)));
  assert.ok(mut("update", (r) => (r.update.before = "ready")).some((l) => /update: .*leaves the terminal ready/.test(l)));
});

test("every engine and width has all five run kinds on the harness; a live record is judged on the signed run only", () => {
  assert.deepEqual(KINDS, ["signed", "late", "silent", "tap", "update"]);
  assert.deepEqual(ANSWERS.good.engines, ENGINES);
  assert.equal(ANSWERS.good.runs.length, ENGINES.length * WIDTHS.length * KINDS.length);
  const live = structuredClone(ANSWERS.good);
  live.source = "live";
  live.runs = live.runs.filter((x) => x.kind === "signed");
  assert.equal(judge(live).ok, true, judge(live).lines.join("\n"));
});

// The harness answers the helper's two reads the token route makes (card app-no-test-token): the lists and the token
// read come from recorded live answers, so / draws a real token there and the page under test never reaches the
// network; a mint the recordings do not hold answers 404 (a helper answer), never an aborted load.
test("harness: GET /v1/market/lists and /v1/market/token are answered from the recorded live answers; the top Trending token reads 200", async () => {
  const { mkdtempSync, copyFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { harnessRoute } = await import("./app-in-shell.mjs");
  const { columnRows } = await import("../../apps/terminal/src/screens/discover/model.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "app-in-shell-harness-"));
  copyFileSync(path.join(HERE, "../../apps/terminal/public/_headers"), path.join(dir, "_headers"));
  try {
    const route = await harnessRoute(dir, "signed");
    const ask = async (url) => {
      let out = null;
      await route({ request: () => ({ url: () => url }), fulfill: async (a) => void (out = { kind: "fulfill", ...a }), abort: async (e) => void (out = { kind: "abort", error: e }) });
      return out;
    };
    const lists = await ask("https://ct-api.unrealized.trade/v1/market/lists?chain=solana");
    assert.equal(lists.kind, "fulfill");
    assert.equal(lists.status, 200);
    assert.equal(lists.headers["access-control-allow-origin"], APP_HOST);
    const snap = JSON.parse(lists.body);
    const top = columnRows(snap, "trending")[0];
    assert.ok(top, "the harness's lists hold a Trending token");
    const tok = await ask(`https://ct-api.unrealized.trade/v1/market/token?chain=solana&token=${top.token}`);
    assert.equal(tok.kind, "fulfill");
    assert.equal(tok.status, 200);
    assert.equal(tok.headers["access-control-allow-origin"], APP_HOST);
    const row = JSON.parse(tok.body).row;
    assert.equal(row.token, top.token);
    assert.equal(row.chain, "solana");
    const other = await ask("https://ct-api.unrealized.trade/v1/market/token?chain=solana&token=So11111111111111111111111111111111111111112");
    assert.equal(other.kind, "fulfill");
    assert.equal(other.status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Verify on mainnet reads the release's two NEAR RPCs; the harness answers them from a recorded real read of the mainnet
// vault (apps/terminal/test/verify-mount/answers-mainnet.json), by RPC and params, so the panel draws its true state and
// no console error comes of an aborted read. A read the recording does not hold, another RPC and any other origin stay
// aborted.
test("harness: Verify's mainnet reads are answered from the recorded read of the release's vault on its pair; nothing else is", async () => {
  const { mkdtempSync, copyFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { harnessRoute } = await import("./app-in-shell.mjs");
  const { VERIFY_RELEASES } = await import("../../apps/terminal/src/screens/verify/release.ts");
  const REC = JSON.parse(readFileSync(path.join(HERE, "../../apps/terminal/test/verify-mount/answers-mainnet.json"), "utf8"));
  const M = VERIFY_RELEASES.mainnet;
  assert.deepEqual([REC.vault, REC.rpcs], [M.pins.vault, M.rpcs]);
  assert.deepEqual([REC.view.state, REC.view.code.status, REC.view.funds.status], ["read", "ok", "ok"]);
  const dir = mkdtempSync(path.join(tmpdir(), "app-in-shell-harness-"));
  copyFileSync(path.join(HERE, "../../apps/terminal/public/_headers"), path.join(dir, "_headers"));
  try {
    const route = await harnessRoute(dir, "signed");
    const ask = async (url, body) => {
      let out = null;
      await route({ request: () => ({ url: () => url, postData: () => body }), fulfill: async (a) => void (out = { kind: "fulfill", ...a }), abort: async (e) => void (out = { kind: "abort", error: e }) });
      return out;
    };
    for (const u of M.rpcs) {
      const asked = REC.answers.filter((a) => new URL(a.url).origin === new URL(u).origin);
      assert.ok(asked.length > 0, u);
      for (const a of asked) {
        const got = await ask(`${u}/`, JSON.stringify({ jsonrpc: "2.0", id: "verify", method: "query", params: a.params }));
        assert.equal(got.kind, "fulfill", u);
        assert.equal(got.status, 200);
        assert.equal(got.headers["access-control-allow-origin"], APP_HOST);
        assert.deepEqual(JSON.parse(got.body), a.answer);
      }
      const unheld = await ask(`${u}/`, JSON.stringify({ jsonrpc: "2.0", id: "verify", method: "query", params: { request_type: "view_account", finality: "final", account_id: "other.near" } }));
      assert.deepEqual(unheld, { kind: "abort", error: "namenotresolved" }, u);
      assert.deepEqual(await ask(`${u}/`, "not json"), { kind: "abort", error: "namenotresolved" }, u);
    }
    const p = REC.answers[0].params;
    assert.deepEqual(await ask("https://rpc.mainnet.near.org/", JSON.stringify({ jsonrpc: "2.0", id: "verify", method: "query", params: p })), { kind: "abort", error: "namenotresolved" });
    assert.deepEqual(await ask("https://example.com/", undefined), { kind: "abort", error: "namenotresolved" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planted on the good answer: a recorded 429 names its resource's origin and path in the BAD line, and an error with no location still fails (card live-console-url)", () => {
  const text = "Failed to load resource: the server responded with a status of 429 ()";
  const helper = "https://ct-api.unrealized.trade";
  const kept = frameErrors([
    { url: `${helper}/v1/market/token?chain=solana&mint=So11111111111111111111111111111111111111112`, text },
    { url: `${SIGN_HOST}/assets/shell.js`, text: "the shell's own" },
    { url: "", text: "Uncaught boom" },
  ]);
  assert.deepEqual(kept, [`${text} (${helper}/v1/market/token)`, "Uncaught boom"]);
  for (const [line, want] of [
    [kept[0], (l) => l.endsWith(`status of 429 () (${helper}/v1/market/token)`)],
    [kept[1], (l) => l.endsWith(": Uncaught boom")],
  ]) {
    const rec = structuredClone(ANSWERS.good);
    rec.runs.find((x) => x.kind === "signed").app.errors.push(line);
    const r = judge(rec);
    assert.equal(r.ok, false);
    assert.ok(r.lines.some((l) => /^BAD \w+ \w+: /.test(l) && want(l)), r.lines.join("\n"));
    assert.ok(!r.lines.some((l) => l.includes("mint=")), "no query in a line");
  }
});
