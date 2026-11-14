// node --test scripts/live-checks/cash-withdraw-in-app-to-any-chain.test.mjs: the live check replays its recorded
// answers (cash-withdraw-in-app-to-any-chain.answers.json). good: this card's builds: PASS. bad (release 144's builds)
// and liveBefore (both hosts before this card's deploy): FAIL, each fact named. Planted on the good one: each fact taken
// away FAILs, each host's half judged alone, and two hosts that disagree on Cash's chains FAIL. The marks are read from
// minified shapes as the builds write them, each planted here as written.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APP, appFacts, bundle, judge, listOf, read, SAYS, SIGN, signFacts } from "./cash-withdraw-in-app-to-any-chain.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./cash-withdraw-in-app-to-any-chain.answers.json", import.meta.url), "utf8"));
const BEFORE = ["cashHopDest", "appChains", "givenDest", "destTaken", "destRefused", "signChains"].map((k) => `BAD ${SAYS[k]}`);

test("recorded good answer: this card's builds: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(ANSWERS.good.app.cashChains, ["near"]);
  assert.deepEqual(ANSWERS.good.sign.cashChains, ["near"]);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, each fact named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, BEFORE);
  });
}

test("planted on the good answer: each fact taken away FAILs; each host alone; the hosts must agree", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ app: { ...g.app, scripts: 0 } }).lines, [`BAD ${SAYS.scripts}`]);
  assert.deepEqual(judge({ app: { ...g.app, cashHopDest: false } }).lines, [`BAD ${SAYS.cashHopDest}`]);
  for (const k of ["pinned", "givenDest", "destTaken", "destRefused"]) assert.deepEqual(judge({ sign: { ...g.sign, [k]: false } }).lines, [`BAD ${SAYS[k]}`], k);
  // each list: NEAR first, no repeat, only chains Cash reaches through 1Click (never Robinhood)
  for (const l of [null, [], ["solana", "near"], ["near", "near"], ["near", "robinhood"]]) {
    assert.deepEqual(judge({ app: { ...g.app, cashChains: l } }).lines, [`BAD ${SAYS.appChains}`], JSON.stringify(l));
    assert.deepEqual(judge({ sign: { ...g.sign, cashChains: l } }).lines, [`BAD ${SAYS.signChains}`], JSON.stringify(l));
  }
  assert.equal(judge({ app: g.app }).ok, true, "the app's half alone");
  assert.equal(judge({ sign: g.sign }).ok, true, "SIGN_HOST's half alone");
  const wide = ["near", "solana", "base"];
  assert.equal(judge({ app: { ...g.app, cashChains: wide }, sign: { ...g.sign, cashChains: wide } }).ok, true, "both wider, equal");
  assert.deepEqual(judge({ app: { ...g.app, cashChains: wide }, sign: g.sign }).lines, [`BAD ${SAYS.agree}`], "the app offers more than the page sends");
  assert.equal(judge({}).ok, false);
  assert.equal(judge(null).ok, false);
});

// the shapes as the builds write them (this card's, 18:26Z) and as release 144's did
const APP_NOW = "return e.kind===`pool.withdraw`?{kind:`pool.withdraw`,params:{chain:e.chain,...o,...t===e.chain?{}:{dest:t}}}:{kind:`withdraw.open`,params:{...o,...t===`near`?{}:{dest:t}}}}function iL(e){return e.kind===`pool.withdraw`?kv:m}var m=Object.freeze([`near`]),h=1;";
const APP_OLD = "return e.kind===`pool.withdraw`?{kind:`pool.withdraw`,params:{chain:e.chain,...o,...t===e.chain?{}:{dest:t}}}:{kind:`withdraw.open`,params:o}}function eL(e){return e.kind===`pool.withdraw`?Ev:[`near`]}";
const SIGN_NOW = "Ho=Object.freeze([`near`]),x=1;PW=Ho,FW=2;`near`?{dest:t}:{};return e.max===!0?Object.freeze({to:e.to,max:!0,...n}):null;let h=t.network===`mainnet`?t.chains??PW:[`near`],g=i?.dest??`near`,_=h.includes(g),v=i&&_?g:`near`,y=1;C.dataset.refusal=`not-available`,dG(C,`not-available`,lG),C.textContent=`${g===`near`?`NEAR`:NW[g].name} · ${cG[`not-available`]}`";
const SIGN_OLD = "PW=Object.freeze([`near`]),FW=2;return e.max===!0?Object.freeze({to:e.to,max:!0}):null;let h=(t.network===`mainnet`?PW:[`near`]).map(1);T.dataset.refusal=`not-available`,dG(T,`not-available`,_G),T.textContent=`${yG[E]} · ${gG[`not-available`]}`";

test("the facts read from the bundles, as the builds write them", () => {
  assert.deepEqual(appFacts([APP_NOW]), { scripts: 1, cashHopDest: true, cashChains: ["near"] });
  assert.deepEqual(appFacts([APP_OLD]), { scripts: 1, cashHopDest: false, cashChains: null });
  assert.equal(appFacts([APP_NOW.replace("t===`near`?{}:{dest:t}", "t!==`near`?{dest:t}:{}")]).cashHopDest, true, "the other order of the ternary");
  assert.equal(appFacts([APP_NOW.replace("t===`near`?{}:{dest:t}", "t===`near`?{}:{dest:`near`}")]).cashHopDest, false, "a dest not the picked chain");
  assert.deepEqual(appFacts([APP_NOW.replace("Object.freeze([`near`])", "Object.freeze([`near`,`solana`,`base`])")]).cashChains, ["near", "solana", "base"]);
  const idx = (js) => `<script type="module" src="/app.js" integrity="${"sha384-" + b64sha384(js)}"></script>`;
  assert.deepEqual(signFacts(idx(SIGN_NOW), SIGN_NOW), { pinned: true, givenDest: true, destTaken: true, destRefused: true, cashChains: ["near"] });
  assert.deepEqual(signFacts(idx(SIGN_OLD), SIGN_OLD), { pinned: true, givenDest: false, destTaken: false, destRefused: false, cashChains: null });
  assert.equal(signFacts(idx("x"), SIGN_NOW).pinned, false, "a script the index does not pin");
  // the given dest sent on NEAR whatever it is: not taken
  assert.equal(signFacts("", SIGN_NOW.replace("v=i&&_?g:`near`", "v=`near`")).destTaken, false);
  // the pool form's refusal alone (its chain name from a table) is not the Cash form's
  assert.equal(signFacts("", SIGN_OLD).destRefused, false);
  assert.equal(listOf("a=b,b=c,c=d,d=e,e=Object.freeze([`near`]);", "a"), null, "past 3 names");
  assert.deepEqual(listOf("a=b,b=c,c=d,d=Object.freeze([`near`]);", "a"), ["near"]);
});

function b64sha384(js) {
  return createHash("sha384").update(js).digest("base64");
}

test("the read: each host's page and the scripts it names; bundle reads one host", async () => {
  const idx = `<script type="module" src="/app.js" integrity="sha384-${b64sha384(SIGN_NOW)}"></script>`;
  const served = { [`${APP}/`]: '<script type="module" crossorigin src="/assets/i.js"></script>', [`${APP}/assets/i.js`]: APP_NOW, [`${SIGN}/`]: idx, [`${SIGN}/app.js`]: SIGN_NOW };
  const f = async (url) => (served[url] !== undefined ? { status: 200, text: async () => served[url] } : { status: 404, text: async () => "" });
  assert.equal(judge(await read(f)).ok, true);
  assert.deepEqual(Object.keys(await read(f, ["sign"])), ["sign"]);
  assert.equal((await bundle(f, { host: "app" })).ok, true);
  assert.equal((await bundle(f, { host: "sign" })).ok, true);
  served[`${APP}/`] = "<html></html>";
  await assert.rejects(read(f, ["app"]), /names no script/);
});
