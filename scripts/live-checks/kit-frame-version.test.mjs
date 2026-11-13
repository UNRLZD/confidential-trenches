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
// word, a move tx shown as heard: each FAIL. Its review FIX re-recorded good and every planted one from its build, and
// added badOpTxsNoAnswer (a read that fails or answers null on one RPC taken as an answer; review P2-a) and
// badNearOtherNonce (a relayer tx shown that carries another nonce's intent; review P1): each FAIL. At its merge with
// card signpage-state-holdings (kit 1.8), good is re-read from the merged build, good17 and the planted records before
// badNoResult17 are this card's 1.7-era ones (each with the op tx facts), judged at 1.7; badNoResult17 and the five op
// tx plants are the merged build with their one cut, judged at 1.8; badLiveHoldings is SIGN_HOST re-read at 14:44Z.
// Card signing-layer-says-when-it-closes (kit 1.13) re-recorded good from its build, kept the kit 1.12 good as good112
// (judged at 1.12 with that era's plants), and added badClosesKept, badCloseKinds, badNoV112Level, badKit112 and
// badState112Stripped, each its build with the one cut the answers' note names: each FAIL at 1.13.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { KIT, LEVELS, MAP, OPEN_KINDS, V1_4, V1_4_KEYS, facts, judge as judgeNow } from "./kit-frame-version.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./kit-frame-version.answers.json", import.meta.url), "utf8"));
const BEFORE = [
  "BAD the bundle reads no kit hello: an app on any kit is sent everything, which kit-v1.4 refuses whole",
  "BAD the bundle has no kit-v1.4 deposit stage map over every deposit stage",
  "BAD the bundle has no kit-v1.4 state field list of exactly its twelve fields",
];
const UNSHAPED = "BAD progress and route events do not go through the shaper's stage map: an app on kit-v1.4 is sent a stage or a route event it cannot read";
// card signpage-state-holdings: every record before it is a 1.7-era build's, judged at the version and levels it was cut
// at (V17); the good build of the card and the live SIGN_HOST before it are judged at 1.8 (judgeNow)
const V17 = { kit: "1.7", levels: ["1.6", "1.5"] };
const judge = (a) => judgeNow(a, V17);
const KIT_LINE = (v) => `BAD the page reads an app in full from kit-v${v}, not kit-v1.7: a kit-v1.7 app's pool deposit op has no level of its own`;
const LEVELS_LINE = (l) => `BAD the page's levels below the current one are ${JSON.stringify(l)}, not ["1.6","1.5"]: an older kit's app is sent what it cannot read`;
const KIT18_LINE = (v) => `BAD the page reads an app in full from kit-v${v}, not kit-v1.8: a kit-v1.8 app's position decimals has no level of its own`;
// card kit-portfolio-reads: the records cut at kit 1.8 (good18, badLiveHoldings, badNoResult17, the op tx plants) are
// judged at the version and levels they were cut at (V18); this card's good build and its plants at 1.9 (judgeNow)
const V18 = { kit: "1.8", levels: ["1.7", "1.6", "1.5"] };
const judge18 = (a) => judgeNow(a, V18);
const KIT19_LINE = (v) => `BAD the page reads an app in full from kit-v${v}, not kit-v1.9: a kit-v1.9 app's op detail has no level of its own`;
const LEVELS19_LINE = (l) => `BAD the page's levels below the current one are ${JSON.stringify(l)}, not ["1.8","1.7","1.6","1.5"]: an older kit's app is sent what it cannot read`;
const DETAIL_LINE = "BAD the state sent below the current level keeps each op's detail, for which a kit-v1.8 app drops the op";
const RESULT18_LINE = "BAD kit-v1.8's answers do not go through its own level: its deposit.confirm is sent with no facts";
// card portfolio-shows-pool-trades: the records cut at kit 1.9 (good19, badNoDetail, badNoResult18) are judged at the
// version and levels they were cut at (V19); this card's good build and its plants at 1.10 (judgeNow)
const V19 = { kit: "1.9", levels: ["1.8", "1.7", "1.6", "1.5"] };
const judge19 = (a) => judgeNow(a, V19);
const KIT110_LINE = (v) => `BAD the page reads an app in full from kit-v${v}, not kit-v1.10: a kit-v1.10 app's op pool_amount has no level of its own`;
const LEVELS110_LINE = (l) => `BAD the page's levels below the current one are ${JSON.stringify(l)}, not ["1.9","1.8","1.7","1.6","1.5"]: an older kit's app is sent what it cannot read`;
const AMOUNT_LINE = "BAD the state sent below the current level keeps each op's pool_amount, for which a kit-v1.9 app drops the op";
const RESULT19_LINE = "BAD kit-v1.9's answers do not go through its own level: its deposit.confirm is sent with no facts";
// card portfolio-counts-money-an-open-buy-holds: the records cut at kit 1.10 (good110, badNoV19State, badPoolAmountBelow,
// badNoResult19) are judged at the version and levels they were cut at (V110); this card's good build and its plants at
// 1.11 (judgeNow)
const V110 = { kit: "1.10", levels: ["1.9", "1.8", "1.7", "1.6", "1.5"] };
const judge110 = (a) => judgeNow(a, V110);
const KIT111_LINE = (v) => `BAD the page reads an app in full from kit-v${v}, not kit-v1.11: a kit-v1.11 app's position asset_held has no level of its own`;
const LEVELS111_LINE = (l) => `BAD the page's levels below the current one are ${JSON.stringify(l)}, not ["1.10","1.9","1.8","1.7","1.6","1.5"]: an older kit's app is sent what it cannot read`;
const HELD_LINE = "BAD the state sent below the current level keeps each position's asset_held, which kit-v1.10 refuses the whole state for";
const RESULT110_LINE = "BAD kit-v1.10's answers do not go through its own level: its deposit.confirm is sent with no facts";
// card buy-spends-several-pieces: the records cut at kit 1.11 (good111, badNoAssetHeld, badKit110, badNoResult110) are
// judged at the version and levels they were cut at (V111); this card's good build and its plants at 1.12 (judgeNow)
const V111 = { kit: "1.11", levels: ["1.10", "1.9", "1.8", "1.7", "1.6", "1.5"] };
const judge111 = (a) => judgeNow(a, V111);
const KIT112_LINE = (v) => `BAD the page reads an app in full from kit-v${v}, not kit-v1.12: a kit-v1.12 app's pool making has no level of its own`;
const LEVELS112_LINE = (l) => `BAD the page's levels below the current one are ${JSON.stringify(l)}, not ["1.11","1.10","1.9","1.8","1.7","1.6","1.5"]: an older kit's app is sent what it cannot read`;
const MAKING_LINE = "BAD the state sent below the current level keeps each pool entry's making, which kit-v1.11 refuses the whole state for";
const DRY_LINE = "BAD pool.buy.dry's answer sent below the current level keeps its pieces and cost, which kit-v1.11 refuses the whole answer for";
const RESULT111_LINE = "BAD kit-v1.11's answers do not go through its own level: its deposit.confirm is sent with no facts";
// card signing-layer-says-when-it-closes: the records cut at kit 1.12 (good112, badNoMaking, badNoDry, badKit111,
// badNoResult111) are judged at the version and levels they were cut at (V112); this card's good build and its plants at
// 1.13 (judgeNow)
const V112 = { kit: "1.12", levels: ["1.11", "1.10", "1.9", "1.8", "1.7", "1.6", "1.5"] };
const judge112 = (a) => judgeNow(a, V112);
const KIT113_LINE = (v) => `BAD the page reads an app in full from kit-v${v}, not kit-v1.13: a kit-v1.13 app's open answer's closes has no level of its own`;
const LEVELS113_LINE = (l) => `BAD the page's levels below the current one are ${JSON.stringify(l)}, not ["1.12","1.11","1.10","1.9","1.8","1.7","1.6","1.5"]: an older kit's app is sent what it cannot read`;
const CLOSES_LINE = "BAD an open kind's answer sent below the current level keeps closes, which kit-v1.12 refuses the whole answer for";
const KINDS_LINE = (k) => `BAD the closes strip reads the kinds ${JSON.stringify(k)}, not the open kinds ${JSON.stringify(OPEN_KINDS)}`;
const STATE112_LINE = "BAD kit-v1.12 is not sent the state in full: it loses a field it reads";
const LEVELS18_LINE = (l) => `BAD the page's levels below the current one are ${JSON.stringify(l)}, not ["1.7","1.6","1.5"]: an older kit's app is sent what it cannot read`;
const DECIMALS_LINE = "BAD the state sent below the current level keeps each position's decimals, which kit-v1.7 refuses the whole state for";
const RESULT17_LINE = "BAD kit-v1.7's answers do not go through its own level: its deposit.confirm is sent with no facts";
const POOL_LINE = "BAD the state sent to kit-v1.6 and kit-v1.5 does not leave the pool_deposit op out";
const RESULT16_LINE = "BAD kit-v1.6's answers do not go through its own level: its deposit.confirm is sent without moved_out";
const OPTX_LINES = [
  "BAD the pool deposit op's txs are not read on both of the pool chain's RPCs: a tx one RPC alone names may be shown, or a landed deposit shows none",
  "BAD a refund move's tx is not read FINAL with success on both NEAR RPCs, sent by the release relayer to intents.near, carrying that move's own intent alone",
  "BAD the pool deposit op shows a refund move's tx before it is read final",
];
const POSTS = (n) => `BAD the bundle holds ${n} parent.postMessage( calls, not exactly one: a post past the shaper sends an older kit what it cannot read`;

test("recorded good answer: this card's build reads the hello, maps every deposit stage for kit-v1.4, keeps its fields: PASS", () => {
  const v = judgeNow(ANSWERS.good);
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
    assert.notEqual(ANSWERS[k].sha384, ANSWERS.good17.sha384, k);
    assert.deepEqual(ANSWERS[k].maps, ANSWERS.good17.maps, k);
    assert.deepEqual(ANSWERS[k].keys, ANSWERS.good17.keys, k);
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
  assert.equal(ANSWERS.good17.hello.kit, "1.7");
  assert.deepEqual(ANSWERS.good17.hello.levels, ["1.6", "1.5"]);
  assert.match(ANSWERS.good17.hello.poolOps, /if\(([\w$]+)===`1\.6`\)return\{\.\.\.([\w$]+),ops:([\w$]+)\(\2\.ops\)\};if\(\1===`1\.5`\)return\{\.\.\.\2,ops:\3\(\2\.ops\)\.map\($/);
});

test("recorded bad answer badLive: SIGN_HOST as served before this card (9 Nov 11:09Z, kit 1.6): FAIL, the version, the level, the pool filter and the op tx reads named", () => {
  assert.equal(ANSWERS.badLive.sha384, "sha384-1aGrtaUQWiKVzeAuTm2zzYpXpF0xmqXly2/JVa4pbGHalP+gNp+xnwQuH3VpjtYN");
  assert.deepEqual(judge(ANSWERS.badLive).lines, [KIT_LINE("1.6"), LEVELS_LINE(["1.5"]), POOL_LINE, RESULT16_LINE, ...OPTX_LINES]);
});

test("card pool-deposit-op-txs: recorded bad answers badOpTxsOneRpc, badNearOneRpc and badMoveHeardShown, each the good build with that one cut: FAIL, named", () => {
  assert.equal(typeof ANSWERS.good18.opTxs.landed, "string");
  assert.deepEqual(Object.keys(ANSWERS.good18.opTxs), ["landed", "every", "nearFinal", "moveShown"]);
  for (const k of ["landed", "every", "nearFinal", "moveShown"]) assert.equal(typeof ANSWERS.good18.opTxs[k], "string", k);
  for (const [k, read, line] of [
    ["badOpTxsOneRpc", "every", 0],
    ["badOpTxsNoAnswer", "every", 0],
    ["badNearOneRpc", "nearFinal", 1],
    ["badNearOtherNonce", "nearFinal", 1],
    ["badMoveHeardShown", "moveShown", 2],
  ]) {
    assert.equal(ANSWERS[k].opTxs[read], null, k);
    assert.deepEqual(judge18(ANSWERS[k]).lines, [OPTX_LINES[line]], k);
  }
  for (const k of ["badOpTxsOneRpc", "badOpTxsNoAnswer", "badNearOneRpc", "badNearOtherNonce", "badMoveHeardShown"]) {
    assert.notEqual(ANSWERS[k].sha384, ANSWERS.good18.sha384, k);
    assert.deepEqual(ANSWERS[k].hello, ANSWERS.good18.hello, k);
  }
  // planted on good's facts: each read taken away FAILs
  for (const k of ["landed", "every", "nearFinal", "moveShown"]) assert.equal(judge18({ ...ANSWERS.good18, opTxs: { ...ANSWERS.good18.opTxs, [k]: null } }).ok, false, k);
  assert.equal(judge18({ ...ANSWERS.good18, opTxs: undefined }).ok, false, "no op tx facts");
});

test("review P3 2: recorded bad answers badEventsUnshaped and badNoResult16: state events through a shaper that shapes nothing, kit-v1.6's answers through no level of its own: each FAIL, named", () => {
  assert.deepEqual(judge(ANSWERS.badEventsUnshaped).lines, [POOL_LINE, RESULT16_LINE], "the filter is read only on the state shaper the shaper calls");
  assert.equal(ANSWERS.badNoResult16.hello.result16, null);
  assert.deepEqual(judge(ANSWERS.badNoResult16).lines, [RESULT16_LINE]);
  assert.match(ANSWERS.good17.hello.result16, /if\(([\w$]+)===`1\.6`\)return ([\w$]+)===`state`\?([\w$]+)\(\1,([\w$]+)\):\4;$/);
});

test("recorded bad answers badPoolOpsKept and badNoV16Level: the good build sending kit-v1.6 its pool ops, or reading it at kit-v1.5's level: each FAIL, named", () => {
  assert.equal(ANSWERS.badPoolOpsKept.hello.poolOps, null);
  assert.deepEqual(judge(ANSWERS.badPoolOpsKept).lines, [POOL_LINE]);
  assert.deepEqual(ANSWERS.badNoV16Level.hello.levels, ["1.5"]);
  assert.deepEqual(judge(ANSWERS.badNoV16Level).lines, [LEVELS_LINE(["1.5"])]);
});

test("planted on the good answer: each piece taken away or moved FAILs", () => {
  const g = ANSWERS.good17;
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
  assert.deepEqual(Object.values(f.hello).map((x) => typeof x), ["string", "string", "string", "string", "object", "string", "object", "string", "string", "object", "object", "object", "object", "object", "object", "object", "object", "object", "object", "object", "object", "object", "object"]);
  assert.equal(f.hello.decimals, null, "a 1.7-era shaper strips no decimals");
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
  assert.equal(judge({ ...ANSWERS.good17, hello: other.hello }).ok, false, "the stage function on another map");
  // the hello read and dropped; the level set but not the one the shaper reads; the post not through the shaper
  assert.equal(facts("", js.replace("return void(r=Bc(c))", "return")).hello.assign, null);
  assert.equal(facts("", js.replace("return void(r=Bc(c))", "return void(q=Bc(c))")).hello.shaper, null);
  // kit 1.13 sets the closed notice's hello flag beside the level (card signing-layer-says-when-it-closes): read the same;
  // anything else beside it is not
  const flagged = facts("", js.replace("return void(r=Bc(c))", "return void(r=Bc(c),h=!0)")).hello;
  assert.equal(flagged.assign, "let c=zc(i);if(c!==null)return void(r=Bc(c),h=!0)");
  assert.deepEqual({ ...flagged, assign: null }, { ...facts("", js).hello, assign: null });
  assert.equal(facts("", js.replace("return void(r=Bc(c))", "return void(r=Bc(c),r=`current`)")).hello.assign, null);
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
  assert.deepEqual(Object.values(f.hello).map((x) => typeof x), ["string", "string", "string", "string", "object", "string", "object", "object", "object", "object", "object", "object", "object", "object", "object", "object", "object", "object", "object", "object", "object", "object", "object"]);
  assert.deepEqual(f.hello.progressMap, MAP);
  // card pool-deposit-stages: release-94's shape reads kit 1.6, kit-v1.5's level alone, no pool filter: FAIL now
  assert.deepEqual([f.hello.kit, f.hello.levels, f.hello.poolOps], ["1.6", ["1.5"], null]);
  assert.deepEqual(judge({ ...ANSWERS.good17, hello: f.hello }).lines, [KIT_LINE("1.6"), LEVELS_LINE(["1.5"]), POOL_LINE, RESULT16_LINE]);
  assert.equal(facts("", js.replace("return r===`1.4`?null:e", "return e")).hello.progress, null, "a route event to kit-v1.4");
  assert.equal(facts("", js.replace("return e!==`1.4`||hl.has(t)", "return e!==`1.5`||hl.has(t)")).hello.progress, null, "kit-v1.4 sent a later stage unmapped");
  assert.equal(facts("", js.replace("i(1,5)?`1.5`:`1.4`", "i(1,5)?`current`:`1.4`")).hello.assign, null, "kit-v1.5 read as current");
});

// ------------------------------------------------------------------------------------------------ card signpage-state-holdings
test("signpage-state-holdings: the good build reads kit 1.8 in full, kit-v1.7, kit-v1.6 and kit-v1.5 below it, each position with no decimals there", () => {
  const g = ANSWERS.good18;
  assert.equal(g.hello.kit, "1.8");
  assert.deepEqual(g.hello.levels, ["1.7", "1.6", "1.5"]);
  assert.match(g.hello.decimals, /let ([\w$]+)=([\w$]+)\(([\w$]+)\);if\(([\w$]+)===`1\.7`\)return \1;if\(\4===`1\.6`\)return\{\.\.\.\1,ops:/);
  assert.deepEqual(judge18(g).lines, []);
});

test("recorded bad answers at 1.8: SIGN_HOST before this card, and the 1.7-era good build: each FAIL, the version, the level and the decimals named", () => {
  assert.deepEqual(judge18(ANSWERS.badLiveHoldings).lines, [KIT18_LINE("1.6"), LEVELS18_LINE(["1.5"]), DECIMALS_LINE, POOL_LINE, RESULT16_LINE, RESULT17_LINE, ...OPTX_LINES]);
  assert.deepEqual(judge18(ANSWERS.good17).lines, [KIT18_LINE("1.7"), LEVELS18_LINE(["1.6", "1.5"]), DECIMALS_LINE, RESULT17_LINE]);
});

test("planted on the good answer at 1.8: no decimals strip, another version or other levels: each FAIL, named", () => {
  const g = ANSWERS.good18;
  assert.deepEqual(judge18({ ...g, hello: { ...g.hello, decimals: null } }).lines, [DECIMALS_LINE]);
  assert.deepEqual(judge18({ ...g, hello: { ...g.hello, result17: null } }).lines, [RESULT17_LINE]);
  for (const v of ["1.7", "1.9", null]) assert.deepEqual(judge18({ ...g, hello: { ...g.hello, kit: v } }).lines, [KIT18_LINE(v ?? "?")], `kit ${v}`);
  for (const l of [["1.6", "1.5"], ["1.7", "1.5"], ["1.7", "1.6", "1.5", "1.4"], null])
    assert.deepEqual(judge18({ ...g, hello: { ...g.hello, levels: l } }).lines, [LEVELS18_LINE(l)], JSON.stringify(l));
});

test("facts() on a bundle whose state shaper keeps decimals below the current level reads no decimals strip", () => {
  const g = ANSWERS.good18;
  const js = `X=e=>({...e,positions:e.positions.map(({decimals:e,...t})=>t)});F=e=>e.filter(e=>e.kind!==\`pool_deposit\`);`;
  assert.equal(facts(g.index ?? "", js).hello.decimals, null);
});

test("review of edc6815f: recorded bad answer badNoResult17: the good build with kit-v1.7's answer branch cut (its deposit.confirm down the kit-v1.4 path): FAIL, named", () => {
  const b = ANSWERS.badNoResult17;
  assert.notEqual(b.sha384, ANSWERS.good18.sha384);
  assert.equal(b.hello.result17, null);
  assert.equal(typeof b.hello.result16, "string", "the kit-v1.6 branch is still read: only the 1.7 alternative is cut");
  assert.deepEqual(judge18(b).lines, [RESULT17_LINE]);
  assert.match(ANSWERS.good18.hello.result17, /if\(([\w$]+)===`1\.7`\|\|\1===`1\.6`\)return /);
  // a 1.7-era record has no such alternative and is not asked for one at its own era
  assert.equal(ANSWERS.good17.hello.result17, undefined);
  assert.deepEqual(judge(ANSWERS.good17).lines, []);
});

// ------------------------------------------------------------------------------------------------ card kit-portfolio-reads
test("kit-portfolio-reads: the good build reads kit 1.9 in full, kit-v1.8 to kit-v1.5 below it, each op with no detail there, and kit-v1.8's answers through its own level", () => {
  const g = ANSWERS.good19;
  assert.equal(g.hello.kit, "1.9");
  assert.deepEqual(g.hello.levels, ["1.8", "1.7", "1.6", "1.5"]);
  assert.match(g.hello.detail, /let ([\w$]+)=\{\.\.\.([\w$]+),ops:\2\.ops\.map\(([\w$]+)\)\};if\(([\w$]+)===`1\.8`\)return \1;let ([\w$]+)=([\w$]+)\(\1\);if\(\4===`1\.7`\)return \5;/);
  assert.match(g.hello.result18, /if\(([\w$]+)===`1\.8`\|\|\1===`1\.7`\|\|\1===`1\.6`\)return /);
  assert.deepEqual(judge19(g).lines, []);
});

test("kit-portfolio-reads: recorded bad answers: the kit 1.8 build (good18) and its plants at 1.9, and badNoDetail and badNoResult18 cut from its build (good19): each FAIL, named", () => {
  assert.deepEqual(judge19(ANSWERS.good18).lines, [KIT19_LINE("1.8"), LEVELS19_LINE(["1.7", "1.6", "1.5"]), DETAIL_LINE, RESULT18_LINE]);
  for (const [k, line] of [["badNoDetail", DETAIL_LINE], ["badNoResult18", RESULT18_LINE]]) {
    assert.notEqual(ANSWERS[k].sha384, ANSWERS.good19.sha384, k);
    assert.deepEqual(ANSWERS[k].maps, ANSWERS.good19.maps, k);
    assert.deepEqual(judge19(ANSWERS[k]).lines, [line], k);
  }
  const g = ANSWERS.good19;
  for (const v of ["1.8", "1.10", null]) assert.deepEqual(judge19({ ...g, hello: { ...g.hello, kit: v } }).lines, [KIT19_LINE(v ?? "?")], `kit ${v}`);
  for (const l of [["1.7", "1.6", "1.5"], ["1.8", "1.6", "1.5"], null]) assert.deepEqual(judge19({ ...g, hello: { ...g.hello, levels: l } }).lines, [LEVELS19_LINE(l)], JSON.stringify(l));
});

test("kit-portfolio-reads: facts() reads no detail strip from a shaper that keeps an op's detail, takes a pool deposit's chain or a deposit's amount_usd, or has no kit-v1.8 level", () => {
  const S = "function S(e,t){if(e===`current`)return t;let n={...t,ops:t.ops.map(jl)};if(e===`1.8`)return n;let r=Al(n);if(e===`1.7`)return r;if(e===`1.6`)return{...r,ops:kl(r.ops)};if(e===`1.5`)return{...r,ops:kl(r.ops).map(e=>e)};return r}";
  const J = "function jl(e){let{created_ms:t,token:n,units:r,...i}=e,a=i;return e.kind!==`pool_deposit`&&delete a.chain,e.kind!==`deposit`&&delete a.amount_usd,a}";
  const P = "var Al=e=>({...e,positions:e.positions.map(({decimals:e,...t})=>t)}),kl=e=>e.filter(e=>e.kind!==`pool_deposit`);";
  const SH = "function sh(e){let r=`1.4`,i=(e,t)=>{if(`ok`in e)return e.ok&&t!==void 0?{...e,result:R(r,t,e.result)}:e;if(e.type===`state`)return{...e,state:S(r,e.state)};},c=async i=>{let c=zc(i);if(c!==null)return void(r=Bc(c));}}";
  const HELLO = "function zc(e){return t.length!==3||n.v!==1||n.type!==`hello`||!Object.hasOwn(n,`kit`)||typeof n.kit!=`string`?null:n.kit}function Bc(e){let t=Rc.exec(e);if(!t)return`1.4`;let[n,r]=[1,9],i=(e,t)=>n>e;return i(Lc[0],Lc[1])?`current`:`1.4`}";
  const js = (j = J, s = S) => `${P}${HELLO}${j}${s}${SH}`;
  assert.equal(typeof facts("", js()).hello.detail, "string");
  assert.equal(facts("", js(J.replace("created_ms:t,", ""))).hello.detail, null, "created_ms kept");
  assert.equal(facts("", js(J.replace("e.kind!==`pool_deposit`&&delete a.chain", "delete a.chain"))).hello.detail, null, "a pool deposit's chain taken");
  assert.equal(facts("", js(J.replace("e.kind!==`deposit`&&delete a.amount_usd", "delete a.amount_usd"))).hello.detail, null, "a deposit's amount_usd taken");
  assert.equal(facts("", js(J, S.replace("if(e===`1.8`)return n;", ""))).hello.detail, null, "no kit-v1.8 level");
  assert.equal(facts("", js(J, S.replace("ops:t.ops.map(jl)", "ops:t.ops"))).hello.detail, null, "the strip not called");
});

// ------------------------------------------------------------------------------------------------ card portfolio-shows-pool-trades
test("portfolio-shows-pool-trades: the good build reads kit 1.10 in full, kit-v1.9 to kit-v1.5 below it, each op with no pool_amount there, and kit-v1.9's state and answers through its own level", () => {
  const g = ANSWERS.good110;
  assert.equal(g.hello.kit, "1.10");
  assert.deepEqual(g.hello.levels, ["1.9", "1.8", "1.7", "1.6", "1.5"]);
  assert.match(g.hello.amount, /return [\w$]+;if\(([\w$]+)===`1\.9`\)return\{\.\.\.([\w$]+),ops:\2\.ops\.map\(([\w$]+)\)\};let ([\w$]+)=\{\.\.\.\2,ops:\2\.ops\.map\(([\w$]+)\)\};if\(\1===`1\.8`\)return \4;/);
  assert.match(g.hello.result19, /if\(([\w$]+)===`1\.9`\|\|\1===`1\.8`\|\|\1===`1\.7`\|\|\1===`1\.6`\)return /);
  assert.deepEqual(judge110(g).lines, []);
  assert.deepEqual(judge19(ANSWERS.good19).lines, [], "the 1.9 build at its own era");
});

test("portfolio-shows-pool-trades: recorded bad answers: the kit 1.9 build (good19) at 1.10, and badNoV19State, badPoolAmountBelow and badNoResult19 cut from its build (good110): each FAIL, named", () => {
  assert.deepEqual(judge110(ANSWERS.good19).lines, [KIT110_LINE("1.9"), LEVELS110_LINE(["1.8", "1.7", "1.6", "1.5"]), AMOUNT_LINE, RESULT19_LINE]);
  for (const [k, line] of [["badNoV19State", AMOUNT_LINE], ["badPoolAmountBelow", AMOUNT_LINE], ["badNoResult19", RESULT19_LINE]]) {
    assert.notEqual(ANSWERS[k].sha384, ANSWERS.good110.sha384, k);
    assert.deepEqual(ANSWERS[k].maps, ANSWERS.good110.maps, k);
    assert.deepEqual(judge110(ANSWERS[k]).lines, [line], k);
  }
  assert.equal(ANSWERS.badNoResult19.hello.result18 !== null, true, "only the 1.9 alternative is cut");
  const g = ANSWERS.good110;
  assert.deepEqual(judge110({ ...g, hello: { ...g.hello, amount: null } }).lines, [AMOUNT_LINE]);
  assert.deepEqual(judge110({ ...g, hello: { ...g.hello, result19: null } }).lines, [RESULT19_LINE]);
  for (const v of ["1.9", "1.11", null]) assert.deepEqual(judge110({ ...g, hello: { ...g.hello, kit: v } }).lines, [KIT110_LINE(v ?? "?")], `kit ${v}`);
  for (const l of [["1.8", "1.7", "1.6", "1.5"], ["1.9", "1.7", "1.6", "1.5"], null]) assert.deepEqual(judge110({ ...g, hello: { ...g.hello, levels: l } }).lines, [LEVELS110_LINE(l)], JSON.stringify(l));
});

test("portfolio-shows-pool-trades: facts() reads the version from a constant the minifier hoists (`X=C.split`), only when that constant is set once", () => {
  const js = "var Rs=`1.10`,z=1;Dl=Rs.split(`.`).map(Number);function Al(e){let t=Ol.exec(e);if(!t)return`1.4`;let[n,r]=[Number(t[1]),Number(t[2])],i=(e,t)=>n>e||n===e&&r>=t;return i(Dl[0],Dl[1])?`current`:i(1,9)?`1.9`:i(1,5)?`1.5`:`1.4`}";
  const HELLO = "function kl(e){return t.length!==3||n.v!==1||n.type!==`hello`||!Object.hasOwn(n,`kit`)||typeof n.kit!=`string`?null:n.kit}";
  const SH = "function sh(e){let r=`1.4`,i=(e,t)=>{if(`ok`in e)return e;},c=async i=>{let c=kl(i);if(c!==null)return void(r=Al(c));}}";
  const f = (j) => facts("", `${HELLO}${j}${SH}`).hello;
  assert.equal(f(js).kit, "1.10");
  assert.deepEqual(f(js).levels, ["1.9", "1.5"]);
  assert.equal(f(js.replace("var Rs=`1.10`,", "var Rs=`1.10`,Q=0;Rs=`1.9`;")).kit, null, "set twice");
  assert.equal(f(js.replace("var Rs=`1.10`,", "var Rs=x,")).kit, null, "not a version");
});

// ------------------------------------------------------------------------------------------------ card portfolio-counts-money-an-open-buy-holds
test("portfolio-counts-money-an-open-buy-holds: its good build (good111) reads kit 1.11 in full, kit-v1.10 to kit-v1.5 below it, each position with no asset_held there, and kit-v1.10's state and answers through its own level", () => {
  const g = ANSWERS.good111;
  assert.equal(g.hello.kit, "1.11");
  assert.deepEqual(g.hello.levels, ["1.10", "1.9", "1.8", "1.7", "1.6", "1.5"]);
  assert.match(g.hello.held, /\{if\(([\w$]+)===`current`\)return ([\w$]+);let ([\w$]+)=([\w$]+)\(\2\);if\(\1===`1\.10`\)return \3;if\(\1===`1\.9`\)return\{\.\.\.\3,ops:\3\.ops\.map\(([\w$]+)\)\};let ([\w$]+)=\{\.\.\.\3,ops:\3\.ops\.map\(([\w$]+)\)\};if\(\1===`1\.8`\)return \6;/);
  assert.equal(g.hello.amount, g.hello.held, "kit-v1.9's level is still read on the stripped state");
  assert.match(g.hello.result110, /if\(([\w$]+)===`1\.10`\|\|\1===`1\.9`\|\|\1===`1\.8`\|\|\1===`1\.7`\|\|\1===`1\.6`\)return /);
  assert.deepEqual(judge111(g).lines, []);
  assert.deepEqual(judge110(ANSWERS.good110).lines, [], "the 1.10 build at its own era");
});

test("portfolio-counts-money-an-open-buy-holds: recorded bad answers: the kit 1.10 build (good110) at 1.11, and badNoAssetHeld, badKit110 and badNoResult110 cut from its build (good111): each FAIL, named", () => {
  assert.deepEqual(judge111(ANSWERS.good110).lines, [KIT111_LINE("1.10"), LEVELS111_LINE(["1.9", "1.8", "1.7", "1.6", "1.5"]), HELD_LINE, RESULT110_LINE]);
  for (const [k, line] of [["badNoAssetHeld", HELD_LINE], ["badKit110", KIT111_LINE("1.10")], ["badNoResult110", RESULT110_LINE]]) {
    assert.notEqual(ANSWERS[k].sha384, ANSWERS.good111.sha384, k);
    assert.deepEqual(ANSWERS[k].maps, ANSWERS.good111.maps, k);
    assert.deepEqual(judge111(ANSWERS[k]).lines, [line], k);
  }
  assert.equal(typeof ANSWERS.badNoAssetHeld.hello.poolOps, "string", "the state shaper is still read: only the strip keeps asset_held");
  assert.equal(typeof ANSWERS.badNoResult110.hello.result19, "string", "only the 1.10 alternative is cut");
  const g = ANSWERS.good111;
  assert.deepEqual(judge111({ ...g, hello: { ...g.hello, held: null } }).lines, [HELD_LINE]);
  assert.deepEqual(judge111({ ...g, hello: { ...g.hello, result110: null } }).lines, [RESULT110_LINE]);
  for (const v of ["1.10", "1.12", null]) assert.deepEqual(judge111({ ...g, hello: { ...g.hello, kit: v } }).lines, [KIT111_LINE(v ?? "?")], `kit ${v}`);
  for (const l of [["1.9", "1.8", "1.7", "1.6", "1.5"], ["1.10", "1.8", "1.7", "1.6", "1.5"], null]) assert.deepEqual(judge111({ ...g, hello: { ...g.hello, levels: l } }).lines, [LEVELS111_LINE(l)], JSON.stringify(l));
});

test("portfolio-counts-money-an-open-buy-holds: facts() reads no asset_held strip from a shaper whose strip keeps it, that has no kit-v1.10 level, or builds a lower level on the given state", () => {
  const S = "function S(e,t){if(e===`current`)return t;let n=Vl(t);if(e===`1.10`)return n;if(e===`1.9`)return{...n,ops:n.ops.map(Hl)};let r={...n,ops:n.ops.map(Ul)};if(e===`1.8`)return r;let i=Bl(r);if(e===`1.7`)return i;if(e===`1.6`)return{...i,ops:zl(i.ops)};if(e===`1.5`)return{...i,ops:zl(i.ops).map(e=>e)};return i}";
  const V = "var Vl=e=>({...e,positions:e.positions.map(({asset_held:e,...t})=>t)});";
  const P = "var zl=e=>e.filter(e=>e.kind!==`pool_deposit`),Bl=e=>({...e,positions:e.positions.map(({decimals:e,...t})=>t)});";
  const SH = "function sh(e){let r=`1.4`,i=(e,t)=>{if(`ok`in e)return e.ok&&t!==void 0?{...e,result:R(r,t,e.result)}:e;if(e.type===`state`)return{...e,state:S(r,e.state)};},c=async i=>{let c=zc(i);if(c!==null)return void(r=Bc(c));}}";
  const HELLO = "function zc(e){return t.length!==3||n.v!==1||n.type!==`hello`||!Object.hasOwn(n,`kit`)||typeof n.kit!=`string`?null:n.kit}function Bc(e){let t=Rc.exec(e);if(!t)return`1.4`;let[n,r]=[1,9],i=(e,t)=>n>e;return i(Lc[0],Lc[1])?`current`:`1.4`}";
  const js = (v = V, s = S) => `${P}${v}${HELLO}${s}${SH}`;
  assert.equal(typeof facts("", js()).hello.held, "string");
  assert.equal(facts("", js(V.replace("({asset_held:e,...t})=>t", "t=>t"))).hello.held, null, "the strip keeps asset_held");
  assert.equal(facts("", js(V.replace("asset_held:e", "decimals:e"))).hello.held, null, "the strip takes another key");
  assert.equal(facts("", js(V, S.replace("let n=Vl(t);", "let n=Bl(t);"))).hello.held, null, "another function in its place");
  assert.equal(facts("", js(V, S.replace("if(e===`1.10`)return n;", ""))).hello.held, null, "no kit-v1.10 level");
  assert.equal(facts("", js(V, S.replace("if(e===`1.10`)return n;", "if(e===`1.10`)return t;"))).hello.held, null, "kit-v1.10 sent the given state");
  assert.equal(facts("", js(V, S.replace("return{...n,ops:n.ops.map(Hl)}", "return{...t,ops:t.ops.map(Hl)}"))).hello.held, null, "kit-v1.9 built on the given state");
  assert.equal(facts("", js(V, S.replace("let r={...n,ops:n.ops.map(Ul)}", "let r={...t,ops:t.ops.map(Ul)}"))).hello.held, null, "kit-v1.8 and below built on the given state");
});

// ------------------------------------------------------------------------------------------------ card buy-spends-several-pieces
test("buy-spends-several-pieces: its good build (good112) reads kit 1.12 in full, kit-v1.11 to kit-v1.5 below it, each pool entry with no making there and the asset_held strip built on that, pool.buy.dry with no pieces and cost there, and kit-v1.11's state and answers through its own level", () => {
  const g = ANSWERS.good112;
  assert.equal(g.hello.kit, "1.12");
  assert.deepEqual(g.hello.levels, ["1.11", "1.10", "1.9", "1.8", "1.7", "1.6", "1.5"]);
  assert.match(g.hello.making, /\{if\(([\w$]+)===`current`\)return ([\w$]+);let ([\w$]+)=([\w$]+)\(\2\);if\(\1===`1\.11`\)return \3;let ([\w$]+)=([\w$]+)\(\3\);if\(\1===`1\.10`\)return \5;/);
  assert.equal(g.hello.held, g.hello.making, "kit-v1.10's level is read on the state with no making");
  assert.match(g.hello.dry, /\)return ([\w$]+);let ([\w$]+)=[\w$]+\([\w$]+,\1\);if\(([\w$]+)===`1\.11`\|\|\3===`1\.10`\|\|\3===`1\.9`\|\|\3===`1\.8`\|\|\3===`1\.7`\|\|\3===`1\.6`\)return [\w$]+===`state`\?[\w$]+\(\3,\2\):\2;/);
  assert.equal(g.hello.result111, g.hello.dry);
  assert.deepEqual(judge112(g).lines, []);
  assert.deepEqual(judge111(ANSWERS.good111).lines, [], "the 1.11 build at its own era");
});

test("buy-spends-several-pieces: recorded bad answers: the kit 1.11 build (good111) at 1.12, and badNoMaking, badNoDry, badKit111 and badNoResult111 cut from its build (good112): each FAIL, named", () => {
  assert.deepEqual(judge112(ANSWERS.good111).lines, [KIT112_LINE("1.11"), LEVELS112_LINE(["1.10", "1.9", "1.8", "1.7", "1.6", "1.5"]), MAKING_LINE, DRY_LINE, RESULT111_LINE]);
  for (const [k, line] of [["badNoMaking", MAKING_LINE], ["badNoDry", DRY_LINE], ["badKit111", KIT112_LINE("1.11")], ["badNoResult111", RESULT111_LINE]]) {
    assert.notEqual(ANSWERS[k].sha384, ANSWERS.good112.sha384, k);
    assert.deepEqual(ANSWERS[k].maps, ANSWERS.good112.maps, k);
    assert.deepEqual(judge112(ANSWERS[k]).lines, [line], k);
  }
  assert.equal(typeof ANSWERS.badNoMaking.hello.held, "string", "the state shaper is still read: only the strip keeps making");
  assert.equal(typeof ANSWERS.badNoDry.hello.result111, "string", "the answer shaper is still read: only the strip keeps pieces and cost");
  assert.equal(typeof ANSWERS.badNoResult111.hello.dry, "string", "only the 1.11 alternative is cut");
  const g = ANSWERS.good112;
  assert.deepEqual(judge112({ ...g, hello: { ...g.hello, making: null } }).lines, [MAKING_LINE]);
  assert.deepEqual(judge112({ ...g, hello: { ...g.hello, dry: null } }).lines, [DRY_LINE]);
  assert.deepEqual(judge112({ ...g, hello: { ...g.hello, result111: null } }).lines, [RESULT111_LINE]);
  for (const v of ["1.11", "1.13", null]) assert.deepEqual(judge112({ ...g, hello: { ...g.hello, kit: v } }).lines, [KIT112_LINE(v ?? "?")], `kit ${v}`);
  for (const l of [["1.10", "1.9", "1.8", "1.7", "1.6", "1.5"], ["1.11", "1.9", "1.8", "1.7", "1.6", "1.5"], null]) assert.deepEqual(judge112({ ...g, hello: { ...g.hello, levels: l } }).lines, [LEVELS112_LINE(l)], JSON.stringify(l));
});

test("buy-spends-several-pieces: facts() reads no making strip from a shaper whose strip keeps it, that has no kit-v1.11 level, or builds a lower level on the given state; and no dry strip from an answer shaper that skips it", () => {
  const S = "function S(e,t){if(e===`current`)return t;let n=Ml(t);if(e===`1.11`)return n;let r=Vl(n);if(e===`1.10`)return r;if(e===`1.9`)return{...r,ops:r.ops.map(Hl)};let i={...r,ops:r.ops.map(Ul)};if(e===`1.8`)return i;let a=Bl(i);if(e===`1.7`)return a;if(e===`1.6`)return{...a,ops:zl(a.ops)};if(e===`1.5`)return{...a,ops:zl(a.ops).map(e=>e)};return a}";
  const R = "function R(e,t,n){if(e===`current`)return n;let r=Dl(t,n);if(e===`1.11`||e===`1.10`||e===`1.9`||e===`1.8`||e===`1.7`||e===`1.6`)return t===`state`?S(e,r):r;return r}";
  const M = "var Ml=e=>e.pools===void 0?e:{...e,pools:e.pools.map(({making:e,...t})=>t)},Dl=(e,t)=>{if(e!==`pool.buy.dry`||typeof t!=`object`||!t)return t;let{pieces:n,cost:r,...i}=t;return i},Vl=e=>({...e,positions:e.positions.map(({asset_held:e,...t})=>t)});";
  const P = "var zl=e=>e.filter(e=>e.kind!==`pool_deposit`),Bl=e=>({...e,positions:e.positions.map(({decimals:e,...t})=>t)});";
  const SH = "function sh(e){let r=`1.4`,i=(e,t)=>{if(`ok`in e)return e.ok&&t!==void 0?{...e,result:R(r,t,e.result)}:e;if(e.type===`state`)return{...e,state:S(r,e.state)};},c=async i=>{let c=zc(i);if(c!==null)return void(r=Bc(c));}}";
  const HELLO = "function zc(e){return t.length!==3||n.v!==1||n.type!==`hello`||!Object.hasOwn(n,`kit`)||typeof n.kit!=`string`?null:n.kit}function Bc(e){let t=Rc.exec(e);if(!t)return`1.4`;let[n,r]=[1,9],i=(e,t)=>n>e;return i(Lc[0],Lc[1])?`current`:`1.4`}";
  const js = (m = M, s = S, r = R) => `${P}${m}${HELLO}${s}${r}${SH}`;
  const h = (...a) => facts("", js(...a)).hello;
  for (const k of ["making", "held", "dry", "result111"]) assert.equal(typeof h()[k], "string", k);
  assert.equal(h(M.replace("({making:e,...t})=>t", "t=>t")).making, null, "the strip keeps making");
  assert.equal(h(M.replace("making:e", "ready:e")).making, null, "the strip takes another key");
  assert.equal(h(M, S.replace("let n=Ml(t);", "let n=Bl(t);")).making, null, "another function in its place");
  assert.equal(h(M, S.replace("if(e===`1.11`)return n;", "if(e===`1.11`)return t;")).making, null, "kit-v1.11 sent the given state");
  assert.equal(h(M, S.replace("let r=Vl(n);", "let r=Vl(t);")).making, null, "the asset_held strip built on the given state");
  assert.equal(h(M.replace("return i}", "return t}")).dry, null, "the dry strip returns the answer as it is");
  assert.equal(h(M.replace("e!==`pool.buy.dry`", "e!==`pool.buy`")).dry, null, "the dry strip names another kind");
  assert.equal(h(M, S, R.replace("let r=Dl(t,n);", "let r=Ml(t,n);")).dry, null, "another function in its place");
  assert.equal(h(M, S, R.replace("return t===`state`?S(e,r):r;return r", "return t===`state`?S(e,n):n;return r")).result16, null, "the branch reads the given result");
  assert.equal(h(M, S, R.replace("e===`1.11`||", "")).result111, null, "no kit-v1.11 alternative");
});

// ------------------------------------------------------------------------------------------------ card signing-layer-says-when-it-closes
test("signing-layer-says-when-it-closes: the good build reads kit 1.13 in full, kit-v1.12 to kit-v1.5 below it, each open kind's answer with no closes there and kit-v1.12 its own level on that, and kit-v1.12 sent the state in full", () => {
  assert.equal(KIT, "1.13");
  assert.deepEqual(LEVELS, ["1.12", "1.11", "1.10", "1.9", "1.8", "1.7", "1.6", "1.5"]);
  const g = ANSWERS.good;
  assert.equal(g.hello.kit, "1.13");
  assert.deepEqual(g.hello.levels, LEVELS);
  assert.match(g.hello.closes, /\{if\(([\w$]+)===`current`\)return ([\w$]+);let ([\w$]+)=[\w$]+\([\w$]+,\2\);if\(\1===`1\.12`\)return \3;let ([\w$]+)=[\w$]+\([\w$]+,\3\);if\(\1===`1\.11`\|\|/);
  assert.equal(g.hello.dry, g.hello.closes, "the dry strip is read on the answer with no closes");
  assert.deepEqual(g.hello.closeKinds, OPEN_KINDS);
  assert.match(g.hello.state112, /^function [\w$]+\(([\w$]+),([\w$]+)\)\{if\(\1===`current`\|\|\1===`1\.12`\)return \2;/);
  assert.equal(g.hello.making, g.hello.state112, "kit-v1.11's level still strips making below kit-v1.12");
  assert.deepEqual(judgeNow(g).lines, []);
  assert.deepEqual(judge112(ANSWERS.good112).lines, [], "the 1.12 build at its own era");
});

test("signing-layer-says-when-it-closes: recorded bad answers: the kit 1.12 build (good112) at 1.13, and badClosesKept, badCloseKinds, badNoV112Level, badKit112 and badState112Stripped cut from this card's build: each FAIL, named", () => {
  assert.deepEqual(judgeNow(ANSWERS.good112).lines, [KIT113_LINE("1.12"), LEVELS113_LINE(["1.11", "1.10", "1.9", "1.8", "1.7", "1.6", "1.5"]), CLOSES_LINE, STATE112_LINE]);
  const cuts = [
    ["badClosesKept", CLOSES_LINE],
    ["badCloseKinds", KINDS_LINE(["withdraw.open", "signin.open", "backup.open", "export.open", "pool.withdraw"])],
    ["badNoV112Level", LEVELS113_LINE(["1.11", "1.10", "1.9", "1.8", "1.7", "1.6", "1.5"])],
    ["badKit112", KIT113_LINE("1.12")],
    ["badState112Stripped", STATE112_LINE],
  ];
  for (const [k, line] of cuts) {
    assert.notEqual(ANSWERS[k].sha384, ANSWERS.good.sha384, k);
    assert.deepEqual(ANSWERS[k].maps, ANSWERS.good.maps, k);
    assert.deepEqual(judgeNow(ANSWERS[k]).lines, [line], k);
  }
  assert.equal(typeof ANSWERS.badClosesKept.hello.dry, "string", "the answer shaper is still read: only the strip keeps closes");
  assert.equal(typeof ANSWERS.badState112Stripped.hello.making, "string", "the state shaper is still read: only kit-v1.12's full state is cut");
  const g = ANSWERS.good;
  assert.deepEqual(judgeNow({ ...g, hello: { ...g.hello, closes: null } }).lines, [CLOSES_LINE]);
  assert.deepEqual(judgeNow({ ...g, hello: { ...g.hello, closeKinds: null } }).lines, [KINDS_LINE(null)]);
  assert.deepEqual(judgeNow({ ...g, hello: { ...g.hello, closeKinds: [...OPEN_KINDS, "deposit.confirm"] } }).lines, [KINDS_LINE([...OPEN_KINDS, "deposit.confirm"])]);
  assert.deepEqual(judgeNow({ ...g, hello: { ...g.hello, state112: null } }).lines, [STATE112_LINE]);
  for (const v of ["1.12", "1.14", null]) assert.deepEqual(judgeNow({ ...g, hello: { ...g.hello, kit: v } }).lines, [KIT113_LINE(v ?? "?")], `kit ${v}`);
});

test("signing-layer-says-when-it-closes: facts() reads no closes strip from a shaper whose strip keeps it, reads another key or kind list, that has no kit-v1.12 level, or builds a lower level on the given answer", () => {
  const S = "function S(e,t){if(e===`current`||e===`1.12`)return t;let n=Ml(t);if(e===`1.11`)return n;let r=Vl(n);if(e===`1.10`)return r;if(e===`1.9`)return{...r,ops:r.ops.map(Hl)};let i={...r,ops:r.ops.map(Ul)};if(e===`1.8`)return i;let a=Bl(i);if(e===`1.7`)return a;if(e===`1.6`)return{...a,ops:zl(a.ops)};if(e===`1.5`)return{...a,ops:zl(a.ops).map(e=>e)};return a}";
  const R = "function R(e,t,n){if(e===`current`)return n;let r=Cl(t,n);if(e===`1.12`)return r;let i=Dl(t,r);if(e===`1.11`||e===`1.10`||e===`1.9`||e===`1.8`||e===`1.7`||e===`1.6`)return t===`state`?S(e,i):i;return i}";
  const K = "var Is=[`withdraw.open`,`signin.open`,`backup.open`,`export.open`,`signout`,`pool.withdraw`];";
  const M = "var Ml=e=>e.pools===void 0?e:{...e,pools:e.pools.map(({making:e,...t})=>t)},Dl=(e,t)=>{if(e!==`pool.buy.dry`||typeof t!=`object`||!t)return t;let{pieces:n,cost:r,...i}=t;return i},Cl=(e,t)=>{if(!Is.includes(e)||typeof t!=`object`||!t)return t;let{closes:n,...r}=t;return r},Vl=e=>({...e,positions:e.positions.map(({asset_held:e,...t})=>t)});";
  const P = "var zl=e=>e.filter(e=>e.kind!==`pool_deposit`),Bl=e=>({...e,positions:e.positions.map(({decimals:e,...t})=>t)});";
  const SH = "function sh(e){let r=`1.4`,i=(e,t)=>{if(`ok`in e)return e.ok&&t!==void 0?{...e,result:R(r,t,e.result)}:e;if(e.type===`state`)return{...e,state:S(r,e.state)};},c=async i=>{let c=zc(i);if(c!==null)return void(r=Bc(c));}}";
  const HELLO = "function zc(e){return t.length!==3||n.v!==1||n.type!==`hello`||!Object.hasOwn(n,`kit`)||typeof n.kit!=`string`?null:n.kit}function Bc(e){let t=Rc.exec(e);if(!t)return`1.4`;let[n,r]=[1,9],i=(e,t)=>n>e;return i(Lc[0],Lc[1])?`current`:`1.4`}";
  const h = (m = M, s = S, r = R, k = K) => facts("", `${P}${k}${m}${HELLO}${s}${r}${SH}`).hello;
  for (const x of ["closes", "state112", "making", "held", "dry", "result111"]) assert.equal(typeof h()[x], "string", x);
  assert.deepEqual(h().closeKinds, OPEN_KINDS);
  assert.equal(h(M.replace("let{closes:n,...r}=t;return r}", "let{closes:n,...r}=t;return t}")).closes, null, "the strip returns the answer as it is");
  assert.equal(h(M.replace("let{closes:n,", "let{pending:n,")).closes, null, "the strip takes another key");
  assert.equal(h(M, S, R, K.replace(",`signout`", "")).closeKinds.includes("signout"), false, "the kinds read as the bundle has them");
  assert.equal(h(M, S, R, "").closeKinds, null, "no kind list");
  assert.equal(h(M, S, R.replace("let r=Cl(t,n);", "let r=Ml(t,n);")).closes, null, "another function in its place");
  assert.equal(h(M, S, R.replace("if(e===`1.12`)return r;", "")).closes, null, "no kit-v1.12 level");
  assert.equal(h(M, S, R.replace("if(e===`1.12`)return r;", "if(e===`1.12`)return n;")).closes, null, "kit-v1.12 sent the given answer");
  assert.equal(h(M, S, R.replace("let i=Dl(t,r);", "let i=Dl(t,n);")).closes, null, "the dry strip built on the given answer");
  assert.equal(h(M, S.replace("if(e===`current`||e===`1.12`)return t;", "if(e===`current`)return t;")).state112, null, "kit-v1.12 sent the stripped state");
  assert.equal(h(M, S.replace("if(e===`current`||e===`1.12`)return t;", "if(e===`current`||e===`1.11`)return t;")).state112, null, "another level sent the state in full");
});
