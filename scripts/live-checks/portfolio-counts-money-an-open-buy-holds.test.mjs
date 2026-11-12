// node --test scripts/live-checks/portfolio-counts-money-an-open-buy-holds.test.mjs: the live check's verdict replays
// recorded answers (portfolio-counts-money-an-open-buy-holds.answers.json, its _note says where each was read), each from
// portfolio-counts-money-an-open-buy-holds.mjs collect():
//   good: this card's two builds (the signing page's build-app.mjs --out and the terminal's vite build), each script the
//         one its page pins and holding each of its host's marks: PASS;
//   bad:  SIGN_HOST and APP_HOST as served before the card's deploy: each script pinned, neither holds one mark: FAIL,
//         every mark named.
// Planted from the good answer: a script that lost one mark (each in turn, on its host), a script the host did not
// answer, a script that is not the one its page pins or has no pin, a host read alone (its own deploy's run), no host at
// all. And the marks on the builds' own minified shapes, each with the old shape it must refuse.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, marksIn, NAMES, scriptsOf, sha384 } from "./portfolio-counts-money-an-open-buy-holds.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "portfolio-counts-money-an-open-buy-holds.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: both builds hold every mark: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const h of ["sign", "app"]) assert.deepEqual(new Set(ANSWERS.good[h].js.flatMap((f) => f.found)), new Set(NAMES[h]), h);
});

test("recorded bad answer: the hosts before the card hold none of them: FAIL, every mark named", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const h of ["sign", "app"]) assert.ok(bad(r.lines).includes(`BAD ${h}: the scripts lack: ${NAMES[h].join("; ")}`), r.lines.join("\n"));
  assert.equal(bad(r.lines).length, 2, r.lines.join("\n"));
});

test("planted: a script without any one mark fails, naming it and its host", () => {
  for (const h of ["sign", "app"])
    for (const n of NAMES[h]) {
      const r = mut((rec) => {
        for (const f of rec[h].js) f.found = f.found.filter((m) => m !== n);
      });
      assert.equal(r.ok, false, n);
      assert.deepEqual(bad(r.lines), [`BAD ${h}: the scripts lack: ${n}`], r.lines.join("\n"));
    }
});

test("planted: a script the host did not answer, a page naming none, no host read; one host alone is its own run", () => {
  const miss = mut((rec) => void (rec.app.js[0].status = 404));
  assert.equal(miss.ok, false);
  assert.ok(bad(miss.lines).some((l) => /^BAD app: 1 script\(s\) named by the page, each answering 200$/.test(l)), miss.lines.join("\n"));
  assert.equal(mut((rec) => void (rec.sign.js = [])).ok, false);
  assert.equal(mut((rec) => void (rec.app.pageStatus = 500)).ok, false);
  assert.equal(judge({ at: "x" }).ok, false);
  assert.equal(judge({ sign: ANSWERS.good.sign }).ok, true);
  assert.equal(judge({ app: ANSWERS.good.app }).ok, true);
  assert.equal(judge({ sign: ANSWERS.bad.sign }).ok, false);
  assert.equal(judge({ app: ANSWERS.bad.app }).ok, false);
});

test("planted: a script that is not the one its page pins, or has no pin, fails on its host, whatever marks it holds", () => {
  for (const h of ["sign", "app"]) {
    for (const pin of ["sha384-other", null]) {
      const r = mut((rec) => void (rec[h].js[0].integrity = pin));
      assert.equal(r.ok, false, `${h} ${pin}`);
      assert.deepEqual(bad(r.lines), [`BAD ${h}: not the script its page pins: ${ANSWERS.good[h].js[0].url}`], r.lines.join("\n"));
    }
    assert.equal(ANSWERS.good[h].js[0].integrity, ANSWERS.good[h].js[0].sha384, h);
    assert.equal(ANSWERS.bad[h].js[0].integrity, ANSWERS.bad[h].js[0].sha384, `${h}: the deployed host pins its own script`);
  }
});

test("the marks on the builds' minified shapes, any quote; each old shape is no mark", () => {
  const [read, carry] = NAMES.sign;
  const [sum, bought, value, axis] = NAMES.app;
  const signNew = [
    // the batched read (review P3-2): every W's accounts flattened into one call
    "let n=t.flatMap(e=>e.keys.map(([e])=>e)),r=(await e(`getMultipleAccounts`,[n,{encoding:`base64`,commitment:`finalized`,dataSlice:{offset:0,length:0}}]))?.value",
    "{chain:`solana`,token:e,amount:t,cost:c,wallets:n.wallets,decimals:r,...a===null?{}:{asset_held:mk(a,SR)}}",
  ].join(";");
  assert.deepEqual(marksIn("sign", signNew), [read, carry]);
  assert.deepEqual(marksIn("sign", signNew.replaceAll("`", '"')), [read, carry]);
  // the finder's own read (no dataSlice), the token read at confirmed, a position with no asset_held, the key written
  // always (a part sum or "0" where a W was not read) are not the marks
  const signOld = [
    // the read per W, one call each (before review P3-2)
    "let a=await r(`getMultipleAccounts`,[i.map(([e])=>e),{encoding:`base64`,commitment:`finalized`,dataSlice:{offset:0,length:0}}])",
    "t[c](`getMultipleAccounts`,[d,{commitment:`finalized`,encoding:`base64`,...f>0?{minContextSlot:f}:{}}])",
    "r(`getMultipleAccounts`,[i.map(([e])=>e),{encoding:`base64`,commitment:`confirmed`,dataSlice:{offset:0,length:0}}])",
    "r(`getMultipleAccounts`,[i.map(([e])=>e),{encoding:`base64`,commitment:`finalized`}])",
    "{chain:`solana`,token:e,amount:t,cost:c,wallets:n.wallets,decimals:r}",
    "{wallets:n.wallets,decimals:r,asset_held:mk(a,SR)}",
  ].join(";");
  assert.deepEqual(marksIn("sign", signOld), []);

  const appNew = [
    "for(let t of e.positions){if(t.asset_held===void 0||t.wallets.some(e=>n.has(`${t.chain}:${e}`)))continue;let a=1}",
    "let r=BigInt(t[2]+(n+`00`).slice(0,2))+(Number(n[2]??`0`)>=5?1n:0n);return r",
    // nearCents: an exact figure to the nearest cent (review of 98d75c8cb: each row figure from the exact one), as this
    // card's vite build writes it (its absolute value inlined)
    "kh=e=>{let t=((e<0n?-e:e)*200n+Dh)/(2n*Dh);return e<0n?-t:t}",
    "for(let e=2;new Set(a).size<n&&e<=8;e++)a=i(e);",
  ].join(";");
  assert.deepEqual(marksIn("app", appNew), [sum, bought, value, axis]);
  assert.deepEqual(marksIn("app", appNew.replaceAll("`", "'")), [sum, bought, value, axis]);
  // the old shapes: positions summed with no asset_held, a cent floored (no half-up step), the product floored by the
  // scale, one label rule at two decimals, a loop that stops at the first alike; none is a mark
  const appOld = [
    "for(let t of e.positions){if(t.wallets.some(e=>n.has(`${t.chain}:${e}`)))continue;let a=1}",
    "let r=BigInt(t[2]+(n+`00`).slice(0,2));return r",
    "return BigInt(n[1]+i)*BigInt(r[1]+a)*100n/o",
    "Ys=e=>e*100n/Fs",
    "for(let e=2;e<=8;e++)a=i(e);",
    "a=i(2),new Set(a).size<n&&a",
    "{}.asset_held,t.wallets.some(",
  ].join(";");
  assert.deepEqual(marksIn("app", appOld), []);
});

test("the page's scripts: each script tag's src and its integrity; sha384 as an integrity attribute names it", () => {
  assert.deepEqual(scriptsOf('<script type="module" src="/app.js" integrity="sha384-x"></script><script>1</script><script src="/b.js"></script>'), [
    { src: "/app.js", integrity: "sha384-x" },
    { src: "/b.js", integrity: null },
  ]);
  assert.match(sha384("x"), /^sha384-[A-Za-z0-9+/]{64}$/);
  assert.notEqual(sha384("x"), sha384("y"));
});
