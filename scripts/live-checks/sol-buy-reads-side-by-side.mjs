#!/usr/bin/env node
// Live check of card sol-buy-reads-side-by-side on SIGN_HOST (https://confidential.unrealized.trade). What it holds,
// and only that: the served /app.js is the one index.html pins (its sha384); and the bundle sends no pool transaction
// (it never names the helper's /v1/pool/solana/send), or, as minified:
//   - the pool's time read for the take (packages/wallet/src/pool/pool.ts chainNow) stamps both of the device's clocks
//     before it asks the pool: `async function RT(e,t){let n=performance.now(),r=Date.now();return{ms:await e.now(t),
//     at:n,wall:r}}`;
//   - the queue's take (packages/wallet/src/pool/queue.ts takeNow) uses that read only while the monotonic time since is
//     0 to 5 s and the wall clock's at most 5 s, as its ms plus the larger of the two, else reads the pool's time:
//     `let e=performance.now()-t.at,n=Date.now()-t.wall;if(e>=0&&e<=5e3&&n<=5e3)return t.ms+BigInt(Math.ceil(Math.max(
//     e,n)))}return r.now()`, and take() awaits it with its third argument;
//   - the buy (packages/signpage/src/pool-buy.ts) starts that read right after its not_funded check, beside its first
//     round, and hands it to the take: `let p=e.chainNow?.();p?.catch(()=>{});` ... `early:p}` ... `e.take(t.noteId,
//     t.attempt,s?.early)`;
//   - the page's buy host (packages/signpage/src/pool-testnet.ts buyHost) passes the take's third argument to the queue
//     and reads the time with that function on the page's pool, or on both of its RPCs: `take:async(e,t,n)=>(await l())
//     .take(e,t,n),chainNow:()=>RT(t.pool??{now:e=>wO(r(),e)})`.
// A read stamped on one clock or after its answer, a bound dropped, the time since dropped or not the larger, a read
// the buy never starts or never hands on, or a host that drops it each FAIL. It reads stretches of the minified
// bundle, so it does not prove the whole rule (what the take's checks then refuse, the review's cases): the wallet's
// test/pool-queue.test.ts, signpage's test/pool-buy.test.ts and test/pool-testnet.test.ts hold those.
// The recorded testnet answers are facts() over packages/signpage/scripts/build-app.mjs --network testnet of each tree
// (this file reaches no package code: the import check holds it).
// After: sign
//   node scripts/live-checks/sol-buy-reads-side-by-side.mjs [--base <url>] [--record <file>] [--answer <file>]
//   (--base: a build's own address, a Pages preview say; SIGN_HOST when absent)
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "sol-buy-reads-side-by-side";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = String.raw`[\w$]+`;
const esc = (s) => s.replace(/\$/g, "\\$");

/** The read for the take: its name (group 1). */
const CLOCK = new RegExp(String.raw`async function (${N})\((${N}),(${N})\)\{let (${N})=performance\.now\(\),(${N})=Date\.now\(\);return\{ms:await \2\.now\(\3\),at:\4,wall:\5\}\}`);
/** The take's time: its name (group 1). */
const NOW = new RegExp(String.raw`let (${N})=async (${N})=>\{let (${N})=await \2\?\.catch\(\(\)=>void 0\);if\(\3!==void 0\)\{let (${N})=performance\.now\(\)-\3\.at,(${N})=Date\.now\(\)-\3\.wall;if\(\4>=0&&\4<=5e3&&\5<=5e3\)return \3\.ms\+BigInt\(Math\.ceil\(Math\.max\(\4,\5\)\)\)\}return ${N}\.now\(\)\}`);
/** The queue's take, its head to its time: the time's function (group 4) called with the third argument. Its fourth and
 *  fifth arguments (a Solana last height, an EVM nullifier: card pool-buy-record-never-stays-sent) are not read here. */
const TAKE = new RegExp(String.raw`take\((${N}),(${N}),(${N})(?:,${N}){0,2}\)\{return ${N}\(\),${N}\(\1,async\(\)=>\{[^{}]*?\{[^{}]*\}[^{}]*?\{[^{}]*\}[^{}]*?let ${N}=await (${N})\(\3\),`);
/** The buy's start of the read (group 1), right after its not_funded check. */
const START = new RegExp(String.raw`return ${N}\(\x60not_funded\x60\);let (${N})=(${N})\.chainNow\?\.\(\);\1\?\.catch\(\(\)=>\{\}\);`);
/** The send's take: the fill's early (group 1). */
const SEND = new RegExp(String.raw`await ${N}\.take\(${N}\.noteId,${N}\.attempt,(${N})\?\.early(?:,BigInt\(${N}\))?\)`);
/** The page's buy host: the take's third argument passed on, and its read (group 4) on the page's pool or its RPCs. */
const HOST = new RegExp(String.raw`take:async\((${N}),(${N}),(${N})(?:,${N})?\)=>(?:\(await ${N}\(\)\)|${N}=await\(await ${N}\(\)\))\.take\(\1,\2,\3(?:,${N})?\),chainNow:\(\)=>(${N})\((${N})\.pool\?\?\{now:(${N})=>${N}\((${N})\(\),\6\)\}\)`);

/** The stretches of the bundle the rule is read in, each its match or null. */
export function facts(index, js) {
  const at = (re) => re.exec(js)?.[0] ?? null;
  const start = START.exec(js);
  // the buy from its start of the read to the send's fill (`early:` and the next `}`)
  const fillAt = start ? js.indexOf("early:", start.index) : -1;
  return {
    index,
    sha384: sha384(js),
    poolSend: js.includes("/v1/pool/solana/send"),
    clock: at(CLOCK),
    now: at(NOW),
    take: at(TAKE),
    buy: start && fillAt > 0 ? js.slice(start.index, js.indexOf("}", fillAt) + 1) : null,
    send: at(SEND),
    host: at(HOST),
  };
}

function problems(a) {
  const out = [];
  const clock = typeof a.clock === "string" ? CLOCK.exec(a.clock)?.[1] : undefined;
  if (clock === undefined) out.push("the bundle's read of the pool's time for the take does not stamp the monotonic and the wall clock before it asks the pool");
  const now = typeof a.now === "string" ? NOW.exec(a.now)?.[1] : undefined;
  if (now === undefined) out.push("the bundle's take does not use an early read as its ms plus the larger of the two clocks' time since, only within 5 s on both, else a read of its own");
  const take = typeof a.take === "string" ? TAKE.exec(a.take)?.[4] : undefined;
  if (now !== undefined && take !== now) out.push("the bundle's take does not time itself with the early read it is handed");
  const start = typeof a.buy === "string" ? START.exec(a.buy)?.[1] : undefined;
  if (start === undefined || !new RegExp(String.raw`early:${esc(start)}\}$`).test(a.buy)) out.push("the bundle's buy does not start the pool's time read beside its first round and hand it to the send");
  if (typeof a.send !== "string" || !SEND.test(a.send)) out.push("the bundle's send does not hand the early read to the take");
  const host = typeof a.host === "string" ? HOST.exec(a.host) : null;
  if (host === null || (clock !== undefined && host[4] !== clock)) out.push("the page's buy host does not pass the early read to the queue and read it with the take's clock on the page's pool or both its RPCs");
  return out;
}

/** The verdict on an answer { index, sha384, poolSend, clock, now, take, buy, send, host }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (typeof a?.poolSend !== "boolean") bad("the bundle's facts are not read");
  else if (a.poolSend) for (const p of problems(a)) bad(p);
  else lines.push("NOTE the bundle sends no pool transaction (no pinned pool on this build)");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch, base = SIGN) {
  const get = async (path) => {
    const r = await fetchFn(`${base}${path}`, { redirect: "error" });
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
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(fetch, (arg("--base") ?? SIGN).replace(/\/$/, ""));
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
