// node --test scripts/live-checks/wallet-restore-id-reader.test.mjs: the live check's verdict on its recorded answers, with
// no network. Each record is a real run of the check (the 8-9 Nov 2026 clock of the recording machine), both providers
// asked live with Origin SIGN_ORIGIN, a preflight first and then the page's reads; none is edited. Re-recorded (9 Nov
// 01:51Z) by card wallet-restore-id-reader-wired's fold of its delta review (P3-3), whose MARK gained ids_end,
// ids_ux_push and seed_per_use_lock, so every record counts them (the fold before it, 00:52Z, added the stall's named
// reasons, intents.near's mt_tokens_for_owner and the final block header). Re-recorded again (9 Nov 03:48Z) by card
// wallet-id-reader-paced, whose MARK gained busy_wait and pair_wrong, each record as below from that card's tree (the
// mutants built in a worktree of its commit with its own install, whose fresh build matched the committed one):
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
// - bad_busy_guard and bad_pair_guard (card wallet-id-reader-paced): this card's build with one guard planted in the
//   IdReader's source, built and run with --local --root <that folder>: busy_guard asks the busy wait only when more
//   than one try is allowed (`if (b !== null && o.tries > 1)` in asked: the page's default tries would still wait, so
//   the guard is one a test passes), pair_guard concludes a disagreement only when an indexer is given (`if (ok.length
//   === 2 && ok[0]!.x !== ok[1]!.x && opts.indexer !== undefined)` in readId: the page gives none, so one provider's
//   word would read the lane on); each FAIL on the markers alone, its own marker at 0;
// - and the good record with another script's integrity, each marker gone, a provider out of the CSP, and each provider's
//   preflight or reads unknown, wrong, failed or with no CORS for the page: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { countOf, judge, judgeBundle, localFetch, MARK, MARKERS, PAIR, PLACES, probe, readBundle, REGISTERED, SIGN_ORIGIN, USDC } from "./wallet-restore-id-reader.mjs";

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
  assert.equal(ID_MARKERS.length, 18);
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

test("this card's build with a guard planted on the busy wait, or on the pair's disagreement, fails, on that marker alone", () => {
  for (const [key, marker] of [["bad_busy_guard", "busy_wait"], ["bad_pair_guard", "pair_wrong"]]) {
    assert.equal(answers[key].url, `local build of ${key.slice(4).replace("_", "-")}`, key);
    assert.deepEqual(BAD(answers[key]), [MARKS], key);
    for (const m of MARKERS) assert.equal(answers[key].app.markers[m], m === marker ? 0 : 1, `${key} ${m}`);
  }
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

// card wallet-id-reader-paced: busy_wait and pair_wrong, each a build's own text (packages/signpage/public/app.js at
// the card's branch, the pieces each marker binds, verbatim, in the bundle's order with other code between them as
// there; the minifier's names move from build to build, the shapes do not) and each planted bundle
// below that text with one change: a guard, an always-true or never-true compare, a step dropped, another name. Each
// plant counts 0, and the good record with that count fails on the markers alone.
const BUSY = {
  head: "XB=class extends Error{retryAfterMs;constructor(e,t){super(e),this.name=`ProviderBusy`,this.retryAfterMs=t}};function ZB(e){if(e instanceof XB)return{retryAfterMs:e.retryAfterMs};if(!JB(e))return null;let t=e.status;return typeof t==`number`&&(t===429||t>=500&&t<=599)?{retryAfterMs:typeof e.retryAfterMs==`number`?e.retryAfterMs:void 0}:e.name===`TimeoutError`?{retryAfterMs:void 0}:null}var QB=e=>JB(e)&&(e.code===-429||e.code===429||e.code===30&&/timeout/i.test(String(e.message))),",
  hold: "function nV(e,t,n){e.tat=Math.max(e.tat,t+n+(e.burst-1)*e.every)}",
  json: "if(QB(i.error))throw new XB(`${e.name}: ${n}: busy`);",
  asked: "async function pV(e,t,n){let r=eV(e),i=0,a=0,o=0;for(;;){n.signal?.throwIfAborted();let s=tV(r,n.now());s>0&&await n.sleep(s,n.signal);try{return await t(n.signal)}catch(t){if(n.signal?.aborted)throw n.signal.reason;let s=ZB(t);if(s!==null){let i=s.retryAfterMs??Math.min(8e3,500*2**a);if(a++,o+i>n.busyMax)throw Error(`${e.name}: busy past ${n.busyMax} ms of waits (${t instanceof Error?t.message:`busy`})`.slice(0,200));o+=i,nV(r,n.now(),i);continue}if(++i>=n.tries)throw t;await n.sleep(n.backoff*2**(i-1),n.signal)}}}",
};
const PAIRS = {
  cls: "oV=class extends Error{stronger;constructor(e,t){super(t),this.name=`PairDisagrees`,this.stronger=e}}",
  read: "async function f(e){let n=o()===0?0:1,i=[n,1-n],a=await Promise.allSettled(i.map(n=>l(t[n],e)));r.signal?.throwIfAborted();let s=a.flatMap((e,t)=>e.status===`fulfilled`?[{p:i[t],x:e.value}]:[]);if(s.length===2&&s[0].x!==s[1].x){let[e,n]=u[s[0].x]>u[s[1].x]?[s[1],s[0]]:[s[0],s[1]];throw new oV(t[n.p].name,`${t[n.p].name} answered ${n.x} where ${t[e.p].name} answered ${e.x} at block ${c.h}: one of the pair is wrong at one block, so the restore stops`)}let d=a.find(e=>e.status===`rejected`);if(d)throw d.reason instanceof Error?d.reason:Error(`the read failed`);",
  stop: "}catch(e){if(e instanceof oV)throw new oV(e.stronger,`lane ${i}: at index ${n}, ${e.message}, to be retried`);if(m.push({i:n,id:o,error:EV(e)}),",
};
// the minifier's names in the recorded text: ProviderBusy, busyOf, hold, asked; PairDisagrees, StalePass's stand-in
const NAME = (text, re) => re.exec(text)[1];
const [PB, BUSY_OF, HOLD] = [NAME(BUSY.head, /^([\w$]+)=/), NAME(BUSY.head, /function ([\w$]+)\(/), NAME(BUSY.hold, /^function ([\w$]+)\(/)];
const PD = NAME(PAIRS.cls, /^([\w$]+)=/);
const busyText = (o = {}) => { const x = { ...BUSY, ...o }; return `var a=1;${x.head}SG=new WeakMap;${x.hold}var b=2;async function zZ1(e,t,n,r,i){let a=1;${x.json}return a}${x.asked}var c=3;`; };
const pairText = (o = {}) => { const x = { ...PAIRS, ...o }; return `var a=1,${x.cls},b=2;function zZ2(){${x.read}return 1}async function zZ3(){try{1${x.stop}0}finally{}}`; };
const planted = (key, text) => {
  const rec = structuredClone(answers.good);
  rec.app.markers[key] = countOf(text, MARK[key]);
  return rec;
};

test("busy_wait and pair_wrong: this build's bundle holds each once, and so does the recorded build's text", () => {
  const app = readFileSync(path.join(HERE, "../../packages/signpage/public/app.js"), "utf8");
  assert.equal(countOf(app, MARK.busy_wait), 1);
  assert.equal(countOf(app, MARK.pair_wrong), 1);
  assert.equal(countOf(busyText(), MARK.busy_wait), 1);
  assert.equal(countOf(pairText(), MARK.pair_wrong), 1);
  assert.equal(judge(planted("busy_wait", busyText())).pass, true);
  assert.equal(judge(planted("pair_wrong", pairText())).pass, true);
});

test("busy waited out: each planted bundle (a guard, a bound never or always met, a step dropped, another name) fails", () => {
  const swap = (k, from, to) => {
    assert.ok(BUSY[k].includes(from), `${k} holds ${from}`);
    return busyText({ [k]: BUSY[k].replace(from, to) });
  };
  for (const [why, text] of [
    ["a guard before the busy branch", swap("asked", "if(s!==null){", "if(s!==null&&n.tries>1){")],
    ["the busy branch never taken", swap("asked", "if(s!==null){", "if(s===null){")],
    ["the bound never met (waits for ever)", swap("asked", "if(a++,o+i>n.busyMax)", "if(a++,!1)")],
    ["the bound always met (no wait)", swap("asked", "if(a++,o+i>n.busyMax)", "if(a++,o+i>=0)")],
    ["the waits not summed", swap("asked", `o+=i,${HOLD}(`, `${HOLD}(`)],
    ["Retry-After ignored", swap("asked", "s.retryAfterMs??Math.min(8e3,500*2**a)", "Math.min(8e3,500*2**a)")],
    ["no backoff growth", swap("asked", "if(a++,", "if(")],
    ["the wait not held on the pace", swap("asked", `o+=i,${HOLD}(r,n.now(),i);continue}`, "o+=i;continue}")],
    ["busy failed at once", swap("asked", `${HOLD}(r,n.now(),i);continue}`, `${HOLD}(r,n.now(),i);throw t}`)],
    ["the pace's slot not waited", swap("asked", "s>0&&await n.sleep(s,n.signal);", "")],
    ["the signal not checked", swap("asked", "if(n.signal?.aborted)throw n.signal.reason;", "")],
    ["another classifier in the catch", swap("asked", `=${BUSY_OF}(`, "=zZ(")],
    ["another hold in the catch", swap("asked", `${HOLD}(`, "zZ(")],
    ["HTTP 429 not busy", swap("head", "t===429||", "t===428||")],
    ["5xx not busy", swap("head", "t>=500&&t<=599", "t>=500&&t<=500")],
    ["a timeout not busy", swap("head", "e.name===`TimeoutError`?", "e.name===`AbortError`?")],
    ["the JSON -429 not busy", swap("head", "e.code===-429||", "")],
    ["dRPC's code 30 not busy", swap("head", "e.code===30&&", "e.code===31&&")],
    ["a JSON busy answer not thrown busy", swap("json", `throw new ${PB}(`, "throw Error(")],
    ["the hold not holding the burst", swap("hold", "+(e.burst-1)*e.every", "")],
  ]) {
    assert.equal(countOf(text, MARK.busy_wait), 0, why);
    assert.deepEqual(BAD(planted("busy_wait", text)), [MARKS], why);
  }
  // the pieces are each found once: a second ProviderBusy or hold (one guarded, one not) counts 0
  assert.equal(countOf(busyText() + BUSY.head, MARK.busy_wait), 0, "two classifiers");
  assert.equal(countOf(busyText() + BUSY.hold, MARK.busy_wait), 0, "two holds");
});

test("one of the pair is wrong at one block: each planted bundle (a guard, a compare never true, a step dropped, another name) fails", () => {
  const swap = (k, from, to) => {
    assert.ok(PAIRS[k].includes(from), `${k} holds ${from}`);
    return pairText({ [k]: PAIRS[k].replace(from, to) });
  };
  for (const [why, text] of [
    ["a guard before the disagreement", swap("read", "if(s.length===2&&s[0].x!==s[1].x)", "if(s.length===2&&s[0].x!==s[1].x&&r.strict)")],
    ["a compare never true", swap("read", "s[0].x!==s[1].x", "s[0].x!==s[0].x")],
    ["one answer taken (no pair)", swap("read", "s.length===2&&", "s.length===3&&")],
    ["one provider asked", swap("read", "i=[n,1-n]", "i=[n]")],
    ["not both at once", swap("read", "await Promise.allSettled(", "await Promise.any(")],
    ["the weaker named", swap("read", `throw new ${PD}(t[n.p].name,`, `throw new ${PD}(t[e.p].name,`)],
    ["a failed read taken", swap("read", "if(d)throw d.reason instanceof Error?d.reason:Error(`the read failed`);", "")],
    ["another error thrown", swap("read", `throw new ${PD}(t[n.p]`, "throw new Error(t[n.p]")],
    ["the class's name another", swap("cls", "`PairDisagrees`", "`Error`")],
    ["step 5 reads on (counted unread)", swap("stop", `if(e instanceof ${PD})throw`, `if(e instanceof ${PD}&&!1)throw`)],
    ["step 5 catches another class", swap("stop", `e instanceof ${PD}`, "e instanceof zZ")],
    ["step 5 counts it before the throw", swap("stop", "}catch(e){if(", "}catch(e){h++;if(")],
  ]) {
    assert.equal(countOf(text, MARK.pair_wrong), 0, why);
    assert.deepEqual(BAD(planted("pair_wrong", text)), [MARKS], why);
  }
  assert.equal(countOf(pairText() + "," + PAIRS.cls, MARK.pair_wrong), 0, "two PairDisagrees classes");
});
