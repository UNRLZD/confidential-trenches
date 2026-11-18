// node --test scripts/live-checks/vault-late-send-carried.test.mjs: the live check replays its recorded answers
// (vault-late-send-carried.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as served before the
// card: FAIL, each fact named. Planted on the good one: another /app.js, no pin, each fact taken away: each FAIL.
// Planted in this tree's build: each rule broken in place: its fact false.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { signBuilt } from "../signpage-built.mjs";
import { facts, judge, WHY } from "./vault-late-send-carried.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./vault-late-send-carried.answers.json", import.meta.url), "utf8"));

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before the card: FAIL, each fact named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, Object.values(WHY).map((w) => `BAD ${w}`));
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [k, why] of Object.entries(WHY)) assert.deepEqual(judge({ ...g, [k]: false }).lines, [`BAD ${why}`], k);
});

test("this tree's build holds every fact; each rule broken in place in it turns its fact false", () => {
  const dir = signBuilt();
  const js = readFileSync(`${dir}/public/app.js`, "utf8");
  const f = (text) => facts("", text);
  const all = (x) => ({ reread: x.reread, rule: x.rule, wired: x.wired, carry: x.carry });
  assert.deepEqual(all(f(js)), { reread: true, rule: true, wired: true, carry: true });
  const mut = (from, to) => {
    assert.equal([...js.matchAll(new RegExp(from.source, "g"))].length, 1, String(from));
    return f(js.replace(from, to));
  };
  // step 7's re-reads: one state in place of each provider's amounts
  assert.equal(mut(/,held:await ([\w$]+)\(([\w$]+)\.id\)\}\)\}catch/, ",state:await $1($2.id)})}catch").reread, false, "one state taken");
  // the rule: two apart taken, a failed read taken as nothing, an intents.near asset taken as the token
  assert.equal(mut(/for\(let\{asset:([\w$]+),amounts:\[([\w$]+),([\w$]+)\]\}of ([\w$]+)\.held\)\2===\3\?/, "for(let{asset:$1,amounts:[$2,$3]}of $4.held)!0?").rule, false, "two apart taken");
  assert.equal(mut(/return\{found:null,why:\[\{text:`its read failed \(\$\{([\w$]+)\.error\}\): read again`,retry:!0\}\]\}/, "return{found:null,why:[]}").rule, false, "a failed read taken as nothing");
  assert.equal(mut(/\?([\w$]+)===([\w$]+)\?([\w$]+)>0n&&/, "?!0?$3>0n&&").rule, false, "any asset taken as the token");
  // readVaultLate: under MIN_DEPOSIT carried, no note written, the carry's end dropped, the vault's ids never read
  assert.equal(mut(/\[0\]<([\w$]+)\.MIN_DEPOSIT\)continue;/, "[0]<0n)continue;").wired, false, "under MIN_DEPOSIT carried");
  assert.equal(mut(/try\{await ([\w$]+)\.found\(([\w$]+)\.scope,([\w$]+)\.i,([\w$]+)\)\}catch/, "try{void 0}catch").wired, false, "carried with no note written");
  assert.equal(mut(/;([\w$]+)!==null&&\(\1\.retry\?([\w$]+)\.held:\2\.named\)\.push\(`\$\{([\w$]+)\} \$\{\1\.why\}`\)\}\}var/, ";void $1}}var").wired, false, "a carry's end dropped");
  assert.equal(mut(/([\w$]+)!==null&&([\w$]+)!==null&&await ([\w$]+)\(([^)]*)\)\.catch\(([\w$]+)=>\{if\(\5 instanceof/, "!1&&$2!==null&&await $3($4).catch($5=>{if($5 instanceof").wired, false, "the vault's ids never read");
  // the carry: a wait that holds the seed (onWait returns), a carry that did not land taken as done
  assert.equal(mut(/onWait:\(([\w$]+),([\w$]+)\)=>\{throw new ([\w$]+)\(\1,\2\?\?1e3\)\}/, "onWait:($1,$2)=>{}").carry, false, "the seed held across a wait");
  assert.equal(mut(/return ([\w$]+)\.kind===`deposited`\?null:/, "return !0?null:").carry, false, "every end taken as deposited");
});
