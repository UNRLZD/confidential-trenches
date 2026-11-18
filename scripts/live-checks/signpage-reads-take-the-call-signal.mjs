#!/usr/bin/env node
// Live check of card signpage-reads-take-the-call-signal on SIGN_HOST (https://confidential.unrealized.trade): a read
// the signing page stops waiting for (a fee walk's cut, a sign out, a bound) ends its request at the provider, so a
// hung provider never holds a host's slot or its pace token. What it holds, and only that: the served /app.js is the
// one index.html pins (its sha384), and in it, as minified, each of the page's RPC wrappers hands the call's signal on:
//   - laned: lanedRpc (page-rpc.ts) joins the call's signal to the reader's and the page's gate, and its one attempt
//     hands that stop to the kit client (solanaJsonRpc), whose fetch it ends;
//   - seat: seatRpc hands it to the member it asks, and a stop is no member's fault: no failover after it;
//   - watch: readWatch (a reference's read, a finder's scan) hands it to the provider it watches;
//   - kept, young: read-waits.ts keptReads and youngReads (a read no leg shares) hand it on;
//   - switched: pool-testnet.ts kindSwitched hands it to the kind's seat at each call;
//   - routes: pageEvmWalletRpc and pageEvmShownRpc hand it to the helper's route;
//   - trade: trade.ts's watched providers hand it on;
//   - gated: positions-evm.ts's gate ends each call at the pass's stop or the call's own;
//   - decimals: keptTokenDecimals (PoolRpc) hands its read's signal to both providers;
//   - fill: the trade fill's reader ends each read at the sign out's stop or the call's own;
//   - dry: the sale preview's bound aborts the reads it still holds;
//   - timed: the pool buy's timed slot read hands it on.
// What each does is held by packages/signpage/test/reads-take-the-call-signal.test.ts, positions-evm.test.ts and
// pool-sell-dry.test.ts ("card signpage-reads-take-the-call-signal"); the recorded answers are facts() over each
// tree's packages/signpage/index.html and public/app.js (this file reaches no package code: the import check holds it).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/signpage-reads-take-the-call-signal.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signpage-reads-take-the-call-signal";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const Q = "[`\"']";
const N = "[\\w$]+";
const NOFN = "(?:(?!function )[\\s\\S])";
// a minified shape: each @X a name (the first its group, the rest the same name), every other character as it is, a
// quote any of the three
const shape = (src) => {
  const seen = new Set();
  const parts = src.split(/(@[A-Z])/).map((x, i) => {
    if (i % 2 === 0) return x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/`/g, Q);
    const k = x[1];
    if (seen.has(k)) return `\\k<${k}>`;
    seen.add(k);
    return `(?<${k}>${N})`;
  });
  return new RegExp(parts.join(""));
};
const esc = (s) => s.replace(/\$/g, "\\$");

// lanedRpc: its one attempt with the stop in the kit client's call; the ask that sends it hands its own stop; the call
// joins its own signal to the reader's (o.signal) under the page's gate
const ONCE = shape("@O=(@M,@R,@P,@A)=>@F(@U,{...@T.init?{init:@T.init}:{},...@T.fetch?{fetch:@T.fetch}:{},retry:{deadlineMs:@M,backoffMs:@M}})(@R,@P,@A)");
const ASK = (once) => new RegExp(`=async\\((${N}),(${N}),(${N}),(${N})\\)=>\\{\\2\\.throwIfAborted\\(\\);${NOFN}{0,300}?let ${N}=await ${esc(once)}\\(Math\\.max\\(1,Math\\.floor\\(\\1-performance\\.now\\(\\)\\)\\),\\3,\\4,\\2\\);`);
const CALL = shape("(@E,@R,@I)=>{let @O=@G(@I===void 0?@T.signal:@T.signal===void 0?@I:AbortSignal.any([@T.signal,@I]));return @O.aborted?Promise.reject(@O.reason):");
const SEAT = shape(
  "return @S.length===1?@M[@L].last(@E,@N,@O):@M[@L].fast(@E,@N,@O).catch(@T=>{if(!(@T instanceof @X)||@O?.aborted)throw @T;return @A(@E,@N,new Set([...@I,@L]),@O)})};return Object.assign((@P,@Q,@R)=>@A(@P,@Q,new Set,@R),{url:",
);
const WATCH = shape("watch:(@E,@C=(@T,@N,@R)=>@E(@T,@N,@R))=>{let @I=@E.url===void 0?`a provider`:new URL(@E.url).host;return @W(@E,async(@M,@A,@O)=>{@F.set(@I,(@F.get(@I)??0)+1);try{return await @C(@M,@A,@O)}");
const KEPT = shape("new Map;return @W(@E,(@R,@I,@A)=>{if(!@T(@R,@I))return @E(@R,@I,@A);let @O=`${@R} ${JSON.stringify(@I)}`;return @N.has(@O)?Promise.resolve(@N.get(@O)):@E(@R,@I,@A).then(");
const YOUNG = shape("return @P.push(@A),@W(@E,(@I,@O,@S)=>{if(!@T(@I,@O))return @E(@I,@O,@S);let @C=`${@I} ${JSON.stringify(@O)}`");
const SWITCHED = shape("[0,1].map(@N=>@W(@E.trade[@N],(@R,@I,@A)=>@E[@T()][@N](@R,@I,@A)))");
const ROUTE = shape("Object.assign((@E,@N,@R)=>@T(@E,@N,@R),{url:`${@H}/v1/rpc/${@C}`})");
const TRADE = shape("=@E=>@W(@E,(@T,@N,@R)=>@E(@T,@N,@R).catch(@Y))");
const GATED = shape("async(@R,@I,@A)=>{for(;@G.busy>=@G.n;)await new Promise(@E=>@G.queue.push(@E));@S.aborted&&(@G.queue.shift()?.(),@S.throwIfAborted()),@G.busy++;try{return await @F(@R,@I,@A===void 0?@S:AbortSignal.any([@A,@S]))}");
const DECIMALS = shape("@S=@N=>@E===`solana`?@N(`getAccountInfo`,[@T,{encoding:`base64`,commitment:`confirmed`}],@R.signal):@N(`eth_call`,[{to:@T,data:@D},`latest`],@R.signal)");
const FILL = shape("@A=(@E,@T,@N)=>(@R.throwIfAborted(),@I(@E,@T,@N===void 0?@R:AbortSignal.any([@N,@R])))");
const DRY = shape(
  "@G=new AbortController,@U=@B.map((@E,@T)=>@W(@E,(@R,@I,@A)=>(@C.calls[@T].push(@K()),@E(@R,@I,@A===void 0?@G.signal:AbortSignal.any([@A,@G.signal])).then(@X=>(@H[@T].set(@P(@R,@I),@X),@X))))),@V,@Y=new Promise(@Z=>@V=setTimeout(()=>(@G.abort(Error(`the preview's bound`)),@Z({error:`busy`})),",
);
const TIMED = shape("[((@M,@Q,@S)=>@H.rpcs[0](@M,@Q,@S).then(@X=>(@F=@C(),@X))),@H.rpcs[1]]");

const count = (re, js) => [...js.matchAll(new RegExp(re.source, "g"))].length;
/** What the check keeps of the reads: the index, the served bundle's sha384, and which wrappers hand the signal on. */
export function facts(index, js) {
  const once = count(ONCE, js) === 1 ? ONCE.exec(js).groups.O : undefined;
  return {
    index,
    sha384: sha384(js),
    laned: !!once && ASK(once).test(js) && CALL.test(js),
    seat: SEAT.test(js),
    watch: WATCH.test(js),
    kept: KEPT.test(js),
    young: YOUNG.test(js),
    switched: SWITCHED.test(js),
    // the wallet route and the shown route, both
    routes: count(ROUTE, js) === 2,
    trade: TRADE.test(js),
    gated: GATED.test(js),
    decimals: DECIMALS.test(js),
    fill: FILL.test(js),
    dry: DRY.test(js),
    timed: TIMED.test(js),
  };
}

const SAY = Object.freeze({
  laned: "the page's RPC client never hands the call's signal to its fetch: a read the page gave up on stays in flight, holding its host's slot and pace token",
  seat: "the page's seat drops the call's signal, or fails over after a stop: the member's request outlives the read",
  watch: "a reference's or scan's watched provider drops the call's signal",
  kept: "the kept reads drop the call's signal",
  young: "the young reads drop the signal of a read no leg shares",
  switched: "a pool buy's switched pair drops the call's signal",
  routes: "the helper's wallet or shown route drops the call's signal",
  trade: "the trade's watched providers drop the call's signal",
  gated: "the positions pass's gate never ends a call in flight at the pass's stop",
  decimals: "the token decimals read drops its signal",
  fill: "the trade fill's reader never ends a read in flight at the sign out",
  dry: "the sale preview's bound leaves its reads in flight at the provider",
  timed: "the pool buy's timed slot read drops the call's signal",
});

/** The verdict on an answer { index, sha384, ...each wrapper's fact }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const [k, m] of Object.entries(SAY)) if (a?.[k] !== true) bad(m);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"));
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
