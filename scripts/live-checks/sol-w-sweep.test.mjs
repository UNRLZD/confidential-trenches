// node --test scripts/live-checks/sol-w-sweep.test.mjs: the live check replays its recorded answers
// (sol-w-sweep.answers.json). good: this card's build, a full sell depositing W's surplus, keeping what the sweep needs
// at a page boundary and each owed claim's cost (rent(0) when its note would land under the floor), checked exactly by
// the sell's rule, and a sweep that leaves W only an owed claim's cost: PASS. bad: 11c963f9's build (the sell left W's surplus on W, the sweep stopped at
// any kept account): FAIL, every mark named. beforeFloor: main 383b1ffe's build, whose sell's rule lets a deposit back
// under the kit's release floor through: FAIL on that rule. Since card round-trip-costs-less the good answer is that card's
// build and each older build also FAILs the rules it moved (MOVED). Planted on the good one: another /app.js, no pin, each mark taken away:
// each FAIL; and planted bundles with a mark's line changed: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MARKS } from "./sol-w-sweep.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./sol-w-sweep.answers.json", import.meta.url), "utf8"));
const ALL = Object.keys(MARKS).map((k) => `BAD the served bundle has no ${k}`);
// The rules card round-trip-costs-less moved, so no build before it carries them: the sell's rule with a sale's closes,
// what W read as (the helper's batched read), the record (listed empty, its proven buy kept), the list a failed load keeps
const MOVED = [6, 11, 12, 14];
const moved = (...more) => [...new Set([...MOVED, ...more])].sort((a, b) => a - b).map((i) => ALL[i]);

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
// seen rule (the buy record read into the pass) and the own-coin rule, with the moved ones and the plan refusal's shape
// as card sol-rent-back-dust-burn wrote it later (16)
test("recorded answer beforeFold (08290868's build): FAIL on the seen and own-coin rules and those moved since", () => {
  const v = judge(ANSWERS.beforeFold);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, moved(11, 16, 25));
});

// Delta review 8 of 5697d7a1: with no buy record, that build swept W on the page's holdings (the helper's word on
// mainnet), and hashed them into what W read as: FAIL on the seen and own-coin rules and those moved since
test("recorded answer beforeFold8 (5697d7a1's build): FAIL on the seen and own-coin rules and those moved since", () => {
  const v = judge(ANSWERS.beforeFold8);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, moved(11, 16, 25));
});

// This card's base: main 383b1ffe's build signs a sell's deposit back under the kit's release floor (its rule refuses
// only one under the pool's least deposit): FAIL on the sell's rule, and on those moved since (with the own-coin rule's
// hold of an unproven W)
test("recorded answer beforeFloor (main 383b1ffe's build): FAIL on the sell's rule and those moved since", () => {
  const v = judge(ANSWERS.beforeFloor);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, moved(6, 25));
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
  "let _=wE(g.data,16);if(_<u)return X(`min_out`);let v=ly(r,n.wallet,t.amount,_);if(typeof s!=`bigint`||s>=_)return X(`reserve`);let y=0n,b=c;if(b!==void 0&&b.full===!0){if(typeof b.lamports!=`bigint`||typeof b.fee!=`bigint`||typeof b.made!=`bigint`||b.fee<0n||b.made<0n||typeof b.next!=`boolean`||typeof b.rent?.lamportsPerByte!=`bigint`||typeof b.rent.factor!=`bigint`||b.rent.lamportsPerByte<0n||b.rent.factor<0n||b.rent.lamportsPerByte*b.rent.factor>6960n||!Number.isSafeInteger(b.owed)||b.owed<0||b.owed>2)return X(`reserve`);let e=b.fee+b.made+UE(b.rent,o,b.held,b.next)-b.lamports,n=ay(b.rent,0);if(b.closes!==void 0&&b.closes.length>0){if(b.owed!==0)return X(`closes`);let r=0n;for(let e of b.closes){if(typeof e.lamports!=`bigint`||e.lamports<0n||e.kind===`token`&&e.mint!==t.token)return X(`closes`);r+=e.lamports}if(s!==e+n-r)return X(`reserve`)}else{let t=GE(b.rent,b.owed),r=HE(b.rent)>1000000n?HE(b.rent):FE,i=e+t,a=i-(t-n)<=iE&&i<_&&_-i>=r;if(s!==(a?i:e+n))return X(`reserve`);a&&(y=t-n)}}else if(s<0n||b?.closes!==void 0&&b.closes.length>0)return X(`reserve`);if(s-y>iE)return X(`reserve`);let w=b?.rent;if(w===void 0||typeof w.lamportsPerByte!=`bigint`||w.lamportsPerByte<1n||w.lamportsPerByte>1000000n||w.factor!==1n&&w.factor!==2n)return X(`reserve`);let k=_-s<Qy(w),x=p.at(-1);if(k&&x.program===l.program)return X(`deposit_floor`);let S=k?p:p.slice(0,-1);if(S.length!==v.length)return X(`sell`);for(let e=0;e<v.length;e++){let t=v[e],n=S[e];if(n.program!==t.program||n.data.length!==t.data.length||n.data.some((e,n)=>e!==t.data[n]))return X(`sell`);if(!jE(n.accounts,t.accounts))return X(`sell_accounts`)}if(k)return uE(e),{chain:`solana`,op:t.kind,token:t.token,amount:t.amount,feeCap:0n,pool:l.pool,to:n.wallet,decimals:t.decimals,back:null};let C=OE(x,l,n.wallet,n.precommitment,o,!0);return C===_-s?",
  "var UE=(e,t)=>t===0?0n:iy(e,0)+BigInt(t)*(sd+iy(e,165));",
  "return typeof r!=`bigint`||!Number.isSafeInteger(o)||o<0||o>2?X(`sweep_reads`):l+5000n+HE(i,n,a)+UE(i,o)===r?l:X(`sweep_amount`)}",
  "function qR(e){return e.length>2||e.some(e=>e.cashback!==!0)?null:e.length}",
  "if(T<x)return{end:i>0?`owed`:`floor`,detail:``};",
  "async function JR(e,t,n){let r=[];}",
  "var Uy=`SysvarRent111111111111111111111111111111111`;async function EG(e,t){let n=await Promise.resolve(e.bought?.get(t)).catch(()=>void 0);return{rec:n,none:n===void 0&&await Promise.resolve(e.buyNone?.(t)).catch(()=>!1)===!0}}var DG=e=>e.rec?`${e.rec.mint}:${e.rec.program}:${e.rec.rebuilt===!0?`rebuilt`:`own`}`:e.none?`none`:`-`,OG=100,kG=1e3;async function AG(e,t){let n=t.map(e=>{try{return[e.address,...tp(e.address,e.mints)]}catch{return[e.address]}}),r=[Uy,...n.flat()],i=[];for(let t=0;t<r.length;t+=OG)i.push(...await SW(e,r.slice(t,t+OG)));let a=e=>e===null?`-`:`${e.owner}:${String(e.lamports)}:${z.encode(e.data)}`,o=a(i[0]??null),s=1;return new Map(t.map((e,t)=>{let r=i.slice(s,s+n[t].length);return s+=n[t].length,[e.address,{any:r.some(e=>e!==null),seen:z.encode(dt(fW.encode(`${r.map(a).join(`|`)}#${o}#1#${DG(e.evidence)}`)))}]}))}async function jG(e,t,n,r){try{let i=await Ij(e,t).read(n);if(r===null)return i===`none`?null:void 0;if(i!==null&&i!==`none`&&i.mint===r.mint&&i.program===r.program)return{mint:i.mint,program:i.program}}catch{}}async function MG(e,t,n,r,i){let a=await EG(e,t.w.address),o=a.rec&&a.rec.rebuilt!==!0?{mint:a.rec.mint,program:a.rec.program}:void 0,s=n.buy;o===void 0&&s===void 0&&(a.rec!==void 0||a.none)&&(s=await jG(t.rpcs[0],t.program,t.w.address,a.rec?{mint:a.rec.mint,program:a.rec.program}:null)),o===void 0&&s&&(o=s);let c=o===void 0&&s===void 0?n.passes+1>=3?`steady`:`again`:void 0,l=await CG(e,o?{...t,mints:HG(t.mints,[o]),buy:o}:{...t,buy:null,...c?{unproven:c}:{}},r);return await PG(e,n,l.end,l.steady?i:void 0,s===void 0?{}:{buy:s}),l.end===`gave_up`||l.end===`sent`||l.end===`owed`||c===`again`}async function NG(e,t,n){let r=await EG(e,t),i=r.rec?HG(n,[{mint:r.rec.mint,program:r.rec.program}]):[...n];return(await AG(e.rpcs[1],[{address:t,mints:i,evidence:r}]).catch(()=>void 0))?.get(t)?.seen}async function PG(e,t,n,r,i={}){try{if(n===`nothing`)return await Promise.resolve(e.owed?.markEmpty?.(t.address)).catch(()=>{}),await e.owed?.drop(t.address);let a=(await e.owed?.list())?.find(e=>e.address===t.address)??t,{seen:o,left:s,...c}=a;await e.owed?.put({...c,mints:HG(a.mints,t.mints),passes:a.passes+1,...r!==void 0&&(n===`floor`||n===`holds`||n===`kept`||n===`refused`)?{seen:r}:{},...i.buy===void 0?{}:{buy:i.buy}})}catch{}}var FG=()=>!1;async function IG(e,t=globalThis.navigator?.locks??null){if(!t||!e.owed)return!1;let n=await e.owed.list(),r=e.pin.program,{pool:i,scope:a}=ww(r),o=e.rpcs,s=e.wait??(e=>new Promise(t=>setTimeout(t,e))),c=null,l=null;try{c=await e.wallets(FG)}catch(e){l=e}let u=await Promise.resolve(e.owed.empty?.()).catch(()=>void 0)??new Set,d=[...new Map((c??[]).filter(e=>e.chain===`sol`&&!u.has(e.address)&&!n.some(t=>t.address===e.address)).map(e=>[e.address,e])).values()];if(n.length===0&&d.length===0)return l!==null;let f=[];for(let{address:t,mints:r}of[...n,...d.map(e=>({address:e.address,mints:[]}))]){let n=await EG(e,t);f.push({address:t,evidence:n,mints:n.rec?HG(r,[{mint:n.rec.mint,program:n.rec.program}]):r})}let p=await AG(o[1],f).catch(()=>null),m=[];for(let{address:t}of f){let r=n.find(e=>e.address===t),i=p?.get(t);r?(i===void 0?r.seen===void 0:r.seen!==i.seen)&&m.push(t):i!==void 0&&(i.any?m.push(t):await Promise.resolve(e.owed.markEmpty?.(t)).catch(()=>{}))}if(m.length===0)return l!==null||p===null;for(let e=m.length-1;e>0;e--){let t=LG(e+1);[m[e],m[t]]=[m[t],m[e]]}let h;try{if(c===null)throw l;h={store:await e.notes(),sync:Uw(o,r),rent:await Jy(o),wallets:c}}catch(n){for(let r of m)if(!await VG(t,r,!0,s,async()=>{let t=(await e.owed.list()).find(e=>e.address===r);t&&(e.told?.({address:r,step:`rent_back`,state:`gave_up`,detail:`this load's reads: ${bG(n)}`}),await PG(e,t,`gave_up`))}))return!0;return!0}let{store:g,sync:_,rent:v}=h,y=p===null,b=e.preempt?.();try{for(let[n,c]of m.entries())if(n>0&&await s(kG+LG(kG)),!await VG(t,c,!0,s,async t=>{let n=d.find(e=>e.address===c),l=(await e.owed.list()).find(e=>e.address===c)??(n?{address:c,l:n.l.toString(),j:n.j,mints:[],passes:0}:void 0),u=l&&h.wallets.find(e=>e.chain===`sol`&&e.address===l.address&&e.l.toString()===l.l&&e.j===l.j);l&&u&&await MG(e,{rpcs:o,program:r,pool:i,scope:a,rent:v,store:g,sync:_,w:u,mints:l.mints,wait:s,...l.sell?{sell:l.sell}:{}},l,t,p?.get(c)?.seen)&&(y=!0)}))return!0}finally{b?.()}return y}function LG(e){if(e<=1)return 0;let t=Math.floor(4294967296/e)*e,n=new Uint32Array(1);for(;;)if(globalThis.crypto.getRandomValues(n),n[0]<t)return n[0]%e}var ez=Error(`a sell took the sell lock`),tz=1n<<62n;function nz(e,t,n){return new Promise((r,i)=>{e.request(t,n?{mode:`exclusive`,ifAvailable:!0}:{mode:`exclusive`},e=>e?new Promise(e=>r(e)):void r(null)).catch(i)})}async function rz(e,t,n,r,i){if(!e)return await i(),!0;let a=await nz(e,fR(t),n);if(!a)return!0;try{let t=await nz(e,uR,n);if(!t)return!1;let a={release:()=>{t?.(),t=null},nap:async n=>(a.release(),await r(n),t=await nz(e,uR,!0),t!==null)};try{await i(a)}finally{a.release()}return!0}finally{a()}}function iz(e,t){let n=[...e??[]];for(let e of t)n.some(t=>t.mint===e.mint)||n.push(e);return n}function az(e,t){return e===null||t===null?e===t:e.owner===t.owner&&e.lamports===t.lamports&&e.data.length===t.data.length&&e.data.every((e,n)=>e===t.data[n])}",
  ";lR=1e3,uR=`ct-pool/sell`,dR=120*lR,fR=e=>`ct-pool/back/${e}`,pR=22;",
  ";u=async e=>{if(!n)return t.wait(e);if(!await n.nap(e))throw ez};",
  "if(n.plan.close.length>0)return{end:`gave_up`,detail:`still open after the teardown: ${n.plan.close.map(e=>e.address).join(`, `)}`};let[d,f]=n.held.map(e=>e[0]?.lamports??0n);if(d!==f)throw Error(`W's lamports differ on the two RPCs`);let p=d;if(p===0n)return{end:r>0?`owed`:`nothing`,",
  "{k:`plan`,held:n,accounts:i,burn:u,plan:Nf(c.address,i,e,u)}}catch(e){if(n[0].every((e,t)=>az(e,n[1][t]??null)))return{k:`refused`,why:GR(e)};throw e}",
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
  ";try{if(!t.buy)return g(`holds`,`no buy of W's is recorded`,t.unproven!==`again`);let n=jf(c.address,t.mints);",
  ";return await e.bought?.put(P.address,{mint:C.mint,program:C.tokenProgram}),await QP(e,D,O,l,te,w.lastHeight,o,{token:c,minOut:T,tell:s,bound:F})}",
  "KR=e=>{let t=`owed/buy-sol`;return{get:async n=>{let r=await(await e()).get(`meta`,t)??{};return Object.hasOwn(r,n)?r[n]:void 0},put:async(n,r)=>void await(await e()).update(`meta`,t,e=>({...e??{},[n]:{mint:r.mint,program:r.program}}))}};",
  "take:async(e,t)=>(await n()).take(e,t),seed64:e.seed64,bought:KR(e.store),send:(e,n)=>hB(e,n,t.fetch),",
  "{r.fill(0)}},owed:GR(e.store),bought:KR(e.store),buyNone:async t=>Object.hasOwn(Qe(await(await e.store()).get(`meta`,gJ)),t),preempt:()=>{let e=Ke.preempt();return()=>e.release()},told:e=>console.warn(`rent back`),",
].join("");
test("the facts read from a bundle; a planted line with its rule changed FAILs", () => {
  assert.deepEqual(Object.values(facts("", JS).carries), Object.keys(MARKS).map(() => true));
  // the compute units as a constant of their own, 14e5, as a bundle that uses SOLANA_POOL_CU_LIMIT_MAX elsewhere has it
  assert.deepEqual(Object.values(facts("", JS.replace("nE=sd+BigInt(14e5)*ad/1000000n", "RD=14e5,nE=sd+BigInt(RD)*ad/1000000n")).carries), Object.keys(MARKS).map(() => true));
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
    // the sell's rule refuses a deposit back under the kit's release floor at the rent read, by name, on the last
    // instruction, and a kept sell's deposit is read from that instruction too
    [JS.replace("return X(`deposit_floor`)", "return X(`sell`)"), 6],
    [JS.replace("if(k&&x.program", "if(!1&&k&&x.program"), 6],
    [JS.replace("_-s<Qy(w)", "_-s<1000000n"), 6],
    [JS.replace("_-s<Qy(w)", "u-s<Qy(w)"), 6],
    [JS.replace("_-s<Qy(w)", "_-s<Qy(b.rent)"), 6],
    [JS.replace("let w=b?.rent;", "let w=FE;"), 6],
    [JS.replace("x=p.at(-1)", "x=p.at(0)"), 6],
    [JS.replace("let C=OE(x,l,", "let C=OE(m,l,"), 6],
    [JS.replace("<=iE&&", "<=nE&&"), 6],
    [JS.replace("iE=nE+145n*rE+2n*216n*rE", "iE=nE+145n*rE+2n*217n*rE"), 6],
    [JS.replace("rE=6960n", "rE=6961n"), 6],
    [JS.replace("if(s-y>iE)", "if(s>iE)"), 6],
    // card round-trip-costs-less: a sale's closes only with no claim owed, each W's own sold coin's or a volume
    // account's, their rent all in the note, and none on a partial sell
    [JS.replace("if(b.owed!==0)return X(`closes`);", ""), 6],
    [JS.replace("||e.kind===`token`&&e.mint!==t.token", ""), 6],
    [JS.replace("if(s!==e+n-r)", "if(s!==e+n)"), 6],
    [JS.replace("||b?.closes!==void 0&&b.closes.length>0)return X(`reserve`)", ")return X(`reserve`)"), 6],
    [JS.replace("iy(e,0)+BigInt(t)*", "BigInt(t)*"), 7],
    [JS.replace("+UE(i,o)===r", "===r"), 8],
    [JS.replace("||o>2?", "?"), 8],
    [JS.replace("e.some(e=>e.cashback!==!0)", "!1"), 9],
    // the floor end's steadiness mark holds the same owed-or-floor end, so both go
    [JS.replaceAll(/\{end:[ai]>0\?`owed`:`floor`,/g, "{end:`floor`,"), [10, 21]],
    [JS.replace("nE=sd+BigInt(14e5)*ad/1000000n", "nE=sd"), 6],
    // the compute units a constant of their own: only 14e5 is the cap's
    [JS.replace("nE=sd+BigInt(14e5)*ad/1000000n", "RD=15e5,nE=sd+BigInt(RD)*ad/1000000n"), 6],
    [JS.replace("nE=sd+BigInt(14e5)*ad/1000000n", "nE=sd+BigInt(RD)*ad/1000000n"), 6],
    [JS.replace("ad=1000000n", "ad=2000000n"), 6],
    [JS.replace("sd=5000n", "sd=0n"), 6],
    // card round-trip-costs-less: what W read as is the helper's batched read, on the second seat, compared per W
    [JS.replace("r.seen===void 0:r.seen!==i.seen)&&m.push(t)", "!0:!0)&&m.push(t)"), 11],
    [JS.replace("await AG(o[1],f)", "await AG(o[0],f)"), 11],
    [JS.replace(",OG=100,", ",OG=1000,"), 11],
    [JS.replace("var Uy=`SysvarRent", "var Uy=`SysvarC1ock"), 11],
    [JS.replace("rebuilt===!0?`rebuilt`:`own`", "`own`"), 11],
    // delta review 7 of 08290868: the buy record is read into the pass's mints; delta review 8 of 5697d7a1: the page's
    // holdings no part of what W read as
    // card restore-rebuilds-buy-records (review of 42a99f81, P1): a record a restore rebuilt is one provider's word, so
    // it is no record to the rent back (the pass holds); read as any other, W's own coin is left to that word
    [JS.replace("#${o}#1#", "#${o}#${e.holdings}#1#"), 11],
    // W's own coin holds the pass: with no record it holds (review 8: not on the page's holdings), the buy's record
    // written before its send, and the page's buy and sell hosts wired to the one record in its store
    [JS.replace("if(!t.buy)return g(`holds`", "if(!t.buy&&[...c.holdings.tokens].length>0)return g(`holds`"), 25],
    [JS.replace("t.unproven!==`again`", "!0"), 25],
    [JS.replace("return await e.bought?.put(P.address,{mint:C.mint,program:C.tokenProgram}),await QP(", "return await QP("), 25],
    [JS.replace("return Object.hasOwn(r,n)?r[n]:void 0}", "return void 0}"), 25],
    [JS.replace("seed64:e.seed64,bought:KR(e.store),send:", "seed64:e.seed64,send:"), 25],
    [JS.replace("owed:GR(e.store),bought:KR(e.store),buyNone:", "owed:GR(e.store),buyNone:"), 25],
    [JS.replace("seed64:e.seed64,bought:KR(e.store),send:", "seed64:e.seed64,bought:YR(e.store),send:"), 25],
    [JS.replace("#${o}#1#", "#1#"), 11],
    [JS.replace("try{return[e.address,...tp(e.address,e.mints)]}", "try{return[e.address]}"), 11],
    [JS.replace("if(n===`nothing`)return await Promise", "if(n!==`floor`)return await Promise"), 12],
    [JS.replace("return await Promise.resolve(e.owed?.markEmpty?.(t.address)).catch(()=>{}),await e.owed?.drop", "return await e.owed?.drop"), 12],
    [JS.replace(",...i.buy===void 0?{}:{buy:i.buy}", ""), 12],
    [JS.replace(",...r!==void 0&&(n===`floor`||n===`holds`||n===`kept`||n===`refused`)?{seen:r}:{}", ""), 12],
    [JS.replace("||n===`refused`)?{seen:r}", "||n===`refused`||n===`gave_up`)?{seen:r}"), 12],
    [JS.replace("let a=(await e.owed?.list())?.find(e=>e.address===t.address)??t,", "let a=t,"), 12],
    [JS.replace("if(d!==f)throw Error(`W's lamports differ on the two RPCs`);", ""), 13],
    [JS.replace("if(p===0n)return{end:r>0?`owed`:`nothing`", "if(p<5000000n)return{end:r>0?`owed`:`nothing`"), 13],
    [JS.replace("await PG(e,t,`gave_up`))}))return!0;return!0}", "await e.owed?.drop(t.address))}))return!0;return!0}"), 14],
    [JS.replace("l=(await e.owed.list()).find(e=>e.address===c)", "l=[].find(e=>e.address===c)"), 14],
    [JS.replace("for(let r of m)if(!await VG(t,r,!0,s,", "for(let r of n)if(!await VG(t,r,!0,s,"), 14],
    [JS.replace("!await VG(t,c,!0,s,", "!await VG(t,c,!1,s,"), 14],
    [JS.replace("nap:async n=>(a.release(),await r(n),t=await nz(e,uR,!0),t!==null)", "nap:async n=>(await r(n),!0)"), 15],
    // the sleep's wrapper is what both the lock's and the sleeps' marks hold
    [JS.replace("if(!await n.nap(e))throw ez", "await n.nap(e)"), [15, 24]],
    [JS.replace("let a=await nz(e,fR(t),n);if(!a)return!0;", "let a=()=>{};"), 15],
    [JS.replace("uR=`ct-pool/sell`", "uR=`ct-pool/sel`"), 15],
    [JS.replace("if(n[0].every((e,t)=>az(e,n[1][t]??null)))return{k:`refused`", "if(!0)return{k:`refused`"), 16],
    [JS.replace("e.lamports===t.lamports&&e.data.length", "e.data.length"), 16],
    [JS.replace("i.other.length===0&&", ""), 17],
    [JS.replace("[e,[r(t),r(n)]]", "[e,[r(t),n]]"), 18],
    [JS.replace("e.data.length===0?null:e", "e.data.length===0?e:e"), 18],
    [JS.replace("if(e!==n)throw Error(`the providers disagree on ${c.to}: ${e}/${n} lamports`);", ""), 19],
    [JS.replace("prefund:i})", "prefund:0n})"), 19],
    [JS.replace("t.unwrap?t.amount+t.prefund:0n", "t.unwrap?t.amount:0n"), 19],
    [JS.replace(":c+=r-e.prefund)", ":c+=r)"), 19],
    [JS.replace("r<e.prefund||", ""), 19],
    [JS.replace("||e===`refused`)=>(h(", ")=>(h("), 20],
    [JS.replace("steady:E<b,", "steady:T<b,"), 21],
    [JS.replace("S.end===`floor`&&S.steady", "S.end===`floor`"), 21],
    [JS.replace("I||(be.mints=iz((await Promise.resolve(e.owed?.list()).then(e=>e?.find(e=>e.address===f.address),()=>void 0))?.mints,be.mints),await e.owed?.put(be)", "I||(await e.owed?.put(be)"), 22],
    [JS.replace("return{end:`refused`,detail:n.why};let a=YR", "return{end:`gave_up`,detail:n.why};let a=YR"), 23],
    [JS.replace("for(let n=0;n<30&&(n===0||f()<p);n++){n>0&&await u(lR);", "for(let n=0;n<30&&(n===0||f()<p);n++){n>0&&await t.wait(lR);"), 24],
    [JS.replace("e++){e>0&&await u(lR);for", "e++){e>0&&await t.wait(lR);for"), 24],
  ];
  for (const [js, i] of planted) {
    assert.notEqual(js, JS, "each plant changes the line");
    const c = facts("", js).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [i].flat().map((n) => Object.keys(MARKS)[n]), js.slice(0, 80));
  }
});

// card pool-sell-legs-side-by-side: W's volume accounts read with W's own accounts and the keep counting each owed, cut
// from that card's build of public/app.js (sol-w-sweep.side.excerpt.txt): it holds; broken in place (one RPC's read
// needed on both, the owed claims left out of the count, the keep priced without them): each FAIL
test("the side-by-side sell's owed claims hold, and each break of them in place FAILs", () => {
  const KEY = "the full sell's keep counts W's volume accounts owed a claim, on either RPC's read";
  const ex = readFileSync(new URL("./sol-w-sweep.side.excerpt.txt", import.meta.url), "utf8");
  assert.equal(MARKS[KEY].test(ex), true);
  for (const [what, from, to] of [
    ["both RPCs' reads needed", ".some(t=>t[2+n]", ".every(t=>t[2+n]"],
    ["the owed claims left out", "||x.owes[t]", ""],
    ["the keep priced without them", /SO\(y,ae\)/, "SO(y,0)"],
  ]) {
    const bad = ex.replace(from, to);
    assert.notEqual(bad, ex, what);
    assert.equal(MARKS[KEY].test(bad), false, what);
  }
});

// card round-trip-costs-less: the read returns W's accounts too, so the bundle names the owes first; the full sell's
// price takes the sale's closes first, the fallback at the sweep's floor after them. Cut from that card's build: each
// holds; each broken in place FAILs.
test("the shapes since the sale closes W's accounts hold, and each break of them in place FAILs", () => {
  const OWES = "the full sell's keep counts W's volume accounts owed a claim, on either RPC's read";
  const FALLBACK = "the sell prices a full sell with that fallback, at the sweep's floor";
  const owes = ",l=o.map((e,n)=>t.some(t=>t[2+n]!=null&&t[2+n].owner===e&&np(e,t[2+n].data)>0n)),u=e=>e==null?null:e;return{program:r,amount:n,lamports:a,owes:l,accounts:u};xe=[yd,zf].filter((e,t)=>le.cashback&&e===be||F.owes[t]).length,Se=ye?sb(le,N):HO(N,xe)";
  const fallback = "Ne=RO(N)>1000000n?RO(N):jO,Pe=Vb(N),Le=(e,n)=>{if(R<pe-rb+n)return $(`not_funded`);let r=qy(N,0),i=Ae.reduce((e,t)=>e+t.lamports,0n),a=Ae.length>0?mG({fee:n,made:me,rents:zO(N,L,we,e),after:r,lamports:R+i,minOut:_e,keeps:!1,noteFloor:Pe}):mG({fee:n,made:me,rents:zO(N,L,we,e),after:Se+Ce,lamports:R,minOut:_e,keeps:ye,noteFloor:Pe,...ye?{}:{swept:Se-r,base:r,floor:Ne}})";
  assert.equal(MARKS[OWES].test(owes), true);
  assert.equal(MARKS[FALLBACK].test(fallback), true);
  for (const [key, ex, from, to] of [
    [OWES, owes, "owes:l,", "owes:[!1,!1],"],
    [OWES, owes, ".some(t=>t[2+n]", ".every(t=>t[2+n]"],
    [FALLBACK, fallback, "floor:Ne}", "floor:jO}"],
    [FALLBACK, fallback, "Ne=RO(N)>1000000n?RO(N):jO,", "Ne=jO,"],
  ]) {
    const bad = ex.replace(from, to);
    assert.notEqual(bad, ex, from);
    assert.equal(MARKS[key].test(bad), false, from);
  }
});
