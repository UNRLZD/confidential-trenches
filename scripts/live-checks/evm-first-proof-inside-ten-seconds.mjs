#!/usr/bin/env node
// Live check of card evm-first-proof-inside-ten-seconds: money deposited into the Base or Robinhood pool from SIGN_HOST
// (https://confidential.unrealized.trade) has its first proof ready inside 10 s of the deposit's block, because the one
// queue pass the device's own landing starts reads as that deposit's last step, and the pool's history is read before
// the landing. The times are the mainnet copies' (packages/signpage/scripts/pool-fork-evm-carry-withdraw.mjs, its
// "first leaf" step: readyMsAfterDeposit, hostWindowMax, deployPages); this check holds that SIGN_HOST serves the code
// those copies ran. It passes only when SIGN_HOST's served /app.js is the one its index.html pins (its sha384), and in
// it, as minified, each exactly once and bound to one another:
//   - landed (packages/signpage/src/pool-testnet.ts evmLanded, the one landing hook of the deposit host and the carry's):
//     the notes one round claims start one pass in a tick (queueMicrotask), and that pass is asked as the landing's
//     (evmProofs(chain, true)); every EVM landed is that hook, and nothing else asks a landing's pass;
//   - proofs (evmProofs): only a landing's pass hands the queue a signal from `landing`, every other pass none;
//   - lanes (openEvmQueue): the queue's pool reads its time, trees and binding on the deposit's own pool (the chain's
//     pair, the trade lane) only for a signal `landing` made (a WeakSet), and on the pass pool (the pass pair and its
//     budget) for every other; the deposit's pool is built on the chain's own pair, the pass pool on the pass pair;
//   - warm (evmWarm): the first time the page is asked for a chain's pool (evmPoolOf: a quote's floor, its follow, a
//     restore), the pass sync reads the pool's history once into the page's hold, asked again only after a failure;
//   - wait (evmWarmWait): the deposit's round waits for that read before its own, at most EVM_WARM_WAIT_MS (20 s), and
//     asks a failed one again once; after a second failure in a row it reads as before. The wait ends at the round's
//     signal, else the page's reads' stop taken at the call (a sign out), asks nothing once that fired, and the round
//     then throws instead of reading; once the read held, a round waits on nothing.
// What each part does is held by the signing page's tests (test/evm-landing-pass-trade.test.ts,
// test/pool-deposit-evm.test.ts) and the wallet's (test/pool-evm-reads-once.test.ts).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/evm-first-proof-inside-ten-seconds.mjs [--local] [--record <file>]
//   PASS exit 0, FAIL 1, error 2. --local judges this tree's SIGN_HOST build (signBuilt) in SIGN_HOST's place; --record
//   writes what the run read, which evm-first-proof-inside-ten-seconds.test.mjs replays. Reads only.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

export const KEY = "evm-first-proof-inside-ten-seconds";
export const SIGN = "https://confidential.unrealized.trade";

const N = "[\\w$]+";
const esc = (s) => s.replace(/[$]/g, "\\$");
const count = (re, js) => [...js.matchAll(new RegExp(re.source, "g"))].length;
const once = (re, js) => count(re, js) === 1;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** evmLanded, a chain's one landing hook: `L=e=>()=>{R.has(e)||(R.add(e),queueMicrotask(()=>{R.delete(e),F(e,!0)}))}`
 *  (group 1 L, group 4 F, evmProofs), each EVM host's landed `landed:L(t)`. */
const LANDED = new RegExp(`[,;{ ](${N})=(${N})=>\\(\\)=>\\{(${N})\\.has\\(\\2\\)\\|\\|\\(\\3\\.add\\(\\2\\),queueMicrotask\\(\\(\\)=>\\{\\3\\.delete\\(\\2\\),(${N})\\(\\2,!0\\)\\}\\)\\)\\}`);
const LANDED_USE = (l) => new RegExp(`landed:${esc(l)}\\(${N}\\)`);
/** A landing's pass asked anywhere (evmProofs with `!0`): evmLanded's alone may ask one, so a second hook (an inline copy
 *  of it, a pass asked as the landing's elsewhere) fails. */
const LANDING_ASK = (f) => new RegExp(`[^\\w$.]${esc(f)}\\(${N},!0\\)`);
/** Any landed of an EVM kind that starts a pass some other way (the shape before this card: `landed:()=>void F(t)`). */
const LANDED_ANY = new RegExp(`landed:\\(\\)=>void ${N}\\(${N}\\)`);
/** evmProofs: `F=async(e,t=!1)=>{...let r=await n,i=await r.queue.refresh(t?r.landing?.():void 0);`. */
const PROOFS = (f) => new RegExp(`[,;{ ]${esc(f)}=async\\((${N}),(${N})=!1\\)=>\\{if\\(${N}\\(\\1\\)===null\\)return null;let (${N})=${N}\\.get\\(\\1\\);\\3===void 0&&${N}\\.set\\(\\1,\\3=${N}\\(\\1\\)\\);try\\{let (${N})=await \\3,${N}=await \\4\\.queue\\.refresh\\(\\2\\?\\4\\.landing\\?\\.\\(\\):void 0\\);`);
/** evmProofs as card a-load-proves-first-and-walks-the-restore-once wraps it: `F=(e,t=!1)=>X(e,G(e,t))` (firstOf, which
 *  only notes the chain's first pass, around evmQueuePass), the landing flag passed through unchanged; G is then PROOFS. */
const WRAPPED = (f) => new RegExp(`[,;{ ]${esc(f)}=\\((${N}),(${N})=!1\\)=>${N}\\(\\1,(${N})\\(\\1,\\2\\)\\)`);
const proofsOf = (f, js) => once(PROOFS(f), js) || (once(WRAPPED(f), js) && once(PROOFS(WRAPPED(f).exec(js)[3]), js));
/** Every call of a passed queue's refresh with an argument (the landing's alone may pass one). */
const REFRESH_ARG = new RegExp(`\\.queue\\.refresh\\([^)]`, "g");
/** openEvmQueue's two pools, the landing set and the routed pool:
 *  `o=t.evmQueuePool?.(n)??kT({pin:r.pin,rpcs:r.passRpcs,feeRpcs:y0(n,`pass`),...` (the pass pool), then
 *  `l=s?.trade??(t.evmQueuePool?null:kT({pin:r.pin,rpcs:r.rpcs,feeRpcs:y0(n),...` (the deposit's),
 *  `u=new WeakSet,f=e=>e!==void 0&&l!==null&&u.has(e),` and `{...c,now:e=>f(e)?l.now(e):p(e),trees:(e,t,n)=>(f(t)?l:c)
 *  .trees(e,t,n),bind:(e,t)=>(f(t)?l:c).bind(e,t)}`, and `g=()=>{let e=new AbortController;return u.add(e.signal),e.signal}`
 *  handed out as the queue's `landing`. */
const PASS_POOL = new RegExp(`[,;{ ](${N})=${N}\\.evmQueuePool\\?\\.\\((${N})\\)\\?\\?(${N})\\(\\{pin:(${N})\\.pin,rpcs:\\4\\.passRpcs,feeRpcs:(${N})\\(\\2,\`pass\`\\),`);
const TRADE_POOL = (make, r, n, fee) => new RegExp(`[,;{ ](${N})=${N}\\?\\.trade\\?\\?\\(${N}\\.evmQueuePool\\?null:${esc(make)}\\(\\{pin:${esc(r)}\\.pin,rpcs:${esc(r)}\\.rpcs,feeRpcs:${esc(fee)}\\(${esc(n)}\\),`);
const ROUTED = (l) => new RegExp(`(${N})=new WeakSet,(${N})=(${N})=>\\3!==void 0&&${esc(l)}!==null&&\\1\\.has\\(\\3\\),`);
const ROUTED_POOL = (l, on) =>
  new RegExp(`\\{\\.\\.\\.(${N}),now:(${N})=>${esc(on)}\\(\\2\\)\\?${esc(l)}\\.now\\(\\2\\):${N}\\(\\2\\),trees:\\((${N}),(${N}),(${N})\\)=>\\(${esc(on)}\\(\\4\\)\\?${esc(l)}:\\1\\)\\.trees\\(\\3,\\4,\\5\\),bind:\\((${N}),(${N})\\)=>\\(${esc(on)}\\(\\7\\)\\?${esc(l)}:\\1\\)\\.bind\\(\\6,\\7\\)\\}`);
const LANDING = (set) => new RegExp(`[,;{ ](${N})=\\(\\)=>\\{let (${N})=new AbortController;return ${esc(set)}\\.add\\(\\2\\.signal\\),\\2\\.signal\\}`);
const HANDED = (l, g) => new RegExp(`\\.\\.\\.${esc(l)}===null\\?\\{\\}:\\{landing:${esc(g)}\\}`);
/** evmWarm and evmPoolOf: `ne=e=>{let t=M(e);if(t===null)return null;let n=R.get(e);if(n===void 0){let r=xe.signal,i=
 *  t.passSync.events(r).then(()=>(!r.aborted&&R.get(e)===i&&(te.delete(e),ee.add(e)),!0),()=>(R.get(e)===i&&(R.delete(e),
 *  r.aborted||te.set(e,(te.get(e)??0)+1)),!1));R.set(e,n=i)}return n}` (an answer after its session's sign out kept by
 *  neither; a failure always leaves the map, counted only while the session is live: delta review of 679ec10f7) and
 *  `evmPoolOf:e=>(t=>t===null?null:(ne(e),{pin:t.pin,rpcs:t.rpcs}))(M(e))`. */
const WARM = new RegExp(
  `[,;{ ](${N})=(${N})=>\\{let (${N})=(${N})\\(\\2\\);if\\(\\3===null\\)return null;let (${N})=(${N})\\.get\\(\\2\\);if\\(\\5===void 0\\)\\{let (${N})=${N}\\.signal,(${N})=\\3\\.passSync\\.events\\(\\7\\)\\.then\\(\\(\\)=>\\(!\\7\\.aborted&&\\6\\.get\\(\\2\\)===\\8&&\\((${N})\\.delete\\(\\2\\),(${N})\\.add\\(\\2\\)\\),!0\\),\\(\\)=>\\(\\6\\.get\\(\\2\\)===\\8&&\\(\\6\\.delete\\(\\2\\),\\7\\.aborted\\|\\|\\9\\.set\\(\\2,\\(\\9\\.get\\(\\2\\)\\?\\?0\\)\\+1\\)\\),!1\\)\\);\\6\\.set\\(\\2,\\5=\\8\\)\\}return \\5\\}`,
);
/** evmWarmWait, bound to that read: `ie=async(e,t)=>{let n=M(e);if(n===null||n.passSync===n.sync||ee.has(e))return;let r=
 *  Date.now()+re;for(let n=0;n<3&&!t.aborted;n++){let n=R.get(e)??((te.get(e)??0)<2?ne(e):null),i=r-Date.now();if(n===null
 *  ||i<=0)return;`, its bound `re=t.evmWarmWaitMs??2e4` (EVM_WARM_WAIT_MS), and the deposit's round behind it, on its
 *  signal and the reads' stop taken at the call (whichever fires first, eitherStop), thrown once that fired, read on that
 *  stop, and its pool marked read for the session once it read (review of 584af1495, P2-1 and P3-1):
 *  `round:t.evmRound?t.evmRound(n,i,r):(t=>async n=>{let r=xe.signal,{stop:i,off:a}=Y2(n,r);try{await ie(e,i),i.
 *  throwIfAborted();let n=await t(i);return r.aborted||ee.add(e),n}finally{a()}})(A(a))`, and eitherStop itself:
 *  `function Y2(e,t){if(e===void 0)return{stop:t,off:()=>{}};let n=new AbortController,r=()=>n.abort(e.aborted?e.reason:
 *  t.reason);return e.aborted||t.aborted?(r(),{stop:n.signal,off:()=>{}}):(e.addEventListener(`abort`,r,{once:!0}),t.
 *  addEventListener(`abort`,r,{once:!0}),{stop:n.signal,off:()=>(e.removeEventListener(`abort`,r),t.removeEventListener(
 *  `abort`,r))})}`. */
const WAIT = (warm, pool, reads, fails, warmed) =>
  new RegExp(`[,;{ ](${N})=async\\((${N}),(${N})\\)=>\\{let (${N})=${esc(pool)}\\(\\2\\);if\\(\\4===null\\|\\|\\4\\.passSync===\\4\\.sync\\|\\|${esc(warmed)}\\.has\\(\\2\\)\\)return;let (${N})=Date\\.now\\(\\)\\+(${N});for\\(let (${N})=0;\\7<3&&!\\3\\.aborted;\\7\\+\\+\\)\\{let (${N})=${esc(reads)}\\.get\\(\\2\\)\\?\\?\\(\\(${esc(fails)}\\.get\\(\\2\\)\\?\\?0\\)<2\\?${esc(warm)}\\(\\2\\):null\\),(${N})=\\5-Date\\.now\\(\\);if\\(\\8===null\\|\\|\\9<=0\\)return;`);
const BOUND = (b) => new RegExp(`[,;{ ]${esc(b)}=${N}\\.evmWarmWaitMs\\?\\?2e4[,;]`);
const BEHIND = (wait, warmed) => new RegExp(`round:(${N})\\.evmRound\\?\\1\\.evmRound\\(${N},${N},${N}\\):\\((${N})=>async (${N})=>\\{let (${N})=${N}\\.signal,\\{stop:(${N}),off:(${N})\\}=(${N})\\(\\3,\\4\\);try\\{await ${esc(wait)}\\(${N},\\5\\),\\5\\.throwIfAborted\\(\\);let (${N})=await \\2\\(\\5\\);return \\4\\.aborted\\|\\|${esc(warmed)}\\.add\\(${N}\\),\\8\\}finally\\{\\6\\(\\)\\}\\}\\)\\(${N}\\(${N}\\)\\)`);
const EITHER = (f) => new RegExp(`function ${esc(f)}\\((${N}),(${N})\\)\\{if\\(\\1===void 0\\)return\\{stop:\\2,off:\\(\\)=>\\{\\}\\};let (${N})=new AbortController,(${N})=\\(\\)=>\\3\\.abort\\(\\1\\.aborted\\?\\1\\.reason:\\2\\.reason\\);return \\1\\.aborted\\|\\|\\2\\.aborted\\?\\(\\4\\(\\),\\{stop:\\3\\.signal,off:\\(\\)=>\\{\\}\\}\\):\\(\\1\\.addEventListener\\(\`abort\`,\\4,\\{once:!0\\}\\),\\2\\.addEventListener\\(\`abort\`,\\4,\\{once:!0\\}\\),\\{stop:\\3\\.signal,off:\\(\\)=>\\(\\1\\.removeEventListener\\(\`abort\`,\\4\\),\\2\\.removeEventListener\\(\`abort\`,\\4\\)\\)\\}\\)\\}`);
// the warm read first, then (card evm-landing-reads-batched) the deposit's sight, which holds the period's fee
const POOL_OF = (warm, pool) => new RegExp(`evmPoolOf:(${N})=>\\((${N})=>\\2===null\\?null:\\(${esc(warm)}\\(\\1\\),(?:${N}\\(\\1\\),)?\\{pin:\\2\\.pin,rpcs:\\2\\.rpcs\\}\\)\\)\\(${esc(pool)}\\(\\1\\)\\)`);

/** What the check keeps of SIGN_HOST's build: its pin and sha384, and each part found exactly once and bound. */
export function pageFacts(index, js) {
  const landed = once(LANDED, js) ? LANDED.exec(js) : null;
  const proofs = landed !== null && proofsOf(landed[4], js);
  const pass = once(PASS_POOL, js) ? PASS_POOL.exec(js) : null;
  const trade = pass !== null && once(TRADE_POOL(pass[3], pass[4], pass[2], pass[5]), js) ? TRADE_POOL(pass[3], pass[4], pass[2], pass[5]).exec(js) : null;
  const routed = trade !== null && once(ROUTED(trade[1]), js) ? ROUTED(trade[1]).exec(js) : null;
  const landing = routed !== null && once(LANDING(routed[1]), js) ? LANDING(routed[1]).exec(js) : null;
  const warm = once(WARM, js) ? WARM.exec(js) : null;
  return {
    pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null,
    sha384: sha384(js),
    landed: landed !== null && count(LANDED_USE(landed[1]), js) >= 1 && count(LANDED_ANY, js) === 0 && once(LANDING_ASK(landed[4]), js),
    proofs: proofs && [...js.matchAll(REFRESH_ARG)].length === 1,
    lanes: routed !== null && once(ROUTED_POOL(trade[1], routed[2]), js) && landing !== null && once(HANDED(trade[1], landing[1]), js),
    warm: warm !== null && once(POOL_OF(warm[1], warm[4]), js),
    wait: ((w) => {
      if (w === null || !once(BOUND(w[6]), js) || !once(BEHIND(w[1], warm[10]), js)) return false;
      const either = BEHIND(w[1], warm[10]).exec(js)[7];
      return once(EITHER(either), js);
    })(warm !== null && once(WAIT(warm[1], warm[4], warm[6], warm[9], warm[10]), js) ? WAIT(warm[1], warm[4], warm[6], warm[9], warm[10]).exec(js) : null),
  };
}

/** SIGN_HOST's index and /app.js through `fetchFn` (bundle-checks: the build, as the host serves it): { from, page }. */
export async function readBundle(fetchFn = fetch) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`SIGN_HOST ${p}: HTTP ${r.status}`);
    return r.text();
  };
  return { from: SIGN, page: pageFacts(await get("/"), await get("/app.js")) };
}

/** The verdict on { page }: { ok, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const p = run?.page;
  say(typeof p?.pin === "string" && p.pin === p.sha384, `[SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`);
  say(p?.landed === true, "[SIGN_HOST] a Base or Robinhood landing starts one pass a tick, asked as the landing's, and no landing starts one any other way (landed)");
  say(p?.proofs === true, "[SIGN_HOST] only the landing's pass hands the queue the landing's signal (proofs)");
  say(p?.lanes === true, "[SIGN_HOST] the queue reads its time, trees and binding on the deposit's pair only for that signal, on the pass pair for every other (lanes)");
  say(p?.warm === true, "[SIGN_HOST] the pool's history is read once on the pass sync when the page is first asked for the pool (warm)");
  say(p?.wait === true, "[SIGN_HOST] the deposit's round waits for that read, at most 20 s and past two failures in a row none, before its own (wait)");
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** SIGN_HOST's index and /app.js, or this tree's build with `local`. */
export async function read(fetchFn = fetch, { local = false } = {}) {
  const page = local ? pageFacts(readFileSync(path.join(signBuilt(), "index.html"), "utf8"), readFileSync(path.join(signBuilt(), "public/app.js"), "utf8")) : (await readBundle(fetchFn)).page;
  return { readAt: new Date().toISOString(), from: local ? "local build" : SIGN, page };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = await read(fetch, { local: a.includes("--local") });
    if (a.includes("--record")) writeFileSync(a[a.indexOf("--record") + 1], `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(verdict === "PASS" ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
