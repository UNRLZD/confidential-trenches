// node --test scripts/live-checks/kit-frame-version.test.mjs: the live check replays its recorded answers
// (kit-frame-version.answers.json). good: this card's SIGN_HOST build (packages/signpage/scripts/build-app.mjs bundle(),
// mainnet, at the card's head), which reads the kit's hello, maps every deposit stage down for kit-v1.4 and keeps
// kit-v1.4's twelve state fields: PASS. bad: SIGN_HOST as served on 6 Nov 2026 (release-60, /app.js
// sha384-3AiaXoHZ...), which sends every app everything: FAIL. badNoHello: the good build planted so its handler reads a
// hello and ignores it: FAIL. Planted on the good one: another /app.js, no pin, each piece of the hello's path missing,
// each later stage mapped elsewhere, a refund move mapped to done, a stage kit-v1.4 lacks, a field list with pools: each
// FAIL. And every SIGN live check that acts as an app on the page names the kit's version first, as the kit's client
// does: without it the page reads it as kit-v1.4 and sends it no pools.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { MAP, V1_4, V1_4_KEYS, facts, judge } from "./kit-frame-version.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./kit-frame-version.answers.json", import.meta.url), "utf8"));
const BEFORE = [
  "BAD the bundle reads no kit hello: an app on any kit is sent everything, which kit-v1.4 refuses whole",
  "BAD the bundle has no kit-v1.4 deposit stage map over every deposit stage",
  "BAD the bundle has no kit-v1.4 state field list of exactly its twelve fields",
];

test("recorded good answer: this card's build reads the hello, maps every deposit stage for kit-v1.4, keeps its fields: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST as served before this card (release-60): FAIL, each missing piece named", () => {
  assert.equal(ANSWERS.bad.sha384, "sha384-3AiaXoHZZZPztfVU6l2AM+6GVfeK5xynH7RgNbaxwpY8EpHpJ+BcZgqTFpPRSfFj");
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, BEFORE);
});

test("recorded bad answer badNoHello: the good build reading a hello and ignoring it: FAIL, the hello named", () => {
  const v = judge(ANSWERS.badNoHello);
  assert.deepEqual(v.lines, [BEFORE[0]]);
  assert.equal(ANSWERS.badNoHello.hello.assign, null);
});

test("every SIGN live check that posts an app's request to the page sends the kit's hello at the kit's version", () => {
  const dir = new URL("./", import.meta.url);
  // an app's request as these checks write it: { v: 1, id, type ... } or { v: 1, id: ..., ...a }; a stand-in shell's
  // answer ({ v: 1, id: e.data.id, ok ... }) is not one
  const REQUEST = /\{ v: 1, id(?:: [^,{}]+)?, (?:type|\.\.\.)/;
  const HELLO = /\{ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION \}/;
  const acting = readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs")).filter((f) => {
    const t = readFileSync(new URL(f, dir), "utf8");
    return /postMessage\(/.test(t) && REQUEST.test(t);
  });
  assert.ok(acting.length >= 5, `the checks acting as an app: ${acting.join(", ")}`);
  for (const f of ["signpage-signin-kinds.mjs", "signpage-shell.mjs", "pool-restore-wired.mjs", "signpage-postmessage.mjs", "signpage-pool-mainnet.mjs"]) assert.ok(acting.includes(f), f);
  for (const f of acting) assert.match(readFileSync(new URL(f, dir), "utf8"), HELLO, `${f} posts to the page with no hello at the kit's version`);
});

test("planted on the good answer: each piece taken away or moved FAILs", () => {
  const g = ANSWERS.good;
  const map = g.maps.find((m) => Object.hasOwn(m, "refund_move"));
  const withMap = (patch) => ({ ...g, maps: [{ ...map, ...patch }] });
  assert.ok(judge({ ...g, sha384: "sha384-other" }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
  for (const k of ["assign", "shaper", "post"]) assert.deepEqual(judge({ ...g, hello: { ...g.hello, [k]: null } }).lines, [BEFORE[0]], `no ${k}`);
  assert.equal(judge({ ...g, hello: true }).ok, false, "the old string presence");
  for (const from of ["failed", "short", "expired", "refund_move"])
    for (const to of V1_4.filter((s) => s !== MAP[from])) assert.equal(judge(withMap({ [from]: to })).ok, false, `${from} -> ${to}`);
  assert.ok(judge(withMap({ refund_move: "done" })).lines.includes("BAD the map sends a refund still moving as done"));
  assert.ok(judge(withMap({ failed: "failed" })).lines.includes("BAD the map sends kit-v1.4 failed as failed, a stage it does not have"));
  const { refund_move: _r, ...short } = map;
  assert.equal(judge({ ...g, maps: [short] }).ok, false, "a stage missing from the map");
  assert.equal(judge({ ...g, keys: [[...V1_4_KEYS, "pools"]] }).ok, false, "pools sent to kit-v1.4");
  assert.equal(judge({}).ok, false, "an empty answer");
});

test("facts() reads the map, the field list and the hello from a minified bundle", () => {
  const pairs = Object.entries(MAP).map(([k, v]) => `${k}:\`${v}\``).join(",");
  // the hello's path as the head build minifies it (packages/signpage/src/kit-version.ts helloKit, kitLevel; api.ts)
  const path = [
    "function zc(e){if(typeof e!=`object`||!e||Array.isArray(e))return null;let t=Reflect.ownKeys(e),n=e;return t.length!==3||n.v!==1||n.type!==`hello`||!Object.hasOwn(n,`kit`)||typeof n.kit!=`string`?null:n.kit}",
    "function Bc(e){let t=Rc.exec(e);if(!t)return`1.4`;let[n,r]=[Number(t[1]),Number(t[2])];return n>Lc[0]||n===Lc[0]&&r>=Lc[1]?`current`:`1.4`}",
    "function pl(e){let r=`1.4`,i=(e,t)=>{if(`ok`in e)return e.ok&&t!==void 0?{...e,result:Xc(r,t,e.result)}:e;if(e.type===`state`)return{...e,state:Jc(r,e.state)};return e},a=(t,n)=>{let r=i(t,n);r!==null&&e.parent.postMessage(r,Zc)},c=async i=>{let c=zc(i);if(c!==null)return void(r=Bc(c));}}",
  ].join(";");
  const js = `var a=Object.freeze({${pairs}}),b=new Set([${V1_4_KEYS.map((k) => `\`${k}\``).join(",")}]);${path}`;
  const f = facts("", js);
  assert.deepEqual(f.maps, [MAP]);
  assert.deepEqual(f.keys, [V1_4_KEYS]);
  assert.deepEqual(Object.values(f.hello).map((x) => typeof x), ["string", "string", "string"]);
  // the hello read and dropped; the level set but not the one the shaper reads; the post not through the shaper
  assert.equal(facts("", js.replace("return void(r=Bc(c))", "return")).hello.assign, null);
  assert.equal(facts("", js.replace("return void(r=Bc(c))", "return void(q=Bc(c))")).hello.shaper, null);
  assert.equal(facts("", js.replace("let r=i(t,n);", "let r=t;")).hello.post, null);
  assert.equal(facts("", js.replace("result:Xc(r,t,e.result)", "result:e.result")).hello.shaper, null);
});
