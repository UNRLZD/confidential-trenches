// node --test scripts/live-checks/closed-positions-show-every-trade.test.mjs: the live check's verdict replays recorded
// answers (closed-positions-show-every-trade.answers.json), each read on 2026-11-13 by the check's collect():
//   good: this card's build of the signing page (build-app.mjs), read through scripts/ci/bundle-checks.mjs buildFetch:
//         the script is the one its page pins and holds each mark: PASS;
//   bad:  SIGN_HOST as deployed before this card, read over https: the script pinned, no mark: FAIL.
// Planted from the good answer: a script that lost one mark (each in turn), a script the host did not answer, a script
// that is not the one its page pins or has no pin, no host at all. And the marks on the build's own minified shapes,
// with the near misses they must refuse.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, marksIn, NAMES } from "./closed-positions-show-every-trade.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "closed-positions-show-every-trade.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the build holds every mark: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(new Set(ANSWERS.good.sign.js.flatMap((f) => f.found)), new Set(NAMES.sign));
});

test("recorded bad answer: SIGN_HOST before this card holds none of them: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).includes(`BAD sign: the scripts lack: ${NAMES.sign.join("; ")}`), r.lines.join("\n"));
});

test("planted: a script without any one mark fails, naming it", () => {
  for (const n of NAMES.sign) {
    const r = mut((rec) => {
      for (const f of rec.sign.js) f.found = f.found.filter((m) => m !== n);
    });
    assert.equal(r.ok, false, n);
    assert.ok(bad(r.lines).includes(`BAD sign: the scripts lack: ${n}`), r.lines.join("\n"));
  }
});

test("planted: a script the host did not answer, a page naming none, no host read", () => {
  const miss = mut((rec) => void (rec.sign.js[0].status = 404));
  assert.equal(miss.ok, false);
  assert.ok(bad(miss.lines).some((l) => /^BAD sign: 1 script\(s\) named by the page, each answering 200$/.test(l)), miss.lines.join("\n"));
  assert.equal(mut((rec) => void (rec.sign.js = [])).ok, false);
  assert.equal(judge({ at: "x" }).ok, false);
});

test("planted: a script that is not the one its page pins, or has no pin, fails whatever marks it holds", () => {
  for (const pin of ["sha384-other", null]) {
    const r = mut((rec) => void (rec.sign.js[0].integrity = pin));
    assert.equal(r.ok, false, String(pin));
    assert.deepEqual(bad(r.lines), [`BAD sign: not the script its page pins: ${ANSWERS.good.sign.js[0].url}`], r.lines.join("\n"));
  }
  assert.equal(ANSWERS.bad.sign.js[0].integrity, ANSWERS.bad.sign.js[0].sha384, "the deployed host pins its own script");
});

test("the marks on the build's minified shapes, any quote; a near miss is no mark", () => {
  const sign = [
    "return l(m!==null&&Date.now()-m*1e3>6e5?`none`:null)",
    "Gie=(e,t)=>s5(e)[t]===2,",
    "r3=(e,t)=>`trade/${e}/${m3(t)}`",
    "...i===null||a===null?{}:{units:mF(i,a)},pool_amount:mF(o,18),...l===null?{}:{amount_usd:l}",
    "await e.traded?.(i3(`buy`,e.chain,n.release.tx,t.holding.mint",
    "await e.traded?.(i3(`sell`,e.chain,n.deposit.tx,t.open.token",
    "done:async()=>new Set([...await Yie(await e.store()),...Ct])",
    "logIndex:h.logIndex,tx:DL(h),fee:OL(h,2),out:h.kind===`buy`?OL(h,6):null}",
    "await i(o3(`sell`,e.chain,r.tx,t.token,null,null,r.value,null,await n(r.block)))",
    "await D7(yie({chain:n.chain,read:r,store:await(e.held?e.held():e.store()),spends:n.spends,returns:n.returns,signal:t}).catch(()=>0),t)",
  ].join(";");
  assert.deepEqual(marksIn("sign", sign), NAMES.sign);
  const dq = [
    'return l(m!==null&&Date.now()-m*1e3>6e5?"none":null)',
    "Gie=(e,t)=>s5(e)[t]===2;",
    'r3=(e,t)=>"trade/"+e+"/"+m3(t)',
    "...i===null||a===null?{}:{units:mF(i,a)},pool_amount:mF(o,18),...l===null?{}:{amount_usd:l}",
    'await e.traded?.(i3("buy",e.chain,n.release.tx,t.holding.mint',
    'await e.traded?.(i3("sell",e.chain,n.deposit.tx,t.open.token',
    "done:async()=>new Set([...await Yie(await e.store()),...Ct])",
    'logIndex:h.logIndex,tx:DL(h),fee:OL(h,2),out:h.kind==="buy"?OL(h,6):null}',
    'await i(o3("sell",e.chain,r.tx,t.token,null,null,r.value,null,await n(r.block)))',
    "await D7(yie({chain:n.chain,read:r,store:await(e.held?e.held():e.store()),spends:n.spends,returns:n.returns,signal:t}).catch(()=>0),t)",
  ].join(";");
  assert.deepEqual(marksIn("sign", dq), NAMES.sign);
  // the old read (a plain release none at once), a mark of any value, an op keyed by chain alone, the ETH at 9 decimals, a buy's op from the pending record, a sale's from its hint;
  const near = [
    "if(Zt(r,t,n))return l(Qt(r,t,n)?`none`:null)",
    "Gie=(e,t)=>Object.hasOwn(s5(e),t)",
    "r3=e=>`trade/${e}`",
    "{units:mF(i,a)},pool_amount:mF(o,9),...l===null?{}:{amount_usd:l}",
    "await e.traded?.(i3(`buy`,e.chain,n.pending.tx,",
    "await e.traded?.(i3(`sell`,e.chain,n.hint.tx,",
    // the old skip list (this device's own buy records too, no running buys), the fee's word read as _value, a sale's op
    // with the buy's amount as its ETH, the restore run with the spends alone
    "done:async()=>Yie(await e.store(),Ct)",
    "tx:DL(h),fee:OL(h,1),out:h.kind===`buy`?OL(h,6):null",
    "await i(o3(`sell`,e.chain,r.tx,t.token,null,null,t.withdrawn,null,",
    "yie({chain:n.chain,read:r,store:await(e.held?e.held():e.store()),spends:n.spends,signal:t})",
  ].join(";");
  assert.deepEqual(marksIn("sign", near), []);
});
