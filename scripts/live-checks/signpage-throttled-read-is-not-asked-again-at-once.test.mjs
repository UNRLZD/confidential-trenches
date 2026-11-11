// node --test scripts/live-checks/signpage-throttled-read-is-not-asked-again-at-once.test.mjs: the live check replays
// its recorded answers (signpage-throttled-read-is-not-asked-again-at-once.answers.json). good: this card's SIGN_HOST
// build, judged as the PR's bundle checks judge it (no ledger until release-114 is cut), and with a ledger that names
// it: PASS. bad: the SIGN_HOST build of main before this card (a flat wait after every 429, no gate): FAIL, each fact
// named. Planted on the good one: another /app.js, no pin, each mark taken away, a bundle no release list from 114 on
// names: each FAIL. Planted in the bundle's own excerpt (the .excerpt.txt, five pieces cut from the good build's
// public/app.js: the rule and the gate, the wait before a round, the Solana reader's round, the helper route's gate,
// the read's bound): each rule broken in place FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, fixedReleases, judge } from "./signpage-throttled-read-is-not-asked-again-at-once.mjs";

const A = JSON.parse(readFileSync(new URL("./signpage-throttled-read-is-not-asked-again-at-once.answers.json", import.meta.url), "utf8"));
const RULE = "BAD the wait after a throttle is not a pause doubling from 1 s to 10 s with a capped, finite Retry-After when longer";
const GATE = "BAD no provider gate on that rule: a round's throttles not counted once, or its pause set back by one call's answer";
const HELD = "BAD a reader does not wait the gate before a round, or waits past its read's 30 s bound";
const READER = "BAD the holdings reader does not wait the gate before each round, or the helper's route gives it no gate of its own";
const OLD = "BAD the bundle still waits a flat Retry-After or 1 s after every 429: a throttled provider is asked again at once";
const notFixed = (sha) => `BAD SIGN_HOST's /app.js is not a release-114-or-later build: ${sha}`;

test("recorded good answer: this card's build: PASS as the PR's bundle checks judge it, and PASS with a ledger that names it", () => {
  assert.deepEqual(judge(A.good, { ledger: false }), { ok: true, lines: [] });
  assert.deepEqual(judge(A.good, { fixed: new Set([A.good.sha384]) }), { ok: true, lines: [] });
});

test("recorded bad answer: main's build before this card: FAIL, each fact named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [RULE, GATE, HELD, READER, OLD, notFixed(A.bad.sha384)]);
  assert.deepEqual(judge(A.bad, { ledger: false }).lines, [RULE, GATE, HELD, READER, OLD], "its marks fail without the ledger too");
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  const ok = { ledger: false };
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }, ok).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }, ok).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, rule: false }, ok).lines, [RULE]);
  assert.deepEqual(judge({ ...g, gate: false }, ok).lines, [GATE]);
  assert.deepEqual(judge({ ...g, held: false }, ok).lines, [HELD]);
  assert.deepEqual(judge({ ...g, reader: false }, ok).lines, [READER]);
  assert.deepEqual(judge({ ...g, old: true }, ok).lines, [OLD]);
  assert.deepEqual(judge(g, { fixed: new Set() }).lines, [notFixed(g.sha384)]);
  assert.equal(judge(null).ok, false);
});

test("the ledger: no release list from 114 on names either recorded bundle yet", () => {
  const listed = fixedReleases();
  assert.ok(!listed.has(A.bad.sha384));
  assert.ok(!listed.has(A.good.sha384), "this branch's build is cut as a release only after its merge");
});

test("planted in the bundle's excerpt: each rule broken in place FAILs", () => {
  const index = A.good.index;
  const js = readFileSync(new URL("./signpage-throttled-read-is-not-asked-again-at-once.excerpt.txt", import.meta.url), "utf8");
  const f = facts(index, js);
  assert.deepEqual([f.rule, f.gate, f.held, f.reader, f.old], [true, true, true, true, false], "the excerpt holds every rule");
  const at = (re) => {
    const m = re.exec(js);
    assert.ok(m, `${re} is in the excerpt`);
    return m[0];
  };
  const plants = {
    "a pause that never grows": [at(/Math\.min\([\w$]+\*2,/), (s) => s.replace("*2", "*1"), "rule"],
    "a Retry-After of any size": [at(/Math\.min\([\w$]+,[\w$]+\.afterMaxMs\)/), (s) => s.replace(/Math\.min\(([\w$]+),[\w$]+\.afterMaxMs\)/, "$1"), "rule"],
    "a non-finite Retry-After the wait": [at(/typeof [\w$]+==`number`&&Number\.isFinite\([\w$]+\)&&/), (s) => s.replace(/Number\.isFinite\([\w$]+\)&&/, ""), "rule"],
    "a first pause of 0": [at(/firstMs:1e3/), () => "firstMs:0", "rule"],
    "every throttle of a round counted": [at(/if\([\w$]+===this\.#[\w$]+\)\{this\.#[\w$]+\+\+/), (s) => s.replace(/===this\.#[\w$]+\)/, "!==null)"), "gate"],
    "one call's answer sets the pause back": [at(/answered\([\w$]+\)\{[\w$]+===this\.#[\w$]+&&/), (s) => s.replace(/\{[\w$]+===this\.#[\w$]+&&/, "{!0&&"), "gate"],
    "no wait before a round": [at(/await [\w$]+\([\w$]+,[\w$]+\),[\w$]+\?\.throwIfAborted\(\)/), (s) => s.replace(/await [\w$]+\([\w$]+,[\w$]+\),/, ""), "held"],
    "a wait past the read's bound": [at(/if\(Date\.now\(\)\+[\w$]+>[\w$]+\)throw/), (s) => s.replace(/>[\w$]+\)throw/, ">1/0)throw"), "held"],
    "a bound of 60 s": [at(/[\w$]+=3e4[,;]/), (s) => s.replace("3e4", "6e4"), "held"],
    "the reader asks with no wait": [at(/await [\w$]+\([\w$]+\.gate,[\w$]+,[\w$]+,[\w$]+\)/), () => "void 0", "reader"],
    "the route gives no gate": [at(/,gate:new [\w$]+\}/), () => "}", "reader"],
  };
  for (const [name, [from, to, fact]] of Object.entries(plants)) {
    const broken = facts(index, js.replace(from, to(from)));
    assert.equal(broken[fact], false, name);
    assert.equal(judge(broken, { ledger: false }).ok, false, name);
  }
  // the old flat wait put back beside the rule
  const old = facts(index, `${js}const waitAfter=(e,t)=>Math.max(t(),Math.min(e instanceof yB&&e.afterMs!==null?e.afterMs:0,OB));`);
  assert.equal(old.old, true);
  assert.equal(judge(old, { ledger: false }).ok, false);
});
