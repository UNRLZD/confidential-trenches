// node --test scripts/live-checks/sol-settle-failed-is-not-unspent.test.mjs: the live check replays its recorded answers
// (sol-settle-failed-is-not-unspent.answers.json). good: recorded from the SIGN_HOST build of card
// signpage-throttled-read-is-not-asked-again-at-once, judged as the PR's bundle checks judge it (no ledger until
// release-115 is cut), and with a ledger that names it: PASS. bad: SIGN_HOST's release-110 (its settle's throw read as
// unspent): FAIL, each fact named. Planted on the good one: another /app.js, no pin, each mark taken away, a bundle no
// release list from 115 on names: each FAIL. Planted in the bundle's own excerpt (sol-settle-failed-is-not-unspent
// .excerpt.txt, two pieces cut from the good build's public/app.js: pastAt through the unlanded reads, and the page's
// buy and withdraw settles): each rule broken in place FAILs, release-114's two-argument pastAt among them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, fixedReleases, judge } from "./sol-settle-failed-is-not-unspent.mjs";

const A = JSON.parse(readFileSync(new URL("./sol-settle-failed-is-not-unspent.answers.json", import.meta.url), "utf8"));
const SETTLE = "BAD a pool send's settle that throws is not held as not known yet, or is not asked with the slots it is handed";
const VERDICT = "BAD a pool send answers not_landed on a settle that did not return unspent at the slots of the read that saw its blockhash past: a landed buy or withdraw part may be told it never happened";
const HOSTS = "BAD the page's buy and withdraw settles do not hand the verdict's slots to solanaSettleSpent: seats from before the spend may answer unspent";
const OLD = "BAD the bundle still reads a settle's throw as unspent";
const notFixed = (sha) => `BAD SIGN_HOST's /app.js is not a release-115-or-later build: ${sha}`;

test("recorded good answer: this card's build: PASS as the PR's bundle checks judge it, and PASS with a ledger that names it", () => {
  assert.deepEqual(judge(A.good, { ledger: false }), { ok: true, lines: [] });
  assert.deepEqual(judge(A.good, { fixed: new Set([A.good.sha384]) }), { ok: true, lines: [] });
});

test("recorded bad answer: SIGN_HOST's release-110: FAIL, each fact named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [SETTLE, VERDICT, HOSTS, OLD, notFixed(A.bad.sha384)]);
  assert.deepEqual(judge(A.bad, { ledger: false }).lines, [SETTLE, VERDICT, HOSTS, OLD], "its marks fail without the ledger too");
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  const ok = { ledger: false };
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }, ok).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }, ok).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, settle: false }, ok).lines, [SETTLE]);
  assert.deepEqual(judge({ ...g, verdict: false }, ok).lines, [VERDICT]);
  assert.deepEqual(judge({ ...g, hosts: false }, ok).lines, [HOSTS]);
  assert.deepEqual(judge({ ...g, old: true }, ok).lines, [OLD]);
  assert.deepEqual(judge(g, { fixed: new Set() }).lines, [notFixed(g.sha384)]);
  assert.equal(judge(null).ok, false);
});

test("the ledger: release-110's bundle (the bad answer) is below release-115, and no list names the good one yet", () => {
  const listed = fixedReleases();
  assert.ok(!listed.has(A.bad.sha384));
  assert.ok(!listed.has(A.good.sha384), "this branch's build is cut as a release only after its merge");
  // a list from release-110 on names it, and none from release-111 on: release-110's served bundle
  assert.ok(fixedReleases(undefined, 110).has(A.bad.sha384), "the bad answer is release-110's served bundle");
});

test("planted in the bundle's excerpt: each rule broken in place FAILs", () => {
  const index = A.good.index;
  const js = readFileSync(new URL("./sol-settle-failed-is-not-unspent.excerpt.txt", import.meta.url), "utf8");
  const f = facts(index, js);
  assert.deepEqual([f.settle, f.verdict, f.hosts, f.old], [true, true, true, false], "the excerpt holds every rule");
  const at = (re) => {
    const m = re.exec(js);
    assert.ok(m, `${re} is in the excerpt`);
    return m[0];
  };
  const thrown = at(/\.then\(([\w$]+)=>\1\.kind===`spent`,\(\)=>null\)/);
  const call = at(/\.settle\([\w$]+\.noteId,[\w$]+\)/);
  const verdict = at(/else if\([\w$]+===!1&&[\w$]+!==null\)/);
  const asked = at(/=await [\w$]+\([\w$]+\?\?void 0\)/);
  const past = at(/\?[\w$]+\([\w$]+\?\.absoluteSlot\):null/);
  const handed = at(/=await [\w$]+\([\w$]+\.rpcs,[\w$]+,[\w$]+\)/);
  const failed = at(/catch\(([\w$]+)\)\{return ([\w$]+)\?\.\(\1\),null\}\}/);
  const head = at(/async function [\w$]+\([\w$]+,[\w$]+,[\w$]+\)\{try\{/);
  const plants = {
    "a thrown settle read as unspent (the old catch)": [thrown, thrown.replace("()=>null", "()=>!1"), "settle"],
    "a thrown settle read as unspent (release-110's shape)": [thrown, ".catch(()=>({kind:`unspent`})).then(e=>e.kind===`spent`)", "old"],
    "the settle asked with no slots": [call, call.replace(/,[\w$]+\)$/, ")"), "settle"],
    "not known treated as unspent at the verdict": [verdict, verdict.replace(/===!1/, "!==!0"), "verdict"],
    "the verdict's settle not handed the past read's slots": [asked, asked.replace(/\([\w$]+\?\?void 0\)/, "()"), "verdict"],
    "the height handed as the slot": [past, past.replace("absoluteSlot", "blockHeight"), "verdict"],
    "pastAt asked with no slow-down": [handed, handed.replace(/,[\w$]+\)$/, ")"), "verdict"],
    "a failed read taken as past": [failed, failed.replace(/,null\}\}$/, ",[0,0]}}"), "verdict"],
    "release-114's pastAt (two arguments, a throw read silently)": [`${head}${js.slice(js.indexOf(head) + head.length, js.indexOf(failed))}${failed}`, `${head.replace(/,[\w$]+\)\{try\{$/, "){try{")}${js.slice(js.indexOf(head) + head.length, js.indexOf(failed))}catch{return null}}`, "verdict"],
    "a host that drops the slots": [at(/program:[\w$]+\.program,minSlots:[\w$]+,rpcs:/), "program:n.program,rpcs:", "hosts"],
  };
  for (const [name, [from, to, fact]] of Object.entries(plants)) {
    const broken = facts(index, js.replace(from, to));
    assert.equal(broken[fact], fact === "old", name);
    assert.equal(judge(broken, { ledger: false }).ok, false, name);
  }
});

test("the buy's settle pair named by its kind at the call (card sell-right-after-a-buy: settleRpcs(kind)) still hands the slots; with the slots dropped in that shape: FAIL", () => {
  const index = A.good.index;
  const js = readFileSync(new URL("./sol-settle-failed-is-not-unspent.excerpt.txt", import.meta.url), "utf8");
  const host = /(noteId:[\w$]+,program:[\w$]+\.program,minSlots:[\w$]+,rpcs:[\w$]+)\(\)/.exec(js);
  assert.ok(host, "a host's settle call is in the excerpt");
  const kinded = js.replace(host[0], `${host[1]}(u)`);
  assert.equal(facts(index, kinded).hosts, true, "rpcs:x(u) is the settle pair of the buy's kind");
  assert.equal(facts(index, kinded.replace(/minSlots:[\w$]+,rpcs:[\w$]+\(u\)/, "rpcs:x(u)")).hosts, false, "that call with no slots");
});
