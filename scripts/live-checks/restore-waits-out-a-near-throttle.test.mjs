// node --test scripts/live-checks/restore-waits-out-a-near-throttle.test.mjs: the live check replays its recorded answers
// (restore-waits-out-a-near-throttle.answers.json). good: this card's SIGN_HOST build: PASS. bad: the base f5a25bd23
// build, whose vault sync stops on a NEAR provider's first 429 past the pace's tries (release 162 live, 16 Nov 04:32Z:
// "near vault: vault sync stopped (rpc): https://near.drpc.org: HTTP 429"): FAIL, each mark named. Planted on the good
// one: another /app.js, no pin, each mark taken away: each FAIL; and on the bundle's own pieces.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./restore-waits-out-a-near-throttle.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./restore-waits-out-a-near-throttle.answers.json", import.meta.url), "utf8"));
const NO_RULE = "BAD the bundle holds no one throttle rule (from 1 s, doubling to 10 s, a Retry-After up to 10 s)";
const NO_WAIT = "BAD the vault's reads do not wait out a throttle on the one rule within 30 s, ending in VaultThrottled";
const NO_KINDS = "BAD a throttle is not HTTP 429 (with its Retry-After) and a rate limit in a 200 (15, -429, 429) alone";
const NO_SYNC = "BAD vaultSync's views do not go through the throttle wait: a NEAR provider's 429 stops the restore at once";
const NO_CONFIG = "BAD the restore's config read does not go through the throttle wait: a 429 there stalls the restore";

test("recorded good answer: the vault's views and its config read wait out a throttle on the one rule: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer (base f5a25bd23): FAIL, each mark named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_WAIT, NO_KINDS, NO_SYNC, NO_CONFIG]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, rule: false }).lines, [NO_RULE]);
  assert.deepEqual(judge({ ...g, wait: false }).lines, [NO_WAIT]);
  assert.deepEqual(judge({ ...g, kinds: false }).lines, [NO_KINDS]);
  assert.deepEqual(judge({ ...g, wired: { ...g.wired, sync: false } }).lines, [NO_SYNC]);
  assert.deepEqual(judge({ ...g, wired: { ...g.wired, config: false } }).lines, [NO_CONFIG]);
  assert.equal(judge(null).ok, false);
});

// the bundle's pieces as this card's build minified them (its public/app.js), each one broken in turn
const BOUNDS = "var NC=Object.freeze({firstMs:1e3,maxMs:1e4,afterMaxMs:1e4});";
const RULE = "function PC(e,t,n=NC){let r=Number.isFinite(e)&&e>0?Math.min(e*2,n.maxMs):n.firstMs,i=typeof t==`number`&&Number.isFinite(t)&&t>0?Math.min(t,n.afterMaxMs):0;return Math.max(r,i)}";
const STATE = "var $ae=3e4,FC=()=>({pause:0,since:null}),IC=class extends Error{constructor(e){super(e),this.name=`VaultThrottled`}},LC=e=>typeof e==`object`&&!!e&&!Array.isArray(e);";
const T429 = "function eoe(e){if(!(e instanceof Error))return null;let t=e.status;if(t!==429&&(t!==void 0||e.message!==`HTTP 429`))return null;let n=e.retryAfterMs;return{words:`HTTP 429`,afterMs:typeof n==`number`?n:null}}var toe=new Set([15,-429,429]);";
const CODES = "function noe(e){return!LC(e)||!LC(e.error)||!toe.has(e.error.code)?null:{words:`a rate limit (code ${String(e.error.code)})`,afterMs:null}}";
const WAIT = "async function RC(e,t,n,r,i){for(;;){let a;try{let t=await e();if(a=noe(t),a===null)return r.since=null,t}catch(e){if(i?.aborted)throw i.reason;if(a=eoe(e),a===null)throw e}let o=Date.now();r.since??=o;let s=PC(r.pause,a.afterMs);if(o-r.since+s>3e4)throw new IC(`${t}: ${a.words} (${n}), still throttling after ${Math.round((o-r.since)/1e3)} s of waits (at most ${$ae/1e3} s)`);r.pause=s,await roe(s,i)}}";
const SYNC = "try{i=await RC(()=>JC(e.query(t,r),r),e.name,String(t.method_name),n,r)}catch(t){throw r?.aborted?r.reason:t instanceof IC?new HC(`rpc`,t.message):new HC(`rpc`,`${e.name}: ${t}`)}";
const CONFIG = "let t=await RC(()=>e.query(o,a),e.name,`config`,FC(),a),n=t?.error===void 0?t?.result:void 0;";
const JS = ";" + [BOUNDS, RULE, STATE, T429, CODES, WAIT, SYNC, CONFIG].join("");

test("facts over the bundle's pieces: every mark read; each piece broken loses its own mark", () => {
  const f = facts("", JS);
  assert.deepEqual({ rule: f.rule, wait: f.wait, kinds: f.kinds, wired: f.wired }, { rule: true, wait: true, kinds: true, wired: { sync: true, config: true } });
  const broken = (from, to) => facts("", JS.replace(from, to));
  // the rule's bounds or its doubling changed
  assert.equal(broken("maxMs:1e4,", "maxMs:6e4,").rule, false);
  assert.equal(broken("Math.min(e*2,", "Math.min(e*3,").rule, false);
  // the wait: a bound past 30 s, no wait between asks, an answer that never ends the stretch, another rule
  assert.equal(broken("+s>3e4)", "+s>6e4)").wait, false);
  assert.equal(broken(",await roe(s,i)}}", "}}").wait, false);
  assert.equal(broken("return r.since=null,t", "return t").wait, false);
  assert.equal(broken("let s=PC(r.pause", "let s=QC(r.pause").wait, false);
  // the kinds: any status waited, or a code past the three
  assert.equal(broken("if(t!==429&&", "if(t<400&&").kinds, false);
  assert.equal(broken("new Set([15,-429,429])", "new Set([15,-429,429,-32e3])").kinds, false);
  // the Retry-After dropped
  assert.equal(broken("afterMs:typeof n==`number`?n:null}", "afterMs:null}").kinds, false);
  // vaultSync's views asked without the wait, or a VaultThrottled not a stop with its reason
  assert.equal(broken("i=await RC(()=>JC(e.query(t,r),r)", "i=await JC(e.query(t,r),r").wired.sync, false);
  assert.equal(broken("t instanceof IC?new HC(`rpc`,t.message)", "t instanceof Error?new HC(`rpc`,t.message)").wired.sync, false);
  // the config read without the wait, or one state for both providers
  assert.equal(broken("await RC(()=>e.query(o,a),e.name,`config`,FC(),a)", "await e.query(o,a)").wired.config, false);
  assert.equal(broken("`config`,FC(),a)", "`config`,S,a)").wired.config, false);
});
