// node --test scripts/live-checks/signpage-shell.test.mjs: the live check replays recorded runs
// (signpage-shell.answers.json). good.<engine>.<width>: this card's committed build on the harness, on the Mac's own
// WebKit (scripts/webkit-harness), Playwright's Chromium and Firefox, at 390 x 844 (phone) and 1440 x 900 (desktop):
// PASS. bad.webkit: main's build before this card
// (APP_HOST frames SIGN_HOST) on the Mac's WebKit: FAIL, its framed SIGN_HOST reading signed out after the sign-in.
// bad.chromium: the same build on Chromium: FAIL on the shell alone (there the old frame still reads the store).
// fstar.<engine>: this card's build with frame-src * in its _headers, on WebKit and Chromium: FAIL on the stranger
// alone, its frame sent to example.com. prefix.<engine>: this card's build at ea785a4, before the review's fixes (the
// layer over the terminal while signed out, the frame left under it, no signin.open, nav or reload): FAIL, and on
// every engine the app takes the typed words. fstar and prefix run at phone width. bad.* were recorded before the check
// named its width, so their first line is the width's BAD and the tests read the lines after it. The rest are a good run with one thing changed each, among them the lines that
// signpage-frame-state judged (retired with this card): a reload while signed in, the status deleted raw, its backfill.
// good.chromium.<width> were recorded again with card signing-views-open-over-the-app (11 Nov, Chrome 156 on the harness):
// the passkey screen opens as a sheet with the frame kept under it, Saved closes to that same frame (no new load), and
// the typed words' screen still takes the frame out, the app's focus() thief getting none of the words.
// release111.chromium.<width>: the live page on release 111, the mainnet Solana pool pinned (card
// sign-live-checks-read-a-pinned-page): PASS, with the pinned hosts' cases planted from it at the end.
// release119.<engine>.<width>: the live page on release 119, the Base and Robinhood pools pinned too (card
// sign-live-checks-name-evm-pool-hosts): PASS, with the EVM hosts' cases planted from it at the end.
// reload.chromium.phone: card sign-out-stops-the-pages-reads's build on the harness (12 Nov, Chrome 157): every landed
// sign out reloads the top window; the passkey account signs out by this tab's own button, the words' in another tab,
// and a second passkey account lands after it: PASS, with that card's cases planted from it at the end.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { connectHosts, EVENT_MS, judge, namesIn, PINNED_HOSTS, RELOAD_MS, START, WIDTHS } from "./signpage-shell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-shell.answers.json"), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD") && !l.startsWith("BAD the view is"));

for (const engine of ["webkit", "chromium", "firefox"]) {
  for (const [width, size] of Object.entries(WIDTHS)) {
    test(`recorded good run on ${engine} at ${width} width: PASS`, () => {
      const rec = ANSWERS.good[engine][width];
      assert.equal(rec.engine, engine);
      const r = judge(rec);
      assert.equal(r.ok, true, r.lines.join("\n"));
      assert.ok(r.lines.includes(`ok  the view is ${width} ${size.width} x ${size.height} (the top window is ${size.width} px wide)`));
      assert.ok(r.lines.some((l) => l.startsWith("ok  the typed words sign the shell in, the layer closes and the new frame answers signed in, way words")));
      assert.ok(r.lines.some((l) => l.startsWith("ok  the 12 words typed while the app calls focus() every 20 ms: the shell holds all of them, the app none")));
    });
  }
}

test("the WebKit good runs are the Mac's own WebKit, not Playwright's", () => {
  for (const width of Object.keys(WIDTHS)) {
    assert.match(ANSWERS.good.webkit[width].browser, /system WebKit/);
    assert.doesNotMatch(ANSWERS.good.webkit[width].browser, /Playwright/);
  }
});

test("a run whose top window is not the width it names, or names no known width, fails", () => {
  const cases = {
    "the phone run read 800 px": (a) => (a.view.inner = 800),
    "an unknown width": (a) => (a.view.name = "tablet"),
    "no width": (a) => delete a.view,
  };
  for (const [name, change] of Object.entries(cases)) {
    const a = clone(ANSWERS.good.webkit.phone);
    change(a);
    const r = judge(a);
    assert.equal(r.ok, false, name);
    assert.match(r.lines[0], /^BAD the view is /, name);
  }
});

test("recorded bad run: main's build on the Mac's WebKit: FAIL, its framed SIGN_HOST reads signed out", () => {
  const r = judge(ANSWERS.bad.webkit);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.match(b[0], /^BAD SIGN_HOST is the top window and frames APP_HOST/);
  assert.match(b[1], /read \{"signed_in":false,"code_saved":false\} after the words signed SIGN_HOST in, signed-in\)$/);
});

test("recorded bad run: main's build on Chromium: FAIL on the shell", () => {
  const r = judge(ANSWERS.bad.chromium);
  assert.equal(r.ok, false);
  assert.match(bad(r)[0], /^BAD SIGN_HOST is the top window and frames APP_HOST/);
});

for (const engine of ["webkit", "chromium"]) {
  test(`recorded bad run: frame-src * on ${engine}: FAIL on the frame sent to another origin only`, () => {
    const r = judge(ANSWERS.fstar[engine]);
    assert.equal(r.ok, false);
    const b = bad(r);
    assert.equal(b.length, 2, r.lines.join("\n"));
    assert.match(b[0], /^BAD the frame cannot be sent to https:\/\/example\.com\/ \([1-9]\d* requests for it\)$/);
    assert.match(b[1], /^BAD no request leaves SIGN_HOST and APP_HOST but for the pinned pool's hosts \([1-9]\d*: example\.com/);
  });
}

const GOOD = ANSWERS.good.chromium.desktop;

test("a second ready while the frame shows APP_HOST fails", () => {
  const a = clone(GOOD);
  const r0 = a.messages.find((m) => m.data?.type === "ready");
  a.messages.push({ t: a.steps.words.t, data: r0.data });
  assert.equal(judge(a).ok, false);
});

test("a frame at another path or query fails", () => {
  for (const href of [`https://ct-app.unrealized.trade/`, `https://ct-app.unrealized.trade${START.split("?")[0]}`, `https://example.com${START}`]) {
    const a = clone(GOOD);
    a.steps.open.frameHref = href;
    assert.equal(judge(a).ok, false, href);
  }
});

test("a state event late, missing or with the wrong way fails", () => {
  const late = clone(GOOD);
  for (const m of late.messages) if (m.t >= late.steps.words.t && m.data?.type === "state" && !m.data.id) m.t += 60_000;
  assert.equal(judge(late).ok, false);
  const way = clone(GOOD);
  for (const m of way.messages) {
    if (m.data?.type === "state" && m.data.state?.way === "words") m.data.state.way = "passkey";
    if (m.data?.result?.way === "words") m.data.result.way = "passkey";
  }
  assert.equal(judge(way).ok, false);
});

test("a request to the stranger or to any third host fails, and so does a run that never tried the stranger", () => {
  const a = clone(GOOD);
  a.requests.push({ host: "example.com", path: "/", method: "GET" });
  assert.equal(judge(a).ok, false);
  const b = clone(GOOD);
  b.requests.push({ host: "evil.ct.test", path: "/x", method: "GET" });
  assert.equal(judge(b).ok, false);
  const c = clone(GOOD);
  delete c.steps.stranger;
  assert.equal(judge(c).ok, false);
});

test("a state with one more key, or a message of another kind, fails", () => {
  const a = clone(GOOD);
  const ev = a.messages.find((m) => m.data?.type === "state" && !m.data.id);
  ev.data.state.words = "x";
  assert.equal(judge(a).ok, false);
  const b = clone(GOOD);
  b.messages.push({ t: b.messages.at(-1).t, data: { v: 1, type: "debug", seed: "x" } });
  assert.equal(judge(b).ok, false);
});

// release9.chromium.<width>: the deployed SIGN_HOST at release-9 (pools in every signed-in state, packages/signpage/src/
// pools.ts withPools), live on Chromium: PASS. The same records replay FAIL on the check before this fix, whose hand
// copy of the state's keys knew no pools.
const signedInStates = (rec) =>
  rec.messages.flatMap((m) => (m.data?.type === "state" ? [m.data.state] : m.data?.ok === true && m.data.result?.signed_in !== undefined ? [m.data.result] : []))
    .filter((x) => x.signed_in === true);
for (const width of Object.keys(WIDTHS)) {
  test(`recorded live run on release-9 at ${width} width, pools in its signed-in states: PASS`, () => {
    const rec = ANSWERS.release9.chromium[width];
    assert.match(rec.source, /^live https:\/\/confidential\.unrealized\.trade/);
    const r = judge(rec);
    assert.equal(r.ok, true, r.lines.join("\n"));
    const ins = signedInStates(rec);
    assert.ok(ins.length >= 3 && ins.every((x) => Array.isArray(x.pools)), "every signed-in state holds pools");
  });
}

test("release-9: a signed-in state with a key the kit does not know, a pool the kit refuses, or pools signed out: FAIL", () => {
  const signedInAnswer = (a) => a.messages.find((m) => m.data?.ok === true && m.data.result?.signed_in === true && Array.isArray(m.data.result.pools));
  const unknown = clone(ANSWERS.release9.chromium.phone);
  signedInAnswer(unknown).data.result.extra = 1;
  assert.equal(judge(unknown).ok, false);
  assert.ok(judge(unknown).lines.some((l) => l.startsWith("BAD every message is ready")), judge(unknown).lines.join("\n"));
  const refused = clone(ANSWERS.release9.chromium.phone);
  signedInAnswer(refused).data.result.pools = [{ chain: "solana", asset: "ETH", balance: "1" }];
  assert.equal(judge(refused).ok, false);
  assert.ok(judge(refused).lines.some((l) => l.startsWith("BAD every message is ready")));
  const out = clone(ANSWERS.release9.chromium.phone);
  const first = out.messages.find((m) => m.data?.id === out.steps.first.id);
  first.data.result.pools = [];
  const lines = judge(out).lines;
  assert.ok(lines.some((l) => l.startsWith("BAD the first state answer is exactly the signed-out state")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("BAD every message is ready")));
});

test("the shell's layer left open over the frame after the sign-in fails", () => {
  const a = clone(GOOD);
  a.steps.words.top.layerHidden = false;
  assert.equal(judge(a).ok, false);
});

const answerTo = (rec, id) => rec.messages.find((m) => m.data?.id === id && m.data.ok === true);

test("the shell reloaded while signed in: a frame reading signed out, another way or code_saved false, the layer open, or no reload fails", () => {
  const cases = {
    "signed out": (a) => (answerTo(a, a.steps.reload.id).data.result.signed_in = false),
    "way passkey": (a) => (answerTo(a, a.steps.reload.id).data.result.way = "passkey"),
    "code_saved false": (a) => (answerTo(a, a.steps.reload.id).data.result.code_saved = false),
    "layer open": (a) => (a.steps.reload.top.layerHidden = false),
    "no reload": (a) => delete a.steps.reload,
  };
  for (const [name, change] of Object.entries(cases)) {
    const a = clone(GOOD);
    change(a);
    assert.equal(judge(a).ok, false, name);
  }
});

test("with the status deleted raw, a frame answering a way or code_saved true fails", () => {
  for (const [k, v] of [["way", "words"], ["code_saved", true]]) {
    const a = clone(GOOD);
    answerTo(a, a.steps.statusGone.id).data.result[k] = v;
    assert.equal(judge(a).ok, false, k);
  }
});

test("the backfill: a frame still without its way fails; the full state in an event within EVENT_MS of the answer passes, a later one fails", () => {
  const full = clone(answerTo(GOOD, GOOD.steps.reload.id).data.result);
  const strip = () => {
    const a = clone(GOOD);
    const b = answerTo(a, a.steps.backfill.id);
    delete b.data.result.way;
    b.data.result.code_saved = false;
    a.messages = a.messages.filter((m) => !(m.t >= b.t && m.data?.type === "state" && !m.data.id && m.data.state?.way === "words"));
    return { a, b };
  };
  const none = strip();
  assert.equal(judge(none.a).ok, false);
  for (const [ms, ok] of [[500, true], [EVENT_MS + 1, false]]) {
    const { a, b } = strip();
    a.messages.push({ t: b.t + ms, data: { v: 1, type: "state", state: clone(full) } });
    a.messages.sort((x, y) => x.t - y.t);
    const r = judge(a);
    assert.equal(r.ok, ok, `${ms} ms\n${r.lines.join("\n")}`);
  }
});

test("the review's fixes, each undone in the good run: FAIL", () => {
  const ref = (a, id) => answerTo(a, id) ?? a.messages.find((m) => m.data?.id === id);
  const cases = {
    "the app got typed characters": (a) => (a.steps.wordsIn.typed.appChars = 3),
    "the shell's field lacks the words": (a) => (a.steps.wordsIn.typed.shellHasWords = false),
    "the frame kept under the open layer": (a) => (a.steps.wordsIn.layer.frames = 1),
    "signin.open refused": (a) => (ref(a, a.steps.wordsIn.openId).data = { v: 1, id: a.steps.wordsIn.openId, ok: false, error: { code: "not_allowed" } }),
    "the layer shown at open": (a) => (a.steps.open.top.layerHidden = false),
    "a sandbox with allow-top-navigation": (a) => (a.steps.open.attrs.sandbox += " allow-top-navigation"),
    "no sandbox": (a) => (a.steps.open.attrs.sandbox = null),
    "an allow attribute": (a) => (a.steps.open.attrs.allow = ""),
    "the top moved by the frame": (a) => (a.steps.topNav.href = "https://example.com/"),
    "nav not followed": (a) => (a.steps.nav.after = a.steps.nav.after.replace("holders", "trades")),
    "nav to another host answered ok": (a) => (ref(a, a.steps.nav.evilId).data = { v: 1, id: a.steps.nav.evilId, ok: true, result: {} }),
    "nav made a new frame": (a) => (a.steps.nav.frames = 2),
    "reload refused": (a) => (ref(a, a.steps.reload.reloadId).data = { v: 1, id: a.steps.reload.reloadId, ok: false, error: { code: "not_allowed" } }),
    "the reloaded frame at the old path": (a) => (a.steps.reload.frameHref = `https://ct-app.unrealized.trade${START}`),
  };
  for (const [name, change] of Object.entries(cases)) {
    const a = clone(GOOD);
    change(a);
    assert.equal(judge(a).ok, false, name);
  }
});

for (const engine of ["webkit", "chromium", "firefox"]) {
  test(`recorded bad run: this card's build before the review's fixes (ea785a4) on ${engine}: FAIL, the layer over the terminal signed out and signin.open, nav and reload refused`, () => {
    const r = judge(ANSWERS.prefix[engine]);
    assert.equal(r.ok, false);
    const b = bad(r).join("\n");
    assert.match(b, /^BAD signed out, the layer is hidden and the terminal shows \(signed-out, layer shown/m);
    assert.match(b, /^BAD signin\.open words: answered pending/m);
    assert.match(b, /^BAD nav /m);
    assert.match(b, /^BAD reload: /m);
  });
}

for (const engine of ["webkit", "chromium", "firefox"]) {
  test(`recorded bad run: ea785a4 on ${engine}: the app takes the typed words`, () => {
    const rec = ANSWERS.prefix[engine];
    assert.equal(rec.engine, engine);
    const r = judge(rec);
    assert.equal(r.ok, false);
    assert.ok(rec.steps.wordsIn.typed.appChars > 0, JSON.stringify(rec.steps.wordsIn.typed));
    assert.ok(bad(r).some((l) => /^BAD the 12 words typed while the app calls focus\(\) every 20 ms: the shell holds all of them, the app none \(shell not all, app [1-9]\d* characters\)$/.test(l)), r.lines.join("\n"));
  });
}

// Card sign-live-checks-read-a-pinned-page: PINNED_HOSTS is the mainnet page's own pinned-pool hosts, read from their
// sources, so a host the page adds or drops fails here before it fails a live run. Card
// sign-live-checks-name-evm-pool-hosts: the Base and Robinhood pools' list too (pool-testnet.ts MAINNET_POOL_RPCS, two
// per chain), the hosts a signed-in mainnet page reads each EVM pool on since both are pinned (release 119).
test("PINNED_HOSTS is exactly the hosts the page's sources name for the mainnet Solana, Base and Robinhood pools' reads", async () => {
  const src = (f) => readFileSync(path.join(HERE, "../..", f), "utf8");
  const one = (f, re) => {
    const m = re.exec(src(f));
    assert.ok(m, `${f}: ${re}`);
    return m.slice(1).map((u) => new URL(u).host);
  };
  // the NEAR pair through the kit's public entry: its rule names the mainnet list in order, fastnear's first, the
  // helper's FastNEAR seat (card near-quote-under-the-pace, on TRADE_HELPER's host) third and drpc's last
  const { nearPairRule } = await import("../../packages/kit/src/index.ts");
  const near = nearPairRule("mainnet").match(/https:\/\/[^\s,]+/g);
  assert.equal(near.length, 4, nearPairRule("mainnet"));
  assert.equal(new URL(near[2]).host, new URL(one("packages/signpage/src/trade.ts", /export const TRADE_HELPER = "([^"]+)"/).map((h) => `https://${h}`)[0]).host);
  const want = [
    ...one("packages/signpage/src/trade.ts", /export const TRADE_HELPER = "([^"]+)"/),
    ...one("packages/signpage/src/trade.ts", /export const SOLANA_PROVIDER_A = "([^"]+)"/),
    // the public seat: provider A and its two spares (card signpage-throttled-provider-has-a-spare; the second since card
    // move-sends-or-says-why), exactly, so a member the seat adds fails here
    ...one("packages/signpage/src/trade.ts", /export const SOLANA_PUBLIC_SEAT: readonly string\[\] = Object\.freeze\(\[SOLANA_PROVIDER_A, "([^"]+)", "([^"]+)"\]\);/),
    ...one("packages/signpage/src/pool-restore.ts", /export const RESTORE_UX_SOLANA = Object\.freeze\(\["([^"]+)", "([^"]+)"\]/),
    new URL(near[0]).host,
    new URL(near[3]).host,
    // each EVM pool's list on mainnet: Base's two, Robinhood's two seats and its spare (card first-sign-in-reads-fast),
    // exactly, so a host the page adds fails here
    ...one("packages/signpage/src/pool-testnet.ts", /export const MAINNET_POOL_RPCS: [^=]+= \/\* @__PURE__ \*\/ Object\.freeze\(\{\n {2}base: \/\* @__PURE__ \*\/ Object\.freeze\(\["([^"]+)", "([^"]+)"\]\),\n {2}robinhood: \/\* @__PURE__ \*\/ Object\.freeze\(\["([^"]+)", "([^"]+)", "([^"]+)"\]\),\n\}\);/),
    // card restore-check-names-fee-hosts: each EVM pool's fee list on mainnet, four per chain (a restore holds the
    // period's fee on it: evmPoolOf marks a deposit in sight), so a fifth host the page adds fails here
    ...one("packages/signpage/src/pool-testnet.ts", /export const MAINNET_EVM_FEE_RPCS: [^=]+= \/\* @__PURE__ \*\/ Object\.freeze\(\{\n {2}base: \/\* @__PURE__ \*\/ Object\.freeze\(\["([^"]+)", "([^"]+)", "([^"]+)", "([^"]+)"\]\),\n {2}robinhood: \/\* @__PURE__ \*\/ Object\.freeze\(\["([^"]+)", "([^"]+)", "([^"]+)", "([^"]+)"\]\),\n\}\);/),
  ];
  assert.deepEqual([...PINNED_HOSTS].sort(), [...new Set(want)].sort());
  // the mainnet page reads each EVM pool on that list (the testnet build on its testnet pair)
  assert.match(src("packages/signpage/src/pool-testnet.ts"), /export const pageEvmPoolUrls = \(chain: "base" \| "robinhood"\): readonly string\[\] => \(POOL_TESTNET \? TESTNET_RPCS\[chain\] : MAINNET_POOL_RPCS\[chain\]\);/);
  // and each EVM pool's fee on that list (the testnet build on its testnet pair)
  assert.match(src("packages/signpage/src/pool-testnet.ts"), /export const pageEvmFeeRpcs = \(chain: "base" \| "robinhood", kind: ReadKind = "trade"\): readonly EvmRpc\[\] => \(POOL_TESTNET \? TESTNET_EVM_FEE_RPCS\[chain\] : MAINNET_EVM_FEE_RPCS\[chain\]\)\.map\(/);
  // the mainnet pair: the public seat (provider A, then its spare) and the helper's route, both paced, nothing else; each
  // with its read's kind (and the helper's its retry: the page's, or a settle's window)
  assert.match(src("packages/signpage/src/pool-testnet.ts"), /: \[solanaPacedRpc\(seatRpc\(SOLANA_PUBLIC_SEAT, kind\)\), solanaPacedRpc\(pageHelperRpc\(TRADE_HELPER, SOLANA_RPC(?:_WINDOW)?_RETRY, kind\)\)\];/);
  assert.match(src("packages/signpage/src/pool-restore.ts"), /return \{ rpcs: \(\) => \[relayRpc\(net\.fastnear\[0\]\), relayRpc\(net\.drpc\)\] \};/);
  // and each is in the page's own connect-src as committed
  const csp = /Content-Security-Policy: (.+)/.exec(src("packages/signpage/public/_headers"))[1];
  for (const h of PINNED_HOSTS) assert.ok(connectHosts(csp).includes(h), h);
});

// release111.<engine>.<width>: the live page on release 111 (main 1de76548, the mainnet Solana pool pinned), recorded
// by this card's check: signed out it asks no host but the two; signed in it reads the pool, its price, the Rent and the
// restore's first reads on PINNED_HOSTS, each named by its served connect-src: PASS. Planted from them: a pinned host
// asked signed out (the price, or a read naming a wallet), at no known time, or not in the connect-src; a host that is
// in the connect-src but not pinned; any third host: FAIL.
const RELEASE111 = Object.entries(ANSWERS.release111).flatMap(([engine, ws]) => Object.entries(ws).map(([width, rec]) => ({ engine, width, rec })));
for (const { engine, width, rec } of RELEASE111) {
  test(`recorded live run on release 111 (${engine}, ${width}): PASS, with signed-in reads on the pinned hosts and none signed out`, () => {
    assert.match(rec.source, /^live https:\/\/confidential\.unrealized\.trade/);
    const r = judge(rec);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.ok(rec.requests.some((x) => PINNED_HOSTS.includes(x.host)), "the pinned page read its pool");
    assert.ok(r.lines.some((l) => /^ok  signed out, no request goes past SIGN_HOST and APP_HOST; signed in, only to a pinned pool's host the page's own connect-src names \(0 signed out; [1-9]\d* signed in to /.test(l)), r.lines.join("\n"));
  });
}

test("release 111 planted: a pinned host asked signed out, at no time, or not in the connect-src; an unpinned or third host: FAIL", () => {
  const { rec: g } = RELEASE111.find((x) => x.engine === "chromium");
  const read = g.requests.find((x) => PINNED_HOSTS.includes(x.host));
  const at = (t, over = {}) => {
    const r = clone(g);
    r.requests.push({ ...clone(read), t, ...over });
    return judge(r);
  };
  const st = g.steps;
  const badLine = (j, re) => {
    assert.equal(j.ok, false, j.lines.join("\n"));
    assert.ok(j.lines.some((l) => l.startsWith("BAD") && re.test(l)), j.lines.join("\n"));
  };
  const out = /^BAD signed out, no request goes past SIGN_HOST and APP_HOST; signed in, only to a pinned pool's host the page's own connect-src names \(1 signed out/;
  badLine(at(st.created.t - 1), out); // before Create passkey
  badLine(at(st.passkeyOut.t + 1), out); // after the passkey's sign out
  badLine(at(st.words.t - 1), out); // before the words' Continue
  badLine(at(st.wordsOut.t + 1), out); // after the words' sign out
  // card sign-out-stops-the-pages-reads: the sign out's time is the post's acknowledgement; a request from that time on
  // is signed out, one just before it signed in
  badLine(at(st.wordsOut.t), out);
  assert.equal(at(st.wordsOut.t - 1).ok, true, at(st.wordsOut.t - 1).lines.join("\n"));
  badLine(at(st.stranger.t + 1, { host: "rpc.mainnet.fastnear.com", path: "/", rpc: [{ method: "query", params: { request_type: "view_account", account_id: "a".repeat(64), finality: "final" } }] }), out); // an account id, signed out
  badLine(at(undefined), out); // at no known time
  const noCsp = clone(g);
  noCsp.connect = noCsp.connect.filter((h) => h !== read.host);
  badLine(judge(noCsp), new RegExp(`not in its connect-src: ${read.host.replaceAll(".", "\\.")}`));
  const none = clone(g);
  none.connect = null;
  assert.equal(judge(none).ok, false);
  for (const host of ["api.mainnet-beta.solana.com", "sender.helius-rpc.com", "evil.example"]) badLine(at(st.words.t + 1, { host }), new RegExp(`^BAD no request leaves SIGN_HOST and APP_HOST but for the pinned pool's hosts \\(1: ${host.replaceAll(".", "\\.")}`));
});

// Card sign-live-checks-name-evm-pool-hosts: release119.<engine>.<width>, the live page on release 119 (main f9cffd25,
// the Base and Robinhood pools pinned on mainnet too), recorded by this check with their lists' four hosts pinned, 12
// Nov: signed in it reads each EVM pool on them, each named by its served connect-src, and signed out none: PASS.
// Before this card the same reads were the 98 stray requests of live run 43184299402. Planted from them: an EVM host
// the connect-src names that no pin reads on, a pinned EVM host asked signed out or not in the connect-src: FAIL.
const EVM_HOSTS = ["base-rpc.publicnode.com", "base.api.pocket.network", "rpc.mainnet.chain.robinhood.com", "robinhood.api.pocket.network"];
const RELEASE119 = Object.entries(ANSWERS.release119).flatMap(([engine, ws]) => Object.entries(ws).map(([width, rec]) => ({ engine, width, rec })));
for (const { engine, width, rec } of RELEASE119) {
  test(`recorded live run on release 119 (${engine}, ${width}): PASS, with signed-in reads on the EVM pools' hosts and none signed out`, () => {
    assert.match(rec.source, /^live https:\/\/confidential\.unrealized\.trade/);
    const r = judge(rec);
    assert.equal(r.ok, true, r.lines.join("\n"));
    for (const h of EVM_HOSTS) assert.ok(rec.requests.some((x) => x.host === h), `the page read an EVM pool on ${h}`);
    assert.ok(r.lines.some((l) => /^ok  signed out, no request goes past SIGN_HOST and APP_HOST; signed in, only to a pinned pool's host the page's own connect-src names \(0 signed out; [1-9]\d* signed in to /.test(l)), r.lines.join("\n"));
  });
}

test("release 119 planted: an EVM host no pin names, a pinned EVM host signed out or not in the connect-src: FAIL", () => {
  const { rec: g } = RELEASE119.find((x) => x.engine === "chromium");
  const st = g.steps;
  const badLine = (j, re) => {
    assert.equal(j.ok, false, j.lines.join("\n"));
    assert.ok(j.lines.some((l) => l.startsWith("BAD") && re.test(l)), j.lines.join("\n"));
  };
  for (const h of EVM_HOSTS) {
    const read = g.requests.find((x) => x.host === h);
    // signed out: before the words' Continue, and after their sign out
    for (const t of [st.words.t - 1, st.wordsOut.t + 1]) {
      const r = clone(g);
      r.requests.push({ ...clone(read), t });
      badLine(judge(r), /^BAD signed out, no request goes past SIGN_HOST and APP_HOST; signed in, only to a pinned pool's host the page's own connect-src names \(1 signed out/);
    }
    const noCsp = clone(g);
    noCsp.connect = noCsp.connect.filter((x) => x !== h);
    badLine(judge(noCsp), new RegExp(`not in its connect-src: ${h.replaceAll(".", "\\.")}\\)$`));
  }
  // the quote list's hosts, in the connect-src but no pin's: stray even signed in (the fee list's are pinned since card
  // restore-check-names-fee-hosts, held signed out below)
  const read = g.requests.find((x) => x.host === EVM_HOSTS[0]);
  for (const host of ["base-mainnet.public.blastapi.io", "base.rpc.blxrbdn.com", "robinhood.rpc.blxrbdn.com"]) {
    assert.ok(g.connect.includes(host), `${host} is in the served connect-src`);
    const r = clone(g);
    r.requests.push({ ...clone(read), t: st.words.t + 1, host });
    badLine(judge(r), new RegExp(`^BAD no request leaves SIGN_HOST and APP_HOST but for the pinned pool's hosts \\(1: ${host.replaceAll(".", "\\.")}\\)$`));
  }
  // card restore-check-names-fee-hosts: a fee list host signed in passes; signed out, or not in the connect-src, fails
  for (const host of ["mainnet.base.org", "base.gateway.tenderly.co", "robinhood.drpc.org", "robinhood-rpc.publicnode.com"]) {
    assert.ok(g.connect.includes(host), `${host} is in the served connect-src`);
    const ok = clone(g);
    ok.requests.push({ ...clone(read), t: st.words.t + 1, host });
    assert.equal(judge(ok).ok, true, judge(ok).lines.join("\n"));
    const out = clone(g);
    out.requests.push({ ...clone(read), t: st.wordsOut.t + 1, host });
    badLine(judge(out), /^BAD signed out, no request goes past SIGN_HOST and APP_HOST; signed in, only to a pinned pool's host the page's own connect-src names \(1 signed out/);
    const noCsp = clone(ok);
    noCsp.connect = noCsp.connect.filter((x) => x !== host);
    badLine(judge(noCsp), new RegExp(`not in its connect-src: ${host.replaceAll(".", "\\.")}\\)$`));
  }
});

// card sign-out-stops-the-pages-reads: a landed sign out reloads the top window, and no request after the words' sign out
// names that account
const RELOAD = ANSWERS.reload.chromium.phone;
test("recorded run on card sign-out-stops-the-pages-reads's build (chromium, phone): PASS, each sign out reloads the top window and its new frame answers signed out", () => {
  const r = judge(RELOAD);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const start of [
    "ok  Sign out in this tab, by its own Sign out button: the top window reloads and its new frame answers exactly signed out (signout answered pending, signed-out, a new document",
    "ok  Sign out in another tab: the top window reloads and its new frame answers exactly signed out (signed-out, a new document",
    "ok  a second passkey account lands after it",
    "ok  the second passkey account's Sign out in this tab: the top window reloads",
    "ok  after the words' account signs out and a second account lands, no request names the words' account",
  ]) assert.ok(r.lines.some((l) => l.startsWith(start)), `${start}\n${r.lines.join("\n")}`);
});

test("sign-out-stops-the-pages-reads planted: no reload, a late or a signed-in new frame, the tap not this tab's, or a later request naming the words' account: FAIL", () => {
  const st = RELOAD.steps;
  const badLine = (rec, re) => {
    const j = judge(rec);
    assert.equal(j.ok, false, j.lines.join("\n"));
    assert.ok(j.lines.some((l) => l.startsWith("BAD") && re.test(l)), `${re}\n${j.lines.join("\n")}`);
  };
  const thisTab = /^BAD Sign out in this tab, by its own Sign out button: the top window reloads/;
  // no new document after the tap: the page stayed (a build before the card)
  let r = clone(RELOAD);
  r.steps.passkeyOut.doc = null;
  badLine(r, thisTab);
  // the new frame's ready past RELOAD_MS
  r = clone(RELOAD);
  r.steps.passkeyOut.t = r.steps.passkeyOut.doc - RELOAD_MS - 1;
  badLine(r, thisTab);
  // the new frame answers signed in
  r = clone(RELOAD);
  r.messages.find((m) => m.data?.id === st.passkeyOut.id).data.result.signed_in = true;
  badLine(r, thisTab);
  // made by another tab's post, not this tab's button
  r = clone(RELOAD);
  r.steps.passkeyOut.by = "channel";
  badLine(r, thisTab);
  // the other tab's sign out with no new document
  r = clone(RELOAD);
  r.steps.wordsOut.doc = null;
  badLine(r, /^BAD Sign out in another tab: the top window reloads/);
  // the second account's own sign out, its signout refused
  r = clone(RELOAD);
  r.messages.find((m) => m.data?.id === st.passkeyOut2.openId).data.result = { pending: false };
  badLine(r, /^BAD the second passkey account's Sign out in this tab/);

  // the words' account's names: on this harness run its reads were refused before the walk named any (0), so they are
  // planted from release 119's live run, whose walk read the vault's Solana accounts
  const names = /^BAD after the words' account signs out and a second account lands, no request names the words' account/;
  const live = ANSWERS.release119.chromium.phone;
  const walk = live.requests.find((x) => x.host === "solana-rpc.publicnode.com" && x.rpc?.[0]?.method === "getMultipleAccounts" && x.t >= live.steps.words.t && namesIn(x).some((n) => !JSON.stringify(RELOAD.requests).includes(n)));
  assert.ok(walk, "release 119 holds a walk read of the words' account");
  const own = (rec) => ({ ...clone(walk), t: rec.steps.words.t + 1 });
  // read in the words' window, then again after its sign out (in the second account's): BAD
  for (const t of [st.wordsOut.doc, st.created2.t + 1, st.passkeyOut2.t - 1]) {
    r = clone(RELOAD);
    r.requests.push(own(r), { ...clone(walk), t });
    badLine(r, names);
  }
  // the same name on another host after the sign out: BAD
  r = clone(RELOAD);
  r.requests.push(own(r), { ...clone(walk), t: st.created2.t + 1, host: "ct-api.unrealized.trade", path: "/v1/rpc/solana" });
  badLine(r, names);
  // read only in the words' window: ok
  r = clone(RELOAD);
  r.requests.push(own(r));
  assert.ok(judge(r).lines.some((l) => /^ok  after the words' account signs out and a second account lands, no request names the words' account \([1-9]\d* of its addresses and ids; \d+ requests after its sign out, 0 naming one\)$/.test(l)), judge(r).lines.join("\n"));
  // a name the first account's requests carried too is not the words' account's: ok
  r = clone(RELOAD);
  r.requests.push({ ...clone(walk), t: st.created.t + 1 }, own(r), { ...clone(walk), t: st.created2.t + 1 });
  assert.ok(!judge(r).lines.some((l) => names.test(l)), judge(r).lines.join("\n"));
  // a live run whose words' account named nothing: BAD (nothing was checked)
  r = clone(RELOAD);
  r.source = "live https://confidential.unrealized.trade";
  badLine(r, names);
});

// card ci-stops-costing-reruns (CI run 43419178373, test-browser 3, attempt 1): the words' open is answered first and
// the frame taken out after (src/api.ts `then`, src/shell.ts seal), so on a loaded runner the frame's document can go
// before it reads the answer: "no answer, layer open, 0 frames". src/shell.ts says so ("may reach the app before it
// leaves; nothing waits on it"). That run passes; an answer that came and is not pending, the frame kept or the layer
// closed still fail.
test("the words' open whose answer the frame never read (it left first): PASS; with the frame kept, the layer closed or a wrong answer: FAIL", () => {
  const unread = () => {
    const rec = clone(ANSWERS.closes.chromium.phone);
    const id = rec.steps.wordsIn.openId;
    const n = rec.messages.length;
    rec.messages = rec.messages.filter((m) => m.data?.id !== id);
    assert.equal(rec.messages.length, n - 1, "one answer to the words' open in the record");
    return rec;
  };
  const r = judge(unread());
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^ok  signin\.open words: answered pending, or not at all once the frame left first; the layer opens and the frame leaves the document \(no answer, layer open, 0 frames\)$/.test(l)), r.lines.join("\n"));
  const words = /^BAD signin\.open words: answered pending/;
  const kept = unread();
  kept.steps.wordsIn.layer.frames = 1;
  const closed = unread();
  closed.steps.wordsIn.layer.layerHidden = true;
  for (const rec of [kept, closed]) {
    const j = judge(rec);
    assert.equal(j.ok, false, j.lines.join("\n"));
    assert.ok(j.lines.some((l) => words.test(l)), j.lines.join("\n"));
  }
});

// card signing-layer-says-when-it-closes (kit 1.13): an open kind answers { pending: true, closes: true } to an app whose
// hello names 1.13, and the layer's close may post one { v: 1, type: "closed", id } for it. closes.chromium.phone: this
// tree's build on the harness (13 Nov, Chrome 156): PASS. release128.<engine>.phone: the live page on release 128: PASS.
// Then cases planted on the harness run.
const CLOSES = ANSWERS.closes.chromium.phone;
test("recorded runs on release 128's answers (the harness at this tree; the live page on Chromium and Firefox): PASS, each open answered pending with closes", () => {
  for (const [name, rec] of [["closes.chromium.phone", CLOSES], ["release128.chromium.phone", ANSWERS.release128.chromium.phone], ["release128.firefox.phone", ANSWERS.release128.firefox.phone]]) {
    const r = judge(rec);
    assert.equal(r.ok, true, `${name}\n${r.lines.join("\n")}`);
    const opens = rec.messages.filter((m) => m.data?.ok === true && m.data.result?.pending === true);
    // Chromium: the two passkey opens, their two sign outs and the words; Firefox (no virtual authenticator): the words
    assert.ok(opens.length === (rec.engine === "chromium" ? 5 : 1) && opens.every((m) => JSON.stringify(m.data.result) === '{"pending":true,"closes":true}'), `${name}: ${opens.length} opens`);
  }
  assert.match(ANSWERS.release128.chromium.phone.source, /^live https:\/\/confidential\.unrealized\.trade$/);
  assert.equal(ANSWERS.release128.firefox.phone.engine, "firefox");
});

test("release 128 planted: an open answered closes false, closes not true, an extra key or not pending, a stray or second closed notice: FAIL", () => {
  const st = CLOSES.steps;
  const badLine = (rec, re) => {
    const j = judge(rec);
    assert.equal(j.ok, false, j.lines.join("\n"));
    assert.ok(j.lines.some((l) => l.startsWith("BAD") && re.test(l)), `${re}\n${j.lines.join("\n")}`);
  };
  const okLine = (rec, re) => {
    const j = judge(rec);
    assert.equal(j.ok, true, j.lines.join("\n"));
    assert.ok(j.lines.some((l) => l.startsWith("ok ") && re.test(l)), `${re}\n${j.lines.join("\n")}`);
  };
  const setResult = (rec, id, result) => {
    const a = rec.messages.find((m) => m.data?.id === id && m.data.ok === true);
    assert.ok(a, `an answer to ${id}`);
    a.data.result = result;
    return rec;
  };
  const passkey = /^BAD signin\.open passkey: answered pending, the layer opens/;
  const words = /^BAD signin\.open words: answered pending/;
  const thisTab = /^BAD Sign out in this tab, by its own Sign out button: the top window reloads/;
  for (const result of [{ pending: true, closes: false }, { pending: true, closes: "true" }, { pending: true, closes: 1 }, { pending: true, closes: true, extra: true }, { pending: true, extra: true }, { pending: false, closes: true }, { closes: true }]) {
    badLine(setResult(clone(CLOSES), st.passkeyIn.openId, result), passkey);
    badLine(setResult(clone(CLOSES), st.wordsIn.openId, result), words);
    badLine(setResult(clone(CLOSES), st.passkeyOut.openId, result), thisTab);
  }
  // the answer before kit 1.13 still counts: { pending: true }
  okLine(setResult(clone(CLOSES), st.passkeyIn.openId, { pending: true }), /^ok  signin\.open passkey: answered pending/);
  // one closed notice for an open answered closes: taken; a second for it, one for an id no open answered closes, or one
  // with another key: another message
  const every = /^BAD every message is ready, an answer, a state event or one closed notice/;
  const notice = (rec, data) => (rec.messages.push({ t: st.saved.t + 600, data }), rec);
  okLine(notice(clone(CLOSES), { v: 1, type: "closed", id: st.passkeyIn.openId }), /^ok  every message is ready, an answer, a state event or one closed notice for an open answered closes, each state exact \(\d+ states, 1 closed, 0 other\)$/);
  badLine(notice(notice(clone(CLOSES), { v: 1, type: "closed", id: st.passkeyIn.openId }), { v: 1, type: "closed", id: st.passkeyIn.openId }), every);
  badLine(notice(clone(CLOSES), { v: 1, type: "closed", id: st.first.id }), every);
  badLine(notice(clone(CLOSES), { v: 1, type: "closed", id: "no-such-open" }), every);
  badLine(notice(clone(CLOSES), { v: 1, type: "closed", id: st.passkeyIn.openId, result: {} }), every);
  badLine(notice(setResult(clone(CLOSES), st.passkeyIn.openId, { pending: true }), { v: 1, type: "closed", id: st.passkeyIn.openId }), every);
});
