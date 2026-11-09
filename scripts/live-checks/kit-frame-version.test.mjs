// node --test scripts/live-checks/kit-frame-version.test.mjs: the live check replays its recorded answers
// (kit-frame-version.answers.json). good: this card's SIGN_HOST build (packages/signpage/scripts/build-app.mjs bundle(),
// mainnet, at the card's head), which reads the kit's hello, maps every deposit stage down for kit-v1.4 and keeps
// kit-v1.4's twelve state fields: PASS. bad: SIGN_HOST as served on 6 Nov 2026 (release-61, /app.js
// sha384-mKDl+6Ec...), which sends every app everything: FAIL. badNoHello: the good build planted so its handler reads a
// hello and ignores it: FAIL. badTwoPosts: the good build planted with a progress event posted straight to the parent,
// a second parent.postMessage past the shaper: FAIL. badProgressUnshaped: the good build planted so the shaper sends
// every progress event as it is: FAIL. badRouteUnshaped: the good build planted so a route event goes to kit-v1.4 too:
// FAIL. Planted on the good one: another /app.js, no pin, each piece of the hello's path missing, no progress branch, a
// progress stage map other than MAP, no post count or other than one, each later stage mapped elsewhere, a refund move
// mapped to done, a stage kit-v1.4 lacks, a field list with pools: each FAIL. Card pool-deposit-stages re-recorded good
// and the planted ones from its own build (kit 1.7, kit-v1.6 and kit-v1.5 levels, the pool_deposit op left out below
// 1.7), and added badLive: SIGN_HOST as served on 9 Nov 2026 (release-107), kit 1.6 with no kit-v1.6 level: FAIL;
// badPoolOpsKept: kit-v1.6 sent its pool ops: FAIL; badNoV16Level: kit-v1.6 read at kit-v1.5's level: FAIL. And every SIGN live check that acts as an app on the page names the kit's version first, as the kit's client
// does: without it the page reads it as kit-v1.4 and sends it no pools. Card pool-deposit-op-txs re-recorded good and
// every planted one from its own build, badLive from SIGN_HOST as served at 11:09Z on 9 Nov 2026 (kit 1.6, no op tx
// reads), kept bad (release-61) as recorded then (both now also name the three op tx lines), and added badOpTxsOneRpc,
// badNearOneRpc and badMoveHeardShown: a pool deposit tx kept on some RPC's read, a NEAR move tx final on one RPC's
// word, a move tx shown as heard: each FAIL.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { KIT, LEVELS, MAP, V1_4, V1_4_KEYS, facts, judge } from "./kit-frame-version.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./kit-frame-version.answers.json", import.meta.url), "utf8"));
const BEFORE = [
  "BAD the bundle reads no kit hello: an app on any kit is sent everything, which kit-v1.4 refuses whole",
  "BAD the bundle has no kit-v1.4 deposit stage map over every deposit stage",
  "BAD the bundle has no kit-v1.4 state field list of exactly its twelve fields",
];
const UNSHAPED = "BAD progress and route events do not go through the shaper's stage map: an app on kit-v1.4 is sent a stage or a route event it cannot read";
const KIT_LINE = (v) => `BAD the page reads an app in full from kit-v${v}, not kit-v1.7: a kit-v1.7 app's pool deposit op has no level of its own`;
const LEVELS_LINE = (l) => `BAD the page's levels below the current one are ${JSON.stringify(l)}, not ["1.6","1.5"]: a kit-v1.6 app is sent what it has no kind for`;
const POOL_LINE = "BAD the state sent to kit-v1.6 and kit-v1.5 does not leave the pool_deposit op out";
const RESULT16_LINE = "BAD kit-v1.6's answers do not go through its own level: its deposit.confirm is sent without moved_out";
const OPTX_LINES = [
  "BAD the pool deposit op's txs are not read on both of the pool chain's RPCs: a tx one RPC alone names may be shown, or a landed deposit shows none",
  "BAD a refund move's tx is not read FINAL with success on both NEAR RPCs, sent by the release relayer to intents.near",
  "BAD the pool deposit op shows a refund move's tx before it is read final",
];
const POSTS = (n) => `BAD the bundle holds ${n} parent.postMessage( calls, not exactly one: a post past the shaper sends an older kit what it cannot read`;

test("recorded good answer: this card's build reads the hello, maps every deposit stage for kit-v1.4, keeps its fields: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST as served before this card (release-61): FAIL, each missing piece named", () => {
  assert.equal(ANSWERS.bad.sha384, "sha384-mKDl+6Ec+mdtOuvuzY/rIwJaYOf61XWAJGXN1BRdzleanUyVMUPlG2/wAkkI0Isr");
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [...BEFORE, ...OPTX_LINES]);
});

test("recorded bad answer badNoHello: the good build reading a hello and ignoring it: FAIL, the hello named", () => {
  const v = judge(ANSWERS.badNoHello);
  assert.deepEqual(v.lines, [BEFORE[0]]);
  assert.equal(ANSWERS.badNoHello.hello.assign, null);
});

test("recorded bad answers on the progress path: a second post, progress unshaped, a route event to kit-v1.4: each FAIL, named", () => {
  assert.equal(ANSWERS.badTwoPosts.posts, 2);
  assert.deepEqual(judge(ANSWERS.badTwoPosts).lines, [POSTS(2)]);
  for (const k of ["badProgressUnshaped", "badRouteUnshaped"]) {
    assert.equal(ANSWERS[k].hello.progress, null, k);
    assert.equal(typeof ANSWERS[k].hello.shaper, "string", `${k}: the shaper is still read, only its progress branch is not`);
    assert.deepEqual(judge(ANSWERS[k]).lines, [UNSHAPED], k);
  }
  // each planted answer is the good build with that one cut, re-pinned
  for (const k of ["badTwoPosts", "badProgressUnshaped", "badRouteUnshaped", "badPoolOpsKept", "badNoV16Level", "badEventsUnshaped", "badNoResult16"]) {
    assert.notEqual(ANSWERS[k].sha384, ANSWERS.good.sha384, k);
    assert.deepEqual(ANSWERS[k].maps, ANSWERS.good.maps, k);
    assert.deepEqual(ANSWERS[k].keys, ANSWERS.good.keys, k);
  }
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

test("pool-deposit-stages: the good build reads kit 1.7 in full, kit-v1.6 and kit-v1.5 below it, and leaves the pool_deposit op out there", () => {
  assert.equal(KIT, "1.7");
  assert.deepEqual(LEVELS, ["1.6", "1.5"]);
  assert.equal(ANSWERS.good.hello.kit, "1.7");
  assert.deepEqual(ANSWERS.good.hello.levels, ["1.6", "1.5"]);
  assert.match(ANSWERS.good.hello.poolOps, /if\(([\w$]+)===`1\.6`\)return\{\.\.\.([\w$]+),ops:([\w$]+)\(\2\.ops\)\};if\(\1===`1\.5`\)return\{\.\.\.\2,ops:\3\(\2\.ops\)\.map\($/);
});

test("recorded bad answer badLive: SIGN_HOST as served before this card (9 Nov 11:09Z, kit 1.6): FAIL, the version, the level, the pool filter and the op tx reads named", () => {
  assert.equal(ANSWERS.badLive.sha384, "sha384-1aGrtaUQWiKVzeAuTm2zzYpXpF0xmqXly2/JVa4pbGHalP+gNp+xnwQuH3VpjtYN");
  assert.deepEqual(judge(ANSWERS.badLive).lines, [KIT_LINE("1.6"), LEVELS_LINE(["1.5"]), POOL_LINE, RESULT16_LINE, ...OPTX_LINES]);
});

test("card pool-deposit-op-txs: recorded bad answers badOpTxsOneRpc, badNearOneRpc and badMoveHeardShown, each the good build with that one cut: FAIL, named", () => {
  assert.equal(typeof ANSWERS.good.opTxs.landed, "string");
  assert.deepEqual(Object.keys(ANSWERS.good.opTxs), ["landed", "every", "nearFinal", "moveShown"]);
  for (const k of ["landed", "every", "nearFinal", "moveShown"]) assert.equal(typeof ANSWERS.good.opTxs[k], "string", k);
  assert.equal(ANSWERS.badOpTxsOneRpc.opTxs.every, null);
  assert.deepEqual(judge(ANSWERS.badOpTxsOneRpc).lines, [OPTX_LINES[0]]);
  assert.equal(ANSWERS.badNearOneRpc.opTxs.nearFinal, null);
  assert.deepEqual(judge(ANSWERS.badNearOneRpc).lines, [OPTX_LINES[1]]);
  assert.equal(ANSWERS.badMoveHeardShown.opTxs.moveShown, null);
  assert.deepEqual(judge(ANSWERS.badMoveHeardShown).lines, [OPTX_LINES[2]]);
  for (const k of ["badOpTxsOneRpc", "badNearOneRpc", "badMoveHeardShown"]) {
    assert.notEqual(ANSWERS[k].sha384, ANSWERS.good.sha384, k);
    assert.deepEqual(ANSWERS[k].hello, ANSWERS.good.hello, k);
  }
  // planted on good's facts: each read taken away FAILs
  for (const k of ["landed", "every", "nearFinal", "moveShown"]) assert.equal(judge({ ...ANSWERS.good, opTxs: { ...ANSWERS.good.opTxs, [k]: null } }).ok, false, k);
  assert.equal(judge({ ...ANSWERS.good, opTxs: undefined }).ok, false, "no op tx facts");
});

test("review P3 2: recorded bad answers badEventsUnshaped and badNoResult16: state events through a shaper that shapes nothing, kit-v1.6's answers through no level of its own: each FAIL, named", () => {
  assert.deepEqual(judge(ANSWERS.badEventsUnshaped).lines, [POOL_LINE, RESULT16_LINE], "the filter is read only on the state shaper the shaper calls");
  assert.equal(ANSWERS.badNoResult16.hello.result16, null);
  assert.deepEqual(judge(ANSWERS.badNoResult16).lines, [RESULT16_LINE]);
  assert.match(ANSWERS.good.hello.result16, /if\(([\w$]+)===`1\.6`\)return ([\w$]+)===`state`\?([\w$]+)\(\1,([\w$]+)\):\4;$/);
});

test("recorded bad answers badPoolOpsKept and badNoV16Level: the good build sending kit-v1.6 its pool ops, or reading it at kit-v1.5's level: each FAIL, named", () => {
  assert.equal(ANSWERS.badPoolOpsKept.hello.poolOps, null);
  assert.deepEqual(judge(ANSWERS.badPoolOpsKept).lines, [POOL_LINE]);
  assert.deepEqual(ANSWERS.badNoV16Level.hello.levels, ["1.5"]);
  assert.deepEqual(judge(ANSWERS.badNoV16Level).lines, [LEVELS_LINE(["1.5"])]);
});

test("planted on the good answer: each piece taken away or moved FAILs", () => {
  const g = ANSWERS.good;
  const map = g.maps.find((m) => Object.hasOwn(m, "refund_move"));
  const withMap = (patch) => ({ ...g, maps: [{ ...map, ...patch }] });
  assert.ok(judge({ ...g, sha384: "sha384-other" }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
  for (const k of ["assign", "shaper", "post"]) assert.deepEqual(judge({ ...g, hello: { ...g.hello, [k]: null } }).lines, [BEFORE[0]], `no ${k}`);
  assert.equal(judge({ ...g, hello: true }).ok, false, "the old string presence");
  assert.deepEqual(judge({ ...g, hello: { ...g.hello, progress: null } }).lines, [UNSHAPED], "no progress branch");
  assert.deepEqual(judge({ ...g, hello: { ...g.hello, progressMap: { ...g.hello.progressMap, failed: "failed" } } }).lines, [
    `BAD the progress stage function reads a map other than kit-v1.4's (${JSON.stringify({ ...g.hello.progressMap, failed: "failed" })})`,
  ]);
  assert.equal(judge({ ...g, hello: { ...g.hello, progressMap: null } }).ok, false, "no progress stage map");
  for (const n of [0, 2]) assert.deepEqual(judge({ ...g, posts: n }).lines, [POSTS(n)], `${n} posts`);
  const { posts: _p, ...noCount } = g;
  assert.deepEqual(judge(noCount).lines, [POSTS("no count of")], "no post count");
  for (const from of ["failed", "short", "expired", "refund_move"])
    for (const to of V1_4.filter((s) => s !== MAP[from])) assert.equal(judge(withMap({ [from]: to })).ok, false, `${from} -> ${to}`);
  assert.ok(judge(withMap({ refund_move: "done" })).lines.includes("BAD the map sends a refund still moving as done"));
  assert.ok(judge(withMap({ failed: "failed" })).lines.includes("BAD the map sends kit-v1.4 failed as failed, a stage it does not have"));
  const { refund_move: _r, ...short } = map;
  assert.equal(judge({ ...g, maps: [short] }).ok, false, "a stage missing from the map");
  assert.equal(judge({ ...g, keys: [[...V1_4_KEYS, "pools"]] }).ok, false, "pools sent to kit-v1.4");
  assert.equal(judge({}).ok, false, "an empty answer");
  // card pool-deposit-stages: another version read in full, the levels other than kit-v1.6's and kit-v1.5's, no pool filter
  for (const v of ["1.6", "1.8", null]) assert.deepEqual(judge({ ...g, hello: { ...g.hello, kit: v } }).lines, [KIT_LINE(v ?? "?")], `kit ${v}`);
  for (const l of [["1.5"], ["1.6"], ["1.5", "1.6"], ["1.6", "1.5", "1.4"], ["1.6->1.7", "1.5"], null])
    assert.deepEqual(judge({ ...g, hello: { ...g.hello, levels: l } }).lines, [LEVELS_LINE(l)], JSON.stringify(l));
  assert.deepEqual(judge({ ...g, hello: { ...g.hello, poolOps: null } }).lines, [POOL_LINE], "no pool filter");
  assert.deepEqual(judge({ ...g, hello: { ...g.hello, result16: null } }).lines, [RESULT16_LINE], "no kit-v1.6 answer branch");
});

test("facts() reads the map, the field list and the hello from a minified bundle", () => {
  const pairs = Object.entries(MAP).map(([k, v]) => `${k}:\`${v}\``).join(",");
  // the hello's path as the head build minifies it (packages/signpage/src/kit-version.ts helloKit, kitLevel; api.ts)
  const path = [
    "function zc(e){if(typeof e!=`object`||!e||Array.isArray(e))return null;let t=Reflect.ownKeys(e),n=e;return t.length!==3||n.v!==1||n.type!==`hello`||!Object.hasOwn(n,`kit`)||typeof n.kit!=`string`?null:n.kit}",
    "Lc=`1.7`.split(`.`).map(Number)",
    "function Bc(e){let t=Rc.exec(e);if(!t)return`1.4`;let[n,r]=[Number(t[1]),Number(t[2])],i=(e,t)=>n>e||n===e&&r>=t;return i(Lc[0],Lc[1])?`current`:i(1,6)?`1.6`:i(1,5)?`1.5`:`1.4`}",
    "var Dl=e=>e.filter(e=>e.kind!==`pool_deposit`);function Jc(e,t){if(e===`current`)return t;if(e===`1.6`)return{...t,ops:Dl(t.ops)};if(e===`1.5`)return{...t,ops:Dl(t.ops).map(e=>e.kind===`deposit`?El(e):e)};return t}",
    "function Xc(e,t,n){if(e===`current`)return n;if(e===`1.6`)return t===`state`?Jc(e,n):n;return n}",
    "function Qc(e,t){return e===`current`||Kc.has(t)?t:qc(Wc,t)?Wc[t]:null}",
    "function pl(e){let r=`1.4`,i=(e,t)=>{if(`ok`in e)return e.ok&&t!==void 0?{...e,result:Xc(r,t,e.result)}:e;if(e.type===`state`)return{...e,state:Jc(r,e.state)};if(e.type!==`progress`)return e;if(!(`stage`in e))return r===`current`?e:null;let n=Qc(r,e.stage);return n===null?null:n===e.stage?e:{...e,stage:n}},a=(t,n)=>{let r=i(t,n);r!==null&&e.parent.postMessage(r,Zc)},c=async i=>{let c=zc(i);if(c!==null)return void(r=Bc(c));}}",
  ].join(";");
  const js = `var Wc=Object.freeze({${pairs}}),b=new Set([${V1_4_KEYS.map((k) => `\`${k}\``).join(",")}]);${path}`;
  const f = facts("", js);
  assert.deepEqual(f.maps, [MAP]);
  assert.deepEqual(f.keys, [V1_4_KEYS]);
  assert.deepEqual(Object.values(f.hello).map((x) => typeof x), ["string", "string", "string", "string", "object", "string", "object", "string", "string"]);
  assert.equal(f.hello.kit, "1.7");
  // review P3 2: the filter and the kit-v1.6 answer branch read only on the functions the shaper calls
  assert.equal(facts("", js.replace("state:Jc(r,e.state)", "state:Qz(r,e.state)").replace("function Jc(", "function Qz(e,t){return t}function Jc(")).hello.poolOps, null);
  assert.equal(facts("", js.replace("result:Xc(r,t,e.result)", "result:Qy(r,t,e.result)").replace("function Xc(", "function Qy(e,t,n){return n}function Xc(")).hello.result16, null);
  assert.equal(facts("", js.replace("if(e===`1.6`)return t===`state`?Jc(e,n):n;", "")).hello.result16, null);
  assert.equal(facts("", js.replace("t===`state`?Jc(e,n):n;", "t===`state`?Qz(e,n):n;")).hello.result16, null);
  assert.deepEqual(f.hello.levels, ["1.6", "1.5"]);
  // card pool-deposit-stages: the pool filter cut or another one, a branch through no filter, a level named wrong, no threshold
  assert.equal(facts("", js.replace("e.kind!==`pool_deposit`", "e.kind!==`deposit`")).hello.poolOps, null);
  assert.equal(facts("", js.replace("return{...t,ops:Dl(t.ops)};", "return t;")).hello.poolOps, null);
  assert.equal(facts("", js.replace("return{...t,ops:Dl(t.ops).map(", "return{...t,ops:t.ops.map(")).hello.poolOps, null);
  assert.deepEqual(facts("", js.replace("i(1,6)?`1.6`", "i(1,6)?`1.7`")).hello.levels, ["1.6->1.7", "1.5"]);
  assert.equal(facts("", js.replace("Lc=`1.7`", "Lc=`1.6`")).hello.kit, "1.6");
  assert.equal(facts("", js.replace("Lc=`1.7`.split(`.`).map(Number)", "Lc=[1,7]")).hello.kit, null);
  assert.deepEqual(f.hello.progressMap, MAP);
  assert.equal(f.posts, 1);
  // a second post to the parent, as written or as minified; a post to a worker is not one
  assert.equal(facts("", `${js};window.parent.postMessage(x,Zc)`).posts, 2);
  assert.equal(facts("", `${js};w.postMessage(x)`).posts, 1);
  // the progress branch: gone, a route event sent at every level, a stage sent unmapped, the stage function on a level
  // other than the shaper's, or on another map; each reads no progress path or another map
  assert.equal(facts("", js.replace("if(e.type!==`progress`)return e;", "")).hello.progress, null);
  assert.equal(facts("", js.replace("return r===`current`?e:null", "return e")).hello.progress, null);
  assert.equal(facts("", js.replace("let n=Qc(r,e.stage);", "let n=e.stage;")).hello.progress, null);
  assert.equal(facts("", js.replace("let n=Qc(r,e.stage);", "let n=Qc(`current`,e.stage);")).hello.progress, null);
  assert.equal(facts("", js.replace("{...e,stage:n}}", "{...e}}")).hello.progress, null);
  assert.equal(facts("", js.replace("function Qc(e,t){return e===`current`||", "function Qc(e,t){return!0||")).hello.progress, null);
  const other = facts("", js.replace("qc(Wc,t)?Wc[t]", "qc(Vc,t)?Vc[t]").replace("var Wc=", `var Vc=Object.freeze({${pairs.replace("failed:`in_transit`", "failed:`failed`")}}),Wc=`));
  assert.equal(other.hello.progressMap.failed, "failed");
  assert.equal(judge({ ...ANSWERS.good, hello: other.hello }).ok, false, "the stage function on another map");
  // the hello read and dropped; the level set but not the one the shaper reads; the post not through the shaper
  assert.equal(facts("", js.replace("return void(r=Bc(c))", "return")).hello.assign, null);
  assert.equal(facts("", js.replace("return void(r=Bc(c))", "return void(q=Bc(c))")).hello.shaper, null);
  assert.equal(facts("", js.replace("let r=i(t,n);", "let r=t;")).hello.post, null);
  assert.equal(facts("", js.replace("result:Xc(r,t,e.result)", "result:e.result")).hello.shaper, null);
});

test("facts() reads the hello's path with the kit-v1.5 level (card held-move-forgotten-tx) as release-94 minifies it; a level that sends kit-v1.4 a route event or an unmapped stage reads no path", () => {
  const pairs = Object.entries(MAP).map(([k, v]) => `${k}:\`${v}\``).join(",");
  const path = [
    "function zc(e){if(typeof e!=`object`||!e||Array.isArray(e))return null;let t=Reflect.ownKeys(e),n=e;return t.length!==3||n.v!==1||n.type!==`hello`||!Object.hasOwn(n,`kit`)||typeof n.kit!=`string`?null:n.kit}",
    "ll=`1.6`.split(`.`).map(Number)",
    "function fl(e){let t=ul.exec(e);if(!t)return`1.4`;let[n,r]=[Number(t[1]),Number(t[2])],i=(e,t)=>n>e||n===e&&r>=t;return i(ll[0],ll[1])?`current`:i(1,5)?`1.5`:`1.4`}",
    "function Sl(e,t){return e!==`1.4`||hl.has(t)?t:gl(pl,t)?pl[t]:null}",
    "function ql(e){let r=`1.4`,i=(e,t)=>{if(`ok`in e)return e.ok&&t!==void 0?{...e,result:Xc(r,t,e.result)}:e;if(e.type===`state`)return{...e,state:Jc(r,e.state)};if(e.type!==`progress`)return e;if(!(`stage`in e))return r===`1.4`?null:e;let n=Sl(r,e.stage);return n===null?null:n===e.stage?e:{...e,stage:n}},a=(t,n)=>{let r=i(t,n);r!==null&&e.parent.postMessage(r,Zc)},c=async i=>{let c=zc(i);if(c!==null)return void(r=fl(c));}}",
  ].join(";");
  const js = `var pl=Object.freeze({${pairs}}),b=new Set([${V1_4_KEYS.map((k) => `\`${k}\``).join(",")}]);${path}`;
  const f = facts("", js);
  assert.deepEqual(Object.values(f.hello).map((x) => typeof x), ["string", "string", "string", "string", "object", "string", "object", "object", "object"]);
  assert.deepEqual(f.hello.progressMap, MAP);
  // card pool-deposit-stages: release-94's shape reads kit 1.6, kit-v1.5's level alone, no pool filter: FAIL now
  assert.deepEqual([f.hello.kit, f.hello.levels, f.hello.poolOps], ["1.6", ["1.5"], null]);
  assert.deepEqual(judge({ ...ANSWERS.good, hello: f.hello }).lines, [KIT_LINE("1.6"), LEVELS_LINE(["1.5"]), POOL_LINE, RESULT16_LINE]);
  assert.equal(facts("", js.replace("return r===`1.4`?null:e", "return e")).hello.progress, null, "a route event to kit-v1.4");
  assert.equal(facts("", js.replace("return e!==`1.4`||hl.has(t)", "return e!==`1.5`||hl.has(t)")).hello.progress, null, "kit-v1.4 sent a later stage unmapped");
  assert.equal(facts("", js.replace("i(1,5)?`1.5`:`1.4`", "i(1,5)?`current`:`1.4`")).hello.assign, null, "kit-v1.5 read as current");
});
