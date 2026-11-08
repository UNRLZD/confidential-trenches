// node --test scripts/live-checks/sol-w-sweep.test.mjs: the live check replays its recorded answers
// (sol-w-sweep.answers.json). good: this card's build, a full sell depositing W's surplus, keeping what the sweep needs
// at a page boundary and each owed claim's cost (rent(0) when its note would land under the floor), checked exactly by
// the sell's rule, and a sweep that leaves W only an owed claim's cost: PASS. bad: 11c963f9's build (the sell left W's surplus on W, the sweep stopped at
// any kept account): FAIL, every mark named. Planted on the good one: another /app.js, no pin, each mark taken away:
// each FAIL; and planted bundles with a mark's line changed: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MARKS } from "./sol-w-sweep.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./sol-w-sweep.answers.json", import.meta.url), "utf8"));
const ALL = Object.keys(MARKS).map((k) => `BAD the served bundle has no ${k}`);

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer (11c963f9's build): FAIL, every mark named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

// Delta review 7 of 08290868: that build swept W to 0 after an airdrop's full sell with W's own coin held: FAIL on the
// seen rule (the buy record read into the pass) and the own-coin rule alone
test("recorded answer beforeFold (08290868's build): FAIL on the seen and own-coin rules alone", () => {
  const v = judge(ANSWERS.beforeFold);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [ALL[11], ALL[26]]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [i, k] of Object.keys(MARKS).entries()) assert.deepEqual(judge({ ...g, carries: { ...g.carries, [k]: false } }).lines, [ALL[i]]);
  assert.equal(judge(null).ok, false);
});

// The minified lines as the good build spells them, each changed so its rule no longer holds.
const JS = [
  "function BR(e){if(!e.keeps&&e.base!==void 0){let t=BR({...e,base:void 0});return`refused`in t||t.value<(e.floor??0n)?BR({...e,after:e.base,swept:0n,base:void 0}):t}let t=e.fee+e.made+e.rents+e.after-e.lamports,n=t>0n||!e.keeps?t:0n;return e.keeps&&n>iE?{refused:`not_funded`}:n-(e.swept??0n)>iE||n>=e.minOut||e.minOut-n<1000000n?{refused:`quote_check_failed`}:{reserve:n,value:e.minOut-n}}",
  "function GE(e,t=0){let n=HE(e)>1000000n?HE(e):FE,r=ay(e,88),i=n+(sd+ay(e,IE)+2n*r)+sd-ay(e,165)+WE(e,t),a=ay(e,0);return i>a?i:a}",
  "ie=k.kind===`pumpswap`?gf:Qu,[ae,oe]=await Promise.all([UR(g,p,v,F,c),Promise.all([Qu,gf].map(async e=>k.cashback&&e===ie?!0:(await wR(g,t=>TR(t,Sf(f.address,e),`confirmed`))).some(t=>!(`none`in t)&&t.owner===e&&Mf(e,t.data)>0n))).then(e=>e.filter(Boolean).length)]),se=I?vy(k,_):GE(_,oe),ce=HE(_)>1000000n?HE(_):FE,",
  "let a=ay(_,0),o=BR({fee:r,made:M,rents:UE(_,v,ae,e),after:se,lamports:b,minOut:ee,keeps:I,...I?{}:{swept:se-a,base:a,floor:ce}});",
  "var sd=5000n,ad=1000000n,nE=sd+BigInt(14e5)*ad/1000000n,rE=6960n,iE=nE+145n*rE+2n*216n*rE;",
  "let _=wE(g.data,16);if(_<u)return X(`min_out`);let v=ly(r,n.wallet,t.amount,_);if(typeof s!=`bigint`||s>=_)return X(`reserve`);let y=0n,b=c;if(b!==void 0&&b.full===!0){if(typeof b.lamports!=`bigint`||typeof b.fee!=`bigint`||typeof b.made!=`bigint`||b.fee<0n||b.made<0n||typeof b.next!=`boolean`||typeof b.rent?.lamportsPerByte!=`bigint`||typeof b.rent.factor!=`bigint`||b.rent.lamportsPerByte<0n||b.rent.factor<0n||b.rent.lamportsPerByte*b.rent.factor>6960n||!Number.isSafeInteger(b.owed)||b.owed<0||b.owed>2)return X(`reserve`);let e=b.fee+b.made+UE(b.rent,o,b.held,b.next)-b.lamports,t=GE(b.rent,b.owed),n=ay(b.rent,0),r=HE(b.rent)>1000000n?HE(b.rent):FE,i=e+t,a=i-(t-n)<=iE&&i<_&&_-i>=r;if(s!==(a?i:e+n))return X(`reserve`);a&&(y=t-n)}else if(s<0n)return X(`reserve`);if(s-y>iE||_-s<1000000n)return X(`reserve`);let x=OE(m,l,n.wallet,n.precommitment,o,!0);return x===_-s?",
  "var UE=(e,t)=>t===0?0n:iy(e,0)+BigInt(t)*(sd+iy(e,165));",
  "return typeof r!=`bigint`||!Number.isSafeInteger(o)||o<0||o>2?X(`sweep_reads`):l+5000n+HE(i,n,a)+UE(i,o)===r?l:X(`sweep_amount`)}",
  "function qR(e){return e.length>2||e.some(e=>e.cashback!==!0)?null:e.length}",
  "if(T<x)return{end:i>0?`owed`:`floor`,detail:``};",
  "async function JR(e,t,n){let r=[];}",
  "async function XR(e){let t=[e.w.address,...jf(e.w.address,e.mints)],[n,r]=(await TR(e.rpcs,e=>DR(e,t))).map(e=>e.map(e=>e===null?`-`:`${e.owner}:${e.lamports}:${L.encode(e.data)}`).join(`|`));if(n!==r)return;let i=e.buy===null?`#${[...e.w.holdings.tokens].filter(([,e])=>e.amount>0n).map(([e])=>e).sort().join(`,`)}`:``;return L.encode(pt(new TextEncoder().encode(`${n}${i}#${e.rent.lamportsPerByte}:${e.rent.factor}#1`)))}async function ZR(e,t,n,r){let i=await Promise.resolve(e.bought?.get(t.w.address)).catch(()=>void 0),a=i?{...t,mints:iz(t.mints,[i]),buy:i}:{...t,buy:null},o=await XR(a).catch(()=>void 0);if(o!==void 0&&o===n.seen)return;let s=await JR(e,a,r);await QR(e,n,s.end,s.steady?o:void 0)}async function QR(e,t,n,r){try{if(n===`nothing`)return await e.owed?.drop(t.address);let i=(await e.owed?.list())?.find(e=>e.address===t.address)??t,{seen:a,...o}=i;await e.owed?.put({...o,mints:iz(i.mints,t.mints),passes:i.passes+1,...r!==void 0&&(n===`floor`||n===`holds`||n===`kept`||n===`refused`)?{seen:r}:{}})}catch{}}async function $R(e,t=globalThis.navigator?.locks??null){if(!t||!e.owed)return;let n=await e.owed.list();if(n.length===0)return;let r=e.pin.program,{pool:i,scope:a}=oC(r),o=e.rpcs,s=e.wait??(e=>new Promise(t=>setTimeout(t,e))),c;try{c={store:await e.notes(),sync:xC(o,r),rent:await oy(o),wallets:await e.wallets()}}catch(r){for(let{address:i}of n)if(!await rz(t,i,!0,s,async()=>{let t=(await e.owed.list()).find(e=>e.address===i);t&&(e.told?.({address:i,step:`rent_back`,state:`gave_up`,detail:`this load's reads: ${GR(r)}`}),await QR(e,t,`gave_up`))}))return;return}let{store:l,sync:u,rent:d,wallets:f}=c;for(let{address:c}of n)if(!await rz(t,c,!0,s,async t=>{let n=(await e.owed.list()).find(e=>e.address===c),p=n&&f.find(e=>e.chain===`sol`&&e.address===n.address&&e.l.toString()===n.l&&e.j===n.j);n&&p&&await ZR(e,{rpcs:o,program:r,pool:i,scope:a,rent:d,store:l,sync:u,w:p,mints:n.mints,wait:s},n,t)}))return}var ez=Error(`a sell took the sell lock`),tz=1n<<62n;function nz(e,t,n){return new Promise((r,i)=>{e.request(t,n?{mode:`exclusive`,ifAvailable:!0}:{mode:`exclusive`},e=>e?new Promise(e=>r(e)):void r(null)).catch(i)})}async function rz(e,t,n,r,i){if(!e)return await i(),!0;let a=await nz(e,fR(t),n);if(!a)return!0;try{let t=await nz(e,uR,n);if(!t)return!1;let a={release:()=>{t?.(),t=null},nap:async n=>(a.release(),await r(n),t=await nz(e,uR,!0),t!==null)};try{await i(a)}finally{a.release()}return!0}finally{a()}}function iz(e,t){let n=[...e??[]];for(let e of t)n.some(t=>t.mint===e.mint)||n.push(e);return n}function az(e,t){return e===null||t===null?e===t:e.owner===t.owner&&e.lamports===t.lamports&&e.data.length===t.data.length&&e.data.every((e,n)=>e===t.data[n])}",
  ";lR=1e3,uR=`ct-pool/sell`,dR=120*lR,fR=e=>`ct-pool/back/${e}`,pR=22;",
  ";u=async e=>{if(!n)return t.wait(e);if(!await n.nap(e))throw ez};",
  "if(n.plan.close.length>0)return{end:`gave_up`,detail:`still open after the teardown: ${n.plan.close.map(e=>e.address).join(`, `)}`};let[d,f]=n.held.map(e=>e[0]?.lamports??0n);if(d!==f)throw Error(`W's lamports differ on the two RPCs`);let p=d;if(p===0n)return{end:r>0?`owed`:`nothing`,",
  "{k:`plan`,held:n,accounts:i,plan:Nf(c.address,i,e)}}catch(e){if(n[0].every((e,t)=>az(e,n[1][t]??null)))return{k:`refused`,why:GR(e)};throw e}",
  ";var RR=e=>{let t=`owed/rentback-sol`;return{list:async()=>Object.values(await(await e()).get(`meta`,t)??{}),put:async n=>void await(await e()).update(`meta`,t,e=>{let t={...e??{}};return delete t[n.address],t[n.address]=n,t})};",
  "r.keep.push({address:e,why:o.join(`, `),...i.other.length===0&&i.amount>0n?{cashback:!0}:{}})",
  "let r=e=>e!==null&&e.owner===`11111111111111111111111111111111`&&e.data.length===0?null:e,i=Object.fromEntries(Object.entries(t).map(([e,[t,n]])=>[e,[r(t),r(n)]])),a={close:[]",
  ";let[e,n]=t[c.to].map(e=>e?.lamports??0n);if(e!==n)throw Error(`the providers disagree on ${c.to}: ${e}/${n} lamports`);i=e}a.claim.push({program:r.program,uva:e,mint:c.mint,from:c.from,to:c.to,amount:r.amount,open:d===null,unwrap:r.program===gf,fromAmount:u,toAmount:n,prefund:i})",
  ";t.claims.reduce((e,t)=>e+(t.unwrap?t.amount+t.prefund:0n),0n)",
  ";e.open&&(typeof r!=`bigint`||r<e.prefund||r-e.prefund>kf?y.push(`${o}: ${e.to} opened with ${r??`nothing read`} lamports (want ${e.prefund} there before and at most ${kf} more)`):c+=r-e.prefund)",
  ";g=(e,t,n=e===`holds`||e===`kept`||e===`refused`)=>(h(`rent_back`,e,t),{end:e,steady:n})",
  ";T=p-my-UE(l,h,w)-WE(l,a),E=p-my-UE(l,h,{...w,state:[tz,tz],label:[tz,tz]})-WE(l,a);if(T<b)return{end:a>0?`owed`:`floor`,steady:E<b,",
  ";if(S.end!==`sent`)return`steady`in S?g(S.end,S.detail,S.end===`floor`&&S.steady):g(S.end,S.detail);",
  ";I||(be.mints=iz((await Promise.resolve(e.owed?.list()).then(e=>e?.find(e=>e.address===f.address),()=>void 0))?.mints,be.mints),await e.owed?.put(be)",
  ";if(n.k===`refused`)return{end:`refused`,detail:n.why};let a=YR(n.plan.keep)",
  ";for(let n=0;n<30&&(n===0||f()<p);n++){n>0&&await u(lR);try{return{ok:await",
  ";e++){e>0&&await u(lR);for(let e of[...h]){let t=await TR(s,t=>zP(t,e.signature,e.wire))",
  ";try{let n=new Set(t.mints.map(e=>e.mint));if(t.buy===null&&[...c.holdings.tokens].some(([e,t])=>!n.has(e)&&t.amount>0n))return g(`holds`,`W holds a token and no buy of W's is recorded`);",
  ";return await e.bought?.put(P.address,{mint:C.mint,program:C.tokenProgram}),await QP(e,D,O,l,te,w.lastHeight,o,{token:c,minOut:T,tell:s,bound:F})}",
].join("");
test("the facts read from a bundle; a planted line with its rule changed FAILs", () => {
  assert.deepEqual(Object.values(facts("", JS).carries), Object.keys(MARKS).map(() => true));
  const planted = [
    [JS.replace("n=t>0n||!e.keeps?t:0n", "n=t>0n?t:0n"), 0],
    [JS.replace("+2n*r)", "+r)"), 1],
    [JS.replace("+WE(e,t)", ""), 1],
    [JS.replace("k.cashback&&e===ie?!0:", ""), 2],
    [JS.replace(".some(t=>!(`none`in t)", ".every(t=>!(`none`in t)"), 2],
    [JS.replace("||t.value<(e.floor??0n)", ""), 3],
    [JS.replace(",floor:ce}", "}"), 4],
    [JS.replace("floor:ce}", "floor:FE}"), 4],
    [JS.replace("ce=HE(_)>1000000n?HE(_):FE,", "ce=FE,"), 4],
    [JS.replace("ce=HE(_)>1000000n?HE(_):FE,", "ce=HE(g)>1000000n?HE(g):FE,"), 4],
    [JS.replace("n-(e.swept??0n)>iE", "n>iE"), 5],
    [JS.replace("b.full===!0", "b.full!==!1"), 6],
    [JS.replace("||b.rent.lamportsPerByte*b.rent.factor>6960n", ""), 6],
    [JS.replace("&&_-i>=r;", ";"), 6],
    [JS.replace("s!==(a?i:e+n)", "s!==i&&s!==e+n"), 6],
    [JS.replace("i<_&&_-i>=r", "i<u&&u-i>=r"), 6],
    [JS.replace("||_-s<1000000n)", ")"), 6],
    [JS.replace("_-s<1000000n", "u-s<1000000n"), 6],
    [JS.replace("<=iE&&", "<=nE&&"), 6],
    [JS.replace("iE=nE+145n*rE+2n*216n*rE", "iE=nE+145n*rE+2n*217n*rE"), 6],
    [JS.replace("rE=6960n", "rE=6961n"), 6],
    [JS.replace("if(s-y>iE||", "if(s>iE||"), 6],
    [JS.replace("iy(e,0)+BigInt(t)*", "BigInt(t)*"), 7],
    [JS.replace("+UE(i,o)===r", "===r"), 8],
    [JS.replace("||o>2?", "?"), 8],
    [JS.replace("e.some(e=>e.cashback!==!0)", "!1"), 9],
    // the floor end's steadiness mark holds the same owed-or-floor end, so both go
    [JS.replaceAll(/\{end:[ai]>0\?`owed`:`floor`,/g, "{end:`floor`,"), [10, 22]],
    [JS.replace("nE=sd+BigInt(14e5)*ad/1000000n", "nE=sd"), 6],
    [JS.replace("ad=1000000n", "ad=2000000n"), 6],
    [JS.replace("sd=5000n", "sd=0n"), 6],
    [JS.replace("if(o!==void 0&&o===n.seen)return;", ""), 11],
    [JS.replace("if(n!==r)return;", ""), 11],
    // delta review 7 of 08290868: with no buy record, the page's holdings are part of what W read as; the buy record is
    // read into the pass's mints
    [JS.replace("e.buy===null?`#", "!1?`#"), 11],
    [JS.replace("a=i?{...t,mints:iz(t.mints,[i]),buy:i}:{...t,buy:null}", "a={...t,buy:null}"), 11],
    // W's own coin holds the pass: the fallback with no record, and the buy's record written before its send
    [JS.replace("if(t.buy===null&&[...c.holdings.tokens]", "if([...c.holdings.tokens]"), 26],
    [JS.replace("return await e.bought?.put(P.address,{mint:C.mint,program:C.tokenProgram}),await QP(", "return await QP("), 26],
    [JS.replace("#${e.rent.lamportsPerByte}:${e.rent.factor}#1", "#1"), 11],
    [JS.replace("let t=[e.w.address,...jf(e.w.address,e.mints)],[n,r]", "let t=[e.w.address],[n,r]"), 11],
    [JS.replace("if(n===`nothing`)return await e.owed?.drop(t.address)", "if(n!==`floor`)return await e.owed?.drop(t.address)"), 12],
    [JS.replace(",...r!==void 0&&(n===`floor`||n===`holds`||n===`kept`||n===`refused`)?{seen:r}:{}", ""), 12],
    [JS.replace("||n===`refused`)?{seen:r}", "||n===`refused`||n===`gave_up`)?{seen:r}"), 12],
    [JS.replace("let i=(await e.owed?.list())?.find(e=>e.address===t.address)??t,", "let i=t,"), 12],
    [JS.replace("if(d!==f)throw Error(`W's lamports differ on the two RPCs`);", ""), 13],
    [JS.replace("if(p===0n)return{end:r>0?`owed`:`nothing`", "if(p<5000000n)return{end:r>0?`owed`:`nothing`"), 13],
    [JS.replace("await QR(e,t,`gave_up`))}))return;return}", "await e.owed?.drop(t.address))}))return;return}"), 14],
    [JS.replace("let n=(await e.owed.list()).find(e=>e.address===c)", "let n=[].find(e=>e.address===c)"), 14],
    [JS.replace("mints:n.mints,wait:s},n,t)}))return}", "mints:n.mints,wait:s},n,t),await e.owed.drop(c)}))return}"), 14],
    [JS.replace("if(!await rz(t,c,!0,s,", "if(!await rz(t,c,!1,s,"), 14],
    [JS.replace("nap:async n=>(a.release(),await r(n),t=await nz(e,uR,!0),t!==null)", "nap:async n=>(await r(n),!0)"), 15],
    // the sleep's wrapper is what both the lock's and the sleeps' marks hold
    [JS.replace("if(!await n.nap(e))throw ez", "await n.nap(e)"), [15, 25]],
    [JS.replace("let a=await nz(e,fR(t),n);if(!a)return!0;", "let a=()=>{};"), 15],
    [JS.replace("uR=`ct-pool/sell`", "uR=`ct-pool/sel`"), 15],
    [JS.replace("if(n[0].every((e,t)=>az(e,n[1][t]??null)))return{k:`refused`", "if(!0)return{k:`refused`"), 16],
    [JS.replace("e.lamports===t.lamports&&e.data.length", "e.data.length"), 16],
    [JS.replace("return delete t[n.address],t[n.address]=n,t", "return t[n.address]=n,t"), 17],
    [JS.replace("i.other.length===0&&", ""), 18],
    [JS.replace("[e,[r(t),r(n)]]", "[e,[r(t),n]]"), 19],
    [JS.replace("e.data.length===0?null:e", "e.data.length===0?e:e"), 19],
    [JS.replace("if(e!==n)throw Error(`the providers disagree on ${c.to}: ${e}/${n} lamports`);", ""), 20],
    [JS.replace("prefund:i})", "prefund:0n})"), 20],
    [JS.replace("t.unwrap?t.amount+t.prefund:0n", "t.unwrap?t.amount:0n"), 20],
    [JS.replace(":c+=r-e.prefund)", ":c+=r)"), 20],
    [JS.replace("r<e.prefund||", ""), 20],
    [JS.replace("||e===`refused`)=>(h(", ")=>(h("), 21],
    [JS.replace("steady:E<b,", "steady:T<b,"), 22],
    [JS.replace("S.end===`floor`&&S.steady", "S.end===`floor`"), 22],
    [JS.replace("I||(be.mints=iz((await Promise.resolve(e.owed?.list()).then(e=>e?.find(e=>e.address===f.address),()=>void 0))?.mints,be.mints),await e.owed?.put(be)", "I||(await e.owed?.put(be)"), 23],
    [JS.replace("return{end:`refused`,detail:n.why};let a=YR", "return{end:`gave_up`,detail:n.why};let a=YR"), 24],
    [JS.replace("for(let n=0;n<30&&(n===0||f()<p);n++){n>0&&await u(lR);", "for(let n=0;n<30&&(n===0||f()<p);n++){n>0&&await t.wait(lR);"), 25],
    [JS.replace("e++){e>0&&await u(lR);for", "e++){e>0&&await t.wait(lR);for"), 25],
  ];
  for (const [js, i] of planted) {
    assert.notEqual(js, JS, "each plant changes the line");
    const c = facts("", js).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [i].flat().map((n) => Object.keys(MARKS)[n]), js.slice(0, 80));
  }
});
