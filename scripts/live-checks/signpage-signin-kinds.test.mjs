// node --test scripts/live-checks/signpage-signin-kinds.test.mjs: the live check's verdict on its recorded answers, with
// no browser and no network. Every record but liveGood is a real run on the browser harness (SIGN_HOST's and APP_HOST's real names
// mapped to it, SIGN_HOST's build under its own _headers and the APP_HOST stand-in under the terminal's), but the two
// marked edited. good: this tree's page on the harness with the step where the frame takes the signed-in state
// (pools included), which passes; liveGood: the deployed SIGN_HOST at release-9 framing the deployed terminal, whose
// own kit client is ready on that state, which passes, and edited from it, the step's bads (the client down or never
// settled, a state the kit refuses, no pools, no state). Each bad fails on its own lines only:
// - good was recorded, unedited, with card signing-views-open-over-the-app on the harness, which maps every outside
//   name to not found: its console lines for those names are not counted on a harness run (HARNESS_UNRESOLVED), and
//   badMainNoSheet (main 8253c0a3, the same harness, unedited) fails the sheet's line only; good was recorded again
//   (12 Nov) once the 12 words shown took the frame out (the review of 7a21ffcd, P2-2), the answer before it kept as
//   goodKeptUnderWords, which fails the sheet's line only;
// - badPageOfItsOwn: the good of this tree before card signing-views-open-over-the-app, each screen a page of its own
//   with the frame taken out of the document: fails on the sheet's line only. Every record but good was recorded before
//   that card, so the sheet's line is read on good and on badPageOfItsOwn alone (the others are read on their own lines);
// - bad: the card's page at efacb58, before the recheck's Lows (an open sent during a resync refused; Cancel stuck on
//   the error page when the stored seed cannot be read);
// - badDcad6c9: the card's page at dcad6c9, before the review fixes (Create passkey offered after I already have one,
//   and a tab loaded signed out refusing backup.open after another tab's sign-in);
// - badMain: main 89cd22c's page (no signout, backup.open or wallet choices);
// - badSeedBeforeChoice: a planted page whose wallet way makes a seed before it draws the two choices (the brief's bad);
// - badFramable: the page served without frame-ancestors 'none' (SIGN_HOST loads in a frame; the brief's other bad);
// - badM1a, badM3b: the review's mutants (signin.open taken with a seed stored; no activation-guard restart at all);
// - badFrameSrc (edited): the frame never loaded but no frame-ancestors refusal was read, as dcad6c9's check ran under
//   APP_HOST's frame-src 'none'; badLoadedReported (edited): SIGN_HOST loaded though a refusal was reported;
//   badPressNeverLanded (edited): the early click never landed, which the old check read as ok.
// Card sign-out-checks-read-the-store-after-the-reload: good re-recorded on main 6430cba10 (release 126, whose sign out
// deletes the database and reloads into a fresh store), its sign outs read after the reload; goodNov11 the good before
// it; badKeepsStore a scratch copy of 6430cba10 whose sign out skips deleteDatabase. A record with no store read is
// judged at the reading it was cut at (SIGN_OUT_BEFORE_RELOAD).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HARNESS_UNRESOLVED, judge as judgeNow, keptAfterSignOut, SIGN_OUT_BEFORE_RELOAD, watch } from "./signpage-signin-kinds.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// card sign-out-checks-read-the-store-after-the-reload: a record cut before it holds no store read after its sign outs
// and is judged at the reading then (the database gone, SIGN_OUT_BEFORE_RELOAD); every record with one, and every run
// now, by the store after the page's reload
const cutBefore = (rec) => !rec?.prf?.signout?.after?.store && !rec?.noPrf?.after?.store;
const judge = (rec, era) => judgeNow(rec, era ?? (cutBefore(rec) ? SIGN_OUT_BEFORE_RELOAD : undefined));
const answers = JSON.parse(readFileSync(path.join(HERE, "signpage-signin-kinds.answers.json"), "utf8"));
const BAD_ALL = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0].slice(4));
// The terminal-takes-the-state step came after most bads were recorded: a record with no prf.app step was recorded
// before it, and is read on its other lines (the step's own bads are below, and a good with the step deleted is BAD).
const APP = "prf: the terminal in the frame takes the signed-in state with pools";
// The sheet's line (card signing-views-open-over-the-app) came after every record but good: read on good alone.
const SHEET = "the sheet keeps the app's frame in the page under every screen it draws but the 12 words, and takes it out under those and after them";
const BAD = (rec) => BAD_ALL(rec).filter((l) => (l !== APP || Object.hasOwn(rec.prf ?? {}, "app")) && (l !== SHEET || rec === answers.good));

const FRAMED = "prf: a signout sent to SIGN_HOST in a frame is refused, the frame never loads a sign-out";
const AGAIN = "prf: signin.open sent signed in is refused, the seed kept";
const EARLY = "prf: a press on Sign out within 500 ms of the page opening does nothing";
const SO_PAGE = "prf: signout opens the sign-out page top-level only";
const CHOICES = "wallet: signin.open {way: wallet} on an empty store draws the two choices";
const NO_SEED = "wallet: no wallet request and no seed before the choice";
const EXISTING = "wallet: I already have one draws Use passkey and Recovery code, no wallet request, no seed";
const NO_CREATE = "wallet: Use passkey there with no PRF makes nothing and offers the passkey and the 12 words, never Create passkey";
const TWO_TABS = "two tabs: a backup.open sent while tab A reads tab B's new seed waits for the read and is taken";
const BROKEN = "broken store: Cancel goes back to the app when the stored seed cannot be read";

test("the recorded good answer passes", () => {
  const r = judge(answers.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
  assert.equal(answers.good.mode, "harness");
  assert.ok(answers.good.prf.framed.refusals >= 1);
  assert.ok(Array.isArray(answers.good.prf.app.state.pools));
});

test("the card's page at 7a21ffcd, the frame kept under the 12 words (the review's P2-2), unedited: fails on the sheet's line only", () => {
  const r = judge(answers.goodKeptUnderWords);
  assert.equal(r.pass, false);
  assert.deepEqual(BAD_ALL(answers.goodKeptUnderWords), [SHEET], r.lines.join("\n"));
  assert.ok(r.lines.includes(`BAD ${SHEET} (7 of 7 kept, 0 of 4 out)`), r.lines.join("\n"));
});

test("a page of its own over no frame (this tree before card signing-views-open-over-the-app) fails on the sheet's line only", () => {
  assert.deepEqual(BAD_ALL(answers.badPageOfItsOwn), [SHEET]);
  assert.equal(answers.badPageOfItsOwn.prf.signin.page.frame, false);
  assert.equal(answers.good.prf.signin.page.frame, true);
});

test("main 8253c0a3 on the same harness as good (11 Nov), unedited: fails on the sheet's line only", () => {
  const r = judge(answers.badMainNoSheet);
  assert.deepEqual(BAD_ALL(answers.badMainNoSheet), [SHEET], r.lines.join("\n"));
  assert.ok(answers.badMainNoSheet.errors.length > 0 && answers.badMainNoSheet.errors.every((e) => HARNESS_UNRESOLVED.test(e)));
});

test("the harness's unresolved outside names are not the page's errors on a harness run only: any other line, or the same on the live host, fails", () => {
  const good = answers.good;
  assert.equal(good.mode, "harness");
  assert.ok(!("edited" in good), "good is the run as recorded");
  assert.ok(good.errors.length > 0 && good.errors.every((e) => HARNESS_UNRESOLVED.test(e)), "good's console holds only the harness's unresolved names");
  const r = judge(good);
  assert.ok(r.lines.includes(`ok  no page error or CSP violation (0)`), r.lines.join("\n"));
  assert.ok(r.lines.includes(`ok  harness: ${good.errors.length} console line(s) for outside names it leaves unresolved, not counted`));
  // planted: the same lines on the live host
  const live = structuredClone(good);
  live.mode = "live";
  assert.ok(judge(live).lines.some((l) => l.startsWith(`BAD no page error or CSP violation (${good.errors.length}):`)));
  // planted: another failure to load on the harness, a resolved name's 404 and an unresolved line with more after it
  for (const line of ["console: Failed to load resource: the server responded with a status of 404 () (https://confidential.unrealized.trade/x)", "console: Failed to load resource: net::ERR_NAME_NOT_RESOLVED (https://x.example/) and more", "console: Failed to load resource: net::ERR_CONNECTION_REFUSED (https://x.example/)",
    // the skip is pinned to SIGN_HOST's connect-src (as its skeleton check pins it): a name outside it, a name that only
    // starts like one in it, plain http, or no address at all is the page's error
    "console: Failed to load resource: net::ERR_NAME_NOT_RESOLVED (https://x.example/)",
    "console: Failed to load resource: net::ERR_NAME_NOT_RESOLVED (https://solana-rpc.publicnode.com.x.example/)",
    "console: Failed to load resource: net::ERR_NAME_NOT_RESOLVED (http://solana-rpc.publicnode.com/)",
    "console: Failed to load resource: net::ERR_NAME_NOT_RESOLVED"]) {
    const rec = structuredClone(good);
    rec.errors.push(line);
    assert.ok(judge(rec).lines.includes(`BAD no page error or CSP violation (1): ${line}`), `${line}: ${judge(rec).lines.join("\n")}`);
  }
});

test("the recorded live answer on release-9, before the sheet: the deployed terminal's client is ready on a state with pools", () => {
  const r = judge(answers.liveGood);
  assert.deepEqual(BAD_ALL(answers.liveGood), [SHEET], r.lines.join("\n"));
  assert.equal(answers.liveGood.mode, "live");
  assert.equal(answers.liveGood.prf.app.signpage, "ready");
  assert.ok(r.lines.includes(`ok  ${APP} (APP_HOST's client ready, signed_in true, pools ${answers.liveGood.prf.app.state.pools.length}, the kit takes it)`));
});

test("the terminal's step fails on a client down, a state the kit refuses, no pools, or no state (edited from the live good)", () => {
  const cases = {
    "the terminal's client went down": (a) => (a.prf.app.signpage = "down"),
    "the terminal's client never settled": (a) => (a.prf.app.signpage = null),
    "a key the kit does not know": (a) => (a.prf.app.state.extra = 1),
    "a pool the kit refuses": (a) => (a.prf.app.state.pools = [{ chain: "solana", asset: "ETH", balance: "1" }]),
    "no pools": (a) => delete a.prf.app.state.pools,
    "signed out": (a) => (a.prf.app.state.signed_in = false),
    "no state": (a) => (a.prf.app.state = null),
    "no frame": (a) => (a.prf.app = { noFrame: true }),
  };
  for (const [name, change] of Object.entries(cases)) {
    const a = structuredClone(answers.liveGood);
    change(a);
    assert.deepEqual(BAD(a), [APP], name);
  }
  // a harness record never stands in for the live client: the same record named live with no client read fails
  const h = structuredClone(answers.good);
  h.mode = "live";
  delete h.prf.app.signpage;
  // (and the harness's unresolved outside names, named live, count as the page's errors)
  assert.deepEqual(BAD(h), [APP, "no page error or CSP violation"]);
});

test("the card's page before the recheck's Lows fails: an open refused during a resync, Cancel stuck on a broken store", () => {
  assert.deepEqual(BAD(answers.bad), [TWO_TABS, BROKEN]);
  assert.equal(answers.bad.twoTabs.heldAtSend, true);
  assert.equal(answers.bad.twoTabs.backup.answer.error.code, "not_allowed");
});

test("the card's page before the review fixes fails: Create passkey after I already have one, a stale tab", () => {
  assert.deepEqual(BAD(answers.badDcad6c9), [NO_CREATE, TWO_TABS]);
});

test("an early press that never landed is BAD, never ok", () => {
  assert.deepEqual(BAD(answers.badPressNeverLanded), [EARLY]);
  assert.ok(answers.good.prf.signout.early.pressLanded && answers.good.prf.signout.early.pressMs < 500);
});

test("main 89cd22c's page fails: no backup.open, no signout page, no wallet choices", () => {
  assert.deepEqual(BAD(answers.badMain), [
    "prf: backup.open draws the 12 words of the account in the top window",
    "prf: Cancel on the backup goes back to the app signed in, the words gone",
    SO_PAGE,
    EARLY,
    "prf: Sign out deletes the store and goes back to the app signed out",
    "no-prf: signout with the words not saved draws the backup first, no Sign out",
    "no-prf: Saved goes on to the sign-out page",
    "no-prf: Sign out then deletes the store",
    CHOICES,
    NO_SEED,
    EXISTING,
    NO_CREATE,
    TWO_TABS,
  ]);
});

test("a wallet sign-in that makes a seed before the choice fails", () => {
  assert.deepEqual(BAD(answers.badSeedBeforeChoice), [NO_SEED, EXISTING, NO_CREATE]);
  assert.equal(answers.badSeedBeforeChoice.wallet.choose.seed, true);
});

test("a sign-out from inside a frame fails: SIGN_HOST loaded in a frame, a refusal never read, or both", () => {
  assert.deepEqual(BAD(answers.badFramable), [FRAMED]);
  assert.equal(answers.badFramable.prf.framed.loaded, true);
  assert.deepEqual(BAD(answers.badFrameSrc), [FRAMED]);
  assert.deepEqual([answers.badFrameSrc.prf.framed.loaded, answers.badFrameSrc.prf.framed.refusals], [false, 0]);
  assert.deepEqual(BAD(answers.badLoadedReported), [FRAMED]);
  assert.deepEqual([answers.badLoadedReported.prf.framed.loaded, answers.badLoadedReported.prf.framed.refusals], [true, 1]);
});

test("the review's mutants fail: signin.open taken signed in, and no guard restart", () => {
  assert.deepEqual(BAD(answers.badM1a), [AGAIN]);
  assert.deepEqual(BAD(answers.badM3b), [SO_PAGE, EARLY]);
});

test("a step that never ran is BAD, never ok, and a missing error list is BAD", () => {
  const rec = structuredClone(answers.good);
  delete rec.prf.framed;
  delete rec.prf.again;
  delete rec.prf.signout.early;
  delete rec.wallet.existingUse;
  delete rec.twoTabs;
  delete rec.broken;
  delete rec.prf.app;
  assert.deepEqual(BAD_ALL(rec), [APP, AGAIN, FRAMED, EARLY, NO_CREATE, TWO_TABS, BROKEN, SHEET]);
  const none = structuredClone(answers.good);
  delete none.errors;
  assert.deepEqual(BAD(none), ["no page error or CSP violation"]);
});

test("planted on the good answer: a recorded 429 names its resource's origin and path in the BAD line, and an error with no location still fails (card live-console-url)", () => {
  const text = "Failed to load resource: the server responded with a status of 429 ()";
  const hooks = {};
  const kept = [];
  watch({ on: (ev, f) => (hooks[ev] = f) }, kept);
  const msg = (t, location) => ({ type: () => "error", text: () => t, location: () => location });
  hooks.console(msg(text, { url: "https://ct-api.unrealized.trade/v1/relay/status?id=abc" }));
  hooks.console({ type: () => "warning", text: () => "a warning", location: () => ({ url: "https://x.example/" }) });
  hooks.console(msg("Uncaught boom", undefined));
  hooks.pageerror(new Error("boom"));
  assert.deepEqual(kept, [`console: ${text} (https://ct-api.unrealized.trade/v1/relay/status)`, "console: Uncaught boom", "pageerror: boom"]);
  for (const [line, want] of [
    [kept[0], `console: ${text} (https://ct-api.unrealized.trade/v1/relay/status)`],
    [kept[1], "console: Uncaught boom"],
    [kept[2], "pageerror: boom"],
  ]) {
    const rec = structuredClone(answers.good);
    rec.errors.push(line);
    const r = judge(rec);
    assert.equal(r.pass, false);
    assert.ok(r.lines.some((l) => l === `BAD no page error or CSP violation (1): ${want}`), r.lines.join("\n"));
    assert.ok(!r.lines.some((l) => l.includes("id=abc")), "no query in a line");
  }
});

test("every live check's harness serves SIGN_HOST as live does: a path with no file is the index, never a 404 (card sign-harness-like-live)", () => {
  // live SIGN_HOST answers /favicon.ico, /_headers and any other path with no file 200 with its index.html (curl 6 Nov
  // 13:20Z); a harness that answers 404 there reports a console error live never has
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const maps = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".mjs") && !x.endsWith(".test.mjs"))) {
    const text = readFileSync(path.join(dir, f), "utf8");
    for (const m of text.matchAll(/startServer\(\{[^\n]*\bsites: \{([^\n]*)\} \}\)/g)) if (m[1].includes("[SIGN_HOST]")) maps.push([f, m[1]]);
  }
  assert.ok(maps.length >= 2, `the harness host maps: ${maps.map(([f]) => f).join(", ")}`);
  for (const [f, m] of maps) assert.match(m, /\[SIGN_HOST\]: \{ root(?:: [\w.]+)?, spa: true \}/, `${f}: SIGN_HOST served without spa: true`);
});

// ------------------------------------------------------------------------------------------------ card sign-out-checks-read-the-store-after-the-reload
const SO_NOW = "prf: Sign out goes back to the app signed out, the store left with no account, no seed, no record and a new K_wrap, nothing in localStorage";
const NP_NOW = "no-prf: Sign out then leaves the store with nothing but a new K_wrap";

test("sign out is judged by the store after the page's reload: the good run (main 6430cba10, release 126) read every store empty but meta's k_wrap and lane, nothing in localStorage, the K_wrap before refused by the one after", () => {
  for (const a of [answers.good.prf.signout.after, answers.good.noPrf.after]) {
    assert.equal(a.store.reloaded, true, "read in the reload's new document");
    assert.deepEqual(a.store.metaKeys.sort(), ["k_wrap", "lane"]);
    assert.ok(Object.entries(a.store.stores).every(([n, c]) => (n === "meta" ? c === 2 : c === 0)), JSON.stringify(a.store.stores));
    assert.equal(a.store.localStorage, 0);
    assert.equal(a.store.oldKey, "refused");
    assert.deepEqual(keptAfterSignOut(a), []);
  }
  assert.equal(judgeNow(answers.good).pass, true);
});

test("the build whose sign out skips deleteDatabase (badKeepsStore, a scratch copy of 6430cba10) fails both sign-out lines", () => {
  const b = BAD_ALL(answers.badKeepsStore);
  assert.ok(b.includes(SO_NOW) && b.includes(NP_NOW), b.join("\n"));
  assert.ok(keptAfterSignOut(answers.badKeepsStore.prf.signout.after).some((k) => / record\(s\) in notes$/.test(k)));
});

test("the release before this card's check (goodNov11, the database gone and nothing reopened then) passes at its own reading, and fails both lines now: its store was never read", () => {
  assert.equal(judge(answers.goodNov11).pass, true);
  const now = judgeNow(answers.goodNov11).lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0].slice(4));
  assert.deepEqual(now, [SO_NOW, NP_NOW]);
  assert.ok(judgeNow(answers.goodNov11).lines.some((l) => l.includes("kept: the store not read")));
});

test("planted on the good answer, each sign out's kept piece fails its line: a seed record, a record in another store, an owed send, localStorage, the K_wrap before still the store's, never sealed, signed in, an account, the store not read", () => {
  const plants = [
    ["a kept seed record", (s) => (s.metaKeys.push("seed"), (s.stores.meta += 1)), "meta seed"],
    ["a kept note", (s) => (s.stores.notes = 1), "1 record(s) in notes"],
    ["a kept wallet", (s) => (s.stores.wallets = 2), "2 record(s) in wallets"],
    ["a kept owed send", (s) => (s.metaKeys.push("owed/*"), (s.stores.meta += 1)), "meta owed/*"],
    ["localStorage not empty", (s) => (s.localStorage = 1), "1 localStorage item(s)"],
    ["the K_wrap before still the store's", (s) => (s.oldKey = "opened"), "the K_wrap before still the store's"],
    ["no block sealed before the press", (s) => (s.oldKey = "not-sealed"), "the K_wrap before not tried (not-sealed)"],
    ["meta's count past its keys", (s) => (s.stores.meta = 3), "meta's count and keys disagree"],
  ];
  for (const [where, line] of [["prf", SO_NOW], ["noPrf", NP_NOW]]) {
    const step = (r) => (where === "prf" ? r.prf.signout.after : r.noPrf.after);
    for (const [name, plant, kept] of plants) {
      const r = structuredClone(answers.good);
      plant(step(r).store);
      assert.ok(BAD_ALL(r).includes(line), `${where} ${name}`);
      assert.ok(keptAfterSignOut(step(r)).includes(kept), `${where} ${name}: ${keptAfterSignOut(step(r)).join("; ")}`);
    }
    for (const [name, edit] of [
      ["still signed in", (a) => (a.state = "signed-in")],
      ["an account shown", (a) => (a.account = "ab".repeat(32))],
      ["the store not read", (a) => delete a.store],
    ]) {
      const r = structuredClone(answers.good);
      edit(step(r));
      assert.ok(BAD_ALL(r).includes(line), `${where} ${name}`);
    }
  }
});

// card signing-layer-says-when-it-closes (kit 1.13): every open kind answers { pending: true, closes: true } to this
// probe's hello. closes: this tree's build on the harness (13 Nov, Chrome 156, --harness --record): PASS. Planted on it:
// an open answered closes false, closes not true, another key, or not pending: FAIL on that step's line.
test("the run on release 128's answers passes, and an open answered closes false, closes not true or with another key fails", () => {
  const rec = answers.closes;
  const r = judge(rec);
  assert.equal(r.pass, true, r.lines.join("\n"));
  assert.equal(rec.mode, "harness");
  const opens = [["prf", "signin"], ["prf", "backup"], ["prf", "signout"], ["noPrf", "signout"], ["wallet"], ["twoTabs", "backup"]];
  const at = (o, p) => p.reduce((x, k) => x?.[k], o);
  for (const p of opens) assert.deepEqual(at(rec, p).answer.result, { pending: true, closes: true }, p.join("."));
  for (const result of [{ pending: true, closes: false }, { pending: true, closes: "true" }, { pending: true, closes: true, extra: 1 }, { pending: true, extra: 1 }, { closes: true }]) {
    for (const p of opens) {
      const c = structuredClone(rec);
      at(c, p).answer.result = result;
      const j = judge(c);
      assert.equal(j.pass, false, `${p.join(".")} ${JSON.stringify(result)}\n${j.lines.join("\n")}`);
    }
  }
  const c = structuredClone(rec);
  for (const p of opens) at(c, p).answer.result = { pending: true };
  assert.equal(judge(c).pass, true, "the answer before kit 1.13 still passes");
});
