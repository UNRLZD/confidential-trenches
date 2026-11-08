// node --test scripts/live-checks/pool-senders-next-page.test.mjs: the live check replays its recorded answers
// (pool-senders-next-page.answers.json). good: this card's SIGN_HOST build, release-92: PASS. bad: SIGN_HOST's
// release-91 page: FAIL, each fact named. Planted on the good one: another /app.js, no pin, each mark taken away, a
// bundle no release list from 92 on names: each FAIL. Planted in this tree's bundle: the window rule broken in place
// (either tree near, no keeps clause, another window) and the fallback broken in place (no catch, a catch of every
// error, no six after it): each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, foldedReleases, judge } from "./pool-senders-next-page.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-senders-next-page.answers.json", import.meta.url), "utf8"));
const NO_WINDOW = "BAD a partial sell names the next pages with a tree far from its page's end: a deposit landing first opens a page the sell does not name, and the sell fails";
const NO_FALLBACK = "BAD a sell whose eight is refused is not built again as the six: a sell inside the reserve's band is refused";
const notFolded = (sha) => `BAD SIGN_HOST's /app.js is not a release-92-or-later build: ${sha}`;

test("recorded good answer: this card's build, release-92: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST's release-91: FAIL, each fact named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_WINDOW, NO_FALLBACK, notFolded(A.bad.sha384)]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins", notFolded("sha384-other")]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, window: false }).lines, [NO_WINDOW]);
  assert.deepEqual(judge({ ...g, fallback: false }).lines, [NO_FALLBACK]);
  assert.deepEqual(judge(g, { folded: new Set() }).lines, [notFolded(g.sha384)]);
  assert.equal(judge(null).ok, false);
});

test("the ledger: the good bundle is a release-92 list's, the bad one (release-91) is below it; the PR build's run reads no ledger", () => {
  assert.ok(foldedReleases().has(A.good.sha384));
  assert.ok(!foldedReleases().has(A.bad.sha384));
  assert.deepEqual(judge({ ...A.good, sha384: A.bad.sha384, index: A.bad.index }, { ledger: false }).lines, []);
});

test("planted in this tree's bundle: the window rule or the fallback broken in place FAILs", () => {
  const index = readFileSync(new URL("../../packages/signpage/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../../packages/signpage/public/app.js", import.meta.url), "utf8");
  const f = facts(index, js);
  assert.equal(f.window, true, "this tree's bundle holds the window rule");
  assert.equal(f.fallback, true, "this tree's bundle holds the fallback");
  const at = (re) => {
    const m = re.exec(js);
    assert.ok(m, `${re} is in the bundle`);
    return m;
  };
  const w = at(/\(!([\w$]+)\|\|([\w$]+)\(([\w$]+)\.stateSize\)&&\2\(\3\.labelSize\)\)/);
  const plants = {
    "either tree near": [w[0], w[0].replace(")&&", ")||")],
    "no keeps clause (release-91's shape)": [w[0], ""],
    "another window": [at(/=>[\w$]+-[\w$]+%[\w$]+<=64,/)[0], at(/=>[\w$]+-[\w$]+%[\w$]+<=64,/)[0].replace("<=64", "<=128")],
  };
  for (const [name, [from, to]] of Object.entries(plants)) assert.equal(facts(index, js.replace(from, to)).window, false, name);
  const t = at(/if\(([\w$]+)\)try\{([\w$]+)=await ([\w$]+)\(!0\)\}catch\(([\w$]+)\)\{if\(!\(\4 instanceof [\w$]+\|\|\4 instanceof [\w$]+\)\)throw \4\}/);
  const six = at(/=([\w$]+)\?\?await ([\w$]+)\(!1\)/);
  const breaks = {
    "no catch": [t[0], `if(${t[1]})${t[2]}=await ${t[3]}(!0);`],
    "a catch of every error": [t[0], `if(${t[1]})try{${t[2]}=await ${t[3]}(!0)}catch{}`],
    "no six after it": [six[0], `=${six[1]}`],
  };
  for (const [name, [from, to]] of Object.entries(breaks)) assert.equal(facts(index, js.replace(from, to)).fallback, false, name);
});
