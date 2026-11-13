// node --test scripts/live-checks/wallet-restore-id-reader.test.mjs: the live check's verdict on its recorded answers, with
// no network. Each record is a real run of the check (the 8-9 Nov 2026 clock of the recording machine), both providers
// asked live with Origin SIGN_ORIGIN, a preflight first and then the page's reads; none is edited. Re-recorded (9 Nov
// 01:51Z) by card wallet-restore-id-reader-wired's fold of its delta review (P3-3), whose MARK gained ids_end,
// ids_ux_push and seed_per_use_lock, so every record counts them (the fold before it, 00:52Z, added the stall's named
// reasons, intents.near's mt_tokens_for_owner and the final block header). Re-recorded again (9 Nov 03:48Z) by card
// wallet-id-reader-paced, whose MARK gained busy_wait and pair_wrong, each record as below from that card's tree (the
// mutants built in a worktree of its commit with its own install, whose fresh build matched the committed one). Card
// wallet-restore-reads-ux re-anchored ids_stop (the id and its index) and ids_ux_push (the push only where the pool's
// chain has no U_X reads) and re-recorded good alone from its build merged with main (9 Nov, --local); the bad records
// keep the counts their builds gave then:
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
// Re-recorded again (9 Nov 04:51Z) by that card's fold of its review (P2-3), whose MARK gained id_keep and id_signout
// and whose busy_wait and pair_wrong bind more, each record as above from the fold's commit 648d10c2 (its mutants built
// in a worktree of that commit with its own install, whose fresh build matched the committed one); bad_pair_guard
// counts id_keep 0 as well, since the keep is bound with readId in one pattern. Re-recorded again (9 Nov 05:47Z) by
// its delta review 2 fold (P1: pacedFetch's deadline from the slot on, busy_wait binding it), the same way, from the fold's
// tree; the live SIGN_HOST now carries the wired IdReader's markers, so bad_live_before fails on the card's four alone.
// Re-recorded again (9 Nov 06:23Z) by its delta review 3 fold (P2-1: only the queue's last slot given back; P2-2:
// busy_wait binds the five requestSignal sites and pacedNearRpc), the same way.
// - bad_busy_guard and bad_pair_guard (card wallet-id-reader-paced): this card's build with one guard planted in the
//   IdReader's source, built and run with --local --root <that folder>: busy_guard asks the busy wait only when more
//   than one try is allowed (`if (b !== null && o.tries > 1)` in asked: the page's default tries would still wait, so
//   the guard is one a test passes), pair_guard concludes a disagreement only when an indexer is given (`if (ok.length
//   === 2 && ok[0]!.x !== ok[1]!.x && opts.indexer !== undefined)` in readId: the page gives none, so one provider's
//   word would read the lane on); each FAIL on the markers alone, its own marker at 0;
// - and the good record with another script's integrity, each marker gone, a provider out of the CSP, and each provider's
//   preflight or reads unknown, wrong, failed or with no CORS for the page: each FAIL.
// Card restore-first-sign-in-under-two-minutes (first in release 115) re-anchored ids_stop and id_keep: each of step 5's
// reads, the readers' openings too, is waited on through letGo on the run's own signal, letGo held by its body (LET_GO),
// so a sign out lets go of a read in flight; it re-recorded good alone from its build (11 Nov, --local), the bad records
// keeping the counts their builds gave then.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";
import { countOf, IDS_END_TRY, IDS_TELL, IDS_WALK_END, judge, judgeBundle, LET_GO, localFetch, MARK, MARKERS, PAIR, PLACES, probe, readBundle, REGISTERED, SIGN_ORIGIN, USDC } from "./wallet-restore-id-reader.mjs";
import { copyChange, dropRule, plantedFetch } from "./planted-build.mjs";

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
  assert.equal(ID_MARKERS.length, 20);
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
    // the pair's guard sits in readId, which the IdReader's keep is bound with (id_keep shares its pattern)
    const zero = key === "bad_pair_guard" ? [marker, "id_keep"] : [marker];
    for (const m of MARKERS) assert.equal(answers[key].app.markers[m], zero.includes(m) ? 0 : 1, `${key} ${m}`);
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

// card held-move-replay-any-build: the tree's build is read with the check's own reader (readBundle over localFetch) and
// judged with the live rule; of the recorded good answer only the providers' reads (and the ids they read) are kept, so
// any build of this tree that keeps the rule passes with no re-record, and one that drops a rule fails
const treeRecord = async (fetchFn = localFetch) => ({ ...answers.good, url: "local build", ...(await readBundle(fetchFn)) });
// card wallet-id-reader-paced: a marker that is a function of the bundle (busy_wait, pair_wrong, id_keep, id_signout)
// binds a whole run, so its rule is dropped by the one piece of the build that run alone needs: the pace's FastNEAR
// rate (paceOf), step 5's PairDisagrees rethrow (`${e.message}, to be retried`), step 5's read through keptIdReader
// (`let{rpcs:s,pass:c,reader:l}=await JV(`, its pair and pass the held reader's: card wallet-restore-reads-ux) and signedOut's new keep; each zeroes its own marker and no other (measured on the
// merged build at 124994e7)
const RULE_OF = { busy_wait: "perSec:.39,burst:8", pair_wrong: ".message}, read again`", id_keep: "let{rpcs:", id_signout: "signedOut:()=>{", ids_end: "?`stalled`:`done`" };
const ruleOf = (m) => (typeof MARK[m] === "function" ? RULE_OF[m] : MARK[m]);

test("the committed build in this tree passes the live rule, with the recorded providers' reads", async () => {
  const rec = await treeRecord();
  assert.equal(judge(rec).pass, true, judge(rec).lines.join("\n"));
});

test("a rebuilt bundle of this tree with an unrelated copy change passes with no re-record; one that drops a rule fails on it alone", async () => {
  const copy = await treeRecord(plantedFetch(localFetch, (js) => copyChange(js, Object.values(MARK))));
  assert.equal(judge(copy).pass, true, judge(copy).lines.join("\n"));
  assert.notEqual(copy.app.sha384, (await treeRecord()).app.sha384, "another bundle than the tree's");
  for (const m of MARKERS) {
    const rec = await treeRecord(plantedFetch(localFetch, (js) => dropRule(js, ruleOf(m))));
    assert.equal(rec.app.markers[m], 0, m);
    if (m in RULE_OF) for (const o of MARKERS) if (o !== m) assert.equal(rec.app.markers[o], answers.good.app.markers[o], `${m}: ${o} kept`);
    assert.deepEqual(BAD(rec), [MARKS], m);
  }
});

test("the committed build in this tree passes with both providers' answers replayed and a fresh random id", async () => {
  const state = {};
  const rec = await probe(SIGN_ORIGIN, localFetch, fakeRpc(state));
  assert.equal(judge(rec).pass, true, judge(rec).lines.join("\n"));
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

// the page's wiring (src/pool-restore.ts readDepositIds): each id on the run's signal, read on past an unread one
// (card restore-first-sign-in-under-two-minutes, review P2-2 of 53f5e92f; the stop that kept the first error and threw
// it at every read after is gone)
test("ids_stop matches each id read on the run's signal through the kept reader, nothing kept between reads, never another", () => {
  const n = (text, k) => [...text.matchAll(MARK[k])].length;
  // since that card's sign out fix (first in release 115) each read is waited on through letGo (WG) on the same signal
  const line = (o = {}) => {
    const x = { sig: "i", rd: "u", check: "i", call: "WG(u(e,t),i)", open: "WG(zW(Nw,n.rpcs,r,{...n.opts,signal:i}),i)", held: "WG(f(e),i)", ...o };
    return `let{rpcs:c,pass:l,reader:${x.rd}}=${x.open === "" ? "" : "await "}${x.open.replace("signal:i", `signal:${x.sig}`)},f=await WG(BW(Nw,c,l,{...n.opts,signal:i}),i),p=e=>${x.held},m=async(e,t)=>(${x.check}.throwIfAborted(),${x.call}),q=1`;
  };
  assert.equal(n(line(), "ids_stop"), 1);
  assert.equal(n(line({ check: "o" }), "ids_stop"), 0, "another signal checked");
  assert.equal(n(line({ call: "WG(c(e,t),i)" }), "ids_stop"), 0, "another reader");
  assert.equal(n(line({ call: "WG(u(e),i)" }), "ids_stop"), 0, "the index dropped");
  assert.equal(n(line({ call: "u(e,t)" }), "ids_stop"), 0, "a read not let go");
  assert.equal(n(line({ call: "WG(u(e,t),o)" }), "ids_stop"), 0, "a read let go on another signal");
  assert.equal(n(line({ call: "XG(u(e,t),i)" }), "ids_stop"), 0, "a read let go through another function");
  assert.equal(n(line({ open: "zW(Nw,n.rpcs,r,{...n.opts,signal:i})" }), "ids_stop"), 0, "the reader opened not let go");
  assert.equal(n(line({ held: "f(e)" }), "ids_stop"), 0, "a held read not let go");
  assert.equal(n(`let{rpcs:c,pass:l,reader:u}=await WG(zW(Nw,n.rpcs,r,{...n.opts,signal:i}),i),f=await WG(BW(Nw,c,l,{...n.opts,signal:i}),i),p=e=>WG(f(e),i),m=async(e,t)=>{if(i.throwIfAborted(),o!==void 0)throw o;try{return await WG(u(e,t),i)}catch(e){throw o??=e,e}}`, "ids_stop"), 0, "the stop at the first unread id");
});

// letGo by its body (id_keep binds it): the function step 5's reads are waited on through
test("LET_GO holds letGo's body: a read let go at the signal's end with its reason, its own answer taken otherwise", () => {
  const body = "function WG(e,t){return t.aborted?(e.catch(()=>{}),Promise.reject(t.reason)):new Promise((n,r)=>{let i=()=>r(t.reason);t.addEventListener(`abort`,i,{once:!0}),e.then(n,r).finally(()=>t.removeEventListener(`abort`,i))})}";
  assert.equal(LET_GO(body, "WG"), true);
  assert.equal(LET_GO(body, "XG"), false, "another name");
  assert.equal(LET_GO(body + body, "WG"), false, "two of it");
  assert.equal(LET_GO(body.replace("t.addEventListener(`abort`,i,{once:!0}),", ""), "WG"), false, "never stops at the abort");
  assert.equal(LET_GO(body.replace("r(t.reason)", "n(void 0)"), "WG"), false, "the abort taken as an answer");
  assert.equal(LET_GO(body.replace("e.then(n,r)", "e.then(n,n)"), "WG"), false, "a read's failure taken as an answer");
  assert.equal(LET_GO(body.replace("Promise.reject(t.reason)", "e"), "WG"), false, "an aborted signal waits on the read");
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
// bundle line below is this build's own line with one change, and fails its marker. Card
// restore-first-sign-in-under-two-minutes made each try of step 5 end on its own lists (retry, held, named) after the
// walk's end, the seed gone passed on (SeedGone, sG here) and the unread chain a finding (`named`).
test("ids_end, ids_ux_push and seed_per_use_lock match this build's lines, never a stage that drops reasons, another constant or a run-long lock", () => {
  // ids_end's try line (IDS_END_TRY; ids_end needs it with the walk's end and the finding's op, review P3-5)
  const n = (text, k) => [...text.matchAll(k === "ids_end" ? IDS_END_TRY : MARK[k])].length;
  const good5 = {
    pass: "if(e instanceof sG||t.aborted)throw e;",
    to: "r",
    answered: "r.retry.length===0&&r.held.length===0",
    last: "a=i||n>x.length",
    told: "a?{retry:[],held:[],named:[...r.named,...r.held,...r.retry],tries:n,last:a}:{...r,tries:n,last:a}",
    gone: "!g&&r.named.length===0&&await _(async()=>{let t=await e.store();mG(await t.get(`meta`,`owed/restore-ids`))?.run===y&&await t.delete(`meta`,fG)});return}",
    pause: "if(a)return;await mG(x[n-1],t)}",
  };
  const end = (o = {}) => {
    const x = { ...good5, ...o };
    return `.catch(e=>{${x.pass}${x.to}.retry.push(\`step 5 did not finish: \${e instanceof Error?e.message:\`it threw\`}\`)}),t.throwIfAborted();let i=${x.answered},${x.last};if(await v(${x.told}),i){${x.gone}${x.pause}`;
  };
  assert.equal(n(end(), "ids_end"), 1);
  assert.equal(n(end({ pass: "" }), "ids_end"), 0, "a seed gone retried");
  assert.equal(n(end({ pass: "if(e instanceof sG)throw e;" }), "ids_end"), 0, "an ended signal retried");
  assert.equal(n(end({ to: "x" }), "ids_end"), 0, "the catch pushes to another try's lists");
  assert.equal(n(end({ answered: "r.retry.length===0" }), "ids_end"), 0, "answered with money read apart left");
  assert.equal(n(end({ answered: "r.retry.length<2&&r.held.length===0" }), "ids_end"), 0);
  assert.equal(n(end({ last: "a=i||n>=x.length" }), "ids_end"), 0, "a try fewer");
  assert.equal(n(end({ told: "a?{retry:[],held:[],named:[...r.named,...r.retry],tries:n,last:a}:{...r,tries:n,last:a}" }), "ids_end"), 0, "the last try drops held");
  assert.equal(n(end({ told: "a?{retry:[],held:[],named:[...r.named,...r.held],tries:n,last:a}:{...r,tries:n,last:a}" }), "ids_end"), 0, "the last try drops what is unread (silent: review P2-2)");
  assert.equal(n(end({ told: "a?{retry:r.retry,held:[],named:[...r.named,...r.held],tries:n,last:a}:{...r,tries:n,last:a}" }), "ids_end"), 0, "the 53f5e92f end: unread kept off the finding");
  assert.equal(n(end({ told: "a?{retry:[],held:r.held,named:[...r.named,...r.held,...r.retry],tries:n,last:a}:{...r,tries:n,last:a}" }), "ids_end"), 0, "held told twice");
  assert.equal(n(end({ gone: "!g&&await _(async()=>{let t=await e.store();mG(await t.get(`meta`,`owed/restore-ids`))?.run===y&&await t.delete(`meta`,fG)});return}" }), "ids_end"), 0, "the marker removed with a finding (review P2-1)");
  assert.equal(n(end({ gone: "await _(async()=>{let t=await e.store();mG(await t.get(`meta`,`owed/restore-ids`))?.run===y&&await t.delete(`meta`,fG)});return}" }), "ids_end"), 0, "the marker removed after a failed walk");
  assert.equal(n(end({ gone: "!g&&r.named.length===0&&await _(async()=>{let t=await e.store();await t.delete(`meta`,fG)});return}" }), "ids_end"), 0, "another tab's marker removed (delta review P3-D)");
  assert.equal(n(end({ pause: "return}" }), "ids_end"), 0, "no retry: no pause before the next try (review P3-5)");
  assert.equal(n(end({ pause: "if(a)return;await mG(x[0],t)}" }), "ids_end"), 0, "the pauses not growing");
  assert.equal(n(end({ told: "{...r,tries:n,last:a}" }), "ids_end"), 0, "held never a finding");
  // the branch of a pool whose chain has no U_X reads (its `ux` null): its ids' reasons through the helper by kind, then
  // the unread chain on `named`, with nothing between them, then the next pool
  const ux = (push, head = "let o=r.ux;if(o===null){", sep = ",") =>
    `var hV=\`the pool's own chain is not read for a deposit's money (each id's U_X there), so the restore is not done\`${sep}gW=/x/;function gV(e){}async function vV(e,t,n,r,i){let m=(e,t)=>{};for(let r of t){${head}let a=await fV(e,r.scope,{notes:[...r.notes]},c);n.read?.(r.scope,a),m(r.label,a),${push};continue}let u=1}}var yV={}`;
  assert.equal(n(ux("i.named.push(`${r.label}: ${hV}`)"), "ids_ux_push"), 1);
  assert.equal(n(ux("i.named.push(`${r.label}: ${hV}`)", undefined, ";"), "ids_ux_push"), 1, "the constant alone in its statement");
  assert.equal(n(ux("i.retry.push(`${r.label}: ${hV}`)"), "ids_ux_push"), 0, "the unread chain retried, never told");
  assert.equal(n(ux("i.held.push(`${r.label}: ${hV}`)"), "ids_ux_push"), 0);
  assert.equal(n(ux("i.named.push(`${r.label}: ${hV}`)", "let o=r.ux;if(o!==null){"), "ids_ux_push"), 0, "pushed where the chain has U_X reads");
  assert.equal(n(ux("i.named.push(`${r.label}: ${hV}`)", "let o=r.ux;if(o===null||r.notes.length>0){"), "ids_ux_push"), 0, "another condition beside the chain's");
  assert.equal(n(ux("i.named.push(`${r.label}: ${hV}`)", "let o=x.ux;if(o===null){"), "ids_ux_push"), 0, "another pool's reads");
  assert.equal(n(ux("i.named.push(`${r.label}: ${gV}`)"), "ids_ux_push"), 0, "another constant pushed");
  assert.equal(n(ux("i.named.push(`${r.label}: done`)"), "ids_ux_push"), 0);
  assert.equal(n(ux("r.notes.length>0&&i.named.push(`${r.label}: ${hV}`)"), "ids_ux_push"), 0, "a condition before the U_X push");
  assert.equal(n(ux("i.named.push(`${x.label}: ${hV}`)"), "ids_ux_push"), 0, "another pool's label");
  const lock = (check, mark, zero, use, cls = ["sG", "sG"]) =>
    `d=n=>r().request(Io,{mode:\`shared\`,signal:t},async()=>{if(t.throwIfAborted(),${check})throw new ${cls[0]}(\`signed out during the restore\`);let r=await e.seed64();try{let e=re(We,c,r);if(u===null)u=e;else{let t=e.length===u.length&&e.every((e,t)=>e===u[t]);if(e.fill(0),!t)throw new ${cls[1]}(\`${mark}\`)}return await n(r)}finally{${zero}}}),${use}`;
  const good = ["!await e.signedIn()", "other words were signed in during the restore", "r.fill(0)", "f=e=>d(async t=>e(t))"];
  assert.equal(n(lock(...good), "seed_per_use_lock"), 1);
  assert.equal(n(lock(...good).replace("throw new sG(`signed out", "throw Error(`signed out"), "seed_per_use_lock"), 0, "a sign out a plain error, which a try retries");
  assert.equal(n(lock(...good, ["sG", "Error"]), "seed_per_use_lock"), 0, "other words another class than a sign out");
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

// card wallet-id-reader-paced (review of 31be751d, P2-3): busy_wait, pair_wrong, id_keep and id_signout on the
// committed build itself (packages/signpage/public/app.js), each planted bundle that build with one change: a number,
// a guard, an always-true or never-true compare, a step dropped, a same-shaped dead copy beside a broken real one. The
// plants find their place by shape, `§` for any name the minifier gave, so they hold from build to build. Each plant
// counts its marker 0, and the good record with that count fails on the markers alone.
const APP = readFileSync(path.join(signBuilt(), "public/app.js"), "utf8"); // made from this tree's sources (never committed)
const rx = (src) => new RegExp(src.replaceAll("§", String.raw`[\w$]+`), "g");
// the build with the one place `src` finds (exactly one) rewritten by `to` (its match, its groups)
const plant = (src, to, text = APP) => {
  const m = [...text.matchAll(rx(src))];
  assert.equal(m.length, 1, `${m.length} places of ${src.slice(0, 90)}`);
  return text.slice(0, m[0].index) + to(m[0][0], m[0].groups ?? {}) + text.slice(m[0].index + m[0][0].length);
};
const swap = (src, from, into) => plant(src, (s) => (assert.ok(s.includes(from), `${s.slice(0, 60)} holds ${from}`), s.replace(from, () => into)));
const planted = (key, text) => {
  const rec = structuredClone(answers.good);
  rec.app.markers[key] = countOf(text, MARK[key]);
  return rec;
};
const PACED = ["busy_wait", "pair_wrong", "id_keep", "id_signout"];
// requestSignal's minified name: `function RS(e,t,n){let r=DL(e,t);return r===null?n:...`
const RS = /function ([\w$]+)\([\w$]+,[\w$]+,[\w$]+\)\{let ([\w$]+)=[\w$]+\([\w$]+,[\w$]+\);return \2===null\?/.exec(APP)[1];
// asked() whole, from its head to its loop's end, and readId() whole: each found by shape
const ASKED = String.raw`async function (?<n>§)\(§,§,§\)\{let §=§\(§\.name\),§=!§\(§\),§=0,§=0,§=0;for\(;;\)\{[^]*?\.signal\)\}\}\}`;
const READ = String.raw`async function (?<n>§)\(§\)\{let §=§\(\)===0\?0:1,[^]*?return\[§,!0\]\}\}`;

test("busy_wait, pair_wrong, id_keep and id_signout: this build's bundle holds each once, and the recorded good answer counts each", () => {
  for (const k of PACED) {
    assert.equal(countOf(APP, MARK[k]), 1, k);
    assert.equal(answers.good.app.markers[k], 1, k);
  }
});

const PLANTS = [
  // the pace by value
  ["busy_wait", "PACE: FastNEAR at 2.5 a second (the rate that earned its 3-minute block)", () => swap("fastnear:Object\\.freeze\\(\\{perSec:\\.39,burst:8\\}\\)", "perSec:.39", "perSec:2.5")],
  ["busy_wait", "PACE: FastNEAR's burst 8 -> 1000", () => swap("fastnear:Object\\.freeze\\(\\{perSec:\\.39,burst:8\\}\\)", "burst:8", "burst:1000")],
  ["busy_wait", "PACE: dRPC at 35 a second", () => swap("drpc:Object\\.freeze\\(\\{perSec:10,burst:20\\}\\)", "perSec:10", "perSec:35")],
  ["busy_wait", "PACE: the helper's seat at 50 a second", () => swap("seat:Object\\.freeze\\(\\{perSec:5,burst:5\\}\\)", "perSec:5", "perSec:50")],
  ["busy_wait", "paceOf: the helper's seat paced as dRPC", () => swap("\\?`fastnear`:§\\.seat===§\\?`seat`:`drpc`\\]", "`seat`:", "`drpc`:")],
  ["busy_wait", "paceOf: no pace for any provider", () => swap("\\?\\{tat:0,every:0,burst:1,floor:0,holes:\\[\\]\\}:\\{tat:0,every:1e3/§\\.perSec,burst:§\\.burst,floor:0,holes:\\[\\]\\}", "every:1e3/", "every:0*")],
  ["busy_wait", "the slot never waits", () => plant(String.raw`function (?<f>§)\((?<a>§),(?<b>§)\)\{let §=\k<a>\.floor-[^}]*\}`, (_, g) => `function ${g.f}(${g.a},${g.b}){return ${g.b}}`)],
  ["busy_wait", "the busy hold holds nothing", () => plant(String.raw`function (?<f>§)\((?<a>§),(?<b>§),(?<c>§)\)\{\k<a>\.floor=Math\.max\([^}]*\}`, (_, g) => `function ${g.f}(${g.a},${g.b},${g.c}){}`)],
  ["busy_wait", "pacedFetch never waits its slot", () => swap(String.raw`,(?<w>§)=§-§;\k<w><=0\|\|await new Promise`, "<=0||", "<=0||!0||")],
  // delta review 4, P2-1 and P3-1: delta review 3's guard (only the queue's tail given back, by float equality), and a
  // give-back with no floor, each in every place it could come back
  ["busy_wait", "an ended wait gives back only the queue's tail (delta review 3's `tat===mine` guard)", () => plant(String.raw`clearTimeout\(§\),(?<g>(?<G>§)\((?<p>§),(?<a>§)\)),§\(§\.reason\)`, (s, g) => s.replace(g.g, () => `${g.p}.tat===${g.a}&&${g.g}`))],
  ["busy_wait", "the slot given back comes off tat below the busy hold's floor (a give-back with no floor)", () => plant(String.raw`(?<p>§)\.holes\.pop\(\),\k<p>\.tat=Math\.max\(\k<p>\.tat-\k<p>\.every,\k<p>\.floor\)`, (_, g) => `${g.p}.holes.pop(),${g.p}.tat=${g.p}.tat-${g.p}.every`)],
  ["busy_wait", "the give-back's tail loop never stops at the busy hold's floor", () => swap(String.raw`>\.001\|\|§\.tat<=§\.floor\)break`, "||", "&&")],
  ["busy_wait", "the busy hold sets no floor (delta review 3's hold)", () => plant(String.raw`\{(?<h>§)\.floor=Math\.max\(\k<h>\.floor,(?<x>§\+§\+\(\k<h>\.burst-1\)\*\k<h>\.every)\),\k<h>\.tat=Math\.max\(\k<h>\.tat,\k<h>\.floor\)\}`, (_, g) => `{${g.h}.tat=Math.max(${g.h}.tat,${g.x})}`)],
  ["busy_wait", "a slot given back is taken inside a busy hold", () => swap(String.raw`\|\|(?<k>§)\.holes\[0\]<§\);\)\k<k>\.holes\.shift\(\)`, "||", "&&!1||")],
  ["busy_wait", "a slot given back is never taken", () => swap(String.raw`if\(§!==void 0\)return §;§\.tat=Math\.max`, "!==void 0", "!==void 0&&!1")],
  ["busy_wait", "the queue's tail found by float equality (delta review 4: about 1.2% of tails missed)", () => plant(String.raw`Math\.abs\((?<l>§)-\((?<x>§\.tat-§\.burst\*§\.every)\)\)>\.001`, (_, g) => `${g.l}!==${g.x}`)],
  // delta review 4, P3-2: a given sleep with no clock of its own is refused, never given one per options build
  ["busy_wait", "a given sleep without its clock is not refused", () => swap(String.raw`if\((?<l>§)!==void 0&&§\.now===void 0\)throw`, "!==void 0&&", "!==void 0&&!1&&")],
  // delta review 2, P1: the deadline from the slot on, the slot given back
  ["busy_wait", "an ended wait keeps its slot (none given back)", () => plant(String.raw`clearTimeout\(§\),(?<g>§\(§,§\),)§\(§\.reason\)`, (s, g) => s.replace(g.g, ""))],
  ["busy_wait", "the slot given back takes no time back", () => swap(String.raw`(?<p>§)\.holes\.pop\(\),\k<p>\.tat=Math\.max\(\k<p>\.tat-\k<p>\.every,\k<p>\.floor\)`, "-", "-0*")],
  ["busy_wait", "pacedFetch sends the caller's signal with no deadline of its own", () => swap(String.raw`return §\(§,\{\.\.\.§,signal:§\?AbortSignal\.any\(\[§,§\]\):§\}\)`, "signal:", "signal:void 0??")],
  ["busy_wait", "a reader on a pacedFetch keeps its own deadline (it runs in the queue)", () => swap(String.raw`=\(§,§\)=>§\(§\)\?null:§;function`, "?null:", "?(null,1e4):")],
  ["busy_wait", "relayRpc hands nearRpc its own 10 s deadline", () => plant(String.raw`=(?<nr>§)\((?<u>§),(?<fx>§),§\(\k<fx>,(?<tm>§)\)\);return §\(\{name:§\.name,query:\(`, (s, g) => s.replace(/,[\w$]+\([\w$]+,[\w$]+\)\);return/, `,${g.tm});return`))],
  // delta review 3, P2-2: each reader's request back to its own 10 s deadline (it runs in the pace queue again)
  ...[0, 1, 2, 3, 4].map((k) => ["busy_wait", `request ${k + 1} of 5 on requestSignal back to its own 10 s deadline`, () => {
    const sites = [...APP.matchAll(/signal:([\w$]+)\([\w$]+,[\w$]+(?:,[\w$]+)?\)/g)].filter((m) => m[1] === RS);
    assert.equal(sites.length, 5, "five requestSignal sites");
    const m = sites[k];
    return APP.slice(0, m.index) + "signal:AbortSignal.timeout(1e4)" + APP.slice(m.index + m[0].length);
  }]),
  ["busy_wait", "pacedNearRpc hands nearRpc its own 10 s deadline", () => plant(String.raw`=§\(§,§,null\),§=Object\.values\(`, (s) => s.replace(",null)", ",1e4)"))],
  ["busy_wait", "pacedNearRpc's reserve hands nearRpc a fetch with no deadline", () => plant(String.raw`=§\(§,§\(§,§\),null\),§=!1;`, (s) => s.replace(/,[\w$]+\(([\w$]+),[\w$]+\),null\)/, ",$1,null)"))],
  ["busy_wait", "pacedNearRpc asks a 429 once (tries 4 -> 1)", () => swap(String.raw`\)\|\|§\+1>=4\|\|§\?\.aborted\|\|`, ">=4", ">=1")],
  ["busy_wait", "pacedNearRpc waits out a 429 naming any wait (the day cap's 75 s too)", () => swap(String.raw`\|\|§&&\(§\.retryAfterMs\?\?0\)>1e4\)throw`, ">1e4", ">1e9")],
  ["busy_wait", "pacedNearRpc skips a long 429 on every URL, not the seat's alone (dRPC's 30 s ends a buy)", () => plant(String.raw`\|\|§&&\(§\.retryAfterMs\?\?0\)>1e4\)throw`, (s) => s.replace(/^\|\|[\w$]+&&/, "||"))],
  ["busy_wait", "pacedNearRpc's seat flag true for every URL", () => plant(String.raw`=Object\.values\(§\)\.some\(§=>§\.seat===§\),§=async\(`, (s) => s.replace(/^=Object\.values\([\w$]+\)\.some\([\w$]+=>[\w$]+\.seat===[\w$]+\)/, "=!0"))],
  ["busy_wait", "pacedNearRpc's busy wait at most 10 s -> 1e9 ms", () => swap(String.raw`var §=1e4,§=§=>§ instanceof Error&&§\.status===429;`, "1e4", "1e9")],
  ["busy_wait", "pacedNearRpc's busy wait not held on the pace", () => plant(String.raw`;§\(§,performance\.now\(\),§\)\}\},`, () => ";}},")],
  ["busy_wait", "RPC_TIMEOUT_MS 10 s -> 1e9 ms", () => { const to = /function [\w$]+\([\w$]+,[\w$]+=\(\.\.\.[\w$]+\)=>fetch\(\.\.\.[\w$]+\),[\w$]+=([\w$]+)\)\{/.exec(APP)[1]; return swap(String.raw`(?<![\w$.])${to.replace(/[$]/g, "\\$&")}=1e4[,;]`, "1e4", "1e9"); }],
  ["busy_wait", "pacedRpc marks every rpc paced (none takes a slot)", () => swap(String.raw`\{return §\(§\)&&§\.add\(§\),§\}`, "return ", "return 1||")],
  ["busy_wait", "the default sleep resolves at once", () => swap(String.raw`\(\)=>\{§\?\.removeEventListener\(` + "`abort`" + String.raw`,§\),§\(\)\},§\),§=\(\)=>\{clearTimeout\(§\),§\(§\.reason\)\};§\?\.addEventListener\(` + "`abort`" + String.raw`,§,\{once:!0\}\)\}\),§=class extends Error\{retryAfterMs`, "()},", "()},0&&")],
  ["busy_wait", "busyMax by default 60 s -> 6e9 ms (69 days: never met)", () => swap("busyMaxMs\\?\\?6e4", "6e4", "6e9")],
  ["busy_wait", "tries by default 4 -> 1", () => swap("=§\\.tries\\?\\?4,", "??4", "??1")],
  ["busy_wait", "the view's JSON busy check dropped", () => plant(String.raw`is halted \(\$\{§\}\)` + "`" + String.raw`\);(?<c>if\(§\(§\.error\)\)throw new §\(` + "`" + String.raw`\$\{§\.name\}: \$\{§\}: busy` + "`" + String.raw`\);)`, (s, g) => s.replace(g.c, ""))],
  ["busy_wait", "blockHeader's JSON busy check moved into dead code (still two in the build)", () => plant(String.raw`(?<c>if\(§\(§\.error\)\)throw new §\(` + "`" + String.raw`\$\{§\.name\}: \$\{§\}: busy` + "`" + String.raw`\);)let §=§\(§\.error\)&&§\(§\.error\.cause\)\?§\.error\.cause\.name:void 0;if\(` + "`block_id`", (s, g) => s.replace(g.c, "") ).replace("var ", () => `function zzJ(e,n,i){${/if\([\w$]+\([\w$]+\.error\)\)throw new [\w$]+\(`\$\{[\w$]+\.name\}: \$\{[\w$]+\}: busy`\);/.exec(APP)[0]}}var `)],
  ["busy_wait", "a Retry-After of 0 waits 0 (no 500 ms or pace floor)", () => swap(String.raw`Math\.max\(§\.retryAfterMs\?\?Math\.min\(8e3,500\*2\*\*§\),500,§\.every\)`, ",500,", ",0*")],
  ["busy_wait", "busy tries not capped", () => swap(String.raw`if\(\+\+§>120\|\|`, ">120||", ",")],
  ["busy_wait", "the request's own time not counted toward the bound", () => plant(String.raw`throw §\.signal\.reason;(?<c>§\+=§\.now\(\)-§;)`, (s, g) => s.replace(g.c, ""))],
  ["busy_wait", "another function: real asked() busy-blind, a same-shaped dead copy beside it", () => plant(ASKED, (s, g) => s.replace(/if\(([\w$]+)!==null\)\{/, "if($1!==null&&!1){") + s.replace(`async function ${g.n}(`, "async function zzA("))],
  ["busy_wait", "the setup's views bypass asked()", () => plant(String.raw`=\((?<a>§),(?<b>§),(?<c>§),(?<d>§)\)=>§\(\k<a>,(?<s>§)=>(?<v>§)\(\k<a>,\k<b>,\k<c>,\k<d>,\k<s>\),§\);return\{token:`, (s, g) => `=(${g.a},${g.b},${g.c},${g.d})=>${g.v}(${g.a},${g.b},${g.c},${g.d});return{token:`)],
  ["busy_wait", "a third caller of asked() with no busy wait", () => plant(ASKED, (s, g) => `${s}var zzC=(e,t,n)=>${g.n}(e,t,{...n,busyMax:0});`)],
  // one of the pair is wrong at one block
  ["pair_wrong", "another function: real readId() takes one provider's word, a same-shaped dead copy beside it", () => plant(READ, (s, g) => s.replace(/if\(([\w$]+)\.length===2&&/, "if(!1&&$1.length===2&&").replace(/if\(([\w$]+)\)throw \1\.reason/, "if(!1)throw $1.reason") + s.replace(`async function ${g.n}(`, "async function zzR("))],
  ["pair_wrong", "the state taken after the checks: every id read unused", () => plant(String.raw`let (?<f>§)=§\[0\]\.x;if\(\k<f>===` + "`unused`", (s, g) => s.replace(/=[\w$]+\[0\]\.x;/, "=`unused`;"))],
  ["pair_wrong", "readId reads rpcs[0] for both (one provider's word as the pair's)", () => plant(String.raw`=await Promise\.allSettled\(§\.map\((?<p>§)=>§\(§\[\k<p>\],§\)\)\)`, (s, g) => s.replace(`[${g.p}]`, "[0]"))],
  ["pair_wrong", "RANK inverted (the weaker named the liar)", () => swap("\\{unused:0,used:1,money:2\\}", "{unused:0,used:1,money:2}", "{unused:2,used:1,money:0}")],
  ["pair_wrong", "readId ranks by another table than RANK", () => plant(String.raw`=(?<r>§)\[(?<o>§)\[0\]\.x\]>\k<r>\[\k<o>\[1\]\.x\]`, (s, g) => s.replaceAll(`${g.r}[`, "({unused:0,used:1,money:2})["))],
  ["pair_wrong", "step 5's catch takes a disagreement as unused (the id skipped, never named unread)", () => plant(String.raw`\}catch\((?<e>§)\)\{if\(§\.signal\?\.aborted\)throw \k<e>;`, (s, g) => `${s}if(${g.e} instanceof Error&&${g.e}.name===\`PairDisagrees\`)continue;`)],
  ["pair_wrong", "step 5's catch counts a read unread after the run's signal ended", () => plant(String.raw`\}catch\((?<e>§)\)\{if\(§\.signal\?\.aborted\)throw \k<e>;`, () => "}catch(e){")],
  // what a Retry keeps
  ["id_keep", "a kept answer of unused for every id", () => plant(String.raw`let (?<h>§)=(?<k>§)\?\.answers\.get\((?<u>§)\);if\(\k<h>!==void 0\)return \k<h>;`, (s, g) => `let ${g.h}=${g.k}?.answers.get(${g.u});if(${g.k})return\`unused\`;`)],
  ["id_keep", "every answer kept across passes (lasting on any state)", () => plant(String.raw`,(?<b>§)&&(?<x>§)===` + "`used`" + String.raw`&&(?<k>§)\?\.lasting\.add\((?<u>§)\)`, (s, g) => `,${g.k}?.lasting.add(${g.u})`)],
  ["id_keep", "the indexer's used made lasting", () => swap("return\\[`used`,!1\\]", "!1", "!0")],
  ["id_keep", "a new pass drops nothing", () => swap(String.raw`§\.lasting\.has\(§\)\|\|§\.answers\.delete\(§\);`, "||", "||1||")],
  ["id_keep", "a new pass drops everything (31be751d's rule)", () => plant(String.raw`for\(let (?<x>§) of\[\.\.\.(?<k>§)\.answers\.keys\(\)\]\)\k<k>\.lasting\.has\(\k<x>\)\|\|\k<k>\.answers\.delete\(\k<x>\);`, (s, g) => `${g.k}.answers.clear();`)],
  ["id_keep", "keptIdReader opens a new pass on any refusal", () => swap(String.raw`catch\((?<e>§)\)\{if\(!\(\k<e> instanceof §\)\)throw \k<e>\}let`, "if(!(", "if(!1&&!(")],
  ["id_keep", "step 5 reads with a new keep each run", () => plant(String.raw`let\{rpcs:§,pass:§,reader:§\}=await §\(§\(§,§\.rpcs,(?<k>§),\{`, (s, g) => s.replace(`,${g.k},{`, ",{answers:new Map,lasting:new Set},{"))],
  // card restore-first-sign-in-under-two-minutes: the kept reader opened through letGo on the run's signal, letGo its body
  ["id_keep", "step 5's kept reader opened not let go", () => plant(String.raw`let\{rpcs:§,pass:§,reader:§\}=await (?<lg>§)\((?<call>§\(§,§\.rpcs,§,\{\.\.\.§\.opts,signal:(?<sig>§)\}\)),\k<sig>\)`, (s, g) => s.replace(`${g.lg}(${g.call},${g.sig})`, () => g.call))],
  ["id_keep", "letGo never stops at the abort", () => plant(String.raw`Promise\.reject\((?<t>§)\.reason\)\):new Promise\(\((?<n>§),(?<r>§)\)=>\{let (?<l>§)=\(\)=>\k<r>\(\k<t>\.reason\);\k<t>\.addEventListener\(` + "`abort`" + String.raw`,\k<l>,\{once:!0\}\),`, (s, g) => `Promise.reject(${g.t}.reason)):new Promise((${g.n},${g.r})=>{let ${g.l}=()=>${g.r}(${g.t}.reason);`)],
  // signing out drops it
  ["id_signout", "sign out keeps what the restore kept", () => plant(String.raw`signedOut:\(\)=>\{(?<a>§)\?\.abort\(\),§=§\(\)\}`, (s, g) => `signedOut:()=>{${g.a}?.abort()}`)],
  ["id_signout", "sign out makes a new keep nobody reads", () => plant(String.raw`signedOut:\(\)=>\{(?<a>§)\?\.abort\(\),(?<o>§)=(?<f>§)\(\)\}`, (s, g) => `signedOut:()=>{${g.a}?.abort(),zzK=${g.f}()}`)],
];

test("busy waited out, the pair's disagreement, the keep and the sign-out drop: each planted bundle fails on its marker", () => {
  assert.ok(PLANTS.length >= 47, `${PLANTS.length} plants`);
  for (const [key, why, make] of PLANTS) {
    const text = make();
    assert.notEqual(text, APP, why);
    assert.equal(countOf(text, MARK[key]), 0, `${key}: ${why}`);
    assert.deepEqual(BAD(planted(key, text)), [MARKS], why);
  }
});

// card restore-first-sign-in-under-two-minutes: step 5 runs after the walk's end, each try told off its own lists. A
// build that lets a try's catch swallow the seed gone (a sign out, other words), calls a try answered with money read
// apart left (`held`), drops `held` from the last try's findings, throws a plain Error at the seed lock (which the catch
// would then retry), or puts the unread pool chain on the retry list, fails on that one marker alone.
test("a build of this tree whose step 5 end loses a list or retries a seed gone fails, on that marker alone", async () => {
  const RE = { ids_end: IDS_END_TRY, ids_walk_end: IDS_WALK_END, ids_tell: IDS_TELL };
  const within = (marker, from, to) => (js) => {
    const hit = js.match(new RegExp((RE[marker] ?? MARK[marker]).source));
    assert.ok(hit, `${marker} found in the build`);
    const planted = hit[0].replace(from, to);
    assert.notEqual(planted, hit[0], `${marker}: ${from} planted`);
    // a function, so a minified name with `$$` in the planted text stays as built
    return js.replace(hit[0], () => planted);
  };
  const cases = [
    ["ids_end", /if\([\w$]+ instanceof [\w$]+\|\|[\w$]+\.aborted\)throw [\w$]+;/, ""],
    ["ids_end", /&&[\w$]+\.held\.length===0/, ""],
    ["ids_end", /,\.\.\.[\w$]+\.held,/, ","],
    ["ids_end", /,\.\.\.[\w$]+\.retry\]/, "]"],
    ["ids_end", /&&[\w$]+\.named\.length===0&&await/, "&&await"],
    // review P3-5 of 53f5e92f: the walk's end always done, a finding written done, no retry at all
    ["ids_walk_end", /\?`stalled`:`done`/, "?`done`:`done`"],
    ["ids_tell", /stage:`stalled`,txs/, "stage:`done`,txs"],
    ["ids_tell", /if\(![\w$]+\.last\|\|![\w$]+\.finding\)return;/, "return;"],
    ["ids_end", /if\(([\w$]+)\)return;await [\w$]+\([\w$]+\[[\w$]+-1\],[\w$]+\)\}$/, "return}"],
    ["seed_per_use_lock", /throw new [\w$]+\(`signed out/, "throw Error(`signed out"],
    ["seed_per_use_lock", /throw new [\w$]+\(`other words/, "throw Error(`other words"],
    ["ids_ux_push", /\.named\.push\(`\$\{[\w$]+\.label\}: \$\{[\w$]+\}`\);continue\}$/, (s) => s.replace(".named.", ".retry.")],
  ];
  for (const [m, from, to] of cases) {
    const rec = await treeRecord(plantedFetch(localFetch, within(m, from, to)));
    assert.deepEqual(MARKERS.filter((o) => rec.app.markers[o] !== answers.good.app.markers[o]), [RE[m] === undefined || m === "ids_end" ? m : "ids_end"], String(from));
    assert.deepEqual(BAD(rec), [MARKS], String(from));
  }
});
