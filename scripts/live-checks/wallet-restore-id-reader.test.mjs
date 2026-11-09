// node --test scripts/live-checks/wallet-restore-id-reader.test.mjs: the live check's verdict on its recorded answers, with
// no network. Each record is a real run of the check (the 8-9 Nov 2026 clock of the recording machine), both providers
// asked live with Origin SIGN_ORIGIN, a preflight first and then the page's reads; none is edited. Re-recorded (9 Nov
// 01:51Z) by card wallet-restore-id-reader-wired's fold of its delta review (P3-3), whose MARK gained ids_end,
// ids_ux_push and seed_per_use_lock, so every record counts them (the fold before it, 00:52Z, added the stall's named
// reasons, intents.near's mt_tokens_for_owner and the final block header):
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
// - bad_catch_done: this card's build with step 5's catch swallowing its throw (`.catch(() => {})`, the review's
//   mutant B3: a step 5 that throws would end the run done), built and run with --local --root <that folder>: FAIL on
//   the markers alone, ids_catch and ids_end at 0;
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
const BLK = (i) => `provider ${i} reads its final block's header for the page's origin`;
const INT = (i, who) => `provider ${i} reads intents.near's token list of the ${who} id for the page's origin`;
// a provider's lines in the order judge says them
const ALL = (i) => [PRE(i), BLK(i), INT(i, "registered"), REG(i), INT(i, "unused"), UNU(i)];

/** Each provider's answers as the recorded good run read them, with no network; the Origin sent is the page's. */
const fakeRpc = (state = {}) => async (u, init) => {
  const url = String(u);
  const i = PAIR.indexOf(url);
  assert.ok(i >= 0, url);
  assert.equal(init.headers.origin, SIGN_ORIGIN);
  const cors = { "access-control-allow-origin": "*" };
  if (init.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" } });
  const { method, params } = JSON.parse(init.body);
  const json = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200, headers: cors });
  if (method === "block") return (assert.deepEqual(params, { finality: "final" }), json({ header: { height: 223700000, hash: "7GimM2vwF2MuALZhZsRYibhPjTqBNjV8gP7pnR5rtQb5" } }));
  assert.equal(method, "query");
  const unknown = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }), { status: 200, headers: cors });
  if (params.request_type === "view_account") return params.account_id === REGISTERED ? json({ amount: "374836026634223774816433" }) : unknown();
  if (params.account_id === "intents.near") return (assert.equal(params.method_name, "mt_tokens_for_owner"), json({ result: [...Buffer.from("[]")] }));
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
  assert.equal(ID_MARKERS.length, 16);
  for (const m of MARKERS) assert.equal(answers.bad_main_bundle.app.markers[m], m.startsWith("reach_") ? 1 : 0, m);
});

test("the live SIGN_HOST before the card's release fails, on the markers alone", () => {
  assert.equal(answers.bad_live_before.url, SIGN_ORIGIN);
  assert.deepEqual(BAD(answers.bad_live_before), [MARKS]);
});

test("this card's build with step 5's catch swallowing its throw (the review's mutant B3) fails, on ids_catch and ids_end alone", () => {
  assert.equal(answers.bad_catch_done.url, "local build of catch-mutant");
  assert.deepEqual(BAD(answers.bad_catch_done), [MARKS]);
  for (const m of MARKERS) assert.equal(answers.bad_catch_done.app.markers[m], m === "ids_catch" || m === "ids_end" ? 0 : 1, m);
});

test("a provider answering with no CORS (dRPC, every access-control header gone) fails, on its preflight and reads alone", () => {
  assert.deepEqual(BAD(answers.bad_no_cors), ALL(1));
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
    // the block and intents.near's list: each wrong, failed or with no CORS fails on its own line
    for (const [why, v] of [["no CORS", { ...good.block, acao: undefined }], ["a 429", { http: 429, error: "error" }], ["no answer", { error: "TimeoutError" }], ["not a header", { ...good.block, read: "other" }]])
      assert.deepEqual(BAD(swap((p) => void (p.block = v))), [BLK(i)], `${k} block ${why}`);
    for (const who of ["registered", "unused"])
      for (const [why, v] of [["no CORS", { ...good[who].intents, acao: undefined }], ["a 429", { http: 429, error: "error" }], ["not a list", { ...good[who].intents, read: "other" }]])
        assert.deepEqual(BAD(swap((p) => void (p[who].intents = v))), [INT(i, who)], `${k} ${who} intents ${why}`);
    const none = structuredClone(answers.good);
    delete none.rpc[k];
    assert.deepEqual(BAD(none), ALL(i), `${k} not read`);
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
  for (const k of PLACES) assert.deepEqual([rec.rpc[k].block.read, rec.rpc[k].registered.intents.read, rec.rpc[k].unused.intents.read], ["header", "list", "list"], k);
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

// the page's wiring (src/pool-restore.ts readDepositIds): the error kept is the one thrown again
test("ids_stop matches the first unread id stopping every read after it, never another", () => {
  const n = (text, k) => [...text.matchAll(MARK[k])].length;
  assert.equal(n("if(r.throwIfAborted(),o!==void 0)throw o;try{return await a(e)}catch(e){throw o??=e,e}", "ids_stop"), 1);
  assert.equal(n("if(r.throwIfAborted(),o!==void 0)throw p;try{return await a(e)}catch(e){throw o??=e,e}", "ids_stop"), 0);
  assert.equal(n("if(r.throwIfAborted(),o!==void 0)throw o;try{return await a(e)}catch(e){throw e}", "ids_stop"), 0);
  assert.equal(n("if(r.throwIfAborted(),o!==void 0)throw o;try{return await a(e)}catch(e){throw o??=x,e}", "ids_stop"), 0);
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
    assert.deepEqual(BAD(rec), PLACES.flatMap((_, i) => [BLK(i), INT(i, "registered"), REG(i), INT(i, "unused"), UNU(i)]), String(ra));
    assert.equal(asks, 4 * 7 * PAIR.length, `${ra}: four asks of each of the seven reads on each provider`);
    assert.deepEqual(new Set(waits), new Set([ms]), `${ra}: each wait ${ms} ms`);
  }
});

// review of e31892ef (P3-3): the end stage, the U_X push and the seed per use, each bound to its names; each planted
// bundle line below is this build's own line with one change, and fails its marker
test("ids_end, ids_ux_push and seed_per_use_lock match this build's lines, never a stage that drops reasons, another constant or a run-long lock", () => {
  const n = (text, k) => [...text.matchAll(MARK[k])].length;
  const end = (stage, to = "s") => `.catch(e=>void ${to}.push(\`step 5 did not finish: \${e instanceof Error?e.message:\`it threw\`}\`)),t.throwIfAborted(),${stage}`;
  assert.equal(n(end("l(s.length>0?`stalled`:`done`)"), "ids_end"), 1);
  // the review's mutant: a stage that drops the U_X reasons
  assert.equal(n(end("l(s.some(e=>!e.endsWith(hV))?`stalled`:`done`)"), "ids_end"), 0);
  assert.equal(n(end("l(s.length>0?`stalled`:`done`)", "x"), "ids_end"), 0, "the catch pushes to another array");
  assert.equal(n(end("l(s.length>1?`stalled`:`done`)"), "ids_end"), 0);
  // this build's two statements: each reason idsUndone names, then the U_X reason, with nothing between them
  const ux = (push) => `var hV=\`the pool's own chain is not read for a deposit's money (each id's U_X there), so the restore is not done\`;function gV(e){}async function vV(e,t,n,r,i){for(let r of t){let a=1;for(let e of gV(a))i.push(\`\${r.label}: \${e}\`);${push}}}var yV={}`;
  assert.equal(n(ux("i.push(`${r.label}: ${hV}`)"), "ids_ux_push"), 1);
  assert.equal(n(ux("i.push(`${r.label}: ${gV}`)"), "ids_ux_push"), 0, "another constant pushed");
  assert.equal(n(ux("i.push(`${r.label}: done`)"), "ids_ux_push"), 0);
  // delta review 2 (P3): a condition before the push (a pool with no notes would end done, its U_X unread)
  assert.equal(n(ux("r.notes.length>0&&i.push(`${r.label}: ${hV}`)"), "ids_ux_push"), 0, "a condition before the U_X push");
  assert.equal(n(ux("if(r.notes.length>0)i.push(`${r.label}: ${hV}`)"), "ids_ux_push"), 0, "an if before the U_X push");
  assert.equal(n(ux("x.push(`${r.label}: ${hV}`)"), "ids_ux_push"), 0, "pushed to another array than the reasons'");
  const lock = (check, mark, zero, use) =>
    `d=n=>r().request(Io,{mode:\`shared\`,signal:t},async()=>{if(t.throwIfAborted(),${check})throw Error(\`signed out during the restore\`);let r=await e.seed64();try{let e=re(We,c,r);if(u===null)u=e;else{let t=e.length===u.length&&e.every((e,t)=>e===u[t]);if(e.fill(0),!t)throw Error(\`${mark}\`)}return await n(r)}finally{${zero}}}),${use}`;
  const good = ["!await e.signedIn()", "other words were signed in during the restore", "r.fill(0)", "f=e=>d(async t=>e(t))"];
  assert.equal(n(lock(...good), "seed_per_use_lock"), 1);
  assert.equal(n(lock("!1", good[1], good[2], good[3]), "seed_per_use_lock"), 0, "no signed-in check");
  assert.equal(n(lock(good[0], "the words changed", good[2], good[3]), "seed_per_use_lock"), 0, "no run mark");
  // delta review 2 (P3): a compare that is always true holds the run to no seed
  const always = lock(...good).replace("e.every((e,t)=>e===u[t])", "e.every((e,t)=>e===e)");
  assert.notEqual(always, lock(...good));
  assert.equal(n(always, "seed_per_use_lock"), 0, "an always-true compare");
  const noMark = lock(...good).replace("if(u===null)u=e;", "if(u===null)u=r;");
  assert.equal(n(noMark, "seed_per_use_lock"), 0, "the mark is not the seed's HMAC");
  assert.equal(n(lock(good[0], good[1], "void 0", good[3]), "seed_per_use_lock"), 0, "the seed not zeroed");
  // the run-long lock: the run's SeedUse hands out one seed held for the run, not a request per use
  assert.equal(n(lock(good[0], good[1], good[2], "f=e=>e(S)"), "seed_per_use_lock"), 0, "a run-long seed");
});
