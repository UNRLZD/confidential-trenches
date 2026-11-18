#!/usr/bin/env node
// Live check of card evm-deposit-pruned-sim-says-why: a Base or Robinhood deposit on SIGN_HOST
// (https://confidential.unrealized.trade) whose simulation met a node with no state at the agreed block is read again,
// never told not_funded, and a deposit's verdict finds its Deposited by the note's own precommitment. What each does is
// held by packages/signpage/test/pool-deposit-evm.test.ts (the card's tests); this check holds that SIGN_HOST serves that
// code. It passes only when SIGN_HOST's served /app.js is the one its index.html pins (its sha384), and in it, as
// minified, each exactly once:
//   - miss (src/pool-deposit-evm.ts stateMiss): an error is a state miss when its words name a block or state the node
//     does not hold (the card's word list, as written) and it is no revert (code 3, or "execution reverted");
//   - sim (tryNote): the simulation's refusals, every one a state miss, throw the lag error before any sim_failed;
//   - down (the run's catch): that lag error is the run's "down" (the page's waits, then the run again);
//   - own (verdictOf): the round read, then the Deposited naming the note's own precommitment; found, the note is claimed
//     at that leaf with the chain walk's takes before it; none, dead only after that, U's nonce read after.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/evm-deposit-pruned-sim-says-why.mjs [--local] [--record <file>]
//   PASS exit 0, FAIL 1, error 2. --local judges this tree's SIGN_HOST build (signBuilt) in SIGN_HOST's place; --record
//   writes what the run read, which evm-deposit-pruned-sim-says-why.test.mjs replays. Reads only.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

export const KEY = "evm-deposit-pruned-sim-says-why";
export const SIGN = "https://confidential.unrealized.trade";

const N = "[\\w$]+";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const count = (re, js) => [...js.matchAll(new RegExp(re.source, "g"))].length;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The two word lists as the source writes them (src/pool-deposit-evm.ts REVERT and STATE_MISS). */
const REVERT_LIT = "/^RPC error (3: |-?\\d+: execution reverted)/i";
const MISS_LIT = "/missing trie node|historical state \\S* ?is not available|state \\S* ?is not available|state (has been|was) pruned|unknown state|unknown block|header not found|block not found|no such block|unsupported block number|archive requests require/i";
/** `uB=/^RPC error .../i,dB=/missing trie node|.../i,fB=e=>{let t=String(e?.message??e);return!uB.test(t)&&dB.test(t)}` */
const MISS = new RegExp(`(${N})=${esc(REVERT_LIT)},(${N})=${esc(MISS_LIT)},(${N})=(${N})=>\\{let (${N})=String\\(\\4\\?\\.message\\?\\?\\4\\);return!\\1\\.test\\(\\5\\)&&\\2\\.test\\(\\5\\)\\}`);
/** The simulation on both RPCs from U, its refusals, every one a state miss: the lag error, before sim_failed. */
const SIM = (miss) => new RegExp(`\`eth_call\`,\\[\\{from:${N},to:${N}\\.to,value:${N}\\(${N}\\.value\\),data:${N}\\.data,gas:${N}\\(${N}\\)\\},${N}\\.tag\\]\\)+\\.flatMap\\((${N})=>\\1\\.status===\`rejected\`\\?\\[\\1\\.reason\\]:\\[\\]\\);if\\((${N})\\.length>0&&\\2\\.every\\(${esc(miss)}\\)\\)throw new (${N})\\(\`the simulation at block \\$\\{${N}\\.block\\}: an RPC holds no state there\`\\);if\\(\\2\\.length>0\\)return\\{kind:\`sim_failed\`\\}`);
/** The run's catch: that error "down", the fault named for the page's waits. */
const DOWN = (lag) => new RegExp(`${N} instanceof ${esc(lag)}\\?\\(${N}\\.fault=${N},\\{error:\`down\`\\}\\)`);
/** verdictOf: `let o=await e.h.round(),s=ZR(e.scope,o.events,t.precommitment);if(s!==null){if(bB(e.h))return{kind:\`pending\`};
 *  let n=JR(e.seed,e.scope,o.events,r,o.finalBlock),i=o.events[Number(s.leafIndex)].block,a={ref:t.ref,...,leaf:s,state:\`UNSPENT\`,...};
 *  for(let r of await XR(e.store,n.taken.some(...)?n.taken:[...n.taken,a]))...}if(i===void 0)return{kind:\`dead\`};let c=t.evmSpent!==void 0` */
const OWN = new RegExp(
  `let (${N})=await (${N})\\.h\\.round\\(\\),(${N})=${N}\\(\\2\\.scope,\\1\\.events,(${N})\\.precommitment\\);if\\(\\3!==null\\)\\{if\\(${N}\\(\\2\\.h\\)\\)return\\{kind:\`pending\`\\};let (${N})=${N}\\(\\2\\.seed,\\2\\.scope,\\1\\.events,${N},\\1\\.finalBlock\\),(${N})=\\1\\.events\\[Number\\(\\3\\.leafIndex\\)\\]\\.block,(${N})=\\{ref:\\4\\.ref,scope:\\2\\.scope,precommitment:\\4\\.precommitment,leaf:\\3,state:\`UNSPENT\`,[^]{0,120}?\\};for\\(let ${N} of await ${N}\\(\\2\\.store,\\5\\.taken\\.some\\([^]{0,60}?\\)\\?\\5\\.taken:\\[\\.\\.\\.\\5\\.taken,\\7\\]\\)\\)[^]{0,240}?return\\{kind:\`landed\`,[^]{0,120}?\\}\\}if\\(${N}===void 0\\)return\\{kind:\`dead\`\\};let ${N}=\\4\\.evmSpent!==void 0`,
);

/** What the check keeps of SIGN_HOST's build: its pin and sha384, and each part found exactly once. */
export function pageFacts(index, js) {
  const m = count(MISS, js) === 1 ? MISS.exec(js) : null;
  const s = m === null ? null : SIM(m[3]).exec(js);
  return {
    pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null,
    sha384: sha384(js),
    miss: m !== null,
    sim: m !== null && count(SIM(m[3]), js) === 1,
    down: s !== null && count(DOWN(s[3]), js) === 1,
    own: count(OWN, js) === 1,
  };
}

/** SIGN_HOST's index and /app.js through `fetchFn`: { from, page }. */
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
  say(p?.miss === true, "[SIGN_HOST] a node's answer that it holds no block or state there, never a revert, is a state miss (miss)");
  say(p?.sim === true, "[SIGN_HOST] a deposit's simulation refused only for want of state is a lag, before any sim_failed (sim)");
  say(p?.down === true, "[SIGN_HOST] that lag is the run's down, read again on the page's waits, never not_funded (down)");
  say(p?.own === true, "[SIGN_HOST] a deposit's verdict finds its Deposited by the note's own precommitment, never through the chain walk (own)");
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
