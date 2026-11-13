// node --test scripts/live-checks/sol-w-sweep.test.mjs: the live check replays its recorded answers
// (sol-w-sweep.answers.json). good: since card pool-amounts-are-standard-sizes that card's build (every note a rung, the
// sweep's a rung with what W keeps and no transfer, W's rest recorded as its tail): PASS; liveBefore, SIGN_HOST before
// it: FAIL on its rules alone (RUNG). Before it good was card every-lamport-can-move's build, a full sell with no deposit back
// and no reserve, a partial sell's deposit back on the pool's grid, the sweep's grid note with the rest under the grid paid to the pin's fee payer,
// and a sweep that leaves W only an owed claim's cost: PASS; beforeLamport, card round-trip-costs-less's build (a full
// sell depositing W's surplus with its proceeds): FAIL on that card's seven rules alone (LAMPORT); before1d, that card's
// 1d3b96d9c build (the rest paid to the pool's account, tokens on any account keeping W whole): FAIL on marks 5, 6 and 9.
// Before it, good was this card's build, a full sell depositing W's surplus, keeping what the sweep needs
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
// The rules card round-trip-costs-less moved, so no build before it carries them: what W read as (the helper's batched
// read), the record (listed empty, its proven buy kept), the list a failed load keeps
// and the found W's rule (card buy-spends-several-pieces), merged after them
const MOVED = [11, 12, 14, 26];
// card every-lamport-can-move's rules, in the places of the full sell's reserve rules it deleted, and the sweep's keep
// rules it rewrote (7, 8, 9: kept accounts counted, review P2-1): no build before it carries them
const LAMPORT = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
// card pool-amounts-are-standard-sizes's rules: the rules' note a rung, the sell's floor a rung, the sweep's rung note with what W keeps and no
// transfer, its rule, the floor end, and W's tail record: no build before it carries them
const RUNG = [1, 2, 3, 4, 5, 6, 8, 21, 27];
const rung = (list) => [...new Set([...list, ...RUNG])].sort((a, b) => a - b).map((i) => ALL[i]);
const moved = (...more) => [...new Set([...MOVED, ...LAMPORT, ...RUNG, ...more])].sort((a, b) => a - b).map((i) => ALL[i]);

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

// SIGN_HOST as served when this card was built: release 130, before card found-wallet-sweep-reads-on-a-pair-that-answers
// shipped its found W's token pair (26)
test("recorded answer liveBefore (SIGN_HOST before card pool-amounts-are-standard-sizes): FAIL on that card's rules and the found W's pair alone", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, rung([26]));
});

test("recorded answer beforeLamport (card round-trip-costs-less's build): FAIL on card every-lamport-can-move's rules alone", () => {
  const v = judge(ANSWERS.beforeLamport);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, rung(LAMPORT));
});

// Review P1-1 and P1-2 of 1d3b96d9c: that build paid the sweep's rest to the pool's account (the builder and the rule)
// and kept W whole for tokens on any account: FAIL on those three marks alone
test("recorded answer before1d (1d3b96d9c's build): FAIL on the fee payer's and the own coins' marks alone", () => {
  const v = judge(ANSWERS.before1d);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, rung([5, 6, 9]));
});

test("recorded bad answer (11c963f9's build): FAIL, every mark named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

// Delta review 7 of 08290868: that build swept W to 0 after an airdrop's full sell with W's own coin held: FAIL on the
// seen rule (the buy record read into the pass) and the own-coin rule, with the moved ones and the plan refusal's shape
// as card sol-rent-back-dust-burn wrote it later (16); and, older than main 383b1ffe, the sell's rule under the floor (6)
test("recorded answer beforeFold (08290868's build): FAIL on the seen and own-coin rules and those moved since", () => {
  const v = judge(ANSWERS.beforeFold);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, moved(6, 11, 16, 25));
});

// Delta review 8 of 5697d7a1: with no buy record, that build swept W on the page's holdings (the helper's word on
// mainnet), and hashed them into what W read as: FAIL on the seen and own-coin rules and those moved since (the
// floor's sell rule among them, as for beforeFold)
test("recorded answer beforeFold8 (5697d7a1's build): FAIL on the seen and own-coin rules and those moved since", () => {
  const v = judge(ANSWERS.beforeFold8);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, moved(6, 11, 16, 25));
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
  // card pool-amounts-are-standard-sizes: the rules' note (a rung, its rule the Solana pieces'), the sweep's note, its stay
  "var BC=1000000n,VC=5000000n;var hD=(e,t)=>pD(e,t)===2n?t*5n/2n:t*2n;function iD(e,t){gD(e);let n=[];for(let r=e.min;r<=t;r=hD(e,r))n.push(r);return n.reverse()}function kD(e,t){if(typeof t!=`bigint`||t<0n)throw Error(`amount: not a whole amount`);let n=t<e.floor?0n:iD(e.ladder,t)[0]??0n;return{note:n,kept:t-n}}function jR(e,t){return typeof t==`bigint`&&fD(e.ladder,t)}var qP=Object.freeze({grid:BC,floor:VC,ladder:Object.freeze({one:BC,min:VC}),least:VC});function JA(e){return typeof e!=`bigint`||e<=0n?0n:kD(qP,e).note}function MR(e,t){return iD(e.ladder,t)}function YA(e){let t=dx(e);if(t<=5000000n)return VC;let n=VC;for(;n<t;)n=MR(qP,n*3n)[0];return n}",
  "var cj=(e,t,n=0)=>t+n===0?0n:dm(e,0)+BigInt(t)*(wc+dm(e,165))+BigInt(n)*wc;function lj(e,t=0n){if(typeof e!=`bigint`||e<=0n)return{value:0n,under:0n};for(let n=e;;){let r=JA(n);if(r===0n)return{value:0n,under:0n};let i=e-r;if(i===0n||i>=t)return{value:r,under:i};n=r-1n}}var sk=(e,t)=>{let n=dm(e,0)-t;return n>0n?n:0n};function uj(e,t,n,r,i,a,o=0,s=0){let c=NA(t),l=FA(e,n);if(l.signers.length!==1||l.signers[0]!==t.wallet)return X(`signers`);if(l.ixs.length!==1)return X(`instructions`);let u=HA(l.ixs[0],c,t.wallet,t.precommitment,n);if(typeof r!=`bigint`||typeof i?.lamportsPerByte!=`bigint`||typeof i.factor!=`bigint`||i.lamportsPerByte<0n||i.factor<0n||!Number.isSafeInteger(o)||o<0||o>2||!Number.isSafeInteger(s)||s<0)return X(`sweep_reads`);let d=cj(i,o,s);return u===lj(r-5000n-sj(i,n,a)-d,sk(i,d)).value?!jR(qP,u)||u<1000000n||u<oj(i)?X(`amount`):(_A(e),u):X(`sweep_amount`)}",
  "var lc=`11111111111111111111111111111111`,wc=5000n,xm=wc,CY=(e,t,n)=>{let r=new Uint8Array(12),i=new DataView(r.buffer);return i.setUint32(0,2,!0),i.setBigUint64(4,n,!0),{program:lc,accounts:[{key:e,signer:!0,writable:!0},{key:t,signer:!1,writable:!0}],data:r}};",
  "var sd=5000n,ad=1000000n,nE=sd+BigInt(14e5)*ad/1000000n,rE=6960n,iE=nE+145n*rE+2n*216n*rE;",
  "let p=d.ixs.slice(f);if(p.length===0)return X(`instructions`);let m=p.find(e=>e.data.length===24&&e.program!==l.program);if(!m)return X(`sell`);let h=IA(m.data,16);if(h<u)return X(`min_out`);let g=gm(r,n.wallet,t.amount,h);if(typeof s!=`bigint`||s<0n||s>=h)return X(`reserve`);let _=c;if(_===void 0||typeof _.full!=`boolean`||typeof _.fee!=`bigint`||_.fee<0n||_.fee>105000n||s>(_.full?0n:iE))return X(`reserve`);let v=_.rent;if(v===void 0||typeof v.lamportsPerByte!=`bigint`||v.lamportsPerByte<1n||v.lamportsPerByte>1000000n||v.factor!==1n&&v.factor!==2n)return X(`reserve`);let y=h-s<YA(v),b=p.at(-1);if(y&&b.program===l.program)return X(`deposit_floor`);if(_.full&&b.program===l.program)return X(`deposit_full`);let x=y||_.full,S=x?p:p.slice(0,-1);if(S.length!==g.length)return X(`sell`);for(let e=0;e<g.length;e++){let t=g[e],n=S[e];if(n.program!==t.program||n.data.length!==t.data.length||n.data.some((e,n)=>e!==t.data[n]))return X(`sell`);if(!zA(n.accounts,t.accounts))return X(`sell_accounts`)}if(x)return hA(e),{chain:`solana`,op:t.kind,token:t.token,amount:t.amount,feeCap:0n,pool:l.pool,to:n.wallet,decimals:t.decimals,back:null};let C=BA(b,l,n.wallet,n.precommitment,o,!0);return C===JA(h-s)?(hA(e),{chain:`solana`,op:t.kind,token:t.token,amount:t.amount,feeCap:0n,pool:l.pool,to:l.pool,decimals:t.decimals,back:C}):X(`deposit_amount`)}",
  "function IY(e,t){let n=e.filter(e=>e.cashback===!0).length;return n>2||e.some(e=>e.tokens===!0&&t(e.address))?null:{owed:n,kept:e.length-n}}",
  "if(T<x)return{end:i>0?`owed`:`floor`,detail:``};",
  "async function JR(e,t,n){let r=[];}",
  "var Uy=`SysvarRent111111111111111111111111111111111`;async function EG(e,t){let n=await Promise.resolve(e.bought?.get(t)).catch(()=>void 0);return{rec:n,none:n===void 0&&await Promise.resolve(e.buyNone?.(t)).catch(()=>!1)===!0}}var DG=e=>e.rec?`${e.rec.mint}:${e.rec.program}:${e.rec.rebuilt===!0?`rebuilt`:`own`}`:e.none?`none`:`-`,OG=100,kG=1e3;async function AG(e,t){let n=t.map(e=>{try{return[e.address,...tp(e.address,e.mints)]}catch{return[e.address]}}),r=[Uy,...n.flat()],i=[];for(let t=0;t<r.length;t+=OG)i.push(...await SW(e,r.slice(t,t+OG)));let a=e=>e===null?`-`:`${e.owner}:${String(e.lamports)}:${z.encode(e.data)}`,o=a(i[0]??null),s=1;return new Map(t.map((e,t)=>{let r=i.slice(s,s+n[t].length);return s+=n[t].length,[e.address,{any:r.some(e=>e!==null),seen:z.encode(dt(fW.encode(`${r.map(a).join(`|`)}#${o}#1#${DG(e.evidence)}`)))}]}))}async function jG(e,t,n,r){try{let i=await Ij(e,t).read(n);if(r===null)return i===`none`?null:void 0;if(i!==null&&i!==`none`&&i.mint===r.mint&&i.program===r.program)return{mint:i.mint,program:i.program}}catch{}}async function MG(e,t,n,r,i){let a=await EG(e,t.w.address),o=a.rec&&a.rec.rebuilt!==!0?{mint:a.rec.mint,program:a.rec.program}:void 0,s=n.buy;o===void 0&&s===void 0&&(a.rec!==void 0||a.none)&&(s=await jG(t.rpcs[0],t.program,t.w.address,a.rec?{mint:a.rec.mint,program:a.rec.program}:null)),o===void 0&&s&&(o=s);let c=o===void 0&&s===void 0?n.passes+1>=3?`steady`:`again`:void 0,l=await CG(e,o?{...t,mints:HG(t.mints,[o]),buy:o}:{...t,buy:null,...c?{unproven:c}:{}},r);return await PG(e,n,l.end,l.steady?i:void 0,s===void 0?{}:{buy:s}),l.end===`gave_up`||l.end===`sent`||l.end===`owed`||c===`again`}async function NG(e,t,n){let r=await EG(e,t),i=r.rec?HG(n,[{mint:r.rec.mint,program:r.rec.program}]):[...n];return(await AG(e.rpcs[1],[{address:t,mints:i,evidence:r}]).catch(()=>void 0))?.get(t)?.seen}async function PG(e,t,n,r,i={}){try{if(n===`floor`&&i.unlisted!==!0&&i.lamports!==void 0&&i.lamports>0n?await Promise.resolve(e.owed?.tail?.({chain:`sol`,address:t.address,l:t.l,j:t.j,amount:i.lamports.toString()})).catch(()=>{}):(n===`nothing`||n===`sent`||n===`floor`&&i.unlisted===!0)&&await Promise.resolve(e.owed?.untail?.(t.address)).catch(()=>{}),n===`nothing`)return await Promise.resolve(e.owed?.markEmpty?.(t.address)).catch(()=>{}),await e.owed?.drop(t.address);let a=(await e.owed?.list())?.find(e=>e.address===t.address)??t,{seen:o,left:s,...c}=a;await e.owed?.put({...c,mints:HG(a.mints,t.mints),passes:a.passes+1,...r!==void 0&&(n===`floor`||n===`holds`||n===`kept`||n===`refused`)?{seen:r}:{},...i.buy===void 0?{}:{buy:i.buy}})}catch{}}var FG=()=>!1;async function IG(e,t=globalThis.navigator?.locks??null){if(!t||!e.owed)return!1;let n=await e.owed.list(),r=e.pin.program,{pool:i,scope:a}=ww(r),o=e.rpcs,s=e.wait??(e=>new Promise(t=>setTimeout(t,e))),c=null,l=null;try{c=await e.wallets(FG)}catch(e){l=e}let u=await Promise.resolve(e.owed.empty?.()).catch(()=>void 0)??new Set,d=[...new Map((c??[]).filter(e=>e.chain===`sol`&&!u.has(e.address)&&!n.some(t=>t.address===e.address)).map(e=>[e.address,e])).values()];if(n.length===0&&d.length===0)return l!==null;let f=[];for(let{address:t,mints:r}of[...n,...d.map(e=>({address:e.address,mints:[]}))]){let n=await EG(e,t);f.push({address:t,evidence:n,mints:n.rec?HG(r,[{mint:n.rec.mint,program:n.rec.program}]):r})}let p=await AG(o[1],f).catch(()=>null),m=[];for(let{address:t}of f){let r=n.find(e=>e.address===t),i=p?.get(t);r?(i===void 0?r.seen===void 0:r.seen!==i.seen)&&m.push(t):i!==void 0&&(i.any?m.push(t):await Promise.resolve(e.owed.markEmpty?.(t)).catch(()=>{}))}if(m.length===0)return l!==null||p===null;for(let e=m.length-1;e>0;e--){let t=LG(e+1);[m[e],m[t]]=[m[t],m[e]]}let h;try{if(c===null)throw l;h={store:await e.notes(),sync:Uw(o,r),rent:await Jy(o),wallets:c}}catch(n){for(let r of m)if(!await VG(t,r,!0,s,async()=>{let t=(await e.owed.list()).find(e=>e.address===r);t&&(e.told?.({address:r,step:`rent_back`,state:`gave_up`,detail:`this load's reads: ${bG(n)}`}),await PG(e,t,`gave_up`))}))return!0;return!0}let{store:g,sync:_,rent:v}=h,y=p===null,b=e.preempt?.();try{for(let[n,c]of m.entries())if(n>0&&await s(kG+LG(kG)),!await VG(t,c,!0,s,async t=>{let n=d.find(e=>e.address===c),l=(await e.owed.list()).find(e=>e.address===c)??(n?{address:c,l:n.l.toString(),j:n.j,mints:[],passes:0}:void 0),u=l&&h.wallets.find(e=>e.chain===`sol`&&e.address===l.address&&e.l.toString()===l.l&&e.j===l.j);l&&u&&await MG(e,{rpcs:o,program:r,pool:i,scope:a,rent:v,store:g,sync:_,w:u,mints:l.mints,wait:s,...l.sell?{sell:l.sell}:{}},l,t,p?.get(c)?.seen)&&(y=!0)}))return!0}finally{b?.()}return y}function LG(e){if(e<=1)return 0;let t=Math.floor(4294967296/e)*e,n=new Uint32Array(1);for(;;)if(globalThis.crypto.getRandomValues(n),n[0]<t)return n[0]%e}var ez=Error(`a sell took the sell lock`),tz=1n<<62n;function nz(e,t,n){return new Promise((r,i)=>{e.request(t,n?{mode:`exclusive`,ifAvailable:!0}:{mode:`exclusive`},e=>e?new Promise(e=>r(e)):void r(null)).catch(i)})}async function rz(e,t,n,r,i){if(!e)return await i(),!0;let a=await nz(e,fR(t),n);if(!a)return!0;try{let t=await nz(e,uR,n);if(!t)return!1;let a={release:()=>{t?.(),t=null},nap:async n=>(a.release(),await r(n),t=await nz(e,uR,!0),t!==null)};try{await i(a)}finally{a.release()}return!0}finally{a()}}function iz(e,t){let n=[...e??[]];for(let e of t)n.some(t=>t.mint===e.mint)||n.push(e);return n}function az(e,t){return e===null||t===null?e===t:e.owner===t.owner&&e.lamports===t.lamports&&e.data.length===t.data.length&&e.data.every((e,n)=>e===t.data[n])}",
  ";lR=1e3,uR=`ct-pool/sell`,dR=120*lR,fR=e=>`ct-pool/back/${e}`,pR=22;",
  // the tail's record (pick (c)): its key and the owed store's write and delete
  "var RZ=e=>`w-tail/sol/${e}`,zZ=e=>({tail:async t=>void await(await e()).update(`meta`,RZ(t.address),()=>({chain:t.chain,address:t.address,l:t.l,j:t.j,amount:t.amount})),untail:async t=>{let n=await e();await n.get(`meta`,RZ(t))!==void 0&&await n.delete?.(`meta`,RZ(t))}});",
  ";u=async e=>{if(!n)return t.wait(e);if(!await n.nap(e))throw ez};",
  "if(n.plan.close.length>0)return{end:`gave_up`,detail:`still open after the teardown: ${n.plan.close.map(e=>e.address).join(`, `)}`};let[d,f]=n.held.map(e=>e[0]?.lamports??0n);if(d!==f)throw Error(`W's lamports differ on the two RPCs`);let p=d;if(p===0n)return{end:r>0?`owed`:`nothing`,",
  "{k:`plan`,held:n,accounts:i,burn:u,plan:Nf(c.address,i,e,u)}}catch(e){if(n[0].every((e,t)=>az(e,n[1][t]??null)))return{k:`refused`,why:GR(e)};throw e}",
  "r.keep.push({address:e,why:o.join(`, `),...i.other.length===0&&i.amount>0n?{cashback:!0}:{}})",
  "let r=e=>e!==null&&e.owner===`11111111111111111111111111111111`&&e.data.length===0?null:e,i=Object.fromEntries(Object.entries(t).map(([e,[t,n]])=>[e,[r(t),r(n)]])),a={close:[]",
  ";let[e,n]=t[c.to].map(e=>e?.lamports??0n);if(e!==n)throw Error(`the providers disagree on ${c.to}: ${e}/${n} lamports`);i=e}a.claim.push({program:r.program,uva:e,mint:c.mint,from:c.from,to:c.to,amount:r.amount,open:d===null,unwrap:r.program===gf,fromAmount:u,toAmount:n,prefund:i})",
  ";t.claims.reduce((e,t)=>e+(t.unwrap?t.amount+t.prefund:0n),0n)",
  ";e.open&&(typeof r!=`bigint`||r<e.prefund||r-e.prefund>kf?y.push(`${o}: ${e.to} opened with ${r??`nothing read`} lamports (want ${e.prefund} there before and at most ${kf} more)`):c+=r-e.prefund)",
  ";g=(e,t,n=e===`holds`||e===`kept`||e===`refused`)=>(h(`rent_back`,e,t),{end:e,steady:n})",
  ";let M=v-xm-sj(l,b,j)-cj(l,p,h),N=v-xm-sj(l,b,{...j,state:[uX,uX],label:[uX,uX]})-cj(l,p,h),Q=sk(l,cj(l,p,h)),{value:P}=lj(M,Q),I=lj(N,Q).value,L=NY(M,w,Q);if(P<w&&L===0n&&t.unlisted?.(),P<w&&L>0n&&(t.buy||S!==void 0)&&t.read?.(L),P<w)return{end:p>0?`owed`:`floor`,steady:I<w,detail:`W's ${v} would leave ${M} for a note, under ${w}: kept on W${p>0?`, owed ${p} cashback claim${p>1?`s`:``}`:``}`};let R=await ZH(s),{message:z}=Ku(c.address,[jY(t.program,t.pool,c.address,b,k,P)],R.blockhash,[]),te=MY(z),ne=await AJ(s,async e=>BigInt(TJ((await e(`getFeeForMessage`,[B.encode(z),{commitment:`confirmed`}]))?.value)));if(ne[0]!==xm||ne[1]!==xm)throw Error(`the sweep's fee reads ${ne[0]} and ${ne[1]}`);",
  ";if(S.end!==`sent`)return`steady`in S?g(S.end,S.detail,S.end===`floor`&&S.steady):g(S.end,S.detail);",
  ";I||(be.mints=iz((await Promise.resolve(e.owed?.list()).then(e=>e?.find(e=>e.address===f.address),()=>void 0))?.mints,be.mints),await e.owed?.put(be)",
  // review P1-2 of 1d3b96d9c: W's own coins' accounts (a found W's every account), the keep count's caller
  ";let n=new Set(t.mints.map(e=>oc(c.address,e.mint,e.program))),r=e=>t.bare===!0||n.has(e);if(IY(y.ok.keep,r)===null)return g(`kept`,``);",
  ";if(n.k===`refused`)return{end:`refused`,detail:n.why};let a=IY(n.plan.keep,r)",
  ";for(let n=0;n<30&&(n===0||f()<p);n++){n>0&&await u(lR);try{return{ok:await",
  ";e++){e>0&&await u(lR);for(let e of[...h]){let t=await TR(s,t=>zP(t,e.signature,e.wire))",
  ";try{if(!t.buy&&t.bare!==!0)return g(`holds`,`no buy of W's is recorded`,t.unproven!==`again`);let n=jf(c.address,t.mints);",
  ";return await e.bought?.put(P.address,{mint:C.mint,program:C.tokenProgram}),await QP(e,D,O,l,te,w.lastHeight,o,{token:c,minOut:T,tell:s,bound:F})}",
  "KR=e=>{let t=`owed/buy-sol`;return{get:async n=>{let r=await(await e()).get(`meta`,t)??{};return Object.hasOwn(r,n)?r[n]:void 0},put:async(n,r)=>void await(await e()).update(`meta`,t,e=>({...e??{},[n]:{mint:r.mint,program:r.program}}))}};",
  "take:async(e,t)=>(await n()).take(e,t),seed64:e.seed64,bought:KR(e.store),send:(e,n)=>hB(e,n,t.fetch),",
  "{r.fill(0)}},owed:GR(e.store),bought:KR(e.store),buyNone:async t=>Object.hasOwn(Qe(await(await e.store()).get(`meta`,gJ)),t),preempt:()=>{let e=Ke.preempt();return()=>e.release()},told:e=>console.warn(`rent back`),",
  // card buy-spends-several-pieces: the found W's rule, as that card's build spells it (its teardown gated on the rule's
  // time part, review P3-5 of c7b85ba3a, and reading every token account both RPCs list W owning, review P2)
  ";let tk=e.tokenRpcs??s;let n=e=>[...new Set([...Yl(c.address,t.mints),...e])],a=async(e,i)=>{let a=n(i),o=new Map;let l=await _K(s,e=>bK(e,[c.address,...a])),u=Object.fromEntries(a.map((e,t)=>[e,[l[0][t+1],l[1][t+1]]]));try{return{k:`plan`,held:l,accounts:u,addresses:a,burn:p,plan:Zl(c.address,u,e,p)}}catch(e){throw e}},h=await v(`teardown`,async()=>{let ww=``,e=t.bare===!0?await wq(s,c.address).catch(t=>(ww=`its latest transaction not read on both RPCs (${fq(t)})`,null)):void 0;if(e===null)return{young:ww||`not yet past its last transaction's blockhash on both RPCs, or the two not reading that transaction alike`,keep:[],signed:[],last:0,unclaimed:void 0,since:void 0};let n=e===void 0?[]:await jq(tk,c.address).catch(t=>(ww=`its token accounts not read alike on both RPCs (${fq(t)})`,null));if(n===null)return{young:ww,keep:[],signed:[],last:0,unclaimed:void 0,since:void 0};let r=await a(void 0,n);if(r.k===`holds`)return{holds:r.steady,keep:[],signed:[],last:0,unclaimed:void 0,since:e};if(r.k===`refused`)return{refused:r.why,keep:[],signed:[],last:0,unclaimed:void 0,since:e};let{held:i,accounts:l,addresses:u,plan:d}=r;if(d.close.length===0)return{keep:d.keep,signed:[],last:0,unclaimed:void 0,since:e};let f=await uB(s),p=await td(c.address,d,l,[i[0][0]?.lamports??0n,i[1][0]?.lamports??0n],{blockhash:f.blockhash,lastValidBlockHeight:f.lastHeight},async e=>{let t=[];for(let n of e)t.push(await _K(s,e=>nd(e,n.wire,c.address,u)));return t},r.burn);pA(p.wires,m,p.reads);let h=await o(p.wires);return e!==void 0&&await Dq(s,c.address).catch(()=>null)!==e?{young:`a transaction landed on W since the rule's read`,keep:[],signed:[],last:0,unclaimed:void 0,since:void 0}:{keep:p.plan.keep,signed:h,last:f.lastHeight,unclaimed:p.reads.unclaimed,since:e}});if(h===null)return g(`gave_up`,`the teardown`);if(h.ok.young!==void 0)return g(`holds`,`a found W: ${h.ok.young}`,!1);let b=h.ok.unclaimed,x=h.ok.since,S=new Set(h.ok.signed.map(e=>e.signature)),C=cA(l)>1000000n?cA(l):tA,w=await v(`sweep`,async()=>{let wy=``,n=x===void 0?[]:await jq(tk,c.address).catch(e=>(wy=fq(e),null));if(n===null)return{end:`holds`,steady:!1,detail:`a found W: its token accounts not read alike on both RPCs (${wy})`};let r=await a(b,n);let ru=x===void 0||await Oq(tk,s,c.address,x,S).catch(e=>fq(e));if(ru!==!0)return{end:`holds`,steady:!1,detail:`a found W: owning a token account, or a transaction on W since the rule's read, on either RPC`};let[ee]=await o([N]);return x!==void 0&&!await kq(s,c.address,x,S).catch(()=>!1)?{end:`holds`,steady:!1,detail:`a found W: a transaction landed on W after the rule's read`}:{end:`sent`};async function wq(e,t){let n=await Eq(e,t);if(n===null)return null;let r=(await _K(e,async e=>await e(`getBlock`,[n.slot,iu]))).map(e=>e?.blockHeight);return!r.every(e=>Number.isSafeInteger(e))||r[0]!==r[1]?null:(await _K(e,async e=>await e(`getBlockHeight`,[{commitment:`finalized`}]))).every(e=>Number.isSafeInteger(e)&&e>r[0]+Tq)?n.signature:null}async function Eq(e,t){let n=(await _K(e,async e=>await e(`getSignaturesForAddress`,[t,{limit:1,commitment:`confirmed`}]))).map(e=>{let t=Array.isArray(e)&&e.length===1?e[0]:null;return t&&typeof t.signature==`string`&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(t.signature)&&Number.isSafeInteger(t.slot)&&t.slot>=0?{signature:t.signature,slot:t.slot}:null});return n[0]&&n[1]&&n[0].signature===n[1].signature&&n[0].slot===n[1].slot?n[0]:null}var Dq=async(e,t)=>(await Eq(e,t))?.signature??null;async function Oq(z1,e,t,n,r){return await Mq(z1,t)&&await kq(e,t,n,r)}async function kq(e,t,n,r){return(await _K(e,async e=>await e(`getSignaturesForAddress`,[t,{until:n,limit:r.size+1,commitment:`confirmed`}]))).every(e=>Array.isArray(e)&&e.length<=r.size&&e.every(e=>typeof e?.signature==`string`&&r.has(e.signature)))}var Aq=e=>{if(e.length<32||e.length>44)return!1;try{return z.decode(e).length===32}catch{return!1}};async function jq(e,t){let n=await _K(e,async e=>{let n=new Set;for(let r of[dc,fc]){let i=await e(`getTokenAccountsByOwner`,[t,{programId:r},{encoding:`base64`,commitment:`confirmed`}]);if(!Array.isArray(i?.value))throw Error(`getTokenAccountsByOwner answered no list`);for(let e of i.value){let t=e?.pubkey;if(typeof t!=`string`||!Aq(t))throw Error(`getTokenAccountsByOwner answered an entry with no address`);n.add(t)}}return[...n].sort()});if(n[0].join(`,`)!==n[1].join(`,`))throw Error(`the two RPCs list W's token accounts apart`);return n[0].slice(0,16)}async function Mq(e,t){return(await Promise.all(e.flatMap(e=>[dc,fc].map(n=>e(`getTokenAccountsByOwner`,[t,{programId:n},{encoding:`base64`,commitment:`confirmed`}]))))).every(e=>Array.isArray(e?.value)&&e.value.length===0)}var Tq=151,iu=Object.freeze({commitment:`finalized`,encoding:`json`,transactionDetails:`none`,rewards:!1,maxSupportedTransactionVersion:0});var _K=(e,t)=>Promise.all([t(e[0]),t(e[1])]),dc=`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`,fc=`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`;",
].join("");
test("the facts read from a bundle; a planted line with its rule changed FAILs", () => {
  assert.deepEqual(Object.values(facts("", JS).carries), Object.keys(MARKS).map(() => true));
  // the compute units as a constant of their own, 14e5, as a bundle that uses SOLANA_POOL_CU_LIMIT_MAX elsewhere has it
  assert.deepEqual(Object.values(facts("", JS.replace("nE=sd+BigInt(14e5)*ad/1000000n", "RD=14e5,nE=sd+BigInt(RD)*ad/1000000n")).carries), Object.keys(MARKS).map(() => true));
  const planted = [
    // card every-lamport-can-move: a full sell's deposit back and reserve refused by name, a partial sell's reserve capped
    [JS.replace("||_.fee>105000n||", "||"), 0],
    [JS.replace("s>(_.full?0n:iE)", "s>(_.full?1n:iE)"), 0],
    [JS.replace("if(_.full&&b.program===l.program)return X(`deposit_full`);", ""), 0],
    [JS.replace("let x=y||_.full,", "let x=y,"), 0],
    [JS.replace("iE=nE+145n*rE+2n*216n*rE", "iE=nE+145n*rE+2n*217n*rE"), 0],
    [JS.replace("rE=6960n", "rE=6961n"), 0],
    // a partial sell's deposit back on the grid, read from the last instruction
    [JS.replace("return C===JA(h-s)?", "return C===h-s?"), 1],
    [JS.replace("X(`deposit_amount`)}", "X(`sell`)}"), 1],
    [JS.replace("let C=BA(b,l,", "let C=BA(m,l,"), 1],
    [JS.replace(",b=p.at(-1);", ",b=p.at(0);"), [1, 3]],
    // the rules' note (card pool-amounts-are-standard-sizes): the largest rung at or under, the ladder 1-2-5 from 0.005 SOL
    [JS.replace("return n.reverse()}", "return n}"), [1, 2, 4, 5, 6]],
    [JS.replace("t*5n/2n:t*2n", "t*3n:t*2n"), [1, 2, 4, 5, 6]],
    [JS.replace("let n=t<e.floor?0n:iD(", "let n=t<e.grid?0n:iD("), [1, 2, 4, 5, 6]],
    [JS.replace("return{note:n,kept:t-n}", "return{note:t,kept:0n}"), [1, 2, 4, 5, 6]],
    [JS.replace("e<=0n?0n:kD(qP,e).note}", "e<=0n?0n:e}"), [1, 2, 4, 5, 6]],
    [JS.replace("BC=1000000n", "BC=100000n"), [1, 2, 3, 4, 5, 6]],
    [JS.replace("VC=5000000n", "VC=1000000n"), [1, 2, 3, 4, 5, 6]],
    // the sell's floor: the pool's note floor rounded up to the grid, never under 0.005 SOL, refused by name
    [JS.replace("let y=h-s<YA(v)", "let y=h-s<1000000n"), 3],
    [JS.replace("if(t<=5000000n)return VC;", "if(t<=1000000n)return VC;"), 3],
    [JS.replace("n=MR(qP,n*3n)[0]", "n+=BC"), 3],
    [JS.replace("for(;n<t;)n=MR(", "for(;n<=t;)n=MR("), 3],
    [JS.replace("return iD(e.ladder,t)}function YA", "return[t]}function YA"), 3],
    [JS.replace(",L=NY(M,w,Q);if(P<w", ",L=NY(M,w);if(P<w"), 21],
    [JS.replace("if(y&&b.program===l.program)return X(`deposit_floor`);", ""), 3],
    // the sweep's note: the largest rung whose remainder is 0 or at least what W must keep, none paid away
    [JS.replace("if(i===0n||i>=t)return{value:r,under:i}", "if(!0)return{value:r,under:i}"), [4, 5, 6]],
    [JS.replace("return n>0n?n:0n};", "return n};"), 4],
    [JS.replace("Q=sk(l,cj(l,p,h))", "Q=0n"), [4, 21]],
    [JS.replace("[jY(t.program,t.pool,c.address,b,k,P)]", "[jY(t.program,t.pool,c.address,b,k,M)]"), 5],
    [JS.replace("[jY(t.program,t.pool,c.address,b,k,P)]", "[jY(t.program,t.pool,c.address,b,k,P),CY(c.address,m.solana.feePayer,M-P)]"), 5],
    [JS.replace("if(ne[0]!==xm||ne[1]!==xm)", "if(ne[0]!==xm)"), 5],
    [JS.replace("wc=5000n,xm=wc", "wc=5001n,xm=wc"), 5],
    // the sweep's rule: the deposit alone, its value the sweep's note with what W keeps, a rung
    [JS.replace("if(l.ixs.length!==1)return X(`instructions`);", ""), 6],
    [JS.replace("if(l.ixs.length!==1)return X(`instructions`);", "if(l.ixs.length>2)return X(`instructions`);"), 6],
    [JS.replace("!jR(qP,u)||", ""), 6],
    [JS.replace("u<1000000n||u<oj(i)", "u<oj(i)"), 6],
    [JS.replace("return u===lj(", "return u>=lj("), [6, 8]],
    [JS.replace("-d,sk(i,d)).value?", "-d,0n).value?"), [6, 8]],
    // an owed claim's cost, and a frame's fee per account kept for any other reason (review P2-1)
    [JS.replace("dm(e,0)+BigInt(t)*", "BigInt(t)*"), 7],
    [JS.replace("t+n===0?0n:", "t===0?0n:"), 7],
    [JS.replace("+BigInt(n)*wc;", ";"), 7],
    [JS.replace("(e,t,n=0)=>", "(e,t,n)=>"), 7],
    [JS.replace("let d=cj(i,o,s);", "let d=cj(i,o);"), [6, 8]],
    [JS.replace("||o<0||o>2||", "||o<0||"), 8],
    [JS.replace("||!Number.isSafeInteger(s)||s<0)return X(`sweep_reads`)", ")return X(`sweep_reads`)"), 8],
    [JS.replace("-sj(i,n,a)-d,", "-sj(i,n,a),"), [6, 8]],
    [JS.replace("e.some(e=>e.tokens===!0&&t(e.address))", "!1"), 9],
    [JS.replace("return n>2||", "return n>3||"), 9],
    [JS.replace("kept:e.length-n}", "kept:0}"), 9],
    [JS.replace("e.filter(e=>e.cashback===!0)", "e.filter(e=>e.cashback!==!1)"), 9],
    // review P1-2 of 1d3b96d9c: only tokens on W's own coins' accounts keep W whole, every account a found W's
    [JS.replace("e.some(e=>e.tokens===!0&&t(e.address))", "e.some(e=>e.tokens===!0)"), 9],
    [JS.replace("r=e=>t.bare===!0||n.has(e)", "r=e=>t.bare===!0"), 9],
    [JS.replace("r=e=>t.bare===!0||n.has(e)", "r=e=>n.has(e)"), 9],
    [JS.replace("IY(y.ok.keep,r)", "IY(y.ok.keep,q)"), 9],
    [JS.replace("IY(n.plan.keep,r)", "IY(n.plan.keep,q)"), 9],
    // the floor end's steadiness mark holds the same owed-or-floor end, so both go
    [JS.replaceAll(/\{end:[adip]>0\?`owed`:`floor`,/g, "{end:`floor`,"), [10, 21]],
    [JS.replace("nE=sd+BigInt(14e5)*ad/1000000n", "nE=sd"), 0],
    // the compute units a constant of their own: only 14e5 is the cap's
    [JS.replace("nE=sd+BigInt(14e5)*ad/1000000n", "RD=15e5,nE=sd+BigInt(RD)*ad/1000000n"), 0],
    [JS.replace("nE=sd+BigInt(14e5)*ad/1000000n", "nE=sd+BigInt(RD)*ad/1000000n"), 0],
    [JS.replace("ad=1000000n", "ad=2000000n"), 0],
    [JS.replace("sd=5000n", "sd=0n"), 0],
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
    [JS.replace("if(!t.buy&&t.bare!==!0)return g(`holds`", "if(!t.buy&&[...c.holdings.tokens].length>0)return g(`holds`"), 25],
    [JS.replace("t.unproven!==`again`", "!0"), 25],
    [JS.replace("return await e.bought?.put(P.address,{mint:C.mint,program:C.tokenProgram}),await QP(", "return await QP("), 25],
    [JS.replace("return Object.hasOwn(r,n)?r[n]:void 0}", "return void 0}"), 25],
    [JS.replace("seed64:e.seed64,bought:KR(e.store),send:", "seed64:e.seed64,send:"), 25],
    [JS.replace("owed:GR(e.store),bought:KR(e.store),buyNone:", "owed:GR(e.store),buyNone:"), 25],
    [JS.replace("seed64:e.seed64,bought:KR(e.store),send:", "seed64:e.seed64,bought:YR(e.store),send:"), 25],
    [JS.replace("#${o}#1#", "#1#"), 11],
    [JS.replace("try{return[e.address,...tp(e.address,e.mints)]}", "try{return[e.address]}"), 11],
    [JS.replace("n===`nothing`)return await Promise", "n!==`floor`)return await Promise"), [12, 27]],
    // the tail's record (card pool-amounts-are-standard-sizes): written at the floor, deleted on an empty read or a sweep
    [JS.replace("amount:i.lamports.toString()}", "amount:`0`}"), 27],
    [JS.replace(":(n===`nothing`||n===`sent`||", ":(n===`nothing`||"), 27],
    [JS.replace("i.lamports!==void 0&&i.lamports>0n?", "i.lamports!==void 0?"), 27],
    [JS.replace("var RZ=e=>`w-tail/sol/${e}`", "var RZ=e=>`w-tail/solana/${e}`"), 27],
    [JS.replace("await n.delete?.(`meta`,RZ(t))", "await n.put(`meta`,RZ(t),null)"), 27],
    [JS.replace("l:t.l,j:t.j,amount:t.amount", "l:t.l,amount:t.amount"), 27],
    [JS.replace("return await Promise.resolve(e.owed?.markEmpty?.(t.address)).catch(()=>{}),await e.owed?.drop", "return await e.owed?.drop"), 12],
    [JS.replace(",...i.buy===void 0?{}:{buy:i.buy}", ""), 12],
    // card buy-spends-several-pieces: a found W (no buy recorded, `found` in its owed record) is swept only when both
    // RPCs read it owning no token account of either program (a zero-balance one included) and past its latest
    // transaction's height + 151 at finalized, the same latest transaction on both, read again before the send
    [JS.replace("if(!t.buy&&t.bare!==!0)return g(`holds`", "if(!t.buy&&t.bare===void 0)return g(`holds`"), 25],
    [JS.replace("return(await Promise.all(e.flatMap(e=>[dc,fc]", "return(await Promise.all(e.slice(0,1).flatMap(e=>[dc,fc]"), 26],
    [JS.replace("_K=(e,t)=>Promise.all([t(e[0]),t(e[1])])", "_K=(e,t)=>Promise.all([t(e[0]),t(e[0])])"), 26],
    [JS.replace("&&e.value.length===0)}", "&&e.value.every(e=>e.account.lamports===0))}"), 26],
    [JS.replace("[dc,fc].map(n=>e(`getTokenAccountsByOwner`", "[dc].map(n=>e(`getTokenAccountsByOwner`"), 26],
    [JS.replace("e>r[0]+Tq)?n.signature:null", "e>r[0])?n.signature:null"), 26],
    [JS.replace("var Tq=151,", "var Tq=150,"), 26],
    // the getBlock config, whole (the helper forwards exactly this one): each field changed, one dropped, not frozen
    [JS.replace("transactionDetails:`none`,rewards:!1", "transactionDetails:`full`,rewards:!1"), 26],
    [JS.replace("transactionDetails:`none`,rewards:!1", "transactionDetails:`none`,rewards:!0"), 26],
    [JS.replace("{commitment:`finalized`,encoding:`json`,transactionDetails", "{commitment:`confirmed`,encoding:`json`,transactionDetails"), 26],
    [JS.replace(",maxSupportedTransactionVersion:0});", "});"), 26],
    [JS.replace("iu=Object.freeze({commitment", "iu=({commitment"), 26],
    [JS.replace(".every(e=>Number.isSafeInteger(e)&&e>r[0]+Tq)", ".some(e=>Number.isSafeInteger(e)&&e>r[0]+Tq)"), 26],
    [JS.replace("n[0]&&n[1]&&n[0].signature===n[1].signature&&n[0].slot===n[1].slot?n[0]:null", "n[0]&&n[1]?n[0]:null"), 26],
    [JS.replace("n[0]&&n[1]&&n[0].signature===n[1].signature&&n[0].slot===n[1].slot?n[0]:null", "n[0]??null"), 26],
    [JS.replace("||r[0]!==r[1]?null:", "?null:"), 26],
    [JS.replace("[n.slot,iu]", "[n.slot,{...iu,commitment:`confirmed`}]"), 26],
    [JS.replace("[{commitment:`finalized`}]", "[{commitment:`confirmed`}]"), 26],
    // nothing signed for a found W, a close included, before the rule's time part (review P3-5 of c7b85ba3a); the
    // sweep reads W owning no token account and its history since that transaction holding only the teardown's frames
    [JS.replace(",e=t.bare===!0?await wq(", ",e=t.bare===!1?await wq("), 26],
    [JS.replace("if(e===null)return{young:ww||", "if(e===void 0)return{young:ww||"), 26],
    [JS.replace("if(n===null)return{young:ww,", "if(!1)return{young:ww,"), 26],
    [JS.replace("return e!==void 0&&await Dq(s,c.address).catch(()=>null)!==e?{young:`a transaction landed on W since the rule's read`,keep:[],signed:[],last:0,unclaimed:void 0,since:void 0}:{keep:", "return{keep:"), 26],
    [JS.replace("if(h.ok.young!==void 0)return g(", "if(!1)return g("), 26],
    [JS.replace("if(d.close.length===0)return{keep:d.keep,signed:[],last:0,unclaimed:void 0,since:e}", "if(d.close.length===0)return{keep:d.keep,signed:[],last:0,unclaimed:void 0,since:void 0}"), 26],
    [JS.replace("unclaimed:p.reads.unclaimed,since:e}", "unclaimed:p.reads.unclaimed,since:void 0}"), 26],
    [JS.replace("if(ru!==!0)return{end:`holds`", "if(!1)return{end:`holds`"), 26],
    [JS.replace("S=new Set(h.ok.signed.map(e=>e.signature))", "S=new Set(h.ok.signed.map(e=>e.wire))"), 26],
    [JS.replace("return x!==void 0&&!await kq(s,c.address,x,S).catch(()=>!1)?{end:`holds`,steady:!1,detail:`a found W: a transaction landed on W after the rule's read`}:", "return"), 26],
    [JS.replace("{until:n,limit:r.size+1,", "{limit:r.size+1,"), 26],
    [JS.replace("e.length<=r.size&&", ""), 26],
    [JS.replace("&&r.has(e.signature)", ""), 26],
    [JS.replace("return await Mq(z1,t)&&await kq(e,t,n,r)", "return await kq(e,t,n,r)"), 26],
    // card found-wallet-sweep-reads-on-a-pair-that-answers: a found W's token accounts on the host's token pair (the
    // page's public seat answers no getTokenAccountsByOwner), each read's fault named in why W holds
    [JS.replace(";let tk=e.tokenRpcs??s;", ";let tk=s;"), 26],
    [JS.replace("await jq(tk,c.address).catch(t=>(ww=", "await jq(s,c.address).catch(t=>(ww="), 26],
    [JS.replace("await jq(tk,c.address).catch(e=>(wy=", "await jq(s,c.address).catch(e=>(wy="), 26],
    [JS.replace("await Oq(tk,s,c.address,x,S)", "await Oq(s,s,c.address,x,S)"), 26],
    [JS.replace("return await Mq(z1,t)&&", "return await Mq(e,t)&&"), 26],
    [JS.replace("await jq(tk,c.address).catch(t=>(ww=`its token accounts not read alike on both RPCs (${fq(t)})`,null))", "await jq(tk,c.address).catch(()=>null)"), 26],
    [JS.replace("if(h.ok.young!==void 0)return g(`holds`,`a found W: ${h.ok.young}`,!1);", "if(h.ok.young!==void 0)return g(`holds`,`a found W`,!1);"), 26],
    // every token account both RPCs list W owning, both programs, the same sorted list, each an address, 16 a pass, read
    // into the teardown's plan and its simulations and again into the sweep's (review P2 of c7b85ba3a)
    [JS.replace("return n[0].slice(0,16)}", "return n[0].slice(0,17)}"), 26],
    [JS.replace("if(n[0].join(`,`)!==n[1].join(`,`))throw Error(", "if(!1)throw Error("), 26],
    [JS.replace("for(let r of[dc,fc]){let i=await e(`getTokenAccountsByOwner`", "for(let r of[dc]){let i=await e(`getTokenAccountsByOwner`"), 26],
    [JS.replace("||!Aq(t))throw", ")throw"), 26],
    [JS.replace("if(e.length<32||e.length>44)return!1;", ""), 26],
    [JS.replace("let r=await a(void 0,n);", "let r=await a(void 0,[]);"), 26],
    [JS.replace("let r=await a(b,n);", "let r=await a(b,[]);"), 26],
    [JS.replace("let a=n(i),o=new Map;", "let a=n([]),o=new Map;"), 26],
    [JS.replace("[...new Set([...Yl(c.address,t.mints),...e])]", "[...Yl(c.address,t.mints)]"), 26],
    [JS.replace("nd(e,n.wire,c.address,u)", "nd(e,n.wire,c.address,Yl(c.address,t.mints))"), 26],
    
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
    [JS.replace("steady:I<w,detail", "steady:M<w,detail"), 21],
    [JS.replace("I=lj(N,Q).value", "I=lj(M,Q).value"), 21],
    [JS.replace("-cj(l,p,h),N=", "-cj(l,p),N="), 21],
    [JS.replace("S.end===`floor`&&S.steady", "S.end===`floor`"), 21],
    [JS.replace("I||(be.mints=iz((await Promise.resolve(e.owed?.list()).then(e=>e?.find(e=>e.address===f.address),()=>void 0))?.mints,be.mints),await e.owed?.put(be)", "I||(await e.owed?.put(be)"), 22],
    [JS.replace("return{end:`refused`,detail:n.why};let a=IY", "return{end:`gave_up`,detail:n.why};let a=IY"), 23],
    [JS.replace("for(let n=0;n<30&&(n===0||f()<p);n++){n>0&&await u(lR);", "for(let n=0;n<30&&(n===0||f()<p);n++){n>0&&await t.wait(lR);"), 24],
    [JS.replace("e++){e>0&&await u(lR);for", "e++){e>0&&await t.wait(lR);for"), 24],
  ];
  for (const [js, i] of planted) {
    assert.notEqual(js, JS, "each plant changes the line");
    const c = facts("", js).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [i].flat().map((n) => Object.keys(MARKS)[n]), js.slice(0, 80));
  }
});

// card round-trip-costs-less (the review of 024e8a89d): four marks read the rent back as that card now spells it (the
// batched read gives W's lamports beside what W read as; the read lists a found W; the passes are counted and each
// W's record is read again inside its locks; the full sell's record
// stamps W's own send), as lines of that card's build of public/app.js (sol-w-sweep.rtcl.excerpt.txt): each holds, and
// each rule broken in place FAILs its own mark alone; the floor end's mark is card pool-amounts-are-standard-sizes's
// shape since, held by the test above
test("the rent back as card round-trip-costs-less spells it: each mark holds, each break of it FAILs that mark alone", () => {
  const ex = readFileSync(new URL("./sol-w-sweep.rtcl.excerpt.txt", import.meta.url), "utf8");
  const pick = (p) => Object.keys(MARKS).find((k) => k.startsWith(p));
  const keys = ["a load that reads W", "the only empty end", "a load whose own reads fail", "a full sell's record"].map(pick);
  assert.deepEqual(keys.map((k) => facts("", ex).carries[k]), keys.map(() => true));
  const planted = [
    ["#${o}#1#${mJ(e.evidence)}", "#${o}#1#", 0],
    ["for(let t=0;t<r.length;t+=hJ)", "for(let t=0;t<r.length;t+=1e3)", 0],
    ["if((t.buy||S!==void 0)&&t.read?.(h),h===0n)", "if((t.buy||S!==void 0)&&t.read?.(h),h===1n)", 1],
    ["if(f!==p)throw Error", "if(!1)throw Error", 1],
    ["m=async()=>(await e.owed.list()).find(e=>e.address===l)", "m=async()=>n.find(e=>e.address===l)", 2],
    ["let n=await m()", "let n=h", 2],
    ["Xe.mints=UJ(t?.mints,Xe.mints)", "Xe.mints=Xe.mints", 3],
  ];
  for (const [from, to, i] of planted) {
    assert.equal(ex.split(from).length, 2, `once: ${from}`);
    const c = facts("", ex.replace(from, to)).carries;
    assert.deepEqual(keys.filter((k) => !c[k]), [keys[i]], `${from} -> ${to}`);
  }
});
