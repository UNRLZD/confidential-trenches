// node --test scripts/live-checks/signpage-throttled-read-is-not-asked-again-at-once.test.mjs: the live check replays
// its recorded answers (signpage-throttled-read-is-not-asked-again-at-once.answers.json). good: this card's SIGN_HOST
// build, judged as the PR's bundle checks judge it (no ledger until release-115 is cut), and with a ledger that names
// it: PASS. bad: the SIGN_HOST build of main before this card (a flat wait after every 429, no gate): FAIL, each fact
// named. Planted on the good one: another /app.js, no pin, each mark taken away, a bundle no release list from 115 on
// names: each FAIL. Planted in the bundle's own excerpt (the .excerpt.txt, eight pieces cut from the good build's
// public/app.js: the rule and the gate, the wait before a round, the round in the gate's turn, a call's throttle told
// to the gate, the Solana reader's round, the helper route's gate, the read's bound, the list's one bound): each rule
// broken in place FAILs, by its name. The rule and the gate re-cut from card signpage-throttled-provider-has-a-spare's
// build (its doubling kept until the quiet time, an answer clearing only the doubt), their names kept. Every piece re-cut
// from card wallets-found-in-one-read's build: the route's 30 s in doubt the bound (held, the gate's doubtMs, its start
// again after the quiet time), the host's pass turn in the round's turn, the route's own gate beside the host's lane,
// and no bound from the list's start; with card pool-sell-legs-side-by-side merged, the refusal past a bound the kit's
// transport fault, and the list's no-bound one name for both its ways of reading.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, fixedReleases, judge } from "./signpage-throttled-read-is-not-asked-again-at-once.mjs";

const A = JSON.parse(readFileSync(new URL("./signpage-throttled-read-is-not-asked-again-at-once.answers.json", import.meta.url), "utf8"));
const RULE = "BAD the wait after a throttle is not a pause doubling from 1 s to 10 s with a capped, finite Retry-After when longer";
const GATE = "BAD no provider gate on that rule: a round's throttles not counted once, its pause set back by one call's answer, its time the wall clock, or no turn given on when a waiter stops";
const HELD = "BAD a reader does not wait the gate until it opens before a round, or waits past its read's bound or 30 s of the route in doubt, or refuses past it as anything but the provider's 429";
const TURN = "BAD a round does not run in the gate's turn, taken before its wait and given back however it ends: two reads at once ask past the gate";
const READER = "BAD the holdings reader does not run each round in its gate's turn with its read's bound, or the helper's route gives it no gate of its own";
const THROTTLED = "BAD a call that draws a 429 does not tell its gate: the gate never closes";
const ANSWERED = "BAD a round that goes through does not tell its gate: the pause never goes back";
const BY = "BAD the list read bounds its Ws from the list's start, or not by the route's 30 s in doubt: a long list is refused for its length, or waits 30 s a W";
const LINES = { rule: RULE, gate: GATE, held: HELD, turn: TURN, reader: READER, throttled: THROTTLED, answered: ANSWERED, by: BY };
const OLD = "BAD the bundle still waits a flat Retry-After or 1 s after every 429: a throttled provider is asked again at once";
const notFixed = (sha) => `BAD SIGN_HOST's /app.js is not a release-115-or-later build: ${sha}`;

test("recorded good answer: this card's build: PASS as the PR's bundle checks judge it, and PASS with a ledger that names it", () => {
  assert.deepEqual(judge(A.good, { ledger: false }), { ok: true, lines: [] });
  assert.deepEqual(judge(A.good, { fixed: new Set([A.good.sha384]) }), { ok: true, lines: [] });
});

test("recorded bad answer: main's build before this card: FAIL, each fact named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [RULE, GATE, HELD, TURN, READER, THROTTLED, ANSWERED, BY, OLD, notFixed(A.bad.sha384)]);
  assert.deepEqual(judge(A.bad, { ledger: false }).lines, [RULE, GATE, HELD, TURN, READER, THROTTLED, ANSWERED, BY, OLD], "its marks fail without the ledger too");
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  const ok = { ledger: false };
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }, ok).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }, ok).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [k, line] of Object.entries(LINES)) assert.deepEqual(judge({ ...g, [k]: false }, ok).lines, [line], k);
  assert.deepEqual(judge({ ...g, old: true }, ok).lines, [OLD]);
  assert.deepEqual(judge(g, { fixed: new Set() }).lines, [notFixed(g.sha384)]);
  assert.equal(judge(null).ok, false);
});

test("the ledger: no release list from 115 on names either recorded bundle yet", () => {
  const listed = fixedReleases();
  assert.ok(!listed.has(A.bad.sha384));
  assert.ok(!listed.has(A.good.sha384), "this branch's build is cut as a release only after its merge");
});

test("planted in the bundle's excerpt: each rule broken in place FAILs", () => {
  const index = A.good.index;
  const js = readFileSync(new URL("./signpage-throttled-read-is-not-asked-again-at-once.excerpt.txt", import.meta.url), "utf8");
  const f = facts(index, js);
  assert.deepEqual([f.rule, f.gate, f.held, f.turn, f.reader, f.throttled, f.answered, f.by, f.old], [true, true, true, true, true, true, true, true, false], "the excerpt holds every rule");
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
    "every throttle of a round counted": [at(/,[\w$]+===this\.#[\w$]+\)\{this\.#[\w$]+\+\+/), (s) => s.replace(/===this\.#[\w$]+\)/, "!==null)"), "gate"],
    "an answer of any epoch clears the doubt": [at(/answered\([\w$]+\)\{[\w$]+===this\.#[\w$]+&&/), (s) => s.replace(/\{[\w$]+===this\.#[\w$]+&&/, "{!0&&"), "gate"],
    // card signpage-throttled-provider-has-a-spare (run 9): one or two answers never set the doubling back; it ends only
    // once the provider has been open its quiet time
    "one call's answer sets the pause back": [at(/answered\([\w$]+\)\{[\w$]+===this\.#[\w$]+&&\(this\.#[\w$]+=!1\)\}/), (s) => s.replace(/=!1\)\}$/, "=0)}"), "gate"],
    "no quiet time: every throttle a first pause again": [at(/<\(this\.#[\w$]+\.quietMs\?\?1e4\)/), () => "<0", "gate"],
    "the doubling never forgotten": [at(/\?this\.#[\w$]+:0;this\.#/), (s) => s.replace(/:0;/, ":1e4;"), "gate"],
    "a throttle that leaves the gate out of doubt": [at(/,this\.#[\w$]+=!0,/), () => ",", "gate"],
    // card wallets-found-in-one-read: the doubt's start, again after the quiet time, and its length
    "the doubt never starts": [at(/&&\(this\.#[\w$]+=this\.#[\w$]+\(\)\),/), () => ",", "gate"],
    "an old doubt never starts again": [at(/\|\|this\.#[\w$]+\(\)-this\.#[\w$]+>=\(this\.#[\w$]+\.quietMs\?\?1e4\)/), () => "", "gate"],
    "the doubt's length on the wall clock": [at(/doubtMs\(\)\{return this\.#[\w$]+\?this\.#[\w$]+\(\)-/), (s) => s.replace(/\?this\.#[\w$]+\(\)-$/, "?Date.now()-"), "gate"],
    "no bound on the route in doubt": [at(/\|\|[\w$]+\.doubtMs\(\)\+[\w$]+>3e4/), () => "", "held"],
    "a doubt bound of 60 s": [at(/\.doubtMs\(\)\+[\w$]+>3e4/), (s) => s.replace("3e4", "6e4"), "held"],
    "no host pass turn in the round's turn": [at(/,[\w$]+&&await [\w$]+\.turn\(`pass`,/), () => ",(0,", "turn"],
    "the gate on the wall clock": [at(/\(\(\)=>performance\.now\(\)\)/), () => "Date.now", "gate"],
    "left() past the longest wait": [at(/left\(\)\{return Math\.min\(/), () => "left(){return (", "gate"],
    "a stopped waiter keeps the turn": [at(/catch\(([\w$]+)\)\{throw [\w$]+\(\),\1\}/), (s) => s.replace(/throw [\w$]+\(\),/, "throw "), "gate"],
    "no wait before a round": [at(/await [\w$]+\([\w$]+,[\w$]+\),[\w$]+\?\.throwIfAborted\(\)/), (s) => s.replace(/await [\w$]+\([\w$]+,[\w$]+\),/, ""), "held"],
    "the gate waited once, not until it opens": [at(/for\(let ([\w$]+)=([\w$]+)\.left\(\);\1>0;\1=\2\.left\(\)\)/), (s) => s.replace(/for\(let ([\w$]+)=([\w$]+)\.left\(\);\1>0;\1=\2\.left\(\)\)/, "for(let $1=$2.left();$1>0;$1=0)"), "held"],
    "no turn taken": [at(/let [\w$]+=await [\w$]+\.turn\([\w$]+\);/), () => "", "turn"],
    "the turn never given back": [at(/finally\{[\w$]+\(\)\}\}/), () => "finally{}}", "turn"],
    "a call's 429 never told to the gate": [at(/[\w$]+\.gate\.throttled\([\w$]+,Math\.max\([\w$]+\.afterMs\?\?0,[\w$]+\.hint\?\.\(\)\?\?0\)\)/), () => "void 0", "throttled"],
    "a whole round never told to the gate": [at(/,[\w$]+\.gate\.answered\([\w$]+\)/), () => "", "answered"],
    "a bound from the list's start": [at(/[,\s;][\w$]+=1\/0;/), (s) => s.replace("1/0", "Date.now()+3e4"), "by"],
    "the reader's round given no bound of its read": [at(/await [\w$]+\([\w$]+\.gate,[\w$]+,/), (s) => s.replace(/\.gate,[\w$]+,/, ".gate,1/0,"), "reader"],
    "a wait past the read's bound": [at(/if\(Date\.now\(\)\+[\w$]+>[\w$]+\|\|/), (s) => s.replace(/>[\w$]+\|\|$/, ">1/0||"), "held"],
    "the refusal past the bound a bare error": [at(/throw new [\w$]+\(`http_429`,`[^`]*`,1,`the holdings route`,[\w$]+\)/), (s) => s.replace(/throw new [\w$]+\(`http_429`,(`[^`]*`),1,`the holdings route`,[\w$]+\)/, "throw Error($1)"), "held"],
    "a bound of 60 s": [at(/[\w$]+=3e4[,;]/), (s) => s.replace("3e4", "6e4"), "held"],
    "the reader's round outside the turn": [at(/await [\w$]+\(([\w$]+)\.gate,/), (s) => s.replace(/\(([\w$]+)\.gate,/, "($1.other,"), "reader"],
    "the route gives no gate": [at(/,gate:new [\w$]+,lane:[^}]*\}/), () => "}", "reader"],
    "the route's gate the host's lane's": [at(/,gate:new [\w$]+,lane:([^}]*)\}/), (s) => s.replace(/gate:new [\w$]+,lane:([^}]*)\}$/, "gate:$1.gate,lane:$1}"), "reader"],
  };
  for (const [name, [from, to, fact]] of Object.entries(plants)) {
    const broken = facts(index, js.replace(from, to(from)));
    assert.equal(broken[fact], false, name);
    const v = judge(broken, { ledger: false });
    assert.equal(v.ok, false, name);
    if (LINES[fact]) assert.ok(v.lines.includes(LINES[fact]), `${name}: FAIL by its name`);
  }
  // the old flat wait put back beside the rule
  const old = facts(index, `${js}const waitAfter=(e,t)=>Math.max(t(),Math.min(e instanceof yB&&e.afterMs!==null?e.afterMs:0,OB));`);
  assert.equal(old.old, true);
  assert.equal(judge(old, { ledger: false }).ok, false);
});
