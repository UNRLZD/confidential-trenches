// node --test scripts/live-checks/held-move-forgotten-tx.test.mjs: the live check's verdict on its recorded answers, with
// no network. Each record is a real run of the check (2026-11-08), each archival host asked with Origin SIGN_ORIGIN:
// - good: this card's build (index.html, public/app.js and public/_headers at the card's branch, --local), with both
//   archival hosts' real reads of the 7 Nov mainnet tx and its block: PASS;
// - bad_live_before: the live SIGN_HOST before this card's release, whose CSP reaches no archival RPC and whose bundle
//   reads none: FAIL on the CSP and the markers alone (its archival reads are the same real answers);
// - bad_pre_fold: f0f8f02c's build (before the delta reviews of c3e71713), which takes a part of the archival list and
//   reads Moved with money in U: FAIL on the markers alone, its whole-list rule and the one rule's four lines missing;
// - bad_pre_r3: 7ea3cbcf's build (before delta review 3), which reads a tx still running as no word and asks each
//   archival host once: FAIL on the markers alone, the running and retry rules missing;
// - bad_r1: this card's build at e58347da with mutant R1 (landed decided on U's first read): FAIL on U's second read
//   alone, which a mark that does not bind the read's name passed (delta review 6, F3);
// - bad_pre_r4: 28018b8c's build (before delta review 4), which decides landed on U's first read, made before the
//   archival hosts answered: FAIL on the markers alone, U's second read and the running word's place missing;
// - bad_pre_r10: 03e5d66f's build (before delta reviews 9 and 10), which reads no stale status again at the tap and
//   answers Moved for a stranger's dust: FAIL on the markers alone, the tap's re-read and the dust floor missing;
// - bad_pre_r11: c286db4b's build (before delta review 11), whose dust floor is on the moved amount, not on what U held
//   (the move's amount + 1), so a tap that moved MIN_DEPOSIT - 1 out of MIN_DEPOSIT answers empty: FAIL on the dust
//   floor alone (recorded 2026-11-09; the older builds count 0 of its mark, each committed public/app.js read 9 Nov);
// - and the good record with its integrity naming another script, each marker gone, each archival host out of the
//   CSP, and each host's tx or block answer unknown, failed, another one's, or with no CORS for the page: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ARCHIVAL, HOSTS, judge, localFetch, MARK, MARKERS, OLD_TX, probe, SIGN_ORIGIN } from "./held-move-forgotten-tx.mjs";
import { copyChange, dropRule, plantedFetch } from "./planted-build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "held-move-forgotten-tx.answers.json"), "utf8"));
// the BAD lines, with the verdict checked to agree (a verdict that passes with a BAD line is a bug of its own)
const BAD = (rec) => {
  const v = judge(rec);
  const bad = v.lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0].slice(4));
  assert.equal(v.pass, bad.length === 0, `the verdict agrees with its lines: ${bad.join(", ")}`);
  return bad;
};
// u_second_read was marked after these two were recorded: their records have no count for it, and their builds have
// none (each committed public/app.js read 8 Nov 2026 16:0xZ: 0 at f0f8f02c and at 7ea3cbcf)
const RULE = ["list_rule", "landed_at_1", "replaced_above_1", "moved_at_1", "follow_open_above_1", "running_states", "running_live", "archival_retry", "u_second_read", "tap_reread", "dust_floor"];
// delta review 3's rules: what the build before it (7ea3cbcf) lacks
const R3 = ["running_states", "running_live", "archival_retry", "u_second_read", "tap_reread", "dust_floor"];
// delta review 4's: what the build before it (28018b8c) lacks, the running word read after the expired test and U read
// again once the archival hosts answer (delta review 5, item 4)
const R4 = ["running_live", "u_second_read"];
// delta reviews 9 and 10's: what the build before them (03e5d66f) lacks, and so every older one (each committed
// public/app.js read 8 Nov 2026 19:1xZ: 0 of each at f0f8f02c, 7ea3cbcf, 28018b8c, e58347da and 03e5d66f)
const R10 = ["tap_reread", "dust_floor"];
const CSP = "SIGN_HOST's connect-src reaches the archival RPCs";
const MARKS = "/app.js reads a forgotten move on the archival RPCs";
const SAME = "/app.js is the script / names: its sha384 is the integrity";
const TX = (i) => `archival host ${i} reads the 7 Nov tx FINAL and a success, in its block, for the page's origin`;
const BLOCK = (i) => `archival host ${i} serves the tx's block by height, for the page's origin`;
/** Each archival host's answers as the recorded good run read them, with no network; the Origin sent is the page's. */
const archivalOk = async (u, init) => {
  assert.ok(ARCHIVAL.includes(String(u)), String(u));
  assert.equal(init.headers.origin, SIGN_ORIGIN);
  const { method } = JSON.parse(init.body);
  const result = method === "tx"
    ? { final_execution_status: "FINAL", status: { SuccessValue: "" }, transaction: { hash: OLD_TX.hash }, transaction_outcome: { block_hash: OLD_TX.block } }
    : { header: { height: OLD_TX.height, hash: OLD_TX.block } };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200, headers: { "access-control-allow-origin": "*" } });
};

test("the recorded good answer (the card's build and both archival hosts' real reads) passes", () => {
  const r = judge(answers.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
  for (const m of MARKERS) assert.ok(answers.good.app.markers[m] >= 1, m);
  for (const k of HOSTS) {
    assert.equal(answers.good.archival[k].hash, OLD_TX.hash, k);
    assert.equal(answers.good.archival[k].block.hash, OLD_TX.block, k);
  }
});

test("the recorded live SIGN_HOST before the release fails, on the CSP and the markers alone", () => {
  assert.equal(answers.bad_live_before.url, SIGN_ORIGIN);
  assert.equal(judge(answers.bad_live_before).pass, false);
  assert.deepEqual(BAD(answers.bad_live_before), [CSP, MARKS]);
});

test("the recorded f0f8f02c build (a part of the archival list taken, Moved with money in U) fails, on its missing rules alone", () => {
  assert.deepEqual(BAD(answers.bad_pre_fold), [MARKS]);
  assert.deepEqual(MARKERS.filter((m) => !(answers.bad_pre_fold.app.markers[m] >= 1)), RULE);
});

test("the recorded 7ea3cbcf build (before delta review 3: a running receipt read as no word, the archival hosts asked once) fails, on its missing rules alone", () => {
  assert.equal(answers.bad_pre_r3.url, "local build at 7ea3cbcf");
  assert.deepEqual(BAD(answers.bad_pre_r3), [MARKS]);
  assert.deepEqual(MARKERS.filter((m) => !(answers.bad_pre_r3.app.markers[m] >= 1)), R3);
});

test("the recorded 28018b8c build (before delta review 4: landed decided on U's first read, before the archival hosts answered) fails, on its missing rules alone", () => {
  assert.equal(answers.bad_pre_r4.url, "local build at 28018b8c");
  assert.deepEqual(BAD(answers.bad_pre_r4), [MARKS]);
  assert.deepEqual(MARKERS.filter((m) => !(answers.bad_pre_r4.app.markers[m] >= 1)), [...R4, ...R10]);
});

// delta review 6, F3: the mark binds the read's name, so a build deciding landed on U's first read fails it
test("the recorded build of e58347da with mutant R1 (landed decided on U's first read) fails, on U's second read alone", () => {
  assert.equal(answers.bad_r1.url, "local build of e58347da with mutant R1");
  assert.deepEqual(BAD(answers.bad_r1), [MARKS]);
  assert.deepEqual(MARKERS.filter((m) => !(answers.bad_r1.app.markers[m] >= 1)), ["u_second_read", ...R10]);
});

// delta review 10, F5: the build before delta reviews 9 and 10 fails on their two marks alone
test("the recorded build of 03e5d66f (no stale status read again at the tap, dust answered Moved) fails, on those two marks alone", () => {
  assert.equal(answers.bad_pre_r10.url, "local build at 03e5d66f");
  assert.deepEqual(BAD(answers.bad_pre_r10), [MARKS]);
  assert.deepEqual(MARKERS.filter((m) => !(answers.bad_pre_r10.app.markers[m] >= 1)), R10);
});

// delta review 11, F1: the build before it floors the moved amount, and fails on the dust floor alone
test("the recorded build of c286db4b (the dust floor on the moved amount, not on what U held) fails, on the dust floor alone", () => {
  assert.equal(answers.bad_pre_r11.url, "local build at c286db4b");
  assert.deepEqual(BAD(answers.bad_pre_r11), [MARKS]);
  assert.deepEqual(MARKERS.filter((m) => !(answers.bad_pre_r11.app.markers[m] >= 1)), ["dust_floor"]);
});

// delta review 7, item 5: the second read's name is a whole name, so a read into `ac` checked on `c` never matches
test("u_second_read matches a read checked and decided on its own whole name, never on a name that only ends it", () => {
  const tail = (v) => `=await lM(e,n.to,t,r).catch(()=>null);if(${v}===null)return\`live\`;if(s===\`ok\`&&${v}.usdc<=1n)return\`landed\``;
  const n = (text) => [...text.matchAll(MARK.u_second_read)].length;
  assert.equal(n(`let a=1,c${tail("c")}`), 1);
  assert.equal(n(`let a=1,ac${tail("c")}`), 0);
  assert.equal(n(`let a=1,c${tail("o")}`), 0);
});

test("the good record with another script's integrity, one marker gone, one archival host out of the CSP, or one host's read not what the page needs fails", () => {
  const other = structuredClone(answers.good);
  other.index.integrity = answers.bad_live_before.index.integrity;
  assert.deepEqual(BAD(other), [SAME]);
  for (const m of MARKERS) {
    const gone = structuredClone(answers.good);
    gone.app.markers[m] = 0;
    assert.deepEqual(BAD(gone), [MARKS], m);
  }
  for (const h of ARCHIVAL) {
    const out = structuredClone(answers.good);
    out.connect_src = out.connect_src.split(" ").filter((x) => x !== h).join(" ");
    assert.deepEqual(BAD(out), [CSP], h);
  }
  HOSTS.forEach((k, i) => {
    const good = answers.good.archival[k];
    for (const [why, a] of [
      ["unknown", { http: 200, acao: "*", error: "UNKNOWN_TRANSACTION", block: good.block }],
      ["failed", { ...good, success: false }],
      ["not final", { ...good, final_execution_status: "EXECUTED_OPTIMISTIC" }],
      ["another tx", { ...good, hash: "11111111111111111111111111111111" }],
      ["another block", { ...good, block_hash: "11111111111111111111111111111111" }],
      ["a 429", { http: 429, error: "error", block: good.block }],
      ["no answer", { error: "TimeoutError", block: good.block }],
      ["CORS for another origin", { ...good, acao: "https://example.com" }],
      ["no CORS", { ...good, acao: undefined }],
    ]) {
      const r = structuredClone(answers.good);
      r.archival[k] = a;
      assert.deepEqual(BAD(r), [TX(i)], `${k} ${why}`);
    }
    for (const [why, b] of [
      ["another height", { ...good.block, height: OLD_TX.height + 1 }],
      ["another hash", { ...good.block, hash: "11111111111111111111111111111111" }],
      ["UNKNOWN_BLOCK", { http: 200, acao: "*", error: "UNKNOWN_BLOCK" }],
      ["no CORS", { ...good.block, acao: undefined }],
    ]) {
      const r = structuredClone(answers.good);
      r.archival[k] = { ...good, block: b };
      assert.deepEqual(BAD(r), [BLOCK(i)], `${k} ${why}`);
    }
    const none = structuredClone(answers.good);
    delete none.archival[k];
    assert.deepEqual(BAD(none), [TX(i), BLOCK(i)], `${k} not read`);
  });
});

// card held-move-replay-any-build: the tree's build is read with the check's own reader (probe over localFetch) and
// judged with the live rule; of the recorded good answer only the archival hosts' reads are kept, so any build of this
// tree that keeps the rule passes with no re-record, and one that drops a rule fails
const treeRecord = async (fetchFn = localFetch) => ({ ...(await probe(SIGN_ORIGIN, fetchFn, archivalOk)), archival: answers.good.archival });

test("the committed build in this tree passes the live rule, with the recorded archival hosts' reads", async () => {
  const rec = await treeRecord();
  assert.equal(judge(rec).pass, true, judge(rec).lines.join("\n"));
  assert.equal(judge(await probe(SIGN_ORIGIN, localFetch, archivalOk)).pass, true, "and with the archival hosts' answers replayed");
});

test("a rebuilt bundle of this tree with an unrelated copy change passes with no re-record; one that drops a rule fails on it alone", async () => {
  const copy = await treeRecord(plantedFetch(localFetch, (js) => copyChange(js, Object.values(MARK))));
  assert.equal(judge(copy).pass, true, judge(copy).lines.join("\n"));
  assert.notEqual(copy.app.sha384, (await treeRecord()).app.sha384, "another bundle than the tree's");
  for (const m of MARKERS) {
    const rec = await treeRecord(plantedFetch(localFetch, (js) => dropRule(js, MARK[m])));
    assert.equal(rec.app.markers[m], 0, m);
    assert.deepEqual(BAD(rec), [MARKS], m);
  }
});

test("a 429 is asked again after its Retry-After (10 s with none, 30 s at most), and after four asks a 429 is the answer", async () => {
  const waits = [];
  const wait = async (ms) => void waits.push(ms);
  let n = 0;
  const flaky = async (u, init) => (++n === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "2" } }) : archivalOk(u, init));
  assert.equal(judge(await probe(SIGN_ORIGIN, localFetch, flaky, wait)).pass, true);
  assert.deepEqual(waits, [2000]);
  for (const [ra, ms] of [["120", 30_000], [null, 10_000], ["soon", 10_000], ["30", 30_000]]) {
    waits.length = 0;
    let asks = 0;
    const always = async () => (asks++, new Response("{}", { status: 429, headers: ra === null ? {} : { "retry-after": ra } }));
    const rec = await probe(SIGN_ORIGIN, localFetch, always, wait);
    assert.deepEqual(BAD(rec), HOSTS.flatMap((_, i) => [TX(i), BLOCK(i)]), String(ra));
    assert.equal(asks, 4 * 2 * HOSTS.length, `${ra}: four asks of each read (tx and block) on each host`);
    assert.deepEqual(new Set(waits), new Set([ms]), `${ra}: each wait ${ms} ms`);
    assert.equal(waits.length, 3 * 2 * HOSTS.length);
  }
});

test("card pool-deposit-stages: kit_1_6 counts kit-v1.6 read in full (release-94 to 107) or kit-v1.6's own state branch keeping moved_out (kit-v1.7 on), never a page with neither", () => {
  const count = (t) => [...t.matchAll(MARK.kit_1_6)].length;
  assert.equal(count("hl=`1.6`.split(`.`).map(Number)"), 1, "release-107: 1.6 read in full");
  assert.equal(count("function Ol(e,t){if(e===`current`)return t;if(e===`1.6`)return{...t,ops:Dl(t.ops)};"), 1, "kit-v1.7: kit-v1.6's own state branch, its ops through the pool filter only");
  // review P3 2: kit-v1.6's branch stripping moved_out as kit-v1.5's does, or a level with no branch, counts none
  assert.equal(count("if(e===`1.6`)return{...t,ops:Dl(t.ops).map(e=>e.kind===`deposit`?El(e):e)};"), 0, "kit-v1.6 sent with moved_out stripped");
  assert.equal(count("return i(hl[0],hl[1])?`current`:i(1,6)?`1.6`:i(1,5)?`1.5`:`1.4`}"), 0, "the level's name alone");
  assert.equal(count("hl=`1.5`.split(`.`).map(Number);return i(hl[0],hl[1])?`current`:`1.4`}"), 0, "kit-v1.6 read at no level of its own");
  assert.equal(answers.good.app.markers.kit_1_6, 1, "this build: the branch");
});
