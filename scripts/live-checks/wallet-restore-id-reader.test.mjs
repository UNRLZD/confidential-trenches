// node --test scripts/live-checks/wallet-restore-id-reader.test.mjs: the live check's verdict on its recorded answers, with
// no network. Each record is a real run of the check (the 8-9 Nov 2026 clock of the recording machine), both providers
// asked live with Origin SIGN_ORIGIN, a preflight first and then the page's reads; none is edited. Re-recorded by card
// wallet-restore-id-reader-wired, whose MARK gained the IdReader's rules:
// - good: that card's build (index.html, public/app.js and public/_headers at its branch, --local): PASS;
// - bad_main_bundle: main's build before it (610143c2's index.html, public/app.js and public/_headers, run with
//   --local --root <that folder>): FAIL on the markers alone, the walk's reach in it and none of the IdReader's rules;
// - bad_live_before: the live SIGN_HOST before its release: FAIL on the markers alone;
// - bad_no_cors: this card's build with dRPC's answers stripped of every access-control header in transit (probe's
//   transport argument, the live answers otherwise as read): FAIL on that provider's preflight and reads alone. No keyless
//   NEAR provider answers a page's origin without CORS, so the missing header is made in transit, by this recorder:
//     const strip = async (u, init) => { const res = await fetch(u, init); if (!String(u).startsWith(PAIR[1])) return res;
//       const h = new Headers(res.headers); for (const k of [...h.keys()]) if (k.startsWith("access-control-")) h.delete(k);
//       return new Response(res.status === 204 ? null : await res.arrayBuffer(), { status: res.status, headers: h }); };
//     probe(SIGN_ORIGIN, localFetch, strip)   // written as JSON as --record writes it
// - and the good record with another script's integrity, each marker gone, a provider out of the CSP, and each provider's
//   preflight or reads unknown, wrong, failed or with no CORS for the page: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, judgeBundle, localFetch, MARK, MARKERS, PAIR, PLACES, probe, readBundle, REGISTERED, SIGN_ORIGIN, USDC } from "./wallet-restore-id-reader.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "wallet-restore-id-reader.answers.json"), "utf8"));
// the BAD lines, with the verdict checked to agree (a verdict that passes with a BAD line is a bug of its own)
const BAD = (rec) => {
  const v = judge(rec);
  const bad = v.lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0].slice(4));
  assert.equal(v.pass, bad.length === 0, `the verdict agrees with its lines: ${bad.join(", ")}`);
  return bad;
};
const MARKS = "/app.js carries the restore walk's reach and the IdReader's rules";
// the IdReader's markers (card wallet-restore-id-reader-wired), after the walk's reach ones
const ID_MARKERS = MARKERS.filter((k) => !k.startsWith("reach_"));
const SAME = "/app.js is the script / names: its sha384 is the integrity";
const CSP = "SIGN_HOST's connect-src reaches both providers";
const IDS = "the ids read are the registered one and a fresh one";
const PRE = (i) => `provider ${i} answers the page's preflight for its origin`;
const REG = (i) => `provider ${i} reads the registered id registered for the page's origin`;
const UNU = (i) => `provider ${i} reads the unused id unused for the page's origin`;

/** Each provider's answers as the recorded good run read them, with no network; the Origin sent is the page's. */
const fakeRpc = (state = {}) => async (u, init) => {
  const url = String(u);
  const i = PAIR.indexOf(url);
  assert.ok(i >= 0, url);
  assert.equal(init.headers.origin, SIGN_ORIGIN);
  const cors = { "access-control-allow-origin": "*" };
  if (init.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" } });
  const { method, params } = JSON.parse(init.body);
  assert.equal(method, "query");
  const json = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200, headers: cors });
  const unknown = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }), { status: 200, headers: cors });
  if (params.request_type === "view_account") return params.account_id === REGISTERED ? json({ amount: "374836026634223774816433" }) : unknown();
  assert.equal(params.account_id, USDC);
  assert.equal(params.method_name, "storage_balance_of");
  state.args = [...(state.args ?? []), JSON.parse(Buffer.from(params.args_base64, "base64").toString()).account_id];
  const body = JSON.parse(Buffer.from(params.args_base64, "base64").toString()).account_id === REGISTERED ? { total: "1250000000000000000000", available: "0" } : null;
  return json({ result: [...Buffer.from(JSON.stringify(body))] });
};

test("the recorded good answer (the card's build and both providers' real reads) passes", () => {
  const r = judge(answers.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
  for (const m of MARKERS) assert.ok(answers.good.app.markers[m] >= 1, m);
  assert.equal(answers.good.ids.registered, REGISTERED);
  for (const k of PLACES) {
    assert.equal(answers.good.rpc[k].registered.storage.read, "registered", k);
    assert.equal(answers.good.rpc[k].unused.storage.read, "null", k);
    assert.equal(answers.good.rpc[k].unused.account.read, "UNKNOWN_ACCOUNT", k);
  }
});

test("main's build before the IdReader was wired (the walk's reach, none of the IdReader's rules) fails, on the markers alone", () => {
  assert.equal(answers.bad_main_bundle.url, "local build of main-610143c2");
  assert.deepEqual(BAD(answers.bad_main_bundle), [MARKS]);
  assert.equal(ID_MARKERS.length, 9);
  for (const m of MARKERS) assert.equal(answers.bad_main_bundle.app.markers[m], m.startsWith("reach_") ? 1 : 0, m);
});

test("the live SIGN_HOST before the card's release fails, on the markers alone", () => {
  assert.equal(answers.bad_live_before.url, SIGN_ORIGIN);
  assert.deepEqual(BAD(answers.bad_live_before), [MARKS]);
});

test("a provider answering with no CORS (dRPC, every access-control header gone) fails, on its preflight and reads alone", () => {
  assert.deepEqual(BAD(answers.bad_no_cors), [PRE(1), REG(1), UNU(1)]);
  assert.equal(judgeBundle(answers.bad_no_cors).pass, true);
});

test("the good record with another script's integrity, one marker gone or a provider out of the CSP fails", () => {
  const other = structuredClone(answers.good);
  other.index.integrity = answers.bad_live_before.index.integrity;
  assert.deepEqual(BAD(other), [SAME]);
  for (const m of MARKERS) {
    const gone = structuredClone(answers.good);
    gone.app.markers[m] = 0;
    assert.deepEqual(BAD(gone), [MARKS], m);
  }
  for (const h of PAIR) {
    const out = structuredClone(answers.good);
    out.connect_src = out.connect_src.split(" ").filter((x) => x !== h).join(" ");
    assert.deepEqual(BAD(out), [CSP], h);
  }
});

test("the ids: a swapped registered id, the fresh one equal to it, or a malformed fresh one fails", () => {
  for (const [why, ids] of [
    ["another registered", { ...answers.good.ids, registered: "ab".repeat(32) }],
    ["the fresh one is the registered one", { ...answers.good.ids, unused: REGISTERED }],
    ["the fresh one is no id", { ...answers.good.ids, unused: "x" }],
  ]) {
    const r = structuredClone(answers.good);
    r.ids = ids;
    assert.ok(BAD(r).includes(IDS), why);
  }
});

test("each provider's preflight or reads not what the page needs fails, on that provider's line alone", () => {
  PLACES.forEach((k, i) => {
    const good = answers.good.rpc[k];
    const swap = (edit) => {
      const r = structuredClone(answers.good);
      edit(r.rpc[k]);
      return r;
    };
    for (const [why, edit] of [
      ["a 500 preflight", (p) => void (p.preflight = { ...good.preflight, http: 500 })],
      ["a preflight with no CORS", (p) => void (p.preflight = { ...good.preflight, acao: undefined })],
      ["a preflight for another origin", (p) => void (p.preflight = { ...good.preflight, acao: "https://example.com" })],
      ["a preflight with no POST", (p) => void (p.preflight = { ...good.preflight, acam: "GET" })],
      ["a preflight with no content-type", (p) => void (p.preflight = { ...good.preflight, acah: "authorization" })],
      ["no preflight answer", (p) => void (p.preflight = { error: "TimeoutError" })],
    ]) assert.deepEqual(BAD(swap(edit)), [PRE(i)], `${k} ${why}`);
    for (const [who, LINE, kind] of [["registered", REG(i), "storage"], ["registered", REG(i), "account"], ["unused", UNU(i), "storage"], ["unused", UNU(i), "account"]]) {
      const a = good[who][kind];
      for (const [why, v] of [
        ["no CORS", { ...a, acao: undefined }],
        ["CORS for another origin", { ...a, acao: "https://example.com" }],
        ["a 429", { http: 429, error: "error" }],
        ["no answer", { error: "TimeoutError" }],
        ["an error word", { ...a, read: "UNKNOWN_BLOCK" }],
        ["a malformed answer", { ...a, read: "other" }],
      ]) assert.deepEqual(BAD(swap((p) => void (p[who][kind] = v))), [LINE], `${k} ${who} ${kind} ${why}`);
    }
    // the wrong state: a registered id read unregistered or with no account; a fresh id read registered or with an account
    assert.deepEqual(BAD(swap((p) => void (p.registered.storage.read = "null"))), [REG(i)], `${k} registered reads null`);
    assert.deepEqual(BAD(swap((p) => void (p.registered.account.read = "UNKNOWN_ACCOUNT"))), [REG(i)], `${k} registered reads no account`);
    assert.deepEqual(BAD(swap((p) => void (p.unused.storage.read = "registered"))), [UNU(i)], `${k} unused reads registered`);
    assert.deepEqual(BAD(swap((p) => void (p.unused.account.read = "account"))), [UNU(i)], `${k} unused reads an account`);
    const none = structuredClone(answers.good);
    delete none.rpc[k];
    assert.deepEqual(BAD(none), [PRE(i), REG(i), UNU(i)], `${k} not read`);
  });
});

test("the committed build in this tree passes as the recorded good answer did (both providers' answers replayed, a fresh random id)", async () => {
  const state = {};
  const rec = await probe(SIGN_ORIGIN, localFetch, fakeRpc(state));
  assert.equal(judge(rec).pass, true, judge(rec).lines.join("\n"));
  assert.equal(rec.connect_src, answers.good.connect_src, "the CSP as recorded");
  assert.equal(rec.app.sha384, answers.good.app.sha384, "the bundle as recorded");
  assert.deepEqual(rec.app.markers, answers.good.app.markers);
  assert.match(rec.ids.unused, /^[0-9a-f]{64}$/);
  assert.notEqual(rec.ids.unused, REGISTERED);
  assert.equal((await probe(SIGN_ORIGIN, localFetch, fakeRpc(), undefined, "cd".repeat(32))).ids.unused, "cd".repeat(32));
  assert.equal(state.args.length, 2 * PAIR.length, "storage_balance_of asked of each provider for each id");
  assert.deepEqual(new Set(state.args), new Set([REGISTERED, rec.ids.unused]));
  // two runs read two fresh ids
  assert.notEqual((await probe(SIGN_ORIGIN, localFetch, fakeRpc())).ids.unused, rec.ids.unused);
});

test("the bundle part alone (readBundle, judgeBundle) reads this build and passes; main's build before the card fails it", async () => {
  assert.equal(judgeBundle(await readBundle(localFetch)).pass, true);
  assert.equal(judgeBundle(answers.bad_main_bundle).pass, false);
  assert.equal(judgeBundle(undefined).pass, false);
});

// the minifier's names are bound: the index pushed is the one compared, the counter reset is the one counted
test("reach_misses and reach_floor match a miss counted only past the floor, never another index or counter", () => {
  const n = (text, k) => [...text.matchAll(MARK[k])].length;
  assert.equal(n("r(l)?(s.push(a),u=0):a>o&&u++", "reach_misses"), 1);
  assert.equal(n("r(l)?(s.push(a),u=0):b>o&&u++", "reach_misses"), 0);
  assert.equal(n("r(l)?(s.push(a),u=0):a>o&&v++", "reach_misses"), 0);
  assert.equal(n("r(l)?(s.push(a),u=0):u++", "reach_misses"), 0);
  assert.equal(n("let o=a??-1,s=[]", "reach_floor"), 1);
  assert.equal(n("let o=a??0,s=[]", "reach_floor"), 0);
});

// the page's wiring (src/pool-restore.ts readDepositIds): the error kept is the one thrown again, the result tested is the
// one whose lanes are read
test("ids_stop and ids_stall match the first unread id stopping every read after it and a lane unread ending the run, never another", () => {
  const n = (text, k) => [...text.matchAll(MARK[k])].length;
  assert.equal(n("if(r.throwIfAborted(),o!==void 0)throw o;try{return await a(e)}catch(e){throw o??=e,e}", "ids_stop"), 1);
  assert.equal(n("if(r.throwIfAborted(),o!==void 0)throw p;try{return await a(e)}catch(e){throw o??=e,e}", "ids_stop"), 0);
  assert.equal(n("if(r.throwIfAborted(),o!==void 0)throw o;try{return await a(e)}catch(e){throw e}", "ids_stop"), 0);
  assert.equal(n("if(r.throwIfAborted(),o!==void 0)throw o;try{return await a(e)}catch(e){throw o??=x,e}", "ids_stop"), 0);
  assert.equal(n("if(n.read?.(r.scope,t),!t.complete||t.lanes.some(e=>e.unread.length>0))return!1", "ids_stall"), 1);
  assert.equal(n("if(n.read?.(r.scope,t),!t.complete||u.lanes.some(e=>e.unread.length>0))return!1", "ids_stall"), 0);
  assert.equal(n("if(n.read?.(r.scope,t),!t.complete||t.lanes.some(e=>f.unread.length>0))return!1", "ids_stall"), 0);
  assert.equal(n("if(n.read?.(r.scope,t),!t.complete)return!1", "ids_stall"), 0);
});

test("a 429 or a 408 is asked again after its Retry-After (10 s with none, 30 s at most), and after four asks it is the answer", async () => {
  const waits = [];
  const wait = async (ms) => void waits.push(ms);
  for (const status of [429, 408]) {
    waits.length = 0;
    let n = 0;
    const base = fakeRpc();
    const flaky = async (u, init) => (init.method === "POST" && ++n === 1 ? new Response("{}", { status, headers: { "retry-after": "2" } }) : base(u, init));
    assert.equal(judge(await probe(SIGN_ORIGIN, localFetch, flaky, wait)).pass, true, String(status));
    assert.deepEqual(waits, [2000], String(status));
  }
  for (const [ra, ms] of [["120", 30_000], [null, 10_000], ["soon", 10_000], ["30", 30_000]]) {
    waits.length = 0;
    let asks = 0;
    const always = async (u, init) => {
      if (init.method === "OPTIONS") return fakeRpc()(u, init);
      asks++;
      return new Response("{}", { status: 429, headers: ra === null ? {} : { "retry-after": ra } });
    };
    const rec = await probe(SIGN_ORIGIN, localFetch, always, wait);
    assert.deepEqual(BAD(rec), PLACES.flatMap((_, i) => [REG(i), UNU(i)]), String(ra));
    assert.equal(asks, 4 * 4 * PAIR.length, `${ra}: four asks of each of the four reads on each provider`);
    assert.deepEqual(new Set(waits), new Set([ms]), `${ra}: each wait ${ms} ms`);
  }
});
